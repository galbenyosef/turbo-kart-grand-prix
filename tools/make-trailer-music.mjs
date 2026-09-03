// Generates an original upbeat chiptune track for the trailer as a 16-bit stereo WAV (no deps).
// Usage: node tools/make-trailer-music.mjs out.wav [seconds]
import fs from 'node:fs';

const out = process.argv[2] || 'trailer-music.wav';
const SECONDS = Number(process.argv[3] || 42);
const SR = 44100;
const BPM = 152;
const BEAT = 60 / BPM;
const STEP = BEAT / 4; // 16th note

const n = Math.floor(SECONDS * SR);
const L = new Float32Array(n), R = new Float32Array(n);

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// C major: I – V – vi – IV, one chord per bar
const PROG = [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]];
const ROOTS = [36, 43, 45, 41];

// waveforms
const pulse = (ph, duty) => (ph % 1 < duty ? 1 : -1);
const tri = (ph) => 1 - 4 * Math.abs(Math.round(ph - 0.25) - (ph - 0.25));
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function addTone(start, dur, freq, gain, wave, { attack = 0.004, release = 0.03, pan = 0, vib = 0 } = {}) {
  const s0 = Math.floor(start * SR), s1 = Math.min(n, Math.floor((start + dur) * SR));
  let ph = 0;
  const gl = gain * (1 - pan) * 0.5 + gain * 0.5, gr = gain * (1 + pan) * 0.5 + gain * 0.5;
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR, tl = (s1 - i) / SR;
    const env = Math.min(1, t / attack) * Math.min(1, tl / release);
    const f = freq * (1 + vib * Math.sin(2 * Math.PI * 6 * t));
    ph += f / SR;
    const v = wave(ph) * env;
    L[i] += v * gl; R[i] += v * gr;
  }
}
function addNoise(start, dur, gain, { lowpass = 0.5, decay = 0.05 } = {}) {
  const s0 = Math.floor(start * SR), s1 = Math.min(n, Math.floor((start + dur) * SR));
  let y = 0;
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    y += (rnd() * 2 - 1 - y) * lowpass;
    const v = y * Math.exp(-t / decay) * gain;
    L[i] += v; R[i] += v;
  }
}
function addKick(start, gain = 0.9) {
  const s0 = Math.floor(start * SR), s1 = Math.min(n, s0 + Math.floor(0.22 * SR));
  let ph = 0;
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    const f = 40 + 120 * Math.exp(-t * 28);
    ph += f / SR;
    const v = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 14) * gain;
    L[i] += v; R[i] += v;
  }
}

// ---- arrangement -----------------------------------------------------------
// lead melody (C major pentatonic, MIDI), 2 bars × 16 steps; 0 = rest, -1 = hold
const LEAD_A = [72, 0, 76, 0, 79, -1, 76, 0, 74, 0, 72, 0, 69, -1, 0, 0, 67, 0, 69, 0, 72, -1, 74, 0, 76, -1, 0, 0, 79, -1, 0, 0];
const LEAD_B = [84, 0, 81, 0, 79, -1, 76, 0, 79, 0, 81, 0, 84, -1, 0, 0, 81, 0, 79, 0, 76, -1, 74, 0, 72, -1, -1, 0, 67, 0, 69, 0];
const totalSteps = Math.floor(SECONDS / STEP);
const STEPS_PER_BAR = 16;

for (let step = 0; step < totalSteps; step++) {
  const t = step * STEP;
  const bar = Math.floor(step / STEPS_PER_BAR);
  const inBar = step % STEPS_PER_BAR;
  const chord = PROG[bar % 4];
  const root = ROOTS[bar % 4];
  const intro = bar < 2;                       // first two bars: bass + hats only
  const outro = t > SECONDS - 4;

  // drums
  if (!intro) {
    if (inBar % 8 === 0 || inBar === 10) addKick(t);
    if (inBar === 4 || inBar === 12) addNoise(t, 0.16, 0.6, { lowpass: 0.35, decay: 0.045 });
  }
  if (inBar % 2 === 0) addNoise(t, 0.05, intro ? 0.14 : 0.2, { lowpass: 0.9, decay: 0.012 });

  // bass: root / fifth / octave pattern, square wave
  const bassNote = [root, root + 12, root, root + 7][inBar % 4] + (inBar % 8 >= 4 ? 0 : 0);
  if (inBar % 2 === 0) addTone(t, STEP * 1.6, midi(bassNote), 0.22, (p) => pulse(p, 0.5), { release: 0.02 });

  // chords: arpeggiated 16ths, thin pulse, panned
  if (!intro) {
    const ci = inBar % 3;
    addTone(t, STEP * 0.9, midi(chord[ci] + 12), 0.075, (p) => pulse(p, 0.25), { pan: ci === 0 ? -0.5 : ci === 2 ? 0.5 : 0, release: 0.02 });
  }

  // lead
  if (!intro && !outro) {
    const pattern = ((bar - 2) % 8) < 4 ? LEAD_A : LEAD_B;
    const idx = ((bar - 2) % 2) * 16 + inBar;
    const note = pattern[idx];
    if (note > 0) {
      let len = 1; while (idx + len < pattern.length && pattern[idx + len] === -1) len++;
      addTone(t, STEP * len * 0.95, midi(note), 0.2, (p) => pulse(p, 0.125), { vib: len > 1 ? 0.004 : 0, pan: 0.15, release: 0.04 });
      addTone(t, STEP * len * 0.95, midi(note - 12), 0.06, tri, { pan: -0.15 });
    }
  }
}

// master: soft clip, fade in/out
for (let i = 0; i < n; i++) {
  const t = i / SR;
  const fade = Math.min(1, t / 0.5) * Math.min(1, (SECONDS - t) / 2.5);
  L[i] = Math.tanh(L[i] * 1.6) * 0.85 * fade;
  R[i] = Math.tanh(R[i] * 1.6) * 0.85 * fade;
}

// write WAV
const buf = Buffer.alloc(44 + n * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}
fs.writeFileSync(out, buf);
console.log(`wrote ${out}: ${SECONDS}s @ ${BPM} BPM, ${(buf.length / 1048576).toFixed(1)} MB`);
