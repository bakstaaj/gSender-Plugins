$ErrorActionPreference = 'Stop'

$buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) "camera-monitor-plugin-$([guid]::NewGuid().ToString('N'))"
$stagePath = Join-Path $buildRoot 'plugin'
$manifest = Get-Content (Join-Path $PSScriptRoot 'gsender-plugin.json') -Raw | ConvertFrom-Json
$outputPath = Join-Path $PSScriptRoot "camera-monitor-v$($manifest.version).zip"
$include = @(
  'screenshots',
  'src',
  'ui',
  'README.md',
  'gsender-plugin.json',
  'index.html',
  'package-lock.json',
  'package.json',
  'vite.config.js'
)

New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
foreach ($item in $include) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination $stagePath -Recurse }
if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stagePath,
  $outputPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
Write-Host "Created $outputPath"
