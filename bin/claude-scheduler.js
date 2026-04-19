#!/usr/bin/env node
// CLI entry point for claude-scheduler

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

// Import modules
import cron from 'node-cron';
import { upsertJob, getJob, removeJob, listJobs, getStorePath } from '../src/store.js';
import { runJob } from '../src/runner.js';
import { scheduleAllJobs, setupGracefulShutdown, getScheduledCount } from '../src/scheduler.js';
import { systemLog } from '../src/logger.js';
import { startServer } from '../src/server.js';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');
const PID_FILE = path.join(BASE_DIR, 'scheduler.pid');

const program = new Command();

program
  .name('claude-scheduler')
  .description('Persistent local cron manager for Claude Code CLI')
  .version('0.1.0');

// ─────────────────────────────────────────────
// start command
// ─────────────────────────────────────────────
program
  .command('start')
  .description('Start the scheduler')
  .option('--daemon', 'Start in background daemon mode')
  .action(async (options) => {
    fs.mkdirSync(BASE_DIR, { recursive: true });

    // Prevent double-start: check existing process via PID file
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          if (!options.daemon) {
            console.error(`Error: scheduler is already running (PID: ${oldPid})`);
            console.error(`To stop it: taskkill /PID ${oldPid} /F`);
            process.exit(1);
          }
        } catch {
          // Process does not exist — PID file is stale, continue
        }
      }
    }

    if (options.daemon) {
      // Stop existing daemon process
      fs.mkdirSync(BASE_DIR, { recursive: true });
      if (fs.existsSync(PID_FILE)) {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (oldPid) {
          try {
            process.kill(oldPid, 0); // Check process exists
            // On Windows, send SIGTERM via process.kill
            process.kill(oldPid, 'SIGTERM');
            const { execSync } = await import('child_process');
            try { execSync(`taskkill /PID ${oldPid} /F`, { stdio: 'ignore' }); } catch {}
            console.log(`Stopped existing daemon (PID: ${oldPid})`);
          } catch {
            // Process does not exist, ignore
          }
        }
      }

      // Daemon mode: spawn self without --daemon flag as a detached child process
      const __filename = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [__filename, 'start'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // Save PID
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

      console.log(`Scheduler started in background (PID: ${child.pid})`);
      console.log(`PID file: ${PID_FILE}`);
      console.log(`To stop: kill ${child.pid}`);
      process.exit(0);
    } else {
      // Foreground mode
      console.log('claude-scheduler starting...');
      console.log(`Config file: ${getStorePath()}`);

      // Write PID file (for double-start prevention)
      fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

      setupGracefulShutdown();
      scheduleAllJobs();

      const count = getScheduledCount();
      console.log(`Scheduled ${count} job(s)`);
      console.log('Press Ctrl+C to stop');

      // Keep process alive
      setInterval(() => {}, 1000 * 60 * 60); // noop every hour
    }
  });

// ─────────────────────────────────────────────
// add command
// ─────────────────────────────────────────────
program
  .command('add')
  .description('Register a job')
  .requiredOption('--name <name>', 'Job name')
  .requiredOption('--cron <expression>', 'Cron expression (e.g. "17 4 * * *")')
  .option('--prompt <text>', 'Prompt string (for short prompts)')
  .option('--prompt-file <path>', 'Path to a prompt file (.md)')
  .option('--allowed-tools <tools>', 'Comma-separated allowedTools list', 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch')
  .option('--model <model>', 'Claude model name (e.g. sonnet, opus, haiku)')
  .option('--project <dir>', 'Project directory')
  .option('--disabled', 'Add in disabled state')
  .action((options) => {
    if (!options.prompt && !options.promptFile) {
      console.error('Error: either --prompt or --prompt-file is required');
      process.exit(1);
    }

    if (!require_cron_valid(options.cron)) {
      console.error(`Error: invalid cron expression: "${options.cron}"`);
      console.error('Example: "17 4 * * *" (every day at 04:17)');
      process.exit(1);
    }

    const job = {
      name: options.name,
      cron: options.cron,
      enabled: !options.disabled,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastResult: null,
      runCount: 0,
      allowedTools: options.allowedTools,
    };

    if (options.prompt) {
      job.prompt = options.prompt;
    }
    if (options.promptFile) {
      job.promptFile = path.resolve(options.promptFile);
    }
    if (options.model) {
      job.model = options.model;
    }
    if (options.project) {
      job.project = options.project;
    }

    const { created } = upsertJob(job);
    if (created) {
      console.log(`Job added: "${options.name}"`);
    } else {
      console.log(`Job updated: "${options.name}"`);
    }
    console.log(`Config file: ${getStorePath()}`);
    console.log('');
    console.log('Restart the scheduler to apply changes:');
    console.log('  npx claude-scheduler start');
  });

// ─────────────────────────────────────────────
// list command
// ─────────────────────────────────────────────
program
  .command('list')
  .description('List registered jobs')
  .action(() => {
    const jobs = listJobs();

    if (jobs.length === 0) {
      console.log('No jobs registered');
      console.log(`To add a job: claude-scheduler add --name "job-name" --cron "17 4 * * *" --prompt-file ./prompts/myjob.md`);
      return;
    }

    console.log(`Registered jobs: ${jobs.length}`);
    console.log('');

    for (const job of jobs) {
      const status = job.enabled !== false ? 'ENABLED' : 'DISABLED';
      const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString('en-US') : 'never';
      const lastResult = job.lastResult || '-';
      const runCount = job.runCount || 0;

      console.log(`┌── ${job.name}`);
      console.log(`│   cron: ${job.cron}`);
      console.log(`│   status: ${status}`);
      console.log(`│   lastRun: ${lastRun}`);
      console.log(`│   lastResult: ${lastResult}`);
      console.log(`│   runCount: ${runCount}`);
      if (job.model) {
        console.log(`│   model: ${job.model}`);
      }
      if (job.project) {
        console.log(`│   project: ${job.project}`);
      }
      if (job.promptFile) {
        console.log(`│   promptFile: ${job.promptFile}`);
      } else if (job.prompt) {
        const preview = job.prompt.slice(0, 60) + (job.prompt.length > 60 ? '...' : '');
        console.log(`│   prompt: "${preview}"`);
      }
      console.log(`└── allowedTools: ${job.allowedTools || 'default'}`);
      console.log('');
    }

    console.log(`Config file: ${getStorePath()}`);
  });

// ─────────────────────────────────────────────
// remove command
// ─────────────────────────────────────────────
program
  .command('remove')
  .description('Delete a job')
  .requiredOption('--name <name>', 'Job name')
  .action((options) => {
    const deleted = removeJob(options.name);
    if (deleted) {
      console.log(`Job removed: "${options.name}"`);
    } else {
      console.error(`Error: job not found: "${options.name}"`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// run command (manual trigger for testing)
// ─────────────────────────────────────────────
program
  .command('run')
  .description('Manually trigger a job (for testing)')
  .requiredOption('--name <name>', 'Job name')
  .action(async (options) => {
    const job = getJob(options.name);
    if (!job) {
      console.error(`Error: job not found: "${options.name}"`);
      process.exit(1);
    }

    console.log(`Running job manually: "${options.name}"`);
    console.log('─'.repeat(60));

    const result = await runJob(job);

    console.log('─'.repeat(60));
    if (result.success) {
      console.log('Success');
    } else {
      console.error('Failed');
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// status command
// ─────────────────────────────────────────────
program
  .command('status')
  .description('Check scheduler status')
  .action(() => {
    console.log('claude-scheduler status');
    console.log('─'.repeat(40));

    // Check PID file
    let daemonRunning = false;
    let daemonPid = null;

    if (fs.existsSync(PID_FILE)) {
      const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
      daemonPid = parseInt(pidStr, 10);

      // Check if process is alive (signal 0)
      try {
        process.kill(daemonPid, 0);
        daemonRunning = true;
      } catch {
        daemonRunning = false;
      }
    }

    if (daemonRunning) {
      console.log(`Daemon: running (PID: ${daemonPid})`);
    } else {
      console.log('Daemon: stopped');
      if (daemonPid) {
        console.log('  (PID file exists but process not found)');
      }
    }

    console.log('');
    console.log(`Config file: ${getStorePath()}`);
    console.log(`Log directory: ${path.join(BASE_DIR, 'logs')}`);

    const jobs = listJobs();
    const enabledCount = jobs.filter(j => j.enabled !== false).length;
    console.log(`Registered jobs: ${jobs.length} (enabled: ${enabledCount})`);

    if (jobs.length > 0) {
      console.log('');
      console.log('Job list:');
      for (const job of jobs) {
        const status = job.enabled !== false ? 'ON' : 'OFF';
        const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString('en-US') : 'never';
        console.log(`  [${status}] ${job.name} (${job.cron}) — last run: ${lastRun}`);
      }
    }
  });

// ─────────────────────────────────────────────
// serve command
// ─────────────────────────────────────────────
program
  .command('serve')
  .description('Start the local dashboard server')
  .option('--port <number>', 'Port number', '3060')
  .action((options) => {
    const port = parseInt(options.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Error: invalid port number: "${options.port}"`);
      process.exit(1);
    }
    startServer(port);
  });

// ─────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────

/**
 * Validate a cron expression using node-cron.
 * @param {string} expression - cron expression
 * @returns {boolean}
 */
function require_cron_valid(expression) {
  return cron.validate(expression);
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
program.parse(process.argv);
