// Smoke test for src/audio.js using a Proxy-based fake AudioContext.
// Run: node tests/audio-smoke.mjs
import assert from 'node:assert/strict';

const SFX_NAMES = [
  'hop', 'drift_tier1', 'drift_tier2', 'drift_tier3', 'boost', 'item_pickup', 'item_roulette',
  'shell_fire', 'shell_hit', 'banana', 'star', 'lightning', 'bomb', 'countdown_beep',
  'countdown_go', 'lap', 'finish', 'wall', 'menu',
];

const stats = { nodes: 0, calls: 0, params: 0 };
let currentTime = 0;

function makeNode(kind = 'node') {
  stats.nodes++;
  const store = {};
  return new Proxy(function () {}, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive || prop === 'then' || prop === 'toJSON') return undefined;
      if (prop === 'currentTime') return currentTime;
      if (prop === 'sampleRate') return 44100;
      if (prop === 'state') return 'running';
      if (prop === 'resume' || prop === 'close') return () => Promise.resolve();
      if (prop === 'createBuffer') {
        return (ch, len) => ({ getChannelData: () => new Float32Array(len), length: len });
      }
      if (prop in store) return store[prop];
      // Any other property: a callable node/param proxy (works for methods and sub-objects alike).
      const child = makeNode(String(prop));
      store[prop] = child;
      return child;
    },
    set(_, prop, value) {
      stats.params++;
      store[prop] = value;
      return true;
    },
    apply() {
      stats.calls++;
      return makeNode('result');
    },
  });
}

class FakeAudioContext {
  constructor() { return makeNode('ctx'); }
}

globalThis.window = { AudioContext: FakeAudioContext };

const { AudioManager } = await import('../src/audio.js');

// --- 1. Everything is a safe no-op before init() --------------------------
const a0 = new AudioManager();
assert.doesNotThrow(() => {
  a0.setEngine(0.5, true, true);
  for (const n of SFX_NAMES) a0.play(n);
  a0.startMusic('race');
  a0.setStarMusic(true);
  a0.stopMusic();
  a0.setVolume(0.3);
  a0.setPaused(true);
  a0.setPaused(false);
  a0.setEngineEnabled(false);
});
assert.equal(a0.ready, false);

// --- 2. init() with fake context -------------------------------------------
const audio = new AudioManager();
audio.init();
assert.equal(audio.ready, true, 'context created');
audio.init(); // idempotent
assert.ok(audio.engine, 'engine graph built');

// Every contract SFX name has a definition and plays without throwing.
for (const n of SFX_NAMES) {
  assert.ok(typeof AudioManager.SFX[n] === 'function', `sfx defined: ${n}`);
  const before = stats.calls;
  audio.play(n);
  assert.ok(stats.calls > before, `sfx ${n} scheduled audio nodes`);
}
audio.play('does_not_exist'); // warns, must not throw

// Engine parameter updates
assert.doesNotThrow(() => {
  audio.setEngine(0, false, false);
  audio.setEngine(0.5, false, true);
  audio.setEngine(1, true, false);
  audio.setEngine(NaN, true, true);
  audio.setEngineEnabled(false);
  audio.setEngineEnabled(true);
});

// Music scheduler: schedule several steps by advancing the fake clock.
for (const kind of ['menu', 'race', 'results']) {
  audio.startMusic(kind);
  assert.equal(audio.music.kind, kind);
  assert.ok(audio.music.timer, 'scheduler interval running');
  const before = stats.calls;
  for (let i = 0; i < 20; i++) { currentTime += 0.1; audio._schedulerTick(); }
  assert.ok(stats.calls > before, `music ${kind} scheduled notes`);
}
audio.setStarMusic(true);
assert.equal(audio.music.transpose, 0, 'star only affects race loop');
audio.startMusic('race');
assert.equal(audio.music.transpose, 5, 'race loop transposed for star');
assert.ok(audio.music.tempoMul > 1, 'race loop faster for star');
audio.setStarMusic(false);
assert.equal(audio.music.tempoMul, 1);

// Pause halts scheduling
audio.setPaused(true);
const paused = stats.calls;
for (let i = 0; i < 5; i++) { currentTime += 0.1; audio._schedulerTick(); }
assert.equal(stats.calls, paused, 'no notes scheduled while paused');
audio.setPaused(false);

audio.stopMusic();
assert.equal(audio.music.timer, 0);
assert.equal(audio.music.kind, null);
audio.startMusic('unknown_kind'); // ignored
assert.equal(audio.music.kind, null);

audio.setVolume(0.2);
assert.equal(audio.volume, 0.2);
audio.setVolume(5);
assert.equal(audio.volume, 1);

// Pending music started before init() begins on init()
const a2 = new AudioManager();
a2.startMusic('menu');
a2.init();
assert.equal(a2.music.kind, 'menu', 'pending music started on init');
a2.stopMusic();
a2.dispose();
audio.dispose();

// --- 3. No AudioContext available → init() is a no-op, nothing throws -------
globalThis.window = {};
const a3 = new AudioManager();
assert.doesNotThrow(() => { a3.init(); a3.play('hop'); a3.startMusic('race'); a3.setEngine(1, true, true); });
assert.equal(a3.ready, false);

console.log(`audio-smoke: OK (${stats.nodes} fake nodes, ${stats.calls} calls, ${stats.params} param writes)`);
process.exit(0);
