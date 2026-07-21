// Render-backed dungeon DEFEAT-result check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM (getComputedStyle/getBoundingClientRect are empty), so the
// "defeat result is a modal popup floated over the still-visible board" behavior is verified here,
// against real layout, rather than in the headless suite. This file is intentionally NOT named
// *.test.mjs and lives under app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs)
// skips it; run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/dungeonDefeatResultRender.mjs
//   DN_SEED=4242 DN_SHOT=/tmp/defeat.png ./node_modules/.bin/electron app/tests/manual/dungeonDefeatResultRender.mjs
//
// It boots an isolated server on a FULL game-data fixture (so the client's boot roster load succeeds and
// the board actually renders), overrides the player parameters to the minimum (fragile HP), commits a
// solo run (no LLM), drives the REAL client enter path, then just WAITS turn after turn. Enemies pursue
// the player globally each turn (dungeonEngine stepToward toward the nearest of player/companion), so a
// fragile solo player is worn down and killed within a bounded, deterministic number of waits for a fixed
// seed — a genuine end-of-run defeat through the real /api/dungeon/action endpoint.
//
// At the fatal turn the harness measures, in real Blink layout:
//   - DEFEAT POPUP OVER BOARD: #dungeon-play stays visible (NOT hidden) while #dungeon-result-popup
//     shows over it (画面遷移しない).
//   - POPUP CONTENT: the popup body carries the 力尽きました heading + floor line.
//   - RETURN UNCHANGED: after the hold the run auto-advances off the dungeon screen to academy-room
//     (the loop return), so defeat changed only the presentation, not the return/finalize path.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const SEED = Number(process.env.DN_SEED ?? 4242);
const WIN_W = Number(process.env.DN_WIN_W ?? 1200);
const WIN_H = Number(process.env.DN_WIN_H ?? 820);
const SHOT = process.env.DN_SHOT ?? null; // optional screenshot path for the defeat popup over the board

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

// Solo loop-mode start: no companion buddy, so the committed run is a synchronous solo run whose death
// ends the run in one step (no deferred companion finalize).
const RUNTIME_STATE = {
  version: 1,
  current_location_id: 'herbology_garden',
  time_slot: 'after_school',
  current_screen: 'academy-map',
  current_interaction_character_id: null,
  global_flags: {},
  visited_locations: ['herbology_garden'],
  active_character_ids: ['lina'],
  last_conversation_id: null,
  current_buddy_character_id: null,
  current_enemy_character_ids: [],
  characters: { lina: { flags: {} } },
  pending_interaction_context: null
};

// Minimal abilities: max_hp = 32 + round(strength*0.7 + power*0.3) floors near its base and defense
// = 2 + round(...) bottoms out, so enemy strikes wear the player down fast — a quick, deterministic death.
function minimalParameters() {
  return {
    magic: { light: { value: 1 }, dark: { value: 1 }, fire: { value: 1 }, water: { value: 1 }, earth: { value: 1 }, wind: { value: 1 } },
    abilities: { strength: { value: 1 }, agility: { value: 1 }, academics: { value: 1 }, magical_power: { value: 1 }, charisma: { value: 1 } }
  };
}

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function defeatFixture() {
  const root = await fixtureRoot('dn-defeat-render-', { runtimeState: RUNTIME_STATE });
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
  await writeJson(root, 'game_data/runtime/player_parameters.json', minimalParameters());
  return root;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

// The live visibility/text state of the dungeon end surfaces, read from real computed layout.
function measureScript() {
  return `(() => {
    const disp = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'absent';
      return getComputedStyle(el).display;
    };
    const popupBody = document.querySelector('#dungeon-result-popup-body');
    const popup = document.querySelector('#dungeon-result-popup');
    const labelledby = popup?.getAttribute('aria-labelledby') ?? null;
    return {
      screen: document.querySelector('.screen.active')?.id ?? null,
      playDisplay: disp('#dungeon-play'),
      popupDisplay: disp('#dungeon-result-popup'),
      popupText: popupBody ? popupBody.textContent.trim() : null,
      // The dialog's accessible name must resolve: aria-labelledby points at an element that exists and
      // carries the heading text (the defeat popup's dynamic heading gets that id).
      accessibleNameResolves: !!(labelledby && document.getElementById(labelledby) && document.getElementById(labelledby).textContent.trim())
    };
  })()`;
}

async function main() {
  const root = await defeatFixture();
  server = createServer({ root, publicRoot: PUBLIC_ROOT, canonicalAssetsRoot: REPO_CANONICAL, lmStudioConfigPath: path.join(root, 'no-such-config.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Commit an active solo run server-side with the fixed seed.
  const resp = await fetch(`${base}/api/dungeon/enter`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: SEED, with_companion: false })
  });
  const events = parseSse(await resp.text());
  const enter = events.find((e) => e.event === 'dungeon_enter')?.data ?? null;
  if (!enter) { log('NO_VIEW', { events: events.map((e) => e.event), error: events.find((e) => e.event === 'error')?.data }); exitCode = 2; app.quit(); return; }
  const v = enter.view;
  log('view', { player: v.player, floor: v.floor, enemies: (v.enemies ?? []).length });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });
  await win.loadURL(`${base}/`);
  await sleep(1600); // let app.js boot (refresh(), roster load, listeners attached)

  // Drive the REAL client path: the click handler runs showScreen('academy-dungeon'), which loads the
  // active run and lays the board out (renderDungeonPlay -> renderDungeonGrid).
  await win.webContents.executeJavaScript(`document.querySelector('#academy-training-open-dungeon').click(); true`);
  const waitForBoard = async () => {
    for (let i = 0; i < 60; i += 1) {
      const ready = await win.webContents.executeJavaScript(`(() => {
        const board = document.querySelector('#dungeon-grid .dn-board');
        return !!board && /translate\\(/.test(board.style.transform || '');
      })()`);
      if (ready) return true;
      await sleep(100);
    }
    return false;
  };
  if (!(await waitForBoard())) {
    const diag = await win.webContents.executeJavaScript(measureScript());
    log('LAYOUT_TIMEOUT', diag);
    exitCode = 2; app.quit(); return;
  }
  await sleep(400);

  const before = await win.webContents.executeJavaScript(measureScript());
  log('before_defeat', before);
  const boardBefore = before.playDisplay !== 'none' && before.playDisplay !== 'absent' && before.popupDisplay === 'none';
  console.log(`PRE-DEFEAT BOARD SHOWN, POPUP HIDDEN: ${boardBefore ? 'PASS' : 'FAIL'}`);
  if (!boardBefore) exitCode = 1;

  // Wait turn after turn (Space). Extra Space presses while an action is in flight are ignored by the
  // client (dungeonActionInFlight), so a steady poll cadence is safe. Break the moment the defeat popup
  // appears (its ~520ms fatal-blow animation, then a ~1600ms hold, is a wide window to catch).
  let defeat = null;
  for (let i = 0; i < 400; i += 1) {
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); true`);
    await sleep(120);
    const s = await win.webContents.executeJavaScript(measureScript());
    if (s.popupDisplay !== 'none' && s.popupDisplay !== 'absent') { defeat = s; break; }
    if (s.screen !== 'academy-dungeon-screen') { defeat = s; break; } // advanced away without us catching the popup
  }
  log('at_defeat', defeat);

  if (!defeat || defeat.popupDisplay === 'none' || defeat.popupDisplay === 'absent') {
    console.log(`DEFEAT POPUP SHOWN: FAIL (run did not surface the defeat popup in 400 waits; try another DN_SEED)`);
    exitCode = 1;
    app.quit();
    return;
  }

  // The defeat popup floats OVER the board: the play surface is still displayed and the popup carries the
  // 力尽きました result content.
  const overBoard = defeat.playDisplay !== 'none' && defeat.playDisplay !== 'absent';
  const hasContent = typeof defeat.popupText === 'string' && defeat.popupText.includes('力尽きました') && /到達 \d+ \/ \d+ 階/.test(defeat.popupText);
  console.log(`DEFEAT POPUP OVER STILL-VISIBLE BOARD (no screen transition): ${overBoard ? 'PASS' : 'FAIL'} (play=${defeat.playDisplay})`);
  console.log(`DEFEAT POPUP SHOWS THE RESULT CONTENT: ${hasContent ? 'PASS' : 'FAIL'} (text=${JSON.stringify(defeat.popupText)})`);
  console.log(`DEFEAT POPUP ACCESSIBLE NAME RESOLVES (aria-labelledby -> rendered heading): ${defeat.accessibleNameResolves ? 'PASS' : 'FAIL'}`);
  if (!overBoard || !hasContent || !defeat.accessibleNameResolves) exitCode = 1;

  if (SHOT) {
    const image = await win.webContents.capturePage();
    await fs.writeFile(SHOT, image.toPNG());
    console.log(`SCREENSHOT: ${SHOT}`);
  }

  // RETURN UNCHANGED: after the transient beat the run auto-advances off the dungeon screen and lands on
  // academy-room (the loop return). Defeat changed only the presentation, not the return/finalize path.
  let landed = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
    const s = await win.webContents.executeJavaScript(measureScript());
    if (s.screen === 'academy-room-screen') { landed = s; break; }
    if (s.screen !== 'academy-dungeon-screen' && s.screen !== 'academy-loading-screen') { landed = s; break; }
  }
  log('after_return', landed);
  const returned = landed?.screen === 'academy-room-screen';
  console.log(`AUTO-ADVANCE TO THE SAME RETURN SCREEN (academy-room): ${returned ? 'PASS' : 'FAIL'} (screen=${landed?.screen ?? 'timeout'})`);
  if (!returned) exitCode = 1;

  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
