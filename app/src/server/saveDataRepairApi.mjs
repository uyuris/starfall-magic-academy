import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 「セーブデータ修正」カテゴリの HTTP surface。設定画面から呼ばれ、その場でリポ配下の migration script を子プロセスで
// 起動して stdout の JSON をそのまま結果として返す。冪等な script を通すだけ＝サーバ側で結果を書き換えない。
// 各エントリは同 prefix `/api/settings/save-data-repair/` に並ぶ形にしてある（今回のエントリは案内人注入寿命 pointer 1 本）。
//
// 二重叩き防止のため endpoint 単位で in-flight Promise の single-flight gate を持つ。UI 側も disable するが、複数タブ
// 同時押下や curl 併走に備えて endpoint 側でもガードし、片方が終わるまで 409 を返す（silent 待ち合わせ禁止＝
// 呼び出し側にも「まだ走っている」ことを明示的に伝える）。

// スクリプト実体はリポ直下 `scripts/` の下に置かれた `.mjs` 実行スクリプト。context.root はテスト時に別の temp dir に
// 差し替わるため、スクリプトパスはこのモジュール自身の位置から解決する（context.root はスクリプトの CWD＝playRoot に使う）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const inFlightByPath = new Map();

const UNCONSUMED_POINTER_PATH = '/api/settings/save-data-repair/unconsumed-routing-conversation-pointer';
const UNCONSUMED_POINTER_SCRIPT_ABSOLUTE = path.join(REPO_ROOT, 'scripts', 'add-unconsumed-routing-conversation-pointer.mjs');

export function canHandleSaveDataRepairRoute(method, pathname) {
  if (method !== 'POST') return false;
  return pathname === UNCONSUMED_POINTER_PATH;
}

export async function handleSaveDataRepairApi({ req, res, url, context, sendJson }) {
  if (!canHandleSaveDataRepairRoute(req.method, url.pathname)) return false;
  if (!context.root) throw new Error('save data repair api requires context.root');

  if (url.pathname === UNCONSUMED_POINTER_PATH) {
    await handleMigration({
      res,
      pathname: url.pathname,
      cwd: context.root,
      scriptAbsolute: UNCONSUMED_POINTER_SCRIPT_ABSOLUTE,
      sendJson,
      runner: context.saveDataRepairRunnerForTest ?? runMigrationScript
    });
    return true;
  }
  return false;
}

async function handleMigration({ res, pathname, cwd, scriptAbsolute, sendJson, runner }) {
  if (inFlightByPath.has(pathname)) {
    sendJson(res, { error: `${pathname} is already running`, code: 'already_running' }, 409);
    return;
  }
  const pending = runner({ cwd, scriptAbsolute });
  inFlightByPath.set(pathname, pending);
  try {
    const result = await pending;
    sendJson(res, { status: 'ok', result });
  } catch (error) {
    sendJson(res, { error: error.message ?? String(error), code: 'migration_failed' }, 500);
  } finally {
    inFlightByPath.delete(pathname);
  }
}

// spawn the migration script as a child process, collect stdout / stderr, parse the stdout JSON payload.
// A non-zero exit code, empty stdout, or non-JSON stdout each throw with a descriptive error — never silently
// swallowed to a partial success.
function runMigrationScript({ cwd, scriptAbsolute }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptAbsolute, '--apply'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(`migration script exited with code ${code}: ${stderr.trim() || stdout.trim() || '(no output)'}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error('migration script produced no stdout'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (parseError) {
        reject(new Error(`migration script stdout is not JSON: ${parseError.message}: ${stdout.slice(0, 400)}`));
        return;
      }
      resolve(parsed);
    });
  });
}

// Test-only exports so the integration test can bypass the actual spawn and assert single-flight behavior.
export const _saveDataRepairInFlightForTest = () => inFlightByPath;
export const _saveDataRepairUnconsumedPointerPath = UNCONSUMED_POINTER_PATH;
export const _saveDataRepairScriptAbsolute = UNCONSUMED_POINTER_SCRIPT_ABSOLUTE;
