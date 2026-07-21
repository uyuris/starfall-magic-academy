// Render-backed board-scale check (Electron / real Blink layout) for board-scale-stabilize.
//
// `node --test` cannot lay out a DOM (clientWidth is 0), so the two scale questions this task fixes are
// verified here against real layout, by hand:
//
//   DUNGEON — the tile scale is content/vision-independent and large: --dn-cell equals the fixed-target
//     viewport formula (targetCells 8, band [44,72]), not the old vision-coupled value, so one window size
//     gives one readable scale.
//   ARENA — the tall layout makes the board its own left column (a large near-square viewport to the bottom,
//     not the old thin strip), and its viewport is INDEPENDENT of the right rail: flooding the rail lists
//     (action log rows / brought column) and the 決着 reflow (the dock + item regions hiding when the match
//     resolves) must NOT move the board viewport or rezoom --an-cell, so an in-flight combat trajectory keeps
//     its coordinates. Structure (board is its own column) + the per-window scale freeze both hold it; the
//     board being large near-square discriminates a broken (non-tall) layout, and the viewport-stable check
//     (viewW/viewH, not just the frozen cell) discriminates a layout that recouples the board to the rail.
//
// This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test` skips it.
// Run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/boardScaleRender.mjs
//   BS_WIN_W=1280 BS_WIN_H=860 ./node_modules/.bin/electron app/tests/manual/boardScaleRender.mjs
//
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { computeDungeonCellSize } from '../../public/dungeonCamera.js';
import { definitionsRoot, projectRoot } from '../testPaths.mjs';
import { writeDungeonMaterialsDefinition } from '../dungeonMaterialsFixture.mjs';
import { minimalValidAlchemyDefinitions } from '../alchemyFixtures.mjs';
import {
  arenaWeekSeed, assembleArenaUnits, createArenaTournamentSlot, ARENA_TOURNAMENT_STATE_KEY
} from '../../src/arena/arenaTournament.mjs';

const PROJECT_ROOT = projectRoot;
const WIN_W = Number(process.env.BS_WIN_W ?? 1200);
const WIN_H = Number(process.env.BS_WIN_H ?? 820);
// The dungeon runtime's scale contract — mirrors app.js (DN_TARGET_CELLS / DN_CELL_MIN / DN_CELL_MAX).
const DN_TARGET_CELLS = 8;
const DN_CELL_MIN = 44;
const DN_CELL_MAX = 72;

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function params(value) {
  const magic = Object.fromEntries(ELEMENTS.map((key) => [key, { value }]));
  const abilities = { strength: { value }, agility: { value }, academics: { value }, magical_power: { value }, charisma: { value } };
  return { magic, abilities };
}

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseSse(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const ev = block.split('\n').find((l) => l.startsWith('event: '));
    if (!ev) continue;
    const dl = block.split('\n').find((l) => l.startsWith('data: '));
    events.push({ event: ev.slice(7), data: dl ? JSON.parse(dl.slice(6)) : null });
  }
  return events;
}

async function economyDefinitions(root) {
  await writeDungeonMaterialsDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await fs.copyFile(
    path.join(definitionsRoot, 'gathering_points.json'),
    path.join(root, 'data/definitions/game_data/gathering_points.json')
  );
}

// Seed one visual set's scene-standee manifest + a placeholder standee, so the character catalog load resolves
// (mirrors the arena integration fixture — the roster read reads each set's manifest during the client boot).
async function seedVisualSetStandeeManifest(root, visualSetId) {
  const sourcePath = path.join(PROJECT_ROOT, 'assets/canonical/character_visual_sets', visualSetId, 'manifest.json');
  const sourceManifest = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  await writeJson(root, `assets/canonical/character_visual_sets/${visualSetId}/manifest.json`, { scene_standee: sourceManifest.scene_standee });
  const standeePath = path.join(root, 'assets/canonical/character_visual_sets', visualSetId, sourceManifest.scene_standee.path);
  await fs.mkdir(path.dirname(standeePath), { recursive: true });
  await fs.writeFile(standeePath, 'standee');
}

// The baseline game data the client boot refresh reads (locations, creature encounters, the character roster +
// its visual set manifests, a seed runtime_state the routing read layers under the slot). Copied/seeded from the
// repo so the boot settles cleanly and applyInitialScreenOverride reaches the arena/dungeon screen.
async function baselineGameData(root) {
  await fs.copyFile(path.join(definitionsRoot, 'locations.json'), path.join(root, 'data/definitions/game_data/locations.json'));
  await fs.copyFile(path.join(definitionsRoot, 'creature_encounters.json'), path.join(root, 'data/definitions/game_data/creature_encounters.json'));
  await fs.cp(path.join(PROJECT_ROOT, 'content/characters'), path.join(root, 'content/characters'), { recursive: true });
  for (let index = 1; index <= 172; index += 1) {
    await seedVisualSetStandeeManifest(root, `visual_set_${String(index).padStart(3, '0')}`);
  }
  await writeJson(root, 'data/seeds/game_data/runtime_state.json', {
    version: 1, elapsed_weeks: 3, current_location_id: 'herbology_garden', current_screen: 'interaction', global_flags: {}, characters: {}
  });
}

// ---- dungeon fixture (a minimal solo run root) ----
async function dungeonRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-dn-'));
  await economyDefinitions(root);
  await baselineGameData(root);
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: { light: { value: 12 }, dark: { value: 10 }, fire: { value: 14 }, water: { value: 8 }, earth: { value: 11 }, wind: { value: 9 } },
    abilities: { strength: { value: 28 }, agility: { value: 30 }, academics: { value: 26 }, magical_power: { value: 24 }, charisma: { value: 22 } }
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  return root;
}

// ---- arena fixture: an active routing SAVE SLOT carrying an injected solo tournament (no roster needed) ----
// /api/arena/* is routing-only AND reads the mutable state inside an active routing read scope, which the server
// only enters for an active routing save slot — so the tournament slot lives in the slot's runtime_state, behind
// an active_slot pointer + a routing meta.
async function arenaRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-arena-'));
  await economyDefinitions(root);
  await baselineGameData(root);
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  const slotId = 'slot_001';
  const slotBase = `data/mutable/game_data/play/slots/${slotId}`;
  await writeJson(root, 'data/mutable/game_data/play/active_slot.json', { slot_id: slotId });
  await writeJson(root, `${slotBase}/meta.json`, {
    slot_id: slotId, label: 'arena', created_at: '2026-07-10T06:00:00.000+09:00', updated_at: '2026-07-10T06:00:00.000+09:00',
    player_note: '', current_location_id: 'herbology_garden', current_screen: 'interaction',
    graduation_completed: false, play_mode: 'routing', routing_persona_variant: 'fallen_star'
  });
  await writeJson(root, `${slotBase}/game_data/player_inventory.json`, {
    money: 1000, items: [], applied_money_delta_conversation_ids: []
  });
  await writeJson(root, `${slotBase}/game_data/runtime/player_parameters.json`, params(20));
  const week = 3;
  const protagonist = { parameters: params(20), equipment: null, mp_reserve_percent: 30 };
  const opponents = Array.from({ length: 15 }, (_, i) => {
    const id = `character_${String(i + 1).padStart(3, '0')}`;
    return { character_id: id, display_name: `opp-${id}`, parameters: params(5), mp_reserve_percent: 30 };
  });
  const { playerUnit, opponentUnits } = assembleArenaUnits({ mode: 'solo', protagonist, buddy: null, opponents });
  const slot = createArenaTournamentSlot({ seed: arenaWeekSeed(week), week, mode: 'solo', playerUnit, opponentUnits });
  await writeJson(root, `${slotBase}/game_data/runtime_state.json`, {
    version: 1, elapsed_weeks: week, current_location_id: 'herbology_garden', current_screen: 'interaction',
    ending_completed: false, current_buddy_character_id: null, current_enemy_character_ids: [],
    global_flags: {}, characters: {}, [ARENA_TOURNAMENT_STATE_KEY]: slot
  });
  const playModeSettingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(playModeSettingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, playModeSettingsPath };
}

async function boot(root, extra = {}) {
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  const server = createServer({ root, activeRoot: root, publicRoot, lmStudioConfigPath: path.join(root, 'no-such-config.json'), ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function poll(win, expr, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (await win.webContents.executeJavaScript(expr)) return true;
    await sleep(120);
  }
  return false;
}

let servers = [];
let exitCode = 0;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

async function runDungeon() {
  const { server, base } = await boot(await dungeonRoot());
  servers.push(server);
  const resp = await fetch(`${base}/api/dungeon/enter`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: 2024, with_companion: false })
  });
  const events = parseSse(await resp.text());
  const enter = events.find((e) => e.event === 'dungeon_enter')?.data ?? null;
  if (!enter) { log('DN_NO_VIEW', { events: events.map((e) => e.event), error: events.find((e) => e.event === 'error')?.data }); exitCode = 2; return; }
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, _l, msg) => { if (/error|Error/.test(msg)) console.log('DN_PAGE:', msg); });
  await win.loadURL(`${base}/`);
  await sleep(1200);
  await win.webContents.executeJavaScript(`document.querySelector('#academy-training-open-dungeon').click(); true`);
  const ready = await poll(win, `(() => { const b = document.querySelector('#dungeon-grid .dn-board'); return !!b && /translate\\(/.test(b.style.transform || ''); })()`);
  if (!ready) { log('DN_LAYOUT_TIMEOUT', {}); exitCode = 2; win.destroy(); return; }
  await sleep(400);
  const m = await win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('#dungeon-grid');
    const vp = grid.querySelector('.dn-viewport');
    const r = vp.getBoundingClientRect();
    return { cell: parseFloat(getComputedStyle(grid).getPropertyValue('--dn-cell')), gap: parseFloat(getComputedStyle(grid).getPropertyValue('--dn-gap')), viewW: +r.width.toFixed(1), viewH: +r.height.toFixed(1) };
  })()`);
  const expected = computeDungeonCellSize({ viewW: m.viewW, viewH: m.viewH, gap: m.gap, targetCells: DN_TARGET_CELLS, cellMin: DN_CELL_MIN, cellMax: DN_CELL_MAX });
  log('dungeon', { ...m, expected });
  const matches = Math.abs(m.cell - expected) < 0.6;
  const readable = m.cell >= DN_CELL_MIN;
  console.log(`DUNGEON CELL IS THE FIXED-TARGET VIEWPORT SCALE (not vision-coupled): ${matches ? 'PASS' : 'FAIL'} (cell=${m.cell} expected=${expected.toFixed(1)})`);
  console.log(`DUNGEON CELL IS READABLE (>= ${DN_CELL_MIN}px floor): ${readable ? 'PASS' : 'FAIL'} (cell=${m.cell})`);
  if (!matches || !readable) exitCode = 1;
  // Tall-layout camera invariant: in the two-column play body the board viewport must NOT depend on the
  // right rail's content. Flood every right-rail list (chat log, materials column, action log) and let the
  // grid ResizeObserver settle; the board viewport (and so --dn-cell) must stay put. The chat / item / log
  // lists scroll internally inside fixed-height sections, so the rail height — and the map column — hold.
  await win.webContents.executeJavaScript(`(() => {
    const push = (sel, n, cls) => { const host = document.querySelector(sel); for (let i = 0; i < n; i += 1) { const p = document.createElement('p'); if (cls) p.className = cls; p.textContent = 'flood row ' + i; host.appendChild(p); } };
    push('#dungeon-chat-log', 40, 'chat-message');
    push('#dungeon-materials-list', 40, 'dungeon-item-row');
    push('#dungeon-log', 60, '');
    return true;
  })()`);
  await sleep(600); // let any ResizeObserver firing settle
  const m2 = await win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('#dungeon-grid');
    const vp = grid.querySelector('.dn-viewport');
    const r = vp.getBoundingClientRect();
    return { cell: parseFloat(getComputedStyle(grid).getPropertyValue('--dn-cell')), viewW: +r.width.toFixed(1), viewH: +r.height.toFixed(1) };
  })()`);
  log('dungeon_after_rail_flood', m2);
  const viewportStable = Math.abs(m2.viewW - m.viewW) < 0.6 && Math.abs(m2.viewH - m.viewH) < 0.6;
  const cellStable = Math.abs(m2.cell - m.cell) < 0.6;
  console.log(`DUNGEON BOARD VIEWPORT IS INDEPENDENT OF RIGHT-RAIL CONTENT (chat/items/log flood): ${viewportStable && cellStable ? 'PASS' : 'FAIL'} (viewW ${m.viewW}->${m2.viewW}, viewH ${m.viewH}->${m2.viewH}, cell ${m.cell}->${m2.cell})`);
  if (!viewportStable || !cellStable) exitCode = 1;
  win.destroy();
}

async function runArena() {
  const { root, playModeSettingsPath } = await arenaRoot();
  const { server, base } = await boot(root, { playModeSettingsPath });
  servers.push(server);
  // Load the slot through the real flow so the routing read staging is populated from the slot's runtime_state
  // (which carries the injected tournament); a direct file write is not visible to the routing read otherwise.
  const loaded = await fetch(`${base}/api/slots/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slot_id: 'slot_001' }) });
  log('arena_slot_load', { status: loaded.status });
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, _l, msg) => { if (/error|Error|fail/i.test(msg)) console.log('ARENA_PAGE:', msg); });
  await win.loadURL(`${base}/?initialScreen=academy-arena`);
  await sleep(1400);
  // The bracket renders from the injected slot; click 試合開始 to reach the interactive match surface.
  const bracket = await poll(win, `!document.querySelector('#arena-bracket').hidden`);
  if (!bracket) {
    const diag = await win.webContents.executeJavaScript(`(() => ({ active: document.querySelector('.screen.active')?.id ?? null, arenaActive: document.querySelector('#academy-arena-screen')?.classList.contains('active'), selHidden: document.querySelector('#arena-selection')?.hidden, brkHidden: document.querySelector('#arena-bracket')?.hidden, selStatus: document.querySelector('#arena-selection-status')?.textContent, brkStatus: document.querySelector('#arena-bracket-status')?.textContent }))()`);
    log('ARENA_BRACKET_TIMEOUT', diag); exitCode = 2; win.destroy(); return;
  }
  await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('#arena-bracket-actions .arena-action-button')].find((n) => n.textContent.includes('試合開始')); if (b) b.click(); return !!b; })()`);
  const laid = await poll(win, `(() => { const m = document.querySelector('#arena-match'); if (m.hidden) return false; const c = parseFloat(getComputedStyle(document.querySelector('#arena-grid')).getPropertyValue('--an-cell')); const items = document.querySelector('#arena-items'); return c > 0 && !items.hidden; })()`);
  if (!laid) { log('ARENA_MATCH_TIMEOUT', {}); exitCode = 2; win.destroy(); return; }
  await sleep(400);
  const measure = () => win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('#arena-grid');
    const vp = grid.querySelector('.an-viewport');
    const r = vp.getBoundingClientRect();
    return { cell: parseFloat(getComputedStyle(grid).getPropertyValue('--an-cell')), gap: parseFloat(getComputedStyle(grid).getPropertyValue('--an-gap')), viewW: +r.width.toFixed(1), viewH: +r.height.toFixed(1) };
  })()`);
  const before = await measure();
  log('arena_interactive', before);
  // The tall layout: the board is its own left column — a large near-square viewport to the bottom, not the old
  // thin wide strip (which floored --an-cell at ~8 on a ~95px-tall band). A broken (non-tall) layout fails here.
  const readable = before.cell >= 24;
  const nearSquare = before.viewH >= before.viewW * 0.6;
  console.log(`ARENA BOARD IS A LARGE NEAR-SQUARE COLUMN (tall layout, not the old strip): ${readable && nearSquare ? 'PASS' : 'FAIL'} (cell=${before.cell}, viewW=${before.viewW}, viewH=${before.viewH})`);
  if (!readable || !nearSquare) exitCode = 1;
  // Independence #1 — right-rail CONTENT: flood the action log + brought column (the rail's variable lists) while
  // still interactive. The lists scroll inside their fixed-height / min-height:0 sections, so the rail height —
  // and thus the board column — must hold. The viewport (not just the frozen cell) staying put is the structural
  // proof the board no longer shares a stacked column with the rail.
  await win.webContents.executeJavaScript(`(() => {
    const push = (sel, n) => { const host = document.querySelector(sel); for (let i = 0; i < n; i += 1) { const p = document.createElement('p'); p.textContent = 'flood row ' + i; host.appendChild(p); } };
    push('#arena-log', 80);
    push('#arena-consumables-list', 40);
    return true;
  })()`);
  await sleep(600); // let any ResizeObserver firing settle
  const afterFlood = await measure();
  log('arena_after_rail_flood', afterFlood);
  const floodStable = Math.abs(afterFlood.viewW - before.viewW) < 0.6 && Math.abs(afterFlood.viewH - before.viewH) < 0.6 && Math.abs(afterFlood.cell - before.cell) < 0.6;
  console.log(`ARENA BOARD VIEWPORT IS INDEPENDENT OF RIGHT-RAIL CONTENT (log/item flood): ${floodStable ? 'PASS' : 'FAIL'} (viewW ${before.viewW}->${afterFlood.viewW}, viewH ${before.viewH}->${afterFlood.viewH}, cell ${before.cell}->${afterFlood.cell})`);
  if (!floodStable) exitCode = 1;
  // Independence #2 — the 決着 REFLOW: renderArenaMatch hides the dock + item regions and reveals the replay
  // controls when the match resolves. In the tall layout those all live in the right rail, so the board column
  // must not move — the combat trajectory drawn at 決着 keeps its start/end coordinates.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#arena-items').hidden = true;
    document.querySelector('#arena-dock-main').hidden = true;
    document.querySelector('#arena-replay-controls').hidden = false;
    return true;
  })()`);
  await sleep(600); // let the ResizeObserver fire against the reflowed rail
  const after = await measure();
  log('arena_concluded_layout', after);
  const viewportStable = Math.abs(after.viewW - before.viewW) < 0.6 && Math.abs(after.viewH - before.viewH) < 0.6;
  const cellFrozen = Math.abs(after.cell - before.cell) < 0.6;
  console.log(`ARENA BOARD VIEWPORT IS UNCHANGED ACROSS 決着 (dock/item hide, replay show — trajectory-safe): ${viewportStable && cellFrozen ? 'PASS' : 'FAIL'} (viewW ${before.viewW}->${after.viewW}, viewH ${before.viewH}->${after.viewH}, cell ${before.cell}->${after.cell})`);
  if (!viewportStable || !cellFrozen) exitCode = 1;
  win.destroy();
}

async function main() {
  await app.whenReady();
  await runDungeon();
  await runArena();
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { for (const s of servers) { try { s.close(); } catch {} } process.exit(exitCode); });
