// src/kart.js
// Turbo Kart Grand Prix — Kart: procedural model + Mario-Kart-style driving physics.
//
// Coordinate conventions (see ARCHITECTURE.md): Y up, heading `yaw` about Y,
// forward = (sin yaw, 0, cos yaw), right = forward × up = (-cos yaw, 0, sin yaw).
// Turning RIGHT therefore DEcreases yaw. The group origin sits on the road surface
// at the centre of the kart; the wheels touch y = 0 in group space.
//
// No side effects at import time: shared geometry/materials are built lazily on
// the first Kart construction and reused by every kart (8 karts share geometry).

import * as THREE from 'three';
import { ROAD_WIDTH, WALL_MARGIN, KART_COLORS } from './constants.js';

/** Driving-model tuning. The integrator may tweak these at runtime via Kart.TUNING. */
export const TUNING = {
  BASE_MAX_SPEED: 38,        // m/s normal top speed
  ACCEL: 16,                 // m/s² from standstill; tapers as speed → cap (≈2.5 s to top speed)
  ACCEL_TAPER: 0.55,         // fraction of ACCEL lost at the cap (cubic taper)
  BOOST_ACCEL: 60,           // m/s² while a boost is active (snappy kick up to the boosted cap)
  BRAKE_DECEL: 28,           // m/s²
  REVERSE_MAX: 10,           // m/s
  REVERSE_ACCEL: 9,          // m/s²
  COAST_DRAG: 0.35,          // fraction of speed lost per second when coasting
  ROLLING_FRICTION: 1.2,     // m/s² constant decel when coasting so the kart actually stops
  OVERSPEED_DECAY: 20,       // m/s² decay when above the current cap (boost ended / shrunk)
  STEER_RATE_LOW: 2.6,       // rad/s at low speed
  STEER_RATE_HIGH: 1.5,      // rad/s at top speed
  STEER_FULL_SPEED: 4,       // m/s below which steering authority fades toward 0 (no turning while stopped)
  OFFROAD_MAX_FACTOR: 0.5,   // cap multiplier offroad (ignored while boosting / star)
  OFFROAD_DECEL: 14,         // m/s² decay when above the offroad cap
  BOOST_PAD: { duration: 1.3, power: 1.5 },
  BOOST_PAD_COOLDOWN: 0.5,   // s before a pad can re-trigger
  MINI_TURBO_DURATIONS: [0, 0.7, 1.3, 2.0], // by drift tier 0..3
  MINI_TURBO_POWER: 1.25,
  DRIFT_MIN_SPEED: 12,       // m/s needed to hop/start a drift
  DRIFT_END_SPEED: 6,        // m/s; drift collapses below this (no boost)
  DRIFT_CHARGE_TIME: 1.0,    // s per tier
  DRIFT_BASE_TURN: 1.0,      // rad/s neutral drift arc (≈38 m radius at top speed)
  DRIFT_STEER_TURN: 0.9,     // ± rad/s steering into / out of the drift → 0.1 (near-straight) … 1.9 (hairpin)
  DRIFT_SLIP_ANGLE: 0.45,    // rad the velocity lags the heading while sliding
  DRIFT_SLIP_RATE: 5,        // /s ease-in of the slide
  SLIP_RECOVER_RATE: 8,      // /s ease-out after the drift
  HOP_TIME: 0.28,            // s
  HOP_HEIGHT: 0.4,           // m (visual only)
  HOP_DRIFT_WINDOW: 0.4,     // s after a hop during which steering starts the drift
  STAR_SPEED_FACTOR: 1.25,
  SHRINK_SPEED_FACTOR: 0.7,
  SHRINK_SCALE: 0.55,
  SPIN_DURATION: 1.0,        // spinOut(): one 360° turn + 1 s stun
  CRASH_DURATION: 1.5,       // crash(): two turns + tumble + 1.5 s stun
  SPIN_DECEL: 30,            // m/s² while stunned
  WALL_SPEED_LOSS: 0.3,      // fraction lost on an impact (a fresh hit)
  BUMP_DRAG: 5,              // 1/s decay of the shove from kart-kart bumps
  WALL_COOLDOWN: 0.3,        // s between impacts
  WALL_REHIT_GAP: 0.25,      // s off the wall before contact counts as a new impact (else it's a grind)
  WALL_GRIND_DECEL: 12,      // m/s² drag while scraping along the wall
  WALL_YAW_NUDGE: 6,         // /s pull of the heading toward the tangent while pointing into the wall
  HEIGHT_LERP: 25,           // /s suspension smoothing toward the road height
  RADIUS: 1.2,
  WHEEL_RADIUS_REAR: 0.34,
  WHEEL_RADIUS_FRONT: 0.30,
};

// ----------------------------------------------------------------------------
// Model dimensions (metres, group space)
// ----------------------------------------------------------------------------
const WHEEL_X = 0.68; // wheel centre from the mid-line
const WHEEL_Z = 0.72; // half wheelbase
const EXHAUST = { x: 0.22, y: 0.58, z: -0.85, len: 0.45, angle: 0.384 }; // pipes point back, 22° up
const DRIVER_Y = 0.48;

// Scratch objects (allocation-free hot paths)
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _c1 = new THREE.Color();

// ----------------------------------------------------------------------------
// Small maths helpers
// ----------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v) => (Number.isFinite(v) ? v : 0);
const lerp = (a, b, t) => a + (b - a) * t;
const moveToward = (v, target, maxDelta) =>
  Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ----------------------------------------------------------------------------
// Geometry helpers
// ----------------------------------------------------------------------------

/** Apply scale → XYZ-Euler rotation → translation to a geometry in place; returns it. */
function xf(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _m4.compose(_v1.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'XYZ')), _v2.set(sx, sy, sz));
  geo.applyMatrix4(_m4);
  return geo;
}

/** Merge geometries (same material) into one non-indexed BufferGeometry. Disposes the inputs. */
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const hasColor = parts.every((p) => !!p.attributes.color);
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const col = hasColor ? new Float32Array(count * 3) : null;
  let off = 0;
  for (const p of parts) {
    const n = p.attributes.position.count;
    pos.set(p.attributes.position.array.subarray(0, n * 3), off * 3);
    if (p.attributes.normal) nor.set(p.attributes.normal.array.subarray(0, n * 3), off * 3);
    if (p.attributes.uv) uv.set(p.attributes.uv.array.subarray(0, n * 2), off * 2);
    if (col) col.set(p.attributes.color.array.subarray(0, n * 3), off * 3);
    off += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  for (const p of parts) p.dispose();
  for (const g of geos) g.dispose();
  return out;
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r); s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1); s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/** Rounded, bevelled slab: footprint w (x) × l (z), height h, bottom at y = 0, centred in x/z. */
function roundedSlab(w, l, h, r, bevel) {
  const shape = roundedRectShape(w - 2 * bevel, l - 2 * bevel, Math.max(0.01, r - bevel));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 3, curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2); // extrude axis → +Y
  geo.translate(0, bevel, 0); // bottom at y = 0
  return geo;
}

/** Half-ring fender over a wheel of radius r at (x, z), widened along the axle. */
function fenderGeo(r, x, z) {
  const R = r + 0.1, tube = 0.055;
  const arc = new THREE.TorusGeometry(R, tube, 8, 16, Math.PI); // +X over +Y to -X
  const capA = new THREE.SphereGeometry(tube, 8, 6); capA.translate(R, 0, 0);
  const capB = new THREE.SphereGeometry(tube, 8, 6); capB.translate(-R, 0, 0);
  // ring into the YZ plane (axis along X), stretched 3.4× along its axis
  return xf(mergeGeos([arc, capA, capB]), x, r, z, 0, Math.PI / 2, 0, 1, 1, 3.4);
}

/** Balloon tyre (torus) with its axle along X. */
function tyreGeo(r, tube) {
  const g = new THREE.TorusGeometry(r - tube, tube, 10, 24);
  g.rotateY(Math.PI / 2);
  return g;
}

/** Rim disc + hub + three spoke bars, axle along X. */
function rimGeo(r, tube) {
  const ringR = r - tube;
  const disc = new THREE.CylinderGeometry(ringR + 0.03, ringR + 0.03, tube * 0.7, 20);
  disc.rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.07, 0.07, tube * 2.0, 12);
  hub.rotateZ(Math.PI / 2);
  const parts = [disc, hub];
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.BoxGeometry(tube * 1.3, ringR * 1.85, 0.045);
    spoke.rotateX((i / 3) * Math.PI);
    parts.push(spoke);
  }
  return mergeGeos(parts);
}

/** Capsule whose axis runs from a to b. */
function capsuleBetween(ax, ay, az, bx, by, bz, r) {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 4, 10);
  g.applyQuaternion(_q.setFromUnitVectors(_UP, dir.normalize()));
  g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return g;
}

/** Two nested cones with a vertex-colour gradient (yellow core → orange tip); base at origin, apex at -Z. */
function flameGeo() {
  const specs = [
    [new THREE.ConeGeometry(0.1, 0.75, 12, 1, true), [1.0, 0.85, 0.35], [1.0, 0.22, 0.02]],
    [new THREE.ConeGeometry(0.05, 0.5, 10, 1, true), [1.0, 1.0, 0.9], [1.0, 0.8, 0.2]],
  ];
  const parts = [];
  for (const [g, base, tip] of specs) {
    const h = g.parameters.height;
    g.rotateX(-Math.PI / 2); // apex (+Y) → -Z
    g.translate(0, 0, -h / 2); // base at z = 0
    const p = g.attributes.position;
    const colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = clamp01(-p.getZ(i) / h);
      colors[i * 3] = lerp(base[0], tip[0], t);
      colors[i * 3 + 1] = lerp(base[1], tip[1], t);
      colors[i * 3 + 2] = lerp(base[2], tip[2], t);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  }
  return mergeGeos(parts);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Number-plate CanvasTexture (white rounded rect, colour tab, bold number). Null outside a DOM. */
function makePlateTexture(number, color) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 128, 96);
  roundRectPath(ctx, 5, 5, 118, 86, 14);
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = '#17181c'; ctx.stroke();
  ctx.fillStyle = '#' + _c1.set(color).getHexString();
  roundRectPath(ctx, 16, 13, 96, 11, 5); ctx.fill();
  ctx.fillStyle = '#111318';
  ctx.font = 'bold 54px "Arial Black", Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(number), 64, 58);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ----------------------------------------------------------------------------
// Shared (colour-independent) geometry + materials, built once
// ----------------------------------------------------------------------------
let SHARED = null;

function getShared() {
  if (SHARED) return SHARED;
  const rr = TUNING.WHEEL_RADIUS_REAR, rf = TUNING.WHEEL_RADIUS_FRONT;

  // --- kart-colour parts: tub, nose cone, side pods, fenders, spoiler end plates, cowl
  const bodyParts = [
    xf(roundedSlab(1.0, 1.6, 0.34, 0.18, 0.06), 0, 0.17, -0.1),
    xf(new THREE.ConeGeometry(0.4, 0.62, 24, 1), 0, 0.33, 0.9, Math.PI / 2, 0, 0, 1, 1, 0.42), // flattened nose
    xf(new THREE.BoxGeometry(0.56, 0.12, 0.3), 0, 0.55, 0.44, 0.3), // sloped cowl in front of the driver
  ];
  for (const sx of [-1, 1]) {
    bodyParts.push(xf(roundedSlab(0.34, 0.74, 0.26, 0.1, 0.05), sx * 0.62, 0.17, 0.02)); // side pod
    bodyParts.push(fenderGeo(rf, sx * WHEEL_X, WHEEL_Z));
    bodyParts.push(fenderGeo(rr, sx * WHEEL_X, -WHEEL_Z));
    bodyParts.push(xf(new THREE.BoxGeometry(0.03, 0.18, 0.34), sx * 0.66, 0.97, -0.98)); // spoiler end plate
  }

  // --- accent parts: hood stripe, nose stripe, rear wing, pod caps
  const accentParts = [
    xf(new THREE.BoxGeometry(0.22, 0.025, 1.62), 0, 0.515, -0.1),
    xf(new THREE.BoxGeometry(0.11, 0.02, 0.5), 0, 0.435, 0.88, 0.27),
    xf(new THREE.BoxGeometry(1.36, 0.05, 0.34), 0, 0.98, -0.98, 0.18),
  ];
  for (const sx of [-1, 1]) accentParts.push(xf(new THREE.BoxGeometry(0.3, 0.02, 0.5), sx * 0.62, 0.435, 0.02));

  // --- dark metal: floor pan, engine block, front splitter, steering column, struts, bumper mounts
  const darkParts = [
    xf(new THREE.BoxGeometry(1.0, 0.05, 1.95), 0, 0.14, -0.05),
    xf(new THREE.BoxGeometry(0.66, 0.34, 0.38), 0, 0.62, -0.78),
    xf(new THREE.BoxGeometry(0.9, 0.03, 0.25), 0, 0.17, 0.85),
    xf(new THREE.CylinderGeometry(0.025, 0.025, 0.44, 8), 0, 0.775, 0.37, -0.64),
  ];
  for (const sx of [-1, 1]) {
    darkParts.push(xf(new THREE.BoxGeometry(0.05, 0.5, 0.08), sx * 0.42, 0.74, -0.94, -0.15));
    darkParts.push(xf(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), sx * 0.42, 0.28, 0.85, Math.PI / 2));
  }

  // --- chrome: bumper bar, intake, two exhaust pipes with lips
  const chromeParts = [
    xf(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 10), 0, 0.28, 1.0, 0, 0, Math.PI / 2),
    xf(new THREE.CylinderGeometry(0.09, 0.09, 0.3, 12), 0, 0.86, -0.78, Math.PI / 2),
  ];
  const ex = EXHAUST;
  const dy = Math.sin(ex.angle), dz = -Math.cos(ex.angle);
  for (const sx of [-1, 1]) {
    chromeParts.push(xf(new THREE.CylinderGeometry(0.055, 0.048, ex.len, 12),
      sx * ex.x, ex.y + dy * ex.len / 2, ex.z + dz * ex.len / 2, -(Math.PI / 2 - ex.angle)));
    chromeParts.push(xf(new THREE.TorusGeometry(0.06, 0.018, 8, 16),
      sx * ex.x, ex.y + dy * ex.len, ex.z + dz * ex.len, -(Math.PI - ex.angle)));
  }

  // --- lights
  const headParts = [], tailParts = [];
  for (const sx of [-1, 1]) {
    headParts.push(xf(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 14), sx * 0.36, 0.42, 0.73, Math.PI / 2));
    tailParts.push(xf(new THREE.BoxGeometry(0.14, 0.06, 0.04), sx * 0.34, 0.42, -0.91));
  }

  // --- seat (base + reclined back)
  const seatParts = [
    xf(new THREE.BoxGeometry(0.52, 0.1, 0.42), 0, 0.5, -0.32),
    xf(new THREE.BoxGeometry(0.52, 0.5, 0.1), 0, 0.74, -0.56, -0.18),
  ];

  // --- number plates: nose board (tilted back) + rear board on the engine block
  const plateParts = [
    xf(new THREE.PlaneGeometry(0.3, 0.22), 0, 0.6, 0.78, -0.3),
    xf(new THREE.PlaneGeometry(0.3, 0.22), 0, 0.66, -0.975, 0, Math.PI, 0),
  ];

  // --- driver (in the driver group's local space): torso + arms + shoulders
  const suitParts = [
    xf(new THREE.CapsuleGeometry(0.19, 0.28, 4, 14), 0, 0.3, 0),
    capsuleBetween(-0.2, 0.52, 0.02, -0.14, 0.5, 0.4, 0.055),
    capsuleBetween(0.2, 0.52, 0.02, 0.14, 0.5, 0.4, 0.055),
    xf(new THREE.SphereGeometry(0.075, 10, 8), -0.2, 0.52, 0.02),
    xf(new THREE.SphereGeometry(0.075, 10, 8), 0.2, 0.52, 0.02),
  ];
  const helmet = new THREE.SphereGeometry(0.22, 24, 16);
  helmet.translate(0, 0.84, 0.02);
  const visor = new THREE.SphereGeometry(0.228, 20, 8, Math.PI / 2 - 0.95, 1.9, 1.15, 0.5);
  visor.translate(0, 0.84, 0.02);
  const whiteParts = [
    xf(new THREE.TorusGeometry(0.222, 0.02, 6, 24, Math.PI), 0, 0.84, 0.02, 0, Math.PI / 2, 0), // stripe over the top
    xf(new THREE.BoxGeometry(0.03, 0.06, 0.2), 0, 1.06, -0.06), // cap ridge / fin
    xf(new THREE.SphereGeometry(0.06, 10, 8), -0.14, 0.5, 0.4), // gloves
    xf(new THREE.SphereGeometry(0.06, 10, 8), 0.14, 0.5, 0.4),
  ];
  const wheelParts = [
    new THREE.TorusGeometry(0.14, 0.025, 8, 24),
    new THREE.BoxGeometry(0.26, 0.03, 0.02),
    xf(new THREE.BoxGeometry(0.03, 0.13, 0.02), 0, 0.065, 0),
    xf(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10), 0, 0, 0, Math.PI / 2),
  ];

  SHARED = {
    body: mergeGeos(bodyParts),
    accent: mergeGeos(accentParts),
    dark: mergeGeos(darkParts),
    chrome: mergeGeos(chromeParts),
    headlights: mergeGeos(headParts),
    taillights: mergeGeos(tailParts),
    seat: mergeGeos(seatParts),
    plate: mergeGeos(plateParts),
    suit: mergeGeos(suitParts),
    helmet,
    visor,
    white: mergeGeos(whiteParts),
    steeringWheel: mergeGeos(wheelParts),
    tyreRear: tyreGeo(rr, 0.13),
    tyreFront: tyreGeo(rf, 0.115),
    rimRear: rimGeo(rr, 0.13),
    rimFront: rimGeo(rf, 0.115),
    flame: flameGeo(),
    mats: {
      dark: new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.6, roughness: 0.45 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xe8e8ee, metalness: 1.0, roughness: 0.18 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 1.0, roughness: 0.22 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.0, roughness: 0.92 }),
      headlight: new THREE.MeshStandardMaterial({ color: 0xfff6d5, emissive: 0xffe9a8, emissiveIntensity: 1.4, roughness: 0.3 }),
      taillight: new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff2a1a, emissiveIntensity: 1.2, roughness: 0.3 }),
      seat: new THREE.MeshStandardMaterial({ color: 0x3a2626, metalness: 0.05, roughness: 0.85 }),
      visor: new THREE.MeshStandardMaterial({ color: 0x0d1117, metalness: 0.4, roughness: 0.08 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf5f5f5, metalness: 0.05, roughness: 0.5 }),
      flame: new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }),
    },
  };
  return SHARED;
}

/**
 * Build one kart visual. Returns { group, body, chassis, bodyMat, accentMat, suitMat, plateMat,
 * plateTex, frontWheels, rearWheels, driver, steeringWheel, helmet, visor, flames, exhaustTips }.
 * `group` is the physics root (on the road surface); `body` is the child that carries the
 * hop/tumble offset.
 */
export function buildKartModel(color, number = 1) {
  const S = getShared();
  const rr = TUNING.WHEEL_RADIUS_REAR, rf = TUNING.WHEEL_RADIUS_FRONT;

  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45), metalness: 0.5, roughness: 0.3,
  });
  const suitMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).offsetHSL(0, -0.1, -0.15), metalness: 0.1, roughness: 0.6,
  });
  const plateTex = makePlateTexture(number, color);
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: plateTex, metalness: 0.05, roughness: 0.4, side: THREE.DoubleSide,
    transparent: !!plateTex, alphaTest: plateTex ? 0.5 : 0,
  });

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const mesh = (geo, mat, parent = body, receive = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = receive;
    parent.add(m);
    return m;
  };

  const chassis = mesh(S.body, bodyMat, body, true);
  mesh(S.accent, accentMat);
  mesh(S.dark, S.mats.dark);
  mesh(S.chrome, S.mats.chrome);
  mesh(S.headlights, S.mats.headlight);
  mesh(S.taillights, S.mats.taillight);
  mesh(S.seat, S.mats.seat);
  mesh(S.plate, plateMat);

  // Wheels: pivot (steering yaw) → spinner (axle spin) → tyre + rim
  const frontWheels = [], rearWheels = [];
  for (const sx of [-1, 1]) {
    for (const front of [true, false]) {
      const r = front ? rf : rr;
      const pivot = new THREE.Group();
      pivot.position.set(sx * WHEEL_X, r, front ? WHEEL_Z : -WHEEL_Z);
      const spinner = new THREE.Group();
      pivot.add(spinner);
      const tyre = mesh(front ? S.tyreFront : S.tyreRear, S.mats.rubber, spinner);
      const rim = mesh(front ? S.rimFront : S.rimRear, S.mats.gold, spinner);
      body.add(pivot);
      (front ? frontWheels : rearWheels).push({ pivot, spinner, tyre, rim, side: sx, radius: r });
    }
  }

  // Driver
  const driver = new THREE.Group();
  driver.position.set(0, DRIVER_Y, -0.22);
  body.add(driver);
  mesh(S.suit, suitMat, driver);
  const helmet = mesh(S.helmet, bodyMat, driver);
  const visor = mesh(S.visor, S.mats.visor, driver);
  mesh(S.white, S.mats.white, driver);
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(0, 0.5, 0.42);
  wheelPivot.rotation.x = -2.18; // faces back and up toward the driver
  driver.add(wheelPivot);
  const steeringWheel = mesh(S.steeringWheel, S.mats.dark, wheelPivot);

  // Exhaust tips carry the boost flames (local -Z = out of the pipe)
  const flames = [], exhaustTips = [];
  const ex = EXHAUST;
  for (const sx of [-1, 1]) {
    const tip = new THREE.Object3D();
    tip.position.set(sx * ex.x, ex.y + Math.sin(ex.angle) * ex.len, ex.z - Math.cos(ex.angle) * ex.len);
    tip.rotation.x = ex.angle;
    body.add(tip);
    const flame = new THREE.Mesh(S.flame, S.mats.flame);
    flame.visible = false;
    flame.scale.setScalar(0.001);
    flame.frustumCulled = false;
    tip.add(flame);
    flames.push(flame);
    exhaustTips.push(tip);
  }

  return {
    group, body, chassis, bodyMat, accentMat, suitMat, plateMat, plateTex,
    frontWheels, rearWheels, driver, steeringWheel, helmet, visor, flames, exhaustTips,
  };
}

// ----------------------------------------------------------------------------
// Tripo asset kart (kart_body + kart_wheel + driver GLBs from src/assets.js)
// ----------------------------------------------------------------------------
/** Placement of the generated pieces — tuned against the shipped GLBs. */
const GLB_KART = {
  driverY: 0.30,        // seat height of the generated body (driver GLB is grounded at its feet)
  driverZ: -0.18,
  driverScale: 1.0,
  wheelDiameter: 0.68,  // the wheel GLB is normalised to this diameter
  wheelRimSide: 1,      // +1: the wheel GLB's rim faces +X after normalisation (left wheels are mirrored)
  tyreTone: 0.62,       // darkens the generated tyre texture toward black rubber (applied once, shared material)
};

function collectTintMaterials(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh && o.material?.userData?.tint) out.push(o.material); });
  return out;
}

function firstMeshMaterial(root) {
  let mat = null;
  root.traverse((o) => { if (!mat && o.isMesh && o.material) mat = o.material; });
  return mat;
}

/**
 * Same return shape as buildKartModel, built from the Tripo asset set. Any missing piece falls
 * back to its procedural counterpart; returns null when the body asset itself is unavailable.
 */
export function buildKartModelFromAssets(assets, color, number = 1) {
  if (!assets || typeof assets.has !== 'function' || !assets.has('kart_body')) return null;
  const S = getShared();
  const rr = TUNING.WHEEL_RADIUS_REAR, rf = TUNING.WHEEL_RADIUS_FRONT;

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // chassis (white paint takes the racer colour through the tint shader)
  const chassis = assets.clone('kart_body', { tint: color, receiveShadow: true });
  body.add(chassis);
  const tinted = collectTintMaterials(chassis);
  const bodyMat = tinted[0] ?? firstMeshMaterial(chassis) ?? new THREE.MeshStandardMaterial({ color });
  const accentMat = tinted[1] ?? bodyMat;

  const mesh = (geo, mat, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // wheels: pivot (steering yaw) → spinner (axle spin) → GLB wheel (or procedural tyre + rim)
  const hasWheel = assets.has('kart_wheel');
  const frontWheels = [], rearWheels = [];
  for (const sx of [-1, 1]) {
    for (const front of [true, false]) {
      const r = front ? rf : rr;
      const pivot = new THREE.Group();
      pivot.position.set(sx * WHEEL_X, r, front ? WHEEL_Z : -WHEEL_Z);
      const spinner = new THREE.Group();
      pivot.add(spinner);
      let tyre, rim = null;
      if (hasWheel) {
        tyre = assets.clone('kart_wheel');
        tyre.scale.setScalar((2 * r) / GLB_KART.wheelDiameter);
        tyre.rotation.y = sx === GLB_KART.wheelRimSide ? 0 : Math.PI;
        tyre.traverse((o) => {
          const m = o.isMesh ? o.material : null;
          if (m && !m.userData.tyreToned) { m.color.multiplyScalar(GLB_KART.tyreTone); m.userData.tyreToned = true; }
        });
        spinner.add(tyre);
      } else {
        tyre = mesh(front ? S.tyreFront : S.tyreRear, S.mats.rubber, spinner);
        rim = mesh(front ? S.rimFront : S.rimRear, S.mats.gold, spinner);
      }
      body.add(pivot);
      (front ? frontWheels : rearWheels).push({ pivot, spinner, tyre, rim, side: sx, radius: r });
    }
  }

  // driver (white suit + helmet take the racer colour); its steering wheel is baked into the mesh
  const driver = new THREE.Group();
  const driverY = assets.has('driver') ? GLB_KART.driverY : DRIVER_Y;
  driver.position.set(0, driverY, assets.has('driver') ? GLB_KART.driverZ : -0.22);
  body.add(driver);
  let steeringWheel, helmet = null, visor = null, suitMat = null;
  if (assets.has('driver')) {
    const d = assets.clone('driver', { tint: color });
    d.scale.setScalar(GLB_KART.driverScale);
    driver.add(d);
    steeringWheel = new THREE.Object3D();
    driver.add(steeringWheel);
  } else {
    suitMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).offsetHSL(0, -0.1, -0.15), metalness: 0.1, roughness: 0.6,
    });
    mesh(S.suit, suitMat, driver);
    helmet = mesh(S.helmet, bodyMat, driver);
    visor = mesh(S.visor, S.mats.visor, driver);
    mesh(S.white, S.mats.white, driver);
    const wheelPivot = new THREE.Group();
    wheelPivot.position.set(0, 0.5, 0.42);
    wheelPivot.rotation.x = -2.18;
    driver.add(wheelPivot);
    steeringWheel = mesh(S.steeringWheel, S.mats.dark, wheelPivot);
  }

  // exhaust tips carry the boost flames (same placement as the procedural kart)
  const flames = [], exhaustTips = [];
  const ex = EXHAUST;
  for (const sx of [-1, 1]) {
    const tip = new THREE.Object3D();
    tip.position.set(sx * ex.x, ex.y + Math.sin(ex.angle) * ex.len, ex.z - Math.cos(ex.angle) * ex.len);
    tip.rotation.x = ex.angle;
    body.add(tip);
    const flame = new THREE.Mesh(S.flame, S.mats.flame);
    flame.visible = false;
    flame.scale.setScalar(0.001);
    flame.frustumCulled = false;
    tip.add(flame);
    flames.push(flame);
    exhaustTips.push(tip);
  }

  return {
    group, body, chassis, bodyMat, accentMat, suitMat, plateMat: null, plateTex: null,
    frontWheels, rearWheels, driver, driverY, steeringWheel, helmet, visor, flames, exhaustTips,
    fromAssets: true, number,
  };
}

// ----------------------------------------------------------------------------
// Kart
// ----------------------------------------------------------------------------
export class Kart {
  static TUNING = TUNING;

  /**
   * @param {THREE.Scene|{add:Function}} scene
   * @param {{color?:number, name?:string, isPlayer?:boolean, index?:number}} opts
   */
  constructor(scene, opts = {}) {
    const index = opts.index ?? 0;
    this.index = index;
    this.name = opts.name ?? `Kart ${index + 1}`;
    this.color = opts.color ?? KART_COLORS[index % KART_COLORS.length];
    this.isPlayer = !!opts.isPlayer;
    this.scene = scene ?? null;

    // --- physics state
    this.yaw = 0;
    this.speed = 0;          // signed forward speed (m/s)
    this.lateralVel = 0;     // side-slip along the kart's right axis (m/s); negative = sliding left
    this.slipAngle = 0;      // heading − velocity direction offset while drifting (rad)
    this.velocity = new THREE.Vector3();
    this.maxSpeed = TUNING.BASE_MAX_SPEED;
    this.speedMultiplier = 1;   // set externally (e.g. AI rubber-banding); scales the speed cap
    this.radius = TUNING.RADIUS;
    this.offroad = false;
    this.wallHit = false;    // set true on wall contact; the consumer resets it after reading

    // --- race bookkeeping (main.js maintains most of it)
    this.lap = 0;
    this.nextCheckpoint = 0;
    this.trackT = 0;
    this.progress = 0;
    this.racePosition = index + 1;
    this.finished = false;
    this.finishTime = 0;
    this.item = null;
    this.itemCount = 0;

    this.state = Kart.freshState();
    this.input = Kart.freshInput();

    // --- effect hooks
    this.particles = null;
    this.audio = null;

    // --- internals
    this._time = 0;
    this._driftHeldPrev = false;
    this._hopArmTimer = 0;
    this._driftRearm = 0;
    this._boostPadCooldown = 0;
    this._wallCooldown = 0;
    this._wallFreeTime = 1; // seconds since last wall contact
    this._spinDuration = 1;
    this._spinTurns = 1;
    this._spinSign = 1;
    this._tumble = false;
    this._groundY = 0;
    this._pitchTarget = 0;
    this._pitch = 0;
    this._roll = 0;
    this._rollKick = 0;        // transient body rock from wall hits and bumps
    this.shove = this.shove ? this.shove.set(0, 0, 0) : new THREE.Vector3(); // world-space bump velocity
    this._steerVisual = 0;
    this._spinFront = 0;
    this._spinRear = 0;
    this._prevSpeed = 0;
    this._starActive = false;
    this._driftEmitAcc = 0;
    this._boostEmitAcc = 0;
    this._dustEmitAcc = 0;
    this._dustSide = 0;
    this._wheelL = new THREE.Vector3();
    this._wheelR = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    // --- visual
    this.model = (opts.assets && buildKartModelFromAssets(opts.assets, this.color, index + 1)) || buildKartModel(this.color, index + 1);
    this.group = this.model.group;
    this.group.rotation.order = 'YXZ';
    this.body = this.model.body;
    this.flames = this.model.flames;
    this.group.name = `kart-${index}`;
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(this.group);
  }

  static freshState() {
    return {
      drifting: false, driftDir: 0, driftCharge: 0, driftTier: 0, hopTimer: 0,
      boostTimer: 0, boostPower: 0, spinTimer: 0, stunTimer: 0, invincibleTimer: 0, shrinkTimer: 0,
      airborne: false, wrongWay: false,
    };
  }

  static freshInput() {
    return { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false };
  }

  // ------------------------------------------------------------------ accessors
  get position() { return this.group.position; }
  set position(v) { this.group.position.copy(v); }

  /** |speed| / BASE_MAX_SPEED (can exceed 1 while boosting). */
  get speedRatio() { return Math.abs(this.speed) / TUNING.BASE_MAX_SPEED; }
  get isBoosting() { return this.state.boostTimer > 0; }
  get isDrifting() { return this.state.drifting; }
  get isStunned() { return this.state.stunTimer > 0; }
  get isInvincible() { return this.state.invincibleTimer > 0; }
  get isShrunk() { return this.state.shrinkTimer > 0; }

  /** Unit heading vector (body orientation, ignores drift slip). */
  forwardVector(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Unit right vector (forward × up). */
  rightVector(target = new THREE.Vector3()) {
    return target.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  /** World positions of the rear-wheel contact patches → [left, right] (fresh vectors). */
  rearWheelWorldPositions() {
    const l = new THREE.Vector3(), r = new THREE.Vector3();
    this._rearWheels(l, r);
    return [l, r];
  }

  /** World position between the two exhaust tips. */
  exhaustWorldPosition(target = new THREE.Vector3()) {
    const sc = this.group.scale.x;
    const p = this.group.position;
    const dist = 1.27 * sc, up = 0.75 * sc;
    return target.set(p.x - Math.sin(this.yaw) * dist, p.y + up, p.z - Math.cos(this.yaw) * dist);
  }

  _rearWheels(outL, outR) {
    const sc = this.group.scale.x;
    const p = this.group.position;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -fz, rz = fx; // right vector
    const back = -WHEEL_Z * sc, side = WHEEL_X * sc, y = p.y + 0.05 * sc;
    outL.set(p.x + fx * back - rx * side, y, p.z + fz * back - rz * side);
    outR.set(p.x + fx * back + rx * side, y, p.z + fz * back + rz * side);
  }

  // ------------------------------------------------------------------ commands
  setEffects(particles, audio) {
    this.particles = particles ?? null;
    this.audio = audio ?? null;
  }

  /** Start/extend a boost. Keeps the stronger power, the longer timer. */
  applyBoost(duration = 1, power = TUNING.MINI_TURBO_POWER) {
    if (!(duration > 0)) return;
    const s = this.state;
    power = Math.max(1, num(power) || 1);
    s.boostPower = s.boostTimer > 0 ? Math.max(s.boostPower, power) : power;
    s.boostTimer = Math.max(s.boostTimer, duration);
    this.audio?.play?.('boost');
  }

  /** Banana / shell hit: 360° spin, lose most speed, 1 s stun. Ignored while invincible. */
  spinOut() {
    if (this.state.invincibleTimer > 0) return false;
    this._startSpin(TUNING.SPIN_DURATION, 1, false);
    this.speed *= 0.35;
    return true;
  }

  /** Kart-kart contact: shove away along (dirX, dirZ), rock the body, spark burst + thud. */
  bump(dirX, dirZ, strength = 5) {
    this.shove.x += dirX * strength;
    this.shove.z += dirZ * strength;
    const side = dirX * -Math.cos(this.yaw) + dirZ * Math.sin(this.yaw); // > 0: shoved toward our right
    this._rollKick = -side * 0.35;
    if (this.particles?.emitPop) {
      const p = this.group.position;
      this._tmp.set(p.x - dirX * 0.9, p.y + 0.5, p.z - dirZ * 0.9);
      this.particles.emitPop(this._tmp, 0xfff2a8);
    }
    this.audio?.play?.('bump');
    return true;
  }

  /** Bomb / lightning-strength hit: two turns + tumble, 1.5 s stun. Ignored while invincible. */
  crash() {
    if (this.state.invincibleTimer > 0) return false;
    this._startSpin(TUNING.CRASH_DURATION, 2, true);
    this.speed *= 0.15;
    return true;
  }

  setStar(duration = 8) {
    const s = this.state;
    s.invincibleTimer = Math.max(s.invincibleTimer, num(duration));
  }

  /** Lightning: shrink + slow. Ignored while invincible (star protects). */
  setShrink(duration = 5) {
    const s = this.state;
    if (s.invincibleTimer > 0) return;
    s.shrinkTimer = Math.max(s.shrinkTimer, num(duration));
  }

  /** Zero all motion/effects and place the kart. `trackT` is the curve hint for the new spot. */
  reset(position, yaw = 0, trackT = 0) {
    if (position) this.group.position.copy(position);
    this.yaw = wrapAngle(num(yaw));
    this.speed = 0;
    this.lateralVel = 0;
    this.slipAngle = 0;
    this.velocity.set(0, 0, 0);
    this.maxSpeed = TUNING.BASE_MAX_SPEED;
    this.offroad = false;
    this.wallHit = false;
    this.lap = 0;
    this.nextCheckpoint = 0;
    this.trackT = num(trackT);
    this.progress = 0;
    this.finished = false;
    this.finishTime = 0;
    this.item = null;
    this.itemCount = 0;
    this.state = Kart.freshState();
    this.input = Kart.freshInput();
    this._driftHeldPrev = false;
    this._hopArmTimer = 0;
    this._driftRearm = 0;
    this._boostPadCooldown = 0;
    this._wallCooldown = 0;
    this._wallFreeTime = 1;
    this._tumble = false;
    this._groundY = this.group.position.y;
    this._pitchTarget = 0;
    this._pitch = 0;
    this._roll = 0;
    this._rollKick = 0;        // transient body rock from wall hits and bumps
    this.shove = this.shove ? this.shove.set(0, 0, 0) : new THREE.Vector3(); // world-space bump velocity
    this._steerVisual = 0;
    this._prevSpeed = 0;
    this._driftEmitAcc = this._boostEmitAcc = this._dustEmitAcc = 0;
    this.body.position.y = 0;
    this.group.scale.setScalar(1);
    this.group.rotation.set(0, this.yaw, 0);
    this._setStarVisual(false);
    for (const f of this.flames) { f.visible = false; f.scale.setScalar(0.001); }
  }

  /** Remove from the scene and free per-kart GPU resources (shared geometry stays). */
  dispose() {
    if (this.scene && typeof this.scene.remove === 'function') this.scene.remove(this.group);
    const m = this.model;
    m.bodyMat?.dispose(); if (m.accentMat !== m.bodyMat) m.accentMat?.dispose(); m.suitMat?.dispose(); m.plateMat?.dispose();
    m.plateTex?.dispose?.();
  }

  _startSpin(duration, turns, tumble) {
    const s = this.state;
    s.spinTimer = duration;
    s.stunTimer = duration;
    s.boostTimer = 0;
    s.boostPower = 0;
    s.hopTimer = 0;
    this._hopArmTimer = 0;
    this._driftRearm = 0;
    this._spinDuration = duration;
    this._spinTurns = turns;
    this._spinSign = Math.random() < 0.5 ? -1 : 1;
    this._tumble = tumble;
    if (s.drifting) this._endDrift();
  }

  _endDrift() {
    const s = this.state;
    this._driftRearm = 0.6; // holding the drift key does not instantly re-hop
    s.drifting = false;
    s.driftDir = 0;
    s.driftCharge = 0;
    s.driftTier = 0;
  }

  // ------------------------------------------------------------------ update
  /**
   * Integrate one physics step. `track` must expose getRoadInfo(position, hintT) per the
   * contract; it may be null (free driving on a flat plane).
   */
  update(dt, track) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    const T = TUNING, s = this.state, inp = this.input;
    this._time += dt;

    // ---- 1. timers
    s.hopTimer = Math.max(0, s.hopTimer - dt);
    s.boostTimer = Math.max(0, s.boostTimer - dt);
    if (s.boostTimer === 0) s.boostPower = 0;
    s.spinTimer = Math.max(0, s.spinTimer - dt);
    s.stunTimer = Math.max(0, s.stunTimer - dt);
    s.invincibleTimer = Math.max(0, s.invincibleTimer - dt);
    s.shrinkTimer = Math.max(0, s.shrinkTimer - dt);
    this._hopArmTimer = Math.max(0, this._hopArmTimer - dt);
    this._driftRearm = Math.max(0, this._driftRearm - dt);
    this._boostPadCooldown = Math.max(0, this._boostPadCooldown - dt);
    this._wallCooldown = Math.max(0, this._wallCooldown - dt);

    const stunned = s.stunTimer > 0;
    const boosting = s.boostTimer > 0;
    const star = s.invincibleTimer > 0;
    const shrunk = s.shrinkTimer > 0;

    // ---- sanitised input
    let throttle = clamp01(num(inp.throttle));
    let brake = clamp01(num(inp.brake));
    let steer = clamp(num(inp.steer), -1, 1);
    let driftHeld = !!inp.drift;
    if (stunned) { throttle = 0; brake = 0; steer = 0; driftHeld = false; }
    if (boosting) { throttle = 1; brake = 0; }

    // ---- 2. effective speed cap
    let max = T.BASE_MAX_SPEED;
    if (this.offroad && !boosting && !star) max *= T.OFFROAD_MAX_FACTOR;
    if (boosting) max *= Math.max(1, s.boostPower);
    if (star) max *= T.STAR_SPEED_FACTOR;
    if (shrunk) max *= T.SHRINK_SPEED_FACTOR;
    max *= this.speedMultiplier || 1; // external hook (AI rubber-banding)
    this.maxSpeed = max;

    // ---- 3. longitudinal
    let speed = num(this.speed);
    if (stunned) {
      speed = moveToward(speed, 0, T.SPIN_DECEL * dt);
    } else if (brake > 0 && speed > 0.05) {
      speed = Math.max(0, speed - T.BRAKE_DECEL * brake * dt); // braking
    } else if (brake > 0 && throttle > 0) {
      speed = moveToward(speed, 0, T.BRAKE_DECEL * dt); // both pedals: hold still
    } else if (brake > 0) {
      speed = Math.max(-T.REVERSE_MAX, speed - T.REVERSE_ACCEL * brake * dt); // reverse
    } else if (throttle > 0) {
      if (speed < 0) {
        speed = Math.min(0, speed + T.BRAKE_DECEL * dt); // stop reversing first
      } else if (speed < max) {
        const r = speed / max;
        const accel = boosting ? T.BOOST_ACCEL : T.ACCEL * (1 - T.ACCEL_TAPER * r * r * r);
        speed = Math.min(max, speed + accel * throttle * dt);
      }
    } else {
      speed *= Math.max(0, 1 - T.COAST_DRAG * dt); // coasting
      speed = moveToward(speed, 0, T.ROLLING_FRICTION * dt);
    }
    if (speed > max) { // above the cap: boost expired / went offroad / shrunk
      const rate = this.offroad && !boosting ? T.OFFROAD_DECEL : T.OVERSPEED_DECAY;
      speed = Math.max(max, speed - rate * dt);
    }

    // ---- 4. hop + drift
    let turnRate = 0;   // rad/s, positive = turning right (yaw decreases)
    let slipTarget = 0;
    const driftPressed = driftHeld && !this._driftHeldPrev;
    this._driftHeldPrev = driftHeld;

    if (!s.drifting) {
      // press to hop; or, with the key already held, steer hard to hop again (hold-to-drift)
      const autoHop = driftHeld && !driftPressed && Math.abs(steer) > 0.5 && this._hopArmTimer === 0 && this._driftRearm === 0;
      if ((driftPressed || autoHop) && s.hopTimer === 0 && speed > T.DRIFT_MIN_SPEED) {
        s.hopTimer = T.HOP_TIME;
        this._hopArmTimer = T.HOP_DRIFT_WINDOW;
        this.audio?.play?.('hop');
      }
      if (this._hopArmTimer > 0) {
        if (!driftHeld || speed < T.DRIFT_END_SPEED) {
          this._hopArmTimer = 0;
    this._driftRearm = 0;
        } else if (Math.abs(steer) > 0.2) {
          this._hopArmTimer = 0;
    this._driftRearm = 0;
          s.drifting = true;
          s.driftDir = steer > 0 ? 1 : -1;
          s.driftCharge = 0;
          s.driftTier = 0;
        }
      }
    }

    if (s.drifting) {
      const tooSlow = speed < T.DRIFT_END_SPEED;
      if (!driftHeld || tooSlow || stunned) {
        const tier = s.driftTier;
        const released = !driftHeld && !tooSlow && !stunned;
        this._endDrift();
        if (released && tier >= 1) this.applyBoost(T.MINI_TURBO_DURATIONS[tier], T.MINI_TURBO_POWER);
      } else {
        const scale = clamp(speed / 25, 0.55, 1); // slightly gentler arcs at low speed
        turnRate = s.driftDir * (T.DRIFT_BASE_TURN + steer * s.driftDir * T.DRIFT_STEER_TURN) * scale;
        slipTarget = s.driftDir * T.DRIFT_SLIP_ANGLE;
        s.driftCharge += dt;
        const tier = Math.min(3, Math.floor(s.driftCharge / T.DRIFT_CHARGE_TIME));
        if (tier !== s.driftTier) {
          s.driftTier = tier;
          if (tier > 0) this.audio?.play?.('drift_tier' + tier);
        }
      }
    }

    if (!s.drifting) {
      // normal steering: slower at speed, fades out when stopped, mirrored in reverse
      const ratio = Math.min(1, Math.abs(speed) / T.BASE_MAX_SPEED);
      const rate = lerp(T.STEER_RATE_LOW, T.STEER_RATE_HIGH, ratio);
      const authority = Math.min(1, Math.abs(speed) / T.STEER_FULL_SPEED);
      turnRate = steer * rate * authority * (speed < 0 ? -1 : 1);
    }

    const slipRate = s.drifting ? T.DRIFT_SLIP_RATE : T.SLIP_RECOVER_RATE;
    this.slipAngle += (slipTarget - this.slipAngle) * Math.min(1, slipRate * dt);

    // ---- 5. yaw
    this.yaw = wrapAngle(this.yaw - turnRate * dt);

    // ---- 6. move along the (slipped) heading, then query the road
    const heading = this.yaw + this.slipAngle;
    const hx = Math.sin(heading), hz = Math.cos(heading);
    const pos = this.group.position;
    const prevY = pos.y;
    pos.x += hx * speed * dt;
    pos.z += hz * speed * dt;
    if (this.shove.lengthSq() > 1e-4) { // kart-kart bump shove, decaying
      pos.x += this.shove.x * dt;
      pos.z += this.shove.z * dt;
      this.shove.multiplyScalar(Math.exp(-TUNING.BUMP_DRAG * dt));
    }

    let info = null;
    if (track && typeof track.getRoadInfo === 'function') info = track.getRoadInfo(pos, this.trackT);
    if (info) {
      if (Number.isFinite(info.t)) this.trackT = info.t;
      this.offroad = typeof info.onRoad === 'boolean' ? !info.onRoad : info.surface === 'offroad';

      if (Number.isFinite(info.height)) {
        if (Math.abs(info.height - this._groundY) > 3) this._groundY = info.height; // teleport
        else this._groundY += (info.height - this._groundY) * Math.min(1, T.HEIGHT_LERP * dt);
        pos.y = this._groundY;
      }

      if (info.surface === 'boost' && this._boostPadCooldown === 0) {
        this.applyBoost(T.BOOST_PAD.duration, T.BOOST_PAD.power);
        this._boostPadCooldown = T.BOOST_PAD_COOLDOWN;
      }

      // ---- 7. walls: clamp lateral, kill the slide, impact (fresh hit) or grind (scraping), nudge heading
      const right = info.right, lateral = info.lateral, tg = info.tangent;
      if (right && Number.isFinite(lateral) && Number.isFinite(right.x + right.z)) {
        const wallDist = Number.isFinite(info.wallDistance) ? info.wallDistance : ROAD_WIDTH / 2 + WALL_MARGIN;
        const limit = wallDist - this.radius;
        if (Math.abs(lateral) > limit) {
          const side = lateral > 0 ? 1 : -1;
          const push = lateral - side * (limit - 0.05); // small bounce back inside
          pos.x -= right.x * push;
          pos.z -= right.z * push;
          this.slipAngle *= 0.5;
          if (s.drifting) this._endDrift();
          if (this._wallFreeTime >= T.WALL_REHIT_GAP && this._wallCooldown === 0) {
            speed *= 1 - T.WALL_SPEED_LOSS; // impact
            this._wallCooldown = T.WALL_COOLDOWN;
            this.wallHit = true;
            this.audio?.play?.('wall');
            this._rollKick = -side * 0.35;
            if (this.particles?.emitPop) {
              this._tmp.set(pos.x + right.x * side * 0.9, pos.y + 0.45, pos.z + right.z * side * 0.9);
              this.particles.emitPop(this._tmp, 0xffd58a);
            }
          } else {
            speed = moveToward(speed, 0, T.WALL_GRIND_DECEL * dt); // grind
          }
          this._wallFreeTime = 0;
          if (tg) {
            const dir = speed < 0 ? -1 : 1;
            const intoWall = (hx * right.x + hz * right.z) * side * dir > 0;
            if (intoWall) {
              let targetYaw = Math.atan2(tg.x, tg.z);
              if (hx * tg.x + hz * tg.z < 0) targetYaw += Math.PI; // facing backwards: align with -tangent
              const diff = wrapAngle(targetYaw - this.yaw);
              this.yaw = wrapAngle(this.yaw + diff * Math.min(1, T.WALL_YAW_NUDGE * dt));
            }
          }
        } else {
          this._wallFreeTime += dt;
        }
      }

      // pitch target from the road slope (sign depends on which way we face along the tangent)
      if (tg) {
        const horiz = Math.hypot(num(tg.x), num(tg.z)) || 1;
        const facing = hx * tg.x + hz * tg.z >= 0 ? 1 : -1;
        this._pitchTarget = -Math.atan2(num(tg.y), horiz) * facing;
      }
    }

    // ---- 8. derived velocity
    this.speed = speed;
    this.lateralVel = -speed * Math.sin(this.slipAngle);
    this.velocity.set(hx * speed, (pos.y - prevY) / dt, hz * speed);
    s.airborne = s.hopTimer > 0;

    this._updateVisuals(dt, steer, speed);
    this._emitEffects(dt, speed);
  }

  // ------------------------------------------------------------------ visuals
  _updateVisuals(dt, steer, speed) {
    const T = TUNING, s = this.state, M = this.model;
    const ratio = Math.min(1, Math.abs(speed) / T.BASE_MAX_SPEED);
    const TWO_PI = Math.PI * 2;

    // wheels: spin about the axle, front pivots yaw with (smoothed) steer
    this._steerVisual += (steer - this._steerVisual) * Math.min(1, 12 * dt);
    this._spinFront = (this._spinFront + (speed / T.WHEEL_RADIUS_FRONT) * dt) % TWO_PI;
    this._spinRear = (this._spinRear + (speed / T.WHEEL_RADIUS_REAR) * dt) % TWO_PI;
    for (const w of M.frontWheels) {
      w.spinner.rotation.x = this._spinFront;
      w.pivot.rotation.y = -this._steerVisual * 0.45;
    }
    for (const w of M.rearWheels) w.spinner.rotation.x = this._spinRear;

    // driver: steering wheel, lean into the turn, bob with speed
    M.steeringWheel.rotation.z = -this._steerVisual * 1.1;
    M.driver.rotation.z = this._steerVisual * 0.1;
    M.driver.position.y = (M.driverY ?? DRIVER_Y) + Math.sin(this._time * (7 + 14 * ratio)) * 0.012 * (0.2 + ratio);

    // body roll (outward in corners, lean into the slide when drifting) and pitch (slope + accel)
    const rollTarget = -this._steerVisual * ratio * 0.09 + (s.drifting ? s.driftDir * 0.15 : 0);
    this._rollKick *= Math.exp(-7 * dt);
    this._roll += (rollTarget + this._rollKick - this._roll) * Math.min(1, 8 * dt);
    const accel = s.stunTimer > 0 ? 0 : (speed - this._prevSpeed) / dt;
    this._prevSpeed = speed;
    const accelPitch = clamp(-accel * 0.004, -0.06, 0.06);
    this._pitch += (this._pitchTarget + accelPitch - this._pitch) * Math.min(1, 8 * dt);

    // hop / crash tumble (visual offsets on the inner body group)
    let bodyY = 0, tumblePitch = 0, spinVisual = 0;
    if (s.hopTimer > 0) bodyY += T.HOP_HEIGHT * Math.sin(Math.PI * (1 - s.hopTimer / T.HOP_TIME));
    if (s.spinTimer > 0) {
      const phase = 1 - s.spinTimer / this._spinDuration;
      spinVisual = this._spinSign * phase * TWO_PI * this._spinTurns;
      if (this._tumble) {
        const elapsed = this._spinDuration - s.spinTimer;
        bodyY += 0.9 * Math.sin(Math.PI * Math.min(1, elapsed / 0.7));
        tumblePitch = Math.sin(elapsed * 10) * 0.3 * (s.spinTimer / this._spinDuration);
      }
    }
    this.body.position.y = bodyY;
    this.group.rotation.set(this._pitch + tumblePitch, this.yaw + spinVisual, this._roll);

    // boost flames
    if (s.boostTimer > 0) {
      const len = 0.6 + (Math.max(1, s.boostPower) - 1) * 1.6;
      for (const f of this.flames) {
        const flick = 0.85 + Math.random() * 0.3;
        f.visible = true;
        f.scale.set(0.9 * flick, 0.9 * flick, len * flick);
      }
    } else {
      for (const f of this.flames) { f.visible = false; f.scale.setScalar(0.001); }
    }

    // star: rainbow emissive cycling on the body colour
    if (s.invincibleTimer > 0) this._setStarVisual(true);
    else if (this._starActive) this._setStarVisual(false);

    // shrink: smooth scale
    const targetScale = s.shrinkTimer > 0 ? T.SHRINK_SCALE : 1;
    const sc = this.group.scale.x + (targetScale - this.group.scale.x) * Math.min(1, 6 * dt);
    this.group.scale.setScalar(Math.abs(sc - targetScale) < 0.002 ? targetScale : sc);
  }

  _setStarVisual(on) {
    const M = this.model;
    if (on) {
      const hue = (this._time * 2.5) % 1;
      M.bodyMat.emissive.setHSL(hue, 1, 0.5);
      M.bodyMat.emissiveIntensity = 0.85;
      M.accentMat.emissive.setHSL((hue + 0.5) % 1, 1, 0.55);
      M.accentMat.emissiveIntensity = 0.7;
      this._starActive = true;
    } else {
      M.bodyMat.emissive.setHex(0x000000);
      M.bodyMat.emissiveIntensity = 1;
      M.accentMat.emissive.setHex(0x000000);
      M.accentMat.emissiveIntensity = 1;
      this._starActive = false;
    }
  }

  // ------------------------------------------------------------------ effects
  _emitEffects(dt, speed) {
    const P = this.particles;
    if (!P) return;
    const s = this.state;

    if (s.drifting && typeof P.emitDrift === 'function') {
      this._driftEmitAcc += dt;
      if (this._driftEmitAcc >= 0.016) {
        this._driftEmitAcc = 0;
        this._rearWheels(this._wheelL, this._wheelR);
        const right = this.rightVector();
        P.emitDrift(this._wheelL.clone(), s.driftTier, right);
        P.emitDrift(this._wheelR.clone(), s.driftTier, right.clone());
      }
    } else {
      this._driftEmitAcc = 0;
    }

    if (s.boostTimer > 0 && typeof P.emitBoost === 'function') {
      this._boostEmitAcc += dt;
      if (this._boostEmitAcc >= 0.016) {
        this._boostEmitAcc = 0;
        const back = this.forwardVector().negate();
        P.emitBoost(this.exhaustWorldPosition(), back, s.boostPower);
      }
    } else {
      this._boostEmitAcc = 0;
    }

    if (this.offroad && Math.abs(speed) > 8 && typeof P.emitDust === 'function') {
      this._dustEmitAcc += dt;
      if (this._dustEmitAcc >= 0.04) {
        this._dustEmitAcc = 0;
        this._rearWheels(this._wheelL, this._wheelR);
        P.emitDust((this._dustSide++ & 1 ? this._wheelL : this._wheelR).clone());
      }
    } else {
      this._dustEmitAcc = 0;
    }
  }
}
