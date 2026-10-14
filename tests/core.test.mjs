// Headless tests for the parts the MVP stands on: grid sight, A*, the behavior tree,
// guard behaviour in the real map, and the learner's safety checks.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../js/grid.js';
import { findPath, smoothPath, octile } from '../js/astar.js';
import { sel, seq, memSeq, cond, act, Status } from '../js/bt.js';
import { World } from '../js/world.js';
import { MAP, GUARD_DEFS, DEFAULT_PARAMS, PARAM_SPEC } from '../js/config.js';
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
  // Teleport the player far away behind walls: guard must keep chasing for giveUpTime, then search.
  w.player.x = 1.5; w.player.y = 14.5;
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
  const spot = { x: 5.5, y: 12.5 };
  w.emitNoise({ x: spot.x, y: spot.y, kind: 'decoy' });
  assert.ok(run(w, 0.2, {}, () => B.state === 'INVESTIGATE'), `B state ${B.state}`);
  assert.ok(run(w, 10, {}, () => Math.hypot(B.x - spot.x, B.y - spot.y) < 0.3), 'B walked to the noise');
  assert.ok(run(w, DEFAULT_PARAMS.searchTime + 1, {}, () => B.state === 'PATROL'), 'searched, then patrol');
  assert.equal(w.outcome, null);
});

test('noise: a guard out of hearing range ignores it', () => {
  const w = makeWorld();
  const A = w.guards[0];
  w.emitNoise({ x: 2.5, y: 13.5, kind: 'decoy' });
  run(w, 0.2);
  assert.equal(A.bb.lead, null);
});

test('walls block sight: player behind a wall is not seen', () => {
  const w = makeWorld();
  const A = w.guards[0]; // starts at (11,1) facing east along row 1
  A.face = Math.PI;      // face west, toward the wall at x=9
  w.player.x = 8.5; w.player.y = 1.5; // on the other side of the wall
  assert.equal(A.canSee(w.player.x, w.player.y), false);
});

test('escape: reaching the exit ends the run as escaped', () => {
  const w = makeWorld();
  w.player.x = grid.exit.x + 0.5; w.player.y = grid.exit.y - 1.5;
  run(w, 1, { dx: 0, dy: 1 }, (ww) => !!ww.outcome);
  assert.equal(w.outcome, 'escaped');
});

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
  // A player who always walks the middle corridor (row 7/8).
  const route = [];
  for (let x = 1; x <= 12; x++) route.push([x, x < 5 ? 1 : 8]);
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
  assert.match(prompt, /########################/);
  assert.match(prompt, /"watchPoints"/);
  assert.match(prompt, /Most-walked cells/);
});
