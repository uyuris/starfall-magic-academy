// Render-backed 工房 (workshop) arrival screen restyle check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no DOM/layout, listeners never attach) nor load images, so the workshop
// screen (#academy-workshop-screen) is verified here against the REAL client in real Blink. This file is NOT
// named *.test.mjs and lives under app/tests/manual/, so `npm test` skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/workshopScreenRender.mjs
//   WS_SHOT_PREFIX=tmp/workshop-after ./node_modules/.bin/electron app/tests/manual/workshopScreenRender.mjs
//
// It boots an isolated server in ROUTING mode (real canonical assets + a deterministic stub LM so the hub-start
// opening completes), drives the REAL title entry path to create an active routing slot, then reloads with
// ?initialScreen=academy-workshop so the dev entry lands the workshop board (GET /api/workshop succeeds on the
// active routing slot). It shoots the arrival surface and reports the screen background + exit button geometry.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.WS_WIN_W ?? 1280);
const WIN_H = Number(process.env.WS_WIN_H ?? 860);
const SHOT_PREFIX = process.env.WS_SHOT_PREFIX ?? 'tmp/workshop-shot';

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startStubLm() {
  let replyCount = 0;
  const server = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore non-JSON */ }
    const schemaName = body?.response_format?.json_schema?.name ?? null;
    const prompt = (body?.messages ?? []).map((m) => m.content ?? '').join('\n');
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'neutral' });
    else if (prompt.includes('継続したいと思うか')) content = 'true';
    else if (prompt.includes('none を返す')) content = 'none';
    else { replyCount += 1; content = '新しい週をここから始めましょう。'; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
  const root = await fixtureRoot('workshop-screen-render-');
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: REPO_CANONICAL,
    publicRoot: PUBLIC_ROOT,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-screen-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function shoot(win, suffix) {
  const image = await win.webContents.capturePage();
  const out = path.resolve(PROJECT_ROOT, `${SHOT_PREFIX}${suffix}.png`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, image.toPNG());
  log('screenshot', out);
}

const MEASURE = `(() => {
  const screen = document.querySelector('#academy-workshop-screen');
  const frame = document.querySelector('.academy-workshop-frame');
  const stage = document.querySelector('.academy-workshop-stage');
  const controls = document.querySelector('.academy-workshop-controls');
  const exit = document.querySelector('#academy-workshop-exit');
  const board = document.querySelector('.academy-workshop-board');
  const rows = document.querySelectorAll('.academy-workshop-row').length;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), top: Math.round(r.top) }; };
  const bg = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage }; };
  return {
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    screenBg: bg(screen),
    stageBg: bg(stage),
    recipeRows: rows,
    frameRect: rect(frame),
    controlsRect: rect(controls),
    exitRect: rect(exit),
    boardRect: rect(board),
    status: (document.querySelector('#academy-workshop-status')?.textContent ?? '').trim()
  };
})()`;

async function main() {
  lm = await startStubLm();
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];
  const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log(`renderer-console[${level}]: ${message}`); });
  await win.loadURL(`${base}/`);
  await sleep(1200);

  // Create an active routing slot through the real title entry path.
  await win.webContents.executeJavaScript(`document.querySelector('#start-new-game').click(); true`);
  for (let i = 0; i < 100; i += 1) {
    const ready = await win.webContents.executeJavaScript(`document.querySelector('#academy-conversation-session-screen.active') ? true : false`);
    if (ready) break;
    await sleep(150);
  }
  await sleep(600);

  // Reload straight into the workshop dev entry; the active routing slot lets GET /api/workshop succeed.
  await win.loadURL(`${base}/?initialScreen=academy-workshop`);
  let m = null;
  for (let i = 0; i < 100; i += 1) {
    m = await win.webContents.executeJavaScript(MEASURE);
    if (m.activeScreenId === 'academy-workshop-screen' && m.recipeRows > 0) break;
    await sleep(150);
  }
  await sleep(500);
  m = await win.webContents.executeJavaScript(MEASURE);
  log('workshop', m);
  await shoot(win, '-arrival');

  console.log(`WORKSHOP SCREEN RENDER: active=${m?.activeScreenId} rows=${m?.recipeRows}`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { server?.close(); } catch { /* ignore */ }
  try { lm?.server?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { fs.rm(p, { recursive: true, force: true }).catch(() => {}); }
  process.exit(exitCode);
});
