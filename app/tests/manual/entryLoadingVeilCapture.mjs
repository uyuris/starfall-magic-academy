// 行き先へ入る道（札の画面・実践・談話室・競売場）と、ロード・新しいゲームで露台へ入る道行きの待ちの姿を、製品の通常の道で
// 1440x900 に撮る手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/entryLoadingVeilCapture.mjs --repo-root <絶対パス> --out <絶対パス> --variant <after|before> --scenes <名,名,...> [--before <絶対パス>]
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い（--before だけは after で並びの一枚を作るときに渡す）。
// --repo-root の製品（app/src・app/public・data・content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・
// 案内人 fallen_star）の上で、この process の中に起こす。LM は固定応答（FIXTURE の表の閉じた集合）で、知らない要求は 500 にして
// 撮影ごと止める。--out は無いか空であること。撮った png（コマの連なりは jpg）と、場面ごとの記録（各枚の待ちの紋の段・層の段・
// 幕と箱と道行きの字の見え方・紋と層の段の変わり目の時刻の列・要求を止めていた区間）を <out>/manifest.json に書く。
//
// 待ちの姿は、その待ちが覆う要求を CDP Fetch の Request 段で止めている間に撮る。
// variant:
//   after  — この変更の入った製品。送り出しの幕が出てから（実践の「潜る」は押してから）行き先の画面に着くまでをコマの連なりで
//            撮り続け、要求を止めている間に待っている姿を一枚ずつ、着いた姿を一枚撮る。--before を渡すと、場面ごとに before（左）と
//            after（右）を並べた一枚を書く。
//   before — この変更の前の製品（claim した base を書き出した木）。場面ごとに今の箱（または幕・道行きの字）を撮る。
// 場面（scene）:
//   errand   依頼の札の画面へ（昼の絵）。送り出し → GET /api/field（厳しい refresh）→ 依頼の画面。
//   academy-map 学院マップへ。送り出し → GET /api/field → GET /api/event-flags → 学院マップ（始められる出来事の無い週）。
//   lounge   談話室へ。送り出し → GET /api/field → 談話室の画面 → POST /api/lounge/enter → 最初の人の言葉。
//   auction  競売場へ。送り出し → GET /api/field → 競売場の画面 → GET /api/auction/state → POST /api/auction/enter → 口上。
//   dungeon  実践へ。送り出し（露台の夜を沈めた幕）→ GET /api/field → 入口の画面 →「潜る」→ POST /api/dungeon/enter → 盤。
//   load     タイトル → ロード → セーブの足跡 → 星の道（POST /api/routing/hub/start を止める）→ 露台。
//   new-game タイトル → 新しいゲーム → 星の道（同上）→ 露台。
//   graduation-load 第 50 週の露台で案内人を締めくくり相手に選び、頁を読み直してそのセーブをロードする（今の木では露台へ戻る
//            ハブへ入る字の道。案内人の卒業が露台で続く形より前の木では、星の道に「卒業のときを迎えました」が写る道）。
//   graduation-person-load 同じ道で、締めくくり相手に学院の人（相手選びの対応表の一行目）を選ぶ（星の道に「卒業のときを迎えました」が
//            写る道）。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const SCENE_LIMIT_MS = 300000;
// コマの連なりの間（層の薄れ 1.2s に 6 コマ前後）。コマは書き出しの速い JPEG で撮る（1440x900 の PNG は一枚 300ms を超える）。
const FILM_FRAME_MS = 200;
const FILM_JPEG_QUALITY = 80;
const FILM_MAX_FRAMES = 240;
// 要求を止めたまま連なりを流す長さ（要求の進まない区間をコマに残す）。
const HELD_FILM_MS = 1200;
// 道行きの途中を撮る時刻（押してから）。今の木ではロードの字が 2.5 秒ごろに灯る（loading-ways-survey H-1）。
const ROAD_SHOT_MS = 3000;
// 依頼の場面で、送り出しの後処理を長くする LM の遅れ（非 stream の応答一つごと）。
const LM_DRAIN_DELAY_MS = 2000;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--variant', '--scenes', '--before'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of ['--repo-root', '--out', '--variant', '--scenes']) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  const variant = parsed['--variant'];
  if (variant !== 'after' && variant !== 'before') throw new Error(`--variant must be after or before, got ${JSON.stringify(variant)}`);
  if (parsed['--before'] !== undefined && variant !== 'after') throw new Error('--before is taken only with --variant after');
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) {
    if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  }
  for (const key of ['--repo-root', '--out', '--before']) {
    if (parsed[key] !== undefined && !path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], variant, scenes, before: parsed['--before'] ?? null };
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
// 卒業の週の露台で、案内人自身を締めくくり相手に選ぶ言葉。
const GRADUATION_GUIDE_SELECT_LINE = 'あなた自身と、この学院生活の最後を過ごしたい';
// 学院の人（相手選びの対応表の一行目の人）を締めくくり相手に選ぶ言葉。
const GRADUATION_PERSON_SELECT_LINE = '挙げてくれた最初の人と、この学院生活の最後を過ごしたい';
// 案内人との卒業の会話が出ている: 今の木では露台のまま続き（露台の data-graduation）、この変更の前の木では昼の会話の画面へ移る。
const GRADUATION_CONVERSATION_SHOWN = "(document.querySelector('#routing-hub-screen.active[data-graduation]') || (document.querySelector('#conversation-day-screen.active') && (document.querySelector('#conversation-day-message-stream')?.textContent || '').trim().length > 0))";
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
    // 卒業の案内人の相手選び（要求は「character_idを1つだけ返す」も含むので表より先に見る）: 案内人自身を選ぶ言葉なら lina、
    // 学院の人を選ぶ言葉なら対応表の一行目の人。
    if (prompt.includes('締めくくりを誰と過ごすと選んだか')) {
      if (prompt.includes(GRADUATION_GUIDE_SELECT_LINE)) return { kind: 'graduation-partner lina', content: 'lina' };
      if (!prompt.includes(GRADUATION_PERSON_SELECT_LINE)) throw new Error('fixture lm: a graduation partner judgment without a choosing line');
      const table = prompt.slice(prompt.indexOf('締めくくりの相手の名称とcharacter_idの対応表:'));
      const first = table.match(/: (character_\d+)$/m);
      if (!first) throw new Error('fixture lm: the graduation partner table names no academy person');
      return { kind: `graduation-partner ${first[1]}`, content: first[1] };
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

// 場面ごとに一つ: 一時のセーブ・固定応答の LM・製品サーバー。lmFailures は 500 にした要求。
async function startProduct(repoRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-veil-capture-'));
  const closers = [];
  const lmFailures = [];
  const lmLog = [];
  const lmDelay = { ms: 0 };
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
      lmLog.push(reply.kind);
      if (!body.stream && lmDelay.ms > 0) await sleep(lmDelay.ms);
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
      lmFailures,
      lmLog,
      setLmDelay(ms) {
        lmDelay.ms = ms;
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
  watch('#terrace-opened', 'hidden', 'curtain-hidden');
  return true;
})()`;

// いまの待ちの姿: 層の段・待ちの紋の段（回っている turning／薄れている leaving／出ていない null）・読み込みの箱が見えているか・いま出ている画面。
const WAIT_STATE = `(() => {
  const veil = document.querySelector('#place-veil');
  const box = document.querySelector('#academy-loading-screen .academy-loading-copy');
  const loaderActive = document.body.classList.contains('academy-loading-screen-active');
  const curtain = document.querySelector('#terrace-opened');
  const journey = document.querySelector('#journey');
  const road = document.querySelector('.journey-road-copy');
  // 道行きの字の実効の不透明度: 字から上の祖先の不透明度を掛け合わせる（どれかが表示されていなければ 0）。
  const effectiveOpacity = (node) => {
    let value = 1;
    for (let el = node; el && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return 0;
      value *= Number(style.opacity);
    }
    return value;
  };
  const roadOpacity = road && road.textContent.trim() ? Number(effectiveOpacity(road).toFixed(3)) : 0;
  const boxOpacity = box && loaderActive && getComputedStyle(box).display !== 'none' ? Number(getComputedStyle(box).opacity) : 0;
  return {
    screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
    veil: veil && !veil.hidden ? { step: veil.dataset.veil ?? null, ground: veil.dataset.veilGround ?? null, dim: veil.dataset.veilDim ?? null, opacity: Number(getComputedStyle(veil).opacity), sigil: document.querySelector('#wait-sigil').hasAttribute('hidden') ? null : document.querySelector('#wait-sigil').dataset.waitSigil ?? 'turning' } : null,
    loaderActive,
    loaderLines: loaderActive ? Number(document.querySelector('#academy-loading-constellation').dataset.constellationRevealed ?? 0) : null,
    boxVisible: boxOpacity > 0.05,
    boxText: boxOpacity > 0.05 ? box.textContent.replace(/\\s+/g, ' ').trim() : null,
    curtain: curtain && !curtain.hidden ? { opacity: Number(getComputedStyle(curtain).opacity), night: curtain.classList.contains('is-night') } : null,
    journeyScene: journey ? journey.dataset.scene ?? null : null,
    roadOpacity,
    roadText: roadOpacity > 0.05 ? road.textContent.replace(/\\s+/g, ' ').trim() : null
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

// 第 50 週の露台で締めくくり相手を選んで第 2 段の会話へ入り、頁を読み直してタイトルからそのセーブをロードする。第 2 段の保存された
// 状態の読み直し（GET /api/state）を読み込みの画面の下で止めて道行きを撮る。
async function driveGraduationLoad(ctx, selectLine, shotPrefix) {
  const { page } = ctx;
  await walkToHub(ctx);
  const set = await page.js("fetch('/api/debug/weeks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elapsed_weeks: 49 }) }).then(async (r) => ({ status: r.status, body: await r.text() }))");
  if (set.status !== 200) throw new Error(`debug weeks: ${JSON.stringify(set)}`);
  ctx.steps.push('POST /api/debug/weeks {elapsed_weeks:49}');
  await walkToHub(ctx);
  await sayOnHub(ctx, selectLine);
  await page.waitFor(`${GRADUATION_CONVERSATION_SHOWN} && !${LOADING_ACTIVE}`, 'the phase-2 conversation', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  ctx.steps.push('graduation phase 2 started');
  await page.load(`${ctx.product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await page.js(INSTALL_TIMELINE);
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  const state = await page.hold('/api/state', { method: 'GET', decide: holdUnderCover(page) });
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  const pressed = Date.now();
  ctx.steps.push('reload → ロード → slot footprint (the phase-2 GET /api/state held under the loading screen)');
  await state.paused;
  // 学院の人の道で止まるのは refresh の読み（製品は 3000 ms で timeout にする）なので、止めてから 2000 ms までに撮って放す。
  await sleep(Math.min(2000, Math.max(900, pressed + ROAD_SHOT_MS - Date.now())));
  await ctx.shoot(`${shotPrefix}-road`, '卒業の第 2 段のセーブのロードの道行きの途中（保存された状態の GET /api/state を止めている間）');
  await state.release();
  await page.waitFor(`${GRADUATION_CONVERSATION_SHOWN} && !${LOADING_ACTIVE} && document.querySelector('#journey').dataset.scene === 'play'`, 'the phase-2 conversation again', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await ctx.shoot(`${shotPrefix}-arrived`, '卒業の第 2 段の会話に戻った姿');
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
    ctx.shots.push({ file: `${file}.png`, note, t: Date.now(), ...state });
    console.log(`shot ${file}.png — ${note} ${JSON.stringify({ veil: state.veil, loaderLines: state.loaderLines, boxVisible: state.boxVisible, screens: state.screens })}`);
    return state;
  };
}

// コマの連なり（after だけ）: 送り出しの幕が出てから（実践の「潜る」は押してから）行き先の画面に着くまで、FILM_FRAME_MS ごとに
// JPEG を一枚ずつ撮り続ける。撮影は窓の一つの口だけが行うので、待っている姿の png もこの連なりの合間に撮る（still）。
function startFilm(ctx, prefix) {
  const { page } = ctx;
  const frames = [];
  const started = Date.now();
  let stopping = false;
  let pendingStill = null;
  const done = (async () => {
    for (let index = 0; index < FILM_MAX_FRAMES; index += 1) {
      if (stopping) break;
      const due = started + index * FILM_FRAME_MS;
      if (Date.now() < due) await sleep(due - Date.now());
      if (pendingStill) {
        const { file, note, resolve, reject } = pendingStill;
        pendingStill = null;
        await ctx.shoot(file, note).then(resolve, reject);
      }
      const state = await page.js(WAIT_STATE);
      const bytes = await page.jpeg(FILM_JPEG_QUALITY);
      const file = `${prefix}-film-${String(frames.length).padStart(2, '0')}.jpg`;
      await fs.writeFile(path.join(ctx.options.out, file), bytes);
      frames.push({ file, ms: Date.now() - started, veil: state.veil, curtain: state.curtain, boxVisible: state.boxVisible, screens: state.screens });
    }
    if (!stopping) throw new Error(`${prefix}: the film reached ${FILM_MAX_FRAMES} frames before the arrival`);
  })();
  done.catch(() => {});
  return {
    still(file, note) {
      if (pendingStill) throw new Error(`${prefix}: a still is already pending`);
      return new Promise((resolve, reject) => { pendingStill = { file, note, resolve, reject }; });
    },
    // 層が下りて行き先が出揃ったあと、一拍撮ってから止める。
    async stop() {
      await page.waitFor(`!${VEIL_UP}`, `${prefix}: the wait gone`, LM_WAIT_MS);
      await sleep(FILM_FRAME_MS * 2);
      stopping = true;
      await done;
      const sigils = frames.map((frame) => frame.veil?.sigil ?? null);
      ctx.shots.push({ sequence: `${prefix}-film`, frames });
      console.log(`${prefix}: ${frames.length} frames over ${frames.at(-1).ms} ms; veil sigil ${sigils.map((step) => (step === null ? '-' : step)).join(' ')}`);
      if (frames.length < 5) throw new Error(`${prefix}: only ${frames.length} frames from the send-off to the arrival`);
      return frames;
    }
  };
}

// 止めた要求の間に一枚: 覆い（場所の絵の上の待ち・読み込みの箱）が上がるのを待ち、紋が現れきるのを待ってから撮る。after は連なりの
// 合間に撮り、止めたままもう少し連なりを流してから返す（要求の進まない区間をコマに残す）。
async function shootHeld(ctx, held, film, file, note) {
  await held.paused;
  await ctx.page.waitFor(COVER_UP, `${file}: the cover`, 30000);
  await sleep(900);
  if (!film) return ctx.shoot(file, note);
  const state = await film.still(file, note);
  await sleep(HELD_FILM_MS);
  return state;
}

// 露台で行き先を言い、送り出しの幕が出るまで待つ。after はそこから連なりを撮り始める。
async function sendOff(ctx, id) {
  const { page } = ctx;
  await sayOnHub(ctx, ctx.product.hubLines[id]);
  await page.waitFor("!document.querySelector('#terrace-opened').hidden", `${id}: the send-off curtain`, LM_WAIT_MS);
  ctx.steps.push(`send-off to ${id}: the curtain is up`);
  return ctx.options.variant === 'after' ? startFilm(ctx, id) : null;
}

// 送り出しのあとの厳しい refresh（GET /api/field）を、覆いが上がっている間だけ止める。
const holdDispatchField = (page) => page.hold('/api/field', { method: 'GET', decide: holdUnderCover(page) });

// 行き先の画面に着いて、層が下りて動きが収まった姿を撮る。
async function shootArrived(ctx, screenId, file, note, { settled = true } = {}) {
  await ctx.page.waitFor(settled ? screenSettled(screenId) : `document.querySelector('#${screenId}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`, `${screenId} arrived`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
  return ctx.shoot(file, note);
}

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
const SCENES = {
  // 依頼は、送り出しの後処理を長くして（LM の非 stream の応答を LM_DRAIN_DELAY_MS ずつ遅らせる）、見送りの読みの間が後処理より
  // 先に満ちる道（後処理の途中で待ちに入る）を撮る。
  async errand(ctx) {
    const { page, options } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    ctx.product.setLmDelay(LM_DRAIN_DELAY_MS);
    ctx.steps.push(`fixture LM: non-stream answers delayed ${LM_DRAIN_DELAY_MS} ms from the send-off line on`);
    const film = await sendOff(ctx, 'errand');
    await shootHeld(ctx, field, film, options.variant === 'before' ? 'errand-box' : 'errand-wait', '依頼へ: 送り出しのあとの GET /api/field を止めている間');
    await field.release();
    await page.waitFor(`document.querySelector('#academy-errand-screen.active')`, 'errand screen', LM_WAIT_MS);
    if (film) await film.stop();
    await shootArrived(ctx, 'academy-errand-screen', 'errand-arrived', '依頼の画面に着いた姿');
  },
  async 'academy-map'(ctx) {
    const { page, options } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'academy-map');
    await shootHeld(ctx, field, film, options.variant === 'before' ? 'academy-map-box' : 'academy-map-wait', '学院マップへ: 送り出しのあとの GET /api/field を止めている間');
    await field.release();
    await page.waitFor(`document.querySelector('#academy-map-screen.active') && !${VEIL_WAITING}`, 'academy map screen', LM_WAIT_MS);
    if (film) await film.stop();
    await shootArrived(ctx, 'academy-map-screen', 'academy-map-arrived', '学院マップに着いた姿', { settled: false });
  },
  async lounge(ctx) {
    const { page, options } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'lounge');
    if (film) await shootHeld(ctx, field, film, 'lounge-wait-a', '談話室へ: 送り出しのあとの GET /api/field を止めている間（幕が地）');
    const enter = await page.hold('/api/lounge/enter', { method: 'POST' });
    await field.release();
    await shootHeld(ctx, enter, film, options.variant === 'before' ? 'lounge-box' : 'lounge-wait-b', '談話室へ: POST /api/lounge/enter を止めている間（談話室の画面が地）');
    await enter.release();
    await page.waitFor(`document.querySelector('#academy-lounge-screen.active') && !${LOADING_ACTIVE} && !${VEIL_WAITING}`, 'the lounge talk started', LM_WAIT_MS);
    if (film) await film.stop();
    await shootArrived(ctx, 'academy-lounge-screen', 'lounge-arrived', '談話室の画面に着いた姿（最初の人の言葉が流れはじめた）', { settled: false });
  },
  async auction(ctx) {
    const { page, options } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'auction');
    if (film) await shootHeld(ctx, field, film, 'auction-wait-a', '競売場へ: 送り出しのあとの GET /api/field を止めている間（幕が地）');
    const enter = await page.hold('/api/auction/enter', { method: 'POST' });
    await field.release();
    await shootHeld(ctx, enter, film, options.variant === 'before' ? 'auction-box' : 'auction-wait-b', '競売場へ: POST /api/auction/enter を止めている間（競売場の画面が地）');
    await enter.release();
    await page.waitFor(`document.querySelector('#academy-auction-screen.active') && !${LOADING_ACTIVE} && !${VEIL_WAITING}`, 'the auction opened', LM_WAIT_MS);
    if (film) await film.stop();
    await shootArrived(ctx, 'academy-auction-screen', 'auction-arrived', '競売場の画面に着いた姿（口上が流れはじめた）', { settled: false });
  },
  async dungeon(ctx) {
    const { page, options } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const sendFilm = await sendOff(ctx, 'dungeon');
    await shootHeld(ctx, field, sendFilm, options.variant === 'before' ? 'dungeon-dispatch-box' : 'dungeon-dispatch-wait', '実践へ: 送り出しのあとの GET /api/field を止めている間（露台の夜を沈めた幕が地）');
    await field.release();
    await page.waitFor("document.querySelector('#academy-dungeon-screen.active') && !document.querySelector('#dungeon-dive').disabled", 'the dungeon entrance', LM_WAIT_MS);
    if (sendFilm) await sendFilm.stop();
    await shootArrived(ctx, 'academy-dungeon-screen', 'dungeon-entrance', '実践の入口の画面に着いた姿');
    const enter = await page.hold('/api/dungeon/enter', { method: 'POST' });
    await page.click("document.querySelector('#dungeon-dive')", '潜る');
    ctx.steps.push('press 潜る');
    const diveFilm = options.variant === 'after' ? startFilm(ctx, 'dungeon-dive') : null;
    await shootHeld(ctx, enter, diveFilm, options.variant === 'before' ? 'dungeon-box' : 'dungeon-wait', '潜る: POST /api/dungeon/enter を止めている間（入口の画面が地）');
    await enter.release();
    await page.waitFor(`document.querySelector('#academy-dungeon-screen.active') && !${LOADING_ACTIVE} && !${VEIL_WAITING} && document.querySelector('#dungeon-retreat-button')?.getBoundingClientRect().width > 0`, 'in the dungeon', LM_WAIT_MS);
    if (diveFilm) await diveFilm.stop();
    await shootArrived(ctx, 'academy-dungeon-screen', 'dungeon-arrived', '盤に着いた姿', { settled: false });
  },
  async load(ctx) {
    const { page } = ctx;
    await page.load(`${ctx.product.base}/`);
    await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
    await page.js(INSTALL_TIMELINE);
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
    await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
    await sleep(SETTLE_MS);
    const hub = await page.hold('/api/routing/hub/start', { method: 'POST' });
    await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
    const pressed = Date.now();
    ctx.steps.push('title → ロード → slot footprint (POST /api/routing/hub/start held)');
    await hub.paused;
    await sleep(Math.max(0, pressed + ROAD_SHOT_MS - Date.now()));
    await ctx.shoot('load-road', `ロードの道行きの途中（押してから ${ROAD_SHOT_MS} ms・POST /api/routing/hub/start を止めている間）`);
    await hub.release();
    await awaitHub(ctx);
    await ctx.shoot('load-arrived', '露台に着いた姿');
  },
  // 卒業の第 2 段（締めくくり相手は案内人）のセーブをロードする道。今の木では露台へ戻るのでハブへ入る字になり、星の道は写さない。
  // 案内人の卒業が露台で続く形より前の木では、製品は箱に「卒業のときを迎えました」を出し、星の道はそれを写す。
  'graduation-load': (ctx) => driveGraduationLoad(ctx, GRADUATION_GUIDE_SELECT_LINE, 'graduation-load'),
  // 卒業の第 2 段（締めくくり相手は学院の人）のセーブをロードする道。製品は箱に「卒業のときを迎えました」を出し、星の道はそれを写す
  // （ハブへ入る字ではないので隠さない）。
  'graduation-person-load': (ctx) => driveGraduationLoad(ctx, GRADUATION_PERSON_SELECT_LINE, 'graduation-person-load'),
  async 'new-game'(ctx) {
    const { page } = ctx;
    await page.load(`${ctx.product.base}/`);
    await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
    await page.js(INSTALL_TIMELINE);
    await sleep(SETTLE_MS);
    const hub = await page.hold('/api/routing/hub/start', { method: 'POST' });
    await page.click("document.querySelector('[data-journey-action=\"new-game\"]')", '新しいゲーム');
    const pressed = Date.now();
    ctx.steps.push('title → 新しいゲーム (POST /api/routing/hub/start held)');
    await hub.paused;
    await sleep(Math.max(0, pressed + ROAD_SHOT_MS - Date.now()));
    await ctx.shoot('new-game-road', `新しいゲームの道行きの途中（押してから ${ROAD_SHOT_MS} ms・POST /api/routing/hub/start を止めている間）`);
    await hub.release();
    await awaitHub(ctx);
    await ctx.shoot('new-game-arrived', '露台に着いた姿');
  }
};

// ── 並びの一枚（before ‖ after） ─────────────────────────────────────────────────────────────────────────
const COMPARE_PAIRS = [
  ['errand', 'errand-box.png', 'errand-wait.png'],
  ['academy-map', 'academy-map-box.png', 'academy-map-wait.png'],
  ['lounge', 'lounge-box.png', 'lounge-wait-b.png'],
  ['auction', 'auction-box.png', 'auction-wait-b.png'],
  ['dungeon', 'dungeon-box.png', 'dungeon-wait.png'],
  ['load', 'load-road.png', 'load-road.png'],
  ['new-game', 'new-game-road.png', 'new-game-road.png'],
  ['graduation-load', 'graduation-load-road.png', 'graduation-load-road.png'],
  ['graduation-person-load', 'graduation-person-load-road.png', 'graduation-person-load-road.png']
];

// 並べる頁は一時ディレクトリの file に書き、二枚は file:// で引く（数 MB の data: URL は窓ごと落ちる）。CDP は頁を load してから送る。
async function writeComparisons(options, scenes) {
  const written = [];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-veil-compare-'));
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
async function runScene(options, name) {
  const product = await startProduct(options.repoRoot);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
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
    return { scene: name, seconds, steps: ctx.steps, shots: ctx.shots, holds: page.holds, timeline, pageErrors: page.pageErrors, lmRequests: product.lmLog.length };
  } catch (error) {
    console.log(`scene ${name} stopped after: ${ctx.steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    console.log(`  last LM requests: ${JSON.stringify(product.lmLog.slice(-12))}`);
    console.log(`  page: ${JSON.stringify(await page.js("({ screen: document.querySelector('.screen.active')?.id ?? null, hubTail: (document.querySelector('#routing-hub-message-stream')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(-200) })").catch((e) => e.message))}`);
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
    try {
      scenes.push(await runScene(options, name));
    } catch (error) {
      console.log(`SCENE FAILED ${name}: ${error.stack ?? error.message}`);
      failed.push(name);
    }
  }
  const comparisons = options.before ? await writeComparisons(options, options.scenes) : [];
  const manifest = { variant: options.variant, repoRoot: options.repoRoot, viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, comparisons, failed };
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
