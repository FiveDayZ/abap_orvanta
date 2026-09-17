@echo off
setlocal
cd /d "%~dp0"
node scripts\run-mvp-batch3-sap.mjs
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
