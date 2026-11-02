@echo off
setlocal
set "WINDOWS_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%WINDOWS_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-Helper.ps1"
pause
