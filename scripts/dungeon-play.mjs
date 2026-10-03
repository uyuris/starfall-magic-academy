#!/usr/bin/env node
// 遊んで確かめる口: 製品のダンジョンへ、本物の LM の同行者を連れて潜る。
//
//   node scripts/dungeon-play.mjs --lmstudio-config <LM Studio の設定 file の絶対パス>
//
// 起こすと開く URL を 1 行出し、Ctrl-C（SIGINT / SIGTERM）で書きかけを終えてから止まる。
//
// - 場: OS temp に新しい loop slot（data/definitions と data/seeds を写し、seeds を mutable の初期状態にする）を作り、その上で
//   製品の server（app/src/server.mjs createServer）を起こす。このリポの data/mutable・app/config と packaged app のセーブは
//   読みも書きもしない。止まるときに slot ごと消す。画面（app/public）・絵（assets/canonical）・キャラ（content/）はこのリポの
//   ものを読むだけ。
// - LM: 引数の設定 file を起動時に 1 回読み（無ければ slot を作る前に止まる）、slot の app/config/lmstudio.json に写して server をそこへ向ける（設定画面の
//   保存が起きても元の file には届かない）。
// - 入口: 開く URL は製品の debug 入口（/?initialScreen=debug）。その HTML にだけ、読み込み後に debug のタブの「実践」を押して
//   body.play-mode を付ける 1 行を足して返す。ほかの要求は製品の server へそのまま中継し、/api/ の要求を 1 行ずつ log に出す。
//   ダンジョンの決まり・操作・会話は製品のまま。
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

async function createSlot(root, lmStudioConfigBytes) {
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  const mutableRoot = path.join(root, 'data/mutable/game_data');
  await fs.cp(path.join(repoRoot, 'data/definitions/game_data'), definitionsRoot, { recursive: true });
  await fs.cp(path.join(repoRoot, 'data/seeds/game_data'), seedsRoot, { recursive: true });
  await fs.cp(seedsRoot, mutableRoot, { recursive: true });
  await writeJson(path.join(root, runtimePathsManifestFilename), {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot,
    seedsRoot,
    mutableRoot,
    characterContentRoot: path.join(repoRoot, 'content/characters'),
    creatureContentRoot: path.join(repoRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  });
  await writeJson(path.join(root, 'app/config/play-mode.json'), { mode: 'loop' });
  const lmStudioConfigPath = path.join(root, 'app/config/lmstudio.json');
  await fs.writeFile(lmStudioConfigPath, lmStudioConfigBytes);
  return lmStudioConfigPath;
}

// The debug entry's HTML gets the step to the dungeon's pre-entry; everything else is relayed as is.
const ENTRY_PATH = '/?initialScreen=debug';
const ENTRY_STEP = `<script>window.addEventListener('load', () => {
  const tab = document.querySelector('button[data-screen="academy-dungeon"]');
  if (!tab) throw new Error('dungeon-play: the debug tab bar has no 実践');
  tab.click();
  document.body.classList.add('play-mode');
});</script>`;

function startRelay(productPort) {
  const relay = createHttpServer((req, res) => {
    const startedAt = Date.now();
    const entry = req.method === 'GET' && req.url === ENTRY_PATH;
    const upstream = httpRequest({ host: HOST, port: productPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      if (req.url.startsWith('/api/')) {
        answer.on('end', () => console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${answer.statusCode} ${Date.now() - startedAt}ms`));
      }
      if (!entry) {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
        return;
      }
      if (answer.statusCode !== 200) throw new Error(`dungeon-play: GET ${ENTRY_PATH} -> ${answer.statusCode}`);
      if (answer.headers['content-encoding']) throw new Error(`dungeon-play: the entry HTML is ${answer.headers['content-encoding']}-encoded`);
      const chunks = [];
      answer.on('data', (chunk) => chunks.push(chunk));
      answer.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        if (!html.includes('</body>')) throw new Error('dungeon-play: the entry HTML has no </body>');
        const body = Buffer.from(html.replace('</body>', `${ENTRY_STEP}</body>`), 'utf8');
        res.writeHead(200, { ...answer.headers, 'content-length': body.length });
        res.end(body);
      });
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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starfall-dungeon-play-'));
const lmStudioConfigPath = await createSlot(root, lmStudioConfigBytes);
const product = createServer({
  root,
  activeRoot: root,
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
console.log(`slot ${root} (removed on stop)`);
console.log(`open http://${HOST}:${relay.address().port}${ENTRY_PATH}`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received; stopping`);
  relay.closeAllConnections();
  await new Promise((resolve) => relay.close(resolve));
  await shutdownServer(product);
  await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(`stopped; slot ${root} removed\n`, () => process.exit(0));
}
process.on('SIGINT', () => { stop('SIGINT').catch((error) => { console.error(error); process.exit(1); }); });
process.on('SIGTERM', () => { stop('SIGTERM').catch((error) => { console.error(error); process.exit(1); }); });
