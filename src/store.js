/**
 * store.js
 * scheduled-tasks.json の読み書きモジュール
 *
 * 目的: ジョブ定義を ~/.claude-scheduler/scheduled-tasks.json に永続保存する
 * 冪等性: 同一名のジョブを2回追加しても壊れない（上書き確認あり）
 *
 * 作成日: 2026-04-10
 * 依頼元: Jack (COO) / Iori.corp
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');
const STORE_PATH = path.join(BASE_DIR, 'scheduled-tasks.json');

/**
 * ストアの初期状態
 */
const DEFAULT_STORE = {
  jobs: []
};

/**
 * ストアを初期化する（ディレクトリとファイルを作成）
 */
function ensureStore() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_STORE, null, 2), 'utf8');
  }
}

/**
 * ストアを読み込む
 * @returns {{ jobs: Array }} ストアオブジェクト
 */
export function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] 読み込みエラー: ${err.message}`);
    return { ...DEFAULT_STORE };
  }
}

/**
 * ストアを書き込む
 * @param {{ jobs: Array }} store - ストアオブジェクト
 */
export function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * ジョブを追加または更新する
 * @param {Object} job - ジョブ定義
 * @returns {{ created: boolean }} 新規作成かどうか
 */
export function upsertJob(job) {
  const store = readStore();
  const existingIndex = store.jobs.findIndex(j => j.name === job.name);

  if (existingIndex >= 0) {
    // 既存ジョブを更新
    store.jobs[existingIndex] = { ...store.jobs[existingIndex], ...job };
    writeStore(store);
    return { created: false };
  } else {
    // 新規追加
    store.jobs.push(job);
    writeStore(store);
    return { created: true };
  }
}

/**
 * ジョブを取得する
 * @param {string} name - ジョブ名
 * @returns {Object|null} ジョブ定義、見つからない場合はnull
 */
export function getJob(name) {
  const store = readStore();
  return store.jobs.find(j => j.name === name) || null;
}

/**
 * ジョブを削除する
 * @param {string} name - ジョブ名
 * @returns {boolean} 削除できたかどうか
 */
export function removeJob(name) {
  const store = readStore();
  const before = store.jobs.length;
  store.jobs = store.jobs.filter(j => j.name !== name);
  writeStore(store);
  return store.jobs.length < before;
}

/**
 * 全ジョブを取得する
 * @returns {Array} ジョブ一覧
 */
export function listJobs() {
  const store = readStore();
  return store.jobs;
}

/**
 * ジョブの実行結果を更新する
 * @param {string} name - ジョブ名
 * @param {boolean} success - 成功したか
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
 * ストアファイルのパスを返す（デバッグ用）
 * @returns {string}
 */
export function getStorePath() {
  return STORE_PATH;
}
