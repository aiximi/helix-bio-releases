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
  & $exe $script --output $functionOut 2>&1 | Tee-Object -FilePath (Join-Path $Out 'installed-functions-console.log')
  $report.functionalExitCode = $LASTEXITCODE
} finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process') }
$profile = $config.profileTest
if ($profile.assetName -notmatch '^Helix-Office-Profile-Validation-[0-9]{2}\.bin$' -or $profile.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Profile validation requires an exact asset and SHA-256' }
$profileExe = Join-Path $env:RUNNER_TEMP 'helix-office-profile-validation.exe'
& curl.exe -fL --retry 3 --output $profileExe "https://github.com/aiximi/helix-bio-releases/releases/download/$ReleaseTag/$($profile.assetName)"
if ($LASTEXITCODE -ne 0) { throw 'Windows profile-path validation asset could not be downloaded' }
if ((Get-FileHash -LiteralPath $profileExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $profile.sha256) { throw 'Windows profile-path validation asset SHA-256 mismatch' }
& $profileExe 2>&1 | Tee-Object -FilePath (Join-Path $Out 'profile-path-validation.log')
$report.profilePathExitCode = $LASTEXITCODE
$report.profilePathSha256 = $profile.sha256
$report.passed = $report.functionalExitCode -eq 0 -and $report.profilePathExitCode -eq 0
$report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out 'installed-validation.json')
if (-not $report.passed) { throw 'Installed functional or Windows path validation failed; see the saved synthetic test reports' }
