/**
 * items.js — item boxes, roulette, item rolling and all projectiles (shells, bananas, bombs),
 * star contact damage and lightning.
 *
 *   const items = new ItemManager(scene, track, particles, audio);   // particles/audio optional
 *   items.update(dt, karts)      items.tryUse(kart, karts)      items.rollItem(kart)
 *   items.hazards                items.reset(karts)             items.dispose()
 *
 * Kart fields READ : position, yaw, speed, radius, trackT, racePosition, item, itemCount, input.lookBack,
 *                    isPlayer, finished, state.{stunTimer, invincibleTimer}
 * Kart fields WRITTEN: item, itemCount, rouletteTimer, rouletteItem, rouletteTick, rouletteIndex
 * Kart methods called: applyBoost, spinOut, crash, setStar, setShrink (all guarded with ?.)
 *
 * Direction rule: holding `input.lookBack` flips an item's default direction —
 *   shells fire BACKWARD, banana is LOBBED FORWARD (~14 m); otherwise shells go forward and the
 *   banana is dropped 2.5 m behind. Bombs always go forward.
 */
import * as THREE from 'three';
import { ROAD_WIDTH, WALL_MARGIN, ITEM_TYPES } from './constants.js';

const BOX_SIZE = 1.3;
const BOX_BOB = 0.15;
const PICKUP_RADIUS = 1.6;
const BOX_RESPAWN_TIME = 3;
const BOX_SHRINK_TIME = 0.15;
const BOX_GROW_TIME = 0.45;
const ROULETTE_TIME = 1.5;
const ROULETTE_STEP = 0.08;

const SHELL_RADIUS = 0.6, BANANA_RADIUS = 0.7, BOMB_RADIUS = 0.7;
const GREEN_SHELL_SPEED = 45, RED_SHELL_SPEED = 42;
const GREEN_SHELL_LIFE = 8, RED_SHELL_LIFE = 10;
const GREEN_MAX_BOUNCES = 3, RED_MAX_BOUNCES = 6;
const RED_TRACK_PHASE = 0.8;        // seconds of centre-line following before direct homing
const RED_TURN_RATE = 3;            // rad/s while homing
const RED_TRACK_TURN_RATE = 6;      // rad/s while following the centre-line
const RED_DIRECT_RANGE = 40;        // within this range (and ahead) a red shell homes immediately
const SHELL_HEIGHT = 0.45;
const BANANA_LIFE = 60, BANANA_HEIGHT = 0.24;
const BOMB_FUSE = 2.5, BOMB_BLAST_RADIUS = 6, BOMB_WALK_SPEED = 6, BOMB_GRAVITY = -22;
const OWNER_IMMUNITY = 0.5, BOMB_OWNER_IMMUNITY = 0.6;
const STAR_TOUCH_MARGIN = 0.35;     // star contact = radii sum + margin (karts are pushed apart to radii sum)
const DEFAULT_WALL_DISTANCE = ROAD_WIDTH / 2 + WALL_MARGIN;

const WEIGHTS = {
  front: [['banana', 40], ['green_shell', 35], ['mushroom', 20], ['red_shell', 5]],
  mid: [['green_shell', 20], ['red_shell', 25], ['mushroom', 25], ['triple_mushroom', 10], ['banana', 10], ['bomb', 10]],
  back: [['triple_mushroom', 25], ['red_shell', 20], ['star', 20], ['lightning', 15], ['bomb', 15], ['mushroom', 5]],
};

const POP_COLORS = { green_shell: 0x66bb6a, red_shell: 0xff5252, banana: 0xffeb3b, bomb: 0xff9100 };

const _v = new THREE.Vector3();
const wrap01 = (t) => t - Math.floor(t);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const isShell = (p) => p.type === 'green_shell' || p.type === 'red_shell';

/** A live item in the world (shell / banana / bomb). `position` aliases mesh.position. */
class Projectile {
  constructor(type, mesh, owner, radius) {
    this.type = type;
    this.mesh = mesh;
    this.position = mesh.position;
    this.velocity = new THREE.Vector3();
    this.owner = owner;
    this.radius = radius;
    this.age = 0;
    this.life = Infinity;
    this.alive = true;
    this.trackT = owner && Number.isFinite(owner.trackT) ? owner.trackT : undefined;
    this.dir = 1;             // +1 forward along the track, -1 backward (red shells)
    this.bounces = 0;
    this.maxBounces = 0;
    this.landed = false;
    this.target = null;
    this.sparkMat = null;
    this.spark = null;
    // AI-facing record; shares vectors so no per-frame allocation is needed
    this.hazard = { position: this.position, radius, type, velocity: this.velocity, owner };
  }
}

export class ItemManager {
  constructor(scene, track, particles, audio) {
    this.scene = scene;
    this.track = track;
    this.particles = particles;
    this.audio = audio;
    this.projectiles = [];
    this.hazards = [];
    this.boxes = [];
    this.elapsed = 0;
    this._hasRoad = !!(track && typeof track.getRoadInfo === 'function');
    this.trackLength = (track && track.length) || (track && track.curve && track.curve.getLength && track.curve.getLength()) || 1000;

    this._buildAssets();
    const positions = (track && track.itemBoxPositions) || [];
    for (let i = 0; i < positions.length; i++) this._makeBox(positions[i], i);
  }

  // ------------------------------------------------------------------ assets

  _buildAssets() {
    const g = (this.geo = {});
    const m = (this.mat = {});

    // Item box
    g.box = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
    g.question = new THREE.PlaneGeometry(0.85, 0.85);
    g.blob = new THREE.CircleGeometry(0.9, 24);
    m.blob = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
    const qTex = this._makeQuestionTexture();
    m.question = qTex
      ? new THREE.MeshBasicMaterial({ map: qTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color: 0xffe082, side: THREE.DoubleSide });

    // Shells: squashed dome + white underside + 8 spikes + fake specular highlight
    g.shellDome = new THREE.SphereGeometry(0.55, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    g.shellDome.scale(1, 0.72, 1);
    g.shellBase = new THREE.CylinderGeometry(0.5, 0.42, 0.16, 24);
    g.spike = new THREE.ConeGeometry(0.09, 0.24, 8);
    g.spike.rotateX(Math.PI / 2); // tip along +Z
    g.highlight = new THREE.SphereGeometry(0.11, 10, 8);
    g.highlight.scale(1.6, 1, 1);
    m.greenShell = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.3, metalness: 0.05 });
    m.redShell = new THREE.MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.3, metalness: 0.05 });
    m.shellBase = new THREE.MeshStandardMaterial({ color: 0xf5f0dc, roughness: 0.5 });
    m.spike = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.35 });
    m.highlight = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });

    // Banana: tube along a bezier "smile", brown stem, dark tip
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(-0.55, 0.42, 0), new THREE.Vector3(0, -0.55, 0), new THREE.Vector3(0.55, 0.42, 0));
    g.bananaBody = new THREE.TubeGeometry(curve, 18, 0.16, 10, false);
    g.bananaStem = new THREE.CylinderGeometry(0.05, 0.07, 0.2, 8);
    g.bananaTip = new THREE.SphereGeometry(0.07, 8, 6);
    m.banana = new THREE.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.45, metalness: 0 });
    m.stem = new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.8 });
    m.tip = new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.8 });

    // Bomb: black body, fuse + flickering spark, eyes, feet, wind-up key
    g.bombBody = new THREE.SphereGeometry(0.45, 24, 16);
    g.fuse = new THREE.CylinderGeometry(0.035, 0.045, 0.32, 8);
    g.spark = new THREE.SphereGeometry(0.09, 10, 8);
    g.eye = new THREE.SphereGeometry(0.1, 10, 8);
    g.pupil = new THREE.SphereGeometry(0.045, 8, 6);
    g.foot = new THREE.SphereGeometry(0.13, 10, 8);
    g.foot.scale(1, 0.55, 1.3);
    g.keyRing = new THREE.TorusGeometry(0.12, 0.03, 8, 16);
    g.keyStem = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8);
    g.keyStem.rotateX(Math.PI / 2);
    m.bomb = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.35, metalness: 0.3 });
    m.fuse = new THREE.MeshStandardMaterial({ color: 0x9e9e9e, roughness: 0.7 });
    m.spark = new THREE.MeshStandardMaterial({ color: 0xffab40, emissive: 0xff6d00, emissiveIntensity: 2.5, roughness: 0.4 });
    m.eye = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    m.pupil = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
    m.foot = new THREE.MeshStandardMaterial({ color: 0xffa000, roughness: 0.6 });
    m.key = new THREE.MeshStandardMaterial({ color: 0xbdbdbd, roughness: 0.35, metalness: 0.7 });
  }

  _makeQuestionTexture() {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext && c.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = 'bold 96px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255, 230, 120, 0.9)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#fff3b0';
    ctx.fillText('?', 64, 70);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ff9800';
    ctx.strokeText('?', 64, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  _makeBox(pos, index) {
    const group = new THREE.Group();
    group.position.copy(pos);
    const inner = new THREE.Group();
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, metalness: 0.2, roughness: 0.15,
      clearcoat: 1, clearcoatRoughness: 0.1, emissive: 0xff40ff, emissiveIntensity: 0.55,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const cube = new THREE.Mesh(this.geo.box, material);
    cube.castShadow = true;
    cube.renderOrder = 2;
    const question = new THREE.Mesh(this.geo.question, this.mat.question);
    question.renderOrder = 1;
    inner.add(cube);
    inner.add(question);
    group.add(inner);

    let blobY = pos.y - BOX_SIZE + 0.16;
    if (this._hasRoad) {
      const info = this.track.getRoadInfo(pos);
      if (info && Number.isFinite(info.height)) blobY = info.height + 0.04;
    }
    const blob = new THREE.Mesh(this.geo.blob, this.mat.blob);
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(pos.x, blobY, pos.z);
    blob.renderOrder = 0;

    this.scene.add(group);
    this.scene.add(blob);
    this.boxes.push({
      group, inner, cube, question, blob, material,
      baseY: pos.y, phase: index * 0.7, state: 'active', timer: 0,
    });
  }

  _makeShell(red) {
    const grp = new THREE.Group();
    const dome = new THREE.Mesh(this.geo.shellDome, red ? this.mat.redShell : this.mat.greenShell);
    dome.position.y = 0.08;
    dome.castShadow = true;
    const base = new THREE.Mesh(this.geo.shellBase, this.mat.shellBase);
    base.castShadow = true;
    grp.add(dome);
    grp.add(base);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const s = new THREE.Mesh(this.geo.spike, this.mat.spike);
      s.position.set(Math.cos(a) * 0.5, 0.2, Math.sin(a) * 0.5);
      s.rotation.y = Math.PI / 2 - a; // tip points radially outward
      s.castShadow = true;
      grp.add(s);
    }
    const hl = new THREE.Mesh(this.geo.highlight, this.mat.highlight);
    hl.position.set(0.16, 0.42, -0.2);
    grp.add(hl);
    return grp;
  }

  _makeBanana() {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(this.geo.bananaBody, this.mat.banana);
    body.castShadow = true;
    const stem = new THREE.Mesh(this.geo.bananaStem, this.mat.stem);
    stem.position.set(-0.6, 0.5, 0);
    stem.rotation.z = 0.7;
    stem.castShadow = true;
    const tip = new THREE.Mesh(this.geo.bananaTip, this.mat.tip);
    tip.position.set(0.6, 0.46, 0);
    grp.add(body);
    grp.add(stem);
    grp.add(tip);
    grp.scale.setScalar(1.1);
    return grp;
  }

  _makeBomb() {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(this.geo.bombBody, this.mat.bomb);
    body.position.y = 0.45;
    body.castShadow = true;
    const fuse = new THREE.Mesh(this.geo.fuse, this.mat.fuse);
    fuse.position.set(-0.03, 1.02, 0);
    fuse.rotation.z = 0.25;
    const sparkMat = this.mat.spark.clone();
    const spark = new THREE.Mesh(this.geo.spark, sparkMat);
    spark.position.set(-0.07, 1.2, 0);
    const eyeL = new THREE.Mesh(this.geo.eye, this.mat.eye);
    eyeL.position.set(0.16, 0.56, 0.37);
    const eyeR = new THREE.Mesh(this.geo.eye, this.mat.eye);
    eyeR.position.set(-0.16, 0.56, 0.37);
    const pupilL = new THREE.Mesh(this.geo.pupil, this.mat.pupil);
    pupilL.position.set(0.16, 0.56, 0.46);
    const pupilR = new THREE.Mesh(this.geo.pupil, this.mat.pupil);
    pupilR.position.set(-0.16, 0.56, 0.46);
    const footL = new THREE.Mesh(this.geo.foot, this.mat.foot);
    footL.position.set(0.2, 0.05, 0.12);
    const footR = new THREE.Mesh(this.geo.foot, this.mat.foot);
    footR.position.set(-0.2, 0.05, 0.12);
    const keyStem = new THREE.Mesh(this.geo.keyStem, this.mat.key);
    keyStem.position.set(0, 0.5, -0.52);
    const keyRing = new THREE.Mesh(this.geo.keyRing, this.mat.key);
    keyRing.position.set(0, 0.5, -0.68);
    keyRing.rotation.y = Math.PI / 2;
    for (const part of [body, fuse, spark, eyeL, eyeR, pupilL, pupilR, footL, footR, keyStem, keyRing]) grp.add(part);
    footL.castShadow = footR.castShadow = true;
    return { grp, sparkMat, spark };
  }

  // ------------------------------------------------------------------ helpers

  _roadInfo(pos, hintT) {
    return this._hasRoad ? this.track.getRoadInfo(pos, hintT) : null;
  }

  /** Keeps a projectile inside the barriers; returns true when it was clamped. */
  _clampToWalls(p, info, margin) {
    const limit = (Number.isFinite(info.wallDistance) ? info.wallDistance : DEFAULT_WALL_DISTANCE) - margin;
    const lat = info.lateral;
    if (!(Math.abs(lat) > limit) || !info.right) return false;
    const sgn = lat > 0 ? 1 : -1;
    const over = Math.abs(lat) - limit + 0.05;
    p.position.x -= info.right.x * sgn * over;
    p.position.z -= info.right.z * sgn * over;
    const vr = p.velocity.x * info.right.x + p.velocity.z * info.right.z;
    if (vr * sgn > 0) { // moving outward: reflect across the wall plane
      p.velocity.x -= 2 * vr * info.right.x;
      p.velocity.z -= 2 * vr * info.right.z;
    }
    return true;
  }

  _spawn(p) {
    this.scene.add(p.mesh);
    this.projectiles.push(p);
    return p;
  }

  _remove(p) {
    this.scene.remove(p.mesh);
    if (p.sparkMat) p.sparkMat.dispose();
  }

  _pop(p, sound) {
    if (!p.alive) return;
    p.alive = false;
    this.particles?.emitPop(p.position, POP_COLORS[p.type] || 0xffffff);
    if (sound) this.audio?.play(sound);
  }

  _findByPosition(karts, racePosition) {
    for (let i = 0; i < karts.length; i++) if (karts[i].racePosition === racePosition) return karts[i];
    return null;
  }

  // ------------------------------------------------------------------ items

  /** Weighted roll by race position (1 = leader). Sets kart.item / kart.itemCount and returns the item. */
  rollItem(kart) {
    const pos = kart.racePosition || 4;
    const table = pos <= 2 ? WEIGHTS.front : pos <= 5 ? WEIGHTS.mid : WEIGHTS.back;
    let total = 0;
    for (let i = 0; i < table.length; i++) total += table[i][1];
    let r = Math.random() * total;
    let item = table[table.length - 1][0];
    for (let i = 0; i < table.length; i++) {
      r -= table[i][1];
      if (r <= 0) { item = table[i][0]; break; }
    }
    kart.item = item;
    kart.itemCount = item === 'triple_mushroom' ? 3 : 1;
    return item;
  }

  /** Uses the kart's held item. Returns true when something was used. */
  tryUse(kart, karts = []) {
    const item = kart.item;
    if (!item || (kart.state && kart.state.stunTimer > 0)) return false;
    const lookBack = !!(kart.input && kart.input.lookBack);
    const consume = () => { kart.item = null; kart.itemCount = 0; };
    switch (item) {
      case 'mushroom':
        kart.applyBoost?.(1.2, 1.4);
        this.audio?.play('boost');
        consume();
        break;
      case 'triple_mushroom':
        kart.applyBoost?.(1.2, 1.4);
        this.audio?.play('boost');
        kart.itemCount = (kart.itemCount || 1) - 1;
        if (kart.itemCount <= 0) consume();
        break;
      case 'green_shell':
        this._fireShell(kart, false, lookBack ? -1 : 1, karts);
        consume();
        break;
      case 'red_shell':
        this._fireShell(kart, true, lookBack ? -1 : 1, karts);
        consume();
        break;
      case 'banana':
        this._dropBanana(kart, lookBack);
        consume();
        break;
      case 'star':
        kart.setStar?.(8);
        this.audio?.play('star');
        consume();
        break;
      case 'lightning':
        this._lightning(kart, karts);
        consume();
        break;
      case 'bomb':
        this._throwBomb(kart);
        consume();
        break;
      default:
        return false;
    }
    return true;
  }

  _fireShell(kart, red, dir, karts) {
    const fx = Math.sin(kart.yaw) * dir, fz = Math.cos(kart.yaw) * dir;
    const p = new Projectile(red ? 'red_shell' : 'green_shell', this._makeShell(red), kart, SHELL_RADIUS);
    p.position.set(kart.position.x + fx * 2.5, kart.position.y + 0.5, kart.position.z + fz * 2.5);
    const speed = red ? RED_SHELL_SPEED : GREEN_SHELL_SPEED;
    p.velocity.set(fx * speed, 0, fz * speed);
    p.dir = dir;
    p.life = red ? RED_SHELL_LIFE : GREEN_SHELL_LIFE;
    p.maxBounces = red ? RED_MAX_BOUNCES : GREEN_MAX_BOUNCES;
    const info = this._roadInfo(p.position, p.trackT);
    if (info) { p.trackT = info.t; p.position.y = info.height + SHELL_HEIGHT; }
    if (red) {
      const rp = kart.racePosition;
      // forward: kart directly ahead in race order; backward: kart directly behind. Leader/last → none.
      p.target = Number.isFinite(rp) ? this._findByPosition(karts, dir > 0 ? rp - 1 : rp + 1) : null;
      if (p.target === kart) p.target = null;
    }
    this.audio?.play('shell_fire');
    return this._spawn(p);
  }

  _dropBanana(kart, lobForward) {
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    const p = new Projectile('banana', this._makeBanana(), kart, BANANA_RADIUS);
    p.life = BANANA_LIFE;
    if (lobForward) {
      // Lob arc landing ~14 m ahead (plus the thrower's own travel while it flies)
      const vy0 = 8, flight = (2 * vy0) / -BOMB_GRAVITY, horiz = 14 / flight;
      const inherit = Math.max(0, kart.speed || 0);
      p.position.set(kart.position.x + fx * 1.5, kart.position.y + 1.0, kart.position.z + fz * 1.5);
      p.velocity.set(fx * (horiz + inherit), vy0, fz * (horiz + inherit));
      p.landed = false;
      this.audio?.play('shell_fire');
    } else {
      p.position.set(kart.position.x - fx * 2.5, kart.position.y, kart.position.z - fz * 2.5);
      p.landed = true;
    }
    const info = this._roadInfo(p.position, p.trackT);
    if (info) {
      p.trackT = info.t;
      if (p.landed) p.position.y = info.height + BANANA_HEIGHT;
    }
    p.mesh.rotation.y = Math.random() * Math.PI * 2;
    return this._spawn(p);
  }

  _throwBomb(kart) {
    const fx = Math.sin(kart.yaw), fz = Math.cos(kart.yaw);
    const { grp, sparkMat, spark } = this._makeBomb();
    const p = new Projectile('bomb', grp, kart, BOMB_RADIUS);
    p.sparkMat = sparkMat;
    p.spark = spark;
    p.life = BOMB_FUSE;
    // forward×20 + up×9, plus 60 % of the thrower's speed so a fast kart doesn't overrun its own bomb
    const inherit = Math.max(0, kart.speed || 0) * 0.6;
    p.position.set(kart.position.x + fx * 1.8, kart.position.y + 1.0, kart.position.z + fz * 1.8);
    p.velocity.set(fx * (20 + inherit), 9, fz * (20 + inherit));
    this.audio?.play('shell_fire');
    return this._spawn(p);
  }

  _lightning(user, karts) {
    this.audio?.play('lightning');
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (k === user) continue;
      if (k.state && k.state.invincibleTimer > 0) continue;
      k.setShrink?.(5);
      k.spinOut?.();
      this.particles?.emitPop(k.position, 0xfff59d);
    }
  }

  _explodeBomb(p, karts) {
    if (!p.alive) return;
    p.alive = false;
    this.particles?.emitExplosion(p.position);
    this.audio?.play('bomb');
    const r2 = BOMB_BLAST_RADIUS * BOMB_BLAST_RADIUS;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (k === p.owner && p.age < BOMB_OWNER_IMMUNITY) continue;
      const st = k.state;
      if (st && (st.invincibleTimer > 0 || st.stunTimer > 0)) continue;
      const dx = k.position.x - p.position.x, dz = k.position.z - p.position.z;
      if (dx * dx + dz * dz <= r2) k.crash?.();
    }
  }

  // ------------------------------------------------------------------ update

  update(dt, karts = []) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.elapsed += dt;
    this._updateBoxes(dt, karts);
    this._updateRoulettes(dt, karts);
    this._updateProjectiles(dt, karts);
    this._resolveHits(karts);
    this._resolveProjectilePairs(karts);
    this._resolveStarContacts(karts);
    // remove dead projectiles (reverse iteration keeps indices valid)
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (!this.projectiles[i].alive) { this._remove(this.projectiles[i]); this.projectiles.splice(i, 1); }
    }
    this.hazards.length = 0;
    for (let i = 0; i < this.projectiles.length; i++) this.hazards.push(this.projectiles[i].hazard);
  }

  _updateBoxes(dt, karts) {
    const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
    for (let b = 0; b < this.boxes.length; b++) {
      const box = this.boxes[b];
      box.cube.rotation.y += dt * 1.3;
      box.cube.rotation.x += dt * 0.8;
      box.question.rotation.y -= dt * 0.9;
      box.group.position.y = box.baseY + Math.sin(this.elapsed * 2.2 + box.phase) * BOX_BOB;
      const hue = wrap01(this.elapsed * 0.25 + box.phase * 0.15);
      box.material.emissive.setHSL(hue, 0.95, 0.42);
      box.material.color.setHSL(wrap01(hue + 0.15), 0.6, 0.85);

      switch (box.state) {
        case 'active': {
          const bx = box.group.position.x, bz = box.group.position.z;
          for (let i = 0; i < karts.length; i++) {
            const k = karts[i];
            const dx = k.position.x - bx, dz = k.position.z - bz;
            if (dx * dx + dz * dz < r2) { this._pickup(box, k); break; }
          }
          break;
        }
        case 'shrinking': {
          box.timer -= dt;
          const s = Math.max(0.001, box.timer / BOX_SHRINK_TIME);
          box.inner.scale.setScalar(s);
          box.blob.scale.setScalar(s);
          if (box.timer <= 0) {
            box.state = 'hidden';
            box.timer = BOX_RESPAWN_TIME - BOX_SHRINK_TIME;
            box.inner.visible = false;
            box.blob.visible = false;
          }
          break;
        }
        case 'hidden':
          box.timer -= dt;
          if (box.timer <= 0) {
            box.state = 'growing';
            box.timer = 0;
            box.inner.visible = true;
            box.blob.visible = true;
            box.inner.scale.setScalar(0.001);
            box.blob.scale.setScalar(0.001);
          }
          break;
        case 'growing': {
          box.timer += dt;
          const k = Math.min(1, box.timer / BOX_GROW_TIME);
          const s = Math.max(0.001, easeOutBack(k));
          box.inner.scale.setScalar(s);
          box.blob.scale.setScalar(Math.min(1, s));
          if (k >= 1) { box.state = 'active'; box.inner.scale.setScalar(1); box.blob.scale.setScalar(1); }
          break;
        }
      }
    }
  }

  _pickup(box, kart) {
    box.state = 'shrinking';
    box.timer = BOX_SHRINK_TIME;
    this.particles?.emitPop(box.group.position, box.material.emissive.getHex());
    this.audio?.play('item_pickup');
    if (kart.item == null && !(kart.rouletteTimer > 0)) {
      kart.rouletteTimer = ROULETTE_TIME;
      kart.rouletteTick = ROULETTE_STEP;
      kart.rouletteIndex = (Math.random() * ITEM_TYPES.length) | 0;
      kart.rouletteItem = ITEM_TYPES[kart.rouletteIndex];
    }
  }

  _updateRoulettes(dt, karts) {
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!(k.rouletteTimer > 0)) continue;
      k.rouletteTimer -= dt;
      k.rouletteTick -= dt;
      if (k.rouletteTimer <= 0) {
        k.rouletteTimer = 0;
        k.rouletteItem = null;
        this.rollItem(k);
        continue;
      }
      if (k.rouletteTick <= 0) {
        k.rouletteTick += ROULETTE_STEP;
        k.rouletteIndex = ((k.rouletteIndex || 0) + 1) % ITEM_TYPES.length;
        k.rouletteItem = ITEM_TYPES[k.rouletteIndex];
        if (k.isPlayer) this.audio?.play('item_roulette');
      }
    }
  }

  _updateProjectiles(dt, karts) {
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.type === 'bomb') this._updateBomb(p, dt, karts);
      else if (p.type === 'banana') this._updateBanana(p, dt);
      else this._updateShell(p, dt);
    }
  }

  _updateShell(p, dt) {
    if (p.age > p.life) { this._pop(p, null); return; }
    if (p.type === 'red_shell') this._steerRedShell(p, dt);
    p.position.x += p.velocity.x * dt;
    p.position.z += p.velocity.z * dt;
    const info = this._roadInfo(p.position, p.trackT);
    if (info) {
      p.trackT = info.t;
      p.position.y = info.height + SHELL_HEIGHT;
      if (this._clampToWalls(p, info, 0.5)) {
        p.bounces++;
        this.audio?.play('wall');
        if (p.bounces > p.maxBounces) { this._pop(p, 'shell_hit'); return; }
      }
    }
    p.mesh.rotation.y += dt * 14;
  }

  _steerRedShell(p, dt) {
    const target = p.target;
    let tx, tz, maxTurn;
    let direct = !!target && p.age >= RED_TRACK_PHASE;
    if (target && !direct) {
      // close range: skip the centre-line phase when the target is near and roughly ahead of the shell
      const ox = target.position.x - p.position.x, oz = target.position.z - p.position.z;
      const d2 = ox * ox + oz * oz;
      if (d2 < RED_DIRECT_RANGE * RED_DIRECT_RANGE) {
        const vl = Math.hypot(p.velocity.x, p.velocity.z) || 1;
        if ((ox * p.velocity.x + oz * p.velocity.z) / (vl * Math.sqrt(d2)) > 0.3) direct = true;
      }
    }
    if (!direct) {
      // follow the centre-line: aim at a point ~8 m further along the track
      if (!this.track || !this.track.curve || !Number.isFinite(p.trackT)) return;
      this.track.curve.getPointAt(wrap01(p.trackT + (p.dir * 8) / this.trackLength), _v);
      tx = _v.x - p.position.x;
      tz = _v.z - p.position.z;
      maxTurn = RED_TRACK_TURN_RATE;
    } else {
      tx = target.position.x - p.position.x;
      tz = target.position.z - p.position.z;
      maxTurn = RED_TURN_RATE;
    }
    if (tx * tx + tz * tz < 1e-6) return;
    const cur = Math.atan2(p.velocity.x, p.velocity.z);
    let d = wrapAngle(Math.atan2(tx, tz) - cur);
    const maxD = maxTurn * dt;
    if (d > maxD) d = maxD; else if (d < -maxD) d = -maxD;
    const a = cur + d;
    p.velocity.x = Math.sin(a) * RED_SHELL_SPEED;
    p.velocity.z = Math.cos(a) * RED_SHELL_SPEED;
  }

  _updateBanana(p, dt) {
    if (p.age > p.life) { p.alive = false; return; }
    if (!p.landed) {
      p.velocity.y += BOMB_GRAVITY * dt;
      p.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += dt * 9;
      const info = this._roadInfo(p.position, p.trackT);
      if (info) {
        p.trackT = info.t;
        this._clampToWalls(p, info, 0.6);
        if (p.velocity.y < 0 && p.position.y <= info.height + BANANA_HEIGHT) {
          p.landed = true;
          p.position.y = info.height + BANANA_HEIGHT;
          p.velocity.set(0, 0, 0);
          p.mesh.rotation.x = 0;
        }
      } else if (p.velocity.y < 0 && p.position.y <= p.owner.position.y + BANANA_HEIGHT) {
        p.landed = true;
        p.velocity.set(0, 0, 0);
      }
      return;
    }
    const info = this._roadInfo(p.position, p.trackT);
    if (info) { p.trackT = info.t; p.position.y = info.height + BANANA_HEIGHT; }
    // gentle wobble
    p.mesh.rotation.x = Math.sin(p.age * 3) * 0.08;
    p.mesh.rotation.z = Math.cos(p.age * 2.3) * 0.06;
    p.mesh.rotation.y += dt * 0.6;
  }

  _updateBomb(p, dt, karts) {
    // fuse spark flicker
    const fl = 0.7 + Math.random() * 0.6;
    p.spark.scale.setScalar(fl);
    p.sparkMat.emissiveIntensity = 1.5 + Math.random() * 2;
    if (!p.landed) {
      p.velocity.y += BOMB_GRAVITY * dt;
      p.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += dt * 5;
      const info = this._roadInfo(p.position, p.trackT);
      const ground = info ? info.height : p.owner.position.y;
      if (info) { p.trackT = info.t; this._clampToWalls(p, info, 0.6); }
      if (p.velocity.y < 0 && p.position.y <= ground) {
        p.landed = true;
        p.position.y = ground;
        const tx = info ? info.tangent.x : Math.sin(p.owner.yaw), tz = info ? info.tangent.z : Math.cos(p.owner.yaw);
        const len = Math.hypot(tx, tz) || 1;
        p.velocity.set((tx / len) * BOMB_WALK_SPEED, 0, (tz / len) * BOMB_WALK_SPEED);
        p.mesh.rotation.set(0, Math.atan2(tx, tz), 0);
      }
    } else {
      const info = this._roadInfo(p.position, p.trackT);
      if (info) {
        p.trackT = info.t;
        const tx = info.tangent.x, tz = info.tangent.z;
        const len = Math.hypot(tx, tz) || 1;
        p.velocity.set((tx / len) * BOMB_WALK_SPEED, 0, (tz / len) * BOMB_WALK_SPEED);
        p.mesh.rotation.y = Math.atan2(tx, tz);
      }
      p.position.x += p.velocity.x * dt;
      p.position.z += p.velocity.z * dt;
      if (info) { p.position.y = info.height; this._clampToWalls(p, info, 0.6); }
      p.mesh.rotation.z = Math.sin(p.age * 14) * 0.12; // waddle
    }
    if (p.age >= BOMB_FUSE) this._explodeBomb(p, karts);
  }

  _resolveHits(karts) {
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (!p.alive) continue;
      const immunity = p.type === 'bomb' ? BOMB_OWNER_IMMUNITY : OWNER_IMMUNITY;
      for (let j = 0; j < karts.length; j++) {
        const k = karts[j];
        if (k === p.owner && p.age < immunity) continue;
        const st = k.state;
        if (st && st.stunTimer > 0) continue;
        const dx = k.position.x - p.position.x, dz = k.position.z - p.position.z;
        const rr = (k.radius || 1.2) + p.radius;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (p.type === 'bomb') { this._explodeBomb(p, karts); break; }
        if (st && st.invincibleTimer > 0) { this._pop(p, 'shell_hit'); break; } // star smashes it
        k.spinOut?.();
        this.audio?.play(p.type === 'banana' ? 'banana' : 'shell_hit');
        this.particles?.emitPop(p.position, POP_COLORS[p.type] || 0xffffff);
        p.alive = false;
        break;
      }
    }
  }

  /** Shells destroy shells and bananas, and detonate bombs. */
  _resolveProjectilePairs(karts) {
    const n = this.projectiles.length;
    for (let i = 0; i < n; i++) {
      const a = this.projectiles[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.projectiles[j];
        if (!b.alive || !(isShell(a) || isShell(b))) continue;
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
        const rr = a.radius + b.radius;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (a.type === 'bomb') this._explodeBomb(a, karts); else this._pop(a, 'shell_hit');
        if (b.type === 'bomb') this._explodeBomb(b, karts); else this._pop(b, null);
        break;
      }
    }
  }

  _resolveStarContacts(karts) {
    for (let i = 0; i < karts.length; i++) {
      const a = karts[i];
      if (!(a.state && a.state.invincibleTimer > 0)) continue;
      for (let j = 0; j < karts.length; j++) {
        const b = karts[j];
        if (b === a) continue;
        const st = b.state;
        if (st && (st.invincibleTimer > 0 || st.stunTimer > 0)) continue;
        const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
        const rr = (a.radius || 1.2) + (b.radius || 1.2) + STAR_TOUCH_MARGIN;
        if (dx * dx + dz * dz >= rr * rr) continue;
        b.spinOut?.();
        this.particles?.emitPop(b.position, 0xfff176);
        this.audio?.play('shell_hit');
      }
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Removes all projectiles, restores every box and clears item state on the given karts. */
  reset(karts) {
    for (let i = 0; i < this.projectiles.length; i++) this._remove(this.projectiles[i]);
    this.projectiles.length = 0;
    this.hazards.length = 0;
    for (let i = 0; i < this.boxes.length; i++) {
      const box = this.boxes[i];
      box.state = 'active';
      box.timer = 0;
      box.inner.visible = true;
      box.blob.visible = true;
      box.inner.scale.setScalar(1);
      box.blob.scale.setScalar(1);
    }
    if (karts) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        k.item = null;
        k.itemCount = 0;
        k.rouletteTimer = 0;
        k.rouletteItem = null;
        k.rouletteTick = 0;
      }
    }
  }

  dispose() {
    this.reset();
    for (let i = 0; i < this.boxes.length; i++) {
      const box = this.boxes[i];
      this.scene.remove(box.group);
      this.scene.remove(box.blob);
      box.material.dispose();
    }
    this.boxes.length = 0;
    for (const key in this.geo) this.geo[key].dispose();
    for (const key in this.mat) {
      const m = this.mat[key];
      if (m.map) m.map.dispose();
      m.dispose();
    }
  }
}
