@echo off
REM ---------------------------------------------------------------
REM  Screen & Face Recorder - local launcher
REM  Camera and screen capture need a "secure context", and
REM  http://localhost counts as one while file:// does not.
REM  So we serve the folder instead of opening the file directly.
REM ---------------------------------------------------------------
cd /d "%~dp0"

set PORT=8000

where python >nul 2>&1
if %errorlevel%==0 (
    set PY=python
) else (
    where py >nul 2>&1
    if %errorlevel%==0 (
        set PY=py
    ) else (
        echo Python was not found on your PATH.
        echo Install Python, or open the folder with any other local web server.
        pause
        exit /b 1
    )
)

echo Serving this folder at http://localhost:%PORT%/
echo Press Ctrl+C in this window to stop.
echo.

start "" http://localhost:%PORT%/
%PY% -m http.server %PORT%
