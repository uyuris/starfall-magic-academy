// Render-backed screen-BGM playback check (Electron / real Blink Web Audio).
//
// `node --test` cannot construct an AudioContext, decode real Ogg Opus, or run the showScreen/overlay seam against
// real layout, so the BGM controller is verified here against the REAL client in Electron. This file is NOT named
// *.test.mjs and lives under app/tests/manual/, so `npm test` skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/bgmPlaybackRender.mjs
//
// Instrumentation (a preload, contextIsolation:false, runs BEFORE app.js boots): wraps window.fetch to record every
// /canonical/bgm/*.ogg request, counts AudioBufferSourceNode start()/stop(), captures the single AudioContext
// instance, and records uncaught window errors. The controller lives in a module closure (app.js is a
// type=module), so transitions are driven through the REAL UI — the [data-screen] top-bar buttons call the real
// showScreen(), and start-new-game drives the real routing entry (its LM-dependent hub-start is doubled, exactly
// like titleLoadingNightRender.mjs). Per ref-camera, the harness is fire-and-forget (no top-level await main()).
//
// Checks:
//   A. Electron autoplay: the AudioContext is 'running' with no user gesture and the boot title screen fetched
//      v4-title and started a source (Electron's default no-user-gesture-required policy is not broken).
//   B. Silence on an unmapped (debug) screen: no BGM is fetched, and the playing source is stopped (→ 無音).
//   C. Track switch + same-screen no-op: re-showing the SAME screen fetches nothing and starts no new source
//      (never restarts); a genuine screen change fetches + starts the new track.
//   D. Routing entry title→loading→hub: v5-loading then v1-moonlit are fetched as the screens switch.
//   E. 星の揺り籠 overlay override: opening the garden fetches v6-cradle (overlay override, not a screen).
//   F. Unknown screen id: driving showScreen with an unknown id throws (surfaced as an uncaught error).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const INSTRUMENT_PRELOAD = path.join(PROJECT_ROOT, 'app/tests/manual/bgmInstrumentPreload.cjs');

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
  const root = await fixtureRoot('bgm-playback-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-playback-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const convPopupSettingsPath = path.join(settingsDir, 'conversation-popup.json');
  return { root, settingsDir, settingsPath, convPopupSettingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
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
const bgmState = (win) => js(win, 'JSON.stringify({ fetches: window.__bgm.fetches, starts: window.__bgm.starts, stops: window.__bgm.stops, ctxState: window.__bgm.ctx ? window.__bgm.ctx.state : null, errors: window.__bgm.errors })').then(JSON.parse);
const countTrack = (fetches, trackId) => fetches.filter((u) => u === `/canonical/bgm/${trackId}.ogg`).length;

// Click a top-bar [data-screen] button (the real showScreen seam) and let the decode/crossfade settle.
async function clickScreenTab(win, screen) {
  await js(win, `document.querySelector('[data-screen="${screen}"]').click(); true`);
  await sleep(700);
}

async function installHubStartDouble(win) {
  await js(win, `(() => {
    const realFetch = window.fetch.bind(window);
    const canned = {
      conversation: { id: 'harness_hub_conv', routing_hub: true, character_id: 'lina', character_name: 'ルミ', messages: [{ role: 'assistant', content: 'こんばんは。' }] },
      routing_persona_visual: {
        character_id: 'lina', display_name: 'ルミ', visual_set_id: 'routing_lumi_fallen_star',
        face_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        selection_icon_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
        standee_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/scene_standee/scene_standee_character_01.jpg'
      },
      state: { elapsed_weeks: 0 }
    };
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/routing/hub/start')) {
        return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(canned), { status: 200, headers: { 'content-type': 'application/json' } })), 300));
      }
      return realFetch(input, init);
    };
    return true;
  })()`);
}

async function main() {
  const { root, settingsDir, settingsPath, convPopupSettingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    conversationPopupSettingsPath: convPopupSettingsPath,
    lmStudioConfig: { base_url: 'http://127.0.0.1:0/v1', chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base });

  // Watchdog: never hang the harness — force a failed exit if the whole run does not finish in time.
  const watchdog = setTimeout(() => { console.log('WATCHDOG: harness exceeded time budget'); exitCode = 2; app.quit(); }, 100000);
  watchdog.unref?.();

  await app.whenReady();
  console.log('step: app ready');
  const win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { preload: INSTRUMENT_PRELOAD, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // ---- Boot title ----
  await win.loadURL(`${base}/`);
  console.log('step: loaded /');
  const titleActive = await waitFor(win, `document.querySelector('#title-screen').classList.contains('active') && !!document.querySelector('#start-new-game')`, { tries: 120, intervalMs: 50 });
  console.log(`step: title active = ${titleActive}`);
  await sleep(900); // let the boot title BGM fetch + decode + start
  const boot = await bgmState(win);
  log('A_boot', boot);
  check('A. Electron autoplay: AudioContext is running with no user gesture and the boot title fetched v4-title and started a source',
    boot.ctxState === 'running' && countTrack(boot.fetches, 'v4-title') >= 1 && boot.starts >= 1,
    { ctxState: boot.ctxState, v4: countTrack(boot.fetches, 'v4-title'), starts: boot.starts });

  // ---- B. Silence on an unmapped screen (debug) ----
  const beforeDebug = await bgmState(win);
  await clickScreenTab(win, 'debug'); // showScreen('debug') → not in the map → silence
  const afterDebugFetch = await bgmState(win);
  await sleep(1300); // > BGM_TEARDOWN_DELAY_MS: the faded-out source is stopped
  const afterDebugStop = await bgmState(win);
  log('B_debug', { beforeFetches: beforeDebug.fetches.length, afterFetches: afterDebugFetch.fetches.length, stopsBefore: beforeDebug.stops, stopsAfter: afterDebugStop.stops });
  check('B. debug (unmapped) is silent: no BGM is fetched for it and the playing source is stopped (→ 無音, previous track does not drag on)',
    afterDebugFetch.fetches.length === beforeDebug.fetches.length && afterDebugStop.stops > beforeDebug.stops,
    { fetchDelta: afterDebugFetch.fetches.length - beforeDebug.fetches.length, stopsDelta: afterDebugStop.stops - beforeDebug.stops });

  // ---- C. Switch back to a track, then same-screen no-op ----
  const beforeTitle = await bgmState(win);
  await clickScreenTab(win, 'title'); // silence → v4-title (real switch)
  const afterTitle1 = await bgmState(win);
  await clickScreenTab(win, 'title'); // same screen again → no-op (no restart)
  const afterTitle2 = await bgmState(win);
  log('C_title', { v4Before: countTrack(beforeTitle.fetches, 'v4-title'), v4After1: countTrack(afterTitle1.fetches, 'v4-title'), v4After2: countTrack(afterTitle2.fetches, 'v4-title'), starts1: afterTitle1.starts, starts2: afterTitle2.starts });
  const switchedBack = countTrack(afterTitle1.fetches, 'v4-title') === countTrack(beforeTitle.fetches, 'v4-title') + 1 && afterTitle1.starts === beforeTitle.starts + 1;
  const sameScreenNoop = countTrack(afterTitle2.fetches, 'v4-title') === countTrack(afterTitle1.fetches, 'v4-title') && afterTitle2.starts === afterTitle1.starts;
  check('C. a genuine screen change fetches + starts the track, and re-showing the SAME screen fetches nothing and starts no new source (never restarts)',
    switchedBack && sameScreenNoop,
    { switchedBack, sameScreenNoop });

  // ---- D. Routing entry title→loading→hub (fresh document so the boot state is clean) ----
  await win.loadURL(`${base}/`);
  await waitFor(win, `document.querySelector('#title-screen').classList.contains('active') && !!document.querySelector('#start-new-game')`, { tries: 120, intervalMs: 50 });
  await sleep(400);
  await installHubStartDouble(win);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  const reachedHub = await waitFor(win, `document.querySelector('#routing-hub-screen').classList.contains('active')`, { tries: 200, intervalMs: 50 });
  await sleep(900);
  const hub = await bgmState(win);
  log('D_hub', { reachedHub, fetches: hub.fetches });
  check('D. the title→loading→routing-hub entry switches tracks: v5-loading and v1-moonlit are both fetched',
    reachedHub && countTrack(hub.fetches, 'v5-loading') >= 1 && countTrack(hub.fetches, 'v1-moonlit') >= 1,
    { v5: countTrack(hub.fetches, 'v5-loading'), v1: countTrack(hub.fetches, 'v1-moonlit') });

  // ---- E. 星の揺り籠 overlay override → v6-cradle ----
  const beforeCradle = await bgmState(win);
  await js(win, `document.querySelector('#routing-hub-cradle-globe').click(); true`);
  await sleep(800);
  const afterCradle = await bgmState(win);
  log('E_cradle', { v6Before: countTrack(beforeCradle.fetches, 'v6-cradle'), v6After: countTrack(afterCradle.fetches, 'v6-cradle') });
  check('E. opening the 星の揺り籠 overlay overrides to v6-cradle (fetched), while the hub screen is unchanged',
    countTrack(afterCradle.fetches, 'v6-cradle') >= 1,
    { v6: countTrack(afterCradle.fetches, 'v6-cradle') });

  // ---- F. Unknown screen id throws (drive showScreen through a tab whose data-screen is an unknown id) ----
  await js(win, `(() => { const t = document.querySelector('[data-screen="world"]'); t.dataset.screen = '__bgm_unknown_screen__'; t.click(); return true; })()`);
  await sleep(200);
  const afterUnknown = await bgmState(win);
  const threwUnknown = afterUnknown.errors.some((e) => e.includes('unknown screen id'));
  log('F_unknown', { errors: afterUnknown.errors });
  check('F. driving showScreen with an unknown screen id throws (surfaced as an uncaught "unknown screen id" error)',
    threwUnknown,
    { threwUnknown, errors: afterUnknown.errors });

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(exitCode);
});
