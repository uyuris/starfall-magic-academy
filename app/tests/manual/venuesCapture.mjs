// 三つの会場（闘技会・競売場・奏楽堂）を、露台からの本物の送り出しで入って段ごとに 1440x900 で撮る手回しの道具（*.test.mjs では
// ないので npm test は拾わない）:
//
//   <electron> app/tests/manual/venuesCapture.mjs --repo-root <絶対パス> --out <絶対パス> --scenes <名,名,...> [--plans <絶対パス>]
//
// <electron> はリポの node_modules/.bin/electron。--repo-root・--out・--scenes は必須で既定値は無い。--plans は構成案の置き場
// （plan-*.png）で、渡すと構成案（左）と撮った姿（右）を並べた一枚を書く。
// --repo-root の製品（app/src・app/public・data・content・assets）を、OS の一時ディレクトリに作った新しいプレイ（routing・案内人
// fallen_star・所持金と出品できる品を一つ足した持ち物）の上で、この process の中に起こす。LM は固定応答（下の表の閉じた集合）で、
// 知らない要求は 500 にして撮影ごと止める。--out は無いか空であること。撮った png と、一枚ごとの見えている字の全数（DOM の照合）・
// 段の道の姿・場面の記録を <out>/manifest.json に書く。
// 場面（scene）:
//   arena          露台 → 闘技会（選ぶ段）→ 一人で立つ → 勝ち上がりの表 → 試合（待機を重ねて決着）→ 結果。
//   arena-failure  闘技会の選ぶ段で POST /api/arena/enter を落とす（段の道が途切れる）。
//   auction-3      入札者 3 人の週: 出品の段 → 自分の品を出す → 自分の出品の競り → 一品目〜三品目（自分は降りる）→ 閉場。
//   auction-5      入札者 5 人の週: 出品しない → 一品目の自分の番。
//   auction-failure 入札者 3 人の週: 出品しない → 一品目の最初の NPC の入札の要求を落とす（段の道が途切れる）→ 言い直しの紋で
//                  一品目を頭からやり直して自分の番まで → 自分の入札の要求を落とす → 言い直しの紋 → もう一度入札して通る。
//   auction-closed-failure 入札者 3 人の週: 出品しない → 三品とも降りて閉場 → 出る紋で露台へ戻る道に故障を入れる（閉場の段で
//                  道が途切れる）。露台を開く要求の失敗は戻る道が自分で露台に着地させるので、故障は CDP の Debugger で
//                  app.js の exitAuction の中に止め、モジュールの returnToRoutingHubFromContent を throw するものに差し替えて入れる。
//   concert-hall   露台 → 奏楽堂（棚）→ 願いを書いて頼む → 語り → 演奏 → 棚。
//   concert-hall-failure 語りの段で LM が拾った材料に知らない id を返し続ける（段の道が途切れる）。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const SCENE_LIMIT_MS = 480000;
// 闘技会の試合で待機を重ねる上限（決着まで）。
const ARENA_WAIT_LIMIT = 400;
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const known = ['--repo-root', '--out', '--scenes', '--plans'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of ['--repo-root', '--out', '--scenes']) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  const scenes = parsed['--scenes'].split(',');
  for (const scene of scenes) {
    if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  }
  for (const key of ['--repo-root', '--out', '--plans']) {
    if (parsed[key] !== undefined && !path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  return { repoRoot: parsed['--repo-root'], out: parsed['--out'], scenes, plans: parsed['--plans'] ?? null };
}

// ── 製品と固定応答の LM（この process の中・一時のセーブ） ─────────────────────────────────────────────────────
// 言葉は撮影のための仮の文（製品の本文ではない）。
const FIXTURE_CHAT_LINE = '（顔を上げて）ええ、行ってらっしゃい。今週も良い一週間になりますように。';
const FIXTURE_REFLECTION_LINE = '学院で主人公と少し話した。';
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
// 闘技会の場内アナウンス（試合前の口上・結果の実況）。
const ARENA_ANNOUNCE_MARKER = 'あなたは魔法学院の闘技会の場内アナウンスの地の文を綴る。';
const ARENA_ANNOUNCE_LINE = '夜の闘技場に篝火が揺れ、魔法陣の上で二つの影が向かい合う。';
// 競売人ガロウの口上（口火・煽り・落札）と客の反応。
const AUCTION_MASTER_MARKER = '競売人ガロウ本人である。';
const AUCTION_MASTER_LINES = [
  ['口火を切る', 'さあお立ち会い、今宵の品のお披露目だ。札はどうぞご遠慮なく。'],
  ['場をさらに煽って', 'まだ上はいかがか。この灯の下で、もうひと声。'],
  ['落札を宣言する', '槌が鳴った。この品は、そちらのお客の手に渡る。']
];
const AUCTION_REACTION_MARKER = 'この品を見た今の反応の発話だけを書く';
const AUCTION_REACTION_LINE = '（身を乗り出して）これは見過ごせない品だね。';
const AUCTION_BID_LINE = '（札を掲げて）その額で取ります。';
const AUCTION_PASS_LINE = '（首を振って）今日は見送ろう。';
// 奏楽堂の語り（concertHallRender.mjs の stub と同じ答え。失敗の場面は拾った材料に知らない id を返す）。
const CONCERT_HALL_STAGE_DELAY_MS = 700;
const CONCERT_HALL_WISH = '星の降る夜に、静かに眠りへ落ちていくような曲を';
const CONCERT_HALL_SKELETON = {
  title: '星降りの子守唄',
  key: 'C',
  mode: 'major',
  tempo: 60,
  meter: '4/4',
  sections: [
    { name: '宵', bars: 4, chords: ['Cmaj7', 'Am', 'Fmaj7', 'G'], character: '星が降り始める、ゆっくりとした導入。' },
    { name: '眠り', bars: 4, chords: ['Fmaj7', 'G', 'Cmaj7', 'Cmaj7'], character: '呼吸が深くなり、静かに閉じる。' }
  ]
};
const CONCERT_HALL_SECTION_PITCHES = ['E5', 'D5', 'C5', 'D5', 'E5', 'G5', 'E5', 'D5', 'C5', 'D5', 'E5', 'C5', 'D5', 'E5', 'D5', 'C5'];
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

function createFixtureLm(hubLines, faults) {
  return async function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') return { kind: schemaName, content: JSON.stringify({ expression: 'neutral' }) };
    if (schemaName === 'work_record_recall_choice') return { kind: schemaName, content: JSON.stringify({ work_record_ids: [] }) };
    if (schemaName === 'auction_bid_turn') {
      // まだ誰も積んでいなければ、予算が届く人は入札できる最低額で積む。誰かが積んだあとは降りる。
      const minNext = prompt.match(/入札するなら (\d+)G 以上/);
      const budget = prompt.match(/予算の上限）: (\d+)G/);
      if (!minNext || !budget) throw new Error('fixture lm: an auction bid turn without its minimum or budget');
      const history = prompt.match(/ここまでの競り: (.*)/);
      if (!history) throw new Error('fixture lm: an auction bid turn without its history');
      const open = !/\d+G/.test(history[1]) && Number(budget[1]) >= Number(minNext[1]);
      return {
        kind: `${schemaName} ${open ? 'bid' : 'pass'}`,
        content: JSON.stringify(open ? { utterance: AUCTION_BID_LINE, action: 'bid', amount: Number(minNext[1]) } : { utterance: AUCTION_PASS_LINE, action: 'pass', amount: 0 })
      };
    }
    if (schemaName === 'concert_hall_materials') {
      await sleep(CONCERT_HALL_STAGE_DELAY_MS);
      return {
        kind: `${schemaName}${faults.concertHall ? ' fault' : ''}`,
        content: JSON.stringify(faults.concertHall
          ? { materials: ['item_does_not_exist'], motif_words: ['星降り'], remark: '（故障注入）' }
          : { materials: [], motif_words: ['星降り'], remark: '願いの言葉から、降る星と眠りの気配を拾った。' })
      };
    }
    if (schemaName === 'concert_hall_direction') {
      await sleep(CONCERT_HALL_STAGE_DELAY_MS);
      return { kind: schemaName, content: JSON.stringify({ direction_id: 'serene', subject_id: 'starry_sky', motif_category_id: 'lullaby', remark: '静謐の方向で、星空を題材に、子守唄の型で行こう。' }) };
    }
    if (schemaName === 'concert_hall_skeleton') {
      await sleep(CONCERT_HALL_STAGE_DELAY_MS);
      return { kind: schemaName, content: JSON.stringify(CONCERT_HALL_SKELETON) };
    }
    if (schemaName === 'concert_hall_section_notes') {
      await sleep(CONCERT_HALL_STAGE_DELAY_MS);
      return { kind: schemaName, content: JSON.stringify({ melody: CONCERT_HALL_SECTION_PITCHES.map((pitch, beat) => ({ pitch, start_beat: beat, duration_beats: 1, velocity: 88 })), counter: [] }) };
    }
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      if (matches.length > 1) throw new Error(`fixture lm: the hub conversation holds ${matches.length} destination lines`);
      const destination = matches.length === 1 ? matches[0][0] : 'none';
      return { kind: `hub-destination ${destination}`, content: destination };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { kind: 'event-flag false', content: 'false' };
    if (prompt.includes(ARENA_ANNOUNCE_MARKER)) return { kind: 'arena-announce', content: ARENA_ANNOUNCE_LINE };
    if (prompt.includes(AUCTION_MASTER_MARKER)) {
      const line = AUCTION_MASTER_LINES.find(([marker]) => prompt.includes(marker));
      if (!line) throw new Error('fixture lm: an auction master speech of an unknown kind');
      return { kind: `auction-master ${line[0]}`, content: line[1] };
    }
    if (prompt.includes(AUCTION_REACTION_MARKER)) return { kind: 'auction-reaction', content: AUCTION_REACTION_LINE };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) {
      if (prompt.includes(marker)) return { kind: marker, content };
    }
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat-line', content: FIXTURE_CHAT_LINE };
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

// 持ち物: 入札できる所持金と、出品できる品（売値のある調合の品）を一つ。
const CAPTURE_MONEY = 100000;
const CAPTURE_CONSIGNABLE_ITEM = 'alchemy_stardust_trinket';

// 場面ごとに一つ: 一時のセーブ・固定応答の LM・製品サーバー。lmFailures は 500 にした要求。
async function startProduct(repoRoot) {
  const product = (relative) => import(path.join(repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'venues-capture-'));
  const closers = [];
  const lmFailures = [];
  const lmLog = [];
  const faults = { concertHall: false };
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
    const play = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    await writeJson(play.root, 'game_data/player_inventory.json', { money: CAPTURE_MONEY, items: [{ item_id: CAPTURE_CONSIGNABLE_ITEM, quantity: 1 }] });
    const answer = createFixtureLm(hubLines, faults);
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
      faults,
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

// 入札者の数がちょうど count の週（籠入りの生き物のロットが立たない週）を、製品の週の抽選で探す。入札者の数は週の seed だけで決まる
// （名簿が 5 人以上なら名簿に依らない）。
async function auctionWeekWithBidders(repoRoot, count) {
  const { drawWeeklyAuctionLots, loadAuctionCatalog, auctionCreatureLotForWeek } = await import(path.join(repoRoot, 'app/src/routingAuction.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'venues-auction-week-'));
  try {
    await writeJson(root, runtimePathsManifestFilename, {
      configRoot: path.join(root, 'app/config'),
      definitionsRoot: path.join(repoRoot, 'data/definitions/game_data'),
      seedsRoot: path.join(repoRoot, 'data/seeds/game_data'),
      mutableRoot: path.join(root, 'data/mutable/game_data'),
      characterContentRoot: path.join(repoRoot, 'content/characters'),
      creatureContentRoot: path.join(repoRoot, 'content/creatures'),
      canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
      publicRoot: path.join(repoRoot, 'app/public'),
      resourceRoot: root
    });
    const catalog = await loadAuctionCatalog({ root });
    const roster = Array.from({ length: 8 }, (_unused, index) => ({ character_id: `character_${String(index + 1).padStart(3, '0')}`, display_name: `人${index + 1}` }));
    for (let week = 2; week < 40; week += 1) {
      if (auctionCreatureLotForWeek(week)) continue;
      if (drawWeeklyAuctionLots({ week, roster, catalog }).bidders.length === count) return week;
    }
    throw new Error(`no week below 40 seats ${count} auction bidders`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ── 窓（CDP） ────────────────────────────────────────────────────────────────────────────────────────────────
// いまの姿: 出ている画面・段の道・言い直しと出る紋・body の play-mode。
const PAGE_STATE = `(() => {
  const screen = document.querySelector('.screen.active');
  const way = screen?.querySelector('.venue-path');
  const shown = (el) => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  return {
    screens: [...document.querySelectorAll('.screen.active')].map((el) => el.id),
    playMode: document.body.classList.contains('play-mode'),
    stage: screen?.dataset.stage ?? screen?.dataset.state ?? null,
    way: way ? { label: way.getAttribute('aria-label'), failed: way.dataset.failed === 'true' } : null,
    retry: shown(screen?.querySelector('.venue-retry')),
    exit: shown(screen?.querySelector('.venue-exit'))
  };
})()`;

// 見えている字の全数: 文書の字の節を一つずつ、祖先のどれも表示を消しておらず（display・visibility・実効の不透明度 0.05 以上）、
// 画面の内に幅と高さを持つものだけ数える。入力欄の値（無ければ placeholder）も一行に数える。読み上げの名（aria-label）は数えない。
const VISIBLE_TEXT = `(() => {
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].join('.') : '');
  const opacityOf = (el) => {
    let value = 1;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return 0;
      value *= Number(style.opacity);
    }
    return value;
  };
  const onScreen = (r) => r.width >= 1 && r.height >= 1 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest('script, style, template')) continue;
    const opacity = opacityOf(el);
    if (opacity < 0.05) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (!onScreen(r)) continue;
    lines.push({ text, where: describe(el), x: Math.round(r.left), y: Math.round(r.top), opacity: Number(opacity.toFixed(2)) });
  }
  for (const input of document.querySelectorAll('input, textarea')) {
    const opacity = opacityOf(input);
    const r = input.getBoundingClientRect();
    if (opacity < 0.05 || !onScreen(r)) continue;
    const text = input.value || input.placeholder;
    if (text) lines.push({ text, where: describe(input) + (input.value ? '[value]' : '[placeholder]'), x: Math.round(r.left), y: Math.round(r.top), opacity: Number(opacity.toFixed(2)) });
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
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
        await sleep(50);
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
      for (const character of text) {
        await send('Input.insertText', { text: character });
        await sleep(20);
      }
    },
    async press(key, code) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === ' ' ? 32 : 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === ' ' ? 32 : 0 });
    },
    // app.js の marker の行に breakpoint を置いて返す（置き終えてから操作する）。返す done は、そこで止まり、その場のモジュールの
    // scope で expression を評価して進めたときに満ちる（故障の差し込み）。
    async injectInModule(marker, expression) {
      const source = await js("fetch('/app.js').then((r) => r.text())");
      const index = source.indexOf(marker);
      if (index < 0) throw new Error(`injectInModule: ${marker} is not in app.js`);
      const lineNumber = source.slice(0, index).split('\n').length - 1;
      await send('Debugger.enable');
      const { breakpointId, locations } = await send('Debugger.setBreakpointByUrl', { urlRegex: '/app\\.js$', lineNumber });
      if (locations.length !== 1) throw new Error(`injectInModule: the breakpoint at app.js line ${lineNumber} resolved to ${locations.length} locations`);
      const done = new Promise((resolve, reject) => {
        const onPaused = (event, method, params) => {
          if (method !== 'Debugger.paused') return;
          cdp.removeListener('message', onPaused);
          send('Debugger.evaluateOnCallFrame', { callFrameId: params.callFrames[0].callFrameId, expression, throwOnSideEffect: false })
            .then((result) => {
              if (result.exceptionDetails) throw new Error(`injectInModule: ${result.exceptionDetails.text}`);
              return send('Debugger.removeBreakpoint', { breakpointId });
            })
            .then(() => send('Debugger.resume'))
            .then(() => send('Debugger.disable'))
            .then(resolve, reject);
        };
        cdp.on('message', onPaused);
      });
      return { done };
    },
    async moveAway() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    },
    // fragment を含む要求（method 指定可）を decide(params) の答えで止める・落とす・通す。
    async hold(fragment, { method = null, decide = async () => 'hold' } = {}) {
      let resolve;
      const paused = new Promise((r) => { resolve = r; });
      const rule = { fragment, method, decide, resolve, done: false, requestId: null };
      rules.push(rule);
      await syncFetch();
      return {
        paused,
        async release() {
          await paused;
          if (rule.requestId) await send('Fetch.continueRequest', { requestId: rule.requestId });
          rule.requestId = null;
          rules.splice(rules.indexOf(rule), 1);
          await syncFetch();
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
const motionSettled = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].every((el) => el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getComputedTiming().iterations === Infinity))`;
const IMAGES_LOADED = (selector) => `[...document.querySelectorAll(${JSON.stringify(`${selector} img`)})].every((img) => !img.getAttribute('src') || img.complete)`;
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true'`;
const arrived = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`;
const settled = (id) => `${arrived(id)} && ${motionSettled(`#${id}`)} && ${IMAGES_LOADED(`#${id}`)}`;
const WAY_FAILED = (id) => `document.querySelector('#${id} .venue-path')?.dataset.failed === 'true' && !document.querySelector('#${id} .venue-retry').hidden`;

async function walkToHub(ctx) {
  const { page, product, steps } = ctx;
  await page.load(`${product.base}/`);
  await page.waitFor("document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'", 'title gate');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('[data-journey-action=\"load\"]')", 'ロード');
  await page.waitFor("document.querySelector('#journey').dataset.scene === 'hall' && document.querySelector('.journey-footprint-light:not(:disabled)')", 'footprint hall');
  await sleep(SETTLE_MS);
  await page.click("document.querySelector('.journey-footprint-light:not(:disabled)')", 'slot footprint');
  await page.waitFor(HUB_READY, 'the terrace', LM_WAIT_MS);
  await page.waitFor(`${motionSettled('#routing-hub-screen')} && ${IMAGES_LOADED('#routing-hub-screen')}`, 'the terrace settled', 30000);
  await sleep(SETTLE_MS);
  steps.push('title → ロード → slot → terrace');
}

async function setWeek(ctx, elapsedWeeks) {
  const set = await ctx.page.js(`fetch('/api/debug/weeks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elapsed_weeks: ${elapsedWeeks} }) }).then(async (r) => ({ status: r.status, body: await r.text() }))`);
  if (set.status !== 200) throw new Error(`debug weeks: ${JSON.stringify(set)}`);
  ctx.steps.push(`POST /api/debug/weeks {elapsed_weeks:${elapsedWeeks}}`);
}

// 露台で行き先を言い、本物の送り出しで行き先の画面に着くまで待つ。
async function sendOff(ctx, destinationId, screenId) {
  const { page } = ctx;
  const line = ctx.product.hubLines[destinationId];
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', line);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor("document.querySelector('#routing-hub-input').value === ''", 'the terrace send to fire');
  ctx.steps.push(`say on the terrace: ${line}`);
  await page.waitFor("!document.querySelector('#terrace-opened').hidden", `${destinationId}: the send-off curtain`, LM_WAIT_MS);
  await page.waitFor(arrived(screenId), `${screenId} arrived`, LM_WAIT_MS);
  ctx.steps.push(`send-off → ${screenId}`);
}

// ── 撮る ───────────────────────────────────────────────────────────────────────────────────────────────────
function createShooter(ctx) {
  return async function shoot(file, note) {
    const target = path.join(ctx.options.out, `${file}.png`);
    if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
    await ctx.page.moveAway();
    await sleep(400);
    const state = await ctx.page.js(PAGE_STATE);
    if (!state.playMode) throw new Error(`${file}: body.play-mode is not set (the dev band would show)`);
    const text = await ctx.page.js(VISIBLE_TEXT);
    const bytes = await ctx.page.png();
    if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${file}.png is not ${VIEWPORT.width}x${VIEWPORT.height}`);
    await fs.writeFile(target, bytes);
    ctx.shots.push({ file: `${file}.png`, note, ...state, text });
    console.log(`shot ${file}.png — ${note} ${JSON.stringify(state)}`);
    for (const line of text) console.log(`  text ${JSON.stringify(line.text)} @${line.where} (${line.x},${line.y})`);
    return state;
  };
}

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
const ARENA = 'academy-arena-screen';
const AUCTION = 'academy-auction-screen';
const CONCERT_HALL = 'academy-concert-hall-screen';
const ARENA_STAGE = (stage) => `document.querySelector('#${ARENA}')?.dataset.stage === '${stage}'`;
const AUCTION_TURN = "document.querySelector('#academy-auction-bid-bar')?.dataset.active === 'true' && document.querySelector('#academy-auction-bid')?.disabled === false";
const CONCERT_STATE = (state) => `document.querySelector('#${CONCERT_HALL}')?.dataset.state === '${state}'`;

async function enterArena(ctx) {
  await walkToHub(ctx);
  await sendOff(ctx, 'arena', ARENA);
  await ctx.page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('selection')} && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3`, 'the arena selection');
  await sleep(SETTLE_MS);
}

// 自分の番の手元に立ち、席の動きが収まるのを待つ。
async function awaitAuctionTurn(ctx, label) {
  await ctx.page.waitFor(`${AUCTION_TURN} && ${motionSettled(`#${AUCTION}`)}`, label, LM_WAIT_MS);
  await sleep(SETTLE_MS);
}

// 露台の送り出しが週を一つ進めるので、競売の週（elapsed_weeks）は送り出しの前の週の次になる。
async function enterAuction(ctx, bidders) {
  const week = await auctionWeekWithBidders(ctx.options.repoRoot, bidders);
  await walkToHub(ctx);
  await setWeek(ctx, week - 1);
  await walkToHub(ctx);
  await sendOff(ctx, 'auction', AUCTION);
  await ctx.page.waitFor(`${settled(AUCTION)} && !document.querySelector('#academy-auction-consignment').hidden && document.querySelectorAll('#academy-auction-seats .academy-auction-seat').length > 1`, 'the auction consignment window');
  const seated = await ctx.page.js("fetch('/api/auction/state').then((r) => r.json()).then((state) => ({ week: state.week, bidders: state.bidders.length, seats: document.querySelectorAll('#academy-auction-seats .academy-auction-seat').length }))");
  if (seated.week !== week || seated.bidders !== bidders || seated.seats !== bidders + 1) throw new Error(`the auction seats ${JSON.stringify(seated)}, expected week ${week} with ${bidders} bidders`);
  ctx.steps.push(`auction week ${seated.week}: ${seated.bidders} bidders seated`);
  await sleep(SETTLE_MS);
  return week;
}

async function skipConsignment(ctx) {
  await ctx.page.click("document.querySelector('#academy-auction-consignment-skip')", '出品しない');
  ctx.steps.push('press 出品しない');
}

async function composeConcertHall(ctx) {
  await ctx.page.type(`document.querySelector('#academy-concert-hall-input')`, 'the wish line', CONCERT_HALL_WISH);
  await sleep(300);
  await ctx.page.click("document.querySelector('#academy-concert-hall-compose')", '奏でてもらう');
  ctx.steps.push(`wish: ${CONCERT_HALL_WISH}`);
}

async function enterConcertHall(ctx) {
  await walkToHub(ctx);
  await sendOff(ctx, 'concert_hall', CONCERT_HALL);
  await ctx.page.waitFor(`${settled(CONCERT_HALL)} && ${CONCERT_STATE('arrived')}`, 'the concert hall shelf');
  await sleep(SETTLE_MS);
}

const SCENES = {
  async arena(ctx) {
    const { page } = ctx;
    await enterArena(ctx);
    await ctx.shoot('arena-arrived', '闘技会に入った直後（選ぶ段: 賞金と失うもの無しの印・一人の立ち位置・バディーの破線の空の輪郭）');
    await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="solo"]')`, '一人の立ち位置');
    ctx.steps.push('stand on solo');
    await page.waitFor(`${settled(ARENA)} && ${ARENA_STAGE('bracket')} && document.querySelector('#arena-bracket-actions .arena-fight')`, 'the bracket');
    await sleep(SETTLE_MS);
    await ctx.shoot('arena-bracket', '勝ち上がりの表の段（試合を始める紋）');
    let matches = 0;
    let waits = 0;
    while (true) {
      await page.waitFor(`${ARENA_STAGE('result')} || ${ARENA_STAGE('match')} || document.querySelector('#arena-bracket-actions .arena-fight')`, 'the next arena stage', LM_WAIT_MS);
      if (await page.js(ARENA_STAGE('result'))) break;
      if (await page.js(ARENA_STAGE('bracket'))) {
        await sleep(SETTLE_MS);
        await page.click("document.querySelector('#arena-bracket-actions .arena-fight')", '試合開始');
        await page.waitFor(`${ARENA_STAGE('match')} && document.querySelector('#arena-match-intro')?.dataset.state === 'ready'`, 'the match and its intro', LM_WAIT_MS);
        matches += 1;
        ctx.steps.push(`start match ${matches}`);
        if (matches === 1) {
          await page.waitFor(`${motionSettled(`#${ARENA}`)} && ${IMAGES_LOADED(`#${ARENA}`)}`, 'the match settled');
          await sleep(SETTLE_MS);
          await ctx.shoot('arena-match', '試合の段（口上・魔法の紋と MP・回復の紋・持ち込みの空の袋）');
        }
        continue;
      }
      await page.press(' ', 'Space');
      waits += 1;
      if (waits > ARENA_WAIT_LIMIT) throw new Error(`the arena did not conclude within ${ARENA_WAIT_LIMIT} waits`);
      await sleep(120);
    }
    ctx.steps.push(`concluded after ${matches} matches and ${waits} waits`);
    await page.waitFor(`${settled(ARENA)} && document.querySelector('#arena-result-flavor')?.dataset.state === 'ready'`, 'the arena result', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await ctx.shoot('arena-result', '結果の段（結果・賞金の印と額・右上の出る紋）');
  },
  async 'arena-failure'(ctx) {
    const { page } = ctx;
    await enterArena(ctx);
    const enter = await page.hold('/api/arena/enter', { method: 'POST', decide: async () => 'fail' });
    await page.click(`document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode="solo"]')`, '一人の立ち位置');
    await enter.paused;
    ctx.steps.push('stand on solo (POST /api/arena/enter failed)');
    await page.waitFor(WAY_FAILED(ARENA), 'the arena way broken');
    await sleep(SETTLE_MS);
    await ctx.shoot('arena-failure', '闘技会の失敗（選ぶ段で道が途切れ、言い直しの紋が立つ）');
    await enter.release();
  },
  async 'auction-3'(ctx) {
    const { page } = ctx;
    ctx.notes.week = await enterAuction(ctx, 3);
    await ctx.shoot('auction-3-arrived', '競売場に入った直後（出品の段・入札者 3 人）');
    // 自分の出品の競り: 三人目の NPC の入札の要求を止め、一人目が積んで二人目が降りた姿を撮る。
    let consignmentBids = 0;
    const third = await page.hold('/api/auction/consignment/npc-bid', { method: 'POST', decide: async () => ((consignmentBids += 1) === 3 ? 'hold' : 'pass') });
    await page.click("document.querySelector('.academy-auction-consignment-option')", '出品する品');
    ctx.steps.push('consign the first option');
    await third.paused;
    await page.waitFor(`document.querySelector('#academy-auction-seats .academy-auction-seat[data-state="highest"]') && document.querySelector('#academy-auction-seats .academy-auction-seat[data-state="down"]') && ${motionSettled(`#${AUCTION}`)}`, 'the consignment bids applied', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await ctx.shoot('auction-3-consignment', '自分の出品の競り（品の名の前と手元の入札しない印・最高入札者の光・降りた沈み）');
    await third.release();
    for (const lot of [1, 2, 3]) {
      await awaitAuctionTurn(ctx, `lot ${lot}: the player's turn`);
      if (lot === 1) await ctx.shoot('auction-3-bidding', '一品目の自分の番（最高入札者の光と札・降りた沈み・上乗せ額に最低増分）');
      await page.click("document.querySelector('#academy-auction-drop')", '降りる');
      ctx.steps.push(`lot ${lot}: drop`);
      await page.waitFor(`!(${AUCTION_TURN})`, `lot ${lot}: the turn closed`);
    }
    await page.waitFor(`${settled(AUCTION)} && !document.querySelector('#academy-auction-closed').hidden && !document.querySelector('#academy-auction-exit').hidden`, 'the auction closed', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await ctx.shoot('auction-3-closed', '閉場（今宵の結果・右上の出る紋）');
  },
  async 'auction-5'(ctx) {
    ctx.notes.week = await enterAuction(ctx, 5);
    await ctx.shoot('auction-5-arrived', '競売場に入った直後（出品の段・入札者 5 人）');
    await skipConsignment(ctx);
    await awaitAuctionTurn(ctx, "lot 1: the player's turn");
    await ctx.shoot('auction-5-bidding', '一品目の自分の番（入札者 5 人）');
  },
  async 'auction-failure'(ctx) {
    const { page } = ctx;
    ctx.notes.week = await enterAuction(ctx, 3);
    const bid = await page.hold('/api/auction/npc-bid', { method: 'POST', decide: async () => 'fail' });
    await skipConsignment(ctx);
    await bid.paused;
    ctx.steps.push('lot 1: the first NPC bid request failed');
    await page.waitFor(WAY_FAILED(AUCTION), 'the auction way broken', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await ctx.shoot('auction-failure', '競売場の失敗（一品目で道が途切れ、言い直しの紋が立つ）');
    await bid.release();
    // 言い直しの紋: 競売場へ入り直し、いまのロット（一品目）を頭からやり直して自分の番まで進む。
    await page.click("document.querySelector('#academy-auction-retry')", '言い直しの紋');
    ctx.steps.push('press the retry sigil');
    await page.waitFor(`document.querySelector('#${AUCTION} .venue-path')?.dataset.failed === 'false' && document.querySelector('#academy-auction-retry').hidden`, 'the way mended');
    await awaitAuctionTurn(ctx, "lot 1 again: the player's turn");
    const again = await page.js("({ way: document.querySelector('#academy-auction-path').getAttribute('aria-label'), lot: document.querySelector('#academy-auction-board-name').textContent })");
    ctx.steps.push(`after the retry: ${again.way} / ${again.lot}`);
    // 手元の入札の要求の失敗: 道が途切れ、言い直しの紋で道が直り、番は開いたままなのでもう一度入札できる。
    const playerBid = await page.hold('/api/auction/bid', { method: 'POST', decide: async () => 'fail' });
    await page.click("document.querySelector('#academy-auction-bid')", '入札の紋');
    await playerBid.paused;
    await page.waitFor(WAY_FAILED(AUCTION), 'the way broken at the bid');
    const failedBid = await page.js("({ way: document.querySelector('#academy-auction-path').getAttribute('aria-label'), bidEnabled: !document.querySelector('#academy-auction-bid').disabled })");
    ctx.steps.push(`the bid request failed: ${failedBid.way} / bid sigil enabled ${failedBid.bidEnabled}`);
    await playerBid.release();
    await page.click("document.querySelector('#academy-auction-retry')", '言い直しの紋');
    await page.waitFor(`document.querySelector('#${AUCTION} .venue-path')?.dataset.failed === 'false' && ${AUCTION_TURN}`, 'the way mended with the turn still open');
    await page.click("document.querySelector('#academy-auction-bid')", '入札の紋');
    await page.waitFor("document.querySelector('#academy-auction-desk-highest') && !document.querySelector('#academy-auction-desk-highest').hidden", 'the player holds the bid');
    ctx.steps.push('after the retry the bid went through: the player holds the bid');
  },
  async 'auction-closed-failure'(ctx) {
    const { page } = ctx;
    ctx.notes.week = await enterAuction(ctx, 3);
    await skipConsignment(ctx);
    for (const lot of [1, 2, 3]) {
      await awaitAuctionTurn(ctx, `lot ${lot}: the player's turn`);
      await page.click("document.querySelector('#academy-auction-drop')", '降りる');
      ctx.steps.push(`lot ${lot}: drop`);
      await page.waitFor(`!(${AUCTION_TURN})`, `lot ${lot}: the turn closed`);
    }
    await page.waitFor(`${settled(AUCTION)} && !document.querySelector('#academy-auction-closed').hidden && !document.querySelector('#academy-auction-exit').hidden`, 'the auction closed', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    const injected = await page.injectInModule('    await returnToRoutingHubFromContent(AUCTION_POST_CONTENT_SCREEN);', "returnToRoutingHubFromContent = async () => { throw new Error('capture: injected failure on the way back to the terrace'); }");
    await page.click("document.querySelector('#academy-auction-exit')", '出る紋');
    await injected.done;
    ctx.steps.push('press the exit sigil (the return to the terrace throws)');
    await page.waitFor(`${WAY_FAILED(AUCTION)} && document.querySelector('#${AUCTION}.active')`, 'the closed way broken');
    await sleep(SETTLE_MS);
    await ctx.shoot('auction-closed-failure', '競売場の閉場の段の失敗（三品目の先で道が途切れ、言い直しの紋が立つ）');
  },
  async 'concert-hall'(ctx) {
    const { page } = ctx;
    await enterConcertHall(ctx);
    await ctx.shoot('concert-hall-arrived', '奏楽堂に入った直後（棚: 楽師の挨拶・空の棚）');
    await composeConcertHall(ctx);
    await page.waitFor(`${CONCERT_STATE('narrated')} && !document.querySelector('#academy-concert-hall-perform').hidden && ${motionSettled(`#${CONCERT_HALL}`)}`, 'the narration', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await ctx.shoot('concert-hall-narrated', '語りの段（四段の語り・指南は題の三語・床の演奏の紋）');
    await page.click("document.querySelector('#academy-concert-hall-perform')", '演奏を始める');
    await page.waitFor(`${CONCERT_STATE('playing')} && document.querySelector('#academy-concert-hall-performance-cards [data-current="true"]')`, 'the performance', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await ctx.shoot('concert-hall-playing', '演奏の段（いまの節が灯る・止める紋）');
    await page.waitFor(`${CONCERT_STATE('played')} && ${motionSettled(`#${CONCERT_HALL}`)}`, 'the performance ended', LM_WAIT_MS);
    await sleep(SETTLE_MS);
    await ctx.shoot('concert-hall-shelf', '棚の段（いま書けた曲が上に灯る）');
  },
  async 'concert-hall-failure'(ctx) {
    const { page } = ctx;
    await enterConcertHall(ctx);
    ctx.product.faults.concertHall = true;
    ctx.steps.push('fixture LM: materials name an unknown id');
    await composeConcertHall(ctx);
    await page.waitFor(`${CONCERT_STATE('error')} && ${WAY_FAILED(CONCERT_HALL)}`, 'the concert hall way broken', LM_WAIT_MS);
    // 失敗は LM の要求を 500 にしていない（知らない id は製品の関所が退ける）。
    await sleep(SETTLE_MS);
    await ctx.shoot('concert-hall-failure', '奏楽堂の失敗（語りの段で道が途切れ、言い直しの紋が立つ）');
  }
};

// ── 並びの一枚（構成案 ‖ 作った姿） ─────────────────────────────────────────────────────────────────────────
const COMPARE_PAIRS = [
  ['arena', 'plan-arena.png', 'arena-arrived.png'],
  ['auction', 'plan-auction.png', 'auction-3-bidding.png'],
  ['auction-5', 'plan-auction.png', 'auction-5-bidding.png'],
  ['auction-consignment', 'plan-auction-consignment.png', 'auction-3-consignment.png'],
  ['concert-hall', 'plan-concert-hall.png', 'concert-hall-narrated.png']
];
const COMPARE_GAP = 24;

// 並べる頁は一時ディレクトリの file に書き、二枚は file:// で引く。構成案の比べ（compare-*.png）と同じ 1440+24+1440 x 900。
async function writeComparisons(options, written) {
  const made = [];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'venues-compare-'));
  const width = VIEWPORT.width * 2 + COMPARE_GAP;
  const win = new BrowserWindow({ width, height: VIEWPORT.height, useContentSize: true, show: false });
  try {
    await win.loadURL('about:blank');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    for (const [name, planFile, builtFile] of COMPARE_PAIRS) {
      if (!written.has(builtFile)) continue;
      const left = new URL(`file://${path.join(options.plans, planFile)}`).href;
      const right = new URL(`file://${path.join(options.out, builtFile)}`).href;
      const html = `<html><body style="margin:0;background:#000"><div style="display:flex;gap:${COMPARE_GAP}px"><img style="width:${VIEWPORT.width}px;height:${VIEWPORT.height}px" src="${left}"><img style="width:${VIEWPORT.width}px;height:${VIEWPORT.height}px" src="${right}"></div></body></html>`;
      const file = path.join(scratch, `${name}.html`);
      await fs.writeFile(file, html, 'utf8');
      await win.loadFile(file);
      await win.webContents.executeJavaScript('Promise.all([...document.images].map((img) => img.decode()))');
      const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: VIEWPORT.height, scale: 1 } });
      const out = `compare-${name}.png`;
      await fs.writeFile(path.join(options.out, out), Buffer.from(data, 'base64'));
      made.push({ file: out, left: planFile, right: builtFile });
      console.log(`compare ${out}`);
    }
  } finally {
    win.destroy();
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return made;
}

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runScene(options, name) {
  const product = await startProduct(options.repoRoot);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard);
  const ctx = { options, product, page, steps: [], shots: [], notes: {} };
  ctx.shoot = createShooter(ctx);
  const started = Date.now();
  let watchdog;
  try {
    await Promise.race([
      SCENES[name](ctx),
      new Promise((resolve, reject) => { watchdog = setTimeout(() => reject(new Error(`scene ${name} exceeded ${SCENE_LIMIT_MS / 1000} s`)), SCENE_LIMIT_MS); })
    ]).finally(() => clearTimeout(watchdog));
    guard();
    const seconds = (Date.now() - started) / 1000;
    console.log(`scene ${name} done in ${seconds.toFixed(1)} s`);
    return { scene: name, seconds, notes: ctx.notes, steps: ctx.steps, shots: ctx.shots, pageErrors: page.pageErrors, lmRequests: product.lmLog.length };
  } catch (error) {
    console.log(`scene ${name} stopped after: ${ctx.steps.at(-1) ?? 'nothing'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    console.log(`  last LM requests: ${JSON.stringify(product.lmLog.slice(-12))}`);
    console.log(`  page: ${JSON.stringify(await page.js(PAGE_STATE).catch((e) => e.message))}`);
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
  const written = new Set(scenes.flatMap((scene) => scene.shots.map((shot) => shot.file)));
  const comparisons = options.plans ? await writeComparisons(options, written) : [];
  const manifest = { repoRoot: options.repoRoot, viewport: VIEWPORT, seconds: (Date.now() - started) / 1000, scenes, comparisons, failed };
  await fs.writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`run done in ${manifest.seconds.toFixed(1)} s (failed: ${failed.join(',') || '-'})`);
  if (failed.length > 0) throw new Error(`scenes failed: ${failed.join(',')}`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
// 奏楽堂の演奏は自分の AudioContext を押した手の中で起こす。撮影の窓でも確かに鳴る形にしておく。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error('FAILED', error.message);
    app.exit(1);
  });
