// Per-guard tuning, the fairness rules, and the admin config.
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../js/grid.js';
import { World } from '../js/world.js';
import {
  MAP, GUARD_DEFS, PARAM_SPEC, PLAYER_SPEED, GUARD_TUNING, WATCH_RULES, paramsFor,
} from '../js/config.js';
import { reinforcementDefs, exitZone } from '../js/reinforce.js';
import { freshMemory, recordRun, buildRunRecord } from '../js/memory.js';
import {
  validateProposal, applyAdaptation, localProposal, buildPrompt, fairnessLock, watchProblem, watchPointsFor, isHarder,
} from '../js/learner.js';
import { sanitizeConfig, mergeConfig, CONFIG_LIMITS } from '../js/gameconfig.js';

const grid = new Grid(MAP);
const reinf = reinforcementDefs(grid, freshMemory(grid), 4);
const allDefs = [...GUARD_DEFS, ...reinf];
const onDuty = allDefs.map((d) => ({ id: d.id, reinforcement: !!d.reinforcement, reason: d.reason || null, route: d.route }));
const C = onDuty.find((g) => g.id === 'C');

function runOf(n, extra) {
  return { n, time: 30, outcome: 'escaped', caughtBy: null, route: [[1, 1]], detections: [], decoys: [], guards: onDuty, ...extra };
}

test('tuning: a reinforcement that spotted the player gets its own values; others keep the team values', () => {
  const mem = freshMemory(grid);
  const run = runOf(1, { detections: [{ guard: 'C', x: 8, y: 4, t: 5 }] });
  recordRun(mem, grid, run);
  const raw = {
    params: {},
    guards: { C: { params: { noticeTime: 0.5 } }, A: { params: { noticeTime: 0.5 } } },
  };
  const rec = applyAdaptation(mem, { raw, source: 'test' }, grid, run);
  assert.deepEqual(rec.involved, ['C']);
  assert.equal(paramsFor(mem.params, mem.guardTuning.C).noticeTime, 0.5);
  assert.equal(mem.guardTuning.A, undefined, 'A did not spot the player');
  assert.ok(rec.rejected.some((r) => /Guard A: did not spot or catch/.test(r)));
  assert.ok(rec.guardChanges.some((c) => c.id === 'C' && c.key === 'noticeTime'));
  // The world gives C its own values and the other guards the team values.
  const w = new World({ grid, params: mem.params, guardDefs: allDefs, guardTuning: mem.guardTuning });
  assert.equal(w.guards.find((g) => g.id === 'C').params.noticeTime, 0.5);
  assert.equal(w.guards.find((g) => g.id === 'A').params.noticeTime, mem.params.noticeTime);
});

test('tuning: a personal value stays within the allowed difference from the team', () => {
  const mem = freshMemory(grid);
  for (let n = 1; n <= 6; n++) {
    const run = runOf(n, { detections: [{ guard: 'B', x: 8, y: 6, t: 4 }] });
    recordRun(mem, grid, run);
    applyAdaptation(mem, { raw: { guards: { B: { params: { coneRange: 99 } } } } }, grid, run);
  }
  const cap = GUARD_TUNING.maxOffsetSteps * PARAM_SPEC.coneRange.step;
  assert.equal(mem.guardTuning.B.coneRange, cap);
  assert.ok(paramsFor(mem.params, mem.guardTuning.B).coneRange <= PARAM_SPEC.coneRange.max);
});

test('tuning: a guard that is not involved drifts back to the team values', () => {
  const mem = freshMemory(grid);
  mem.guardTuning = { D: { giveUpTime: 1 } };
  const run = runOf(1);
  recordRun(mem, grid, run);
  applyAdaptation(mem, { raw: {} }, grid, run);
  assert.equal(mem.guardTuning.D.giveUpTime, 1 * GUARD_TUNING.decay);
});

test('tuning: the admin can turn per-guard tuning off', () => {
  const mem = freshMemory(grid);
  const run = runOf(1, { detections: [{ guard: 'C', x: 8, y: 4, t: 5 }] });
  recordRun(mem, grid, run);
  const out = validateProposal(mem, { guards: { C: { params: { noticeTime: 0.5 } } } }, grid, run, { perGuard: false });
  assert.deepEqual(out.guardTuning, {});
  assert.ok(out.rejected.some((r) => /turned off/.test(r)));
});

test('fairness lock: after a quick catch nothing may get harder, but easing off is allowed', () => {
  const mem = freshMemory(grid);
  const run = runOf(1, { outcome: 'caught', caughtBy: 'E', time: 6, detections: [{ guard: 'E', x: 9, y: 9, t: 4 }] });
  recordRun(mem, grid, run);
  assert.match(fairnessLock(mem, run), /caught after only 6s/);
  const raw = {
    params: { coneRange: 7, chaseSpeed: 2.7, noticeTime: 0.8 },
    guards: { E: { params: { noticeTime: 0.5, coneAngle: 50 } } },
  };
  const out = validateProposal(mem, raw, grid, run);
  assert.equal(out.params.coneRange, mem.params.coneRange);
  assert.equal(out.params.chaseSpeed, mem.params.chaseSpeed);
  assert.equal(out.params.noticeTime, 0.8, 'easing off still allowed');
  const e = paramsFor(out.params, out.guardTuning.E);
  assert.equal(e.coneAngle, 50, 'E may ease its own vision');
  assert.ok(e.noticeTime >= mem.params.noticeTime, 'E may not get sharper');
});

test('fairness lock: two catches in a row also lock', () => {
  const mem = freshMemory(grid);
  recordRun(mem, grid, runOf(1, { outcome: 'caught', caughtBy: 'A', time: 40 }));
  const run = runOf(2, { outcome: 'caught', caughtBy: 'B', time: 40 });
  recordRun(mem, grid, run);
  assert.match(fairnessLock(mem, run), /2 runs in a row/);
});

test('fairness: random LLM replies never break the rules, for any guard, over many runs', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const mem = freshMemory(grid);
  const keys = Object.keys(PARAM_SPEC);
  const ids = onDuty.map((g) => g.id);
  for (let n = 1; n <= 300; n++) {
    const caught = rnd() < 0.5;
    const spotter = ids[Math.floor(rnd() * ids.length)];
    const run = runOf(n, {
      outcome: caught ? 'caught' : 'escaped', caughtBy: caught ? spotter : null, time: Math.round(rnd() * 60),
      detections: rnd() < 0.7 ? [{ guard: spotter, x: 8, y: 4, t: 3 }] : [],
    });
    recordRun(mem, grid, run);
    const wild = () => Object.fromEntries(keys.filter(() => rnd() < 0.5).map((k) => [k, (rnd() - 0.3) * 20]));
    const raw = {
      params: wild(),
      guards: Object.fromEntries(ids.filter(() => rnd() < 0.4).map((id) => [id, { params: wild() }])),
      watchPoints: Object.fromEntries(ids.filter(() => rnd() < 0.4).map((id) => [id, [Math.floor(rnd() * 16), Math.floor(rnd() * 12)]])),
    };
    const before = Object.fromEntries(ids.map((id) => [id, paramsFor(mem.params, mem.guardTuning[id])]));
    const lock = fairnessLock(mem, run);
    applyAdaptation(mem, { raw }, grid, run);
    for (const id of ids) {
      const p = paramsFor(mem.params, mem.guardTuning[id]);
      for (const [k, s] of Object.entries(PARAM_SPEC)) {
        assert.ok(p[k] >= s.min - 1e-9 && p[k] <= s.max + 1e-9, `${id} ${k}=${p[k]} out of range`);
        const off = mem.guardTuning[id]?.[k] || 0;
        assert.ok(Math.abs(off) <= GUARD_TUNING.maxOffsetSteps * s.step + 1e-9, `${id} ${k} offset ${off}`);
        if (lock) assert.ok(!isHarder(k, before[id][k], p[k]), `run ${n}: ${id} ${k} got harder under the lock (${lock})`);
      }
      assert.ok(p.chaseSpeed < PLAYER_SPEED, 'a spotted player can always outrun the guard');
    }
    const zone = exitZone(grid);
    const wps = Object.entries(mem.watchPoints).filter(([, w]) => w);
    for (const [id, w] of wps) {
      assert.ok(Math.hypot(w.x - grid.start.x, w.y - grid.start.y) >= WATCH_RULES.minFromStart);
      if (onDuty.find((g) => g.id === id)?.reinforcement) assert.ok(!zone.some((z) => z.x === w.x && z.y === w.y), `${id} watches the exit`);
      for (const [id2, w2] of wps) if (id2 !== id) assert.ok(Math.hypot(w.x - w2.x, w.y - w2.y) >= WATCH_RULES.minApart);
    }
  }
});

test('watch points: a reinforcement keeps to fair ground near its post', () => {
  const zone = exitZone(grid);
  assert.match(watchProblem(grid, zone[3], [], C), /exit approach|more than|walk there|see/);
  const far = grid.freeCells().find((c) => Math.abs(c.x - C.route[0][0]) + Math.abs(c.y - C.route[0][1]) > 10
    && Math.hypot(c.x - grid.start.x, c.y - grid.start.y) >= 5 && !zone.some((z) => z.x === c.x && z.y === c.y));
  assert.match(watchProblem(grid, far, [], C), /steps from its post|walk there|see/);
  const [px, py] = C.route[C.route.length - 1];
  assert.equal(watchProblem(grid, { x: px, y: py }, [], C), 'already on its patrol');
  // A point that stops being fair (the post moved) is dropped when the next world is built.
  assert.deepEqual(watchPointsFor(grid, [C], { C: zone[3] }), {});
});

test('reinforcements: a guard never stands frozen; a one-cell post looks around', () => {
  // Fallback posts always get a beat; a sentry (one-cell post from memory) keeps turning.
  for (const d of reinf) if (!['caught', 'spotted', 'route'].includes(d.reason)) assert.equal(d.route.length, 2, `${d.id} has a beat`);
  const w = new World({ grid, params: freshMemory(grid).params, guardDefs: [{ id: 'C', name: 'Guard C', reinforcement: true, route: [[10, 4]] }] });
  w.player.x = -50; w.player.y = -50;
  const faces = new Set();
  for (let f = 0; f < 60 * 8; f++) { w.step(1 / 60, {}); faces.add(Math.round(w.guards[0].face * 2)); }
  assert.ok(faces.size >= 4, 'the sentry turns to look around');
});

test('local learner: tunes the guard that spotted the player and gives reinforcements watch points', () => {
  const mem = freshMemory(grid);
  const run = runOf(1, { detections: [{ guard: 'D', x: 8, y: 4, t: 5 }], route: onDuty.flatMap((g) => g.route) });
  recordRun(mem, grid, run);
  const raw = localProposal(mem, run, grid);
  assert.ok(raw.guards.D, 'D spotted the player and escaped, so D is tuned');
  const rec = applyAdaptation(mem, { raw, source: 'local' }, grid, run);
  assert.ok(rec.guardChanges.some((c) => c.id === 'D' && c.key === 'giveUpTime'));
  assert.ok(Object.keys(mem.watchPoints).some((id) => id >= 'C' && mem.watchPoints[id]), 'a reinforcement got a watch point');
});

test('prompt: lists every guard on duty, who was involved, and the lock', () => {
  const mem = freshMemory(grid);
  const run = runOf(1, { outcome: 'caught', caughtBy: 'F', time: 5 });
  recordRun(mem, grid, run);
  const { prompt } = buildPrompt(mem, run, grid);
  for (const g of onDuty) assert.match(prompt, new RegExp(`Guard ${g.id} \\(`));
  assert.match(prompt, /Guard F \(reinforcement.*caught the player/);
  assert.match(prompt, /only F spotted or caught/);
  assert.match(prompt, /FAIRNESS LOCK/);
  assert.match(prompt, /"F": \[x, y\] or null/);
});

test('run record: includes the reinforcements on duty', () => {
  const w = new World({ grid, params: freshMemory(grid).params, guardDefs: allDefs });
  w.outcome = 'escaped';
  const rec = buildRunRecord(w, freshMemory(grid));
  assert.deepEqual(rec.guards.map((g) => g.id), allDefs.map((d) => d.id));
  assert.ok(rec.guards.find((g) => g.id === 'C').reinforcement);
});

test('admin config: values are clamped and a token is never shared', () => {
  const c = sanitizeConfig({
    lives: 99, levels: 0, decoys: -3, maxOffsetSteps: 9, devView: 'yes',
    startParams: { chaseSpeed: 5, coneRange: 2 },
    learner: { provider: 'huggingface', apiKey: 'secret', model: 'x' },
  });
  assert.equal(c.lives, CONFIG_LIMITS.lives.max);
  assert.equal(c.levels, CONFIG_LIMITS.levels.min);
  assert.equal(c.decoys, 0);
  assert.equal(c.maxOffsetSteps, CONFIG_LIMITS.maxOffsetSteps.max);
  assert.equal(c.devView, true);
  assert.equal(c.startParams.chaseSpeed, PARAM_SPEC.chaseSpeed.max);
  assert.ok(c.startParams.chaseSpeed < PLAYER_SPEED);
  assert.equal(c.startParams.coneRange, PARAM_SPEC.coneRange.min);
  assert.equal(c.learner, undefined, 'the learner and its token are never shared');
  assert.ok(!JSON.stringify(c).includes('secret'));
  assert.equal(mergeConfig({ lives: 5, startParams: { coneRange: 7 } }, { startParams: { noticeTime: 0.5 } }).startParams.coneRange, 7);
});

test('admin config: the World gives the player the configured decoys', () => {
  const w = new World({ grid, params: freshMemory(grid).params, guardDefs: GUARD_DEFS, decoys: 1 });
  assert.equal(w.decoysLeft, 1);
});
