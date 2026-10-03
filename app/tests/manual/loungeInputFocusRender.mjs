// Render-backed lounge input focus check (Electron / real Blink layout + real client flow).
//
// Keyboard focus goes into #academy-lounge-input when the player's turn opens (the round's NPCs have all spoken), so
// the next utterance is typed and sent without a mouse — only while the lounge screen is active, the lounge talk is
// live, no lounge popup is open and the input is open, and without moving a scrolled-up read position.
// `node --test` cannot run app.js (no DOM / focus / layout), so this drives the REAL client in Electron. Not a
// *.test.mjs (npm test skips it); run it by hand with the directory the screenshots are written to:
//
//   LOUNGE_FOCUS_SHOT_DIR=<dir> ./node_modules/.bin/electron app/tests/manual/loungeInputFocusRender.mjs
//
// One isolated routing server with a deterministic LM stub, entered through ?initialScreen=academy-lounge. A focus()
// probe, installed before app.js runs, records every focus call on the input (options, scroll positions before and
// after, which screen was active) and every opening of the input, so a no-op is observable, not inferred.
// Cases: the entry with a fast LM, where the first player turn opens while the entry loading cover is still up (the
// lounge screen is not active); the landing turn, keyboard-only turns, keys typed during the NPCs' replies, an open
// stage / speaker popup, and the terminal all-exit auto completion. Two states cannot arise at the instant the
// player's turn opens in the real client (the input is opened right before the focus, and every revealed 吹き出し
// re-pins the stream to the bottom): a closed input and a scrolled-up stream. Those are set there through a CDP
// breakpoint, then the real code runs on.
// The harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const SHOT_DIR = process.env.LOUNGE_FOCUS_SHOT_DIR;
if (!SHOT_DIR) throw new Error('LOUNGE_FOCUS_SHOT_DIR is required (the directory the screenshots are written to)');
const WIN_W = 1200;
const WIN_H = 820;
const PERSONA_VARIANT = 'fallen_star';

const FIRST_INPUT = 'みんな、こんばんは。混ぜてもらってもいいかな';
const SECOND_INPUT = 'キーボードだけで続けて話しかけるよ';
const TYPING_INPUT = 'みんなの話を聞きながら打ちかけてみる';
const SCROLL_INPUT = '前の話を読み返したいんだ';
const STAGE_POPUP_INPUT = 'この部屋のことを教えて';
const SPEAKER_POPUP_INPUT = 'あなたのことをもっと知りたい';
const CLOSED_INPUT = 'もう少しだけ話そう';
const END_INPUT = 'そろそろ今日はお開きにしよう';
const DRAFT_TEXT = 'かきかけ';
// A multi-吹き出し reply (地の文 + 発話 alternating) so each NPC's reveal runs long enough to act during it and the
// stream overflows after a round.
const REPLY_TEXT = '（小さく笑って）ええ、もちろんです。今夜の談話室は静かで落ち着きますね。（暖炉の火に目をやって）こうして集まっていると、時間がゆっくり流れていくように感じます。（あなたに向き直って）それで、次は何の話をしましょうか。';
const FAST_TEXT = 'ええ、そうですね。';
const DEPARTURE_TEXT = '（立ち上がって）では、私はこれで失礼しますね。おやすみなさい。';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// One stub for the whole run. The finalization / judgment prompts embed the transcript (and so the player inputs),
// so they are matched before the NPC utterance. `mode` switches the NPC utterance ('fast' = one short 吹き出し,
// 'normal' = the long reply) and the lounge continuation judgment ('end' = every NPC leaves → auto completion).
async function startStubLm() {
  const stub = { prompts: [], mode: 'normal' };
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    const prompt = body.messages?.[0]?.content ?? '';
    stub.prompts.push(prompt);
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (prompt.includes('skill_record作成の必要性判定')) content = 'false';
    else if (prompt.includes('のタイトルと本文を平文で出力する')) content = 'タイトル: 談話室の夜\n本文: 談話室で主人公と言葉を交わした。';
    else if (prompt.includes('memory_recordの本文だけ')) content = '談話室で主人公と穏やかに話した。';
    else if (prompt.includes('好感度の変化量を判定する')) content = '0';
    else if (prompt.includes('この談話の場に残っていたいと思っているか')) content = stub.mode === 'end' ? 'false' : 'true';
    else if (prompt.includes('この談話の場から自分だけが退出する')) content = DEPARTURE_TEXT;
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) content = 'none';
    else if (prompt.includes('継続したいと思うか')) content = 'true';
    else if (prompt.includes('MP温存ライン')) content = '30';
    else if (prompt.includes('増減したユーザーの所持金を判定する') || prompt.includes('所持金判定')) content = '0';
    else content = stub.mode === 'fast' ? FAST_TEXT : REPLY_TEXT;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stub.server = server;
  stub.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return stub;
}

async function makeFixture() {
  const root = await fixtureRoot('lounge-focus-');
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: REPO_CANONICAL,
    publicRoot: PUBLIC_ROOT,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lounge-focus-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: PERSONA_VARIANT }, null, 2)}\n`, 'utf8');
  cleanupPaths.push(root, settingsDir);
  return { root, settingsPath };
}

async function startGameServer({ root, settingsPath }) {
  const server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

let lm;
const servers = [];
const cleanupPaths = [];
let exitCode = 0;

// ── window / CDP helpers ─────────────────────────────────────────────────────
async function openWindow() {
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });
  return win;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);
const cdp = (win, method, params = {}) => win.webContents.debugger.sendCommand(method, params);

// Attach CDP once a real page is loaded (a command sent while the window still holds its initial blank page never
// returns). A hidden window is never the OS-focused window; emulate page focus so focus()/activeElement and CDP key
// input behave as in the player's focused window.
async function enableCdp(win) {
  if (win.webContents.debugger.isAttached()) return;
  win.webContents.debugger.attach('1.3');
  await cdp(win, 'Emulation.setFocusEmulationEnabled', { enabled: true });
}

// Installed on every new document before app.js runs, so the focus call made when the first player turn opens (during
// the entry) is recorded too. __loungeFocusLog: every focus() on the input. __loungeTurnOpenLog: every time the input
// goes from disabled to open, with which screen was active at that instant.
const PROBE_SOURCE = `(() => {
  window.__loungeFocusLog = [];
  window.__loungeTurnOpenLog = [];
  const screenState = () => ({
    loungeActive: !!document.querySelector('#academy-lounge-screen')?.classList.contains('active'),
    loaderActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active')
  });
  const original = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focusProbe(options) {
    if (this.id !== 'academy-lounge-input') return original.call(this, options);
    const stream = document.querySelector('#academy-lounge-message-stream');
    const entry = {
      options: options ?? null,
      ...screenState(),
      streamScrollBefore: stream.scrollTop,
      pageScrollBefore: document.scrollingElement.scrollTop
    };
    original.call(this, options);
    entry.streamScrollAfter = stream.scrollTop;
    entry.pageScrollAfter = document.scrollingElement.scrollTop;
    entry.activeIsInput = document.activeElement === this;
    window.__loungeFocusLog.push(entry);
  };
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.querySelector('#academy-lounge-input');
    let wasDisabled = input.disabled;
    new MutationObserver(() => {
      if (wasDisabled && !input.disabled) window.__loungeTurnOpenLog.push(screenState());
      wasDisabled = input.disabled;
    }).observe(input, { attributes: true, attributeFilter: ['disabled'] });
  });
})();`;

async function installProbeForNextLoads(win) {
  await enableCdp(win);
  await cdp(win, 'Page.enable');
  await cdp(win, 'Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE });
}

async function waitFor(win, predicate, { tries = 300, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await js(win, `(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function cdpClick(win, selector) {
  const rect = await js(win, `(() => {
    const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  })()`);
  if (!rect) throw new Error(`cdpClick: ${selector} has no layout box`);
  await cdp(win, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp(win, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp(win, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

const cdpType = (win, text) => cdp(win, 'Input.insertText', { text });
async function cdpEnter(win) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp(win, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' });
  await cdp(win, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

const focusLogLength = (win) => js(win, `window.__loungeFocusLog.length`);
const focusLogSince = (win, index) => js(win, `window.__loungeFocusLog.slice(${index})`);

function readFocusState(win) {
  return js(win, `(() => {
    const input = document.querySelector('#academy-lounge-input');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      activeElementId: document.activeElement?.id || document.activeElement?.tagName || null,
      activeIsInput: document.activeElement === input,
      inputDisabled: input.disabled,
      inputValue: input.value
    };
  })()`);
}

async function shot(win, name) {
  await js(win, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  win.webContents.invalidate();
  await win.webContents.capturePage();
  const image = await win.webContents.capturePage();
  const file = path.join(SHOT_DIR, `${name}.png`);
  await fs.writeFile(file, image.toPNG());
  return file;
}

const loungeLanded = `
  document.querySelector('#academy-lounge-screen')?.classList.contains('active')
  && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  && !document.querySelector('#academy-lounge-input')?.disabled
  && document.querySelectorAll('#academy-lounge-message-stream .chat-message').length > 0
`;

// A round is in flight while the input is closed (setControlsDisabled covers every NPC utterance of the round). Wait
// for it to close after a send, then for the player's turn to reopen it.
async function waitRoundStarted(win) {
  return waitFor(win, `document.querySelector('#academy-lounge-input').disabled`, { tries: 100, intervalMs: 20 });
}
async function waitPlayerTurn(win) {
  return waitFor(win, `!document.querySelector('#academy-lounge-input').disabled`, { tries: 900, intervalMs: 100 });
}

// Send the player's turn by keyboard only: CDP text insertion into whatever holds focus + a CDP Enter.
async function keyboardTurn(win, text) {
  const before = lm.prompts.length;
  await cdpType(win, text);
  await cdpEnter(win);
  const started = await waitRoundStarted(win);
  return { started, before };
}

async function appJsLine(needle, afterNeedle) {
  const lines = (await fs.readFile(path.join(PUBLIC_ROOT, 'app.js'), 'utf8')).split('\n');
  const start = lines.findIndex((line) => line.startsWith(afterNeedle));
  if (start < 0) throw new Error(`app.js has no line starting with ${afterNeedle}`);
  const index = lines.findIndex((line, i) => i > start && line === needle);
  if (index < 0) throw new Error(`app.js has no line ${JSON.stringify(needle)} after ${afterNeedle}`);
  return index;
}

// Arm a one-shot breakpoint at a given app.js line (0-based); when it is hit, evaluate an expression in that frame and
// resume. Resolves once the breakpoint is set, with { evaluated }: the promise of the evaluated value.
async function armEvaluateOnceAtLine(win, lineNumber, expression) {
  await cdp(win, 'Debugger.enable');
  const { breakpointId } = await cdp(win, 'Debugger.setBreakpointByUrl', { urlRegex: '/app\\.js$', lineNumber });
  const evaluated = new Promise((resolve, reject) => {
    const onMessage = async (_event, method, params) => {
      if (method !== 'Debugger.paused') return;
      win.webContents.debugger.removeListener('message', onMessage);
      try {
        const result = await cdp(win, 'Debugger.evaluateOnCallFrame', { callFrameId: params.callFrames[0].callFrameId, expression, returnByValue: true });
        await cdp(win, 'Debugger.removeBreakpoint', { breakpointId });
        await cdp(win, 'Debugger.resume');
        resolve(result.result?.value ?? result.exceptionDetails ?? null);
      } catch (error) {
        reject(error);
      }
    };
    win.webContents.debugger.on('message', onMessage);
  });
  return { evaluated };
}

// A round during which a popup is opened (by clicking its opener mid-reply): when the player's turn opens the focus
// must not be put into the input (no focus() call), and the popup is still open.
async function popupRound(win, { input, label, open, popupSelector, close }) {
  const logBefore = await focusLogLength(win);
  const turn = await keyboardTurn(win, input);
  await sleep(400);
  await open();
  const opened = await waitFor(win, `document.querySelector(${JSON.stringify(popupSelector)})?.hidden === false`, { tries: 50, intervalMs: 50 });
  const done = turn.started && await waitPlayerTurn(win);
  await sleep(200);
  const after = await readFocusState(win);
  const popupStillOpen = await js(win, `document.querySelector(${JSON.stringify(popupSelector)})?.hidden === false`);
  const logAfter = await focusLogLength(win);
  const popupShot = await shot(win, `${label}-open-no-focus`);
  check(`${label} open when the player's turn opens: focus is NOT put into the input`,
    opened && done && popupStillOpen && !after.activeIsInput && logAfter === logBefore,
    { opened, done, popupStillOpen, focusCallsDuringRound: logAfter - logBefore, ...after, shot: popupShot });
  await js(win, `document.querySelector(${JSON.stringify(close)}).click(); true`);
  await waitFor(win, `document.querySelector(${JSON.stringify(popupSelector)})?.hidden === true`, { tries: 50, intervalMs: 50 });
  // Back to the input by a click (the player's own act) for the next keyboard turn.
  await cdpClick(win, '#academy-lounge-input');
}

// ── scenario ─────────────────────────────────────────────────────────────────
async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  lm = await startStubLm();
  await app.whenReady();
  const fixture = await makeFixture();
  const base = await startGameServer(fixture);
  const win = await openWindow();
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
  await installProbeForNextLoads(win);

  // Screen not active: with a fast LM the first round's three NPCs have all spoken while the entry loading cover is
  // still up, so the player's turn opens with the lounge screen inactive — the focus must not be put in.
  {
    lm.mode = 'fast';
    await win.loadURL(`${base}/?initialScreen=academy-lounge`);
    const landed = await waitFor(win, loungeLanded, { tries: 400, intervalMs: 50 });
    const turnOpens = await js(win, `window.__loungeTurnOpenLog`);
    const focusLog = await js(win, `window.__loungeFocusLog`);
    const after = await readFocusState(win);
    const inactiveShot = await shot(win, 'screen-inactive-at-turn-open-no-focus');
    const firstOpen = turnOpens[0] ?? null;
    check('screen not active: the first player turn opens under the entry loading cover and focus is NOT put into the input',
      landed && firstOpen !== null && firstOpen.loungeActive === false && firstOpen.loaderActive === true
        && focusLog.length === 0 && !after.activeIsInput,
      { landed, turnOpens, focusLog, ...after, shot: inactiveShot });
  }

  // Landing: with a real-paced reply the first round ends after the loading cover has handed over, so on landing — no
  // click, no harness focus() — the focus is already in the input, put there with preventScroll.
  lm.mode = 'normal';
  await win.loadURL(`${base}/?initialScreen=academy-lounge`);
  const landed = await waitFor(win, loungeLanded, { tries: 600, intervalMs: 100 });
  {
    const turnOpens = await js(win, `window.__loungeTurnOpenLog`);
    const focusLog = await js(win, `window.__loungeFocusLog`);
    const after = await readFocusState(win);
    const matchesFocus = await js(win, `document.querySelector('#academy-lounge-input').matches(':focus')`);
    await sleep(500);
    const landShot = await shot(win, 'landing-player-turn-focused');
    check('landing: when the first player turn opens, document.activeElement is #academy-lounge-input (no click), focus() with preventScroll',
      landed && after.activeIsInput && matchesFocus && after.activeScreenId === 'academy-lounge-screen'
        && turnOpens.length === 1 && turnOpens[0].loungeActive === true
        && focusLog.length === 1 && focusLog[0].options?.preventScroll === true && focusLog[0].loungeActive === true,
      { landed, turnOpens, focusLog, ...after, matchesFocus, shot: landShot });
  }

  // Keyboard only (acceptance 1): the first and the second utterance go out with keys alone (no click, no harness
  // focus()); each reaches the server transcript and the next round's NPC prompts, and focus is back in the input
  // when the next player turn opens. The focus is put in exactly once per round — never while the NPCs speak.
  for (const [label, text] of [['first', FIRST_INPUT], ['second', SECOND_INPUT]]) {
    const logBefore = await focusLogLength(win);
    const turn = await keyboardTurn(win, text);
    const midRound = await readFocusState(win);
    const done = turn.started && await waitPlayerTurn(win);
    await sleep(200);
    const after = await readFocusState(win);
    const entries = await focusLogSince(win, logBefore);
    const inStream = await js(win, `(document.querySelector('#academy-lounge-message-stream')?.textContent || '').includes(${JSON.stringify(text)})`);
    const lmSaw = lm.prompts.slice(turn.before).some((prompt) => prompt.includes(text));
    const turnShot = await shot(win, `keyboard-only-${label}-turn`);
    check(`keyboard only (${label}): the utterance is typed + sent with keys only, reaches the NPCs, and focus is back in the input at the next player turn`,
      done && inStream && lmSaw && midRound.inputDisabled && after.activeIsInput && entries.length === 1
        && entries[0].options?.preventScroll === true && after.inputValue === '',
      { done, inStream, lmSawInput: lmSaw, midRound, focusCallsDuringRound: entries.length, entries, ...after, shot: turnShot });
  }

  // Typing: keys typed while the NPCs are speaking land nowhere (the input is closed) and clear nothing; when the turn
  // opens the focus comes once, a draft typed there stays intact, and no later focus() pulls the caret while typing.
  {
    const logBefore = await focusLogLength(win);
    const turn = await keyboardTurn(win, TYPING_INPUT);
    await sleep(500);
    const midRound = await readFocusState(win);
    await cdpType(win, DRAFT_TEXT);
    const afterMidTyping = await readFocusState(win);
    const done = turn.started && await waitPlayerTurn(win);
    await sleep(200);
    const afterTurn = await readFocusState(win);
    await cdpType(win, DRAFT_TEXT);
    await sleep(300);
    await cdpType(win, DRAFT_TEXT);
    await sleep(1000);
    const afterDraft = await readFocusState(win);
    const caret = await js(win, `(() => { const el = document.querySelector('#academy-lounge-input'); return { start: el.selectionStart, end: el.selectionEnd, length: el.value.length }; })()`);
    const focusCalls = (await focusLogLength(win)) - logBefore;
    const draftShot = await shot(win, 'typing-draft-kept');
    check('typing: keys typed while the NPCs speak do not land in the input; at the player turn focus comes once and a draft typed there is never interrupted',
      done && midRound.inputDisabled && afterMidTyping.inputValue === '' && afterTurn.activeIsInput && afterTurn.inputValue === ''
        && afterDraft.inputValue === DRAFT_TEXT + DRAFT_TEXT && afterDraft.activeIsInput && focusCalls === 1
        && caret.start === caret.length && caret.end === caret.length,
      { midRound, afterMidTyping, afterTurn, afterDraft, caret, focusCalls, shot: draftShot });
    // Clear the draft with keys (select-all + delete) so the next turn starts from an empty input.
    await js(win, `document.querySelector('#academy-lounge-input').select(); true`);
    await cdp(win, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp(win, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }

  const focusCallLine = await appJsLine('    focusLoungeInputIfContinuing();', 'function runLoungePlayerTurn() {');

  // Scrolled-up read position: the stream is scrolled to the top at the instant the player's turn opens (breakpoint at
  // the focus call); the focus must use preventScroll and leave the stream (and page) scroll untouched.
  {
    const logBefore = await focusLogLength(win);
    const paused = await armEvaluateOnceAtLine(win, focusCallLine, `(() => {
      const s = document.querySelector('#academy-lounge-message-stream');
      s.scrollTop = 0;
      return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollTop: s.scrollTop };
    })()`);
    const turn = await keyboardTurn(win, SCROLL_INPUT);
    const atPause = await paused.evaluated;
    const done = turn.started && await waitPlayerTurn(win);
    await sleep(200);
    const after = await readFocusState(win);
    const entries = await focusLogSince(win, logBefore);
    const finalScroll = await js(win, `document.querySelector('#academy-lounge-message-stream').scrollTop`);
    const scrollShot = await shot(win, 'scrolled-up-kept');
    const entry = entries[0] ?? null;
    check('scrolled up: the read position is not pulled back — focus() uses preventScroll and the stream/page scroll are unchanged across it',
      atPause.scrollHeight > atPause.clientHeight && atPause.scrollTop === 0 && done && entries.length === 1
        && entry.options?.preventScroll === true && entry.streamScrollBefore === 0 && entry.streamScrollAfter === 0
        && entry.pageScrollBefore === entry.pageScrollAfter && finalScroll === 0 && after.activeIsInput,
      { atPause, done, entries, finalScroll, ...after, shot: scrollShot });
    await js(win, `(() => { const s = document.querySelector('#academy-lounge-message-stream'); s.scrollTop = s.scrollHeight; })(); true`);
  }

  await popupRound(win, {
    input: STAGE_POPUP_INPUT,
    label: 'stage-popup',
    open: () => cdpClick(win, '#academy-lounge-stage-image'),
    popupSelector: '#academy-lounge-stage-popup',
    close: '#academy-lounge-stage-popup .conversation-day-info-popup-close'
  });
  await popupRound(win, {
    input: SPEAKER_POPUP_INPUT,
    label: 'speaker-popup',
    open: () => js(win, `document.querySelector('#academy-lounge-message-stream .chat-message[data-character-id] .message-speaker, #academy-lounge-message-stream .chat-message[data-character-id]').click(); true`),
    popupSelector: '#academy-lounge-character-popup',
    close: '#academy-lounge-character-popup .conversation-day-info-popup-close'
  });

  // Input closed at the instant the turn opens (breakpoint at the focus call sets it disabled): no focus() call.
  {
    const logBefore = await focusLogLength(win);
    const paused = await armEvaluateOnceAtLine(win, focusCallLine, `(() => {
      document.querySelector('#academy-lounge-input').disabled = true;
      return document.querySelector('#academy-lounge-input').disabled;
    })()`);
    const turn = await keyboardTurn(win, CLOSED_INPUT);
    const disabledAtPause = await paused.evaluated;
    const reachedPlayerTurn = turn.started && await waitFor(win, `document.querySelector('#academy-lounge-end') && !document.querySelector('#academy-lounge-end').disabled`, { tries: 900, intervalMs: 100 });
    await sleep(300);
    const after = await readFocusState(win);
    const logAfter = await focusLogLength(win);
    const closedShot = await shot(win, 'input-closed-no-focus');
    check('input closed: when the input is not open at the player turn, focus is NOT put into it',
      disabledAtPause === true && reachedPlayerTurn && after.inputDisabled && !after.activeIsInput && logAfter === logBefore,
      { disabledAtPause, reachedPlayerTurn, focusCallsDuringRound: logAfter - logBefore, ...after, shot: closedShot });
    await js(win, `document.querySelector('#academy-lounge-input').disabled = false; true`);
    await cdpClick(win, '#academy-lounge-input');
  }

  // Terminal: every NPC leaves in the next round → the auto completion returns to the hub without ever opening the
  // input; no focus() on the lounge input, and the hub keeps its own focus.
  {
    lm.mode = 'end';
    const logBefore = await focusLogLength(win);
    const opensBefore = await js(win, `window.__loungeTurnOpenLog.length`);
    const turn = await keyboardTurn(win, END_INPUT);
    const settled = turn.started && await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 900, intervalMs: 100 });
    await sleep(500);
    const after = await readFocusState(win);
    const logAfter = await focusLogLength(win);
    const opensAfter = await js(win, `window.__loungeTurnOpenLog.length`);
    const endShot = await shot(win, 'terminal-auto-completion-no-focus');
    check('terminal: the all-exit auto completion returns to the hub without opening the lounge input or focusing it',
      settled && after.activeScreenId === 'routing-hub-screen' && !after.activeIsInput && logAfter === logBefore && opensAfter === opensBefore,
      { settled, focusCallsDuringRound: logAfter - logBefore, turnOpensDuringRound: opensAfter - opensBefore, ...after, shot: endShot });
  }
  win.destroy();

  const failed = results.filter((result) => !result.pass);
  log('summary', { total: results.length, failed: failed.length });
  if (failed.length > 0) exitCode = 1;
}

async function cleanup() {
  for (const server of servers) await new Promise((r) => server.close(r));
  if (lm) await new Promise((r) => lm.server.close(r));
  for (const target of cleanupPaths) await fs.rm(target, { recursive: true, force: true });
}

main()
  .catch((error) => {
    console.error(error);
    exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    app.exit(exitCode);
  });
