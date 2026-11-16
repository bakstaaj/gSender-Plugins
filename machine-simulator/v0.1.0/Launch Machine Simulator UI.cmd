@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch-Machine-Simulator-UI.ps1"
if errorlevel 1 pause
