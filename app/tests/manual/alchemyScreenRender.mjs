// Render-backed alchemy lab screen check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch / DOM / real layout), so the alchemy lab screen
// (#academy-alchemy-screen — the routing "alchemy"/調合 destination's landing surface) is verified here
// against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives under
// app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/alchemyScreenRender.mjs
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC local LM stub, does a routing new-game
// (which materializes runtime state so GET /api/alchemy can build the standing recipe book), SEEDS a rich
// inventory (all 24 dungeon materials + money, so recipes are craftable — the standing book has NO zero-cost
// guarantee, unlike the old weekly-offer arrival), and drives the REAL stay-and-craft flow against real Blink
// layout:
//   1. ARRIVAL: ?initialScreen=academy-alchemy renders the dedicated #academy-alchemy-screen with the full
//      56-recipe book table (分類・品名・効果・素材・費用 columns), the week header (第N週 / 50), the 分類 filter
//      chips (すべて + 5 categories), and the always-available 「調合室を出る」 exit. This is the dev entry AND the
//      shape a routing dispatch to alchemy lands on.
//   2. FILTER: clicking a 分類 chip hides the other categories' rows in place (no re-fetch).
//   3. FIXED CRAFT → STAY: click an affordable fixed-cost recipe → POST /api/alchemy/craft (ONE call, no
//      conversation) → the result popup floats with the crafted item as the 主役 → 受け取る keeps the player in the
//      lab with the board re-fetched (stay-and-craft).
//   4. CHOICE CRAFT → STAY: click an affordable choice-cost recipe → the single-element choice picker floats →
//      selecting an enabled element crafts → result popup → 受け取る → stay.
//   5. EXIT → HUB RETURN: click 「調合室を出る」 (#academy-alchemy-exit) → returnToRoutingHubFromContent takes the
//      server-authoritative post_content_screen through the shared loading-covered hub return: the academy loading
//      screen (#academy-loading-screen) covers the non-streaming hub start (押下→ロード画面→迎え会話ストリーミング開始
//      でハブ表示 — no freeze on the alchemy screen), then the routing hub re-opens (#routing-hub-screen).
//   6. REAL DISPATCH: a hub turn the stub decides toward alchemy lands on the arrival via performRoutingTurnDispatch
//      (the in-turn dispatch, not just the dev entry), proving the mirror ROUTING_DISPATCH_SCREENS entry is wired.
//
// NEGATIVE CONTROL (documented in the task report): reverting the wiring (remove the screens['academy-alchemy']
// registry entry / the showScreen refreshAlchemyScreen hook, or the #academy-alchemy-screen section) makes step 1
// FAIL — the arrival never renders; removing the ROUTING_DISPATCH_SCREENS alchemy entry makes step 6 FAIL (the
// dispatch validation throws instead of landing on the arrival). Per ref-camera the harness is fire-and-forget
// (no top-level await main(); whenReady would deadlock), and the deterministic LM stub answers every prompt the
// hub dispatch drain/finalization touches (好感度 delta 整数 / MP温存ライン 整数 included).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
// Fixed window size for this single-purpose render harness (no env override — no default-value fallback).
const WIN_W = 1200;
const WIN_H = 820;
// The 6 magic elements × 4 tiers = the 24 dungeon materials the recipe book prices against. Seeded rich so every
// recipe (fixed AND choice) is affordable — the standing book has no zero-cost guarantee.
const MATERIAL_ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
// The hub-dispatch leg: the player's hub turn the stub decides toward the alchemy destination, and the send-off
// utterance streamed before performRoutingTurnDispatch navigates to the alchemy arrival.
const HUB_DISPATCH_INPUT = '今日は調合の実習をしたい気分です。';
const SENDOFF_TEXT = 'では、調合室へ向かいましょう。';
const OPENING_TEXT = 'ようこそ。今日はどこへ向かいましょうか。';

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

// Deterministic routing LM stub. The alchemy craft is LM-free, so the stub only answers the routing legs: the hub
// opening / re-opening welcome, the hub destination judgment (→ alchemy), the send-off utterance, and the drain /
// finalization judgments the hub turn touches (好感度 delta 整数 / MP温存ライン 整数 included per ref-camera —
// a missing branch would make the product-side fail-fast turn into an SSE error before dispatch).
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
    else if (prompt.includes('場所移動の合意')) content = 'false'; // stage-move agreement → no move
    else if (prompt.includes('location_idを1つだけ返す')) content = 'none'; // stage-move destination → none
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) content = 'alchemy'; // hub destination judgment → alchemy
    else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) content = SENDOFF_TEXT; // hub send-off utterance
    else if (prompt.includes('継続したいと思うか')) content = 'true'; // continuation judgment → keep going
    else if (prompt.includes('好感度の変化量を判定する')) content = '0'; // affinity delta judgment → neutral (contract: integer -10..10)
    else if (prompt.includes('MP温存ライン')) content = '30'; // mp reserve line judgment → neutral (contract: integer 0..100)
    else content = OPENING_TEXT; // hub opening & re-opening / drain reflection
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// Routing-mode fixture. fixtureRoot seeds the alchemy / dungeon-material definitions into <root>/game_data, which
// GET /api/alchemy reads through the manifest's definitions/mutable roots. The manifest points the
// definitions/seeds/mutable roots at the fixture's game_data (new-game materializes runtime state there) and
// resourceRoot at the fixture root.
async function routingFixture() {
  const root = await fixtureRoot('alchemy-screen-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alchemy-screen-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

// Recursively find every file named `name` under `dir` (used to locate the materialized save-slot game_data dirs).
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

// Seed a rich inventory (all 24 dungeon materials + money) so every recipe (fixed and choice) prices affordable.
// The standing book has no zero-cost guarantee, so without materials NOTHING could be crafted. In routing mode the
// active read scope reads player_inventory.json from the materialized SAVE-SLOT game_data (…/play/slots/<slot>/
// game_data), NOT the flat fixture root; a fresh new-game leaves it absent (empty inventory). So write the file
// next to every materialized runtime_state.json (each save-slot game_data dir), which is exactly where the active
// slot's read scope resolves it. Must run AFTER new-game (which creates the slot).
async function seedRichInventory(root) {
  const items = [];
  for (const element of MATERIAL_ELEMENTS) {
    for (let tier = 1; tier <= 4; tier += 1) items.push({ item_id: `material_${element}_t${tier}`, quantity: 99 });
  }
  const payload = `${JSON.stringify({ money: 999999, items }, null, 2)}\n`;
  const stateDirs = (await findFiles(root, 'runtime_state.json')).map((p) => path.dirname(p));
  for (const dir of stateDirs) await fs.writeFile(path.join(dir, 'player_inventory.json'), payload, 'utf8');
  console.log(`seeded inventory into ${stateDirs.length} slot game_data dir(s): ${JSON.stringify(stateDirs.map((d) => d.slice(root.length)))}`);
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

// A DOM reader for the rendered book rows: recipe id / disabled / category / name / effect / cost text, and
// whether the row is a choice-cost recipe (its 素材 cell shows the 任意1系統 label).
const READ_ROWS = `(() => {
  const rows = [...document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row')];
  return rows.map((li) => {
    const button = li.querySelector('.academy-alchemy-row-button');
    const itemsText = (li.querySelector('.academy-alchemy-cell-items')?.textContent || '').trim();
    return {
      recipeId: button?.dataset.recipeId || '',
      disabled: button ? button.disabled : true,
      hidden: li.hidden,
      category: li.dataset.category || '',
      name: (li.querySelector('.academy-alchemy-cell-name-title')?.textContent || '').trim(),
      effect: (li.querySelector('.academy-alchemy-effect')?.textContent || '').trim(),
      itemsText,
      moneyText: (li.querySelector('.academy-alchemy-cell-money')?.textContent || '').trim(),
      isChoice: itemsText.includes('任意')
    };
  });
})()`;

// Routing new-game materializes runtime state, seed the rich inventory, then load the alchemy dev screen: boot's
// refresh() adopts that state (currentPlayMode=routing from GET /api/slots), and ?initialScreen=academy-alchemy
// shows the arrival, whose showScreen hook fetches GET /api/alchemy and renders the 56-recipe book table.
async function newGameThenAlchemy(win, base, root) {
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
  await seedRichInventory(root);
  await win.loadURL(`${base}/?initialScreen=academy-alchemy`);
  return waitFor(win, `
    document.querySelector('#academy-alchemy-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row').length === 56
  `, { tries: 400, intervalMs: 120 });
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

  // ── 1) ARRIVAL: the alchemy book renders 56 recipe rows + filter + exit ────────────────────
  const onAlchemy = await newGameThenAlchemy(win, base, root);
  const arrival = await js(win, `(() => {
    const active = document.querySelector('.screen.active');
    const rows = ${READ_ROWS};
    return {
      activeScreenId: active ? active.id : null,
      routingActive: !!document.querySelector('#routing-hub-screen.active'),
      sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
      hasTab: !!document.querySelector('[data-screen="academy-alchemy"]'),
      weekText: (document.querySelector('#academy-alchemy-week')?.textContent || '').trim(),
      filterChips: [...document.querySelectorAll('#academy-alchemy-filter .academy-alchemy-filter-chip')].map((c) => (c.textContent || '').trim()),
      hasExit: !!document.querySelector('#academy-alchemy-exit'),
      stageBg: (() => { const b = document.querySelector('.academy-alchemy-stage-image'); return b ? getComputedStyle(b).backgroundImage : ''; })(),
      rowCount: rows.length,
      affordableCount: rows.filter((r) => !r.disabled).length,
      choiceCount: rows.filter((r) => r.isChoice).length,
      categories: [...new Set(rows.map((r) => r.category))],
      sample: rows.slice(0, 3),
      // Direct-background (いきなり背景) standard: the layout has padding:0 so the flat obsidian screen fills it
      // edge-to-edge with no navy-gradient border inset.
      layoutPadding: (() => { const l = document.querySelector('.layout'); return l ? getComputedStyle(l).padding : ''; })()
    };
  })()`);
  log('arrival', arrival);
  check('ARRIVAL lands on the dedicated #academy-alchemy-screen (not routing hub / session), no tab',
    onAlchemy && arrival.activeScreenId === 'academy-alchemy-screen' && !arrival.routingActive && !arrival.sessionActive && !arrival.hasTab,
    { activeScreenId: arrival.activeScreenId, hasTab: arrival.hasTab });
  check('ARRIVAL renders the full 56-recipe book with the week header 第N週 / 50',
    arrival.rowCount === 56 && /^第\d+週 \/ 50$/.test(arrival.weekText), { weekText: arrival.weekText, rowCount: arrival.rowCount });
  check('ARRIVAL carries the 分類 filter (すべて + 5 categories) and the 「調合室を出る」 exit',
    arrival.filterChips.length === 6 && arrival.filterChips[0] === 'すべて' && arrival.hasExit,
    { filterChips: arrival.filterChips, hasExit: arrival.hasExit });
  check('ARRIVAL prices the book against the seeded inventory (affordable recipes exist) and includes choice-cost recipes',
    arrival.affordableCount >= 1 && arrival.choiceCount >= 1, { affordableCount: arrival.affordableCount, choiceCount: arrival.choiceCount });
  check('ARRIVAL each sample row carries a 分類 / 品名 / 効果 / 素材 cell',
    arrival.sample.every((r) => r.recipeId && r.category && r.name && r.effect && r.itemsText),
    { sample: arrival.sample.map((r) => ({ id: r.recipeId, cat: r.category, hasName: !!r.name, hasEffect: !!r.effect })) });
  check('ARRIVAL the 1:1 stage-image column paints the alchemy stage image (a real background-image, not none)',
    arrival.stageBg && arrival.stageBg !== 'none' && arrival.stageBg.includes('/canonical/alchemy/stage.jpg'),
    { stageBg: arrival.stageBg.slice(0, 90) });
  // BACKGROUND (いきなり背景): the alchemy layout is edge-to-edge (padding:0) so the flat obsidian screen fills it
  // with no navy-gradient border inset behind it (the frame's own padding holds the content余白).
  check('ARRIVAL the alchemy layout is edge-to-edge (layout padding:0) — no navy-gradient border inset behind the obsidian screen',
    arrival.layoutPadding === '0px', { layoutPadding: arrival.layoutPadding });

  const shotPath = path.join(os.tmpdir(), 'alchemy-book-render.png');
  try { await sleep(500); await fs.writeFile(shotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${shotPath}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // ── 1b) COLUMN WRAP: the 分類 chip + the 効果 pill are held to ONE line per row, so a long effect_summary (the
  //        賢者の霊薬's 5-parameter self_boost, or the ダンジョン消耗品 label) no longer wraps the column and grows
  //        the row past the 名前＋説明 stack. Measured against real Blink layout: per row, how many client-rect
  //        lines the chip/pill occupies, the (content-sized, align-items:center) cell heights, and — for an
  //        ellipsis-clipped cell — that the full text stays reachable through the title attribute (no silent cut).
  const wrap = await js(win, `(() => {
    const px = (v) => Math.round(v);
    const rows = [...document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row')].filter((li) => !li.hidden);
    const measured = rows.map((li) => {
      const button = li.querySelector('.academy-alchemy-row-button');
      const catChip = li.querySelector('.academy-alchemy-category-chip');
      const effChip = li.querySelector('.academy-alchemy-effect');
      const catCell = li.querySelector('.academy-alchemy-cell-category');
      const effCell = li.querySelector('.academy-alchemy-cell-effect');
      const nameCell = li.querySelector('.academy-alchemy-cell-name');
      const itemsCell = li.querySelector('.academy-alchemy-cell-items');
      const moneyCell = li.querySelector('.academy-alchemy-cell-money');
      return {
        recipeId: button?.dataset.recipeId || '',
        category: li.dataset.category || '',
        catLabel: catChip ? (catChip.textContent || '').trim() : '',
        effect: (effChip?.textContent || '').trim(),
        catLines: catChip ? catChip.getClientRects().length : 0,
        effLines: effChip ? effChip.getClientRects().length : 0,
        catCellH: catCell ? px(catCell.offsetHeight) : 0,
        effCellH: effCell ? px(effCell.offsetHeight) : 0,
        catColW: catCell ? px(catCell.getBoundingClientRect().width) : 0,
        effColW: effCell ? px(effCell.getBoundingClientRect().width) : 0,
        nameColW: nameCell ? px(nameCell.getBoundingClientRect().width) : 0,
        itemsColW: itemsCell ? px(itemsCell.getBoundingClientRect().width) : 0,
        moneyColW: moneyCell ? px(moneyCell.getBoundingClientRect().width) : 0,
        catTrunc: catChip ? catChip.scrollWidth > catChip.clientWidth + 1 : false,
        effTrunc: effChip ? effChip.scrollWidth > effChip.clientWidth + 1 : false,
        catTitle: catChip ? catChip.title : '',
        effTitle: effChip ? effChip.title : ''
      };
    });
    const byEffLen = measured.slice().sort((a, b) => b.effect.length - a.effect.length);
    const longest = byEffLen[0] || null;
    const truncatedEff = measured.filter((r) => r.effTrunc);
    const truncatedCat = measured.filter((r) => r.catTrunc);
    const effFit = measured.filter((r) => !r.effTrunc);
    const catFit = measured.filter((r) => !r.catTrunc);
    const maxLen = (arr, f) => arr.length ? Math.max(...arr.map(f)) : 0;
    const minLen = (arr, f) => arr.length ? Math.min(...arr.map(f)) : 0;
    return {
      total: measured.length,
      catMultiLine: measured.filter((r) => r.catLines > 1).map((r) => r.recipeId),
      effMultiLine: measured.filter((r) => r.effLines > 1).map((r) => r.recipeId),
      effCellHeights: [...new Set(measured.map((r) => r.effCellH))],
      catCellHeights: [...new Set(measured.map((r) => r.catCellH))],
      cols: { cat: measured[0]?.catColW ?? 0, name: measured[0]?.nameColW ?? 0, eff: measured[0]?.effColW ?? 0, items: measured[0]?.itemsColW ?? 0, money: measured[0]?.moneyColW ?? 0 },
      catTruncLabels: [...new Set(truncatedCat.map((r) => r.catLabel))],
      effFitMaxLen: maxLen(effFit, (r) => r.effect.length),
      effTruncMinLen: minLen(truncatedEff, (r) => r.effect.length),
      catFitMaxLen: maxLen(catFit, (r) => r.catLabel.length),
      catTruncMinLen: minLen(truncatedCat, (r) => r.catLabel.length),
      longest,
      truncatedEffCount: truncatedEff.length,
      truncatedCatCount: truncatedCat.length,
      effTitleAllFull: truncatedEff.every((r) => r.effTitle === r.effect),
      catTitleAllFull: truncatedCat.every((r) => r.catTitle && r.catTitle.length > 0)
    };
  })()`);
  log('wrap-metrics', wrap);
  check('WRAP: no 分類 chip wraps to a second line (all 56 rows single-line category)',
    wrap.catMultiLine.length === 0, { catMultiLine: wrap.catMultiLine, catColW: wrap.cols.cat });
  check('WRAP: no 効果 pill wraps to a second line (all 56 rows single-line effect, incl. the 32-char 賢者の霊薬)',
    wrap.effMultiLine.length === 0, { effMultiLine: wrap.effMultiLine, effColW: wrap.cols.eff });
  check('WRAP: every 効果 cell resolves to ONE uniform single-line height (no row grown by a wrapping effect column)',
    wrap.effCellHeights.length === 1, { effCellHeights: wrap.effCellHeights });
  check('WRAP: every 分類 cell resolves to ONE uniform single-line height',
    wrap.catCellHeights.length === 1, { catCellHeights: wrap.catCellHeights });
  check('WRAP: the longest 効果 (32-char self_boost) is clipped with an ellipsis and its full text stays in the title (no silent truncation)',
    !!wrap.longest && wrap.longest.effTrunc && wrap.longest.effTitle === wrap.longest.effect,
    { effect: wrap.longest?.effect, effTrunc: wrap.longest?.effTrunc, titleMatches: wrap.longest?.effTitle === wrap.longest?.effect });
  check('WRAP: every ellipsis-clipped 効果 / 分類 cell keeps its full text in the title attribute (no information silently cut)',
    wrap.effTitleAllFull && wrap.catTitleAllFull,
    { truncatedEffCount: wrap.truncatedEffCount, truncatedCatCount: wrap.truncatedCatCount, effTitleAllFull: wrap.effTitleAllFull, catTitleAllFull: wrap.catTitleAllFull });

  // Evidence shot of the long-effect region: scroll the book so the 32-char self_boost (賢者の霊薬) + the
  // ダンジョン消耗品 rows are visible, proving the single-line ellipsis holds where the wrapping used to break rows.
  await js(win, `(() => {
    const btn = [...document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row-button')].find((b) => b.dataset.recipeId === 'alchemy_sage_elixir');
    if (btn) btn.scrollIntoView({ block: 'center' });
    return !!btn;
  })()`);
  const longShotPath = path.join(os.tmpdir(), 'alchemy-book-longrows.png');
  try { await sleep(400); await fs.writeFile(longShotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot-longrows: ${longShotPath}`); }
  catch (e) { console.log(`screenshot-longrows: FAILED ${e?.message ?? e}`); }

  // ── 2) FILTER: a 分類 chip hides the other categories' rows in place ────────────────────
  const filtered = await js(win, `(() => {
    const chip = [...document.querySelectorAll('#academy-alchemy-filter .academy-alchemy-filter-chip')].find((c) => c.dataset.category === 'product');
    if (!chip) return { ok: false };
    chip.click();
    const rows = ${READ_ROWS};
    const visible = rows.filter((r) => !r.hidden);
    return { ok: true, chipPressed: chip.getAttribute('aria-pressed'), visibleCount: visible.length, visibleAllProduct: visible.every((r) => r.category === 'product') };
  })()`);
  check('FILTER a 分類 chip (換金品/product) shows only that category (in-place hidden toggle, aria-pressed marked)',
    filtered.ok && filtered.chipPressed === 'true' && filtered.visibleCount >= 1 && filtered.visibleAllProduct,
    { visibleCount: filtered.visibleCount, visibleAllProduct: filtered.visibleAllProduct });
  // Reset to すべて for the craft steps.
  await js(win, `(() => { const c = [...document.querySelectorAll('#academy-alchemy-filter .academy-alchemy-filter-chip')].find((x) => x.dataset.category === 'all'); c && c.click(); return true; })()`);

  // ── 3) FIXED CRAFT → RESULT POPUP → STAY ────────────────────
  const fixedTarget = await js(win, `(() => {
    const rows = ${READ_ROWS};
    const target = rows.find((r) => !r.disabled && !r.isChoice);
    if (!target) return null;
    const btn = [...document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row-button')].find((b) => b.dataset.recipeId === target.recipeId);
    btn.click();
    return target;
  })()`);
  const fixedPopupUp = fixedTarget && await waitFor(win, `
    document.querySelector('#academy-alchemy-result-popup') && document.querySelector('#academy-alchemy-result-popup').hidden === false
    && document.querySelector('#academy-alchemy-result-body')?.textContent.trim().length > 0
  `, { tries: 400, intervalMs: 120 });
  const fixedPopup = await js(win, `(() => {
    const el = document.querySelector('#academy-alchemy-result-popup');
    return {
      visible: el ? el.hidden === false : false,
      stillAlchemy: !!document.querySelector('#academy-alchemy-screen.active'),
      name: (document.querySelector('#academy-alchemy-result-title')?.textContent || '').trim(),
      category: (document.querySelector('.academy-alchemy-result-category')?.textContent || '').trim(),
      effect: (document.querySelector('.academy-alchemy-result-effect')?.textContent || '').trim()
    };
  })()`);
  log('fixed-craft', { target: fixedTarget?.recipeId, targetName: fixedTarget?.name, ...fixedPopup });
  check('FIXED CRAFT completes in one call (POST /api/alchemy/craft) and floats the result popup over the board (no screen change)',
    fixedPopupUp && fixedPopup.visible && fixedPopup.stillAlchemy, { visible: fixedPopup.visible, stillAlchemy: fixedPopup.stillAlchemy });
  check('FIXED CRAFT result popup shows the crafted item name (主役) + 分類 badge + 効果',
    fixedPopup.name.length > 0 && (fixedTarget?.name ? fixedPopup.name === fixedTarget.name : true) && fixedPopup.category.length > 0 && fixedPopup.effect.length > 0,
    { name: fixedPopup.name, targetName: fixedTarget?.name, category: fixedPopup.category, effect: fixedPopup.effect });
  // 受け取る → STAY (board re-fetched, still on the alchemy screen).
  await js(win, `(() => { const b = document.querySelector('#academy-alchemy-result-close'); b && b.click(); return true; })()`);
  const stayedAfterFixed = await waitFor(win, `
    document.querySelector('#academy-alchemy-screen')?.classList.contains('active')
    && document.querySelector('#academy-alchemy-result-popup')?.hidden === true
    && document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row').length === 56
  `, { tries: 400, intervalMs: 120 });
  check('FIXED CRAFT 受け取る stays in the lab and re-fetches the board (stay-and-craft — no hub return)',
    stayedAfterFixed, { stayedAfterFixed });

  // ── 4) CHOICE CRAFT → PICKER → RESULT POPUP → STAY ────────────────────
  const choiceTarget = await js(win, `(() => {
    const rows = ${READ_ROWS};
    const target = rows.find((r) => !r.disabled && r.isChoice);
    if (!target) return null;
    const btn = [...document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row-button')].find((b) => b.dataset.recipeId === target.recipeId);
    btn.click();
    return target;
  })()`);
  const pickerUp = choiceTarget && await waitFor(win, `
    document.querySelector('#academy-alchemy-choice-popup') && document.querySelector('#academy-alchemy-choice-popup').hidden === false
    && document.querySelectorAll('#academy-alchemy-choice-body .academy-alchemy-choice-option').length === 6
  `, { tries: 400, intervalMs: 120 });
  const picker = await js(win, `(() => {
    const options = [...document.querySelectorAll('#academy-alchemy-choice-body .academy-alchemy-choice-option')];
    return { optionCount: options.length, enabledCount: options.filter((o) => !o.disabled).length };
  })()`);
  log('choice-picker', { target: choiceTarget?.recipeId, ...picker });
  check('CHOICE CRAFT opens the single-element picker with 6 element options (at least one craftable)',
    pickerUp && picker.optionCount === 6 && picker.enabledCount >= 1, { optionCount: picker.optionCount, enabledCount: picker.enabledCount });
  // Pick the first enabled element → craft.
  await js(win, `(() => { const o = [...document.querySelectorAll('#academy-alchemy-choice-body .academy-alchemy-choice-option')].find((x) => !x.disabled); o && o.click(); return true; })()`);
  const choicePopupUp = await waitFor(win, `
    document.querySelector('#academy-alchemy-result-popup')?.hidden === false
    && document.querySelector('#academy-alchemy-choice-popup')?.hidden === true
    && document.querySelector('#academy-alchemy-result-body')?.textContent.trim().length > 0
  `, { tries: 400, intervalMs: 120 });
  const choicePopup = await js(win, `(() => ({
    stillAlchemy: !!document.querySelector('#academy-alchemy-screen.active'),
    name: (document.querySelector('#academy-alchemy-result-title')?.textContent || '').trim()
  }))()`);
  log('choice-craft', { target: choiceTarget?.recipeId, targetName: choiceTarget?.name, ...choicePopup });
  check('CHOICE CRAFT selecting an element crafts (POST with materials), closes the picker, and floats the result popup (still in the lab)',
    choicePopupUp && choicePopup.stillAlchemy && choicePopup.name.length > 0 && (choiceTarget?.name ? choicePopup.name === choiceTarget.name : true),
    { name: choicePopup.name, targetName: choiceTarget?.name, stillAlchemy: choicePopup.stillAlchemy });
  await js(win, `(() => { const b = document.querySelector('#academy-alchemy-result-close'); b && b.click(); return true; })()`);
  const stayedAfterChoice = await waitFor(win, `
    document.querySelector('#academy-alchemy-screen')?.classList.contains('active')
    && document.querySelector('#academy-alchemy-result-popup')?.hidden === true
    && document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row').length === 56
  `, { tries: 400, intervalMs: 120 });
  check('CHOICE CRAFT 受け取る stays in the lab and re-fetches the board (stay-and-craft)',
    stayedAfterChoice, { stayedAfterChoice });

  // ── 5) EXIT → HUB RETURN via the shared loading-covered hub return ────────────────────
  const exited = await js(win, `(() => { const b = document.querySelector('#academy-alchemy-exit'); if (!b) return false; b.click(); return true; })()`);
  const loadingCovered = exited && await waitFor(win, `
    document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 400, intervalMs: 15 });
  check('EXIT → LOADING: 調合室を出る shows the academy loading screen while the hub-return request runs (no freeze on the alchemy screen)',
    loadingCovered, { loadingCovered });
  const onHub = exited && await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 120 });
  await sleep(400);
  const hub = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    alchemyActive: !!document.querySelector('#academy-alchemy-screen.active'),
    hubOpeningLen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length
  }))()`);
  log('exit', { exited, ...hub });
  check('EXIT → HUB: 調合室を出る returns to the routing hub through the loading-covered path — not stranded on the arrival / loading screen',
    onHub && hub.activeScreenId === 'routing-hub-screen' && !hub.alchemyActive && hub.hubOpeningLen > 0,
    { activeScreenId: hub.activeScreenId, hubOpeningLen: hub.hubOpeningLen });

  // ── 6) REAL DISPATCH: a hub turn the stub decides toward alchemy lands on the arrival ────────────────────
  let dispatchFired = false;
  if (onHub) {
    await waitFor(win, `!document.querySelector('#routing-hub-send')?.disabled && !!document.querySelector('#routing-hub-input')`, { tries: 200, intervalMs: 120 });
    for (let attempt = 0; attempt < 6 && !dispatchFired; attempt += 1) {
      await js(win, `(() => {
        const input = document.querySelector('#routing-hub-input');
        const send = document.querySelector('#routing-hub-send');
        if (!input || !send || send.disabled) return false;
        input.value = ${JSON.stringify(HUB_DISPATCH_INPUT)};
        send.click();
        return true;
      })()`);
      dispatchFired = await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 80 });
    }
  }
  const dispatched = dispatchFired && await waitFor(win, `
    document.querySelector('#academy-alchemy-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row').length === 56
  `, { tries: 600, intervalMs: 150 });
  await sleep(300);
  const dispatch = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    rowCount: document.querySelectorAll('#academy-alchemy-recipes .academy-alchemy-row').length,
    weekText: (document.querySelector('#academy-alchemy-week')?.textContent || '').trim(),
    sendoffSeen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(SENDOFF_TEXT)})
  }))()`);
  log('dispatch', { dispatchFired, dispatched, ...dispatch });
  check('DISPATCH: a decided routing hub turn (alchemy) lands on #academy-alchemy-screen via performRoutingTurnDispatch with the 56-recipe book rendered',
    dispatched && dispatch.activeScreenId === 'academy-alchemy-screen' && dispatch.rowCount === 56 && /^第\d+週 \/ 50$/.test(dispatch.weekText),
    { activeScreenId: dispatch.activeScreenId, rowCount: dispatch.rowCount, weekText: dispatch.weekText, sendoffSeen: dispatch.sendoffSeen });

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\nALCHEMY SCREEN RENDER: ${passCount}/${results.length} checks passed`);
  if (passCount !== results.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { server?.close(); } catch {}
  try { lm?.server?.close(); } catch {}
  for (const p of cleanupPaths) fs.rm(p, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
});
