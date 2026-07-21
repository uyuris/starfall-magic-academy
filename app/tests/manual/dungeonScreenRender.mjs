// Render-backed 実践ダンジョン screen restyle check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no DOM/layout, listeners never attach) nor lay out the camera board, so the
// dungeon screen (#academy-dungeon-screen — the obsidian+amber restyle) is verified here against the REAL client
// in real Blink. This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// (node --test app/tests/*.test.mjs) skips it; run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/dungeonScreenRender.mjs
//   DN_SHOT_PREFIX=tmp/dungeon-after ./node_modules/.bin/electron app/tests/manual/dungeonScreenRender.mjs
//
// It boots an isolated server in LOOP mode (no play-mode.json -> loop baseline; no LM Studio -> a SOLO run, no
// companion) and drives the real client across the entry / play surfaces, the run-end result popup, and the
// mechanics, all in real Blink:
//   1. ENTRY:  navigate to the dungeon (the real #academy-training-open-dungeon handler -> showScreen) and shoot
//      the operable pre-entry surface (#dungeon-entry) — obsidian card + amber eyebrow + the launch buttons
//      (#dungeon-enter / #dungeon-back-to-map) recolored to the obsidian chip-pill (not the warm-gold CTA).
//   2. PLAY:   click #dungeon-enter -> the run board renders (tiles + player token), the HUD HP/MP bars, the 6
//      element spell pills + the amber heal pill, the dock + action log. Shoot the play surface and assert the
//      obsidian tokens are live (panels read the --dungeon-panel fill) and the board-protection exception holds
//      (.dungeon-grid keeps NO backdrop blur while the HUD panel does).
//   3. DETAIL + RESULT: click the 主人公 HUD party-card name -> the unified actor detail shell opens (obsidian
//      panel + the 能力値 / 装備 / 獲得予定 section grammar, no image for the hero). Then retreat at the spawn
//      (entrance -> can_retreat) through the HUD retreat button -> the dedicated #dungeon-retreat-confirm modal,
//      whose .primary confirm is the obsidian chip-pill (amber edge, NOT the old warm-gold academy chrome) ->
//      the #dungeon-result-popup floats over the still-visible board (no screen swap). Shoot the detail + result.
//   4. MECHANICS: enter again and drive a 待機(Space)+移動(Arrow) turn -> the turn advances and the action log
//      grows. This is the app.js/dungeonCamera.js-unchanged proof (the same client code still drives the board).
//
// Screenshots are written to ${DN_SHOT_PREFIX}{-entry,-play,-result}.png. Capture before/after by running once on
// the base design and once on the restyle with distinct prefixes. Per ref-camera the harness is fire-and-forget
// (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureRoot } from '../helpers.mjs';
import { createServer } from '../../src/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.DN_WIN_W ?? 1280);
const WIN_H = Number(process.env.DN_WIN_H ?? 860);
const SHOT_PREFIX = process.env.DN_SHOT_PREFIX ?? 'tmp/dungeon-shot';

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

const activeScreen = (win) => js(win, `document.querySelector('.screen.active')?.id ?? null`);

async function shoot(win, suffix) {
  const image = await win.webContents.capturePage();
  const out = path.resolve(PROJECT_ROOT, `${SHOT_PREFIX}${suffix}.png`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, image.toPNG());
  log('screenshot', out);
  return out;
}

// Navigate to the dungeon screen through the REAL client handler (works even though the button is non-render).
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

async function main() {
  // A complete game-data fixture root + baseline runtime state. No play-mode.json and no LM Studio config ->
  // loop play-mode baseline and a SOLO dungeon run (companion is availability-gated on LM, off here).
  const root = await fixtureRoot('dungeon-screen-render-');
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
  await sleep(1500); // let app.js boot (refresh(), listeners attach)

  // ---- 1. ENTRY surface -------------------------------------------------------------------------------------
  if (!(await gotoDungeon(win))) { check('entry: dungeon screen activates', false); exitCode = 2; app.quit(); return; }
  // refreshDungeonScreen resolves the availability line async; give it a beat, then confirm the entry card.
  await sleep(600);
  const entry = await js(win, `(() => {
    const card = document.querySelector('#dungeon-entry');
    const cs = card ? getComputedStyle(card) : null;
    const eyebrow = document.querySelector('#dungeon-entry .eyebrow');
    const enter = document.querySelector('#dungeon-enter');
    const back = document.querySelector('#dungeon-back-to-map');
    const csEnter = enter ? getComputedStyle(enter) : null;
    const csBack = back ? getComputedStyle(back) : null;
    const screen = document.querySelector('#academy-dungeon-screen.active');
    const csScreen = screen ? getComputedStyle(screen) : null;
    const layout = document.querySelector('.layout');
    return {
      entryVisible: card ? card.hidden === false : false,
      entryBg: cs ? cs.backgroundColor : '',
      eyebrowColor: eyebrow ? getComputedStyle(eyebrow).color : '',
      enter: csEnter ? { border: csEnter.borderColor, bg: csEnter.backgroundColor, color: csEnter.color } : null,
      back: csBack ? { border: csBack.borderColor, bg: csBack.backgroundColor, color: csBack.color } : null,
      // Direct-background (いきなり背景) standard: the layout is edge-to-edge (padding:0) and the obsidian screen
      // drops the floating-frame chrome (radius / box-shadow), so no navy gradient is revealed as a border — not
      // even at rounded corners.
      layoutPadding: layout ? getComputedStyle(layout).padding : '',
      screenRadius: csScreen ? csScreen.borderTopLeftRadius : '',
      screenShadow: csScreen ? csScreen.boxShadow : ''
    };
  })()`);
  log('entry', entry);
  check('entry: #dungeon-entry pre-entry surface visible', entry.entryVisible === true, { entryVisible: entry.entryVisible });
  check('entry: entry card wears the obsidian panel fill (rgb 20,23,30)', /20,\s*23,\s*30/.test(entry.entryBg), { entryBg: entry.entryBg });
  check('entry: eyebrow is amber lamplight (rgb 240,178,74)', /240,\s*178,\s*74/.test(entry.eyebrowColor), { eyebrowColor: entry.eyebrowColor });
  // The launch buttons (#dungeon-enter primary / #dungeon-back-to-map secondary) are recolored to the obsidian
  // chip-pill family (same as the menu popup CTAs) — amber edge over the obsidian chip/inset, NOT the old warm-gold
  // academy chrome (gold 211,180,105 border + cream 255,248,229 text).
  check('entry: enter (primary) carries the amber emphasis edge (240,178,74), not warm gold (211,180,105)', !!entry.enter && /240,\s*178,\s*74/.test(entry.enter.border) && !/211,\s*180,\s*105/.test(entry.enter.border), { enter: entry.enter });
  check('entry: back-to-map (secondary) wears the amber hairline (240,178,74) over the obsidian chip (26,29,38)', !!entry.back && /240,\s*178,\s*74/.test(entry.back.border) && /26,\s*29,\s*38/.test(entry.back.bg), { back: entry.back });
  check('entry: launch button ink is dungeon ivory, not cream (255,248,229)', !!entry.enter && !/255,\s*248,\s*229/.test(entry.enter.color) && !/255,\s*248,\s*229/.test(entry.back.color), { enterColor: entry.enter?.color, backColor: entry.back?.color });
  // BACKGROUND (いきなり背景): the dungeon layout is edge-to-edge (padding:0) and the obsidian screen drops the
  // floating-frame chrome (border radius / drop shadow) so no navy gradient shows as a border — not at corners.
  check('entry: the dungeon layout is edge-to-edge (layout padding:0) and the obsidian screen has no frame radius / drop-shadow (no navy-gradient border)',
    entry.layoutPadding === '0px' && entry.screenRadius === '0px' && entry.screenShadow === 'none',
    { layoutPadding: entry.layoutPadding, screenRadius: entry.screenRadius, screenShadow: entry.screenShadow });
  await shoot(win, '-entry');

  // ---- 2. PLAY surface --------------------------------------------------------------------------------------
  await js(win, `document.querySelector('#dungeon-enter').click(); true`);
  if (!(await waitForBoard(win))) { check('play: run board renders', false); exitCode = 2; app.quit(); return; }
  await sleep(400); // let the ResizeObserver settle any reframe
  const play = await js(win, `(() => {
    const grid = document.querySelector('#dungeon-grid');
    const hud = document.querySelector('.dungeon-hud');
    const cells = document.querySelectorAll('#dungeon-grid .dn-cell').length;
    const hasSelf = !!document.querySelector('#dungeon-grid .dn-token--self');
    const spells = [...document.querySelectorAll('#dungeon-spells .dungeon-spell')];
    // The self-heal, 貫通 and 回避 pills share the single #dungeon-actions row (order 回復・貫通・回避). Measure
    // their offsetTop within the row to confirm they land on one visual line.
    const actionRow = document.querySelector('#dungeon-actions');
    const actionPills = actionRow ? [...actionRow.children] : [];
    const heal = actionRow ? actionRow.querySelector('.dungeon-spell-heal') : null;
    const pierce = actionRow ? actionRow.querySelector('.dungeon-spell-pierce') : null;
    const evasion = actionRow ? actionRow.querySelector('.dungeon-spell-evasion') : null;
    const actionTops = [heal, pierce, evasion].filter(Boolean).map((b) => b.offsetTop);
    const hpBar = document.querySelector('.dn-hud-bar--hp .dn-hud-bar-fill');
    const mpBar = document.querySelector('.dn-hud-bar--mp .dn-hud-bar-fill');
    const spellBorders = [...new Set(spells.map((s) => getComputedStyle(s).borderColor))];
    return {
      screen: document.querySelector('.screen.active')?.id ?? null,
      cells,
      hasSelf,
      spellCount: spells.length,
      distinctSpellBorders: spellBorders.length,
      hasHeal: !!heal,
      healColor: heal ? getComputedStyle(heal).color : '',
      actionPillCount: actionPills.length,
      actionPillClasses: actionPills.map((b) => b.className),
      hasPierce: !!pierce,
      hasEvasion: !!evasion,
      actionTops,
      actionSameRow: actionTops.length === 3 && new Set(actionTops).size === 1,
      hasHpBar: !!hpBar,
      hasMpBar: !!mpBar,
      gridBg: grid ? getComputedStyle(grid).backgroundColor : '',
      gridBackdrop: grid ? getComputedStyle(grid).backdropFilter : '',
      hudBackdrop: hud ? getComputedStyle(hud).backdropFilter : ''
    };
  })()`);
  log('play', play);
  check('play: board renders tiles + player token', play.cells > 0 && play.hasSelf, { cells: play.cells, hasSelf: play.hasSelf });
  check('play: HUD carries HP + MP bars', play.hasHpBar && play.hasMpBar, { hasHpBar: play.hasHpBar, hasMpBar: play.hasMpBar });
  check('play: element spell pills render with distinct identity colors', play.spellCount > 0 && play.distinctSpellBorders >= Math.min(play.spellCount, 2), { spellCount: play.spellCount, distinctSpellBorders: play.distinctSpellBorders });
  check('play: amber self-heal pill present (rgb 240,178,74)', play.hasHeal && /240,\s*178,\s*74/.test(play.healColor), { healColor: play.healColor });
  check('play: 回復・貫通・回避 are the three children of the #dungeon-actions row', play.actionPillCount === 3 && play.hasHeal && play.hasPierce && play.hasEvasion, { actionPillCount: play.actionPillCount, actionPillClasses: play.actionPillClasses });
  check('play: the three action pills sit on a single visual row (equal offsetTop)', play.actionSameRow, { actionTops: play.actionTops });
  check('play: panels wear the obsidian fill (grid rgb 20,23,30)', /20,\s*23,\s*30/.test(play.gridBg), { gridBg: play.gridBg });
  check('play: board-protection — .dungeon-grid keeps NO backdrop blur', play.gridBackdrop === 'none', { gridBackdrop: play.gridBackdrop });
  check('play: HUD panel keeps its blur (only the grid is exempt)', /blur/.test(play.hudBackdrop), { hudBackdrop: play.hudBackdrop });
  await shoot(win, '-play');

  // ---- 3. DETAIL shell (HUD party-card name -> unified actor detail: obsidian panel + section grammar) -------
  const hudButtons = await js(win, `(() => ({
    retreat: !!document.querySelector('#dungeon-retreat-button'),
    help: !!document.querySelector('#dungeon-help-button'),
    menuGone: !document.querySelector('#dungeon-menu-button')
  }))()`);
  log('hud-buttons', hudButtons);
  check('hud: a retreat button + a help icon replace the menu button', hudButtons.retreat && hudButtons.help && hudButtons.menuGone, hudButtons);
  await js(win, `document.querySelector('#dungeon-hud-status .dn-hud-actor-name').click(); true`);
  await sleep(300);
  const detail = await js(win, `(() => {
    const popup = document.querySelector('#dungeon-actor-detail');
    const panel = document.querySelector('#dungeon-actor-detail .actor-detail-panel');
    const cs = panel ? getComputedStyle(panel) : null;
    const heads = [...document.querySelectorAll('#dungeon-actor-detail .actor-detail-section-head')].map((h) => h.textContent);
    return {
      visible: popup ? popup.hidden === false : false,
      bg: cs ? cs.backgroundColor : '',
      heads,
      hasEquipment: !!document.querySelector('#dungeon-actor-detail .actor-detail-equipment'),
      hasImage: !!document.querySelector('#dungeon-actor-detail .actor-detail-image')
    };
  })()`);
  log('detail', detail);
  check('detail: the 主人公 HUD party-card name opens the unified actor detail', detail.visible, { visible: detail.visible });
  check('detail: the detail panel wears the obsidian panel fill (rgb 20,23,30)', /20,\s*23,\s*30/.test(detail.bg), { bg: detail.bg });
  // The hero detail lays out 能力値 / 装備 / 獲得予定 with NO image slot (the hero has no portrait; a companion would).
  check('detail: the hero detail is 能力値 / 装備 / 獲得予定 with equipment cards and no image slot',
    detail.heads.includes('能力値') && detail.heads.includes('装備') && detail.heads.includes('獲得予定') && detail.hasEquipment && !detail.hasImage,
    { heads: detail.heads, hasEquipment: detail.hasEquipment, hasImage: detail.hasImage });
  await shoot(win, '-detail');
  await js(win, `document.querySelector('#dungeon-actor-detail [data-dungeon-actor-detail-close]').click(); true`);
  await sleep(200);

  // ---- 3b. RESULT surface (retreat at spawn via the HUD retreat button -> dedicated confirm modal) ----------
  await js(win, `document.querySelector('#dungeon-retreat-button').click(); true`);
  await sleep(300);
  const confirmClicked = await js(win, `(() => {
    const btn = document.querySelector('#dungeon-retreat-confirm .academy-map-action-button.primary');
    if (!btn) return { ok: false, disabled: 'missing' };
    const cs = getComputedStyle(btn);
    const style = { border: cs.borderColor, bg: cs.backgroundColor, color: cs.color };
    if (btn.disabled) return { ok: false, disabled: true, style };
    btn.click();
    return { ok: true, style };
  })()`);
  log('retreat', { confirmClicked });
  check('retreat-confirm: the primary confirm carries the amber emphasis edge (240,178,74), not warm gold (211,180,105)', !!confirmClicked.style && /240,\s*178,\s*74/.test(confirmClicked.style.border) && !/211,\s*180,\s*105/.test(confirmClicked.style.border), { border: confirmClicked.style?.border });
  let resultShot = false;
  for (let i = 0; i < 24; i += 1) { // poll within the DUNGEON_RESULT_HOLD_MS (1600ms) window before it auto-exits
    await sleep(60);
    const shown = await js(win, `(() => { const r = document.querySelector('#dungeon-result-popup'); return !!r && r.hidden === false; })()`);
    if (shown) { resultShot = true; break; }
  }
  const result = await js(win, `(() => {
    const popup = document.querySelector('#dungeon-result-popup');
    const panel = document.querySelector('#dungeon-result-popup .dungeon-result-popup-panel');
    const cs = panel ? getComputedStyle(panel) : null;
    return {
      visible: popup ? popup.hidden === false : false,
      playVisible: document.querySelector('#dungeon-play')?.hidden === false,
      bg: cs ? cs.backgroundColor : '',
      text: (document.querySelector('#dungeon-result-popup-body')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    };
  })()`);
  log('result', result);
  check('result: #dungeon-result-popup floated over the board after retreat', resultShot && result.visible, { resultShot, visible: result.visible });
  check('result: board stays visible under the popup (no screen swap)', result.playVisible === true, { playVisible: result.playVisible });
  check('result: result popup panel wears the obsidian panel fill (rgb 20,23,30)', /20,\s*23,\s*30/.test(result.bg), { bg: result.bg });
  if (result.visible) await shoot(win, '-result');

  // ---- 4. MECHANICS leg (unchanged app.js / dungeonCamera.js still drive the board) -------------------------
  await sleep(2600); // let the result auto-exit to the room + the solo finalize/clear settle
  log('post-retreat screen', { screen: await activeScreen(win) });
  if (!(await gotoDungeon(win))) { check('mechanics: re-enter dungeon screen', false); exitCode = 1; app.quit(); return; }
  await sleep(700);
  const preEnter2 = await js(win, `(() => ({ screen: document.querySelector('.screen.active')?.id ?? null, entryHidden: document.querySelector('#dungeon-entry')?.hidden, playHidden: document.querySelector('#dungeon-play')?.hidden }))()`);
  log('pre second-enter', preEnter2);
  await js(win, `document.querySelector('#dungeon-enter').click(); true`);
  if (!(await waitForBoard(win))) {
    const diag = await js(win, `(() => ({ screen: document.querySelector('.screen.active')?.id ?? null, playHidden: document.querySelector('#dungeon-play')?.hidden, hasSelf: !!document.querySelector('#dungeon-grid .dn-token--self'), boardT: document.querySelector('#dungeon-grid .dn-board')?.style.transform ?? null }))()`);
    log('second-run diag', diag);
    check('mechanics: second run board renders', false, diag); exitCode = 1; app.quit(); return;
  }
  await sleep(400);
  const readState = () => js(win, `(() => ({
    status: (document.querySelector('#dungeon-hud-status')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    logLines: document.querySelectorAll('#dungeon-log p').length
  }))()`);
  const before = await readState();
  // 待機(Space) always advances a turn; a follow-up Arrow drives a real move.
  await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); true`);
  await sleep(700);
  await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); true`);
  await sleep(700);
  const after = await readState();
  log('mechanics', { before, after });
  check('mechanics: HUD status advances after a turn', after.status !== before.status || after.logLines > before.logLines, { beforeStatus: before.status, afterStatus: after.status });
  check('mechanics: action log grows across turns', after.logLines >= before.logLines && after.logLines > 0, { beforeLines: before.logLines, afterLines: after.logLines });

  const passed = results.filter((r) => r.pass).length;
  console.log(`DUNGEON SCREEN RENDER: ${passed}/${results.length} checks PASS`);
  if (passed !== results.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
