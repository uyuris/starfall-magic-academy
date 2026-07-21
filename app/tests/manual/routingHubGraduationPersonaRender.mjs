// Render-backed routing graduation guide 案内人 (routing persona) check (Electron / real Blink layout + real
// client flow).
//
// Sibling of routingHubGraduationRender.mjs (which drives the candidate `character_###` path). This one drives
// the 案内人自身 (routing persona / actor id `lina`) partner selection (task graduation-lumi-partner-frontend):
// selecting ルミ starts a phase-2 卒業 event conversation on the DAYTIME screen OUTSIDE the routing hub, where the
// hub-scoped persona registry no longer resolves her. It verifies that the dedicated phase-2 persona registry
// makes ルミ's face + speaker name render from her own variant art (routing_lumi_<variant>, never the roster
// head), that the daytime diary shows ルミの日記, that the speaker-name popup is 一枚絵 + name only, and that the
// phase-2 end lands on the title.
//
// `node --test` cannot run app.js (no fetch/DOM/SSE pump), so this runs against the REAL client in Electron. Not
// named *.test.mjs and under app/tests/manual/, so `npm test` skips it; run by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubGraduationPersonaRender.mjs
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
// The partner-selection input: the player asks to spend the last time with ルミ herself (the 案内人). The stub's
// selection judgment answers `lina` so the guide confirms the 案内人 and phase 2 begins with the routing persona.
const SELECT_INPUT = 'あなた自身と、この学院生活の最後を過ごしたい';
const SELECT_REPLY = 'ふふ、うれしい。では最後の時間を、わたしと一緒に過ごしましょうね。';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const GRADUATION_OPENING_TEXT = 'とうとうこの日が来たね。一緒に歩いたこの一年を、少し振り返ろうか。';

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

// Deterministic routing LM stub. Mirrors routingHubGraduationRender's stub, except the graduation guide selection
// judgment answers `lina` (the 案内人自身 option) so phase 2 runs with the routing persona.
function routingTurnLmResponder({ prompt, requestIndex }) {
  if (prompt.includes('好感度の変化量を判定する')) return '0';
  if (prompt.includes('MP温存ライン')) return '30';
  if (prompt.includes('所持金判定')) return '0';
  if (prompt.includes('場所移動の合意')) return 'false';
  if (prompt.includes('location_idを1つだけ返す')) return 'none';
  // Graduation guide partner selection judgment: pick the 案内人自身 (lina) so phase 2 begins with the persona.
  if (prompt.includes('締めくくりを誰と過ごすと選んだか')) return 'lina';
  // The guide phase never decides a destination (the backend gates destination judgment off during the guide).
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'none';
  if (requestIndex === 0) return OPENING_TEXT;
  if (prompt.includes(SELECT_INPUT)) return SELECT_REPLY;
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
// graduation guide AT HUB START (the guide no longer begins on an in-turn decided turn).
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

  // ── Entry + seed week 49 + guide entry (hub start) ──────────────────────
  const onHub = await newGameToHub(win, base);
  check('ENTRY lands on the routing hub', onHub && await js(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active')`));
  const seeded = await seedActiveSlotElapsedWeeks(root, 49);
  log('seed', seeded);

  // Re-enter the hub by loading the seeded slot so hub start observes the seeded week and seeds the graduation
  // guide AT HUB START (elapsed stays 49; the guide holds it there until the ending starts). Then select 案内人
  // (lina) as the partner.
  const guideOnHub = await loadSlotIntoHub(win, base);
  await sleep(600);
  const afterGuideEntry = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      guideActive: state?.routing_graduation_guide != null,
      elapsedWeeks: Number(state?.elapsed_weeks)
    };
  })()`);
  log('guide_entry', { guideOnHub, ...afterGuideEntry });
  check('GUIDE ENTRY: re-entering the hub at the displayed graduation week seeds the guide AT HUB START and stays on the hub (elapsed_weeks stays 49)',
    Boolean(guideOnHub && afterGuideEntry.activeScreenId === 'routing-hub-screen' && afterGuideEntry.guideActive && afterGuideEntry.elapsedWeeks === 49), afterGuideEntry);

  // ── SELECTION (案内人 / lina) → 卒業会話 (conversation-day) ────────────────
  const selectSent = await sendHubTurn(win, SELECT_INPUT);
  const onGraduationDay = selectSent && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 150 });
  await sleep(600);
  const landing = await js(win, `(async () => {
    const state = await fetch('/api/state').then((r) => r.json());
    const speaker = document.querySelector('#conversation-day-message-stream .message-speaker');
    const face = document.querySelector('#conversation-day-message-stream .message-face img');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
      endingCharacterId: state?.ending_character_id ?? null,
      pendingEventFlag: state?.pending_interaction_context?.event_flag_id ?? null,
      speakerName: speaker ? speaker.textContent.trim() : null,
      faceSrc: face ? face.getAttribute('src') : null
    };
  })()`);
  log('selection_landing', { selectSent, onGraduationDay, ...landing });
  check('SELECTION (案内人): confirming ルミ transitions to the graduation event on #conversation-day-screen (not stranded on loading)',
    Boolean(onGraduationDay && landing.activeScreenId === 'conversation-day-screen' && !landing.loadingActive), landing);
  check('SELECTION (案内人): backend started phase 2 with the routing actor (ending_character_id=lina, graduation ending pending)',
    Boolean(landing.endingCharacterId === 'lina' && landing.pendingEventFlag === 'event.graduation_ending.ready'), landing);
  check('PHASE 2 IDENTITY: the daytime speaker name is the persona variant name (ルミ), not the roster head',
    landing.speakerName === PERSONA_DISPLAY_NAME, landing);
  check('PHASE 2 IDENTITY: the daytime message face renders the routing persona variant art (routing_lumi_<variant>), never a roster face',
    typeof landing.faceSrc === 'string' && landing.faceSrc.includes(PERSONA_VISUAL_SET), landing);

  // ── DIARY: the daytime diary shows ルミの日記 (fetch character_id=lina) ─────
  const diaryOpened = await js(win, `(() => {
    const btn = document.querySelector('.conversation-day-category-button[data-day-category="diary"]');
    if (!btn) return false; btn.click(); return true;
  })()`);
  await sleep(700);
  const diary = await js(win, `(() => {
    const popup = document.querySelector('#conversation-day-info-popup');
    const body = document.querySelector('#conversation-day-info-popup-body');
    return { open: !!(popup && !popup.hidden && popup.dataset.category === 'diary'), text: body ? body.textContent.trim() : '' };
  })()`);
  log('diary', { diaryOpened, ...diary });
  check('DIARY (案内人): the daytime diary opens ルミの日記 (persona partner, not a roster diary error)',
    Boolean(diaryOpened && diary.open && diary.text.includes(PERSONA_DISPLAY_NAME)), diary);

  // ── POPUP: speaker-name click opens the 一枚絵 + name only persona popup ────
  await js(win, `document.querySelector('#conversation-day-info-popup [data-day-popup-close]')?.click(); true`);
  await sleep(300);
  const popupOpened = await js(win, `(() => {
    const speaker = document.querySelector('#conversation-day-message-stream .message-speaker');
    if (!speaker) return false; speaker.click(); return true;
  })()`);
  await sleep(400);
  const popup = await js(win, `(() => {
    const popup = document.querySelector('#conversation-day-graduation-popup');
    const title = document.querySelector('#conversation-day-graduation-popup-title');
    const standee = document.querySelector('#conversation-day-graduation-popup-standee');
    return {
      shown: !!(popup && !popup.hidden),
      title: title ? title.textContent.trim() : null,
      standeeSrc: standee ? standee.getAttribute('src') : null,
      hasParameters: !!popup?.querySelector('[id*="parameters"], .interaction-character-parameters')
    };
  })()`);
  log('popup', { popupOpened, ...popup });
  check('POPUP (案内人): the speaker-name click opens the persona popup with ルミ + her standee art, and NO ability section',
    Boolean(popupOpened && popup.shown && popup.title === PERSONA_DISPLAY_NAME && typeof popup.standeeSrc === 'string' && popup.standeeSrc.includes(PERSONA_VISUAL_SET) && !popup.hasParameters), popup);
  await js(win, `document.querySelector('#conversation-day-graduation-popup [data-day-popup-close]')?.click(); true`);
  await sleep(300);

  // ── PHASE 2 → TITLE ──────────────────────────────────────────────────────
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
    playMode: document.body.classList.contains('play-mode')
  }))()`);
  log('phase2_end_to_title', { phase2EndClicked, endedToTitle, ...titleState });
  check('PHASE 2 → TITLE: ending the 案内人 graduation event lands on #title-screen and leaves play mode (graduation-ending-complete)',
    Boolean(endedToTitle && titleState.activeScreenId === 'title-screen' && titleState.playMode === false), titleState);

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
