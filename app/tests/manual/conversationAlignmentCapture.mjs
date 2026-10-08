// 会話の言葉の並び（枠の幅・寄せ・中の揃え・字の大きさ・主人公の色）を、製品の通常の道で一つの窓の大きさに撮る手回しの道具
// （*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/conversationAlignmentCapture.mjs --repo-root <絶対パス> --out <絶対パス> --viewport <幅>x<高さ>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い（--viewport は例えば 1440x900）。--repo-root の製品（app/src・app/public・data・
// content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。
// LM は固定応答（FIXTURE の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。--out は無いか空であること。
//
// 撮る姿（png・--viewport の大きさ）。どの枚も、言葉は製品の書く口から送った主人公の言葉と、固定応答の LM が返した相手の言葉で、
// 括弧の地の文の切り分けは製品の表示（displayMessages）のまま:
//   hub          露台（ルーティングハブ）で二往復した姿（hub-top は同じ列を上端まで遡った姿）。相手の長い地の文・相手の短い一言・主人公の短い一言・相手の長く折り返す
//                言葉・主人公の括弧つきの長い地の文・主人公の長く折り返す言葉・相手の短い一言が列に並ぶ。
//   day          学院の人と話す昼の会話（data-conversation-kind="field"・場所の絵の上）で同じ二往復をした姿（day-top も同じ）。
//   lounge       談話室で主人公が括弧つきの地の文と言葉を一度送り、三人が返した後の姿（主人公の手番）。
//   dungeon      ダンジョンの記録（#dungeon-journal）に、day の列の行の写しを置いて描いた姿（歩かせない。主人公の言葉の色を見る）。
//   graduation   卒業の会話（#academy-conversation-session）の列に、day の列の行の写しを置いて描いた姿（主人公の言葉の色を見る）。
//   greenhouse   薬草温室（herbology_garden へ動いてから入る field の昼の会話）で、相手の地の文と主人公の短い一言が交互に積まれた姿。
//   errand       依頼の到着の画面（?initialScreen=academy-errand）の一枚目の札から入る昼の会話（errand）で day と同じ二往復をした姿。
//   study-circle 研究会の到着の画面（?initialScreen=academy-study-circle）の一枚目の札から入る昼の会話（study-circle）で同じ二往復をした姿。
//   atelier      錬成室（?initialScreen=academy-atelier）で一人目の子に会いに行く昼の会話（atelier）で同じ二往復をした姿。一時のプレイに
//                錬成室の解放（光魔法の習熟 80）と迷宮の素材（製品の grantAllDungeonMaterials）を種まきし、製品の POST /api/atelier/synthesize
//                で一人錬成してから入る。
//   event        出来事の旗（event.opening_mentor_intro.ready・相手 character_001）を一時のプレイの runtime_state に立てておき、露台で
//                学院マップへ行く一言を送って、学院マップに着いた製品が始める出来事の昼の会話（event）で同じ二往復をした姿。
// 各枚の時点で、言葉の列の矩形と、列の行ごとの種類・枠の矩形・字の大きさ・色・揃え（computed style）・見えているかを読み、
// 案内人の立ち絵・左の情報の引き出し・相手の顔の矩形と一緒に <out>/manifest.json に書く。言葉の列の枚には、相手の行の枠の右の限り
// （枠の左＋行の中の幅の 82%）の最も右と、主人公の行の枠の右の最も右と、その差（gap）を添えて一行に出す。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const RUN_LIMIT_MS = 600000;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--viewport'];
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
  }
  for (const key of ['--repo-root', '--out']) {
    if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  const size = /^(\d+)x(\d+)$/.exec(parsed['--viewport']);
  if (!size) throw new Error(`--viewport must be <width>x<height>, got ${parsed['--viewport']}`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], viewport: { width: Number(size[1]), height: Number(size[2]) } };
}

// ── 言葉（撮影のための仮の文。製品の本文ではない） ──────────────────────────────────────────────────────────
// 相手の言葉は会話ごとに順に返す: 開き（長い地の文＋短い一言）→ 一往復目（長く折り返す言葉）→ 二往復目（短い一言）。
const PARTNER_LINES = [
  '（星図を巻きかけた手を止め、手すりに肘をついて、夜の向こうに沈みかけた塔の灯りをひとつずつ数えるように眺めてから、ゆっくりとこちらへ振り返る）おかえりなさい。',
  '今週は少し風が冷たくなってきましたね。北の塔の観測室では、夜明け前にいちばん明るい星が地平から上がってくるころなので、早起きの子たちが毛布を抱えて階段をのぼっていくのを、窓からよく見かけるんですよ。',
  'ふふ、そうですね。'
];
// 薬草温室の場面: 相手は地の文の長い仕草と短い一言、主人公は短い一言だけを交互に置く。
const GREENHOUSE_PARTNER_LINES = [
  '（鉢の縁にこぼれた土を指先で払い、光る葉の脈をひとつずつ確かめるように覗きこんでから、こちらに気づいて小さく顔を上げる）……いらっしゃい。',
  '（葉に添えていた手をそっと引き、言葉を選ぶように視線を鉢の列へ落として、しばらく黙ったまま土の匂いを確かめている）……ええ。たぶん、そうなんだと思います。',
  '（倒れかけた鉢を両手で起こし、根もとの土を押さえながら、答えを出すのに時間がかかるように、ゆっくりとまばたきをする）……いいえ。ただ、静かな方が好きなだけです。',
  '（如雨露の口を傾けかけて止め、光る葉の上に落ちた雫が転がっていくのを、眺めるともなく眺めている）'
];
// 出来事: 露台の開き・学院マップへの一言への返し・送り出しの三つのあとに、day と同じ並びの言葉。
const EVENT_PARTNER_LINES = [PARTNER_LINES[0], PARTNER_LINES[2], PARTNER_LINES[2], ...PARTNER_LINES];
const GREENHOUSE_PLAYER_LINES = ['この鉢、元気がないのか？', '静かなところが好きなのか？', 'また来てもいいか？'];
const PLAYER_SHORT = 'うん、ただいま。';
const PLAYER_LONG = '（手すりの冷たさを確かめるように指を滑らせ、塔の灯りのいちばん高いところを探して目を細めたまま、しばらく言葉を選んでいる）その観測室、一度だけ連れていってもらったことがあるんだ。夜明けの少し前に、空の端がほんのり明るくなっていくのを、みんなで黙って眺めていた。';
const PLAYER_LOUNGE = '（茶碗を置いて、窓の外の夕焼けがゆっくり紫に沈んでいくのをしばらく眺めながら、肩の力を抜いて座りなおす）三問目、最後まで迷ったけど、みんなの話を聞いていたら、なんだかどうでもよくなってきました。';
const FIXTURE_EXPRESSIONS = ['joy', 'smug', 'shy', 'surprised', 'determined', 'worried'];
const FIXTURE_LOUNGE_LINES = [
  '試験明けの紅茶は格別ですね。答え合わせ、もう済みました？',
  '済んだ。三問目は捨てた。',
  '（茶碗を両手で包んで）……あれは、問いの方が少し、ずるい。'
];
const FIXTURE_REFLECTION_LINE = '主人公と少し話した。';
// 錬成の人格（紹介文と話し方）。
const FIXTURE_HOMUNCULUS_PERSONA = '紹介文：錬成の光から生まれたばかりの、静かで好奇心の強い子。鉢や星の名を一つずつ覚えるのが好き。\n話し方：短い言葉を、ゆっくり確かめるように話す。丁寧語。';
// 依頼・研究会の札の文（構造化の骨組み）と、相手が自分の口で持ちかける一言。
const FIXTURE_OFFER_RECORD = { title: '温室の鉢の植え替え', situation: '温室の棚に、根の詰まった鉢が十ほど並んでいる。', motivation: '週末の品評会までに鉢を整えておきたい。' };
const FIXTURE_OFFER_APPEAL = 'ねえ、少しだけ手を貸してもらえないかな。温室の鉢がどれも窮屈そうで、ひとりだと週末までに間に合いそうにないんだ。';
const FIXTURE_PROMPT_ANSWERS = [
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['場所移動の合意', 'false'],
  ['継続したいと思うか', 'true'],
  ['この談話の場に残っていたいと思っているか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false'],
  ['のタイトルと本文を平文で出力する', 'タイトル: 会話\n本文: 主人公と言葉を交わした。'],
  ['memory_recordの本文だけ', '主人公と穏やかに話した。'],
  ['の達成条件が、ここまでの会話で満たされたかを判定する', 'false'],
  ['【紹介文】と【話し方】の2つを書く', FIXTURE_HOMUNCULUS_PERSONA],
  ['この依頼はすでに内容が確定している', FIXTURE_OFFER_APPEAL],
  ['この研究会はすでに内容が確定している', FIXTURE_OFFER_APPEAL]
];
const ATELIER_SEED_MAGIC_KEY = 'light';
const EVENT_SEED_FLAG = 'event.opening_mentor_intro.ready';
const EVENT_SEED_CHARACTER = 'character_001';
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

function createFixtureLm(hubLines, partnerLines) {
  // lounge は道具が露台で談話室へ行く一言を送るときに立てる（それより後の言葉はすべて談話室の三人の言葉）。
  const state = { emotionAnswers: 0, partnerLines: 0, loungeLines: 0, lounge: false };
  function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') {
      const expression = FIXTURE_EXPRESSIONS[state.emotionAnswers % FIXTURE_EXPRESSIONS.length];
      state.emotionAnswers += 1;
      return { kind: `${schemaName} ${expression}`, content: JSON.stringify({ expression }) };
    }
    if (schemaName === 'work_record_recall_choice') return { kind: schemaName, content: JSON.stringify({ work_record_ids: [] }) };
    if (schemaName === 'homunculus_face_selection') {
      const face = /^- (\S+) ／/m.exec(prompt);
      if (!face) throw new Error('fixture lm: the face selection prompt lists no candidate');
      return { kind: `${schemaName} ${face[1]}`, content: JSON.stringify({ face_id: face[1] }) };
    }
    if (schemaName === 'errand_offer_record' || schemaName === 'study_circle_offer_record') return { kind: schemaName, content: JSON.stringify(FIXTURE_OFFER_RECORD) };
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
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) {
      if (state.lounge) {
        const line = FIXTURE_LOUNGE_LINES[state.loungeLines % FIXTURE_LOUNGE_LINES.length];
        state.loungeLines += 1;
        return { kind: 'lounge-line', content: line };
      }
      if (state.partnerLines >= partnerLines.length) throw new Error(`fixture lm: no partner line left (asked ${state.partnerLines + 1} times)`);
      const line = partnerLines[state.partnerLines];
      state.partnerLines += 1;
      return { kind: `partner-line ${state.partnerLines}`, content: line };
    }
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: FIXTURE_REFLECTION_LINE };
    throw new Error(`fixture lm: unknown request (model ${body.model}, stream ${body.stream === true}): ${prompt.slice(-160)}`);
  }
  return { answer, state };
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

async function startProduct(repoRoot, partnerLines, seed) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-alignment-capture-'));
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
    const area = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    if (seed) await seed({ slotRoot: area.root, product });
    const fixture = createFixtureLm(hubLines, partnerLines);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = fixture.answer(body);
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
      lmFailures,
      lmLog,
      lm: fixture.state,
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
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js,
    pageErrors,
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
      throw new Error(`timed out waiting for ${label} (screen: ${await js("document.querySelector('.screen.active')?.id ?? null").catch(() => null)})`);
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

// ── 製品の通常の道 ─────────────────────────────────────────────────────────────────────────────────────────
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const DAY_READY = `document.querySelector('#conversation-day-screen.active[data-conversation-kind]') && !${VEIL_UP} && !${LOADING_ACTIVE} && !document.querySelector('#conversation-day-send').disabled`;
const LOUNGE_ACTIVE = `(document.querySelector('#academy-lounge-screen.active') && !${VEIL_UP} && !${LOADING_ACTIVE})`;
const PLAYER_TURN = `(${LOUNGE_ACTIVE} && !document.querySelector('#academy-lounge-input').disabled)`;
const rowCount = (stream) => `document.querySelectorAll('${stream} .chat-message').length`;

// 列の行ごとの記録: 種類・字の頭・枠（.message-bubble）の矩形・字（p）の computed style・見えているか。
const streamRecord = (stream) => `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
  const list = document.querySelector('${stream}');
  const lr = list.getBoundingClientRect();
  const kinds = ['player-message', 'player-narration-message', 'narration-message', 'character-message'];
  const rows = [...list.querySelectorAll('.chat-message')].map((row) => {
    const bubble = row.querySelector('.message-bubble');
    const text = bubble.querySelector('p');
    const s = getComputedStyle(text);
    const r = bubble.getBoundingClientRect();
    const rs = getComputedStyle(row);
    const rowInner = row.clientWidth - parseFloat(rs.paddingLeft) - parseFloat(rs.paddingRight);
    return {
      kind: kinds.find((k) => row.classList.contains(k)),
      head: text.textContent.slice(0, 14),
      row: box(row),
      bubble: box(bubble),
      bubbleRightLimit: Math.round(r.left + rowInner * 0.82),
      bubbleMaxWidth: getComputedStyle(bubble).maxWidth,
      fontSize: s.fontSize,
      color: s.color,
      textAlign: s.textAlign,
      lines: Math.round(text.getBoundingClientRect().height / parseFloat(s.lineHeight)),
      inView: r.top >= lr.top + lr.height * 0.16 && r.bottom <= lr.bottom
    };
  });
  const partner = rows.filter((row) => row.kind === 'character-message' || row.kind === 'narration-message');
  const player = rows.filter((row) => row.kind === 'player-message' || row.kind === 'player-narration-message');
  const partnerRight = partner.length > 0 ? Math.max(...partner.map((row) => row.bubbleRightLimit)) : null;
  const playerRight = player.length > 0 ? Math.max(...player.map((row) => row.bubble[0] + row.bubble[2])) : null;
  const gap = partnerRight !== null && playerRight !== null ? { partnerRight, playerRight, px: playerRight - partnerRight } : null;
  return { screen: document.querySelector('.screen.active')?.id ?? null, stream: box(list), gap, rows };
})()`;

const HUB_NEIGHBOURS = `({
  standee: (() => { const r = document.querySelector('#routing-hub-standee').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })(),
  drawer: [...document.querySelectorAll('#routing-hub-screen [class*="drawer"], #routing-hub-screen [class*="rail"]')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => { const r = el.getBoundingClientRect(); return { el: el.id || el.className, box: [r.left, r.top, r.width, r.height].map(Math.round) }; }).slice(0, 6)
})`;
const DAY_NEIGHBOURS = `({
  face: [...document.querySelectorAll('#conversation-day-screen .cl-face')].filter((el) => el.getBoundingClientRect().width > 0).map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); }),
  kind: document.querySelector('#conversation-day-screen').dataset.conversationKind
})`;

const LOUNGE_RECORD = `(() => {
  const words = [...document.querySelectorAll('#academy-lounge-message-stream .lounge-voice .lounge-word')];
  return {
    screen: document.querySelector('.screen.active')?.id ?? null,
    words: words.map((word) => {
      const s = getComputedStyle(word);
      return { seat: word.closest('.lounge-voice').dataset.seat, gesture: word.classList.contains('is-gesture'), head: word.textContent.slice(0, 14), fontSize: s.fontSize, color: s.color, textAlign: s.textAlign };
    })
  };
})()`;

async function walkToHub({ page, product, steps }) {
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(motionSettled('#routing-hub-screen'), 'the terrace settled', 30000);
  steps.push('title → ロード → slot → terrace');
}

// 書く口に一言を書いて送り、相手の言葉が列に増えて書く口が戻るまで待つ。
async function say(ctx, { stream, input, send, ready }, line) {
  const { page } = ctx;
  const before = await page.js(rowCount(stream));
  await page.type(`document.querySelector('${input}')`, input, line);
  await page.click(`document.querySelector('${send}')`, send);
  await page.waitFor(`document.querySelector('${input}').value === ''`, `${input} sent`, 10000);
  await page.waitFor(`${rowCount(stream)} > ${before} + 1 && ${ready}`, `the reply after: ${line.slice(0, 12)}`, LM_WAIT_MS);
  ctx.steps.push(`say: ${line.slice(0, 20)}…`);
}

// 列を上端まで戻す（言葉が積まれて上の行が列の上の溶けに入ったとき、遡って読む姿）。
async function scrollToTop(page, stream) {
  await page.js(`document.querySelector('${stream}').scrollTop = 0; true`);
  await sleep(SETTLE_MS);
}

async function settle(page, screen) {
  await page.waitFor(motionSettled(screen), `${screen} settled`, 30000);
  await sleep(SETTLE_MS);
}

async function runHubAndLounge(ctx) {
  const { page, product } = ctx;
  const hub = { stream: '#routing-hub-message-stream', input: '#routing-hub-input', send: '#routing-hub-send', ready: HUB_READY };
  await walkToHub(ctx);
  await page.waitFor(`${rowCount(hub.stream)} >= 2`, 'the terrace opening', LM_WAIT_MS);
  await say(ctx, hub, PLAYER_SHORT);
  await say(ctx, hub, PLAYER_LONG);
  await settle(page, '#routing-hub-screen');
  await ctx.shoot('hub', streamRecord(hub.stream), HUB_NEIGHBOURS);
  await scrollToTop(page, hub.stream);
  await ctx.shoot('hub-top', streamRecord(hub.stream), HUB_NEIGHBOURS);
  product.lm.lounge = true;
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', product.hubLines.lounge);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  ctx.steps.push(`say on the terrace: ${product.hubLines.lounge}`);
  await page.waitFor(PLAYER_TURN, 'the first lounge player turn', LM_WAIT_MS);
  const before = await page.js("document.querySelectorAll('#academy-lounge-message-stream .lounge-word').length");
  await page.type("document.querySelector('#academy-lounge-input')", 'lounge input', PLAYER_LOUNGE);
  await page.click("document.querySelector('#academy-lounge-send')", 'lounge send mark');
  await page.waitFor(`document.querySelectorAll('#academy-lounge-message-stream .lounge-word').length > ${before} && document.querySelector('#academy-lounge-input').disabled`, 'the lounge round started', LM_WAIT_MS);
  await page.waitFor(PLAYER_TURN, 'the next lounge player turn', LM_WAIT_MS);
  ctx.steps.push(`lounge say: ${PLAYER_LOUNGE.slice(0, 20)}…`);
  await settle(page, '#academy-lounge-screen');
  await ctx.shoot('lounge', LOUNGE_RECORD, '({})');
}

const DAY = { stream: '#conversation-day-message-stream', input: '#conversation-day-input', send: '#conversation-day-send', ready: DAY_READY };

async function runDay(ctx) {
  const { page, product } = ctx;
  const day = DAY;
  await page.load(`${product.base}/?initialScreen=conversation-day`);
  await page.js("document.body.classList.add('play-mode'); true");
  await page.waitFor(`${DAY_READY} && ${rowCount(day.stream)} >= 2`, 'the day conversation opening', LM_WAIT_MS);
  ctx.steps.push('?initialScreen=conversation-day (body.play-mode) → field conversation');
  await say(ctx, day, PLAYER_SHORT);
  await say(ctx, day, PLAYER_LONG);
  await settle(page, '#conversation-day-screen');
  await ctx.shoot('day', streamRecord(day.stream), DAY_NEIGHBOURS);
  await scrollToTop(page, day.stream);
  await ctx.shoot('day-top', streamRecord(day.stream), DAY_NEIGHBOURS);
  // ダンジョンの記録と卒業の会話は、歩かせず・卒業へ進めず、昼の会話で製品が作った行の写しをその画面の部品に置いて描く。
  await placeRows(page, '#academy-dungeon-screen', '#dungeon-journal', "screen.dataset.scene = 'play'; const block = document.createElement('div'); block.className = 'dn-talk-block'; block.append(...rows); stream.replaceChildren(block);");
  ctx.steps.push('copy of the day rows placed in #dungeon-journal (scene play)');
  await settle(page, '#academy-dungeon-screen');
  await ctx.shoot('dungeon', streamRecord('#dungeon-journal'), '({})');
  await placeRows(page, '#academy-conversation-session-screen', '#academy-conversation-session-message-stream', 'stream.replaceChildren(...rows);');
  ctx.steps.push('copy of the day rows placed in #academy-conversation-session-message-stream');
  await settle(page, '#academy-conversation-session-screen');
  await ctx.shoot('graduation', streamRecord('#academy-conversation-session-message-stream'), '({})');
}

// 薬草温室: 製品の場所の移り（POST /api/field/move）で薬草温室に立ってから field の昼の会話に入り、主人公の短い一言を三度送る。
async function runGreenhouse(ctx) {
  const { page, product } = ctx;
  const moved = await fetch(`${product.base}/api/field/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ location_id: 'herbology_garden' }) });
  if (!moved.ok) throw new Error(`POST /api/field/move answered ${moved.status}: ${await moved.text()}`);
  ctx.steps.push('POST /api/field/move herbology_garden');
  await page.load(`${product.base}/?initialScreen=conversation-day`);
  await page.js("document.body.classList.add('play-mode'); true");
  await page.waitFor(`${DAY_READY} && ${rowCount(DAY.stream)} >= 2`, 'the greenhouse conversation opening', LM_WAIT_MS);
  const place = await page.js("document.querySelector('#conversation-day-screen .cl-stage-name')?.textContent ?? null");
  if (place !== '薬草温室') throw new Error(`the greenhouse conversation stands at ${JSON.stringify(place)}`);
  ctx.steps.push('?initialScreen=conversation-day (body.play-mode) → field conversation at 薬草温室');
  for (const line of GREENHOUSE_PLAYER_LINES) await say(ctx, DAY, line);
  await settle(page, '#conversation-day-screen');
  await ctx.shoot('greenhouse', streamRecord(DAY.stream), DAY_NEIGHBOURS);
}

// 依頼・研究会: 到着の画面の一枚目の札から昼の会話に入り（製品が data-conversation-kind に種類を立てる）、day と同じ二往復をする。
function roomRun(kind) {
  return async function runRoom(ctx) {
    const { page, product } = ctx;
    await page.load(`${product.base}/?initialScreen=academy-${kind}`);
    await page.js("document.body.classList.add('play-mode'); true");
    await page.waitFor(`document.querySelector('#academy-${kind}-offers .room-card-button:not(:disabled)') && !${VEIL_UP} && !${LOADING_ACTIVE}`, `the ${kind} offers`, LM_WAIT_MS);
    await settle(page, `#academy-${kind}-screen`);
    await page.click(`document.querySelector('#academy-${kind}-offers .room-card-button')`, `the first ${kind} offer`);
    await page.waitFor(`document.querySelector('#academy-${kind}-offers .room-card[data-chosen]')`, `the first ${kind} offer chosen`, 10000);
    ctx.steps.push(`?initialScreen=academy-${kind} → first offer`);
    await page.waitFor(`${DAY_READY} && document.querySelector('#conversation-day-screen').dataset.conversationKind === '${kind}' && ${rowCount(DAY.stream)} >= 2`, `the ${kind} conversation opening`, LM_WAIT_MS);
    await say(ctx, DAY, PLAYER_SHORT);
    await say(ctx, DAY, PLAYER_LONG);
    await settle(page, '#conversation-day-screen');
    await ctx.shoot(kind, streamRecord(DAY.stream), DAY_NEIGHBOURS);
  };
}

// 新しいプレイの slot の中の game_data の一つを、製品の保存の口（createStorageApi）で読んで書き換える。
async function editSlotJson({ slotRoot, product }, relativePath, edit) {
  const { createStorageApi } = await product('storage.mjs');
  const storage = createStorageApi({ root: slotRoot });
  const value = await storage.readJson(relativePath);
  edit(value);
  await storage.writeJson(relativePath, value);
}

// 錬成室の種まき: 光魔法の習熟を解放の線（80）に上げ、製品の grantAllDungeonMaterials で迷宮の素材を各 10 持たせる。
async function seedAtelier(slot) {
  const { HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } = await slot.product('homunculusUnlock.mjs');
  await editSlotJson(slot, 'game_data/runtime/player_parameters.json', (parameters) => {
    const entry = parameters.magic?.[ATELIER_SEED_MAGIC_KEY];
    if (!entry || typeof entry.value !== 'number') throw new Error(`player parameters have no magic.${ATELIER_SEED_MAGIC_KEY}.value`);
    entry.value = HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD;
  });
  const { grantAllDungeonMaterials } = await slot.product('economy.mjs');
  await grantAllDungeonMaterials({ root: slot.slotRoot });
}

// 出来事の種まき: 会話の判定が旗を立てたときと同じ形（global_flags と event_flag_sources の相手）を runtime_state に置く。
async function seedEvent(slot) {
  await editSlotJson(slot, 'game_data/runtime_state.json', (state) => {
    state.global_flags = { ...(state.global_flags ?? {}), [EVENT_SEED_FLAG]: true };
    state.event_flag_sources = { ...(state.event_flag_sources ?? {}), [EVENT_SEED_FLAG]: { character_id: EVENT_SEED_CHARACTER, conversation_id: null, achieved_at: null } };
  });
}

async function postProduct(product, pathname, body) {
  const response = await fetch(`${product.base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`POST ${pathname} answered ${response.status}: ${await response.text()}`);
  return response.json();
}

async function runAtelier(ctx) {
  const { page, product } = ctx;
  const answered = await fetch(`${product.base}/api/atelier`);
  if (!answered.ok) throw new Error(`GET /api/atelier answered ${answered.status}: ${await answered.text()}`);
  const atelier = await answered.json();
  const material = atelier.materials?.find((entry) => entry.held >= 10) ?? null;
  if (!material) throw new Error(`no seeded material reaches 10 in GET /api/atelier: ${JSON.stringify(atelier.materials ?? null)}`);
  await postProduct(product, '/api/atelier/synthesize', { mode: 'manual', name: 'シズク', skeleton: '静かで好奇心の強い子。', materials: [{ item_id: material.item_id, quantity: 10 }] });
  ctx.steps.push(`POST /api/atelier/synthesize (${material.item_id} x10)`);
  await page.load(`${product.base}/?initialScreen=academy-atelier`);
  await page.js("document.body.classList.add('play-mode'); true");
  await page.waitFor(`document.querySelector('#academy-atelier-screen .academy-atelier-slot-talk:not(:disabled)') && !${VEIL_UP} && !${LOADING_ACTIVE}`, 'the atelier child', LM_WAIT_MS);
  await settle(page, '#academy-atelier-screen');
  await page.click("document.querySelector('#academy-atelier-screen .academy-atelier-slot-talk')", 'the first child');
  ctx.steps.push('?initialScreen=academy-atelier → 会いに行く');
  await page.waitFor(`${DAY_READY} && document.querySelector('#conversation-day-screen').dataset.conversationKind === 'atelier' && ${rowCount(DAY.stream)} >= 2`, 'the atelier conversation opening', LM_WAIT_MS);
  await say(ctx, DAY, PLAYER_SHORT);
  await say(ctx, DAY, PLAYER_LONG);
  await settle(page, '#conversation-day-screen');
  await ctx.shoot('atelier', streamRecord(DAY.stream), DAY_NEIGHBOURS);
}

async function runEvent(ctx) {
  const { page, product } = ctx;
  const hub = { stream: '#routing-hub-message-stream', input: '#routing-hub-input', send: '#routing-hub-send', ready: HUB_READY };
  await walkToHub(ctx);
  await page.waitFor(`${rowCount(hub.stream)} >= 2`, 'the terrace opening', LM_WAIT_MS);
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', product.hubLines['academy-map']);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  ctx.steps.push(`say on the terrace: ${product.hubLines['academy-map']}`);
  await page.waitFor(`${DAY_READY} && document.querySelector('#conversation-day-screen').dataset.conversationKind === 'event' && ${rowCount(DAY.stream)} >= 2`, 'the event conversation opening', LM_WAIT_MS);
  await say(ctx, DAY, PLAYER_SHORT);
  await say(ctx, DAY, PLAYER_LONG);
  await settle(page, '#conversation-day-screen');
  await ctx.shoot('event', streamRecord(DAY.stream), DAY_NEIGHBOURS);
}

// 昼の会話の列の行（製品の createMessageRows が作ったもの）を写し、画面を一つだけ active にして、その画面の列へ置く。
async function placeRows(page, screenSelector, streamSelector, place) {
  await page.js(`(() => {
    const rows = [...document.querySelectorAll('#conversation-day-message-stream .chat-message')].map((row) => { const copy = row.cloneNode(true); copy.classList.remove('pop-in'); return copy; });
    for (const active of document.querySelectorAll('.screen.active')) active.classList.remove('active');
    const screen = document.querySelector('${screenSelector}');
    screen.classList.add('active');
    const stream = document.querySelector('${streamSelector}');
    ${place}
    return true;
  })()`);
}

function createShooter(ctx) {
  return async function shoot(file, recordExpr, neighboursExpr) {
    const target = path.join(ctx.options.out, `${file}.png`);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
    await ctx.page.moveAway();
    await ctx.page.js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const record = await ctx.page.js(recordExpr);
    const neighbours = await ctx.page.js(neighboursExpr);
    const bytes = await ctx.page.png();
    const { viewport } = ctx.options;
    if (bytes.readUInt32BE(16) !== viewport.width || bytes.readUInt32BE(20) !== viewport.height) throw new Error(`${file}.png is not ${viewport.width}x${viewport.height}`);
    await fs.writeFile(target, bytes);
    ctx.shots.push({ file: `${file}.png`, ...record, neighbours });
    console.log(`shot ${file}.png ${JSON.stringify({ ...record, neighbours })}`);
    if (record.gap) console.log(`gap ${ctx.options.viewport.width}x${ctx.options.viewport.height} ${file}: partner frame right ${record.gap.partnerRight} → player frame right ${record.gap.playerRight} = ${record.gap.px}px (stream ${record.stream[2]}px)`);
  };
}

async function withProduct(options, shots, steps, partnerLines, run, seed = null) {
  const started = Date.now();
  const product = await startProduct(options.repoRoot, partnerLines, seed);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard, options.viewport);
  const ctx = { options, product, page, steps, shots };
  ctx.shoot = createShooter(ctx);
  let watchdog;
  try {
    await Promise.race([
      run(ctx),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`the run exceeded ${RUN_LIMIT_MS / 1000} s`)), RUN_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    guard();
  } catch (error) {
    console.log(`stopped after: ${steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    console.log(`  last LM requests: ${JSON.stringify(product.lmLog.slice(-12))}`);
    throw error;
  } finally {
    page.close();
    await product.stop();
  }
  if (page.pageErrors.length > 0) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
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
  const shots = [];
  const steps = [];
  await withProduct(options, shots, steps, PARTNER_LINES, runHubAndLounge);
  await withProduct(options, shots, steps, PARTNER_LINES, runDay);
  await withProduct(options, shots, steps, GREENHOUSE_PARTNER_LINES, runGreenhouse);
  await withProduct(options, shots, steps, PARTNER_LINES, roomRun('errand'));
  await withProduct(options, shots, steps, PARTNER_LINES, roomRun('study-circle'));
  await withProduct(options, shots, steps, PARTNER_LINES, runAtelier, seedAtelier);
  await withProduct(options, shots, steps, EVENT_PARTNER_LINES, runEvent, seedEvent);
  const seconds = (Date.now() - started) / 1000;
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify({ repoRoot: options.repoRoot, viewport: options.viewport, seconds, steps, shots }, null, 2)}\n`);
  console.log(`run done in ${seconds.toFixed(1)} s`);
}

app.on('window-all-closed', () => {});
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('FAILED', error.stack ?? error.message);
    app.exit(1);
  });
