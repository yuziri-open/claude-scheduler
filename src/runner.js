/**
 * runner.js
 * claude CLI 実行ロジック
 *
 * 目的: ジョブ定義に従って `claude -p "..."` を実行し、結果を記録する
 * 制約:
 *   - リトライしない（失敗したら次のスケジュールまで待つ）
 *   - タイムアウト: デフォルト30分（claudeが重い処理をする場合を考慮）
 *   - stdout/stderrは両方キャプチャしてログに保存
 *
 * 実行方式:
 *   claude -p --allowedTools "..." [prompt]
 *   プロンプトが長い場合はファイルから読み込み、引数として渡す
 *
 * 作成日: 2026-04-10
 * 依頼元: Jack (COO) / Iori.corp
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log, logJobResult } from './logger.js';
import { updateJobResult } from './store.js';

// デフォルトのallowedTools
const DEFAULT_ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';

// タイムアウト: 30分
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * プロンプト文字列を取得する
 * promptFile が指定されている場合はファイルから読み込む
 * @param {Object} job - ジョブ定義
 * @returns {string} プロンプト文字列
 */
function resolvePrompt(job) {
  if (job.promptFile) {
    const filePath = path.resolve(job.promptFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`promptFileが見つかりません: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8');
  }
  if (job.prompt) {
    return job.prompt;
  }
  throw new Error(`ジョブ "${job.name}" にpromptまたはpromptFileが設定されていません`);
}

/**
 * claude CLI のパスを取得する
 * @returns {string} claudeコマンドのパス
 */
function getClaudePath() {
  // Unix系: ~/.local/bin/claude が多い
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    'claude', // PATHから検索
  ];

  for (const c of candidates) {
    if (c === 'claude') return c; // fallback
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}

/**
 * Windows環境でclaude CLIを実行するために必要な環境変数を取得する
 * CLAUDE_CODE_GIT_BASH_PATH が未設定の場合、既知のパスを自動検出する
 * @returns {Object} 環境変数オブジェクト
 */
function getEnv() {
  const env = { ...process.env };

  // 既に設定されていれば何もしない
  if (env.CLAUDE_CODE_GIT_BASH_PATH) {
    return env;
  }

  // Windowsの場合、git-bashのパスを自動検出
  // 注意: Windowsパスはバックスラッシュで指定する必要がある
  if (process.platform === 'win32' || process.env.OS === 'Windows_NT') {
    // fs.existsSync はスラッシュ形式でも動作するが、
    // CLAUDE_CODE_GIT_BASH_PATH はバックスラッシュ形式で渡す必要がある
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
 * ジョブを実行する
 * @param {Object} job - ジョブ定義
 * @returns {{ success: boolean, stdout: string, stderr: string, durationMs: number }}
 */
export async function runJob(job) {
  const startTime = Date.now();
  log(job.name, 'INFO', `実行開始: cron="${job.cron || 'manual'}"`);

  let prompt;
  try {
    prompt = resolvePrompt(job);
  } catch (err) {
    log(job.name, 'ERROR', `プロンプト取得失敗: ${err.message}`);
    updateJobResult(job.name, false);
    return { success: false, stdout: '', stderr: err.message, durationMs: Date.now() - startTime };
  }

  const allowedTools = job.allowedTools || DEFAULT_ALLOWED_TOOLS;
  const claudePath = getClaudePath();

  // claude CLIのコマンド引数を構築する
  // 注意: プロンプトは最初に渡す必要がある
  // 形式: claude [prompt] -p --allowedTools "..."
  const args = [
    prompt,
    '-p',
    '--allowedTools', allowedTools,
  ];

  // モデル指定
  if (job.model) {
    args.push('--model', job.model);
  }

  // プロジェクトディレクトリ指定
  // Claude CLI には --project オプションが無いため、spawnSync の cwd で渡す。
  // job.project は絶対パス or "~/<name>" 形式 or "<name>" のみ（後者は $HOME/<name> と解釈）
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
      log(job.name, 'WARN', `project ディレクトリが存在しません: ${cwd} — cwd を設定しません`);
      cwd = undefined;
    }
  }

  log(job.name, 'INFO', `コマンド実行: ${claudePath} -p --allowedTools "${allowedTools}"${cwd ? ` [cwd=${cwd}]` : ''} [prompt: ${prompt.slice(0, 50)}...]`);

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
      // spawnSyncがエラーを返した場合（コマンドが見つからない、タイムアウト等）
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
      log(job.name, 'INFO', `実行完了 (${durationSec}s)`);
    } else {
      const errPreview = (stderr || stdout).slice(0, 200);
      log(job.name, 'ERROR', `実行失敗 (${durationSec}s) exit=${result.status}: ${errPreview}`);
    }

    logJobResult(job.name, stdout, stderr, success);
    updateJobResult(job.name, success);

    return { success, stdout, stderr, durationMs };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    log(job.name, 'ERROR', `予期しないエラー: ${err.message}`);
    logJobResult(job.name, '', err.message, false);
    updateJobResult(job.name, false);
    return { success: false, stdout: '', stderr: err.message, durationMs };
  }
}
