// Turbo Kart Grand Prix — track.js
// Procedural circuit: closed Catmull-Rom centre-line, ribbon road with curbs, terrain,
// barriers, boost pads and all trackside scenery. Everything is generated at runtime.
//
// Pure-math parts (design points, curve, lookup table, queryRoad) are exported so they can
// be verified in node without a DOM: see tests/verify-track.mjs.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD_WIDTH, WALL_MARGIN } from './constants.js';

// ---------------------------------------------------------------------------
// Small math / random helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so the scenery layout is identical every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
function smoothstep(e0, e1, x) {
  const k = clamp((x - e0) / (e1 - e0), 0, 1);
  return k * k * (3 - 2 * k);
}

/** Hash-based 2D value noise in [-1, 1]. */
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296 * 2 - 1;
}
function valueNoise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}
export function fbm2(x, z, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq + i * 17.3, z * freq - i * 9.1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Circuit design
// ---------------------------------------------------------------------------
// Heading convention: forward = (sin(yaw), 0, cos(yaw)); right = tangent x up.
// Driving +Z means "right" is -X. The circuit below turns mostly right (clockwise from
// above with +Z pointing down the screen) with an S-section and one left sweeper on the hill.
//
// t = 0 is the finish line, in the middle of the long start/finish straight (heading +Z).
export const DESIGN_POINTS = [
  // Start/finish straight (heading +Z). Finish line at index 0; grid sits at z -64..-80.
  [0, 0, -60],
  [0, 0, 10],
  [0, 0, 80],
  [0, 0, 100],
  // Fast sweeping right-hander, R = 80 m (centre -80, 100).
  [-10.7, 0, 140],
  [-40, 0, 169.3],
  [-80, 0, 180],
  // S-curve section heading -X (left swing, then right).
  [-110, 0, 195],
  [-140, 0, 215],
  [-175, 0, 215],
  [-200, 0, 195],
  [-220, 0, 185],
  // Hairpin right, R = 32 m (centre -240, 153); starts climbing.
  [-240, 0, 185],
  [-262.6, 0.8, 175.6],
  [-272, 1.6, 153],
  [-262.6, 2.4, 130.4],
  [-240, 3.2, 121],
  // Hill climb heading +X.
  [-205, 5.5, 121],
  [-170, 7.5, 121],
  // Left sweeper over the crest, R = 60 m (centre -170, 61).
  [-140, 9.5, 113],
  [-118, 11, 91],
  [-110, 10.8, 61],
  // Descent heading -Z.
  [-110, 7.6, 10],
  [-110, 3.6, -60],
  // Wide chicane (right-left).
  [-92, 1.9, -90],
  [-90, 0.7, -115],
  [-110, 0, -150],
  // Final sweeping right U-turn, R = 55 m (centre -55, -150), back onto the straight.
  [-93.9, 0, -188.9],
  [-55, 0, -205],
  [-16.1, 0, -188.9],
  [0, 0, -150],
  [0, 0, -105],
];

/**
 * Builds the closed, centripetal Catmull-Rom centre-line. The hand-placed design curve is
 * resampled at uniform arc-length spacing and rebuilt, so the raw curve parameter is a very
 * close approximation of the arc-length parameter (curve.getPoint(t) ~= curve.getPointAt(t)).
 * Every `t` this module exposes is the arc-length parameter (use getPointAt / getTangentAt).
 */
export function buildTrackCurve(resamplePoints = 128) {
  const design = new THREE.CatmullRomCurve3(
    DESIGN_POINTS.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    true,
    'centripetal',
  );
  design.arcLengthDivisions = 4000;
  design.updateArcLengths();
  const pts = [];
  for (let i = 0; i < resamplePoints; i++) pts.push(design.getPointAt(i / resamplePoints));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  curve.arcLengthDivisions = 4000;
  curve.updateArcLengths();
  return curve;
}

/**
 * Dense lookup table along the curve (arc-length uniform): positions, unit tangents and
 * horizontal unit right vectors, plus the total length. Used by getRoadInfo and by all the
 * mesh builders.
 */
export function buildRoadLookup(curve, n = 2048) {
  const positions = new Float32Array(n * 3);
  const tangents = new Float32Array(n * 3);
  const rights = new Float32Array(n * 3);
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3(), tg = new THREE.Vector3(), r = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const u = i / n;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, tg).normalize();
    r.crossVectors(tg, up);
    r.y = 0;
    r.normalize();
    positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z;
    tangents[i * 3] = tg.x; tangents[i * 3 + 1] = tg.y; tangents[i * 3 + 2] = tg.z;
    rights[i * 3] = r.x; rights[i * 3 + 1] = r.y; rights[i * 3 + 2] = r.z;
  }
  return { n, positions, tangents, rights, length: curve.getLength() };
}

/** Interpolated centre-line sample at arc-length parameter t (wraps). */
export function lookupAt(lut, t, out) {
  const n = lut.n;
  let f = (t - Math.floor(t)) * n;
  const i0 = Math.floor(f) % n;
  const i1 = (i0 + 1) % n;
  const s = f - Math.floor(f);
  const P = lut.positions, T = lut.tangents, R = lut.rights;
  out.x = lerp(P[i0 * 3], P[i1 * 3], s);
  out.y = lerp(P[i0 * 3 + 1], P[i1 * 3 + 1], s);
  out.z = lerp(P[i0 * 3 + 2], P[i1 * 3 + 2], s);
  out.tx = lerp(T[i0 * 3], T[i1 * 3], s);
  out.ty = lerp(T[i0 * 3 + 1], T[i1 * 3 + 1], s);
  out.tz = lerp(T[i0 * 3 + 2], T[i1 * 3 + 2], s);
  const tl = Math.hypot(out.tx, out.ty, out.tz) || 1;
  out.tx /= tl; out.ty /= tl; out.tz /= tl;
  out.rx = lerp(R[i0 * 3], R[i1 * 3], s);
  out.rz = lerp(R[i0 * 3 + 2], R[i1 * 3 + 2], s);
  const rl = Math.hypot(out.rx, out.rz) || 1;
  out.rx /= rl; out.rz /= rl;
  return out;
}

/**
 * Closest-point query against the lookup table (XZ distance). Returns a plain object:
 * { t, x, y, z, tx, ty, tz, rx, rz, lateral, dist }. With hintT the search is limited to
 * +-hintWindow in t (wrapping); a coarse-to-fine global search is used otherwise.
 */
export function queryRoad(lut, px, pz, hintT, out = {}, hintWindow = 0.06) {
  const n = lut.n;
  const P = lut.positions;
  let best = -1, bestD = Infinity;

  const consider = (i) => {
    const dx = P[i * 3] - px, dz = P[i * 3 + 2] - pz;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  };

  if (hintT !== undefined && hintT !== null && Number.isFinite(hintT)) {
    const c = Math.round((hintT - Math.floor(hintT)) * n);
    const w = Math.ceil(hintWindow * n);
    for (let k = -w; k <= w; k++) consider((c + k + n * 4) % n);
    // Sanity: if the local best is implausibly far (teleport / respawn), fall back to global.
    if (bestD > 60 * 60) { best = -1; bestD = Infinity; }
  }
  if (best < 0) {
    const stride = 8;
    for (let i = 0; i < n; i += stride) consider(i);
    const c = best;
    for (let k = -stride; k <= stride; k++) consider((c + k + n) % n);
  }

  // Refine: project onto the two polyline segments adjacent to the best sample.
  const prev = (best - 1 + n) % n, next = (best + 1) % n;
  let bi = best, bs = 0, bd = bestD;
  for (const [ia, ib] of [[prev, best], [best, next]]) {
    const ax = P[ia * 3], az = P[ia * 3 + 2];
    const bx = P[ib * 3], bz = P[ib * 3 + 2];
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-9) continue;
    let s = ((px - ax) * ex + (pz - az) * ez) / len2;
    s = clamp(s, 0, 1);
    const qx = ax + ex * s - px, qz = az + ez * s - pz;
    const d = qx * qx + qz * qz;
    if (d < bd) { bd = d; bi = ia; bs = s; }
  }

  let t = (bi + bs) / n;
  t -= Math.floor(t);
  lookupAt(lut, t, out);
  out.t = t;
  const dx = px - out.x, dz = pz - out.z;
  out.lateral = dx * out.rx + dz * out.rz;
  out.dist = Math.sqrt(bd);
  return out;
}

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finishTexture(canvas, renderer, repeat = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  tex.needsUpdate = true;
  return tex;
}

/** Asphalt tile: 16 m x 16 m. Speckle noise, cracks, white edge lines, dashed yellow centre line. */
export function makeAsphaltTexture(renderer, size = 1024) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = mulberry32(1234);
  ctx.fillStyle = '#3b3b40';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const nse = (rand() - 0.5) * 34;
    const speck = rand() < 0.03 ? rand() * 60 : 0;
    d[i] = clamp(d[i] + nse + speck, 0, 255);
    d[i + 1] = clamp(d[i + 1] + nse + speck, 0, 255);
    d[i + 2] = clamp(d[i + 2] + nse * 0.9 + speck, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  // Large soft patches (wear).
  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = `rgba(${rand() < 0.5 ? '20,20,24' : '90,90,96'},${0.05 + rand() * 0.08})`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, 40 + rand() * 160, 20 + rand() * 90, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Subtle cracks.
  ctx.strokeStyle = 'rgba(15,15,18,0.55)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 10; i++) {
    let x = rand() * size, y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (rand() - 0.5) * 70; y += (rand() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Edge lines: 0.3 m wide, 0.3 m in from each edge (u runs across the road).
  const m = size / 16; // px per metre
  ctx.fillStyle = 'rgba(245,245,240,0.92)';
  ctx.fillRect(0.3 * m, 0, 0.3 * m, size);
  ctx.fillRect(size - 0.6 * m, 0, 0.3 * m, size);
  // Dashed yellow centre line: two 3.5 m dashes per 16 m tile.
  ctx.fillStyle = 'rgba(255,205,60,0.95)';
  for (let k = 0; k < 2; k++) ctx.fillRect(size / 2 - 0.11 * m, k * 8 * m + 1.5 * m, 0.22 * m, 3.5 * m);
  return finishTexture(c, renderer);
}

/** Grass tile: 8 m x 8 m. */
export function makeGrassTexture(renderer, size = 512) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = mulberry32(777);
  ctx.fillStyle = '#4e9a2e';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const nse = (rand() - 0.5) * 30;
    d[i] = clamp(d[i] + nse * 0.8, 0, 255);
    d[i + 1] = clamp(d[i + 1] + nse, 0, 255);
    d[i + 2] = clamp(d[i + 2] + nse * 0.5, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  // Patches.
  for (let i = 0; i < 40; i++) {
    const g = 120 + rand() * 60;
    ctx.fillStyle = `rgba(${g * 0.55},${g},${g * 0.25},${0.08 + rand() * 0.14})`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, 20 + rand() * 70, 15 + rand() * 50, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Blade dabs.
  for (let i = 0; i < 2600; i++) {
    const g = 130 + rand() * 90;
    ctx.strokeStyle = `rgba(${g * 0.5},${g},${g * 0.3},0.55)`;
    ctx.lineWidth = 1 + rand();
    const x = rand() * size, y = rand() * size, l = 3 + rand() * 6, a = (rand() - 0.5) * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(a) * l, y - Math.cos(a) * l);
    ctx.stroke();
  }
  return finishTexture(c, renderer);
}

/** Worn verge / dirt tile: 6 m x 6 m (offroad shoulder between curb and barrier). */
export function makeDirtTexture(renderer, size = 512) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = mulberry32(4242);
  ctx.fillStyle = '#8a7a4a';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const nse = (rand() - 0.5) * 40;
    d[i] = clamp(d[i] + nse, 0, 255);
    d[i + 1] = clamp(d[i + 1] + nse, 0, 255);
    d[i + 2] = clamp(d[i + 2] + nse * 0.7, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 70; i++) {
    const green = rand() < 0.5;
    ctx.fillStyle = green ? `rgba(90,140,50,${0.15 + rand() * 0.25})` : `rgba(120,95,60,${0.15 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, 15 + rand() * 60, 10 + rand() * 40, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 700; i++) {
    const v = 70 + rand() * 80;
    ctx.fillStyle = `rgba(${v},${v * 0.85},${v * 0.55},0.6)`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
  }
  return finishTexture(c, renderer);
}

/** Curb tile: red block then white block along v (each block 2 m long on a 1.2 m wide curb). */
export function makeCurbTexture(renderer) {
  const w = 128, h = 256;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e53935';
  ctx.fillRect(0, 0, w, h / 2);
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, h / 2, w, h / 2);
  // Grime / bevel toward the outer edge.
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.18)');
  grad.addColorStop(0.15, 'rgba(0,0,0,0)');
  grad.addColorStop(0.85, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const rand = mulberry32(99);
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rand() * 0.12})`;
    ctx.fillRect(rand() * w, rand() * h, 2, 2);
  }
  return finishTexture(c, renderer);
}

/** Black/white checker. */
export function makeCheckerTexture(renderer, cells = 8, size = 256) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const s = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111111' : '#f5f5f5';
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  return finishTexture(c, renderer);
}

/** Wide banner with checkered borders and bold outlined text (gantry / arch signs). */
export function makeBannerTexture(text, renderer, opts = {}) {
  const w = 1024, h = 256;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const bg = opts.bg ?? '#d32f2f';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const cs = 32;
  for (let x = 0; x < w / cs; x++) {
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#111111' : '#f5f5f5';
      ctx.fillRect(x * cs, y * cs, cs, cs);
      ctx.fillRect(x * cs, h - (y + 1) * cs, cs, cs);
    }
  }
  ctx.font = `900 ${opts.fontSize ?? 130}px "Arial Black", "Segoe UI Black", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 18;
  ctx.strokeStyle = '#111111';
  ctx.strokeText(text, w / 2, h / 2 + 6);
  ctx.fillStyle = opts.fg ?? '#ffffff';
  ctx.fillText(text, w / 2, h / 2 + 6);
  return finishTexture(c, renderer, false);
}

/** Billboard poster: bright gradient background, big outlined word, a few stars. */
export function makeBillboardTexture(text, renderer, colorA, colorB, textColor) {
  const w = 1024, h = 512;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, colorA);
  g.addColorStop(1, colorB);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const rand = mulberry32(text.length * 31 + 7);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 14; i++) {
    const x = rand() * w, y = rand() * h, r = 10 + rand() * 40;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const rr = k % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 16;
  ctx.strokeRect(24, 24, w - 48, h - 48);
  ctx.font = '900 240px "Arial Black", "Segoe UI Black", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 28;
  ctx.strokeStyle = '#1a1a2e';
  ctx.strokeText(text, w / 2, h / 2 + 12);
  ctx.fillStyle = textColor;
  ctx.fillText(text, w / 2, h / 2 + 12);
  return finishTexture(c, renderer, false);
}

/** Boost pad: orange base with yellow chevrons pointing along +v (forward). */
export function makeBoostTexture(renderer) {
  const w = 256, h = 512;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff7a00';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffe14d';
  const n = 3;
  for (let i = 0; i < n; i++) {
    const y0 = h - (i + 1) * (h / n) + 30;
    ctx.beginPath();
    ctx.moveTo(20, y0 + 90);
    ctx.lineTo(w / 2, y0);
    ctx.lineTo(w - 20, y0 + 90);
    ctx.lineTo(w - 20, y0 + 130);
    ctx.lineTo(w / 2, y0 + 40);
    ctx.lineTo(20, y0 + 130);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = '#ffd000';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);
  return finishTexture(c, renderer, false);
}

/** Water ripple tile. */
export function makeWaterTexture(renderer, size = 256) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rand = mulberry32(31);
  ctx.fillStyle = '#3d9be9';
  ctx.fillRect(0, 0, size, size);
  ctx.lineWidth = 2;
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = `rgba(210,240,255,${0.12 + rand() * 0.25})`;
    const x = rand() * size, y = rand() * size, l = 20 + rand() * 60;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + l * 0.5, y - 6 + rand() * 12, x + l, y);
    ctx.stroke();
  }
  return finishTexture(c, renderer);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Adds a constant vertex colour attribute (needed so parts can be merged into one mesh). */
function withColor(geometry, color) {
  const col = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = geometry.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geometry;
}

/** Transform helper for parts about to be merged. */
function placed(geometry, x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  geometry.applyMatrix4(m);
  return geometry;
}

/** Strip merged geometry of attributes other than position/normal/uv/color so merges match. */
function normalizeAttributes(geometry) {
  const keep = ['position', 'normal', 'uv', 'color'];
  for (const name of Object.keys(geometry.attributes)) if (!keep.includes(name)) geometry.deleteAttribute(name);
  if (!geometry.getAttribute('uv')) {
    const n = geometry.getAttribute('position').count;
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geometry;
}

function mergeParts(parts) {
  const cleaned = parts.map((g) => normalizeAttributes(g.index ? g.toNonIndexed() : g));
  return mergeGeometries(cleaned, false);
}

/**
 * Ribbon along the centre-line between lateral offsets a < b (metres along `right`).
 * uAcross runs 0..1 from a to b; v repeats `vRepeats` times over one lap (integer → seamless).
 */
function buildRibbon(lut, a, b, yOffset, vRepeats, stride = 2) {
  const n = Math.floor(lut.n / stride);
  const pos = new Float32Array((n + 1) * 2 * 3);
  const nor = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx = new Uint32Array(n * 6);
  const P = lut.positions, T = lut.tangents, R = lut.rights;
  for (let k = 0; k <= n; k++) {
    const i = (k * stride) % lut.n;
    const cx = P[i * 3], cy = P[i * 3 + 1] + yOffset, cz = P[i * 3 + 2];
    const rx = R[i * 3], rz = R[i * 3 + 2];
    // normal = right x tangent (points up for a flat road)
    const tx = T[i * 3], ty = T[i * 3 + 1], tz = T[i * 3 + 2];
    let nx = 0 * tz - rz * ty, ny = rz * tx - rx * tz, nz = rx * ty - 0 * tx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const v = (k / n) * vRepeats;
    const o = k * 6;
    pos[o] = cx + rx * a; pos[o + 1] = cy; pos[o + 2] = cz + rz * a;
    pos[o + 3] = cx + rx * b; pos[o + 4] = cy; pos[o + 5] = cz + rz * b;
    nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
    nor[o + 3] = nx; nor[o + 4] = ny; nor[o + 5] = nz;
    uv[k * 4] = 0; uv[k * 4 + 1] = v;
    uv[k * 4 + 2] = 1; uv[k * 4 + 3] = v;
  }
  for (let k = 0; k < n; k++) {
    const A = k * 2, B = k * 2 + 1, A1 = k * 2 + 2, B1 = k * 2 + 3;
    const o = k * 6;
    idx[o] = A; idx[o + 1] = B; idx[o + 2] = A1;
    idx[o + 3] = B; idx[o + 4] = B1; idx[o + 5] = A1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// ---------------------------------------------------------------------------
// Terrain height field (pure; shared by terrain mesh, tree placement, etc.)
// ---------------------------------------------------------------------------

export function createTerrainField(lut, opts) {
  const {
    flatRadius = 16, blendRadius = 52, lake, flatZones = [], bounds, planeY = -0.6,
  } = opts;
  const n = lut.n, P = lut.positions;
  const coarseStride = 8;
  const nc = Math.floor(n / coarseStride);
  const cx = new Float32Array(nc), cz = new Float32Array(nc), cy = new Float32Array(nc);
  for (let j = 0; j < nc; j++) {
    cx[j] = P[j * coarseStride * 3]; cy[j] = P[j * coarseStride * 3 + 1]; cz[j] = P[j * coarseStride * 3 + 2];
  }

  const tmp = { d: 0, h: 0, i: 0 };
  /** Nearest fine sample (XZ) — coarse scan then local refine. */
  function nearest(x, z) {
    let bj = 0, bd = Infinity;
    for (let j = 0; j < nc; j++) {
      const dx = cx[j] - x, dz = cz[j] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bj = j; }
    }
    let bi = bj * coarseStride;
    for (let k = -coarseStride; k <= coarseStride; k++) {
      const i = (bj * coarseStride + k + n) % n;
      const dx = P[i * 3] - x, dz = P[i * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    tmp.d = Math.sqrt(bd);
    tmp.h = P[bi * 3 + 1];
    tmp.i = bi;
    return tmp;
  }

  function farHeight(x, z) {
    let sw = 0, sh = 0;
    for (let j = 0; j < nc; j++) {
      const dx = cx[j] - x, dz = cz[j] - z;
      const w = 1 / (dx * dx + dz * dz + 900);
      sw += w; sh += w * cy[j];
    }
    return sh / sw;
  }

  function height(x, z) {
    const nr = nearest(x, z);
    const d = nr.d;
    const roadLevel = nr.h - 0.05;
    if (d <= flatRadius) return roadLevel;            // flat apron beside the road
    // Far-field: smoothed road heights + rolling noise, lake bowl and flat zones.
    let h = farHeight(x, z) + 0.6;
    const amp = 0.5 * smoothstep(flatRadius - 2, 40, d) + 3.2 * smoothstep(60, 170, d);
    h += amp * fbm2(x * 0.018 + 3.1, z * 0.018 - 7.7, 4);
    if (lake) {
      const dl = Math.hypot(x - lake.x, z - lake.z);
      if (dl < lake.r + 20) h = lerp(h, lake.y - 3.0, smoothstep(lake.r + 20, lake.r - 8, dl));
    }
    for (const zn of flatZones) {
      const dz = Math.hypot(x - zn.x, z - zn.z);
      const bw = zn.blend ?? 14;
      if (dz < zn.r + bw) h = lerp(h, zn.y, smoothstep(zn.r + bw, zn.r, dz));
    }
    if (bounds) {
      const e = Math.max(Math.abs(x - bounds.cx) / bounds.hw, Math.abs(z - bounds.cz) / bounds.hh);
      h = lerp(h, planeY, smoothstep(0.78, 1.0, e));
    }
    // The road apron always wins near the track, whatever the far-field does.
    return lerp(roadLevel, h, smoothstep(flatRadius, blendRadius, d));
  }

  return { height, nearest, farHeight, roadDistance: (x, z) => nearest(x, z).d };
}

// ---------------------------------------------------------------------------
// Scenery geometry builders (all vertex-coloured so each kind is one draw call)
// ---------------------------------------------------------------------------

const _Y = new THREE.Vector3(0, 1, 0);

function makePineGeometry() {
  return mergeParts([
    withColor(new THREE.CylinderGeometry(0.22, 0.38, 2.6, 6), 0x6b4423).translate(0, 1.3, 0),
    withColor(new THREE.ConeGeometry(2.5, 3.4, 8), 0x1f7a34).translate(0, 3.6, 0),
    withColor(new THREE.ConeGeometry(2.0, 3.0, 8), 0x2a8f3c).translate(0, 5.6, 0),
    withColor(new THREE.ConeGeometry(1.4, 2.6, 8), 0x37a344).translate(0, 7.5, 0),
  ]);
}

function makeDeciduousGeometry() {
  return mergeParts([
    withColor(new THREE.CylinderGeometry(0.28, 0.45, 3.2, 7), 0x7a4a26).translate(0, 1.6, 0),
    withColor(new THREE.IcosahedronGeometry(2.7, 1), 0x3f9f2f).scale(1, 0.85, 1).translate(0, 5.0, 0),
    withColor(new THREE.IcosahedronGeometry(1.9, 1), 0x4fb43a).translate(1.4, 5.9, 0.7),
    withColor(new THREE.IcosahedronGeometry(1.7, 1), 0x2f8f2a).translate(-1.3, 5.6, -0.8),
  ]);
}

function makePalmGeometry() {
  const parts = [];
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 2.6, 0.1),
    new THREE.Vector3(0.7, 5.2, 0.25), new THREE.Vector3(1.05, 7.4, 0.35),
  ]);
  parts.push(withColor(new THREE.TubeGeometry(path, 8, 0.27, 7, false), 0x9b6b3c));
  const top = path.getPoint(1);
  for (let k = 0; k < 8; k++) {
    const frond = new THREE.PlaneGeometry(1.1, 3.8, 1, 6);
    frond.rotateX(Math.PI / 2);      // lie in XZ, spanning z in [-1.9, 1.9]
    frond.translate(0, 0, 1.9);      // z in [0, 3.8]
    const pos = frond.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i), x = pos.getX(i);
      const f = z / 3.8;
      pos.setY(i, -1.4 * f * f + 0.25 * Math.abs(x) * (1 - f));   // droop + slight V
      pos.setX(i, x * (1 - f * 0.55));                            // taper to the tip
    }
    frond.rotateX(-0.55);
    frond.rotateY((k / 8) * Math.PI * 2 + 0.3);
    frond.translate(top.x, top.y - 0.1, top.z);
    parts.push(withColor(frond, k % 2 ? 0x3aa848 : 0x2f9540));
  }
  for (let k = 0; k < 3; k++) {
    parts.push(withColor(new THREE.SphereGeometry(0.2, 6, 5), 0x6b4a2a)
      .translate(top.x + Math.cos(k * 2.1) * 0.35, top.y - 0.35, top.z + Math.sin(k * 2.1) * 0.35));
  }
  return mergeParts(parts);
}

function makeRockGeometry() {
  const g = new THREE.DodecahedronGeometry(1, 1);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = 1 + 0.22 * valueNoise2(x * 2.3 + y * 1.7 + 10, z * 2.1 - y * 1.3 + 10);
    pos.setXYZ(i, x * n, y * n * 0.75, z * n);
  }
  g.computeVertexNormals();
  return withColor(g, 0xffffff);
}

function makeSpectatorGeometry() {
  return mergeParts([
    withColor(new THREE.SphereGeometry(0.36, 8, 6), 0xffffff).scale(1, 1.25, 1).translate(0, 0.45, 0),
    withColor(new THREE.SphereGeometry(0.25, 8, 6), 0xffffff).translate(0, 1.05, 0),
    withColor(new THREE.SphereGeometry(0.12, 5, 4), 0xffffff).translate(-0.4, 0.6, 0),
    withColor(new THREE.SphereGeometry(0.12, 5, 4), 0xffffff).translate(0.4, 0.6, 0),
  ]);
}

/** Splits a geometry's triangles into two by the parity of their longitude gore. */
function splitByGore(geometry, gores) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = src.getAttribute('position'), nor = src.getAttribute('normal'), uv = src.getAttribute('uv');
  const groups = [[], []];
  for (let t = 0; t < pos.count / 3; t++) {
    let cx = 0, cz = 0;
    for (let k = 0; k < 3; k++) { cx += pos.getX(t * 3 + k); cz += pos.getZ(t * 3 + k); }
    let ang = Math.atan2(cz, cx);
    if (ang < 0) ang += Math.PI * 2;
    groups[Math.floor((ang / (Math.PI * 2)) * gores) % 2].push(t);
  }
  return groups.map((tris) => {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(tris.length * 9), n = new Float32Array(tris.length * 9), u = new Float32Array(tris.length * 6);
    tris.forEach((t, j) => {
      for (let k = 0; k < 3; k++) {
        const vi = t * 3 + k;
        p[j * 9 + k * 3] = pos.getX(vi); p[j * 9 + k * 3 + 1] = pos.getY(vi); p[j * 9 + k * 3 + 2] = pos.getZ(vi);
        n[j * 9 + k * 3] = nor.getX(vi); n[j * 9 + k * 3 + 1] = nor.getY(vi); n[j * 9 + k * 3 + 2] = nor.getZ(vi);
        u[j * 6 + k * 2] = uv.getX(vi); u[j * 6 + k * 2 + 1] = uv.getY(vi);
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
    return g;
  });
}

/** Hot-air balloon: `tinted` gores take the per-instance colour, `plain` parts stay as coloured. */
function makeBalloonGeometries() {
  const [even, odd] = splitByGore(new THREE.SphereGeometry(1, 16, 12), 8);
  even.scale(1, 1.25, 1);
  odd.scale(1, 1.25, 1);
  const tinted = mergeParts([
    withColor(even, 0xffffff),
    withColor(new THREE.CylinderGeometry(0.4, 0.28, 0.6, 16, 1, true), 0xffffff).translate(0, -1.45, 0),
  ]);
  const plainParts = [
    withColor(odd, 0xf7f7f7),
    withColor(new THREE.BoxGeometry(0.46, 0.46, 0.46), 0x7a4a22).translate(0, -2.35, 0),
  ];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    plainParts.push(withColor(new THREE.CylinderGeometry(0.02, 0.02, 0.42, 4), 0x333333)
      .translate(Math.cos(a) * 0.2, -1.94, Math.sin(a) * 0.2));
  }
  return { tinted, plain: mergeParts(plainParts) };
}

/** Stepped grandstand in a local frame: X along the stand, +Z away from the track. */
function makeGrandstand(length, tiers, rand) {
  const parts = [];
  const seatColors = [0x3f7fd9, 0xe0453c, 0xf2c231, 0x43a047, 0x8e24aa];
  const stepH = 0.62, stepD = 1.7;
  parts.push(withColor(new THREE.BoxGeometry(length + 1, 1.2, tiers * stepD + 2.4), 0xbdbdbd).translate(0, -0.45, tiers * stepD / 2 + 0.6));
  for (let k = 0; k < tiers; k++) {
    const h = (k + 1) * stepH;
    parts.push(withColor(new THREE.BoxGeometry(length, h, stepD), seatColors[k % seatColors.length]).translate(0, h / 2, 0.85 + k * stepD));
  }
  parts.push(withColor(new THREE.BoxGeometry(length, 1.1, 0.25), 0xf5f5f5).translate(0, 0.55, -0.12));
  const backH = tiers * stepH + 1.6;
  parts.push(withColor(new THREE.BoxGeometry(length, backH, 0.35), 0xe0e0e0).translate(0, backH / 2, tiers * stepD + 0.15));
  for (const s of [-1, 1]) {
    parts.push(withColor(new THREE.BoxGeometry(0.35, tiers * stepH + 0.4, tiers * stepD + 0.4), 0xd0d0d0)
      .translate(s * (length / 2 + 0.1), (tiers * stepH + 0.4) / 2, tiers * stepD / 2));
  }
  const roofY = tiers * stepH + 4.4, roofD = tiers * stepD + 3.0;
  const roof = withColor(new THREE.BoxGeometry(length + 2.4, 0.35, roofD), 0xd7263d);
  placed(roof, 0, roofY, tiers * stepD / 2 + 0.2, 0, 1, 1, 1, 0.12, 0);
  parts.push(roof);
  const postCount = Math.max(3, Math.round(length / 9));
  for (let i = 0; i < postCount; i++) {
    const x = -length / 2 + 1 + (i / (postCount - 1)) * (length - 2);
    parts.push(withColor(new THREE.CylinderGeometry(0.16, 0.16, roofY, 6), 0xf0f0f0).translate(x, roofY / 2, tiers * stepD + 0.9));
  }
  for (const s of [-1, 1]) {
    parts.push(withColor(new THREE.CylinderGeometry(0.16, 0.16, roofY + 1.0, 6), 0xf0f0f0).translate(s * (length / 2 - 0.4), (roofY + 1) / 2, 0.2));
  }
  const seats = [];
  for (let k = 0; k < tiers; k++) {
    for (let x = -length / 2 + 0.9; x < length / 2 - 0.8; x += 1.05) {
      if (rand() < 0.14) continue;
      seats.push({ x: x + (rand() - 0.5) * 0.3, y: (k + 1) * stepH, z: 0.85 + k * stepD + 0.35 + (rand() - 0.5) * 0.3 });
    }
  }
  return { geometry: mergeParts(parts), seats };
}

/** Gantry / arch: two banded pillars and a lattice truss. Local X across the road, Z along it. */
function makeGantryParts(span, height, accent = 0xd32f2f) {
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(withColor(new THREE.BoxGeometry(1.3, height, 1.3), 0xf2f2f2).translate((s * span) / 2, height / 2, 0));
    for (let k = 0; k < 3; k++) parts.push(withColor(new THREE.BoxGeometry(1.42, 0.5, 1.42), accent).translate((s * span) / 2, 1.6 + k * 2.4, 0));
    parts.push(withColor(new THREE.BoxGeometry(2.2, 0.4, 2.2), 0x555555).translate((s * span) / 2, 0.2, 0));
  }
  const yTop = height, yBot = height - 1.4;
  parts.push(withColor(new THREE.BoxGeometry(span + 1.3, 0.32, 0.32), 0xf2f2f2).translate(0, yTop - 0.16, 0));
  parts.push(withColor(new THREE.BoxGeometry(span + 1.3, 0.32, 0.32), 0xf2f2f2).translate(0, yBot, 0));
  const segs = Math.round(span / 2.4);
  const dx = span / segs;
  const inner = yTop - yBot - 0.3;
  for (let i = 0; i < segs; i++) {
    const x0 = -span / 2 + i * dx;
    const diag = withColor(new THREE.BoxGeometry(Math.hypot(dx, inner), 0.16, 0.16), accent);
    placed(diag, x0 + dx / 2, (yTop + yBot) / 2 - 0.15, 0, 0, 1, 1, 1, 0, Math.atan2(inner, dx) * (i % 2 ? -1 : 1));
    parts.push(diag);
    parts.push(withColor(new THREE.BoxGeometry(0.16, inner, 0.16), 0xf2f2f2).translate(x0, (yTop + yBot) / 2 - 0.15, 0));
  }
  return parts;
}

/** Distant mountain ring with snow caps plus a nearer ring of green foothills. */
function makeMountainRing(rand, cx, cz, baseY) {
  const parts = [];
  const snow = new THREE.Color(0xf2f6ff), rockHi = new THREE.Color(0x707598), rockLo = new THREE.Color(0x587a66);
  const tmp = new THREE.Color();
  const peaks = 26;
  for (let i = 0; i < peaks; i++) {
    const ang = (i / peaks) * Math.PI * 2 + (rand() - 0.5) * 0.15;
    const dist = 640 + rand() * 240;
    const h = 150 + rand() * 170, r = 130 + rand() * 150;
    const g = new THREE.ConeGeometry(r, h, 7, 4, false);
    const pos = g.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const f = (y + h / 2) / h;
      const jit = f < 0.98 ? 1 + 0.28 * valueNoise2(x * 0.02 + i * 3.7, z * 0.02 - i * 1.3) : 1;
      pos.setXYZ(v, x * jit, y, z * jit);
      const snowLine = 0.58 + 0.1 * valueNoise2(x * 0.03 + i, z * 0.03);
      if (f > snowLine) tmp.copy(snow);
      else tmp.copy(rockLo).lerp(rockHi, clamp(f / snowLine, 0, 1));
      col[v * 3] = tmp.r; col[v * 3 + 1] = tmp.g; col[v * 3 + 2] = tmp.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.translate(cx + Math.cos(ang) * dist, baseY + h / 2 - 8, cz + Math.sin(ang) * dist);
    parts.push(g);
  }
  for (let i = 0; i < 18; i++) {
    const ang = (i / 18) * Math.PI * 2 + rand() * 0.3;
    const dist = 420 + rand() * 90;
    const h = 28 + rand() * 40, r = 60 + rand() * 70;
    const g = new THREE.ConeGeometry(r, h, 6, 1, false);
    withColor(g, new THREE.Color().setHSL(0.28 + rand() * 0.04, 0.5, 0.34 + rand() * 0.08));
    g.translate(cx + Math.cos(ang) * dist, baseY + h / 2 - 4, cz + Math.sin(ang) * dist);
    parts.push(g);
  }
  const merged = mergeParts(parts);
  merged.computeVertexNormals();   // non-indexed → faceted low-poly look
  return merged;
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

export class Track {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.roadWidth = ROAD_WIDTH;
    this.wallDistance = ROAD_WIDTH / 2 + WALL_MARGIN;
    this.startLineT = 0;
    this.group = new THREE.Group();
    this.group.name = 'track';

    // --- Centre-line + lookup ---
    this.curve = buildTrackCurve();
    this.length = this.curve.getLength();
    this.lut = buildRoadLookup(this.curve, 2048);
    this._q = {};
    this._animated = [];

    // --- Layout data used by gameplay ---
    this.checkpoints = this._makeCheckpoints(24);
    this.startPositions = this._makeStartPositions();
    this.itemBoxPositions = this._makeItemBoxPositions();
    this.minimapPoints = this._makeMinimapPoints(200);
    this.boostPads = [];
    this._pads = [];
    this._definePads();

    // --- Environment layout constants ---
    const bb = this._bounds();
    this.lake = { x: -68, z: 34, r: 20, y: -0.8 };
    this.terrainBounds = { cx: (bb.minX + bb.maxX) / 2, cz: (bb.minZ + bb.maxZ) / 2, hw: (bb.maxX - bb.minX) / 2 + 190, hh: (bb.maxZ - bb.minZ) / 2 + 190 };
    this.planeY = -0.9;
    this._planScenery();
    this.field = createTerrainField(this.lut, {
      lake: this.lake,
      flatZones: this._flatZones,
      bounds: this.terrainBounds,
      planeY: this.planeY,
    });

    // --- Build meshes (textures need a DOM) ---
    this.textures = {};
    if (typeof document !== 'undefined') {
      this._makeTextures();
      this._buildRoad();
      this._buildTerrain();
      this._buildBoostPads();
      this._buildBarriers();
      this._buildScenery();
    }
    scene.add(this.group);
  }

  // ----- layout helpers -------------------------------------------------------

  _bounds() {
    const P = this.lut.positions;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.lut.n; i++) {
      minX = Math.min(minX, P[i * 3]); maxX = Math.max(maxX, P[i * 3]);
      minZ = Math.min(minZ, P[i * 3 + 2]); maxZ = Math.max(maxZ, P[i * 3 + 2]);
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Centre point / tangent / right at arc-length t as Vector3s. */
  sampleAt(t) {
    const s = lookupAt(this.lut, t, {});
    return {
      t: t - Math.floor(t),
      position: new THREE.Vector3(s.x, s.y, s.z),
      tangent: new THREE.Vector3(s.tx, s.ty, s.tz),
      right: new THREE.Vector3(s.rx, 0, s.rz),
    };
  }

  _makeCheckpoints(count) {
    const cps = [];
    for (let i = 0; i < count; i++) {
      const s = this.sampleAt(i / count);
      cps.push({ t: i / count, position: s.position, tangent: s.tangent });
    }
    return cps;
  }

  _makeStartPositions() {
    const slots = [];
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2), col = i % 2;
      const back = 4.5 + row * 4.2 + col * 2.1;       // metres behind the line
      const lateral = col === 0 ? -3.0 : 3.0;
      const t = ((1 - back / this.length) % 1 + 1) % 1;
      const s = this.sampleAt(t);
      const position = s.position.clone().addScaledVector(s.right, lateral);
      const yaw = Math.atan2(s.tangent.x, s.tangent.z);
      slots.push({ position, yaw, t });
    }
    return slots;
  }

  _makeItemBoxPositions() {
    const out = [];
    for (const t of [0.12, 0.38, 0.62, 0.85]) {
      const s = this.sampleAt(t);
      for (const lat of [-6, -2, 2, 6]) {
        const p = s.position.clone().addScaledVector(s.right, lat);
        p.y += 1.2;
        out.push(p);
      }
    }
    return out;
  }

  _makeMinimapPoints(count) {
    const pts = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      this.curve.getPointAt(i / count, v);
      pts.push({ x: v.x, z: v.z });
    }
    return pts;
  }

  _definePads() {
    // {t, lateral} — straights and corner exits.
    const defs = [
      { t: 0.055, lateral: 0 },    // start straight, after the line
      { t: 0.475, lateral: 0 },    // hairpin exit / hill climb
      { t: 0.665, lateral: -3 },   // descent
      { t: 0.925, lateral: 3 },    // U-turn exit onto the straight
    ];
    for (const d of defs) {
      const s = this.sampleAt(d.t);
      const position = s.position.clone().addScaledVector(s.right, d.lateral);
      const fwd = new THREE.Vector3(s.tangent.x, 0, s.tangent.z).normalize();
      const yaw = Math.atan2(fwd.x, fwd.z);
      this.boostPads.push({ position, yaw, t: d.t });
      this._pads.push({ x: position.x, z: position.z, fx: fwd.x, fz: fwd.z, rx: s.right.x, rz: s.right.z, halfLen: 4, halfWid: 3 });
    }
  }

  // ----- gameplay query --------------------------------------------------------

  getRoadInfo(position, hintT) {
    const q = queryRoad(this.lut, position.x, position.z, hintT, this._q);
    const lateral = q.lateral;
    let surface = 'road';
    if (Math.abs(lateral) > this.roadWidth / 2) {
      surface = 'offroad';
    } else {
      for (let i = 0; i < this._pads.length; i++) {
        const p = this._pads[i];
        const dx = position.x - p.x, dz = position.z - p.z;
        const along = dx * p.fx + dz * p.fz;
        const across = dx * p.rx + dz * p.rz;
        if (Math.abs(along) <= p.halfLen && Math.abs(across) <= p.halfWid) { surface = 'boost'; break; }
      }
    }
    return {
      t: q.t,
      center: new THREE.Vector3(q.x, q.y, q.z),
      tangent: new THREE.Vector3(q.tx, q.ty, q.tz),
      right: new THREE.Vector3(q.rx, 0, q.rz),
      lateral,
      height: q.y,
      surface,
      onRoad: surface !== 'offroad',
      wallDistance: this.wallDistance,
    };
  }

  // ----- building --------------------------------------------------------------

  _makeTextures() {
    const r = this.renderer;
    this.textures.asphalt = makeAsphaltTexture(r);
    this.textures.grass = makeGrassTexture(r);
    this.textures.dirt = makeDirtTexture(r);
    this.textures.curb = makeCurbTexture(r);
    this.textures.checker = makeCheckerTexture(r);
    this.textures.boost = makeBoostTexture(r);
    this.textures.water = makeWaterTexture(r);
  }

  _buildRoad() {
    const lut = this.lut;
    const half = this.roadWidth / 2;
    const tileRepeats = Math.max(1, Math.round(this.length / 16));

    const road = new THREE.Mesh(
      buildRibbon(lut, -half, half, 0, tileRepeats),
      new THREE.MeshStandardMaterial({ map: this.textures.asphalt, roughness: 0.93, metalness: 0.0 }),
    );
    road.receiveShadow = true;
    road.name = 'road';
    this.group.add(road);

    // Curbs (raised 6 cm, 1.3 m wide). Both sides merged: red/white blocks 2 m long.
    const curbRepeats = Math.max(1, Math.round(this.length / 4));
    const curbL = buildRibbon(lut, -half - 1.3, -half, 0.06, curbRepeats);
    const curbR = buildRibbon(lut, half, half + 1.3, 0.06, curbRepeats);
    const curbs = new THREE.Mesh(
      mergeGeometries([curbL, curbR], false),
      new THREE.MeshStandardMaterial({ map: this.textures.curb, roughness: 0.75 }),
    );
    curbs.receiveShadow = true;
    curbs.castShadow = false;
    curbs.name = 'curbs';
    this.group.add(curbs);

    // Worn verge / dirt shoulder from the curb out to just past the barrier.
    const vergeRepeats = Math.max(1, Math.round(this.length / 6));
    const vergeL = buildRibbon(lut, -this.wallDistance - 1.2, -half - 1.25, 0.0, vergeRepeats);
    const vergeR = buildRibbon(lut, half + 1.25, this.wallDistance + 1.2, 0.0, vergeRepeats);
    const verge = new THREE.Mesh(
      mergeGeometries([vergeL, vergeR], false),
      new THREE.MeshStandardMaterial({ map: this.textures.dirt, roughness: 1.0 }),
    );
    verge.receiveShadow = true;
    verge.name = 'verge';
    this.group.add(verge);

    // Finish line strip painted across the road at t = 0.
    const s0 = this.sampleAt(0);
    const stripGeo = new THREE.PlaneGeometry(this.roadWidth, 2.4, 1, 1);
    stripGeo.rotateX(-Math.PI / 2);
    stripGeo.rotateY(Math.atan2(s0.tangent.x, s0.tangent.z) + Math.PI);
    stripGeo.translate(s0.position.x, s0.position.y + 0.02, s0.position.z);
    const stripTex = this.textures.checker.clone();
    stripTex.repeat.set(8, 1.2);
    stripTex.needsUpdate = true;
    const strip = new THREE.Mesh(stripGeo, new THREE.MeshStandardMaterial({
      map: stripTex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    strip.receiveShadow = true;
    strip.name = 'finishLine';
    this.group.add(strip);
  }

  _buildTerrain() {
    const tb = this.terrainBounds;
    const cell = 4;
    const nx = Math.ceil((tb.hw * 2) / cell), nz = Math.ceil((tb.hh * 2) / cell);
    const geo = new THREE.PlaneGeometry(nx * cell, nz * cell, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + tb.cx, z = pos.getZ(i) + tb.cz;
      const h = this.field.height(x, z);
      pos.setXYZ(i, x, h, z);
      uv.setXY(i, x / 8, z / 8);
      // Subtle colour variation: dry/yellow patches and darker damp patches.
      const nv = fbm2(x * 0.03 + 11, z * 0.03 - 4, 3);
      const dry = smoothstep(0.15, 0.6, nv);
      const damp = smoothstep(-0.2, -0.7, nv);
      c.setRGB(lerp(1, 1.15, dry) * lerp(1, 0.78, damp), lerp(1, 1.05, dry) * lerp(1, 0.82, damp), lerp(1, 0.7, dry) * lerp(1, 0.8, damp));
      // Sandy shore around the lake.
      const sand = smoothstep(this.lake.r + 16, this.lake.r + 2, Math.hypot(x - this.lake.x, z - this.lake.z));
      c.r = lerp(c.r, 2.2, sand); c.g = lerp(c.g, 1.35, sand); c.b = lerp(c.b, 0.7, sand);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: this.textures.grass, vertexColors: true, roughness: 1.0, metalness: 0 }),
    );
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    this.group.add(terrain);

    // Huge flat ground plane for the far distance (same world-space tiling → seamless).
    const size = 6000;
    const pg = new THREE.PlaneGeometry(size, size, 1, 1);
    pg.rotateX(-Math.PI / 2);
    const puv = pg.getAttribute('uv');
    const ppos = pg.getAttribute('position');
    for (let i = 0; i < ppos.count; i++) puv.setXY(i, (ppos.getX(i) + tb.cx) / 8, (ppos.getZ(i) + tb.cz) / 8);
    const plane = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ map: this.textures.grass, roughness: 1.0, color: 0xdfe8c8 }));
    plane.position.set(tb.cx, this.planeY, tb.cz);
    plane.receiveShadow = true;
    plane.name = 'ground';
    this.group.add(plane);
  }

  _buildBoostPads() {
    const geos = [];
    for (const pad of this.boostPads) {
      const g = new THREE.PlaneGeometry(6, 8, 1, 1);
      g.rotateX(-Math.PI / 2);            // face up; texture +v now points to -Z ...
      g.rotateY(pad.yaw + Math.PI);       // ... so add PI to make chevrons point forward
      g.translate(pad.position.x, pad.position.y + 0.03, pad.position.z);
      geos.push(g);
    }
    const mat = new THREE.MeshStandardMaterial({
      map: this.textures.boost,
      emissive: 0xff8a00,
      emissiveMap: this.textures.boost,
      emissiveIntensity: 0.8,
      roughness: 0.5,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
    mesh.receiveShadow = true;
    mesh.name = 'boostPads';
    this.group.add(mesh);
    this._padMaterial = mat;
  }

  _buildBarriers() {
    const lut = this.lut;
    const spacing = 4.0;
    const perSide = Math.floor(this.length / spacing);

    // Rail segment: two horizontal rails on a centre post (4.4 m long to overlap on bends).
    const railGeo = mergeParts([
      withColor(new THREE.BoxGeometry(0.14, 0.34, 4.45), 0xffffff).translate(0, 0.78, 0),
      withColor(new THREE.BoxGeometry(0.14, 0.26, 4.45), 0xffffff).translate(0, 0.36, 0),
      withColor(new THREE.BoxGeometry(0.22, 1.05, 0.22), 0x9a9a9a).translate(0, 0.52, 0),
    ]);
    const railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
    const rails = new THREE.InstancedMesh(railGeo, railMat, perSide * 2);
    rails.castShadow = true;
    rails.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1);
    const red = new THREE.Color(0xe53935), white = new THREE.Color(0xf5f5f5);
    let idx = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < perSide; k++) {
        const s = lookupAt(lut, (k * spacing) / this.length, {});
        const yaw = Math.atan2(s.tx, s.tz);
        pv.set(s.x + s.rx * side * (this.wallDistance + 0.3), s.y - 0.05, s.z + s.rz * side * (this.wallDistance + 0.3));
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        m.compose(pv, q, sv);
        rails.setMatrixAt(idx, m);
        rails.setColorAt(idx, k % 2 ? white : red);
        idx++;
      }
    }
    rails.instanceMatrix.needsUpdate = true;
    if (rails.instanceColor) rails.instanceColor.needsUpdate = true;
    rails.name = 'rails';
    this.group.add(rails);

    // Tyre stacks behind the rails on the outside of the tight corners.
    const tyreProfile = [];
    for (let i = 0; i <= 12; i++) {
      const y = (i / 12) * 1.15;
      const bulge = 0.05 * Math.sin((i / 12) * Math.PI * 3);
      tyreProfile.push(new THREE.Vector2(0.58 + bulge, y));
    }
    const tyreGeo = new THREE.LatheGeometry(tyreProfile, 10);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.95 });
    const tyreSpots = [];
    const corners = [
      { t0: 0.14, t1: 0.235, side: -1 },   // sweeper outside (right-hander → left side)
      { t0: 0.375, t1: 0.465, side: -1 },  // hairpin outside
      { t0: 0.70, t1: 0.75, side: -1 },    // chicane first bend (right)
      { t0: 0.735, t1: 0.785, side: 1 },   // chicane second bend (left)
      { t0: 0.79, t1: 0.92, side: -1 },    // U-turn outside
    ];
    for (const cr of corners) {
      const len = (cr.t1 - cr.t0) * this.length;
      const count = Math.floor(len / 1.35);
      for (let k = 0; k < count; k++) {
        const t = cr.t0 + (k * 1.35) / this.length;
        const s = lookupAt(lut, t, {});
        tyreSpots.push({ x: s.x + s.rx * cr.side * (this.wallDistance + 1.15), y: s.y - 0.08, z: s.z + s.rz * cr.side * (this.wallDistance + 1.15), yaw: Math.atan2(s.tx, s.tz) });
      }
    }
    const tyres = new THREE.InstancedMesh(tyreGeo, tyreMat, tyreSpots.length);
    tyres.castShadow = true;
    tyres.receiveShadow = true;
    const rand = mulberry32(5);
    tyreSpots.forEach((sp, i) => {
      pv.set(sp.x, sp.y, sp.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
      m.compose(pv, q, sv);
      tyres.setMatrixAt(i, m);
      const shade = 0.75 + rand() * 0.35;
      tyres.setColorAt(i, new THREE.Color(shade, shade, shade));
    });
    tyres.instanceMatrix.needsUpdate = true;
    if (tyres.instanceColor) tyres.instanceColor.needsUpdate = true;
    tyres.name = 'tyres';
    this.group.add(tyres);
  }

  // ----- scenery -----------------------------------------------------------------

  /** Pure placement planning (no DOM): grandstands, keep-out zones, flat terrain zones. */
  _planScenery() {
    this._flatZones = [];
    this._keepOut = [];
    // Grandstands flank the start/finish straight (axis-aligned at x = 0, heading +Z).
    // ry = +PI/2 → local +Z (away from the track) maps to world +X; -PI/2 → world -X.
    this._stands = [
      { x: 21, z: -80, ry: Math.PI / 2, length: 56, tiers: 6 },
      { x: -21, z: 4, ry: -Math.PI / 2, length: 60, tiers: 6 },
    ];
    for (const s of this._stands) {
      const away = s.ry > 0 ? 1 : -1;
      const depth = s.tiers * 1.7 + 3;
      const cx = s.x + away * depth * 0.5;
      const r = Math.max(s.length, depth) * 0.5;
      this._flatZones.push({ x: cx, z: s.z, r: r + 3, y: -0.05, blend: 8 });
      this._keepOut.push({ x: cx, z: s.z, r: r + 8 });
    }
    this._keepOut.push({ x: 0, z: -60, r: 22 });                                  // finish gantry
    this._keepOut.push({ x: this.lake.x, z: this.lake.z, r: this.lake.r + 6 });   // lake
  }

  _buildScenery() {
    this._structureParts = [];
    this._buildLake();
    this._buildGantries();
    this._buildBillboards();
    this._buildFlags();
    this._buildGrandstands();
    this._finishStructures();
    this._buildTrees();
    this._buildRocks();
    this._buildMountains();
    this._buildBalloons();
  }

  _buildLake() {
    const lk = this.lake;
    const geo = new THREE.CircleGeometry(lk.r + 9, 48);
    geo.rotateX(-Math.PI / 2);
    const tex = this.textures.water;
    tex.repeat.set(5, 5);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4fb0f0, map: tex, roughness: 0.12, metalness: 0.3,
      transparent: true, opacity: 0.86, emissive: 0x0b3d6b, emissiveIntensity: 0.25,
    });
    const water = new THREE.Mesh(geo, mat);
    water.position.set(lk.x, lk.y, lk.z);
    water.receiveShadow = true;
    water.name = 'lake';
    this.group.add(water);
    this._animated.push((dt) => { tex.offset.x += dt * 0.015; tex.offset.y += dt * 0.01; });
  }

  /** Start/finish gantry (FINISH banner) and a sponsor arch on the crest. */
  _buildGantries() {
    const defs = [
      { t: 0, text: 'FINISH', bg: '#d32f2f', accent: 0xd32f2f, span: 32, height: 10, fontSize: 130 },
      { t: 0.548, text: 'TURBO KART GP', bg: '#1e63c9', accent: 0x1e63c9, span: 32, height: 9.5, fontSize: 96 },
    ];
    for (const d of defs) {
      const s = this.sampleAt(d.t);
      const yaw = Math.atan2(s.tangent.x, s.tangent.z);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(s.position.x, s.position.y - 0.05, s.position.z),
        new THREE.Quaternion().setFromAxisAngle(_Y, yaw),
        new THREE.Vector3(1, 1, 1),
      );
      for (const p of makeGantryParts(d.span, d.height, d.accent)) this._structureParts.push(p.applyMatrix4(m));
      // Two-sided banner: one plane facing the approaching karts (-Z local), one facing back.
      const w = d.span - 8, h = 3.2;
      const front = new THREE.PlaneGeometry(w, h);
      front.rotateY(Math.PI);
      const back = new THREE.PlaneGeometry(w, h);
      const bg = mergeGeometries([front, back], false);
      bg.translate(0, d.height - 1.4 - h / 2 - 0.2, 0);
      bg.applyMatrix4(m);
      const tex = makeBannerTexture(d.text, this.renderer, { bg: d.bg, fontSize: d.fontSize });
      const banner = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.8, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.15,
      }));
      banner.castShadow = true;
      banner.name = 'banner_' + d.text;
      this.group.add(banner);
      this._keepOut.push({ x: s.position.x, z: s.position.z, r: 22 });
    }
  }

  /** Billboards on the outside of the big corners, facing the approaching karts. */
  _buildBillboards() {
    const defs = [
      { t: 0.19, side: -1, lateral: 25, text: 'TURBO', a: '#ff6f00', b: '#ffca28', fg: '#ffffff' },
      { t: 0.405, side: -1, lateral: 27, text: 'KART', a: '#1e88e5', b: '#8e24aa', fg: '#ffeb3b' },
      { t: 0.85, side: -1, lateral: 25, text: 'GP', a: '#43a047', b: '#00acc1', fg: '#ffffff' },
    ];
    for (const d of defs) {
      const s = this.sampleAt(d.t);
      const pos = s.position.clone().addScaledVector(s.right, d.side * d.lateral);
      pos.y = this.field.height(pos.x, pos.z);
      const yaw = Math.atan2(-s.tangent.x, -s.tangent.z);   // plane normal = -tangent
      const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(_Y, yaw), new THREE.Vector3(1, 1, 1));
      const parts = [
        withColor(new THREE.CylinderGeometry(0.22, 0.26, 5, 7), 0x8d6e63).translate(-3.6, 2.5, -0.3),
        withColor(new THREE.CylinderGeometry(0.22, 0.26, 5, 7), 0x8d6e63).translate(3.6, 2.5, -0.3),
        withColor(new THREE.BoxGeometry(10.6, 4.8, 0.3), 0x263238).translate(0, 7.0, -0.25),
      ];
      for (const p of parts) this._structureParts.push(p.applyMatrix4(m));
      const poster = new THREE.PlaneGeometry(10, 4.4);
      poster.translate(0, 7.0, 0);
      poster.applyMatrix4(m);
      const tex = makeBillboardTexture(d.text, this.renderer, d.a, d.b, d.fg);
      const mesh = new THREE.Mesh(poster, new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.7, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.12,
      }));
      mesh.castShadow = true;
      mesh.name = 'billboard_' + d.text;
      this.group.add(mesh);
      this._keepOut.push({ x: pos.x, z: pos.z, r: 9 });
    }
  }

  /** Flag poles around the circuit; flags share one geometry and wave via vertex animation. */
  _buildFlags() {
    const flagColors = [0xe53935, 0xfdd835, 0x1e88e5, 0x43a047, 0x8e24aa, 0xfb8c00, 0x00acc1, 0xf06292];
    const flagGeos = [];
    const restPos = [], uArr = [], phaseArr = [];
    for (let k = 0; k < 24; k++) {
      const t = (0.03 + k / 24) % 1;
      if (Math.abs(t - 0.548) < 0.02) continue;   // sponsor arch lives here
      const side = k % 2 ? 1 : -1;
      const s = this.sampleAt(t);
      const px = s.position.x + s.right.x * side * 16.8;
      const pz = s.position.z + s.right.z * side * 16.8;
      const py = this.field.height(px, pz);
      this._structureParts.push(withColor(new THREE.CylinderGeometry(0.06, 0.09, 7.5, 6), 0xf5f5f5).translate(px, py + 3.75, pz));
      this._structureParts.push(withColor(new THREE.SphereGeometry(0.17, 6, 5), 0xffc107).translate(px, py + 7.6, pz));
      // Flag in the XY plane, hinged at the pole, extending +X (wind direction).
      const fg = new THREE.PlaneGeometry(2.4, 1.5, 8, 4);
      fg.translate(1.28, 0, 0);
      fg.translate(px, py + 6.6, pz);
      withColor(fg, flagColors[k % flagColors.length]);
      const pos = fg.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        restPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        uArr.push((pos.getX(i) - px) / 2.48);
        phaseArr.push(k * 1.7);
      }
      flagGeos.push(fg);
    }
    const merged = mergeGeometries(flagGeos, false);   // keeps indices → vertex order preserved
    const flags = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 }));
    flags.castShadow = true;
    flags.frustumCulled = false;
    flags.name = 'flags';
    this.group.add(flags);
    const rest = new Float32Array(restPos), U = new Float32Array(uArr), PH = new Float32Array(phaseArr);
    const posAttr = merged.getAttribute('position');
    this._animated.push((dt, elapsed) => {
      const arr = posAttr.array;
      for (let i = 0; i < U.length; i++) {
        const u = U[i], ph = PH[i];
        const w = u * (0.34 * Math.sin(u * 5.5 - elapsed * 6.5 + ph) + 0.1 * Math.sin(u * 11 - elapsed * 9.7 + ph * 1.3));
        arr[i * 3] = rest[i * 3];
        arr[i * 3 + 1] = rest[i * 3 + 1] - 0.15 * u * u;
        arr[i * 3 + 2] = rest[i * 3 + 2] + w;
      }
      posAttr.needsUpdate = true;
    });
  }

  /** Two grandstands beside the straight, packed with instanced bobbing spectators. */
  _buildGrandstands() {
    const rand = mulberry32(88);
    const geos = [];
    const spots = [];
    const v = new THREE.Vector3();
    for (const st of this._stands) {
      const { geometry, seats } = makeGrandstand(st.length, st.tiers, rand);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(st.x, -0.05, st.z),
        new THREE.Quaternion().setFromAxisAngle(_Y, st.ry),
        new THREE.Vector3(1, 1, 1),
      );
      geometry.applyMatrix4(m);
      geos.push(geometry);
      for (const s of seats) {
        v.set(s.x, s.y, s.z).applyMatrix4(m);
        spots.push({
          x: v.x, y: v.y, z: v.z,
          phase: rand() * Math.PI * 2, rate: 3.5 + rand() * 3,
          amp: rand() < 0.5 ? 0.35 : 0.12, scale: 0.85 + rand() * 0.3,
        });
      }
    }
    const stands = new THREE.Mesh(mergeGeometries(geos, false), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
    stands.castShadow = true;
    stands.receiveShadow = true;
    stands.name = 'grandstands';
    this.group.add(stands);

    const crowd = new THREE.InstancedMesh(
      makeSpectatorGeometry(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
      spots.length,
    );
    crowd.castShadow = true;
    crowd.frustumCulled = false;
    crowd.name = 'spectators';
    const palette = [0xe53935, 0xfdd835, 0x1e88e5, 0x43a047, 0x8e24aa, 0xfb8c00, 0x00acc1, 0xf06292, 0xffffff, 0x795548];
    const color = new THREE.Color();
    spots.forEach((s, i) => {
      color.set(palette[Math.floor(rand() * palette.length)]);
      crowd.setColorAt(i, color);
    });
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const tick = (elapsed) => {
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const bob = Math.max(0, Math.sin(elapsed * s.rate + s.phase)) * s.amp;
        p.set(s.x, s.y + bob, s.z);
        q.setFromAxisAngle(_Y, s.phase);
        sc.set(s.scale, s.scale, s.scale);
        m.compose(p, q, sc);
        crowd.setMatrixAt(i, m);
      }
      crowd.instanceMatrix.needsUpdate = true;
    };
    tick(0);
    this.group.add(crowd);
    this._animated.push((dt, elapsed) => tick(elapsed));
  }

  /** Merges every static vertex-coloured structure part (gantries, posts, poles) into one mesh. */
  _finishStructures() {
    if (!this._structureParts.length) return;
    const mesh = new THREE.Mesh(
      mergeParts(this._structureParts),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'structures';
    this.group.add(mesh);
    this._structureParts = null;
  }

  /** ~300 trees of three varieties (pine, deciduous, palm) as three InstancedMeshes. */
  _buildTrees() {
    const rand = mulberry32(2718);
    const geos = [makePineGeometry(), makeDeciduousGeometry(), makePalmGeometry()];
    const placements = [[], [], []];
    const tb = this.terrainBounds;
    const minRoad = this.wallDistance + 6.5;
    const ok = (x, z) => {
      if (this.field.roadDistance(x, z) < minRoad) return false;
      for (const k of this._keepOut) if (Math.hypot(x - k.x, z - k.z) < k.r) return false;
      const e = Math.max(Math.abs(x - tb.cx) / tb.hw, Math.abs(z - tb.cz) / tb.hh);
      return e < 0.82;
    };
    // Variety from low-frequency noise so each kind forms natural groves.
    const pick = (x, z) => {
      const nv = fbm2(x * 0.011 + 5, z * 0.011 - 2, 3);
      return nv < -0.12 ? 0 : nv > 0.16 ? 2 : 1;
    };
    const add = (x, z, kind) => {
      placements[kind].push({
        x, z, y: this.field.height(x, z) - 0.2,
        yaw: rand() * Math.PI * 2, s: 0.8 + rand() * 0.55, tint: 0.85 + rand() * 0.25,
      });
    };
    // Trackside trees (rejection sampled along the circuit).
    let tries = 0, made = 0;
    while (made < 190 && tries < 8000) {
      tries++;
      const s = lookupAt(this.lut, rand(), {});
      const side = rand() < 0.5 ? -1 : 1;
      const dist = minRoad + 1 + rand() * 28;
      const x = s.x + s.rx * side * dist, z = s.z + s.rz * side * dist;
      if (!ok(x, z)) continue;
      add(x, z, pick(x, z));
      made++;
    }
    // Scattered trees over the whole terrain.
    tries = 0; made = 0;
    while (made < 110 && tries < 8000) {
      tries++;
      const x = tb.cx + (rand() * 2 - 1) * tb.hw * 0.82, z = tb.cz + (rand() * 2 - 1) * tb.hh * 0.82;
      if (!ok(x, z)) continue;
      add(x, z, pick(x, z));
      made++;
    }
    // Palms around the lake shore.
    for (let i = 0; i < 12; i++) {
      const a = rand() * Math.PI * 2, d = this.lake.r + 10 + rand() * 8;
      const x = this.lake.x + Math.cos(a) * d, z = this.lake.z + Math.sin(a) * d;
      if (this.field.roadDistance(x, z) < minRoad) continue;
      add(x, z, 2);
    }
    const mats = [
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
    ];
    const names = ['pines', 'trees', 'palms'];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    for (let k = 0; k < 3; k++) {
      const list = placements[k];
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(geos[k], mats[k], list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      list.forEach((tr, i) => {
        p.set(tr.x, tr.y, tr.z);
        q.setFromAxisAngle(_Y, tr.yaw);
        sc.set(tr.s, tr.s * (0.9 + rand() * 0.25), tr.s);
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);
        col.setRGB(tr.tint, tr.tint * (0.95 + rand() * 0.1), tr.tint * 0.95);
        mesh.setColorAt(i, col);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = names[k];
      this.group.add(mesh);
    }
    this.treeCount = placements[0].length + placements[1].length + placements[2].length;
  }

  /** Rock clusters and singles, partially buried. */
  _buildRocks() {
    const rand = mulberry32(99);
    const tb = this.terrainBounds;
    const spots = [];
    const tryAdd = (x, z, s) => {
      if (this.field.roadDistance(x, z) < this.wallDistance + 5) return;
      for (const k of this._keepOut) if (Math.hypot(x - k.x, z - k.z) < k.r) return;
      const e = Math.max(Math.abs(x - tb.cx) / tb.hw, Math.abs(z - tb.cz) / tb.hh);
      if (e > 0.8) return;
      spots.push({ x, z, y: this.field.height(x, z) - s * 0.35, s, yaw: rand() * Math.PI * 2, shade: 0.7 + rand() * 0.4, sz: 0.8 + rand() * 0.4 });
    };
    for (let c = 0; c < 14; c++) {
      const cx = tb.cx + (rand() * 2 - 1) * tb.hw * 0.75, cz = tb.cz + (rand() * 2 - 1) * tb.hh * 0.75;
      const n = 3 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) tryAdd(cx + (rand() - 0.5) * 9, cz + (rand() - 0.5) * 9, 0.6 + rand() * 1.8);
    }
    for (let i = 0; i < 24; i++) tryAdd(tb.cx + (rand() * 2 - 1) * tb.hw * 0.78, tb.cz + (rand() * 2 - 1) * tb.hh * 0.78, 0.5 + rand() * 1.4);
    if (!spots.length) return;
    const mesh = new THREE.InstancedMesh(
      makeRockGeometry(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
      spots.length,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    spots.forEach((r, i) => {
      p.set(r.x, r.y, r.z);
      q.setFromAxisAngle(_Y, r.yaw);
      sc.set(r.s, r.s * 0.8, r.s * r.sz);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      col.setRGB(0.55 * r.shade, 0.52 * r.shade, 0.48 * r.shade);
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = 'rocks';
    this.group.add(mesh);
  }

  _buildMountains() {
    const tb = this.terrainBounds;
    const mesh = new THREE.Mesh(
      makeMountainRing(mulberry32(314), tb.cx, tb.cz, this.planeY),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    mesh.name = 'mountains';
    this.group.add(mesh);
  }

  /** Floating hot-air balloons: tinted gores + plain parts as two InstancedMeshes sharing transforms. */
  _buildBalloons() {
    const rand = mulberry32(555);
    const { tinted, plain } = makeBalloonGeometries();
    const count = 14;
    const tintedMesh = new THREE.InstancedMesh(tinted, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), count);
    const plainMesh = new THREE.InstancedMesh(plain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), count);
    tintedMesh.frustumCulled = false;
    plainMesh.frustumCulled = false;
    tintedMesh.name = 'balloonsTinted';
    plainMesh.name = 'balloonsPlain';
    const palette = [0xe53935, 0x1e88e5, 0x43a047, 0xfdd835, 0x8e24aa, 0xfb8c00, 0x00acc1, 0xf06292];
    const tb = this.terrainBounds;
    const data = [];
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2, d = 40 + rand() * 300;
      data.push({
        x: tb.cx + Math.cos(a) * d, z: tb.cz + Math.sin(a) * d, y: 38 + rand() * 50,
        s: 4.5 + rand() * 2.5, phase: rand() * Math.PI * 2, yaw: rand() * Math.PI * 2, spin: (rand() - 0.5) * 0.1,
      });
      color.set(palette[i % palette.length]);
      tintedMesh.setColorAt(i, color);
    }
    if (tintedMesh.instanceColor) tintedMesh.instanceColor.needsUpdate = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const tick = (elapsed) => {
      for (let i = 0; i < count; i++) {
        const b = data[i];
        p.set(b.x + Math.sin(elapsed * 0.11 + b.phase) * 3, b.y + Math.sin(elapsed * 0.37 + b.phase) * 1.8, b.z);
        q.setFromAxisAngle(_Y, b.yaw + elapsed * b.spin);
        sc.set(b.s, b.s, b.s);
        m.compose(p, q, sc);
        tintedMesh.setMatrixAt(i, m);
        plainMesh.setMatrixAt(i, m);
      }
      tintedMesh.instanceMatrix.needsUpdate = true;
      plainMesh.instanceMatrix.needsUpdate = true;
    };
    tick(0);
    this.group.add(tintedMesh);
    this.group.add(plainMesh);
    this._animated.push((dt, elapsed) => tick(elapsed));
  }

  // ----- per-frame -----------------------------------------------------------------

  update(dt, elapsed) {
    if (this._padMaterial) this._padMaterial.emissiveIntensity = 0.75 + 0.55 * (0.5 + 0.5 * Math.sin(elapsed * 6));
    for (let i = 0; i < this._animated.length; i++) this._animated[i](dt, elapsed);
  }
}
