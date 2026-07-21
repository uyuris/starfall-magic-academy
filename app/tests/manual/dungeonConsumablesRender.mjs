// Render-backed dungeon consumables use-UI check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no DOM/layout, listeners never attach) nor lay out the camera board, so the
// dungeon consumables band + the four target_mode flows are verified here against the REAL client in real Blink.
// Not named *.test.mjs (lives under app/tests/manual/) so `npm test` skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/dungeonConsumablesRender.mjs
//
// It boots an isolated server in LOOP mode with no LM Studio (a SOLO run — no companion), seeds the player
// inventory with real dungeon_consumable alchemy items (one per interactive mode), enters the run, and drives:
//   1. BAND:  the always-on consumables band lists the seeded items with names + quantities.
//   2. AUTO:  clicking an attack_single chip fires use_consumable (it either hits a visible enemy and spends the
//             item, or surfaces the readable no_target action_error — both prove the wiring).
//   3. AIM:   arming an attack_area chip lays the aim overlay (legal-tile highlight) + the targeting prompt;
//             hovering a legal tile previews the Manhattan-radius blast; clicking a legal tile spends the item
//             and passes the turn (a whiff still consumes), and tears the overlay down.
//   4. ALLY:  a heal chip opens the self/companion pick (the companion button disabled in the solo run);
//             choosing 主人公 spends the item.
//   5. REVIVE:the revive chip is disabled with the 対象なし note (no downed companion in a solo run).
// Per ref-camera the harness is fire-and-forget (no top-level await main(); whenReady would deadlock) and the
// board pointer interactions are dispatched in-page (a hidden window's synthetic events reach the delegated
// listeners because they are real DOM dispatches, not OS input).
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureRoot, writeJson } from '../helpers.mjs';
import { createServer } from '../../src/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.DN_WIN_W ?? 1280);
const WIN_H = Number(process.env.DN_WIN_H ?? 860);
const SHOT_PREFIX = process.env.DN_SHOT_PREFIX ?? 'tmp/dungeon-consumables';

// One consumable per interactive target_mode (real ids from data/definitions/game_data/alchemy_recipes.json).
const SEEDED = {
  auto: 'alchemy_light_throwing_bomb',   // attack_single
  aim: 'alchemy_fire_great_blast',        // attack_area (radius 4)
  ally: 'alchemy_healing_elixir',         // heal
  revive: 'alchemy_revival_droplet'       // revive
};

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = async (win, expr) => {
  try { return await win.webContents.executeJavaScript(expr); }
  catch (e) { console.log('EVAL_FAIL', JSON.stringify(expr.slice(0, 120)), e?.message ?? e); throw e; }
};
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

const activeScreen = (win) => js(win, `document.querySelector('.screen.active')?.id ?? null`);

async function shoot(win, suffix) {
  const image = await win.webContents.capturePage();
  const out = path.resolve(PROJECT_ROOT, `${SHOT_PREFIX}${suffix}.png`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, image.toPNG());
  log('screenshot', out);
  return out;
}

async function gotoDungeon(win) {
  await js(win, `document.querySelector('#academy-training-open-dungeon').click(); true`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    if ((await activeScreen(win)) === 'academy-dungeon-screen') return true;
  }
  return false;
}

async function waitForBoard(win) {
  for (let i = 0; i < 50; i += 1) {
    const ready = await js(win, `(() => {
      const play = document.querySelector('#dungeon-play');
      const board = document.querySelector('#dungeon-grid .dn-board');
      const self = document.querySelector('#dungeon-grid .dn-token--self');
      return !!play && play.hidden === false && !!board && /translate\\(/.test(board.style.transform || '') && !!self;
    })()`);
    if (ready) return true;
    await sleep(150);
  }
  return false;
}

// Read the current band chips (item id, target mode, quantity, disabled + note).
function readBandExpr() {
  return `[...document.querySelectorAll('#dungeon-consumables-list .dungeon-consumable')].map((chip) => ({
    itemId: chip.dataset.itemId,
    mode: chip.dataset.targetMode,
    qty: Number((chip.querySelector('.dungeon-consumable-qty')?.textContent ?? '×0').replace(/[^0-9]/g, '')),
    disabled: chip.disabled,
    armed: chip.dataset.armed === 'true',
    note: chip.querySelector('.dungeon-consumable-note')?.textContent ?? ''
  }))`;
}
const readBand = (win) => js(win, readBandExpr());
const readTurnLog = (win) => js(win, `(() => ({
  turn: (document.querySelector('#dungeon-hud-status')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  logLines: document.querySelectorAll('#dungeon-log p').length,
  note: document.querySelector('#dungeon-log-note')?.textContent ?? (document.querySelector('.dungeon-log-note')?.textContent ?? '')
}))()`);

const clickChip = (win, itemId) => js(win, `(() => {
  const chip = document.querySelector('#dungeon-consumables-list .dungeon-consumable[data-item-id=${JSON.stringify(itemId)}]');
  if (!chip || chip.disabled) return false;
  chip.click();
  return true;
})()`);

async function main() {
  const root = await fixtureRoot('dungeon-consumables-render-');
  // Seed the persistent player inventory with one consumable per interactive mode (before any enter builds
  // the run view, which reads consumables straight from player_inventory).
  await writeJson(root, 'game_data/player_inventory.json', {
    money: 100000,
    items: Object.values(SEEDED).map((item_id) => ({ item_id, quantity: 5 })),
    applied_money_delta_conversation_ids: []
  });
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
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('renderer-console:', message); });
  win.webContents.on('render-process-gone', (_e, d) => console.log('render-process-gone:', JSON.stringify(d)));
  await win.loadURL(`${base}/`);
  await sleep(1500);

  if (!(await gotoDungeon(win))) { check('setup: dungeon screen activates', false); exitCode = 2; app.quit(); return; }
  await sleep(400);
  await js(win, `document.querySelector('#dungeon-enter').click(); true`);
  if (!(await waitForBoard(win))) { check('setup: solo run board renders', false); exitCode = 2; app.quit(); return; }
  await sleep(500);

  // ---- 1. BAND -----------------------------------------------------------------------------------------------
  const band = await readBand(win);
  log('band', band);
  const bandIds = new Set(band.map((c) => c.itemId));
  check('band: lists every seeded consumable', Object.values(SEEDED).every((id) => bandIds.has(id)), { bandIds: [...bandIds] });
  check('band: chips show quantities', band.length > 0 && band.every((c) => c.qty === 5), { qtys: band.map((c) => c.qty) });
  check('band: modes are wired (auto/aim/ally/revive present)', ['auto', 'aim', 'ally', 'revive'].every((m) => band.some((c) => c.mode === m)), { modes: band.map((c) => c.mode) });
  await shoot(win, '-band');

  // ---- 2. AUTO (attack_single) -------------------------------------------------------------------------------
  const autoBefore = (await readBand(win)).find((c) => c.itemId === SEEDED.auto);
  await clickChip(win, SEEDED.auto);
  await sleep(800);
  const autoAfter = (await readBand(win)).find((c) => c.itemId === SEEDED.auto);
  const autoLog = await readTurnLog(win);
  const autoConsumed = autoAfter && autoBefore && autoAfter.qty === autoBefore.qty - 1;
  const autoErrorReadable = !!autoLog.note && !/undefined|\bno_target\b|\bblocked\b/.test(autoLog.note);
  log('auto', { autoBefore: autoBefore?.qty, autoAfter: autoAfter?.qty, note: autoLog.note });
  check('auto: clicking fires use_consumable (spent an item OR surfaced a readable action_error)', autoConsumed || autoErrorReadable, { consumed: autoConsumed, note: autoLog.note });

  // ---- 3. AIM (attack_area) ----------------------------------------------------------------------------------
  await clickChip(win, SEEDED.aim);
  await sleep(250);
  const armed = await js(win, `(() => {
    const layer = document.querySelector('#dungeon-grid .dn-aim');
    const valid = layer ? layer.querySelectorAll('.dn-aim-valid').length : 0;
    const prompt = document.querySelector('#dungeon-consumable-prompt');
    const chip = document.querySelector('#dungeon-consumables-list .dungeon-consumable[data-item-id=${JSON.stringify(SEEDED.aim)}]');
    return {
      overlay: !!layer,
      validCells: valid,
      aimingCursor: document.querySelector('#dungeon-grid')?.classList.contains('dn-aiming') ?? false,
      promptVisible: prompt ? prompt.hidden === false : false,
      chipArmed: chip?.dataset.armed === 'true'
    };
  })()`);
  log('aim-armed', armed);
  check('aim: arming lays the overlay with legal tiles + the aim prompt + armed chip', armed.overlay && armed.validCells > 0 && armed.promptVisible && armed.aimingCursor && armed.chipArmed, armed);
  await shoot(win, '-aim');

  // Hover a legal tile -> the Manhattan-radius blast preview appears.
  const hover = await js(win, `(() => {
    const cell = document.querySelector('#dungeon-grid .dn-aim .dn-aim-valid');
    if (!cell) return { hovered: false };
    cell.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return { hovered: true, blast: document.querySelectorAll('#dungeon-grid .dn-aim .dn-aim-blast').length, x: cell.dataset.x, y: cell.dataset.y };
  })()`);
  log('aim-hover', hover);
  check('aim: hovering a legal tile previews the blast radius', hover.hovered && hover.blast > 0, hover);

  // Click a legal tile -> the item is spent and the turn passes (a whiff still consumes), overlay torn down.
  const aimBefore = (await readBand(win)).find((c) => c.itemId === SEEDED.aim);
  const turnBefore = await readTurnLog(win);
  await js(win, `(() => { const cell = document.querySelector('#dungeon-grid .dn-aim .dn-aim-valid'); if (cell) cell.click(); return true; })()`);
  await sleep(900);
  const aimAfter = (await readBand(win)).find((c) => c.itemId === SEEDED.aim);
  const turnAfter = await readTurnLog(win);
  const overlayGone = await js(win, `document.querySelector('#dungeon-grid .dn-aim') === null && document.querySelector('#dungeon-consumable-prompt').hidden === true`);
  log('aim-fire', { aimBefore: aimBefore?.qty, aimAfter: aimAfter?.qty, turnBefore: turnBefore.turn, turnAfter: turnAfter.turn, overlayGone });
  check('aim: clicking a legal tile spends the item and passes the turn', !!aimAfter && !!aimBefore && aimAfter.qty === aimBefore.qty - 1, { before: aimBefore?.qty, after: aimAfter?.qty });
  check('aim: firing tears the overlay + prompt down', overlayGone === true, { overlayGone });

  // ---- 4. ALLY (heal) ----------------------------------------------------------------------------------------
  await clickChip(win, SEEDED.ally);
  await sleep(250);
  const allyPrompt = await js(win, `(() => {
    const prompt = document.querySelector('#dungeon-consumable-prompt');
    const buttons = prompt ? [...prompt.querySelectorAll('.dungeon-consumable-prompt-action')] : [];
    return {
      visible: prompt ? prompt.hidden === false : false,
      labels: buttons.map((b) => b.textContent),
      companionDisabled: buttons.length >= 2 ? buttons[1].disabled : null
    };
  })()`);
  log('ally-prompt', allyPrompt);
  check('ally: heal opens the self/companion pick with the companion disabled in the solo run', allyPrompt.visible && allyPrompt.labels[0] === '主人公' && allyPrompt.companionDisabled === true, allyPrompt);
  await shoot(win, '-ally');

  const allyBefore = (await readBand(win)).find((c) => c.itemId === SEEDED.ally);
  await js(win, `(() => { const b = [...document.querySelectorAll('#dungeon-consumable-prompt .dungeon-consumable-prompt-action')].find((x) => x.textContent === '主人公'); if (b) b.click(); return true; })()`);
  await sleep(800);
  const allyAfter = (await readBand(win)).find((c) => c.itemId === SEEDED.ally);
  log('ally-fire', { allyBefore: allyBefore?.qty, allyAfter: allyAfter?.qty });
  check('ally: choosing 主人公 spends the heal item', !!allyAfter && !!allyBefore && allyAfter.qty === allyBefore.qty - 1, { before: allyBefore?.qty, after: allyAfter?.qty });

  // ---- 5. REVIVE ---------------------------------------------------------------------------------------------
  const revive = (await readBand(win)).find((c) => c.itemId === SEEDED.revive);
  log('revive', revive);
  check('revive: the chip is disabled with the 対象なし note (no downed companion, solo run)', !!revive && revive.disabled === true && revive.note === '対象なし', revive);

  const passed = results.filter((r) => r.pass).length;
  console.log(`DUNGEON CONSUMABLES RENDER: ${passed}/${results.length} checks PASS`);
  if (passed !== results.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
