// Render-backed routing send-off dispatch check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot drive the browser app's screen transitions (no DOM layout, no real fetch/SSE
// pump against a live server), so the routing send-off question is verified here against the REAL
// client running in Electron, not in the headless suite. This file is intentionally NOT named
// *.test.mjs and lives under app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips
// it; run it by hand with the Electron binary.
//
//   ./node_modules/.bin/electron app/tests/manual/routingTurnDispatchRender.mjs
//
// It boots an isolated game server in routing mode with a DETERMINISTIC local LM Studio stub (no real
// LM Studio), then drives the REAL client routing flow:
//   title -> #start-new-game -> enterRoutingHub() -> the hub 迎え conversation on
//   academy-conversation-session -> type a turn -> #academy-conversation-session-run-conversation ->
//   runConversation() -> /api/conversation/stream -> the decided send-off turn.
// The stub decides the 鍛錬 (training) destination, so the decided turn carries routing_dispatch +
// transition(next_screen=academy-training). With the fix, the client consumes that dispatch IN-TURN
// (reveals the send-off, then moves to academy-training). The bug it guards is the pre-fix stall:
// backend state advances but the UI stays on the conversation screen because the turn-result dispatch
// was only consumed on the conversation-end button path.
//
// VERDICT (what this harness measures against real layout):
//   - SEND-OFF SHOWN THEN DISPATCHED: after the decided turn settles, the active screen is
//     academy-training (NOT academy-conversation-session), and the send-off utterance is present in the
//     conversation message stream (it was revealed before the dispatch moved on).
//
// NEGATIVE CONTROL (run separately, documented in the task report): with the fix reverted (e.g.
// `git stash` the app.js change), the same drive stalls on academy-conversation-session and this
// harness reports FAIL — proving it actually detects the bug.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.mjs';
import { fixtureRoot } from '../helpers.mjs';
import { projectRoot } from '../testPaths.mjs';

const PUBLIC_ROOT = path.join(projectRoot, 'app/public');
const CANONICAL_ASSETS_ROOT = path.join(projectRoot, 'assets/canonical');
const WIN_W = Number(process.env.RTD_WIN_W ?? 1200);
const WIN_H = Number(process.env.RTD_WIN_H ?? 820);
const PLAYER_INPUT = process.env.RTD_INPUT ?? '今週は鍛錬する';

const SENDOFF_TEXT = 'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。';

// Deterministic routing LM stub. Mirrors app/tests/serverApi.test.mjs routingTurnLmResponder: it
// answers each LM round-trip of the hub opening + decided turn so the turn resolves to the 鍛錬
// (training) destination without a real LM Studio.
function routingTurnLmResponder({ body, prompt, requestIndex }) {
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'training';
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) return SENDOFF_TEXT;
  if (requestIndex === 0) return '新しい週をここから始めましょう。';
  return '鍛錬ですね。今の伸ばしたい力にも合っています。';
}

async function startLmStub() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ method: req.method, url: req.url, body });
    const prompt = body.messages?.[0]?.content ?? '';
    const content = routingTurnLmResponder({ body, prompt, requestIndex: requests.length - 1 });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let gameServer;
let lmStub;
let root;
let exitCode = 0;

// Poll the page until `predicate` (a JS expression string returning boolean) is true, or time out.
async function waitFor(win, predicate, { tries = 200, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function main() {
  root = await fixtureRoot('routing-turn-dispatch-render-');

  // Routing-mode play settings sidecar (fallen_star persona), the same shape the server tests write.
  const playModeSettingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(playModeSettingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');

  lmStub = await startLmStub();
  gameServer = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: CANONICAL_ASSETS_ROOT,
    playModeSettingsPath,
    lmStudioConfig: { base_url: lmStub.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((resolve) => gameServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gameServer.address().port}`;

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await sleep(1200); // let app.js boot (refresh(), refreshSaveSlots(), listeners attached)

  // 1) New game in routing mode -> enterRoutingHub() opens the 迎え conversation on the session screen.
  if (!(await waitFor(win, `document.querySelector('#start-new-game')`))) {
    log('NO_START_BUTTON', { screen: await win.webContents.executeJavaScript(`document.querySelector('.screen.active')?.id ?? null`) });
    exitCode = 2; app.quit(); return;
  }
  await win.webContents.executeJavaScript(`document.querySelector('#start-new-game').click(); true`);

  const hubReady = await waitFor(win, `
    document.querySelector('#academy-conversation-session-screen')?.classList.contains('active')
    && !document.querySelector('#academy-conversation-session-run-conversation')?.disabled
    && (document.querySelector('#academy-conversation-session-message-stream')?.textContent || '').trim().length > 0
  `);
  if (!hubReady) {
    log('HUB_NOT_READY', {
      screen: await win.webContents.executeJavaScript(`document.querySelector('.screen.active')?.id ?? null`),
      stream: await win.webContents.executeJavaScript(`(document.querySelector('#academy-conversation-session-message-stream')?.textContent || '').slice(0, 200)`)
    });
    exitCode = 1; app.quit(); return;
  }
  log('hub_opening', {
    screen: await win.webContents.executeJavaScript(`document.querySelector('.screen.active')?.id ?? null`),
    openingLen: await win.webContents.executeJavaScript(`(document.querySelector('#academy-conversation-session-message-stream')?.textContent || '').trim().length`)
  });

  // 2) Send a turn. The deterministic stub decides 鍛錬 -> the decided turn carries routing_dispatch.
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#academy-conversation-session-player-input');
    input.value = ${JSON.stringify(PLAYER_INPUT)};
    document.querySelector('#academy-conversation-session-run-conversation').click();
    return true;
  })()`);

  // 3) With the fix, the decided turn is consumed in-turn and the client moves to academy-training.
  //    Without the fix, it stalls on academy-conversation-session.
  const dispatched = await waitFor(win, `document.querySelector('#academy-training-screen')?.classList.contains('active')`, { tries: 250, intervalMs: 120 });

  await sleep(300); // let the screen settle
  const finalScreen = await win.webContents.executeJavaScript(`document.querySelector('.screen.active')?.id ?? null`);
  // The send-off was revealed into the conversation stream before the dispatch moved on; the (now
  // hidden) conversation DOM still carries it.
  const sendoffSeen = await win.webContents.executeJavaScript(`(document.querySelector('#academy-conversation-session-message-stream')?.textContent || '').includes(${JSON.stringify(SENDOFF_TEXT)})`);
  const conversationStillActive = await win.webContents.executeJavaScript(`document.querySelector('#academy-conversation-session-screen')?.classList.contains('active')`);

  log('final', { dispatched, finalScreen, sendoffSeen, conversationStillActive, lmRequests: lmStub.requests.length });

  const pass = dispatched && finalScreen === 'academy-training-screen' && sendoffSeen && !conversationStillActive;
  console.log(`SEND-OFF SHOWN THEN DISPATCHED (decided routing turn moves to academy-training, not stuck on the conversation screen): ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) {
    console.log('  (a FAIL with finalScreen=academy-conversation-session is the pre-fix stall this harness detects)');
    exitCode = 1;
  }

  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { gameServer?.close(); } catch {}
  try { lmStub?.server?.close(); } catch {}
  if (root) fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
});
