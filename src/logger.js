// Logging — writes per-job stdout/stderr to ~/.claude-scheduler/logs/YYYY-MM-DD/job-name.log

import fs from 'fs';
import path from 'path';
import os from 'os';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');

/**
 * Resolve the log file path for a job, using UTC+9 (JST) for the date partition.
 * @param {string} jobName
 * @returns {string} absolute log file path
 */
function getLogPath(jobName) {
  const now = new Date();
  // Compute date in JST (UTC+9)
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstDate = new Date(now.getTime() + jstOffset);
  const dateStr = jstDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const logDir = path.join(BASE_DIR, 'logs', dateStr);
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `${jobName}.log`);
}

/**
 * Append a log line to the job's log file and echo to stdout.
 * @param {string} jobName
 * @param {string} level - INFO / WARN / ERROR
 * @param {string} message
 */
export function log(jobName, level, message) {
  const logPath = getLogPath(jobName);
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${message}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
  console.log(`[${jobName}] [${level}] ${message}`);
}

/**
 * Write the stdout/stderr of a job execution to its log file.
 * @param {string} jobName
 * @param {string} stdout
 * @param {string} stderr
 * @param {boolean} success
 */
export function logJobResult(jobName, stdout, stderr, success) {
  const logPath = getLogPath(jobName);
  const now = new Date().toISOString();
  const separator = '─'.repeat(60);
  const status = success ? 'SUCCESS' : 'FAILED';

  let entry = `\n${separator}\n`;
  entry += `[${now}] JOB RESULT: ${status}\n`;
  entry += `${separator}\n`;

  if (stdout && stdout.trim()) {
    entry += `[STDOUT]\n${stdout.trim()}\n`;
  }
  if (stderr && stderr.trim()) {
    entry += `[STDERR]\n${stderr.trim()}\n`;
  }
  entry += `${separator}\n\n`;

  fs.appendFileSync(logPath, entry, 'utf8');
}

/**
 * Write a scheduler-level system log entry.
 * @param {string} level - INFO / WARN / ERROR
 * @param {string} message
 */
export function systemLog(level, message) {
  const logPath = getLogPath('scheduler');
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${message}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
  console.log(`[scheduler] [${level}] ${message}`);
}
