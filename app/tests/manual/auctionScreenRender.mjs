// Render-backed 競売場 (auction) screen check (Electron / real Blink layout + real client flow, stubbed API).
//
// `node --test` cannot run app.js (no fetch / DOM / real layout), so the auction screen (#academy-auction-screen)
// is verified here against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives
// under app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/auctionScreenRender.mjs
//
// It boots a self-contained STUB HTTP server (static app/public + /canonical + deterministic /api/auction/*
// responses, and the minimal boot endpoints the client refreshes) and drives the REAL auction flow against real
// Blink layout: land on #academy-auction-screen via ?initialScreen=academy-auction → the entry loading cover
// releases on the opening 口上 → the master opening + seated-bidder reactions reveal in the chat stream → the NPC
// bidders pass and the bid bar activates for the player's turn → the player raises and wins → the hammer 宣言
// reveals → the next lot → after the third lot the closed view shows the week's results + the ハブへ戻る affordance.
// The board (name / current / highest / min-increment / progress / history) and the numeric bid bar are measured
// against real layout. Per ref-camera, the harness is fire-and-forget (no top-level await main(); whenReady
// would deadlock) and drives real pointer clicks through the DOM.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.AUC_WIN_W ?? 1200);
const WIN_H = Number(process.env.AUC_WIN_H ?? 820);

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// ── Deterministic auction fixture: two seated bidders, three lots. The stub NPCs always pass, so the player
// wins every lot they raise on — a deterministic 1-lot-at-a-time walkthrough through the close. ──
const BIDDERS = [
  { character_id: 'character_001', display_name: 'セラ' },
  { character_id: 'character_002', display_name: 'リオ' }
];
const LOTS = [
  { lot_index: 0, category: 'treasure', band: 'C', name: '番所の封蝋菓子', category_label: '調合の貴重品', blurb: '曰くつきの逸話が触れ込みの小物。', initial_price: 400, min_increment: 50 },
  { lot_index: 1, category: 'weapon_amulet', band: 'B', name: '業物の剣', category_label: '武器・護符', blurb: '競売に披露された一点物の剣。', initial_price: 2000, min_increment: 100 },
  { lot_index: 2, category: 'flavor', band: 'A', name: '星図の天球儀', category_label: '愛玩の品', blurb: '手回しで星が巡る古い天球儀。', initial_price: 6000, min_increment: 300 }
];
const START_MONEY = 100000;

function freshSlot() {
  return { status: 'in_progress', current_lot_index: 0, awards: [] };
}
let slot = freshSlot();

function slotStateView() {
  return {
    phase: slot.status === 'closed' ? 'closed' : 'in_progress',
    week: 6,
    status: slot.status,
    current_lot_index: slot.current_lot_index,
    bidders: BIDDERS.map((bidder) => ({ ...bidder })),
    lots: LOTS.map((lot) => ({ ...lot })),
    awards: slot.awards.map((award) => ({ ...award }))
  };
}

function sseSpeech(res, resultPayload, utterance) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`event: status\ndata: ${JSON.stringify({ phase: 'chat_started' })}\n\n`);
  res.write(`event: assistant_complete\ndata: ${JSON.stringify({ content: utterance })}\n\n`);
  res.write(`event: result\ndata: ${JSON.stringify(resultPayload)}\n\n`);
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const STATIC_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

async function serveStatic(res, absPath) {
  try {
    const data = await fs.readFile(absPath);
    res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(absPath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

function startStubServer() {
  const json = (res, payload, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    // ── auction API stub ──
    if (p === '/api/auction/state' && req.method === 'GET') return json(res, slotStateView());
    if (p === '/api/auction/enter' && req.method === 'POST') { await readJsonBody(req); return json(res, { ...slotStateView(), post_content_screen: 'interaction' }); }
    if (p === '/api/auction/lot/opening/stream') { const b = await readJsonBody(req); const lot = LOTS[b.lot_index]; return sseSpeech(res, { lot_index: b.lot_index, utterance: `本日の品、「${lot.name}」。最低増分は${lot.min_increment}ギルより。` }, `本日の品、「${lot.name}」。最低増分は${lot.min_increment}ギルより。`); }
    if (p === '/api/auction/lot/reaction/stream') { const b = await readJsonBody(req); const bidder = BIDDERS.find((x) => x.character_id === b.character_id); return sseSpeech(res, { lot_index: b.lot_index, character_id: b.character_id, display_name: bidder.display_name, utterance: `（値踏みするように）ほう、これは。` }, `（値踏みするように）ほう、これは。`); }
    if (p === '/api/auction/lot/goad/stream') { const b = await readJsonBody(req); return sseSpeech(res, { lot_index: b.lot_index, utterance: `${b.current}ギル。さあ、まだ上はいかがか。` }, `${b.current}ギル。さあ、まだ上はいかがか。`); }
    if (p === '/api/auction/lot/hammer/stream') { const b = await readJsonBody(req); return sseSpeech(res, { lot_index: b.lot_index, utterance: `落札！ お客人のもとへ。` }, `落札！ お客人のもとへ。`); }
    if (p === '/api/auction/npc-bid' && req.method === 'POST') {
      const b = await readJsonBody(req); const bidder = BIDDERS.find((x) => x.character_id === b.character_id);
      return json(res, { lot_index: b.lot_index, character_id: b.character_id, display_name: bidder.display_name, utterance: `（そっと首を振り）今日は見送りましょう。`, action: 'pass', amount: 0, min_next: b.current + LOTS[b.lot_index].min_increment, current: b.current, highest_bidder: b.highest_bidder ?? null });
    }
    if (p === '/api/auction/bid' && req.method === 'POST') {
      const b = await readJsonBody(req);
      if (b.pass === true) return json(res, { lot_index: b.lot_index, player_active: false });
      return json(res, { lot_index: b.lot_index, current: b.current + b.add_amount, highest_bidder: 'player', money: START_MONEY });
    }
    if (p === '/api/auction/lot/resolve' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const outcome = b.winner === null ? 'passed_in' : 'awarded';
      slot.awards.push({ lot_index: b.lot_index, outcome, winner_character_id: b.winner, amount: b.amount });
      slot.current_lot_index = b.lot_index + 1;
      const closed = slot.current_lot_index >= LOTS.length;
      if (closed) slot.status = 'closed';
      return json(res, {
        resolution: { lot_index: b.lot_index, outcome, winner_character_id: b.winner, amount: b.amount, closed },
        content_result: null,
        ...(closed ? { post_content_screen: 'interaction' } : {}),
        state: slotStateView()
      });
    }

    // ── minimal boot endpoints the client refreshes (fallbacks swallow the rest) ──
    // /api/slots must resolve or the boot Promise.all rejects before applyInitialScreenOverride runs.
    if (p === '/api/slots') return json(res, { active_play_mode: { mode: 'routing' }, post_content_screen: 'interaction', slots: [] });
    if (p === '/api/state') return json(res, { elapsed_weeks: 5, training_actions_used: 0, training_actions_limit: 6 });
    // /api/field returns null so refresh()'s post-task renderField(field) is skipped (a {} would throw and reject
    // the boot Promise.all before applyInitialScreenOverride runs). The auction screen reads no field.
    if (p === '/api/field') return json(res, null);
    if (p === '/api/inventory') return json(res, { money: START_MONEY, items: [] });
    if (p === '/api/shop') return json(res, { items: [] });
    if (p === '/api/equipment') return json(res, { slots: { weapon: null, amulet: null }, instances: [], buddy: null, sales: [] });
    if (p === '/api/characters') return json(res, { characters: BIDDERS.map((b) => ({ character_id: b.character_id, display_name: b.display_name, visual_set_id: b.character_id, face_url: `/canonical/character_visual_sets/${b.character_id}/face_emotions/neutral.jpg`, standee_url: '' })), capabilities: { character_authoring: { enabled: false, reason: null, message: null } } });
    if (p === '/api/character-delete-flags') return json(res, { flagged: [] });
    if (p === '/api/settings/conversation-popup') return json(res, { cooldown_ms: 30, animation_ms: 30, academy_conversation_screen: 'day' });
    if (p.startsWith('/api/')) return json(res, {}); // catch-all: resilient refresh tasks swallow empties

    // ── static ──
    if (p.startsWith('/canonical/')) return serveStatic(res, path.join(REPO_CANONICAL, p.slice('/canonical/'.length)));
    if (p === '/' || p === '') return serveStatic(res, path.join(PUBLIC_ROOT, 'index.html'));
    return serveStatic(res, path.join(PUBLIC_ROOT, p.replace(/^\//, '')));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

async function waitFor(win, predicate, { tries = 300, intervalMs = 60 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// Play one lot: wait for the bid bar to activate (the player's turn after the NPCs pass), assert the board, then
// raise by the minimum increment and win. Returns the observed board snapshot for the lot.
async function playOneLot(win, lot) {
  const barActive = await waitFor(win, `document.querySelector('#academy-auction-bid-bar')?.dataset.active === 'true' && document.querySelector('#academy-auction-bid')?.disabled === false`, { tries: 400, intervalMs: 60 });
  const board = await js(win, `(() => ({
    name: (document.querySelector('#academy-auction-board-name')?.textContent || '').trim(),
    category: (document.querySelector('#academy-auction-board-category')?.textContent || '').trim(),
    current: (document.querySelector('#academy-auction-current')?.textContent || '').trim(),
    increment: (document.querySelector('#academy-auction-increment')?.textContent || '').trim(),
    progress: (document.querySelector('#academy-auction-lot-progress')?.textContent || '').trim(),
    streamText: (document.querySelector('#academy-auction-message-stream')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    rows: document.querySelectorAll('#academy-auction-message-stream .chat-message').length,
    faces: document.querySelectorAll('#academy-auction-message-stream .message-face img').length
  }))()`);
  check(`LOT ${lot.lot_index}: board shows the lot (name / category / increment / progress) and the reveal ran (opening + reactions with faces)`,
    barActive && board.name === lot.name && board.category === lot.category_label && board.increment === `${lot.min_increment}G`
      && board.progress.includes(`${lot.lot_index + 1} / 3`) && board.rows > 0 && board.faces > 0
      && board.streamText.includes(lot.name),
    { barActive, ...board });
  // Viewport-fit + internal-scroll measurement (the point of this task): as chat accumulates across lots, the
  // document must not grow past the viewport, the chat stream must own the internal scroll, and the board +
  // numeric bid bar must stay on-screen. Real Blink layout only (jsdom / static regex cannot measure this).
  const viewport = await js(win, `(() => {
    const doc = document.scrollingElement || document.documentElement;
    const stream = document.querySelector('#academy-auction-message-stream');
    const screen = document.querySelector('#academy-auction-screen');
    const board = document.querySelector('#academy-auction-board');
    const bar = document.querySelector('#academy-auction-bid-bar');
    const barRect = bar.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    return {
      innerH: window.innerHeight,
      docScrollH: doc.scrollHeight,
      pageOverflow: doc.scrollHeight - window.innerHeight,
      screenH: Math.round(screen.getBoundingClientRect().height),
      streamClientH: stream.clientHeight,
      streamScrollH: stream.scrollHeight,
      streamOverflows: stream.scrollHeight > stream.clientHeight + 1,
      barOnScreen: barRect.bottom <= window.innerHeight + 1 && barRect.top >= -1,
      boardOnScreen: boardRect.bottom <= window.innerHeight + 1 && boardRect.top >= -1,
      rows: document.querySelectorAll('#academy-auction-message-stream .chat-message').length
    };
  })()`);
  check(`LOT ${lot.lot_index}: page stays viewport-fit (no document overflow), chat scrolls internally, board + bid bar on-screen`,
    viewport.pageOverflow <= 1 && viewport.screenH <= viewport.innerH + 1 && viewport.barOnScreen && viewport.boardOnScreen
      && (lot.lot_index === 0 || viewport.streamOverflows),
    viewport);
  // Raise by the minimum increment and win.
  await js(win, `(() => { const i = document.querySelector('#academy-auction-bid-input'); i.value = '${lot.min_increment}'; document.querySelector('#academy-auction-bid').click(); return true; })()`);
  return board;
}

async function main() {
  server = await startStubServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await win.loadURL(`${base}/?initialScreen=academy-auction`);

  // ── 1) ENTRY: the auction screen becomes active and the board renders once the entry loading cover releases on
  // the opening 口上 stream (so wait for the board to be populated, not just the screen swap). ──
  const onScreen = await waitFor(win, `document.querySelector('#academy-auction-screen')?.classList.contains('active') && (document.querySelector('#academy-auction-board-name')?.textContent || '').trim().length > 0`, { tries: 400, intervalMs: 60 });
  const entry = await js(win, `(() => ({
    activeId: document.querySelector('.screen.active')?.id || null,
    liveShown: document.querySelector('#academy-auction-live') && !document.querySelector('#academy-auction-live').hidden,
    closedHidden: document.querySelector('#academy-auction-closed')?.hidden !== false,
    week: (document.querySelector('#academy-auction-week')?.textContent || '').trim(),
    motes: document.querySelector('#academy-auction-motes')?.dataset.ambient || null,
    boardName: (document.querySelector('#academy-auction-board-name')?.textContent || '').trim()
  }))()`);
  log('entry', { onScreen, ...entry });
  check('ENTRY: lands on #academy-auction-screen with the live board (not the closed view), week rendered, motes ambient running',
    onScreen && entry.activeId === 'academy-auction-screen' && entry.liveShown && entry.closedHidden
      && /^第\d+週 \/ 50$/.test(entry.week) && entry.motes === 'animated',
    entry);

  // ── 2) DRIVE ALL THREE LOTS (player wins each; NPCs pass) THROUGH TO CLOSE ──
  for (const lot of LOTS) {
    await playOneLot(win, lot);
    // After the win: the money debits display stays authoritative and the flow advances (hammer reveals). Give the
    // reveal + next-lot opening a moment before the next lot's bid bar is awaited inside playOneLot.
    await sleep(200);
  }

  // ── 3) CLOSED VIEW: the third lot's resolution closes the auction and shows the week results + hub-return ──
  const closed = await waitFor(win, `document.querySelector('#academy-auction-closed')?.hidden === false`, { tries: 400, intervalMs: 60 });
  const closedView = await js(win, `(() => ({
    liveHidden: document.querySelector('#academy-auction-live')?.hidden === true,
    resultCount: document.querySelectorAll('#academy-auction-closed-results li').length,
    wonRows: document.querySelectorAll('#academy-auction-closed-results li[data-result="won_by_player"]').length,
    exitPresent: !!document.querySelector('#academy-auction-exit'),
    resultsText: (document.querySelector('#academy-auction-closed-results')?.textContent || '').replace(/\\s+/g, ' ').trim()
  }))()`);
  log('closed', { closed, ...closedView });
  check('CLOSED: after the third lot the closed view shows the three results, all won by the player, with the ハブへ戻る affordance',
    closed && closedView.liveHidden && closedView.resultCount === 3 && closedView.wonRows === 3 && closedView.exitPresent
      && closedView.resultsText.includes('星図の天球儀'),
    closedView);

  const shotDir = path.join(os.tmpdir(), 'auction-frontend-screen');
  await fs.mkdir(shotDir, { recursive: true });
  try { await fs.writeFile(path.join(shotDir, 'auction-closed.png'), (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${path.join(shotDir, 'auction-closed.png')}`); } catch (e) { console.log(`screenshot failed: ${e?.message ?? e}`); }

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { server?.close(); } catch { /* ignore */ }
  process.exit(exitCode);
});
