param(
  [Parameter(Mandatory=$true)][ValidateSet('Start','Crash')][string]$Action,
  [ValidateSet('before','after')][string]$Phase = 'before',
  [ValidatePattern('^[a-z0-9]+$')][string]$Run = '20260919a'
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$testRoot = Join-Path $repoRoot '.t03-local\tt-367b0c7'
$exe = Join-Path $testRoot 'tauritavern.exe'
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne '11A9BC110DA5DC634FF8C0B7B8FE244110C360AF46693E50DE67968CB811F2C4') { throw 'Unexpected executable' }
if (!(Test-Path -LiteralPath (Join-Path $testRoot 'portable.flag')) -or
    (Test-Path -LiteralPath (Join-Path $testRoot 'tauritavern-runtime.json'))) { throw 'Unexpected runtime configuration' }
$instances = @(Get-CimInstance Win32_Process -Filter "Name='tauritavern.exe'")
if ($Action -eq 'Start') {
  if ($instances.Count -ne 0) { throw 'An existing TT instance must be closed normally first' }
  $env:TAURITAVERN_RUNTIME_MODE = 'portable'
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $testRoot 'webview-profile'
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = ''
  $testProcess = Start-Process -FilePath $exe -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru
  [pscustomobject]@{Action='Start';PID=$testProcess.Id;Executable=$exe;DataRoot=(Join-Path $testRoot 'data')} | ConvertTo-Json
} else {
  if ($instances.Count -ne 1 -or $instances[0].ExecutablePath -ne $exe) { throw 'Not exactly the isolated executable; refusing kill' }
  $evidencePath = Join-Path $repoRoot ".t03-local\evidence\$Run-$Phase.json"
  $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
  $boundary = $evidence.events[-1]
  if ($boundary.type -ne 'kill-ready' -or $boundary.phase -ne $Phase -or
      $boundary.namespace -ne "mnemo-t03-$Run-crash-$Phase") { throw 'No matching armed fault boundary' }
  $testProcess = Get-Process -Id $instances[0].ProcessId
  if ((Get-Item -LiteralPath $evidencePath).LastWriteTime -lt $testProcess.StartTime) { throw 'Stale fault evidence' }
  $proof = [pscustomobject]@{Action='Crash';PID=$testProcess.Id;Executable=$exe;DataRoot=(Join-Path $testRoot 'data');Phase=$Phase;Boundary=$boundary;At=[DateTime]::UtcNow.ToString('o')}
  $proof | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $repoRoot ".t03-local\evidence\$Run-$Phase-process.json") -Encoding utf8
  Stop-Process -Id $testProcess.Id -Force
  $proof | ConvertTo-Json -Depth 15
}
