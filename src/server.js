/**
 * server.js
 * ローカルダッシュボードHTTPサーバー
 *
 * 目的: claude-scheduler の状態をブラウザで確認できるダッシュボードを提供する
 * エンドポイント:
 *   GET /          - HTMLダッシュボード
 *   GET /api/status - JSON APIでジョブ状態を返す
 *   GET /api/log?name=<job> - 指定ジョブの最新ログを返す
 *
 * 依存: Node.js標準モジュールのみ（http, fs, path, os）
 *
 * 作成日: 2026-04-10
 * 依頼元: Jack (COO) / Iori.corp
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listJobs, getStorePath } from './store.js';

const BASE_DIR = path.join(os.homedir(), '.claude-scheduler');
const PID_FILE = path.join(BASE_DIR, 'scheduler.pid');

// ─────────────────────────────────────────────
// cron式パーサー（軽量・手動実装）
// 対応パターン: "M H * * *" / "M H1,H2,H3 * * *"
// ─────────────────────────────────────────────

/**
 * cron式を人間可読な文字列に変換する
 * @param {string} cronExpr - cron式 (5フィールド: 分 時 日 月 曜日)
 * @returns {string} 人間可読文字列
 */
function cronToHuman(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return cronExpr;

  const [min, hour, dom, month, dow] = parts;

  // 毎日パターン (dom=* month=* dow=*)
  if (dom === '*' && month === '*' && dow === '*') {
    if (!hour.includes(',') && !hour.includes('-') && !hour.includes('/')) {
      // 単一時刻: "17 4 * * *" → "毎日 4:17"
      return `毎日 ${hour}:${min.padStart(2, '0')}`;
    }
    if (hour.includes(',')) {
      // 複数時刻: "0 9,12,15,18 * * *" → "毎日 9,12,15,18時"
      return `毎日 ${hour}時`;
    }
    if (hour.includes('/')) {
      // 間隔: "0 */3 * * *" → "3時間ごと"
      const interval = hour.split('/')[1];
      return `${interval}時間ごと`;
    }
  }

  // 曜日指定パターン
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  if (dow !== '*' && dom === '*' && month === '*') {
    if (!dow.includes(',') && !dow.includes('-')) {
      const dayNum = parseInt(dow, 10);
      const dayName = dayNames[dayNum] || dow;
      if (!hour.includes(',')) {
        return `毎週${dayName} ${hour}:${min.padStart(2, '0')}`;
      }
    }
  }

  // フォールバック: そのまま返す
  return cronExpr;
}

/**
 * cron式から次回実行時刻を計算する（JST基準）
 * 対応パターン: "M H * * *" / "M H1,H2,H3 * * *"
 * @param {string} cronExpr - cron式
 * @returns {string|null} ISO文字列 or null
 */
function calcNextRun(cronExpr) {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const [minStr, hourStr, dom, month, dow] = parts;

    // 現在時刻をJSTで取得
    const nowUtc = Date.now();
    const jstOffset = 9 * 60 * 60 * 1000;
    const nowJst = new Date(nowUtc + jstOffset);

    const currentMin = nowJst.getUTCMinutes();
    const currentHour = nowJst.getUTCHours();

    // 対象時刻リストを作成
    let targetHours = [];
    if (hourStr.includes(',')) {
      targetHours = hourStr.split(',').map(h => parseInt(h.trim(), 10));
    } else if (!hourStr.includes('*') && !hourStr.includes('/') && !hourStr.includes('-')) {
      targetHours = [parseInt(hourStr, 10)];
    } else {
      // 複雑なパターンは非対応
      return null;
    }

    const targetMin = parseInt(minStr, 10);
    if (isNaN(targetMin)) return null;

    // 今日の候補を検索
    for (const h of targetHours.sort((a, b) => a - b)) {
      if (h > currentHour || (h === currentHour && targetMin > currentMin)) {
        // 今日の h:targetMin が次回
        const next = new Date(nowJst);
        next.setUTCHours(h, targetMin, 0, 0);
        // JSTからUTCに戻す
        return new Date(next.getTime() - jstOffset).toISOString();
      }
    }

    // 今日は全て過ぎた → 翌日の最初の時刻
    const firstHour = targetHours.sort((a, b) => a - b)[0];
    const next = new Date(nowJst);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(firstHour, targetMin, 0, 0);
    return new Date(next.getTime() - jstOffset).toISOString();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// デーモン状態取得
// ─────────────────────────────────────────────

/**
 * デーモンの状態を確認する
 * @returns {{ running: boolean, pid: number|null }}
 */
function getDaemonStatus() {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false, pid: null };
  }

  try {
    const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return { running: false, pid: null };

    // シグナル0でプロセス存在確認
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false, pid: null };
  }
}

// ─────────────────────────────────────────────
// /api/status レスポンス構築
// ─────────────────────────────────────────────

/**
 * ステータスJSONを構築する
 * @returns {Object}
 */
function buildStatus() {
  const daemon = getDaemonStatus();
  const rawJobs = listJobs();

  const jobs = rawJobs.map(job => ({
    name: job.name,
    cron: job.cron,
    cronHuman: cronToHuman(job.cron),
    enabled: job.enabled !== false,
    lastRun: job.lastRun || null,
    lastResult: job.lastResult || null,
    runCount: job.runCount || 0,
    nextRun: calcNextRun(job.cron),
  }));

  return {
    daemon,
    jobs,
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// /api/log エンドポイント: 最新ログ取得
// ─────────────────────────────────────────────

/**
 * 指定ジョブの最新ログを取得する
 * @param {string} jobName - ジョブ名
 * @returns {string} ログ内容（見つからなければメッセージ）
 */
function getLatestLog(jobName) {
  const logsDir = path.join(BASE_DIR, 'logs');
  if (!fs.existsSync(logsDir)) return 'ログディレクトリが見つかりません。';

  // 日付ディレクトリを降順ソート（最新日付を先に）
  let dateDirs;
  try {
    dateDirs = fs.readdirSync(logsDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
  } catch {
    return 'ログディレクトリの読み取りに失敗しました。';
  }

  for (const dateDir of dateDirs) {
    const logFile = path.join(logsDir, dateDir, `${jobName}.log`);
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        // 最新の5000文字のみ返す（大きすぎる場合）
        if (content.length > 5000) {
          return '...(省略)...\n' + content.slice(-5000);
        }
        return content || '(ログが空です)';
      } catch {
        return 'ログの読み取りに失敗しました。';
      }
    }
  }

  return `"${jobName}" のログが見つかりません。`;
}

// ─────────────────────────────────────────────
// HTMLダッシュボード（テンプレートリテラルで埋め込み）
// ─────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>claude-scheduler</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {}
      }
    }
  </script>
  <style>
    body { font-family: 'Segoe UI', 'Hiragino Sans', sans-serif; }
    .log-modal { display: none; }
    .log-modal.open { display: flex; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
</head>
<body class="dark bg-gray-950 text-gray-100 min-h-screen">

  <!-- ヘッダー -->
  <header class="border-b border-gray-800 px-6 py-4">
    <div class="max-w-4xl mx-auto flex items-center justify-between">
      <div class="flex items-center gap-3">
        <span class="text-2xl">⚙️</span>
        <h1 class="text-xl font-bold text-gray-100">claude-scheduler</h1>
      </div>
      <div id="daemon-badge" class="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-gray-800 text-gray-400">
        <span class="w-2 h-2 rounded-full bg-gray-500"></span>
        <span>確認中...</span>
      </div>
    </div>
  </header>

  <!-- メインコンテンツ -->
  <main class="max-w-4xl mx-auto px-6 py-6">

    <!-- サマリーバー -->
    <div class="flex items-center gap-4 mb-6 text-sm text-gray-400">
      <span id="job-count">ジョブ: 読み込み中...</span>
      <span class="text-gray-700">|</span>
      <span id="refresh-countdown" class="text-gray-500">次回更新: 30秒後</span>
    </div>

    <!-- ジョブカードリスト -->
    <div id="jobs-container" class="space-y-3">
      <div class="text-gray-500 text-center py-12">
        <div class="inline-block w-6 h-6 border-2 border-gray-600 border-t-blue-500 rounded-full spin mb-3"></div>
        <p>読み込み中...</p>
      </div>
    </div>

  </main>

  <!-- フッター -->
  <footer class="border-t border-gray-800 px-6 py-4 mt-8">
    <div class="max-w-4xl mx-auto flex items-center justify-between text-xs text-gray-500">
      <span id="last-updated">最終更新: -</span>
      <span>自動リフレッシュ: 30秒ごと</span>
    </div>
  </footer>

  <!-- ログモーダル -->
  <div id="log-modal" class="log-modal fixed inset-0 bg-black/70 items-center justify-center z-50 p-4">
    <div class="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-700">
        <h2 id="modal-title" class="font-semibold text-gray-100">ログ</h2>
        <button onclick="closeModal()" class="text-gray-400 hover:text-gray-200 text-xl leading-none">&times;</button>
      </div>
      <div class="overflow-auto p-5 flex-1">
        <pre id="modal-log" class="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-5"></pre>
      </div>
    </div>
  </div>

  <script>
    let countdown = 30;
    let countdownTimer = null;

    // JST日時フォーマット
    function fmtJst(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      return d.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    // 現在時刻（JST）をフォーマット
    function nowJst() {
      return new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }) + ' JST';
    }

    // 結果バッジ
    function resultBadge(result) {
      if (!result) return '<span class="text-gray-500 text-lg" title="未実行">⏳</span>';
      if (result === 'success') return '<span class="text-green-400 text-lg" title="成功">✅</span>';
      return '<span class="text-red-400 text-lg" title="エラー">❌</span>';
    }

    // 有効バッジ
    function enabledBadge(enabled) {
      if (enabled) {
        return '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/50 text-green-400 border border-green-800">有効</span>';
      }
      return '<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-800 text-gray-500 border border-gray-700">無効</span>';
    }

    // ジョブカードHTMLを生成
    function renderJobCard(job) {
      const lastRunStr = job.lastRun ? fmtJst(job.lastRun) : '未実行';
      const nextRunStr = job.nextRun ? fmtJst(job.nextRun) : '-';
      const resultIcon = resultBadge(job.lastResult);
      const badge = enabledBadge(job.enabled);

      return \`
        <div
          class="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-600 transition-colors"
          onclick="openLog('\${job.name}')"
          title="クリックでログを表示"
        >
          <div class="flex items-start justify-between mb-3">
            <div class="flex items-center gap-2">
              \${resultIcon}
              <h3 class="font-semibold text-gray-100">\${job.name}</h3>
              \${badge}
            </div>
            <span class="text-xs text-gray-500 font-mono">\${job.cron}</span>
          </div>

          <div class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">スケジュール</span>
              <span class="text-gray-200">\${job.cronHuman}</span>
            </div>
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">次回実行</span>
              <span class="text-blue-300">\${nextRunStr}</span>
            </div>
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">最終実行</span>
              <span class="text-gray-300">\${lastRunStr}</span>
            </div>
            <div class="flex items-center gap-2 text-gray-400">
              <span class="text-gray-600 text-xs">実行回数</span>
              <span class="text-gray-300">\${job.runCount}回</span>
            </div>
          </div>
        </div>
      \`;
    }

    // ステータスを取得して画面更新
    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        // デーモンバッジ更新
        const daemonBadge = document.getElementById('daemon-badge');
        if (data.daemon.running) {
          daemonBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-green-900/50 text-green-400 border border-green-800';
          daemonBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-400"></span><span>Running (PID: ' + data.daemon.pid + ')</span>';
        } else {
          daemonBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-red-900/50 text-red-400 border border-red-800';
          daemonBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-400"></span><span>Stopped</span>';
        }

        // ジョブ数
        const enabledCount = data.jobs.filter(j => j.enabled).length;
        document.getElementById('job-count').textContent =
          'ジョブ: ' + data.jobs.length + '件 (有効: ' + enabledCount + '件)';

        // ジョブカード更新
        const container = document.getElementById('jobs-container');
        if (data.jobs.length === 0) {
          container.innerHTML = '<p class="text-gray-500 text-center py-12">ジョブが登録されていません</p>';
        } else {
          container.innerHTML = data.jobs.map(renderJobCard).join('');
        }

        // 最終更新時刻
        document.getElementById('last-updated').textContent = '最終更新: ' + nowJst();

      } catch (err) {
        console.error('ステータス取得エラー:', err);
        document.getElementById('jobs-container').innerHTML =
          '<p class="text-red-400 text-center py-12">データ取得エラー: ' + err.message + '</p>';
      }
    }

    // カウントダウンタイマー
    function startCountdown() {
      if (countdownTimer) clearInterval(countdownTimer);
      countdown = 30;
      countdownTimer = setInterval(() => {
        countdown--;
        document.getElementById('refresh-countdown').textContent = '次回更新: ' + countdown + '秒後';
        if (countdown <= 0) {
          fetchStatus();
          countdown = 30;
        }
      }, 1000);
    }

    // ログモーダルを開く
    async function openLog(jobName) {
      document.getElementById('modal-title').textContent = jobName + ' — 最新ログ';
      document.getElementById('modal-log').textContent = '読み込み中...';
      document.getElementById('log-modal').classList.add('open');

      try {
        const res = await fetch('/api/log?name=' + encodeURIComponent(jobName));
        const text = await res.text();
        document.getElementById('modal-log').textContent = text;
      } catch (err) {
        document.getElementById('modal-log').textContent = 'ログ取得エラー: ' + err.message;
      }
    }

    // ログモーダルを閉じる
    function closeModal() {
      document.getElementById('log-modal').classList.remove('open');
    }

    // ESCキーでモーダル閉じる
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });

    // モーダル背景クリックで閉じる
    document.getElementById('log-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('log-modal')) closeModal();
    });

    // 初期化
    fetchStatus();
    startCountdown();
  </script>
</body>
</html>`;

// ─────────────────────────────────────────────
// HTTPサーバー
// ─────────────────────────────────────────────

/**
 * URLクエリパラメータをパースする
 * @param {string} search - URL検索文字列 (?name=foo)
 * @returns {Object}
 */
function parseQuery(search) {
  const params = {};
  if (!search || !search.startsWith('?')) return params;
  search.slice(1).split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  return params;
}

/**
 * ダッシュボードサーバーを起動する
 * @param {number} port - 待ち受けポート番号
 */
export function startServer(port = 3060) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS（ローカル専用なので許可）
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && pathname === '/') {
      // HTMLダッシュボード
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);

    } else if (req.method === 'GET' && pathname === '/api/status') {
      // JSON APIステータス
      try {
        const status = buildStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }

    } else if (req.method === 'GET' && pathname === '/api/log') {
      // ジョブログ取得
      const query = parseQuery(url.search);
      const jobName = query['name'];
      if (!jobName) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('name パラメータが必要です');
        return;
      }
      const logContent = getLatestLog(jobName);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(logContent);

    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`claude-scheduler ダッシュボード起動`);
    console.log(`URL: http://localhost:${port}`);
    console.log(`API: http://localhost:${port}/api/status`);
    console.log('Ctrl+C で停止します');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`エラー: ポート ${port} はすでに使用中です`);
      console.error(`別のポートを指定してください: node bin/claude-scheduler.js serve --port 3070`);
    } else {
      console.error(`サーバーエラー: ${err.message}`);
    }
    process.exit(1);
  });

  return server;
}
