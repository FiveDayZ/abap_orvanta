@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required on PATH.
  pause
  exit /b 2
)
node "%~dp0scripts\run-m7-standalone-acceptance.mjs" %*
set "result=%errorlevel%"
echo.
pause
exit /b %result%
