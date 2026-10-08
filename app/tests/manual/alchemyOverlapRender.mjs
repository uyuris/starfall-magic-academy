// Render-backed alchemy table-room layout check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM, so the alchemy lab's table-room layout is verified here against real layout. Not
// a *.test.mjs (npm test skips it); run it by hand:
//   ./node_modules/.bin/electron app/tests/manual/alchemyOverlapRender.mjs
//   AL_WIN_W=1280 AL_WIN_H=720 ./node_modules/.bin/electron app/tests/manual/alchemyOverlapRender.mjs
//
// It loads the real client shell, forces the alchemy lab screen active, injects a dense recipe table with the CURRENT
// row markup (the longest 効果 and a two-material cost), and measures: the table stays right of the room's art (the
// left 38.9%) and clear of the place name and the 出る sigil, the rows never overflow the table horizontally, the cells
// line up row to row, and the crafting overlay stays fully in view with the list scrolled to its bottom.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.AL_WIN_W ?? 1280);
const WIN_H = Number(process.env.AL_WIN_H ?? 720);

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function minRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'al-render-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  return root;
}
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-http-cache');

let server;
let exitCode = 0;
async function main() {
  const root = await minRoot();
  const publicRoot = path.join(PROJECT_ROOT, 'app/public');
  server = createServer({ root, activeRoot: root, publicRoot, lmStudioConfigPath: path.join(root, 'no-such-config.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await new Promise((r) => setTimeout(r, 1800)); // let app.js boot + the offscreen window settle its viewport

  // Force the alchemy screen active and inject a dense board with the CURRENT row markup (table-room rows: an li
  // carrying data-lack when unaffordable, its row body a button whose cells sit on the room's column template).
  await win.webContents.executeJavaScript(`(() => {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    document.querySelector('#academy-alchemy-screen').classList.add('active');
    const list = document.querySelector('#academy-alchemy-recipes');
    list.replaceChildren();
    for (let i = 0; i < 40; i += 1) {
      const li = document.createElement('li');
      li.className = 'table-room-row academy-alchemy-row';
      if (i % 3 === 0) li.dataset.lack = 'true';
      li.innerHTML = '<button type="button" class="table-room-row-body academy-alchemy-row-body"' + (i % 3 === 0 ? ' disabled' : '') + '>' +
        '<span class="table-room-cell academy-alchemy-cell-category"><span class="academy-alchemy-category-mark" data-category="self_boost" role="img" aria-label="自分用強化"><svg viewBox="0 0 32 32"></svg></span></span>' +
        '<span class="table-room-cell academy-alchemy-cell-name"><span class="table-room-name">賢者の霊薬</span><span class="table-room-desc">澄んだ霊薬が喉を通ると、頭の奥まで冴えわたり、手足に静かな力が満ちる。</span></span>' +
        '<span class="table-room-cell academy-alchemy-cell-effect"><span class="table-room-effect">筋力 +2、敏捷 +2、学力 +2、魔力 +2、カリスマ +2</span></span>' +
        '<span class="table-room-cell academy-alchemy-cell-items"><span class="table-room-cost"><span class="table-room-cost-name">天光の宝冠</span><span class="table-room-cost-amount">2（所持 0）</span></span><span class="table-room-cost"><span class="table-room-cost-name">深淵の王珠</span><span class="table-room-cost-amount">1（所持 0）</span></span></span>' +
        '<span class="table-room-cell academy-alchemy-cell-money"><span class="table-room-cost"><span class="table-room-cost-name"></span><span class="table-room-cost-amount">1,500 G</span></span></span>' +
        '</button>';
      list.append(li);
    }
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  // The room's layout: the table sits right of the left 38.9% (the room's art stays clear there), clear of the place
  // name and the 出る sigil; the rows never overflow the table horizontally; every row's cells line up with every
  // other row's (a column reads straight down); and the in-flight crafting overlay stays fully inside the table's
  // visible frame even when the list is scrolled to its bottom.
  const measure = () => win.webContents.executeJavaScript(`(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }; };
    const inter = (a, b) => { if (!a || !b) return null; const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)); const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); return { x: +x.toFixed(1), y: +y.toFixed(1), overlaps: x > 1 && y > 1 }; };
    const screen = document.querySelector('#academy-alchemy-screen');
    const tableEl = screen.querySelector('.table-room-table');
    const listEl = document.querySelector('#academy-alchemy-recipes');
    const table = box(tableEl);
    const exit = box(screen.querySelector('.table-room-exit'));
    const place = box(screen.querySelector('.table-room-place'));
    const artEdge = +(window.innerWidth * 0.389).toFixed(1);
    const overflowX = listEl.scrollWidth - listEl.clientWidth;
    const bodies = [...listEl.querySelectorAll('.table-room-row-body')];
    const widest = Math.max(...bodies.map((b) => b.getBoundingClientRect().right)) - listEl.getBoundingClientRect().right;
    const cellLefts = (b) => [...b.querySelectorAll(':scope > .table-room-cell')].map((el) => +el.getBoundingClientRect().left.toFixed(1));
    const rowA = bodies[1] ? cellLefts(bodies[1]) : [];
    const rowB = bodies[6] ? cellLefts(bodies[6]) : [];
    const rowDrift = rowA.map((v, i) => +Math.abs(v - (rowB[i] ?? NaN)).toFixed(1));
    const rowToRowAligned = rowA.length === 5 && rowB.length === 5 && rowDrift.every((d) => d <= 0.5);
    listEl.scrollTop = listEl.scrollHeight;
    tableEl.dataset.crafting = 'true';
    const ov = document.createElement('div');
    ov.className = 'academy-alchemy-crafting';
    ov.innerHTML = '<span class="screen-wait-mark" aria-hidden="true"></span>';
    tableEl.append(ov);
    const br = tableEl.getBoundingClientRect();
    const or = ov.getBoundingClientRect();
    const within = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const overlayVisible = within(or, br) && or.width > 1 && or.height > 1;
    return { window: { w: window.innerWidth, h: window.innerHeight }, ground: getComputedStyle(screen.querySelector('.table-room-stage')).backgroundImage, artEdge, table, exit, place, table_x_exit: inter(table, exit), table_x_place: inter(table, place), overflowX, widest: +widest.toFixed(1), rowA, rowB, rowDrift, rowToRowAligned, overlayVisible };
  })()`);

  const m = await measure();
  log('measure', m);
  const checks = [
    ['ROOM ART CLEAR LEFT OF THE TABLE', m.table.left >= m.artEdge - 1, `table.left=${m.table.left} artEdge=${m.artEdge}`],
    ['GROUND IS THE ROOM ART', m.ground.includes('/canonical/alchemy/stage.jpg'), m.ground.slice(0, 90)],
    ['TABLE CLEAR OF THE PLACE NAME AND THE 出る SIGIL', !m.table_x_exit.overlaps && !m.table_x_place.overlaps],
    ['NO HORIZONTAL OVERFLOW OF THE ROWS', m.overflowX <= 1 && m.widest <= 1, `overflowX=${m.overflowX} widest=${m.widest}`],
    ['ROW↔ROW COLUMNS ALIGNED', m.rowToRowAligned, `drift=${JSON.stringify(m.rowDrift)}`],
    ['CRAFTING OVERLAY FULLY IN VIEW (scrolled to bottom)', m.overlayVisible]
  ];
  for (const [label, pass, extra] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}${extra ? ` (${extra})` : ''}`);
    if (!pass) exitCode = 1;
  }
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
