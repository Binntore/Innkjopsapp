@echo off
echo.
echo  Deployer Ambio Innkjøp og varer til Fly.io...
echo.
cd /d "%~dp0"
fly deploy
echo.
echo  Done! Sjekk https://ambio-innkjop.fly.dev
pause
