// 閉じるの紋を星の揺り籠の閉じると揃えた窓を、製品の通常の道で開いて 1440x900 に撮り、閉じる釦を実ポインタで押して確かめる
// 手回しの道具（*.test.mjs ではないので npm test は拾わない）:
//
//   env -u TEAM_ROOT -u TEAM_QUEUE_DIR -u TEAM_STATE_DIR -u TEAM_CONFIG_FILE ... \
//     <electron> app/tests/manual/closeButtonRender.mjs --repo-root <絶対パス> --public-root <絶対パス> --out <絶対パス> \
//       --label <before|after> --scenes <名,名,...>
//
// <electron> はリポの node_modules/.bin/electron。どの引数も必須で既定値は無い。--repo-root の製品（app/src・data・content・assets）を、
// OS の一時ディレクトリに作った新しいプレイ（routing・場面ごとの案内人・装備一つとうちの子一人を足したセーブ）の上で、この process の
// 中に起こし、--public-root の app/public を配る（直す前の姿は、直す前の commit の app/public を書き出した木を渡して撮る）。LM は固定
// 応答（FIXTURE の表の閉じた集合）で、知らない要求は 500 にして撮影ごと止める。TEAM_* の環境変数が一つでもあれば止まる。
// --out の中の既存の file は上書きしない。撮った png は <out>/<label>-<窓>.png、窓ごとの行は <out>/<label>-rows.json。
// --label after の run で <out>/before-<窓>.png があれば、左に前・右に後を半分の大きさで並べた <out>/compare-<窓>.png も書く。
//
// 窓ごとの行: 閉じる釦の紋が揺り籠の閉じるの紋と同じ SVG か（outerHTML の一致）・窓の右上の角から釦の箱と紋の箱までの px・釦と紋の
// 計算済みの値（余白・紋の大きさ・不透明度・filter）と、実ポインタを乗せて 1 秒後の紋の不透明度・filter・窓の中の字と絵のうち閉じる
// 釦の箱に重なるもの・実ポインタで紋の中心を押して窓が閉じたか。見出しに印の紋を持つ帯では、釦の中心と印の紋の中心の縦の差と、
// 右上の角の置き場（見えている端から top 16px / right 22px）から釦が下へ動いた量と左へ動いた量も書く。揺り籠の行（窓は画面いっぱいの
// 揺り籠そのもの）を先頭に置く。
//
// 場面（scene）:
//   hub              露台（案内人 fallen_star）: 揺り籠・情報の帯 7・装備の小窓・案内人の窓。after では紋の並べた絵 icon-lineup.png も書く。
//   guide-<variant>  露台（案内人 <variant>）: 案内人の窓だけ（fallen_star 以外の 9 通り）。
//   academy-map      露台 → 学院マップ: 情報の帯・舞台の覗き・相手選び。相手を選んで入った会話の舞台の詳細（昼の会話の層の形）。
//   day              露台 → 依頼 → 依頼の会話: 情報の帯・舞台の詳細・会話の相手の窓。
//   homunculus       露台 → 錬成室 → うちの子の会話: うちの子の窓。
//   dungeon          露台 → 実践: 装備の小窓（入口）→ 一人で潜る → ヘルプ・主人公の詳しい窓。
//   arena            露台 → 闘技会 → 一人で立つ → 勝ち上がりの表の名 → 出場者の詳しい画面。
//   lounge           露台 → 談話室: 舞台の詳細・会話の相手の窓。
//   compare          （--label after で単独）撮らずに、<out> にある before-/after- の対から compare-<窓>.png だけを書く。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VIEWPORT = { width: 1440, height: 900 };
const HOST = '127.0.0.1';
const SETTLE_MS = 1500;
const LM_WAIT_MS = 120000;
const HOVER_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GUIDE_VARIANTS = ['bureau_apprentice', 'dethroned_constellation', 'scale_arbiter', 'pool_cat', 'far_side_sister', 'eclipse_shadow', 'hourglass_grain', 'star_egg_keeper', 'stardust_sweeper'];

function parseArgs(argv) {
  const known = ['--repo-root', '--public-root', '--out', '--label', '--scenes'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!known.includes(key)) throw new Error(`unexpected argument: ${key} (known: ${known.join(' ')})`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${key}`);
    if (parsed[key] !== undefined) throw new Error(`duplicate argument: ${key}`);
    parsed[key] = argv[i + 1];
  }
  for (const key of known) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  for (const key of ['--repo-root', '--public-root', '--out']) {
    if (!path.isAbsolute(parsed[key])) throw new Error(`${key} must be an absolute path, got ${parsed[key]}`);
  }
  const label = parsed['--label'];
  if (label !== 'before' && label !== 'after') throw new Error(`--label must be before or after, got ${JSON.stringify(label)}`);
  const scenes = parsed['--scenes'] === 'compare' ? [] : parsed['--scenes'].split(',');
  if (scenes.length === 0 && label !== 'after') throw new Error('--scenes compare is for --label after');
  for (const scene of scenes) if (!Object.hasOwn(SCENES, scene)) throw new Error(`unknown scene ${scene} (known: ${Object.keys(SCENES).join(' ')})`);
  return { repoRoot: parsed['--repo-root'], publicRoot: parsed['--public-root'], out: parsed['--out'], label, scenes };
}

// ── 製品と固定応答の LM ───────────────────────────────────────────────────────────────────────────────────
// 言葉は撮影のための仮の文（製品の本文ではない）。
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';
const FIXTURE_CHAT_LINE = '（顔を上げて）あ、こんにちは。ちょうど一息つこうと思っていたところです。';
const FIXTURE_REFLECTION_LINE = '学院で主人公と少し話した。';
const FIXTURE_OFFER_RECORDS = {
  errand_offer_record: {
    title: '書架の並べ替えの手伝い',
    situation: '書庫の長机に、背表紙の色ごとに分けた本が高く積まれている。',
    motivation: '書架の並べ替えを今週中に終えたいが、一人では手が足りない。'
  }
};
const FIXTURE_OFFER_APPEALS = [
  ['この依頼はすでに内容が確定している', 'ねえ、少しだけいいかな。書架の並べ替えを今週中に終えたいのだけど、一人では手が足りなくて困っているんだ。']
];
const FIXTURE_PROMPT_ANSWERS = [
  ['この依頼の達成条件が、ここまでの会話で満たされたかを判定する', 'false'],
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
  ['あなたは魔法学院の闘技会の場内アナウンスの地の文を綴る。', '夜の闘技場に篝火が揺れ、魔法陣の上で二つの影が向かい合う。']
];
function createFixtureLm(hubLines) {
  return function answer(body) {
    const prompt = body.messages.map((message) => message.content ?? '').join('\n');
    const schemaName = body.response_format?.json_schema?.name ?? null;
    if (schemaName === 'character_emotion_choice') return { kind: schemaName, content: JSON.stringify({ expression: 'neutral' }) };
    if (schemaName === 'work_record_recall_choice') return { kind: schemaName, content: JSON.stringify({ work_record_ids: [] }) };
    if (Object.hasOwn(FIXTURE_OFFER_RECORDS, schemaName)) return { kind: schemaName, content: JSON.stringify(FIXTURE_OFFER_RECORDS[schemaName]) };
    if (schemaName !== null) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    if (prompt.includes('destination_idを1つだけ返す')) {
      const matches = Object.entries(hubLines).filter(([, line]) => prompt.includes(line));
      if (matches.length > 1) throw new Error(`fixture lm: the hub conversation holds ${matches.length} destination lines`);
      return { kind: 'hub-destination', content: matches.length === 1 ? matches[0][0] : 'none' };
    }
    if (prompt.includes('これはイベントフラグ判定')) return { kind: 'event-flag', content: 'false' };
    for (const [marker, appeal] of FIXTURE_OFFER_APPEALS) if (prompt.includes(marker)) return { kind: 'offer-appeal', content: appeal };
    for (const [marker, content] of FIXTURE_PROMPT_ANSWERS) if (prompt.includes(marker)) return { kind: marker, content };
    if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) return { kind: 'chat-line', content: FIXTURE_CHAT_LINE };
    if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: FIXTURE_REFLECTION_LINE };
    throw new Error(`fixture lm: unknown request (model ${body.model}, stream ${body.stream === true}): ${prompt.slice(-160)}`);
  };
}

// 装備の小窓を開くための装備一つと、錬成室で会ううちの子一人（錬成室の場面だけ、錬成室の行き先が開く習熟度にする）。
const SEED_EQUIPMENT = [
  { instance_id: 'eq_w_fire', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2, quality: 'fine', name: '紅蓮の剣', flavor: '炎をまとう片手剣。', base_effects: { attack: 12 }, bonus_effects: { element_spell_power: 5 } }
];
const HOMUNCULUS_ID = 'homunculus_001';
async function seedSlot(slotRoot, scene) {
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: SEED_EQUIPMENT });
  if (scene === 'homunculus') {
    const entry = (label, value) => ({ min: 0, max: 100, label, value });
    await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', {
      magic: Object.fromEntries(['light', 'dark', 'fire', 'water', 'earth', 'wind'].map((key) => [key, entry(`${key}魔法習熟度`, 85)])),
      abilities: Object.fromEntries(['strength', 'agility', 'academics', 'magical_power', 'charisma'].map((key) => [key, entry(key, 50)]))
    });
  }
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
    parameters: { magic: { light: 72, dark: 30, fire: 55, water: 41, earth: 18, wind: 63 }, abilities: { strength: 44, agility: 60, academics: 51, magical_power: 77, charisma: 38 } }
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/flags.json`, { character_id: HOMUNCULUS_ID, flags: {} });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/skills.json`, { character_id: HOMUNCULUS_ID, skills: [] });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/memory`), { recursive: true });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/work_records`), { recursive: true });
}

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, () => resolve(server.address().port)); });
}
function closeServer(server) {
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
async function writeJson(root, relativePath, value) {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function startProduct(options, variant, scene) {
  const product = (relative) => import(path.join(options.repoRoot, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const { routingDestinations } = await product('routingDestinations.mjs');
  const hubLines = Object.fromEntries(routingDestinations.map((destination) => [destination.id, `今週は${destination.label}に行きたい。`]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'close-button-render-'));
  const closers = [];
  const lmFailures = [];
  try {
    await fs.cp(path.join(options.repoRoot, 'data/definitions'), path.join(root, 'data/definitions'), { recursive: true });
    await fs.cp(path.join(options.repoRoot, 'data/seeds'), path.join(root, 'data/seeds'), { recursive: true });
    await fs.cp(path.join(root, 'data/seeds/game_data'), path.join(root, 'data/mutable/game_data'), { recursive: true });
    await writeJson(root, runtimePathsManifestFilename, {
      configRoot: path.join(root, 'app/config'),
      definitionsRoot: path.join(root, 'data/definitions/game_data'),
      seedsRoot: path.join(root, 'data/seeds/game_data'),
      mutableRoot: path.join(root, 'data/mutable/game_data'),
      characterContentRoot: path.join(options.repoRoot, 'content/characters'),
      creatureContentRoot: path.join(options.repoRoot, 'content/creatures'),
      canonicalAssetsRoot: path.join(options.repoRoot, 'assets/canonical'),
      publicRoot: options.publicRoot,
      resourceRoot: root
    });
    const play = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: variant });
    await seedSlot(play.root, scene);
    const answer = createFixtureLm(hubLines);
    const lm = createHttpServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      let reply;
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
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const characters = [...reply.content];
      for (let index = 0; index < characters.length; index += 3) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: characters.slice(index, index + 3).join('') } }] })}\n\n`);
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
      publicRoot: options.publicRoot,
      canonicalAssetsRoot: path.join(options.repoRoot, 'assets/canonical'),
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
  const js = (expr) => win.webContents.executeJavaScript(expr);
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
        if (await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`)) return;
        await sleep(40);
      }
      throw new Error(`timed out waiting for ${label} (screen ${await js("document.querySelector('.screen.active')?.id ?? null").catch(() => '?')})`);
    },
    async pointerTo(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },
    async pressAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async click(selectorExpr, label) {
      const box = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!box || box.w === 0 || box.h === 0) throw new Error(`${label} is not on screen`);
      await page.pressAt(box.x, box.y);
    },
    async type(selectorExpr, label, text) {
      await page.click(selectorExpr, label);
      for (const character of text) {
        await send('Input.insertText', { text: character });
        await sleep(20);
      }
    },
    async png(clip = null) {
      const { data } = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png', captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    },
    close() {
      win.destroy();
    }
  };
  return page;
}

// ── 製品の通常の道 ─────────────────────────────────────────────────────────────────────────────────────────
const LOADING_ACTIVE = "document.body.classList.contains('academy-loading-screen-active')";
const VEIL_UP = "(document.querySelector('#place-veil') && !document.querySelector('#place-veil').hidden)";
const HUB_READY = `document.querySelector('#routing-hub-screen.active') && !${VEIL_UP} && !document.querySelector('#routing-hub-input').disabled && document.querySelector('#journey').dataset.journeyReady === 'true' && !!document.querySelector('#routing-hub-message-stream .message-speaker')`;
const arrived = (id) => `document.querySelector('#${id}.active') && !${LOADING_ACTIVE} && !${VEIL_UP}`;
const visible = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); })()`;

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
  await sleep(SETTLE_MS);
}

async function dispatchTo(ctx, id, screenId) {
  const { page } = ctx;
  await walkToHub(ctx);
  await page.type("document.querySelector('#routing-hub-input')", 'terrace input', ctx.product.hubLines[id]);
  await sleep(300);
  await page.click("document.querySelector('#routing-hub-send')", 'terrace send');
  await page.waitFor(arrived(screenId), `${screenId} arrived`, LM_WAIT_MS);
  await sleep(SETTLE_MS * 2);
}

// 開いた窓の動きを終わりへ送り、rAF 2 回を挟み、ポインタを退けてから撮る。
async function shoot(ctx, name) {
  const target = path.join(ctx.options.out, `${ctx.options.label}-${name}.png`);
  if (await fs.stat(target).then(() => true, () => false)) throw new Error(`refusing to overwrite ${target}`);
  await ctx.page.pointerTo(4, 4);
  await ctx.page.js('(async () => { for (const a of document.getAnimations()) { const t = a.effect?.getComputedTiming?.(); if (t && Number.isFinite(t.endTime)) a.finish(); } await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()');
  await sleep(400);
  const bytes = await ctx.page.png();
  if (bytes.readUInt32BE(16) !== VIEWPORT.width || bytes.readUInt32BE(20) !== VIEWPORT.height) throw new Error(`${name} is not ${VIEWPORT.width}x${VIEWPORT.height}`);
  await fs.writeFile(target, bytes);
  console.log(`shot ${path.basename(target)}`);
}

// 開いている窓の閉じる釦（読み上げの名「閉じる」で見えている一つ）と、窓の箱の右上の角からの間合い・紋・計算済みの値・中身との重なり。
const MEASURE = (rootSelector, windowSelector) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSelector)});
  const win = document.querySelector(${JSON.stringify(windowSelector)});
  if (!root || !win) return { error: 'missing root or window' };
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }); };
  const closers = [...root.querySelectorAll('button[aria-label="閉じる"]')].filter(shown);
  if (closers.length !== 1) return { error: 'visible close buttons: ' + closers.length };
  const button = closers[0];
  const svg = button.querySelector('svg');
  const cradleSvg = document.querySelector('#routing-hub-star-cradle button[data-routing-popup-close] svg');
  const r = button.getBoundingClientRect();
  const w = win.getBoundingClientRect();
  const s = svg ? svg.getBoundingClientRect() : null;
  const bs = getComputedStyle(button);
  const ss = svg ? getComputedStyle(svg) : null;
  const round = (n) => Math.round(n * 10) / 10;
  const describe = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const hits = (a) => a.right > r.left && a.left < r.right && a.bottom > r.top && a.top < r.bottom && a.width > 0 && a.height > 0;
  const overlaps = [];
  const windowArea = w.width * w.height;
  for (const el of win.querySelectorAll('*')) {
    if (button.contains(el) || !shown(el)) continue;
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (hits(rect)) overlaps.push(describe(el) + ' "' + node.textContent.trim().slice(0, 16) + '"');
    }
    if (el.classList.contains('night-band-figure-art')) continue;
    const media = el.tagName === 'IMG' || el.tagName.toLowerCase() === 'svg' || el.tagName === 'CANVAS';
    const rect = el.getBoundingClientRect();
    if (media && rect.width * rect.height < windowArea / 2 && hits(rect)) overlaps.push(describe(el) + ' (picture)');
  }
  // 夜の帯: 見えている端（溶ける幅の真ん中）からの間合いと、姿の絵（四辺を夜へ溶かす丸い mask）の、釦の箱の中での mask の最大の濃さ。
  const fade = win.classList.contains('night-band-card') ? parseFloat(getComputedStyle(win).getPropertyValue('--terrace-band-fade')) : null;
  const figure = win.querySelector('.night-band-figure-art');
  let figureMaskMax = null;
  if (figure && shown(figure)) {
    const f = figure.getBoundingClientRect();
    const rx = f.width / 2;
    const ry = Math.min(f.height * 0.46, f.height * 0.54);
    figureMaskMax = 0;
    for (let i = 0; i <= 10; i += 1) for (let j = 0; j <= 10; j += 1) {
      const x = r.left + (r.width * i) / 10;
      const y = r.top + (r.height * j) / 10;
      if (x < f.left || x > f.right || y < f.top || y > f.bottom) continue;
      const d = Math.hypot((x - (f.left + f.width / 2)) / rx, (y - (f.top + f.height * 0.46)) / ry);
      figureMaskMax = Math.max(figureMaskMax, d <= 0.58 ? 1 : d >= 1 ? 0 : (1 - d) / 0.42);
    }
    figureMaskMax = round(figureMaskMax * 100) / 100;
  }
  // 見出しの印の紋: 釦の中心との縦の差と、右上の角の置き場からの下・左への動き。
  const icon = win.querySelector(':scope > .night-band-header .night-band-icon');
  let iconAlign = null;
  if (icon && shown(icon)) {
    const i = icon.getBoundingClientRect();
    const iconCenterY = i.top + i.height / 2 - w.top;
    const buttonCenterY = r.top + r.height / 2 - w.top;
    iconAlign = { iconCenterY: round(iconCenterY), buttonCenterY: round(buttonCenterY), gap: round(buttonCenterY - iconCenterY), down: round(r.top - w.top - 16), left: round(w.right - fade / 2 - r.right - 22) };
  }
  return {
    fromVisibleEdge: fade === null ? null : { top: round(r.top - w.top), right: round(w.right - fade / 2 - r.right) },
    figureMaskMax,
    iconAlign,
    window: describe(win),
    windowBox: [round(w.left), round(w.top), round(w.width), round(w.height)],
    offsetParent: button.offsetParent ? describe(button.offsetParent) : null,
    text: button.textContent.trim(),
    className: button.className,
    sigil: svg ? svg.getAttribute('class') : null,
    sameSigilAsCradle: !!(svg && cradleSvg && svg !== cradleSvg && svg.outerHTML === cradleSvg.outerHTML) || (svg === cradleSvg),
    button: { top: round(r.top - w.top), right: round(w.right - r.right), width: round(r.width), height: round(r.height), padding: bs.padding },
    sigilBox: s ? { top: round(s.top - w.top), right: round(w.right - s.right), width: round(s.width), height: round(s.height) } : null,
    rest: ss ? { opacity: ss.opacity, filter: ss.filter } : { opacity: bs.opacity, filter: bs.filter, color: bs.color, background: bs.backgroundColor },
    overlaps,
    center: { x: s ? s.left + s.width / 2 : r.left + r.width / 2, y: s ? s.top + s.height / 2 : r.top + r.height / 2 }
  };
})()`;

// 窓を測り、撮り、実ポインタを紋に乗せて 1 秒後の灯りを読み、紋の中心を押して閉じたことを確かめる。
async function closeRow(ctx, name, { root, window: windowSelector, closed = `document.querySelector(${JSON.stringify(root)}).hidden === true`, shot = true }) {
  const { page } = ctx;
  if (shot) await shoot(ctx, name);
  else {
    await page.pointerTo(4, 4);
    await sleep(HOVER_MS);
  }
  const measured = await page.js(MEASURE(root, windowSelector));
  if (measured.error) throw new Error(`${name}: ${measured.error}`);
  await page.pointerTo(measured.center.x, measured.center.y);
  await sleep(HOVER_MS);
  const hover = await page.js(`(() => { const b = document.elementFromPoint(${measured.center.x}, ${measured.center.y})?.closest('button[aria-label="閉じる"]'); if (!b) return null; const svg = b.querySelector('svg'); const s = getComputedStyle(svg ?? b); return { opacity: s.opacity, filter: s.filter }; })()`);
  const hitOnClose = hover !== null;
  await page.pressAt(measured.center.x, measured.center.y);
  let closedAfter = true;
  try { await page.waitFor(closed, `${name} closed`, 4000); } catch { closedAfter = false; }
  const row = { name, ...measured, hover, hitOnClose, closedAfter };
  delete row.center;
  ctx.rows.push(row);
  console.log(`ROW ${JSON.stringify(row)}`);
  if (!hitOnClose || !closedAfter) ctx.failures.push(`${name}: hit ${hitOnClose} closed ${closedAfter}`);
  await sleep(600);
}

async function waitShown(ctx, selector, label) {
  await ctx.page.waitFor(visible(selector), label);
  await sleep(1200);
}

// ── 場面 ───────────────────────────────────────────────────────────────────────────────────────────────────
const CATEGORIES = ['self', 'buddy', 'enemy', 'inventory', 'money', 'diary', 'library'];

async function guideRow(ctx, variant) {
  await ctx.page.click("document.querySelector('#routing-hub-message-stream .message-speaker')", 'guide name');
  await ctx.page.waitFor("!document.querySelector('#routing-hub-character-popup').hidden && document.querySelector('#routing-hub-character-popup-standee').naturalWidth > 0", 'guide window');
  await sleep(1200);
  await closeRow(ctx, `guide-${variant}`, { root: '#routing-hub-character-popup', window: '#routing-hub-character-popup .night-band-card' });
}

const SCENES = {
  async hub(ctx) {
    const { page } = ctx;
    await walkToHub(ctx);
    await page.click("document.querySelector('#routing-hub-cradle-globe')", '天球儀');
    await waitShown(ctx, '#routing-hub-star-cradle', 'the star cradle');
    await page.waitFor("!!document.querySelector('#routing-hub-star-cradle-garden').children.length", 'the garden drawn');
    await sleep(1500);
    await closeRow(ctx, 'cradle', { root: '#routing-hub-star-cradle', window: '#routing-hub-star-cradle' });
    for (const category of CATEGORIES) {
      await page.click(`document.querySelector('.routing-hub-category-button[data-routing-category="${category}"]')`, category);
      await page.waitFor(`(() => { const p = document.querySelector('#routing-hub-info-popup'); return !p.hidden && p.dataset.category === '${category}'; })()`, `info ${category}`);
      await sleep(1200);
      if (category === 'self' && ctx.options.label === 'after') await iconLineup(ctx);
      if (category === 'inventory') {
        await page.waitFor("!!document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-owned-row')", 'owned equipment row');
        await shoot(ctx, 'info-inventory');
        await page.click("document.querySelector('#routing-hub-info-popup-body .routing-hub-info-equip-owned-row')", 'owned equipment row');
        await waitShown(ctx, '#routing-hub-equipment-popup .night-band-card', 'equipment window');
        await closeRow(ctx, 'equipment', { root: '#routing-hub-equipment-popup', window: '#routing-hub-equipment-popup .night-band-card' });
        await closeRow(ctx, 'info-inventory', { root: '#routing-hub-info-popup', window: '#routing-hub-info-popup .night-band-card', shot: false });
        continue;
      }
      await closeRow(ctx, `info-${category}`, { root: '#routing-hub-info-popup', window: '#routing-hub-info-popup .night-band-card' });
    }
    await guideRow(ctx, 'fallen_star');
  },
  async 'academy-map'(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'academy-map', 'academy-map-screen');
    await page.click("document.querySelector('.academy-map-category-button[data-am-category=\"self\"]')", '学院マップの自分の印');
    await waitShown(ctx, '#academy-map-info-popup .night-band-card', 'academy map band');
    await closeRow(ctx, 'academy-map-band', { root: '#academy-map-info-popup', window: '#academy-map-info-popup .night-band-card' });
    // 舞台の覗き（最初のピン）を閉じる紋で閉じ、相手選びは人のいる舞台のピン → ここに行く で開く。
    const PEEK_OPEN = "!document.querySelector('#ap-peek').hidden && document.querySelector('#ap-peek').classList.contains('is-open')";
    const PICK_OPEN = "!document.querySelector('#ap-pick').hidden && document.querySelector('#ap-pick').classList.contains('is-open') && document.querySelectorAll('#ap-pick .ap-pick-face').length > 0";
    await page.waitFor("document.querySelectorAll('.academy-map-node').length > 0", 'map pins');
    await page.click("document.querySelectorAll('.academy-map-node')[0]", 'pin 0');
    await page.waitFor(PEEK_OPEN, 'the peek');
    await sleep(1500);
    await closeRow(ctx, 'academy-map-peek', { root: '#ap-peek', window: '#ap-peek' });
    const pins = await page.js("document.querySelectorAll('.academy-map-node').length");
    let stagePin = null;
    for (let index = 0; index < pins && stagePin === null; index += 1) {
      await page.click(`document.querySelectorAll('.academy-map-node')[${index}]`, `pin ${index}`);
      await page.waitFor(PEEK_OPEN, `the peek of pin ${index}`);
      await sleep(900);
      if ((await page.js("document.querySelectorAll('#ap-peek .ap-peek-face').length")) > 0) {
        stagePin = index;
        break;
      }
      await page.click("document.querySelector('#ap-peek .ap-popup-veil')", 'peek veil');
      await page.waitFor("document.querySelector('#ap-peek').hidden", 'the peek closed');
      await sleep(600);
    }
    if (stagePin === null) throw new Error('no stage on the map had people to pick');
    await page.click("document.querySelector('#ap-peek .ap-way-go')", 'ここに行く');
    await page.waitFor(PICK_OPEN, 'the pick', LM_WAIT_MS);
    await sleep(1500);
    await closeRow(ctx, 'academy-map-pick', { root: '#ap-pick', window: '#ap-pick' });
    // 相手を選んで会話へ: 着いた舞台のピンをもう一度押し、相手選びを開き直す。
    await page.click(`document.querySelectorAll('.academy-map-node')[${stagePin}]`, `pin ${stagePin} again`);
    await page.waitFor(`(${PEEK_OPEN}) || (${PICK_OPEN})`, 'peek or pick again', LM_WAIT_MS);
    await sleep(1200);
    if (!(await page.js(PICK_OPEN))) {
      await page.click("document.querySelector('#ap-peek .ap-way-go')", 'ここに行く (again)');
      await page.waitFor(PICK_OPEN, 'the pick again', LM_WAIT_MS);
      await sleep(1200);
    }
    await page.click("document.querySelector('#ap-pick .ap-pick-face')", 'a companion');
    await page.waitFor(`${arrived('conversation-day-screen')} && !document.querySelector('#conversation-day-send').disabled`, 'the field conversation', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await stagePopupRow(ctx, 'field-stage');
  },
  async day(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'errand', 'academy-errand-screen');
    await page.click("document.querySelector('#academy-errand-offers .academy-errand-card-button')", 'first errand card');
    await page.waitFor(`${arrived('conversation-day-screen')} && !document.querySelector('#conversation-day-send').disabled`, 'the errand conversation', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await page.click("document.querySelector('.conversation-day-category-button[data-day-category=\"self\"]')", '昼の会話の自分の印');
    await waitShown(ctx, '#conversation-day-info-popup .night-band-card', 'day band');
    await closeRow(ctx, 'day-band', { root: '#conversation-day-info-popup', window: '#conversation-day-info-popup .night-band-card' });
    await stagePopupRow(ctx, 'day-stage');
    await page.click("document.querySelector('#cl-face .cl-face-well')", 'the partner face');
    await waitShown(ctx, '#conversation-day-character-popup .night-band-card', 'partner window');
    await page.waitFor("document.querySelector('#conversation-day-character-popup-standee').complete", 'partner standee');
    await sleep(800);
    await closeRow(ctx, 'day-partner', { root: '#conversation-day-character-popup', window: '#conversation-day-character-popup .night-band-card' });
  },
  async homunculus(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'homunculus', 'academy-atelier-screen');
    await page.waitFor("!!document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk')", 'the visit sigil');
    await page.click("document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk')", '会いに行く');
    await page.waitFor(`${arrived('conversation-day-screen')} && !document.querySelector('#conversation-day-send').disabled`, 'the atelier conversation', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await page.click("document.querySelector('#cl-face .cl-face-well')", 'the child face');
    await waitShown(ctx, '#conversation-day-homunculus-popup .night-band-card', 'child window');
    await closeRow(ctx, 'day-homunculus', { root: '#conversation-day-homunculus-popup', window: '#conversation-day-homunculus-popup .night-band-card' });
  },
  async dungeon(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'dungeon', 'academy-dungeon-screen');
    await page.waitFor("!document.querySelector('#dungeon-dive').disabled", 'the dungeon entrance');
    await page.click("document.querySelector('#dungeon-entry-kit button, #dungeon-entry-kit [role=\"button\"]')", 'the kit gear');
    await waitShown(ctx, '#dungeon-equip-modal .dn-modal-panel', 'kit window');
    await closeRow(ctx, 'dungeon-equip', { root: '#dungeon-equip-modal', window: '#dungeon-equip-modal .dn-modal-panel' });
    if (await page.js("document.querySelector('#dungeon-entry-companion-toggle')?.getAttribute('aria-pressed') === 'true'")) {
      await page.click("document.querySelector('#dungeon-entry-companion-toggle')", '同行者を外す');
      await sleep(600);
    }
    await page.click("document.querySelector('#dungeon-dive')", '潜る');
    await page.waitFor("document.querySelector('#dungeon-rail') && document.querySelector('#dungeon-help-button').getBoundingClientRect().width > 0 && document.querySelectorAll('#dungeon-party > *').length > 0", 'the dive', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await page.click("document.querySelector('#dungeon-help-button')", 'ヘルプ');
    await waitShown(ctx, '#dungeon-help-modal .dn-modal-panel', 'help window');
    await closeRow(ctx, 'dungeon-help', { root: '#dungeon-help-modal', window: '#dungeon-help-modal .dn-modal-panel' });
    await page.click("document.querySelector('#dungeon-party .dn-member--player .dn-member-name')", 'the hero name');
    await waitShown(ctx, '#dungeon-detail-modal .dn-modal-panel', 'detail window');
    await closeRow(ctx, 'dungeon-detail', { root: '#dungeon-detail-modal', window: '#dungeon-detail-modal .dn-modal-panel' });
  },
  async arena(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'arena', 'academy-arena-screen');
    await page.waitFor("document.querySelector('#academy-arena-screen').dataset.stage === 'selection' && document.querySelectorAll('#arena-selection-modes .arena-floor-spot').length === 3", 'the arena selection');
    await sleep(SETTLE_MS);
    await page.click("document.querySelector('#arena-selection-modes .arena-floor-spot[data-mode=\"solo\"]')", '一人の立ち位置');
    await page.waitFor("document.querySelector('#academy-arena-screen').dataset.stage === 'bracket' && !!document.querySelector('#academy-arena-screen .arena-name-button')", 'the bracket', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await page.click("[...document.querySelectorAll('#academy-arena-screen .arena-name-button')].find((b) => b.getBoundingClientRect().width > 0)", 'an entrant name');
    await waitShown(ctx, '#arena-actor-detail .actor-detail-panel', 'entrant detail');
    await page.waitFor("[...document.querySelectorAll('#arena-actor-detail img')].every((img) => img.complete)", 'entrant face');
    await closeRow(ctx, 'arena-detail', { root: '#arena-actor-detail', window: '#arena-actor-detail .actor-detail-panel' });
  },
  async lounge(ctx) {
    const { page } = ctx;
    await dispatchTo(ctx, 'lounge', 'academy-lounge-screen');
    await page.waitFor("!document.querySelector('#academy-lounge-input').disabled && !!document.querySelector('#academy-lounge-seats [data-character-id]')", 'the lounge talk', LM_WAIT_MS);
    await sleep(SETTLE_MS * 2);
    await page.click("document.querySelector('#academy-lounge-stage-name')", '談話室の舞台の名');
    await waitShown(ctx, '#academy-lounge-stage-popup .conversation-day-stage-popup-card', 'lounge stage window');
    await closeRow(ctx, 'lounge-stage', { root: '#academy-lounge-stage-popup', window: '#academy-lounge-stage-popup .conversation-day-stage-popup-card' });
    await page.click("[...document.querySelectorAll('#academy-lounge-seats [data-character-id]')].find((el) => el.getBoundingClientRect().width > 0)", 'a seat');
    await waitShown(ctx, '#academy-lounge-character-popup .conversation-day-character-popup-card', 'lounge partner window');
    await page.waitFor("document.querySelector('#academy-lounge-character-popup-standee').complete", 'lounge standee');
    await sleep(800);
    await closeRow(ctx, 'lounge-partner', { root: '#academy-lounge-character-popup', window: '#academy-lounge-character-popup .conversation-day-character-popup-card' });
  }
};
for (const variant of GUIDE_VARIANTS) {
  SCENES[`guide-${variant}`] = async (ctx) => {
    await walkToHub(ctx);
    await guideRow(ctx, variant);
  };
}
const SCENE_VARIANT = (name) => (name.startsWith('guide-') ? name.slice('guide-'.length) : 'fallen_star');

// 昼の会話の舞台の詳細（会話の見せ方の層の形では画面いっぱいの小窓・窓は小窓そのもの）。
async function stagePopupRow(ctx, name) {
  const { page } = ctx;
  const dressed = await page.js("document.querySelector('#conversation-day-screen').dataset.conversationKind !== undefined");
  await page.click(dressed ? "document.querySelector('#cl-stage-name')" : "document.querySelector('#conversation-day-stage-image')", '舞台の名');
  await waitShown(ctx, '#conversation-day-stage-popup', 'stage window');
  await closeRow(ctx, name, { root: '#conversation-day-stage-popup', window: dressed ? '#conversation-day-stage-popup' : '#conversation-day-stage-popup .conversation-day-stage-popup-card' });
}

// ── 並べた絵 ─────────────────────────────────────────────────────────────────────────────────────────────────
// 画像を一枚の窓の上に等倍（または指定の大きさ）で並べて撮る。
async function compose(file, size, items, background = 'rgb(5 6 15)') {
  const html = `<!doctype html><html><body style="margin:0;width:${size.width}px;height:${size.height}px;background:${background};position:relative;overflow:hidden;font:13px sans-serif;color:#cdd6ea">${items.map((item) => (item.src
    ? `<img src="${item.src}" style="position:absolute;left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px;image-rendering:auto">`
    : `<div style="position:absolute;left:${item.x}px;top:${item.y}px;width:${item.w}px">${item.text}</div>`)).join('')}</body></html>`;
  const page = path.join(os.tmpdir(), `close-button-compose-${process.pid}.html`);
  await fs.writeFile(page, html);
  const win = new BrowserWindow({ width: size.width, height: size.height, useContentSize: true, show: false });
  try {
    await win.loadFile(page);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map((img) => img.decode())).then(() => true)');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    if (await fs.stat(file).then(() => true, () => false)) throw new Error(`refusing to overwrite ${file}`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log(`composed ${path.basename(file)}`);
  } finally {
    win.destroy();
    await fs.rm(page, { force: true });
  }
}

// パネルの見出しの紋・左のドロワーの印・揺り籠の閉じる・新しい閉じるを、それぞれの箱の周り 12px ごと等倍で切り出して並べる。
async function iconLineup(ctx) {
  const { page } = ctx;
  const boxOf = (expr) => page.js(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: Math.round(r.left) - 12, y: Math.round(r.top) - 12, width: Math.round(r.width) + 24, height: Math.round(r.height) + 24 }; })()`);
  const parts = [
    ['パネルの見出しの紋', "document.querySelector('#routing-hub-info-popup-icon')"],
    ['左のドロワーの印', "document.querySelector('.routing-hub-category-button[data-routing-category=\"buddy\"]')"],
    ['新しい閉じる（帯）', "[...document.querySelectorAll('#routing-hub-info-popup button[aria-label=\"閉じる\"]')].find((b) => b.getBoundingClientRect().width > 0)"]
  ];
  await page.pointerTo(4, 4);
  await sleep(900);
  const clips = [];
  for (const [label, expr] of parts) {
    const box = await boxOf(expr);
    clips.push({ label, box, bytes: await page.png(box) });
  }
  // 揺り籠の閉じるは、揺り籠を開いて同じように切り出す（帯はいったん閉じる）。
  await page.click("[...document.querySelectorAll('#routing-hub-info-popup button[aria-label=\"閉じる\"]')].find((b) => b.getBoundingClientRect().width > 0)", 'band close');
  await page.waitFor("document.querySelector('#routing-hub-info-popup').hidden", 'band closed');
  await page.click("document.querySelector('#routing-hub-cradle-globe')", '天球儀');
  await waitShown(ctx, '#routing-hub-star-cradle', 'the star cradle');
  await page.js('(async () => { for (const a of document.getAnimations()) { const t = a.effect?.getComputedTiming?.(); if (t && Number.isFinite(t.endTime)) a.finish(); } return true; })()');
  await page.pointerTo(4, 4);
  await sleep(900);
  const cradleBox = await boxOf("document.querySelector('#routing-hub-star-cradle button[aria-label=\"閉じる\"]')");
  clips.splice(2, 0, { label: '揺り籠の閉じる', box: cradleBox, bytes: await page.png(cradleBox) });
  await page.click("document.querySelector('#routing-hub-star-cradle button[aria-label=\"閉じる\"]')", 'cradle close');
  await page.waitFor("document.querySelector('#routing-hub-star-cradle').hidden", 'cradle closed');
  await page.click("document.querySelector('.routing-hub-category-button[data-routing-category=\"self\"]')", 'self again');
  await page.waitFor("!document.querySelector('#routing-hub-info-popup').hidden", 'band again');
  await sleep(1200);
  let x = 24;
  const items = [];
  for (const clip of clips) {
    items.push({ src: `data:image/png;base64,${clip.bytes.toString('base64')}`, x, y: 40, w: clip.box.width, h: clip.box.height });
    items.push({ text: `${clip.label}<br>${clip.box.width - 24}×${clip.box.height - 24}px`, x, y: 48 + clip.box.height, w: 150 });
    x += Math.max(clip.box.width, 150) + 24;
  }
  await compose(path.join(ctx.options.out, 'icon-lineup.png'), { width: x, height: 200 }, items);
  ctx.lineup = clips.map((clip) => ({ label: clip.label, box: clip.box }));
}

async function compareShots(options) {
  const files = (await fs.readdir(options.out)).filter((file) => file.startsWith('after-') && file.endsWith('.png'));
  for (const file of files) {
    const name = file.slice('after-'.length, -'.png'.length);
    const before = path.join(options.out, `before-${name}.png`);
    if (!(await fs.stat(before).then(() => true, () => false))) continue;
    const half = { w: VIEWPORT.width / 2, h: VIEWPORT.height / 2 };
    await compose(path.join(options.out, `compare-${name}.png`), { width: VIEWPORT.width, height: half.h }, [
      { src: pathToFileURL(before).href, x: 0, y: 0, ...half },
      { src: pathToFileURL(path.join(options.out, file)).href, x: half.w, y: 0, ...half }
    ]);
  }
}

// ── 本体 ───────────────────────────────────────────────────────────────────────────────────────────────────
async function runScene(options, name) {
  const product = await startProduct(options, SCENE_VARIANT(name), name);
  const guard = () => {
    if (product.lmFailures.length > 0) throw new Error(`fixture LM answered 500: ${product.lmFailures.join(' | ')}`);
  };
  const page = await openPage(guard);
  const ctx = { options, product, page, rows: [], failures: [], lineup: null };
  const started = Date.now();
  try {
    await SCENES[name](ctx);
    guard();
    if (page.pageErrors.length > 0) throw new Error(`renderer errors: ${JSON.stringify(page.pageErrors)}`);
    console.log(`scene ${name} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return ctx;
  } finally {
    page.close();
    await product.stop();
  }
}

async function main() {
  const teamVars = Object.keys(process.env).filter((key) => key.startsWith('TEAM_'));
  if (teamVars.length > 0) throw new Error(`TEAM_* variables are set (${teamVars.join(' ')}); run with them unset`);
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(options.out, { recursive: true });
  await app.whenReady();
  const rows = [];
  const failures = [];
  let lineup = null;
  for (const name of options.scenes) {
    const ctx = await runScene(options, name);
    rows.push(...ctx.rows);
    failures.push(...ctx.failures);
    lineup ??= ctx.lineup;
  }
  if (options.scenes.length === 0) {
    await compareShots(options);
    return 0;
  }
  const rowsFile = path.join(options.out, `${options.label}-rows.json`);
  const previous = await fs.readFile(rowsFile, 'utf8').then((text) => JSON.parse(text), (error) => { if (error.code === 'ENOENT') return { rows: [] }; throw error; });
  await fs.writeFile(rowsFile, `${JSON.stringify({ label: options.label, rows: [...previous.rows, ...rows], lineup: lineup ?? previous.lineup ?? null }, null, 2)}\n`);
  if (options.label === 'after') await compareShots(options);
  console.log(`RESULT ${failures.length === 0 ? 'PASS' : 'FAIL'} (${rows.length - failures.length}/${rows.length} closed by a real pointer on the sigil)`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

app.on('window-all-closed', () => {});
main().then((code) => app.exit(code)).catch((error) => {
  console.error('FAILED', error.stack ?? error.message);
  app.exit(1);
});
