# watchdog.ps1
# Purpose: Monitor claude-scheduler daemon and restart if dead
# Created: 2026-04-17
# PowerShell 5.1 compatible
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1
#
# Configuration:
#   Set environment variables to override defaults, or edit the variables below.
#   CLAUDE_SCHEDULER_BASE_DIR    - Data directory (default: $HOME\.claude-scheduler)
#   CLAUDE_SCHEDULER_DIR         - Installation directory (default: directory containing this script's parent)
#   NODE_EXE                     - Path to node.exe (default: auto-detect from PATH)

# ─── Configuration (override via environment variables) ───────────────────────

# Data directory — where PID file and logs are stored
$BaseDir = if ($env:CLAUDE_SCHEDULER_BASE_DIR) {
    $env:CLAUDE_SCHEDULER_BASE_DIR
} else {
    Join-Path $HOME ".claude-scheduler"
}

# Installation directory — where claude-scheduler is installed
$SchedulerDir = if ($env:CLAUDE_SCHEDULER_DIR) {
    $env:CLAUDE_SCHEDULER_DIR
} else {
    # Default: two levels up from this script (scripts/ -> root)
    Split-Path (Split-Path $PSCommandPath -Parent) -Parent
}

# Node executable path
$NodeExe = if ($env:NODE_EXE) {
    $env:NODE_EXE
} else {
    # Try to find node in PATH first
    $nodeInPath = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeInPath) {
        $nodeInPath.Source
    } else {
        # Common Windows install locations
        $candidates = @(
            "$env:ProgramFiles\nodejs\node.exe",
            "${env:ProgramFiles(x86)}\nodejs\node.exe",
            "C:\Program Files\nodejs\node.exe",
            "D:\nodejs\node.exe"
        )
        $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($found) { $found } else { "node" }
    }
}

# Derived paths
$PidFile    = Join-Path $BaseDir "scheduler.pid"
$LogDir     = Join-Path $BaseDir "logs"
$LockFile   = Join-Path $BaseDir ".watchdog.lock"
$EntryPoint = Join-Path $SchedulerDir "bin\claude-scheduler.js"

# ─── Logging ──────────────────────────────────────────────────────────────────

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogDate   = Get-Date -Format "yyyy-MM-dd"
    $LogFile   = Join-Path $LogDir ("watchdog-" + $LogDate + ".log")
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    $Line = "[$Timestamp] [$Level] $Message"
    Add-Content -Path $LogFile -Value $Line -Encoding UTF8
    Write-Host $Line
}

# ─── Main ─────────────────────────────────────────────────────────────────────

# Multi-instance prevention via lock file
if (Test-Path $LockFile) {
    $LockPid = Get-Content $LockFile -ErrorAction SilentlyContinue
    if ($LockPid -and ($LockPid -match "^\d+$")) {
        $LockProc = Get-Process -Id ([int]$LockPid) -ErrorAction SilentlyContinue
        if ($LockProc) { exit 0 }
    }
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
$MyPid = $PID
Set-Content -Path $LockFile -Value $MyPid -Encoding ASCII

try {

    if (-not (Test-Path $PidFile)) {
        Write-Log "PID file not found: $PidFile" "WARN"
        $NeedRestart = $true
    } else {
        $RawPid = Get-Content $PidFile -ErrorAction SilentlyContinue
        $DaemonPid = $null
        if ($RawPid -and ($RawPid -match "^\d+$")) {
            $DaemonPid = [int]$RawPid
        }
        if ($null -eq $DaemonPid) {
            Write-Log "Invalid PID file content: $RawPid" "WARN"
            $NeedRestart = $true
        } else {
            $Proc = Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue
            if ($Proc) {
                Write-Log "Daemon is alive (PID: $DaemonPid)" "INFO"
                $NeedRestart = $false
            } else {
                Write-Log "Daemon is dead (PID $DaemonPid not found)" "WARN"
                $NeedRestart = $true
            }
        }
    }

    if ($NeedRestart) {
        Write-Log "=== RESTART: Launching claude-scheduler daemon ===" "WARN"

        if (-not (Test-Path $NodeExe) -and $NodeExe -ne "node") {
            Write-Log "node.exe not found: $NodeExe" "ERROR"
            exit 1
        }
        if (-not (Test-Path $EntryPoint)) {
            Write-Log "Entry point not found: $EntryPoint" "ERROR"
            exit 1
        }

        $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
        $StartInfo.FileName               = $NodeExe
        $StartInfo.Arguments              = ("`"" + $EntryPoint + "`" start --daemon")
        $StartInfo.WorkingDirectory       = $SchedulerDir
        $StartInfo.UseShellExecute        = $false
        $StartInfo.CreateNoWindow         = $true
        $StartInfo.RedirectStandardOutput = $false
        $StartInfo.RedirectStandardError  = $false

        $NewProc = [System.Diagnostics.Process]::Start($StartInfo)
        if ($NewProc) {
            Write-Log "Launcher started (PID: $($NewProc.Id))" "INFO"
        } else {
            Write-Log "Process launch failed" "ERROR"
            exit 1
        }

        $MaxWait  = 20
        $Waited   = 0
        $Interval = 2
        $NewDaemonPid = $null

        while ($Waited -lt $MaxWait) {
            Start-Sleep -Seconds $Interval
            $Waited += $Interval
            if (Test-Path $PidFile) {
                $UpdatedPid = Get-Content $PidFile -ErrorAction SilentlyContinue
                if ($UpdatedPid -and ($UpdatedPid -match "^\d+$")) {
                    $CheckProc = Get-Process -Id ([int]$UpdatedPid) -ErrorAction SilentlyContinue
                    if ($CheckProc) {
                        $NewDaemonPid = [int]$UpdatedPid
                        break
                    }
                }
            }
        }

        if ($NewDaemonPid) {
            Write-Log "=== RESTART SUCCESS: New daemon PID=$NewDaemonPid ===" "INFO"
        } else {
            Write-Log "Restart timeout (${MaxWait}s). Daemon may still be starting." "WARN"
        }
    }

} finally {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
