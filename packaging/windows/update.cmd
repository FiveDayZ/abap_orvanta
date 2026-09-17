@echo off
setlocal
title ORVANTA Update
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo ORVANTA update finished.
) else (
  echo ORVANTA update failed. The previous installation was kept or restored.
)
pause
exit /b %EXIT_CODE%
