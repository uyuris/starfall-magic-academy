// Render-backed arrival-card hover-clip check (Electron / real Blink layout).
//
// Symptom (うゆりすさん, 2026-07-09 実プレイ): on the 依頼 / 研究会 arrival screens, hovering a TOP-ROW offer card —
// which lifts (translateY(-4px)) and grows a focus ring (0 0 0 3px) — clips the card's top edge against the board's
// internal-scroll boundary. The offer boards (.academy-errand-board / .academy-study-circle-board) are
// overflow-y:auto scroll containers; overflow-y:auto forces overflow-x to auto too, so the board clips its cards on
// every edge. With only 2px board padding the 4px lift + 3px ring reached 7px above the resting box — 5px above the
// scroll clip edge — so the top row's hover was cut. (調合 is not among these: its book is an aligned table whose
// rows use a non-lifting inset-ring hover, so no hover envelope reaches the scroll edge — the workshop table grammar.)
//
// `node --test` cannot run app.js (no real layout), so this drives the REAL arrival screens in Electron and measures,
// against real Blink layout, whether the TOP-ROW card's HOVER envelope (border box + the 3px ring) stays inside the
// board's scroll clip rectangle. A hidden window ignores webContents.sendInputEvent, so the hover is driven with a
// genuine pointer via CDP Input.dispatchMouseEvent (mouseMoved) — the same technique the frame-decoration calibration
// harness uses. Run it by hand (NOT named *.test.mjs, lives under app/tests/manual/, so `npm test` skips it):
//
//   ./node_modules/.bin/electron app/tests/manual/arrivalCardHoverClipRender.mjs
//
// PASS criterion per board: with the board scrolled to top, moving the real pointer over the top-row card lifts it,
// and the lifted card's ring top (cardTop - 3) stays at or below the board clip top (not clipped). Before the padding
// fix the ring top sat ~5px above the clip edge (clipped); after it clears. A hovered screenshot per board is written
// to tmp for the visual before/after evidence. Per ref-camera the harness is fire-and-forget (no top-level await
// main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
// Fixed window size for this single-purpose clip harness (no env override — no default-value fallback).
const WIN_W = 1200;
const WIN_H = 820;
// The card hover ring (box-shadow 0 0 0 3px) renders 3px outside the border box — the top-most painted hover pixel.
const HOVER_RING_PX = 3;

// Deterministic weekly-offer generation text (依頼 / 研究会 GET generates each offer's structured record + the appeal
// chat call). Arrival-only: no conversation is started.
const OFFER_TITLE = '依頼の相談';
const OFFER_SITUATION = '作業台に、依頼に使う道具が種類ごとに並べて置かれている。';
const OFFER_MOTIVATION = '手を貸してほしいことがあり、会話の相手を探している。';
const OFFER_APPEAL = 'ねえ、少しだけいいかな。手を貸してほしいことがあって、あなたとなら落ち着いて話せそうだから声をかけたんだ。お願い、力を貸して。';
const OPENING_TEXT = 'よく来てくれました。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// Combined offer-generation stub for the 依頼 + 研究会 GETs (調合 needs none). Only the offer-record schema calls and
// the appeal chat call are exercised by rendering the three arrivals; the generic branch covers anything else.
async function startStubLm() {
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* probe */ }
    const prompt = body.messages?.[0]?.content ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'errand_offer_record') content = JSON.stringify({ title: OFFER_TITLE, situation: OFFER_SITUATION, motivation: OFFER_MOTIVATION });
    else if (schemaName === 'study_circle_offer_record') content = JSON.stringify({ title: OFFER_TITLE, situation: OFFER_SITUATION, motivation: OFFER_MOTIVATION });
    else if (prompt.includes('この依頼を自分の口から持ちかける')) content = OFFER_APPEAL; // errand appeal (当人の語り)
    else if (prompt.includes('この研究会を自分の口から持ちかける')) content = OFFER_APPEAL; // study circle appeal
    else content = OPENING_TEXT;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// Routing-mode fixture that serves all three arrivals: fixtureRoot seeds the study-circle + alchemy definitions into
// game_data (loaded from <definitionsRoot>); the errand type catalog is read from <resourceRoot>/data/definitions, so
// copy errand_types.json there (the only extra file, mirroring the errand harness).
async function routingFixture() {
  const root = await fixtureRoot('arrival-hover-clip-render-');
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
  await fs.mkdir(path.join(root, 'data/definitions'), { recursive: true });
  await fs.copyFile(path.join(PROJECT_ROOT, 'data/definitions/errand_types.json'), path.join(root, 'data/definitions/errand_types.json'));
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arrival-hover-clip-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 400, intervalMs = 120 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}
const js = (win, expr) => win.webContents.executeJavaScript(expr);

// The lifting-card offer boards this clip harness covers. 調合 is NOT among them: the alchemy book migrated to an
// aligned table with a non-lifting inset-ring row hover (the workshop grammar), so it has no hover envelope to clip
// against the scroll edge — this invariant does not apply to it.
const SCREENS = [
  { key: 'errand', label: '依頼', screen: 'academy-errand', board: '.academy-errand-board', button: '#academy-errand-offers .academy-errand-card-button' },
  { key: 'study-circle', label: '研究会', screen: 'academy-study-circle', board: '.academy-study-circle-board', button: '#academy-study-circle-offers .academy-study-circle-card-button' }
];

// Pick the top-row target card (min top; prefer an enabled one so it actually lifts), tag it, scroll the board to top,
// and return the board clip top + the target's resting geometry.
function measureScript(spec) {
  return `(() => {
    const board = document.querySelector(${JSON.stringify(spec.board)});
    board.scrollTop = 0;
    const cards = [...document.querySelectorAll(${JSON.stringify(spec.button)})];
    const rects = cards.map((c) => ({ el: c, r: c.getBoundingClientRect(), disabled: !!c.disabled }));
    const minTop = Math.min(...rects.map((x) => x.r.top));
    const topRow = rects.filter((x) => x.r.top <= minTop + 2);
    const target = topRow.find((x) => !x.disabled) || topRow[0];
    document.querySelectorAll('[data-hover-clip-target]').forEach((el) => el.removeAttribute('data-hover-clip-target'));
    target.el.setAttribute('data-hover-clip-target', '1');
    const bRect = board.getBoundingClientRect();
    const clipTop = bRect.top + parseFloat(getComputedStyle(board).borderTopWidth || '0');
    const tRect = target.el.getBoundingClientRect();
    return {
      clipTop, paddingTop: getComputedStyle(board).paddingTop, cardCount: cards.length, topRowCount: topRow.length,
      disabled: target.disabled, restTop: tRect.top, centerX: tRect.left + tRect.width / 2, centerY: tRect.top + tRect.height / 2
    };
  })()`;
}
function hoverMeasureScript(spec) {
  return `(() => {
    const board = document.querySelector(${JSON.stringify(spec.board)});
    const t = document.querySelector('[data-hover-clip-target]');
    const bRect = board.getBoundingClientRect();
    const clipTop = bRect.top + parseFloat(getComputedStyle(board).borderTopWidth || '0');
    const r = t.getBoundingClientRect();
    return { clipTop, hovTop: r.top, transform: getComputedStyle(t).transform };
  })()`;
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
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // Routing new-game once (materializes runtime state + roster so the three GETs can build this week's offers).
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const mouseMove = (x, y) => dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });

  for (const spec of SCREENS) {
    await win.loadURL(`${base}/?initialScreen=${spec.screen}`);
    const ready = await waitFor(win, `
      document.querySelector('#${spec.screen}-screen')?.classList.contains('active')
      && document.querySelectorAll(${JSON.stringify(spec.button)}).length === 3
    `, { tries: 500, intervalMs: 120 });
    if (!ready) {
      check(`${spec.label} (${spec.screen}) arrival renders three offer cards`, false, { screen: spec.screen });
      continue;
    }

    // Park the pointer off the board, measure at rest, then move a real pointer onto the top-row card to hover it.
    await mouseMove(2, 2);
    await sleep(120);
    const rest = await js(win, measureScript(spec));
    await mouseMove(Math.round(rest.centerX), Math.round(rest.centerY));
    await sleep(280); // the 160ms hover transition settles
    const hov = await js(win, hoverMeasureScript(spec));

    const lift = rest.restTop - hov.hovTop;                  // ~4 when the hover lift applied
    const bodyGap = hov.hovTop - hov.clipTop;                // >=0 → card body not clipped
    const ringGap = hov.hovTop - HOVER_RING_PX - hov.clipTop; // >=0 → 3px ring not clipped either
    const hoverApplied = lift >= 2;
    const notClipped = ringGap >= -0.5;
    log(`${spec.key}`, { paddingTop: rest.paddingTop, disabled: rest.disabled, cardCount: rest.cardCount, topRowCount: rest.topRowCount, restTop: round(rest.restTop), hovTop: round(hov.hovTop), clipTop: round(hov.clipTop), lift: round(lift), bodyGap: round(bodyGap), ringGap: round(ringGap), transform: hov.transform });

    // Screenshot the hovered state for the visual evidence.
    const shot = path.join(os.tmpdir(), `arrival-hover-clip-${spec.key}.png`);
    try { await sleep(120); await fs.writeFile(shot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${shot}`); }
    catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

    check(`${spec.label} (${spec.screen}) top-row card hover lifts and its hover envelope (card + 3px ring) is NOT clipped by the board scroll edge`,
      hoverApplied && notClipped,
      { paddingTop: rest.paddingTop, lift: round(lift), bodyGap: round(bodyGap), ringGap: round(ringGap), disabledTopCard: rest.disabled });
    await mouseMove(2, 2);
    await sleep(80);
  }

  try { dbg.detach(); } catch { /* noop */ }
  const passCount = results.filter((r) => r.pass).length;
  console.log(`\nARRIVAL CARD HOVER CLIP: ${passCount}/${results.length} checks passed`);
  if (passCount !== results.length) exitCode = 1;
  app.quit();
}

function round(n) { return Math.round(n * 100) / 100; }

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { server?.close(); } catch {}
  try { lm?.server?.close(); } catch {}
  for (const p of cleanupPaths) fs.rm(p, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
});
