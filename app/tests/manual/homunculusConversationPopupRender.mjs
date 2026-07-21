// Render-backed 錬成室 (homunculus) conversation character-popup check (Electron / real Blink layout + real client flow).
//
// The task: during a 錬成室 conversation on the daytime screen, clicking the うちの子's chat name opens a READ-ONLY
// popup with the child's display_name + 11 parameters (魔法6＋基礎能力5), reusing the atelier compact grid. `node --test`
// cannot run app.js (no DOM / layout), so this drives the REAL client in Electron. Not a *.test.mjs (npm test skips it):
//
//   ./node_modules/.bin/electron app/tests/manual/homunculusConversationPopupRender.mjs
//
// It boots an isolated ROUTING play area with ONE active homunculus seeded (surface + profile with real 11 params),
// a deterministic local LM stub for the one opening chat call, then:
//   1. ?initialScreen=academy-atelier → the 錬成室 arrival renders the seeded active slot (GET /api/atelier).
//   2. Click 会いに行く → startAtelierConversation lands the conversation on #conversation-day-screen; the opening
//      reveals with the うちの子's FACE + a .message-speaker (the click target).
//   3. Click the .message-speaker → the うちの子 popup opens with the display_name title, the うちの子 face, and the 11
//      atelier-grid parameters (.academy-atelier-parameter × 11), re-skinned to the 黒夜 palette.
//   4. READ-ONLY: opening + closing the popup fires NO fetch (no turn/end/record), leaves the chat stream byte-equal,
//      and leaves the conversation usable (send not disabled). Close via button AND backdrop both dismiss it.
//   5. The roster (selectable) name-click path is untouched (asserted by conversationDayScreenRender.mjs).
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
const WIN_W = Number(process.env.HP_WIN_W ?? 1200);
const WIN_H = Number(process.env.HP_WIN_H ?? 820);

// The seeded うちの子: id / name / face (a real hp_0NN face pool asset) + real 11-parameter values spanning the
// low/mid/high meter tiers, so the popup shows 11 distinct real bars (not zero-filled placeholders).
const HOMUNCULUS_ID = 'homunculus_001';
const HOMUNCULUS_NAME = 'ヴィオラ';
const HOMUNCULUS_FACE_ID = 'hp_007';
const HOMUNCULUS_MAGIC = { light: 72, dark: 30, fire: 55, water: 41, earth: 18, wind: 63 };
const HOMUNCULUS_ABILITIES = { strength: 44, agility: 60, academics: 51, magical_power: 77, charisma: 38 };
const OPENING_TEXT = '……おかえりなさい。あなたが、私を灯してくれたのですね。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot, writeJson } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { initializeNewPlayArea, resolvePlayRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// Deterministic LM stub: the atelier opening is a single chat call with NO response_format, so it falls through to
// the opening line. The emotion / work-record branches are defensive (turn-time structured calls) so a stray call
// never breaks the run. Mirrors conversationDayScreenRender.mjs startStubLm().
async function startStubLm() {
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else content = OPENING_TEXT;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function unlockedPlayerParameters() {
  const entry = (label, value) => ({ min: 0, max: 100, label, value });
  const magicKeys = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
  const abilityKeys = ['strength', 'agility', 'academics', 'magical_power', 'charisma'];
  return {
    magic: Object.fromEntries(magicKeys.map((key) => [key, entry(`${key}魔法習熟度`, 85)])),
    abilities: Object.fromEntries(abilityKeys.map((key) => [key, entry(key, 50)]))
  };
}

// Seed one active うちの子 into the slot play root exactly as the backend persists a synthesized child (surface entry
// + profile carrying the 11 parameters + the actor sidecar files the conversation opening reads). GET /api/atelier
// then returns it as an active entry with parameters + a resolved face_url (a real hp_0NN canonical asset).
async function seedActiveHomunculus(slotRoot) {
  await writeJson(slotRoot, 'game_data/homunculi.json', {
    version: 1,
    active: [{ homunculus_id: HOMUNCULUS_ID, display_name: HOMUNCULUS_NAME, face_id: HOMUNCULUS_FACE_ID, created_week: 3 }],
    nameplates: []
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/profile.json`, {
    character_id: HOMUNCULUS_ID,
    display_name: HOMUNCULUS_NAME,
    visual_set_id: HOMUNCULUS_FACE_ID,
    prompt_description: '臆病で甘えん坊、けれど時おり皮肉を差し込むホムンクルス。',
    speaking_basis: '一人称は「私」。控えめで小声、緊張すると言葉に詰まる。',
    parameters: { magic: HOMUNCULUS_MAGIC, abilities: HOMUNCULUS_ABILITIES }
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/flags.json`, { character_id: HOMUNCULUS_ID, flags: {} });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/skills.json`, { character_id: HOMUNCULUS_ID, skills: [] });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/memory`), { recursive: true });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/work_records`), { recursive: true });
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

async function routingFixture() {
  const root = await fixtureRoot('homunculus-popup-render-');
  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });
  const slotRoot = initialized.root;
  await seedActiveHomunculus(slotRoot);
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', unlockedPlayerParameters());
  const state = JSON.parse(await fs.readFile(path.join(slotRoot, 'game_data/runtime_state.json'), 'utf8'));
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-atelier',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: 5
  });
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homunculus-popup-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

async function main() {
  lm = await startStubLm();
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    activeRoot: resolvePlayRoot(root),
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // ── 1) 錬成室 ARRIVAL: the seeded active slot renders with its 会いに行く action ──────────────
  await win.loadURL(`${base}/?initialScreen=academy-atelier`);
  const onAtelier = await waitFor(win, `
    document.querySelector('#academy-atelier-screen')?.classList.contains('active')
    && !!document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk')
  `, { tries: 300, intervalMs: 120 });
  const arrival = await js(win, `(() => {
    const slot = document.querySelector('#academy-atelier-slots .academy-atelier-slot--active');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      slotName: (slot?.querySelector('.academy-atelier-slot-name')?.textContent || '').trim(),
      slotParamCount: slot ? slot.querySelectorAll('.academy-atelier-parameter').length : 0,
      talkPresent: !!document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk')
    };
  })()`);
  log('arrival', { onAtelier, ...arrival });
  check('ARRIVAL: the 錬成室 screen renders the seeded active うちの子 slot with 11 params and a 会いに行く action',
    onAtelier && arrival.activeScreenId === 'academy-atelier-screen' && arrival.slotName === HOMUNCULUS_NAME
      && arrival.slotParamCount === 11 && arrival.talkPresent,
    arrival);

  // ── 2) START CONVERSATION: 会いに行く lands the conversation on the daytime screen with a clickable name ──
  await js(win, `document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk').click(); true`);
  const onDay = await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !!document.querySelector('#conversation-day-message-stream .message-speaker')
  `, { tries: 500, intervalMs: 120 });
  const landing = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const speaker = stream?.querySelector('.message-speaker');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      speakerText: (speaker?.textContent || '').trim(),
      messageCount: stream ? stream.querySelectorAll('.chat-message').length : 0
    };
  })()`);
  log('landing', { onDay, ...landing });
  check('START: 会いに行く lands the 錬成室 conversation on #conversation-day-screen with the うちの子 name as the click target',
    onDay && landing.activeScreenId === 'conversation-day-screen' && landing.speakerText === HOMUNCULUS_NAME && landing.messageCount > 0,
    landing);

  // ── 3) READ-ONLY BASELINE: snapshot the stream + control state and start a fetch counter ─────────
  await js(win, `(() => {
    window.__baselineStreamHtml = document.querySelector('#conversation-day-message-stream').innerHTML;
    window.__fetchCount = 0;
    if (!window.__fetchWrapped) {
      const orig = window.fetch;
      window.fetch = (...args) => { window.__fetchCount += 1; return orig.apply(window, args); };
      window.__fetchWrapped = true;
    }
    return true;
  })()`);

  // ── 4) HOMUNCULUS POPUP: click the うちの子 name → the popup opens with display_name + face + 11 params ──
  await js(win, `document.querySelector('#conversation-day-message-stream .message-speaker').click(); true`);
  const popupOpen = await waitFor(win, `!document.querySelector('#conversation-day-homunculus-popup').hidden`, { tries: 80, intervalMs: 40 });
  const popup = await js(win, `(() => {
    const popup = document.querySelector('#conversation-day-homunculus-popup');
    const face = document.querySelector('#conversation-day-homunculus-popup-face');
    const section = document.querySelector('#conversation-day-homunculus-popup-parameters');
    const grid = section?.querySelector('.academy-atelier-parameters');
    const rows = section ? [...section.querySelectorAll('.academy-atelier-parameter')] : [];
    return {
      title: (document.querySelector('#conversation-day-homunculus-popup-title')?.textContent || '').trim(),
      faceSrc: face ? (face.getAttribute('src') || '') : '',
      gridPresent: !!grid,
      paramCount: rows.length,
      labels: rows.map((r) => (r.querySelector('.academy-atelier-parameter-label')?.textContent || '').trim()),
      values: rows.map((r) => (r.querySelector('.academy-atelier-parameter-value')?.textContent || '').trim()),
      meterFill: rows[0] ? getComputedStyle(rows[0].querySelector('meter'), '::-webkit-meter-optimum-value').backgroundColor : '',
      characterPopupHidden: !!document.querySelector('#conversation-day-character-popup')?.hidden
    };
  })()`);
  log('homunculus_popup', { popupOpen, ...popup });
  check('POPUP: clicking the うちの子 name opens the homunculus popup with the display_name title + a face + the 11 params via the atelier grid',
    popupOpen && popup.title === HOMUNCULUS_NAME && popup.faceSrc.includes(`/${HOMUNCULUS_FACE_ID}/`) && /\/canonical\//.test(popup.faceSrc)
      && popup.gridPresent && popup.paramCount === 11,
    popup);
  check('POPUP: the 11 rows carry the server labels and the seeded values (real bars, not zero-filled), and the roster character popup stays closed',
    popup.labels.includes('光魔法習熟度') && popup.labels.includes('カリスマ')
      && popup.values.includes(String(HOMUNCULUS_MAGIC.light)) && popup.values.includes(String(HOMUNCULUS_ABILITIES.magical_power))
      && popup.characterPopupHidden,
    { labels: popup.labels, values: popup.values, characterPopupHidden: popup.characterPopupHidden });

  // Let the face decode + the offscreen window repaint the popup frame, then capture it for うゆりす's visual review.
  const shotDir = path.join(os.tmpdir(), 'homunculus-name-parameter-popup-frontend');
  await fs.mkdir(shotDir, { recursive: true });
  const capture = async (name) => {
    const p = path.join(shotDir, name);
    try { await fs.writeFile(p, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${p}`); }
    catch (e) { console.log(`screenshot: FAILED ${name} ${e?.message ?? e}`); }
  };
  await waitFor(win, `(() => { const i = document.querySelector('#conversation-day-homunculus-popup-face'); return !!i && i.complete && i.naturalWidth > 0; })()`, { tries: 80, intervalMs: 40 });
  await sleep(300);
  await capture('homunculus-conversation-popup.png');

  // ── 5) READ-ONLY: opening the popup fired no fetch and left the stream byte-equal ────────────────
  const readonlyOpen = await js(win, `(() => ({
    fetchCount: window.__fetchCount,
    streamUnchanged: document.querySelector('#conversation-day-message-stream').innerHTML === window.__baselineStreamHtml,
    sendDisabled: !!document.querySelector('#conversation-day-send')?.disabled
  }))()`);
  log('readonly_open', readonlyOpen);
  check('READ-ONLY: opening the popup fired NO fetch (no turn/end/record) and left the chat stream byte-equal, conversation still usable',
    readonlyOpen.fetchCount === 0 && readonlyOpen.streamUnchanged && !readonlyOpen.sendDisabled, readonlyOpen);

  // ── 6) CLOSE via button, then reopen + close via backdrop ────────────────────────────────────────
  await js(win, `document.querySelector('#conversation-day-homunculus-popup .conversation-day-info-popup-close').click(); true`);
  const closedByButton = await waitFor(win, `document.querySelector('#conversation-day-homunculus-popup').hidden === true`, { tries: 60, intervalMs: 40 });
  check('CLOSE: the close button dismisses the homunculus popup', closedByButton, { closedByButton });

  await js(win, `document.querySelector('#conversation-day-message-stream .message-speaker').click(); true`);
  await waitFor(win, `!document.querySelector('#conversation-day-homunculus-popup').hidden`, { tries: 60, intervalMs: 40 });
  const closedByBackdrop = await js(win, `(() => { document.querySelector('#conversation-day-homunculus-popup .conversation-day-character-popup-backdrop').click(); return true; })()`)
    .then(() => waitFor(win, `document.querySelector('#conversation-day-homunculus-popup').hidden === true`, { tries: 60, intervalMs: 40 }));
  check('CLOSE: clicking the backdrop dismisses the homunculus popup (same modal流儀 as the info drawer)', closedByBackdrop, { closedByBackdrop });

  const readonlyAfter = await js(win, `(() => ({
    fetchCount: window.__fetchCount,
    streamUnchanged: document.querySelector('#conversation-day-message-stream').innerHTML === window.__baselineStreamHtml,
    sendDisabled: !!document.querySelector('#conversation-day-send')?.disabled,
    atelierConversationLive: !!document.querySelector('#conversation-day-screen')?.classList.contains('active')
  }))()`);
  log('readonly_after', readonlyAfter);
  check('READ-ONLY: after open→close→reopen→close, still NO fetch, stream byte-equal, conversation live and usable',
    readonlyAfter.fetchCount === 0 && readonlyAfter.streamUnchanged && !readonlyAfter.sendDisabled && readonlyAfter.atelierConversationLive,
    readonlyAfter);

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
