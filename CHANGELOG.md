# Changelog

## 0.4.0-alpha: MVP 2.0 (Assignment 4)

Changes since the midterm build (0.3.0, commit `8a510a2`).

### New features
- **Full game loop.** Main menu → run → pause → run result → mission complete / mission failed, driven by a state machine (`js/game.js`) that refuses illegal moves.
- **Missions.** 5 security levels and 3 lives. Escaping clears a level, getting caught costs a life. The guards still learn after every run, so each level is tuned against how you played. A mission in progress survives a reload (**Continue mission**). A new mission resets the guards' memory.
- **Reinforcements.** Each security level above 1 adds one guard (up to 6 guards at level 5). New guards are posted from run memory: first where you were caught, then where you were spotted, then the cells you walk most. With no memory yet, they guard the shortest way out. A post is never near the start or in view of it, and never on top of another guard. Reinforcements also never stand in, walk through, or look into the exit approach (every tile within 5 steps of the exit), so they can never seal the way out. The base guards still patrol it. Guards are spread out: an extra guard's whole beat may share ground with at most one other guard, so no corridor gets crowded. Only if the map runs out of room is that limit loosened. Each reinforcement walks a short beat around its post (`js/reinforce.js`).
- **Exit lock.** The exit only works while every guard is on patrol. If any guard is suspicious, investigating or chasing, the exit turns red and stays locked until all of them are back on patrol.
- **Ringing decoy.** A decoy now rings for 6 seconds after it lands, once per second, instead of making a single noise. A guard that hears it walks over and keeps searching there until it stops, so the decoy can hold guards away while you get past. Guards that walk into hearing range while it rings are pulled in too.
- **Smaller map.** The facility went from 24×16 to 16×12 (96 floor cells instead of 228), with far fewer branching points (34 instead of 169). There are still two separate ways to the exit, but fewer side routes around the guards. The base guard routes were redrawn for it, and guards A and B never walk the same cells.
- **Main menu** with Start/Continue, New mission, How to play, and Settings (learning on/off, developer view).
- **Pause menu** (Esc/P or the Pause button): Resume, Restart run, Main menu. The game also pauses itself when the tab is hidden.
- **Mission end screen** with runs, escapes, times caught, times spotted, best escape time and level reached. Play again or go to the main menu.
- **HUD:** security level, lives, an objective line (which also says when the exit is locked), a detection meter (Hidden / Seen / Spotted!), and short messages about what the guards are doing (heard a decoy, spotted you, lost you, exit locked or open).
- **Developer view:** the behavior tree, learner, run memory, debug map and stress test panel is now hidden for players. Toggle it with ` or the Dev view button.
- **Hosted LLM learner hook:** `HOSTED_LEARNER_ENDPOINT` in `js/config.js` makes a deployed Lambda proxy the default learner, so visitors need no API key.
- Guards now log when they give up a chase and start searching.
- 15 new headless tests (40 total). They include a full mission played by a bot against the real simulation, the ringing decoy, the exit lock, where reinforcements are posted and how far apart they stay, and a check that the map has exactly two separate ways to the exit.

### Bug fixes
- Pressing **R** while the learner was still working started the next run with the old guard settings, and the learner's reply then wrote into a hidden card. Restart now only works during a run, and the run result's buttons stay disabled until learning finishes.
- Resetting memory while an LLM call was pending let the late reply change the freshly reset memory. Late replies are now dropped.
- One exception inside a frame stopped the game loop for good, freezing the page. The loop now survives, logs the error once and pauses the run.
- If the browser lost the WebGL context (GPU reset), the game kept drawing into a dead context. It now pauses until the context comes back.
- Space and the arrow keys were blocked from scrolling the page even outside play (for example on the stacked mobile layout). They are now captured only during a run.
- After an update, browsers could keep some old JavaScript modules cached and run a mix of old and new code (for example, new reinforcements but no exit lock). The local server (`npm start`) and the S3 deploy command now send `Cache-Control: no-cache`.
- Clicking a top-bar button left it focused, so the next Space both threw a decoy and pressed that button again.

### Known issues
- Restarting a run (R) costs no life, so a spotted player can restart to avoid a catch.
- The LLM proxy is not deployed yet. Until `HOSTED_LEARNER_ENDPOINT` is set, the hosted build uses the local learner unless a visitor enters their own key in the developer view.
- No sound in this build. It was removed for the alpha and is planned for a later week.
- A decoy puts guards into investigate mode, which locks the exit. Throwing one near the exit therefore keeps it locked for about 6–9 seconds. This is intended (use decoys to get past guards, then wait), but it may need tuning after playtests.
- At levels 4–5 (5–6 guards on a small map) the game may be too hard. Balancing is planned after playtests.
- Memory from the old map is not carried over: the new map has a new ID, so returning players start fresh.
- One map only. More maps are planned (see the production schedule).
- Tested in Chrome on desktop and with mobile emulation. Not yet tested in Safari or Firefox.
- The page has no favicon, so the browser console shows a harmless 404.
