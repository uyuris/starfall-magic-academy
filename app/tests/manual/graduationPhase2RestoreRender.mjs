// Render-backed graduation phase-2 restore check (Electron / real Blink layout + real client flow).
//
// A mid-phase-2 卒業 conversation (締めくくり相手 = 案内人 lina or a candidate character_###) is re-entered live from a
// slot LOAD / RESUME, instead of dropping the player to the routing hub start / academy-room (which restarts the
// graduation flow). This drives the REAL client through:
//   案内人: drive guide → choose the 案内人 → the conversation goes on on the terrace → RELOAD the page (fresh frontend)
//   → LOAD the slot → assert the terrace comes back with the same conversation and its history, under the hub-entry
//   loading copy and never the graduation-ending-start box → continue a turn → RESUME re-entry → a turn the 案内人 cuts
//   off auto-ends the conversation as the graduation → 卒業しました。 → title. A slot saved mid-graduation in the
//   earlier form (a separate front-gate event conversation, saved on the legacy screen at elapsed_weeks 50) re-enters
//   the terrace too, and its next turn takes the terrace 舞台.
//   候補: drive guide → choose a candidate → phase-2 卒業会話 → RELOAD → LOAD → the conversation resumes in place.
// It also seeds legacy-screen and opening-未実行 variants from the driven candidate slot's runtime_state, and a loop
// mid-phase-2 slot to assert it lands in the conversation (not academy-room). A routing candidate (an academy person)
// re-enters like any event conversation — the passage onto the daytime screen marked event, with no box — whichever
// screen it was saved under (legacy included); the loop graduation keeps the unmarked daytime / saved-screen landing
// under the graduation-ending-start box. Every box loader that shows is recorded by its title.
//
// `node --test` cannot run app.js (no fetch/DOM/SSE pump), so this runs against the REAL client in Electron.
// Not named *.test.mjs and under app/tests/manual/, so `npm test` skips it; run by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/graduationPhase2RestoreRender.mjs
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = 1200;
const WIN_H = 820;
const SELECT_INPUT_GUIDE = 'あなた自身と、この学院生活の最後を過ごしたい';
const SELECT_INPUT_CANDIDATE = 'セラと、この学院生活の最後を過ごしたい';
const SELECT_REPLY = 'ふふ、うれしい。では最後の時間を、わたしと一緒に過ごしましょうね。';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const GRADUATION_OPENING_TEXT = 'とうとうこの日が来たね。一緒に歩いたこの一年を、少し振り返ろうか。';
const CONTINUE_INPUT = 'この一年で一番心に残ったことを話したい';
const CONTINUE_REPLY = 'そうだね、あの日のことは今でも覚えているよ。';
const AFTER_LOAD_INPUT = '続きを聞かせて';
const AFTER_LOAD_REPLY = '星の巡りを数えた夜のこと、話そうか。';
// The 案内人 cuts the conversation off on this input (the continuation judgment answers false), so it auto-ends.
const CUTOFF_INPUT = 'そろそろ行かなくちゃ';
const CUTOFF_REPLY = 'うん、いってらっしゃい。ずっとここで見ているからね。';
const TERRACE_STAGE_LINE = '舞台: 月の文字盤の露台';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
const { resolvePlayRoot, resolveSlotProjectRoot, readSlotMeta, writeSlotMeta } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));
const { routingPersonaDisplayName } = await import(path.join(PROJECT_ROOT, 'app/src/routingPersona.mjs'));

// Deterministic routing LM stub. The graduation guide selection judgment answers `lina` when the player asks
// for the 案内人自身, otherwise `character_001` (セラ) — so one stub drives both the guide and candidate phase-2
// scenarios. Continuation judgments return true unless a turn should auto-end.
function routingTurnLmResponder({ prompt, requestIndex }) {
  if (prompt.includes('好感度の変化量を判定する')) return '0';
  if (prompt.includes('MP温存ライン')) return '30';
  if (prompt.includes('所持金判定')) return '0';
  if (prompt.includes('場所移動の合意')) return 'false';
  if (prompt.includes('location_idを1つだけ返す')) return 'none';
  if (prompt.includes('締めくくりを誰と過ごすと選んだか')) return prompt.includes(SELECT_INPUT_CANDIDATE) ? 'character_001' : 'lina';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'none';
  if (prompt.includes(CUTOFF_INPUT)) return CUTOFF_REPLY;
  if (prompt.includes(AFTER_LOAD_INPUT)) return AFTER_LOAD_REPLY;
  if (prompt.includes(CONTINUE_INPUT)) return CONTINUE_REPLY;
  if (requestIndex === 0) return OPENING_TEXT;
  if (prompt.includes(SELECT_INPUT_GUIDE) || prompt.includes(SELECT_INPUT_CANDIDATE)) return SELECT_REPLY;
  return GRADUATION_OPENING_TEXT;
}

// The persona / 舞台 lines of every LM request from index `since` on that carries any of them.
function sceneLinesSince(requests, since) {
  return requests.slice(since).map((entry, offset) => ({
    request: since + offset,
    lines: entry.allText.split('\n').map((line) => line.trim()).filter((line) => /^(あなたは.+である。|舞台:)/.test(line))
  })).filter((entry) => entry.lines.length > 0);
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
    // The cutoff input is the last turn the 案内人 scenario sends: the 案内人 does not go on after it.
    else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) content = prompt.includes(CUTOFF_INPUT) ? 'false' : 'true';
    else content = routingTurnLmResponder({ prompt, requestIndex: requests.length - 1 });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// A new game always starts in routing with a randomly drawn persona variant (the play-mode sidecar is not
// consulted), so no sidecar is written; the slot's own meta.json carries the mode and variant.
async function makeFixture(slug) {
  const root = await fixtureRoot(`${slug}-`);
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), `${slug}-settings-`));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  return { root, settingsDir, settingsPath };
}

async function startGameServer({ root, settingsPath, lm }) {
  const server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function activeSlotStatePath(root, slotId) {
  return path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json');
}

async function readActiveSlotId(root) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  return active.active_slot_id ?? active.slot_id ?? active.active_slot ?? null;
}

async function seedActiveSlotElapsedWeeks(root, weeks) {
  const slotId = await readActiveSlotId(root);
  if (!slotId) throw new Error('no active slot to seed');
  const statePath = activeSlotStatePath(root, slotId);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.elapsed_weeks = weeks;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { slotId };
}

async function mutateActiveSlotState(root, mutate) {
  const slotId = await readActiveSlotId(root);
  const statePath = activeSlotStatePath(root, slotId);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  mutate(state);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { slotId, state };
}

// The routing persona identity the active slot was drawn with at new game (meta.json routing_persona_variant).
async function readActiveSlotPersona(root) {
  const slotId = await readActiveSlotId(root);
  const variant = (await readSlotMeta(root, slotId))?.routing_persona_variant;
  return { variant, displayName: routingPersonaDisplayName(variant), visualSet: `routing_lumi_${variant}` };
}

async function readActiveSlotState(root) {
  const slotId = await readActiveSlotId(root);
  return JSON.parse(await fs.readFile(activeSlotStatePath(root, slotId), 'utf8'));
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let win;
let exitCode = 0;
const cleanups = [];

async function waitFor(predicate, { tries = 300, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}
const js = (expr) => win.webContents.executeJavaScript(expr);

// Record every box loader that shows (the loading screen up with no conversation passage) by its title, in order.
// The record lives on the page, so it is installed after each page load and read before the next.
async function watchBoxLoaders() {
  await js(`(() => {
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
const takeLoaderRecord = () => js(`(() => {
  const record = { boxes: window.__boxLoadersSeen ?? [], passage: window.__passageSeen === true };
  window.__boxLoadersSeen = [];
  window.__passageSeen = false;
  return record;
})()`);

async function newGameRouting(base) {
  await win.loadURL(`${base}/`);
  await sleep(1200);
  await js(`document.querySelector('#start-new-game').click(); true`);
  return waitFor(`
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `);
}

async function sendHubTurn(input) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
    const fired = await js(`(() => {
      const el = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!el || !send || send.disabled) return false;
      el.value = ${JSON.stringify(input)};
      send.click();
      return true;
    })()`);
    if (fired && await waitFor(`document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 })) return true;
    await sleep(400);
  }
  return false;
}

// Drive: hub → seed week 49 → reload + LOAD (hub start at the graduation week creates the guide) → select a
// candidate → phase-2 卒業会話 on the daytime screen.
async function driveToPhase2Day(root, base, selectInput) {
  if (!await newGameRouting(base)) throw new Error('did not reach the routing hub');
  await seedActiveSlotElapsedWeeks(root, 49);
  await reloadToTitle(base);
  if (!await loadFirstSlotFromTitle()) throw new Error('slot load button was not clickable');
  if (!await waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled && !document.querySelector('#academy-loading-screen')?.classList.contains('active') && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0`, { tries: 300, intervalMs: 120 })) throw new Error('guide start did not settle on the hub');
  if (!(await readActiveSlotState(root)).routing_graduation_guide) throw new Error('hub start at week 49 did not create the graduation guide');
  await sleep(400);
  if (!await sendHubTurn(selectInput)) throw new Error('selection turn did not send');
  const landed = await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 150 });
  await sleep(600);
  if (!landed) throw new Error('did not land on the phase-2 daytime conversation');
}

function readDayLanding() {
  return js(`(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    const speaker = document.querySelector('#conversation-day-message-stream .message-speaker');
    const face = document.querySelector('#conversation-day-message-stream .message-face img');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
      streamText: (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim(),
      endingCharacterId: state?.ending_character_id ?? null,
      pendingEventFlag: state?.pending_interaction_context?.event_flag_id ?? null,
      speakerName: speaker ? speaker.textContent.trim() : null,
      faceSrc: face ? face.getAttribute('src') : null,
      conversationKind: document.querySelector('#conversation-day-screen')?.dataset.conversationKind ?? null,
      weekText: (document.querySelector('#conversation-day-week')?.textContent || '').trim(),
      elapsedWeeks: Number(state?.elapsed_weeks)
    };
  })()`);
}

async function reloadToTitle(base) {
  await win.loadURL(`${base}/`);
  await waitFor(`document.querySelector('#title-screen')?.classList.contains('active')`, { tries: 200, intervalMs: 100 });
  await sleep(400);
  await watchBoxLoaders();
}

// From the title, open the load screen and click the (single) slot's load button.
async function loadFirstSlotFromTitle() {
  await js(`document.querySelector('#open-load-screen').click(); true`);
  await waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && document.querySelector('.slot-load-item .academy-map-action-button.primary')`, { tries: 200, intervalMs: 100 });
  await sleep(200);
  return js(`(() => { const b = document.querySelector('.slot-load-item .academy-map-action-button.primary'); if (!b || b.disabled) return false; b.click(); return true; })()`);
}

// Drive: hub → seed week 49 → reload + LOAD (hub start at the graduation week creates the guide) → choose the 案内人 →
// the selection reply settles on the terrace (the conversation goes on there as the graduation conversation).
async function driveToGuideGraduationOnTerrace(root, base) {
  if (!await newGameRouting(base)) throw new Error('did not reach the routing hub');
  await seedActiveSlotElapsedWeeks(root, 49);
  await reloadToTitle(base);
  if (!await loadFirstSlotFromTitle()) throw new Error('slot load button was not clickable');
  if (!await waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled && !document.querySelector('#academy-loading-screen')?.classList.contains('active') && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0`, { tries: 300, intervalMs: 120 })) throw new Error('guide start did not settle on the hub');
  if (!(await readActiveSlotState(root)).routing_graduation_guide) throw new Error('hub start at week 49 did not create the graduation guide');
  await sleep(400);
  if (!await sendHubTurn(SELECT_INPUT_GUIDE)) throw new Error('selection turn did not send');
  if (!await terraceShows(SELECT_REPLY)) throw new Error('the selection reply did not settle on the terrace');
}

// The terrace is up and settled with the given words in its stream.
const terraceShows = (text) => waitFor(`
  document.querySelector('#routing-hub-screen')?.classList.contains('active')
  && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  && (document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(text)})
  && !document.querySelector('#routing-hub-send')?.disabled
`, { tries: 600, intervalMs: 100 });

function readTerraceLanding() {
  return js(`(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    const speakers = [...document.querySelectorAll('#routing-hub-message-stream .message-speaker')].map((el) => el.textContent.trim());
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      streamText: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim(),
      weekText: (document.querySelector('#routing-hub-week')?.textContent || '').trim(),
      railMarks: document.querySelectorAll('#routing-hub-screen .routing-hub-category-button').length,
      standeeSrc: document.querySelector('#routing-hub-standee')?.getAttribute('src') ?? null,
      lastSpeaker: speakers.at(-1) ?? null,
      lastConversationId: state?.last_conversation_id ?? null,
      endingCharacterId: state?.ending_character_id ?? null,
      pendingEventFlag: state?.pending_interaction_context?.event_flag_id ?? null,
      elapsedWeeks: Number(state?.elapsed_weeks)
    };
  })()`);
}

async function scenarioGuideLoad(lm) {
  const fx = await makeFixture('grad-phase2-restore-guide');
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath, lm });
  cleanups.push(() => server.close());
  log('scenario', { name: 'guide-load', base });

  await driveToGuideGraduationOnTerrace(fx.root, base);
  const persona = await readActiveSlotPersona(fx.root);
  log('guide_persona', persona);
  const continued = await sendHubTurn(CONTINUE_INPUT) && await terraceShows(CONTINUE_REPLY);
  const before = await readTerraceLanding();
  check('DRIVE (案内人): the graduation goes on on the terrace with the persona (pre-reload)',
    Boolean(continued && before.activeScreenId === 'routing-hub-screen' && before.endingCharacterId === 'lina' && before.lastSpeaker === persona.displayName
      && typeof before.standeeSrc === 'string' && before.standeeSrc.includes(persona.visualSet)), before);

  // ── RELOAD (fresh frontend) → explicit LOAD → the terrace comes back ──
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const reentered = loaded && await terraceShows(CONTINUE_REPLY);
  await sleep(500);
  const after = await readTerraceLanding();
  const guideLoaders = await takeLoaderRecord();
  log('guide_reentry', { loaded, reentered, loaders: guideLoaders, ...after, streamText: after.streamText.slice(-120) });
  check('LOAD (案内人): the re-entry lands on the terrace under the hub-entry loading copy — never the graduation-ending-start box, no passage',
    Boolean(reentered && after.activeScreenId === 'routing-hub-screen' && !guideLoaders.boxes.includes('卒業のときを迎えました') && !guideLoaders.passage), { loaders: guideLoaders });
  check('LOAD (案内人): the same conversation goes on with its history (the selection reply and the turn after it), week 第50週 / 50',
    Boolean(after.lastConversationId === before.lastConversationId && after.streamText.includes(SELECT_REPLY) && after.streamText.includes(CONTINUE_REPLY)
      && after.weekText === '第50週 / 50' && after.elapsedWeeks === 49), { before: before.lastConversationId, after: after.lastConversationId, weekText: after.weekText });
  check('LOAD (案内人): the terrace keeps its look — the rail of marks and the 案内人 standee and name',
    Boolean(after.railMarks === before.railMarks && after.railMarks > 0 && after.standeeSrc === before.standeeSrc && after.lastSpeaker === persona.displayName), { railMarks: after.railMarks, standee: after.standeeSrc, lastSpeaker: after.lastSpeaker });

  // ── Continue a turn on the restored terrace ──
  const requestsBeforeTurn = lm.requests.length;
  const turnRendered = await sendHubTurn(AFTER_LOAD_INPUT) && await terraceShows(AFTER_LOAD_REPLY);
  const turnScenes = sceneLinesSince(lm.requests, requestsBeforeTurn).filter((entry) => entry.lines.includes(`あなたは${persona.displayName}である。`));
  check('CONTINUE (案内人): the restored conversation takes a new turn, spoken on the terrace 舞台',
    Boolean(turnRendered && turnScenes.length > 0 && turnScenes.every((entry) => entry.lines.includes(TERRACE_STAGE_LINE))), { turnRendered, scenes: turnScenes.slice(0, 1) });

  // ── RESUME button (no hub start): open the load screen through the in-play slot-load tab, then 「プレイに戻る」 ──
  await js(`document.querySelector('[data-screen="slot-load"]').click(); true`);
  await waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && !document.querySelector('#slot-load-resume-play')?.disabled`, { tries: 200, intervalMs: 100 });
  const resumeClicked = await js(`(() => { const b = document.querySelector('#slot-load-resume-play'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const resumed = resumeClicked && await terraceShows(AFTER_LOAD_REPLY);
  const resumeLanding = await readTerraceLanding();
  const resumeLoaders = await takeLoaderRecord();
  log('guide_resume', { resumeClicked, resumed, loaders: resumeLoaders, activeScreenId: resumeLanding.activeScreenId, lastConversationId: resumeLanding.lastConversationId });
  check('RESUME (案内人): 「プレイに戻る」 re-enters the terrace with the same conversation and no graduation-ending-start box',
    Boolean(resumed && resumeLanding.lastConversationId === before.lastConversationId && !resumeLoaders.boxes.includes('卒業のときを迎えました')), { resumed, loaders: resumeLoaders });

  // ── AUTO-END: the 案内人 cuts the conversation off → 卒業しました。 → title ──
  await watchBoxLoaders();
  const cutoffSent = await sendHubTurn(CUTOFF_INPUT);
  const toTitle = cutoffSent && await waitFor(`document.querySelector('#title-screen')?.classList.contains('active') && !document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 600, intervalMs: 150 });
  const endLoaders = await takeLoaderRecord();
  const titleState = await js(`(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    return { activeScreenId: document.querySelector('.screen.active')?.id ?? null, playMode: document.body.classList.contains('play-mode'), endingCompleted: state?.ending_completed === true };
  })()`);
  log('guide_auto_end', { cutoffSent, toTitle, loaders: endLoaders, ...titleState });
  check('AUTO-END → TITLE (案内人): the 案内人 cutting the conversation off ends it as the graduation — 卒業しました。 and #title-screen',
    Boolean(toTitle && titleState.activeScreenId === 'title-screen' && titleState.playMode === false && titleState.endingCompleted && endLoaders.boxes.includes('卒業しました。')), { loaders: endLoaders, ...titleState });

  // ── A graduated slot cannot be loaded ──
  await js(`document.querySelector('#open-load-screen').click(); true`);
  await waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && document.querySelector('.slot-load-item')`, { tries: 200, intervalMs: 100 });
  await sleep(300);
  const slotCard = await js(`(() => { const b = document.querySelector('.slot-load-item .academy-map-action-button.primary'); return { hasLoadButton: !!b, disabled: b ? b.disabled : null, text: (document.querySelector('.slot-load-item')?.textContent || '').trim().slice(0, 120) }; })()`);
  log('graduated_slot', slotCard);
  check('GRADUATED (案内人): the graduated slot cannot be loaded', slotCard.hasLoadButton === false || slotCard.disabled === true, slotCard);
}

// A slot saved mid-graduation in the earlier 案内人 form: a separate front-gate event conversation (no routing_hub),
// elapsed_weeks advanced to 50, saved on the legacy conversation screen. It re-enters the terrace, and its next turn
// takes the terrace 舞台 (the conversation record then carries it).
async function scenarioGuideOldSave(lm) {
  const fx = await makeFixture('grad-phase2-restore-guide-old');
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath, lm });
  cleanups.push(() => server.close());
  log('scenario', { name: 'guide-old-save', base });

  if (!await newGameRouting(base)) throw new Error('did not reach the routing hub');
  await sleep(400);
  const slotId = await readActiveSlotId(fx.root);
  const hubState = await readActiveSlotState(fx.root);
  const conversationFile = path.join(resolveSlotProjectRoot(fx.root, slotId), `game_data/logs/conversations/${hubState.last_conversation_id}.json`);
  const { routing_hub: _routingHub, ...hubRecord } = JSON.parse(await fs.readFile(conversationFile, 'utf8'));
  await fs.writeFile(conversationFile, `${JSON.stringify({
    ...hubRecord,
    source_type: 'event',
    event_flag_id: 'event.graduation_ending.ready',
    event_label: '卒業エンディング',
    location_id: 'front_gate_morning',
    time_slot: hubState.time_slot ?? 'after_school'
  }, null, 2)}\n`, 'utf8');
  await mutateActiveSlotState(fx.root, (state) => {
    state.current_screen = 'academy-conversation-session';
    state.current_interaction_character_id = 'lina';
    state.current_location_id = 'front_gate_morning';
    state.elapsed_weeks = 50;
    state.ending_started = true;
    state.ending_completed = false;
    state.ending_character_id = 'lina';
    state.global_flags = { ...(state.global_flags ?? {}), 'event.graduation_ending.ready': true, 'event.graduation_ending.completed': false };
    state.event_flag_sources = { ...(state.event_flag_sources ?? {}), 'event.graduation_ending.ready': { character_id: 'lina', source_type: 'graduation_ending', achieved_at: new Date().toISOString() } };
    state.pending_interaction_context = {
      source_type: 'event',
      event_flag_id: 'event.graduation_ending.ready',
      event_label: '卒業エンディング',
      source_conversation_id: null,
      opening_context: 'あなたは卒業を迎えた主人公とお別れの会話をする。'
    };
  });
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const reentered = loaded && await terraceShows(hubRecord.messages[0].content);
  const landing = await readTerraceLanding();
  const loaders = await takeLoaderRecord();
  const legacyShown = await js(`!!document.querySelector('#academy-conversation-session-screen')?.classList.contains('active')`);
  log('guide_old_save_reentry', { loaded, reentered, legacyShown, loaders, ...landing, streamText: landing.streamText.slice(-80) });
  check('LOAD (案内人・旧い形): a slot saved mid-graduation in the earlier form (legacy screen) re-enters the terrace — no box, never the legacy screen',
    Boolean(reentered && landing.activeScreenId === 'routing-hub-screen' && !legacyShown && !loaders.boxes.includes('卒業のときを迎えました')), { loaders, activeScreenId: landing.activeScreenId });
  const requestsBeforeTurn = lm.requests.length;
  const turnRendered = await sendHubTurn(AFTER_LOAD_INPUT) && await terraceShows(AFTER_LOAD_REPLY);
  const turnScenes = sceneLinesSince(lm.requests, requestsBeforeTurn).filter((entry) => entry.lines.some((line) => line.startsWith('あなたは')));
  const record = JSON.parse(await fs.readFile(conversationFile, 'utf8'));
  log('guide_old_save_turn', { turnRendered, scenes: turnScenes.slice(0, 1), record: { source_type: record.source_type, location_name: record.location_name, location_id: record.location_id ?? null } });
  check('CONTINUE (案内人・旧い形): its next turn is spoken on the terrace 舞台 (never 正門) and the record takes the terrace 舞台',
    Boolean(turnRendered && turnScenes.length > 0 && turnScenes.every((entry) => entry.lines.includes(TERRACE_STAGE_LINE) && !entry.lines.some((line) => line.includes('正門')))
      && record.source_type === 'guide_graduation' && record.location_name === '月の文字盤の露台' && !Object.hasOwn(record, 'location_id')), { turnRendered, source_type: record.source_type });
}

async function scenarioCandidateAndVariants(lm) {
  const fx = await makeFixture('grad-phase2-restore-candidate');
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath, lm });
  cleanups.push(() => server.close());
  log('scenario', { name: 'candidate-and-variants', base });

  await driveToPhase2Day(fx.root, base, SELECT_INPUT_CANDIDATE);
  const before = await readDayLanding();
  check('DRIVE (候補): phase 2 started on the daytime screen marked event with the roster partner (character_001), week 第50週 / 50',
    before.activeScreenId === 'conversation-day-screen' && before.endingCharacterId === 'character_001' && before.conversationKind === 'event'
    && before.weekText === '第50週 / 50' && before.elapsedWeeks === 49, before);

  // Candidate LOAD → re-entry with history restored (no persona visual involved).
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const reentered = loaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(GRADUATION_OPENING_TEXT)})
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 150 });
  const after = await readDayLanding();
  const candidateLoaders = await takeLoaderRecord();
  const hubShown = await js(`!!document.querySelector('#routing-hub-screen')?.classList.contains('active')`);
  log('candidate_reentry', { loaded, reentered, hubShown, loaders: candidateLoaders, endingCharacterId: after.endingCharacterId, kind: after.conversationKind, weekText: after.weekText });
  check('LOAD (候補): a mid-phase-2 candidate slot re-enters the phase-2 conversation with restored history (never the hub)',
    Boolean(reentered && after.activeScreenId === 'conversation-day-screen' && !hubShown && after.endingCharacterId === 'character_001'), { reentered, hubShown });
  check('LOAD (候補): the re-entry opens through the passage onto the daytime screen marked event, with no box, week 第50週 / 50',
    after.conversationKind === 'event' && candidateLoaders.passage && candidateLoaders.boxes.length === 0 && after.weekText === '第50週 / 50', { kind: after.conversationKind, loaders: candidateLoaders, weekText: after.weekText });

  // Read the driven runtime state so the seeded variants keep a valid in-flight phase-2 shape.
  const driven = await readActiveSlotState(fx.root);
  log('driven_state', { current_screen: driven.current_screen, last_conversation_id: driven.last_conversation_id, ending_character_id: driven.ending_character_id });

  // ── Legacy variant: same slot re-saved with current_screen='academy-conversation-session' → still the event day ──
  await mutateActiveSlotState(fx.root, (state) => { state.current_screen = 'academy-conversation-session'; });
  await reloadToTitle(base);
  const legacyLoaded = await loadFirstSlotFromTitle();
  const onLegacyDay = legacyLoaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(GRADUATION_OPENING_TEXT)})
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 150 });
  const legacyLanding = await readDayLanding();
  const legacyLoaders = await takeLoaderRecord();
  const legacyScreenShown = await js(`!!document.querySelector('#academy-conversation-session-screen')?.classList.contains('active')`);
  log('legacy_reentry', { legacyLoaded, onLegacyDay, legacyScreenShown, loaders: legacyLoaders, activeScreenId: legacyLanding.activeScreenId, kind: legacyLanding.conversationKind, weekText: legacyLanding.weekText });
  check('LOAD (legacy screen, 候補): a candidate slot saved with current_screen=academy-conversation-session re-enters the daytime screen marked event through the passage, with no box and never the legacy screen',
    Boolean(onLegacyDay && legacyLanding.activeScreenId === 'conversation-day-screen' && !legacyScreenShown && legacyLanding.conversationKind === 'event'
      && legacyLoaders.passage && legacyLoaders.boxes.length === 0), { activeScreenId: legacyLanding.activeScreenId, kind: legacyLanding.conversationKind, loaders: legacyLoaders });

  // ── Opening-未実行 variant: clear last_conversation_id (+ restore daytime) → a fresh opening is generated ──
  await mutateActiveSlotState(fx.root, (state) => { state.current_screen = 'interaction'; state.last_conversation_id = null; });
  await reloadToTitle(base);
  const freshLoaded = await loadFirstSlotFromTitle();
  const freshOpening = freshLoaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(GRADUATION_OPENING_TEXT)})
  `, { tries: 600, intervalMs: 150 });
  const freshState = await js(`(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    return { activeScreenId: document.querySelector('.screen.active')?.id ?? null, lastConversationId: state?.last_conversation_id ?? null };
  })()`);
  log('opening_未実行_reentry', { freshLoaded, freshOpening, ...freshState });
  check('LOAD (opening 未実行): a mid-phase-2 slot with no opened conversation generates a fresh opening on re-entry',
    Boolean(freshOpening && freshState.activeScreenId === 'conversation-day-screen' && typeof freshState.lastConversationId === 'string' && freshState.lastConversationId.length > 0), freshState);
}

async function scenarioLoop(lm) {
  // A loop mid-phase-2 slot must land in the conversation, not academy-room. A new game always starts in routing
  // and loop graduation is week-50 gated, so rather than drive 50 weeks this re-marks the new-game slot as a loop
  // save (meta.json play_mode, which LOAD resolves the mode from), seeds it into an in-flight phase-2 (opening
  // 未実行) shape, and asserts the LOAD lands on the daytime conversation.
  const fx = await makeFixture('grad-phase2-restore-loop');
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath, lm });
  cleanups.push(() => server.close());
  log('scenario', { name: 'loop', base });

  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(`document.querySelector('#start-new-game').click(); true`);
  await waitFor(`document.body.classList.contains('play-mode')`, { tries: 300, intervalMs: 100 });
  await sleep(400);
  const seed = await mutateActiveSlotState(fx.root, (state) => {
    state.current_screen = 'interaction';
    state.current_interaction_character_id = 'character_001';
    state.last_conversation_id = null;
    state.ending_started = true;
    state.ending_completed = false;
    state.ending_character_id = 'character_001';
    state.elapsed_weeks = 50;
    state.pending_interaction_context = {
      event_flag_id: 'event.graduation_ending.ready',
      character_id: 'character_001',
      location_id: state.pending_interaction_context?.location_id ?? 'front_gate_morning',
      source_type: 'event'
    };
  });
  const { routing_persona_variant: _routingVariant, ...slotMeta } = await readSlotMeta(fx.root, seed.slotId);
  await writeSlotMeta(fx.root, seed.slotId, { ...slotMeta, play_mode: 'loop' });
  log('loop_seed', { slotId: seed.slotId, playMode: (await readSlotMeta(fx.root, seed.slotId)).play_mode });
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const onConversation = loaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 150 });
  const roomShown = await js(`!!document.querySelector('#academy-room-screen')?.classList.contains('active')`);
  const loopLoaders = await takeLoaderRecord();
  const loopKind = await js(`document.querySelector('#conversation-day-screen')?.dataset.conversationKind ?? null`);
  const loopState = await js(`(async () => {
    const slots = await fetch('/api/slots').then((r) => r.json());
    return { activeScreenId: document.querySelector('.screen.active')?.id ?? null, activePlayMode: slots?.active_play_mode?.mode ?? null };
  })()`);
  log('loop_reentry', { loaded, onConversation, roomShown, loaders: loopLoaders, kind: loopKind, ...loopState });
  check('LOAD (loop): the loop keeps its landing — the unmarked daytime screen under the graduation-ending-start box',
    loopKind === null && loopLoaders.boxes.includes('卒業のときを迎えました') && !loopLoaders.passage, { kind: loopKind, loaders: loopLoaders });
  check('LOAD (loop): a loop mid-phase-2 slot lands on the phase-2 conversation, not academy-room',
    Boolean(onConversation && loopState.activeScreenId === 'conversation-day-screen' && !roomShown && loopState.activePlayMode === 'loop'), loopState);
}

async function main() {
  const lm = await startStubLm();
  cleanups.push(() => lm.server.close());
  await app.whenReady();
  win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await scenarioGuideLoad(lm);
  await scenarioGuideOldSave(lm);
  await scenarioCandidateAndVariants(lm);
  await scenarioLoop(lm);

  console.log(`stub LM requests: ${lm.requests.length}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  for (const c of cleanups) {
    try {
      if (typeof c === 'function') c();
      else await fs.rm(c, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
  process.exit(exitCode);
});
