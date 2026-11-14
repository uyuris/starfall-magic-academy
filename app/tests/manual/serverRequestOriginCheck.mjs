// One-off check of the server entrance rules (app/src/server/requestOrigin.mjs):
//
//   <electron> app/tests/manual/serverRequestOriginCheck.mjs browser|electron --work-dir=<absolute, not yet existing>
//   node app/tests/manual/serverRequestOriginCheck.mjs serve|unresolved
//
// Under Electron the work dir (LM config, Electron userData, the electron mode's saves) is the caller's to remove
// after the run: Electron writes its userData while it exits, after anything this script could run. Under node
// a temp dir is used and removed at exit.
//
// modes:
//   browser    — `node app/src/server.mjs` as npm start does (127.0.0.1); opens the screen in a hidden window and
//                plays new game → hub → one turn → one settings read/write; then sends each refused shape (and the
//                accepted pair) from Node, and a cross-site GET /api/errand with the save hashed before and after.
//   electron   — loads electron/main.mjs as `npm run electron` does (127.0.0.1:41731), its window kept hidden and
//                userData in a temp dir; plays the same steps on the window main.mjs opens.
//   serve      — `node scripts/serve-starfall.mjs` with SERVE_HOST=0.0.0.0; opens the screen on the serve list's
//                name (`scutil --get LocalHostName` + `.local`) and port in headless Google Chrome (a throwaway
//                profile, driven over CDP: dev Electron does not resolve .local names); plays the same steps.
//   unresolved — the start-stops / refuses-every-request conditions: serve-starfall on 0.0.0.0 with no scutil on
//                PATH, and a createServer() listened on 0.0.0.0 by hand without a readable .local name.
//
// The LM is a fixed-response stub in this process; no request goes to LM Studio. Every product process is
// started without TEAM_* variables. The play writes saves under the worktree's data/mutable (browser / serve)
// or a temp userData (electron).
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { projectRoot } from '../testPaths.mjs';

const MODE = process.argv.find((arg) => ['browser', 'electron', 'serve', 'unresolved'].includes(arg));
if (!MODE) throw new Error('usage: <electron> app/tests/manual/serverRequestOriginCheck.mjs browser|electron, or node … serve|unresolved');
const ELECTRON_MODES = new Set(['browser', 'electron']);
if (ELECTRON_MODES.has(MODE) !== Boolean(process.versions.electron)) {
  throw new Error(`mode ${MODE} runs under ${ELECTRON_MODES.has(MODE) ? 'the Electron binary' : 'node'}`);
}
const { app, BrowserWindow } = ELECTRON_MODES.has(MODE) ? await import('electron') : {};
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TURN_INPUT = '今週は鍛錬する';
const SENDOFF_TEXT = 'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。';
const log = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

function productEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TEAM_') && !key.startsWith('ELECTRON_')));
  return { ...env, ...extra };
}

function nodeBinary() {
  return execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function serveListHostName() {
  return `${execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`;
}

// The answers the conversation's closing bookkeeping asks for after the send-off (the same as
// hubReturnOnePathCapture.mjs).
const CLOSING_ANSWERS = [
  ['好感度の変化量を判定する', '0'],
  ['増減したユーザーの所持金を判定する', '0'],
  ['所持金判定', '0'],
  ['skill_record作成の必要性判定', 'false'],
  ['のタイトルと本文を平文で出力する', 'タイトル: 学院の午後\n本文: 学院で主人公と言葉を交わした。'],
  ['memory_recordの本文だけ', '学院で主人公と穏やかに話した。']
];

// ── fixed-response LM ──────────────────────────────────────────────────────────────────────────────────────
// The hub opening, the decided turn (destination 鍛錬) and its send-off; the same answers as
// routingTurnDispatchRender.mjs.
function lmAnswer(body, requestIndex) {
  const prompt = (body.messages ?? []).map((message) => message.content ?? '').join('\n');
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  for (const [marker, answer] of CLOSING_ANSWERS) {
    if (prompt.includes(marker)) return answer;
  }
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'training';
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) return SENDOFF_TEXT;
  if (requestIndex === 0) return '新しい週をここから始めましょう。';
  return '鍛錬ですね。今の伸ばしたい力にも合っています。';
}

async function startLmStub() {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'chat-model' }, { id: 'reflection-model' }] }));
      return;
    }
    const parsed = JSON.parse(text);
    const content = lmAnswer(parsed, requests.length - 1);
    if (process.env.SRO_DEBUG) console.log(`lm#${requests.length - 1} ${parsed.response_format?.json_schema?.name ?? ''} stream=${parsed.stream} ${JSON.stringify((parsed.messages ?? []).map((m) => m.content ?? '').join(' ').slice(0, 90))} -> ${JSON.stringify(content.slice(0, 40))}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, config: { provider: 'lmstudio', base_url: `http://127.0.0.1:${server.address().port}/v1`, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 10000, stream: false, thinking_effort: null, mock_provider_enabled: true } };
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ── product processes ──────────────────────────────────────────────────────────────────────────────────────
// Every product child this run started, so the error path stops it too.
const children = new Set();

function spawnProduct(label, args, env) {
  const child = spawn(nodeBinary(), args, { cwd: projectRoot, env: productEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  children.add(child);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        lines.push(line);
        console.log(`[${label}] ${line}`);
      }
    });
  }
  return { child, lines, exited };
}

async function waitForLine(proc, pattern, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (proc.lines.some((line) => pattern.test(line))) return;
    if (proc.child.exitCode !== null) throw new Error(`product exited before ${pattern}: ${proc.child.exitCode}`);
    await sleep(100);
  }
  throw new Error(`product did not print ${pattern} within ${ms}ms`);
}

async function stopProduct(label, proc) {
  proc.child.kill('SIGTERM');
  const result = await proc.exited;
  log(`${label} exit`, result);
  check(`${label} stops on SIGTERM with exit 0`, result.code === 0, result);
}

// ── the play through the real client ───────────────────────────────────────────────────────────────────────
async function js(win, source) {
  return win.evaluate ? win.evaluate(source) : win.webContents.executeJavaScript(source);
}

async function waitFor(win, predicate, { tries = 300, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await js(win, `(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`)) return true;
    await sleep(intervalMs);
  }
  return false;
}

function recordRequests(targetSession) {
  const seen = [];
  targetSession.webRequest.onCompleted({ urls: ['http://*/*'] }, (details) => {
    const url = new URL(details.url);
    if (url.pathname.startsWith('/api/')) seen.push({ method: details.method, path: url.pathname, status: details.statusCode });
  });
  return seen;
}

async function clickUntilSent(win) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sent = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      input.value = ${JSON.stringify(TURN_INPUT)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#routing-hub-send').click();
      return input.value === '';
    })()`);
    if (sent) return true;
    await sleep(250);
  }
  return false;
}

async function play(win, label, requests, origin) {
  await waitFor(win, `document.querySelector('#title-screen')?.classList.contains('active')`);
  await sleep(1000);
  check(`${label}: the screen opened on ${origin}`, await js(win, 'location.origin') === origin, await js(win, 'location.href'));
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  const hubReady = await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0`, { tries: 400 });
  check(`${label}: hub opened with the guide's opening`, hubReady, await js(win, `document.querySelector('.screen.active')?.id ?? null`));
  const sent = hubReady && await clickUntilSent(win);
  check(`${label}: one turn sent from the hub input`, sent);
  const answered = sent && await waitFor(win, `(document.querySelector('#routing-hub-message-stream')?.textContent || '').includes('鍛錬ですね')
    || (document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(SENDOFF_TEXT)})
    || document.querySelector('#academy-training-screen')?.classList.contains('active')`, { tries: 400, intervalMs: 120 });
  check(`${label}: the guide's reply to the turn reached the screen`, answered, { screen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), stream: await js(win, `(document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().slice(-200)`), status: await js(win, `document.querySelector('#routing-hub-status')?.textContent ?? null`) });
  const turnDone = () => requests.some((entry) => entry.method === 'POST' && entry.path === '/api/conversation/stream' && entry.status < 300);
  for (let i = 0; i < 300 && !turnDone(); i += 1) await sleep(100);
  check(`${label}: POST /api/conversation/stream (the turn) answered 2xx`, turnDone());
  const settings = await js(win, `(async () => {
    const read = await fetch('/api/settings/conversation-popup');
    const before = await read.json();
    const written = await fetch('/api/settings/conversation-popup', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cooldown_ms: before.cooldown_ms }) });
    return { read: read.status, before, written: written.status, after: await written.json() };
  })()`);
  check(`${label}: settings read and write (conversation popup cooldown)`, settings.read === 200 && settings.written === 200 && settings.after.cooldown_ms === settings.before.cooldown_ms, settings);
  log(`${label} /api requests from the screen`, requests);
  const refused = requests.filter((entry) => entry.status === 403 || entry.status === 415);
  check(`${label}: no request from the screen was refused`, refused.length === 0, refused);
  for (const needed of ['POST /api/new-game', 'POST /api/routing/hub/start', 'GET /api/settings/conversation-popup', 'PATCH /api/settings/conversation-popup']) {
    check(`${label}: ${needed} answered 2xx`, requests.some((entry) => `${entry.method} ${entry.path}` === needed && entry.status < 300));
  }
}

async function openHidden(url) {
  const win = new BrowserWindow({ width: 1280, height: 860, show: false });
  const requests = recordRequests(win.webContents.session);
  await win.loadURL(url);
  return { win, requests };
}

// Headless Google Chrome on a throwaway profile, one page driven over CDP; `requests` gets every /api/ request once
// its response has finished (an SSE stream counts when it ends).
async function openChrome(url) {
  const port = await freePort();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'server-request-origin-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  const chromeExited = new Promise((resolve) => chrome.once('exit', resolve));
  let pageTarget = null;
  for (let i = 0; i < 100 && !pageTarget; i += 1) {
    await sleep(200);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json(), () => null);
    pageTarget = targets?.find((target) => target.type === 'page') ?? null;
  }
  if (!pageTarget) throw new Error('headless Chrome did not open a page target');
  const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message}`)); else waiter.resolve(message.result);
    } else {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
  const on = (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]);
  const requests = [];
  const inFlight = new Map();
  on('Network.requestWillBeSent', ({ requestId, request }) => {
    const parsed = new URL(request.url);
    if (parsed.pathname.startsWith('/api/')) inFlight.set(requestId, { method: request.method, path: parsed.pathname, status: null });
  });
  on('Network.responseReceived', ({ requestId, response }) => {
    if (inFlight.has(requestId)) inFlight.get(requestId).status = response.status;
  });
  on('Network.loadingFinished', ({ requestId }) => {
    if (!inFlight.has(requestId)) return;
    requests.push(inFlight.get(requestId));
    inFlight.delete(requestId);
  });
  await send('Network.enable');
  await send('Page.enable');
  const loaded = new Promise((resolve) => on('Page.loadEventFired', resolve));
  await send('Page.navigate', { url });
  await loaded;
  const page = {
    async evaluate(source) {
      const answer = await send('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true });
      if (answer.exceptionDetails) throw new Error(`page evaluate: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`);
      return answer.result.value;
    },
    async close() {
      socket.close();
      chrome.kill('SIGTERM');
      await chromeExited;
      await fs.rm(profile, { recursive: true, force: true });
    }
  };
  return { page, requests };
}

// ── refusals, sent from Node with exact headers ─────────────────────────────────────────────────────────────
function raw(port, { method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, error_code: json?.error_code ?? null, error: json?.error ?? null });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

async function hashTree(root) {
  const hash = createHash('sha256');
  let files = 0;
  async function walk(dir) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        hash.update(path.relative(root, full));
        hash.update(await fs.readFile(full));
      }
    }
  }
  await walk(root);
  return { files, sha256: hash.digest('hex') };
}

// The save tree once the conversation's background finalization has settled: two walks a second apart agree.
async function settledHash(root) {
  let previous = null;
  for (let i = 0; i < 60; i += 1) {
    const current = await hashTree(root).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (current && previous && current.sha256 === previous.sha256) return current;
    previous = current;
    await sleep(1000);
  }
  throw new Error(`the save tree under ${root} did not settle within 60s`);
}

async function refusals(port, lm) {
  const own = `http://127.0.0.1:${port}`;
  const route = '/api/settings/conversation-popup';
  const before = await (await fetch(`${own}${route}`)).json();
  const body = JSON.stringify({ cooldown_ms: 300 });
  const json = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  const cases = [
    ['different Origin', { method: 'PATCH', pathname: route, headers: { ...json, origin: 'http://evil.example' }, body }, 403, 'request_origin_forbidden'],
    ['Origin on another port', { method: 'PATCH', pathname: route, headers: { ...json, origin: `http://127.0.0.1:${port + 1}` }, body }, 403, 'request_origin_forbidden'],
    ['PATCH without Origin', { method: 'PATCH', pathname: route, headers: json, body }, 403, 'request_origin_required'],
    ['Host not allowed', { pathname: '/', headers: { host: `evil.example:${port}` } }, 403, 'request_host_forbidden'],
    ['the serve-list name on a 127.0.0.1 server', { pathname: '/', headers: { host: `${serveListHostName()}:${port}` } }, 403, 'request_host_forbidden'],
    ['Host on another port', { pathname: '/', headers: { host: `127.0.0.1:${port + 1}` } }, 403, 'request_host_forbidden'],
    ['body that is not JSON', { method: 'PATCH', pathname: route, headers: { origin: own, 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(body)) }, body }, 415, 'request_content_type_unsupported'],
    ['GET from another site', { pathname: route, headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'request_cross_site'],
    ['accepted: PATCH with own Origin and JSON', { method: 'PATCH', pathname: route, headers: { ...json, origin: own }, body }, 200, null],
    ['accepted: PATCH with Origin on localhost', { method: 'PATCH', pathname: route, headers: { ...json, origin: `http://localhost:${port}`, host: `localhost:${port}` }, body }, 200, null],
    ['accepted: GET without Origin', { pathname: route }, 200, null],
    ['accepted: GET same-origin', { pathname: route, headers: { 'sec-fetch-site': 'same-origin' } }, 200, null],
    ['accepted: static GET /', { pathname: '/' }, 200, null]
  ];
  for (const [label, request, status, errorCode] of cases) {
    const answer = await raw(port, request);
    check(`refusal: ${label} → ${status}${errorCode ? ` ${errorCode}` : ''}`, answer.status === status && answer.error_code === errorCode, answer);
  }
  const restore = JSON.stringify({ cooldown_ms: before.cooldown_ms });
  const restored = await raw(port, { method: 'PATCH', pathname: route, headers: { origin: own, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(restore)) }, body: restore });
  log('cooldown put back to the value before the refusal checks', { before: before.cooldown_ms, restored });

  const saves = path.join(projectRoot, 'data/mutable/game_data');
  const savesBefore = await settledHash(saves);
  const lmBefore = lm.requests.length;
  const errand = await raw(port, { pathname: '/api/errand', headers: { 'sec-fetch-site': 'cross-site' } });
  const after = await hashTree(saves);
  check('refusal: cross-site GET /api/errand → 403 request_cross_site', errand.status === 403 && errand.error_code === 'request_cross_site', errand);
  check('refusal: the save is byte-identical after the refused GET /api/errand', savesBefore.sha256 === after.sha256 && savesBefore.files === after.files, { before: savesBefore, after });
  check('refusal: the refused GET /api/errand sent nothing to the LM', lm.requests.length === lmBefore, { before: lmBefore, after: lm.requests.length });
  const control = await raw(port, { pathname: '/api/errand' });
  const afterControl = await hashTree(saves);
  log('control: same-origin GET /api/errand (passes the entrance)', { answer: control, lmRequests: lm.requests.length - lmBefore, saveChanged: afterControl.sha256 !== after.sha256 });
}

// ── modes ──────────────────────────────────────────────────────────────────────────────────────────────────
async function runBrowser(lm, work) {
  const port = await freePort();
  const configPath = path.join(work, 'config/lmstudio.json');
  await writeJsonFile(configPath, lm.config);
  const proc = spawnProduct('npm start', ['app/src/server.mjs'], { PORT: String(port), MAGIC_ACADEMY_LMSTUDIO_CONFIG: configPath });
  await waitForLine(proc, /runtime listening on/);
  const origin = `http://127.0.0.1:${port}`;
  const { win, requests } = await openHidden(`${origin}/`);
  await play(win, 'browser', requests, origin);
  win.destroy();
  await refusals(port, lm);
  await stopProduct('npm start', proc);
}

async function runServe(lm, work) {
  const port = await freePort();
  const configPath = path.join(work, 'config/lmstudio.json');
  await writeJsonFile(configPath, lm.config);
  const proc = spawnProduct('serve-starfall', ['scripts/serve-starfall.mjs'], { SERVE_HOST: '0.0.0.0', SERVE_PORT: String(port), MAGIC_ACADEMY_LMSTUDIO_CONFIG: configPath });
  await waitForLine(proc, /runtime listening on/);
  const name = serveListHostName();
  const origin = `http://${name.toLowerCase()}:${port}`;
  log('serve list open URL', { url: `http://${name}:${port}/`, name, port });
  const { page, requests } = await openChrome(`http://${name}:${port}/`);
  try {
    await play(page, 'serve', requests, origin);
  } finally {
    await page.close();
  }
  const health = await raw(port, { pathname: '/' });
  check('serve: the frame health check GET http://127.0.0.1:<port>/ answers 200', health.status === 200, health);
  await stopProduct('serve-starfall', proc);
}

async function runUnresolved(lm, work) {
  const port = await freePort();
  const configPath = path.join(work, 'config/lmstudio.json');
  await writeJsonFile(configPath, lm.config);
  const proc = spawnProduct('serve-starfall without scutil', ['scripts/serve-starfall.mjs'], { SERVE_HOST: '0.0.0.0', SERVE_PORT: String(port), MAGIC_ACADEMY_LMSTUDIO_CONFIG: configPath, PATH: '/nonexistent' });
  const result = await proc.exited;
  log('serve-starfall without scutil exit', result);
  check('unresolved: serve-starfall on 0.0.0.0 without a .local name stops at start', result.code !== 0 && proc.lines.some((line) => line.includes('LocalHostName')), result);
  const probe = await raw(port, { pathname: '/' }).catch((error) => ({ error: error.code }));
  check('unresolved: nothing is left listening on the port', probe.error === 'ECONNREFUSED', probe);

  const { createServer } = await import('../../src/server.mjs');
  const server = createServer({ root: projectRoot, lmStudioConfig: lm.config, lmStudioConfigPath: configPath, playModeSettingsPath: path.join(work, 'config/play-mode.json') });
  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const handPort = server.address().port;
  const first = await raw(handPort, { pathname: '/' });
  const second = await raw(handPort, { pathname: '/api/settings/conversation-popup' });
  process.env.PATH = savedPath;
  check('unresolved: a hand-listened 0.0.0.0 server without a .local name refuses requests (500 request_origin_unresolved)', first.status === 500 && first.error_code === 'request_origin_unresolved' && second.error_code === 'request_origin_unresolved', { first, second });
  await new Promise((resolve) => server.close(resolve));
}

// electron: main.mjs is loaded into this process as `npm run electron` loads it; its window is kept hidden.
// Prepared before this module finishes evaluating: main.mjs settles userData and registers its launch before
// Electron's ready, as it does when it is the entry.
async function prepareElectron(lm, work) {
  const inUse = await raw(41731, { pathname: '/' }).then(() => true, () => false);
  if (inUse) throw new Error('port 41731 is in use (the desktop app is running); the electron mode needs it free');
  const userData = path.join(work, 'userData');
  await writeJsonFile(path.join(`${userData}-dev`, 'runtime-project/app/config/lmstudio.json'), lm.config);
  app.setPath('userData', userData);
  const created = new Promise((resolve) => {
    app.on('browser-window-created', (_event, win) => {
      win.show = () => {};
      win.webContents.openDevTools = () => {};
      resolve(win);
    });
  });
  await import('../../../electron/main.mjs');
  // Wrapped: returning the bare promise from this async function would make the top-level await wait for the
  // window, which Electron only opens after this module has finished evaluating.
  return { created };
}

async function runElectron(created) {
  const win = await created;
  const requests = recordRequests(win.webContents.session);
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  log('electron main window', { url: win.webContents.getURL(), visible: win.isVisible() });
  await play(win, 'electron', requests, 'http://127.0.0.1:41731');
  return win;
}

let lm = null;
let work = null;
async function cleanup() {
  for (const child of children) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  try { lm?.server.close(); } catch { /* closing */ }
}

function finish() {
  log('run', { mode: MODE, lmRequests: lm?.requests.length ?? 0, failures });
  console.log(failures === 0 ? 'RESULT PASS' : `RESULT FAIL (${failures})`);
}

app?.on('window-all-closed', () => {});
lm = await startLmStub();
if (app) {
  const workArg = process.argv.find((arg) => arg.startsWith('--work-dir='));
  if (!workArg) throw new Error(`mode ${MODE} requires --work-dir=<absolute, not yet existing directory>`);
  work = workArg.slice('--work-dir='.length);
  if (!path.isAbsolute(work)) throw new Error(`--work-dir must be absolute, got: ${work}`);
  await fs.mkdir(work);
  console.log(`work dir (remove after the run): ${work}`);
} else {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'server-request-origin-'));
  process.on('exit', () => rmSync(work, { recursive: true, force: true }));
}

if (MODE === 'electron') {
  // main.mjs owns the quit (it shuts its server down, then exits 0); a failure exits 1 here instead.
  const { created } = await prepareElectron(lm, work);
  runElectron(created).then(async () => {
    finish();
    await cleanup();
    if (failures === 0) app.quit(); else app.exit(1);
  }, async (error) => {
    console.error('CHECK_ERROR', error?.stack ?? error);
    failures += 1;
    finish();
    await cleanup();
    app.exit(1);
  });
} else {
  const exit = (code) => (app ? app.exit(code) : process.exit(code));
  if (app) app.setPath('userData', path.join(work, 'driver-userData'));
  const run = { browser: runBrowser, serve: runServe, unresolved: runUnresolved }[MODE];
  const ready = app ? app.whenReady() : Promise.resolve();
  ready.then(() => run(lm, work)).then(async () => {
    finish();
    await cleanup();
    exit(failures === 0 ? 0 : 1);
  }, async (error) => {
    console.error('CHECK_ERROR', error?.stack ?? error);
    failures += 1;
    finish();
    await cleanup();
    exit(1);
  });
}
