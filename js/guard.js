// A guard = perception (sense) + a behavior tree (think) + A* movement.
//
// Behavior tree (highest priority first):
//
//   Root (Selector)
//   ├─ Catch       (Sequence)  Touching player? → Catch player
//   ├─ Chase       (Sequence)  Alerted? → Chase player
//   ├─ Notice      (Sequence)  Glimpsing player? → Turn and stare
//   ├─ Investigate (Sequence)  Has a lead? → [Go to lead → Search area → Clear lead] (memory sequence)
//   └─ Patrol      (Sequence)  Walk patrol route
//
// State changes are driven by two accumulators so they never flicker:
//   suspicion fills while the player is in sight and drains when not; Chase starts only at 1.0.
//   lostTime counts time out of sight; Chase only ends after giveUpTime, turning into a search.

import { Status, sel, seq, memSeq, cond, act } from './bt.js';
import { findPath, smoothPath } from './astar.js';
import { GUARD_RADIUS, CATCH_DISTANCE, WATCH_PAUSE } from './config.js';

const { SUCCESS, FAILURE, RUNNING } = Status;
const TURN_RATE = 6.5;           // rad/s
const DEG = Math.PI / 180;

export const STATE_OF_BRANCH = {
  Catch: 'CHASE', Chase: 'CHASE', Notice: 'SUSPICIOUS', Investigate: 'INVESTIGATE', Patrol: 'PATROL',
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Guard {
  constructor(def, world) {
    this.world = world;
    this.id = def.id;
    this.name = def.name;
    this.stress = !!def.stress;
    this.route = def.route.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
    this.patrol = buildPatrol(this.route, world.watchPoints[this.id] || null, world.grid);
    this.x = this.patrol[0].x;
    this.y = this.patrol[0].y;
    const nxt = this.patrol[1 % this.patrol.length];
    this.face = Math.atan2(nxt.y - this.y, nxt.x - this.x) || 0;

    this.bb = {
      seesPlayer: false, suspicion: 0, alerted: false,
      lastKnown: null, lostTime: 0, lastGlimpse: null,
      lead: null, leadSeq: 0,
      path: [], pathKey: null, pathTarget: null, pathAge: 99, pathFailed: false,
      wpIndex: 1 % this.patrol.length, pause: 0, pauseFace: 0,
      searchT: 0, searchBase: 0,
    };
    this.state = 'PATROL';
    this.lastSearch = null; // last A* result, for the debug overlay
    this.tickId = 0;
    this.tree = this.buildTree();
  }

  get params() { return this.world.params; }

  buildTree() {
    this.investigateSteps = memSeq('Investigate steps',
      act('Go to lead', (c) => this.actGoToLead(c)),
      act('Search area', (c) => this.actSearch(c)),
      act('Clear lead', () => { this.bb.lead = null; return SUCCESS; }),
    );
    return sel('Root',
      seq('Catch',
        cond('Touching player?', () => this.touchingPlayer()),
        act('Catch player', () => { this.world.playerCaught(this); return SUCCESS; })),
      seq('Chase',
        cond('Alerted?', () => this.bb.alerted),
        act('Chase player', (c) => this.actChase(c))),
      seq('Notice',
        cond('Glimpsing player?', () => this.bb.seesPlayer && this.bb.suspicion > 0),
        act('Turn and stare', (c) => this.actStare(c))),
      seq('Investigate',
        cond('Has a lead?', () => !!this.bb.lead),
        this.investigateSteps),
      seq('Patrol',
        act('Walk patrol route', (c) => this.actPatrol(c))),
    );
  }

  // ---------- perception ----------

  canSee(px, py) {
    const P = this.params;
    const dx = px - this.x, dy = py - this.y;
    const d = Math.hypot(dx, dy);
    if (d > P.coneRange) return false;
    if (d > 0.35 && Math.abs(wrap(Math.atan2(dy, dx) - this.face)) > (P.coneAngle * DEG) / 2) return false;
    return this.world.grid.lineOfSight(this.x, this.y, px, py);
  }

  sense(dt) {
    const bb = this.bb, P = this.params, p = this.world.player;
    const sawBefore = bb.seesPlayer;
    bb.seesPlayer = this.canSee(p.x, p.y);
    if (bb.seesPlayer) {
      const d = Math.hypot(p.x - this.x, p.y - this.y);
      const closeness = 1 + (1 - d / P.coneRange) * 1.5; // nearer = spotted faster
      bb.suspicion = Math.min(1, bb.suspicion + (dt / P.noticeTime) * closeness);
      bb.lastGlimpse = { x: p.x, y: p.y };
      if (bb.alerted) { bb.lastKnown = { x: p.x, y: p.y }; bb.lostTime = 0; }
      else if (bb.suspicion >= 1) this.becomeAlerted();
    } else {
      bb.suspicion = Math.max(0, bb.suspicion - dt * 0.45);
      if (bb.alerted) bb.lostTime += dt;
      // Lost a half-seen figure: go and check where it was.
      if (sawBefore && !bb.alerted && bb.suspicion > 0.3 && bb.lastGlimpse) this.setLead(bb.lastGlimpse, 'glimpse');
    }
  }

  becomeAlerted() {
    const bb = this.bb, p = this.world.player;
    bb.alerted = true;
    bb.suspicion = 1;
    bb.lastKnown = { x: p.x, y: p.y };
    bb.lostTime = 0;
    bb.lead = null;
    this.investigateSteps.halt({});
    this.world.guardAlerted(this);
  }

  // A noise (decoy, radio call) reaches this guard. Returns true if it reacts.
  hear(noise) {
    if (this.bb.alerted || noise.from === this) return false;
    const d = Math.hypot(noise.x - this.x, noise.y - this.y);
    if (d > this.params.hearingRange) return false;
    this.setLead({ x: noise.x, y: noise.y }, noise.kind);
    return true;
  }

  setLead(pos, reason) {
    const bb = this.bb;
    bb.lead = { x: pos.x, y: pos.y, reason, id: ++bb.leadSeq };
    this.investigateSteps.halt({}); // restart the investigation for the new lead
  }

  touchingPlayer() {
    const p = this.world.player;
    const d = Math.hypot(p.x - this.x, p.y - this.y);
    return d < CATCH_DISTANCE && this.world.grid.lineOfSight(this.x, this.y, p.x, p.y);
  }

  // ---------- thinking ----------

  think(dt) {
    this.tickId++;
    this.bb.pathAge += dt;
    const ctx = { dt, tickId: this.tickId };
    this.tree.tick(ctx);
    for (const branch of this.tree.children) {
      if (branch.tickId === this.tickId && branch.status !== FAILURE) {
        this.state = STATE_OF_BRANCH[branch.name] || this.state;
        break;
      }
    }
  }

  actPatrol(c) {
    const bb = this.bb;
    if (bb.pause > 0) {
      bb.pause -= c.dt;
      this.turnToward(bb.pauseFace + Math.sin(bb.pause * 2.4) * 0.35, c.dt);
      return RUNNING;
    }
    const wp = this.patrol[bb.wpIndex];
    this.ensurePath(`patrol:${bb.wpIndex}`, wp);
    if (bb.pathFailed) { bb.wpIndex = (bb.wpIndex + 1) % this.patrol.length; return RUNNING; }
    const arrived = this.moveAlong(c.dt, this.params.patrolSpeed);
    if (arrived) {
      if (wp.watch) { bb.pause = WATCH_PAUSE; bb.pauseFace = wp.face; }
      bb.wpIndex = (bb.wpIndex + 1) % this.patrol.length;
    }
    return RUNNING;
  }

  actChase(c) {
    const bb = this.bb, P = this.params, p = this.world.player;
    if (bb.seesPlayer) {
      this.ensurePath('chase', p, 0.2);
      this.moveAlong(c.dt, P.chaseSpeed);
      if (Math.hypot(p.x - this.x, p.y - this.y) < 1.2) this.turnToward(Math.atan2(p.y - this.y, p.x - this.x), c.dt);
      return RUNNING;
    }
    if (bb.lostTime >= P.giveUpTime) {
      // Give up the chase: it becomes a search of the last known position.
      bb.alerted = false;
      bb.suspicion = 0;
      this.setLead(bb.lastKnown, 'lost sight');
      return FAILURE;
    }
    this.ensurePath('chase-last', bb.lastKnown);
    const arrived = this.moveAlong(c.dt, P.chaseSpeed);
    if (arrived) this.turnToward(this.face + 2.2, c.dt);
    return RUNNING;
  }

  actStare(c) {
    const p = this.world.player;
    this.turnToward(Math.atan2(p.y - this.y, p.x - this.x), c.dt);
    return RUNNING;
  }

  actGoToLead(c) {
    const bb = this.bb, lead = bb.lead;
    if (!lead) return FAILURE;
    this.ensurePath(`lead:${lead.id}`, lead);
    const arrived = bb.pathFailed || this.moveAlong(c.dt, this.params.patrolSpeed * 1.4);
    if (arrived) { bb.searchT = 0; bb.searchBase = this.face; return SUCCESS; }
    return RUNNING;
  }

  actSearch(c) {
    const bb = this.bb;
    bb.searchT += c.dt;
    this.turnToward(bb.searchBase + Math.sin(bb.searchT * 2.1) * 1.4, c.dt);
    return bb.searchT >= this.params.searchTime ? SUCCESS : RUNNING;
  }

  // ---------- movement ----------

  // Re-plan when the purpose (key) changes, or when a moving target changes cell
  // and at least `every` seconds have passed (throttled re-planning for a chase).
  ensurePath(key, target, every = Infinity) {
    const bb = this.bb;
    const tcx = Math.floor(target.x), tcy = Math.floor(target.y);
    const moved = !bb.pathTarget || Math.floor(bb.pathTarget.x) !== tcx || Math.floor(bb.pathTarget.y) !== tcy;
    const spent = bb.path.length === 0 && Math.hypot(target.x - this.x, target.y - this.y) > 0.3;
    const need = bb.pathKey !== key || (bb.pathAge >= every && (moved || spent));
    if (need) this.plan(key, target);
  }

  plan(key, target) {
    const bb = this.bb, grid = this.world.grid;
    const res = findPath(grid, { x: Math.floor(this.x), y: Math.floor(this.y) },
      { x: Math.floor(target.x), y: Math.floor(target.y) }, { keepClosed: true });
    this.lastSearch = res;
    bb.pathKey = key;
    bb.pathTarget = { x: target.x, y: target.y };
    bb.pathAge = 0;
    bb.pathFailed = !res.found;
    if (!res.found) { bb.path = []; return; }
    const pts = res.path.map((cell) => ({ x: cell.x + 0.5, y: cell.y + 0.5 }));
    const tc = res.path[res.path.length - 1];
    if (Math.floor(target.x) === tc.x && Math.floor(target.y) === tc.y) pts[pts.length - 1] = { x: target.x, y: target.y };
    pts.unshift({ x: this.x, y: this.y });
    bb.path = smoothPath(grid, pts, GUARD_RADIUS * 0.85);
  }

  // Walk along the current path. Returns true once the path is used up.
  moveAlong(dt, speed) {
    const path = this.bb.path;
    let remain = speed * dt;
    let heading = null;
    while (remain > 1e-9 && path.length) {
      const t = path[0];
      const dx = t.x - this.x, dy = t.y - this.y, d = Math.hypot(dx, dy);
      if (d > 1e-4) heading = Math.atan2(dy, dx);
      if (d <= remain) { this.x = t.x; this.y = t.y; remain -= d; path.shift(); }
      else { this.x += (dx / d) * remain; this.y += (dy / d) * remain; remain = 0; }
    }
    if (heading !== null) this.turnToward(heading, dt);
    return path.length === 0;
  }

  turnToward(angle, dt) {
    const diff = wrap(angle - this.face);
    const max = TURN_RATE * dt;
    this.face = wrap(this.face + Math.max(-max, Math.min(max, diff)));
  }
}

// Insert a learned watch point into the patrol loop where it adds the least walking.
function buildPatrol(route, watch, grid) {
  const pts = route.map((p) => ({ x: p.x, y: p.y, watch: false }));
  if (!watch || !grid.isWalkable(watch.x, watch.y)) return pts;
  const w = { x: watch.x + 0.5, y: watch.y + 0.5, watch: true, face: watch.face ?? 0 };
  let best = 0, bestCost = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cost = Math.hypot(w.x - a.x, w.y - a.y) + Math.hypot(b.x - w.x, b.y - w.y) - Math.hypot(b.x - a.x, b.y - a.y);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  pts.splice(best + 1, 0, w);
  return pts;
}
