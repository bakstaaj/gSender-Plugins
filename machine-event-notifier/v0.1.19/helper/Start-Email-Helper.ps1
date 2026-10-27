$ErrorActionPreference = 'Stop'
$Port = 1985
$Target = 'Bakstaaj.GSender.MachineEventNotifier.v2'
$DataDir = Join-Path $env:ProgramData 'Bakstaaj\MachineEventEmailNotifier'
$MonitorConfigPath = Join-Path $DataDir 'monitor-config.json'
$MonitorStatusPath = Join-Path $DataDir 'monitor-status.json'
$MonitorTokenPath = Join-Path $DataDir 'monitor-token.txt'
$PairCodePath = Join-Path $DataDir 'pair-code.txt'
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

$CredCode = @'
using System;using System.Runtime.InteropServices;public static class GSenderCred{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct CREDENTIAL{public UInt32 Flags;public UInt32 Type;public string TargetName;public string Comment;public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;public UInt32 CredentialBlobSize;public IntPtr CredentialBlob;public UInt32 Persist;public UInt32 AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}[DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredWrite(ref CREDENTIAL c,UInt32 f);[DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredRead(string t,UInt32 ty,UInt32 f,out IntPtr c);[DllImport("advapi32.dll",SetLastError=true)]public static extern void CredFree(IntPtr p);}
'@
Add-Type -TypeDefinition $CredCode
function ConvertTo-Map($Value) { $result = @{}; if ($null -ne $Value) { foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = $property.Value } }; return $result }
function Read-Secret { $pointer = [IntPtr]::Zero; if (-not [GSenderCred]::CredRead($Target, 1, 0, [ref]$pointer)) { return $null }; try { $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][GSenderCred+CREDENTIAL]); $bytes = [byte[]]::new([int]$credential.CredentialBlobSize); [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length); return (ConvertTo-Map ([Text.Encoding]::Unicode.GetString($bytes) | ConvertFrom-Json)) } finally { [GSenderCred]::CredFree($pointer) } }
function Write-Secret($Value) { $bytes = [Text.Encoding]::Unicode.GetBytes(($Value | ConvertTo-Json -Compress -Depth 16)); $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length); try { [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length); $credential = New-Object GSenderCred+CREDENTIAL; $credential.Type = 1; $credential.TargetName = $Target; $credential.UserName = 'gSender SMTP settings'; $credential.CredentialBlob = $pointer; $credential.CredentialBlobSize = [uint32]$bytes.Length; $credential.Persist = 2; if (-not [GSenderCred]::CredWrite([ref]$credential, 0)) { throw 'Credential Manager write failed.' } } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) } }
function New-Token { $bytes = [byte[]]::new(32); $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose(); return [Convert]::ToBase64String($bytes) }
function Ensure-File($Path, $Value) { if (-not (Test-Path -LiteralPath $Path)) { Set-Content -LiteralPath $Path -Value $Value -Encoding UTF8 } }
Ensure-File $MonitorTokenPath (New-Token)
Ensure-File $MonitorConfigPath '{"remoteUrl":"http://127.0.0.1:8000","events":{},"monitorToken":""}'
if (-not (Test-Path -LiteralPath $PairCodePath) -and -not (Read-Secret)) { $random = [byte[]]::new(4); $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($random); $rng.Dispose(); Set-Content -LiteralPath $PairCodePath -Value (100000 + ([BitConverter]::ToUInt32($random, 0) % 900000)) -Encoding ASCII }
function Get-MonitorConfig($Secret) { $monitorToken = (Get-Content -LiteralPath $MonitorTokenPath -Raw).Trim(); $events = if ($Secret.events) { $Secret.events } else { @{ jobEnd=$true; machineAlarm=$true; toolChange=$true; jobStart=$false; pause=$false; resume=$false; disconnect=$false } }; $config = @{ remoteUrl = if ($Secret.remoteUrl) { $Secret.remoteUrl } else { 'http://127.0.0.1:8000' }; events = $events; monitorToken = $monitorToken }; $json = ConvertTo-Json -InputObject $config -Compress -Depth 12; Set-Content -LiteralPath $MonitorConfigPath -Value $json -Encoding UTF8 }
if ($existingSecret = Read-Secret) { if ($existingSecret.token) { Get-MonitorConfig $existingSecret } }
function Send-Json($Stream, [int]$Status, $Object, $Origin) { $json = ConvertTo-Json -InputObject $Object -Compress -Depth 16; $body = if ($Status -eq 204) { [byte[]]::new(0) } else { [Text.Encoding]::UTF8.GetBytes($json) }; $reason = switch ($Status) { 200 {'OK'} 204 {'No Content'} 401 {'Unauthorized'} 404 {'Not Found'} 502 {'Bad Gateway'} default {'Bad Request'} }; $allowOrigin = if ($Origin) { $Origin } else { 'null' }; $crlf = [string][char]13 + [char]10; $headers = @("HTTP/1.1 $Status $reason", 'Content-Type: application/json; charset=utf-8', ('Content-Length: ' + $body.Length), 'Connection: close', ('Access-Control-Allow-Origin: ' + $allowOrigin), 'Vary: Origin', 'Access-Control-Allow-Methods: GET, POST, OPTIONS', 'Access-Control-Allow-Headers: Authorization, Content-Type, X-Monitor-Token', 'Access-Control-Allow-Private-Network: true'); $headerBytes = [Text.Encoding]::ASCII.GetBytes(($headers -join $crlf) + $crlf + $crlf); $Stream.Write($headerBytes, 0, $headerBytes.Length); if ($body.Length) { $Stream.Write($body, 0, $body.Length) }; $Stream.Flush() }
function Read-Request($Stream) { $memory = [IO.MemoryStream]::new(); $byte = [byte[]]::new(1); $delimiter = [byte[]](13,10,13,10); $matched = 0; while ($memory.Length -lt 16384) { $count = $Stream.Read($byte, 0, 1); if ($count -le 0) { throw 'Client disconnected.' }; $memory.WriteByte($byte[0]); if ($byte[0] -eq $delimiter[$matched]) { $matched++ } else { $matched = if ($byte[0] -eq 13) { 1 } else { 0 } }; if ($matched -eq 4) { break } }; $crlf = [string][char]13 + [char]10; $lines = [Text.Encoding]::ASCII.GetString($memory.ToArray()) -split [regex]::Escape($crlf); $first = $lines[0] -split ' '; $headers = @{}; foreach ($line in ($lines | Select-Object -Skip 1)) { if ($line -match '^([^:]+):\s*(.*)$') { $headers[$matches[1].ToLowerInvariant()] = $matches[2] } }; $length = if ($headers.ContainsKey('content-length')) { [int]$headers['content-length'] } else { 0 }; if ($length -gt 1048576) { throw 'Request is too large.' }; $bodyBytes = [byte[]]::new($length); $offset = 0; while ($offset -lt $length) { $count = $Stream.Read($bodyBytes, $offset, $length - $offset); if ($count -le 0) { throw 'Incomplete request body.' }; $offset += $count }; $body = if ($length) { ConvertTo-Map ([Text.Encoding]::UTF8.GetString($bodyBytes) | ConvertFrom-Json) } else { $null }; return @{ method=$first[0]; path=($first[1] -split '\?')[0]; headers=$headers; body=$body } }
function Test-PluginAuth($Request) { $secret = Read-Secret; return ($secret -and $secret.token -and $Request.headers['authorization'] -eq ('Bearer ' + $secret.token)) }
function Add-PayloadText($Value, $Lines) {
  if ($null -eq $Value) { return }
  if ($Value -is [string]) { if ($Value.Length) { $Lines.Add($Value) }; return }
  if ($Value -is [System.Collections.IDictionary]) { $Lines.Add((ConvertTo-Json -InputObject $Value -Compress -Depth 8)); return }
  if ($Value -is [System.Collections.IEnumerable]) { foreach ($item in $Value) { Add-PayloadText $item $Lines }; return }
  $Lines.Add([string]$Value)
}
function Get-EventPayloadText($Event) {
  $payload = $null
  if ($Event.details) { $payload = $Event.details.payload }
  $lines = [Collections.Generic.List[string]]::new()
  Add-PayloadText $payload $lines
  return ($lines -join "`n")
}
function Send-Mail($Config, $Event, [bool]$IsTest) {
  if (-not $Config.host -or -not $Config.from -or -not $Config.to -or -not $Config.username -or -not $Config.password) { throw 'Complete SMTP settings first.' }
  $name = if ($IsTest) { 'Test email' } else { [string]$Event.event }
  $subject = '[gSender] ' + $name
  $body = if ($IsTest) { 'Test message from Machine Event Email Notifier.' } else { Get-EventPayloadText $Event }
  $message = [Net.Mail.MailMessage]::new($Config.from, $Config.to, $subject, [string]$body)
  $smtp = [Net.Mail.SmtpClient]::new($Config.host, [int]$Config.port)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $smtp.EnableSsl = ($Config.tls -eq 'starttls')
  $smtp.UseDefaultCredentials = $false
  $smtp.Credentials = [Net.NetworkCredential]::new($Config.username, $Config.password)
  try { $smtp.Send($message) } finally { $message.Dispose(); $smtp.Dispose() }
}
function Send-Ntfy($Config, $Event, [bool]$IsTest) {
  if (-not $Config.ntfyEnabled) { throw 'ntfy notifications are disabled.' }
  if (-not $Config.ntfyServer -or ([string]$Config.ntfyServer -notmatch '^https://')) { throw 'ntfy server must be an HTTPS URL.' }
  if (-not $Config.ntfyTopic -or ([string]$Config.ntfyTopic -notmatch '^[A-Za-z0-9_-]{1,64}$')) { throw 'ntfy topic must be 1–64 letters, numbers, underscores, or hyphens.' }
  $server = ([string]$Config.ntfyServer).TrimEnd('/')
  $name = if ($IsTest) { 'Test notification' } else { [string]$Event.event }
  $message = if ($IsTest) { 'Test push from gSender Machine Event Notifications. If this appears, the ntfy app subscription is working.' } else { Get-EventPayloadText $Event }
  if ($message.Length -gt 1800) { $message = $message.Substring(0, 1800) + '…' }
  $priority = if (-not $IsTest -and [string]$Event.event -match 'alarm|disconnect') { 5 } else { 3 }
  $tags = if ($priority -eq 5) { @('warning') } else { @('gear') }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ Title=('[gSender] ' + $name); Priority=[string]$priority; Tags=($tags -join ',') }
  try {
    $null = Invoke-WebRequest -Uri ($server + '/' + [string]$Config.ntfyTopic) -Method Post -Headers $headers -ContentType 'text/plain; charset=utf-8' -Body $message -TimeoutSec 15 -UseBasicParsing
  } catch {
    $response = $_.Exception.Response
    if ($response) {
      $reader = $null
      try { $reader = [IO.StreamReader]::new($response.GetResponseStream()); $responseText = $reader.ReadToEnd() } catch { $responseText = '' } finally { if ($reader) { $reader.Dispose() } }
      if ($responseText) { throw ('ntfy returned HTTP ' + [int]$response.StatusCode + ': ' + $responseText) }
    }
    throw ('ntfy request failed: ' + $_.Exception.Message)
  }
}
function Send-Notifications($Config, $Event, [bool]$IsTest) {
  $channels = @{ email='disabled'; ntfy='disabled' }
  $emailConfigured = $Config.from -and $Config.to -and $Config.username -and $Config.password
  $ntfyConfigured = [bool]$Config.ntfyEnabled
  if ($emailConfigured) { try { Send-Mail $Config $Event $IsTest; $channels.email='sent' } catch { $channels.email='failed: ' + $_.Exception.Message } }
  if ($ntfyConfigured) { try { Send-Ntfy $Config $Event $IsTest; $channels.ntfy='sent' } catch { $channels.ntfy='failed: ' + $_.Exception.Message } }
  if ($channels.email -ne 'sent' -and $channels.ntfy -ne 'sent') {
    if (-not $emailConfigured -and -not $ntfyConfigured) { throw 'No notification channel is configured. Configure SMTP email or enable ntfy.' }
    $failures = @(); if ($channels.email -like 'failed:*') { $failures += 'Email ' + $channels.email.Substring(8) }; if ($channels.ntfy -like 'failed:*') { $failures += 'ntfy ' + $channels.ntfy.Substring(8) }
    throw ($failures -join ' | ')
  }
  $sent = @(); if ($channels.email -eq 'sent') { $sent += 'email' }; if ($channels.ntfy -eq 'sent') { $sent += 'ntfy' }
  $message = 'Alert delivered by ' + ($sent -join ' and ') + '.'
  $partial = @(); if ($channels.email -like 'failed:*') { $partial += 'Email delivery failed: ' + $channels.email.Substring(8) }; if ($channels.ntfy -like 'failed:*') { $partial += 'ntfy delivery failed: ' + $channels.ntfy.Substring(8) }
  if ($partial.Count) { $message += ' ' + ($partial -join ' ') }
  return @{ ok=$true; channels=$channels; message=$message }
}
function Read-SmtpLine($Stream) { $memory = [IO.MemoryStream]::new(); $byte = [byte[]]::new(1); while ($true) { $count = $Stream.Read($byte, 0, 1); if ($count -le 0) { throw 'SMTP server closed the connection while replying.' }; if ($byte[0] -eq 10) { break }; if ($byte[0] -ne 13) { $memory.WriteByte($byte[0]) } }; return [Text.Encoding]::ASCII.GetString($memory.ToArray()) }
function Send-SmtpCommand($Stream, $Text) { $line = [Text.Encoding]::ASCII.GetBytes($Text); $bytes = [byte[]]::new($line.Length + 2); [Array]::Copy($line, $bytes, $line.Length); $bytes[$line.Length] = 13; $bytes[$line.Length + 1] = 10; $Stream.Write($bytes, 0, $bytes.Length); $Stream.Flush(); $replies = [Collections.Generic.List[string]]::new(); do { $reply = Read-SmtpLine $Stream; $replies.Add($reply) } while ($reply -match '^\d{3}-'); return ,$replies.ToArray() }
function Test-SmtpAuth($Config) { $tcp = [Net.Sockets.TcpClient]::new(); $ssl = $null; try { $tcp.Connect([string]$Config.host, [int]$Config.port); $net = $tcp.GetStream(); $greeting = Read-SmtpLine $net; if ($greeting -notmatch '^220') { throw ('SMTP greeting was unexpected: ' + $greeting) }; $ehlo = Send-SmtpCommand $net 'EHLO localhost'; if ($ehlo[-1] -notmatch '^250') { throw ('EHLO failed: ' + ($ehlo -join ' | ')) }; if (-not (($ehlo -join ' ') -match 'STARTTLS')) { throw 'The SMTP server did not advertise STARTTLS.' }; $tlsReply = Send-SmtpCommand $net 'STARTTLS'; if ($tlsReply[-1] -notmatch '^220') { throw ('STARTTLS was rejected: ' + ($tlsReply -join ' | ')) }; $ssl = [Net.Security.SslStream]::new($net, $false); $ssl.AuthenticateAsClient([string]$Config.host); $ehloTls = Send-SmtpCommand $ssl 'EHLO localhost'; if ($ehloTls[-1] -notmatch '^250') { throw ('EHLO after TLS failed: ' + ($ehloTls -join ' | ')) }; $capabilities = $ehloTls -join ' '; if ($capabilities -notmatch 'AUTH(?:=|\s)') { throw ('SMTP server did not advertise authentication after TLS: ' + $capabilities) }; $plain = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(([string][char]0 + [string]$Config.username + [string][char]0 + [string]$Config.password))); $auth = Send-SmtpCommand $ssl ('AUTH PLAIN ' + $plain); $code = $auth[-1].Substring(0, 3); if ($code -eq '235') { $null = Send-SmtpCommand $ssl 'QUIT'; return 'SMTP authentication accepted.' }; if ($code -in @('500','501','502','504')) { $login = Send-SmtpCommand $ssl 'AUTH LOGIN'; if ($login[-1] -notmatch '^334') { throw ('SMTP AUTH LOGIN was rejected: ' + ($login -join ' | ')) }; $user = Send-SmtpCommand $ssl ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$Config.username))); if ($user[-1] -notmatch '^334') { throw ('SMTP username was rejected: ' + ($user -join ' | ')) }; $pass = Send-SmtpCommand $ssl ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$Config.password))); if ($pass[-1] -match '^235') { $null = Send-SmtpCommand $ssl 'QUIT'; return 'SMTP authentication accepted using LOGIN.' }; $auth = $pass }; if ($auth[-1] -match '^535' -and [string]$Config.host -eq 'smtp.gmail.com') { throw ('Gmail rejected SMTP authentication: ' + $auth[-1] + ' Use the full Gmail address and, when required, a Google App Password. The password is never printed by this check.') }; throw ('SMTP authentication failed: ' + ($auth -join ' | ')) } finally { if ($ssl) { $ssl.Dispose() }; $tcp.Close() } }

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Output "gSender Machine Event Email Helper API listening at http://127.0.0.1:$Port"
while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient(); $client.ReceiveTimeout = 10000; $client.SendTimeout = 10000; $stream = $client.GetStream(); $request = Read-Request $stream; $origin = $request.headers['origin']
    if ($request.method -eq 'OPTIONS') { Send-Json $stream 204 @{} $origin; continue }
    if ($request.path -eq '/api/status' -and $request.method -eq 'GET') { Send-Json $stream 200 @{ ok=$true; version='0.1.17'; service='windows' } $origin; continue }
    if ($request.path -eq '/api/pair' -and $request.method -eq 'POST') {
      if (-not (Test-Path -LiteralPath $PairCodePath) -or [string]$request.body.code -ne (Get-Content -LiteralPath $PairCodePath -Raw).Trim()) { Send-Json $stream 401 @{ error='Pairing code is wrong, expired, or already used.' } $origin; continue }
      $saved = Read-Secret; if (-not $saved) { $saved = @{} }; $saved.token = New-Token; Write-Secret $saved; Remove-Item -LiteralPath $PairCodePath -Force; Get-MonitorConfig $saved; Send-Json $stream 200 @{ token=$saved.token; paired=$true } $origin; continue
    }
    if ($request.path -eq '/api/monitor-event' -and $request.method -eq 'POST') {
      $expected = (Get-Content -LiteralPath $MonitorTokenPath -Raw).Trim()
      if (-not $expected -or $request.headers['x-monitor-token'] -ne $expected) { Send-Json $stream 401 @{ error='Event monitor authentication failed.' } $null; continue }
      $saved = Read-Secret
      $delivery = Send-Notifications $saved $request.body $false
      Send-Json $stream 200 $delivery $null
      continue
    }
    if (-not (Test-PluginAuth $request)) { Send-Json $stream 401 @{ error='Plugin is not paired. Enter the pairing code shown by the installer.' } $origin; continue }
    $saved = Read-Secret
    if ($request.path -eq '/api/generate-topic' -and $request.method -eq 'POST') {
      $remoteUrl = if ($request.body.remoteUrl) { [string]$request.body.remoteUrl } else { [string]$saved.remoteUrl }
      $address = $null
      try {
        if ($remoteUrl) {
          $uri = [Uri]$remoteUrl
          $candidate = [Net.IPAddress]::Parse($uri.Host)
          if ($candidate.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and -not [Net.IPAddress]::IsLoopback($candidate)) { $address = $candidate }
        }
      } catch { }
      if (-not $address) {
        $udp = $null
        try { $udp = [Net.Sockets.UdpClient]::new(); $udp.Connect([Net.IPAddress]::Parse('192.0.2.1'), 9); $address = $udp.Client.LocalEndPoint.Address } catch { } finally { if ($udp) { $udp.Dispose() } }
      }
      if (-not $address) {
        try { $address = [Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and -not [Net.IPAddress]::IsLoopback($_) -and $_.ToString() -notlike '169.254.*' } | Select-Object -First 1 } catch { }
      }
      if (-not $address) { throw 'Could not determine the LAN IPv4 address. Set the gSender Wireless Control address to this computer LAN IP, then try again.' }
      $hostName = [Environment]::MachineName.ToUpperInvariant() -replace '[^A-Z0-9_-]', '-'
      $suffix = $address.GetAddressBytes()[3]
      $topic = "gSender-$hostName-$suffix"
      $hostLimit = 64 - ("gSender--$suffix").Length
      if ($hostName.Length -gt $hostLimit) { $hostName = $hostName.Substring(0, $hostLimit); $topic = "gSender-$hostName-$suffix" }
      Send-Json $stream 200 @{ topic=$topic; hostName=$hostName; address=$address.ToString() } $origin
      continue
    }
    if ($request.path -eq '/api/open-app-password' -and $request.method -eq 'POST') { Send-Json $stream 400 @{ error='Windows services cannot open a browser on the desktop. Open https://myaccount.google.com/apppasswords from the plugin link.' } $origin; continue }
    if ($request.path -eq '/api/config' -and $request.method -eq 'GET') { $safe = @{}; foreach ($key in @('host','port','tls','from','to','username','remoteUrl','events','ntfyEnabled','ntfyServer','ntfyTopic')) { if ($saved.ContainsKey($key)) { $safe[$key] = $saved[$key] } }; if (-not $safe.remoteUrl) { $safe.remoteUrl = 'http://127.0.0.1:8000' }; if (-not $safe.ntfyServer) { $safe.ntfyServer = 'https://ntfy.sh' }; $safe.hasPassword = [bool]$saved.password; Send-Json $stream 200 $safe $origin; continue }
    if ($request.path -eq '/api/config' -and $request.method -eq 'POST') { foreach ($key in @('host','port','tls','from','to','username','remoteUrl','events','ntfyEnabled','ntfyServer','ntfyTopic')) { if ($request.body.ContainsKey($key)) { $saved[$key] = $request.body[$key] } }; if ($request.body.password) { $saved.password = $request.body.password }; Write-Secret $saved; Get-MonitorConfig $saved; Send-Json $stream 200 @{ ok=$true; hasPassword=[bool]$saved.password } $origin; continue }
    if ($request.path -eq '/api/monitor-status' -and $request.method -eq 'GET') { $status = if (Test-Path -LiteralPath $MonitorStatusPath) { Get-Content -LiteralPath $MonitorStatusPath -Raw | ConvertFrom-Json } else { @{ remoteConnected=$false; message='The event monitor has not started yet.' } }; Send-Json $stream 200 $status $origin; continue }
    if ($request.path -eq '/api/test' -and $request.method -eq 'POST') { if (-not $saved.host -or -not $saved.from -or -not $saved.to -or -not $saved.username -or -not $saved.password) { throw 'Complete SMTP settings first.' }; Test-SmtpAuth $saved | Out-Null; Send-Mail $saved $request.body $true; Send-Json $stream 200 @{ ok=$true; message='Test email delivered.' } $origin; continue }
    if ($request.path -eq '/api/test-ntfy' -and $request.method -eq 'POST') { Send-Ntfy $saved @{ event='Test notification' } $true; Send-Json $stream 200 @{ ok=$true; message='Test push sent. Check the ntfy app subscription.' } $origin; continue }
    Send-Json $stream 404 @{ error='Unknown API endpoint.' } $origin
  } catch {
    # Preserve the requesting plugin origin on API failures so fetch can read
    # the helper's diagnostic instead of reducing it to a generic CORS error.
    if ($client -and $client.Connected) { try { Send-Json $client.GetStream() 502 @{ error=$_.Exception.Message } $origin } catch { } }
    Write-Error $_.Exception.Message
  } finally { if ($client) { $client.Close() } }
}
