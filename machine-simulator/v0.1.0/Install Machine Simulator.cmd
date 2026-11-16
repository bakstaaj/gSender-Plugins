@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Machine-Simulator.ps1"
if errorlevel 1 (
  echo.
  echo Installation did not complete. Review the message above.
  pause
  exit /b 1
)
pause
