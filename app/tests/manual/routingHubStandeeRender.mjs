// Render-backed routing-hub VARIANT VISUAL check (Electron / real Blink).
//
// Proves, against the REAL client in a real Blink window, that the routing hub 立ち絵 (and the ルミ chat
// face) follow the session's EFFECTIVE persona variant end-to-end: the server resolves the variant's own
// visual set (routing_lumi_<variant>) and the frontend ACTUALLY LOADS it (naturalWidth > 0). This is the
// display-wiring acceptance for routing-variant-visual-wiring.
//
// This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// (node --test app/tests/*.test.mjs) skips it. Run it by hand for each variant you want to confirm
// (the visual assertions + screenshot follow RH_VARIANT; default fallen_star):
//
//   RH_VARIANT=fallen_star           ./node_modules/.bin/electron app/tests/manual/routingHubStandeeRender.mjs
//   RH_VARIANT=dethroned_constellation ./node_modules/.bin/electron app/tests/manual/routingHubStandeeRender.mjs
//
// It boots an isolated server in ROUTING mode (full game-data fixture pointed at the REAL canonical
// assets + a deterministic local stub LM Studio — no real LM Studio needed), loads the real client,
// drives the REAL title entry path (#start-new-game -> enterRoutingHub -> POST /api/routing/hub/start ->
// the dedicated #routing-hub-screen), and asserts the hub standee (#routing-hub-standee) and the ルミ chat
// face point at /character_visual_sets/routing_lumi_<RH_VARIANT>/, are loaded and visible, and screenshots
// the hub as evidence.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.RH_WIN_W ?? 1200);
const WIN_H = Number(process.env.RH_WIN_H ?? 820);
const PERSONA_VARIANT = process.env.RH_VARIANT ?? 'fallen_star';
const VARIANT_SET_FRAGMENT = `/character_visual_sets/routing_lumi_${PERSONA_VARIANT}/`;
const OPENING_TEXT = '新しい週をここから始めましょう。今週はどこへ向かいますか。';

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic local stub LM Studio: enough to open the hub. The opening chat returns the 迎え text; the
// emotion choice returns valid structured JSON; a continuation judgment keeps talking; a destination
// judgment returns 'none' (no dispatch). No real LM Studio is needed.
async function startStubLm() {
  const requests = [];
  let replyCount = 0;
  const server = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* non-JSON body is fine to ignore */ }
    const schemaName = body?.response_format?.json_schema?.name ?? null;
    const prompt = (body?.messages ?? []).map((m) => m.content ?? '').join('\n');
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'neutral' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (prompt.includes('継続したいと思うか')) content = 'true';
    else if (prompt.includes('none を返す')) content = 'none';
    else { replyCount += 1; content = OPENING_TEXT; }
    requests.push({ schemaName });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
  const root = await fixtureRoot('routing-hub-standee-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-standee-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: PERSONA_VARIANT }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

// Read the routing hub standee + the newest ルミ chat face from the real DOM, including naturalWidth so we
// can prove the variant asset actually LOADED (not merely a url on a hidden/broken element).
const MEASURE = `(() => {
  const active = document.querySelector('.screen.active');
  const stream = document.querySelector('#routing-hub-message-stream');
  const standee = document.querySelector('#routing-hub-standee');
  const characterRows = stream ? [...stream.querySelectorAll('.chat-message.character-message')] : [];
  const faceImg = characterRows.length ? characterRows[characterRows.length - 1].querySelector('.message-face img') : null;
  const imgState = (img) => (img ? { src: img.getAttribute('src'), visibility: getComputedStyle(img).visibility, naturalWidth: img.naturalWidth } : null);
  return {
    activeScreenId: active ? active.id : null,
    hubActive: !!document.querySelector('#routing-hub-screen.active'),
    messageCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
    characterMessageCount: characterRows.length,
    standee: imgState(standee),
    face: imgState(faceImg)
  };
})()`;

function loadedFromVariantSet(imageState) {
  if (!imageState) return false;
  const src = imageState.src ?? '';
  return src.includes(VARIANT_SET_FRAGMENT) && imageState.naturalWidth > 0 && imageState.visibility !== 'hidden';
}

function looksLikeRosterHead(imageState) {
  const src = imageState?.src ?? '';
  return /visual_set_001|character_001/.test(src);
}

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
  log('server', { base, playMode: 'routing', variant: PERSONA_VARIANT });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });
  await win.loadURL(`${base}/`);
  await sleep(1200); // let app.js boot

  const measure = () => win.webContents.executeJavaScript(MEASURE);

  // Drive the REAL title entry path (the offscreen button still fires its click handler).
  await win.webContents.executeJavaScript(`document.querySelector('#start-new-game').click(); true`);

  // Poll until the hub opening settles on #routing-hub-screen with BOTH the standee and the newest ルミ
  // chat face decoded (naturalWidth > 0) — both are variant-set images, and the face decodes a beat after
  // the standee, so waiting only for the standee races the face.
  let opening = null;
  for (let i = 0; i < 140; i += 1) {
    opening = await measure();
    if (opening.hubActive && opening.characterMessageCount > 0
      && (opening.standee?.naturalWidth ?? 0) > 0 && (opening.face?.naturalWidth ?? 0) > 0) break;
    await sleep(150);
  }
  log('after_opening', opening);

  const check = (label, pass, detail) => {
    console.log(`${label}: ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(detail)}`);
    if (!pass) exitCode = 1;
  };

  check('OPENING lands on the dedicated #routing-hub-screen', opening?.hubActive === true, { activeScreenId: opening?.activeScreenId });
  check('迎え opening rendered in the hub chat stream', (opening?.messageCount ?? 0) > 0, { messageCount: opening?.messageCount });
  check(`hub 立ち絵 loads the variant set (routing_lumi_${PERSONA_VARIANT}), visible, NOT the roster head`,
    loadedFromVariantSet(opening?.standee) && !looksLikeRosterHead(opening?.standee), { standee: opening?.standee });
  check(`ルミ chat face loads the variant set (routing_lumi_${PERSONA_VARIANT}), NOT the roster head`,
    loadedFromVariantSet(opening?.face) && !looksLikeRosterHead(opening?.face), { face: opening?.face });

  const shotPath = path.join(PROJECT_ROOT, 'tmp', `routing-hub-standee-${PERSONA_VARIANT}.png`);
  try {
    await fs.mkdir(path.dirname(shotPath), { recursive: true });
    await sleep(300);
    await fs.writeFile(shotPath, (await win.webContents.capturePage()).toPNG());
    console.log(`screenshot: ${shotPath}`);
  } catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  console.log(`OVERALL (${PERSONA_VARIANT}): ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
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
