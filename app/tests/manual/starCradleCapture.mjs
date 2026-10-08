// 星の揺り籠を、製品の通常の道（タイトル → ロード → 露台 → 天球儀）で開いて 1440x900 に撮る手回しの道具（*.test.mjs ではないので
// npm test は拾わない）:
//
//   <electron> app/tests/manual/starCradleCapture.mjs --repo-root <絶対パス> --out <絶対パス> --plan <絶対パス> --scenes <名,名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品を、OS の一時ディレクトリに作った
// 新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。LM は固定応答（露台の最初の一言と表情の選択だけ）で、
// 知らない要求は 500 にして撮影ごと止める。--out は無いか空であること（既にある file は上書きしない）。--plan は構成案の置き場で、
// そこの plan-<画面>.png を左・撮った姿を右に並べた compare-<画面>.png を書く。
//
// 撮った各枚について、見えている字（窓の内側・実効の不透明度 0.05 超・その点で一番上に描かれている要素の字）を
// <out>/text/<file>.json に書き、その場面の view と持ち物から引ける名（品種・種・卵・変貌・付けた名・品の名）と数（「3」「×2」）の
// どれにも当たらない字を「説明の字」として数える。説明の字が 1 つでもあれば run は失敗する。
// 手がかり（載せ直した印と数）ごとに、その要素の見えている箱を切り出した clue-<名>.png を書く。
//
// 場面（scene）:
//   empty      何も植えていない揺り籠を開いた直後。                         → built-star-cradle.png（構成案 plan-star-cradle.png と並べる）
//   filled     第 8 週・鉢 3・生き物 3・籠 1・種と卵と素材を持つ揺り籠を開いた直後。 → built-star-cradle-filled.png
//              続けて蕾の球根（鉢の 2 つ目）を押して選ぶ。                   → built-star-cradle-selected.png（plan-star-cradle-filled.png と並べる）
//              続けて成体の副産物を受け取り、名付けの紋を押す。             → built-star-cradle-claimed-naming.png
//   bare       filled と同じ揺り籠で素材を持たずに、蕾の球根を選ぶ。       → built-star-cradle-bare.png
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const SCENE_LIMIT_MS = 240000;
const COMPARE_GAP = 24;
const CLUE_PAD = 10;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--plan', '--scenes'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  return { repoRoot: path.resolve(parsed['--repo-root']), out: path.resolve(parsed['--out']), plan: path.resolve(parsed['--plan']), scenes };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

async function writeJson(root, relativePath, value) {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ── 固定応答の LM（言葉は撮影のための仮の文・製品の本文ではない） ──────────────────────────────────────────────
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';
const FIXTURE_CHAT_LINE = '（顔を上げて）あ、こんにちは。ちょうど一息つこうと思っていたところです。';

function fixtureAnswer(body) {
  const schemaName = body.response_format?.json_schema?.name ?? null;
  if (schemaName === 'character_emotion_choice') return { kind: schemaName, content: JSON.stringify({ expression: 'neutral' }) };
  if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
  if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat-line', content: FIXTURE_CHAT_LINE };
  const prompt = body.messages.map((message) => message.content ?? '').join('\n');
  throw new Error(`fixture lm: unknown request (model ${body.model}, stream ${body.stream === true}): ${prompt.slice(-160)}`);
}

// ── 揺り籠を埋める（一時のセーブの slot だけに書く） ───────────────────────────────────────────────────────────
// 鉢と生き物の狙う姿。seed と植えた週は、製品の導出（plantView・creatureView）がこの姿を返す最初の組を探して決める（無ければ throw）。
const CRADLE_WEEK = 8;
const CRADLE_POTS = [
  { item_id: 'star_cradle_hoshikusa_seed', feed: {}, want: (v) => v.revealed && v.golden === true },
  { item_id: 'star_cradle_yuragi_bulb', feed: { fire: 2 }, want: (v) => v.stage === '蕾' },
  { item_id: 'star_cradle_hoshikusa_seed', feed: {}, want: (v) => v.stage === '若葉' }
];
const CRADLE_CREATURES = [
  { item_id: 'star_cradle_warm_egg', feed: {}, name: 'ヨル', want: (v) => v.adult && v.mutation !== null && v.byproduct_pending_weeks > 0 },
  { item_id: 'star_cradle_madara_egg', feed: {}, name: null, want: (v) => v.stage === '幼体' },
  { item_id: 'star_cradle_madara_egg', feed: { water: 1 }, name: null, want: (v) => v.stage === '卵' }
];
const CRADLE_CAGED = { item_id: 'star_cradle_madara_egg', feed: {}, name: null, caged_week: 6, want: (identity) => identity.variety.id === 'c03' };
const CRADLE_SEEDS = [
  { item_id: 'star_cradle_hoshikusa_seed', quantity: 2 },
  { item_id: 'star_cradle_madara_egg', quantity: 1 }
];
const CRADLE_MATERIALS = [
  { item_id: 'material_fire_t1', quantity: 3 },
  { item_id: 'material_water_t2', quantity: 2 },
  { item_id: 'material_light_t1', quantity: 4 }
];

function findRecord(viewOf, base, want) {
  for (let seed = 1; seed < 200000; seed += 1) {
    for (let plantedWeek = 0; plantedWeek <= CRADLE_WEEK; plantedWeek += 1) {
      const record = { ...base, planted_week: plantedWeek, seed };
      if (want(viewOf(record))) return record;
    }
  }
  throw new Error(`no seed gives the wanted star cradle state for ${base.item_id}`);
}

async function fillCradle(product, slotRoot, { materials }) {
  const { createStorageApi } = await product('storage.mjs');
  const { loadStarCradleCatalog } = await product('starCradleCatalog.mjs');
  const { plantView, creatureView, resolveCreatureIdentity } = await product('starCradle.mjs');
  const { writeStarCradleSurface, writeStarCradleCreaturesSurface } = await product('starCradleSurface.mjs');
  const { requireRoutingContentWeek } = await product('routingContentResult.mjs');
  const storage = createStorageApi({ root: slotRoot });
  const catalog = await loadStarCradleCatalog({ storage });
  const pots = CRADLE_POTS.map(({ item_id, feed, want }, slot_index) =>
    findRecord((record) => plantView(catalog, record, CRADLE_WEEK), { slot_index, item_id, feed }, want));
  const creatures = CRADLE_CREATURES.map(({ item_id, feed, name, want }, slot_index) => {
    const found = findRecord((record) => creatureView(catalog, { ...record, last_byproduct_week: record.planted_week }, CRADLE_WEEK), { slot_index, item_id, feed, name }, want);
    return { ...found, last_byproduct_week: found.planted_week };
  });
  let cagedSeed = 1;
  while (!CRADLE_CAGED.want(resolveCreatureIdentity(catalog, { item_id: CRADLE_CAGED.item_id, seed: cagedSeed, feed: CRADLE_CAGED.feed }))) cagedSeed += 1;
  const caged = { instance_id: `sc_creature_${cagedSeed}`, item_id: CRADLE_CAGED.item_id, seed: cagedSeed, feed: CRADLE_CAGED.feed, name: CRADLE_CAGED.name, caged_week: CRADLE_CAGED.caged_week };
  await writeStarCradleSurface({ storage, surface: { version: 1, pots, creatures } });
  await writeStarCradleCreaturesSurface({ storage, surface: { version: 1, instances: [caged] } });
  const inventory = await storage.readJson('game_data/player_inventory.json');
  inventory.items.push(...CRADLE_SEEDS, ...(materials ? CRADLE_MATERIALS : []));
  await storage.writeJson('game_data/player_inventory.json', inventory);
  const state = await storage.readJson('game_data/runtime_state.json');
  requireRoutingContentWeek(state);
  state.elapsed_weeks = CRADLE_WEEK;
  await storage.writeJson('game_data/runtime_state.json', state);
  return `week ${CRADLE_WEEK}: pots ${pots.map((r) => `${r.item_id}#${r.seed}@${r.planted_week}`).join(' ')}; creatures ${creatures.map((r) => `${r.item_id}#${r.seed}@${r.planted_week}`).join(' ')}; caged ${caged.instance_id}; materials ${materials}`;
}

// 場面ごとに一つ: 一時のセーブ・固定応答の LM・製品サーバー。lmFailures は 500 にした要求。
async function startProduct(repoRoot, cradle) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'star-cradle-capture-'));
  const closers = [];
  const lmFailures = [];
  try {
    await fs.cp(path.join(repoRoot, 'data/definitions'), path.join(root, 'data/definitions'), { recursive: true });
    await fs.cp(path.join(repoRoot, 'data/seeds'), path.join(root, 'data/seeds'), { recursive: true });
    await fs.cp(path.join(root, 'data/seeds/game_data'), path.join(root, 'data/mutable/game_data'), { recursive: true });
    await writeJson(root, runtimePathsManifestFilename, {
      configRoot: path.join(root, 'app/config'),
      definitionsRoot: path.join(root, 'data/definitions/game_data'),
      seedsRoot: path.join(root, 'data/seeds/game_data'),
      mutableRoot: path.join(root, 'data/mutable/game_data'),
      characterContentRoot: path.join(repoRoot, 'content/characters'),
      creatureContentRoot: path.join(repoRoot, 'content/creatures'),
      canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
      publicRoot: path.join(repoRoot, 'app/public'),
      resourceRoot: root
    });
    const { root: slotRoot } = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    const filled = cradle === null ? null : await fillCradle(product, slotRoot, cradle);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = fixtureAnswer(body);
      } catch (error) {
        lmFailures.push(error.message);
        console.log(`fixture-lm 500: ${error.message}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message) }));
        return;
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const characters = [...reply.content];
      for (let index = 0; index < characters.length; index += 3) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: characters.slice(index, index + 3).join('') } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
    const lmPort = await listen(lm);
    closers.push(() => closeServer(lm));
    await writeJson(root, 'app/config/lmstudio.json', {
      provider: 'lmstudio',
      base_url: `http://${HOST}:${lmPort}/v1`,
      chat_model: FIXTURE_CHAT_MODEL,
      reflection_model: FIXTURE_REFLECTION_MODEL,
      timeout_ms: 120000,
      stream: true,
      thinking_effort: null,
      mock_provider_enabled: false
    });
    const server = createServer({
      root,
      publicRoot: path.join(repoRoot, 'app/public'),
      canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
      playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
      conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
      audioSettingsPath: path.join(root, 'app/config/audio.json'),
      lmStudioConfigPath: path.join(root, 'app/config/lmstudio.json')
    });
    const port = await listen(server);
    closers.push(() => closeServer(server));
    return {
      base: `http://${HOST}:${port}`,
      filled,
      lmFailures,
      async stop() {
        for (const close of closers.reverse()) await close();
        await fs.rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

// ── 窓（CDP） ────────────────────────────────────────────────────────────────────────────────────────────────
async function openPage(guard) {
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (event, level, message) => {
    if (level === 3) {
      pageErrors.push(message);
      console.log(`renderer-error: ${message}`);
    }
  });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js,
    pageErrors,
    async load(url) {
      await win.loadURL(url);
      const measured = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
      if (measured.w !== VIEWPORT.width || measured.h !== VIEWPORT.height || measured.dpr !== 1) throw new Error(`viewport ${JSON.stringify(measured)}`);
    },
    async waitFor(predicate, label, timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        guard();
        const ok = await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`);
        if (ok) return;
        await sleep(40);
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    async click(selectorExpr, label) {
      const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    async png() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    close() {
      win.destroy();
    }
  };
  return page;
}

// 見えている字: 窓の内側・実効の不透明度 0.05 超で、字の箱の中心で一番上に描かれている要素がその字の要素（か子）であるもの
// （揺り籠の地の下に隠れた露台の字は数えない）。読み上げの名・alt も、見えている要素の分だけ別に並べる。
const VISIBLE_TEXT = `(() => {
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none') return 0; o *= parseFloat(cs.opacity); } return o; };
  const onTop = (el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2))); return hit !== null && (el.contains(hit) || hit.contains(el)); };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && opacityOf(el) > 0.05 && !el.closest('[hidden]') && onTop(el); };
  const where = (el) => { const owner = el.closest('[id]'); const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.'); return (owner ? '#' + owner.id + ' ' : '') + el.tagName.toLowerCase() + (cls ? '.' + cls : ''); };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || !el || el.closest('script, style, template, svg title')) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    texts.push({ text, where: where(el), x: Math.round(r.left), y: Math.round(r.top) });
  }
  const inputs = [...document.querySelectorAll('input, textarea')].filter(visible).map((el) => ({ value: el.value, placeholder: el.getAttribute('placeholder'), where: where(el) }));
  const attrs = [];
  for (const el of document.querySelectorAll('[aria-label], [title], [placeholder], img[alt]')) {
    if (!visible(el)) continue;
    for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = el.getAttribute(name);
      if (value && value.trim()) attrs.push({ attr: name, value: value.trim(), where: where(el) });
    }
  }
  return { texts, inputs, attrs };
})()`;

// 字の照合: その場面の view と持ち物から引ける名（品種・種・卵・変貌・付けた名・品の名）と数だけを許す。
const KNOWN_WORDS = `(async () => {
  const [view, inventory] = await Promise.all([fetch('/api/star-cradle').then((r) => r.json()), fetch('/api/inventory').then((r) => r.json())]);
  const names = new Set();
  for (const record of [...view.pots, ...view.creatures, ...view.caged]) {
    for (const value of [record.name, record.seed_item?.name, record.variety?.name, record.mutation?.name]) if (typeof value === 'string') names.add(value);
  }
  for (const item of inventory.items) if (/^(star_cradle_|material_)/.test(item.item_id)) names.add(item.name);
  return [...names];
})()`;
const NUMBER_WORD = /^×?[0-9,]+$/;

const CRADLE_OPEN = "!document.querySelector('#routing-hub-star-cradle').hidden && document.querySelector('#routing-hub-star-cradle-status').hidden && document.querySelector('#routing-hub-star-cradle-garden').children.length > 0 && [...document.querySelectorAll('#routing-hub-star-cradle img')].every((img) => img.complete && img.naturalWidth > 0) && document.querySelector('#routing-hub-star-cradle').getAnimations().every((a) => a.playState !== 'running')";
const HUB_READY = "document.querySelector('#routing-hub-screen.active') && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'";
const GARDEN_IMAGE = "(() => { const url = getComputedStyle(document.querySelector('#routing-hub-star-cradle-garden')).backgroundImage; const img = new Image(); img.src = url.slice(5, -2); return img.decode().then(() => url); })()";

async function walkToCradle(page, base, steps) {
  await page.load(`${base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'the footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  steps.push('title → ロード → slot → terrace');
  await page.click("document.querySelector('#routing-hub-cradle-globe')", '星の揺り籠');
  await page.waitFor(CRADLE_OPEN, 'the star cradle');
  await page.js(GARDEN_IMAGE);
  await sleep(SETTLE_MS);
  steps.push('press the star cradle globe');
}

// 撮る: png・見えている字・照合。説明の字があれば throw する。
function shooter(options, page, steps, record) {
  return async function shoot(file) {
    await page.moveAway();
    await sleep(300);
    const bytes = await page.png();
    if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${file}.png is not ${VIEWPORT.width}x${VIEWPORT.height}`);
    const seen = await page.js(VISIBLE_TEXT);
    const known = new Set(await page.js(KNOWN_WORDS));
    const explaining = seen.texts.filter(({ text }) => !known.has(text) && !NUMBER_WORD.test(text));
    await fs.writeFile(path.join(options.out, `${file}.png`), bytes, { flag: 'wx' });
    await fs.writeFile(path.join(options.out, 'text', `${file}.json`), `${JSON.stringify({ ...seen, known: [...known], explaining }, null, 2)}\n`, { flag: 'wx' });
    steps.push(`shot ${file}.png`);
    console.log(`shot ${file}.png: ${seen.texts.length} visible words, ${explaining.length} explaining`);
    for (const { text, where } of seen.texts) console.log(`  word ${JSON.stringify(text)} ${NUMBER_WORD.test(text) ? 'number' : known.has(text) ? 'name' : 'EXPLAINING'} @ ${where}`);
    for (const { value, placeholder, where } of seen.inputs) console.log(`  input value=${JSON.stringify(value)} placeholder=${JSON.stringify(placeholder)} @ ${where}`);
    record.shots.push({ file: `${file}.png`, words: seen.texts.length, explaining: explaining.length });
    if (explaining.length > 0) throw new Error(`${file}.png shows explaining words: ${explaining.map((e) => e.text).join(' | ')}`);
    return bytes;
  };
}

// 手がかりの切り出し: selectors の要素の箱（見えている分の和）を shot から切り出して clue-<name>.png に書く。
async function cutClue(options, page, record, shotFile, bytes, name, selectorsExpr) {
  const box = await page.js(`(() => {
    const rects = (${selectorsExpr}).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;
    const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - ${CLUE_PAD});
    const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - ${CLUE_PAD});
    const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + ${CLUE_PAD});
    const bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + ${CLUE_PAD});
    return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
  })()`);
  if (box === null) throw new Error(`clue ${name} has nothing on screen in ${shotFile}`);
  const data = await page.js(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${bytes.toString('base64')}';
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${box.w};
    canvas.height = ${box.h};
    canvas.getContext('2d').drawImage(img, ${box.x}, ${box.y}, ${box.w}, ${box.h}, 0, 0, ${box.w}, ${box.h});
    return canvas.toDataURL('image/png');
  })()`);
  await fs.writeFile(path.join(options.out, `clue-${name}.png`), Buffer.from(data.split(',')[1], 'base64'), { flag: 'wx' });
  record.clues.push({ clue: name, from: shotFile, box });
  console.log(`clue-${name}.png from ${shotFile} ${JSON.stringify(box)}`);
}

// 左に構成案・右に作った姿を並べた一枚。
async function compare(options, page, record, planFile, builtFile, outFile) {
  const left = (await fs.readFile(path.join(options.plan, planFile))).toString('base64');
  const right = (await fs.readFile(path.join(options.out, builtFile))).toString('base64');
  const data = await page.js(`(async () => {
    const load = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
    const [a, b] = await Promise.all([load('data:image/png;base64,${left}'), load('data:image/png;base64,${right}')]);
    const canvas = document.createElement('canvas');
    canvas.width = ${VIEWPORT.width * 2 + COMPARE_GAP};
    canvas.height = ${VIEWPORT.height};
    const context = canvas.getContext('2d');
    context.fillStyle = '#05060f';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(a, 0, 0);
    context.drawImage(b, ${VIEWPORT.width + COMPARE_GAP}, 0);
    return canvas.toDataURL('image/png');
  })()`);
  await fs.writeFile(path.join(options.out, outFile), Buffer.from(data.split(',')[1], 'base64'), { flag: 'wx' });
  record.compares.push({ file: outFile, left: planFile, right: builtFile });
  console.log(`${outFile} = ${planFile} | ${builtFile}`);
}

const q = (selector) => `[...document.querySelectorAll(${JSON.stringify(`#routing-hub-star-cradle ${selector}`)})]`;
const SPOT = (n) => `#routing-hub-star-cradle-garden > .routing-hub-star-cradle-spot:nth-child(${n})`;

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
const SCENES = {
  empty: {
    cradle: null,
    async run({ options, page, shoot, record }) {
      const bytes = await shoot('built-star-cradle');
      await compare(options, page, record, 'plan-star-cradle.png', 'built-star-cradle.png', 'compare-star-cradle.png');
      await cutClue(options, page, record, 'built-star-cradle.png', bytes, 'free-slots-3', q('.routing-hub-star-cradle-free'));
      await cutClue(options, page, record, 'built-star-cradle.png', bytes, 'no-seed-pouch', q('.routing-hub-star-cradle-station > [role="img"]'));
      await cutClue(options, page, record, 'built-star-cradle.png', bytes, 'empty-cage', q('.routing-hub-star-cradle-cage'));
      await cutClue(options, page, record, 'built-star-cradle.png', bytes, 'empty-seats', q('.routing-hub-star-cradle-spot > .routing-hub-star-cradle-figure'));
    }
  },
  filled: {
    cradle: { materials: true },
    async run({ options, page, shoot, record, steps }) {
      const filled = await shoot('built-star-cradle-filled');
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'plant-stage-art-and-names', q('.routing-hub-star-cradle-spot:nth-child(-n+3) :is(.routing-hub-star-cradle-sprite, .routing-hub-star-cradle-tag > .routing-hub-star-cradle-name:first-child)'));
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'golden-star-and-glow', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(1)} :is(.routing-hub-star-cradle-sprite, .routing-hub-star-cradle-mark)`)})]`);
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'growth-pips-and-fed', q('.routing-hub-star-cradle-meter, .routing-hub-star-cradle-fed'));
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'harvest-sigil', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(1)} .routing-hub-star-cradle-tag`)})]`);
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'creature-stage-art-and-mutation-star', q('.routing-hub-star-cradle-spot:nth-child(n+4):nth-child(-n+6) :is(.routing-hub-star-cradle-sprite, .routing-hub-star-cradle-tag > .routing-hub-star-cradle-name:first-child)'));
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'adult-byproduct-name-cage-sigils', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-actions`)})]`);
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'station-free-0-and-seeds', q('.routing-hub-star-cradle-station'));
      await cutClue(options, page, record, 'built-star-cradle-filled.png', filled, 'caged-creature', q('.routing-hub-star-cradle-cage'));
      await page.click(`document.querySelector(${JSON.stringify(`${SPOT(2)} button.routing-hub-star-cradle-figure`)})`, 'the bud bulb');
      await page.waitFor(`document.querySelector(${JSON.stringify(`${SPOT(2)}.is-selected .routing-hub-star-cradle-material`)})`, 'the bulb selected with materials');
      await sleep(SETTLE_MS);
      steps.push('press the bud bulb (pot 2)');
      const selected = await shoot('built-star-cradle-selected');
      await compare(options, page, record, 'plan-star-cradle-filled.png', 'built-star-cradle-selected.png', 'compare-star-cradle-filled.png');
      await cutClue(options, page, record, 'built-star-cradle-selected.png', selected, 'selected-gold-foot-and-materials', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(2)} :is(.routing-hub-star-cradle-figure, .routing-hub-star-cradle-tag)`)})]`);
      await page.click(`document.querySelector(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-actions button:first-child`)})`, 'the byproduct sigil');
      await page.waitFor(`document.querySelector(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-actions button:first-child`)}).disabled`, 'the byproduct claimed');
      steps.push('press the byproduct sigil of the adult (creature 1)');
      await page.click(`document.querySelector(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-actions button:nth-child(2)`)})`, 'the name sigil');
      await page.waitFor(`document.activeElement === document.querySelector(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-name-input`)})`, 'the name input open and focused');
      await sleep(SETTLE_MS);
      steps.push('press the name sigil of the adult (creature 1)');
      const naming = await shoot('built-star-cradle-claimed-naming');
      await cutClue(options, page, record, 'built-star-cradle-claimed-naming.png', naming, 'name-input-in-place', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-tag`)})]`);
      // 受け取り済みの淡い紋は名付けの入力が開くと退くので、入力を閉じてから切り出す。
      await page.js(`document.querySelector(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-name-input`)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await page.waitFor(`document.querySelector(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-actions button:first-child`)})?.disabled === true`, 'the name input closed');
      await sleep(SETTLE_MS);
      steps.push('Escape closes the name input');
      const claimed = await shoot('built-star-cradle-claimed');
      await cutClue(options, page, record, 'built-star-cradle-claimed.png', claimed, 'byproduct-claimed-quiet-sigil', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(4)} .routing-hub-star-cradle-actions`)})]`);
    }
  },
  bare: {
    cradle: { materials: false },
    async run({ options, page, shoot, record, steps }) {
      await page.click(`document.querySelector(${JSON.stringify(`${SPOT(2)} button.routing-hub-star-cradle-figure`)})`, 'the bud bulb');
      await page.waitFor(`document.querySelector(${JSON.stringify(`${SPOT(2)}.is-selected .routing-hub-star-cradle-actions [role="img"]`)})`, 'the bulb selected with the empty pouch');
      await sleep(SETTLE_MS);
      steps.push('press the bud bulb (pot 2) with no materials held');
      const bare = await shoot('built-star-cradle-bare');
      await cutClue(options, page, record, 'built-star-cradle-bare.png', bare, 'no-material-pouch', `[...document.querySelectorAll(${JSON.stringify(`${SPOT(2)} .routing-hub-star-cradle-tag`)})]`);
    }
  }
};

async function runScene(options, name, manifest) {
  const started = Date.now();
  const scene = SCENES[name];
  const product = await startProduct(options.repoRoot, scene.cradle);
  if (product.filled) console.log(`cradle ${product.filled}`);
  const page = await openPage(() => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  });
  const steps = [];
  const record = { scene: name, cradle: product.filled, steps, shots: [], clues: [], compares: [], seconds: null };
  manifest.scenes.push(record);
  try {
    let watchdog;
    await Promise.race([
      (async () => {
        await walkToCradle(page, product.base, steps);
        await scene.run({ options, page, shoot: shooter(options, page, steps, record), record, steps });
      })(),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`scene ${name} exceeded ${SCENE_LIMIT_MS / 1000} s`)), SCENE_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    if (page.pageErrors.length > 0) throw new Error(`renderer errors: ${JSON.stringify(page.pageErrors)}`);
  } finally {
    record.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    console.log(`scene ${name} ${steps.at(-1) ?? 'nothing'} in ${record.seconds} s`);
    page.close();
    await product.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await fs.readdir(options.out).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length > 0) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(path.join(options.out, 'text'), { recursive: true });
  await app.whenReady();
  const manifest = { viewport: VIEWPORT, scenes: [] };
  const failed = [];
  try {
    for (const name of options.scenes) {
      try {
        await runScene(options, name, manifest);
      } catch (error) {
        console.log(`SCENE FAILED ${name}: ${error.stack ?? error.message}`);
        failed.push(name);
      }
    }
  } finally {
    await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }
  if (failed.length > 0) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.on('window-all-closed', () => {});
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('FAILED', error.message);
    app.exit(1);
  });
