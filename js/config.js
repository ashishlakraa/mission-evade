// Mission Evade — game configuration.
// Everything the learner is allowed to change lives in PARAM_SPEC, with hard bounds.

export const MAP_ID = 'facility-01';

// Legend: # wall   . floor   S player start   E exit
// x runs left→right (columns), y runs top→bottom (rows).
export const MAP = [
  '########################',
  '#S.......#.............#',
  '#........#....######...#',
  '#..####..#....#........#',
  '#..#.........##...###..#',
  '#..#..####.......#.....#',
  '#.....#..#...##..#..####',
  '####..#..#...#.........#',
  '#.....#......#..####...#',
  '#..####..###.#.....#...#',
  '#........#.......#.#...#',
  '#.###....#..####.#.....#',
  '#...#.......#....###...#',
  '#...#..####.#..........#',
  '#.......#...........#E.#',
  '########################',
];

// Exactly two guards (the MVP configuration). Waypoints are grid cells.
// Guards walk between waypoints with A*, so a straight line between them is not required.
export const GUARD_DEFS = [
  { id: 'A', name: 'Guard A', route: [[11, 1], [22, 1], [22, 5], [18, 7], [11, 7]] },
  { id: 'B', name: 'Guard B', route: [[2, 10], [8, 12], [16, 13], [22, 10], [14, 10]] },
];

export const PLAYER_SPEED = 3.2;   // cells per second
export const PLAYER_RADIUS = 0.3;
export const GUARD_RADIUS = 0.32;
export const CATCH_DISTANCE = 0.62; // centre-to-centre contact distance
export const DECOYS_PER_RUN = 3;
export const DECOY_THROW = 4.5;     // cells
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
