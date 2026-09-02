// Resolve hook: maps the browser import-map specifiers onto a local three install.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let threeRoot = '';

export async function initialize(data) {
  threeRoot = data.threeRoot;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') {
    return { url: pathToFileURL(path.join(threeRoot, 'build', 'three.module.js')).href, shortCircuit: true };
  }
  const prefix = 'three/addons/';
  if (specifier.startsWith(prefix)) {
    const rel = specifier.slice(prefix.length);
    return { url: pathToFileURL(path.join(threeRoot, 'examples', 'jsm', rel)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
