// Run memory. Saved in the browser (localStorage) per map, so guards keep what
// they learned between runs and page reloads. Storage can be unavailable
// (private windows, blocked site data); the game then keeps memory in RAM.

import { DEFAULT_PARAMS, MAP_ID, HOSTED_LEARNER_ENDPOINT } from './config.js';

const KEY = `mission-evade:memory:${MAP_ID}:v1`;
const SETTINGS_KEY = 'mission-evade:llm:v1';
const MISSION_KEY = `mission-evade:mission:${MAP_ID}:v1`;
const PREFS_KEY = 'mission-evade:prefs:v1';
const MAX_RUNS = 40;
const HEAT_DECAY = 0.8; // older runs fade, recent habits count most

export function freshMemory(grid) {
  return {
    version: 1,
    mapId: MAP_ID,
    learning: true,
    params: { ...DEFAULT_PARAMS },
    watchPoints: { A: null, B: null },
    heat: new Array(grid.w * grid.h).fill(0),
    runs: [],
    adaptations: [],
  };
}

export function loadMemory(grid) {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshMemory(grid);
    const m = JSON.parse(raw);
    if (m.version !== 1 || !Array.isArray(m.heat) || m.heat.length !== grid.w * grid.h) return freshMemory(grid);
    m.params = { ...DEFAULT_PARAMS, ...m.params };
    return m;
  } catch {
    return freshMemory(grid);
  }
}

export function saveMemory(mem) {
  try { localStorage.setItem(KEY, JSON.stringify(mem)); return true; } catch { return false; }
}

export function clearMemory(grid) {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
  return freshMemory(grid);
}

// Turn a finished World into a compact run record.
export function buildRunRecord(world, mem) {
  return {
    n: (mem.runs.at(-1)?.n ?? 0) + 1,
    ts: Date.now(),
    outcome: world.outcome,
    caughtBy: world.caughtBy,
    time: Math.round(world.time * 10) / 10,
    route: world.route.map((c) => [c.x, c.y]),
    detections: world.detections.slice(),
    decoys: world.decoyLog.slice(),
    params: { ...world.params },
    watchPoints: Object.fromEntries(Object.entries(world.watchPoints).map(([k, v]) => [k, v ? [v.x, v.y] : null])),
  };
}

export function recordRun(mem, grid, run) {
  mem.runs.push(run);
  if (mem.runs.length > MAX_RUNS) mem.runs.splice(0, mem.runs.length - MAX_RUNS);
  for (let i = 0; i < mem.heat.length; i++) mem.heat[i] = Math.round(mem.heat[i] * HEAT_DECAY * 1000) / 1000;
  const seen = new Set();
  for (const [x, y] of run.route) {
    const i = grid.idx(x, y);
    if (seen.has(i)) continue;
    seen.add(i);
    mem.heat[i] += 1;
  }
}

export function loadSettings() {
  // A hosted build can ship a proxy endpoint, so visitors get the LLM learner without a key.
  const base = HOSTED_LEARNER_ENDPOINT
    ? { provider: 'proxy', apiKey: '', model: '', endpoint: HOSTED_LEARNER_ENDPOINT }
    : { provider: 'local', apiKey: '', model: '', endpoint: '' };
  try { return { ...base, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return base; }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

// The mission in progress (lives, security level), so Continue survives a reload.
export function loadMission() {
  try { return JSON.parse(localStorage.getItem(MISSION_KEY) || 'null'); } catch { return null; }
}

export function saveMission(m) {
  try { localStorage.setItem(MISSION_KEY, JSON.stringify(m)); } catch { /* storage blocked */ }
}

// Per-player conveniences: developer view.
export function loadPrefs() {
  const base = { dev: false };
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return base; }
}

export function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}
