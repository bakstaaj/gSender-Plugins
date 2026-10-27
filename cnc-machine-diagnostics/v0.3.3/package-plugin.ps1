$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$output = Join-Path $project "cnc-machine-diagnostics-v$($package.version).zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "cnc-machine-diagnostics-$([guid]::NewGuid().ToString('N'))"
$include = @('ui', 'src', 'screenshots', 'README.md', 'gsender-plugin.json', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js')

Push-Location $project
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }

New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($item in $include) {
  $source = Join-Path $project $item
  if (-not (Test-Path -LiteralPath $source)) { throw "Package input missing: $item" }
  Copy-Item -LiteralPath $source -Destination $stage -Recurse
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $output, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host "Created $output"
