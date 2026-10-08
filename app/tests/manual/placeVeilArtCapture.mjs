// 待ちの層（#place-veil）と行き先の画面のあいだの移り（層が上がる瞬間・層が薄れて画面が現れる瞬間）を、製品の通常の道で 1440x900 の
// コマ（200 ms ごと）に撮り、層の地の絵と画面の地の絵の計算済みの大きさ・位置（px）を並べる手回しの道具（*.test.mjs ではないので
// npm test は拾わない）:
//
//   <electron> app/tests/manual/placeVeilArtCapture.mjs --repo-root <絶対パス> --out <絶対パス> --variant <before|after> --scenes <名,名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・app/public・data・
// content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人 fallen_star）の上で、この process の中に起こす。
// LM は固定応答（FIXTURE の表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。--variant は撮った木の名札（before = 直す
// 前・after = 直した後）で、manifest とコマの名に写るだけ（木は --repo-root が決める）。--out は無いか空であること。
//
// 場面ごとに、移りの始めから終わりまでを FILM_FRAME_MS ごとの JPEG（<場面>-film-NN.jpg）に撮り、各コマの層の段・見えている画面と、
// 地の絵の置き方（層の地の絵と、出ている画面の中で同じ絵を敷いている要素の、計算済みの大きさ・位置）を <out>/manifest.json に書く。
// 地の絵の置き方は、層と画面の両方が出ている最初のコマ（移りの瞬間）と、着いて落ち着いた姿で測り、標準出力にも表で出す。
// 場面（scene）:
//   lounge-enter   露台 → 談話室（送り出しの幕 → 層 → 談話室の画面の上で入りを待つ → 最初の言葉で層が薄れる）。
//   lounge-exit    談話室で「出る」を押す（談話室の画面 → 談話室の絵の層 → 露台）。
//   academy-map    露台 → 学院マップ（送り出しの幕 → 層 → 学院マップ）。
//   conversation-end 依頼の会話を「会話を終える」で閉じる（昼の会話の画面 → 依頼の絵の層 → 露台）。
//   errand / auction / dungeon  露台 → 依頼・競売場・実践の入口（実践は絵の無い幕が地）。
//   arena-exit / auction-exit / concert-hall-exit  会場の出る紋を押す（会場の画面 → 会場の絵の層 → 露台）。闘技会と競売場の出る紋は
//                  催しの終わりにだけ出るので、撮影の中だけで紋の hidden を外して押す（押したあとの道は製品のまま）。
//   load / new-game  タイトル → ロード（足跡）・新しいゲーム → 露台（星の道の層。待ちの層は使わない）。
//   undeclared     依頼の画面の置き方の宣言を撮影の中だけで外してから依頼へ送り出し、層を上げるところで投げられた誤りを記録する。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const SCENE_LIMIT_MS = 300000;
// コマの間。コマは書き出しの速い JPEG で撮る（1440x900 の PNG は一枚 300ms を超える）。
const FILM_FRAME_MS = 200;
const FILM_JPEG_QUALITY = 80;
const FILM_MAX_FRAMES = 240;
// 要求を止めたまま連なりを流す長さ。
const HELD_FILM_MS = 1200;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--variant', '--scenes'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  const variant = parsed['--variant'];
  if (variant !== 'after' && variant !== 'before') throw new Error(`--variant must be after or before, got ${JSON.stringify(variant)}`);
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) {
    if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  }
  for (const key of ['--repo-root', '--out']) {
    if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], variant, scenes };
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
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false'],
  ['のタイトルと本文を平文で出力する', 'タイトル: 談話室の午後\n本文: 談話室で主人公と言葉を交わした。'],
  ['memory_recordの本文だけ', '談話室で主人公と穏やかに話した。']
];
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'place-veil-art-capture-'));
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
  window.__pageErrors = [];
  window.addEventListener('error', (event) => window.__pageErrors.push(String(event.error?.message ?? event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason?.message ?? event.reason)));
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

// 地の絵の置き方: 層の地の絵（.place-veil-art）と、出ている画面（.screen.active）の中で同じ絵を敷いている要素（背景の層・::before／
// ::after の背景・img）の、絵が実際に描かれる矩形（px・窓の座標）。背景の層は、置き場（padding box）と計算済みの background-size・
// background-position と絵の素の大きさから求める。読めない値の形に出会ったら投げる（測れない行を黙って落とさない）。
const ART_PROBE = `(async () => {
  window.__artSizes ??= new Map();
  const naturalSize = async (url) => {
    if (!window.__artSizes.has(url)) {
      const img = new Image();
      img.src = url;
      await img.decode();
      window.__artSizes.set(url, { w: img.naturalWidth, h: img.naturalHeight });
    }
    return window.__artSizes.get(url);
  };
  const split = (value, separator) => {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of value) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === separator && depth === 0) {
        if (current.trim()) out.push(current.trim());
        current = '';
      } else current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };
  // 一つの長さ: { pct, px }（px・%・calc(a% + bpx) の形だけ）。
  const term = (token) => {
    const m = token.match(/^(-?[\\d.]+(?:e[+-]?\\d+)?)(px|%)$/);
    if (!m) throw new Error('art probe: unreadable length ' + token);
    return m[2] === '%' ? { pct: Number(m[1]), px: 0 } : { pct: 0, px: Number(m[1]) };
  };
  const length = (token) => {
    if (!token.startsWith('calc(')) return term(token);
    const inner = token.slice(5, -1).replace(/ - /g, ' + -').split(' + ');
    return inner.map((part) => term(part.trim())).reduce((a, b) => ({ pct: a.pct + b.pct, px: a.px + b.px }), { pct: 0, px: 0 });
  };
  const urlOf = (layer) => (layer.match(/url\\("?([^")]+)"?\\)/) ?? [])[1] ?? null;
  const same = (a, b) => a && b && new URL(a, location.href).pathname === new URL(b, location.href).pathname;
  const round = (n) => Math.round(n * 10) / 10;
  const layerRect = async (area, style, index, url) => {
    const sizes = split(style.backgroundSize, ',');
    const positions = split(style.backgroundPosition, ',');
    const size = sizes[index % sizes.length];
    const position = positions[index % positions.length];
    const natural = await naturalSize(url);
    let w;
    let h;
    if (size === 'cover' || size === 'contain') {
      const scale = (size === 'cover' ? Math.max : Math.min)(area.w / natural.w, area.h / natural.h);
      w = natural.w * scale;
      h = natural.h * scale;
    } else {
      const [sw, sh = 'auto'] = split(size, ' ');
      const resolve = (token, base) => (token === 'auto' ? null : ((v) => (base * v.pct) / 100 + v.px)(length(token)));
      w = resolve(sw, area.w);
      h = resolve(sh, area.h);
      if (w === null && h === null) { w = natural.w; h = natural.h; }
      else if (w === null) w = (h * natural.w) / natural.h;
      else if (h === null) h = (w * natural.h) / natural.w;
    }
    const [px, py] = split(position, ' ').map(length);
    const x = area.x + ((area.w - w) * px.pct) / 100 + px.px;
    const y = area.y + ((area.h - h) * py.pct) / 100 + py.px;
    return { x: round(x), y: round(y), w: round(w), h: round(h), size, position };
  };
  const paddingBox = (rect, style) => {
    const bl = parseFloat(style.borderLeftWidth); const bt = parseFloat(style.borderTopWidth);
    return { x: rect.left + bl, y: rect.top + bt, w: rect.width - bl - parseFloat(style.borderRightWidth), h: rect.height - bt - parseFloat(style.borderBottomWidth) };
  };
  const describe = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const backgroundsOf = async (el, pseudo, art) => {
    const style = getComputedStyle(el, pseudo);
    if (style.display === 'none' || style.backgroundImage === 'none' || (pseudo && style.content === 'none')) return [];
    let area;
    if (pseudo) {
      const host = el.getBoundingClientRect();
      area = { x: host.left + parseFloat(style.left), y: host.top + parseFloat(style.top), w: parseFloat(style.width), h: parseFloat(style.height) };
    } else {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return [];
      area = paddingBox(rect, style);
    }
    const out = [];
    const layers = split(style.backgroundImage, ',');
    const attachments = split(style.backgroundAttachment, ',');
    for (let index = 0; index < layers.length; index += 1) {
      const url = urlOf(layers[index]);
      if (!same(url, art)) continue;
      // background-attachment: fixed の層の置き場は窓そのもの（要素はその絵を切り抜くだけ）。
      const fixed = attachments[index % attachments.length] === 'fixed';
      const layerArea = fixed ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : area;
      out.push({ element: describe(el) + (pseudo ?? ''), layer: index, attachment: fixed ? 'fixed' : 'scroll', filter: style.filter, ...(await layerRect(layerArea, style, index, url)) });
    }
    return out;
  };
  const veil = document.querySelector('#place-veil');
  const veilUp = veil && !veil.hidden && veil.dataset.veilGround === 'art';
  const art = veilUp ? urlOf(getComputedStyle(veil.querySelector('.place-veil-art')).backgroundImage) : (window.__lastVeilArt ?? null);
  if (!art) return null;
  window.__lastVeilArt = art;
  const veilRows = veilUp ? await backgroundsOf(veil.querySelector('.place-veil-art'), null, art) : [];
  const screenRows = [];
  for (const screen of document.querySelectorAll('.screen.active')) {
    for (const el of [screen, ...screen.querySelectorAll('*')]) {
      screenRows.push(...(await backgroundsOf(el, null, art)), ...(await backgroundsOf(el, '::before', art)), ...(await backgroundsOf(el, '::after', art)));
      if (el.tagName === 'IMG' && same(el.currentSrc || el.src, art)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) screenRows.push({ element: describe(el), layer: 'img', objectFit: getComputedStyle(el).objectFit, x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) });
      }
    }
  }
  return { art: new URL(art, location.href).pathname, screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id), veilStep: veilUp ? veil.dataset.veil : null, veil: veilRows, screen: screenRows };
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
  // 投げられた誤り（捕まえられたものも）: catchThrown() のあとだけ、例外で止まるたびに記録してすぐ再開する。
  const thrown = [];
  cdp.on('message', (event, method, params) => {
    if (method !== 'Debugger.paused') return;
    if (params.reason === 'exception' || params.reason === 'promiseRejection') {
      thrown.push({ description: params.data?.description ?? null, stack: params.callFrames.slice(0, 8).map((frame) => `${frame.functionName || '(anonymous)'}:${frame.location.lineNumber + 1}`) });
    }
    send('Debugger.resume').catch(() => {});
  });
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
    thrown,
    async catchThrown() {
      await send('Debugger.enable');
      await send('Debugger.setPauseOnExceptions', { state: 'all' });
    },
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

// コマの連なり: 移りの始めから、層が下りて画面が出揃うまで FILM_FRAME_MS ごとに JPEG を一枚ずつ撮り続ける。撮影は窓の一つの口だけが
// 行うので、待っている姿の png もこの連なりの合間に撮る（still）。層の絵と、絵の無い画面以外の画面が両方出ているコマでは地の絵の置き方を
// 測り、最初と最後の一回を残す。
function startFilm(ctx, prefix) {
  const { page } = ctx;
  const frames = [];
  const placement = { first: null, last: null };
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
      const frame = { file, ms: Date.now() - started, veil: state.veil, curtain: state.curtain, screens: state.screens };
      if (state.veil?.ground === 'art' && state.screens.some((id) => id !== 'routing-hub-screen')) {
        const measured = await page.js(ART_PROBE);
        frame.placement = measured;
        placement.first ??= { file, ...measured };
        placement.last = { file, ...measured };
      }
      frames.push(frame);
    }
    if (!stopping) throw new Error(`${prefix}: the film reached ${FILM_MAX_FRAMES} frames before the arrival`);
  })();
  done.catch(() => {});
  return {
    still(file, note) {
      if (pendingStill) throw new Error(`${prefix}: a still is already pending`);
      return new Promise((resolve, reject) => { pendingStill = { file, note, resolve, reject }; });
    },
    // 層が下りて画面が出揃ったあと、一拍撮ってから止める。
    async stop() {
      await page.waitFor(`!${VEIL_UP}`, `${prefix}: the wait gone`, LM_WAIT_MS);
      await sleep(FILM_FRAME_MS * 2);
      stopping = true;
      await done;
      ctx.shots.push({ sequence: `${prefix}-film`, frames });
      ctx.placements.push({ sequence: `${prefix}-film`, moment: 'transition-first', ...placement.first });
      ctx.placements.push({ sequence: `${prefix}-film`, moment: 'transition-last', ...placement.last });
      console.log(`${prefix}: ${frames.length} frames over ${frames.at(-1).ms} ms (${prefix}-film-00.jpg .. ${frames.at(-1).file}); veil steps ${frames.map((f) => f.veil?.step ?? '-').join(' ')}`);
      if (frames.length < 5) throw new Error(`${prefix}: only ${frames.length} frames over the transition`);
      return frames;
    }
  };
}

// 止めた要求の間に一枚: 覆いが上がるのを待ってから、連なりの合間に撮り、止めたままもう少し連なりを流してから返す。
async function shootHeld(ctx, held, film, file, note) {
  await held.paused;
  await ctx.page.waitFor(COVER_UP, `${file}: the cover`, 30000);
  await sleep(900);
  const state = await film.still(file, note);
  await sleep(HELD_FILM_MS);
  return state;
}

// 露台で行き先を言い、送り出しの幕が出たところから連なりを撮り始める。
async function sendOff(ctx, id) {
  const { page } = ctx;
  await sayOnHub(ctx, ctx.product.hubLines[id]);
  await page.waitFor("!document.querySelector('#terrace-opened').hidden", `${id}: the send-off curtain`, LM_WAIT_MS);
  ctx.steps.push(`send-off to ${id}: the curtain is up`);
  return startFilm(ctx, id);
}

// 送り出しのあとの厳しい refresh（GET /api/field）を、覆いが上がっている間だけ止める。
const holdDispatchField = (page) => page.hold('/api/field', { method: 'GET', decide: holdUnderCover(page) });

// 着いて落ち着いた姿を撮り、地の絵の置き方（画面の側）を測る。
async function shootArrived(ctx, screenId, file, note, { settled = true } = {}) {
  await ctx.page.waitFor(settled ? screenSettled(screenId) : `document.querySelector('#${screenId}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`, `${screenId} arrived`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
  const state = await ctx.shoot(file, note);
  const measured = await ctx.page.js(ART_PROBE);
  if (measured) ctx.placements.push({ sequence: file, moment: 'arrived', file: `${file}.png`, ...measured });
  return state;
}

async function dispatchTo(ctx, id, screenId) {
  await walkToHub(ctx);
  await sayOnHub(ctx, ctx.product.hubLines[id]);
  await ctx.page.waitFor(screenSettled(screenId), `${screenId} settled`, LM_WAIT_MS);
  await sleep(SETTLE_MS);
  ctx.steps.push(`dispatched to ${id}`);
}

const LOUNGE_ACTIVE = `(document.querySelector('#academy-lounge-screen.active') && !${VEIL_UP} && !${LOADING_ACTIVE})`;
const LOUNGE_PLAYER_TURN = `(${LOUNGE_ACTIVE} && !document.querySelector('#academy-lounge-input').disabled && !document.querySelector('#academy-lounge-end').disabled)`;

// 宣言を外した画面へ送り出したときに、製品が投げた誤り（捕まえられて露台の立て直しへ回るので、頁の error にも console にも出ない）を、
// 例外で止まる記録から待つ。
async function awaitThrown(ctx, fragment) {
  const end = Date.now() + LM_WAIT_MS;
  while (Date.now() < end) {
    const thrown = ctx.page.thrown.filter((entry) => (entry.description ?? '').includes(fragment));
    if (thrown.length > 0) return thrown;
    await sleep(100);
  }
  throw new Error(`no error mentioning ${JSON.stringify(fragment)} was thrown`);
}

// 戻り道の押下: 押した直後に層が上がらなければ（手番の直後で製品がまだ押下を受けない間）、一拍おいて押し直す。
async function pressUntilVeil(ctx, selector, label) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await ctx.page.click(`document.querySelector(${JSON.stringify(selector)})`, label);
    await sleep(400);
    if (await ctx.page.js(VEIL_UP)) {
      ctx.steps.push(`press ${label}; taken on press ${attempt}`);
      return;
    }
    const toast = await ctx.page.js("Boolean(document.querySelector('#conversation-processing-toast.visible'))");
    console.log(`press ${label}: press ${attempt} not taken (processing toast ${toast})`);
    await sleep(1600);
  }
  throw new Error(`${label} was not taken after 20 presses`);
}

// ほかの行き先（着いた画面が自分の入りを待たない道）: 送り出し → 層 → 行き先の画面。着く瞬間のコマと地の絵の置き方を残す。
const PLAIN_DESTINATIONS = {
  training: 'academy-training-screen',
  study_circle: 'academy-study-circle-screen',
  alchemy: 'academy-alchemy-screen',
  workshop: 'academy-workshop-screen',
  library: 'academy-library-screen',
  arena: 'academy-arena-screen',
  concert_hall: 'academy-concert-hall-screen'
};
function plainDestinationScene(id, screenId) {
  return async (ctx) => {
    await walkToHub(ctx);
    const film = await sendOff(ctx, id);
    await ctx.page.waitFor(`document.querySelector('#${screenId}.active') && !${VEIL_WAITING}`, `${screenId} shown`, LM_WAIT_MS);
    await film.stop();
    await shootArrived(ctx, screenId, `${id}-arrived`, `${id} の画面に着いた姿`, { settled: false });
  };
}

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
const SCENES = {
  async 'lounge-enter'(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'lounge');
    await shootHeld(ctx, field, film, 'lounge-enter-wait-a', '談話室へ: 送り出しのあとの GET /api/field を止めている間（幕と同じ絵の層）');
    const enter = await page.hold('/api/lounge/enter', { method: 'POST' });
    await field.release();
    await shootHeld(ctx, enter, film, 'lounge-enter-wait-b', '談話室へ: POST /api/lounge/enter を止めている間（層の下に談話室の画面）');
    await enter.release();
    await page.waitFor(`document.querySelector('#academy-lounge-screen.active') && !${LOADING_ACTIVE} && !${VEIL_WAITING}`, 'the lounge talk started', LM_WAIT_MS);
    await film.stop();
    await shootArrived(ctx, 'academy-lounge-screen', 'lounge-enter-arrived', '談話室の画面に着いた姿', { settled: false });
  },
  async 'lounge-exit'(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await sayOnHub(ctx, ctx.product.hubLines.lounge);
    await page.waitFor(LOUNGE_PLAYER_TURN, 'the first player turn in the lounge', LM_WAIT_MS);
    await page.waitFor(`${LOUNGE_PLAYER_TURN} && ${motionSettled('#academy-lounge-screen')}`, 'the lounge settled', 30000);
    await sleep(SETTLE_MS);
    const measured = await page.js(`(window.__lastVeilArt = '/canonical/lounge/stage.jpg', ${ART_PROBE})`);
    ctx.placements.push({ sequence: 'lounge-exit', moment: 'before-press', ...measured });
    const end = await page.hold('/api/lounge/end', { method: 'POST' });
    const film = startFilm(ctx, 'lounge-exit');
    await sleep(FILM_FRAME_MS * 3);
    await pressUntilVeil(ctx, '#academy-lounge-end', '出る (POST /api/lounge/end held)');
    await shootHeld(ctx, end, film, 'lounge-exit-wait', '談話室を出る: POST /api/lounge/end を止めている間（談話室の絵の層）');
    await end.release();
    await page.waitFor(HUB_READY, 'back on the terrace', LM_WAIT_MS);
    await film.stop();
  },
  async 'academy-map'(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'academy-map');
    await shootHeld(ctx, field, film, 'academy-map-wait', '学院マップへ: 送り出しのあとの GET /api/field を止めている間');
    await field.release();
    await page.waitFor(`document.querySelector('#academy-map-screen.active') && !${VEIL_WAITING}`, 'academy map screen', LM_WAIT_MS);
    await film.stop();
    await shootArrived(ctx, 'academy-map-screen', 'academy-map-arrived', '学院マップに着いた姿', { settled: false });
  },
  async 'conversation-end'(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'errand', 'academy-errand-screen');
    await page.click("document.querySelector('#academy-errand-offers .academy-errand-card-button')", 'first errand card');
    await page.waitFor("document.querySelector('#conversation-day-screen.active') && !document.querySelector('#conversation-day-end').disabled && !document.querySelector('#conversation-day-send').disabled", 'errand conversation ready', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    const end = await page.hold('/api/conversation/end', { method: 'POST' });
    const film = startFilm(ctx, 'conversation-end');
    await sleep(FILM_FRAME_MS * 3);
    await pressUntilVeil(ctx, '#conversation-day-end', '会話を終える (errand conversation; POST /api/conversation/end held)');
    await shootHeld(ctx, end, film, 'conversation-end-wait', '会話を終えて: POST /api/conversation/end を止めている間（依頼の絵の層）');
    await end.release();
    await page.waitFor(HUB_READY, 'back on the terrace', LM_WAIT_MS);
    await film.stop();
  },
  async errand(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'errand');
    await shootHeld(ctx, field, film, 'errand-wait', '依頼へ: 送り出しのあとの GET /api/field を止めている間');
    await field.release();
    await page.waitFor('document.querySelector(\'#academy-errand-screen.active\')', 'errand screen', LM_WAIT_MS);
    await film.stop();
    await shootArrived(ctx, 'academy-errand-screen', 'errand-arrived', '依頼の画面に着いた姿');
  },
  async auction(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'auction');
    const enter = await page.hold('/api/auction/enter', { method: 'POST' });
    await field.release();
    await shootHeld(ctx, enter, film, 'auction-wait', '競売場へ: POST /api/auction/enter を止めている間（層の下に競売場の画面）');
    await enter.release();
    await page.waitFor(`document.querySelector('#academy-auction-screen.active') && !${LOADING_ACTIVE} && !${VEIL_WAITING}`, 'the auction opened', LM_WAIT_MS);
    await film.stop();
    await shootArrived(ctx, 'academy-auction-screen', 'auction-arrived', '競売場の画面に着いた姿', { settled: false });
  },
  async dungeon(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const field = await holdDispatchField(page);
    const film = await sendOff(ctx, 'dungeon');
    await shootHeld(ctx, field, film, 'dungeon-wait', '実践へ: 送り出しのあとの GET /api/field を止めている間（露台の夜を沈めた幕が地）');
    await field.release();
    await page.waitFor("document.querySelector('#academy-dungeon-screen.active') && !document.querySelector('#dungeon-dive').disabled", 'the dungeon entrance', LM_WAIT_MS);
    await film.stop();
    await shootArrived(ctx, 'academy-dungeon-screen', 'dungeon-arrived', '実践の入口の画面に着いた姿');
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
    // 押下は連なりを撮り始める前に送る（撮影の合間に送った押下は取りこぼされることがある）。
    await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
    const film = startFilm(ctx, 'load');
    ctx.steps.push('title → ロード → slot footprint');
    await awaitHub(ctx);
    await film.stop();
    await ctx.shoot('load-arrived', '露台に着いた姿');
  },
  async 'new-game'(ctx) {
    const { page } = ctx;
    await page.load(`${ctx.product.base}/`);
    await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
    await page.js(INSTALL_TIMELINE);
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('[data-journey-action=\"new-game\"]')", '新しいゲーム');
    const film = startFilm(ctx, 'new-game');
    ctx.steps.push('title → 新しいゲーム');
    await awaitHub(ctx);
    await film.stop();
    await ctx.shoot('new-game-arrived', '露台に着いた姿');
  },
  async undeclared(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    const before = await page.js("(() => { const s = getComputedStyle(document.querySelector('#academy-errand-screen')); return { size: s.getPropertyValue('--place-art-size'), position: s.getPropertyValue('--place-art-position') }; })()");
    await page.js("document.head.insertAdjacentHTML('beforeend', '<style>#academy-errand-screen { --place-art-size: initial !important; --place-art-position: initial !important; }</style>')");
    const after = await page.js("(() => { const s = getComputedStyle(document.querySelector('#academy-errand-screen')); return { size: s.getPropertyValue('--place-art-size'), position: s.getPropertyValue('--place-art-position') }; })()");
    ctx.steps.push(`errand screen declaration ${JSON.stringify(before)} → removed in the capture only ${JSON.stringify(after)}`);
    console.log(`undeclared: errand screen declaration ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    await page.catchThrown();
    await sayOnHub(ctx, ctx.product.hubLines.errand);
    const thrown = await awaitThrown(ctx, 'place veil');
    ctx.thrown = thrown;
    for (const entry of thrown) console.log(`undeclared: thrown: ${entry.description.split('\n')[0]} (stack ${entry.stack.join(' < ')})`);
    await sleep(3000);
    const veil = await page.js("(() => { const v = document.querySelector('#place-veil'); return { hidden: v.hidden, step: v.dataset.veil ?? null, screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id) }; })()");
    console.log(`undeclared: 3 s after the throw ${JSON.stringify(veil)}`);
  }
};

for (const [id, screenId] of Object.entries(PLAIN_DESTINATIONS)) SCENES[id] = plainDestinationScene(id, screenId);

// 会場から露台へ戻る道: 会場に着いて落ち着いたら、露台の支度（POST /api/routing/hub/start）を止めたまま出る紋を押し、会場の画面 →
// 会場の絵の層 → 露台の移りを撮る。
const VENUE_EXITS = {
  'arena-exit': { id: 'arena', screenId: 'academy-arena-screen', exit: '#arena-exit' },
  'auction-exit': { id: 'auction', screenId: 'academy-auction-screen', exit: '#academy-auction-exit' },
  'concert-hall-exit': { id: 'concert_hall', screenId: 'academy-concert-hall-screen', exit: '#academy-concert-hall-exit' }
};
function venueExitScene(name, { id, screenId, exit }) {
  return async (ctx) => {
    const { page } = ctx;
    await walkToHub(ctx);
    await sayOnHub(ctx, ctx.product.hubLines[id]);
    await page.waitFor(`document.querySelector('#${screenId}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`, `${screenId} shown`, LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    const revealed = await page.js(`(() => { const b = document.querySelector(${JSON.stringify(exit)}); const was = b.hidden; b.hidden = false; return was; })()`);
    ctx.steps.push(`at ${id}; exit sigil ${exit} ${revealed ? 'unhidden in the capture only' : 'already shown'}`);
    const measured = await page.js(`(window.__lastVeilArt = ${JSON.stringify(`/canonical/${id}/stage.jpg`)}, ${ART_PROBE})`);
    ctx.placements.push({ sequence: name, moment: 'before-press', ...measured });
    const start = await page.hold('/api/routing/hub/start', { method: 'POST' });
    const film = startFilm(ctx, name);
    await sleep(FILM_FRAME_MS * 3);
    await pressUntilVeil(ctx, exit, `${exit} (POST /api/routing/hub/start held)`);
    await shootHeld(ctx, start, film, `${name}-wait`, `${id} を出る: POST /api/routing/hub/start を止めている間（会場の絵の層）`);
    await start.release();
    await page.waitFor(HUB_READY, 'back on the terrace', LM_WAIT_MS);
    await film.stop();
  };
}
for (const [name, venue] of Object.entries(VENUE_EXITS)) SCENES[name] = venueExitScene(name, venue);

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
function printPlacements(name, placements) {
  for (const entry of placements) {
    if (!entry.art) {
      console.log(`placement ${name} ${entry.moment}: (no art veil over a screen)`);
      continue;
    }
    console.log(`placement ${name} ${entry.moment} ${entry.file ?? ''} art=${entry.art} screens=${entry.screens.join(',')} veilStep=${entry.veilStep}`);
    for (const row of entry.veil) console.log(`  veil   ${row.element}[${row.layer}] x=${row.x} y=${row.y} w=${row.w} h=${row.h} (size ${row.size} / position ${row.position})`);
    for (const row of entry.screen) console.log(`  screen ${row.element}[${row.layer}] x=${row.x} y=${row.y} w=${row.w} h=${row.h}${row.size ? ` (size ${row.size} / position ${row.position})` : ''}${row.filter && row.filter !== 'none' ? ` filter ${row.filter}` : ''}`);
  }
}

async function runScene(options, name) {
  const product = await startProduct(options.repoRoot);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], shots: [], placements: [], thrown: null };
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
    printPlacements(name, ctx.placements);
    console.log(`scene ${name} done in ${seconds.toFixed(1)} s`);
    return { scene: name, seconds, steps: ctx.steps, shots: ctx.shots, placements: ctx.placements, thrown: ctx.thrown, holds: page.holds, timeline, pageErrors: page.pageErrors, lmRequests: product.lmLog.length };
  } catch (error) {
    console.log(`scene ${name} stopped after: ${ctx.steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    console.log(`  last LM requests: ${JSON.stringify(product.lmLog.slice(-12))}`);
    console.log(`  page: ${JSON.stringify(await page.js("({ screen: document.querySelector('.screen.active')?.id ?? null })").catch((e) => e.message))}`);
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
  const manifest = { variant: options.variant, repoRoot: options.repoRoot, viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, failed };
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
