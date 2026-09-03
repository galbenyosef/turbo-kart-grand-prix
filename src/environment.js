// Turbo Kart Grand Prix — environment.js
// Sky dome (gradient + sun disc), sun light with stable shadows, hemisphere light, fog and
// drifting low-poly clouds. Everything procedural, except that the clouds use the GLB model
// when an asset library (assets.js) is passed in.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Pin the dome to the far plane so it is never clipped whatever the camera's far value.
    gl_Position = clip.xyww;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col;
    if (h >= 0.0) {
      col = mix(uHorizon, uMid, smoothstep(0.0, 0.14, h));
      col = mix(col, uTop, smoothstep(0.14, 0.65, h));
    } else {
      col = mix(uHorizon, uGround, smoothstep(0.0, -0.2, h));
    }
    float s = max(dot(d, uSunDir), 0.0);
    float disc = smoothstep(0.9988, 0.9996, s);
    float glow = pow(s, 90.0) * 0.45 + pow(s, 6.0) * 0.10;
    col += uSunColor * (disc * 1.6 + glow);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One fluffy cloud: several flattened spheres merged into a single geometry. */
function makeCloudGeometry(rand, puffs) {
  const parts = [];
  for (let i = 0; i < puffs; i++) {
    const r = i === 0 ? 1.0 : 0.5 + rand() * 0.4;
    const g = new THREE.SphereGeometry(r, 10, 7);
    const x = i === 0 ? 0 : (rand() - 0.5) * 2.6;
    const z = i === 0 ? 0 : (rand() - 0.5) * 1.4;
    const y = i === 0 ? 0 : (rand() - 0.3) * 0.5;
    g.translate(x, y, z);
    parts.push(g);
  }
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
  merged.scale(1, 0.55, 1);
  merged.computeVertexNormals();
  return merged;
}

export class Environment {
  /** @param {object} [assets] optional GLB library (assets.js); clouds use it when `has('cloud')`. */
  constructor(scene, renderer = null, assets = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'environment';

    // Palette (sRGB hex → managed linear via THREE.Color).
    this.colors = {
      zenith: new THREE.Color(0x2458c9),
      mid: new THREE.Color(0x79c4f4),
      horizon: new THREE.Color(0xf3e3c9),
      ground: new THREE.Color(0xb9c8a6),
      sun: new THREE.Color(0xfff3d0),
    };
    // Slight boost so ACES tone mapping keeps the sky saturated.
    for (const k of ['zenith', 'mid', 'horizon']) this.colors[k].multiplyScalar(1.15);

    this.sunDir = new THREE.Vector3(0.55, 0.78, -0.32).normalize();
    this.sunDistance = 240;

    // --- Fog + fallback background ---
    scene.background = new THREE.Color(0xf3e3c9);
    scene.fog = new THREE.Fog(new THREE.Color(0xf3e3c9), 250, 1100);

    // --- Sky dome ---
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1200, 32, 18),
      new THREE.ShaderMaterial({
        uniforms: {
          uTop: { value: this.colors.zenith },
          uMid: { value: this.colors.mid },
          uHorizon: { value: this.colors.horizon },
          uGround: { value: this.colors.ground },
          uSunDir: { value: this.sunDir },
          uSunColor: { value: this.colors.sun },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.sky.name = 'sky';
    this.group.add(this.sky);

    // --- Lights ---
    this.hemiLight = new THREE.HemisphereLight(0xbfe4ff, 0x668a3c, 0.6);
    this.group.add(this.hemiLight);

    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -120; cam.right = 120; cam.top = 120; cam.bottom = -120;
    cam.near = 1; cam.far = 500;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.target = new THREE.Object3D();
    sun.target.name = 'sunTarget';
    sun.position.copy(this.sunDir).multiplyScalar(this.sunDistance);
    this.sunLight = sun;
    this.group.add(sun);
    this.group.add(sun.target);
    this._shadowTexel = (cam.right - cam.left) / sun.shadow.mapSize.x;
    // Light-space basis used for texel snapping (matches the shadow camera's lookAt basis).
    this._lRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.sunDir).normalize();
    this._lUp = new THREE.Vector3().crossVectors(this.sunDir, this._lRight).normalize();
    this._tmp = new THREE.Vector3();

    // --- Clouds (GLB instanced, or 3 procedural shape variants) ---
    this._buildClouds();

    scene.add(this.group);
  }

  _buildClouds() {
    const rand = mulberry32(2024);
    const total = 36;
    // Instancing targets: one GLB group, or three procedural shape variants. Every target has
    // setMatrixAt(i, m) plus the InstancedMesh parts whose instanceMatrix is flagged after updates.
    const useAsset = !!(this.assets && this.assets.has('cloud'));
    let targets;
    if (useAsset) {
      const group = this.assets.instanced('cloud', total, { castShadow: false, receiveShadow: false });
      group.name = 'clouds';
      targets = [{ target: group, parts: group.parts, count: total }];
    } else {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x2b3a4d, emissiveIntensity: 0.35 });
      const variants = [makeCloudGeometry(rand, 5), makeCloudGeometry(rand, 6), makeCloudGeometry(rand, 7)];
      const per = Math.ceil(total / variants.length);
      targets = variants.map((geo, v) => {
        const mesh = new THREE.InstancedMesh(geo, mat, per);
        mesh.name = 'clouds' + v;
        return { target: mesh, parts: [mesh], count: per };
      });
    }
    this.clouds = [];
    this._cloudParts = [];
    this._cloudData = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const { target, parts, count } of targets) {
      const data = [];
      for (let i = 0; i < count; i++) {
        const ang = rand() * Math.PI * 2;
        const rad = 120 + Math.sqrt(rand()) * 620;
        const d = { x: -150 + Math.cos(ang) * rad, y: 80 + rand() * 80, z: Math.sin(ang) * rad, yaw: rand() * Math.PI * 2, sx: 0, sy: 0, sz: 0, speed: 0 };
        // GLB clouds keep their shape (uniform 0.6–1.4); the unit-size procedural blobs are stretched.
        if (useAsset) d.sx = d.sy = d.sz = 0.6 + rand() * 0.8;
        else { d.sx = 18 + rand() * 26; d.sy = 14 + rand() * 12; d.sz = 16 + rand() * 20; }
        d.speed = 1.8 + rand() * 1.6;
        data.push(d);
        p.set(d.x, d.y, d.z);
        q.setFromAxisAngle(_yAxis, d.yaw);
        s.set(d.sx, d.sy, d.sz);
        m.compose(p, q, s);
        target.setMatrixAt(i, m);
      }
      // Clouds drift and wrap, so they are never frustum culled (matrices are flagged here, no finish()).
      for (const part of parts) { part.instanceMatrix.needsUpdate = true; part.frustumCulled = false; }
      this.group.add(target);
      this.clouds.push(target);
      this._cloudParts.push(parts);
      this._cloudData.push(data);
    }
    this._cloudM = m; this._cloudQ = q; this._cloudP = p; this._cloudS = s;
  }

  /**
   * @param {number} dt seconds
   * @param {number} elapsed seconds since start
   * @param {THREE.Vector3} [focusPosition] player position; shadow frustum & sky follow it
   */
  update(dt, elapsed, focusPosition) {
    const fx = focusPosition ? focusPosition.x : 0;
    const fy = focusPosition ? focusPosition.y : 0;
    const fz = focusPosition ? focusPosition.z : 0;

    // Sky dome follows the player (horizon stays at world y ≈ 0).
    this.sky.position.set(fx, 0, fz);

    // Shadow camera: keep the light→target offset constant and snap the target to the
    // shadow texel grid in light space so shadow edges don't shimmer while driving.
    const tex = this._shadowTexel;
    const a = fx * this._lRight.x + fy * this._lRight.y + fz * this._lRight.z;
    const b = fx * this._lUp.x + fy * this._lUp.y + fz * this._lUp.z;
    const c = fx * this.sunDir.x + fy * this.sunDir.y + fz * this.sunDir.z;
    const sa = Math.round(a / tex) * tex, sb = Math.round(b / tex) * tex;
    const t = this._tmp;
    t.set(0, 0, 0)
      .addScaledVector(this._lRight, sa)
      .addScaledVector(this._lUp, sb)
      .addScaledVector(this.sunDir, c);
    this.sunLight.target.position.copy(t);
    this.sunLight.position.copy(t).addScaledVector(this.sunDir, this.sunDistance);
    this.sunLight.target.updateMatrixWorld();

    // Clouds drift with the wind (+X), wrapping around far away.
    const m = this._cloudM, q = this._cloudQ, p = this._cloudP, s = this._cloudS;
    const axis = _yAxis;
    for (let v = 0; v < this.clouds.length; v++) {
      const target = this.clouds[v];
      const data = this._cloudData[v];
      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        d.x += d.speed * dt;
        if (d.x > -150 + 780) d.x -= 1560;
        p.set(d.x, d.y + Math.sin(elapsed * 0.15 + i) * 2.0, d.z);
        q.setFromAxisAngle(axis, d.yaw);
        s.set(d.sx, d.sy, d.sz);
        m.compose(p, q, s);
        target.setMatrixAt(i, m);
      }
      const parts = this._cloudParts[v];
      for (let j = 0; j < parts.length; j++) parts[j].instanceMatrix.needsUpdate = true;
    }
  }
}

const _yAxis = new THREE.Vector3(0, 1, 0);
