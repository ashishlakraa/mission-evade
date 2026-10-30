// Headless tests for the game flow added in the alpha: the screen state machine
// and the mission rules (security levels and lives), plus a full mission played
// against the real simulation.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, State, newMission, scoreRun, validMission, MISSION_RULES } from '../js/game.js';
import { Grid } from '../js/grid.js';
import { World } from '../js/world.js';
import { findPath } from '../js/astar.js';
import { MAP, GUARD_DEFS, DEFAULT_PARAMS } from '../js/config.js';

const grid = new Grid(MAP);

// ---------------------------------------------------------------- state machine

test('game: starts on the menu and follows menu → play → pause → play → run end → next run', () => {
  const g = new Game();
  assert.equal(g.state, State.MENU);
  assert.ok(g.go(State.PLAYING));
  assert.ok(g.go(State.PAUSED));
  assert.ok(g.go(State.PLAYING));
  assert.ok(g.go(State.RUN_END));
  assert.ok(g.go(State.PLAYING));
});

test('game: illegal moves are refused and leave the state unchanged', () => {
  const g = new Game();
  for (const to of [State.PAUSED, State.RUN_END, State.MISSION_END]) {
    assert.equal(g.go(to), false, `MENU → ${to}`);
    assert.equal(g.state, State.MENU);
  }
  g.go(State.PLAYING);
  assert.equal(g.go(State.MISSION_END), false, 'a mission cannot end mid-run');
  g.go(State.PAUSED);
  assert.equal(g.go(State.RUN_END), false, 'a paused run cannot end');
  assert.equal(g.state, State.PAUSED);
});

test('game: every state can get back to the menu', () => {
  for (const path of [[State.PLAYING], [State.PLAYING, State.PAUSED], [State.PLAYING, State.RUN_END],
    [State.PLAYING, State.RUN_END, State.MISSION_END]]) {
    const g = new Game();
    for (const s of path) assert.ok(g.go(s));
    assert.ok(g.go(State.MENU), `from ${g.state}`);
  }
});

// ---------------------------------------------------------------- mission rules

test('mission: escaping raises the level; clearing the last level wins', () => {
  const m = newMission();
  for (let lvl = 1; lvl < MISSION_RULES.levels; lvl++) {
    assert.equal(scoreRun(m, { outcome: 'escaped', time: 30 }).change, 'level-up');
    assert.equal(m.level, lvl + 1);
  }
  assert.equal(scoreRun(m, { outcome: 'escaped', time: 20 }).change, 'won');
  assert.equal(m.result, 'won');
  assert.equal(m.level, MISSION_RULES.levels);
  assert.equal(m.escapes, MISSION_RULES.levels);
  assert.equal(m.bestTime, 20);
});

test('mission: getting caught costs a life and keeps the level; no lives left loses', () => {
  const m = newMission();
  scoreRun(m, { outcome: 'escaped', time: 30 });
  assert.equal(scoreRun(m, { outcome: 'caught', time: 10, detections: 2 }).change, 'life-lost');
  assert.equal(m.level, 2);
  assert.equal(m.lives, MISSION_RULES.lives - 1);
  scoreRun(m, { outcome: 'caught', time: 10 });
  assert.equal(scoreRun(m, { outcome: 'caught', time: 10 }).change, 'lost');
  assert.equal(m.result, 'lost');
  assert.equal(m.lives, 0);
  assert.equal(m.spotted, 2);
});

test('mission: a finished mission ignores further runs', () => {
  const m = newMission({ lives: 1, levels: 5 });
  scoreRun(m, { outcome: 'caught', time: 5 });
  const before = JSON.stringify(m);
  assert.equal(scoreRun(m, { outcome: 'escaped', time: 5 }).change, 'none');
  assert.equal(JSON.stringify(m), before);
});

test('mission: corrupt saved missions are rejected', () => {
  assert.ok(validMission(newMission()));
  assert.equal(new Game({ ...newMission(), level: 9 }).mission, null);
  assert.equal(new Game({ ...newMission(), lives: -1 }).mission, null);
  assert.equal(new Game({ version: 1 }).mission, null);
  assert.equal(new Game('garbage').mission, null);
  assert.equal(new Game(null).mission, null);
  const g = new Game(newMission());
  assert.ok(g.inProgress);
});

// ---------------------------------------------------------------- full loop against the simulation

// A bot that walks the A* path to the exit, with guards far too slow and blind to stop it.
function playRun(params) {
  const w = new World({ grid, params, guardDefs: GUARD_DEFS });
  const path = findPath(grid, grid.start, grid.exit).path;
  let i = 1;
  for (let t = 0; t < 60 * 60 && !w.outcome; t++) {
    const c = path[Math.min(i, path.length - 1)];
    const dx = c.x + 0.5 - w.player.x, dy = c.y + 0.5 - w.player.y;
    if (Math.hypot(dx, dy) < 0.15) i++;
    w.step(1 / 60, { dx: Math.abs(dx) > 0.05 ? Math.sign(dx) : 0, dy: Math.abs(dy) > 0.05 ? Math.sign(dy) : 0 });
  }
  return { outcome: w.outcome, time: w.time, detections: w.detections.length };
}

test('loop: a full mission from menu to "mission complete" against the real World', () => {
  const blind = { ...DEFAULT_PARAMS, coneRange: 0.1, hearingRange: 0, patrolSpeed: 0.01 };
  const g = new Game();
  g.startMission();
  let runs = 0;
  while (!g.mission.result && runs < 20) {
    assert.ok(g.go(State.PLAYING));
    const r = playRun(blind);
    assert.equal(r.outcome, 'escaped');
    assert.ok(g.go(State.RUN_END));
    scoreRun(g.mission, r);
    runs++;
  }
  assert.equal(g.mission.result, 'won');
  assert.equal(runs, MISSION_RULES.levels);
  assert.ok(g.go(State.MISSION_END));
  assert.ok(g.go(State.MENU));
  assert.equal(g.inProgress, false);
});
