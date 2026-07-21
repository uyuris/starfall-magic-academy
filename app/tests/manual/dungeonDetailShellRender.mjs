// Render-backed dungeon companion detail-shell check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM, and a companion only rolls when LM Studio is available (the enter opening is
// a real LLM call), so the companion actor-detail shell (image + 能力値 + 装備) cannot be exercised by the headless
// suite or the solo camera harness (a solo run has no companion). This file is intentionally NOT named *.test.mjs
// and lives under app/tests/manual/, so `npm test` skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/dungeonDetailShellRender.mjs
//
// It boots the server against the REAL project root (full character roster + assets), builds and commits a
// COMPANION run directly through the engine (no LLM opening needed for rendering), then drives the REAL client to
// the dungeon screen and measures, in real Blink layout:
//   - the fixed chat header is GONE (#dungeon-chat has no .dungeon-chat-head), the panel is the log over the input;
//   - the HUD companion party-card name is clickable and opens the unified actor-detail shell (#dungeon-actor-detail)
//     with the section grammar for a companion: an image slot (the scene standee), the 11 parameter meters (能力値),
//     and the read-only 装備 cards — and NO 獲得予定 section (that is the hero's);
//   - edge-to-edge (direct-background) standard: the layout is padding:0 and the obsidian screen drops the
//     floating-frame chrome (radius / drop shadow), the 6:5 map/chat ratio holds, and the camera-transformed board
//     still lays out (the refactor did not break the layout/camera);
//   - the chat log keeps a positive height (the viewport-bound internal scroll is preserved).
// The created data/mutable runtime_state.json is removed afterward (none existed before).
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.DN_WIN_W ?? 1200);
const WIN_H = Number(process.env.DN_WIN_H ?? 820);
const SEED = Number(process.env.DN_SEED ?? 2024);
const RUNTIME_STATE = path.join(PROJECT_ROOT, 'data/mutable/game_data/runtime_state.json');

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { listSelectableCharacters } = await import(path.join(PROJECT_ROOT, 'app/src/characterCatalog.mjs'));
const { companionDescriptor } = await import(path.join(PROJECT_ROOT, 'app/src/dungeon/dungeonCompanion.mjs'));
const { prepareDungeonRun, commitEnteredRun } = await import(path.join(PROJECT_ROOT, 'app/src/dungeon/dungeonEngine.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;
let createdRuntimeState = false;

async function cleanup() {
  try { server?.close(); } catch {}
  if (createdRuntimeState) {
    try { await fs.rm(RUNTIME_STATE, { force: true }); } catch {}
  }
}

async function main() {
  // No real save must be clobbered: this harness only runs when no runtime_state exists yet.
  const hadRuntimeState = await fs.access(RUNTIME_STATE).then(() => true).catch(() => false);
  if (hadRuntimeState) { log('ABORT', { reason: 'a runtime_state.json already exists; refusing to overwrite real state', path: RUNTIME_STATE }); exitCode = 2; app.quit(); return; }

  const characters = await listSelectableCharacters({ root: PROJECT_ROOT, authoringRoot: PROJECT_ROOT });
  const selected = characters[0];
  const companion = companionDescriptor(selected, `conv_render_${SEED}`);
  log('companion', { character_id: companion.character_id, name: companion.name, abilities: Object.fromEntries(Object.entries(companion.parameters.abilities).map(([k, v]) => [k, v.value])) });

  const run = await prepareDungeonRun({ root: PROJECT_ROOT, seed: SEED, companion });
  createdRuntimeState = true;
  await commitEnteredRun({ root: PROJECT_ROOT, run });

  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({ root: PROJECT_ROOT, activeRoot: PROJECT_ROOT, publicRoot, lmStudioConfigPath: path.join(PROJECT_ROOT, 'no-such-config.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  // Anchor the REAL first-open precondition: resolve once the page's boot /api/characters fetch completes
  // (refresh() -> refreshCharacters() populates selectableCharacters). We then open the dungeon exactly once and
  // await that single render — no retrying around a throw.
  let rosterLoaded = false;
  win.webContents.session.webRequest.onCompleted({ urls: [`${base}/api/characters*`] }, () => { rosterLoaded = true; });
  await win.loadURL(`${base}/`);

  // Play-surface layout invariants (the chat header removal + edge-to-edge refactor must not break camera/layout).
  const measure = () => win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('#dungeon-chat');
    const logEl = document.querySelector('#dungeon-chat-log');
    const screen = document.querySelector('.screen.active')?.id ?? null;
    const screenEl = document.querySelector('#academy-dungeon-screen');
    const gridEl = document.querySelector('#dungeon-grid');
    const board = gridEl?.querySelector('.dn-board');
    const layout = document.querySelector('.layout');
    if (!panel || !logEl || !screenEl || !gridEl) return { ok: false, screen };
    const scs = getComputedStyle(screenEl);
    const gridW = +gridEl.getBoundingClientRect().width.toFixed(1);
    const chatW = +panel.getBoundingClientRect().width.toFixed(1);
    const lr = logEl.getBoundingClientRect();
    const names = [...document.querySelectorAll('#dungeon-hud-status .dn-hud-actor-name')];
    return {
      ok: true,
      screen,
      hasChatHeader: !!document.querySelector('.dungeon-chat-head'),
      hudNameCount: names.length,
      hudNamesAreButtons: names.length > 0 && names.every((n) => n.tagName === 'BUTTON'),
      logH: +lr.height.toFixed(1),
      gridW,
      chatW,
      ratioGridToChat: (gridW && chatW) ? +(gridW / chatW).toFixed(3) : null,
      layoutPadding: layout ? getComputedStyle(layout).padding : '',
      screenRadius: scs.borderTopLeftRadius,
      screenShadow: scs.boxShadow,
      boardHasTransform: !!board && /matrix|translate/.test(board.style.transform || getComputedStyle(board).transform || '')
    };
  })()`);

  // Open the companion detail: the second HUD party-card name (0 = 主人公, 1 = companion) opens the unified shell
  // with an image (standee), 11 meters, and the 装備 cards — and NO 獲得予定 (the carry-home is the hero's).
  const measureDetail = () => win.webContents.executeJavaScript(`(() => {
    const names = [...document.querySelectorAll('#dungeon-hud-status .dn-hud-actor-name')];
    const companionBtn = names[1];
    if (!companionBtn) return { ok: false, reason: 'no companion party-card name button' };
    companionBtn.click();
    const popup = document.querySelector('#dungeon-actor-detail');
    const img = document.querySelector('#dungeon-actor-detail .actor-detail-image');
    const meters = document.querySelectorAll('#dungeon-actor-detail meter');
    const heads = [...document.querySelectorAll('#dungeon-actor-detail .actor-detail-section-head')].map((h) => h.textContent);
    const equipmentSlots = document.querySelectorAll('#dungeon-actor-detail .actor-detail-equipment-slot').length;
    return {
      ok: true,
      visible: popup ? popup.hidden === false : false,
      hasImage: !!img,
      imageShape: img ? (img.closest('.actor-detail-image-frame--standee') ? 'standee' : (img.closest('.actor-detail-image-frame--face') ? 'face' : 'none')) : 'none',
      meterCount: meters.length,
      heads,
      equipmentSlots
    };
  })()`);

  // Wait for the boot roster fetch to finish (the real precondition a user has before reaching the dungeon), then
  // open the dungeon EXACTLY ONCE and await the single render. No re-click / retry-around-failure.
  for (let i = 0; i < 100 && !rosterLoaded; i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!rosterLoaded) { log('RESULT', { pass: false, reason: 'boot /api/characters never completed' }); exitCode = 1; app.quit(); return; }
  await new Promise((r) => setTimeout(r, 200)); // let refreshCharacters() assign selectableCharacters after the fetch
  await win.webContents.executeJavaScript(`document.querySelector('#academy-training-open-dungeon').click(); true`);
  let m = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    m = await measure();
    if (m.ok && m.screen === 'academy-dungeon-screen' && m.hudNameCount >= 2) break;
  }
  log('measure', m);
  if (!m || !m.ok) { log('RESULT', { pass: false, reason: 'play surface not rendered on first open' }); exitCode = 1; app.quit(); return; }

  const detail = await measureDetail();
  log('detail', detail);

  const checks = {
    onDungeonScreen: m.screen === 'academy-dungeon-screen',
    chatHeaderGone: m.hasChatHeader === false,
    hudPartyNamesAreButtons: m.hudNameCount >= 2 && m.hudNamesAreButtons === true,
    logKeepsHeight: m.logH > 40,
    // edge-to-edge (direct-background): layout padding:0 and no frame radius / drop shadow on the obsidian screen.
    edgeToEdge: m.layoutPadding === '0px' && m.screenRadius === '0px' && m.screenShadow === 'none',
    ratio6to5Holds: m.ratioGridToChat !== null && m.ratioGridToChat >= 1.05 && m.ratioGridToChat <= 1.35,
    boardLaidOut: m.boardHasTransform === true,
    // companion detail shell: image (standee) + 11 meters + two 装備 slot cards, and NO 獲得予定 section.
    detailOpens: detail.ok && detail.visible === true,
    detailHasStandee: detail.ok && detail.hasImage === true && detail.imageShape === 'standee',
    detailElevenBars: detail.ok && detail.meterCount === 11,
    detailHasEquipmentCards: detail.ok && detail.equipmentSlots === 2,
    detailSectionGrammar: detail.ok && detail.heads.includes('能力値') && detail.heads.includes('装備') && !detail.heads.includes('獲得予定')
  };
  log('checks', checks);
  const pass = Object.values(checks).every(Boolean);
  console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => { await cleanup(); process.exit(exitCode); });
