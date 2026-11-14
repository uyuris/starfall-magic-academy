// 行き先からハブ（または錬成室・自室）へ帰る道と、ハブから出かける道を、四分の一秒ごとのコマに撮って層の姿を並べる手回しの撮影の
// 道具（task hub-return-one-path・*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/hubReturnOnePathCapture.mjs --repo-root <絶対パス> --out <絶対パス> --roads <名,名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・app/public・data・
// content・assets）を、道ごとに OS の一時ディレクトリに作った新しいプレイの上で、この process の中に起こす。LM は固定応答（FIXTURE の
// 表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。--out は無いか空であること。
//
// 道（road）ごとに、出る操作の瞬間から着いた画面が落ち着くまでを Page.startScreencast の時刻つきコマで受け、SLOT_MS ごとの区切りの頭に
// 画面に出ていたコマを <道>-NNN.png に書き、その区切りの頭に読んだ層の姿（出ている画面・送り出しの幕・待ちの層の段と不透明度・地の絵の
// 不透明度・暗がりの不透明度・浮かびの形・読み込みの箱・ハブの場所の窓・大書庫の眠りの幕）と画面全体の明るさの平均を <道>.tsv と
// <out>/manifest.json に書く。着く画面へ移る前後のコマ（移り始めの 2 コマ前から層が下りるまで）を横に並べた一枚を <道>-strip.png に書く。
// 道ごとに三つの判定を出す（manifest の judgments）:
//   a  いた場所の絵が見えたあと、夜だけのコマを挟んでまた見えることが無い。
//   b  夜だけのコマ（送り出しの幕・大書庫の眠りの幕・夜へ沈んだ層だけで画面が覆われたコマ）の続く長さが、同じ撮影の outbound の長さ以下。
//   c  着く画面へ移るコマから層が下りるまで、層の暗がりの不透明度が移る前の値より下がらない（場所の絵が明るくならない）。
// 道:
//   outbound          ハブで大書庫へ行きたいと送った瞬間から、大書庫の画面が落ち着くまで（出かける道）。
//   library           大書庫の「書庫を出る」（帰り道 B）。
//   alchemy-exit      調合室を出る（帰り道 A・returnToRoutingHubFromContent → returnToRoutingHubFromPlace）。
//   alchemy-exit-reduced  同じ道を、動きを減らす設定で。
//   errand-end        依頼の会話の「会話を終える」（帰り道 A・会話の終わり）。
//   errand-achieved   依頼の達成で自動に終わる会話（帰り道 A・達成の後処理が読みの間より長い道）。
//   lounge-exit       談話室を出る（帰り道 A・談話室）。
//   dungeon-result    ダンジョンの結果の「戻る」（帰り道 C）。
//   fail-on-screen    調合室の画面が出たあと、その画面の取得（GET /api/alchemy）が落ちる（帰り道 D・行き先の画面の上の失敗）。
//   fail-under-sendoff 送り出しの層の下で、着く前の field の取得（GET /api/field）が落ちる（帰り道 D・送り出しの層の下の失敗）。
//   atelier-end       錬成室の会話の「会話を終える」（錬成室へ戻る道）。
//   loop-dungeon      周回のプレイのダンジョンの結果の「戻る」（自室へ戻る道）。
//   name-window       ハブで行き先の名に触れて開く窓（一枚の静止画 name-window.png）。
import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SLOT_MS = 250;
const CAST_SCALE = 0.5;
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const ROAD_LIMIT_MS = 90000;
// 着いた後も撮る（層が晴れきった姿と、着いた後に窓が出るかを含める）。
const TAIL_MS = 2500;
const STATE_POLL_MS = 20;
// 並べた一枚の一コマの大きさ。
const STRIP_FRAME = { width: 288, height: 180 };
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--roads'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  for (const key of ['--repo-root', '--out']) if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  const roads = parsed['--roads'].split(',');
  for (const road of roads) if (!Object.hasOwn(ROADS, road)) throw new Error(`unknown road ${road} (known: ${Object.keys(ROADS).join(' ')})`);
  if (new Set(roads).size !== roads.length) throw new Error(`a road is named twice in --roads ${parsed['--roads']}`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], roads };
}

// ── 固定応答の LM（言葉は撮影のための仮の文・製品の本文ではない） ─────────────────────────────────────────
const FIXTURE_EXPRESSIONS = ['joy', 'surprised', 'shy', 'worried', 'determined', 'smug'];
// 露台の案内人の言葉（出かける道は調べの道具と同じ一文）。
const FIXTURE_GUIDE_LINE = '（静かに頷いて）では、行ってらっしゃい。灯りの残る書架が待っていますよ。';
// 名に触れて開く窓を撮る道の迎えの言葉（行き先の名を含む）。
const FIXTURE_NAMING_GUIDE_LINE = '（星図を巻きながら）おかえりなさい。今週は大書庫で調べものをするのも、調合室で薬を煮るのもよさそうですね。';
const FIXTURE_LOUNGE_LINES = [
  'ふふ、頁をめくる音だけ聞いていると、試験のことなんて忘れそうです。',
  '（窓の外へ目をやって）風が気持ちいい。今日はここでゆっくりしたいな。',
  '次の実技は組みで出るらしいぞ。誰と組むか、もう決めたか？'
];
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
  ['この研究会の達成条件が、ここまでの会話で満たされたかを判定する', 'false'],
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['この談話の場に残っていたいと思っているかを判定する', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false'],
  ['のタイトルと本文を平文で出力する', 'タイトル: 学院の午後\n本文: 学院で主人公と言葉を交わした。'],
  ['memory_recordの本文だけ', '学院で主人公と穏やかに話した。']
];
const ERRAND_ACHIEVEMENT_MARKER = 'この依頼の達成条件が、ここまでの会話で満たされたかを判定する';
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

// lm: { guideLine, achieveErrand, reflectionDelayMs, loungeLines }（道ごとの答え方）。
function createFixtureLm(hubLines, lm) {
  const state = { emotionAnswers: 0, loungeLines: 0 };
  return function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') {
      const expression = FIXTURE_EXPRESSIONS[state.emotionAnswers % FIXTURE_EXPRESSIONS.length];
      state.emotionAnswers += 1;
      return { kind: `${schemaName} ${expression}`, content: JSON.stringify({ expression }) };
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
    if (prompt.includes(ERRAND_ACHIEVEMENT_MARKER)) return { kind: `errand-achievement ${lm.achieveErrand}`, content: String(lm.achieveErrand) };
    for (const [marker, appeal] of FIXTURE_OFFER_APPEALS) {
      if (prompt.includes(marker)) return { kind: `offer-appeal ${marker}`, content: appeal };
    }
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) {
      if (prompt.includes(marker)) return { kind: marker, content };
    }
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) {
      // 談話室の道だけが談話室の言葉を返す（ハブの行き先の一覧の文にも「寮の談話室」が出るので、文では見分けない）。
      if (lm.loungeLines) {
        const line = FIXTURE_LOUNGE_LINES[state.loungeLines % FIXTURE_LOUNGE_LINES.length];
        state.loungeLines += 1;
        return { kind: 'lounge-line', content: line };
      }
      return { kind: 'chat-line', content: lm.guideLine };
    }
    if (body.model === FIXTURE_CHAT_MODEL) return { kind: 'chat-line', content: lm.guideLine };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: FIXTURE_REFLECTION_LINE, delayMs: lm.reflectionDelayMs };
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
    if (reply.delayMs) await sleep(reply.delayMs);
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

// 錬成室で会える子を一人、プレイの root に置く（製品が錬成した子を保存する形のまま）。
const HOMUNCULUS_ID = 'homunculus_001';
async function seedActiveHomunculus(slotRoot) {
  await writeJson(slotRoot, 'game_data/homunculi.json', {
    version: 1,
    active: [{ homunculus_id: HOMUNCULUS_ID, display_name: 'ヴィオラ', face_id: 'hp_007', created_week: 0 }],
    nameplates: []
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/profile.json`, {
    character_id: HOMUNCULUS_ID,
    display_name: 'ヴィオラ',
    visual_set_id: 'hp_007',
    prompt_description: '臆病で甘えん坊、けれど時おり皮肉を差し込むホムンクルス。',
    speaking_basis: '一人称は「私」。控えめで小声、緊張すると言葉に詰まる。',
    parameters: {
      magic: { light: 72, dark: 30, fire: 55, water: 41, earth: 18, wind: 63 },
      abilities: { strength: 44, agility: 60, academics: 51, magical_power: 77, charisma: 38 }
    }
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/flags.json`, { character_id: HOMUNCULUS_ID, flags: {} });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/skills.json`, { character_id: HOMUNCULUS_ID, skills: [] });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/memory`), { recursive: true });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/work_records`), { recursive: true });
}

// 道ごとに一つ: 一時のプレイ・固定応答の LM・製品サーバー。lmFailures は撮影を止める LM の失敗。
async function startProduct(repoRoot, road) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-return-one-path-capture-'));
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
    const play = await initializeNewPlayArea(road.playMode === 'loop' ? { root, playMode: 'loop' } : { root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    if (road.homunculus) {
      // 錬成室はハブが開いた行き先にしか出さない: 一つ目の魔法の習熟を錬成室の開く値まで上げ、会える子を一人置く。
      const { magicParameterDefinitions } = await product('parameters.mjs');
      const { HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } = await product('homunculusUnlock.mjs');
      const parametersPath = path.join(play.root, 'game_data/runtime/player_parameters.json');
      const parameters = JSON.parse(await fs.readFile(parametersPath, 'utf8'));
      const key = magicParameterDefinitions[0].key;
      const entry = parameters.magic?.[key];
      if (entry === undefined) throw new Error(`the new play has no magic parameter ${key}`);
      parameters.magic[key] = entry !== null && typeof entry === 'object' ? { ...entry, value: HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } : HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD;
      await fs.writeFile(parametersPath, `${JSON.stringify(parameters, null, 2)}\n`, 'utf8');
      await seedActiveHomunculus(play.root);
    }
    const lmServer = createFixtureLmServer(createFixtureLm(hubLines, road.lm), lmFailures, lmLog);
    const lmPort = await listen(lmServer);
    closers.push(() => closeServer(lmServer));
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

// ── 窓（CDP） ─────────────────────────────────────────────────────────────────────────────────────────────
async function openPage(guard, { reducedMotion }) {
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
  let cast = null;
  // CDP Fetch: 規則に合う要求を decide(params) の答えで落とす（'fail'）・行き先を書き換えて通す（{ url }）・通す（'pass'）。
  const rules = [];
  cdp.on('message', (event, method, params) => {
    if (method === 'Page.screencastFrame') {
      if (cast !== null) {
        if (params.metadata.timestamp === undefined) throw new Error('a screencast frame came without its timestamp');
        cast.push({ at: params.metadata.timestamp * 1000, png: Buffer.from(params.data, 'base64') });
      }
      send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => console.log(`screencast ack: ${error.message}`));
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const rule = rules.find((entry) => params.request.url.includes(entry.fragment) && entry.method === params.request.method);
    if (!rule) {
      send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    rule.decide(params).then((verdict) => {
      if (verdict === 'pass') return send('Fetch.continueRequest', { requestId: params.requestId });
      rule.hits.push({ at: Date.now(), url: params.request.url, verdict: typeof verdict === 'string' ? verdict : verdict.url });
      if (verdict === 'fail') return send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' });
      return send('Fetch.continueRequest', { requestId: params.requestId, url: verdict.url });
    }).catch((error) => console.log(`fetch rule error: ${error.message}`));
  });
  async function syncFetch() {
    if (rules.length === 0) await send('Fetch.disable');
    else await send('Fetch.enable', { patterns: rules.map((entry) => ({ urlPattern: `*${entry.fragment}*`, requestStage: 'Request' })) });
  }
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js,
    pageErrors,
    rules,
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
      throw new Error(`timed out waiting for ${label} (state ${JSON.stringify(await js(FRAME_STATE).catch(() => null))}, page ${JSON.stringify(await js(DIAGNOSIS).catch(() => null))})`);
    },
    async point(selectorExpr, label) {
      const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      return box;
    },
    async click(selectorExpr, label) {
      const box = await page.point(selectorExpr, label);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      await send('Input.insertText', { text });
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    // fragment を含む method の要求を decide で裁く規則を立てる。返る hits に裁いた要求が積まれる。
    async rule(fragment, method, decide) {
      const entry = { fragment, method, decide, hits: [] };
      rules.push(entry);
      await syncFetch();
      return entry;
    },
    async png() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    async startCast() {
      if (cast !== null) throw new Error('the screencast is already running');
      cast = [];
      await send('Page.startScreencast', { format: 'png', maxWidth: Math.round(VIEWPORT.width * CAST_SCALE), maxHeight: Math.round(VIEWPORT.height * CAST_SCALE), everyNthFrame: 1 });
    },
    castFrames() {
      if (cast === null) throw new Error('the screencast is not running');
      return cast;
    },
    async stopCast() {
      await send('Page.stopScreencast');
      cast = null;
    },
    close() {
      win.destroy();
    }
  };
  return page;
}

// ── 製品の通常の道 ─────────────────────────────────────────────────────────────────────────────────────────
const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(!document.querySelector('#place-veil').hidden)";
const VEIL_WAITING = `(${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'waiting')`;
const CURTAIN_UP = "(!document.querySelector('#terrace-opened').hidden)";
const screenUp = (id) => `(document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP} && !${CURTAIN_UP})`;
const HUB_SHOWN = screenUp('routing-hub-screen');
const HUB_READY = `${HUB_SHOWN} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const LIBRARY = "document.querySelector('#academy-library-screen')";
const LIBRARY_EXITABLE = `(${screenUp('academy-library-screen')} && ['arrival', 'shelf'].includes(${LIBRARY}.dataset.scene))`;

// 止まったときに添える画面の言葉（状態の行と、ハブ・昼の会話の最後の行）。
const DIAGNOSIS = `(() => {
  const text = (selector) => document.querySelector(selector)?.textContent.replace(/\\s+/g, ' ').trim() ?? null;
  const lastRows = (selector) => [...document.querySelectorAll(selector + ' .chat-message')].slice(-2).map((row) => row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120));
  return { hubStatus: text('#routing-hub-status'), dayStatus: text('#conversation-day-status'), hubRows: lastRows('#routing-hub-message-stream'), dayRows: lastRows('#conversation-day-message-stream'), dayEndDisabled: document.querySelector('#conversation-day-end')?.disabled ?? null };
})()`;

// 各区切りの頭に読む層の姿。
const FRAME_STATE = `(() => {
  const round = (value) => Math.round(Number(value) * 100) / 100;
  const curtain = document.querySelector('#terrace-opened');
  const veil = document.querySelector('#place-veil');
  const library = ${LIBRARY};
  const sleepLayer = library.querySelector('.academy-library-sleep');
  const veilArt = veil.style.getPropertyValue('--place-veil-art').trim();
  const window = document.querySelector('#routing-hub-screen .terrace-place-window');
  const veilShown = !veil.hidden;
  return {
    screen: document.querySelector('.screen.active')?.id ?? null,
    libraryScene: library.dataset.scene ?? null,
    librarySleep: library.classList.contains('active') && sleepLayer ? round(getComputedStyle(sleepLayer).opacity) : null,
    curtain: curtain.hidden ? null : round(getComputedStyle(curtain).opacity),
    veil: veilShown ? veil.dataset.veil : null,
    veilOpacity: veilShown ? round(getComputedStyle(veil).opacity) : null,
    veilGround: veilShown ? veil.dataset.veilGround : null,
    veilArt: !veilShown || veilArt === 'none' ? null : veilArt.replace(/^url\\(['"]?|['"]?\\)$/g, ''),
    veilArtOpacity: veilShown ? round(getComputedStyle(veil.querySelector('.place-veil-art')).opacity) : null,
    veilScrim: veilShown && veil.dataset.veilDim === 'night' ? round(getComputedStyle(veil.querySelector('.place-veil-scrim')).opacity) : null,
    veilDusk: veilShown ? round(getComputedStyle(veil.querySelector('.place-veil-dusk')).opacity) : null,
    veilFrom: veilShown ? (veil.dataset.veilFrom ?? null) : null,
    veilDim: veilShown ? veil.dataset.veilDim : null,
    loadingBox: document.body.classList.contains('academy-loading-screen-active'),
    placeWindow: window && !window.hidden ? (window.dataset.window ?? 'seating') : null,
    sigil: !document.querySelector('#wait-sigil').hasAttribute('hidden')
  };
})()`;

function frameLuma(png) {
  const bitmap = nativeImage.createFromBuffer(png).toBitmap();
  let sum = 0;
  for (let i = 0; i < bitmap.length; i += 4) sum += 0.0722 * bitmap[i] + 0.7152 * bitmap[i + 1] + 0.2126 * bitmap[i + 2];
  return Math.round((sum / (bitmap.length / 4)) * 10) / 10;
}

// 夜だけのコマ: 画面が送り出しの幕・大書庫の眠りの幕・夜へ沈んだ層だけで覆われている（地の絵が見えない）。
function nightOnly(state) {
  const veilArtSeen = state.veil !== null && state.veilGround === 'art' && state.veilOpacity * state.veilArtOpacity > 0.05 && state.veil !== 'stopped';
  if (veilArtSeen) return false;
  if (state.veil === 'stopped' && state.veilOpacity > 0.95) return true;
  if (state.curtain !== null && state.curtain > 0.95) return true;
  if (state.librarySleep !== null && state.librarySleep > 0.95) return true;
  return false;
}

// 層の姿を一行の言葉にする（tsv の欄）。
function layersOf(state) {
  const parts = [];
  if (state.screen) parts.push(`画面=${state.screen.replace(/-screen$/, '')}`);
  if (state.screen === 'academy-library-screen') parts.push(`大書庫の場面=${state.libraryScene}${state.librarySleep === null ? '' : `・眠りの幕=${state.librarySleep}`}`);
  if (state.curtain !== null) parts.push(`送り出しの幕=${state.curtain}`);
  if (state.veil !== null) {
    parts.push(`待ちの層=${state.veil}(不透明度${state.veilOpacity}・地=${state.veilGround === 'art' ? `絵 ${state.veilArt}・絵の不透明度${state.veilArtOpacity}` : '画面そのまま'}・暗がり=${state.veilDim}${state.veilScrim === null ? '' : `${state.veilScrim}`}${state.veilFrom ? `・from=${state.veilFrom}` : ''}${state.veilDusk > 0 ? `・夜へ沈む${state.veilDusk}` : ''})`);
  }
  if (state.loadingBox) parts.push('読み込みの箱');
  if (state.placeWindow !== null) parts.push(`場所の窓=${state.placeWindow}`);
  if (state.sigil) parts.push('待ちのアイコン');
  return parts.join(' / ');
}

const TSV_COLUMNS = ['slot', 'ms', 'file', 'mean_luma', 'screen', 'curtain', 'veil', 'veil_opacity', 'veil_art_opacity', 'veil_scrim', 'veil_from', 'loading_box', 'place_window', 'night_only', 'layers'];
function tsvRow(entry) {
  const s = entry.state;
  const cell = (value) => (value === null ? '-' : String(value));
  return [entry.slot, entry.ms, entry.file, entry.mean, cell(s.screen), cell(s.curtain), cell(s.veil), cell(s.veilOpacity), cell(s.veilArtOpacity), cell(s.veilScrim), cell(s.veilFrom), s.loadingBox, cell(s.placeWindow), entry.nightOnly, entry.layers].join('\t');
}

// trigger を押した時刻から done が真になって TAIL_MS 経つまでを撮り、SLOT_MS ごとの区切りの頭のコマと層の姿を書く。
async function recordRoad(ctx, { name, trigger, done }) {
  const { page } = ctx;
  await page.moveAway();
  await page.startCast();
  await sleep(300);
  const states = [];
  const started = Date.now();
  await trigger();
  let doneAt = null;
  for (;;) {
    ctx.guard();
    const at = Date.now();
    if (at - started > ROAD_LIMIT_MS) throw new Error(`${name}: not done within ${ROAD_LIMIT_MS} ms (last ${JSON.stringify(states.at(-1)?.state)}, page ${JSON.stringify(await page.js(DIAGNOSIS))})`);
    const { state, finished } = await page.js(`(() => ({ state: ${FRAME_STATE}, finished: (() => { try { return !!(${done}); } catch (error) { return false; } })() }))()`);
    states.push({ at, state });
    if (finished && doneAt === null) doneAt = at;
    if (doneAt !== null && at - doneAt >= TAIL_MS) break;
    await sleep(STATE_POLL_MS);
  }
  const ended = states.at(-1).at;
  await sleep(300);
  const cast = page.castFrames();
  const slots = [];
  for (let slot = 0; started + slot * SLOT_MS <= ended; slot += 1) {
    const head = started + slot * SLOT_MS;
    const frame = cast.filter((entry) => entry.at <= head).at(-1);
    if (frame === undefined) throw new Error(`${name}: no screen frame was on screen at slot ${slot} (the screencast had ${cast.length} frames)`);
    const reading = states.filter((entry) => entry.at <= head).at(-1) ?? states[0];
    const file = `${name}-${String(slot).padStart(3, '0')}.png`;
    await fs.writeFile(path.join(ctx.options.out, file), frame.png);
    slots.push({ slot, ms: slot * SLOT_MS, file, mean: frameLuma(frame.png), frameAgeMs: Math.round(head - frame.at), readAgeMs: head - reading.at, state: reading.state, nightOnly: nightOnly(reading.state), layers: layersOf(reading.state) });
  }
  await page.stopCast();
  await fs.writeFile(path.join(ctx.options.out, `${name}.tsv`), `${[TSV_COLUMNS.join('\t'), ...slots.map(tsvRow)].join('\n')}\n`, 'utf8');
  console.log(`── ${name}: ${slots.length} slots (${SLOT_MS} ms each), done at ${doneAt - started} ms`);
  for (const entry of slots) console.log(`${entry.file}\t${entry.ms}ms\tluma ${entry.mean}\t${entry.nightOnly ? 'NIGHT ' : ''}${entry.layers}`);
  return { name, slotMs: SLOT_MS, startedAt: started, doneAtMs: doneAt - started, slots };
}

// ── 判定 ─────────────────────────────────────────────────────────────────────────────────────────────────
function longestNightRun(slots) {
  let longest = 0;
  let run = 0;
  for (const entry of slots) {
    run = entry.nightOnly ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

// 着く画面へ移るコマ: 待ちの層が待つのをやめ（薄れ始め・下りた）、着く画面が出ている最初の区切り。待ちの層を通らない道は、着く画面が
// 出ている最初の区切り。from より前は数えない。
function arrivalSlot(slots, arrival, from = 0) {
  const ended = slots.findIndex((entry, index) => index > from && slots[index - 1].state.veil === 'waiting' && entry.state.veil !== 'waiting' && entry.state.screen === arrival);
  if (ended >= 0) return ended;
  const index = slots.findIndex((entry, i) => i >= from && entry.state.screen === arrival);
  if (index < 0) throw new Error(`the road never showed ${arrival}`);
  return index;
}

// 判定を始める区切り: 失敗を起こす道は、要求を落とした区切りから（その前の出かける道は判定に入れない）。ほかは 0。
function judgedFrom(record) {
  if (record.failedRequests.length === 0) return 0;
  return Math.floor((record.failedRequests[0].at - record.startedAt) / record.slotMs);
}

function judge(record, road, outboundNightRun) {
  const from = judgedFrom(record);
  const slots = record.slots.slice(from);
  const origin = road.origin;
  const arrivalIndex = arrivalSlot(slots, road.arrival);
  // いた場所の絵: 出る画面そのもの（地の絵の層で覆われきっていない）か、出る画面の上で上がった層の地の絵（出かける道では、いた場所は
  // ハブで、層の地の絵は行き先の絵なので数えない）。
  const originArt = road.outbound ? null : slots.find((entry) => entry.state.veil !== null && entry.state.veilGround === 'art')?.state.veilArt ?? null;
  const placeSeen = (entry) => (entry.state.screen === origin && !(entry.state.veil !== null && entry.state.veilOpacity > 0.98 && entry.state.veilGround === 'art'))
    || (originArt !== null && entry.state.veilArt === originArt && entry.state.veil !== 'stopped' && entry.state.veilOpacity * entry.state.veilArtOpacity > 0.05)
    || (entry.state.veil !== null && entry.state.veilGround === 'screen' && entry.state.screen === origin);
  // a: 見えた → 夜だけ → また見える、の並びが無い。
  let seen = false;
  let darkAfterSeen = false;
  let reappeared = null;
  for (const entry of slots) {
    if (entry.nightOnly) {
      if (seen) darkAfterSeen = true;
      continue;
    }
    if (placeSeen(entry)) {
      if (darkAfterSeen && reappeared === null) reappeared = entry.slot;
      seen = true;
    }
  }
  const nightRun = longestNightRun(slots);
  // c: 着く画面へ移るコマから層が下りるまで、暗がりの不透明度が移る前（直前の区切り）の値より下がらない。
  // 出かける道と、層と同じ絵の画面へ戻る道（錬成室の会話の終わり→錬成室）は、同じ絵の画面へ着くので暗がりを解いて薄れるのが決まり
  // （この判定は違う絵の画面へ着く帰り道だけに掛ける）。
  const before = road.outbound || road.sameArtArrival ? null : slots[Math.max(0, arrivalIndex - 1)].state.veilScrim;
  const leaving = slots.slice(arrivalIndex).filter((entry) => entry.state.veil !== null);
  const dropped = before === null ? [] : leaving.filter((entry) => entry.state.veilScrim !== null && entry.state.veilScrim < before - 0.01).map((entry) => `${entry.slot}:${entry.state.veilScrim}`);
  const windowAfterArrival = slots.slice(arrivalIndex).filter((entry) => entry.state.placeWindow !== null).map((entry) => `${entry.slot}:${entry.state.placeWindow}`);
  return {
    a: { pass: reappeared === null, reappearedAtSlot: reappeared, originArt },
    b: { pass: outboundNightRun === null ? null : nightRun <= outboundNightRun, nightRun, outboundNightRun },
    c: { pass: before === null ? null : dropped.length === 0, scrimBeforeArrival: before, droppedAt: dropped },
    judgedFromSlot: from,
    arrivalSlot: slots[arrivalIndex].slot,
    windowAfterArrival
  };
}

// 着く画面へ移る前後のコマ（移り始めの 2 コマ前から、層が下りた最初の区切りまで）を横に並べた一枚。
async function writeStrip(options, record, road) {
  const { slots } = record;
  const arrivalIndex = arrivalSlot(slots, road.arrival, judgedFrom(record));
  const from = Math.max(0, arrivalIndex - 2);
  let to = slots.findIndex((entry, index) => index >= arrivalIndex && entry.state.veil === null && entry.state.curtain === null);
  if (to < 0) to = slots.length - 1;
  const picked = slots.slice(from, to + 1);
  const width = STRIP_FRAME.width * picked.length;
  const win = new BrowserWindow({ width, height: STRIP_FRAME.height + 20, useContentSize: true, show: false });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-return-strip-'));
  try {
    await win.loadURL('about:blank');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: STRIP_FRAME.height + 20, deviceScaleFactor: 1, mobile: false });
    const cells = picked.map((entry) => `<div style="width:${STRIP_FRAME.width}px"><img style="display:block;width:${STRIP_FRAME.width}px;height:${STRIP_FRAME.height}px" src="${new URL(`file://${path.join(options.out, entry.file)}`).href}"><div style="height:20px;font:12px sans-serif;color:#ddd;padding-left:4px">${entry.slot} · ${entry.ms}ms · ${entry.mean}</div></div>`).join('');
    const html = path.join(scratch, 'strip.html');
    await fs.writeFile(html, `<html><body style="margin:0;background:#000"><div style="display:flex">${cells}</div></body></html>`, 'utf8');
    await win.loadFile(html);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map((img) => img.decode()))');
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: STRIP_FRAME.height + 20, scale: 1 } });
    const file = `${record.name}-strip.png`;
    await fs.writeFile(path.join(options.out, file), Buffer.from(data, 'base64'));
    return { file, slots: picked.map((entry) => entry.slot) };
  } finally {
    win.destroy();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

// ── 道の入り口までの歩き ─────────────────────────────────────────────────────────────────────────────────
async function walkToHub(ctx) {
  const { page, product } = ctx;
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
}

async function awaitHub(ctx) {
  await ctx.page.waitFor(HUB_READY, 'the hub', LM_WAIT_MS);
  await ctx.page.waitFor(motionSettled('#routing-hub-screen'), 'the hub settled');
  await sleep(SETTLE_MS);
}

// 送信は迎えの言葉を出している間は黙って何もしないので、入力の欄が空になる（送信が走った）まで押し直す。
async function sendOnHub(page, line) {
  await page.type("document.querySelector('#routing-hub-input')", 'hub input', line);
  const end = Date.now() + 30000;
  for (;;) {
    await page.click("document.querySelector('#routing-hub-send')", 'hub send');
    await sleep(60);
    if (await page.js("document.querySelector('#routing-hub-input').value === ''")) return;
    if (Date.now() > end) throw new Error(`the hub send never fired for: ${line} (${JSON.stringify(await page.js("({ input: document.querySelector('#routing-hub-input').value, inputDisabled: document.querySelector('#routing-hub-input').disabled, sendDisabled: document.querySelector('#routing-hub-send').disabled, status: document.querySelector('#routing-hub-status').textContent.trim(), rows: document.querySelectorAll('#routing-hub-message-stream .chat-message').length })"))})`);
  }
}

async function dispatchTo(ctx, id, screenId) {
  await walkToHub(ctx);
  await awaitHub(ctx);
  await sendOnHub(ctx.page, ctx.product.hubLines[id]);
  await ctx.page.waitFor(`${screenUp(screenId)} && ${motionSettled(`#${screenId}`)}`, `${screenId} settled`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
}

async function openErrandConversation(ctx) {
  const { page } = ctx;
  await dispatchTo(ctx, 'errand', 'academy-errand-screen');
  await page.click("document.querySelector('#academy-errand-offers .academy-errand-card-button')", 'first errand card');
  await page.waitFor(`${screenUp('conversation-day-screen')} && !document.querySelector('#conversation-day-end').disabled && !document.querySelector('#conversation-day-send').disabled`, 'errand conversation ready', LM_WAIT_MS);
  await sleep(SETTLE_MS);
}

const hubDone = `${HUB_SHOWN} && ${motionSettled('#routing-hub-screen')}`;
const alchemyExit = (page) => () => page.click("document.querySelector('#academy-alchemy-exit')", '調合室を出る');

// 道の表: walk は撮る前の歩きで { trigger, done } を返す。origin は出る画面、arrival は着く画面（判定と並べた一枚が読む）。
const ROADS = {
  outbound: {
    outbound: true,
    origin: 'routing-hub-screen',
    arrival: 'academy-library-screen',
    async walk(ctx) {
      await walkToHub(ctx);
      await awaitHub(ctx);
      return { trigger: () => sendOnHub(ctx.page, ctx.product.hubLines.library), done: `${LIBRARY_EXITABLE} && ${motionSettled('#academy-library-screen')}` };
    }
  },
  library: {
    origin: 'academy-library-screen',
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      await dispatchTo(ctx, 'library', 'academy-library-screen');
      await ctx.page.waitFor(LIBRARY_EXITABLE, 'the library exitable');
      return { trigger: () => ctx.page.click(`${LIBRARY}.querySelector('.academy-library-exit')`, '書庫を出る'), done: hubDone };
    }
  },
  'alchemy-exit': {
    origin: 'academy-alchemy-screen',
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      await dispatchTo(ctx, 'alchemy', 'academy-alchemy-screen');
      return { trigger: alchemyExit(ctx.page), done: hubDone };
    }
  },
  'alchemy-exit-reduced': {
    origin: 'academy-alchemy-screen',
    arrival: 'routing-hub-screen',
    reducedMotion: true,
    async walk(ctx) {
      await dispatchTo(ctx, 'alchemy', 'academy-alchemy-screen');
      return { trigger: alchemyExit(ctx.page), done: hubDone };
    }
  },
  'errand-end': {
    origin: 'conversation-day-screen',
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      await openErrandConversation(ctx);
      return { trigger: () => ctx.page.click("document.querySelector('#conversation-day-end')", '会話を終える'), done: hubDone };
    }
  },
  'errand-achieved': {
    origin: 'conversation-day-screen',
    arrival: 'routing-hub-screen',
    lm: { achieveErrand: true, reflectionDelayMs: 7000 },
    async walk(ctx) {
      await openErrandConversation(ctx);
      const { page } = ctx;
      return {
        async trigger() {
          await page.type("document.querySelector('#conversation-day-input')", 'day input', 'では、背表紙の色ごとに棚へ戻していきましょう。');
          await page.click("document.querySelector('#conversation-day-send')", '送信');
        },
        done: hubDone
      };
    }
  },
  'lounge-exit': {
    origin: 'academy-lounge-screen',
    lm: { loungeLines: true },
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      const { page } = ctx;
      await walkToHub(ctx);
      await awaitHub(ctx);
      await sendOnHub(page, ctx.product.hubLines.lounge);
      await page.waitFor(`${screenUp('academy-lounge-screen')} && !document.querySelector('#academy-lounge-input').disabled && ${motionSettled('#academy-lounge-screen')}`, 'the lounge player turn', LM_WAIT_MS);
      await sleep(SETTLE_MS);
      return { trigger: () => page.click("document.querySelector('#academy-lounge-end')", '談話室を出る'), done: hubDone };
    }
  },
  'dungeon-result': {
    origin: 'academy-dungeon-screen',
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      const { page } = ctx;
      await dispatchTo(ctx, 'dungeon', 'academy-dungeon-screen');
      await diveAndRetreat(page);
      return { trigger: () => page.click("document.querySelector('#dungeon-result-back')", '戻る'), done: hubDone };
    }
  },
  'fail-on-screen': {
    origin: 'academy-alchemy-screen',
    expectedRendererErrors: ['Failed to fetch'],
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      const { page } = ctx;
      await walkToHub(ctx);
      await awaitHub(ctx);
      // 調合室の画面が出たあとの取得（GET /api/alchemy）を一度だけ落とす。
      const rule = await page.rule('/api/alchemy', 'GET', async () => ((await page.js("Boolean(document.querySelector('#academy-alchemy-screen.active'))")) && rule.hits.length === 0 ? 'fail' : 'pass'));
      return { trigger: () => sendOnHub(page, ctx.product.hubLines.alchemy), done: `${hubDone} && document.querySelector('#routing-hub-status').textContent.trim() !== ''`, rule };
    }
  },
  'fail-under-sendoff': {
    origin: 'routing-hub-screen',
    expectedRendererErrors: ['Failed to fetch'],
    arrival: 'routing-hub-screen',
    async walk(ctx) {
      const { page } = ctx;
      await walkToHub(ctx);
      await awaitHub(ctx);
      // 送り出しの層の下で、着く前の field の取得（GET /api/field）を一度だけ落とす。
      const rule = await page.rule('/api/field', 'GET', async () => ((await page.js(`${VEIL_WAITING} && ${CURTAIN_UP}`)) && rule.hits.length === 0 ? 'fail' : 'pass'));
      return { trigger: () => sendOnHub(page, ctx.product.hubLines.alchemy), done: `${hubDone} && document.querySelector('#routing-hub-status').textContent.trim() !== ''`, rule };
    }
  },
  'atelier-end': {
    origin: 'conversation-day-screen',
    arrival: 'academy-atelier-screen',
    sameArtArrival: true,
    homunculus: true,
    async walk(ctx) {
      const { page } = ctx;
      await dispatchTo(ctx, 'homunculus', 'academy-atelier-screen');
      await page.click("document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk')", '会いに行く');
      await page.waitFor(`${screenUp('conversation-day-screen')} && !document.querySelector('#conversation-day-end').disabled`, 'the atelier conversation', LM_WAIT_MS);
      await sleep(SETTLE_MS);
      return { trigger: () => page.click("document.querySelector('#conversation-day-end')", '会話を終える'), done: `${screenUp('academy-atelier-screen')} && ${motionSettled('#academy-atelier-screen')}` };
    }
  },
  'loop-dungeon': {
    origin: 'academy-dungeon-screen',
    arrival: 'academy-room-screen',
    playMode: 'loop',
    async walk(ctx) {
      const { page } = ctx;
      await walkToLoopRoom(ctx);
      await page.click("document.querySelector('#academy-room-start-training')", '次の一週間に進む');
      await page.waitFor(screenUp('academy-training-screen'), 'the loop training', LM_WAIT_MS);
      await sleep(SETTLE_MS);
      // 鍛錬の画面の「実践に潜る」は隠れた列（.academy-training-utility[hidden]）にあって押せないので、そのボタンの click を起こす。
      await page.js("document.querySelector('#academy-training-open-dungeon').click()");
      await page.waitFor(`${screenUp('academy-dungeon-screen')} && ${motionSettled('#academy-dungeon-screen')}`, 'the loop dungeon', LM_WAIT_MS);
      await sleep(SETTLE_MS);
      await diveAndRetreat(page);
      return { trigger: () => page.click("document.querySelector('#dungeon-result-back')", '戻る'), done: `${screenUp('academy-room-screen')} && ${motionSettled('#academy-room-screen')}` };
    }
  },
  'name-window': {
    still: true,
    lm: { guideLine: FIXTURE_NAMING_GUIDE_LINE },
    async walk(ctx) {
      const { page } = ctx;
      await walkToHub(ctx);
      await awaitHub(ctx);
      // 案内人の返事（固定応答の LM の言葉）に行き先の名を二つ含める。
      await sendOnHub(page, '少し話を聞かせて。');
      await page.waitFor(`document.querySelector('#routing-hub-message-stream .terrace-place') && !document.querySelector('#routing-hub-input').disabled && ${motionSettled('#routing-hub-screen')}`, 'a destination name in the reply', LM_WAIT_MS);
      await sleep(SETTLE_MS);
      await page.point("document.querySelector('#routing-hub-message-stream .terrace-place')", 'the destination name');
      await page.waitFor("!document.querySelector('#routing-hub-screen .terrace-place-window').hidden", 'the name window', 10000);
      await page.waitFor(motionSettled('#routing-hub-screen .terrace-place-window'), 'the name window settled');
      await sleep(400);
      const bytes = await page.png();
      await fs.writeFile(path.join(ctx.options.out, 'name-window.png'), bytes);
      const state = await page.js(`({ frame: ${FRAME_STATE}, name: document.querySelector('#routing-hub-message-stream .terrace-place').textContent, art: document.querySelector('#routing-hub-screen .terrace-place-window-art').getAttribute('src') })`);
      console.log(`name-window.png ${JSON.stringify(state)}`);
      return { still: { file: 'name-window.png', ...state } };
    }
  }
};

// 周回のプレイはハブを持たず、ロードで自室へ着く。
async function walkToLoopRoom(ctx) {
  await walkToHub(ctx);
  await ctx.page.waitFor(`${screenUp('academy-room-screen')} && document.querySelector('#academy-room-start-training').getBoundingClientRect().width > 0`, 'the loop room', LM_WAIT_MS);
  await sleep(SETTLE_MS);
}

async function diveAndRetreat(page) {
  await page.waitFor("!document.querySelector('#dungeon-dive').disabled", 'dive enabled', LM_WAIT_MS);
  await page.click("document.querySelector('#dungeon-dive')", '潜る');
  await page.waitFor(`document.querySelector('#academy-dungeon-screen.active') && !${LOADING_ACTIVE} && !${VEIL_UP} && document.querySelector('#dungeon-retreat-button')?.getBoundingClientRect().width > 0`, 'in the dungeon', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('#dungeon-retreat-button')", '撤退');
  await page.waitFor("document.querySelector('#dungeon-retreat-yes')?.getBoundingClientRect().width > 0", 'retreat dialog');
  await sleep(500);
  await page.click("document.querySelector('#dungeon-retreat-yes')", '撤退する');
  await page.waitFor("!document.querySelector('#dungeon-result-back').hidden && document.querySelector('#dungeon-result-back').getBoundingClientRect().width > 0", 'result back', LM_WAIT_MS);
  await page.waitFor(motionSettled('#academy-dungeon-screen'), 'the result settled', LM_WAIT_MS);
  await sleep(SETTLE_MS);
}

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runRoad(options, name) {
  const road = { outbound: false, playMode: 'routing', homunculus: false, reducedMotion: false, expectedRendererErrors: [], ...ROADS[name], lm: { guideLine: FIXTURE_GUIDE_LINE, achieveErrand: false, reflectionDelayMs: 0, loungeLines: false, ...ROADS[name].lm } };
  const product = await startProduct(options.repoRoot, road);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`LM failed: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard, { reducedMotion: road.reducedMotion });
  const ctx = { options, product, page, guard };
  const started = Date.now();
  try {
    const walked = await road.walk(ctx);
    if (road.still) return { name, seconds: (Date.now() - started) / 1000, ...walked.still, lmLog: product.lmLog };
    const record = await recordRoad(ctx, { name, trigger: walked.trigger, done: walked.done });
    guard();
    if (walked.rule && walked.rule.hits.length !== 1) throw new Error(`${name}: the failure rule hit ${walked.rule.hits.length} request(s), expected 1`);
    // 落とした要求の失敗（console に残る 'Failed to fetch'）だけは、その道が起こした失敗として数えない。
    const unexpected = page.pageErrors.filter((message) => !road.expectedRendererErrors.some((expected) => message.includes(expected)));
    if (unexpected.length > 0) throw new Error(`${name}: renderer errors: ${unexpected.join(' | ')}`);
    return { ...record, road, seconds: (Date.now() - started) / 1000, failedRequests: walked.rule?.hits ?? [], rendererErrors: page.pageErrors, lmLog: product.lmLog };
  } finally {
    page.close();
    await product.stop();
  }
}

// userData は ready より前に置き場の中へ向ける（host 共有の Electron の cache に書かない）。
const OPTIONS = parseArgs(process.argv.slice(2));
const USER_DATA = path.join(OPTIONS.out, '.electron-user-data');
app.setPath('userData', USER_DATA);

async function main() {
  const options = OPTIONS;
  const existing = await fs.readdir(options.out).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (existing !== null && existing.length > 0) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  console.log('electron ready');
  const started = Date.now();
  const records = [];
  try {
    for (const name of options.roads) {
      console.log(`── road ${name}`);
      records.push(await runRoad(options, name));
    }
    const outbound = records.find((record) => record.name === 'outbound');
    const outboundNightRun = outbound ? longestNightRun(outbound.slots) : null;
    const roads = [];
    for (const record of records) {
      if (!record.slots) {
        roads.push(record);
        continue;
      }
      const { road, ...rest } = record;
      const judgments = judge(record, road, outboundNightRun);
      const strip = await writeStrip(options, record, road);
      console.log(`judge ${record.name}: ${JSON.stringify(judgments)} strip ${strip.file} (slots ${strip.slots.join(',')})`);
      roads.push({ ...rest, origin: road.origin, arrival: road.arrival, reducedMotion: road.reducedMotion, judgments, strip });
    }
    const seconds = (Date.now() - started) / 1000;
    await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify({ viewport: VIEWPORT, castScale: CAST_SCALE, slotMs: SLOT_MS, lm: 'fixture', seconds, roads }, null, 2)}\n`, 'utf8');
    console.log(`wrote ${path.join(options.out, 'manifest.json')} (${seconds.toFixed(1)} s)`);
  } finally {
    await fs.rm(USER_DATA, { recursive: true, force: true });
  }
}

app.on('window-all-closed', () => {});
main().then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
