// Node ESM loader registration so `import * as THREE from 'three'` and
// `three/addons/...` (normally resolved by the browser import map) resolve in node.
//
// Usage:  THREE_ROOT=<path to node_modules/three> node --import ./tests/register.mjs tests/verify-track.mjs
// Falls back to <repo>/node_modules/three when THREE_ROOT is not set.
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const threeRoot = process.env.THREE_ROOT || path.resolve(here, '..', 'node_modules', 'three');

register('./three-hooks.mjs', import.meta.url, { data: { threeRoot } });
