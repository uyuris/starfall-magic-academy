// 札の部屋（依頼の札・研究会の札）を製品の通常の道で 1440x900 に撮る手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/roomCardsCapture.mjs --repo-root <絶対パス> --plan-dir <絶対パス> --out-dir <絶対パス>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--out-dir は無いか空であること（書く file は
// どれも上書きせずに止まる）。--plan-dir は構成案の plan-*.png の置き場（読むだけ）。
//
// 1. 画面ごとに、<repo-root> の製品を一時のセーブ（OS の一時ディレクトリに作った新しいプレイ・routing・案内人 fallen_star）・
//    固定応答の LM（下の表の閉じた集合）で、この process の中に起こす。知らない LM の要求は 500 になり、撮影ごと止める。
// 2. Electron の隠れた窓（1440x900・DPR 1）で、タイトル →「ロード」→ 足あとの広間 → 露台で一言、の製品の道で札の部屋へ入る。
//    依頼の札では、最初の札の要求（GET /api/errand）を CDP Fetch で落として失敗の報せともう一度の紋を撮り、もう一度を押して入り
//    直す。札が並んだ姿を撮り、最初の札を押し、相手が光の中から現れきった瞬間（札が残っている間）を撮る。この一枚は、相手の
//    現れる動きが終わる直前に頁の動きをすべて止めて撮り、撮ったら動きを戻す（止めている間は札が退かない）。最初の言葉が出揃い札が
//    退いた姿を撮る。
// 3. 各枚で見えている字を全数集め、札の値・週と場所の名・会話の言葉と名のどれかに当たるかを照合する（当たらない字が説明の文の
//    候補）。札の位置は札の部屋と会話の画面の両方で測る。
// 4. 構成案と作った姿を並べた compare-*.png（左が構成案）と、載せ直した手がかりの切り抜き clue-*.png を Pillow で書く。
// 記録は <out-dir>/<画面>.json、run の秒数は標準出力。
import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';
const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 900;
const WATCHDOG_MS = 900000;
// 露台で言う一言と、固定応答の LM がこの一言から返す行き先。
const SCREENS = [
  { name: 'errand', destination: 'errand', place: '依頼の現場', hubLine: '今週は依頼を引き受けに行きたい。', screen: '#academy-errand-screen', offers: '#academy-errand-offers', api: '/api/errand', failFirstOffers: true },
  { name: 'study-circle', destination: 'study_circle', place: '研究会', hubLine: '今週は研究会に行きたい。', screen: '#academy-study-circle-screen', offers: '#academy-study-circle-offers', api: '/api/study-circle', failFirstOffers: false }
];
// 左が構成案・右が作った姿（構成案に無い場面は、いまの会話の姿と並べる: 札が退いたあとは、いまの会話と同じ姿になる）。
const COMPARES = [
  ['plan', 'plan-errand.png', 'built-errand.png', 'compare-errand.png'],
  ['plan', 'plan-study-circle.png', 'built-study-circle.png', 'compare-study-circle.png'],
  ['plan', 'plan-room-cards-chosen.png', 'built-errand-chosen.png', 'compare-errand-chosen.png'],
  ['plan', 'plan-room-cards-chosen.png', 'built-study-circle-chosen.png', 'compare-study-circle-chosen.png'],
  ['plan', 'now-errand-chosen.png', 'built-errand-settled.png', 'compare-errand-settled.png'],
  ['plan', 'now-study-circle-chosen.png', 'built-study-circle-settled.png', 'compare-study-circle-settled.png']
];

function parseArgs(argv) {
  const keys = ['--repo-root', '--plan-dir', '--out-dir'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    if (!keys.includes(argv[i])) throw new Error(`unexpected argument: ${argv[i]} (known: ${keys.join(' ')})`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    parsed[argv[i]] = path.resolve(argv[i + 1]);
    i += 1;
  }
  for (const key of keys) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

// 終わるときは、まだ開いている接続（閉じた窓の要求が残した socket など）を待たずに切ってから閉じる。
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

// ── 固定応答の LM ─────────────────────────────────────────────────────────────────────────────────────────────
// 言葉は撮影のための仮の文（製品の本文ではない）。表情の選択には joy を返し、会話の一行は最後に選ばれた表情（選ばれる前は
// neutral）の行を返す。
const FIXTURE_EXPRESSION = 'joy';
const FIXTURE_CHAT_LINES = new Map([
  ['neutral', '（顔を上げて）あ、こんにちは。ちょうど一息つこうと思っていたところです。'],
  ['joy', '（ぱっと笑って）それ、すごくいいですね。聞いているだけで楽しくなります。']
]);
const FIXTURE_REFLECTION_LINE = '学院で主人公と少し話した。';
// 依頼・研究会の週の札の文面（構造化の骨子と当人の語り）。製品の札の関所（括弧・引用符・改行・情景でない語・達成条件と報酬の語を
// 拒む）を通る文にしてある。
const FIXTURE_OFFER_RECORDS = {
  errand_offer_record: {
    title: '書架の並べ替えの手伝い',
    situation: '書庫の長机に、背表紙の色ごとに分けた本が高く積まれている。',
    motivation: '書架の並べ替えを今週中に終えたいが、一人では手が足りない。'
  },
  study_circle_offer_record: {
    title: '星図の読み合わせ',
    situation: '窓辺の机に、古い星図と真鍮の天球儀が広げて置かれている。',
    motivation: '星図の読み方を、話しながら確かめ合いたい。'
  }
};
const FIXTURE_OFFER_APPEALS = [
  ['この依頼はすでに内容が確定している', 'ねえ、少しだけいいかな。書架の並べ替えを今週中に終えたいのだけど、一人では手が足りなくて困っているんだ。あなたなら落ち着いて付き合ってくれそうだから、声をかけたの。'],
  ['この研究会はすでに内容が確定している', 'よかったら、星図の読み合わせに来てみない？　古い星図を広げて、話しながら一緒に読み方を確かめたいんだ。あなたが来てくれたら、きっと楽しくなると思う。']
];
// 露台の会話の締めの判定。
const FIXTURE_PROMPT_ANSWERS = [
  ['継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['増減したユーザーの所持金を判定する', '0']
];
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

// ハブの行き先は、主人公の言葉が SCREENS の hubLine のどれを含むかで決まる（どれも含まなければ失敗）。
function createFixtureLm() {
  const mood = { expression: 'neutral' };
  return function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') {
      mood.expression = FIXTURE_EXPRESSION;
      return { kind: `${schemaName} ${mood.expression}`, content: JSON.stringify({ expression: mood.expression }) };
    }
    if (Object.hasOwn(FIXTURE_OFFER_RECORDS, schemaName)) return { kind: schemaName, content: JSON.stringify(FIXTURE_OFFER_RECORDS[schemaName]) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = SCREENS.filter((screen) => prompt.includes(screen.hubLine));
      if (matches.length !== 1) throw new Error(`fixture lm: the hub conversation must hold exactly one of the hub lines, found ${matches.length}`);
      return { kind: `hub-destination ${matches[0].destination}`, content: matches[0].destination };
    }
    for (const [marker, appeal] of FIXTURE_OFFER_APPEALS) {
      if (prompt.includes(marker)) return { kind: `offer-appeal ${marker}`, content: appeal };
    }
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) {
      if (prompt.includes(marker)) return { kind: marker, content };
    }
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: `chat-line ${mood.expression}`, content: FIXTURE_CHAT_LINES.get(mood.expression) };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: FIXTURE_REFLECTION_LINE };
    throw new Error(`fixture lm: unknown request (model ${body.model}, stream ${body.stream === true}): ${prompt.slice(-160)}`);
  };
}

// 画面ごとに一つ: 一時のセーブ・固定応答の LM・製品サーバーを、この process の中に起こす。
async function startProduct(repoRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'room-cards-capture-'));
  const closers = [];
  const failures = [];
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
    const play = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    const answer = createFixtureLm();
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = answer(body);
      } catch (error) {
        failures.push(error.message);
        console.error(`fixture-lm 500: ${error.message}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message) }));
        return;
      }
      console.log(`fixture-lm ${reply.kind}${body.stream ? ' (stream)' : ''}`);
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
    console.log(`product slot ${play.slot.slot_id} isolated root: <os-temp>`);
    return {
      url: `http://${HOST}:${port}/`,
      async stop() {
        for (const close of closers.reverse()) await close();
        await fs.rm(root, { recursive: true, force: true });
      },
      assertNoLmFailure() { if (failures.length) throw new Error(`fixture LM answered 500: ${failures.join(' | ')}`); }
    };
  } catch (error) {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

const HUB_READY = "document.querySelector('#routing-hub-screen.active') && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'";
const PARTNER_ROWS = "document.querySelectorAll('#conversation-day-message-stream .chat-message.character-message')";
const CONVERSATION_IDLE = "!document.querySelector('#conversation-day-send').disabled && !document.querySelector('#conversation-day-screen').classList.contains('is-day-responding') && [...document.querySelectorAll('#conversation-day-message-stream .chat-message')].every((row) => row.getAnimations().every((a) => a.playState !== 'running'))";

// 見えている字（表示・不透明度・矩形で判定）と、その字が何の字か。札の値（offers の字）・週と場所の名・会話の言葉と名（会話の画面の
// 言葉の欄と相手の名）のどれかに当たらない字は「照合なし」として出す（使い方の説明の文が混ざれば、ここに出る）。
const VISIBLE_TEXTS = (knownRaw) => `(() => {
  const known = Object.fromEntries(Object.entries(${JSON.stringify(knownRaw)}).map(([text, source]) => [text.replace(/\\s+/g, ' ').trim(), source]));
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    const parent = node.parentElement;
    const rect = parent.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
    let visible = true;
    let opacity = 1;
    for (let el = parent; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') { visible = false; break; }
      opacity *= Number(style.opacity);
    }
    if (!visible || opacity < 0.05) continue;
    let source = known[text] ?? null;
    if (!source && parent.closest('#conversation-day-message-stream .message-bubble')) source = 'conversation words';
    if (!source && parent.closest('#cl-face .cl-face-name')) source = 'partner name';
    if (!source && parent.closest('#cl-stage-name')) source = 'place name (conversation)';
    if (!source && parent.closest('#conversation-day-week')) source = 'week (conversation)';
    if (!source && parent.closest('.routing-failure-destination')) source = 'failure notice: destination name';
    out.push({ text, source: source ?? 'UNMATCHED', element: parent.tagName.toLowerCase() + (parent.id ? '#' + parent.id : '') + (typeof parent.className === 'string' && parent.className ? '.' + parent.className.trim().split(/\\s+/).join('.') : ''), opacity: Math.round(opacity * 100) / 100, box: [rect.left, rect.top, rect.right, rect.bottom].map(Math.round) });
  }
  return out;
})()`;

const BOXES = (offersSelector, screenSelector) => `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
  const offers = document.querySelector('${offersSelector}');
  const cards = [...offers.querySelectorAll('.room-card')];
  return {
    parent: offers.parentElement.id,
    step: offers.dataset.step ?? null,
    cards: cards.map((card) => ({ chosen: card.hasAttribute('data-chosen'), box: box(card), visibility: getComputedStyle(card).visibility, opacity: Number(getComputedStyle(card).opacity) })),
    parts: cards.map((card) => ({
      face: box(card.querySelector('.room-card-face')), name: box(card.querySelector('.room-card-name')), title: box(card.querySelector('.room-card-title')),
      venue: box(card.querySelector('.room-card-venue')), appeal: box(card.querySelector('.room-card-appeal')), worth: box(card.querySelector('.room-card-worth'))
    })),
    roomTopbar: box(document.querySelector('${screenSelector} .room-cards-topbar')),
    roomWeek: box(document.querySelector('${screenSelector} .conversation-day-week')),
    roomPlace: box(document.querySelector('${screenSelector} .room-cards-place')),
    conversationWeek: box(document.querySelector('#conversation-day-week')),
    conversationPlace: box(document.querySelector('#cl-stage-name')),
    face: box(document.querySelector('#cl-face')),
    ground: getComputedStyle(document.querySelector('${screenSelector}')).getPropertyValue('--room-cards-art').trim(),
    conversationArt: getComputedStyle(document.querySelector('#conversation-day-screen')).getPropertyValue('--cl-stage-art').trim(),
    light: getComputedStyle(document.querySelector('${screenSelector}')).getPropertyValue('--cl-light-rgb').trim()
  };
})()`;

async function shootScreen({ target, url, outDir }) {
  const win = new BrowserWindow({ show: false, width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const contents = win.webContents;
  contents.setAudioMuted(true);
  const rendererErrors = [];
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) { rendererErrors.push(message); console.log(`renderer-error: ${message}`); }
  });
  await win.loadURL('about:blank');
  contents.debugger.attach('1.3');
  const send = (method, params = {}) => contents.debugger.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = (expression) => contents.executeJavaScript(expression);
  const expectedErrors = [];
  const waitFor = async (predicate, label, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const unexpected = rendererErrors.filter((message) => !expectedErrors.some((pattern) => pattern.test(message)));
      if (unexpected.length) throw new Error(`renderer errors while waiting for ${label}: ${JSON.stringify(unexpected)}`);
      if (await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`)) return;
      await sleep(40);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const click = async (selectorExpr, label) => {
    const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  const moveAway = () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: VIEWPORT.width / 2, y: 4 });
  // 隠れた窓は直前の合成のコマを返すことがある: 2 フレーム待ち・invalidate・捨て撮りを挟む。
  const shot = async (name) => {
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    contents.invalidate();
    await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await sleep(400);
    const bytes = Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
    const size = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (size.join('x') !== `${VIEWPORT.width}x${VIEWPORT.height}`) throw new Error(`${name} is ${size.join('x')}`);
    writeFileSync(path.join(outDir, name), bytes, { flag: 'wx' });
    console.log(`shoot: ${name} ${size.join('x')}`);
  };
  const record = { screen: target.name, steps: [] };
  const step = (line) => { record.steps.push(line); console.log(`step: ${line}`); };

  await win.loadURL(url);
  const viewport = await js('[innerWidth, innerHeight, devicePixelRatio]');
  if (viewport.join('x') !== `${VIEWPORT.width}x${VIEWPORT.height}x1`) throw new Error(`viewport is ${viewport.join('x')}, not 1440x900 at DPR 1`);
  if (target.failFirstOffers) {
    // 最初の札の要求だけを落とす（server には届かない）。二度目からは通す。
    await send('Fetch.enable', { patterns: [{ urlPattern: `*${target.api}`, requestStage: 'Request' }] });
    let failed = false;
    contents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const isOffers = new URL(params.request.url).pathname === target.api && params.request.method === 'GET';
      if (isOffers && !failed) {
        failed = true;
        send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' }).catch((error) => console.error(error));
        return;
      }
      send('Fetch.continueRequest', { requestId: params.requestId }).catch((error) => console.error(error));
    });
    expectedErrors.push(/Failed to load resource: net::ERR_CONNECTION_REFUSED/, /Failed to fetch/);
  }
  await waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title');
  step('open / (title gate)');
  await sleep(1500);
  await click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'the footprint hall');
  step('press ロード (footprint hall)');
  await sleep(1800);
  await click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await waitFor(HUB_READY, 'the terrace', 90000);
  step('terrace (routing hub)');
  await sleep(1800);
  await click("document.querySelector('#routing-hub-input')", 'terrace input');
  for (const character of target.hubLine) { await send('Input.insertText', { text: character }); await sleep(45); }
  await sleep(600);
  await click("document.querySelector('#routing-hub-send')", 'terrace send');
  step(`say on the terrace: ${target.hubLine}`);

  const veilDown = "document.querySelector('#place-veil').hidden";
  if (target.failFirstOffers) {
    await waitFor(`document.querySelector('${target.screen}.active') && ${veilDown} && !document.querySelector('${target.screen} .room-cards-status').hidden && !document.querySelector('${target.screen} .room-cards-retry').hidden`, 'the failure notice and the retry sigil', 180000);
    await sleep(SETTLE_MS);
    await moveAway();
    await shot(`built-${target.name}-trouble.png`);
    record.troubleTexts = await js(VISIBLE_TEXTS({ [target.place]: 'place name (room)', [await js(`document.querySelector('${target.screen} .conversation-day-week').textContent`)]: 'week (room)' }));
    record.trouble = await js(`(() => { const status = document.querySelector('${target.screen} .room-cards-status'); const retry = document.querySelector('${target.screen} .room-cards-retry'); return { statusHtmlText: status.textContent, statusTone: status.dataset.tone ?? null, retryLabel: retry.getAttribute('aria-label'), retryText: retry.textContent.trim(), cards: document.querySelectorAll('${target.offers} .room-card').length }; })()`);
    step(`offers request failed (built-${target.name}-trouble.png): ${JSON.stringify(record.trouble)}`);
    await click(`document.querySelector('${target.screen} .room-cards-retry')`, 'retry sigil');
    step('press the retry sigil');
  }

  await waitFor(`document.querySelector('${target.screen}.active') && ${veilDown} && document.querySelectorAll('${target.offers} .room-card-button').length === 3`, `${target.screen} with three cards`, 180000);
  await sleep(SETTLE_MS);
  await moveAway();
  await shot(`built-${target.name}.png`);
  record.offers = await js(`fetch('${target.api}').then((r) => { if (!r.ok) throw new Error('${target.api} answered ' + r.status); return r.json(); })`);
  const list = target.name === 'errand' ? record.offers.errands : record.offers.offers;
  const known = {};
  for (const offer of list) {
    if (target.name === 'errand') {
      known[offer.client_display_name] = 'card: name';
      known[`${offer.reward_money.toLocaleString('ja-JP')} G`] = 'card: reward money';
    } else {
      known[offer.host_display_name] = 'card: name';
      known[offer.venue] = 'card: venue / place name';
      for (const reward of offer.reward_params) known[`${reward.label} +${reward.amount}`] = 'card: reward param';
    }
    known[offer.title] = 'card: title';
    known[offer.appeal] = 'card: appeal';
  }
  known[target.place] = 'place name (room)';
  known[await js(`document.querySelector('${target.screen} .conversation-day-week').textContent`)] = 'week (room)';
  record.known = known;
  record.cardsTexts = await js(VISIBLE_TEXTS(known));
  record.cardsBoxes = await js(BOXES(target.offers, target.screen));
  step(`${target.screen} with 3 cards (built-${target.name}.png)`);

  await click(`document.querySelector('${target.offers} .room-card-button')`, 'first card');
  step('press the first card');
  // 最初の言葉が出揃い（書く口が開く）、相手が現れはじめた（札はまだ残っている）ところで頁の動きをすべて止め、終わりのある動き
  // （相手の現れる cl-emerge・言葉の現れ・暗がりの満ち）を終わりの 1ms 手前へ送ってから撮る（繰り返しの動きは止めたまま）。
  await waitFor(`document.querySelector('#conversation-day-screen.active') && document.querySelector('${target.offers}').dataset.step === 'held' && document.querySelector('#cl-face.is-present') && ${PARTNER_ROWS}.length > 0 && !document.querySelector('#conversation-day-send').disabled`, 'the first words beside the held card while the partner emerges', 180000);
  record.emergeSeek = await js(`(() => {
    const animations = document.getAnimations();
    animations.forEach((a) => a.pause());
    return animations.filter((a) => Number.isFinite(a.effect.getComputedTiming().endTime)).map((a) => { const before = a.currentTime; a.currentTime = a.effect.getComputedTiming().endTime - 1; return { name: a.animationName ?? a.constructor.name, before: Math.round(before), after: a.currentTime }; });
  })()`);
  step(`paused the page; finite animations seeked to their end ${JSON.stringify(record.emergeSeek)}`);
  await moveAway();
  await shot(`built-${target.name}-chosen.png`);
  record.chosenTexts = await js(VISIBLE_TEXTS(known));
  record.chosenBoxes = await js(BOXES(target.offers, target.screen));
  await js('document.getAnimations().forEach((a) => a.play())');
  step(`the partner has emerged beside the held card (built-${target.name}-chosen.png)`);

  await waitFor(`document.querySelector('${target.offers}').parentElement === document.querySelector('${target.screen}') && document.querySelectorAll('${target.offers} .room-card').length === 0 && !document.querySelector('#conversation-day-screen').hasAttribute('data-room-card-held') && ${CONVERSATION_IDLE} && document.querySelector('#cl-face').getAnimations({ subtree: true }).every((a) => a.playState !== 'running')`, 'the card leaving after the first words', 60000);
  await sleep(SETTLE_MS);
  await moveAway();
  await shot(`built-${target.name}-settled.png`);
  record.settledTexts = await js(VISIBLE_TEXTS(known));
  record.settled = await js(`(() => { const box = (sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); }; return { place: document.querySelector('#cl-stage-name').textContent, week: document.querySelector('#conversation-day-week').textContent, weekBox: box('#conversation-day-week'), placeBox: box('#cl-stage-name'), face: box('#cl-face') }; })()`);
  step(`the first words are out and the card has left (built-${target.name}-settled.png)`);
  // 札の部屋の週の字と会話の画面の週の字は同じ字・同じ箱（札から会話へ移っても字は動かない）。
  const roomWeek = Object.keys(known).find((text) => known[text] === 'week (room)');
  record.weekCheck = { room: roomWeek, conversation: record.settled.week, roomBox: record.cardsBoxes.roomWeek, conversationBox: record.settled.weekBox, offersWeek: record.offers.week };
  if (roomWeek !== record.settled.week || JSON.stringify(record.cardsBoxes.roomWeek) !== JSON.stringify(record.settled.weekBox)) throw new Error(`the week moved from the card room to the conversation: ${JSON.stringify(record.weekCheck)}`);
  step(`week check ${JSON.stringify(record.weekCheck)}`);

  record.rendererErrors = rendererErrors;
  const unexpected = rendererErrors.filter((message) => !expectedErrors.some((pattern) => pattern.test(message)));
  writeFileSync(path.join(outDir, `${target.name}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  win.destroy();
  if (unexpected.length) throw new Error(`renderer errors: ${JSON.stringify(unexpected)}`);
  return record;
}

const PILLOW = String.raw`
import json, os, sys
from PIL import Image
job = json.loads(sys.argv[1])
def save(image, out):
    if os.path.exists(out): raise SystemExit(out + " exists")
    image.save(out, format="PNG")
    print("%s %dx%d" % (os.path.basename(out), image.width, image.height))
for left, right, out in job["compares"]:
    a = Image.open(left).convert("RGB"); b = Image.open(right).convert("RGB")
    if a.size != (1440, 900) or b.size != (1440, 900): raise SystemExit("sizes %s %s" % (a.size, b.size))
    canvas = Image.new("RGB", (a.width * 2 + 24, a.height), (5, 6, 15))
    canvas.paste(a, (0, 0)); canvas.paste(b, (a.width + 24, 0))
    save(canvas, out)
for source, box, out in job["crops"]:
    image = Image.open(source).convert("RGB")
    x, y, w, h = box
    pad = 14
    save(image.crop((max(0, x - pad), max(0, y - pad), min(image.width, x + w + pad), min(image.height, y + h + pad))), out)
`;

function unionBox(boxes) {
  const present = boxes.filter(Boolean);
  const left = Math.min(...present.map((b) => b[0]));
  const top = Math.min(...present.map((b) => b[1]));
  const right = Math.max(...present.map((b) => b[0] + b[2]));
  const bottom = Math.max(...present.map((b) => b[1] + b[3]));
  return [left, top, right - left, bottom - top];
}

async function main() {
  const args = parseArgs(process.argv.slice(1));
  const outDir = args['--out-dir'];
  await fs.mkdir(outDir, { recursive: true });
  if ((await fs.readdir(outDir)).length) throw new Error(`${outDir} is not empty`);
  // 一画面ずつ窓を閉じるので、最後の窓が閉じても app を終えない（終えるのは main の終わり）。
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const records = {};
  const timings = [];
  for (const target of SCREENS) {
    const product = await startProduct(args['--repo-root']);
    const started = Date.now();
    try {
      records[target.name] = await shootScreen({ target, url: product.url, outDir });
      product.assertNoLmFailure();
    } finally {
      await product.stop();
      console.log(`product stopped (${target.name})`);
    }
    timings.push(`${target.name} ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  // 載せ直した手がかり: 札の値・人の顔と名・題・語り・集まる所（札と選んだ後の場所の名）・週。
  const errand = records.errand;
  const study = records['study-circle'];
  const crops = [
    ['built-errand.png', errand.cardsBoxes.parts[0].worth, 'clue-errand-reward-money.png'],
    ['built-study-circle.png', study.cardsBoxes.parts[0].worth, 'clue-study-circle-reward-params.png'],
    ['built-errand.png', unionBox([errand.cardsBoxes.parts[0].face, errand.cardsBoxes.parts[0].name, errand.cardsBoxes.parts[0].title, errand.cardsBoxes.parts[0].appeal]), 'clue-errand-who-title-appeal.png'],
    ['built-study-circle.png', unionBox([study.cardsBoxes.parts[0].face, study.cardsBoxes.parts[0].name, study.cardsBoxes.parts[0].title, study.cardsBoxes.parts[0].venue, study.cardsBoxes.parts[0].appeal]), 'clue-study-circle-who-title-venue-appeal.png'],
    ['built-study-circle-settled.png', unionBox([study.settled.weekBox, study.settled.placeBox]), 'clue-study-circle-venue-as-place.png'],
    ['built-errand.png', errand.cardsBoxes.roomTopbar, 'clue-errand-week.png'],
    ['built-study-circle.png', study.cardsBoxes.roomTopbar, 'clue-study-circle-week.png']
  ];
  const job = {
    compares: COMPARES.map(([, left, right, out]) => [path.join(args['--plan-dir'], left), path.join(outDir, right), path.join(outDir, out)]),
    crops: crops.map(([source, box, out]) => [path.join(outDir, source), box, path.join(outDir, out)])
  };
  const { stdout } = await execFileAsync('python3', ['-c', PILLOW, JSON.stringify(job)]);
  process.stdout.write(stdout);
  console.log(`shot: ${timings.join(' / ')}`);
}

const watchdog = setTimeout(() => { console.error(`roomCardsCapture: no result within ${WATCHDOG_MS} ms`); app.exit(2); }, WATCHDOG_MS);
main().then(() => { clearTimeout(watchdog); app.exit(0); }, (error) => { console.error(error); app.exit(1); });
