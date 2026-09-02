// tests/kart-sim.mjs — headless physics simulation for src/kart.js (no browser, no renderer).
// Run from the project root:  node tests/kart-sim.mjs
// Requires `three` resolvable from node_modules (npm i three@0.160.0 --no-save).

import * as THREE from 'three';
import { Kart, TUNING } from '../src/kart.js';

// ----------------------------------------------------------------------------
// Fake track: straight road along +Z, height 0.
// Contract: right = tangent × up = (-1, 0, 0) for tangent (0, 0, 1); lateral = position · right = -x.
// ----------------------------------------------------------------------------
function makeTrack({ halfWidth = 8, wallDistance = 14, boostZone = null } = {}) {
  return {
    calls: 0,
    getRoadInfo(position) {
      this.calls++;
      const lateral = -position.x;
      const abs = Math.abs(lateral);
      const onRoad = abs <= halfWidth;
      let surface = onRoad ? 'road' : 'offroad';
      if (boostZone && onRoad && position.z > boostZone[0] && position.z < boostZone[1]) surface = 'boost';
      return {
        t: (((position.z / 1000) % 1) + 1) % 1,
        center: new THREE.Vector3(0, 0, position.z),
        tangent: new THREE.Vector3(0, 0, 1),
        right: new THREE.Vector3(-1, 0, 0),
        lateral, height: 0, surface, onRoad, wallDistance,
      };
    },
  };
}

const scene = { add() {}, remove() {} };
const DT = 1 / 120;

function run(kart, track, seconds, dt, inputFn) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    if (inputFn) inputFn(kart, i * dt);
    kart.update(dt, track);
  }
}

function finite(kart) {
  const p = kart.position, v = kart.velocity;
  return [p.x, p.y, p.z, kart.yaw, kart.speed, kart.slipAngle, v.x, v.y, v.z, kart.group.rotation.x, kart.group.rotation.z]
    .every(Number.isFinite);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Seeded PRNG for the stability test
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ----------------------------------------------------------------------------
const kart = new Kart(scene, { color: 0xe53935, name: 'Test', isPlayer: true, index: 0 });
const track = makeTrack();

// (a) full throttle 4 s → ≥ 36 m/s
kart.reset(new THREE.Vector3(0, 0, 0), 0);
run(kart, track, 4, DT, (k) => { k.input.throttle = 1; });
check('(a) full throttle 4 s reaches ≥ 36 m/s', kart.speed >= 36 && kart.speed <= TUNING.BASE_MAX_SPEED + 1e-6,
  `speed=${kart.speed.toFixed(2)}`);
check('(a2) drives straight down +Z', Math.abs(kart.position.x) < 1e-6 && kart.position.z > 100,
  `x=${kart.position.x.toFixed(3)} z=${kart.position.z.toFixed(1)}`);

// (b) release → coasts down
const before = kart.speed;
run(kart, track, 2, DT, (k) => { k.input.throttle = 0; });
check('(b) coasting slows the kart', kart.speed < before - 5 && kart.speed > 0,
  `${before.toFixed(2)} → ${kart.speed.toFixed(2)} after 2 s`);

// (c) steer right at speed → yaw decreases, kart moves toward its right (= -X = track.right).
// Uses a wide track so the wall (14 m) doesn't interfere with a 20 m turning radius.
const wideTrack = makeTrack({ halfWidth: 500, wallDistance: 600 });
kart.reset(new THREE.Vector3(0, 0, 0), 0);
kart.speed = 30;
run(kart, wideTrack, 1, DT, (k) => { k.input.throttle = 1; k.input.steer = 1; });
check('(c) steer right → yaw decreases', kart.yaw < -1.0 && kart.yaw > -2.0, `yaw=${kart.yaw.toFixed(3)} rad`);
check('(c2) steer right → moves along track.right (-X)', kart.position.x < -5, `x=${kart.position.x.toFixed(2)}`);

// (c3) steer left mirrors
kart.reset(new THREE.Vector3(0, 0, 0), 0);
kart.speed = 30;
run(kart, wideTrack, 1, DT, (k) => { k.input.throttle = 1; k.input.steer = -1; });
check('(c3) steer left → yaw increases, moves +X', kart.yaw > 1.0 && kart.position.x > 5,
  `yaw=${kart.yaw.toFixed(3)} x=${kart.position.x.toFixed(2)}`);

// (c5) steering into a wall on the narrow track: first touch is an impact, then a grind (no 30 % per 0.3 s)
{
  const hits = [];
  kart.setEffects(null, { play: (n) => { if (n === 'wall') hits.push(n); } });
  kart.reset(new THREE.Vector3(0, 0, 0), 0);
  kart.speed = 38;
  run(kart, track, 2, DT, (k) => { k.input.throttle = 1; k.input.steer = 1; });
  check('(c5) full-lock into the wall: one impact then grinding, still moving', hits.length <= 2 && kart.speed > 8 && Math.abs(kart.position.x) <= 12.8 + 1e-6,
    `impacts=${hits.length} speed=${kart.speed.toFixed(2)} x=${kart.position.x.toFixed(2)} yaw=${kart.yaw.toFixed(2)}`);
  kart.setEffects(null, null);
}

// (c4) no turning while stopped
kart.reset(new THREE.Vector3(0, 0, 0), 0);
run(kart, track, 1, DT, (k) => { k.input.steer = 1; });
check('(c4) no yaw change while stationary', Math.abs(kart.yaw) < 1e-9, `yaw=${kart.yaw}`);

// (d) drift for 3 s while steering → tier 2; release → boost, speed exceeds base max
{
  const wide = makeTrack({ halfWidth: 500, wallDistance: 600 });
  const audioLog = [];
  kart.setEffects(null, { play: (n) => audioLog.push(n) });
  kart.reset(new THREE.Vector3(0, 0, 0), 0);
  run(kart, wide, 3, DT, (k) => { k.input.throttle = 1; });
  const entrySpeed = kart.speed;
  // press drift while steering right
  run(kart, wide, 0.1, DT, (k) => { k.input.throttle = 1; k.input.steer = 1; k.input.drift = true; });
  const started = kart.state.drifting && kart.state.driftDir === 1;
  const hopped = audioLog.includes('hop');
  const yawAtStart = kart.yaw;
  run(kart, wide, 2.9, DT, (k) => { k.input.throttle = 1; k.input.steer = 1; k.input.drift = true; });
  const tier = kart.state.driftTier;
  const slid = Math.abs(kart.slipAngle) > 0.3;
  const turned = kart.yaw !== yawAtStart;
  check('(d) hop + drift starts with steer held', started && hopped, `drifting=${kart.state.drifting} dir=${kart.state.driftDir} hop=${hopped}`);
  check('(d2) drift tier reaches 2 after 3 s', tier === 2, `tier=${tier} charge=${kart.state.driftCharge.toFixed(2)}`);
  check('(d3) kart slides (slip angle) and turns while drifting', slid && turned, `slip=${kart.slipAngle.toFixed(3)}`);
  check('(d4) tier audio cues fired', audioLog.includes('drift_tier1') && audioLog.includes('drift_tier2'), audioLog.join(','));
  // release
  run(kart, wide, DT, DT, (k) => { k.input.throttle = 1; k.input.steer = 0; k.input.drift = false; });
  const boostTimer = kart.state.boostTimer, boostPower = kart.state.boostPower;
  check('(d5) release grants a mini-turbo', !kart.state.drifting && boostTimer > 0 && Math.abs(boostPower - TUNING.MINI_TURBO_POWER) < 1e-9,
    `boostTimer=${boostTimer.toFixed(2)} power=${boostPower}`);
  run(kart, wide, 0.5, DT, (k) => { k.input.throttle = 1; });
  check('(d6) boosted speed exceeds base max', kart.speed > TUNING.BASE_MAX_SPEED + 3 && kart.maxSpeed > TUNING.BASE_MAX_SPEED,
    `speed=${kart.speed.toFixed(2)} cap=${kart.maxSpeed.toFixed(2)} entry=${entrySpeed.toFixed(1)}`);
  check('(d7) flames visible while boosting', kart.flames.every((f) => f.visible && f.scale.z > 0.5));
  run(kart, wide, 2.5, DT, (k) => { k.input.throttle = 1; });
  check('(d8) boost expires and speed decays back to cap', kart.state.boostTimer === 0 && kart.speed <= TUNING.BASE_MAX_SPEED + 1e-6
    && kart.flames.every((f) => !f.visible), `speed=${kart.speed.toFixed(2)}`);
  check('(d9) boost audio cue fired', audioLog.includes('boost'));
  kart.setEffects(null, null);
}

// (d10) drift without steering never starts; hop only
kart.reset(new THREE.Vector3(0, 0, 0), 0);
kart.speed = 30;
run(kart, track, 1, DT, (k) => { k.input.throttle = 1; k.input.drift = true; });
check('(d10) drift button without steer does not drift', !kart.state.drifting && kart.state.driftTier === 0);

// (e) beyond the wall → clamped back inside
kart.reset(new THREE.Vector3(20, 0, 0), 0);
kart.speed = 20;
run(kart, track, DT, DT, (k) => { k.input.throttle = 1; });
{
  const limit = 14 - kart.radius;
  check('(e) wall clamps |x| ≤ wallDistance − radius', Math.abs(kart.position.x) <= limit + 1e-6,
    `x=${kart.position.x.toFixed(3)} limit=${limit}`);
  check('(e2) wall contact flagged and speed −30 %', kart.wallHit === true && Math.abs(kart.speed - 20 * 0.7) < 0.5,
    `wallHit=${kart.wallHit} speed=${kart.speed.toFixed(2)}`);
}
// (e3) grinding into the wall at an angle: heading pulled toward the tangent, stays inside
kart.reset(new THREE.Vector3(-12, 0, 0), 0.6); // pointing toward +x (yaw > 0 → left), wall at x=+12.8
kart.speed = 30;
let maxAbsX = 0;
run(kart, track, 2, DT, (k) => { k.input.throttle = 1; maxAbsX = Math.max(maxAbsX, Math.abs(k.position.x)); });
check('(e3) wall grind: stays inside, heading aligns to the tangent', maxAbsX <= 12.8 + 1e-6 && Math.abs(kart.yaw) < 0.2,
  `max|x|=${maxAbsX.toFixed(2)} yaw=${kart.yaw.toFixed(3)}`);

// (f) spinOut → stunned, then recovers
kart.reset(new THREE.Vector3(0, 0, 0), 0);
kart.speed = 30;
kart.spinOut();
check('(f) spinOut stuns', kart.state.stunTimer > 0 && kart.state.spinTimer > 0 && kart.speed < 30);
run(kart, track, 0.5, DT, (k) => { k.input.throttle = 1; k.input.steer = 1; });
const midSpin = { speed: kart.speed, yaw: kart.yaw, visualYaw: kart.group.rotation.y };
check('(f2) input ignored while stunned (no accel, no steer, body spinning)',
  midSpin.speed < 5 && Math.abs(midSpin.yaw) < 1e-9 && Math.abs(midSpin.visualYaw) > 0.5,
  `speed=${midSpin.speed.toFixed(2)} yaw=${midSpin.yaw} visual=${midSpin.visualYaw.toFixed(2)}`);
run(kart, track, 0.7, DT, (k) => { k.input.throttle = 1; });
check('(f3) stun expires and the kart accelerates again', kart.state.stunTimer === 0 && kart.speed > 1,
  `speed=${kart.speed.toFixed(2)}`);
check('(f4) visual spin returns to heading', Math.abs(kart.group.rotation.y - kart.yaw) < 1e-6);
kart.setStar(5);
kart.speed = 30;
check('(f5) spinOut ignored while invincible', kart.spinOut() === false && kart.state.stunTimer === 0 && kart.speed === 30);
kart.reset(new THREE.Vector3(0, 0, 0), 0);
kart.speed = 30;
kart.crash();
check('(f6) crash: longer stun, bigger speed loss', kart.state.stunTimer === TUNING.CRASH_DURATION && kart.speed < 5);

// (g) stability at dt = 1/30 for 10 s with random inputs
{
  const rnd = lcg(12345);
  kart.reset(new THREE.Vector3(0, 0, 0), 0);
  let ok = true, maxX = 0;
  run(kart, track, 10, 1 / 30, (k, t) => {
    if (Math.floor(t * 4) !== Math.floor((t - 1 / 30) * 4)) { // new random command every 0.25 s
      k.input.throttle = rnd() < 0.8 ? 1 : 0;
      k.input.brake = rnd() < 0.1 ? 1 : 0;
      k.input.steer = rnd() * 2 - 1;
      k.input.drift = rnd() < 0.5;
    }
    if (rnd() < 0.01) k.spinOut();
    if (rnd() < 0.005) k.applyBoost(1, 1.4);
    if (!finite(k)) ok = false;
    maxX = Math.max(maxX, Math.abs(k.position.x));
  });
  check('(g) dt=1/30 for 10 s: no NaN / inf', ok && finite(kart));
  check('(g2) dt=1/30: stays inside the walls', maxX <= 12.8 + 1e-6, `max|x|=${maxX.toFixed(2)}`);
}
// (g3) same at dt = 1/120 and a huge dt (clamped) must not explode
{
  kart.reset(new THREE.Vector3(0, 0, 0), 0);
  kart.input.throttle = 1; kart.input.steer = 0.5;
  kart.update(5, track); // absurd dt → clamped internally
  check('(g3) absurd dt is clamped safely', finite(kart) && Math.abs(kart.speed) <= TUNING.BASE_MAX_SPEED + 1e-6);
}

// (h) reverse: brake while stopped → negative speed, capped
kart.reset(new THREE.Vector3(0, 0, 0), 0);
run(kart, track, 2, DT, (k) => { k.input.brake = 1; });
check('(h) reverse with brake when stopped', kart.speed < -5 && kart.speed >= -TUNING.REVERSE_MAX - 1e-9 && kart.position.z < -5,
  `speed=${kart.speed.toFixed(2)} z=${kart.position.z.toFixed(2)}`);
run(kart, track, 1, DT, (k) => { k.input.brake = 0; k.input.throttle = 1; });
check('(h2) throttle recovers from reverse', kart.speed > 0, `speed=${kart.speed.toFixed(2)}`);

// (i) boost pad
{
  const padTrack = makeTrack({ boostZone: [50, 56] });
  kart.reset(new THREE.Vector3(0, 0, 0), 0);
  run(kart, padTrack, 3, DT, (k) => { k.input.throttle = 1; });
  check('(i) boost pad triggers a 1.5× boost', kart.state.boostTimer > 0 && kart.state.boostPower === TUNING.BOOST_PAD.power,
    `timer=${kart.state.boostTimer.toFixed(2)} power=${kart.state.boostPower} z=${kart.position.z.toFixed(1)}`);
}

// (j) offroad halves the cap
kart.reset(new THREE.Vector3(-10, 0, 0), 0); // lateral = 10 > halfWidth 8
kart.speed = 38;
run(kart, track, 3, DT, (k) => { k.input.throttle = 1; });
check('(j) offroad caps speed at 50 %', kart.offroad && Math.abs(kart.speed - TUNING.BASE_MAX_SPEED * TUNING.OFFROAD_MAX_FACTOR) < 0.05,
  `speed=${kart.speed.toFixed(2)}`);

// (k) star + shrink
kart.reset(new THREE.Vector3(0, 0, 0), 0);
kart.setStar(3);
run(kart, track, 1, DT, (k) => { k.input.throttle = 1; });
check('(k) star raises the cap and flashes the body', Math.abs(kart.maxSpeed - 38 * 1.25) < 1e-9 && kart.model.bodyMat.emissiveIntensity > 0.5);
run(kart, track, 2.5, DT, (k) => { k.input.throttle = 1; });
check('(k2) star ends: emissive restored', kart.state.invincibleTimer === 0 && kart.model.bodyMat.emissive.getHex() === 0);
kart.setShrink(2);
run(kart, track, 1, DT, (k) => { k.input.throttle = 1; });
check('(k3) shrink scales the model and slows it', kart.group.scale.x < 0.6 && Math.abs(kart.maxSpeed - 38 * 0.7) < 1e-9,
  `scale=${kart.group.scale.x.toFixed(3)} cap=${kart.maxSpeed.toFixed(2)}`);
run(kart, track, 2, DT, (k) => { k.input.throttle = 1; });
check('(k4) shrink ends: scale back to 1', kart.state.shrinkTimer === 0 && kart.group.scale.x > 0.99);

// (l) helper vectors
kart.reset(new THREE.Vector3(3, 0, 5), Math.PI / 2); // facing +X
{
  const [l, r] = kart.rearWheelWorldPositions();
  const ex = kart.exhaustWorldPosition();
  const fwd = kart.forwardVector(), right = kart.rightVector();
  const behind = l.x < 3 && r.x < 3 && ex.x < 3;
  check('(l) rear wheels / exhaust are behind the kart, finite', behind && [l, r, ex].every((v) => [v.x, v.y, v.z].every(Number.isFinite)),
    `l=(${l.x.toFixed(2)},${l.z.toFixed(2)}) r=(${r.x.toFixed(2)},${r.z.toFixed(2)}) ex=(${ex.x.toFixed(2)},${ex.y.toFixed(2)},${ex.z.toFixed(2)})`);
  check('(l2) forward=(1,0,0) and right=(0,0,1) at yaw=π/2',
    Math.abs(fwd.x - 1) < 1e-9 && Math.abs(right.z - 1) < 1e-9 && Math.abs(right.x) < 1e-9);
  check('(l3) left wheel is on the −right side', (l.z - r.z) < 0);
}

// (m) effects hooks are called with the contract signatures
{
  const calls = { drift: 0, boost: 0, dust: 0 };
  const particles = {
    emitDrift(p, tier, right) { if (p.isVector3 && Number.isInteger(tier) && right.isVector3) calls.drift++; },
    emitBoost(p, dir, power) { if (p.isVector3 && dir.isVector3 && power > 1) calls.boost++; },
    emitDust(p) { if (p.isVector3) calls.dust++; },
  };
  const wide = makeTrack({ halfWidth: 500, wallDistance: 600 });
  kart.setEffects(particles, null);
  kart.reset(new THREE.Vector3(0, 0, 0), 0);
  kart.speed = 30;
  run(kart, wide, 1.5, DT, (k) => { k.input.throttle = 1; k.input.steer = 1; k.input.drift = true; }); // → tier 1
  run(kart, wide, 0.5, DT, (k) => { k.input.throttle = 1; k.input.drift = false; });                     // 0.7 s mini-turbo
  kart.reset(new THREE.Vector3(-10, 0, 0), 0);
  kart.speed = 20;
  run(kart, track, 0.5, DT, (k) => { k.input.throttle = 1; });
  check('(m) particle hooks fire (drift/boost/dust) at throttled rates',
    calls.drift > 100 && calls.drift < 250 && calls.boost > 10 && calls.boost < 80 && calls.dust > 5 && calls.dust < 30,
    `drift=${calls.drift} boost=${calls.boost} dust=${calls.dust}`);
  kart.setEffects(null, null);
}

// (n) model sanity: every mesh casts shadows, chassis receives, order YXZ, reasonable draw-call count
{
  let meshes = 0, noShadow = 0;
  kart.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    if (!o.castShadow && !kart.flames.includes(o)) noShadow++; // flames are additive, no shadow by design
  });
  check('(n) model: all solid meshes cast shadows, chassis receives', noShadow === 0 && kart.model.chassis.receiveShadow === true,
    `${meshes} meshes`);
  check('(n2) draw-call budget: ≤ 30 meshes per kart', meshes <= 30, `${meshes} meshes`);
  check('(n3) group euler order YXZ', kart.group.rotation.order === 'YXZ');
  check('(n4) contract fields present', ['drifting', 'driftDir', 'driftCharge', 'driftTier', 'hopTimer', 'boostTimer', 'boostPower',
    'spinTimer', 'stunTimer', 'invincibleTimer', 'shrinkTimer', 'airborne', 'wrongWay'].every((k) => k in kart.state)
    && ['throttle', 'brake', 'steer', 'drift', 'useItem', 'lookBack'].every((k) => k in kart.input)
    && kart.radius === 1.2 && kart.position === kart.group.position);
  // second kart shares geometry
  const k2 = new Kart(scene, { index: 3 });
  check('(n5) karts share static geometry', k2.model.chassis.geometry === kart.model.chassis.geometry && k2.color === 0xfdd835);
  k2.dispose();
}

// (o) reset zeroes everything
kart.speed = 20; kart.state.boostTimer = 3; kart.lap = 2;
kart.reset(new THREE.Vector3(1, 2, 3), 1.0, 0.98);
check('(o) reset zeroes state and sets the pose', kart.speed === 0 && kart.state.boostTimer === 0 && kart.lap === 0
  && kart.position.y === 2 && Math.abs(kart.yaw - 1) < 1e-12 && kart.trackT === 0.98);

// ----------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
