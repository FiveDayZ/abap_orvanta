@echo off
setlocal
cd /d "%~dp0"
node scripts\run-mvp-batch2-sap.mjs
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
