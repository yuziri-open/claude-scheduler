# register-watchdog-task.ps1
# Purpose: Register watchdog.ps1 as a Windows Task Scheduler job
#          Runs every 5 minutes and on logon to ensure the daemon stays alive.
#
# Usage (run as the user who will own the task):
#   powershell -ExecutionPolicy Bypass -File scripts\register-watchdog-task.ps1
#
# The script auto-detects paths from its own location — no manual editing needed.

$TaskName    = "ClaudeSchedulerWatchdog"

# Resolve paths relative to this script
$ScriptDir   = Split-Path $PSCommandPath -Parent
$WatchdogPs1 = Join-Path $ScriptDir "watchdog.ps1"
$UserSid     = "$env:USERDOMAIN\$env:USERNAME"
$ArgsVal     = "-ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File `"$WatchdogPs1`""

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] $msg"
}

Log "Start: $TaskName registration"
Log "Watchdog script: $WatchdogPs1"
Log "User: $UserSid"

if (-not (Test-Path $WatchdogPs1)) {
    Log "ERROR: watchdog.ps1 not found at $WatchdogPs1"
    exit 1
}

# Delete existing task
schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null
Log "Cleaned up existing task"

# Build XML using XmlDocument API
$xml = New-Object System.Xml.XmlDocument
$ns  = "http://schemas.microsoft.com/windows/2004/02/mit/task"

function AddElem($parent, $name, $value) {
    $e = $xml.CreateElement($name, $ns)
    if ($value -ne $null) { $e.InnerText = [string]$value }
    [void]$parent.AppendChild($e)
    return $e
}

$decl = $xml.CreateXmlDeclaration("1.0","UTF-16",$null)
[void]$xml.AppendChild($decl)

$task = $xml.CreateElement("Task", $ns)
$task.SetAttribute("version","1.2")
[void]$xml.AppendChild($task)

# RegistrationInfo
$ri = AddElem $task "RegistrationInfo" $null
[void](AddElem $ri "Description" "claude-scheduler daemon watchdog. Checks PID every 5 min, auto-restarts if dead.")
[void](AddElem $ri "Author" $UserSid)

# Triggers
$triggers = AddElem $task "Triggers" $null
$lt = $xml.CreateElement("LogonTrigger", $ns)
[void](AddElem $lt "Enabled" "true")
[void](AddElem $lt "UserId"  $UserSid)
[void]$triggers.AppendChild($lt)
$tt = $xml.CreateElement("TimeTrigger", $ns)
[void](AddElem $tt "Enabled"       "true")
[void](AddElem $tt "StartBoundary" (Get-Date -Format "yyyy-MM-ddTHH:mm:ss"))
$rep = AddElem $tt "Repetition" $null
[void](AddElem $rep "Interval"          "PT5M")
[void](AddElem $rep "StopAtDurationEnd" "false")
[void]$triggers.AppendChild($tt)

# Principals
$principals = AddElem $task "Principals" $null
$principal  = $xml.CreateElement("Principal", $ns)
$principal.SetAttribute("id","Author")
[void](AddElem $principal "UserId"    $UserSid)
[void](AddElem $principal "LogonType" "InteractiveToken")
[void](AddElem $principal "RunLevel"  "LeastPrivilege")
[void]$principals.AppendChild($principal)

# Settings
$settings = AddElem $task "Settings" $null
[void](AddElem $settings "MultipleInstancesPolicy"    "IgnoreNew")
[void](AddElem $settings "DisallowStartIfOnBatteries"  "false")
[void](AddElem $settings "StopIfGoingOnBatteries"      "false")
[void](AddElem $settings "AllowHardTerminate"          "true")
[void](AddElem $settings "StartWhenAvailable"          "true")
[void](AddElem $settings "RunOnlyIfNetworkAvailable"   "false")
[void](AddElem $settings "AllowStartOnDemand"          "true")
[void](AddElem $settings "Enabled"                     "true")
[void](AddElem $settings "Hidden"                      "false")
[void](AddElem $settings "RunOnlyIfIdle"               "false")
[void](AddElem $settings "ExecutionTimeLimit"          "PT3M")
[void](AddElem $settings "Priority"                    "7")

# Actions
$actions = $xml.CreateElement("Actions", $ns)
$actions.SetAttribute("Context","Author")
$exec = AddElem $actions "Exec" $null
[void](AddElem $exec "Command"   "powershell.exe")
[void](AddElem $exec "Arguments" $ArgsVal)
[void]$task.AppendChild($actions)

# Write XML (UTF-16 LE with BOM)
$tmpXml = Join-Path $env:TEMP "claude-watchdog-task.xml"
$sw = New-Object System.IO.StreamWriter($tmpXml, $false, [System.Text.Encoding]::Unicode)
$xml.Save($sw)
$sw.Close()
Log "XML written: $tmpXml"

# Register via schtasks
$out = schtasks /Create /TN $TaskName /XML $tmpXml /F 2>&1
Log "schtasks: $out"
$rc = $LASTEXITCODE
Remove-Item $tmpXml -Force -ErrorAction SilentlyContinue

if ($rc -ne 0) { Log "FAILED (exit $rc)"; exit 1 }

# Verify
Log "=== Verify ==="
$v = schtasks /Query /TN $TaskName /FO LIST 2>&1
$v | ForEach-Object { Log "  $_" }
Log "SUCCESS: $TaskName registered. It will run every 5 minutes and on logon."
