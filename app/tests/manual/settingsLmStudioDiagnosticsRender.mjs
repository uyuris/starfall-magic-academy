// Render-backed check of the モデル一覧を取得 failure terminal text (Electron / real Blink).
//
// Question: after a REAL pointer click on モデル一覧を取得 fails, does the model status line
// (#lmstudio-model-status) leave 「モデル一覧を取得中です。」 and land on the cause-naming row of the
// closed cause_code → text table, with the target named? One leg per table row:
//
//   1. unreachable host  — real network: a LAN address nobody answers on in the host field
//                          (UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT / EHOSTUNREACH, ~10s on macOS)
//   2. refused port      — real network: 127.0.0.1 + a loopback port that was just closed (ECONNREFUSED)
//   3. code off-table    — window.fetch stubbed to answer 502 { ..., cause_code: 'ENETUNREACH' }
//   4. cause_message     — window.fetch stubbed to answer 502 { ..., cause_message: 'bad port' }
//
// Each leg records the status textContent at t+0 (right after the click, while the request is in
// flight) and at the terminal (first change away from 取得中, polled), then takes a screenshot of the
// settings screen. The verdict is taken from the DOM text, never from the screenshot. The unfixed
// client (bare throw → console.error only) leaves 取得中 on every leg, so this harness FAILs on the
// bug — run it once against the pre-fix public root as the negative control (argv[4]).
//
// Clicks go through CDP `Input.dispatchMouseEvent` (hidden window: sendInputEvent does not reach the
// page, synthetic events are not trusted). `main()` is fire-and-forget — a top-level `await main()`
// deadlocks with `app.whenReady()`.
//
// This file is intentionally NOT named *.test.mjs and lives under app/tests/manual/, so `npm test`
// skips it. Run it by hand from the project root (TEAM_* isolated so nothing touches a live queue):
//
//   env -u TEAM_QUEUE_DIR -u TEAM_STATE_DIR ./node_modules/.bin/electron \
//     app/tests/manual/settingsLmStudioDiagnosticsRender.mjs "$PWD" <screenshot-dir> [<public-root>]
import { app, BrowserWindow } from 'electron';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const SHOT_DIR = path.resolve(process.argv[3] ?? path.join(os.tmpdir(), 'settings-lmstudio-diagnostics-shots'));
const PUBLIC_ROOT = path.resolve(process.argv[4] ?? path.join(PROJECT_ROOT, 'app/public'));
const UNREACHABLE_HOST = '192.168.11.250';
const SEED_PORT = 1234;
const TERMINAL_TIMEOUT_MS = 30000;
const FETCHING_TEXT = 'モデル一覧を取得中です。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));

async function writeJson(root, rel, value) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-lmstudio-diagnostics-render-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: { light: { value: 12 }, dark: { value: 10 }, fire: { value: 14 }, water: { value: 8 }, earth: { value: 11 }, wind: { value: 9 } },
    abilities: { strength: { value: 28 }, agility: { value: 30 }, academics: { value: 26 }, magical_power: { value: 24 }, charisma: { value: 22 } }
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  const lmStudioConfigPath = path.join(root, 'lmstudio.json');
  await fs.writeFile(lmStudioConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: `http://127.0.0.1:${SEED_PORT}/v1`,
    chat_model: 'seed-model-a',
    reflection_model: 'seed-model-a',
    thinking_effort: null
  }, null, 2)}\n`, 'utf8');
  return { root, lmStudioConfigPath };
}

// A loopback port that is closed right now: bind an ephemeral listener, read its port, close it.
async function closedLoopbackPort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let exitCode = 0;

function check(label, ok) {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) exitCode = 1;
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const { root, lmStudioConfigPath } = await splitRoot();
  server = createServer({ root, activeRoot: root, publicRoot: PUBLIC_ROOT, lmStudioConfigPath });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('public_root', PUBLIC_ROOT);
  log('GET /api/settings/lmstudio (seed)', await (await fetch(`${base}/api/settings/lmstudio`)).json());

  await app.whenReady();
  const win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(`${base}/`);
  await sleep(1200); // let app.js boot (refresh(), listeners attached)
  const js = (code) => win.webContents.executeJavaScript(code);

  // In-page fetch record for /api/settings/lmstudio/models, plus a stub slot: when window.__diag.stub is
  // set, the models request is answered in-page (after a short delay so t+0 still sees the request in
  // flight) instead of reaching the server.
  await js(`(() => {
    window.__diag = { fetches: [], stub: null };
    const orig = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input.url;
      const isModels = url.includes('/api/settings/lmstudio/models');
      const entry = { t: performance.now().toFixed(0), method: init?.method ?? 'GET', url, body: init?.body ?? null };
      if (isModels) window.__diag.fetches.push(entry);
      if (isModels && window.__diag.stub) {
        await new Promise((r) => setTimeout(r, 300));
        const { status, payload } = window.__diag.stub;
        entry.status = status;
        entry.response = JSON.stringify(payload);
        entry.stubbed = true;
        return new Response(entry.response, { status, headers: { 'content-type': 'application/json' } });
      }
      const res = await orig.call(this, input, init);
      if (isModels) {
        entry.status = res.status;
        entry.response = await res.clone().text();
      }
      return res;
    };
    return true;
  })()`);

  await js(`document.querySelector('[data-screen="settings"]').click(); true`);
  await sleep(600);

  const state = () => js(`(() => {
    const q = (s) => document.querySelector(s);
    return { t: performance.now().toFixed(0), activeScreen: q('.screen.active')?.id ?? null,
      lmstudioPanelHidden: q('#settings-panel-lmstudio').hidden,
      hostValue: q('#lmstudio-host').value, port: q('#lmstudio-port').value,
      fetchDisabled: q('#fetch-lmstudio-models').disabled,
      modelStatus: q('#lmstudio-model-status').textContent };
  })()`);
  const fetches = () => js('window.__diag.fetches');

  const before = await state();
  log('state_before', before);
  if (before.activeScreen !== 'settings-screen' || before.lmstudioPanelHidden) {
    throw new Error('precondition: settings screen open on the LM Studio category');
  }

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const clickAt = async (selector) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' }); true`);
    const rect = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!(rect.w > 0 && rect.h > 0)) throw new Error(`${selector} not laid out`);
    const x = Math.round(rect.x + Math.min(12, rect.w / 2));
    const y = Math.round(rect.y + rect.h / 2);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { x, y };
  };

  // Hidden-window capture: two rAF turns + invalidate + a throwaway frame before the real shot.
  const screenshot = async (name) => {
    await js(`document.querySelector('#lmstudio-model-status').scrollIntoView({ block: 'center' }); true`);
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    win.webContents.invalidate();
    await win.webContents.capturePage();
    await sleep(100);
    const image = await win.webContents.capturePage();
    const file = path.join(SHOT_DIR, `${name}.png`);
    await fs.writeFile(file, image.toPNG());
    return file;
  };

  const waitTerminal = async () => {
    const started = Date.now();
    for (;;) {
      const s = await state();
      if (s.modelStatus !== FETCHING_TEXT && !s.fetchDisabled) return { ...s, waitedMs: Date.now() - started };
      if (Date.now() - started > TERMINAL_TIMEOUT_MS) return { ...s, waitedMs: Date.now() - started, timedOut: true };
      await sleep(100);
    }
  };

  const runLeg = async ({ name, expected, stub }) => {
    await js(`window.__diag.stub = ${JSON.stringify(stub ?? null)}; true`);
    const fetchCountBefore = (await fetches()).length;
    const at = await clickAt('#fetch-lmstudio-models');
    log(`${name}: cdp_click_at`, at);
    const t0 = await state();
    log(`${name}: state_t+0`, { t: t0.t, modelStatus: t0.modelStatus, fetchDisabled: t0.fetchDisabled });
    const terminal = await waitTerminal();
    log(`${name}: state_terminal`, { t: terminal.t, waitedMs: terminal.waitedMs, timedOut: terminal.timedOut === true, modelStatus: terminal.modelStatus, fetchDisabled: terminal.fetchDisabled });
    const legFetches = (await fetches()).slice(fetchCountBefore);
    log(`${name}: models_fetches`, legFetches);
    const shot = await screenshot(name);
    log(`${name}: screenshot`, shot);
    check(`${name}: t+0 shows 取得中 (request in flight)`, t0.modelStatus === FETCHING_TEXT);
    check(`${name}: exactly one models request`, legFetches.length === 1 && legFetches[0].status === 502);
    check(`${name}: terminal text left 取得中`, terminal.timedOut !== true && terminal.modelStatus !== FETCHING_TEXT);
    check(`${name}: terminal text is the table row`, terminal.modelStatus === expected);
    check(`${name}: fetch button re-enabled`, terminal.fetchDisabled === false);
    return terminal;
  };

  // (1) unreachable host — real network. Type the host (no change event: the model fetch reads the field
  // directly, so no PATCH is needed for this leg).
  await js(`(() => { const h = document.querySelector('#lmstudio-host'); h.value = ${JSON.stringify(UNREACHABLE_HOST)}; h.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#lmstudio-port').value = ${JSON.stringify(String(SEED_PORT))}; return true; })()`);
  const lanState = await state();
  log('lan_state', { hostValue: lanState.hostValue, port: lanState.port });
  if (lanState.hostValue !== UNREACHABLE_HOST) throw new Error('precondition: the unreachable host in the field');
  const unreachableTarget = `http://${UNREACHABLE_HOST}:${SEED_PORT}/v1`;
  const leg1 = await runLeg({
    name: 'row1_unreachable_host',
    expected: `${unreachableTarget} に届きません。IP・LM Studio 側の起動・macOS の「ローカルネットワーク」権限（STARFALL MAGIC ACADEMY）を確認してください。`
  });
  const leg1Response = (await fetches()).at(-1)?.response;
  log('row1_unreachable_host: server_payload', leg1Response ? JSON.parse(leg1Response) : null);
  check('row1_unreachable_host: server cause_code is an unreachable code', ['EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(leg1Response ? JSON.parse(leg1Response).cause_code : null));
  void leg1;

  // (2) refused port — real network. Point the host at loopback and the port at a just-closed loopback port
  // (input events only: the model fetch reads the fields directly, so no PATCH is needed for this leg).
  const refusedPort = await closedLoopbackPort();
  await js(`(() => { const h = document.querySelector('#lmstudio-host'); h.value = '127.0.0.1'; h.dispatchEvent(new Event('input', { bubbles: true })); const p = document.querySelector('#lmstudio-port'); p.value = ${JSON.stringify(String(refusedPort))}; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const localhostState = await state();
  log('localhost_state', { hostValue: localhostState.hostValue, port: localhostState.port });
  if (localhostState.hostValue !== '127.0.0.1' || localhostState.port !== String(refusedPort)) throw new Error('precondition: loopback host with the closed port in the field');
  const refusedTarget = `http://127.0.0.1:${refusedPort}/v1`;
  await runLeg({
    name: 'row2_refused_port',
    expected: `${refusedTarget} は在りますが、この port で LM Studio が待ち受けていません。`
  });
  const leg2Response = (await fetches()).at(-1)?.response;
  log('row2_refused_port: server_payload', leg2Response ? JSON.parse(leg2Response) : null);
  check('row2_refused_port: server cause_code is ECONNREFUSED', (leg2Response ? JSON.parse(leg2Response).cause_code : null) === 'ECONNREFUSED');

  // (3) code off-table — stubbed 502.
  const stubTarget = 'http://192.168.11.250:1234/v1';
  await runLeg({
    name: 'row3_code_off_table',
    stub: { status: 502, payload: { error: 'LM Studio model list request failed: fetch failed', error_code: 'LMSTUDIO_MODEL_LIST_UNAVAILABLE', target: stubTarget, cause_code: 'ENETUNREACH' } },
    expected: `${stubTarget} への接続に失敗しました（ENETUNREACH）。`
  });

  // (4) cause_message without cause_code — stubbed 502.
  const stubTarget4 = 'http://127.0.0.1:1/v1';
  await runLeg({
    name: 'row4_cause_message',
    stub: { status: 502, payload: { error: 'LM Studio model list request failed: fetch failed', error_code: 'LMSTUDIO_MODEL_LIST_UNAVAILABLE', target: stubTarget4, cause_message: 'bad port' } },
    expected: `${stubTarget4} への接続に失敗しました（bad port）。`
  });

  dbg.detach();
  console.log(`ALL CHECKS: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => { try { server?.close(); } catch {} process.exit(exitCode); });
