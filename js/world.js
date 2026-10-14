// The simulation. No drawing code lives here, so the same World runs in the
// browser (with the 3D view attached) and in Node tests (headless).

import { Guard } from './guard.js';
import {
  PLAYER_SPEED, PLAYER_RADIUS, DECOYS_PER_RUN, DECOY_THROW,
} from './config.js';

export class World {
  /**
   * @param {object} o
   * @param {import('./grid.js').Grid} o.grid
   * @param {object} o.params        learnable guard parameters
   * @param {object[]} o.guardDefs   guard id, name, route
   * @param {object} [o.watchPoints] learned watch points by guard id: {x, y} cells or null
   * @param {number[]} [o.heat]      memory heat map, used to aim watch points
   */
  constructor({ grid, params, guardDefs, watchPoints = {}, heat = null }) {
    this.grid = grid;
    this.params = { ...params };
    this.time = 0;
    this.outcome = null;      // null | 'escaped' | 'caught'
    this.caughtBy = null;
    this.player = {
      x: grid.start.x + 0.5, y: grid.start.y + 0.5,
      r: PLAYER_RADIUS, speed: PLAYER_SPEED, face: 0, moving: false,
    };
    this.watchPoints = resolveWatchPoints(grid, watchPoints, heat);
    this.guards = guardDefs.map((d) => new Guard(d, this));
    this.decoys = [];
    this.decoysLeft = DECOYS_PER_RUN;
    this.decoyCooldown = 0;
    this.noises = [];         // short-lived, for drawing sound rings
    this.route = [{ x: grid.start.x, y: grid.start.y, t: 0 }];
    this.detections = [];
    this.decoyLog = [];
    this.log = [];
    this.nextId = 1;
  }

  addGuard(def) { this.guards.push(new Guard(def, this)); }
  removeStressGuards() { this.guards = this.guards.filter((g) => !g.stress); }

  step(dt, input = {}) {
    if (this.outcome) return;
    this.time += dt;
    this.movePlayer(dt, input);
    if (input.decoy) this.throwDecoy();
    this.updateDecoys(dt);
    for (const g of this.guards) g.sense(dt);
    for (const g of this.guards) g.think(dt);
    this.recordRoute();
    if (!this.outcome) {
      const p = this.player, e = this.grid.exit;
      if (Math.floor(p.x) === e.x && Math.floor(p.y) === e.y) {
        this.outcome = 'escaped';
        this.note('Player reached the exit');
      }
    }
    this.noises = this.noises.filter((n) => this.time - n.t < 1.6);
  }

  movePlayer(dt, { dx = 0, dy = 0 } = {}) {
    const p = this.player;
    if (!dx && !dy) { p.moving = false; return; }
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    p.face = Math.atan2(dy, dx);
    p.moving = true;
    const s = p.speed * dt;
    const nx = p.x + dx * s;
    if (!this.collides(nx, p.y, p.r)) p.x = nx;
    const ny = p.y + dy * s;
    if (!this.collides(p.x, ny, p.r)) p.y = ny;
  }

  collides(x, y, r) {
    const g = this.grid;
    return g.isWall(Math.floor(x - r), Math.floor(y - r)) || g.isWall(Math.floor(x + r), Math.floor(y - r))
        || g.isWall(Math.floor(x - r), Math.floor(y + r)) || g.isWall(Math.floor(x + r), Math.floor(y + r));
  }

  // The decoy is thrown ahead of the player, stops at walls, and makes noise on landing.
  throwDecoy() {
    if (this.decoysLeft <= 0 || this.decoyCooldown > 0 || this.outcome) return false;
    const p = this.player;
    const reach = Math.max(0.25, this.grid.rayDistance(p.x, p.y, p.face, DECOY_THROW) - 0.35);
    const d = {
      id: this.nextId++, fromX: p.x, fromY: p.y,
      x: p.x + Math.cos(p.face) * reach, y: p.y + Math.sin(p.face) * reach,
      t: 0, flight: 0.45, landed: false,
    };
    this.decoys.push(d);
    this.decoysLeft--;
    this.decoyCooldown = 0.8;
    this.decoyLog.push({ x: Math.floor(d.x), y: Math.floor(d.y), t: round1(this.time) });
    this.note(`Decoy thrown to (${Math.floor(d.x)}, ${Math.floor(d.y)})`);
    return true;
  }

  updateDecoys(dt) {
    this.decoyCooldown = Math.max(0, this.decoyCooldown - dt);
    for (const d of this.decoys) {
      d.t += dt;
      if (!d.landed && d.t >= d.flight) {
        d.landed = true;
        this.emitNoise({ x: d.x, y: d.y, kind: 'decoy' });
      }
    }
    this.decoys = this.decoys.filter((d) => d.t < d.flight + 3);
  }

  emitNoise(noise) {
    const n = { ...noise, t: this.time };
    this.noises.push(n);
    for (const g of this.guards) {
      if (g.hear(n)) this.note(`${g.name} heard a ${n.kind} and goes to check`);
    }
  }

  // Called by a guard when its suspicion reaches 1. It radios the others.
  guardAlerted(g) {
    const p = this.player;
    this.detections.push({ x: Math.floor(p.x), y: Math.floor(p.y), t: round1(this.time), guard: g.id });
    this.note(`${g.name} spotted the player — chasing`);
    this.emitNoise({ x: p.x, y: p.y, kind: 'radio call', from: g });
  }

  playerCaught(g) {
    if (this.outcome) return;
    this.outcome = 'caught';
    this.caughtBy = g.id;
    this.note(`${g.name} caught the player`);
  }

  recordRoute() {
    const p = this.player;
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    const last = this.route[this.route.length - 1];
    if (last.x !== cx || last.y !== cy) this.route.push({ x: cx, y: cy, t: round1(this.time) });
  }

  note(text) { this.log.push({ t: round1(this.time), text }); }
}

const round1 = (v) => Math.round(v * 10) / 10;

// Validate learned watch points against the map and give each a facing,
// aimed at where the player has walked most near that point.
export function resolveWatchPoints(grid, watchPoints, heat) {
  const out = {};
  for (const [id, wp] of Object.entries(watchPoints || {})) {
    if (!wp || !grid.isWalkable(wp.x, wp.y)) { out[id] = null; continue; }
    out[id] = { x: wp.x, y: wp.y, face: aimFrom(grid, wp, heat) };
  }
  return out;
}

function aimFrom(grid, wp, heat) {
  const cx = wp.x + 0.5, cy = wp.y + 0.5;
  let sx = 0, sy = 0, total = 0;
  if (heat) {
    for (let y = Math.max(0, wp.y - 6); y <= Math.min(grid.h - 1, wp.y + 6); y++) {
      for (let x = Math.max(0, wp.x - 6); x <= Math.min(grid.w - 1, wp.x + 6); x++) {
        const h = heat[grid.idx(x, y)] || 0;
        if (h <= 0 || (x === wp.x && y === wp.y)) continue;
        if (!grid.lineOfSight(cx, cy, x + 0.5, y + 0.5)) continue;
        const d = Math.hypot(x - wp.x, y - wp.y);
        sx += ((x - wp.x) / d) * h; sy += ((y - wp.y) / d) * h; total += h;
      }
    }
  }
  if (total > 0 && Math.hypot(sx, sy) > 1e-6) return Math.atan2(sy, sx);
  // Fallback: face the most open direction.
  let best = 0, bestD = -1;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const d = grid.rayDistance(cx, cy, a, 10);
    if (d > bestD) { bestD = d; best = a; }
  }
  return best;
}
