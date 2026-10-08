// 打ち合いの演出（回復・品・蘇生・回避の魔法・外れ・空振り）を、ダンジョンと闘技会の画面で動きの始めから終わりまでのこまの連なりに撮り、
// 見返しの三段の速さで外れの動きが見えている長さと、一人の大会を最後まで送る長さを測る手回しの道具（*.test.mjs ではないので
// npm test は拾わない）:
//
//   <electron> app/tests/manual/combatFxCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品を、OS の一時ディレクトリに作った
// 新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こし、露台からの本物の送り出しで入る。LM は固定応答（知らない
// 要求は 500 にして撮影ごと止める）。--out は空でなければ止まる。
//
// 出来事の起こし方（dungeon・arena）: 画面の本物の入力で、サーバが手を進めずに断る手（ダンジョンは階段の外での Enter＝降りる、闘技会は
// 壁か人のいる升への矢印）を送り、その応答だけをページの中で書き換えて画面へ渡す — action_error を外し、events に撮る出来事を一つ
// 置き、view の値（体力・倒れ・回避の魔法・隣の敵）を撮る姿に合わせる。サーバの状態は一手も進まない。出来事の形は
// combat-fx-events の report の event の一覧のとおり（闘技会の応答は画面の validateArenaEvents を通る）。撮る前の姿が要る出来事
// （体力が減っている・倒れている・敵が隣にいる）は、同じ書き換えで先にその姿を一度渡して落ち着かせてから撮る。
//
// こまの撮り方: 書き換えた応答を画面へ渡した時刻を 0 とし、決めた時刻でページの中の動きと setTimeout を全部止めて、出来事の升の
// まわりを切り出して撮る（撮り終えたら動かし直す。止めていた長さは時刻に数えない）。こまごとの実際の時刻を manifest に残し、
// 一続きのこまを時刻つきで並べた一枚（*-sheet.png）も作る。
//
// scenes:
//   dungeon   相棒を連れて潜り、回復の魔法・HP の品（相棒へ）・MP の品・蘇生（相棒）・回避の魔法（瞬間と、次の応答でもかかっている間の
//             印）・打撃の外れ（主人公→隣の敵）・魔法の外れ（隣の敵の属性の一撃→主人公）・範囲の空振り、動きを減らす設定で回復と外れ
//   arena     バディーと二人の大会（主人公の能力値を上限）の第一試合で、回復の魔法・HP の品（バディーへ）・MP の品・蘇生（バディー）・
//             打撃の外れ（相手→主人公）・魔法の外れ（主人公→相手・闘技会のサーバは魔法の外れを出さない）・範囲の空振り、動きを
//             減らす設定で回復・魔法の当たり（浮く数）・外れ。そのあと試合を本物の手で決着まで送り（届いた出来事の kind を数える）、表で一回戦の
//             見返しを開いて、一歩目から三歩目の出来事を外れ一つに書き換え、一歩ごとに速さを低速→中速→高速と替えて、外れの動き
//             （駒が身をかわす動き・抜ける弾）が見えている長さを測る
//   arena-replay-miss  主人公の能力値を上限にした一人の大会の第一試合を本物の手で勝ち、表の目（NPC の試合）の見返しを node から
//             サーバに引いて、魔法が外れた一手（cast の hit:false・whiff:false）を持つ最初の試合の目を押す。画面はその見返しの応答を
//             書き換えずに流し、最初の外れの一歩が始まった時刻を 0 としてこまを撮る。その一手の記録の行と、node が引いた応答と画面が
//             受けた応答の一致も残す
//   timing-champion    主人公の能力値を上限にした一人の大会を優勝まで、凍らせずに送って測る
//   timing-eliminated  主人公の能力値を全部 0 にした一人の大会を一回戦の敗退まで、同じく測る
//
// 測りの手の送り方（timing-*）: 体力が半分を切り、回復の札が押せれば回復。そうでなければ撃てる魔法の札の先頭。撃って誤り（届かない）
// が返ったら、いちばん近い生きた相手へ差の大きい軸で一歩寄り、その一歩も誤りならもう一方の軸で寄る。それも誤りか撃てる札が無ければ
// 待機。応答のあと、一手の流れ（呪文の欄の is-flowing）が終わるのを待ち、HUMAN_GAP_MS 空けて次を送る。表では試合を始める紋が
// 出たらすぐ押す。手の選び方は view だけで決まるので、同じ保存・同じ週の seed なら製品の版を替えても同じ手が送られる。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const PRE_SETTLE_MS = 1400;
const LM_WAIT_MS = 120000;
const TURN_LIMIT = 400;
const HUMAN_GAP_MS = 300;
const HOST = '127.0.0.1';
const BUDDY_ID = 'character_001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// こまの時刻（ms・書き換えた応答を渡した時から）。闘技会は手の主の区切り（輪の受け渡し）の分だけ遅れて始まる。
const DUNGEON_FRAMES = [0, 40, 80, 120, 160, 200, 240, 300, 360, 440, 520, 620, 740, 880, 1040];
const ARENA_FRAMES = [0, 100, 140, 180, 240, 300, 380, 460, 560, 660, 760, 840, 920, 1000, 1100, 1220, 1400];
const REDUCED_FRAMES = [0, 40, 80, 140, 200, 280, 400];
// 見返しの一歩（低速 1100ms）の内に収まる、ARENA_FRAMES と同じ時刻。
const REPLAY_FRAMES = ARENA_FRAMES.filter((ms) => ms < 1100);
const SHEET_COLUMNS = 6;
const SHEET_CELL_WIDTH = 320;

const SCENE_NAMES = ['dungeon', 'arena', 'arena-replay-miss', 'timing-champion', 'timing-eliminated'];

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--scenes'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.includes(argv[i])) throw new Error(`unexpected argument: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    parsed[argv[i]] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required`);
  for (const key of ['--repo-root', '--out']) if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be absolute`);
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) if (!SCENE_NAMES.includes(scene)) throw new Error(`unknown scene ${scene}`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], scenes };
}

// ── 固定応答の LM ──
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
  ['所持金判定', '0']
];
const ARENA_INTRO_MARKER = '次の試合の開始を告げる短い口上を書く。';
const ARENA_RESULT_MARKER = '結果を告げる実況を一文だけ書く。';

function createFixtureLm(hubLines) {
  return async function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') return { kind: schemaName, content: JSON.stringify({ expression: 'neutral' }) };
    if (schemaName === 'work_record_recall_choice') return { kind: schemaName, content: JSON.stringify({ work_record_ids: [] }) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      return { kind: 'hub-destination', content: matches.length === 1 ? matches[0][0] : 'none' };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { kind: 'event-flag', content: 'false' };
    if (prompt.includes(ARENA_INTRO_MARKER)) return { kind: 'arena-intro', content: '夜の闘技場に篝火が揺れ、魔法陣の上で影が向かい合う。' };
    if (prompt.includes(ARENA_RESULT_MARKER)) return { kind: 'arena-result', content: '篝火の円形の場に、この大会の結びが高く告げられた。' };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) if (prompt.includes(marker)) return { kind: marker, content };
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat', content: '（顔を上げて）ええ、行きましょう。' };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: '学院で主人公と少し話した。' };
    throw new Error(`fixture lm: unknown request: ${prompt.slice(-160)}`);
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}
function closeServer(server) {
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
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
// 能力値の file の形はそのまま、値だけを to へ（{value} の形でも数そのものでも）。
function setParameters(node, to) {
  if (typeof node === 'number') return to;
  if (node && typeof node === 'object') {
    if ('value' in node && typeof node.value === 'number') return { ...node, value: to };
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, setParameters(v, to)]));
  }
  return node;
}
const POWER_VALUES = { max: 100, min: 0 };

async function startProduct(repoRoot, { power, buddy }) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((d) => [d.id, `今週は${d.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'combat-fx-capture-'));
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
    const playArea = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    if (buddy) {
      const { setRelationshipDebugState } = await product('relationshipState.mjs');
      await setRelationshipDebugState({ root: playArea.root, buddyCharacterId: buddy });
    }
    if (power !== 'default') {
      const paramFiles = await findFiles(root, 'player_parameters.json');
      if (!paramFiles.length) throw new Error(`no player_parameters.json to set to ${power}`);
      for (const file of paramFiles) {
        const json = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, `${JSON.stringify(setParameters(json, POWER_VALUES[power]), null, 2)}\n`, 'utf8');
      }
    }
    const answer = createFixtureLm(hubLines);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = await answer(body);
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
      base: `http://${HOST}:${port}`, root, hubLines, lmFailures,
      async stop() { for (const close of closers.reverse()) await close(); await fs.rm(root, { recursive: true, force: true }); }
    };
  } catch (error) {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

// ── ページの中の道具 ──
// 応答の控え（dungeon・arena・replay）と、次の一つの応答の書き換え（rewrite: { key, frames, fn }）。書き換えた応答を画面へ渡した時刻を
// 0 とし、frames の時刻で順にページを止める（動きを全部止め、止めている間に来る setTimeout は後へ回す）。止めていた長さは時刻に
// 数えない。見返しの見張り（watchReplay）は、一歩ごとの始まりと、外れの動き（駒の身をかわす動き・抜ける弾）が見えていた時刻を残す。
const PAGE_TOOLS = `(() => {
  if (window.__fx) return true;
  const fx = window.__fx = { seq: 0, last: {}, kinds: {}, rewrite: null, rewriteError: null, t0: null, frozen: null, frozenAt: 0, pausedTotal: 0, queued: [], plan: null, paused: new Set(), replay: null };
  const realSetTimeout = window.setTimeout.bind(window);
  const virtualNow = () => performance.now() - fx.pausedTotal;
  const timers = new Map();
  const dispatch = (timer) => {
    if (timer.cancelled) return;
    if (fx.frozen) { fx.queued.push(timer); return; }
    const remaining = timer.due - virtualNow();
    if (remaining > 1) { realSetTimeout(() => dispatch(timer), remaining); return; }
    timers.delete(timer.id);
    timer.fn(...timer.args);
  };
  window.setTimeout = (fn, ms = 0, ...args) => {
    const timer = { fn, args, due: virtualNow() + ms, cancelled: false };
    timer.id = realSetTimeout(() => dispatch(timer), ms);
    timers.set(timer.id, timer);
    return timer.id;
  };
  const realClearTimeout = window.clearTimeout.bind(window);
  window.clearTimeout = (id) => {
    const timer = timers.get(id);
    if (timer) { timer.cancelled = true; timers.delete(id); }
    realClearTimeout(id);
  };
  const flushStyle = () => { void document.documentElement.getBoundingClientRect(); };
  const pauseAll = () => { flushStyle(); for (const a of document.getAnimations()) if (a.playState === 'running') { a.pause(); fx.paused.add(a); } };
  const holdLoop = () => { if (!fx.frozen) return; pauseAll(); realSetTimeout(holdLoop, 4); };
  const armNext = () => {
    const plan = fx.plan;
    if (!plan || !plan.offsets.length) return;
    const target = plan.offsets[0];
    realSetTimeout(() => {
      if (fx.plan !== plan) return;
      if (virtualNow() - fx.t0 < target - 0.5) { armNext(); return; }
      plan.offsets.shift();
      fx.frozen = { target, actual: Math.round((virtualNow() - fx.t0) * 10) / 10 };
      fx.frozenAt = performance.now();
      pauseAll();
      holdLoop();
    }, Math.max(0, target - (virtualNow() - fx.t0)));
  };
  fx.resume = () => {
    fx.pausedTotal += performance.now() - fx.frozenAt;
    fx.frozen = null;
    for (const timer of fx.queued.splice(0)) dispatch(timer);
    // 終わりの時刻で止めた動きは play() すると頭から始め直すので、終わらせる。
    for (const a of fx.paused) if (a.playState === 'paused') { if (a.currentTime >= a.effect.getComputedTiming().endTime) a.finish(); else a.play(); }
    fx.paused.clear();
    armNext();
    return true;
  };
  fx.planDone = () => !fx.plan || (!fx.plan.offsets.length && !fx.frozen);
  // 見返しの index 番目の一歩が始まった時（ターンの数の字がそれに替わった時）を 0 として、frames の時刻で止める。
  fx.armReplayStep = (index, frames) => {
    const node = document.querySelector('#arena-replay-controls');
    const want = (index + 1) + ' / ';
    const observer = new MutationObserver(() => {
      if (!(node.querySelector('.arena-replay-info')?.textContent ?? '').startsWith(want)) return;
      observer.disconnect();
      fx.t0 = virtualNow();
      fx.plan = { offsets: [...frames] };
      armNext();
    });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    return true;
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = typeof input === 'string' ? input : input.url;
    const key = /\\/api\\/dungeon\\/action$/.test(url) ? 'dungeon'
      : /\\/api\\/arena\\/(match\\/start|action)$/.test(url) ? 'arena'
        : /\\/api\\/arena\\/match\\/[^/]+\\/replay$/.test(url) ? 'replay' : null;
    if (!key) return response;
    let json = await response.clone().json();
    fx.last[key] = json;
    if (/\\/action$/.test(url)) for (const e of json.events ?? []) fx.kinds[e.kind] = (fx.kinds[e.kind] ?? 0) + 1;
    const rewrite = fx.rewrite && fx.rewrite.key === key ? fx.rewrite : null;
    if (rewrite) {
      fx.rewrite = null;
      try { json = rewrite.fn(json); } catch (error) { fx.rewriteError = String(error.message); throw error; }
      fx.rewritten = json;
    }
    fx.seq += 1;
    if (!rewrite) return response;
    if (rewrite.frames) { fx.t0 = virtualNow(); fx.plan = { offsets: [...rewrite.frames] }; armNext(); }
    return new Response(JSON.stringify(json), { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  // 見返しの見張り: 一歩の始まり（ターンの数の字が替わった時）と、その一歩で外れの動きが見えていた最初と最後の時刻（ページの時計）。
  fx.watchReplay = () => {
    const steps = fx.replay = [];
    const info = () => document.querySelector('#arena-replay-controls .arena-replay-info')?.textContent ?? '';
    const isDodge = (a) => {
      const target = a.effect?.target;
      if (!target?.classList?.contains('an-token') || a.playState !== 'running') return false;
      const frames = a.effect.getKeyframes();
      return frames.length === 3 && /translate\\(-?[\\d.]+px/.test(frames[1].transform ?? '');
    };
    let lastInfo = info();
    const tick = () => {
      if (fx.replay !== steps) return;
      const now = performance.now();
      const text = info();
      if (text !== lastInfo) { lastInfo = text; steps.push({ info: text, start: now, dodge: null, pass: null }); }
      const step = steps.at(-1);
      if (step) {
        const dodging = document.getAnimations().some(isDodge);
        const passing = [...document.querySelectorAll('#arena-grid .an-bolt')].some((bolt) => bolt.getAnimations().some((a) => a.playState === 'running' && a.effect.getKeyframes().some((k) => String(k.opacity) === '0')));
        for (const [name, on] of [['dodge', dodging], ['pass', passing]]) {
          if (!on) continue;
          step[name] ??= { first: now, last: now };
          step[name].last = now;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  };
  return true;
})()`;

const PAGE_STATE = `(() => ({
  screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
  arenaStage: document.querySelector('#academy-arena-screen')?.dataset.stage ?? null,
  dungeonScene: document.querySelector('#academy-dungeon-screen')?.dataset.scene ?? null
}))()`;

async function openPage(guard) {
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (event, level, message) => { if (level === 3) { pageErrors.push(message); console.log(`renderer-error: ${message}`); } });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js, send, pageErrors,
    async reducedMotion(on) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
      const matches = await js("matchMedia('(prefers-reduced-motion: reduce)').matches");
      if (matches !== on) throw new Error(`prefers-reduced-motion did not become ${on}`);
    },
    async load(url) {
      await win.loadURL(url);
      const m = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
      if (m.w !== VIEWPORT.width || m.h !== VIEWPORT.height || m.dpr !== 1) throw new Error(`viewport ${JSON.stringify(m)}`);
    },
    async waitFor(predicate, label, timeoutMs = 30000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        guard();
        if (await js(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`)) return;
        await sleep(30);
      }
      throw new Error(`timed out waiting for ${label} (page: ${JSON.stringify(await js(PAGE_STATE).catch(() => null))})`);
    },
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async click(selectorExpr, label) {
      const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      await page.clickAt(box.x, box.y);
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) { await send('Input.insertText', { text: character }); await sleep(20); }
    },
    async press(key, code, vk) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
      await js('document.activeElement?.blur?.(); true');
    },
    async png(clip) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...clip, scale: 1 } });
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

const DUNGEON = 'academy-dungeon-screen';
const DUNGEON_ENTRY = `${settled(DUNGEON)} && document.querySelector('#${DUNGEON}').dataset.scene === 'entry' && !document.querySelector('#dungeon-dive').disabled && document.querySelector('#terrace-opened').hidden`;
const DUNGEON_PLAY = `document.querySelector('#${DUNGEON}').dataset.scene === 'play' && !${VEIL_UP} && !${LOADING_ACTIVE}`;
const ARENA = 'academy-arena-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const FIGHT_READY = `${ARENA_STAGE('bracket')} && document.querySelector('#arena-bracket-actions .arena-fight')`;
const RESULT_UP = `${ARENA_STAGE('result')} && !document.querySelector('#arena-result').hidden`;
const BACK_FROM_MATCH = `(${FIGHT_READY} || ${RESULT_UP})`;
const MATCH_INPUT = `${ARENA_STAGE('match')} && !document.querySelector('#arena-dock-main').hidden && !document.querySelector('#arena-dock-main').classList.contains('is-flowing') && !document.querySelector('#arena-match').dataset.flow`;
const ARROW_KEYS = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39] };
const STEPS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

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
}

async function sendOff(ctx, destination) {
  const { page } = ctx;
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', ctx.product.hubLines[destination]);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
}

// ── 撮る ──
// 出来事の升（tiles）を囲む切り出し: 升の外へ margin 升ずつ広げ、最小 minCells 升四方、窓の内側に収める。
const TILE_CLIP = (screen, tiles, margin, minCells) => `(() => {
  const dn = ${screen === 'dungeon'};
  const layer = document.querySelector(dn ? '#dungeon-viewport .dn-effects' : '#arena-grid .an-effects');
  const host = dn ? document.querySelector('#dungeon-viewport') : document.querySelector('#arena-grid');
  const cs = getComputedStyle(host);
  const cell = parseFloat(cs.getPropertyValue(dn ? '--dn-cell' : '--an-cell'));
  const step = cell + parseFloat(cs.getPropertyValue(dn ? '--dn-gap' : '--an-gap'));
  const o = layer.getBoundingClientRect();
  const tiles = ${JSON.stringify(tiles)};
  const xs = tiles.map((t) => o.left + t.x * step + cell / 2), ys = tiles.map((t) => o.top + t.y * step + cell / 2);
  const half = (lo, hi) => Math.max((hi - lo) / 2 + ${margin} * step, ${minCells} * step / 2);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const hx = half(Math.min(...xs), Math.max(...xs)), hy = half(Math.min(...ys), Math.max(...ys));
  const x = Math.max(0, Math.round(cx - hx)), y = Math.max(0, Math.round(cy - hy));
  return { x, y, width: Math.min(innerWidth - x, Math.round(2 * hx)), height: Math.min(innerHeight - y, Math.round(2 * hy)), cell: Math.round(cell * 10) / 10 };
})()`;

// 応答を書き換える式: body は json を受けて書き換えた json を返す関数の本体（dungeon の json は view そのもの、arena は { view, events, ... }）。
const setRewrite = (key, frames, body) => `(() => { window.__fx.rewrite = { key: ${JSON.stringify(key)}, frames: ${JSON.stringify(frames)}, fn: (json) => { ${body} } }; return true; })()`;

// 一つの出来事の一続きを撮る: 書き換えを置き、断られる入力を送り、時刻ごとに止まったページを切り出して撮る。
async function filmSequence(ctx, { screen, name, note, tiles, frames, rewrite, trigger }) {
  const { page } = ctx;
  const dir = path.join(ctx.options.out, screen);
  await fs.mkdir(dir, { recursive: true });
  const clip = await page.js(TILE_CLIP(screen, tiles, 1.6, 4));
  const seq = await page.js('window.__fx.seq');
  await page.js(setRewrite(screen, frames, rewrite));
  await trigger();
  const shots = [];
  for (let index = 0; index < frames.length; index += 1) {
    await page.waitFor('window.__fx.frozen || window.__fx.rewriteError', `${name} frame ${frames[index]}ms`, 15000);
    const rewriteError = await page.js('window.__fx.rewriteError');
    if (rewriteError) throw new Error(`${name}: ${rewriteError}`);
    const frozen = await page.js('window.__fx.frozen');
    const file = path.join(dir, `${name}-f${String(index).padStart(2, '0')}-${String(frozen.target).padStart(4, '0')}ms.png`);
    const bytes = await page.png(clip);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    shots.push({ file, target_ms: frozen.target, actual_ms: frozen.actual, bytes });
    await page.js('window.__fx.resume()');
  }
  await page.waitFor(`window.__fx.seq > ${seq} && window.__fx.planDone()`, `${name} done`, 5000);
  const events = await page.js(screen === 'dungeon' ? 'window.__fx.rewritten.events' : 'window.__fx.rewritten.events');
  const sheet = path.join(dir, `${name}-sheet.png`);
  await fs.writeFile(sheet, await composeSheet(ctx, shots, `${screen} / ${name}`), { flag: 'wx' });
  const record = { screen, name, note, clip, events, sheet, frames: shots.map(({ file, target_ms, actual_ms }) => ({ file, target_ms, actual_ms })) };
  ctx.sequences.push(record);
  console.log(`FILM ${screen}/${name} frames=${shots.length} actual=[${shots.map((s) => s.actual_ms).join(',')}] events=${JSON.stringify(events)}`);
  await sleep(SETTLE_MS);
  return record;
}

// 撮る前の姿を一度渡して落ち着かせる（こまは撮らない）。
async function stage(ctx, screen, label, rewrite, trigger) {
  const { page } = ctx;
  const seq = await page.js('window.__fx.seq');
  await page.js(setRewrite(screen, null, rewrite));
  await trigger();
  await page.waitFor(`window.__fx.seq > ${seq} || window.__fx.rewriteError`, `${label} staged`, 15000);
  const rewriteError = await page.js('window.__fx.rewriteError');
  if (rewriteError) throw new Error(`${label}: ${rewriteError}`);
  await sleep(PRE_SETTLE_MS);
}

// 時刻つきのこまを一枚に並べる（別の窓の canvas で）。
async function composeSheet(ctx, shots, title) {
  if (!ctx.sheetWindow) {
    ctx.sheetWindow = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { backgroundThrottling: false } });
    await ctx.sheetWindow.loadURL('about:blank');
  }
  const images = shots.map((shot) => ({ src: `data:image/png;base64,${shot.bytes.toString('base64')}`, label: `${Math.round(shot.actual_ms)} ms` }));
  const dataUrl = await ctx.sheetWindow.webContents.executeJavaScript(`(async () => {
    const images = ${JSON.stringify(images)};
    const loaded = await Promise.all(images.map((item) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = item.src; })));
    const w = ${SHEET_CELL_WIDTH}, scale = w / loaded[0].naturalWidth, h = Math.round(loaded[0].naturalHeight * scale);
    const cols = Math.min(${SHEET_COLUMNS}, loaded.length), rows = Math.ceil(loaded.length / cols), head = 28;
    const canvas = document.createElement('canvas');
    canvas.width = cols * w + (cols + 1) * 4; canvas.height = head + rows * h + (rows + 1) * 4;
    const g = canvas.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#eee'; g.font = '16px sans-serif'; g.fillText(${JSON.stringify(title)}, 6, 19);
    loaded.forEach((img, i) => {
      const x = 4 + (i % cols) * (w + 4), y = head + 4 + Math.floor(i / cols) * (h + 4);
      g.drawImage(img, x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(x, y, 78, 20);
      g.fillStyle = '#ffe9a8'; g.font = '13px monospace'; g.fillText(images[i].label, x + 5, y + 14);
    });
    return canvas.toDataURL('image/png');
  })()`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// ── ダンジョン ──
// 階段の外での Enter（降りる）は、サーバが手を進めずに not_on_stairs で断る。
async function dungeonTrigger(ctx) {
  await ctx.page.moveAway();
  await ctx.page.press('Enter', 'Enter', 13);
}
// 書き換えの頭: 断られた応答であることを確かめ、action_error を外す。
const DUNGEON_REFUSED = "if (json.action_error !== 'not_on_stairs') throw new Error('the trigger was not refused off the stairs: ' + JSON.stringify(json.action_error)); json.action_error = null; json.events = [];";

async function savedDungeonEnemy(ctx) {
  for (const file of await findFiles(ctx.product.root, 'runtime_state.json')) {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    const enemy = state.dungeon_run?.enemies?.find((candidate) => candidate.hp > 0);
    if (enemy) return { uid: 'capture-foe', archetype_id: enemy.archetype_id, name: enemy.name, element: enemy.element, glyph: enemy.glyph, hp: enemy.hp, max_hp: enemy.max_hp, boss: false, elite: false };
  }
  throw new Error('no living enemy in the saved dungeon run');
}

function floorAround(view, at, taken, distances) {
  for (const d of distances) {
    for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
      const x = at.x + dx;
      const y = at.y + dy;
      if (view.tiles[y]?.[x] !== 'floor') continue;
      if (taken.some((t) => t.x === x && t.y === y)) continue;
      return { x, y };
    }
  }
  throw new Error(`no free floor tile around ${at.x},${at.y}`);
}

async function dungeonScene(ctx) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOff(ctx, 'dungeon');
  await page.waitFor(DUNGEON_ENTRY, 'the dungeon entry', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.js(PAGE_TOOLS);
  await page.click("document.querySelector('#dungeon-dive')", '潜る');
  await page.waitFor(DUNGEON_PLAY, 'the dungeon play scene', LM_WAIT_MS);
  await page.waitFor(`${motionSettled(`#${DUNGEON}`)} && ${IMAGES_LOADED(`#${DUNGEON}`)}`, 'the dungeon board settled');
  await sleep(SETTLE_MS);
  // 盤の view を一度受け取る（書き換えない断られた Enter。記録に「階段の上でだけ」の一行が出る）。
  await dungeonTrigger(ctx);
  await page.waitFor('window.__fx.last.dungeon', 'the first refused dungeon response', 15000);
  await sleep(SETTLE_MS);
  const view = await page.js('window.__fx.last.dungeon');
  if (view.action_error !== 'not_on_stairs') throw new Error(`the first Enter was not refused off the stairs: ${view.action_error}`);
  if (!view.companion || view.companion.down) throw new Error('the dungeon run has no standing companion');
  const p = { x: view.player.x, y: view.player.y };
  const c = { x: view.companion.x, y: view.companion.y };
  const foe = { ...(await savedDungeonEnemy(ctx)), ...floorAround(view, p, [c], [1]) };
  const empty = floorAround(view, p, [c, foe], [3, 2]);
  const element = view.castable_elements[0]?.element;
  if (!element) throw new Error('the protagonist has no castable element');
  ctx.notes.dungeon = { player: p, companion: c, foe, empty, element };
  const trigger = () => dungeonTrigger(ctx);
  const film = (name, note, tiles, rewrite, frames = DUNGEON_FRAMES) => filmSequence(ctx, { screen: 'dungeon', name, note, tiles, frames, rewrite: `${DUNGEON_REFUSED} ${rewrite} return json;`, trigger });
  const pre = (label, rewrite) => stage(ctx, 'dungeon', label, `${DUNGEON_REFUSED} ${rewrite} return json;`, trigger);
  const P = JSON.stringify(p);
  const C = JSON.stringify(c);

  await pre('player hurt', 'json.player.hp = Math.round(json.player.max_hp * 0.35);');
  await film('heal-spell', '回復の魔法（主人公が自分に・HP）', [p], `json.events = [{ kind: 'heal', from: ${P}, to: ${P}, resource: 'hp', source: 'spell', amount: json.player.hp - Math.round(json.player.max_hp * 0.35) }];`);
  await pre('companion hurt', 'json.companion.hp = Math.round(json.companion.max_hp * 0.3);');
  await film('hp-item', 'HP の品（主人公が相棒へ）', [p, c], `json.events = [{ kind: 'heal', from: ${P}, to: ${C}, resource: 'hp', source: 'item', amount: json.companion.hp - Math.round(json.companion.max_hp * 0.3) }];`);
  await pre('player drained', 'json.player.mp = Math.round(json.player.max_mp * 0.1);');
  await film('mp-item', 'MP の品（主人公が自分に）', [p], `json.events = [{ kind: 'heal', from: ${P}, to: ${P}, resource: 'mp', source: 'item', amount: json.player.mp - Math.round(json.player.max_mp * 0.1) }];`);
  await pre('companion down', 'json.companion.hp = 0; json.companion.down = true;');
  await film('revive', '蘇生（主人公が相棒を・立った升）', [p, c], `json.events = [{ kind: 'revive', from: ${P}, to: ${C}, amount: json.companion.hp }];`);
  const warded = `json.evasion_spell = { ...json.evasion_spell, active: true, turns_remaining: json.evasion_spell.duration };`;
  await film('evasion-cast', '回避の魔法をかけた瞬間', [p], `${warded} json.events = [{ kind: 'evasion', from: ${P}, to: ${P} }];`);
  await film('evasion-held', '回避の魔法がかかっている間（出来事の無い次の応答・演出は畳まれ、印は view から残る）', [p], `${warded}`, [0, 600]);
  ctx.notes.dungeon.wardedMark = await page.js("(() => { const token = document.querySelector('#dungeon-viewport .dn-entity--player .dn-token'); const after = getComputedStyle(token, '::after'); return { warded: token.parentNode.classList.contains('dn-entity--warded'), border: after.borderTopStyle + ' ' + after.borderTopWidth + ' ' + after.borderTopColor, animations: token.getAnimations().length }; })()");
  console.log(`WARDED ${JSON.stringify(ctx.notes.dungeon.wardedMark)}`);
  const withFoe = `json.enemies = [...json.enemies, ${JSON.stringify(foe)}];`;
  await pre('foe beside the protagonist', withFoe);
  const F = JSON.stringify({ x: foe.x, y: foe.y });
  await film('melee-miss', '打撃の外れ（主人公→隣の敵・敵が身をかわす）', [p, foe], `${withFoe} json.events = [{ kind: 'melee', from: ${P}, to: ${F}, element: null, hit: false, damage: 0, crit: false, whiff: false }];`);
  await film('magic-miss', '魔法の外れ（隣の敵の属性の一撃→主人公・主人公が身をかわす）', [p, foe], `${withFoe} json.events = [{ kind: 'enemy_attack', from: ${F}, to: ${P}, element: ${JSON.stringify(foe.element)}, hit: false, damage: 0, crit: false, whiff: false }];`);
  await film('area-whiff', '範囲の投げ物の空振り（誰もいない升）', [p, empty], `${withFoe} json.events = [{ kind: 'cast', from: ${P}, to: ${JSON.stringify(empty)}, element: ${JSON.stringify(element)}, hit: false, damage: 0, crit: false, whiff: true }];`);

  await page.reducedMotion(true);
  await pre('player hurt (reduced)', `${withFoe} json.player.hp = Math.round(json.player.max_hp * 0.35);`);
  await film('reduced-heal-spell', '動きを減らす設定: 回復の魔法', [p], `${withFoe} json.events = [{ kind: 'heal', from: ${P}, to: ${P}, resource: 'hp', source: 'spell', amount: json.player.hp - Math.round(json.player.max_hp * 0.35) }];`, REDUCED_FRAMES);
  await film('reduced-magic-miss', '動きを減らす設定: 魔法の外れ（敵→主人公）', [p, foe], `${withFoe} json.events = [{ kind: 'enemy_attack', from: ${F}, to: ${P}, element: ${JSON.stringify(foe.element)}, hit: false, damage: 0, crit: false, whiff: false }];`, REDUCED_FRAMES);
  await page.reducedMotion(false);
}

// ── 闘技会 ──
// 主人公の升から、壁か人のいる升への向き（サーバは blocked で断り、手を進めない）。
function blockedDirection(view) {
  const me = view.actors.find((a) => a.actor_id === view.player_actor_id);
  for (const [direction, [dx, dy]] of Object.entries(STEPS)) {
    const x = me.x + dx;
    const y = me.y + dy;
    if (view.tiles[y]?.[x] !== 'floor' || view.actors.some((a) => !a.down && a.x === x && a.y === y)) return direction;
  }
  throw new Error(`no blocked direction around the protagonist at ${me.x},${me.y}`);
}
const ARENA_REFUSED = "if (json.view.action_error !== 'blocked') throw new Error('the trigger was not refused: ' + JSON.stringify(json.view.action_error)); json.view.action_error = null; json.events = [];";
const arenaActor = (id) => `json.view.actors.find((a) => a.actor_id === ${JSON.stringify(id)})`;

async function arenaScene(ctx) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOff(ctx, 'arena');
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection', LM_WAIT_MS);
  await page.js(PAGE_TOOLS);
  await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="pair"]')`, '二人の立ち位置');
  await page.waitFor(FIGHT_READY, 'the bracket', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('#arena-bracket-actions .arena-fight')", '試合開始');
  await page.waitFor(`${MATCH_INPUT} && ${IMAGES_LOADED(`#${ARENA}`)}`, 'the first input', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  const view = (await page.js('window.__fx.last.arena')).view;
  const me = view.actors.find((a) => a.actor_id === view.player_actor_id);
  const buddy = view.actors.find((a) => a.team === me.team && a.actor_id !== me.actor_id);
  const foe = view.actors.find((a) => a.team !== me.team);
  if (!buddy) throw new Error('the pair match has no buddy');
  const direction = blockedDirection(view);
  const element = view.castable_elements?.[0]?.element ?? me.element;
  const empty = (() => {
    for (let d = 3; d >= 2; d -= 1) {
      for (const [dx, dy] of [[d, 0], [0, d], [0, -d], [-d, 0]]) {
        const x = me.x + dx;
        const y = me.y + dy;
        if (view.tiles[y]?.[x] === 'floor' && !view.actors.some((a) => a.x === x && a.y === y)) return { x, y };
      }
    }
    throw new Error('no empty floor tile for the whiff');
  })();
  ctx.notes.arena = { me: `${me.actor_id}@${me.x},${me.y}`, buddy: `${buddy.actor_id}@${buddy.x},${buddy.y}`, foe: `${foe.actor_id}@${foe.x},${foe.y}`, direction, element, empty };
  const trigger = async () => {
    await page.moveAway();
    const [key, vk] = ARROW_KEYS[direction];
    await page.press(key, key, vk);
  };
  // 外れは隣で起きる形で撮る: 相手を主人公の隣の空いた床へ置いた姿を先に渡す（サーバの相手は動かない）。
  const beside = (() => {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const x = me.x + dx;
      const y = me.y + dy;
      if (view.tiles[y]?.[x] === 'floor' && !view.actors.some((a) => a.x === x && a.y === y)) return { x, y };
    }
    throw new Error('no free floor tile beside the protagonist');
  })();
  ctx.notes.arena.foeBeside = beside;
  const P = JSON.stringify({ x: me.x, y: me.y });
  const B = JSON.stringify({ x: buddy.x, y: buddy.y });
  const F = JSON.stringify(beside);
  const film = async (name, note, tiles, rewrite, frames = ARENA_FRAMES) => {
    await page.waitFor(MATCH_INPUT, `${name}: the input`, 15000);
    return filmSequence(ctx, { screen: 'arena', name, note, tiles, frames, rewrite: `${ARENA_REFUSED} ${rewrite} return json;`, trigger });
  };
  const pre = async (label, rewrite) => {
    await page.waitFor(MATCH_INPUT, `${label}: the input`, 15000);
    await stage(ctx, 'arena', label, `${ARENA_REFUSED} ${rewrite} return json;`, trigger);
  };
  const ME = arenaActor(me.actor_id);
  const BU = arenaActor(buddy.actor_id);
  const low = (who, field, max, share) => `${who}.${field} = Math.round(${who}.${max} * ${share});`;

  await pre('protagonist hurt', low(ME, 'hp', 'max_hp', 0.35));
  await film('heal-spell', '回復の魔法（主人公が自分に・HP・主人公の手）', [me], `json.events = [{ kind: 'heal', from: ${P}, to: ${P}, resource: 'hp', source: 'spell', amount: ${ME}.hp - Math.round(${ME}.max_hp * 0.35) }];`);
  await pre('buddy hurt', low(BU, 'hp', 'max_hp', 0.3));
  await film('hp-item', 'HP の品（主人公がバディーへ）', [me, buddy], `json.events = [{ kind: 'heal', from: ${P}, to: ${B}, resource: 'hp', source: 'item', amount: ${BU}.hp - Math.round(${BU}.max_hp * 0.3) }];`);
  await pre('protagonist drained', low(ME, 'mp', 'max_mp', 0.1));
  await film('mp-item', 'MP の品（主人公が自分に）', [me], `json.events = [{ kind: 'heal', from: ${P}, to: ${P}, resource: 'mp', source: 'item', amount: ${ME}.mp - Math.round(${ME}.max_mp * 0.1) }];`);
  await pre('buddy down', `${BU}.hp = 0; ${BU}.down = true;`);
  await film('revive', '蘇生（主人公がバディーを・立った升）', [me, buddy], `json.events = [{ kind: 'revive', from: ${P}, to: ${B}, amount: ${BU}.hp }];`);
  const FOE = arenaActor(foe.actor_id);
  const besideFoe = `${FOE}.x = ${beside.x}; ${FOE}.y = ${beside.y};`;
  await pre('foe beside the protagonist', besideFoe);
  await film('melee-miss', '打撃の外れ（相手→主人公・主人公が身をかわす。相手の手の区切りで流れる）', [me, beside], `${besideFoe} json.events = [{ kind: 'melee', from: ${F}, to: ${P}, element: null, hit: false, damage: 0, crit: false, whiff: false }];`);
  await film('magic-miss', '魔法の外れ（主人公→相手・闘技会のサーバは出さない形を、描き手の確かめに渡す）', [me, beside], `${besideFoe} json.events = [{ kind: 'cast', from: ${P}, to: ${F}, element: ${JSON.stringify(element)}, hit: false, damage: 0, crit: false, whiff: false }];`);
  await film('area-whiff', '範囲の投げ物の空振り（誰もいない升）', [me, empty], `${besideFoe} json.events = [{ kind: 'cast', from: ${P}, to: ${JSON.stringify(empty)}, element: ${JSON.stringify(element)}, hit: false, damage: 0, crit: false, whiff: true }];`);

  await page.reducedMotion(true);
  await pre('protagonist hurt (reduced)', `${besideFoe} ${low(ME, 'hp', 'max_hp', 0.35)}`);
  await film('reduced-heal-spell', '動きを減らす設定: 回復の魔法', [me], `${besideFoe} json.events = [{ kind: 'heal', from: ${P}, to: ${P}, resource: 'hp', source: 'spell', amount: ${ME}.hp - Math.round(${ME}.max_hp * 0.35) }];`, REDUCED_FRAMES);
  await film('reduced-cast-hit', '動きを減らす設定: 魔法の当たり（主人公→隣の相手・浮く数）', [me, beside], `${besideFoe} json.events = [{ kind: 'cast', from: ${P}, to: ${F}, element: ${JSON.stringify(element)}, hit: true, damage: 33, crit: false, whiff: false }];`, REDUCED_FRAMES);
  await film('reduced-melee-miss', '動きを減らす設定: 打撃の外れ（相手→主人公）', [me, beside], `${besideFoe} json.events = [{ kind: 'melee', from: ${F}, to: ${P}, element: null, hit: false, damage: 0, crit: false, whiff: false }];`, REDUCED_FRAMES);
  await page.reducedMotion(false);

  // 試合を本物の手で決着まで送る（書き換えない）。
  const kindsBefore = await page.js('({ ...window.__fx.kinds })');
  const match = await playMatch(ctx);
  const kindsAfter = await page.js('({ ...window.__fx.kinds })');
  ctx.notes.arena.realMatch = { ...match, kinds: Object.fromEntries(Object.entries(kindsAfter).map(([k, v]) => [k, v - (kindsBefore[k] ?? 0)]).filter(([, v]) => v > 0)) };
  console.log(`REAL MATCH ${JSON.stringify(ctx.notes.arena.realMatch)}`);
  if (!match.won) throw new Error('the strong pair lost round 1; the replay needs the bracket');
  await page.waitFor(`${FIGHT_READY} && document.querySelector('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')`, 'a replay eye on the bracket', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  ctx.notes.arena.replaySpeeds = await measureReplaySpeeds(ctx);
}

// 見返しの一歩目から五歩目の出来事を、その手の主の組（a）の立っている者から、いちばん近い相手（b）への打撃の外れ一つに替える。
const REPLAY_MISSES = `
  const out = { ...json, turns: json.turns.map((turn) => ({ ...turn })) };
  for (let k = 1; k <= 5; k += 1) {
    const prev = out.turns[k - 1].view, view = out.turns[k].view;
    const standing = (a) => !a.down && !prev.actors.find((b) => b.actor_id === a.actor_id).down;
    const thrower = view.actors.find((a) => a.team === 'a' && standing(a));
    const target = view.actors.filter((a) => a.team === 'b' && !a.down).sort((x, y) => (Math.abs(x.x - thrower.x) + Math.abs(x.y - thrower.y)) - (Math.abs(y.x - thrower.x) + Math.abs(y.y - thrower.y)))[0];
    out.turns[k].events = [{ kind: 'melee', from: { x: thrower.x, y: thrower.y }, to: { x: target.x, y: target.y }, element: null, hit: false, damage: 0, crit: false, whiff: false }];
  }
  return out;`;

async function measureReplaySpeeds(ctx) {
  const { page } = ctx;
  await page.js(setRewrite('replay', null, REPLAY_MISSES));
  await page.click("document.querySelector('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')", '見返しの目');
  await page.waitFor(`${ARENA_STAGE('match')} && !document.querySelector('#arena-replay-controls').hidden`, 'the replay', 15000);
  await page.js('window.__fx.watchReplay()');
  const speedButton = (label) => `[...document.querySelectorAll('.arena-replay-speed-button')].find((b) => b.getAttribute('aria-label') === '${label}')`;
  const stepped = (n) => `window.__fx.replay.length >= ${n}`;
  // 速さの紋を押すと盤の pointerdown がその一歩の演出を畳むので、測る一歩の一つ前の一歩で押す: 一歩目を低速で測り、二歩目で
  // 中速を押して三歩目を測り、四歩目で高速を押して五歩目を測る（押した一歩の次の一歩から、飛ぶ時間と次までの間が替わる）。
  await page.waitFor(stepped(2), 'replay step 2', 15000);
  await page.click(speedButton('中速'), '中速');
  await page.waitFor(stepped(4), 'replay step 4', 15000);
  await page.click(speedButton('高速'), '高速');
  await page.waitFor(stepped(6), 'replay step 6', 15000);
  await page.moveAway();
  const steps = await page.js('window.__fx.replay.slice(0, 6)');
  await page.js('window.__fx.replay = null; true');
  const measured = [['低速', 0], ['中速', 2], ['高速', 4]];
  const rows = measured.map(([speed, i]) => {
    const step = steps[i];
    const next = steps[i + 1];
    const span = (m) => (m ? { from_step_start_ms: Math.round(m.first - step.start), seen_ms: Math.round(m.last - m.first) } : null);
    return { speed, info: step.info, step_ms: Math.round(next.start - step.start), dodge: span(step.dodge), pass: span(step.pass) };
  });
  for (const row of rows) console.log(`REPLAY ${JSON.stringify(row)}`);
  return rows;
}

// ── 一試合を本物の手で送る ──
const APPROACH = `(() => {
  const v = window.__fx.last.arena.view;
  const me = v.actors.find((a) => a.actor_id === v.player_actor_id);
  const foes = v.actors.filter((a) => a.team !== me.team && !a.down);
  const foe = foes.reduce((n, a) => (Math.abs(a.x - me.x) + Math.abs(a.y - me.y) < Math.abs(n.x - me.x) + Math.abs(n.y - me.y) ? a : n));
  const dx = foe.x - me.x, dy = foe.y - me.y;
  const h = dx > 0 ? 'right' : dx < 0 ? 'left' : null, w = dy > 0 ? 'down' : dy < 0 ? 'up' : null;
  return Math.abs(dx) >= Math.abs(dy) ? { primary: h, secondary: w } : { primary: w, secondary: h };
})()`;
const HURT = `(() => { const v = window.__fx.last.arena.view; const me = v.actors.find((a) => a.actor_id === v.player_actor_id); return me.hp * 2 < me.max_hp; })()`;

async function arenaAct(ctx) {
  const { page } = ctx;
  const lastErrored = await page.js('!!window.__fx.last.arena.view.action_error');
  const previous = lastErrored ? ctx.lastAct : null;
  let label = null;
  if (previous === 'cast' || previous === 'move-primary') {
    const step = await page.js(APPROACH);
    const direction = previous === 'cast' ? step.primary : step.secondary;
    if (direction) {
      const [key, vk] = ARROW_KEYS[direction];
      await page.press(key, key, vk);
      label = previous === 'cast' ? 'move-primary' : 'move-secondary';
    }
  }
  if (!label && !lastErrored && await page.js(HURT) && await page.js("!!document.querySelector('#arena-heal .arena-spell-heal:not(:disabled)')")) {
    await page.click("document.querySelector('#arena-heal .arena-spell-heal')", '回復');
    label = 'heal';
  }
  const spell = await page.js("(() => { const b = document.querySelector('#arena-spells .arena-spell:not(:disabled)'); return b ? b.getAttribute('aria-label') : null; })()");
  if (!label && spell && !lastErrored) {
    await page.click("document.querySelector('#arena-spells .arena-spell:not(:disabled)')", spell);
    label = 'cast';
  }
  if (!label) {
    await page.press(' ', 'Space', 32);
    label = 'wait';
  }
  ctx.lastAct = label;
  return label;
}

async function playMatch(ctx) {
  const { page } = ctx;
  const started = Date.now();
  const labels = {};
  let actions = 0;
  while (true) {
    if (actions > TURN_LIMIT) throw new Error('the match did not conclude');
    await page.waitFor(MATCH_INPUT, 'the next input', 15000);
    await sleep(HUMAN_GAP_MS);
    const seq = await page.js('window.__fx.seq');
    await page.moveAway();
    const label = await arenaAct(ctx);
    labels[label] = (labels[label] ?? 0) + 1;
    actions += 1;
    await page.waitFor(`window.__fx.seq > ${seq}`, 'the action response', 15000);
    if (!(await page.js('window.__fx.last.arena.view.active'))) break;
  }
  await page.waitFor(BACK_FROM_MATCH, 'the bracket or the result after the match', LM_WAIT_MS);
  const final = (await page.js('window.__fx.last.arena')).view;
  const player = final.actors.find((a) => a.kind === 'protagonist');
  return { won: final.winner === player.team, actions, labels, ms_click_to_back: Date.now() - started };
}

// 一人の大会の第一試合を本物の手で勝ち、表の一回戦の NPC の試合の見返しを書き換えずに流して、最初の魔法の外れの一歩を撮る。
async function arenaReplayMissScene(ctx) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOff(ctx, 'arena');
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection', LM_WAIT_MS);
  await page.js(PAGE_TOOLS);
  await sleep(SETTLE_MS);
  await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="solo"]')`, '一人の立ち位置');
  await page.waitFor(FIGHT_READY, 'the fight sigil', LM_WAIT_MS);
  await page.click("document.querySelector('#arena-bracket-actions .arena-fight')", '試合開始');
  const match = await playMatch(ctx);
  console.log(`REAL MATCH ${JSON.stringify(match)}`);
  if (!match.won) throw new Error('the strong protagonist lost round 1; the replay needs the bracket');
  await page.waitFor(`${FIGHT_READY} && document.querySelector('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')`, 'a replay eye on the bracket', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  const isMiss = (e) => e.kind === 'cast' && e.hit === false && e.whiff === false;
  const eyes = await page.js("[...document.querySelectorAll('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')].map((eye) => eye.dataset.matchId)");
  let served = null;
  for (const matchId of eyes) {
    const candidate = await (await fetch(`${ctx.product.base}/api/arena/match/${encodeURIComponent(matchId)}/replay`)).json();
    const misses = candidate.turns.filter((t) => t.events.some(isMiss)).length;
    console.log(`EYE ${matchId} steps=${candidate.turns.length} steps_with_magic_miss=${misses}`);
    if (misses && !served) served = candidate;
  }
  if (!served) throw new Error(`no replay among ${eyes.join(',')} has a magic miss`);
  if (await page.js('window.__fx.rewrite !== null || window.__fx.last.replay !== undefined')) throw new Error('a rewrite is set or a replay was already fetched');
  await page.click(`document.querySelector('#arena-bracket-ring .arena-ring-eye[data-match-id="${served.match_id}"]')`, '見返しの目');
  await page.waitFor('window.__fx.last.replay', 'the replay response', 15000);
  const replay = await page.js('window.__fx.last.replay');
  const index = replay.turns.findIndex((turn) => turn.events.some(isMiss));
  const turn = replay.turns[index];
  const miss = turn.events.find(isMiss);
  const clip = await page.js(TILE_CLIP('arena', [miss.from, miss.to], 1.6, 4));
  await page.js(`window.__fx.armReplayStep(${index}, ${JSON.stringify(REPLAY_FRAMES)})`);
  await page.waitFor(`${ARENA_STAGE('match')} && !document.querySelector('#arena-replay-controls').hidden`, 'the replay', 15000);
  await page.moveAway();
  const dir = path.join(ctx.options.out, 'arena');
  await fs.mkdir(dir, { recursive: true });
  const shots = [];
  for (let i = 0; i < REPLAY_FRAMES.length; i += 1) {
    await page.waitFor('window.__fx.frozen', `replay-magic-miss frame ${REPLAY_FRAMES[i]}ms`, LM_WAIT_MS);
    const frozen = await page.js('window.__fx.frozen');
    const info = await page.js("document.querySelector('#arena-replay-controls .arena-replay-info').textContent");
    if (!info.startsWith(`${index + 1} / `)) throw new Error(`frame ${frozen.target}ms is on replay step ${info}, not ${index + 1}`);
    const file = path.join(dir, `replay-magic-miss-f${String(i).padStart(2, '0')}-${String(frozen.target).padStart(4, '0')}ms.png`);
    const bytes = await page.png(clip);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    shots.push({ file, target_ms: frozen.target, actual_ms: frozen.actual, bytes });
    await page.js('window.__fx.resume()');
  }
  const sheet = path.join(dir, 'replay-magic-miss-sheet.png');
  await fs.writeFile(sheet, await composeSheet(ctx, shots, `arena / replay ${replay.match_id} step ${index + 1}/${replay.turns.length} magic miss`), { flag: 'wx' });
  // 撮った一手の出来事がサーバの試合の記録から来ていること: node がサーバから引いた見返しと、画面が受けた応答を比べる。
  // その一手で増えた記録の行（log は上限で頭が削られるので、前の一手の log の末尾と重なる最も長い頭を除く）。
  const before = replay.turns[index - 1].view.log;
  const after = turn.view.log;
  const added = [...Array(after.length + 1).keys()].find((m) => JSON.stringify(before.slice(before.length - (after.length - m))) === JSON.stringify(after.slice(0, after.length - m)));
  const logLines = after.slice(after.length - added);
  const record = {
    match_id: replay.match_id, seed: replay.seed, round: replay.round, step: index + 1, steps: replay.turns.length, events: turn.events, log_lines: logLines,
    refetch_equal: JSON.stringify(served) === JSON.stringify(replay),
    actors: Object.fromEntries(turn.view.actors.map((a) => [a.actor_id, `${a.name}@${a.x},${a.y}`]))
  };
  ctx.notes.replayMiss = record;
  ctx.sequences.push({ screen: 'arena', name: 'replay-magic-miss', clip, events: turn.events, sheet, frames: shots.map(({ file, target_ms, actual_ms }) => ({ file, target_ms, actual_ms })) });
  console.log(`FILM arena/replay-magic-miss frames=${shots.length} actual=[${shots.map((s) => s.actual_ms).join(',')}]`);
  console.log(`REPLAY MISS ${JSON.stringify(record)}`);
  if (!record.refetch_equal) throw new Error('the replay the page played differs from the server replay');
}

// 一人の大会を、表で試合を始める紋が出たらすぐ押して、優勝か敗退まで送る。
async function timingScene(ctx) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOff(ctx, 'arena');
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection', LM_WAIT_MS);
  await page.js(PAGE_TOOLS);
  await sleep(SETTLE_MS);
  const clickAt = Date.now();
  await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="solo"]')`, '一人の立ち位置');
  const matches = [];
  for (let round = 0; round < 4; round += 1) {
    await page.waitFor(FIGHT_READY, 'the fight sigil', LM_WAIT_MS);
    const fightAt = Date.now();
    await page.click("document.querySelector('#arena-bracket-actions .arena-fight')", '試合開始');
    const record = await playMatch(ctx);
    matches.push({ ...record, ms_fight_to_back: Date.now() - fightAt });
    console.log(`MATCH ${JSON.stringify(matches.at(-1))}`);
    if (!record.won) break;
  }
  await page.waitFor(RESULT_UP, 'the result stage', LM_WAIT_MS);
  ctx.notes.timing = { ms_solo_to_result: Date.now() - clickAt, matches, kinds: await page.js('({ ...window.__fx.kinds })') };
  console.log(`TIMING ${JSON.stringify(ctx.notes.timing)}`);
}

const SCENES = {
  dungeon: { power: 'default', buddy: BUDDY_ID, run: dungeonScene },
  arena: { power: 'max', buddy: BUDDY_ID, run: arenaScene },
  'arena-replay-miss': { power: 'max', buddy: null, run: arenaReplayMissScene },
  'timing-champion': { power: 'max', buddy: null, run: timingScene },
  'timing-eliminated': { power: 'min', buddy: null, run: timingScene }
};

async function runScene(options, name) {
  const plan = SCENES[name];
  const product = await startProduct(options.repoRoot, plan);
  const guard = () => { if (product.lmFailures.length) throw new Error(`fixture LM 500: ${product.lmFailures.join(' | ')}`); };
  const page = await openPage(guard);
  const ctx = { options, product, page, sequences: [], notes: {}, sheetWindow: null };
  const started = Date.now();
  try {
    await plan.run(ctx);
    guard();
    if (page.pageErrors.length) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
    console.log(`${name} renderer errors: 0`);
    return { scene: name, power: plan.power, buddy: plan.buddy, seconds: (Date.now() - started) / 1000, notes: ctx.notes, sequences: ctx.sequences };
  } finally {
    page.close();
    ctx.sheetWindow?.destroy();
    await product.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await fs.readdir(options.out).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  if (existing.length) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const started = Date.now();
  const scenes = [];
  const failed = [];
  for (const name of options.scenes) {
    try {
      scenes.push(await runScene(options, name));
      console.log(`scene ${name} done in ${scenes.at(-1).seconds.toFixed(1)} s`);
    } catch (error) {
      console.log(`SCENE FAILED ${name}: ${error.stack}`);
      failed.push(name);
    }
  }
  const manifest = { repo_root: options.repoRoot, viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, failed };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${manifest.seconds.toFixed(1)} s (failed: ${failed.join(',') || '-'})`);
  if (failed.length) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
main().then(() => app.exit(0)).catch((error) => { console.error('FAILED', error.message); app.exit(1); });
