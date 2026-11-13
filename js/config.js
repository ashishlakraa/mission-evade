// Mission Evade — game configuration.
// Everything the learner is allowed to change lives in PARAM_SPEC, with hard bounds.

export const MAP_ID = 'facility-02';

// Legend: # wall   . floor   S player start   E exit
// x runs left→right (columns), y runs top→bottom (rows).
export const MAP = [
  '################',
  '#S...#.........#',
  '#....#.###.###.#',
  '#....#.#.....#.#',
  '#..........#.#.#',
  '###.####.#.#...#',
  '#...#....#.###.#',
  '#.#.#.##.#.....#',
  '#.#...#..###.#.#',
  '#.####.#.#.....#',
  '#........#....E#',
  '################',
];

// The two base guards. Waypoints are grid cells. Guards walk between waypoints
// with A*, so a straight line between them is not required.
// A covers the north corridor and the east side (and walks back the same way, so it
// never crosses the middle); B covers the west and the middle.
export const GUARD_DEFS = [
  { id: 'A', name: 'Guard A', route: [[6, 1], [14, 1], [14, 7], [11, 7], [14, 6], [14, 2]] },
  { id: 'B', name: 'Guard B', route: [[1, 10], [8, 10], [8, 6], [10, 4], [6, 4]] },
];

// Each security level above 1 adds one reinforcement guard, posted where the
// player was caught or spotted before (see js/reinforce.js).
export const REINFORCE_IDS = ['C', 'D', 'E', 'F'];
export const REINFORCE_RULES = {
  minFromStart: 5,  // cells (euclidean) from the player start
  exitZone: 5,      // the exit approach (cells within this many steps of the exit) stays clear:
                    // reinforcements may not stand in it or see into it, so they never seal the exit
  minApart: 3,      // from every other guard's post
  maxShared: 1,     // a reinforcement's beat may share ground with at most this many other guards
  patrolReach: 4,   // a reinforcement walks between its post and a cell up to this many steps away
};

export const PLAYER_SPEED = 3.2;   // cells per second
export const PLAYER_RADIUS = 0.3;
export const GUARD_RADIUS = 0.32;
export const CATCH_DISTANCE = 0.62; // centre-to-centre contact distance
export const DECOYS_PER_RUN = 3;
export const DECOY_THROW = 4.5;     // cells
export const DECOY_RING = 6;        // seconds a landed decoy keeps ringing
export const DECOY_PULSE = 1;       // seconds between rings; guards in hearing range come to it
export const WATCH_PAUSE = 1.8;     // seconds a guard holds at a learned watch point

// Learnable guard parameters. The learner (LLM or local) can only move these
// inside [min, max], and by at most maxStep per run. chaseSpeed stays below
// PLAYER_SPEED so a spotted player can always still escape (fairness bound).
// harder: +1 if a higher value makes guards harder to beat, -1 if lower does, 0 if neither.
export const PARAM_SPEC = {
  coneRange:    { label: 'Vision range',  unit: 'cells', min: 4,    max: 8,    def: 6,    step: 1,    harder: 1,  desc: 'how far a guard can see' },
  coneAngle:    { label: 'Vision angle',  unit: '°',     min: 40,   max: 90,   def: 60,   step: 10,   harder: 1,  desc: 'full width of the vision cone' },
  noticeTime:   { label: 'Time to spot',  unit: 's',     min: 0.35, max: 1.0,  def: 0.65, step: 0.15, harder: -1, desc: 'seconds of sight needed before a chase starts (lower = sharper)' },
  patrolSpeed:  { label: 'Patrol speed',  unit: 'c/s',   min: 1.0,  max: 2.0,  def: 1.4,  step: 0.25, harder: 1,  desc: 'walking speed on patrol' },
  chaseSpeed:   { label: 'Chase speed',   unit: 'c/s',   min: 2.2,  max: 2.9,  def: 2.5,  step: 0.2,  harder: 1,  desc: 'running speed while chasing (always below player speed 3.2)' },
  searchTime:   { label: 'Search time',   unit: 's',     min: 1.5,  max: 5.0,  def: 2.5,  step: 0.75, harder: 0,  desc: 'seconds spent looking around at a lead (longer is more thorough but easier to distract)' },
  giveUpTime:   { label: 'Chase give-up', unit: 's',     min: 1.5,  max: 4.0,  def: 2.5,  step: 0.5,  harder: 1,  desc: 'seconds without sight before a chase becomes a search' },
  hearingRange: { label: 'Hearing range', unit: 'cells', min: 4,    max: 10,   def: 7,    step: 1.5,  harder: 1,  desc: 'how far a guard hears a decoy or a radio call' },
};

export const DEFAULT_PARAMS = Object.fromEntries(
  Object.entries(PARAM_SPEC).map(([k, s]) => [k, s.def]),
);

// Per-guard tuning. Every guard (base or reinforcement) uses the team parameters
// plus its own offsets. Only a guard that spotted or caught the player in the last run
// may get new offsets, and a guard's value may differ from the team's by at most
// maxOffsetSteps steps. A guard that was not involved drifts back towards the team
// (its offsets shrink by `decay` per run), so personal edges never pile up.
export const GUARD_TUNING = { maxOffsetSteps: 2, decay: 0.5 };

// Fairness lock: after a quick catch, or several catches in a row, the learner may
// not make any guard harder to beat for the next run. It can only ease off or hold.
export const FAIRNESS = { quickCatch: 15, catchStreak: 2 };

// One guard's parameters: the team values plus its offsets, always inside PARAM_SPEC.
export function paramsFor(team, offsets) {
  if (!offsets) return { ...team };
  const out = { ...team };
  for (const [k, s] of Object.entries(PARAM_SPEC)) {
    if (!offsets[k]) continue;
    out[k] = Math.round(Math.min(s.max, Math.max(s.min, team[k] + offsets[k])) * 100) / 100;
  }
  return out;
}

// Fairness rules for learned watch points.
export const WATCH_RULES = {
  minFromStart: 5,  // cells (euclidean) — no camping the spawn
  minFromExit: 2,   // cells — no camping the exit tile
  minApart: 3,      // watch points of different guards must be at least this far apart
  reinforcementReach: 6, // a reinforcement's watch point is at most this many steps from its post
};
