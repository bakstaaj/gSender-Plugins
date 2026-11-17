$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app')).TrimEnd('\')
$taskName = 'gSender Machine Simulator'
try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($appRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match 'server\.js'
}
if (-not $processes) { Write-Host 'Machine Simulator is not running.'; return }
foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Write-Host 'Machine Simulator stopped.'
