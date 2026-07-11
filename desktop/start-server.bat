@echo off
REM Launcher for the packaged bb-transform signaling server (no Docker / no Node needed).
REM Double-click this file. It runs bb-transform-server.exe from this folder.
cd /d "%~dp0"

setlocal
REM Port resolution order: command-line arg > existing PORT env > default 8080.
REM   start-server.bat         -> uses %PORT% if set, else 8080
REM   start-server.bat 9000    -> forces 9000
if not "%~1"=="" (
    set "PORT=%~1"
) else (
    if not defined PORT set "PORT=8080"
)

echo.
echo  bb-transform server (no Docker / no Node needed)
echo  ==================================================
echo.
echo  Starting... open one of these URLs in a browser
echo  (phones on the same Wi-Fi / LAN can use them too):
echo.
echo    http://localhost:%PORT%
echo.
echo  This machine LAN IPv4 addresses (open one on your phone):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    for /f "tokens=* delims= " %%b in ("%%a") do echo    http://%%b:%PORT%
)
echo.
echo  Press Ctrl+C to stop the server.
echo  Closing this window also stops it.
echo  --------------------------------------------------
echo.

REM Run the packaged exe. It reads the PORT env var (already set above).
"bb-transform-server.exe"

echo.
echo  Server stopped. Press any key to close this window.
pause >nul
endlocal
