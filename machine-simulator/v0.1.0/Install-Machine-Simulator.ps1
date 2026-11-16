$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\gSender Machine Simulator'
$appRoot = Join-Path $installRoot 'app'
$dataRoot = Join-Path $env:LOCALAPPDATA 'gSender Machine Simulator\Data'

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node -and (Test-Path 'C:\msys64\mingw64\bin\node.exe')) {
    $env:Path = "C:\msys64\mingw64\bin;$env:Path"
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
}
if (-not $node) {
    throw 'Node.js 20 or newer with npm is required. Install the current LTS release from https://nodejs.org/ and run this installer again.'
}
$nodeVersion = (& $node.Source --version).TrimStart('v')
if ([version]$nodeVersion -lt [version]'20.0') {
    throw "Node.js 20 or newer is required. Found $nodeVersion. Update Node.js and run this installer again."
}
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw 'npm.cmd was not found beside Node.js. Repair the Node.js installation and try again.' }

New-Item -ItemType Directory -Path $installRoot,$dataRoot -Force | Out-Null
Get-ChildItem -LiteralPath $packageRoot -Force | Where-Object { $_.Name -notin @('Install-Machine-Simulator.ps1','Install Machine Simulator.cmd','package-release.ps1') -and $_.Extension -notin @('.zip','.sha256') } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Recurse -Force
}

Push-Location $appRoot
try {
    & $npm.Source ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\gSender Machine Simulator'
New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
function New-Shortcut($Path,$Title,$ScriptName) {
    $shortcut = $shell.CreateShortcut((Join-Path $Path "$Title.lnk"))
    $shortcut.TargetPath = Join-Path $installRoot $ScriptName
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = $Title
    $shortcut.Save()
}
New-Shortcut $startMenu 'Start Machine Simulator' 'Start Machine Simulator.cmd'
New-Shortcut $startMenu 'Stop Machine Simulator' 'Stop Machine Simulator.cmd'
New-Shortcut $startMenu 'Launch Machine Simulator UI' 'Launch Machine Simulator UI.cmd'
New-Shortcut $startMenu 'Uninstall Machine Simulator' 'Uninstall Machine Simulator.cmd'

$autoStart = (Read-Host 'Start the simulator automatically when you sign in? [Y/n]').Trim()
if (-not $autoStart -or $autoStart -match '^(y|yes)$') {
    $taskName = 'gSender Machine Simulator'
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskAction = '"{0}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}"' -f $powerShell,(Join-Path $installRoot 'Start-Machine-Simulator.ps1')
    & schtasks.exe /Create /SC ONLOGON /TN $taskName /TR $taskAction /F | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Windows did not register the sign-in task. Use Start Machine Simulator from the Start menu after signing in.' }
}

Write-Host "Installed to: $installRoot"
Write-Host "User data:    $dataRoot"
Write-Host 'Use Launch Machine Simulator UI from the Start menu to start the service and open its web page.'
