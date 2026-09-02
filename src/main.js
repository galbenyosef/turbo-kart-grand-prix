// main.js — game orchestration: world construction, state machine, fixed-timestep
// simulation, lap/checkpoint logic, race ordering, kart-kart collisions, camera,
// HUD + audio wiring, and the window.__game test hook.
//
// State machine:  loading → menu → countdown → racing → finished → (restart) countdown
//
// Grid: the PLAYER starts LAST (track.startPositions[7]) so overtaking is part of the
// fun; bots 1..7 take slots 0..6.
//
// Lap logic (main.js owns kart.lap / kart.nextCheckpoint / kart.progress / racePosition /
// finished / finishTime): karts start with lap = 1 and nextCheckpoint = 1 — the start
// line is already "counted" at the grid. Checkpoints must be passed in order (a kart
// passes checkpoint cp when wrap(trackT - cp.t) < 2.5/N while moving forward); passing
// checkpoint 0 after N-1 increments lap; lap > TOTAL_LAPS → finished. Backing over the
// line does nothing (checkpoints are ignored while velocity·tangent < 0).

import * as THREE from 'three';
import { TOTAL_LAPS, NUM_RACERS, KART_COLORS, KART_NAMES } from './constants.js';
import { Track } from './track.js';
import { Environment } from './environment.js';
import { Kart } from './kart.js';
import { Input } from './input.js';
import { AIController } from './ai.js';
import { ItemManager } from './items.js';
import { ParticleSystem } from './particles.js';
import { AudioManager } from './audio.js';
import { HUD } from './hud.js';

const FIXED = 1 / 120;
const MAX_SUBSTEPS = 6;
const REFERENCE_TOP_SPEED = 38;      // m/s, for speedometer / engine ratio
const COUNTDOWN_SECONDS = 3;
const FINISH_COOLDOWN = 3.5;         // s between player finishing and the results panel
const RESULTS_REFRESH = 1.0;         // s
const WRONG_WAY_SPEED = -2;          // m/s along track tangent
const WRONG_WAY_TIME = 1.0;          // s
const BUMP_COOLDOWN = 0.6;           // s between speed exchanges for the same kart pair
const PLAYER_GRID_SLOT = NUM_RACERS - 1;

// Scratch vectors (never allocate per frame)
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _vdir = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _lookSmooth = new THREE.Vector3();   // persistent smoothed look-at target (chase cam)
const _up = new THREE.Vector3(0, 1, 0);

const G = {
  state: 'loading',
  paused: false,
  crashed: false,
  errorCount: 0,

  renderer: null, scene: null, camera: null,
  environment: null, track: null, particles: null, audio: null, items: null, hud: null, input: null,
  karts: [], ais: [], controllers: [], player: null, playerAI: null,

  elapsed: 0, lastTime: 0, lastRaf: 0, accumulator: 0,
  raceTime: 0,
  countdownT: 0, countdownStage: -1, goClearAt: -1,
  finishedAt: -1, resultsAt: -1, resultsFinishedCount: -1,
  playerUseItem: false,
  wrongWayTimers: new Float32Array(NUM_RACERS),
  bumpTimes: new Float32Array(NUM_RACERS * NUM_RACERS).fill(-10),
  lastRoulette: null,
  prevKeys: { pause: false, restart: false, confirm: false, useItem: false },

  cam: { fov: 60, lookBack: false, snap: true, menuT: 0, shakeSeed: 0 },
  minimapKarts: [],
  frameTimes: new Float32Array(30), frameIdx: 0, frameCount: 0, fps: 0,
};

const wrap01 = (t) => t - Math.floor(t);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Resolves on the next animation frame, or after 80 ms if rAF is starved (background tab / hidden pane).
const nextFrame = () => new Promise((r) => {
  let done = false;
  const finish = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 80);
});
async function nextFrames(n) { for (let i = 0; i < n; i++) await nextFrame(); }

// ===========================================================================
// Boot
// ===========================================================================

async function boot() {
  G.hud = new HUD();
  G.hud.setLoading(0.04, 'Starting engines…');
  G.hud.setVisible(false);
  await nextFrames(2);

  try {
    await buildWorld();
  } catch (err) {
    console.error('[main] world construction failed:', err);
    G.crashed = true;
    G.hud.showError((err && err.stack) || String(err));
    G.hud.hideLoading();
    return;
  }

  G.hud.hideLoading();
  enterMenu();
  G.hud.onStart(() => {
    if (G.state !== 'menu') return;
    G.audio.init();
    G.audio.play('menu');
    startCountdown();
  });

  window.addEventListener('resize', onResize);
  exposeTestHook();
  G.lastTime = performance.now();
  G.lastRaf = G.lastTime;
  requestAnimationFrame(loop);
  setTimeout(watchdog, 250);
}

async function buildWorld() {
  const hud = G.hud;
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  G.renderer = renderer;

  G.scene = new THREE.Scene();
  G.camera = new THREE.PerspectiveCamera(60, Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight), 0.3, 2500);
  G.camera.position.set(0, 30, 60);
  G.scene.add(G.camera);

  hud.setLoading(0.12, 'Painting the sky…');
  await nextFrames(2);
  G.environment = new Environment(G.scene, renderer);

  hud.setLoading(0.3, 'Building track…');
  await nextFrames(2);
  G.track = new Track(G.scene, renderer);

  hud.setLoading(0.62, 'Fuelling karts…');
  await nextFrames(2);
  G.particles = new ParticleSystem(G.scene);
  if (typeof G.particles.setViewport === 'function') G.particles.setViewport(Math.max(1, window.innerHeight), 60, renderer.getPixelRatio());
  G.audio = new AudioManager();
  G.items = new ItemManager(G.scene, G.track, G.particles, G.audio);

  G.karts = [];
  for (let i = 0; i < NUM_RACERS; i++) {
    const kart = new Kart(G.scene, { color: KART_COLORS[i], name: KART_NAMES[i], isPlayer: i === 0, index: i });
    if (typeof kart.setEffects === 'function') kart.setEffects(G.particles, i === 0 ? G.audio : null);
    G.karts.push(kart);
  }
  G.player = G.karts[0];
  G.minimapKarts = G.karts.map((k) => ({ x: 0, z: 0, color: k.color, isPlayer: !!k.isPlayer }));

  hud.setLoading(0.85, 'Waking up the rivals…');
  await nextFrames(1);
  G.input = new Input();
  G.ais = G.karts.slice(1).map((k, i) => new AIController(k, G.track, { skill: 0.45 + i * 0.065 }));
  G.controllers = [null, ...G.ais];

  hud.setMinimapTrack(G.track.minimapPoints || []);
  resetRace();
  hud.setLoading(1, 'Ready!');
  await nextFrames(1);
}

// ===========================================================================
// Race setup / state transitions
// ===========================================================================

function gridSlot(kart) {
  const sp = G.track.startPositions || [];
  const idx = kart.index === 0 ? PLAYER_GRID_SLOT : kart.index - 1;
  return sp[idx] || sp[sp.length - 1] || { position: new THREE.Vector3(kart.index * 3, 0, -5), yaw: 0 };
}

function zeroInput(inp) {
  inp.throttle = 0; inp.brake = 0; inp.steer = 0;
  inp.drift = false; inp.useItem = false; inp.lookBack = false;
}

function resetKart(kart) {
  const slot = gridSlot(kart);
  if (typeof kart.reset === 'function') {
    kart.reset(slot.position, slot.yaw);
  } else {
    kart.position.copy(slot.position);
    kart.yaw = slot.yaw;
    kart.speed = 0;
    if (kart.velocity) kart.velocity.set(0, 0, 0);
    if (kart.group) kart.group.rotation.set(0, slot.yaw, 0);
    if (kart.state) {
      Object.assign(kart.state, {
        drifting: false, driftDir: 0, driftCharge: 0, driftTier: 0, hopTimer: 0, boostTimer: 0, boostPower: 0,
        spinTimer: 0, stunTimer: 0, invincibleTimer: 0, shrinkTimer: 0, airborne: false,
      });
    }
  }
  if (!kart.input) kart.input = {};
  zeroInput(kart.input);
  if (!kart.state) kart.state = {};
  kart.state.wrongWay = false;

  // Race bookkeeping owned by main.js
  kart.lap = 1;
  kart.nextCheckpoint = 1;
  kart.progress = 0;
  kart.racePosition = kart.index + 1;
  kart.finished = false;
  kart.finishTime = null;
  kart.item = null;
  kart.itemCount = 0;
  kart.rouletteItem = null;
  kart.locked = true;
  kart.wallHit = false;
  try {
    const info = G.track.getRoadInfo(kart.position);
    kart.trackT = info ? info.t : 0;
  } catch (e) {
    kart.trackT = 0;
  }
}

function resetRace() {
  for (const kart of G.karts) resetKart(kart);
  if (G.items && typeof G.items.reset === 'function') G.items.reset(G.karts);
  for (const ai of G.ais) if (ai && typeof ai.reset === 'function') ai.reset();
  G.playerAI = null;
  G.controllers[0] = null;
  G.raceTime = 0;
  G.accumulator = 0;
  G.finishedAt = -1;
  G.resultsAt = -1;
  G.goClearAt = -1;
  G.playerUseItem = false;
  G.wrongWayTimers.fill(0);
  G.bumpTimes.fill(-10);
  G.lastRoulette = null;
  computeOrdering();
  G.hud.showCountdown('');
}

function enterMenu() {
  G.state = 'menu';
  G.paused = false;
  G.hud.hideResults();
  G.hud.hideOverlay();
  G.hud.setVisible(false);
  G.hud.showMenu();
  G.cam.menuT = 0;
  if (G.audio) {
    G.audio.setEngineEnabled(false);
    G.audio.startMusic('menu');
  }
}

function startCountdown() {
  G.hud.hideMenu();
  G.hud.hideResults();
  G.hud.hideOverlay();
  G.hud.setVisible(true);
  G.paused = false;
  G.audio.setPaused(false);
  G.audio.stopMusic();
  G.audio.setEngineEnabled(true);
  resetRace();
  G.state = 'countdown';
  G.countdownT = 0;
  G.countdownStage = -1;
  G.cam.snap = true;
}

function stepCountdown(dt) {
  G.countdownT += dt;
  const stage = Math.floor(G.countdownT);
  if (stage === G.countdownStage) return;
  G.countdownStage = stage;
  if (stage < COUNTDOWN_SECONDS) {
    G.hud.showCountdown(String(COUNTDOWN_SECONDS - stage));
    G.audio.play('countdown_beep');
  } else {
    goRacing();
  }
}

function goRacing() {
  G.hud.showCountdown('GO!');
  G.audio.play('countdown_go');
  G.audio.startMusic('race');
  G.state = 'racing';
  G.raceTime = 0;
  G.accumulator = 0;
  G.goClearAt = G.elapsed + 1.0;
  for (const kart of G.karts) kart.locked = false;
  G.cam.snap = true;
}

function restartRace() {
  if (G.state === 'loading') return;
  startCountdown();
}

function togglePause() {
  G.paused = !G.paused;
  if (G.paused) {
    G.hud.showOverlayMessage('PAUSED', 'PRESS P OR ESC TO RESUME  •  R TO RESTART');
  } else {
    G.hud.hideOverlay();
  }
  G.audio.setPaused(G.paused);
}

function onPlayerFinished() {
  const player = G.player;
  G.hud.showLapMessage('FINISH!');
  G.audio.play('finish');
  if (G.particles && typeof G.particles.emitConfetti === 'function') G.particles.emitConfetti(player.position);
  // Hand the player over to an AI for the cool-down lap.
  try {
    G.playerAI = new AIController(player, G.track, { skill: 0.7 });
  } catch (e) {
    console.warn('[main] could not create AI for player', e);
    G.playerAI = null;
  }
  G.controllers[0] = G.playerAI;
  G.finishedAt = G.raceTime;
}

function enterFinished() {
  G.state = 'finished';
  G.audio.startMusic('results');
  G.hud.showResults(buildStandings());
  G.resultsAt = G.raceTime;
  G.resultsFinishedCount = G.karts.reduce((n, k) => n + (k.finished ? 1 : 0), 0);
}

// ===========================================================================
// Simulation
// ===========================================================================

function simulate(dt) {
  G.accumulator += dt;
  let steps = 0;
  while (G.accumulator >= FIXED && steps < MAX_SUBSTEPS) {
    step(FIXED);
    G.accumulator -= FIXED;
    steps++;
  }
  if (steps >= MAX_SUBSTEPS) G.accumulator = 0; // drop backlog, no spiral of death
}

function step(h) {
  const karts = G.karts;
  const racing = G.state === 'racing' || G.state === 'finished';
  if (racing) G.raceTime += h;

  // 1. Inputs
  for (let i = 0; i < karts.length; i++) {
    const kart = karts[i];
    if (!kart.input) kart.input = {};
    if (!racing) { zeroInput(kart.input); continue; }
    const ctl = G.controllers[i];
    if (kart.isPlayer && !ctl) {
      const s = G.input.state || {};
      const inp = kart.input;
      inp.throttle = +s.throttle || 0;
      inp.brake = +s.brake || 0;
      inp.steer = clamp(+s.steer || 0, -1, 1);
      inp.drift = !!s.drift;
      inp.lookBack = !!s.lookBack;
      inp.useItem = G.playerUseItem;
      G.playerUseItem = false;
    } else if (ctl) {
      try { ctl.update(h, karts, G.items); } catch (e) { reportError(e); }
      // Rubber-banding: the AI writes aiSpeedFactor (≈0.94..1.06); the kart scales its cap by it.
      kart.speedMultiplier = kart.finished ? 1 : clamp(kart.aiSpeedFactor || 1, 0.9, 1.1);
    }
  }

  // 2. Item usage
  if (racing) {
    for (const kart of karts) {
      if (kart.input.useItem) {
        try { G.items.tryUse(kart, karts); } catch (e) { reportError(e); }
        kart.input.useItem = false;
      }
    }
  }

  // 3. Kart physics
  for (const kart of karts) kart.update(h, G.track);

  // 4. Kart-kart collisions
  if (racing) resolveCollisions();

  // 5. Items (boxes, projectiles, hazards)
  if (typeof G.items.update === 'function') G.items.update(h, karts);

  // 6. Lap / checkpoint / wrong-way
  if (racing) for (const kart of karts) updateLapLogic(kart, h);
}

function resolveCollisions() {
  const karts = G.karts;
  for (let i = 0; i < karts.length; i++) {
    const a = karts[i];
    const ra = a.radius || 1.2;
    for (let j = i + 1; j < karts.length; j++) {
      const b = karts[j];
      const rb = b.radius || 1.2;
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const minD = ra + rb;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const push = (minD - d) * 0.5;
      a.position.x -= nx * push; a.position.z -= nz * push;
      b.position.x += nx * push; b.position.z += nz * push;

      // Speed exchange + star spin-outs happen once per contact (per-pair cooldown);
      // the positional push-apart above runs every substep.
      const pair = i * NUM_RACERS + j;
      if (G.raceTime - G.bumpTimes[pair] < BUMP_COOLDOWN) continue;
      G.bumpTimes[pair] = G.raceTime;

      // Faster kart loses 15%, slower gains 10% of the faster's speed.
      const sa = a.speed || 0, sb = b.speed || 0;
      if (Math.abs(sa) >= Math.abs(sb)) {
        a.speed = sa * 0.85;
        b.speed = sb + 0.10 * Math.abs(sa) * Math.sign(sa || 1);
      } else {
        b.speed = sb * 0.85;
        a.speed = sa + 0.10 * Math.abs(sb) * Math.sign(sb || 1);
      }

      const aStar = a.state && a.state.invincibleTimer > 0;
      const bStar = b.state && b.state.invincibleTimer > 0;
      if (aStar && !bStar && typeof b.spinOut === 'function') b.spinOut();
      else if (bStar && !aStar && typeof a.spinOut === 'function') a.spinOut();
    }
  }
}

function kartVelocityAlongTrack(kart, t) {
  G.track.curve.getTangentAt(wrap01(t), _tangent);
  if (kart.velocity) return kart.velocity.x * _tangent.x + kart.velocity.z * _tangent.z;
  const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
  return (kart.speed || 0) * (fx * _tangent.x + fz * _tangent.z);
}

function updateLapLogic(kart, h) {
  const cps = G.track.checkpoints;
  const N = cps ? cps.length : 0;
  if (!N) return;

  let t = kart.trackT;
  if (typeof t !== 'number' || !isFinite(t)) {
    const info = G.track.getRoadInfo(kart.position);
    t = kart.trackT = info ? info.t : 0;
  }
  t = wrap01(t);

  // Wrong-way detection (only while actually moving backwards along the track)
  const along = kartVelocityAlongTrack(kart, t);
  const idx = kart.index;
  if (along < WRONG_WAY_SPEED) G.wrongWayTimers[idx] += h;
  else G.wrongWayTimers[idx] = 0;
  kart.state.wrongWay = G.wrongWayTimers[idx] > WRONG_WAY_TIME;

  if (kart.finished) return;
  if (along < 0) return; // never count checkpoints while reversing / rolling back

  const passWindow = 2.5 / N;
  for (let guard = 0; guard < 3; guard++) {
    const cp = kart.nextCheckpoint | 0;
    const dT = wrap01(t - cps[cp].t);
    if (dT >= passWindow) break; // not past it yet (or way off: must come back and pass it)
    kart.nextCheckpoint = (cp + 1) % N;
    if (cp === 0) {
      kart.lap += 1;
      if (kart.lap > TOTAL_LAPS) {
        kart.finished = true;
        kart.finishTime = G.raceTime;
        kart.lap = TOTAL_LAPS;
        if (kart.isPlayer) onPlayerFinished();
        break;
      }
      if (kart.isPlayer) {
        G.hud.showLapMessage(kart.lap === TOTAL_LAPS ? 'FINAL LAP!' : `LAP ${kart.lap}`);
        G.audio.play('lap');
      }
    }
  }
}

function computeProgress(kart) {
  const cps = G.track.checkpoints;
  const N = cps ? cps.length : 0;
  if (!N) { kart.progress = kart.lap || 0; return; }
  const cp = kart.nextCheckpoint | 0;
  const lastT = cps[(cp - 1 + N) % N].t;
  const t = typeof kart.trackT === 'number' ? wrap01(kart.trackT) : lastT;
  const d = wrap01(t - lastT);
  const slack = 3 / N;
  let frac;
  if (d < slack) frac = lastT + d;             // consistent: a little ahead of the last checkpoint
  else if (d > 1 - slack) frac = lastT + d - 1; // slightly behind it (e.g. on the grid, or backed up)
  else frac = lastT;                            // inconsistent: hold at last checkpoint
  kart.progress = (kart.lap || 0) + frac;
}

function orderKarts(list) {
  return list.slice().sort((a, b) => {
    if (a.finished && b.finished) return (a.finishTime - b.finishTime) || (a.index - b.index);
    if (a.finished) return -1;
    if (b.finished) return 1;
    return (b.progress - a.progress) || (a.index - b.index);
  });
}

function computeOrdering() {
  for (const kart of G.karts) computeProgress(kart);
  const ordered = orderKarts(G.karts);
  for (let i = 0; i < ordered.length; i++) ordered[i].racePosition = i + 1;
}

function buildStandings() {
  return orderKarts(G.karts).map((k, i) => ({
    name: k.name,
    color: k.color,
    time: k.finished ? k.finishTime : null,
    isPlayer: !!k.isPlayer,
    position: i + 1,
  }));
}

// ===========================================================================
// Camera
// ===========================================================================

function playerForward(out) {
  const p = G.player;
  out.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  return out;
}

function speedRatioOf(kart) {
  if (typeof kart.speedRatio === 'number') return clamp(kart.speedRatio, 0, 1.2);
  return clamp(Math.abs(kart.speed || 0) / REFERENCE_TOP_SPEED, 0, 1.2);
}

function chaseTarget(outPos, outLook) {
  const p = G.player;
  const st = p.state || {};
  playerForward(_fwd);
  // Blend the camera forward toward the velocity direction while drifting so the slide is visible.
  if (st.drifting && p.velocity) {
    _vdir.set(p.velocity.x, 0, p.velocity.z);
    if (_vdir.lengthSq() > 4) {
      _vdir.normalize();
      _fwd.lerp(_vdir, 0.35).normalize();
    }
  }
  _right.crossVectors(_fwd, _up).normalize();
  const ratio = speedRatioOf(p);
  const dist = 7.5;
  const height = 3.2;
  outPos.copy(p.position)
    .addScaledVector(_fwd, -dist + 0.5 * ratio)
    .addScaledVector(_up, height);
  if (st.drifting) outPos.addScaledVector(_right, (st.driftDir || 0) * 1.0);
  outLook.copy(p.position).addScaledVector(_fwd, 6).addScaledVector(_up, 1.2);
}

function keepCameraAboveRoad() {
  try {
    const info = G.track.getRoadInfo(G.camera.position, G.player.trackT);
    const minY = (info && typeof info.height === 'number' ? info.height : 0) + 1.6;
    if (G.camera.position.y < minY) G.camera.position.y = minY;
  } catch (e) { /* ignore */ }
}

function updateCamera(dt) {
  const cam = G.camera;
  const C = G.cam;
  const p = G.player;

  if (G.state === 'menu' || G.state === 'loading') {
    // Cinematic: glide along the circuit, elevated, looking ahead.
    C.menuT = wrap01(C.menuT + dt * 0.012);
    const curve = G.track && G.track.curve;
    if (curve) {
      curve.getPointAt(C.menuT, _desired);
      curve.getTangentAt(C.menuT, _tangent);
      _right.crossVectors(_tangent, _up).normalize();
      _desired.addScaledVector(_up, 25).addScaledVector(_right, 18).addScaledVector(_tangent, -10);
      curve.getPointAt(wrap01(C.menuT + 0.03), _look);
      _look.addScaledVector(_up, 3);
    } else {
      const a = C.menuT * Math.PI * 2;
      _desired.set(Math.cos(a) * 120, 40, Math.sin(a) * 120);
      _look.set(0, 0, 0);
    }
    if (C.snap) { cam.position.copy(_desired); C.snap = false; }
    else cam.position.lerp(_desired, 1 - Math.exp(-dt * 2));
    cam.lookAt(_look);
    setFov(dt, 60);
    return;
  }

  if (G.state === 'countdown') {
    // Slow orbit sweep around the player's kart that lands on the chase position at GO.
    const k = clamp(G.countdownT / COUNTDOWN_SECONDS, 0, 1);
    const e = k * k * (3 - 2 * k); // smoothstep
    const angle = p.yaw + Math.PI / 3 + (Math.PI - Math.PI / 3) * e;
    const radius = 5 + 2.5 * e;
    const height = 1.6 + 1.6 * e;
    _desired.set(p.position.x + Math.sin(angle) * radius, p.position.y + height, p.position.z + Math.cos(angle) * radius);
    _look.copy(p.position).addScaledVector(_up, 1.0);
    if (k >= 1) chaseTarget(_desired, _look);
    if (C.snap) { cam.position.copy(_desired); C.snap = false; }
    else cam.position.lerp(_desired, 1 - Math.exp(-dt * 8));
    keepCameraAboveRoad();
    cam.lookAt(_look);
    setFov(dt, 60);
    return;
  }

  // Racing / finished: chase camera (or look-back)
  const st = p.state || {};
  const lookBack = !!(G.input && G.input.state && G.input.state.lookBack) && G.state === 'racing';
  if (lookBack !== C.lookBack) { C.lookBack = lookBack; C.snap = true; }

  if (lookBack) {
    playerForward(_fwd);
    _desired.copy(p.position).addScaledVector(_fwd, 7).addScaledVector(_up, 3);
    _look.copy(p.position).addScaledVector(_up, 1).addScaledVector(_fwd, -3);
    cam.position.copy(_desired);
    keepCameraAboveRoad();
    cam.lookAt(_look);
    setFov(dt, 60);
    return;
  }

  chaseTarget(_desired, _look);
  if (C.snap) {
    cam.position.copy(_desired);
    _lookSmooth.copy(_look);
    C.snap = false;
  } else {
    cam.position.lerp(_desired, 1 - Math.exp(-dt * 6));
    _lookSmooth.lerp(_look, 1 - Math.exp(-dt * 10));
  }
  const boosting = st.boostTimer > 0;
  if (boosting) {
    cam.position.x += (Math.random() - 0.5) * 0.1;
    cam.position.y += (Math.random() - 0.5) * 0.1;
    cam.position.z += (Math.random() - 0.5) * 0.1;
  }
  keepCameraAboveRoad();
  cam.lookAt(_lookSmooth);
  setFov(dt, 60 + (boosting ? 18 : 0) + 6 * speedRatioOf(p));
}

function setFov(dt, target) {
  const C = G.cam;
  C.fov += (target - C.fov) * (1 - Math.exp(-dt * 5));
  if (Math.abs(G.camera.fov - C.fov) > 0.01) {
    G.camera.fov = C.fov;
    G.camera.updateProjectionMatrix();
  }
}

// ===========================================================================
// Per-frame HUD / audio
// ===========================================================================

function updateHud() {
  const p = G.player;
  const st = p.state || {};
  const mk = G.minimapKarts;
  for (let i = 0; i < G.karts.length; i++) {
    const k = G.karts[i];
    mk[i].x = k.position.x;
    mk[i].z = k.position.z;
  }
  const racing = G.state === 'racing' || G.state === 'finished';
  G.hud.update({
    speed: p.speed || 0,
    maxSpeed: REFERENCE_TOP_SPEED,
    lap: p.lap,
    totalLaps: TOTAL_LAPS,
    position: p.racePosition,
    totalRacers: NUM_RACERS,
    item: p.item || null,
    itemCount: p.itemCount || 0,
    driftTier: st.drifting ? (st.driftTier | 0) : 0,
    time: p.finished && typeof p.finishTime === 'number' ? p.finishTime : G.raceTime,
    wrongWay: racing && !!st.wrongWay && !p.finished,
    karts: mk,
    rouletteItem: p.rouletteItem || null,
    boosting: st.boostTimer > 0,
  });
  G.hud.setFps(G.fps);
}

function updateAudio() {
  const p = G.player;
  const st = p.state || {};
  const audio = G.audio;
  const active = G.state === 'racing' || G.state === 'finished' || G.state === 'countdown';
  if (active) {
    audio.setEngine(speedRatioOf(p), st.boostTimer > 0, !!st.drifting);
    audio.setStarMusic(st.invincibleTimer > 0);
    if (p.wallHit) { audio.play('wall'); p.wallHit = false; }
    const r = p.rouletteItem || null;
    if (r !== G.lastRoulette) {
      if (r) audio.play('item_roulette');
      G.lastRoulette = r;
    }
  }
}

// ===========================================================================
// Input (global keys)
// ===========================================================================

function consumeKey(name) {
  const inp = G.input;
  const fnName = 'consume' + name.charAt(0).toUpperCase() + name.slice(1);
  if (typeof inp[fnName] === 'function') return !!inp[fnName]();
  const s = inp.state || {};
  const down = !!s[name];
  const pressed = down && !G.prevKeys[name];
  G.prevKeys[name] = down;
  return pressed;
}

function handleGlobalInput() {
  const pause = consumeKey('pause');
  const restart = consumeKey('restart');
  const confirm = consumeKey('confirm');
  const useItem = consumeKey('useItem');
  const s = G.state;

  if ((s === 'racing' || s === 'countdown' || s === 'finished') && pause) togglePause();
  if (G.paused) {
    if (restart) { G.paused = false; G.hud.hideOverlay(); G.audio.setPaused(false); restartRace(); }
    return;
  }
  if ((s === 'racing' || s === 'countdown' || s === 'finished') && restart) { restartRace(); return; }
  if (s === 'finished' && confirm) { restartRace(); return; }
  if (s === 'racing' && useItem && !G.playerAI) G.playerUseItem = true;
}

// ===========================================================================
// Main loop
// ===========================================================================

function loop(now) {
  requestAnimationFrame(loop);
  G.lastRaf = now;
  const dt = clamp((now - G.lastTime) / 1000, 0, 0.1);
  G.lastTime = now;
  trackFps(dt);
  frame(dt, true);
}

// Watchdog: if requestAnimationFrame stalls while the page is still visible (embedded/hidden
// panes do this), keep the game alive at ~30 fps from a timer. A truly hidden tab stays paused.
function watchdog() {
  setTimeout(watchdog, 33);
  const now = performance.now();
  if (now - G.lastRaf < 200 || document.hidden) return;
  const dt = clamp((now - G.lastTime) / 1000, 0, 0.1);
  G.lastTime = now;
  trackFps(dt);
  frame(dt, true);
}

/** One full game frame with an explicit dt (seconds). `render=false` lets tests fast-forward. */
function frame(dt, render = true) {
  G.elapsed += dt;

  try {
    if (G.input && typeof G.input.update === 'function') G.input.update(dt); // game-time dt so steer/throttle ramps track the sim
    handleGlobalInput();

    if (!G.paused) {
      if (G.state === 'countdown') stepCountdown(dt);

      if (G.state === 'countdown' || G.state === 'racing' || G.state === 'finished') {
        simulate(dt);
        computeOrdering();
      }
      if (G.goClearAt > 0 && G.elapsed >= G.goClearAt) { G.hud.showCountdown(''); G.goClearAt = -1; }

      if (G.state === 'racing' && G.finishedAt >= 0 && G.raceTime - G.finishedAt >= FINISH_COOLDOWN) enterFinished();
      if (G.state === 'finished' && G.raceTime - G.resultsAt >= RESULTS_REFRESH) {
        G.resultsAt = G.raceTime;
        const done = G.karts.reduce((n, k) => n + (k.finished ? 1 : 0), 0);
        if (done !== G.resultsFinishedCount) {
          G.resultsFinishedCount = done;
          G.hud.showResults(buildStandings());
        }
      }

      if (G.particles && typeof G.particles.update === 'function') G.particles.update(dt);
      if (G.track && typeof G.track.update === 'function') G.track.update(dt, G.elapsed);
      if (G.environment && typeof G.environment.update === 'function') G.environment.update(dt, G.elapsed, G.player.position);
    }

    updateCamera(G.paused ? 0 : dt);
    updateHud();
    updateAudio();
    if (render) G.renderer.render(G.scene, G.camera);
  } catch (err) {
    reportError(err);
  }
}

function trackFps(dt) {
  G.frameTimes[G.frameIdx] = dt;
  G.frameIdx = (G.frameIdx + 1) % G.frameTimes.length;
  if (G.frameCount < G.frameTimes.length) G.frameCount++;
  let sum = 0;
  for (let i = 0; i < G.frameCount; i++) sum += G.frameTimes[i];
  G.fps = sum > 0 ? G.frameCount / sum : 0;
}

function reportError(err) {
  G.errorCount++;
  if (G.errorCount <= 3) console.error('[main]', err);
  if (!G.crashed) {
    G.crashed = true;
    try { G.hud.showError((err && err.stack) || String(err)); } catch (e) { /* ignore */ }
  }
}

function onResize() {
  if (!G.renderer || !G.camera) return;
  // Guard against a 0×0 viewport (hidden pane / iframe): a 0 height would make the aspect NaN.
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  G.renderer.setSize(w, h);
  G.camera.aspect = w / h;
  G.camera.updateProjectionMatrix();
  if (G.particles && typeof G.particles.setViewport === 'function') G.particles.setViewport(h, 60, G.renderer.getPixelRatio());
}

// ===========================================================================
// Test hook
// ===========================================================================

function exposeTestHook() {
  const api = {
    get state() { return G.state; },
    get paused() { return G.paused; },
    get raceTime() { return G.raceTime; },
    get crashed() { return G.crashed; },
    karts: G.karts,
    get player() { return G.player; },
    track: G.track,
    items: G.items,
    particles: G.particles,
    scene: G.scene,
    camera: G.camera,
    renderer: G.renderer,
    audio: G.audio,
    hud: G.hud,
    input: G.input,
    restart: restartRace,
    getFps: () => G.fps,
    standings: buildStandings,
    /** Tests: hand the player kart to an AI driver (or back to the keyboard). */
    setPlayerAI(on, skill = 0.75) {
      if (on && !G.playerAI) {
        G.playerAI = new AIController(G.player, G.track, { skill });
        G.controllers[0] = G.playerAI;
      } else if (!on) {
        G.playerAI = null;
        G.controllers[0] = null;
        G.player.speedMultiplier = 1;
      }
    },
    /** Advance one frame by dt seconds (tests); render=false skips drawing for fast-forward. */
    frame(dt = 1 / 60, render = true) { frame(clamp(+dt || 0, 0, 0.1), render); },
    /** Fast-forward `seconds` of game time in 1/60 s frames without rendering; renders once at the end. */
    fastForward(seconds) {
      const n = Math.max(0, Math.round((+seconds || 0) * 60));
      for (let i = 0; i < n; i++) frame(1 / 60, false);
      frame(1 / 60, true);
    },
    /** Start from the menu without a user gesture (audio stays silent until a gesture). */
    startRace() {
      if (G.state === 'menu') { G.audio.init(); startCountdown(); }
    },
    /** Jump straight to racing (from menu/countdown). */
    skipCountdown() {
      if (G.state === 'menu') startCountdown();
      if (G.state === 'countdown') { G.countdownT = COUNTDOWN_SECONDS; G.countdownStage = COUNTDOWN_SECONDS; goRacing(); }
    },
    /** For testing: 'menu' | 'countdown' | 'racing' | 'finished'. */
    setState(s) {
      switch (s) {
        case 'menu': enterMenu(); break;
        case 'countdown': startCountdown(); break;
        case 'racing': api.skipCountdown(); break;
        case 'finished':
          if (G.state === 'menu') startCountdown();
          if (G.state === 'countdown') api.skipCountdown();
          enterFinished();
          break;
        default: console.warn('[__game] unknown state', s);
      }
    },
    setPaused(v) { if (!!v !== G.paused) togglePause(); },
  };
  window.__game = api;
}

window.addEventListener('error', (e) => {
  if (!G.crashed && G.hud) {
    G.crashed = true;
    G.hud.showError((e.error && e.error.stack) || e.message || 'Unknown error');
  }
});
window.addEventListener('unhandledrejection', (e) => {
  if (!G.crashed && G.hud) {
    G.crashed = true;
    const r = e.reason;
    G.hud.showError((r && r.stack) || String(r));
  }
});

boot();
