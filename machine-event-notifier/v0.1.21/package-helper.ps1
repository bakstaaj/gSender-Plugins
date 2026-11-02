$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$manifest=Get-Content (Join-Path $root 'gsender-plugin.json') -Raw | ConvertFrom-Json
$monitor=Join-Path $root 'helper\monitor'
foreach($required in @('node_modules\socket.io-client','..\runtime\node.exe','..\runtime\nssm.exe')){if(-not (Test-Path (Join-Path $monitor $required))){throw "Required self-contained helper file is missing: $required"}}
$pluginZip=Join-Path $root "machine-event-email-notifier-v$($manifest.version).zip"
if(-not (Test-Path -LiteralPath $pluginZip)){throw "Plugin ZIP is missing: $pluginZip. Run package-plugin.ps1 first."}
$out=Join-Path $root "machine-event-email-helper-v$($manifest.version).zip"
$stage=Join-Path ([IO.Path]::GetTempPath()) ("MachineEventEmailNotifier-"+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  Copy-Item -Path (Join-Path $root 'helper\*') -Destination $stage -Recurse
  Copy-Item -LiteralPath $pluginZip -Destination $stage
  Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $stage
  Copy-Item -Path (Join-Path $root 'screenshots') -Destination $stage -Recurse
  if(Test-Path -LiteralPath $out){Remove-Item -LiteralPath $out -Force}
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
Write-Output "Created single release package $out with helper, plugin ZIP, README, and screenshots."