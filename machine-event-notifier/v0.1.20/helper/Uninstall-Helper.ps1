param([switch]$PurgeData)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""; if ($PurgeData) { $args += ' -PurgeData' }; Start-Process powershell.exe -ArgumentList $args -Verb RunAs; exit }
$appDir = Join-Path $env:ProgramFiles 'Bakstaaj\GSenderMachineEventEmailNotifier'
$nssm = Join-Path $appDir 'runtime\nssm.exe'
if (-not (Test-Path $nssm)) { $nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
function Remove-ManagedService([string]$Name) {
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
  if ($service -and $service.Status -ne 'Stopped') { throw "Service '$Name' with PID $servicePid remained in '$($service.Status)' after force-stop. Restart Windows and retry uninstall." }
  if ($service) { $service.Close() }
  $delete = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\sc.exe') -ArgumentList @('delete',$Name) -NoNewWindow -Wait -PassThru
  if ($delete.ExitCode -ne 0) { throw "Could not remove service '$Name' (sc.exe exit code $($delete.ExitCode))." }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Windows has not released service '$Name' yet. Wait a few seconds, then retry uninstall."
}
foreach ($name in @('GSenderMachineEventMonitor','GSenderMachineEventEmailApi')) {
  Remove-ManagedService $name
}
if ($PurgeData) {
  $data = Join-Path $env:ProgramData 'Bakstaaj\MachineEventEmailNotifier'
  if (Test-Path $data) { Remove-Item -LiteralPath $data -Recurse -Force }
  cmdkey.exe /delete:Bakstaaj.GSender.MachineEventNotifier.v2 | Out-Null
}
Write-Host 'gSender Machine Event Notification services removed.'
if ($PurgeData) { Write-Host 'Service data, logs, pairing material, and credentials removed.' } else { Write-Host 'Stored data and credentials were kept.' }
