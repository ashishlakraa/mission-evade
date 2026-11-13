// Game flow: which screen the player is on, and the mission they are playing.
// No DOM here, so the same rules run in the browser and in Node tests.
//
//   MENU ──▶ PLAYING ⇄ PAUSED
//              │ run ends
//              ▼
//           RUN_END ──▶ PLAYING (next run)
//              │ mission won or lost
//              ▼
//         MISSION_END ──▶ PLAYING (play again) / MENU

export const State = {
  MENU: 'MENU', PLAYING: 'PLAYING', PAUSED: 'PAUSED', RUN_END: 'RUN_END', MISSION_END: 'MISSION_END',
};

// Allowed moves. PLAYING → PLAYING is a restart of the current run.
const MOVES = {
  MENU: ['PLAYING'],
  PLAYING: ['PLAYING', 'PAUSED', 'RUN_END', 'MENU'],
  PAUSED: ['PLAYING', 'MENU'],
  RUN_END: ['PLAYING', 'MISSION_END', 'MENU'],
  MISSION_END: ['PLAYING', 'MENU'],
};

// A mission: clear every security level before running out of lives.
// Escaping clears the current level; getting caught costs a life.
// The guards learn after every run, so each level is tuned against how you played.
export const MISSION_RULES = { lives: 3, levels: 5 };

export function newMission(rules = MISSION_RULES) {
  return {
    version: 1,
    level: 1, levels: rules.levels,
    lives: rules.lives, maxLives: rules.lives,
    runs: 0, escapes: 0, catches: 0, spotted: 0,
    bestTime: null,
    result: null,             // null while in progress | 'won' | 'lost'
  };
}

// Apply one finished run to the mission. Returns what changed, for the end card.
export function scoreRun(m, { outcome, time, detections = 0 }) {
  if (m.result) return { change: 'none' };
  m.runs++;
  m.spotted += detections;
  if (outcome === 'escaped') {
    m.escapes++;
    m.bestTime = m.bestTime == null ? time : Math.min(m.bestTime, time);
    if (m.level >= m.levels) { m.result = 'won'; return { change: 'won' }; }
    m.level++;
    return { change: 'level-up' };
  }
  m.catches++;
  m.lives = Math.max(0, m.lives - 1);
  if (m.lives === 0) { m.result = 'lost'; return { change: 'lost' }; }
  return { change: 'life-lost' };
}

// A saved mission is trusted only if it has the right shape.
export function validMission(m) {
  return !!m && m.version === 1
    && Number.isInteger(m.level) && m.level >= 1 && m.level <= m.levels
    && Number.isInteger(m.lives) && m.lives >= 0 && m.lives <= m.maxLives
    && Number.isInteger(m.runs) && (m.result === null || m.result === 'won' || m.result === 'lost');
}

export class Game {
  constructor(mission = null) {
    this.state = State.MENU;
    this.mission = validMission(mission) ? mission : null;
  }

  can(to) { return MOVES[this.state].includes(to); }

  // Move to another state; ignored (returns false) if the move is not allowed.
  go(to) {
    if (!this.can(to)) return false;
    this.state = to;
    return true;
  }

  get inProgress() { return !!this.mission && !this.mission.result; }

  startMission(rules = MISSION_RULES) { this.mission = newMission(rules); }
}
