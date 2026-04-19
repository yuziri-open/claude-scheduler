/**
 * logger.js
 * ログ管理モジュール
 *
 * 目的: 各ジョブ実行のstdout/stderrを日付・ジョブ名ごとにファイルに保存する
 * 保存先: ~/.claude-scheduler/logs/YYYY-MM-DD/job-name.log
 *
 * 作成日: 2026-04-10
 * 依頼元: Jack (COO) / Iori.corp
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');

/**
 * ログディレクトリのパスを取得する
 * @param {string} jobName - ジョブ名
 * @returns {string} ログファイルの絶対パス
 */
function getLogPath(jobName) {
  const now = new Date();
  // JSTで日付を計算 (UTC+9)
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstDate = new Date(now.getTime() + jstOffset);
  const dateStr = jstDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const logDir = path.join(BASE_DIR, 'logs', dateStr);
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `${jobName}.log`);
}

/**
 * ログを追記する
 * @param {string} jobName - ジョブ名
 * @param {string} level - ログレベル (INFO / ERROR / WARN)
 * @param {string} message - メッセージ
 */
export function log(jobName, level, message) {
  const logPath = getLogPath(jobName);
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${message}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
  // コンソールにも出力
  console.log(`[${jobName}] [${level}] ${message}`);
}

/**
 * ジョブ実行のstdout/stderrをログファイルに保存する
 * @param {string} jobName - ジョブ名
 * @param {string} stdout - 標準出力
 * @param {string} stderr - 標準エラー出力
 * @param {boolean} success - 成功したか
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
 * スケジューラー自身のシステムログを出力する
 * @param {string} level - ログレベル
 * @param {string} message - メッセージ
 */
export function systemLog(level, message) {
  const logPath = getLogPath('scheduler');
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${message}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
  console.log(`[scheduler] [${level}] ${message}`);
}
