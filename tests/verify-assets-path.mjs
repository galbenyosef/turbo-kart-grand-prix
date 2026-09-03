// Exercises the GLB-asset code paths of Track and Environment with a FAKE asset library (no model
// files needed). Every asset "exists" as a box the size of the real, normalised model, so: the
// procedural tree/rock/tyre/rail/balloon/crowd InstancedMeshes must not be built, instance counts
// must match the planned scenery (the same planning as the procedural build), the FINISH banner
// must hang on the arch, and update() must keep flagging the balloon / cloud instance matrices.
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

const { Track, ASSET_YAW, GRANDSTAND_TILE } = await import('../src/track.js');
const { Environment } = await import('../src/environment.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

// --- Fake asset library: boxes with the real models' normalised sizes [w, h, d, grounded] ---
const SIZES = {
  tree_pine: [6.5, 11, 6.2, true], tree_round: [8, 8.5, 7.6, true], tree_palm: [9.7, 9.5, 9.9, true],
  rock: [2.25, 1.83, 2.4, true], tyre_stack: [1.52, 1.0, 1.52, true], rail: [4.0, 1.37, 0.59, true],
  balloon: [8.4, 13, 8.4, false], cloud: [24, 12.6, 36, false],
  grandstand: [20.4, 14, 12.25, true], finish_arch: [24, 15.4, 7.75, true],
};
function fakeGeometry(name, shrink = 1) {
  if (!SIZES[name]) throw new Error(`unexpected asset requested: ${name}`);
  const [w, h, d, grounded] = SIZES[name];
  const g = new THREE.BoxGeometry(w * shrink, h * shrink, d * shrink);
  g.translate(0, grounded ? (h * shrink) / 2 : 0, 0);
  g.computeBoundingBox();
  return g;
}
const calls = { instanced: {}, clone: {}, finished: [] };
const assets = {
  has: () => true,
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

// --- Build with assets, plus the procedural build as the reference for the planned counts ---
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
check('no spectator crowd / procedural balloons / procedural stand mesh', !T('spectators') && !T('balloonsTinted') && !T('balloonsPlain') && !!T('grandstands') && !T('grandstands').isMesh);
check('procedural structures mesh kept (sponsor arch, billboards, poles)', !!T('structures')?.isMesh && !!T('banner_TURBO KART GP'));

// Instance counts = planned counts (identical planning on both paths).
const groupOf = { tree_pine: 'pines', tree_round: 'trees', tree_palm: 'palms', rock: 'rocks', tyre_stack: 'tyres', rail: 'rails', balloon: 'balloons' };
const planned = { tree_pine: R('pines').count, tree_round: R('trees').count, tree_palm: R('palms').count, rock: R('rocks').count, tyre_stack: R('tyres').count, rail: R('rails').count, balloon: R('balloonsTinted').count };
for (const [name, n] of Object.entries(planned)) check(`${name} instances = planned ${n}`, calls.instanced[name] === n && T(groupOf[name])?.parts[0].count === n, `${calls.instanced[name]}`);
check('rails = 2 x floor(length / 4)', calls.instanced.rail === 2 * Math.floor(track.length / 4), `${calls.instanced.rail}`);
check('trees total = track.treeCount', calls.instanced.tree_pine + calls.instanced.tree_round + calls.instanced.tree_palm === track.treeCount, `${track.treeCount}`);
check('static groups finished exactly once', ['tree_pine', 'tree_round', 'tree_palm', 'rock', 'tyre_stack', 'rail'].every((n) => calls.finished.filter((f) => f === n).length === 1), calls.finished.join(','));
check('animated balloons not finished, never culled', !calls.finished.includes('balloon') && T('balloons').parts.every((p) => p.frustumCulled === false));
const tiles = (st) => (GRANDSTAND_TILE ? Math.max(1, Math.round(st.length / SIZES.grandstand[0])) : 1);
check(`grandstand clones (${GRANDSTAND_TILE ? 'tiled' : 'one per stand'})`, calls.clone.grandstand === track._stands.reduce((s, st) => s + tiles(st), 0) && T('grandstands').children.length === calls.clone.grandstand, `${calls.clone.grandstand}`);
check('one finish arch clone', calls.clone.finish_arch === 1 && !!T('finish_arch'));
{
  const noShadow = [];
  track.group.traverse((o) => { if (o.userData.asset && !o.castShadow) noShadow.push(o.userData.asset); });
  check('every asset mesh casts shadows', noShadow.length === 0, noShadow.join(','));
}

// Trees / tyres: the same per-instance matrices as the procedural build.
{
  const m = new THREE.Matrix4(), mr = new THREE.Matrix4();
  let maxDiff = 0;
  for (const n of ['pines', 'trees', 'palms']) {
    const part = T(n).parts[0], refMesh = R(n);
    for (let i = 0; i < part.count; i++) {
      part.getMatrixAt(i, m); refMesh.getMatrixAt(i, mr);
      for (let k = 0; k < 16; k++) maxDiff = Math.max(maxDiff, Math.abs(m.elements[k] - mr.elements[k]));
    }
  }
  check('tree instance matrices identical to the procedural build', maxDiff < 1e-6, `max diff ${maxDiff.toExponential(1)}`);
  const part = T('tyres').parts[0], refMesh = R('tyres'), a = new THREE.Vector3(), b = new THREE.Vector3();
  let maxPos = 0;
  for (let i = 0; i < part.count; i++) { part.getMatrixAt(i, m); refMesh.getMatrixAt(i, mr); maxPos = Math.max(maxPos, a.setFromMatrixPosition(m).distanceTo(b.setFromMatrixPosition(mr))); }
  check('tyre stacks at the procedural positions', maxPos < 1e-6, `max ${maxPos.toExponential(1)}`);
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
    notes.push(`stand${i}: ${n} copies, front x=${frontX.toFixed(2)} (planned ${st.x}), length ${size.z.toFixed(2)} (planned ${st.length}), height ${size.y.toFixed(1)}`);
  });
  check('grandstand copies placed on the planned footprint facing the track', ok, notes.join(' | '));
}

// Finish arch + FINISH banner.
{
  const arch = T('finish_arch'), banner = T('banner_FINISH');
  const k = 32 / SIZES.finish_arch[0], H = SIZES.finish_arch[1] * k, D = SIZES.finish_arch[2] * k;
  const s0 = track.sampleAt(0);   // heading +Z at the line, so the approach side is -Z
  banner.geometry.computeBoundingBox();
  const c = banner.geometry.boundingBox.getCenter(new THREE.Vector3()), sz = banner.geometry.boundingBox.getSize(new THREE.Vector3());
  const yOk = Math.abs(c.y - (s0.position.y - 0.05 + 0.72 * H)) < 0.05;
  const zOk = c.z < s0.position.z - D / 2 && c.z > s0.position.z - D / 2 - 0.5;
  check('FINISH banner kept, across the arch top on the approach side', yOk && zOk && Math.abs(sz.x - 24) < 0.05 && Math.abs(sz.y - 3.2) < 0.01, `centre y=${c.y.toFixed(2)} (arch ${H.toFixed(1)} m tall), z=${c.z.toFixed(2)} (arch front z=${(s0.position.z - D / 2).toFixed(2)})`);
  check('arch scaled to the 32 m span at the line, yawed by ASSET_YAW.finish_arch', Math.abs(arch.scale.x - k) < 1e-6 && arch.scale.y === arch.scale.x && Math.abs(arch.rotation.y - ASSET_YAW.finish_arch) < 0.02 && arch.position.distanceTo(s0.position) < 0.1, `scale ${k.toFixed(3)}, yaw ${arch.rotation.y.toFixed(3)}`);
}

// Balloons: aloft, uniform scale; update() flags only the animated matrices (needsUpdate is
// write-only on BufferAttribute, so a flag shows up as a bumped `version`).
{
  const parts = T('balloons').parts, m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  let ok = true;
  for (let i = 0; i < parts[0].count; i++) { parts[0].getMatrixAt(i, m); m.decompose(pos, q, sc); if (pos.y < 30 || pos.y > 95 || sc.x < 1.3 || sc.x > 2.2 || Math.abs(sc.x - sc.y) > 1e-6) ok = false; }
  check('balloons aloft (38..88 m), uniform scale 1.35..2.1 (17..27 m tall)', ok);
  const treeParts = T('pines').parts;
  const v0 = parts.map((p) => p.instanceMatrix.version), t0 = treeParts.map((p) => p.instanceMatrix.version);
  let err = null;
  try { track.update(0.016, 1); for (let i = 0; i < 120; i++) track.update(1 / 60, 1 + i / 60); } catch (e) { err = e; }
  check('track.update() runs with assets (121 frames)', !err, err?.stack);
  check('balloon instance matrices flagged dirty by update()', parts.every((p, i) => p.instanceMatrix.version > v0[i]), `versions ${parts.map((p) => p.instanceMatrix.version).join(',')}`);
  check('static tree matrices untouched by update()', treeParts.every((p, i) => p.instanceMatrix.version === t0[i]));
}
{
  let draws = 0;
  track.group.traverse((o) => { if (o.isMesh) draws++; });
  console.log(`      track meshes with assets: ${draws} (each fake asset has 2 sub-meshes)`);
}

// --- Environment: instanced GLB clouds, drifting ---
let env;
try {
  env = new Environment(new THREE.Scene(), null, assets);
} catch (e) {
  console.log('FAIL  Environment constructor threw with assets:\n', e.stack);
  process.exit(1);
}
check('36 cloud instances in one group, no procedural cloud meshes', calls.instanced.cloud === 36 && env.clouds.length === 1 && env._cloudData[0].length === 36 && !find(env.group, 'clouds0') && env.clouds[0].parts[0].count === 36);
{
  const parts = env.clouds[0].parts, m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  let ok = true, sMin = Infinity, sMax = 0;
  for (let i = 0; i < 36; i++) {
    parts[0].getMatrixAt(i, m); m.decompose(pos, q, sc);
    if (Math.abs(sc.x - sc.y) > 1e-6 || Math.abs(sc.x - sc.z) > 1e-6 || pos.y < 80 || pos.y > 160) ok = false;
    sMin = Math.min(sMin, sc.x); sMax = Math.max(sMax, sc.x);
  }
  check('clouds uniformly scaled 0.6..1.4 at 80..160 m', ok && sMin >= 0.6 && sMax <= 1.4, `scale ${sMin.toFixed(2)}..${sMax.toFixed(2)}`);
  check('cloud parts never culled, no shadows', parts.every((p) => p.frustumCulled === false && p.castShadow === false));
  const v0 = parts.map((p) => p.instanceMatrix.version), x0 = env._cloudData[0][0].x, focus = new THREE.Vector3(10, 2, 30);
  let err = null;
  try { env.update(0.016, 1, focus); for (let i = 0; i < 120; i++) env.update(1 / 60, 1 + i / 60, focus); } catch (e) { err = e; }
  check('env.update() runs with assets (121 frames)', !err, err?.stack);
  check('cloud instance matrices flagged dirty and drifting', parts.every((p, i) => p.instanceMatrix.version > v0[i]) && env._cloudData[0][0].x !== x0);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
