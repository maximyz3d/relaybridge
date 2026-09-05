[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('relaybridge-mcp-install-test-' + [Guid]::NewGuid().ToString('N'))
$bridgeRoot = Join-Path $testRoot 'RelayBridge'
$bridgeRootB = Join-Path $testRoot 'RelayBridge-B'
$profileRoot = Join-Path $testRoot 'profile'
$fakeBin = Join-Path $testRoot 'bin'
$codexConfig = Join-Path $profileRoot '.codex\config.toml'
$claudeConfig = Join-Path $profileRoot '.claude.json'
$tokenFile = Join-Path $bridgeRoot '.bridge-token'
$tokenFileB = Join-Path $bridgeRootB '.bridge-token'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Get-FreePort {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Test-LocalPortInUse([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false }
  finally { $client.Dispose() }
}

function Test-ProcessRunning([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return (-not $process.HasExited)
  } catch { return $false }
}

function Wait-ForPath([string]$Path, [int]$TimeoutMilliseconds) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return $false
}

function New-InstallerChildCommand([string]$InstallerPath, [string]$StartedPath, [string]$ResultPath, [string]$WaitingPath) {
  $installerLiteral = $InstallerPath.Replace("'", "''")
  $startedLiteral = $StartedPath.Replace("'", "''")
  $resultLiteral = $ResultPath.Replace("'", "''")
  $waitingLiteral = $WaitingPath.Replace("'", "''")
  $scriptText = @"
`$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText('$startedLiteral', 'started', [Text.UTF8Encoding]::new(`$false))
try {
  & '$installerLiteral' 6>&1 | ForEach-Object {
    `$childLine = (`$_ | Out-String)
    [Console]::Out.Write(`$childLine)
    if ('$waitingLiteral' -and `$childLine -match 'Another MCP registration is active') {
      [IO.File]::WriteAllText('$waitingLiteral', 'waiting', [Text.UTF8Encoding]::new(`$false))
    }
  }
  [IO.File]::WriteAllText('$resultLiteral', 'success', [Text.UTF8Encoding]::new(`$false))
  exit 0
} catch {
  [IO.File]::WriteAllText('$resultLiteral', (`$_ | Out-String), [Text.UTF8Encoding]::new(`$false))
  exit 41
}
"@
  return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))
}

function Reset-Configs {
  $codex = @'
[mcp_servers.ps_bridge]
command = "node"
args = ["C:\legacy\RelayBridge\mcp\server.mjs"]

[mcp_servers.ps-bridge]
command = "node"
args = ["C:\other\server.js"]

[mcp_servers.unrelated]
command = "unrelated"
args = []
'@
  [IO.File]::WriteAllText($codexConfig, ($codex.Trim() + "`n"), [Text.UTF8Encoding]::new($false))
  $claude = [ordered]@{ mcpServers = [ordered]@{
    ps_bridge = [ordered]@{ type = 'stdio'; command = 'node'; args = @('C:\legacy\RelayBridge\mcp\server.mjs') }
    'ps-bridge' = [ordered]@{ type = 'stdio'; command = 'node'; args = @('C:\other\server.js') }
    unrelated = [ordered]@{ type = 'stdio'; command = 'unrelated'; args = @() }
  } }
  [IO.File]::WriteAllText($claudeConfig, (($claude | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Path (Join-Path $bridgeRoot 'mcp'), (Join-Path $bridgeRoot 'config'), `
  (Join-Path $bridgeRoot 'lib'), (Join-Path $bridgeRoot 'tools'),
  (Join-Path $bridgeRoot 'node_modules\express'), (Split-Path -Parent $codexConfig), $fakeBin -Force | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $repoRoot 'install-mcp.ps1') -Destination (Join-Path $bridgeRoot 'install-mcp.ps1')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'start.ps1') -Destination (Join-Path $bridgeRoot 'start.ps1')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'config\timeout-policy.json') -Destination (Join-Path $bridgeRoot 'config\timeout-policy.json')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\build-identity.cjs') -Destination (Join-Path $bridgeRoot 'lib\build-identity.cjs')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\github-tracker.js') -Destination (Join-Path $bridgeRoot 'lib\github-tracker.js')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'tools\prepare-build-info.cjs') -Destination (Join-Path $bridgeRoot 'tools\prepare-build-info.cjs')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination (Join-Path $bridgeRoot 'package.json')
  [IO.File]::WriteAllText((Join-Path $bridgeRoot 'mcp\server.mjs'), "// fake MCP entrypoint`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $bridgeRoot 'server.js'), "require('fs').writeFileSync('server-started.marker', 'unexpected');`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $bridgeRoot 'node_modules\express\package.json'), "{}`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $bridgeRoot '.gitignore'), "node_modules/`nbuild-info.json`n.build-info.*.tmp`n.bridge-token`n.mcp-install.lock/`n", [Text.UTF8Encoding]::new($false))
  & git.exe -C $bridgeRoot init -q
  & git.exe -C $bridgeRoot config user.email 'relaybridge-test@example.invalid'
  & git.exe -C $bridgeRoot config user.name 'RelayBridge Test'
  & git.exe -C $bridgeRoot add .
  & git.exe -C $bridgeRoot commit -qm fixture
  if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the Windows source-identity fixture.' }
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $fakeClient = Join-Path $fakeBin 'fake-mcp-client.js'
  Copy-Item -LiteralPath (Join-Path $repoRoot 'test\fake-mcp-client.js') -Destination $fakeClient
  $fakeClientWrapper = Join-Path $fakeBin 'race-aware-mcp-client.js'
  $fakeClientWrapperSource = @'
'use strict';
const fs = require('fs');
const [, , client, ...args] = process.argv;
if (process.env.RELAYBRIDGE_FAKE_MCP_RACE_ROLE === 'A' && client === 'claude' && args[1] === 'add') {
  const pausedPath = process.env.RELAYBRIDGE_FAKE_MCP_RACE_PAUSED;
  const releasePath = process.env.RELAYBRIDGE_FAKE_MCP_RACE_RELEASE;
  if (!pausedPath || !releasePath) process.exit(18);
  fs.writeFileSync(pausedPath, String(process.pid));
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(releasePath) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 25);
  process.exit(fs.existsSync(releasePath) ? 17 : 19);
}
require('./fake-mcp-client.js');
'@
  [IO.File]::WriteAllText($fakeClientWrapper, ($fakeClientWrapperSource + "`n"), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $fakeBin 'codex.cmd'), "@echo off`r`ncd /d `"%~dp0`"`r`n`"$nodePath`" `"$fakeClientWrapper`" codex %*`r`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $fakeBin 'claude.cmd'), "@echo off`r`ncd /d `"%~dp0`"`r`n`"$nodePath`" `"$fakeClientWrapper`" claude %*`r`n", [Text.UTF8Encoding]::new($false))

  $previousPath = $env:Path
  $previousProfile = $env:USERPROFILE
  $previousFailure = $env:RELAYBRIDGE_FAKE_MCP_FAIL
  $previousRaceRole = $env:RELAYBRIDGE_FAKE_MCP_RACE_ROLE
  $previousRacePaused = $env:RELAYBRIDGE_FAKE_MCP_RACE_PAUSED
  $previousRaceRelease = $env:RELAYBRIDGE_FAKE_MCP_RACE_RELEASE
  try {
    $env:Path = "$fakeBin;$previousPath"
    $env:USERPROFILE = $profileRoot
    $env:RELAYBRIDGE_FAKE_MCP_FAIL = $null
    Reset-Configs

    $installerSource = [IO.File]::ReadAllText((Join-Path $bridgeRoot 'install-mcp.ps1'), [Text.UTF8Encoding]::new($false))
    Assert-True ($installerSource -match 'Global\\RelayBridge-McpInstall-\$sid') 'Windows MCP locking must use one OS-global SID namespace'
    $lockFunctionStart = $installerSource.IndexOf('function Enter-McpRegistrationLock')
    $lockFunctionEnd = $installerSource.IndexOf('function Exit-McpRegistrationLock')
    Assert-True ($lockFunctionStart -ge 0 -and $lockFunctionEnd -gt $lockFunctionStart) 'Windows MCP lock functions must be discoverable for namespace audit'
    $lockFunctionText = $installerSource.Substring($lockFunctionStart, $lockFunctionEnd - $lockFunctionStart)
    Assert-True ($lockFunctionText -notmatch '\$env:|\$bridgeRoot') 'the production mutex namespace must not be splittable by checkout or environment override'

    # Constructor ACLs apply only when a named mutex is first created. Prove
    # that a pre-created object granting an extra principal is rejected before
    # any snapshot, token, or client mutation is attempted.
    $windowsIdentityText = (& whoami.exe /user /fo csv /nh 2>$null | Out-String)
    $windowsSidMatch = [regex]::Match($windowsIdentityText, 'S-[0-9]+(?:-[0-9]+)+')
    Assert-True $windowsSidMatch.Success 'the descriptor regression must resolve the current Windows SID'
    $currentSid = New-Object System.Security.Principal.SecurityIdentifier($windowsSidMatch.Value)
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $foreignSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $foreignMutexSecurity = New-Object System.Security.AccessControl.MutexSecurity
    $foreignMutexSecurity.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($currentSid, $systemSid, $administratorsSid, $foreignSid)) {
      $foreignMutexSecurity.AddAccessRule((New-Object System.Security.AccessControl.MutexAccessRule(
        $principal,
        [System.Security.AccessControl.MutexRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
      )))
    }
    $foreignMutexSecurity.SetOwner($currentSid)
    $foreignMutexCreated = $false
    $foreignMutex = [System.Threading.Mutex]::new(
      $false,
      "Global\RelayBridge-McpInstall-$($windowsSidMatch.Value)",
      [ref]$foreignMutexCreated,
      $foreignMutexSecurity
    )
    Assert-True $foreignMutexCreated 'the descriptor regression requires a fresh global mutex namespace'
    $codexBeforeForeignMutex = [Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig))
    $claudeBeforeForeignMutex = [Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig))
    $foreignMutexRejected = $false
    $foreignMutexDiagnostic = ''
    try {
      try { & (Join-Path $bridgeRoot 'install-mcp.ps1') }
      catch {
        $foreignMutexRejected = $true
        $foreignMutexDiagnostic = $_.Exception.Message
      }
    } finally { $foreignMutex.Dispose() }
    Assert-True $foreignMutexRejected 'an existing mutex with a foreign DACL principal must fail closed'
    Assert-True ($foreignMutexDiagnostic -match 'security descriptor is not trusted') 'foreign mutex rejection must identify descriptor trust failure'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig)) -eq $codexBeforeForeignMutex) 'foreign mutex rejection must preserve Codex bytes'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig)) -eq $claudeBeforeForeignMutex) 'foreign mutex rejection must preserve Claude bytes'
    Assert-True (-not (Test-Path -LiteralPath $tokenFile)) 'foreign mutex rejection must happen before token creation'

    # A configuration snapshot can fail before the transaction is assembled
    # (for example, another client can hold its file without sharing). The
    # installer must not create a bearer token until every snapshot succeeds.
    $snapshotFailed = $false
    $configLock = [IO.File]::Open($codexConfig, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      try { & (Join-Path $bridgeRoot 'install-mcp.ps1') }
      catch { $snapshotFailed = $true }
    } finally { $configLock.Dispose() }
    Assert-True $snapshotFailed 'injected configuration snapshot failure must abort MCP registration'
    Assert-True (-not (Test-Path -LiteralPath $tokenFile)) 'snapshot failure must happen before a new token can be left behind'

    # Invocation A pauses after creating its token and changing Codex, then
    # fails Claude registration. Invocation B runs from a different checkout
    # and must already be waiting on the user-global transaction lock before A
    # is released. A checkout-local lock lets A restore its old snapshots over
    # B's successful global client configuration.
    Copy-Item -LiteralPath $bridgeRoot -Destination $bridgeRootB -Recurse -Force
    Assert-True (Test-Path -LiteralPath (Join-Path $bridgeRootB '.git') -PathType Container) 'the cross-checkout race fixture must copy an independent Git source root'
    $installerPath = Join-Path $bridgeRoot 'install-mcp.ps1'
    $installerPathB = Join-Path $bridgeRootB 'install-mcp.ps1'

    $racePausedPath = Join-Path $testRoot 'race-a-paused'
    $raceReleasePath = Join-Path $testRoot 'race-a-release'
    $raceAStartedPath = Join-Path $testRoot 'race-a-started'
    $raceBStartedPath = Join-Path $testRoot 'race-b-started'
    $raceBWaitingPath = Join-Path $testRoot 'race-b-waiting'
    $raceAResultPath = Join-Path $testRoot 'race-a-result.txt'
    $raceBResultPath = Join-Path $testRoot 'race-b-result.txt'
    $raceAOutPath = Join-Path $testRoot 'race-a.out.log'
    $raceAErrPath = Join-Path $testRoot 'race-a.err.log'
    $raceBOutPath = Join-Path $testRoot 'race-b.out.log'
    $raceBErrPath = Join-Path $testRoot 'race-b.err.log'
    $powerShellExe = Join-Path $PSHOME $(if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' })
    if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) { $powerShellExe = (Get-Process -Id $PID -ErrorAction Stop).Path }
    $raceACommand = New-InstallerChildCommand $installerPath $raceAStartedPath $raceAResultPath ''
    $raceBCommand = New-InstallerChildCommand $installerPathB $raceBStartedPath $raceBResultPath $raceBWaitingPath
    $raceAProcess = $null
    $raceBProcess = $null
    $raceTokenA = ''
    $raceProcessesExited = $false
    try {
      $env:RELAYBRIDGE_FAKE_MCP_RACE_PAUSED = $racePausedPath
      $env:RELAYBRIDGE_FAKE_MCP_RACE_RELEASE = $raceReleasePath
      $env:RELAYBRIDGE_FAKE_MCP_RACE_ROLE = 'A'
      $raceAProcess = Start-Process -FilePath $powerShellExe -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $raceACommand
      ) -WorkingDirectory $testRoot -RedirectStandardOutput $raceAOutPath -RedirectStandardError $raceAErrPath -PassThru
      $raceAPaused = Wait-ForPath $racePausedPath 15000
      if (-not $raceAPaused) {
        $raceADiagnostic = @($raceAOutPath, $raceAErrPath, $raceAResultPath | ForEach-Object {
          if (Test-Path -LiteralPath $_ -PathType Leaf) {
            try { [IO.File]::ReadAllText($_) } catch { "<diagnostic file still locked: $_>" }
          }
        }) -join "`n"
        throw "ASSERTION FAILED: invocation A must reach the deterministic post-Codex failure gate. $raceADiagnostic"
      }
      Assert-True (Test-Path -LiteralPath $tokenFile -PathType Leaf) 'invocation A fixture must create a token before it pauses'
      $raceTokenA = ([IO.File]::ReadAllText($tokenFile)).Trim()
      Assert-True ($raceTokenA -match '^[a-f0-9]{64}$') 'invocation A fixture token must be valid'
      Assert-True ([IO.File]::ReadAllText($codexConfig) -match '\[mcp_servers\.relaybridge\]') 'invocation A fixture must mutate Codex before its injected failure'

      $env:RELAYBRIDGE_FAKE_MCP_RACE_ROLE = 'B'
      $raceBProcess = Start-Process -FilePath $powerShellExe -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $raceBCommand
      ) -WorkingDirectory $testRoot -RedirectStandardOutput $raceBOutPath -RedirectStandardError $raceBErrPath -PassThru
      Assert-True (Wait-ForPath $raceBStartedPath 10000) 'invocation B must start while invocation A owns the transaction'
      $raceBWaited = Wait-ForPath $raceBWaitingPath 10000
      if (-not $raceBWaited) {
        $raceBDiagnostic = @($raceBOutPath, $raceBErrPath, $raceBResultPath | ForEach-Object {
          if (Test-Path -LiteralPath $_ -PathType Leaf) {
            try { [IO.File]::ReadAllText($_) } catch { "<diagnostic file still locked: $_>" }
          }
        }) -join "`n"
        throw "ASSERTION FAILED: invocation B must deterministically reach lock contention before A is released. $raceBDiagnostic"
      }
      Assert-True (-not $raceBProcess.HasExited) 'invocation B must remain blocked while invocation A owns the lock'

      [IO.File]::WriteAllText($raceReleasePath, 'release', [Text.UTF8Encoding]::new($false))
      $raceAExited = $raceAProcess.WaitForExit(30000)
      $raceBExited = $raceBProcess.WaitForExit(30000)
      if ($raceAExited) { $raceAProcess.WaitForExit(); $raceAProcess.Refresh() }
      if ($raceBExited) { $raceBProcess.WaitForExit(); $raceBProcess.Refresh() }
      $raceProcessesExited = $raceAExited -and $raceBExited
    } finally {
      $env:RELAYBRIDGE_FAKE_MCP_RACE_ROLE = $null
      $env:RELAYBRIDGE_FAKE_MCP_RACE_PAUSED = $null
      $env:RELAYBRIDGE_FAKE_MCP_RACE_RELEASE = $null
      if (-not (Test-Path -LiteralPath $raceReleasePath -PathType Leaf)) {
        [IO.File]::WriteAllText($raceReleasePath, 'release', [Text.UTF8Encoding]::new($false))
      }
      foreach ($raceProcess in @($raceAProcess, $raceBProcess)) {
        if ($null -ne $raceProcess) {
          try {
            if (-not $raceProcess.HasExited) { Stop-Process -Id $raceProcess.Id -Force -ErrorAction SilentlyContinue }
          } catch { }
        }
      }
    }
    Assert-True $raceProcessesExited 'both serialized installer invocations must finish within the bounded lock interval'
    Assert-True ([IO.File]::ReadAllText($raceAResultPath) -match 'claude mcp add failed') 'invocation A must fail for the intended post-mutation reason'
    Assert-True ([IO.File]::ReadAllText($raceBResultPath).Trim() -eq 'success') 'invocation B must report a successful serialized transaction'
    Assert-True (-not (Test-Path -LiteralPath $tokenFile)) 'invocation A must remove only its own failed-checkout token'
    $raceTokenB = ([IO.File]::ReadAllText($tokenFileB)).Trim()
    Assert-True ($raceTokenB -match '^[a-f0-9]{64}$' -and $raceTokenB -ne $raceTokenA) 'invocation B must create and retain its own token after A rolls back'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot '.mcp-install.lock'))) 'checkout A must not create a checkout-local lock namespace'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $bridgeRootB '.mcp-install.lock'))) 'checkout B must not create a checkout-local lock namespace'
    $raceCodexAfter = [IO.File]::ReadAllText($codexConfig, [Text.UTF8Encoding]::new($false))
    $raceClaudeAfter = [IO.File]::ReadAllText($claudeConfig, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    Assert-True ($raceCodexAfter -match '\[mcp_servers\.relaybridge\]') 'A rollback must not clobber B successful Codex registration from another checkout'
    Assert-True ($raceCodexAfter -match '\[mcp_servers\.unrelated\]') 'the cross-checkout race must preserve unrelated Codex bytes'
    Assert-True ([string]::Equals([string]$raceClaudeAfter.mcpServers.relaybridge.env.RELAYBRIDGE_TOKEN_FILE, $tokenFileB, [StringComparison]::OrdinalIgnoreCase)) 'A rollback must not clobber B successful Claude token ownership from another checkout'
    Assert-True (@($raceClaudeAfter.mcpServers.relaybridge.args | Where-Object {
      try { [string]::Equals([IO.Path]::GetFullPath([string]$_), [IO.Path]::GetFullPath((Join-Path $bridgeRootB 'mcp\server.mjs')), [StringComparison]::OrdinalIgnoreCase) }
      catch { $false }
    }).Count -gt 0) 'the surviving Claude registration must belong to checkout B'
    Assert-True ($null -ne $raceClaudeAfter.mcpServers.unrelated) 'the cross-checkout race must preserve unrelated Claude configuration'

    $foreignCheckoutTokenBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tokenFileB))
    $foreignCheckoutTokenOwner = ([IO.File]::GetAccessControl($tokenFileB)).GetOwner([Security.Principal.SecurityIdentifier]).Value
    Push-Location -LiteralPath $testRoot
    try { & $installerPath }
    finally { Pop-Location }
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($tokenFileB)) -eq $foreignCheckoutTokenBytes) 'a later checkout A registration must preserve checkout B token bytes it does not own'
    Assert-True (([IO.File]::GetAccessControl($tokenFileB)).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $foreignCheckoutTokenOwner) 'a later checkout A registration must preserve checkout B token ownership'

    $preparedBuild = [IO.File]::ReadAllText((Join-Path $bridgeRoot 'build-info.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    Assert-True ([string]$preparedBuild.buildId -match '^2\.0\.1\+[a-f0-9]{16}$') 'Windows MCP registration must prepare an exact source build identity'
    $codexAfter = [IO.File]::ReadAllText($codexConfig, [Text.UTF8Encoding]::new($false))
    $claudeAfter = [IO.File]::ReadAllText($claudeConfig, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    Assert-True ($codexAfter -match '\[mcp_servers\.relaybridge\]') 'Codex canonical registration must be created'
    Assert-True ($codexAfter -match 'tool_timeout_sec = 2745') 'Codex MCP timeout must cover the 45-minute provider cap plus transport and host grace'
    foreach ($newTool in @(
      'plan_task', 'list_models', 'list_active_runs', 'bridge_activity',
      'submit_task', 'get_task', 'list_tasks', 'cancel_task',
      'provider_cooldowns', 'usage_gauges', 'usage_totals', 'usage_advise'
    )) {
      Assert-True ($codexAfter -match ('"' + [regex]::Escape($newTool) + '"')) "Codex allowlist must include PR #40 tool: $newTool"
    }
    Assert-True ($codexAfter -notmatch '\[mcp_servers\.ps_bridge\]') 'recognized Codex ps_bridge registration must be removed after promotion'
    Assert-True ($codexAfter -match '\[mcp_servers\.ps-bridge\]') 'non-RelayBridge lookalike registration must not be removed'
    Assert-True ($codexAfter -match '\[mcp_servers\.unrelated\]') 'unrelated Codex registration must be preserved'
    Assert-True ($null -ne $claudeAfter.mcpServers.relaybridge) 'Claude canonical registration must be created'
    Assert-True ($null -eq $claudeAfter.mcpServers.ps_bridge) 'recognized Claude ps_bridge registration must be removed after promotion'
    Assert-True ($null -ne $claudeAfter.mcpServers.'ps-bridge') 'non-RelayBridge Claude lookalike must not be removed'
    Assert-True ((Get-Content -LiteralPath $tokenFile -Raw).Trim() -match '^[a-f0-9]{64}$') 'MCP registration must create a valid capability token'
    $aclText = (& icacls.exe $tokenFile 2>$null | Out-String)
    Assert-True ($aclText -notmatch '\(I\)') 'new capability token must have inheritance removed'

    $codexBeforeUnready = [Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig))
    $claudeBeforeUnready = [Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig))
    Remove-Item -LiteralPath $tokenFile -Force
    Move-Item -LiteralPath (Join-Path $bridgeRoot '.git') -Destination (Join-Path $bridgeRoot '.git-away')
    Remove-Item -LiteralPath (Join-Path $bridgeRoot 'build-info.json') -Force
    $unreadyRegistrationFailed = $false
    try { & (Join-Path $bridgeRoot 'install-mcp.ps1') }
    catch { $unreadyRegistrationFailed = $true }
    Assert-True $unreadyRegistrationFailed 'Windows MCP registration must fail before changing clients when exact identity is unavailable'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig)) -eq $codexBeforeUnready) 'unready identity must leave Codex configuration unchanged'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig)) -eq $claudeBeforeUnready) 'unready identity must leave Claude configuration unchanged'
    Assert-True (-not (Test-Path -LiteralPath $tokenFile)) 'build preparation failure must remove a token created inside the transaction guard'

    $previousPort = $env:PORT
    $startFailed = $false
    try {
      $env:PORT = [string](Get-FreePort)
      & (Join-Path $bridgeRoot 'start.ps1') -NoBrowser
    } catch { $startFailed = $true }
    finally { $env:PORT = $previousPort }
    Assert-True $startFailed 'Windows start must fail when build-info.json is unavailable outside a Git checkout'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot 'server-started.marker'))) 'unready Windows start must not launch server.js'
    Move-Item -LiteralPath (Join-Path $bridgeRoot '.git-away') -Destination (Join-Path $bridgeRoot '.git')
    & $nodePath (Join-Path $bridgeRoot 'tools\prepare-build-info.cjs') $bridgeRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore the Windows source identity fixture.' }

    # Post-launch validation must distinguish the exact Start-Process child
    # from a detached same-build process that wins the port first. Otherwise a
    # matching build ID can make start.ps1 report success for the wrong owner.
    $raceOriginalServer = [IO.File]::ReadAllBytes((Join-Path $bridgeRoot 'server.js'))
    $raceWinnerPath = Join-Path $bridgeRoot 'winner.js'
    $raceCandidatePidPath = Join-Path $bridgeRoot '.bridge.race-candidate.pid'
    $raceWinnerPidPath = Join-Path $bridgeRoot '.bridge.race-winner.pid'
    $raceStdoutPath = Join-Path $bridgeRoot 'bridge.start.out.log'
    $raceStderrPath = Join-Path $bridgeRoot 'bridge.start.err.log'
    $raceCandidateServer = @'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
fs.writeFileSync(path.join(__dirname, '.bridge.race-candidate.pid'), String(process.pid));
const winner = spawn(process.execPath, [path.join(__dirname, 'winner.js')], {
  cwd: __dirname,
  env: process.env,
  detached: true,
  stdio: 'ignore',
  windowsHide: true
});
fs.writeFileSync(path.join(__dirname, '.bridge.race-winner.pid'), String(winner.pid));
winner.unref();
setInterval(() => {}, 1000);
'@
    $raceWinnerServer = @'
'use strict';
const http = require('http');
const buildId = process.env.RELAYBRIDGE_EXPECTED_BUILD_ID;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    pid: process.pid,
    capabilityAuth: true,
    buildId,
    buildIdentityReady: true,
    receiptStoreIdentityReady: true,
    receiptStoreId: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  }));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
'@
    $racePort = Get-FreePort
    $raceRejected = $false
    $raceDiagnostic = ''
    $raceCandidatePid = 0
    $raceWinnerPid = 0
    $raceCandidateStopped = $false
    $raceWinnerHealthMatched = $false
    $raceExpectedBuildId = ''
    $raceListenerCleaned = $false
    $racePidArtifactsCleaned = $false
    try {
      [IO.File]::WriteAllText((Join-Path $bridgeRoot 'server.js'), ($raceCandidateServer + "`n"), [Text.UTF8Encoding]::new($false))
      [IO.File]::WriteAllText($raceWinnerPath, ($raceWinnerServer + "`n"), [Text.UTF8Encoding]::new($false))
      $previousPort = $env:PORT
      try {
        $env:PORT = [string]$racePort
        try { & (Join-Path $bridgeRoot 'start.ps1') -NoBrowser }
        catch {
          $raceRejected = $true
          $raceDiagnostic = $_.Exception.Message
        }
      } finally { $env:PORT = $previousPort }
      if (Test-Path -LiteralPath (Join-Path $bridgeRoot 'build-info.json') -PathType Leaf) {
        $raceBuildInfo = [IO.File]::ReadAllText((Join-Path $bridgeRoot 'build-info.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        $raceExpectedBuildId = [string]$raceBuildInfo.buildId
      }
      if (Test-Path -LiteralPath $raceCandidatePidPath -PathType Leaf) {
        $raceCandidatePid = [int]([IO.File]::ReadAllText($raceCandidatePidPath).Trim())
      }
      if (Test-Path -LiteralPath $raceWinnerPidPath -PathType Leaf) {
        $raceWinnerPid = [int]([IO.File]::ReadAllText($raceWinnerPidPath).Trim())
      }
      for ($attempt = 0; $attempt -lt 30 -and (Test-ProcessRunning $raceCandidatePid); $attempt++) { Start-Sleep -Milliseconds 100 }
      $raceCandidateStopped = $raceCandidatePid -gt 0 -and -not (Test-ProcessRunning $raceCandidatePid)
      try {
        $raceWinnerHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$racePort/api/health" -TimeoutSec 2 -UseBasicParsing
        $raceWinnerHealthMatched = $raceWinnerPid -gt 0 -and
          [int64]$raceWinnerHealth.pid -eq [int64]$raceWinnerPid -and
          $raceExpectedBuildId -match '^2\.0\.1\+[a-f0-9]{16}$' -and
          [string]$raceWinnerHealth.buildId -eq $raceExpectedBuildId -and
          $raceWinnerPid -ne $raceCandidatePid
      } catch { $raceWinnerHealthMatched = $false }
    } finally {
      if (-not $raceCandidatePid -and (Test-Path -LiteralPath $raceCandidatePidPath -PathType Leaf)) {
        $raceCandidatePid = [int]([IO.File]::ReadAllText($raceCandidatePidPath).Trim())
      }
      if (-not $raceWinnerPid -and (Test-Path -LiteralPath $raceWinnerPidPath -PathType Leaf)) {
        $raceWinnerPid = [int]([IO.File]::ReadAllText($raceWinnerPidPath).Trim())
      }
      if ($raceCandidatePid -gt 0 -and (Test-ProcessRunning $raceCandidatePid)) {
        Stop-Process -Id $raceCandidatePid -Force -ErrorAction SilentlyContinue
      }
      if ($raceWinnerPid -gt 0 -and (Test-ProcessRunning $raceWinnerPid)) {
        Stop-Process -Id $raceWinnerPid -Force -ErrorAction SilentlyContinue
      }
      for ($attempt = 0; $attempt -lt 50 -and (Test-LocalPortInUse $racePort); $attempt++) { Start-Sleep -Milliseconds 100 }
      $raceListenerCleaned = -not (Test-LocalPortInUse $racePort)
      Remove-Item -LiteralPath $raceCandidatePidPath, $raceWinnerPidPath, $raceStdoutPath, $raceStderrPath -Force -ErrorAction SilentlyContinue
      $racePidArtifactsCleaned = -not (Test-Path -LiteralPath $raceCandidatePidPath) -and
        -not (Test-Path -LiteralPath $raceWinnerPidPath)
      [IO.File]::WriteAllBytes((Join-Path $bridgeRoot 'server.js'), $raceOriginalServer)
      Remove-Item -LiteralPath $raceWinnerPath -Force -ErrorAction SilentlyContinue
    }
    Assert-True $raceRejected 'Windows start must reject a same-build listener owned by another PID'
    Assert-True ($raceDiagnostic -match 'candidate PID') 'same-build Windows start rejection must identify the PID ownership mismatch'
    Assert-True $raceCandidateStopped 'same-build Windows start rejection must terminate the spawned candidate process'
    Assert-True $raceWinnerHealthMatched 'the Windows start race fixture must prove that a different PID won the port with the expected build'
    Assert-True $raceListenerCleaned 'Windows start PID regression must clean the detached winner listener'
    Assert-True $racePidArtifactsCleaned 'Windows start PID regression must clean its PID artifacts'
    & $nodePath (Join-Path $bridgeRoot 'tools\prepare-build-info.cjs') $bridgeRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore build identity after the Windows PID-ownership regression.' }

    $manifestBeforeFailedRegistration = [IO.File]::ReadAllText((Join-Path $bridgeRoot 'build-info.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    [IO.File]::AppendAllText((Join-Path $bridgeRoot 'server.js'), "// changed source identity`n", [Text.UTF8Encoding]::new($false))
    Reset-Configs
    $codexBeforeFailure = [Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig))
    $claudeBeforeFailure = [Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig))
    $env:RELAYBRIDGE_FAKE_MCP_FAIL = 'claude-add'
    $failed = $false
    try { & (Join-Path $bridgeRoot 'install-mcp.ps1') }
    catch { $failed = $true }
    Assert-True $failed 'injected Claude registration failure must fail the transaction'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig)) -eq $codexBeforeFailure) 'Codex config bytes must roll back after partial registration failure'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig)) -eq $claudeBeforeFailure) 'Claude config bytes must roll back after partial registration failure'
    Assert-True (-not (Test-Path -LiteralPath $tokenFile)) 'new token must be removed when registration rolls back'
    $manifestAfterFailedRegistration = [IO.File]::ReadAllText((Join-Path $bridgeRoot 'build-info.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    Assert-True ([string]$manifestAfterFailedRegistration.buildId -ne [string]$manifestBeforeFailedRegistration.buildId) 'configuration rollback must not restore an older generated build manifest'

    Write-Host '[RelayBridge] MCP canonical-name migration, guarded-token, and rollback test passed.' -ForegroundColor Green
  } finally {
    $env:Path = $previousPath
    $env:USERPROFILE = $previousProfile
    $env:RELAYBRIDGE_FAKE_MCP_FAIL = $previousFailure
    $env:RELAYBRIDGE_FAKE_MCP_RACE_ROLE = $previousRaceRole
    $env:RELAYBRIDGE_FAKE_MCP_RACE_PAUSED = $previousRacePaused
    $env:RELAYBRIDGE_FAKE_MCP_RACE_RELEASE = $previousRaceRelease
  }
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTestRoot) -like 'relaybridge-mcp-install-test-*') {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
