@echo off
setlocal
cd /d "%~dp0"
node scripts\run-mvp-batch1-acceptance.mjs %*
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
