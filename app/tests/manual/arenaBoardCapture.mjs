// 闘技会の試合の盤の流れ（入り・番の受け渡し・決着・見返し）の撮影と、大会一回分の長さの実測の手回しの道具（*.test.mjs ではないので
// npm test は拾わない）:
//
//   <electron> app/tests/manual/arenaBoardCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,...> --boards <絶対パス|none>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品を、OS の一時ディレクトリに作った
// 新しいプレイ（routing・案内人 fallen_star・バディー＝content/characters の連番で最初の選べる人）の上で、この process の中に起こし、
// 露台からの本物の送り出しで入る。LM は固定応答（知らない要求は 500 にして撮影ごと止める）。--out は空でなければ止まる。
// --boards は構成案のこま割りの html の dir（board-1-into-match.html など）。与えると、撮った姿を構成案のこまと並べた一枚
// （compare-board-<n>.png）を作る。
//
// 瞬間の撮り方: 引き金（盤を開く応答・一手の応答・決める一撃の白み）が来た所から、ページの中の時刻で決めた ms が経った所で、ページの
// 中の動き（document.getAnimations()）を全部止めて撮り、動かし直す。ページの setTimeout は道具がページの中の時刻で数え直し、止めていた間は
// ページの中の時刻に数えず止まっているので、一つの引き金の後の瞬間を続けて撮れる。
//
// scenes:
//   win          主人公の能力値を上限にした一人の大会を優勝まで。選ぶ段・表・第一試合の入り（0・0.12・0.38・1 秒）・第一試合の決着
//                （0・0.2・0.6 秒・勝ち上がり）・決勝の決着（優勝）
//   lose         新しいプレイの一人の大会。第一試合で主人公と相手が打ち合う最初の一手の番の受け渡し（0・0.28・0.6・1・1.3 秒）と、
//                一回戦の決着（敗退）
//   pair         二人（バディーあり）の大会の第一試合を最後まで。入り（0.38・1 秒）・輪が三人目へ移る所・一人が倒れて試合が続く所・決着
//   replay       能力値を上限にした主人公で一回戦を勝って戻った表（一回戦の組が明かされた所）から、自動の試合の見返し（入り・番の輪・
//                決着・表へ戻る）
//   timing-champion / timing-eliminated      大会一回分の長さ（r1 の送り方: 撃てる魔法の先頭→撃てなければ待機・応答のあと 700ms で次・
//                表では試合を始める紋が出たらすぐ押す）。champion は能力値を上限にした主人公
//   timing-champion-flow / timing-eliminated-flow   同じ大会を、一手の流れが終わって呪文の欄が戻ってから次を送る形で
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const TURN_LIMIT = 160;
const SEND_GAP_MS = 700;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--scenes', '--boards'];
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
  const boards = parsed['--boards'] === 'none' ? null : parsed['--boards'];
  if (boards !== null && !path.isAbsolute(boards)) throw new Error('--boards must be an absolute path or none');
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], scenes, boards };
}

// ── 製品と固定応答の LM（この process の中・一時のセーブ） ─────────────────────────────────────────────────────
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';
const FIXTURE_PROMPT_ANSWERS = [
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['character_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false']
];
const ARENA_ANNOUNCE_MARKER = 'あなたは魔法学院の闘技会の場内アナウンスの地の文を綴る。';
const ARENA_INTRO_ASK = '次の試合の開始を告げる短い口上を書く。';
const ARENA_INTRO_LINE = '夜の闘技場に篝火が揺れ、魔法陣の上で二つの影が向かい合う。';
const ARENA_RESULT_LINE = '篝火に照らされた円形の場に、今宵の勝ち名乗りが高く告げられた。';

function createFixtureLm(hubLines) {
  return function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') return { content: JSON.stringify({ expression: 'neutral' }) };
    if (schemaName === 'work_record_recall_choice') return { content: JSON.stringify({ work_record_ids: [] }) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      return { content: matches.length === 1 ? matches[0][0] : 'none' };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { content: 'false' };
    if (prompt.includes(ARENA_ANNOUNCE_MARKER)) return { content: prompt.includes(ARENA_INTRO_ASK) ? ARENA_INTRO_LINE : ARENA_RESULT_LINE };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) if (prompt.includes(marker)) return { content };
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { content: '（顔を上げて）ええ、行ってらっしゃい。' };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { content: '学院で主人公と少し話した。' };
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

async function findFiles(dir, name) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(full, name));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

// 能力値の file の形はそのまま、値だけを上限へ（{value} の形でも数そのものでも）。
function maxOut(node) {
  if (typeof node === 'number') return 100;
  if (node && typeof node === 'object') {
    if ('value' in node && typeof node.value === 'number') return { ...node, value: 100 };
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, maxOut(value)]));
  }
  return node;
}

async function startProduct(repoRoot, { strong }) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const { setRelationshipDebugState } = await product('relationshipState.mjs');
  const { isSelectableCharacterId } = await product('characterCatalog.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-board-capture-'));
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
    const ids = (await fs.readdir(path.join(repoRoot, 'content/characters'))).filter((name) => /^character_\d+$/.test(name)).sort();
    const buddy = ids.find((id) => isSelectableCharacterId(id));
    if (!buddy) throw new Error('no selectable character in content/characters');
    await setRelationshipDebugState({ root: slotRoot, buddyCharacterId: buddy });
    if (strong) {
      const paramFiles = await findFiles(root, 'player_parameters.json');
      if (!paramFiles.length) throw new Error('no player_parameters.json to max out');
      for (const file of paramFiles) await fs.writeFile(file, `${JSON.stringify(maxOut(JSON.parse(await fs.readFile(file, 'utf8'))), null, 2)}\n`, 'utf8');
    }
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
      provider: 'lmstudio', base_url: `http://${HOST}:${lmPort}/v1`, chat_model: FIXTURE_CHAT_MODEL, reflection_model: FIXTURE_REFLECTION_MODEL,
      timeout_ms: 120000, stream: true, thinking_effort: null, mock_provider_enabled: false
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
      base: `http://${HOST}:${port}`, hubLines, lmFailures, buddy,
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

// ── ページの中の道具 ─────────────────────────────────────────────────────────────────────────────────────
// ページの中の時刻（止めていた間を数えない）・闘技会の応答の控え・止める／動かし直す・引き金と瞬間の計画。
// 計画: { trigger, moments: [{ name, at }] }。trigger は { kind: 'response', url: <正規表現の文字列>, when: <json を受ける関数の式> }
// か { kind: 'added', cls }（その class の要素が足された時）。引き金の後、ページの中の時刻で at ms の所で name の名で止める。
const PAGE_TOOLS = `(() => {
  if (window.__bc) return true;
  const bc = window.__bc = { frozen: null, frozenAt: 0, frozenMs: 0, seq: 0, last: null, plans: [] };
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  // ページの中の時刻（止めていた間を数えない）。setTimeout はこの時刻で数え（id は負の数）、止めている間は一つも走らせない。
  bc.vnow = () => (bc.frozen ? bc.frozenAt : performance.now()) - bc.frozenMs;
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (fn, ms, ...args) => {
    nextTimer -= 1;
    timers.set(nextTimer, { due: bc.vnow() + Math.max(0, Number(ms) || 0), seq: -nextTimer, run: () => fn(...args) });
    return nextTimer;
  };
  window.clearTimeout = (id) => { if (typeof id === 'number' && id < 0) timers.delete(id); else realClearTimeout(id); };
  const runDue = () => {
    while (!bc.frozen) {
      let next = null;
      for (const [id, timer] of timers) if (timer.due <= bc.vnow() && (!next || timer.due < next[1].due || (timer.due === next[1].due && timer.seq < next[1].seq))) next = [id, timer];
      if (!next) return;
      timers.delete(next[0]);
      next[1].run();
    }
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const response = await realFetch(input, init);
    if (/\\/api\\/arena\\/(match\\/start|action|match\\/[^/]+\\/replay)$/.test(url)) {
      const json = await response.clone().json();
      bc.last = { url, json };
      bc.seq += 1;
      for (const plan of bc.plans) {
        if (plan.at !== null || plan.trigger.kind !== 'response' || !new RegExp(plan.trigger.url).test(url)) continue;
        if (plan.trigger.when && !plan.trigger.when(json)) continue;
        plan.at = bc.vnow();
      }
    }
    return response;
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      for (const plan of bc.plans) if (plan.at === null && plan.trigger.kind === 'added' && node.classList.contains(plan.trigger.cls)) plan.at = bc.vnow();
    }
  }).observe(document.body, { childList: true, subtree: true });
  const flushStyle = () => { void document.documentElement.getBoundingClientRect(); for (const el of document.querySelectorAll('*')) getComputedStyle(el).transitionProperty; };
  // 止めた動きは覚えておき、動かし直しで一つ残らず play する（止めた時に始まる前だった動きも含む）。
  const paused = new Set();
  const pauseAll = () => { flushStyle(); for (const a of document.getAnimations()) if (a.playState === 'running') { a.pause(); paused.add(a); } };
  const holdLoop = () => { if (!bc.frozen) return; pauseAll(); realSetTimeout(holdLoop, 4); };
  bc.freeze = (name) => { bc.frozen = name; bc.frozenAt = performance.now(); pauseAll(); holdLoop(); };
  bc.resume = () => {
    bc.frozenMs += performance.now() - bc.frozenAt;
    bc.frozen = null;
    for (const a of paused) if (a.playState !== 'finished' && a.playState !== 'idle') a.play();
    paused.clear();
  };
  bc.arm = (trigger, moments) => { bc.plans.push({ trigger, moments: moments.slice(), at: null, fired: [] }); return true; };
  bc.disarm = () => { bc.plans = []; return true; };
  bc.status = () => ({
    frozen: bc.frozen,
    pending: bc.plans.reduce((n, plan) => n + plan.moments.length, 0),
    triggered: bc.plans.reduce((n, plan) => n + (plan.at === null ? 0 : plan.moments.length), 0)
  });
  const poll = () => {
    runDue();
    if (!bc.frozen) {
      for (const plan of bc.plans) {
        if (plan.at === null || !plan.moments.length) continue;
        const elapsed = bc.vnow() - plan.at;
        if (elapsed >= plan.moments[0].at) {
          const moment = plan.moments.shift();
          bc.frozenElapsed = Math.round(elapsed);
          bc.freeze(moment.name);
          break;
        }
      }
    }
    realSetTimeout(poll, 2);
  };
  poll();
  return true;
})()`;

// 撮った瞬間の盤の流れの姿（駒ごとの足もとの輪・倒れ・入りを待つ、会場の灯、印、呪文の欄、番の名）。
const BOARD_STATE = `(() => {
  const screen = document.querySelector('#academy-arena-screen');
  const match = document.querySelector('#arena-match');
  const dock = document.querySelector('#arena-dock-main');
  const mark = document.querySelector('#arena-mark');
  const tokens = [...document.querySelectorAll('#arena-grid .an-entity')].map((node) => ({
    side: ['self', 'ally', 'enemy'].find((side) => node.classList.contains('an-entity--' + side)),
    ring: node.querySelector('.an-foot').dataset.ring,
    down: node.classList.contains('an-entity--down'),
    waiting: node.classList.contains('an-entity--waiting')
  }));
  return {
    stage: screen.dataset.stage,
    flow: match.dataset.flow ?? null,
    venue: document.querySelector('#arena-venue').dataset.venue ?? null,
    mark: mark.classList.contains('is-shown') ? mark.textContent : null,
    dock: dock.hidden ? 'hidden' : dock.classList.contains('is-flowing') ? 'sunk' : 'up',
    turn: [...document.querySelectorAll('#arena-hud-status .an-hud-actor--turn .an-hud-actor-name')].map((node) => node.textContent),
    intro: document.querySelector('#arena-match-intro').dataset.state ?? null,
    tokens,
    effects: { bolt: document.querySelectorAll('.an-bolt').length, impact: document.querySelectorAll('.an-impact').length, flash: [...document.querySelectorAll('.an-flash')].map((node) => node.getAnimations().map((a) => a.playState + '@' + Math.round(a.currentTime)).join('|') + ' op=' + getComputedStyle(node).opacity) }
  };
})()`;

async function openPage(guard, size = VIEWPORT) {
  const win = new BrowserWindow({ width: size.width, height: size.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (event, level, message) => { if (level === 3) { pageErrors.push(message); console.log(`renderer-error: ${message}`); } });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js, pageErrors, win,
    async load(url) {
      await win.loadURL(url);
      const m = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
      if (m.w !== size.width || m.h !== size.height || m.dpr !== 1) throw new Error(`viewport ${JSON.stringify(m)}`);
    },
    async waitFor(predicate, label, timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        guard();
        if (await js(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`)) return;
        await sleep(20);
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
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) { await send('Input.insertText', { text: character }); await sleep(20); }
    },
    async press(key) {
      const vk = { ' ': 32 }[key];
      const code = key === ' ' ? 'Space' : key;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    async moveAway() { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); },
    async png(clip = null) {
      const params = { format: 'png', captureBeyondViewport: false };
      if (clip) params.clip = { ...clip, scale: 1 };
      const { data } = await send('Page.captureScreenshot', params);
      return Buffer.from(data, 'base64');
    },
    close() { win.destroy(); }
  };
  return page;
}

const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const IMAGES_LOADED = (selector) => `[...document.querySelectorAll(${JSON.stringify(`${selector} img`)})].every((img) => !img.getAttribute('src') || img.complete)`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const arrived = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`;
const settled = (id) => `${arrived(id)} && ${motionSettled(`#${id}`)} && ${IMAGES_LOADED(`#${id}`)}`;

async function walkToHub(ctx) {
  const { page } = ctx;
  await page.load(`${ctx.product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled');
  await sleep(SETTLE_MS);
  ctx.steps.push('title → ロード → slot → terrace');
}

const ARENA = 'academy-arena-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const FIGHT = "document.querySelector('#arena-bracket-actions .arena-fight')";
const IN_MATCH = ARENA_STAGE('match');
const DOCK_UP = "(!document.querySelector('#arena-dock-main').hidden && !document.querySelector('#arena-dock-main').classList.contains('is-flowing'))";

async function shoot(ctx, file, note) {
  const target = path.join(ctx.options.out, `${file}.png`);
  if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
  // 止めた時刻の姿が合成まで届いた frame を撮る: 窓全体を描き直させ、四 frame 待つ。
  ctx.page.win.webContents.invalidate();
  await ctx.page.js('new Promise((resolve) => { let n = 0; const tick = () => (++n >= 4 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })');
  const board = await ctx.page.js(BOARD_STATE);
  const at = await ctx.page.js('window.__bc ? window.__bc.frozenElapsed ?? null : null');
  const bytes = await ctx.page.png();
  if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${file}.png is not 1440x900`);
  await fs.writeFile(target, bytes);
  ctx.shots.push({ file: `${file}.png`, note, at, board });
  console.log(`shot ${file}.png — ${note} at=${at} board=${JSON.stringify(board)}`);
}

// 計画の瞬間が来るたびに撮って動かし直す。掛かっている計画が全部撮れたか、minMs が過ぎて引き金の来た計画に残りが無くなったら戻る
// （引き金の来ない計画は掛けたまま残り、後の手で来れば、その手の待ちで撮る）。
async function runCaptures(ctx, { minMs }) {
  const { page } = ctx;
  const fired = [];
  const end = Date.now() + minMs;
  while (true) {
    const status = await page.js('window.__bc.status()');
    if (status.frozen) {
      await shoot(ctx, status.frozen, ctx.momentNotes.get(status.frozen));
      await page.js('window.__bc.resume()');
      fired.push(status.frozen);
      continue;
    }
    if (status.pending === 0 || (Date.now() >= end && status.triggered === 0)) return fired;
    await sleep(5);
  }
}

async function armPlans(ctx, plans) {
  for (const plan of plans) {
    for (const moment of plan.moments) ctx.momentNotes.set(moment.name, moment.note);
    await ctx.page.js(`window.__bc.arm(${plan.trigger}, ${JSON.stringify(plan.moments.map(({ name, at }) => ({ name, at })))})`);
  }
}

async function captureMoments(ctx, plans, act, { minMs }) {
  await armPlans(ctx, plans);
  await act();
  return runCaptures(ctx, { minMs });
}

async function enterArena(ctx, mode, { shootSelection = null } = {}) {
  const { page } = ctx;
  await walkToHub(ctx);
  const line = ctx.product.hubLines.arena;
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  await page.waitFor(arrived(ARENA), 'the arena', LM_WAIT_MS);
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection');
  await sleep(SETTLE_MS);
  await page.moveAway();
  if (shootSelection) await shoot(ctx, shootSelection, '選ぶ段（一人・二人・観戦の立ち位置）');
  const clickAt = Date.now();
  await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="${mode}"]')`, `${mode} の立ち位置`);
  await page.waitFor(`${ARENA_STAGE('bracket')} && ${FIGHT}`, 'the bracket');
  const bracketAt = Date.now();
  await page.js(PAGE_TOOLS);
  ctx.steps.push(`say on the terrace: ${line} → stand on ${mode} → bracket`);
  return { clickAt, ms_entry_to_bracket: bracketAt - clickAt };
}

// 撃てる魔法の先頭を押す。撃てなければ（直前に魔力が足りないと言われた後も）待機。
async function sendFirstOrWait(ctx) {
  const { page } = ctx;
  const lastErrored = await page.js('!!window.__bc.last?.json?.view?.action_error');
  const spell = await page.js("(() => { const b = document.querySelector('#arena-spells .arena-spell:not(.arena-spell-heal):not(:disabled)'); return b ? b.getAttribute('aria-label') : null; })()");
  if (spell && !lastErrored) {
    await page.click("document.querySelector('#arena-spells .arena-spell:not(.arena-spell-heal):not(:disabled)')", spell);
    return 'cast';
  }
  await page.press(' ');
  return 'wait';
}

// 試合を始める紋を押してから、表（か結果の段）へ戻るまで一試合を送る。gap: 'r1' は応答のあと SEND_GAP_MS で次、'flow' は一手の
// 流れが終わって呪文の欄が戻ってから次。perAction(index) が計画を返せば、その手でその瞬間を撮る。
async function playMatch(ctx, { gap, entrance = null, perAction = () => [], windowMs = 2500 }) {
  const { page } = ctx;
  const record = { actions: 0, casts: 0, waits: 0, fired: [] };
  const clickAt = Date.now();
  const start = async () => { await page.click(FIGHT, '試合開始'); await page.moveAway(); };
  if (entrance) record.fired.push(...await captureMoments(ctx, entrance, start, { minMs: 1500 }));
  else await start();
  await page.waitFor(`${IN_MATCH} && document.querySelector('#arena-grid .an-entity')`, 'the match board', LM_WAIT_MS);
  record.ms_click_to_board = Date.now() - clickAt;
  let lastResponseAt = null;
  while (await page.js(IN_MATCH)) {
    if (record.actions > TURN_LIMIT) throw new Error('arena match did not conclude');
    if (gap === 'flow') await page.waitFor(`!(${IN_MATCH}) || ${DOCK_UP}`, 'the spell dock to rise', 15000);
    else await page.waitFor(`!(${IN_MATCH}) || !document.querySelector('#arena-dock-main').hidden`, 'the spell dock', 15000);
    if (!(await page.js(IN_MATCH))) break;
    const seq = await page.js('window.__bc.seq');
    await armPlans(ctx, perAction(record.actions));
    const kind = await sendFirstOrWait(ctx);
    await page.moveAway();
    if ((await page.js('window.__bc.status()')).pending > 0) record.fired.push(...await runCaptures(ctx, { minMs: windowMs }));
    record.actions += 1;
    record[kind === 'cast' ? 'casts' : 'waits'] += 1;
    await page.waitFor(`window.__bc.seq > ${seq}`, 'the action response', 15000);
    lastResponseAt = Date.now();
    const view = await page.js('window.__bc.last.json.view');
    if (!view.active) {
      const friendly = view.actors.find((actor) => actor.controller === 'player').team;
      record.won = view.winner === friendly;
      record.opponent = view.actors.filter((actor) => actor.team !== friendly).map((actor) => actor.name).join('・');
      break;
    }
    if (gap === 'r1') await sleep(SEND_GAP_MS);
  }
  await page.waitFor(`${ARENA_STAGE('bracket')} || ${ARENA_STAGE('result')}`, 'back on the bracket', 20000);
  const backAt = Date.now();
  record.ms_last_response_to_back = lastResponseAt === null ? null : backAt - lastResponseAt;
  record.ms_click_to_back = backAt - clickAt;
  await page.js('window.__bc.disarm()');
  console.log(`MATCH ${JSON.stringify(record)}`);
  return record;
}

// ── 計画 ─────────────────────────────────────────────────────────────────────────────────────────────────
const RESPONSE = (url, when = null) => `({ kind: 'response', url: ${JSON.stringify(url)}${when ? `, when: ${when}` : ''} })`;
const ADDED = (cls) => `({ kind: 'added', cls: ${JSON.stringify(cls)} })`;
const START_URL = '/api/arena/match/start$';
const ACTION_URL = '/api/arena/action$';
const REPLAY_URL = '/api/arena/match/[^/]+/replay$';

const ENTRANCE = (prefix, moments) => ({ trigger: RESPONSE(START_URL), moments: moments.map(([suffix, at, note]) => ({ name: `${prefix}-${suffix}`, at, note })) });
const DECISIVE = (moments) => ({ trigger: ADDED('an-flash'), moments: moments.map(([name, at, note]) => ({ name, at, note })) });

// 主人公と相手が打ち合う一手（主人公の升から出た一撃と、主人公に向かった一撃の両方があり、試合が続く）。
const BOTH_STRIKE = `((json) => {
  const view = json.view;
  const self = view.actors.find((a) => a.controller === 'player');
  return view.active && json.events.some((e) => e.from.x === self.x && e.from.y === self.y) && json.events.some((e) => e.to.x === self.x && e.to.y === self.y);
})`;
// 二人の試合で、輪が三人目まで移る一手（三つ以上の升から一撃が出て、試合が続く）。
const THREE_THROWERS = `((json) => json.view.active && new Set(json.events.map((e) => e.from.x + ',' + e.from.y)).size >= 3)`;
// 二人の試合で、誰かが倒れて試合が続く一手。
const FALL_GOES_ON = `((json) => json.view.active && json.view.actors.some((a) => a.down))`;

// ── 場面 ─────────────────────────────────────────────────────────────────────────────────────────────────
async function winScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo', { shootSelection: 'b1-0-selection' });
  await page.waitFor(`${settled(ARENA)} && ${FIGHT}`, 'the bracket settled');
  await sleep(SETTLE_MS);
  await page.moveAway();
  await shoot(ctx, 'b1-1-bracket', '表（第一試合の前）');
  const entrance = [ENTRANCE('b1', [
    ['2-entry-0', 30, '入り 0 秒（盤が開いた所）'],
    ['3-entry-012', 250, '入り 0.12 秒の後（相手の輪が開いていく）'],
    ['4-entry-038', 500, '入り 0.38 秒の後（相手が輪から立ち、自陣の輪が開く）'],
    ['5-entry-1', 1300, '入り 1 秒の後（輪がほどけ、口上と呪文の欄が出て、主人公に番の輪）']
  ])];
  const decisive = [DECISIVE([
    ['b3-0-decisive-0', 70, '決着 0 秒（決める一撃: 盤が白み、着弾がひとまわり大きい。白みの山の 65ms の直後）'],
    ['b3-1-decisive-02', 300, '決着 0.2 秒の後（倒れた学院生が灰色に褪せて沈む）'],
    ['b3-2-decisive-06', 750, '決着 0.6 秒の後（会場の灯がふくらみ、主人公の足もとの輪が大きく開く）'],
    ['b3-3-decisive-advance', 1300, '決着 0.9 秒の後（勝ち上がりの印）']
  ])];
  const matches = [];
  matches.push(await playMatch(ctx, { gap: 'r1', entrance, perAction: (index) => (index === 0 ? decisive : []) }));
  for (let round = 1; round < 4 && matches.at(-1).won; round += 1) {
    await page.waitFor(FIGHT, 'the fight sigil', 15000);
    const final = round === 3;
    const plans = final ? [DECISIVE([['b3-4-decisive-champion', 1300, '決勝の決着（優勝の印）']])] : [];
    matches.push(await playMatch(ctx, { gap: 'r1', perAction: (index) => (index === 0 ? plans : []) }));
  }
  ctx.notes.win = matches;
  if (!matches.every((match) => match.won) || matches.length !== 4) throw new Error(`the maxed protagonist did not win all four: ${JSON.stringify(matches)}`);
}

async function loseScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo');
  await page.waitFor(`${settled(ARENA)} && ${FIGHT}`, 'the bracket settled');
  await sleep(SETTLE_MS);
  const turns = { trigger: RESPONSE(ACTION_URL, BOTH_STRIKE), moments: [
    { name: 'b2-0-turn-0', at: 40, note: '番 0 秒（主人公の番の輪が明るみ、呪文の欄が沈む）' },
    { name: 'b2-1-turn-028', at: 300, note: '番 0.28 秒（主人公の一撃が相手に届く）' },
    { name: 'b2-2-turn-06', at: 880, note: '番 0.6 秒の後（輪が相手へ移り、上の相手の名の下が灯る）' },
    { name: 'b2-3-turn-1', at: 1020, note: '番 1 秒（相手の一撃が主人公に届く）' },
    { name: 'b2-4-turn-13', at: 1500, note: '番 1.3 秒の後（輪が主人公へ戻り、呪文の欄が戻って光の筋が走る）' }
  ] };
  const decisive = DECISIVE([['b3-5-decisive-eliminated', 1300, '一回戦の決着（主人公が灰色に沈み、会場の灯が沈み、敗退の印）']]);
  let armed = false;
  const record = await playMatch(ctx, {
    gap: 'flow',
    perAction: () => {
      if (armed) return [];
      armed = true;
      return [turns, decisive];
    }
  });
  ctx.notes.lose = record;
  if (record.won) throw new Error('the default protagonist won round 1; the lose scene needs a loss');
  await page.waitFor(ARENA_STAGE('result'), 'the result stage', LM_WAIT_MS);
}

async function pairScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'pair');
  await page.waitFor(`${settled(ARENA)} && ${FIGHT}`, 'the bracket settled');
  await sleep(SETTLE_MS);
  const entrance = [ENTRANCE('pair', [
    ['entry-038', 500, '二人の入り 0.38 秒の後（相手の二人が輪から立ち、自陣の二つの輪が開く）'],
    ['entry-1', 1300, '二人の入り 1 秒の後（四人が立ち、主人公に番の輪）']
  ])];
  const third = { trigger: RESPONSE(ACTION_URL, THREE_THROWERS), moments: [{ name: 'b2-5-pair-turn', at: 880, note: '二人の番（輪が二人目の手の主へ移った所）' }] };
  const fall = { trigger: RESPONSE(ACTION_URL, FALL_GOES_ON), moments: [{ name: 'b3-6-pair-fall', at: 2600, note: '二人の試合で一人が倒れ、灰色で盤に残ったまま試合が続く' }] };
  const decisive = DECISIVE([['pair-decisive', 1300, '二人の試合の決着（印）']]);
  let armed = false;
  const record = await playMatch(ctx, { gap: 'flow', entrance, perAction: () => (armed ? [] : ((armed = true), [third, fall, decisive])) });
  ctx.notes.pair = record;
}

// 表の見えている姿: 名の札と勝ち・負け・主人公の印、灯った線とこの先の道、節と頂の状態、見返しの目。明かしの動きで組み立てた表と
// 描き直した表は DOM の綴りが違ってよく、見えている姿が同じかを比べる（明かしの動きだけを起こす class は終わった姿を変えないので数えない）。
const BRACKET_SHOWN = `JSON.stringify((() => {
  const ring = document.querySelector('#arena-bracket-ring');
  const motion = new Set(['arena-ring-lit--growing', 'arena-ring-eye--lit']);
  const classes = (el) => [...el.classList].filter((name) => !motion.has(name)).sort();
  const key = (el) => el.dataset.unitId ?? el.dataset.matchId;
  const byKey = (selector, read) => [...ring.querySelectorAll(selector)].map((el) => [key(el), read(el)]).sort(([a], [b]) => a.localeCompare(b));
  return {
    names: byKey('.arena-ring-name', (el) => [el.textContent, classes(el)]),
    lit: byKey('path.arena-ring-lit', classes),
    route: byKey('path.arena-ring-route', classes),
    nodes: byKey('.arena-ring-node, .arena-ring-crown', (el) => el.dataset.state),
    eyes: byKey('.arena-ring-eye', classes)
  };
})())`;

async function replayScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo');
  await page.waitFor(`${settled(ARENA)} && ${FIGHT}`, 'the bracket settled');
  // 見返しの目は明かした自動の組（節の解けた組）にだけ出る: 一回戦を勝って戻り、表の明かしが済んで試合を始める紋が出るまで待つ。
  const opener = await playMatch(ctx, { gap: 'r1' });
  if (!opener.won) throw new Error('the replay scene needs the first match won (strong protagonist)');
  await page.waitFor(`${settled(ARENA)} && ${FIGHT}`, 'the bracket revealed after the first match', 15000);
  await sleep(SETTLE_MS);
  await page.moveAway();
  await shoot(ctx, 'b7-0-replay-eyes', '表の見返しの目（見返しに入る前）');
  const before = await page.js(BRACKET_SHOWN);
  const pick = await page.js("(() => { const eyes = [...document.querySelectorAll('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')]; return eyes.length; })()");
  if (!pick) throw new Error('no watchable match on the bracket');
  const plans = [
    { trigger: RESPONSE(REPLAY_URL), moments: [
      { name: 'b7-1-replay-entry', at: 600, note: '見返しの入り（相手の側が立ち、自陣の側の輪が開く）' },
      { name: 'b7-2-replay-ring', at: 2250, note: '見返しの番の輪（最初の一手の手の主の足もと）' }
    ] },
    DECISIVE([['b7-3-replay-decisive', 1300, '見返しの決着（勝った側に合わせた灯と印）']])
  ];
  await captureMoments(ctx, plans, async () => {
    await page.click("document.querySelector('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')", '観戦');
    await page.moveAway();
  }, { minMs: 120000 });
  await sleep(1500);
  ctx.notes.replayEnd = await page.js(BOARD_STATE);
  await page.click("document.querySelector('#arena-match-back')", '表へ戻る');
  await page.waitFor(`${ARENA_STAGE('bracket')} && ${settled(ARENA)}`, 'back on the bracket');
  await sleep(SETTLE_MS);
  await page.moveAway();
  await shoot(ctx, 'b7-4-replay-back', '見返しから表へ戻った所（表は見返しに入る前の姿のまま）');
  const after = await page.js(BRACKET_SHOWN);
  ctx.notes.replay = { watchable: pick, bracket_unchanged: before === after };
  if (before !== after) console.log(`BRACKET BEFORE ${before}\nBRACKET AFTER  ${after}`);
  // 同じ組を見返し直す: 入りの盤は前の見返しの印・会場の灯・倒れた駒を持ち越さない。
  await page.click("document.querySelector('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')", '同じ組をもう一度観戦');
  await page.waitFor(`${IN_MATCH} && document.querySelector('#arena-match').dataset.flow === 'entering'`, 'the rewatch entrance', LM_WAIT_MS);
  const again = await page.js(BOARD_STATE);
  ctx.notes.rewatch = { flow: again.flow, venue: again.venue, mark: again.mark, down: again.tokens.filter((token) => token.down).length };
  console.log(`REWATCH ${JSON.stringify(ctx.notes.rewatch)}`);
  if (again.mark !== null || again.venue !== 'entering' || ctx.notes.rewatch.down) throw new Error('the rewatched replay carried the previous board over');
  console.log(`REPLAY ${JSON.stringify(ctx.notes.replay)}`);
}

// 大会一回分: 立ち位置を押してから結果の段が出るまで。段ごとに待ちの上限を掛け、止まった段があれば名指して止める。
async function timingScene(ctx, gap) {
  const { page } = ctx;
  const entry = await enterArena(ctx, 'solo');
  const matches = [];
  for (let round = 0; round < 4; round += 1) {
    const readyAt = Date.now();
    await page.waitFor(FIGHT, `the fight sigil before round ${round + 1}`, 15000);
    const dwell = Date.now() - readyAt;
    const record = await playMatch(ctx, { gap });
    matches.push({ round: round + 1, ms_bracket_wait: dwell, ...record });
    if (!record.won) break;
  }
  await page.waitFor(ARENA_STAGE('result'), 'the result stage', 20000);
  const resultAt = Date.now();
  ctx.notes.timing = {
    gap,
    ms_entry_to_bracket: entry.ms_entry_to_bracket,
    matches: matches.map(({ fired, ...rest }) => rest),
    ms_entry_to_result: resultAt - entry.clickAt,
    ms_matches_sum: matches.reduce((n, match) => n + match.ms_click_to_back, 0)
  };
  console.log(`TIMING ${JSON.stringify(ctx.notes.timing)}`);
}

const SCENES = {
  win: { run: winScene, strong: true },
  lose: { run: loseScene, strong: false },
  pair: { run: pairScene, strong: false },
  replay: { run: replayScene, strong: true },
  'timing-champion': { run: (ctx) => timingScene(ctx, 'r1'), strong: true },
  'timing-eliminated': { run: (ctx) => timingScene(ctx, 'r1'), strong: false },
  'timing-champion-flow': { run: (ctx) => timingScene(ctx, 'flow'), strong: true },
  'timing-eliminated-flow': { run: (ctx) => timingScene(ctx, 'flow'), strong: false }
};

async function runScene(options, name) {
  const product = await startProduct(options.repoRoot, { strong: SCENES[name].strong });
  const guard = () => { if (product.lmFailures.length) throw new Error(`fixture LM 500: ${product.lmFailures.join(' | ')}`); };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], shots: [], notes: {}, momentNotes: new Map() };
  const started = Date.now();
  try {
    await SCENES[name].run(ctx);
    guard();
    if (page.pageErrors.length) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
    return { scene: name, seconds: (Date.now() - started) / 1000, notes: ctx.notes, steps: ctx.steps, shots: ctx.shots };
  } catch (error) {
    console.log(`scene ${name} stopped after: ${ctx.steps.at(-1) ?? 'nothing'}: ${error.message}`);
    throw error;
  } finally {
    page.close();
    await product.stop();
  }
}

// ── 構成案のこまとの対照 ─────────────────────────────────────────────────────────────────────────────────
// 構成案のこまは、撮影を 0.5 倍にして (-20, -60) ずらした 700×415 の窓（どのこまも同じ）。撮った姿を同じ窓に入れて並べる。
const BOARD_PAIRS = {
  1: { html: 'board-1-into-match.html', shots: ['b1-0-selection', 'b1-1-bracket', 'b1-2-entry-0', 'b1-3-entry-012', 'b1-4-entry-038', 'b1-5-entry-1'] },
  2: { html: 'board-2-turns.html', shots: ['b2-0-turn-0', 'b2-1-turn-028', 'b2-2-turn-06', 'b2-3-turn-1', 'b2-4-turn-13', 'b2-5-pair-turn'] },
  3: { html: 'board-3-decisive.html', shots: ['b3-0-decisive-0', 'b3-1-decisive-02', 'b3-2-decisive-06', 'b3-3-decisive-advance', 'b3-4-decisive-champion', 'b3-5-decisive-eliminated', 'b3-6-pair-fall'] },
  7: { html: 'board-7-replay.html', shots: ['b7-0-replay-eyes', 'b7-1-replay-entry', 'b7-2-replay-ring', 'b7-3-replay-decisive', 'b7-4-replay-back'] }
};
const FRAME = { width: 700, height: 415 };

async function exists(file) { return fs.stat(file).then(() => true, () => false); }

async function cutBoardFrames(boardsDir, out) {
  const frames = {};
  for (const [number, pair] of Object.entries(BOARD_PAIRS)) {
    const page = await openPage(() => {}, { width: 2300, height: 1800 });
    try {
      await page.win.loadFile(path.join(boardsDir, pair.html));
      await page.js('Promise.all([...document.images].map((img) => img.decode()))');
      const figures = await page.js(`[...document.querySelectorAll('figure')].map((figure) => {
        const r = figure.firstElementChild.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), caption: figure.querySelector('figcaption').innerText };
      })`);
      if (figures.length !== pair.shots.length) throw new Error(`${pair.html}: ${figures.length} frames, expected ${pair.shots.length}`);
      frames[number] = [];
      for (const [index, figure] of figures.entries()) {
        if (figure.width !== FRAME.width || figure.height !== FRAME.height) throw new Error(`${pair.html} frame ${index} is ${figure.width}x${figure.height}`);
        const file = path.join(out, 'frames', `board-${number}-${index}.png`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, await page.png({ x: figure.x, y: figure.y, width: figure.width, height: figure.height }));
        frames[number].push({ file, caption: figure.caption });
      }
    } finally {
      page.close();
    }
  }
  return frames;
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function composeComparisons(out, boardsDir, shots) {
  const frames = await cutBoardFrames(boardsDir, out);
  const byFile = new Map(shots.map((shot) => [shot.file, shot]));
  for (const [number, pair] of Object.entries(BOARD_PAIRS)) {
    const rows = [];
    for (const [index, name] of pair.shots.entries()) {
      const frame = frames[number][index];
      const shotFile = path.join(out, `${name}.png`);
      const shot = byFile.get(`${name}.png`);
      const mine = (await exists(shotFile))
        ? `<div class="win"><img src="${shotFile}" style="transform:scale(0.5) translate(-20px,-60px)"></div>`
        : '<div class="win missing">撮影なし</div>';
      rows.push(`<div class="row"><figure><div class="win"><img src="${frame.file}"></div><figcaption>構成案 ${number} のこま ${index + 1}: ${escapeHtml(frame.caption)}</figcaption></figure>
        <figure>${mine}<figcaption>作った姿: ${escapeHtml(name)}.png${shot ? `<br>${escapeHtml(shot.note)}${shot.at !== null ? `（引き金から ${shot.at}ms）` : ''}` : ''}</figcaption></figure></div>`);
    }
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#111;color:#eee;font:14px/1.55 "Hiragino Kaku Gothic ProN",sans-serif}
      h1{font-size:20px;margin:16px 20px 4px}
      .row{display:flex;gap:24px;padding:10px 20px}
      figure{margin:0;width:700px} figcaption{padding:6px 0 0;color:#d9ccc4}
      .win{position:relative;width:700px;height:415px;overflow:hidden;border-radius:6px;box-shadow:0 0 0 1px rgba(232,200,119,0.35)}
      .win img{position:absolute;left:0;top:0;transform-origin:0 0}
      .missing{display:flex;align-items:center;justify-content:center;color:#888}
    </style><h1>構成案 ${number} と作った姿（左 = 承認のこま・右 = 同じ瞬間の撮影。どちらも撮影の 0.5 倍・(-20, -60) の窓）</h1>${rows.join('')}`;
    const htmlFile = path.join(out, 'html', `compare-board-${number}.html`);
    await fs.mkdir(path.dirname(htmlFile), { recursive: true });
    await fs.writeFile(htmlFile, html, 'utf8');
    const height = 60 + pair.shots.length * 500;
    const page = await openPage(() => {}, { width: 1464, height });
    try {
      await page.win.loadFile(htmlFile);
      await page.js('Promise.all([...document.images].map((img) => img.decode().catch(() => null)))');
      const docHeight = await page.js('document.documentElement.scrollHeight');
      const bytes = await page.png({ x: 0, y: 0, width: 1464, height: Math.min(docHeight, height) });
      await fs.writeFile(path.join(out, `compare-board-${number}.png`), bytes);
      console.log(`wrote compare-board-${number}.png ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
    } finally {
      page.close();
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await fs.readdir(options.out).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  if (existing.length) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const started = Date.now();
  const scenes = [];
  const failed = [];
  for (const name of options.scenes) {
    try { scenes.push(await runScene(options, name)); } catch (error) { console.log(`SCENE FAILED ${name}: ${error.stack}`); failed.push(name); }
  }
  if (options.boards) await composeComparisons(options.out, options.boards, scenes.flatMap((scene) => scene.shots));
  const manifest = { viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, failed };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${manifest.seconds.toFixed(1)} s (scenes ${options.scenes.join(',')}; failed: ${failed.join(',') || '-'})`);
  if (failed.length) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
main().then(() => app.exit(0)).catch((error) => { console.error('FAILED', error.message); app.exit(1); });
