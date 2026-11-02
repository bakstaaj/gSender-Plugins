@echo off
setlocal
set "WINDOWS_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%WINDOWS_PS%" (
  echo Windows PowerShell 5.1 was not found. This package supports Windows 10 and newer.
  pause
  exit /b 1
)
"%WINDOWS_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Helper.ps1"
pause
