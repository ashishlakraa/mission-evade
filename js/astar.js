// A* pathfinding on the grid.
// - 8-directional movement, diagonal cost √2
// - no corner cutting (a diagonal step needs both side cells free)
// - octile distance heuristic (admissible and consistent for this move set)
// - binary min-heap open list with lazy deletion
// - smoothPath() then removes zig-zags with radius-aware line-of-sight checks

const SQRT2 = Math.SQRT2;
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];
const now = () => (globalThis.performance ? performance.now() : Date.now());

class MinHeap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop(), lastKey = keys.pop();
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lastKey;
        if (l < n && keys[l] < mk) { m = l; mk = keys[l]; }
        if (r < n && keys[r] < mk) { m = r; }
        if (m === i) break;
        ids[i] = ids[m]; keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}

// Shared counters, shown in the debug panel.
export const pathStats = { calls: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastExpanded: 0 };

export function octile(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * Find a path between two cells.
 * @returns {{found:boolean, path:{x:number,y:number}[], cost:number, expanded:number, ms:number, closed:Uint8Array|null}}
 */
export function findPath(grid, start, goal, { keepClosed = false } = {}) {
  const t0 = now();
  const s = grid.nearestWalkable(start.x, start.y);
  const g = grid.nearestWalkable(goal.x, goal.y);
  const W = grid.w, N = grid.w * grid.h;
  const result = { found: false, path: [], cost: Infinity, expanded: 0, ms: 0, closed: null };
  if (!s || !g) return finish(result, t0);

  const gScore = new Float64Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = new MinHeap();
  const sId = s.y * W + s.x, gId = g.y * W + g.x;
  gScore[sId] = 0;
  // A tiny tie-break factor prefers nodes closer to the goal among equal f-scores.
  open.push(sId, octile(s.x, s.y, g.x, g.y) * 1.0001);

  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;           // lazy deletion of stale heap entries
    closed[cur] = 1;
    expanded++;
    if (cur === gId) break;
    const cx = cur % W, cy = (cur / W) | 0;
    const cg = gScore[cur];
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (grid.isWall(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (grid.isWall(cx + dx, cy) || grid.isWall(cx, cy + dy))) continue;
      const nId = ny * W + nx;
      if (closed[nId]) continue;
      const ng = cg + cost;
      if (ng < gScore[nId]) {
        gScore[nId] = ng;
        parent[nId] = cur;
        open.push(nId, ng + octile(nx, ny, g.x, g.y) * 1.0001);
      }
    }
  }

  result.expanded = expanded;
  if (keepClosed) result.closed = closed;
  if (!closed[gId]) return finish(result, t0);

  const path = [];
  for (let id = gId; id !== -1; id = parent[id]) path.push({ x: id % W, y: (id / W) | 0 });
  path.reverse();
  result.found = true;
  result.path = path;
  result.cost = gScore[gId];
  return finish(result, t0);
}

function finish(result, t0) {
  result.ms = now() - t0;
  pathStats.calls++;
  pathStats.totalMs += result.ms;
  pathStats.lastMs = result.ms;
  pathStats.lastExpanded = result.expanded;
  if (result.ms > pathStats.maxMs) pathStats.maxMs = result.ms;
  return result;
}

/**
 * String-pulling: keep only the points needed so every straight hop is clear
 * for a body of radius r. pts[0] is the current position and is not returned.
 */
export function smoothPath(grid, pts, r) {
  if (pts.length <= 1) return [];
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !grid.clearPath(pts[i].x, pts[i].y, pts[j].x, pts[j].y, r)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}
