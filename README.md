# claude-scheduler

Persistent local cron scheduler for Claude Code — no 7-day expiry.

## Why

Claude Code's built-in `CronCreate` tool expires after 7 days and only survives within a session.
**claude-scheduler** solves this by running as a local daemon process that persists across sessions and reboots. Jobs are stored in `~/.claude-scheduler/scheduled-tasks.json` and survive indefinitely.

## Features

- **Persistent** — jobs survive session restarts; stored in `~/.claude-scheduler/scheduled-tasks.json`
- **Local execution** — no cloud dependency; runs on your machine while it is awake
- **Simple CLI** — `add`, `list`, `remove`, `run`, `start`, `status`, `serve` commands
- **Daemon mode** — detached background process with PID file management
- **Structured logging** — per-job logs at `~/.claude-scheduler/logs/YYYY-MM-DD/job-name.log`
- **Web dashboard** — built-in HTTP dashboard at `http://localhost:3060`
- **Windows watchdog** — optional PowerShell watchdog script + Task Scheduler registration for auto-restart on reboot

## Requirements

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/claude-code) — the `claude` command must be in your PATH

## Installation

### Option A: Clone and link globally

```bash
git clone https://github.com/iorifuseya/claude-scheduler.git
cd claude-scheduler
npm install
npm link
```

### Option B: Use directly without installing

```bash
git clone https://github.com/iorifuseya/claude-scheduler.git
cd claude-scheduler
npm install
node bin/claude-scheduler.js --help
```

## Usage

### `start` — Start the scheduler

```bash
# Foreground (stop with Ctrl+C)
claude-scheduler start

# Background daemon
claude-scheduler start --daemon
```

### `add` — Register a job

```bash
# Inline prompt
claude-scheduler add \
  --name "daily-summary" \
  --cron "0 9 * * 1-5" \
  --prompt "Summarize yesterday's work and list today's priorities."

# Prompt from a file (recommended for long prompts)
claude-scheduler add \
  --name "daily-summary" \
  --cron "0 9 * * 1-5" \
  --prompt-file ./prompts/daily-summary.md

# Customize allowed tools and model
claude-scheduler add \
  --name "daily-summary" \
  --cron "0 9 * * 1-5" \
  --prompt-file ./prompts/daily-summary.md \
  --allowed-tools "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch" \
  --model "claude-opus-4-5"

# Run in a specific project directory
claude-scheduler add \
  --name "build-check" \
  --cron "*/30 * * * *" \
  --prompt "Run tests and report results." \
  --project ~/my-project
```

**Common cron expressions:**

| Expression | Meaning |
|------------|---------|
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `17 4 * * *` | Every day at 04:17 |
| `0 */6 * * *` | Every 6 hours |
| `0 0 1 * *` | 1st of every month at 00:00 |

### `list` — List registered jobs

```bash
claude-scheduler list
```

Example output:

```
Registered jobs: 2

┌── daily-summary
│   cron: 0 9 * * 1-5
│   status: ENABLED
│   lastRun: 4/19/2026, 09:00
│   lastResult: success
│   runCount: 12
│   promptFile: /home/user/prompts/daily-summary.md
└── allowedTools: Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch
```

### `remove` — Delete a job

```bash
claude-scheduler remove --name "daily-summary"
```

### `run` — Manually trigger a job (for testing)

```bash
claude-scheduler run --name "daily-summary"
```

### `status` — Check daemon status

```bash
claude-scheduler status
```

### `serve` — Open the web dashboard

```bash
# Default port 3060
claude-scheduler serve

# Custom port
claude-scheduler serve --port 3070
```

Then open `http://localhost:3060` in your browser to see job status, next run times, and logs.

## Configuration

All runtime data is stored under `~/.claude-scheduler/`:

| Path | Purpose |
|------|---------|
| `~/.claude-scheduler/scheduled-tasks.json` | Job definitions |
| `~/.claude-scheduler/logs/YYYY-MM-DD/job-name.log` | Per-job execution logs |
| `~/.claude-scheduler/scheduler.pid` | Daemon PID file |

### Job definition schema (`scheduled-tasks.json`)

```json
{
  "jobs": [
    {
      "name": "daily-summary",
      "cron": "0 9 * * 1-5",
      "promptFile": "/absolute/path/to/prompts/daily-summary.md",
      "allowedTools": "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch",
      "model": "claude-sonnet-4-5",
      "project": "/home/user/my-project",
      "enabled": true,
      "createdAt": "2026-04-10T00:00:00.000Z",
      "lastRun": "2026-04-19T00:00:00.000Z",
      "lastResult": "success",
      "runCount": 12
    }
  ]
}
```

### Prompt files

Store your prompt files anywhere and reference them with `--prompt-file`. A sample is included at [`prompts/example-daily-report.md`](prompts/example-daily-report.md).

### Windows: Auto-restart with watchdog (optional)

The `scripts/` directory contains PowerShell helpers for Windows users who want the daemon to survive reboots:

```powershell
# 1. Register a Task Scheduler job that runs watchdog every 5 minutes
powershell -ExecutionPolicy Bypass -File scripts\register-watchdog-task.ps1

# 2. The watchdog checks the daemon PID and restarts it if dead
#    It auto-detects paths — no editing required
```

The watchdog respects these environment variables if you need to override defaults:

| Variable | Default |
|----------|---------|
| `CLAUDE_SCHEDULER_BASE_DIR` | `%USERPROFILE%\.claude-scheduler` |
| `CLAUDE_SCHEDULER_DIR` | Parent directory of `scripts\` |
| `NODE_EXE` | `node` from PATH, or common install locations |

> **Cross-platform note:** The core scheduler (`bin/`, `src/`) works on macOS, Linux, and Windows. The watchdog scripts (`scripts/*.ps1`) are Windows-only. On macOS/Linux, use `launchd` or `systemd` to achieve the same auto-restart behavior.

## How it works

1. `start` launches a Node.js process that loads `~/.claude-scheduler/scheduled-tasks.json`
2. Each enabled job is registered with [node-cron](https://github.com/node-cron/node-cron)
3. At the scheduled time, the job's prompt is resolved (inline or from file)
4. `claude -p --allowedTools "..." [prompt]` is executed as a child process
5. stdout/stderr are captured and written to the log file
6. `lastRun`, `lastResult`, and `runCount` are updated in `scheduled-tasks.json`

**Behavior guarantees:**
- No retry on failure — waits until the next scheduled time
- Graceful shutdown on `SIGINT` / `SIGTERM`
- Double-start prevention via PID file check
- 30-minute timeout per job execution

## Limitations

- **Sleep-aware**: jobs will not fire while the machine is asleep; they are skipped, not queued
- **Local only**: requires the machine to be running at the scheduled time
- **Claude CLI required**: `claude` must be in PATH and authenticated

## License

MIT License — Copyright (c) 2026 Iori Fuseya

See [LICENSE](LICENSE) for full text.
