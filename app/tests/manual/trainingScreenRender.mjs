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
//   1. ARRIVAL: the 鍛錬 tab renders #academy-training-screen with the framed 昼下がりの鍛錬場 stage image
//      (.academy-training-stage-image over /canonical/training/background.jpg), the corner_02 ornaments, the eight
//      compact option cards (5x4 board), the player-parameters panel, and the 鍛錬状況 result summary.
//   2. ACTION: click the first enabled option card -> POST /api/training/run -> the progress summary advances
//      (残り N / 6) and the effect overlay fires, all without leaving the screen (until the 6th action completes).
//
// A screenshot of the arrival is written to ${TR_SHOT_PREFIX}.png (env TR_SHOT_PREFIX, default tmp/training-shot).
// Capture before/after by running once on the base design and once on the restyle with distinct prefixes.
//
// NEGATIVE CONTROL (documented in the task report): reverting the stage-image markup / the token layer makes the
// stage-image + corner checks FAIL; breaking the option wiring makes the action leg FAIL. Per ref-camera the
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

  // Presentation facts: the framed stage image paints the training-ground background, the corner_02 ornaments
  // sit over it, the option board carries the eight cards, and the status panel + result summary are present.
  const face = await js(win, `(() => {
    const stage = document.querySelector('#academy-training-screen .academy-training-stage');
    const img = document.querySelector('#academy-training-screen .academy-training-stage-image');
    const cs = img ? getComputedStyle(img) : null;
    const before = stage ? getComputedStyle(stage, '::before') : null;
    const options = document.querySelectorAll('#academy-training-options .training-option-card');
    const params = document.querySelector('#academy-training-player-parameters')?.children.length ?? 0;
    const result = document.querySelector('#academy-training-result')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
    const heroVisible = (() => { const h = document.querySelector('#academy-training-screen .academy-training-hero'); return h ? getComputedStyle(h).display !== 'none' : false; })();
    const dungeonHidden = (() => { const b = document.querySelector('#academy-training-open-dungeon'); if (!b) return 'MISSING'; return b.offsetParent === null; })();
    return {
      hasStage: !!stage,
      stageImageBg: cs ? cs.backgroundImage : '',
      cornerBg: before ? before.backgroundImage : '',
      optionCount: options.length,
      paramGroups: params,
      result,
      heroVisible,
      dungeonHidden,
      // Direct-background (いきなり背景) standard: the layout has padding:0 so the flat obsidian screen fills it
      // edge-to-edge with no navy-gradient border inset.
      layoutPadding: (() => { const l = document.querySelector('.layout'); return l ? getComputedStyle(l).padding : ''; })()
    };
  })()`);
  log('face', face);
  check('face: framed stage image paints /canonical/training/background.jpg', /canonical\/training\/background\.jpg/.test(face.stageImageBg), { bg: face.stageImageBg });
  check('face: corner_02 ornament over the stage frame', /corner_02\.png/.test(face.cornerBg), { corner: face.cornerBg });
  check('face: option board carries the training cards (5x4 board)', face.optionCount >= 8, { optionCount: face.optionCount });
  check('face: player-parameters panel populated', face.paramGroups > 0, { paramGroups: face.paramGroups });
  check('face: result summary shows 訓練可能回数 / 現在の曜日', /訓練可能回数/.test(face.result) && /現在の曜日/.test(face.result), { result: face.result });
  check('face: #academy-training-open-dungeon stays non-render (behavior unchanged)', face.dungeonHidden === true, { dungeonHidden: face.dungeonHidden });
  // BACKGROUND (いきなり背景): the training layout is edge-to-edge (padding:0) so the flat obsidian screen fills it
  // with no navy-gradient border inset behind it (the frame's own padding holds the content余白).
  check('face: the training layout is edge-to-edge (layout padding:0) — no navy-gradient border inset behind the obsidian screen',
    face.layoutPadding === '0px', { layoutPadding: face.layoutPadding });

  await shoot(win, '');

  // ACTION leg: click the first enabled option card -> POST /api/training/run -> the progress summary advances.
  const beforeResult = face.result;
  await js(win, `(() => { const c = document.querySelector('#academy-training-options .training-option-card:not(:disabled)'); if (c) c.click(); return !!c; })()`);
  // Wait for the run request + effect overlay (effect timer is ~1s; day transition ~2s).
  let ran = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    ran = await js(win, `window.__requests.some((u) => u.includes('/api/training/run'))`);
    if (ran) break;
  }
  await sleep(1400);
  const afterResult = await js(win, `document.querySelector('#academy-training-result')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
  const stillOnScreen = (await activeScreen(win)) === 'academy-training-screen';
  log('action', { ran, beforeResult, afterResult, stillOnScreen });
  check('action: option card fires POST /api/training/run', ran === true, { ran });
  check('action: progress summary advances after the action', afterResult !== beforeResult, { beforeResult, afterResult });
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
