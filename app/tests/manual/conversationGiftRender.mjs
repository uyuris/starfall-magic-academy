// Render-backed daytime 渡す (会話中の贈与) check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch / DOM / real layout), so the daytime gift affordance is verified
// here against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives under
// app/tests/manual/, so `npm test` skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/conversationGiftRender.mjs
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC local LM stub, does a routing new-game,
// seeds the save-slot inventory with a gift + an ally_boost + a product item (fetched from the live alchemy
// book so the ids are real), enters a daytime conversation with roster[0] (a selectable partner), and drives:
//   1. RENDER GATE: the inventory drawer shows 渡す on the gift + ally_boost rows and NOT on the product row.
//   2. GIFT FLOW: confirm → POST /api/conversation/gift → the hand-over 地の文 + the partner reaction reveal in
//      the stream, and the effect toasts (好感度 before→after).
//   3. 1会話1回 GATE: reopening the drawer shows the 渡す affordance disabled for the rest of the conversation.
// Per ref-camera, the harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.CG_WIN_W ?? 1200);
const WIN_H = Number(process.env.CG_WIN_H ?? 820);
const OPENING_TEXT = 'こんにちは。今日はどんなご用ですか。';
const GIFT_REACTION = 'まあ、わたしに……？（そっと受け取って）ありがとうございます、大切にしますね。';

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

// Deterministic LM stub: answers the daytime opening's emotion / recall / continuation calls + the opening line,
// and returns the fixed reaction for the gift_reaction prompt (identified by the 手渡した hand-over line).
async function startStubLm() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    requests.push({ url: req.url });
    const prompt = body.messages?.[0]?.content ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (prompt.includes('継続したいと思うか')) content = 'true';
    else if (prompt.includes('を手渡した')) content = GIFT_REACTION; // the gift_reaction turn
    else content = OPENING_TEXT;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const root = await fixtureRoot('conversation-gift-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-gift-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

async function findFiles(dir, name, acc = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await findFiles(full, name, acc);
    else if (entry.name === name) acc.push(full);
  }
  return acc;
}

// Seed the materialized save-slot inventory (…/play/slots/<slot>/game_data/player_inventory.json, where routing's
// active read scope resolves it — a fresh new-game leaves it absent). Runs AFTER new-game (which creates the slot).
async function seedInventory(root, items) {
  const payload = `${JSON.stringify({ money: 99999, items }, null, 2)}\n`;
  const stateDirs = (await findFiles(root, 'runtime_state.json')).map((p) => path.dirname(p));
  for (const dir of stateDirs) await fs.writeFile(path.join(dir, 'player_inventory.json'), payload, 'utf8');
  console.log(`seeded inventory into ${stateDirs.length} slot game_data dir(s)`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 300, intervalMs = 120 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// A DOM reader for the inventory drawer's ledger rows: name + whether the row carries a 渡す button (and its
// disabled state). The 渡す button is `.conversation-day-info-ledger-give`.
const READ_LEDGER = `(() => {
  const rows = [...document.querySelectorAll('#conversation-day-info-popup-body .conversation-day-info-ledger-row')];
  return rows.map((li) => {
    const give = li.querySelector('.conversation-day-info-ledger-give');
    return {
      name: (li.querySelector('.conversation-day-info-ledger-head strong')?.textContent || '').trim(),
      hasGive: !!give,
      giveDisabled: give ? give.disabled : null
    };
  });
})()`;

async function openInventoryDrawer(win) {
  await js(win, `document.querySelector('.conversation-day-category-button[data-day-category="inventory"]').click(); true`);
  // The 渡す affordances need the alchemy-book category map, which loads async then re-renders the drawer — wait
  // until either a give button exists or the (empty of gifts) ledger has settled.
  await waitFor(win, `!document.querySelector('#conversation-day-info-popup').hidden && (document.querySelector('#conversation-day-info-popup-body')?.childElementCount || 0) > 0`, { tries: 60, intervalMs: 40 });
  await sleep(400);
}

async function closeDrawer(win) {
  await js(win, `document.querySelector('#conversation-day-info-popup .conversation-day-info-popup-close')?.click(); true`);
  await waitFor(win, `document.querySelector('#conversation-day-info-popup').hidden === true`, { tries: 40, intervalMs: 40 });
}

async function newGameThenDaytime(win, base, root) {
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
  // Pick real gift / ally_boost / product ids from the live routing alchemy book, then seed them.
  const picks = await js(win, `(async () => {
    const book = await fetch('/api/alchemy').then((r) => r.json());
    const pick = (cat) => book.recipes.find((r) => r.result.category === cat)?.result ?? null;
    return { gift: pick('gift'), ally: pick('ally_boost'), product: pick('product') };
  })()`);
  if (!picks.gift || !picks.ally || !picks.product) throw new Error(`alchemy book missing a needed category: ${JSON.stringify(picks)}`);
  await seedInventory(root, [
    { item_id: picks.gift.item_id, quantity: 3 },
    { item_id: picks.ally.item_id, quantity: 3 },
    { item_id: picks.product.item_id, quantity: 3 }
  ]);
  await win.loadURL(`${base}/?initialScreen=conversation-day`);
  const onDay = await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
  `, { tries: 400, intervalMs: 120 });
  return { onDay, picks };
}

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
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  const shotDir = path.join(os.tmpdir(), 'conversation-gift-render');
  await fs.mkdir(shotDir, { recursive: true });
  const capture = async (name) => {
    const p = path.join(shotDir, name);
    try { await fs.writeFile(p, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${p}`); }
    catch (e) { console.log(`screenshot: FAILED ${name} ${e?.message ?? e}`); }
  };

  // ── ENTRY: routing daytime conversation with a selectable partner ─────────────
  const { onDay, picks } = await newGameThenDaytime(win, base, root);
  const partnerName = await js(win, `(async () => { const c = await fetch('/api/characters').then((r) => r.json()); const list = Array.isArray(c) ? c : (c?.characters ?? []); return (list[0]?.display_name || '').trim(); })()`);
  log('entry', { onDay, partnerName, gift: picks.gift.name, ally: picks.ally.name, product: picks.product.name });
  check('ENTRY: routing daytime conversation with a selectable partner is live', onDay && partnerName.length > 0, { onDay, partnerName });

  // ── 1) RENDER GATE: 渡す on gift + ally_boost rows, NOT on the product row ─────
  await openInventoryDrawer(win);
  const ledger = await js(win, READ_LEDGER);
  const giftRow = ledger.find((r) => r.name === picks.gift.name);
  const allyRow = ledger.find((r) => r.name === picks.ally.name);
  const productRow = ledger.find((r) => r.name === picks.product.name);
  const giveCount = ledger.filter((r) => r.hasGive).length;
  log('ledger', { rows: ledger.length, giveCount, giftRow, allyRow, productRow });
  check('RENDER GATE: 渡す shows on the gift + ally_boost rows and NOT on the product row',
    !!giftRow?.hasGive && !!allyRow?.hasGive && productRow && !productRow.hasGive && giveCount === 2,
    { giftHasGive: giftRow?.hasGive, allyHasGive: allyRow?.hasGive, productHasGive: productRow?.hasGive, giveCount });
  await capture('gift-drawer-affordance.png');

  // ── 2) GIFT FLOW: confirm → POST → reaction reveal + effect toast ─────────────
  const beforeRows = await js(win, `document.querySelectorAll('#conversation-day-message-stream .chat-message').length`);
  // Auto-accept the confirm, then click the gift row's 渡す.
  const clicked = await js(win, `(() => {
    window.confirm = () => true;
    const rows = [...document.querySelectorAll('#conversation-day-info-popup-body .conversation-day-info-ledger-row')];
    const row = rows.find((li) => (li.querySelector('.conversation-day-info-ledger-head strong')?.textContent || '').trim() === ${JSON.stringify(picks.gift.name)});
    const give = row?.querySelector('.conversation-day-info-ledger-give');
    if (!give) return false;
    give.click();
    return true;
  })()`);
  const reacted = clicked && await waitFor(win, `(document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify('ありがとうございます')})`, { tries: 400, intervalMs: 120 });
  const toastShown = await waitFor(win, `(() => { const b = document.querySelector('#economy-message-box'); return !!b && b.classList.contains('visible') && (b.textContent || '').includes('好感度'); })()`, { tries: 200, intervalMs: 30 });
  await sleep(300);
  const flow = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const text = (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim();
    return {
      rowCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      hasHandover: text.includes('差し出した'),
      hasReaction: text.includes('ありがとうございます'),
      toast: (document.querySelector('#economy-message-box')?.textContent || '').trim(),
      drawerHidden: !!document.querySelector('#conversation-day-info-popup')?.hidden
    };
  })()`);
  log('gift_flow', { clicked, reacted, toastShown, beforeRows, ...flow });
  check('GIFT FLOW: the hand-over 地の文 + the partner reaction reveal in the stream (drawer closed for the reveal)',
    clicked && reacted && flow.hasHandover && flow.hasReaction && flow.drawerHidden && flow.rowCount >= beforeRows + 2,
    { hasHandover: flow.hasHandover, hasReaction: flow.hasReaction, drawerHidden: flow.drawerHidden, rowCount: flow.rowCount });
  check('GIFT FLOW: the effect toasts the affinity change (好感度 before → after)',
    toastShown && /好感度/.test(flow.toast) && /→/.test(flow.toast), { toast: flow.toast });
  await capture('gift-reaction-and-effect.png');

  // ── 3) 1会話1回 GATE: reopening the drawer shows 渡す disabled ─────────────────
  await openInventoryDrawer(win);
  const afterLedger = await js(win, READ_LEDGER);
  const giftRowAfter = afterLedger.find((r) => r.name === picks.gift.name);
  const allyRowAfter = afterLedger.find((r) => r.name === picks.ally.name);
  log('after_gift_ledger', { giftRowAfter, allyRowAfter });
  check('1会話1回 GATE: every 渡す affordance is disabled for the rest of this conversation',
    giftRowAfter?.giveDisabled === true && allyRowAfter?.giveDisabled === true,
    { giftDisabled: giftRowAfter?.giveDisabled, allyDisabled: allyRowAfter?.giveDisabled });
  await capture('gift-gate-disabled.png');
  await closeDrawer(win);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nSUMMARY: ${passed}/${results.length} checks passed`);
  if (passed !== results.length) exitCode = 1;
}

main()
  .catch((error) => { console.error(error); exitCode = 1; })
  .finally(async () => {
    try { server?.close(); } catch { /* noop */ }
    try { lm?.server?.close(); } catch { /* noop */ }
    for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* noop */ } }
    app.quit();
    process.exit(exitCode);
  });
