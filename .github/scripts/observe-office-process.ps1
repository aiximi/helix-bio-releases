param([string]$Out,[string]$Staging,[int]$BrokerPid,[int]$Elapsed)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$report = @{at=(Get-Date).ToUniversalTime().ToString('o');brokerPid=$BrokerPid;sampleSeconds=$Elapsed}
try {
  $directory = [System.IO.Path]::GetFullPath($Staging)
  if ($directory -notmatch '\\hx-office-[^\\]+$') { throw 'Observation requires this request synthetic Office staging directory' }
  $report.staging = $directory
  if (Test-Path -LiteralPath $directory) {
    $items = @(Get-ChildItem -LiteralPath $directory -Recurse -Force -ErrorAction Stop | Select-Object -First 1500)
    $report.stagingFiles = @($items | ForEach-Object {@{path=[System.IO.Path]::GetRelativePath($directory,$_.FullName);directory=$_.PSIsContainer;bytes=if($_.PSIsContainer){0}else{$_.Length};reparsePoint=[bool]($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint)}})
    $report.stagingLogs = @($items | Where-Object {-not $_.PSIsContainer -and $_.Extension -eq '.log' -and -not ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint)} | Select-Object -First 4 | ForEach-Object {
      $stream = [System.IO.File]::Open($_.FullName,'Open','Read','ReadWrite')
      try { $buffer = [byte[]]::new(16384);$count=$stream.Read($buffer,0,$buffer.Length);@{path=[System.IO.Path]::GetRelativePath($directory,$_.FullName);prefix=[System.Text.Encoding]::UTF8.GetString($buffer,0,$count)} } finally {$stream.Dispose()}
    })
  } else { $report.stagingMissing = $true }
} catch { $report.stagingObservationError = $_.Exception.Message }
try {
  $all = @(Get-CimInstance Win32_Process)
  $related = @($all | Where-Object {$_.Name -match '^(Helix Bio\.exe|helix-office-runner\.exe|soffice\.(com|exe|bin))$'})
  $ids = @($related.ProcessId)
  $report.processes = @($related | ForEach-Object {
    $detail = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    @{name=$_.Name;pid=$_.ProcessId;parentPid=$_.ParentProcessId;commandLine=$_.CommandLine;cpuSeconds=$detail.CPU;handles=$detail.Handles;threadCount=$detail.Threads.Count;memoryBytes=$detail.WorkingSet64;responding=$detail.Responding;windowTitle=$detail.MainWindowTitle}
  })
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Out
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $report.windows = @($windows | Where-Object {$_.Current.ProcessId -in $ids} | ForEach-Object {
    $window = $_
    $texts = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    @{pid=$window.Current.ProcessId;name=$window.Current.Name;offscreen=$window.Current.IsOffscreen;bounds=$window.Current.BoundingRectangle.ToString();texts=@($texts | ForEach-Object {$_.Current.Name} | Where-Object {$_} | Select-Object -First 120)}
  })
} catch { $report.processObservationError = $_.Exception.Message }
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Out
