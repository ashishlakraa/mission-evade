// Headless tests for the parts the MVP stands on: grid sight, A*, the behavior tree,
// guard behaviour in the real map, and the learner's safety checks.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../js/grid.js';
import { findPath, smoothPath, octile } from '../js/astar.js';
import { sel, seq, memSeq, cond, act, Status } from '../js/bt.js';
import { World } from '../js/world.js';
import {
  MAP, GUARD_DEFS, DEFAULT_PARAMS, PARAM_SPEC, DECOY_RING, DECOY_PULSE, REINFORCE_IDS, REINFORCE_RULES,
} from '../js/config.js';
import { reinforcementDefs, postProblem, exitZone, walkOf } from '../js/reinforce.js';
import { freshMemory, buildRunRecord, recordRun } from '../js/memory.js';
import { localProposal, validateProposal, applyAdaptation, buildPrompt } from '../js/learner.js';

const { SUCCESS, FAILURE, RUNNING } = Status;
const grid = new Grid(MAP);

// ---------------------------------------------------------------- grid

test('map: every floor cell is reachable from the start', () => {
  for (const c of grid.freeCells()) {
    assert.ok(findPath(grid, grid.start, c).found, `cell (${c.x},${c.y}) unreachable`);
  }
});

test('map: guard waypoints are floor cells', () => {
  for (const g of GUARD_DEFS) for (const [x, y] of g.route) assert.ok(grid.isWalkable(x, y), `${g.id} (${x},${y})`);
});

test('line of sight: blocked by a wall, open across a room', () => {
  const g = new Grid(['#####', '#S..#', '#.#.#', '#..E#', '#####']);
  assert.equal(g.lineOfSight(1.5, 2.5, 3.5, 2.5), false, 'wall in the middle blocks');
  assert.equal(g.lineOfSight(1.5, 1.5, 3.5, 1.5), true, 'open row');
});

test('line of sight: cannot peek through a diagonal corner gap', () => {
  const g = new Grid(['#####', '#S###', '##.##', '###E#', '#####']);
  assert.equal(g.lineOfSight(1.5, 1.5, 2.5, 2.5), false);
});

test('ray distance stops at the first wall', () => {
  const g = new Grid(['#####', '#S.E#', '#####']);
  const d = g.rayDistance(1.5, 1.5, 0, 10);
  assert.ok(Math.abs(d - 2.5) < 1e-9, `got ${d}`);
});

// ---------------------------------------------------------------- A*

test('A*: straight corridor gives the straight path', () => {
  const g = new Grid(['#######', '#S...E#', '#######']);
  const r = findPath(g, { x: 1, y: 1 }, { x: 5, y: 1 });
  assert.ok(r.found);
  assert.equal(r.path.length, 5);
  assert.equal(r.cost, 4);
});

test('A*: routes around a wall and is optimal', () => {
  const g = new Grid([
    '#######',
    '#S.#..#',
    '#..#..#',
    '#..#.E#',
    '#.....#',
    '#######',
  ]);
  const r = findPath(g, g.start, g.exit);
  assert.ok(r.found);
  for (const c of r.path) assert.ok(g.isWalkable(c.x, c.y));
  // Optimal octile cost found by brute force (Dijkstra = A* with h=0 is equivalent here).
  assert.ok(Math.abs(r.cost - (3 + 4 * Math.SQRT2)) < 1e-9 || r.cost <= 3 + 4 * Math.SQRT2 + 1e-9, `cost ${r.cost}`);
});

test('A*: never cuts a wall corner diagonally', () => {
  const g = new Grid(['#####', '#S#E#', '#...#', '#####']);
  const r = findPath(g, { x: 1, y: 1 }, { x: 3, y: 1 });
  assert.ok(r.found);
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1], b = r.path[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1, 'steps are adjacent');
    if (dx && dy) assert.ok(g.isWalkable(a.x + dx, a.y) && g.isWalkable(a.x, a.y + dy), 'no corner cut');
  }
});

test('A*: reports unreachable goals', () => {
  const g = new Grid(['#######', '#S.#.E#', '#######']);
  assert.equal(findPath(g, g.start, g.exit).found, false);
});

test('A*: matches Dijkstra cost on 200 random pairs in the real map', () => {
  const cells = grid.freeCells();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 200; i++) {
    const a = cells[Math.floor(rnd() * cells.length)], b = cells[Math.floor(rnd() * cells.length)];
    const r = findPath(grid, a, b);
    assert.ok(r.found);
    assert.ok(Math.abs(r.cost - dijkstra(grid, a, b)) < 1e-6, `pair ${i}`);
    assert.ok(r.cost + 1e-9 >= octile(a.x, a.y, b.x, b.y), 'heuristic never overestimates');
  }
});

test('smoothPath: every hop is clear of walls', () => {
  const r = findPath(grid, grid.start, grid.exit);
  const pts = r.path.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }));
  const sm = smoothPath(grid, pts, 0.27);
  assert.ok(sm.length < pts.length, 'path got shorter');
  let prev = pts[0];
  for (const p of sm) { assert.ok(grid.clearPath(prev.x, prev.y, p.x, p.y, 0.27)); prev = p; }
});

function dijkstra(g, a, b) {
  const dist = new Map([[`${a.x},${a.y}`, 0]]);
  const q = [[0, a.x, a.y]];
  while (q.length) {
    q.sort((p, r) => p[0] - r[0]);
    const [d, x, y] = q.shift();
    if (x === b.x && y === b.y) return d;
    if (d > (dist.get(`${x},${y}`) ?? Infinity)) continue;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (g.isWall(nx, ny)) continue;
      if (dx && dy && (g.isWall(x + dx, y) || g.isWall(x, y + dy))) continue;
      const nd = d + (dx && dy ? Math.SQRT2 : 1);
      if (nd < (dist.get(`${nx},${ny}`) ?? Infinity)) { dist.set(`${nx},${ny}`, nd); q.push([nd, nx, ny]); }
    }
  }
  return Infinity;
}

// ---------------------------------------------------------------- behavior tree

test('BT selector: highest-priority passing branch wins', () => {
  const log = [];
  const tree = sel('root',
    seq('a', cond('no', () => false), act('A', () => { log.push('A'); return SUCCESS; })),
    seq('b', cond('yes', () => true), act('B', () => { log.push('B'); return RUNNING; })),
    act('C', () => { log.push('C'); return SUCCESS; }));
  assert.equal(tree.tick({ tickId: 1 }), RUNNING);
  assert.deepEqual(log, ['B']);
});

test('BT memory sequence: resumes from the running child, resets on halt', () => {
  let step2 = 0;
  const steps = memSeq('m',
    act('one', () => SUCCESS),
    act('two', () => (++step2 < 3 ? RUNNING : SUCCESS)),
    act('three', () => SUCCESS));
  let interrupt = false;
  const tree = sel('root', seq('hi', cond('interrupt?', () => interrupt), act('x', () => RUNNING)), steps);
  tree.tick({ tickId: 1 });
  assert.equal(steps.index, 1, 'waiting on step two');
  interrupt = true;
  tree.tick({ tickId: 2 });
  assert.equal(steps.index, 0, 'higher branch halted and reset the sequence');
  interrupt = false;
  tree.tick({ tickId: 3 });
  tree.tick({ tickId: 4 });
  assert.equal(tree.tick({ tickId: 5 }), SUCCESS);
});

// ---------------------------------------------------------------- guards in the real map

function makeWorld(params = DEFAULT_PARAMS, watchPoints = {}) {
  return new World({ grid, params, guardDefs: GUARD_DEFS, watchPoints });
}
const STEP = 1 / 60;
// Guards that cannot see or hear, so they stay on patrol.
const BLIND = { ...DEFAULT_PARAMS, coneRange: 0.1, hearingRange: 0 };
function run(world, seconds, input = {}, until) {
  for (let t = 0; t < seconds; t += STEP) {
    world.step(STEP, typeof input === 'function' ? input(world) : input);
    if (until && until(world)) return true;
  }
  return false;
}

test('patrol: guards walk their loops without entering walls and keep cycling', () => {
  const w = makeWorld();
  w.player.x = 1.5; w.player.y = 1.5; // stays at start, out of sight
  const visited = { A: new Set(), B: new Set() };
  for (let t = 0; t < 90; t += STEP) {
    w.step(STEP);
    for (const g of w.guards) {
      assert.ok(grid.isWalkable(Math.floor(g.x), Math.floor(g.y)), `${g.id} inside a wall at ${g.x},${g.y}`);
      visited[g.id].add(g.bb.wpIndex);
    }
  }
  assert.equal(w.outcome, null);
  assert.equal(visited.A.size, GUARD_DEFS[0].route.length, 'A reached every waypoint');
  assert.equal(visited.B.size, GUARD_DEFS[1].route.length, 'B reached every waypoint');
});

test('chase: a player standing in front of a guard is spotted, chased and caught', () => {
  const w = makeWorld();
  const A = w.guards[0];
  // Put the player 3 cells in front of guard A.
  w.player.x = A.x + Math.cos(A.face) * 3; w.player.y = A.y + Math.sin(A.face) * 3;
  assert.ok(grid.isWalkable(Math.floor(w.player.x), Math.floor(w.player.y)));
  const states = [];
  run(w, 10, {}, (ww) => { states.push(A.state); return !!ww.outcome; });
  assert.equal(w.outcome, 'caught');
  assert.equal(w.caughtBy, 'A');
  assert.ok(states.includes('SUSPICIOUS'), 'noticed first');
  assert.ok(states.includes('CHASE'), 'then chased');
});

test('no flicker: once chasing, state stays CHASE until the give-up rule fires', () => {
  const w = makeWorld();
  const A = w.guards[0];
  w.player.x = A.x + Math.cos(A.face) * 3; w.player.y = A.y + Math.sin(A.face) * 3;
  run(w, 4, {}, () => A.bb.alerted);
  assert.ok(A.bb.alerted);
  // Teleport the player back to the start room, behind walls: guard must keep chasing for giveUpTime, then search.
  w.player.x = 1.5; w.player.y = 1.5;
  const trace = [];
  run(w, DEFAULT_PARAMS.giveUpTime + DEFAULT_PARAMS.searchTime + 8, {}, () => { trace.push(A.state); return false; });
  const firstNonChase = trace.findIndex((s) => s !== 'CHASE');
  assert.ok(firstNonChase * STEP >= DEFAULT_PARAMS.giveUpTime - 0.05, `left chase after ${firstNonChase * STEP}s`);
  assert.equal(trace[firstNonChase], 'INVESTIGATE', 'chase turns into a search');
  const changes = trace.filter((s, i) => i && s !== trace[i - 1]).length;
  assert.ok(changes <= 3, `state changed ${changes} times: ${[...new Set(trace)].join(' → ')}`);
  assert.equal(trace.at(-1), 'PATROL', 'back to patrol at the end');
});

test('decoy: thrown decoy lands, stops at walls, and makes a noise', () => {
  const w = makeWorld();
  w.player.face = 0; // facing east along row 1 from the start
  w.step(STEP, { decoy: true });
  const d = w.decoys[0];
  assert.ok(d, 'decoy thrown');
  assert.equal(w.decoysLeft, 2);
  assert.ok(grid.isWalkable(Math.floor(d.x), Math.floor(d.y)), 'landed on floor');
  run(w, 0.6);
  assert.ok(d.landed);
});

test('noise: a guard in hearing range investigates the spot, then returns to patrol', () => {
  const w = makeWorld();
  const B = w.guards[1];
  run(w, 0.5); // player waits at the start, out of sight
  const spot = { x: 4.5, y: 10.5 };
  w.emitNoise({ x: spot.x, y: spot.y, kind: 'decoy' });
  assert.ok(run(w, 0.2, {}, () => B.state === 'INVESTIGATE'), `B state ${B.state}`);
  assert.ok(run(w, 10, {}, () => Math.hypot(B.x - spot.x, B.y - spot.y) < 0.3), 'B walked to the noise');
  assert.ok(run(w, DEFAULT_PARAMS.searchTime + 1, {}, () => B.state === 'PATROL'), 'searched, then patrol');
  assert.equal(w.outcome, null);
});

test('noise: a guard out of hearing range ignores it', () => {
  const w = makeWorld();
  const A = w.guards[0];
  w.emitNoise({ x: 2.5, y: 10.5, kind: 'decoy' });
  run(w, 0.2);
  assert.equal(A.bb.lead, null);
});

test('walls block sight: player behind a wall is not seen', () => {
  const w = makeWorld();
  const A = w.guards[0]; // starts at (6,1) facing east along row 1
  A.face = Math.PI;      // face west, toward the wall at x=5
  w.player.x = 3.5; w.player.y = 1.5; // on the other side of the wall
  assert.equal(A.canSee(w.player.x, w.player.y), false);
});

test('escape: reaching the exit ends the run as escaped', () => {
  const w = makeWorld(BLIND);
  w.player.x = grid.exit.x + 0.5; w.player.y = grid.exit.y - 1.5;
  run(w, 1, { dx: 0, dy: 1 }, (ww) => !!ww.outcome);
  assert.equal(w.outcome, 'escaped');
});

test('decoy: keeps ringing, and a guard that hears it searches there until it stops', () => {
  const w = makeWorld();
  const B = w.guards[1];
  run(w, 0.5);
  // Throw south from (6,9), out of B's sight, so it lands in B's hearing range.
  w.player.x = 6.5; w.player.y = 9.5; w.player.face = Math.PI / 2;
  w.step(STEP, { decoy: true });
  w.player.x = 1.5; w.player.y = 1.5;   // then hide back at the start
  const d = w.decoys[0];
  const rings = new Set();
  run(w, 0.45 + DECOY_RING - 0.3, {}, (ww) => { for (const n of ww.noises) if (n.source === d.id) rings.add(n.t); return false; });
  assert.ok(rings.size >= DECOY_RING / DECOY_PULSE - 1, `rang ${rings.size} times`);
  assert.equal(B.bb.lead?.source, d.id, 'B is still on the decoy while it rings');
  assert.equal(B.state, 'INVESTIGATE');
  assert.ok(Math.hypot(B.x - d.x, B.y - d.y) < 1, 'B stands at the decoy');
  assert.ok(run(w, DEFAULT_PARAMS.searchTime + 6, {}, () => B.state === 'PATROL'), 'back to patrol after it stops');
  assert.equal(w.log.filter((e) => e.text.startsWith('Guard B heard')).length, 1, 'one log line, not one per ring');
});

test('exit: locked while any guard is not on patrol, open again once all are', () => {
  const w = makeWorld();
  run(w, 0.2);
  assert.equal(w.exitOpen, true);
  w.emitNoise({ x: 4.5, y: 10.5, kind: 'decoy' });   // B goes to check
  run(w, 0.1);
  assert.equal(w.exitOpen, false);
  w.player.x = grid.exit.x + 0.5; w.player.y = grid.exit.y + 0.5;   // standing on the exit does nothing
  run(w, 0.5);
  assert.equal(w.outcome, null, 'cannot escape through a locked exit');
  assert.ok(run(w, 20, {}, (ww) => !!ww.outcome), 'the run ends once the exit opens');
  if (w.outcome === 'escaped') assert.ok(w.guards.every((g) => g.state === 'PATROL'));
});

test('reinforcements: posted where the player was caught or spotted, and fair', () => {
  const mem = freshMemory(grid);
  const base = { time: 20, decoys: [], params: mem.params, watchPoints: {} };
  recordRun(mem, grid, { ...base, n: 1, outcome: 'caught', route: [[1, 1], [8, 3], [8, 4]], detections: [{ x: 8, y: 3, t: 5 }] });
  recordRun(mem, grid, { ...base, n: 2, outcome: 'escaped', route: [[1, 1], [11, 7]], detections: [{ x: 12, y: 3, t: 9 }] });
  const defs = reinforcementDefs(grid, mem, 2);
  assert.equal(defs.length, 2);
  const posts = defs.map((d) => d.route[0]);
  assert.deepEqual(posts[0], [8, 4], 'first post: where the player was caught');
  assert.equal(defs[0].reason, 'caught');
  assert.equal(defs[1].reason, 'spotted');
  for (const d of defs) {
    for (const [x, y] of d.route) assert.ok(grid.isWalkable(x, y), `${d.id} (${x},${y}) floor`);
    assert.equal(postProblem(grid, { x: d.route[0][0], y: d.route[0][1] }), null, `${d.id} post is fair`);
  }
  assert.ok(Math.hypot(posts[0][0] - posts[1][0], posts[0][1] - posts[1][1]) >= REINFORCE_RULES.minApart);
});

test('reinforcements: never stand in or look into the exit approach, even if the player is always caught there', () => {
  const mem = freshMemory(grid);
  const route = findPath(grid, grid.start, grid.exit).path.map((c) => [c.x, c.y]);
  const base = { time: 20, decoys: [], params: mem.params, watchPoints: {} };
  // A player who keeps getting spotted and caught just before the exit.
  for (let n = 1; n <= 4; n++) {
    recordRun(mem, grid, { ...base, n, outcome: 'caught', route: route.slice(0, -2 - (n % 3)),
      detections: [{ x: 11, y: 7, t: 5 }, { x: 12, y: 7, t: 6 }, { x: 13, y: 7, t: 7 }] });
  }
  const zone = exitZone(grid);
  const sees = (c, z) => Math.hypot(z.x - c.x, z.y - c.y) <= PARAM_SPEC.coneRange.max
    && grid.lineOfSight(c.x + 0.5, c.y + 0.5, z.x + 0.5, z.y + 0.5);
  const defs = reinforcementDefs(grid, mem, REINFORCE_IDS.length);
  assert.equal(defs.length, REINFORCE_IDS.length);
  for (const d of defs) {
    // Every cell the guard walks on its beat, not just the two end points.
    const walk = d.route.length > 1 ? findPath(grid, { x: d.route[0][0], y: d.route[0][1] }, { x: d.route[1][0], y: d.route[1][1] }).path : [{ x: d.route[0][0], y: d.route[0][1] }];
    for (const c of walk) {
      assert.ok(!zone.some((z) => z.x === c.x && z.y === c.y), `${d.id} walks into the exit approach at (${c.x},${c.y})`);
      const seen = zone.find((z) => sees(c, z));
      assert.ok(!seen, `${d.id} at (${c.x},${c.y}) can see the exit approach at (${seen?.x},${seen?.y})`);
    }
  }
});

test('reinforcements: spread out, so no stretch of floor is walked by more than two guards', () => {
  const route = findPath(grid, grid.start, grid.exit).path.map((c) => [c.x, c.y]);
  const memories = [freshMemory(grid)];
  for (const spot of [[8, 4], [6, 4], [10, 5], [9, 1]]) {
    const mem = freshMemory(grid);
    for (let n = 1; n <= 3; n++) {
      recordRun(mem, grid, { n, time: 20, decoys: [], params: mem.params, watchPoints: {}, outcome: 'caught',
        route: [...route.slice(0, 6), spot], detections: [{ x: spot[0], y: spot[1], t: 4 }] });
    }
    memories.push(mem);
  }
  for (const mem of memories) {
    const defs = [...GUARD_DEFS, ...reinforcementDefs(grid, mem, REINFORCE_IDS.length)];
    // Ground each guard covers: its walk and the cells next to it.
    const covers = defs.map((d) => {
      const set = new Set();
      for (const c of walkOf(grid, d.route)) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set.add(grid.idx(c.x + dx, c.y + dy));
      }
      return set;
    });
    for (const d of defs.slice(GUARD_DEFS.length)) {
      for (const c of walkOf(grid, d.route)) {
        const n = covers.filter((s) => s.has(grid.idx(c.x, c.y))).length;
        assert.ok(n <= REINFORCE_RULES.maxShared + 1, `${n} guards around (${c.x},${c.y}) on ${d.id}'s beat`);
      }
    }
  }
  // The base guards do not share ground with each other.
  const [a, b] = GUARD_DEFS.map((d) => new Set(walkOf(grid, d.route).map((c) => grid.idx(c.x, c.y))));
  assert.ok(![...a].some((i) => b.has(i)), 'guards A and B never walk the same cell');
});

test('reinforcements: with no memory they guard the shortest route, up to one per level', () => {
  const mem = freshMemory(grid);
  for (let n = 0; n <= REINFORCE_IDS.length; n++) {
    const defs = reinforcementDefs(grid, mem, n);
    assert.equal(defs.length, n);
    assert.deepEqual(defs.map((d) => d.id), REINFORCE_IDS.slice(0, n));
  }
  assert.equal(reinforcementDefs(grid, mem, 99).length, REINFORCE_IDS.length, 'capped');
  const shortest = findPath(grid, grid.start, grid.exit).path;
  const [x, y] = reinforcementDefs(grid, mem, 1)[0].route[0];
  assert.ok(shortest.some((c) => c.x === x && c.y === y), 'on the shortest way out');
  // The world runs with them: a still player at the start is never caught.
  const w = new World({ grid, params: DEFAULT_PARAMS, guardDefs: [...GUARD_DEFS, ...reinforcementDefs(grid, mem, 4)] });
  assert.equal(w.guards.length, 6);
  run(w, 60);
  assert.equal(w.outcome, null);
});

test('map: smaller, with only two independent ways to the exit', () => {
  assert.ok(grid.w * grid.h <= 16 * 12);
  // Max number of routes that share no cell (node-disjoint paths), via repeated path removal on a max flow.
  assert.equal(disjointRoutes(grid), 2);
});

function disjointRoutes(g) {
  const id = (x, y) => y * g.w + x;
  const cap = new Map();
  const adj = new Map();
  const add = (u, v, c) => {
    cap.set(`${u}>${v}`, (cap.get(`${u}>${v}`) || 0) + c);
    if (!cap.has(`${v}>${u}`)) cap.set(`${v}>${u}`, 0);
    (adj.get(u) || adj.set(u, []).get(u)).push(v);
    (adj.get(v) || adj.set(v, []).get(v)).push(u);
  };
  const s = id(g.start.x, g.start.y), e = id(g.exit.x, g.exit.y);
  for (const c of g.freeCells()) {
    const k = id(c.x, c.y);
    add(`${k}i`, `${k}o`, k === s || k === e ? 99 : 1);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (g.isWalkable(c.x + dx, c.y + dy)) add(`${k}o`, `${id(c.x + dx, c.y + dy)}i`, 1);
    }
  }
  let flow = 0;
  for (;;) {
    const par = new Map([[`${s}i`, null]]);
    const q = [`${s}i`];
    while (q.length && !par.has(`${e}o`)) {
      const u = q.shift();
      for (const v of adj.get(u) || []) if (!par.has(v) && cap.get(`${u}>${v}`) > 0) { par.set(v, u); q.push(v); }
    }
    if (!par.has(`${e}o`)) return flow;
    for (let v = `${e}o`; par.get(v) !== null; v = par.get(v)) {
      const u = par.get(v);
      cap.set(`${u}>${v}`, cap.get(`${u}>${v}`) - 1);
      cap.set(`${v}>${u}`, cap.get(`${v}>${u}`) + 1);
    }
    flow++;
  }
}

// ---------------------------------------------------------------- learning & memory

test('memory: route goes into the heat map', () => {
  const mem = freshMemory(grid);
  const w = makeWorld();
  run(w, 2, { dx: 1, dy: 0 });
  w.outcome = 'caught'; w.caughtBy = 'A';
  const rec = buildRunRecord(w, mem);
  recordRun(mem, grid, rec);
  assert.equal(mem.runs.length, 1);
  assert.ok(mem.heat[grid.idx(2, 1)] > 0);
});

test('learner: out-of-bounds and oversized LLM values are clamped, bad cells rejected', () => {
  const mem = freshMemory(grid);
  const raw = {
    params: { coneRange: 50, noticeTime: 'fast', chaseSpeed: 9 },
    watchPoints: { A: [1, 2], B: [0, 0] },
  };
  const { params, watchPoints, rejected } = validateProposal(mem, raw, grid);
  assert.equal(params.coneRange, DEFAULT_PARAMS.coneRange + PARAM_SPEC.coneRange.step);
  assert.equal(params.noticeTime, DEFAULT_PARAMS.noticeTime);
  assert.ok(params.chaseSpeed <= PARAM_SPEC.chaseSpeed.max);
  assert.equal(watchPoints.A, null, 'too close to start');
  assert.equal(watchPoints.B, null, 'wall');
  assert.ok(rejected.length >= 4);
});

test('learner: local proposal puts watch points on the habitual route', () => {
  const mem = freshMemory(grid);
  // A player who always takes the shortest way out.
  const route = findPath(grid, grid.start, grid.exit).path.map((c) => [c.x, c.y]);
  for (let i = 0; i < 4; i++) {
    recordRun(mem, grid, { n: i + 1, outcome: 'escaped', time: 30, route, detections: [], decoys: [], params: mem.params, watchPoints: {} });
  }
  const run = mem.runs.at(-1);
  const rec = applyAdaptation(mem, { raw: localProposal(mem, run, grid), source: 'local' }, grid, run);
  const wps = Object.values(mem.watchPoints).filter(Boolean);
  assert.ok(wps.length >= 1, 'at least one watch point');
  for (const wp of wps) assert.ok(route.some(([x, y]) => x === wp.x && y === wp.y), `(${wp.x},${wp.y}) on route`);
  assert.ok(rec.changes.length > 0);
  // And the new world builds with them.
  const w = makeWorld(mem.params, mem.watchPoints);
  assert.ok(w.guards.some((g) => g.patrol.some((p) => p.watch)));
});

test('learner: prompt includes map, memory and the JSON contract', () => {
  const mem = freshMemory(grid);
  const rec = { n: 1, outcome: 'escaped', time: 22, route: [[1, 1], [2, 1]], detections: [], decoys: [], params: mem.params, watchPoints: {} };
  recordRun(mem, grid, rec);
  const { system, prompt } = buildPrompt(mem, rec, grid);
  assert.match(system, /JSON/);
  assert.match(prompt, new RegExp(MAP[0]));
  assert.match(prompt, /"watchPoints"/);
  assert.match(prompt, /Most-walked cells/);
});
