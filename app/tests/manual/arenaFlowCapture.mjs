// 闘技会の表の明かし・勝ち上がり・敗退の後の見届け・結果の段の確かめの、撮影と大会一回の実測の手回しの道具（*.test.mjs ではないので
// npm test は拾わない）:
//
//   <electron> app/tests/manual/arenaFlowCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品を、OS の一時ディレクトリに作った
// 新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こし、露台からの本物の送り出しで入る。LM は固定応答（知らない
// 要求は 500 にして撮影ごと止める）。口上と実況一文は続く字で見分け、実況一文は prompt の確定した結果の行を写した一文を返す。
// --out は空でなければ止まる。
//
// 瞬間の撮り方: 試合から表へ戻って表が出た時刻を 0 とし、決めた時刻でページの中の動きを全部止め、止めている間に来る setTimeout も
// 後へ回して撮る（撮り終えたら動かし直す）。次の瞬間までの間は、動かし直してから数える。
// 撮影はどれも 1440×900 と 1100×720 の二つの窓で撮る（止めたまま窓を替え、円の表が新しい窓で置き直されてから撮る。file 名の末尾が
// 窓の寸法）。表が出ている一枚ごとに、名の札の字が欠けていないこと（字の行ごとに scrollWidth ≤ clientWidth）と、字が名簿の
// display_name（content/characters の profile.json・主人公は server の固定の名「主人公」）と一致することを照らして RINGNAMES 行に出し、
// 外れれば止まる。輪とまだの線の計算済みの色・太さ・濃さも同じ行に出す。
// 表を撮るたびに、表に見えているもの（回戦ごとの灯った節・灯った線・見返しの目）と、server の表（解けた試合）を並べて BRACKET 行に
// 出し、まだ明かしていない回戦に灯った節・線・目が出ていれば止まる。
//
// scenes:
//   champion     主人公の 11 の能力値を上限にした一人の大会を優勝まで。表（第一試合の前）・表の名を押しても窓が開かない姿・第一試合で
//                HUD の名を押して開いた窓・一回戦の後の明かしの途中（0.1・0.2・0.3・0.4・0.6・0.9・1.1 秒）と終わり・準々決勝の後は表が
//                出てすぐ押して畳んだ姿・決勝の後の頂が灯る瞬間（0.2・0.3 秒）と表が沈む途中（0.55 秒）・結果の段
//   eliminated   新しいプレイの主人公で一人の大会を一回戦の敗退まで。敗退（0.25 秒）・見届けの途中（1.0・2.0・2.7・3.2 秒）・表が沈む途中・
//                結果の段（実況一文が出てから、枠の高さと中身の高さ・見えている行を測る）
//   pair         バディーを置いたプレイの二人の大会を終わりまで（手は撃つか待つかで動かないので、能力値を上限にすると二人の試合が
//                決着しないことがある — 新しいプレイの主人公のまま送る）。表（第一試合の前）・勝って戻ったときの明かし終わり・結果の段
//   pair-champion  バディーを置き、主人公の能力値を上限にした二人の大会を優勝まで。表（第一試合の前）・一回戦の後の明かしの途中（0.2・
//                0.9 秒）と終わり・決勝の後の頂が灯る瞬間（0.3 秒）と表が沈む途中（0.55 秒）・結果の段。どこかで負ければ止まる
//   pair-eliminated  バディーを置き、主人公の能力値を全部 0 にした二人の大会を負けるまで。表（第一試合の前）・負けて戻った見届けの途中
//                （0.25・1.0・2.0 秒）・結果の段
//   glow         能力値を上限にした一人の大会を優勝まで。一回戦の後の明かしで、主人公の名の後ろの金の楕円が灯る途中（板の時間の
//                四分の一）といちばん強い瞬間、決勝の後の優勝者の楕円がいちばん強い瞬間を、全面一枚と名の周りの拡大しない切り出し
//                一枚ずつ撮り、切り出しと同じ高さの名ごとに字と光の色（RGB）を測る（GLOW 行）
//   pair-win     バディーを置き、主人公の能力値を上限にしたプレイの二人の大会で、一回戦に勝って戻った明かしの途中（主人公の楕円が
//                いちばん強い 0.2 秒・隣の組の勝者の線が伸びる 0.6 秒・ほかの組の途中 1.1 秒）と終わりを撮る。一回戦に負ければ止まる
//   timing-champion  能力値を上限にした一人の大会を、凍らせずに最後まで送り、一人を押してから結果の段までを測る
//   timing-eliminated  新しいプレイの一人の大会を、同じく測る
//   timing-fold  timing-champion と同じ大会を、表が出るたびにすぐ押して明かしを畳んで測る
//
// 手の送り方は「撃てる魔法の札の先頭を押す。撃って誤り（相手が届く所にいない）が返ったら、いちばん近い生きた相手へ差の大きい軸で
// 一歩寄り、その一歩も誤り（壁）ならもう一方の軸で寄る。それも誤りか撃てる札が無ければ待機。応答のあと 700ms 空けて次を送る」。表では試合を始める紋が出たら
// すぐ押す（人の考える時間は入れない）。
import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';

const VIEWPORT = { width: 1440, height: 900 };
const WINDOWS = [VIEWPORT, { width: 1100, height: 720 }];
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const TURN_LIMIT = 400;
const HUMAN_GAP_MS = 700;
const HOST = '127.0.0.1';
const BUDDY_ID = 'character_001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCENE_NAMES = ['champion', 'eliminated', 'pair', 'pair-champion', 'pair-eliminated', 'glow', 'pair-win', 'timing-champion', 'timing-eliminated', 'timing-fold'];

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
const ARENA_INTRO_LINE = '夜の闘技場に篝火が揺れ、魔法陣の上で二つの影が向かい合う。';

function arenaResultLine(prompt) {
  const champion = prompt.match(/- この大会の優勝者は (.+)/);
  const lost = prompt.match(/- 主人公は(.+?)で (.+?) に敗れて姿を消した/);
  // 二人の大会の敗退（プロンプトに字数の行がある）は、その上限の内側に収まる短い型で返す。
  if (lost && champion && /長さは\d+字以内。$/.test(prompt)) return `${lost[1]}で${lost[2]}に敗れ、頂に立ったのは${champion[1].trim()}。`;
  if (lost && champion) return `${lost[1]}で${lost[2]}に阻まれた主人公の名を惜しむ声のなか、星を掲げたのは${champion[1].trim()}だった。`;
  const final = prompt.match(/- 主人公は決勝で (.+?) を下して優勝した/);
  if (final) return `決勝で${final[1]}を下した主人公の名が、篝火に照らされた円形の場に高く告げられた。`;
  throw new Error(`fixture lm: arena result prompt without a known outcome block: ${prompt.slice(-400)}`);
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-flow-capture-'));
  const closers = [];
  const lmFailures = [];
  const lmKinds = [];
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
      const state = JSON.parse(await fs.readFile(path.join(playArea.root, 'game_data/runtime_state.json'), 'utf8'));
      if (state.current_buddy_character_id !== buddy) throw new Error(`buddy was not set: ${state.current_buddy_character_id}`);
      console.log(`BUDDY_SET current_buddy_character_id=${state.current_buddy_character_id}`);
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

// ── ページの中の道具: 応答の控え・表が出た時刻・止める／動かし直す・表が出てからの時刻で順に止める見張り ──
const PAGE_TOOLS = `(() => {
  if (window.__af) return true;
  const af = window.__af = { seq: 0, last: null, frozen: null, frozenAt: 0, pausedTotal: 0, pausedAtShown: 0, readyMs: null, queued: [], bracketShownAt: null, bracketShows: 0, watch: null };
  const realSetTimeout = window.setTimeout.bind(window);
  // ページの setTimeout は、止めていた長さだけ後へずれる時計で数える: 止めている間に来たものは待たせ、動かし直した後も、止めていた
  // 長さの分だけ残りを待ってから走る（明かしの時割りが撮影で詰まらない）。
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
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = typeof input === 'string' ? input : input.url;
    if (/\\/api\\/arena\\/action$/.test(url)) {
      af.last = { url, json: await response.clone().json(), at: performance.now() };
      af.seq += 1;
    }
    return response;
  };
  const bracket = document.querySelector('#arena-bracket');
  new MutationObserver(() => {
    if (!bracket.hidden && af.bracketShownAt === null) { af.bracketShownAt = performance.now(); af.pausedAtShown = af.pausedTotal; af.readyMs = null; af.bracketShows += 1; if (af.watch) af.watch.onShown(); }
    if (bracket.hidden) af.bracketShownAt = null;
  }).observe(bracket, { attributes: true, attributeFilter: ['hidden'] });
  // 表が出てから、試合を始める紋か結果の段が立つまで（止めていた長さを除く）を、ページの中の時計で測る。
  const result = document.querySelector('#arena-result');
  const actions = document.querySelector('#arena-bracket-actions');
  const markReady = () => {
    if (af.bracketShownAt === null || af.readyMs !== null) return;
    if (actions.querySelector('.arena-fight') || !result.hidden) af.readyMs = performance.now() - af.bracketShownAt - af.pausedTotalSinceShown();
  };
  new MutationObserver(markReady).observe(actions, { childList: true });
  new MutationObserver(markReady).observe(result, { attributes: true, attributeFilter: ['hidden'] });
  const flushStyle = () => { void document.documentElement.getBoundingClientRect(); };
  const pauseAll = () => { flushStyle(); for (const a of document.getAnimations()) if (a.playState === 'running') a.pause(); };
  const holdLoop = () => { if (!af.frozen) return; pauseAll(); realSetTimeout(holdLoop, 4); };
  af.freeze = (name) => { af.frozen = name; af.frozenAt = performance.now(); pauseAll(); holdLoop(); };
  af.pausedTotalSinceShown = () => af.pausedTotal - af.pausedAtShown + (af.frozen ? performance.now() - af.frozenAt : 0);
  af.resume = () => {
    af.pausedTotal += performance.now() - af.frozenAt;
    af.frozen = null;
    const queued = af.queued.splice(0);
    for (const timer of queued) dispatch(timer);
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
    if (af.watch) af.watch.onResumed();
  };
  // 次に表が出たら、offsets（ms・昇順）の時刻で順に止める。二つ目からの間は、動かし直してから数える。
  af.armReveal = (offsets) => {
    const state = { offsets: [...offsets], fired: [], last: 0 };
    const next = () => {
      if (!state.offsets.length) { af.watch = null; return; }
      const offset = state.offsets.shift();
      const wait = offset - state.last;
      state.last = offset;
      realSetTimeout(() => { if (af.watch === state) { state.fired.push(offset); af.freeze('reveal@' + offset); } }, wait);
    };
    state.onShown = next;
    state.onResumed = next;
    af.watch = state;
    return true;
  };
  af.disarm = () => { af.watch = null; };
  // 止めている間に、表の中でまだ終わっていない name の動きのうち、いちばん早く始まったもの（後の組の同じ動きが同じ時刻に始まって
  // いても、狙いは先に始まった組）を、動きの中の localMs の所へ合わせる。
  // ほかの止めている動きも同じ長さだけずらす（瞬間の中の前後をくずさない）。合わせた動きの持ち主（::before の動きなら、その持ち主の
  // 要素）に data-af-target を付ける。
  af.seek = (name, localMs) => {
    if (!af.frozen) throw new Error('seek while not frozen');
    for (const el of document.querySelectorAll('[data-af-target]')) el.removeAttribute('data-af-target');
    const targets = document.querySelector('#arena-bracket').getAnimations({ subtree: true }).filter((a) => a.animationName === name && a.playState === 'paused');
    if (!targets.length) throw new Error('seek ' + name + ': no paused animation');
    const target = targets.reduce((a, b) => (b.currentTime > a.currentTime ? b : a));
    const delta = localMs - target.currentTime;
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.currentTime += delta;
    target.effect.target.setAttribute('data-af-target', '');
    return { name, local_ms: localMs, shifted_ms: Math.round(delta * 10) / 10, duration_ms: target.effect.getComputedTiming().duration, paused_same_name: targets.length };
  };
  return true;
})()`;

// 止めた瞬間の、表と結果の段の終わっていない動き（名と進み）。表が出てからの時刻（止めていた長さを除く）も添える。
const FROZEN_STATE = `(() => ({
  ms_since_bracket: Math.round(performance.now() - window.__af.pausedTotalSinceShown() - window.__af.bracketShownAt),
  motions: document.querySelector('#arena-bracket').getAnimations({ subtree: true })
    .filter((a) => a.currentTime < a.effect.getComputedTiming().endTime)
    .map((a) => (a.animationName ?? a.transitionProperty ?? a.id) + '@' + Math.round(a.currentTime) + '/' + Math.round(a.effect.getComputedTiming().endTime))
}))()`;

const PAGE_STATE = `(() => ({
  screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
  playMode: document.body.classList.contains('play-mode'),
  arenaStage: document.querySelector('#academy-arena-screen')?.dataset.stage ?? null
}))()`;

// 表に見えているもの（回戦ごと）: 節の数（決勝は頂）・結果を見せている節（見返しの目・灯）・節から次の節へ灯った線・見返しの目・
// 金の輪の目。と、優勝者の星の付いた名の数。
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
  terminal: s.terminal, outcome: s.outcome, wins: s.wins, mode: s.mode,
  rounds: s.bracket.rounds.map((round) => ({
    resolved: round.filter((m) => m.resolved).length,
    auto_resolved: round.filter((m) => m.resolved && m.is_auto).length,
    filled: round.reduce((n, m) => n + (m.team_a_unit_id ? 1 : 0) + (m.team_b_unit_id ? 1 : 0), 0),
    player_resolved: round.some((m) => m.is_player_match && m.resolved)
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

// 実況一文の枠: 字の数・枠の高さと中身の高さ・行の上端と、枠の中に見えている行の数。
const FLAVOR_BOX = `(() => {
  const p = document.querySelector('#arena-result-flavor');
  const cs = getComputedStyle(p);
  const range = document.createRange(); range.selectNodeContents(p);
  const lineTops = [...new Set([...range.getClientRects()].map((r) => Math.round(r.top)))].sort((a, b) => a - b);
  const box = p.getBoundingClientRect();
  const panel = document.querySelector('#arena-result').getBoundingClientRect();
  return { state: p.dataset.state, text: p.textContent, chars: [...p.textContent].length,
    clientHeight: p.clientHeight, scrollHeight: p.scrollHeight, scrollTop: p.scrollTop,
    height: cs.height, lineHeight: cs.lineHeight, fontSize: cs.fontSize, maxWidth: cs.maxWidth,
    boxWidth: Math.round(box.width), panelWidth: Math.round(panel.width), boxTop: Math.round(box.top), boxBottom: Math.round(box.bottom),
    lineTops, linesVisible: lineTops.filter((t) => t >= box.top - 1 && t < box.bottom - 1).length, linesTotal: lineTops.length };
})()`;

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

const ARENA = 'academy-arena-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const FIGHT_READY = `${ARENA_STAGE('bracket')} && document.querySelector('#arena-bracket-actions .arena-fight')`;
const RESULT_UP = `${ARENA_STAGE('result')} && !document.querySelector('#arena-result').hidden`;
const RESULT_READY = `${RESULT_UP} && document.querySelector('#arena-result-flavor')?.dataset.state !== 'pending'`;
const BACK_FROM_MATCH = `(${FIGHT_READY} || ${RESULT_UP})`;
const INPUT_READY = `(${BACK_FROM_MATCH} || (${ARENA_STAGE('match')} && !document.querySelector('#arena-dock-main').hidden))`;

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

// 表に見えているものと server の表を並べ、明かしていない回戦に星・目・名が出ていないことを確かめる。revealed は表が結果を見せてよい
// 回戦の数（主人公の試合が解けた回戦まで・大会が終われば全部）。
async function checkBracket(ctx, label) {
  const dom = await ctx.page.js(BRACKET_DOM);
  const server = await ctx.page.js(SERVER_BRACKET);
  const revealed = server.terminal ? server.rounds.length : server.rounds.filter((r) => r.player_resolved).length;
  const last = server.rounds.length - 1;
  const rows = dom.rounds.map((d, r) => ({ round: r + 1, dom: d, server: server.rounds[r] }));
  const problems = [];
  rows.forEach(({ round, dom: d, server: s }, r) => {
    if (r >= revealed && (d.shown || d.lit || d.eyes)) problems.push(`round ${round} is not revealed but shows ${d.shown} lit nodes / ${d.lit} lit lines / ${d.eyes} eyes`);
    if (r < revealed && d.shown !== s.resolved) problems.push(`round ${round} is revealed but shows ${d.shown}/${s.resolved} lit nodes`);
    if (r < revealed && d.lit !== (r === last ? 0 : s.resolved)) problems.push(`round ${round} is revealed but shows ${d.lit}/${r === last ? 0 : s.resolved} lit lines`);
    if (r < revealed && d.eyes !== s.auto_resolved) problems.push(`round ${round} is revealed but shows ${d.eyes}/${s.auto_resolved} eyes`);
  });
  if (dom.champions !== (revealed === server.rounds.length ? 1 : 0)) problems.push(`${dom.champions} crowned names with ${revealed} revealed rounds`);
  const line = { label, revealed, server_terminal: server.terminal, champions: dom.champions, rounds: rows.map(({ round, dom: d, server: s }) => ({ round, shown: `nodes ${d.shown}/${d.matches} lines ${d.lit} eyes ${d.eyes} entry ${d.entry}`, server: `resolved ${s.resolved} auto ${s.auto_resolved} filled ${s.filled}` })) };
  console.log(`BRACKET ${JSON.stringify(line)}`);
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  ctx.checks.push(line);
  return line;
}

const ARROW_KEYS = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39] };
// いちばん近い生きた相手への一歩の向き（差の大きい軸が primary、もう一方が secondary）。
const APPROACH = `(() => {
  const v = window.__af.last.json.view;
  const me = v.actors.find((a) => a.actor_id === v.player_actor_id);
  const foes = v.actors.filter((a) => a.team !== me.team && !a.down);
  const foe = foes.reduce((n, a) => (Math.abs(a.x - me.x) + Math.abs(a.y - me.y) < Math.abs(n.x - me.x) + Math.abs(n.y - me.y) ? a : n));
  const dx = foe.x - me.x, dy = foe.y - me.y;
  const h = dx > 0 ? 'right' : dx < 0 ? 'left' : null, w = dy > 0 ? 'down' : dy < 0 ? 'up' : null;
  return Math.abs(dx) >= Math.abs(dy) ? { primary: h, secondary: w } : { primary: w, secondary: h };
})()`;

async function arenaAct(ctx) {
  const { page } = ctx;
  const lastErrored = await page.js('!!window.__af.last?.json?.view?.action_error');
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

// HUD の名からは名の窓が開くことを撮る: 試合の盤で主人公の HUD の名を押し、窓が開いた姿を撮って閉じる。
async function openHudName(ctx) {
  const { page } = ctx;
  await page.waitFor(INPUT_READY, 'the first input', 15000);
  await page.click("[...document.querySelectorAll('#arena-hud-status .an-hud-actor-name')].find((b) => b.textContent === '主人公')", 'HUD の主人公の名');
  await page.waitFor("!document.querySelector('#arena-actor-detail').hidden", 'the actor detail window', 5000);
  await sleep(400);
  await page.moveAway();
  await shoot(ctx, 'hud-name-window', '試合の HUD の名（主人公）を押した後・名の窓が開く', { title: await page.js("document.querySelector('#arena-actor-detail-title').textContent") });
  await page.click("document.querySelector('#arena-actor-detail .terrace-close')", '名の窓を閉じる');
  await page.waitFor("document.querySelector('#arena-actor-detail').hidden", 'the actor detail window closed', 5000);
}

// 表の名を押しても窓が開かないことを撮る: 主人公の名の札の字の中ほどを押し、0.6 秒待って、名の窓（#arena-actor-detail）が閉じたまま
// かを見る（開いていれば止まる）。押した所の一番上の要素も記録する。
async function clickRingName(ctx) {
  const { page } = ctx;
  const at = await page.js("(() => { const line = document.querySelector('#arena-bracket-ring .arena-ring-name--hero .arena-ring-name-line'); const b = line.getBoundingClientRect(); const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2); const top = document.elementFromPoint(x, y); return { x, y, text: line.textContent, element_at_point: top.id ? '#' + top.id : top.className }; })()");
  await page.clickAt(at.x, at.y);
  await sleep(600);
  const open = await page.js("!document.querySelector('#arena-actor-detail').hidden");
  if (open) throw new Error(`the bracket name ${at.text} opened the actor detail window`);
  await page.moveAway();
  await shoot(ctx, 'name-click-no-window', `表の名（${at.text}）を押した 0.6 秒後・名の窓は開かない`, { clicked: at, detail_open: open });
}

// 一試合を送る。reveal: 表へ戻ったときに { offsets, shots: [{file, note}] } の瞬間で止めて撮る。fold: 表が出たらすぐ押して畳む。
// hud: 盤が出たら、最初の手の前に HUD の名を押して名の窓を撮る。
// 返すのは試合の記録（表が出てから、試合を始める紋か結果の段が立つまでの長さ ms_bracket_to_ready はページの中の時計で、
// 止めていた長さを除く）。
async function playMatch(ctx, { reveal = null, fold = false, hud = false } = {}) {
  const { page } = ctx;
  const clickAt = Date.now();
  await page.click("document.querySelector('#arena-bracket-actions .arena-fight')", '試合開始');
  await page.waitFor(`${ARENA_STAGE('match')} && document.querySelector('#arena-grid .an-entity')`, 'the match board', LM_WAIT_MS);
  const boardAt = Date.now();
  if (hud) await openHudName(ctx);
  let actions = 0;
  let casts = 0;
  let endAt = null;
  while (true) {
    if (actions > TURN_LIMIT) throw new Error('the match did not conclude');
    await page.waitFor(INPUT_READY, 'the next input', 15000);
    const seq = await page.js('window.__af.seq');
    if (reveal) await page.js(`window.__af.armReveal(${JSON.stringify(reveal.offsets)})`);
    const label = await arenaAct(ctx);
    await page.moveAway();
    actions += 1;
    if (label === 'cast') casts += 1;
    await page.waitFor(`window.__af.seq > ${seq}`, 'the action response', 15000);
    if (!(await page.js('window.__af.last.json.view.active'))) { endAt = Date.now(); break; }
    if (actions % 25 === 0) console.log(`TURN ${JSON.stringify(await page.js("(() => { const v = window.__af.last.json.view; return { actions: " + actions + ", round: v.round, action_error: v.action_error ?? null, actors: v.actors.map((a) => a.name + ' ' + a.team + ' hp ' + a.hp + '/' + a.max_hp + ' mp ' + a.mp) }; })()"))}`);
    await page.js('window.__af.disarm()');
    await sleep(HUMAN_GAP_MS);
  }
  await page.waitFor('window.__af.bracketShownAt !== null', 'the bracket after the match', 15000);
  const bracketAt = Date.now();
  if (fold) {
    await sleep(50);
    await page.clickAt(720, 450);
  }
  if (reveal) {
    for (const shot of reveal.shots) {
      await page.waitFor('window.__af.frozen', `the frozen moment for ${shot.file}`, 15000);
      if (shot.seek) await shootGlow(ctx, shot);
      else await shoot(ctx, shot.file, shot.note, { at: await page.js('window.__af.frozen'), ...(await page.js(FROZEN_STATE)) });
      await page.js('window.__af.resume()');
    }
  }
  await page.waitFor(BACK_FROM_MATCH, 'the fight sigil or the result stage', 15000);
  const readyAt = Date.now();
  const final = await page.js('window.__af.last.json.view');
  const player = final.actors.find((a) => a.kind === 'protagonist');
  const record = {
    opponent: final.actors.filter((a) => a.team !== player.team).map((a) => a.name).join('・'),
    won: final.winner === player.team, actions, casts,
    ms_click_to_board: boardAt - clickAt,
    ms_last_response_to_bracket: bracketAt - endAt,
    ms_bracket_to_ready: Math.round(await page.js('window.__af.readyMs')),
    ms_click_to_ready: readyAt - clickAt,
    folded: fold
  };
  console.log(`MATCH ${JSON.stringify(record)}`);
  return record;
}

async function enter(ctx, mode) {
  const { page } = ctx;
  await page.js(PAGE_TOOLS);
  const clickAt = Date.now();
  await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="${mode}"]')`, `${mode} の立ち位置`);
  await page.waitFor(FIGHT_READY, 'the bracket', LM_WAIT_MS);
  return { clickAt, ms_enter_to_bracket: Date.now() - clickAt };
}

async function shootSettled(ctx, file, note, condition) {
  const { page } = ctx;
  await page.waitFor(`${settled(ARENA)} && ${condition}`, `${file} settled`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
  await page.moveAway();
  const check = await checkBracket(ctx, file);
  await shoot(ctx, file, note, { revealed: check.revealed, result: await page.js(RESULT_STATE) });
}

// 明かしの時割り（表が出た時を 0 とした ms）: 一回戦に勝って戻ると、主人公の組を 0 から 400ms（ARENA_REVEAL_LEAD_MS）で明かし（主人公の
// 線が準々決勝の節へ伸び、名の後ろの金の楕円の板が灯って消える）、隣の組を 400 から、残りを 600 から 200 ずつずらして各 400ms。
const ADVANCE_SHOTS = [
  { offset: 100, file: 'advance-r1-0100', note: '一回戦に勝って戻った表・0.1 秒（主人公の金の線が一回戦の節から伸び始め、名の後ろの板が灯り始める）' },
  { offset: 200, file: 'advance-r1-0200', note: '同・0.2 秒（主人公の線が輪を回る途中・板がいちばん強い）' },
  { offset: 300, file: 'advance-r1-0300', note: '同・0.3 秒（主人公の線が準々決勝の節へ近づく）' },
  { offset: 400, file: 'advance-r1-0400', note: '同・0.4 秒（主人公の線が準々決勝の節へ届き、深紅の輪が移る。次の相手を決める隣の組が明かされ始める）' },
  { offset: 600, file: 'advance-r1-0600', note: '同・0.6 秒（隣の組の勝者の線が白く伸びる途中・負けた名が沈む）' },
  { offset: 900, file: 'advance-r1-0900', note: '同・0.9 秒（ほかの組が上から順に明らかになる途中）' },
  { offset: 1100, file: 'advance-r1-1100', note: '同・1.1 秒（ほかの組の線が伸びる途中）' }
];
// 敗退の後の見届け: 主人公の組を 0 から 400ms、一回戦の残りを 400 から 120 ずつずらして各 300ms、回戦の間に 180ms、決勝は 400ms。
const ELIMINATED_SHOTS = [
  { offset: 250, file: 'eliminated-0250', note: '一回戦で負けて戻った表・0.25 秒（相手の線が白く準々決勝の節へ伸びる途中、主人公の名が沈み、主人公の道は半分の濃さの金になる）' },
  { offset: 1000, file: 'watch-1000', note: '見届け・1.0 秒（一回戦の残りが上から速く明らかになる）' },
  { offset: 2000, file: 'watch-2000', note: '見届け・2.0 秒（短い間を置いて準々決勝）' },
  { offset: 2700, file: 'watch-2700', note: '見届け・2.7 秒（準決勝）' },
  { offset: 3300, file: 'watch-3300', note: '見届け・3.3 秒（決勝が明らかになり、頂の星が灯って優勝者の道が金で通る）' },
  { offset: 3600, file: 'watch-3600', note: '見届け・3.6 秒（表が沈み、結果の段が立つ途中）' }
];
const CHAMPION_SHOTS = [
  { offset: 200, file: 'champion-0200', note: '決勝に勝って戻った表・0.2 秒（頂の星が灯り、主人公の道が強い金になり、名の後ろの板がいちばん強い）' },
  { offset: 300, file: 'champion-0300', note: '同・0.3 秒（頂が灯る瞬間・構成案の solo-2b-crown と同じ時刻）' },
  { offset: 550, file: 'champion-0550', note: '同・0.55 秒（表が沈み、結果の段が立つ途中）' }
];
const PAIR_ADVANCE_SHOTS = [
  { offset: 200, file: 'pair-advance-r1-0200', note: '二人の表・一回戦に勝って戻った明かし・0.2 秒（二人の金の線が伸びる途中・板がいちばん強い）' },
  { offset: 900, file: 'pair-advance-r1-0900', note: '同・0.9 秒（構成案の pair-2-reveal と同じ時刻: 自分の線が準々決勝の節へ届き、ほかの組が明かされる途中）' }
];
const PAIR_CHAMPION_SHOTS = [
  { offset: 300, file: 'pair-champion-0300', note: '二人の表・決勝に勝って戻った頂が灯る瞬間（0.3 秒・構成案の pair-3b-crown と同じ時刻）' },
  { offset: 550, file: 'pair-champion-0550', note: '同・0.55 秒（表が沈み、結果の段が立つ途中）' }
];
const PAIR_ELIMINATED_SHOTS = [
  { offset: 250, file: 'pair-eliminated-0250', note: '二人の表・負けて戻った表・0.25 秒（相手の線が伸びる途中、二人の名が沈む）' },
  { offset: 1000, file: 'pair-watch-1000', note: '二人の表・見届け・1.0 秒' },
  { offset: 2000, file: 'pair-watch-2000', note: '二人の表・見届け・2.0 秒' }
];
const asReveal = (shots) => ({ offsets: shots.map((s) => s.offset), shots });

// 光の瞬間（表の明かしが始まった時を 0 とした ms）。一回戦に勝って戻ると、主人公の組を 0 から 400ms（ARENA_REVEAL_LEAD_MS）で明かし、
// 主人公の名の後ろの金の楕円の板（arena-reveal-plate・step = 400ms）が 0 から灯る。板は opacity が 0 → 1（50%）→ 0 と動くので、
// いちばん強いのは板の 200ms 目、灯る途中は 100ms 目。決勝に勝って戻ると、優勝者の名の板（step 400ms）が 0 から灯るので、いちばん強い
// のは 200。止めた後、板の動きをその ms へ合わせる。
const GLOW_CROP = { width: 440, height: 240 };
const GLOW_ADVANCE_SHOTS = [
  { offset: 100, seek: { name: 'arena-reveal-plate', ms: 100 }, file: 'glow-player-mid', note: '一回戦に勝って戻った表・100ms（主人公の名の後ろの金の楕円が灯る途中）' },
  { offset: 200, seek: { name: 'arena-reveal-plate', ms: 200 }, file: 'glow-player-peak', note: '同・200ms（主人公の名の後ろの金の楕円がいちばん強い）' }
];
const PAIR_WIN_SHOTS = [
  { offset: 200, seek: { name: 'arena-reveal-plate', ms: 200 }, file: 'pair-win-r1-0200', note: '二人の表・一回戦に勝って戻った明かし・200ms（二人の名の後ろの金の楕円がいちばん強い）' },
  { offset: 600, file: 'pair-win-r1-0600', note: '同・600ms（次の相手を決める隣の組の勝者の線が伸びる途中）' },
  { offset: 1100, file: 'pair-win-r1-1100', note: '同・1.1 秒（ほかの組が上から順に明らかになる途中）' }
];
const GLOW_CHAMPION_SHOTS = [
  { offset: 200, seek: { name: 'arena-reveal-plate', ms: 200 }, file: 'glow-champion-peak', note: '決勝に勝って戻った表・200ms（優勝者の名の後ろの金の楕円がいちばん強い）' }
];

// 表の名の札ごとの箱（字の並びの外接）と、計算済みの字の色・影・不透明度と、名の後ろの板の不透明度。合わせた動きの持ち主（板）を
// 持つ名の札が target。
const GLOW_NAMES = `[...document.querySelectorAll('#arena-bracket-ring .arena-ring-name')].map((n) => {
  const lines = [...n.querySelectorAll('.arena-ring-name-line')];
  const rects = lines.flatMap((line) => { const range = document.createRange(); range.selectNodeContents(line); return [...range.getClientRects()]; }).filter((r) => r.width > 0 && r.height > 0);
  const left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right)), bottom = Math.max(...rects.map((r) => r.bottom));
  const cs = getComputedStyle(n);
  return { text: lines.map((line) => line.textContent).join('・'), target: !!n.querySelector('[data-af-target]'), player: n.classList.contains('arena-ring-name--hero'),
    state: [...n.classList].filter((c) => c !== 'arena-ring-name').map((c) => c.replace('arena-ring-name--', '')).join(' '),
    box: { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) },
    computed: { opacity: cs.opacity, color: cs.color, text_shadow: cs.textShadow, plate_opacity: getComputedStyle(n.querySelector('.arena-ring-plate')).opacity } };
})`;

// CDP の png（8bit・RGB か RGBA・interlace なし）を RGBA の画素へ戻す。
function decodePng(bytes) {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const [depth, colorType, , , interlace] = bytes.subarray(24, 29);
  if (depth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error(`png: depth ${depth} colorType ${colorType} interlace ${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const idat = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] += a;
      else if (filter === 2) line[i] += b;
      else if (filter === 3) line[i] += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); line[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new Error(`png: filter ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      for (let k = 0; k < 3; k += 1) out[(y * width + x) * 4 + k] = line[x * channels + k];
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, pixels: out };
}

// 名の箱の中の明るい方から 15% の画素の平均を字の色とする。光の色は名の周りの二つの帯で測る: 箱を 1px 広げた外から 6px 広げた内まで
// （近い帯・名の字の影が落ちる所）と、6px の外から 16px 広げた内まで（広い帯・名の後ろの楕円の板が名の外へ広がる所）。それぞれ平均と
// 明るい方から 10% の平均。光が無ければ下地の暗さになる。
function glowStats(image, box) {
  const pick = (x, y) => { const at = (y * image.width + x) * 4; return [image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]]; };
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mean = (list) => [0, 1, 2].map((k) => Math.round(list.reduce((n, p) => n + p[k], 0) / list.length));
  const brightest = (list, share) => mean([...list].sort((p, q) => luma(q) - luma(p)).slice(0, Math.max(1, Math.round(list.length * share))));
  const inside = (x, y, grow) => x >= box.x - grow && x < box.x + box.w + grow && y >= box.y - grow && y < box.y + box.h + grow;
  const glyph = [];
  const ring = [];
  const wide = [];
  for (let y = Math.max(0, box.y - 16); y < Math.min(image.height, box.y + box.h + 16); y += 1) {
    for (let x = Math.max(0, box.x - 16); x < Math.min(image.width, box.x + box.w + 16); x += 1) {
      if (inside(x, y, 0)) glyph.push(pick(x, y));
      else if (inside(x, y, 6)) { if (!inside(x, y, 1)) ring.push(pick(x, y)); }
      else wide.push(pick(x, y));
    }
  }
  return { text_rgb: brightest(glyph, 0.15), glow_ring_mean_rgb: mean(ring), glow_ring_bright_rgb: brightest(ring, 0.1),
    glow_wide_mean_rgb: mean(wide), glow_wide_bright_rgb: brightest(wide, 0.1) };
}

// 止めた瞬間を合わせて撮る（窓ごとに）: 全面一枚、合わせた名を中ほどにした拡大しない切り出し一枚（全面と同じ一枚から切る）、名ごとの測り。
async function shootGlow(ctx, shot) {
  const { page } = ctx;
  const seek = await page.js(`window.__af.seek(${JSON.stringify(shot.seek.name)}, ${shot.seek.ms})`);
  if (await page.js("document.querySelector('#arena-bracket').classList.contains('arena-bracket--sinking')")) throw new Error(`${shot.file}: the bracket already sinks`);
  await shoot(ctx, shot.file, shot.note, { at: await page.js('window.__af.frozen'), ...(await page.js(FROZEN_STATE)), seek }, async (size, bytes, name) => {
    const names = await page.js(GLOW_NAMES);
    const targets = names.filter((n) => n.target);
    if (targets.length !== 1) throw new Error(`${name}: ${targets.length} target names`);
    const [target] = targets;
    const crop = {
      x: Math.min(Math.max(0, Math.round(target.box.x + target.box.w / 2 - GLOW_CROP.width / 2)), size.width - GLOW_CROP.width),
      y: Math.min(Math.max(0, Math.round(target.box.y + target.box.h / 2 - GLOW_CROP.height / 2)), size.height - GLOW_CROP.height),
      width: GLOW_CROP.width, height: GLOW_CROP.height
    };
    const cropName = name.replace(/\.png$/, '-crop.png');
    const cropFile = path.join(ctx.options.out, cropName);
    if (await fs.stat(cropFile).then(() => true, () => false)) throw new Error(`refusing to overwrite ${cropFile}`);
    const cropped = nativeImage.createFromBuffer(bytes).crop(crop);
    const cropSize = cropped.getSize();
    if (cropSize.width !== crop.width || cropSize.height !== crop.height) throw new Error(`${cropName} is ${cropSize.width}x${cropSize.height}`);
    await fs.writeFile(cropFile, cropped.toPNG());
    const image = decodePng(bytes);
    // 測る名は、切り出しと同じ高さの帯にある名（円の反対側の名も、周りの名として並べる）。
    const within = (n) => n.box.y + n.box.h / 2 >= crop.y && n.box.y + n.box.h / 2 < crop.y + crop.height;
    const measured = names.filter(within).map((n) => ({ ...n, ...glowStats(image, n.box) }));
    const line = { file: name, crop_file: cropName, seek, crop, names: measured };
    ctx.glow.push(line);
    console.log(`GLOW ${JSON.stringify(line)}`);
    return { crop_file: cropName };
  });
}

async function playToEnd(ctx, plan) {
  const matches = [];
  for (let r = 0; r < 4; r += 1) {
    const options = plan(r);
    const record = await playMatch(ctx, options);
    matches.push(record);
    if (options.after) await options.after(record);
    if (!record.won) break;
  }
  return matches;
}

const SCENES = {
  async champion(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    await enter(ctx, 'solo');
    await shootSettled(ctx, 'bracket-before', '表（主人公の第一試合の前・構成案の solo-1-entrance と同じ瞬間）', FIGHT_READY);
    await clickRingName(ctx);
    ctx.notes.matches = await playToEnd(ctx, (r) => {
      if (r === 0) return { hud: true, reveal: asReveal(ADVANCE_SHOTS), after: () => shootSettled(ctx, 'advance-r1-end', '一回戦に勝って戻った表・明かし終わり（試合を始める紋）', FIGHT_READY) };
      if (r === 1) return { fold: true, after: () => shootSettled(ctx, 'advance-r2-folded', '準々決勝に勝って戻った表・明かしを押して畳んだ後', FIGHT_READY) };
      if (r === 2) return { after: () => shootSettled(ctx, 'advance-r3-end', '準決勝に勝って戻った表・明かし終わり', FIGHT_READY) };
      return { reveal: asReveal(CHAMPION_SHOTS) };
    });
    if (!ctx.notes.matches.every((m) => m.won)) throw new Error('the strong protagonist did not win every match');
    await shootSettled(ctx, 'result-champion', '結果の段（優勝・構成案の solo-2-end と同じ瞬間）', RESULT_READY);
    ctx.notes.flavor = await page.js(FLAVOR_BOX);
    console.log(`FLAVOR ${JSON.stringify(ctx.notes.flavor)}`);
  },
  async eliminated(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    await enter(ctx, 'solo');
    await page.waitFor(`${settled(ARENA)} && ${FIGHT_READY}`, 'the bracket settled');
    await sleep(SETTLE_MS);
    const record = await playMatch(ctx, { reveal: asReveal(ELIMINATED_SHOTS) });
    ctx.notes.matches = [record];
    if (record.won) throw new Error('the default protagonist won round 1; the scene needs a loss');
    await page.waitFor(`${settled(ARENA)} && ${RESULT_READY}`, 'the result flavor', LM_WAIT_MS);
    await sleep(5000);
    await shootSettled(ctx, 'result-eliminated', '結果の段（一回戦で敗退・実況一文が出て 5 秒後）', RESULT_READY);
    ctx.notes.flavor = await page.js(FLAVOR_BOX);
    console.log(`FLAVOR ${JSON.stringify(ctx.notes.flavor)}`);
  },
  async pair(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    const modes = await page.js("[...document.querySelectorAll('#arena-selection-modes .arena-floor-spot')].map((b) => ({ mode: b.dataset.mode, disabled: b.disabled }))");
    console.log(`MODES ${JSON.stringify(modes)}`);
    await enter(ctx, 'pair');
    await shootSettled(ctx, 'pair-bracket-before', '二人の表（第一試合の前）', FIGHT_READY);
    let n = 0;
    ctx.notes.matches = await playToEnd(ctx, (r) => ({
      reveal: r === 0 ? asReveal([{ offset: 1000, file: 'pair-reveal-1000', note: '二人の表・一試合目の後の明かし（勝ち上がりか見届け）の 1.0 秒' }]) : null,
      after: async (record) => {
        n += 1;
        if (record.won && !(await page.js(ARENA_STAGE('result')))) await shootSettled(ctx, `pair-advance-r${n}-end`, `二人の表・${n} 試合目に勝って戻った明かし終わり`, FIGHT_READY);
      }
    }));
    await shootSettled(ctx, 'pair-result', '二人の結果の段', RESULT_READY);
    ctx.notes.flavor = await page.js(FLAVOR_BOX);
    console.log(`FLAVOR ${JSON.stringify(ctx.notes.flavor)}`);
  },
  async 'pair-champion'(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    await enter(ctx, 'pair');
    await shootSettled(ctx, 'pair-champion-bracket-before', '二人の表（第一試合の前・構成案の pair-1-entrance と同じ瞬間）', FIGHT_READY);
    ctx.notes.matches = await playToEnd(ctx, (r) => {
      if (r === 0) return { reveal: asReveal(PAIR_ADVANCE_SHOTS), after: async (record) => { if (record.won) await shootSettled(ctx, 'pair-advance-r1-end', '二人の表・一回戦に勝って戻った明かし終わり（試合を始める紋）', FIGHT_READY); } };
      if (r === 3) return { reveal: asReveal(PAIR_CHAMPION_SHOTS) };
      return {};
    });
    if (!ctx.notes.matches.every((m) => m.won)) throw new Error('the strong pair did not win every match');
    await shootSettled(ctx, 'pair-result-champion', '二人の結果の段（優勝・構成案の pair-3-end と同じ瞬間）', RESULT_READY);
    ctx.notes.flavor = await page.js(FLAVOR_BOX);
  },
  async 'pair-eliminated'(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    await enter(ctx, 'pair');
    await shootSettled(ctx, 'pair-eliminated-bracket-before', '二人の表（主人公の能力値 0・第一試合の前）', FIGHT_READY);
    const record = await playMatch(ctx, { reveal: asReveal(PAIR_ELIMINATED_SHOTS) });
    ctx.notes.matches = [record];
    if (record.won) throw new Error('the weak pair won round 1; the scene needs a loss');
    await page.waitFor(`${settled(ARENA)} && ${RESULT_READY}`, 'the pair result flavor', LM_WAIT_MS);
    await shootSettled(ctx, 'pair-result-eliminated', '二人の結果の段（一回戦で敗退）', RESULT_READY);
  },
  async glow(ctx) {
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    await enter(ctx, 'solo');
    await ctx.page.waitFor(`${settled(ARENA)} && ${FIGHT_READY}`, 'the bracket settled');
    await sleep(SETTLE_MS);
    ctx.notes.matches = await playToEnd(ctx, (r) => {
      if (r === 0) return { reveal: asReveal(GLOW_ADVANCE_SHOTS) };
      if (r === 3) return { reveal: asReveal(GLOW_CHAMPION_SHOTS) };
      return {};
    });
    if (!ctx.notes.matches.every((m) => m.won)) throw new Error('the strong protagonist did not win every match');
  },
  async 'pair-win'(ctx) {
    await walkToHub(ctx);
    await sendOffToArena(ctx);
    await enter(ctx, 'pair');
    await shootSettled(ctx, 'pair-win-bracket-before', '二人の表（第一試合の前）', FIGHT_READY);
    const record = await playMatch(ctx, { reveal: asReveal(PAIR_WIN_SHOTS) });
    ctx.notes.matches = [record];
    if (!record.won) throw new Error('the strong pair lost round 1');
    await shootSettled(ctx, 'pair-win-r1-end', '二人の表・一回戦に勝って戻った明かし終わり（試合を始める紋）', FIGHT_READY);
  },
  async 'timing-champion'(ctx) { await timingRun(ctx, { fold: false }); },
  async 'timing-eliminated'(ctx) { await timingRun(ctx, { fold: false }); },
  async 'timing-fold'(ctx) { await timingRun(ctx, { fold: true }); }
};

// 壁時計: 一人の立ち位置を押してから結果の段が立つまで。表で試合を始める紋が出たらすぐ押す。凍らせない。
async function timingRun(ctx, { fold }) {
  const { page } = ctx;
  await walkToHub(ctx);
  await sendOffToArena(ctx);
  await sleep(SETTLE_MS);
  const entry = await enter(ctx, 'solo');
  const matches = await playToEnd(ctx, () => ({ fold }));
  await page.waitFor(RESULT_UP, 'the result stage', LM_WAIT_MS);
  const resultAt = Date.now();
  ctx.notes.timing = {
    fold,
    ms_solo_to_bracket: entry.ms_enter_to_bracket,
    matches,
    ms_solo_to_result: resultAt - entry.clickAt,
    ms_reveals_sum: matches.reduce((n, m) => n + m.ms_bracket_to_ready, 0)
  };
  console.log(`TIMING ${JSON.stringify(ctx.notes.timing)}`);
}

async function runScene(options, name, roster) {
  const power = ['champion', 'glow', 'pair-win', 'pair-champion', 'timing-champion', 'timing-fold'].includes(name) ? 'max' : name === 'pair-eliminated' ? 'min' : 'default';
  const product = await startProduct(options.repoRoot, { power, buddy: ['pair', 'pair-win', 'pair-champion', 'pair-eliminated'].includes(name) ? BUDDY_ID : null });
  const guard = () => { if (product.lmFailures.length) throw new Error(`fixture LM 500: ${product.lmFailures.join(' | ')}`); };
  const page = await openPage(guard);
  const ctx = { options, product, page, roster, shots: [], checks: [], glow: [], notes: { power } };
  const started = Date.now();
  try {
    await SCENES[name](ctx);
    guard();
    if (page.pageErrors.length) throw new Error(`renderer errors: ${page.pageErrors.join(' | ')}`);
    return { scene: name, seconds: (Date.now() - started) / 1000, notes: ctx.notes, shots: ctx.shots, checks: ctx.checks, glow: ctx.glow, lmKinds: [...new Set(product.lmKinds)] };
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
