// Cron scheduler — loads jobs from store and runs them on schedule

import cron from 'node-cron';
import { listJobs } from './store.js';
import { runJob } from './runner.js';
import { systemLog } from './logger.js';

// Map of scheduled tasks: { jobName: cronTask }
const scheduledTasks = new Map();

/**
 * Register all enabled jobs with node-cron.
 */
export function scheduleAllJobs() {
  const jobs = listJobs();
  const enabledJobs = jobs.filter(j => j.enabled !== false);

  systemLog('INFO', `Scheduling ${enabledJobs.length} job(s)`);

  for (const job of enabledJobs) {
    scheduleJob(job);
  }
}

/**
 * Register a single job with node-cron.
 * @param {Object} job - job definition
 */
export function scheduleJob(job) {
  // If already scheduled, stop and re-register
  if (scheduledTasks.has(job.name)) {
    scheduledTasks.get(job.name).stop();
    scheduledTasks.delete(job.name);
  }

  if (!cron.validate(job.cron)) {
    systemLog('ERROR', `Invalid cron expression for job "${job.name}": "${job.cron}"`);
    return;
  }

  const task = cron.schedule(job.cron, async () => {
    systemLog('INFO', `Firing job: "${job.name}"`);
    try {
      await runJob(job);
    } catch (err) {
      systemLog('ERROR', `Unexpected error in job "${job.name}": ${err.message}`);
    }
  }, {
    scheduled: true,
    // node-cron uses local time by default
  });

  scheduledTasks.set(job.name, task);
  systemLog('INFO', `Job registered: "${job.name}" (${job.cron})`);
}

/**
 * Stop all scheduled jobs.
 */
export function stopAllJobs() {
  for (const [name, task] of scheduledTasks) {
    task.stop();
    systemLog('INFO', `Job stopped: "${name}"`);
  }
  scheduledTasks.clear();
}

/**
 * Return the number of registered scheduled jobs.
 * @returns {number}
 */
export function getScheduledCount() {
  return scheduledTasks.size;
}

/**
 * Set up graceful shutdown on SIGINT/SIGTERM.
 */
export function setupGracefulShutdown() {
  const shutdown = (signal) => {
    systemLog('INFO', `Signal received (${signal}). Shutting down...`);
    stopAllJobs();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
