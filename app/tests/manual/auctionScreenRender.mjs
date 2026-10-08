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
// Blink layout: land on #academy-auction-screen via ?initialScreen=academy-auction → the entry wait releases on the
// opening 口上 → the master opening + seated-bidder reactions land over the speakers' heads in their seats → the NPC
// bidders pass and the hand at the bottom opens for the player's turn (the raise starts at the minimum increment) →
// the player raises and wins → the hammer 宣言 → the next lot → after the third lot the closed results stand with the
// exit sigil. The lot (category / name / price), the way of the stages, the seats and the hand are measured against
// real layout. The harness is fire-and-forget (no top-level await main(); whenReady
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
const WIN_W = Number(process.env.AUC_WIN_W ?? 1440);
const WIN_H = Number(process.env.AUC_WIN_H ?? 900);

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// ── Deterministic auction fixture: three seated bidders (the week's 3〜5), three lots. The stub NPCs always pass, so the player
// wins every lot they raise on — a deterministic 1-lot-at-a-time walkthrough through the close. ──
// Each seat's face is a real visual set under assets/canonical (the seats decode the matted face, so a missing face fails
// the entry).
const BIDDERS = [
  { character_id: 'character_001', display_name: 'セラ', visual_set_id: 'ab_001' },
  { character_id: 'character_002', display_name: 'リオ', visual_set_id: 'ab_002' },
  { character_id: 'character_003', display_name: 'ミナ', visual_set_id: 'ab_003' }
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
    bidders: BIDDERS.map(({ character_id, display_name }) => ({ character_id, display_name })),
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

const STATIC_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml' };

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
    if (p === '/api/characters') return json(res, { characters: BIDDERS.map((b) => ({ character_id: b.character_id, display_name: b.display_name, visual_set_id: b.visual_set_id, face_url: `/canonical/character_visual_sets/${b.visual_set_id}/face_emotions/neutral.jpg`, standee_url: '' })), capabilities: { character_authoring: { enabled: false, reason: null, message: null } } });
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

// Play one lot: wait for the hand to open (the player's turn after the NPCs pass), assert the stage, then raise by
// the minimum increment (already in the raise) and win. Returns the observed stage snapshot for the lot.
async function playOneLot(win, lot) {
  const turn = await waitFor(win, `document.querySelector('#academy-auction-bid-bar')?.dataset.active === 'true' && document.querySelector('#academy-auction-bid')?.disabled === false`, { tries: 400, intervalMs: 60 });
  const stage = await js(win, `(() => ({
    name: (document.querySelector('#academy-auction-board-name')?.textContent || '').trim(),
    category: (document.querySelector('#academy-auction-board-category')?.textContent || '').trim(),
    current: (document.querySelector('#academy-auction-current')?.textContent || '').trim(),
    raise: document.querySelector('#academy-auction-bid-input')?.value ?? null,
    way: document.querySelector('#academy-auction-path')?.getAttribute('aria-label') ?? null,
    seats: document.querySelectorAll('#academy-auction-seats .academy-auction-seat').length,
    faces: [...document.querySelectorAll('#academy-auction-seats .academy-auction-seat-face img')].filter((img) => img.complete && img.naturalWidth > 0).length,
    masterWords: (document.querySelector('#academy-auction-seats .academy-auction-seat[data-seat="master"] .academy-auction-voice')?.textContent || '').trim(),
    bidderWords: document.querySelectorAll('#academy-auction-seats .academy-auction-seat:not([data-seat="master"]) .academy-auction-word').length
  }))()`);
  const lotWay = ['一品目', '二品目', '三品目'][lot.lot_index];
  check(`LOT ${lot.lot_index}: the stage shows the lot (name / category / price), the way is on ${lotWay}, the raise holds the minimum increment, and the words landed over the seats`,
    turn && stage.name === lot.name && stage.category === lot.category_label && stage.raise === String(lot.min_increment)
      && (stage.way ?? '').includes(`いま ${lotWay}`) && stage.seats === BIDDERS.length + 1 && stage.faces === BIDDERS.length + 1
      && stage.masterWords.length > 0 && stage.bidderWords > 0,
    { turn, ...stage });
  // Viewport fit: the document never grows past the viewport, and the lot, the seats and the hand stay on-screen.
  const viewport = await js(win, `(() => {
    const doc = document.scrollingElement || document.documentElement;
    const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1; };
    return {
      innerH: window.innerHeight,
      pageOverflow: doc.scrollHeight - window.innerHeight,
      screenH: Math.round(document.querySelector('#academy-auction-screen').getBoundingClientRect().height),
      lotOnScreen: onScreen(document.querySelector('.academy-auction-lot')),
      handOnScreen: onScreen(document.querySelector('#academy-auction-bid-bar')),
      seatsOnScreen: [...document.querySelectorAll('#academy-auction-seats .academy-auction-seat-face')].every(onScreen)
    };
  })()`);
  check(`LOT ${lot.lot_index}: page stays viewport-fit (no document overflow), the lot, every seat's face and the hand on-screen`,
    viewport.pageOverflow <= 1 && viewport.screenH <= viewport.innerH + 1 && viewport.lotOnScreen && viewport.handOnScreen && viewport.seatsOnScreen,
    viewport);
  // Raise by the minimum increment (already in the raise) and win.
  await js(win, `(() => { document.querySelector('#academy-auction-bid').click(); return true; })()`);
  return stage;
}

async function main() {
  server = await startStubServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await win.loadURL(`${base}/?initialScreen=academy-auction`);

  // ── 1) ENTRY: the auction screen becomes active and the lot renders once the entry wait releases on the opening
  // 口上 stream (so wait for the lot to be populated, not just the screen swap). ──
  const onScreen = await waitFor(win, `document.querySelector('#academy-auction-screen')?.classList.contains('active') && (document.querySelector('#academy-auction-board-name')?.textContent || '').trim().length > 0`, { tries: 400, intervalMs: 60 });
  const entry = await js(win, `(() => ({
    activeId: document.querySelector('.screen.active')?.id || null,
    liveShown: document.querySelector('#academy-auction-live') && !document.querySelector('#academy-auction-live').hidden,
    closedHidden: document.querySelector('#academy-auction-closed')?.hidden !== false,
    name: (document.querySelector('#academy-auction-title')?.textContent || '').trim(),
    weekText: /第\d+週/.test(document.querySelector('#academy-auction-screen').textContent),
    exitHidden: document.querySelector('#academy-auction-exit').hidden,
    boardName: (document.querySelector('#academy-auction-board-name')?.textContent || '').trim()
  }))()`);
  log('entry', { onScreen, ...entry });
  check('ENTRY: lands on #academy-auction-screen with the live stage (not the closed view), the venue name, no week text, no exit sigil before the close',
    onScreen && entry.activeId === 'academy-auction-screen' && entry.liveShown && entry.closedHidden
      && entry.name === '競売場' && !entry.weekText && entry.exitHidden,
    entry);

  // ── 2) DRIVE ALL THREE LOTS (player wins each; NPCs pass) THROUGH TO CLOSE ──
  for (const lot of LOTS) {
    await playOneLot(win, lot);
    // After the win: the money debits display stays authoritative and the flow advances (hammer reveals). Give the
    // reveal + next-lot opening a moment before the next lot's bid bar is awaited inside playOneLot.
    await sleep(200);
  }

  // ── 3) CLOSED: the third lot's resolution closes the auction; the results stand with the exit sigil ──
  const closed = await waitFor(win, `document.querySelector('#academy-auction-closed')?.hidden === false`, { tries: 400, intervalMs: 60 });
  const closedView = await js(win, `(() => ({
    liveHidden: document.querySelector('#academy-auction-live')?.hidden === true,
    resultCount: document.querySelectorAll('#academy-auction-closed-results li').length,
    wonRows: document.querySelectorAll('#academy-auction-closed-results li[data-result="won_by_player"]').length,
    exitShown: !document.querySelector('#academy-auction-exit').hidden,
    way: document.querySelector('#academy-auction-path')?.getAttribute('aria-label') ?? null,
    resultsText: (document.querySelector('#academy-auction-closed-results')?.textContent || '').replace(/\\s+/g, ' ').trim()
  }))()`);
  log('closed', { closed, ...closedView });
  check('CLOSED: after the third lot the three results stand, all won by the player, the way is all done and the exit sigil is up',
    closed && closedView.liveHidden && closedView.resultCount === 3 && closedView.wonRows === 3 && closedView.exitShown
      && (closedView.way ?? '').includes('すべて済んだ')
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
