@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0open-settings.ps1"
exit /b %ERRORLEVEL%
