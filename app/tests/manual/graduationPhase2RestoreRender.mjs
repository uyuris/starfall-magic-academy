// Render-backed graduation phase-2 restore check (Electron / real Blink layout + real client flow).
//
// Task graduation-phase2-restore-frontend. A mid-phase-2 卒業 conversation (締めくくり相手 = 案内人 lina or a
// candidate character_###) is re-entered live from a slot LOAD / RESUME, instead of dropping the player to the
// routing hub / academy-room (which restarts the graduation flow). This drives the REAL client through:
//   drive guide → select partner → phase-2 卒業会話 (opening streamed) → RELOAD the page (fresh frontend, no
//   in-memory persona) → open the load screen → LOAD the slot → assert the phase-2 conversation resumes in
//   place with its history restored (案内人: face + speaker name = the routing persona variant art, never the
//   roster head) → continue a turn → RESUME re-entry (no hub start) → end → title.
// It also seeds legacy-screen and opening-未実行 variants from the driven slot's runtime_state to assert the
// saved-screen landing and the new-opening path, and a loop mid-phase-2 slot to assert it lands in the
// conversation (not academy-room).
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
const PERSONA_VARIANT = 'fallen_star';
const PERSONA_DISPLAY_NAME = 'ルミ';
const PERSONA_VISUAL_SET = 'routing_lumi_fallen_star';
const GUIDE_START_INPUT = '今週は鍛錬する';
const GUIDE_SENDOFF_TEXT = 'では、鍛錬へ向かいましょう。（あなたの背をそっと押す）新しい一週間をそこから始めます。';
const SELECT_INPUT_GUIDE = 'あなた自身と、この学院生活の最後を過ごしたい';
const SELECT_INPUT_CANDIDATE = 'セラと、この学院生活の最後を過ごしたい';
const SELECT_REPLY = 'ふふ、うれしい。では最後の時間を、わたしと一緒に過ごしましょうね。';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const GRADUATION_OPENING_TEXT = 'とうとうこの日が来たね。一緒に歩いたこの一年を、少し振り返ろうか。';
const CONTINUE_INPUT = 'この一年で一番心に残ったことを話したい';
const CONTINUE_REPLY = 'そうだね、あの日のことは今でも覚えているよ。';

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
const { resolvePlayRoot, resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

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
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
    return prompt.includes(GUIDE_START_INPUT) ? 'training' : 'none';
  }
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) return GUIDE_SENDOFF_TEXT;
  if (prompt.includes(CONTINUE_INPUT)) return CONTINUE_REPLY;
  if (requestIndex === 0) return OPENING_TEXT;
  if (prompt.includes(SELECT_INPUT_GUIDE) || prompt.includes(SELECT_INPUT_CANDIDATE)) return SELECT_REPLY;
  return GRADUATION_OPENING_TEXT;
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

async function makeFixture(slug, { mode }) {
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
  const settings = mode === 'routing' ? { mode: 'routing', routing_persona_variant: PERSONA_VARIANT } : { mode: 'loop' };
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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

// Drive: hub → seed week 49 → guide start (week 50) → select partner → phase-2 卒業会話 on the daytime screen.
async function driveToPhase2Day(root, base, selectInput) {
  if (!await newGameRouting(base)) throw new Error('did not reach the routing hub');
  await seedActiveSlotElapsedWeeks(root, 49);
  if (!await sendHubTurn(GUIDE_START_INPUT)) throw new Error('guide-start turn did not send');
  if (!await waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled && !document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 300, intervalMs: 120 })) throw new Error('guide start did not settle on the hub');
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
      faceSrc: face ? face.getAttribute('src') : null
    };
  })()`);
}

async function reloadToTitle(base) {
  await win.loadURL(`${base}/`);
  await waitFor(`document.querySelector('#title-screen')?.classList.contains('active')`, { tries: 200, intervalMs: 100 });
  await sleep(400);
}

// From the title, open the load screen and click the (single) slot's load button.
async function loadFirstSlotFromTitle() {
  await js(`document.querySelector('#open-load-screen').click(); true`);
  await waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && document.querySelector('.slot-load-item .academy-map-action-button.primary')`, { tries: 200, intervalMs: 100 });
  await sleep(200);
  return js(`(() => { const b = document.querySelector('.slot-load-item .academy-map-action-button.primary'); if (!b || b.disabled) return false; b.click(); return true; })()`);
}

async function scenarioGuideLoad(lm) {
  const fx = await makeFixture('grad-phase2-restore-guide', { mode: 'routing' });
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath, lm });
  cleanups.push(() => server.close());
  log('scenario', { name: 'guide-load', base });

  await driveToPhase2Day(fx.root, base, SELECT_INPUT_GUIDE);
  const before = await readDayLanding();
  check('DRIVE (案内人): phase 2 started on the daytime screen with the persona identity (pre-reload)',
    before.activeScreenId === 'conversation-day-screen' && before.endingCharacterId === 'lina'
    && before.speakerName === PERSONA_DISPLAY_NAME && typeof before.faceSrc === 'string' && before.faceSrc.includes(PERSONA_VISUAL_SET), before);
  const openingPresent = before.streamText.includes(GRADUATION_OPENING_TEXT);

  // ── RELOAD (fresh frontend, no in-memory persona) → explicit LOAD → live re-entry ──
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const reentered = loaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 150 });
  await sleep(500);
  const after = await readDayLanding();
  const hubShown = await js(`!!document.querySelector('#routing-hub-screen')?.classList.contains('active')`);
  log('guide_reentry', { loaded, reentered, openingPresent, hubShown, ...after });
  check('LOAD (案内人): a mid-phase-2 routing slot re-enters the phase-2 卒業会話 on #conversation-day-screen (never the hub / academy-room)',
    Boolean(reentered && after.activeScreenId === 'conversation-day-screen' && !after.loadingActive && !hubShown), { reentered, hubShown, activeScreenId: after.activeScreenId });
  check('LOAD (案内人): the restored conversation history is rendered (the phase-2 opening line is present after re-entry)',
    Boolean(openingPresent && after.streamText.includes(GRADUATION_OPENING_TEXT)), { streamLen: after.streamText.length });
  check('LOAD (案内人): identity restored — speaker name = ルミ and face = routing_lumi_<variant> (registered from the entry contract before refresh)',
    after.speakerName === PERSONA_DISPLAY_NAME && typeof after.faceSrc === 'string' && after.faceSrc.includes(PERSONA_VISUAL_SET), { speakerName: after.speakerName, faceSrc: after.faceSrc });

  // ── Continue a turn in the restored conversation ──
  const turnSent = await js(`(() => {
    const el = document.querySelector('#conversation-day-input');
    const send = document.querySelector('#conversation-day-send');
    if (!el || !send || send.disabled) return false;
    el.value = ${JSON.stringify(CONTINUE_INPUT)};
    send.click();
    return true;
  })()`);
  const turnRendered = turnSent && await waitFor(`(document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(CONTINUE_REPLY)})`, { tries: 400, intervalMs: 150 });
  check('CONTINUE (案内人): the restored conversation accepts a new turn (input continues from the resumed history)', Boolean(turnRendered), { turnSent, turnRendered });

  // ── RESUME button (no hub start): while still in play (active phase-2 slot), open the load screen through the
  // in-play slot-load tab (canResumePlay = play-mode = true), then click 「プレイに戻る」. Resume re-enters the
  // same phase-2 conversation WITHOUT re-loading the slot, reading the cached /api/slots re-entry contract. ──
  await js(`document.querySelector('[data-screen="slot-load"]').click(); true`);
  await waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && !document.querySelector('#slot-load-resume-play')?.disabled`, { tries: 200, intervalMs: 100 });
  const resumeClicked = await js(`(() => { const b = document.querySelector('#slot-load-resume-play'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const resumed = resumeClicked && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 150 });
  await sleep(400);
  const resumeHubShown = await js(`!!document.querySelector('#routing-hub-screen')?.classList.contains('active')`);
  const resumeLanding = await readDayLanding();
  log('guide_resume', { resumeClicked, resumed, resumeHubShown, activeScreenId: resumeLanding.activeScreenId, speakerName: resumeLanding.speakerName });
  check('RESUME (案内人): the 「プレイに戻る」 button re-enters phase 2 (same conversation) and never opens the routing hub',
    Boolean(resumed && resumeLanding.activeScreenId === 'conversation-day-screen' && !resumeHubShown && resumeLanding.speakerName === PERSONA_DISPLAY_NAME), { resumed, resumeHubShown });

  // ── PHASE 2 → TITLE ──
  await waitFor(`!document.querySelector('#conversation-day-end')?.disabled`, { tries: 200, intervalMs: 120 });
  let ended = false;
  for (let attempt = 0; attempt < 20 && !ended; attempt += 1) {
    ended = await js(`(() => { const end = document.querySelector('#conversation-day-end'); if (!end || end.disabled) return false; end.click(); return true; })()`);
    if (!ended) await sleep(400);
  }
  const toTitle = ended && await waitFor(`document.querySelector('#title-screen')?.classList.contains('active') && !document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 600, intervalMs: 150 });
  const titleState = await js(`(() => ({ activeScreenId: document.querySelector('.screen.active')?.id ?? null, playMode: document.body.classList.contains('play-mode') }))()`);
  log('guide_end', { ended, toTitle, ...titleState });
  check('PHASE 2 → TITLE (案内人): ending the restored 卒業会話 lands on #title-screen and leaves play mode',
    Boolean(toTitle && titleState.activeScreenId === 'title-screen' && titleState.playMode === false), titleState);
}

async function scenarioCandidateAndVariants(lm) {
  const fx = await makeFixture('grad-phase2-restore-candidate', { mode: 'routing' });
  cleanups.push(fx.root, fx.settingsDir);
  const { server, base } = await startGameServer({ root: fx.root, settingsPath: fx.settingsPath, lm });
  cleanups.push(() => server.close());
  log('scenario', { name: 'candidate-and-variants', base });

  await driveToPhase2Day(fx.root, base, SELECT_INPUT_CANDIDATE);
  const before = await readDayLanding();
  check('DRIVE (候補): phase 2 started on the daytime screen with the roster partner (character_001)',
    before.activeScreenId === 'conversation-day-screen' && before.endingCharacterId === 'character_001', before);

  // Candidate LOAD → re-entry with history restored (no persona visual involved).
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const reentered = loaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(GRADUATION_OPENING_TEXT)})
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 150 });
  const after = await readDayLanding();
  const hubShown = await js(`!!document.querySelector('#routing-hub-screen')?.classList.contains('active')`);
  log('candidate_reentry', { loaded, reentered, hubShown, endingCharacterId: after.endingCharacterId });
  check('LOAD (候補): a mid-phase-2 candidate slot re-enters the phase-2 conversation with restored history (never the hub)',
    Boolean(reentered && after.activeScreenId === 'conversation-day-screen' && !hubShown && after.endingCharacterId === 'character_001'), { reentered, hubShown });

  // Read the driven runtime state so the seeded variants keep a valid in-flight phase-2 shape.
  const driven = await readActiveSlotState(fx.root);
  log('driven_state', { current_screen: driven.current_screen, last_conversation_id: driven.last_conversation_id, ending_character_id: driven.ending_character_id });

  // ── Legacy variant: same slot re-saved with current_screen='academy-conversation-session' → legacy landing ──
  await mutateActiveSlotState(fx.root, (state) => { state.current_screen = 'academy-conversation-session'; });
  await reloadToTitle(base);
  const legacyLoaded = await loadFirstSlotFromTitle();
  const onLegacy = legacyLoaded && await waitFor(`
    document.querySelector('#academy-conversation-session-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 150 });
  const legacyState = await js(`(() => ({ activeScreenId: document.querySelector('.screen.active')?.id ?? null }))()`);
  log('legacy_reentry', { legacyLoaded, onLegacy, ...legacyState });
  check('LOAD (legacy screen): a slot saved with current_screen=academy-conversation-session re-enters on the legacy session screen',
    Boolean(onLegacy && legacyState.activeScreenId === 'academy-conversation-session-screen'), legacyState);

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
  // A loop mid-phase-2 slot must land in the conversation, not academy-room. Loop graduation is week-50 gated, so
  // rather than drive 50 weeks this seeds a loop new-game slot into an in-flight phase-2 (opening 未実行) shape and
  // asserts the LOAD lands on the daytime conversation.
  const fx = await makeFixture('grad-phase2-restore-loop', { mode: 'loop' });
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
  log('loop_seed', { slotId: seed.slotId });
  await reloadToTitle(base);
  const loaded = await loadFirstSlotFromTitle();
  const onConversation = loaded && await waitFor(`
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 150 });
  const roomShown = await js(`!!document.querySelector('#academy-room-screen')?.classList.contains('active')`);
  const loopState = await js(`(() => ({ activeScreenId: document.querySelector('.screen.active')?.id ?? null }))()`);
  log('loop_reentry', { loaded, onConversation, roomShown, ...loopState });
  check('LOAD (loop): a loop mid-phase-2 slot lands on the phase-2 conversation, not academy-room',
    Boolean(onConversation && loopState.activeScreenId === 'conversation-day-screen' && !roomShown), loopState);
}

async function main() {
  const lm = await startStubLm();
  cleanups.push(() => lm.server.close());
  await app.whenReady();
  win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await scenarioGuideLoad(lm);
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
