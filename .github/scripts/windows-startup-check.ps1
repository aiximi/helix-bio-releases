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
& curl.exe -fL --retry 3 --output $installer $url
if ($LASTEXITCODE -ne 0) { throw 'Installer download failed' }
$actualHash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $env:EXPECTED_SHA256.ToLowerInvariant()) { throw 'Installer hash mismatch' }
@{tag=$env:RELEASE_TAG;url=$url;sha256=$actualHash;size=(Get-Item $installer).Length;os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture);cpu=(Get-CimInstance Win32_Processor | Select-Object Name,Architecture,NumberOfCores);memory=(Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory);installDirectory=$install;nodeVersion=(& node --version)} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $out 'system.json')
$p = Start-Process -FilePath $installer -ArgumentList "/S /D=$install" -PassThru
if (-not $p.WaitForExit(300000)) { throw "Installer did not exit within five minutes" }
$p.Refresh()
@{exitCode=$p.ExitCode} | ConvertTo-Json | Set-Content (Join-Path $out 'installation.json')
if ($p.ExitCode -ne 0) { throw "Installer exited $($p.ExitCode)" }
$exe = Join-Path $install 'Helix Bio.exe'
if (-not (Test-Path $exe)) { Get-ChildItem $install | Out-String | Set-Content (Join-Path $out 'installed-files.txt'); throw 'Installed normal entry point missing' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Capture-UI([string]$Name) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $image = [System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$image.Size)
  $image.Save((Join-Path $out "$Name.png"))
  $graphics.Dispose(); $image.Dispose()
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  foreach ($window in $windows) {
    if ($window.Current.Name -match 'Helix|Error|错误|启动') {
      $texts = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      $items += @{name=$window.Current.Name;processId=$window.Current.ProcessId;texts=@($texts | ForEach-Object {$_.Current.Name} | Where-Object {$_} | Select-Object -First 300)}
    }
  }
  $items | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $out "$Name-ui.json")
}
function Stop-InstalledApp {
  Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($install,[System.StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
  Start-Sleep -Seconds 2
}
Stop-InstalledApp
$normal = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 25
Capture-UI 'normal-startup'
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
Get-ChildItem $profile -Recurse -File -ErrorAction SilentlyContinue | Where-Object {$_.Name -match 'startup|diagnostic|crash|\.log$' -and $_.Length -lt 10MB} | ForEach-Object {Copy-Item $_.FullName (Join-Path $out ('app-log-' + [guid]::NewGuid().ToString('N') + '-' + $_.Name))}
if ($diagnosticCode -ne 0) { throw "Startup acceptance failed; see uploaded diagnostic evidence ($diagnosticCode)." }
