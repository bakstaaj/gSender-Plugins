$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$manifest=Get-Content (Join-Path $root 'gsender-plugin.json') -Raw | ConvertFrom-Json
if(-not (Test-Path (Join-Path $root 'ui/index.html'))){throw 'Built UI not found. Run npm run build first.'}
$out=Join-Path $root "machine-event-email-notifier-v$($manifest.version).zip"
if(Test-Path -LiteralPath $out){Remove-Item -LiteralPath $out -Force}
Compress-Archive -Path (Join-Path $root 'gsender-plugin.json'),(Join-Path $root 'README.md'),(Join-Path $root 'screenshots'),(Join-Path $root 'ui') -DestinationPath $out
Write-Output "Created $out"
