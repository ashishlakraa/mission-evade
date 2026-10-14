# Mission Evade

A top-down 3D stealth game for CS 549 (AI for Visual Computing). One player, two guards. Guards run a behavior tree, move with A*, and learn between runs from your earlier routes, using an LLM plus run memory.

**Goal:** reach the green exit tile without a guard touching you.

## Run it

It is a static site: plain JavaScript modules, no build step. Three.js loads from a CDN.

```bash
# from this folder
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` by double-click does not work, because browsers block ES modules from `file://`.

**Deploy to S3** (static website hosting on):

```bash
aws s3 sync . s3://<your-bucket> --exclude "node_modules/*" --exclude "tests/*" --exclude "lambda/*" --exclude ".git/*"
```

## Controls

| Key | Action |
| --- | --- |
| W A S D / arrows | Move |
| Space | Throw a decoy (3 per run) |
| R | Restart the run |
| Enter | Next run (after a run ends) |
| G / H / V / P | Toggle A* paths / heat map / camera / pause |

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

**Decoy.** Thrown ahead of the player, stops at walls, makes a noise on landing. Guards within hearing range investigate it. A guard that spots you radios the others.

**Learning with an LLM and memory** (`js/memory.js`, `js/learner.js`, `js/llm.js`).

1. Every run is saved to memory in the browser: route, where you were spotted, decoys, outcome. A heat map of your routes builds up, with recent runs weighted more.
2. After a run, the learner sends the map, the guard settings and their limits, the last run and the heat map to an LLM. It asks for new guard settings plus one **watch point** per guard: a cell added to its patrol where it stops and looks.
3. Every suggestion passes safety checks before use: each setting stays within its range and moves at most one step per run; watch points must be floor cells away from the start and exit. Chase speed always stays below player speed, so a spotted player can still escape.
4. The end-of-run card shows what the guards learned and why.

Learner options (Learning panel): **Claude**, **OpenAI**, **your own endpoint**, or the **local learner**, which needs no key and uses the heat map with simple rules. If an LLM call fails, the game falls back to the local learner and says so. Learning can be switched off to freeze the guards.

## API keys

A key typed into the page is saved only in that browser and sent only to that provider. On a public site, do not ask visitors for keys. Instead deploy `lambda/index.mjs` as an AWS Lambda with a Function URL, set `ANTHROPIC_API_KEY` in its environment, and choose "Own endpoint (proxy)" in the game. The endpoint receives `{system, prompt}` and returns `{"text": "<model reply>"}`.

## Tests

```bash
npm install   # only needed for three.js in browser tests; core tests have no dependencies
node --test tests/core.test.mjs
```

25 headless tests cover: map connectivity, line of sight through walls and corners, A* optimality against brute-force Dijkstra on 200 random pairs, no corner cutting, the behavior tree's priority and halting, patrol, spot → chase → catch, chase → give-up → search → patrol without flicker, decoys and hearing, escape, and the learner's safety checks.

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
js/llm.js           Claude / OpenAI / proxy client
js/render3d.js      Three.js view
js/minimap.js       2D debug map (A* searched cells, heat map)
js/ui.js, main.js   panel and game loop
lambda/index.mjs    optional server-side LLM proxy
tests/              headless tests (node --test)
```

## Stress test

Debug panel → "+ 5 guards" adds extra guards with random patrols. The panel shows FPS, A* call count, average and worst search time. Stress runs are not saved to memory.
