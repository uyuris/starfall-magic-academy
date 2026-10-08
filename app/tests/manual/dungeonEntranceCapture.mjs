// 実践の潜る前の画面を、製品の通常の道（タイトル → ロード → 札 → 露台で「今週はダンジョンに行きたい。」→ 送り出しの幕 → 入る前）で
// 1440x900 に撮り、画面の字と要素の並び・相棒の札の動き・潜るを押したあとの待ちの地の置き方を記録する手回しの道具（*.test.mjs では
// ないので npm test は拾わない）:
//
//   <electron> app/tests/manual/dungeonEntranceCapture.mjs --repo-root <絶対パス> --out <絶対パス> --plan <構成案の png の絶対パス>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・app/public・data・
// content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。
// LM は固定応答（FIXTURE の表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。ロードの前に、一時のセーブへ相棒を一人
// （content/characters の連番で最初の選べる人）と、実践の消耗品を二品（定義を item_id 順に見て属性の違う最初の二品を 2 個と 1 個）
// 持たせる。--plan は構成案の絵で、潜るの紋のあたりの同じ矩形を構成案と作った画面から切り出して並べるのに使う。--out にある file は
// 上書きせずに止まる。
//
// 撮るもの（--out の中）:
//   arrived.png                 入った直後。
//   companion-toggle-film-NN.jpg 相棒の札に指を寄せる → 押す（コマの連なり）。
//   companion-off.png           札を押してひとりにした姿。
//   wait.png                    「潜る」を押したあとの待ち（POST /api/dungeon/enter を Request 段で止めている間）。
//   companion-unavailable.png   止めた入場を落とし、潜るのに失敗した後の入る前（同行できない姿）。製品のサーバは LM の設定を一度読むと
//                               持ち続けるので、失敗の後の読み直しの GET /api/dungeon/availability だけを CDP Fetch で止め、製品の
//                               evaluateDungeonLlmAvailability が設定の無いときに返す本文（LM 未設定）で答える。
//   stairs-sigil-pair.png       潜るの紋のあたり（SIGIL_RECT）を、左 = 構成案・右 = arrived.png で等倍に並べた一枚。
//   record.json                 通った道・撮った枚ごとの見えている字と読み上げの名・字の分類・要素の矩形・待ちの地の計算値・秒数。
import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const SCENE_LIMIT_MS = 300000;
// 札の動きのコマ: JPEG を FILM_FRAME_MS ごとに。押下はコマの合間に順に送る（撮影と重ねると取りこぼされる）。
const FILM_FRAME_MS = 70;
const FILM_JPEG_QUALITY = 85;
// 潜るの紋のあたりの矩形（1440x900 の窓の座標）: アーチの奥の段と紋。
const SIGIL_RECT = { x: 541, y: 338, width: 360, height: 260 };
const PAIR_GAP = 16;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--plan'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) {
    if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
    if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], plan: parsed['--plan'] };
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
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false']
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

// 実践の支度（一時のセーブの slot だけに書く）: 相棒を一人と、属性の違う消耗品を二品。
async function prepareKit(repoRoot, slotRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { setRelationshipDebugState } = await product('relationshipState.mjs');
  const { loadDungeonConsumableDefinitions } = await product('dungeon/combatConsumables.mjs');
  const { isSelectableCharacterId } = await product('characterCatalog.mjs');
  const { createStorageApi } = await product('storage.mjs');
  const ids = (await fs.readdir(path.join(repoRoot, 'content/characters'))).filter((name) => /^character_\d+$/.test(name)).sort();
  const buddy = ids.find((id) => isSelectableCharacterId(id));
  if (!buddy) throw new Error('no selectable character in content/characters');
  await setRelationshipDebugState({ root: slotRoot, buddyCharacterId: buddy });
  const definitions = [...(await loadDungeonConsumableDefinitions(slotRoot))].sort((a, b) => a.item_id.localeCompare(b.item_id));
  const picked = [];
  for (const definition of definitions) {
    if (picked.some((other) => (other.element ?? null) === (definition.element ?? null))) continue;
    picked.push(definition);
    if (picked.length === 2) break;
  }
  if (picked.length !== 2) throw new Error(`expected two dungeon consumables of different elements, got ${picked.length}`);
  const storage = createStorageApi({ root: slotRoot });
  const inventory = (await storage.readJsonIfExists('game_data/player_inventory.json')) ?? { items: [] };
  if (!Array.isArray(inventory.items)) throw new Error('player_inventory.json items is not an array');
  inventory.items.push({ item_id: picked[0].item_id, quantity: 2 }, { item_id: picked[1].item_id, quantity: 1 });
  await storage.writeJson('game_data/player_inventory.json', inventory);
  return { buddy, consumables: picked.map((item) => item.item_id) };
}

async function startProduct(repoRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dungeon-entrance-capture-'));
  const closers = [];
  const lmFailures = [];
  const lmLog = [];
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
    const kit = await prepareKit(repoRoot, slotRoot);
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
      lmLog.push(reply.kind);
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
      kit,
      lmFailures,
      lmLog,
      // LM の設定が無いときに製品が返す、実践の同行の可否。
      unconfiguredAvailability: (await product('dungeon/dungeonAvailability.mjs')).evaluateDungeonLlmAvailability({ lmStudioConfigured: false, busy: false }),
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
  const paused = [];
  cdp.on('message', (event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    paused.push({ requestId: params.requestId, url: params.request.url, method: params.request.method });
    console.log(`held ${params.request.method} ${new URL(params.request.url).pathname}`);
  });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const pointerAt = async (selectorExpr, label) => {
    const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
    return box;
  };
  const page = {
    js,
    send,
    paused,
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
      throw new Error(`timed out waiting for ${label} (page: ${JSON.stringify(await js(STOPPED_AT).catch(() => null))})`);
    },
    async hover(selectorExpr, label) {
      const box = await pointerAt(selectorExpr, label);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      return box;
    },
    async press(selectorExpr, label) {
      const box = await pointerAt(selectorExpr, label);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      return box;
    },
    async release(selectorExpr, label) {
      const box = await pointerAt(selectorExpr, label);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      return box;
    },
    async click(selectorExpr, label) {
      await page.hover(selectorExpr, label);
      await page.press(selectorExpr, label);
      await page.release(selectorExpr, label);
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) {
        await send('Input.insertText', { text: character });
        await sleep(20);
      }
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    // 隠れた窓は直前の合成のコマを返すことがある: 2 フレーム待ち・invalidate・捨て撮りを挟む。
    async png() {
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      win.webContents.invalidate();
      await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await sleep(400);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    async jpeg() {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: FILM_JPEG_QUALITY, captureBeyondViewport: false });
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
  journey: document.querySelector('#journey')?.dataset.scene ?? null,
  dungeonScene: document.querySelector('#academy-dungeon-screen')?.dataset.scene ?? null,
  veil: document.querySelector('#place-veil')?.hidden ? null : document.querySelector('#place-veil')?.dataset.veil ?? null
})`;

// 見えている字（実効の不透明度 0.05 超・窓の内側・上に別の要素が重なっていない）と、見えている要素の読み上げの名と、字を持つ釦。
const VISIBLE_TEXT = `(() => {
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none') return 0; o *= parseFloat(cs.opacity); } return o; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.color !== 'rgba(0, 0, 0, 0)' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && opacityOf(el) > 0.05 && !el.closest('[hidden]'); };
  const onTop = (el) => { const r = el.getBoundingClientRect(); const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)); const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)); const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit) || hit.contains(el)); };
  const where = (el) => { const owner = el.closest('[id]'); const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.'); return (owner ? '#' + owner.id + ' ' : '') + el.tagName.toLowerCase() + (cls ? '.' + cls : ''); };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || !el || el.closest('script, style, template, svg title')) continue;
    if (!visible(el) || !onTop(el)) continue;
    const r = el.getBoundingClientRect();
    texts.push({ text, where: where(el), box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] });
  }
  const attrs = [];
  for (const el of document.querySelectorAll('[aria-label], [title], img[alt]')) {
    if (!visible(el) || !onTop(el)) continue;
    for (const name of ['aria-label', 'title', 'alt']) {
      const value = el.getAttribute(name);
      if (value && value.trim()) attrs.push({ attr: name, value: value.trim(), where: where(el) });
    }
  }
  const textButtons = [...document.querySelectorAll('button, [role=button], a[href]')].filter((el) => visible(el) && onTop(el) && el.textContent.replace(/\\s+/g, '').length > 0 && !el.querySelector('.dn-kit-count')).map((el) => ({ text: el.textContent.trim(), where: where(el) }));
  return { screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id), texts, attrs, textButtons };
})()`;

// 入る前の画面の要素: 個数・矩形（窓の座標）・状態。並びと隣り合う向きは、この矩形から node の側で求める。
const ENTRY_LAYOUT = `(() => {
  const box = (el) => { if (!el || el.closest('[hidden]')) return null; const r = el.getBoundingClientRect(); if (r.width === 0) return null; return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; };
  const root = document.querySelector('#academy-dungeon-screen');
  return {
    scene: root.dataset.scene,
    place: { text: document.querySelector('.dn-entry-place').textContent, box: box(document.querySelector('.dn-entry-place')) },
    back: { shown: !document.querySelector('#dungeon-back-to-map').hidden, label: document.querySelector('#dungeon-back-to-map').getAttribute('aria-label'), box: box(document.querySelector('#dungeon-back-to-map')) },
    dive: { label: document.querySelector('#dungeon-dive').getAttribute('aria-label'), disabled: document.querySelector('#dungeon-dive').disabled, box: box(document.querySelector('#dungeon-dive')) },
    hero: { token: box(document.querySelector('.dn-entry-token--hero')), name: box(document.querySelector('.dn-entry-member--hero .dn-entry-name')) },
    ally: {
      shown: !document.querySelector('#dungeon-entry-companion').hidden,
      pressed: document.querySelector('#dungeon-entry-companion-toggle').getAttribute('aria-pressed'),
      label: document.querySelector('#dungeon-entry-companion-toggle').getAttribute('aria-label'),
      name: document.querySelector('#dungeon-entry-companion-name').textContent,
      faceFilter: getComputedStyle(document.querySelector('#dungeon-entry-face')).filter,
      token: box(document.querySelector('#dungeon-entry-companion-toggle')),
      nameBox: box(document.querySelector('#dungeon-entry-companion-name')),
      tether: box(document.querySelector('#dungeon-entry-tether'))
    },
    apart: { shown: !document.querySelector('#dungeon-entry-apart').hidden, label: document.querySelector('#dungeon-entry-apart-mark').getAttribute('aria-label'), box: box(document.querySelector('#dungeon-entry-apart-mark')) },
    kit: [...document.querySelectorAll('#dungeon-entry-kit .dn-kit')].map((item) => {
      const plate = item.querySelector('.dn-kit-plate');
      return { kind: item.classList.contains('dn-kit--gear') ? 'gear' : 'carry', empty: item.classList.contains('is-empty'), opens: plate.tagName === 'BUTTON', label: plate.getAttribute('aria-label'), name: item.querySelector('.dn-kit-name')?.textContent ?? null, count: item.querySelector('.dn-kit-count')?.textContent ?? null, plate: box(plate), nameBox: box(item.querySelector('.dn-kit-name')) };
    })
  };
})()`;

// 地の計算値: 待ちの層の地（.place-veil-art）と、この画面の地（.dn-entry-ground）。
const GROUNDS = `(() => {
  const read = (selector) => { const el = document.querySelector(selector); const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { selector, display: cs.display, backgroundImage: cs.backgroundImage, backgroundSize: cs.backgroundSize, backgroundPosition: cs.backgroundPosition, backgroundAttachment: cs.backgroundAttachment, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }; };
  const veil = document.querySelector('#place-veil');
  return { veil: { step: veil.hidden ? null : veil.dataset.veil, ground: veil.dataset.veilGround ?? null }, veilArt: read('#place-veil .place-veil-art'), screenGround: read('#academy-dungeon-screen .dn-entry-ground') };
})()`;

// ── 製品の通常の道 ─────────────────────────────────────────────────────────────────────────────────────────
const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const IMAGES_LOADED = (selector) => `[...document.querySelectorAll(${JSON.stringify(`${selector} img`)})].every((img) => !img.getAttribute('src') || img.complete)`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const ENTRY_READY = `document.querySelector('#academy-dungeon-screen.active') && document.querySelector('#academy-dungeon-screen').dataset.scene === 'entry' && !document.querySelector('#dungeon-dive').disabled && !${VEIL_UP} && document.querySelector('#terrace-opened').hidden && !${LOADING_ACTIVE} && ${motionSettled('#academy-dungeon-screen')} && ${IMAGES_LOADED('#academy-dungeon-screen')}`;

async function walkToEntry(ctx) {
  const { page, product, steps } = ctx;
  steps.push(`kit in the save: buddy ${product.kit.buddy}, consumables ${product.kit.consumables.join(' ')}`);
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled', 30000);
  await sleep(SETTLE_MS);
  steps.push('title → ロード → slot → terrace');
  const line = product.hubLines.dungeon;
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  steps.push(`say on the terrace: ${line}`);
  await page.waitFor("!document.querySelector('#terrace-opened').hidden", 'the send-off curtain', LM_WAIT_MS);
  steps.push('send-off curtain up');
  await page.waitFor(`${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'waiting'`, 'the entering wait', LM_WAIT_MS);
  ctx.record.sendoffWait = await page.js(GROUNDS);
  steps.push(`entering wait over the curtain (ground ${ctx.record.sendoffWait.veil.ground})`);
  await page.waitFor(ENTRY_READY, 'the dungeon entry', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  steps.push('dungeon entry');
}

// ── 撮る ───────────────────────────────────────────────────────────────────────────────────────────────────
async function writeNew(file, bytes) {
  await fs.writeFile(file, bytes, { flag: 'wx' });
}

function createShooter(ctx) {
  return async function shoot(file) {
    await ctx.page.moveAway();
    await sleep(500);
    const bytes = await ctx.page.png();
    if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${file} is not ${VIEWPORT.width}x${VIEWPORT.height}`);
    const text = await ctx.page.js(VISIBLE_TEXT);
    const layout = await ctx.page.js(ENTRY_LAYOUT);
    await writeNew(path.join(ctx.options.out, file), bytes);
    ctx.record.shots[file] = { steps: [...ctx.steps], screens: text.screens, visibleTexts: text.texts, visibleAttrs: text.attrs, textButtons: text.textButtons, layout };
    ctx.steps.push(`shot ${file}`);
    console.log(`shot ${file} screens=${text.screens.join(',')} texts=${text.texts.map((entry) => entry.text).join(' / ')}`);
    return bytes;
  };
}

// 字の分類: 場所の名・人の名・品の名・個数。どれにも当たらない字は other に入れる（0 であるべき）。
async function classifyTexts(ctx, file) {
  const shot = ctx.record.shots[file];
  const equipment = await ctx.page.js("fetch('/api/equipment').then((r) => r.json())");
  const entry = await ctx.page.js("fetch('/api/dungeon/entry-consumables').then((r) => r.json())");
  const companionName = shot.layout.ally.name;
  const places = new Set(['実践']);
  const persons = new Set(['主人公', ...(companionName ? [companionName] : [])]);
  const items = new Set([equipment.slots?.weapon?.instance?.name, equipment.slots?.amulet?.instance?.name, ...entry.consumables.map((row) => row.name)].filter(Boolean));
  const rows = shot.visibleTexts.map((row) => {
    let kind = 'other';
    if (places.has(row.text)) kind = 'place';
    else if (persons.has(row.text)) kind = 'person';
    else if (items.has(row.text)) kind = 'item';
    else if (/^×\d+$/.test(row.text)) kind = 'count';
    return { ...row, kind };
  });
  shot.classified = rows;
  shot.otherTexts = rows.filter((row) => row.kind === 'other').length;
  console.log(`texts ${file}: ${rows.map((row) => `${row.text}[${row.kind}]`).join(' / ')}; other ${shot.otherTexts}; text buttons ${shot.textButtons.length}`);
}

// 相棒の札の動き: 指を寄せる → 浮く → 押す → 輪がほどけて顔が灰に沈む、をコマに。押下はコマの合間に順に送る。
async function filmCompanionToggle(ctx) {
  const { page } = ctx;
  const toggle = "document.querySelector('#dungeon-entry-companion-toggle')";
  const plan = [
    { at: 0, act: null },
    { at: 3, act: () => page.hover(toggle, '相棒の札'), note: 'pointer onto the card' },
    { at: 11, act: () => page.press(toggle, '相棒の札'), note: 'press' },
    { at: 12, act: () => page.release(toggle, '相棒の札'), note: 'release' },
    { at: 14, act: () => page.moveAway(), note: 'pointer away' },
    { at: 24, act: null, note: 'end' }
  ];
  const frames = [];
  const started = Date.now();
  for (let index = 0; index <= plan.at(-1).at; index += 1) {
    const step = plan.find((entry) => entry.at === index);
    if (step?.act) await step.act();
    const due = started + index * FILM_FRAME_MS;
    if (Date.now() < due) await sleep(due - Date.now());
    const state = await page.js("(() => { const t = document.querySelector('#dungeon-entry-companion-toggle'); const ring = document.querySelector('#dungeon-entry-tether .dm-tether-ring--left'); return { pressed: t.getAttribute('aria-pressed'), transform: getComputedStyle(t).transform, faceFilter: getComputedStyle(document.querySelector('#dungeon-entry-face')).filter, ringTransform: getComputedStyle(ring).transform }; })()");
    const file = `companion-toggle-film-${String(index).padStart(2, '0')}.jpg`;
    await writeNew(path.join(ctx.options.out, file), await page.jpeg());
    frames.push({ file, ms: Date.now() - started, event: step?.note ?? null, ...state });
  }
  ctx.record.film = frames;
  for (const frame of frames) console.log(`film ${frame.file} ${frame.ms}ms ${frame.event ?? ''} pressed=${frame.pressed} card=${frame.transform} face=${frame.faceFilter} ring=${frame.ringTransform}`);
  if (frames.at(-1).pressed !== 'false') throw new Error('the press on the companion card was not taken');
  ctx.steps.push('film the companion card: hover → press (solo)');
}

// 潜るの紋のあたりを、構成案と作った画面から同じ矩形で切り出して左右に並べる（等倍）。
async function sigilPair(ctx, arrivedBytes) {
  const plan = nativeImage.createFromPath(ctx.options.plan);
  const size = plan.getSize();
  if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) throw new Error(`--plan is ${size.width}x${size.height}`);
  const left = plan.crop(SIGIL_RECT).toDataURL();
  const right = nativeImage.createFromBuffer(arrivedBytes).crop(SIGIL_RECT).toDataURL();
  const dataUrl = await ctx.page.js(`(async () => {
    const load = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
    const [a, b] = await Promise.all([load(${JSON.stringify(left)}), load(${JSON.stringify(right)})]);
    const canvas = document.createElement('canvas');
    canvas.width = ${SIGIL_RECT.width * 2 + PAIR_GAP};
    canvas.height = ${SIGIL_RECT.height};
    const g = canvas.getContext('2d');
    g.fillStyle = 'rgb(5, 6, 15)';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(a, 0, 0);
    g.drawImage(b, ${SIGIL_RECT.width + PAIR_GAP}, 0);
    return canvas.toDataURL('image/png');
  })()`);
  await writeNew(path.join(ctx.options.out, 'stairs-sigil-pair.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  ctx.record.sigilRect = SIGIL_RECT;
  ctx.steps.push(`stairs-sigil-pair.png (left plan, right arrived; rect ${JSON.stringify(SIGIL_RECT)})`);
}

async function scene(ctx) {
  const { page, product } = ctx;
  await walkToEntry(ctx);
  const arrived = await ctx.shoot('arrived.png');
  await classifyTexts(ctx, 'arrived.png');
  await sigilPair(ctx, arrived);

  await filmCompanionToggle(ctx);
  await ctx.shoot('companion-off.png');
  await classifyTexts(ctx, 'companion-off.png');

  // 入るときの待ち: POST /api/dungeon/enter を Request 段で止めたまま「潜る」を押す。
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/dungeon/enter', requestStage: 'Request' }] });
  await page.click("document.querySelector('#dungeon-dive')", '潜る');
  ctx.steps.push('press 潜る (POST /api/dungeon/enter held at the Request stage)');
  await page.waitFor(`${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'waiting'`, 'the dive wait');
  const heldEnd = Date.now() + 10000;
  while (!page.paused.some((entry) => entry.url.endsWith('/api/dungeon/enter'))) {
    if (Date.now() > heldEnd) throw new Error('POST /api/dungeon/enter was not held');
    await sleep(40);
  }
  await sleep(SETTLE_MS);
  ctx.record.diveWait = await page.js(GROUNDS);
  await ctx.shoot('wait.png');
  const { veilArt, screenGround } = ctx.record.diveWait;
  for (const key of ['backgroundImage', 'backgroundSize', 'backgroundPosition']) {
    console.log(`ground ${key}: veil ${veilArt[key]} | screen ${screenGround[key]}`);
    if (veilArt[key] !== screenGround[key]) throw new Error(`the wait ground ${key} differs from the screen ground`);
  }

  // 同行できないとき: 止めた入場を落とす → 製品は待ちを夜へ沈めて入る前へ戻し、入る前を読み直す。その読み直しの同行の可否には、
  // LM の設定が無いときの製品の答えを返す。
  const errorsBeforeFailure = page.pageErrors.length;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/dungeon/enter', requestStage: 'Request' }, { urlPattern: '*/api/dungeon/availability', requestStage: 'Request' }] });
  const held = page.paused.find((entry) => entry.url.endsWith('/api/dungeon/enter'));
  await page.send('Fetch.failRequest', { requestId: held.requestId, errorReason: 'ConnectionRefused' });
  ctx.steps.push('fail the held POST /api/dungeon/enter (ConnectionRefused)');
  const askedEnd = Date.now() + 30000;
  let asked;
  while (!(asked = page.paused.find((entry) => entry.url.endsWith('/api/dungeon/availability')))) {
    if (Date.now() > askedEnd) throw new Error('the entry did not ask GET /api/dungeon/availability after the failed dive');
    await sleep(40);
  }
  const body = JSON.stringify(product.unconfiguredAvailability);
  await page.send('Fetch.fulfillRequest', { requestId: asked.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(body).toString('base64') });
  await page.send('Fetch.disable');
  ctx.record.unavailableAnswer = product.unconfiguredAvailability;
  ctx.steps.push(`answer GET /api/dungeon/availability with ${body}`);
  await page.waitFor(`${ENTRY_READY} && !document.querySelector('#dungeon-entry-apart').hidden`, 'the entry after the failed dive', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await ctx.shoot('companion-unavailable.png');
  await classifyTexts(ctx, 'companion-unavailable.png');
  ctx.record.errorsBeforeFailure = page.pageErrors.slice(0, errorsBeforeFailure);
  ctx.record.errorsAfterFailure = page.pageErrors.slice(errorsBeforeFailure);
  if (errorsBeforeFailure > 0) throw new Error(`renderer errors before the deliberate failure: ${JSON.stringify(ctx.record.errorsBeforeFailure)}`);
}

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const product = await startProduct(options.repoRoot);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], record: { viewport: VIEWPORT, shots: {} } };
  ctx.shoot = createShooter(ctx);
  const started = Date.now();
  let watchdog;
  try {
    await Promise.race([
      scene(ctx),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`scene exceeded ${SCENE_LIMIT_MS / 1000} s`)), SCENE_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    guard();
    ctx.record.steps = ctx.steps;
    ctx.record.lmRequests = product.lmLog;
    ctx.record.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    await writeNew(path.join(options.out, 'record.json'), `${JSON.stringify(ctx.record, null, 2)}\n`);
    console.log(`scene done in ${ctx.record.seconds} s`);
  } catch (error) {
    console.log(`scene stopped after: ${ctx.steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    throw error;
  } finally {
    page.close();
    await product.stop();
  }
}

app.on('window-all-closed', () => {});
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('FAILED', error.stack ?? error.message);
    app.exit(1);
  });
