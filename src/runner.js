// Executes claude CLI jobs and records results

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log, logJobResult } from './logger.js';
import { updateJobResult } from './store.js';

// Default allowed tools
const DEFAULT_ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';

// Timeout: 30 minutes
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Resolve the prompt string for a job.
 * If promptFile is specified, reads from that file.
 * @param {Object} job - job definition
 * @returns {string} prompt string
 */
function resolvePrompt(job) {
  if (job.promptFile) {
    const filePath = path.resolve(job.promptFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`promptFile not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8');
  }
  if (job.prompt) {
    return job.prompt;
  }
  throw new Error(`Job "${job.name}" has no prompt or promptFile configured`);
}

/**
 * Resolve the path to the claude CLI binary.
 * @returns {string} path to the claude command
 */
function getClaudePath() {
  // Common locations on Unix-like systems
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    'claude', // fallback: search PATH
  ];

  for (const c of candidates) {
    if (c === 'claude') return c; // fallback
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}

/**
 * Build the environment for spawning the claude CLI.
 * On Windows, auto-detects CLAUDE_CODE_GIT_BASH_PATH if not already set.
 * @returns {Object} environment variables object
 */
function getEnv() {
  const env = { ...process.env };

  // Nothing to do if already configured
  if (env.CLAUDE_CODE_GIT_BASH_PATH) {
    return env;
  }

  // On Windows, auto-detect git-bash path.
  // Note: CLAUDE_CODE_GIT_BASH_PATH must use backslashes.
  if (process.platform === 'win32' || process.env.OS === 'Windows_NT') {
    // fs.existsSync accepts forward slashes, but the env var needs backslashes
    const candidates = [
      { check: 'D:/Git/usr/bin/bash.exe', value: String.raw`D:\Git\usr\bin\bash.exe` },
      { check: 'C:/Program Files/Git/usr/bin/bash.exe', value: String.raw`C:\Program Files\Git\usr\bin\bash.exe` },
      { check: 'C:/Git/usr/bin/bash.exe', value: String.raw`C:\Git\usr\bin\bash.exe` },
    ];
    for (const c of candidates) {
      if (fs.existsSync(c.check)) {
        env.CLAUDE_CODE_GIT_BASH_PATH = c.value;
        break;
      }
    }
  }

  return env;
}

/**
 * Execute a job.
 * @param {Object} job - job definition
 * @returns {{ success: boolean, stdout: string, stderr: string, durationMs: number }}
 */
export async function runJob(job) {
  const startTime = Date.now();
  log(job.name, 'INFO', `Starting: cron="${job.cron || 'manual'}"`);

  let prompt;
  try {
    prompt = resolvePrompt(job);
  } catch (err) {
    log(job.name, 'ERROR', `Failed to resolve prompt: ${err.message}`);
    updateJobResult(job.name, false);
    return { success: false, stdout: '', stderr: err.message, durationMs: Date.now() - startTime };
  }

  const allowedTools = job.allowedTools || DEFAULT_ALLOWED_TOOLS;
  const claudePath = getClaudePath();

  // Build command arguments for the claude CLI.
  // Prompt must come first: claude [prompt] -p --allowedTools "..."
  const args = [
    prompt,
    '-p',
    '--allowedTools', allowedTools,
  ];

  // Optional: model override
  if (job.model) {
    args.push('--model', job.model);
  }

  // Optional: project directory.
  // The claude CLI has no --project flag; we pass it as spawnSync cwd instead.
  // job.project accepts: absolute path, "~/<name>", or "<name>" (resolved under $HOME).
  let cwd;
  if (job.project) {
    if (path.isAbsolute(job.project)) {
      cwd = job.project;
    } else if (job.project.startsWith('~')) {
      cwd = path.join(os.homedir(), job.project.slice(1).replace(/^[\\/]+/, ''));
    } else {
      cwd = path.join(os.homedir(), job.project);
    }
    if (!fs.existsSync(cwd)) {
      log(job.name, 'WARN', `project directory not found: ${cwd} — skipping cwd`);
      cwd = undefined;
    }
  }

  log(job.name, 'INFO', `Executing: ${claudePath} -p --allowedTools "${allowedTools}"${cwd ? ` [cwd=${cwd}]` : ''} [prompt: ${prompt.slice(0, 50)}...]`);

  let stdout = '';
  let stderr = '';
  let success = false;

  try {
    const env = getEnv();
    const spawnOpts = {
      timeout: DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env,
    };
    if (cwd) spawnOpts.cwd = cwd;
    const result = spawnSync(claudePath, args, spawnOpts);

    stdout = result.stdout || '';
    stderr = result.stderr || '';

    if (result.error) {
      // spawnSync returned an error (command not found, timeout, etc.)
      stderr = result.error.message;
      success = false;
    } else if (result.status === 0) {
      success = true;
    } else {
      success = false;
    }

    const durationMs = Date.now() - startTime;
    const durationSec = (durationMs / 1000).toFixed(1);

    if (success) {
      log(job.name, 'INFO', `Completed (${durationSec}s)`);
    } else {
      const errPreview = (stderr || stdout).slice(0, 200);
      log(job.name, 'ERROR', `Failed (${durationSec}s) exit=${result.status}: ${errPreview}`);
    }

    logJobResult(job.name, stdout, stderr, success);
    updateJobResult(job.name, success);

    return { success, stdout, stderr, durationMs };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    log(job.name, 'ERROR', `Unexpected error: ${err.message}`);
    logJobResult(job.name, '', err.message, false);
    updateJobResult(job.name, false);
    return { success: false, stdout: '', stderr: err.message, durationMs };
  }
}
