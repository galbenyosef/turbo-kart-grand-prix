/**
 * particles.js — pooled point-sprite particle system.
 *
 * Two THREE.Points objects share a 6000-particle budget:
 *   • sparks  (additive blending)  — drift sparks, boost fire, explosion embers, pops
 *   • smoke   (normal blending)    — dust, smoke puffs, confetti
 * Particles are integrated on the CPU into Float32Array attributes (position, colour,
 * size, alpha) and uploaded each frame. All hot loops are allocation-free.
 *
 * API (see ARCHITECTURE.md):
 *   emitDrift(position, tier, right)  emitBoost(position, dir, power)  emitDust(position)
 *   emitExplosion(position)           emitPop(position, color)         emitConfetti(position, floorY?)
 *   update(dt)                        activeCount (getter)             setViewport(heightPx, fovDeg, pixelRatio)
 */
import * as THREE from 'three';

const GRAVITY = -14;             // m/s², applied scaled by each particle's gravity factor
const SPARK_CAPACITY = 3600;
const SMOKE_CAPACITY = 2400;     // total pool = 6000
const MAX_SHOCKWAVES = 4;
const DEFAULT_POINT_SCALE = 700; // ≈ viewport height / (2·tan(fov/2)) for a ~850 px tall 60° view
const NO_FLOOR = -1e9;

const rand = (a, b) => a + Math.random() * (b - a);
const _color = new THREE.Color();

const VERT = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 pColor;
  uniform float uPointScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = pColor;
    vAlpha = alpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.5, -mvPosition.z);
    gl_PointSize = clamp(size * uPointScale / dist, 0.0, 220.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAG = /* glsl */ `
  uniform float uSoftness;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float a = (1.0 - smoothstep(1.0 - uSoftness, 1.0, d)) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** One pooled THREE.Points with CPU-side simulation state. */
class ParticlePool {
  constructor(scene, capacity, additive, softness, name) {
    this.capacity = capacity;
    this.count = 0;
    this._cursor = 0; // overwrite cursor used when the pool is full

    const n = capacity;
    this.pos = new Float32Array(n * 3);   // GPU
    this.col = new Float32Array(n * 3);   // GPU (linear rgb)
    this.size = new Float32Array(n);      // GPU (world metres)
    this.alpha = new Float32Array(n);     // GPU
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    this.grav = new Float32Array(n);      // gravity factor (0 = none, 1 = full, <0 = buoyant)
    this.drag = new Float32Array(n);      // 1/s
    this.floor = new Float32Array(n);     // y below which the particle bounces/settles

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('pColor', this.colAttr);
    geo.setAttribute('size', this.sizeAttr);
    geo.setAttribute('alpha', this.alphaAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPointScale: { value: DEFAULT_POINT_SCALE },
        uSoftness: { value: softness },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 1001 : 1000; // smoke first, sparks on top
    this.points.name = name;
    scene.add(this.points);
  }

  /** Spawn one particle. Positional args keep this allocation-free. */
  spawn(px, py, pz, vx, vy, vz, r, g, b, size0, size1, life, alpha, gravity, drag, floor) {
    let i;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this._cursor;
      this._cursor = (this._cursor + 1) % this.capacity;
    }
    const i3 = i * 3;
    this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.size[i] = size0;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.alpha[i] = 0;
    this.alpha0[i] = alpha;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.floor[i] = floor;
  }

  _move(from, to) {
    const f3 = from * 3, t3 = to * 3;
    this.pos[t3] = this.pos[f3]; this.pos[t3 + 1] = this.pos[f3 + 1]; this.pos[t3 + 2] = this.pos[f3 + 2];
    this.vel[t3] = this.vel[f3]; this.vel[t3 + 1] = this.vel[f3 + 1]; this.vel[t3 + 2] = this.vel[f3 + 2];
    this.col[t3] = this.col[f3]; this.col[t3 + 1] = this.col[f3 + 1]; this.col[t3 + 2] = this.col[f3 + 2];
    this.size[to] = this.size[from];
    this.alpha[to] = this.alpha[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.alpha0[to] = this.alpha0[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
    this.floor[to] = this.floor[from];
  }

  update(dt) {
    const pos = this.pos, vel = this.vel, life = this.life, maxLife = this.maxLife;
    const size = this.size, size0 = this.size0, size1 = this.size1;
    const alpha = this.alpha, alpha0 = this.alpha0, grav = this.grav, drag = this.drag, floor = this.floor;
    let n = this.count;
    let i = 0;
    while (i < n) {
      const l = life[i] - dt;
      if (l <= 0) {
        // dead: swap the last live particle into this slot and re-process the slot
        n--;
        if (i !== n) this._move(n, i);
        continue;
      }
      life[i] = l;
      const i3 = i * 3;
      const g = grav[i];
      if (g !== 0) vel[i3 + 1] += GRAVITY * g * dt;
      const d = drag[i];
      if (d !== 0) {
        const k = 1 / (1 + d * dt);
        vel[i3] *= k; vel[i3 + 1] *= k; vel[i3 + 2] *= k;
      }
      let y = pos[i3 + 1] + vel[i3 + 1] * dt;
      const fl = floor[i];
      if (y < fl) {
        y = fl;
        if (vel[i3 + 1] < 0) { vel[i3 + 1] *= -0.35; vel[i3] *= 0.6; vel[i3 + 2] *= 0.6; }
      }
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] = y;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      const f = l / maxLife[i];              // remaining fraction 1 → 0
      size[i] = size1[i] + (size0[i] - size1[i]) * f;
      const age = 1 - f;
      const fadeIn = age < 0.1 ? age * 10 : 1; // quick fade-in avoids popping
      alpha[i] = alpha0[i] * fadeIn * f;
      i++;
    }
    this.count = n;
    this.geometry.setDrawRange(0, n);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(scene) {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Converts a hex colour to a linear-rgb triplet (matches MeshStandardMaterial colour handling). */
function lin(hex) {
  _color.setHex(hex);
  return [_color.r, _color.g, _color.b];
}

export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this.sparks = new ParticlePool(scene, SPARK_CAPACITY, true, 0.6, 'particles-sparks');
    this.smoke = new ParticlePool(scene, SMOKE_CAPACITY, false, 0.5, 'particles-smoke');

    // Pre-converted palettes (linear rgb) so emit calls do no colour maths.
    this.pal = {
      dust: lin(0xcfcfcf),
      tier: [lin(0xcfcfcf), lin(0x4fc3ff), lin(0xffa726), lin(0xea80fc)],
      white: lin(0xffffff),
      fire: [lin(0xffee58), lin(0xffa000), lin(0xff6d00), lin(0xf4511e)],
      boostSmoke: lin(0x8d8d8d),
      tan: [lin(0xc9a86a), lin(0xb5945a), lin(0xd7bc8a)],
      ember: [lin(0xff7a00), lin(0xffd740), lin(0xffffff), lin(0xff3d00)],
      dark: [lin(0x3a3a3a), lin(0x555555), lin(0x2a2a2a)],
      confetti: [lin(0xff1744), lin(0x2979ff), lin(0xffea00), lin(0x00e676), lin(0xf50057), lin(0x00e5ff), lin(0xffffff), lin(0xff9100)],
    };

    // Shockwave pool (ring + fireball) used by emitExplosion.
    this._waves = [];
    this._ringGeo = new THREE.RingGeometry(0.72, 1, 48);
    this._ballGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const ring = new THREE.Mesh(this._ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffb74d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      ring.frustumCulled = false;
      const ball = new THREE.Mesh(this._ballGeo, new THREE.MeshBasicMaterial({
        color: 0xff9100, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      ball.visible = false;
      ball.frustumCulled = false;
      scene.add(ring);
      scene.add(ball);
      this._waves.push({ ring, ball, t: 0, active: false });
    }
  }

  /** Total live particles across both pools. */
  get activeCount() { return this.sparks.count + this.smoke.count; }

  /**
   * Makes point sizes match world metres for the current viewport.
   * Call on resize: particles.setViewport(renderer.domElement.clientHeight, camera.fov, renderer.getPixelRatio()).
   */
  setViewport(heightPx, fovDeg = 60, pixelRatio = 1) {
    const s = (heightPx * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5));
    this.sparks.material.uniforms.uPointScale.value = s;
    this.smoke.material.uniforms.uPointScale.value = s;
  }

  // ---------------------------------------------------------------- emitters

  /** Sparks at a rear wheel. tier 0 = grey dust puffs, 1 blue, 2 orange, 3 magenta (+ white hot ones). */
  emitDrift(position, tier, right) {
    const px = position.x, py = position.y, pz = position.z;
    const rx = right ? right.x : 1, rz = right ? right.z : 0;
    // right = forward × up  ⇒  forward = (rz, 0, -rx), backward = (-rz, 0, rx)
    const bx = -rz, bz = rx;
    const n = 3 + ((Math.random() * 3) | 0);
    if (!(tier > 0)) {
      // uncharged drift: a light, low tyre-smoke haze (emitted ~60×/s per wheel, so keep it sparse)
      const c = this.pal.dust;
      const nd = 1 + ((Math.random() * 2) | 0);
      for (let i = 0; i < nd; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const s = rand(1.5, 3.5), b = rand(1, 3);
        this.smoke.spawn(
          px + rand(-0.12, 0.12), py + 0.06, pz + rand(-0.12, 0.12),
          rx * side * s + bx * b + rand(-0.5, 0.5), rand(0.8, 2.0), rz * side * s + bz * b + rand(-0.5, 0.5),
          c[0], c[1], c[2], 0.3, 0.75, rand(0.3, 0.45), 0.28, 0.3, 2.5, py - 0.05);
      }
      return;
    }
    const pal = this.pal.tier[Math.min(3, tier | 0)];
    const white = this.pal.white;
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const s = rand(3, 6), b = rand(2, 5);
      const c = (tier >= 3 && Math.random() < 0.35) ? white : pal;
      this.sparks.spawn(
        px, py + 0.05, pz,
        rx * side * s + bx * b + rand(-1, 1), rand(1.5, 4), rz * side * s + bz * b + rand(-1, 1),
        c[0], c[1], c[2], rand(0.16, 0.26), 0, rand(0.3, 0.5), 1, 1, 0.5, py - 0.02);
    }
  }

  /** Fire trail behind an exhaust. dir = direction the flame travels (usually kart backward). */
  emitBoost(position, dir, power = 1) {
    const px = position.x, py = position.y, pz = position.z;
    const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : -1;
    const n = 6 + ((Math.random() * 5) | 0);
    const fire = this.pal.fire;
    for (let i = 0; i < n; i++) {
      const c = fire[(Math.random() * fire.length) | 0];
      const sp = rand(8, 14) * power;
      this.sparks.spawn(
        px + rand(-0.08, 0.08), py + rand(-0.08, 0.08), pz + rand(-0.08, 0.08),
        dx * sp + rand(-1.5, 1.5), dy * sp + rand(-0.8, 1.2), dz * sp + rand(-1.5, 1.5),
        c[0], c[1], c[2], rand(0.28, 0.5) * power, 0, rand(0.25, 0.45), 1, 0, 2.5, NO_FLOOR);
    }
    const m = 1 + ((Math.random() * 2) | 0);
    const g = this.pal.boostSmoke;
    for (let i = 0; i < m; i++) {
      const sp = rand(2, 4);
      this.smoke.spawn(
        px, py, pz,
        dx * sp + rand(-0.6, 0.6), dy * sp + rand(0.5, 1.5), dz * sp + rand(-0.6, 0.6),
        g[0], g[1], g[2], 0.3, 1.2, rand(0.4, 0.7), 0.4, -0.05, 1.5, NO_FLOOR);
    }
  }

  /** Off-road dust puffs. */
  emitDust(position) {
    const px = position.x, py = position.y, pz = position.z;
    const n = 2 + ((Math.random() * 3) | 0);
    const tan = this.pal.tan;
    for (let i = 0; i < n; i++) {
      const c = tan[(Math.random() * tan.length) | 0];
      const a = Math.random() * Math.PI * 2, sp = rand(0.5, 2);
      this.smoke.spawn(
        px + rand(-0.3, 0.3), py + 0.1, pz + rand(-0.3, 0.3),
        Math.cos(a) * sp, rand(0.5, 1.5), Math.sin(a) * sp,
        c[0], c[1], c[2], rand(0.35, 0.55), rand(1.0, 1.5), rand(0.6, 1.0), 0.42, 0, 1.5, py - 0.05);
    }
  }

  /** Bomb explosion: 120 embers, 40 smoke puffs, expanding shockwave ring + fireball. */
  emitExplosion(position) {
    const px = position.x, py = position.y, pz = position.z;
    const ember = this.pal.ember, dark = this.pal.dark;
    for (let i = 0; i < 120; i++) {
      const c = ember[(Math.random() * ember.length) | 0];
      const y = rand(-0.2, 1), s = Math.sqrt(Math.max(0, 1 - y * y)), a = Math.random() * Math.PI * 2;
      const sp = rand(6, 22);
      this.sparks.spawn(
        px, py + 0.3, pz,
        Math.cos(a) * s * sp, y * sp, Math.sin(a) * s * sp,
        c[0], c[1], c[2], rand(0.3, 0.6), 0, rand(0.5, 1.1), 1, 1, 1.0, py - 0.1);
    }
    for (let i = 0; i < 40; i++) {
      const c = dark[(Math.random() * dark.length) | 0];
      const y = rand(0.2, 1), s = Math.sqrt(Math.max(0, 1 - y * y)), a = Math.random() * Math.PI * 2;
      const sp = rand(2, 8);
      this.smoke.spawn(
        px + rand(-0.5, 0.5), py + 0.4, pz + rand(-0.5, 0.5),
        Math.cos(a) * s * sp, y * sp, Math.sin(a) * s * sp,
        c[0], c[1], c[2], rand(0.8, 1.5), rand(3.5, 5.5), rand(0.9, 1.6), rand(0.6, 0.85), -0.08, 1.2, py - 0.2);
    }
    this._startShockwave(px, py, pz);
  }

  /** Item-box burst / pickup: 24 coloured sparks + a few white. */
  emitPop(position, color = 0xffffff) {
    const px = position.x, py = position.y, pz = position.z;
    _color.set(color);
    const r = _color.r, g = _color.g, b = _color.b;
    const w = this.pal.white;
    for (let i = 0; i < 30; i++) {
      const white = i >= 24;
      const y = rand(-1, 1), s = Math.sqrt(Math.max(0, 1 - y * y)), a = Math.random() * Math.PI * 2;
      const sp = rand(3, 8);
      this.sparks.spawn(
        px, py, pz,
        Math.cos(a) * s * sp, y * sp + 1, Math.sin(a) * s * sp,
        white ? w[0] : r, white ? w[1] : g, white ? w[2] : b,
        rand(0.2, 0.35), 0, rand(0.35, 0.7), 1, 0.4, 1.5, py - 3);
    }
  }

  /** Finish-line confetti: 200 multi-coloured pieces with gravity and drag (life 2–3 s). */
  emitConfetti(position, floorY = NO_FLOOR) {
    const px = position.x, py = position.y, pz = position.z;
    const pal = this.pal.confetti;
    for (let i = 0; i < 200; i++) {
      const c = pal[(Math.random() * pal.length) | 0];
      const a = Math.random() * Math.PI * 2, sp = rand(4, 14);
      const size = rand(0.18, 0.3);
      this.smoke.spawn(
        px + rand(-0.5, 0.5), py + rand(0, 0.5), pz + rand(-0.5, 0.5),
        Math.cos(a) * sp, rand(6, 16), Math.sin(a) * sp,
        c[0], c[1], c[2], size, size, rand(2, 3), 1, 0.6, 2.2, floorY);
    }
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.time += dt;
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (let i = 0; i < this._waves.length; i++) {
      const w = this._waves[i];
      if (!w.active) continue;
      w.t += dt;
      const k = Math.min(1, w.t / 0.5);
      w.ring.scale.setScalar(1 + 26 * k);
      w.ring.material.opacity = (1 - k) * 0.9;
      const kb = Math.min(1, w.t / 0.35);
      w.ball.scale.setScalar(0.8 + 5.2 * kb);
      w.ball.material.opacity = (1 - kb) * 0.85;
      if (w.t >= 0.5) {
        w.active = false;
        w.ring.visible = false;
        w.ball.visible = false;
      }
    }
  }

  _startShockwave(x, y, z) {
    let w = null;
    for (let i = 0; i < this._waves.length; i++) if (!this._waves[i].active) { w = this._waves[i]; break; }
    if (!w) { // all busy: recycle the oldest
      w = this._waves[0];
      for (let i = 1; i < this._waves.length; i++) if (this._waves[i].t > w.t) w = this._waves[i];
    }
    w.active = true;
    w.t = 0;
    w.ring.position.set(x, y + 0.15, z);
    w.ring.scale.setScalar(1);
    w.ring.material.opacity = 0.9;
    w.ring.visible = true;
    w.ball.position.set(x, y + 0.6, z);
    w.ball.scale.setScalar(0.8);
    w.ball.material.opacity = 0.85;
    w.ball.visible = true;
  }

  /** Kills every live particle and effect (used on race restart). */
  clear() {
    this.sparks.clear();
    this.smoke.clear();
    for (const w of this._waves) { w.active = false; w.ring.visible = false; w.ball.visible = false; }
  }

  dispose() {
    this.sparks.dispose(this.scene);
    this.smoke.dispose(this.scene);
    for (const w of this._waves) {
      this.scene.remove(w.ring); this.scene.remove(w.ball);
      w.ring.material.dispose(); w.ball.material.dispose();
    }
    this._ringGeo.dispose();
    this._ballGeo.dispose();
  }
}
