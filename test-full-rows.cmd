@echo off
setlocal
pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\run-full-row-acceptance.ps1"
set "result=%errorlevel%"
pause
exit /b %result%
