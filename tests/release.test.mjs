// Headless tests for the feature-complete build: giving up a run costs a life, sound
// events, first-run hints, level easing, and the generated models and textures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Game, State, newMission, scoreRun, settleOpenRun, validMission } from '../js/game.js';
import { Grid } from '../js/grid.js';
import { World } from '../js/world.js';
import { cueFor, loudness } from '../js/audio.js';
import { Hints, HINTS } from '../js/hints.js';
import { reinforcementDefs } from '../js/reinforce.js';
import { freshMemory } from '../js/memory.js';
import { MAP, GUARD_DEFS, DEFAULT_PARAMS, PARAM_SPEC, LEVEL_TUNING, PLAYER_SPEED, levelRules } from '../js/config.js';

const grid = new Grid(MAP);
const makeWorld = (o = {}) => new World({ grid, params: DEFAULT_PARAMS, guardDefs: GUARD_DEFS, ...o });
const asset = (p) => readFileSync(new URL(`../assets/${p}`, import.meta.url));

// ---------------------------------------------------------------- giving up a run

test('give up: costs a life, keeps the level, and is not counted as a catch', () => {
  const m = newMission();
  scoreRun(m, { outcome: 'escaped', time: 20 });
  m.runActive = true;
  const r = scoreRun(m, { outcome: 'restarted', time: 5, detections: 1 });
  assert.equal(r.change, 'life-lost');
  assert.deepEqual([m.level, m.lives, m.restarts, m.catches, m.runs, m.spotted, m.runActive], [2, 2, 1, 0, 2, 1, false]);
});

test('give up: the last life ends the mission', () => {
  const m = newMission({ lives: 1, levels: 5 });
  assert.equal(scoreRun(m, { outcome: 'restarted', time: 1 }).change, 'lost');
  assert.equal(m.result, 'lost');
  assert.equal(m.lives, 0);
});

test('give up: the way from a paused run to the mission end uses only legal moves', () => {
  const g = new Game(newMission({ lives: 1, levels: 5 }));
  for (const s of [State.PLAYING, State.PAUSED, State.PLAYING, State.RUN_END, State.MISSION_END]) assert.ok(g.go(s), s);
});

test('reload: a run that was open when the page closed costs a life, once', () => {
  const m = newMission();
  m.runActive = true;
  const saved = JSON.parse(JSON.stringify(m));
  assert.ok(validMission(saved));
  assert.equal(settleOpenRun(saved).change, 'life-lost');
  assert.equal(saved.lives, 2);
  assert.equal(settleOpenRun(saved), null, 'a second load is free');
  assert.equal(saved.lives, 2);
});

test('reload: nothing is charged between runs, after the mission, or without one', () => {
  assert.equal(settleOpenRun(newMission()), null);
  assert.equal(settleOpenRun({ ...newMission(), runActive: true, result: 'won' }), null);
  assert.equal(settleOpenRun(null), null);
});

test('reload: missions saved by the beta (no restarts, no runActive) still load and score', () => {
  const { restarts, runActive, ...beta } = newMission();
  assert.ok(validMission(beta));
  assert.equal(settleOpenRun(beta), null);
  scoreRun(beta, { outcome: 'restarted', time: 1 });
  assert.equal(beta.restarts, 1);
});

test('mission: a save with no lives left and no result is rejected', () => {
  assert.equal(validMission({ ...newMission(), lives: 0 }), false);
});

// ---------------------------------------------------------------- sound events

test('events: a decoy gives a throw and one ring per second', () => {
  const run = (guardDefs) => {
    const w = makeWorld({ guardDefs });
    w.step(1 / 60, { decoy: true });
    for (let i = 0; i < 60 * 8 && !w.outcome; i++) w.step(1 / 60);
    return w.events.map((e) => e.type);
  };
  const quiet = run([]);
  assert.equal(quiet.filter((t) => t === 'throw').length, 1);
  assert.equal(quiet.filter((t) => t === 'ring').length, 6);
  const guarded = run(GUARD_DEFS);
  assert.ok(guarded.includes('exit-locked'), 'a guard went to check, so the exit locked');
  assert.ok(guarded.includes('state'));
});

test('events: being chased down gives spotted, then caught', () => {
  const w = makeWorld();
  const g = w.guards[0];
  w.player.x = g.x + 1.5 * Math.cos(g.face);
  w.player.y = g.y + 1.5 * Math.sin(g.face);
  for (let i = 0; i < 60 * 10 && !w.outcome; i++) w.step(1 / 60);
  const types = w.events.map((e) => e.type);
  assert.ok(types.indexOf('spotted') >= 0 && types.indexOf('spotted') < types.indexOf('caught'));
});

test('events: draining empties the list, and an unheard list stays bounded', () => {
  const w = makeWorld();
  for (let i = 0; i < 1000; i++) w.emit('ring', { x: 1, y: 1 });
  assert.ok(w.events.length <= 256);
  assert.ok(w.drainEvents().length > 0);
  assert.equal(w.events.length, 0);
});

test('events: they never change the simulation (same run with and without draining)', () => {
  const a = makeWorld(), b = makeWorld();
  for (let i = 0; i < 60 * 20; i++) {
    const input = { dx: i % 240 < 120 ? 1 : 0, dy: i % 240 < 120 ? 0 : 1, decoy: i % 400 === 50 };
    a.step(1 / 60, input);
    b.step(1 / 60, input);
    b.drainEvents();
  }
  assert.deepEqual([a.outcome, a.player.x, a.player.y, ...a.guards.map((g) => g.x)], [b.outcome, b.player.x, b.player.y, ...b.guards.map((g) => g.x)]);
});

test('sound: every event that matters has a cue, and loudness falls with distance', () => {
  for (const type of ['throw', 'ring', 'spotted', 'caught', 'escaped', 'exit-locked', 'exit-open']) assert.ok(cueFor({ type }), type);
  assert.equal(cueFor({ type: 'state', from: 'PATROL', to: 'SUSPICIOUS' }), 'suspicion');
  assert.equal(cueFor({ type: 'state', from: 'SUSPICIOUS', to: 'CHASE' }), null);
  assert.equal(cueFor({ type: 'unknown' }), null);
  assert.ok(loudness(0) === 1 && loudness(3) < loudness(1) && loudness(50) === 0);
});

// ---------------------------------------------------------------- hints

test('hints: start with moving, then the goal, and each shows only once', () => {
  const w = makeWorld({ guardDefs: [] });
  const h = new Hints();
  assert.match(h.update(w, 0.1), /Move with W A S D/);
  w.player.x += 2;
  assert.match(h.update(w, 0.1), /exit at the bottom right/);
  for (let i = 0; i < 300; i++) h.update(w, 0.1);
  assert.equal(h.update(w, 0.1), null);
  assert.equal(h.shown.has('decoy'), false, 'no guard came near');
});

test('hints: a locked exit comes first, and touch players get touch words', () => {
  const w = makeWorld({ guardDefs: [] });
  const h = new Hints();
  assert.match(h.update(w, 0.1, true), /arrow pad/);
  w.exitOpen = false;
  assert.match(h.update(w, 0.1, true), /locked/);
  for (const x of HINTS) assert.ok(x.key.length < 90, `${x.id} is one line`);
});

// ---------------------------------------------------------------- level easing

test('easing: only ever makes guards easier, stays in bounds, and chase stays below the player', () => {
  const extremes = [0, 1].map((k) => Object.fromEntries(Object.entries(PARAM_SPEC).map(([p, s]) => [p, k ? s.max : s.min])));
  for (const [lvl, t] of Object.entries(LEVEL_TUNING)) {
    for (const [k, steps] of Object.entries(t.reinforcementEase)) assert.ok(steps * PARAM_SPEC[k].harder < 0, `level ${lvl} ${k} must ease`);
    for (const params of [DEFAULT_PARAMS, ...extremes]) {
      const defs = [...GUARD_DEFS, ...reinforcementDefs(grid, freshMemory(grid), Number(lvl) - 1)];
      const w = makeWorld({ params, guardDefs: defs, reinforcementEase: levelRules(lvl).reinforcementEase });
      for (const g of w.guards) {
        for (const [k, s] of Object.entries(PARAM_SPEC)) assert.ok(g.params[k] >= s.min - 1e-9 && g.params[k] <= s.max + 1e-9, `${g.id} ${k}`);
        assert.ok(g.params.chaseSpeed < PLAYER_SPEED);
        if (!g.reinforcement) assert.deepEqual(g.params, params, 'base guards are not eased');
      }
    }
  }
});

test('easing: levels 1 and 2 are untouched', () => {
  for (const l of [1, 2]) assert.deepEqual(levelRules(l), { bonusDecoys: 0, reinforcementEase: {} });
});

// ---------------------------------------------------------------- assets

function readGlb(p) {
  const b = asset(p);
  assert.equal(b.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.equal(b.readUInt32LE(8), b.length, 'declared length');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString());
}

test('models: both characters have the parts and clips the game animates', () => {
  for (const f of ['player', 'guard']) {
    const j = readGlb(`models/${f}.glb`);
    const names = j.nodes.map((n) => n.name);
    for (const n of ['Hips', 'Torso', 'Head', 'ArmL', 'ArmR', 'LegL', 'LegR']) assert.ok(names.includes(n), `${f} ${n}`);
    assert.deepEqual(j.animations.map((a) => a.name), ['Idle', 'Walk', 'Run']);
    assert.ok(j.materials.some((m) => m.name === 'Visor'));
    for (const a of j.accessors) {
      const v = j.bufferViews[a.bufferView];
      assert.ok(v.byteOffset + v.byteLength <= j.buffers[0].byteLength, 'data inside the buffer');
    }
  }
});

test('models: the exit door has two panels and a lamp', () => {
  const j = readGlb('models/exit-door.glb');
  for (const n of ['PanelL', 'PanelR', 'Lamp']) assert.ok(j.nodes.some((x) => x.name === n), n);
});

test('textures: every PNG is valid, square and complete', () => {
  for (const t of ['floor', 'floor_n', 'wall', 'wall_n', 'door', 'door_n']) {
    const b = asset(`textures/${t}.png`);
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    assert.equal(w, h);
    const idat = b.readUInt32BE(33);
    assert.equal(b.subarray(37, 41).toString(), 'IDAT');
    assert.equal(inflateSync(b.subarray(41, 41 + idat)).length, (w * 3 + 1) * h);
  }
});

test('page: everything the game loads is in the folder (no CDN scripts)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  for (const v of Object.values(map)) assert.ok(v.startsWith('./vendor/'), v);
  for (const f of ['three.module.min.js', 'addons/loaders/GLTFLoader.js', 'addons/utils/BufferGeometryUtils.js']) {
    assert.ok(readFileSync(new URL(`../vendor/three/${f}`, import.meta.url)).length > 1000);
  }
});
