// AudioManager — 100% procedural WebAudio: engine hum, one-shot SFX and a chiptune
// music sequencer (look-ahead scheduler). Every public method is a safe no-op until
// init() has been called from a user gesture, and never throws if WebAudio is missing.

const TAU_SMOOTH = 0.05;   // setTargetAtTime time constant for engine params
const LOOKAHEAD = 0.1;     // seconds of audio scheduled ahead
const TICK_MS = 25;        // scheduler interval

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// Music patterns (8th-note grid, 8 steps per bar). 0 = rest.
// ---------------------------------------------------------------------------

function bassFromRoots(roots) {
  const out = [];
  for (const r of roots) out.push(r, r, r + 12, r, r, r + 12, r, r + 7);
  return out;
}

const RACE = {
  bpm: 150,
  bass: bassFromRoots([36, 43, 45, 41, 36, 43, 41, 43]),  // C G Am F | C G F G
  lead: [
    72, 76, 79, 84, 79, 76, 72, 76,   // C
    74, 79, 83, 79, 74, 79, 71, 74,   // G
    69, 72, 76, 81, 76, 72, 69, 72,   // Am
    77, 81, 84, 81, 77, 74, 72, 74,   // F
    84, 0, 84, 83, 81, 79, 76, 79,    // C
    79, 0, 79, 81, 83, 79, 74, 76,    // G
    77, 79, 81, 84, 81, 79, 77, 76,   // F
    74, 76, 79, 83, 84, 0, 79, 0,     // G
  ],
  drums: ['K', 'H', 'S', 'H', 'K', 'H', 'S', 'KH'],
  leadType: 'square', bassType: 'square', leadGain: 0.09, bassGain: 0.11,
};

const MENU = {
  bpm: 88,
  bass: [48, 0, 0, 0, 55, 0, 0, 0, 45, 0, 0, 0, 52, 0, 0, 0, 41, 0, 0, 0, 48, 0, 0, 0, 43, 0, 0, 0, 47, 0, 0, 0],
  lead: [
    60, 64, 67, 71, 72, 71, 67, 64,   // Cmaj7
    57, 60, 64, 67, 69, 67, 64, 60,   // Am7
    53, 57, 60, 64, 65, 64, 60, 57,   // Fmaj7
    55, 59, 62, 65, 67, 65, 62, 59,   // G7
  ],
  drums: ['', '', '', '', '', '', '', ''],
  leadType: 'triangle', bassType: 'sine', leadGain: 0.12, bassGain: 0.14, release: 0.35,
};

const RESULTS = {
  bpm: 120,
  bass: bassFromRoots([36, 41, 43, 36]),
  lead: [
    72, 0, 76, 0, 79, 0, 84, 0,       // C fanfare
    77, 0, 81, 0, 84, 0, 89, 0,       // F
    79, 79, 83, 83, 86, 86, 91, 0,    // G
    84, 0, 88, 0, 91, 91, 96, 0,      // C
  ],
  drums: ['K', 'H', 'S', 'H', 'K', 'H', 'S', 'H'],
  leadType: 'square', bassType: 'triangle', leadGain: 0.1, bassGain: 0.12,
};

const PATTERNS = { race: RACE, menu: MENU, results: RESULTS };

// ---------------------------------------------------------------------------

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.engineBus = null;
    this.engine = null;
    this.noiseBuffer = null;
    this.volume = 0.6;
    this.paused = false;
    this.engineEnabled = true;

    this.music = {
      kind: null, pattern: null, timer: 0, step: 0, nextTime: 0,
      star: false, transpose: 0, tempoMul: 1,
    };
    this._pendingMusic = null;
    this._lastEngine = { speed: 0, boosting: false, drifting: false };
  }

  get ready() { return !!this.ctx; }

  // ------------------------------------------------------------------ init

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        try { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
      }
      return;
    }
    try {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      if (ctx.state === 'suspended') {
        try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
      }

      // master chain: buses → compressor → master gain → destination
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 20;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.2;
      this.compressor.connect(this.master);
      this.master.connect(ctx.destination);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 1;
      this.sfxBus.connect(this.compressor);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.55;
      this.musicBus.connect(this.compressor);
      this.engineBus = ctx.createGain();
      this.engineBus.gain.value = 1;
      this.engineBus.connect(this.compressor);

      this.noiseBuffer = this._makeNoiseBuffer(2.0);
      this._buildEngine();

      if (this._pendingMusic) {
        const kind = this._pendingMusic;
        this._pendingMusic = null;
        this.startMusic(kind);
      }
    } catch (err) {
      console.warn('[audio] WebAudio unavailable:', err);
      this.ctx = null;
    }
  }

  _makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noiseSource(loop) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = !!loop;
    return src;
  }

  // ---------------------------------------------------------------- engine

  _buildEngine() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const e = {};

    e.filter = ctx.createBiquadFilter();
    e.filter.type = 'lowpass';
    e.filter.frequency.value = 400;
    e.filter.Q.value = 2;
    e.gain = ctx.createGain();
    e.gain.gain.value = 0;
    e.filter.connect(e.gain);
    e.gain.connect(this.engineBus);

    e.osc1 = ctx.createOscillator(); e.osc1.type = 'sawtooth'; e.osc1.frequency.value = 60;
    e.osc2 = ctx.createOscillator(); e.osc2.type = 'sawtooth'; e.osc2.frequency.value = 60; e.osc2.detune.value = 9;
    e.osc3 = ctx.createOscillator(); e.osc3.type = 'triangle'; e.osc3.frequency.value = 120;
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.45;
    const g3 = ctx.createGain(); g3.gain.value = 0.3;
    e.osc1.connect(g1); e.osc2.connect(g2); e.osc3.connect(g3);
    g1.connect(e.filter); g2.connect(e.filter); g3.connect(e.filter);

    // LFO wobble on the sawtooth pitch (engine "chug")
    e.lfo = ctx.createOscillator(); e.lfo.type = 'sine'; e.lfo.frequency.value = 7;
    e.lfoGain = ctx.createGain(); e.lfoGain.gain.value = 2.5;
    e.lfo.connect(e.lfoGain);
    e.lfoGain.connect(e.osc1.frequency);
    e.lfoGain.connect(e.osc2.frequency);

    // Wind / whoosh noise
    e.whoosh = this._noiseSource(true);
    e.whooshFilter = ctx.createBiquadFilter();
    e.whooshFilter.type = 'bandpass';
    e.whooshFilter.frequency.value = 500;
    e.whooshFilter.Q.value = 0.7;
    e.whooshGain = ctx.createGain(); e.whooshGain.gain.value = 0;
    e.whoosh.connect(e.whooshFilter); e.whooshFilter.connect(e.whooshGain); e.whooshGain.connect(this.engineBus);

    // Drift screech (gated filtered noise)
    e.screech = this._noiseSource(true);
    e.screechFilter = ctx.createBiquadFilter();
    e.screechFilter.type = 'bandpass';
    e.screechFilter.frequency.value = 2100;
    e.screechFilter.Q.value = 6;
    e.screechGain = ctx.createGain(); e.screechGain.gain.value = 0;
    e.screech.connect(e.screechFilter); e.screechFilter.connect(e.screechGain); e.screechGain.connect(this.engineBus);

    for (const s of [e.osc1, e.osc2, e.osc3, e.lfo, e.whoosh, e.screech]) s.start(now);
    this.engine = e;
  }

  setEngine(speedRatio, boosting, drifting) {
    const e = this.engine;
    if (!this.ctx || !e) return;
    const s = Math.max(0, Math.min(1.2, +speedRatio || 0));
    const t = this.ctx.currentTime;
    const on = this.engineEnabled && !this.paused;
    const base = 62 * (1 + 3 * s) * (boosting ? 1.2 : 1);

    e.osc1.frequency.setTargetAtTime(base, t, TAU_SMOOTH);
    e.osc2.frequency.setTargetAtTime(base * 1.01, t, TAU_SMOOTH);
    e.osc3.frequency.setTargetAtTime(base * 2, t, TAU_SMOOTH);
    e.lfo.frequency.setTargetAtTime(5 + 18 * s, t, TAU_SMOOTH);
    e.filter.frequency.setTargetAtTime(280 + 2600 * s + (boosting ? 900 : 0), t, TAU_SMOOTH);
    e.gain.gain.setTargetAtTime(on ? 0.12 + 0.12 * s : 0, t, TAU_SMOOTH);

    e.whooshFilter.frequency.setTargetAtTime(400 + 1900 * s, t, TAU_SMOOTH);
    e.whooshGain.gain.setTargetAtTime(on ? 0.02 + 0.16 * s + (boosting ? 0.12 : 0) : 0, t, TAU_SMOOTH);
    e.screechGain.gain.setTargetAtTime(on && drifting ? 0.07 + 0.05 * s : 0, t, TAU_SMOOTH);

    this._lastEngine.speed = s;
    this._lastEngine.boosting = !!boosting;
    this._lastEngine.drifting = !!drifting;
  }

  /** Extra (not in contract): silence the engine bed (menu / results screens). */
  setEngineEnabled(enabled) {
    this.engineEnabled = !!enabled;
    if (!this.ctx) return;
    const { speed, boosting, drifting } = this._lastEngine;
    this.setEngine(speed, boosting, drifting);
  }

  /** Extra (not in contract): pause → engine silent, music scheduler halts. */
  setPaused(paused) {
    paused = !!paused;
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.ctx) return;
    const { speed, boosting, drifting } = this._lastEngine;
    this.setEngine(speed, boosting, drifting);
    if (!paused && this.music.timer) {
      this.music.nextTime = this.ctx.currentTime + 0.05;
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, +v || 0));
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------- synth helpers

  /** Oscillator one-shot with attack/exponential-decay envelope and optional pitch glide. */
  _tone({ type = 'sine', freq = 440, freqEnd = null, glide = null, start = 0, dur = 0.2,
          gain = 0.2, attack = 0.005, dest = null, detune = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq), t0);
    if (detune) osc.detune.value = detune;
    if (freqEnd != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + (glide != null ? glide : dur));
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(dest || this.sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
    return osc;
  }

  /** Filtered noise burst. */
  _noise({ start = 0, dur = 0.2, gain = 0.3, filter = 'bandpass', freq = 1000, freqEnd = null, Q = 1,
           attack = 0.005, dest = null }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const src = this._noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(Math.max(10, freq), t0);
    if (freqEnd != null) f.frequency.exponentialRampToValueAtTime(Math.max(10, freqEnd), t0 + dur);
    f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest || this.sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  _chime(notes, spacing, dur, type = 'square', gain = 0.16) {
    notes.forEach((hz, i) => this._tone({ type, freq: hz, start: i * spacing, dur, gain }));
  }

  // ------------------------------------------------------------ one-shots

  play(name) {
    if (!this.ctx) return;
    try {
      const fn = this._sfx[name];
      if (fn) fn.call(this);
      else console.warn('[audio] unknown sfx', name);
    } catch (err) {
      console.warn('[audio] sfx failed', name, err);
    }
  }

  get _sfx() {
    return AudioManager.SFX;
  }

  // -------------------------------------------------------------- music

  startMusic(kind) {
    if (!this.ctx) { this._pendingMusic = kind; return; }
    const pattern = PATTERNS[kind];
    if (!pattern) return;
    this.stopMusic();
    const m = this.music;
    m.kind = kind;
    m.pattern = pattern;
    m.step = 0;
    m.nextTime = this.ctx.currentTime + 0.05;
    this._applyStar();
    m.timer = setInterval(() => this._schedulerTick(), TICK_MS);
    this._schedulerTick();
  }

  stopMusic() {
    const m = this.music;
    if (m.timer) clearInterval(m.timer);
    m.timer = 0;
    m.kind = null;
    m.pattern = null;
    this._pendingMusic = null;
  }

  setStarMusic(on) {
    on = !!on;
    if (this.music.star === on) return;
    this.music.star = on;
    this._applyStar();
  }

  _applyStar() {
    const m = this.music;
    const star = m.star && m.kind === 'race';
    m.transpose = star ? 5 : 0;
    m.tempoMul = star ? 1.22 : 1;
  }

  _schedulerTick() {
    const m = this.music;
    const ctx = this.ctx;
    if (!ctx || !m.pattern) return;
    if (this.paused) return;
    const p = m.pattern;
    const stepDur = 60 / (p.bpm * m.tempoMul) / 2; // 8th notes
    const total = Math.max(p.lead.length, p.bass.length);
    let guard = 0;
    while (m.nextTime < ctx.currentTime + LOOKAHEAD && guard++ < 32) {
      this._scheduleStep(m.step, m.nextTime, stepDur);
      m.nextTime += stepDur;
      m.step = (m.step + 1) % total;
    }
  }

  _scheduleStep(step, time, stepDur) {
    const m = this.music;
    const p = m.pattern;
    const start = time - this.ctx.currentTime;
    const release = p.release || 0;
    const dest = this.musicBus;

    const lead = p.lead[step % p.lead.length];
    if (lead) {
      const hz = midiHz(lead + m.transpose);
      this._tone({ type: p.leadType, freq: hz, start, dur: stepDur * 0.9 + release, gain: p.leadGain, attack: 0.01, dest });
      if (p.leadType === 'square') {
        // slight vibrato/detune layer for a richer chip lead
        this._tone({ type: 'square', freq: hz, start, dur: stepDur * 0.9 + release, gain: p.leadGain * 0.35, attack: 0.01, dest, detune: 8 });
      }
    }
    const bass = p.bass[step % p.bass.length];
    if (bass) {
      this._tone({ type: p.bassType, freq: midiHz(bass + m.transpose), start, dur: stepDur * 0.95 + release, gain: p.bassGain, attack: 0.005, dest });
    }
    const drum = p.drums[step % p.drums.length] || '';
    if (drum.includes('K')) {
      this._tone({ type: 'sine', freq: 150, freqEnd: 40, glide: 0.12, start, dur: 0.16, gain: 0.5, attack: 0.002, dest });
    }
    if (drum.includes('S')) {
      this._noise({ start, dur: 0.12, gain: 0.22, filter: 'bandpass', freq: 1800, Q: 0.8, dest });
    }
    if (drum.includes('H')) {
      this._noise({ start, dur: 0.04, gain: 0.08, filter: 'highpass', freq: 7000, Q: 0.5, dest });
    }
  }

  dispose() {
    this.stopMusic();
    if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (e) { /* ignore */ } }
    this.ctx = null;
    this.engine = null;
  }
}

// One-shot SFX definitions (this = AudioManager instance, ctx guaranteed present).
AudioManager.SFX = {
  hop() {
    this._tone({ type: 'square', freq: 320, freqEnd: 720, dur: 0.1, gain: 0.18 });
  },
  drift_tier1() { this._chime([660, 880], 0.07, 0.1, 'square', 0.14); },
  drift_tier2() { this._chime([880, 1175], 0.07, 0.1, 'square', 0.15); },
  drift_tier3() { this._chime([1175, 1568, 1976], 0.06, 0.12, 'square', 0.16); },
  boost() {
    this._noise({ dur: 0.5, gain: 0.3, filter: 'bandpass', freq: 400, freqEnd: 3200, Q: 1.2 });
    this._tone({ type: 'sine', freq: 200, freqEnd: 900, dur: 0.4, gain: 0.2 });
    this._tone({ type: 'sawtooth', freq: 100, freqEnd: 450, dur: 0.35, gain: 0.08 });
  },
  item_pickup() { this._chime([880, 1108, 1318], 0.07, 0.12, 'sine', 0.22); },
  item_roulette() {
    this._tone({ type: 'square', freq: 1200, dur: 0.03, gain: 0.1, attack: 0.002 });
  },
  shell_fire() {
    this._noise({ dur: 0.15, gain: 0.35, filter: 'highpass', freq: 900, Q: 0.7 });
    this._tone({ type: 'sine', freq: 130, freqEnd: 45, dur: 0.22, gain: 0.45 });
  },
  shell_hit() {
    this._noise({ dur: 0.22, gain: 0.4, filter: 'lowpass', freq: 1800, freqEnd: 300, Q: 1 });
    this._tone({ type: 'square', freq: 420, freqEnd: 90, dur: 0.28, gain: 0.22 });
  },
  banana() {
    this._tone({ type: 'square', freq: 900, freqEnd: 180, dur: 0.45, gain: 0.16 });
    this._tone({ type: 'sine', freq: 600, freqEnd: 120, dur: 0.45, gain: 0.14, start: 0.05 });
    this._tone({ type: 'triangle', freq: 300, freqEnd: 150, dur: 0.15, gain: 0.2, start: 0.45 });
  },
  star() { this._chime([784, 988, 1175, 1568, 1976], 0.06, 0.16, 'sine', 0.2); },
  lightning() {
    this._noise({ dur: 0.45, gain: 0.5, filter: 'highpass', freq: 2500, freqEnd: 600, Q: 0.6, attack: 0.002 });
    this._noise({ dur: 1.2, gain: 0.3, filter: 'lowpass', freq: 220, Q: 0.8, start: 0.08, attack: 0.05 });
    this._tone({ type: 'sine', freq: 55, freqEnd: 28, dur: 1.4, gain: 0.55, start: 0.06, attack: 0.03 });
  },
  bomb() {
    this._tone({ type: 'sine', freq: 70, freqEnd: 18, dur: 0.9, gain: 0.9, attack: 0.004 });
    this._noise({ dur: 0.7, gain: 0.6, filter: 'lowpass', freq: 900, freqEnd: 120, Q: 0.7, attack: 0.004 });
    this._noise({ dur: 0.25, gain: 0.3, filter: 'highpass', freq: 1500, Q: 0.5 });
  },
  countdown_beep() { this._tone({ type: 'sine', freq: 880, dur: 0.15, gain: 0.3 }); },
  countdown_go() {
    this._tone({ type: 'sine', freq: 1320, dur: 0.55, gain: 0.35 });
    this._tone({ type: 'square', freq: 1320, dur: 0.55, gain: 0.06 });
  },
  lap() { this._chime([784, 988, 1175], 0.11, 0.18, 'square', 0.16); },
  finish() {
    const notes = [659, 784, 988, 1175, 1568];
    notes.forEach((hz, i) => {
      const last = i === notes.length - 1;
      this._tone({ type: 'square', freq: hz, start: i * 0.14, dur: last ? 0.9 : 0.16, gain: 0.16 });
      this._tone({ type: 'triangle', freq: hz / 2, start: i * 0.14, dur: last ? 0.9 : 0.16, gain: 0.12 });
    });
  },
  wall() {
    this._tone({ type: 'sine', freq: 95, freqEnd: 38, dur: 0.16, gain: 0.5, attack: 0.003 });
    this._noise({ dur: 0.1, gain: 0.25, filter: 'lowpass', freq: 350, Q: 0.7 });
  },
  bump() {
    this._tone({ type: 'triangle', freq: 260, freqEnd: 110, dur: 0.14, gain: 0.35, attack: 0.002 });
    this._noise({ dur: 0.07, gain: 0.18, filter: 'bandpass', freq: 1400, Q: 1.2 });
  },
  menu() {
    this._tone({ type: 'square', freq: 1500, dur: 0.025, gain: 0.12, attack: 0.002 });
    this._tone({ type: 'sine', freq: 700, dur: 0.06, gain: 0.1, start: 0.01 });
  },
};
