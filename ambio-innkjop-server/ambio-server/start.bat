@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installerer avhengigheter...
  npm install
)
echo.
echo  Starter Ambio lokalt på http://localhost:3000
echo  Trykk Ctrl+C for å stoppe.
echo.
node server.js
