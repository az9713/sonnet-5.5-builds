@echo off
rem Serve the project on 127.0.0.1 and open the gallery. Needs Node.js 20 or newer.
rem   windows\run-browser.cmd            gallery on port 8080
rem   set PORT=8081 && windows\run-browser.cmd
setlocal
cd /d "%~dp0.."
if "%PORT%"=="" set PORT=8080
where node >nul 2>nul || (echo Node.js is missing. Install it with: winget install OpenJS.NodeJS.LTS & exit /b 1)
start "" "http://127.0.0.1:%PORT%"
node serve.mjs
