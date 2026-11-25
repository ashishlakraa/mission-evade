// Three.js view of the World. Reads simulation state every frame; never changes it.
// Grid x → scene x, grid y → scene z. One grid cell = one scene unit.

import * as THREE from 'three';
import { findPath, smoothPath } from './astar.js';
import { GUARD_RADIUS } from './config.js';

const WALL_H = 0.62;
const CONE_SEGMENTS = 44;
const CLIP_PACE = { Walk: 1.5, Run: 3.0 };   // cells per second a clip was made for
const RUN_FROM = 2.05;                       // above patrol speed's maximum

export const STATE_COLORS = {
  PATROL: 0x3f8ee8,
  SUSPICIOUS: 0xf0b232,
  INVESTIGATE: 0xf07f2b,
  CHASE: 0xe23e44,
};
const C = {
  bg: 0x161a20,
  floor: 0xb9c0c9,
  gridLine: 0x9aa3ae,
  wall: 0x3c4552,
  wallTop: 0x56606e,
  player: 0x2f7cf6,
  guard: 0xd2453f,
  exit: 0x2fbf68,
  exitLocked: 0xe23e44,
  start: 0x2f7cf6,
  learn: 0x9b6cff,
  path: 0xffffff,
  route: 0xf2c94c,
  heatLow: new THREE.Color(0xf2c94c),
  heatHigh: new THREE.Color(0xe23e44),
};

export class Scene3D {
  // assets: loaded models and textures (assets.js); anything missing falls back to plain shapes
  constructor(host, grid, assets = { models: {}, textures: {} }) {
    this.host = host;
    this.grid = grid;
    this.assets = assets;
    this.tmp = new THREE.Vector3();
    this.lastTime = null;
    this.epoch = 0;   // how many times the GPU context was rebuilt
    this.ox = -grid.w / 2;
    this.oz = -grid.h / 2;
    this.view = 'angled';

    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);
    r.domElement.setAttribute('aria-label', 'Mission Evade 3D view');
    this.renderer = r;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(C.bg);
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 300);

    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    host.appendChild(this.labels);

    this.buildLights();
    this.buildStatic();
    this.buildDynamic();
    this.guardViews = new Map();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.prewarm();
  }

  // grid → scene
  sx(x) { return x + this.ox; }
  sz(y) { return y + this.oz; }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xe6edf6, 0x30363f, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-9, 22, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = Math.max(this.grid.w, this.grid.h) * 0.62;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 60 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  buildStatic() {
    const g = this.grid;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(g.w, g.h),
      this.surface('floor', C.floor, { roughness: 0.95 }, [g.w / 2, g.h / 2]),   // the texture covers 2x2 cells
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const lines = [];
    for (let x = 0; x <= g.w; x++) lines.push(this.sx(x), 0.004, this.sz(0), this.sx(x), 0.004, this.sz(g.h));
    for (let y = 0; y <= g.h; y++) lines.push(this.sx(0), 0.004, this.sz(y), this.sx(g.w), 0.004, this.sz(y));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: C.gridLine, transparent: true, opacity: this.assets.textures.floor ? 0.18 : 0.55 })));

    // Walls: one instanced box mesh, with a lighter cap on top for readability from above.
    const wallCells = [];
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.isWall(x, y)) wallCells.push([x, y]);
    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, WALL_H, 1),
      this.surface('wall', C.wall, { roughness: 0.7, metalness: 0.15 }),
      wallCells.length,
    );
    const caps = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: C.wallTop, roughness: 0.7 }),
      wallCells.length,
    );
    const m = new THREE.Matrix4();
    wallCells.forEach(([x, y], i) => {
      m.makeTranslation(this.sx(x + 0.5), WALL_H / 2, this.sz(y + 0.5));
      walls.setMatrixAt(i, m);
      m.makeTranslation(this.sx(x + 0.5), WALL_H + 0.002, this.sz(y + 0.5));
      caps.setMatrixAt(i, m);
    });
    walls.castShadow = true;
    walls.receiveShadow = true;
    this.scene.add(walls, caps);

    // Start and exit tiles.
    const tile = (cell, color, opacity) => {
      const t = new THREE.Mesh(
        new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
      );
      t.position.set(this.sx(cell.x + 0.5), 0.01, this.sz(cell.y + 0.5));
      this.scene.add(t);
      return t;
    };
    tile(g.start, C.start, 0.25);
    this.exitTile = tile(g.exit, C.exit, 0.85);
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 1.6, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: C.exit, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    beacon.position.set(this.sx(g.exit.x + 0.5), 0.8, this.sz(g.exit.y + 0.5));
    this.scene.add(beacon);
    this.exitBeacon = beacon;
    this.buildDoor();

    // Heat map tiles (memory), one instance per floor cell.
    this.freeCells = g.freeCells();
    this.heatMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.62, depthWrite: false }),
      this.freeCells.length,
    );
    this.freeCells.forEach((c, i) => {
      m.makeTranslation(this.sx(c.x + 0.5), 0.015, this.sz(c.y + 0.5));
      this.heatMesh.setMatrixAt(i, m);
      this.heatMesh.setColorAt(i, C.heatLow);
    });
    this.heatMesh.visible = false;
    this.scene.add(this.heatMesh);
    this.heatVersion = -1;
  }

  // A textured material, or a plain colour if the texture did not load.
  surface(name, color, props = {}, repeat = null) {
    const map = this.assets.textures[name], normalMap = this.assets.textures[`${name}_n`];
    if (repeat) for (const t of [map, normalMap]) t?.repeat.set(...repeat);
    return new THREE.MeshStandardMaterial({ ...props, color: map ? 0xffffff : color, map: map || null, normalMap: normalMap || null });
  }

  // The exit door stands against a wall of the exit cell and opens while the exit is open.
  buildDoor() {
    const src = this.assets.models['exit-door'];
    if (!src) return;
    const e = this.grid.exit;
    // East, then west, then north, then south: whichever side of the exit cell is a wall.
    const [dx, dy] = [[1, 0], [-1, 0], [0, -1], [0, 1]].find(([x, y]) => this.grid.isWall(e.x + x, e.y + y)) || [1, 0];
    const door = src.scene.clone(true);
    const lamp = new THREE.MeshBasicMaterial({ color: C.exit });
    const panel = this.surface('door', 0x7b8592, { roughness: 0.55, metalness: 0.3 });
    const parts = {};
    door.traverse((o) => {
      parts[o.name] = o;
      if (!o.isMesh) return;
      o.castShadow = true;
      if (o.material.name === 'Lamp') o.material = lamp;
      if (o.material.name === 'Panel') o.material = panel;
    });
    door.position.set(this.sx(e.x + 0.5 + dx * 0.44), 0, this.sz(e.y + 0.5 + dy * 0.44));
    door.rotation.y = Math.atan2(dy, -dx);   // the model faces +x: turn it to face into the room
    this.scene.add(door);
    const { PanelL, PanelR } = parts;
    if (PanelL && PanelR) this.door = { PanelL, PanelR, lamp, zL: PanelL.position.z, zR: PanelR.position.z, open: 1 };
  }

  // A character: a cloned model with its own animation mixer, or a plain body.
  makeActor(name, color, radius, height) {
    const src = this.assets.models[name];
    if (!src) return { grp: this.makeBody(color, radius, height), mixer: null, visor: null };
    const grp = src.scene.clone(true);   // rigid parts, so a plain clone shares geometry safely
    let visor = null;
    grp.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      if (o.material.name === 'Visor') { o.material = o.material.clone(); visor = o.material; }
    });
    const mixer = new THREE.AnimationMixer(grp);
    const clips = {};
    for (const c of src.animations) {
      clips[c.name] = mixer.clipAction(c);
      if (c.name === 'Idle') clips[c.name].play();
    }
    return { grp, mixer, visor, clips, clip: 'Idle', x: null, y: null, pace: 0 };
  }

  // Pick the clip from how fast the body really moves, and match the clip's pace to it.
  animate(a, x, y, dt) {
    if (!a.mixer || dt <= 0) return;
    const moved = a.x == null ? 0 : Math.hypot(x - a.x, y - a.y);
    a.x = x;
    a.y = y;
    if (moved > 1) return;               // a new run put the body somewhere else
    a.pace += (moved / dt - a.pace) * Math.min(1, dt * 14);
    const want = a.pace < 0.25 ? 'Idle' : a.pace > RUN_FROM ? 'Run' : 'Walk';
    if (want !== a.clip && a.clips[want]) {
      const from = a.clips[a.clip], to = a.clips[want];
      to.reset().setEffectiveWeight(1).play();
      from?.crossFadeTo(to, 0.14, false);
      a.clip = want;
    }
    const pace = CLIP_PACE[a.clip];
    if (pace && a.clips[a.clip]) a.clips[a.clip].setEffectiveTimeScale(Math.max(0.5, a.pace / pace));
    a.mixer.update(dt);
  }

  buildDynamic() {
    const body = (color, radius, height) => {
      const grp = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
      const torso = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.85, radius, height, 20), mat);
      torso.position.y = height / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.72, 20, 14), mat);
      head.position.y = height + radius * 0.55;
      torso.castShadow = head.castShadow = true;
      grp.add(torso, head);
      return grp;
    };
    this.makeBody = body;

    this.player = this.makeActor('player', C.player, 0.27, 0.62);
    this.scene.add(this.player.grp);

    this.decoyMeshes = [];
    this.noiseRings = [];
  }

  makeGuardView(g) {
    const actor = this.makeActor('guard', C.guard, 0.3, 0.68);
    const grp = actor.grp;
    if (!actor.mixer) {   // a plain body needs a nose to show where it looks
      const nose = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x1b1f25 }));
      nose.position.set(0.24, 0.98, 0);
      grp.add(nose);
    }
    this.scene.add(grp);

    const coneGeo = new THREE.BufferGeometry();
    const pos = new Float32Array((CONE_SEGMENTS + 2) * 3);
    coneGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const idx = [];
    for (let i = 1; i <= CONE_SEGMENTS; i++) idx.push(0, i + 1, i);
    coneGeo.setIndex(idx);
    const coneMat = new THREE.MeshBasicMaterial({ color: STATE_COLORS.PATROL, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.renderOrder = 2;
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((CONE_SEGMENTS + 2) * 3), 3));
    const edge = new THREE.LineLoop(edgeGeo, new THREE.LineBasicMaterial({ color: STATE_COLORS.PATROL, transparent: true, opacity: 0.9 }));
    edge.renderOrder = 3;
    this.scene.add(cone, edge);

    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
    const path = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: C.path, transparent: true, opacity: 0.95 }));
    path.renderOrder = 4;
    path.frustumCulled = false;
    this.scene.add(path);

    // Draw the loop the guard actually walks: A* between consecutive waypoints, smoothed.
    const loop = [];
    for (let i = 0; i < g.patrol.length; i++) {
      const a = g.patrol[i], b = g.patrol[(i + 1) % g.patrol.length];
      const res = findPath(this.grid, { x: Math.floor(a.x), y: Math.floor(a.y) }, { x: Math.floor(b.x), y: Math.floor(b.y) });
      const pts = [{ x: a.x, y: a.y }, ...res.path.slice(1).map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }))];
      loop.push(pts[0], ...smoothPath(this.grid, pts, GUARD_RADIUS * 0.85));
    }
    loop.push(loop[0]);
    const routePts = loop.map((p) => new THREE.Vector3(this.sx(p.x), 0.03, this.sz(p.y)));
    const routeGeo = new THREE.BufferGeometry().setFromPoints(routePts);
    const route = new THREE.Line(routeGeo, new THREE.LineDashedMaterial({ color: C.route, dashSize: 0.32, gapSize: 0.2 }));
    route.computeLineDistances();
    this.scene.add(route);

    let watch = null;
    const wp = g.patrol.find((p) => p.watch);
    if (wp) {
      watch = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: C.learn, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
      ring.position.y = 0.025;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 8),
        new THREE.MeshBasicMaterial({ color: C.learn, transparent: true, opacity: 0.55 }));
      beam.position.y = 0.7;
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 3).rotateZ(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: C.learn }));
      arrow.position.set(Math.cos(wp.face) * 0.62, 0.03, Math.sin(wp.face) * 0.62);
      arrow.rotation.y = -wp.face;
      watch.add(ring, beam, arrow);
      watch.position.set(this.sx(wp.x), 0, this.sz(wp.y));
      watch.userData.ring = ring;
      this.scene.add(watch);
    }

    const label = document.createElement('div');
    label.className = 'glabel';
    label.innerHTML = '<span class="gname"></span><span class="gstate"></span>';
    this.labels.appendChild(label);

    return { actor, grp, cone, edge, path, route, watch, label, lastState: null, epoch: this.epoch };
  }

  // Every run builds new guard views, so free the GPU memory of the old ones.
  disposeGuardView(v) {
    v.actor.mixer?.stopAllAction();
    v.actor.mixer?.uncacheRoot(v.grp);
    for (const o of [v.grp, v.cone, v.edge, v.path, v.route, v.watch]) if (o) this.scene.remove(o);
    v.label.remove();
    if (v.epoch !== this.epoch) return;   // its GPU objects went with the lost context; deleting them is an error
    const owned = v.actor.mixer ? [] : [v.grp];   // a model's geometry is shared with every other guard
    for (const o of [...owned, v.cone, v.edge, v.path, v.route, v.watch]) {
      o?.traverse((m) => { m.geometry?.dispose(); m.material?.dispose(); });
    }
    v.actor.visor?.dispose();
  }

  // Rebuild guard views when the world changes (new run, stress guards added or removed).
  syncGuards(world) {
    const want = new Set(world.guards);
    for (const [g, v] of this.guardViews) if (!want.has(g)) { this.disposeGuardView(v); this.guardViews.delete(g); }
    for (const g of world.guards) if (!this.guardViews.has(g)) this.guardViews.set(g, this.makeGuardView(g));
  }

  setHeat(heat, version) {
    if (version === this.heatVersion) return;
    this.heatVersion = version;
    let max = 0;
    for (const c of this.freeCells) max = Math.max(max, heat[this.grid.idx(c.x, c.y)]);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    this.freeCells.forEach((c, i) => {
      const h = max > 0 ? heat[this.grid.idx(c.x, c.y)] / max : 0;
      const s = h > 0.04 ? 1 : 0;
      m.makeScale(s, 1, s).setPosition(this.sx(c.x + 0.5), 0.015, this.sz(c.y + 0.5));
      this.heatMesh.setMatrixAt(i, m);
      col.copy(C.heatLow).lerp(C.heatHigh, h);
      this.heatMesh.setColorAt(i, col);
    });
    this.heatMesh.instanceMatrix.needsUpdate = true;
    if (this.heatMesh.instanceColor) this.heatMesh.instanceColor.needsUpdate = true;
  }

  update(world, opts, time) {
    const { showPaths, showRoutes, showHeat } = opts;
    this.heatMesh.visible = !!showHeat;
    this.syncGuards(world);
    const dt = this.lastTime == null ? 0 : Math.min(0.1, time - this.lastTime);
    this.lastTime = time;

    const p = world.player;
    this.player.grp.position.set(this.sx(p.x), 0, this.sz(p.y));
    this.player.grp.rotation.y = -p.face;
    this.animate(this.player, p.x, p.y, dt);
    // The exit glows green while open, red while a guard is on alert.
    const exitColor = world.exitOpen ? C.exit : C.exitLocked;
    this.exitTile.material.color.setHex(exitColor);
    this.exitBeacon.material.color.setHex(exitColor);
    this.exitBeacon.material.opacity = 0.14 + Math.sin(time * 3) * 0.06;
    if (this.door) {   // each panel slides into its side of the frame
      const d = this.door;
      d.open += ((world.exitOpen ? 1 : 0) - d.open) * Math.min(1, dt * 7);
      const s = 1 - 0.8 * d.open;
      d.PanelL.scale.z = d.PanelR.scale.z = s;
      d.PanelL.position.z = d.zL - 0.21 * (1 - s);
      d.PanelR.position.z = d.zR + 0.21 * (1 - s);
      d.lamp.color.setHex(exitColor);
    }

    for (const g of world.guards) {
      const v = this.guardViews.get(g);
      v.grp.position.set(this.sx(g.x), 0, this.sz(g.y));
      v.grp.rotation.y = -g.face;
      this.animate(v.actor, g.x, g.y, dt);
      this.updateCone(g, v, world);
      const col = STATE_COLORS[g.state] || STATE_COLORS.PATROL;
      v.cone.material.color.setHex(col);
      v.edge.material.color.setHex(col);
      if (v.actor.visor) { v.actor.visor.color.setHex(col); v.actor.visor.emissive.setHex(col); }
      v.cone.material.opacity = g.state === 'CHASE' ? 0.5 : g.state === 'PATROL' ? 0.36 : 0.44;

      v.path.visible = !!showPaths && g.bb.path.length > 0;
      if (v.path.visible) {
        const arr = v.path.geometry.attributes.position.array;
        const pts = [{ x: g.x, y: g.y }, ...g.bb.path].slice(0, 96);
        pts.forEach((q, i) => { arr[i * 3] = this.sx(q.x); arr[i * 3 + 1] = 0.06; arr[i * 3 + 2] = this.sz(q.y); });
        v.path.geometry.setDrawRange(0, pts.length);
        v.path.geometry.attributes.position.needsUpdate = true;
        v.path.material.color.setHex(col);
      }
      v.route.visible = !!showRoutes;
      if (v.watch) {
        const s = 1 + Math.sin(time * 4) * 0.08;
        v.watch.userData.ring.scale.set(s, 1, s);
      }

      // State label above the guard.
      if (v.lastState !== g.state) {
        v.label.querySelector('.gname').textContent = g.id;
        v.label.querySelector('.gstate').textContent = g.state === 'SUSPICIOUS' ? '?' : g.state === 'CHASE' ? '!' : g.state.toLowerCase();
        v.label.dataset.state = g.state;
        v.lastState = g.state;
      }
      this.placeLabel(v.label, g.x, g.y, 1.55);
    }

    this.updateDecoys(world, time);
  }

  updateCone(g, v, world) {
    const P = g.params;
    const half = (P.coneAngle * Math.PI) / 360;
    const range = P.coneRange;
    const pos = v.cone.geometry.attributes.position.array;
    const epos = v.edge.geometry.attributes.position.array;
    const y = 0.035;
    pos[0] = this.sx(g.x); pos[1] = y; pos[2] = this.sz(g.y);
    epos[0] = pos[0]; epos[1] = y + 0.005; epos[2] = pos[2];
    for (let i = 0; i <= CONE_SEGMENTS; i++) {
      const a = g.face - half + (2 * half * i) / CONE_SEGMENTS;
      const d = world.grid.rayDistance(g.x, g.y, a, range);
      const k = (i + 1) * 3;
      pos[k] = this.sx(g.x + Math.cos(a) * d); pos[k + 1] = y; pos[k + 2] = this.sz(g.y + Math.sin(a) * d);
      epos[k] = pos[k]; epos[k + 1] = y + 0.005; epos[k + 2] = pos[k + 2];
    }
    v.cone.geometry.attributes.position.needsUpdate = true;
    v.cone.geometry.computeBoundingSphere();
    v.edge.geometry.attributes.position.needsUpdate = true;
    v.edge.geometry.computeBoundingSphere();
  }

  makeDecoy() {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf2c94c, emissive: 0x6b4f00 }));
    m.castShadow = true;
    this.scene.add(m);
    return m;
  }

  makeRing() {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf2c94c, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    ring.renderOrder = 5;
    this.scene.add(ring);
    return ring;
  }

  // Draw a decoy and a ring once while loading, so their shaders are ready before the first throw.
  prewarm() {
    this.decoyMeshes.push(this.makeDecoy());
    this.noiseRings.push(this.makeRing());
    this.render();
    this.decoyMeshes[0].visible = this.noiseRings[0].visible = false;
  }

  updateDecoys(world, time) {
    while (this.decoyMeshes.length < world.decoys.length) {
      this.decoyMeshes.push(this.makeDecoy());
    }
    this.decoyMeshes.forEach((m, i) => {
      const d = world.decoys[i];
      m.visible = !!d;
      if (!d) return;
      const k = Math.min(1, d.t / d.flight);
      const x = d.fromX + (d.x - d.fromX) * k, y = d.fromY + (d.y - d.fromY) * k;
      m.position.set(this.sx(x), 0.13 + Math.sin(k * Math.PI) * 1.1, this.sz(y));
    });

    while (this.noiseRings.length < world.noises.length) {
      this.noiseRings.push(this.makeRing());
    }
    this.noiseRings.forEach((r, i) => {
      const n = world.noises[i];
      r.visible = !!n;
      if (!n) return;
      const age = world.time - n.t;
      const radius = 0.3 + (age / 1.6) * (n.kind === 'radio call' ? 4 : world.params.hearingRange);
      r.scale.set(radius, 1, radius);
      r.position.set(this.sx(n.x), 0.05, this.sz(n.y));
      r.material.color.setHex(n.kind === 'radio call' ? 0xe23e44 : 0xf2c94c);
      r.material.opacity = Math.max(0, 0.9 - age / 1.6);
    });
  }

  placeLabel(el, x, y, h) {
    const v = this.tmp.set(this.sx(x), h, this.sz(y)).project(this.camera);
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * hh}px) translate(-50%, -100%)`;
  }

  setView(view) { this.view = view; this.fitCamera(); }

  fitCamera() {
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600;
    const cam = this.camera;
    cam.aspect = w / h;
    const vfov = (cam.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
    const needW = (this.grid.w / 2 + 0.6) / Math.tan(hfov / 2);
    const needH = (this.grid.h / 2 + 0.6) / Math.tan(vfov / 2);
    if (this.view === 'top') {
      const d = Math.max(needW, needH) + WALL_H;
      cam.position.set(0, d, 0.001);
      cam.lookAt(0, 0, 0);
    } else {
      const d = Math.max(needW, needH * 1.12) * 1.04;
      const tilt = (58 * Math.PI) / 180;
      cam.position.set(0, Math.sin(tilt) * d, Math.cos(tilt) * d);
      cam.lookAt(0, 0, 0.6);
    }
    cam.updateProjectionMatrix();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.fitCamera();
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
