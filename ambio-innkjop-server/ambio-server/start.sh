#!/bin/bash
echo ""
echo " ============================================"
echo "  Ambio Innkjøp og varer — Oppsett og start"
echo " ============================================"
echo ""

if ! command -v node &> /dev/null; then
    echo " FEIL: Node.js er ikke installert."
    echo " Last ned fra: https://nodejs.org  (velg LTS-versjonen)"
    exit 1
fi

echo " Node.js funnet: $(node --version)"
echo ""

if [ ! -d "node_modules" ]; then
    echo " Installerer avhengigheter (express, node-fetch)..."
    npm install
    echo ""
fi

echo " Starter server..."
echo " Appen kjører på: http://localhost:3000"
echo " Trykk Ctrl+C for å stoppe."
echo ""

node server.js
