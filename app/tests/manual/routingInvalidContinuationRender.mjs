// Render-backed check for the routing hub invalid-continuation fail-fast + loading-residue defense
// (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch/DOM/real layout/SSE pump), so the frontend error path is
// verified here against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and
// lives under app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by
// hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/routingInvalidContinuationRender.mjs
//
// It boots an isolated server in ROUTING mode with a local LM Studio stub whose CONTINUATION judgment
// output is chosen per player input, and drives the real routing hub turn to measure the task's two
// frontend acceptance paths against real layout:
//
//   A) INVALID OUTPUT -> SETTINGS: the continuation judgment returns 'maybe' (neither true nor false).
//      The backend fails the turn fast (SSE `error` carrying error_code INVALID_LLM_CONTINUATION_OUTPUT);
//      the client must NOT stay on #academy-loading-screen — it shows the fixed cause message
//      「LLM出力が不正です。接続設定やモデルを見直してください。」 and routes to the #settings-screen.
//
//   B) END-REQUEST FAILURE -> HUB RECOVERY (loading-residue defense): the continuation returns a valid
//      'false'. The hub auto-ends, but a hub conversation with no decided destination gets a 409 from
//      /api/conversation/end while the drain loading screen is up. The client must NOT stay stranded on
//      #academy-loading-screen — it returns to #routing-hub-screen with the error shown.
//
// NEGATIVE CONTROL (run separately, documented in the task report): with the fix reverted
// (git stash the app.js + backend change), scenario A stalls on #academy-loading-screen (infinite load)
// and scenario B stays stuck on #academy-loading-screen — proving this harness detects the bug.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.RIC_WIN_W ?? 1200);
const WIN_H = Number(process.env.RIC_WIN_H ?? 820);
const PERSONA_VARIANT = process.env.RIC_VARIANT ?? 'fallen_star';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const INPUT_INVALID = '判定を不正にするテスト入力';
const INPUT_FALSE = '会話を終えるテスト入力';
const INVALID_MESSAGE = 'LLM出力が不正です。接続設定やモデルを見直してください。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// The continuation judgment output is chosen from the player input carried in the continuation prompt:
// INPUT_INVALID -> 'maybe' (invalid, fail-fast); INPUT_FALSE -> 'false' (valid end, no destination -> 409
// on end). No destination is ever decided here, so neither scenario dispatches.
function continuationScenarioLmResponder({ body, prompt, requestIndex }) {
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) {
    if (prompt.includes(INPUT_FALSE)) return 'false';
    return 'maybe';
  }
  if (prompt.includes('この会話を切り上げる')) return 'ここで一区切りにしましょう。';
  if (requestIndex === 0) return OPENING_TEXT;
  return '……なるほど、その話を聞かせてください。';
}

async function startStubLm() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    requests.push({ url: req.url });
    const prompt = body.messages?.[0]?.content ?? '';
    const content = continuationScenarioLmResponder({ body, prompt, requestIndex: requests.length - 1 });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const root = await fixtureRoot('routing-invalid-continuation-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-invalid-continuation-render-settings-'));
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

async function waitFor(win, predicate, { tries = 200, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

async function newGameToHub(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1200);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  return waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `);
}

// enterRoutingHub keeps conversationRequestInFlight true across its opening reveal while re-enabling
// #routing-hub-send, so a send fired the instant the hub appears silently no-ops on the in-flight guard.
// A real send clears the input synchronously (optimistic render) before its first await; an in-flight
// no-op leaves it. Retry until the send actually fires.
async function sendHubTurn(win, playerInput) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const fired = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!input || !send || send.disabled) return false;
      input.value = ${JSON.stringify(playerInput)};
      send.click();
      return document.querySelector('#routing-hub-input').value === '';
    })()`);
    if (fired) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  lm = await startStubLm();
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

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

  // ── SCENARIO A: invalid continuation output -> fixed message + settings screen (no loading residue) ──
  const onHubA = await newGameToHub(win, base);
  const sentA = await sendHubTurn(win, INPUT_INVALID);
  check('A0 setup: entered the hub and the invalid-output turn actually fired', onHubA && sentA, { activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), sentA });
  const reachedSettings = await waitFor(win, `document.querySelector('#settings-screen')?.classList.contains('active')`, { tries: 200, intervalMs: 100 });
  await sleep(300);
  const stateA = await js(win, `(() => ({
    active: document.querySelector('.screen.active')?.id ?? null,
    loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
    hubActive: !!document.querySelector('#routing-hub-screen')?.classList.contains('active'),
    settingsStatus: (document.querySelector('#lmstudio-settings-status')?.textContent || '').trim(),
    lmCategoryActive: document.querySelector('.settings-category-panel[data-settings-category="lmstudio"]')?.hidden === false
  }))()`);
  log('scenarioA', stateA);
  check('A1 invalid continuation output does NOT strand on #academy-loading-screen (no infinite load)', reachedSettings && !stateA.loadingActive, { active: stateA.active, loadingActive: stateA.loadingActive });
  check('A2 invalid continuation output routes to the #settings-screen', stateA.active === 'settings-screen', { active: stateA.active });
  check('A3 the fixed cause message is shown on the LM settings', stateA.settingsStatus.includes(INVALID_MESSAGE), { settingsStatus: stateA.settingsStatus });

  // ── SCENARIO B: valid 'false' end -> 409 on end while loading -> hub recovery (no loading residue) ──
  const onHubB = await newGameToHub(win, base);
  const sentB = await sendHubTurn(win, INPUT_FALSE);
  check('B0 setup: re-entered the hub and the valid-false end turn actually fired', onHubB && sentB, { activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), sentB });
  // The valid 'false' auto-ends after FINAL_REPLY_AUTO_END_DELAY_MS (3s): the drain loading screen goes
  // up, the hub end request 409s (no decided destination), and the defense returns to the hub with the
  // error shown. Confirm the loading screen actually appeared, then that it recovered to the hub.
  // Best-effort catch of the transient drain loading screen (up ~1s, ~turn-time + 3s after send).
  const loadingShown = await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 300, intervalMs: 100 });
  const recoveredWithError = await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
    && (document.querySelector('#routing-hub-status')?.textContent || '').trim().length > 0
  `, { tries: 150, intervalMs: 100 });
  await sleep(200);
  const stateB = await js(win, `(() => ({
    active: document.querySelector('.screen.active')?.id ?? null,
    loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
    hubStatus: (document.querySelector('#routing-hub-status')?.textContent || '').trim()
  }))()`);
  log('scenarioB', { loadingShown, recoveredWithError, ...stateB });
  // The 409 cause surfaced on the hub is definitive proof the whole endRoutingConversation
  // loading -> 409 -> recover path ran (only that path produces this message), so B1 keys on the
  // recovered end-state rather than on catching the ~1s loading flash.
  check('B1 a failed routing-end does NOT strand on #academy-loading-screen (loading-residue defense)', recoveredWithError && stateB.active === 'routing-hub-screen' && !stateB.loadingActive, { active: stateB.active, loadingActive: stateB.loadingActive });
  check('B2 the failed routing-end returns to the hub with the end-failure cause shown', stateB.hubStatus.includes('no decided routing destination'), { hubStatus: stateB.hubStatus });

  console.log(`stub LM requests: ${lm.requests.length}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { lm?.server?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(exitCode);
});
