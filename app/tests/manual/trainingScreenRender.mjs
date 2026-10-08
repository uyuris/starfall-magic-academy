// Render-backed academy 鍛錬 screen check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no DOM/layout, listeners never attach), so the academy training screen
// (#academy-training-screen — the 鍛錬 topbar tab's play surface) is verified here against the REAL client in
// real Blink. This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// (node --test app/tests/*.test.mjs) skips it; run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/trainingScreenRender.mjs
//
// It boots an isolated server in LOOP mode (no play-mode.json -> loop baseline; no LM Studio needed), loads the
// real app, navigates to the 鍛錬 screen via the REAL topbar tab (data-screen="academy-training"), and drives the
// real presentation + one training action against real Blink layout:
//   1. ARRIVAL: the 鍛錬 tab renders #academy-training-screen with the 鍛錬場 picture laid over the whole screen
//      (.shelf-ground = /canonical/training/background.jpg, the send-off curtain's art), the drill plates on the floor,
//      the eleven player values in one row, the remaining-count diamonds (six lit) and the weekday sigil, with the
//      plates of the weekday's element lit.
//   2. ACTION: click the first enabled drill plate -> POST /api/training/run -> one diamond goes out and the effect
//      overlay fires, all without leaving the screen (until the 6th action completes).
//
// A screenshot of the arrival is written to ${TR_SHOT_PREFIX}.png (env TR_SHOT_PREFIX, default tmp/training-shot).
// Capture before/after by running once on the base design and once on the restyle with distinct prefixes.
//
// NEGATIVE CONTROL: dropping the ground's src makes the ground check FAIL; breaking the drill wiring makes the action
// leg FAIL. The
// harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureRoot } from '../helpers.mjs';
import { createServer } from '../../src/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.TR_WIN_W ?? 1200);
const WIN_H = Number(process.env.TR_WIN_H ?? 820);
const SHOT_PREFIX = process.env.TR_SHOT_PREFIX ?? 'tmp/training-shot';

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (win, expr) => win.webContents.executeJavaScript(expr);
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

async function activeScreen(win) {
  return js(win, `document.querySelector('.screen.active')?.id ?? null`);
}

async function shoot(win, suffix) {
  const image = await win.webContents.capturePage();
  const out = path.resolve(PROJECT_ROOT, `${SHOT_PREFIX}${suffix}.png`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, image.toPNG());
  log('screenshot', out);
  return out;
}

async function main() {
  // A complete game-data fixture root + baseline runtime state. No play-mode.json and no LM Studio config ->
  // the server resolves the loop play-mode baseline (the 鍛錬 screen presentation needs no LM).
  const root = await fixtureRoot('training-screen-render-');
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

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await sleep(1500); // let app.js boot (refresh(), listeners attach, renderTrainingScreen ran)

  // Instrument fetch so we can SEE the training action request fire.
  await js(win, `(() => {
    window.__requests = [];
    const of = window.fetch;
    window.fetch = (...a) => { window.__requests.push(typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || String(a[0])); return of(...a); };
    return true;
  })()`);

  // Navigate to the 鍛錬 screen via the REAL topbar tab (data-screen="academy-training" -> showScreen).
  await js(win, `document.querySelector('[data-screen="academy-training"]').click(); true`);
  await sleep(700);
  const screen = await activeScreen(win);
  check('arrival: 鍛錬 tab activates #academy-training-screen', screen === 'academy-training-screen', { screen });
  if (screen !== 'academy-training-screen') { exitCode = 2; app.quit(); return; }

  // Presentation facts: the ground is the training-ground picture, the floor carries the drill plates, the row
  // carries the eleven values, the diamonds show six left, and the plates of the weekday's element are lit.
  const face = await js(win, `(() => {
    const ground = document.querySelector('#academy-training-screen .shelf-ground');
    const drills = [...document.querySelectorAll('#academy-training-options .academy-training-drill')];
    const dungeonHidden = (() => { const b = document.querySelector('#academy-training-open-dungeon'); if (!b) return 'MISSING'; return b.offsetParent === null; })();
    return {
      groundSrc: ground ? new URL(ground.src).pathname : '',
      groundLoaded: ground ? ground.complete && ground.naturalWidth > 0 : false,
      drillCount: drills.length,
      litElements: [...new Set(drills.filter((d) => d.dataset.today === 'true').map((d) => d.dataset.trainingElement))],
      params: document.querySelectorAll('#academy-training-player-parameters .academy-training-param').length,
      marksLeft: document.querySelectorAll('#academy-training-remaining .shelf-diamond[data-state="left"]').length,
      marksTotal: document.querySelectorAll('#academy-training-remaining .shelf-diamond').length,
      day: document.querySelector('#academy-training-day')?.getAttribute('aria-label') ?? '',
      dungeonHidden,
      // Direct-background (いきなり背景) standard: the layout has padding:0 so the picture fills it edge-to-edge.
      layoutPadding: (() => { const l = document.querySelector('.layout'); return l ? getComputedStyle(l).padding : ''; })()
    };
  })()`);
  log('face', face);
  check('face: the ground is /canonical/training/background.jpg and loaded', face.groundSrc === '/canonical/training/background.jpg' && face.groundLoaded, { src: face.groundSrc, loaded: face.groundLoaded });
  check('face: the floor carries the drill plates', face.drillCount >= 8, { drillCount: face.drillCount });
  check('face: the row carries the eleven player values', face.params === 11, { params: face.params });
  check('face: six lit remaining diamonds and the weekday sigil 光曜（光）', face.marksTotal === 6 && face.marksLeft === 6 && face.day === '光曜（光）', { marksLeft: face.marksLeft, marksTotal: face.marksTotal, day: face.day });
  check('face: only the plates of the weekday element (light) are lit', face.litElements.length === 1 && face.litElements[0] === 'light', { litElements: face.litElements });
  check('face: #academy-training-open-dungeon stays non-render (behavior unchanged)', face.dungeonHidden === true, { dungeonHidden: face.dungeonHidden });
  check('face: the training layout is edge-to-edge (layout padding:0)', face.layoutPadding === '0px', { layoutPadding: face.layoutPadding });

  await shoot(win, '');

  // ACTION leg: click the first enabled drill plate -> POST /api/training/run -> one diamond goes out.
  const beforeMarksLeft = face.marksLeft;
  await js(win, `(() => { const c = document.querySelector('#academy-training-options .academy-training-drill:not(:disabled)'); if (c) c.click(); return !!c; })()`);
  // Wait for the run request + effect overlay (effect timer is ~1s; day transition ~2s).
  let ran = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    ran = await js(win, `window.__requests.some((u) => u.includes('/api/training/run'))`);
    if (ran) break;
  }
  await sleep(1400);
  const afterMarksLeft = await js(win, `document.querySelectorAll('#academy-training-remaining .shelf-diamond[data-state="left"]').length`);
  const stillOnScreen = (await activeScreen(win)) === 'academy-training-screen';
  log('action', { ran, beforeMarksLeft, afterMarksLeft, stillOnScreen });
  check('action: drill plate fires POST /api/training/run', ran === true, { ran });
  check('action: one remaining mark goes out after the action', afterMarksLeft === beforeMarksLeft - 1, { beforeMarksLeft, afterMarksLeft });
  check('action: stays on #academy-training-screen mid-week (no premature transition)', stillOnScreen, { stillOnScreen });

  await shoot(win, '-after-action');

  const passed = results.filter((r) => r.pass).length;
  console.log(`TRAINING SCREEN RENDER: ${passed}/${results.length} checks PASS`);
  if (passed !== results.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
