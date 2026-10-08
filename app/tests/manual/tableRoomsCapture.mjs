// 表の部屋（調合・工房・錬成室）を実描画（Electron の隠れた窓・1440x900・DPR 1）で撮り、構成案と並べる撮影の道具。
// `node --test` は app.js を描けないので、ここで本物の client を本物の Blink で動かす。*.test.mjs ではなく app/tests/manual/ に置く
// （npm test は拾わない）。手で走らせる:
//
//   <electron> app/tests/manual/tableRoomsCapture.mjs --out <空の置き場> --plan-dir <構成案の置き場>
//
// <electron> は依存を入れた checkout の node_modules/.bin/electron。どちらの引数も必須で既定値は無い。--plan-dir は構成案の
// plan-*.png を読むだけ（書かない）。--out には撮った絵・並べた絵・場面ごとの記録（見えている字の全数と要素の実測）を書き、
// 既にある file は上書きせずに止まる。
//
// 1. 製品を一時のセーブ（OS の一時ディレクトリに作った新しいプレイ・routing・案内人 fallen_star）で、この process の中に起こす。
//    撮る場面は LM に何も問わないので、LM の口はどの要求にも 500 を返して `fixture-lm 500:` を log に出し、撮り終えたあとに
//    1 件でもあれば撮影ごと止める。
// 2. 一時の slot にだけ錬成室の解錠と子 1 人（FIXTURE_HOMUNCULUS）を書き、撮影のための所持（燐光の砂 4・熾火の欠片 2・
//    しぶきの雫石 2・所持金 120 G — 構成案と同じ値）を置いてから、POST /api/slots/load でその slot を開く。錬成の箱の一枚だけは、
//    箱が開くように所持へ地脈の小礫 2 を足して slot を開き直す（SYNTHESIS_HOLD）。
// 3. 画面ごとに製品の dev の入口（?initialScreen=）で着く。通常のプレイ（タイトルのロード → 露台 → 送り出し）では製品が body に
//    play-mode を付けて上の帯を隠す。dev の入口は付けないので class だけを付け、帯が消えてから撮る。押す・打つは CDP の
//    実入力で行う。錬成室の失敗の姿は、子に会いに行く要求（POST /api/atelier/conversation/start）だけを CDP Fetch で落として起こす。
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST = '127.0.0.1';
const VIEWPORT = { width: 1440, height: 900 };
const COMPARE_GAP = 24;
const READY_TIMEOUT_MS = 60000;
const SETTLE_MS = 1500;
const WATCHDOG_MS = 900000;
// 撮影のための所持（構成案と同じ値。新しいプレイは所持 0・所持金 0 で、そのままでは全部の行が足りない姿になる）。
const HOLD = Object.freeze({ material_light_t1: 4, material_fire_t1: 2, material_water_t1: 2 });
const MONEY = 120;
// 錬成の箱は所持が要る数（10）に届かないと開かない（新たに錬成する が押せない）。箱を開いた一枚だけは、所持に地脈の小礫 2 を足して
// 開き、選ぶのは構成案と同じ 8 個（燐光の砂 4・熾火の欠片 2・しぶきの雫石 2）にする。
const SYNTHESIS_HOLD = Object.freeze({ ...HOLD, material_earth_t1: 2 });
const SYNTHESIS_INPUT = Object.freeze({ name: 'ノア', skeleton: '静かで、星の話をするときだけ早口になる。' });
// 使い方を説明する文として作り替えで無くした字（見えている字にこれが一つでも残れば失敗）。
const REMOVED_GUIDANCE = Object.freeze([
  'ダンジョンの素材を、ティアを問わず合計ちょうど',
  '使う系統を選んでください',
  '名前と、どんな子かの骨子を渡す',
  '名前だけ渡して、骨子はまかせる',
  '性格・雰囲気・話し方など、ゆるいスケッチ',
  'この子の名前',
  '素材・費用が足りません',
  'が生まれました。そのまま会いに行けます。'
]);

function parseArgs(argv) {
  const keys = ['--out', '--plan-dir'];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    if (!keys.includes(argv[i])) throw new Error(`unexpected argument ${argv[i]} (known: ${keys.join(' ')})`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    parsed[argv[i]] = path.resolve(argv[i + 1]);
    i += 1;
  }
  for (const key of keys) if (parsed[key] === undefined) throw new Error(`${key} is required (no default)`);
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

// 終わるときは、まだ開いている接続（閉じた窓の要求が残した socket など）を待たずに切ってから閉じる。
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

// 錬成室の子の人となりは撮影のための仮の文（製品の本文ではない）。
const FIXTURE_HOMUNCULUS = Object.freeze({
  homunculus_id: 'homunculus_001',
  display_name: 'ミルテ',
  face_id: 'hp_001',
  prompt_description: '錬成室の硝子の器から生まれたばかりの子。見るもの聞くものすべてが新しく、主人公の話を目を丸くして聞く。',
  speaking_basis: 'やわらかい丁寧語で、短い文をゆっくり話す。わからない言葉はそのまま聞き返す。'
});

// 一時の slot にだけ、錬成室の解錠（光魔法の習熟を解錠の閾値へ）と子 1 人を書く。
async function prepareAtelier(slotRoot) {
  const product = (relative) => import(path.join(PROJECT_ROOT, 'app/src', relative));
  const { createStorageApi } = await product('storage.mjs');
  const { faceExpressions } = await product('faceExpressions.mjs');
  const { generateHomunculusParameters } = await product('homunculusAtelier.mjs');
  const { appendActiveHomunculus } = await product('homunculusSurface.mjs');
  const { HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD } = await product('homunculusUnlock.mjs');
  const { requireRoutingContentWeek } = await product('routingContentResult.mjs');
  const storage = createStorageApi({ root: slotRoot });
  const playerParameters = await storage.readJson('game_data/runtime/player_parameters.json');
  const state = await storage.readJson('game_data/runtime_state.json');
  const { homunculus_id: homunculusId, display_name: displayName, face_id: faceId } = FIXTURE_HOMUNCULUS;
  await appendActiveHomunculus({
    storage,
    entry: { homunculus_id: homunculusId, display_name: displayName, face_id: faceId, created_week: requireRoutingContentWeek(state) }
  });
  await storage.writeJson(`game_data/homunculi/${homunculusId}/profile.json`, {
    character_id: homunculusId,
    display_name: displayName,
    visual_set_id: faceId,
    prompt_description: FIXTURE_HOMUNCULUS.prompt_description,
    speaking_basis: FIXTURE_HOMUNCULUS.speaking_basis,
    available_expressions: [...faceExpressions],
    parameters: generateHomunculusParameters({ playerParameters, materials: [], rng: () => 0.5 })
  });
  await storage.writeJson(`game_data/homunculi/${homunculusId}/flags.json`, { character_id: homunculusId, flags: {} });
  await storage.writeJson(`game_data/homunculi/${homunculusId}/skills.json`, { character_id: homunculusId, skills: [] });
  playerParameters.magic.light.value = HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD;
  await storage.writeJson('game_data/runtime/player_parameters.json', playerParameters);
  return { homunculus_id: homunculusId, display_name: displayName };
}

// 一時のセーブ・何にも答えない LM・製品サーバーを、この process の中に起こす。
async function startProduct() {
  const product = (relative) => import(path.join(PROJECT_ROOT, 'app/src', relative));
  const { createServer } = await product('server.mjs');
  const { runtimePathsManifestFilename } = await product('runtimePaths.mjs');
  const { initializeNewPlayArea } = await product('playSession.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'table-rooms-capture-'));
  const closers = [];
  const failures = [];
  try {
    await fs.cp(path.join(PROJECT_ROOT, 'data/definitions'), path.join(root, 'data/definitions'), { recursive: true });
    await fs.cp(path.join(PROJECT_ROOT, 'data/seeds'), path.join(root, 'data/seeds'), { recursive: true });
    await fs.cp(path.join(root, 'data/seeds/game_data'), path.join(root, 'data/mutable/game_data'), { recursive: true });
    await writeJson(root, runtimePathsManifestFilename, {
      configRoot: path.join(root, 'app/config'),
      definitionsRoot: path.join(root, 'data/definitions/game_data'),
      seedsRoot: path.join(root, 'data/seeds/game_data'),
      mutableRoot: path.join(root, 'data/mutable/game_data'),
      characterContentRoot: path.join(PROJECT_ROOT, 'content/characters'),
      creatureContentRoot: path.join(PROJECT_ROOT, 'content/creatures'),
      canonicalAssetsRoot: path.join(PROJECT_ROOT, 'assets/canonical'),
      publicRoot: path.join(PROJECT_ROOT, 'app/public'),
      resourceRoot: root
    });
    const play = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: 'fallen_star' });
    const lm = createHttpServer((req, res) => {
      failures.push(`${req.method} ${req.url}`);
      console.error(`fixture-lm 500: ${req.method} ${req.url}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'the table-room scenes ask the LM nothing' }));
    });
    const lmPort = await listen(lm);
    closers.push(() => closeServer(lm));
    await writeJson(root, 'app/config/lmstudio.json', {
      provider: 'lmstudio',
      base_url: `http://${HOST}:${lmPort}/v1`,
      chat_model: 'capture-chat',
      reflection_model: 'capture-reflection',
      timeout_ms: 120000,
      stream: true,
      thinking_effort: null,
      mock_provider_enabled: false
    });
    const server = createServer({
      root,
      publicRoot: path.join(PROJECT_ROOT, 'app/public'),
      canonicalAssetsRoot: path.join(PROJECT_ROOT, 'assets/canonical'),
      playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
      conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
      audioSettingsPath: path.join(root, 'app/config/audio.json'),
      lmStudioConfigPath: path.join(root, 'app/config/lmstudio.json')
    });
    const port = await listen(server);
    closers.push(() => closeServer(server));
    console.log(`product slot ${play.slot.slot_id} isolated root: ${root}`);
    return {
      url: `http://${HOST}:${port}/`,
      root,
      slotId: play.slot.slot_id,
      slotRoot: play.root,
      assertNoLmFailure() { if (failures.length) throw new Error(`fixture LM answered 500: ${failures.join(' | ')}`); },
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

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} answered ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function seedHoldings(product, hold) {
  const { resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));
  const slotRoot = resolveSlotProjectRoot(product.root, product.slotId);
  const inventoryPath = path.join(slotRoot, 'game_data/player_inventory.json');
  await fs.access(path.join(slotRoot, 'game_data/runtime_state.json'));
  const inventory = { money: MONEY, items: Object.entries(hold).map(([item_id, quantity]) => ({ item_id, quantity })), applied_money_delta_conversation_ids: [] };
  await fs.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventoryPath;
}

// ── 窓の中で走る関数（文字列にして executeJavaScript へ渡す） ─────────────────────────────────────────────
// 見えている字の全数: 画面に描かれた text node（矩形が窓の内側・祖先の不透明度の積が 0.05 超）と、値のある入力欄。
// スクロールする入れ物の外へ出た字は数えず、行の帳面の下の溶け（56px）に掛かる字は faded と印を付ける。
function pageVisibleTexts(scope) {
  const root = document.querySelector(scope);
  const out = [];
  const visibleOpacity = (element) => {
    let opacity = 1;
    for (let at = element; at && at !== document.documentElement; at = at.parentElement) opacity *= Number(getComputedStyle(at).opacity);
    return opacity;
  };
  const clipOf = (element) => {
    for (let at = element.parentElement; at && at !== root; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (/(auto|scroll|hidden)/.test(style.overflowY)) return at;
    }
    return null;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (!text) continue;
    const parent = node.parentElement;
    if (getComputedStyle(parent).visibility === 'hidden') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    let rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
    const clip = clipOf(parent);
    const clipBox = clip ? clip.getBoundingClientRect() : null;
    if (clipBox) rects = rects.filter((rect) => rect.top < clipBox.bottom && rect.bottom > clipBox.top);
    if (rects.length === 0) continue;
    const opacity = visibleOpacity(parent);
    if (opacity <= 0.05) continue;
    const faded = Boolean(clip && clip.classList.contains('table-room-rows') && rects.some((rect) => rect.bottom > clipBox.bottom - 56));
    out.push({ text, element: `${parent.tagName.toLowerCase()}.${String(parent.className)}`, color: getComputedStyle(parent).color, faded, box: [rects[0].left, rects[0].top, rects[0].right, rects[0].bottom].map(Math.round) });
  }
  for (const input of root.querySelectorAll('input[type="text"]')) {
    const rect = input.getBoundingClientRect();
    if (!input.value || rect.width === 0) continue;
    out.push({ text: input.value, element: `input.${input.className}`, color: getComputedStyle(input).color, faded: false, box: [rect.left, rect.top, rect.right, rect.bottom].map(Math.round) });
  }
  return out;
}

// 要素の実測（照合の表の材料）: 個数・並び（左上から）・矩形。
function pageMeasure(screenSelector) {
  const screen = document.querySelector(screenSelector);
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return [rect.left, rect.top, rect.right, rect.bottom].map(Math.round);
  };
  const shown = (element) => element.getClientRects().length > 0 && element.getBoundingClientRect().height > 0;
  const named = (element) => element.getAttribute('aria-label') ?? element.querySelector('[aria-label]')?.getAttribute('aria-label') ?? element.textContent.trim();
  const table = screen.querySelector('.table-room-table');
  const tableStyle = getComputedStyle(table, '::before');
  const rows = [...screen.querySelectorAll('.table-room-rows > li')].filter(shown);
  const firstRow = rows[0];
  return {
    screen: screenSelector,
    activeScreen: document.querySelector('.screen.active')?.id ?? null,
    bodyPlayMode: document.body.classList.contains('play-mode'),
    groundArt: getComputedStyle(screen.querySelector('.table-room-stage')).backgroundImage,
    groundSize: getComputedStyle(screen.querySelector('.table-room-stage')).backgroundSize,
    groundPosition: getComputedStyle(screen.querySelector('.table-room-stage')).backgroundPosition,
    placeName: { text: screen.querySelector('.table-room-place-name').textContent, box: box(screen.querySelector('.table-room-place-name')) },
    status: { hidden: screen.querySelector('.table-room-status').hidden, glyph: Boolean(screen.querySelector('.table-room-status .routing-failure-glyph')), text: screen.querySelector('.table-room-status').textContent, box: box(screen.querySelector('.table-room-status')) },
    exit: { name: screen.querySelector('.table-room-exit').getAttribute('aria-label'), box: box(screen.querySelector('.table-room-exit')) },
    table: box(table),
    pool: { inset: tableStyle.inset, background: tableStyle.backgroundColor, radius: tableStyle.borderRadius },
    filters: [...screen.querySelectorAll('.table-room-filter')].map((group) => ({ group: group.getAttribute('aria-label'), buttons: [...group.children].map((button) => ({ name: named(button), pressed: button.getAttribute('aria-pressed'), box: box(button) })) })),
    purse: screen.querySelector('.table-room-purse') ? { text: screen.querySelector('.table-room-purse').textContent, box: box(screen.querySelector('.table-room-purse')) } : null,
    rows: { visible: rows.length, total: screen.querySelectorAll('.table-room-rows > li').length, affordable: rows.filter((row) => !row.dataset.lack).length, inView: rows.filter((row) => row.getBoundingClientRect().top < innerHeight).length },
    firstRowCells: firstRow ? [...firstRow.querySelectorAll('.table-room-cell')].map((cell) => ({ className: cell.className, text: cell.textContent.trim(), marks: [...cell.querySelectorAll('[role="img"], button[aria-label]')].map(named), box: box(cell) })) : [],
    firstRowGoldLine: firstRow ? getComputedStyle(firstRow.querySelector('.table-room-row-body')).boxShadow : null,
    atelier: screen.id === 'academy-atelier-screen' ? {
      roomHidden: screen.querySelector('#academy-atelier-room').hidden,
      synthesisHidden: screen.querySelector('#academy-atelier-synthesis-form').hidden,
      synthesizeOpen: { name: screen.querySelector('#academy-atelier-synthesize-open').getAttribute('aria-label'), disabled: screen.querySelector('#academy-atelier-synthesize-open').disabled, box: box(screen.querySelector('#academy-atelier-synthesize-open')) },
      materialCount: { text: screen.querySelector('#academy-atelier-material-count').textContent, short: screen.querySelector('#academy-atelier-material-count').dataset.short, color: getComputedStyle(screen.querySelector('#academy-atelier-material-count')).color, box: box(screen.querySelector('#academy-atelier-material-count')) },
      slots: [...screen.querySelectorAll('#academy-atelier-slots > li')].map((slot) => ({
        empty: slot.classList.contains('academy-atelier-slot--empty'),
        emptyArt: slot.querySelector('.academy-atelier-slot-empty-art')?.getAttribute('aria-label') ?? null,
        name: slot.querySelector('.academy-atelier-slot-name')?.textContent ?? null,
        parameters: [...slot.querySelectorAll('.academy-atelier-parameter')].map((item) => `${item.querySelector('[aria-label]')?.getAttribute('aria-label')} ${item.querySelector('.academy-atelier-parameter-value').textContent}`),
        actions: [...slot.querySelectorAll('.academy-atelier-slot-actions button')].map((button) => ({ name: button.getAttribute('aria-label'), disabled: button.disabled, title: button.title || null })),
        box: box(slot)
      })),
      shelf: { name: screen.querySelector('.academy-atelier-shelf-name').textContent, emptyArt: screen.querySelector('#academy-atelier-nameplates-empty').hidden ? null : screen.querySelector('#academy-atelier-nameplates-empty').getAttribute('aria-label'), emptyArtBox: box(screen.querySelector('#academy-atelier-nameplates-empty')), nameplates: screen.querySelectorAll('#academy-atelier-nameplates > li').length },
      synthesis: screen.querySelector('#academy-atelier-synthesis-form').hidden ? null : {
        modes: [...screen.querySelectorAll('.academy-atelier-mode')].map((mode) => ({ name: mode.textContent.trim(), checked: mode.querySelector('input').checked })),
        name: screen.querySelector('#academy-atelier-name-input').value,
        namePlaceholder: screen.querySelector('#academy-atelier-name-input').placeholder,
        skeleton: screen.querySelector('#academy-atelier-skeleton-input').value,
        skeletonPlaceholder: screen.querySelector('#academy-atelier-skeleton-input').placeholder,
        gridTiers: [...screen.querySelectorAll('.academy-atelier-grid-tier')].map((tier) => tier.textContent),
        gridElements: [...screen.querySelectorAll('.academy-atelier-grid-element')].map((sigil) => sigil.getAttribute('aria-label')),
        cells: screen.querySelectorAll('.academy-atelier-material').length,
        picked: [...screen.querySelectorAll('.academy-atelier-material--selected')].map((cell) => `${cell.querySelector('.academy-atelier-material-name').textContent} ${cell.querySelector('.academy-atelier-material-qty').textContent}`),
        total: { text: screen.querySelector('#academy-atelier-materials-total').textContent, short: screen.querySelector('#academy-atelier-materials-total').dataset.short },
        cancel: screen.querySelector('#academy-atelier-synthesis-cancel').getAttribute('aria-label'),
        submit: { name: screen.querySelector('#academy-atelier-synthesis-submit').getAttribute('aria-label'), disabled: screen.querySelector('#academy-atelier-synthesis-submit').disabled }
      }
    } : null
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const watchdog = setTimeout(() => { console.error(`tableRoomsCapture: no result within ${WATCHDOG_MS} ms`); app.exit(2); }, WATCHDOG_MS);
  await fs.mkdir(args['--out'], { recursive: true });
  const present = await fs.readdir(args['--out']);
  if (present.length) throw new Error(`${args['--out']} is not empty (${present.join(', ')}); move them away before shooting again`);
  const write = (name, bytes) => fs.writeFile(path.join(args['--out'], name), bytes, { flag: 'wx' });
  const runStarted = Date.now();

  const product = await startProduct();
  let win = null;
  try {
    const child = await prepareAtelier(product.slotRoot);
    console.log(`atelier child ${child.homunculus_id} ${child.display_name}`);
    console.log(`holdings ${await seedHoldings(product, HOLD)}`);
    await postJson(new URL('/api/slots/load', product.url), { slot_id: product.slotId });
    console.log(`loaded ${product.slotId}`);

    await app.whenReady();
    win = new BrowserWindow({ show: false, width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, webPreferences: { backgroundThrottling: false } });
    const contents = win.webContents;
    contents.setAudioMuted(true);
    let consoleErrors = [];
    contents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.log(`renderer[${level}]: ${message}`);
      if (level >= 3) consoleErrors.push(message);
    });
    await win.loadURL('about:blank');
    contents.debugger.attach('1.3');
    const send = (method, params = {}) => contents.debugger.sendCommand(method, params);
    await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const js = (source) => contents.executeJavaScript(source);
    const call = (fn, ...fnArgs) => js(`(${fn.toString()})(${fnArgs.map((value) => JSON.stringify(value)).join(', ')})`);

    async function waitFor(expression, label) {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        if (await js(expression)) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(200);
      }
    }

    // 隠れた窓は直前の合成のコマを返すことがある: 2 フレーム待ち・invalidate・捨て撮りを挟む。
    async function shot() {
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      contents.invalidate();
      await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await sleep(400);
      const png = Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
      const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) throw new Error(`shot is ${size.width}x${size.height}`);
      return png;
    }

    // CDP の実クリック（要素の中心）。押す先が覆われていれば、その点で一番上にある要素が押す先と違うので止まる。
    async function click(selector) {
      const point = await call((target) => {
        const element = document.querySelector(target);
        if (!element) return { error: `missing ${target}` };
        element.scrollIntoView({ block: 'nearest' });
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const top = document.elementFromPoint(x, y);
        if (!top || !(top === element || element.contains(top))) return { error: `${target} is covered by ${top?.tagName}.${top?.className}` };
        return { x, y };
      }, selector);
      if (point.error) throw new Error(point.error);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      }
      await sleep(120);
    }

    async function typeInto(selector, text) {
      await click(selector);
      await send('Input.insertText', { text });
    }

    async function arrive(screen) {
      const url = new URL(product.url);
      url.searchParams.set('initialScreen', screen.initial);
      await win.loadURL(url.href);
      await waitFor(screen.ready, `${screen.initial} arrival`);
      // 起動の連なりの終わりに入口の画面が出し直されることがある: 静まってから着いた印をもう一度確かめる。
      await sleep(SETTLE_MS);
      if (!(await js(screen.ready))) throw new Error(`${screen.initial} did not stay arrived`);
      await js("document.body.classList.add('play-mode')");
      await waitFor("getComputedStyle(document.querySelector('.topbar')).display === 'none' && getComputedStyle(document.documentElement).getPropertyValue('--runtime-topbar-height').trim() === '0px'", `${screen.initial} play-mode layout`);
      const viewport = await js('[innerWidth, innerHeight, devicePixelRatio]');
      if (viewport.join('x') !== `${VIEWPORT.width}x${VIEWPORT.height}x1`) throw new Error(`viewport is ${viewport.join('x')}, not 1440x900 at DPR 1`);
      await sleep(400);
    }

    const ALCHEMY = { initial: 'academy-alchemy', selector: '#academy-alchemy-screen', ready: "Boolean(document.querySelector('#academy-alchemy-screen.active')) && document.querySelectorAll('#academy-alchemy-recipes > li').length === 56" };
    const WORKSHOP = { initial: 'academy-workshop', selector: '#academy-workshop-screen', ready: "Boolean(document.querySelector('#academy-workshop-screen.active')) && document.querySelectorAll('#academy-workshop-recipes > li').length === 96" };
    const ATELIER = { initial: 'academy-atelier', selector: '#academy-atelier-screen', ready: "Boolean(document.querySelector('#academy-atelier-screen.active')) && document.querySelectorAll('#academy-atelier-slots > li').length === 3 && [...document.querySelectorAll('#academy-atelier-slots img')].every((img) => img.naturalWidth > 0)" };

    const scenes = [
      { name: 'alchemy', plan: 'plan-alchemy.png', screen: ALCHEMY },
      { name: 'alchemy-choice', plan: 'plan-alchemy-choice.png', screen: ALCHEMY, act: async () => {
        await click('#academy-alchemy-filter [data-category="product"]');
        await waitFor("document.querySelector('#academy-alchemy-filter [data-category=\"product\"]').getAttribute('aria-pressed') === 'true'", 'the 換金品 filter');
      } },
      { name: 'workshop', plan: 'plan-workshop.png', screen: WORKSHOP },
      { name: 'atelier', plan: 'plan-atelier.png', screen: ATELIER },
      { name: 'atelier-failure', plan: 'plan-atelier-failure.png', screen: ATELIER, expectsConsoleErrors: true, act: async () => {
        // 子に会いに行く要求だけを、server へ届く前に落とす（server の状態は汚れない）。
        const failed = [];
        const onMessage = (_event, method, params) => {
          if (method !== 'Fetch.requestPaused') return;
          failed.push(params.request.url);
          send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionRefused' }).catch((error) => console.error(error));
        };
        contents.debugger.on('message', onMessage);
        await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/atelier/conversation/start*', requestStage: 'Request' }] });
        try {
          await click('#academy-atelier-slots .academy-atelier-slot-talk');
          await waitFor("Boolean(document.querySelector('#academy-atelier-screen.active #academy-atelier-status .routing-failure-glyph')) && !document.querySelector('#academy-loading-screen.active') && document.querySelectorAll('#academy-atelier-slots > li').length === 3 && [...document.querySelectorAll('#academy-atelier-slots img')].every((img) => img.naturalWidth > 0)", 'the atelier failure landing');
          await sleep(SETTLE_MS);
        } finally {
          await send('Fetch.disable');
          contents.debugger.removeListener('message', onMessage);
        }
        if (failed.length !== 1) throw new Error(`expected one failed conversation start, got ${JSON.stringify(failed)}`);
        return { failedRequests: failed };
      } },
      { name: 'atelier-synthesis', plan: 'plan-atelier-synthesis.png', screen: ATELIER, before: async () => {
        await seedHoldings(product, SYNTHESIS_HOLD);
        await postJson(new URL('/api/slots/load', product.url), { slot_id: product.slotId });
        return { hold: SYNTHESIS_HOLD };
      }, act: async () => {
        await click('#academy-atelier-synthesize-open');
        await waitFor("!document.querySelector('#academy-atelier-synthesis-form').hidden", 'the synthesis box');
        await typeInto('#academy-atelier-name-input', SYNTHESIS_INPUT.name);
        await typeInto('#academy-atelier-skeleton-input', SYNTHESIS_INPUT.skeleton);
        for (const [itemId, quantity] of Object.entries(HOLD)) {
          for (let i = 0; i < quantity; i += 1) await click(`.academy-atelier-material[data-item-id="${itemId}"] .academy-atelier-material-step--plus`);
        }
        await call(() => document.activeElement.blur());
      } }
    ];

    const timings = [];
    const records = {};
    for (const scene of scenes) {
      const started = Date.now();
      consoleErrors = [];
      const beforeResult = scene.before ? await scene.before() : null;
      await arrive(scene.screen);
      const actResult = scene.act ? await scene.act() : null;
      await sleep(400);
      const png = await shot();
      await write(`built-${scene.name}.png`, png);
      const texts = await call(pageVisibleTexts, scene.screen.selector);
      const measure = await call(pageMeasure, scene.screen.selector);
      const leftover = texts.filter((record) => REMOVED_GUIDANCE.some((phrase) => record.text.includes(phrase)));
      if (leftover.length) throw new Error(`${scene.name}: removed guidance is still on screen: ${JSON.stringify(leftover)}`);
      if (consoleErrors.length && !scene.expectsConsoleErrors) throw new Error(`${scene.name}: renderer errors ${JSON.stringify(consoleErrors)}`);
      const oneSource = await js(`import('/hubTerrace.js').then((terrace) => terrace.destinationArt(${JSON.stringify({ 'academy-alchemy': 'alchemy', 'academy-workshop': 'workshop', 'academy-atelier': 'homunculus' }[scene.screen.initial])}))`);
      const record = { scene: scene.name, url: await js('location.href'), destinationArt: oneSource, before: beforeResult, act: actResult, consoleErrors, visibleTexts: texts, measure };
      records[scene.name] = record;
      await write(`built-${scene.name}.json`, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`built-${scene.name}.png texts=${texts.length} rows=${measure.rows.visible} ground=${measure.groundArt}`);

      // 左に構成案・右に作った姿を並べる。
      const planPng = await fs.readFile(path.join(args['--plan-dir'], scene.plan));
      const compare = await js(`(async () => {
        const load = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
        const [a, b] = await Promise.all([load('data:image/png;base64,${planPng.toString('base64')}'), load('data:image/png;base64,${png.toString('base64')}')]);
        const canvas = document.createElement('canvas');
        canvas.width = ${VIEWPORT.width * 2 + COMPARE_GAP};
        canvas.height = ${VIEWPORT.height};
        const context = canvas.getContext('2d');
        context.fillStyle = '#05060f';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(a, 0, 0);
        context.drawImage(b, ${VIEWPORT.width + COMPARE_GAP}, 0);
        return canvas.toDataURL('image/png');
      })()`);
      await write(`compare-${scene.name}.png`, Buffer.from(compare.split(',')[1], 'base64'));

      // 載せ直した手がかり（素材の値・空の棚）を、錬成室の着いた直後の一枚の上で名指す。
      if (scene.name === 'atelier') {
        const cues = [
          { label: '素材の値', box: measure.atelier.materialCount.box },
          { label: '空の棚', box: measure.atelier.shelf.emptyArtBox }
        ];
        const marked = await js(`(async () => {
          const img = new Image();
          img.src = 'data:image/png;base64,${png.toString('base64')}';
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = ${VIEWPORT.width};
          canvas.height = ${VIEWPORT.height};
          const context = canvas.getContext('2d');
          context.drawImage(img, 0, 0);
          context.strokeStyle = '#ff4fd8';
          context.fillStyle = '#ff4fd8';
          context.lineWidth = 3;
          context.font = '600 18px sans-serif';
          for (const cue of ${JSON.stringify(cues)}) {
            const [left, top, right, bottom] = cue.box;
            context.strokeRect(left - 8, top - 8, right - left + 16, bottom - top + 16);
            context.fillText(cue.label, left - 8, bottom + 30);
          }
          return canvas.toDataURL('image/png');
        })()`);
        await write('built-atelier-cues.png', Buffer.from(marked.split(',')[1], 'base64'));
      }
      timings.push({ scene: scene.name, seconds: Math.round((Date.now() - started) / 100) / 10 });
    }
    product.assertNoLmFailure();
    const summary = { hold: HOLD, money: MONEY, synthesisInput: SYNTHESIS_INPUT, timings, totalSeconds: Math.round((Date.now() - runStarted) / 100) / 10 };
    await write('capture-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`timings ${JSON.stringify(timings)} total ${summary.totalSeconds} s`);
  } finally {
    if (win) win.destroy();
    await product.stop();
    console.log('product stopped');
    clearTimeout(watchdog);
  }
}

app.on('window-all-closed', () => {});
main().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
