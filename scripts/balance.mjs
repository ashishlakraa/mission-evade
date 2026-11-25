// Difficulty check: a careful bot plays whole missions against the real simulation, with a
// learner adapting the guards after every run, and the escape rate per level is printed.
// It is a bot, not a person: use it to compare settings, not to predict how people will do.
//
//   node scripts/balance.mjs [missions] [--no-easing] [--llm]
//
// --llm uses the LLM learner only (token in the HF_TOKEN environment variable). A failed call is
// retried, never replaced by the local learner; if it keeps failing, that run teaches nothing
// and is counted.

import { Grid } from '../js/grid.js';
import { World } from '../js/world.js';
import { MAP, GUARD_DEFS, DECOYS_PER_RUN, levelRules } from '../js/config.js';
import { reinforcementDefs } from '../js/reinforce.js';
import { freshMemory, buildRunRecord, recordRun } from '../js/memory.js';
import { proposeAdaptation, applyAdaptation, watchPointsFor } from '../js/learner.js';
import { newMission, scoreRun, MISSION_RULES } from '../js/game.js';

const grid = new Grid(MAP);
const STEP = 1 / 60;
const MAX_TIME = 120;

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Cells a guard sees now or will soon see, as a cost per cell.
function danger(w, margin) {
  const cost = new Float32Array(grid.w * grid.h);
  for (const g of w.guards) {
    const spots = [{ x: g.x, y: g.y, face: g.face, k: 1 }];
    // Where it is heading: the next points on its path.
    let px = g.x, py = g.y, left = 2.2;
    for (const q of g.bb.path.slice(0, 4)) {
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < 1e-3) continue;
      const f = Math.atan2(q.y - py, q.x - px);
      const t = Math.min(1, left / d);
      spots.push({ x: px + (q.x - px) * t, y: py + (q.y - py) * t, face: f, k: 0.6 });
      left -= d;
      if (left <= 0) break;
      px = q.x; py = q.y;
    }
    const range = g.params.coneRange + margin, half = (g.params.coneAngle * Math.PI) / 360 + margin * 0.35;
    for (const s of spots) for (const c of grid.freeCells()) {
      const dx = c.x + 0.5 - s.x, dy = c.y + 0.5 - s.y, d = Math.hypot(dx, dy);
      if (d > range || (d > 0.9 && Math.abs(wrap(Math.atan2(dy, dx) - s.face)) > half)) continue;
      if (!grid.lineOfSight(s.x, s.y, c.x + 0.5, c.y + 0.5)) continue;
      const i = grid.idx(c.x, c.y);
      cost[i] = Math.max(cost[i], s.k * (12 + (range - d) * 4));
    }
  }
  return cost;
}

// Cheapest route from a to any cell that passes `goal`, with danger as extra cost.
function route(a, goal, cost) {
  const N = grid.w * grid.h, dist = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  dist[grid.idx(a.x, a.y)] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) return null;
    done[u] = 1;
    const x = u % grid.w, y = (u - x) / grid.w;
    if (goal(x, y, u)) {
      const path = [];
      for (let i = u; i >= 0; i = prev[i]) path.unshift({ x: i % grid.w, y: Math.floor(i / grid.w) });
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!grid.isWalkable(x + dx, y + dy)) continue;
      const v = grid.idx(x + dx, y + dy), c = dist[u] + 1 + cost[v];
      if (c < dist[v]) { dist[v] = c; prev[v] = u; }
    }
  }
}

// One careful player. skill 0..1: how far ahead it keeps clear of cones.
export class Bot {
  constructor(rand, skill = 0.6) { this.rand = rand; this.margin = 0.4 + skill * 0.8; this.wait = rand() * 4; this.t = 0; this.path = null; this.idle = 0; }

  input(w, dt) {
    this.t -= dt;
    this.wait -= dt;
    const p = w.player, at = { x: Math.floor(p.x), y: Math.floor(p.y) };
    const chased = w.guards.some((g) => g.bb.alerted);
    let decoy = false;
    if (this.t <= 0) {
      this.t = 0.12 + this.rand() * 0.12;       // reaction time
      const cost = danger(w, this.margin);
      const here = cost[grid.idx(at.x, at.y)];
      const go = route(at, (x, y) => x === grid.exit.x && y === grid.exit.y, cost);
      const next = go && go[1];
      const risky = next && cost[grid.idx(next.x, next.y)] > 8;
      if (chased || here > 0) this.path = route(at, (x, y, i) => cost[i] === 0 && (x !== at.x || y !== at.y), cost) || go;   // get out of sight
      else if (this.wait > 0 || risky) {
        this.path = null;                        // hold still until the way is clear
        this.idle += this.t;
        if (this.idle > 5 && w.decoysLeft > 0 && w.guards.every((g) => g.state === 'PATROL')) { decoy = true; this.idle = 0; }
      } else this.path = go;
      if (this.path) this.idle = 0;
    }
    if (!this.path || this.path.length < 2) return { decoy };
    let c = this.path[1];
    if (at.x === c.x && at.y === c.y && Math.hypot(c.x + 0.5 - p.x, c.y + 0.5 - p.y) < 0.2) { this.path.shift(); c = this.path[1] || c; }
    const dx = c.x + 0.5 - p.x, dy = c.y + 0.5 - p.y;
    return { dx: Math.abs(dx) > 0.06 ? Math.sign(dx) : 0, dy: Math.abs(dy) > 0.06 ? Math.sign(dy) : 0, decoy };
  }
}

const LLM_TRIES = 4;
export const llmLog = { ms: [], ok: 0, retried: 0, gaveUp: 0, rejected: 0, locked: 0, models: new Set(), errors: [] };

async function learn(mem, run, llm) {
  if (!llm) { applyAdaptation(mem, await proposeAdaptation(mem, run, grid, { provider: 'local' }, {}), grid, run, {}); return; }
  for (let t = 0; t < LLM_TRIES; t++) {
    const p = await proposeAdaptation(mem, run, grid, llm, {});
    if (p.source !== 'local') {
      const rec = applyAdaptation(mem, p, grid, run, {});
      llmLog.ok++;
      llmLog.ms.push(p.ms);
      llmLog.models.add(p.model);
      llmLog.rejected += rec.rejected?.length || 0;
      if (rec.fairness) llmLog.locked++;
      return;
    }
    llmLog.retried++;
    llmLog.errors.push(p.error);
    await new Promise((ok) => setTimeout(ok, 1500 * (t + 1)));
  }
  llmLog.gaveUp++;
}

export async function playMission(seed, { easing = true, lives = 3, llm = null } = {}) {
  const rand = rng(seed);
  const mem = freshMemory(grid);
  const m = newMission({ lives, levels: MISSION_RULES.levels });
  const runs = [];
  while (!m.result && runs.length < 40) {
    const defs = [...GUARD_DEFS, ...reinforcementDefs(grid, mem, m.level - 1)];
    const rules = easing ? levelRules(m.level) : { bonusDecoys: 0, reinforcementEase: {} };
    const w = new World({
      grid, params: mem.params, guardDefs: defs, heat: mem.heat, guardTuning: mem.guardTuning,
      watchPoints: watchPointsFor(grid, defs, mem.watchPoints),
      decoys: DECOYS_PER_RUN + rules.bonusDecoys, reinforcementEase: rules.reinforcementEase,
    });
    const bot = new Bot(rand, 0.35 + rand() * 0.5);
    while (!w.outcome && w.time < MAX_TIME) w.step(STEP, bot.input(w, STEP));
    if (!w.outcome) w.outcome = 'caught';       // stuck counts as a failed run
    runs.push({ level: m.level, outcome: w.outcome, time: w.time, spotted: w.detections.length, stuck: w.time >= MAX_TIME, guards: defs.length });
    const run = buildRunRecord(w, mem);
    recordRun(mem, grid, run);
    scoreRun(m, { outcome: w.outcome, time: w.time, detections: w.detections.length });
    if (!m.result) await learn(mem, run, llm);
  }
  return { mission: m, runs };
}

async function main() {
  const n = Number(process.argv[2]) || 60;
  const easing = !process.argv.includes('--no-easing');
  // Many lives, so that every mission reaches the last levels and they are measured too.
  const by = new Map();
  const llm = process.argv.includes('--llm') ? { provider: 'huggingface', apiKey: process.env.HF_TOKEN || '', model: process.env.HF_MODEL || '' } : null;
  if (llm && !llm.apiKey) throw new Error('--llm needs a token in HF_TOKEN');
  let won3 = 0;
  const missions = [];
  const batch = llm ? 4 : 1;   // a few LLM missions at a time
  for (let s = 0; s < n; s += batch) {
    const size = Math.min(batch, n - s);
    missions.push(...await Promise.all(Array.from({ length: size }, (_, k) => playMission(1000 + s + k, { easing, lives: 9, llm }))));
  }
  for (const r of missions) {
    // With 3 lives the same mission is won if it has at most 2 catches.
    if (r.mission.result === 'won' && r.mission.catches <= 2) won3++;
    for (const x of r.runs) {
      const L = by.get(x.level) || { runs: 0, esc: 0, spotted: 0, stuck: 0, times: [] };
      L.runs++; L.spotted += x.spotted; L.stuck += x.stuck ? 1 : 0;
      if (x.outcome === 'escaped') { L.esc++; L.times.push(x.time); }
      by.set(x.level, L);
    }
  }
  console.log(`${n} missions, easing ${easing ? 'on' : 'off'} (bot player, ${llm ? 'LLM learner only' : 'local learner'})`);
  console.log('level  guards  runs  escape rate  median escape  spotted/run  timeouts');
  for (const [lvl, L] of [...by].sort((a, b) => a[0] - b[0])) {
    const t = L.times.sort((a, b) => a - b);
    console.log(`${String(lvl).padStart(5)}  ${String(lvl + 1).padStart(6)}  ${String(L.runs).padStart(4)}  ${`${Math.round((L.esc / L.runs) * 100)}%`.padStart(11)}  ${`${t.length ? t[t.length >> 1].toFixed(1) : '-'}s`.padStart(13)}  ${(L.spotted / L.runs).toFixed(2).padStart(11)}  ${String(L.stuck).padStart(8)}`);
  }
  console.log(`missions won with 3 lives: ${won3}/${n}`);
  if (llm) {
    const s = llmLog.ms.sort((a, b) => a - b);
    console.log(`LLM: ${[...llmLog.models].join(', ')}; ${llmLog.ok} adaptations, ${llmLog.retried} failed calls, ${llmLog.gaveUp} runs without an answer; `
      + `median ${s[s.length >> 1]} ms, slowest ${s.at(-1)} ms; safety checks adjusted ${llmLog.rejected} suggestions; fairness lock ${llmLog.locked} times`);
    if (llmLog.errors.length) console.log('errors:', [...new Set(llmLog.errors)].slice(0, 3));
  }
}

if (globalThis.process?.argv[1]?.endsWith('balance.mjs')) await main();
