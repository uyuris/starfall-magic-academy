// Render-backed routing graduation check — the 案内人 form (Electron / real Blink layout + real client flow).
//
// Sibling of routingHubGraduationRender.mjs (which drives the academy-person form). `node --test` cannot run app.js
// (no fetch/DOM/SSE pump), so the graduation guide → 案内人 selection → 卒業会話 → title path is verified here against
// the REAL client in Electron. Not named *.test.mjs and under app/tests/manual/, so `npm test` skips it; run by hand
// with the directory the shots go to (1440×900 PNGs):
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubGraduationPersonaRender.mjs <absolute shot dir>
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC LM stub, new-games into the hub (the 案内人 set to
// one variant before the hub start), and drives the REAL flow:
//   1. GUIDE ENTRY (hub start) at elapsed_weeks=49 (the displayed graduation week): the hub week reads 第50週 / 50.
//   2. SELECTION: a turn choosing the 案内人 herself. The screen stays on the terrace — no box, no passage, no wait for
//      a drain or an opening — the conversation id is the one before the choice, and the history goes on. Shot.
//   3. FIRST WORDS / EXCHANGES: the graduation words go on in the same conversation on the terrace. The requests that
//      speak as the 案内人 carry 舞台: 月の文字盤の露台 and the terrace's 見えている状況 (never 正門), no stage-move judgment
//      runs, and the place does not move. Shots after the first and the third exchange.
//   4. END → TITLE: 今日はここまで ends the conversation as the graduation: 「卒業しました。」 and #title-screen. The
//      post-processing requests carry the same terrace 舞台, and the slot is graduated. The end box shows 「卒業しました。」
//      once (the product box alone, no line under it, the night-journey layer down). Shots: the box, the title.
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
const PERSONA_DISPLAY_NAME = 'ルミ';
const SHOT_DIR = process.argv.at(-1);
if (!path.isAbsolute(SHOT_DIR ?? '') || SHOT_DIR.endsWith('.mjs')) {
  throw new Error(`pass the absolute shot directory as the last argument (got ${JSON.stringify(SHOT_DIR)})`);
}
// The partner-selection input: the player asks to spend the last time with the 案内人 herself. The stub's selection
// judgment answers `lina` for it.
const SELECT_INPUT = 'あなた自身と、この学院生活の最後を過ごしたい';
const SELECT_REPLY = 'ふふ、うれしい。では最後の時間を、わたしと一緒に過ごしましょうね。';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const EXCHANGE_INPUTS = ['入学した日のこと、覚えてる？', 'いちばん楽しかったのは学院祭かな。', 'これからも、また会えるよね。'];
const REPLIES = [
  'とうとうこの日が来たね。ここで見上げる月も、今夜で見納めかな。',
  '覚えてるよ。あなた、最初の週は行き先を決めるのに一時間もかかったもの。',
  '学院祭の夜は、ここからでも広場の灯りが見えたね。',
  'うん。星の巡りが一回りしたら、きっとまた会えるよ。'
];
const TERRACE_STAGE_LINE = '舞台: 月の文字盤の露台';

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

// Deterministic routing LM stub: the guide's partner selection picks the 案内人 (lina); the destination judgment never
// decides; every other free reply takes the next of REPLIES so the shots show distinct words.
let replyIndex = 0;
function routingTurnLmResponder({ prompt, requestIndex }) {
  if (prompt.includes('好感度の変化量を判定する')) return '0';
  if (prompt.includes('MP温存ライン')) return '30';
  if (prompt.includes('所持金判定')) return '0';
  if (prompt.includes('場所移動の合意')) return 'false';
  if (prompt.includes('location_idを1つだけ返す')) return 'none';
  if (prompt.includes('締めくくりを誰と過ごすと選んだか')) return 'lina';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'none';
  // Every reply before the choice (the hub greetings) is the opening line; the graduation words come after it.
  if (requestIndex === 0 || !prompt.includes(SELECT_INPUT)) return OPENING_TEXT;
  if (!prompt.includes(EXCHANGE_INPUTS[0])) return SELECT_REPLY;
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

// The stage fields of every post-processing request from index `since` on (the JSON the finalization prompts carry).
function recordStagesSince(requests, since) {
  return requests.slice(since).map((entry, offset) => ({
    request: since + offset,
    lines: entry.allText.split('\n').map((line) => line.trim()).filter((line) => /^"(source_type|location_name|visible_situation|location_id)":/.test(line))
  })).filter((entry) => entry.lines.length > 0);
}

const countSince = (requests, since, needle) => requests.slice(since).filter((entry) => entry.allText.includes(needle)).length;

async function routingFixture() {
  const root = await fixtureRoot('routing-hub-graduation-persona-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-graduation-persona-render-settings-'));
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

async function readActiveSlotConversation(root, conversationId) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  const slotId = active.active_slot_id ?? active.slot_id ?? active.active_slot ?? null;
  const file = path.join(resolveSlotProjectRoot(root, slotId), `game_data/logs/conversations/${conversationId}.json`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
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

// A hidden window paints on demand and can hand back the last composited frame: sync two animation frames, invalidate,
// and throw one capture away so the kept capture is the current frame.
async function shoot(win, name) {
  await js(win, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  win.webContents.invalidate();
  await sleep(150);
  await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, name);
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
  console.log(`screenshot: ${file}`);
}

// Record every box loader that shows (the loading screen up with no conversation passage) by its title, in order, and
// whether a passage showed.
async function watchBoxLoaders(win) {
  await js(win, `(() => {
    window.__boxLoadersSeen = [];
    window.__passageSeen = false;
    window.__loadingSeen = false;
    setInterval(() => {
      const loading = document.querySelector('#academy-loading-screen');
      if (!loading?.classList.contains('active')) return;
      window.__loadingSeen = true;
      if (loading.dataset.conversationPassage) { window.__passageSeen = true; return; }
      const title = (document.querySelector('#academy-loading-title')?.textContent || '').trim();
      if (window.__boxLoadersSeen.at(-1) !== title) window.__boxLoadersSeen.push(title);
    }, 20);
    return true;
  })()`);
}

const takeLoaderRecord = (win) => js(win, `(() => {
  const record = { boxes: window.__boxLoadersSeen ?? [], passage: window.__passageSeen === true, loading: window.__loadingSeen === true };
  window.__boxLoadersSeen = [];
  window.__passageSeen = false;
  window.__loadingSeen = false;
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

// Fire a hub turn with the given input, retrying until the real send actually starts (the input is cleared
// synchronously on a fired send; a still-populated input is an in-flight silent no-op).
async function sendHubTurn(win, input) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
    const fired = await js(win, `(() => {
      const el = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!el || !send || send.disabled) return false;
      el.value = ${JSON.stringify(input)};
      send.click();
      return true;
    })()`);
    if (fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 })) return true;
    await sleep(400);
  }
  return false;
}

// A hub turn has settled: its words are on the terrace and the send is open again.
const hubTurnSettled = (win, text) => waitFor(win, `
  document.querySelector('#routing-hub-screen')?.classList.contains('active')
  && (document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(text)})
  && !document.querySelector('#routing-hub-send')?.disabled
`, { tries: 600, intervalMs: 50 });

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

// What the terrace shows (the left rail of marks, the week, the 案内人's standee and name) and the runtime state.
const readTerrace = (win) => js(win, `(async () => {
  const state = await fetch('/api/state').then((r) => r.json());
  const standee = document.querySelector('#routing-hub-standee');
  const speakers = [...document.querySelectorAll('#routing-hub-message-stream .message-speaker')].map((el) => el.textContent.trim());
  return {
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
    weekText: (document.querySelector('#routing-hub-week')?.textContent || '').trim(),
    railMarks: document.querySelectorAll('#routing-hub-screen .routing-hub-category-button').length,
    standeeSrc: standee?.getAttribute('src') ?? null,
    lastSpeaker: speakers.at(-1) ?? null,
    endLabel: document.querySelector('#routing-hub-end')?.getAttribute('aria-label') ?? null,
    bubbles: document.querySelectorAll('#routing-hub-message-stream .message').length,
    elapsedWeeks: Number(state?.elapsed_weeks),
    lastConversationId: state?.last_conversation_id ?? null,
    currentLocationId: state?.current_location_id ?? null,
    currentScreen: state?.current_screen ?? null,
    endingCharacterId: state?.ending_character_id ?? null,
    pendingEventFlag: state?.pending_interaction_context?.event_flag_id ?? null,
    guideActive: state?.routing_graduation_guide != null,
    streamTail: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().slice(-120)
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
  // A new game draws the 案内人 at random: set her to one variant before the guide's hub start.
  const personaStatus = await js(win, `fetch('/api/slots/active/routing-persona', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routing_persona_variant: ${JSON.stringify(PERSONA_VARIANT)} }) }).then((r) => r.status)`);
  log('persona', { status: personaStatus, variant: PERSONA_VARIANT });

  // ── 1) GUIDE ENTRY at elapsed_weeks=49 ─────────────────────────────────────────────────────────────────────────
  log('seed_guide_week', await editActiveSlotState(root, (state) => { state.elapsed_weeks = 49; }));
  const guideOnHub = await loadSlotIntoHub(win, base);
  await sleep(800);
  const guide = await readTerrace(win);
  log('guide_entry', { guideOnHub, ...guide });
  check('GUIDE ENTRY: the hub at the displayed graduation week holds the guide (elapsed_weeks 49) and reads 第50週 / 50',
    Boolean(guideOnHub && guide.activeScreenId === 'routing-hub-screen' && guide.elapsedWeeks === 49 && guide.guideActive && guide.weekText === '第50週 / 50'), guide);

  // ── 2) SELECTION: the 案内人 herself ──────────────────────────────────────────────────────────────────────────
  await watchBoxLoaders(win);
  const requestsBeforeSelection = lm.requests.length;
  const sentAt = Date.now();
  const selectSent = await sendHubTurn(win, SELECT_INPUT);
  const selectionSettled = selectSent && await hubTurnSettled(win, SELECT_REPLY);
  const selectionMs = Date.now() - sentAt;
  await sleep(1200);
  await shoot(win, 'guide-01-selected.png');
  const selected = await readTerrace(win);
  const selectionLoaders = await takeLoaderRecord(win);
  const selectionRequests = lm.requests.length - requestsBeforeSelection;
  log('selected', { selectSent, selectionSettled, selectionMs, selectionRequests, loaders: selectionLoaders, ...selected });
  check('SELECTION: the screen stays on the terrace — no loading screen at all (no box, no passage)',
    Boolean(selectionSettled && selected.activeScreenId === 'routing-hub-screen' && !selectionLoaders.loading && selectionLoaders.boxes.length === 0 && !selectionLoaders.passage), { loaders: selectionLoaders, activeScreenId: selected.activeScreenId });
  check('SELECTION: the conversation id is the one before the choice, the graduation started (lina, graduation pending, guide cleared)',
    Boolean(selected.lastConversationId === guide.lastConversationId && selected.endingCharacterId === 'lina'
      && selected.pendingEventFlag === 'event.graduation_ending.ready' && !selected.guideActive), { before: guide.lastConversationId, after: selected.lastConversationId, endingCharacterId: selected.endingCharacterId });
  check('SELECTION: the terrace keeps its look — the same rail of marks, 第50週 / 50, the 案内人 standee, 今日はここまで',
    Boolean(selected.railMarks === guide.railMarks && selected.railMarks > 0 && selected.weekText === '第50週 / 50' && selected.standeeSrc === guide.standeeSrc
      && selected.endLabel === '今日はここまで'), { railMarks: [guide.railMarks, selected.railMarks], weekText: selected.weekText, standee: selected.standeeSrc, endLabel: selected.endLabel });
  check('SELECTION: nothing was drained and no opening was generated after the choice (the selection turn\'s own requests only)',
    countSince(lm.requests, requestsBeforeSelection, '次の会話セッションだけを根拠に') === 0, { selectionRequests });
  check('WEEK / PLACE: elapsed_weeks stays 49 and the place does not move on the choice',
    selected.elapsedWeeks === 49 && selected.currentLocationId === guide.currentLocationId, { elapsedWeeks: selected.elapsedWeeks, location: [guide.currentLocationId, selected.currentLocationId] });
  const recordAfterSelection = await readActiveSlotConversation(root, selected.lastConversationId);
  log('record_after_selection', {
    id: recordAfterSelection.id,
    source_type: recordAfterSelection.source_type,
    location_name: recordAfterSelection.location_name,
    visible_situation: recordAfterSelection.visible_situation,
    event_flag_id: recordAfterSelection.event_flag_id,
    has_routing_hub: Object.hasOwn(recordAfterSelection, 'routing_hub'),
    messages: recordAfterSelection.messages.length
  });

  // ── 3) FIRST WORDS / EXCHANGES on the terrace ─────────────────────────────────────────────────────────────────
  const requestsBeforeExchanges = lm.requests.length;
  const exchanges = [];
  for (const [index, input] of EXCHANGE_INPUTS.entries()) {
    const sent = await sendHubTurn(win, input);
    const replied = sent && await hubTurnSettled(win, REPLIES[index]);
    exchanges.push({ input, sent, replied });
    if (index === 0) {
      await sleep(1200);
      await shoot(win, 'guide-02-first-words.png');
      log('first_words', await readTerrace(win));
    }
  }
  await sleep(1200);
  await shoot(win, 'guide-03-three-exchanges.png');
  const afterExchanges = await readTerrace(win);
  const exchangeScenes = sceneLinesSince(lm.requests, requestsBeforeExchanges);
  const exchangeLoaders = await takeLoaderRecord(win);
  log('exchanges', { exchanges, loaders: exchangeLoaders, ...afterExchanges });
  log('scene_lines_since_selection', sceneLinesSince(lm.requests, requestsBeforeSelection));
  const personaScenes = exchangeScenes.filter((entry) => entry.lines.includes(`あなたは${PERSONA_DISPLAY_NAME}である。`));
  check('EXCHANGES: three exchanges go on on the terrace in the same conversation, the 案内人 speaking, week 第50週 / 50',
    exchanges.every((e) => e.sent && e.replied) && afterExchanges.activeScreenId === 'routing-hub-screen' && afterExchanges.lastConversationId === guide.lastConversationId
      && afterExchanges.lastSpeaker === PERSONA_DISPLAY_NAME && afterExchanges.weekText === '第50週 / 50' && !exchangeLoaders.loading, { exchanges, lastSpeaker: afterExchanges.lastSpeaker, weekText: afterExchanges.weekText });
  check('SCENE: every request speaking as the 案内人 after the choice carries 舞台: 月の文字盤の露台, and none carries 正門',
    personaScenes.length > 0 && personaScenes.every((entry) => entry.lines.includes(TERRACE_STAGE_LINE))
      && exchangeScenes.every((entry) => !entry.lines.some((line) => line.includes('正門'))), { personaRequests: personaScenes.length });
  check('PLACE: no stage-move judgment runs during the graduation conversation and the place does not move',
    countSince(lm.requests, requestsBeforeExchanges, '場所移動の合意') === 0 && afterExchanges.currentLocationId === guide.currentLocationId, { location: afterExchanges.currentLocationId });

  // ── 4) END → TITLE ───────────────────────────────────────────────────────────────────────────────────────────
  await watchBoxLoaders(win);
  const requestsBeforeEnd = lm.requests.length;
  let endClicked = false;
  for (let attempt = 0; attempt < 20 && !endClicked; attempt += 1) {
    endClicked = await js(win, `(() => { const end = document.querySelector('#routing-hub-end'); if (!end || end.disabled) return false; end.click(); return true; })()`);
    if (!endClicked) await sleep(400);
  }
  // The box, while it is up (the end request keeps it up).
  const boxUp = endClicked && await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active') && (document.querySelector('#academy-loading-title')?.textContent || '').includes('卒業しました')`, { tries: 400, intervalMs: 20 });
  let boxLook = null;
  if (boxUp) {
    await sleep(400);
    await shoot(win, 'guide-04a-graduated-box.png');
    boxLook = await js(win, END_BOX_LOOK);
  }
  log('end_box', { boxUp, ...boxLook });
  check('END BOX: 卒業しました。 appears once — the product box alone with no line under it, the night-journey layer down',
    Boolean(boxUp && endBoxSingle(boxLook)), boxLook);
  const endedToTitle = endClicked && await waitFor(win, `
    document.querySelector('#title-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 100 });
  const endLoaders = await takeLoaderRecord(win);
  await sleep(1200);
  await shoot(win, 'guide-04-title.png');
  const titleState = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    const slots = await fetch('/api/slots').then((r) => r.json());
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      playMode: document.body.classList.contains('play-mode'),
      endingCompleted: state?.ending_completed === true,
      currentScreen: state?.current_screen ?? null,
      journeyScene: document.querySelector('#journey')?.dataset.scene ?? null,
      slots: (slots?.slots ?? []).map((slot) => ({ id: slot.slot_id ?? slot.id ?? null, graduated: slot.graduated ?? slot.ending_completed ?? null, loadable: slot.loadable ?? null }))
    };
  })()`);
  const recordStages = recordStagesSince(lm.requests, requestsBeforeEnd);
  log('end_to_title', { endClicked, boxUp, endedToTitle, loaders: endLoaders, ...titleState });
  log('record_stages_since_end', recordStages.slice(0, 3));
  check('END → TITLE: 今日はここまで ends the conversation as the graduation — 卒業しました。 and #title-screen, graduated',
    Boolean(endedToTitle && titleState.activeScreenId === 'title-screen' && titleState.endingCompleted && endLoaders.boxes.includes('卒業しました。') && !titleState.playMode), { loaders: endLoaders, ...titleState });
  check('RECORD: the post-processing requests carry the terrace 舞台 (guide_graduation / 月の文字盤の露台), never 正門',
    recordStages.length > 0 && recordStages.every((entry) => entry.lines.includes('"location_name": "月の文字盤の露台",') && entry.lines.includes('"source_type": "guide_graduation",'))
      && recordStages.every((entry) => !entry.lines.some((line) => line.includes('front_gate'))), { requests: recordStages.length });

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
