# Self-contained x64 Windows installer. Uses Windows PowerShell 5.1 already included with Windows.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer is for Windows.' }
$runtime = Join-Path $PSScriptRoot 'runtime'
$nssm = Join-Path $runtime 'nssm.exe'
$node = Join-Path $runtime 'node.exe'
if (-not (Test-Path $nssm)) { throw "Bundled NSSM executable not found: $nssm" }
if (-not (Test-Path $node)) { throw "Bundled Node.js executable not found: $node" }
if (-not (Test-Path (Join-Path $PSScriptRoot 'monitor\node_modules\socket.io-client'))) { throw 'Bundled event monitor dependencies are missing. Rebuild the helper ZIP.' }
$nodeVersion = (& $node --version).Trim().TrimStart('v').Split('.')[0]
if ([int]$nodeVersion -lt 20) { throw 'The bundled Node.js runtime is too old.' }
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $powershell)) { throw 'Windows PowerShell 5.1 was not found. This package supports Windows 10 and newer.' }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs
  exit
}

$destination = Join-Path $env:ProgramFiles 'Bakstaaj\GSenderMachineEventEmailNotifier'
$data = Join-Path $env:ProgramData 'Bakstaaj\MachineEventEmailNotifier'
New-Item -ItemType Directory -Path $destination,$data -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $destination -Recurse -Force
$nssm = Join-Path $destination 'runtime\nssm.exe'
$node = Join-Path $destination 'runtime\node.exe'
function Remove-ExistingService([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) { return }
  if ($service.Status -ne 'Stopped') {
    # Stop-Service waits synchronously for STOP_PENDING to finish, so a hung
    # NSSM service would block before our PID timeout can run. sc.exe returns
    # after issuing the stop control; the bounded loop below owns the timeout.
    & (Join-Path $env:WINDIR 'System32\sc.exe') stop $Name | Out-Null
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 500
      $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    } while ($service -and $service.Status -ne 'Stopped' -and (Get-Date) -lt $deadline)
  }
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') {
    $svcInfo = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    $servicePid = if ($svcInfo) { [int]$svcInfo.ProcessId } else { 0 }
    if ($servicePid -le 0) { throw "Service '$Name' is still stopping, but Windows did not report its process ID. Restart Windows or stop it manually in Services." }
    $root = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid" -ErrorAction SilentlyContinue
    $expectedNssm = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'Bakstaaj\GSenderMachineEventEmailNotifier\runtime\nssm.exe'))
    $actualPath = if ($root.ExecutablePath) { [IO.Path]::GetFullPath($root.ExecutablePath) } else { '' }
    $serviceBinary = if ($svcInfo.PathName -match '^"([^"]+)"') { [IO.Path]::GetFullPath($matches[1]) } else { '' }
    if (-not $root -or $root.Name -ne 'nssm.exe' -or $serviceBinary -ine $expectedNssm -or ($actualPath -and $actualPath -ine $expectedNssm)) { throw "Service '$Name' is stuck with PID $servicePid, but its service/process identity did not match the installed helper NSSM. No process was killed. Check it in Task Manager or Services." }

    Write-Warning "Service '$Name' did not stop normally. Force-stopping helper process tree rooted at PID $servicePid."
    $currentSvc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
    if ($currentSvc -and [int]$currentSvc.ProcessId -eq $servicePid) {
      & (Join-Path $env:WINDIR 'System32\taskkill.exe') /F /T /PID $servicePid
      if ($LASTEXITCODE -ne 0) { Write-Warning "taskkill reported exit code $LASTEXITCODE for helper PID $servicePid; checking service state." }
    }
    $deadline = (Get-Date).AddSeconds(15)
    do { Start-Sleep -Milliseconds 500; $service = Get-Service -Name $Name -ErrorAction SilentlyContinue } while ($service -and $service.Status -ne 'Stopped' -and (Get-Date) -lt $deadline)
  }
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') { throw "Service '$Name' with PID $servicePid remained in '$($service.Status)' after force-stop. Restart Windows and retry the installer." }
  if ($service) { $service.Close() }
  $delete = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\sc.exe') -ArgumentList @('delete',$Name) -NoNewWindow -Wait -PassThru
  if ($delete.ExitCode -ne 0) { throw "Could not remove existing service '$Name' (sc.exe exit code $($delete.ExitCode))." }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Windows has not released the old service '$Name' yet. Wait a few seconds, then run the installer again."
}
$services = @(
  # Keep AppParameters paths relative to AppDirectory. This avoids PowerShell
  # native-argument quoting differences that otherwise split paths at spaces
  # such as "C:\Program Files" when NSSM is configured from PowerShell.
  @{ Name='GSenderMachineEventEmailApi'; Display='gSender Machine Event Email API'; App=$powershell; Args='-NoLogo -NoProfile -ExecutionPolicy Bypass -File Start-Email-Helper.ps1'; Directory=$destination; Out='email-api.log' },
  @{ Name='GSenderMachineEventMonitor'; Display='gSender Machine Event Monitor'; App=$node; Args='monitor.js'; Directory=(Join-Path $destination 'monitor'); Out='event-monitor.log' }
)
foreach ($service in $services) {
  Remove-ExistingService $service.Name
  & $nssm install $service.Name $service.App | Out-Null
  & $nssm set $service.Name AppParameters $service.Args | Out-Null
  & $nssm set $service.Name DisplayName $service.Display | Out-Null
  & $nssm set $service.Name AppDirectory $service.Directory | Out-Null
  & $nssm set $service.Name AppStdout (Join-Path $data $service.Out) | Out-Null
  & $nssm set $service.Name AppStderr (Join-Path $data $service.Out) | Out-Null
  & $nssm set $service.Name AppRotateFiles 1 | Out-Null
  & $nssm set $service.Name AppRotateOnline 1 | Out-Null
  & $nssm set $service.Name AppRestartDelay 5000 | Out-Null
  & $nssm set $service.Name AppNoConsole 1 | Out-Null
  & $nssm set $service.Name Start SERVICE_AUTO_START | Out-Null
  & $nssm set $service.Name ObjectName LocalSystem | Out-Null
}
if (-not (Test-Path (Join-Path $data 'pair-code.txt'))) {
  $bytes = New-Object byte[] 4; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  Set-Content -LiteralPath (Join-Path $data 'pair-code.txt') -Value (100000 + ([BitConverter]::ToUInt32($bytes,0) % 900000)) -Encoding ASCII
}
icacls $data /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
foreach ($service in $services) { Start-Service -Name $service.Name }
$apiReady = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1:1985/api/status' -UseBasicParsing -TimeoutSec 2
    if ($health.StatusCode -eq 200) { $apiReady = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $apiReady) {
  $logPath = Join-Path $data 'email-api.log'
  $logTail = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Tail 12) -join [Environment]::NewLine } else { 'No API log was created.' }
  throw "The helper services were installed, but the local API did not start on 127.0.0.1:1985. Check $logPath`n$logTail"
}
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$shortcutPath = Join-Path $desktop 'gSender Email Helper Status.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath); $shortcut.TargetPath = 'C:\Windows\System32\services.msc'; $shortcut.Description = 'View gSender Machine Event Email services'; $shortcut.Save()
$pairCode = (Get-Content -LiteralPath (Join-Path $data 'pair-code.txt') -Raw).Trim()
Write-Host 'Installed and started the gSender notification API and background event monitor services.' -ForegroundColor Green
Write-Host "Pairing code: $pairCode" -ForegroundColor Yellow
Write-Host 'Enter this code in the Machine Event Notifications plugin. The code is one time use.'
Write-Host "Service logs: $data"
