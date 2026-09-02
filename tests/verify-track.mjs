// Numeric verification of src/track.js (no DOM needed).
// Run:  THREE_ROOT=<path>/node_modules/three node --import ./tests/register.mjs tests/verify-track.mjs
import * as THREE from 'three';
import { Track, DESIGN_POINTS, buildTrackCurve } from '../src/track.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const scene = { add() {}, children: [] };
const track = new Track(scene, null);
const lut = track.lut;
const L = track.length;
const n = lut.n;
const P = lut.positions;

// 1. Length.
check('length in 1000..1300 m', L >= 1000 && L <= 1300, `${L.toFixed(1)} m`);

// 2. Self-intersection / proximity: samples with |dt| > 0.08 must be > 40 m apart (XZ).
let minFar = Infinity, minPair = null;
const stride = 2; // 1024 samples
for (let i = 0; i < n; i += stride) {
  for (let j = i + stride; j < n; j += stride) {
    let dt = (j - i) / n;
    dt = Math.min(dt, 1 - dt);
    if (dt <= 0.08) continue;
    const dx = P[i * 3] - P[j * 3], dz = P[i * 3 + 2] - P[j * 3 + 2];
    const d = Math.hypot(dx, dz);
    if (d < minFar) { minFar = d; minPair = [i / n, j / n]; }
  }
}
check('no two non-adjacent segments within 40 m', minFar > 40, `min ${minFar.toFixed(1)} m at t=${minPair[0].toFixed(3)} / ${minPair[1].toFixed(3)}`);

// 3. Grade: rise over run measured on 6 m windows.
let maxGrade = 0, maxGradeT = 0, maxY = -Infinity, minY = Infinity;
const win = Math.round(6 / (L / n));
for (let i = 0; i < n; i++) {
  const j = (i + win) % n;
  const dy = P[j * 3 + 1] - P[i * 3 + 1];
  const run = Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 2] - P[i * 3 + 2]);
  const g = Math.abs(dy) / run;
  if (g > maxGrade) { maxGrade = g; maxGradeT = i / n; }
  maxY = Math.max(maxY, P[i * 3 + 1]); minY = Math.min(minY, P[i * 3 + 1]);
}
check('max grade <= 8%', maxGrade <= 0.08, `${(maxGrade * 100).toFixed(2)}% at t=${maxGradeT.toFixed(3)}`);
check('hill height 10..14 m', maxY >= 10 && maxY <= 14, `maxY ${maxY.toFixed(2)} minY ${minY.toFixed(2)}`);

// 4. Raw parameter vs arc-length parameter agreement.
let maxParamErr = 0;
const a = new THREE.Vector3(), b = new THREE.Vector3();
for (let i = 0; i < 500; i++) {
  const t = i / 500;
  track.curve.getPoint(t, a); track.curve.getPointAt(t, b);
  maxParamErr = Math.max(maxParamErr, a.distanceTo(b));
}
check('getPoint(t) ~ getPointAt(t)', maxParamErr < 2.0, `max ${maxParamErr.toFixed(3)} m`);

// 5. Start straight: tangent deviation between t=0.975 and t=0.10 small, and >= 120 m long.
{
  const s0 = track.sampleAt(0).tangent;
  let straightLen = 0;
  let tt = 0.975, ok = true;
  for (let k = 0; k <= 200; k++) {
    const t = (0.975 + k * (0.125 / 200)) % 1;
    const tg = track.sampleAt(t).tangent;
    if (tg.angleTo(s0) > 0.02) { ok = false; break; }
    straightLen = (k * (0.125 / 200)) * L;
  }
  check('start straight is straight over >= 120 m', ok && straightLen >= 120, `${straightLen.toFixed(0)} m straight around the line (tangent within 1.1 deg)`);
  const yaw0 = Math.atan2(s0.x, s0.z);
  check('t=0 heading +Z (yaw ~ 0)', Math.abs(yaw0) < 0.01, `yaw ${yaw0.toFixed(4)}`);
}

// 6. getRoadInfo accuracy on curve points (global and hinted) + lateral sign.
let maxTErr = 0, maxLatErr = 0, maxTErrHint = 0, maxHeightErr = 0;
const pos = new THREE.Vector3();
for (let i = 0; i < 1000; i++) {
  const t = (i / 1000 + 0.0003) % 1;
  const s = track.sampleAt(t);
  // On centre-line.
  pos.copy(s.position);
  const info = track.getRoadInfo(pos);
  let e = Math.abs(info.t - t); e = Math.min(e, 1 - e);
  maxTErr = Math.max(maxTErr, e);
  maxLatErr = Math.max(maxLatErr, Math.abs(info.lateral));
  maxHeightErr = Math.max(maxHeightErr, Math.abs(info.height - s.position.y));
  // Offset +5 m along right (should give lateral ~ +5) and -5 (lateral ~ -5).
  pos.copy(s.position).addScaledVector(s.right, 5);
  const infoR = track.getRoadInfo(pos, (t + 0.02) % 1);
  maxLatErr = Math.max(maxLatErr, Math.abs(infoR.lateral - 5));
  let eh = Math.abs(infoR.t - t); eh = Math.min(eh, 1 - eh);
  maxTErrHint = Math.max(maxTErrHint, eh);
  pos.copy(s.position).addScaledVector(s.right, -5);
  const infoL = track.getRoadInfo(pos, (t - 0.03 + 1) % 1);
  maxLatErr = Math.max(maxLatErr, Math.abs(infoL.lateral + 5));
  eh = Math.abs(infoL.t - t); eh = Math.min(eh, 1 - eh);
  maxTErrHint = Math.max(maxTErrHint, eh);
}
check('getRoadInfo t error < 0.002 (global)', maxTErr < 0.002, `max ${maxTErr.toExponential(2)}`);
check('getRoadInfo t error < 0.002 (hinted)', maxTErrHint < 0.002, `max ${maxTErrHint.toExponential(2)}`);
check('lateral accurate & signed (+right)', maxLatErr < 0.05, `max err ${maxLatErr.toFixed(4)} m`);
check('height == centre height', maxHeightErr < 1e-4, `max ${maxHeightErr.toExponential(2)}`);

// Wrap handling around t=0 with hints on the other side of the seam.
{
  const s = track.sampleAt(0.999);
  const info = track.getRoadInfo(s.position, 0.002);
  let e = Math.abs(info.t - 0.999); e = Math.min(e, 1 - e);
  check('hint wrap across seam', e < 0.002 && info.t >= 0 && info.t < 1, `t=${info.t.toFixed(4)}`);
  // Stale hint far away → falls back to global search.
  const s2 = track.sampleAt(0.5);
  const info2 = track.getRoadInfo(s2.position, 0.1);
  e = Math.abs(info2.t - 0.5);
  check('stale hint recovers via global search', e < 0.002, `t=${info2.t.toFixed(4)}`);
}

// 7. Surfaces.
{
  const s = track.sampleAt(0.25);
  const off = s.position.clone().addScaledVector(s.right, 9);
  check('offroad beyond half width', track.getRoadInfo(off).surface === 'offroad' && track.getRoadInfo(off).onRoad === false);
  const on = s.position.clone().addScaledVector(s.right, 7);
  check('road within half width', track.getRoadInfo(on).surface === 'road');
  let padsOk = true;
  for (const pad of track.boostPads) {
    const info = track.getRoadInfo(pad.position, pad.t);
    const fwd = new THREE.Vector3(Math.sin(pad.yaw), 0, Math.cos(pad.yaw));
    const ahead = pad.position.clone().addScaledVector(fwd, 3.5);
    const outside = pad.position.clone().addScaledVector(fwd, 5.0);
    if (info.surface !== 'boost' || track.getRoadInfo(ahead).surface !== 'boost' || track.getRoadInfo(outside).surface === 'boost') padsOk = false;
    if (Math.abs(info.lateral) > 4) padsOk = false;
  }
  check('boost pads detected in local frame', padsOk, `${track.boostPads.length} pads`);
}

// 8. Contract arrays.
check('24 checkpoints, first at t=0', track.checkpoints.length === 24 && track.checkpoints[0].t === 0);
check('16 item boxes at surface + 1.2', track.itemBoxPositions.length === 16 && track.itemBoxPositions.every((p) => Math.abs(track.getRoadInfo(p).height + 1.2 - p.y) < 0.05));
check('200 minimap points', track.minimapPoints.length === 200 && typeof track.minimapPoints[0].x === 'number');
{
  let ok = track.startPositions.length === 8;
  for (const sp of track.startPositions) {
    const info = track.getRoadInfo(sp.position);
    const yawExpected = Math.atan2(info.tangent.x, info.tangent.z);
    if (!(info.t > 0.98 && info.t < 0.998)) ok = false;
    if (Math.abs(Math.abs(info.lateral) - 3) > 0.05) ok = false;
    if (Math.abs(sp.yaw - yawExpected) > 0.02) ok = false;
    if (Math.abs(sp.position.y - info.height) > 0.02) ok = false;
    if (info.surface !== 'road') ok = false;
  }
  check('8 start slots behind the line, on road, yaw from tangent', ok, track.startPositions.map((s) => s.t.toFixed(4)).join(' '));
}
check('wallDistance = 14', track.getRoadInfo(track.sampleAt(0.3).position).wallDistance === 14);

// 9. Performance sanity.
{
  const p = track.sampleAt(0.42).position.clone();
  let t0 = performance.now();
  for (let i = 0; i < 20000; i++) track.getRoadInfo(p, 0.42);
  const hinted = (performance.now() - t0) / 20000 * 1e3;
  t0 = performance.now();
  for (let i = 0; i < 2000; i++) track.getRoadInfo(p);
  const global = (performance.now() - t0) / 2000 * 1e3;
  console.log(`      getRoadInfo: hinted ${hinted.toFixed(1)} us, global ${global.toFixed(1)} us`);
}

// 10. Landmarks (for placing pads / scenery).
console.log('\nDesign landmarks (t at each design point):');
const design = new THREE.CatmullRomCurve3(DESIGN_POINTS.map((p) => new THREE.Vector3(...p)), true, 'centripetal');
design.arcLengthDivisions = 4000;
const dl = design.getLength();
let acc = 0;
const lens = design.getLengths(DESIGN_POINTS.length);
for (let i = 0; i < DESIGN_POINTS.length; i++) {
  console.log(`  #${String(i).padStart(2)}  t=${(lens[i] / dl).toFixed(3)}  (${DESIGN_POINTS[i].join(', ')})`);
}
console.log(`\nLength ${L.toFixed(1)} m, checkpoints ${track.checkpoints.length}, boost pads ${track.boostPads.length}`);
console.log(`Bounds: ${JSON.stringify(track._bounds())}`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
