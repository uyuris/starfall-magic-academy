// The 大書庫's book opened while the brush is writing, timed from the moment the 本文 reaches the page until the text is
// shown, through each stage of the flow that ends the writing: when the answer arrived, the first frame after it, the
// brush's first frame of its wind-up (data-writing lifting), the sweep's start (data-writing sweeping, data-ink
// translating), the first not-yet-written line rising, the first glow, the brush gone, the page filled with letters, the
// text shown (data-ink ready), every frame the page drew in between and the longest interval between two of them, the
// long animation frames (with the scripts that ran in them); in one more open under the CPU profiler, which functions
// the arrival work spent its time in (the work is cut into steps run inside the wind-up's frames); and in one more under
// the tracer, the longest main-thread task and every layout / style recalculation in it by who forced it.
//
// Run by hand (not *.test.mjs, so `npm test` skips it; it takes a few minutes):
//
//   <electron> app/tests/manual/libraryWritingStallTimes.mjs \
//     --repo-root <absolute repo root> --out-dir <absolute, empty or absent directory> --runs <books to time>
//
// Every argument is required (absolute paths, a positive integer); none has a default. The repo must be clean (the
// figures record the commit they were taken from). The renderer's userData lives in the out dir and is removed after the
// run; the timings are printed (STALLRUN / STALLPROFILE / STALLTRACE / STALL-TABLE lines) and written to <out-dir>/runs.json.
//
// WHAT IS REAL AND WHAT IS A FIXTURE
// - Entry: the ordinary play entry — the title screen, 新しいプレイ, the routing hub's welcome talk, one typed line asking
//   for the 大書庫, the hub's send-off into the library; then one theme handed over and the shelf.
// - Server: the product createServer in this process over an OS-temp root (definitions and seeds copied there; the repo's
//   data/ and app/config are never opened for writing).
// - LM: a fixed-answer server speaking the LM Studio wire protocol. It holds the 本文 (fragment) answer FRAGMENT_HOLD_MS so
//   that the brush is writing when it arrives, and the footnotes answer FOOTNOTES_HOLD_MS so that the footnotes land after
//   the text is shown (a real LM's footnotes come seconds after the 本文). The 本文 is 8 paragraphs, ~700 letters (the
//   product asks the LM for 500〜800).
// - Front: a relay in front of the server records when each /api/library/read went in and when its answer went out.
// - Books: the shelf's 生成 books (each one a new 本文 from the LM), opened one after another in the same visit, closed
//   between: `--runs` timed opens, then one more open under the CPU profiler and one more under the tracer (their times
//   are not in the table: sampling and tracing slow the page).
// - Page clock: every page time is performance.now() of the renderer; node-side times (LM, relay) are epoch ms, put on the
//   page clock with performance.timeOrigin. Probes only record: a rAF ticker, MutationObservers, a wrapper around
//   Response.text/json, a long-animation-frame observer, and getAnimations() read when the page starts to translate.
// - Rendering: a hidden Electron window, 1440×900 at DPR 1, driven over CDP Input events.
//
// The harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, mkdirSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ARGS = { paths: ['--repo-root', '--out-dir'], counts: ['--runs'] };

function parseArgs(argv) {
  const known = [...ARGS.paths, ...ARGS.counts];
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!known.includes(token)) throw new Error(`unexpected argument: ${token} (expected ${known.join(', ')} only)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of known) {
    const value = parsed[token];
    if (value === undefined) throw new Error(`${token} is required (no default, no fallback)`);
    if (ARGS.paths.includes(token) && !path.isAbsolute(value)) throw new Error(`${token} must be an absolute path: ${value}`);
    if (ARGS.counts.includes(token) && !/^[1-9]\d*$/.test(value)) throw new Error(`${token} must be a positive integer: ${value}`);
  }
  return { repoRoot: parsed['--repo-root'], outDir: parsed['--out-dir'], runs: Number(parsed['--runs']) };
}

const FRAGMENT_HOLD_MS = 6000;
const FOOTNOTES_HOLD_MS = 5000;
const VIEWPORT = { width: 1440, height: 900 };
const HUB_INPUT = '大書庫で本を探したい';
const THEME = '夜の星と古い記録';
// A frame interval longer than this is a frame the page did not draw on time (two 60 Hz frames and a little).
const STALL_FRAME_MS = 34;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(name, pass, detail = {}) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!pass) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}

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

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ── The fixed-answer LM ─────────────────────────────────────────────────────────────────────────────────────
const FILL_TITLES = ['観測者の夜録', '灯り番の手控え', '夜更けの暦', '塔の影の測り方', '鐘楼守りの記録', '霧の朝の星図'];
const FREE_TITLES = ['題の無い写本', '砂時計職人の弟子', '星の余白', '三つの月の旅日記', '羊皮紙の匂い', '銀の栞の行方'];
const FOOTNOTE_TITLE = '星明かりの下で綴られた往復書簡';
const SKELETON = '夜の観測と古い記録のあいだを行き来する、静かな覚え書き。読む者を急がせない。';
const STYLE_ID = 'dry';
const FRAGMENT = [
  '書架の最上段にあったその束は、表紙に何の題も記されていなかった。紐をほどくと、紙は思いのほか柔らかく、夜ごとに少しずつ書き足された跡が残っていた。',
  '最初の頁には、星の位置が小さな点で記されている。点の横には時刻と、その晩の風の向きが添えられ、ところどころに「雲」「霧」とだけ書かれた日もある。書き手は、見えなかった夜も同じように一行を残していた。',
  '十日を過ぎたあたりから、記録は星の位置だけではなくなる。書庫の灯りが消える刻限、階段の軋む音、窓の外を渡っていった鳥の数。書き手は、星を見ているあいだに耳へ届いたものを、何ひとつ取りこぼすまいとしていたように見える。',
  '二十夜目には、はじめて人の名が現れる。「今夜は灯り番が早く来た」とだけあって、その名は墨でていねいに塗り消されている。消された名の上に、書き手はもう一度、同じ星の点を打っていた。',
  '三十夜を越えると、字は次第に小さくなり、余白が増えていく。書くべきことが減ったのではなく、書かずにおくことを覚えたのだろう。空白の多い頁ほど、紙は何度も指でなぞられて薄くなっていた。',
  '四十夜目の頁には、一行だけが記されている。「今夜の星は、昨夜と同じ場所にあった」。その下に、日付の無い押し跡がひとつ残っている。',
  '最後の頁は、四十九夜目である。星の点は打たれていない。代わりに、書庫の奥の通路の見取り図が、細い線で描かれていた。通路の突き当たりには小さな印があり、その横に「ここで灯りが消える」とだけ書かれている。',
  '束を閉じると、紐の結び目がほどけかけていた。結び直そうとして、紐の端に小さな結び目がもうひとつあるのに気づく。数えると四十九あった。'
].join('\n\n');

function startFixtureLm({ gatedIds }) {
  const calls = [];
  let titleCall = 0;
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages.map((message) => message.content).join('\n');
    const schema = body.response_format?.json_schema?.name ?? '';
    const call = { kind: null, startedAt: Date.now() };
    calls.push(call);
    let content;
    try {
      if (prompt.includes('テーマに合う本を選ぶ司書')) {
        call.kind = 'selection';
        titleCall = 0;
        const rowTitles = new Set([...FILL_TITLES, ...FREE_TITLES]);
        const candidates = [...prompt.matchAll(/^- (\S+) ／ (.+?) ／/gm)].filter((match) => !rowTitles.has(match[2])).map((match) => match[1]);
        const pick = (prefix, count) => candidates.filter((id) => id.startsWith(prefix)).slice(0, count);
        content = JSON.stringify({ book_ids: [...pick('core_', 1), ...pick('periphery_', 2)] });
      } else if (prompt.includes('蔵書目録を作っている')) {
        call.kind = 'titles';
        const match = /タイトルを(\d+)つ/.exec(prompt);
        if (!match) throw new Error('fixture lm: title prompt without a count');
        titleCall += 1;
        const pool = titleCall === 1 ? FILL_TITLES : FREE_TITLES;
        if (Number(match[1]) > pool.length) throw new Error(`fixture lm: asked for ${match[1]} titles, the pool has ${pool.length}`);
        content = pool.slice(0, Number(match[1])).join('\n');
      } else if (prompt.includes('書誌カタログを整えている')) {
        call.kind = 'skeleton';
        content = SKELETON;
      } else if (prompt.includes('これから本文を書き起こす一冊について')) {
        call.kind = 'style';
        content = JSON.stringify({ style_id: STYLE_ID });
      } else if (prompt.includes('巻末に添える「関連する本」')) {
        call.kind = 'footnotes';
        await sleep(FOOTNOTES_HOLD_MS);
        const selfTitle = /書名『(.+?)』/.exec(prompt)?.[1];
        if (!selfTitle) throw new Error('fixture lm: footnote prompt without a subject title');
        const candidates = [...prompt.matchAll(/^- (\S+) ／ (.+?) ／ (.+?) ／ (\S+)$/gm)].map((match) => ({ id: match[1], title: match[2] }));
        const usable = candidates.filter((candidate) => candidate.title !== selfTitle && candidate.title !== FOOTNOTE_TITLE);
        const readableRef = usable.find((candidate) => !gatedIds.has(candidate.id));
        const gatedRef = usable.find((candidate) => gatedIds.has(candidate.id));
        if (!readableRef || !gatedRef) throw new Error('fixture lm: the footnote candidates lack a readable or a gated catalog book');
        content = JSON.stringify({ references: [{ generated_title: FOOTNOTE_TITLE }, { book_id: readableRef.id }, { book_id: gatedRef.id }] });
      } else if (prompt.includes('大書庫に収められた一冊の本の書き手')) {
        call.kind = 'fragment';
        await sleep(FRAGMENT_HOLD_MS);
        content = FRAGMENT;
      } else if (schema === 'character_emotion_choice') {
        call.kind = 'hub:emotion';
        content = JSON.stringify({ expression: 'joy' });
      } else if (schema === 'work_record_recall_choice') {
        call.kind = 'hub:recall';
        content = JSON.stringify({ work_record_ids: [] });
      } else if (prompt.includes('好感度の変化量を判定する')) {
        call.kind = 'hub:affinity';
        content = '0';
      } else if (prompt.includes('MP温存ライン')) {
        call.kind = 'hub:mp';
        content = '30';
      } else if (prompt.includes('所持金判定')) {
        call.kind = 'hub:money';
        content = '0';
      } else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) {
        call.kind = 'hub:continue';
        content = 'true';
      } else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
        call.kind = 'hub:destination';
        content = 'library';
      } else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) {
        call.kind = 'hub:sendoff';
        content = 'では、大書庫へ。灯りの落ちた通路の奥まで、ゆっくり見ていらっしゃい。';
      } else if (prompt.includes('次の会話セッションだけを根拠に')) {
        call.kind = 'hub:record';
        content = '大書庫へ本を探しに行った。';
      } else if (prompt.includes('ルーティングハブに所属する')) {
        call.kind = 'hub:utterance';
        content = '新しい週をここから始めましょう。';
      } else {
        throw new Error(`fixture lm: unknown prompt kind: ${prompt.slice(0, 80)}`);
      }
    } catch (error) {
      call.error = String(error.message);
      call.endedAt = Date.now();
      console.error(`fixture lm: ${error.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
      return;
    }
    call.endedAt = Date.now();
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      calls,
      stop: () => new Promise((done) => { server.close(done); server.closeAllConnections(); })
    }));
  });
}

// ── The front relay: when each request went in and when its answer went out ─────────────────────────────────
function startFront(productBase) {
  const seen = [];
  const server = createHttpServer(async (req, res) => {
    const entry = { method: req.method, pathname: new URL(req.url, 'http://127.0.0.1').pathname, startedAt: Date.now() };
    seen.push(entry);
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      const upstream = await fetch(`${productBase}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
      });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = {};
      for (const [key, value] of upstream.headers) {
        if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') continue;
        outHeaders[key] = value;
      }
      entry.status = upstream.status;
      if (upstream.status === 200 && entry.pathname === '/api/library/search') entry.json = JSON.parse(buffer.toString('utf8'));
      entry.endedAt = Date.now();
      res.writeHead(upstream.status, outHeaders);
      res.end(buffer);
    } catch (error) {
      console.error(error);
      entry.status = 502;
      entry.endedAt = Date.now();
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      last: (method, pathname) => [...seen].reverse().find((entry) => entry.method === method && entry.pathname === pathname) ?? null
    }));
  });
}

async function startStage(repoRoot, { createServer, runtimePathsManifestFilename, gatedIds }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-writing-stall-'));
  const definitionsRoot = path.join(root, 'data/definitions/game_data');
  const seedsRoot = path.join(root, 'data/seeds/game_data');
  const configRoot = path.join(root, 'config');
  await fs.cp(path.join(repoRoot, 'data/definitions/game_data'), definitionsRoot, { recursive: true });
  await fs.cp(path.join(repoRoot, 'data/seeds/game_data'), seedsRoot, { recursive: true });
  await writeJson(path.join(root, runtimePathsManifestFilename), {
    configRoot,
    definitionsRoot,
    seedsRoot,
    mutableRoot: path.join(root, 'data/mutable/game_data'),
    characterContentRoot: path.join(repoRoot, 'content/characters'),
    creatureContentRoot: path.join(repoRoot, 'content/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  });
  const lm = await startFixtureLm({ gatedIds });
  const lmConfigPath = path.join(configRoot, 'lmstudio.json');
  await writeJson(lmConfigPath, {
    provider: 'lmstudio',
    base_url: lm.baseUrl,
    chat_model: 'stall-fixture',
    reflection_model: 'stall-fixture',
    timeout_ms: 120000,
    stream: false,
    thinking_effort: null,
    mock_provider_enabled: false
  });
  const playModeSettingsPath = path.join(configRoot, 'play-mode.json');
  await writeJson(playModeSettingsPath, { mode: 'routing', routing_persona_variant: 'fallen_star' });
  const product = createServer({
    root,
    publicRoot: path.join(repoRoot, 'app/public'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    playModeSettingsPath,
    conversationPopupSettingsPath: path.join(configRoot, 'conversation-popup.json'),
    audioSettingsPath: path.join(configRoot, 'audio.json'),
    lmStudioConfigPath: lmConfigPath
  });
  await new Promise((resolve) => product.listen(0, '127.0.0.1', resolve));
  const front = await startFront(`http://127.0.0.1:${product.address().port}`);
  return {
    base: front.base,
    front,
    lm,
    async stop() {
      await new Promise((resolve) => front.server.close(resolve));
      await new Promise((resolve) => product.close(resolve));
      await lm.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

// ── The page under CDP ────────────────────────────────────────────────────────────────────────────────────────
async function openPage() {
  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false, partition: 'library-writing-stall' }
  });
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) rendererErrors.push({ message: message.slice(0, 200), source: `${sourceId}:${line}`, at: Date.now() });
  });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    send,
    js,
    rendererErrors,
    async waitFor(predicate, label, { timeoutMs = 30000, intervalMs = 50 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`)) return;
        await sleep(intervalMs);
      }
      throw new Error(`timed out waiting for ${label} (renderer errors: ${JSON.stringify(rendererErrors.slice(-3))})`);
    },
    async pointOf(selector, { text = null } = {}) {
      return js(`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const node = ${text === null ? 'nodes[0]' : `nodes.find((n) => (n.getAttribute('aria-label') ?? n.textContent).trim() === ${JSON.stringify(text)})`};
        if (!node) throw new Error('no node: ' + ${JSON.stringify(`${selector} ${text ?? ''}`)});
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) throw new Error('node has no box: ' + ${JSON.stringify(selector)});
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(box.y + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === node || node.contains(hit) || hit.contains(node))) throw new Error('point is covered at ' + ${JSON.stringify(selector)} + ': ' + (hit ? hit.className : 'nothing'));
        return { x, y };
      })()`);
    },
    mouse: { x: 4, y: 4 },
    async moveTo(target, { steps = 1, stepMs = 0 } = {}) {
      const from = { ...page.mouse };
      for (let i = 1; i <= steps; i += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x + ((target.x - from.x) * i) / steps), y: Math.round(from.y + ((target.y - from.y) * i) / steps) });
        if (stepMs) await sleep(stepMs);
      }
      page.mouse = { ...target };
    },
    async click(selector, options = {}, motion = {}) {
      const point = await page.pointOf(selector, options);
      await page.moveTo(point, motion);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    async type(text, charMs) {
      for (const character of [...text]) {
        await send('Input.insertText', { text: character });
        if (charMs) await sleep(charMs);
      }
    },
    async close() {
      if (cdp.isAttached()) cdp.detach();
      if (!win.isDestroyed()) win.destroy();
    },
    win
  };
  return page;
}

const ROOT = `document.querySelector('#academy-library-screen')`;
const SCENE = `${ROOT}.dataset.scene`;
const BOOK = `${ROOT}.querySelector('.academy-library-book')`;
const SHELF_BOOK = '.academy-library-shelf > button.academy-library-book-item';

async function enterLibrary(page, stage) {
  await page.win.loadURL(`${stage.base}/`);
  const measured = await page.js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches })');
  check('viewport 1440x900 dpr1 full motion', measured.w === VIEWPORT.width && measured.h === VIEWPORT.height && measured.dpr === 1 && measured.reduced === false, measured);
  await page.waitFor(`document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'`, 'title gate');
  await page.click('[data-journey-action="new-game"]');
  await page.waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send').disabled && document.querySelector('#routing-hub-message-stream').textContent.trim().length > 0`, 'routing hub welcome', { timeoutMs: 60000 });
  await page.click('#routing-hub-input');
  await page.type(HUB_INPUT, 0);
  let sent = false;
  for (let attempt = 0; attempt < 60 && !sent; attempt += 1) {
    await page.click('#routing-hub-send');
    await sleep(250);
    sent = await page.js(`document.querySelector('#routing-hub-input').value === ''`);
    if (!sent) await sleep(500);
  }
  if (!sent) throw new Error('the hub never took the typed line');
  await page.waitFor(`[...document.querySelectorAll('.screen.active')].map((s) => s.id).join() === 'academy-library-screen' && ${ROOT}.dataset.arrived === 'true'`, 'library arrival', { timeoutMs: 60000, intervalMs: 20 });
  check('entered through play (play-mode, no ?initialScreen)', await page.js(`document.body.classList.contains('play-mode') && location.pathname + location.search === '/'`));
}

// ── The probe: records only ─────────────────────────────────────────────────────────────────────────────────
// Installed once per open, before the press. Everything is on performance.now().
const PROBE_INSTALL = `(() => {
  const root = document.querySelector('#academy-library-screen');
  const book = root.querySelector('.academy-library-book');
  const brush = root.querySelector('.academy-library-brush');
  if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) throw new Error('this renderer has no long-animation-frame entries');
  window.__stallProbe?.stop();
  performance.setResourceTimingBufferSize(100000);
  performance.clearResourceTimings();
  const p = { timeOrigin: performance.timeOrigin, frames: [], marks: [], brush: [], loaf: [], anims: [], armed: true };
  const now = () => performance.now();
  const mark = (kind, value = null) => p.marks.push({ t: now(), kind, value });
  const onDown = (event) => {
    const pressed = event.target.closest('button.academy-library-book-item');
    if (pressed) mark('press', pressed.getAttribute('aria-label'));
  };
  document.addEventListener('pointerdown', onDown, true);
  const tick = (t) => { if (!p.armed) return; p.frames.push({ t, ran: now() }); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const watchBodies = (name) => {
    const original = Response.prototype[name];
    Response.prototype[name] = function () {
      const url = this.url;
      const result = original.call(this);
      if (url.includes('/api/library/read')) result.then(() => mark('read-body-' + name), () => mark('read-body-failed'));
      return result;
    };
    return () => { Response.prototype[name] = original; };
  };
  const restores = [watchBodies('text'), watchBodies('json')];
  const classify = (animation) => {
    const target = animation.effect.target;
    const frames = animation.effect.getKeyframes();
    if (target.classList.contains('academy-library-page-line')) return 'line-ink';
    if (frames.length === 5) return 'glow';
    if (+frames[0].opacity === 0 && +frames.at(-1).opacity === 1) return 'bloom';
    if (+frames[0].opacity === 1 && +frames.at(-1).opacity === 0) return 'row-out';
    return 'other:' + target.className;
  };
  const readAnimations = () => {
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
      if (!book.contains(animation.effect.target)) continue;
      const timing = animation.effect.getTiming();
      const record = { kind: classify(animation), delay: timing.delay, duration: timing.duration, startTime: null, readyAt: null, finishedAt: null };
      p.anims.push(record);
      animation.ready.then(() => { record.startTime = animation.startTime; record.readyAt = now(); });
      animation.finished.then(() => { record.finishedAt = now(); }, () => { record.finishedAt = 'cancelled'; });
    }
  };
  const bookObserver = new MutationObserver((records) => {
    for (const r of records) {
      const value = r.target.getAttribute(r.attributeName);
      mark(r.attributeName, value);
      if (r.attributeName === 'data-ink' && value === 'translating') readAnimations();
    }
  });
  bookObserver.observe(book, { attributes: true, attributeFilter: ['data-ink', 'data-writing', 'data-open', 'data-footnotes'] });
  const sceneObserver = new MutationObserver(() => mark('data-scene', root.dataset.scene));
  sceneObserver.observe(root, { attributes: true, attributeFilter: ['data-scene'] });
  const brushObserver = new MutationObserver(() => p.brush.push({ t: now(), transform: brush.style.transform }));
  brushObserver.observe(brush, { attributes: true, attributeFilter: ['style'] });
  const loafObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      p.loaf.push({
        start: e.startTime, duration: e.duration, blocking: e.blockingDuration, renderStart: e.renderStart, styleAndLayoutStart: e.styleAndLayoutStart,
        scripts: e.scripts.map((s) => ({ start: s.startTime, duration: s.duration, invoker: s.invoker, invokerType: s.invokerType, fn: s.sourceFunctionName, src: (s.sourceURL.split('/').pop() || '') + ':' + s.sourceCharPosition, forcedLayout: s.forcedStyleAndLayoutDuration }))
      });
    }
  });
  loafObserver.observe({ type: 'long-animation-frame', buffered: false });
  p.stop = () => {
    p.armed = false;
    document.removeEventListener('pointerdown', onDown, true);
    for (const restore of restores) restore();
    bookObserver.disconnect();
    sceneObserver.disconnect();
    brushObserver.disconnect();
    loafObserver.disconnect();
  };
  window.__stallProbe = p;
  return true;
})()`;
const PROBE_READ = `(() => {
  const p = window.__stallProbe;
  p.stop();
  const reads = performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/library/read'));
  return { ...p, stop: undefined, reads: reads.map((e) => ({ startTime: e.startTime, requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd })) };
})()`;

// ── One open, timed ───────────────────────────────────────────────────────────────────────────────────────────
async function openBook(page, title, { profile }) {
  await page.js(PROBE_INSTALL);
  if (profile) {
    await page.send('Profiler.enable');
    await page.send('Profiler.setSamplingInterval', { interval: 100 });
    await page.send('Profiler.start');
  }
  await page.click(SHELF_BOOK, { text: title }, { steps: 8, stepMs: 20 });
  await page.waitFor(`${SCENE} === 'reading' && ${BOOK}.dataset.ink === 'ready' && ${ROOT}.querySelector('.academy-library-page-title')?.textContent === ${JSON.stringify(title)}`, `「${title}」 shown`, { timeoutMs: 60000, intervalMs: 20 });
  // Let every animation of the arrival settle before the probe is read.
  await sleep(600);
  const cpu = profile ? (await page.send('Profiler.stop')).profile : null;
  if (profile) await page.send('Profiler.disable');
  const probe = await page.js(PROBE_READ);
  return { probe, cpu };
}

async function closeBook(page) {
  await page.waitFor(`${BOOK}.dataset.footnotes === 'ready' || ${BOOK}.dataset.footnotes === 'failed'`, 'footnotes settled', { timeoutMs: 30000 });
  await page.click('.academy-library-close', {}, { steps: 8, stepMs: 20 });
  await page.waitFor(`${SCENE} === 'shelf' && ${ROOT}.querySelector('.academy-library-reading').hidden`, 'book closed', { timeoutMs: 15000 });
  await sleep(600);
}

// ── Reading one open's record ─────────────────────────────────────────────────────────────────────────────────
const round = (value) => (typeof value === 'number' ? Math.round(value * 10) / 10 : value);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function analyse(probe, { stage, title }) {
  const at = (kind, value = undefined, from = -Infinity) => probe.marks.find((m) => m.kind === kind && (value === undefined || m.value === value) && m.t >= from) ?? null;
  const press = at('press', title);
  if (!press) throw new Error(`no press on 「${title}」 was recorded`);
  const moving = at('data-writing', 'moving', press.t);
  if (!moving) throw new Error(`the brush never wrote for 「${title}」 (the 本文 arrived before the book was open)`);
  const lifting = at('data-writing', 'lifting', moving.t);
  const sweeping = lifting ? at('data-writing', 'sweeping', lifting.t) : null;
  const translating = at('data-ink', 'translating', press.t);
  const ready = at('data-ink', 'ready', translating ? translating.t : press.t);
  const body = probe.marks.find((m) => m.kind.startsWith('read-body-') && m.t >= press.t);
  const read = probe.reads.at(-1);
  if (!lifting || !sweeping || !translating || !ready || !body || !read) throw new Error(`the arrival of 「${title}」 left no full trace: ${JSON.stringify({ lifting, sweeping, translating, ready, body, read })}`);
  // The brush: the last frame it was drawn writing, the first frame it was drawn winding up, and the frame it was hidden
  // (its transform cleared) after the sweep.
  const lastWrite = [...probe.brush].reverse().find((b) => b.t < lifting.t && b.t > moving.t);
  const firstLift = probe.brush.find((b) => b.t > lifting.t);
  const gone = probe.brush.find((b) => b.t > sweeping.t && b.transform === '');
  // The page was filled: every 染み出し (bloom) of the not-yet-written rows has finished.
  const kinds = {};
  for (const anim of probe.anims) {
    const k = (kinds[anim.kind] ??= { count: 0, firstVisible: Infinity, lastFinished: -Infinity, durations: new Set(), cancelled: 0 });
    k.count += 1;
    k.durations.add(anim.duration);
    if (anim.startTime !== null) k.firstVisible = Math.min(k.firstVisible, anim.startTime + anim.delay);
    if (anim.finishedAt === 'cancelled') k.cancelled += 1;
    else if (anim.finishedAt !== null) k.lastFinished = Math.max(k.lastFinished, anim.finishedAt);
  }
  const bloom = kinds.bloom;
  if (!bloom) throw new Error(`no bloom animation was found for 「${title}」`);
  // The frames around the arrival (by when each frame's callbacks ran): the last frame run before the body was read, and
  // the first one run after it.
  const frameBefore = [...probe.frames].reverse().find((f) => f.ran <= body.t);
  const frameAfter = probe.frames.find((f) => f.ran > body.t);
  const intervals = [];
  for (let i = 1; i < probe.frames.length; i += 1) intervals.push({ from: probe.frames[i - 1].ran, to: probe.frames[i].ran, ms: probe.frames[i].ran - probe.frames[i - 1].ran });
  const writing = intervals.filter((f) => f.from >= moving.t && f.to <= body.t).map((f) => f.ms);
  const arrivalToShown = intervals.filter((f) => f.to > read.responseEnd && f.from < ready.t);
  const stalls = intervals.filter((f) => f.to > read.responseEnd - 100 && f.from < ready.t && f.ms > STALL_FRAME_MS);
  const loafs = probe.loaf.filter((l) => l.start + l.duration > read.responseEnd - 100 && l.start < ready.t);
  // Node-side times (epoch) on the page clock.
  const toPage = (epoch) => epoch - probe.timeOrigin;
  const relay = stage.front.last('POST', '/api/library/read');
  const pressEpoch = press.t + probe.timeOrigin;
  const lmCalls = stage.lm.calls.filter((c) => c.startedAt >= pressEpoch - 50 && c.startedAt <= ready.t + probe.timeOrigin);
  const fragment = lmCalls.find((c) => c.kind === 'fragment');
  const rel = (t) => (t === null || t === undefined ? null : round(t - press.t));
  return {
    title,
    // ms from the press, on the page clock
    times: {
      readAsked: rel(read.startTime),
      brushStarted: rel(moving.t),
      lmFragmentAnswered: fragment ? rel(toPage(fragment.endedAt)) : null,
      serverAnswered: rel(toPage(relay.endedAt)),
      bodyArrived_responseEnd: rel(read.responseEnd),
      bodyRead_byPage: rel(body.t),
      brushLastWritingFrame: rel(lastWrite?.t),
      brushStopped_frameBeforeArrival: rel(frameBefore?.ran),
      liftingObserved: rel(lifting.t),
      translatingObserved: rel(translating.t),
      firstFrameAfterArrival: rel(frameAfter?.ran),
      brushFirstLiftingFrame: rel(firstLift?.t),
      sweepingObserved: rel(sweeping.t),
      bloomFirstVisible: rel(bloom.firstVisible),
      pageFilled_bloomDone: rel(bloom.lastFinished),
      glowFirstVisible: rel(kinds.glow?.firstVisible),
      lineInkLastDone: rel(kinds['line-ink']?.lastFinished),
      brushGone: rel(gone?.t),
      textShown_inkReady: rel(ready.t),
      footnotesSettled: rel(probe.marks.find((m) => m.kind === 'data-footnotes' && (m.value === 'ready' || m.value === 'failed') && m.t >= press.t)?.t)
    },
    serverSide: {
      readInRelayMs: relay.endedAt - relay.startedAt,
      lmCalls: lmCalls.map((c) => ({ kind: c.kind, ms: c.endedAt - c.startedAt, from: rel(toPage(c.startedAt)), to: rel(toPage(c.endedAt)) })),
      fragmentAnswerToRelayOutMs: fragment ? relay.endedAt - fragment.endedAt : null
    },
    animations: Object.fromEntries(Object.entries(kinds).map(([kind, k]) => [kind, { count: k.count, durations: [...k.durations], cancelled: k.cancelled, firstVisible: rel(k.firstVisible === Infinity ? null : k.firstVisible), lastFinished: rel(k.lastFinished === -Infinity ? null : k.lastFinished) }])),
    frames: {
      whileWritingMedianMs: writing.length ? round(median(writing)) : null,
      whileWritingMaxMs: writing.length ? round(Math.max(...writing)) : null,
      whileWritingCount: writing.length,
      stallsFromArrivalToShown: stalls.map((f) => ({ from: rel(f.from), to: rel(f.to), ms: round(f.ms) })),
      fromArrivalToShownCount: arrivalToShown.length,
      fromArrivalToShownLongestMs: arrivalToShown.length ? round(Math.max(...arrivalToShown.map((f) => f.ms))) : null
    },
    longAnimationFrames: loafs.map((l) => ({
      start: rel(l.start), duration: round(l.duration), blocking: round(l.blocking), renderStart: rel(l.renderStart), styleAndLayoutStart: rel(l.styleAndLayoutStart),
      scripts: l.scripts.filter((s) => s.duration >= 1).map((s) => ({ start: rel(s.start), duration: round(s.duration), forcedLayout: round(s.forcedLayout), invoker: s.invoker, fn: s.fn, src: s.src }))
    }))
  };
}

// The arrival work under the profiler: the samples whose stack holds showBook or preparing (the steps run in the wind-up's
// frames: paginate → the spread on the paper → the translation set up), as inclusive ms per function of the library
// screen, and the heaviest self times.
const PROFILED_FUNCTIONS = ['showBook', 'preparing', 'paginate', 'largestFit', 'placeTail', 'renderingSpread', 'renderPageInto', 'layPageOnPaper', 'paintSheet', 'drawSheet',
  'pageLines', 'relay', 'makeRow', 'layLine', 'rowCanvas', 'inkStroke', 'paintPageLine', 'requestFootnotes', 'validateRead'];
function analyseProfile(cpu) {
  const byId = new Map(cpu.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of cpu.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const stackOf = (id) => {
    const names = [];
    for (let at = id; at !== undefined; at = parent.get(at)) names.push(byId.get(at).callFrame.functionName || byId.get(at).callFrame.url.split('/').pop() || '(anonymous)');
    return names;
  };
  const inclusive = Object.fromEntries(PROFILED_FUNCTIONS.map((name) => [name, 0]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < cpu.samples.length; i += 1) {
    const dt = (cpu.timeDeltas[i + 1] ?? 0) / 1000;
    const stack = stackOf(cpu.samples[i]);
    if (!stack.includes('showBook') && !stack.includes('preparing')) continue;
    total += dt;
    for (const name of new Set(stack)) if (name in inclusive) inclusive[name] += dt;
    const leaf = byId.get(cpu.samples[i]).callFrame;
    const key = `${leaf.functionName || '(anonymous)'} ${leaf.url.split('/').pop()}:${leaf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  return {
    arrivalWorkMs: round(total),
    inclusiveMs: Object.fromEntries(Object.entries(inclusive).map(([name, ms]) => [name, round(ms)])),
    topSelfMs: [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, ms]) => ({ name, ms: round(ms) }))
  };
}

// The arrival work under the tracer (devtools.timeline): the longest task the renderer's main thread ran during the
// open, what it spent its time in by trace event, and every layout and style recalculation inside it, by the script
// function that forced it (the event's own stack; an event without a stack ran at the frame's own render).
const TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack'];
async function startTrace(page) {
  const events = [];
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const onMessage = (_event, method, params) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value);
    if (method === 'Tracing.tracingComplete') complete();
  };
  page.win.webContents.debugger.on('message', onMessage);
  await page.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: TRACE_CATEGORIES } });
  return async () => {
    await page.send('Tracing.end');
    await completed;
    page.win.webContents.debugger.removeListener('message', onMessage);
    return events;
  };
}

function analyseTrace(events) {
  const mains = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const onMain = events.filter((e) => mains.has(`${e.pid}:${e.tid}`));
  // Complete events, with B/E pairs folded into complete ones.
  const spans = [];
  const open = new Map();
  for (const e of [...onMain].sort((a, b) => a.ts - b.ts)) {
    if (e.ph === 'X') spans.push({ name: e.name, ts: e.ts, dur: e.dur ?? 0, args: e.args, thread: `${e.pid}:${e.tid}` });
    else if (e.ph === 'B') {
      const key = `${e.pid}:${e.tid}:${e.name}`;
      open.set(key, [...(open.get(key) ?? []), e]);
    } else if (e.ph === 'E') {
      const key = `${e.pid}:${e.tid}:${e.name}`;
      const begun = open.get(key)?.pop();
      if (begun) spans.push({ name: e.name, ts: begun.ts, dur: e.ts - begun.ts, args: { ...begun.args, ...e.args }, thread: `${e.pid}:${e.tid}` });
    }
  }
  const tasks = spans.filter((s) => s.name === 'RunTask' || s.name === 'ThreadControllerImpl::RunTask');
  if (!tasks.length) throw new Error('the trace holds no main-thread task');
  const task = tasks.reduce((a, b) => (b.dur > a.dur ? b : a));
  const inside = spans.filter((s) => s.thread === task.thread && s !== task && s.ts >= task.ts && s.ts + s.dur <= task.ts + task.dur);
  const byName = new Map();
  for (const s of inside) byName.set(s.name, { count: (byName.get(s.name)?.count ?? 0) + 1, ms: (byName.get(s.name)?.ms ?? 0) + s.dur / 1000 });
  const forced = new Map();
  for (const s of inside.filter((x) => x.name === 'Layout' || x.name === 'UpdateLayoutTree')) {
    const frame = s.args?.beginData?.stackTrace?.[0] ?? null;
    const key = `${s.name} ← ${frame ? `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}` : '(no stack)'}`;
    forced.set(key, { count: (forced.get(key)?.count ?? 0) + 1, ms: (forced.get(key)?.ms ?? 0) + s.dur / 1000 });
  }
  const sorted = (map) => [...map].sort((a, b) => b[1].ms - a[1].ms).map(([name, v]) => ({ name, count: v.count, ms: round(v.ms) }));
  return { longestTaskMs: round(task.dur / 1000), events: sorted(byName).slice(0, 15), layoutAndStyle: sorted(forced) };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function measure({ repoRoot, outDir, runs }) {
  const globalTimer = setTimeout(() => { console.error('FAILED global timeout (15 min)'); runTeardown().finally(() => app.exit(2)); }, 15 * 60 * 1000);
  teardown.push(async () => clearTimeout(globalTimer));
  await app.whenReady();
  app.on('window-all-closed', () => {});
  const head = (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'])).stdout.trim();
  check('repo is clean (the figures are stamped with HEAD)', dirty === '', { head, dirty });
  const { createServer } = await import(path.join(repoRoot, 'app/src/server.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  const catalog = JSON.parse(await fs.readFile(path.join(repoRoot, 'data/definitions/game_data/library_catalog.json'), 'utf8')).books;
  const seedMagic = JSON.parse(await fs.readFile(path.join(repoRoot, 'data/seeds/game_data/runtime/player_parameters.json'), 'utf8')).magic;
  const gatedIds = new Set(catalog.filter((book) => book.gate && !(book.gate.kind === 'magic' && seedMagic[book.gate.key].value >= book.gate.min)).map((book) => book.id));

  const stage = await startStage(repoRoot, { createServer, runtimePathsManifestFilename, gatedIds });
  teardown.push(stage.stop);
  const page = await openPage();
  teardown.push(() => page.close());
  await enterLibrary(page, stage);
  const arrivedAt = Date.now();
  await sleep(2800);
  await page.click('.academy-library-slip-input', {}, { steps: 12, stepMs: 25 });
  await page.type(THEME, 60);
  await sleep(300);
  await page.click('.academy-library-slip-hand', {}, { steps: 8, stepMs: 25 });
  await page.waitFor(`${SCENE} === 'shelf'`, 'shelf', { timeoutMs: 60000, intervalMs: 100 });
  await sleep(2600);
  const shelf = stage.front.last('POST', '/api/library/search').json;
  const generated = [...shelf.generated_books, ...shelf.free_books].map((book) => book.title);
  check(`the shelf holds ${runs + 2} 生成 books to open (runs + the profiled open + the traced open)`, generated.length >= runs + 2, { generated });

  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const title = generated[i];
    console.log(`── open ${i + 1}/${runs}: 「${title}」`);
    const { probe } = await openBook(page, title, { profile: false });
    const result = { run: i + 1, loadAvg: os.loadavg().map((v) => +v.toFixed(2)), ...analyse(probe, { stage, title }) };
    results.push(result);
    console.log(`STALLRUN ${JSON.stringify(result)}`);
    await closeBook(page);
  }
  const profiledTitle = generated[runs];
  console.log(`── profiled open: 「${profiledTitle}」`);
  const { probe, cpu } = await openBook(page, profiledTitle, { profile: true });
  const profiled = { title: profiledTitle, ...analyse(probe, { stage, title: profiledTitle }), profile: analyseProfile(cpu) };
  console.log(`STALLPROFILE ${JSON.stringify({ title: profiledTitle, times: profiled.times, profile: profiled.profile })}`);
  await closeBook(page);
  const tracedTitle = generated[runs + 1];
  console.log(`── traced open: 「${tracedTitle}」`);
  const stopTrace = await startTrace(page);
  const tracedOpen = await openBook(page, tracedTitle, { profile: false });
  const traced = { title: tracedTitle, ...analyse(tracedOpen.probe, { stage, title: tracedTitle }), trace: analyseTrace(await stopTrace()) };
  console.log(`STALLTRACE ${JSON.stringify({ title: tracedTitle, times: traced.times, trace: traced.trace })}`);

  const columns = ['bodyArrived_responseEnd', 'firstFrameAfterArrival', 'brushFirstLiftingFrame', 'sweepingObserved', 'bloomFirstVisible', 'glowFirstVisible', 'brushGone', 'pageFilled_bloomDone', 'textShown_inkReady'];
  console.log(`STALL-TABLE run\t${columns.join('\t')}\tlongestFrameMs\tframes`);
  for (const result of results) console.log(`STALL-TABLE ${result.run}\t${columns.map((c) => result.times[c]).join('\t')}\t${result.frames.fromArrivalToShownLongestMs}\t${result.frames.fromArrivalToShownCount}`);
  await writeJson(path.join(outDir, 'runs.json'), { head, fragmentHoldMs: FRAGMENT_HOLD_MS, footnotesHoldMs: FOOTNOTES_HOLD_MS, viewport: VIEWPORT, runs: results, profiled, traced, libraryArrivedAt: arrivedAt, rendererErrors: page.rendererErrors });
  console.log(`DONE head=${head} runs=${results.length} rendererErrors=${page.rendererErrors.length} out=${path.join(outDir, 'runs.json')}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Synchronous up to setPath: userData must be pointed before the app is ready.
  const existing = (() => {
    try {
      return readdirSync(args.outDir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  })();
  check('out dir is empty or absent', existing.length === 0, { existing: existing.slice(0, 5) });
  mkdirSync(args.outDir, { recursive: true });
  const userData = path.join(args.outDir, 'electron-user-data');
  app.setPath('userData', userData);
  teardown.push(() => fs.rm(userData, { recursive: true, force: true }));
  return measure(args);
}

Promise.resolve()
  .then(main)
  .then(async () => { await runTeardown(); app.exit(0); })
  .catch(async (error) => { console.error('FAILED', error); await runTeardown(); app.exit(1); });
