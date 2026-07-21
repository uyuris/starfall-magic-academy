// Render-backed routing-hub chat-corner orientation check (Electron / real Blink computed transform).
//
// `node --test` cannot resolve a CSS transform matrix (no real layout), so the routing hub chat panel's
// bottom-right corner ornament orientation is verified here against the REAL client in Electron. This file is
// intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test` (node --test
// app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubScreenRender.mjs
//
// Scope A — corner ornaments (static CSS decoration): the chat panel corner ornaments are static CSS
// decoration on the #routing-hub-screen markup, so section A does not start a routing session (no LM). It
// activates #routing-hub-screen by toggling .active directly (no app side effects), then measures the
// corner <img> computed transforms against real layout:
//   - top-left  .routing-hub-corner-tl: corner_01 UPRIGHT — translate(-6,-8)         => matrix(1,0,0,1,-6,-8)
//   - bottom-right .routing-hub-corner-br: corner_01 180° POINT REFLECTION (scale(-1,-1) = 上下左右反転) after
//     the same calibration translate — translate(7,9) scale(-1,-1)                    => matrix(-1,0,0,-1,7,9)
// The BR check FAILS if the ornament is still upright (the pre-flip matrix(1,0,0,1,7,9)), so this harness does
// not pass on the buggy CSS — the upright TL measured from the same render is the built-in reference contrast.
//
// Scope B — routing entry loading flow (押下→ロード画面→hub 表示): section B measures the requested routing
// entry flow in real Blink for all THREE routing play entries — new game, slot load (このデータで始める), and
// resume (プレイに戻る). Most entry checks double ONLY POST /api/routing/hub/start with window.fetch: it delays a
// canned valid hub response so the in-flight window is samplable, then returns it. The global-loop/routing-slot
// regression probe removes that double and drives the real hub-start API with a local LM stub. Everything else
// (new-game slot creation, /api/slots/load, the real screen transitions, the real academy-loading +
// routing-hub renders) hits the real server / real app, driven by the real buttons. For each entry it measures:
//   1. while the hub start is in flight: #academy-loading-screen is active with the ROUTING_HUB_ENTRY copy
//      (ハブへ移動しています) and #routing-hub-screen is NOT active — the entry shows the loading screen during
//      the request instead of freezing on the previous screen;
//   2. once the hub start resolves: #routing-hub-screen is active and #academy-loading-screen is not — the
//      switch to the hub happens when the opening is ready.
// The slot-load and resume entries drive the real load screen (#slot-load-list button / #slot-load-resume-play)
// using the slot the new-game entry created. Two screenshots (routing frame corners; the landed hub) are saved
// for うゆりす's visual confirmation.
// Per ref-camera, the harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = 1200;
const WIN_H = 820;

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

async function routingFixture() {
  const root = await fixtureRoot('routing-hub-screen-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-screen-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  // A routing-mode sidecar: section A toggles #routing-hub-screen .active directly (static CSS decoration, mode
  // independent); section B needs it so the real new-game entry resolves to the routing branch. Routing requires
  // an explicit persona variant.
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const convPopupSettingsPath = path.join(settingsDir, 'conversation-popup.json');
  return { root, settingsDir, settingsPath, convPopupSettingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lmServer;
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

async function routingLmStub() {
  const requests = [];
  const stub = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'こんばんは。今週はどこへ向かう？' } }] }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return { server: stub, baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, requests };
}

// Measure one routing play entry (new game / slot load / resume) in real Blink. `mode` picks how the doubled
// hub start resolves — 'success' (canned hub), 'lm-error' (LMSTUDIO_CONFIG_REQUIRED), or 'generic-error'. In
// every mode the entry must show #academy-loading WHILE the hub start is in flight; only the after-state
// differs, given by `afterSelector` / `afterName` (success → the hub; lm-error → settings; generic-error →
// the origin screen). `setup` navigates to the pre-trigger screen; `trigger` is the real user button click.
async function measureRoutingEntry(win, label, { setup = null, trigger, mode = 'success', afterSelector, afterName }) {
  if (setup) await setup();
  await js(win, `window.__hubStartMode = ${JSON.stringify(mode)}; true`);
  await js(win, trigger);
  const sawLoading = await waitFor(win, `document.querySelector('#academy-loading-screen').classList.contains('active')`, { tries: 160, intervalMs: 20 });
  const during = await js(win, `(() => ({
    loadingActive: document.querySelector('#academy-loading-screen').classList.contains('active'),
    hubActive: document.querySelector('#routing-hub-screen').classList.contains('active'),
    settingsActive: document.querySelector('#settings-screen').classList.contains('active'),
    loadingTitle: document.querySelector('#academy-loading-title').textContent,
    loadingStatus: document.querySelector('#academy-loading-status').textContent
  }))()`);
  log(`entry_${label}_during`, during);
  check(`ENTRY(${label}): while the hub start is in flight, #academy-loading is active (ハブへ移動しています) and the hub is not — the loading screen shows during the request, not the frozen previous screen`,
    sawLoading && during.loadingActive === true && during.hubActive === false && during.settingsActive === false
      && during.loadingTitle === 'ハブへ移動しています'
      && during.loadingStatus === '案内人が出迎えの支度をしています。',
    during);
  const sawAfter = await waitFor(win, `document.querySelector('${afterSelector}').classList.contains('active')`, { tries: 200, intervalMs: 50 });
  const after = await js(win, `(() => ({
    loadingActive: document.querySelector('#academy-loading-screen').classList.contains('active'),
    targetActive: document.querySelector('${afterSelector}').classList.contains('active'),
    hubActive: document.querySelector('#routing-hub-screen').classList.contains('active'),
    settingsActive: document.querySelector('#settings-screen').classList.contains('active')
  }))()`);
  log(`entry_${label}_after`, after);
  check(`ENTRY(${label}): after the hub start resolves, ${afterName} is active and #academy-loading is not — the loading screen is never terminal`,
    sawAfter && after.targetActive === true && after.loadingActive === false,
    after);
  if (mode === 'success') {
    // Let the hub entry fully settle before the next entry: sawAfter fires at showScreen('routing-hub'), BEFORE
    // enterRoutingHub's opening reveal + the finally that releases conversationRequestInFlight. Wait for the
    // reveal to commit the 迎え bubble, then a short settle, so the next entry does not hit enterRoutingHub's
    // re-entrancy guard mid-reveal (a real user cannot trigger the next entry that fast).
    await waitFor(win, `(() => { const s = document.querySelector('#routing-hub-message-stream'); return !!s && s.textContent.includes('こんばんは'); })()`, { tries: 200, intervalMs: 25 });
    await sleep(1000);
  } else {
    // Failure paths have no hub reveal; enterRoutingHub's finally already released the in-flight flag right
    // after the error was handled. A short settle keeps the next entry off the re-entrancy guard.
    await sleep(600);
  }
}

// Install the /api/routing/hub/start network double on the current page. It intercepts ONLY that endpoint
// (everything else hits the real server) and, after a 1s delay so the in-flight loading screen is samplable,
// resolves per window.__hubStartMode: 'success' → canned valid hub, 'lm-error' → LMSTUDIO_CONFIG_REQUIRED,
// 'generic-error' → a plain 500. Re-run after any reload (a reload wipes the override); it resets the
// per-page call counter window.__hubStartCalls.
async function installHubStartDouble(win) {
  await js(win, `(() => {
    const realFetch = window.fetch.bind(window);
    window.__restoreHubStartDouble = () => {
      window.fetch = realFetch;
      return true;
    };
    window.__hubStartCalls = 0;
    window.__hubStartMode = 'success';
    const canned = {
      conversation: {
        id: 'harness_hub_conv',
        routing_hub: true,
        character_id: 'lina',
        character_name: 'ルミ',
        messages: [{ role: 'assistant', content: 'こんばんは。今週はどこへ向かう？' }]
      },
      routing_persona_visual: {
        character_id: 'lina',
        display_name: 'ルミ',
        visual_set_id: 'routing_lumi_fallen_star',
        // A real canonical variant set (fallen_star, the default) — what buildRoutingPersonaVisualSummary
        // produces for the effective variant — so the ルミ face / standee actually render in the hub +
        // character-popup screenshots.
        face_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        selection_icon_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        standee_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/scene_standee/scene_standee_character_01.jpg'
      },
      state: { elapsed_weeks: 0 }
    };
    const respond = () => {
      const mode = window.__hubStartMode;
      if (mode === 'lm-error') {
        // An LM Studio config error the player fixes in settings (the settings-redirect class).
        return new Response(JSON.stringify({ error_code: 'LMSTUDIO_CONFIG_REQUIRED', error: 'LM Studio の接続設定が必要です。' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      if (mode === 'generic-error') {
        // Any non-LM hub-start failure (rethrown after un-stranding from the loading screen to the origin).
        return new Response(JSON.stringify({ error: 'hub start failed (harness generic error)' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(canned), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/routing/hub/start')) {
        window.__hubStartCalls += 1;
        return new Promise((resolve) => setTimeout(() => resolve(respond()), 1000));
      }
      return realFetch(input, init);
    };
    return true;
  })()`);
}

async function restoreHubStartDouble(win) {
  await js(win, `(() => {
    if (typeof window.__restoreHubStartDouble === 'function') return window.__restoreHubStartDouble();
    return true;
  })()`);
}

// Load a fresh, visible title screen and reinstall the hub-start double, so a #start-new-game press is a
// faithful click on the active title screen (not an inactive DOM node). Slots persist on disk across reload.
async function freshTitleScreen(win, base, { hubStartDouble = true } = {}) {
  await win.loadURL(`${base}/`);
  await waitFor(win, `document.querySelector('#title-screen').classList.contains('active') && !!document.querySelector('#start-new-game')`, { tries: 100, intervalMs: 50 });
  if (hubStartDouble) await installHubStartDouble(win);
}

async function main() {
  const { root, settingsDir, settingsPath, convPopupSettingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];
  const lm = await routingLmStub();
  lmServer = lm.server;

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
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await win.loadURL(`${base}/`);
  await waitFor(win, `!!document.querySelector('#routing-hub-screen')`, { tries: 100, intervalMs: 50 });

  // Show the routing hub screen by toggling .active directly — the chat corner ornaments are static CSS
  // decoration, so no routing session (or app logic) is needed to resolve their computed transform / render.
  await js(win, `(() => {
    document.querySelectorAll('.screen.active').forEach((s) => s.classList.remove('active'));
    document.querySelector('#routing-hub-screen').classList.add('active');
    return true;
  })()`);
  // Wait for the corner img to actually decode so the screenshot shows it.
  await waitFor(win, `(() => { const i = document.querySelector('.routing-hub-corner-br'); return !!i && i.complete && i.naturalWidth > 0; })()`, { tries: 120, intervalMs: 40 });
  await sleep(300);

  const cornerProbe = await js(win, `(() => {
    const norm = (t) => (!t || t === 'none' ? 'none' : t.replace(/\\s+/g, ''));
    const chatTL = document.querySelector('.routing-hub-corner-tl');
    const chatBR = document.querySelector('.routing-hub-corner-br');
    return {
      chatTLsrc: chatTL.getAttribute('src'), chatBRsrc: chatBR.getAttribute('src'),
      chatTLtransform: norm(getComputedStyle(chatTL).transform),
      chatBRtransform: norm(getComputedStyle(chatBR).transform)
    };
  })()`);
  log('corner_probe', cornerProbe);

  const parseMatrix = (t) => { const m = /^matrix\(([^)]+)\)$/.exec(t); return m ? m[1].split(',').map(Number) : null; };
  const matrixApprox = (t, expected) => { const g = parseMatrix(t); return !!g && g.length === expected.length && expected.every((v, i) => Math.abs(g[i] - v) <= 1e-4); };

  check('CORNER chat: TL is corner_01 upright — translate(-6,-8) => matrix(1,0,0,1,-6,-8) (reference orientation)',
    /corner_01\.png$/.test(cornerProbe.chatTLsrc) && matrixApprox(cornerProbe.chatTLtransform, [1, 0, 0, 1, -6, -8]),
    { chatTLsrc: cornerProbe.chatTLsrc, chatTLtransform: cornerProbe.chatTLtransform });
  check('CORNER chat: BR is corner_01 point-reflected — translate(7,9) scale(-1,-1) => matrix(-1,0,0,-1,7,9) = the 180° point reflection of the TL (FAILS on the pre-flip upright matrix(1,0,0,1,7,9))',
    /corner_01\.png$/.test(cornerProbe.chatBRsrc) && matrixApprox(cornerProbe.chatBRtransform, [-1, 0, 0, -1, 7, 9]),
    { chatBRsrc: cornerProbe.chatBRsrc, chatBRtransform: cornerProbe.chatBRtransform });

  // Screenshot the routing frame (both chat corners) for うゆりす's visual confirmation of the flipped BR.
  const shotDir = path.join(os.tmpdir(), 'routing-entry-loading-flow');
  await fs.mkdir(shotDir, { recursive: true });
  const cornersShot = path.join(shotDir, 'routing-hub-corners.png');
  try { await fs.writeFile(cornersShot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${cornersShot}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // ---- Section B: routing entry loading flow (押下→ロード画面→hub 表示), all three entries ----
  // Reload the shell on the title screen (the new-game button's home) and double ONLY /api/routing/hub/start
  // with window.fetch — delaying a canned valid hub response so the in-flight loading screen is samplable.
  // Everything else (new-game slot creation, /api/slots/load, the real screen transitions and renders) hits
  // the real server / real app.
  await freshTitleScreen(win, base);

  const openLoadScreen = async () => {
    await js(win, `document.querySelector('[data-screen="slot-load"]').click(); true`);
    await waitFor(win, `document.querySelector('#slot-load-screen').classList.contains('active')`, { tries: 120, intervalMs: 40 });
  };

  // --- Success: all three routing entries land on the hub when the opening is ready ---
  // 1) New game (origin title): the real #start-new-game button on the freshly loaded, visible title screen.
  // This also creates the slot the slot-load and resume measurements below then use through the real load
  // screen.
  await measureRoutingEntry(win, 'new-game', {
    trigger: `document.querySelector('#start-new-game').click(); true`,
    mode: 'success', afterSelector: '#routing-hub-screen', afterName: '#routing-hub-screen'
  });

  // 2) Slot load (このデータで始める): open the real load screen from the top-bar ロード tab, then click the
  // slot's load button — the exact path in the task context (ロード画面から routing hub へ飛ぶとき).
  await measureRoutingEntry(win, 'slot-load', {
    setup: async () => {
      await openLoadScreen();
      await waitFor(win, `!!document.querySelector('#slot-load-list .academy-map-action-button.primary:not([disabled])')`, { tries: 120, intervalMs: 40 });
    },
    trigger: `document.querySelector('#slot-load-list .academy-map-action-button.primary:not([disabled])').click(); true`,
    mode: 'success', afterSelector: '#routing-hub-screen', afterName: '#routing-hub-screen'
  });

  // 3) Resume (プレイに戻る): open the load screen again (play-mode → resume enabled) and click resume, which
  // takes the stored routing route (no slot reload) through the same entry wrapper.
  await measureRoutingEntry(win, 'resume', {
    setup: async () => {
      await openLoadScreen();
      await waitFor(win, `!!document.querySelector('#slot-load-resume-play:not([disabled])')`, { tries: 120, intervalMs: 40 });
    },
    trigger: `document.querySelector('#slot-load-resume-play').click(); true`,
    mode: 'success', afterSelector: '#routing-hub-screen', afterName: '#routing-hub-screen'
  });

  const successHubStartCalls = await js(win, `window.__hubStartCalls`);
  check('ENTRY: all three routing SUCCESS entries actually drove POST /api/routing/hub/start (>=3 doubled calls)', successHubStartCalls >= 3, { successHubStartCalls });

  // Screenshot the landed hub (we are on the routing hub screen after the resume success) for うゆりす's
  // visual confirmation of the entry landing.
  await sleep(200);
  const hubShot = path.join(shotDir, 'routing-entry-landed-hub.png');
  try { await fs.writeFile(hubShot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${hubShot}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // 3b) Slot load with global loop mismatch: keep the saved slot as routing, switch only the global sidecar to
  // loop, remove the hub-start double, then click the real load-screen button. This must land on the routing hub
  // through the real server path; the old global-mode hub gate leaves the screen stuck on #slot-load-screen.
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');
  await freshTitleScreen(win, base, { hubStartDouble: false });
  await restoreHubStartDouble(win);
  await openLoadScreen();
  await waitFor(win, `!!document.querySelector('#slot-load-list .academy-map-action-button.primary:not([disabled])')`, { tries: 120, intervalMs: 40 });
  await js(win, `document.querySelector('#slot-load-list .academy-map-action-button.primary:not([disabled])').click(); true`);
  const mismatchLanded = await waitFor(win, `document.querySelector('#routing-hub-screen').classList.contains('active')`, { tries: 220, intervalMs: 50 });
  const mismatchProbe = await js(win, `(() => ({
    activeScreen: document.querySelector('.screen.active')?.id ?? null,
    slotLoadActive: document.querySelector('#slot-load-screen').classList.contains('active'),
    hubActive: document.querySelector('#routing-hub-screen').classList.contains('active'),
    loadingActive: document.querySelector('#academy-loading-screen').classList.contains('active')
  }))()`);
  log('entry_slot_load_global_loop_mismatch_after', mismatchProbe);
  check('ENTRY(slot-load global-loop/routing-slot): clicking このデータで始める lands on #routing-hub-screen through the real hub-start API',
    mismatchLanded && mismatchProbe.hubActive === true && mismatchProbe.slotLoadActive === false && lm.requests.length > 0,
    { ...mismatchProbe, lmRequests: lm.requests.length });
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');

  // ---- Character-detail popup (task): the ルミ speaker name in a chat bubble opens her routing character popup
  // (一枚絵 standee + name, no ability section). We are on the hub with the 迎え bubble revealed. Clicking the
  // .message-speaker fires the delegated stream listener; only the 相手側 (ルミ) bubble carries that name element. ----
  const hubSpeakerPresent = await waitFor(win, `!!document.querySelector('#routing-hub-message-stream .message-speaker')`, { tries: 120, intervalMs: 40 });
  check('POPUP(routing): the ルミ speaker name is present in a chat bubble (the click target)', hubSpeakerPresent);
  await js(win, `document.querySelector('#routing-hub-message-stream .message-speaker').click(); true`);
  const routingPopupOpen = await waitFor(win, `!document.querySelector('#routing-hub-character-popup').hidden`, { tries: 120, intervalMs: 40 });
  const routingPopupProbe = await js(win, `(() => {
    const popup = document.querySelector('#routing-hub-character-popup');
    const title = document.querySelector('#routing-hub-character-popup-title');
    const standee = document.querySelector('#routing-hub-character-popup-standee');
    return {
      hidden: popup.hidden,
      title: title.textContent,
      standeeSrc: standee.getAttribute('src'),
      hasParameters: !!popup.querySelector('.character-parameter-section')
    };
  })()`);
  log('routing_character_popup', routingPopupProbe);
  check('POPUP(routing): clicking ルミの名前 opens her character popup with the persona name title, a standee 一枚絵, and NO ability section (routing persona has no parameters)',
    routingPopupOpen && routingPopupProbe.hidden === false
      && routingPopupProbe.title === 'ルミ'
      && !!routingPopupProbe.standeeSrc && routingPopupProbe.hasParameters === false,
    routingPopupProbe);
  // Let the standee decode + the offscreen window repaint the new popup frame so capturePage shows it (not a
  // stale frame), then capture the open popup.
  await waitFor(win, `(() => { const i = document.querySelector('#routing-hub-character-popup-standee'); return !!i && i.complete && i.naturalWidth > 0; })()`, { tries: 80, intervalMs: 40 });
  await sleep(300);
  const routingPopupShot = path.join(shotDir, 'routing-hub-character-popup.png');
  try { await fs.writeFile(routingPopupShot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${routingPopupShot}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }
  // Close via the close BUTTON specifically (class-targeted, not the shared data-attr which the backdrop also
  // carries): the popup returns to hidden.
  await js(win, `document.querySelector('#routing-hub-character-popup .routing-hub-info-popup-close').click(); true`);
  const routingPopupClosed = await waitFor(win, `document.querySelector('#routing-hub-character-popup').hidden`, { tries: 120, intervalMs: 40 });
  check('POPUP(routing): the close button dismisses the character popup (returns to hidden)', routingPopupClosed, { closed: routingPopupClosed });
  // Reopen, then close via the BACKDROP (the other required dismiss path — same [hidden]-toggle modal流儀 as the
  // info drawer).
  await js(win, `document.querySelector('#routing-hub-message-stream .message-speaker').click(); true`);
  await waitFor(win, `!document.querySelector('#routing-hub-character-popup').hidden`, { tries: 120, intervalMs: 40 });
  const routingBackdropClosed = await js(win, `(() => { document.querySelector('#routing-hub-character-popup .routing-hub-character-popup-backdrop').click(); return true; })()`)
    .then(() => waitFor(win, `document.querySelector('#routing-hub-character-popup').hidden`, { tries: 120, intervalMs: 40 }));
  check('POPUP(routing): clicking the backdrop dismisses the character popup (same modal流儀 as the info drawer)', routingBackdropClosed, { routingBackdropClosed });

  // --- Failure contract (behavioral): the loading screen is never terminal ---
  // Return to a fresh, visible title screen so each #start-new-game press below is a faithful click on the
  // active title screen. The two new-game failure entries are ordered so the first restores the title screen
  // (generic-error → origin title) and the second is then clicked from that restored title (lm-error).
  await freshTitleScreen(win, base);

  // 4) Generic hub-start failure from new game (origin title), clicked on the visible title screen: the entry
  // un-strands from the still-active loading screen back to the title screen (the origin) and rethrows —
  // never terminal on the loader. Restores the title screen for the lm-error entry below.
  await measureRoutingEntry(win, 'generic-error→title', {
    trigger: `document.querySelector('#start-new-game').click(); true`,
    mode: 'generic-error', afterSelector: '#title-screen', afterName: '#title-screen (origin)'
  });

  // 5) LM-config error (LMSTUDIO_CONFIG_REQUIRED), clicked on the title screen the previous entry restored:
  // the entry redirects to the settings screen from the loading screen (settings-redirect class), not the
  // hub and not the origin.
  await measureRoutingEntry(win, 'lm-error→settings', {
    setup: async () => {
      await waitFor(win, `document.querySelector('#title-screen').classList.contains('active')`, { tries: 120, intervalMs: 40 });
    },
    trigger: `document.querySelector('#start-new-game').click(); true`,
    mode: 'lm-error', afterSelector: '#settings-screen', afterName: '#settings-screen'
  });

  // 6) Generic hub-start failure from slot load (origin slot-load), clicked on the visible slot-load screen:
  // the entry un-strands from the loading screen back to the slot-load screen (the origin) and rethrows.
  await measureRoutingEntry(win, 'generic-error→slot-load', {
    setup: async () => {
      await openLoadScreen();
      await waitFor(win, `!!document.querySelector('#slot-load-list .academy-map-action-button.primary:not([disabled])')`, { tries: 120, intervalMs: 40 });
    },
    trigger: `document.querySelector('#slot-load-list .academy-map-action-button.primary:not([disabled])').click(); true`,
    mode: 'generic-error', afterSelector: '#slot-load-screen', afterName: '#slot-load-screen (origin)'
  });

  const failureHubStartCalls = await js(win, `window.__hubStartCalls`);
  check('ENTRY: all three routing FAILURE entries actually drove POST /api/routing/hub/start (>=3 doubled calls)', failureHubStartCalls >= 3, { failureHubStartCalls });

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { lmServer?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(exitCode);
});
