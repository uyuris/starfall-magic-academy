// ルーティングハブの場所の窓（行き先の名に触れたとき）と送り出しを、製品の通常の道で撮る手回しの道具
// （*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/hubPlaceWindowCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・app/public・data・
// content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。
// LM は固定応答で、案内人の言葉は場面が決めた文（撮影のための仮の文）を返し、知らない要求は 500 にして撮影ごと止める。
// --out は無いか空であること。撮った png と、場面ごとの記録（各枚の窓の数・範囲・絵・言葉の行との重なりの数・窓の中の
// 明るさ・窓と言葉の列の変わり目の時刻）を <out>/manifest.json に書く。
// 場面（scene）:
//   names          行き先ぜんぶの名に一つずつ触れて窓が開いた姿（1600x1200）。行き先の数は hub start の応答の
//                  routing_destinations から数え、撮った数と一致しなければ止める。窓だけを切り出した画と、それを同じ大きさで
//                  並べた一覧（windows-sheet.png）も書く。
//   paragraph      長い段落の中の名・同じ段落の二つの名（一つ目と二つ目）・動きを減らす設定で開いた姿。
//   longest        言葉の欄に収まる最も長い段落で、各行の名に一つずつ触れた姿と、窓と言葉の行の重なりの数。
//   sendoff        露台から送り出せる行き先ぜんぶ（数は hub start の応答から数える）の送り出しを、幕が満ち始めてから読み込みが落ち着く
//                  までを 100ms の区切りで撮り、区切りごとの明るさ（画面全体の平均・上位 5% の境）と、沈む・夜・浮かぶの三つの長さを
//                  <out>/sendoff-frames.tsv・sendoff-summary.tsv に書く（比べ方は judgeSendoff・越えたら止める）。各行に平らな夜
//                  （星も待ちのアイコンも無い区切りの数 × 100ms）を添え、FLAT_NIGHT_LIMIT_MS を越えたら止める。
//   sendoff-event  学院マップへの送り出しで、着いた所で出来事が始まる道（会話へ移るあいだ）。
//   sendoff-resumed 後処理の止まりから露台の「もう一度」でやり直した送り出し（読み込みの箱）。
//   sendoff-reduced 動きを減らす設定の送り出し（調合へ）。
//   sendoff-wrap-up 区切り（タイトルへ）の送り出し（幕が夜に満ち、区切りの読み込みの箱の上で薄れて上がる）。
//   bounds         画面の大きさごと（1024x768・1280x720・製品の窓の既定の 1440x960・1920x1080・2560x1440）の窓の大きさ
//                  （下限・上限の確かめ）。
// 撮影の罠: ポインタを動かしてすぐ（1 秒足らずのうち）に Page.captureScreenshot を呼ぶと、ページに座標が 2 倍のポインタの離脱と
// 入り直しが届き、名のそばの窓が閉じて開き直す。名に触れた後は POINTER_REST_MS を置いてから撮り、撮った前後で窓の姿が
// 変わっていないことを確かめる。
import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1600, height: 1200 };
const BOUNDS_VIEWPORTS = [{ width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1440, height: 960 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }];
const SETTLE_MS = 1500;
const POINTER_REST_MS = 1100;
const LM_WAIT_MS = 300000;
// 送り出しのコマ: 区切りの長さと、コマを撮る大きさ（画面に対する倍率）。
const FRAME_SLOT_MS = 100;
const FRAME_SCALE = 0.25;
const SCENE_LIMIT_MS = 1800000;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--scenes'];
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
  for (const scene of scenes) {
    if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  }
  for (const key of ['--repo-root', '--out']) if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], scenes };
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
const FIXTURE_PROMPT_ANSWERS = [
  ['この依頼の達成条件が、ここまでの会話で満たされたかを判定する', 'false'],
  ['この研究会の達成条件が、ここまでの会話で満たされたかを判定する', 'false'],
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['この談話の場に残っていたいと思っているかを判定する', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0']
];
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

// 案内人の言葉は script.guideLine（場面が決めた文）。決めていない間は表情ごとの決まり文。script.failReflections が正の間は、
// 振り返りの要求をその数だけ 500 で返す（場面が決めた失敗・後処理を止める）。
function createFixtureLm(hubLines, script) {
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
    if (Object.hasOwn(FIXTURE_OFFER_RECORDS, schemaName)) return { kind: schemaName, content: JSON.stringify(FIXTURE_OFFER_RECORDS[schemaName]) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      if (matches.length > 1) throw new Error(`fixture lm: the hub conversation holds ${matches.length} destination lines`);
      const destination = matches.length === 1 ? matches[0][0] : 'none';
      return { kind: `hub-destination ${destination}`, content: destination };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { kind: 'event-flag false', content: 'false' };
    for (const [marker, appeal] of FIXTURE_OFFER_APPEALS) {
      if (prompt.includes(marker)) return { kind: `offer-appeal ${marker}`, content: appeal };
    }
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) {
      if (prompt.includes(marker)) return { kind: marker, content };
    }
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) {
      if (script.guideLine !== null) return { kind: 'guide-line (scripted)', content: script.guideLine };
      return { kind: `chat-line ${mood.expression}`, content: FIXTURE_CHAT_LINES.get(mood.expression) };
    }
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) {
      if (script.failReflections > 0) {
        script.failReflections -= 1;
        return { kind: 'reflection (scripted failure)', status: 500, content: 'capture: scripted reflection failure' };
      }
      return { kind: 'reflection', content: FIXTURE_REFLECTION_LINE };
    }
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

// 固定応答の LM: 知らない要求は 500 にして lmFailures に積む。
function createFixtureLmServer(answer, lmFailures, lmLog) {
  return createHttpServer(async (req, res) => {
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
    // 場面が決めた失敗（後処理を止める）: 撮影を止める失敗には積まない。
    if (reply.status === 500) {
      console.log(`fixture-lm 500 (scripted): ${reply.content}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: reply.content }));
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
}

// 場面ごとに一つ: 一時のセーブ・固定応答の LM・製品サーバー。lmFailures は撮影を止める LM の失敗。
// preparePlay は新しいプレイ（slot の root）を製品が起きる前に書き換える（null なら書き換えない）。
async function startProduct(repoRoot, preparePlay) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations, GATED_ROUTING_DESTINATION_IDS } = await product('routingDestinations.mjs');
  const { routingDestinationsForState } = await product('routingDestinationSelection.mjs');
  const { magicParameterDefinitions } = await product('parameters.mjs');
  const { HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } = await product('homunculusUnlock.mjs');
  const script = { guideLine: null, failReflections: 0 };
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-place-window-capture-'));
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
    const play = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    if (preparePlay !== null) await preparePlay(play.root);
    const lmServer = createFixtureLmServer(createFixtureLm(hubLines, script), lmFailures, lmLog);
    const lmPort = await listen(lmServer);
    closers.push(() => closeServer(lmServer));
    const lmBase = `http://${HOST}:${lmPort}/v1`;
    await writeJson(root, 'app/config/lmstudio.json', {
      provider: 'lmstudio',
      base_url: lmBase,
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
      script,
      hubReachableIds: routingDestinationsForState({}, [...GATED_ROUTING_DESTINATION_IDS]).map((destination) => destination.id),
      gatedIds: [...GATED_ROUTING_DESTINATION_IDS],
      atelierUnlock: { magicKey: magicParameterDefinitions[0].key, value: HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD },
      lmFailures,
      lmLog,
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
// 場所の窓と言葉の列の変わり目を、ページの時計（performance.now の ms）で残す。
const INSTALL_TIMELINE = `(() => {
  if (window.__placeTimeline) return true;
  window.__placeTimeline = [];
  const record = (kind, value) => window.__placeTimeline.push({ t: Math.round(performance.now()), kind, value });
  const placeWindow = document.querySelector('#routing-hub-screen .terrace-place-window');
  const stream = document.querySelector('#routing-hub-message-stream');
  const hub = document.querySelector('#routing-hub-screen');
  new MutationObserver(() => record('window', placeWindow.hidden ? 'hidden' : (placeWindow.dataset.window ?? 'seating'))).observe(placeWindow, { attributes: true, attributeFilter: ['hidden', 'data-window'] });
  new MutationObserver(() => record('rows', [...stream.children].map((row) => row.classList.contains('player-message') || row.classList.contains('player-narration-message') ? 'P' : 'G').join(''))).observe(stream, { childList: true });
  new MutationObserver(() => record('hub', hub.classList.contains('active') ? 'shown' : 'left')).observe(hub, { attributes: true, attributeFilter: ['class'] });
  return true;
})()`;

// いまの場所の窓の姿: 開いている窓の数・範囲・席・段・絵・切り取り・窓の中の文字の数、言葉の行（顔と言葉の枠）の数と、窓と重なる数。
const WINDOW_STATE = `(() => {
  const all = [...document.querySelectorAll('.terrace-place-window')];
  const open = all.filter((el) => !el.hidden && el.getBoundingClientRect().width > 0);
  const pieces = [...document.querySelectorAll('#routing-hub-message-stream .chat-message :is(.message-face, .message-bubble)')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const round = (r) => ({ x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 });
  const el = open[0] ?? null;
  const box = el ? el.getBoundingClientRect() : null;
  const art = el ? el.querySelector('img') : null;
  const stream = document.querySelector('#routing-hub-message-stream').getBoundingClientRect();
  return {
    windowElements: all.length,
    openWindows: open.length,
    window: el ? { box: round(box), state: el.dataset.window ?? null, running: el.getAnimations().filter((a) => a.playState === 'running').length, art: art.getAttribute('src'), objectPosition: getComputedStyle(art).objectPosition, natural: [art.naturalWidth, art.naturalHeight], text: el.textContent.length, filter: getComputedStyle(art).filter, opacity: getComputedStyle(el).opacity, insideViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight } : null,
    wordsColumn: round(stream),
    guideFaceBandBottom: Math.round(document.querySelector('#routing-hub-screen').getBoundingClientRect().height * 0.31 * 10) / 10,
    wordPieces: pieces.length,
    overlappingWordPieces: box ? pieces.filter((r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top).length : 0,
    viewport: [innerWidth, innerHeight]
  };
})()`;

async function openPage(guard, viewport) {
  const win = new BrowserWindow({ width: viewport.width, height: viewport.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
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
  await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Network.enable');
  // hub start の応答（routing_destinations を運ぶ）を、届くたびに覚える。
  const hubStartRequests = new Set();
  const hubStarts = [];
  // 止めている要求（CDP Fetch の Request 段）: hold が止め始め、release がまとめて流す。
  const held = [];
  // 画面のコマ（CDP の screencast）: 画面が描き変わるたびに届くコマを、描き変わった時刻（ms）と一緒に受ける。
  let cast = null;
  cdp.on('message', (event, method, params) => {
    if (method === 'Fetch.requestPaused') held.push({ requestId: params.requestId, url: params.request.url, method: params.request.method, at: Date.now() });
    if (method === 'Page.screencastFrame') {
      if (cast !== null) {
        if (params.metadata.timestamp === undefined) throw new Error('a screencast frame came without its timestamp');
        cast.push({ at: params.metadata.timestamp * 1000, receivedAt: Date.now(), png: Buffer.from(params.data, 'base64') });
      }
      send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => console.log(`screencast ack: ${error.message}`));
    }
    if (method === 'Network.responseReceived' && params.response.url.endsWith('/api/routing/hub/start')) hubStartRequests.add(params.requestId);
    if (method === 'Network.loadingFinished' && hubStartRequests.has(params.requestId)) {
      hubStartRequests.delete(params.requestId);
      send('Network.getResponseBody', { requestId: params.requestId }).then(({ body }) => hubStarts.push(JSON.parse(body))).catch((error) => console.log(`hub start body: ${error.message}`));
    }
  });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js,
    viewport,
    pageErrors,
    hubStarts,
    async load(url) {
      await win.loadURL(url);
      const measured = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
      if (measured.w !== viewport.width || measured.h !== viewport.height || measured.dpr !== 1) throw new Error(`viewport ${JSON.stringify(measured)}`);
    },
    async waitFor(predicate, label, timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        guard();
        const ok = await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`);
        if (ok) return;
        await sleep(30);
      }
      throw new Error(`timed out waiting for ${label} (window: ${JSON.stringify(await js(WINDOW_STATE).catch(() => null))})`);
    },
    async moveTo(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
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
      await send('Input.insertText', { text });
    },
    async reduceMotion(reduce) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
    },
    // urlPattern（CDP の * の式）に合う要求を、release まで止める。
    async hold(urlPattern) {
      if (held.length > 0) throw new Error(`requests are already held: ${held.map((entry) => entry.url).join(' ')}`);
      await send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Request' }] });
    },
    held() {
      return held.map((entry) => ({ method: entry.method, url: new URL(entry.url).pathname }));
    },
    async release() {
      for (const entry of held.splice(0)) await send('Fetch.continueRequest', { requestId: entry.requestId });
      await send('Fetch.disable');
      for (const entry of held.splice(0)) await send('Fetch.continueRequest', { requestId: entry.requestId });
    },
    // 画面のコマを FRAME_SCALE の大きさで受け始める（受けたコマは castFrames が返す）。
    async startCast() {
      if (cast !== null) throw new Error('the screencast is already running');
      cast = [];
      await send('Page.startScreencast', { format: 'png', maxWidth: Math.round(viewport.width * FRAME_SCALE), maxHeight: Math.round(viewport.height * FRAME_SCALE), everyNthFrame: 1 });
    },
    castFrames() {
      if (cast === null) throw new Error('the screencast is not running');
      return cast;
    },
    async stopCast() {
      await send('Page.stopScreencast');
      cast = null;
    },
    async png(clip = null) {
      const { data } = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    close() {
      win.destroy();
    }
  };
  return page;
}

// ── 製品の通常の道 ─────────────────────────────────────────────────────────────────────────────────────────
const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const IMAGES_LOADED = (selector) => `[...document.querySelectorAll(${JSON.stringify(`${selector} img`)})].every((img) => !img.getAttribute('src') || img.complete)`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const screenSettled = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP} && ${motionSettled(`#${id}`)} && ${IMAGES_LOADED(`#${id}`)}`;
const HUB_SHOWN = `(document.querySelector('#routing-hub-screen.active') && !${LOADING_ACTIVE} && !${VEIL_UP})`;
const HUB_READY = `${HUB_SHOWN} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const PLACE_WINDOW = "document.querySelector('#routing-hub-screen .terrace-place-window')";
const WINDOW_OPEN = `(!${PLACE_WINDOW}.hidden && ${PLACE_WINDOW}.dataset.window === 'opening' && ${PLACE_WINDOW}.getAnimations().every((a) => a.playState !== 'running'))`;
const WINDOW_CLOSED = `${PLACE_WINDOW}.hidden`;
const LAST_GUIDE_ROW = "[...document.querySelectorAll('#routing-hub-message-stream .character-message')].at(-1)";

async function walkToHub(ctx) {
  const { page, product, steps } = ctx;
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await awaitHub(ctx);
  await page.js(INSTALL_TIMELINE);
  steps.push('title → ロード → slot → hub');
}

async function awaitHub({ page }) {
  await page.waitFor(HUB_READY, 'the hub', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the hub settled', 30000);
  await sleep(SETTLE_MS);
}

// 送信は、迎えの言葉を出している間は黙って何もしないので、入力の欄が空になる（送信が走った）まで押し直す。
async function sayOnHub({ page, steps }, line) {
  await page.type("document.querySelector('#routing-hub-input')", 'hub input', line);
  const end = Date.now() + 30000;
  for (;;) {
    await page.click("document.querySelector('#routing-hub-send')", 'hub send');
    await sleep(120);
    if (await page.js("document.querySelector('#routing-hub-input').value === ''")) break;
    if (Date.now() > end) throw new Error(`the hub send never fired for: ${line}`);
  }
  steps.push(`say on the hub: ${line}`);
}

// 案内人に決めた文を言わせる（固定応答の LM）: 主人公の雑談を一つ送り、案内人の最後の行がその文になるのを待つ。
async function guideSays(ctx, line) {
  const { page, product } = ctx;
  product.script.guideLine = line;
  const before = await page.js("document.querySelectorAll('#routing-hub-message-stream .character-message').length");
  await sayOnHub(ctx, '少し話を聞かせて。');
  await page.waitFor(`document.querySelectorAll('#routing-hub-message-stream .character-message').length > ${before} && !document.querySelector('#routing-hub-input').disabled && ${motionSettled('#routing-hub-screen')}`, 'the guide reply', LM_WAIT_MS);
  await sleep(700);
  const said = await page.js(`[...${LAST_GUIDE_ROW}.querySelectorAll('.message-bubble p')].map((p) => p.textContent).join('')`);
  if (said !== line) throw new Error(`the guide's last row is not the scripted line: ${JSON.stringify(said)}`);
  product.script.guideLine = null;
}

// 案内人の最後の行の名（.terrace-place）の一覧: 行き先の id・名・触れる点（最初の行の箱の真ん中）・段落の中の行の番号。
const LAST_ROW_NAMES = `(() => {
  const row = ${LAST_GUIDE_ROW};
  const paragraph = row.querySelector('.message-bubble p');
  const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
  const top = paragraph.getBoundingClientRect().top;
  return {
    lines: Math.round(paragraph.getBoundingClientRect().height / lineHeight),
    characters: paragraph.textContent.length,
    paragraph: paragraph.getBoundingClientRect().toJSON(),
    names: [...row.querySelectorAll('.terrace-place')].map((span, index) => { const r = span.getClientRects()[0]; return { index, id: span.dataset.destinationId, label: span.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2, line: Math.round((r.top - top) / lineHeight - 0.2) }; })
  };
})()`;

// 名に触れて、その行き先の窓が開ききるのを待つ。
async function touchName(ctx, name) {
  const { page } = ctx;
  await page.moveTo(name.x, name.y);
  await page.waitFor(`${WINDOW_OPEN} && ${PLACE_WINDOW}.querySelector('img').getAttribute('src') !== null`, `the window for ${name.label}`, 10000);
  await sleep(POINTER_REST_MS);
}

async function leaveName(ctx) {
  await ctx.page.moveTo(4, 4);
  await ctx.page.waitFor(WINDOW_CLOSED, 'the window closed', 10000);
}

// ── 撮る ───────────────────────────────────────────────────────────────────────────────────────────────────
// 窓の中（額の内側）の明るさの平均（0〜255・Rec.709）。
function meanLuma(png, box) {
  const image = nativeImage.createFromBuffer(png).crop({ x: Math.round(box.x) + 2, y: Math.round(box.y) + 2, width: Math.round(box.width) - 4, height: Math.round(box.height) - 4 });
  const bitmap = image.toBitmap();
  let sum = 0;
  for (let i = 0; i < bitmap.length; i += 4) sum += 0.0722 * bitmap[i] + 0.7152 * bitmap[i + 1] + 0.2126 * bitmap[i + 2];
  return Math.round((sum / (bitmap.length / 4)) * 10) / 10;
}

function createShooter(ctx) {
  return async function shoot(file, note, extra = {}) {
    const target = path.join(ctx.options.out, `${file}.png`);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
    const state = await ctx.page.js(WINDOW_STATE);
    const bytes = await ctx.page.png();
    const { width, height } = ctx.page.viewport;
    if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error(`${file}.png is not ${width}x${height}`);
    await fs.writeFile(target, bytes);
    const after = await ctx.page.js(WINDOW_STATE);
    if (JSON.stringify(after.window) !== JSON.stringify(state.window) || after.openWindows !== state.openWindows) throw new Error(`${file}: the place window changed while it was captured (${JSON.stringify(state.window)} → ${JSON.stringify(after.window)})`);
    const luma = state.window ? meanLuma(bytes, state.window.box) : null;
    const shot = { file: `${file}.png`, note, size: [width, height], ...state, windowMeanLuma: luma, ...extra };
    ctx.shots.push(shot);
    console.log(`shot ${file}.png — ${note} ${JSON.stringify({ open: state.openWindows, of: state.windowElements, window: state.window && { box: state.window.box, state: state.window.state, art: state.window.art, pos: state.window.objectPosition, text: state.window.text, inside: state.window.insideViewport }, luma, wordPieces: state.wordPieces, overlap: state.overlappingWordPieces, ...extra })}`);
    return { state, bytes };
  };
}

function requireOneWindow(state, label) {
  if (state.windowElements !== 1 || state.openWindows !== 1) throw new Error(`${label}: expected exactly one open place window, got ${state.openWindows} open of ${state.windowElements}`);
  if (state.window.text !== 0) throw new Error(`${label}: the place window holds text`);
  if (state.overlappingWordPieces !== 0) throw new Error(`${label}: the place window overlaps ${state.overlappingWordPieces} word piece(s)`);
  if (!state.window.insideViewport) throw new Error(`${label}: the place window is not inside the viewport`);
  if (state.window.box.y < state.guideFaceBandBottom - 0.5) throw new Error(`${label}: the place window's top ${state.window.box.y} is inside the guide's face band (down to ${state.guideFaceBandBottom})`);
}

// 並べる頁は一時ディレクトリの file に書き、切り出した画は file:// で引く。
async function writeSheet(out, cells, cellSize) {
  const columns = 5;
  const rows = Math.ceil(cells.length / columns);
  const gap = 28;
  const labelHeight = 30;
  const width = columns * (cellSize.width + gap) + gap;
  const height = rows * (cellSize.height + labelHeight + gap) + gap;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-place-window-sheet-'));
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false });
  try {
    const html = `<html><body style="margin:0;background:#05060f;color:#cdd6ea;font:14px sans-serif"><div style="display:grid;grid-template-columns:repeat(${columns},${cellSize.width}px);gap:${gap}px;padding:${gap}px">${cells.map((cell) => `<div><img style="display:block;width:${cellSize.width}px;height:${cellSize.height}px" src="${new URL(`file://${path.join(out, cell.file)}`).href}"><div style="height:${labelHeight}px;line-height:${labelHeight}px">${cell.caption}</div></div>`).join('')}</div></body></html>`;
    const pagePath = path.join(scratch, 'tile-capture.html');
    await fs.writeFile(pagePath, html, 'utf8');
    await win.loadFile(pagePath);
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await win.webContents.executeJavaScript('Promise.all([...document.images].map((img) => img.decode()))');
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
    await fs.writeFile(path.join(out, 'windows-sheet.png'), Buffer.from(data, 'base64'));
    console.log(`sheet windows-sheet.png — ${cells.length} windows, each ${cellSize.width}x${cellSize.height}`);
  } finally {
    win.destroy();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
const sentenceWith = (labels) => `今週でしたら、${labels.join('も、')}も開いていますよ。`;

// ── 送り出し: 幕が満ち始めてから読み込みが落ち着くまでを FRAME_SLOT_MS ごとに区切って撮り、各コマの明るさを数える ─────────────
// 明るさは画面全体の各画素の Rec.709 の明るさ（0〜255）の平均と、上位 5% の境の値（明るい側から数えて画素の 5% に届く値）。
// 比べ方は judgeSendoff（沈む区切りは直前の区切りを越えない・夜から先は落ち着いた後の姿を越えない）。落ち着いた後の姿は、その道の
// 読み込みを要求を止めて落ち着かせたまま SETTLED_REFERENCE_MS 撮ったコマ（学院マップは浮かび終えた一コマ）。越えた区切りがあれば
// 場面ごと止める。
const DISPATCH_SCREENS = {
  'academy-map': 'academy-map', training: 'academy-training', dungeon: 'academy-dungeon', errand: 'academy-errand', alchemy: 'academy-alchemy',
  study_circle: 'academy-study-circle', workshop: 'academy-workshop', library: 'academy-library', homunculus: 'academy-atelier', arena: 'academy-arena',
  auction: 'academy-auction', lounge: 'academy-lounge', concert_hall: 'academy-concert-hall', overlook: 'academy-overlook'
};
// 区切り（タイトルへ）の行き先。着く画面が行き先の画面でないので行き先ごとの行からは外し、sendoff-wrap-up の一本で撮る。
const WRAP_UP_DESTINATION = 'title';
const CURTAIN_UP = "!document.querySelector('#terrace-opened').hidden";
const LOADING_SCREEN = "document.querySelector('#academy-loading-screen')";
// 読み込みが落ち着いた: 層の待ち・会話へ移るあいだ・読み込みの箱それぞれの、終わりのある動きが済んだ姿（星々・待ちのアイコンの回り・
// 明るみの息のような終わりの無い動きは残る）。
const SETTLED = {
  veil: `${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'waiting' && ${motionSettled('#place-veil')} && ${motionSettled('#wait-sigil')}`,
  passage: `${LOADING_ACTIVE} && ${LOADING_SCREEN}.dataset.conversationPassage === 'waiting' && !${VEIL_UP} && ${motionSettled('#academy-loading-screen')} && ${motionSettled('#wait-sigil')}`,
  box: `${LOADING_ACTIVE} && ${LOADING_SCREEN}.dataset.conversationPassage === undefined && !${VEIL_UP} && document.querySelector('#terrace-opened').hidden && ${motionSettled('#academy-loading-screen')} && ${motionSettled('#wait-sigil')}`,
  // 区切りの道: タイトルの画面が出て、幕が薄れて上がりきった姿。
  title: `document.querySelector('#title-screen.active') && !${LOADING_ACTIVE} && document.querySelector('#terrace-opened').hidden`
};
// 落ち着いた後を撮る長さ: 明るみの息（3.2s）が一巡りする長さと、ほかの読み込み（星々の瞬き）。
const SETTLED_REFERENCE_MS = { veil: 1000, passage: 3200, box: 1000, title: 1000 };
const SENDOFF_LIMIT_MS = 60000;
// 平らな夜（星も待ちのアイコンも無い区切り）の長さの上限（Lead の決め）。
const FLAT_NIGHT_LIMIT_MS = 300;
// 各コマの層の姿（幕の不透明度・待ちの層の段・読み込みの形・出ている画面・待ちのアイコンが出ているか）。
const FRAME_STATE = `(() => {
  const curtain = document.querySelector('#terrace-opened');
  const veil = document.querySelector('#place-veil');
  const loading = document.body.classList.contains('academy-loading-screen-active') ? (${LOADING_SCREEN}.dataset.conversationPassage ?? 'box') : null;
  return { curtain: curtain.hidden ? null : Math.round(Number(getComputedStyle(curtain).opacity) * 100) / 100, veil: veil.hidden ? null : veil.dataset.veil, rise: veil.hidden ? null : (veil.dataset.veilRise ?? null), loading, screen: document.querySelector('.screen.active')?.id ?? null, sigil: !document.querySelector('#wait-sigil').hasAttribute('hidden') };
})()`;

function frameLuma(png) {
  const bitmap = nativeImage.createFromBuffer(png).toBitmap();
  const pixels = bitmap.length / 4;
  const histogram = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    const luma = 0.0722 * bitmap[i] + 0.7152 * bitmap[i + 1] + 0.2126 * bitmap[i + 2];
    sum += luma;
    histogram[Math.min(255, Math.floor(luma))] += 1;
  }
  let seen = 0;
  let top5 = 0;
  for (let value = 255; value >= 0; value -= 1) {
    seen += histogram[value];
    if (seen >= pixels * 0.05) {
      top5 = value;
      break;
    }
  }
  return { mean: Math.round((sum / pixels) * 10) / 10, top5 };
}

// t0 から until が真になるまで（until が null なら durationMs のあいだ）を FRAME_SLOT_MS ごとに区切る。区切りの明るさは、その区切りの
// あいだ画面に出ていたコマ（区切りの頭に出ていたコマと、区切りの中で描き変わったコマ）の数の最大で、区切りの画はそのうち平均の
// 最も明るいコマ。層の姿は区切りの中で最後に読んだもの。
const STATE_POLL_MS = 40;
// screencast のコマの時刻（描き変わった時刻）は ms より粗く丸められて届くので、受けた時刻より少し後に見えることがある。
const CAST_CLOCK_ROUNDING_MS = 2;
async function recordSlots(ctx, { prefix, until, durationMs, endAtExpr = null }) {
  const { page } = ctx;
  const started = Date.now();
  const states = [];
  for (;;) {
    ctx.guard();
    const at = Date.now();
    if (at - started > SENDOFF_LIMIT_MS) throw new Error(`${prefix}: not settled within ${SENDOFF_LIMIT_MS} ms (last ${JSON.stringify(states.at(-1)?.state)})`);
    const { state, done } = await page.js(`(() => ({ state: ${FRAME_STATE}, done: ${until === null ? 'false' : `(() => { try { return !!(${until}); } catch (error) { return false; } })()`} }))()`);
    states.push({ at, state });
    // until の道も少なくとも一つの区切りを撮る（動きを減らす設定では、夜と待ちの層がその場で出て最初の読みで落ち着いている）。
    if (until === null ? at - started >= durationMs : done && at - started >= FRAME_SLOT_MS) break;
    await sleep(STATE_POLL_MS);
  }
  // endAtExpr: 終わりの時刻をページが記録した時刻（ms）で決める道（落ち着いた姿が一瞬しか無い学院マップ）。
  const ended = endAtExpr !== null ? await page.js(endAtExpr) : until === null ? started + durationMs : states.at(-1).at;
  if (!Number.isFinite(ended) || ended < started) throw new Error(`${prefix}: the end time ${JSON.stringify(ended)} is not after the start ${started}`);
  // 終わりの時刻までに描き変わったコマが届ききるのを待つ。
  await sleep(300);
  const cast = page.castFrames();
  const lumaOf = new Map();
  const luma = (frame) => {
    if (!lumaOf.has(frame)) lumaOf.set(frame, frameLuma(frame.png));
    return lumaOf.get(frame);
  };
  const frames = [];
  for (let slot = 0; started + slot * FRAME_SLOT_MS < ended; slot += 1) {
    const from = started + slot * FRAME_SLOT_MS;
    const to = from + FRAME_SLOT_MS;
    const carried = cast.filter((frame) => frame.at < from).at(-1);
    const inside = cast.filter((frame) => frame.at >= from && frame.at < Math.min(to, ended));
    const shown = carried === undefined ? inside : [carried, ...inside];
    if (shown.length === 0) throw new Error(`${prefix}: no screen frame was on screen in slot ${slot} (the screencast had ${cast.length} frames)`);
    const brightest = shown.reduce((best, frame) => (luma(frame).mean > luma(best).mean ? frame : best));
    const file = `${prefix}-${String(slot).padStart(3, '0')}.png`;
    await fs.writeFile(path.join(ctx.options.out, file), brightest.png);
    frames.push({
      slot, fromMs: slot * FRAME_SLOT_MS, toMs: (slot + 1) * FRAME_SLOT_MS, file,
      mean: Math.max(...shown.map((frame) => luma(frame).mean)),
      top5: Math.max(...shown.map((frame) => luma(frame).top5)),
      screenFrames: inside.length,
      state: states.filter((entry) => entry.at < to).at(-1).state
    });
  }
  return frames;
}

// 新しいプレイを一つ起こして fn を走らせ、閉じる（行き先ごとに、迎えから始まる同じ露台に立つ）。
async function freshPlay(ctx, prepareState, fn) {
  const product = await startProduct(ctx.options.repoRoot, prepareState);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`LM failed: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard, VIEWPORT);
  // 場面が自分で起こした失敗のあいだに出た描き手の error（記録に残し、止めない）。
  const expectedPageErrors = [];
  try {
    await fn({ ...ctx, product, page, guard, expectedPageErrors });
    guard();
    if (page.pageErrors.length > 0) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
    if (expectedPageErrors.length > 0) {
      ctx.measures.push({ scene: ctx.scene, rendererErrorsDuringTheScriptedFailure: expectedPageErrors });
      console.log(`renderer errors during the scripted failure: ${expectedPageErrors.join(' | ')}`);
    }
  } finally {
    page.close();
    await product.stop();
  }
}

// 一本の道: start が真になったところ（幕が満ち始めた・幕の無い道は読み込みが出た）から、settled の読み込みが落ち着くまでを撮り、
// 落ち着いた姿を要求を止めたまま撮って比べる相手にする。止めた要求を流し、着いた画面が出るのを待つ。
async function sendoffRow(ctx, { row, path: road, destination, start, hold, settled, arrived }) {
  const { page } = ctx;
  await page.startCast();
  if (settled === 'momentary') await page.js(WATCH_VEIL_RISE_AND_LEAVE);
  await page.waitFor(start, `${row}: the send-off start`, LM_WAIT_MS);
  let frames;
  let reference;
  let heldNow = [];
  if (settled === 'momentary') {
    ({ frames, reference } = await recordMomentary(ctx, row));
  } else {
    // hold が null の道（区切り）は、落ち着いた姿が止める要求の無い画面そのもの。
    if (hold !== null) await page.hold(hold);
    frames = await recordSlots(ctx, { prefix: `sendoff-${row}`, until: SETTLED[settled], durationMs: null });
    heldNow = page.held();
    if (hold !== null && heldNow.length === 0) throw new Error(`${row}: the loading settled without the held request ${hold} (it was never made)`);
    reference = await recordSlots(ctx, { prefix: `sendoff-${row}-settled`, until: null, durationMs: SETTLED_REFERENCE_MS[settled] });
    if (!(await page.js(SETTLED[settled]))) throw new Error(`${row}: the loading did not stay settled while the reference was taken (${JSON.stringify(await page.js(FRAME_STATE))})`);
  }
  const lag = page.castFrames().map((frame) => frame.receivedAt - frame.at).sort((a, b) => a - b);
  const castClock = { frames: lag.length, receivedMinusSwapMsMedian: Math.round(lag[Math.floor(lag.length / 2)]), min: Math.round(lag[0]), max: Math.round(lag.at(-1)) };
  if (castClock.min < -CAST_CLOCK_ROUNDING_MS || castClock.max > 1000) throw new Error(`${row}: the screencast clock is out of step with this process (${JSON.stringify(castClock)})`);
  await page.stopCast();
  if (hold !== null) await page.release();
  await page.waitFor(`document.querySelector('#${arrived}-screen.active')`, `${row}: ${arrived}`, LM_WAIT_MS);
  const result = judgeSendoff({ row, road, destination, settled, frames, reference });
  Object.assign(result, { held: heldNow, arrived, castClock });
  ctx.sendoffRows.push(result);
  console.log(`sendoff ${row}: ${frames.length} slots, night from slot ${result.phases.nightSlot}, rise from slot ${result.phases.riseSlot}; sinking ${result.phases.sinkingMs} ms / night ${result.phases.nightMs} ms / rising ${result.phases.risingMs} ms / flat night ${result.phases.flatNightMs} ms; settled ceiling ${JSON.stringify(result.ceiling)}; over ${JSON.stringify(result.over)}`);
  return result;
}

// 比べ方（flagship の決め）: 幕が満ち始めてから夜が満ちるまで（沈む区切り）は、各区切りが直前の区切りより明るくならない。夜が満ちた
// 区切りから先は、その行き先の落ち着いた後の姿（比べる相手）を越えない。読み込みの箱の道の比べる相手は、字の出ている間も含めた箱の
// 姿の最も明るい区切り。夜が満ちた区切り = 幕が満ちきった（不透明度 1）か、待ちの層・読み込みの画面が出た最初の区切り。浮かび始めの
// 区切り = 夜から先で、絵が夜に留められていない待ちの層・満ち始めた会話へ移るあいだ・箱が出た最初の区切り。三つの長さは区切りの数から
// 読む（沈む = 夜が満ちるまで・夜 = 夜が満ちてから浮かび始めるまで・浮かぶ = 浮かび始めから落ち着くまで）。平らな夜 = 幕が満ちきって
// いて、星々を持つ層（待ちの層・読み込みの画面）も待ちのアイコンも出ていない区切り（区切りの数 × 100ms）。
function judgeSendoff({ row, road, destination, settled, frames, reference }) {
  const nightSlot = frames.findIndex((frame) => frame.state.curtain === 1 || frame.state.veil !== null || frame.state.loading !== null);
  if (nightSlot === -1) throw new Error(`${row}: the night never filled the screen`);
  const rising = (state) => (state.veil === 'waiting' && state.rise !== 'held') || state.loading === 'waiting' || (state.loading === 'box' && (settled === 'box' || settled === 'title')) || state.screen === 'title-screen';
  const riseOffset = frames.slice(nightSlot).findIndex((frame) => rising(frame.state));
  if (riseOffset === -1) throw new Error(`${row}: nothing rose from the night`);
  const riseSlot = nightSlot + riseOffset;
  // 読み込みの側の画面そのものの姿は比べる相手に含める（flagship・Lead の決め）: 箱の道は字の出ている間も含めた箱の姿、区切りの道は
  // 幕が薄れ始めてからの区切りの読み込みの箱とタイトルの画面の姿（入りの動きの間も含む）。区切りの道では、幕が薄れ始めてから
  // 不透明度が上がらない（幕が暗くする向きにしか動かない）ことも確かめる。
  const overTitleRoad = (frame) => frame.state.loading === 'box' || frame.state.screen === 'title-screen';
  const settledLook = settled === 'box' ? [...reference, ...frames.filter((frame) => frame.state.loading === 'box')]
    : settled === 'title' ? [...reference, ...frames.filter(overTitleRoad)]
      : reference;
  if (settled === 'title') {
    const clearing = frames.filter(overTitleRoad).map((frame) => frame.state.curtain ?? 0);
    const rose = clearing.findIndex((opacity, index) => index > 0 && opacity > clearing[index - 1]);
    if (rose !== -1) throw new Error(`${row}: the curtain grew more opaque over the wrap-up box and the title screen (${JSON.stringify(clearing)})`);
  }
  const flatNightSlots = frames.filter((frame) => frame.state.curtain === 1 && frame.state.veil === null && frame.state.loading === null && !frame.state.sigil).length;
  const ceiling = { mean: Math.max(...settledLook.map((frame) => frame.mean)), top5: Math.max(...settledLook.map((frame) => frame.top5)) };
  for (const frame of frames) {
    if (frame.slot < nightSlot) {
      const previous = frame.slot === 0 ? null : frames[frame.slot - 1];
      frame.phase = 'sinking';
      frame.over = previous !== null && (frame.mean > previous.mean || frame.top5 > previous.top5);
    } else {
      frame.phase = frame.slot < riseSlot ? 'night' : 'rising';
      frame.over = frame.mean > ceiling.mean || frame.top5 > ceiling.top5;
    }
  }
  return {
    row, path: road, destination, settled, reference: { frames: reference, ceilingFrom: settled === 'box' ? 'the box frames (copy shown) and the settled box' : settled === 'title' ? 'the wrap-up box and title screen frames from the curtain clearing on (their entrances included) and the settled title' : 'the settled loading' }, ceiling,
    phases: { nightSlot, riseSlot, sinkingMs: nightSlot * FRAME_SLOT_MS, nightMs: riseOffset * FRAME_SLOT_MS, risingMs: (frames.length - riseSlot) * FRAME_SLOT_MS, flatNightMs: flatNightSlots * FRAME_SLOT_MS },
    frames, over: frames.filter((frame) => frame.over).map((frame) => frame.slot),
    brightest: { mean: Math.max(...frames.map((frame) => frame.mean)), top5: Math.max(...frames.map((frame) => frame.top5)) }
  };
}

// 学院マップ（出来事の無い週）: 待ちは出来事を確かめるまで絵を夜に留め、浮かび終えたところで学院マップへ薄れ替わるので、落ち着いた
// 姿は浮かび終えてから薄れ始めるまでの一瞬だけ。区切りは薄れ始め（data-veil="leaving"）の時刻で終え、比べる相手はそのとき画面に
// 出ていたコマ一枚（浮かび終えた姿）。浮かび始めから薄れ始めまでが浮かびの長さ（1.2s）に届かなければ止める。
const VEIL_RISE_MS = 1200;
const WATCH_VEIL_RISE_AND_LEAVE = `(() => {
  const veil = document.querySelector('#place-veil');
  window.__veilRiseAt = null;
  window.__veilLeavingAt = null;
  let held = false;
  new MutationObserver(() => {
    if (veil.dataset.veilRise === 'held') held = true;
    else if (held && window.__veilRiseAt === null) window.__veilRiseAt = Date.now();
    if (veil.dataset.veil === 'leaving' && window.__veilLeavingAt === null) window.__veilLeavingAt = Date.now();
  }).observe(veil, { attributes: true, attributeFilter: ['data-veil', 'data-veil-rise'] });
  return true;
})()`;

async function recordMomentary(ctx, row) {
  const { page } = ctx;
  const frames = await recordSlots(ctx, { prefix: `sendoff-${row}`, until: 'window.__veilLeavingAt !== null', durationMs: null, endAtExpr: 'window.__veilLeavingAt' });
  const { riseAt, leavingAt } = await page.js('({ riseAt: window.__veilRiseAt, leavingAt: window.__veilLeavingAt })');
  if (riseAt === null) throw new Error(`${row}: the wait never held its art in the night before it rose`);
  if (leavingAt - riseAt < VEIL_RISE_MS - FRAME_SLOT_MS / 2) throw new Error(`${row}: the wait began to leave ${leavingAt - riseAt} ms after its rise began (the rise is ${VEIL_RISE_MS} ms)`);
  const shown = page.castFrames().filter((frame) => frame.at < leavingAt).at(-1);
  if (shown === undefined) throw new Error(`${row}: no screen frame before the wait began to leave`);
  const file = `sendoff-${row}-settled-000.png`;
  await fs.writeFile(path.join(ctx.options.out, file), shown.png);
  const reference = [{ slot: 0, fromMs: null, toMs: null, file, ...frameLuma(shown.png), screenFrames: 1, state: { riseAt, leavingAt, frameAt: Math.round(shown.at) } }];
  return { frames, reference };
}

// 露台から行き先へ送り出す道（言葉の中で決まった送り出し）。
async function inTurnSendoff(ctx, { row, destination, reduceMotion }) {
  await walkToHub(ctx);
  if (reduceMotion) await ctx.page.reduceMotion(true);
  await sayOnHub(ctx, ctx.product.hubLines[destination]);
  const momentary = destination === 'academy-map';
  return sendoffRow(ctx, { row, path: reduceMotion ? 'in-turn (reduced motion)' : 'in-turn', destination, start: CURTAIN_UP, hold: momentary ? null : '*/api/field', settled: momentary ? 'momentary' : 'veil', arrived: DISPATCH_SCREENS[destination] });
}

// 表を書く（一行が一つの区切り: 道・区切り・画・明るさ・比べる相手）。
async function writeSendoffTable(ctx) {
  const lines = ['row\tpath\tdestination\tslot\tfrom_ms\tto_ms\tphase\tscreen_frames\tfile\tmean\ttop5\tcompared_with\tover\tcurtain\tveil\trise\tloading\tscreen\tsigil'];
  for (const result of ctx.sendoffRows) {
    for (const frame of result.frames) {
      const previous = frame.slot === 0 ? null : result.frames[frame.slot - 1];
      const against = frame.phase === 'sinking' ? (previous === null ? 'start' : `previous ${previous.mean}/${previous.top5}`) : `settled ${result.ceiling.mean}/${result.ceiling.top5}`;
      lines.push([result.row, result.path, result.destination, frame.slot, frame.fromMs, frame.toMs, frame.phase, frame.screenFrames, frame.file, frame.mean, frame.top5, against, frame.over ? 'OVER' : '-', frame.state.curtain ?? '-', frame.state.veil ?? '-', frame.state.rise ?? '-', frame.state.loading ?? '-', frame.state.screen ?? '-', frame.state.sigil ? 'shown' : '-'].join('\t'));
    }
  }
  await fs.writeFile(path.join(ctx.options.out, `${ctx.scene}-frames.tsv`), `${lines.join('\n')}\n`, 'utf8');
  const summary = ['row\tpath\tdestination\tslots\tsinking_ms\tnight_ms\trising_ms\tflat_night_ms\tbrightest_mean\tbrightest_top5\tsettled_mean_max\tsettled_top5_max\tover_slots'];
  for (const result of ctx.sendoffRows) {
    summary.push([result.row, result.path, result.destination, result.frames.length, result.phases.sinkingMs, result.phases.nightMs, result.phases.risingMs, result.phases.flatNightMs, result.brightest.mean, result.brightest.top5, result.ceiling.mean, result.ceiling.top5, result.over.length === 0 ? '-' : result.over.join(',')].join('\t'));
  }
  await fs.writeFile(path.join(ctx.options.out, `${ctx.scene}-summary.tsv`), `${summary.join('\n')}\n`, 'utf8');
  console.log(summary.join('\n'));
  const failed = ctx.sendoffRows.filter((result) => result.over.length > 0);
  if (failed.length > 0) throw new Error(`brighter than allowed: ${failed.map((result) => `${result.row} slots ${result.over.join(',')}`).join(' / ')}`);
  const flat = ctx.sendoffRows.filter((result) => result.phases.flatNightMs > FLAT_NIGHT_LIMIT_MS);
  if (flat.length > 0) throw new Error(`flat night longer than ${FLAT_NIGHT_LIMIT_MS} ms: ${flat.map((result) => `${result.row} ${result.phases.flatNightMs} ms`).join(' / ')}`);
}

// 学院マップで始められる出来事（星見の約束・相手は一人目の人）がある週。
const STARGAZING_EVENT = 'event.stargazing_promise.ready';
const EVENT_PARTNER = 'character_001';
async function editPlayJson(playRoot, relative, edit) {
  const full = path.join(playRoot, relative);
  const value = JSON.parse(await fs.readFile(full, 'utf8'));
  edit(value);
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function withStargazingEvent(playRoot) {
  await editPlayJson(playRoot, 'game_data/runtime_state.json', (state) => {
    state.global_flags[STARGAZING_EVENT] = true;
    state.event_flag_sources ??= {};
    state.event_flag_sources[STARGAZING_EVENT] = { character_id: EVENT_PARTNER, conversation_id: null, achieved_at: null };
  });
}

// 鍵の掛かった行き先（錬成室）を開く: 製品の解放の線（homunculusUnlock.mjs）ちょうどの魔法の習熟を一つ持たせる。
function withAtelierUnlocked(unlock) {
  return (playRoot) => editPlayJson(playRoot, 'game_data/runtime/player_parameters.json', (parameters) => {
    const entry = parameters.magic?.[unlock.magicKey];
    if (entry === undefined) throw new Error(`the new play has no magic parameter ${unlock.magicKey}`);
    parameters.magic[unlock.magicKey] = entry !== null && typeof entry === 'object' ? { ...entry, value: unlock.value } : unlock.value;
  });
}

const SENDOFF_SCENES = {
  // 露台から送り出せる行き先ぜんぶ（区切りを除く）。行き先は hub start の応答の routing_destinations から数え、製品の候補の決め方
  // （routingDestinationSelection.mjs: 露台から行けない行き先を除き、鍵の掛かった行き先は開いたものとして数える）で絞る。鍵の掛かった
  // 行き先は、その行だけ新しいプレイの鍵を開けて送り出す。撮った行の数が数えた数と一致しなければ止める。
  async sendoff(ctx) {
    await walkToHub(ctx);
    const destinations = ctx.page.hubStarts.at(-1)?.routing_destinations;
    if (!Array.isArray(destinations) || destinations.length === 0) throw new Error('no routing_destinations in the hub start response');
    const reachable = new Set(ctx.product.hubReachableIds.filter((id) => id !== WRAP_UP_DESTINATION));
    const ids = destinations.map((destination) => destination.id).filter((id) => id !== WRAP_UP_DESTINATION && reachable.has(id));
    const notOffered = destinations.map((destination) => destination.id).filter((id) => id !== WRAP_UP_DESTINATION && !reachable.has(id));
    const unknown = ids.filter((id) => !Object.hasOwn(DISPATCH_SCREENS, id));
    if (unknown.length > 0 || [...reachable].some((id) => !ids.includes(id))) throw new Error(`the destinations ${JSON.stringify(ids)} are out of step with the dispatch screens (${unknown.join(',') || '-'}) or the hub-reachable set ${JSON.stringify([...reachable])}`);
    for (const id of ids) {
      if (ctx.product.gatedIds.includes(id) && id !== 'homunculus') throw new Error(`no way to open the gated destination ${id}`);
      const prepare = ctx.product.gatedIds.includes(id) ? withAtelierUnlocked(ctx.product.atelierUnlock) : null;
      await freshPlay(ctx, prepare, (play) => inTurnSendoff(play, { row: id, destination: id, reduceMotion: false }));
    }
    if (ctx.sendoffRows.length !== ids.length) throw new Error(`took ${ctx.sendoffRows.length} send-off rows for ${ids.length} destinations`);
    ctx.measures.push({ scene: 'sendoff', routingDestinations: destinations.length, wrapUpExcluded: WRAP_UP_DESTINATION, notOfferedByTheHub: notOffered, gatedOpened: ctx.product.gatedIds, rows: ids.length });
    console.log(`sendoff: routing_destinations ${destinations.length}; wrap-up ${WRAP_UP_DESTINATION} and not offered by the hub ${JSON.stringify(notOffered)} excluded; rows ${ids.length}`);
    await writeSendoffTable(ctx);
  },
  // 学院マップへ送り出し、着いた所で出来事が始まる（会話へ移るあいだの読み込み）。出来事の最初の言葉の要求を止めて落ち着かせる。
  async 'sendoff-event'(ctx) {
    await freshPlay(ctx, withStargazingEvent, async (play) => {
      await walkToHub(play);
      await sayOnHub(play, play.product.hubLines['academy-map']);
      await sendoffRow(play, { row: 'academy-map-event', path: 'in-turn → event passage', destination: 'academy-map', start: CURTAIN_UP, hold: '*/api/conversation/opening/stream', settled: 'passage', arrived: 'conversation-day' });
    });
    await writeSendoffTable(ctx);
  },
  // 送り出しの後処理が止まり、露台の「もう一度」からやり直した送り出し（読み込みの箱）。一度目の送り出しの後処理で振り返りの要求を
  // 一度だけ失敗させると（製品は露台に戻って LM の失敗を報せる）、後処理の仕事が失敗のまま残る。タイトルからロードし直して同じ行き先を
  // 言うと、残った失敗の仕事に止められて露台に「もう一度」が出る。会話を閉じる要求を止めて箱を落ち着かせる。
  async 'sendoff-resumed'(ctx) {
    await freshPlay(ctx, null, async (play) => {
      const { page, product } = play;
      await walkToHub(play);
      product.script.failReflections = 1;
      await sayOnHub(play, product.hubLines.alchemy);
      await page.waitFor(`${HUB_SHOWN} && document.querySelector('#routing-hub-screen').innerText.includes('capture: scripted reflection failure') && document.querySelector('#terrace-opened').hidden && !document.querySelector('#routing-hub-input').disabled`, 'the failed post-processing on the hub', LM_WAIT_MS);
      if (product.script.failReflections !== 0) throw new Error('the scripted reflection failure was never asked for');
      play.steps.push('the first send-off post-processing failed (the hub reports it); load the slot again and say the destination again');
      await walkToHub(play);
      await sayOnHub(play, product.hubLines.alchemy);
      await page.waitFor(`${HUB_SHOWN} && !document.querySelector('#routing-hub-finalize-notice').hidden && document.querySelector('#terrace-opened').hidden`, 'the blocked post-processing notice', LM_WAIT_MS);
      await sleep(SETTLE_MS);
      play.steps.push('the send-off post-processing stopped; press もう一度');
      await page.click("document.querySelector('#routing-hub-finalize-retry')", 'もう一度');
      await sendoffRow(play, { row: 'alchemy-resumed', path: 'resumed → loading box', destination: 'alchemy', start: `(${CURTAIN_UP} || ${LOADING_ACTIVE})`, hold: '*/api/conversation/end', settled: 'box', arrived: DISPATCH_SCREENS.alchemy });
    });
    await writeSendoffTable(ctx);
  },
  // 区切り（タイトルへ）の道: 幕が夜に満ち、その下で区切りの読み込みが走り、タイトルの画面が出たところで幕が薄れて上がる。比べる
  // 相手はタイトルの画面が出て幕が上がりきった後の姿。
  async 'sendoff-wrap-up'(ctx) {
    await freshPlay(ctx, null, async (play) => {
      await walkToHub(play);
      await sayOnHub(play, play.product.hubLines[WRAP_UP_DESTINATION]);
      await sendoffRow(play, { row: 'title-wrap-up', path: 'in-turn → wrap-up (title)', destination: WRAP_UP_DESTINATION, start: CURTAIN_UP, hold: null, settled: 'title', arrived: 'title' });
    });
    await writeSendoffTable(ctx);
  },
  // 動きを減らす設定の送り出し（一本）。
  async 'sendoff-reduced'(ctx) {
    await freshPlay(ctx, null, (play) => inTurnSendoff(play, { row: 'alchemy-reduced', destination: 'alchemy', reduceMotion: true }));
    await writeSendoffTable(ctx);
  }
};

const SCENES = {
  async names(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const destinations = page.hubStarts.at(-1)?.routing_destinations;
    if (!Array.isArray(destinations) || destinations.length === 0) throw new Error('no routing_destinations in the hub start response');
    const cells = [];
    let cellSize = null;
    for (let from = 0; from < destinations.length; from += 3) {
      const group = destinations.slice(from, from + 3);
      await guideSays(ctx, sentenceWith(group.map((destination) => destination.label)));
      const { names } = await page.js(LAST_ROW_NAMES);
      if (names.length !== group.length) throw new Error(`expected ${group.length} names in the guide's row, got ${names.length}`);
      for (const name of names) {
        await touchName(ctx, name);
        const { state, bytes } = await ctx.shoot(`name-${name.id}`, `名「${name.label}」に触れて窓が開いた姿`, { destination: name.id, label: name.label });
        requireOneWindow(state, `name-${name.id}`);
        const expected = destinations.find((destination) => destination.id === name.id);
        if (!expected || expected.label !== name.label) throw new Error(`the name ${name.label} does not belong to ${name.id}`);
        const halo = 40;
        const clip = { x: Math.round(state.window.box.x) - halo, y: Math.round(state.window.box.y) - halo, width: Math.round(state.window.box.width) + halo * 2, height: Math.round(state.window.box.height) + halo * 2 };
        const crop = nativeImage.createFromBuffer(bytes).crop(clip).toPNG();
        await fs.writeFile(path.join(ctx.options.out, `window-${name.id}.png`), crop);
        if (cellSize !== null && (cellSize.width !== clip.width || cellSize.height !== clip.height)) throw new Error(`the window for ${name.id} is ${clip.width}x${clip.height}, not ${cellSize.width}x${cellSize.height}`);
        cellSize = { width: clip.width, height: clip.height };
        cells.push({ file: `window-${name.id}.png`, caption: `${name.id}（${name.label}）・明るさ ${ctx.shots.at(-1).windowMeanLuma}` });
        await leaveName(ctx);
      }
    }
    const shotIds = new Set(ctx.shots.map((shot) => shot.destination));
    if (ctx.shots.length !== destinations.length || shotIds.size !== destinations.length) throw new Error(`took ${ctx.shots.length} name shots (${shotIds.size} destinations) for ${destinations.length} routing_destinations`);
    const sizes = new Set(ctx.shots.map((shot) => `${shot.window.box.width}x${shot.window.box.height}`));
    if (sizes.size !== 1) throw new Error(`the windows differ in size: ${[...sizes].join(' ')}`);
    await writeSheet(ctx.options.out, cells, cellSize);
    const lumas = ctx.shots.map((shot) => [shot.destination, shot.windowMeanLuma]).sort((a, b) => a[1] - b[1]);
    ctx.measures.push({ scene: 'names', routingDestinations: destinations.length, nameShots: ctx.shots.length, windowSize: [...sizes][0], windowMeanLumaDarkToBright: lumas });
    console.log(`names: routing_destinations ${destinations.length} = name shots ${ctx.shots.length}; window ${[...sizes][0]}; luma dark→bright ${JSON.stringify(lumas)}`);
  },
  async paragraph(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const labels = Object.fromEntries(page.hubStarts.at(-1).routing_destinations.map((destination) => [destination.id, destination.label]));
    await guideSays(ctx, `そうですね、いろいろ考えてみたのですが、今週は少し腰を据えて取り組めることがいいのではないかと思うんです。たとえば${labels.alchemy}でしたら、先週あつめた素材をそのまま活かせますし、仕上がりを見ながらゆっくり手を動かせます。急がなくて大丈夫ですから、気が向いたら声をかけてくださいね。`);
    let row = await page.js(LAST_ROW_NAMES);
    if (row.names.length !== 1 || row.lines < 4) throw new Error(`the long paragraph has ${row.names.length} names over ${row.lines} lines`);
    await touchName(ctx, row.names[0]);
    requireOneWindow((await ctx.shoot('paragraph-long', `長い段落（${row.lines} 行・${row.characters} 字）の中の名「${row.names[0].label}」に触れた姿`, { paragraphLines: row.lines })).state, 'paragraph-long');
    await leaveName(ctx);
    await guideSays(ctx, `体を動かしたい気分でしたら${labels.training}がいいですし、静かに過ごしたいのでしたら${labels.homunculus}にこもるのも素敵だと思います。`);
    row = await page.js(LAST_ROW_NAMES);
    if (row.names.length !== 2) throw new Error(`the two-name paragraph has ${row.names.length} names`);
    await touchName(ctx, row.names[0]);
    requireOneWindow((await ctx.shoot('paragraph-two-first', `同じ段落に名が二つ: 一つ目「${row.names[0].label}」に触れた姿`)).state, 'paragraph-two-first');
    // 一つ目から二つ目へ直に移る（前の窓が閉じてから次が開く）。
    await sleep(POINTER_REST_MS);
    const mark = await page.js('window.__placeTimeline.length');
    await page.moveTo(row.names[1].x, row.names[1].y);
    await page.waitFor(`${WINDOW_OPEN} && ${PLACE_WINDOW}.querySelector('img').getAttribute('src').includes('atelier')`, 'the second window', 10000);
    await sleep(POINTER_REST_MS);
    const moved = (await page.js('window.__placeTimeline')).slice(mark).filter((entry) => entry.kind === 'window').map((entry) => `${entry.t}:${entry.value}`);
    requireOneWindow((await ctx.shoot('paragraph-two-second', `同じ段落に名が二つ: 二つ目「${row.names[1].label}」に触れた姿`, { windowChangesFromFirstToSecond: moved })).state, 'paragraph-two-second');
    await leaveName(ctx);
    // 動きを減らす設定: 名に触れた次の描画でもう開いた姿で、動きは走っていない。
    await page.reduceMotion(true);
    const before = await page.js('window.__placeTimeline.length');
    await page.moveTo(row.names[0].x, row.names[0].y);
    await page.waitFor(`!${PLACE_WINDOW}.hidden && ${PLACE_WINDOW}.dataset.window === 'opening'`, 'the reduced-motion window', 10000);
    const reduced = await page.js(`({ animations: ${PLACE_WINDOW}.getAnimations().length, opacity: getComputedStyle(${PLACE_WINDOW}).opacity, transform: getComputedStyle(${PLACE_WINDOW}).transform, media: matchMedia('(prefers-reduced-motion: reduce)').matches })`);
    if (reduced.animations !== 0 || reduced.opacity !== '1' || reduced.transform !== 'none' || !reduced.media) throw new Error(`reduced motion: the window still moves ${JSON.stringify(reduced)}`);
    await sleep(POINTER_REST_MS);
    requireOneWindow((await ctx.shoot('reduced-motion', `動きを減らす設定で名「${row.names[0].label}」に触れて窓が開いた姿`, { reducedMotion: reduced })).state, 'reduced-motion');
    await page.moveTo(4, 4);
    await page.waitFor(WINDOW_CLOSED, 'the reduced-motion window closed', 10000);
    const closing = (await page.js('window.__placeTimeline')).slice(before).filter((entry) => entry.kind === 'window').map((entry) => `${entry.t}:${entry.value}`);
    ctx.measures.push({ scene: 'paragraph', reducedMotion: reduced, reducedMotionWindowChanges: closing, firstToSecondWindowChanges: moved });
    console.log(`paragraph: first→second ${JSON.stringify(moved)}; reduced motion ${JSON.stringify(reduced)} ${JSON.stringify(closing)}`);
    await page.reduceMotion(false);
  },
  async longest(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const labels = page.hubStarts.at(-1).routing_destinations.map((destination) => destination.label);
    // 言葉の欄に収まる最も長い段落: 案内人の行の写しを言葉の列に仮に置いて高さを測り、欄の見える高さに収まる限り文を足す。
    const sentences = await page.js(`(() => {
      const labels = ${JSON.stringify(labels)};
      const stream = document.querySelector('#routing-hub-message-stream');
      const probe = ${LAST_GUIDE_ROW}.cloneNode(true);
      probe.classList.remove('pop-in');
      const paragraph = probe.querySelector('.message-bubble p');
      stream.append(probe);
      const room = stream.clientHeight - parseFloat(getComputedStyle(stream).paddingTop);
      let count = 0;
      const textOf = (n) => Array.from({ length: n }, (_, i) => labels[i % labels.length] + 'へ行くのもいいですね。').join('');
      for (;;) {
        paragraph.textContent = textOf(count + 1);
        if (probe.getBoundingClientRect().height > room) break;
        count += 1;
      }
      probe.remove();
      return { count, room, text: textOf(count) };
    })()`);
    await guideSays(ctx, sentences.text);
    const row = await page.js(LAST_ROW_NAMES);
    const fits = await page.js(`(() => { const s = document.querySelector('#routing-hub-message-stream').getBoundingClientRect(); const r = ${LAST_GUIDE_ROW}.getBoundingClientRect(); return { rowTop: r.top, rowBottom: r.bottom, columnTop: s.top, columnBottom: s.bottom, inside: r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5 }; })()`);
    if (!fits.inside) throw new Error(`the longest paragraph does not fit the words column: ${JSON.stringify(fits)}`);
    const byLine = new Map();
    for (const name of row.names) if (!byLine.has(name.line)) byLine.set(name.line, name);
    const linesWithoutName = Array.from({ length: row.lines }, (_, line) => line).filter((line) => !byLine.has(line));
    const perLine = [];
    for (const [line, name] of [...byLine].sort((a, b) => a[0] - b[0])) {
      await touchName(ctx, name);
      const { state } = await ctx.shoot(`longest-line-${String(line + 1).padStart(2, '0')}`, `最も長い段落（${row.lines} 行）の ${line + 1} 行目の名「${name.label}」に触れた姿`, { line: line + 1, nameY: Math.round(name.y) });
      requireOneWindow(state, `longest line ${line + 1}`);
      perLine.push({ line: line + 1, label: name.label, nameY: Math.round(name.y), window: state.window.box, wordPieces: state.wordPieces, overlappingWordPieces: state.overlappingWordPieces });
      await leaveName(ctx);
    }
    ctx.measures.push({ scene: 'longest', sentences: sentences.count, characters: row.characters, lines: row.lines, linesTouched: perLine.length, linesWithoutName, fits, wordsColumn: ctx.shots.at(-1).wordsColumn, perLine });
    console.log(`longest: ${sentences.count} sentences, ${row.characters} characters, ${row.lines} lines, touched ${perLine.length} lines, lines without a name ${JSON.stringify(linesWithoutName)}, overlaps ${perLine.reduce((sum, entry) => sum + entry.overlappingWordPieces, 0)}`);
  },
  async bounds(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const labels = Object.fromEntries(page.hubStarts.at(-1).routing_destinations.map((destination) => [destination.id, destination.label]));
    await guideSays(ctx, `体を動かしたい気分でしたら${labels.training}がいいですし、静かに過ごしたいのでしたら${labels.homunculus}にこもるのも素敵だと思います。`);
    const sizes = [];
    for (const name of (await page.js(LAST_ROW_NAMES)).names) {
      await touchName(ctx, name);
      const { state } = await ctx.shoot(`bounds-${page.viewport.width}x${page.viewport.height}-${name.id}`, `画面 ${page.viewport.width}x${page.viewport.height} で上の行の名「${name.label}」（名の高さ y=${Math.round(name.y)}）に触れた姿`, { nameY: Math.round(name.y) });
      requireOneWindow(state, `bounds ${name.id}`);
      sizes.push(state.window.box);
      await leaveName(ctx);
    }
    ctx.measures.push({ scene: 'bounds', viewport: [page.viewport.width, page.viewport.height], guideFaceBandBottom: ctx.shots.at(-1).guideFaceBandBottom, windowBoxes: sizes });
    console.log(`bounds ${page.viewport.width}x${page.viewport.height}: window ${sizes[0].width}x${sizes[0].height}`);
  },
  ...SENDOFF_SCENES
};

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runScene(options, name, viewport) {
  const product = await startProduct(options.repoRoot, null);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`LM failed: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard, viewport);
  const ctx = { scene: name, options, product, page, guard, steps: [], shots: [], measures: [], sendoffRows: [], expectedPageErrors: [] };
  ctx.shoot = createShooter(ctx);
  const started = Date.now();
  let watchdog;
  try {
    await Promise.race([
      SCENES[name](ctx),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`scene ${name} exceeded ${SCENE_LIMIT_MS / 1000} s`)), SCENE_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    guard();
    const unexpected = page.pageErrors.filter((message) => !ctx.expectedPageErrors.some((expected) => message.includes(expected)));
    if (unexpected.length > 0) throw new Error(`renderer errors: ${unexpected.join(' | ')}`);
    const timeline = await page.js('window.__placeTimeline ?? []');
    const seconds = (Date.now() - started) / 1000;
    console.log(`scene ${name} (${viewport.width}x${viewport.height}) done in ${seconds.toFixed(1)} s`);
    return { scene: name, viewport, seconds, steps: ctx.steps, shots: ctx.shots, measures: ctx.measures, sendoffRows: ctx.sendoffRows, timeline, pageErrors: page.pageErrors, lmRequests: product.lmLog };
  } catch (error) {
    console.log(`scene ${name} stopped after: ${ctx.steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
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
  if (existing.length > 0) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const started = Date.now();
  const scenes = [];
  const failed = [];
  for (const name of options.scenes) {
    for (const viewport of name === 'bounds' ? BOUNDS_VIEWPORTS : [VIEWPORT]) {
      try {
        scenes.push(await runScene(options, name, viewport));
      } catch (error) {
        console.log(`SCENE FAILED ${name}: ${error.stack ?? error.message}`);
        failed.push(name);
      }
    }
  }
  const manifest = { viewport: VIEWPORT, lm: 'fixture', seconds: (Date.now() - started) / 1000, scenes, failed };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${manifest.seconds.toFixed(1)} s (failed: ${failed.join(',') || '-'})`);
  if (failed.length > 0) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.on('window-all-closed', () => {});
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('FAILED', error.message);
    app.exit(1);
  });
