@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Machine-Simulator.ps1"
if errorlevel 1 pause
