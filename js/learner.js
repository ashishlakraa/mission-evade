// Between-run learning.
//
// After each run the learner reads run memory (routes, detections, decoys,
// a heat map of where the player walks) and proposes:
//   - new team values for the guard parameters in PARAM_SPEC (every guard uses them)
//   - personal values for any guard that spotted or caught the player, base guard or
//     reinforcement (stored as small offsets from the team values)
//   - one "watch point" per guard on duty: a cell added to its patrol where it stops and looks
//
// The proposal comes from an LLM when one is configured, otherwise from a local
// heuristic. Either way it passes through validateProposal(), which enforces the
// bounds, the per-run step limit and the fairness rules. The LLM can suggest; it
// cannot break the rules.
//
// Fairness rules, always on:
//   - every value stays inside PARAM_SPEC; chase speed stays below the player's speed
//   - every value moves by at most one step per run
//   - a guard's personal value stays within GUARD_TUNING.maxOffsetSteps steps of the team's,
//     and only a guard that spotted or caught the player may change its own; the others
//     drift back towards the team
//   - after a quick catch or a catch streak (FAIRNESS), nothing may get harder
//   - watch points keep clear of the start and exit; a reinforcement's stays near its post,
//     out of the exit approach and out of sight of the start (same rules as its post)

import { PARAM_SPEC, GUARD_DEFS, WATCH_RULES, PLAYER_SPEED, GUARD_TUNING, FAIRNESS, paramsFor } from './config.js';
import { findPath } from './astar.js';
import { postProblem } from './reinforce.js';
import { callLLM, extractJson, isConfigured, PROVIDERS } from './llm.js';

// Options set by the admin (see gameconfig.js).
const DEFAULT_TUNING = { perGuard: true, maxOffsetSteps: GUARD_TUNING.maxOffsetSteps };

// The guards on duty in a run. Runs saved by the alpha only had the two base guards.
export function guardsOf(run) {
  if (run?.guards?.length) return run.guards;
  return GUARD_DEFS.map((g) => ({ id: g.id, reinforcement: false, reason: null, route: g.route }));
}

// Guards that spotted or caught the player in this run.
export function involvedIds(run, guards = guardsOf(run)) {
  const on = new Set(guards.map((g) => g.id));
  const ids = new Set((run?.detections || []).map((d) => d.guard));
  if (run?.outcome === 'caught' && run.caughtBy) ids.add(run.caughtBy);
  return new Set([...ids].filter((id) => on.has(id)));
}

// Why nothing may get harder for the next run, or null.
export function fairnessLock(mem, run) {
  if (!run) return null;
  if (run.outcome === 'caught' && run.time < FAIRNESS.quickCatch) return `the player was caught after only ${run.time}s`;
  const runs = mem.runs.at(-1)?.n === run.n ? mem.runs : [...mem.runs, run];
  let streak = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i].outcome === 'caught'; i--) streak++;
  return streak >= FAIRNESS.catchStreak ? `the player was caught ${streak} runs in a row` : null;
}

const POSTED_BECAUSE = {
  caught: ' where the player was caught before', spotted: ' where the player was spotted before',
  route: " on the player's usual route", 'shortest route': ' on the shortest route to the exit',
};

// Does moving parameter k from a to b make guards harder to beat?
export const isHarder = (k, a, b) => PARAM_SPEC[k].harder * (b - a) > 1e-9;

// ---------- prompt ----------

export function buildPrompt(mem, run, grid, opts = {}) {
  const tuning = { ...DEFAULT_TUNING, ...opts };
  const guards = guardsOf(run);
  const involved = involvedIds(run, guards);
  const tunable = tuning.perGuard && tuning.maxOffsetSteps > 0 ? guards.filter((g) => involved.has(g.id)).map((g) => g.id) : [];
  const lock = fairnessLock(mem, run);
  const system = [
    'You are the learning module for the guards in "Mission Evade", a top-down stealth game.',
    'Between runs you adjust guard behaviour so a player who repeats one route gets caught more often,',
    'while the game stays fair and beatable. You only output a JSON object, nothing else.',
  ].join(' ');

  const cols = Array.from({ length: grid.w }, (_, x) => x % 10).join('');
  const tens = Array.from({ length: grid.w }, (_, x) => (x % 10 === 0 ? String(x / 10) : ' ')).join('');
  const mapLines = grid.rows.map((r, y) => `${String(y).padStart(2)} ${r}`);

  const paramLines = Object.entries(PARAM_SPEC).map(([k, s]) =>
    `- ${k} = ${fmt(mem.params[k])}  (allowed ${s.min}–${s.max}, change at most ±${s.step} per run) — ${s.desc}`);

  const guardLines = guards.map((g) => {
    const wp = mem.watchPoints[g.id];
    const kind = g.reinforcement ? `reinforcement, posted at (${g.route[0][0]},${g.route[0][1]})${POSTED_BECAUSE[g.reason] || ''}` : 'base guard';
    const own = Object.entries(mem.guardTuning?.[g.id] || {}).map(([k, o]) => `${k} ${fmt(mem.params[k] + o)}`);
    const did = [];
    const spots = run.detections.filter((d) => d.guard === g.id).length;
    if (spots) did.push(`spotted the player ${spots === 1 ? 'once' : `${spots} times`}`);
    if (run.outcome === 'caught' && run.caughtBy === g.id) did.push('caught the player');
    return `- Guard ${g.id} (${kind}): ${g.route.length > 1 ? 'patrol' : 'stands at'} ${g.route.map(([x, y]) => `(${x},${y})`).join(' → ')}; `
      + `watch point ${wp ? `(${wp.x},${wp.y})` : 'none'}; own values ${own.length ? own.join(', ') : 'same as team'}; `
      + `last run: ${did.length ? did.join(' and ') : 'did not spot the player'}`;
  });

  const routeCells = downsample(run.route, 36).map(([x, y]) => `(${x},${y})`).join(' ');
  const det = run.detections.length
    ? run.detections.map((d) => `Guard ${d.guard} at (${d.x},${d.y}) after ${d.t}s`).join('; ')
    : 'never spotted';
  const decoys = run.decoys.length ? run.decoys.map((d) => `(${d.x},${d.y}) at ${d.t}s`).join('; ') : 'none';

  const hot = hotCells(mem.heat, grid, 14).map((c) => `(${c.x},${c.y}):${c.h.toFixed(1)}`).join(' ');
  const history = mem.runs.slice(-8).map((r) =>
    `#${r.n} ${r.outcome === 'escaped' ? 'escaped' : `caught by ${r.caughtBy}`} in ${r.time}s`).join(', ');

  const prompt = `MAP (${grid.w}×${grid.h}; x = column, y = row; # wall, . floor, S player start, E exit)
   ${tens}
   ${cols}
${mapLines.join('\n')}

GUARDS ON DUTY
${guardLines.join('\n')}

CURRENT TEAM PARAMETERS (every guard uses these unless it has its own values)
${paramLines.join('\n')}
Player speed is ${PLAYER_SPEED} cells/s; chaseSpeed must stay below it.

LAST RUN (#${run.n}): ${run.outcome === 'escaped' ? `player escaped in ${run.time}s` : `player caught by Guard ${run.caughtBy} after ${run.time}s`}
Player route (in order, sampled): ${routeCells}
Spotted: ${det}
Decoys thrown: ${decoys}

MEMORY
Most-walked cells across recent runs (cell:weight, recent runs weigh more): ${hot || 'none yet'}
Recent results: ${history || 'this was the first run'}

RULES
- A watch point must be a floor cell, at least ${WATCH_RULES.minFromStart} cells from the start S, at least ${WATCH_RULES.minFromExit} cells from the exit E, and at least ${WATCH_RULES.minApart} cells from every other guard's watch point. Use null for no watch point. You may set one for any guard on duty (${guards.map((g) => g.id).join(', ')}).
- A reinforcement's watch point must be at most ${WATCH_RULES.reinforcementReach} steps from its post, outside the area around the exit and out of sight of the start.
- ${tunable.length ? `Personal values: only ${tunable.join(', ')} spotted or caught the player, so only ${tunable.length > 1 ? 'they' : 'it'} may get their own values in "guards". A personal value may differ from the team value by at most ${tuning.maxOffsetSteps} steps. Use them to sharpen or ease exactly the guard that mattered.` : 'Personal values: no guard may get its own values this time, so leave "guards" empty.'}
- Prefer putting watch points on the player's habitual route over raising every parameter.
- If the player was caught quickly, ease off; if the player escaped easily, tighten. Aim for roughly half of runs escaping.
- Decoys: if the player beat the guards with decoys, a shorter searchTime makes guards less easy to distract.${lock ? `
- FAIRNESS LOCK: ${lock}. Do not make any guard harder this time (no higher vision, speed, give-up time or hearing, no lower time to spot). Easing off or holding is allowed.` : ''}

Reply with ONLY this JSON:
{"params": {${Object.keys(PARAM_SPEC).map((k) => `"${k}": number`).join(', ')}},
 "guards": {${tunable.length ? tunable.map((id) => `"${id}": {"params": {"<parameter>": number}}`).join(', ') : ''}},
 "watchPoints": {${guards.map((g) => `"${g.id}": [x, y] or null`).join(', ')}},
 "rationale": "one or two plain sentences on what you changed and why"}`;

  return { system, prompt };
}

// ---------- local learner (no LLM) ----------

export function localProposal(mem, run, grid, opts = {}) {
  const tuning = { ...DEFAULT_TUNING, ...opts };
  const p = { ...mem.params };
  const notes = [];
  const escaped = run.outcome === 'escaped';
  if (escaped) {
    p.noticeTime -= 0.1; p.coneRange += 0.5; p.patrolSpeed += 0.1;
    notes.push('the player escaped, so guards spot a little faster and see a little further');
    if (run.decoys.length) { p.searchTime -= 0.5; notes.push('decoys worked, so searches are shorter'); }
  } else if (run.time < FAIRNESS.quickCatch) {
    p.noticeTime += 0.1; p.coneRange -= 0.5;
    notes.push('the player was caught quickly, so guards ease off');
  } else {
    p.giveUpTime += 0.25;
    notes.push('the player was caught late, so only chase persistence goes up slightly');
  }

  // Personal values for the guards that mattered: one that spotted the player but lost
  // them chases longer; one that caught the player quickly gets a little slower to spot.
  const guards = guardsOf(run);
  const involved = involvedIds(run, guards);
  const own = {};
  if (tuning.perGuard && tuning.maxOffsetSteps > 0) {
    for (const id of involved) {
      const eff = paramsFor(mem.params, mem.guardTuning?.[id]);
      if (escaped) {
        own[id] = { params: { giveUpTime: eff.giveUpTime + PARAM_SPEC.giveUpTime.step } };
        notes.push(`Guard ${id} spotted the player but lost them, so it now chases longer`);
      } else if (run.caughtBy === id && run.time < FAIRNESS.quickCatch) {
        own[id] = { params: { noticeTime: eff.noticeTime + PARAM_SPEC.noticeTime.step } };
        notes.push(`Guard ${id} caught the player quickly, so it is now a little slower to spot`);
      }
    }
  }

  // Watch points: the two hottest valid cells for the base guards, far enough apart,
  // matched to the nearest guard; then, for each reinforcement, the hottest fair cell near its post.
  const hot = hotCells(mem.heat, grid, 60);
  const candidates = hot.filter((c) => watchProblem(grid, c) === null);
  const picks = [];
  for (const c of candidates) {
    if (picks.every((q) => Math.hypot(q.x - c.x, q.y - c.y) >= WATCH_RULES.minApart + 2)) picks.push(c);
    if (picks.length === 2) break;
  }
  const watch = { A: null, B: null };
  if (picks.length) {
    const centre = Object.fromEntries(GUARD_DEFS.map((g) => [g.id, centroid(g.route)]));
    const d = (id, c) => Math.hypot(centre[id].x - c.x, centre[id].y - c.y);
    if (picks.length === 1) {
      const id = d('A', picks[0]) <= d('B', picks[0]) ? 'A' : 'B';
      watch[id] = [picks[0].x, picks[0].y];
    } else {
      const straight = d('A', picks[0]) + d('B', picks[1]);
      const crossed = d('A', picks[1]) + d('B', picks[0]);
      const [a, b] = straight <= crossed ? [picks[0], picks[1]] : [picks[1], picks[0]];
      watch.A = [a.x, a.y]; watch.B = [b.x, b.y];
    }
    notes.push('guards now stop to watch the cells the player walks most');
  }
  const taken = Object.values(watch).filter(Boolean).map(([x, y]) => ({ x, y }));
  let posted = 0;
  for (const g of guards.filter((q) => q.reinforcement)) {
    const c = hot.find((h) => watchProblem(grid, h, taken, g) === null);
    if (!c) continue;
    watch[g.id] = [c.x, c.y];
    taken.push(c);
    posted++;
  }
  if (posted) notes.push(`${posted === 1 ? 'the reinforcement watches' : 'reinforcements watch'} the most-walked cell near ${posted === 1 ? 'its post' : 'their posts'}`);
  const rationale = notes.length ? cap(notes.join('; ')) + '.' : 'No change needed.';
  return { params: p, guards: own, watchPoints: watch, rationale };
}

// ---------- the step that runs after every run ----------

export async function proposeAdaptation(mem, run, grid, settings, opts = {}) {
  if (!isConfigured(settings)) {
    const why = settings.provider === 'local' ? null : 'LLM not set up (missing access token)';
    return { raw: localProposal(mem, run, grid, opts), source: 'local', error: why };
  }
  const { system, prompt } = buildPrompt(mem, run, grid, opts);
  try {
    const { text, ms, model } = await callLLM(settings, system, prompt);
    const raw = extractJson(text);
    return { raw, source: settings.provider, model, ms, prompt };
  } catch (e) {
    return {
      raw: localProposal(mem, run, grid, opts), source: 'local',
      error: `${PROVIDERS[settings.provider].label} failed: ${e.message}. Used the local learner instead.`,
      prompt,
    };
  }
}

// Validate a proposal and write it into memory. Returns a record of what changed.
export function applyAdaptation(mem, proposal, grid, run, opts = {}) {
  const { params, guardTuning, watchPoints, rejected, lock, involved } = validateProposal(mem, proposal.raw, grid, run, opts);
  const changes = [];
  for (const k of Object.keys(PARAM_SPEC)) {
    if (params[k] !== mem.params[k]) changes.push({ key: k, from: mem.params[k], to: params[k] });
  }
  // A guard's own value changed (team changes are listed above).
  const oldTuning = mem.guardTuning || {};
  const guardChanges = [];
  for (const id of new Set([...Object.keys(oldTuning), ...Object.keys(guardTuning)])) {
    const before = paramsFor(mem.params, oldTuning[id]), after = paramsFor(params, guardTuning[id]);
    for (const k of Object.keys(PARAM_SPEC)) {
      if ((oldTuning[id]?.[k] || 0) === (guardTuning[id]?.[k] || 0) || before[k] === after[k]) continue;
      guardChanges.push({ id, key: k, from: before[k], to: after[k], team: params[k] });
    }
  }
  const watchChanges = [];
  for (const id of new Set([...Object.keys(mem.watchPoints), ...Object.keys(watchPoints)])) {
    const a = mem.watchPoints[id], b = watchPoints[id];
    if ((a?.x ?? null) !== (b?.x ?? null) || (a?.y ?? null) !== (b?.y ?? null)) watchChanges.push({ id, from: a || null, to: b || null });
  }
  mem.params = params;
  mem.guardTuning = guardTuning;
  mem.watchPoints = watchPoints;
  const record = {
    afterRun: run.n,
    ts: Date.now(),
    source: proposal.source,
    model: proposal.model || null,
    ms: proposal.ms || null,
    error: proposal.error || null,
    rationale: String(proposal.raw?.rationale || '').slice(0, 400),
    changes, guardChanges, watchChanges, rejected,
    fairness: lock, involved: [...involved],
  };
  mem.adaptations.push(record);
  if (mem.adaptations.length > 40) mem.adaptations.splice(0, mem.adaptations.length - 40);
  return record;
}

export function validateProposal(mem, raw, grid, run = null, opts = {}) {
  const tuning = { ...DEFAULT_TUNING, ...opts };
  const guards = guardsOf(run);
  const involved = involvedIds(run, guards);
  const lock = fairnessLock(mem, run);
  const rejected = [];
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

  // Team values: bounds, one step per run, and the fairness lock.
  const params = { ...mem.params };
  const inParams = obj(raw?.params) || {};
  for (const [k, s] of Object.entries(PARAM_SPEC)) {
    if (!(k in inParams)) continue;
    const v = Number(inParams[k]);
    if (!Number.isFinite(v)) { rejected.push(`${k}: "${inParams[k]}" is not a number`); continue; }
    const cur = mem.params[k];
    let next = Math.min(cur + s.step, Math.max(cur - s.step, v));
    if (next !== v) rejected.push(`${k}: ${fmt(v)} is more than ±${s.step} from ${fmt(cur)}, limited to ${fmt(next)}`);
    const bounded = Math.min(s.max, Math.max(s.min, next));
    if (bounded !== next) rejected.push(`${k}: ${fmt(next)} is outside ${s.min}–${s.max}, set to ${fmt(bounded)}`);
    if (lock && isHarder(k, cur, bounded)) { rejected.push(`${k}: kept at ${fmt(cur)}, fairness lock (${lock})`); continue; }
    params[k] = round2(bounded);
  }

  // Personal values, stored as offsets from the team values.
  const oldTuning = mem.guardTuning || {};
  const inGuards = obj(raw?.guards) || {};
  const guardTuning = {};
  for (const [id, t] of Object.entries(oldTuning)) {
    if (!guards.some((g) => g.id === id)) guardTuning[id] = { ...t };   // not on duty this run: unchanged
  }
  for (const id of Object.keys(inGuards)) {
    if (!guards.some((g) => g.id === id)) rejected.push(`Guard ${id}: not on duty this run`);
  }
  for (const g of guards) {
    const prev = oldTuning[g.id] || {};
    const before = paramsFor(mem.params, prev);
    const asked = obj(obj(inGuards[g.id])?.params);
    const may = tuning.perGuard && involved.has(g.id);
    if (asked && !may) {
      rejected.push(tuning.perGuard
        ? `Guard ${g.id}: did not spot or catch the player, so it keeps the team values`
        : `Guard ${g.id}: per-guard tuning is turned off`);
    }
    const out = {};
    for (const [k, s] of Object.entries(PARAM_SPEC)) {
      const capOff = tuning.perGuard ? tuning.maxOffsetSteps * s.step : 0;
      let o = prev[k] || 0;
      if (!involved.has(g.id)) o = Math.abs(o * GUARD_TUNING.decay) < s.step / 4 ? 0 : o * GUARD_TUNING.decay;
      if (may && asked && k in asked) {
        const v = Number(asked[k]);
        if (!Number.isFinite(v)) rejected.push(`Guard ${g.id} ${k}: "${asked[k]}" is not a number`);
        else {
          let next = Math.min(before[k] + s.step, Math.max(before[k] - s.step, v));
          if (next !== v) rejected.push(`Guard ${g.id} ${k}: ${fmt(v)} is more than ±${s.step} from ${fmt(before[k])}, limited to ${fmt(next)}`);
          next = Math.min(s.max, Math.max(s.min, next));
          const near = Math.min(params[k] + capOff, Math.max(params[k] - capOff, next));
          if (Math.abs(near - next) > 1e-9) rejected.push(`Guard ${g.id} ${k}: ${fmt(next)} is too far from the team value ${fmt(params[k])}, limited to ${fmt(near)}`);
          o = near - params[k];
        }
      }
      o = Math.min(capOff, Math.max(-capOff, o));
      if (lock && isHarder(k, before[k], paramsFor(params, { [k]: o })[k])) {
        if (may && asked && k in asked) rejected.push(`Guard ${g.id} ${k}: kept at ${fmt(before[k])}, fairness lock (${lock})`);
        o = Math.min(capOff, Math.max(-capOff, before[k] - params[k]));
      }
      o = round2(o);
      if (Math.abs(o) > 1e-9) out[k] = o;
    }
    if (Object.keys(out).length) guardTuning[g.id] = out;
  }

  // Watch points, for any guard on duty. Personal watch points may also come inside "guards".
  const watchPoints = { ...mem.watchPoints };
  const inWatch = { ...(obj(raw?.watchPoints) || {}) };
  for (const [id, t] of Object.entries(inGuards)) if (obj(t) && 'watchPoint' in t && !(id in inWatch)) inWatch[id] = t.watchPoint;
  for (const id of Object.keys(inWatch)) {
    if (!guards.some((g) => g.id === id)) rejected.push(`watch point for ${id}: Guard ${id} is not on duty this run`);
  }
  for (const g of guards) {
    if (!(g.id in inWatch)) continue;
    const w = inWatch[g.id];
    if (w === null) { watchPoints[g.id] = null; continue; }
    const cell = Array.isArray(w) ? { x: Number(w[0]), y: Number(w[1]) }
      : (w && typeof w === 'object' ? { x: Number(w.x), y: Number(w.y) } : null);
    if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) {
      rejected.push(`watch point for ${g.id}: ${JSON.stringify(w)} is not a cell`);
      continue;
    }
    const others = Object.entries(watchPoints).filter(([id, p]) => id !== g.id && p).map(([, p]) => p);
    const problem = watchProblem(grid, cell, others, g);
    if (problem) { rejected.push(`watch point for ${g.id} at (${cell.x},${cell.y}): ${problem}`); continue; }
    watchPoints[g.id] = { x: cell.x, y: cell.y };
  }
  return { params, guardTuning, watchPoints, rejected, lock, involved };
}

// Returns a reason string if a cell is not allowed as a watch point, else null.
// others: the other guards' watch points. def: the guard ({route, reinforcement}), to check
// it can walk there; a reinforcement must also stay near its post and keep to fair ground.
export function watchProblem(grid, c, others = [], def = null) {
  if (!grid.isWalkable(c.x, c.y)) return 'not a floor cell';
  if (Math.hypot(c.x - grid.start.x, c.y - grid.start.y) < WATCH_RULES.minFromStart) return 'too close to the player start';
  if (Math.hypot(c.x - grid.exit.x, c.y - grid.exit.y) < WATCH_RULES.minFromExit) return 'too close to the exit';
  if ((others || []).some((o) => o && Math.hypot(c.x - o.x, c.y - o.y) < WATCH_RULES.minApart)) return "too close to another guard's watch point";
  if (def) {
    if (def.route.some(([x, y]) => x === c.x && y === c.y)) return 'already on its patrol';
    const [sx, sy] = def.route[0];
    const res = findPath(grid, { x: sx, y: sy }, c);
    if (!res.found) return 'unreachable from the patrol';
    if (def.reinforcement) {
      if (res.path.length - 1 > WATCH_RULES.reinforcementReach) return `more than ${WATCH_RULES.reinforcementReach} steps from its post`;
      const here = postProblem(grid, c);
      if (here) return here;
      // The guard walks there from every point of its beat; all of that ground must be fair too.
      for (const [x, y] of def.route) {
        for (const q of findPath(grid, { x, y }, c).path || []) {
          const why = postProblem(grid, q);
          if (why) return `the walk there passes (${q.x},${q.y}): ${why}`;
        }
      }
    }
  }
  return null;
}

// The learned watch points that are still fair for this run's guards. A reinforcement's
// post can move between runs (it follows run memory), so its point is checked again.
export function watchPointsFor(grid, defs, watchPoints) {
  const out = {};
  for (const d of defs) {
    const wp = watchPoints?.[d.id];
    if (wp && !watchProblem(grid, wp, [], d)) out[d.id] = wp;
  }
  return out;
}

// ---------- helpers ----------

export function hotCells(heat, grid, n) {
  const out = [];
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
    const h = heat[grid.idx(x, y)];
    if (h > 0.05) out.push({ x, y, h });
  }
  out.sort((a, b) => b.h - a.h);
  return out.slice(0, n);
}

function downsample(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return out;
}

function centroid(route) {
  const s = route.reduce((a, [x, y]) => ({ x: a.x + x, y: a.y + y }), { x: 0, y: 0 });
  return { x: s.x / route.length, y: s.y / route.length };
}

const round2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => String(round2(v));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
