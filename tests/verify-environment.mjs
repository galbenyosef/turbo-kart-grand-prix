// Smoke test for src/environment.js in node (no renderer): construct, update, inspect.
// Run:  THREE_ROOT=<path>/node_modules/three node --import ./tests/register.mjs tests/verify-environment.mjs
import * as THREE from 'three';
import { Environment } from '../src/environment.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

const scene = new THREE.Scene();
const env = new Environment(scene, null);

check('sunLight is a DirectionalLight with shadows', env.sunLight instanceof THREE.DirectionalLight && env.sunLight.castShadow === true);
check('shadow map 2048', env.sunLight.shadow.mapSize.x === 2048 && env.sunLight.shadow.mapSize.y === 2048);
check('shadow camera ±120, near 1, far 500', env.sunLight.shadow.camera.left === -120 && env.sunLight.shadow.camera.far === 500 && env.sunLight.shadow.camera.near === 1);
check('fog set (250..1100)', scene.fog instanceof THREE.Fog && scene.fog.near === 250 && scene.fog.far === 1100);
check('background colour set', scene.background instanceof THREE.Color);
check('sun target in scene graph', env.sunLight.target.parent !== null);

const focus = new THREE.Vector3(-120, 8, 40);
for (let i = 0; i < 300; i++) env.update(1 / 60, i / 60, focus);
const off = env.sunLight.position.clone().sub(env.sunLight.target.position);
check('light/target offset constant = sunDir*distance', Math.abs(off.length() - env.sunDistance) < 1e-3 && off.clone().normalize().distanceTo(env.sunDir) < 1e-4);
check('target snapped near focus (< 1 texel + 1e-6)', env.sunLight.target.position.distanceTo(focus) < env._shadowTexel * 1.0 + 1e-6, `${env.sunLight.target.position.distanceTo(focus).toFixed(4)} m, texel ${env._shadowTexel.toFixed(4)}`);
check('sky follows focus', env.sky.position.x === focus.x && env.sky.position.z === focus.z);

let draws = 0;
scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) draws++; });
check('environment meshes <= 6 draw calls', draws <= 6, `${draws} meshes`);
// Clouds keep drifting and wrap.
const before = env._cloudData[0][0].x;
for (let i = 0; i < 60; i++) env.update(1, 300 + i, focus);
check('clouds drift', env._cloudData[0][0].x !== before);
check('cloud x stays within wrap range', env._cloudData.every((arr) => arr.every((d) => d.x <= 640 && d.x >= -940)));
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
