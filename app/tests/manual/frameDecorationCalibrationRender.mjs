// Render-backed frame-decoration drag-calibration check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no DOM / real layout / pointer input), so the dev calibration tool is
// verified here against the REAL client in Electron. Not named *.test.mjs and under app/tests/manual/, so
// `npm test` skips it; run by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/frameDecorationCalibrationRender.mjs
//
// It boots a ROUTING-mode server with a deterministic LM stub, starts a game to reach the hub (so the hub's
// week/moon render has real runtime state), then RELOADS with ?calibrate=routing-hub so the dev calibration
// overlay activates on the real hub. It measures, against real layout:
//   OFF:  a plain load carries NO calibration overlay and the corners render at their baked positions.
//   ON:   ?calibrate=routing-hub injects one handle per registered corner + the export panel; the corner
//         transform matrices fold in the baked calibration offsets (the chat corners are corner_01 upright,
//         the standee corners rotated), and the export text lists the eight offset custom properties at
//         their baked values.
//   DRAG: a REAL mouse drag on the chat bottom-right handle translates that upright corner_01 ornament in
//         real time — its computed matrix gains the drag's (dx,dy) on top of the baked baseline — and the
//         panel readout reflects the new offset.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.FDC_WIN_W ?? 1200);
const WIN_H = Number(process.env.FDC_WIN_H ?? 820);
const OPENING_TEXT = '新しい週をここから始めましょう。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

function routingLmResponder({ prompt, requestIndex }) {
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'none';
  if (requestIndex === 0) return OPENING_TEXT;
  return 'ゆっくり選びましょう。';
}

async function startStubLm() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    const schemaName = body.response_format?.json_schema?.name ?? '';
    const prompt = body.messages?.[0]?.content ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else content = routingLmResponder({ prompt, requestIndex: requests.length });
    requests.push({ url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const root = await fixtureRoot('frame-decoration-calibration-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-decoration-calibration-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 200, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

async function main() {
  lm = await startStubLm();
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  const rendererErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) { rendererErrors.push(message); console.log(`renderer-error: ${message}`); } });

  // ── 0) CAL OFF: a plain load carries no calibration overlay ────────────────
  await win.loadURL(`${base}/`);
  await sleep(1000);
  const offLayer = await js(win, `document.querySelectorAll('.frame-decoration-calibration-layer').length`);
  check('OFF: no calibration overlay without ?calibrate', offLayer === 0, { layers: offLayer });

  // ── 1) Reach the routing hub so its week/moon render has real runtime state ─
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  const onHub = await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
  `);
  check('reached the routing hub (runtime state present)', onHub, { onHub });

  // ── 2) CAL ON: reload with ?calibrate=routing-hub — the overlay activates on the real hub ──
  await win.loadURL(`${base}/?calibrate=routing-hub`);
  const built = await waitFor(win, `
    !!document.querySelector('.frame-decoration-calibration-layer')
    && document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && document.querySelectorAll('.frame-decoration-calibration-handle').length === 4
  `);
  const shell = await js(win, `(() => {
    const handles = [...document.querySelectorAll('.frame-decoration-calibration-handle')];
    return {
      layer: !!document.querySelector('.frame-decoration-calibration-layer'),
      hubActive: document.querySelector('#routing-hub-screen')?.classList.contains('active'),
      handleCount: handles.length,
      labels: handles.map((h) => h.querySelector('.frame-decoration-calibration-handle-label')?.textContent),
      panel: !!document.querySelector('.frame-decoration-calibration-panel'),
      exportText: document.querySelector('.frame-decoration-calibration-export')?.value || ''
    };
  })()`);
  log('shell', shell);
  check('ON: overlay activates on the hub with one handle per registered corner + export panel',
    built && shell.handleCount === 4 && shell.panel && shell.labels.filter(Boolean).length === 4,
    { handleCount: shell.handleCount, labels: shell.labels, panel: shell.panel });
  const exportHasAllVars = [
    ['--rh-standee-corner-tl-dx', '-1px'], ['--rh-standee-corner-tl-dy', '-6px'],
    ['--rh-standee-corner-br-dx', '2px'], ['--rh-standee-corner-br-dy', '6px'],
    ['--rh-chat-corner-tl-dx', '-6px'], ['--rh-chat-corner-tl-dy', '-8px'],
    ['--rh-chat-corner-br-dx', '7px'], ['--rh-chat-corner-br-dy', '9px']
  ].every(([v, value]) => shell.exportText.includes(`${v}: ${value};`));
  check('ON: export lists all eight offset custom properties at their baked values (bake-ready)',
    exportHasAllVars, { exportText: shell.exportText });

  // ── 3) Baked baseline: with calibration active but not yet dragged, the corners render with the baked
  //       offsets folded into their transforms (chat BR = corner_01 as the 180° point reflection scale(-1,-1)
  //       + translate(7,9); standee ::after = corner_02 rotate(90deg) + translate(2,6)). ──
  const norm = (t) => t.replace(/\s+/g, '');
  const probe = () => js(win, `(() => {
    const norm = (t) => t.replace(/\\s+/g, '');
    const chatBR = document.querySelector('.routing-hub-corner-br');
    const afterCs = getComputedStyle(document.querySelector('.routing-hub-standee-frame'), '::after');
    return {
      chatBR: norm(getComputedStyle(chatBR).transform),
      standeeAfter: norm(afterCs.transform)
    };
  })()`);
  const baked = await probe();
  log('baked_offset', baked);
  check('ON: chat BR ornament = corner_01 point-reflected (scale(-1,-1)) + baked translate(7,9) => matrix(-1,0,0,-1,7,9)',
    baked.chatBR === 'matrix(-1,0,0,-1,7,9)', { chatBR: baked.chatBR });
  check('ON: standee ::after ornament = corner_02 rotate(90deg) + baked translate(2,6) => matrix(0,1,-1,0,2,6)',
    baked.standeeAfter === 'matrix(0,1,-1,0,2,6)', { standeeAfter: baked.standeeAfter });

  // ── 4) REAL DRAG: drag the chat bottom-right handle and measure the ornament move in real layout ──
  const DX = 24;
  const DY = 16;
  // The chat BR corner ships baked to translate(7,9) (style.css .routing-hub-screen), so the drag lands on
  // top of that baseline: the final offset is (baseline + drag).
  const BAKED_BR_DX = 7;
  const BAKED_BR_DY = 9;
  const handleCenter = await js(win, `(() => {
    const h = document.querySelector('.frame-decoration-calibration-handle[data-calibration-id="routing-hub-chat-corner-br"]');
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  // Drive a REAL pointer drag through the actual handler via CDP Input events (a hidden window ignores
  // webContents.sendInputEvent, and a dispatched PointerEvent can't satisfy setPointerCapture — CDP creates a
  // genuine pointer, so pointerdown/capture/pointermove/pointerup fire exactly as under a mouse).
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const mouse = (type, x, y, buttons) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse('mousePressed', handleCenter.x, handleCenter.y, 1);
  await sleep(40);
  for (let step = 1; step <= 4; step += 1) {
    await mouse('mouseMoved', handleCenter.x + (DX * step) / 4, handleCenter.y + (DY * step) / 4, 1);
    await sleep(30);
  }
  await mouse('mouseReleased', handleCenter.x + DX, handleCenter.y + DY, 0);
  await sleep(120);
  try { dbg.detach(); } catch { /* noop */ }
  const dragged = await js(win, `(() => {
    const norm = (t) => t.replace(/\\s+/g, '');
    const chatBR = document.querySelector('.routing-hub-corner-br');
    const m = norm(getComputedStyle(chatBR).transform).match(/^matrix\\(([^)]*)\\)$/);
    const parts = m ? m[1].split(',').map(Number) : [];
    const host = document.querySelector('.routing-hub-corner-br');
    return {
      matrixParts: parts,
      inlineDx: host.style.getPropertyValue('--rh-chat-corner-br-dx'),
      inlineDy: host.style.getPropertyValue('--rh-chat-corner-br-dy'),
      exportText: document.querySelector('.frame-decoration-calibration-export')?.value || ''
    };
  })()`);
  log('dragged', dragged);
  // matrix(a,b,c,d,e,f): the chat BR corner_01 ships as the 180° point reflection scale(-1,-1) so it keeps
  // a=-1,d=-1; the drag offset (baked baseline + drag) still lands in e (x) and f (y) because the calibration
  // translate is composed IN FRONT of the flip.
  const [a, , , d, e, f] = dragged.matrixParts;
  check('DRAG: the chat BR ornament translated by the drag delta on top of its baked baseline (e≈baseline+dx, f≈baseline+dy)',
    Math.abs(e - (BAKED_BR_DX + DX)) <= 4 && Math.abs(f - (BAKED_BR_DY + DY)) <= 4,
    { e, f, expected: { e: BAKED_BR_DX + DX, f: BAKED_BR_DY + DY } });
  check('DRAG: the ornament kept its shipped scale(-1,-1) point reflection while translating (a=-1, d=-1)',
    a === -1 && d === -1, { a, d });
  check('DRAG: the export/readout reflects the new offset (moved off the baked 7px baseline)',
    /--rh-chat-corner-br-dx: \d+px;/.test(dragged.exportText) && !dragged.exportText.includes('--rh-chat-corner-br-dx: 7px;'),
    { inlineDx: dragged.inlineDx, inlineDy: dragged.inlineDy });

  // ── 5) RESET restores the captured baseline (the baked 7px/9px shipped default), not a hardcoded 0 ──
  await js(win, `document.querySelectorAll('.frame-decoration-calibration-actions button')[1].click(); true`);
  await sleep(80);
  const afterReset = await js(win, `(() => {
    const norm = (t) => t.replace(/\\s+/g, '');
    const host = document.querySelector('.routing-hub-corner-br');
    return {
      chatBR: norm(getComputedStyle(host).transform),
      inlineDx: host.style.getPropertyValue('--rh-chat-corner-br-dx'),
      inlineDy: host.style.getPropertyValue('--rh-chat-corner-br-dy'),
      exportBaseline: (document.querySelector('.frame-decoration-calibration-export')?.value || '').includes('--rh-chat-corner-br-dx: 7px;')
    };
  })()`);
  log('after_reset', afterReset);
  check('RESET (既定に戻す): the ornament returns to its captured baked baseline (7px/9px), matrix + export back to baseline',
    afterReset.chatBR === 'matrix(-1,0,0,-1,7,9)' && afterReset.inlineDx === '7px' && afterReset.inlineDy === '9px' && afterReset.exportBaseline,
    afterReset);

  const shotPath = path.join(os.tmpdir(), 'frame-decoration-calibration-render.png');
  try { await fs.writeFile(shotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${shotPath}`); }
  catch (error) { console.log(`screenshot: FAILED ${error?.message ?? error}`); }

  // ── 5b) CAL ON (academy-map): the tool's SECOND kind — map pins (% coordinates) + the four frame corners ──
  // The game started above persisted runtime state (field locations + elapsed_weeks). Reloading into the map
  // renders the real pins; the tool binds a handle to EVERY truth-source pin — a live node where one rendered,
  // a synthesized dashed marker where none did (event stages / stages absent from the field) — so all are
  // draggable, not merely exported.
  await win.loadURL(`${base}/?calibrate=academy-map`);
  const mapBuilt = await waitFor(win, `
    !!document.querySelector('.frame-decoration-calibration-layer')
    && document.querySelector('#academy-map-screen')?.classList.contains('active')
    && document.querySelectorAll('.frame-decoration-calibration-handle--pin').length > 0
  `);
  const mapShell = await js(win, `(() => {
    const pinHandles = [...document.querySelectorAll('.frame-decoration-calibration-handle--pin')];
    const cornerHandles = [...document.querySelectorAll('.frame-decoration-calibration-handle:not(.frame-decoration-calibration-handle--pin)')];
    const nodeCount = document.querySelectorAll('#academy-map-stage-layer .academy-map-node').length;
    const syntheticCount = document.querySelectorAll('#academy-map-stage-layer .academy-map-node--calibration-synthetic').length;
    const pinExport = document.querySelector('.frame-decoration-calibration-pin-export')?.value || '';
    const exportPinCount = pinExport.split('\\n').filter((l) => /: \\{ x:/.test(l)).length;
    const pinIds = pinHandles.map((h) => h.dataset.calibrationPinId);
    return {
      mapActive: document.querySelector('#academy-map-screen')?.classList.contains('active'),
      pinHandleCount: pinHandles.length,
      nodeCount,
      syntheticCount,
      exportPinCount,
      pinIds,
      cornerIds: cornerHandles.map((h) => h.dataset.calibrationId).sort(),
      pinExport,
      cornerExport: document.querySelector('.frame-decoration-calibration-export')?.value || ''
    };
  })()`);
  log('map_shell', { pinHandleCount: mapShell.pinHandleCount, nodeCount: mapShell.nodeCount, syntheticCount: mapShell.syntheticCount, exportPinCount: mapShell.exportPinCount });
  const everyExportedPinDraggable = ['courtyard_fountain', 'academy_shop', 'main_hall_runaway_golem', 'sealed_ritual_room', 'festival_plaza_night', 'mirror_hall']
    .every((id) => mapShell.pinIds.includes(id));
  check('ON(academy-map): EVERY truth-source pin (all 33 stages + shop) has a drag handle — including the event stages the normal map never draws',
    mapBuilt && mapShell.pinHandleCount === mapShell.exportPinCount && mapShell.pinHandleCount === mapShell.nodeCount && mapShell.pinHandleCount >= 33 && mapShell.syntheticCount > 0 && everyExportedPinDraggable,
    { pinHandleCount: mapShell.pinHandleCount, exportPinCount: mapShell.exportPinCount, nodeCount: mapShell.nodeCount, syntheticCount: mapShell.syntheticCount, everyExportedPinDraggable });
  check('ON(academy-map): the four map frame corners (tl/tr/bl/br) each get a handle',
    JSON.stringify(mapShell.cornerIds) === JSON.stringify(['academy-map-corner-bl', 'academy-map-corner-br', 'academy-map-corner-tl', 'academy-map-corner-tr']),
    { cornerIds: mapShell.cornerIds });
  check('ON(academy-map): the pin export is a paste-ready JS object carrying the seed coordinates (33 stages + shop)',
    mapShell.pinExport.startsWith('const academyMapStagePinCoordinates = {')
    && mapShell.pinExport.includes('courtyard_fountain: { x: 50.4, y: 42.3 }')
    && mapShell.pinExport.includes('academy_shop: { x: 31, y: 29.6 }')
    && mapShell.pinExport.includes('main_hall_runaway_golem: { x: 5.6, y: 92.2 }'),
    { head: mapShell.pinExport.slice(0, 72) });
  check('ON(academy-map): the corner export lists the four --am-corner offsets at their baked 0px baseline',
    ['--am-corner-tl-dx', '--am-corner-tr-dx', '--am-corner-bl-dx', '--am-corner-br-dy'].every((v) => mapShell.cornerExport.includes(`${v}: 0px;`)),
    { cornerExport: mapShell.cornerExport.slice(0, 140) });

  // ── 5c) REAL DRAG an EVENT pin (sealed_ritual_room — never drawn by the normal map, so a synthesized marker):
  //       it moves by a percentage of the map image live, and its export line updates. This proves the event
  //       stages, not just the rendered ones, are draggable. ──
  const PIN_DX = 40;
  const PIN_DY = 24;
  const pinBefore = await js(win, `(() => {
    const h = document.querySelector('.frame-decoration-calibration-handle--pin[data-calibration-pin-id="sealed_ritual_room"]');
    const hr = h.getBoundingClientRect();
    const hx = hr.left + hr.width / 2, hy = hr.top + hr.height / 2;
    const container = document.querySelector('#academy-map-stage-layer').getBoundingClientRect();
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    let index = -1, best = Infinity;
    nodes.forEach((n, i) => { const r = n.getBoundingClientRect(); const d = Math.hypot((r.left + r.width / 2) - hx, r.bottom - hy); if (d < best) { best = d; index = i; } });
    const line = (document.querySelector('.frame-decoration-calibration-pin-export')?.value || '').split('\\n').find((l) => l.includes(h.dataset.calibrationPinId + ':')) || '';
    return { pinId: h.dataset.calibrationPinId, index, hx: Math.round(hx), hy: Math.round(hy), cw: container.width, ch: container.height,
      left: nodes[index].style.left, top: nodes[index].style.top, line };
  })()`);
  log('pin_before', pinBefore);
  const pdbg = win.webContents.debugger;
  if (!pdbg.isAttached()) pdbg.attach('1.3');
  const pmouse = (type, x, y, buttons) => pdbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await pmouse('mousePressed', pinBefore.hx, pinBefore.hy, 1);
  await sleep(40);
  for (let step = 1; step <= 4; step += 1) { await pmouse('mouseMoved', pinBefore.hx + (PIN_DX * step) / 4, pinBefore.hy + (PIN_DY * step) / 4, 1); await sleep(30); }
  await pmouse('mouseReleased', pinBefore.hx + PIN_DX, pinBefore.hy + PIN_DY, 0);
  await sleep(120);
  try { pdbg.detach(); } catch { /* noop */ }
  const pinAfter = await js(win, `(() => {
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    const node = nodes[${pinBefore.index}];
    const pinId = ${JSON.stringify(pinBefore.pinId)};
    const line = (document.querySelector('.frame-decoration-calibration-pin-export')?.value || '').split('\\n').find((l) => l.includes(pinId + ':')) || '';
    return { left: node.style.left, top: node.style.top, line };
  })()`);
  log('pin_after', pinAfter);
  const expectDxPct = (PIN_DX / pinBefore.cw) * 100;
  const expectDyPct = (PIN_DY / pinBefore.ch) * 100;
  const beforeLeftPct = Number.parseFloat(pinBefore.left);
  const afterLeftPct = Number.parseFloat(pinAfter.left);
  const afterTopPct = Number.parseFloat(pinAfter.top);
  const beforeTopPct = Number.parseFloat(pinBefore.top);
  check('DRAG(academy-map pin): the live pin moved right/down by the pointer delta expressed as a % of the map image',
    Math.abs((afterLeftPct - beforeLeftPct) - expectDxPct) <= 1.0 && Math.abs((afterTopPct - beforeTopPct) - expectDyPct) <= 1.0,
    { before: { left: pinBefore.left, top: pinBefore.top }, after: { left: pinAfter.left, top: pinAfter.top }, expectDxPct: Number(expectDxPct.toFixed(2)), expectDyPct: Number(expectDyPct.toFixed(2)) });
  check('DRAG(academy-map pin): the JS export line for the dragged pin updated off its seed value',
    pinAfter.line !== pinBefore.line && new RegExp(`${pinBefore.pinId}: \\{ x: -?\\d`).test(pinAfter.line),
    { before: pinBefore.line.trim(), after: pinAfter.line.trim() });

  // ── 5d) REAL DRAG a map corner: it writes the --am-corner-* offset off its 0px baseline ──
  const cornerCenter = await js(win, `(() => {
    const h = document.querySelector('.frame-decoration-calibration-handle[data-calibration-id="academy-map-corner-tl"]');
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const cdbg = win.webContents.debugger;
  if (!cdbg.isAttached()) cdbg.attach('1.3');
  const cmouse = (type, x, y, buttons) => cdbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await cmouse('mousePressed', cornerCenter.x, cornerCenter.y, 1);
  await sleep(40);
  for (let step = 1; step <= 4; step += 1) { await cmouse('mouseMoved', cornerCenter.x + (12 * step) / 4, cornerCenter.y + (8 * step) / 4, 1); await sleep(30); }
  await cmouse('mouseReleased', cornerCenter.x + 12, cornerCenter.y + 8, 0);
  await sleep(120);
  try { cdbg.detach(); } catch { /* noop */ }
  const cornerAfter = await js(win, `(() => {
    const host = document.querySelector('.academy-map-corner-tl');
    return { dx: host.style.getPropertyValue('--am-corner-tl-dx'), dy: host.style.getPropertyValue('--am-corner-tl-dy'),
      exportMoved: !(document.querySelector('.frame-decoration-calibration-export')?.value || '').includes('--am-corner-tl-dx: 0px;') };
  })()`);
  log('map_corner_after', cornerAfter);
  check('DRAG(academy-map corner): the tl frame ornament writes --am-corner-tl-* off its 0px baseline and the CSS export follows',
    /^-?\d+px$/.test(cornerAfter.dx) && cornerAfter.dx !== '0px' && cornerAfter.exportMoved,
    cornerAfter);

  // ── 5e) RESET (academy-map): pins return to their seed % and corners to their 0px baseline ──
  await js(win, `document.querySelector('.frame-decoration-calibration-actions [data-calibration-action="reset"]').click(); true`);
  await sleep(90);
  const mapReset = await js(win, `(() => {
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    const node = nodes[${pinBefore.index}];
    const host = document.querySelector('.academy-map-corner-tl');
    return { left: node.style.left, top: node.style.top, cornerDx: host.style.getPropertyValue('--am-corner-tl-dx'),
      pinExportBaseline: (document.querySelector('.frame-decoration-calibration-pin-export')?.value || '').includes(${JSON.stringify(pinBefore.line.trim())}),
      cornerExportBaseline: (document.querySelector('.frame-decoration-calibration-export')?.value || '').includes('--am-corner-tl-dx: 0px;') };
  })()`);
  log('map_reset', mapReset);
  check('RESET(academy-map): the dragged pin returns to its seed % (node + export) and the corner returns to 0px',
    mapReset.left === pinBefore.left && mapReset.top === pinBefore.top && mapReset.pinExportBaseline
    && mapReset.cornerDx === '0px' && mapReset.cornerExportBaseline,
    mapReset);

  // ── 5f) CAL ON (academy-map + region=sanrin): the SAME map DOM screen, switched to the 山林 region so the sanrin
  //       background + sanrin pins render, and the pin export bakes back into sanrinMapStagePinCoordinates. This is
  //       the additive registration this task adds — the academy pins are NOT shown here (only the active region's). ──
  await win.loadURL(`${base}/?calibrate=academy-map&region=sanrin`);
  const sanrinBuilt = await waitFor(win, `
    !!document.querySelector('.frame-decoration-calibration-layer')
    && document.querySelector('#academy-map-screen')?.classList.contains('active')
    && document.querySelector('.academy-map-canvas')?.dataset.mapRegion === 'sanrin'
    && document.querySelectorAll('.frame-decoration-calibration-handle--pin').length > 0
  `);
  const sanrinShell = await js(win, `(() => {
    const pinHandles = [...document.querySelectorAll('.frame-decoration-calibration-handle--pin')];
    const nodeCount = document.querySelectorAll('#academy-map-stage-layer .academy-map-node').length;
    const pinExport = document.querySelector('.frame-decoration-calibration-pin-export')?.value || '';
    const exportPinCount = pinExport.split('\\n').filter((l) => /: \\{ x:/.test(l)).length;
    return {
      region: document.querySelector('.academy-map-canvas')?.dataset.mapRegion,
      pinHandleCount: pinHandles.length,
      nodeCount,
      exportPinCount,
      pinIds: pinHandles.map((h) => h.dataset.calibrationPinId),
      pinExport
    };
  })()`);
  log('sanrin_shell', { region: sanrinShell.region, pinHandleCount: sanrinShell.pinHandleCount, nodeCount: sanrinShell.nodeCount, exportPinCount: sanrinShell.exportPinCount });
  const everySanrinPinDraggable = ['sanrin_trailhead', 'sanrin_conifer_forest', 'sanrin_stream_bank', 'sanrin_mossy_shrine', 'sanrin_gathering']
    .every((id) => sanrinShell.pinIds.includes(id));
  check('ON(region=sanrin): the map switched to the 山林 region and every sanrin truth-source pin (5) has a drag handle',
    sanrinBuilt && sanrinShell.region === 'sanrin' && sanrinShell.pinHandleCount === 5 && sanrinShell.exportPinCount === 5
    && sanrinShell.pinHandleCount === sanrinShell.nodeCount && everySanrinPinDraggable,
    { region: sanrinShell.region, pinHandleCount: sanrinShell.pinHandleCount, nodeCount: sanrinShell.nodeCount, exportPinCount: sanrinShell.exportPinCount, everySanrinPinDraggable });
  check('ON(region=sanrin): the pin export is a paste-ready JS object that bakes back into sanrinMapStagePinCoordinates',
    sanrinShell.pinExport.startsWith('const sanrinMapStagePinCoordinates = {')
    && sanrinShell.pinExport.includes('sanrin_trailhead: { x: 29.9, y: 79.3 }')
    && sanrinShell.pinExport.includes('sanrin_gathering: { x: 49, y: 28 }'),
    { head: sanrinShell.pinExport.slice(0, 80) });

  // REAL DRAG a sanrin pin: it moves by a % of the map image and its export line updates off the seed value.
  const S_DX = 40;
  const S_DY = 24;
  const sanrinPinBefore = await js(win, `(() => {
    const h = document.querySelector('.frame-decoration-calibration-handle--pin[data-calibration-pin-id="sanrin_trailhead"]');
    const hr = h.getBoundingClientRect();
    const hx = hr.left + hr.width / 2, hy = hr.top + hr.height / 2;
    const container = document.querySelector('#academy-map-stage-layer').getBoundingClientRect();
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    let index = -1, best = Infinity;
    nodes.forEach((n, i) => { const r = n.getBoundingClientRect(); const d = Math.hypot((r.left + r.width / 2) - hx, r.bottom - hy); if (d < best) { best = d; index = i; } });
    const line = (document.querySelector('.frame-decoration-calibration-pin-export')?.value || '').split('\\n').find((l) => l.includes('sanrin_trailhead:')) || '';
    return { index, hx: Math.round(hx), hy: Math.round(hy), cw: container.width, ch: container.height, left: nodes[index].style.left, top: nodes[index].style.top, line };
  })()`);
  log('sanrin_pin_before', sanrinPinBefore);
  const sdbg = win.webContents.debugger;
  if (!sdbg.isAttached()) sdbg.attach('1.3');
  const smouse = (type, x, y, buttons) => sdbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await smouse('mousePressed', sanrinPinBefore.hx, sanrinPinBefore.hy, 1);
  await sleep(40);
  for (let step = 1; step <= 4; step += 1) { await smouse('mouseMoved', sanrinPinBefore.hx + (S_DX * step) / 4, sanrinPinBefore.hy + (S_DY * step) / 4, 1); await sleep(30); }
  await smouse('mouseReleased', sanrinPinBefore.hx + S_DX, sanrinPinBefore.hy + S_DY, 0);
  await sleep(120);
  try { sdbg.detach(); } catch { /* noop */ }
  const sanrinPinAfter = await js(win, `(() => {
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    const node = nodes[${sanrinPinBefore.index}];
    const line = (document.querySelector('.frame-decoration-calibration-pin-export')?.value || '').split('\\n').find((l) => l.includes('sanrin_trailhead:')) || '';
    return { left: node.style.left, top: node.style.top, line };
  })()`);
  log('sanrin_pin_after', sanrinPinAfter);
  const sExpectDxPct = (S_DX / sanrinPinBefore.cw) * 100;
  const sExpectDyPct = (S_DY / sanrinPinBefore.ch) * 100;
  check('DRAG(region=sanrin pin): the live sanrin pin moved right/down by the pointer delta as a % of the map image, and its export line updated',
    Math.abs((Number.parseFloat(sanrinPinAfter.left) - Number.parseFloat(sanrinPinBefore.left)) - sExpectDxPct) <= 1.0
    && Math.abs((Number.parseFloat(sanrinPinAfter.top) - Number.parseFloat(sanrinPinBefore.top)) - sExpectDyPct) <= 1.0
    && sanrinPinAfter.line !== sanrinPinBefore.line && /sanrin_trailhead: \{ x: -?\d/.test(sanrinPinAfter.line),
    { before: { left: sanrinPinBefore.left, top: sanrinPinBefore.top }, after: { left: sanrinPinAfter.left, top: sanrinPinAfter.top }, afterLine: sanrinPinAfter.line.trim() });

  const sanrinShot = path.join(os.tmpdir(), 'frame-decoration-calibration-sanrin.png');
  try { await fs.writeFile(sanrinShot, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${sanrinShot}`); }
  catch (error) { console.log(`screenshot: FAILED ${error?.message ?? error}`); }

  // ── 5g) FAIL-FAST (region): an unknown ?region= id aborts activation (no overlay) and surfaces the throw ──
  rendererErrors.length = 0;
  await win.loadURL(`${base}/?calibrate=academy-map&region=__no_such_region__`);
  await sleep(1200);
  const badRegionLayers = await js(win, `document.querySelectorAll('.frame-decoration-calibration-layer').length`);
  const badRegionSurfaced = rendererErrors.some((m) => /is not a known map region/.test(m));
  check('FAIL-FAST(region): an unknown ?region= id builds NO overlay (activation aborted) and the throw is surfaced',
    badRegionLayers === 0 && badRegionSurfaced, { layers: badRegionLayers, surfaced: badRegionSurfaced, sampleErrors: rendererErrors.slice(0, 2) });

  // ── 6) DOM-side fail-fast: a non-px offset custom property aborts activation (no overlay) and surfaces the throw ──
  // Inject a bad default (--rh-chat-corner-br-dx: 1rem) at document-start via CDP, then reactivate on the hub
  // (runtime state still present from the game above). resolveCalibrationTarget must reject the non-px value.
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: "(() => { const inject = () => { const s = document.createElement('style'); s.textContent = '.routing-hub-screen{--rh-chat-corner-br-dx:1rem !important}'; (document.head || document.documentElement).appendChild(s); }; if (document.head) inject(); else document.addEventListener('DOMContentLoaded', inject); })();"
  });
  rendererErrors.length = 0;
  await win.loadURL(`${base}/?calibrate=routing-hub`);
  await sleep(1500);
  const nonPxLayers = await js(win, `document.querySelectorAll('.frame-decoration-calibration-layer').length`);
  const nonPxSurfaced = rendererErrors.some((m) => /must be a px length/.test(m));
  check('FAIL-FAST: a non-px offset custom property (1rem) aborts activation (no overlay) and surfaces the throw',
    nonPxLayers === 0 && nonPxSurfaced, { layers: nonPxLayers, surfaced: nonPxSurfaced, sampleErrors: rendererErrors.slice(0, 2) });
  try { dbg.detach(); } catch { /* noop */ }

  // ── 7) DOM-side fail-fast: an unknown ?calibrate screen aborts activation (no overlay) and surfaces the throw ──
  rendererErrors.length = 0;
  await win.loadURL(`${base}/?calibrate=__no_such_screen__`);
  await sleep(1200);
  const failFast = await js(win, `document.querySelectorAll('.frame-decoration-calibration-layer').length`);
  const surfaced = rendererErrors.some((m) => /no calibration targets registered for screen/.test(m));
  check('FAIL-FAST: an unknown ?calibrate screen builds NO overlay (activation aborted, not degraded) and the throw is surfaced',
    failFast === 0 && surfaced, { layers: failFast, surfaced, sampleErrors: rendererErrors.slice(0, 2) });

  void norm;
  const failed = results.filter((r) => !r.pass);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { exitCode = 1; console.log(`FAILED: ${failed.map((r) => r.name).join(' | ')}`); }
  app.quit();
}

// NOTE: main() is fired without a top-level await. Awaiting it at module top would deadlock — Electron
// does not emit 'ready' (which app.whenReady() awaits inside main) until the initial module script finishes
// evaluating, so a top-level `await main()` that waits on whenReady would wait forever. Cleanup runs in the
// 'quit' handler after app.quit().
app.on('window-all-closed', () => {});
main().catch((error) => { console.error('render check crashed:', error); exitCode = 1; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* noop */ }
  try { lm?.server?.close(); } catch { /* noop */ }
  for (const dir of cleanupPaths) { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* noop */ } }
  process.exit(exitCode);
});
