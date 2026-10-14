// Entry point: input, the fixed-step game loop, the run lifecycle, and learning between runs.

import { Grid } from './grid.js';
import { World } from './world.js';
import { MAP, GUARD_DEFS } from './config.js';
import { Scene3D } from './render3d.js';
import { MiniMap } from './minimap.js';
import { Panel } from './ui.js';
import {
  loadMemory, saveMemory, clearMemory, buildRunRecord, recordRun, loadSettings, saveSettings,
} from './memory.js';
import { proposeAdaptation, applyAdaptation } from './learner.js';
import { PROVIDERS, isConfigured } from './llm.js';

const $ = (id) => document.getElementById(id);
const STEP = 1 / 60;

const grid = new Grid(MAP);
let mem = loadMemory(grid);
let settings = loadSettings();
const panel = new Panel();
const scene = new Scene3D($('stage'), grid);
const minimap = new MiniMap($('minimap'), grid);

const opts = {
  showPaths: true, showRoutes: true, showHeat: false, showSearch: true,
};
let world = null;
let paused = false;
let learning = false;     // waiting on the learner
let stressCount = 0;
let heatVersion = 0;

// ---------- runs ----------

function newWorld() {
  const w = new World({
    grid, params: mem.params, guardDefs: GUARD_DEFS, watchPoints: mem.watchPoints, heat: mem.heat,
  });
  for (let i = 0; i < stressCount; i++) w.addGuard(stressGuardDef(i));
  return w;
}

function startRun() {
  world = newWorld();
  learning = false;
  panel.hideEnd();
  panel.setGuards(world);
  panel.renderParams(mem);
  panel.renderHistory(mem);
  panel.logLen = -1;
  if (!opts.heatPinned) setHeat(false);
}

async function finishRun() {
  const run = buildRunRecord(world, mem);
  const stress = stressCount > 0;
  if (!stress) {
    recordRun(mem, grid, run);
    heatVersion++;
    saveMemory(mem);
  }
  panel.showEnd(world, run, mem);
  panel.renderHistory(mem);
  setHeat(true);

  if (stress) {
    panel.showLearning({ off: true });
    $('learnNote').textContent = 'Stress-test runs are not saved to memory and do not train the guards.';
    return;
  }
  if (!mem.learning) { panel.showLearning({ off: true }); return; }

  learning = true;
  const viaLLM = isConfigured(settings);
  panel.showLearning({
    busy: true,
    source: viaLLM ? (settings.model || PROVIDERS[settings.provider].defaultModel || settings.provider) : 'local learner',
    label: viaLLM ? 'Sending run memory to the LLM…' : 'Reading run memory…',
  });
  const proposal = await proposeAdaptation(mem, run, grid, settings);
  const record = applyAdaptation(mem, proposal, grid, run);
  saveMemory(mem);
  learning = false;
  panel.showLearning({ record });
  panel.renderParams(mem);
  panel.renderHistory(mem);
  updateLearnerBadge();
}

function nextRun() {
  if (learning) return;
  startRun();
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
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (e.repeat && (k === ' ' || k === 'enter')) return;
  keys.add(k);
  if (k === ' ') decoyQueued = true;
  if (k === 'r') startRun();
  if (k === 'enter' && world?.outcome) nextRun();
  if (k === 'g') toggle('optPaths');
  if (k === 'h') toggle('optHeat');
  if (k === 'v') setView(scene.view === 'top' ? 'angled' : 'top');
  if (k === 'p') setPaused(!paused);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

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
function setPaused(v) {
  paused = v;
  $('btnPause').textContent = v ? 'Resume' : 'Pause';
  $('pausedTag').hidden = !v;
}
function setView(v) {
  scene.setView(v);
  $('viewAngled').setAttribute('aria-pressed', String(v === 'angled'));
  $('viewTop').setAttribute('aria-pressed', String(v === 'top'));
}
function updateLearnerBadge() {
  $('hudLearner').textContent = !mem.learning ? 'Off'
    : isConfigured(settings) ? (settings.model || PROVIDERS[settings.provider].defaultModel || settings.provider) : 'Local';
}

$('optPaths').addEventListener('change', (e) => { opts.showPaths = e.target.checked; });
$('optRoutes').addEventListener('change', (e) => { opts.showRoutes = e.target.checked; });
$('optHeat').addEventListener('change', (e) => { opts.showHeat = e.target.checked; opts.heatPinned = e.target.checked; });
$('optSearch').addEventListener('change', (e) => { opts.showSearch = e.target.checked; });
$('viewAngled').addEventListener('click', () => setView('angled'));
$('viewTop').addEventListener('click', () => setView('top'));
$('btnPause').addEventListener('click', () => setPaused(!paused));
$('btnRestart').addEventListener('click', () => startRun());
$('btnNext').addEventListener('click', nextRun);
$('btnShowHeat').addEventListener('click', () => { setHeat(!opts.showHeat); });
$('stressAdd').addEventListener('click', () => addStress(5));
$('stressClear').addEventListener('click', clearStress);

$('learnToggle').checked = mem.learning;
$('learnToggle').addEventListener('change', (e) => {
  mem.learning = e.target.checked;
  e.target.nextElementSibling.textContent = mem.learning ? 'Learning on' : 'Learning off';
  saveMemory(mem);
  updateLearnerBadge();
});
$('learnToggle').nextElementSibling.textContent = mem.learning ? 'Learning on' : 'Learning off';

$('llmProvider').addEventListener('change', () => panel.syncSettingsForm());
$('llmSave').addEventListener('click', () => {
  settings = panel.readSettings();
  saveSettings(settings);
  panel.renderSettings(settings);
  updateLearnerBadge();
  $('llmHint').textContent = isConfigured(settings) || settings.provider === 'local'
    ? 'Saved. The learner runs after your next run ends.'
    : 'Saved, but this learner still needs a key or an endpoint. Until then the local learner is used.';
});

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
  const wasOn = mem.learning;
  mem = clearMemory(grid);
  mem.learning = wasOn;
  saveMemory(mem);
  heatVersion++;
  startRun();
});

// ---------- loop ----------

let last = performance.now();
let acc = 0;
let fps = 60, uiTimer = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (!paused && !world.outcome) {
    acc += dt;
    while (acc >= STEP) {
      world.step(STEP, readInput());
      acc -= STEP;
      if (world.outcome) { acc = 0; finishRun(); break; }
    }
  } else {
    acc = 0;
  }

  scene.setHeat(mem.heat, heatVersion);
  scene.update(world, opts, now / 1000);
  scene.render();

  uiTimer += dt;
  if (uiTimer > 0.1) {
    uiTimer = 0;
    panel.updateGuard(world);
    panel.updateHud(world, mem);
    panel.updateStats(world, fps);
    panel.updateLog(world);
    minimap.draw(world, { heat: mem.heat, showHeat: opts.showHeat, showSearch: opts.showSearch, focus: null });
  }
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => { if (document.hidden && !paused && !world.outcome) setPaused(true); });
addEventListener('resize', () => minimap.resize());

panel.renderSettings(settings);
updateLearnerBadge();
startRun();
requestAnimationFrame(frame);

// Handy for the console and for automated checks.
window.missionEvade = { get world() { return world; }, get memory() { return mem; }, startRun, scene };
