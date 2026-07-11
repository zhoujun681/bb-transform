@echo off
chcp 65001 >nul
REM Double-click this file to start the HTTPS server (for phone scanning).
cd /d "%~dp0"
echo.
echo  Starting HTTPS server (auto picks a free port if 8443 is busy)...
echo  Open the printed https://... address on your phone (same Wi-Fi).
echo  (First visit: cert untrusted warning -> Advanced -> Proceed)
echo.
python serve_https.py
echo.
echo  Server stopped. Press any key to close.
pause >nul
