// The 大書庫's shelf, a book drawn out under the finger, frame by frame: every book of the three bays (上・真ん中・下) is
// pointed at with a real CDP mouse move, the pull's own CSS transitions are paused and stepped through FRAME_TIMES, and
// at each step the book's bottom edge (the spine's lower corners as the browser places them, the clipped bottom the
// lower bay shows, and the bottom of the cover face that comes out of the neighbour's shadow) is read off the page and
// set against the painted board it stands on (BOARDS: lines measured on stage.jpg). One book per bay (SHOT_BOOKS) is
// also captured as a still at every step (1440×900, 1:1) and as a strip of the same crop side by side.
//
// Run by hand (not *.test.mjs, so `npm test` skips it; it takes about two minutes):
//
//   ./node_modules/.bin/electron app/tests/manual/libraryShelfPullFrames.mjs \
//     --repo-root <absolute repo root> --out-dir <absolute, empty or absent directory> --motion <full|reduced>
//
// Every argument is required, the two paths absolute; there are no defaults. --motion is the page's
// prefers-reduced-motion: full (no-preference) steps the 800ms pull through FRAME_TIMES; reduced (reduce) measures the
// book at rest (the finger away) and drawn out (the finger on it, the page settled), and prints the book's computed
// transition and the pull's transitions as one SWITCH line per book. The repo must be clean (the figures are stamped
// with its HEAD). Written to --out-dir: <bay>-<ms>ms.png or <bay>-rest.png・<bay>-drawn.png (the stills), <bay>-strip.png (the crops side by side) and <bay>-strip-marked.png (the same with
// the board line in green and the book's bottom in red), measurements.json (HEAD, the motion, the art's box, the
// boards, every book's every frame, the renderer's console errors). Every frame is also printed as one FRAME line,
// every renderer console error as one RENDERER-ERROR line.
//
// WHAT IS REAL AND WHAT IS A FIXTURE
// - Entry: the ordinary play entry — the title screen, 新しいプレイ, the routing hub's welcome, one typed line asking for
//   the 大書庫, the hub's send-off into the library; then THEME is typed on the slip and handed over.
// - Server: the product createServer in this process over an OS-temp root (the definitions and seeds are copied
//   there; the repo's data/ and app/config are never opened for writing). The renderer's userData is a directory in
//   --out-dir, removed at the end.
// - LM: a fixed-answer server speaking the LM Studio wire protocol (the hub's talk and the library's selection and
//   titles prompts).
// - Rendering: a hidden Electron window over CDP, 1440×900 at DPR 1, the motion --motion names. The only thing the
//   harness changes on the page is the playback of the pull's transitions under full motion (paused and seeked); the
//   shelf, the books and their styles are the product's.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PATH_ARGS = ['--repo-root', '--out-dir'];
const ARGS = [...PATH_ARGS, '--motion'];
// Under full motion the pull is one 800ms transition (style.css .academy-library-book-item); its steps, from the
// finger's arrival.
const FRAME_TIMES = [0, 100, 200, 300, 400, 500, 600, 700, 800];
const REDUCED_MOTION = { full: 'no-preference', reduced: 'reduce' };

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!ARGS.includes(token)) throw new Error(`unexpected argument: ${token} (expected ${ARGS.join(', ')} only)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of ARGS) if (parsed[token] === undefined) throw new Error(`${token} is required (no default, no fallback)`);
  for (const token of PATH_ARGS) if (!path.isAbsolute(parsed[token])) throw new Error(`${token} must be an absolute path: ${parsed[token]}`);
  if (!Object.hasOwn(REDUCED_MOTION, parsed['--motion'])) throw new Error(`--motion must be one of ${Object.keys(REDUCED_MOTION).join(', ')}: ${parsed['--motion']}`);
  return { repoRoot: parsed['--repo-root'], outDir: parsed['--out-dir'], motion: parsed['--motion'] };
}

const VIEWPORT = { width: 1440, height: 900 };
const HUB_INPUT = '大書庫で本を探したい';
const THEME = '夜の星と古い記録';
// The book of each bay captured as stills: the bay and the book's place in it (--order, from the far end).
const SHOT_BOOKS = [{ bay: 'upper', order: 2 }, { bay: 'middle', order: 2 }, { bay: 'lower', order: 0 }];
// Around the captured book's whole path in the stills' crop (screen px).
const CROP_MARGIN = 24;
const STRIP_GAP = 8;
const ART_UNIT = 1440;

// The painted boards, in px of the art at 1440 wide (y = y0 + slope·(x − x0)), measured on stage.jpg for this harness:
// for each column the largest step in brightness across the line (dark → light where the books' feet meet the board,
// light → dark at the board's near edge), and a least-squares line through the columns. `span` is the art's x range
// where that board is painted; a book drawn past it hangs over something else (the case's post).
// - upper: the board's top edge, where the books' feet meet it (above the eye line, its upper face is not seen); 29
//   columns 1135–1280, residual ≤ 2.4px.
// - middle: the books' feet on the board (23 columns 1306–1438, residual ≤ 0.9px) and the board's near edge, about 2px
//   below (residual ≤ 0.7px).
// - lower: each book's painted feet on the board (order 0: columns 1308–1344, residual ≤ 0.3px; order 1: columns
//   1348–1392, residual ≤ 3.0px — its foot is rounded) and the near edge where the desk's pile of books starts (the
//   product's own `cut` line: the board's near edge is hidden under the pile).
const BOARDS = {
  upper: { span: [1140, 1280], feet: [{ x0: 1135, y0: 648.43, slope: -0.1168 }] },
  middle: { span: [1306, 1440], feet: [{ x0: 1306, y0: 824.86, slope: 0.0691 }], near: { x0: 1306, y0: 826.99, slope: 0.0693 } },
  lower: {
    span: [1306, 1440],
    feet: [{ x0: 1308, y0: 1037.72, slope: 0.3011 }, { x0: 1348, y0: 1058.39, slope: 0.0812 }],
    near: { x0: 1306, y0: 1058, slope: 20 / 134 }
  }
};
const lineY = ({ x0, y0, slope }, x) => y0 + slope * (x - x0);

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
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ── Pillow (crops, strips, the marked strip) ─────────────────────────────────────────────────────────────────
const PYTHON_TOOL = [
  'import json, sys',
  'from PIL import Image, ImageDraw',
  'job = json.loads(sys.argv[1])',
  'box = tuple(job["box"])',
  'crops = [Image.open(f).convert("RGB").crop(box) for f in job["files"]]',
  'gap = job["gap"]',
  'w, h = crops[0].size',
  'canvas = Image.new("RGB", (w * len(crops) + gap * (len(crops) - 1), h), (0, 0, 0))',
  'for i, c in enumerate(crops):',
  '    canvas.paste(c, (i * (w + gap), 0))',
  'canvas.save(job["out"], format="PNG")',
  'marked = canvas.copy()',
  'draw = ImageDraw.Draw(marked)',
  'for i, frame in enumerate(job["marks"]):',
  '    ox = i * (w + gap) - box[0]',
  '    oy = -box[1]',
  '    for line, colour in ((frame["board"], (60, 220, 90)), (frame["bottom"], (240, 60, 60))):',
  '        draw.line([(x + ox, y + oy) for x, y in line], fill=colour, width=1)',
  'marked.save(job["marked"], format="PNG")',
  'print(json.dumps({"size": list(canvas.size)}))'
].join('\n');

async function python(job) {
  try {
    const { stdout } = await execFileAsync('python3', ['-c', PYTHON_TOOL, JSON.stringify(job)], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').pop());
  } catch (error) {
    throw new Error(`python3 failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function pngSize(bytes) {
  if (bytes.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG (no IHDR)');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// ── The fixed-answer LM: the hub's talk, and the library's selection and titles ──────────────────────────────
const FILL_TITLES = ['観測者の夜録', '灯り番の手控え', '夜更けの暦', '塔の影の測り方', '鐘楼守りの記録', '霧の朝の星図'];
const FREE_TITLES = ['題の無い写本', '砂時計職人の弟子', '星の余白', '三つの月の旅日記', '羊皮紙の匂い', '銀の栞の行方'];

function answerFor(prompt, schema, state) {
  if (prompt.includes('テーマに合う本を選ぶ司書')) {
    state.titleCall = 0;
    const rowTitles = new Set([...FILL_TITLES, ...FREE_TITLES]);
    const candidates = [...prompt.matchAll(/^- (\S+) ／ (.+?) ／/gm)].filter((match) => !rowTitles.has(match[2])).map((match) => match[1]);
    const pick = (prefix, count) => candidates.filter((id) => id.startsWith(prefix)).slice(0, count);
    return JSON.stringify({ book_ids: [...pick('core_', 1), ...pick('periphery_', 2)] });
  }
  if (prompt.includes('蔵書目録を作っている')) {
    const match = /タイトルを(\d+)つ/.exec(prompt);
    if (!match) throw new Error('fixture lm: title prompt without a count');
    state.titleCall += 1;
    // One search asks for titles twice: the 補充 row first, then the 自由 row.
    const pool = state.titleCall === 1 ? FILL_TITLES : FREE_TITLES;
    const count = Number(match[1]);
    if (count > pool.length) throw new Error(`fixture lm: asked for ${count} titles, the pool has ${pool.length}`);
    return pool.slice(0, count).join('\n');
  }
  if (schema === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schema === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('好感度の変化量を判定する')) return '0';
  if (prompt.includes('MP温存ライン')) return '30';
  if (prompt.includes('所持金判定')) return '0';
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'library';
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) return 'では、大書庫へ。';
  if (prompt.includes('次の会話セッションだけを根拠に')) return '大書庫へ本を探しに行った。';
  if (prompt.includes('ルーティングハブに所属する')) return '新しい週をここから始めましょう。';
  throw new Error(`fixture lm: unknown prompt kind: ${prompt.slice(0, 80)}`);
}

function startFixtureLm() {
  const state = { titleCall: 0 };
  const errors = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages.map((message) => message.content).join('\n');
    let content;
    try {
      content = answerFor(prompt, body.response_format?.json_schema?.name ?? '', state);
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message) }));
      return;
    }
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
      errors,
      stop: () => new Promise((done) => { server.close(done); server.closeAllConnections(); })
    }));
  });
}

// ── The stage: an OS-temp root, the product server, the LM ───────────────────────────────────────────────────
async function startStage(repoRoot) {
  const { createServer } = await import(path.join(repoRoot, 'app/src/server.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-shelf-pull-'));
  teardown.push(() => fs.rm(root, { recursive: true, force: true }));
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
  const lm = await startFixtureLm();
  teardown.push(lm.stop);
  const lmConfigPath = path.join(configRoot, 'lmstudio.json');
  await writeJson(lmConfigPath, {
    provider: 'lmstudio',
    base_url: lm.baseUrl,
    chat_model: 'shelf-pull-fixture',
    reflection_model: 'shelf-pull-fixture',
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
  teardown.push(() => new Promise((resolve) => { product.close(resolve); product.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${product.address().port}`, lm };
}

// ── The page under CDP ────────────────────────────────────────────────────────────────────────────────────────
async function openPage(motion) {
  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false, partition: 'library-shelf-pull' }
  });
  const rendererErrors = [];
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) rendererErrors.push({ message, source: `${sourceId}:${line}` });
  });
  await win.loadURL('about:blank');
  const cdp = win.webContents.debugger;
  cdp.attach('1.3');
  const send = (method, params = {}) => cdp.sendCommand(method, params);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: REDUCED_MOTION[motion] }] });
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const page = {
    js,
    rendererErrors,
    async load(url) {
      await win.loadURL(url);
      const measured = await js('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
      check(`viewport ${VIEWPORT.width}x${VIEWPORT.height} dpr1`, measured.w === VIEWPORT.width && measured.h === VIEWPORT.height && measured.dpr === 1, measured);
    },
    async waitFor(predicate, label, { timeoutMs = 30000, intervalMs = 50 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await js(`(() => { try { return !!(${predicate}); } catch (error) { return false; } })()`)) return;
        await sleep(intervalMs);
      }
      throw new Error(`timed out waiting for ${label} (renderer errors: ${JSON.stringify(rendererErrors.slice(-3))})`);
    },
    async pointOf(selector) {
      return js(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('no node: ' + ${JSON.stringify(selector)});
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) throw new Error('node has no box: ' + ${JSON.stringify(selector)});
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(box.y + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === node || node.contains(hit))) throw new Error('point is covered at ' + ${JSON.stringify(selector)} + ': ' + (hit ? hit.className : 'nothing'));
        return { x, y };
      })()`);
    },
    async moveTo({ x, y }) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },
    async click(selector) {
      const point = await page.pointOf(selector);
      await page.moveTo(point);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    async type(text) {
      for (const character of [...text]) await send('Input.insertText', { text: character });
    },
    // Two frames, a redraw and a throwaway shot, so the shot holds what was just measured (a hidden window's paint trails the DOM).
    async settle() {
      await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      win.webContents.invalidate();
      await send('Page.captureScreenshot', { format: 'png' });
    },
    async still(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(data, 'base64');
      const size = pngSize(bytes);
      check(`still ${path.basename(file)} is ${VIEWPORT.width}x${VIEWPORT.height}`, size.width === VIEWPORT.width && size.height === VIEWPORT.height, size);
      await fs.writeFile(file, bytes);
    },
    async close() {
      if (cdp.isAttached()) cdp.detach();
      if (!win.isDestroyed()) win.destroy();
    }
  };
  return page;
}

// ── Reading the shelf ─────────────────────────────────────────────────────────────────────────────────────────
const ROOT = `document.querySelector('#academy-library-screen')`;
const SHELF_BOOK = '.academy-library-shelf > button.academy-library-book-item';

// Every book's bay (from its box's top in art px: the upper bay's boxes start near 500, the middle's near 640, the
// lower's near 870) and its place in the bay.
const SHELF_INDEX = `[...document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})].map((node, index) => {
  const top = Number.parseFloat(node.style.top) * ${ART_UNIT} / 100;
  return { index, title: node.getAttribute('aria-label'), order: Number(node.style.getPropertyValue('--order')), bay: top < 600 ? 'upper' : top < 800 ? 'middle' : 'lower' };
})`;

// The pull's own animations: the transitions on the book, its ::before and its cover face.
const PULL_ANIMATIONS = (index) => `document.getAnimations().filter((a) => {
  const node = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}];
  const target = a.effect && a.effect.target;
  return target && (target === node || node.contains(target));
})`;

// One book as the page lays it out now (screen px): the spine's four corners (the face's projection, then the book's
// transform about its own transform-origin), the corners of the spine's clip (the lower bay), the cover face's box,
// and the art's box. The face's own bounding box is read too, to check the computed corners against the browser's.
const MEASURE = (index) => `(() => {
  const node = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}];
  const shelf = node.parentElement.getBoundingClientRect();
  const art = ${ROOT}.querySelector('.academy-library-art').getBoundingClientRect();
  const face = node.querySelector('.academy-library-book-face');
  const spine = node.querySelector('.academy-library-book-spine');
  const reveal = node.querySelector('.academy-library-book-reveal');
  const style = getComputedStyle(node);
  const pct = (value, of) => Number.parseFloat(value) * of / 100;
  const box = { left: shelf.left + pct(node.style.left, shelf.width), top: shelf.top + pct(node.style.top, shelf.height), width: pct(node.style.width, shelf.width), height: pct(node.style.height, shelf.height) };
  const m = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
  const [ox, oy] = style.transformOrigin.split(' ').map(Number.parseFloat);
  const place = ([x, y]) => { const p = m.transformPoint(new DOMPoint(x - ox, y - oy)); return [box.left + ox + p.x, box.top + oy + p.y]; };
  const f = new DOMMatrix(face.style.transform);
  const [fw, fh] = [Number.parseFloat(face.style.width), Number.parseFloat(face.style.height)];
  const project = ([x, y]) => { const p = f.transformPoint(new DOMPoint(x, y, 0, 1)); return [p.x / p.w, p.y / p.w]; };
  const corners = [[0, 0], [fw, 0], [fw, fh], [0, fh]].map((point) => place(project(point)));
  const clip = spine.style.clipPath ? [...spine.style.clipPath.matchAll(/([\\d.]+)% ([\\d.]+)%/g)].map((match) => place([Number(match[1]) * box.width / 100, Number(match[2]) * box.height / 100])) : null;
  const faceBox = face.getBoundingClientRect();
  const cover = reveal.getBoundingClientRect();
  return {
    art: { left: art.left, top: art.top, width: art.width },
    transform: [m.a, m.d, m.e, m.f],
    corners,
    clip,
    faceBox: { left: faceBox.left, top: faceBox.top, right: faceBox.right, bottom: faceBox.bottom },
    cover: cover.width > 0.01 ? { left: cover.left, right: cover.right, bottom: cover.bottom } : null,
    pullDx: node.style.getPropertyValue('--pull-dx')
  };
})()`;

// The bottom of the book in a frame, against the board: the spine's lower corners (left, right), the visible bottom
// (the clip's lowest points at the left and the right, where the lower bay clips the spine), the cover face's bottom
// at its left and right ends. Each point: screen px, and how far below the board's feet line (and near edge) it is
// at its own x (+ is below), in screen px.
function bottomOf(raw, bay, order) {
  const unit = raw.art.width / ART_UNIT;
  const toArt = ([x, y]) => [(x - raw.art.left) / unit, (y - raw.art.top) / unit];
  const toScreenY = (yArt) => raw.art.top + yArt * unit;
  const board = BOARDS[bay];
  const feet = board.feet[Math.min(order, board.feet.length - 1)];
  const at = (label, point) => {
    const [ax, ay] = toArt(point);
    const feetY = toScreenY(lineY(feet, ax));
    const nearY = board.near ? toScreenY(lineY(board.near, ax)) : null;
    return {
      at: label,
      x: +point[0].toFixed(2),
      y: +point[1].toFixed(2),
      onBoard: ax >= board.span[0] && ax <= board.span[1],
      feetY: +feetY.toFixed(2),
      belowFeet: +(point[1] - feetY).toFixed(2),
      nearY: nearY === null ? null : +nearY.toFixed(2),
      belowNear: nearY === null ? null : +(point[1] - nearY).toFixed(2)
    };
  };
  const [, , br, bl] = raw.corners;
  const points = [at('spine-left', bl), at('spine-right', br)];
  if (raw.clip) {
    const xs = raw.clip.map(([x]) => x);
    const lowestNear = (x) => raw.clip.filter(([px]) => Math.abs(px - x) < 0.5).reduce((a, b) => (b[1] > a[1] ? b : a));
    points.push(at('shown-left', lowestNear(Math.min(...xs))), at('shown-right', lowestNear(Math.max(...xs))));
  }
  if (raw.cover) points.push(at('cover-left', [raw.cover.left, raw.cover.bottom]), at('cover-right', [raw.cover.right, raw.cover.bottom]));
  return points;
}

// ── The walk ──────────────────────────────────────────────────────────────────────────────────────────────────
async function enterShelf(page, stage) {
  await page.load(`${stage.base}/`);
  await page.waitFor(`document.querySelector('#journey')?.dataset.journeyReady === 'true' && document.querySelector('#journey').dataset.scene === 'gate'`, 'title gate');
  await page.click('[data-journey-action="new-game"]');
  await page.waitFor(`document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send').disabled && document.querySelector('#routing-hub-message-stream').textContent.trim().length > 0`, 'routing hub welcome', { timeoutMs: 60000 });
  await page.click('#routing-hub-input');
  await page.type(HUB_INPUT);
  // The send is a no-op while the welcome is still being revealed: pressed until the product clears the input.
  let taken = false;
  for (let attempt = 0; attempt < 60 && !taken; attempt += 1) {
    await page.click('#routing-hub-send');
    await sleep(250);
    taken = await page.js(`document.querySelector('#routing-hub-input').value === ''`);
    if (!taken) await sleep(500);
  }
  if (!taken) throw new Error('the hub never took the typed line');
  await page.waitFor(`[...document.querySelectorAll('.screen.active')].map((s) => s.id).join() === 'academy-library-screen' && ${ROOT}.dataset.arrived === 'true'`, 'library arrival', { timeoutMs: 60000, intervalMs: 20 });
  const look = await page.js(`({ playMode: document.body.classList.contains('play-mode'), topbar: getComputedStyle(document.querySelector('.topbar')).display, url: location.pathname + location.search })`);
  check('entered through play (play-mode, no development top bar, no query)', look.playMode && look.topbar === 'none' && look.url === '/', look);
  // The lamps and the dust come up over 2.6 s and the arrival's loading cover lifts.
  await sleep(2800);
  await page.click('.academy-library-slip-input');
  await page.type(THEME);
  await page.click('.academy-library-slip-hand');
  await page.waitFor(`${ROOT}.dataset.scene === 'shelf'`, 'shelf', { timeoutMs: 60000, intervalMs: 20 });
  // The books slide in (0.9 s each, 0.12 s apart): wait until nothing on the shelf moves.
  await page.waitFor(`document.querySelectorAll(${JSON.stringify(SHELF_BOOK)}).length > 0 && document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.closest?.('.academy-library-shelf')).length === 0`, 'the shelf at rest', { timeoutMs: 20000 });
}

const AWAY = { x: 200, y: 120 };

// One frame of a book: measured (and, for a captured book, the still taken) as the page lies now.
async function takeFrame(page, book, shoot, t, still) {
  await page.settle();
  const raw = await page.js(MEASURE(book.index));
  const lowest = Math.max(...raw.corners.map(([, y]) => y));
  check(`「${book.title}」 t=${t}: the computed spine corners agree with the browser's box of the face (bottom within 0.5px)`, Math.abs(lowest - raw.faceBox.bottom) <= 0.5, { computed: lowest, browser: raw.faceBox.bottom });
  const frame = { t, raw, bottom: bottomOf(raw, book.bay, book.order) };
  if (shoot) {
    frame.still = still;
    await page.still(path.join(shoot, still));
  }
  return frame;
}

const DRAWN = (index) => `document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${index}].dataset.drawn === 'true'`;

// Reduced motion: the book at rest (the finger away), then drawn out (the finger on it, the page settled). What the
// switch is made of — the book's computed transition and the pull's transitions just after the finger arrives — is
// recorded, not assumed.
async function switchFrames(page, book, shoot) {
  await page.moveTo(AWAY);
  await sleep(50);
  const point = await page.pointOf(`${SHELF_BOOK}:nth-child(${book.index + 1 + book.shadeCount})`);
  const rest = await takeFrame(page, book, shoot, 'rest', `${book.bay}-rest.png`);
  await page.moveTo(point);
  const change = await page.js(`(() => {
    const node = document.querySelectorAll(${JSON.stringify(SHELF_BOOK)})[${book.index}];
    return { transition: getComputedStyle(node).transition, transitions: ${PULL_ANIMATIONS(book.index)}.map((a) => [a.transitionProperty ?? null, a.effect.pseudoElement ?? null, a.effect.getTiming().duration, a.playState]) };
  })()`);
  check(`「${book.title}」 (${book.bay} ${book.order}): the finger drew it out (data-drawn)`, await page.js(DRAWN(book.index)));
  console.log(`SWITCH\t${book.bay}\t${book.order}\t${book.title}\t${JSON.stringify(change)}`);
  await page.waitFor(`${PULL_ANIMATIONS(book.index)}.every((a) => a.playState !== 'running')`, `「${book.title}」 drawn out`, { timeoutMs: 5000 });
  const drawn = await takeFrame(page, book, shoot, 'drawn', `${book.bay}-drawn.png`);
  await page.moveTo(AWAY);
  await page.waitFor(`!(${DRAWN(book.index)}) && ${PULL_ANIMATIONS(book.index)}.every((a) => a.playState !== 'running')`, `「${book.title}」 back at rest`, { timeoutMs: 5000 });
  return { switch: change, frames: [rest, drawn].map((frame, i) => ({ ...frame, progress: i })) };
}

// Full motion: point at one book, pause the pull's transitions and step them through FRAME_TIMES; at each step measure
// (and, for a captured book, take the still). Then let the pull finish and take the finger away until the book is
// back at rest.
async function pullFrames(page, book, shoot) {
  await page.moveTo(AWAY);
  await sleep(50);
  const point = await page.pointOf(`${SHELF_BOOK}:nth-child(${book.index + 1 + book.shadeCount})`);
  await page.moveTo(point);
  const kinds = await page.js(`(() => { const list = ${PULL_ANIMATIONS(book.index)}; list.forEach((a) => a.pause()); return list.map((a) => [a.constructor.name, a.transitionProperty ?? null, a.effect.pseudoElement ?? null, a.effect.getTiming().duration]); })()`);
  check(`「${book.title}」 (${book.bay} ${book.order}): the finger drew it out (data-drawn) and its transitions are paused`,
    kinds.some(([kind, property, pseudo]) => kind === 'CSSTransition' && property === 'transform' && pseudo === null)
    && kinds.some(([kind, property]) => kind === 'CSSTransition' && property === 'width')
    && await page.js(DRAWN(book.index)), { kinds });
  const frames = [];
  for (const t of FRAME_TIMES) {
    await page.js(`(() => { ${PULL_ANIMATIONS(book.index)}.forEach((a) => { a.currentTime = ${t}; }); return true; })()`);
    frames.push(await takeFrame(page, book, shoot, t, `${book.bay}-${String(t).padStart(3, '0')}ms.png`));
  }
  const endX = frames[frames.length - 1].raw.transform[2];
  for (const frame of frames) frame.progress = +(frame.raw.transform[2] / endX).toFixed(4);
  await page.js(`(() => { ${PULL_ANIMATIONS(book.index)}.forEach((a) => a.finish()); return true; })()`);
  await page.moveTo(AWAY);
  await page.waitFor(`!(${DRAWN(book.index)}) && ${PULL_ANIMATIONS(book.index)}.every((a) => a.playState !== 'running')`, `「${book.title}」 back at rest`, { timeoutMs: 5000 });
  return { frames };
}

// The crop around a captured book's whole path, and its marks: the board's feet line across the crop and the book's
// bottom (the spine's lower edge — the shown one where clipped — and the cover face's bottom).
function stripJob(frames, bay, order, outDir) {
  const xs = frames.flatMap((frame) => [...frame.raw.corners.map(([x]) => x), ...(frame.raw.cover ? [frame.raw.cover.left, frame.raw.cover.right] : [])]);
  const ys = frames.flatMap((frame) => [...frame.raw.corners.map(([, y]) => y), ...(frame.raw.cover ? [frame.raw.cover.bottom] : [])]);
  const box = [
    Math.max(0, Math.floor(Math.min(...xs)) - CROP_MARGIN),
    Math.max(0, Math.floor(Math.min(...ys)) - CROP_MARGIN),
    Math.min(VIEWPORT.width, Math.ceil(Math.max(...xs)) + CROP_MARGIN),
    Math.min(VIEWPORT.height, Math.ceil(Math.max(...ys)) + CROP_MARGIN)
  ];
  const board = BOARDS[bay];
  const feet = board.feet[Math.min(order, board.feet.length - 1)];
  const marks = frames.map((frame) => {
    const unit = frame.raw.art.width / ART_UNIT;
    const screenY = (xScreen) => frame.raw.art.top + lineY(feet, (xScreen - frame.raw.art.left) / unit) * unit;
    const pick = (label) => frame.bottom.find((point) => point.at === label);
    const shown = pick('shown-left') ? ['shown-left', 'shown-right'] : ['spine-left', 'spine-right'];
    const bottom = shown.map((label) => [pick(label).x, pick(label).y]);
    if (pick('cover-left')) bottom.push([pick('cover-left').x, pick('cover-left').y], [pick('cover-right').x, pick('cover-right').y]);
    return { board: [[box[0], screenY(box[0])], [box[2], screenY(box[2])]], bottom };
  });
  return { box, files: frames.map((frame) => path.join(outDir, frame.still)), gap: STRIP_GAP, marks, out: path.join(outDir, `${bay}-strip.png`), marked: path.join(outDir, `${bay}-strip-marked.png`) };
}

const USER_DATA_DIR = 'electron-user-data';

async function main() {
  const { repoRoot, outDir, motion } = parseArgs(process.argv.slice(2));
  // Synchronous up to setPath: userData must be pointed before the app is ready.
  const existing = (() => {
    try {
      return readdirSync(outDir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  })();
  check('out dir is empty or absent', existing.length === 0, { existing: existing.slice(0, 5) });
  mkdirSync(outDir, { recursive: true });
  const userData = path.join(outDir, USER_DATA_DIR);
  app.setPath('userData', userData);
  teardown.push(() => fs.rm(userData, { recursive: true, force: true }));
  const globalTimer = setTimeout(() => { console.error('FAILED global timeout (8 min)'); runTeardown().finally(() => app.exit(2)); }, 8 * 60 * 1000);
  teardown.push(async () => clearTimeout(globalTimer));
  await app.whenReady();
  app.on('window-all-closed', () => {});

  const head = (await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'])).stdout.trim();
  check('repo is clean (the figures are stamped with HEAD)', dirty === '', { head, dirty });

  const stage = await startStage(repoRoot);
  const page = await openPage(motion);
  teardown.push(() => page.close());
  await enterShelf(page, stage);

  const shadeCount = await page.js(`document.querySelectorAll('.academy-library-shelf > .academy-library-bay').length`);
  const books = (await page.js(SHELF_INDEX)).map((book) => ({ ...book, shadeCount }));
  const counts = Object.fromEntries(['upper', 'middle', 'lower'].map((bay) => [bay, books.filter((book) => book.bay === bay).length]));
  check('the shelf holds books in all three bays', counts.upper > 0 && counts.middle > 0 && counts.lower > 0, counts);
  for (const shot of SHOT_BOOKS) check(`a book stands at ${shot.bay} ${shot.order}`, books.some((book) => book.bay === shot.bay && book.order === shot.order));

  const results = [];
  for (const book of books) {
    const shot = SHOT_BOOKS.some((s) => s.bay === book.bay && s.order === book.order);
    const taken = await (motion === 'full' ? pullFrames : switchFrames)(page, book, shot ? outDir : null);
    results.push({ ...book, shot, ...taken });
    for (const frame of taken.frames) {
      const cells = frame.bottom.map((p) => `${p.at}=(${p.x},${p.y}) feet ${p.feetY} below ${p.belowFeet}${p.nearY === null ? '' : ` near ${p.nearY} below ${p.belowNear}`}${p.onBoard ? '' : ' off-board'}`);
      console.log(`FRAME\t${book.bay}\t${book.order}\t${book.title}\tt=${frame.t}\tp=${frame.progress}\t${cells.join('\t')}`);
    }
  }
  for (const shot of SHOT_BOOKS) {
    const result = results.find((r) => r.bay === shot.bay && r.order === shot.order);
    const strip = await python(stripJob(result.frames, shot.bay, shot.order, outDir));
    console.log(`STRIP\t${shot.bay}\t${shot.order}\t${result.title}\t${strip.size.join('x')}`);
  }
  await writeJson(path.join(outDir, 'measurements.json'), {
    head,
    viewport: VIEWPORT,
    theme: THEME,
    motion,
    frameTimesMs: motion === 'full' ? FRAME_TIMES : null,
    boards: BOARDS,
    shots: SHOT_BOOKS,
    rendererErrors: page.rendererErrors,
    lmErrors: stage.lm.errors,
    books: results.map(({ shadeCount: _shadeCount, ...rest }) => rest)
  });
  // The renderer's console errors are recorded, not judged: the walk's hub and arrival are not what is measured here.
  for (const error of page.rendererErrors) console.log(`RENDERER-ERROR\t${error.message}\t${error.source}`);
  check('no fixture LM errors', stage.lm.errors.length === 0, { errors: stage.lm.errors });
  console.log(`DONE head=${head} motion=${motion} books=${results.length} frames=${results[0].frames.length}`);
}

main()
  .then(async () => { await runTeardown(); app.exit(0); })
  .catch(async (error) => { console.error('FAILED', error); await runTeardown(); app.exit(1); });
