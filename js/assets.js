// Loads the models and textures (built by scripts/build-assets.mjs). Every file is
// optional: if one fails to load, the 3D view draws its plain shape instead, so a
// missing or blocked file never stops the game.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODELS = ['player', 'guard', 'exit-door'];
const TEXTURES = ['floor', 'floor_n', 'wall', 'wall_n', 'door', 'door_n'];
const TIMEOUT = 12000;   // ms: a file that hangs counts as missing

const within = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), TIMEOUT))]);

// onProgress(done, total) is called after every file.
export async function loadAssets(onProgress = () => {}, base = 'assets/') {
  const models = {}, textures = {}, failed = [];
  const total = MODELS.length + TEXTURES.length;
  let done = 0;
  const step = (p, store, name, file) => within(p)
    .then((v) => { store[name] = v; })
    .catch(() => { failed.push(file); })
    .finally(() => onProgress(++done, total));

  const gltf = new GLTFLoader(), tex = new THREE.TextureLoader();
  await Promise.all([
    ...MODELS.map((n) => step(gltf.loadAsync(`${base}models/${n}.glb`), models, n, `models/${n}.glb`)),
    ...TEXTURES.map((n) => step(tex.loadAsync(`${base}textures/${n}.png`), textures, n, `textures/${n}.png`)),
  ]);
  for (const [n, t] of Object.entries(textures)) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (!n.endsWith('_n')) t.colorSpace = THREE.SRGBColorSpace;   // normal maps hold vectors, not colours
  }
  if (failed.length) console.warn(`Mission Evade: using plain shapes for ${failed.join(', ')}`);
  return { models, textures, failed };
}
