// Reinforcements. From security level 2 on, every level adds one guard. Each new
// guard is posted where run memory says the player gets caught or spotted, and
// falls back to the cells the player walks most, then to the shortest route to the exit.
// Pure functions of (grid, memory), so the same posts come out in the browser and in tests.

import { findPath } from './astar.js';
import { GUARD_DEFS, REINFORCE_IDS, REINFORCE_RULES, PARAM_SPEC } from './config.js';

const RECENT = 0.8;   // a run's weight shrinks by this per newer run
const WEIGHT = { caught: 3, spotted: 2, route: 0.5 };
const FROM_MEMORY = new Set(Object.keys(WEIGHT));

// Floor cells ranked by how much memory says about the player there.
// Each comes with the reason that contributed most: 'caught', 'spotted' or 'route'.
export function hotSpots(grid, mem) {
  const cells = new Map();
  const add = (x, y, v, why) => {
    if (!grid.isWalkable(x, y) || v <= 0) return;
    const i = grid.idx(x, y);
    const c = cells.get(i) || { x, y, score: 0, by: { caught: 0, spotted: 0, route: 0 } };
    c.score += v;
    c.by[why] += v;
    cells.set(i, c);
  };
  const runs = mem.runs || [];
  runs.forEach((r, k) => {
    const w = RECENT ** (runs.length - 1 - k);
    if (r.outcome === 'caught' && r.route?.length) {
      const [x, y] = r.route[r.route.length - 1];
      add(x, y, WEIGHT.caught * w, 'caught');
    }
    for (const d of r.detections || []) add(d.x, d.y, WEIGHT.spotted * w, 'spotted');
  });
  if (mem.heat) {
    for (const c of grid.freeCells()) add(c.x, c.y, WEIGHT.route * (mem.heat[grid.idx(c.x, c.y)] || 0), 'route');
  }
  return [...cells.values()]
    .map((c) => ({ x: c.x, y: c.y, score: c.score, reason: topReason(c.by) }))
    .sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
}

const topReason = (by) => Object.entries(by).sort((a, b) => b[1] - a[1])[0][0];

// The exit approach: floor cells within REINFORCE_RULES.exitZone steps of the exit.
const zones = new WeakMap();
export function exitZone(grid) {
  if (zones.has(grid)) return zones.get(grid);
  const steps = new Map([[grid.idx(grid.exit.x, grid.exit.y), 0]]);
  const zone = [grid.exit];
  for (let i = 0; i < zone.length; i++) {
    const c = zone[i], d = steps.get(grid.idx(c.x, c.y));
    if (d === REINFORCE_RULES.exitZone) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (!grid.isWalkable(n.x, n.y) || steps.has(grid.idx(n.x, n.y))) continue;
      steps.set(grid.idx(n.x, n.y), d + 1);
      zone.push(n);
    }
  }
  zones.set(grid, zone);
  return zone;
}

// Could a guard standing on c see cell z at the longest vision range the learner allows?
const sees = (grid, c, z) => Math.hypot(z.x - c.x, z.y - c.y) <= PARAM_SPEC.coneRange.max
  && grid.lineOfSight(c.x + 0.5, c.y + 0.5, z.x + 0.5, z.y + 0.5);

// Why a cell cannot be a post or part of a beat (or null if it can). Reinforcements
// must leave the player a fair start and a way out: they never stand in, or look
// into, the exit approach. The base guards still patrol it.
export function postProblem(grid, c, taken = []) {
  const R = REINFORCE_RULES;
  if (!grid.isWalkable(c.x, c.y)) return 'not a floor cell';
  const ds = Math.hypot(c.x - grid.start.x, c.y - grid.start.y);
  if (ds < R.minFromStart) return 'too close to the start';
  if (sees(grid, c, grid.start)) return 'can see the start';
  const zone = exitZone(grid);
  if (zone.some((z) => z.x === c.x && z.y === c.y)) return 'in the exit approach';
  if (zone.some((z) => sees(grid, c, z))) return 'can see the exit approach';
  if (taken.some((t) => Math.hypot(c.x - t.x, c.y - t.y) < R.minApart)) return 'too close to another guard';
  return null;
}

// The guard definitions for `count` reinforcements, best posts first.
// Guards are spread out: a reinforcement's whole beat may share ground (a cell on, or
// next to, another guard's walk) with at most REINFORCE_RULES.maxShared other guards.
// Only if the map runs out of room is that limit raised, one guard at a time.
export function reinforcementDefs(grid, mem, count) {
  const n = Math.max(0, Math.min(count, REINFORCE_IDS.length));
  if (!n) return [];
  const heat = mem.heat || [];
  const candidates = postCandidates(grid, mem);
  const taken = GUARD_DEFS.map((g) => ({ x: g.route[0][0], y: g.route[0][1] }));
  const ground = new Map();   // cell index → how many guards walk on or next to it
  for (const g of GUARD_DEFS) tread(grid, ground, walkOf(grid, g.route));

  // A post needs a beat to walk (a fair second cell nearby). Where memory says the player was
  // caught, spotted or walks, a one-cell post is still worth it: that guard is a sentry and
  // looks around. Other one-cell posts are a last resort.
  const defs = [];
  const tries = [];
  for (let limit = REINFORCE_RULES.maxShared; limit <= GUARD_DEFS.length + n; limit++) tries.push({ limit, standing: false });
  tries.push({ limit: GUARD_DEFS.length + n, standing: true });
  for (const { limit, standing } of tries) {
    if (defs.length >= n) break;
    const roomy = (c) => (ground.get(grid.idx(c.x, c.y)) || 0) <= limit;
    for (const c of candidates) {
      if (defs.length >= n) break;
      if (postProblem(grid, c, taken) || !roomy(c)) continue;
      const partner = patrolPartner(grid, c, heat, roomy);
      if (!partner && !standing && !FROM_MEMORY.has(c.reason)) continue;
      const route = partner ? [[c.x, c.y], [partner.x, partner.y]] : [[c.x, c.y]];
      const id = REINFORCE_IDS[defs.length];
      defs.push({ id, name: `Guard ${id}`, reinforcement: true, reason: c.reason, route });
      taken.push(c);
      tread(grid, ground, walkOf(grid, route));
    }
  }
  return defs;
}

// Posts to try, best first: memory hot spots, then the shortest way out (from its
// middle outwards), then any floor cell.
function postCandidates(grid, mem) {
  const out = [], seen = new Set();
  const add = (c, reason) => {
    const i = grid.idx(c.x, c.y);
    if (seen.has(i)) return;
    seen.add(i);
    out.push({ x: c.x, y: c.y, reason });
  };
  for (const c of hotSpots(grid, mem)) add(c, c.reason);
  const path = findPath(grid, grid.start, grid.exit).path || [];
  const mid = path.length / 2;
  path.map((c, i) => ({ c, d: Math.abs(i - mid) })).sort((a, b) => a.d - b.d).forEach(({ c }) => add(c, 'shortest route'));
  for (const c of grid.freeCells()) add(c, 'open floor');
  return out;
}

// Every cell a guard walks on its loop (A* between consecutive waypoints).
export function walkOf(grid, route) {
  const pts = route.map(([x, y]) => ({ x, y }));
  if (pts.length < 2) return pts;
  const cells = [];
  for (let i = 0; i < pts.length; i++) cells.push(...(findPath(grid, pts[i], pts[(i + 1) % pts.length]).path || []));
  return cells;
}

// Mark the ground one guard covers: its walk plus the cells next to it, counted once per guard.
function tread(grid, ground, walk) {
  const mine = new Set();
  for (const c of walk) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (grid.isWalkable(c.x + dx, c.y + dy)) mine.add(grid.idx(c.x + dx, c.y + dy));
    }
  }
  for (const i of mine) ground.set(i, (ground.get(i) || 0) + 1);
}

// A short beat for the reinforcement: the most-walked fair cell within a few steps of its post.
// Every cell the guard walks on the way (its actual A* path) must be fair and roomy too.
function patrolPartner(grid, post, heat, roomy) {
  const ok = (c) => !postProblem(grid, c) && roomy(c);
  const reach = REINFORCE_RULES.patrolReach;
  const seen = new Map([[grid.idx(post.x, post.y), 0]]);
  const queue = [post];
  const options = [];
  while (queue.length) {
    const c = queue.shift();
    const d = seen.get(grid.idx(c.x, c.y));
    if (d >= 2) options.push({ c, score: (heat[grid.idx(c.x, c.y)] || 0) + d * 0.01 });   // walked cells first, then longer beats
    if (d === reach) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (seen.has(grid.idx(n.x, n.y)) || !ok(n)) continue;
      seen.set(grid.idx(n.x, n.y), d + 1);
      queue.push(n);
    }
  }
  options.sort((a, b) => b.score - a.score);
  for (const { c } of options) {
    const path = findPath(grid, post, c).path || [];
    if (path.every(ok)) return c;
  }
  return null;
}
