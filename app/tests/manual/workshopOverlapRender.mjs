// Render-backed workshop-arrival overlap check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM, so the "recipe board overlaps the 1:1 stage image" layout bug is
// verified here against real layout. Not a *.test.mjs (npm test skips it); run it by hand:
//   ./node_modules/.bin/electron app/tests/manual/workshopOverlapRender.mjs
//   WS_WIN_W=1280 WS_WIN_H=720 ./node_modules/.bin/electron app/tests/manual/workshopOverlapRender.mjs
//
// It loads the real client shell, forces the workshop arrival screen active, injects a dense recipe
// board with the CURRENT markup, and measures the rects of the stage column vs the recipe board /
// list, reporting any geometric intersection (the overlap).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.WS_WIN_W ?? 1280);
const WIN_H = Number(process.env.WS_WIN_H ?? 720);

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function minRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-render-'));
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

  // Force the workshop arrival screen active and inject a dense board with the CURRENT card markup.
  await win.webContents.executeJavaScript(`(() => {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    const screen = document.querySelector('#academy-workshop-screen');
    screen.classList.add('active');
    const list = document.querySelector('#academy-workshop-recipes');
    list.replaceChildren();
    for (let i = 0; i < 40; i += 1) {
      const li = document.createElement('li');
      li.className = 'academy-workshop-row';
      li.dataset.category = 'sword';
      li.dataset.element = 'fire';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'academy-workshop-row-button';
      if (i % 3 === 0) btn.disabled = true;
      btn.innerHTML =
        '<span class="academy-workshop-cell academy-workshop-cell-kind">武器（剣）</span>' +
        '<span class="academy-workshop-cell academy-workshop-cell-element">火</span>' +
        '<span class="academy-workshop-cell academy-workshop-cell-tier">T2</span>' +
        '<span class="academy-workshop-cell academy-workshop-cell-effects"><span class="academy-workshop-effect">攻撃+12</span><span class="academy-workshop-effect">最大HP+8</span></span>' +
        '<span class="academy-workshop-cell academy-workshop-cell-items"><span class="academy-workshop-cost"><span class="academy-workshop-cost-label">紅蓮鉄鉱</span><span class="academy-workshop-cost-amount">3（所持 1）</span></span></span>' +
        '<span class="academy-workshop-cell academy-workshop-cell-money"><span class="academy-workshop-cost"><span class="academy-workshop-cost-label">費用</span><span class="academy-workshop-cost-amount">1200（所持 800）</span></span></span>' +
        '<span class="academy-workshop-cell academy-workshop-cell-outlook" data-band="2">良い仕上がり</span>';
      if (btn.disabled) { const l = document.createElement('span'); l.className = 'academy-workshop-row-lack'; l.textContent = '素材・費用が足りません'; btn.append(l); }
      li.append(btn);
      list.append(li);
    }
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  const measure = () => win.webContents.executeJavaScript(`(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { left:+r.left.toFixed(1), top:+r.top.toFixed(1), right:+r.right.toFixed(1), bottom:+r.bottom.toFixed(1), width:+r.width.toFixed(1), height:+r.height.toFixed(1) }; };
    const stageEl = document.querySelector('.academy-workshop-stage');
    const cs = getComputedStyle(stageEl);
    const stageComputed = { width: cs.width, height: cs.height, aspectRatio: cs.aspectRatio, justifySelf: cs.justifySelf, alignSelf: cs.alignSelf, gridColumn: cs.gridColumn, gridRow: cs.gridRow, boxSizing: cs.boxSizing, minWidth: cs.minWidth, inlineStyle: stageEl.getAttribute('style') };
    const frameEl = document.querySelector('.academy-workshop-frame');
    const frameCols = getComputedStyle(frameEl).gridTemplateColumns;
    const stage = rect('.academy-workshop-stage');
    const board = rect('.academy-workshop-board');
    const list = rect('#academy-workshop-recipes');
    const frame = rect('.academy-workshop-frame');
    const layout = rect('.layout');
    const topbarVar = getComputedStyle(document.documentElement).getPropertyValue('--runtime-topbar-height');
    const stageSize = getComputedStyle(document.querySelector('.academy-workshop-screen')).getPropertyValue('--workshop-stage-size');
    // Intersection of stage vs board/list (positive w&h => real overlap).
    const inter = (a, b) => { if (!a || !b) return null; const x = Math.max(0, Math.min(a.right,b.right) - Math.max(a.left,b.left)); const y = Math.max(0, Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top)); return { x:+x.toFixed(1), y:+y.toFixed(1), overlaps: x>1 && y>1 }; };
    // Column alignment: every header cell's left must sit over the matching first-row cell's left (a table reads
    // straight down its columns). Compare the 7 header columns to the first row's 7 cells.
    const lefts = (sel) => [...document.querySelectorAll(sel)].map((el) => +el.getBoundingClientRect().left.toFixed(1));
    const wOf = (sel) => { const el = document.querySelector(sel); return el ? +el.getBoundingClientRect().width.toFixed(1) : null; };
    const widths = { board: wOf('.academy-workshop-board'), boardClient: document.querySelector('.academy-workshop-board')?.clientWidth, head: wOf('.academy-workshop-head-row'), ul: wOf('#academy-workshop-recipes'), rowLi: wOf('#academy-workshop-recipes .academy-workshop-row'), rowBtn: wOf('#academy-workshop-recipes .academy-workshop-row-button') };
    const headLefts = lefts('.academy-workshop-head-row .academy-workshop-col');
    const firstRow = document.querySelector('#academy-workshop-recipes .academy-workshop-row .academy-workshop-row-button');
    const rowLefts = firstRow ? [...firstRow.querySelectorAll(':scope > .academy-workshop-cell')].map((el) => +el.getBoundingClientRect().left.toFixed(1)) : [];
    const colDrift = headLefts.map((h, i) => +Math.abs(h - (rowLefts[i] ?? NaN)).toFixed(1));
    const aligned = headLefts.length === 7 && rowLefts.length === 7 && colDrift.every((d) => d <= 2.5);
    // Row-to-row alignment: the SECOND row's cell lefts must match the first row's exactly (a column reads straight
    // down across recipes — the core table requirement).
    const rows = [...document.querySelectorAll('#academy-workshop-recipes .academy-workshop-row .academy-workshop-row-button')];
    const cellLefts = (btn) => [...btn.querySelectorAll(':scope > .academy-workshop-cell')].map((el) => +el.getBoundingClientRect().left.toFixed(1));
    const rowA = rows[1] ? cellLefts(rows[1]) : [];
    const rowB = rows[6] ? cellLefts(rows[6]) : [];
    const rowDrift = rowA.map((v, i) => +Math.abs(v - (rowB[i] ?? NaN)).toFixed(1));
    const rowToRowAligned = rowA.length === 7 && rowB.length === 7 && rowDrift.every((d) => d <= 0.5);
    // Sticky header: after scrolling the inner table, the header top stays at the table's top.
    const boardEl = document.querySelector('.academy-workshop-board');
    const tableEl = document.querySelector('.academy-workshop-table');
    tableEl.scrollTop = 300;
    const headTop = document.querySelector('.academy-workshop-head-row').getBoundingClientRect().top;
    const tableTop = tableEl.getBoundingClientRect().top;
    const sticky = Math.abs(headTop - tableTop) <= 1.5;
    // Scroll-independent crafting overlay: scroll the list to the BOTTOM (as if crafting the last row), inject the
    // crafting overlay into the board (as setWorkshopCrafting does), and confirm the overlay + its 銘を刻んでいる…
    // label are FULLY inside the board's visible frame (never scrolled off-screen).
    tableEl.scrollTop = tableEl.scrollHeight;
    boardEl.dataset.crafting = 'true';
    const ov = document.createElement('div');
    ov.className = 'academy-workshop-crafting';
    ov.innerHTML = '<span class="academy-workshop-crafting-label">銘を刻んでいる…</span>';
    boardEl.append(ov);
    const br = boardEl.getBoundingClientRect();
    const or = ov.getBoundingClientRect();
    const lr = ov.querySelector('.academy-workshop-crafting-label').getBoundingClientRect();
    const within = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const overlayVisible = within(or, br) && within(lr, br) && or.width > 1 && or.height > 1;
    const rectOf = (r) => ({ left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) });
    return { window: { w: window.innerWidth, h: window.innerHeight }, topbarVar: topbarVar.trim(), stageSize: stageSize.trim(), stageComputed, frameCols, stage, board, list, frame, layout, stage_x_board: inter(stage, board), stage_x_list: inter(stage, list), widths, headLefts, rowLefts, colDrift, aligned, rowDrift, rowToRowAligned, sticky, overlayVisible, overlayRect: rectOf(or), boardRect: rectOf(br), labelRect: rectOf(lr) };
  })()`);

  const m = await measure();
  log('measure', m);
  const noOverlap = !(m.stage_x_board?.overlaps || m.stage_x_list?.overlaps);
  const checks = [
    ['NO STAGE/BOARD OVERLAP', noOverlap],
    ['HEADER↔ROW COLUMNS ALIGNED', m.aligned, `maxDrift=${Math.max(...m.colDrift)}px`],
    ['ROW↔ROW COLUMNS ALIGNED', m.rowToRowAligned, `drift=${JSON.stringify(m.rowDrift)}`],
    ['STICKY HEADER', m.sticky],
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
