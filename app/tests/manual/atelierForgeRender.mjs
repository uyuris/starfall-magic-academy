// 錬成する時の動き（錬成室に居たまま器に光が満ちて結果の窓が生まれる）と、錬成室の表の下の説明を、製品の通常の道で撮って時刻を
// 測る手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   env -u TEAM_ROOT -u TEAM_QUEUE_DIR -u TEAM_STATE_DIR -u TEAM_CONFIG_FILE ... \
//     node app/tests/manual/atelierForgeRender.mjs --repo-root <絶対パス> --lm-config <lmstudio.json の絶対パス> \
//       --shell <chrome-headless-shell の絶対パス> --approved <構成案の置き場の絶対パス> --out <絶対パス> --scenes <名,名,...>
//
// どの引数も必須で既定値は無い。TEAM_* の環境変数が一つでもあれば止まる。--out の中の既存の file は上書きしない。
// --repo-root の製品（app/src・app/public・data・content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人
// fallen_star・錬成室の解錠・子 1 人・全素材を各 10）の上でこの process の中に起こし、chrome-headless-shell を CDP で直に動かして、
// タイトルの門 → ロード → 足あとの広間 → 露台で一言 → 錬成室、と歩く。LM は --lm-config の本物（製品のまま届く）。止まると一時の
// root ごと消す。/api/ の要求は「時刻 METHOD path -> status ms」で stdout へ出す。
//
// 場面（scene・この順で走る。錬成の成功は席を一つ使うので、一回の起動で成功は二回まで）:
//   room     錬成室を 1440×900 と 1100×900 で撮る（room-<幅>.png）。説明の各行の文字列と矩形（文の塊ごとの矩形を同じ高さで
//            まとめた行）・表と説明の矩形・錬成の箱を開いた間に説明が隠れるか、を記録へ。承認の二枚と並べた pair-room-<幅>.png。
//   fail     錬成を確定し、/api/atelier/synthesize を CDP Fetch の Request 段で 4 秒止めてから ConnectionRefused で落とす（server に
//            届かないので何も消費されない — 製品の client の失敗の経路）。器の光が引き残光が席へ戻る間と、失敗の印が出た姿を撮る。
//   fail-early fail と同じ落とし方で、止めずにすぐ落とす（応答が「注ぐ」より先に届く場合）。注ぎ終えてから光が引くかを段の時刻で見る。
//   success  本物の LM で錬成を最後まで通す。六こま（注ぐ・満ちる・満ち続ける・灯る・生まれる と確定直後）を段の印に合わせて撮り、
//            承認の六こま（<approved>/shots/after-forge-f1〜f6.png）と並べた pair-forge-f<n>.png を書く。とじて誕生の名残も撮る。
//   reduced  視差を減らす設定（CDP の prefers-reduced-motion: reduce）で錬成を最後まで通す（本物の LM）。器の光・灯り・結果の窓を撮る。
// 錬成の各回は、押してから・応答からの段の時刻（data-forge の移り・結果の窓・失敗の印）を記録へ書く。
// 記録は <out>/record-<scenes>.json と stdout の最後の一行。
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VIEW = { width: 1440, height: 900 };
const HOST = '127.0.0.1';
const SCENES = ['room', 'fail', 'fail-early', 'success', 'reduced'];
const FAIL_HOLD_MS = 4000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--lm-config', '--shell', '--approved', '--out', '--scenes'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  for (const key of ['--repo-root', '--lm-config', '--shell', '--approved', '--out']) {
    if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) if (!SCENES.includes(scene)) throw new Error(`unknown scene ${scene} (known: ${SCENES.join(',')})`);
  if (scenes.filter((scene) => scene === 'success' || scene === 'reduced').length > 2) throw new Error('at most two successful syntheses per run (three seats, one child prepared)');
  return { repoRoot: parsed['--repo-root'], lmConfig: parsed['--lm-config'], shell: parsed['--shell'], approved: parsed['--approved'], out: parsed['--out'], scenes: SCENES.filter((scene) => scenes.includes(scene)) };
}

async function writeJson(full, value) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeNew(full, bytes) {
  await fs.writeFile(full, bytes, { flag: 'wx' });
}

// ── 製品を一時のプレイで起こす ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_HOMUNCULUS = Object.freeze({
  homunculus_id: 'homunculus_001',
  display_name: 'ミルテ',
  face_id: 'hp_001',
  prompt_description: '錬成室の硝子の器から生まれたばかりの子。見るもの聞くものすべてが新しく、主人公の話を目を丸くして聞く。',
  speaking_basis: 'やわらかい丁寧語で、短い文をゆっくり話す。わからない言葉はそのまま聞き返す。'
});

async function startProduct({ repoRoot, lmConfig }) {
  const mod = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
  const { createServer, shutdownServer } = await mod('app/src/server.mjs');
  const { runtimePathsManifestFilename } = await mod('app/src/runtimePaths.mjs');
  const { initializeNewPlayArea } = await mod('app/src/playSession.mjs');
  const { createStorageApi } = await mod('app/src/storage.mjs');
  const { faceExpressions } = await mod('app/src/faceExpressions.mjs');
  const { generateHomunculusParameters } = await mod('app/src/homunculusAtelier.mjs');
  const { appendActiveHomunculus } = await mod('app/src/homunculusSurface.mjs');
  const { HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } = await mod('app/src/homunculusUnlock.mjs');
  const { requireRoutingContentWeek } = await mod('app/src/routingContentResult.mjs');
  const lmBytes = await fs.readFile(lmConfig);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-forge-render-'));
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  const mutableRoot = path.join(root, 'data/mutable/game_data');
  await fs.cp(path.join(repoRoot, 'data/definitions'), path.join(root, 'data/definitions'), { recursive: true });
  await fs.cp(path.join(repoRoot, 'data/seeds'), path.join(root, 'data/seeds'), { recursive: true });
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
  const lmConfigPath = path.join(root, 'app/config/lmstudio.json');
  await fs.mkdir(path.dirname(lmConfigPath), { recursive: true });
  await fs.writeFile(lmConfigPath, lmBytes);
  const { root: slotRoot } = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });

  // 錬成室の支度: 解錠（光魔法を閾値へ）・子 1 人（撮影用の仮の人となり）・全素材を各 10。
  const storage = createStorageApi({ root: slotRoot });
  const playerParameters = await storage.readJson('game_data/runtime/player_parameters.json');
  const state = await storage.readJson('game_data/runtime_state.json');
  const { homunculus_id: id, display_name: name, face_id: faceId } = FIXTURE_HOMUNCULUS;
  await appendActiveHomunculus({ storage, entry: { homunculus_id: id, display_name: name, face_id: faceId, created_week: requireRoutingContentWeek(state) } });
  await storage.writeJson(`game_data/homunculi/${id}/profile.json`, {
    character_id: id,
    display_name: name,
    visual_set_id: faceId,
    prompt_description: FIXTURE_HOMUNCULUS.prompt_description,
    speaking_basis: FIXTURE_HOMUNCULUS.speaking_basis,
    available_expressions: [...faceExpressions],
    parameters: generateHomunculusParameters({ playerParameters, materials: [], rng: () => 0.5 })
  });
  await storage.writeJson(`game_data/homunculi/${id}/flags.json`, { character_id: id, flags: {} });
  await storage.writeJson(`game_data/homunculi/${id}/skills.json`, { character_id: id, skills: [] });
  playerParameters.magic.light.value = HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD;
  await storage.writeJson('game_data/runtime/player_parameters.json', playerParameters);
  const catalog = JSON.parse(await fs.readFile(path.join(definitionsRoot, 'dungeon_materials.json'), 'utf8'));
  const inventory = await storage.readJson('game_data/player_inventory.json');
  for (const material of catalog.materials) inventory.items.push({ item_id: material.item_id, quantity: 10 });
  await storage.writeJson('game_data/player_inventory.json', inventory);
  console.log(`prep atelier: unlocked, child ${id}, ${catalog.materials.length} materials x10`);

  const product = createServer({
    root,
    publicRoot: path.join(repoRoot, 'app/public'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
    conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
    audioSettingsPath: path.join(root, 'app/config/audio.json'),
    lmStudioConfigPath: lmConfigPath
  });
  await new Promise((resolve) => product.listen(0, HOST, resolve));
  const productPort = product.address().port;
  const relay = createHttpServer((req, res) => {
    const startedAt = Date.now();
    const upstream = httpRequest({ host: HOST, port: productPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      if (req.url.startsWith('/api/')) answer.on('end', () => console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${answer.statusCode} ${Date.now() - startedAt}ms`));
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => res.destroy(error));
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, HOST, resolve);
  });
  return {
    base: `http://${HOST}:${relay.address().port}`,
    async stop() {
      relay.closeAllConnections();
      await new Promise((resolve) => relay.close(resolve));
      await shutdownServer(product);
      await fs.rm(root, { recursive: true, force: true });
      console.log('stopped (os-temp root removed)');
    }
  };
}

// ── chrome-headless-shell を CDP で ──────────────────────────────────────────────────────────────────────────

async function startShell(shellPath) {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-forge-render-shell-'));
  const child = spawn(shellPath, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, `--window-size=${VIEW.width},${VIEW.height}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(userDir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    const text = await fs.readFile(portFile, 'utf8').catch(() => null);
    if (text) {
      const port = Number(text.split('\n')[0]);
      const list = await (await fetch(`http://${HOST}:${port}/json/list`)).json();
      const page = list.find((entry) => entry.type === 'page');
      return {
        wsUrl: page.webSocketDebuggerUrl,
        async stop() {
          child.kill('SIGTERM');
          await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
          await fs.rm(userDir, { recursive: true, force: true });
        }
      };
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('chrome-headless-shell did not write DevToolsActivePort');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params);
  });
  return new Promise((resolve) => ws.addEventListener('open', () => resolve({
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(handler);
    },
    close() {
      ws.close();
    }
  })));
}

function makePage(cdp, outDir, steps) {
  const page = {
    async js(expr) {
      const result = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`page js failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      return result.result.value;
    },
    async load(url) {
      const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
      await cdp.send('Page.navigate', { url });
      await loaded;
    },
    async waitFor(predicate, label, timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await page.js(`(() => { try { return !!(${predicate}); } catch { return false; } })()`)) return;
        await sleep(30);
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    async click(selectorExpr, label) {
      const box = await page.js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
      }
      steps.push(`press ${label}`);
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) {
        await cdp.send('Input.insertText', { text: character });
        await sleep(40);
      }
      steps.push(`type ${JSON.stringify(text)}`);
    },
    async moveAway() {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: VIEW.height - 4 });
    },
    async viewport(width, height) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    // 撮る直前の頁の時刻（performance.now）を返す。
    async shot(name) {
      const at = await page.js('performance.now()');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeNew(path.join(outDir, name), Buffer.from(data, 'base64'));
      steps.push(`shot ${name}`);
      return at;
    }
  };
  return page;
}

// ── 露台から錬成室へ ────────────────────────────────────────────────────────────────────────────────────────

const HUB_READY = "document.querySelector('#routing-hub-screen.active') && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'";
const ATELIER_READY = "document.querySelector('#academy-atelier-screen.active') && document.querySelectorAll('#academy-atelier-slots > li').length > 0";
const MOTION_SETTLED = (sel) => `document.querySelector('${sel}').getAnimations({ subtree: true }).filter((a) => a.effect.getComputedTiming().iterations !== Infinity).every((a) => a.playState !== 'running')`;

async function walkToAtelier(page, base, steps) {
  await page.load(`${base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title');
  await sleep(1500);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(1800);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot light');
  await page.waitFor(HUB_READY, 'terrace', 180000);
  steps.push('terrace ready');
  await sleep(1500);
  // 本物の LM が送り出さずに返事だけ返したら（入力がまた開いた）、次の一言で頼み直す。
  for (const line of ['今週は錬成室に行きたい。', 'うん、錬成室へ行くよ。送り出して。', '錬成室へお願い。']) {
    await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
    await sleep(500);
    await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
    await sleep(3000);
    const end = Date.now() + 240000;
    let idleSince = null;
    while (Date.now() < end) {
      if (await page.js(`(() => { try { return !!(${ATELIER_READY}); } catch { return false; } })()`)) break;
      const idle = await page.js(`(() => { try { return !!(${HUB_READY}); } catch { return false; } })()`);
      if (!idle) idleSince = null;
      else idleSince ??= Date.now();
      if (idleSince !== null && Date.now() - idleSince >= 5000) break;
      await sleep(250);
    }
    if (await page.js(`(() => { try { return !!(${ATELIER_READY}); } catch { return false; } })()`)) break;
    steps.push('guide replied without a send-off');
  }
  await page.waitFor(ATELIER_READY, 'atelier', 240000);
  await sleep(2500);
  await page.waitFor(MOTION_SETTLED('#academy-atelier-screen'), 'atelier settled', 20000);
  steps.push('atelier ready');
}

// 段の時刻の記録を頁に仕掛ける（押した・応答・data-forge の移り・結果の窓・失敗の印・読み上げの字）。
const INSTALL_RECORDER = `(() => {
  if (window.__forgeLog) return true;
  window.__forgeLog = [];
  const mark = (what) => window.__forgeLog.push({ what, t: performance.now() });
  const screen = document.querySelector('#academy-atelier-screen');
  new MutationObserver(() => mark('forge:' + (screen.dataset.forge ?? 'off'))).observe(screen, { attributes: true, attributeFilter: ['data-forge'] });
  const popup = document.querySelector('#academy-atelier-result-popup');
  new MutationObserver(() => mark(popup.hidden ? 'result:closed' : 'result:open')).observe(popup, { attributes: true, attributeFilter: ['hidden'] });
  const status = document.querySelector('#academy-atelier-status');
  new MutationObserver(() => { if (!status.hidden && status.querySelector('.routing-failure-glyph')) mark('failure-glyph'); }).observe(status, { childList: true, subtree: true, attributes: true });
  const spoken = document.querySelector('#academy-atelier-forge-status');
  new MutationObserver(() => mark('spoken:' + JSON.stringify(spoken.textContent))).observe(spoken, { childList: true, characterData: true, subtree: true });
  document.querySelector('#academy-atelier-confirm-accept').addEventListener('click', () => mark('press'), true);
  const original = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    const watched = url.includes('/api/atelier/synthesize');
    try {
      const response = await original(...args);
      if (watched) mark('response:' + response.status);
      return response;
    } catch (error) {
      if (watched) mark('response:failed');
      throw error;
    }
  };
  return true;
})()`;

// 一回の錬成の段の時刻を、押してから・応答からの ms で。
function forgeTimeline(log) {
  const press = log.find((entry) => entry.what === 'press');
  if (!press) throw new Error('forge timeline: no press recorded');
  const response = log.find((entry) => entry.t >= press.t && entry.what.startsWith('response:'));
  return log.filter((entry) => entry.t >= press.t).map((entry) => ({
    what: entry.what,
    fromPressMs: Math.round(entry.t - press.t),
    fromResponseMs: response ? Math.round(entry.t - response.t) : null
  }));
}

async function openSynthesis(page, name) {
  await page.click("document.querySelector('#academy-atelier-synthesize-open')", '新たに錬成する');
  await page.waitFor("!document.querySelector('#academy-atelier-synthesis-form').hidden", 'synthesis form');
  await sleep(600);
  await page.type("document.querySelector('#academy-atelier-name-input')", 'name', name);
  await page.type("document.querySelector('#academy-atelier-skeleton-input')", 'skeleton', '星を数えるのが好きな、少し臆病で優しい子。');
  for (const [index, count] of [[0, 5], [1, 5]]) {
    for (let i = 0; i < count; i += 1) {
      await page.click(`document.querySelectorAll('#academy-atelier-materials .academy-atelier-material:not(.academy-atelier-material--none) .academy-atelier-material-step--plus')[${index}]`, `material ${index} +`);
      await sleep(60);
    }
  }
  await page.waitFor("!document.querySelector('#academy-atelier-synthesis-submit').disabled", 'submit enabled');
  await page.click("document.querySelector('#academy-atelier-synthesis-submit')", '錬成する');
  await page.waitFor("!document.querySelector('#academy-atelier-confirm-popup').hidden", 'confirm');
  await sleep(500);
}

const FORGE_IS = (stage) => `document.querySelector('#academy-atelier-screen').dataset.forge === '${stage}'`;
const SINCE_STAGE = (stage) => `(window.__forgeLog.findLast((entry) => entry.what === 'forge:${stage}')?.t ?? null)`;

// 段に入ってから offset ms の時に撮る（段がもう過ぎていたら撮らずに null）。
async function shootAtStage(page, stage, offsetMs, name, timeoutMs) {
  await page.waitFor(`${FORGE_IS(stage)} || (${SINCE_STAGE(stage)}) !== null`, `forge ${stage}`, timeoutMs);
  const entered = await page.js(SINCE_STAGE(stage));
  const now = await page.js('performance.now()');
  if (now < entered + offsetMs) await sleep(entered + offsetMs - now);
  if (!(await page.js(FORGE_IS(stage)))) return null;
  const at = await page.shot(name);
  return { name, stage, msIntoStage: Math.round(at - entered) };
}

// ── 並べる ──────────────────────────────────────────────────────────────────────────────────────────────

// 承認の姿（左）と置いた姿（右）を同じ大きさで並べた一枚を、頁の中で組んで撮る。
async function composePair(page, { left, right, leftLabel, rightLabel, width, height, out }) {
  const scale = 0.5;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const pad = 24;
  const caption = 34;
  const total = { width: w * 2 + pad * 3, height: h + pad * 2 + caption };
  const data = async (file) => `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;
  const html = `<body style="margin:0;background:#0b0d18;color:#e6ebf7;font:15px/1.4 'Hiragino Sans',sans-serif">
    <div style="display:flex;gap:${pad}px;padding:${pad}px">
      <figure style="margin:0"><figcaption style="height:${caption}px">${leftLabel}</figcaption><img id="l" style="width:${w}px;height:${h}px;display:block"></figure>
      <figure style="margin:0"><figcaption style="height:${caption}px">${rightLabel}</figcaption><img id="r" style="width:${w}px;height:${h}px;display:block"></figure>
    </div></body>`;
  await page.viewport(total.width, total.height);
  await page.load('about:blank');
  await page.js(`(async () => {
    document.open(); document.write(${JSON.stringify(html)}); document.close();
    const set = (id, src) => new Promise((resolve, reject) => { const img = document.getElementById(id); img.onload = resolve; img.onerror = reject; img.src = src; });
    await Promise.all([set('l', ${JSON.stringify(await data(left))}), set('r', ${JSON.stringify(await data(right))})]);
    return true;
  })()`);
  await page.shot(out);
}

// ── 場面 ────────────────────────────────────────────────────────────────────────────────────────────────

const LEDE_RECORD = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left * 100) / 100, Math.round(b.top * 100) / 100, Math.round(b.width * 100) / 100, Math.round(b.height * 100) / 100]; };
  const lede = document.querySelector('#academy-atelier-lede');
  const sentences = [...lede.querySelectorAll('.academy-atelier-lede-sentence')].map((span) => ({ text: span.textContent, rect: r(span), boxes: span.getClientRects().length }));
  const lines = [];
  for (const sentence of sentences) {
    const line = lines.find((entry) => Math.abs(entry.y - sentence.rect[1]) < 1);
    if (line) { line.text += sentence.text; line.right = sentence.rect[0] + sentence.rect[2]; line.height = Math.max(line.height, sentence.rect[3]); }
    else lines.push({ text: sentence.text, x: sentence.rect[0], y: sentence.rect[1], right: sentence.rect[0] + sentence.rect[2], height: sentence.rect[3] });
  }
  const style = getComputedStyle(lede);
  return {
    viewport: [innerWidth, innerHeight],
    table: r(document.querySelector('#academy-atelier-screen .table-room-table')),
    lede: r(lede),
    ledeHidden: lede.hidden,
    lines: lines.map((line) => ({ text: line.text, rect: [line.x, line.y, Math.round((line.right - line.x) * 100) / 100, line.height] })),
    sentences,
    font: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textAlign: style.textAlign, color: style.color, textShadow: style.textShadow, background: style.backgroundColor, border: style.borderStyle },
    precedingComment: (() => { let node = lede.previousSibling; while (node && node.nodeType === Node.TEXT_NODE) node = node.previousSibling; return node && node.nodeType === Node.COMMENT_NODE ? node.textContent.trim() : null; })()
  };
})()`;

async function sceneRoom(context) {
  const { page, out, approved, record } = context;
  record.room = {};
  for (const width of [1440, 1100]) {
    await page.viewport(width, VIEW.height);
    await sleep(800);
    await page.moveAway();
    await page.shot(`room-${width}.png`);
    record.room[width] = await page.js(LEDE_RECORD);
  }
  await page.viewport(VIEW.width, VIEW.height);
  await sleep(500);
  await page.click("document.querySelector('#academy-atelier-synthesize-open')", '新たに錬成する');
  await page.waitFor("!document.querySelector('#academy-atelier-synthesis-form').hidden", 'synthesis form');
  record.room.ledeWhileSynthesisBoxOpen = await page.js("({ hidden: document.querySelector('#academy-atelier-lede').hidden, rects: document.querySelector('#academy-atelier-lede').getClientRects().length })");
  await page.click("document.querySelector('#academy-atelier-synthesis-cancel')", 'やめる');
  await page.waitFor("document.querySelector('#academy-atelier-synthesis-form').hidden", 'synthesis box closed');
  record.room.ledeAfterSynthesisBoxClosed = await page.js("({ hidden: document.querySelector('#academy-atelier-lede').hidden })");
  context.pairs.push(...[1440, 1100].map((width) => ({
    left: path.join(approved, `shots/after-atelier-room-${width}.png`),
    right: path.join(out, `room-${width}.png`),
    leftLabel: `承認の姿（構成案 after-atelier-room-${width}.png）`,
    rightLabel: `置いた姿（製品 room-${width}.png）`,
    width,
    height: VIEW.height,
    out: `pair-room-${width}.png`
  })));
}

// 錬成を確定し、/api/atelier/synthesize を CDP Fetch の Request 段で holdMs 止めてから ConnectionRefused で落とす。
async function runFail(context, { holdMs, prefix, frames }) {
  const { cdp, page } = context;
  const held = [];
  context.onPaused = (event) => {
    held.push(event.request.url);
    setTimeout(() => {
      cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionRefused' }).catch((error) => console.error(error));
    }, holdMs);
  };
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/atelier/synthesize', requestStage: 'Request' }] });
  await page.js('window.__forgeLog.length = 0, true');
  await openSynthesis(page, 'ソラネ');
  await page.click("document.querySelector('#academy-atelier-confirm-accept')", '確定する（落とす）');
  const shots = [];
  for (const [stage, offset, file] of frames) shots.push(await shootAtStage(page, stage, offset, `${prefix}-${file}`, 15000));
  await page.waitFor("window.__forgeLog.some((entry) => entry.what === 'failure-glyph')", 'failure glyph', 15000);
  await page.waitFor(`!document.querySelector('#academy-atelier-screen').dataset.forge && ${MOTION_SETTLED('#academy-atelier-column')}`, 'room back', 15000);
  await sleep(400);
  await page.moveAway();
  await page.shot(`${prefix}-glyph.png`);
  await cdp.send('Fetch.disable');
  context.onPaused = null;
  return {
    holdMs,
    heldRequests: held,
    timeline: forgeTimeline(await page.js('window.__forgeLog')),
    shots: shots.filter(Boolean),
    after: await page.js("({ status: document.querySelector('#academy-atelier-status').innerHTML, slots: document.querySelectorAll('#academy-atelier-slots > li.academy-atelier-slot--active').length, materialCount: document.querySelector('#academy-atelier-material-count').textContent, forgeLayers: document.querySelector('#academy-atelier-forge-light').childElementCount + document.querySelector('#academy-atelier-forge-dim').childElementCount })")
  };
}

async function sceneFail(context) {
  context.record.fail = await runFail(context, { holdMs: FAIL_HOLD_MS, prefix: 'fail', frames: [['fill', 1500, '1-fill.png'], ['recede', 350, '2-recede.png']] });
}

// 応答が「注ぐ」より先に届く場合: 要求をすぐ落とし、注ぎ終えてから光が引くこと（段の時刻）を見る。
async function sceneFailEarly(context) {
  context.record.failEarly = await runFail(context, { holdMs: 0, prefix: 'fail-early', frames: [['pour', 900, '1-pour.png']] });
}

async function runSuccess(context, { name, prefix, frames }) {
  const { page } = context;
  await page.js('window.__forgeLog.length = 0, true');
  await openSynthesis(page, name);
  await page.moveAway();
  await page.click("document.querySelector('#academy-atelier-confirm-accept')", '確定する');
  const shots = [];
  for (const [stage, offset, file, timeout] of frames) shots.push(await shootAtStage(page, stage, offset, `${prefix}-${file}`, timeout));
  await page.waitFor("!document.querySelector('#academy-atelier-result-popup').hidden", 'result popup', 60000);
  await page.waitFor(`${MOTION_SETTLED('#academy-atelier-result-popup')} && document.querySelector('#academy-atelier-result-face-img').complete`, 'result settled', 20000);
  await sleep(300);
  const resultAt = await page.shot(`${prefix}-result.png`);
  const result = await page.js("({ name: document.querySelector('#academy-atelier-result-name').textContent, forge: document.querySelector('#academy-atelier-screen').dataset.forge ?? null, spoken: document.querySelector('#academy-atelier-forge-status').textContent })");
  await page.click("document.querySelector('#academy-atelier-result-close')", 'とじる');
  await page.waitFor(`!document.querySelector('#academy-atelier-screen').dataset.forge && document.querySelector('#academy-atelier-forge-light').childElementCount === 0`, 'forge stood down', 10000);
  await sleep(500);
  await page.moveAway();
  await page.shot(`${prefix}-room-birth.png`);
  return {
    shots: shots.filter(Boolean),
    missedFrames: frames.map(([, , file]) => `${prefix}-${file}`).filter((file) => !shots.some((shot) => shot?.name === file)),
    resultShotAt: resultAt,
    result,
    timeline: forgeTimeline(await page.js('window.__forgeLog')),
    afterClose: await page.js("({ slots: document.querySelectorAll('#academy-atelier-slots > li.academy-atelier-slot--active').length, birthing: [...document.querySelectorAll('.academy-atelier-slot--birthing')].map((slot) => slot.querySelector('.academy-atelier-slot-name')?.textContent), ledeHidden: document.querySelector('#academy-atelier-lede').hidden, spoken: document.querySelector('#academy-atelier-forge-status').textContent })")
  };
}

async function sceneSuccess(context) {
  const { approved, out, record } = context;
  // 六こま: 1 確定（表が退いた直後・残光が席に）・2 注ぐ・3 満ちる・4 満ち続ける・5 灯る・6 生まれる。
  record.success = await runSuccess(context, {
    name: 'ソラネ',
    prefix: 'forge',
    frames: [
      ['pour', 280, 'f1.png', 15000],
      ['pour', 950, 'f2.png', 15000],
      ['fill', 700, 'f3.png', 15000],
      ['fill', 3600, 'f4.png', 15000],
      ['kindle', 900, 'f5.png', 60000],
      ['birth', 520, 'f6.png', 15000]
    ]
  });
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const right = path.join(out, `forge-f${n}.png`);
    if (!(await fs.stat(right).catch(() => null))) continue;
    context.pairs.push({
      left: path.join(approved, `shots/after-forge-f${n}.png`),
      right,
      leftLabel: `承認のこま ${n}（構成案 after-forge-f${n}.png）`,
      rightLabel: `置いた姿（製品 forge-f${n}.png）`,
      width: VIEW.width,
      height: VIEW.height,
      out: `pair-forge-f${n}.png`
    });
  }
}

async function sceneReduced(context) {
  const { cdp, page, record } = context;
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const matched = await page.js("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
  if (!matched) throw new Error('reduced: prefers-reduced-motion did not take');
  record.reduced = await runSuccess(context, {
    name: 'ルカ',
    prefix: 'reduced',
    frames: [
      ['fill', 400, 'appear.png', 15000],
      ['kindle', 250, 'kindle.png', 60000]
    ]
  });
  record.reduced.layersUsed = 'appear/fill: 器の光（移動なし） → kindle: 短く濃く → birth: 結果の窓（不透明度）';
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
}

async function main() {
  const startedAt = Date.now();
  const teamVars = Object.keys(process.env).filter((key) => key.startsWith('TEAM_'));
  if (teamVars.length > 0) throw new Error(`TEAM_* must be unset before running this tool (found ${teamVars.join(', ')})`);
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.out, { recursive: true });
  const product = await startProduct(options);
  const shell = await startShell(options.shell);
  const cdp = await connect(shell.wsUrl);
  const steps = [];
  const record = { scenes: options.scenes, startedAt: new Date().toISOString(), steps, consoleErrors: [] };
  const context = {};
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') record.consoleErrors.push(event.args.map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300));
    });
    cdp.on('Runtime.exceptionThrown', (event) => record.consoleErrors.push(`exception: ${event.exceptionDetails.exception?.description ?? event.exceptionDetails.text}`.slice(0, 300)));
    cdp.on('Fetch.requestPaused', (event) => {
      if (!context.onPaused) throw new Error(`unexpected paused request ${event.request.url}`);
      context.onPaused(event);
    });
    const page = makePage(cdp, options.out, steps);
    await page.viewport(VIEW.width, VIEW.height);
    await walkToAtelier(page, product.base, steps);
    await page.js(INSTALL_RECORDER);
    Object.assign(context, { cdp, page, out: options.out, approved: options.approved, record, pairs: [], onPaused: null });
    const scenes = { room: sceneRoom, fail: sceneFail, 'fail-early': sceneFailEarly, success: sceneSuccess, reduced: sceneReduced };
    for (const scene of options.scenes) {
      await scenes[scene](context);
      steps.push(`scene ${scene} done`);
    }
    for (const pair of context.pairs) await composePair(page, pair);
  } finally {
    record.seconds = Math.round((Date.now() - startedAt) / 1000);
    await writeNew(path.join(options.out, `record-${options.scenes.join('-')}.json`), `${JSON.stringify(record, null, 2)}\n`).catch((error) => console.error(error));
    cdp.close();
    await shell.stop();
    await product.stop();
  }
  console.log(JSON.stringify({ seconds: record.seconds, scenes: options.scenes, consoleErrors: record.consoleErrors.length }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
