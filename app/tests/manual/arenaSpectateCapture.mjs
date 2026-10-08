// 闘技会の観戦（バディーを主人公に見立てる形）の確かめの、撮影と大会一回の実測の手回しの道具（*.test.mjs ではないので npm test は
// 拾わない）:
//
//   <electron> app/tests/manual/arenaSpectateCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品を、OS の一時ディレクトリに作った
// 新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こし、バディー（character_001）を置いて露台からの本物の
// 送り出しで入る。LM は固定応答（知らない要求は 500 にして撮影ごと止める）。--out は空でなければ止まる。
//
// バディーの強さ: 一時のプレイに写した content/characters の character_001 の profile.json（作品は characterContentRoot から読む）
// の能力値を全部 上限（max）か 0（min）にする。そのまま（default）なら、こま割りの撮影と同じ大会（バディーは一回戦に勝ち、準々決勝で負ける）。
//
// 瞬間の撮り方: 観戦の入りで表が出た時刻か、表へ戻る紋・見ずに先へ進む紋を押した時刻を 0 とし（こま割りの時刻と同じ取り方）、決めた時刻で
// ページの中の動きを全部止め、止めている間に来る setTimeout も後へ回して撮る（撮り終えたら動かし直す）。
// 撮影はどれも 1440×900 と 1100×720 の二つの窓で撮る（止めたまま窓を替え、円の表が新しい窓で置き直されてから撮る。file 名の末尾が
// 窓の寸法）。表が出ている一枚ごとに、名の札の字が欠けていないこと（字の行ごとに scrollWidth ≤ clientWidth）と、字が名簿の
// display_name（content/characters の profile.json）と一致することを照らして RINGNAMES 行に出し、外れれば止まる。輪とまだの線の
// 計算済みの色・太さ・濃さも同じ行に出す。
// 表を撮るたびに、表に見えているもの（回戦ごとの灯った節・灯った線・見返しの目・金の輪の目）を、道具が数えた明かした回戦の数と
// server の表に照らし、まだ明かしていない回戦に灯った節・線・目が出ていれば止まる。
//
// scenes:
//   boards     バディーそのまま。選ぶ段・観戦の入り（0・0.3・0.7・1 秒）・一回戦の見返し（三手目・バディーが左）と終わり（スキップ）・
//              表へ戻ったときの明かし（0.3・0.7・1.1・1.5 秒と終わり）・準々決勝の前で見ずに先へ進む紋を押した後（0・0.4・1.2・1.9・
//              2.3 秒）・結果の段（こま割り 3 枚の同じ瞬間）
//   champion   バディーを上限に。どの回戦も見返しをスキップで終わりまで送って戻り、優勝まで。準々決勝の見返し（バディーが左に立つ姿）・
//              決勝の後の優勝の灯り（0.2 秒）と表が沈む途中（0.55 秒）・結果の段
//   eliminated バディーを 0 に。一回戦の見返しをスキップで送って戻り、負けた回戦からの見届け（0.25・1.0・2.0・2.7・3.3・3.6 秒）・
//              結果の段
//   timing-champion    champion と同じ大会を凍らせずに送り、観戦を押してから結果の段までを測る
//   timing-eliminated  eliminated と同じ大会を同じく測る
//   timing-skip        バディーそのままの大会を、見ずに先へ進む紋だけで最後まで送って同じく測る
//   reload     バディーそのまま。見返しを終えて表へ戻り、明かしの途中（0.3 秒）で読み直し、出た所（露台）と、露台から闘技会へ
//              送り出し直した姿を記録して撮る（明かしの途中は画面だけが持つので残らない）
//   capped     バディーの出ない試合のうち三百の回りで打ち切られた試合（見返しの最後の手が active）を回戦の早い順に一つ選び、その回戦まで
//              表を明かして（一回戦ならバディーの一回戦の見返しから戻る・その先なら見ずに先へ進む紋で結果の段まで）、見返しを高速の
//              自動送りで最後まで送った終わりと、スキップで送った終わりを撮る
//   decided    同じく、バディーの出ない倒れて決まった試合を一つ選んで、同じ二つの終わりを撮る
//              （capped・decided の終わりは、勝った側〈表の winner_unit_id〉の灯・印・大きく開く輪を照らし、外れれば止まる）
//   buddy-ends       バディーそのまま。一回戦のバディーの試合の見返しを、金の輪の目から高速の自動送りで最後まで送った終わりと、表へ
//                    戻って同じ枠の目からスキップで送った終わりを撮り、バディーの側から読んだ灯・印・大きく開く輪を照らす
//   buddy-ends-min   バディーを 0 に。同じく撮る（バディーが負ける試合）
//
// 送り方: 表で目か紋が出たらすぐ押し、見返しは出たらすぐスキップを押して終わりまで送る（人の考える時間は入れない）。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const WINDOWS = [VIEWPORT, { width: 1100, height: 720 }];
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const HOST = '127.0.0.1';
const BUDDY_ID = 'character_001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCENE_POWER = {
  boards: 'default', champion: 'max', eliminated: 'min',
  'timing-champion': 'max', 'timing-eliminated': 'min', 'timing-skip': 'default', reload: 'default', capped: 'default', decided: 'default',
  'buddy-ends': 'default', 'buddy-ends-min': 'min'
};

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
  for (const scene of scenes) if (!(scene in SCENE_POWER)) throw new Error(`unknown scene ${scene}`);
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
const ARENA_INTRO_LINE = '夜の闘技場に篝火が揺れ、魔法陣の上で二つの影が向かい合う。';

function arenaResultLine(prompt) {
  const champion = prompt.match(/- この大会の優勝者は (.+)/);
  const buddyLost = prompt.match(/- 主人公の相棒 (.+?) は(.+?)で (.+?) に敗れて姿を消した/);
  if (buddyLost && champion) return `${buddyLost[2]}で${buddyLost[3]}に阻まれた相棒${buddyLost[1]}の名を惜しむ声のなか、星を掲げたのは${champion[1].trim()}だった。`;
  const buddyWon = prompt.match(/- (.+?) は決勝を制して優勝した/);
  if (buddyWon) return `決勝を制した相棒${buddyWon[1]}の名が、篝火に照らされた円形の場に高く告げられた。`;
  throw new Error(`fixture lm: arena result prompt without a known spectate outcome block: ${prompt.slice(-400)}`);
}

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
    if (prompt.includes(ARENA_INTRO_MARKER)) return { kind: 'arena-intro', content: ARENA_INTRO_LINE };
    if (prompt.includes(ARENA_RESULT_MARKER)) return { kind: 'arena-result', content: arenaResultLine(prompt) };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) if (prompt.includes(marker)) return { kind: marker, content };
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat', content: '（顔を上げて）ええ、行ってらっしゃい。' };
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
// 能力値の形はそのまま、値（{ value } の value）だけを差し替える。
function setParameterValues(node, value) {
  if (node && typeof node === 'object') {
    if ('value' in node && typeof node.value === 'number') return { ...node, value };
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, setParameterValues(v, value)]));
  }
  return node;
}

async function startProduct(repoRoot, { power }) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const { setRelationshipDebugState } = await product('relationshipState.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((d) => [d.id, `今週は${d.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-spectate-capture-'));
  const closers = [];
  const lmFailures = [];
  const lmKinds = [];
  try {
    await fs.cp(path.join(repoRoot, 'data/definitions'), path.join(root, 'data/definitions'), { recursive: true });
    await fs.cp(path.join(repoRoot, 'data/seeds'), path.join(root, 'data/seeds'), { recursive: true });
    await fs.cp(path.join(root, 'data/seeds/game_data'), path.join(root, 'data/mutable/game_data'), { recursive: true });
    // profile.json は characterContentRoot から読まれる。バディーの強さを変える場面は、写しの上で能力値を書き換える（リポは触らない）。
    const characterContentRoot = power === 'default' ? path.join(repoRoot, 'content/characters') : path.join(root, 'content/characters');
    if (power !== 'default') {
      await fs.cp(path.join(repoRoot, 'content/characters'), characterContentRoot, { recursive: true });
      const profilePath = path.join(characterContentRoot, BUDDY_ID, 'profile.json');
      const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
      await fs.writeFile(profilePath, `${JSON.stringify({ ...profile, parameters: setParameterValues(profile.parameters, power === 'max' ? 100 : 0) }, null, 2)}\n`, 'utf8');
    }
    await writeJson(root, runtimePathsManifestFilename, {
      configRoot: path.join(root, 'app/config'),
      definitionsRoot: path.join(root, 'data/definitions/game_data'),
      seedsRoot: path.join(root, 'data/seeds/game_data'),
      mutableRoot: path.join(root, 'data/mutable/game_data'),
      characterContentRoot,
      creatureContentRoot: path.join(repoRoot, 'content/creatures'),
      canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
      publicRoot: path.join(repoRoot, 'app/public'),
      resourceRoot: root
    });
    const playArea = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    await setRelationshipDebugState({ root: playArea.root, buddyCharacterId: BUDDY_ID });
    const state = JSON.parse(await fs.readFile(path.join(playArea.root, 'game_data/runtime_state.json'), 'utf8'));
    if (state.current_buddy_character_id !== BUDDY_ID) throw new Error(`buddy was not set: ${state.current_buddy_character_id}`);
    console.log(`BUDDY_SET current_buddy_character_id=${state.current_buddy_character_id} power=${power}`);
    const answer = createFixtureLm(hubLines);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let reply;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        reply = await answer(body);
        lmKinds.push(reply.kind);
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
      base: `http://${HOST}:${port}`, hubLines, lmFailures, lmKinds,
      async stop() { for (const close of closers.reverse()) await close(); await fs.rm(root, { recursive: true, force: true }); }
    };
  } catch (error) {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

// ── ページの中の道具: 表が出た時刻・止める／動かし直す・決めた時刻で順に止める見張り・明かしが落ち着いた時刻 ──
const PAGE_TOOLS = `(() => {
  if (window.__af) return true;
  const af = window.__af = { frozen: null, frozenAt: 0, pausedTotal: 0, queued: [], watch: null, zeroAt: null, zeroPaused: 0, readyMs: null };
  const realSetTimeout = window.setTimeout.bind(window);
  // ページの setTimeout は、止めていた長さだけ後へずれる時計で数える（明かしの時割りが撮影で詰まらない）。
  const virtualNow = () => performance.now() - af.pausedTotal;
  const timers = new Map();
  const dispatch = (timer) => {
    if (timer.cancelled) return;
    if (af.frozen) { af.queued.push(timer); return; }
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
  const bracket = document.querySelector('#arena-bracket');
  const result = document.querySelector('#arena-result');
  const actions = document.querySelector('#arena-bracket-actions');
  af.sinceZero = () => performance.now() - af.zeroAt - (af.pausedTotal - af.zeroPaused) - (af.frozen ? performance.now() - af.frozenAt : 0);
  // 0 の時刻（表が出た・紋を押した）から、次の手（金の輪の目と見ずに先へ進む紋）か結果の段が立つまでを、止めていた長さを除いて測る。
  const markReady = () => {
    if (af.zeroAt === null || af.readyMs !== null) return;
    const skip = actions.querySelector('.arena-spectate-skip');
    const settledEntry = !bracket.hidden && skip && skip !== af.pressedSkip && !bracket.classList.contains('arena-bracket--entering');
    if (settledEntry || !result.hidden) af.readyMs = af.sinceZero();
  };
  af.markZero = () => { af.zeroAt = performance.now(); af.zeroPaused = af.pausedTotal; af.readyMs = null; if (af.watch) af.watch.start(); markReady(); };
  // 表へ戻る紋・見ずに先へ進む紋を押した時も 0（押した瞬間・画面の処理より先に）。
  document.addEventListener('click', (event) => {
    const skip = event.target.closest?.('.arena-spectate-skip');
    if (skip) { af.pressedSkip = skip; af.markZero(); }
    if (event.target.closest?.('#arena-match-back')) af.markZero();
  }, true);
  // 表が出た時を 0 にするのは、観戦の立ち位置を押した後（観戦の入り）だけ。
  new MutationObserver(() => { if (!bracket.hidden && af.zeroOnBracket) { af.zeroOnBracket = false; af.markZero(); } }).observe(bracket, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(markReady).observe(actions, { childList: true });
  new MutationObserver(markReady).observe(bracket, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(markReady).observe(result, { attributes: true, attributeFilter: ['hidden'] });
  const flushStyle = () => { void document.documentElement.getBoundingClientRect(); };
  const pauseAll = () => { flushStyle(); for (const a of document.getAnimations()) if (a.playState === 'running') a.pause(); };
  const holdLoop = () => { if (!af.frozen) return; pauseAll(); realSetTimeout(holdLoop, 4); };
  af.freeze = (name) => { af.frozen = name; af.frozenAt = performance.now(); pauseAll(); holdLoop(); };
  af.resume = () => {
    af.pausedTotal += performance.now() - af.frozenAt;
    af.frozen = null;
    const queued = af.queued.splice(0);
    for (const timer of queued) dispatch(timer);
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
    if (af.watch) af.watch.next();
  };
  // 次の 0 の時刻（表が出る・markZero）から、offsets（ms・昇順）の時刻で順に止める。二つ目からの間は、動かし直してから数える。
  af.arm = (offsets) => {
    const state = { offsets: [...offsets], last: 0 };
    state.next = () => {
      if (!state.offsets.length) { af.watch = null; return; }
      const offset = state.offsets.shift();
      const wait = offset - state.last;
      state.last = offset;
      realSetTimeout(() => { if (af.watch === state) af.freeze('at@' + offset); }, wait);
    };
    state.start = state.next;
    af.watch = state;
    return true;
  };
  return true;
})()`;

// 止めた瞬間の、表と結果の段の終わっていない動き（名と進み）と、0 の時刻からの長さ（止めていた長さを除く）。
const FROZEN_STATE = `(() => ({
  ms_since_zero: Math.round(window.__af.sinceZero()),
  motions: document.querySelector('#arena-bracket').getAnimations({ subtree: true })
    .filter((a) => a.currentTime < a.effect.getComputedTiming().endTime)
    .map((a) => (a.animationName ?? a.transitionProperty ?? a.id) + '@' + Math.round(a.currentTime) + '/' + Math.round(a.effect.getComputedTiming().endTime))
}))()`;

const PAGE_STATE = `(() => ({
  screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
  playMode: document.body.classList.contains('play-mode'),
  arenaStage: document.querySelector('#academy-arena-screen')?.dataset.stage ?? null
}))()`;

// 表に見えているもの（回戦ごと）: 節の数（決勝は頂）・結果を見せている節（見返しの目・灯）・節から次の節へ灯った線・見返しの目
// （金の輪の目を除く）・金の輪の目。と、優勝者の星の付いた名の数。
const BRACKET_DOM = `(() => {
  const ring = document.querySelector('#arena-bracket-ring');
  const rounds = [...new Set([...ring.querySelectorAll('.arena-ring-node, .arena-ring-crown')].map((n) => Number(n.dataset.round)))].sort((a, b) => a - b);
  return {
    champions: ring.querySelectorAll('.arena-ring-name--champion').length,
    rounds: rounds.map((r) => {
      const nodes = [...ring.querySelectorAll('.arena-ring-node[data-round="' + r + '"], .arena-ring-crown[data-round="' + r + '"]')];
      return {
        matches: nodes.length,
        shown: nodes.filter((n) => ['eye', 'won', 'hero'].includes(n.dataset.state)).length,
        lit: ring.querySelectorAll('.arena-ring-lit--on[data-round="' + r + '"]').length,
        eyes: ring.querySelectorAll('.arena-ring-eye[data-round="' + r + '"]:not(.arena-ring-eye--entry)').length,
        entry: ring.querySelectorAll('.arena-ring-eye--entry[data-round="' + r + '"]').length
      };
    })
  };
})()`;

// 名の札の照合（表が出ているときだけ・出ていなければ null）: 字の行ごとに scrollWidth ≤ clientWidth（描いた字が欠けていない）と、
// 字が名簿の名（actor_id → display_name）と一致すること。輪とまだの線の計算済みの色・太さ・濃さ（線の層の濃さも）を添える。
const ringNames = (roster) => `(() => {
  if (document.querySelector('#arena-bracket').hidden) return null;
  const roster = ${JSON.stringify(roster)};
  const ring = document.querySelector('#arena-bracket-ring');
  const labels = [...ring.querySelectorAll('.arena-ring-name')];
  const problems = [];
  const lines = labels.flatMap((label) => [...label.querySelectorAll('.arena-ring-name-line')].map((line) => {
    const expected = roster[line.dataset.actorId];
    if (expected === undefined) problems.push('no roster name for ' + line.dataset.actorId);
    else if (line.textContent !== expected) problems.push(line.dataset.actorId + ' shows ' + JSON.stringify(line.textContent) + ' not ' + JSON.stringify(expected));
    if (line.scrollWidth > line.clientWidth) problems.push(line.textContent + ' overflows ' + line.scrollWidth + ' > ' + line.clientWidth);
    return { actor: line.dataset.actorId, text: line.textContent, scroll_w: line.scrollWidth, client_w: line.clientWidth };
  }));
  if (labels.length !== 16) problems.push(labels.length + ' name labels');
  const style = (selector) => {
    const el = ring.querySelector(selector);
    const cs = getComputedStyle(el);
    return { stroke: cs.stroke, stroke_width: cs.strokeWidth, opacity: cs.opacity, layer_opacity: getComputedStyle(el.parentNode).opacity };
  };
  return { layout: ring.dataset.layout, labels: labels.length, lines: lines.length, widest_text_px: Math.max(...lines.map((l) => l.scroll_w)),
    problems, names: lines, guide: style('.arena-ring-guide'), line: style('.arena-ring-line') };
})()`;

const SERVER_BRACKET = `fetch('/api/arena/state').then((r) => r.json()).then((s) => ({
  week: s.week, terminal: s.terminal, outcome: s.outcome, wins: s.wins, mode: s.mode, player_unit_id: s.player_unit_id,
  buddy: s.units.find((u) => u.unit_id === s.player_unit_id).actors.map((a) => ({ name: a.name, parameters: a.parameters })),
  rounds: s.bracket.rounds.map((round) => ({
    resolved: round.filter((m) => m.resolved).length,
    auto_resolved: round.filter((m) => m.resolved && m.is_auto).length,
    buddy_match: round.find((m) => m.team_a_unit_id === s.player_unit_id || m.team_b_unit_id === s.player_unit_id) ?? null
  }))
}))`;

const RESULT_STATE = `(() => {
  const panel = document.querySelector('#arena-result');
  if (!panel || panel.hidden) return null;
  return {
    title: panel.querySelector('.arena-result-title')?.textContent ?? null,
    summary: panel.querySelector('.arena-result-summary')?.textContent ?? null,
    prize: panel.querySelector('.arena-result-prize')?.textContent ?? null,
    materials: [...panel.querySelectorAll('.arena-result-materials-row')].map((r) => r.textContent),
    flavor: panel.querySelector('#arena-result-flavor')?.textContent ?? null,
    flavorState: panel.querySelector('#arena-result-flavor')?.dataset.state ?? null
  };
})()`;

// 見返しの盤: 操作の手数・HUD の列（見出しと名）・駒（組の色・金の輪か・名・列 x・画面の左端）。
const REPLAY_STATE = `(() => ({
  info: document.querySelector('.arena-replay-info')?.textContent ?? null,
  columns: [...document.querySelectorAll('#arena-hud-status .an-hud-team')].map((col) => ({
    label: col.querySelector('.an-hud-team-label')?.textContent ?? null,
    names: [...col.querySelectorAll('.an-hud-actor-name')].map((b) => b.textContent)
  })),
  tokens: [...document.querySelectorAll('#arena-grid .an-entity')].map((node) => ({
    side: [...node.classList].find((c) => c.startsWith('an-entity--')),
    label: node.querySelector('.an-token')?.title ?? null,
    left: Math.round(node.getBoundingClientRect().left)
  })).sort((a, b) => a.left - b.left)
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js, pageErrors,
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
    async moveAway() { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); },
    // 窓の寸法を替え、表が出ていれば円の表が新しい窓で置き直されるまで待つ（止めている間も置き直しは走る）。
    async setWindow(size) {
      await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      await page.waitFor(`innerWidth === ${size.width} && innerHeight === ${size.height} && (document.querySelector('#arena-bracket').hidden || document.querySelector('#arena-bracket-ring').dataset.layout === '${size.width}x${size.height}')`, `the ${size.width}x${size.height} window`, 5000);
    },
    async png() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
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
}

async function sendOffToArena(ctx) {
  const { page } = ctx;
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', ctx.product.hubLines.arena);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  await page.waitFor(arrived(ARENA), 'arena arrived', LM_WAIT_MS);
  await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection');
}

const ARENA = 'academy-arena-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const ENTRY_READY = `${ARENA_STAGE('bracket')} && document.querySelector('#arena-bracket-ring .arena-ring-eye--entry') && document.querySelector('#arena-bracket-actions .arena-spectate-skip') && !document.querySelector('#arena-bracket').classList.contains('arena-bracket--entering')`;
const RESULT_UP = `${ARENA_STAGE('result')} && !document.querySelector('#arena-result').hidden`;
const RESULT_READY = `${RESULT_UP} && document.querySelector('#arena-result-flavor')?.dataset.state !== 'pending'`;
const NEXT_READY = `(${ENTRY_READY} || ${RESULT_UP})`;
const REPLAY_UP = `${ARENA_STAGE('match')} && document.querySelector('#arena-grid .an-entity') && document.querySelector('.arena-replay-info')`;
const REPLAY_AT_END = "(() => { const t = document.querySelector('.arena-replay-info')?.textContent ?? ''; const [a, b] = t.split(' / '); return a && a === b; })()";

async function sendOff(ctx, condition, label) {
  const { page } = ctx;
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', ctx.product.hubLines.arena);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  await page.waitFor(arrived(ARENA), 'arena arrived', LM_WAIT_MS);
  await page.waitFor(`${settled(ARENA)} && ${condition}`, label);
}
const SELECTION_READY = `${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`;

// 一つの瞬間を二つの窓で撮る（<file>-<幅>x<高さ>.png）。perWindow(size, bytes, name) は窓ごとの測りを足す。
async function shoot(ctx, file, note, extra = {}, perWindow = null) {
  const state = await ctx.page.js(PAGE_STATE);
  if (!state.playMode) throw new Error(`${file}: body.play-mode is not set`);
  const files = [];
  for (const size of WINDOWS) {
    await ctx.page.setWindow(size);
    const name = `${file}-${size.width}x${size.height}.png`;
    const target = path.join(ctx.options.out, name);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
    const bytes = await ctx.page.png();
    if (bytes.readUInt32BE(16) !== size.width || bytes.readUInt32BE(20) !== size.height) throw new Error(`${name} is not ${size.width}x${size.height}`);
    await fs.writeFile(target, bytes);
    const names = await ctx.page.js(ringNames(ctx.roster));
    if (names) {
      const summary = { ...names };
      delete summary.names;
      console.log(`RINGNAMES ${JSON.stringify({ file: name, ...summary })}`);
      if (names.problems.length) throw new Error(`${name}: ${names.problems.join('; ')}`);
    }
    const measured = perWindow ? await perWindow(size, bytes, name) : {};
    files.push({ file: name, ring_names: names, ...measured });
    console.log(`shot ${name} — ${note} ${JSON.stringify({ stage: state.arenaStage, ...extra })}`);
  }
  await ctx.page.setWindow(VIEWPORT);
  ctx.shots.push({ file, note, state, files, ...extra });
}

// 表に見えているものを、道具が数えた明かした回戦の数（revealed）と server の表に照らす。明かした回戦は 灯った節 = 解けた試合・灯った
// 線 = 解けた試合（決勝は線を持たない）・目 = 自動の試合、明かしていない回戦は灯った節・線・目が 0、金の輪の目はバディーの次の組に
// 一つだけ（明かし終えていれば 0）、優勝者の星は全部明かしたときだけ一つ。
async function checkBracket(ctx, label, revealed) {
  const dom = await ctx.page.js(BRACKET_DOM);
  const server = await ctx.page.js(SERVER_BRACKET);
  const total = server.rounds.length;
  const problems = [];
  if (server.mode !== 'spectate' || !server.terminal) problems.push(`server is not a concluded spectate (${server.mode}, terminal ${server.terminal})`);
  dom.rounds.forEach((d, r) => {
    const s = server.rounds[r];
    const entry = r === revealed && revealed < total ? 1 : 0;
    const lines = r === total - 1 ? 0 : s.resolved;
    if (r < revealed && d.shown !== s.resolved) problems.push(`round ${r + 1} is revealed but shows ${d.shown}/${s.resolved} lit nodes`);
    if (r < revealed && d.lit !== lines) problems.push(`round ${r + 1} is revealed but shows ${d.lit}/${lines} lit lines`);
    if (r < revealed && d.eyes !== s.auto_resolved) problems.push(`round ${r + 1} is revealed but shows ${d.eyes}/${s.auto_resolved} eyes`);
    if (r >= revealed && (d.shown || d.lit || d.eyes)) problems.push(`round ${r + 1} is not revealed but shows ${d.shown} lit nodes / ${d.lit} lit lines / ${d.eyes} eyes`);
    if (d.entry !== entry) problems.push(`round ${r + 1} shows ${d.entry} gold-ringed eyes (expected ${entry})`);
  });
  if (dom.champions !== (revealed === total ? 1 : 0)) problems.push(`${dom.champions} crowned names with ${revealed} revealed rounds`);
  const line = { label, revealed, champions: dom.champions, rounds: dom.rounds.map((d, r) => ({ round: r + 1, shown: `nodes ${d.shown}/${d.matches} lines ${d.lit} eyes ${d.eyes} entry ${d.entry}`, server: `resolved ${server.rounds[r].resolved} auto ${server.rounds[r].auto_resolved}` })) };
  console.log(`BRACKET ${JSON.stringify(line)}`);
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  ctx.checks.push(line);
  return server;
}

async function shootSettled(ctx, file, note, condition, revealed) {
  const { page } = ctx;
  await page.waitFor(`${settled(ARENA)} && ${condition}`, `${file} settled`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.moveAway();
  await checkBracket(ctx, file, revealed);
  await shoot(ctx, file, note, { revealed, result: await page.js(RESULT_STATE) });
}

// 止める瞬間を順に撮る（0 の時刻の前に arm で仕掛けておく）。
async function shootFrozen(ctx, shots) {
  const { page } = ctx;
  for (const shot of shots) {
    await page.waitFor('window.__af.frozen', `the frozen moment for ${shot.file}`, 15000);
    await shoot(ctx, shot.file, shot.note, { at: await page.js('window.__af.frozen'), ...(await page.js(FROZEN_STATE)) });
    await page.js('window.__af.resume()');
  }
}
const offsetsOf = (shots) => JSON.stringify(shots.map((s) => s.offset));

async function enterSpectate(ctx, shots = []) {
  const { page } = ctx;
  await page.js(PAGE_TOOLS);
  if (shots.length) await page.js(`window.__af.arm(${offsetsOf(shots)})`);
  await page.js('window.__af.zeroOnBracket = true');
  const clickAt = Date.now();
  await page.click("document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode=\"spectate\"]')", '観戦の立ち位置');
  await shootFrozen(ctx, shots);
  await page.waitFor(ENTRY_READY, 'the spectate entrance to settle', LM_WAIT_MS);
  const record = { ms_click_to_entry: Date.now() - clickAt, ms_entrance_ready: Math.round(await page.js('window.__af.readyMs')) };
  console.log(`ENTER ${JSON.stringify(record)}`);
  return { clickAt, record };
}

// バディーの次の組の見返し: 金の輪の目を押し、（start なら三手目で撮って）スキップで終わりまで送り、（end なら撮って）表へ戻る紋を押す。
// 見返しでバディーが自陣の側（左の列・左の駒）に立ち、駒が金の輪（an-entity--self）であることを確かめる。
async function watchBuddy(ctx, { round, buddyName, entering = null, start = null, end = null, back = [] }) {
  const { page } = ctx;
  const server = await page.js(SERVER_BRACKET);
  const match = server.rounds[round - 1].buddy_match;
  const expectedMark = match.winner_unit_id !== server.player_unit_id ? '敗退' : round === server.rounds.length ? '優勝' : '勝ち上がり';
  const clickAt = Date.now();
  await page.click("document.querySelector('#arena-bracket-ring .arena-ring-eye--entry')", 'バディーの組の金の輪の目');
  await page.waitFor(REPLAY_UP, 'the buddy replay', LM_WAIT_MS);
  const boardAt = Date.now();
  if (entering) { await sleep(entering.afterMs); await shoot(ctx, entering.file, entering.note, { ms_after_board: Date.now() - boardAt }); }
  if (start) {
    await page.waitFor("(document.querySelector('.arena-replay-info')?.textContent ?? '').startsWith('3 / ') || " + REPLAY_AT_END, 'the third replay turn', 15000);
    await page.moveAway();
  }
  const replay = await page.js(REPLAY_STATE);
  const left = replay.tokens[0];
  const problems = [];
  if (replay.columns[0]?.label !== '自陣' || !replay.columns[0].names.includes(buddyName)) problems.push(`the left HUD column is not the buddy's 自陣: ${JSON.stringify(replay.columns)}`);
  if (left?.side !== 'an-entity--self' || !left.label.startsWith(buddyName)) problems.push(`the leftmost token is not the gold-ringed buddy: ${JSON.stringify(replay.tokens)}`);
  if (replay.tokens.filter((t) => t.side === 'an-entity--self').length !== 1) problems.push(`gold-ringed tokens: ${JSON.stringify(replay.tokens)}`);
  console.log(`REPLAY ${JSON.stringify({ round, ...replay })}`);
  if (problems.length) throw new Error(`round ${round} replay: ${problems.join('; ')}`);
  if (start) await shoot(ctx, start.file, start.note, { replay });
  if (await page.js("!!document.querySelector('.arena-replay-skip')")) await page.click("document.querySelector('.arena-replay-skip')", 'スキップ');
  await page.waitFor(REPLAY_AT_END, 'the replay end', 15000);
  const endInfo = await page.js("document.querySelector('.arena-replay-info').textContent");
  // 見返しの終わりの灯と印は、バディーの側から読む（勝てば灯がふくらみ 勝ち上がり／優勝、負ければ灯が沈み 敗退）。
  await page.waitFor("document.querySelector('#arena-mark')?.classList.contains('is-shown')", 'the ending mark', 15000);
  const ending = await page.js("({ mark: document.querySelector('#arena-mark').textContent, venue: document.querySelector('#arena-venue').dataset.venue })");
  console.log(`ENDING ${JSON.stringify({ round, ...ending, expected: expectedMark })}`);
  if (ending.mark !== expectedMark || ending.venue !== (expectedMark === '敗退' ? 'sink' : 'swell')) throw new Error(`round ${round} ending is not read from the buddy's side: ${JSON.stringify(ending)} (expected ${expectedMark})`);
  if (end) { await sleep(600); await page.moveAway(); await shoot(ctx, end.file, end.note, { info: endInfo, ending }); }
  if (back.length) await page.js(`window.__af.arm(${offsetsOf(back)})`);
  const backAt = Date.now();
  await page.click("document.querySelector('#arena-match-back')", '表へ戻る紋');
  await shootFrozen(ctx, back);
  await page.waitFor(NEXT_READY, 'the next entry or the result stage', 15000);
  const record = { round, replay_turns: endInfo, ms_eye_to_board: boardAt - clickAt, ms_back_to_ready: Math.round(await page.js('window.__af.readyMs')), ms_round_wall: Date.now() - clickAt };
  console.log(`WATCH ${JSON.stringify(record)}`);
  return record;
}

async function pressSkip(ctx, shots = []) {
  const { page } = ctx;
  if (shots.length) await page.js(`window.__af.arm(${offsetsOf(shots)})`);
  await page.click("document.querySelector('#arena-bracket-actions .arena-spectate-skip')", '見ずに先へ進む紋');
  await shootFrozen(ctx, shots);
  await page.waitFor(NEXT_READY, 'the next entry or the result stage', 15000);
  const record = { ms_skip_to_ready: Math.round(await page.js('window.__af.readyMs')) };
  console.log(`SKIP ${JSON.stringify(record)}`);
  return record;
}

// バディーの次の回戦を明かした後の数: 勝てば一つ先、負けたか決勝なら全部。
function nextRevealed(server, revealed) {
  const match = server.rounds[revealed].buddy_match;
  return match.winner_unit_id === server.player_unit_id && revealed < server.rounds.length - 1 ? revealed + 1 : server.rounds.length;
}

async function arenaReady(ctx) {
  await walkToHub(ctx);
  await sendOff(ctx, SELECTION_READY, 'the arena selection');
  const server = await ctx.page.js("fetch('/api/arena/state').then((r) => r.json()).then((s) => s.buddy)");
  return server.display_name;
}

const ENTRANCE_SHOTS = [
  { offset: 0, file: 'entrance-0000', note: '観戦の入り・表 0 秒（一回戦の名だけの円の表・灯った節も目も無い）' },
  { offset: 300, file: 'entrance-0300', note: '同・0.3 秒（バディーの名の後ろの金の板が灯り始める）' },
  { offset: 700, file: 'entrance-0700', note: '同・0.7 秒（バディーの組の節にだけ目が出て、金の輪で開き始める）' }
];
const REVEAL_SHOTS = [
  { offset: 150, file: 'reveal-r1-0150', note: '一回戦の見返しの終わりで表へ戻る紋を押した・0.15 秒（盤が薄れる途中）' },
  { offset: 400, file: 'reveal-r1-0400', note: '同・0.4 秒（表が出て、金の輪が退いて明かした組の目になり、バディーの金の線が準々決勝の節へ伸び始める）' },
  { offset: 700, file: 'reveal-r1-0700', note: '同・0.7 秒（バディーの線が準々決勝の節へ近づく・名の後ろの板が灯る）' },
  { offset: 1100, file: 'reveal-r1-1100', note: '同・1.1 秒（次の相手を決める隣の組の勝者の線が白く伸びる）' },
  { offset: 1500, file: 'reveal-r1-1500', note: '同・1.5 秒（ほかの組が上から順に明らかになる途中）' }
];
const SKIP_SHOTS = [
  { offset: 200, file: 'skip-r2-0200', note: '準々決勝の前で見ずに先へ進む紋を押した・0.2 秒（盤を開かずに明かし、相手の線が準決勝の節へ伸び、バディーの名が沈み、バディーの道が半分の濃さの金になる）' },
  { offset: 500, file: 'skip-r2-0500', note: '同・0.5 秒（準々決勝の残りが見届けの速さで）' },
  { offset: 1200, file: 'skip-r2-1200', note: '同・1.2 秒（短い間を置いて準決勝）' },
  { offset: 1900, file: 'skip-r2-1900', note: '同・1.9 秒（決勝が明らかになり、頂の星が灯って優勝者の道が金で通る）' },
  { offset: 2300, file: 'skip-r2-2300', note: '同・2.3 秒（表が沈み、結果の段が立つ途中）' }
];
const CHAMPION_SHOTS = [
  { offset: 500, file: 'champion-0500', note: '決勝の見返しを終えて表へ戻る紋を押した・0.5 秒（盤が薄れた後、頂の星が灯り、バディーの道が強い金になり、名の後ろの板が灯る）' },
  { offset: 850, file: 'champion-0850', note: '同・0.85 秒（表が沈み、結果の段が立つ途中）' }
];
const ELIMINATED_SHOTS = [
  { offset: 150, file: 'eliminated-0150', note: '一回戦の見返し（バディーの負け）の終わりで表へ戻る紋を押した・0.15 秒（盤が薄れる途中）' },
  { offset: 550, file: 'eliminated-0550', note: '同・0.55 秒（相手の線が準々決勝の節へ伸び、バディーの名が沈み、バディーの道が半分の濃さの金になる）' },
  { offset: 1300, file: 'watch-1300', note: '見届け・1.3 秒（一回戦の残りが上から速く）' },
  { offset: 2300, file: 'watch-2300', note: '見届け・2.3 秒（短い間を置いて準々決勝）' },
  { offset: 3000, file: 'watch-3000', note: '見届け・3.0 秒（準決勝）' },
  { offset: 3600, file: 'watch-3600', note: '見届け・3.6 秒（決勝が明らかになり、頂の星が灯って優勝者の道が金で通る）' },
  { offset: 3900, file: 'watch-3900', note: '見届け・3.9 秒（表が沈み、結果の段が立つ途中）' }
];

// バディーの出ない解けた試合の見返しを全部取り、最後の手の status と手数を並べる（回戦の順）。
const NON_BUDDY_REPLAYS = `fetch('/api/arena/state').then((r) => r.json()).then(async (s) => {
  const out = [];
  for (const m of s.bracket.rounds.flat()) {
    if (!m.resolved || !m.is_auto || m.team_a_unit_id === s.player_unit_id || m.team_b_unit_id === s.player_unit_id) continue;
    const replay = await fetch('/api/arena/match/' + encodeURIComponent(m.match_id) + '/replay').then((r) => r.json());
    const last = replay.turns.at(-1).view;
    out.push({ match_id: m.match_id, round: m.round, index: m.index, team_a_unit_id: m.team_a_unit_id, team_b_unit_id: m.team_b_unit_id, winner_unit_id: replay.winner_unit_id, turns: replay.turns.length, last_status: last.status, last_winner: last.winner });
  }
  return { rounds: s.bracket.rounds.length, matches: out };
})`;

// 見返しの終わり: 印・会場の灯・大きく開く輪の付いた駒（組の色と名）。
const REPLAY_ENDING = `(() => ({
  info: document.querySelector('.arena-replay-info')?.textContent ?? null,
  mark: document.querySelector('#arena-mark').classList.contains('is-shown') ? document.querySelector('#arena-mark').textContent : null,
  venue: document.querySelector('#arena-venue').dataset.venue ?? null,
  wide: [...document.querySelectorAll('#arena-grid .an-entity')].filter((node) => node.querySelector('.an-foot')?.dataset.ring === 'wide').map((node) => ({
    side: [...node.classList].find((c) => c.startsWith('an-entity--')),
    label: node.querySelector('.an-token')?.title ?? null
  }))
}))()`;

// バディーの出ない試合の終わりは勝った側から読む: 印は 勝ち上がり（決勝なら 優勝）・灯はふくらむ・大きく開く輪は勝った側
// （team a＝ally・team b＝enemy）の駒にだけ付く。
function winnerSideEnding(match, rounds) {
  return { mark: match.round === rounds - 1 ? '優勝' : '勝ち上がり', venue: 'swell', side: match.winner_unit_id === match.team_a_unit_id ? 'an-entity--ally' : 'an-entity--enemy' };
}

// 観戦のバディーの試合の終わりはバディーの側から読む: 勝てば 勝ち上がり（決勝なら 優勝）・灯がふくらみ・大きく開く輪はバディー（金の輪
// an-entity--self）に、負ければ 敗退・灯が沈み・大きく開く輪は相手（左右に映した後も相手は右＝enemy）に付く。
function buddySideEnding(match, rounds) {
  const won = match.winner_unit_id === match.buddy_unit_id;
  return won
    ? { mark: match.round === rounds - 1 ? '優勝' : '勝ち上がり', venue: 'swell', side: 'an-entity--self' }
    : { mark: '敗退', venue: 'sink', side: 'an-entity--enemy' };
}

// 試合の見返しを表の目（バディーの組なら金の輪の目も同じ枠の目）から開き、way（auto＝高速の自動送り・skip＝スキップ）で終わりまで
// 送って、終わりの印・灯・大きく開く輪を expected に照らして撮り、表へ戻る。
async function watchEnd(ctx, match, expected, way, file, note) {
  const { page } = ctx;
  const eye = `document.querySelector('#arena-bracket-ring .arena-ring-eye[data-match-id="${match.match_id}"]')`;
  await page.click(eye, `${match.match_id} の見返しの目`);
  await page.waitFor(REPLAY_UP, `the replay of ${match.match_id}`, LM_WAIT_MS);
  const startedAt = Date.now();
  if (way === 'auto') {
    await page.click("document.querySelectorAll('.arena-replay-speed-button')[2]", '高速');
    await page.waitFor(REPLAY_AT_END, `the auto-advanced end of ${match.match_id}`, match.turns * 400 + 30000);
  } else {
    await page.click("document.querySelector('.arena-replay-skip')", 'スキップ');
    await page.waitFor(REPLAY_AT_END, `the skipped end of ${match.match_id}`, 15000);
  }
  await page.waitFor("document.querySelector('#arena-mark')?.classList.contains('is-shown')", `the ending mark of ${match.match_id}`, 15000);
  await sleep(SETTLE_MS);
  await page.moveAway();
  const ending = await page.js(REPLAY_ENDING);
  const line = { match_id: match.match_id, way, last_status: match.last_status, winner_unit_id: match.winner_unit_id, ...(match.buddy_unit_id ? { buddy_unit_id: match.buddy_unit_id, buddy_side: match.buddy_side } : {}), expected, ms_to_end: Date.now() - startedAt, ...ending };
  console.log(`REPLAY_END ${JSON.stringify(line)}`);
  const problems = [];
  if (ending.mark !== expected.mark) problems.push(`mark ${ending.mark}`);
  if (ending.venue !== expected.venue) problems.push(`venue ${ending.venue}`);
  if (!ending.wide.length || ending.wide.some((w) => w.side !== expected.side)) problems.push(`wide rings ${JSON.stringify(ending.wide)}`);
  if (problems.length) throw new Error(`${match.match_id} ${way} ending is not read from the expected side: ${problems.join('; ')}`);
  await shoot(ctx, file, note, { ending: line });
  await page.click("document.querySelector('#arena-match-back')", '表へ戻る紋');
  await page.waitFor(`(${ARENA_STAGE('bracket')} || ${RESULT_UP}) && ${settled(ARENA)}`, 'the bracket after the replay', 15000);
  return line;
}

// バディーの出ない試合から kind に合う一つ（回戦の早い順）を選ぶ。一回戦なら、一回戦のバディーの試合を見返して戻って一回戦を明かし、
// その先の回戦なら、見ずに先へ進む紋で結果の段まで送って表を全部明かしてから、その試合の二つの送り方の終わりを撮る。
async function nonBuddyEndings(ctx, kind) {
  const { page } = ctx;
  const buddyName = await arenaReady(ctx);
  await enterSpectate(ctx);
  const probe = await page.js(NON_BUDDY_REPLAYS);
  console.log(`NON_BUDDY ${JSON.stringify(probe)}`);
  const match = probe.matches.find((m) => (kind === 'capped' ? m.last_status === 'active' : m.last_status !== 'active'));
  if (!match) throw new Error(`no ${kind} non-buddy match in the tournament`);
  if (match.round === 0) {
    const server = await page.js(SERVER_BRACKET);
    if (nextRevealed(server, 0) !== 1) throw new Error('the buddy was expected to win round 1 (the bracket stays up with round 1 revealed)');
    await watchBuddy(ctx, { round: 1, buddyName });
    await page.waitFor(`${settled(ARENA)} && ${ENTRY_READY}`, 'round 1 revealed', LM_WAIT_MS);
  } else {
    while (!(await page.js(`!!(${RESULT_UP})`))) await pressSkip(ctx);
    await page.waitFor(`${settled(ARENA)} && ${RESULT_READY}`, 'the whole bracket revealed', LM_WAIT_MS);
  }
  const label = kind === 'capped' ? '三百の回りで打ち切られた' : '倒れて決まった';
  ctx.notes.match = match;
  ctx.notes.endings = [
    await watchEnd(ctx, match, winnerSideEnding(match, probe.rounds), 'auto', `${kind}-auto-end`, `バディーの出ない${label}試合（${match.match_id}・${match.turns} 手）の見返しを高速の自動送りで最後まで送った終わり`),
    await watchEnd(ctx, match, winnerSideEnding(match, probe.rounds), 'skip', `${kind}-skip-end`, `同じ試合の見返しをスキップで送った終わり`)
  ];
}

// 一回戦のバディーの試合の見返し（組の側・勝者・手数・最後の手の status）。
const BUDDY_ROUND1_REPLAY = `fetch('/api/arena/state').then((r) => r.json()).then(async (s) => {
  const m = s.bracket.rounds[0].find((c) => c.team_a_unit_id === s.player_unit_id || c.team_b_unit_id === s.player_unit_id);
  const replay = await fetch('/api/arena/match/' + encodeURIComponent(m.match_id) + '/replay').then((r) => r.json());
  const last = replay.turns.at(-1).view;
  return { rounds: s.bracket.rounds.length, match: { match_id: m.match_id, round: m.round, index: m.index, team_a_unit_id: m.team_a_unit_id, team_b_unit_id: m.team_b_unit_id, buddy_unit_id: s.player_unit_id, buddy_side: m.team_a_unit_id === s.player_unit_id ? 'a' : 'b', winner_unit_id: replay.winner_unit_id, turns: replay.turns.length, last_status: last.status } };
})`;

// 一回戦のバディーの試合を、金の輪の目から高速の自動送りで最後まで送った終わりと、表へ戻ってから同じ枠の目を開き直してスキップで
// 送った終わりを撮る（どちらもバディーの側から読む）。
async function buddyEndings(ctx, tag) {
  const { page } = ctx;
  await arenaReady(ctx);
  await enterSpectate(ctx);
  const { rounds, match } = await page.js(BUDDY_ROUND1_REPLAY);
  console.log(`BUDDY_ROUND1 ${JSON.stringify(match)}`);
  const result = match.winner_unit_id === match.buddy_unit_id ? '勝ち' : '負け';
  ctx.notes.match = match;
  ctx.notes.endings = [
    await watchEnd(ctx, match, buddySideEnding(match, rounds), 'auto', `${tag}-auto-end`, `一回戦のバディーの試合（${match.match_id}・バディーは team ${match.buddy_side}・${result}・${match.turns} 手）の見返しを高速の自動送りで最後まで送った終わり`),
    await watchEnd(ctx, match, buddySideEnding(match, rounds), 'skip', `${tag}-skip-end`, '同じ試合の見返しをスキップで送った終わり')
  ];
}

const SCENES = {
  async capped(ctx) { await nonBuddyEndings(ctx, 'capped'); },
  async decided(ctx) { await nonBuddyEndings(ctx, 'decided'); },
  async 'buddy-ends'(ctx) { await buddyEndings(ctx, 'buddy-ends'); },
  async 'buddy-ends-min'(ctx) { await buddyEndings(ctx, 'buddy-ends-min'); },
  async boards(ctx) {
    const buddyName = await arenaReady(ctx);
    await sleep(SETTLE_MS);
    await shoot(ctx, 'selection', '選ぶ段（バディーの居る保存・観戦の立ち位置が押せる）');
    await enterSpectate(ctx, ENTRANCE_SHOTS);
    await shootSettled(ctx, 'entrance-settled', '観戦の入り・落ち着いた姿（バディーの組の目が金の輪で灯り、下に見ずに先へ進む紋・構成案の spectate-1-entrance と同じ瞬間）', ENTRY_READY, 0);
    let server = await ctx.page.js(SERVER_BRACKET);
    await watchBuddy(ctx, {
      round: 1, buddyName,
      entering: { afterMs: 400, file: 'replay-r1-entering', note: '一回戦の見返しの入り・盤が出て約 0.4 秒（二人が足もとの輪から順に立つ途中・バディーは左）' },
      start: { file: 'replay-r1-turn3', note: '一回戦の見返し・三手目（バディーが自陣の側〈左〉に立ち、足もとの輪が金）' },
      end: { file: 'replay-r1-end', note: '一回戦の見返しの終わり（スキップで送った・バディーが左）' },
      back: REVEAL_SHOTS
    });
    let revealed = nextRevealed(server, 0);
    await shootSettled(ctx, 'reveal-r1-end', '一回戦の明かし終わり（バディーの次の組の目だけが金の輪で灯り、下に見ずに先へ進む紋）', NEXT_READY, revealed);
    server = await ctx.page.js(SERVER_BRACKET);
    await pressSkip(ctx, SKIP_SHOTS);
    revealed = nextRevealed(server, revealed);
    if (revealed !== server.rounds.length) throw new Error('the default buddy was expected to lose the quarter-final (the boards tournament)');
    await shootSettled(ctx, 'result-buddy-eliminated', '結果の段（バディー敗退・実況の一文が全文・構成案の spectate-2-end と同じ瞬間）', RESULT_READY, revealed);
    ctx.notes.result = await ctx.page.js(RESULT_STATE);
  },
  async champion(ctx) {
    const buddyName = await arenaReady(ctx);
    await enterSpectate(ctx);
    let revealed = 0;
    const rounds = [];
    while (revealed < 4) {
      const server = await ctx.page.js(SERVER_BRACKET);
      if (revealed === 0) console.log(`BUDDY ${JSON.stringify(server.buddy)}`);
      const last = revealed === server.rounds.length - 1;
      rounds.push(await watchBuddy(ctx, {
        round: revealed + 1, buddyName,
        start: revealed <= 1 ? { file: `champion-replay-r${revealed + 1}-turn3`, note: `${['一回戦', '準々決勝'][revealed]}の見返し・三手目（バディーが左に立ち、足もとの輪が金）` } : null,
        back: last ? CHAMPION_SHOTS : []
      }));
      revealed = nextRevealed(server, revealed);
      if (revealed === server.rounds.length && !last) throw new Error(`the max buddy lost round ${rounds.length}`);
      if (!last) await shootSettled(ctx, `champion-reveal-r${revealed}-end`, `${['一回戦', '準々決勝', '準決勝'][revealed - 1]}の明かし終わり`, ENTRY_READY, revealed);
    }
    await shootSettled(ctx, 'result-buddy-champion', '結果の段（バディー優勝）', RESULT_READY, revealed);
    ctx.notes.rounds = rounds;
    ctx.notes.result = await ctx.page.js(RESULT_STATE);
  },
  async eliminated(ctx) {
    const buddyName = await arenaReady(ctx);
    await enterSpectate(ctx);
    const server = await ctx.page.js(SERVER_BRACKET);
    console.log(`BUDDY ${JSON.stringify(server.buddy)}`);
    if (nextRevealed(server, 0) !== server.rounds.length) throw new Error('the min buddy won round 1; the scene needs a loss');
    ctx.notes.rounds = [await watchBuddy(ctx, {
      round: 1, buddyName,
      start: { file: 'eliminated-replay-r1-turn3', note: '一回戦の見返し・三手目（バディーが左に立ち、足もとの輪が金）' },
      end: { file: 'eliminated-replay-r1-end', note: '一回戦の見返しの終わり（バディーの負け・スキップで送った）' },
      back: ELIMINATED_SHOTS
    })];
    await shootSettled(ctx, 'result-buddy-eliminated-r1', '結果の段（バディーが一回戦で敗退）', RESULT_READY, server.rounds.length);
    ctx.notes.result = await ctx.page.js(RESULT_STATE);
  },
  async 'timing-champion'(ctx) { await timingRun(ctx, 'watch'); },
  async 'timing-eliminated'(ctx) { await timingRun(ctx, 'watch'); },
  async 'timing-skip'(ctx) { await timingRun(ctx, 'skip'); },
  async reload(ctx) {
    const { page } = ctx;
    const buddyName = await arenaReady(ctx);
    await enterSpectate(ctx);
    const entered = await page.js(SERVER_BRACKET);
    console.log(`RELOAD_ENTERED ${JSON.stringify({ week: entered.week, terminal: entered.terminal, outcome: entered.outcome })}`);
    await watchBuddy(ctx, { round: 1, buddyName, back: [{ offset: 600, file: 'reload-before', note: '一回戦の見返しの終わりで表へ戻る紋を押した 0.6 秒（表の明かしの途中）・この後に読み直す' }] });
    // shootFrozen は撮った後に動かし直す。明かしが終わる前（表が出て約 0.3 秒＋撮影の間）に読み直す。
    await page.load(`${ctx.product.base}/`);
    await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
    await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
    await page.waitFor(`(${HUB_READY}) || (${arrived(ARENA)})`, 'the terrace or the arena after the reload', LM_WAIT_MS);
    const landed = { ...(await page.js(PAGE_STATE)), arena: await page.js("fetch('/api/arena/state').then((r) => r.json()).then((s) => ({ phase: s.phase, week: s.week, terminal: s.terminal ?? null }))") };
    console.log(`RELOAD_LANDED ${JSON.stringify(landed)}`);
    if (!(await page.js(`!!(${HUB_READY})`))) throw new Error('the reload did not land on the terrace');
    await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled');
    await sleep(SETTLE_MS);
    await shoot(ctx, 'reload-landed', '明かしの途中で読み直した後（露台に出る・観戦の明かしの途中は残らない）', { arena: landed.arena });
    await sendOff(ctx, `(${ARENA_STAGE('selection')} || ${RESULT_UP})`, 'the arena after the reload');
    await sleep(SETTLE_MS);
    const arena = { stage: await page.js(`document.querySelector('#${ARENA}').dataset.stage`), state: await page.js("fetch('/api/arena/state').then((r) => r.json()).then((s) => ({ phase: s.phase, week: s.week, terminal: s.terminal ?? null }))") };
    console.log(`RELOAD_ARENA ${JSON.stringify(arena)}`);
    await shoot(ctx, 'reload-arena', '読み直した後に露台から闘技会へ送り出し直した姿', arena);
    ctx.notes.reload = { entered: { week: entered.week, outcome: entered.outcome }, landed, arena };
  }
};

// 壁時計: 観戦の立ち位置を押してから結果の段が立つまで。凍らせない。watch はバディーの試合をどれも見返し（スキップで送って）から戻り、
// skip は見ずに先へ進む紋だけで進む。
async function timingRun(ctx, way) {
  const { page } = ctx;
  const buddyName = await arenaReady(ctx);
  await sleep(SETTLE_MS);
  const { clickAt, record: entrance } = await enterSpectate(ctx);
  const steps = [];
  let revealed = 0;
  while (revealed < 4) {
    const server = await page.js(SERVER_BRACKET);
    steps.push(way === 'watch' ? await watchBuddy(ctx, { round: revealed + 1, buddyName }) : { round: revealed + 1, ...(await pressSkip(ctx)) });
    revealed = nextRevealed(server, revealed);
  }
  await page.waitFor(RESULT_UP, 'the result stage', LM_WAIT_MS);
  ctx.notes.timing = { way, entrance, steps, ms_spectate_to_result: Date.now() - clickAt };
  console.log(`TIMING ${JSON.stringify(ctx.notes.timing)}`);
}

async function runScene(options, name, roster) {
  const product = await startProduct(options.repoRoot, { power: SCENE_POWER[name] });
  const guard = () => { if (product.lmFailures.length) throw new Error(`fixture LM 500: ${product.lmFailures.join(' | ')}`); };
  const page = await openPage(guard);
  const ctx = { options, product, page, roster, shots: [], checks: [], notes: { power: SCENE_POWER[name] } };
  const started = Date.now();
  try {
    await SCENES[name](ctx);
    guard();
    if (page.pageErrors.length) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
    return { scene: name, seconds: (Date.now() - started) / 1000, notes: ctx.notes, shots: ctx.shots, checks: ctx.checks, lmKinds: [...new Set(product.lmKinds)] };
  } finally {
    page.close();
    await product.stop();
  }
}

// 名簿の名: actor_id → 表に出る字。学院生は content/characters/<id>/profile.json の display_name、主人公は server の固定の名。
async function readRoster(repoRoot) {
  const roster = { protagonist: '主人公' };
  const characterRoot = path.join(repoRoot, 'content/characters');
  for (const dir of (await fs.readdir(characterRoot)).filter((d) => /^character_\d+$/.test(d))) {
    const profile = JSON.parse(await fs.readFile(path.join(characterRoot, dir, 'profile.json'), 'utf8'));
    if (typeof profile.display_name !== 'string' || !profile.display_name) throw new Error(`${dir}: profile.json has no display_name`);
    roster[dir] = profile.display_name;
  }
  return roster;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await fs.readdir(options.out).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  if (existing.length) throw new Error(`--out ${options.out} is not empty`);
  await fs.mkdir(options.out, { recursive: true });
  const roster = await readRoster(options.repoRoot);
  console.log(`ROSTER ${Object.keys(roster).length - 1} characters + protagonist`);
  await app.whenReady();
  const started = Date.now();
  const scenes = [];
  const failed = [];
  for (const name of options.scenes) {
    const sceneStart = Date.now();
    try {
      scenes.push(await runScene(options, name, roster));
      console.log(`scene ${name} done in ${((Date.now() - sceneStart) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.log(`SCENE FAILED ${name}: ${error.stack}`);
      failed.push(name);
    }
  }
  const manifest = { viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, failed };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${manifest.seconds.toFixed(1)} s (failed: ${failed.join(',') || '-'})`);
  if (failed.length) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
main().then(() => app.exit(0)).catch((error) => { console.error('FAILED', error.message); app.exit(1); });
