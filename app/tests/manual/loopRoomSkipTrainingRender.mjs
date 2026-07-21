// Render-backed loop-mode 自室「鍛錬をサボる」 check (Electron / real Blink + real client flow).
//
// `node --test` cannot run the browser app (no DOM/layout, listeners never attach), so the
// "clicking skip actually skips and transitions" question is verified here against the REAL client in
// real Blink. This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so
// `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/loopRoomSkipTrainingRender.mjs
//
// It boots an isolated server in LOOP mode (no play-mode.json -> loop baseline; no LM Studio), loads
// the real app, navigates to the 自室 (academy-room) via the topbar tab, then clicks the REAL
// #academy-room-skip-training button. It records (a) which API requests the click fires and (b) the
// active-screen transitions afterwards.
//
// Expected (loop): the skip button fires POST /api/academy/week/start then POST /api/training/skip
// (which returns post_content_screen='academy-map'), and openAcademyRoomSkipTraining forwards that
// screen into routeAfterCompletedAcademyTraining('academy-map') -> academy-loading -> academy-map.
//
// The bug this guards: the loop (normal-week) branch called routeAfterCompletedAcademyTraining() with
// NO argument, so post_content_screen was undefined and the route fail-fasted ("unexpected
// post_content_screen undefined"); the rejection hit .catch(reportError) (console.error) and the
// button looked like a no-op (the screen stayed on academy-room, never reaching academy-loading).
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRoot } from '../helpers.mjs';
import { createServer } from '../../src/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.SKIP_WIN_W ?? 1200);
const WIN_H = Number(process.env.SKIP_WIN_H ?? 820);
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

async function activeScreen(win) {
  return win.webContents.executeJavaScript(`document.querySelector('.screen.active')?.id ?? null`);
}

async function main() {
  // A complete game-data fixture root + baseline runtime state (normal week, elapsed_weeks=0 -> NOT the
  // graduation-ending week, so the skip handler takes the loop normal-week branch). No play-mode.json
  // and no LM Studio config -> the server resolves the loop play-mode baseline.
  const root = await fixtureRoot('loop-room-skip-render-');
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({
    root,
    activeRoot: root,
    publicRoot,
    lmStudioConfigPath: path.join(root, 'no-such-lmstudio.json'),
    playModeSettingsPath: path.join(root, 'no-such-play-mode.json')
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Confirm the server resolves loop and the skip endpoint returns post_content_screen='academy-map'
  // (server-side truth, independent of the client wiring under test).
  await fetch(`${base}/api/academy/week/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const skipProbe = await (await fetch(`${base}/api/training/skip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  log('server_skip_post_content_screen', skipProbe.post_content_screen ?? null);

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1500)); // let app.js boot (refresh(), listeners attach)

  // Instrument the page: record fetch URLs and console.error messages so we can SEE whether the click
  // fires the skip request and whether the route throws.
  await win.webContents.executeJavaScript(`(() => {
    window.__requests = [];
    const of = window.fetch;
    window.fetch = (...a) => { window.__requests.push(typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || String(a[0])); return of(...a); };
    window.__errors = [];
    const oe = console.error;
    console.error = (...a) => { window.__errors.push(a.map((x) => (x && x.message) ? x.message : String(x)).join(' ')); return oe(...a); };
    window.addEventListener('unhandledrejection', (e) => { window.__errors.push('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))); });
    return true;
  })()`);

  // Navigate to the 自室 via the REAL topbar tab (data-screen="academy-room" -> showScreen('academy-room')).
  await win.webContents.executeJavaScript(`document.querySelector('[data-screen="academy-room"]').click(); true`);
  await new Promise((r) => setTimeout(r, 600));
  const beforeScreen = await activeScreen(win);
  const skipBtn = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#academy-room-skip-training'); return b ? { present: true, disabled: !!b.disabled, text: b.textContent.trim() } : { present: false }; })()`);
  log('before_click', { screen: beforeScreen, skipButton: skipBtn });
  if (beforeScreen !== 'academy-room-screen') { log('NAV_FAILED', { note: 'could not reach 自室 before clicking skip', screen: beforeScreen }); exitCode = 2; app.quit(); return; }

  // Click the REAL "鍛錬をサボる" button.
  await win.webContents.executeJavaScript(`document.querySelector('#academy-room-skip-training').click(); true`);

  // Poll the active screen for up to ~8s, recording the distinct transition sequence.
  const sequence = [beforeScreen];
  let reachedLoading = false;
  let reachedMap = false;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const s = await activeScreen(win);
    if (s !== sequence[sequence.length - 1]) sequence.push(s);
    if (s === 'academy-loading-screen') reachedLoading = true;
    if (s === 'academy-map-screen') reachedMap = true;
    if (reachedMap) break;
  }

  const requests = await win.webContents.executeJavaScript(`window.__requests`);
  const errors = await win.webContents.executeJavaScript(`window.__errors`);
  const skipFired = requests.some((u) => u.includes('/api/training/skip'));
  const weekStartFired = requests.some((u) => u.includes('/api/academy/week/start'));
  const finalScreen = await activeScreen(win);

  log('requests_after_click', requests.filter((u) => u.includes('/api/')));
  log('skip_request_fired', skipFired);
  log('week_start_request_fired', weekStartFired);
  log('screen_sequence', sequence);
  log('final_screen', finalScreen);
  log('console_errors', errors);

  // The bug left the screen on academy-room and logged the unexpected-screen fail-fast; the fix routes
  // through academy-loading to academy-map. PASS = skip fired AND the screen left the room into the
  // loading/map route.
  const leftRoomIntoRoute = reachedLoading || reachedMap;
  const noUnexpectedScreenError = !errors.some((e) => e.includes('unexpected post_content_screen'));
  const pass = skipFired && weekStartFired && leftRoomIntoRoute && reachedMap && noUnexpectedScreenError;
  console.log(`LOOP SKIP TRANSITIONS TO ACADEMY-MAP (skip fired -> academy-loading -> academy-map, no fail-fast): ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) exitCode = 1;

  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
