param(
  [Parameter(Mandatory=$true)][ValidateSet('p3-recovery','recover-p3-before','recover-p3-after','paged-reopen-check','paged-roundtrip','recover-paged-before','recover-paged-after','p4-resource','p5-diagnostics')][string]$Phase,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9]+$')][string]$Run
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$testRoot = Join-Path $repoRoot '.t03-local\tt-367b0c7'
$exe = Join-Path $testRoot 'tauritavern.exe'
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne '11A9BC110DA5DC634FF8C0B7B8FE244110C360AF46693E50DE67968CB811F2C4') { throw 'Unexpected executable' }
$instances = @(Get-CimInstance Win32_Process -Filter "Name='tauritavern.exe'")
if ($instances.Count -ne 1 -or $instances[0].ExecutablePath -ne $exe) { throw 'Not exactly the isolated process' }
$evidencePath = Join-Path $repoRoot ".t03-local\evidence\$Run-$Phase.json"
$evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
$last = $evidence.events[-1]
if ($last.type -ne 'done' -or $last.phase -ne $Phase -or $evidence.run -ne $Run) { throw 'No matching completed test' }
$namespaces = if ($last.namespaces) { @($last.namespaces) } else { @($last.namespace) }
$invalidNamespaces = if ($Phase -eq 'p4-resource') {
  @($namespaces | Where-Object {
    !$_.StartsWith("mnemo-t03-paged-$Run-") -and !$_.StartsWith("mnemo-t03-index-$Run-")
  })
} else {
  $expectedPrefix = if ($Phase.Contains('paged') -or $Phase -eq 'p5-diagnostics') { "mnemo-t03-paged-$Run-" } else { "mnemo-t03-p3-$Run-" }
  @($namespaces | Where-Object { !$_.StartsWith($expectedPrefix) })
}
if ($namespaces.Count -eq 0 -or $invalidNamespaces.Count -ne 0) { throw 'Unexpected namespace evidence' }
$process = Get-Process -Id $instances[0].ProcessId
if ((Get-Item -LiteralPath $evidencePath).LastWriteTime -lt $process.StartTime) { throw 'Stale completion evidence' }
$requested = $process.CloseMainWindow()
$exited = $process.WaitForExit(3000)
if (!$exited) { Stop-Process -Id $process.Id -Force }
$proof = [pscustomobject]@{ Action='Completed-test cleanup, not fault evidence'; PID=$process.Id; Executable=$exe; DataRoot=(Join-Path $testRoot 'data'); Phase=$Phase; Namespaces=$namespaces; NormalCloseRequested=$requested; ForceRequired=(!$exited); At=[DateTime]::UtcNow.ToString('o') }
$proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $repoRoot ".t03-local\evidence\$Run-$Phase-exit.json") -Encoding utf8
$proof | ConvertTo-Json -Depth 8
