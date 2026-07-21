// Render-backed 錬成室 slot-row layout check (Electron / real Blink layout).
//
// `node --test` cannot lay out a DOM, so the reported "3 slots break / don't spend the width when every child shows
// all 11 parameters" layout bug is verified here against real layout. Not a *.test.mjs (npm test skips it); run by hand:
//   ./node_modules/.bin/electron app/tests/manual/atelierSlotsRender.mjs
//   AT_WIN_W=1680 AT_WIN_H=900 ./node_modules/.bin/electron app/tests/manual/atelierSlotsRender.mjs
//
// It loads the real client shell, forces the atelier arrival screen active, injects the うちの子 slot row with the
// CURRENT markup for four scenarios (3 active / 1 active + 2 empty, each also once with the freshly-born
// first-conversation slot carrying academy-atelier-slot--birthing), and measures, per slot:
//   - all 11 parameters are present (reachable),
//   - no horizontal overflow of the slot card or its parameter grid (the 崩れ),
//   - head → parameters → actions stack without vertical overlap,
//   - the 会いに行く button is the same text and the same width/height whether or not the slot is the birthed
//     first-conversation one (there is no long first-conversation label that broke the card),
// and, per scenario, that the filled slots spend the full board width (the auto-fit fix; auto-fill left phantom
// tracks so the slots huddled in the left columns). A wide window (AT_WIN_W=1680) makes the width regression obvious.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WIN_W = Number(process.env.AT_WIN_W ?? 1280);
const WIN_H = Number(process.env.AT_WIN_H ?? 720);

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function minRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atelier-render-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'atelier', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  return root;
}
const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-http-cache');

let server;
let exitCode = 0;

// The 11 server-authoritative labels (magic 6 + abilities 5), matching app/src/parameters.mjs — used only to build a
// realistic injected card. Values span the low/mid/high meter tiers.
const LABELS = ['光魔法習熟度', '闇魔法習熟度', '火魔法習熟度', '水魔法習熟度', '土魔法習熟度', '風魔法習熟度',
  '筋力', '瞬発力', '学力', '魔力', 'カリスマ'];

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

  const scenarios = [
    { name: '3 active (full)', active: 3, birthed: -1 },
    { name: '1 active + 2 empty', active: 1, birthed: -1 },
    { name: '3 active, slot0 first-conversation', active: 3, birthed: 0 },
    { name: '1 active first-conversation', active: 1, birthed: 0 }
  ];

  for (const scenario of scenarios) {
    await win.webContents.executeJavaScript(`(() => {
      for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
      const screen = document.querySelector('#academy-atelier-screen');
      screen.classList.add('active');
      const labels = ${JSON.stringify(LABELS)};
      const list = document.querySelector('#academy-atelier-slots');
      list.replaceChildren();
      const MAX = 3, ACTIVE = ${scenario.active}, BIRTHED = ${scenario.birthed};
      const px1 = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
      for (let i = 0; i < MAX; i += 1) {
        const li = document.createElement('li');
        if (i >= ACTIVE) {
          li.className = 'academy-atelier-slot academy-atelier-slot--empty';
          const p = document.createElement('p');
          p.className = 'academy-atelier-slot-empty-label';
          p.textContent = '空き枠';
          li.append(p);
          list.append(li);
          continue;
        }
        li.className = 'academy-atelier-slot academy-atelier-slot--active' + (i === BIRTHED ? ' academy-atelier-slot--birthing' : '');
        li.dataset.homunculusId = 'h' + i;
        const head = document.createElement('div');
        head.className = 'academy-atelier-slot-head';
        const face = document.createElement('div');
        face.className = 'academy-atelier-slot-face';
        const img = document.createElement('img');
        img.src = px1; img.alt = '';
        face.append(img);
        const identity = document.createElement('div');
        identity.className = 'academy-atelier-slot-identity';
        const name = document.createElement('p');
        name.className = 'academy-atelier-slot-name';
        name.textContent = 'ホムンクルス' + (i + 1);
        const meta = document.createElement('p');
        meta.className = 'academy-atelier-slot-meta';
        meta.textContent = '第3週生まれ・好感度 50';
        identity.append(name, meta);
        head.append(face, identity);
        const params = document.createElement('ul');
        params.className = 'academy-atelier-parameters';
        for (let k = 0; k < labels.length; k += 1) {
          const value = (k * 9 + 12) % 101;
          const pli = document.createElement('li');
          pli.className = 'academy-atelier-parameter';
          const lab = document.createElement('span');
          lab.className = 'academy-atelier-parameter-label';
          lab.textContent = labels[k];
          const meter = document.createElement('meter');
          meter.className = 'academy-atelier-parameter-meter';
          meter.min = 0; meter.max = 100; meter.low = 33; meter.high = 66; meter.optimum = 100; meter.value = value;
          const val = document.createElement('strong');
          val.className = 'academy-atelier-parameter-value';
          val.textContent = String(value);
          pli.append(lab, meter, val);
          params.append(pli);
        }
        const actions = document.createElement('div');
        actions.className = 'academy-atelier-slot-actions';
        const talk = document.createElement('button');
        talk.type = 'button'; talk.className = 'academy-atelier-slot-talk'; talk.textContent = '会いに行く';
        const farewell = document.createElement('button');
        farewell.type = 'button'; farewell.className = 'academy-atelier-slot-farewell'; farewell.textContent = 'お別れ';
        actions.append(talk, farewell);
        li.append(head, params, actions);
        list.append(li);
      }
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));

    const m = await win.webContents.executeJavaScript(`(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left:+r.left.toFixed(1), top:+r.top.toFixed(1), right:+r.right.toFixed(1), bottom:+r.bottom.toFixed(1), width:+r.width.toFixed(1), height:+r.height.toFixed(1) }; };
      const ul = document.querySelector('#academy-atelier-slots');
      const ulRect = rect(ul);
      const cols = getComputedStyle(ul).gridTemplateColumns;
      const slots = [...ul.querySelectorAll(':scope > .academy-atelier-slot')];
      const perSlot = slots.map((slot) => {
        const active = slot.classList.contains('academy-atelier-slot--active');
        const params = slot.querySelector(':scope > .academy-atelier-parameters');
        const head = slot.querySelector(':scope > .academy-atelier-slot-head');
        const actions = slot.querySelector(':scope > .academy-atelier-slot-actions');
        const paramCount = params ? params.querySelectorAll(':scope > .academy-atelier-parameter').length : 0;
        // Overflow: content wider than the padding box (allow 1px rounding).
        const slotOverflow = slot.scrollWidth - slot.clientWidth;
        const paramsOverflow = params ? params.scrollWidth - params.clientWidth : 0;
        // Any parameter cell spilling past the parameters list content box on the right.
        let cellSpill = 0;
        if (params) {
          const pr = params.getBoundingClientRect();
          for (const cell of params.querySelectorAll(':scope > .academy-atelier-parameter')) {
            const cr = cell.getBoundingClientRect();
            cellSpill = Math.max(cellSpill, +(cr.right - pr.right).toFixed(1));
          }
        }
        // Vertical stacking: head above params above actions (no overlap).
        const hb = head ? head.getBoundingClientRect() : null;
        const pb = params ? params.getBoundingClientRect() : null;
        const ab = actions ? actions.getBoundingClientRect() : null;
        const stackOk = active
          ? (pb.top >= hb.bottom - 1.5 && ab.top >= pb.bottom - 1.5)
          : true;
        // 会話導線ボタン: its text + rendered box, to check first-conversation (birthing) vs repeat identity.
        const birthing = slot.classList.contains('academy-atelier-slot--birthing');
        const talk = slot.querySelector(':scope > .academy-atelier-slot-actions > .academy-atelier-slot-talk');
        const talkRect = talk ? talk.getBoundingClientRect() : null;
        const talkText = talk ? talk.textContent : null;
        const talkW = talkRect ? +talkRect.width.toFixed(1) : 0;
        const talkH = talkRect ? +talkRect.height.toFixed(1) : 0;
        return { active, birthing, rect: rect(slot), paramCount, slotOverflow:+slotOverflow.toFixed(1), paramsOverflow:+paramsOverflow.toFixed(1), cellSpill, stackOk, talkText, talkW, talkH };
      });
      const first = perSlot[0]?.rect, last = perSlot[perSlot.length - 1]?.rect;
      const usedWidth = (first && last) ? +(last.right - first.left).toFixed(1) : 0;
      const tops = perSlot.map((s) => s.rect.top);
      const rowSpread = +(Math.max(...tops) - Math.min(...tops)).toFixed(1);
      // Direct-background (いきなり背景) standard: the layout is edge-to-edge (padding:0) so the flat obsidian atelier
      // screen fills it with no navy-gradient border inset behind it (the frame's own padding holds the content余白).
      const layoutEl = document.querySelector('.layout');
      const layoutPadding = layoutEl ? getComputedStyle(layoutEl).padding : '';
      return { window: { w: window.innerWidth, h: window.innerHeight }, cols, ulRect, usedWidth, rowSpread, perSlot, layoutPadding };
    })()`);

    log(`measure[${scenario.name}]`, m);
    const active = m.perSlot.filter((s) => s.active);
    const checks = [
      ['ALL 11 PARAMS PRESENT', active.every((s) => s.paramCount === 11), `counts=${JSON.stringify(active.map((s) => s.paramCount))}`],
      ['NO SLOT H-OVERFLOW', m.perSlot.every((s) => s.slotOverflow <= 1), `max=${Math.max(...m.perSlot.map((s) => s.slotOverflow))}px`],
      ['NO PARAM-GRID H-OVERFLOW', active.every((s) => s.paramsOverflow <= 1 && s.cellSpill <= 1), `overflow=${JSON.stringify(active.map((s) => s.paramsOverflow))} spill=${JSON.stringify(active.map((s) => s.cellSpill))}`],
      ['HEAD→PARAMS→ACTIONS STACKED', active.every((s) => s.stackOk)],
      ['SLOTS SPEND FULL WIDTH', m.usedWidth >= m.ulRect.width - 2, `used=${m.usedWidth} ul=${m.ulRect.width}`],
      ['SLOTS ON ONE ROW', m.rowSpread <= 4, `spread=${m.rowSpread}px`],
      ['TALK BUTTON UNIFORM TEXT (会いに行く)', active.every((s) => s.talkText === '会いに行く'), `texts=${JSON.stringify(active.map((s) => s.talkText))}`],
      ['TALK BUTTON UNIFORM SIZE', active.length <= 1
        || (Math.max(...active.map((s) => s.talkW)) - Math.min(...active.map((s) => s.talkW)) <= 1
          && Math.max(...active.map((s) => s.talkH)) - Math.min(...active.map((s) => s.talkH)) <= 1),
        `w=${JSON.stringify(active.map((s) => s.talkW))} h=${JSON.stringify(active.map((s) => s.talkH))} birthing=${JSON.stringify(active.map((s) => s.birthing))}`],
      ['LAYOUT EDGE-TO-EDGE (padding:0, no navy-gradient border inset)', m.layoutPadding === '0px', `layoutPadding=${m.layoutPadding}`]
    ];
    for (const [label, pass, extra] of checks) {
      console.log(`${pass ? 'PASS' : 'FAIL'}: [${scenario.name}] ${label}${extra ? ` (${extra})` : ''}`);
      if (!pass) exitCode = 1;
    }
  }

  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
