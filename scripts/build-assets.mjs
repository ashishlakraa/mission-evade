// Builds every art asset of the game, so all of it is original and in one style:
//   assets/models/player.glb, guard.glb, exit-door.glb   (glTF 2.0 binary, with animation clips)
//   assets/textures/{floor,wall,door}.png and *_n.png    (colour and normal maps)
//
// Models are rigid parts on a small node hierarchy (hips, head, arms, legs), one mesh per
// part with vertex colours, so a character costs a handful of draw calls. They face +x, which
// matches the simulation's angles. Run: npm install && npm run assets

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(`${out}models`, { recursive: true });
mkdirSync(`${out}textures`, { recursive: true });

const PALETTE = {
  player: 0x3d88ff, playerDark: 0x1f4690, playerLight: 0x9cc4ff,
  guard: 0xd8433d, guardDark: 0x39404b, guardPad: 0x5a6472,
  skin: 0xd9a581, boot: 0x20252c, steel: 0x7b8592, metal: 0x4a535f, black: 0x0f1216,
};

// ---------------------------------------------------------------- geometry helpers

const tint = (geo, hex) => {
  const c = new THREE.Color(hex);          // linear, as glTF COLOR_0 expects
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
};
// w along x (depth), h along y, d along z (width, shoulder to shoulder)
const box = (hex, w, h, d, x = 0, y = 0, z = 0, r = 0.03) => tint(new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2.2, h / 2.2, d / 2.2)).translate(x, y, z), hex);
const ball = (hex, r, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => tint(new THREE.SphereGeometry(r, 14, 10).scale(sx, sy, sz).translate(x, y, z), hex);
const cyl = (hex, rt, rb, h, x = 0, y = 0, z = 0, seg = 14) => tint(new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z), hex);
const rod = (hex, r, len, x, y, z) => tint(new THREE.CylinderGeometry(r, r, len, 10).rotateZ(Math.PI / 2).translate(x, y, z), hex);
const merge = (...gs) => mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { if (!g.attributes.uv) throw new Error('uv'); return g; }));

// ---------------------------------------------------------------- glTF binary writer

// nodes: [{ name, parent, t, mesh: { geo, material } }], clips: { name: { dur, tracks: [{ node, path, times, values }] } }
function writeGlb(file, { nodes, materials, clips = {} }) {
  const chunks = [];
  let size = 0;
  const views = [], accessors = [];
  const push = (arr, target) => {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    views.push({ buffer: 0, byteOffset: size, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf);
    size += buf.length;
    const pad = (4 - (size % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); size += pad; }
    return views.length - 1;
  };
  const accessor = (arr, type, { target, minmax, normalized } = {}) => {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const a = { bufferView: push(arr, target), componentType: 5126, count: arr.length / n, type };
    if (arr instanceof Uint16Array) a.componentType = 5123;
    if (normalized) a.normalized = true;
    if (minmax) {
      a.min = Array(n).fill(Infinity);
      a.max = Array(n).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) {
        a.min[i % n] = Math.min(a.min[i % n], arr[i]);
        a.max[i % n] = Math.max(a.max[i % n], arr[i]);
      }
    }
    accessors.push(a);
    return accessors.length - 1;
  };

  const matIndex = new Map(Object.keys(materials).map((k, i) => [k, i]));
  const meshes = [];
  const gl = nodes.map((n) => {
    const node = { name: n.name };
    if (n.t) node.translation = n.t;
    if (n.mesh) {
      const g = n.mesh.geo;
      const A = g.attributes;
      const prim = {
        attributes: {
          POSITION: accessor(A.position.array, 'VEC3', { target: 34962, minmax: true }),
          NORMAL: accessor(A.normal.array, 'VEC3', { target: 34962 }),
        },
        material: matIndex.get(n.mesh.material),
      };
      if (n.mesh.uv) prim.attributes.TEXCOORD_0 = accessor(A.uv.array, 'VEC2', { target: 34962 });
      else prim.attributes.COLOR_0 = accessor(A.color.array, 'VEC3', { target: 34962 });
      meshes.push({ name: n.name, primitives: [prim] });
      node.mesh = meshes.length - 1;
    }
    return node;
  });
  const roots = [];
  nodes.forEach((n, i) => {
    if (n.parent == null) { roots.push(i); return; }
    const p = nodes.findIndex((q) => q.name === n.parent);
    (gl[p].children ||= []).push(i);
  });

  const animations = Object.entries(clips).map(([name, tracks]) => {
    const samplers = [], channels = [];
    for (const tr of tracks) {
      samplers.push({
        input: accessor(new Float32Array(tr.times), 'SCALAR', { minmax: true }),
        output: accessor(new Float32Array(tr.values), tr.path === 'rotation' ? 'VEC4' : 'VEC3'),
        interpolation: 'LINEAR',
      });
      channels.push({ sampler: samplers.length - 1, target: { node: nodes.findIndex((q) => q.name === tr.node), path: tr.path } });
    }
    return { name, samplers, channels };
  });

  const json = {
    asset: { version: '2.0', generator: 'Mission Evade scripts/build-assets.mjs' },
    scene: 0, scenes: [{ nodes: roots }], nodes: gl, meshes,
    materials: Object.entries(materials).map(([name, m]) => ({ name, ...m })),
    accessors, bufferViews: views, buffers: [{ byteLength: size }],
    ...(animations.length ? { animations } : {}),
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const glb = Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin]);
  writeFileSync(`${out}models/${file}`, glb);
  const tris = nodes.reduce((s, n) => s + (n.mesh ? n.mesh.geo.attributes.position.count / 3 : 0), 0);
  console.log(`models/${file}: ${(glb.length / 1024).toFixed(0)} KB, ${tris} triangles, clips: ${Object.keys(clips).join(', ') || 'none'}`);
}

// ---------------------------------------------------------------- characters

const body = { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.05, roughnessFactor: 0.62 } };
const glow = (hex) => {
  const c = new THREE.Color(hex);
  return { pbrMetallicRoughness: { baseColorFactor: [c.r, c.g, c.b, 1], metallicFactor: 0, roughnessFactor: 0.3 }, emissiveFactor: [c.r * 0.9, c.g * 0.9, c.b * 0.9] };
};

const qz = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];   // swing forward/back (about the shoulder axis)
const FRAMES = 12;
const cycle = (dur, fn) => {
  const times = [], values = [];
  for (let i = 0; i <= FRAMES; i++) { times.push((i / FRAMES) * dur); values.push(...fn((i / FRAMES) * Math.PI * 2)); }
  return { times, values };
};

// Gait clips shared by both characters.
function gaits(hipY, carry = 0) {
  const gait = (dur, leg, arm, bob, lean) => [
    { node: 'LegL', path: 'rotation', ...cycle(dur, (p) => qz(Math.sin(p) * leg)) },
    { node: 'LegR', path: 'rotation', ...cycle(dur, (p) => qz(-Math.sin(p) * leg)) },
    { node: 'ArmL', path: 'rotation', ...cycle(dur, (p) => qz(-Math.sin(p) * arm)) },
    { node: 'ArmR', path: 'rotation', ...cycle(dur, (p) => qz(Math.sin(p) * arm * (carry ? 0.25 : 1) + carry)) },
    { node: 'Hips', path: 'translation', ...cycle(dur, (p) => [0, hipY + Math.abs(Math.cos(p)) * bob - bob / 2, 0]) },
    { node: 'Torso', path: 'rotation', ...cycle(dur, () => qz(-lean)) },
  ];
  return {
    Idle: [
      { node: 'LegL', path: 'rotation', ...cycle(2.4, () => qz(0)) },
      { node: 'LegR', path: 'rotation', ...cycle(2.4, () => qz(0)) },
      { node: 'ArmL', path: 'rotation', ...cycle(2.4, (p) => qz(Math.sin(p) * 0.05)) },
      { node: 'ArmR', path: 'rotation', ...cycle(2.4, (p) => qz(Math.sin(p) * 0.04 + carry)) },
      { node: 'Hips', path: 'translation', ...cycle(2.4, (p) => [0, hipY + Math.sin(p) * 0.008, 0]) },
      { node: 'Torso', path: 'rotation', ...cycle(2.4, () => qz(0)) },
    ],
    Walk: gait(0.8, 0.55, 0.45, 0.03, 0.04),
    Run: gait(0.5, 0.95, 0.9, 0.06, 0.2),
  };
}

function character(file, { hipY, torso, head, face, arm, armR = arm, leg, shoulderZ, shoulderY, neckY, hipZ, visor, carry }) {
  writeGlb(file, {
    materials: { Body: body, Visor: glow(visor) },
    nodes: [
      { name: 'Root' },
      { name: 'Hips', parent: 'Root', t: [0, hipY, 0] },
      { name: 'Torso', parent: 'Hips', mesh: { geo: torso, material: 'Body' } },
      { name: 'Head', parent: 'Torso', t: [0, neckY, 0], mesh: { geo: head, material: 'Body' } },
      { name: 'Face', parent: 'Head', mesh: { geo: face, material: 'Visor' } },
      { name: 'ArmL', parent: 'Torso', t: [0, shoulderY, -shoulderZ], mesh: { geo: arm, material: 'Body' } },
      { name: 'ArmR', parent: 'Torso', t: [0, shoulderY, shoulderZ], mesh: { geo: armR, material: 'Body' } },
      { name: 'LegL', parent: 'Hips', t: [0, 0, -hipZ], mesh: { geo: leg, material: 'Body' } },
      { name: 'LegR', parent: 'Hips', t: [0, 0, hipZ], mesh: { geo: leg, material: 'Body' } },
    ],
    clips: gaits(hipY, carry),
  });
}

const P = PALETTE;

// The player: a hooded operative in blue with a small backpack.
character('player.glb', {
  hipY: 0.36, neckY: 0.4, shoulderY: 0.31, shoulderZ: 0.215, hipZ: 0.095, visor: 0x9fe3ff, carry: 0,
  torso: merge(
    box(P.player, 0.24, 0.38, 0.34, 0, 0.19, 0, 0.09),
    box(P.playerDark, 0.26, 0.07, 0.35, 0, 0.03, 0, 0.03),          // belt
    box(P.playerDark, 0.13, 0.25, 0.24, -0.16, 0.22, 0, 0.05),      // backpack
    box(P.playerLight, 0.04, 0.05, 0.2, -0.22, 0.28, 0, 0.015),     // backpack strip
  ),
  head: merge(
    ball(P.player, 0.2, 0, 0.13, 0, 1, 1, 1),                        // hood
    ball(P.playerDark, 0.16, 0.06, 0.12, 0, 1, 0.95, 0.95),          // shade under the hood
    cyl(P.playerLight, 0.15, 0.17, 0.06, 0, -0.02, 0),               // scarf
  ),
  face: merge(box(0xffffff, 0.06, 0.055, 0.2, 0.2, 0.14, 0, 0.02)),
  arm: merge(
    box(P.player, 0.11, 0.24, 0.1, 0, -0.1, 0, 0.045),
    box(P.playerDark, 0.1, 0.1, 0.09, 0, -0.25, 0, 0.04),
  ),
  leg: merge(
    box(P.playerDark, 0.13, 0.26, 0.12, 0, -0.14, 0, 0.045),
    box(P.boot, 0.19, 0.09, 0.13, 0.025, -0.31, 0, 0.035),
  ),
});

// A guard: helmet, shoulder pads and a torch held forward. The visor is recoloured by state.
character('guard.glb', {
  hipY: 0.4, neckY: 0.43, shoulderY: 0.34, shoulderZ: 0.26, hipZ: 0.11, visor: 0x3f8ee8, carry: 0.9,
  torso: merge(
    box(P.guard, 0.28, 0.42, 0.4, 0, 0.21, 0, 0.09),
    box(P.guardDark, 0.3, 0.2, 0.3, 0.01, 0.23, 0, 0.05),            // vest
    box(P.guardDark, 0.3, 0.08, 0.41, 0, 0.03, 0, 0.03),             // belt
    box(P.steel, 0.02, 0.06, 0.06, 0.16, 0.28, -0.08, 0.008),        // badge
    box(P.guardPad, 0.06, 0.14, 0.08, -0.16, 0.26, 0.1, 0.02),       // radio
  ),
  head: merge(
    ball(P.guardDark, 0.205, 0, 0.14, 0, 1.02, 1, 1),                // helmet
    box(P.guard, 0.36, 0.05, 0.08, -0.01, 0.335, 0, 0.02),           // helmet stripe
    box(P.skin, 0.1, 0.1, 0.2, 0.12, 0.03, 0, 0.04),                 // jaw
  ),
  face: merge(box(0xffffff, 0.1, 0.09, 0.3, 0.165, 0.14, 0, 0.035)),
  arm: merge(
    ball(P.guardPad, 0.1, 0, 0.0, 0, 1, 0.85, 1),                    // shoulder pad
    box(P.guard, 0.12, 0.24, 0.11, 0, -0.12, 0, 0.045),
    box(P.black, 0.11, 0.1, 0.1, 0, -0.27, 0, 0.04),
  ),
  armR: merge(
    ball(P.guardPad, 0.1, 0, 0.0, 0, 1, 0.85, 1),
    box(P.guard, 0.12, 0.24, 0.11, 0, -0.12, 0, 0.045),
    box(P.black, 0.11, 0.1, 0.1, 0, -0.27, 0, 0.04),
    rod(P.metal, 0.035, 0.22, 0.1, -0.28, 0),                        // torch
    rod(0xfff2c2, 0.042, 0.03, 0.22, -0.28, 0),
  ),
  leg: merge(
    box(P.guardDark, 0.15, 0.29, 0.14, 0, -0.16, 0, 0.05),
    box(P.boot, 0.22, 0.1, 0.15, 0.03, -0.345, 0, 0.035),
  ),
});

// The exit door stands against the wall and faces +x. Its two panels slide apart along z.
{
  const W = 0.94, H = 0.95;
  const panel = (dir) => new THREE.BoxGeometry(0.05, H - 0.1, W / 2 - 0.05).toNonIndexed().translate(0, 0, dir * 0.0);
  writeGlb('exit-door.glb', {
    materials: {
      Body: { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.35, roughnessFactor: 0.5 } },
      Panel: { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.3, roughnessFactor: 0.55 } },
      Lamp: glow(0x2fbf68),
    },
    nodes: [
      { name: 'Root' },
      { name: 'Frame', parent: 'Root', mesh: { material: 'Body', geo: merge(
        box(P.metal, 0.12, H, 0.07, 0, H / 2, -W / 2 + 0.035, 0.015),
        box(P.metal, 0.12, H, 0.07, 0, H / 2, W / 2 - 0.035, 0.015),
        box(P.metal, 0.14, 0.1, W, 0, H - 0.05, 0, 0.02),
        box(P.black, 0.01, H - 0.1, W - 0.1, -0.045, (H - 0.1) / 2, 0, 0.002),   // dark opening behind the panels
      ) } },
      { name: 'PanelL', parent: 'Root', t: [0, (H - 0.1) / 2, -(W / 4 - 0.025)], mesh: { material: 'Panel', uv: true, geo: panel(-1) } },
      { name: 'PanelR', parent: 'Root', t: [0, (H - 0.1) / 2, W / 4 - 0.025], mesh: { material: 'Panel', uv: true, geo: panel(1) } },
      { name: 'Lamp', parent: 'Root', t: [0.06, H - 0.05, 0], mesh: { material: 'Lamp', geo: merge(box(0xffffff, 0.05, 0.05, 0.44, 0, 0, 0, 0.02)) } },
    ],
  });
}

// ---------------------------------------------------------------- textures

function png(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 1;                           // Sub filter: smooth textures compress better
    for (let x = 0; x < w * 3; x++) raw[o + 1 + x] = (rgb[y * w * 3 + x] - (x >= 3 ? rgb[y * w * 3 + x - 3] : 0)) & 255;
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const buf = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(`${out}textures/${file}`, buf);
  console.log(`textures/${file}: ${w}x${h}, ${(buf.length / 1024).toFixed(0)} KB`);
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(buf) {

  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Tileable value noise.
function noise(seed) {
  const hash = (x, y) => { let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  return (u, v, cells) => {
    const x = u * cells, y = v * cells, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const s = (t) => t * t * (3 - 2 * t), m = (a) => ((a % cells) + cells) % cells;
    const a = hash(m(xi), m(yi)), b = hash(m(xi + 1), m(yi)), c = hash(m(xi), m(yi + 1)), d = hash(m(xi + 1), m(yi + 1));
    const l = (p, q, t) => p + (q - p) * t;
    return l(l(a, b, s(fx)), l(c, d, s(fx)), s(fy));
  };
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgbOf = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// fn(u, v) → { color: [r, g, b], h: 0..1 height }; writes the colour map and a normal map from the heights.
function texture(name, size, strength, fn) {
  const rgb = Buffer.alloc(size * size * 3), hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const t = fn(x / size, y / size);
    for (let k = 0; k < 3; k++) rgb[(y * size + x) * 3 + k] = clamp(t.color[k]);
    hgt[y * size + x] = t.h;
  }
  const nrm = Buffer.alloc(size * size * 3);
  const at = (x, y) => hgt[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (at(x - 1, y) - at(x + 1, y)) * strength, ny = (at(x, y + 1) - at(x, y - 1)) * strength;
    const len = Math.hypot(nx, ny, 1);
    [nx / len, ny / len, 1 / len].forEach((v, k) => { nrm[(y * size + x) * 3 + k] = clamp((v * 0.5 + 0.5) * 255); });
  }
  png(`${name}.png`, size, size, rgb);
  png(`${name}_n.png`, size, size, nrm);
}

const n1 = noise(3), n2 = noise(11), n3 = noise(29);
const rough = (u, v) => n1(u, v, 8) * 0.5 + n2(u, v, 24) * 0.32 + n3(u, v, 64) * 0.18;

// Floor: one texture covers 2x2 cells of sealed concrete slabs with seams and corner bolts.
texture('floor', 256, 2.2, (u, v) => {
  const s = (t) => Math.abs(((t * 2) % 1) - 0.5) * 2;             // 1 at a slab's edge
  const edge = Math.max(s(u), s(v));
  const seam = edge > 0.965;
  const lu = (u * 2) % 1, lv = (v * 2) % 1;
  const bolt = Math.hypot(Math.abs(lu - 0.5) - 0.42, Math.abs(lv - 0.5) - 0.42) < 0.022;
  const slab = ((Math.floor(u * 2) + Math.floor(v * 2)) % 2) * 5;
  const r = rough(u, v);
  let c = mix(rgbOf(0x97a1ad), rgbOf(0xb4bcc6), r).map((x) => x - slab);
  if (seam) c = rgbOf(0x6f7986);
  if (bolt) c = rgbOf(0x7f8996);
  return { color: c, h: (seam ? 0 : 0.7 + r * 0.25) + (bolt ? 0.25 : 0) };
});

// Wall: a steel panel per cell face, with a kick plate, a light band and rivets.
texture('wall', 256, 2.6, (u, v) => {
  const y = 1 - v;                                                // 0 at the floor
  const r = rough(u, v);
  const brushed = n3(u, v * 0.25, 64) * 0.5 + r * 0.5;
  let c = mix(rgbOf(0x566273), rgbOf(0x77869a), brushed), h = 0.6 + r * 0.08;
  if (u < 0.02 || u > 0.98) { c = rgbOf(0x262d36); h = 0.2; }
  if (y < 0.16) { c = mix(rgbOf(0x343c47), rgbOf(0x454f5c), r); h = 0.72; }
  if (y > 0.74 && y < 0.82) { c = mix(rgbOf(0x2c5fae), rgbOf(0x3f8ee8), r); h = 0.66; }
  for (const [ru, rv] of [[0.1, 0.24], [0.9, 0.24], [0.1, 0.66], [0.9, 0.66]]) {
    if (Math.hypot(u - ru, y - rv) < 0.028) { c = rgbOf(0x76828f); h = 1; }
  }
  return { color: c, h };
});

// Door: steel with a hazard band, used on both exit panels.
texture('door', 128, 2.2, (u, v) => {
  const y = 1 - v;
  const r = rough(u, v);
  let c = mix(rgbOf(0x65707d), rgbOf(0x8a95a2), r), h = 0.6 + r * 0.1;
  if (u < 0.05 || u > 0.95 || y < 0.03 || y > 0.97) { c = rgbOf(0x353c46); h = 0.25; }
  if (y > 0.4 && y < 0.6) { c = ((u + y) * 5) % 1 < 0.5 ? rgbOf(0xe9b92f) : rgbOf(0x1c2026); h = 0.7; }
  if (y > 0.74 && y < 0.88 && u > 0.25 && u < 0.75) { c = mix(rgbOf(0x203246), rgbOf(0x35608a), y); h = 0.35; }
  return { color: c, h };
});
