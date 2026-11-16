$ErrorActionPreference = 'Stop'
$appRoot = Join-Path $PSScriptRoot 'app'
$dataRoot = Join-Path $env:LOCALAPPDATA 'gSender Machine Simulator\Data'
$logRoot = Join-Path $env:LOCALAPPDATA 'gSender Machine Simulator\Logs'
$url = 'http://127.0.0.1:4176/api/machine/configs'
New-Item -ItemType Directory -Path $dataRoot,$logRoot -Force | Out-Null

try {
    $ready = Invoke-RestMethod -Uri $url -TimeoutSec 2
    if ($ready.simulator -eq 'gsender-machine-simulator') { Write-Host 'Machine Simulator is already running.'; return }
} catch { }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node -and (Test-Path 'C:\msys64\mingw64\bin\node.exe')) {
    $env:Path = "C:\msys64\mingw64\bin;$env:Path"
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
}
if (-not $node) { throw 'Node.js was not found. Run Install Machine Simulator or install Node.js 20 or newer.' }
$env:SIMULATOR_PORT = '4176'
$env:MACHINE_SIM_TCP_PORT = '2327'
$env:SIMULATOR_STATE_DIR = $dataRoot
$stdout = Join-Path $logRoot 'server.log'
$stderr = Join-Path $logRoot 'server-error.log'
$serverScript = Join-Path $appRoot 'server.js'
$process = Start-Process -FilePath $node.Source -ArgumentList ('"{0}"' -f $serverScript) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    try {
        $ready = Invoke-RestMethod -Uri $url -TimeoutSec 2
        if ($ready.simulator -eq 'gsender-machine-simulator') { Write-Host 'Machine Simulator started. Web UI: http://127.0.0.1:4176/machine'; return }
    } catch { }
    if ($process.HasExited) { break }
} while ((Get-Date) -lt $deadline)

$logTail = if (Test-Path $stderr) { (Get-Content $stderr -Tail 12) -join [Environment]::NewLine } else { '' }
if (-not $logTail -and (Test-Path $stdout)) { $logTail = (Get-Content $stdout -Tail 12) -join [Environment]::NewLine }
throw "Machine Simulator failed to start. Check port 4176/2327 and logs in $logRoot. $logTail"
