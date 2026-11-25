// Scenario playtest: simulated players drive the real game in a real browser.
// These are scripted players written by the team, not people.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/serve.mjs 8123 &
//   With HF_TOKEN set, the scenarios use the LLM learner. The token is only put in the test
//   browser's storage; it is never written to a file.
//   node scripts/playtest.mjs [S1 S2 S3 S4 S5] [--out dir] [--browser chromium|firefox|webkit] [--headed]
//
// Writes one JSON result per scenario plus screenshots to --out (default: playtest-out).

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const OUT = opt('out', 'playtest-out');
const ENGINE = opt('browser', 'chromium');
const URL_ = process.env.GAME_URL || 'http://localhost:8123/';
const only = args.filter((a) => /^S\d$/.test(a));
mkdirSync(OUT, { recursive: true });
const require_ = createRequire(process.env.PLAYWRIGHT_DIR ? join(process.env.PLAYWRIGHT_DIR, 'x.js') : import.meta.url);
const pw = require_('playwright');

const gpu = ENGINE === 'chromium' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=document-user-activation-required'] : [];
const browser = await pw[ENGINE].launch({ headless: !args.includes('--headed'), args: gpu, ...(ENGINE === 'chromium' && process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });

// ---------------------------------------------------------------- helpers

async function open(name, ctxOpts = {}, { init, route, goto = true, allow = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, ...ctxOpts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  const skip = (t) => allow.some((r) => r.test(t));
  page.on('console', (m) => { if (m.type() === 'error' && !skip(m.text())) errors.push(`console: ${m.text()} ${m.location().url}`); });
  page.on('pageerror', (e) => { if (!skip(e.message)) errors.push(`page error: ${e.message}`); });
  if (route) await page.route(...route);
  if (goto) await load(page);
  return { ctx, page, errors, name };
}
async function load(page) {
  await page.goto(URL_);
  await page.waitForFunction(() => window.missionEvade, null, { timeout: 30000 });
  await page.waitForTimeout(250);
}
// The LLM learner, for scenarios that play several runs.
const LLM = process.env.HF_TOKEN ? { provider: 'huggingface', apiKey: process.env.HF_TOKEN, model: process.env.HF_MODEL || '' } : null;
async function useLlm(page) {
  if (!LLM) return;
  await page.evaluate((s) => localStorage.setItem('mission-evade:llm:v1', JSON.stringify(s)), LLM);
  await load(page);
}
// What the learner did after each run.
const learnLog = (page) => page.evaluate(() => missionEvade.memory.adaptations.map((a) => ({
  afterRun: a.afterRun, source: a.source, model: a.model, ms: a.ms, changes: a.changes.length, guardChanges: a.guardChanges?.length || 0,
  watch: a.watchChanges.length, rejected: a.rejected?.length || 0, fairness: !!a.fairness, error: a.error || null, why: a.rationale,
})));
const llmOnly = (log) => !LLM || (log.length > 0 && log.every((a) => a.source === 'huggingface'));

const state = (page) => page.evaluate(() => ({ s: missionEvade.game.state, m: missionEvade.game.mission, t: missionEvade.world.time, o: missionEvade.world.outcome, left: missionEvade.world.decoysLeft }));
const shot = (page, n) => page.screenshot({ path: join(OUT, `${ENGINE}-${n}.png`) });

// Frame times, sampled in the page while a run is on.
const sampleFrames = (page) => page.evaluate(() => {
  window.__ft = {};
  let last = 0;
  const f = (t) => {
    requestAnimationFrame(f);
    const g = missionEvade.game;
    if (g.state === 'PLAYING' && last) (window.__ft[g.mission?.level ?? 0] ||= []).push(t - last);
    last = g.state === 'PLAYING' ? t : 0;
  };
  requestAnimationFrame(f);
});
const frameStats = (page) => page.evaluate(() => Object.fromEntries(Object.entries(window.__ft).map(([l, a]) => {
  const s = [...a].sort((x, y) => x - y);
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return [l, { frames: a.length, fps: Math.round(1000 / mean), low1: Math.round(1000 / s[Math.floor(s.length * 0.99)]), worstMs: Math.round(s.at(-1)), over33ms: a.filter((x) => x > 33.4).length }];
})));

// Anything the player must see that is off screen or covered by another HUD element.
const layoutProblems = (page, ids) => page.evaluate((list) => {
  const out = [], boxes = [];
  for (const sel of list) {
    const el = document.querySelector(sel);
    if (!el || el.hidden || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(`${sel} is off screen`);
    boxes.push([sel, r]);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, p] = boxes[i], [b, q] = boxes[j];
    const w = Math.min(p.right, q.right) - Math.max(p.left, q.left), h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
    if (w > 2 && h > 2) out.push(`${a} overlaps ${b} (${Math.round(w)}x${Math.round(h)} px)`);
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  return out;
}, ids);
const HUD = ['#objective', '#detect', '#hint', '#keys', '#pad'];

// Walk along cells with real key presses until done() or the time is up.
const KEY = { '1,0': 'd', '-1,0': 'a', '0,1': 's', '0,-1': 'w' };
async function pressFor(page, key, ms) { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); }

// An in-page bot presses the same keys a player would (careful: waits for cones; otherwise straight to the exit).
const startBot = (page, { careful, seed = 7 }) => page.evaluate(async ({ careful, seed }) => {
  const { Bot, rng } = await import('/scripts/balance.mjs');
  const { findPath } = await import('/js/astar.js');
  let bot = null, world = null, last = performance.now();
  const held = new Set(), rand = rng(seed);
  const key = (k, on) => {
    if (on === held.has(k)) return;
    on ? held.add(k) : held.delete(k);
    document.body.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { key: k, bubbles: true }));
  };
  const rush = {
    input(w) {
      const p = w.player, at = { x: Math.floor(p.x), y: Math.floor(p.y) };
      const path = findPath(w.grid, at, w.grid.exit).path;
      const c = path[1] || path[0];
      const cx = c.x + 0.5 - p.x, cy = c.y + 0.5 - p.y;
      return { dx: Math.abs(cx) > 0.06 ? Math.sign(cx) : 0, dy: Math.abs(cy) > 0.06 ? Math.sign(cy) : 0 };
    },
  };
  window.__bot = true;
  const tick = (t) => {
    if (!window.__bot) { for (const k of [...held]) key(k, false); return; }
    requestAnimationFrame(tick);
    const g = missionEvade.game, w = missionEvade.world, dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (g.state !== 'PLAYING') { for (const k of [...held]) key(k, false); return; }
    if (w !== world) { world = w; bot = careful ? new Bot(rand, 0.6) : rush; }
    const i = bot.input(w, dt);
    key('d', i.dx > 0); key('a', i.dx < 0); key('s', i.dy > 0); key('w', i.dy < 0);
    if (i.decoy) { key(' ', true); key(' ', false); }
  };
  requestAnimationFrame(tick);
}, { careful, seed });
const stopBot = (page) => page.evaluate(() => { window.__bot = false; });

async function waitRunEnd(page, ms = 90000) {
  try { await page.waitForFunction(() => ['RUN_END', 'MISSION_END'].includes(missionEvade.game.state), null, { timeout: ms }); return true; } catch { return false; }
}
const btnNextReady = (page) => page.waitForFunction(() => !document.getElementById('btnNext').disabled, null, { timeout: 60000 });   // longer than the LLM's own time limit

// ---------------------------------------------------------------- scenarios

const scenarios = {
  // First-time player: only what is on screen, unhurried, real key presses.
  async S1(r) {
    const T = await open('S1');
    const { page } = T;
    await useLlm(page);
    await sampleFrames(page);
    r.menuText = (await page.textContent('#menu .end-sub')).trim();
    await shot(page, 'S1-menu');
    await page.click('#btnNewMission');
    const brief = (await page.textContent('#briefing')).replace(/\s+/g, ' ');
    r.briefingShownBeforeFirstMission = await page.isVisible('#briefing');
    r.briefingWords = brief.split(' ').length;
    r.briefingCovers = Object.fromEntries(Object.entries({
      goal: /exit/, cones: /cone/, exitLock: /locked/, decoys: /decoy/i, lives: /lives/, controls: /move/, restartCost: /restarting .* costs a life/i, learning: /learn/,
    }).map(([k, re]) => [k, re.test(brief)]));
    await shot(page, 'S1-briefing');
    await page.keyboard.press('Enter');
    r.runs = [];
    const hints = new Set();
    for (let run = 0; run < 3; run++) {
      const t0 = Date.now();
      let seed = 11 + run * 5, first = true;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      while (Date.now() - t0 < 60000) {
        const st = await state(page);
        if (st.s !== 'PLAYING') break;
        const h = await page.evaluate(() => (document.getElementById('hint').hidden ? null : document.getElementById('hint').textContent));
        if (h) hints.add(h);
        if (first && run === 0) { await page.waitForTimeout(900); await shot(page, 'S1-first-hint'); r.layout = await layoutProblems(page, HUD); first = false; }
        if (h && /Space/.test(h) && st.left === 3) await page.keyboard.press(' ');
        // Explore: prefer cells towards the exit, sometimes not.
        const dir = await page.evaluate((roll) => {
          const w = missionEvade.world, p = w.player, x = Math.floor(p.x), y = Math.floor(p.y), e = w.grid.exit;
          const opts = [[1, 0], [0, 1], [-1, 0], [0, -1]].filter(([a, b]) => w.grid.isWalkable(x + a, y + b));
          opts.sort((a, b) => Math.hypot(e.x - x - a[0], e.y - y - a[1]) - Math.hypot(e.x - x - b[0], e.y - y - b[1]));
          return roll < 0.6 ? opts[0] : opts[Math.floor(((roll - 0.6) / 0.4) * opts.length)] || opts[0];
        }, rnd());
        await pressFor(page, KEY[dir.join(',')], 250 + rnd() * 350);
        await page.waitForTimeout(120);
      }
      const st = await state(page);
      r.runs.push({ outcome: st.o || 'still exploring after 60 s', time: Math.round(st.t * 10) / 10, level: st.m.level, lives: st.m.lives, spotted: await page.evaluate(() => missionEvade.world.detections.length) });
      if (st.s === 'PLAYING') { await page.keyboard.press('Escape'); break; }
      await page.waitForTimeout(300);
      if (run === 0) await shot(page, 'S1-run-end');
      if (st.m.result) break;
      await btnNextReady(page);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    r.hintsSeen = [...hints];
    r.hintsAfterFirstRun = await page.evaluate(() => JSON.parse(localStorage.getItem('mission-evade:prefs:v1')).hintsDone);
    r.sounds = await page.evaluate(() => missionEvade.sound.played);
    r.learner = await learnLog(page);
    r.webAudio = await page.evaluate(() => typeof (window.AudioContext || window.webkitAudioContext) === 'function');   // Playwright's WebKit on Windows has none
    r.frames = await frameStats(page);
    // A second mission must not force the briefing again.
    await load(page);
    await page.click('#btnNewMission');
    await page.waitForTimeout(300);
    r.briefingSkippedSecondTime = !(await page.isVisible('#briefing'));
    r.checks = {
      'briefing covers every rule and control': Object.values(r.briefingCovers).every(Boolean),
      'briefing shown first, skipped later': r.briefingShownBeforeFirstMission && r.briefingSkippedSecondTime,
      'every adaptation came from the chosen learner': llmOnly(r.learner),
      'at least 3 hints appeared': hints.size >= 3,
      'HUD has no overlaps': r.layout.length === 0,
      'sound played (or the browser has no Web Audio)': !r.webAudio || Object.keys(r.sounds).length >= 2,
    };
    return T;
  },

  // Rusher: straight at the exit, gives up runs, mashes keys.
  async S2(r) {
    const T = await open('S2');
    const { page } = T;
    await page.evaluate(() => localStorage.setItem('mission-evade:prefs:v1', JSON.stringify({ briefed: true, hintsDone: true })));
    await load(page);
    await useLlm(page);
    await sampleFrames(page);
    await page.keyboard.press('Enter');
    await startBot(page, { careful: false });
    r.runs = [];
    for (let i = 0; i < 6; i++) {
      if (!(await waitRunEnd(page, 60000))) { r.runs.push('timeout'); break; }
      const st = await state(page);
      r.runs.push({ outcome: st.o, time: Math.round(st.t * 10) / 10, level: st.m.level, lives: st.m.lives });
      await page.keyboard.press('Enter');           // too early: the learner may still be working
      await btnNextReady(page);
      if (st.m.result) break;
      await page.waitForTimeout(50);
      if ((await state(page)).s === 'RUN_END') await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
    await stopBot(page);
    r.learner = await learnLog(page);
    // Restart rules.
    await load(page);
    await page.evaluate(() => missionEvade.newMission());
    await page.waitForTimeout(300);
    await page.keyboard.press('r');
    r.confirmText = (await page.textContent('#confirmText')).trim();
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');             // focus is on "Keep playing"
    await page.waitForTimeout(150);
    const kept = await state(page);
    for (let i = 0; i < 5; i++) await page.keyboard.press('r');   // mashing R must not confirm itself
    await page.waitForTimeout(100);
    const mashed = await state(page);
    await page.click('#btnGiveUp');
    await page.waitForTimeout(200);
    const paid = await state(page);
    // Monkey test: 600 random keys.
    const keys = ['w', 'a', 's', 'd', ' ', 'r', 'Escape', 'p', 'v', 'm', 'g', 'h', '`', 'Enter', 'ArrowUp', 'ArrowLeft', 'Tab', 'q'];
    let seed = 99;
    const seen = new Set();
    for (let i = 0; i < 600; i++) {
      seed = (seed * 16807) % 2147483647;
      await page.keyboard.press(keys[seed % keys.length]);
      if (i % 20 === 0) seen.add((await state(page)).s);
    }
    r.statesUnderMashing = [...seen];
    const after = await state(page);
    r.afterMashing = { state: after.s, lives: after.m?.lives, result: after.m?.result };
    const t1 = await page.evaluate(() => performance.now());
    await page.waitForTimeout(400);
    r.loopAlive = (await page.evaluate(() => performance.now())) > t1 && (await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => ok(true)))));
    r.frames = await frameStats(page).catch(() => ({}));
    await shot(page, 'S2-after-mashing');
    r.checks = {
      'every adaptation came from the chosen learner': llmOnly(r.learner),
      'Enter on the confirm keeps the run': kept.s === 'PLAYING' && kept.m.lives === 3,
      'mashing R does not spend a life': mashed.m.lives === 3,
      'confirming spends exactly one life': paid.m.lives === 2 && paid.m.restarts === 1,
      'lives stay between 0 and 3': after.m == null || (after.m.lives >= 0 && after.m.lives <= 3),
      'the game loop survives 600 random keys': r.loopAlive,
    };
    return T;
  },

  // Careful player with extra lives, so every level is played. Learner on, every decoy available.
  async S3(r) {
    const T = await open('S3');
    const { page } = T;
    await page.evaluate(() => {
      localStorage.setItem('mission-evade:admin:v1', JSON.stringify({ lives: 9 }));
      localStorage.setItem('mission-evade:prefs:v1', JSON.stringify({ briefed: true, hintsDone: true }));
    });
    await load(page);
    await useLlm(page);
    await sampleFrames(page);
    const mem0 = await page.evaluate(() => ({ g: missionEvade.scene.renderer.info.memory.geometries, t: missionEvade.scene.renderer.info.memory.textures }));
    await page.keyboard.press('Enter');
    await startBot(page, { careful: true });
    r.runs = [];
    const t0 = Date.now();
    const shots = new Set();
    while (Date.now() - t0 < 10 * 60000) {
      const s0 = await state(page);
      if (s0.m && !shots.has(s0.m.level) && s0.s === 'PLAYING') { shots.add(s0.m.level); await page.waitForTimeout(1500); await shot(page, `S3-level${s0.m.level}`); }
      if (!(await waitRunEnd(page, 130000))) { r.runs.push({ outcome: 'no result after 130 s', level: s0.m.level }); break; }
      const st = await state(page);
      const info = await page.evaluate(() => ({ spotted: missionEvade.world.detections.length, guards: missionEvade.world.guards.length, decoys: missionEvade.world.decoyLog.length, geo: missionEvade.scene.renderer.info.memory.geometries }));
      r.runs.push({ outcome: st.o, level: st.o === 'escaped' && !st.m.result ? st.m.level - 1 : st.m.level, time: Math.round(st.t * 10) / 10, lives: st.m.lives, ...info });
      if (st.m.result) break;
      await btnNextReady(page);
      if (r.runs.length === 2) { r.learnCard = (await page.textContent('#learnBox')).replace(/\s+/g, ' ').trim().slice(0, 400); await shot(page, 'S3-learn-card'); }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
    await stopBot(page);
    r.result = (await state(page)).m.result;
    r.levelReached = Math.max(...r.runs.map((x) => x.level));
    r.gpu = { start: mem0, geometriesPerRun: r.runs.map((x) => x.geo) };
    r.frames = await frameStats(page);
    r.sounds = await page.evaluate(() => missionEvade.sound.played);
    await page.waitForTimeout(300);
    await shot(page, 'S3-end');
    const adapt = await page.evaluate(() => missionEvade.memory.adaptations.length);
    r.adaptations = adapt;
    r.learner = await learnLog(page);
    r.checks = {
      'the guards adapted after runs': adapt > 0,
      'every adaptation came from the chosen learner': llmOnly(r.learner),
      'a result was reached on every run': r.runs.every((x) => ['escaped', 'caught'].includes(x.outcome)),
      'GPU geometry does not grow run over run': r.runs.length < 4 || r.runs.at(-1).geo - r.runs[1].geo < 40,
      'average 60 FPS or more on every level': Object.values(r.frames).every((f) => f.fps >= 60),
    };
    return T;
  },

  // Disruptive player: reloads, resizes, hides the tab, breaks storage, blocks files, loses the GPU.
  async S4(r) {
    const T = await open('S4');
    const { page } = T;
    const c = (r.checks = {});
    await page.evaluate(() => localStorage.setItem('mission-evade:prefs:v1', JSON.stringify({ briefed: true, hintsDone: true })));
    await load(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await load(page);
    let st = await state(page);
    r.reloadNotice = (await page.textContent('#menuStatus')).trim();
    c['reload during a run costs one life'] = st.m.lives === 2 && /costs a life/.test(r.reloadNotice);
    await load(page);
    c['a second reload is free'] = (await state(page)).m.lives === 2;

    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    for (const [w, h] of [[500, 400], [1600, 900], [320, 560], [1280, 760]]) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(120); }
    c['survives resizing'] = (await state(page)).s === 'PLAYING';
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(100);
    c['hiding the tab pauses'] = (await state(page)).s === 'PAUSED';
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const t = (await state(page)).t;
    await page.waitForTimeout(300);
    c['time stands still while paused'] = (await state(page)).t === t;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    c['resumes'] = (await state(page)).s === 'PLAYING';
    await page.keyboard.press('m');
    c['M mutes and it is remembered'] = await page.evaluate(() => JSON.parse(localStorage.getItem('mission-evade:prefs:v1')).muted === true);
    await page.keyboard.press('m');

    const lost = await page.evaluate(async () => {
      const gl = missionEvade.scene.renderer.getContext(), ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) return null;
      ext.loseContext();
      await new Promise((ok) => setTimeout(ok, 300));
      const paused = missionEvade.game.state;
      ext.restoreContext();
      await new Promise((ok) => setTimeout(ok, 500));
      return paused;
    });
    c['losing the GPU pauses instead of crashing'] = lost === null || lost === 'PAUSED';
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await shot(page, 'S4-after-gpu-loss');
    c['plays on after the GPU returns'] = (await state(page)).s === 'PLAYING';

    await page.evaluate(() => { document.getElementById('btnPause').click(); });
    await page.click('#btnQuit');
    await page.click('#btnGiveUp');
    await page.waitForTimeout(200);
    st = await state(page);
    c['leaving for the menu costs a life'] = st.s === 'MENU' && st.m.lives === 1;

    // Corrupt every saved value.
    const bad = ['{', 'null', '[]', '"x"', '123', '{"version":1}', '{"volume":"loud","muted":"yes","dev":1}', '{"version":1,"level":99,"levels":5,"lives":-3}'];
    r.corruption = {};
    for (const v of bad) {
      const keys = await page.evaluate(() => ['mission-evade:memory:facility-02:v1', 'mission-evade:mission:facility-02:v1', 'mission-evade:prefs:v1', 'mission-evade:llm:v1', 'mission-evade:admin:v1']);
      await page.evaluate(([ks, x]) => ks.forEach((k) => localStorage.setItem(k, x)), [keys, v]);
      const before = T.errors.length;
      try { await load(page); await page.evaluate(() => missionEvade.newMission()); await page.waitForTimeout(250); r.corruption[v] = (await state(page)).s; }
      catch (e) { r.corruption[v] = `failed: ${e.message.split('\n')[0]}`; }
      if (T.errors.length > before) r.corruption[v] += ` with errors: ${T.errors.slice(before).join(' | ')}`;
    }
    c['starts with any corrupt save'] = Object.values(r.corruption).every((x) => x === 'PLAYING');

    // Storage blocked completely.
    const B = await open('S4b', {}, { init: () => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); } });
    await B.page.click('#btnNewMission');
    await B.page.keyboard.press('Enter');
    await B.page.waitForTimeout(300);
    c['plays with storage blocked'] = (await state(B.page)).s === 'PLAYING' && B.errors.length === 0;
    T.errors.push(...B.errors);
    await B.ctx.close();

    // Art files missing: plain shapes (the browser itself logs each failed download).
    const A = await open('S4c', {}, { route: ['**/assets/{models,textures}/**', (x) => x.abort()], allow: [/Failed to load resource|ERR_FAILED|NetworkError|Couldn't load|Could not load|access control|cancelled|blocked/i] });
    await A.page.click('#btnNewMission');
    await A.page.keyboard.press('Enter');
    await A.page.waitForTimeout(500);
    c['plays with the art blocked'] = (await state(A.page)).s === 'PLAYING' && (await A.page.evaluate(() => missionEvade.assets.failed.length)) === 9 && A.errors.length === 0;
    await shot(A.page, 'S4-no-art');
    T.errors.push(...A.errors);
    await A.ctx.close();

    // No internet: only this server answers.
    const host = new URL(URL_).host;
    const O = await open('S4d', {}, { route: [(u) => u.host !== host, (x) => x.abort()], allow: [/Failed to load resource|ERR_FAILED|fonts\.g|NetworkError|access control|blocked/i] });
    await O.page.click('#btnNewMission');
    await O.page.keyboard.press('Enter');
    await O.page.waitForTimeout(500);
    c['plays offline'] = (await state(O.page)).s === 'PLAYING' && (await O.page.evaluate(() => missionEvade.assets.failed.length)) === 0 && O.errors.length === 0;
    await shot(O.page, 'S4-offline');
    T.errors.push(...O.errors);
    await O.ctx.close();

    // The admin page opens without errors.
    const D = await open('S4e', {}, { goto: false });
    await D.page.goto(`${URL_}admin/`);
    await D.page.waitForTimeout(500);
    c['admin page loads'] = (await D.page.locator('#startParams .slider').count()) === 8 && D.errors.length === 0;
    T.errors.push(...D.errors);
    await D.ctx.close();
    return T;
  },

  // Phone: touch only, portrait and landscape.
  async S5(r) {
    const mobile = ENGINE === 'firefox' ? {} : { isMobile: true };
    const T = await open('S5', { viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2, ...mobile });
    const { page } = T;
    const c = (r.checks = {});
    r.coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    await sampleFrames(page);
    await shot(page, 'S5-menu');
    await page.tap('#btnNewMission');
    await page.waitForTimeout(200);
    await shot(page, 'S5-briefing');
    c['briefing shows touch controls'] = !r.coarse || (await page.isVisible('#briefing .touch-only'));
    await page.locator('#btnBriefGo').scrollIntoViewIfNeeded();
    await page.tap('#btnBriefGo');
    await page.waitForTimeout(500);
    c['mission starts by touch'] = (await state(page)).s === 'PLAYING';
    r.portrait = await layoutProblems(page, HUD);
    await shot(page, 'S5-portrait');
    if (r.coarse) {
      const hold = async (k, ms) => { await page.dispatchEvent(`#pad [data-k="${k}"]`, 'pointerdown', { pointerType: 'touch' }); await page.waitForTimeout(ms); await page.dispatchEvent(`#pad [data-k="${k}"]`, 'pointerup', { pointerType: 'touch' }); };
      const x0 = await page.evaluate(() => missionEvade.world.player.x);
      await hold('right', 500);
      c['pad moves the player'] = (await page.evaluate(() => missionEvade.world.player.x)) > x0 + 0.5;
      await page.tap('#pad [data-k="decoy"]');
      await page.waitForTimeout(200);
      c['pad throws a decoy'] = (await state(page)).left === 2;
      c['touch targets are 40 px or more'] = await page.evaluate(() => [...document.querySelectorAll('#pad button')].every((b) => b.getBoundingClientRect().height >= 40 && b.getBoundingClientRect().width >= 40));
    }
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(500);
    r.landscape = await layoutProblems(page, HUD);
    await shot(page, 'S5-landscape');
    await page.tap('#btnPause');
    await page.waitForTimeout(200);
    await shot(page, 'S5-landscape-pause');
    c['pause works by touch'] = (await state(page)).s === 'PAUSED';
    c['pause buttons can be reached in landscape'] = await page.evaluate(() => ['btnResume', 'btnRestart', 'btnQuit'].every((id) => { const el = document.getElementById(id); el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight + 1; }));
    c['portrait layout is clean'] = r.portrait.length === 0;
    c['landscape layout is clean'] = r.landscape.length === 0;
    r.frames = await frameStats(page);
    return T;
  },
};

// ---------------------------------------------------------------- run

let failed = 0;
for (const name of Object.keys(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  const r = { scenario: name, browser: `${ENGINE} ${browser.version()}`, simulatedPlayer: true };
  const t0 = Date.now();
  let T = null;
  try { T = await scenarios[name](r); r.errors = T.errors; } catch (e) { r.errors = [`scenario stopped: ${e.message}`]; }
  r.seconds = Math.round((Date.now() - t0) / 1000);
  await T?.ctx.close();
  writeFileSync(join(OUT, `${ENGINE}-${name}.json`), JSON.stringify(r, null, 2));
  const bad = Object.entries(r.checks || {}).filter(([, v]) => !v).map(([k]) => k);
  failed += bad.length + r.errors.length;
  console.log(`${name} (${r.seconds}s): ${Object.keys(r.checks || {}).length - bad.length}/${Object.keys(r.checks || {}).length} checks, ${r.errors.length} errors`);
  for (const b of bad) console.log(`   FAILED: ${b}`);
  for (const e of r.errors.slice(0, 6)) console.log(`   ERROR: ${e}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
