// 三つの戻り道（会話を終えて露台へ・週を締める・実践から露台へ）と、露台の上でやり直す二本（「もう一度」・卒業の週の「今日は
// ここまで」）の待ちの姿を、製品の通常の道で 1440x900 に撮る手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/returnLoadingVeilCapture.mjs --repo-root <絶対パス> --out <絶対パス> --variant <after|before> --scenes <名,名,...> --lm <fixture|絶対パス> [--before <絶対パス>]
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い（--before だけは after で並びの一枚を作るときに渡す）。
// --repo-root の製品（app/src・app/public・data・content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・
// 案内人 fallen_star）の上で、この process の中に起こす。
// --lm fixture は固定応答の LM（FIXTURE の表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。--lm に LM Studio の設定
// （lmstudio.json）の絶対パスを渡すと本物の LM で撮る: 設定の写しの base_url をこの process の中の中継に替え、中継は要求を
// 設定の base_url へそのまま流して、要求ごとの model と応答の status を記録する（2xx 以外の応答で撮影ごと止める）。
// --out は無いか空であること。撮った png（薄れ替わりのコマは jpg）と、場面ごとの記録（各枚の待ちの紋の段・層の段・見えている箱の有無・
// 露台の言葉の列・紋と層の段の変わり目の時刻の列・要求を止めていた区間・LM の要求）を <out>/manifest.json に書く。
//
// 待ちの姿は、その待ちが覆う要求を CDP Fetch の Request 段で止めている間に撮る。
// variant:
//   after  — この変更の入った製品。待っている間（要求の区切りごと）・薄れ替わりのコマの連なり・露台に着いた姿を撮る。
//            --before を渡すと、場面ごとに before の箱（左）と after の待ち（右）を並べた一枚を書く。
//   before — この変更の前の製品（claim した base を書き出した木）。場面ごとに今の箱を一枚だけ撮る。
// 場面（scene）:
//   errand-end     会話を終える（依頼の会話・昼の絵）。POST /api/conversation/end → hub start → refresh。
//   week-close     週を締める（調合室を出る・昼の絵）。hub start → refresh。
//   dungeon-return 実践から戻る（同行者と潜って撤退した結果の画面）。POST /api/dungeon/finalize → hub start → refresh。
//   retry          会話の無い露台の「もう一度」（調合室を出た hub start を落として着地させる）。
//   graduation     卒業の週の露台の「今日はここまで」（POST /api/debug/weeks で週を 49 にしてから入り直す）。
//   terrace        露台の長いやり取り（7 往復）と、送り出しの幕が開いた瞬間（after だけ）。この二つの瞬間は、動きを止めたまま
//                  楕円なしと、会話の画面（conversationLayer.css）の言葉ごとの夜の楕円を撮影の中だけで露台の言葉に重ねた
//                  楕円あり（-ellipse）を続けて撮る。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
// 本物の LM の一歩（露台の一往復・会話の始まり）が収まる待ち。
const LM_WAIT_MS = 300000;
const SCENE_LIMIT_MS = 1800000;
// 薄れ替わりのコマの間（層の薄れ 1.2s に 8 コマ前後）。コマは書き出しの速い JPEG で撮る（1440x900 の PNG は一枚 300ms を超え、
// 1.2s に 5 コマ入らない）。
const LEAVE_FRAME_MS = 150;
const LEAVE_FRAME_JPEG_QUALITY = 85;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--variant', '--scenes', '--lm', '--before'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of ['--repo-root', '--out', '--variant', '--scenes', '--lm']) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  const variant = parsed['--variant'];
  if (variant !== 'after' && variant !== 'before') throw new Error(`--variant must be after or before, got ${JSON.stringify(variant)}`);
  if (parsed['--before'] !== undefined && variant !== 'after') throw new Error('--before is taken only with --variant after');
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) {
    if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
    if (variant === 'before' && scene === 'terrace') throw new Error('the terrace scene is taken only with --variant after');
  }
  for (const key of ['--repo-root', '--out', '--before']) {
    if (parsed[key] !== undefined && !path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  const lm = parsed['--lm'];
  if (lm !== 'fixture' && !path.isAbsolute(lm)) throw new Error(`--lm must be fixture or an absolute path to lmstudio.json, got ${lm}`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], variant, scenes, lm, before: parsed['--before'] ?? null };
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
// 露台の雑談（行き先を決めない言葉）。
const TERRACE_SMALL_TALK = [
  '今日は風が気持ちいいね。',
  '昨日の授業、少し難しかったな。',
  'この露台から見える星、好きなんだ。',
  '最近、寮の食堂のスープがおいしいんだよ。',
  '図書館で面白そうな本を見つけたんだ。',
  '来週の予定、まだ何も決めていないんだ。',
  'もう少しだけ、ここで話していてもいい？'
];

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

// 本物の LM への中継: 要求をそのまま upstream（設定の base_url）へ流し、応答をそのまま返す。要求ごとに path・model・stream・
// status・秒を lmLog に残し、2xx 以外と届かなかった要求は lmFailures に積む。
function createRelayLmServer(upstreamBase, lmFailures, lmLog) {
  const upstream = new URL(upstreamBase.endsWith('/') ? upstreamBase : `${upstreamBase}/`);
  if (upstream.protocol !== 'http:') throw new Error(`relay: only an http base_url is relayed, got ${upstreamBase}`);
  return createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let model = null;
    let stream = null;
    if (body.length > 0) {
      const parsed = JSON.parse(body.toString('utf8'));
      model = parsed.model ?? null;
      stream = parsed.stream === true;
    }
    const target = new URL(req.url.replace(/^\/v1\//, ''), upstream);
    const started = Date.now();
    const entry = { method: req.method, path: target.pathname, model, stream, status: null, seconds: null };
    lmLog.push(entry);
    const headers = { ...req.headers, host: target.host };
    delete headers['content-length'];
    if (body.length > 0) headers['content-length'] = String(body.length);
    const forward = httpRequest(target, { method: req.method, headers }, (upstreamRes) => {
      entry.status = upstreamRes.statusCode;
      if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
        lmFailures.push(`${req.method} ${target.pathname} (${model}) answered ${upstreamRes.statusCode}`);
        console.log(`relay-lm ${upstreamRes.statusCode}: ${req.method} ${target.pathname} (${model})`);
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => { entry.seconds = (Date.now() - started) / 1000; });
    });
    forward.on('error', (error) => {
      lmFailures.push(`${req.method} ${target.pathname} (${model}) did not reach ${upstream.host}: ${error.code ?? error.message}`);
      console.log(`relay-lm unreachable: ${error.code ?? error.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `relay: ${error.code ?? error.message}` }));
    });
    forward.end(body);
  });
}

// --lm の設定: 'fixture' か、本物の LM の設定（lmstudio.json の中身と upstream の base_url）。
async function readLmSetting(lm) {
  if (lm === 'fixture') return 'fixture';
  const config = JSON.parse(await fs.readFile(lm, 'utf8'));
  if (typeof config.base_url !== 'string' || typeof config.chat_model !== 'string' || typeof config.reflection_model !== 'string') {
    throw new Error(`--lm ${lm}: base_url, chat_model and reflection_model must be strings`);
  }
  return { config, baseUrl: config.base_url };
}

// 場面ごとに一つ: 一時のセーブ・LM（固定応答か本物への中継）・製品サーバー。lmFailures は撮影を止める LM の失敗。
async function startProduct(repoRoot, lmSetting) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'return-veil-capture-'));
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
    await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    const lmServer = lmSetting === 'fixture'
      ? createFixtureLmServer(createFixtureLm(hubLines), lmFailures, lmLog)
      : createRelayLmServer(lmSetting.baseUrl, lmFailures, lmLog);
    const lmPort = await listen(lmServer);
    closers.push(() => closeServer(lmServer));
    const lmBase = `http://${HOST}:${lmPort}/v1`;
    await writeJson(root, 'app/config/lmstudio.json', lmSetting === 'fixture'
      ? {
          provider: 'lmstudio',
          base_url: lmBase,
          chat_model: FIXTURE_CHAT_MODEL,
          reflection_model: FIXTURE_REFLECTION_MODEL,
          timeout_ms: 120000,
          stream: true,
          thinking_effort: null,
          mock_provider_enabled: false
        }
      : { ...lmSetting.config, base_url: lmBase });
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
// 待ちの記録: 読み込みの箱の星座の線の本数と、層と待ちの紋の段の変わり目を、ページの時計で残す。
const INSTALL_TIMELINE = `(() => {
  if (window.__veilTimeline) return true;
  window.__veilTimeline = [];
  const record = (kind, value) => window.__veilTimeline.push({ t: Date.now(), kind, value });
  const watch = (selector, attribute, kind) => {
    const node = document.querySelector(selector);
    if (!node) return;
    new MutationObserver(() => record(kind, node.getAttribute(attribute))).observe(node, { attributes: true, attributeFilter: [attribute] });
  };
  watch('#wait-sigil', 'data-wait-sigil', 'sigil-step');
  watch('#wait-sigil', 'hidden', 'sigil-hidden');
  watch('#place-veil', 'data-veil', 'veil-step');
  watch('#place-veil', 'hidden', 'veil-hidden');
  watch('#academy-loading-constellation', 'data-constellation-revealed', 'loader-lines');
  return true;
})()`;

// いまの待ちの姿: 層の段・待ちの紋の段（回っている turning／薄れている leaving／出ていない null）・読み込みの箱が見えているか・いま出ている画面。
const WAIT_STATE = `(() => {
  const veil = document.querySelector('#place-veil');
  const box = document.querySelector('#academy-loading-screen .academy-loading-copy');
  const loaderActive = document.body.classList.contains('academy-loading-screen-active');
  const boxOpacity = box && loaderActive && getComputedStyle(box).display !== 'none' ? Number(getComputedStyle(box).opacity) : 0;
  return {
    screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
    veil: veil && !veil.hidden ? { step: veil.dataset.veil ?? null, ground: veil.dataset.veilGround ?? null, dim: veil.dataset.veilDim ?? null, opacity: Number(getComputedStyle(veil).opacity), sigil: document.querySelector('#wait-sigil').hasAttribute('hidden') ? null : document.querySelector('#wait-sigil').dataset.waitSigil ?? 'turning' } : null,
    loaderActive,
    loaderLines: loaderActive ? Number(document.querySelector('#academy-loading-constellation').dataset.constellationRevealed ?? 0) : null,
    boxVisible: boxOpacity > 0.05,
    boxText: boxOpacity > 0.05 ? box.textContent.replace(/\\s+/g, ' ').trim() : null,
    hubWords: [...document.querySelectorAll('#routing-hub-message-stream .chat-message')].map((el) => ({ kind: [...el.classList].find((name) => name.endsWith('-message') && name !== 'chat-message') ?? null, text: (el.querySelector('.message-bubble')?.textContent ?? '').replace(/\\s+/g, ' ').trim() }))
  };
})()`;

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
  // CDP Fetch: 止める要求の規則。paused の要求は規則の decide が 'hold' なら持ち、'fail' なら落とし、'pass' なら通す。
  const rules = [];
  const holds = [];
  cdp.on('message', (event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const rule = rules.find((entry) => !entry.done && params.request.url.includes(entry.fragment) && (!entry.method || entry.method === params.request.method));
    if (!rule) {
      send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    rule.decide(params).then((verdict) => {
      if (verdict === 'pass') return send('Fetch.continueRequest', { requestId: params.requestId });
      rule.done = true;
      if (verdict === 'fail') return send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' }).then(() => rule.resolve(params));
      rule.requestId = params.requestId;
      rule.heldAt = Date.now();
      rule.resolve(params);
      return null;
    }).catch((error) => console.log(`fetch rule error: ${error.message}`));
  });
  async function syncFetch() {
    const active = rules.filter((entry) => !entry.done || entry.requestId);
    if (active.length === 0) await send('Fetch.disable');
    else await send('Fetch.enable', { patterns: active.map((entry) => ({ urlPattern: `*${entry.fragment}*`, requestStage: 'Request' })) });
  }
  const page = {
    js,
    pageErrors,
    holds,
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
        await sleep(30);
      }
      throw new Error(`timed out waiting for ${label} (page: ${JSON.stringify(await js(WAIT_STATE).catch(() => null))})`);
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
        await sleep(20);
      }
    },
    // ページの動き（CSS の animation・transition・Web Animations）の再生の速さ。0 で止め、1 で戻す。
    async setPlaybackRate(rate) {
      await send('Animation.enable');
      await send('Animation.setPlaybackRate', { playbackRate: rate });
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    // fragment を含む要求（method 指定可）を decide(params) の答えで止める・落とす・通す。
    async hold(fragment, { method = null, decide = async () => 'hold' } = {}) {
      let resolve;
      const paused = new Promise((r) => { resolve = r; });
      const rule = { fragment, method, decide, resolve, done: false, requestId: null, heldAt: null };
      rules.push(rule);
      await syncFetch();
      return {
        fragment,
        paused,
        async release() {
          await paused;
          if (rule.requestId) {
            holds.push({ fragment, from: rule.heldAt, to: Date.now() });
            await send('Fetch.continueRequest', { requestId: rule.requestId });
          }
          rule.requestId = null;
          rules.splice(rules.indexOf(rule), 1);
          await syncFetch();
        }
      };
    },
    async png(clip = null) {
      const { data } = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    async jpeg(quality) {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false });
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
const VEIL_WAITING = `(${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'waiting')`;
const COVER_UP = `(${LOADING_ACTIVE} || ${VEIL_WAITING})`;
const screenSettled = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP} && ${motionSettled(`#${id}`)} && ${IMAGES_LOADED(`#${id}`)}`;
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;

async function walkToHub(ctx) {
  const { page, product, steps } = ctx;
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await page.js(INSTALL_TIMELINE);
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await awaitHub(ctx);
  steps.push('title → ロード → slot → terrace');
}

async function awaitHub({ page }) {
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled', 30000);
  await sleep(SETTLE_MS);
}

async function sayOnHub({ page, steps }, line) {
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  steps.push(`say on the terrace: ${line}`);
}

async function dispatchTo(ctx, id, screenId) {
  await walkToHub(ctx);
  await sayOnHub(ctx, ctx.product.hubLines[id]);
  await ctx.page.waitFor(screenSettled(screenId), `${screenId} settled`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
  ctx.steps.push(`dispatched to ${id}`);
}

// 待ちの下で次の要求を止める: 待ち（場所の絵の上・読み込みの箱）が上がっている間だけ止める。
const holdUnderCover = (page) => async () => ((await page.js(COVER_UP)) ? 'hold' : 'pass');

// ── 撮る ───────────────────────────────────────────────────────────────────────────────────────────────────
function createShooter(ctx) {
  return async function shoot(file, note) {
    const target = path.join(ctx.options.out, `${file}.png`);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
    await ctx.page.moveAway();
    const state = await ctx.page.js(WAIT_STATE);
    const bytes = await ctx.page.png();
    if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${file}.png is not ${VIEWPORT.width}x${VIEWPORT.height}`);
    await fs.writeFile(target, bytes);
    const repeatedHubWords = repeatedWords(state.hubWords);
    ctx.shots.push({ file: `${file}.png`, note, t: Date.now(), ...state, repeatedHubWords });
    console.log(`shot ${file}.png — ${note} ${JSON.stringify({ veil: state.veil, loaderLines: state.loaderLines, boxVisible: state.boxVisible, screens: state.screens, hubWords: state.hubWords.length, repeatedHubWords })}`);
    return state;
  };
}

// 露台の言葉の列で、同じ種類の同じ言葉が二度以上出ているもの（{ kind, text, count } の列）。
function repeatedWords(words) {
  const counts = new Map();
  for (const word of words) {
    const key = `${word.kind}\u0000${word.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([key, count]) => {
    const [kind, text] = key.split('\u0000');
    return { kind, text, count };
  });
}

// 会話の画面（conversationLayer.css）の言葉ごとの夜の楕円を、撮影の中だけで露台の言葉に重ねる <style>。楕円の値は製品の
// スタイルシートの規則（border-image が楕円の radial-gradient の規則）から読む（写しを持たない）。規則がちょうど一つで無ければ止める。
const OVERLAY_CONVERSATION_ELLIPSE = `(() => {
  const found = [];
  for (const sheet of document.styleSheets) {
    if (!sheet.href || !sheet.href.endsWith('/conversationLayer.css')) continue;
    for (const rule of sheet.cssRules) {
      if (rule.selectorText && rule.selectorText.endsWith('.conversation-day-message-stream .chat-message .message-bubble') && rule.style.borderImageSource.startsWith('radial-gradient(')) found.push(rule.style.borderImage);
    }
  }
  if (found.length !== 1) throw new Error('conversation ellipse rules found: ' + found.length);
  const style = document.createElement('style');
  style.id = 'capture-conversation-ellipse';
  style.textContent = '#routing-hub-screen .routing-hub-message-stream .chat-message .message-bubble { border-image: ' + found[0] + '; }';
  document.head.append(style);
  return found[0];
})()`;

// 同じ瞬間を楕円なし（file）と楕円あり（file-ellipse）で撮る。二枚の間はページの動きを止めておく。
async function shootEllipsePair(ctx, file, note) {
  const { page } = ctx;
  await page.setPlaybackRate(0);
  try {
    await ctx.shoot(file, note);
    const ellipse = await page.js(OVERLAY_CONVERSATION_ELLIPSE);
    ctx.steps.push(`overlay (capture only) the conversation ellipse: border-image ${ellipse}`);
    await page.js("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await ctx.shoot(`${file}-ellipse`, `${note}・会話の画面と同じ言葉ごとの夜の楕円を撮影の中だけで重ねた姿`);
    await page.js("document.querySelector('#capture-conversation-ellipse').remove()");
  } finally {
    await page.setPlaybackRate(1);
  }
}

// 待ちの終わりから着くまで: 層が薄れはじめる直前の一枚から、層が下りて行き先が出揃うまでを撮り続ける（after だけ）。
async function shootLeaving(ctx, prefix) {
  const { page } = ctx;
  await page.waitFor(`${VEIL_UP} && document.querySelector('#place-veil').dataset.veil !== 'waiting'`, `${prefix}: the wait ending`, LM_WAIT_MS);
  const frames = [];
  const started = Date.now();
  for (let index = 0; index < 60; index += 1) {
    const due = started + index * LEAVE_FRAME_MS;
    if (Date.now() < due) await sleep(due - Date.now());
    const state = await page.js(WAIT_STATE);
    const bytes = await page.jpeg(LEAVE_FRAME_JPEG_QUALITY);
    const file = `${prefix}-leave-${String(index).padStart(2, '0')}.jpg`;
    await fs.writeFile(path.join(ctx.options.out, file), bytes);
    frames.push({ file, ms: Date.now() - started, veil: state.veil, screens: state.screens });
    if (state.veil === null) break;
  }
  if (frames.at(-1).veil !== null) throw new Error(`${prefix}: the veil was still up after ${frames.length} frames`);
  ctx.shots.push({ sequence: `${prefix}-leave`, frames });
  console.log(`${prefix}: ${frames.length} frames over ${frames.at(-1).ms} ms: ${frames.map((f) => `${f.ms}ms:${f.veil ? f.veil.opacity.toFixed(2) : 'gone'}`).join(' ')}`);
  if (frames.length < 5) throw new Error(`${prefix}: only ${frames.length} frames from the wait's end to the arrival`);
}

// 止めた要求の間に一枚: 待ちが上がるのを待ち、線が伸びきるのを待ってから撮る。
async function shootHeld(ctx, held, file, note) {
  await held.paused;
  await ctx.page.waitFor(COVER_UP, `${file}: the cover`, 30000);
  await sleep(ctx.options.variant === 'before' ? 1000 : 900);
  return ctx.shoot(file, note);
}

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
// 戻り道の待ちを撮る共通の段取り。startHeld は最初の要求を止めた規則（既に押した後）、prefix は file の頭。after は要求の区切り
// ごとに一枚（hub start・その後の refresh の GET /api/state を順に止める）、薄れ替わりの連なり、露台に着いた姿。before は箱を一枚。
// 次の要求の規則は、前の要求を止めている間に立てる（止めている間は次の要求が出ないので、取り違えない）。
async function shootReturnWait(ctx, { prefix, startHeld, startNote }) {
  const { page } = ctx;
  if (ctx.options.variant === 'before') {
    await shootHeld(ctx, startHeld, `${prefix}-box`, `今の箱（${startNote}）`);
    await startHeld.release();
    await awaitHub(ctx);
    return;
  }
  await shootHeld(ctx, startHeld, `${prefix}-wait-a`, `待っている間（${startNote}）`);
  let hub = startHeld;
  if (startHeld.fragment !== '/api/routing/hub/start') {
    hub = await page.hold('/api/routing/hub/start', { method: 'POST', decide: holdUnderCover(page) });
    await startHeld.release();
    await shootHeld(ctx, hub, `${prefix}-wait-b`, '待っている間（POST /api/routing/hub/start を止めている間）');
  }
  const state = await page.hold('/api/state', { method: 'GET', decide: async () => ((await page.js(VEIL_WAITING)) ? 'hold' : 'pass') });
  await hub.release();
  await shootHeld(ctx, state, `${prefix}-wait-c`, '待っている間（露台の支度の refresh の GET /api/state を止めている間）');
  await state.release();
  await shootLeaving(ctx, prefix);
  await awaitHub(ctx);
  await ctx.shoot(`${prefix}-arrived`, '露台に着いた姿');
}

const SCENES = {
  async 'errand-end'(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'errand', 'academy-errand-screen');
    await page.click("document.querySelector('#academy-errand-offers .academy-errand-card-button')", 'first errand card');
    await page.waitFor("document.querySelector('#conversation-day-screen.active') && !document.querySelector('#conversation-day-end').disabled && !document.querySelector('#conversation-day-send').disabled", 'errand conversation ready', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    const end = await page.hold('/api/conversation/end', { method: 'POST' });
    await page.click("document.querySelector('#conversation-day-end')", '会話を終える');
    ctx.steps.push('press 会話を終える (errand conversation)');
    await shootReturnWait(ctx, { prefix: 'errand-end', startHeld: end, startNote: 'POST /api/conversation/end を止めている間' });
  },
  async 'week-close'(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'alchemy', 'academy-alchemy-screen');
    const hub = await page.hold('/api/routing/hub/start', { method: 'POST' });
    await page.click("document.querySelector('#academy-alchemy-exit')", '調合室を出る');
    ctx.steps.push('press 調合室を出る');
    await shootReturnWait(ctx, { prefix: 'week-close', startHeld: hub, startNote: 'POST /api/routing/hub/start を止めている間' });
  },
  async 'dungeon-return'(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'dungeon', 'academy-dungeon-screen');
    await page.waitFor("!document.querySelector('#dungeon-dive').disabled", 'dive enabled');
    await page.click("document.querySelector('#dungeon-dive')", '潜る');
    await page.waitFor(`document.querySelector('#academy-dungeon-screen.active') && !${LOADING_ACTIVE} && document.querySelector('#dungeon-retreat-button')?.getBoundingClientRect().width > 0`, 'in the dungeon', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('#dungeon-retreat-button')", '撤退');
    await page.waitFor("document.querySelector('#dungeon-retreat-yes')?.getBoundingClientRect().width > 0", 'retreat dialog');
    await sleep(500);
    // 同行者の後片づけ（POST /api/dungeon/finalize）は結果が出た時点で裏で始まるので、撤退の前から止めておく。
    const finalize = await page.hold('/api/dungeon/finalize', { method: 'POST' });
    await page.click("document.querySelector('#dungeon-retreat-yes')", '撤退する');
    await page.waitFor("!document.querySelector('#dungeon-result-back').hidden && document.querySelector('#dungeon-result-back').getBoundingClientRect().width > 0", 'result back', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    const finalizeHeld = await Promise.race([finalize.paused.then(() => true), sleep(5000).then(() => false)]);
    if (!finalizeHeld) throw new Error('dungeon: no POST /api/dungeon/finalize after the companion run ended');
    await page.click("document.querySelector('#dungeon-result-back')", '戻る');
    ctx.steps.push('潜る（同行者）→ 撤退 → 戻る');
    await shootReturnWait(ctx, { prefix: 'dungeon-return', startHeld: finalize, startNote: 'POST /api/dungeon/finalize を止めている間' });
  },
  async retry(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'alchemy', 'academy-alchemy-screen');
    const failed = await page.hold('/api/routing/hub/start', { method: 'POST', decide: async () => 'fail' });
    await page.click("document.querySelector('#academy-alchemy-exit')", '調合室を出る');
    await failed.paused;
    await failed.release();
    ctx.steps.push('press 調合室を出る with POST /api/routing/hub/start failed by CDP Fetch');
    if (ctx.options.variant === 'after') {
      await page.waitFor(`${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'stopped'`, 'the wait sinking', 30000);
      await sleep(600);
      await ctx.shoot('retry-sinking', '露台の始まりの失敗: 待ちが夜へ沈む途中');
    }
    await page.waitFor(`document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-start-retry').hidden && !document.querySelector('#routing-hub-start-retry').disabled`, 'the conversationless terrace', 30000);
    await sleep(SETTLE_MS);
    await ctx.shoot('retry-landing', '会話の無い露台（もう一度の前）');
    const hub = await page.hold('/api/routing/hub/start', { method: 'POST' });
    await page.click("document.querySelector('#routing-hub-start-retry')", 'もう一度');
    ctx.steps.push('press もう一度');
    await shootHeld(ctx, hub, ctx.options.variant === 'before' ? 'retry-box' : 'retry-wait', '「もう一度」のあと POST /api/routing/hub/start を止めている間');
    await hub.release();
    await awaitHub(ctx);
    await ctx.shoot('retry-arrived', '露台（会話が始まった）');
  },
  async graduation(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const set = await page.js("fetch('/api/debug/weeks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elapsed_weeks: 49 }) }).then(async (r) => ({ status: r.status, body: await r.text() }))");
    if (set.status !== 200) throw new Error(`debug weeks: ${JSON.stringify(set)}`);
    ctx.steps.push('POST /api/debug/weeks {elapsed_weeks:49}');
    await walkToHub(ctx);
    const guide = await page.js('Boolean(document.querySelector("#routing-hub-screen.active"))');
    if (!guide) throw new Error('graduation: not on the terrace');
    const end = await page.hold('/api/conversation/end', { method: 'POST' });
    await page.click("document.querySelector('#routing-hub-end')", '今日はここまで');
    ctx.steps.push('press 今日はここまで (graduation guide week)');
    await shootHeld(ctx, end, ctx.options.variant === 'before' ? 'graduation-box' : 'graduation-wait', '卒業の週の「今日はここまで」のあと POST /api/conversation/end を止めている間');
    await end.release();
    await awaitHub(ctx);
    await ctx.shoot('graduation-arrived', '露台（案内の言葉の続き）');
  },
  async terrace(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    for (const line of TERRACE_SMALL_TALK) {
      await sayOnHub(ctx, line);
      await page.waitFor(`!document.querySelector('#routing-hub-input').disabled && ${motionSettled('#routing-hub-screen')}`, `reply to ${line}`, LM_WAIT_MS);
      await sleep(800);
    }
    await sleep(SETTLE_MS);
    await shootEllipsePair(ctx, 'terrace-long', `露台の長いやり取り（${TERRACE_SMALL_TALK.length} 往復）`);
    await sayOnHub(ctx, ctx.product.hubLines.alchemy);
    await page.waitFor("document.querySelector('#routing-hub-screen').classList.contains('terrace-is-opening')", 'the send-off opening', LM_WAIT_MS);
    await shootEllipsePair(ctx, 'sendoff-opening', '送り出しの幕が開いた瞬間（行き先の絵が露台の向こうで開きはじめた）');
    await page.waitFor("!document.querySelector('#terrace-opened').hidden", 'the send-off curtain', LM_WAIT_MS);
    await sleep(2800);
    await ctx.shoot('sendoff-filled', '送り出しの幕が画面を満たした姿');
    await page.waitFor(screenSettled('academy-alchemy-screen'), 'alchemy settled', LM_WAIT_MS);
  }
};

// ── 並びの一枚（before の箱 ‖ after の待ち） ─────────────────────────────────────────────────────────────────
const COMPARE_PAIRS = [
  ['errand-end', 'errand-end-box.png', 'errand-end-wait-a.png'],
  ['week-close', 'week-close-box.png', 'week-close-wait-a.png'],
  ['dungeon-return', 'dungeon-return-box.png', 'dungeon-return-wait-a.png'],
  ['retry', 'retry-box.png', 'retry-wait.png'],
  ['graduation', 'graduation-box.png', 'graduation-wait.png']
];

// 並べる頁は一時ディレクトリの file に書き、二枚は file:// で引く（数 MB の data: URL は窓ごと落ちる）。CDP は頁を load してから送る。
async function writeComparisons(options, scenes) {
  const written = [];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'return-veil-compare-'));
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, show: false });
  try {
    await win.loadURL('about:blank');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    for (const [scene, beforeFile, afterFile] of COMPARE_PAIRS) {
      if (!scenes.includes(scene)) continue;
      const left = new URL(`file://${path.join(options.before, beforeFile)}`).href;
      const right = new URL(`file://${path.join(options.out, afterFile)}`).href;
      const html = `<html><body style="margin:0;background:#000"><div style="display:flex;height:450px;margin-top:225px"><img id="l" style="width:720px;height:450px" src="${left}"><img id="r" style="width:720px;height:450px" src="${right}"></div></body></html>`;
      const page = path.join(scratch, `${scene}.html`);
      await fs.writeFile(page, html, 'utf8');
      await win.loadFile(page);
      await win.webContents.executeJavaScript("Promise.all([...document.images].map((img) => img.decode()))");
      const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 225, width: VIEWPORT.width, height: 450, scale: 1 } });
      const file = `${scene}-compare.png`;
      await fs.writeFile(path.join(options.out, file), Buffer.from(data, 'base64'));
      written.push({ file, left: `before/${beforeFile}`, right: afterFile });
      console.log(`compare ${file}`);
    }
  } finally {
    win.destroy();
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return written;
}

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runScene(options, lmSetting, name) {
  const product = await startProduct(options.repoRoot, lmSetting);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`LM failed: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], shots: [] };
  ctx.shoot = createShooter(ctx);
  const started = Date.now();
  let watchdog;
  try {
    await Promise.race([
      SCENES[name](ctx),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`scene ${name} exceeded ${SCENE_LIMIT_MS / 1000} s`)), SCENE_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    guard();
    const timeline = await page.js('window.__veilTimeline ?? []');
    const seconds = (Date.now() - started) / 1000;
    console.log(`scene ${name} done in ${seconds.toFixed(1)} s`);
    return { scene: name, seconds, steps: ctx.steps, shots: ctx.shots, holds: page.holds, timeline, pageErrors: page.pageErrors, lmRequests: product.lmLog };
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
  const lmSetting = await readLmSetting(options.lm);
  await app.whenReady();
  const started = Date.now();
  const scenes = [];
  const failed = [];
  for (const name of options.scenes) {
    try {
      scenes.push(await runScene(options, lmSetting, name));
    } catch (error) {
      console.log(`SCENE FAILED ${name}: ${error.stack ?? error.message}`);
      failed.push(name);
    }
  }
  const comparisons = options.before ? await writeComparisons(options, options.scenes) : [];
  const lm = lmSetting === 'fixture' ? 'fixture' : { base_url: lmSetting.baseUrl, chat_model: lmSetting.config.chat_model, reflection_model: lmSetting.config.reflection_model };
  const manifest = { variant: options.variant, repoRoot: options.repoRoot, viewport: VIEWPORT, lm, seconds: (Date.now() - started) / 1000, scenes, comparisons, failed };
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
