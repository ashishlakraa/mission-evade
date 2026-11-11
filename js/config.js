// Mission Evade — game configuration.
// Everything the learner is allowed to change lives in PARAM_SPEC, with hard bounds.

export const MAP_ID = 'facility-02';

// Function URL of the deployed LLM proxy (lambda/index.mjs). When set, the hosted
// build uses it as the default learner, so visitors never need an API key.
export const HOSTED_LEARNER_ENDPOINT = '';

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
export const PARAM_SPEC = {
  coneRange:    { label: 'Vision range',  unit: 'cells', min: 4,    max: 8,    def: 6,    step: 1,    desc: 'how far a guard can see' },
  coneAngle:    { label: 'Vision angle',  unit: '°',     min: 40,   max: 90,   def: 60,   step: 10,   desc: 'full width of the vision cone' },
  noticeTime:   { label: 'Time to spot',  unit: 's',     min: 0.35, max: 1.0,  def: 0.65, step: 0.15, desc: 'seconds of sight needed before a chase starts (lower = sharper)' },
  patrolSpeed:  { label: 'Patrol speed',  unit: 'c/s',   min: 1.0,  max: 2.0,  def: 1.4,  step: 0.25, desc: 'walking speed on patrol' },
  chaseSpeed:   { label: 'Chase speed',   unit: 'c/s',   min: 2.2,  max: 2.9,  def: 2.5,  step: 0.2,  desc: 'running speed while chasing (always below player speed 3.2)' },
  searchTime:   { label: 'Search time',   unit: 's',     min: 1.5,  max: 5.0,  def: 2.5,  step: 0.75, desc: 'seconds spent looking around at a lead' },
  giveUpTime:   { label: 'Chase give-up', unit: 's',     min: 1.5,  max: 4.0,  def: 2.5,  step: 0.5,  desc: 'seconds without sight before a chase becomes a search' },
  hearingRange: { label: 'Hearing range', unit: 'cells', min: 4,    max: 10,   def: 7,    step: 1.5,  desc: 'how far a guard hears a decoy or a radio call' },
};

export const DEFAULT_PARAMS = Object.fromEntries(
  Object.entries(PARAM_SPEC).map(([k, s]) => [k, s.def]),
);

// Fairness rules for learned watch points.
export const WATCH_RULES = {
  minFromStart: 5,  // cells (euclidean) — no camping the spawn
  minFromExit: 2,   // cells — no camping the exit tile
  minApart: 3,      // the two guards' watch points must differ
};
