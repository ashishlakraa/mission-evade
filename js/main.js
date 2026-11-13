// Entry point: screens (menu → play → run end → mission end), input, the fixed-step
// game loop, and learning between runs.

import { Grid } from './grid.js';
import { World } from './world.js';
import { MAP, GUARD_DEFS } from './config.js';
import { reinforcementDefs } from './reinforce.js';
import { Scene3D } from './render3d.js';
import { MiniMap } from './minimap.js';
import { Panel } from './ui.js';
import { Game, State, scoreRun } from './game.js';
import {
  loadMemory, saveMemory, clearMemory, buildRunRecord, recordRun, loadSettings,
  loadMission, saveMission, loadPrefs, savePrefs,
} from './memory.js';
import { proposeAdaptation, applyAdaptation, watchPointsFor } from './learner.js';
import { PROVIDERS, isConfigured } from './llm.js';
import { loadGameConfig, tuningOptions } from './gameconfig.js';

const $ = (id) => document.getElementById(id);
const STEP = 1 / 60;

// Settings from the admin dashboard (/admin): mission rules, decoys, learner rules.
const cfg = await loadGameConfig();
const rules = { lives: cfg.lives, levels: cfg.levels };

const grid = new Grid(MAP);
let mem = loadMemory(grid, cfg.startParams, cfg.learning);
let settings = loadSettings();
const prefs = loadPrefs();
if (!cfg.devView) prefs.dev = false;
const game = new Game(missionUnderRules(loadMission()));
const panel = new Panel();
const scene = new Scene3D($('stage'), grid);
const minimap = new MiniMap($('minimap'), grid);

const opts = {
  showPaths: true, showRoutes: true, showHeat: false, showSearch: true,
};
let world = null;
let learning = false;     // waiting on the learner
let learnJob = 0;         // id of the latest learner call, so stale replies are ignored
let stressCount = 0;
let heatVersion = 0;
let contextLost = false;

// A saved mission only continues if the admin has not changed the rules since.
function missionUnderRules(m) {
  return m && m.levels === rules.levels && m.maxLives === rules.lives ? m : null;
}

// ---------- screens ----------

// Move the game to another state and show the matching overlay. Returns false if not allowed.
function enter(state) {
  if (game.state !== state && !game.go(state)) return false;
  document.body.dataset.state = state;
  $('menu').hidden = state !== State.MENU;
  $('pauseMenu').hidden = state !== State.PAUSED;
  $('missionEnd').hidden = state !== State.MISSION_END;
  if (state !== State.RUN_END) panel.hideEnd();
  $('btnPause').textContent = state === State.PAUSED ? 'Resume' : 'Pause';
  return true;
}

function showMenu() {
  if (!enter(State.MENU)) return;
  world = newWorld();   // a still backdrop behind the menu
  panel.clearToasts();
  panel.renderMenu(game.mission);
  setTimeout(() => $(game.inProgress ? 'btnContinue' : 'btnNewMission').focus(), 0);
}

function newMission() {
  // A new mission starts from untrained guards, so every mission is a fair comparison.
  mem = clearMemory(grid, cfg.startParams, mem.learning);
  saveMemory(mem);
  dropLearner();
  heatVersion++;
  game.startMission(rules);
  saveMission(game.mission);
  startRun();
}

function continueMission() {
  if (!game.inProgress) return newMission();
  startRun();
}

function showMissionEnd() {
  if (!enter(State.MISSION_END)) return;
  panel.showMissionEnd(game.mission);
  setTimeout(() => $('btnAgain').focus(), 0);
}

// ---------- runs ----------

// Security level N fields the two base guards plus N - 1 reinforcements, posted
// from run memory where the player was caught or spotted.
function guardDefsForLevel() {
  const level = game.inProgress ? game.mission.level : 1;
  return [...GUARD_DEFS, ...reinforcementDefs(grid, mem, level - 1)];
}

function newWorld() {
  const guardDefs = guardDefsForLevel();
  const w = new World({
    grid, params: mem.params, guardDefs, heat: mem.heat, decoys: cfg.decoys,
    watchPoints: watchPointsFor(grid, guardDefs, mem.watchPoints),
    guardTuning: cfg.perGuardTuning ? mem.guardTuning : {},
  });
  for (let i = 0; i < stressCount; i++) w.addGuard(stressGuardDef(i));
  return w;
}

function startRun() {
  if (learning) return;   // the next run must use what the guards just learned
  if (!enter(State.PLAYING)) return;
  world = newWorld();
  decoyQueued = false;
  panel.clearToasts();
  panel.setGuards(world);
  panel.renderParams(mem);
  panel.renderHistory(mem);
  panel.logLen = -1;
  if (!opts.heatPinned) setHeat(false);
  $('stage').focus({ preventScroll: true });
}

async function finishRun() {
  enter(State.RUN_END);
  const run = buildRunRecord(world, mem);
  const stress = stressCount > 0;
  let change = null;
  if (!stress) {
    recordRun(mem, grid, run);
    heatVersion++;
    saveMemory(mem);
    if (game.inProgress) {
      change = scoreRun(game.mission, { outcome: run.outcome, time: run.time, detections: run.detections.length });
      saveMission(game.mission);
    }
  } else if (game.mission) {
    change = { change: 'none' };
  }
  panel.showEnd(world, run, mem, game.mission, change);
  panel.renderHistory(mem);
  setHeat(true);
  setTimeout(() => $('btnNext').focus(), 0);

  if (stress) {
    panel.showLearning({ off: true });
    $('learnNote').textContent = 'Stress-test runs are not saved to memory and do not train the guards.';
    return;
  }
  if (!mem.learning) { panel.showLearning({ off: true }); return; }
  if (game.mission?.result) {
    panel.showLearning({ off: true });
    $('learnNote').textContent = 'The mission is over, so the guards stop learning here.';
    return;
  }

  learning = true;
  syncEndButtons();
  const job = ++learnJob;
  const target = mem;
  const viaLLM = isConfigured(settings);
  panel.showLearning({
    busy: true,
    source: viaLLM ? (settings.model || PROVIDERS[settings.provider].defaultModel || settings.provider) : 'local learner',
    label: viaLLM ? 'Sending run memory to the LLM…' : 'Reading run memory…',
  });
  let record = null;
  try {
    const proposal = await proposeAdaptation(target, run, grid, settings, tuningOptions(cfg));
    if (job === learnJob && target === mem) {
      record = applyAdaptation(mem, proposal, grid, run, tuningOptions(cfg));
      saveMemory(mem);
    }
  } catch (e) {
    console.error('Learner failed', e);
  } finally {
    if (job === learnJob) learning = false;
    syncEndButtons();
  }
  if (job !== learnJob || game.state !== State.RUN_END) return;   // the player moved on, or memory was reset
  if (record) panel.showLearning({ record });
  else {
    panel.showLearning({ off: true });
    $('learnNote').textContent = 'The learner hit an error, so the guards keep their current settings.';
  }
  panel.renderParams(mem);
  panel.renderHistory(mem);
  updateLearnerBadge();
}

// Leaving the run-end card waits for the learner, so the next run uses what it learned.
function syncEndButtons() {
  $('btnNext').disabled = learning;
  $('btnEndMenu').disabled = learning;
}

// Forget any learner reply still on its way (memory was reset).
function dropLearner() {
  learnJob++;
  learning = false;
  syncEndButtons();
}

function nextRun() {
  if (learning || game.state !== State.RUN_END) return;
  if (game.mission?.result) showMissionEnd();
  else startRun();
}

function restartRun() {
  if (game.state === State.PLAYING || game.state === State.PAUSED) startRun();
}

// ---------- pause ----------

function setPaused(v) {
  if (v && game.state === State.PLAYING) {
    enter(State.PAUSED);
    setTimeout(() => $('btnResume').focus(), 0);
  } else if (!v && game.state === State.PAUSED && !contextLost) {
    enter(State.PLAYING);
    $('stage').focus({ preventScroll: true });
  }
}

function quitToMenu() {
  // An unfinished run is simply dropped: it is not saved and costs no life.
  if (game.state === State.RUN_END && learning) return;
  showMenu();
}

// ---------- stress test ----------

function stressGuardDef(i) {
  const cells = grid.freeCells().filter((c) => Math.hypot(c.x - grid.start.x, c.y - grid.start.y) > 6);
  let seed = 97 + i * 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const route = [];
  for (let k = 0; k < 4; k++) {
    const c = cells[Math.floor(rnd() * cells.length)];
    route.push([c.x, c.y]);
  }
  return { id: `S${i + 1}`, name: `Stress ${i + 1}`, route, stress: true };
}

function addStress(n) {
  for (let k = 0; k < n; k++) world.addGuard(stressGuardDef(stressCount++));
}
function clearStress() {
  stressCount = 0;
  world.removeStressGuards();
}

// ---------- input ----------

const keys = new Set();
const pad = { up: 0, down: 0, left: 0, right: 0 };
let decoyQueued = false;

addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  const s = game.state;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) && s === State.PLAYING) e.preventDefault();
  if (e.repeat && (k === ' ' || k === 'enter' || k === 'escape' || k === 'p')) return;
  keys.add(k);
  if (k === 'enter') {
    // Enter on a focused button is that button's click; don't fire a second action.
    if (e.target.closest('button, summary')) return;
    if (s === State.MENU) continueMission();
    else if (s === State.RUN_END) nextRun();
    else if (s === State.MISSION_END) newMission();
    return;
  }
  if (k === ' ' && s === State.PLAYING) decoyQueued = true;
  if (k === 'escape' || k === 'p') setPaused(s === State.PLAYING);
  if (k === 'r') restartRun();
  if (k === 'g') toggle('optPaths');
  if (k === 'h') toggle('optHeat');
  if (k === 'v') setView(scene.view === 'top' ? 'angled' : 'top');
  if (k === '`' && cfg.devView) setDev(!prefs.dev);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); for (const k in pad) pad[k] = 0; });

for (const b of document.querySelectorAll('#pad button')) {
  const k = b.dataset.k;
  const down = (e) => { e.preventDefault(); if (k === 'decoy') decoyQueued = true; else pad[k] = 1; };
  const up = (e) => { e.preventDefault(); if (k !== 'decoy') pad[k] = 0; };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('pointercancel', up);
}

function readInput() {
  let dx = 0, dy = 0;
  if (keys.has('w') || keys.has('arrowup') || pad.up) dy -= 1;
  if (keys.has('s') || keys.has('arrowdown') || pad.down) dy += 1;
  if (keys.has('a') || keys.has('arrowleft') || pad.left) dx -= 1;
  if (keys.has('d') || keys.has('arrowright') || pad.right) dx += 1;
  const decoy = decoyQueued;
  decoyQueued = false;
  return { dx, dy, decoy };
}

// ---------- controls ----------

function toggle(id) { const el = $(id); el.checked = !el.checked; el.dispatchEvent(new Event('change')); }
function setHeat(on) { $('optHeat').checked = on; opts.showHeat = on; }
function setView(v) {
  scene.setView(v);
  $('viewAngled').setAttribute('aria-pressed', String(v === 'angled'));
  $('viewTop').setAttribute('aria-pressed', String(v === 'top'));
}
function setDev(on) {
  prefs.dev = on && cfg.devView;
  on = prefs.dev;
  savePrefs(prefs);
  document.body.classList.toggle('dev', on);
  $('btnDev').setAttribute('aria-pressed', String(on));
  $('menuDev').checked = on;
}
function setLearning(on) {
  mem.learning = on;
  saveMemory(mem);
  $('learnToggle').checked = on;
  $('learnToggle').nextElementSibling.textContent = on ? 'Learning on' : 'Learning off';
  $('menuLearn').checked = on;
  updateLearnerBadge();
}
function learnerLabel() {
  return !mem.learning ? 'Off'
    : isConfigured(settings) ? (settings.model || PROVIDERS[settings.provider].defaultModel || settings.provider) : 'Local';
}
function updateLearnerBadge() {
  $('hudLearner').textContent = learnerLabel();
  $('menuLearner').textContent = !mem.learning ? 'off (guards stay as they are)'
    : isConfigured(settings) ? PROVIDERS[settings.provider].label : 'Local learner (no LLM)';
}

// Buttons
$('btnContinue').addEventListener('click', continueMission);
$('btnNewMission').addEventListener('click', newMission);
$('btnResume').addEventListener('click', () => setPaused(false));
$('btnRestart').addEventListener('click', restartRun);
$('btnQuit').addEventListener('click', quitToMenu);
$('btnNext').addEventListener('click', nextRun);
$('btnEndMenu').addEventListener('click', quitToMenu);
$('btnAgain').addEventListener('click', newMission);
$('btnMenu').addEventListener('click', showMenu);
$('btnPause').addEventListener('click', () => setPaused(game.state === State.PLAYING));
$('btnDev').addEventListener('click', () => setDev(!prefs.dev));
$('menuDev').addEventListener('change', (e) => setDev(e.target.checked));
$('menuLearn').addEventListener('change', (e) => setLearning(e.target.checked));
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  // Don't leave focus on a top-bar button during play, or Space would press it again.
  if (game.state === State.PLAYING) b.blur();
});

// Developer panel
$('optPaths').addEventListener('change', (e) => { opts.showPaths = e.target.checked; });
$('optRoutes').addEventListener('change', (e) => { opts.showRoutes = e.target.checked; });
$('optHeat').addEventListener('change', (e) => { opts.showHeat = e.target.checked; opts.heatPinned = e.target.checked; });
$('optSearch').addEventListener('change', (e) => { opts.showSearch = e.target.checked; });
$('viewAngled').addEventListener('click', () => setView('angled'));
$('viewTop').addEventListener('click', () => setView('top'));
$('btnShowHeat').addEventListener('click', () => { setHeat(!opts.showHeat); });
$('stressAdd').addEventListener('click', () => addStress(5));
$('stressClear').addEventListener('click', clearStress);
$('learnToggle').addEventListener('change', (e) => setLearning(e.target.checked));

$('memReset').addEventListener('click', () => {
  const btn = $('memReset');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Click again to erase all runs';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Reset memory'; }, 3000);
    return;
  }
  btn.dataset.confirm = '';
  btn.textContent = 'Reset memory';
  mem = clearMemory(grid, cfg.startParams, mem.learning);
  saveMemory(mem);
  dropLearner();
  heatVersion++;
  if (game.state === State.MENU) { world = newWorld(); return; }
  if (game.state === State.MISSION_END) { showMenu(); return; }
  startRun();   // the current run restarts against untrained guards
});

// ---------- loop ----------

let last = performance.now();
let acc = 0;
let fps = 60, uiTimer = 0;
let frameError = false;

function frame(now) {
  requestAnimationFrame(frame);   // scheduled first, so one bad frame cannot stop the game
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  try {
    if (game.state === State.PLAYING && !world.outcome) {
      acc += dt;
      while (acc >= STEP) {
        world.step(STEP, readInput());
        acc -= STEP;
        if (world.outcome) { acc = 0; finishRun(); break; }
      }
    } else {
      acc = 0;
    }

    if (!contextLost) {
      scene.setHeat(mem.heat, heatVersion);
      scene.update(world, opts, now / 1000);
      scene.render();
    }

    uiTimer += dt;
    if (uiTimer > 0.1) {
      uiTimer = 0;
      panel.updateHud(world, mem, game.mission);
      panel.updateDetect(world);
      if (game.state === State.PLAYING) panel.updateToasts(world);
      if (prefs.dev) {
        panel.updateGuard(world);
        panel.updateStats(world, fps);
        panel.updateLog(world);
        minimap.draw(world, { heat: mem.heat, showHeat: opts.showHeat, showSearch: opts.showSearch, focus: null });
      }
    }
  } catch (e) {
    // Report once, pause the run, and keep the page alive instead of freezing on a stack trace.
    if (!frameError) console.error('Frame error', e);
    frameError = true;
    setPaused(true);
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
addEventListener('resize', () => minimap.resize());

// If the GPU resets, pause instead of drawing into a dead context.
const canvas = scene.renderer.domElement;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  contextLost = true;
  setPaused(true);
});
canvas.addEventListener('webglcontextrestored', () => { contextLost = false; });

// ---------- boot ----------

panel.renderSettings(settings);
$('ruleLevels').textContent = `${rules.levels} security level${rules.levels === 1 ? '' : 's'}`;
$('ruleLives').textContent = rules.lives === 1 ? 'once' : `${rules.lives} times`;
$('btnDev').hidden = !cfg.devView;
$('menuDev').closest('label').hidden = !cfg.devView;
setDev(prefs.dev);
setLearning(mem.learning);
$('stage').tabIndex = -1;
showMenu();
requestAnimationFrame(frame);

// Handy for the console and for automated checks.
window.missionEvade = {
  get world() { return world; }, get memory() { return mem; }, get game() { return game; },
  config: cfg, startRun, newMission, showMenu, scene,
};
