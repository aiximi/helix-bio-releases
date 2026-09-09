param([string]$Install,[string]$Out,[string]$ReleaseTag,[string]$InstallerSha256)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$config = Get-Content '.github/scripts/installed-validation.json' -Raw | ConvertFrom-Json
if ($config.schema -ne 1 -or $config.releaseTag -ne $ReleaseTag -or $config.installerSha256 -ne $InstallerSha256) { throw 'Functional validation manifest does not match the original installed release' }
if (Test-Path '.github/scripts/office-broker-candidate.json') { throw 'Full installer validation cannot use candidate component replacements' }
$exe = Join-Path $Install 'Helix Bio.exe'
$script = Join-Path $Install 'resources\docs\verify-windows-installed.cjs'
if (-not (Test-Path -LiteralPath $script)) { throw 'Published installer is missing its built-in functional self-test' }
$report = @{variant='original-installed-package';releaseTag=$ReleaseTag;installerSha256=$InstallerSha256;syntheticModelOnly=$true}
$functionOut = Join-Path $Out 'installed-functions'
New-Item -ItemType Directory -Force $functionOut | Out-Null
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $nodeArguments = @()
  if ($env:HELIX_NATIVE_DIAGNOSTIC_OUT) { $nodeArguments += @('--require',(Resolve-Path '.github/scripts/office-native-preload.cjs').Path) }
  $nodeArguments += @($script,'--output',$functionOut)
  & $exe @nodeArguments 2>&1 | Tee-Object -FilePath (Join-Path $Out 'installed-functions-console.log')
  $report.functionalExitCode = $LASTEXITCODE
} finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process') }
$reports = @(Get-ChildItem -LiteralPath $functionOut -Recurse -File -Filter '验收结果.json')
if ($reports.Count -ne 1) { throw 'The installed functional test did not produce exactly one result report' }
$functionalReport = Get-Content -LiteralPath $reports[0].FullName -Raw | ConvertFrom-Json
$report.functionalReportAccepted = $functionalReport.passed -eq $true -and $functionalReport.windowsExecutionVerified -eq $true -and $functionalReport.appVersion -eq ($ReleaseTag -replace '^v','')
$profile = $config.profileTest
if ($profile.repoPath -ne '.github/fixtures/helix-office-profile-validation.bin' -or $profile.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Profile validation requires the fixed diagnostic fixture and an exact SHA-256' }
if ((Get-FileHash -LiteralPath $profile.repoPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $profile.sha256) { throw 'Windows profile-path validation fixture SHA-256 mismatch' }
$profileExe = Join-Path $env:RUNNER_TEMP 'helix-office-profile-validation.exe'
Copy-Item -LiteralPath $profile.repoPath -Destination $profileExe -Force
& $profileExe 2>&1 | Tee-Object -FilePath (Join-Path $Out 'profile-path-validation.log')
$report.profilePathExitCode = $LASTEXITCODE
$report.profilePathSha256 = $profile.sha256
$report.passed = $report.functionalExitCode -eq 0 -and $report.functionalReportAccepted -and $report.profilePathExitCode -eq 0
$report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out 'installed-validation.json')
if (-not $report.passed) { throw 'Installed functional or Windows path validation failed; see the saved synthetic test reports' }
