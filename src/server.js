// Local dashboard HTTP server for claude-scheduler

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listJobs, getStorePath } from './store.js';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');
const PID_FILE = path.join(BASE_DIR, 'scheduler.pid');

// ─────────────────────────────────────────────
// Lightweight cron expression parser
// Supported patterns: "M H * * *" / "M H1,H2,H3 * * *"
// ─────────────────────────────────────────────

/**
 * Convert a cron expression to a human-readable string.
 * @param {string} cronExpr - 5-field cron expression (min hour dom month dow)
 * @returns {string} human-readable description
 */
function cronToHuman(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return cronExpr;

  const [min, hour, dom, month, dow] = parts;

  // Daily pattern (dom=* month=* dow=*)
  if (dom === '*' && month === '*' && dow === '*') {
    if (!hour.includes(',') && !hour.includes('-') && !hour.includes('/')) {
      // Single time: "17 4 * * *" → "Daily at 4:17"
      return `Daily at ${hour}:${min.padStart(2, '0')}`;
    }
    if (hour.includes(',')) {
      // Multiple hours: "0 9,12,15,18 * * *" → "Daily at 9,12,15,18"
      return `Daily at ${hour}`;
    }
    if (hour.includes('/')) {
      // Interval: "0 */3 * * *" → "Every 3 hours"
      const interval = hour.split('/')[1];
      return `Every ${interval} hour(s)`;
    }
  }

  // Day-of-week pattern
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (dow !== '*' && dom === '*' && month === '*') {
    if (!dow.includes(',') && !dow.includes('-')) {
      const dayNum = parseInt(dow, 10);
      const dayName = dayNames[dayNum] || dow;
      if (!hour.includes(',')) {
        return `Weekly ${dayName} at ${hour}:${min.padStart(2, '0')}`;
      }
    }
  }

  // Fallback: return the raw expression
  return cronExpr;
}

/**
 * Calculate the next run time for a cron expression.
 * Supported patterns: "M H * * *" / "M H1,H2,H3 * * *"
 * @param {string} cronExpr
 * @returns {string|null} ISO string or null if not computable
 */
function calcNextRun(cronExpr) {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const [minStr, hourStr, dom, month, dow] = parts;

    // Get current time in JST (UTC+9)
    const nowUtc = Date.now();
    const jstOffset = 9 * 60 * 60 * 1000;
    const nowJst = new Date(nowUtc + jstOffset);

    const currentMin = nowJst.getUTCMinutes();
    const currentHour = nowJst.getUTCHours();

    // Build the list of target hours
    let targetHours = [];
    if (hourStr.includes(',')) {
      targetHours = hourStr.split(',').map(h => parseInt(h.trim(), 10));
    } else if (!hourStr.includes('*') && !hourStr.includes('/') && !hourStr.includes('-')) {
      targetHours = [parseInt(hourStr, 10)];
    } else {
      // Complex patterns are not supported
      return null;
    }

    const targetMin = parseInt(minStr, 10);
    if (isNaN(targetMin)) return null;

    // Find the next occurrence today
    for (const h of targetHours.sort((a, b) => a - b)) {
      if (h > currentHour || (h === currentHour && targetMin > currentMin)) {
        // Next run is today at h:targetMin
        const next = new Date(nowJst);
        next.setUTCHours(h, targetMin, 0, 0);
        // Convert back from JST to UTC
        return new Date(next.getTime() - jstOffset).toISOString();
      }
    }

    // All slots today have passed — use the first slot tomorrow
    const firstHour = targetHours.sort((a, b) => a - b)[0];
    const next = new Date(nowJst);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(firstHour, targetMin, 0, 0);
    return new Date(next.getTime() - jstOffset).toISOString();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Daemon status
// ─────────────────────────────────────────────

/**
 * Check whether the daemon is running.
 * @returns {{ running: boolean, pid: number|null }}
 */
function getDaemonStatus() {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false, pid: null };
  }

  try {
    const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return { running: false, pid: null };

    // Signal 0 checks process existence without sending a real signal
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

// ─────────────────────────────────────────────
// /api/status response builder
// ─────────────────────────────────────────────

/**
 * Build the status JSON response.
 * @returns {Object}
 */
function buildStatus() {
  const daemon = getDaemonStatus();
  const rawJobs = listJobs();

  const jobs = rawJobs.map(job => ({
    name: job.name,
    cron: job.cron,
    cronHuman: cronToHuman(job.cron),
    enabled: job.enabled !== false,
    lastRun: job.lastRun || null,
    lastResult: job.lastResult || null,
    runCount: job.runCount || 0,
    nextRun: calcNextRun(job.cron),
  }));

  return {
    daemon,
    jobs,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// /api/log endpoint: fetch latest log
// ─────────────────────────────────────────────

/**
 * Retrieve the most recent log for a job.
 * @param {string} jobName
 * @returns {string} log content, or an error message if not found
 */
function getLatestLog(jobName) {
  const logsDir = path.join(BASE_DIR, 'logs');
  if (!fs.existsSync(logsDir)) return 'Log directory not found.';

  // Sort date directories descending (newest first)
  let dateDirs;
  try {
    dateDirs = fs.readdirSync(logsDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
  } catch {
    return 'Failed to read log directory.';
  }

  for (const dateDir of dateDirs) {
    const logFile = path.join(logsDir, dateDir, `${jobName}.log`);
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        // Return only the last 5000 characters for very large files
        if (content.length > 5000) {
          return '...(truncated)...\n' + content.slice(-5000);
        }
        return content || '(log is empty)';
      } catch {
        return 'Failed to read log file.';
      }
    }
  }

  return `No log found for "${jobName}".`;
}

// ─────────────────────────────────────────────
// HTML dashboard (embedded template literal)
// ─────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>claude-scheduler</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {}
      }
    }
  </script>
  <style>
    body { font-family: 'Segoe UI', sans-serif; }
    .log-modal { display: none; }
    .log-modal.open { display: flex; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
</head>
<body class="dark bg-gray-950 text-gray-100 min-h-screen">

  <!-- Header -->
  <header class="border-b border-gray-800 px-6 py-4">
    <div class="max-w-4xl mx-auto flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-2xl">&#x2699;&#xFE0F;</span>
        <h1 class="text-xl font-bold text-gray-100">claude-scheduler</h1>
      </div>
      <div id="daemon-badge" class="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-gray-800 text-gray-400">
        <span class="w-2 h-2 rounded-full bg-gray-500"></span>
        <span>Checking...</span>
      </div>
    </div>
  </header>

  <!-- Main content -->
  <main class="max-w-4xl mx-auto px-6 py-6">

    <!-- Summary bar -->
    <div class="flex items-center gap-4 mb-6 text-sm text-gray-400">
      <span id="job-count">Jobs: loading...</span>
      <span class="text-gray-700">|</span>
      <span id="refresh-countdown" class="text-gray-500">Next refresh: 30s</span>
    </div>

    <!-- Job card list -->
    <div id="jobs-container" class="space-y-3">
      <div class="text-gray-500 text-center py-12">
        <div class="inline-block w-6 h-6 border-2 border-gray-600 border-t-blue-500 rounded-full spin mb-3"></div>
        <p>Loading...</p>
      </div>
    </div>

  </main>

  <!-- Footer -->
  <footer class="border-t border-gray-800 px-6 py-4 mt-8">
    <div class="max-w-4xl mx-auto flex items-center justify-between text-xs text-gray-500">
      <span id="last-updated">Last updated: -</span>
      <span>Auto-refresh: every 30s</span>
    </div>
  </footer>

  <!-- Log modal -->
  <div id="log-modal" class="log-modal fixed inset-0 bg-black/70 items-center justify-center z-50 p-4">
    <div class="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-700">
        <h2 id="modal-title" class="font-semibold text-gray-100">Log</h2>
        <button onclick="closeModal()" class="text-gray-400 hover:text-gray-200 text-xl leading-none">&times;</button>
      </div>
      <div class="overflow-auto p-5 flex-1">
        <pre id="modal-log" class="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-5"></pre>
      </div>
    </div>
  </div>

  <script>
    let countdown = 30;
    let countdownTimer = null;

    // Format an ISO date string for display (local timezone)
    function fmtDate(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      return d.toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    // Format the current time for display
    function nowStr() {
      return new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    // Result icon badge
    function resultBadge(result) {
      if (!result) return '<span class="text-gray-500 text-lg" title="Never run">&#x23F3;</span>';
      if (result === 'success') return '<span class="text-green-400 text-lg" title="Success">&#x2705;</span>';
      return '<span class="text-red-400 text-lg" title="Error">&#x274C;</span>';
    }

    // Enabled/disabled badge
    function enabledBadge(enabled) {
      if (enabled) {
        return '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/50 text-green-400 border border-green-800">Enabled</span>';
      }
      return '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-500 border border-gray-700">Disabled</span>';
    }

    // Render a job card
    function renderJobCard(job) {
      const lastRunStr = job.lastRun ? fmtDate(job.lastRun) : 'Never';
      const nextRunStr = job.nextRun ? fmtDate(job.nextRun) : '-';
      const resultIcon = resultBadge(job.lastResult);
      const badge = enabledBadge(job.enabled);

      return \`
        <div
          class="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-600 transition-colors"
          onclick="openLog('\${job.name}')"
          title="Click to view log"
        >
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center gap-2">
              \${resultIcon}
              <h3 class="font-semibold text-gray-100">\${job.name}</h3>
              \${badge}
            </div>
            <span class="text-xs text-gray-500 font-mono">\${job.cron}</span>
          </div>

          <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">Schedule</span>
              <span class="text-gray-200">\${job.cronHuman}</span>
            </div>
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">Next run</span>
              <span class="text-blue-300">\${nextRunStr}</span>
            </div>
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">Last run</span>
              <span class="text-gray-300">\${lastRunStr}</span>
            </div>
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">Run count</span>
              <span class="text-gray-300">\${job.runCount}</span>
            </div>
          </div>
        </div>
      \`;
    }

    // Fetch status from API and update the UI
    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        // Daemon badge
        const daemonBadge = document.getElementById('daemon-badge');
        if (data.daemon.running) {
          daemonBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-green-900/50 text-green-400 border border-green-800';
          daemonBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-400"></span><span>Running (PID: ' + data.daemon.pid + ')</span>';
        } else {
          daemonBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-red-900/50 text-red-400 border border-red-800';
          daemonBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-400"></span><span>Stopped</span>';
        }

        // Job count summary
        const enabledCount = data.jobs.filter(j => j.enabled).length;
        document.getElementById('job-count').textContent =
          'Jobs: ' + data.jobs.length + ' (' + enabledCount + ' enabled)';

        // Job cards
        const container = document.getElementById('jobs-container');
        if (data.jobs.length === 0) {
          container.innerHTML = '<p class="text-gray-500 text-center py-12">No jobs registered</p>';
        } else {
          container.innerHTML = data.jobs.map(renderJobCard).join('');
        }

        // Last updated timestamp
        document.getElementById('last-updated').textContent = 'Last updated: ' + nowStr();

      } catch (err) {
        console.error('Status fetch error:', err);
        document.getElementById('jobs-container').innerHTML =
          '<p class="text-red-400 text-center py-12">Data fetch error: ' + err.message + '</p>';
      }
    }

    // Countdown timer for auto-refresh
    function startCountdown() {
      if (countdownTimer) clearInterval(countdownTimer);
      countdown = 30;
      countdownTimer = setInterval(() => {
        countdown--;
        document.getElementById('refresh-countdown').textContent = 'Next refresh: ' + countdown + 's';
        if (countdown <= 0) {
          fetchStatus();
          countdown = 30;
        }
      }, 1000);
    }

    // Open the log modal for a job
    async function openLog(jobName) {
      document.getElementById('modal-title').textContent = jobName + ' — latest log';
      document.getElementById('modal-log').textContent = 'Loading...';
      document.getElementById('log-modal').classList.add('open');

      try {
        const res = await fetch('/api/log?name=' + encodeURIComponent(jobName));
        const text = await res.text();
        document.getElementById('modal-log').textContent = text;
      } catch (err) {
        document.getElementById('modal-log').textContent = 'Log fetch error: ' + err.message;
      }
    }

    // Close the log modal
    function closeModal() {
      document.getElementById('log-modal').classList.remove('open');
    }

    // Close modal on Escape key
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });

    // Close modal when clicking the backdrop
    document.getElementById('log-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('log-modal')) closeModal();
    });

    // Initialize
    fetchStatus();
    startCountdown();
  </script>
</body>
</html>`;

// ─────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────

/**
 * Parse URL query parameters.
 * @param {string} search - URL search string (e.g. ?name=foo)
 * @returns {Object}
 */
function parseQuery(search) {
  const params = {};
  if (!search || !search.startsWith('?')) return params;
  search.slice(1).split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return params;
}

/**
 * Start the dashboard HTTP server.
 * @param {number} port - port to listen on
 */
export function startServer(port = 3060) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS — local use only
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && pathname === '/') {
      // HTML dashboard
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);

    } else if (req.method === 'GET' && pathname === '/api/status') {
      // JSON status API
      try {
        const status = buildStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }

    } else if (req.method === 'GET' && pathname === '/api/log') {
      // Job log endpoint
      const query = parseQuery(url.search);
      const jobName = query['name'];
      if (!jobName) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('name parameter is required');
        return;
      }
      const logContent = getLatestLog(jobName);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(logContent);

    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`claude-scheduler dashboard started`);
    console.log(`URL: http://localhost:${port}`);
    console.log(`API: http://localhost:${port}/api/status`);
    console.log('Press Ctrl+C to stop');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${port} is already in use`);
      console.error(`Try a different port: node bin/claude-scheduler.js serve --port 3070`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  return server;
}
