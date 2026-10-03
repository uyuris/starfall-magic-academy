// 夜の道行き（app/public/metaJourney.js）の撮影道具。製品を一時の root（一時のセーブ・一時の設定・固定応答の LM）で隔離して
// 起こし、Electron の隠れた窓を CDP で動かして撮る（npm test は拾わない。app/tests/manual/ の手で走らせる道具）:
//
//   ./node_modules/.bin/electron app/tests/manual/metaJourneyCapture.mjs --plan stills --stills <名,名,…> \
//     --repo-root <絶対パス> --out-dir <絶対パス> --size <W>x<H> --reduced <on|off> --lm-latency-ms <ms>
//   ./node_modules/.bin/electron app/tests/manual/metaJourneyCapture.mjs --plan anim --clips <名,名,…> \
//     --repo-root <絶対パス> --out-dir <絶対パス> --size <W>x<H> --reduced <on|off> --lm-latency-ms <ms>
//   ./node_modules/.bin/electron app/tests/manual/metaJourneyCapture.mjs --plan timing --flow <new-game|load> --runs <n> \
//     --before-root <絶対パス> --repo-root <絶対パス> --size <W>x<H> --lm-latency-ms <ms>
//   ./node_modules/.bin/electron app/tests/manual/metaJourneyCapture.mjs --plan manifest --repo-root <絶対パス> --out-dir <絶対パス>
//
// 起動口だけを起こす（撮影の各 plan が子として起こすのと同じもの。一回きりの確かめの script からも使う）:
//
//   node app/tests/manual/metaJourneyCapture.mjs --serve --repo-root <絶対パス> --port <n> --saves <none|three> --lm-latency-ms <ms>
//
// どの引数も必須で既定値は無い。--repo-root は撮る製品の tree（その tree の app/src と app/public を起こす）。out-dir を取る plan
// （manifest を除く）は、out-dir が無いか空であること。
//
// 起動口（--serve）: OS の一時ディレクトリにセーブの置き場を作り、repo-root の製品の createServer をその上で起こす。repo-root の
//   data/mutable・app/config は読まず書かない（定義 data/definitions と初期値 data/seeds は一時ディレクトリへ写して使う）。設定の
//   file（LM Studio・セリフの出かた・BGM・遊び方）も一時ディレクトリに置く。終了（SIGINT/SIGTERM）で一時ディレクトリごと消す。
//   --saves none はセーブ無しの初めての姿、three は製品の initializeNewPlayArea でルーティングの slot を3つ作り、それぞれに
//   メモを付ける（日付は数日ずつずらす）。LM は LM Studio の chat-completions と同じ口で答える固定応答で、--lm-latency-ms は
//   1要求ごとに返す前に待つ時間（ハブの支度が LM を待つ間の姿を作るため）。製品への GET 以外の要求を `api <METHOD> <path>` の
//   1行で標準出力に出す（「消す」の要求を数えるため）。
//
// stills: 道行きの各場面を、その場面で止まった瞬間に1枚ずつ PNG（viewport と同じ画素・DPR 1）で out-dir に撮る。撮るのは STILLS
//   の閉じた一覧のうち --stills に並べた名で、撮る前後の道行きの層の場面が STILLS の場面と違えば落ちる（星の道は読み込みの間だけ
//   あるので、--lm-latency-ms が短いと着いてしまい落ちる。1920×1080 では 5000 を使う）。最後に manifest.json（場面・file・大きさ・
//   動きを減らす設定・撮った commit）を書く。セーブ無しの姿だけ --saves none の起動口で撮り、ほかは --saves three の起動口1本で、
//   門 → 広間 → 足跡 → 星の道 → 露台 → 部屋（ゲームの中）→ 今日はここまで → 門 → 部屋（門から）→ 最初から始める → 星の道 → 露台、
//   の順に通す。
// anim: 道行きを CDP の screencast で録り、場面ごとに切った animated WebP を out-dir に書く（綴じは python3 の Pillow）。
//   --reduced off は ANIM_CLIPS のうち --clips に並べた場面を1本ずつ、--reduced on は同じ流れの全体を journey-reduced.webp の
//   1本にする（--clips は journey-reduced だけを取る）。この plan だけ GPU で合成し、録る frame は ANIM_MIN_FRAME_MS 以上の間隔へ
//   間引いて一時の dir に置く（録り終えたら消す）。書いた各 file を読み戻して、大きさ・frame 数・animated・長さを `anim {...}` の
//   1行で出す。道行きを通すあいだ page の中で字の重なりを毎 frame 見張り（SEAM_WATCH_SCRIPT）、通しから切った各場面の見張りの
//   frame 数と重なった frame を `seam {...}` の1行で出す（セーブの無い初めての姿は別の起動口で録るので見張らない）。
// timing: 「最初から始める」または「ロード」を押し、押してからハブが操作できるまでの秒数を、置き換え前の製品（--before-root。
//   道行きの層を持たない tree）と置き換え後（--repo-root。app/public/metaJourney.js を持つ tree）で、時間的に隣接した対で --runs
//   回測る（対ごとに先に測る側を入れ替える。run ごとに新しい起動口＝新しい一時のセーブ）。「操作できる」は #routing-hub-screen が
//   出ていて #routing-hub-input が押せることで、置き換え後では加えて層がハブを覆っていない（場面が arriving か play）こと。ロードは
//   広間（置き換え前はロードの画面）が出てから、いちばん新しいセーブを押した時刻を「押した」とする。置き換え後では、層が露台に
//   着いた時刻（場面が arriving になった時刻）と、ハブ自身が操作できる時刻を同じ観測（一つの MutationObserver）で取り、露台だけが
//   見えている時間（着いてから層の opacity が 1 を割るまで）も rAF ごとに測る。各 run を `run {...}`（直前の load average 付き）、
//   側ごとの中央値を `median {...}` の1行で出す。
// manifest: out-dir の中の regular file すべて（manifest.json 自身を除く）の相対パス・bytes・sha256 と repo-root の HEAD を
//   out-dir/manifest.json に書く。regular file でも dir でもない entry があれば何も書かずに落ちる。
//
// 入力はすべて CDP の Input（マウスの押下・移動）で、製品の page には手を入れない。起動口と python3 の子プロセスには TEAM_* を
// 渡さない。
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LAUNCHER_EXIT_MS = 10000;

const SELF = fileURLToPath(import.meta.url);

// 「--名 値」の並びを { '--名': 値 } にする（--serve だけは値を取らない）。
function parseTokens(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    if (token === '--serve') {
      parsed[token] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    parsed[token] = value;
    i += 1;
  }
  return parsed;
}

function requireKnown(parsed, known, label) {
  for (const token of Object.keys(parsed)) {
    if (!known.includes(token)) throw new Error(`unexpected argument for ${label}: ${token}`);
  }
  for (const token of known) {
    if (parsed[token] === undefined) throw new Error(`${token} is required (no default)`);
  }
}

function requireAbsolute(parsed, token) {
  if (!path.isAbsolute(parsed[token])) throw new Error(`${token} must be an absolute path`);
  return parsed[token];
}

function parseNonNegativeInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

const SAVES = ['none', 'three'];

function parseServeArgs(parsed) {
  requireKnown(parsed, ['--serve', '--repo-root', '--port', '--saves', '--lm-latency-ms'], '--serve');
  const port = parseNonNegativeInteger(parsed['--port'], '--port');
  if (port === 0) throw new Error('--port must be a fixed port (1-65535), got 0');
  if (!SAVES.includes(parsed['--saves'])) throw new Error(`--saves must be none or three, got ${JSON.stringify(parsed['--saves'])}`);
  return {
    repoRoot: requireAbsolute(parsed, '--repo-root'),
    port,
    saves: parsed['--saves'],
    lmLatencyMs: parseNonNegativeInteger(parsed['--lm-latency-ms'], '--lm-latency-ms')
  };
}

function parseArgs(parsed) {
  const plan = parsed['--plan'];
  const knownByPlan = {
    stills: ['--plan', '--stills', '--repo-root', '--out-dir', '--size', '--reduced', '--lm-latency-ms'],
    anim: ['--plan', '--clips', '--repo-root', '--out-dir', '--size', '--reduced', '--lm-latency-ms'],
    timing: ['--plan', '--flow', '--runs', '--before-root', '--repo-root', '--size', '--lm-latency-ms'],
    manifest: ['--plan', '--repo-root', '--out-dir']
  };
  if (!knownByPlan[plan]) throw new Error(`--plan must be one of ${Object.keys(knownByPlan).join(', ')}, got ${JSON.stringify(plan)}`);
  requireKnown(parsed, knownByPlan[plan], `--plan ${plan}`);
  const repoRoot = requireAbsolute(parsed, '--repo-root');
  if (parsed['--out-dir'] !== undefined) requireAbsolute(parsed, '--out-dir');
  if (plan === 'manifest') return { plan, repoRoot, outDir: parsed['--out-dir'] };
  const size = /^(\d+)x(\d+)$/.exec(parsed['--size']);
  if (!size) throw new Error(`--size must be <W>x<H>, got ${JSON.stringify(parsed['--size'])}`);
  const options = {
    plan,
    repoRoot,
    viewport: { width: Number(size[1]), height: Number(size[2]) },
    lmLatencyMs: parseNonNegativeInteger(parsed['--lm-latency-ms'], '--lm-latency-ms')
  };
  if (plan === 'stills' || plan === 'anim') {
    if (!['on', 'off'].includes(parsed['--reduced'])) throw new Error('--reduced must be on or off');
    const reduced = parsed['--reduced'] === 'on';
    if (plan === 'stills') return { ...options, outDir: parsed['--out-dir'], reduced, stills: parseNames('--stills', parsed['--stills'], Object.keys(STILLS)) };
    const clipNames = reduced ? [ANIM_REDUCED_CLIP] : ANIM_CLIPS;
    return { ...options, outDir: parsed['--out-dir'], reduced, clips: parseNames('--clips', parsed['--clips'], clipNames) };
  }
  if (!['new-game', 'load'].includes(parsed['--flow'])) throw new Error('--flow must be new-game or load');
  if (!/^[1-9]\d*$/.test(parsed['--runs'])) throw new Error('--runs must be a positive integer');
  return { ...options, beforeRoot: requireAbsolute(parsed, '--before-root'), flow: parsed['--flow'], runs: Number(parsed['--runs']), reduced: false };
}

// 「名,名,…」の引数を、known の閉じた一覧の中の重複の無い名の Set にする。
function parseNames(token, value, known) {
  const names = value.split(',');
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`${token} takes names from ${known.join(', ')}, got ${JSON.stringify(unknown)}`);
  if (new Set(names).size !== names.length) throw new Error(`${token} names a scene twice: ${value}`);
  return new Set(names);
}

function isolatedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TEAM_') && key !== 'ELECTRON_RUN_AS_NODE'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── 起動口の中身（--serve） ─────────────────────────────────────────────────────────────────────────────
const HOST = '127.0.0.1';
const LAUNCHER_READY_PREFIX = '起動口:';
// three の3つのセーブ（足跡を見るための仮のメモ）。日付は一時の置き場を作った時刻から数日ずつ遡る。
const PREPARED_SLOTS = [
  { daysAgo: 9, note: '星降り祭の前の週' },
  { daysAgo: 4, note: '大書庫で題を探している' },
  { daysAgo: 1, note: '' }
];
const PREPARED_PERSONA_VARIANT = 'fallen_star';

async function writeJson(root, relativePath, value) {
  const full = path.join(root, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function importFromRoot(repoRoot, relativePath) {
  return import(pathToFileURL(path.join(repoRoot, relativePath)).href);
}

async function buildIsolatedRoot({ repoRoot, saves }) {
  const { runtimePathsManifestFilename } = await importFromRoot(repoRoot, 'app/src/runtimePaths.mjs');
  const { initializeNewPlayArea } = await importFromRoot(repoRoot, 'app/src/playSession.mjs');
  const { updateSaveSlotNote } = await importFromRoot(repoRoot, 'app/src/saveLoad.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-journey-capture-'));
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  const mutableRoot = path.join(root, 'data/mutable/game_data');
  await fs.cp(path.join(repoRoot, 'data/definitions/game_data'), definitionsRoot, { recursive: true });
  await fs.cp(path.join(repoRoot, 'data/seeds/game_data'), seedsRoot, { recursive: true });
  await fs.cp(seedsRoot, mutableRoot, { recursive: true });
  await writeJson(root, runtimePathsManifestFilename, {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot,
    seedsRoot,
    mutableRoot,
    characterContentRoot: path.join(repoRoot, 'content/characters'),
    creatureContentRoot: path.join(repoRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  });
  if (saves === 'three') {
    const startedAt = Date.now();
    for (const prepared of PREPARED_SLOTS) {
      const now = new Date(startedAt - prepared.daysAgo * 86_400_000).toISOString();
      const { slot } = await initializeNewPlayArea({ root, playMode: 'routing', routingPersonaVariant: PREPARED_PERSONA_VARIANT, now });
      if (prepared.note !== '') await updateSaveSlotNote({ root, slotId: slot.slot_id, playerNote: prepared.note, now });
    }
  }
  return root;
}

// 固定応答の LM。案内人の文は姿を見るための仮の文（製品の本文ではない）。答えは次の閉じた集合:
//   - 構造化の要求（response_format）: schema 名が表情の選択・記録の想起のもの。ほかの schema 名は 500。
//   - 判定の問い（移動の合意・継続・好感度・MP 温存・所持金・行き先の選定）と送り出し・足跡のまとめ: 本文の目印で見分ける。
//   - 上のどれにも当たらない本文の要求（ハブの迎え・ハブでの返事・後処理の記録）: 案内人の固定の短い文。
const FIXTURE_GUIDE_LINE = '（露台の手すりから振り返って）おかえりなさい。今夜も星がよく見えるよ。今週はどこへ行く？';
const FIXTURE_SENDOFF = '（星の道の先を指さして）いってらっしゃい。帰りの灯りはつけておくね。';
const FIXTURE_FOOTPRINT_SUMMARY = '第1週、まだ近しい相手はおらず、露台で案内人と今週の行き先を話し合った。';
const FIXTURE_SCHEMA_ANSWERS = new Map([
  ['character_emotion_choice', JSON.stringify({ expression: 'joy' })],
  ['work_record_recall_choice', JSON.stringify({ work_record_ids: [] })]
]);
const FIXTURE_PROMPT_ANSWERS = [
  ['この発言を行ったプレイヤーとの会話を継続したいと思うか', 'true'],
  ['好感度の変化量を判定する', '0'],
  ['MP温存ライン', '30'],
  ['所持金判定', '0'],
  ['場所移動の合意', 'false'],
  ['location_idを1つだけ返す', 'none'],
  ['行き先が確定したプレイヤーを送り出す', FIXTURE_SENDOFF],
  ['セーブデータに添える短い覚え書き', FIXTURE_FOOTPRINT_SUMMARY]
];
const FIXTURE_CHAT_MODEL = 'capture-chat';
const FIXTURE_REFLECTION_MODEL = 'capture-reflection';

function fixtureAnswer(body) {
  const prompt = body.messages.map((message) => message.content ?? '').join('\n');
  const schemaName = body.response_format?.json_schema?.name ?? null;
  if (schemaName !== null) {
    if (!FIXTURE_SCHEMA_ANSWERS.has(schemaName)) throw new Error(`fixture lm: unknown structured request ${schemaName}`);
    return FIXTURE_SCHEMA_ANSWERS.get(schemaName);
  }
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'none';
  for (const [marker, answer] of FIXTURE_PROMPT_ANSWERS) {
    if (prompt.includes(marker)) return answer;
  }
  return FIXTURE_GUIDE_LINE;
}

function startFixtureLm({ lmLatencyMs }) {
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let answer;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      answer = fixtureAnswer(body);
    } catch (error) {
      console.error(`fixture-lm 500: ${error.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
      return;
    }
    await sleep(lmLatencyMs);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const characters = [...answer];
    for (let index = 0; index < characters.length; index += 3) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: characters.slice(index, index + 3).join('') } }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve({ server, baseUrl: `http://${HOST}:${server.address().port}/v1` }));
  });
}

// 終わるときは、まだ開いている接続（閉じた窓の要求が残した socket など）を待たずに切ってから閉じる。
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

async function serve(options) {
  const root = await buildIsolatedRoot(options);
  const closers = [];
  let closing = false;
  const shutdown = async (code) => {
    if (closing) return;
    closing = true;
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  try {
    const lm = await startFixtureLm(options);
    closers.push(() => closeServer(lm.server));
    await writeJson(root, 'app/config/lmstudio.json', {
      provider: 'lmstudio',
      base_url: lm.baseUrl,
      chat_model: FIXTURE_CHAT_MODEL,
      reflection_model: FIXTURE_REFLECTION_MODEL,
      timeout_ms: 120000,
      stream: true,
      thinking_effort: null,
      mock_provider_enabled: false
    });
    const { createServer: createProductServer } = await importFromRoot(options.repoRoot, 'app/src/server.mjs');
    const product = createProductServer({
      root,
      publicRoot: path.join(options.repoRoot, 'app/public'),
      canonicalAssetsRoot: path.join(options.repoRoot, 'assets/canonical'),
      playModeSettingsPath: path.join(root, 'app/config/play-mode.json'),
      conversationPopupSettingsPath: path.join(root, 'app/config/conversation-popup.json'),
      audioSettingsPath: path.join(root, 'app/config/audio.json'),
      lmStudioConfigPath: path.join(root, 'app/config/lmstudio.json')
    });
    product.on('request', (req) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') console.log(`api ${req.method} ${new URL(req.url, `http://${HOST}`).pathname}`);
    });
    await new Promise((resolve, reject) => {
      product.once('error', reject);
      product.listen(options.port, HOST, resolve);
    });
    closers.push(() => closeServer(product));
    console.log(`meta journey capture launcher (saves=${options.saves}, lm-latency-ms=${options.lmLatencyMs}) isolated root: ${root}`);
    console.log(`${LAUNCHER_READY_PREFIX} http://${HOST}:${options.port}/`);
  } catch (error) {
    console.error(error);
    await shutdown(1);
  }
}

// ── 起動口 ─────────────────────────────────────────────────────────────────────────────────────────────────
async function startLauncher({ repoRoot, saves, lmLatencyMs }) {
  const port = await freePort();
  const child = spawn('node', [SELF, '--serve', '--repo-root', repoRoot, '--port', String(port), '--saves', saves, '--lm-latency-ms', String(lmLatencyMs)], {
    cwd: repoRoot,
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const log = [];
  const failures = [];
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      log.push(line);
      if (line.startsWith(`${LAUNCHER_READY_PREFIX} `)) ready();
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    failures.push(text);
    process.stderr.write(`launcher-stderr: ${text}`);
  });
  const outcome = await Promise.race([readyPromise.then(() => 'ready'), exited.then(() => 'exited'), sleep(60000).then(() => 'timeout')]);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const result = await Promise.race([exited, sleep(LAUNCHER_EXIT_MS).then(() => null)]);
    if (result === null) {
      child.kill('SIGKILL');
      throw new Error(`launcher pid ${child.pid} did not exit within ${LAUNCHER_EXIT_MS} ms of SIGTERM (killed)`);
    }
    return result;
  };
  if (outcome !== 'ready') {
    await stop();
    throw new Error(`launcher did not come up (${outcome})`);
  }
  return { base: `http://127.0.0.1:${port}`, log, failures, stop, pid: child.pid };
}

// ── CDP の窓 ───────────────────────────────────────────────────────────────────────────────────────────────
async function openWindow(viewport, reduced) {
  const win = new electron.BrowserWindow({ width: viewport.width, height: viewport.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) {
      pageErrors.push(message);
      console.log(`renderer-error: ${message}`);
    }
  });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
  const js = (expression) => win.webContents.executeJavaScript(expression);
  const waitFor = async (expression, { timeoutMs, label }) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await js(expression)) return;
      await sleep(50);
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}: ${expression}`);
  };
  const center = async (selector) => {
    const box = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    if (!box || box.w === 0 || box.h === 0) throw new Error(`no visible element for ${selector}`);
    return box;
  };
  const hover = async (selector) => {
    const { x, y } = await center(selector);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  };
  const click = async (selector) => {
    const { x, y } = await center(selector);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  };
  // screencast の frame は届いた時刻（Date.now）と一緒に frameDir へ JPEG で書く（届いた順の連番）。書くのは前に書いた frame から
  // ANIM_MIN_FRAME_MS 以上あいた frame だけで、間に合わなかった frame は held に1枚だけ残す。held のあと ANIM_MIN_FRAME_MS 以上
  // 何も届かなければ、それは動きが止まる直前の姿なので、次の frame の前（または録画の終わり）に書く。
  let recording = null;
  const keep = (frame) => {
    const file = path.join(recording.frameDir, `${String(recording.frames.length).padStart(6, '0')}.jpg`);
    recording.frames.push({ at: frame.at, file });
    recording.writes.push(fs.writeFile(file, Buffer.from(frame.data, 'base64')));
  };
  cdp.on('message', (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => { if (recording) recording.failures.push(error); });
    if (!recording) return;
    const frame = { at: Date.now(), data: params.data };
    if (recording.held && frame.at - recording.held.at >= ANIM_MIN_FRAME_MS) keep(recording.held);
    recording.held = null;
    const last = recording.frames.at(-1);
    if (!last || frame.at - last.at >= ANIM_MIN_FRAME_MS) keep(frame);
    else recording.held = frame;
  });
  const startRecording = async (frameDir) => {
    if (recording) throw new Error('a recording is already running');
    recording = { frameDir, frames: [], writes: [], failures: [], held: null };
    await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  };
  const stopRecording = async () => {
    await send('Page.stopScreencast');
    if (recording.held) keep(recording.held);
    const done = recording;
    recording = null;
    await Promise.all(done.writes);
    if (done.failures.length > 0) throw new Error(`screencast ack failed: ${done.failures.join(' | ')}`);
    return done.frames;
  };
  const close = async () => {
    cdp.detach();
    win.destroy();
  };
  return { win, send, js, waitFor, center, hover, click, screenshot, startRecording, stopRecording, pageErrors, close };
}

// 押した時刻とハブが操作できた時刻を page の中で測る（CDP の押下が page に届いた時刻から）。置き換え後では、層が露台に着いた時刻
// （場面が arriving になった）とハブ自身が操作できる時刻を同じ MutationObserver の同じ callback の中で取り、露台だけが見えている
// 時間（着いてから層の opacity が 1 を割った最初の frame まで）を rAF ごとに見る。
const MEASURE_SCRIPT = `(() => {
  const measure = { armed: false, press: null, operable: null, hubOperable: null, arrived: null, dissolveStart: null, requests: [] };
  window.__captureMeasure = measure;
  // 押したあとの /api/ 要求の始まりと終わり（二つの側の待ちの内訳を並べるため）。
  const pageFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (measure.press === null || !url.startsWith('/api/')) return pageFetch(input, init);
    const entry = { method: init?.method ?? 'GET', url, startMs: Math.round(performance.now() - measure.press), endMs: null };
    measure.requests.push(entry);
    const settle = () => { entry.endMs = Math.round(performance.now() - measure.press); };
    const pending = pageFetch(input, init);
    pending.then(settle, settle);
    return pending;
  };
  document.addEventListener('pointerdown', () => { if (measure.armed && measure.press === null) measure.press = performance.now(); }, true);
  const hub = document.querySelector('#routing-hub-screen');
  const input = document.querySelector('#routing-hub-input');
  const journey = document.querySelector('#journey');
  const observe = () => {
    if (measure.press === null) return;
    const now = performance.now();
    const hubReady = hub.classList.contains('active') && !input.disabled;
    const uncovered = !journey || journey.dataset.scene === 'play' || journey.dataset.scene === 'arriving';
    if (journey && measure.arrived === null && journey.dataset.scene === 'arriving') measure.arrived = now;
    if (measure.hubOperable === null && hubReady) measure.hubOperable = now;
    if (measure.operable === null && uncovered && hubReady) measure.operable = now;
  };
  new MutationObserver(observe).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'data-scene'] });
  const watchDissolve = () => {
    if (journey && measure.arrived !== null && measure.dissolveStart === null && Number(getComputedStyle(journey).opacity) < 1) measure.dissolveStart = performance.now();
    requestAnimationFrame(watchDissolve);
  };
  requestAnimationFrame(watchDissolve);
  return true;
})()`;

const HUB_OPERABLE = `(() => { const hub = document.querySelector('#routing-hub-screen'); const input = document.querySelector('#routing-hub-input'); return !!(hub?.classList.contains('active') && input && !input.disabled); })()`;
const JOURNEY_IN_PLAY = `document.querySelector('#journey')?.dataset.scene === 'play'`;
const JOURNEY_SCENE = `(document.querySelector('#journey')?.dataset.scene ?? null)`;
// いちばん新しいセーブの slot id。前後どちらの製品にもあるロードの一覧（カードの要約の2つ目が更新日時・メモ欄の name が
// player_note_<slot id>）から、足跡と同じ並べ方（更新日時の新しい順）で選ぶ。
const NEWEST_SLOT_ID = `(() => {
  const cards = [...document.querySelectorAll('#slot-load-list .slot-load-item:not(.slot-load-item-degraded)')].map((card) => ({
    slotId: card.querySelector('textarea').name.replace(/^player_note_/, ''),
    updatedAt: card.querySelector('.slot-load-item-summary > p').textContent.split(' / ')[1]
  }));
  if (cards.length !== 3) throw new Error('expected 3 loadable slot cards, got ' + cards.length);
  return cards.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0].slotId;
})()`;

// 置き換え後の製品を開き、門（道行きの層）が起動の終わりまで来て題字が灯るまで待つ。saves は起動口のセーブ（three なら
// 「ロード」が灯っている、none なら灯っていない）。
async function openAfter(page, base, saves) {
  await page.win.loadURL(`${base}/`);
  await page.waitFor(`document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#title-screen')?.classList.contains('active')`, { timeoutMs: 20000, label: 'gate after boot' });
  await page.waitFor(`document.querySelector('.journey-title')?.classList.contains('is-lit') && document.querySelector('[data-journey-action="load"]')?.disabled === ${saves === 'none'}`, { timeoutMs: 10000, label: `lit gate (saves ${saves})` });
}

// 置き換え前の製品を開き、起動の最後の showScreen('title')（#title-starfield の data-starfield を立てる）まで待つ。その前に押すと、
// 開いた画面が起動の最後で門へ戻される。
async function openBefore(page, base) {
  await page.win.loadURL(`${base}/`);
  await page.waitFor(`document.querySelector('#title-starfield')?.dataset.starfield !== undefined && document.querySelector('#title-screen')?.classList.contains('active') && document.querySelector('#open-load-screen')?.disabled === false`, { timeoutMs: 20000, label: 'title after boot (before)' });
}

// 門から広間（置き換え前はロードの画面）へ進み、セーブが3つ並ぶまで待って、いちばん新しいセーブを押す selector を返す。
async function enterHall(page, side) {
  if (side === 'after') {
    await page.click('[data-journey-action="load"]');
    await page.waitFor(`document.querySelectorAll('.journey-footprint').length === 3`, { timeoutMs: 10000, label: 'three footprints' });
  } else {
    await page.click('#open-load-screen');
    await page.waitFor(`document.querySelector('#slot-load-screen')?.classList.contains('active') && document.querySelectorAll('#slot-load-list .slot-load-item').length === 3`, { timeoutMs: 10000, label: 'slot list (before)' });
  }
  const slotId = await page.js(NEWEST_SLOT_ID);
  return side === 'after'
    ? `.journey-footprint[data-slot-id="${slotId}"] .journey-footprint-light`
    : `#slot-load-list .slot-load-item:has(textarea[name="player_note_${slotId}"]) .dialog-action-row button:first-child`;
}

// 置き換え前の tree は道行きの層を持たず、置き換え後の tree は持つ。取り違えた root で測らない。
async function assertTreeSide(repoRoot, side) {
  const hasJourney = await fs.access(path.join(repoRoot, 'app/public/metaJourney.js')).then(() => true, () => false);
  if (hasJourney !== (side === 'after')) throw new Error(`${repoRoot} ${hasJourney ? 'has' : 'lacks'} app/public/metaJourney.js, so it is not the ${side} tree`);
}

// ── stills ─────────────────────────────────────────────────────────────────────────────────────────────────
// 静止ごとに、撮る前と撮った後の両方で道行きの層がいるべき場面。
const STILLS = {
  '01-gate-lit': 'gate',
  '02-gate-no-saves': 'gate',
  '03-hall': 'hall',
  '04-hall-near': 'hall',
  '05-hall-chosen': 'road',
  '06-road': 'road',
  '07-terrace-hub': 'play',
  '08-room-in-play': 'room',
  '09-return-road': 'road',
  '10-gate-returned': 'gate',
  '11-room-from-gate': 'room',
  '12-new-game-road': 'road',
  '13-new-game-hub': 'play'
};

async function commitOf(repoRoot) {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

async function assertEmptyOutDir(outDir) {
  const entries = await fs.readdir(outDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entries === null) {
    await fs.mkdir(outDir, { recursive: true });
    return;
  }
  if (entries.length > 0) throw new Error(`--out-dir must be absent or empty: ${outDir} holds ${entries.length} entries`);
}

async function runStills(options) {
  await assertEmptyOutDir(options.outDir);
  const shots = [];
  const settle = options.reduced ? 700 : 3200;
  const shoot = async (page, name) => {
    const expected = STILLS[name];
    if (!expected) throw new Error(`unknown still ${name}`);
    if (!options.stills.has(name)) return;
    const readScene = () => page.js(`document.querySelector('#journey')?.dataset.scene ?? null`);
    const before = await readScene();
    const file = `${name}.png`;
    await page.screenshot(path.join(options.outDir, file));
    const scene = await readScene();
    if (before !== expected || scene !== expected) throw new Error(`still ${name} expects scene ${expected}, got ${before} before and ${scene} after the shot`);
    shots.push({ name, file, scene });
    console.log(`still ${name} (scene ${scene})`);
  };

  // セーブの無い初めての姿。
  if (options.stills.has('02-gate-no-saves')) {
    const empty = await startLauncher({ repoRoot: options.repoRoot, saves: 'none', lmLatencyMs: options.lmLatencyMs });
    try {
      const page = await openWindow(options.viewport, options.reduced);
      await openAfter(page, empty.base, 'none');
      await sleep(settle);
      await shoot(page, '02-gate-no-saves');
      await page.close();
    } finally {
      await empty.stop();
    }
  }

  const launcher = await startLauncher({ repoRoot: options.repoRoot, saves: 'three', lmLatencyMs: options.lmLatencyMs });
  try {
    const page = await openWindow(options.viewport, options.reduced);
    await openAfter(page, launcher.base, 'three');
    await sleep(settle);
    await shoot(page, '01-gate-lit');

    await page.click('[data-journey-action="load"]');
    await page.waitFor(`document.querySelectorAll('.journey-footprint').length === 3`, { timeoutMs: 10000, label: 'three footprints' });
    await sleep(settle);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    await shoot(page, '03-hall');
    await page.hover('.journey-footprint:nth-child(2) .journey-footprint-light');
    await sleep(900);
    await shoot(page, '04-hall-near');

    await page.click('.journey-footprint:nth-child(2) .journey-footprint-light');
    await sleep(options.reduced ? 300 : 700);
    await shoot(page, '05-hall-chosen');
    await page.waitFor(`document.querySelector('#journey')?.dataset.scene === 'road'`, { timeoutMs: 5000, label: 'road' });
    await sleep(options.reduced ? 500 : 1500);
    await shoot(page, '06-road');
    await page.waitFor(`${HUB_OPERABLE} && ${JOURNEY_IN_PLAY}`, { timeoutMs: 60000, label: 'hub operable after load' });
    await sleep(1200);
    await shoot(page, '07-terrace-hub');

    await page.click('[data-journey-action="room-in-play"]');
    await page.waitFor(`document.body.classList.contains('journey-room-lit')`, { timeoutMs: 5000, label: 'room lit in play' });
    await sleep(options.reduced ? 700 : 1600);
    await shoot(page, '08-room-in-play');
    await page.click('#settings-screen .journey-room-way');
    await page.waitFor(`!document.body.classList.contains('journey-room-lit') && ${JOURNEY_IN_PLAY}`, { timeoutMs: 5000, label: 'room closed in play' });

    await page.click('#routing-hub-end');
    await page.waitFor(`document.querySelector('#journey')?.dataset.scene === 'road'`, { timeoutMs: 20000, label: 'return road' });
    await sleep(options.reduced ? 400 : 1600);
    await shoot(page, '09-return-road');
    await page.waitFor(`document.querySelector('#title-screen')?.classList.contains('active') && document.querySelector('#journey')?.dataset.scene === 'gate'`, { timeoutMs: 60000, label: 'gate after 今日はここまで' });
    await sleep(settle);
    await shoot(page, '10-gate-returned');

    await page.click('[data-journey-action="settings"]');
    await page.waitFor(`document.querySelector('#settings-screen')?.classList.contains('active')`, { timeoutMs: 5000, label: 'room from gate' });
    await sleep(settle);
    await shoot(page, '11-room-from-gate');
    await page.click('#settings-screen .journey-room-way');
    await page.waitFor(`document.querySelector('#title-screen')?.classList.contains('active')`, { timeoutMs: 5000, label: 'gate from room' });
    await sleep(settle);

    await page.click('[data-journey-action="new-game"]');
    await page.waitFor(`document.querySelector('#journey')?.dataset.scene === 'road'`, { timeoutMs: 5000, label: 'new game road' });
    await sleep(options.reduced ? 500 : 1500);
    await shoot(page, '12-new-game-road');
    await page.waitFor(`${HUB_OPERABLE} && ${JOURNEY_IN_PLAY}`, { timeoutMs: 60000, label: 'hub operable after new game' });
    await sleep(1200);
    await shoot(page, '13-new-game-hub');
    if (page.pageErrors.length > 0) throw new Error(`page errors: ${page.pageErrors.join(' | ')}`);
    await page.close();
  } finally {
    await launcher.stop();
  }
  const missing = [...options.stills].filter((name) => !shots.some((shot) => shot.name === name));
  if (missing.length > 0) throw new Error(`stills not taken: ${missing.join(', ')}`);
  await fs.writeFile(path.join(options.outDir, 'manifest.json'), `${JSON.stringify({
    commit: await commitOf(options.repoRoot),
    viewport: options.viewport,
    reducedMotion: options.reduced,
    lmLatencyMs: Number(options.lmLatencyMs),
    stills: shots
  }, null, 2)}\n`);
  console.log(`stills: ${shots.length} PNG + manifest.json in ${options.outDir}`);
}

// ── anim ───────────────────────────────────────────────────────────────────────────────────────────────────
// --reduced off で書く場面の閉じた一覧（file 名の順は発注の場面の順）。
const ANIM_CLIPS = [
  '01-open-star-title',
  '02-new-game-gate-to-road',
  '03-load-hall-footprint-road',
  '04-road-crossing',
  '05-terrace-arrival-hub',
  '06-end-day-back-to-gate',
  '07-room-from-gate',
  '08-room-in-play',
  '09-first-no-saves'
];
// --reduced on で書く通しの1本。
const ANIM_REDUCED_CLIP = 'journey-reduced';
const ANIM_MIN_FRAME_MS = 40;
const ANIM_QUALITY = 80;

// 字の重なりの見張り。page の中で毎 frame（requestAnimationFrame）、道行きの層（#journey）の見えている字の箱と、ほかの見えている
// 字の箱（層の別の要素の字・層が覆っていない製品の字と入力欄）・層の線と光（下記）が縦横とも SEAM_MIN_OVERLAP_PX を超えて
// 交わるかを調べ、見張った frame の時刻（Date.now）と、交わった frame の時刻と字の組を window.__seamWatch に積む。
//   見えている字: 空白でない text の行の箱で、親の要素の visibility が visible、祖先まで掛けた opacity が SEAM_MIN_OPACITY を
//   超え、窓の中にあるもの。製品の入力欄（input・textarea）は中の字の代わりに欄の箱を使う（置かれた案内の字は text を持たない）。
//   製品の字を数えるのは、層が覆っていない（場面が arriving か play、または層の opacity が 1 未満）ときと、層より上に出る
//   #settings-screen の中の字だけ。
//   層の字は、層の線と光とも見張る: 足跡の天球儀と床の光（見えている箱）、広間の道の線（描けている分を SEAM_TRAIL_SAMPLES 等分
//   した点が字の箱から SEAM_LINE_REACH_PX 以内に来たら）、読み込みの星座（字の箱の下の canvas の画素の alpha が
//   SEAM_CONSTELLATION_MIN_ALPHA を超えたら）。門をくぐる一瞬・露台に着く一瞬の光（.journey-flash）と星屑の空は見張らない。
const SEAM_MIN_OPACITY = 0.02;
const SEAM_MIN_OVERLAP_PX = 1;
const SEAM_TRAIL_SAMPLES = 64;
const SEAM_LINE_REACH_PX = 3;
const SEAM_CONSTELLATION_MIN_ALPHA = 24;
const SEAM_WATCH_SCRIPT = `(() => {
  const layer = document.querySelector('#journey');
  if (!layer) throw new Error('no #journey layer to watch');
  const watch = { running: true, samples: [], hits: [] };
  window.__seamWatch = watch;
  const opacityOf = (element, cache) => {
    if (!element) return 1;
    if (cache.has(element)) return cache.get(element);
    const value = Number(getComputedStyle(element).opacity) * opacityOf(element.parentElement, cache);
    cache.set(element, value);
    return value;
  };
  const shown = (element, cache) => getComputedStyle(element).visibility === 'visible' && opacityOf(element, cache) > ${SEAM_MIN_OPACITY};
  const inView = (rect) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  const label = (element, text) => {
    const id = element.id ? '#' + element.id : '';
    const classes = typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\\s+/).join('.') : '';
    return element.tagName.toLowerCase() + id + classes + ' ' + JSON.stringify(text.slice(0, 24));
  };
  const range = document.createRange();
  const textBoxes = (root, cache, skip) => {
    const boxes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || (skip && skip.contains(element)) || node.data.trim() === '') continue;
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(inView);
      if (rects.length === 0 || !shown(element, cache)) continue;
      for (const rect of rects) boxes.push({ element, rect, name: label(element, node.data.trim()) });
    }
    return boxes;
  };
  const fieldBoxes = (root, cache, skip) => [...root.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=range]), textarea')]
    .filter((element) => !(skip && skip.contains(element)))
    .map((element) => ({ element, rect: element.getBoundingClientRect(), name: label(element, element.value || element.placeholder || '') }))
    .filter((box) => inView(box.rect) && shown(box.element, cache));
  const cross = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > ${SEAM_MIN_OVERLAP_PX} && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > ${SEAM_MIN_OVERLAP_PX};
  // 層の線と光: 足跡の天球儀と床の光（箱）、広間の道の線（描けている分の点）、読み込みの星座（字の箱の下の canvas の画素）。
  const lightBoxes = (cache) => [...layer.querySelectorAll('.journey-footprint-globe, .journey-footprint-pool')]
    .map((element) => ({ element, rect: element.getBoundingClientRect(), name: 'light ' + element.className + ' ' + (element.closest('[data-slot-id]')?.dataset.slotId ?? '') }))
    .filter((box) => inView(box.rect) && shown(box.element, cache));
  const trailLine = layer.querySelector('.journey-hall-trail-line');
  const trailPoints = (cache) => {
    if (!trailLine || !trailLine.getAttribute('d') || !shown(trailLine, cache)) return [];
    const drawn = 1 - Number.parseFloat(getComputedStyle(trailLine).strokeDashoffset);
    if (!(drawn > 0)) return [];
    const total = trailLine.getTotalLength();
    const ctm = trailLine.getScreenCTM();
    const points = [];
    for (let i = 0; i <= ${SEAM_TRAIL_SAMPLES}; i += 1) {
      const point = trailLine.getPointAtLength((total * Math.min(1, drawn) * i) / ${SEAM_TRAIL_SAMPLES});
      points.push(new DOMPoint(point.x, point.y).matrixTransform(ctm));
    }
    return points;
  };
  const near = (rect, point) => point.x >= rect.left - ${SEAM_LINE_REACH_PX} && point.x <= rect.right + ${SEAM_LINE_REACH_PX} && point.y >= rect.top - ${SEAM_LINE_REACH_PX} && point.y <= rect.bottom + ${SEAM_LINE_REACH_PX};
  const constellation = layer.querySelector('#journey-constellation');
  const constellationUnder = (rect, cache) => {
    if (!constellation || !shown(constellation, cache) || constellation.width === 0) return false;
    const box = constellation.getBoundingClientRect();
    const sx = constellation.width / box.width;
    const sy = constellation.height / box.height;
    const x = Math.max(0, Math.floor((rect.left - box.left) * sx));
    const y = Math.max(0, Math.floor((rect.top - box.top) * sy));
    const w = Math.min(constellation.width - x, Math.ceil(rect.width * sx));
    const h = Math.min(constellation.height - y, Math.ceil(rect.height * sy));
    if (w <= 0 || h <= 0) return false;
    const data = constellation.getContext('2d').getImageData(x, y, w, h).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > ${SEAM_CONSTELLATION_MIN_ALPHA}) return true;
    return false;
  };
  const sample = () => {
    if (!watch.running) return;
    const at = Date.now();
    const cache = new Map();
    watch.samples.push(at);
    const mine = textBoxes(layer, cache, null);
    if (mine.length > 0) {
      const covering = !['arriving', 'play'].includes(layer.dataset.scene) && opacityOf(layer, cache) >= 1;
      const productRoots = covering ? [document.querySelector('#settings-screen')].filter(Boolean) : [document.body];
      const others = productRoots.flatMap((root) => [...textBoxes(root, cache, layer), ...fieldBoxes(root, cache, layer)]);
      const lights = lightBoxes(cache);
      const points = trailPoints(cache);
      const pairs = new Set();
      for (let i = 0; i < mine.length; i += 1) {
        for (const other of [...mine.slice(i + 1), ...others, ...lights]) {
          if (other.element === mine[i].element || !cross(mine[i].rect, other.rect)) continue;
          pairs.add(mine[i].name + ' × ' + other.name);
        }
        if (points.some((point) => near(mine[i].rect, point))) pairs.add(mine[i].name + ' × line path.journey-hall-trail-line');
        if (constellationUnder(mine[i].rect, cache)) pairs.add(mine[i].name + ' × line canvas#journey-constellation');
      }
      if (pairs.size > 0) watch.hits.push({ at, scene: layer.dataset.scene, pairs: [...pairs] });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return true;
})()`;

// 録った frame の列から [from, to] を切る。各 frame の ts は from からの ms で、先頭は from の時点で見えていた frame（from 以前の
// 最後の1枚）。
function cutClip(frames, from, to) {
  const shownAtStart = frames.filter((frame) => frame.at <= from).at(-1);
  const inside = frames.filter((frame) => frame.at > from && frame.at <= to);
  const head = shownAtStart ?? inside.shift();
  if (!head) throw new Error(`no screencast frame for the clip ${from}..${to}`);
  const picked = [{ file: head.file, ts: 0 }, ...inside.map((frame) => ({ file: frame.file, ts: frame.at - from }))];
  return { frames: picked, endMs: Math.max(to - from, picked.at(-1).ts + ANIM_MIN_FRAME_MS) };
}

// Pillow の WebPAnimEncoder へ1枚ずつ渡す（Image.save の save_all は全 frame を展開したまま持つので使わない）。書いた file を
// 読み戻して大きさ・frame 数・animated・長さを1行の JSON で返す。
const WEBP_ASSEMBLER = `
import json, os, sys
from PIL import Image, _webp
spec = json.load(sys.stdin)
for clip in spec["clips"]:
    first = Image.open(clip["frames"][0]["file"])
    size = first.size
    first.close()
    enc = _webp.WebPAnimEncoder(size, 0, 0, False, 3, 5, False, False)
    for frame in clip["frames"]:
        with Image.open(frame["file"]) as im:
            rgb = im.convert("RGB")
            if rgb.size != size:
                raise SystemExit("frame %s is %r, the clip is %r" % (frame["file"], rgb.size, size))
            enc.add(rgb.getim(), frame["ts"], False, spec["quality"], 100, 4)
    enc.add(None, clip["endMs"], False, spec["quality"], 100, 0)
    data = enc.assemble(b"", b"", b"")
    with open(clip["out"], "wb") as out:
        out.write(data)
    with Image.open(clip["out"]) as back:
        total = 0
        for index in range(back.n_frames):
            back.seek(index)
            back.load()
            total += back.info["duration"]
        print(json.dumps({"file": os.path.basename(clip["out"]), "format": back.format, "width": back.size[0], "height": back.size[1], "frames": back.n_frames, "animated": back.is_animated, "durationMs": total, "bytes": os.path.getsize(clip["out"])}), flush=True)
`;

function assembleWebp(clips) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', WEBP_ASSEMBLER], { env: isolatedEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        lines.push(JSON.parse(line));
        console.log(`anim ${line}`);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`python3 WebP assembler exited ${code ?? signal}: ${stderr}`));
      else resolve(lines);
    });
    child.stdin.end(JSON.stringify({ quality: ANIM_QUALITY, clips }));
  });
}

// 窓は about:blank（白）から開き、製品の page も最初の描画までは白いので、開いたときの場面は製品の page の
// firstContentfulPaint が届いた時刻（Date.now）から切る。
async function openedAt(page, open) {
  await page.send('Page.enable');
  await page.send('Page.setLifecycleEventsEnabled', { enabled: true });
  const cdp = page.win.webContents.debugger;
  let onMessage;
  const painted = new Promise((resolve) => {
    onMessage = (_event, method, params) => {
      if (method === 'Page.lifecycleEvent' && params.name === 'firstContentfulPaint') resolve(Date.now());
    };
    cdp.on('message', onMessage);
  });
  try {
    await open();
    const at = await Promise.race([painted, sleep(10000).then(() => null)]);
    if (at === null) throw new Error('no firstContentfulPaint lifecycle event within 10000 ms of opening the product');
    return at;
  } finally {
    cdp.off('message', onMessage);
  }
}

// 最初の描画の後に届いた最初の frame の時刻（その frame から切れば白い about:blank と描画前の白が入らない）。
function firstFrameAfter(frames, at) {
  const frame = frames.find((entry) => entry.at > at);
  if (!frame) throw new Error(`no screencast frame after ${at}`);
  return frame.at;
}

// 門 → 広間 → 足跡 → 星の道 → 露台 → 部屋（ゲームの中）→ 今日はここまで → 門 → 部屋（門から）→ 最初から始める → 星の道 → 露台、
// を通し、場面の区切りの時刻（Date.now）を marks に入れる。
async function walkJourney(page, base, reduced, marks) {
  const now = () => Date.now();
  const settle = reduced ? 700 : 3200;
  const waitScene = async (expression, label, timeoutMs) => {
    await page.waitFor(expression, { timeoutMs, label });
    return now();
  };
  marks.paintedAt = await openedAt(page, () => openAfter(page, base, 'three'));
  await page.js(SEAM_WATCH_SCRIPT);
  marks.watchFrom = Date.now();
  await sleep(settle);
  marks.openTo = now();

  marks.loadFrom = now();
  const newest = await enterHall(page, 'after');
  await sleep(reduced ? 700 : 1500);
  await page.hover(newest);
  await sleep(900);
  await page.click(newest);
  marks.roadFrom = await waitScene(`${JOURNEY_SCENE} === 'road'`, 'road after footprint', 5000);
  marks.loadTo = marks.roadFrom + 900;
  marks.arrivingAt = await waitScene(`${JOURNEY_SCENE} === 'arriving' || ${JOURNEY_SCENE} === 'play'`, 'arriving after load', 60000);
  await page.waitFor(`${HUB_OPERABLE} && ${JOURNEY_IN_PLAY}`, { timeoutMs: 60000, label: 'hub operable after load' });
  await sleep(1500);
  marks.arrivalTo = now();

  marks.roomInPlayFrom = now();
  await page.click('[data-journey-action="room-in-play"]');
  await page.waitFor(`document.body.classList.contains('journey-room-lit')`, { timeoutMs: 5000, label: 'room lit in play' });
  await sleep(reduced ? 900 : 2000);
  await page.click('#settings-screen .journey-room-way');
  await page.waitFor(`!document.body.classList.contains('journey-room-lit') && ${JOURNEY_IN_PLAY}`, { timeoutMs: 5000, label: 'room closed in play' });
  await sleep(1200);
  marks.roomInPlayTo = now();

  marks.endDayFrom = now();
  await page.click('#routing-hub-end');
  await page.waitFor(`document.querySelector('#title-screen')?.classList.contains('active') && ${JOURNEY_SCENE} === 'gate'`, { timeoutMs: 60000, label: 'gate after 今日はここまで' });
  await sleep(reduced ? 900 : 2500);
  marks.endDayTo = now();

  marks.roomFromGateFrom = now();
  await page.click('[data-journey-action="settings"]');
  await page.waitFor(`document.querySelector('#settings-screen')?.classList.contains('active')`, { timeoutMs: 5000, label: 'room from gate' });
  await sleep(reduced ? 900 : 2500);
  await page.click('#settings-screen .journey-room-way');
  await page.waitFor(`document.querySelector('#title-screen')?.classList.contains('active') && ${JOURNEY_SCENE} === 'gate'`, { timeoutMs: 5000, label: 'gate from room' });
  await sleep(reduced ? 900 : 2000);
  marks.roomFromGateTo = now();

  marks.newGameFrom = now();
  await page.click('[data-journey-action="new-game"]');
  await waitScene(`${JOURNEY_SCENE} === 'road'`, 'road after new game', 5000);
  await sleep(reduced ? 700 : 1500);
  marks.newGameTo = now();
  await page.waitFor(`${HUB_OPERABLE} && ${JOURNEY_IN_PLAY}`, { timeoutMs: 60000, label: 'hub operable after new game' });
  await sleep(1500);
  marks.journeyTo = now();
}

// 通しから切った場面ごとに、その範囲で見張った frame 数・字の重なった frame 数・重なった最初と最後の ms（場面の始まりから）・
// 重なった字の組ごとの frame 数を `seam {...}` の1行で出す。
function reportSeams(watch, ranges) {
  for (const [clip, [from, to]] of ranges) {
    const samples = watch.samples.filter((at) => at >= from && at <= to).length;
    if (samples === 0) throw new Error(`no seam-watch sample inside the clip ${clip} (${from}..${to})`);
    const hits = watch.hits.filter((hit) => hit.at >= from && hit.at <= to);
    const pairs = {};
    for (const hit of hits) for (const pair of hit.pairs) pairs[pair] = (pairs[pair] ?? 0) + 1;
    console.log(`seam ${JSON.stringify({
      clip,
      spanMs: to - from,
      samples,
      overlapFrames: hits.length,
      firstMs: hits.length > 0 ? hits[0].at - from : null,
      lastMs: hits.length > 0 ? hits.at(-1).at - from : null,
      scenes: [...new Set(hits.map((hit) => hit.scene))],
      pairs
    })}`);
  }
}

async function runAnim(options) {
  await assertEmptyOutDir(options.outDir);
  const frameRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-journey-anim-'));
  try {
    const clips = [];
    const out = (name) => path.join(options.outDir, `${name}.webp`);
    const marks = {};
    const launcher = await startLauncher({ repoRoot: options.repoRoot, saves: 'three', lmLatencyMs: options.lmLatencyMs });
    let frames;
    let watch;
    try {
      const page = await openWindow(options.viewport, options.reduced);
      await page.startRecording(await fs.mkdtemp(path.join(frameRoot, 'three-')));
      await walkJourney(page, launcher.base, options.reduced, marks);
      frames = await page.stopRecording();
      watch = await page.js(`(() => { window.__seamWatch.running = false; return window.__seamWatch; })()`);
      if (page.pageErrors.length > 0) throw new Error(`page errors: ${page.pageErrors.join(' | ')}`);
      await page.close();
    } finally {
      await launcher.stop();
    }
    const ranges = options.reduced
      ? new Map([[ANIM_REDUCED_CLIP, [firstFrameAfter(frames, marks.paintedAt), marks.journeyTo]]])
      : new Map(Object.entries({
        '01-open-star-title': [firstFrameAfter(frames, marks.paintedAt), marks.openTo],
        '02-new-game-gate-to-road': [marks.newGameFrom, marks.newGameTo],
        '03-load-hall-footprint-road': [marks.loadFrom, marks.loadTo],
        '04-road-crossing': [marks.roadFrom, marks.arrivingAt + 300],
        '05-terrace-arrival-hub': [marks.arrivingAt - 700, marks.arrivalTo],
        '06-end-day-back-to-gate': [marks.endDayFrom, marks.endDayTo],
        '07-room-from-gate': [marks.roomFromGateFrom, marks.roomFromGateTo],
        '08-room-in-play': [marks.roomInPlayFrom, marks.roomInPlayTo]
      }).filter(([name]) => options.clips.has(name)));
    for (const [name, [from, to]] of ranges) clips.push({ out: out(name), ...cutClip(frames, from, to) });
    // 見張りは門が出てから始まるので、開いたときの場面は見張りの始まりから数える。
    reportSeams(watch, [...ranges].map(([name, [from, to]]) => [name, [Math.max(from, marks.watchFrom), to]]));

    if (options.clips.has('09-first-no-saves')) {
      // セーブの無い初めての姿。
      const empty = await startLauncher({ repoRoot: options.repoRoot, saves: 'none', lmLatencyMs: options.lmLatencyMs });
      try {
        const page = await openWindow(options.viewport, false);
        await page.startRecording(await fs.mkdtemp(path.join(frameRoot, 'none-')));
        const paintedAt = await openedAt(page, () => openAfter(page, empty.base, 'none'));
        await sleep(3200);
        const to = Date.now();
        const noSaveFrames = await page.stopRecording();
        clips.push({ out: out('09-first-no-saves'), ...cutClip(noSaveFrames, firstFrameAfter(noSaveFrames, paintedAt), to) });
        await page.close();
      } finally {
        await empty.stop();
      }
    }
    const names = clips.map((clip) => path.basename(clip.out, '.webp'));
    const expected = (options.reduced ? [ANIM_REDUCED_CLIP] : ANIM_CLIPS).filter((name) => options.clips.has(name));
    if (names.join('\n') !== expected.join('\n')) throw new Error(`anim clips ${names.join(', ')} do not match --clips ${expected.join(', ')}`);
    const written = await assembleWebp(clips);
    const bad = written.filter((entry) => entry.format !== 'WEBP' || !entry.animated || entry.width !== options.viewport.width || entry.height !== options.viewport.height);
    if (bad.length > 0) throw new Error(`written WebP not animated at ${options.viewport.width}x${options.viewport.height}: ${JSON.stringify(bad)}`);
    console.log(`anim: ${written.length} animated WebP in ${options.outDir} (reduced ${options.reduced ? 'on' : 'off'}, lm-latency-ms ${options.lmLatencyMs})`);
  } finally {
    await fs.rm(frameRoot, { recursive: true, force: true });
  }
}

// ── timing ─────────────────────────────────────────────────────────────────────────────────────────────────
async function measureOnce(options, side) {
  const repoRoot = side === 'after' ? options.repoRoot : options.beforeRoot;
  const launcher = await startLauncher({ repoRoot, saves: 'three', lmLatencyMs: options.lmLatencyMs });
  try {
    const page = await openWindow(options.viewport, false);
    if (side === 'after') await openAfter(page, launcher.base, 'three');
    else await openBefore(page, launcher.base);
    await page.js(MEASURE_SCRIPT);
    const pressSelector = options.flow === 'new-game'
      ? (side === 'after' ? '[data-journey-action="new-game"]' : '#start-new-game')
      : await enterHall(page, side);
    const loadAverage = os.loadavg().map((value) => Number(value.toFixed(2)));
    await page.js(`window.__captureMeasure.armed = true; true`);
    await page.click(pressSelector);
    const settled = side === 'after' ? 'window.__captureMeasure.operable !== null && window.__captureMeasure.dissolveStart !== null' : 'window.__captureMeasure.operable !== null';
    await page.waitFor(settled, { timeoutMs: 60000, label: 'hub operable' });
    const measure = await page.js(`(() => { const m = window.__captureMeasure; return { press: m.press, operable: m.operable, hubOperable: m.hubOperable, arrived: m.arrived, dissolveStart: m.dissolveStart, requests: m.requests }; })()`);
    if (page.pageErrors.length > 0) throw new Error(`page errors: ${page.pageErrors.join(' | ')}`);
    await page.close();
    const sincePress = (at) => (at === null ? null : Math.round(at - measure.press));
    return {
      side,
      flow: options.flow,
      loadAverage,
      pressToOperableSeconds: Number(((measure.operable - measure.press) / 1000).toFixed(3)),
      pressToHubOperableSeconds: Number(((measure.hubOperable - measure.press) / 1000).toFixed(3)),
      arrivedMs: sincePress(measure.arrived),
      hubOperableMs: sincePress(measure.hubOperable),
      terraceGlimpseMs: measure.arrived === null ? null : Math.round(measure.dissolveStart - measure.arrived),
      requests: measure.requests
    };
  } finally {
    await launcher.stop();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(3));
}

async function runTiming(options) {
  await assertTreeSide(options.beforeRoot, 'before');
  await assertTreeSide(options.repoRoot, 'after');
  const results = [];
  for (let pair = 1; pair <= options.runs; pair += 1) {
    const order = pair % 2 === 1 ? ['before', 'after'] : ['after', 'before'];
    for (const side of order) {
      const result = { pair, ...(await measureOnce(options, side)) };
      results.push(result);
      console.log(`run ${JSON.stringify(result)}`);
    }
  }
  for (const side of ['before', 'after']) {
    const mine = results.filter((result) => result.side === side);
    console.log(`median ${JSON.stringify({
      side,
      commit: await commitOf(side === 'after' ? options.repoRoot : options.beforeRoot),
      flow: options.flow,
      runs: mine.length,
      viewport: options.viewport,
      lmLatencyMs: options.lmLatencyMs,
      pressToOperableSeconds: median(mine.map((result) => result.pressToOperableSeconds)),
      pressToHubOperableSeconds: median(mine.map((result) => result.pressToHubOperableSeconds))
    })}`);
  }
}

// ── manifest ───────────────────────────────────────────────────────────────────────────────────────────────
async function listRegularFiles(root, relative = '') {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`${path.join(root, child)} is neither a regular file nor a directory`);
  }
  return files;
}

async function runManifest(options) {
  const target = path.join(options.outDir, 'manifest.json');
  const files = (await listRegularFiles(options.outDir)).filter((file) => file !== 'manifest.json');
  if (files.length === 0) throw new Error(`${options.outDir} holds no files to list`);
  const listed = [];
  for (const file of files) {
    const bytes = await fs.readFile(path.join(options.outDir, file));
    listed.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await fs.writeFile(target, `${JSON.stringify({ head: await commitOf(options.repoRoot), files: listed }, null, 2)}\n`);
  console.log(`manifest: ${listed.length} files + manifest.json in ${options.outDir}`);
}

let electron = null;
const tokens = (() => {
  try {
    return { parsed: parseTokens(process.argv.slice(2)) };
  } catch (error) {
    return { error };
  }
})();

if (tokens.parsed?.['--serve']) {
  serve(parseServeArgs(tokens.parsed)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  // Electron の API は Electron の main process でだけ読む（--serve は素の node で走る）。ready より前に下の設定を済ませるため同期で読む。
  electron = createRequire(import.meta.url)('electron');
  const { app } = electron;
  const parsed = (() => {
    try {
      if (tokens.error) throw tokens.error;
      return { options: parseArgs(tokens.parsed) };
    } catch (error) {
      return { error };
    }
  })();
  // 録画（anim）だけ GPU で合成する。software の合成では screencast が 12 fps 前後しか届かない。
  if (parsed.options?.plan !== 'anim') app.disableHardwareAcceleration();
  // 窓を閉じても app を終わらせない（場面ごとに窓を開け直すため）。終わりは下の app.exit だけ。
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    let code = 0;
    try {
      if (parsed.error) throw parsed.error;
      const plans = { stills: runStills, anim: runAnim, timing: runTiming, manifest: runManifest };
      await plans[parsed.options.plan](parsed.options);
    } catch (error) {
      console.error(error);
      code = 1;
    }
    app.exit(code);
  });
}
