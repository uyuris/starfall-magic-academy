// 購買・採取・鍛錬（棚の画面）を、製品の通常の道で 1440x900 に撮る手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/shelvesCapture.mjs --repo-root <絶対パス> --out <絶対パス> --plans <絶対パス> --scenes <map|training,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・app/public・data・
// content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。
// LM は固定応答（下の表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。--out は無いか空であること。--plans は構成案の
// plan-shop.png・plan-gathering.png・plan-training.png がある所で、場面ごとに左が構成案・右が作った姿の一枚（compare-<画面>.png）を書く。
// 撮った枚ごとに、見えている字の全数と、その字を「場所の名・品や行いの名・値」のどれかに当てた結果を <out>/record-<場面>.json に書く。
// どれにも当たらない字（使い方を説明する文など）が一つでもあれば、その場面は失敗する。
//
// 場面（scene）:
//   map      露台で「学院マップ」へ → 山林 → 採取のピン → ここに行く → gathering-arrival → 採取の籠の紋を在庫のある二か所で押す
//            → 山林マップに戻る → 学院 → 購買のピン → ここに行く（深夜へ沈む途中を shop-sinking）→ shop-arrival → 手もとの一つ目を
//            押して使う・売るの紋を開く → shop-open。
//   training 露台で「鍛錬」へ → training-arrival（光曜の板が灯る・残り 6）→ 一つ目の板を押す → 結果と日の移りが済む →
//            training-after-action（闇曜の板が灯る・残り 5）。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const SCENE_LIMIT_MS = 300000;
// 購買への沈み（academyMapLayer.js の SHOP_NIGHT_SINK_MS 900ms）の途中を撮る時刻（押してから）。
const SINKING_SHOT_MS = 250;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--plans', '--scenes'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  for (const key of ['--repo-root', '--out', '--plans']) {
    if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], plans: parsed['--plans'], scenes };
}

// ── 製品と固定応答の LM（この process の中・一時のセーブ） ─────────────────────────────────────────────────────
// 言葉は撮影のための仮の文（製品の本文ではない）。
const FIXTURE_EXPRESSIONS = ['joy', 'surprised', 'shy', 'worried', 'determined', 'smug'];
const FIXTURE_CHAT_LINES = new Map([
  ['neutral', '（顔を上げて）あ、こんにちは。ちょうど一息つこうと思っていたところです。'],
  ['joy', '（ぱっと笑って）それ、すごくいいですね。聞いているだけで楽しくなります。'],
  ['surprised', 'えっ、本当ですか？　そんなふうに考えたこと、一度もなかったです。'],
  ['shy', '（少し目を伏せて）……そう言ってもらえると、なんだか照れますね。'],
  ['worried', 'でも、うまくいくかどうか。少しだけ心配なんです。'],
  ['determined', '（小さく頷いて）決めました。次の週までに、もう一度やってみます。'],
  ['smug', 'ふふ、見ていてください。きっと驚かせてみせますから。']
]);
const FIXTURE_REFLECTION_LINE = '学院で主人公と少し話した。';
const FIXTURE_PROMPT_ANSWERS = [
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0']
];
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

function createFixtureLm(hubLines) {
  const mood = { emotionAnswers: 0, expression: 'neutral' };
  return function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') {
      mood.expression = FIXTURE_EXPRESSIONS[mood.emotionAnswers % FIXTURE_EXPRESSIONS.length];
      mood.emotionAnswers += 1;
      return { kind: `${schemaName} ${mood.expression}`, content: JSON.stringify({ expression: mood.expression }) };
    }
    if (schemaName === 'work_record_recall_choice') return { kind: schemaName, content: JSON.stringify({ work_record_ids: [] }) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      if (matches.length > 1) throw new Error(`fixture lm: the hub conversation holds ${matches.length} destination lines`);
      const destination = matches.length === 1 ? matches[0][0] : 'none';
      return { kind: `hub-destination ${destination}`, content: destination };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { kind: 'event-flag false', content: 'false' };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) {
      if (prompt.includes(marker)) return { kind: marker, content };
    }
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: `chat-line ${mood.expression}`, content: FIXTURE_CHAT_LINES.get(mood.expression) };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: FIXTURE_REFLECTION_LINE };
    throw new Error(`fixture lm: unknown request (model ${body.model}, stream ${body.stream === true}): ${prompt.slice(-160)}`);
  };
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

// 場面ごとに一つ: 一時のセーブ・固定応答の LM・製品サーバー。
async function startProduct(repoRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const { trainingDefinitions } = await product('training.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelves-capture-'));
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
    await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    const answer = createFixtureLm(hubLines);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = answer(body);
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
      hubLines,
      trainingNames: trainingDefinitions.map((definition) => definition.name),
      assertNoLmFailure() {
        if (lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${lmFailures.join(' | ')}`);
      },
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
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
      const where = await js(STOPPED_AT).catch(() => null);
      throw new Error(`timed out waiting for ${label} (page: ${JSON.stringify(where)})`);
    },
    async click(selectorExpr, label) {
      const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) {
        await send('Input.insertText', { text: character });
        await sleep(30);
      }
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    // 隠れた窓は直前の合成のコマを返すことがある: 2 フレーム待ち・invalidate・捨て撮りを挟む。settle: false は
    // 移ろいの途中を撮るときで、捨て撮りを挟まない。
    async png({ settle = true } = {}) {
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      win.webContents.invalidate();
      if (settle) {
        await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await sleep(400);
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    close() {
      win.destroy();
    }
  };
  return page;
}

const STOPPED_AT = `({
  screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
  scene: document.querySelector('#journey')?.dataset.scene ?? null,
  statuses: [...document.querySelectorAll('[role=status], [aria-live]')].filter((el) => !el.hidden && el.textContent.trim() !== '').map((el) => el.id + ': ' + el.textContent.trim().slice(0, 160))
})`;

// 見えている字（実効の不透明度 0.05 超・窓の内側・上に別の要素が重なっていない）と、見えている要素の読み上げの名。
const VISIBLE_TEXT = `(() => {
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; o *= parseFloat(cs.opacity); } return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && opacityOf(el) > 0.05 && !el.closest('[hidden]'); };
  const onTop = (el) => { const r = el.getBoundingClientRect(); const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)); const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)); const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit) || hit.contains(el)); };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || !el || el.closest('script, style, template, svg')) continue;
    if (!visible(el) || !onTop(el)) continue;
    const r = el.getBoundingClientRect();
    texts.push({ text, x: Math.round(r.left), y: Math.round(r.top) });
  }
  const names = [];
  for (const el of document.querySelectorAll('[aria-label]')) {
    if (visible(el) && onTop(el)) names.push(el.getAttribute('aria-label'));
  }
  return { screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id), texts, names };
})()`;

// 置いた部品の数（構成案と比べる表の材料）。
const SHELF_COUNTS = `(() => {
  const count = (selector) => document.querySelectorAll(selector).length;
  const rows = (selector) => [...document.querySelectorAll(selector)].map((row) => row.children.length);
  return {
    shopShelves: rows('#shop-items .shop-shelf'),
    shopWaresDisabled: count('#shop-items .shop-ware:disabled'),
    shopEffects: count('#shop-items .shop-effect'),
    shopOwned: count('#shop-inventory-items .shop-owned'),
    shopOpenWays: [...document.querySelectorAll('#shop-inventory-items .shop-way')].map((way) => way.getAttribute('aria-label')),
    shopSatchelEmpty: document.querySelector('#shop-satchel')?.dataset.empty ?? null,
    gatheringSpots: [...document.querySelectorAll('#gathering-points .gathering-spot')].map((spot) => {
      const r = spot.querySelector('.gathering-vignette').getBoundingClientRect();
      return {
        name: spot.querySelector('.shelf-label-name').textContent,
        center: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)],
        harvest: !!spot.querySelector('.gathering-harvest'),
        stand: spot.querySelector('.gathering-vignette').dataset.stand ?? 'art',
        stock: spot.querySelector('.gathering-stock').getAttribute('aria-label')
      };
    }),
    trainingRemaining: document.querySelector('#academy-training-remaining')?.getAttribute('aria-label') ?? null,
    trainingDay: document.querySelector('#academy-training-day')?.getAttribute('aria-label') ?? null,
    trainingParams: count('#academy-training-player-parameters .academy-training-param'),
    trainingDrills: count('#academy-training-options .academy-training-drill'),
    trainingDrillsLit: [...document.querySelectorAll('#academy-training-options .academy-training-drill[data-today="true"]')].map((drill) => drill.getAttribute('aria-label')),
    grounds: [...document.querySelectorAll('.shelf-screen.active .shelf-ground')].map((img) => new URL(img.src).pathname)
  };
})()`;

// 字を「場所の名・品や行いの名・値」に当てる。名は製品のいまの応答から集める（場所の名は三つ）。値は形で当てる。
const PLACE_NAMES = new Set(['購買', '採取', '鍛錬']);
const VALUE_PATTERNS = [
  ['money', /^[\d,]+ G$/],
  ['count', /^×[\d,]+$/],
  ['effect', /^\+\d+$/],
  ['parameter', /^\d+$/],
  ['weekday', /^.曜$/]
];
function classifyTexts(texts, names) {
  return texts.map(({ text, x, y }) => {
    if (PLACE_NAMES.has(text)) return { text, x, y, kind: 'place' };
    if (names.has(text)) return { text, x, y, kind: 'name' };
    const value = VALUE_PATTERNS.find(([, pattern]) => pattern.test(text));
    if (value) return { text, x, y, kind: `value:${value[0]}` };
    return { text, x, y, kind: 'UNCLASSIFIED' };
  });
}

async function productNames(product) {
  const get = async (url) => {
    const response = await fetch(`${product.base}${url}`);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  };
  const [shop, inventory, gathering] = await Promise.all([get('/api/shop'), get('/api/inventory'), get('/api/gathering')]);
  return new Set([
    ...shop.items.map((item) => item.name),
    ...inventory.items.map((item) => item.name),
    ...gathering.points.map((point) => point.display_name),
    ...product.trainingNames
  ]);
}

// ── 撮る ───────────────────────────────────────────────────────────────────────────────────────────────────
function shooter(options, page, product, steps, record) {
  // still: 移ろいの途中を撮るとき、撮り終えた直後にもまだ成り立っていなければならない式（撮った一コマが途中であることの証）。
  return async function shoot(name, { settle = true, still = null } = {}) {
    if (settle) await page.moveAway();
    const bytes = await page.png({ settle });
    if (still !== null && !(await page.js(still))) throw new Error(`${name}: the frame was not taken while ${still} held`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== VIEWPORT.width || height !== VIEWPORT.height) throw new Error(`${name}.png is ${width}x${height}`);
    if (!settle) {
      // 移ろいの途中の一コマ: 字と部品はこの後すぐ変わるので、残すのは撮り終えた直後に成り立っていた式だけ。
      await fs.writeFile(path.join(options.out, `${name}.png`), bytes, { flag: 'wx' });
      record.shots[name] = { steps: [...steps], heldAfterCapture: still };
      steps.push(`shot ${name}.png`);
      console.log(`shot ${name}.png (in passing; held after capture: ${still})`);
      return;
    }
    const seen = await page.js(VISIBLE_TEXT);
    const counts = await page.js(SHELF_COUNTS);
    const texts = classifyTexts(seen.texts, await productNames(product));
    await fs.writeFile(path.join(options.out, `${name}.png`), bytes, { flag: 'wx' });
    record.shots[name] = { steps: [...steps], screens: seen.screens, texts, names: seen.names, counts };
    steps.push(`shot ${name}.png`);
    const unclassified = texts.filter((entry) => entry.kind === 'UNCLASSIFIED');
    console.log(`shot ${name}.png screens=${seen.screens.join(',')} texts=${texts.length} unclassified=${unclassified.length}`);
    if (unclassified.length > 0) throw new Error(`${name}: texts that are neither a place, a name nor a value: ${JSON.stringify(unclassified)}`);
  };
}

// 左が構成案・右が作った姿の一枚（2880x900）。頁は一時ディレクトリの file に書き、絵は file:// で引く。
async function compose(options, screen, builtName) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shelves-compare-'));
  const win = new BrowserWindow({ width: VIEWPORT.width * 2, height: VIEWPORT.height, useContentSize: true, show: false });
  try {
    const left = path.join(options.plans, `plan-${screen}.png`);
    const right = path.join(options.out, `${builtName}.png`);
    await fs.access(left);
    const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}body{display:flex;width:${VIEWPORT.width * 2}px;height:${VIEWPORT.height}px}img{width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;display:block}</style><img src="file://${left}"><img src="file://${right}">`;
    const page = path.join(dir, 'compare.html');
    await fs.writeFile(page, html, 'utf8');
    await win.loadURL('about:blank');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width * 2, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await win.loadFile(page);
    const loaded = await win.webContents.executeJavaScript('Promise.all([...document.images].map((img) => img.decode().then(() => img.naturalWidth)))');
    if (loaded.some((w) => w !== VIEWPORT.width)) throw new Error(`compare ${screen}: image widths ${JSON.stringify(loaded)}`);
    await cdp.sendCommand('Page.captureScreenshot', { format: 'png' });
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(options.out, `compare-${screen}.png`), Buffer.from(data, 'base64'), { flag: 'wx' });
    console.log(`wrote compare-${screen}.png (left plan-${screen}.png / right ${builtName}.png)`);
  } finally {
    win.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── 製品の通常の道 ─────────────────────────────────────────────────────────────────────────────────────────
const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const IMAGES_LOADED = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector + ' img')})].every((img) => !img.getAttribute('src') || (img.complete && img.naturalWidth > 0))`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "!document.querySelector('#place-veil').hidden";
const screenSettled = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP} && ${motionSettled('#' + id)} && ${IMAGES_LOADED('#' + id)}`;
const HUB_READY = "document.querySelector('#routing-hub-screen.active') && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'";
const SINKING_UNDER_WAY = "document.querySelector('#ap-peek').classList.contains('is-sinking') && !document.querySelector('#shop-screen.active')";
const PEEK_OPEN = "document.querySelector('#ap-peek.is-open') && !document.querySelector('#ap-peek').hidden";
const MAP_READY = `document.querySelector('#academy-map-screen.active') && document.querySelector('#ap').dataset.apReady === 'true' && !${LOADING_ACTIVE} && !${VEIL_UP} && ${motionSettled('#academy-map-screen')}`;
const PINS = "[...document.querySelectorAll('#academy-map-stage-layer > .academy-map-node')].map((pin, index) => ({ index, label: pin.getAttribute('aria-label') }))";

async function walkToHub(page, product, steps) {
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title');
  steps.push('open / (title gate)');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'the footprint hall');
  steps.push('press ロード (footprint hall)');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  steps.push('press the slot light');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled', 30000);
  steps.push('terrace (routing hub)');
  await sleep(SETTLE_MS);
}

async function sayOnHub(page, product, destinationId, steps) {
  const line = product.hubLines[destinationId];
  if (!line) throw new Error(`no hub line for ${destinationId}`);
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
  await sleep(400);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the line sent');
  steps.push(`say on the terrace: ${line}`);
}

async function openPin(page, steps, pattern, key) {
  const nodes = await page.js(PINS);
  const pin = nodes.find((n) => pattern.test(n.label ?? ''));
  if (!pin) throw new Error(`no pin matching ${pattern}: ${JSON.stringify(nodes)}`);
  await page.click(`document.querySelectorAll('#academy-map-stage-layer > .academy-map-node')[${pin.index}]`, `${key} pin`);
  steps.push(`press ${pin.label}`);
  await page.waitFor(PEEK_OPEN, `${key} peek`);
  await sleep(800);
}

const SCENES = {
  async map({ page, product, shoot, steps, record, options }) {
    await walkToHub(page, product, steps);
    await sayOnHub(page, product, 'academy-map', steps);
    await page.waitFor(MAP_READY, 'academy map', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('#academy-map-region-sanrin')", '山林');
    await page.waitFor(`document.documentElement.dataset.apRegion === 'sanrin' && ${motionSettled('#academy-map-screen')}`, 'sanrin map');
    steps.push('press 山林');
    await sleep(SETTLE_MS);
    await openPin(page, steps, /採取/, 'gathering');
    record.entryArt.gathering = await page.js(PEEK_ART);
    await page.click("document.querySelector('#ap-peek [data-ap-action=\"go\"]')", 'ここに行く');
    steps.push('press ここに行く');
    await page.waitFor(`${screenSettled('gathering-screen')} && document.querySelector('#gathering-points .gathering-spot')`, 'gathering settled', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await shoot('gathering-arrival');
    await compose(options, 'gathering', 'gathering-arrival');
    // 手もとを積む: 在庫のある所の籠の紋を、前から二か所押す（押すたびに所は描き直される）。
    for (let i = 0; i < 2; i += 1) {
      const name = await page.js(`[...document.querySelectorAll('#gathering-points .gathering-harvest')][${i}]?.getAttribute('aria-label') ?? null`);
      if (!name) throw new Error(`no harvest sigil #${i + 1}`);
      await page.click(`[...document.querySelectorAll('#gathering-points .gathering-harvest')][${i}]`, name);
      steps.push(`press ${name}`);
      await page.waitFor("document.querySelector('#economy-message-box.visible')", 'collect message');
      await sleep(2200);
    }
    await page.click("document.querySelector('#gathering-back-to-map')", '山林マップに戻る');
    steps.push('press 山林マップに戻る');
    await page.waitFor(MAP_READY, 'back on the map', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('#academy-map-region-academy')", '学院');
    await page.waitFor(`document.documentElement.dataset.apRegion !== 'sanrin' && ${motionSettled('#academy-map-screen')}`, 'academy region');
    steps.push('press 学院');
    await sleep(SETTLE_MS);
    await openPin(page, steps, /購買/, 'shop');
    record.entryArt.shop = await page.js(PEEK_ART);
    await page.click("document.querySelector('#ap-peek [data-ap-action=\"go\"]')", 'ここに行く');
    steps.push('press ここに行く');
    await sleep(SINKING_SHOT_MS);
    if (!(await page.js(SINKING_UNDER_WAY))) throw new Error(`the shop sink is not under way at ${SINKING_SHOT_MS} ms`);
    await shoot('shop-sinking', { settle: false, still: SINKING_UNDER_WAY });
    await page.waitFor(`${screenSettled('shop-screen')} && document.querySelector('#shop-items .shop-ware')`, 'shop settled', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await shoot('shop-arrival');
    await page.click("document.querySelector('#shop-inventory-items .shop-owned-token')", 'the first owned item');
    steps.push('press the first owned item');
    await page.waitFor("document.querySelector('#shop-inventory-items .shop-owned[data-open=\"true\"] .shop-ways')", 'the ways open');
    await sleep(600);
    await shoot('shop-open');
    await compose(options, 'shop', 'shop-open');
  },
  async training({ page, product, shoot, steps, record, options }) {
    await walkToHub(page, product, steps);
    await sayOnHub(page, product, 'training', steps);
    await page.waitFor(screenSettled('academy-training-screen'), 'training settled', LM_WAIT_MS);
    record.entryArt.training = await page.js("new URL(document.querySelector('#academy-training-screen .shelf-ground').src).pathname");
    await sleep(SETTLE_MS);
    await shoot('training-arrival');
    await compose(options, 'training', 'training-arrival');
    const drill = await page.js("document.querySelector('#academy-training-options .academy-training-drill').getAttribute('aria-label')");
    await page.click("document.querySelector('#academy-training-options .academy-training-drill')", drill);
    steps.push(`press ${drill}`);
    await page.waitFor("document.querySelector('#academy-training-day-transition.visible')", 'the day transition');
    await page.waitFor(`!document.querySelector('#academy-training-day-transition.visible') && !document.querySelector('#academy-training-effect-overlay.visible') && ${motionSettled('#academy-training-screen')}`, 'the day passed');
    await sleep(SETTLE_MS);
    await shoot('training-after-action');
  }
};

// 覗きの窓の絵（.ap-popup-art の背景）の path。
const PEEK_ART = `(() => { const bg = getComputedStyle(document.querySelector('#ap-peek .ap-popup-art')).backgroundImage; const m = bg.match(/url\\("?([^")]+)"?\\)/); return m ? new URL(m[1]).pathname : bg; })()`;

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runScene(options, name) {
  const product = await startProduct(options.repoRoot);
  const page = await openPage(() => product.assertNoLmFailure());
  const steps = [];
  const record = { scene: name, shots: {}, entryArt: {} };
  const started = Date.now();
  try {
    let watchdog;
    await Promise.race([
      SCENES[name]({ page, product, shoot: shooter(options, page, product, steps, record), steps, record, options }),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`scene ${name} exceeded ${SCENE_LIMIT_MS / 1000} s`)), SCENE_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    product.assertNoLmFailure();
    record.rendererErrors = page.pageErrors;
    record.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    await fs.writeFile(path.join(options.out, `record-${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    console.log(`scene ${name} done in ${record.seconds} s; renderer errors ${page.pageErrors.length}`);
    if (page.pageErrors.length > 0) throw new Error(`renderer errors: ${JSON.stringify(page.pageErrors)}`);
  } catch (error) {
    console.log(`scene ${name} stopped after: ${steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    throw error;
  } finally {
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
  if (existing.length > 0) throw new Error(`--out ${options.out} is not empty (${existing.length} entries)`);
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const failed = [];
  for (const name of options.scenes) {
    try {
      await runScene(options, name);
    } catch (error) {
      console.log(`SCENE FAILED ${name}: ${error.stack ?? error.message}`);
      failed.push(name);
    }
  }
  if (failed.length > 0) throw new Error(`scenes failed: ${failed.join(',')}`);
}

let exitCode = 0;
app.on('window-all-closed', () => {});
main()
  .catch((error) => {
    console.error('FAILED', error.message);
    exitCode = 1;
  })
  .finally(() => app.exit(exitCode));
