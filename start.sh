#!/bin/sh
# Starts Mission Evade on http://localhost:8000 (Node if installed, otherwise Python 3).
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
echo "Open http://localhost:$PORT in a browser. Press Ctrl+C to stop."
if command -v node >/dev/null 2>&1; then exec node scripts/serve.mjs "$PORT"; fi
if command -v python3 >/dev/null 2>&1; then exec python3 -m http.server "$PORT"; fi
echo "Install Node.js (nodejs.org) or Python 3, then run this again."
exit 1
