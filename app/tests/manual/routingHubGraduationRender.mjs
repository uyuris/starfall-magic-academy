// Render-backed routing graduation guide check (Electron / real Blink layout + real client flow).
//
// Sibling of routingHubSessionScreenRender.mjs (same 系), focused on the routing week-50 graduation guide
// frontend wiring (task routing-graduation-guide-frontend). `node --test` cannot run app.js (no fetch/DOM/SSE
// pump), so the graduation guide → selection → 卒業会話 → title path is verified here against the REAL client in
// Electron. Not named *.test.mjs and under app/tests/manual/, so `npm test` skips it; run by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubGraduationRender.mjs
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC LM stub, new-games into the hub, seeds the
// active slot's runtime state to elapsed_weeks=49 (the displayed graduation week), and drives the REAL flow.
// The graduation guide now begins AT HUB START (POST /api/routing/hub/start seeds routing_graduation_guide when
// elapsed_weeks>=49), never on an in-turn decided turn, so the harness re-enters the hub after seeding to make a
// fresh hub start observe the seeded week:
//   1. GUIDE ENTRY (hub start): re-enter the hub via the load screen's "プレイに戻る" (resume) — it re-runs
//      enterRoutingHub → POST /api/routing/hub/start on the active slot (now at elapsed_weeks=49), so the backend
//      seeds the graduation guide at hub start. The client lands on #routing-hub-screen with the guide phase
//      active; /api/state shows elapsed_weeks stays 49 (the guide holds it there until the ending starts).
//   2. WEEK 第50週: the guide-phase hub week counter reads 第50週 / 50 (elapsed_weeks=49 → elapsed+1, no pin).
//   2b. GUIDE END: pressing 今日はここまで during the guide does NOT 409 — endRoutingConversation omits wrap_up while
//      the guide is active, so the backend returns the guide continuation contract and the client stays on
//      #routing-hub-screen with the composer re-enabled and no error banner (guide still active, elapsed_weeks 49).
//   3. SELECTION → 卒業会話: a turn that confirms a partner emits graduation_guide_draining, holds the 見送り
//      読みポーズ, covers with the graduation-ending-start loading, then transitions to the DAYTIME conversation
//      screen (#conversation-day-screen) with the selected character's graduation event conversation shown. With
//      no conversation-popup settings the academy_conversation_screen preference defaults to 'day', so the
//      graduation event follows the same daytime landing every event conversation follows — current_screen is the
//      truthful 'interaction' and the stage frame paints the event location field stage.
//   4. PHASE 2 → TITLE: ending the graduation event conversation (the #conversation-day-end button) lands on
//      #title-screen (graduation-ending-complete), the same terminal as the loop graduation.
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
// The partner-selection input (the stub's graduation_guide_selection judgment picks the first candidate).
const SELECT_INPUT = 'あなたと一緒に、この学院生活を締めくくりたい';
const SELECT_REPLY = 'ふふ、うれしい。では最後の時間を、一緒に過ごしましょうね。';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const GRADUATION_OPENING_TEXT = 'とうとうこの日が来たね。一緒に過ごした日々を、少し振り返ろうか。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
const { resolvePlayRoot, resolvePlaySlotsRoot, resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// Deterministic routing LM stub. Mirrors the routingHubSessionScreenRender stub, plus the graduation guide
// selection judgment (returns the first candidate character_id off the prompt's candidate table) and the
// graduation-appropriate reply / opening text.
function routingTurnLmResponder({ prompt, requestIndex }) {
  if (prompt.includes('好感度の変化量を判定する')) return '0';
  if (prompt.includes('MP温存ライン')) return '30';
  if (prompt.includes('所持金判定')) return '0';
  if (prompt.includes('場所移動の合意')) return 'false';
  if (prompt.includes('location_idを1つだけ返す')) return 'none';
  // Graduation guide partner selection judgment: pick the first candidate id listed in the candidate table so
  // the guide confirms a partner and phase 2 begins (strict closed set: a candidate id or none).
  if (prompt.includes('締めくくりを誰と過ごすと選んだか')) {
    const m = prompt.match(/character_\d{3}/);
    return m ? m[0] : 'none';
  }
  // Routing destination judgment: the guide phase never decides a destination (the backend gates destination
  // judgment off during the guide), so every turn returns none — no in-turn dispatch occurs.
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'none';
  if (requestIndex === 0) return OPENING_TEXT;
  if (prompt.includes(SELECT_INPUT)) return SELECT_REPLY;
  // Fallback reply text (also serves the graduation event opening, which carries no judgment marker).
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

// Seed the ACTIVE ROUTING SLOT's runtime state to elapsed_weeks=weeks so the next decided turn advances to week
// 50 and begins the graduation guide. Routing mode keeps its runtime state per save slot (not the top-level
// game_data/runtime_state.json), resolved through the active_slot.json pointer; seed that slot's plain-JSON
// runtime_state.json, preserving the hub interaction context the new-game just set up.
async function seedActiveSlotElapsedWeeks(root, weeks) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  const slotId = active.active_slot_id ?? active.slot_id ?? active.active_slot ?? null;
  if (!slotId) throw new Error(`no active routing slot to seed: ${JSON.stringify(active)}`);
  const statePath = path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.elapsed_weeks = weeks;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { slotId, elapsedWeeks: state.elapsed_weeks, statePath };
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

// Re-enter the hub by LOADING the seeded slot from a freshly reloaded client. A full reload drops the stale
// in-session hub/opening-event state, and POST /api/slots/load re-establishes the active routing read scope and
// reads the slot's seeded elapsed_weeks=49, so the fresh enterRoutingHub → POST /api/routing/hub/start seeds the
// graduation guide AT HUB START. Open the load screen through the screen-tabs, then click the slot's load button.
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

async function main() {
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
  log('server', { base, playMode: 'routing', variant: PERSONA_VARIANT });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // ── Entry + seed week 49 ────────────────────────────────────────────────
  const onHub = await newGameToHub(win, base);
  check('ENTRY lands on the routing hub', onHub && await js(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active')`));
  const seeded = await seedActiveSlotElapsedWeeks(root, 49);
  log('seed', seeded);

  // ── 1) GUIDE ENTRY (hub start) + 2) WEEK 第50週 ──────────────────────────
  // Re-enter the hub by loading the seeded slot so a fresh POST /api/routing/hub/start runs at elapsed_weeks=49:
  // the backend seeds the graduation guide AT HUB START, the client lands on #routing-hub-screen, elapsed_weeks
  // stays 49 (the guide holds it there), and the week counter derives 第50週 / 50 from elapsed_weeks+1 (no pin).
  const guideOnHub = await loadSlotIntoHub(win, base);
  await sleep(600);
  const afterGuideEntry = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
      elapsedWeeks: Number(state?.elapsed_weeks),
      guideActive: state?.routing_graduation_guide != null,
      candidateCount: Array.isArray(state?.routing_graduation_guide?.candidate_character_ids) ? state.routing_graduation_guide.candidate_character_ids.length : 0,
      weekText: (document.querySelector('#routing-hub-week')?.textContent || '').trim()
    };
  })()`);
  log('guide_entry', { guideOnHub, ...afterGuideEntry });
  check('GUIDE ENTRY: re-entering the hub at the displayed graduation week seeds the guide AT HUB START and STAYS on #routing-hub-screen (elapsed_weeks stays 49, guide active with candidates)',
    Boolean(guideOnHub && afterGuideEntry.activeScreenId === 'routing-hub-screen' && !afterGuideEntry.loadingActive && afterGuideEntry.elapsedWeeks === 49 && afterGuideEntry.guideActive && afterGuideEntry.candidateCount >= 1), afterGuideEntry);
  check('WEEK: the guide-phase hub week counter reads 第50週 / 50 (elapsed_weeks=49 → elapsed+1, no pin, not 第51週)',
    afterGuideEntry.weekText.includes('第50週') && afterGuideEntry.weekText.includes('50') && !afterGuideEntry.weekText.includes('第51週'), afterGuideEntry);

  // ── 2b) GUIDE END ("今日はここまで"): CONVERSATION CONTINUES (no 409) ──────
  // During the guide week the hub end button must NOT 409. endRoutingConversation omits wrap_up while the guide
  // is active (isRoutingGraduationGuideActive()), so the backend returns the guide continuation contract
  // (finalization_status:'idle' + graduation_guide + transition.next_screen='interaction', state unchanged): the
  // client STAYS on #routing-hub-screen with the composer re-enabled and no error banner, the guide still active
  // and elapsed_weeks still 49. Before the fleet fix this end sent wrap_up:'title' and surfaced a 409 error
  // banner on the hub.
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
      loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
      sendDisabled: !!document.querySelector('#routing-hub-send')?.disabled,
      endDisabled: !!document.querySelector('#routing-hub-end')?.disabled,
      statusHidden: status ? status.hidden : true,
      statusText: (status?.textContent || '').trim(),
      elapsedWeeks: Number(state?.elapsed_weeks),
      guideActive: state?.routing_graduation_guide != null
    };
  })()`);
  log('guide_end', { guideEndClicked, guideEndSettled, ...afterGuideEnd });
  check('GUIDE END: "今日はここまで" during the guide keeps the conversation alive — stays on #routing-hub-screen, composer re-enabled, no error banner (no 409), guide still active, elapsed_weeks still 49',
    Boolean(guideEndSettled && afterGuideEnd.activeScreenId === 'routing-hub-screen' && !afterGuideEnd.loadingActive
      && !afterGuideEnd.sendDisabled && !afterGuideEnd.endDisabled && afterGuideEnd.statusHidden && afterGuideEnd.statusText === ''
      && afterGuideEnd.guideActive && afterGuideEnd.elapsedWeeks === 49), afterGuideEnd);

  // ── 3) SELECTION → 卒業会話 (conversation-day) ───────────────────────────
  const selectSent = await sendHubTurn(win, SELECT_INPUT);
  // The selection turn holds the ~5s graduation reading pause, covers with the graduation-ending-start loading,
  // then transitions to the graduation event conversation on the DAYTIME screen (#conversation-day-screen) —
  // the academy_conversation_screen preset defaults to 'day', so the graduation event follows the same daytime
  // landing every event conversation follows (opening streamed).
  const onGraduationDay = selectSent && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 150 });
  await sleep(500);
  const selectionLanding = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    const stageImage = document.querySelector('#conversation-day-stage-image');
    const stageBg = stageImage ? getComputedStyle(stageImage).backgroundImage : '';
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
      currentScreen: state?.current_screen ?? null,
      endingCharacterId: state?.ending_character_id ?? null,
      pendingEventFlag: state?.pending_interaction_context?.event_flag_id ?? null,
      guideCleared: state?.routing_graduation_guide == null,
      stageBg
    };
  })()`);
  log('selection_landing', { selectSent, onGraduationDay, ...selectionLanding });
  check('SELECTION → 卒業会話: confirming a partner transitions to the graduation event on #conversation-day-screen (daytime landing, not stranded on loading)',
    Boolean(onGraduationDay && selectionLanding.activeScreenId === 'conversation-day-screen' && !selectionLanding.loadingActive), selectionLanding);
  // The persisted current_screen is the truthful 'interaction' (the daytime event mapping), never the session hard-pin.
  check('SELECTION: the daytime landing writes the truthful current_screen (interaction), not the academy-conversation-session hard-pin',
    selectionLanding.currentScreen === 'interaction', selectionLanding);
  // The daytime stage frame paints the event location field stage (a real background image, no placeholder).
  check('SELECTION: the daytime graduation stage frame (#conversation-day-stage-image) renders the event location field stage (non-empty background image)',
    typeof selectionLanding.stageBg === 'string' && selectionLanding.stageBg.includes('url('), selectionLanding);
  check('SELECTION: the backend started phase 2 (ending_character_id set, graduation ending event pending, guide phase cleared)',
    Boolean(selectionLanding.endingCharacterId && selectionLanding.pendingEventFlag === 'event.graduation_ending.ready' && selectionLanding.guideCleared), selectionLanding);

  // ── 4) PHASE 2 → TITLE ──────────────────────────────────────────────────
  await waitFor(win, `!document.querySelector('#conversation-day-end')?.disabled`, { tries: 200, intervalMs: 120 });
  let phase2EndClicked = false;
  for (let attempt = 0; attempt < 20 && !phase2EndClicked; attempt += 1) {
    phase2EndClicked = await js(win, `(() => { const end = document.querySelector('#conversation-day-end'); if (!end || end.disabled) return false; end.click(); return true; })()`);
    if (!phase2EndClicked) await sleep(400);
  }
  const endedToTitle = phase2EndClicked && await waitFor(win, `
    document.querySelector('#title-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 600, intervalMs: 150 });
  const titleState = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active')
  }))()`);
  log('phase2_end_to_title', { phase2EndClicked, endedToTitle, ...titleState });
  check('PHASE 2 → TITLE: ending the graduation event conversation lands on #title-screen (graduation-ending-complete), like the loop graduation',
    Boolean(endedToTitle && titleState.activeScreenId === 'title-screen' && !titleState.loadingActive), titleState);

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
