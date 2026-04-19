/**
 * scheduler.js
 * cronスケジューラー本体
 *
 * 目的: node-cronを使って登録されたジョブをスケジュール実行する
 * タイムゾーン: ローカルタイム（JST）で解釈（node-cronのデフォルト動作）
 * 制約:
 *   - エラーが起きても次のスケジュールまで待つ（クラッシュしない）
 *   - gracefulシャットダウン対応（SIGINT/SIGTERM）
 *
 * 作成日: 2026-04-10
 * 依頼元: Jack (COO) / Iori.corp
 */

import cron from 'node-cron';
import { listJobs } from './store.js';
import { runJob } from './runner.js';
import { systemLog } from './logger.js';

// スケジュール済みタスクのマップ { jobName: cronTask }
const scheduledTasks = new Map();

/**
 * 全ジョブをスケジュールに登録する
 */
export function scheduleAllJobs() {
  const jobs = listJobs();
  const enabledJobs = jobs.filter(j => j.enabled !== false);

  systemLog('INFO', `${enabledJobs.length}件のジョブをスケジュールに登録します`);

  for (const job of enabledJobs) {
    scheduleJob(job);
  }
}

/**
 * 単一ジョブをスケジュールに登録する
 * @param {Object} job - ジョブ定義
 */
export function scheduleJob(job) {
  // 既に登録済みなら停止してから再登録
  if (scheduledTasks.has(job.name)) {
    scheduledTasks.get(job.name).stop();
    scheduledTasks.delete(job.name);
  }

  if (!cron.validate(job.cron)) {
    systemLog('ERROR', `ジョブ "${job.name}" のcron式が無効です: "${job.cron}"`);
    return;
  }

  const task = cron.schedule(job.cron, async () => {
    systemLog('INFO', `ジョブ起動: "${job.name}"`);
    try {
      await runJob(job);
    } catch (err) {
      systemLog('ERROR', `ジョブ "${job.name}" で予期しないエラー: ${err.message}`);
    }
  }, {
    scheduled: true,
    // node-cronはデフォルトでローカルタイムを使う
  });

  scheduledTasks.set(job.name, task);
  systemLog('INFO', `ジョブ登録完了: "${job.name}" (${job.cron})`);
}

/**
 * スケジューラーを停止する
 */
export function stopAllJobs() {
  for (const [name, task] of scheduledTasks) {
    task.stop();
    systemLog('INFO', `ジョブ停止: "${name}"`);
  }
  scheduledTasks.clear();
}

/**
 * 登録済みジョブ数を返す
 * @returns {number}
 */
export function getScheduledCount() {
  return scheduledTasks.size;
}

/**
 * gracefulシャットダウンを設定する
 */
export function setupGracefulShutdown() {
  const shutdown = (signal) => {
    systemLog('INFO', `シグナル受信 (${signal})。シャットダウンします...`);
    stopAllJobs();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
