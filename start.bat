@echo off
cd /d "%~dp0"
echo Starting Yard Stock Tracker...  (close this window to stop it)
start "" http://localhost:3000
node server.js
pause
