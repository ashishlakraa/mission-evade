# Mission Evade

A top-down 3D stealth game for CS 549 (AI for Visual Computing). One player against two guards, plus one more guard for each security level. Guards run a behavior tree, move with A*, and learn between runs from your earlier routes, using an LLM plus run memory.

**Goal:** reach the exit tile without a guard touching you. The exit is open (green) only while every guard is on patrol, and locked (red) while any of them is suspicious, investigating or chasing. A mission has **5 security levels** and **3 lives**: each escape clears a level, each catch costs a life, and the guards adapt after every run. Each level above 1 adds a reinforcement guard, posted from run memory where you were caught, then where you were spotted, then where you walk most (`js/reinforce.js`).

## Game loop (alpha, v0.4.0)

```
Main menu ──▶ Run ⇄ Pause
                │ escaped / caught
                ▼
           Run result (+ what the guards learned) ──▶ next run
                │ level 5 cleared, or no lives left
                ▼
           Mission complete / Mission failed ──▶ play again / main menu
```

The flow lives in `js/game.js` (a small state machine plus the mission rules, no DOM), so it is covered by headless tests. A mission in progress survives a page reload (**Continue mission** on the menu). Starting a new mission resets what the guards learned. See `CHANGELOG.md` for everything that changed since the midterm build.

## Run it

It is a static site: plain JavaScript modules, no build step. Three.js loads from a CDN.

```bash
# from this folder
npm start
# open http://localhost:8000
```

Opening `index.html` by double-click does not work, because browsers block ES modules from `file://`.

**Deploy to S3** (static website hosting on):

```bash
aws s3 sync . s3://<your-bucket> --cache-control no-cache --exclude "node_modules/*" --exclude "tests/*" --exclude "scripts/*" --exclude ".git/*" --exclude ".gitignore" --exclude "package*.json" --exclude "*.md" --exclude "*.pdf" --exclude "ramp.csv"
```

`--cache-control no-cache` matters: the game is plain ES modules, and without it browsers may keep some old modules after an update and run a mix of old and new code. `npm start` uses `scripts/serve.mjs`, which sends the same header locally.

## Controls

| Key | Action |
| --- | --- |
| W A S D / arrows | Move (touch screens get an on-screen pad) |
| Space | Throw a decoy (3 per run) |
| Esc / P | Pause menu (resume, restart run, main menu) |
| R | Restart the run (costs no life) |
| Enter | Start / continue from the menu, next run, play again |
| V | Camera: angled / top-down |
| ` | Developer view (behavior tree, learner, debug map) |
| G / H | Toggle A* paths / heat map |

## What is in the MVP

**Behavior tree** (`js/bt.js`, `js/guard.js`). A real tree, not a switch statement: Selector, Sequence, a memory Sequence, Conditions and Actions, each returning SUCCESS, FAILURE or RUNNING. A higher-priority branch halts and resets the lower ones.

```
Root (Selector)
├─ Catch        Touching player? → Catch player
├─ Chase        Alerted? → Chase player
├─ Notice       Glimpsing player? → Turn and stare
├─ Investigate  Has a lead? → [Go to lead → Search area → Clear lead]
└─ Patrol       Walk patrol route
```

States never flicker. Suspicion fills while the player is in sight and drains when not, and a chase starts only when it reaches 1. A chase only ends after `giveUpTime` seconds out of sight, and then turns into a search of the last known position. The side panel draws the tree live, highlighting the running branch.

**A\* pathfinding** (`js/astar.js`). 8-directional, √2 diagonal cost, no corner cutting, octile heuristic, binary-heap open list. Paths are then smoothed with radius-aware line-of-sight checks. Patrol, investigation and chase all use it; chase re-plans at most every 0.2 s and only when the target changes cell. The debug map shows the cells each search expanded.

**Vision** (`js/grid.js`). Range, angle, and a line-of-sight test using exact grid traversal (DDA), so sight cannot leak through walls or diagonal corner gaps. The 3D cone is ray-cast against the walls, so what you see is what the guard sees.

**Decoy.** Thrown ahead of the player and stops at walls. After landing it rings for 6 seconds, once per second. Guards within hearing range walk over and keep searching there until it stops. A guard that spots you radios the others.

**Learning with an LLM and memory** (`js/memory.js`, `js/learner.js`, `js/llm.js`).

1. Every run is saved to memory in the browser: route, where you were spotted, decoys, outcome. A heat map of your routes builds up, with recent runs weighted more.
2. After a run, the learner sends the map, the guard settings and their limits, the last run and the heat map to an LLM. It lists **every guard on duty**, reinforcements included, and which of them spotted or caught you. It asks for new team settings, **personal settings for the guards that spotted or caught you**, and one **watch point** per guard: a cell added to its patrol where it stops and looks.
3. Every suggestion passes safety checks before use, so the game stays fair at all times:
   - each setting stays within its range and moves at most one step per run; chase speed always stays below player speed, so a spotted player can still escape
   - only a guard that spotted or caught you gets personal settings, at most 2 steps from the team's; guards that were not involved drift back to the team settings
   - **fairness lock:** after a catch within 15 s, or 2 catches in a row, no guard may get harder for the next run
   - watch points are floor cells away from the start and exit; a reinforcement's stays within 6 steps of its post, out of the exit approach and out of sight of the start
4. The end-of-run card shows what the guards learned and why.

Learner options (set by the admin at `/admin`): an **open-weight model** on Hugging Face (default `Qwen/Qwen2.5-7B-Instruct`, served by Featherless AI) or the **local learner**, which needs no key and uses the heat map with simple rules. If an LLM call fails, the game falls back to the local learner and says so. Learning can be switched off to freeze the guards.

## Developer view

Players see only the 3D view and the HUD (security level, lives, time, decoys, a detection meter, and short messages about what the guards are doing). The side panel with the live behavior tree, the current learner, learned team and personal parameters, run memory, debug map and stress test is the **developer view**: press <kbd>`</kbd> or the **Dev view** button.

## Admin dashboard (`/admin`)

Not linked from the game. Configure the learner (model and token), lives, security levels, decoys, whether guards learn by default, whether players may open the developer view, per-guard tuning, and the starting guard parameters. It also shows what the guards learned (team values, personal tuning, watch points, recent adaptations with the model's reasoning) and can reset memory or the mission. The fairness rules are listed there and cannot be turned off.

Changes save in that browser at once. To apply them to every player, click **Download game.json** and upload it as `config/game.json`; the game reads that file at start and clamps every value to safe limits. The file never contains the learner or its token. The site is static, so `/admin` is hidden, not password-protected: anyone with the address can change settings in their own browser only.

## API keys

A Hugging Face token entered at `/admin` is saved only in that browser and sent only to Hugging Face. It is never written to `config/game.json`, so players who have not entered a token use the local learner.

## Tests

```bash
npm install   # only needed for three.js in browser tests; core tests have no dependencies
npm test
```

53 headless tests. `tests/game.test.mjs` covers the game flow: allowed and refused state changes, levels and lives, corrupt saved missions, and a full mission played by a bot against the real simulation. `tests/core.test.mjs` covers: map connectivity, line of sight through walls and corners, A* optimality against brute-force Dijkstra on 200 random pairs, no corner cutting, the behavior tree's priority and halting, patrol, spot → chase → catch, chase → give-up → search → patrol without flicker, decoys and hearing, escape, and the learner's safety checks.

## Project layout

```
index.html          page and HUD
css/style.css       styles (light and dark)
js/config.js        map, guard routes, learnable settings with limits
js/grid.js          grid, line of sight, ray casting
js/astar.js         A* and path smoothing
js/bt.js            behavior tree library
js/guard.js         guard perception, behavior tree, movement
js/world.js         simulation (no drawing code, runs headless)
js/memory.js        run memory in localStorage
js/learner.js       prompt, safety checks, local learner
js/llm.js           Hugging Face (open models) client
js/gameconfig.js    admin settings: deployed config/game.json + local overrides, clamped
js/admin.js         admin dashboard (admin/index.html, css/admin.css)
config/game.json    settings for every player (download it from /admin)
js/render3d.js      Three.js view
js/minimap.js       2D debug map (A* searched cells, heat map)
js/game.js          screen state machine and mission rules (headless)
js/reinforce.js     where reinforcement guards are posted (from run memory)
js/ui.js            menu, HUD, end screens, developer panel
js/main.js          input, game loop, wiring
tests/              headless tests (node --test), fairness.test.mjs for per-guard tuning and the fairness rules
```

## Stress test

Debug panel → "+ 5 guards" adds extra guards with random patrols. The panel shows FPS, A* call count, average and worst search time. Stress runs are not saved to memory.
