// Render-backed alchemy-arrival overlap check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM, so the "1:1 stage image overlaps the recipe board" layout bug is
// verified here against real layout. Not a *.test.mjs (npm test skips it); run it by hand:
//   ./node_modules/.bin/electron app/tests/manual/alchemyOverlapRender.mjs
//   AL_WIN_W=1280 AL_WIN_H=720 ./node_modules/.bin/electron app/tests/manual/alchemyOverlapRender.mjs
//
// It loads the real client shell, forces the alchemy lab screen active, injects a dense recipe table with
// the CURRENT markup, and measures the rects of the 1:1 stage column vs the recipe board / list, reporting any
// geometric intersection (the overlap). The alchemy stage shares the workshop content-box overlap root cause:
// its frame is `grid-template-columns: var(--alchemy-stage-size) minmax(0, 1fr)`, so a content-box stage whose
// padding+border spill past --alchemy-stage-size covers the neighbouring board. `box-sizing: border-box` keeps
// the stage's real paint inside its column. This harness confirms the sibling fix the same way workshop's did.
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

  // Force the alchemy lab screen active and inject a dense recipe table with plausible row content so the board
  // column resolves to its real width (the overlap is a function of the stage column geometry, so filler rows are
  // enough to make the board occupy its neighbouring column next to the stage). Rows mirror the real
  // buildAlchemyRow markup (subgrid row-button + the 5 aligned cells).
  await win.webContents.executeJavaScript(`(() => {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    const screen = document.querySelector('#academy-alchemy-screen');
    screen.classList.add('active');
    const list = document.querySelector('#academy-alchemy-recipes');
    list.replaceChildren();
    const cats = ['gift', 'ally_boost', 'self_boost', 'dungeon_consumable', 'product'];
    for (let i = 0; i < 24; i += 1) {
      const category = cats[i % cats.length];
      const li = document.createElement('li');
      li.className = 'academy-alchemy-row';
      li.dataset.category = category;
      li.innerHTML =
        '<button type="button" class="academy-alchemy-row-button">' +
          '<span class="academy-alchemy-cell academy-alchemy-cell-category"><span class="academy-alchemy-category-chip" data-category="' + category + '">分類</span></span>' +
          '<span class="academy-alchemy-cell academy-alchemy-cell-name"><span class="academy-alchemy-cell-name-title">霜結の霊薬 ' + i + '</span><span class="academy-alchemy-cell-name-desc">冷気属性の下地を煮詰め、星霜の粉を溶かし込む調合。</span></span>' +
          '<span class="academy-alchemy-cell academy-alchemy-cell-effect"><span class="academy-alchemy-effect">効果 +4</span></span>' +
          '<span class="academy-alchemy-cell academy-alchemy-cell-items"><span class="academy-alchemy-cost"><span class="academy-alchemy-cost-label">霜の結晶</span><span class="academy-alchemy-cost-amount">3（所持 5）</span></span></span>' +
          '<span class="academy-alchemy-cell academy-alchemy-cell-money"><span class="academy-alchemy-cost"><span class="academy-alchemy-cost-label">費用</span><span class="academy-alchemy-cost-amount">5,000（所持 9,000）</span></span></span>' +
        '</button>';
      list.append(li);
    }
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  const measure = () => win.webContents.executeJavaScript(`(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { left:+r.left.toFixed(1), top:+r.top.toFixed(1), right:+r.right.toFixed(1), bottom:+r.bottom.toFixed(1), width:+r.width.toFixed(1), height:+r.height.toFixed(1) }; };
    const stageEl = document.querySelector('.academy-alchemy-stage');
    const cs = getComputedStyle(stageEl);
    const stageComputed = { width: cs.width, height: cs.height, aspectRatio: cs.aspectRatio, alignSelf: cs.alignSelf, boxSizing: cs.boxSizing, paddingLeft: cs.paddingLeft, borderLeftWidth: cs.borderLeftWidth };
    const frameEl = document.querySelector('.academy-alchemy-frame');
    const frameCols = getComputedStyle(frameEl).gridTemplateColumns;
    const stage = rect('.academy-alchemy-stage');
    const board = rect('.academy-alchemy-board');
    const list = rect('#academy-alchemy-recipes');
    const frame = rect('.academy-alchemy-frame');
    const stageSize = getComputedStyle(document.querySelector('.academy-alchemy-screen')).getPropertyValue('--alchemy-stage-size');
    // Intersection of stage vs board/list (positive w&h => real overlap).
    const inter = (a, b) => { if (!a || !b) return null; const x = Math.max(0, Math.min(a.right,b.right) - Math.max(a.left,b.left)); const y = Math.max(0, Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top)); return { x:+x.toFixed(1), y:+y.toFixed(1), overlaps: x>1 && y>1 }; };
    return { window: { w: window.innerWidth, h: window.innerHeight }, stageSize: stageSize.trim(), stageComputed, frameCols, stage, board, list, frame, stage_x_board: inter(stage, board), stage_x_list: inter(stage, list) };
  })()`);

  const m = await measure();
  log('measure', m);
  const noOverlap = !(m.stage_x_board?.overlaps || m.stage_x_list?.overlaps);
  const borderBox = m.stageComputed?.boxSizing === 'border-box';
  const checks = [
    ['STAGE IS border-box', borderBox, `boxSizing=${m.stageComputed?.boxSizing}`],
    ['NO STAGE/BOARD OVERLAP', noOverlap, `stage_x_board=${JSON.stringify(m.stage_x_board)}`]
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
