@echo off
setlocal
if "%~1"=="" (
  echo Usage: test-m8-candidate.cmd candidate-suffix
  pause
  exit /b 2
)
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 is required on PATH.
  pause
  exit /b 2
)
pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\run-m8-candidate-tests.ps1" -CandidateSuffix "%~1"
set "result=%errorlevel%"
pause
exit /b %result%
