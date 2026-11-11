$ErrorActionPreference = 'Stop'

$pluginRoot = $PSScriptRoot
$manifest = Get-Content (Join-Path $pluginRoot 'gsender-plugin.json') -Raw | ConvertFrom-Json
$uiPath = Join-Path $pluginRoot 'ui'
if (-not (Test-Path (Join-Path $uiPath 'index.html'))) {
    throw 'Built UI not found. Run npm run build first.'
}

$zipPath = Join-Path $pluginRoot "camera-align-print-registration-v$($manifest.version).zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
$packagePaths = @(
    (Join-Path $pluginRoot 'gsender-plugin.json'),
    (Join-Path $pluginRoot 'README.md'),
    $uiPath
)
$screenshotsPath = Join-Path $pluginRoot 'screenshots'
if (Test-Path -LiteralPath $screenshotsPath) { $packagePaths += $screenshotsPath }
Compress-Archive -Path $packagePaths -DestinationPath $zipPath
Write-Output "Created $zipPath"
