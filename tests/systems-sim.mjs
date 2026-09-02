/**
 * Headless simulation tests for items.js, ai.js and particles.js.
 * Run from the project root:  node tests/systems-sim.mjs
 * Requires `npm i three@0.160.0 --no-save` (node_modules/three) so the bare 'three' specifier resolves.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- DOM stub (for the '?' canvas texture)
globalThis.document = {
  createElement(tag) {
    const el = { tagName: tag, width: 0, height: 0 };
    el.getContext = () => new Proxy({ canvas: el }, {
      get: (t, key) => (key in t ? t[key] : () => {}),
      set: (t, key, v) => { t[key] = v; return true; },
    });
    return el;
  },
};

const { ItemManager } = await import('../src/items.js');
const { AIController } = await import('../src/ai.js');
const { ParticleSystem } = await import('../src/particles.js');

// ---------------------------------------------------------------- fakes
const R = 150;
const TWO_PI = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const wrap01 = (t) => t - Math.floor(t);

function makeScene() {
  return { objects: new Set(), add(o) { this.objects.add(o); }, remove(o) { this.objects.delete(o); } };
}

function makeTrack() {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TWO_PI;
    pts.push(new THREE.Vector3(Math.sin(a) * R, 0, Math.cos(a) * R));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  const length = curve.getLength();
  const itemBoxPositions = [];
  for (let i = 0; i < 4; i++) {
    const a = 0.1 * TWO_PI, lat = -6 + i * 4;
    itemBoxPositions.push(new THREE.Vector3(Math.sin(a) * (R + lat), 1.2, Math.cos(a) * (R + lat)));
  }
  const checkpoints = [];
  for (let i = 0; i < 24; i++) {
    const t = i / 24;
    checkpoints.push({ t, position: curve.getPointAt(t), tangent: curve.getTangentAt(t) });
  }
  return {
    curve, length, roadWidth: 16, itemBoxPositions, checkpoints,
    getRoadInfo(pos) {
      const a = Math.atan2(pos.x, pos.z);
      const t = wrap01(a / TWO_PI);
      const r = Math.hypot(pos.x, pos.z);
      const tangent = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      const right = new THREE.Vector3().crossVectors(tangent, UP).normalize();
      const lateral = r - R;
      return {
        t, center: new THREE.Vector3(Math.sin(a) * R, 0, Math.cos(a) * R), tangent, right, lateral,
        height: 0, surface: Math.abs(lateral) > 8 ? 'offroad' : 'road', onRoad: Math.abs(lateral) <= 8, wallDistance: 14,
      };
    },
  };
}

function makeKart(index, isPlayer = false) {
  return {
    index, name: 'K' + index, isPlayer, position: new THREE.Vector3(), yaw: 0, speed: 0,
    velocity: new THREE.Vector3(), radius: 1.2, trackT: 0, progress: 0, racePosition: index + 1, lap: 0,
    item: null, itemCount: 0, finished: false, locked: false,
    state: { invincibleTimer: 0, stunTimer: 0, spinTimer: 0, drifting: false, driftTier: 0, boostTimer: 0, airborne: false },
    input: { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false },
    calls: [],
    applyBoost(d, p) { this.calls.push(['boost', d, p]); },
    spinOut() { if (this.state.invincibleTimer > 0) return; this.calls.push(['spinOut']); this.state.stunTimer = 1; },
    crash() { this.calls.push(['crash']); this.state.stunTimer = 1.5; },
    setStar(d) { this.calls.push(['star', d]); this.state.invincibleTimer = d; },
    setShrink(d) { this.calls.push(['shrink', d]); },
    forwardVector() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); },
    has(name) { return this.calls.some((c) => c[0] === name); },
  };
}

/** Places a kart on the circle at angle a (radians along +t), lateral offset (+ = outside), facing +t. */
function placeOnCircle(k, a, lateral = 0) {
  k.position.set(Math.sin(a) * (R + lateral), 0, Math.cos(a) * (R + lateral));
  k.yaw = Math.atan2(Math.cos(a), -Math.sin(a));
  k.trackT = wrap01(a / TWO_PI);
}

function makeParticlesStub() {
  return { pops: 0, explosions: [], emitPop() { this.pops++; }, emitExplosion(p) { this.explosions.push(p.clone()); } };
}
function makeAudioStub() { return { sounds: [], play(n) { this.sounds.push(n); } }; }

// ---------------------------------------------------------------- harness
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function test(name, fn) {
  try { await fn(); } catch (e) { check(name, false, 'threw: ' + (e && e.stack || e)); }
}
const DT = 1 / 60;

// Sanity: curve param convention matches the fake getRoadInfo
{
  const track = makeTrack();
  const p = track.curve.getPointAt(0.25);
  const err = Math.hypot(p.x - R, p.z);
  check('fake track: curve.getPointAt(0.25) ≈ (R,0,0)', err < 2, `err=${err.toFixed(2)} m, length=${track.length.toFixed(1)} m`);
}

// (a) green shell hits a kart 20 m ahead within 1 s
await test('(a) green shell', () => {
  const scene = makeScene(), track = makeTrack(), particles = makeParticlesStub(), audio = makeAudioStub();
  const items = new ItemManager(scene, track, particles, audio);
  const A = makeKart(0, true), B = makeKart(1);
  placeOnCircle(A, 0); placeOnCircle(B, 20 / R);
  const karts = [A, B];
  A.item = 'green_shell'; A.itemCount = 1;
  const used = items.tryUse(A, karts);
  check('(a) tryUse consumed the green shell', used && A.item === null && items.projectiles.length === 1);
  items.update(DT, karts);
  check('(a) hazards exposes the shell', items.hazards.length === 1 && items.hazards[0].type === 'green_shell' && items.hazards[0].velocity.length() > 40);
  let hitAt = -1;
  for (let f = 1; f <= 60; f++) {
    items.update(DT, karts);
    if (B.has('spinOut')) { hitAt = f * DT; break; }
  }
  check('(a) green shell hit kart 20 m ahead within 1 s', hitAt > 0 && hitAt < 1, `hit at ${hitAt.toFixed(2)} s`);
  check('(a) owner not hit, shell removed after hit', !A.has('spinOut') && items.projectiles.length === 0 && items.hazards.length === 0);
  check('(a) audio: shell_fire + shell_hit played', audio.sounds.includes('shell_fire') && audio.sounds.includes('shell_hit'));
});

// (b) red shell homes to the position-1 kart 30 m ahead and 5 m aside within 2 s
await test('(b) red shell', () => {
  const scene = makeScene(), track = makeTrack();
  const items = new ItemManager(scene, track);
  const A = makeKart(0), B = makeKart(1);
  A.racePosition = 2; B.racePosition = 1;
  placeOnCircle(A, 0); placeOnCircle(B, 30 / R, 5);
  const karts = [A, B];
  A.item = 'red_shell';
  items.tryUse(A, karts);
  check('(b) red shell acquired the leader as target', items.projectiles[0] && items.projectiles[0].target === B);
  let hitAt = -1;
  for (let f = 1; f <= 120; f++) {
    items.update(DT, karts);
    if (B.has('spinOut')) { hitAt = f * DT; break; }
  }
  check('(b) red shell homed onto target within 2 s', hitAt > 0 && hitAt < 2, `hit at ${hitAt.toFixed(2)} s`);

  // leader fires a red shell: no target → behaves like a green (still flies, eventually despawns)
  const items2 = new ItemManager(makeScene(), track);
  const L = makeKart(2); L.racePosition = 1; placeOnCircle(L, 0); L.item = 'red_shell';
  items2.tryUse(L, [L]);
  check('(b) leader red shell has no target', items2.projectiles[0].target === null);
});

// (c) banana dropped behind hits a kart driving over it
await test('(c) banana', () => {
  const scene = makeScene(), track = makeTrack(), audio = makeAudioStub();
  const items = new ItemManager(scene, track, undefined, audio);
  const A = makeKart(0), C = makeKart(1);
  placeOnCircle(A, 0); // at (0,0,150) facing +X
  A.item = 'banana';
  items.tryUse(A, [A, C]);
  const banana = items.projectiles[0];
  check('(c) banana dropped 2.5 m behind the kart, at road height', banana && banana.type === 'banana' && Math.abs(banana.position.x + 2.5) < 0.05 && banana.position.y > 0 && banana.position.y < 0.6,
    `pos=(${banana.position.x.toFixed(2)}, ${banana.position.y.toFixed(2)}, ${banana.position.z.toFixed(2)})`);
  C.position.set(-12, 0, 150); C.yaw = Math.PI / 2; C.speed = 20;
  let hitAt = -1;
  for (let f = 1; f <= 120; f++) {
    C.position.x += 20 * DT;
    items.update(DT, [A, C]);
    if (C.has('spinOut')) { hitAt = f * DT; break; }
  }
  check('(c) banana spun out the kart that drove over it', hitAt > 0 && !A.has('spinOut') && items.projectiles.length === 0, `hit at ${hitAt.toFixed(2)} s`);
  check('(c) banana slip sound played', audio.sounds.includes('banana'));

  // lookBack held → lobbed forward, lands ahead on the road
  const items2 = new ItemManager(makeScene(), track);
  const D = makeKart(3); placeOnCircle(D, 0); D.item = 'banana'; D.input.lookBack = true;
  items2.tryUse(D, [D]);
  for (let f = 0; f < 120; f++) items2.update(DT, [D]);
  const lob = items2.projectiles[0];
  check('(c) lobbed banana lands ~14 m ahead', lob && lob.landed && lob.position.x > 10 && lob.position.x < 18, `x=${lob ? lob.position.x.toFixed(1) : '?'}`);
});

// (d) bomb explodes on contact; crashes karts within 6 m but not at ~10 m
await test('(d) bomb', () => {
  const scene = makeScene(), track = makeTrack(), particles = makeParticlesStub(), audio = makeAudioStub();
  const items = new ItemManager(scene, track, particles, audio);
  const A = makeKart(0);
  placeOnCircle(A, 0);
  A.item = 'bomb';
  items.tryUse(A, [A]);
  const bomb = items.projectiles[0];
  check('(d) bomb thrown forward with an upward arc', bomb && bomb.type === 'bomb' && bomb.velocity.y === 9 && bomb.velocity.x > 15);
  let time = 0;
  while (!bomb.landed && time < 2.5) { items.update(DT, [A]); time += DT; }
  check('(d) bomb landed on the road and walks along the tangent', bomb.landed && time < 1.5 && Math.abs(bomb.position.y) < 0.01 && Math.abs(bomb.velocity.length() - 6) < 0.01,
    `landed at t=${time.toFixed(2)} s, x=${bomb.position.x.toFixed(1)}`);
  const dir = bomb.velocity.clone().normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);
  const D = makeKart(1), E = makeKart(2), F = makeKart(3);
  D.position.copy(bomb.position).addScaledVector(dir, 5);
  F.position.copy(D.position).addScaledVector(perp, 4);
  E.position.copy(D.position).addScaledVector(perp, 10);
  const karts = [A, D, E, F];
  let explodedAt = -1;
  while (items.projectiles.length && time < 3) {
    items.update(DT, karts);
    time += DT;
    if (particles.explosions.length && explodedAt < 0) explodedAt = time;
  }
  const ex = particles.explosions[0];
  const dist = (k) => (ex ? Math.hypot(k.position.x - ex.x, k.position.z - ex.z) : NaN);
  check('(d) bomb exploded on contact before the fuse ran out', explodedAt > 0 && explodedAt < 2.5 && audio.sounds.includes('bomb'), `exploded at ${explodedAt.toFixed(2)} s`);
  check('(d) karts within 6 m crashed', D.has('crash') && F.has('crash'), `D at ${dist(D).toFixed(1)} m, F at ${dist(F).toFixed(1)} m`);
  check('(d) kart at ~10 m not crashed, thrower far away not crashed', !E.has('crash') && !A.has('crash'), `E at ${dist(E).toFixed(1)} m`);

  // fuse-end explosion with nobody around
  const items2 = new ItemManager(makeScene(), track, makeParticlesStub());
  const G = makeKart(4); placeOnCircle(G, 0); G.item = 'bomb';
  items2.tryUse(G, [G]);
  let t2 = 0;
  while (items2.projectiles.length && t2 < 4) { items2.update(DT, [G]); t2 += DT; }
  check('(d) bomb self-destructs at fuse end (2.5 s)', Math.abs(t2 - 2.5) < 0.05 && !G.has('crash'), `gone at ${t2.toFixed(2)} s`);
});

// (e) lightning shrinks + spins all but the user (and spares invincible karts)
await test('(e) lightning', () => {
  const track = makeTrack(), particles = makeParticlesStub(), audio = makeAudioStub();
  const items = new ItemManager(makeScene(), track, particles, audio);
  const karts = [];
  for (let i = 0; i < 8; i++) { const k = makeKart(i, i === 0); placeOnCircle(k, i * 0.1); karts.push(k); }
  const user = karts[7];
  karts[3].state.invincibleTimer = 4; // starred kart is immune
  user.item = 'lightning';
  items.tryUse(user, karts);
  const victims = karts.filter((k) => k !== user && k !== karts[3]);
  check('(e) all other karts shrunk + spun', victims.every((k) => k.has('shrink') && k.has('spinOut')) && victims.length === 6);
  check('(e) user immune, starred kart immune, item consumed', !user.has('shrink') && !karts[3].has('shrink') && user.item === null && audio.sounds.includes('lightning'));
});

// star contact + mushrooms + roll distribution
await test('(misc) star / mushroom / rollItem / boxes', () => {
  const track = makeTrack();
  const items = new ItemManager(makeScene(), track, makeParticlesStub(), makeAudioStub());
  const A = makeKart(0), B = makeKart(1);
  placeOnCircle(A, 0); placeOnCircle(B, 2.5 / R);
  A.item = 'star';
  items.tryUse(A, [A, B]);
  items.update(DT, [A, B]);
  check('(misc) star: kart touched by a starred kart spins out', A.has('star') && B.has('spinOut'));

  const M = makeKart(2); M.item = 'triple_mushroom'; M.itemCount = 3;
  items.tryUse(M, [M]); items.tryUse(M, [M]);
  const two = M.item === 'triple_mushroom' && M.itemCount === 1;
  items.tryUse(M, [M]);
  check('(misc) triple mushroom: 3 boosts then cleared', two && M.item === null && M.calls.filter((c) => c[0] === 'boost').length === 3);

  const counts = { front: {}, back: {} };
  for (let i = 0; i < 2000; i++) {
    const k = makeKart(0); k.racePosition = 1; items.rollItem(k); counts.front[k.item] = (counts.front[k.item] || 0) + 1;
    const b = makeKart(0); b.racePosition = 8; items.rollItem(b); counts.back[b.item] = (counts.back[b.item] || 0) + 1;
  }
  check('(misc) rollItem: leader never gets star/lightning/bomb; last place gets them', !counts.front.star && !counts.front.lightning && !counts.front.bomb && counts.back.star > 200 && counts.back.lightning > 150 && counts.front.banana > 600,
    `front=${JSON.stringify(counts.front)} back=${JSON.stringify(counts.back)}`);

  // item box pickup → roulette → item, box respawn
  const items2 = new ItemManager(makeScene(), track, makeParticlesStub(), makeAudioStub());
  check('(misc) one item box per track position', items2.boxes.length === 4);
  const P = makeKart(0, true);
  P.position.copy(track.itemBoxPositions[1]); P.position.y = 0;
  items2.update(DT, [P]);
  check('(misc) box pickup starts a 1.5 s roulette', P.rouletteTimer > 1.4 && typeof P.rouletteItem === 'string' && items2.boxes[1].state === 'shrinking');
  P.position.x += 30; // drive away so the respawned box is not collected again immediately
  let seen = new Set();
  for (let f = 0; f < 100; f++) { items2.update(DT, [P]); if (P.rouletteItem) seen.add(P.rouletteItem); }
  check('(misc) roulette cycles items then rolls one', seen.size >= 5 && P.rouletteItem === null && P.rouletteTimer === 0 && typeof P.item === 'string');
  for (let f = 0; f < 130; f++) items2.update(DT, [P]);
  check('(misc) box respawned ~3.5 s after pickup', items2.boxes[1].state === 'active' && items2.boxes[1].inner.visible, `state=${items2.boxes[1].state}`);
  items2.reset([P]);
  check('(misc) reset clears kart item state', P.item === null && P.rouletteItem === null && items2.projectiles.length === 0);
});

// shell wall bounces
await test('(wall) green shell bounces', () => {
  const track = makeTrack();
  const items = new ItemManager(makeScene(), track, makeParticlesStub());
  const A = makeKart(0);
  A.position.set(0, 0, R); A.yaw = 0; // facing +Z = radially outward → straight into the outer wall
  A.item = 'green_shell';
  items.tryUse(A, [A]);
  A.position.set(0, 0, 0); // move the owner out of the rebound path (a bounced shell CAN hit its owner after 0.5 s)
  const shell = items.projectiles[0];
  let maxLat = 0, t = 0, bounces = 0;
  while (items.projectiles.length && t < 6) {
    items.update(DT, [A]);
    t += DT;
    if (items.projectiles.length) {
      const lat = Math.abs(Math.hypot(shell.position.x, shell.position.z) - R);
      if (lat > maxLat) maxLat = lat;
      bounces = shell.bounces;
    }
  }
  check('(wall) shell stayed inside the barriers and popped after 3 bounces', maxLat < 14.2 && bounces === 3 && t < 6 && items.projectiles.length === 0, `maxLateral=${maxLat.toFixed(2)} bounces=${bounces} gone at ${t.toFixed(2)} s`);
});

// (f) AIController drives a kinematic kart around the circle for 30 s
await test('(f) AI', () => {
  const track = makeTrack();
  const items = new ItemManager(makeScene(), track);
  const K = makeKart(1), P = makeKart(0, true);
  placeOnCircle(K, 0); placeOnCircle(P, 0.02);
  P.progress = 0.02;
  const ai = new AIController(K, track, { skill: 0.7 });
  let maxLat = 0, laps = 0, lastT = 0, minSpeed = Infinity, time = 0;
  const step = () => {
    ai.update(DT, [K, P], items);
    const inp = K.input;
    const target = inp.throttle > 0 ? 30 * inp.throttle : inp.brake > 0 ? -6 : 0;
    K.speed += (target - K.speed) * Math.min(1, DT * 1.5);
    K.yaw -= inp.steer * 2 * DT * (K.speed < 0 ? -1 : 1); // kart.js convention: positive steer = right (yaw decreases), flipped in reverse
    K.position.x += Math.sin(K.yaw) * K.speed * DT;
    K.position.z += Math.cos(K.yaw) * K.speed * DT;
    const info = track.getRoadInfo(K.position);
    if (info.t < 0.2 && lastT > 0.8) laps++;
    lastT = info.t;
    K.trackT = info.t;
    K.progress = laps + info.t;
    K.lap = laps;
    maxLat = Math.max(maxLat, Math.abs(info.lateral));
    time += DT;
  };
  // countdown lock: zero input
  K.locked = true;
  ai.update(DT, [K, P], items);
  check('(f) AI outputs zero input while locked', K.input.throttle === 0 && K.input.steer === 0 && K.input.drift === false);
  K.locked = false;
  for (let f = 0; f < 30 * 60; f++) { step(); if (time > 3) minSpeed = Math.min(minSpeed, K.speed); }
  check('(f) AI stayed on the road for 30 s (|lateral| < 8)', maxLat < 8, `max |lateral| = ${maxLat.toFixed(2)} m`);
  check('(f) AI made forward progress', K.progress > 0.5, `progress = ${K.progress.toFixed(2)} laps (${(K.progress * track.length).toFixed(0)} m), min speed after 3 s = ${minSpeed.toFixed(1)}`);
  check('(f) rubber-band fields written', typeof K.aiSpeedFactor === 'number' && typeof K.rubberBoost === 'boolean', `aiSpeedFactor=${K.aiSpeedFactor.toFixed(2)} rubberBoost=${K.rubberBoost}`);

  // wrong-way recovery: face backwards, expect to turn around within 6 s
  placeOnCircle(K, 0.5); K.yaw += Math.PI; K.speed = 0; lastT = 0.5 / TWO_PI;
  for (let f = 0; f < 6 * 60; f++) step();
  const info = track.getRoadInfo(K.position);
  const dot = Math.sin(K.yaw) * info.tangent.x + Math.cos(K.yaw) * info.tangent.z;
  check('(f) wrong-way recovery turned the kart around', dot > 0.8 && Math.abs(info.lateral) < 14, `dot=${dot.toFixed(2)} lateral=${info.lateral.toFixed(1)}`);

  // item use pulses
  const B = makeKart(2); placeOnCircle(B, 15 / R); // kart ahead within 30 m in the cone
  placeOnCircle(K, 0); K.speed = 25; K.item = 'green_shell'; K.itemCount = 1;
  let pulses = 0, frames = 0;
  for (let f = 0; f < 60; f++) { ai.update(DT, [K, P, B], items); if (K.input.useItem) { pulses++; frames = f; K.item = null; } }
  check('(f) AI pulses useItem once for a green shell with a kart ahead', pulses === 1 && frames < 40, `pulses=${pulses} at frame ${frames}`);
  K.finished = true; K.item = 'star'; pulses = 0;
  for (let f = 0; f < 300; f++) { ai.update(DT, [K, P, B], items); if (K.input.useItem) pulses++; }
  check('(f) finished AI never uses items but keeps driving', pulses === 0 && K.input.throttle > 0);

  // hazard avoidance: a banana straight ahead biases steering
  K.finished = false; placeOnCircle(K, 0); K.speed = 25; K.item = null;
  const H = makeKart(3); placeOnCircle(H, 0); H.item = 'banana'; H.input.lookBack = true; H.speed = 0; items.tryUse(H, [H]);
  for (let f = 0; f < 60; f++) items.update(DT, [H]);
  const lob = items.projectiles[0];
  const rel = lob.position.x - K.position.x;
  ai.laneOffset = 0; ai.laneTarget = 0;
  ai.update(DT, [K], items);
  const steerWith = K.input.steer;
  items.reset();
  ai.update(DT, [K], items);
  const steerWithout = K.input.steer;
  check('(f) AI steers around a banana lying ahead', lob.landed && rel > 5 && Math.abs(steerWith - steerWithout) > 0.2, `banana ${rel.toFixed(1)} m ahead; steer with=${steerWith.toFixed(2)} without=${steerWithout.toFixed(2)}`);
});

// (g) ParticleSystem: 5000 particles, no NaN, returns to 0
await test('(g) particles', () => {
  const scene = makeScene();
  const ps = new ParticleSystem(scene);
  const p = new THREE.Vector3(3, 0, 5);
  for (let i = 0; i < 10; i++) ps.emitExplosion(p);   // 1200 sparks + 400 smoke
  for (let i = 0; i < 100; i++) ps.emitPop(p, 0x44ff88); // 3000 sparks
  ps.emitConfetti(p); ps.emitConfetti(p);               // 400 smoke
  ps.emitDrift(p, 3, new THREE.Vector3(1, 0, 0)); ps.emitDrift(p, 0, new THREE.Vector3(1, 0, 0));
  ps.emitBoost(p, new THREE.Vector3(0, 0, -1), 1.4); ps.emitDust(p);
  const spawned = ps.activeCount;
  check('(g) 5000+ particles spawned (pool caps at 6000)', spawned >= 4300 && spawned <= 6000, `active=${spawned} (sparks ${ps.sparks.count}/${ps.sparks.capacity}, smoke ${ps.smoke.count}/${ps.smoke.capacity})`);
  let nan = false;
  const t0 = performance.now();
  for (let f = 0; f < 100; f++) {
    ps.update(DT);
    for (const pool of [ps.sparks, ps.smoke]) {
      for (let i = 0; i < pool.count * 3; i++) if (!Number.isFinite(pool.pos[i])) { nan = true; break; }
      for (let i = 0; i < pool.count; i++) if (!Number.isFinite(pool.size[i]) || !Number.isFinite(pool.alpha[i])) { nan = true; break; }
    }
  }
  const ms = (performance.now() - t0) / 100;
  check('(g) 100 frames without NaN', !nan, `${ms.toFixed(3)} ms/frame CPU with ${spawned} particles`);
  check('(g) draw range tracks live count', ps.sparks.geometry.drawRange.count === ps.sparks.count && ps.smoke.geometry.drawRange.count === ps.smoke.count);
  let time = 100 * DT;
  while (ps.activeCount > 0 && time < 3.5) { ps.update(DT); time += DT; }
  check('(g) all particles expired within max lifetime (3 s)', ps.activeCount === 0 && time <= 3.2, `empty at ${time.toFixed(2)} s`);
  check('(g) shockwave meshes hidden after 0.5 s', ps._waves.every((w) => !w.active && !w.ring.visible));
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
