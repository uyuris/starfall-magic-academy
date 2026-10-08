// 闘技会の攻撃と移動をダンジョンと同じ姿にした確かめの、撮影の手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   <electron> app/tests/manual/arenaParityCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,...> --diff-against <絶対パス|none>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品を、OS の一時ディレクトリに作った
// 新しいプレイ（routing・案内人 fallen_star・バディー＝content/characters の連番で最初の選べる人）の上で、この process の中に起こし、
// 露台からの本物の送り出しで入る。LM は固定応答（知らない要求は 500 にして撮影ごと止める）。--out は空でなければ止まる。
//
// 瞬間の撮り方: 条件が満ちた所で、ページの中の動き（document.getAnimations()）を全部止め、止めている間に来る setTimeout も後へ回す。
// 止めた時に動いていた動きは、どれも「自分の長さ（遅れ＋本体）の f の所」へそろえ（繰り返す動きは 0、画面の字の出入りの keyframes は
// 終わりの姿）、撮り終えたら動かし直す。そろえ方が時刻の揺れに依らないので、同じ製品・同じ手順なら同じ絵になる（変更の前と後の
// ダンジョンの画素差はこれで比べる）。f は瞬間ごとに一つ: 弾が飛ぶ 0.5・着弾 0.35・数が浮く 0.3・目盛りが削れる 0.45・滑り 0.5。
//
// scenes:
//   dungeon        潜る（相棒なし・入る seed は DUNGEON_SEED に固定）。主人公の手（弾・着弾・数・目盛り）と敵の手（同じ四つ。主人公が
//                  打たれる）と、主人公が升を滑る途中を撮る: dungeon-{self,foe}-{bolt,impact,float,gauge}.png・dungeon-slide.png
//   arena-solo     一人の第一試合。主人公の手・相手の手の同じ四つと滑り（arena-*.png）、主人公が撃てる属性を一つずつ撃った手の
//                  弾と着弾の切り抜き（arena-el-<属性>-{bolt,impact}.png）
//   arena-down     一人の第一試合を決着まで。主人公が倒れた手（arena-player-down.png と、その 1 秒後の arena-player-down-later.png）
//   arena-pair     二人（バディーあり）の第一試合を最後まで。味方の手の弾の一瞬（arena-pair-ally-bolt.png）と、風の味方の一撃から
//                  風の弾と着弾の切り抜き（主人公は風を撃てない）
//   arena-replay   能力値を上限にした主人公で一人の一回戦を勝って戻った表（一回戦の組が明かされた所）で、見返しの目の出た一回戦の
//                  自動の組の見返しを全部読み（会心の有無も書く）、一撃のある最初の見返しを再生して、最初の弾の一瞬
//                  （arena-replay-bolt.png）を撮る
//   arena-crit     会心の数（arena-crit.png）。会心は近接にだけ出て撮影の盤では起きないので、主人公の最初の一撃の応答をページの中で
//                  crit: true にして描かせる（server の数・他の event はそのまま）
// 撮った後に、全面の撮影（1440×900）ごとに四辺の端の色を測る: 端から EDGE_BAND_PX の帯の平均色（RGB）を辺ごとと四辺まとめて
// （EDGE 行）。闘技会の撮影は、撮った瞬間の盤の列（.arena-stage）の上辺と右辺をまたいで、辺の内側 BOARD_BAND_PX と外側
// BOARD_BAND_PX の帯の平均色とその差も測る（BOARD-EDGE 行）。
// 撮った後に、そろった組から並べた一枚を作る: compare-<瞬間>.png（左 = 闘技会・右 = ダンジョン）・arena-elements.png（6 属性の弾と
// 着弾）。--diff-against の dir に同じ名の dungeon-*.png があれば、画素差（違う画素の数と最大の差）を一枚ずつ出す。
import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const TURN_LIMIT = 120;
const DUNGEON_SEED = 20261008;
const PAGE_RANDOM_SEED = 4681;
const ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
const ELEMENT_LABELS = { light: '光', dark: '闇', fire: '火', water: '水', earth: '土', wind: '風' };
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 瞬間ごとの f（動きをそれぞれ自分の長さの f の所へそろえる）。
const POSE = { bolt: 0.5, impact: 0.35, float: 0.3, gauge: 0.45, slide: 0.5 };
const MOMENT_NOTES = {
  bolt: '弾が飛ぶ（弾が出た所で止め、動きを各自の長さの 0.5 へ）',
  impact: '着弾（着弾の絵が出た所で止め、0.35 へ）',
  float: '数が浮く（浮く数が出た所で止め、0.3 へ）',
  gauge: '目盛りが削れる（浮く数が出た所で止め、0.45 へ: 満ちた所が縮み、削れが残る）',
  slide: '駒が升を滑る途中（滑りが始まった所で止め、0.5 へ）'
};

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--scenes', '--diff-against'];
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
  const diffAgainst = parsed['--diff-against'] === 'none' ? null : parsed['--diff-against'];
  if (diffAgainst !== null && !path.isAbsolute(diffAgainst)) throw new Error('--diff-against must be an absolute path or none');
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], scenes, diffAgainst };
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
const ARENA_ANNOUNCE_LINE = '夜の闘技場に篝火が揺れ、魔法陣の上で二つの影が向かい合う。';

function createFixtureLm(hubLines) {
  return function answer(body) {
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
    if (prompt.includes(ARENA_ANNOUNCE_MARKER)) return { kind: 'arena-announce', content: ARENA_ANNOUNCE_LINE };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) if (prompt.includes(marker)) return { kind: marker, content };
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat', content: '（顔を上げて）ええ、行ってらっしゃい。' };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: '学院で主人公と少し話した。' };
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

// 能力値の file の形はそのまま、値だけを上限へ（{value} の形でも数そのものでも）。
function maxOut(node) {
  if (typeof node === 'number') return 100;
  if (node && typeof node === 'object') {
    if ('value' in node && typeof node.value === 'number') return { ...node, value: 100 };
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, maxOut(value)]));
  }
  return node;
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

async function startProduct(repoRoot, { strong }) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const { setRelationshipDebugState } = await product('relationshipState.mjs');
  const { isSelectableCharacterId } = await product('characterCatalog.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-parity-capture-'));
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
// 応答の控え（app が応答を読む前に写す。闘技会の応答は { view, events, … }、ダンジョンの応答は盤そのもの＋ events）・足された要素の数（class ごと）・止める／そろえる／動かし直す・順に満ちる見張り・乱数の固定。
const PAGE_TOOLS = `(() => {
  if (window.__pc) return true;
  const pc = window.__pc = { seq: 0, last: null, frozen: null, queued: [], added: new Map(), log: [], watch: null };
  const realSetTimeout = window.setTimeout.bind(window);
  pc.realSetTimeout = realSetTimeout;
  window.setTimeout = (fn, ms, ...args) => realSetTimeout(() => {
    if (pc.frozen) pc.queued.push(() => fn(...args));
    else fn(...args);
  }, ms);
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (pc.dungeonSeed !== undefined && /\\/api\\/dungeon\\/enter$/.test(url) && init?.body) {
      init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), seed: pc.dungeonSeed }) };
    }
    const response = await realFetch(input, init);
    if (/\\/api\\/(arena|dungeon)\\/action$/.test(url)) {
      const json = await response.clone().json();
      // 会心の撮影だけ: 主人公の升から出た最初の当たりの event を crit にして app へ渡す（server の応答の他は変えない）。
      if (pc.critNext && json.events) {
        const view = json.view;
        const self = view.actors.find((a) => a.kind === 'protagonist');
        const strike = json.events.find((e) => e.hit && e.from.x === self.x && e.from.y === self.y);
        if (strike) {
          strike.crit = true;
          pc.critNext = false;
          pc.critForced = strike;
          pc.last = { url, json, at: performance.now() };
          pc.seq += 1;
          return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: response.headers });
        }
      }
      pc.last = { url, json, at: performance.now() };
      pc.seq += 1;
    }
    return response;
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      for (const cls of node.classList) pc.added.set(cls, (pc.added.get(cls) ?? 0) + 1);
      if (pc.watch) pc.watch.onAdded(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
  // 止める前とそろえる前に style を確定させる: class の付け外しや幅の書き換えから生まれる CSS transition は、次の style の計算で
  // 初めて生まれるので、確定させないと「まだ生まれていない」か「生まれている」かが時刻の揺れで変わる。
  const flushStyle = () => { void document.documentElement.getBoundingClientRect(); for (const el of document.querySelectorAll('*')) getComputedStyle(el).transitionProperty; };
  const pauseAll = () => { flushStyle(); for (const a of document.getAnimations()) if (a.playState === 'running') a.pause(); };
  const holdLoop = () => { if (!pc.frozen) return; pauseAll(); realSetTimeout(holdLoop, 4); };
  pc.freeze = (name) => { pc.frozen = name; pauseAll(); holdLoop(); };
  // 動きをそろえる: 有限の動きは自分の長さ（遅れ＋本体）の f の所、繰り返す動きは 0、画面の字の出入りの keyframes（CSS animation）は終わり。
  pc.pose = (f) => {
    const counts = { posed: 0, looping: 0, ended: 0 };
    flushStyle();
    for (const a of document.getAnimations()) {
      const timing = a.effect.getComputedTiming();
      if (timing.iterations === Infinity) { a.currentTime = 0; counts.looping += 1; continue; }
      if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) { a.currentTime = timing.endTime - 0.001; counts.ended += 1; continue; }
      a.currentTime = f * (timing.delay + timing.activeDuration);
      counts.posed += 1;
      const target = a.effect.target;
      (counts.detail ??= []).push(a.constructor.name + ':' + (target?.id || target?.className?.baseVal || target?.className || '?') + ':' + (a.transitionProperty ?? '') + '@' + Math.round(a.currentTime) + '/' + Math.round(timing.endTime));
    }
    return counts;
  };
  pc.resume = () => {
    pc.frozen = null;
    const queued = pc.queued.splice(0);
    for (const run of queued) run();
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
  };
  // 見張り: steps を順に満たす。各 step は { name, cls, role, part } — 応答の events から、role（self = 主人公の升から出た最初の一撃・
  // foe = 主人公に向かった最初の一撃・ally = 主人公の味方の升から出た最初の一撃）の一撃が何番目かを決め、その一撃の part（bolt = 弾・
  // impact = 着弾・float = 浮く数）が cls の要素として足された所で止める。その一撃が無い（外れて着弾が無いを含む）応答では、残りの
  // step を捨てる。slide の step は { name, slide: <駒の selector> } — その駒の transform の滑りが始まったら止める。
  pc.strikeIndex = (role) => {
    const json = pc.last.json;
    const view = json.view ?? json;
    const events = json.events;
    const self = view.player ?? view.actors.find((a) => a.kind === 'protagonist');
    const at = (tile, actor) => tile.x === actor.x && tile.y === actor.y;
    if (role === 'self') return events.findIndex((e) => at(e.from, self));
    if (role === 'foe') return events.findIndex((e) => at(e.to, self));
    const allies = view.actors.filter((a) => a.team === self.team && a.kind !== 'protagonist' && !a.down);
    return events.findIndex((e) => allies.some((a) => at(e.from, a)));
  };
  pc.nthFor = (step) => {
    const events = pc.last.json.events;
    const k = pc.strikeIndex(step.role);
    if (k < 0) return null;
    if (step.part === 'bolt') return k + 1;
    if (!events[k].hit) return null;
    if (step.part === 'impact') return events.slice(0, k + 1).filter((e) => e.hit).length;
    if (step.cls.endsWith('--hurt')) return 1;
    return k + 1;
  };
  pc.arm = (steps) => {
    const base = new Map(pc.added);
    const armSeq = pc.seq;
    const state = { steps: steps.slice(), fired: [], dropped: null };
    const since = (cls) => (pc.added.get(cls) ?? 0) - (base.get(cls) ?? 0);
    const check = () => {
      const step = state.steps[0];
      if (!step || pc.frozen || !step.cls) return;
      if (step.role && pc.seq === armSeq) return;
      const nth = step.role ? pc.nthFor(step) : step.nth;
      if (nth === null) { state.dropped = step.name; state.steps = []; return; }
      if (since(step.cls) >= nth) { state.steps.shift(); state.fired.push(step.name); pc.freeze(step.name); }
    };
    state.onAdded = () => check();
    const poll = () => {
      if (pc.watch !== state) return;
      const step = state.steps[0];
      if (step && step.slide && !pc.frozen) {
        const node = document.querySelector(step.slide);
        if (node && node.getAnimations().some((a) => a.transitionProperty === 'transform')) { state.steps.shift(); state.fired.push(step.name); pc.freeze(step.name); }
      }
      if (step && step.cls) check();
      realSetTimeout(poll, 4);
    };
    pc.watch = state;
    poll();
    return true;
  };
  pc.disarm = () => { pc.watch = null; };
  pc.seedRandom = (seed) => {
    let s = seed >>> 0;
    Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };
  pc.preload = () => Promise.all(${JSON.stringify(ELEMENTS)}.flatMap((el) => ['bolt', 'impact'].map((k) => {
    const img = new Image();
    img.src = '/canonical/dungeon/effects/' + el + '_' + k + '.png';
    return img.decode();
  })));
  return true;
})()`;

const PAGE_STATE = `(() => ({
  screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
  playMode: document.body.classList.contains('play-mode'),
  arenaStage: document.querySelector('#academy-arena-screen')?.dataset.stage ?? null,
  dungeonScene: document.querySelector('#academy-dungeon-screen')?.dataset.scene ?? null
}))()`;

// 撮った瞬間に盤の上にあった演出の要素（個数と、浮く数の字）。
const FX_STATE = `(() => {
  const count = (s) => document.querySelectorAll(s).length;
  const texts = (s) => [...document.querySelectorAll(s)].map((n) => n.textContent);
  const board = document.querySelector('#arena-match:not([hidden]) .arena-stage')?.getBoundingClientRect();
  return {
    dn: { bolt: count('.dn-bolt'), impact: count('.dn-impact'), float: texts('.dn-float'), hurt: !!document.querySelector('.dn-hurt.is-hurt') },
    an: { bolt: count('.an-bolt'), impact: count('.an-impact'), float: texts('.an-float'), hurt: !!document.querySelector('.an-hurt.is-hurt'), tokens: count('#arena-grid .an-entity'),
      teams: [...document.querySelectorAll('#arena-hud-status .an-hud-team-label')].map((n) => n.textContent),
      board: board && board.width > 0 ? { left: Math.round(board.left), top: Math.round(board.top), right: Math.round(board.right), bottom: Math.round(board.bottom) } : null }
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
      throw new Error(`timed out waiting for ${label} (page: ${JSON.stringify(await js(PAGE_STATE).catch(() => null))})`);
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
      const vk = { ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[key];
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
  const { page, product } = ctx;
  await page.load(`${product.base}/`);
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

async function sendOff(ctx, destinationId, screenId) {
  const { page } = ctx;
  const line = ctx.product.hubLines[destinationId];
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  await page.waitFor(arrived(screenId), `${screenId} arrived`, LM_WAIT_MS);
  ctx.steps.push(`say on the terrace: ${line} → ${screenId}`);
}

async function shoot(ctx, file, note, clip = null) {
  const target = path.join(ctx.options.out, `${file}.png`);
  if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
  // そろえた時刻が合成（transform・opacity の動き）まで届いた frame を撮る: 窓全体を描き直させ、四 frame 待つ（同じ止め所で二度
  // そろえると、前の絵の raster の区画が残ることがある）。
  ctx.page.win.webContents.invalidate();
  await ctx.page.js('new Promise((resolve) => { let n = 0; const tick = () => (++n >= 4 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })');
  const fx = await ctx.page.js(FX_STATE);
  const bytes = await ctx.page.png(clip);
  if (!clip && (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height)) throw new Error(`${file}.png is not 1440x900`);
  await fs.writeFile(target, bytes);
  ctx.shots.push({ file: `${file}.png`, note, fx, turn: ctx.turn, clip: Boolean(clip) });
  console.log(`shot ${file}.png — ${note} fx=${JSON.stringify(fx)}`);
}

// 一手を送り、arm した steps が順に満ちるたびに、その step の poses を撮って動かし直す。返すのは撮った step の名の列。
// step: { name, cls, nth, poses: [{ file, f, note, clip? }] } か { name, slide, poses }。
async function playTurn(ctx, steps, act, { windowMs }) {
  const { page } = ctx;
  const seq = await page.js('window.__pc.seq');
  if (steps.length) await page.js(`window.__pc.arm(${JSON.stringify(steps.map(({ poses, ...rest }) => rest))})`);
  await act();
  ctx.turn += 1;
  const fired = [];
  const end = Date.now() + windowMs;
  while (Date.now() < end && fired.length < steps.length) {
    const frozen = await page.js('window.__pc.frozen');
    if (frozen) {
      const step = steps.find((candidate) => candidate.name === frozen);
      for (const pose of step.poses) {
        const counts = await page.js(`window.__pc.pose(${pose.f})`);
        await shoot(ctx, pose.file, `${pose.note}（そろえた動き ${JSON.stringify(counts)}）`, pose.clip ? await page.js(pose.clip) : null);
      }
      await page.js('window.__pc.resume()');
      fired.push(frozen);
      continue;
    }
    await sleep(10);
  }
  await page.js('window.__pc.disarm()');
  await page.waitFor(`window.__pc.seq > ${seq}`, 'the action response', 10000);
  const events = await page.js('(window.__pc.last.json.events ?? []).map((e) => e.kind + (e.element ? ":" + e.element : "") + (e.hit ? "" : ":miss") + (e.damage !== undefined ? " " + e.damage : "") + (e.crit ? "!" : "") + " " + e.from.x + "," + e.from.y + ">" + e.to.x + "," + e.to.y)');
  ctx.turnLog.push({ turn: ctx.turn, events, fired });
  console.log(`turn ${ctx.turn} events=${JSON.stringify(events)} fired=${JSON.stringify(fired)}`);
  return fired;
}

// ある一撃（role）の四つの瞬間の steps: 弾・着弾・浮く数（同じ止め所で目盛りも）。extra は part ごとに足す pose（切り抜きなど）。
function strikeSteps(prefix, role, { bolt, impact, float }, extra = {}) {
  const pose = (part, moment) => ({ file: `${prefix}-${role}-${moment}`, f: POSE[moment], note: MOMENT_NOTES[moment] });
  return [
    { name: `${role}-bolt`, cls: bolt, role, part: 'bolt', poses: [pose('bolt', 'bolt'), ...(extra.bolt ?? [])] },
    { name: `${role}-impact`, cls: impact, role, part: 'impact', poses: [pose('impact', 'impact'), ...(extra.impact ?? [])] },
    { name: `${role}-float`, cls: float, role, part: 'float', poses: [pose('float', 'float'), pose('float', 'gauge')] }
  ];
}

// ── ダンジョン ───────────────────────────────────────────────────────────────────────────────────────────
const DUNGEON = 'academy-dungeon-screen';

// 次の一手（state を読んで決める・決まった盤なら同じ手になる）: 見えている敵がいて撃てる魔法があれば撃つ。撃てなければ隣の敵へ
// 踏み込む。魔力が足りないと言われた後は待つ。敵がいなければ未踏の縁へ一歩。
const DUNGEON_PLAN = `(async () => {
  const view = await fetch('/api/dungeon/state').then((r) => r.json()).then((s) => s.view ?? s.run ?? s);
  const p = view.player;
  const enemies = view.enemies ?? [];
  const lastErr = window.__pc.last?.json?.view?.action_error ?? window.__pc.last?.json?.action_error ?? null;
  const adjacent = enemies.some((e) => Math.max(Math.abs(e.x - p.x), Math.abs(e.y - p.y)) <= 1);
  const foe = enemies[0]?.element ?? null;
  const cards = [...document.querySelectorAll('#dungeon-spells .dn-card:not(:disabled)')].filter((b) => [...b.classList].some((c) => c.startsWith('dn-el-')));
  const card = cards.find((b) => !b.classList.contains('dn-el-' + foe)) ?? cards[0];
  if (enemies.length && card && !lastErr) return { kind: 'cast', element: [...card.classList].find((c) => c.startsWith('dn-el-')).slice(6), adjacent };
  const bump = [['ArrowUp',0,-1],['ArrowDown',0,1],['ArrowLeft',-1,0],['ArrowRight',1,0]].find(([, dx, dy]) => enemies.some((e) => e.x === p.x + dx && e.y === p.y + dy));
  if (bump && lastErr !== 'insufficient_mp') return { kind: 'move', key: bump[0], adjacent, bump: true };
  if (lastErr === 'insufficient_mp') return { kind: 'wait', adjacent };
  const W = view.width, H = view.height;
  const blocked = new Set(enemies.map((e) => e.x + ',' + e.y));
  const goal = (x, y) => {
    if (enemies.length) return enemies.some((e) => Math.abs(e.x - x) + Math.abs(e.y - y) === 1);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && !view.explored[ny][nx]) return true; }
    return false;
  };
  const dirs = [['ArrowUp',0,-1],['ArrowDown',0,1],['ArrowLeft',-1,0],['ArrowRight',1,0]];
  const seen = new Set([p.x + ',' + p.y]);
  const queue = [[p.x, p.y, null]];
  while (queue.length) {
    const [x, y, first] = queue.shift();
    if (first && goal(x, y)) return { kind: 'move', key: first, adjacent };
    for (const [key, dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy, id = nx + ',' + ny;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(id) || blocked.has(id) || view.tiles[ny][nx] !== 'floor') continue;
      seen.add(id);
      queue.push([nx, ny, first ?? key]);
    }
  }
  return { kind: 'wait', adjacent };
})()`;

const DUNGEON_FREE_STEP = `(async () => {
  const view = await fetch('/api/dungeon/state').then((r) => r.json()).then((s) => s.view ?? s.run ?? s);
  const p = view.player;
  const taken = new Set((view.enemies ?? []).map((e) => e.x + ',' + e.y));
  const step = [['ArrowUp',0,-1],['ArrowDown',0,1],['ArrowLeft',-1,0],['ArrowRight',1,0]]
    .find(([, dx, dy]) => view.tiles[p.y + dy]?.[p.x + dx] === 'floor' && !taken.has((p.x + dx) + ',' + (p.y + dy)));
  if (!step) throw new Error('dungeon: no free tile next to the player');
  return step[0];
})()`;

async function dungeonScene(ctx) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOff(ctx, 'dungeon', DUNGEON);
  await page.waitFor(`${settled(DUNGEON)} && document.querySelector('#${DUNGEON}').dataset.scene === 'entry'`, 'the dungeon entry', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  if (await page.js("document.querySelector('#dungeon-entry-companion-toggle')?.getAttribute('aria-pressed') === 'true'")) {
    await page.click("document.querySelector('#dungeon-entry-companion-toggle')", '相棒の札');
    ctx.steps.push('companion off');
  }
  await page.js(PAGE_TOOLS);
  await page.js('window.__pc.preload()');
  await page.js(`window.__pc.dungeonSeed = ${DUNGEON_SEED}; window.__pc.seedRandom(${PAGE_RANDOM_SEED});`);
  await page.click("document.querySelector('#dungeon-dive')", '潜る');
  await page.waitFor(`${arrived(DUNGEON)} && document.querySelector('#${DUNGEON}').dataset.scene === 'play'`, 'the dungeon play', LM_WAIT_MS);
  await page.waitFor(`${motionSettled(`#${DUNGEON}`)} && ${IMAGES_LOADED(`#${DUNGEON}`)}`, 'the dungeon settled');
  await sleep(SETTLE_MS);
  await page.moveAway();
  ctx.steps.push(`dive with seed ${DUNGEON_SEED}`);
  const pending = new Set(['slide', 'self', 'foe']);
  while (pending.size) {
    if (ctx.turn > TURN_LIMIT) throw new Error(`dungeon: moments still missing after ${TURN_LIMIT} turns: ${[...pending]}`);
    if (await page.js(`document.querySelector('#${DUNGEON}').dataset.scene !== 'play'`)) throw new Error(`dungeon run ended with ${[...pending]} missing`);
    const plan = await page.js(DUNGEON_PLAN);
    let choice = plan;
    // 滑りは最初の手で撮る: 敵のいない床へ一歩（上・下・左・右の順で最初に歩ける升）。
    if (pending.has('slide')) choice = { kind: 'move', key: await page.js(DUNGEON_FREE_STEP), bump: false };
    // 敵の手は、敵が隣にいる間に待って打たれる所を撮る（主人公の手を撮った後）。
    if (!pending.has('self') && pending.has('foe') && plan.adjacent && (plan.kind === 'cast' || plan.bump)) choice = { kind: 'wait' };
    let steps = [];
    if (choice.kind === 'move' && !choice.bump && pending.has('slide')) {
      steps = [{ name: 'slide', slide: '.dn-entity--player', poses: [{ file: 'dungeon-slide', f: POSE.slide, note: MOMENT_NOTES.slide }] }];
    } else if (choice.kind === 'cast' && pending.has('self')) {
      steps = strikeSteps('dungeon', 'self', { bolt: 'dn-bolt', impact: 'dn-impact', float: 'dn-float' });
    } else if (choice.kind === 'wait' && pending.has('foe') && !pending.has('self')) {
      steps = strikeSteps('dungeon', 'foe', { bolt: 'dn-bolt', impact: 'dn-impact', float: 'dn-float--hurt' });
    }
    const before = await page.js("fetch('/api/dungeon/state').then((r) => r.json()).then((s) => s.view ?? s.run ?? s)");
    const shotsBefore = ctx.shots.length;
    let fired = await playTurn(ctx, steps, async () => {
      if (choice.kind === 'cast') await page.click(`document.querySelector('#dungeon-spells .dn-card.dn-el-${choice.element}')`, `cast ${choice.element}`);
      else if (choice.kind === 'move') await page.press(choice.key);
      else await page.press(' ');
      await page.moveAway();
    }, { windowMs: 2200 });
    // ダンジョンは一撃の行き先を「その升の駒がいま描かれている所」から取るので、同じ手で敵が升を移っていると、滑りの途中のどこを
    // 取るかが時刻で揺れる。主人公の手・敵の手は、その一撃に関わる敵がこの手で動かなかった手だけを採り、動いた手の撮影は捨てて
    // 次の手で撮り直す。
    if (fired.some((name) => name.startsWith('self-') || name.startsWith('foe-'))) {
      const still = await page.js(`(() => {
        const before = ${JSON.stringify(before)};
        const json = window.__pc.last.json;
        const role = ${JSON.stringify(fired[0].split('-')[0])};
        const k = window.__pc.strikeIndex(role);
        const tile = role === 'self' ? json.events[k].to : json.events[k].from;
        const was = before.enemies.find((e) => e.x === tile.x && e.y === tile.y);
        const now = (json.enemies ?? []).find((e) => was && e.uid === was.uid);
        return Boolean(was && (!now || (now.x === was.x && now.y === was.y)) && before.player.x === json.player.x && before.player.y === json.player.y);
      })()`);
      if (!still) {
        for (const entry of ctx.shots.splice(shotsBefore)) await fs.rm(path.join(ctx.options.out, entry.file));
        console.log(`turn ${ctx.turn}: discarded ${fired.join(' ')} (the enemy in the strike moved this turn)`);
        fired = [];
      }
    }
    ctx.steps.push(`turn ${ctx.turn}: ${JSON.stringify(choice)}${fired.length ? ` [${fired.join(' ')}]` : ''}`);
    if (fired.includes('slide')) pending.delete('slide');
    if (fired.includes('self-float')) pending.delete('self');
    if (fired.includes('foe-float')) pending.delete('foe');
    await sleep(600);
  }
}

// ── 闘技会 ───────────────────────────────────────────────────────────────────────────────────────────────
const ARENA = 'academy-arena-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const ARENA_DONE = `(${ARENA_STAGE('bracket')} || ${ARENA_STAGE('result')})`;
const ARENA_INPUT_READY = `(${ARENA_DONE} || (${ARENA_STAGE('match')} && !document.querySelector('#arena-dock-main').hidden))`;

async function enterArena(ctx, mode) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOff(ctx, 'arena', ARENA);
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection');
  await sleep(SETTLE_MS);
  await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="${mode}"]')`, `${mode} の立ち位置`);
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('bracket')}`, 'the bracket');
  await sleep(SETTLE_MS);
  await page.js(PAGE_TOOLS);
  await page.js('window.__pc.preload()');
  ctx.steps.push(`stand on ${mode} → bracket`);
}

async function startArenaMatch(ctx) {
  const { page } = ctx;
  await page.waitFor("document.querySelector('#arena-bracket-actions .arena-fight')", 'the fight sigil');
  const started = Date.now();
  await page.click("document.querySelector('#arena-bracket-actions .arena-fight')", '試合開始');
  await page.waitFor(`${ARENA_STAGE('match')} && document.querySelector('#arena-grid .an-entity')`, 'the match board', LM_WAIT_MS);
  return started;
}

const ARENA_VIEW = 'window.__pc.last?.json?.view ?? null';
// いまの盤（最後の応答の view か、まだ応答が無ければ試合の始まりの state）。
const ARENA_CURRENT = `(async () => (${ARENA_VIEW}) ?? (await fetch('/api/arena/state').then((r) => r.json())).current_match)()`;

async function arenaCast(ctx, element) {
  await ctx.page.click(`document.querySelector('#arena-spells .arena-spell.an-el-${element}')`, `cast ${element}`);
}

async function arenaCastFirstOrWait(ctx) {
  const { page } = ctx;
  const lastErrored = await page.js(`!!(${ARENA_VIEW})?.action_error`);
  const spell = await page.js("(() => { const b = document.querySelector('#arena-spells .arena-spell:not(.arena-spell-heal):not(:disabled)'); return b ? b.getAttribute('aria-label') : null; })()");
  if (spell && !lastErrored) {
    await page.click("document.querySelector('#arena-spells .arena-spell:not(.arena-spell-heal):not(:disabled)')", spell);
    return `cast ${spell}`;
  }
  await page.press(' ');
  return 'wait';
}

// 切り抜き: 最後に足された selector の要素の中心から、升 2.4 個分の正方形。
const CLIP_AROUND = (selector) => `(() => {
  const node = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1);
  const cell = parseFloat(getComputedStyle(document.querySelector('#arena-grid')).getPropertyValue('--an-cell'));
  const r = node.getBoundingClientRect();
  const size = Math.round(cell * 2.4);
  return { x: Math.round(r.left + r.width / 2 - size / 2), y: Math.round(r.top + r.height / 2 - size / 2), width: size, height: size };
})()`;

const elementCrops = (element) => ({
  bolt: [{ file: `arena-el-${element}-bolt`, f: POSE.bolt, note: `${ELEMENT_LABELS[element]}の弾（切り抜き）`, clip: CLIP_AROUND('.an-bolt') }],
  impact: [{ file: `arena-el-${element}-impact`, f: POSE.impact, note: `${ELEMENT_LABELS[element]}の着弾（切り抜き）`, clip: CLIP_AROUND('.an-impact') }]
});

// 一人の第一試合: 間合いが空いている間に一歩寄って滑りを撮り、6 属性を一つずつ撃つ（撃った手で主人公の一撃の弾と着弾を切り抜き、
// 最初の手では主人公の手の四つを撮る）。主人公の手を撮った後は、手ごとに相手の手の四つを見張る。撃てない属性の番は待機。
async function arenaSoloScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo');
  await startArenaMatch(ctx);
  await page.waitFor(`document.querySelector('#arena-match-intro')?.dataset.state === 'ready' && ${motionSettled(`#${ARENA}`)} && ${IMAGES_LOADED(`#${ARENA}`)}`, 'the match settled', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.moveAway();
  const pending = new Set(['slide', 'self', 'foe', ...ELEMENTS.map((el) => `el-${el}`)]);
  while (true) {
    if (ctx.turn > TURN_LIMIT) throw new Error('arena did not conclude');
    const current = await page.js(ARENA_CURRENT);
    const player = current.actors.find((actor) => actor.actor_id === current.player_actor_id);
    const foe = current.actors.find((actor) => actor.team !== player.team && !actor.down);
    const lastError = (await page.js(ARENA_VIEW))?.action_error ?? null;
    const nextElement = ELEMENTS.find((el) => pending.has(`el-${el}`)) ?? null;
    const castable = nextElement ? await page.js(`!!document.querySelector('#arena-spells .arena-spell.an-el-${nextElement}:not(:disabled)')`) : false;
    let label;
    let act;
    let steps = [];
    if (pending.has('slide') && Math.abs(player.x - foe.x) + Math.abs(player.y - foe.y) > 3) {
      label = 'move left';
      act = () => page.press('ArrowLeft');
      steps = [{ name: 'slide', slide: '.an-entity--self', poses: [{ file: 'arena-slide', f: POSE.slide, note: MOMENT_NOTES.slide }] }];
    } else if (nextElement && castable && lastError !== 'insufficient_mp') {
      label = `cast ${nextElement}`;
      act = () => arenaCast(ctx, nextElement);
      const crops = elementCrops(nextElement);
      steps = pending.has('self')
        ? strikeSteps('arena', 'self', { bolt: 'an-bolt', impact: 'an-impact', float: 'an-float' }, crops)
        : [{ name: 'el-bolt', cls: 'an-bolt', role: 'self', part: 'bolt', poses: crops.bolt }, { name: 'el-impact', cls: 'an-impact', role: 'self', part: 'impact', poses: crops.impact }];
    } else {
      label = 'first-or-wait';
      act = async () => { label = await arenaCastFirstOrWait(ctx); };
    }
    // 相手の一撃は主人公の一撃の後に流れるので、属性の切り抜きと同じ手で続けて見張る（切り抜きの手だけで試合が終わっても撮れる）。
    if (pending.has('foe') && !pending.has('self') && !steps.some((step) => step.role === 'foe')) steps = [...steps, ...strikeSteps('arena', 'foe', { bolt: 'an-bolt', impact: 'an-impact', float: 'an-float--hurt' })];
    const fired = await playTurn(ctx, steps, async () => { await act(); await page.moveAway(); }, { windowMs: 2400 });
    ctx.steps.push(`turn ${ctx.turn}: ${label}${fired.length ? ` [${fired.join(' ')}]` : ''}`);
    if (fired.includes('slide')) pending.delete('slide');
    if (fired.includes('self-float')) pending.delete('self');
    if (fired.includes('foe-float')) pending.delete('foe');
    if (nextElement && (fired.includes('self-impact') || fired.includes('el-impact'))) pending.delete(`el-${nextElement}`);
    const view = await page.js(ARENA_VIEW);
    if (!view.active) {
      const protagonist = view.actors.find((actor) => actor.kind === 'protagonist');
      ctx.notes.solo = { status: view.status, winner: view.winner, protagonist_down: protagonist.down, missing: [...pending] };
      console.log(`SOLO ${JSON.stringify(ctx.notes.solo)}`);
      break;
    }
    if (!pending.size) { ctx.notes.solo = { stopped_after_all_moments: ctx.turn, missing: [] }; break; }
    await page.waitFor(ARENA_INPUT_READY, 'the next input', 10000);
    await sleep(400);
  }
}

// 主人公が倒れる手（一人・第一試合を「撃てる魔法の先頭→待機」で送ると、主人公が負ける）: 最後の応答の、最後に足された浮く数で止めて
// 撮り、動かし直して 1 秒後（表へ戻る前）にもう一枚。
async function arenaDownScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo');
  await startArenaMatch(ctx);
  await page.waitFor(`document.querySelector('#arena-match-intro')?.dataset.state === 'ready'`, 'the intro', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  while (!(await page.js(ARENA_DONE))) {
    if (ctx.turn > TURN_LIMIT) throw new Error('arena did not conclude');
    await page.waitFor(ARENA_INPUT_READY, 'the next input', 10000);
    if (await page.js(ARENA_DONE)) break;
    const seq = await page.js('window.__pc.seq');
    // 決着の手かどうかは応答まで分からないので、毎手「主人公への浮く数」で止める見張りを掛け、決着の手でだけ撮る。
    await page.js(`window.__pc.arm(${JSON.stringify([{ name: 'down', cls: 'an-float--hurt', role: 'foe', part: 'float' }])})`);
    const label = await arenaCastFirstOrWait(ctx);
    await page.moveAway();
    ctx.turn += 1;
    await page.waitFor(`window.__pc.seq > ${seq}`, 'the action response', 10000);
    const view = await page.js(ARENA_VIEW);
    const protagonist = view.actors.find((actor) => actor.kind === 'protagonist');
    ctx.steps.push(`turn ${ctx.turn}: ${label}`);
    if (view.active || !protagonist.down) {
      await page.js('window.__pc.disarm(); if (window.__pc.frozen) window.__pc.resume();');
      await sleep(700);
      continue;
    }
    const respondedAt = Date.now();
    await page.waitFor('window.__pc.frozen', 'the blow on the protagonist', 3000);
    const counts = await page.js(`window.__pc.pose(${POSE.float})`);
    await shoot(ctx, 'arena-player-down', `主人公が倒れた手（主人公に浮く数が出た所で止め、0.3 へ。そろえた動き ${JSON.stringify(counts)}）`);
    await page.js('window.__pc.disarm(); window.__pc.resume();');
    await sleep(Math.max(0, 1000 - (Date.now() - respondedAt)));
    await shoot(ctx, 'arena-player-down-later', '主人公が倒れた手の応答から約 1 秒（表へ戻る前・動かしたまま）');
    ctx.notes.down = { status: view.status, winner: view.winner, protagonist_team: protagonist.team };
    break;
  }
  await page.waitFor(`${settled(ARENA)} && ${ARENA_DONE}`, 'back on the bracket', LM_WAIT_MS);
}

// 二人の第一試合を最後まで（撃てる魔法の先頭→待機）。味方の一撃のある最初の手で、その弾の一瞬を撮る。
async function arenaPairScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'pair');
  await startArenaMatch(ctx);
  await page.waitFor(`document.querySelector('#arena-match-intro')?.dataset.state === 'ready'`, 'the intro', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  let allyStrikes = 0;
  while (!(await page.js(ARENA_DONE))) {
    if (ctx.turn > TURN_LIMIT) throw new Error('arena did not conclude');
    await page.waitFor(ARENA_INPUT_READY, 'the next input', 10000);
    if (await page.js(ARENA_DONE)) break;
    const shot = ctx.shots.some((entry) => entry.file === 'arena-pair-ally-bolt.png');
    // 主人公は風を撃てないので、風の弾と着弾の切り抜きは風の味方の一撃から撮る。
    const current = await page.js(ARENA_CURRENT);
    const self = current.actors.find((actor) => actor.kind === 'protagonist');
    const windAlly = current.actors.some((actor) => actor.team === self.team && actor.kind !== 'protagonist' && !actor.down && actor.element === 'wind');
    const crops = windAlly && !ctx.shots.some((entry) => entry.file === 'arena-el-wind-impact.png') ? elementCrops('wind') : { bolt: [], impact: [] };
    const steps = [];
    if (!shot || crops.bolt.length) steps.push({ name: 'ally-bolt', cls: 'an-bolt', role: 'ally', part: 'bolt', poses: [...(shot ? [] : [{ file: 'arena-pair-ally-bolt', f: POSE.bolt, note: '二人の試合の味方の一撃の弾（味方の弾が出た所で止め、0.5 へ）' }]), ...crops.bolt] });
    if (crops.impact.length) steps.push({ name: 'ally-impact', cls: 'an-impact', role: 'ally', part: 'impact', poses: crops.impact });
    let label = '';
    await playTurn(ctx, steps, async () => { label = await arenaCastFirstOrWait(ctx); await page.moveAway(); }, { windowMs: 1600 });
    const strikes = await page.js("window.__pc.strikeIndex('ally') >= 0");
    if (strikes) allyStrikes += 1;
    ctx.steps.push(`turn ${ctx.turn}: ${label}${strikes ? ' (ally strikes)' : ''}`);
    // 決着の応答の後も、表へ移るまでは呪文の欄が見えている。そこで送ると要求が出ず応答を待ち切れないので、決着の応答で止める。
    if (!(await page.js(ARENA_VIEW)).active) break;
    await sleep(500);
  }
  const final = await page.js(ARENA_VIEW);
  ctx.notes.pair = { status: final.status, winner: final.winner, actions: ctx.turn, turns_with_ally_strike: allyStrikes, actors: final.actors.map((actor) => `${actor.name}(${actor.team}${actor.down ? ' down' : ''})`) };
  console.log(`PAIR ${JSON.stringify(ctx.notes.pair)}`);
}

// 見返し: 表は主人公が戦った回戦までしか結果と見返しの目を出さないので、能力値を上限にした主人公で一回戦を（撃てる魔法の先頭→待機で）
// 勝って戻り、明かしが済んで試合を始める紋が出た表で、一回戦の自動の組の見返しを全部読み（会心の有無も書く）、一撃のある最初の見返しを
// 再生して最初の弾を撮る。
async function arenaReplayScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo');
  await startArenaMatch(ctx);
  await page.waitFor(`document.querySelector('#arena-match-intro')?.dataset.state === 'ready'`, 'the intro', LM_WAIT_MS);
  while (!(await page.js(ARENA_DONE))) {
    if (ctx.turn > TURN_LIMIT) throw new Error('arena did not conclude');
    await page.waitFor(ARENA_INPUT_READY, 'the next input', 10000);
    if (await page.js(ARENA_DONE)) break;
    const seq = await page.js('window.__pc.seq');
    const label = await arenaCastFirstOrWait(ctx);
    ctx.turn += 1;
    ctx.steps.push(`turn ${ctx.turn}: ${label}`);
    await page.waitFor(`window.__pc.seq > ${seq}`, 'the action response', 10000);
    if (!(await page.js(ARENA_VIEW)).active) break;
    await sleep(700);
  }
  const opener = await page.js(ARENA_VIEW);
  const protagonist = opener.actors.find((actor) => actor.kind === 'protagonist');
  if (opener.winner !== protagonist.team) throw new Error(`the replay scene needs the first match won (strong protagonist), got winner ${opener.winner}`);
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('bracket')} && document.querySelector('#arena-bracket-actions .arena-fight')`, 'the bracket revealed after the first match', 15000);
  await sleep(SETTLE_MS);
  await page.moveAway();
  ctx.steps.push('won the first match → bracket');
  const survey = await page.js(`(async () => {
    const state = await fetch('/api/arena/state').then((r) => r.json());
    const ids = state.bracket.rounds[0].filter((m) => m.resolved && m.is_auto).map((m) => m.match_id);
    const found = [];
    for (const id of ids) {
      const replay = await fetch('/api/arena/match/' + encodeURIComponent(id) + '/replay').then((r) => r.json());
      const turn = replay.turns.findIndex((t) => t.events.some((e) => e.crit));
      found.push({ id, turns: replay.turns.length, critTurn: turn, strikes: replay.turns.reduce((n, t) => n + t.events.length, 0) });
    }
    return found;
  })()`);
  console.log(`REPLAYS ${JSON.stringify(survey)}`);
  const pick = survey.find((entry) => entry.strikes > 0);
  if (!pick) throw new Error('no watchable replay carries a strike');
  ctx.notes.replay = { survey, pick };
  // 見返しの目は円の表の節に置かれ、組を data-match-id で持つ。
  const watchable = await page.js("JSON.stringify([...document.querySelectorAll('#arena-bracket-ring .arena-ring-eye:not(.arena-ring-eye--entry)')].map((eye) => eye.dataset.matchId).sort())");
  const expected = JSON.stringify(survey.map((entry) => entry.id).sort());
  if (watchable !== expected) throw new Error(`watch eyes ${watchable} != watchable matches ${expected}`);
  await page.js(`window.__pc.arm(${JSON.stringify([{ name: 'replay-bolt', cls: 'an-bolt', nth: 1 }])})`);
  await page.click(`document.querySelector('#arena-bracket-ring .arena-ring-eye[data-match-id=${JSON.stringify(pick.id)}]')`, '観戦');
  await page.waitFor('window.__pc.frozen', 'the first replay bolt', 15000);
  let counts = await page.js(`window.__pc.pose(${POSE.bolt})`);
  await shoot(ctx, 'arena-replay-bolt', `試合の見返しの最初の弾（弾が出た所で止め、0.5 へ。そろえた動き ${JSON.stringify(counts)}）`);
  await page.js('window.__pc.disarm(); window.__pc.resume();');
}

// 会心: 会心は近接の一撃にだけ出る（魔法には出ない）が、撮影の盤では主人公が相手へ寄りきる前に倒れ、観戦の見返しにも会心が無い。
// そこで一人の第一試合の主人公の最初の一撃の応答を、ページの中で crit: true にして app に渡し（数も他の event も server のまま）、
// 会心の数が出た所で止めて撮る。描く経路は本物の応答と同じ（arenaDo → validateArenaEvents → playCombatStrikes）。
async function arenaCritScene(ctx) {
  const { page } = ctx;
  await enterArena(ctx, 'solo');
  await startArenaMatch(ctx);
  await page.waitFor(`document.querySelector('#arena-match-intro')?.dataset.state === 'ready' && ${motionSettled(`#${ARENA}`)} && ${IMAGES_LOADED(`#${ARENA}`)}`, 'the match settled', LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.moveAway();
  await page.js('window.__pc.critNext = true');
  const steps = [{ name: 'crit', cls: 'an-float--crit', nth: 1, poses: [{ file: 'arena-crit', f: POSE.float, note: '会心の数（主人公の最初の一撃の応答を道具が crit: true にした・浮く数が出た所で止め、0.3 へ）' }] }];
  let label = '';
  const fired = await playTurn(ctx, steps, async () => { label = await arenaCastFirstOrWait(ctx); await page.moveAway(); }, { windowMs: 2400 });
  ctx.steps.push(`turn ${ctx.turn}: ${label}${fired.length ? ' [crit]' : ''}`);
  if (!fired.includes('crit')) throw new Error('the forced crit float was not drawn');
  ctx.notes.crit = { turn: ctx.turn, forced: await page.js('window.__pc.critForced') };
  console.log(`CRIT ${JSON.stringify(ctx.notes.crit)}`);
}

// 能力値を上限にした主人公で起こす scene。
const STRONG_SCENES = new Set(['arena-replay']);

const SCENES = {
  dungeon: dungeonScene,
  'arena-solo': arenaSoloScene,
  'arena-down': arenaDownScene,
  'arena-pair': arenaPairScene,
  'arena-replay': arenaReplayScene,
  'arena-crit': arenaCritScene
};

async function runScene(options, name) {
  const product = await startProduct(options.repoRoot, { strong: STRONG_SCENES.has(name) });
  const guard = () => { if (product.lmFailures.length) throw new Error(`fixture LM 500: ${product.lmFailures.join(' | ')}`); };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], shots: [], notes: {}, turn: 0, turnLog: [] };
  const started = Date.now();
  try {
    await SCENES[name](ctx);
    guard();
    if (page.pageErrors.length) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
    return { scene: name, seconds: (Date.now() - started) / 1000, notes: ctx.notes, steps: ctx.steps, turnLog: ctx.turnLog, shots: ctx.shots, pageErrors: page.pageErrors };
  } catch (error) {
    console.log(`scene ${name} stopped after: ${ctx.steps.at(-1) ?? 'nothing'}: ${error.message}`);
    throw error;
  } finally {
    page.close();
    await product.stop();
  }
}

// ── 並べた一枚と画素差 ───────────────────────────────────────────────────────────────────────────────────
const COMPARE_MOMENTS = ['self-bolt', 'self-impact', 'self-float', 'self-gauge', 'foe-bolt', 'foe-impact', 'foe-float', 'foe-gauge', 'slide'];

async function exists(file) { return fs.stat(file).then(() => true, () => false); }

async function renderSheet(out, name, html, size) {
  const htmlFile = path.join(out, 'html', `${name}.html`);
  await fs.mkdir(path.dirname(htmlFile), { recursive: true });
  await fs.writeFile(htmlFile, html, 'utf8');
  const page = await openPage(() => {}, size);
  try {
    await page.win.loadFile(htmlFile);
    await page.js('Promise.all([...document.images].map((img) => img.decode()))');
    const bytes = await page.png();
    await fs.writeFile(path.join(out, `${name}.png`), bytes);
    console.log(`wrote ${name}.png ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
  } finally {
    page.close();
  }
}

const SHEET_STYLE = 'body{margin:0;background:#111;color:#eee;font:16px "Hiragino Kaku Gothic ProN",sans-serif} .row{display:flex;gap:24px;padding:12px} figure{margin:0} figcaption{padding:4px 0 8px}';

async function composeSheets(out) {
  for (const moment of COMPARE_MOMENTS) {
    const arena = path.join(out, `arena-${moment}.png`);
    const dungeon = path.join(out, `dungeon-${moment}.png`);
    if (!(await exists(arena)) || !(await exists(dungeon))) { console.log(`compare-${moment}: skipped (missing ${!(await exists(arena)) ? 'arena' : 'dungeon'} shot)`); continue; }
    const html = `<!doctype html><meta charset="utf-8"><style>${SHEET_STYLE}</style><div class="row">
      <figure><figcaption>闘技会 — arena-${moment}.png</figcaption><img src="${arena}"></figure>
      <figure><figcaption>ダンジョン — dungeon-${moment}.png</figcaption><img src="${dungeon}"></figure></div>`;
    await renderSheet(out, `compare-${moment}`, html, { width: 1440 * 2 + 24 * 3, height: 900 + 24 + 34 });
  }
  const cells = [];
  for (const el of ELEMENTS) {
    const bolt = path.join(out, `arena-el-${el}-bolt.png`);
    const impact = path.join(out, `arena-el-${el}-impact.png`);
    cells.push({ el, bolt: (await exists(bolt)) ? bolt : null, impact: (await exists(impact)) ? impact : null });
  }
  if (cells.some((cell) => cell.bolt || cell.impact)) {
    const column = (cell) => `<figure><figcaption>${ELEMENT_LABELS[cell.el]}（${cell.el}）</figcaption>
      ${cell.bolt ? `<img src="${cell.bolt}">` : '<p>弾 なし</p>'}<br>${cell.impact ? `<img src="${cell.impact}">` : '<p>着弾 なし</p>'}</figure>`;
    const html = `<!doctype html><meta charset="utf-8"><style>${SHEET_STYLE} img{display:block;margin-bottom:8px}</style>
      <p style="padding:12px 12px 0">闘技会の盤の上の 6 属性: 上 = 弾が飛ぶ（0.5）・下 = 着弾（0.35）。各こまは弾／着弾の中心から升 2.4 個分の正方形の等倍の切り抜き。</p>
      <div class="row">${cells.map(column).join('')}</div>`;
    await renderSheet(out, 'arena-elements', html, { width: 1300, height: 560 });
  }
}

const EDGE_BAND_PX = 8;
const BOARD_BAND_PX = 8;

function meanRgb(bitmap, width, x0, y0, x1, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      b += bitmap[i]; g += bitmap[i + 1]; r += bitmap[i + 2]; n += 1;
    }
  }
  if (n === 0) throw new Error(`empty band ${x0},${y0}-${x1},${y1}`);
  return [r / n, g / n, b / n].map((v) => Math.round(v * 10) / 10);
}

const rgbDelta = (a, b) => a.map((v, i) => Math.round((v - b[i]) * 10) / 10);

async function measureEdges(out, shots) {
  const results = [];
  for (const shot of shots) {
    if (shot.clip) continue;
    const image = nativeImage.createFromPath(path.join(out, shot.file));
    const { width, height } = image.getSize();
    if (width !== VIEWPORT.width || height !== VIEWPORT.height) throw new Error(`${shot.file} is ${width}x${height}, not a full frame`);
    const bitmap = image.toBitmap(); // BGRA
    const e = EDGE_BAND_PX;
    const edges = {
      top: meanRgb(bitmap, width, 0, 0, width, e),
      bottom: meanRgb(bitmap, width, 0, height - e, width, height),
      left: meanRgb(bitmap, width, 0, e, e, height - e),
      right: meanRgb(bitmap, width, width - e, e, width, height - e)
    };
    const perimeter = 2 * width * e + 2 * (height - 2 * e) * e;
    const all = [0, 1, 2].map((c) => Math.round(((edges.top[c] + edges.bottom[c]) * width * e + (edges.left[c] + edges.right[c]) * (height - 2 * e) * e) / perimeter * 10) / 10);
    const result = { file: shot.file, band: e, hurt: shot.fx.dn.hurt || shot.fx.an.hurt, edges, all };
    console.log(`EDGE ${JSON.stringify(result)}`);
    const board = shot.fx.an.board;
    if (board) {
      const k = BOARD_BAND_PX;
      const topIn = meanRgb(bitmap, width, board.left, board.top, board.right, board.top + k);
      const topOut = meanRgb(bitmap, width, board.left, board.top - k, board.right, board.top);
      const rightIn = meanRgb(bitmap, width, board.right - k, board.top, board.right, board.bottom);
      const rightOut = meanRgb(bitmap, width, board.right, board.top, board.right + k, board.bottom);
      result.boardEdge = { board, band: k, top: { inside: topIn, outside: topOut, delta: rgbDelta(topIn, topOut) }, right: { inside: rightIn, outside: rightOut, delta: rgbDelta(rightIn, rightOut) } };
      console.log(`BOARD-EDGE ${JSON.stringify({ file: shot.file, ...result.boardEdge })}`);
    }
    results.push(result);
  }
  return results;
}

async function diffAgainst(out, other) {
  const names = (await fs.readdir(out)).filter((name) => /^dungeon-.*\.png$/.test(name)).sort();
  const results = [];
  for (const name of names) {
    const theirs = path.join(other, name);
    if (!(await exists(theirs))) { results.push({ name, missing: true }); continue; }
    const a = nativeImage.createFromPath(path.join(out, name));
    const b = nativeImage.createFromPath(theirs);
    const sa = a.getSize();
    const sb = b.getSize();
    if (sa.width !== sb.width || sa.height !== sb.height) { results.push({ name, size: [sa, sb] }); continue; }
    const pa = a.toBitmap();
    const pb = b.toBitmap();
    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const delta = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3]));
      if (delta > 0) { differing += 1; if (delta > maxDelta) maxDelta = delta; }
    }
    results.push({ name, pixels: sa.width * sa.height, differing, maxDelta });
  }
  for (const result of results) console.log(`DIFF ${JSON.stringify(result)}`);
  return results;
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
  await composeSheets(options.out);
  const edges = await measureEdges(options.out, scenes.flatMap((scene) => scene.shots));
  const diffs = options.diffAgainst ? await diffAgainst(options.out, options.diffAgainst) : null;
  const manifest = { viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, failed, edges, diffs };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${manifest.seconds.toFixed(1)} s (scenes ${options.scenes.join(',')}; failed: ${failed.join(',') || '-'})`);
  if (failed.length) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
main().then(() => app.exit(0)).catch((error) => { console.error('FAILED', error.message); app.exit(1); });
