// Render-backed dungeon entry-framing check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM (clientWidth is 0, getBoundingClientRect is empty), so the
// camera questions are verified here, against real layout, rather than in the headless suite. This
// file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// (node --test app/tests/*.test.mjs) skips it; run it by hand with the Electron binary.
//
//   ./node_modules/.bin/electron app/tests/manual/dungeonEnterRender.mjs
//   DN_SEED=8080 DN_WIN_W=1000 DN_WIN_H=720 DN_MOVE=ArrowLeft ./node_modules/.bin/electron app/tests/manual/dungeonEnterRender.mjs
//
// It boots an isolated server (solo, no LLM), drives the REAL client enter path
// (#academy-training-open-dungeon -> showScreen('academy-dungeon') -> refreshDungeonScreen ->
// renderDungeonPlay -> renderDungeonGrid(center) -> the grid ResizeObserver settle), then measures
// the BOARD CAMERA (its translate offset) and the player token's on-screen position. The entry
// camera uses the same content-clamped deadzone-follow rule as a move (no clamp-less center snap), so:
//   - NO FIRST-MOVE CAMERA JERK: the first step is chosen to keep the player inside the deadzone, so
//     the camera must hold EXACTLY still (zero jump). The pre-fix bug jumped the camera by the clamp
//     gap (a whole content-edge worth) on the first step.
//   - PRE-MOVE RE-SHOW STABLE: re-showing the screen before any action (a 'preserve' render) does not
//     move the camera.
//   - FOLLOW ACTIVE: the move is real — the player visibly moves on screen while the camera holds.
// The entry frame is content-clamped (the player is NOT forced dead-centre when the spawn sits near a
// floor edge), exactly as a follow frames the same position — that shared rule is what removes the jerk.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SEED = Number(process.env.DN_SEED ?? 2024);
const WIN_W = Number(process.env.DN_WIN_W ?? 1200);
const WIN_H = Number(process.env.DN_WIN_H ?? 820);
const MOVE = process.env.DN_MOVE ?? 'ArrowLeft'; // a step toward viewport centre keeps the player in the deadzone

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

function baselineParameters() {
  return {
    magic: { light: { value: 12 }, dark: { value: 10 }, fire: { value: 14 }, water: { value: 8 }, earth: { value: 11 }, wind: { value: 9 } },
    abilities: { strength: { value: 28 }, agility: { value: 30 }, academics: { value: 26 }, magical_power: { value: 24 }, charisma: { value: 22 } }
  };
}

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// A minimal split-layout root (no characters): enough for the mechanical solo dungeon path.
async function splitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dn-render-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', baselineParameters());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
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

// Board camera = the board's translate offset (negated scroll). A "jerk" is the camera jumping
// between two frames; we compare entry vs re-show vs after-move.
function cameraOf(measure) {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(measure?.boardTransform ?? '');
  return m ? { x: +(+m[1]).toFixed(1), y: +(+m[2]).toFixed(1) } : null;
}
function jump(a, b) {
  const ca = cameraOf(a);
  const cb = cameraOf(b);
  if (!ca || !cb) return null;
  return { x: +Math.abs(ca.x - cb.x).toFixed(1), y: +Math.abs(ca.y - cb.y).toFixed(1) };
}

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;
async function main() {
  const root = await splitRoot();
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({ root, activeRoot: root, publicRoot, lmStudioConfigPath: path.join(root, 'no-such-config.json') });
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
  log('view', { width: v.width, height: v.height, player: v.player, vision_radius: v.player_stats?.vision_radius, floor: v.floor, run_id: v.run_id });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1200)); // let app.js boot (refresh(), listeners attached)

  // Drive the REAL client path: the click handler runs showScreen('academy-dungeon') even though the
  // button is not visible, which loads the active run and lays the board out.
  await win.webContents.executeJavaScript(`document.querySelector('#academy-training-open-dungeon').click(); true`);
  // Wait until the board has actually been laid out (its camera transform set) rather than a fixed
  // delay — the offscreen window can settle its viewport late, so polling avoids a 0-size race.
  const waitForLayout = async () => {
    for (let i = 0; i < 40; i += 1) {
      const ready = await win.webContents.executeJavaScript(`(() => {
        const board = document.querySelector('#dungeon-grid .dn-board');
        return !!board && /translate\\(/.test(board.style.transform || '');
      })()`);
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  if (!(await waitForLayout())) { log('LAYOUT_TIMEOUT', { note: 'board never received a camera transform' }); exitCode = 2; app.quit(); return; }
  await new Promise((r) => setTimeout(r, 400)); // let the ResizeObserver settle reframe (if any) finish

  const measure = () => win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('#dungeon-grid');
    const viewport = grid?.querySelector('.dn-viewport');
    const board = grid?.querySelector('.dn-board');
    const playerNode = [...(grid?.querySelectorAll('.dn-entities .dn-entity') ?? [])].find((n) => n.querySelector('.dn-token--self'));
    if (!viewport || !board || !playerNode) return { ok: false, hasViewport: !!viewport, hasBoard: !!board, hasPlayer: !!playerNode, screen: document.querySelector('.screen.active')?.id ?? null };
    const vr = viewport.getBoundingClientRect();
    const pr = playerNode.getBoundingClientRect();
    const cell = parseFloat(getComputedStyle(grid).getPropertyValue('--dn-cell'));
    const gap = parseFloat(getComputedStyle(grid).getPropertyValue('--dn-gap'));
    return {
      ok: true,
      viewport: { width: +vr.width.toFixed(1), height: +vr.height.toFixed(1) },
      step: +(cell + gap).toFixed(1),
      playerDelta: { x: +((pr.left + pr.width / 2) - (vr.left + vr.width / 2)).toFixed(1), y: +((pr.top + pr.height / 2) - (vr.top + vr.height / 2)).toFixed(1) },
      boardTransform: board.style.transform
    };
  })()`);

  const entry = await measure();
  log('entry', entry);
  if (!entry.ok) { exitCode = 1; app.quit(); return; }

  // A 'preserve' render: re-showing the dungeon screen before any action must not move the camera.
  await win.webContents.executeJavaScript(`document.querySelector('#academy-training-open-dungeon').click(); true`);
  await new Promise((r) => setTimeout(r, 1000));
  const reshow = await measure();
  log('reshow_no_action', reshow);
  const reshowJump = jump(entry, reshow);
  const reshowStable = reshowJump && reshowJump.x < 2 && reshowJump.y < 2;
  console.log(`PRE-MOVE RE-SHOW STABLE (camera unchanged): ${reshowStable ? 'PASS' : 'FAIL'} jump=${JSON.stringify(reshowJump)}`);
  if (!reshowStable) exitCode = 1;

  // First move: the deadzone follow takes over. Because the entry frame is ALREADY the
  // content-clamped position the follow holds, the camera moves at most one tile (zero while the
  // player stays in the deadzone) — never the clamp-gap jump of a clamp-less center handing off.
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(MOVE)}, bubbles: true })); true`);
  await new Promise((r) => setTimeout(r, 900));
  const moved = await measure();
  log('after_move', moved);
  const moveJump = jump(entry, moved);
  // The move is chosen to keep the player inside the deadzone (a step toward viewport centre), so a
  // unified entry/follow camera must hold EXACTLY still — zero jump (sub-pixel epsilon only). The
  // pre-fix clamp-less center handed off to a clamped follow and jumped the camera by the clamp gap.
  const EPS = 0.5;
  const noJerk = moveJump && moveJump.x < EPS && moveJump.y < EPS;
  console.log(`NO FIRST-MOVE CAMERA JERK (camera held — zero jump for the deadzone-preserving move): ${noJerk ? 'PASS' : 'FAIL'} jump=${JSON.stringify(moveJump)} (one tile would be ${entry.step}px)`);
  if (!noJerk) exitCode = 1;
  const followActive = moved.ok && (Math.abs(moved.playerDelta.x - entry.playerDelta.x) >= 2 || Math.abs(moved.playerDelta.y - entry.playerDelta.y) >= 2);
  console.log(`FOLLOW ACTIVE (player moved on screen while the camera held): ${followActive ? 'PASS' : 'FAIL'}`);
  if (!followActive) exitCode = 1;

  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
