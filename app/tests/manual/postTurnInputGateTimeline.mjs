// Three-time timeline of routing hub turns against the real client (Electron / real Blink, real SSE pump).
//
// For each player input, sent in order and only once the hub input has reopened, it records:
//   - when each character bubble was displayed (a row added to #routing-hub-message-stream),
//   - when the turn stream's `result` (or `error`) arrived — the end of the turn's post-processing,
//   - when the hub input reopened (#routing-hub-input and #routing-hub-send enabled again),
// plus whether the client moved to #settings-screen, and every 会話終了判定 (continuation judgment) prompt and
// answer the turn produced (from GET /api/debug/llm-requests).
//
// Not a *.test.mjs: `npm test` skips it. Run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/postTurnInputGateTimeline.mjs \
//     [--lm-config <lmstudio.json>] [--inputs <inputs.json>] [--out <record.json>] \
//     [--project-root <checkout>] [--turn-timeout-ms <ms>]
//
//   --lm-config     LM Studio config JSON (the shape of app/config/lmstudio.example.json). Omitted: an in-process
//                   stub LM answers every request (continuation judgment always 'true').
//   --inputs        JSON array of player inputs, sent in order. Omitted: three fixed inputs.
//   --out           Writes the whole record as JSON to this path (the record is also printed to stdout).
//   --project-root  The checkout whose server and client run (default: the checkout holding this file). Point it
//                   at an extract of another commit to time that implementation; the canonical assets are read from
//                   the checkout holding this file.
//
// It always plays in an isolated temp root (deleted on exit) and never reads or writes data/mutable/.
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_INPUTS = ['こんにちは。今週はどう過ごそうか迷っています。', '最近、図書館で調べものをしていました。', 'もう少し話を聞かせてください。'];
const STUB_REPLY_TEXT = '……なるほど、その話をもう少し聞かせてください。';
const TARGET_WEEK = 10;

function parseArgs(argv) {
  const scriptIndex = argv.findIndex((arg) => arg.endsWith('postTurnInputGateTimeline.mjs'));
  const args = argv.slice(scriptIndex + 1).filter((arg) => arg !== '--');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`unexpected argument: ${key}`);
    options[key.slice(2)] = value;
  }
  const known = new Set(['lm-config', 'inputs', 'out', 'project-root', 'turn-timeout-ms']);
  for (const key of Object.keys(options)) if (!known.has(key)) throw new Error(`unknown option --${key}`);
  return options;
}

const options = parseArgs(process.argv);
const PROJECT_ROOT = path.resolve(options['project-root'] ?? HARNESS_ROOT);
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const CANONICAL_ROOT = path.join(HARNESS_ROOT, 'assets/canonical');
const TURN_TIMEOUT_MS = Number(options['turn-timeout-ms'] ?? 600000);
if (!Number.isFinite(TURN_TIMEOUT_MS) || TURN_TIMEOUT_MS <= 0) throw new Error(`invalid --turn-timeout-ms: ${options['turn-timeout-ms']}`);
const inputs = options.inputs ? JSON.parse(await fs.readFile(path.resolve(options.inputs), 'utf8')) : DEFAULT_INPUTS;
if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((input) => typeof input !== 'string' || !input.trim())) {
  throw new Error('--inputs must be a JSON array of non-empty strings');
}
const lmConfigFromFile = options['lm-config'] ? JSON.parse(await fs.readFile(path.resolve(options['lm-config']), 'utf8')) : null;

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
const { resolvePlayRoot, resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const progress = (stage, detail = {}) => console.log(`STAGE ${stage} ${JSON.stringify(detail)}`);

async function startStubLm() {
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const prompt = body.messages?.map((message) => message.content).join('\n') ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) content = 'true';
    else if (prompt.includes('destination_id')) content = 'none';
    else content = STUB_REPLY_TEXT;
    await sleep(200);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    config: { base_url: `http://127.0.0.1:${server.address().port}/v1`, chat_model: 'stub-chat', reflection_model: 'stub-reflection', timeout_ms: 30000, stream: false }
  };
}

async function routingFixture() {
  const root = await fixtureRoot('post-turn-input-gate-timeline-');
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: CANONICAL_ROOT,
    publicRoot: PUBLIC_ROOT,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-turn-input-gate-timeline-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

// Routing mode keeps its runtime state per save slot; seed the active slot's elapsed_weeks (第N週 = elapsed+1).
async function seedActiveSlotElapsedWeeks(root, weeks) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  const slotId = active.active_slot_id ?? active.slot_id ?? active.active_slot ?? null;
  if (!slotId) throw new Error(`no active routing slot to seed: ${JSON.stringify(active)}`);
  const statePath = path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.elapsed_weeks = weeks;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

async function waitFor(win, predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await js(win, `(() => { try { return !!(${predicate}); } catch { return false; } })()`)) return true;
    await sleep(intervalMs);
  }
  return false;
}

const HUB_READY = `
  document.querySelector('#routing-hub-screen')?.classList.contains('active')
  && !document.querySelector('#routing-hub-send')?.disabled
  && !document.querySelector('#routing-hub-input')?.disabled
  && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
`;

async function loadSlotIntoHub(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1200);
  await js(win, `document.querySelector('.screen-tabs button[data-screen="slot-load"]')?.click(); true`);
  const listed = await waitFor(win, `
    document.querySelector('#slot-load-screen')?.classList.contains('active')
    && document.querySelector('#slot-load-list .slot-load-item .academy-map-action-button.primary:not([disabled])')
  `, 30000);
  if (!listed) throw new Error('slot load list did not appear');
  await js(win, `document.querySelector('#slot-load-list .slot-load-item .academy-map-action-button.primary:not([disabled])')?.click(); true`);
  if (!await waitFor(win, HUB_READY, TURN_TIMEOUT_MS)) throw new Error('the seeded slot did not land on a ready routing hub');
}

// Page-side recorder: tees the turn stream to timestamp its SSE events, and observes the hub stream and input to
// timestamp each displayed character bubble and the input reopening. All times are the page's Date.now().
const INSTALL_RECORDER = `(() => {
  if (window.__turnTimeline) return true;
  const recorder = { current: null };
  window.__turnTimeline = recorder;
  const stream = document.querySelector('#routing-hub-message-stream');
  const characterRows = () => [...stream.querySelectorAll('.chat-message')]
    .filter((row) => !row.classList.contains('player-message') && !row.classList.contains('player-narration-message'));
  new MutationObserver(() => {
    const turn = recorder.current;
    if (!turn) return;
    const rows = characterRows();
    while (rows.length > turn.shownCount) {
      const row = rows[turn.shownCount];
      turn.bubbles.push({ at: Date.now(), text: (row.querySelector('p')?.textContent || row.textContent || '').trim() });
      turn.shownCount += 1;
    }
  }).observe(stream, { childList: true, subtree: true });
  const inputOpen = () => !document.querySelector('#routing-hub-input')?.disabled && !document.querySelector('#routing-hub-send')?.disabled;
  const noteInput = () => {
    const turn = recorder.current;
    if (!turn) return;
    const open = inputOpen();
    if (!open) turn.closedSeen = true;
    if (open && turn.closedSeen && turn.inputOpenedAt === null) turn.inputOpenedAt = Date.now();
  };
  const inputObserver = new MutationObserver(noteInput);
  for (const selector of ['#routing-hub-input', '#routing-hub-send']) {
    inputObserver.observe(document.querySelector(selector), { attributes: true, attributeFilter: ['disabled'] });
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (resource, init) => {
    const url = typeof resource === 'string' ? resource : resource.url;
    const response = await originalFetch(resource, init);
    const turn = recorder.current;
    if (!turn || !url.includes('/api/conversation/stream')) return response;
    turn.httpStatus = response.status;
    if (!response.ok || !response.body) return response;
    const [mine, theirs] = response.body.tee();
    (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const take = (block) => {
        const event = block.split('\\n').find((line) => line.startsWith('event: '))?.slice(7);
        const dataText = block.split('\\n').find((line) => line.startsWith('data: '))?.slice(6);
        if (!event) return;
        const at = Date.now();
        turn.events.push({ event, at });
        if (event === 'result' || event === 'error') {
          turn.endedAt = at;
          turn.endEvent = event;
          if (event === 'error') {
            const data = dataText ? JSON.parse(dataText) : {};
            turn.error = { error: data.error ?? null, error_code: data.error_code ?? null };
          }
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const blocks = buffer.split('\\n\\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) if (block.trim()) take(block);
        if (done) break;
      }
      if (buffer.trim()) take(buffer);
    })();
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return true;
})()`;

async function recentContinuationJudgments(base, afterId) {
  const response = await fetch(`${base}/api/debug/llm-requests`);
  if (!response.ok) throw new Error(`/api/debug/llm-requests ${response.status}`);
  const { requests } = await response.json();
  const idNumber = (id) => Number(String(id).replace(/^llm_request_/, ''));
  return {
    lastId: requests.reduce((max, request) => Math.max(max, idNumber(request.id)), afterId),
    judgments: requests
      .filter((request) => idNumber(request.id) > afterId && request.title === '会話終了判定')
      .map((request) => ({ question: request.input, answer: request.output }))
  };
}

async function runTurn(win, base, playerInput, lastRequestId) {
  await js(win, `(() => {
    const turn = { shownCount: 0, bubbles: [], events: [], closedSeen: false, inputOpenedAt: null, endedAt: null, endEvent: null, error: null, httpStatus: null, sentAt: null };
    turn.shownCount = [...document.querySelectorAll('#routing-hub-message-stream .chat-message')]
      .filter((row) => !row.classList.contains('player-message') && !row.classList.contains('player-narration-message')).length;
    window.__turnTimeline.current = turn;
    return true;
  })()`);
  // Right after the hub opens, the client still holds its in-flight flag across the opening reveal with the send
  // enabled, and a click is a silent no-op. A send that fires clears the input synchronously; retry until it does.
  let sentAt = null;
  for (let attempt = 0; attempt < 60 && sentAt === null; attempt += 1) {
    sentAt = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (input.disabled || send.disabled) return null;
      input.value = ${JSON.stringify(playerInput)};
      const at = Date.now();
      send.click();
      if (input.value !== '') return null;
      window.__turnTimeline.current.sentAt = at;
      return at;
    })()`);
    if (sentAt === null) await sleep(250);
  }
  if (sentAt === null) throw new Error(`the hub send never fired for: ${playerInput}`);
  const settled = await waitFor(win, `(() => {
    const turn = window.__turnTimeline.current;
    if (document.querySelector('#settings-screen')?.classList.contains('active')) return true;
    if (!document.querySelector('#routing-hub-screen')?.classList.contains('active')) return turn.endedAt !== null;
    return turn.endedAt !== null && turn.inputOpenedAt !== null;
  })()`, TURN_TIMEOUT_MS);
  await sleep(300);
  const turn = await js(win, `(() => {
    const turn = window.__turnTimeline.current;
    window.__turnTimeline.current = null;
    return {
      sentAt: turn.sentAt,
      httpStatus: turn.httpStatus,
      bubbles: turn.bubbles,
      events: turn.events,
      endEvent: turn.endEvent,
      endedAt: turn.endedAt,
      inputOpenedAt: turn.inputOpenedAt,
      error: turn.error,
      activeScreen: document.querySelector('.screen.active')?.id ?? null,
      hubStatus: (document.querySelector('#routing-hub-status')?.textContent || '').trim()
    };
  })()`);
  const { lastId, judgments } = await recentContinuationJudgments(base, lastRequestId);
  const relative = (at) => (at === null || at === undefined ? null : at - sentAt);
  return {
    lastId,
    record: {
      player_input: playerInput,
      settled_within_timeout: settled,
      http_status: turn.httpStatus,
      bubbles_shown_ms: turn.bubbles.map((bubble) => ({ at_ms: relative(bubble.at), text: bubble.text })),
      events_ms: turn.events.map((event) => ({ event: event.event, at_ms: relative(event.at) })),
      post_processing_end_event: turn.endEvent,
      post_processing_end_ms: relative(turn.endedAt),
      input_opened_ms: relative(turn.inputOpenedAt),
      error: turn.error,
      moved_to_settings: turn.activeScreen === 'settings-screen',
      active_screen: turn.activeScreen,
      hub_status: turn.hubStatus,
      continuation_judgments: judgments
    }
  };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server = null;
let stubLm = null;
let cleanupPaths = [];

// Electron does not await async 'quit' listeners, so the temp root is removed here before the app exits.
async function finish(exitCode) {
  server?.close();
  stubLm?.server.close();
  for (const cleanupPath of cleanupPaths) await fs.rm(cleanupPath, { recursive: true, force: true });
  app.exit(exitCode);
}

async function main() {
  stubLm = lmConfigFromFile ? null : await startStubLm();
  const lmStudioConfig = lmConfigFromFile ?? stubLm.config;
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];
  server = createServer({ root, publicRoot: PUBLIC_ROOT, canonicalAssetsRoot: CANONICAL_ROOT, playModeSettingsPath: settingsPath, lmStudioConfig });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  progress('server', { base, project_root: PROJECT_ROOT });
  await app.whenReady();
  progress('electron-ready');
  const win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  await win.loadURL(`${base}/`);
  await sleep(1200);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  if (!await waitFor(win, HUB_READY, TURN_TIMEOUT_MS)) throw new Error('new game did not land on a ready routing hub');
  progress('new-game-hub');
  await seedActiveSlotElapsedWeeks(root, TARGET_WEEK - 1);
  await loadSlotIntoHub(win, base);
  progress('seeded-slot-hub');
  const weekLabel = (await js(win, `document.querySelector('#routing-hub-week')?.textContent ?? ''`)).trim();
  if (!weekLabel.startsWith(`第${TARGET_WEEK}週`)) throw new Error(`hub did not open on week ${TARGET_WEEK}: ${weekLabel}`);
  await js(win, INSTALL_RECORDER);

  const record = {
    project_root: PROJECT_ROOT,
    lm: lmConfigFromFile ? { source: 'lm-config', base_url: lmStudioConfig.base_url, chat_model: lmStudioConfig.chat_model ?? null, reflection_model: lmStudioConfig.reflection_model ?? null } : { source: 'stub' },
    week_label: weekLabel,
    turns: []
  };
  let lastRequestId = (await recentContinuationJudgments(base, 0)).lastId;
  for (const playerInput of inputs) {
    const { lastId, record: turnRecord } = await runTurn(win, base, playerInput, lastRequestId);
    lastRequestId = lastId;
    record.turns.push(turnRecord);
    console.log(`TURN ${JSON.stringify({ ...turnRecord, continuation_judgments: turnRecord.continuation_judgments.map((judgment) => ({ answer: judgment.answer })) })}`);
    if (!turnRecord.settled_within_timeout || turnRecord.active_screen !== 'routing-hub-screen') break;
  }
  if (options.out) await fs.writeFile(path.resolve(options.out), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(`RECORD ${JSON.stringify({ week_label: record.week_label, lm: record.lm, turns: record.turns.length, out: options.out ?? null })}`);
  await finish(0);
}

app.on('window-all-closed', () => {});
main().catch(async (error) => {
  console.error('HARNESS_ERROR', error?.stack ?? error);
  await finish(3);
});
