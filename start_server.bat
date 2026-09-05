@echo off
title Resonance Piano - Local Server
cd /d "%~dp0"

set PORT=8613

echo.
echo  ==============================================
echo    Resonance Piano - Local Server
echo  ==============================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    echo  Starting with Python:  http://127.0.0.1:%PORT%/
    start "" "http://127.0.0.1:%PORT%/"
    python -m http.server %PORT% --bind 127.0.0.1
    goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
    echo  Starting with Python:  http://127.0.0.1:%PORT%/
    start "" "http://127.0.0.1:%PORT%/"
    py -m http.server %PORT% --bind 127.0.0.1
    goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
    echo  Starting with Node.js:  http://127.0.0.1:%PORT%/
    start "" "http://127.0.0.1:%PORT%/"
    node "scripts\tiny-server.js" %PORT%
    goto :eof
)

echo  [ERROR] Neither Python nor Node.js was found.
echo.
echo  This project needs no build - you can also just double-click
echo  "start_piano.bat" to open index.html directly in the browser.
echo.
pause
