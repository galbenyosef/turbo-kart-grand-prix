// src/input.js
// Turbo Kart Grand Prix — keyboard + gamepad input with a smooth analog steering ramp.
//
//   const input = new Input();     // attaches listeners (window); safe to construct without a DOM
//   input.update();                // once per frame: polls the gamepad, ramps steering, refreshes state
//   input.state → { throttle, brake, steer, drift, useItem, lookBack, pause, confirm, restart }
//   input.consumeUseItem() / consumeConfirm() / consumeRestart() / consumePause()  — true once per press
//   input.anyKeyPressed            // true for exactly one update() after any key / button / pointer press
//   input.dispose()                // removes listeners
//
// Keys: Arrow keys / WASD steer + throttle, Down/S brake (reverse when stopped), Shift or Space =
// drift/hop, Ctrl / E / Enter / X = use item, Enter = confirm, R = restart, P / Esc = pause, Q = look back.
// Gamepad (standard mapping): left stick / d-pad steer, RT or A throttle, LT or B brake, RB/LB drift,
// X/Y use item, Start pause + confirm, Back look back.

const KEYS = {
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  drift: ['ShiftLeft', 'ShiftRight', 'Space'],
  useItem: ['ControlLeft', 'ControlRight', 'KeyE', 'Enter', 'NumpadEnter', 'KeyX'],
  confirm: ['Enter', 'NumpadEnter'],
  restart: ['KeyR'],
  pause: ['KeyP', 'Escape'],
  lookBack: ['KeyQ'],
};

// Keys whose browser default (page scroll) must be suppressed while playing.
const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

// Standard-mapping gamepad buttons
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, DPAD_LEFT: 14, DPAD_RIGHT: 15 };
const STICK_DEADZONE = 0.15;

const STEER_RAMP_IN = 8;   // units/s toward a non-zero target
const STEER_RAMP_OUT = 10; // units/s back toward centre

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const moveToward = (v, target, maxDelta) =>
  Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta;

export class Input {
  /** @param {EventTarget} [target] defaults to window when available. */
  constructor(target) {
    this.state = {
      throttle: 0, brake: 0, steer: 0,
      drift: false, useItem: false, lookBack: false, pause: false, confirm: false, restart: false,
    };
    this.anyKeyPressed = false;
    this.gamepadConnected = false;

    this._keys = new Set();           // currently held KeyboardEvent.code values
    this._latched = { useItem: false, confirm: false, restart: false, pause: false };
    this._anyLatch = false;
    this._steer = 0;
    this._padPrev = {};               // previous gamepad button states (edge detection)
    this._lastTime = now();
    this._target = target ?? (typeof window !== 'undefined' ? window : null);

    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onBlur = () => this._releaseAll();
    this._onPointerDown = () => { this._anyLatch = true; };
    this._onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) this._releaseAll();
    };

    const t = this._target;
    if (t && typeof t.addEventListener === 'function') {
      t.addEventListener('keydown', this._onKeyDown);
      t.addEventListener('keyup', this._onKeyUp);
      t.addEventListener('blur', this._onBlur);
      t.addEventListener('pointerdown', this._onPointerDown);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  // ------------------------------------------------------------------ keyboard
  _keyDown(e) {
    const code = e.code || e.key;
    if (!code) return;
    if (PREVENT_DEFAULT.has(code) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
    if (e.repeat) return; // held: already in the set, no new edge
    if (!this._keys.has(code)) {
      this._keys.add(code);
      this._anyLatch = true;
      if (KEYS.useItem.includes(code)) this._latched.useItem = true;
      if (KEYS.confirm.includes(code)) this._latched.confirm = true;
      if (KEYS.restart.includes(code)) this._latched.restart = true;
      if (KEYS.pause.includes(code)) this._latched.pause = true;
    }
  }

  _keyUp(e) {
    const code = e.code || e.key;
    if (code) this._keys.delete(code);
  }

  _releaseAll() {
    this._keys.clear();
  }

  _held(list) {
    for (let i = 0; i < list.length; i++) if (this._keys.has(list[i])) return true;
    return false;
  }

  // ------------------------------------------------------------------ gamepad
  _pollGamepad() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    let pads;
    try { pads = navigator.getGamepads(); } catch { return null; }
    if (!pads) return null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected !== false && p.buttons && p.buttons.length >= 10) return p;
    }
    return null;
  }

  /** 0..1 button value; analog triggers keep their value, digital buttons read 0/1. */
  _padButton(pad, i) {
    const b = pad.buttons[i];
    if (!b) return 0;
    if (typeof b === 'object') {
      if (typeof b.value === 'number' && b.value > 0) return clamp(b.value, 0, 1);
      return b.pressed ? 1 : 0;
    }
    return b > 0.5 ? 1 : 0;
  }

  _padEdge(name, pressed) {
    const was = !!this._padPrev[name];
    this._padPrev[name] = pressed;
    return pressed && !was;
  }

  // ------------------------------------------------------------------ per-frame
  /** @param {number} [dt] seconds since the last update; measured from the clock when omitted. */
  update(dt) {
    const t = now();
    if (!Number.isFinite(dt)) dt = (t - this._lastTime) / 1000;
    this._lastTime = t;
    dt = clamp(dt, 0, 0.1);

    // keyboard
    let throttle = this._held(KEYS.throttle) ? 1 : 0;
    let brake = this._held(KEYS.brake) ? 1 : 0;
    let steerTarget = (this._held(KEYS.right) ? 1 : 0) - (this._held(KEYS.left) ? 1 : 0);
    let drift = this._held(KEYS.drift);
    let useItem = this._held(KEYS.useItem);
    let lookBack = this._held(KEYS.lookBack);
    let pause = this._held(KEYS.pause);
    let confirm = this._held(KEYS.confirm);
    let restart = this._held(KEYS.restart);
    let analogSteer = null;

    // gamepad
    const pad = this._pollGamepad();
    this.gamepadConnected = !!pad;
    if (pad) {
      const rawX = pad.axes && pad.axes.length ? pad.axes[0] : 0;
      if (Number.isFinite(rawX) && Math.abs(rawX) > STICK_DEADZONE) {
        analogSteer = Math.sign(rawX) * clamp((Math.abs(rawX) - STICK_DEADZONE) / (1 - STICK_DEADZONE), 0, 1);
      }
      const dpad = (this._padButton(pad, PAD.DPAD_RIGHT) > 0.5 ? 1 : 0) - (this._padButton(pad, PAD.DPAD_LEFT) > 0.5 ? 1 : 0);
      if (dpad !== 0) analogSteer = dpad;

      throttle = Math.max(throttle, clamp(this._padButton(pad, PAD.RT), 0, 1), this._padButton(pad, PAD.A) > 0.5 ? 1 : 0);
      brake = Math.max(brake, clamp(this._padButton(pad, PAD.LT), 0, 1), this._padButton(pad, PAD.B) > 0.5 ? 1 : 0);
      drift = drift || this._padButton(pad, PAD.RB) > 0.5 || this._padButton(pad, PAD.LB) > 0.5;
      const item = this._padButton(pad, PAD.X) > 0.5 || this._padButton(pad, PAD.Y) > 0.5;
      const start = this._padButton(pad, PAD.START) > 0.5;
      const back = this._padButton(pad, PAD.BACK) > 0.5;
      useItem = useItem || item;
      pause = pause || start;
      confirm = confirm || start;
      lookBack = lookBack || back;
      if (this._padEdge('item', item)) { this._latched.useItem = true; this._anyLatch = true; }
      if (this._padEdge('start', start)) { this._latched.pause = true; this._latched.confirm = true; this._anyLatch = true; }
      if (this._padEdge('any', throttle > 0.5 || drift || item || start || back)) this._anyLatch = true;
    }

    // steering: analog is direct (lightly smoothed); keys ramp in at 8/s and recentre at 10/s
    if (analogSteer !== null) {
      this._steer += (analogSteer - this._steer) * Math.min(1, 20 * dt);
    } else {
      const rate = steerTarget !== 0 ? STEER_RAMP_IN : STEER_RAMP_OUT;
      this._steer = moveToward(this._steer, steerTarget, rate * dt);
    }
    if (Math.abs(this._steer) < 1e-4) this._steer = 0;

    const s = this.state;
    s.throttle = throttle;
    s.brake = brake;
    s.steer = clamp(this._steer, -1, 1);
    s.drift = drift;
    s.useItem = useItem;
    s.lookBack = lookBack;
    s.pause = pause;
    s.confirm = confirm;
    s.restart = restart;

    this.anyKeyPressed = this._anyLatch;
    this._anyLatch = false;
    return s;
  }

  // ------------------------------------------------------------------ edge consumers
  consumeUseItem() { const v = this._latched.useItem; this._latched.useItem = false; return v; }
  /** Enter is both confirm and use-item: consuming the confirm also drops that press's item edge. */
  consumeConfirm() {
    const v = this._latched.confirm;
    if (v) { this._latched.confirm = false; this._latched.useItem = false; }
    return v;
  }
  consumeRestart() { const v = this._latched.restart; this._latched.restart = false; return v; }
  consumePause() { const v = this._latched.pause; this._latched.pause = false; return v; }

  /** Drop any pending edges (e.g. when leaving a menu so a held Enter doesn't fire twice). */
  clearEdges() {
    this._latched.useItem = this._latched.confirm = this._latched.restart = this._latched.pause = false;
    this._anyLatch = false;
  }

  dispose() {
    const t = this._target;
    if (t && typeof t.removeEventListener === 'function') {
      t.removeEventListener('keydown', this._onKeyDown);
      t.removeEventListener('keyup', this._onKeyUp);
      t.removeEventListener('blur', this._onBlur);
      t.removeEventListener('pointerdown', this._onPointerDown);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    }
    this._releaseAll();
    this.clearEdges();
  }
}
