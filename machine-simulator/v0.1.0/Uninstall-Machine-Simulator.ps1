$ErrorActionPreference = 'Stop'
$installRoot = $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'gSender Machine Simulator\Data'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\gSender Machine Simulator'
$taskName = 'gSender Machine Simulator'
$answer = Read-Host 'Remove the simulator and its shortcuts? User data can be kept or removed separately. [y/N]'
if ($answer -notmatch '^(y|yes)$') { Write-Host 'Uninstall cancelled.'; exit 0 }
& (Join-Path $installRoot 'Stop-Machine-Simulator.ps1')
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
if (Test-Path $startMenu) { Remove-Item -LiteralPath $startMenu -Recurse -Force }
$keepData = Read-Host 'Keep machine profiles and stock library? [Y/n]'
Set-Location $env:TEMP
Remove-Item -LiteralPath $installRoot -Recurse -Force
if ($keepData -match '^(n|no)$' -and (Test-Path $dataRoot)) { Remove-Item -LiteralPath $dataRoot -Recurse -Force }
Write-Host 'Machine Simulator removed.'
