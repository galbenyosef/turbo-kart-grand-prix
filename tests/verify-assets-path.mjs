// Exercises the GLB-asset code paths of Track and Environment with a FAKE asset library (no model
// files needed). Every asset "exists" as a box the size of the real, normalised model, so: the
// procedural tree/rock/tyre/rail/crowd InstancedMeshes must not be built, instance counts must
// match the planned scenery, the empty stands must be seated with animated GLB spectators (or the
// procedural blobs when only the stands exist), the FINISH banner must hang on the arch, bushes
// must stay off the road, and update() must keep flagging the crowd / cloud instance matrices.
// Run:  THREE_ROOT=<path>/node_modules/three node --import ./tests/register.mjs tests/verify-assets-path.mjs
import * as THREE from 'three';

// --- document stub (same as verify-track-build.mjs) ---
const noop = () => {};
function makeCtx() {
  const ctx = { fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '', lineJoin: '' };
  for (const m of ['fillRect', 'strokeRect', 'beginPath', 'closePath', 'fill', 'stroke', 'moveTo', 'lineTo', 'ellipse', 'arc',
    'quadraticCurveTo', 'strokeText', 'fillText', 'putImageData', 'save', 'restore', 'translate', 'rotate', 'scale', 'clearRect']) ctx[m] = noop;
  ctx.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctx.createLinearGradient = () => ({ addColorStop: noop });
  ctx.createRadialGradient = () => ({ addColorStop: noop });
  return ctx;
}
globalThis.document = { createElement: (tag) => ({ width: 0, height: 0, tagName: tag, getContext: () => makeCtx() }) };

const { Track, ASSET_YAW, GRANDSTAND_TILE, CROWD_TIERS } = await import('../src/track.js');
const { Environment } = await import('../src/environment.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// --- Fake asset library: boxes with the real models' normalised sizes [w, h, d, grounded] ---
const SIZES = {
  tree_pine: [6.5, 11, 6.2, true], tree_round: [8, 8.5, 7.6, true], tree_palm: [9.7, 9.5, 9.9, true],
  tree_autumn: [6, 9, 6, true], tree_birch: [4, 12, 4, true], bush: [1.6, 1.1, 1.4, true],
  rock: [2.25, 1.83, 2.4, true], tyre_stack: [1.52, 1.0, 1.52, true], rail: [4.0, 1.37, 0.59, true],
  cloud: [24, 12.6, 36, false], cloud_b: [24, 36, 12.6, false],   // cloud_b arrives as an upright slab
  grandstand: [20.4, 14, 12.25, true], grandstand_empty: [20.4, 14, 12.25, true], finish_arch: [24, 15.4, 7.75, true],
  spectator_a_up: [0.6, 1.6, 0.4, true], spectator_b_up: [0.6, 1.6, 0.4, true], spectator_c_up: [0.6, 1.6, 0.4, true],
  spectator_a_down: [0.6, 1.5, 0.4, true], spectator_b_down: [0.6, 1.5, 0.4, true], spectator_c_down: [0.6, 1.5, 0.4, true],
};
function fakeGeometry(name, shrink = 1) {
  if (!SIZES[name]) throw new Error(`unexpected asset requested: ${name}`);
  const [w, h, d, grounded] = SIZES[name];
  const g = new THREE.BoxGeometry(w * shrink, h * shrink, d * shrink);
  g.translate(0, grounded ? (h * shrink) / 2 : 0, 0);
  g.computeBoundingBox();
  return g;
}
function makeFakeAssets(has) {
  const calls = { instanced: {}, clone: {}, finished: [] };
  const assets = {
    has,
    instanced(name, count, { castShadow = true, receiveShadow = false } = {}) {
      calls.instanced[name] = (calls.instanced[name] || 0) + count;
      const group = new THREE.Group();
      group.name = `${name}×${count}`;
      // Two sub-meshes, like a real multi-material model, so multi-part flagging is exercised.
      const parts = [fakeGeometry(name), fakeGeometry(name, 0.5)].map((geo) => {
        const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial(), count);
        im.castShadow = castShadow; im.receiveShadow = receiveShadow; im.frustumCulled = false;
        im.userData.asset = name;
        group.add(im);
        return im;
      });
      group.setMatrixAt = (i, matrix) => { for (const p of parts) p.setMatrixAt(i, matrix); };
      group.finish = () => { calls.finished.push(name); for (const p of parts) { p.instanceMatrix.needsUpdate = true; p.computeBoundingSphere(); p.frustumCulled = true; } };
      group.parts = parts;
      return group;
    },
    clone(name, { castShadow = true, receiveShadow = false } = {}) {
      calls.clone[name] = (calls.clone[name] || 0) + 1;
      const g = new THREE.Group();
      g.name = name;
      const mesh = new THREE.Mesh(fakeGeometry(name), new THREE.MeshStandardMaterial());
      mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow; mesh.userData.asset = name;
      g.add(mesh);
      return g;
    },
  };
  return { assets, calls };
}
const { assets, calls } = makeFakeAssets(() => true);

// --- Build with every asset, plus the procedural build as the reference for the planned counts ---
const scene = new THREE.Scene();
let track;
try {
  track = new Track(scene, null, assets);
} catch (e) {
  console.log('FAIL  Track constructor threw with assets:\n', e.stack);
  process.exit(1);
}
const ref = new Track(new THREE.Scene(), null);
scene.updateMatrixWorld(true);
const find = (root, n) => { let r = null; root.traverse((o) => { if (o.name === n) r = o; }); return r; };
const T = (n) => find(track.group, n), R = (n) => find(ref.group, n);
console.log(`      instanced: ${JSON.stringify(calls.instanced)}\n      clones: ${JSON.stringify(calls.clone)}`);

check('assets stored on the track', track.assets === assets);
{
  const stray = [];
  track.group.traverse((o) => { if (o.isInstancedMesh && !o.userData.asset) stray.push(o.name || o.type); });
  check('no procedural InstancedMeshes when assets are present', stray.length === 0, stray.join(', '));
}
check('no procedural crowd blobs / balloons / stand mesh', !T('spectators') && !T('balloons') && !T('balloonsTinted') && !!T('grandstands') && !T('grandstands').isMesh);
check('procedural structures mesh kept (sponsor arch, billboards, poles)', !!T('structures')?.isMesh && !!T('banner_TURBO KART GP'));

// Instance counts = planned counts (identical planning on both paths).
for (const [name, group, refName] of [['rock', 'rocks', 'rocks'], ['tyre_stack', 'tyres', 'tyres'], ['rail', 'rails', 'rails']]) {
  const n = R(refName).count;
  check(`${name} instances = planned ${n}`, calls.instanced[name] === n && T(group)?.parts[0].count === n, `${calls.instanced[name]}`);
}
check('rails = 2 x floor(length / 4)', calls.instanced.rail === 2 * Math.floor(track.length / 4), `${calls.instanced.rail}`);
{
  const kinds = ['tree_pine', 'tree_round', 'tree_palm', 'tree_autumn', 'tree_birch'];
  const total = kinds.reduce((s, k) => s + (calls.instanced[k] || 0), 0);
  check('five tree varieties, each present, total = track.treeCount = procedural total', kinds.every((k) => calls.instanced[k] > 0) && total === track.treeCount && total === ref.treeCount, kinds.map((k) => `${k}=${calls.instanced[k]}`).join(' '));
}
check('static groups finished exactly once', ['tree_pine', 'tree_round', 'tree_palm', 'tree_autumn', 'tree_birch', 'bush', 'rock', 'tyre_stack', 'rail'].every((n) => calls.finished.filter((f) => f === n).length === 1), calls.finished.join(','));
const tiles = (st) => (GRANDSTAND_TILE ? Math.max(1, Math.round(st.length / SIZES.grandstand_empty[0])) : 1);
check(`empty grandstand clones (${GRANDSTAND_TILE ? 'tiled' : 'one per stand'}), crowd version unused`, calls.clone.grandstand_empty === track._stands.reduce((s, st) => s + tiles(st), 0) && !calls.clone.grandstand && T('grandstands').children.length === calls.clone.grandstand_empty, `${calls.clone.grandstand_empty}`);
check('one finish arch clone', calls.clone.finish_arch === 1 && !!T('finish_arch'));
{
  const noShadow = [];
  track.group.traverse((o) => { if (o.userData.asset && !o.castShadow) noShadow.push(o.userData.asset); });
  check('every asset mesh casts shadows', noShadow.length === 0, noShadow.join(','));
}

// Trees: ground - 0.2, planned scale jitter, clear of the road. Tyres: the procedural positions.
{
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  let ok = true, minLat = Infinity;
  for (const n of ['pines', 'trees', 'palms', 'autumn', 'birches']) {
    const part = T(n).parts[0];
    for (let i = 0; i < part.count; i++) {
      part.getMatrixAt(i, m); m.decompose(pos, q, sc);
      if (Math.abs(pos.y - (track.field.height(pos.x, pos.z) - 0.2)) > 1e-3 || sc.x < 0.8 || sc.x > 1.35) ok = false;
      minLat = Math.min(minLat, Math.abs(track.getRoadInfo(pos).lateral));
    }
  }
  check('trees grounded with the planned scale jitter, >= wallDistance + 5 m', ok && minLat >= track.wallDistance + 5, `min |lateral| ${minLat.toFixed(1)} m`);
  const part = T('tyres').parts[0], refMesh = R('tyres'), mr = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3();
  let maxPos = 0;
  for (let i = 0; i < part.count; i++) { part.getMatrixAt(i, m); refMesh.getMatrixAt(i, mr); maxPos = Math.max(maxPos, a.setFromMatrixPosition(m).distanceTo(b.setFromMatrixPosition(mr))); }
  check('tyre stacks at the procedural positions', maxPos < 1e-6, `max ${maxPos.toExponential(1)}`);
}

// Bushes: ~120, on the verge outside the barriers or among the trees, never on the road.
{
  const part = T('bushes')?.parts[0], m = new THREE.Matrix4(), pos = new THREE.Vector3();
  let minLat = Infinity, verge = 0;
  for (let i = 0; part && i < part.count; i++) {
    part.getMatrixAt(i, m); pos.setFromMatrixPosition(m);
    const lat = Math.abs(track.getRoadInfo(pos).lateral);
    minLat = Math.min(minLat, lat);
    if (lat <= track.wallDistance + 6.2) verge++;
  }
  check('~120 bushes off the road, most on the verge just outside the barriers', part && part.count >= 100 && part.count <= 120 && minLat >= track.wallDistance + 1.5 && verge >= 60, `${part?.count} bushes, ${verge} on the verge, min |lateral| ${minLat.toFixed(1)} m`);
}

// Rails: bar (local X) along the tangent, stretched to 4.45 m, front toward the road per ASSET_YAW.rail.
{
  const part = T('rails').parts[0], m = new THREE.Matrix4(), ax = new THREE.Vector3(), az = new THREE.Vector3(), pos = new THREE.Vector3();
  const perSide = part.count / 2;
  let ok = true, worstAlong = 1, worstFront = 1;
  for (let idx = 0; idx < part.count; idx += 7) {
    const side = idx < perSide ? -1 : 1, k = idx % perSide;
    part.getMatrixAt(idx, m);
    pos.setFromMatrixPosition(m);
    ax.setFromMatrixColumn(m, 0); az.setFromMatrixColumn(m, 2);
    const stretch = ax.length(); ax.normalize(); az.normalize();
    const s = track.sampleAt((k * 4) / track.length);
    const tg = s.tangent.clone().setY(0).normalize();
    worstAlong = Math.min(worstAlong, Math.abs(ax.dot(tg)));
    worstFront = Math.min(worstFront, az.dot(s.right) * -side * Math.cos(ASSET_YAW.rail));
    if (Math.abs(stretch - 4.45 / 4) > 1e-3 || Math.abs(Math.abs(track.getRoadInfo(pos).lateral) - (track.wallDistance + 0.3)) > 0.05) ok = false;
  }
  check('rail bars run along the tangent (x1.1125), at the wall line', ok && worstAlong > 0.999, `min |along| ${worstAlong.toFixed(4)}`);
  check('rail fronts face the road (per ASSET_YAW.rail)', worstFront > 0.99, `min ${worstFront.toFixed(3)}`);
}

// Rocks: grounded model partly buried, beyond the walls.
{
  const part = T('rocks').parts[0], m = new THREE.Matrix4(), pos = new THREE.Vector3();
  let ok = true, maxSink = 0, minSink = Infinity;
  for (let i = 0; i < part.count; i++) {
    part.getMatrixAt(i, m); pos.setFromMatrixPosition(m);
    const sink = track.field.height(pos.x, pos.z) - pos.y;
    maxSink = Math.max(maxSink, sink); minSink = Math.min(minSink, sink);
    if (Math.abs(track.getRoadInfo(pos).lateral) < track.wallDistance + 3) ok = false;
  }
  check('rocks partly buried (0.1..1.2 m) beyond the walls', ok && minSink > 0.1 && maxSink < 1.2, `sink ${minSink.toFixed(2)}..${maxSink.toFixed(2)} m`);
}

// Grandstands: copies end up with their track-side edge on the planned line, planned length, seating toward the track.
{
  const stands = T('grandstands'), box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
  let ok = true, off = 0;
  const notes = [];
  track._stands.forEach((st, i) => {
    const n = tiles(st), clones = stands.children.slice(off, off + n);
    off += n;
    box.makeEmpty();
    for (const c of clones) box.expandByObject(c);
    box.getSize(size); box.getCenter(centre);
    const away = Math.sign(st.ry);
    const frontX = away > 0 ? box.min.x : box.max.x;
    if (Math.abs(frontX - st.x) > 0.05 || Math.abs(size.z - st.length) > 0.05 || Math.abs(centre.z - st.z) > 0.05 || Math.abs(box.min.y + 0.05) > 0.05) ok = false;
    const seat = new THREE.Vector3(0, 0, 1).applyQuaternion(clones[0].quaternion);
    if (Math.abs(seat.x * -away - Math.cos(ASSET_YAW.grandstand)) > 0.01) ok = false;
    notes.push(`stand${i}: ${n} copies, front x=${frontX.toFixed(2)} (planned ${st.x}), length ${size.z.toFixed(2)} (planned ${st.length})`);
  });
  check('grandstand copies placed on the planned footprint facing the track', ok, notes.join(' | '));
}

// Crowd: six GLB spectator sets seated inside the stands' footprints on rising rows, animated.
const SPECTATORS = ['spectator_a_up', 'spectator_b_up', 'spectator_c_up', 'spectator_a_down', 'spectator_b_down', 'spectator_c_down'];
{
  const total = SPECTATORS.reduce((s, n) => s + (calls.instanced[n] || 0), 0);
  const ups = SPECTATORS.filter((n) => n.endsWith('_up')).reduce((s, n) => s + (calls.instanced[n] || 0), 0);
  check('300..600 spectators over six models, ~40 % arms up', total === track.spectatorCount && total >= 300 && total <= 600 && SPECTATORS.every((n) => calls.instanced[n] > 0) && Math.abs(ups / total - CROWD_TIERS.upShare) < 0.08, `${total} total, ${(100 * ups / total).toFixed(0)} % up`);
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), fwd = new THREE.Vector3();
  const H = SIZES.grandstand_empty[1], D = SIZES.grandstand_empty[2];
  let ok = true, minH = Infinity, maxH = 0;
  for (const n of SPECTATORS) {
    const part = T('spectators_' + n).parts[0];
    for (let i = 0; i < part.count; i++) {
      part.getMatrixAt(i, m); m.decompose(pos, q, sc);
      const st = track._stands.find((s) => Math.abs(pos.z - s.z) <= s.length / 2 + 0.5);
      if (!st) { ok = false; continue; }
      const away = Math.sign(st.ry), depth = (pos.x - st.x) * away;
      if (depth < D * CROWD_TIERS.depthFrom - 0.2 || depth > D * CROWD_TIERS.depthTo + 0.2) ok = false;
      if (sc.x < 0.85 || sc.x > 1.15) ok = false;
      fwd.set(0, 0, 1).applyQuaternion(q);
      if (fwd.x * -away * Math.cos(ASSET_YAW.spectator) < Math.cos(0.3)) ok = false;   // faces the track (±0.25 rad jitter)
      minH = Math.min(minH, pos.y); maxH = Math.max(maxH, pos.y);
    }
  }
  check('spectators on the tier rows, scaled 0.85..1.15, facing the track', ok && minH > H * CROWD_TIERS.heightFrom - 0.5 && maxH < H * CROWD_TIERS.heightTo + 1.0, `heights ${minH.toFixed(2)}..${maxH.toFixed(2)} m (tiers ${(H * CROWD_TIERS.heightFrom).toFixed(1)}..${(H * CROWD_TIERS.heightTo).toFixed(1)})`);
  // update(): crowd parts flagged dirty (needsUpdate is write-only on BufferAttribute: a flag bumps `version`), static parts untouched.
  const crowdParts = SPECTATORS.flatMap((n) => T('spectators_' + n).parts), treeParts = T('pines').parts;
  const v0 = crowdParts.map((p) => p.instanceMatrix.version), t0 = treeParts.map((p) => p.instanceMatrix.version);
  let err = null, moved = 0;
  const before = new Float32Array(crowdParts[0].instanceMatrix.array);
  try { track.update(0.016, 1); for (let i = 0; i < 120; i++) track.update(1 / 60, 1 + i / 60); } catch (e) { err = e; }
  const after = crowdParts[0].instanceMatrix.array;
  for (let i = 0; i < crowdParts[0].count; i++) { for (let k = 0; k < 16; k++) if (after[i * 16 + k] !== before[i * 16 + k]) { moved++; break; } }
  check('track.update() runs with assets (121 frames)', !err, err?.stack);
  check('crowd instance matrices flagged dirty and moving', crowdParts.every((p, i) => p.instanceMatrix.version > v0[i]) && moved > crowdParts[0].count / 2, `${moved}/${crowdParts[0].count} instances of set 0 changed`);
  check('static tree matrices untouched by update()', treeParts.every((p, i) => p.instanceMatrix.version === t0[i]));
  // The wave: force one to start and make sure it lifts a band of seats by up to 0.4 m.
  const wave = track._crowdWaves[0];
  wave.t = -1; wave.next = 0;
  track.update(1 / 60, 500);            // starts
  track.update(1 / 60, 500 + 1.25);     // half way along the stand
  const set = track._crowdSets.find((s) => s.count > 20);
  let lifted = 0;
  const arr = set.parts[0].instanceMatrix.array;
  for (let i = 0; i < set.count; i++) if (set.stand[i] === 0 && Math.abs(set.along[i] - wave.pos) < 0.05 && arr[i * 16 + 13] - set.base[i * 3 + 1] > 0.25) lifted++;
  check('wave ripple lifts the seats it passes', lifted > 0, `${lifted} lifted near along=${wave.pos.toFixed(2)}`);
}

// FINISH banner + arch.
{
  const arch = T('finish_arch'), banner = T('banner_FINISH');
  const k = 32 / SIZES.finish_arch[0], H = SIZES.finish_arch[1] * k, D = SIZES.finish_arch[2] * k;
  const s0 = track.sampleAt(0);   // heading +Z at the line, so the approach side is -Z
  banner.geometry.computeBoundingBox();
  const c = banner.geometry.boundingBox.getCenter(new THREE.Vector3()), sz = banner.geometry.boundingBox.getSize(new THREE.Vector3());
  const yOk = Math.abs(c.y - (s0.position.y - 0.05 + 0.72 * H)) < 0.05;
  const zOk = c.z < s0.position.z - D / 2 && c.z > s0.position.z - D / 2 - 0.5;
  check('FINISH banner kept, across the arch top on the approach side', yOk && zOk && Math.abs(sz.x - 24) < 0.05 && Math.abs(sz.y - 3.2) < 0.01, `centre y=${c.y.toFixed(2)} (arch ${H.toFixed(1)} m tall), z=${c.z.toFixed(2)}`);
  check('arch scaled to the 32 m span at the line, yawed by ASSET_YAW.finish_arch', Math.abs(arch.scale.x - k) < 1e-6 && arch.scale.y === arch.scale.x && Math.abs(arch.rotation.y - ASSET_YAW.finish_arch) < 0.02 && arch.position.distanceTo(s0.position) < 0.1);
}
{
  let draws = 0;
  track.group.traverse((o) => { if (o.isMesh) draws++; });
  console.log(`      track meshes with assets: ${draws} (each fake asset has 2 sub-meshes)`);
}

// --- Fallback: empty stands but no spectator models → procedural blobs on the same rows, animated ---
{
  const fb = makeFakeAssets((n) => !n.startsWith('spectator_'));
  let t2 = null, err = null;
  try { t2 = new Track(new THREE.Scene(), null, fb.assets); for (let i = 0; i < 30; i++) t2.update(1 / 60, i / 60); } catch (e) { err = e; }
  const blobs = t2 && find(t2.group, 'spectators');
  check('no spectator models → procedural blobs seated on the empty stands and animated', !err && blobs?.isInstancedMesh && blobs.count === track.spectatorCount && blobs.instanceMatrix.version > 1 && fb.calls.clone.grandstand_empty > 0, err ? err.stack : `${blobs?.count} blobs`);
}

// --- Environment: instanced GLB clouds alternating between the two models, drifting ---
let env;
try {
  env = new Environment(new THREE.Scene(), null, assets);
} catch (e) {
  console.log('FAIL  Environment constructor threw with assets:\n', e.stack);
  process.exit(1);
}
check('36 clouds split over cloud / cloud_b, no procedural cloud meshes', calls.instanced.cloud === 18 && calls.instanced.cloud_b === 18 && env.clouds.length === 2 && env._cloudData.every((d) => d.length === 18) && !find(env.group, 'clouds0'));
{
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3();
  let ok = true, sMin = Infinity, sMax = 0, flatOk = true;
  env.clouds.forEach((group, v) => {
    for (let i = 0; i < 18; i++) {
      group.parts[0].getMatrixAt(i, m); m.decompose(pos, q, sc);
      if (Math.abs(sc.x - sc.y) > 1e-6 || Math.abs(sc.x - sc.z) > 1e-6 || pos.y < 80 || pos.y > 160) ok = false;
      sMin = Math.min(sMin, sc.x); sMax = Math.max(sMax, sc.x);
      up.set(0, 1, 0).applyQuaternion(q);
      if (v === 1 ? Math.abs(up.y) > 1e-6 : Math.abs(up.y - 1) > 1e-6) flatOk = false;   // cloud_b (upright slab) laid flat, cloud upright
    }
  });
  check('clouds uniformly scaled 0.6..1.4 at 80..160 m', ok && sMin >= 0.6 && sMax <= 1.4, `scale ${sMin.toFixed(2)}..${sMax.toFixed(2)}`);
  check('cloud_b slab laid flat, cloud kept upright', flatOk && env._cloudFlat[0] === false && env._cloudFlat[1] === true);
  const parts = env.clouds.flatMap((g) => g.parts);
  check('cloud parts never culled, no shadows', parts.every((p) => p.frustumCulled === false && p.castShadow === false));
  const v0 = parts.map((p) => p.instanceMatrix.version), x0 = env._cloudData[1][0].x, focus = new THREE.Vector3(10, 2, 30);
  let err = null;
  try { env.update(0.016, 1, focus); for (let i = 0; i < 120; i++) env.update(1 / 60, 1 + i / 60, focus); } catch (e) { err = e; }
  check('env.update() runs with assets (121 frames)', !err, err?.stack);
  check('both cloud groups flagged dirty and drifting', parts.every((p, i) => p.instanceMatrix.version > v0[i]) && env._cloudData[1][0].x !== x0);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
