$ErrorActionPreference = 'Stop'
$pluginRoot = $PSScriptRoot
$manifest = Get-Content (Join-Path $pluginRoot 'gsender-plugin.json') -Raw | ConvertFrom-Json
$uiPath = Join-Path $pluginRoot 'ui'
if (-not (Test-Path (Join-Path $uiPath 'index.html'))) { throw 'Built UI not found. Run npm run build first.' }
$zipPath = Join-Path $pluginRoot "basic-shape-cam-v$($manifest.version).zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $pluginRoot 'gsender-plugin.json'), (Join-Path $pluginRoot 'README.md'), $uiPath -DestinationPath $zipPath
Write-Output "Created $zipPath"
