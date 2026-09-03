// assets.js — GLB asset library for the Tripo-generated low-poly set.
//
// Every model is normalised once at load time (uniform scale to a target size, centred on XZ,
// grounded or centred on Y, yaw-corrected) by baking the transform straight into the geometry,
// so a loaded asset is a flat Group of identity-transform meshes. That makes them trivially
// cloneable for karts/items and directly usable as InstancedMesh sources for scenery.
//
// Everything degrades gracefully: a missing or failed model simply reports `has(name) === false`
// and callers fall back to their procedural builders, so the game (and the Node tests) never
// depend on the files being present.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Per-asset normalisation:
 *   size  — target extent in metres along `axis` ('x' | 'y' | 'z' | 'max')
 *   ground — true: rest the model on y = 0; false: centre it vertically
 *   rotY  — extra yaw (radians) applied after auto-orientation, to make the model face +Z
 *   rotX, rotZ — extra pitch / roll (radians) for models generated lying on their side
 *   tint  — model accepts per-instance tinting (bright/desaturated texels take the tint colour)
 */
export const ASSET_MANIFEST = {
  kart_body:        { size: 2.2,  axis: 'z',   ground: true,  rotY: Math.PI, tint: true },  // generated nose-to-−Z: flip to face +Z
  kart_wheel:       { size: 0.68, axis: 'y',   ground: false, rotY: 0 },
  driver:           { size: 1.15, axis: 'y',   ground: true,  rotY: Math.PI, tint: true },  // same: generated facing −Z
  tree_pine:        { size: 11,   axis: 'y',   ground: true },
  tree_round:       { size: 8.5,  axis: 'y',   ground: true },
  tree_palm:        { size: 9.5,  axis: 'y',   ground: true },
  rock:             { size: 2.4,  axis: 'max', ground: true },
  cloud:            { size: 36,   axis: 'max', ground: false, rotZ: Math.PI / 2 },  // generated as a tall slab: lay it flat
  balloon:          { size: 13,   axis: 'y',   ground: false },
  tyre_stack:       { size: 1.0,  axis: 'y',   ground: true },
  rail:             { size: 4.0,  axis: 'x',   ground: true,  rotY: Math.PI / 2 },  // generated along Z → run it along X
  grandstand:       { size: 14,   axis: 'y',   ground: true,  rotY: Math.PI / 2 },  // 14 m tall → ≈20 m long along X
  finish_arch:      { size: 24,   axis: 'x',   ground: true,  rotY: Math.PI / 2 },  // span along X
  item_mushroom:    { size: 0.9,  axis: 'y',   ground: false },
  item_banana:      { size: 0.9,  axis: 'max', ground: false },
  item_shell_green: { size: 0.9,  axis: 'max', ground: false },
  item_shell_red:   { size: 0.9,  axis: 'max', ground: false },
  item_star:        { size: 0.9,  axis: 'max', ground: false },
  item_bomb:        { size: 0.85, axis: 'y',   ground: false },
  // second batch: crowd, empty stand, extra vegetation, second cloud
  grandstand_empty: { size: 14,   axis: 'y',   ground: true,  rotY: Math.PI / 2 },
  spectator_a_up:   { size: 1.6,  axis: 'y',   ground: true, rotY: -Math.PI / 2 }, // generated facing -X
  spectator_a_down: { size: 1.5,  axis: 'y',   ground: true, rotY: -Math.PI / 2 }, // generated facing -X
  spectator_b_up:   { size: 1.6,  axis: 'y',   ground: true, rotY: -Math.PI / 2 }, // generated facing -X
  spectator_b_down: { size: 1.5,  axis: 'y',   ground: true, rotY: -Math.PI / 2 }, // generated facing -X
  spectator_c_up:   { size: 1.6,  axis: 'y',   ground: true, rotY: -Math.PI / 2 }, // generated facing -X
  spectator_c_down: { size: 1.5,  axis: 'y',   ground: true, rotY: -Math.PI / 2 }, // generated facing -X
  tree_autumn:      { size: 9,    axis: 'y',   ground: true },
  tree_birch:       { size: 12,   axis: 'y',   ground: true },
  bush:             { size: 1.6,  axis: 'max', ground: true },
  cloud_b:          { size: 36,   axis: 'max', ground: false },
};

const MODEL_DIR = 'assets/models/';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Bakes a mesh's world transform + the normalisation matrix into its geometry. */
function bakeMesh(mesh, normalize) {
  const geo = mesh.geometry.clone();
  _m.multiplyMatrices(normalize, mesh.matrixWorld);
  geo.applyMatrix4(_m);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const out = new THREE.Mesh(geo, mesh.material);
  out.name = mesh.name;
  out.castShadow = true;
  out.receiveShadow = false;
  return out;
}

/** Tint support: bright, low-saturation texels (white paint) take the tint; dark/colourful ones keep theirs. */
function makeTintable(material, tint) {
  const mat = material.clone();
  const uTint = { value: new THREE.Color(tint) };
  mat.userData.tint = uTint;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = uTint;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTint;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 c = diffuseColor.rgb;
          float lum = dot(c, vec3(0.299, 0.587, 0.114));
          float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
          // paint (bright, unsaturated, incl. baked shading) takes the tint; engine greys, black and
          // deliberately coloured details keep their own colour
          float mask = smoothstep(0.3, 0.52, lum) * (1.0 - smoothstep(0.28, 0.55, sat));
          diffuseColor.rgb = mix(c, c * uTint, mask);
        }`
      );
  };
  mat.customProgramCacheKey = () => 'tkgp-tint';
  mat.needsUpdate = true;
  return mat;
}

export class AssetLibrary {
  constructor(baseUrl = MODEL_DIR) {
    this.baseUrl = baseUrl;
    this.loader = new GLTFLoader();
    this.models = new Map();   // name → { root: Group, meshes: Mesh[], cfg }
    this.errors = new Map();   // name → Error
    this.enabled = true;
  }

  has(name) { return this.models.has(name); }
  get loadedCount() { return this.models.size; }

  /** Loads every manifest entry; never rejects. onProgress(done, total, name). */
  async loadAll(onProgress, names = Object.keys(ASSET_MANIFEST)) {
    let done = 0;
    await Promise.all(names.map(async (name) => {
      try {
        await this.load(name);
      } catch (err) {
        this.errors.set(name, err);
        console.warn(`[assets] ${name}: falling back to procedural (${err?.message || err})`);
      }
      done++;
      onProgress?.(done, names.length, name);
    }));
    return this.models.size;
  }

  async load(name) {
    const cfg = ASSET_MANIFEST[name];
    if (!cfg) throw new Error(`unknown asset "${name}"`);
    const url = `${this.baseUrl}${name}.glb`;
    const gltf = await this.loader.loadAsync(url);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    // Auto-orientation for forward-facing assets: yaw so the longest horizontal extent lies on Z.
    _box.setFromObject(scene);
    _box.getSize(_size);
    let autoYaw = 0;
    if (cfg.axis === 'z' && _size.x > _size.z * 1.15) autoYaw = Math.PI / 2;

    // Normalisation: the model is parented under a rotated group (so mesh.matrixWorld already carries the
    // yaw/pitch/roll); the bake matrix then only scales and translates (centre XZ, ground or centre Y).
    const euler = new THREE.Euler(cfg.rotX || 0, autoYaw + (cfg.rotY || 0), cfg.rotZ || 0, 'YXZ');
    const rotated = new THREE.Group();
    rotated.add(scene);
    rotated.rotation.copy(euler);
    rotated.updateMatrixWorld(true);
    _box.setFromObject(rotated);
    _box.getSize(_size);
    _box.getCenter(_center);
    const extent = cfg.axis === 'max' ? Math.max(_size.x, _size.y, _size.z) : _size[cfg.axis];
    const s = extent > 1e-6 ? cfg.size / extent : 1;
    const ty = cfg.ground ? -_box.min.y * s : -_center.y * s;
    const normalize = new THREE.Matrix4()
      .makeTranslation(-_center.x * s, ty, -_center.z * s)
      .multiply(new THREE.Matrix4().makeScale(s, s, s));

    const meshes = [];
    rotated.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        m.side = THREE.FrontSide;
        if (m.transparent && m.opacity >= 0.99) m.transparent = false;
      }
      // A multi-material mesh is split so every mesh has exactly one material (instancing needs that).
      if (Array.isArray(o.material) && o.geometry.groups?.length) {
        o.geometry.groups.forEach((g, gi) => {
          const sub = o.geometry.clone();
          sub.clearGroups();
          const idx = sub.index ? sub.index.array.slice(g.start, g.start + g.count) : null;
          if (idx) sub.setIndex(new THREE.BufferAttribute(idx, 1));
          const tmp = new THREE.Mesh(sub, o.material[g.materialIndex ?? gi]);
          tmp.matrixWorld.copy(o.matrixWorld);
          meshes.push(bakeMesh(tmp, normalize));
        });
      } else {
        meshes.push(bakeMesh(o, normalize));
      }
    });
    if (!meshes.length) throw new Error('no meshes in file');

    const root = new THREE.Group();
    root.name = name;
    for (const m of meshes) root.add(m);
    let tris = 0;
    for (const m of meshes) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    const entry = { root, meshes, cfg, triangles: tris | 0 };
    this.models.set(name, entry);
    return entry;
  }

  /** Deep-clones an asset. `tint` (hex/Color) recolours bright texels; materials are shared otherwise. */
  clone(name, { tint = null, castShadow = true, receiveShadow = false } = {}) {
    const entry = this.models.get(name);
    if (!entry) return null;
    const g = new THREE.Group();
    g.name = name;
    for (const src of entry.meshes) {
      const mesh = new THREE.Mesh(src.geometry, tint != null && entry.cfg.tint ? makeTintable(src.material, tint) : src.material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      g.add(mesh);
    }
    return g;
  }

  /** Materials of a clone that carry a tint uniform (for star flashes etc.). */
  static tintMaterials(group) {
    const out = [];
    group.traverse((o) => { if (o.isMesh && o.material?.userData?.tint) out.push(o.material); });
    return out;
  }

  /**
   * Builds one InstancedMesh per sub-mesh of an asset, all sharing the same instance matrices.
   * Returns a Group; call `setMatrixAt(i, matrix)` on it and `finish()` when done.
   */
  instanced(name, count, { castShadow = true, receiveShadow = false } = {}) {
    const entry = this.models.get(name);
    if (!entry) return null;
    const group = new THREE.Group();
    group.name = `${name}×${count}`;
    const parts = entry.meshes.map((src) => {
      const im = new THREE.InstancedMesh(src.geometry, src.material, count);
      im.castShadow = castShadow;
      im.receiveShadow = receiveShadow;
      im.frustumCulled = false;
      group.add(im);
      return im;
    });
    group.setMatrixAt = (i, matrix) => { for (const p of parts) p.setMatrixAt(i, matrix); };
    group.finish = () => { for (const p of parts) { p.instanceMatrix.needsUpdate = true; p.computeBoundingSphere(); p.frustumCulled = true; } };
    group.parts = parts;
    return group;
  }

  /** Approximate triangle count of an asset (for budgeting / stats). */
  triangles(name) { return this.models.get(name)?.triangles ?? 0; }
}
