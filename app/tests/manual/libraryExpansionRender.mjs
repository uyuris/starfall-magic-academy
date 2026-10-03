// Render-backed QA for the ハブ書斎棚 (the routing hub's 収蔵庫 drawer: 並び替え / お気に入り / 処分 / 関連する本 and
// the move to a related book inside the drawer), driven in real Blink against the real product. The 大書庫 screen
// itself is captured by libraryScreenCapture.mjs.
//
// `node --test` cannot resolve layout, focus rings or a real click, so every state here is produced by driving the
// SHIPPED client (app/public/{index.html,app.js,style.css}) in Electron against the REAL server (createServer) over
// REAL HTTP, and captured at the same 1440×900 / DPR2 / PNG 2880×1800 condition as the approved figures. This file
// is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test` and the change gate skip
// it (it takes minutes, not seconds); run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/libraryExpansionRender.mjs \
//     --repo-root <absolute worker worktree> --out-dir <absolute publication directory>
//
// Both arguments are required, must be absolute, and have no default — a missing / relative / unknown argument
// dies before anything is started or written.
//
// WHAT IS REAL AND WHAT IS A FIXTURE
// - Real: the server, every /api/library* request and response, the client's own DOM/CSS/renderers, every click
//   and key press (webContents.sendInputEvent), and the capture. The books on the shelf are banked by real
//   POST /api/library/read requests sent from the page (the drawer only ever shows what a read has banked).
// - Fixture: an OS-temp slot + definitions copy (the real save is never opened), and an LM-compatible HTTP stub
//   that answers the model calls deterministically. The stub speaks the LM Studio wire protocol, so the product's
//   own generation gates run on its output exactly as they would on a real model's.
// - Failure states are produced OUTSIDE the browser: a fault seam in front of the real server (a proxy the page
//   talks to) answers ONE armed request with a real HTTP error instead of forwarding it, and the same seam can
//   delay ONE armed request so an in-flight cover is capturable. Nothing in the page is patched, no fetch is
//   overridden, and no response shape is faked in the browser.
//
// EVERY interaction in this harness is a real pointer or key event — opening a spine, following a 関連する本 link,
// 再試行, お気に入り, 処分, the confirmation and its Tab / Escape, and the 並び替え select. The select is driven by type-ahead (real Tab to focus, then the option label's first
// character as a real char event); how that was settled, and what does NOT work, is recorded in audit.json
// (`capture_inputs.select`).
//
// The harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── CLI (required, absolute, no defaults) ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const parsed = {};
  const known = new Set(['--repo-root', '--out-dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!known.has(token)) throw new Error(`unexpected argument: ${token} (expected --repo-root and --out-dir only)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of known) {
    const value = parsed[token];
    if (value === undefined) throw new Error(`${token} is required (no default, no fallback)`);
    if (!path.isAbsolute(value)) throw new Error(`${token} must be an absolute path: ${value}`);
  }
  return { repoRoot: parsed['--repo-root'], outDir: parsed['--out-dir'] };
}

const VIEWPORT = { width: 1440, height: 900, dpr: 2 };
const EXPECTED_PNG = { width: 2880, height: 1800 };
// The three catalog books the shelf banks, in the approved figures' order. Titles/categories are the
// current catalog's own entries (checked against the fixture catalog at startup — never copied blind).
const CATALOG_THREE = [
  { id: 'core_starfall_principle', title: '星降りの理', layer: 'core' },
  { id: 'periphery_flora_fauna_01', title: '月光苔の観察記', layer: 'periphery' },
  { id: 'core_six_aspects', title: '六つの相 — 系統魔法総論', layer: 'core' }
];
// The catalog-external 生成題 the shelf banks and the footnote answers name.
const GENERATED_TITLES = [1, 2].map((n) => `夜と星の写本 1-${n}`);

// The stub's deterministic bodies, carried over from the upstream preview fixture (no new authored prose).
const FRAGMENT_TEXT = '古い書架の隙間を星明かりが渡り、羊皮紙の端に淡い影を落とす。\n\n頁をめくるたび、遠い鐘の余韻が夜の静けさへ溶けていった。';
const SKELETON_TEXT = '夜と星をめぐる短い覚え書き。観測と暦のあいだを行き来する眼差し。';
// The style stage's fixed pick: one id from the product's closed set (LIBRARY_STYLE_IDS), matched to the 観測 skeleton.
const STYLE_ID = 'dry';

// The core 関連宣言 this run declares in its ISOLATED fixture table (the production table is not touched):
//   - 星降りの理: an empty declaration, so a 中核 book with no 関連 renders NO 関連する本 box at all.
//   - 六つの相: one readable core book and one 禁書 (dark>=80, which this run's parameters do not meet).
//   - 星暦五十週と祭事考: the book the 関連 link moves to, itself carrying two readable references.
const FIXTURE_CORE_REFERENCES = {
  core_starfall_principle: [],
  core_six_aspects: ['core_star_calendar', 'core_forbidden_arts'],
  core_star_calendar: ['core_starfall_geography', 'core_star_roles']
};
const RELATED_TARGET_ID = 'core_star_calendar';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

const checks = [];
function check(name, pass, detail = {}) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!pass) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}

// ── LM-compatible stub (the only place a model answer is fabricated) ──────────────────────────────────────────
// Speaks the LM Studio chat-completions wire protocol. The request kind is read off the product's own prompt
// text, so a prompt the product stops sending shows up as an unknown kind (throw) rather than a wrong answer.
function startLmStub(state) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages.map((message) => message.content).join('\n');
    let kind;
    let content;
    try {
      if (prompt.includes('書誌カタログを整えている')) {
        kind = 'skeleton';
        content = SKELETON_TEXT;
      } else if (prompt.includes('これから本文を書き起こす一冊について')) {
        kind = 'style';
        content = JSON.stringify({ style_id: STYLE_ID });
      } else if (prompt.includes('巻末に添える「関連する本」')) {
        kind = 'footnotes';
        // Read the subject and the candidate list off the product's own prompt, so the answer never names the book
        // being read (which the product rightly refuses as a self reference) and never invents a catalog id.
        const selfTitle = /書名『(.+?)』/.exec(prompt)?.[1];
        if (!selfTitle) throw new Error('lm stub: footnote prompt without a subject title');
        const candidates = [...prompt.matchAll(/^- (\S+) ／ (.+?) ／ (.+?) ／ (\S+)$/gm)].map((match) => ({ id: match[1], title: match[2] }));
        content = JSON.stringify({ references: state.footnotes(selfTitle, candidates) });
      } else if (prompt.includes('大書庫に収められた一冊の本の書き手')) {
        kind = 'fragment';
        content = FRAGMENT_TEXT;
      } else {
        throw new Error(`lm stub: unknown prompt kind: ${prompt.slice(0, 60)}`);
      }
    } catch (error) {
      requests.push({ kind: 'unknown', failed: String(error.message) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
      return;
    }
    requests.push({ kind });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        countOf(kind) { return requests.filter((entry) => entry.kind === kind).length; }
      });
    });
  });
}

// ── Fault seam: a proxy in FRONT of the real server ───────────────────────────────────────────────────────────
// The page talks to this; it forwards everything to the real server untouched. One armed fault answers the next
// matching request with a real HTTP error instead of forwarding it (so a failure state is a real failed request,
// not a shape faked in the browser); one armed delay holds the next matching request open long enough for its
// in-flight cover to be captured. Each arming is consumed by exactly one request.
async function startFaultProxy(targetBase) {
  let fault = null;
  let delay = null;
  const seen = [];
  let inFlight = 0;
  let quietSince = Date.now();
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ method: req.method, pathname: url.pathname });
    inFlight += 1;
    res.on('close', () => {
      inFlight -= 1;
      if (inFlight === 0) quietSince = Date.now();
    });
    if (delay && delay.pathname === url.pathname) {
      const held = delay;
      delay = null;
      await sleep(held.ms);
    }
    if (fault && fault.pathname === url.pathname) {
      const armed = fault;
      fault = null;
      res.writeHead(armed.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: armed.message, error_code: armed.errorCode }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const upstream = await fetch(`${targetBase}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : payload
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const outHeaders = {};
    for (const [key, value] of upstream.headers) {
      if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') continue;
      outHeaders[key] = value;
    }
    res.writeHead(upstream.status, outHeaders);
    res.end(buffer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    armFault(pathname, { status = 503, errorCode = 'HARNESS_FAULT_SEAM', message = '（QA fault seam）この要求は意図的に失敗させました。' } = {}) {
      fault = { pathname, status, errorCode, message };
    },
    armDelay(pathname, ms) { delay = { pathname, ms }; },
    // Nothing has been in flight for at least `ms` (the client's boot requests have all been answered).
    quietFor(ms) { return inFlight === 0 && Date.now() - quietSince >= ms; },
    countOf(pathname) { return seen.filter((entry) => entry.pathname === pathname).length; }
  };
}

// ── Fixture (OS temp; the real save is never opened) ──────────────────────────────────────────────────────────
async function buildFixture(repoRoot, prefix, { elapsedWeeks = 0, manifestFilename } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const slotRoot = path.join(root, 'data/mutable/game_data/play/slots/slot_001');
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  await fs.mkdir(definitionsRoot, { recursive: true });
  for (const filename of ['library_catalog.json', 'library_core_references.json']) {
    await fs.copyFile(path.join(repoRoot, 'data/definitions/game_data', filename), path.join(definitionsRoot, filename));
  }
  // The isolated 関連宣言: the production table keeps every key; only the entries this run needs are replaced.
  const referencesPath = path.join(definitionsRoot, 'library_core_references.json');
  const referencesFile = JSON.parse(await fs.readFile(referencesPath, 'utf8'));
  for (const [id, refs] of Object.entries(FIXTURE_CORE_REFERENCES)) {
    if (!Object.prototype.hasOwnProperty.call(referencesFile.references, id)) {
      throw new Error(`fixture core reference key ${id} is not in the catalog declaration`);
    }
    referencesFile.references[id] = refs;
  }
  await fs.writeFile(referencesPath, `${JSON.stringify(referencesFile, null, 2)}\n`, 'utf8');

  const manifest = (mutableRoot) => ({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot,
    seedsRoot: definitionsRoot,
    mutableRoot,
    characterContentRoot: path.join(repoRoot, 'content/characters'),
    creatureContentRoot: path.join(repoRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  });
  await writeJson(root, manifestFilename, manifest(path.join(root, 'data/mutable/game_data')));
  await writeJson(slotRoot, manifestFilename, manifest(path.join(slotRoot, 'game_data')));
  await writeRuntimeState(slotRoot, elapsedWeeks);
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', {
    magic: {
      light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 },
      dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 10 }
    },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  // v2 収蔵庫, explicitly empty: every entry these figures show is banked by a real read during the run.
  await writeJson(slotRoot, 'game_data/library_collection.json', { version: 3, entries: [] });
  const settingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, slotRoot, definitionsRoot, settingsPath };
}

async function writeJson(root, relativePath, value) {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRuntimeState(slotRoot, elapsedWeeks) {
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    version: 1,
    current_screen: 'academy-library',
    current_interaction_character_id: null,
    last_conversation_id: null,
    elapsed_weeks: elapsedWeeks,
    current_buddy_character_id: null,
    current_enemy_character_ids: [],
    pending_finalizations: [],
    routing_week_progressions: []
  });
}

// ── Real Blink driving ────────────────────────────────────────────────────────────────────────────────────────
const js = (win, expr) => win.webContents.executeJavaScript(expr);
// Reads the live 収蔵庫 through the page's own origin (an async IIFE — executeJavaScript evaluates a classic
// script, where a bare top-level await is a syntax error).
const fetchCollectionEntries = (win) => js(win, `(async () => (await (await fetch('/api/library/collection')).json()).entries)()`);

async function waitFor(win, predicate, label, { tries = 300, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await js(win, `(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A real pointer press on the element's own centre. If something else covers that point the press would land
// somewhere else, so the harness dies rather than recording a click that never reached the control.
async function realClick(win, selector) {
  const point = await js(win, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('no node to click: ' + ${JSON.stringify(selector)});
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) throw new Error('node has no box: ' + ${JSON.stringify(selector)});
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit) || hit.contains(node))) {
      throw new Error('click point is covered at ' + ${JSON.stringify(selector)} + ': ' + (hit ? hit.className : 'nothing'));
    }
    return { x, y };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  for (const type of ['mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await sleep(120);
  return point;
}

// Same real press, addressed by the visible text. The product DOM is only READ (an index is resolved and the
// point computed from it) — nothing is marked, tagged or otherwise changed to make the click land.
async function realClickByText(win, selector, text) {
  const point = await js(win, `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
    if (!node) throw new Error('no ' + ${JSON.stringify(selector)} + ' reads ' + ${JSON.stringify(text)} + '; got ' + JSON.stringify(nodes.map((n) => n.textContent.trim())));
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) throw new Error('node has no box: ' + ${JSON.stringify(text)});
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit) || hit.contains(node))) {
      throw new Error('click point is covered at ' + ${JSON.stringify(text)} + ': ' + (hit ? hit.className : 'nothing'));
    }
    return { x, y };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  for (const type of ['mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await sleep(120);
  return point;
}

// A real key press. Activation keys (Return / Space) additionally need the `char` event: Blink runs a button's
// default action off the character event, so keyDown/keyUp alone move focus but never press the button.
const ACTIVATION_KEYS = new Set(['Return', 'Enter', 'Space']);
async function realKey(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ACTIVATION_KEYS.has(keyCode)) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(150);
}

// The capture condition, identical for every figure: settle two animation frames, invalidate, let the live
// animations (busy dots, footnote wait, hub starfield) run, throw one frame away, then take the figure.
async function capture(win, outDir, name) {
  await js(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  win.webContents.invalidate();
  await sleep(400);
  await win.webContents.capturePage();
  await sleep(200);
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== EXPECTED_PNG.width || size.height !== EXPECTED_PNG.height) {
    throw new Error(`capture size mismatch for ${name}: expected ${EXPECTED_PNG.width}x${EXPECTED_PNG.height}, got ${size.width}x${size.height}`);
  }
  const file = path.join(outDir, `${name}.png`);
  const bytes = image.toPNG();
  await fs.writeFile(file, bytes);
  return {
    file: `${name}.png`,
    bytes: bytes.length,
    width: size.width,
    height: size.height,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

// ── DOM measurements ──────────────────────────────────────────────────────────────────────────────────────────
const MEASURE_FOOTNOTES = (hostSelector) => `(() => {
  const host = document.querySelector(${JSON.stringify(hostSelector)} + ' .library-footnotes');
  if (!host) return { hasBox: false };
  const items = [...host.querySelectorAll('.library-footnotes-item')];
  // 見出し / 失敗文 / 再試行 の「個数・並び・隣接の向き」は、DOM の並び（children）と実測 rect の両方で読む。
  const boxOf = (selector) => { const node = host.querySelector(selector); return node ? node.getBoundingClientRect() : null; };
  const headingBox = boxOf('.library-footnotes-heading');
  const statusBox = boxOf('.library-footnotes-status');
  const labelBox = boxOf('.library-footnotes-status-label');
  const retryBox = boxOf('.library-footnotes-retry');
  const listBox = boxOf('.library-footnotes-list');
  return {
    hasBox: true,
    state: host.dataset.state ?? null,
    heading: host.querySelector('.library-footnotes-heading')?.textContent ?? null,
    headingCount: host.querySelectorAll('.library-footnotes-heading').length,
    children: [...host.children].map((child) => child.className),
    statusChildren: [...(host.querySelector('.library-footnotes-status')?.children ?? [])].map((child) => child.className),
    order: {
      headingAboveStatus: headingBox && statusBox ? headingBox.bottom <= statusBox.top + 0.5 : null,
      headingAboveList: headingBox && listBox ? headingBox.bottom <= listBox.top + 0.5 : null,
      retryRightOfLabel: labelBox && retryBox ? labelBox.right <= retryBox.left + 0.5 : null,
      retrySameLineAsLabel: labelBox && retryBox ? Math.abs((labelBox.top + labelBox.height / 2) - (retryBox.top + retryBox.height / 2)) <= 4 : null
    },
    status: host.querySelector('.library-footnotes-status')?.textContent ?? null,
    retryLabel: host.querySelector('.library-footnotes-retry')?.textContent ?? null,
    count: items.length,
    entries: items.map((item) => ({
      readable: item.dataset.readable,
      title: (item.querySelector('.library-footnotes-link') ?? item.querySelector('.library-footnotes-unreadable-title'))?.textContent ?? null,
      note: item.querySelector('.library-footnotes-unreadable-note')?.textContent ?? null,
      isLink: !!item.querySelector('.library-footnotes-link')
    }))
  };
})()`;

const MEASURE_DRAWER = `(() => {
  const popup = document.querySelector('#routing-hub-info-popup');
  const card = document.querySelector('.routing-hub-info-popup-card');
  const cardBox = card.getBoundingClientRect();
  const busy = document.querySelector('.routing-hub-info-library-busy');
  const confirm = document.querySelector('.routing-hub-info-library-confirm');
  const error = document.querySelector('.routing-hub-info-library-error');
  const spines = [...document.querySelectorAll('.routing-hub-info-library-spine')];
  const box = (node) => { const b = node.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) }; };
  return {
    screen: [...document.querySelectorAll('.screen.active')].map((s) => s.id),
    drawerOpen: !popup.hidden,
    category: popup.dataset.category ?? null,
    cardRect: box(card),
    intro: document.querySelector('.routing-hub-info-library-intro')?.textContent ?? null,
    sortPresent: !!document.querySelector('.routing-hub-info-library-sort'),
    sortValue: document.querySelector('.routing-hub-info-library-sort-select')?.value ?? null,
    sortOptions: [...document.querySelectorAll('.routing-hub-info-library-sort-select option')].map((o) => ({ value: o.value, label: o.textContent })),
    spineCount: spines.length,
    spineTitles: spines.map((s) => s.querySelector('.routing-hub-info-library-spine-title').textContent),
    spineFavorites: spines.map((s) => s.querySelector('.routing-hub-info-library-spine-favorite').dataset.on),
    emptyCard: document.querySelector('.routing-hub-info-empty-title')?.textContent ?? null,
    entryTitle: document.querySelector('.routing-hub-info-library-entry-title')?.textContent ?? null,
    entryMeta: document.querySelector('.routing-hub-info-library-entry-meta')?.textContent ?? null,
    entryText: document.querySelector('.routing-hub-info-library-entry-text')?.textContent ?? null,
    favoriteLabel: document.querySelector('.routing-hub-info-library-favorite')?.textContent ?? null,
    favoriteOn: document.querySelector('.routing-hub-info-library-favorite')?.dataset.on ?? null,
    disposeLabel: document.querySelector('.routing-hub-info-library-dispose')?.textContent ?? null,
    backPresent: !!document.querySelector('.routing-hub-info-library-back'),
    errorHidden: error ? error.hidden : null,
    errorText: error?.textContent ?? null,
    busyPresent: !!busy,
    busyLabel: busy?.querySelector('.routing-hub-info-library-busy-label')?.textContent ?? null,
    busyInsideCard: busy ? (() => { const b = busy.getBoundingClientRect(); return b.left >= cardBox.left - 0.5 && b.right <= cardBox.right + 0.5 && b.top >= cardBox.top - 0.5 && b.bottom <= cardBox.bottom + 0.5; })() : null,
    confirmPresent: !!confirm,
    confirmTitle: confirm?.querySelector('.routing-hub-info-library-confirm-title')?.textContent ?? null,
    confirmQuestion: confirm?.querySelector('.routing-hub-info-library-confirm-question')?.textContent ?? null,
    confirmButtons: confirm ? [...confirm.querySelectorAll('.routing-hub-info-library-confirm-row button')].map((b) => b.textContent) : null,
    confirmRect: confirm ? box(confirm) : null,
    confirmInsideCard: confirm ? (() => { const b = confirm.getBoundingClientRect(); return b.left >= cardBox.left - 0.5 && b.right <= cardBox.right + 0.5 && b.top >= cardBox.top - 0.5 && b.bottom <= cardBox.bottom + 0.5; })() : null
  };
})()`;

const MEASURE_CONFIRM_SELECTION = `(() => {
  const cancel = document.querySelector('.routing-hub-info-library-confirm-cancel');
  const accept = document.querySelector('.routing-hub-info-library-confirm-accept');
  if (!cancel || !accept) throw new Error('confirmation is not open');
  const read = (node) => {
    const style = getComputedStyle(node);
    return {
      matchesFocus: node.matches(':focus'),
      matchesFocusVisible: node.matches(':focus-visible'),
      borderColor: style.borderColor,
      boxShadow: style.boxShadow
    };
  };
  return {
    activeElementClass: document.activeElement?.className ?? null,
    cancel: read(cancel),
    accept: read(accept),
    differs: {
      borderColor: getComputedStyle(cancel).borderColor !== getComputedStyle(accept).borderColor,
      boxShadow: getComputedStyle(cancel).boxShadow !== getComputedStyle(accept).boxShadow
    }
  };
})()`;

// ── Server + window lifecycle ─────────────────────────────────────────────────────────────────────────────────
async function requireFile(file) {
  try {
    await fs.access(file);
  } catch {
    throw new Error(`required file is missing: ${file}`);
  }
  return file;
}

async function startStage(repoRoot, createServer, fixture, lmBaseUrl) {
  const lmConfigPath = path.join(fixture.root, 'lmstudio.json');
  await fs.writeFile(lmConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: lmBaseUrl,
    chat_model: 'qa-stub',
    reflection_model: 'qa-stub',
    timeout_ms: 60000,
    stream: false,
    thinking_effort: null,
    mock_provider_enabled: false
  }, null, 2)}\n`, 'utf8');
  const server = createServer({
    root: fixture.root,
    activeRoot: fixture.slotRoot,
    publicRoot: path.join(repoRoot, 'app/public'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    playModeSettingsPath: fixture.settingsPath,
    lmStudioConfigPath: lmConfigPath
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxy = await startFaultProxy(`http://127.0.0.1:${server.address().port}`);
  return { server, proxy };
}

// The client on the debug start (no screen of its own is opened); the drawer is reached from the hub screen, made
// the active screen directly — what is under test is the drawer its category rail opens.
// The boot has no screen to show on this start, so it is taken as settled once every request it sent is answered.
async function openClient(win, stage) {
  await win.loadURL(`${stage.proxy.base}/?initialScreen=debug`);
  await waitFor(win, `document.readyState === 'complete' && !!document.querySelector('.routing-hub-category-button[data-routing-category="library"]')`, 'client loaded');
  for (let i = 0; !stage.proxy.quietFor(400); i += 1) {
    if (i >= 300) throw new Error('the client boot never went quiet');
    await sleep(50);
  }
  // The hidden capture window still needs document focus for real key events to land.
  win.webContents.focus();
}

// Banks one book through the product's own read route, sent from the page (the request the 大書庫 sends to read).
async function bankRead(win, target) {
  return js(win, `(async () => {
    const response = await fetch('/api/library/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(target)}) });
    const body = await response.json();
    if (!response.ok) throw new Error('library read ' + response.status + ': ' + JSON.stringify(body));
    return { title: body.title, entry_id: body.collection_entry_id };
  })()`);
}

async function openHubDrawer(win, stage) {
  await openClient(win, stage);
  await js(win, `(() => {
    document.querySelectorAll('.screen.active').forEach((screen) => screen.classList.remove('active'));
    document.querySelector('#routing-hub-screen').classList.add('active');
    return true;
  })()`);
  await waitFor(win, `document.querySelector('#routing-hub-screen').classList.contains('active')`, 'routing hub screen active');
  await realClick(win, '.routing-hub-category-button[data-routing-category="library"]');
  await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden && document.querySelector('#routing-hub-info-popup').dataset.category === 'library' && !document.querySelector('.routing-hub-info-library-loading')`, 'collection drawer loaded', { tries: 600 });
}

async function openSpineByTitle(win, title) {
  await realClickByText(win, '.routing-hub-info-library-spine-title', title);
  await waitFor(win, `document.querySelector('.routing-hub-info-library-entry-title')?.textContent === ${JSON.stringify(title)}`, `collection entry ${title}`, { tries: 300 });
}

async function backToShelf(win) {
  await realClick(win, '.routing-hub-info-library-back');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-shelf') || !!document.querySelector('.routing-hub-info-empty-title')`, 'back on the shelf', { tries: 300 });
}

// The 並び替え select, driven by REAL keyboard input. A native <select> opens an OS popup menu that pointer events
// cannot drive, and the arrow keys reach the element but move nothing (measured: keydown/keyup arrive on the
// select, its value does not change and no `change` fires). What does drive it is type-ahead — the option label's
// first character, sent as a real char event, selects that option and the product's own change handler runs.
// Focus is carried there by real Tab presses only; no DOM value is assigned and no event is synthesised.
const SORT_TYPEAHEAD = { read_week: '読', title: '題', category: '分', favorite: 'お' };
const SORT_SELECT = '.routing-hub-info-library-sort-select';
async function chooseSort(win, sortKey) {
  const character = SORT_TYPEAHEAD[sortKey];
  if (character === undefined) throw new Error(`no 並び替え type-ahead character is declared for ${sortKey}`);
  // Re-rendering the shelf replaces the select node, so focus has to be walked back in for every axis.
  let tabs = 0;
  const focused = () => js(win, `document.activeElement?.classList.contains('routing-hub-info-library-sort-select') === true`);
  while (!(await focused())) {
    if (tabs >= 40) throw new Error('real Tab presses never reached the 並び替え select');
    await realKey(win, 'Tab');
    tabs += 1;
  }
  // Blink keeps a ~1s type-ahead session; waiting it out means this character starts a new one instead of being
  // appended to the previous axis's character (which would match no option at all).
  await sleep(1100);
  const valueBefore = await js(win, `document.querySelector(${JSON.stringify(SORT_SELECT)}).value`);
  win.webContents.sendInputEvent({ type: 'char', keyCode: character });
  await waitFor(win, `document.querySelector(${JSON.stringify(SORT_SELECT)}).value === ${JSON.stringify(sortKey)}`, `並び替え select on ${sortKey} after the real type-ahead key`, { tries: 100 });
  await sleep(150);
  return { via: '実キー入力: Tab で focus → option ラベル先頭文字の char event（type-ahead）', tabs, character, value_before: valueBefore, value_after: sortKey };
}

async function waitFootnoteState(win, hostSelector, state, { tries = 600 } = {}) {
  await waitFor(win, `document.querySelector(${JSON.stringify(hostSelector)} + ' .library-footnotes')?.dataset.state === ${JSON.stringify(state)}`, `footnote state ${state} in ${hostSelector}`, { tries });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const started = new Date().toISOString();
let exitCode = 0;
const teardown = [];

async function main() {
  const { repoRoot, outDir } = parseArgs(process.argv.slice(2));
  for (const relative of ['app/src/server.mjs', 'app/public/app.js', 'app/public/index.html', 'app/public/style.css', 'app/public/libraryFootnotesClient.js', 'app/public/libraryCollectionViewClient.js', 'data/definitions/game_data/library_catalog.json', 'data/definitions/game_data/library_core_references.json', 'assets/canonical/library/stage.jpg']) {
    await requireFile(path.join(repoRoot, relative));
  }
  const { createServer } = await import(path.join(repoRoot, 'app/src/server.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  // Asked of git itself: in a worktree `.git` is a file pointing elsewhere, so reading .git/HEAD does not work.
  const headCommit = (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout.trim();

  const catalog = JSON.parse(await fs.readFile(path.join(repoRoot, 'data/definitions/game_data/library_catalog.json'), 'utf8'));
  const catalogTitles = new Map(catalog.books.map((book) => [book.id, book.title]));
  const catalogTitleSet = new Set(catalogTitles.values());
  for (const book of CATALOG_THREE) {
    if (catalogTitles.get(book.id) !== book.title) {
      throw new Error(`catalog title drift for ${book.id}: expected ${book.title}, catalog says ${catalogTitles.get(book.id)}`);
    }
  }

  await fs.mkdir(outDir, { recursive: true });
  const images = [];
  const measurements = {};
  const lmState = {
    // The answer is always one catalog-external 生成題 plus one 目録参照, so every footnote box carries both
    // read-target routes.
    footnotes(selfTitle, candidates) {
      const generatedTitle = selfTitle === GENERATED_TITLES[0] ? GENERATED_TITLES[1] : GENERATED_TITLES[0];
      if (generatedTitle === selfTitle) throw new Error(`lm stub: the footnote answer would name the book being read: ${selfTitle}`);
      const catalogRef = candidates.find((candidate) => candidate.id === RELATED_TARGET_ID && candidate.title !== selfTitle && candidate.title !== generatedTitle)
        ?? candidates.find((candidate) => candidate.title !== selfTitle && candidate.title !== generatedTitle);
      if (!catalogRef) throw new Error('lm stub: no catalog candidate left for the footnote answer');
      return [{ generated_title: generatedTitle }, { book_id: catalogRef.id }];
    }
  };
  const lm = await startLmStub(lmState);
  teardown.push(() => new Promise((resolve) => lm.server.close(resolve)));

  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false }
  });
  teardown.push(async () => { if (!win.isDestroyed()) win.destroy(); });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) console.log(`renderer-error: ${message}`);
  });

  // ── Stage 1: ハブ書斎棚 ────────────────────────────────────────────────────────────────────────────────────
  // The shelf carries exactly the three books the approved figures show, banked by real reads.
  const hubFixture = await buildFixture(repoRoot, 'library-expansion-render-hub-', { manifestFilename: runtimePathsManifestFilename });
  teardown.push(() => fs.rm(hubFixture.root, { recursive: true, force: true }));
  const hubStage = await startStage(repoRoot, createServer, hubFixture, lm.baseUrl);
  teardown.push(() => new Promise((resolve) => hubStage.proxy.server.close(resolve)));
  teardown.push(() => new Promise((resolve) => hubStage.server.close(resolve)));

  await openClient(win, hubStage);
  const viewport = await js(win, `({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio })`);
  if (viewport.innerWidth !== VIEWPORT.width || viewport.innerHeight !== VIEWPORT.height || viewport.dpr !== VIEWPORT.dpr) {
    throw new Error(`viewport mismatch: expected ${JSON.stringify(VIEWPORT)}, got ${JSON.stringify(viewport)}`);
  }
  log('viewport', viewport);

  // Bank the three books through the real read route, each at its own 読んだ週 so the 4軸 sort has something to order.
  for (const [target, week] of [[{ book_id: CATALOG_THREE[0].id }, 0], [{ book_id: CATALOG_THREE[1].id }, 2], [{ generated_title: GENERATED_TITLES[0] }, 1]]) {
    await writeRuntimeState(hubFixture.slotRoot, week);
    await bankRead(win, target);
  }
  const banked = await fetchCollectionEntries(win);
  measurements.collection_seed = banked.map((entry) => ({ entry_id: entry.entry_id, title: entry.title, category: entry.category, layer: entry.layer, read_week: entry.read_week, favorite: entry.favorite }));
  check('F7 the three books were banked by real reads, each with its own 読んだ週 and favorite:false',
    banked.length === 3 && new Set(banked.map((entry) => entry.read_week)).size === 3 && banked.every((entry) => entry.favorite === false), measurements.collection_seed);
  const bankedByTitle = new Map(banked.map((entry) => [entry.title, entry]));

  await openHubDrawer(win, hubStage);
  measurements.collection_shelf_initial = await js(win, MEASURE_DRAWER);
  check('F5 the drawer opens on the shelf with the 並び替え row and the three spines',
    measurements.collection_shelf_initial.drawerOpen === true && measurements.collection_shelf_initial.spineCount === 3
    && measurements.collection_shelf_initial.sortPresent === true && measurements.collection_shelf_initial.sortValue === 'read_week', measurements.collection_shelf_initial);

  // F5 — お気に入り: the server answer is what turns the mark on.
  await openSpineByTitle(win, CATALOG_THREE[1].title);
  measurements.collection_favorite_none = await js(win, MEASURE_DRAWER);
  check('F5 an unmarked book reads ☆ お気に入り', measurements.collection_favorite_none.favoriteOn === 'false'
    && measurements.collection_favorite_none.favoriteLabel === '☆ お気に入り', measurements.collection_favorite_none);
  images.push({ ...await capture(win, outDir, 'collection-favorite-none'), state: '収蔵の読み返し（お気に入り未設定）', operation: '背表紙『月光苔の観察記』を実クリック' });
  await realClick(win, '.routing-hub-info-library-favorite');
  await waitFor(win, `document.querySelector('.routing-hub-info-library-favorite').dataset.on === 'true'`, 'favorite on', { tries: 200 });
  measurements.collection_favorite_yes = await js(win, MEASURE_DRAWER);
  const savedAfterFavorite = await fetchCollectionEntries(win);
  check('F5 お気に入り on is the SAVED state, re-read from the server', measurements.collection_favorite_yes.favoriteLabel === '★ お気に入り'
    && savedAfterFavorite.find((entry) => entry.title === CATALOG_THREE[1].title).favorite === true, {
      label: measurements.collection_favorite_yes.favoriteLabel,
      saved: savedAfterFavorite.map((entry) => ({ title: entry.title, favorite: entry.favorite }))
    });
  images.push({ ...await capture(win, outDir, 'collection-favorite-yes'), state: '収蔵の読み返し（お気に入り設定後）', operation: '「☆ お気に入り」を実クリック' });

  // F5 — the OFF direction of the same toggle: pressing ★ again POSTs favorite:false, and the mark comes back
  // off only because the SAVED state says so. The third press restores the ON state the approved figures show.
  const favoriteCallsBeforeOff = hubStage.proxy.countOf('/api/library/collection/favorite');
  await realClick(win, '.routing-hub-info-library-favorite');
  await waitFor(win, `document.querySelector('.routing-hub-info-library-favorite').dataset.on === 'false'`, 'favorite off', { tries: 200 });
  measurements.collection_favorite_off = await js(win, MEASURE_DRAWER);
  const savedAfterFavoriteOff = await fetchCollectionEntries(win);
  check('F5 お気に入り off is the SAVED state too (false → true → false, each way re-read from the server)',
    measurements.collection_favorite_off.favoriteLabel === '☆ お気に入り'
    && measurements.collection_favorite_off.favoriteOn === 'false'
    && savedAfterFavoriteOff.find((entry) => entry.title === CATALOG_THREE[1].title).favorite === false
    && hubStage.proxy.countOf('/api/library/collection/favorite') - favoriteCallsBeforeOff === 1, {
      label: measurements.collection_favorite_off.favoriteLabel,
      favorite_calls: hubStage.proxy.countOf('/api/library/collection/favorite') - favoriteCallsBeforeOff,
      saved: savedAfterFavoriteOff.map((entry) => ({ title: entry.title, favorite: entry.favorite }))
    });
  await realClick(win, '.routing-hub-info-library-favorite');
  await waitFor(win, `document.querySelector('.routing-hub-info-library-favorite').dataset.on === 'true'`, 'favorite back on', { tries: 200 });
  const savedAfterFavoriteRestore = await fetchCollectionEntries(win);
  measurements.collection_favorite_restored = {
    saved: savedAfterFavoriteRestore.map((entry) => ({ title: entry.title, favorite: entry.favorite }))
  };
  check('F5 the ★ the approved figures show is restored by a third real POST',
    savedAfterFavoriteRestore.find((entry) => entry.title === CATALOG_THREE[1].title).favorite === true,
    measurements.collection_favorite_restored);
  await backToShelf(win);

  // F5 — the four axes, checked against the declared order (tie-break 週 desc → entry_id asc).
  const expectedOrder = (sortKey) => {
    const collator = new Intl.Collator('ja');
    const entries = savedAfterFavorite.map((entry) => ({ ...entry }));
    const tie = (a, b) => (a.read_week !== b.read_week ? b.read_week - a.read_week : (a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0));
    const primary = {
      read_week: () => 0,
      title: (a, b) => collator.compare(a.title, b.title),
      category: (a, b) => collator.compare(a.category, b.category),
      favorite: (a, b) => Number(b.favorite) - Number(a.favorite)
    }[sortKey];
    return entries.sort((a, b) => primary(a, b) || tie(a, b)).map((entry) => entry.title);
  };
  // The axes are walked so that every step CHANGES the value (the shelf opens on 読んだ週, so taking that axis
  // first would measure a key press that had nothing to move).
  for (const [sortKey, name] of [['title', 'collection-sort-title'], ['category', 'collection-sort-category'], ['read_week', 'collection-sort-week'], ['favorite', 'collection-sort-favorite']]) {
    const chosen = await chooseSort(win, sortKey);
    const shelf = await js(win, MEASURE_DRAWER);
    measurements[`collection_sort_${sortKey}`] = { ...shelf, expected: expectedOrder(sortKey), input: chosen };
    check(`F5 the ${sortKey} axis is reached by a real key press and orders the shelf as declared`,
      chosen.value_before !== chosen.value_after && shelf.sortValue === sortKey
      && JSON.stringify(shelf.spineTitles) === JSON.stringify(expectedOrder(sortKey)), {
        input: chosen, got: shelf.spineTitles, expected: expectedOrder(sortKey)
      });
    images.push({ ...await capture(win, outDir, name), state: `書斎棚（並び替え＝${{ read_week: '読んだ週', title: '題', category: '分類', favorite: 'お気に入り' }[sortKey]}）`, operation: `並び替えの選択欄へ実 Tab で focus を移し、「${chosen.character}」を実キー入力（type-ahead）で選択` });
  }
  // The chosen axis survives ← 棚に戻る, and the received order is never mutated.
  await openSpineByTitle(win, savedAfterFavorite[0].title);
  await backToShelf(win);
  measurements.collection_sort_kept = await js(win, MEASURE_DRAWER);
  check('F5 the chosen 並び替え軸 survives ← 棚に戻る', measurements.collection_sort_kept.sortValue === 'favorite'
    && JSON.stringify(measurements.collection_sort_kept.spineTitles) === JSON.stringify(expectedOrder('favorite')), measurements.collection_sort_kept);
  await chooseSort(win, 'read_week');

  // F3/F7 — the re-read: the SAVED body, no read call, footnotes only. pending → ready → failed → 再試行.
  const generatedEntry = bankedByTitle.get(GENERATED_TITLES[0]);
  const readCallsBeforeReReads = hubStage.proxy.countOf('/api/library/read');
  hubStage.proxy.armDelay('/api/library/footnotes', 3000);
  await openSpineByTitle(win, GENERATED_TITLES[0]);
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'pending', { tries: 100 });
  measurements.collection_pending = await js(win, MEASURE_DRAWER);
  images.push({ ...await capture(win, outDir, 'collection-pending'), state: '収蔵の読み返し（脚注は待機中・保存本文は読める）', operation: `背表紙『${GENERATED_TITLES[0]}』を実クリック（footnotes 応答を fault seam で 3 秒保持）` });
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'ready');
  measurements.collection_read = await js(win, MEASURE_DRAWER);
  measurements.collection_read_footnotes = await js(win, MEASURE_FOOTNOTES('#routing-hub-info-popup-body'));
  check('F7 the re-read shows the SAVED body byte-for-byte and calls the read API zero times',
    measurements.collection_read.entryText === generatedEntry.text
    && hubStage.proxy.countOf('/api/library/read') === readCallsBeforeReReads, {
      matches_saved: measurements.collection_read.entryText === generatedEntry.text,
      read_calls: hubStage.proxy.countOf('/api/library/read') - readCallsBeforeReReads
    });
  images.push({ ...await capture(win, outDir, 'collection-read'), state: '収蔵の読み返し（保存本文＋確定した脚注）', operation: '同上（脚注の解決後）' });

  await backToShelf(win);
  hubStage.proxy.armFault('/api/library/footnotes');
  await openSpineByTitle(win, GENERATED_TITLES[0]);
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'failed', { tries: 300 });
  measurements.collection_failed = await js(win, MEASURE_DRAWER);
  measurements.collection_failed_footnotes = await js(win, MEASURE_FOOTNOTES('#routing-hub-info-popup-body'));
  check('F3 a failed 収蔵 footnote keeps the saved body and ← 棚に戻る',
    measurements.collection_failed.entryText === generatedEntry.text && measurements.collection_failed.backPresent === true
    && measurements.collection_failed_footnotes.retryLabel === '再試行', measurements.collection_failed_footnotes);
  check('F3 the SAME shared renderer draws the same 見出し1つ → 失敗文 → 再試行 in the ハブ収蔵庫 drawer',
    measurements.collection_failed_footnotes.heading === '関連する本'
    && measurements.collection_failed_footnotes.headingCount === 1
    && JSON.stringify(measurements.collection_failed_footnotes.children) === JSON.stringify(['library-footnotes-heading', 'library-footnotes-status'])
    && JSON.stringify(measurements.collection_failed_footnotes.statusChildren) === JSON.stringify(['library-footnotes-status-label', 'library-footnotes-retry'])
    && measurements.collection_failed_footnotes.order.headingAboveStatus === true
    && measurements.collection_failed_footnotes.order.retryRightOfLabel === true
    && measurements.collection_failed_footnotes.order.retrySameLineAsLabel === true,
    { heading: measurements.collection_failed_footnotes.heading, headingCount: measurements.collection_failed_footnotes.headingCount, children: measurements.collection_failed_footnotes.children, statusChildren: measurements.collection_failed_footnotes.statusChildren, order: measurements.collection_failed_footnotes.order });
  images.push({ ...await capture(win, outDir, 'collection-failed'), state: '収蔵の読み返し（脚注失敗・保存本文と戻るは健在）', operation: '背表紙を実クリック（footnotes を fault seam で 503）' });
  hubStage.proxy.armDelay('/api/library/footnotes', 3000);
  await realClick(win, '.library-footnotes-retry');
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'pending', { tries: 100 });
  measurements.collection_retry = await js(win, MEASURE_FOOTNOTES('#routing-hub-info-popup-body'));
  images.push({ ...await capture(win, outDir, 'collection-retry'), state: '収蔵の脚注を再試行した直後（待機へ戻る）', operation: '「再試行」を実クリック（footnotes 応答を fault seam で 3 秒保持）' });
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'ready');

  // F4 — a 関連本 move inside the drawer: hub screen unchanged, drawer open, cover inside the card.
  const failTargetTitle = (await js(win, MEASURE_FOOTNOTES('#routing-hub-info-popup-body'))).entries.find((entry) => entry.isLink).title;
  hubStage.proxy.armFault('/api/library/read');
  await realClickByText(win, '.library-footnotes-link', failTargetTitle);
  await waitFor(win, `document.querySelector('.routing-hub-info-library-error')?.hidden === false`, 'drawer error line', { tries: 200 });
  measurements.collection_related_failed = await js(win, MEASURE_DRAWER);
  check('F4 a failed move inside the drawer keeps the open book and stays on the hub',
    measurements.collection_related_failed.entryTitle === GENERATED_TITLES[0]
    && measurements.collection_related_failed.screen.includes('routing-hub-screen')
    && measurements.collection_related_failed.drawerOpen === true
    && measurements.collection_related_failed.busyPresent === false, measurements.collection_related_failed);
  images.push({ ...await capture(win, outDir, 'collection-related-failed'), state: 'ドロワー内の関連本移動が失敗（開いていた本は残る）', operation: '脚注の可読題を実クリック（read を fault seam で 503）' });

  const entriesBeforeMove = (await fetchCollectionEntries(win)).length;
  hubStage.proxy.armDelay('/api/library/read', 2500);
  await realClickByText(win, '.library-footnotes-link', failTargetTitle);
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-busy')`, 'drawer busy cover', { tries: 100 });
  measurements.collection_related_busy = await js(win, MEASURE_DRAWER);
  check('F4 the move wait is covered INSIDE the drawer card, the screen is still the hub and the drawer is open',
    measurements.collection_related_busy.busyInsideCard === true
    && measurements.collection_related_busy.screen.includes('routing-hub-screen')
    && measurements.collection_related_busy.drawerOpen === true, measurements.collection_related_busy);
  images.push({ ...await capture(win, outDir, 'collection-related-busy'), state: 'ドロワー内で関連本へ移動中（覆いはカードの内側）', operation: '脚注の可読題を実クリック（read 応答を fault seam で 2.5 秒保持）' });
  await waitFor(win, `document.querySelector('.routing-hub-info-library-entry-title')?.textContent === ${JSON.stringify(failTargetTitle)}`, 'moved to the related book', { tries: 400 });
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'ready');
  measurements.collection_related_success = await js(win, MEASURE_DRAWER);
  const entriesAfterMove = await fetchCollectionEntries(win);
  const movedEntry = entriesAfterMove.find((entry) => entry.title === failTargetTitle);
  check('F4 the move shows the SAVED copy of the newly banked entry, still inside the drawer',
    measurements.collection_related_success.entryText === movedEntry.text
    && entriesAfterMove.length === entriesBeforeMove + 1
    && measurements.collection_related_success.screen.includes('routing-hub-screen'), {
      entries_before: entriesBeforeMove, entries_after: entriesAfterMove.length, title: failTargetTitle
    });
  images.push({ ...await capture(win, outDir, 'collection-related-success'), state: 'ドロワー内で関連本へ移動した後（保存された新 entry の本文と脚注）', operation: '同上（read 成功 → 収蔵 GET → 保存本文）' });

  // F4 — the OTHER read-target route inside the drawer: a 目録参照 (`{book_id}`). The move stays on the hub with
  // the drawer open, reads once, and shows the SAVED copy of the authored book it banked.
  const drawerFootnotes = await js(win, MEASURE_FOOTNOTES('#routing-hub-info-popup-body'));
  const drawerCatalogRouteTitle = drawerFootnotes.entries
    .find((entry) => entry.isLink && catalogTitleSet.has(entry.title))?.title;
  if (!drawerCatalogRouteTitle) throw new Error('no catalog 関連題 to follow inside the drawer');
  const entriesBeforeCatalogMove = (await fetchCollectionEntries(win)).length;
  const readCallsBeforeCatalogMove = hubStage.proxy.countOf('/api/library/read');
  await realClickByText(win, '.library-footnotes-link', drawerCatalogRouteTitle);
  await waitFor(win, `document.querySelector('.routing-hub-info-library-entry-title')?.textContent === ${JSON.stringify(drawerCatalogRouteTitle)}`, 'drawer moved to the catalog related book', { tries: 400 });
  await waitFootnoteState(win, '#routing-hub-info-popup-body', 'ready');
  measurements.collection_related_catalog = await js(win, MEASURE_DRAWER);
  const entriesAfterCatalogMove = await fetchCollectionEntries(win);
  const bankedCatalogEntry = entriesAfterCatalogMove.find((entry) => entry.title === drawerCatalogRouteTitle);
  measurements.collection_related_catalog_route = {
    title: drawerCatalogRouteTitle,
    banked_layer: bankedCatalogEntry.layer,
    read_calls: hubStage.proxy.countOf('/api/library/read') - readCallsBeforeCatalogMove,
    entries_before: entriesBeforeCatalogMove,
    entries_after: entriesAfterCatalogMove.length,
    screen: measurements.collection_related_catalog.screen,
    drawerOpen: measurements.collection_related_catalog.drawerOpen,
    busyPresent: measurements.collection_related_catalog.busyPresent
  };
  check('F4 ハブ: a 目録参照 moves inside the drawer too, showing the SAVED copy of the authored book',
    measurements.collection_related_catalog.entryTitle === drawerCatalogRouteTitle
    && measurements.collection_related_catalog.entryText === bankedCatalogEntry.text
    && measurements.collection_related_catalog.screen.includes('routing-hub-screen')
    && measurements.collection_related_catalog.drawerOpen === true
    && bankedCatalogEntry.layer !== 'generated'
    && entriesAfterCatalogMove.length === entriesBeforeCatalogMove + 1
    && hubStage.proxy.countOf('/api/library/read') - readCallsBeforeCatalogMove === 1,
    measurements.collection_related_catalog_route);

  // The 図 that follow are the approved figures' shelf, so the extra book this route test banked is taken back
  // out through the product's own 確認つき処分 (no figure is taken here).
  await realClick(win, '.routing-hub-info-library-dispose');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-confirm')`, 'dispose confirmation (route cleanup)', { tries: 200 });
  await realClick(win, '.routing-hub-info-library-confirm-accept');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-sort')`, 'back on the shelf after the cleanup dispose', { tries: 300 });
  measurements.collection_route_cleanup = {
    entries: (await fetchCollectionEntries(win)).length,
    expected: entriesBeforeCatalogMove
  };
  check('F4 the extra book banked by the 目録参照 route is disposed again, restoring the approved shelf',
    measurements.collection_route_cleanup.entries === entriesBeforeCatalogMove, measurements.collection_route_cleanup);

  measurements.collection_shelf_after_move = await js(win, MEASURE_DRAWER);
  check('F4 the refreshed shelf carries the new entry and keeps the chosen 並び替え',
    measurements.collection_shelf_after_move.spineCount === entriesAfterMove.length
    && measurements.collection_shelf_after_move.sortValue === 'read_week', measurements.collection_shelf_after_move);

  // F5 — a failed お気に入り leaves everything as it was.
  await openSpineByTitle(win, CATALOG_THREE[0].title);
  const favoriteBeforeFailure = await js(win, MEASURE_DRAWER);
  hubStage.proxy.armFault('/api/library/collection/favorite');
  await realClick(win, '.routing-hub-info-library-favorite');
  await waitFor(win, `document.querySelector('.routing-hub-info-library-error')?.hidden === false`, 'favorite error line', { tries: 200 });
  measurements.collection_favorite_failed = await js(win, MEASURE_DRAWER);
  const savedAfterFavoriteFailure = await fetchCollectionEntries(win);
  check('F5 a failed お気に入り changes neither the mark, the body, nor the saved state',
    measurements.collection_favorite_failed.favoriteOn === favoriteBeforeFailure.favoriteOn
    && measurements.collection_favorite_failed.entryText === favoriteBeforeFailure.entryText
    && savedAfterFavoriteFailure.find((entry) => entry.title === CATALOG_THREE[0].title).favorite === false, measurements.collection_favorite_failed);
  images.push({ ...await capture(win, outDir, 'collection-favorite-failed'), state: 'お気に入りの変更が失敗（表示も保存も不変・明示エラー）', operation: '「☆ お気に入り」を実クリック（favorite を fault seam で 503）' });

  // F6 — the confirmation, opened by MOUSE: the selected side must be visible even though the last input was a
  // pointer, and Tab must move both the selection and its frame + glow.
  await realClick(win, '.routing-hub-info-library-dispose');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-confirm')`, 'dispose confirmation (mouse)', { tries: 200 });
  measurements.collection_confirm_mouse = await js(win, MEASURE_DRAWER);
  measurements.collection_confirm_mouse_selection = await js(win, MEASURE_CONFIRM_SELECTION);
  check('F6 the confirmation names the book, asks once and offers やめる then 処分する, inside the drawer card',
    measurements.collection_confirm_mouse.confirmTitle === CATALOG_THREE[0].title
    && measurements.collection_confirm_mouse.confirmQuestion === 'この本を棚から処分しますか？'
    && JSON.stringify(measurements.collection_confirm_mouse.confirmButtons) === JSON.stringify(['やめる', '処分する'])
    && measurements.collection_confirm_mouse.confirmInsideCard === true, measurements.collection_confirm_mouse);
  check('F6 a MOUSE-opened confirmation still shows which side is selected (やめる)',
    measurements.collection_confirm_mouse_selection.activeElementClass.includes('routing-hub-info-library-confirm-cancel')
    && measurements.collection_confirm_mouse_selection.cancel.matchesFocus === true
    && measurements.collection_confirm_mouse_selection.cancel.matchesFocusVisible === false
    && measurements.collection_confirm_mouse_selection.differs.borderColor === true
    && measurements.collection_confirm_mouse_selection.differs.boxShadow === true, measurements.collection_confirm_mouse_selection);
  images.push({ ...await capture(win, outDir, 'collection-confirm-mouse'), state: '処分の確認（マウスで開いた・「やめる」が選択され枠と光が付く）', operation: '「処分」を実マウスクリック' });
  await realKey(win, 'Tab');
  measurements.collection_confirm_after_tab = await js(win, MEASURE_CONFIRM_SELECTION);
  check('F6 Tab moves the selection and its frame + glow to 処分する',
    measurements.collection_confirm_after_tab.activeElementClass.includes('routing-hub-info-library-confirm-accept')
    && measurements.collection_confirm_after_tab.accept.matchesFocus === true
    && measurements.collection_confirm_after_tab.cancel.matchesFocus === false, measurements.collection_confirm_after_tab);
  await realKey(win, 'Tab', ['shift']);
  measurements.collection_confirm_after_shift_tab = await js(win, MEASURE_CONFIRM_SELECTION);
  check('F6 Shift+Tab brings the selection back to やめる',
    measurements.collection_confirm_after_shift_tab.activeElementClass.includes('routing-hub-info-library-confirm-cancel'), measurements.collection_confirm_after_shift_tab);
  const disposeCallsBeforeCancel = hubStage.proxy.countOf('/api/library/collection/dispose');
  await realKey(win, 'Escape');
  await waitFor(win, `!document.querySelector('.routing-hub-info-library-confirm')`, 'confirmation closed by Escape', { tries: 200 });
  measurements.collection_confirm_escape = { ...await js(win, MEASURE_DRAWER), dispose_calls: hubStage.proxy.countOf('/api/library/collection/dispose') - disposeCallsBeforeCancel };
  check('F6 Escape closes the confirmation with no mutation', measurements.collection_confirm_escape.confirmPresent === false
    && measurements.collection_confirm_escape.entryTitle === CATALOG_THREE[0].title
    && measurements.collection_confirm_escape.dispose_calls === 0, measurements.collection_confirm_escape);

  // F6 — 確認中の背後操作: while the drawer is open its own backdrop covers the hub, so the category rail cannot
  // be reached by pointer at all — the harness proves that here rather than assuming it. The route that IS
  // reachable behind the confirmation is the drawer's own × / backdrop, and then re-opening a category. The
  // confirmation must not survive any of it, and must send nothing.
  await realClick(win, '.routing-hub-info-library-dispose');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-confirm')`, 'dispose confirmation (behind-operation check)', { tries: 200 });
  const disposeCallsBeforeBehind = hubStage.proxy.countOf('/api/library/collection/dispose');
  const coverProbe = (selector) => `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('nothing to probe at ' + ${JSON.stringify(selector)});
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    return { covered: Boolean(hit) && hit !== node && !node.contains(hit), coveredBy: hit ? hit.className : null };
  })()`;
  measurements.collection_confirm_behind_unreachable = {
    categoryRail: await js(win, coverProbe('.routing-hub-category-button[data-routing-category="self"]')),
    drawerClose: await js(win, coverProbe('#routing-hub-info-popup .routing-hub-info-popup-close'))
  };
  check('F6 while the confirmation is up, neither the hub category rail nor the drawer × takes a pointer',
    measurements.collection_confirm_behind_unreachable.categoryRail.covered === true
    && measurements.collection_confirm_behind_unreachable.drawerClose.covered === true,
    measurements.collection_confirm_behind_unreachable);

  // The one background control the confirmation does NOT cover is the drawer backdrop (it sits outside the card),
  // and dismissing there hides the popup without touching the card — which is exactly the route that used to leave
  // the confirmation standing, ready to dispose an entry that had left the screen.
  await realClick(win, '.routing-hub-info-popup-backdrop');
  await waitFor(win, `document.querySelector('#routing-hub-info-popup').hidden`, 'drawer closed under the confirmation', { tries: 300 });
  measurements.collection_confirm_drawer_close = {
    confirmPresent: await js(win, `!!document.querySelector('.routing-hub-info-library-confirm')`),
    dispose_calls: hubStage.proxy.countOf('/api/library/collection/dispose') - disposeCallsBeforeBehind
  };
  check('F6 dismissing the drawer on its backdrop retires the confirmation and sends nothing',
    measurements.collection_confirm_drawer_close.confirmPresent === false
    && measurements.collection_confirm_drawer_close.dispose_calls === 0, measurements.collection_confirm_drawer_close);

  await realClick(win, '.routing-hub-category-button[data-routing-category="library"]');
  await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden && document.querySelector('#routing-hub-info-popup').dataset.category === 'library' && !document.querySelector('.routing-hub-info-library-loading')`, 'back on the 収蔵庫 drawer', { tries: 600 });
  const entriesAfterBehindOperations = await fetchCollectionEntries(win);
  measurements.collection_confirm_behind_no_mutation = {
    confirmPresent: await js(win, `!!document.querySelector('.routing-hub-info-library-confirm')`),
    entries: entriesAfterBehindOperations.length,
    expected: entriesAfterMove.length,
    titles: entriesAfterBehindOperations.map((entry) => entry.title)
  };
  check('F6 re-opening the 収蔵庫 carries no 処分 confirmation over and nothing was disposed behind it',
    measurements.collection_confirm_behind_no_mutation.confirmPresent === false
    && entriesAfterBehindOperations.length === entriesAfterMove.length, measurements.collection_confirm_behind_no_mutation);
  await openSpineByTitle(win, CATALOG_THREE[0].title);

  // F6 — the confirmation, opened by KEYBOARD: the same selection must be visible.
  await js(win, `(() => { document.querySelector('.routing-hub-info-library-back').focus(); return true; })()`);
  let reachedDispose = false;
  for (let i = 0; i < 12 && !reachedDispose; i += 1) {
    await realKey(win, 'Tab');
    reachedDispose = await js(win, `document.activeElement?.classList.contains('routing-hub-info-library-dispose') === true`);
  }
  if (!reachedDispose) throw new Error('Tab never reached the 処分 button');
  await realKey(win, 'Return');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-confirm')`, 'dispose confirmation (keyboard)', { tries: 200 });
  measurements.collection_confirm_keyboard_selection = await js(win, MEASURE_CONFIRM_SELECTION);
  check('F6 a KEYBOARD-opened confirmation shows the same selected side',
    measurements.collection_confirm_keyboard_selection.activeElementClass.includes('routing-hub-info-library-confirm-cancel')
    && measurements.collection_confirm_keyboard_selection.differs.borderColor === true
    && measurements.collection_confirm_keyboard_selection.differs.boxShadow === true, measurements.collection_confirm_keyboard_selection);
  images.push({ ...await capture(win, outDir, 'collection-confirm-keyboard'), state: '処分の確認（キーボードで開いた・同じ側が選択され枠と光が付く）', operation: 'Tab で「処分」へ移動し Return を実キー入力' });

  // F6 — a failed 処分 keeps the saved view.
  hubStage.proxy.armFault('/api/library/collection/dispose');
  await realClick(win, '.routing-hub-info-library-confirm-accept');
  await waitFor(win, `document.querySelector('.routing-hub-info-library-error')?.hidden === false`, 'dispose error line', { tries: 300 });
  measurements.collection_dispose_failed = await js(win, MEASURE_DRAWER);
  const savedAfterDisposeFailure = await fetchCollectionEntries(win);
  check('F6 a failed 処分 keeps the saved view and removes nothing',
    measurements.collection_dispose_failed.entryTitle === CATALOG_THREE[0].title
    && savedAfterDisposeFailure.length === entriesAfterMove.length, {
      entries: savedAfterDisposeFailure.length, expected: entriesAfterMove.length
    });
  images.push({ ...await capture(win, outDir, 'collection-dispose-failed'), state: '処分が失敗（保存表示は残り、明示エラー）', operation: '「処分する」を実クリック（dispose を fault seam で 503）' });
  await backToShelf(win);

  // F6 — a favorite book disposes through the same confirmation; then the shelf empties, book by book.
  await openSpineByTitle(win, CATALOG_THREE[1].title);
  measurements.collection_dispose_favorite_target = await js(win, MEASURE_DRAWER);
  check('F6 the book about to be disposed is the お気に入り one', measurements.collection_dispose_favorite_target.favoriteOn === 'true', measurements.collection_dispose_favorite_target);
  await realClick(win, '.routing-hub-info-library-dispose');
  await waitFor(win, `!!document.querySelector('.routing-hub-info-library-confirm')`, 'dispose confirmation (favorite book)', { tries: 200 });
  await realClick(win, '.routing-hub-info-library-confirm-accept');
  await waitFor(win, `!document.querySelector('.routing-hub-info-library-confirm') && !!document.querySelector('.routing-hub-info-library-shelf')`, 'shelf after dispose', { tries: 300 });
  measurements.collection_after_dispose = await js(win, MEASURE_DRAWER);
  check('F6 an お気に入り book disposes through the same confirmation and leaves the shelf one book shorter',
    measurements.collection_after_dispose.spineCount === entriesAfterMove.length - 1
    && !measurements.collection_after_dispose.spineTitles.includes(CATALOG_THREE[1].title), measurements.collection_after_dispose);
  images.push({ ...await capture(win, outDir, 'collection-after-dispose'), state: `処分を確定した後の書斎棚（残り${measurements.collection_after_dispose.spineCount}冊）`, operation: '★の付いた『月光苔の観察記』を開き「処分」→「処分する」を実クリック' });

  while ((await js(win, MEASURE_DRAWER)).spineCount > 0) {
    const shelf = await js(win, MEASURE_DRAWER);
    await openSpineByTitle(win, shelf.spineTitles[0]);
    await realClick(win, '.routing-hub-info-library-dispose');
    await waitFor(win, `!!document.querySelector('.routing-hub-info-library-confirm')`, 'dispose confirmation', { tries: 200 });
    await realClick(win, '.routing-hub-info-library-confirm-accept');
    await waitFor(win, `!document.querySelector('.routing-hub-info-library-confirm')`, 'confirmation closed after dispose', { tries: 300 });
  }
  measurements.collection_empty = await js(win, MEASURE_DRAWER);
  const savedWhenEmpty = await fetchCollectionEntries(win);
  check('F6 disposing every book ends at the empty shelf, with the empty state and no 並び替え row',
    measurements.collection_empty.spineCount === 0 && measurements.collection_empty.sortPresent === false
    && measurements.collection_empty.emptyCard === 'まだ何も収蔵されていません' && savedWhenEmpty.length === 0, measurements.collection_empty);
  images.push({ ...await capture(win, outDir, 'collection-empty'), state: '空の棚（全冊を確認つきで処分した後）', operation: '残りの本を順に「処分」→「処分する」で実クリック' });

  measurements.hub_stage_calls = {
    read: hubStage.proxy.countOf('/api/library/read'),
    footnotes: hubStage.proxy.countOf('/api/library/footnotes'),
    favorite: hubStage.proxy.countOf('/api/library/collection/favorite'),
    dispose: hubStage.proxy.countOf('/api/library/collection/dispose'),
    collection_get: hubStage.proxy.countOf('/api/library/collection')
  };


  // ── Stage 2: 同順位の棚（figure は増やさない・check だけを足す） ───────────────────────────────────────────
  // 承認図の棚は読んだ週が3値とも相異なるので同順位が起きない。4軸の tie-break（週 desc → entry_id asc）を実機で
  // 測るために、別 fixture の棚を実 read で組む。期待列はこの fixture に対して固定した literal（下の EXPECTED）で、
  // 製品と同形の comparator は harness に書かない。
  //
  // 棚（収蔵された順＝entry_id の昇順。この一致は下の check で実測する）:
  //   T1 星降りの理           / 世界の理   / 第5週 / ★     ← T2 と題・分類・週が同値、★ だけが違う
  //   T2 星降りの理           / 世界の理   / 第5週 / ☆
  //   T3 月光苔の観察記       / 動植物誌   / 第5週 / ☆
  //   T4 六つの相 — 系統魔法総論 / 系統総論 / 第2週 / ★
  //
  // この fixture の ja 照合順（Intl.Collator('ja') 昇順・値は fixture の題／分類そのもの）:
  //   題   月光苔の観察記 < 星降りの理 < 六つの相 — 系統魔法総論
  //   分類 系統総論 < 世界の理 < 動植物誌
  const TIE_ROWS = [
    { name: 'T1', title: CATALOG_THREE[0].title, category: '世界の理', read_week: 5, favorite: true },
    { name: 'T2', title: CATALOG_THREE[0].title, category: '世界の理', read_week: 5, favorite: false },
    { name: 'T3', title: CATALOG_THREE[1].title, category: '動植物誌', read_week: 5, favorite: false },
    { name: 'T4', title: CATALOG_THREE[2].title, category: '系統総論', read_week: 2, favorite: true }
  ];
  // 各軸の期待列。同順位がどこで解けるかを1行ずつ書き下したもの。
  const TIE_EXPECTED = {
    // 週 desc: 第5週 {T1,T2,T3} は三つとも同順位 → entry_id asc、そのあと第2週 {T4}。
    read_week: ['T1', 'T2', 'T3', 'T4'],
    // 題 asc: 月光苔(T3) → 星降り(T1,T2) → 六つの相(T4)。星降りの2冊は週も同値なので entry_id asc。
    title: ['T3', 'T1', 'T2', 'T4'],
    // 分類 asc: 系統総論(T4) → 世界の理(T1,T2) → 動植物誌(T3)。世界の理の2冊は週も同値なので entry_id asc。
    category: ['T4', 'T1', 'T2', 'T3'],
    // ★先頭: {T1,T4} は週 desc で T1(5)→T4(2)。☆の {T2,T3} は週が同値なので entry_id asc。
    favorite: ['T1', 'T4', 'T2', 'T3']
  };

  const tieFixture = await buildFixture(repoRoot, 'library-expansion-render-tie-', { manifestFilename: runtimePathsManifestFilename });
  teardown.push(() => fs.rm(tieFixture.root, { recursive: true, force: true }));
  const tieStage = await startStage(repoRoot, createServer, tieFixture, lm.baseUrl);
  teardown.push(() => new Promise((resolve) => tieStage.proxy.server.close(resolve)));
  teardown.push(() => new Promise((resolve) => tieStage.server.close(resolve)));

  // 収蔵は全部実 read。★は実 POST。T1 を先に読んで★を付けてから同じ本をもう一度読むので、★を押す時点では
  // その題の背表紙は棚に1本しかない（並び順に依存せず対象が決まる）。
  const bankTieBook = async (title, week) => {
    await openClient(win, tieStage);
    await writeRuntimeState(tieFixture.slotRoot, week);
    await bankRead(win, { book_id: CATALOG_THREE.find((book) => book.title === title).id });
  };
  const markTieFavorite = async (title) => {
    await openHubDrawer(win, tieStage);
    await openSpineByTitle(win, title);
    await realClick(win, '.routing-hub-info-library-favorite');
    await waitFor(win, `document.querySelector('.routing-hub-info-library-favorite').dataset.on === 'true'`, `tie-stage favorite on for ${title}`, { tries: 200 });
    await backToShelf(win);
  };
  await bankTieBook(TIE_ROWS[0].title, TIE_ROWS[0].read_week);
  await markTieFavorite(TIE_ROWS[0].title);
  await bankTieBook(TIE_ROWS[1].title, TIE_ROWS[1].read_week);
  await bankTieBook(TIE_ROWS[2].title, TIE_ROWS[2].read_week);
  await bankTieBook(TIE_ROWS[3].title, TIE_ROWS[3].read_week);
  await markTieFavorite(TIE_ROWS[3].title);

  const tieBanked = await fetchCollectionEntries(win);
  measurements.collection_tie_seed = tieBanked.map((entry) => ({ entry_id: entry.entry_id, title: entry.title, category: entry.category, read_week: entry.read_week, favorite: entry.favorite }));
  const tieIdsInBankOrder = tieBanked.map((entry) => entry.entry_id);
  check('F5 tie: the shelf is the declared 4冊 and entry_id ascending IS the order they were read in',
    tieBanked.length === TIE_ROWS.length
    && TIE_ROWS.every((row, index) => tieBanked[index].title === row.title && tieBanked[index].category === row.category
      && tieBanked[index].read_week === row.read_week && tieBanked[index].favorite === row.favorite)
    && JSON.stringify(tieIdsInBankOrder) === JSON.stringify([...tieIdsInBankOrder].sort()),
    { declared: TIE_ROWS, saved: measurements.collection_tie_seed });
  const tieEntryIdOf = new Map(TIE_ROWS.map((row, index) => [row.name, tieIdsInBankOrder[index]]));

  // 背表紙から entry_id は読めないので、照合は (題, ★) の対で行う。この4冊はその対が全て相異なるので、棚に並んだ
  // (題, ★) の列は entry_id の列を一意に決める — この一意性そのものを先に実測する。
  const tieMark = (row) => `${row.title}／${row.favorite ? '★' : '☆'}`;
  check('F5 tie: (題, ★) tells the four books apart, so the shelf order names one entry_id order and no other',
    new Set(TIE_ROWS.map(tieMark)).size === TIE_ROWS.length, { marks: TIE_ROWS.map(tieMark) });

  await openHubDrawer(win, tieStage);
  measurements.collection_tie_axes = {};
  for (const sortKey of ['title', 'category', 'read_week', 'favorite']) {
    const chosen = await chooseSort(win, sortKey);
    const shelf = await js(win, MEASURE_DRAWER);
    const shelfMarks = shelf.spineTitles.map((title, index) => `${title}／${shelf.spineFavorites[index] === 'true' ? '★' : '☆'}`);
    const expectedNames = TIE_EXPECTED[sortKey];
    const expectedMarks = expectedNames.map((name) => tieMark(TIE_ROWS.find((row) => row.name === name)));
    const expectedEntryIds = expectedNames.map((name) => tieEntryIdOf.get(name));
    measurements.collection_tie_axes[sortKey] = {
      input: chosen, sortValue: shelf.sortValue, shelfMarks, expectedNames, expectedMarks, expectedEntryIds
    };
    check(`F5 tie: the ${sortKey} axis, reached by a real key press, lands on the fixed expected entry_id order`,
      chosen.value_before !== chosen.value_after && shelf.sortValue === sortKey
      && JSON.stringify(shelfMarks) === JSON.stringify(expectedMarks),
      measurements.collection_tie_axes[sortKey]);
  }
  measurements.tie_stage_calls = {
    read: tieStage.proxy.countOf('/api/library/read'),
    favorite: tieStage.proxy.countOf('/api/library/collection/favorite'),
    collection_get: tieStage.proxy.countOf('/api/library/collection')
  };
  // ── audit / presentation / checksums ───────────────────────────────────────────────────────────────────────
  const audit = {
    generated_at: new Date().toISOString(),
    started_at: started,
    implementation_head: headCommit,
    repo_root: repoRoot,
    out_dir: outDir,
    viewport: VIEWPORT,
    png_dimensions: EXPECTED_PNG,
    capture_procedure: '状態を確立 → requestAnimationFrame 2回同期 → webContents.invalidate() → 400ms 静定 → 1枚捨て撮り → 200ms → 本撮り。live animation（busy dot / 脚注 wait dot / hub starfield）は止めない。',
    capture_inputs: {
      pointer: 'webContents.sendInputEvent の mouseMove/mouseDown/mouseUp。押す点は要素の中心で、別要素に覆われていれば die する。',
      keyboard: 'webContents.sendInputEvent の keyDown/keyUp（Tab / Shift+Tab / Escape / Return / 文字入力）。',
      select: '並び替えの <select> も実キー入力で操作している。pointer は OS の popup menu を開くので使えず、Arrow キーは select に届くが値を動かさない（実測: keydown/keyup は届き、value 不変・change 0件）。効くのは type-ahead で、実 Tab で focus を運び、option ラベルの先頭文字（読／題／分／お）を char event として送ると option が選ばれ、製品自身の change handler が走る。value 代入も合成 event も使っていない。'
    },
    fault_seam: {
      what: '実サーバの前に置いた proxy。既定は素通しで、armFault は次の1件だけを実 HTTP エラー（503 + error_code）で返し、armDelay は次の1件だけを指定 ms 保持する。',
      why: 'ブラウザ側で fetch を差し替えたり応答 shape を偽装したりせずに、失敗と待ちを実 HTTP の事象として作るため。',
      armed: ['/api/library/read', '/api/library/footnotes', '/api/library/collection/favorite', '/api/library/collection/dispose']
    },
    lm_stub: {
      what: 'LM Studio の chat-completions を話す決定的 stub。製品の prompt 文面で呼び分け、未知 prompt は 500 で落とす。',
      bodies: '生成本文・骨子は上流 preview の fixture 文面をそのまま流用（新規 authored 本文は書いていない）。'
    },
    fixture: {
      isolation: 'OS temp の root/slot/definitions/settings。実セーブ（リポの data/mutable）は開かない。',
      collection_seeded_by: '空の収蔵庫から始め、棚の本はすべて製品の POST /api/library/read をページから送って収蔵した（大書庫の画面は通さない）。',
      core_references_override: FIXTURE_CORE_REFERENCES,
      core_references_note: '本番の対応表は変更していない。隔離 fixture の写しで3 key だけを差し替えた。',
      player_parameters: { light: 25, dark: 10, strength: 25 },
      tie_case: {
        why: '承認図の棚は読んだ週が3値とも相異なるので同順位が起きない。4軸の tie-break（週 desc → entry_id asc）を実機で測るための別 fixture。',
        shelf: TIE_ROWS,
        expected_orders: TIE_EXPECTED,
        expected_entry_ids: Object.fromEntries(Object.entries(TIE_EXPECTED).map(([axis, names]) => [axis, names.map((name) => tieEntryIdOf.get(name))])),
        oracle: '期待列はこの fixture に対して固定した literal。harness に製品と同形の comparator は書いていない。',
        identification: '背表紙から entry_id は読めないので (題, ★) の対で照合する。4冊はその対が全て相異なり、その一意性自体を実測している。',
        figures: 'この検証ケースからは1図も撮らない。'
      }
    },
    capture_differences: [
      'ハブの背景は動きのある夜空なので、星の位置は撮るたびに違う。',
      '迎え会話を起こしていないため、ドロワーの奥に案内人の立ち絵は入らない（実際の遊戯中は立ち絵が入る場所）。',
      '中核の関連題は隔離 fixture の対応表によるもので、本番の対応表が返す題とは異なる。生成本文・骨子・生成題は決定的 stub の出力で、実モデルの文面ではない。'
    ],
    checks,
    images,
    measurements
  };
  await fs.writeFile(path.join(outDir, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outDir, 'presentation.md'), renderPresentation(audit), 'utf8');
  const manifest = [];
  for (const name of [...images.map((image) => image.file), 'audit.json', 'presentation.md'].sort()) {
    const bytes = await fs.readFile(path.join(outDir, name));
    manifest.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(outDir, 'sha256.txt'), `${manifest.join('\n')}\n`, 'utf8');

  log('images', images.length);
  log('checks', { total: checks.length, passed: checks.filter((entry) => entry.pass).length });
  log('audit written', path.join(outDir, 'audit.json'));
}

// The presentation原本 lives here (tracked), and the publication copy is what this run writes out.
function renderPresentation(audit) {
  const rows = audit.images.map((image) => `| \`${image.file}\` | ${image.state} | ${image.operation} | ${image.bytes} | ${image.width}×${image.height} |`);
  return [
    '# ハブの書斎棚 — 製品実装の実機QA',
    '',
    `ルーティングハブの収蔵庫（書斎棚）の全状態を実 Blink・実 HTTP で撮った${audit.images.length}図です。`,
    `実装 HEAD は \`${audit.implementation_head}\`、撮影条件は CSS ビューポート ${audit.viewport.width}×${audit.viewport.height} / DPR ${audit.viewport.dpr} / PNG ${audit.png_dimensions.width}×${audit.png_dimensions.height} です。`,
    '',
    '- **画面も応答も本物です。** サーバは製品の `createServer`、画面は製品の `index.html` / `app.js` / `style.css`、`/api/library*` はすべて実 HTTP です。',
    '- **待ちと失敗は、ブラウザの外で作っています。** 実サーバの前に置いた seam が、指定した1件だけを実 HTTP エラーで返すか、指定した時間だけ保持します。ページの中身は差し替えていません。',
    '- **言語モデルだけが決定的なスタブ**です。生成本文・骨子は上流の提示物と同じ文面を流用しています。',
    '- **セーブは触っていません。** 収蔵庫は空から始め、棚の本はすべて製品の read で収蔵したものです。',
    '',
    '## 図の一覧（操作と状態）',
    '',
    '| 図 | 状態 | 操作 | bytes | 実寸 |',
    '| --- | --- | --- | ---: | --- |',
    ...rows,
    '',
    '## 図の外の説明（fixture と stub の限界）',
    '',
    ...audit.capture_differences.map((line) => `- ${line}`),
    `- 並び替えの同順位（題・分類・お気に入りが並び、読んだ週まで同じところまで降りる場合）は、承認図の棚では起きないため、別に組んだ4冊の棚で測っています。この検証は\`audit.json\`の\`fixture.tie_case\`にあり、図は撮っていません（${audit.fixture.tie_case.shelf.length}冊・${Object.keys(audit.fixture.tie_case.expected_orders).length}軸）。`,
    `- 並び替えの選択欄も実際のキー入力で操作しています。${audit.capture_inputs.select}`,
    '',
    `全 ${audit.checks.length} 件の実測チェックはすべて PASS しています（内訳は \`audit.json\` の \`checks\`）。`,
    ''
  ].join('\n');
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    exitCode = 1;
    console.error(`libraryExpansionRender failed: ${error && error.stack ? error.stack : error}`);
  } finally {
    for (const step of teardown.reverse()) {
      try { await step(); } catch (error) { console.error(`teardown failed: ${error}`); }
    }
    app.exit(exitCode);
  }
});
