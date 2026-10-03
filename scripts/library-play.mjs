#!/usr/bin/env node
// 遊んで確かめる口: 製品の大書庫へ、本物の LM で入る。
//
//   node scripts/library-play.mjs --lmstudio-config <LM Studio の設定 file の絶対パス>
//
// 起こすと開く URL を 1 行出し、Ctrl-C（SIGINT / SIGTERM）で書きかけを終えてから止まる。
//
// - 場: OS temp に新しい root（data/definitions と data/seeds を写す。mutable は新しいプレイが作る）を作り、その上で
//   製品の server（app/src/server.mjs createServer）を起こす。このリポの data/mutable・app/config と packaged app のセーブは
//   読みも書きもしない。止まるときに root ごと消す。画面（app/public）・絵（assets/canonical）・キャラ（content/）はこのリポの
//   ものを読むだけ。
// - LM: 引数の設定 file を起動時に 1 回読み（無ければ root を作る前に止まる）、root の app/config/lmstudio.json に写して server をそこへ向ける（設定画面の
//   保存が起きても元の file には届かない）。ハブの会話も大書庫の頼みも、この LM へ製品のまま届く。
// - 入口: 開く URL は製品の通常の play の入口（/）。タイトル → 新しいプレイ → ハブで案内人に大書庫を頼むと、製品の見送りと
//   ローディングを経て大書庫に着く。要求は製品の server へそのまま中継し、/api/ の要求を 1 行ずつ log に出す。
//   大書庫の決まり・操作・LM への頼み方は製品のまま。
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, shutdownServer } from '../app/src/server.mjs';
import { runtimePathsManifestFilename } from '../app/src/runtimePaths.mjs';

const HOST = '127.0.0.1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const [flag, value, ...rest] = argv;
  if (flag !== '--lmstudio-config') throw new Error(`expected --lmstudio-config <absolute path>, got: ${flag === undefined ? 'no arguments' : flag}`);
  if (value === undefined || value.startsWith('--')) throw new Error('missing value for --lmstudio-config');
  if (!path.isAbsolute(value)) throw new Error(`--lmstudio-config must be an absolute path: ${value}`);
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]} (expected --lmstudio-config only)`);
  return { lmStudioConfigSource: value };
}

async function writeJson(full, value) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createRoot(root, lmStudioConfigBytes) {
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  await fs.cp(path.join(repoRoot, 'data/definitions/game_data'), definitionsRoot, { recursive: true });
  await fs.cp(path.join(repoRoot, 'data/seeds/game_data'), seedsRoot, { recursive: true });
  await writeJson(path.join(root, runtimePathsManifestFilename), {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot,
    seedsRoot,
    mutableRoot: path.join(root, 'data/mutable/game_data'),
    characterContentRoot: path.join(repoRoot, 'content/characters'),
    creatureContentRoot: path.join(repoRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  });
  const lmStudioConfigPath = path.join(root, 'app/config/lmstudio.json');
  await fs.mkdir(path.dirname(lmStudioConfigPath), { recursive: true });
  await fs.writeFile(lmStudioConfigPath, lmStudioConfigBytes);
  return lmStudioConfigPath;
}

function startRelay(productPort) {
  const relay = createHttpServer((req, res) => {
    const startedAt = Date.now();
    const upstream = httpRequest({ host: HOST, port: productPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      if (req.url.startsWith('/api/')) {
        answer.on('end', () => console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${answer.statusCode} ${Date.now() - startedAt}ms`));
      }
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => {
      console.error(`${req.method} ${req.url} relay failed: ${error.message}`);
      res.destroy(error);
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, HOST, () => resolve(relay));
  });
}

const { lmStudioConfigSource } = parseArgs(process.argv.slice(2));
const lmStudioConfigBytes = await fs.readFile(lmStudioConfigSource);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starfall-library-play-'));
const lmStudioConfigPath = await createRoot(root, lmStudioConfigBytes);
const product = createServer({
  root,
  publicRoot: path.join(repoRoot, 'app/public'),
  canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
  playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
  conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
  audioSettingsPath: path.join(root, 'app/config/audio.json'),
  lmStudioConfigPath
});
await new Promise((resolve, reject) => {
  product.once('error', reject);
  product.listen(0, HOST, resolve);
});
const relay = await startRelay(product.address().port);
console.log(`root ${root} (removed on stop)`);
console.log(`open http://${HOST}:${relay.address().port}/`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received; stopping`);
  relay.closeAllConnections();
  await new Promise((resolve) => relay.close(resolve));
  await shutdownServer(product);
  await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(`stopped; root ${root} removed\n`, () => process.exit(0));
}
process.on('SIGINT', () => { stop('SIGINT').catch((error) => { console.error(error); process.exit(1); }); });
process.on('SIGTERM', () => { stop('SIGTERM').catch((error) => { console.error(error); process.exit(1); }); });
