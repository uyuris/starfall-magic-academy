// 談話室（輪の三席に三人が座り、言葉が話した人の頭の上に乗る姿）を、露台から送り出す製品の通常の道で 1440x900 に撮る手回しの道具
// （*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/loungeTerraceCapture.mjs --repo-root <絶対パス> --out <絶対パス> --plan <絶対パス>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・app/public・data・
// content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。
// LM は固定応答（FIXTURE の表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。--out は無いか空であること。--plan は
// 構成案の一枚（1440x900 の png）で、構成案（左）と作った姿（右）を並べた一枚に使う。
//
// 撮る姿（png・1440x900）:
//   lounge-entered       談話室へ入った直後（待ちの層が薄れ、最初の人の言葉が乗った）
//   lounge-round-3       三人とのやり取りが 3 往復進んだ姿（主人公の手番）
//   lounge-long          長いやり取り（7 往復）の姿（主人公の手番）
//   lounge-departed      途中で一人が退出した後の姿（その人の席は空いたまま）
//   lounge-leaving       談話室を出る瞬間（出るを押し、POST /api/lounge/end を止めている間。談話室の絵の上の待ち）
//   lounge-compare       構成案（左）と lounge-long（右）を並べた一枚（2880x900）
// 三人が同時に話す場面は製品に無い（一人ずつ順に話す）ので撮らない。
// 談話室の画面の DOM の照合（週の字・月相の紋・説明の文・字の釦・顔の札の付いた言葉の箱が無いこと）を lounge-long の時点で一度行い、
// 撮った各枚の席・言葉の記録と一緒に <out>/manifest.json に書く。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const RUN_LIMIT_MS = 600000;
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
// 言葉は撮影のための仮の文（製品の本文ではない）。三人の言葉は順に回し、主人公の言葉は往復ごとに一つ。
const FIXTURE_EXPRESSIONS = ['joy', 'smug', 'shy', 'surprised', 'determined', 'worried'];
const FIXTURE_LOUNGE_LINES = [
  '試験明けの紅茶は格別ですね。答え合わせ、もう済みました？',
  '済んだ。三問目は捨てた。',
  '（茶碗を両手で包んで）……あれは、問いの方が少し、ずるい。',
  '同感です。配点に見合わない問いは、真っ先に削りたくなりますね。',
  'お前は何でも勘定にするな。',
  '……なら、茶菓子は持ってくる。次の試験のあとも。',
  '（窓の外へ目をやって）風が気持ちいい。今日はここでゆっくりしたいな。',
  '次の実技は組みで出るらしいぞ。誰と組むか、もう決めたか？',
  'まだ決めていません。……（少し考えて）でも、この顔ぶれなら心強いです。',
  'ふふ、頁をめくる音だけ聞いていると、試験のことなんて忘れそうです。',
  '忘れるな。来週には返ってくる。',
  '（菓子皿を押しやって）……甘いものを食べると、点のことはどうでもよくなる。'
];
const FIXTURE_DEPARTURE_LINE = '（本を閉じて立ち上がり）では、私は先に部屋へ戻りますね。おやすみなさい。';
const FIXTURE_HUB_OPENING = '（星図を巻きながら）おかえりなさい。今週はどこへ行きましょうか。';
const FIXTURE_REFLECTION_LINE = '談話室で主人公と少し話した。';
const FIXTURE_PROMPT_ANSWERS = [
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false'],
  ['のタイトルと本文を平文で出力する', 'タイトル: 談話室の午後\n本文: 談話室で主人公と言葉を交わした。'],
  ['memory_recordの本文だけ', '談話室で主人公と穏やかに話した。']
];
const PLAYER_LINES = [
  '三問目、最後まで迷いました。',
  '次の試験のあとも、ここで答え合わせしませんか。',
  'この部屋、窓からの風が気持ちいいですね。',
  '実技の組み、まだ誰とも約束していないんです。',
  'みなさんは、試験の前の晩に何をしていますか。',
  '茶菓子、私も今度持ってきます。',
  'もう少しだけ、ここで話していてもいいですか。',
  '今日は来てよかったです。'
];
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

function createFixtureLm(hubLines) {
  const state = { emotionAnswers: 0, loungeLines: 0, departNext: false, departures: 0 };
  function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') {
      const expression = FIXTURE_EXPRESSIONS[state.emotionAnswers % FIXTURE_EXPRESSIONS.length];
      state.emotionAnswers += 1;
      return { kind: `${schemaName} ${expression}`, content: JSON.stringify({ expression }) };
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
    if (prompt.includes('この談話の場に残っていたいと思っているか')) {
      const stay = !state.departNext;
      state.departNext = false;
      if (!stay) state.departures += 1;
      return { kind: `lounge-stay ${stay}`, content: String(stay) };
    }
    if (prompt.includes('この談話の場から自分だけが退出する')) return { kind: 'lounge-departure', content: FIXTURE_DEPARTURE_LINE };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) {
      if (prompt.includes(marker)) return { kind: marker, content };
    }
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) {
      if (prompt.includes('寮の談話室')) {
        const line = FIXTURE_LOUNGE_LINES[state.loungeLines % FIXTURE_LOUNGE_LINES.length];
        state.loungeLines += 1;
        return { kind: 'lounge-line', content: line };
      }
      return { kind: 'hub-line', content: FIXTURE_HUB_OPENING };
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

async function startProduct(repoRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-terrace-capture-'));
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
    const fixture = createFixtureLm(hubLines);
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
  // CDP Fetch: 止める要求（fragment を含む・method が合う最初の一つ）を持ち、release で通す。
  const holds = [];
  cdp.on('message', (event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const hold = holds.find((entry) => !entry.requestId && params.request.url.includes(entry.fragment) && params.request.method === entry.method);
    if (!hold) {
      send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    hold.requestId = params.requestId;
    hold.resolve();
  });
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
      for (const character of text) {
        await send('Input.insertText', { text: character });
        await sleep(15);
      }
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    async hold(fragment, method) {
      let resolve;
      const paused = new Promise((r) => { resolve = r; });
      const hold = { fragment, method, resolve, requestId: null };
      holds.push(hold);
      await send('Fetch.enable', { patterns: holds.map((entry) => ({ urlPattern: `*${entry.fragment}*`, requestStage: 'Request' })) });
      return {
        paused,
        async release() {
          await paused;
          await send('Fetch.continueRequest', { requestId: hold.requestId });
          holds.splice(holds.indexOf(hold), 1);
          if (holds.length === 0) await send('Fetch.disable');
        }
      };
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
const LOUNGE_ACTIVE = `(document.querySelector('#academy-lounge-screen.active') && !${VEIL_UP} && !${LOADING_ACTIVE})`;
const PLAYER_TURN = `(${LOUNGE_ACTIVE} && !document.querySelector('#academy-lounge-input').disabled)`;
const SEATS_DRAWN = "[...document.querySelectorAll('#academy-lounge-seats .lounge-seat')].every((seat) => seat.querySelector('img').complete && seat.querySelector('img').naturalWidth > 0)";
const PLAYER_WORDS = "document.querySelectorAll('#academy-lounge-message-stream .lounge-voice[data-seat=\"player\"] .lounge-word').length";

// 一枚ごとの記録: 席（置き場・人・表情・溶かし・光・空席・名・矩形）と、言葉（置き場ごとの数・見えている数・最新の言葉）。
const LOUNGE_RECORD = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && r.bottom > 0 && r.top < innerHeight; };
  const seats = [...document.querySelectorAll('#academy-lounge-seats .lounge-seat')].map((seat) => ({
    seat: seat.dataset.seat,
    characterId: seat.dataset.characterId,
    name: seat.querySelector('.lounge-seat-name').textContent,
    expression: seat.dataset.expression ?? null,
    faceFade: seat.dataset.faceFade ?? null,
    speaking: seat.hasAttribute('data-speaking'),
    departed: seat.hasAttribute('data-departed'),
    shown: visible(seat),
    well: box(seat.querySelector('.lounge-seat-well'))
  }));
  const voices = [...document.querySelectorAll('#academy-lounge-message-stream .lounge-voice')].map((voice) => {
    const words = [...voice.querySelectorAll('.lounge-word')];
    const vr = voice.getBoundingClientRect();
    const inView = words.filter((word) => { const r = word.getBoundingClientRect(); return r.bottom > vr.top + 36 && r.top < vr.bottom; });
    return {
      seat: voice.dataset.seat,
      words: words.length,
      inView: inView.length,
      newest: words.at(-1)?.textContent ?? null,
      newestOpacity: words.at(-1) ? Number(getComputedStyle(words.at(-1)).opacity) : null,
      newestColor: words.at(-1) ? getComputedStyle(words.at(-1)).color : null,
      box: box(voice)
    };
  });
  return {
    screen: document.querySelector('.screen.active')?.id ?? null,
    veil: ${VEIL_UP},
    stageName: document.querySelector('#academy-lounge-stage-name').textContent,
    inputDisabled: document.querySelector('#academy-lounge-input').disabled,
    seats,
    voices
  };
})()`;

// 談話室の画面の DOM の照合（閉じた popup の中は数えない）: 週の字・月相の紋・説明の文・字の釦・顔の札の付いた言葉の箱。
const DOM_AUDIT = `(() => {
  const screen = document.querySelector('#academy-lounge-screen');
  const open = (el) => !el.closest('[hidden]');
  const all = [...screen.querySelectorAll('*')].filter(open);
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const names = new Set([...screen.querySelectorAll('.lounge-seat-name')].map((el) => el.textContent));
  const stageName = screen.querySelector('#academy-lounge-stage-name').textContent;
  const texts = [];
  const walker = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text || !open(node.parentElement) || !shown(node.parentElement)) continue;
    texts.push({ text, holder: node.parentElement.className || node.parentElement.tagName.toLowerCase() });
  }
  const textHolders = {};
  for (const { holder } of texts) textHolders[holder] = (textHolders[holder] ?? 0) + 1;
  const weekText = texts.filter(({ text }) => /第\\s*\\d+\\s*週|\\d+\\s*\\/\\s*50/.test(text));
  const weekNodes = all.filter((el) => /week/i.test(el.id) || /week/i.test(el.className));
  const moonNodes = all.filter((el) => /moon/i.test(el.id) || /moon/i.test(el.className) || /月相/.test(el.getAttribute('aria-label') ?? '') || /月相/.test(el.getAttribute('alt') ?? ''));
  const placeholders = all.filter((el) => el.hasAttribute('placeholder')).map((el) => el.getAttribute('placeholder'));
  const explanatory = texts.filter(({ text, holder }) => holder !== 'lounge-word' && holder !== 'lounge-word is-gesture' && holder !== 'lounge-word is-new' && holder !== 'lounge-word is-gesture is-new' && !names.has(text) && text !== stageName);
  const buttons = all.filter((el) => el.tagName === 'BUTTON' && shown(el)).map((el) => ({ id: el.id || null, class: el.className, text: el.textContent.trim(), ariaLabel: el.getAttribute('aria-label') }));
  const letteredButtons = buttons.filter((b) => b.text && !names.has(b.text) && b.text !== stageName);
  const facedWordBoxes = all.filter((el) => el.matches('.chat-message, .message-face, .message-speaker, .message-bubble, .conversation-day-chat-panel, .conversation-day-composer-label'));
  return {
    weekText: weekText.map(({ text }) => text),
    weekNodes: weekNodes.map((el) => el.id || el.className),
    moonNodes: moonNodes.map((el) => el.id || el.className),
    placeholders,
    explanatoryText: explanatory,
    buttons,
    letteredButtons,
    facedWordBoxes: facedWordBoxes.length,
    visibleTextHolders: textHolders,
    stageName,
    seatNames: [...names]
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
  await sleep(SETTLE_MS);
  steps.push('title → ロード → slot → terrace');
}

// 主人公の手番で一言を書いて送る（書く口を押して書き、送るの紋を押す）。三人が話し終えて手番が戻るまで待つ。
async function playerTurn(ctx, line) {
  const { page } = ctx;
  const before = await page.js(PLAYER_WORDS);
  await page.type("document.querySelector('#academy-lounge-input')", 'lounge input', line);
  await page.click("document.querySelector('#academy-lounge-send')", 'lounge send mark');
  await page.waitFor(`${PLAYER_WORDS} > ${before} && document.querySelector('#academy-lounge-input').disabled`, 'the round started', LM_WAIT_MS);
  await page.waitFor(PLAYER_TURN, 'the next player turn', LM_WAIT_MS);
  ctx.rounds += 1;
  ctx.steps.push(`player turn ${ctx.rounds}: ${line}`);
}

async function settleLounge(ctx) {
  await ctx.page.waitFor(`${SEATS_DRAWN} && ${motionSettled('#academy-lounge-screen')}`, 'the lounge settled', 30000);
  await sleep(SETTLE_MS);
}

async function run(ctx) {
  const { page, product } = ctx;
  await walkToHub(ctx);
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', product.hubLines.lounge);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  ctx.steps.push(`say on the terrace: ${product.hubLines.lounge}`);
  // 入った直後: 待ちの層が薄れきり、最初の人の言葉が乗った姿。
  await page.waitFor(`${LOUNGE_ACTIVE} && document.querySelectorAll('#academy-lounge-message-stream .lounge-word').length > 0`, 'the lounge entered', LM_WAIT_MS);
  await page.waitFor(SEATS_DRAWN, 'the three seated', 30000);
  await sleep(400);
  await ctx.shoot('lounge-entered', '談話室へ入った直後（待ちの層が薄れ、最初の人の言葉が乗った）');
  await page.waitFor(PLAYER_TURN, 'the first player turn', LM_WAIT_MS);
  for (const line of PLAYER_LINES.slice(0, 3)) await playerTurn(ctx, line);
  await settleLounge(ctx);
  await ctx.shoot('lounge-round-3', `三人とのやり取りが ${ctx.rounds} 往復進んだ姿（主人公の手番）`);
  for (const line of PLAYER_LINES.slice(3, 7)) await playerTurn(ctx, line);
  await settleLounge(ctx);
  await ctx.shoot('lounge-long', `長いやり取り（${ctx.rounds} 往復）の姿（主人公の手番）`);
  ctx.audit = await page.js(DOM_AUDIT);
  console.log(`dom audit: ${JSON.stringify(ctx.audit)}`);
  // 次の往復の最初に話す人が、話したあと退出する（残るかの判定に一度だけ false を返す）。
  product.lm.departNext = true;
  await playerTurn(ctx, PLAYER_LINES[7]);
  if (product.lm.departures !== 1) throw new Error(`expected one departure, got ${product.lm.departures}`);
  await page.waitFor("document.querySelectorAll('#academy-lounge-seats .lounge-seat[data-departed]').length === 1", 'the departed seat', 30000);
  await settleLounge(ctx);
  await ctx.shoot('lounge-departed', '途中で一人が退出した後の姿（その人の席は空いたまま）');
  // 出る瞬間: 出るの紋を押し、POST /api/lounge/end を止めている間（談話室の絵の上の待ち）。
  const end = await page.hold('/api/lounge/end', 'POST');
  await page.click("document.querySelector('#academy-lounge-end')", 'lounge leave mark');
  ctx.steps.push('press 出る (POST /api/lounge/end held)');
  await end.paused;
  await page.waitFor(`${VEIL_UP} && document.querySelector('#place-veil').dataset.veil === 'waiting'`, 'the leaving wait', 30000);
  await sleep(1400);
  await ctx.shoot('lounge-leaving', '談話室を出る瞬間（出るを押し、POST /api/lounge/end を止めている間）');
  await end.release();
  await page.waitFor(HUB_READY, 'back on the terrace', LM_WAIT_MS);
  ctx.steps.push('back on the terrace');
}

function createShooter(ctx) {
  return async function shoot(file, note) {
    const target = path.join(ctx.options.out, `${file}.png`);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
    await ctx.page.moveAway();
    await ctx.page.js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const record = await ctx.page.js(LOUNGE_RECORD);
    const bytes = await ctx.page.png();
    if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${file}.png is not ${VIEWPORT.width}x${VIEWPORT.height}`);
    await fs.writeFile(target, bytes);
    ctx.shots.push({ file: `${file}.png`, note, rounds: ctx.rounds, ...record });
    console.log(`shot ${file}.png — ${note} ${JSON.stringify({ screen: record.screen, veil: record.veil, seats: record.seats.map((s) => `${s.seat}:${s.expression}${s.speaking ? '*' : ''}${s.departed ? '(left)' : ''}`), voices: record.voices.map((v) => `${v.seat}:${v.inView}/${v.words}`) })}`);
    return record;
  };
}

// 構成案（左）と作った姿（右）を並べた一枚。頁は一時ディレクトリの file に書き、二枚は file:// で引く。
async function writeComparison(options) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-terrace-compare-'));
  const width = VIEWPORT.width * 2;
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, show: false });
  try {
    await win.loadURL('about:blank');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    const left = new URL(`file://${options.plan}`).href;
    const right = new URL(`file://${path.join(options.out, 'lounge-long.png')}`).href;
    const html = `<html><body style="margin:0;background:#000"><div style="display:flex;width:${width}px;height:${VIEWPORT.height}px"><img style="width:${VIEWPORT.width}px;height:${VIEWPORT.height}px" src="${left}"><img style="width:${VIEWPORT.width}px;height:${VIEWPORT.height}px" src="${right}"></div></body></html>`;
    const page = path.join(scratch, 'compare.html');
    await fs.writeFile(page, html, 'utf8');
    await win.loadFile(page);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map((img) => img.decode()))');
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: VIEWPORT.height, scale: 1 } });
    await fs.writeFile(path.join(options.out, 'lounge-compare.png'), Buffer.from(data, 'base64'));
    console.log('compare lounge-compare.png (left: plan, right: lounge-long)');
  } finally {
    win.destroy();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await fs.readdir(options.out).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length > 0) throw new Error(`--out ${options.out} is not empty`);
  await fs.access(options.plan);
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const started = Date.now();
  const product = await startProduct(options.repoRoot);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], shots: [], rounds: 0, audit: null };
  ctx.shoot = createShooter(ctx);
  let watchdog;
  try {
    await Promise.race([
      run(ctx),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`the run exceeded ${RUN_LIMIT_MS / 1000} s`)), RUN_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    guard();
  } catch (error) {
    console.log(`stopped after: ${ctx.steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    console.log(`  last LM requests: ${JSON.stringify(product.lmLog.slice(-12))}`);
    throw error;
  } finally {
    page.close();
    await product.stop();
  }
  await writeComparison(options);
  const seconds = (Date.now() - started) / 1000;
  const manifest = { repoRoot: options.repoRoot, plan: options.plan, viewport: VIEWPORT, seconds, steps: ctx.steps, shots: ctx.shots, domAudit: ctx.audit, pageErrors: page.pageErrors, lmRequests: product.lmLog.length };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${seconds.toFixed(1)} s`);
  if (page.pageErrors.length > 0) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
}

app.on('window-all-closed', () => {});
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('FAILED', error.stack ?? error.message);
    app.exit(1);
  });
