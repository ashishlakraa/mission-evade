// Game settings an admin can change at /admin. Players never see these.
//
// Two layers, later wins:
//   1. config/game.json, deployed with the site, applies to every player
//   2. overrides saved by /admin in this browser (localStorage), for trying changes out
// Everything is clamped to safe bounds here, so a bad file can never make the game unfair.
// The learner and its access token are never part of this config: they stay in the
// learner settings of the admin's browser (see memory.js).

import { PARAM_SPEC, DEFAULT_PARAMS, DECOYS_PER_RUN, GUARD_TUNING, REINFORCE_IDS } from './config.js';
import { MISSION_RULES } from './game.js';

export const ADMIN_KEY = 'mission-evade:admin:v1';

export const CONFIG_LIMITS = {
  lives: { min: 1, max: 9 },
  levels: { min: 1, max: 1 + REINFORCE_IDS.length },   // each level above 1 adds one reinforcement
  decoys: { min: 0, max: 6 },
  maxOffsetSteps: { min: 0, max: 3 },
};

export const CONFIG_DEFAULTS = {
  lives: MISSION_RULES.lives,
  levels: MISSION_RULES.levels,
  decoys: DECOYS_PER_RUN,
  learning: true,                       // default for new players; each player can still turn it off
  perGuardTuning: true,                 // the learner may tune the guards that spotted or caught the player
  maxOffsetSteps: GUARD_TUNING.maxOffsetSteps,
  devView: true,                        // players may open the developer view (`)
  startParams: { ...DEFAULT_PARAMS },   // untrained guards at the start of every mission
};

// Clamp every value to its bounds and drop anything unknown.
export function sanitizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const int = (v, { min, max }, def) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : def);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const D = CONFIG_DEFAULTS;
  const startParams = {};
  for (const [k, s] of Object.entries(PARAM_SPEC)) {
    const v = Number(c.startParams?.[k]);
    startParams[k] = Number.isFinite(v) ? Math.round(Math.min(s.max, Math.max(s.min, v)) * 100) / 100 : s.def;
  }
  return {
    lives: int(c.lives, CONFIG_LIMITS.lives, D.lives),
    levels: int(c.levels, CONFIG_LIMITS.levels, D.levels),
    decoys: int(c.decoys, CONFIG_LIMITS.decoys, D.decoys),
    learning: bool(c.learning, D.learning),
    perGuardTuning: bool(c.perGuardTuning, D.perGuardTuning),
    maxOffsetSteps: int(c.maxOffsetSteps, CONFIG_LIMITS.maxOffsetSteps, D.maxOffsetSteps),
    devView: bool(c.devView, D.devView),
    startParams,
  };
}

// The deployed file. Missing or broken means "no deployed changes".
export async function loadDeployedConfig(url = 'config/game.json') {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

export function loadLocalOverrides() {
  try { return JSON.parse(localStorage.getItem(ADMIN_KEY) || '{}') || {}; } catch { return {}; }
}

export function saveLocalOverrides(o) {
  try { localStorage.setItem(ADMIN_KEY, JSON.stringify(o)); return true; } catch { return false; }
}

export function clearLocalOverrides() {
  try { localStorage.removeItem(ADMIN_KEY); } catch { /* storage blocked */ }
}

export function mergeConfig(deployed, local) {
  return sanitizeConfig({
    ...deployed, ...local,
    startParams: { ...deployed?.startParams, ...local?.startParams },
  });
}

export async function loadGameConfig(url) {
  return mergeConfig(await loadDeployedConfig(url), loadLocalOverrides());
}

// Learner options for the hidden tuning rules (passed to the learner after each run).
export function tuningOptions(cfg) {
  return { perGuard: cfg.perGuardTuning, maxOffsetSteps: cfg.maxOffsetSteps };
}
