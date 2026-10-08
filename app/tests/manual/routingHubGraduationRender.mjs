// Render-backed routing graduation check — the academy-person form (Electron / real Blink layout + real client flow).
//
// Sibling of routingHubSessionScreenRender.mjs (same 系). `node --test` cannot run app.js (no fetch/DOM/SSE pump), so
// the graduation guide → academy-person selection → 卒業会話 → title path is verified here against the REAL client in
// Electron. Not named *.test.mjs and under app/tests/manual/, so `npm test` skips it; run by hand with the directory
// the shots go to (1440×900 PNGs):
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubGraduationRender.mjs <absolute shot dir>
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC LM stub, new-games into the hub, and drives the
// REAL flow:
//   E. ORDINARY EVENT: a pending event (stargazing promise) is seeded on the slot and the hub sends the player to the
//      academy map; the arrival starts the event, which opens through the conversation passage onto the daytime
//      screen marked `event`. Shot: the conversation just entered.
//   W. WRAP-UP: 今日はここまで on an ordinary hub walks the night journey back along the road to the gate (unchanged).
//   1. GUIDE ENTRY (hub start) at elapsed_weeks=49 (the displayed graduation week): the hub week reads 第50週 / 50.
//   2. GUIDE END: 今日はここまで during the guide keeps the conversation alive (no 409); the selection follows directly,
//      and the night-journey layer must stay down over its passage.
//   3. SELECTION → 卒業会話: a turn confirming a candidate (an academy person) opens the graduation event the same way
//      the ordinary event opens — the conversation passage onto the daytime screen marked `event`, never the
//      「卒業のときを迎えました」 box — at the front gate (正門, the opening request's 舞台 line), with elapsed_weeks still 49
//      and the week reading 第50週 / 50. Shots: just after choosing, the front gate's passage filling in, the first words.
//   4. EXCHANGES: three more turns. Shot.
//   5. END → TITLE: ending the conversation shows 「卒業しました。」 and lands on #title-screen. The end box is the 案内人
//      form: 「卒業しました。」 once (the product box alone, no line under it, the night-journey layer down). Shots: the
//      box, the title.
// Every box loader that shows (the loading screen up without a passage) is recorded with its title, so the run says
// which boxes appeared on the way.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// The end box as it looks while it is up: the product box carries 「卒業しました。」 alone (no line under it), and the
// night-journey layer stays down over it — the words appear once.
const END_BOX_LOOK = `(() => {
  const journey = document.querySelector('#journey');
  const roadCopy = document.querySelector('.journey-road-copy');
  const status = document.querySelector('#academy-loading-status');
  return {
    boxTitle: (document.querySelector('#academy-loading-title')?.textContent || '').trim(),
    boxCopyDisplay: getComputedStyle(document.querySelector('#academy-loading-screen .academy-loading-copy')).display,
    statusHidden: status.hidden,
    statusText: (status.textContent || '').trim(),
    journeyScene: journey?.dataset.scene ?? null,
    journeyOpacity: getComputedStyle(journey).opacity,
    roadCopyShown: Boolean(roadCopy && !roadCopy.hidden && journey?.dataset.scene === 'road')
  };
})()`;
const endBoxSingle = (look) => look.boxTitle === '卒業しました。' && look.boxCopyDisplay !== 'none' && look.statusHidden && look.statusText === ''
  && look.journeyScene === 'play' && !look.roadCopyShown;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = 1440;
const WIN_H = 900;
const PERSONA_VARIANT = 'fallen_star';
const SHOT_DIR = process.argv.at(-1);
if (!path.isAbsolute(SHOT_DIR ?? '') || SHOT_DIR.endsWith('.mjs')) {
  throw new Error(`pass the absolute shot directory as the last argument (got ${JSON.stringify(SHOT_DIR)})`);
}
// The ordinary event the comparison shot enters, and its partner.
const ORDINARY_EVENT_FLAG_ID = 'event.stargazing_promise.ready';
const ORDINARY_EVENT_CHARACTER_ID = 'character_001';
const SENDOFF_INPUT = '学院マップへ行って、星を見る約束を果たしたい';
// The partner-selection input (the stub's graduation_guide_selection judgment picks the first candidate).
const SELECT_INPUT = 'あなたと一緒に、この学院生活を締めくくりたい';
const SELECT_REPLY = 'ふふ、うれしい。では最後の時間を、一緒に過ごしましょうね。';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const EXCHANGE_INPUTS = ['入学した日のこと、覚えてる？', 'いちばん楽しかったのは学院祭かな。', 'これからも、また会えるよね。'];
const REPLIES = [
  'とうとうこの日が来たね。門の向こうの朝が、少しまぶしい。',
  '覚えてるよ。あなた、校舎の場所を三回も聞きに来たもの。',
  '学院祭の夜は、広場の灯りがずっと消えなかったね。',
  'うん。手紙を書くから、ちゃんと返事をちょうだいね。'
];

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
const { resolvePlayRoot, resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// Deterministic routing LM stub: the guide's partner selection picks the first candidate off the prompt's candidate
// table; the destination judgment sends the player to the academy map only on SENDOFF_INPUT; every other free reply
// takes the next of REPLIES so the shots show distinct words.
let replyIndex = 0;
function routingTurnLmResponder({ prompt, requestIndex }) {
  if (prompt.includes('好感度の変化量を判定する')) return '0';
  if (prompt.includes('MP温存ライン')) return '30';
  if (prompt.includes('所持金判定')) return '0';
  if (prompt.includes('場所移動の合意')) return 'false';
  if (prompt.includes('location_idを1つだけ返す')) return 'none';
  if (prompt.includes('締めくくりを誰と過ごすと選んだか')) {
    const m = prompt.match(/character_\d{3}/);
    return m ? m[0] : 'none';
  }
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
    return prompt.includes(SENDOFF_INPUT) ? 'academy-map' : 'none';
  }
  if (requestIndex === 0) return OPENING_TEXT;
  if (prompt.includes(SELECT_INPUT)) return SELECT_REPLY;
  const reply = REPLIES[replyIndex % REPLIES.length];
  replyIndex += 1;
  return reply;
}

async function startStubLm() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    const prompt = body.messages?.[0]?.content ?? '';
    const allText = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    requests.push({ url: req.url, allText });
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) content = 'true';
    else content = routingTurnLmResponder({ prompt, requestIndex: requests.length - 1 });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// The persona / 舞台 / 見えている状況 lines of every LM request from index `since` on that carries any of them.
function sceneLinesSince(requests, since) {
  return requests.slice(since).map((entry, offset) => ({
    request: since + offset,
    lines: entry.allText.split('\n').map((line) => line.trim()).filter((line) => /^(あなたは.+である。|舞台:|見えている状況:)/.test(line))
  })).filter((entry) => entry.lines.length > 0);
}

async function routingFixture() {
  const root = await fixtureRoot('routing-hub-graduation-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-graduation-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: PERSONA_VARIANT }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

// Rewrite the ACTIVE ROUTING SLOT's runtime state (routing keeps it per save slot, resolved through active_slot.json).
async function editActiveSlotState(root, edit) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  const slotId = active.active_slot_id ?? active.slot_id ?? active.active_slot ?? null;
  if (!slotId) throw new Error(`no active routing slot to seed: ${JSON.stringify(active)}`);
  const statePath = path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  edit(state);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { slotId, elapsedWeeks: state.elapsed_weeks };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 300, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// A hidden window paints on demand: invalidate first so the capture is the current frame, not the last one painted.
async function shoot(win, name) {
  win.webContents.invalidate();
  await sleep(150);
  const file = path.join(SHOT_DIR, name);
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
  console.log(`screenshot: ${file}`);
}

// Record every box loader that shows (the loading screen up with no conversation passage) by its title, in order.
async function watchBoxLoaders(win) {
  await js(win, `(() => {
    window.__boxLoadersSeen = [];
    window.__passageSeen = false;
    setInterval(() => {
      const loading = document.querySelector('#academy-loading-screen');
      if (!loading?.classList.contains('active')) return;
      if (loading.dataset.conversationPassage) { window.__passageSeen = true; return; }
      const title = (document.querySelector('#academy-loading-title')?.textContent || '').trim();
      if (window.__boxLoadersSeen.at(-1) !== title) window.__boxLoadersSeen.push(title);
    }, 20);
    return true;
  })()`);
}

const takeLoaderRecord = (win) => js(win, `(() => {
  const record = { boxes: window.__boxLoadersSeen ?? [], passage: window.__passageSeen === true };
  window.__boxLoadersSeen = [];
  window.__passageSeen = false;
  return record;
})()`);

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

// Fire a turn with the given input, retrying until the real send actually starts (the input is cleared synchronously
// on a fired send; a still-populated input is an in-flight silent no-op).
async function sendTurn(win, { screen, input: inputSelector, send: sendSelector }, input) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await waitFor(win, `document.querySelector('${screen}')?.classList.contains('active') && !document.querySelector('${sendSelector}')?.disabled`, { tries: 100, intervalMs: 100 });
    const fired = await js(win, `(() => {
      const el = document.querySelector('${inputSelector}');
      const send = document.querySelector('${sendSelector}');
      if (!el || !send || send.disabled) return false;
      el.value = ${JSON.stringify(input)};
      send.click();
      return true;
    })()`);
    if (fired && await waitFor(win, `document.querySelector('${inputSelector}').value === ''`, { tries: 40, intervalMs: 50 })) return true;
    await sleep(400);
  }
  return false;
}
const HUB = { screen: '#routing-hub-screen', input: '#routing-hub-input', send: '#routing-hub-send' };
const DAY = { screen: '#conversation-day-screen', input: '#conversation-day-input', send: '#conversation-day-send' };

// Re-enter the hub by LOADING the active slot from a freshly reloaded client, so the slot's edited state is read and
// a fresh POST /api/routing/hub/start runs on it.
async function loadSlotIntoHub(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1200);
  await js(win, `document.querySelector('.screen-tabs button[data-screen="slot-load"]')?.click(); true`);
  const listed = await waitFor(win, `
    document.querySelector('#slot-load-screen')?.classList.contains('active')
    && document.querySelector('#slot-load-list .slot-load-item .academy-map-action-button.primary:not([disabled])')
  `);
  if (!listed) return false;
  await js(win, `document.querySelector('#slot-load-list .slot-load-item .academy-map-action-button.primary:not([disabled])')?.click(); true`);
  return waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 400, intervalMs: 120 });
}

// What the daytime conversation screen shows: its kind mark, the week, the stage name, the partner's face.
const readDayScreen = (win) => js(win, `(async () => {
  const state = await fetch('/api/state').then((r) => r.json());
  const screen = document.querySelector('#conversation-day-screen');
  const face = document.querySelector('#conversation-day-screen .cl-face');
  return {
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
    conversationKind: screen?.dataset.conversationKind ?? null,
    weekText: (document.querySelector('#conversation-day-week')?.textContent || '').trim(),
    stageName: (document.querySelector('#cl-stage-name')?.textContent || '').trim(),
    stage: screen?.dataset.clStage ?? null,
    facePartner: face?.dataset.partner ?? null,
    faceName: (face?.querySelector('.cl-face-name')?.textContent || '').trim(),
    elapsedWeeks: Number(state?.elapsed_weeks),
    currentScreen: state?.current_screen ?? null,
    currentLocationId: state?.current_location_id ?? null,
    endingCharacterId: state?.ending_character_id ?? null,
    pendingEventFlag: state?.pending_interaction_context?.event_flag_id ?? null,
    guideCleared: state?.routing_graduation_guide == null,
    assistantBubbles: document.querySelectorAll('#conversation-day-message-stream .message.assistant, #conversation-day-message-stream [data-role="assistant"]').length,
    streamText: (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().slice(-160)
  };
})()`);

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  lm = await startStubLm();
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing', variant: PERSONA_VARIANT, shotDir: SHOT_DIR });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  const onHub = await newGameToHub(win, base);
  check('ENTRY lands on the routing hub', onHub && await js(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active')`));

  // ── W) WRAP-UP: 今日はここまで on an ordinary hub still walks the night journey back along the road to the gate ────
  await js(win, `(() => {
    window.__journeyScenes = [];
    setInterval(() => {
      const scene = document.querySelector('#journey')?.dataset.scene ?? null;
      if (window.__journeyScenes.at(-1) !== scene) window.__journeyScenes.push(scene);
    }, 20);
    return true;
  })()`);
  // The end is a silent no-op while the hub opening is still in flight: wait for the settled hub, then retry until the
  // end has actually started (the loading screen or the title is up).
  let wrapUpClicked = false;
  for (let attempt = 0; attempt < 20 && !wrapUpClicked; attempt += 1) {
    await waitFor(win, `document.querySelector('#journey')?.dataset.scene === 'play' && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
    await js(win, `(() => { const end = document.querySelector('#routing-hub-end'); if (end && !end.disabled) end.click(); return true; })()`);
    wrapUpClicked = await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active') || document.querySelector('#title-screen')?.classList.contains('active')`, { tries: 20, intervalMs: 50 });
    if (!wrapUpClicked) await sleep(400);
  }
  const wrappedToTitle = wrapUpClicked && await waitFor(win, `
    document.querySelector('#title-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 400, intervalMs: 100 });
  await sleep(800);
  const wrapUp = await js(win, `({ scenes: window.__journeyScenes, activeScreenId: document.querySelector('.screen.active')?.id ?? null })`);
  log('wrap_up', { wrapUpClicked, wrappedToTitle, ...wrapUp });
  check('WRAP-UP: 今日はここまで on an ordinary hub walks the road back to the gate and lands on the title',
    Boolean(wrappedToTitle && wrapUp.scenes.includes('road') && wrapUp.scenes.at(-1) === 'gate'), wrapUp);

  // ── E) ORDINARY EVENT: hub → academy map → pending event → passage → daytime screen marked event ──────────────
  log('seed_ordinary_event', await editActiveSlotState(root, (state) => {
    state.global_flags ??= {};
    state.event_flag_sources ??= {};
    state.global_flags[ORDINARY_EVENT_FLAG_ID] = true;
    state.event_flag_sources[ORDINARY_EVENT_FLAG_ID] = { character_id: ORDINARY_EVENT_CHARACTER_ID, conversation_id: null, achieved_at: new Date().toISOString(), source_type: 'conversation' };
  }));
  const eventHub = await loadSlotIntoHub(win, base);
  await watchBoxLoaders(win);
  const sendoffSent = eventHub && await sendTurn(win, HUB, SENDOFF_INPUT);
  const onEventDay = sendoffSent && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 100 });
  const eventLoaders = await takeLoaderRecord(win);
  await shoot(win, 'event-entry.png');
  const eventDay = await readDayScreen(win);
  log('ordinary_event', { eventHub, sendoffSent, onEventDay, loaders: eventLoaders, ...eventDay });
  check('ORDINARY EVENT: the academy-map arrival opens the pending event through the passage onto the daytime screen marked event',
    Boolean(onEventDay && eventDay.conversationKind === 'event' && eventLoaders.passage), { kind: eventDay.conversationKind, loaders: eventLoaders });

  // ── 1) GUIDE ENTRY at elapsed_weeks=49 + WEEK 第50週 ─────────────────────────────────────────────────────────────
  log('seed_guide_week', await editActiveSlotState(root, (state) => {
    state.elapsed_weeks = 49;
    state.global_flags[ORDINARY_EVENT_FLAG_ID] = false;
    delete state.event_flag_sources[ORDINARY_EVENT_FLAG_ID];
    state.pending_interaction_context = null;
    state.current_interaction_character_id = null;
  }));
  const guideOnHub = await loadSlotIntoHub(win, base);
  await sleep(600);
  const afterGuideEntry = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      elapsedWeeks: Number(state?.elapsed_weeks),
      guideActive: state?.routing_graduation_guide != null,
      candidates: state?.routing_graduation_guide?.candidate_character_ids ?? [],
      weekText: (document.querySelector('#routing-hub-week')?.textContent || '').trim(),
      journeyScene: document.querySelector('#journey')?.dataset.scene ?? null
    };
  })()`);
  log('guide_entry', { guideOnHub, ...afterGuideEntry });
  check('GUIDE ENTRY: the hub at the displayed graduation week holds the guide (elapsed_weeks 49, candidates present)',
    Boolean(guideOnHub && afterGuideEntry.activeScreenId === 'routing-hub-screen' && afterGuideEntry.elapsedWeeks === 49 && afterGuideEntry.guideActive && afterGuideEntry.candidates.length >= 1), afterGuideEntry);
  check('GUIDE WEEK: the hub week reads 第50週 / 50', afterGuideEntry.weekText === '第50週 / 50', afterGuideEntry);

  // ── 2) GUIDE END: 今日はここまで keeps the guide conversation alive ───────────────────────────────────────────────
  const guideEndClicked = await js(win, `(() => { const end = document.querySelector('#routing-hub-end'); if (!end || end.disabled) return false; end.click(); return true; })()`);
  const guideEndSettled = guideEndClicked && await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
  `, { tries: 300, intervalMs: 120 });
  await sleep(400);
  const afterGuideEnd = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    const status = document.querySelector('#routing-hub-status');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      statusText: (status?.textContent || '').trim(),
      elapsedWeeks: Number(state?.elapsed_weeks),
      guideActive: state?.routing_graduation_guide != null
    };
  })()`);
  log('guide_end', { guideEndClicked, guideEndSettled, ...afterGuideEnd });
  check('GUIDE END: 今日はここまで during the guide stays on the hub with no error, guide active, elapsed_weeks 49',
    Boolean(guideEndSettled && afterGuideEnd.activeScreenId === 'routing-hub-screen' && afterGuideEnd.statusText === '' && afterGuideEnd.guideActive && afterGuideEnd.elapsedWeeks === 49), afterGuideEnd);

  // ── 3) SELECTION → 卒業会話 ───────────────────────────────────────────────────────────────────────────────────
  const beforeSelection = await js(win, `fetch('/api/state').then((r) => r.json()).then((s) => ({ elapsedWeeks: Number(s.elapsed_weeks), weekText: (document.querySelector('#routing-hub-week')?.textContent || '').trim() }))`);
  log('before_selection', beforeSelection);
  await watchBoxLoaders(win);
  const requestsBeforeSelection = lm.requests.length;
  const selectSent = await sendTurn(win, HUB, SELECT_INPUT);
  // Just after choosing: the first moment the hub has handed off (the loading screen is up).
  const handedOff = selectSent && await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 600, intervalMs: 25 });
  await sleep(handedOff ? 700 : 0);
  await shoot(win, 'academy-01-selected.png');
  const selectedLook = await js(win, `(() => {
    const loading = document.querySelector('#academy-loading-screen');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      passageStep: loading?.dataset.conversationPassage ?? null,
      passageWeek: (document.querySelector('#academy-loading-screen .cl-passage-week')?.textContent || '').trim(),
      passageStageName: (document.querySelector('#academy-loading-screen .cl-passage-stage-name')?.textContent || '').trim(),
      boxTitle: loading?.dataset.conversationPassage ? null : (document.querySelector('#academy-loading-title')?.textContent || '').trim(),
      journeyScene: document.querySelector('#journey')?.dataset.scene ?? null,
      journeyOpacity: getComputedStyle(document.querySelector('#journey')).opacity,
      journeyDisplay: getComputedStyle(document.querySelector('#journey')).display,
      boxCopyDisplay: getComputedStyle(document.querySelector('#academy-loading-screen .academy-loading-copy')).display,
      boxBackdropDisplay: getComputedStyle(document.querySelector('#academy-loading-screen .academy-loading-backdrop')).display
    };
  })()`);
  log('selected', { handedOff, ...selectedLook });
  // The front gate's passage filling in (its arriving step), still under the loading screen.
  const passageArriving = handedOff && await waitFor(win, `document.querySelector('#academy-loading-screen')?.dataset.conversationPassage === 'arriving'`, { tries: 600, intervalMs: 25 });
  if (passageArriving) {
    await sleep(500);
    await shoot(win, 'academy-01b-passage-arriving.png');
  }
  log('passage_arriving', { passageArriving, journeyScene: await js(win, `document.querySelector('#journey')?.dataset.scene ?? null`) });
  const onGraduationDay = selectSent && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 100 });
  const selectionLoaders = await takeLoaderRecord(win);
  await sleep(1500);
  await shoot(win, 'academy-02-first-words.png');
  const firstWords = await readDayScreen(win);
  const sceneRequests = sceneLinesSince(lm.requests, requestsBeforeSelection);
  // The partner's opening: the request that speaks as the partner whose face is shown.
  const partnerScene = sceneRequests.find((entry) => firstWords.faceName && entry.lines.includes(`あなたは${firstWords.faceName}である。`)) ?? null;
  log('first_words', { onGraduationDay, loaders: selectionLoaders, ...firstWords });
  log('scene_lines_since_selection', sceneRequests);
  // The selection comes right after the guide-week 今日はここまで: the night-journey layer must be down, not walking the
  // road back to the gate over the passage.
  check('SELECTION after the guide-week 今日はここまで: the night-journey layer is down (scene play) and the box copy is hidden',
    selectedLook.journeyScene === 'play' && selectedLook.boxCopyDisplay === 'none' && selectedLook.passageStep !== null, selectedLook);
  check('SELECTION: the graduation opens through the passage onto the daytime screen marked event, with no box loader on the way',
    Boolean(onGraduationDay && firstWords.conversationKind === 'event' && selectionLoaders.passage && selectionLoaders.boxes.length === 0), { kind: firstWords.conversationKind, loaders: selectionLoaders });
  check('SELECTION: the backend started phase 2 on the daytime screen (interaction) at the front gate, guide cleared',
    Boolean(firstWords.endingCharacterId && firstWords.pendingEventFlag === 'event.graduation_ending.ready' && firstWords.guideCleared
      && firstWords.currentScreen === 'interaction' && firstWords.currentLocationId === 'front_gate_morning'), firstWords);
  check('SELECTION: the front gate is the stage and the partner appears as a face in the corner',
    Boolean(firstWords.stage === 'front_gate_morning' && firstWords.stageName === '正門' && firstWords.facePartner === firstWords.endingCharacterId), firstWords);
  check('WEEK: elapsed_weeks stays 49 across the start and the conversation week reads 第50週 / 50',
    beforeSelection.elapsedWeeks === 49 && firstWords.elapsedWeeks === 49 && firstWords.weekText === '第50週 / 50', { before: beforeSelection, after: { elapsedWeeks: firstWords.elapsedWeeks, weekText: firstWords.weekText } });
  check('SCENE: the request that speaks as the graduation partner carries 舞台: 正門', Boolean(partnerScene?.lines.includes('舞台: 正門')), { partnerScene });

  // ── 4) EXCHANGES ─────────────────────────────────────────────────────────────────────────────────────────────
  const exchanges = [];
  for (const input of EXCHANGE_INPUTS) {
    const sent = await sendTurn(win, DAY, input);
    const replied = sent && await waitFor(win, `
      (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(input)})
      && !document.querySelector('#conversation-day-send')?.disabled
    `, { tries: 400, intervalMs: 100 });
    exchanges.push({ input, sent, replied });
  }
  await sleep(1500);
  await shoot(win, 'academy-03-three-exchanges.png');
  const afterExchanges = await readDayScreen(win);
  log('exchanges', { exchanges, ...afterExchanges });
  check('EXCHANGES: three more turns run on the same screen (kind event, week 第50週 / 50)',
    exchanges.every((e) => e.sent && e.replied) && afterExchanges.activeScreenId === 'conversation-day-screen' && afterExchanges.conversationKind === 'event' && afterExchanges.weekText === '第50週 / 50', { exchanges, kind: afterExchanges.conversationKind, weekText: afterExchanges.weekText });

  // ── 5) END → TITLE ───────────────────────────────────────────────────────────────────────────────────────────
  await watchBoxLoaders(win);
  let endClicked = false;
  for (let attempt = 0; attempt < 20 && !endClicked; attempt += 1) {
    endClicked = await js(win, `(() => { const end = document.querySelector('#conversation-day-end'); if (!end || end.disabled) return false; end.click(); return true; })()`);
    if (!endClicked) await sleep(400);
  }
  // The box, while it is up (the end request keeps it up).
  const boxUp = endClicked && await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active') && (document.querySelector('#academy-loading-title')?.textContent || '').includes('卒業しました')`, { tries: 400, intervalMs: 20 });
  let boxLook = null;
  if (boxUp) {
    await sleep(400);
    await shoot(win, 'academy-04a-graduated-box.png');
    boxLook = await js(win, END_BOX_LOOK);
  }
  log('end_box', { boxUp, ...boxLook });
  check('END BOX: 卒業しました。 appears once — the product box alone with no line under it, the night-journey layer down (the 案内人 form)',
    Boolean(boxUp && endBoxSingle(boxLook)), boxLook);
  const endedToTitle = endClicked && await waitFor(win, `
    document.querySelector('#title-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 100 });
  const endLoaders = await takeLoaderRecord(win);
  await sleep(1200);
  await shoot(win, 'academy-04-title.png');
  const titleState = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    return { activeScreenId: document.querySelector('.screen.active')?.id ?? null, endingCompleted: state?.ending_completed === true, elapsedWeeks: Number(state?.elapsed_weeks) };
  })()`);
  log('end_to_title', { endClicked, endedToTitle, loaders: endLoaders, ...titleState });
  check('END → TITLE: ending the conversation shows 卒業しました。 and lands on #title-screen',
    Boolean(endedToTitle && titleState.activeScreenId === 'title-screen' && titleState.endingCompleted && endLoaders.boxes.includes('卒業しました。')), { loaders: endLoaders, ...titleState });

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
