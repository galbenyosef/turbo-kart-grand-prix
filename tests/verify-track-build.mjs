// Builds the full Track (all meshes) in node by stubbing `document` + a 2D canvas context,
// so every geometry builder, merge and animation closure runs without a browser.
// Run:  THREE_ROOT=<path>/node_modules/three node --import ./tests/register.mjs tests/verify-track-build.mjs
import * as THREE from 'three';

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
globalThis.document = {
  createElement: (tag) => {
    const c = { width: 0, height: 0, tagName: tag };
    c.getContext = () => makeCtx();
    return c;
  },
};

const { Track } = await import('../src/track.js');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const scene = new THREE.Scene();
let track;
const t0 = performance.now();
try {
  track = new Track(scene, null);
} catch (e) {
  console.log('FAIL  Track constructor threw:\n', e.stack);
  process.exit(1);
}
const buildMs = performance.now() - t0;
check('Track built with meshes', track.group.children.length > 10, `${track.group.children.length} children, ${buildMs.toFixed(0)} ms`);

let draws = 0, tris = 0, nanMeshes = [], nullGeo = [], names = [];
track.group.traverse((o) => {
  if (!o.isMesh) return;
  draws++;
  const g = o.geometry;
  if (!g || !g.getAttribute('position')) { nullGeo.push(o.name || o.type); return; }
  const pos = g.getAttribute('position');
  const count = g.index ? g.index.count / 3 : pos.count / 3;
  const inst = o.isInstancedMesh ? o.count : 1;
  tris += count * inst;
  let bad = false;
  for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) { bad = true; break; }
  if (o.isInstancedMesh) {
    const a = o.instanceMatrix.array;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { bad = true; break; }
  }
  if (bad) nanMeshes.push(o.name || o.type);
  names.push(`${(o.name || o.type).padEnd(16)} ${String(Math.round(count)).padStart(7)} tris${o.isInstancedMesh ? ' x ' + o.count : ''}${o.castShadow ? '  [castShadow]' : ''}${o.receiveShadow ? '  [receiveShadow]' : ''}`);
});
console.log(names.map((n) => '      ' + n).join('\n'));
check('no null/empty geometries', nullGeo.length === 0, nullGeo.join(', '));
check('no NaN in geometry / instance matrices', nanMeshes.length === 0, nanMeshes.join(', '));
check('track draw calls <= 40', draws <= 40, `${draws} meshes, ~${(tris / 1e6).toFixed(2)} M triangles incl. instances`);

const find = (n) => { let r = null; track.group.traverse((o) => { if (o.name === n) r = o; }); return r; };
check('road receives shadow', find('road')?.receiveShadow === true);
check('terrain + ground present', !!find('terrain') && !!find('ground'));
check('rails instanced & cast shadow', find('rails')?.isInstancedMesh && find('rails').castShadow && find('rails').count > 400, `${find('rails')?.count} rail segments`);
const treeTotal = ['pines', 'trees', 'palms'].reduce((s, n) => s + (find(n)?.count || 0), 0);
check('150..320 trees in 3 varieties', treeTotal >= 150 && treeTotal <= 320 && ['pines', 'trees', 'palms'].every((n) => find(n)?.count > 0), `${treeTotal} (${['pines', 'trees', 'palms'].map((n) => n + '=' + find(n)?.count).join(', ')})`);
check('hundreds of spectators', (find('spectators')?.count || 0) >= 300, `${find('spectators')?.count}`);
check('balloons 10..20', find('balloonsTinted')?.count >= 10 && find('balloonsTinted')?.count <= 20, `${find('balloonsTinted')?.count}`);
check('gantry banner, billboards, flags, lake, mountains, rocks exist',
  !!find('banner_FINISH') && !!find('billboard_TURBO') && !!find('billboard_KART') && !!find('billboard_GP') && !!find('flags') && !!find('lake') && !!find('mountains') && !!find('rocks') && !!find('structures') && !!find('grandstands') && !!find('boostPads') && !!find('tyres'));

// Trees never inside the wall margin + 5 m; rocks never inside wall margin.
{
  const tmp = new THREE.Vector3();
  let minTree = Infinity, minRock = Infinity;
  const m = new THREE.Matrix4();
  for (const n of ['pines', 'trees', 'palms']) {
    const mesh = find(n);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); tmp.setFromMatrixPosition(m);
      minTree = Math.min(minTree, Math.abs(track.getRoadInfo(tmp).lateral));
    }
  }
  const rocks = find('rocks');
  for (let i = 0; i < rocks.count; i++) { rocks.getMatrixAt(i, m); tmp.setFromMatrixPosition(m); minRock = Math.min(minRock, Math.abs(track.getRoadInfo(tmp).lateral)); }
  check('trees >= wallDistance + 5 m from centre-line', minTree >= track.wallDistance + 5, `min |lateral| ${minTree.toFixed(1)} m`);
  check('rocks beyond the walls', minRock >= track.wallDistance + 3, `min |lateral| ${minRock.toFixed(1)} m`);
}

// Terrain is flat (road level) beside the road, and terrain sits below the road surface.
{
  let maxDiff = 0, maxAbove = -Infinity;
  for (let i = 0; i < 400; i++) {
    const s = track.sampleAt(i / 400);
    for (const lat of [-15, -12, 12, 15]) {
      const x = s.position.x + s.right.x * lat, z = s.position.z + s.right.z * lat;
      const h = track.field.height(x, z);
      maxDiff = Math.max(maxDiff, Math.abs(h + 0.05 - s.position.y));
      maxAbove = Math.max(maxAbove, h - s.position.y);
    }
  }
  check('terrain flat at road level within the walls', maxDiff < 0.06 && maxAbove < 0, `max dev ${maxDiff.toFixed(3)} m`);
}

// Animation: run a few seconds of updates.
try {
  const tA = performance.now();
  for (let i = 0; i < 240; i++) track.update(1 / 60, i / 60);
  const per = (performance.now() - tA) / 240;
  check('update() runs (240 frames)', true, `${per.toFixed(3)} ms per frame`);
  check('boost pad emissive pulses', track._padMaterial.emissiveIntensity > 0.7 && track._padMaterial.emissiveIntensity <= 1.5);
  const flags = find('flags');
  let moved = false;
  const arr = flags.geometry.getAttribute('position').array;
  for (let i = 2; i < arr.length; i += 3) if (Math.abs(arr[i] - Math.round(arr[i] * 1000) / 1000) < 1 && arr[i] !== 0) { moved = true; break; }
  check('flag vertices animated', moved);
} catch (e) {
  console.log('FAIL  update() threw:\n', e.stack);
  failures++;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
