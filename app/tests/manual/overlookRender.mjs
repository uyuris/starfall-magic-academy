// Render-backed 星見の窓 (overlook) screen QA: the composition's states 1〜19 in real Blink at 1440×960, driven through
// the REAL client (app.js / overlookClient.js / the layout worker) and the REAL server, entered from the routing hub's
// real dispatch. The overlook LM is the product's mock provider (?provider=mock on enter); the hub LM is a
// wire-protocol stub.
//
// `node --test` cannot run app.js (no DOM / layout / workers), so this harness runs it in Electron. It is not named
// *.test.mjs and lives under app/tests/manual/ (unguarded in the change gate); run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/overlookRender.mjs \
//     --repo-root <absolute tree> --out-dir <absolute output directory> --mode overlook|lounge
//
//   --mode overlook  the nineteen overlook captures (01-hub-candidates … 19-roster-swap, plus 06b the focus-wait cover,
//                    16b the 15:00 return, and 18b / 18c the roster list in a 760 px high window — opened, then
//                    scrolled) and audit.json.
//   --mode lounge    one capture of the 談話室 arrival (the first round revealed, the player's turn open) — run on the
//                    trees before and after a change to compare the lounge pixel by pixel. The lounge's motes canvas
//                    (random, animated) is hidden in the capture; nothing else is touched.
//
// Fixture seams (the product code is not patched):
//   - an OS-temp routing slot; the server runs in this process;
//   - the server's wall clock (Date.now in this process) is frozen right after the overlook entry and moved on by the
//     harness, so the academy time only advances when a capture needs it;
//   - a local proxy in front of the server adds ?provider=mock to the overlook enter (the client sends none) and holds
//     its answer 2.5 s so the entry cover is capturable; in lounge mode it answers the lounge utterance stream with
//     fixed lines, the speakers in character_id order (the lounge entry is the real server's; only its first speaker
//     — drawn from the entry time — is set to that order's head, so two runs show the same rows);
//   - the live overlook session's generators (the mock provider's) are wrapped: the talk lines stream in timed deltas
//     so the focus-wait cover and 状態 8 exist, the unwatched resolutions can be held so a meeting pair stays
//     pickable (状態 14), and one call can be made to fail through the product's own LM transport (a chat request to a
//     closed loopback port → LMSTUDIO_CONNECTION_UNAVAILABLE) for 状態 15.
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { execFileSync } from 'node:child_process';

// ── the server clock (frozen / moved by the harness) ──────────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
const clock = { frozenAt: null };
Date.now = () => clock.frozenAt ?? realNow();
function freezeClock() { clock.frozenAt = Date.now(); }
function advanceClock(ms) {
  if (clock.frozenAt === null) throw new Error('advanceClock needs a frozen clock');
  clock.frozenAt += ms;
}

// ── CLI (required, absolute, no defaults) ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const parsed = {};
  const known = new Set(['--repo-root', '--out-dir', '--mode']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!known.has(token)) throw new Error(`unexpected argument: ${token} (expected --repo-root, --out-dir, --mode)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    if (parsed[token] !== undefined) throw new Error(`duplicate argument: ${token}`);
    parsed[token] = value;
    i += 1;
  }
  for (const token of known) if (parsed[token] === undefined) throw new Error(`${token} is required (no default)`);
  for (const token of ['--repo-root', '--out-dir']) if (!path.isAbsolute(parsed[token])) throw new Error(`${token} must be an absolute path`);
  if (!['overlook', 'lounge'].includes(parsed['--mode'])) throw new Error(`--mode must be overlook or lounge: ${parsed['--mode']}`);
  return { repoRoot: parsed['--repo-root'], outDir: parsed['--out-dir'], mode: parsed['--mode'] };
}

const VIEWPORT = { width: 1440, height: 960 };
const POLL_MS = 100;
const ENTER_HOLD_MS = 2500;
const HUB_WISH = '今週はどこへ行こうかな。';
const HUB_DECIDE = '星見の窓に行きたい。学院を眺めたい';
const HUB_DECIDE_LOUNGE = '談話室に行きたい';
const HUB_CANDIDATES = '今週はどうしましょう。星見の窓から学院のみんなを眺めるのもいいですし、奏楽堂で一曲頼むのも素敵です。';
const WRITING_TEXT = '明日の朝、鍵が消える';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

const checks = [];
function check(name, pass, detail = {}) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!pass) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}

// ── hub LM stub (the prompt cases mirror concertHallRender.mjs) ───────────────────────────────────────────────
async function startLmStub(state) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages?.map((message) => message.content).join('\n') ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    requests.push({ at: Date.now(), schemaName, promptHead: prompt.slice(0, 40), overlookResultLine: prompt.match(/- 直近コンテンツ結果: 先週は星見の窓[^\n]*/)?.[0] ?? null });
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) content = 'true';
    else if (prompt.includes('好感度の変化量を判定する')) content = '0';
    else if (prompt.includes('MP温存ライン')) content = '30';
    else if (prompt.includes('所持金判定')) content = '0';
    else if (prompt.includes('場所移動の合意')) content = 'false';
    else if (prompt.includes('location_idを1つだけ返す')) content = 'none';
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
      state.judgments += 1;
      content = state.judgments === 1 && state.firstTurnUndecided ? 'none' : state.destination;
    } else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) content = 'では、行ってらっしゃい。';
    else if (state.hubReplies === 0) { state.hubReplies += 1; content = '新しい週をここから始めましょう。'; }
    else { state.hubReplies += 1; content = HUB_CANDIDATES; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

async function closedLoopbackPort() {
  const probe = createTcpServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// ── the proxy in front of the server ─────────────────────────────────────────────────────────────────────────
function loungeLine(speaker, index) {
  return `${speaker.character_name.split('・')[0]}です。今夜の談話室は静かですね。（${index + 1}番目に口を開いた）`;
}

async function startProxy(target, hooks) {
  const lounge = { conversation: null };
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://proxy');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && url.pathname === '/api/lounge/utterance/stream' && hooks.mode === 'lounge') {
      const request = JSON.parse(body.toString('utf8'));
      const conversation = lounge.conversation;
      if (!conversation || request.id !== conversation.id) throw new Error('lounge fixture: utterance for an unknown conversation');
      const index = conversation.cursor.next_speaker_index;
      const speaker = conversation.next_speaker;
      const content = loungeLine(speaker, index);
      const nextIndex = index + 1;
      const next = {
        ...conversation,
        messages: [...conversation.messages, { role: 'assistant', character_id: speaker.character_id, character_name: speaker.character_name, content, expression: 'joy', face_emotion_variant_id: 'joy' }],
        cursor: { round_number: conversation.cursor.round_number, next_speaker_index: nextIndex },
        // The next NPC is the first participant (character_id order) who has not spoken yet.
        next_speaker: [...conversation.participants].sort((a, b) => a.character_id.localeCompare(b.character_id)).find((participant) => participant.character_id !== speaker.character_id
          && !conversation.messages.some((message) => message.character_id === participant.character_id)) ?? null
      };
      lounge.conversation = next;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('assistant_emotion', { expression: 'joy', face_emotion_variant_id: 'joy' });
      send('assistant_delta', { delta: content });
      send('assistant_complete', { content });
      send('result', { conversation: next });
      res.end();
      return;
    }
    const overlookEnter = req.method === 'POST' && url.pathname === '/api/overlook/enter';
    const upstreamPath = overlookEnter ? `${url.pathname}?provider=mock` : `${url.pathname}${url.search}`;
    const upstream = httpRequest({ host: '127.0.0.1', port: target.port, method: req.method, path: upstreamPath, headers: { ...req.headers, host: `127.0.0.1:${target.port}` } }, async (answer) => {
      if (overlookEnter || (req.method === 'POST' && url.pathname === '/api/lounge/enter')) {
        const parts = [];
        for await (const part of answer) parts.push(part);
        const text = Buffer.concat(parts);
        if (overlookEnter) {
          await sleep(ENTER_HOLD_MS);
          if (answer.statusCode === 200) await hooks.onOverlookEntered();
          res.writeHead(answer.statusCode, answer.headers);
          res.end(text);
          return;
        }
        if (answer.statusCode !== 200) throw new Error(`lounge fixture: enter answered ${answer.statusCode}`);
        const entered = JSON.parse(text.toString('utf8'));
        const [first] = [...entered.conversation.participants].sort((a, b) => a.character_id.localeCompare(b.character_id));
        entered.conversation.next_speaker = first;
        lounge.conversation = entered.conversation;
        const rewritten = Buffer.from(JSON.stringify(entered));
        res.writeHead(200, { ...answer.headers, 'content-length': String(rewritten.length) });
        res.end(rewritten);
        return;
      }
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => { res.writeHead(502); res.end(String(error)); });
    upstream.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// ── page helpers ─────────────────────────────────────────────────────────────────────────────────────────────
async function js(win, source) {
  return win.webContents.executeJavaScript(source);
}

async function waitFor(win, predicate, { tries = 300, intervalMs = POLL_MS } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await js(win, `(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const STATE = `(document.querySelector('#academy-overlook-screen')?.dataset.state ?? null)`;
const ACTIVE_SCREEN = `(document.querySelector('.screen.active')?.id ?? null)`;

async function waitForState(win, state, options) {
  const ok = await waitFor(win, `${STATE} === ${JSON.stringify(state)}`, options);
  const seen = await js(win, `({ state: ${STATE}, screen: ${ACTIVE_SCREEN} })`);
  check(`overlook state ${state}`, ok, seen);
}

// Read talks out until the field (or a hover on it) is back: 次へ is clicked only when enabled (a click during generation or the
// line's reveal is ignored by the page), and a return that hands the camera to the next focus keeps reading.
async function readTalksToField(win, { deadlineMs = 90000 } = {}) {
  const until = realNow() + deadlineMs;
  const seen = [];
  // The pointer that picked a pair would hover that coma again on the way back.
  mouse(win, 'mouseMove', 5, 500);
  while (realNow() < until) {
    const state = await js(win, STATE);
    if (seen.at(-1) !== state) seen.push(state);
    if (['field', 'say', 'lines', 'pair'].includes(state)) return true;
    if (state === 'talk' || state === 'talk-closed') {
      await js(win, `(() => { const el = document.querySelector('#academy-overlook-next'); if (el && !el.disabled) el.click(); })()`);
    }
    await sleep(400);
  }
  log('readTalksToField timed out', { seen, page: await js(win, `({ next: document.querySelector('#academy-overlook-next')?.disabled ?? null, label: document.querySelector('#academy-overlook-next')?.textContent ?? null, rows: document.querySelectorAll('#academy-overlook-message-stream .character-message').length })`) });
  return false;
}

async function click(win, selector) {
  const ok = await js(win, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
  check(`click ${selector}`, ok);
}

function mouse(win, type, x, y, extra = {}) {
  win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
}

async function pointerClick(win, point) {
  mouse(win, 'mouseMove', point.x, point.y);
  await sleep(30);
  mouse(win, 'mouseDown', point.x, point.y, { button: 'left', clickCount: 1 });
  await sleep(30);
  mouse(win, 'mouseUp', point.x, point.y, { button: 'left', clickCount: 1 });
  await sleep(60);
}

async function drag(win, from, to) {
  mouse(win, 'mouseMove', from.x, from.y);
  mouse(win, 'mouseDown', from.x, from.y, { button: 'left', clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    mouse(win, 'mouseMove', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { button: 'left' });
    await sleep(16);
  }
  mouse(win, 'mouseUp', to.x, to.y, { button: 'left', clickCount: 1 });
  await sleep(150);
}

// The field as the page draws it: the world transform (camera + scale), each coma's screen centre, the parts.
const FIELD_VIEW = `(() => {
  const world = document.querySelector('#academy-overlook-world');
  const m = new DOMMatrix(getComputedStyle(world).transform);
  const origin = document.querySelector('#academy-overlook-screen').getBoundingClientRect();
  const comas = [...document.querySelectorAll('.academy-overlook-coma')].map((node) => {
    const t = new DOMMatrix(getComputedStyle(node).transform);
    return { id: node.dataset.characterId, x: m.a * t.e + m.e, y: m.d * t.f + m.f };
  });
  const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top }; };
  const roster = document.querySelector('#academy-overlook-roster');
  const parts = [rect('#academy-overlook-topbar'), rect('#academy-overlook-roster-button'), rect('#academy-overlook-exit'), ...(roster.hidden ? [] : [rect('#academy-overlook-roster')])];
  return { scale: m.a, camera: { x: -m.e / m.a, y: -m.f / m.a }, comas, parts };
})()`;

// The roster list and the two buttons as the page lays them out (screen px), and each row's face / name / button.
const ROSTER_VIEW = `(() => {
  const origin = document.querySelector('#academy-overlook-screen').getBoundingClientRect();
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top }; };
  const list = document.querySelector('#academy-overlook-roster');
  return {
    open: !list.hidden,
    expanded: document.querySelector('#academy-overlook-roster-button').getAttribute('aria-expanded'),
    screen: { width: origin.width, height: origin.height },
    button: rect(document.querySelector('#academy-overlook-roster-button')),
    exit: rect(document.querySelector('#academy-overlook-exit')),
    list: list.hidden ? null : rect(list),
    background: getComputedStyle(list).backgroundColor,
    bgToken: getComputedStyle(document.querySelector('#academy-overlook-screen')).getPropertyValue('--cd-night-bg-1').trim(),
    scrollTop: list.scrollTop,
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    rows: [...list.children].map((row) => ({
      id: row.dataset.characterId,
      rect: rect(row),
      face: rect(row.querySelector('.academy-overlook-roster-face')),
      name: row.querySelector('.academy-overlook-roster-name').textContent,
      send: rect(row.querySelector('.academy-overlook-roster-send')),
      sendDisabled: row.querySelector('.academy-overlook-roster-send').disabled
    }))
  };
})()`;

function near(a, b, tolerance = 1) {
  return Math.abs(a - b) <= tolerance;
}

function hexToRgb(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`not a #rrggbb color: ${hex}`);
  return `rgb(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)})`;
}

function hoverable(point, parts) {
  if (point.x < 0 || point.y < 0 || point.x > VIEWPORT.width || point.y > VIEWPORT.height) return false;
  return parts.every((part) => {
    const dx = Math.max(part.left - point.x, 0, point.x - part.right);
    const dy = Math.max(part.top - point.y, 0, point.y - part.bottom);
    return Math.hypot(dx, dy) - 28 >= 6;
  });
}

// Drag the camera so a map point lands near the screen centre (the map edge may stop it).
async function bringIntoView(win, mapPoint) {
  const view = await js(win, FIELD_VIEW);
  const screen = { x: mapPoint.x - view.camera.x, y: mapPoint.y - view.camera.y };
  const dx = VIEWPORT.width / 2 - screen.x;
  const dy = VIEWPORT.height / 2 - screen.y;
  if (Math.abs(dx) < 80 && Math.abs(dy) < 80) return;
  // Start the drag on bare map near the centre, away from the parts.
  const start = { x: VIEWPORT.width / 2 - Math.sign(dx) * 200, y: VIEWPORT.height / 2 - Math.sign(dy) * 150 };
  await drag(win, start, { x: start.x + dx, y: start.y + dy });
}

async function shoot(win, outDir, name, { settleMs = 300 } = {}) {
  await sleep(settleMs);
  // Captured at the machine's device pixel ratio, stored at the window's CSS px size (1440×960 like the composition's
  // images, except the 760 px high roster shots).
  const [width, height] = win.getContentSize();
  const image = (await win.webContents.capturePage()).resize({ width, height, quality: 'best' });
  const file = path.join(outDir, `${name}.png`);
  await fs.writeFile(file, image.toPNG());
  const size = image.getSize();
  log('screenshot', { file: path.basename(file), width: size.width, height: size.height });
  return path.basename(file);
}

// Every element that must be visible for a capture: inside the viewport and not covered at its centre.
async function assertVisible(win, name, selectors) {
  const measured = await js(win, `((selectors) => selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, found: false };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { selector, found: true, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], inside: r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, covered: !(hit && (hit === el || el.contains(hit) || getComputedStyle(el).pointerEvents === 'none')) };
  }))(${JSON.stringify(selectors)})`);
  const bad = measured.filter((entry) => !entry.found || !entry.inside || entry.covered);
  check(`${name}: visible`, bad.length === 0, { bad });
  return measured;
}

function gitHead(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function readRuntimeState(fixture) {
  const [slotRoot] = await findFile(fixture, 'game_data/overlook/roster.json');
  if (!slotRoot) throw new Error('overlook fixture: no routing slot found');
  return JSON.parse(await fs.readFile(path.join(slotRoot, 'game_data/runtime_state.json'), 'utf8'));
}

async function findFile(dir, relative) {
  const found = [];
  const walk = async (current, depth) => {
    if (depth > 6) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (await fs.stat(path.join(full, relative)).then(() => true, () => false)) found.push(full);
        await walk(full, depth + 1);
      }
    }
  };
  await walk(dir, 0);
  return found;
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let gameServer;
let lmStub;
let proxy;
let root;
let exitCode = 0;

async function main() {
  const { repoRoot, outDir, mode } = parseArgs(process.argv.slice(2));
  const startedAt = realNow();
  const { createServer } = await import(path.join(repoRoot, 'app/src/server.mjs'));
  const { fixtureRoot } = await import(path.join(repoRoot, 'app/tests/helpers.mjs'));
  const { runtimePathsManifestFilename } = await import(path.join(repoRoot, 'app/src/runtimePaths.mjs'));
  const overlookModule = mode === 'overlook' ? await import(path.join(repoRoot, 'app/src/routingOverlook.mjs')) : null;
  const lmClient = await import(path.join(repoRoot, 'app/src/llm/lmStudioClient.mjs'));
  await fs.mkdir(outDir, { recursive: true });

  root = await fixtureRoot('overlook-render-');
  await fs.copyFile(path.join(repoRoot, 'data/definitions/game_data/overlook_field.json'), path.join(root, 'game_data/overlook_field.json'));
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(repoRoot, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    publicRoot: path.join(repoRoot, 'app/public'),
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  const playModeSettingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(playModeSettingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');

  const stubState = { judgments: 0, hubReplies: 0, destination: mode === 'overlook' ? 'overlook' : 'lounge', firstTurnUndecided: mode === 'overlook' };
  lmStub = await startLmStub(stubState);
  gameServer = createServer({
    root,
    publicRoot: path.join(repoRoot, 'app/public'),
    canonicalAssetsRoot: path.join(repoRoot, 'assets/canonical'),
    playModeSettingsPath,
    lmStudioConfig: { base_url: lmStub.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 15000, stream: false },
    lmStudioConfigPath: path.join(root, 'app/config/lmstudio.json')
  });
  await new Promise((resolve) => gameServer.listen(0, '127.0.0.1', resolve));

  // The live overlook session's generator wrappers (see the header).
  const seam = { session: null, line: { preMs: 0, chunkMs: 0, chunks: 1 }, holdOffscreen: false, releaseOffscreen: [], failNext: false, failPort: await closedLoopbackPort() };
  const wrapSession = async () => {
    const [slotRoot] = await findFile(root, 'game_data/overlook/roster.json');
    if (!slotRoot) throw new Error('overlook fixture: no slot holds game_data/overlook/roster.json after enter');
    const session = overlookModule.requireOverlookSession(slotRoot);
    const mock = session.generators;
    const failThroughTransport = () => lmClient.callLmStudioChat({
      config: lmClient.normalizeLmStudioConfig({ base_url: `http://127.0.0.1:${seam.failPort}/v1`, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 2000, stream: false }),
      prompt: 'overlook harness: the LM is unreachable'
    });
    session.generators = {
      ...mock,
      generateUtterance: async (input) => {
        const { preMs, chunkMs, chunks } = seam.line;
        await sleep(preMs);
        const result = await mock.generateUtterance({ ...input, onDelta: null });
        const size = Math.ceil(result.content.length / chunks);
        for (let i = 0; i < result.content.length; i += size) {
          input.onDelta?.(result.content.slice(i, i + size));
          await sleep(chunkMs);
        }
        return result;
      },
      resolveOffscreen: async (input) => {
        if (seam.holdOffscreen) await new Promise((resolve) => seam.releaseOffscreen.push(resolve));
        return mock.resolveOffscreen(input);
      },
      decideWish: async (input) => {
        if (seam.failNext) {
          seam.failNext = false;
          await failThroughTransport();
        }
        return mock.decideWish(input);
      }
    };
    seam.session = session;
    seam.fieldView = () => overlookModule.overlookFieldView(session);
  };
  proxy = await startProxy(gameServer.address(), {
    mode,
    onOverlookEntered: async () => {
      freezeClock();
      await wrapSession();
    }
  });
  log('server', { proxy: proxy.base, head: gitHead(repoRoot), mode });

  await app.whenReady();
  const win = new BrowserWindow({ width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log(`renderer-console[${level}]: ${message}`); });
  await win.loadURL(`${proxy.base}/`);
  await sleep(1200);
  const size = await js(win, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
  check('viewport 1440×960', size.w === VIEWPORT.width && size.h === VIEWPORT.height, size);
  log('device pixel ratio', size.dpr);

  const captures = {};
  async function capture(key, selectors, note = {}) {
    const visibility = await assertVisible(win, key, selectors);
    const file = await shoot(win, outDir, key);
    captures[key] = { file, state: await js(win, STATE), screen: await js(win, ACTIVE_SCREEN), visibility, ...note };
  }

  // New game (routing) → the hub opening.
  check('title start button', await waitFor(win, `document.querySelector('#start-new-game')`));
  await click(win, '#start-new-game');
  const hubReady = `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`;
  check('hub opening ready', await waitFor(win, `${hubReady} && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0`));

  async function hubSend(text) {
    let sent = false;
    for (let attempt = 0; attempt < 20 && !sent; attempt += 1) {
      await waitFor(win, hubReady, { tries: 100 });
      const fired = await js(win, `(() => { const input = document.querySelector('#routing-hub-input'); const send = document.querySelector('#routing-hub-send'); if (!input || !send || send.disabled) return false; input.value = ${JSON.stringify(text)}; send.click(); return true; })()`);
      sent = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 20 });
      if (!sent) await sleep(400);
    }
    check(`hub turn sent: ${text}`, sent);
  }

  if (mode === 'lounge') {
    await hubSend(HUB_DECIDE_LOUNGE);
    check('lounge first round revealed, the player turn open', await waitFor(win, `
      document.querySelector('#academy-lounge-screen')?.classList.contains('active')
      && document.querySelectorAll('#academy-lounge-message-stream .chat-message').length >= 3
      && !document.querySelector('#academy-lounge-input').disabled`, { tries: 400 }));
    await sleep(1500);
    await js(win, `document.querySelector('#academy-lounge-motes').style.visibility = 'hidden'`);
    await capture('lounge-arrival', ['#academy-lounge-message-stream', '#academy-lounge-input', '#academy-lounge-send', '#academy-lounge-end', '#academy-lounge-stage-image']);
    await finish({ outDir, mode, repoRoot, captures, startedAt });
    return;
  }

  // ── entry A: 1 → 2 → 6 → 6b → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 16 ─────────────────────────────────────
  await hubSend(HUB_WISH);
  check('hub reply names 星見の窓', await waitFor(win, `${hubReady} && document.querySelector('#routing-hub-message-stream').textContent.includes('星見の窓')`));
  await sleep(800);
  await capture('01-hub-candidates', ['#routing-hub-message-stream', '#routing-hub-input']);

  const weekBefore = await readRuntimeState(root);
  await hubSend(HUB_DECIDE);
  check('entry cover shows the overlook copy', await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active') && document.querySelector('#academy-loading-title')?.textContent === '星見の窓へ移動中'`, { tries: 300, intervalMs: 50 }));
  await sleep(1000);
  await js(win, `document.querySelectorAll('#academy-loading-screen *').forEach((el) => el.getAnimations().forEach((a) => a.pause()))`);
  const coverCopy = await js(win, `({ title: document.querySelector('#academy-loading-title').textContent, status: document.querySelector('#academy-loading-status').textContent })`);
  check('entry cover copy', coverCopy.title === '星見の窓へ移動中' && coverCopy.status === '学院の朝の鐘を待っています。', coverCopy);
  await capture('02-entry-cover', ['#academy-loading-title', '#academy-loading-status']);
  await js(win, `document.querySelectorAll('#academy-loading-screen *').forEach((el) => el.getAnimations().forEach((a) => a.play()))`);
  await waitForState(win, 'field', { tries: 200 });
  check('the overlook screen is active', await js(win, `document.querySelector('#academy-overlook-screen').classList.contains('active')`));
  const weekAfter = await readRuntimeState(root);
  check('entering advanced the week by one', weekAfter.elapsed_weeks === weekBefore.elapsed_weeks + 1 && seam.fieldView().week === weekAfter.elapsed_weeks, { before: weekBefore.elapsed_weeks, after: weekAfter.elapsed_weeks, field_week: seam.fieldView().week });
  const enterView = await js(win, FIELD_VIEW);
  const fountain = seam.session.graph.places.find((place) => place.location_id === 'courtyard_fountain');
  const centre = { x: enterView.camera.x + VIEWPORT.width / 2, y: enterView.camera.y + VIEWPORT.height / 2 };
  check('entry camera: the fountain at the screen centre', Math.abs(centre.x - fountain.x) < 1 && Math.abs(centre.y - fountain.y) < 1, { centre, fountain: { x: fountain.x, y: fountain.y } });

  // A holdable page clock for the mid-move shot of 状態 6: hold() freezes performance.now, release() resumes it from
  // the held instant, so every time the page measures stays continuous.
  await js(win, `(() => {
    const real = performance.now.bind(performance);
    let heldAt = null;
    let lost = 0;
    performance.now = () => heldAt ?? real() - lost;
    window.__overlookRenderClock = {
      hold() { heldAt = real() - lost; return true; },
      release() { lost = real() - heldAt; heldAt = null; }
    };
  })()`);
  // Let the academy run until it chooses a focus; the first line waits 5 s so the move (1.1 s, plus the held
  // clock of the mid-move shot) ends before it starts.
  seam.line = { preMs: 5000, chunkMs: 250, chunks: 4 };
  let focusSeen = false;
  for (let i = 0; i < 600 && !focusSeen; i += 1) {
    advanceClock(200);
    await sleep(60);
    focusSeen = await js(win, `${STATE} === 'focusing'`);
  }
  check('the academy chose a focus (状態 6)', focusSeen, { academy_time: seam.fieldView().clock.academy_time });
  // The move is 1.1 s long: stop the page's clock at the image's scale 1.6 (the harness's performance.now seam),
  // shoot the held frame, then let the clock run on from where it stopped.
  const SCALE = `new DOMMatrix(getComputedStyle(document.querySelector('#academy-overlook-world')).transform).a`;
  check('the move is zooming in', await waitFor(win, `${STATE} === 'focusing' && ${SCALE} >= 1.6 && window.__overlookRenderClock.hold()`, { tries: 300, intervalMs: 2 }));
  await sleep(200);
  const zoomHeld = await js(win, `({ state: ${STATE}, scale: ${SCALE}, dim: document.querySelector('.academy-overlook-vignette').style.opacity, topbar: getComputedStyle(document.querySelector('#academy-overlook-topbar')).opacity, exit: getComputedStyle(document.querySelector('#academy-overlook-exit')).opacity, roster_button: getComputedStyle(document.querySelector('#academy-overlook-roster-button')).opacity })`);
  const zoomFile = await shoot(win, outDir, '06-focus-move', { settleMs: 0 });
  await js(win, 'window.__overlookRenderClock.release()');
  check('状態 6: held mid-move, the rim darkening, bar, 顔ぶれ and exit gone', zoomHeld.state === 'focusing' && zoomHeld.scale > 1 && zoomHeld.scale < 1.8 && Number(zoomHeld.dim) > 0 && zoomHeld.topbar === '0' && zoomHeld.exit === '0' && zoomHeld.roster_button === '0', zoomHeld);
  captures['06-focus-move'] = { file: zoomFile, state: 'focusing', held: zoomHeld };
  await waitForState(win, 'awaiting-first-line', { tries: 60 });
  check('focus-wait cover copy', await waitFor(win, `document.querySelector('#academy-loading-screen').classList.contains('active') && /のもとへ$/.test(document.querySelector('#academy-loading-title').textContent) && document.querySelector('#academy-loading-status').textContent === '二人の最初の言葉を待っています。'`, { tries: 40 }));
  await sleep(700);
  await js(win, `document.querySelectorAll('#academy-loading-screen *').forEach((el) => el.getAnimations().forEach((a) => a.pause()))`);
  await capture('06b-focus-wait-cover', ['#academy-loading-title', '#academy-loading-status']);
  await js(win, `document.querySelectorAll('#academy-loading-screen *').forEach((el) => el.getAnimations().forEach((a) => a.play()))`);

  // 7: the first line has streamed in; the next is generated ahead while it shows.
  seam.line = { preMs: 0, chunkMs: 0, chunks: 1 };
  check('talk shows the first line', await waitFor(win, `${STATE} === 'talk' && document.querySelectorAll('#academy-overlook-message-stream .character-message').length >= 1`, { tries: 200 }));
  await sleep(800);
  const talkDom = await js(win, `({ seed: document.querySelector('#academy-overlook-message-stream .chat-message')?.className, rows: document.querySelectorAll('#academy-overlook-message-stream .chat-message').length, buttons: [...document.querySelectorAll('#academy-overlook-talk .conversation-day-button-row button')].map((b) => b.textContent), input: document.querySelectorAll('#academy-overlook-talk textarea, #academy-overlook-talk input').length, stage: getComputedStyle(document.querySelector('#academy-overlook-stage-image')).backgroundImage })`);
  check('talk face (0.7): seed line first, no input, one 次へ, window stage', talkDom.seed.includes('narration-message') && talkDom.input === 0 && JSON.stringify(talkDom.buttons) === JSON.stringify(['次へ']) && talkDom.stage.includes('stage_window.jpg'), talkDom);
  await capture('07-talk', ['#academy-overlook-message-stream', '#academy-overlook-next', '#academy-overlook-stage-image']);

  // 8: the next line is slow (streams after 2.5 s in 6 chunks) → 次へ shows it generating.
  seam.line = { preMs: 2500, chunkMs: 300, chunks: 6 };
  // The line after the first was already generated ahead with no delay; show it, then click again into a slow one.
  await click(win, '#academy-overlook-next');
  check('the ahead-generated line shows at once (7 → 7)', await waitFor(win, `${STATE} === 'talk' && document.querySelectorAll('#academy-overlook-message-stream .character-message').length >= 2`, { tries: 100 }));
  await sleep(1200);
  await click(win, '#academy-overlook-next');
  check('状態 8: generating, 次へ disabled, a streamed row in', await waitFor(win, `${STATE} === 'talk-generating' && document.querySelector('#academy-overlook-next').disabled && document.querySelectorAll('#academy-overlook-message-stream .character-message').length >= 3`, { tries: 100 }));
  await capture('08-talk-generating', ['#academy-overlook-message-stream', '#academy-overlook-next']);
  seam.line = { preMs: 0, chunkMs: 0, chunks: 1 };
  check('the slow line completes', await waitFor(win, `${STATE} === 'talk' || ${STATE} === 'talk-closed'`, { tries: 200 }));

  // 9: read on until the outcome closes the talk.
  for (let i = 0; i < 20 && (await js(win, STATE)) !== 'talk-closed'; i += 1) {
    await waitFor(win, `${STATE} === 'talk' || ${STATE} === 'talk-closed'`, { tries: 100 });
    if ((await js(win, STATE)) === 'talk') await js(win, `document.querySelector('#academy-overlook-next').click()`);
    await sleep(900);
  }
  await waitForState(win, 'talk-closed', { tries: 100 });
  await sleep(800);
  check('closed talk: the button reads フィールドへ戻る', (await js(win, `document.querySelector('#academy-overlook-next').textContent`)) === 'フィールドへ戻る');
  await capture('09-talk-closed', ['#academy-overlook-message-stream', '#academy-overlook-next']);

  // 10: back to the field on the talk's place; unwatched meetings have left traces.
  await click(win, '#academy-overlook-next');
  await waitForState(win, 'returning', { tries: 50 });
  await waitForState(win, 'field', { tries: 100 });
  await sleep(600);
  const traces = seam.fieldView().traces;
  log('traces after return', traces.map((trace) => `${trace.academy_time} ${trace.text}`));
  // Bring a trace into view if none is on screen.
  const traceOnScreen = await js(win, `[...document.querySelectorAll('.academy-overlook-mark-label')].some((el) => { const r = el.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; })`);
  if (!traceOnScreen && traces.length) {
    await bringIntoView(win, traces[0]);
    await sleep(500);
  }
  check('trace labels on the field', await js(win, `document.querySelectorAll('.academy-overlook-mark-label[data-kind="trace"]').length`) > 0, { traces: traces.length });
  await capture('10-field-traces', ['#academy-overlook-topbar', '#academy-overlook-roster-button', '#academy-overlook-exit']);

  // 11 → 12 → 13: write at a place on screen, then try a second place within the hour.
  const places = await (async () => {
    const answer = seam.session.graph.places.map((place) => ({ id: place.location_id, x: place.x, y: place.y }));
    return answer;
  })();
  const onScreenPlace = async (exclude = null) => {
    const view = await js(win, FIELD_VIEW);
    return places.map((place) => ({ ...place, sx: place.x - view.camera.x, sy: place.y - view.camera.y }))
      .find((place) => place.id !== exclude && place.sx > 220 && place.sx < VIEWPORT.width - 220 && place.sy > 200 && place.sy < VIEWPORT.height - 120
        && view.comas.every((coma) => Math.hypot(coma.x - place.sx, coma.y - place.sy) > 40)) ?? null;
  };
  let writePlace = await onScreenPlace();
  if (!writePlace) {
    await bringIntoView(win, places.find((place) => place.id === 'herbology_garden'));
    writePlace = await onScreenPlace();
  }
  check('a place to write at is on screen', writePlace !== null);
  await pointerClick(win, { x: writePlace.sx, y: writePlace.sy });
  await waitForState(win, 'writing', { tries: 30 });
  check('the input has the caret, no placeholder', await js(win, `document.activeElement === document.querySelector('#academy-overlook-writing-input') && document.querySelector('#academy-overlook-writing-input').placeholder === ''`));
  await js(win, `(() => { const input = document.querySelector('#academy-overlook-writing-input'); input.value = ${JSON.stringify(WRITING_TEXT)}; input.dispatchEvent(new Event('input')); })()`);
  await sleep(200);
  await capture('11-writing', ['#academy-overlook-writing', '#academy-overlook-writing-input', '#academy-overlook-writing-submit', '.academy-overlook-place-ring']);
  await click(win, '#academy-overlook-writing-submit');
  await waitForState(win, 'field', { tries: 50 });
  check('the writing mark is on the map', await waitFor(win, `document.querySelectorAll('.academy-overlook-mark-label[data-kind="writing"]').length === 1`, { tries: 30 }));
  await sleep(500);
  await capture('12-writing-mark', ['.academy-overlook-mark-label[data-kind="writing"]']);
  const limitedPlace = await onScreenPlace(writePlace.id);
  check('a second place is on screen', limitedPlace !== null);
  await pointerClick(win, { x: limitedPlace.sx, y: limitedPlace.sy });
  await waitForState(win, 'writing-limited', { tries: 30 });
  const limitedDom = await js(win, `({ input: document.querySelector('#academy-overlook-writing-input').disabled, submit: document.querySelector('#academy-overlook-writing-submit').disabled, status: document.querySelector('#academy-overlook-writing-status').textContent })`);
  check('状態 13: input and button dead, the next time named', limitedDom.input && limitedDom.submit && /^次の書き込みは \d{1,2}:\d{2} から$/.test(limitedDom.status), limitedDom);
  await capture('13-writing-limited', ['#academy-overlook-writing', '#academy-overlook-writing-status']);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await waitForState(win, 'field', { tries: 30 });

  // 14: hold the unwatched resolutions so a meeting stays pending, and step until one is pickable with no focus.
  seam.holdOffscreen = true;
  let pair = null;
  for (let i = 0; i < 1500 && !pair; i += 1) {
    advanceClock(120);
    const view = seam.fieldView();
    if (view.focus) {
      // The academy took a pending one: the page moves to it, then read the talk out and come back.
      const moved = await waitFor(win, `${STATE} !== 'field'`, { tries: 100 });
      if (!moved) {
        const pageField = await js(win, `fetch('/api/overlook/field').then((r) => r.json()).then((j) => ({ focus: j.field.focus, tick: j.field.clock.tick }))`);
        log('focus not taken by the page', { server_focus: view.focus, server_tick: view.clock.tick, page_get: pageField, state: await js(win, STATE) });
      }
      check('the page moves to the academy-chosen focus', moved);
      check('an academy-chosen talk reads out to the field', await readTalksToField(win));
      continue;
    }
    pair = view.encounters.find((encounter) => encounter.pickable) ?? null;
    await sleep(20);
  }
  check('a meeting pair is pickable with no focus', pair !== null);
  await sleep(600);
  const pairChildren = seam.fieldView().children.filter((entry) => pair.participants.some((participant) => participant.character_id === entry.character_id));
  await bringIntoView(win, { x: (pairChildren[0].x + pairChildren[1].x) / 2, y: (pairChildren[0].y + pairChildren[1].y) / 2 });
  await sleep(700);
  const pairView = await js(win, FIELD_VIEW);
  const pairComa = pairView.comas.find((coma) => coma.id === pair.participants[0].character_id);
  log('pair to hover', { pair, pairComa, parts: pairView.parts, scale: pairView.scale, server_encounter: seam.fieldView().encounters.find((entry) => entry.encounter_id === pair.encounter_id) ?? null, focus: seam.fieldView().focus });
  mouse(win, 'mouseMove', pairComa.x, pairComa.y);
  await waitForState(win, 'pair', { tries: 30 });
  await sleep(400);
  await capture('14-pair', ['.academy-overlook-pair-ring', '.academy-overlook-label[data-kind="say"]']);
  await pointerClick(win, pairComa);
  await waitForState(win, 'focusing', { tries: 30 });
  check('the picked pair is the focus', seam.fieldView().focus?.encounter_id === pair.encounter_id && seam.fieldView().focus.source === 'picked');
  await waitFor(win, `${STATE} === 'talk' || ${STATE} === 'talk-closed'`, { tries: 200 });
  seam.holdOffscreen = false;
  for (const release of seam.releaseOffscreen.splice(0)) release();
  check('the picked talk reads out to the field', await readTalksToField(win));

  // 16: the exit button → the loading cover → the hub greets with the result.
  mouse(win, 'mouseMove', 5, 500);
  await sleep(300);
  const requestsBeforeExit = lmStub.requests.length;
  await click(win, '#academy-overlook-exit');
  check('back at the hub', await waitFor(win, `${hubReady} && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0`, { tries: 300 }));
  const hubState = await readRuntimeState(root);
  check('the exit wrote the overlook content result', hubState.last_routing_content_result?.kind === 'overlook', { kind: hubState.last_routing_content_result?.kind ?? null, watched: hubState.last_routing_content_result?.detail?.watched_conversations?.length ?? null });
  const greetingResultLine = lmStub.requests.slice(requestsBeforeExit).find((request) => request.overlookResultLine)?.overlookResultLine ?? null;
  check('the hub greeting is asked with the overlook result', greetingResultLine !== null, { line: greetingResultLine });
  await sleep(800);
  await capture('16-hub-return', ['#routing-hub-message-stream'], { greeting_result_line: greetingResultLine });

  // ── entry B: 3 → 4 → 5 (children carry feelings now), then 15:00 → the hub ─────────────────────────────────
  clock.frozenAt = null;
  await hubSend(HUB_DECIDE);
  await waitForState(win, 'field', { tries: 300 });
  await sleep(800);
  const enterViewB = await js(win, FIELD_VIEW);
  const centreB = { x: enterViewB.camera.x + VIEWPORT.width / 2, y: enterViewB.camera.y + VIEWPORT.height / 2 };
  check('entry B camera: the fountain at the screen centre', Math.abs(centreB.x - fountain.x) < 1 && Math.abs(centreB.y - fountain.y) < 1, { centre: centreB, fountain: { x: fountain.x, y: fountain.y } });
  // The clock stays where the entry froze it, so no new meeting takes the camera away from 3 → 4 → 5.
  check('entry B: at the field', await readTalksToField(win));
  const comasOnScreen = (await js(win, FIELD_VIEW)).comas.filter((coma) => coma.x > 0 && coma.x < VIEWPORT.width && coma.y > 0 && coma.y < VIEWPORT.height).length;
  check('comas on screen at the entry camera', comasOnScreen > 0, { comasOnScreen });
  await capture('03-field', ['#academy-overlook-topbar', '#academy-overlook-roster-button', '#academy-overlook-exit'], { academy_time: seam.fieldView().clock.academy_time, comasOnScreen });

  // 17: the same moment — the 「顔ぶれ」 button left of the exit, 10 px apart, bottoms aligned.
  const buttons = await js(win, ROSTER_VIEW);
  check('状態 17: 顔ぶれ 10 px left of the exit, bottoms aligned, exit 24 px / 22 px from the corner', near(buttons.exit.left - buttons.button.right, 10, 0.5) && near(buttons.button.bottom, buttons.exit.bottom, 0.5)
    && near(buttons.exit.right, 1416, 0.5) && near(buttons.exit.bottom, 938, 0.5) && near(buttons.button.top, buttons.exit.top, 0.5) && !buttons.open,
  { button: buttons.button, exit: buttons.exit, image_button: [1189, 901, 1269, 938], image_exit: [1279, 901, 1416, 938] });
  await capture('17-roster-button', ['#academy-overlook-roster-button', '#academy-overlook-exit'], { button: buttons.button, exit: buttons.exit });

  // 18: the list opens over the field — 12 rows in the roster's order, opaque, above the button.
  await click(win, '#academy-overlook-roster-button');
  await sleep(200);
  const list = await js(win, ROSTER_VIEW);
  const serverRoster = seam.fieldView().roster;
  check('状態 18: the frame at (1024, 248, 1416, 890) — right on the exit\'s right, 10 px above 顔ぶれ', list.open && list.expanded === 'true'
    && near(list.list.left, 1024) && near(list.list.top, 248) && near(list.list.right, list.exit.right, 0.5) && near(list.list.bottom, list.button.top - 10, 0.5) && near(list.list.bottom, 890, 1), { list: list.list, button: list.button });
  check('状態 18: 12 rows in the roster order, row 1 at (1035, 259, 1405, 307), 48 px apart by 4 px, 40 px faces',
    list.rows.length === 12 && JSON.stringify(list.rows.map((row) => row.id)) === JSON.stringify(serverRoster.map((row) => row.character_id))
    && JSON.stringify(list.rows.map((row) => row.name)) === JSON.stringify(serverRoster.map((row) => row.character_name))
    && near(list.rows[0].rect.left, 1035) && near(list.rows[0].rect.top, 259) && near(list.rows[0].rect.right, 1405) && near(list.rows[0].rect.bottom, 307)
    && list.rows.every((row, index) => near(row.rect.top - list.rows[0].rect.top, index * 52, 0.5) && near(row.face.right - row.face.left, 40, 0.1) && near(row.face.bottom - row.face.top, 40, 0.1))
    && list.rows.every((row) => !row.sendDisabled),
  { rows: list.rows.map((row) => ({ name: row.name, rect: row.rect })) });
  const send = list.rows[0].send;
  check('状態 18: 送り出す at the row\'s right end, the image\'s size (82×31 at (1315, 268, 1396, 298))', near(send.right, 1397, 1) && near(send.right - send.left, 82, 1.5) && near(send.bottom - send.top, 31, 1.5) && near((send.top + send.bottom) / 2, 283.5, 1), { send });
  check('状態 18: the frame is painted --cd-night-bg-1 (not see-through), opened at row 1', list.background === hexToRgb(list.bgToken) && list.scrollTop === 0, { background: list.background, token: list.bgToken });
  await capture('18-roster-list', ['#academy-overlook-roster', '#academy-overlook-roster-button', '#academy-overlook-exit'], { list: list.list, rows: list.rows.map((row) => row.name) });

  // 18: the field goes on under the open list — a coma outside it takes a hover; one under it belongs to the list.
  const openView = await js(win, FIELD_VIEW);
  const outside = openView.comas.find((coma) => hoverable(coma, openView.parts) && seam.fieldView().children.find((entry) => entry.character_id === coma.id)?.wish_line);
  if (outside) {
    mouse(win, 'mouseMove', outside.x, outside.y);
    check('状態 18: a coma outside the list takes the hover', await waitFor(win, `${STATE} === 'say' || ${STATE} === 'pair'`, { tries: 30, intervalMs: 50 }), { coma: outside.id });
    check('状態 18: the list stays open through the hover', (await js(win, ROSTER_VIEW)).open);
    mouse(win, 'mouseMove', 5, 500);
    await waitForState(win, 'field', { tries: 30 });
  } else {
    log('状態 18: no hoverable coma with a wish outside the list at this moment', { comas: openView.comas.length });
  }
  const under = openView.comas.find((coma) => coma.x > list.list.left && coma.x < list.list.right && coma.y > list.list.top && coma.y < list.list.bottom);
  if (under) {
    mouse(win, 'mouseMove', under.x, under.y);
    await sleep(600);
    check('状態 18: a coma under the list takes no hover', (await js(win, STATE)) === 'field', { coma: under.id });
    mouse(win, 'mouseMove', 5, 500);
  } else {
    log('状態 18: no coma under the list at this moment', {});
  }
  // The three ways to close: press 顔ぶれ again, Esc, a click outside (which only closes: no writing frame, no pick).
  await click(win, '#academy-overlook-roster-button');
  check('顔ぶれ again closes the list', !(await js(win, ROSTER_VIEW)).open && (await js(win, STATE)) === 'field');
  await click(win, '#academy-overlook-roster-button');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(150);
  check('Esc closes the list', !(await js(win, ROSTER_VIEW)).open && (await js(win, STATE)) === 'field');
  await click(win, '#academy-overlook-roster-button');
  const fountainScreen = { x: fountain.x - openView.camera.x, y: fountain.y - openView.camera.y };
  await pointerClick(win, fountainScreen);
  await sleep(200);
  check('a click outside (on a place) only closes the list', !(await js(win, ROSTER_VIEW)).open && (await js(win, STATE)) === 'field'
    && (await js(win, `document.querySelector('#academy-overlook-writing').hidden`)), { clicked: fountainScreen });
  mouse(win, 'mouseMove', 5, 500);

  // Hover a hoverable coma with feelings towards others (bring one on screen if needed).
  const withFeelings = seam.fieldView().children.filter((entry) => entry.status === 'free' && entry.wish_line && entry.feelings.length >= 1)
    .sort((a, b) => b.feelings.length - a.feelings.length);
  check('children carry feelings from entry A', withFeelings.length > 0, { counts: seam.fieldView().children.map((entry) => entry.feelings.length) });
  let hoverTarget = null;
  for (const candidate of withFeelings) {
    const view = await js(win, FIELD_VIEW);
    let coma = view.comas.find((entry) => entry.id === candidate.character_id);
    if (!hoverable(coma, view.parts)) {
      await bringIntoView(win, candidate);
      await sleep(500);
      coma = (await js(win, FIELD_VIEW)).comas.find((entry) => entry.id === candidate.character_id);
    }
    if (hoverable(coma, (await js(win, FIELD_VIEW)).parts)) { hoverTarget = { ...candidate, coma }; break; }
    log('hover candidate not hoverable', { id: candidate.character_id, server: { x: candidate.x, y: candidate.y }, coma: coma ?? null, state: await js(win, STATE), camera: (await js(win, FIELD_VIEW)).camera });
  }
  check('a hoverable coma with feelings', hoverTarget !== null);
  mouse(win, 'mouseMove', hoverTarget.coma.x, hoverTarget.coma.y);
  await waitForState(win, 'say', { tries: 30, intervalMs: 50 });
  await sleep(150);
  await capture('04-hover-say', ['.academy-overlook-label[data-kind="say"]'], { hovered: hoverTarget.character_name, targets: hoverTarget.feelings.map((feeling) => feeling.label) });
  const sayRect4 = await js(win, `JSON.stringify(document.querySelector('.academy-overlook-label[data-kind="say"]').getBoundingClientRect())`);
  await waitForState(win, 'lines', { tries: 40, intervalMs: 50 });
  await sleep(300);
  const linesDom = await js(win, `({ feelings: [...document.querySelectorAll('.academy-overlook-label[data-kind="feeling"]')].filter((el) => el.style.visibility === 'visible').map((el) => el.textContent), say: JSON.stringify(document.querySelector('.academy-overlook-label[data-kind="say"]').getBoundingClientRect()) })`);
  check('状態 5: feeling labels shown, the say label did not move', linesDom.feelings.length === hoverTarget.feelings.length && linesDom.say === sayRect4, { ...linesDom, sayRect4 });
  await capture('05-hover-lines', ['.academy-overlook-label[data-kind="say"]'], { feelings: linesDom.feelings });
  mouse(win, 'mouseMove', 5, 500);
  await waitForState(win, 'field', { tries: 30 });

  // 19: send one child off. The camera goes to the gate first (a drag would close the list), the list opens, the
  // child nearest the gate goes, and the field runs until the two pass each other on the road outside the gate.
  const gate = seam.session.graph.places.find((place) => place.location_id === 'front_gate_morning');
  const mapHeight = seam.fieldView().map.height;
  // Runs the field on; a focus the academy takes in between is read out (the camera then stands on the talk's place).
  async function runField(ms) {
    advanceClock(ms);
    await sleep(40);
    if (!seam.fieldView().focus) return;
    check('the page moves to the academy-chosen focus', await waitFor(win, `!['field', 'say', 'lines', 'pair'].includes(${STATE})`, { tries: 100 }));
    check('an academy-chosen talk reads out to the field', await readTalksToField(win));
  }
  // With the server clock standing still: back on the field, the camera on the gate (a drag closes the list, so the
  // list opens after it), the list open. A focus the academy takes meanwhile is read out and the round starts over.
  async function settleAtGate() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!['field', 'say', 'lines', 'pair'].includes(await js(win, STATE))) {
        check('an academy-chosen talk reads out to the field', await readTalksToField(win));
        continue;
      }
      if ((await js(win, ROSTER_VIEW)).open) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await sleep(150);
      }
      await bringIntoView(win, gate);
      await sleep(400);
      const view = await js(win, FIELD_VIEW);
      const gateOnScreen = { x: gate.x - view.camera.x, y: gate.y - view.camera.y };
      if (!['field', 'say', 'lines', 'pair'].includes(await js(win, STATE)) || Math.abs(gateOnScreen.x - VIEWPORT.width / 2) > 80 || gateOnScreen.y < 300 || gateOnScreen.y > 700) continue;
      await click(win, '#academy-overlook-roster-button');
      await sleep(200);
      if (['field', 'say', 'lines', 'pair'].includes(await js(win, STATE)) && (await js(win, ROSTER_VIEW)).open) return gateOnScreen;
    }
    return null;
  }
  const inEncounter = () => new Set(seam.fieldView().encounters.flatMap((encounter) => encounter.participants.map((participant) => participant.character_id)));
  await bringIntoView(win, gate);
  await sleep(500);
  await click(win, '#academy-overlook-roster-button');
  const meeting = inEncounter();
  const leaver = seam.fieldView().children.filter((entry) => entry.status === 'free' && !meeting.has(entry.character_id))
    .sort((a, b) => Math.hypot(a.x - gate.x, a.y - gate.y) - Math.hypot(b.x - gate.x, b.y - gate.y))[0];
  const rowIndex = seam.fieldView().roster.findIndex((row) => row.character_id === leaver.character_id);
  await js(win, `document.querySelectorAll('#academy-overlook-roster .academy-overlook-roster-send')[${rowIndex}].click()`);
  check('状態 19: the row turns to the newcomer at once, its 送り出す dead', await waitFor(win, `(() => { const row = document.querySelectorAll('#academy-overlook-roster .academy-overlook-roster-row')[${rowIndex}]; return row.dataset.characterId !== ${JSON.stringify(leaver.character_id)} && row.querySelector('.academy-overlook-roster-send').disabled; })()`, { tries: 40, intervalMs: 50 }));
  const newcomerRow = seam.fieldView().roster[rowIndex];
  const swapRows = (await js(win, ROSTER_VIEW)).rows;
  check('状態 19: the new row is the server\'s newcomer, the other 11 rows unchanged', swapRows[rowIndex].id === newcomerRow.character_id && swapRows[rowIndex].name === newcomerRow.character_name && !newcomerRow.swappable
    && swapRows.every((row, index) => index === rowIndex || row.id === serverRoster[index].character_id || seam.fieldView().roster[index].character_id === row.id),
  { leaver: leaver.character_name, newcomer: newcomerRow.character_name, row: rowIndex + 1 });
  const walkers = () => {
    const view = seam.fieldView();
    return { out: view.children.find((entry) => entry.character_id === leaver.character_id) ?? null, in: view.children.find((entry) => entry.character_id === newcomerRow.character_id) ?? null };
  };
  let passing = null;
  for (let i = 0; i < 3000 && !passing; i += 1) {
    await runField(80);
    const { out, in: coming } = walkers();
    if (out?.status === 'leaving' && out.y >= gate.y + 140 && coming?.status === 'arriving') passing = { out, in: coming };
  }
  check('状態 19: the leaver walks out and the newcomer walks in on the road outside the gate', passing !== null, passing ?? {});
  check('状態 19: the lanes are 28 px west and east of the gate point', near(passing.out.x, gate.x - 28, 0.01) && near(passing.in.x, gate.x + 28, 0.01), { gate: { x: gate.x, y: gate.y }, out: { x: passing.out.x, y: passing.out.y }, in: { x: passing.in.x, y: passing.in.y } });
  const gateOnScreen = await settleAtGate();
  check('状態 19: the camera on the gate, the list open', gateOnScreen !== null, { gateOnScreen });
  check('状態 19: the two walkers still on the road (the clock stood still meanwhile)', walkers().out?.status === 'leaving' && walkers().in?.status === 'arriving', { out: walkers().out?.y ?? null, in: walkers().in?.y ?? null });
  await sleep(900);
  const swapView = await js(win, FIELD_VIEW);
  const outComa = swapView.comas.find((coma) => coma.id === leaver.character_id);
  const inComa = swapView.comas.find((coma) => coma.id === newcomerRow.character_id);
  const comaSizes = await js(win, `[${JSON.stringify(leaver.character_id)}, ${JSON.stringify(newcomerRow.character_id)}].map((id) => { const node = document.querySelector('.academy-overlook-coma[data-character-id="' + id + '"]'); const style = getComputedStyle(node); return { id, width: node.offsetWidth, height: node.offsetHeight, border: style.borderTopWidth + ' ' + style.borderTopColor, opacity: style.opacity, filter: style.filter }; })`);
  const plainComa = await js(win, `(() => { const style = getComputedStyle(document.querySelector('.academy-overlook-coma')); return style.borderTopWidth + ' ' + style.borderTopColor; })()`);
  check('状態 19: both walkers drawn on screen as the same 56 px comas (same rim, no dimming)', outComa && inComa && [outComa, inComa].every((coma) => coma.x > 0 && coma.x < VIEWPORT.width && coma.y > 0 && coma.y < VIEWPORT.height)
    && comaSizes.every((entry) => entry.width === 56 && entry.height === 56 && entry.border === plainComa && entry.opacity === '1' && entry.filter === 'none'),
  { outComa, inComa, comaSizes });
  check('状態 19: no text explains the walk (the field holds no label)', (await js(win, `document.querySelectorAll('#academy-overlook-hover .academy-overlook-label').length`)) === 0);
  await capture('19-roster-swap', ['#academy-overlook-roster', '#academy-overlook-roster-button', '#academy-overlook-exit', `.academy-overlook-coma[data-character-id="${leaver.character_id}"]`, `.academy-overlook-coma[data-character-id="${newcomerRow.character_id}"]`],
    { leaver: leaver.character_name, newcomer: newcomerRow.character_name, row: rowIndex + 1, academy_time: seam.fieldView().clock.academy_time });
  // No pointer on the two walkers: no say label, no state change.
  for (const coma of [outComa, inComa]) {
    mouse(win, 'mouseMove', coma.x, coma.y);
    await sleep(700);
    check(`状態 19: the walker ${coma.id} takes no pointer`, (await js(win, STATE)) === 'field' && (await js(win, `document.querySelectorAll('#academy-overlook-hover .academy-overlook-label').length`)) === 0);
  }
  mouse(win, 'mouseMove', 5, 500);
  // Closing the list does not stop the walk.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(150);
  check('the list closed with the walk under way', !(await js(win, ROSTER_VIEW)).open);
  const beforeWalk = walkers();
  await runField(400);
  await sleep(900);
  const afterWalk = walkers();
  check('the walk goes on with the list closed', afterWalk.in && afterWalk.in.y < beforeWalk.in.y, { before: beforeWalk.in?.y ?? null, after: afterWalk.in?.y ?? null, status: afterWalk.in?.status ?? null });
  // Once through the gate the newcomer is a roster child like the others: its 送り出す comes alive.
  for (let i = 0; i < 400 && walkers().in?.status === 'arriving'; i += 1) await runField(80);
  check('the newcomer walked through the gate', walkers().in && walkers().in.status !== 'arriving' && seam.fieldView().roster[rowIndex].swappable, { status: walkers().in?.status ?? null });
  await click(win, '#academy-overlook-roster-button');
  check('its 送り出す is alive after the gate', await waitFor(win, `!document.querySelectorAll('#academy-overlook-roster .academy-overlook-roster-send')[${rowIndex}].disabled`, { tries: 30 }));
  // 別の子の「送り出す」を続けて押せる: two rows, one right after the other.
  const busy = inEncounter();
  const pairRows = seam.fieldView().roster.map((row, index) => ({ ...row, index })).filter((row) => row.swappable && !busy.has(row.character_id) && row.index !== rowIndex).slice(0, 2);
  await js(win, `(() => { const sends = document.querySelectorAll('#academy-overlook-roster .academy-overlook-roster-send'); sends[${pairRows[0].index}].click(); sends[${pairRows[1].index}].click(); })()`);
  check('two send-offs one after the other both go through', await waitFor(win, `(() => { const rows = document.querySelectorAll('#academy-overlook-roster .academy-overlook-roster-row'); return rows[${pairRows[0].index}].dataset.characterId !== ${JSON.stringify(pairRows[0].character_id)} && rows[${pairRows[1].index}].dataset.characterId !== ${JSON.stringify(pairRows[1].character_id)}; })()`, { tries: 40, intervalMs: 50 })
    && pairRows.every((row) => seam.fieldView().children.find((entry) => entry.character_id === row.character_id)?.status === 'leaving'),
  { sent: pairRows.map((row) => row.character_name) });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(150);

  // 18 in a 760 px high window: the top stops 94 px below the screen top and the rows scroll inside the frame.
  win.setContentSize(VIEWPORT.width, 760);
  check('window 1440×760', await waitFor(win, 'innerHeight === 760 && innerWidth === 1440', { tries: 30 }));
  await sleep(400);
  await click(win, '#academy-overlook-roster-button');
  await sleep(200);
  const short = await js(win, ROSTER_VIEW);
  check('760 px: the top at 94 px, bottom and right unchanged, the rows scroll inside, opened at row 1', short.open && near(short.list.top, 94, 0.5) && near(short.list.bottom, short.button.top - 10, 0.5) && near(short.list.right, short.exit.right, 0.5)
    && short.scrollHeight > short.clientHeight && short.scrollTop === 0 && short.rows.every((row) => near(row.rect.bottom - row.rect.top, 48, 0.1)), { list: short.list, scrollHeight: short.scrollHeight, clientHeight: short.clientHeight, screen: short.screen });
  await capture('18b-roster-list-760', ['#academy-overlook-roster', '#academy-overlook-roster-button', '#academy-overlook-exit'], { list: short.list, scrollHeight: short.scrollHeight, clientHeight: short.clientHeight });
  // Scrolled to the end: the last row comes into the frame, the frame itself stays put.
  await js(win, `(() => { const list = document.querySelector('#academy-overlook-roster'); list.scrollTop = list.scrollHeight; })()`);
  await sleep(200);
  const scrolled = await js(win, ROSTER_VIEW);
  const lastRow = scrolled.rows.at(-1);
  check('760 px: scrolled to the end inside the frame (the frame does not move)', scrolled.scrollTop > 0 && near(scrolled.scrollTop, scrolled.scrollHeight - scrolled.clientHeight, 1) && near(scrolled.list.top, 94, 0.5)
    && near(scrolled.rows[0].rect.top, short.rows[0].rect.top - scrolled.scrollTop, 0.5) && lastRow.rect.bottom <= scrolled.list.bottom, { scrollTop: scrolled.scrollTop, lastRow: lastRow.rect, list: scrolled.list });
  await capture('18c-roster-list-760-scrolled', ['#academy-overlook-roster'], { scrollTop: scrolled.scrollTop });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(150);
  await click(win, '#academy-overlook-roster-button');
  await sleep(150);
  check('760 px: reopened at row 1', (await js(win, ROSTER_VIEW)).scrollTop === 0);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.setContentSize(VIEWPORT.width, VIEWPORT.height);
  check('window back to 1440×960', await waitFor(win, 'innerHeight === 960', { tries: 30 }));

  // 15:00: the academy day ends → the loading cover → the hub.
  const requestsBefore1500 = lmStub.requests.length;
  advanceClock(30 * 60 * 1000);
  check('15:00 returns to the hub', await waitFor(win, `${hubReady} && ${ACTIVE_SCREEN} === 'routing-hub-screen'`, { tries: 300 }));
  const greeting1500 = lmStub.requests.slice(requestsBefore1500).find((request) => request.overlookResultLine)?.overlookResultLine ?? null;
  check('the 15:00 hub greeting is asked with the overlook result', greeting1500 !== null, { line: greeting1500 });
  await sleep(800);
  await capture('16b-hub-return-1500', ['#routing-hub-message-stream'], { greeting_result_line: greeting1500 });

  // ── entry C: an LM call fails through the product's transport → the settings screen (状態 15) ─────────────
  clock.frozenAt = null;
  await hubSend(HUB_DECIDE);
  // The academy may take a focus at once on this entry: read it out so the failure lands while the field polls.
  check('entry C: on the overlook screen', await waitFor(win, `${ACTIVE_SCREEN} === 'academy-overlook-screen' && ${STATE} !== 'entering'`, { tries: 300 }));
  seam.line = { preMs: 0, chunkMs: 0, chunks: 1 };
  check('entry C: at the field', await readTalksToField(win));
  seam.failNext = true;
  advanceClock(60 * 1000);
  check('LM failure lands on 接続設定', await waitFor(win, `${ACTIVE_SCREEN} === 'settings-screen'`, { tries: 300 }));
  await sleep(1200);
  const settingsDom = await js(win, `({ text: document.querySelector('#settings-screen')?.textContent.includes('LM Studioの接続が確認できません') })`);
  check('the settings screen names the LM failure', settingsDom.text === true, settingsDom);
  await capture('15-lm-unreachable', ['#settings-screen'], settingsDom);

  await finish({ outDir, mode, repoRoot, captures, startedAt });
}

async function finish({ outDir, mode, repoRoot, captures, startedAt }) {
  const summary = { mode, head: gitHead(repoRoot), captures, checks, lm_stub_requests: lmStub.requests.length, elapsed_ms: realNow() - startedAt };
  await fs.writeFile(path.join(outDir, `audit-${mode}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`OVERLOOK RENDER (${mode}): ${checks.every((entry) => entry.pass) ? 'PASS' : 'FAIL'} (${checks.length} checks, ${Object.keys(captures).length} captures)`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((error) => {
  console.error('HARNESS_ERROR', error?.stack ?? error);
  exitCode = 3;
  app.quit();
});
app.on('quit', () => {
  try { proxy?.server?.close(); } catch { /* closing */ }
  try { gameServer?.close(); } catch { /* closing */ }
  try { lmStub?.server?.close(); } catch { /* closing */ }
  if (root) fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
});
