// Admin dashboard (/admin). Edits the hidden game settings (gameconfig.js) and the
// learner settings, shows what the guards learned in this browser, and exports
// config/game.json for every player. No browser dialogs: resets use a second click.

import {
  PARAM_SPEC, MAP, FAIRNESS, GUARD_TUNING, WATCH_RULES, REINFORCE_RULES, PLAYER_SPEED, paramsFor,
} from './config.js';
import { Grid } from './grid.js';
import { PROVIDERS, isConfigured } from './llm.js';
import {
  CONFIG_LIMITS, sanitizeConfig, loadDeployedConfig, loadLocalOverrides, saveLocalOverrides,
  clearLocalOverrides, mergeConfig,
} from './gameconfig.js';
import {
  loadMemory, saveMemory, clearMemory, loadSettings, saveSettings, loadMission, saveMission,
} from './memory.js';

const $ = (id) => document.getElementById(id);
const round2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => String(round2(v));
const grid = new Grid(MAP);
const deployedRaw = await loadDeployedConfig('../config/game.json');
const deployed = sanitizeConfig(deployedRaw);
let cfg = mergeConfig(deployedRaw, loadLocalOverrides());
let settings = loadSettings();

// ---------- saving ----------

// Only what differs from the deployed file is stored in this browser.
function overridesOf(c) {
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'startParams') {
      const sp = Object.fromEntries(Object.entries(v).filter(([p, x]) => x !== deployed.startParams[p]));
      if (Object.keys(sp).length) out.startParams = sp;
    } else if (JSON.stringify(v) !== JSON.stringify(deployed[k])) out[k] = v;
  }
  return out;
}

function commit(msg = 'Saved in this browser. Reload the game tab to use it.') {
  cfg = sanitizeConfig(cfg);
  const ok = saveLocalOverrides(overridesOf(cfg));
  status(ok ? msg : 'This browser blocks site storage, so changes cannot be saved here. Use Download instead.');
  renderFile();
}

let statusTimer = 0;
function status(text) {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('status').textContent = ''; }, 4000);
}

// ---------- learner ----------

function renderLearner() {
  const sel = $('provider');
  if (!sel.options.length) {
    for (const [k, p] of Object.entries(PROVIDERS)) sel.add(new Option(p.label, k));
  }
  sel.value = settings.provider;
  $('model').value = settings.model || '';
  $('apiKey').value = settings.apiKey || '';
  syncLearner();
}

function syncLearner() {
  const p = PROVIDERS[$('provider').value] || PROVIDERS.local;
  const isLLM = $('provider').value !== 'local';
  for (const el of document.querySelectorAll('.needs-llm')) el.hidden = !isLLM;
  for (const el of document.querySelectorAll('.needs-key')) el.hidden = !p.needsKey;
  $('model').placeholder = p.defaultModel || 'optional';
  const ready = isConfigured(settings) || settings.provider === 'local';
  $('learnerHint').textContent = !isLLM
    ? 'The local learner uses the heat map and simple rules, with no network calls.'
    : `The token is saved only in this browser and sent only to Hugging Face. The learner applies to the game in this browser.${ready ? '' : ' Enter a token, or the game falls back to the local learner.'}`;
}

function onLearnerChange() {
  settings = {
    provider: $('provider').value,
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
  };
  saveSettings(settings);
  syncLearner();
  status(saveSettingsOk() ? 'Learner saved in this browser. Reload the game tab to use it.' : 'This browser blocks site storage, so the learner cannot be saved.');
}

// saveSettings swallows storage errors; check that the value actually landed.
function saveSettingsOk() {
  try { return JSON.parse(localStorage.getItem('mission-evade:llm:v1') || 'null')?.provider === settings.provider; } catch { return false; }
}

$('provider').addEventListener('change', onLearnerChange);
for (const id of ['model', 'apiKey']) $(id).addEventListener('change', onLearnerChange);

// ---------- mission, gameplay and learning rules ----------

function renderRules() {
  for (const [id, key] of [['lives', 'lives'], ['levels', 'levels'], ['decoys', 'decoys'], ['maxOffset', 'maxOffsetSteps']]) {
    const el = $(id), lim = CONFIG_LIMITS[key];
    el.min = lim.min; el.max = lim.max; el.value = cfg[key];
  }
  $('maxLevels').textContent = CONFIG_LIMITS.levels.max;
  $('learning').checked = cfg.learning;
  $('devView').checked = cfg.devView;
  $('perGuard').checked = cfg.perGuardTuning;
  $('maxOffset').disabled = !cfg.perGuardTuning;

  const ul = $('fairRules');
  ul.textContent = '';
  const rules = [
    `Every guard value stays in its allowed range. Chase speed is at most ${PARAM_SPEC.chaseSpeed.max} cells/s, always below the player's ${PLAYER_SPEED}, so a spotted player can always get away.`,
    'Each value moves by at most one step per run, for the team and for each guard.',
    'Only a guard that spotted or caught the player in the last run gets personal values. A guard that was not involved drifts back to the team values (its difference halves each run).',
    `Fairness lock: after a catch within ${FAIRNESS.quickCatch} s, or ${FAIRNESS.catchStreak} catches in a row, no guard may get harder for the next run.`,
    `Watch points stay at least ${WATCH_RULES.minFromStart} cells from the start, ${WATCH_RULES.minFromExit} from the exit and ${WATCH_RULES.minApart} from each other. A reinforcement's watch point is at most ${WATCH_RULES.reinforcementReach} steps from its post.`,
    `Reinforcements never stand in, walk through or look into the exit approach (${REINFORCE_RULES.exitZone} steps around the exit) or the start, so the exit can never be sealed.`,
  ];
  for (const r of rules) { const li = document.createElement('li'); li.textContent = r; ul.appendChild(li); }
}

const num = (id, key) => $(id).addEventListener('change', () => {
  cfg[key] = Number($(id).value);
  cfg = sanitizeConfig(cfg);
  $(id).value = cfg[key];
  commit();
});
num('lives', 'lives'); num('levels', 'levels'); num('decoys', 'decoys'); num('maxOffset', 'maxOffsetSteps');
const flag = (id, key) => $(id).addEventListener('change', () => {
  cfg[key] = $(id).checked;
  renderRules();
  commit();
});
flag('learning', 'learning'); flag('devView', 'devView'); flag('perGuard', 'perGuardTuning');

// ---------- starting parameters ----------

function renderStart() {
  const box = $('startParams');
  box.textContent = '';
  for (const [k, s] of Object.entries(PARAM_SPEC)) {
    const row = document.createElement('label');
    row.className = 'slider';
    row.title = s.desc;
    row.innerHTML = '<span class="s-name"></span><input type="range" step="any"><span class="s-val"></span>';
    const input = row.querySelector('input');
    input.min = s.min; input.max = s.max; input.value = cfg.startParams[k];
    row.querySelector('.s-name').textContent = s.label;
    const show = () => {
      const v = Number(input.value);
      row.querySelector('.s-val').textContent = `${fmt(v)} ${s.unit}${Math.abs(v - s.def) < 1e-9 ? '' : ` (default ${s.def})`}`;
    };
    show();
    input.addEventListener('input', () => { input.value = round2(Number(input.value)); show(); });
    input.addEventListener('change', () => {
      cfg.startParams = { ...cfg.startParams, [k]: round2(Number(input.value)) };
      commit('Saved. New missions start from these values (reload the game tab).');
    });
    box.appendChild(row);
  }
}

$('startReset').addEventListener('click', () => {
  cfg.startParams = Object.fromEntries(Object.entries(PARAM_SPEC).map(([k, s]) => [k, s.def]));
  renderStart();
  commit('Starting parameters reset to the defaults.');
});

// ---------- learned memory ----------

function renderMemory() {
  const mem = loadMemory(grid, cfg.startParams, cfg.learning);
  const dl = $('memParams');
  dl.textContent = '';
  for (const [k, s] of Object.entries(PARAM_SPEC)) {
    const d = document.createElement('div');
    d.innerHTML = '<dt></dt><dd></dd>';
    d.children[0].textContent = s.label;
    d.children[1].textContent = `${fmt(mem.params[k])} ${s.unit}`;
    if (Math.abs(mem.params[k] - cfg.startParams[k]) > 1e-9) d.classList.add('changed');
    dl.appendChild(d);
  }

  const tuned = Object.entries(mem.guardTuning || {}).filter(([, t]) => Object.keys(t).length).sort();
  $('memTuning').textContent = tuned.length ? '' : 'none yet';
  $('memTuning').classList.toggle('muted', !tuned.length);
  for (const [id, t] of tuned) {
    const eff = paramsFor(mem.params, t);
    const p = document.createElement('p');
    p.textContent = `Guard ${id}: ` + Object.keys(t).map((k) => `${PARAM_SPEC[k].label.toLowerCase()} ${fmt(eff[k])} ${PARAM_SPEC[k].unit} (team ${fmt(mem.params[k])})`).join(', ');
    $('memTuning').appendChild(p);
  }

  const wps = Object.entries(mem.watchPoints || {}).filter(([, w]) => w).sort();
  $('memWatch').textContent = wps.length ? wps.map(([id, w]) => `Guard ${id} → (${w.x}, ${w.y})`).join(' · ') : 'none yet';
  $('memWatch').classList.toggle('muted', !wps.length);

  const m = loadMission();
  $('memMission').textContent = m && !m.result
    ? `In progress: security level ${m.level}/${m.levels}, ${m.lives}/${m.maxLives} lives, ${m.runs} runs`
    : m ? `Finished (${m.result}) after ${m.runs} runs` : 'none';

  const ol = $('memAdapts');
  ol.textContent = '';
  for (const a of mem.adaptations.slice(-8).reverse()) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'a-head';
    head.textContent = `After run #${a.afterRun} · ${a.source === 'local' ? 'local learner' : (a.model || a.source)}${a.ms ? ` · ${(a.ms / 1000).toFixed(1)} s` : ''}`
      + `${a.involved?.length ? ` · involved: ${a.involved.join(', ')}` : ''}`;
    const why = document.createElement('div');
    why.textContent = a.rationale || 'No explanation given.';
    li.append(head, why);
    const extra = [];
    if (a.fairness) extra.push(`Fairness lock: ${a.fairness}.`);
    if (a.rejected?.length) extra.push(`Safety checks adjusted ${a.rejected.length}: ${a.rejected.slice(0, 4).join('; ')}${a.rejected.length > 4 ? '…' : ''}`);
    if (a.error) extra.push(a.error);
    if (extra.length) { const n = document.createElement('div'); n.className = 'muted'; n.textContent = extra.join(' '); li.appendChild(n); }
    ol.appendChild(li);
  }
  if (!mem.adaptations.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'No runs yet.'; ol.appendChild(li); }
}

// A destructive button asks for a second click instead of a dialog.
function twoClick(id, label, action) {
  const btn = $(id);
  btn.addEventListener('click', () => {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Click again to confirm';
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = label; }, 3000);
      return;
    }
    btn.dataset.confirm = '';
    btn.textContent = label;
    action();
    renderMemory();
  });
}

twoClick('memReset', 'Reset learned memory', () => {
  const mem = loadMemory(grid, cfg.startParams, cfg.learning);
  saveMemory(clearMemory(grid, cfg.startParams, mem.learning));
  status('Learned memory erased in this browser. Reload the game tab.');
});
twoClick('missionReset', 'End the mission in progress', () => {
  saveMission(null);
  status('Mission ended. The game will start a new one (reload the game tab).');
});
$('memRefresh').addEventListener('click', renderMemory);
addEventListener('storage', renderMemory);   // the game in another tab finished a run

// ---------- config file ----------

const exported = () => ({ version: 1, ...sanitizeConfig(cfg) });

function renderFile() {
  const local = Object.keys(loadLocalOverrides()).length;
  const defaults = sanitizeConfig({});
  const fromFile = Object.keys(deployed).filter((k) => JSON.stringify(deployed[k]) !== JSON.stringify(defaults[k])).length;
  $('fileStatus').textContent = `Deployed config/game.json: ${fromFile ? `${fromFile} setting${fromFile === 1 ? '' : 's'}` : 'defaults only'}. `
    + `This browser: ${local ? `${local} change${local === 1 ? '' : 's'} on top` : 'no changes'}. The file never contains an access token.`;
  $('preview').textContent = JSON.stringify(exported(), null, 2);
}

$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(exported(), null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'game.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    cfg = sanitizeConfig(JSON.parse(await file.text()));
  } catch {
    status(`${file.name} is not valid JSON.`);
    return;
  }
  renderAll();
  commit(`Imported ${file.name} into this browser.`);
});

twoClick('clearLocal', "Clear this browser's changes", () => {
  clearLocalOverrides();
  cfg = mergeConfig(deployedRaw, {});
  renderAll();
  status('This browser now uses the deployed settings.');
});

// ---------- boot ----------

function renderAll() {
  renderLearner();
  renderRules();
  renderStart();
  renderMemory();
  renderFile();
}
renderAll();
