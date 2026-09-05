@echo off
title Resonance Piano
echo.
echo  ==============================================
echo    Resonance Piano - Online Music Performance
echo  ==============================================
echo.
echo  Opening the piano in your default browser...
echo.
start "" "%~dp0index.html"
echo  If the page shows a "sound loading failed" message,
echo  please close it and run start_server.bat instead.
echo.
echo  (This window will close in a few seconds.)
timeout /t 4 >nul
