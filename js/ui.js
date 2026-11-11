// Screens and HUD (menu, run end, mission end, detection meter, toasts) and the
// developer side panel (live behavior tree, guard status, learned parameters, run memory, event log).

import { walk } from './bt.js';
import { PARAM_SPEC } from './config.js';
import { pathStats } from './astar.js';
import { PROVIDERS } from './llm.js';

const $ = (id) => document.getElementById(id);
const KIND_MARK = { selector: '?', sequence: '→', memsequence: '⇥', condition: '◇', action: '▸' };
const STATE_NAME = { PATROL: 'Patrol', SUSPICIOUS: 'Suspicious', INVESTIGATE: 'Investigate', CHASE: 'Chase' };

export class Panel {
  constructor() {
    this.focus = 'A';
    this.treeFor = null;
    this.nodeEls = new Map();
    this.logLen = -1;
    this.toastLen = 0;
  }

  // ---------- guards ----------

  setGuards(world, onFocus) {
    const tabs = $('guardTabs');
    tabs.textContent = '';
    for (const g of world.guards.filter((x) => !x.stress)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'tab';
      b.textContent = g.id;
      b.setAttribute('aria-selected', String(g.id === this.focus));
      b.addEventListener('click', () => { this.focus = g.id; onFocus?.(g.id); this.setGuards(world, onFocus); });
      tabs.appendChild(b);
    }
    this.buildTree(world.guards.find((g) => g.id === this.focus));
  }

  buildTree(guard) {
    this.treeFor = guard;
    this.nodeEls.clear();
    const wrap = $('btWrap');
    wrap.textContent = '';
    if (!guard) return;
    const build = (node) => {
      const li = document.createElement('li');
      li.dataset.kind = node.kind;
      const row = document.createElement('div');
      row.className = 'node';
      row.innerHTML = `<span class="k" title="${node.kind}">${KIND_MARK[node.kind] || '·'}</span><span></span>`;
      row.lastChild.textContent = node.name;
      li.appendChild(row);
      this.nodeEls.set(node, li);
      if (node.children.length) {
        const ul = document.createElement('ul');
        for (const c of node.children) ul.appendChild(build(c));
        li.appendChild(ul);
      }
      return li;
    };
    const root = document.createElement('ul');
    root.className = 'bt';
    root.appendChild(build(guard.tree));
    wrap.appendChild(root);
  }

  updateGuard(world) {
    const g = world.guards.find((x) => x.id === this.focus);
    if (!g) return;
    if (g !== this.treeFor) this.buildTree(g);
    const pill = $('gcState');
    pill.dataset.state = g.state;
    pill.textContent = STATE_NAME[g.state] || g.state;
    $('gcSus').style.width = `${Math.round(g.bb.suspicion * 100)}%`;
    const lead = g.bb.lead;
    $('gcLead').textContent = g.bb.alerted
      ? `chasing · out of sight ${g.bb.lostTime.toFixed(1)}s`
      : lead ? `${lead.reason} at (${Math.floor(lead.x)}, ${Math.floor(lead.y)})` : 'none';
    const s = g.lastSearch;
    $('gcAstar').textContent = s
      ? (s.found ? `${s.ms.toFixed(2)} ms · ${s.expanded} cells · ${s.path.length} steps` : `no path · ${s.expanded} cells`)
      : '—';

    walk(g.tree, (node) => {
      const li = this.nodeEls.get(node);
      if (!li) return;
      let st = node.tickId === g.tickId ? node.status : '';
      if (!st && node.parentMem && node.parentMem.index > node.parentMem.children.indexOf(node)) st = 'DONE';
      if (li.dataset.s !== st) li.dataset.s = st;
    });
  }

  // ---------- learning ----------

  renderParams(mem) {
    const box = $('params');
    box.textContent = '';
    for (const [k, s] of Object.entries(PARAM_SPEC)) {
      const v = mem.params[k];
      const pct = ((v - s.min) / (s.max - s.min)) * 100;
      const dpct = ((s.def - s.min) / (s.max - s.min)) * 100;
      const row = document.createElement('div');
      row.className = 'prm' + (Math.abs(v - s.def) > 1e-9 ? ' changed' : '');
      row.title = `${s.desc}. Allowed ${s.min}–${s.max} ${s.unit}, default ${s.def}.`;
      row.innerHTML = `<span class="prm-name"></span>
        <span class="prm-track"><span class="prm-def" style="left:${dpct}%"></span><span class="prm-val" style="left:${pct}%"></span></span>
        <span class="prm-num"></span>`;
      row.querySelector('.prm-name').textContent = s.label;
      row.querySelector('.prm-num').textContent = `${fmt(v)} ${s.unit}`;
      box.appendChild(row);
    }
    const w = mem.watchPoints;
    const box2 = $('watchList');
    box2.textContent = '';
    const ids = ['A', 'B'].filter((id) => w[id]);
    box2.classList.toggle('none', !ids.length);
    if (!ids.length) box2.textContent = 'none yet';
    for (const id of ids) {
      const span = document.createElement('span');
      span.textContent = `Guard ${id} → (${w[id].x}, ${w[id].y})`;
      box2.appendChild(span);
    }
  }

  renderHistory(mem) {
    $('memCount').textContent = `${mem.runs.length} run${mem.runs.length === 1 ? '' : 's'} remembered`;
    const ol = $('history');
    ol.textContent = '';
    const bySource = new Map(mem.adaptations.map((a) => [a.afterRun, a]));
    for (const r of mem.runs.slice(-10).reverse()) {
      const li = document.createElement('li');
      const a = bySource.get(r.n);
      li.innerHTML = `<span>#${r.n}</span><span class="o-${r.outcome}"></span><span class="src"></span>`;
      li.children[1].textContent = r.outcome === 'escaped' ? `escaped ${r.time}s` : `caught by ${r.caughtBy} ${r.time}s`;
      li.children[2].textContent = a ? (a.source === 'local' ? 'local' : (a.model || a.source)) : '';
      ol.appendChild(li);
    }
  }

  renderSettings(settings) {
    const sel = $('llmProvider');
    if (!sel.options.length) {
      for (const [k, p] of Object.entries(PROVIDERS)) {
        const o = document.createElement('option');
        o.value = k; o.textContent = p.label;
        sel.appendChild(o);
      }
    }
    sel.value = settings.provider;
    $('llmModel').value = settings.model || '';
    $('llmKey').value = settings.apiKey || '';
    $('llmEndpoint').value = settings.endpoint || '';
    this.syncSettingsForm();
    $('learnerName').textContent = PROVIDERS[settings.provider]?.label || settings.provider;
  }

  syncSettingsForm() {
    const p = PROVIDERS[$('llmProvider').value] || PROVIDERS.local;
    const isLLM = $('llmProvider').value !== 'local';
    for (const el of document.querySelectorAll('.needs-llm')) el.hidden = !isLLM;
    for (const el of document.querySelectorAll('.needs-key')) el.hidden = !p.needsKey;
    for (const el of document.querySelectorAll('.needs-endpoint')) el.hidden = !p.needsEndpoint;
    $('llmModel').placeholder = p.defaultModel || 'optional';
    $('llmHint').textContent = !isLLM
      ? 'The local learner uses the heat map and simple rules. Pick an LLM to have a model read run memory and choose the changes.'
      : p.needsKey
        ? 'The key is saved only in this browser and sent only to that provider. For a public site, use your own endpoint instead.'
        : 'Your endpoint receives {system, prompt} and should return {"text": "<model reply>"}. Keeps keys off the page.';
  }

  readSettings() {
    return {
      provider: $('llmProvider').value,
      model: $('llmModel').value.trim(),
      apiKey: $('llmKey').value.trim(),
      endpoint: $('llmEndpoint').value.trim(),
    };
  }

  // ---------- end of run ----------

  showEnd(world, run, mem, mission = null, change = null) {
    $('endcard').hidden = false;
    const played = change?.change === 'level-up' ? mission.level - 1 : mission?.level;
    $('endKicker').textContent = mission
      ? `Run ${mission.runs} · Security level ${played}/${mission.levels}`
      : `Run ${run.n} · ${mem.runs.length} in memory`;
    const title = $('endTitle');
    if (world.outcome === 'escaped') {
      title.textContent = 'Escaped';
      title.className = 'end-title won';
      $('endSub').textContent = `Reached the exit in ${run.time}s${run.detections.length ? `, spotted ${run.detections.length}×` : ', never spotted'}.`;
    } else {
      title.textContent = 'Caught';
      title.className = 'end-title lost';
      $('endSub').textContent = `Guard ${run.caughtBy} caught you after ${run.time}s.`;
    }
    const em = $('endMission');
    em.hidden = !mission || !change;
    if (mission && change) {
      const msg = {
        'level-up': ['up', `Security level cleared. Next: level ${mission.level} of ${mission.levels}, with one more guard posted where you were caught or seen.`],
        'life-lost': ['down', `You lost a life. ${mission.lives} of ${mission.maxLives} left.`],
        won: ['up', 'Final security level cleared. Mission complete!'],
        lost: ['down', 'No lives left. Mission failed.'],
        none: ['', 'Practice run: the mission is not affected.'],
      }[change.change];
      em.innerHTML = '<span></span>';
      em.firstChild.className = msg[0];
      em.firstChild.textContent = msg[1];
    }
    const over = !!mission?.result;
    $('btnNext').innerHTML = over ? 'See mission result <kbd>Enter</kbd>' : 'Next run <kbd>Enter</kbd>';
    $('learnBusy').hidden = true;
    $('learnWhy').hidden = true;
    $('learnChanges').hidden = true;
    $('learnNote').hidden = true;
    $('learnSource').textContent = '';
  }

  showLearning(state) {
    const busy = $('learnBusy'), why = $('learnWhy'), list = $('learnChanges'), note = $('learnNote');
    if (state.off) {
      busy.hidden = true;
      note.hidden = false;
      note.textContent = 'Learning is off. Guard parameters stay frozen for the next run.';
      $('learnSource').textContent = 'frozen';
      return;
    }
    if (state.busy) {
      busy.hidden = false;
      busy.textContent = state.label;
      $('learnSource').textContent = state.source;
      return;
    }
    const rec = state.record;
    busy.hidden = true;
    $('learnSource').textContent = rec.source === 'local' ? 'local learner' : `${rec.model || rec.source}${rec.ms ? ` · ${(rec.ms / 1000).toFixed(1)}s` : ''}`;
    why.hidden = false;
    why.textContent = rec.rationale || 'No explanation given.';
    list.hidden = false;
    list.textContent = '';
    for (const c of rec.changes) {
      const s = PARAM_SPEC[c.key];
      const li = document.createElement('li');
      li.innerHTML = '<span></span><span></span>';
      li.children[0].textContent = s.label;
      li.children[1].textContent = `${fmt(c.from)} → ${fmt(c.to)} ${s.unit}`;
      li.children[1].className = harderFor(c) ? 'up' : 'down';
      list.appendChild(li);
    }
    for (const w of rec.watchChanges) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><span></span>';
      li.children[0].textContent = `Guard ${w.id} watch point`;
      li.children[1].textContent = w.to ? `→ (${w.to.x}, ${w.to.y})` : 'removed';
      list.appendChild(li);
    }
    if (!rec.changes.length && !rec.watchChanges.length) {
      const li = document.createElement('li');
      li.textContent = 'No changes this time.';
      list.appendChild(li);
    }
    const notes = [];
    if (rec.error) notes.push(rec.error);
    if (rec.rejected?.length) notes.push(`Safety checks adjusted ${rec.rejected.length} suggestion${rec.rejected.length > 1 ? 's' : ''}: ${rec.rejected.slice(0, 3).join('; ')}${rec.rejected.length > 3 ? '…' : ''}`);
    note.hidden = !notes.length;
    note.textContent = notes.join(' ');
  }

  hideEnd() { $('endcard').hidden = true; }

  // ---------- menu and mission end ----------

  renderMenu(mission) {
    const going = !!mission && !mission.result;
    $('btnContinue').hidden = !going;
    const nm = $('btnNewMission');
    nm.className = going ? '' : 'primary';
    nm.innerHTML = going ? 'New mission' : 'Start mission <kbd>Enter</kbd>';
    const st = $('menuStatus');
    st.hidden = !going;
    if (going) {
      st.textContent = `Mission in progress: security level ${mission.level}/${mission.levels}, `
        + `${mission.lives} ${mission.lives === 1 ? 'life' : 'lives'} left, ${mission.runs} run${mission.runs === 1 ? '' : 's'} played.`;
    }
  }

  showMissionEnd(m) {
    const won = m.result === 'won';
    $('mKicker').textContent = won ? 'All security levels cleared' : 'Out of lives';
    const t = $('mTitle');
    t.textContent = won ? 'Mission complete' : 'Mission failed';
    t.className = `end-title ${won ? 'won' : 'lost'}`;
    $('mSub').textContent = won
      ? `You beat ${m.levels} levels of guards that kept learning your routes, in ${m.runs} runs.`
      : `The guards caught you ${m.catches} time${m.catches === 1 ? '' : 's'}. They reached security level ${m.level}. A new mission starts them from scratch.`;
    $('mRuns').textContent = String(m.runs);
    $('mEscapes').textContent = String(m.escapes);
    $('mCatches').textContent = String(m.catches);
    $('mSpotted').textContent = String(m.spotted);
    $('mBest').textContent = m.bestTime == null ? '—' : `${m.bestTime}s`;
    $('mLevel').textContent = `${m.level}/${m.levels}`;
  }

  // ---------- HUD, stats, log ----------

  updateHud(world, mem, mission) {
    $('hudTime').textContent = `${world.time.toFixed(1)}s`;
    $('runNo').textContent = mission ? `Run ${mission.runs + (world.outcome ? 0 : 1)}` : 'Practice';
    $('hudLevel').textContent = mission ? `${mission.level}/${mission.levels}` : '—';
    const lives = $('hudLives');
    const maxL = mission?.maxLives ?? 0;
    if (lives.childElementCount !== maxL) {
      lives.textContent = '';
      for (let i = 0; i < maxL; i++) lives.appendChild(document.createElement('i'));
    }
    [...lives.children].forEach((el, i) => el.classList.toggle('used', i >= (mission?.lives ?? 0)));
    const pips = $('hudDecoys');
    const total = world.decoysLeft + world.decoyLog.length;
    if (pips.childElementCount !== total) {
      pips.textContent = '';
      for (let i = 0; i < total; i++) pips.appendChild(document.createElement('i'));
    }
    [...pips.children].forEach((el, i) => el.classList.toggle('used', i >= world.decoysLeft));
  }

  // How close any guard is to spotting the player.
  updateDetect(world) {
    let sus = 0, alerted = false;
    for (const g of world.guards) {
      if (g.stress) continue;
      sus = Math.max(sus, g.bb.suspicion);
      alerted ||= g.bb.alerted;
    }
    const level = alerted ? 'spotted' : sus > 0.02 ? 'seen' : 'hidden';
    const box = $('detect');
    if (box.dataset.level !== level) {
      box.dataset.level = level;
      $('detectLabel').textContent = { hidden: 'Hidden', seen: 'Seen…', spotted: 'Spotted!' }[level];
    }
    $('detectBar').style.width = `${Math.round((alerted ? 1 : sus) * 100)}%`;
    $('objective').textContent = alerted ? 'Break line of sight!'
      : !world.exitOpen ? 'Exit locked: wait until every guard is back on patrol'
        : 'Reach the green exit';
    $('objective').classList.toggle('locked', !world.exitOpen);
  }

  // Short messages over the 3D view for what the guards are doing.
  updateToasts(world) {
    if (world.log.length < this.toastLen) this.toastLen = 0;
    const box = $('toasts');
    for (const e of world.log.slice(this.toastLen)) {
      if (/^Decoy thrown|^Player reached/.test(e.text)) continue;
      const li = document.createElement('li');
      li.textContent = e.text;
      box.appendChild(li);
      setTimeout(() => li.remove(), 3000);
      while (box.childElementCount > 3) box.firstChild.remove();
    }
    this.toastLen = world.log.length;
  }

  clearToasts() { $('toasts').textContent = ''; this.toastLen = 0; }

  updateStats(world, fps) {
    $('fps').textContent = `${Math.round(fps)} fps`;
    $('stCalls').textContent = String(pathStats.calls);
    $('stAvg').textContent = pathStats.calls ? `${(pathStats.totalMs / pathStats.calls).toFixed(3)} ms` : '—';
    $('stMax').textContent = pathStats.calls ? `${pathStats.maxMs.toFixed(2)} ms` : '—';
    $('stGuards').textContent = String(world.guards.length);
  }

  updateLog(world) {
    if (world.log.length === this.logLen) return;
    this.logLen = world.log.length;
    const ol = $('log');
    ol.textContent = '';
    for (const e of world.log.slice(-14).reverse()) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="t"></span><span></span>';
      li.children[0].textContent = `${e.t.toFixed(1)}s`;
      li.children[1].textContent = e.text;
      ol.appendChild(li);
    }
  }
}

// A change that makes guards tougher shows in red, easier in green.
function harderFor(c) {
  const tougherWhenHigher = { coneRange: 1, coneAngle: 1, patrolSpeed: 1, chaseSpeed: 1, giveUpTime: 1, hearingRange: 1, noticeTime: -1, searchTime: 0 };
  const dir = tougherWhenHigher[c.key] ?? 1;
  return dir === 0 ? false : (c.to - c.from) * dir > 0;
}

const fmt = (v) => String(Math.round(v * 100) / 100);
