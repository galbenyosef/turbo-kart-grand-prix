/**
 * ai.js — AIController: drives one kart by writing kart.input every frame.
 *
 *   const ai = new AIController(kart, track, { skill: 0.6 });   // skill 0..1
 *   ai.update(dt, karts, itemManager);   ai.reset();   ai.skill
 *
 * Behaviour: look-ahead racing line on track.curve (+ a slowly drifting lane offset so bots spread
 * out), throttle/brake by upcoming curvature, drifting through sharp corners (target mini-turbo tier
 * scales with skill), hazard + kart avoidance, sensible item use, rubber-banding to the player,
 * stuck / wrong-way recovery. Outputs zero input while `kart.locked` (countdown).
 *
 * Kart fields READ : position, yaw, speed, trackT, progress, lap, racePosition, item, isPlayer,
 *                    finished, locked, state.{stunTimer, spinTimer, driftTier, drifting, airborne}
 * Kart fields WRITTEN: input.{throttle, brake, steer, drift, useItem, lookBack}, aiSpeedFactor, rubberBoost
 *
 * Conventions: forward = (sin yaw, 0, cos yaw); right = forward × up = (-cos yaw, 0, sin yaw).
 * kart.js integrates `yaw -= steer * rate * dt`, i.e. POSITIVE steer turns RIGHT (yaw decreases);
 * a heading error `err = desiredYaw - yaw` therefore maps to `steer = -err * gain`.
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _tanNow = new THREE.Vector3();
const _tanFar = new THREE.Vector3();
const _right = new THREE.Vector3();

const LOOK_MIN = 10, LOOK_MAX = 28;
const CURVE_PROBE = 25;          // metres ahead used to measure upcoming turn angle
const HAZARD_RANGE = 25;
const KART_AVOID_RANGE = 6;
const STUCK_TIME = 1.5, REVERSE_TIME = 1.0;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap01 = (t) => t - Math.floor(t);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const progressOf = (k) => (Number.isFinite(k.progress) ? k.progress : (k.lap || 0) + (Number.isFinite(k.trackT) ? k.trackT : 0));

export class AIController {
  constructor(kart, track, { skill = 0.6 } = {}) {
    this.kart = kart;
    this.track = track;
    this.curve = track.curve;
    this.skill = clamp(Number.isFinite(skill) ? skill : 0.6, 0, 1);
    this.trackLength = track.length || (track.curve && track.curve.getLength && track.curve.getLength()) || 1000;
    this.reset();
  }

  reset() {
    this.laneOffset = rand(-3, 3);
    this.laneTarget = rand(-5, 5);
    this.laneTimer = rand(4, 8);
    this.lastT = 0;
    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.reverseSteer = 0;
    this.drifting = false;
    this.driftDir = 0;
    this.driftTime = 0;
    this.driftCooldown = 0;
    this.itemTimer = 0;
    this.itemDelay = rand(1, 3);
    this.lastItem = null;
    this.band = 1;
    const k = this.kart;
    if (k) {
      k.aiSpeedFactor = 1;
      k.rubberBoost = false;
      if (k.input) { k.input.throttle = 0; k.input.brake = 0; k.input.steer = 0; k.input.drift = false; k.input.useItem = false; k.input.lookBack = false; }
    }
  }

  /** Unit tangent of the (closed) curve at arc-length parameter u, written into target. Allocation-free. */
  _tangentAt(u, target) {
    const d = 0.0005;
    this.curve.getPointAt(wrap01(u + d), target);
    this.curve.getPointAt(wrap01(u - d), _q);
    target.sub(_q);
    const len = target.length();
    if (len < 1e-9) target.set(0, 0, 1); else target.multiplyScalar(1 / len);
    return target;
  }

  update(dt, karts = [], itemManager = null) {
    const k = this.kart;
    const input = k.input || (k.input = { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false });
    input.useItem = false;
    input.lookBack = false;

    if (k.locked) {
      input.throttle = 0; input.brake = 0; input.steer = 0; input.drift = false;
      this.drifting = false;
      this.stuckTimer = 0;
      this.reverseTimer = 0;
      return;
    }
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    const st = k.state || {};
    const stunned = st.stunTimer > 0 || st.spinTimer > 0;
    const speed = k.speed || 0;
    const pos = k.position;
    const L = this.trackLength;
    const skill = this.skill;

    // ---- where am I on the track
    const hint = Number.isFinite(k.trackT) ? k.trackT : this.lastT;
    const info = typeof this.track.getRoadInfo === 'function' ? this.track.getRoadInfo(pos, hint) : null;
    const t = info && Number.isFinite(info.t) ? info.t : hint;
    const lateral = info && Number.isFinite(info.lateral) ? info.lateral : 0;
    const onRoad = info ? info.onRoad !== false : true;
    this.lastT = t;
    const tanNow = info && info.tangent ? info.tangent : this._tangentAt(t, _tanNow);

    // ---- racing line: look-ahead point + lane offset
    const lookDist = clamp(LOOK_MIN + Math.max(0, speed) * 0.35, LOOK_MIN, LOOK_MAX);
    const tAhead = wrap01(t + lookDist / L);
    this.curve.getPointAt(tAhead, _p);
    this._tangentAt(tAhead, _tan);
    _right.crossVectors(_tan, UP).normalize();
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) { this.laneTarget = rand(-5, 5); this.laneTimer = rand(4, 8); }
    this.laneOffset = lerp(this.laneOffset, this.laneTarget, 1 - Math.exp(-dt * 0.6));
    const targetX = _p.x + _right.x * this.laneOffset;
    const targetZ = _p.z + _right.z * this.laneOffset;

    const dx = targetX - pos.x, dz = targetZ - pos.z;
    const err = wrapAngle(Math.atan2(dx, dz) - k.yaw);
    let steer = clamp(-err * (2.2 + 0.4 * skill), -1, 1);

    // ---- upcoming curvature (signed: + = left / yaw increasing); turnSteer is the same in steer sign (+ = right)
    this._tangentAt(wrap01(t + CURVE_PROBE / L), _tanFar);
    const turn = Math.atan2(tanNow.z * _tanFar.x - tanNow.x * _tanFar.z, tanNow.x * _tanFar.x + tanNow.z * _tanFar.z);
    const turnSteer = -turn;
    const absTurn = Math.abs(turn);

    // ---- throttle / brake
    let throttle = 0.9 + 0.1 * skill;
    let brake = 0;
    const slowThr = 0.5 + 0.35 * skill;
    const brakeThr = 0.9 + 0.5 * skill;
    if (absTurn > brakeThr && speed > 24) { throttle = 0.3; brake = 0.5; }
    else if (absTurn > slowThr && speed > 18) { throttle = 0.6; }

    // ---- drift
    const targetTier = skill < 0.4 ? 1 : skill < 0.75 ? 2 : 3;
    let drift = false;
    if (this.drifting) {
      this.driftTime += dt;
      const tier = st.driftTier || 0;
      const overRotated = Math.sign(-err) !== this.driftDir && Math.abs(err) > 0.35;
      const release = absTurn < 0.12 || tier >= targetTier || speed < 8 || this.driftTime > 4.5 || stunned
        || overRotated || (st.drifting === false && this.driftTime > 0.6);
      if (release) {
        this.drifting = false;
        this.driftCooldown = 0.5;
      } else {
        drift = true;
        // keep a steering component in the drift direction (steering against it only widens the arc)
        steer = Math.sign(-err) === this.driftDir ? this.driftDir * clamp(Math.abs(err) * 2.2, 0.2, 1) : this.driftDir * 0.2;
      }
    } else {
      this.driftCooldown -= dt;
      if (this.driftCooldown <= 0 && absTurn > 0.35 && speed > 15 && Math.abs(steer) > 0.3
          && Math.sign(steer) === Math.sign(turnSteer) && !stunned && !st.airborne) {
        this.drifting = true;
        this.driftDir = Math.sign(turnSteer);
        this.driftTime = 0;
        drift = true;
      }
    }

    // ---- avoidance (hazards ahead + karts directly ahead)
    const fwdX = Math.sin(k.yaw), fwdZ = Math.cos(k.yaw);
    const rightX = -fwdZ, rightZ = fwdX;
    let bias = 0;
    const hazards = itemManager && itemManager.hazards;
    if (hazards) {
      for (let i = 0; i < hazards.length; i++) {
        const h = hazards[i];
        if (!h || !h.position) continue;
        if (h.owner === k && h.type !== 'banana') continue; // our own shell flying away
        const rx = h.position.x - pos.x, rz = h.position.z - pos.z;
        const ahead = rx * fwdX + rz * fwdZ;
        if (ahead <= 0 || ahead > HAZARD_RANGE) continue;
        const side = rx * rightX + rz * rightZ;
        const width = 2.5 + (h.radius || 0.6);
        if (Math.abs(side) >= width) continue;
        const dir = side > 0.05 ? -1 : side < -0.05 ? 1 : (lateral > 0 ? -1 : 1); // obstacle on the right → steer left (negative)
        bias += dir * (1 - ahead / HAZARD_RANGE) * (1 - Math.abs(side) / width) * 1.2;
      }
    }
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === k) continue;
      const rx = o.position.x - pos.x, rz = o.position.z - pos.z;
      const ahead = rx * fwdX + rz * fwdZ;
      if (ahead <= 0 || ahead > KART_AVOID_RANGE) continue;
      const side = rx * rightX + rz * rightZ;
      if (Math.abs(side) >= 1.8) continue;
      const dir = side > 0.05 ? 1 : side < -0.05 ? -1 : (lateral > 0 ? 1 : -1);
      bias += dir * (1 - ahead / KART_AVOID_RANGE) * 0.5;
    }
    if (bias !== 0) steer = clamp(steer + bias, -1, 1);

    // ---- wrong-way recovery
    const tanDot = fwdX * tanNow.x + fwdZ * tanNow.z;
    if (tanDot < -0.3 && !stunned) {
      steer = err >= 0 ? -1 : 1; // need yaw to increase → turn left → negative steer
      throttle = 0.6;
      brake = 0;
      drift = false;
      this.drifting = false;
    }

    // ---- rubber-banding vs the player
    const cap = this._rubberBand(k, karts, dt);
    if (cap < throttle) throttle = cap;

    // ---- stuck recovery (reverse briefly with opposite steer)
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      input.throttle = 0;
      input.brake = 1;
      input.steer = this.reverseSteer;
      input.drift = false;
      this.drifting = false;
      return;
    }
    if (speed < 2 && input.throttle > 0 && !stunned) this.stuckTimer += dt; else this.stuckTimer = 0;
    if (this.stuckTimer > STUCK_TIME) {
      this.stuckTimer = 0;
      this.reverseTimer = REVERSE_TIME;
      // kart.js flips turn direction while reversing, so steering "opposite" (right when the target is
      // on the left) swings the nose toward the target as we back up
      this.reverseSteer = err >= 0 ? 1 : -1;
    }

    // ---- items (never after finishing)
    this._decideItem(k, karts, input, dt, absTurn, onRoad, fwdX, fwdZ, stunned);

    if (stunned) { throttle = 0; brake = 0; steer = 0; drift = false; this.drifting = false; }
    input.throttle = throttle;
    input.brake = brake;
    input.steer = steer;
    input.drift = drift;
  }

  /** Sets kart.aiSpeedFactor / kart.rubberBoost; returns a throttle cap. */
  _rubberBand(k, karts, dt) {
    let player = null;
    for (let i = 0; i < karts.length; i++) if (karts[i].isPlayer) { player = karts[i]; break; }
    const smooth = 1 - Math.exp(-dt * 0.5);
    if (!player || player === k || k.finished) {
      this.band = lerp(this.band, 1, smooth);
      k.aiSpeedFactor = this.band;
      k.rubberBoost = false;
      return 1;
    }
    const gap = progressOf(player) - progressOf(k); // > 0: bot is behind the player (laps)
    let cap = 1;
    if (gap > 0.08) this.band = 1.06;
    else if (gap < -0.10) { this.band = 0.94; cap = 0.85; }
    else this.band = lerp(this.band, 1, smooth);
    k.aiSpeedFactor = this.band;
    k.rubberBoost = gap > 0.08;
    return cap;
  }

  _decideItem(k, karts, input, dt, absTurn, onRoad, fwdX, fwdZ, stunned) {
    if (!k.item || k.finished || stunned) {
      this.itemTimer = 0;
      this.lastItem = k.item || null;
      return;
    }
    if (k.item !== this.lastItem) {
      this.lastItem = k.item;
      this.itemTimer = 0;
      this.itemDelay = rand(1, 3) + (1 - this.skill) * 0.8;
    }
    this.itemTimer += dt;
    const T = this.itemTimer;
    const pos = k.position;
    let aheadNear = false, aheadBomb = false, behindClose = false;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === k) continue;
      const rx = o.position.x - pos.x, rz = o.position.z - pos.z;
      const dist = Math.sqrt(rx * rx + rz * rz);
      if (dist < 1e-3) continue;
      const dot = (rx * fwdX + rz * fwdZ) / dist;
      if (dot > 0.9 && dist < 30) aheadNear = true;
      if (dot > 0.8 && dist >= 8 && dist <= 25) aheadBomb = true;
      if (dot < -0.5 && dist < 8) behindClose = true;
    }
    let use = false;
    switch (k.item) {
      case 'mushroom':
      case 'triple_mushroom':
        use = T > 0.3 && (absTurn < 0.25 || !onRoad);
        break;
      case 'green_shell':
        use = (T > 0.2 && aheadNear) || T > 3;
        break;
      case 'red_shell':
        use = (T > 0.4 && k.racePosition > 1) || T > 3;
        break;
      case 'banana':
        use = (T > 0.2 && behindClose) || T > 6; // lookBack stays false → dropped behind
        break;
      case 'star':
      case 'lightning':
        use = T > this.itemDelay;
        break;
      case 'bomb':
        use = (T > this.itemDelay && aheadBomb) || T > 8;
        break;
      default:
        use = T > 3;
    }
    if (use) {
      input.useItem = true;   // one-frame pulse; main.js calls itemManager.tryUse(kart, karts)
      input.lookBack = false;
      this.itemTimer = 0;
    }
  }
}
