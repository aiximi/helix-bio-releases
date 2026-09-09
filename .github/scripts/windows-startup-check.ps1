$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$out = Join-Path $env:GITHUB_WORKSPACE 'startup-evidence'
New-Item -ItemType Directory -Force $out | Out-Null
$install = Join-Path $env:RUNNER_TEMP 'Helix 启动测试\安装目录 with spaces'
$profile = Join-Path $env:RUNNER_TEMP 'Helix 启动测试\空白用户数据'
$env:HELIX_USER_DATA_DIR = $profile
$env:HELIX_DATA_DIR = Join-Path $profile 'workspace'
$version = $env:RELEASE_TAG -replace '^v',''
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$') { throw 'Invalid release tag' }
if ($env:EXPECTED_SHA256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Expected SHA-256 required' }
$installer = Join-Path $env:RUNNER_TEMP 'helix-setup.exe'
$url = "https://github.com/aiximi/helix-bio-releases/releases/download/$env:RELEASE_TAG/Helix-Bio-$version-Windows-x64-Setup.exe"
if ($env:GH_TOKEN) {
  & gh release download $env:RELEASE_TAG --repo aiximi/helix-bio-releases --pattern "Helix-Bio-$version-Windows-x64-Setup.exe" --output $installer --clobber
} else {
  & curl.exe -fL --retry 3 --output $installer $url
}
if ($LASTEXITCODE -ne 0) { throw 'Installer download failed' }
[Environment]::SetEnvironmentVariable('GH_TOKEN',$null,'Process')
$actualHash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $env:EXPECTED_SHA256.ToLowerInvariant()) { throw 'Installer hash mismatch' }
@{tag=$env:RELEASE_TAG;url=$url;sha256=$actualHash;size=(Get-Item $installer).Length;os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture);cpu=(Get-CimInstance Win32_Processor | Select-Object Name,Architecture,NumberOfCores);memory=(Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory);installDirectory=$install;nodeVersion=(& node --version)} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out 'system.json')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Capture-UI([string]$Name) {
  try {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $image = [System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$image.Size)
  $image.Save((Join-Path $out "$Name.png"))
  $graphics.Dispose(); $image.Dispose()
  } catch { $_.Exception.Message | Set-Content (Join-Path $out "$Name-screenshot-error.txt") }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  foreach ($window in $windows) {
    if ($window.Current.Name -match 'Helix|Error|错误|启动|Setup|安装') {
      $texts = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      $items += @{name=$window.Current.Name;processId=$window.Current.ProcessId;texts=@($texts | ForEach-Object {$_.Current.Name} | Where-Object {$_} | Select-Object -First 300)}
    }
  }
  ConvertTo-Json -InputObject @($items) -Depth 8 | Set-Content (Join-Path $out "$Name-ui.json")
}
$p = Start-Process -FilePath $installer -ArgumentList "/S /D=$install" -PassThru
if (-not $p.WaitForExit(30000)) {
  Capture-UI 'installer-progress'
  $installerText = Get-Content (Join-Path $out 'installer-progress-ui.json') -Raw
  Write-Host $installerText
  if ($installerText -match 'requires 64-bit Windows|需要 Windows 10|需要 Windows 11|integrity check has failed|Error launching installer') { throw 'Installer displayed a blocking diagnostic; see installer-progress evidence.' }
}
$installDeadline = (Get-Date).AddMinutes(14.5)
$installProgress = @()
while (-not $p.WaitForExit(30000)) {
  $p.Refresh()
  $files = @(Get-ChildItem $install -File -Recurse -ErrorAction SilentlyContinue)
  $snapshot = @{at=(Get-Date).ToUniversalTime().ToString('o');cpuSeconds=$p.TotalProcessorTime.TotalSeconds;memoryBytes=$p.WorkingSet64;installedFileCount=$files.Count;installedBytes=($files | Measure-Object -Property Length -Sum).Sum}
  $installProgress += $snapshot
  ConvertTo-Json -InputObject @($installProgress) -Depth 5 | Set-Content (Join-Path $out 'installation-progress.json')
  Write-Host ($snapshot | ConvertTo-Json -Compress)
  if ((Get-Date) -gt $installDeadline) {
    Capture-UI 'installer-timeout'
    Get-CimInstance Win32_Process | Where-Object {$_.Name -match 'helix|setup'} | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json | Set-Content (Join-Path $out 'installer-processes.json')
    throw 'Installer did not exit within fifteen minutes'
  }
}
$p.Refresh()
@{exitCode=$p.ExitCode} | ConvertTo-Json | Set-Content (Join-Path $out 'installation.json')
if ($p.ExitCode -ne 0) { throw "Installer exited $($p.ExitCode)" }
$exe = Join-Path $install 'Helix Bio.exe'
if (-not (Test-Path $exe)) { Get-ChildItem $install | Out-String | Set-Content (Join-Path $out 'installed-files.txt'); throw 'Installed normal entry point missing' }
function Stop-InstalledApp {
  Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($install,[System.StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
  Start-Sleep -Seconds 2
}
Stop-InstalledApp
Write-Host 'Installation completed; testing ordinary desktop entry point.'
$normal = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 25
Capture-UI 'normal-startup'
$normalUiText = Get-Content (Join-Path $out 'normal-startup-ui.json') -Raw
Write-Host $normalUiText
$normalWindows = @($normalUiText | ConvertFrom-Json)
$normalFailure = $normalWindows.Count -eq 0 -or $normalUiText -match '无法启动|暂时无法打开|启动遇到问题|ERR_FAILED|Error launching|Application Error|The application was unable'
@{normalWindowPresent=$normalWindows.Count -gt 0;blockingError=$normalFailure} | ConvertTo-Json | Set-Content (Join-Path $out 'normal-acceptance.json')
$processes = @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($install,[System.StringComparison]::OrdinalIgnoreCase)} | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)
$processes | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out 'normal-processes.json')
$health = @()
foreach ($proc in $processes) {
  $ports = @(Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue)
  foreach ($port in $ports) {
    if ($port.LocalAddress -eq '127.0.0.1') {
      try { $response=Invoke-WebRequest -Uri "http://127.0.0.1:$($port.LocalPort)/api/health" -TimeoutSec 5; $health += @{port=$port.LocalPort;status=$response.StatusCode;body=$response.Content} } catch { $health += @{port=$port.LocalPort;error=$_.Exception.Message} }
    }
  }
}
$health | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'normal-health.json')
Stop-InstalledApp
$env:HELIX_TEST_EXE = $exe
$env:HELIX_TEST_OUT = $out
& node .github/scripts/windows-startup-observer.cjs
$diagnosticCode = $LASTEXITCODE
Capture-UI 'observed-startup'
Stop-InstalledApp
$compatibilityCode = 0
if ([version]($version -replace '-.*','') -ge [version]'0.3.18') {
  $compatibilityOut = Join-Path $out 'compatibility'
  New-Item -ItemType Directory -Force $compatibilityOut | Out-Null
  $env:HELIX_TEST_OUT = $compatibilityOut
  $env:HELIX_TEST_MODE = 'compatibility'
  & node .github/scripts/windows-startup-observer.cjs
  $compatibilityCode = $LASTEXITCODE
  Capture-UI 'compatibility-startup'
  Stop-InstalledApp
  $env:HELIX_TEST_OUT = $out
  [Environment]::SetEnvironmentVariable('HELIX_TEST_MODE',$null,'Process')
}
Get-ChildItem $profile -Recurse -File -ErrorAction SilentlyContinue | Where-Object {$_.Name -match 'startup|diagnostic|crash|\.log$' -and $_.Length -lt 10MB} | ForEach-Object {Copy-Item $_.FullName (Join-Path $out ('app-log-' + [guid]::NewGuid().ToString('N') + '-' + $_.Name))}
if ($normalFailure -or $diagnosticCode -ne 0 -or $compatibilityCode -ne 0) { throw "Startup acceptance failed; see uploaded diagnostic evidence ($diagnosticCode)." }
