param([string]$Install,[string]$Out,[string]$ReleaseTag,[string]$InstallerSha256)
$ErrorActionPreference = 'Stop'
$config = Get-Content '.github/scripts/office-only-validation.json' -Raw | ConvertFrom-Json
if ($config.schema -ne 1 -or $config.releaseTag -ne $ReleaseTag -or $config.installerSha256 -ne $InstallerSha256) { throw 'Office diagnostic configuration does not match the unchanged installer' }
if (Test-Path '.github/scripts/office-broker-candidate.json') { throw 'This diagnostic must not replace any installed component' }
@{variant='unchanged-installer-office-diagnostic';releaseTag=$ReleaseTag;installerSha256=$InstallerSha256;repeatedGuiChecksSkipped=$true;installedFilesModified=$false} | ConvertTo-Json | Set-Content (Join-Path $Out 'run-variant.json')
$env:HELIX_NATIVE_DIAGNOSTIC_OUT = Join-Path $Out 'office-native'
$env:HELIX_TEST_NATIVE_OBSERVER = (Resolve-Path '.github/scripts/observe-office-process.ps1').Path
$env:HELIX_TEST_POWERSHELL = (Get-Command pwsh).Source
$failed = $false
try { & .github/scripts/run-installed-validation.ps1 -Install $Install -Out $Out -ReleaseTag $ReleaseTag -InstallerSha256 $InstallerSha256 }
catch { $failed=$true; $_.Exception.Message | Set-Content (Join-Path $Out 'installed-validation-error.txt'); Write-Host $_.Exception.Message }
if ($failed) {
 try {
  $env:ELECTRON_RUN_AS_NODE='1'
  $exe=Join-Path $Install 'Helix Bio.exe'
  & $exe --require (Resolve-Path '.github/scripts/office-native-preload.cjs').Path (Resolve-Path '.github/scripts/office-preview-probe.cjs').Path $Install $Out 2>&1 | Tee-Object -FilePath (Join-Path $Out 'independent-office-previews-console.log')
  $previewCode=$LASTEXITCODE
  if ($previewCode -ne 0) { Write-Host "Independent preview diagnostic exit code: $previewCode" }
 } finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process') }
}
if ($failed) { throw 'The unchanged installer functional check failed; native traces and independent previews are preserved.' }
