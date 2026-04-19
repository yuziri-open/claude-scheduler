#!/usr/bin/env node
/**
 * claude-scheduler.js
 * CLIエントリポイント
 *
 * 目的: claude-schedulerコマンドのCLIインターフェースを提供する
 * コマンド体系:
 *   start         - 常駐起動（フォアグラウンド）
 *   start --daemon - バックグラウンド起動
 *   add           - ジョブ追加
 *   list          - ジョブ一覧
 *   remove        - ジョブ削除
 *   run           - 手動実行（テスト用）
 *   status        - ステータス確認
 *
 * 作成日: 2026-04-10
 * 依頼元: Jack (COO) / Iori.corp
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

// 各モジュールをインポート
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
// start コマンド
// ─────────────────────────────────────────────
program
  .command('start')
  .description('スケジューラーを起動する')
  .option('--daemon', 'バックグラウンドで起動する')
  .action(async (options) => {
    fs.mkdirSync(BASE_DIR, { recursive: true });

    // 2重起動防止: PIDファイルで既存プロセスをチェック
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          if (!options.daemon) {
            console.error(`エラー: スケジューラーは既に起動中です (PID: ${oldPid})`);
            console.error(`停止するには: taskkill /PID ${oldPid} /F`);
            process.exit(1);
          }
        } catch {
          // プロセスが存在しない — PIDファイルは古い、続行OK
        }
      }
    }

    if (options.daemon) {
      // 既存のデーモンプロセスを停止
      fs.mkdirSync(BASE_DIR, { recursive: true });
      if (fs.existsSync(PID_FILE)) {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (oldPid) {
          try {
            process.kill(oldPid, 0); // プロセス存在確認
            // Windowsではprocess.killでSIGTERMを送る
            process.kill(oldPid, 'SIGTERM');
            // 少し待つ
            const { execSync } = await import('child_process');
            try { execSync(`taskkill /PID ${oldPid} /F`, { stdio: 'ignore' }); } catch {}
            console.log(`既存デーモン (PID: ${oldPid}) を停止しました`);
          } catch {
            // プロセスが存在しない場合は無視
          }
        }
      }

      // デーモンモード: 自分自身を --daemon なしで子プロセスとして起動
      const __filename = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [__filename, 'start'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // PIDを保存
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

      console.log(`スケジューラーをバックグラウンドで起動しました (PID: ${child.pid})`);
      console.log(`PIDファイル: ${PID_FILE}`);
      console.log(`停止するには: kill ${child.pid}`);
      process.exit(0);
    } else {
      // フォアグラウンドモード
      console.log('claude-scheduler 起動中...');
      console.log(`設定ファイル: ${getStorePath()}`);

      // PIDファイルを書き込み（2重起動防止用）
      fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

      setupGracefulShutdown();
      scheduleAllJobs();

      const count = getScheduledCount();
      console.log(`${count}件のジョブをスケジュールしました`);
      console.log('Ctrl+C で停止します');

      // プロセスを生かし続ける
      setInterval(() => {}, 1000 * 60 * 60); // 1時間ごとにnoop
    }
  });

// ─────────────────────────────────────────────
// add コマンド
// ─────────────────────────────────────────────
program
  .command('add')
  .description('ジョブを追加する')
  .requiredOption('--name <name>', 'ジョブ名')
  .requiredOption('--cron <expression>', 'cron式 (例: "17 4 * * *")')
  .option('--prompt <text>', 'プロンプト文字列（短い場合）')
  .option('--prompt-file <path>', 'プロンプトファイルのパス (.md)')
  .option('--allowed-tools <tools>', 'allowedTools（カンマ区切り）', 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch')
  .option('--model <model>', 'Claude モデル名 (例: sonnet, opus, haiku)')
  .option('--project <dir>', 'プロジェクトディレクトリ名')
  .option('--disabled', '無効状態で追加する')
  .action((options) => {
    if (!options.prompt && !options.promptFile) {
      console.error('エラー: --prompt または --prompt-file のどちらかが必要です');
      process.exit(1);
    }

    if (!require_cron_valid(options.cron)) {
      console.error(`エラー: cron式が無効です: "${options.cron}"`);
      console.error('例: "17 4 * * *" (毎日4:17)');
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
      console.log(`ジョブを追加しました: "${options.name}"`);
    } else {
      console.log(`ジョブを更新しました: "${options.name}"`);
    }
    console.log(`設定ファイル: ${getStorePath()}`);
    console.log('');
    console.log('スケジューラーを再起動して変更を反映してください:');
    console.log('  npx claude-scheduler start');
  });

// ─────────────────────────────────────────────
// list コマンド
// ─────────────────────────────────────────────
program
  .command('list')
  .description('ジョブ一覧を表示する')
  .action(() => {
    const jobs = listJobs();

    if (jobs.length === 0) {
      console.log('ジョブが登録されていません');
      console.log(`ジョブを追加するには: claude-scheduler add --name "job-name" --cron "17 4 * * *" --prompt-file ./prompts/myjob.md`);
      return;
    }

    console.log(`登録済みジョブ: ${jobs.length}件`);
    console.log('');

    for (const job of jobs) {
      const status = job.enabled !== false ? 'ENABLED' : 'DISABLED';
      const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString('ja-JP') : '未実行';
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
      console.log(`└── allowedTools: ${job.allowedTools || 'デフォルト'}`);
      console.log('');
    }

    console.log(`設定ファイル: ${getStorePath()}`);
  });

// ─────────────────────────────────────────────
// remove コマンド
// ─────────────────────────────────────────────
program
  .command('remove')
  .description('ジョブを削除する')
  .requiredOption('--name <name>', 'ジョブ名')
  .action((options) => {
    const deleted = removeJob(options.name);
    if (deleted) {
      console.log(`ジョブを削除しました: "${options.name}"`);
    } else {
      console.error(`エラー: ジョブが見つかりません: "${options.name}"`);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// run コマンド（手動実行・テスト用）
// ─────────────────────────────────────────────
program
  .command('run')
  .description('ジョブを手動実行する（テスト用）')
  .requiredOption('--name <name>', 'ジョブ名')
  .action(async (options) => {
    const job = getJob(options.name);
    if (!job) {
      console.error(`エラー: ジョブが見つかりません: "${options.name}"`);
      process.exit(1);
    }

    console.log(`ジョブを手動実行します: "${options.name}"`);
    console.log('─'.repeat(60));

    const result = await runJob(job);

    console.log('─'.repeat(60));
    if (result.success) {
      console.log('実行成功');
    } else {
      console.error('実行失敗');
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────
// status コマンド
// ─────────────────────────────────────────────
program
  .command('status')
  .description('スケジューラーのステータスを確認する')
  .action(() => {
    console.log('claude-scheduler ステータス');
    console.log('─'.repeat(40));

    // PIDファイルの確認
    let daemonRunning = false;
    let daemonPid = null;

    if (fs.existsSync(PID_FILE)) {
      const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
      daemonPid = parseInt(pidStr, 10);

      // プロセスが生きているか確認
      try {
        process.kill(daemonPid, 0); // シグナル0でプロセス存在確認
        daemonRunning = true;
      } catch {
        daemonRunning = false;
      }
    }

    if (daemonRunning) {
      console.log(`デーモン: 実行中 (PID: ${daemonPid})`);
    } else {
      console.log('デーモン: 停止中');
      if (daemonPid) {
        console.log('  (PIDファイルは残っていますがプロセスが見つかりません)');
      }
    }

    console.log('');
    console.log(`設定ファイル: ${getStorePath()}`);
    console.log(`ログディレクトリ: ${path.join(BASE_DIR, 'logs')}`);

    const jobs = listJobs();
    const enabledCount = jobs.filter(j => j.enabled !== false).length;
    console.log(`登録ジョブ: ${jobs.length}件 (有効: ${enabledCount}件)`);

    if (jobs.length > 0) {
      console.log('');
      console.log('ジョブ一覧:');
      for (const job of jobs) {
        const status = job.enabled !== false ? 'ON' : 'OFF';
        const lastRun = job.lastRun ? new Date(job.lastRun).toLocaleString('ja-JP') : '未実行';
        console.log(`  [${status}] ${job.name} (${job.cron}) — 最終実行: ${lastRun}`);
      }
    }
  });

// ─────────────────────────────────────────────
// serve コマンド
// ─────────────────────────────────────────────
program
  .command('serve')
  .description('ローカルダッシュボードサーバーを起動する')
  .option('--port <number>', 'ポート番号', '3060')
  .action((options) => {
    const port = parseInt(options.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`エラー: ポート番号が無効です: "${options.port}"`);
      process.exit(1);
    }
    startServer(port);
  });

// ─────────────────────────────────────────────
// バリデーション関数
// ─────────────────────────────────────────────

/**
 * cron式が有効かどうかを確認する
 * node-cronのvalidate関数を使用する
 * @param {string} expression - cron式
 * @returns {boolean}
 */
function require_cron_valid(expression) {
  return cron.validate(expression);
}

// ─────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────
program.parse(process.argv);
