// Render-backed routing-hub IDENTITY check (Electron / real Blink).
//
// `node --test` cannot run app.js (no fetch/DOM/real layout, and it cannot LOAD images), so the routing
// hub identity is driven here in a real Blink client. This file is intentionally NOT named *.test.mjs
// and lives under app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it
// by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubIdentityRender.mjs
//
// It boots an isolated server in ROUTING mode (full game-data fixture pointed at the REAL canonical
// assets + a deterministic local stub LM Studio — no real LM Studio needed), loads the real client,
// drives the REAL title entry path (#start-new-game -> enterRoutingHub -> POST /api/routing/hub/start ->
// academy-conversation-session), then sends ONE real turn through the conversation-session input.
// Finally it reloads the page and LOADS the persisted slot to prove a RESTORED (already-active) routing
// hub re-adopts the identity.
//
// It asserts, against the real DOM, the routing-hub VISUAL wiring:
//   - speaker name / character-name button = the persona display name for RH_VARIANT (default ルミ; NOT セラ / character_001);
//   - the hub speaker face and the session standee point at the EFFECTIVE variant's set
//     (routing_lumi_<variant>, chosen via RH_VARIANT), ACTUALLY LOAD (naturalWidth > 0) and are visible
//     — ルミ's own variant art, NEVER セラ / character_001 / visual_set_001;
//   - the conversation-session stage card = ルーティングハブ (the stage background is a separate meta
//     location and stays blank — this harness checks the CHARACTER visual, not the stage background);
//   - after one turn the speaker stays ルミ with her variant face and the stage stays the hub;
//   - a restored (loaded) hub shows the same variant face/standee.
//
// Run each variant you want to verify (default fallen_star); the visual assertions follow RH_VARIANT:
//   RH_VARIANT=fallen_star ./node_modules/.bin/electron app/tests/manual/routingHubIdentityRender.mjs
//   RH_VARIANT=pool_cat    ./node_modules/.bin/electron app/tests/manual/routingHubIdentityRender.mjs
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
// The persona display name follows the selected variant (mirrors the backend routingPersonaVariants
// display_name); the speaker-name assertions use it for whichever RH_VARIANT is exercised.
const ROUTING_PERSONA_DISPLAY_NAMES = {
  fallen_star: 'ルミ',
  bureau_apprentice: 'リステ・ドリームレッジ',
  dethroned_constellation: 'アステリア・スタークラウン',
  scale_arbiter: 'ユスティ・フェアウェイト',
  pool_cat: 'ネル・グロウパドル',
  far_side_sister: 'ノクテ・ヴェイルサイド',
  eclipse_shadow: 'ウンブラ・カッパーグロウ',
  hourglass_grain: 'サラ・アワーグラス',
  star_egg_keeper: 'ニンナ・スターネスト',
  stardust_sweeper: 'シュシュ・スターブルーム'
};
const ROUTING_PERSONA_DISPLAY_NAME = ROUTING_PERSONA_DISPLAY_NAMES[PERSONA_VARIANT];
const ROUTING_HUB_STAGE_NAME = 'ルーティングハブ';
const OPENING_TEXT = '新しい週をここから始めましょう。今週はどこへ向かいますか。';
const REPLY_TEXT = 'まだ決めきらなくても大丈夫です。ゆっくり考えていきましょう。';
const PLAYER_TURN_TEXT = 'まだ迷っています。';

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

// Deterministic local stub LM Studio. A routing turn drives several distinct model calls; the stub
// returns a schema/prompt-appropriate answer for each so the turn completes and CONTINUES in the hub
// (it does not dispatch away): the emotion choice returns valid structured JSON, the continuation
// judgment returns "true" (keep talking), the routing destination returns "none" (no destination
// decided → no dispatch), and the character reply returns the 迎え opening first, then a plain reply.
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
    let label;
    if (schemaName === 'character_emotion_choice') {
      content = JSON.stringify({ expression: 'neutral' });
      label = 'emotion';
    } else if (prompt.includes('継続したいと思うか')) {
      content = 'true';
      label = 'continuation';
    } else if (prompt.includes('none を返す')) {
      content = 'none';
      label = 'routing-destination';
    } else {
      replyCount += 1;
      content = replyCount === 1 ? OPENING_TEXT : REPLY_TEXT;
      label = replyCount === 1 ? 'opening' : 'reply';
    }
    requests.push({ label, schemaName });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
  const root = await fixtureRoot('routing-hub-identity-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-identity-render-settings-'));
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

// Read the routing-hub identity surfaces from the real DOM. Face/standee state includes naturalWidth so
// we can prove the variant asset actually LOADED (not merely a url on a hidden/broken element).
const MEASURE = `(() => {
  const active = document.querySelector('.screen.active');
  const stream = document.querySelector('#academy-conversation-session-message-stream');
  const text = (el) => (el ? el.textContent : '').replace(/\\s+/g, ' ').trim();
  const characterRows = stream ? [...stream.querySelectorAll('.chat-message.character-message')] : [];
  const speakers = characterRows.map((row) => text(row.querySelector('.message-speaker')));
  const faceImg = characterRows.length ? characterRows[characterRows.length - 1].querySelector('.message-face img') : null;
  const standee = document.querySelector('#academy-conversation-session-character-standee');
  const faceState = (img) => (img ? { src: img.getAttribute('src'), visibility: getComputedStyle(img).visibility, naturalWidth: img.naturalWidth } : null);
  return {
    activeScreenId: active ? active.id : null,
    sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
    messageCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
    characterMessageCount: characterRows.length,
    speakers,
    lastSpeaker: speakers.length ? speakers[speakers.length - 1] : null,
    characterNameButton: text(document.querySelector('#academy-conversation-session-character-name-button')),
    stageName: text(document.querySelector('#academy-conversation-session-location-name-button')),
    face: faceState(faceImg),
    standee: faceState(standee),
    streamText: text(stream)
  };
})()`;

// A valid ルミ visual points at the EFFECTIVE variant's set (routing_lumi_<variant>), actually loaded
// (naturalWidth > 0), and is visible. Checking the variant-specific set proves the display follows the
// session's variant rather than a shared/default set.
const ROUTING_VARIANT_SET_FRAGMENT = `/character_visual_sets/routing_lumi_${PERSONA_VARIANT}/`;
function isRoutingLumiVisual(imageState) {
  if (!imageState) return false;
  const src = imageState.src ?? '';
  return src.includes(ROUTING_VARIANT_SET_FRAGMENT) && imageState.naturalWidth > 0 && imageState.visibility !== 'hidden';
}

function looksLikeCharacter001(imageState) {
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
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`renderer-console[${level}]: ${message}`);
  });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1200)); // let app.js boot

  const measure = () => win.webContents.executeJavaScript(MEASURE);

  // Drive the REAL title entry path (the offscreen button still fires its click handler).
  await win.webContents.executeJavaScript(`document.querySelector('#start-new-game').click(); true`);

  // Poll until the hub opening settles on the conversation session screen with the face image loaded.
  let opening = null;
  for (let i = 0; i < 100; i += 1) {
    opening = await measure();
    if (opening.activeScreenId === 'academy-conversation-session-screen' && opening.characterMessageCount > 0 && (opening.face?.naturalWidth ?? 0) > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  log('after_opening', opening);

  const check = (label, pass, detail) => {
    console.log(`${label}: ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(detail)}`);
    if (!pass) exitCode = 1;
  };

  check('OPENING lands on conversation session screen', opening?.sessionActive === true && opening?.activeScreenId === 'academy-conversation-session-screen', { activeScreenId: opening?.activeScreenId });
  check('OPENING speaker is ルミ (not セラ / character_001)', opening?.lastSpeaker === ROUTING_PERSONA_DISPLAY_NAME, { lastSpeaker: opening?.lastSpeaker });
  check('OPENING character-name button is ルミ', opening?.characterNameButton === ROUTING_PERSONA_DISPLAY_NAME, { characterNameButton: opening?.characterNameButton });
  check('OPENING speaker face is the variant set (loaded, visible), NOT character_001', isRoutingLumiVisual(opening?.face) && !looksLikeCharacter001(opening?.face), { face: opening?.face });
  check('OPENING session standee is the variant set (loaded, visible), NOT character_001', isRoutingLumiVisual(opening?.standee) && !looksLikeCharacter001(opening?.standee), { standee: opening?.standee });
  check('OPENING stage card is the routing hub (not the field stage)', opening?.stageName === ROUTING_HUB_STAGE_NAME, { stageName: opening?.stageName });

  // The opening holds the in-flight guard (and disables the send control) until its reveal + prompt/
  // record refreshes finish; clicking earlier is a no-op processing toast. Wait for the send control
  // to re-enable before sending the turn.
  for (let i = 0; i < 80; i += 1) {
    const ready = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('#academy-conversation-session-run-conversation');
      return !!btn && btn.disabled === false;
    })()`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  // Send ONE real turn through the conversation-session input.
  const sendState = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#academy-conversation-session-player-input');
    const btn = document.querySelector('#academy-conversation-session-run-conversation');
    input.value = ${JSON.stringify(PLAYER_TURN_TEXT)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const disabled = btn.disabled;
    btn.click();
    return { inputValue: input.value, buttonDisabled: disabled };
  })()`);
  log('send_state', sendState);

  // Poll until the assistant reply is revealed (character message count grows past the opening).
  const openingCharCount = opening?.characterMessageCount ?? 0;
  let afterTurn = null;
  for (let i = 0; i < 140; i += 1) {
    afterTurn = await measure();
    if (afterTurn.characterMessageCount > openingCharCount && afterTurn.streamText.includes(PLAYER_TURN_TEXT)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  log('after_turn', afterTurn);

  check('TURN continued the routing conversation (player + reply added)', (afterTurn?.characterMessageCount ?? 0) > openingCharCount && (afterTurn?.streamText ?? '').includes(PLAYER_TURN_TEXT), { openingCharCount, afterTurn: afterTurn?.characterMessageCount });
  check('TURN speaker stays ルミ (did not become セラ / character_001)', afterTurn?.lastSpeaker === ROUTING_PERSONA_DISPLAY_NAME && (afterTurn?.speakers ?? []).every((s) => s === ROUTING_PERSONA_DISPLAY_NAME), { speakers: afterTurn?.speakers });
  check('TURN speaker face stays the variant set (loaded), NOT character_001', isRoutingLumiVisual(afterTurn?.face) && !looksLikeCharacter001(afterTurn?.face), { face: afterTurn?.face });
  check('TURN session standee stays the variant set', isRoutingLumiVisual(afterTurn?.standee) && !looksLikeCharacter001(afterTurn?.standee), { standee: afterTurn?.standee });
  check('TURN stage stays the routing hub', afterTurn?.stageName === ROUTING_HUB_STAGE_NAME, { stageName: afterTurn?.stageName });

  // ---- Phase 2: RESTORE an already-active routing hub via LOAD (reload the page first) ----
  // Reload the page so app.js boots fresh (routingHubConversationId === null, routingPersonaVisual ===
  // null), then load the persisted slot whose active conversation is the routing hub. loadSpecificSlot
  // -> routing -> enterRoutingHub re-adopts the hub and re-registers the variant visual; this
  // proves a restored routing hub keeps ルミ + her variant face (not セラ / a blank).
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1200));
  await win.webContents.executeJavaScript(`document.querySelector('#open-load-screen').click(); true`);
  for (let i = 0; i < 80; i += 1) {
    const ready = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('#slot-load-list .academy-map-action-button.primary');
      return !!btn && btn.disabled === false;
    })()`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('#slot-load-list .academy-map-action-button.primary');
    if (btn) btn.click();
    return !!btn;
  })()`);
  let restored = null;
  for (let i = 0; i < 140; i += 1) {
    restored = await measure();
    if (restored.activeScreenId === 'academy-conversation-session-screen' && restored.characterMessageCount > 0 && (restored.face?.naturalWidth ?? 0) > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  log('after_restore_load', restored);

  check('RESTORE (load) lands on the conversation session screen', restored?.sessionActive === true && restored?.activeScreenId === 'academy-conversation-session-screen', { activeScreenId: restored?.activeScreenId });
  check('RESTORE (load) speaker is ルミ (not セラ / character_001)', restored?.lastSpeaker === ROUTING_PERSONA_DISPLAY_NAME, { lastSpeaker: restored?.lastSpeaker });
  check('RESTORE (load) character-name button is ルミ', restored?.characterNameButton === ROUTING_PERSONA_DISPLAY_NAME, { characterNameButton: restored?.characterNameButton });
  check('RESTORE (load) speaker face is the variant set (loaded), NOT character_001', isRoutingLumiVisual(restored?.face) && !looksLikeCharacter001(restored?.face), { face: restored?.face });
  check('RESTORE (load) session standee is the variant set', isRoutingLumiVisual(restored?.standee) && !looksLikeCharacter001(restored?.standee), { standee: restored?.standee });
  check('RESTORE (load) stage is the routing hub (not the field stage)', restored?.stageName === ROUTING_HUB_STAGE_NAME, { stageName: restored?.stageName });

  log('stub_lm_calls', lm.requests.map((r) => r.label));
  console.log(`OVERALL: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { server?.close(); } catch { /* ignore */ }
  try { lm?.server?.close(); } catch { /* ignore */ }
  // Fire-and-forget the temp cleanup so process.exit runs synchronously and the exit code is reliable.
  for (const p of cleanupPaths) { fs.rm(p, { recursive: true, force: true }).catch(() => {}); }
  process.exit(exitCode);
});
