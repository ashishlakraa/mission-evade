@echo off
rem Starts Mission Evade on http://localhost:8000 (Node if installed, otherwise Python 3).
cd /d "%~dp0"
rem Opens the browser once the server has had a moment to start.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000"
where node >nul 2>nul && (node scripts\serve.mjs 8000 & goto end)
where py >nul 2>nul && (py -3 -m http.server 8000 & goto end)
where python >nul 2>nul && (python -m http.server 8000 & goto end)
echo Install Node.js (nodejs.org) or Python 3, then run this again.
:end
pause
