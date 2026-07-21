// Render-backed daytime conversation screen check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch / DOM / real layout), so the dedicated daytime conversation
// screen (#conversation-day-screen — the SECOND consumer of the shared conversation stage) is verified here
// against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives under
// app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/conversationDayScreenRender.mjs
//
// It boots an isolated server with a DETERMINISTIC local LM stub, does a daytime new-game (which materializes
// the fixture roster + runtime state), and drives the REAL daytime flow against real Blink layout:
//   1. ENTRY: ?initialScreen=conversation-day auto-starts startConversationDay(roster[0]) → lands on the
//      dedicated #conversation-day-screen with the current conversation's STAGE image in the standee frame (no
//      persona standee, no speaker caption), and the opening revealed in the stage's own chat stream (FACE).
//   2. TURN: type + send a real turn over the ordinary character conversation API (/api/conversation/stream);
//      the player utterance + the partner reply appear in the stream and the in-progress status stays hidden.
//   3. COMPOSITION / LAYOUT: 6-category rail, week/moon, motes ambient, the stage image frame + corner ornaments
//      + the click→stage-detail popup, the
//      viewport-fit + internal-scroll + speaker-side bubble invariants (measured against real layout, some via
//      injected rows), the info drawer open/rail-select/switch/backdrop/close + fail-fast, and reduced motion.
//   4. LANDING: drive the REAL academy-map → companion → start flow; a new academy-map character conversation
//      lands on the dedicated #conversation-day-screen (the fixed production entry — legacy is saved phase-2
//      re-entry only, not a landing choice).
// Per ref-camera, the harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.CD_WIN_W ?? 1200);
const WIN_H = Number(process.env.CD_WIN_H ?? 820);
// Deterministic conversation text (opening + one turn) the local LM stub answers so the daytime opening/turn
// flow runs end-to-end against the ordinary character conversation API.
const TURN_INPUT = process.env.CD_INPUT ?? 'おはよう、今日はいい天気だね';
const OPENING_TEXT = 'おはようございます。今日はよく晴れていますね。';
const TURN_REPLY = 'ほんとうに。こんな日は、少し外を歩きたくなります。';

// A SECOND, dedicated turn the stub agrees to move on (場所移動). The reply + cutoff stream as 完成吹き出し; the
// backend then holds the new-stage opening line back and delivers it only inside the final conversation. The
// opening carries a 地の文 + a 発話 so a correct queue-driven reveal shows the 地の文 on screen before its 発話 (a
// transient frame impossible when the opening is dumped all at once by the canonical commit).
const MOVE_INPUT = '一緒に別の場所へ移動しよう';
const MOVE_REPLY = 'いいですね、そうしましょう。';
const MOVE_CUTOFF_TEXT = '（立ち上がって）では、こちらへ行きましょう。';
const MOVE_OPENING_NARRATION = 'あたりを見回して';
const MOVE_OPENING_SPEECH = '新しい場所に着きましたね';
const MOVE_OPENING_TEXT = `（${MOVE_OPENING_NARRATION}）${MOVE_OPENING_SPEECH}。`;

// Parse the first real field destination id from the stage-move destination-selection prompt's 対応表 (the tail
// `名称: location_id` lines). Any real destination drives the move; fail fast if the table can't be parsed so a
// silent no-move does not masquerade as a pass.
function firstDestinationId(prompt) {
  const table = prompt.split('移動可能な移動先の名称とlocation_idの対応表:')[1] ?? '';
  const firstLine = table.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
  const id = firstLine.split(': ').pop()?.trim() ?? '';
  if (!id) throw new Error(`stub could not parse a stage-move destination id from the prompt table: ${JSON.stringify(firstLine)}`);
  return id;
}

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// Renderer-side error console messages captured from the window, so a fail-fast that the product catches
// synchronously and surfaces through reportError (console.error) can be observed by the harness — it is not an
// uncaught window.error, which the product's own try/catch prevents.
const rendererErrors = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// Deterministic character-conversation LM stub: answers the emotion / work-record / continuation LM calls of
// the ordinary conversation pipeline, returns the turn reply when the transcript carries the player's input,
// and otherwise the opening line. This drives the daytime opening/turn end-to-end (no routing prompts).
async function startStubLm() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    requests.push({ url: req.url });
    const prompt = body.messages?.[0]?.content ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    // Order matters: the judgment prompts (stage-move agreement / destination / continuation) also embed the
    // player input in their transcript, so they must be matched before the reply's `includes(TURN_INPUT)`.
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    // Stage-move agreement judgment: agree ONLY on the dedicated move-turn input, so the earlier normal turn
    // stays a no-move turn (both judgment transcripts embed their own player input).
    else if (prompt.includes('場所移動の合意')) content = prompt.includes(MOVE_INPUT) ? 'true' : 'false';
    // Stage-move destination selection: return a real field destination id parsed from the prompt's 対応表 (the
    // normal turn never reaches here because its agreement is false).
    else if (prompt.includes('location_idを1つだけ返す')) content = firstDestinationId(prompt);
    else if (prompt.includes('継続したいと思うか')) content = 'true'; // continuation judgment → keep going
    // Stage-move cutoff reply (区切り発話) — matched before the reply's player-input check.
    else if (prompt.includes('今いる場所での会話を短く区切り')) content = MOVE_CUTOFF_TEXT;
    // The NEW-stage opening line: the only turn with playerInput null → this exact turn line. Matched before the
    // includes(MOVE_INPUT) reply check because the opening prompt's transcript still carries the move-turn input.
    else if (prompt.includes('プレイヤーの次の発言を待たず、直前までの会話に自然に続く発話を生成する。')) content = MOVE_OPENING_TEXT;
    // END finalization strict judgments (会話を終える → drain). Each finalization prompt embeds the transcript,
    // so they MUST be matched before the reply branches below (includes(MOVE_INPUT) / includes(TURN_INPUT) / the
    // generic else), which they would otherwise false-match through the embedded player input. affinity delta is
    // a strict integer -10..10 (a non-integer answer throws `affinity delta answer must be an integer`) and MP
    // reserve a strict integer 0..100; money is 0-fallback but is answered here too so END touches EVERY
    // finalization judgment with a valid answer. (ref-camera.md: an END-driven render harness LM stub answers
    // every finalization LLM judgment, affinity branch before the generic transcript branches.)
    else if (prompt.includes('好感度の変化量を判定する')) content = '0'; // affinity delta → neutral (integer -10..10)
    else if (prompt.includes('MP温存ライン')) content = '30'; // MP reserve line → neutral (integer 0..100)
    else if (prompt.includes('増減したユーザーの所持金を判定する')) content = '0'; // money delta → none (integer)
    else if (prompt.includes(MOVE_INPUT)) content = MOVE_REPLY; // the move-turn reply
    else if (prompt.includes(TURN_INPUT)) content = TURN_REPLY; // the normal reply (transcript carries the input)
    else content = OPENING_TEXT;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// New-game always creates a ROUTING game (app/src/playMode.mjs newGameActivePlayMode: the play-mode sidecar is
// NOT consulted for the new-game mode), and the created save slot's mode governs every request thereafter
// (server.mjs resolves readActiveSlotPlayMode before the sidecar). The play-mode sidecar is only the
// pre-new-game boot fallback, so it is written routing to match the game the harness actually runs — a routing
// sidecar requires a persona variant (normalizePlayModeSettings), so one is supplied though new-game picks its own.
async function newGameFixture() {
  const root = await fixtureRoot('conversation-day-screen-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-day-screen-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  // A writable conversation-popup settings sidecar (the cooldown-only conversation-popup settings API can PATCH it).
  const convPopupSettingsPath = path.join(settingsDir, 'conversation-popup.json');
  return { root, settingsDir, settingsPath, convPopupSettingsPath };
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

// Poll for a transient truthy condition (e.g. a status line shown for a few hundred ms during a turn) and
// report whether it was ever observed within the window.
async function observeTransient(win, predicate, { tries = 120, intervalMs = 20 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// Drive the REAL academy-map → stage node → Go → companion flow and stop on the first stage whose companion
// screen actually lists a selectable character (assignments distribute the roster across academy stages).
// The synthetic 購買/採取 nodes never lead to a companion screen, so they are skipped.
async function reachOccupiedCompanion(win) {
  await js(win, `document.querySelector('[data-screen="academy-map"]').click(); true`);
  if (!(await waitFor(win, `document.querySelectorAll('.academy-map-node').length > 0`, { tries: 80, intervalMs: 50 }))) return false;
  const total = await js(win, `document.querySelectorAll('.academy-map-node').length`);
  for (let i = 0; i < total; i += 1) {
    const label = await js(win, `document.querySelectorAll('.academy-map-node')[${i}]?.getAttribute('aria-label') || ''`);
    if (/購買|採取/.test(label)) continue;
    await js(win, `document.querySelectorAll('.academy-map-node')[${i}].click(); true`);
    const dialogOpen = await waitFor(win, `document.querySelector('#academy-map-location-dialog')?.open === true && (document.querySelector('#academy-map-location-title')?.textContent || '').length > 0`, { tries: 40, intervalMs: 30 });
    if (!dialogOpen) continue;
    await js(win, `document.querySelector('#academy-map-go-button').click(); true`);
    // A confirmed move opens the conversation-partner popup over the map (map stays active; no companion screen).
    const onPopup = await waitFor(win, `document.querySelector('#academy-map-companion-popup') && !document.querySelector('#academy-map-companion-popup').hidden`, { tries: 100, intervalMs: 50 });
    if (!onPopup) continue;
    const cards = await js(win, `document.querySelectorAll('#academy-map-companion-popup-body .academy-map-companion-card').length`);
    if (cards > 0) return true;
    // No candidates at this stage: close the popup (stay on map) and try the next node.
    await js(win, `document.querySelector('#academy-map-companion-popup .academy-map-info-popup-close').click(); true`);
    await waitFor(win, `document.querySelector('#academy-map-companion-popup')?.hidden === true`, { tries: 80, intervalMs: 50 });
  }
  return false;
}

// Click the first conversation-partner popup card: the real click that starts the conversation directly
// (startAcademyMapCompanionConversation → the persisted landing branch). There is no intermediate detail dialog.
async function startFirstCompanionCard(win) {
  return js(win, `document.querySelector('#academy-map-companion-popup-body .academy-map-companion-card').click(); true`);
}

// Reload to the in-progress game (NO ?initialScreen override) and let the boot refresh() adopt the persisted
// state, so the academy map renders its nodes when navigated to.
async function reloadInProgressGame(win, base) {
  await win.loadURL(`${base}/`);
  await waitFor(win, `!!document.querySelector('[data-screen="academy-map"]')`, { tries: 100, intervalMs: 50 });
  await sleep(1500);
}

// New-game establishes runtime state + materializes the fixture roster, then reload the daytime dev screen:
// boot's refresh() adopts that state and ?initialScreen=conversation-day auto-starts startConversationDay(
// roster[0]). Wait for the screen + the auto-started opening to settle (send re-enabled, ≥1 revealed 吹き出し).
async function newGameThenDaytime(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
  await win.loadURL(`${base}/?initialScreen=conversation-day`);
  return waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
  `, { tries: 400, intervalMs: 120 });
}

async function main() {
  lm = await startStubLm();
  const { root, settingsDir, settingsPath, convPopupSettingsPath } = await newGameFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    conversationPopupSettingsPath: convPopupSettingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) { rendererErrors.push(message); console.log(`renderer-error: ${message}`); } });

  // ── 1) ENTRY + SHELL + AMBIENT ────────────────────────────────────────────
  const onDay = await newGameThenDaytime(win, base);
  const rosterName = await js(win, `(async () => { const c = await fetch('/api/characters').then((r) => r.json()); const list = Array.isArray(c) ? c : (c?.characters ?? []); return (list[0]?.display_name || '').trim(); })()`);
  const entry = await js(win, `(() => {
    const active = document.querySelector('.screen.active');
    const stream = document.querySelector('#conversation-day-message-stream');
    const stageImage = document.querySelector('#conversation-day-stage-image');
    const faceImg = stream?.querySelector('.message-face img');
    const face = stream?.querySelector('.message-face');
    const faceCs = face ? getComputedStyle(face) : null;
    return {
      activeScreenId: active ? active.id : null,
      routingActive: !!document.querySelector('#routing-hub-screen.active'),
      sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
      categoryButtons: document.querySelectorAll('#conversation-day-screen .conversation-day-category-button').length,
      weekText: (document.querySelector('#conversation-day-week')?.textContent || '').trim(),
      moonImage: document.querySelector('#conversation-day-moon-phase img')?.getAttribute('src') ?? null,
      motesMode: document.querySelector('#conversation-day-motes')?.dataset.ambient || null,
      standeeFramePresent: !!document.querySelector('.conversation-day-standee-frame'),
      stageImagePresent: !!stageImage,
      stageImageBg: stageImage ? getComputedStyle(stageImage).backgroundImage : '',
      hasSpeakerCaption: !!document.querySelector('#conversation-day-speaker-name'),
      hasStandeeImg: !!document.querySelector('#conversation-day-standee'),
      messageCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      streamText: (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim(),
      faceSrc: faceImg ? (faceImg.getAttribute('src') || '') : '',
      faceBorderColor: faceCs ? faceCs.borderTopColor : '',
      faceBorderWidth: faceCs ? faceCs.borderTopWidth : '',
      faceBackgroundColor: faceCs ? faceCs.backgroundColor : '',
      faceBackgroundImage: faceCs ? faceCs.backgroundImage : '',
      faceBoxShadow: faceCs ? faceCs.boxShadow : ''
    };
  })()`);
  log('entry', { ...entry, rosterName });
  check('ENTRY lands on the dedicated #conversation-day-screen (not routing / academy session)',
    onDay && entry.activeScreenId === 'conversation-day-screen' && !entry.routingActive && !entry.sessionActive, { activeScreenId: entry.activeScreenId });
  check('SHELL: 6 category buttons (incl. diary), week counter, moon phase image, standee frame present',
    entry.categoryButtons === 6 && entry.weekText.includes('週') && entry.weekText.includes('/ 50')
    && /^\/canonical\/moon_phases\/phase_[0-7]\.jpg$/.test(entry.moonImage || '') && entry.standeeFramePresent,
    { categoryButtons: entry.categoryButtons, weekText: entry.weekText, moonImage: entry.moonImage });
  check('WEEK/MOON rendered through the stage: 第N週 / 50 with a moon phase image phase_0-7',
    /^第\d+週 \/ 50$/.test(entry.weekText) && /^\/canonical\/moon_phases\/phase_[0-7]\.jpg$/.test(entry.moonImage || ''),
    { weekText: entry.weekText, moonImage: entry.moonImage });
  check('AMBIENT: the daytime light-motes canvas runs animated under normal motion (rAF loop)',
    entry.motesMode === 'animated', { motesMode: entry.motesMode });
  // STAGE IMAGE: the standee frame's content is the current conversation's STAGE image (a real background url),
  // with NO persona standee image and NO speaker caption text label around the frame.
  check('STAGE: the standee frame shows the current conversation stage image (a real background url), no persona standee, no speaker caption',
    entry.stageImagePresent && /url\(/.test(entry.stageImageBg) && /\/canonical\/backgrounds\//.test(entry.stageImageBg)
    && !entry.hasSpeakerCaption && !entry.hasStandeeImg,
    { stageImagePresent: entry.stageImagePresent, stageImageBg: entry.stageImageBg, hasSpeakerCaption: entry.hasSpeakerCaption, hasStandeeImg: entry.hasStandeeImg });
  // OPENING (ordinary character conversation API): the opening revealed on the stage stream, with the partner's
  // FACE, carrying the stubbed opening text.
  check('OPENING: the opening revealed in the daytime chat stream with the partner face (existing conversation API)',
    entry.messageCount > 0 && entry.faceSrc.length > 0 && entry.streamText.includes('晴れて'),
    { messageCount: entry.messageCount, faceSrc: entry.faceSrc, streamHasOpening: entry.streamText.includes('晴れて') });
  // FACE FRAME: the shared warm parchment frame (gold border rgba(211,180,105,0.42) + cream radial backing +
  // deep floating drop) is sunk into 黒曜 by the daytime scope. The LIVE computed values prove the override
  // wins the cascade (not the shared base): the border is the cool-slate edge token rgba(95,127,166,0.3), the
  // 1px hairline width is kept, the backing is the deepest obsidian rgb(12,14,19) with NO cream gradient image,
  // and the shadow is the tight 黒夜 contact shadow rgba(0,0,0,0.5) 0 3px 8px — no warm/gold ring, no cascade defeat.
  check('FACE FRAME: computed border/background/box-shadow are the live 黒夜 sunk-frame tokens (cool-slate hairline, obsidian backing, contact shadow — no warm gold ring / cream gradient / cascade defeat)',
    /^rgba\(95,\s*127,\s*166,\s*0\.3\)$/.test(entry.faceBorderColor)
    && entry.faceBorderWidth === '1px'
    && /^rgb\(12,\s*14,\s*19\)$/.test(entry.faceBackgroundColor)
    && entry.faceBackgroundImage === 'none'
    && /rgba\(0,\s*0,\s*0,\s*0\.5\)/.test(entry.faceBoxShadow) && /\b3px 8px\b/.test(entry.faceBoxShadow),
    { faceBorderColor: entry.faceBorderColor, faceBorderWidth: entry.faceBorderWidth, faceBackgroundColor: entry.faceBackgroundColor, faceBackgroundImage: entry.faceBackgroundImage, faceBoxShadow: entry.faceBoxShadow });

  // ── 1.5) TURN over the ordinary character conversation API (/api/conversation/stream) ──
  // Type + send a real turn; the player utterance + the partner reply are appended to the stage stream, and
  // the in-progress status stays hidden (daytime chat shows no in-progress text — the ① responding glow only).
  const beforeTurn = await js(win, `document.querySelectorAll('#conversation-day-message-stream .chat-message').length`);
  const fired = await js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
    const send = document.querySelector('#conversation-day-send');
    if (!input || !send || send.disabled) return false;
    input.value = ${JSON.stringify(TURN_INPUT)};
    send.click();
    return true;
  })()`);
  // The real send synchronously clears the input; a still-populated input means an in-flight silent no-op.
  const sent = fired && await waitFor(win, `document.querySelector('#conversation-day-input').value === ''`, { tries: 60, intervalMs: 50 });
  const statusTextEver = await observeTransient(win, `(() => { const s = document.querySelector('#conversation-day-status'); return !!s && s.hidden === false && (s.textContent || '').trim().length > 0; })()`, { tries: 120, intervalMs: 20 });
  const settled = sent && await waitFor(win, `
    !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length >= ${beforeTurn} + 2
    && document.querySelector('#conversation-day-status')?.hidden === true
  `, { tries: 400, intervalMs: 120 });
  await sleep(300);
  const turn = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const text = (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim();
    return {
      rowCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      hasPlayerInput: text.includes(${JSON.stringify(TURN_INPUT)}),
      hasReply: text.includes('外を歩きたく'),
      statusHidden: !!document.querySelector('#conversation-day-status')?.hidden
    };
  })()`);
  log('turn', { beforeTurn, fired, sent, statusTextEver, settled, ...turn });
  check('TURN: a real turn flows end-to-end over the existing conversation API (player utterance + partner reply appended)',
    sent && settled && turn.rowCount >= beforeTurn + 2 && turn.hasPlayerInput && turn.hasReply,
    { beforeTurn, rowCount: turn.rowCount, hasPlayerInput: turn.hasPlayerInput, hasReply: turn.hasReply });
  check('TURN: no in-progress status text during the turn (progress is the ① responding glow), status hidden after',
    !statusTextEver && turn.statusHidden, { statusTextEver, statusHidden: turn.statusHidden });

  // Screenshots for うゆりす's visual confirmation (warm player bubbles, grounded face-icon shadow, the flipped
  // BR chat corner, the stage-move opening reveal), saved to one fixed task-named tmp dir printed for the report.
  const shotDir = path.join(os.tmpdir(), 'hub-day-chat-decor-polish');
  await fs.mkdir(shotDir, { recursive: true });
  const capture = async (name) => {
    const p = path.join(shotDir, name);
    try { await fs.writeFile(p, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${p}`); }
    catch (e) { console.log(`screenshot: FAILED ${name} ${e?.message ?? e}`); }
  };

  // ── 1.55) STAGE-MOVE TURN: the post-move opening reveals through the SAME reveal queue ────────
  // Drive a turn the stub agrees to move on. The reply + movement cutoff stream as 完成吹き出し; the backend then
  // holds the new-stage opening line back (delivered only in the final conversation), which the daytime turn must
  // enqueue onto the stage reveal queue so 移動後の発話・地の文 pop in one 吹き出し単位 at a time. Because the opening
  // splits into a 地の文 + a 発話, a correct sequential reveal passes through a transient frame where the 地の文 is
  // on screen but its 発話 is NOT yet — a frame that never exists if the opening is dumped all at once by the
  // canonical commit (the pre-fix defect: まとめて・いつの間にか).
  const beforeMove = await js(win, `document.querySelectorAll('#conversation-day-message-stream .chat-message').length`);
  const moveFired = await js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
    const send = document.querySelector('#conversation-day-send');
    if (!input || !send || send.disabled) return false;
    input.value = ${JSON.stringify(MOVE_INPUT)};
    send.click();
    return true;
  })()`);
  const moveSent = moveFired && await waitFor(win, `document.querySelector('#conversation-day-input').value === ''`, { tries: 60, intervalMs: 50 });
  // Poll concurrently with the reveal for the sequential-reveal signature (地の文 shown, 発話 not yet). observeTransient
  // returns as soon as it is seen; a broken all-at-once dump never produces it, so this poll fails the check.
  const openingRevealedSequentially = moveSent && await observeTransient(win, `(() => {
    const t = (document.querySelector('#conversation-day-message-stream')?.textContent || '');
    return t.includes(${JSON.stringify(MOVE_OPENING_NARRATION)}) && !t.includes(${JSON.stringify(MOVE_OPENING_SPEECH)});
  })()`, { tries: 900, intervalMs: 15 });
  const moveSettled = moveSent && await waitFor(win, `
    !document.querySelector('#conversation-day-send')?.disabled
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(MOVE_OPENING_SPEECH)})
  `, { tries: 500, intervalMs: 120 });
  await sleep(300);
  const move = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const text = (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim();
    return {
      rowCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      hasReply: text.includes('そうしましょう'),
      hasCutoff: text.includes('こちらへ行きましょう'),
      hasOpeningNarration: text.includes(${JSON.stringify(MOVE_OPENING_NARRATION)}),
      hasOpeningSpeech: text.includes(${JSON.stringify(MOVE_OPENING_SPEECH)})
    };
  })()`);
  log('stage_move_turn', { beforeMove, moveFired, moveSent, openingRevealedSequentially, moveSettled, ...move });
  check('STAGE-MOVE: the post-move opening line reveals through the reveal queue one 吹き出し at a time (地の文 shown before its 発話), never dumped all at once',
    moveSent && moveSettled && openingRevealedSequentially && move.hasOpeningNarration && move.hasOpeningSpeech,
    { openingRevealedSequentially, hasCutoff: move.hasCutoff, hasOpeningNarration: move.hasOpeningNarration, hasOpeningSpeech: move.hasOpeningSpeech, rowCount: move.rowCount });
  await capture('conversation-day-stage-move.png');

  // ── 1.6) COMPOSER FIXED SIZE (可変→固定) ───────────────────────────────────
  // The daytime input is a fixed-height box (resize:none): a long multi-line value must NOT stretch the input;
  // the overflow is absorbed by an internal scroll (scrollHeight > clientHeight), and the drag-resize handle is
  // gone. Measured against real Blink layout, then the input is restored.
  const composerProbe = await js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
    const saved = input.value;
    const cs = getComputedStyle(input);
    const heightShort = input.getBoundingClientRect().height;
    input.value = Array.from({ length: 40 }, (_, i) => 'とても長い発言テスト行' + i).join('\\n');
    void input.offsetHeight;
    const rectLong = input.getBoundingClientRect();
    const result = {
      resize: cs.resize,
      heightShort,
      heightLong: rectLong.height,
      heightDelta: Math.abs(rectLong.height - heightShort),
      scrolls: input.scrollHeight > input.clientHeight + 1
    };
    input.value = saved;
    return result;
  })()`);
  log('composer_fixed_size', composerProbe);
  check('COMPOSER fixed size: a long multi-line value does not stretch the daytime input; overflow scrolls internally; drag-resize is disabled',
    composerProbe.resize === 'none' && composerProbe.heightDelta < 1 && composerProbe.scrolls, composerProbe);

  await sleep(800);
  await capture('conversation-day-chat.png');

  // ── 2) LAYOUT / WIDTH / VERTICAL-FIT / SCROLL-FOLLOW ──────────────────────
  // Inject a tall history with one very long unbroken run, measure real layout, then restore. Long text must
  // not widen the panel; the log scrolls internally with the frame/stream/standee/button inside the viewport;
  // the newest row must be stuck to the bottom (the same injected-rows technique the routing harness uses).
  const layoutProbe = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const savedHtml = stream.innerHTML;
    const panel = document.querySelector('.conversation-day-chat-panel');
    const widthBefore = panel.getBoundingClientRect().width;
    const longRun = 'あ'.repeat(400) + ' https://example.com/' + 'x'.repeat(320);
    const rowsHtml = [];
    for (let i = 0; i < 10; i += 1) {
      rowsHtml.push('<article class="chat-message player-message"><div class="message-bubble"><p>短い発言' + i + '</p></div></article>');
      const content = i === 9 ? longRun : ('相手の応答' + i);
      rowsHtml.push('<article class="chat-message character-message"><div class="message-face"><img src="" alt=""></div><div class="message-bubble"><strong class="message-speaker">会話相手</strong><p>' + content + '</p></div></article>');
    }
    stream.innerHTML = rowsHtml.join('');
    stream.scrollTop = stream.scrollHeight;
    const frameEl = document.querySelector('.conversation-day-frame');
    const rows = stream.querySelectorAll('.chat-message');
    const lastRow = rows[rows.length - 1];
    const panelRect = panel.getBoundingClientRect();
    const streamRect = stream.getBoundingClientRect();
    const lastRowRect = lastRow.getBoundingClientRect();
    const standeeFrameRect = document.querySelector('.conversation-day-standee-frame').getBoundingClientRect();
    const stageRect = document.querySelector('.conversation-day-stage').getBoundingClientRect();
    const result = {
      innerW: window.innerWidth, innerH: window.innerHeight,
      widthBefore, widthAfter: panelRect.width, widthDelta: Math.abs(panelRect.width - widthBefore),
      panelRight: panelRect.right, lastRowRight: lastRowRect.right,
      streamScrollH: stream.scrollHeight, streamClientH: stream.clientHeight,
      atBottom: (stream.scrollTop + stream.clientHeight) >= (stream.scrollHeight - 3),
      lastRowBottom: lastRowRect.bottom, streamBottom: streamRect.bottom,
      frameBottom: frameEl.getBoundingClientRect().bottom,
      standeeFrameBottom: standeeFrameRect.bottom, standeeFrameHeight: standeeFrameRect.height,
      stageHeight: stageRect.height, chatPanelBottom: panelRect.bottom,
      buttonRowBottom: document.querySelector('.conversation-day-button-row').getBoundingClientRect().bottom
    };
    stream.innerHTML = savedHtml;
    return result;
  })()`);
  log('layout_probe', layoutProbe);
  check('WIDTH fixed: long partner text does not widen the chat panel and stays within the viewport',
    layoutProbe.widthDelta < 1 && layoutProbe.panelRight <= layoutProbe.innerW + 1 && layoutProbe.lastRowRight <= layoutProbe.innerW + 1,
    { widthBefore: layoutProbe.widthBefore, widthAfter: layoutProbe.widthAfter, panelRight: layoutProbe.panelRight, innerW: layoutProbe.innerW });
  check('VERTICAL fit: log scrolls internally; frame/stream/standee-frame/buttons stay within the viewport',
    layoutProbe.streamScrollH > layoutProbe.streamClientH && layoutProbe.frameBottom <= layoutProbe.innerH + 1 && layoutProbe.streamBottom <= layoutProbe.innerH + 1 && layoutProbe.standeeFrameBottom <= layoutProbe.innerH + 1 && layoutProbe.buttonRowBottom <= layoutProbe.innerH + 1,
    { frameBottom: layoutProbe.frameBottom, streamBottom: layoutProbe.streamBottom, standeeFrameBottom: layoutProbe.standeeFrameBottom, buttonRowBottom: layoutProbe.buttonRowBottom, innerH: layoutProbe.innerH });
  check('SCROLL follow: newest message sticks to the bottom and is visible in the log',
    layoutProbe.atBottom && layoutProbe.lastRowBottom <= layoutProbe.streamBottom + 2,
    { atBottom: layoutProbe.atBottom, lastRowBottom: layoutProbe.lastRowBottom, streamBottom: layoutProbe.streamBottom });
  check('STANDEE frame is ~60% of the stage height and bottom-aligned with the chat window',
    Math.abs(layoutProbe.standeeFrameHeight / layoutProbe.stageHeight - 0.6) <= 0.06 && Math.abs(layoutProbe.standeeFrameBottom - layoutProbe.chatPanelBottom) <= 2,
    { standeeFrameHeight: layoutProbe.standeeFrameHeight, stageHeight: layoutProbe.stageHeight, standeeFrameBottom: layoutProbe.standeeFrameBottom, chatPanelBottom: layoutProbe.chatPanelBottom });

  // ── 3) SPEAKER-SIDE BUBBLE ALIGNMENT ──────────────────────────────────────
  const alignProbe = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const savedHtml = stream.innerHTML;
    const long = 'あ'.repeat(300);
    stream.innerHTML = [
      '<article class="chat-message character-message" data-t="partner"><div class="message-face"><img src="" alt=""></div><div class="message-bubble"><strong class="message-speaker">会話相手</strong><p>' + long + '</p></div></article>',
      '<article class="chat-message narration-message" data-t="partnerNarr"><div class="message-bubble"><p>' + long + '</p></div></article>',
      '<article class="chat-message player-message" data-t="player"><div class="message-bubble"><p>' + long + '</p></div></article>',
      '<article class="chat-message player-narration-message" data-t="playerNarr"><div class="message-bubble"><p>' + long + '</p></div></article>'
    ].join('');
    const ICON = 129 + 12;
    const measure = (t) => {
      const row = stream.querySelector('.chat-message[data-t="' + t + '"]');
      const bubble = row.querySelector('.message-bubble');
      const cs = getComputedStyle(bubble);
      const sr = stream.getBoundingClientRect();
      const br = bubble.getBoundingClientRect();
      const contentW = br.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      return {
        leftInset: Math.round((br.left - sr.left) * 10) / 10,
        rightInset: Math.round((sr.right - br.right) * 10) / 10,
        contentW: Math.round(contentW * 10) / 10,
        expectedCap: Math.round(0.8 * (row.clientWidth - ICON) * 10) / 10,
        iconCol: ICON
      };
    };
    const result = {
      partner: measure('partner'), partnerNarr: measure('partnerNarr'),
      player: measure('player'), playerNarr: measure('playerNarr')
    };
    stream.innerHTML = savedHtml;
    return result;
  })()`);
  log('align_probe', alignProbe);
  const capOk = (m) => Math.abs(m.contentW - m.expectedCap) <= 2;
  check('SPEAKER-SIDE: every message type caps at 80% of the icon-excluded row width (no unclassified type)',
    capOk(alignProbe.partner) && capOk(alignProbe.partnerNarr) && capOk(alignProbe.player) && capOk(alignProbe.playerNarr), alignProbe);
  check('SPEAKER-SIDE: 相手の発話・地の文 hug the LEFT (bubble starts at the 141px icon column)',
    Math.abs(alignProbe.partner.leftInset - alignProbe.partner.iconCol) <= 3 && Math.abs(alignProbe.partnerNarr.leftInset - alignProbe.partnerNarr.iconCol) <= 3,
    { partnerLeftInset: alignProbe.partner.leftInset, partnerNarrLeftInset: alignProbe.partnerNarr.leftInset });
  check('SPEAKER-SIDE: 主人公の発話・地の文 hug the RIGHT and never cross into the 相手の顔アイコン列',
    alignProbe.player.rightInset <= 10 && alignProbe.playerNarr.rightInset <= 10
    && alignProbe.player.leftInset >= alignProbe.player.iconCol && alignProbe.playerNarr.leftInset >= alignProbe.playerNarr.iconCol,
    { playerLeftInset: alignProbe.player.leftInset, playerRightInset: alignProbe.player.rightInset });

  // ── 4) CORNER ORNAMENT ORIENTATION ────────────────────────────────────────
  // Chat corners: corner_01, TL upright (baked 0px → matrix(1,0,0,1,0,0)), BR its 180° point reflection —
  // translate(0,0) scale(-1,-1) → matrix(-1,0,0,-1,0,0). Standee corners: corner_02 ::before rotate(-90deg)
  // TL = matrix(0,-1,1,0,0,0), ::after rotate(+90deg) BR = matrix(0,1,-1,0,0,0).
  const cornerProbe = await js(win, `(() => {
    const norm = (t) => (!t || t === 'none' ? 'none' : t.replace(/\\s+/g, ''));
    const chatTL = document.querySelector('.conversation-day-corner-tl');
    const chatBR = document.querySelector('.conversation-day-corner-br');
    const sframe = document.querySelector('.conversation-day-standee-frame');
    const before = getComputedStyle(sframe, '::before');
    const after = getComputedStyle(sframe, '::after');
    return {
      chatTLsrc: chatTL.getAttribute('src'), chatBRsrc: chatBR.getAttribute('src'),
      chatTLtransform: norm(getComputedStyle(chatTL).transform), chatBRtransform: norm(getComputedStyle(chatBR).transform),
      beforeBg: before.backgroundImage, afterBg: after.backgroundImage,
      beforeTransform: norm(before.transform), afterTransform: norm(after.transform)
    };
  })()`);
  log('corner_probe', cornerProbe);
  const parseMatrix = (t) => { const m = /^matrix\(([^)]+)\)$/.exec(t); return m ? m[1].split(',').map(Number) : null; };
  const matrixApprox = (t, expected) => { const g = parseMatrix(t); return !!g && g.length === expected.length && expected.every((v, i) => Math.abs(g[i] - v) <= 1e-4); };
  check('CORNER chat: TL is corner_01 upright (matrix 1,0,0,1); BR is corner_01 point-reflected scale(-1,-1) (matrix -1,0,0,-1) = the 180° point reflection of the TL',
    /corner_01\.png$/.test(cornerProbe.chatTLsrc) && /corner_01\.png$/.test(cornerProbe.chatBRsrc)
    && matrixApprox(cornerProbe.chatTLtransform, [1, 0, 0, 1, 0, 0]) && matrixApprox(cornerProbe.chatBRtransform, [-1, 0, 0, -1, 0, 0]),
    { chatTLsrc: cornerProbe.chatTLsrc, chatTLtransform: cornerProbe.chatTLtransform, chatBRtransform: cornerProbe.chatBRtransform });
  check('CORNER standee: ::before=corner_02 rotate(-90deg) TL, ::after=corner_02 rotate(+90deg) BR (180° point reflection)',
    /corner_02\.png/.test(cornerProbe.beforeBg) && /corner_02\.png/.test(cornerProbe.afterBg)
    && matrixApprox(cornerProbe.beforeTransform, [0, -1, 1, 0, 0, 0]) && matrixApprox(cornerProbe.afterTransform, [0, 1, -1, 0, 0, 0]),
    { beforeBg: cornerProbe.beforeBg, afterBg: cornerProbe.afterBg, beforeTransform: cornerProbe.beforeTransform, afterTransform: cornerProbe.afterTransform });

  // ── 4.5) STAGE IMAGE + STAGE-DETAIL POPUP ─────────────────────────────────
  // The stage image is the standee frame's sole content, filling it edge-to-edge (no余白 beyond the 1px border),
  // with the corner ornaments sitting over it. Clicking the image opens a daytime stage-detail popup (舞台名 +
  // 舞台画像 + visible_situation), dismissed by its close button + backdrop (same modal流儀 as the info drawer).
  const stageGeom = await js(win, `(() => {
    const frame = document.querySelector('.conversation-day-standee-frame');
    const image = document.querySelector('#conversation-day-stage-image');
    const fr = frame.getBoundingClientRect();
    const ir = image.getBoundingClientRect();
    return {
      dx: Math.abs(ir.left - fr.left), dy: Math.abs(ir.top - fr.top),
      widthGap: fr.width - ir.width, heightGap: fr.height - ir.height,
      beforeZ: Number(getComputedStyle(frame, '::before').zIndex),
      imageZ: Number(getComputedStyle(image).zIndex),
      bg: getComputedStyle(image).backgroundImage
    };
  })()`);
  log('stage_geometry', stageGeom);
  check('STAGE IMAGE fills the standee frame edge-to-edge (no余白 gap beyond the 1px border) and cover-fills a real background',
    stageGeom.widthGap <= 3 && stageGeom.heightGap <= 3 && stageGeom.dx <= 2 && stageGeom.dy <= 2 && /url\(/.test(stageGeom.bg),
    stageGeom);
  check('STAGE ornaments overlap the image: the corner ornament z-index sits above the stage image',
    stageGeom.beforeZ > stageGeom.imageZ, { beforeZ: stageGeom.beforeZ, imageZ: stageGeom.imageZ });

  await js(win, `document.querySelector('#conversation-day-stage-image').click(); true`);
  const stagePopupOpen = await waitFor(win, `!document.querySelector('#conversation-day-stage-popup').hidden`, { tries: 40, intervalMs: 40 });
  const stagePopup = await js(win, `(() => {
    const image = document.querySelector('#conversation-day-stage-popup-image');
    return {
      title: (document.querySelector('#conversation-day-stage-popup-title')?.textContent || '').trim(),
      text: (document.querySelector('#conversation-day-stage-popup-text')?.textContent || '').trim(),
      bg: image ? getComputedStyle(image).backgroundImage : ''
    };
  })()`);
  log('stage_popup', { stagePopupOpen, ...stagePopup });
  check('STAGE POPUP: clicking the stage image opens the daytime stage-detail popup with 舞台名 + 舞台画像 + visible_situation',
    stagePopupOpen && stagePopup.title.length > 0 && stagePopup.text.length > 0 && /url\(/.test(stagePopup.bg) && /\/canonical\/backgrounds\//.test(stagePopup.bg),
    stagePopup);
  await capture('conversation-day-stage-popup.png');
  await js(win, `document.querySelector('#conversation-day-stage-popup .conversation-day-info-popup-close').click(); true`);
  const stageClosed = await waitFor(win, `document.querySelector('#conversation-day-stage-popup').hidden === true`, { tries: 40, intervalMs: 40 });
  check('STAGE POPUP: the close button dismisses it', stageClosed, { stageClosed });
  await js(win, `document.querySelector('#conversation-day-stage-image').click(); true`);
  await waitFor(win, `!document.querySelector('#conversation-day-stage-popup').hidden`, { tries: 40, intervalMs: 40 });
  const stageBackdropClosed = await js(win, `(() => { document.querySelector('#conversation-day-stage-popup .conversation-day-stage-popup-backdrop').click(); return true; })()`)
    .then(() => waitFor(win, `document.querySelector('#conversation-day-stage-popup').hidden === true`, { tries: 40, intervalMs: 40 }));
  check('STAGE POPUP: clicking the backdrop dismisses it (same modal流儀 as the info drawer)', stageBackdropClosed, { stageBackdropClosed });

  // Runtime fail-fast: with the popup node's id broken, a still-bound close hook throws (broken markup) instead
  // of silently succeeding. Open the popup, break the id, click the close button, expect the click to throw, then
  // restore the id and close cleanly.
  const stageCloseFailFast = await js(win, `(() => {
    document.querySelector('#conversation-day-stage-image').click();
    const popup = document.querySelector('#conversation-day-stage-popup');
    popup.id = 'conversation-day-stage-popup-broken';
    let threw = false;
    const onErr = (e) => { threw = true; e.preventDefault(); };
    window.addEventListener('error', onErr);
    try { document.querySelector('#conversation-day-stage-popup-broken .conversation-day-info-popup-close').click(); }
    catch (_) { threw = true; }
    window.removeEventListener('error', onErr);
    popup.id = 'conversation-day-stage-popup';
    const stillShown = !popup.hidden;
    popup.hidden = true;
    return { threw, stillShown };
  })()`);
  log('stage_close_fail_fast', stageCloseFailFast);
  check('STAGE POPUP FAIL-FAST: closing with the popup node id broken throws (no silent no-op), popup stays shown until wiring is fixed',
    stageCloseFailFast.threw && stageCloseFailFast.stillShown, stageCloseFailFast);

  // ── 4b) CHARACTER POPUP (task): the 相手 speaker name in a chat bubble opens the partner's character popup
  // (能力値 ability meters + 一枚絵 standee). Opening + turns are revealed, so a 相手側 .message-speaker exists;
  // clicking it fires the delegated stream listener (the 主人公側 bubbles carry no name element → not clickable). ──
  const daySpeakerPresent = await waitFor(win, `!!document.querySelector('#conversation-day-message-stream .message-speaker')`, { tries: 40, intervalMs: 40 });
  check('CHARACTER POPUP: the 相手 speaker name is present in a chat bubble (the click target)', daySpeakerPresent);
  await js(win, `document.querySelector('#conversation-day-message-stream .message-speaker').click(); true`);
  const dayCharPopupOpen = await waitFor(win, `!document.querySelector('#conversation-day-character-popup').hidden`, { tries: 40, intervalMs: 40 });
  const dayCharPopup = await js(win, `(() => {
    const popup = document.querySelector('#conversation-day-character-popup');
    const standee = document.querySelector('#conversation-day-character-popup-standee');
    return {
      title: (document.querySelector('#conversation-day-character-popup-title')?.textContent || '').trim(),
      standeeSrc: standee ? standee.getAttribute('src') : null,
      paramItems: popup.querySelectorAll('.character-parameter-item').length,
      paramSections: popup.querySelectorAll('.character-parameter-section').length
    };
  })()`);
  log('character_popup', { dayCharPopupOpen, ...dayCharPopup });
  check('CHARACTER POPUP: clicking the 相手の名前 opens the daytime character popup with the partner name, a 一枚絵 standee, and the 11 ability meters (能力値・魔法習熟度6＋基礎能力5)',
    dayCharPopupOpen && dayCharPopup.title.length > 0 && dayCharPopup.title === rosterName
      && !!dayCharPopup.standeeSrc && dayCharPopup.paramSections === 2 && dayCharPopup.paramItems === 11,
    dayCharPopup);
  // Let the standee decode + the offscreen window repaint the new popup frame so capturePage shows it (not a
  // stale frame), then capture the open character popup.
  await waitFor(win, `(() => { const i = document.querySelector('#conversation-day-character-popup-standee'); return !!i && i.complete && i.naturalWidth > 0; })()`, { tries: 80, intervalMs: 40 });
  await sleep(300);
  await capture('conversation-day-character-popup.png');
  await js(win, `document.querySelector('#conversation-day-character-popup .conversation-day-info-popup-close').click(); true`);
  const dayCharClosed = await waitFor(win, `document.querySelector('#conversation-day-character-popup').hidden === true`, { tries: 40, intervalMs: 40 });
  check('CHARACTER POPUP: the close button dismisses it', dayCharClosed, { dayCharClosed });
  await js(win, `document.querySelector('#conversation-day-message-stream .message-speaker').click(); true`);
  await waitFor(win, `!document.querySelector('#conversation-day-character-popup').hidden`, { tries: 40, intervalMs: 40 });
  const dayCharBackdropClosed = await js(win, `(() => { document.querySelector('#conversation-day-character-popup .conversation-day-character-popup-backdrop').click(); return true; })()`)
    .then(() => waitFor(win, `document.querySelector('#conversation-day-character-popup').hidden === true`, { tries: 40, intervalMs: 40 }));
  check('CHARACTER POPUP: clicking the backdrop dismisses it (same modal流儀 as the info drawer)', dayCharBackdropClosed, { dayCharBackdropClosed });

  // ── 5) INFO DRAWER (each category opens through the stage as a rail-linked drawer) ──
  for (const category of ['self', 'buddy', 'enemy', 'inventory', 'money']) {
    await js(win, `document.querySelector('.conversation-day-category-button[data-day-category="${category}"]').click(); true`);
    const opened = await waitFor(win, `!document.querySelector('#conversation-day-info-popup').hidden && (document.querySelector('#conversation-day-info-popup-body')?.childElementCount || 0) > 0`, { tries: 40, intervalMs: 40 });
    const title = await js(win, `document.querySelector('#conversation-day-info-popup-title')?.textContent || ''`);
    check(`info drawer [${category}] opens with content`, opened, { title });
    const selected = await js(win, `[...document.querySelectorAll('#conversation-day-screen .conversation-day-category-button')].filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.dayCategory)`);
    check(`info drawer [${category}] marks exactly its rail button selected`, selected.length === 1 && selected[0] === category, { selected });
    await js(win, `document.querySelector('#conversation-day-info-popup .conversation-day-info-popup-close').click(); true`);
    await waitFor(win, `document.querySelector('#conversation-day-info-popup').hidden === true`, { tries: 40, intervalMs: 40 });
    const cleared = await js(win, `[...document.querySelectorAll('#conversation-day-screen .conversation-day-category-button')].every((b) => !b.classList.contains('is-active'))`);
    check(`info drawer [${category}] clears the selected rail state on close`, cleared, { cleared });
  }

  // Drawer geometry: opens as a LEFT drawer from the rail's right edge, roughly full height, chat still beside it.
  await js(win, `document.querySelector('.conversation-day-category-button[data-day-category="self"]').click(); true`);
  await waitFor(win, `!document.querySelector('#conversation-day-info-popup').hidden`, { tries: 40, intervalMs: 40 });
  const drawer = await js(win, `(() => {
    const card = document.querySelector('#conversation-day-info-popup .conversation-day-info-popup-card');
    const rail = document.querySelector('#conversation-day-screen .conversation-day-category-rail');
    const chat = document.querySelector('#conversation-day-screen .conversation-day-chat-panel');
    const frame = document.querySelector('#conversation-day-screen .conversation-day-frame');
    const cr = card.getBoundingClientRect();
    return {
      winW: window.innerWidth, cardLeft: cr.left, cardRight: cr.right, cardHeight: cr.height,
      railRight: rail.getBoundingClientRect().right, chatLeft: chat.getBoundingClientRect().left,
      frameHeight: frame.getBoundingClientRect().height
    };
  })()`);
  log('drawer_geometry', drawer);
  check('DRAWER: opens from the rail right edge, left-hugging (not centered), roughly full height, chat beside it',
    drawer.cardLeft >= drawer.railRight - 2 && ((drawer.winW - drawer.cardRight) - drawer.cardLeft) > 120
    && drawer.cardHeight >= drawer.frameHeight * 0.85 && drawer.chatLeft >= drawer.cardRight - 8, drawer);

  // The self drawer is open here, so its re-skinned status meters (low=sky → mid=sun → high=ember) are on screen.
  // Settle so the drawer's slide-in has composited before the capture (the geometry above is already laid out).
  await sleep(500);
  await capture('conversation-day-self-drawer.png');

  // Switch-while-open: open self, click buddy WITHOUT closing → stays open, content/title/icon/rail swap to buddy.
  await js(win, `document.querySelector('.conversation-day-category-button[data-day-category="buddy"]').click(); true`);
  const switched = await js(win, `(() => {
    const popup = document.querySelector('#conversation-day-info-popup');
    const active = [...document.querySelectorAll('#conversation-day-screen .conversation-day-category-button')].filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.dayCategory);
    return {
      stillOpen: !popup.hidden,
      title: document.querySelector('#conversation-day-info-popup-title')?.textContent || '',
      iconSrc: document.querySelector('#conversation-day-info-popup-icon')?.getAttribute('src') || '',
      bodyChildren: document.querySelector('#conversation-day-info-popup-body')?.childElementCount || 0,
      active
    };
  })()`);
  log('category_switch_while_open', switched);
  check('SWITCH: clicking another category while open swaps content + selection without closing',
    switched.stillOpen && switched.title === 'バディー' && switched.iconSrc.includes('/conversation_day/icons/buddy.png')
    && switched.bodyChildren > 0 && switched.active.length === 1 && switched.active[0] === 'buddy', switched);

  // Backdrop-click dismissal.
  const backdropClosed = await js(win, `(() => { document.querySelector('#conversation-day-info-popup .conversation-day-info-popup-backdrop').click(); return true; })()`)
    .then(() => waitFor(win, `document.querySelector('#conversation-day-info-popup').hidden === true`, { tries: 40, intervalMs: 40 }));
  check('BACKDROP: clicking the backdrop dismisses the drawer', backdropClosed, {});

  // Runtime fail-fast: with the header icon node's id broken, openInfo throws — but the conversation-day rail
  // click handler catches that synchronous throw and routes it to reportError (console.error), so it is NOT an
  // uncaught window.error. The harness therefore observes the PRODUCT error surface (a captured renderer error
  // console message) plus the drawer staying hidden with no rail selected. The id is restored afterwards.
  const iconErrBefore = rendererErrors.length;
  const iconFailFast = await js(win, `(() => {
    const icon = document.querySelector('#conversation-day-info-popup-icon');
    icon.id = 'conversation-day-info-popup-icon-broken';
    document.querySelector('.conversation-day-category-button[data-day-category="self"]').click();
    icon.id = 'conversation-day-info-popup-icon';
    const anyActive = [...document.querySelectorAll('#conversation-day-screen .conversation-day-category-button')].some((b) => b.classList.contains('is-active'));
    return { hidden: document.querySelector('#conversation-day-info-popup').hidden, anyActive };
  })()`);
  await sleep(100);
  const iconErrored = rendererErrors.slice(iconErrBefore).some((m) => /icon node is missing|broken markup/.test(m));
  log('icon_fail_fast', { ...iconFailFast, iconErrored });
  check('FAIL-FAST: a broken header icon node surfaces a product error on category open (no silent no-op), drawer stays hidden with no rail selected',
    iconErrored && iconFailFast.hidden && !iconFailFast.anyActive, { ...iconFailFast, iconErrored });

  // ── 5.4) END BUTTON (会話を終える → the mode-appropriate 復帰先) ───────────────
  // The daytime end button reuses the existing endConversationDay → endConversation path. This harness runs a
  // routing game (new-game always creates routing — see newGameFixture), so a non-errand daytime character
  // conversation ends through the shared end path and returns to the routing hub (#routing-hub-screen): the
  // server resolves the mode-appropriate 復帰先 (resolvePostContentScreen → ROUTING_HUB_SCREEN for routing).
  // The daytime conversation from ENTRY is still active here (the drawer probes above left it untouched); drive
  // the REAL click and assert it leaves the daytime screen for the routing hub.
  const endBtnState = await js(win, `(() => {
    const btn = document.querySelector('#conversation-day-end');
    return {
      present: !!btn,
      label: (btn?.textContent || '').trim(),
      disabled: !!btn?.disabled,
      dayActive: !!document.querySelector('#conversation-day-screen')?.classList.contains('active')
    };
  })()`);
  const endClicked = endBtnState.present && !endBtnState.disabled && endBtnState.dayActive
    && await js(win, `(() => { document.querySelector('#conversation-day-end').click(); return true; })()`);
  const backToHub = endClicked && await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#conversation-day-screen')?.classList.contains('active')`, { tries: 400, intervalMs: 120 });
  log('end_button', { ...endBtnState, endClicked, backToHub });
  check('END BUTTON: 会話を終える ends the daytime conversation via the existing path and returns to the mode-appropriate 復帰先 (routing hub #routing-hub-screen for this routing game)',
    endBtnState.present && endBtnState.label === '会話を終える' && endClicked && backToHub,
    { ...endBtnState, endClicked, backToHub });

  // ── 5.5) PRODUCTION LANDING (an academy-map character conversation lands on the daytime screen) ──
  // New-conversation landing is fixed to the dedicated daytime screen: the removed day/legacy preference is
  // gone and legacy is now reserved for saved phase-2 re-entry only, not a new-conversation landing choice.
  // Reload to the in-progress game (NO ?initialScreen override), drive the REAL academy-map → companion →
  // start flow, and assert the production entry lands on #conversation-day-screen. The dev entry above already
  // proved startConversationDay itself works; this proves the single production entry.
  await reloadInProgressGame(win, base);
  const dayReached = await reachOccupiedCompanion(win);
  const dayStarted = dayReached && await startFirstCompanionCard(win);
  const dayLanding = dayStarted && await waitFor(win, `document.querySelector('#conversation-day-screen')?.classList.contains('active') && !document.querySelector('#academy-conversation-session-screen')?.classList.contains('active')`, { tries: 240, intervalMs: 60 });
  log('landing_day', { dayReached, dayStarted, dayLanding });
  check('LANDING: an academy-map character conversation lands on the dedicated #conversation-day-screen (fixed daytime landing)',
    Boolean(dayReached && dayStarted && dayLanding),
    { dayReached, dayStarted, dayLanding });

  // ── 6) REDUCED MOTION ─────────────────────────────────────────────────────
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
  } catch (e) { console.log(`cdp emulate: ${e?.message ?? e}`); }
  await newGameThenDaytime(win, base);
  const rm = await js(win, `(() => {
    const decor = document.querySelector('#conversation-day-screen .conversation-day-decor');
    const canvas = document.querySelector('#conversation-day-motes');
    const stream = document.querySelector('#conversation-day-message-stream');
    const savedHtml = stream.innerHTML;
    stream.insertAdjacentHTML('beforeend', '<article class="chat-message character-message pop-in" data-rm-probe="1"><div class="message-bubble"><p>相手</p></div></article>');
    const popInAnimation = getComputedStyle(stream.querySelector('[data-rm-probe="1"]')).animationName;
    stream.innerHTML = savedHtml;
    return {
      prefersReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      decorAnimationName: decor ? getComputedStyle(decor).animationName : null,
      motesMode: canvas ? (canvas.dataset.ambient || null) : null,
      popInAnimation
    };
  })()`);
  log('reduced_motion', rm);
  check('REDUCED MOTION: emulated; daytime decor animation disabled AND motes run static (no rAF loop)',
    rm.prefersReduced && rm.decorAnimationName === 'none' && rm.motesMode === 'static', rm);
  check('REDUCED MOTION: the daytime 吹き出し pop-in fade is disabled (即時出現; interval discipline kept by the reveal queue)',
    rm.prefersReduced && rm.popInAnimation === 'none', { popInAnimation: rm.popInAnimation });

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
