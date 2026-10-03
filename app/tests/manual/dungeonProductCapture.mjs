// Capture of the product's ダンジョン for the polish before delivery (FS-20260929-03, the aim's reach, the large window's boundary
// and the equipment window's word), rendered for real, in one run — only what the polish changed:
//
// - 照準 (state-aiming): the fire great blast armed and the pointer on a landing cell, before the polish (POLISH_BASE, extracted)
//   and after (the repo), at 1440×900 and at the maximised window of a 1920×1080 display (MAX1920). After: no mark on a cell never
//   seen, no filled surface over the board, and the pointed cell marked.
// - 歩く・戦う・同行者が話す at MAX1920. 歩く and 同行者が話す are walked at 1440×900 first without a still, since the other size
//   replays the turn and the steps walked there.
// - The entry's equipment window after the polish at MAX1920 (the breakdown's title in the world's word), the entry inside the window.
// - Every size (1920×1080, MAX1920, 1440×900, the two MacBook windows, 860×900): the board's window and the cell in px, before the
//   polish and after, one line each; the cells fully inside the board's window against the product before the replacement at that
//   size; every rail label on one line; no two tokens overlapping in any settled frame or still.
//   Every walk's scene is checked against the server's answers and what the page drew; one failure stops the run.
//
// Run by hand (not *.test.mjs, so `npm test` skips it; it takes about twenty minutes):
//
//   env -u TEAM_ROOT -u TEAM_QUEUE_DIR -u TEAM_STATE_DIR -u TEAM_CONFIG_FILE ... \
//     ./node_modules/.bin/electron app/tests/manual/dungeonProductCapture.mjs \
//     --repo-root <absolute repo root> --out-dir <absolute publication directory>
//
// Both arguments are required and absolute; the out dir is absent or empty; the repo must be clean (the manifest records the
// commit it was taken from). Any TEAM_* variable in the environment stops the run (the product must not see the team's queue).
//
// WHAT IS REAL AND WHAT IS A FIXTURE
// - Every walk gets its own OS-temp loop slot (data/definitions and data/seeds copied in, the seeds as the mutable state; the
//   repo's data/mutable is neither read nor written) and the real product server (app/src/server.mjs createServer) on it,
//   serving the real app/public. The slot is removed after the walk. The hero's strength (HEROES: every ability set in the
//   slot) and what the hero carries in (KITS: equipment made and equipped in the slot, consumables in its inventory) are
//   written into the slot before the server starts; 踏破 lowers the slot's dungeon_run.max_floors to 1 after entering.
// - LM: a fixed LM answering on the LM Studio chat-completions shape, for the closed set of requests a dive makes (the
//   companion's opening and its long reply streamed 3 characters per STREAM_CHUNK_MS, the judgement questions, the structured
//   choices, the reflection). Any other request gets a 500 and fails the capture.
// - The product before the replacement (the floor of the cells): `git archive BEFORE_COMMIT` of app/ and data/ into OS temp,
//   with assets/canonical dungeon/ and equipment/ from the same commit and every other assets/canonical entry linked to the
//   repo's (checked unchanged since BEFORE_COMMIT with git diff, like content/). Removed at the end.
// - The product before the polish: `git archive POLISH_BASE` of app/ into OS temp, with data/, assets/ and content/ linked to the
//   repo's (checked unchanged since POLISH_BASE with git diff). Removed at the end.
// - The dungeon is opened the only way that lands on it without a save: /?initialScreen=debug and a real click on the debug
//   tab bar's 実践, then body.play-mode is set (what the title / slot-load entry sets). The product's enter request carries
//   with_companion (the entry's 同行 choice, clicked for real); the seed is added to that one request by a fetch wrapper
//   installed before the document (the product before the replacement gets with_companion the same way).
// - Scenes are reproduced by seed and the hero's strength: the turn RNG is (seed, turn) and each scene's action per turn
//   depends only on the view, so the same run comes back at every size.
// - Rendering: a hidden Electron window driven over CDP, the viewport pinned with Emulation.setDeviceMetricsOverride at DPR 1.
//   Input is CDP mouse, key (a held arrow is keyDown, then keyDown with autoRepeat every HOLD_REPEAT_MS, then keyUp) and text
//   events. Stills are Page.captureScreenshot (PNG), checked to be the window's size in px. Each turn's server answer is read
//   off the network (Network.getResponseBody).
//
// The harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const parsed = {};
  const known = new Set(['--repo-root', '--out-dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!known.has(token)) throw new Error(`unexpected argument: ${token} (expected --repo-root and --out-dir only)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of known) {
    if (parsed[token] === undefined) throw new Error(`${token} is required (no default, no fallback)`);
    if (!path.isAbsolute(parsed[token])) throw new Error(`${token} must be an absolute path: ${parsed[token]}`);
  }
  return { repoRoot: parsed['--repo-root'], outDir: parsed['--out-dir'] };
}

const HOST = '127.0.0.1';
const STREAM_CHUNK_MS = 40;
const HOLD_REPEAT_MS = 83;
const RAPID_CLICK_MS = 60;
const TALK_TEXT = 'この階、静かだね';
// The product before the replacement (the stage-2 base).
const BEFORE_COMMIT = 'd7f3384907bbcf8460fdcf8ec8b9508afbcc0b64';
// The product before the polish (the polish task's base).
const POLISH_BASE = 'fe68cff3b19e37b3c3d05be0a2690b9e8b83bcd5';
// The MacBook windows: the default display (points) less the macOS menu bar and Chrome's standard frame (the tab strip and the
// toolbar with the address bar), i.e. Chrome maximised. Both measured on this host (MacBook Pro 14-inch, macOS menu bar 33 pt
// from Electron's screen workArea; Chrome 154 outerHeight − innerHeight 87 px, no side frame); the Air 13-inch M4's notched
// menu bar is taken as the same 33 pt.
const MENU_BAR_PT = 33;
const CHROME_FRAME_TOP_PX = 87;
const MACBOOKS = {
  air13: { name: 'MacBook Air 13-inch (M4)', display: { width: 1470, height: 956 } },
  pro14: { name: 'MacBook Pro 14-inch (M5)', display: { width: 1512, height: 982 } }
};
const macbookScreen = ({ display }) => ({ width: display.width, height: display.height - MENU_BAR_PT - CHROME_FRAME_TOP_PX });
// The maximised window of a 1920×1080 display: Windows 11 at 100% scale, its taskbar (48 px) leaving a 1920×1032 work area, less
// Chrome's standard frame as measured on this host (87 px) — the browser's content, smaller than Electron's (the default frame's
// caption and menu bar, 23 + 20 px, leave 1920×989), so the one the boundary must hold.
const MAX1920 = { display: { width: 1920, height: 1080 }, taskbarPx: 48 };
const max1920Screen = () => ({ width: MAX1920.display.width, height: MAX1920.display.height - MAX1920.taskbarPx - CHROME_FRAME_TOP_PX });
const S = {
  main: { label: '1440x900', screen: { width: 1440, height: 900 } },
  large: { label: '1920x1080', screen: { width: 1920, height: 1080 } },
  max1920: { label: `max1920-${max1920Screen().width}x${max1920Screen().height}`, screen: max1920Screen() },
  narrow: { label: '860x900', screen: { width: 860, height: 900 } },
  air13: { label: `air13-${macbookScreen(MACBOOKS.air13).width}x${macbookScreen(MACBOOKS.air13).height}`, screen: macbookScreen(MACBOOKS.air13) },
  pro14: { label: `pro14-${macbookScreen(MACBOOKS.pro14).width}x${macbookScreen(MACBOOKS.pro14).height}`, screen: macbookScreen(MACBOOKS.pro14) }
};

// The hero's abilities in the slot (strong keeps diving), and what the hero carries in.
const HEROES = { standard: null, strong: 90 };
const KIT_EQUIPMENT = [
  { instance_id: 'capture_kit_weapon', kind: 'weapon', weapon_type: 'staff', element: 'fire', tier: 2, quality: 'fine', name: '灯り守りの杖', flavor: '撮影の支度を見るための仮の杖。', base_effects: { attack: 14 }, bonus_effects: {} },
  { instance_id: 'capture_kit_amulet', kind: 'amulet', element: 'water', tier: 2, quality: 'fine', name: '水面の護符', flavor: '撮影の支度を見るための仮の護符。', base_effects: { defense: 8 }, bonus_effects: {} }
];
const KITS = {
  none: null,
  // The weapon and the amulet (the equipment window's breakdown has rows) and the fire great blast (the aim, radius 4).
  aiming: [{ item_id: 'alchemy_fire_great_blast', quantity: 1 }]
};

// Each scene: its seed, whether the companion comes, the hero and the kit, and why.
const SCENES = [
  // seed 54: the way to the stairs ends in a straight run of 13 towards them; the key is held along it, the stairs ahead.
  { id: '02-walk', name: '歩く', seed: 54, companion: true, hero: 'strong', kit: 'none' },
  // seed 4 (standard hero): plain hits (the rapid casts), then a kill with a material drop, a hurt and a miss on slow turns.
  { id: '04-combat', name: '戦う', seed: 4, companion: true, hero: 'standard', kit: 'none' },
  // seed 11: walking to the stairs past the fights leaves the companion behind; talking brings the board round to it.
  { id: '05-talk', name: '同行者が話す', seed: 11, companion: true, hero: 'strong', kit: 'none' }
];
// The walks of the scenes the polish retakes. 1440×900 comes first, without a still: 歩く and 同行者が話す at MAX1920 replay the
// turn and the steps walked there.
const PASSES = [
  { size: S.main, walks: [['02-walk'], ['05-talk']], stills: [] },
  { size: S.max1920, walks: [['02-walk'], ['04-combat'], ['05-talk']], stills: ['02-walk', '04-combat', '05-talk'] }
];
const CHECK_SIZES = [S.large, S.max1920, S.main, S.air13, S.pro14, S.narrow];
const AIM_SIZES = [S.main, S.max1920];
const CELLS_RUN = { seed: 2024, hero: 'standard' };
// seed 2024 with the companion: the fire great blast (radius 4) aimed from the entrance.
const AIM_RUN = { seed: 2024, radius: 4 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
function check(name, pass, detail = {}) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!pass) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}
const dims = (screen) => `${screen.width}×${screen.height}`;

const teardown = [];
async function runTeardown() {
  while (teardown.length) {
    const step = teardown.pop();
    try {
      await step();
    } catch (error) {
      console.error('teardown step failed:', error);
    }
  }
}

function pngSize(bytes) {
  if (bytes.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG (no IHDR)');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function writeJson(full, value) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const readJson = async (full) => JSON.parse(await fs.readFile(full, 'utf8'));

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

// ── The fixed LM ──────────────────────────────────────────────────────────────────────────────────────────────
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';
const FIXTURE_OPENING = '（杖の先に小さな灯りをともして）よろしくお願いします。ここから一緒に潜りましょう。';
// A long reply (narration and speech in turn), so the 吹き出し fill in one by one while it streams.
const FIXTURE_REPLY = [
  '（松明を少し高く掲げて）ええ、静かすぎるくらいです。足音がよく響きますね。',
  '（壁の苔に指先で触れて）この先はもう少し湿っているみたいです。滑らないように気をつけてください。',
  '（耳を澄ませて）奥で何かが動いた気がします。まだ遠いですけど、灯りの外には出ないでおきましょう。',
  '（あなたに向き直って）私は後ろを見ています。前はお任せしますね。'
].join('');
const FIXTURE_SCHEMA_ANSWERS = new Map([
  ['character_emotion_choice', JSON.stringify({ expression: 'joy' })],
  ['work_record_recall_choice', JSON.stringify({ work_record_ids: [] })]
]);
// The dungeon's scene lines the product puts in the companion's prompt (app/src/server/dungeonApi.mjs).
const FIXTURE_OPENING_SCENE = '探索の途中で主人公と出会い、ここから一緒に潜ることになった。';
const FIXTURE_TURN_SCENE = '層を主人公と一緒に探索している。';
const FIXTURE_PROMPT_ANSWERS = [
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0']
];

function fixtureAnswer(body) {
  const prompt = body.messages.map((message) => message.content ?? '').join('\n');
  const schemaName = body.response_format?.json_schema?.name ?? null;
  if (schemaName !== null) {
    if (!FIXTURE_SCHEMA_ANSWERS.has(schemaName)) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    return { kind: schemaName, content: FIXTURE_SCHEMA_ANSWERS.get(schemaName) };
  }
  for (const [marker, answer] of FIXTURE_PROMPT_ANSWERS) {
    if (prompt.includes(marker)) return { kind: marker, content: answer };
  }
  if (body.model === FIXTURE_CHAT_MODEL && body.stream === true) {
    if (prompt.includes(FIXTURE_OPENING_SCENE)) return { kind: 'opening', content: FIXTURE_OPENING };
    if (prompt.includes(FIXTURE_TURN_SCENE)) return { kind: 'reply', content: FIXTURE_REPLY };
  }
  if (body.model === FIXTURE_REFLECTION_MODEL && body.stream !== true) return { kind: 'reflection', content: '探索の途中で主人公と話した。' };
  throw new Error(`fixture lm: unknown request (model ${body.model}, stream ${body.stream === true}): ${prompt.slice(0, 80)}`);
}

function startFixtureLm() {
  const calls = {};
  const failures = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    let answer;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      answer = fixtureAnswer(body);
    } catch (error) {
      failures.push(error.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
      return;
    }
    calls[answer.kind] = (calls[answer.kind] ?? 0) + 1;
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer.content } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const characters = [...answer.content];
    for (let index = 0; index < characters.length; index += 3) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: characters.slice(index, index + 3).join('') } }] })}\n\n`);
      await sleep(STREAM_CHUNK_MS);
    }
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve({ server, calls, failures, baseUrl: `http://${HOST}:${server.address().port}/v1` }));
  });
}

// ── The product before the replacement, extracted to OS temp ──────────────────────────────────────────────────
// app/ and data/ from BEFORE_COMMIT; assets/canonical/{dungeon,equipment} from BEFORE_COMMIT and every other entry linked to
// the repo's (content/ is read from the repo). Both linked trees must be unchanged since BEFORE_COMMIT.
async function extractBefore(repoRoot) {
  const unchanged = ['content', ':(exclude)assets/canonical/dungeon', ':(exclude)assets/canonical/equipment', 'assets/canonical'];
  const { stdout: drift } = await execFileAsync('git', ['-C', repoRoot, 'diff', '--name-only', BEFORE_COMMIT, 'HEAD', '--', ...unchanged]);
  check(`the trees read from the repo for the product before the replacement are unchanged since ${BEFORE_COMMIT.slice(0, 8)} (content/, assets/canonical but dungeon/ and equipment/)`, drift.trim() === '', { drift: drift.trim().split('\n').slice(0, 5) });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dungeon-product-before-'));
  const archive = path.join(root, 'before.tar');
  await execFileAsync('git', ['-C', repoRoot, 'archive', '--format=tar', `--output=${archive}`, BEFORE_COMMIT, 'app', 'data/definitions', 'data/seeds', 'assets/canonical/dungeon', 'assets/canonical/equipment'], { maxBuffer: 64 * 1024 * 1024 });
  await execFileAsync('tar', ['-xf', archive, '-C', root]);
  await fs.rm(archive);
  const canonical = path.join(root, 'assets/canonical');
  for (const name of await fs.readdir(path.join(repoRoot, 'assets/canonical'))) {
    if (name === 'dungeon' || name === 'equipment') continue;
    await fs.symlink(path.join(repoRoot, 'assets/canonical', name), path.join(canonical, name));
  }
  await fs.symlink(path.join(repoRoot, 'content'), path.join(root, 'content'));
  return root;
}

// ── The product before the polish, extracted to OS temp ───────────────────────────────────────────────────────
// app/ from POLISH_BASE; data/, assets/ and content/ linked to the repo's, which must be unchanged since POLISH_BASE.
async function extractPolishBase(repoRoot) {
  const linked = ['data', 'assets', 'content'];
  const { stdout: drift } = await execFileAsync('git', ['-C', repoRoot, 'diff', '--name-only', POLISH_BASE, 'HEAD', '--', ...linked]);
  check(`the trees read from the repo for the product before the polish are unchanged since ${POLISH_BASE.slice(0, 8)} (data/, assets/, content/)`, drift.trim() === '', { drift: drift.trim().split('\n').slice(0, 5) });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dungeon-product-polish-base-'));
  const archive = path.join(root, 'polish-base.tar');
  await execFileAsync('git', ['-C', repoRoot, 'archive', '--format=tar', `--output=${archive}`, POLISH_BASE, 'app'], { maxBuffer: 64 * 1024 * 1024 });
  await execFileAsync('tar', ['-xf', archive, '-C', root]);
  await fs.rm(archive);
  for (const name of linked) await fs.symlink(path.join(repoRoot, name), path.join(root, name));
  return root;
}

// ── The isolated slot and the product server on it ────────────────────────────────────────────────────────────
// `productRoot` is the repo (the product) or the extracted BEFORE_COMMIT root.
async function startProduct(productRoot, { hero = 'standard', kit = 'none' }) {
  if (!Object.hasOwn(HEROES, hero)) throw new Error(`unknown hero ${JSON.stringify(hero)}`);
  if (!Object.hasOwn(KITS, kit)) throw new Error(`unknown kit ${JSON.stringify(kit)}`);
  const load = (file) => import(pathToFileURL(path.join(productRoot, file)).href);
  const { createServer } = await load('app/src/server.mjs');
  const { runtimePathsManifestFilename } = await load('app/src/runtimePaths.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dungeon-product-capture-'));
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  const mutableRoot = path.join(root, 'data/mutable/game_data');
  await fs.cp(path.join(productRoot, 'data/definitions/game_data'), definitionsRoot, { recursive: true });
  await fs.cp(path.join(productRoot, 'data/seeds/game_data'), seedsRoot, { recursive: true });
  await fs.cp(seedsRoot, mutableRoot, { recursive: true });
  await writeJson(path.join(root, runtimePathsManifestFilename), {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot,
    seedsRoot,
    mutableRoot,
    characterContentRoot: path.join(productRoot, 'content/characters'),
    creatureContentRoot: path.join(productRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(productRoot, 'assets/canonical'),
    publicRoot: path.join(productRoot, 'app/public'),
    resourceRoot: root
  });
  const state = await readJson(path.join(mutableRoot, 'runtime_state.json'));
  await writeJson(path.join(mutableRoot, 'runtime_state.json'), { ...state, current_screen: 'academy-dungeon', current_interaction_character_id: null, current_buddy_character_id: null });
  if (HEROES[hero] !== null) {
    const parametersFile = path.join(mutableRoot, 'runtime/player_parameters.json');
    const parameters = await readJson(parametersFile);
    for (const group of Object.values(parameters)) {
      for (const entry of Object.values(group)) entry.value = HEROES[hero];
    }
    await writeJson(parametersFile, parameters);
  }
  if (KITS[kit] !== null) {
    const { addEquipmentInstance, equipItem, PLAYER_EQUIP_TARGET } = await load('app/src/equipment.mjs');
    for (const instance of KIT_EQUIPMENT) {
      await addEquipmentInstance({ root, instance });
      await equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: instance.kind, instance_id: instance.instance_id });
    }
    const inventoryFile = path.join(mutableRoot, 'player_inventory.json');
    const inventory = await readJson(inventoryFile);
    await writeJson(inventoryFile, { ...inventory, items: [...inventory.items, ...KITS[kit]] });
  }
  await writeJson(path.join(root, 'app/config/play-mode.json'), { mode: 'loop' });
  const lmStudioConfigPath = path.join(root, 'app/config/lmstudio.json');
  const fixtureLm = await startFixtureLm();
  await writeJson(lmStudioConfigPath, {
    provider: 'lmstudio',
    base_url: fixtureLm.baseUrl,
    chat_model: FIXTURE_CHAT_MODEL,
    reflection_model: FIXTURE_REFLECTION_MODEL,
    timeout_ms: 120000,
    stream: true,
    thinking_effort: null,
    mock_provider_enabled: false
  });
  const product = createServer({
    root,
    activeRoot: root,
    publicRoot: path.join(productRoot, 'app/public'),
    canonicalAssetsRoot: path.join(productRoot, 'assets/canonical'),
    playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
    conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
    audioSettingsPath: path.join(root, 'app/config/audio.json'),
    lmStudioConfigPath
  });
  await new Promise((resolve) => product.listen(0, HOST, resolve));
  return {
    base: `http://${HOST}:${product.address().port}`,
    slotRoot: root,
    lm: fixtureLm,
    async stop() {
      await closeServer(product);
      await closeServer(fixtureLm.server);
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

// ── The page under CDP ────────────────────────────────────────────────────────────────────────────────────────
const ARROWS = {
  up: { key: 'ArrowUp', keyCode: 38, dx: 0, dy: -1 },
  down: { key: 'ArrowDown', keyCode: 40, dx: 0, dy: 1 },
  left: { key: 'ArrowLeft', keyCode: 37, dx: -1, dy: 0 },
  right: { key: 'ArrowRight', keyCode: 39, dx: 1, dy: 0 }
};

// The enter request gets the seed (and, on the product before the replacement, with_companion), before the document.
const ENTER_WRAP = (seed, withCompanion) => `(() => {
  const original = window.fetch;
  window.fetch = (input, init) => {
    if (String(input).endsWith('/api/dungeon/enter')) {
      init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), seed: ${seed}${withCompanion === null ? '' : `, with_companion: ${withCompanion}`} }) };
    }
    return original(input, init);
  };
})();`;

async function openPage(size, { beforeDocument }) {
  const css = size.screen;
  const win = new BrowserWindow({ width: css.width, height: css.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) {
      pageErrors.push(message);
      console.log(`renderer-error: ${message}`);
    }
  });
  // CDP is only answered once a real page has loaded in the hidden window.
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: css.width, height: css.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  // The script is only installed for later documents while the Page domain is enabled.
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: beforeDocument });
  // Each turn's answer: the /api/dungeon/action responses in order, read off the network.
  const actions = [];
  await send('Network.enable');
  cdp.on('message', (_event, method, params) => {
    if (method === 'Network.requestWillBeSent' && params.request.url.endsWith('/api/dungeon/action')) {
      let finish;
      actions.push({ requestId: params.requestId, finished: new Promise((resolve) => { finish = resolve; }), finish });
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      actions.find((entry) => entry.requestId === params.requestId)?.finish(method);
    }
  });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const tokenStills = [];
  const page = {
    win,
    size,
    css,
    send,
    js,
    pageErrors,
    actions,
    tokenStills,
    async load(url) {
      await win.loadURL(url);
      const measured = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches })');
      check(`${size.label}: window ${css.width}x${css.height} css px at dpr 1, full motion`, measured.w === css.width && measured.h === css.height && measured.dpr === 1 && !measured.reduced, measured);
    },
    async waitFor(predicate, label, { timeoutMs = 30000, intervalMs = 20 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`)) return Date.now();
        await sleep(intervalMs);
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    // The answer of the n-th action request (the last one when omitted), parsed.
    async actionAnswer(index = actions.length - 1) {
      const entry = actions[index];
      if (!entry) throw new Error(`no action request #${index}`);
      const how = await entry.finished;
      if (how !== 'Network.loadingFinished') throw new Error(`action request #${index} failed on the network`);
      const { body, base64Encoded } = await send('Network.getResponseBody', { requestId: entry.requestId });
      return JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
    },
    // The centre of the n-th match; dies if something else covers that point (the event would land elsewhere).
    async pointOf(selector, { index = 0 } = {}) {
      return js(`(() => {
        const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!node) throw new Error('no node: ' + ${JSON.stringify(`${selector} ${index}`)});
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) throw new Error('node has no box: ' + ${JSON.stringify(selector)});
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(box.y + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === node || node.contains(hit) || hit.contains(node))) throw new Error('point is covered at ' + ${JSON.stringify(selector)} + ': ' + (hit ? hit.className : 'nothing'));
        return { x, y };
      })()`);
    },
    mouse: { x: 0, y: 0 },
    async moveTo(target, { steps = 1, stepMs = 0 } = {}) {
      const from = { ...page.mouse };
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(from.x + ((target.x - from.x) * i) / steps);
        const y = Math.round(from.y + ((target.y - from.y) * i) / steps);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        if (stepMs) await sleep(stepMs);
      }
      page.mouse = { x: target.x, y: target.y };
    },
    async hover(selector, options = {}, motion = {}) {
      const point = await page.pointOf(selector, options);
      await page.moveTo(point, motion);
      return point;
    },
    async click(selector, options = {}, motion = {}) {
      const point = await page.hover(selector, options, motion);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      return point;
    },
    async type(text, charMs) {
      for (const character of [...text]) {
        await send('Input.insertText', { text: character });
        await sleep(charMs);
      }
    },
    async key(key, code, keyCode, { text = null } = {}) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    },
    arrow(direction) {
      const { key, keyCode } = ARROWS[direction];
      return page.key(key, key, keyCode);
    },
    // A held arrow key: keyDown, keyDown with autoRepeat every `repeatMs` while `whileHeld()` says so, keyUp.
    async holdArrow(direction, whileHeld, repeatMs = HOLD_REPEAT_MS) {
      const { key, keyCode } = ARROWS[direction];
      const base = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      let repeats = 0;
      while (await whileHeld(repeats)) {
        await sleep(repeatMs);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...base });
        repeats += 1;
      }
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return repeats;
    },
    async still(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(data, 'base64');
      const shot = pngSize(bytes);
      check(`still ${path.basename(file)} is ${size.screen.width}x${size.screen.height} px`, shot.width === size.screen.width && shot.height === size.screen.height, shot);
      await fs.writeFile(file, bytes);
      const tokens = await js(`document.querySelector('#dungeon-entities') && document.querySelector('#academy-dungeon-screen').dataset.render !== undefined ? ${TOKEN_BOXES} : null`);
      if (tokens?.play) tokenStills.push({ still: path.basename(file), tokens: tokens.tokens, moving: tokens.moving, overlaps: tokens.overlaps });
    },
    watch: () => js('window.__dnTokenWatch ?? null'),
    async close() {
      if (cdp.isAttached()) cdp.detach();
      if (!win.isDestroyed()) win.destroy();
    }
  };
  return page;
}

// ── Reading the product (read only) ─────────────────────────────────────────────────────────────────────────────
const ROOT = `document.querySelector('#academy-dungeon-screen')`;
const SCENE_IS = (scene) => `${ROOT}.dataset.scene === ${JSON.stringify(scene)}`;
const RENDER = `+(${ROOT}.dataset.render ?? 0)`;
// A running Web Animation on `selector` that has reached `atMs` (read off Element.getAnimations(), nothing is changed).
const ANIMATION_AT = (selector, atMs) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((n) => n.getAnimations().some((a) => a.playState === 'running' && a.currentTime >= ${atMs}))`;
const ASSISTANT_ROWS = `document.querySelectorAll('#dungeon-journal .chat-message.character-message').length`;
const OPENING_DONE = `${ASSISTANT_ROWS} > 0 && !document.querySelector('#dungeon-journal .dn-line--waiting')`;
const VOICES_GONE = `document.querySelectorAll('.dn-voice').length === 0`;
// Cells of the board fully inside the board's window, and the window's own capacity in whole cells (the product).
const FULL_CELLS = `(() => {
  const vpNode = document.querySelector('#dungeon-viewport');
  const vp = vpNode.getBoundingClientRect();
  const cells = [...document.querySelectorAll('#dungeon-tiles > *')].map((n) => n.getBoundingClientRect());
  const full = cells.filter((r) => r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5 && r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5);
  const style = getComputedStyle(vpNode);
  const cell = parseFloat(style.getPropertyValue('--dn-cell'));
  const gap = parseFloat(style.getPropertyValue('--dn-gap'));
  const cols = Math.floor((vpNode.clientWidth + gap) / (cell + gap));
  const rows = Math.floor((vpNode.clientHeight + gap) / (cell + gap));
  const board = document.querySelector('#dungeon-board').getBoundingClientRect();
  return {
    viewport: [Math.round(vp.width), Math.round(vp.height)],
    board: [Math.round(board.width), Math.round(board.height)],
    zoom: document.querySelector('#academy-dungeon-screen').currentCSSZoom,
    cellPx: Math.round(cells[0].width * 100) / 100,
    gapPx: gap,
    cols: new Set(full.map((r) => Math.round(r.left))).size,
    rows: new Set(full.map((r) => Math.round(r.top))).size,
    full: full.length,
    window: { cols, rows, cells: cols * rows }
  };
})()`;
// The same count on the product before the replacement (its board is .dn-tiles in .dn-viewport).
const BEFORE_FULL_CELLS = `(() => {
  const vp = document.querySelector('.dn-viewport').getBoundingClientRect();
  const cells = [...document.querySelectorAll('.dn-tiles > *')].map((n) => n.getBoundingClientRect());
  const full = cells.filter((r) => r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5 && r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5);
  return {
    viewport: [Math.round(vp.width), Math.round(vp.height)],
    cellPx: Math.round(cells[0].width * 100) / 100,
    cols: new Set(full.map((r) => Math.round(r.left))).size,
    rows: new Set(full.map((r) => Math.round(r.top))).size,
    full: full.length
  };
})()`;
// Every label in the rail: its line count (distinct line boxes of its text) and whether it stays inside the rail.
const RAIL_LINES = `(() => {
  const rail = document.querySelector('#dungeon-rail').getBoundingClientRect();
  const lines = (node) => { const range = document.createRange(); range.selectNodeContents(node); return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size; };
  const labels = [...document.querySelectorAll('#dungeon-rail .dn-depth-floor, #dungeon-rail .dn-depth-turn, #dungeon-retreat-button, #dungeon-help-button, #dungeon-rail .dn-member-name, #dungeon-rail .dn-member-tag, #dungeon-rail .dn-member-value, #dungeon-rail .dn-card-name, #dungeon-rail .dn-card-cost, #dungeon-rail .dn-carry-name, #dungeon-rail .dn-carry-note, #dungeon-rail .dn-carry-count, #dungeon-talk-send')]
    .filter((n) => n.getClientRects().length && n.textContent.trim());
  const rows = labels.map((n) => ({ text: n.textContent.trim(), lines: lines(n), inside: n.getBoundingClientRect().right <= rail.right + 0.5 && n.getBoundingClientRect().left >= rail.left - 0.5 }));
  return { railWidth: Math.round(rail.width), labels: rows.length, maxLines: Math.max(...rows.map((r) => r.lines)), folded: rows.filter((r) => r.lines !== 1).map((r) => r.text), outside: rows.filter((r) => !r.inside).map((r) => r.text) };
})()`;
// The tokens on the board, each as one box (the token with its gauges), and every pair of boxes that overlaps. A token sliding
// or bumping (an animation running on the entity or the token) makes the board "moving": a settled frame has nothing moving.
const TOKEN_BOXES = `(() => {
  const nodes = [...document.querySelectorAll('#dungeon-entities > .dn-entity')];
  const moving = nodes.some((n) => [n, n.firstElementChild].some((el) => el && el.getAnimations().some((a) => a.playState === 'running')));
  const boxes = nodes.map((n) => {
    const rects = [n.firstElementChild, n.querySelector('.dn-token-gauges')].filter(Boolean).map((el) => el.getBoundingClientRect());
    return { key: n.className.replace('dn-entity ', ''), left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  });
  const overlaps = [];
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
    const w = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left);
    const h = Math.min(boxes[i].bottom, boxes[j].bottom) - Math.max(boxes[i].top, boxes[j].top);
    if (w > 0 && h > 0) overlaps.push({ a: boxes[i].key, b: boxes[j].key, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 });
  }
  const root = document.querySelector('#academy-dungeon-screen');
  return { play: root.dataset.scene === 'play', render: +(root.dataset.render ?? 0), tokens: boxes.length, moving, overlaps };
})()`;
// Installed once the board is up: every 30 ms while in play, the settled frames' token boxes are measured.
const TOKEN_WATCH = `(() => {
  const watch = { samples: 0, rendersSeen: [], rendersSettled: [], overlaps: [] };
  window.__dnTokenWatch = watch;
  setInterval(() => {
    const now = (${TOKEN_BOXES});
    if (!now.play) return;
    if (!watch.rendersSeen.includes(now.render)) watch.rendersSeen.push(now.render);
    if (now.moving || now.tokens < 2) return;
    watch.samples += 1;
    if (!watch.rendersSettled.includes(now.render)) watch.rendersSettled.push(now.render);
    if (now.overlaps.length && watch.overlaps.length < 20) watch.overlaps.push({ render: now.render, overlaps: now.overlaps });
  }, 30);
  return true;
})()`;
// What the entry shows: the title, 潜る, the companion (face and name, or the shadow token), the kit (each frame's label, the
// thing's name and which mark draws it), the way back to the map, and every part inside the window.
const ENTRY_READING = `(() => {
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const face = document.querySelector('#dungeon-entry-face');
  const parts = ['.dn-entry-title', '#dungeon-dive', '#dungeon-entry-party', '#dungeon-entry-company', '#dungeon-entry-kit', '#dungeon-back-to-map'].map((selector) => box(document.querySelector(selector)));
  return {
    title: document.querySelector('.dn-entry-title').textContent,
    dive: document.querySelector('#dungeon-dive').textContent,
    back: document.querySelector('#dungeon-back-to-map').textContent,
    companionShown: !document.querySelector('#dungeon-entry-companion').hidden,
    companionName: document.querySelector('#dungeon-entry-companion-name').textContent,
    companionFace: !face.hidden && face.complete && face.naturalWidth > 0 ? new URL(face.src).pathname : null,
    shadow: document.querySelector('#dungeon-entry-companion-token').classList.contains('dn-token--unknown'),
    withLabel: document.querySelector('#dungeon-entry-with-label').textContent,
    withDisabled: document.querySelector('.dn-choice[data-with="1"]').disabled,
    note: document.querySelector('#dungeon-entry-note').hidden ? null : document.querySelector('#dungeon-entry-note').textContent,
    kit: [...document.querySelectorAll('#dungeon-entry-kit .dn-kit')].map((n) => {
      const drawn = n.querySelector('.dn-kit-plate svg.dm') ?? n.querySelector('.dn-kit-vial');
      const r = drawn.getBoundingClientRect();
      return { label: n.querySelector('.dn-kit-label').textContent, name: n.querySelector('.dn-kit-name').textContent, held: !n.classList.contains('is-empty'), art: drawn.tagName === 'svg' ? drawn.getAttribute('class') : 'vial', drawn: r.width > 0 && r.height > 0, img: n.querySelectorAll('img').length };
    }),
    arch: Boolean(document.querySelector('#dungeon-entry-hall svg')),
    crest: Boolean(document.querySelector('.dn-entry-member--hero svg')),
    inside: parts.every((b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight)
  };
})()`;
// Where a board node is drawn, in the board window's pixels.
const SCREEN_OF = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const r = node.getBoundingClientRect();
  const vp = document.querySelector('#dungeon-viewport').getBoundingClientRect();
  return { left: Math.round(r.left - vp.left), top: Math.round(r.top - vp.top), right: Math.round(r.right - vp.left), bottom: Math.round(r.bottom - vp.top), inside: r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5 && r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5 };
})()`;
const SCREEN_OF_ALL = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => {
  const r = node.getBoundingClientRect();
  const vp = document.querySelector('#dungeon-viewport').getBoundingClientRect();
  return { left: Math.round(r.left - vp.left), top: Math.round(r.top - vp.top), right: Math.round(r.right - vp.left), bottom: Math.round(r.bottom - vp.top), inside: r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5 && r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5 };
})`;
const COMPANION_SCREEN = `(() => {
  const node = document.querySelector('.dn-entity--companion');
  if (!node) return null;
  const r = node.getBoundingClientRect();
  const vp = document.querySelector('#dungeon-viewport').getBoundingClientRect();
  const x = r.left + r.width / 2 - vp.left;
  const y = r.top + r.height / 2 - vp.top;
  return { x: Math.round(x), y: Math.round(y), onScreen: x >= 0 && x <= vp.width && y >= 0 && y <= vp.height };
})()`;
// A mark on the board (下り階段 .dn-feature--stairs, のぼり階段 .dn-feature--entrance) drawn and wholly inside the board's window,
// and whether a token's box covers any of it.
const MARK_SHOWN = (selector) => `(() => {
  const vp = document.querySelector('#dungeon-viewport').getBoundingClientRect();
  const tokens = [...document.querySelectorAll('#dungeon-entities > .dn-entity')].map((n) => ({ key: n.className.replace('dn-entity ', ''), r: n.firstElementChild.getBoundingClientRect() }));
  return [...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => {
    const r = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      drawn: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0,
      inside: r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5 && r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5,
      covered: tokens.some(({ r: t }) => t.left < r.right - 1 && r.left < t.right - 1 && t.top < r.bottom - 1 && r.top < t.bottom - 1),
      coveredBy: tokens.filter(({ r: t }) => t.left < r.right - 1 && r.left < t.right - 1 && t.top < r.bottom - 1 && r.top < t.bottom - 1).map(({ key }) => key),
      mark: node.querySelector('svg')?.getAttribute('class') ?? null
    };
  });
})()`;

// 照準: the valid cells wholly inside the board's window, with the point to put the pointer on.
const AIM_CANDIDATES = `(() => {
  const vp = document.querySelector('#dungeon-viewport').getBoundingClientRect();
  return [...document.querySelectorAll('.dn-aim-cell.is-valid')].map((c) => ({ x: +c.dataset.x, y: +c.dataset.y, r: c.getBoundingClientRect() }))
    .filter(({ r }) => r.left >= vp.left + 8 && r.right <= vp.right - 8 && r.top >= vp.top + 8 && r.bottom <= vp.bottom - 8)
    .map(({ x, y, r }) => ({ x, y, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }));
})()`;
// The landing cell: three or more tiles from the hero, the one whose reach takes in the most cells never seen (so the still
// shows how the reach meets the dark), then the nearest, then the topmost and leftmost.
function aimTarget(view, candidates) {
  const unseenAround = ({ x, y }) => {
    let n = 0;
    for (let ty = y - AIM_RUN.radius; ty <= y + AIM_RUN.radius; ty += 1) {
      for (let tx = x - AIM_RUN.radius; tx <= x + AIM_RUN.radius; tx += 1) {
        if (Math.abs(tx - x) + Math.abs(ty - y) <= AIM_RUN.radius && view.explored[ty]?.[tx] === false) n += 1;
      }
    }
    return n;
  };
  const scored = candidates.map((c) => ({ ...c, d: Math.abs(c.x - view.player.x) + Math.abs(c.y - view.player.y), unseen: unseenAround(c) }))
    .filter((c) => c.d >= 3)
    .sort((a, b) => b.unseen - a.unseen || a.d - b.d || a.y - b.y || a.x - b.x);
  return scored[0] ?? null;
}
// Every aim cell that draws something (reach, blast or point), with what it paints: its background, its borders, its inset
// ring, and the point's mark.
const AIM_MARKS = `(() => {
  const marked = [...document.querySelectorAll('.dn-aim-cell')].filter((c) => c.matches('.is-valid, .is-blast, .is-point') || getComputedStyle(c).backgroundColor !== 'rgba(0, 0, 0, 0)');
  return {
    prompt: document.querySelector('#dungeon-targeting').textContent,
    cells: marked.map((c) => {
      const style = getComputedStyle(c);
      const after = getComputedStyle(c, '::after');
      return {
        x: +c.dataset.x, y: +c.dataset.y, valid: c.classList.contains('is-valid'), blast: c.classList.contains('is-blast'), point: c.classList.contains('is-point'),
        background: style.backgroundColor, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(parseFloat),
        mark: after.content !== 'none' && after.content !== 'normal' ? { background: after.backgroundColor, border: parseFloat(after.borderTopWidth) } : null
      };
    })
  };
})()`;
function aimReading(view, target, { prompt, cells }) {
  const transparent = (color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
  const points = cells.filter((c) => c.point);
  return {
    target: [target.x, target.y],
    unseenInReach: target.unseen,
    prompt,
    valid: cells.filter((c) => c.valid).length,
    blast: cells.filter((c) => c.blast).length,
    marksOnUnseen: cells.filter((c) => !view.explored[c.y][c.x]).length,
    filled: cells.filter((c) => !transparent(c.background) || (c.mark && !transparent(c.mark.background))).map((c) => ({ at: [c.x, c.y], background: c.background, mark: c.mark })),
    outlineEdges: cells.reduce((n, c) => n + c.borders.filter((w) => w > 0).length, 0),
    pointedAtTarget: points.length === 1 && points[0].x === target.x && points[0].y === target.y,
    pointMark: points.length === 1 && points[0].mark !== null && points[0].mark.border > 0
  };
}
// The equipment window: the breakdown's title and label, its rows, "run" anywhere in the window's text, the window inside.
const EQUIPMENT_READING = `(() => {
  const card = document.querySelector('#dungeon-equip-modal .dn-modal-card, #dungeon-equip-modal > *').getBoundingClientRect();
  const modal = document.querySelector('#dungeon-equip-modal');
  return {
    title: document.querySelector('.dungeon-equipment-run-title').textContent,
    label: document.querySelector('#dungeon-equipment-run').getAttribute('aria-label'),
    rows: document.querySelectorAll('.dungeon-equipment-run-body > *').length,
    run: /\\brun\\b/i.test(modal.innerText + ' ' + [...modal.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')).join(' ')),
    inside: card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight
  };
})()`;

const stateOf = (page) => page.js(`fetch('/api/dungeon/state').then((r) => r.json())`);

// The board a still was taken of: the page's scene and turn, and (while the run is live) the run, floor and who stands where.
async function boardOfStill(page) {
  const shown = await page.js(`({ scene: ${ROOT}.dataset.scene, turn: ${ROOT}.dataset.turn ?? null, result: document.querySelector('#dungeon-result').hidden ? null : document.querySelector('#dungeon-result-title').textContent })`);
  if (shown.scene !== 'play') return shown;
  const view = await stateOf(page);
  return { ...shown, run: view.run_id, floor: view.floor, serverTurn: view.turn, player: [view.player.x, view.player.y], companion: view.companion ? [view.companion.x, view.companion.y] : null };
}

// Shortest path of arrow moves to `target` over floor tiles (optionally around the enemies in sight).
function pathTo(view, target, { avoidEnemies }) {
  const key = (x, y) => `${x},${y}`;
  const blocked = new Set(avoidEnemies ? view.enemies.map((enemy) => key(enemy.x, enemy.y)) : []);
  const previous = new Map([[key(view.player.x, view.player.y), null]]);
  const queue = [[view.player.x, view.player.y]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (x === target.x && y === target.y) break;
    for (const [direction, { dx, dy }] of Object.entries(ARROWS)) {
      const nx = x + dx;
      const ny = y + dy;
      const k = key(nx, ny);
      if (previous.has(k) || view.tiles[ny]?.[nx] !== 'floor' || blocked.has(k)) continue;
      previous.set(k, [key(x, y), direction]);
      queue.push([nx, ny]);
    }
  }
  let k = key(target.x, target.y);
  if (!previous.has(k)) return null;
  const steps = [];
  while (previous.get(k)) {
    const [before, direction] = previous.get(k);
    steps.unshift(direction);
    k = before;
  }
  return steps;
}

// One arrow press as one turn: waits for the product's redraw of that answer.
async function stepOnce(page, direction) {
  const before = await page.js(RENDER);
  const sent = page.actions.length;
  await page.arrow(direction);
  await page.waitFor(`${RENDER} > ${before} || !(${SCENE_IS('play')})`, `redraw after ${direction}`);
  if (page.actions.length === sent) throw new Error(`the ${direction} press did not reach the server`);
  return page.actionAnswer();
}

// The entry, then 潜る with the scene's company. `entryStill` runs on the drawn entry, before anything is chosen.
async function enter(page, product, scene, { entryStill = null } = {}) {
  await page.load(`${product.base}/?initialScreen=debug`);
  await page.waitFor(`document.querySelector('button[data-screen="academy-dungeon"]')`, 'the debug tab bar');
  await page.click('button[data-screen="academy-dungeon"]');
  await page.waitFor(`${ROOT}.classList.contains('active') && ${SCENE_IS('entry')} && !document.querySelector('#dungeon-dive').disabled`, 'the entry');
  await page.js(`document.body.classList.add('play-mode'); true`);
  await page.waitFor(`[...document.querySelectorAll('#academy-dungeon-screen img')].every((img) => img.complete) && document.querySelectorAll('#dungeon-entry-hall > *').length > 0`, 'the entry drawn');
  if (entryStill) await entryStill();
  await page.click(`.dn-choice[data-with="${scene.companion ? 1 : 0}"]`, {}, { steps: 8, stepMs: 20 });
  await page.click('#dungeon-dive', {}, { steps: 12, stepMs: 25 });
  await page.waitFor(`${ROOT}.classList.contains('active') && ${SCENE_IS('play')} && document.querySelectorAll('#dungeon-tiles > *').length > 0`, 'the board', { timeoutMs: 60000 });
  if (scene.companion) await page.waitFor(OPENING_DONE, 'the companion opening', { timeoutMs: 60000 });
  await page.js(TOKEN_WATCH);
  const view = await stateOf(page);
  check(`${scene.id} entered seed ${scene.seed} ${scene.companion ? 'with the companion' : 'alone'}`, view.active === true && view.run_id === `dr_${scene.seed}` && Boolean(view.companion) === scene.companion, { run: view.run_id, floor: view.floor, turn: view.turn, companion: view.companion?.name ?? null });
  return view;
}

// ── The scenes ──────────────────────────────────────────────────────────────────────────────────────────────────
// Each takes (page, product, ctx): ctx.take(key instant id) writes the still when this pass keeps it, ctx.record holds what
// the scene measured (keyed by the size for every pass but 1440×900).
const recordKey = (ctx, id) => (ctx.sizeLabel === S.main.label ? id : `${id}@${ctx.sizeLabel}`);
const SCENE_RUNS = {
  async '02-walk'(page, product, ctx) {
    const scene = sceneOf('02-walk');
    let view = await enter(page, product, scene);
    await page.waitFor(VOICES_GONE, 'the opening voice leaving the board', { timeoutMs: 15000 });
    // Taps along the way to the stairs up to the last straight run towards them, then the key held along that run.
    const route = pathTo(view, view.stairs, { avoidEnemies: false });
    let tail = 1;
    while (tail < route.length && route[route.length - 1 - tail] === route[route.length - 1]) tail += 1;
    const direction = route[route.length - 1];
    check('02-walk the way to the stairs ends in a straight run of at least 6', tail >= 6, { route: route.length, tail, direction });
    await sleep(600);
    for (let taps = 0; pathTo(view, view.stairs, { avoidEnemies: false }).length > tail; taps += 1) {
      if (taps >= 20) throw new Error('02-walk did not reach the straight run in 20 taps');
      view = await stepOnce(page, pathTo(view, view.stairs, { avoidEnemies: false })[0]);
      await sleep(420);
    }
    const heldFrom = view.turn;
    // Held until the hero stands one short of the stairs (walking into an enemy on the run is the melee attack, a turn without a
    // step). The 1440×900 pass takes its still on the first turn three or more into the held walk with the 下り階段 in the
    // window; every other pass takes it on that same turn.
    const plannedTurn = ctx.sizeLabel === S.main.label ? null : ctx.record['02-walk']?.keyInstant?.turn;
    if (ctx.sizeLabel !== S.main.label && plannedTurn === undefined) throw new Error('02-walk at another size needs the 1440x900 walk first');
    let keyInstant = null;
    const RUNNING_LIGHT = `[...document.querySelectorAll('#dungeon-tiles > .dn-cell')].reduce((n, c) => n + c.getAnimations().filter((a) => a.playState === 'running').length, 0)`;
    const repeats = await page.holdArrow(direction, async (sent) => {
      if (sent >= 80) throw new Error('the held walk did not finish its run in 80 repeats');
      // No key event is sent while this runs, so once the turns already asked for have answered, the board holds still.
      await Promise.all(page.actions.map((entry) => entry.finished));
      const answered = page.actions.length;
      await page.waitFor(`${RENDER} >= ${answered + 1}`, 'the held walk redrawn up to its last answer (the entry is render 1)', { timeoutMs: 3000, intervalMs: 5 });
      const turn = +(await page.js(`${ROOT}.dataset.turn`));
      if (keyInstant === null && (plannedTurn === null ? turn >= heldFrom + 3 : turn === plannedTurn)) {
        const stairs = await page.js(MARK_SHOWN('#dungeon-tiles .dn-feature--stairs'));
        if (plannedTurn !== null || stairs.some((mark) => mark.drawn && mark.inside)) {
          // The key instant: three tiles or more into the held walk, the key still down, the 下り階段 ahead in the window.
          keyInstant = await page.js(`({ turn: +${ROOT}.dataset.turn, runningLightTransitions: ${RUNNING_LIGHT}, stairs: ${MARK_SHOWN('#dungeon-tiles .dn-feature--stairs')} })`);
          await ctx.take('02-walk');
        }
      }
      const at = page.actions.length ? (await page.actionAnswer()).player : view.player;
      return Math.abs(at.x - view.stairs.x) + Math.abs(at.y - view.stairs.y) > 1;
    });
    await sleep(250);
    const settled = await page.js(`({ turn: +${ROOT}.dataset.turn, transitions: ${RUNNING_LIGHT} })`);
    const after = await stateOf(page);
    const litCells = await page.js(`document.querySelectorAll('#dungeon-tiles > .dn-cell.is-lit').length`);
    const visibleCells = after.visible.flat().filter(Boolean).length;
    const record = { direction, route: route.length, straight: tail, heldFrom, heldRepeats: repeats, holdRepeatMs: HOLD_REPEAT_MS, turnsHeld: settled.turn - heldFrom, keyInstant, afterRelease250ms: { runningLightTransitions: settled.transitions, litCells, serverVisibleCells: visibleCells } };
    ctx.record[recordKey(ctx, '02-walk')] = record;
    check(`02-walk 歩く (${ctx.sizeLabel}): the held key walked the run towards the stairs${plannedTurn === null ? ' with the 下り階段 in the window' : ` (still on turn ${plannedTurn}, as at 1440x900)`}, and 250 ms after release the light has no transition left and matches the server`,
      keyInstant !== null && settled.turn - heldFrom >= 3 && settled.transitions === 0 && litCells === visibleCells, record);
    await sleep(900);
  },

  async '04-combat'(page, product, ctx) {
    const scene = sceneOf('04-combat');
    await enter(page, product, scene);
    await page.waitFor(VOICES_GONE, 'the opening voice leaving the board', { timeoutMs: 15000 });
    await sleep(500);
    const lightCard = '#dungeon-spells .dn-card[data-element="light"]';
    // 連打: the light card clicked every RAPID_CLICK_MS until three turns have gone (a click during a turn in flight is dropped).
    await page.hover(lightCard, {}, { steps: 12, stepMs: 25 });
    const rapid = { clicks: 0, startedAt: Date.now() };
    while (+(await page.js(`${ROOT}.dataset.turn`)) < 3) {
      if (rapid.clicks >= 12) throw new Error('the rapid casts did not advance three turns in 12 clicks');
      await page.click(lightCard);
      rapid.clicks += 1;
      await sleep(RAPID_CLICK_MS);
    }
    rapid.ms = Date.now() - rapid.startedAt;
    delete rapid.startedAt;
    rapid.requests = page.actions.length;
    const rapidAnswers = [];
    for (let i = 0; i < page.actions.length; i += 1) rapidAnswers.push(await page.actionAnswer(i));
    rapid.turns = rapidAnswers.map((answer) => answer.turn);
    rapid.events = rapidAnswers.map((answer) => answer.events.map((event) => event.kind).join('+'));
    // Then one slow turn at a time (cast while the card is usable, else wait) until a hit, a miss, a kill with its material,
    // and a hurt have each played out in full.
    const seen = { hit: [], miss: [], kill: [], material: [], hurt: [] };
    const drawn = new Set();
    let previous = rapidAnswers.at(-1);
    let keyInstant = null;
    for (let turn = 0; turn < 10 && Object.values(seen).some((list) => list.length === 0); turn += 1) {
      await sleep(700);
      const usable = await page.js(`!!document.querySelector('${lightCard}:not(:disabled)')`);
      const before = await page.js(RENDER);
      const sent = page.actions.length;
      if (usable) await page.click(lightCard, {}, { steps: 4, stepMs: 20 });
      else await page.key(' ', 'Space', 32);
      await page.waitFor(`${RENDER} > ${before}`, 'the slow turn');
      if (page.actions.length === sent) throw new Error('the slow turn did not reach the server');
      let answer = await page.actionAnswer();
      if (answer.action_error === 'no_target') {
        const again = await page.js(RENDER);
        await page.key(' ', 'Space', 32);
        await page.waitFor(`${RENDER} > ${again}`, 'the wait after no target');
        answer = await page.actionAnswer();
      }
      for (const event of answer.events) {
        const onHero = event.to.x === answer.player.x && event.to.y === answer.player.y;
        if (event.hit === false) seen.miss.push(answer.turn);
        else if (onHero) seen.hurt.push(answer.turn);
        else seen.hit.push(answer.turn);
      }
      if (previous.enemies.some((enemy) => !answer.enemies.some((alive) => alive.uid === enemy.uid) && answer.log.includes(`${enemy.name}を倒した。`))) seen.kill.push(answer.turn);
      const count = (a) => a.material_buffer.reduce((sum, item) => sum + item.quantity, 0);
      if (count(answer) > count(previous)) seen.material.push(answer.turn);
      // What the page drew for this turn, read for 1.3 s (every effect lives under #dungeon-effects).
      const end = Date.now() + 1300;
      while (Date.now() < end) {
        const classes = await page.js(`[...document.querySelectorAll('#dungeon-effects > *')].map((n) => n.className.split(' ').filter((c) => !c.startsWith('dn-el-')).join('.'))`);
        for (const name of classes) drawn.add(name);
        if (keyInstant === null && count(answer) > count(previous)) {
          if (await page.js(ANIMATION_AT('.dn-draw-in', 200))) {
            // The key instant: the material's picture on its way from the fallen enemy to the hero.
            await ctx.take('04-combat');
            keyInstant = { turn: answer.turn, effects: await page.js(`[...document.querySelectorAll('#dungeon-effects > *')].map((n) => n.className).join(' / ')`) };
          }
        }
        await sleep(15);
      }
      previous = answer;
    }
    const reduced = await page.js(`${ROOT}.dataset.motion === 'reduced'`);
    ctx.record[recordKey(ctx, '04-combat')] = { rapid, seen, drawn: [...drawn].sort(), keyInstant, motion: reduced ? 'reduced' : 'full', material: previous.material_buffer.map((item) => `${item.display_name}×${item.quantity}`) };
    const mustDraw = ['dn-float.dn-float--hit', 'dn-ghost', 'dn-draw-in', ...(reduced ? [] : ['dn-bolt', 'dn-impact'])];
    check(`04-combat 戦う (${ctx.sizeLabel}): rapid casts, then a hit, a miss, a kill with its material drawn to the hero, and a hurt`,
      rapid.turns.length >= 3 && Object.values(seen).every((list) => list.length > 0) && mustDraw.every((name) => drawn.has(name)) && keyInstant !== null,
      { ...ctx.record[recordKey(ctx, '04-combat')], mustDraw });
    await sleep(600);
  },

  async '05-talk'(page, product, ctx) {
    const scene = sceneOf('05-talk');
    let view = await enter(page, product, scene);
    await page.waitFor(VOICES_GONE, 'the opening voice leaving the board', { timeoutMs: 15000 });
    // Walk to the stairs around the fights until the companion has fallen outside the board's window (at 1440×900; the other
    // sizes walk the same number of steps, so every still is of the same turn on the same board).
    const plannedSteps = ctx.sizeLabel === S.main.label ? null : ctx.record['05-talk']?.stepsWalked;
    if (ctx.sizeLabel !== S.main.label && plannedSteps === undefined) throw new Error('05-talk at another size needs the 1440x900 walk first');
    let companion = await page.js(COMPANION_SCREEN);
    let steps = 0;
    while (plannedSteps === null ? companion.onScreen : steps < plannedSteps) {
      if (steps >= 24) throw new Error(`the companion stayed on the board for ${steps} steps`);
      const route = pathTo(view, view.stairs, { avoidEnemies: true }) ?? pathTo(view, view.stairs, { avoidEnemies: false });
      if (!route?.length) throw new Error('reached the stairs with the companion still on the board');
      view = await stepOnce(page, route[0]);
      steps += 1;
      await sleep(320);
      companion = await page.js(COMPANION_SCREEN);
    }
    await sleep(500);
    await page.click('#dungeon-talk-input', {}, { steps: 14, stepMs: 25 });
    await sleep(300);
    await page.type(TALK_TEXT, 110);
    await sleep(300);
    const rowsBefore = await page.js(ASSISTANT_ROWS);
    await page.key('Enter', 'Enter', 13, { text: '\r' });
    const sentAt = Date.now();
    // The key instant: the reply still arriving (the waiting dots under the 吹き出し revealed so far) and the board brought round
    // to the companion.
    await page.waitFor(`document.querySelector('#dungeon-journal .dn-line--waiting') && ${ASSISTANT_ROWS} >= ${rowsBefore + 1}`, 'the reply arriving', { timeoutMs: 20000, intervalMs: 10 });
    await page.waitFor(`document.querySelector('#dungeon-board').getAnimations().every((a) => a.playState !== 'running')`, 'the board settled on the speaker', { timeoutMs: 3000, intervalMs: 10 });
    await sleep(300);
    const streaming = await page.js(`({
      assistantRows: ${ASSISTANT_ROWS},
      waiting: !!document.querySelector('#dungeon-journal .dn-line--waiting'),
      speaking: ${ROOT}.dataset.speaking ?? null,
      voice: document.querySelector('.dn-voice .dn-voice-text')?.textContent ?? null,
      voiceBox: ${SCREEN_OF('.dn-voice')},
      companionToken: ${SCREEN_OF('.dn-entity--companion > .dn-token')},
      heroToken: ${SCREEN_OF('.dn-entity--player > .dn-token')},
      enemyTokens: ${SCREEN_OF_ALL('.dn-entity--enemy > .dn-token')},
      window: [document.querySelector('#dungeon-viewport').getBoundingClientRect().width, document.querySelector('#dungeon-viewport').getBoundingClientRect().height]
    })`);
    await ctx.take('05-talk');
    await page.waitFor(`!document.querySelector('#dungeon-journal .dn-line--waiting') && !document.querySelector('#dungeon-talk-input').disabled && ${ROOT}.dataset.speaking === undefined`, 'the reply revealed', { timeoutMs: 40000 });
    await sleep(300);
    const done = await page.js(`({ assistantRows: ${ASSISTANT_ROWS}, focusOnInput: document.activeElement === document.querySelector('#dungeon-talk-input') })`);
    const [W, H] = streaming.window;
    const cut = (b) => b && !b.inside && b.right > 0 && b.left < W && b.bottom > 0 && b.top < H;
    const danger = [streaming.heroToken, ...streaming.enemyTokens];
    const record = { stepsWalked: steps, companionBeforeTalking: companion, typed: TALK_TEXT, keyInstant: streaming, revealedRows: done.assistantRows, sendToRevealedMs: Date.now() - sentAt, focusReturnedToInput: done.focusOnInput, cutTokens: [streaming.companionToken, ...danger].filter(cut).length };
    ctx.record[recordKey(ctx, '05-talk')] = record;
    check(`05-talk 同行者が話す (${ctx.sizeLabel}): the reply arrives piece by piece while the companion speaks, the hero and the enemies in sight stay in the window, no token is cut by its edge, and the focus comes back to the input`,
      (plannedSteps !== null || !companion.onScreen) && streaming.waiting && streaming.speaking === 'companion' && done.assistantRows > streaming.assistantRows
        && danger.every((b) => b.inside) && record.cutTokens === 0 && done.focusOnInput, record);
    await sleep(900);
  }
};

function sceneOf(id) {
  const scene = SCENES.find((entry) => entry.id === id);
  if (!scene) throw new Error(`unknown scene ${id}`);
  return scene;
}

// ── The product before the replacement (its entry and board) ────────────────────────────────────────────────────
async function enterBefore(page, product) {
  await page.load(`${product.base}/?initialScreen=debug`);
  await page.waitFor(`document.querySelector('button[data-screen="academy-dungeon"]')`, 'the debug tab bar');
  await page.click('button[data-screen="academy-dungeon"]', {}, { steps: 6, stepMs: 20 });
  await page.waitFor(`document.querySelector('#academy-dungeon-screen').classList.contains('active') && !document.querySelector('#dungeon-enter').disabled && [...document.querySelectorAll('#academy-dungeon-screen img')].every((img) => img.complete)`, 'the entry before the replacement');
  await page.js(`document.body.classList.add('play-mode'); true`);
  await sleep(600);
}
async function diveBefore(page) {
  await page.click('#dungeon-enter', {}, { steps: 12, stepMs: 25 });
  await page.waitFor(`!document.querySelector('#dungeon-play').hidden && document.querySelectorAll('.dn-tiles > *').length > 0 && document.querySelector('#academy-dungeon-screen').classList.contains('active')`, 'the board before the replacement', { timeoutMs: 60000 });
  // The opening streams into the chat column; the board is drawn and waits for keys once it has settled.
  await sleep(6000);
}
// ── The capture ────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { repoRoot, outDir } = parseArgs(process.argv.slice(2));
  const teamVars = Object.keys(process.env).filter((key) => key.startsWith('TEAM_'));
  check('no TEAM_* variable in the environment', teamVars.length === 0, { teamVars });
  const globalTimer = setTimeout(() => { console.error('FAILED global timeout (45 min)'); runTeardown().finally(() => app.exit(2)); }, 45 * 60 * 1000);
  teardown.push(async () => clearTimeout(globalTimer));
  await app.whenReady();
  app.on('window-all-closed', () => {});

  const head = (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'])).stdout.trim();
  check('repo is clean (the manifest is stamped with HEAD)', dirty === '', { head, dirty });
  const existing = await fs.readdir(outDir).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  check('out dir is absent or empty', existing.length === 0, { existing: existing.slice(0, 5) });
  await fs.mkdir(outDir, { recursive: true });
  const beforeRoot = await extractBefore(repoRoot);
  teardown.push(() => fs.rm(beforeRoot, { recursive: true, force: true }));
  const polishBaseRoot = await extractPolishBase(repoRoot);
  teardown.push(() => fs.rm(polishBaseRoot, { recursive: true, force: true }));
  const out = (name) => path.join(outDir, name);
  const artifacts = [];
  const add = (file, scene, kind, size) => artifacts.push({ file, scene, kind, size });
  const records = { scenes: {}, stillBoards: {}, aiming: {}, equipment: null, board: {}, cells: {}, before: {}, rail: {}, tokens: {}, lm: {} };

  // One walk: a fresh isolated slot and product server, a fresh page; the token watch's findings are gathered per size.
  const walk = async (label, size, { productRoot = repoRoot, hero = 'standard', kit = 'none', beforeDocument }, body) => {
    console.log(`── walk: ${label}`);
    const product = await startProduct(productRoot, { hero, kit });
    teardown.push(product.stop);
    const page = await openPage(size, { beforeDocument });
    try {
      const result = await body(page, product);
      check(`${label}: no renderer error`, page.pageErrors.length === 0, { errors: page.pageErrors });
      const watch = await page.watch();
      if (watch && productRoot === repoRoot) {
        const entry = (records.tokens[size.label] ??= { walks: 0, samples: 0, turnsSettled: 0, stills: 0, overlaps: [] });
        entry.walks += 1;
        entry.samples += watch.samples;
        entry.turnsSettled += watch.rendersSettled.length;
        entry.stills += page.tokenStills.length;
        entry.overlaps.push(...watch.overlaps.map((o) => ({ walk: label, ...o })), ...page.tokenStills.filter((s) => s.overlaps.length).map((s) => ({ walk: label, ...s })));
        check(`${label}: no two tokens on the board overlap (${watch.samples} settled samples over ${watch.rendersSettled.length} of ${watch.rendersSeen.length} turns, ${page.tokenStills.length} stills)`,
          watch.overlaps.length === 0 && page.tokenStills.every((still) => still.overlaps.length === 0), { watchOverlaps: watch.overlaps, stills: page.tokenStills.filter((still) => still.overlaps.length) });
      }
      return result;
    } finally {
      await page.close();
      teardown.splice(teardown.indexOf(product.stop), 1);
      await product.stop();
      records.lm[label] = { calls: product.lm.calls, failures: product.lm.failures };
      check(`${label}: the fixed LM answered every request (no 500)`, product.lm.failures.length === 0, { failures: product.lm.failures });
    }
  };

  // ── The key instants: 歩く・戦う・同行者が話す at MAX1920 ──
  for (const { size, walks, stills } of PASSES) {
    for (const ids of walks) {
      const first = sceneOf(ids[0]);
      const ctx = {
        record: records.scenes,
        sizeLabel: size.label,
        async take(id) {
          if (!ids.includes(id)) throw new Error(`walk ${ids.join('+')} took a key instant of ${id}`);
          if (!stills.includes(id)) return;
          await ctx.page.still(out(`${id}@${size.label}.png`));
          records.stillBoards[id] ??= {};
          records.stillBoards[id][size.label] = await boardOfStill(ctx.page);
        }
      };
      await walk(`${ids.join('+')} ${size.label}`, size, { hero: first.hero, kit: first.kit, beforeDocument: ENTER_WRAP(first.seed, null) }, async (page, product) => {
        ctx.page = page;
        await SCENE_RUNS[ids[0]](page, product, ctx);
      });
      for (const id of ids.filter((entry) => stills.includes(entry))) add(out(`${id}@${size.label}.png`), sceneOf(id).name, 'screenshot（要の一瞬）', dims(size.screen));
    }
  }

  // ── 照準: before the polish and after, at 1440×900 and MAX1920 ──
  for (const size of AIM_SIZES) {
    for (const [stage, productRoot] of [['before', polishBaseRoot], ['after', repoRoot]]) {
      const file = `state-aiming-${stage}@${size.label}.png`;
      const label = `aiming ${stage} the polish ${size.label}`;
      records.aiming[`${stage} ${size.label}`] = await walk(label, size, { productRoot, hero: 'standard', kit: 'aiming', beforeDocument: ENTER_WRAP(AIM_RUN.seed, null) }, async (page, product) => {
        await enter(page, product, { id: label, seed: AIM_RUN.seed, companion: true });
        await page.waitFor(VOICES_GONE, 'the opening voice leaving the board', { timeoutMs: 15000 });
        await sleep(400);
        await page.click('#dungeon-carry .dn-carry-row[data-key="consumable:alchemy_fire_great_blast"]', {}, { steps: 12, stepMs: 20 });
        await page.waitFor(`document.querySelector('.dn-aim') && ${ROOT}.dataset.aiming === 'true'`, 'the aim');
        const view = await stateOf(page);
        const target = aimTarget(view, await page.js(AIM_CANDIDATES));
        check(`${label}: a valid cell three or more tiles away inside the window`, target !== null, { target });
        await page.moveTo(target.point, { steps: 16, stepMs: 20 });
        await sleep(400);
        const reading = aimReading(view, target, await page.js(AIM_MARKS));
        if (stage === 'after') {
          check(`${label}: no cell never seen carries a mark, no aim cell or mark fills a surface, the pointed cell marked, the reach around it outlined`,
            reading.marksOnUnseen === 0 && reading.filled.length === 0 && reading.pointedAtTarget && reading.pointMark && reading.blast > 1 && reading.outlineEdges > 0 && reading.prompt.includes('着弾点'), reading);
        }
        await page.still(out(file));
        await page.key('Escape', 'Escape', 27);
        await page.waitFor(`!document.querySelector('.dn-aim')`, 'the aim cancelled');
        return reading;
      });
      add(out(file), `照準を合わせるとき（火の大爆薬の着弾点を指した姿・${stage === 'before' ? '直す前' : '直した後'}）`, 'screenshot', dims(size.screen));
    }
  }
  log('aiming', records.aiming);

  // ── The entry's equipment window after the polish, at MAX1920 ──
  const equipmentFile = `entry-equipment@${S.max1920.label}.png`;
  await walk(`equipment ${S.max1920.label}`, S.max1920, { hero: 'standard', kit: 'aiming', beforeDocument: ENTER_WRAP(AIM_RUN.seed, null) }, async (page, product) => {
    await enter(page, product, { id: `equipment ${S.max1920.label}`, seed: AIM_RUN.seed, companion: true }, {
      entryStill: async () => {
        await sleep(800);
        const entry = await page.js(ENTRY_READING);
        check(`entry ${S.max1920.label}: every part of the entry inside the window`, entry.inside, entry);
        await page.click('#dungeon-entry-kit button.dn-kit-plate', {}, { steps: 10, stepMs: 20 });
        await page.waitFor(`!document.querySelector('#dungeon-equip-modal').hidden && document.querySelector('.dungeon-equipment-run-title')`, 'the equipment window');
        await sleep(600);
        const shown = await page.js(EQUIPMENT_READING);
        records.equipment = shown;
        check(`equipment ${S.max1920.label}: the breakdown titled この潜りに効く補正 (no "run" in the window), its rows shown, the window inside`,
          shown.title === 'この潜りに効く補正' && shown.label === 'この潜りに効く補正' && !shown.run && shown.rows > 0 && shown.inside, shown);
        await page.still(out(equipmentFile));
        await page.click('#dungeon-equip-modal [data-close]', {}, { steps: 8, stepMs: 20 });
        await page.waitFor(`document.querySelector('#dungeon-equip-modal').hidden`, 'the equipment window closed');
      }
    });
  });
  add(out(equipmentFile), '入る前・武器の台を押して開いた装備の窓（補正の内訳の見出し）', 'screenshot', dims(S.max1920.screen));

  // ── Checks at every size ──
  // The product before the replacement first: the cells fully in its board's window at each size (the floor).
  for (const size of CHECK_SIZES) {
    records.before[size.label] = await walk(`cells before the replacement ${size.label}`, size, { productRoot: beforeRoot, hero: CELLS_RUN.hero, beforeDocument: ENTER_WRAP(CELLS_RUN.seed, true) }, async (page, product) => {
      await enterBefore(page, product);
      await diveBefore(page);
      const view = await stateOf(page);
      check(`before the replacement ${size.label}: seed ${CELLS_RUN.seed} with the companion`, view.run_id === `dr_${CELLS_RUN.seed}` && Boolean(view.companion), { run: view.run_id });
      return page.js(BEFORE_FULL_CELLS);
    });
  }
  log('cells fully in the board window before the replacement', records.before);
  // The product before the polish: the board's window and the cell at each size (the after is read in the checks below).
  for (const size of CHECK_SIZES) {
    const label = `board before the polish ${size.label}`;
    const before = await walk(label, size, { productRoot: polishBaseRoot, hero: CELLS_RUN.hero, beforeDocument: ENTER_WRAP(CELLS_RUN.seed, null) }, async (page, product) => {
      await enter(page, product, { id: label, seed: CELLS_RUN.seed, companion: true });
      await page.waitFor(VOICES_GONE, 'the opening voice leaving the board', { timeoutMs: 15000 });
      await sleep(400);
      return page.js(FULL_CELLS);
    });
    records.board[size.label] = { before, after: null };
  }
  for (const size of CHECK_SIZES) {
    const floor = records.before[size.label].full;
    for (const withCompanion of [true, false]) {
      const label = `${size.label} ${withCompanion ? 'companion' : 'solo'}`;
      await walk(`checks ${label}`, size, { hero: CELLS_RUN.hero, beforeDocument: ENTER_WRAP(CELLS_RUN.seed, null) }, async (page, product) => {
        await enter(page, product, { id: `checks ${label}`, seed: CELLS_RUN.seed, companion: withCompanion });
        await page.waitFor(VOICES_GONE, 'the opening voice leaving the board', { timeoutMs: 15000 });
        await sleep(400);
        const cells = await page.js(FULL_CELLS);
        records.cells[label] = { ...cells, floor, floorFrom: `${size.label} before the replacement` };
        if (withCompanion) records.board[size.label].after = cells;
        check(`${label}: cells fully in the board's window ≥ ${floor} (the product before the replacement at ${size.label}), and so is the window's capacity`, cells.full >= floor && cells.window.cells >= floor, records.cells[label]);
        check(`${label}: the cells touch (gap 0)`, cells.gapPx === 0, { gapPx: cells.gapPx });
        const before = await page.js(RENDER);
        await page.click('#dungeon-spells .dn-card[data-element="light"]', {}, { steps: 6, stepMs: 20 });
        await page.waitFor(`${RENDER} > ${before}`, 'the cast');
        await sleep(900);
        const rail = await page.js(RAIL_LINES);
        records.rail[label] = rail;
        check(`${label}: every rail label on one line and inside the rail`, rail.labels > 0 && rail.maxLines === 1 && rail.folded.length === 0 && rail.outside.length === 0, rail);
      });
    }
  }
  log('cells fully in the board window, and the window in whole cells', records.cells);
  const px = (pair) => pair.join('×');
  for (const size of CHECK_SIZES) {
    const { before, after } = records.board[size.label];
    console.log(`board ${size.label}: before the polish window ${px(before.viewport)} board ${px(before.board)} cell ${before.cellPx}px zoom ${before.zoom} → after window ${px(after.viewport)} board ${px(after.board)} cell ${after.cellPx}px zoom ${after.zoom}`);
  }
  for (const size of CHECK_SIZES) {
    const { before, after } = records.board[size.label];
    if (size === S.large || size === S.max1920) check(`${size.label}: the cell drawn at 96 px`, after.cellPx === 96, { before: before.cellPx, after: after.cellPx });
    else check(`${size.label}: the cell as before the polish (${before.cellPx} px)`, after.cellPx === before.cellPx, { before: before.cellPx, after: after.cellPx });
  }
  log('rail labels', records.rail);

  // Every walk on the product's board, at every size: no two tokens' boxes (face and gauges) overlap, settled or in a still.
  check('tokens: no two tokens on the board overlap in any settled frame or still, in every walk, at every size',
    CHECK_SIZES.every((size) => records.tokens[size.label]?.samples > 0) && Object.values(records.tokens).every((entry) => entry.overlaps.length === 0), records.tokens);
  for (const [size, entry] of Object.entries(records.tokens)) console.log(`tokens ${size}: walks ${entry.walks}, settled samples ${entry.samples}, turns measured settled ${entry.turnsSettled}, stills ${entry.stills}, overlaps ${entry.overlaps.length}`);

  const listing = [];
  for (const artifact of artifacts) {
    const bytes = await fs.readFile(artifact.file);
    listing.push({ ...artifact, file: path.basename(artifact.file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const written = (await fs.readdir(outDir)).sort();
  check('out dir holds exactly the listed artifacts', JSON.stringify(written) === JSON.stringify(listing.map((entry) => entry.file).sort()), { written: written.length, listed: listing.length });
  await fs.writeFile(out('manifest.json'), `${JSON.stringify({
    head,
    beforeCommit: BEFORE_COMMIT,
    polishBase: POLISH_BASE,
    streamChunkMs: STREAM_CHUNK_MS,
    holdRepeatMs: HOLD_REPEAT_MS,
    macbooks: { menuBarPt: MENU_BAR_PT, chromeFrameTopPx: CHROME_FRAME_TOP_PX, ...Object.fromEntries(Object.entries(MACBOOKS).map(([key, entry]) => [key, { ...entry, window: macbookScreen(entry) }])) },
    max1920: { ...MAX1920, chromeFrameTopPx: CHROME_FRAME_TOP_PX, window: max1920Screen() },
    sizes: S,
    passes: PASSES.map(({ size, walks, stills }) => ({ size: size.label, walks, stills })),
    scenes: SCENES,
    records,
    artifacts: listing
  }, null, 2)}\n`, 'utf8');
  for (const entry of listing) console.log(`artifact\t${entry.file}\t${entry.size}\t${entry.bytes}\t${entry.sha256}\t${entry.scene}`);
  console.log(`DONE head=${head} artifacts=${listing.length}`);
}

main()
  .then(async () => { await runTeardown(); app.exit(0); })
  .catch(async (error) => { console.error('FAILED', error); await runTeardown(); app.exit(1); });
