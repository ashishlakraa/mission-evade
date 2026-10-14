// Between-run learning.
//
// After each run the learner reads run memory (routes, detections, decoys,
// a heat map of where the player walks) and proposes:
//   - new values for the guard parameters in PARAM_SPEC
//   - one "watch point" per guard: a cell added to its patrol where it stops and looks
//
// The proposal comes from an LLM when one is configured, otherwise from a local
// heuristic. Either way it passes through validateProposal(), which enforces the
// bounds, the per-run step limit and the fairness rules. The LLM can suggest; it
// cannot break the rules.

import { PARAM_SPEC, GUARD_DEFS, WATCH_RULES, PLAYER_SPEED } from './config.js';
import { findPath } from './astar.js';
import { callLLM, extractJson, isConfigured, PROVIDERS } from './llm.js';

const GUARD_IDS = ['A', 'B'];

// ---------- prompt ----------

export function buildPrompt(mem, run, grid) {
  const system = [
    'You are the learning module for the two guards in "Mission Evade", a top-down stealth game.',
    'Between runs you adjust guard behaviour so a player who repeats one route gets caught more often,',
    'while the game stays fair and beatable. You only output a JSON object, nothing else.',
  ].join(' ');

  const cols = Array.from({ length: grid.w }, (_, x) => x % 10).join('');
  const tens = Array.from({ length: grid.w }, (_, x) => (x % 10 === 0 ? String(x / 10) : ' ')).join('');
  const mapLines = grid.rows.map((r, y) => `${String(y).padStart(2)} ${r}`);

  const paramLines = Object.entries(PARAM_SPEC).map(([k, s]) =>
    `- ${k} = ${fmt(mem.params[k])}  (allowed ${s.min}–${s.max}, change at most ±${s.step} per run) — ${s.desc}`);

  const guardLines = GUARD_DEFS.map((g) => {
    const wp = mem.watchPoints[g.id];
    return `- Guard ${g.id}: patrol loop ${g.route.map(([x, y]) => `(${x},${y})`).join(' → ')}; current watch point ${wp ? `(${wp.x},${wp.y})` : 'none'}`;
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

GUARDS
${guardLines.join('\n')}

CURRENT PARAMETERS
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
- A watch point must be a floor cell, at least ${WATCH_RULES.minFromStart} cells from the start S, at least ${WATCH_RULES.minFromExit} cells from the exit E, and the two guards' points at least ${WATCH_RULES.minApart} apart. Use null for no watch point.
- Prefer putting watch points on the player's habitual route over raising every parameter.
- If the player was caught quickly, ease off; if the player escaped easily, tighten. Aim for roughly half of runs escaping.
- Decoys: if the player beat the guards with decoys, a shorter searchTime makes guards less easy to distract.

Reply with ONLY this JSON:
{"params": {${Object.keys(PARAM_SPEC).map((k) => `"${k}": number`).join(', ')}},
 "watchPoints": {"A": [x, y] or null, "B": [x, y] or null},
 "rationale": "one or two plain sentences on what you changed and why"}`;

  return { system, prompt };
}

// ---------- local learner (no LLM) ----------

export function localProposal(mem, run, grid) {
  const p = { ...mem.params };
  const notes = [];
  const escaped = run.outcome === 'escaped';
  if (escaped) {
    p.noticeTime -= 0.1; p.coneRange += 0.5; p.patrolSpeed += 0.1;
    notes.push('the player escaped, so guards spot a little faster and see a little further');
    if (run.decoys.length) { p.searchTime -= 0.5; notes.push('decoys worked, so searches are shorter'); }
  } else if (run.time < 15) {
    p.noticeTime += 0.1; p.coneRange -= 0.5;
    notes.push('the player was caught quickly, so guards ease off');
  } else {
    p.giveUpTime += 0.25;
    notes.push('the player was caught late, so only chase persistence goes up slightly');
  }

  // Watch points: the two hottest valid cells, far enough apart, matched to the nearest guard.
  const candidates = hotCells(mem.heat, grid, 60).filter((c) => watchProblem(grid, c, null) === null);
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
  const rationale = notes.length ? cap(notes.join('; ')) + '.' : 'No change needed.';
  return { params: p, watchPoints: watch, rationale };
}

// ---------- the step that runs after every run ----------

export async function proposeAdaptation(mem, run, grid, settings) {
  if (!isConfigured(settings)) {
    const why = settings.provider === 'local' ? null : 'LLM not set up (missing key or endpoint)';
    return { raw: localProposal(mem, run, grid), source: 'local', error: why };
  }
  const { system, prompt } = buildPrompt(mem, run, grid);
  try {
    const { text, ms, model } = await callLLM(settings, system, prompt);
    const raw = extractJson(text);
    return { raw, source: settings.provider, model, ms, prompt };
  } catch (e) {
    return {
      raw: localProposal(mem, run, grid), source: 'local',
      error: `${PROVIDERS[settings.provider].label} failed: ${e.message}. Used the local learner instead.`,
      prompt,
    };
  }
}

// Validate a proposal and write it into memory. Returns a record of what changed.
export function applyAdaptation(mem, proposal, grid, run) {
  const { params, watchPoints, rejected } = validateProposal(mem, proposal.raw, grid);
  const changes = [];
  for (const k of Object.keys(PARAM_SPEC)) {
    if (params[k] !== mem.params[k]) changes.push({ key: k, from: mem.params[k], to: params[k] });
  }
  const watchChanges = [];
  for (const id of GUARD_IDS) {
    const a = mem.watchPoints[id], b = watchPoints[id];
    if ((a?.x ?? null) !== (b?.x ?? null) || (a?.y ?? null) !== (b?.y ?? null)) watchChanges.push({ id, from: a, to: b });
  }
  mem.params = params;
  mem.watchPoints = watchPoints;
  const record = {
    afterRun: run.n,
    ts: Date.now(),
    source: proposal.source,
    model: proposal.model || null,
    ms: proposal.ms || null,
    error: proposal.error || null,
    rationale: String(proposal.raw?.rationale || '').slice(0, 400),
    changes, watchChanges, rejected,
  };
  mem.adaptations.push(record);
  if (mem.adaptations.length > 40) mem.adaptations.splice(0, mem.adaptations.length - 40);
  return record;
}

export function validateProposal(mem, raw, grid) {
  const rejected = [];
  const params = { ...mem.params };
  const inParams = raw && typeof raw.params === 'object' ? raw.params : {};
  for (const [k, s] of Object.entries(PARAM_SPEC)) {
    if (!(k in inParams)) continue;
    const v = Number(inParams[k]);
    if (!Number.isFinite(v)) { rejected.push(`${k}: "${inParams[k]}" is not a number`); continue; }
    const cur = mem.params[k];
    let next = Math.min(cur + s.step, Math.max(cur - s.step, v));
    if (next !== v) rejected.push(`${k}: ${fmt(v)} is more than ±${s.step} from ${fmt(cur)}, limited to ${fmt(next)}`);
    const bounded = Math.min(s.max, Math.max(s.min, next));
    if (bounded !== next) rejected.push(`${k}: ${fmt(next)} is outside ${s.min}–${s.max}, set to ${fmt(bounded)}`);
    params[k] = round2(bounded);
  }

  const watchPoints = { ...mem.watchPoints };
  const inWatch = raw && typeof raw.watchPoints === 'object' && raw.watchPoints ? raw.watchPoints : null;
  if (inWatch) {
    for (const id of GUARD_IDS) {
      if (!(id in inWatch)) continue;
      const w = inWatch[id];
      if (w === null) { watchPoints[id] = null; continue; }
      const cell = Array.isArray(w) ? { x: Number(w[0]), y: Number(w[1]) }
        : (w && typeof w === 'object' ? { x: Number(w.x), y: Number(w.y) } : null);
      if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)) {
        rejected.push(`watch point for ${id}: ${JSON.stringify(w)} is not a cell`);
        continue;
      }
      const other = id === 'A' ? watchPoints.B : watchPoints.A;
      const problem = watchProblem(grid, cell, other, id);
      if (problem) { rejected.push(`watch point for ${id} at (${cell.x},${cell.y}): ${problem}`); continue; }
      watchPoints[id] = { x: cell.x, y: cell.y };
    }
    // Re-check the pair after both are set.
    if (watchPoints.A && watchPoints.B
        && Math.hypot(watchPoints.A.x - watchPoints.B.x, watchPoints.A.y - watchPoints.B.y) < WATCH_RULES.minApart) {
      rejected.push(`watch point for B at (${watchPoints.B.x},${watchPoints.B.y}): too close to A's`);
      watchPoints.B = mem.watchPoints.B;
    }
  }
  return { params, watchPoints, rejected };
}

// Returns a reason string if a cell is not allowed as a watch point, else null.
export function watchProblem(grid, c, other, guardId) {
  if (!grid.isWalkable(c.x, c.y)) return 'not a floor cell';
  if (Math.hypot(c.x - grid.start.x, c.y - grid.start.y) < WATCH_RULES.minFromStart) return 'too close to the player start';
  if (Math.hypot(c.x - grid.exit.x, c.y - grid.exit.y) < WATCH_RULES.minFromExit) return 'too close to the exit';
  if (other && Math.hypot(c.x - other.x, c.y - other.y) < WATCH_RULES.minApart) return "too close to the other guard's watch point";
  if (guardId) {
    const def = GUARD_DEFS.find((g) => g.id === guardId);
    const [sx, sy] = def.route[0];
    if (!findPath(grid, { x: sx, y: sy }, c).found) return 'unreachable from the patrol';
  }
  return null;
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
