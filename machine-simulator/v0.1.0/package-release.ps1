$ErrorActionPreference = 'Stop'
$version = '0.1.0'
$releaseFolder = "gSender-Machine-Simulator-v$version"
$releaseDir = Join-Path $env:TEMP $releaseFolder
$zipPath = Join-Path $PSScriptRoot "$releaseFolder.zip"
$hashPath = "$zipPath.sha256"

if (Test-Path $releaseDir) { Remove-Item -LiteralPath $releaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Get-ChildItem -LiteralPath $PSScriptRoot -Force | Where-Object { $_.Name -notin @("$releaseFolder.zip","$releaseFolder.zip.sha256") } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $releaseDir -Recurse -Force
}
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path $releaseDir -DestinationPath $zipPath -CompressionLevel Optimal
$digest = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $hashPath -Value "$digest  $releaseFolder.zip" -Encoding ascii
Write-Host "Created $zipPath"
Write-Host "SHA-256 $digest"
