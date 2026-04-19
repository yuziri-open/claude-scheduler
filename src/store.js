// Persistent store — reads and writes ~/.claude-scheduler/scheduled-tasks.json

import fs from 'fs';
import path from 'path';
import os from 'os';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');
const STORE_PATH = path.join(BASE_DIR, 'scheduled-tasks.json');

/**
 * Default empty store structure.
 */
const DEFAULT_STORE = {
  jobs: []
};

/**
 * Ensure the store directory and file exist.
 */
function ensureStore() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), 'utf8');
  }
}

/**
 * Read the store from disk.
 * @returns {{ jobs: Array }}
 */
export function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] Read error: ${err.message}`);
    return { ...DEFAULT_STORE };
  }
}

/**
 * Write the store to disk.
 * @param {{ jobs: Array }} store
 */
export function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Add or update a job (upsert by name).
 * @param {Object} job - job definition
 * @returns {{ created: boolean }}
 */
export function upsertJob(job) {
  const store = readStore();
  const existingIndex = store.jobs.findIndex(j => j.name === job.name);

  if (existingIndex >= 0) {
    // Update existing job
    store.jobs[existingIndex] = { ...store.jobs[existingIndex], ...job };
    writeStore(store);
    return { created: false };
  } else {
    // Add new job
    store.jobs.push(job);
    writeStore(store);
    return { created: true };
  }
}

/**
 * Get a job by name.
 * @param {string} name
 * @returns {Object|null}
 */
export function getJob(name) {
  const store = readStore();
  return store.jobs.find(j => j.name === name) || null;
}

/**
 * Remove a job by name.
 * @param {string} name
 * @returns {boolean} true if a job was removed
 */
export function removeJob(name) {
  const store = readStore();
  const before = store.jobs.length;
  store.jobs = store.jobs.filter(j => j.name !== name);
  writeStore(store);
  return store.jobs.length < before;
}

/**
 * Return all jobs.
 * @returns {Array}
 */
export function listJobs() {
  const store = readStore();
  return store.jobs;
}

/**
 * Update the last run result for a job.
 * @param {string} name
 * @param {boolean} success
 */
export function updateJobResult(name, success) {
  const store = readStore();
  const job = store.jobs.find(j => j.name === name);
  if (job) {
    job.lastRun = new Date().toISOString();
    job.lastResult = success ? 'success' : 'error';
    job.runCount = (job.runCount || 0) + 1;
    writeStore(store);
  }
}

/**
 * Return the store file path (for display/debug).
 * @returns {string}
 */
export function getStorePath() {
  return STORE_PATH;
}
