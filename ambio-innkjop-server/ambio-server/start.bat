@echo off
echo.
echo  ============================================
echo   Ambio Innkjop og varer — Oppsett og start
echo  ============================================
echo.

:: Check Node is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  FEIL: Node.js er ikke installert.
    echo  Last ned fra: https://nodejs.org  (velg LTS-versjonen)
    pause
    exit /b 1
)

echo  Node.js funnet:
node --version
echo.

:: Install dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo  Installerer avhengigheter (express, node-fetch)...
    npm install
    echo.
)

echo  Starter server...
echo  Appen kjorer pa: http://localhost:3000
echo  Trykk Ctrl+C for a stoppe.
echo.

node server.js
