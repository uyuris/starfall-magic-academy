// Render-backed daytime input refocus check (Electron / real Blink layout + real client flow).
//
// Keyboard focus returns to #conversation-day-input whenever the partner has finished speaking, so the next utterance
// is typed and sent without a mouse: after a non-terminal daytime turn has revealed the reply to its last 吹き出し,
// after the opening has revealed, and after a gift's reaction has revealed.
// `node --test` cannot run app.js (no DOM / focus / layout), so this drives the REAL client in Electron. Not a
// *.test.mjs (npm test skips it); run it by hand with the directory the screenshots are written to:
//
//   CD_FOCUS_SHOT_DIR=<dir> ./node_modules/.bin/electron app/tests/manual/conversationDayInputFocusRender.mjs
//
// Every daytime conversation kind runs on its own isolated routing server with a deterministic LM stub:
//   roster (学院マップの相手) / event (hub → academy-map dispatch auto-starts a pending event) / errand / study circle /
//   atelier (うちの子).
// Per kind: on landing (no click) the opening has revealed and document.activeElement must already be the input.
// The first utterance is then typed after a real (CDP) click on the input; once the reply has revealed,
// document.activeElement must be the input; the second utterance is then typed + sent with CDP key events only
// (no click, no harness focus()) and must reach the LM stub. On the roster kind, the edge cases: typing during the
// reveal, a scrolled-up read position, an open overlay (info drawer / stage popup / character popup) and the
// terminal auto-end, plus one gift (渡す from the inventory drawer) after which focus must return once the reaction
// has revealed. The atelier kind adds its own partner popup. A focus() probe records every
// focus call on the input (options + scroll positions before/after) so a no-op is observable, not inferred.
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
const SHOT_DIR = process.env.CD_FOCUS_SHOT_DIR;
if (!SHOT_DIR) throw new Error('CD_FOCUS_SHOT_DIR is required (the directory the screenshots are written to)');
const WIN_W = 1200;
const WIN_H = 820;
const PERSONA_VARIANT = 'fallen_star';

const FIRST_INPUT = 'こんにちは、少し話してもいいかな';
const SECOND_INPUT = 'キーボードだけで続けて話しかけるよ';
const REVEAL_TYPING_INPUT = '返事を読みながら打ちかけてみる';
const SCROLL_INPUT = '前の話を読み返したいんだ';
const DRAWER_INPUT = '持ち物を見ながら話すね';
const STAGE_POPUP_INPUT = 'この場所のことを教えて';
const PARTNER_POPUP_INPUT = 'あなたのことをもっと知りたい';
const END_INPUT = 'そろそろ今日はお別れしよう';
const DRAFT_TEXT = 'かきかけ';
// A multi-吹き出し reply (地の文 + 発話 alternating) so the reveal runs long enough to act during it and the stream
// overflows after a few turns.
const GIFT_REACTION = '（目を丸くして）わあ、ありがとうございます。大事にしますね。';
const REPLY_TEXT = '（小さく笑って）ええ、もちろんです。今日はとても穏やかな日ですね。（窓の外に目をやって）こうして話していると、時間がゆっくり流れていくように感じます。（あなたに向き直って）それで、次は何の話をしましょうか。';
const OPENING_TEXT = '（こちらに気づいて）あ、来てくれたんですね。どうぞ、座ってください。';
const OFFER_TITLE = '小さな頼みごと';
const OFFER_SITUATION = '放課後の中庭で、相手が困った顔で待っている。';
const OFFER_MOTIVATION = '一人では手が回らないため。';
const OFFER_APPEAL = 'あの、ひとつお願いしてもいいですか。少しだけ手を貸してほしいんです。';
const SENDOFF_TEXT = '（あなたの背をそっと押して）では、いってらっしゃい。';
const MAP_INPUT = '今週は学院を歩いて回りたい';
const EVENT_FLAG_ID = 'event.stargazing_promise.ready';
const EVENT_CHARACTER_ID = 'character_001';
const HOMUNCULUS_ID = 'homunculus_001';
const HOMUNCULUS_NAME = 'ともしび';
const HOMUNCULUS_FACE_ID = 'hp_001';

const { createServer } = await import(path.join(PROJECT_ROOT, 'app/src/server.mjs'));
const { fixtureRoot, writeJson } = await import(path.join(PROJECT_ROOT, 'app/tests/helpers.mjs'));
const { runtimePathsManifestFilename } = await import(path.join(PROJECT_ROOT, 'app/src/runtimePaths.mjs'));
const { initializeNewPlayArea, resolvePlayRoot, resolveSlotProjectRoot } = await import(path.join(PROJECT_ROOT, 'app/src/playSession.mjs'));

const log = (label, obj) => console.log(`${label}: ${JSON.stringify(obj)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail = {}) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

// One stub for every kind. Judgment prompts embed the transcript (and so the player inputs), so they are matched
// before the generic reply. Continuation is false only for END_INPUT (the terminal auto-end case).
async function startStubLm() {
  const prompts = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    const prompt = body.messages?.[0]?.content ?? '';
    prompts.push(prompt);
    const schemaName = body.response_format?.json_schema?.name ?? '';
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (schemaName === 'errand_offer_record' || schemaName === 'study_circle_offer_record') {
      content = JSON.stringify({ title: OFFER_TITLE, situation: OFFER_SITUATION, motivation: OFFER_MOTIVATION });
    } else if (prompt.includes('この依頼を自分の口から持ちかける') || prompt.includes('この研究会を自分の口から持ちかける')) content = OFFER_APPEAL;
    else if (prompt.includes('場所移動の合意')) content = 'false';
    else if (prompt.includes('location_idを1つだけ返す')) content = 'none';
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
      if (prompt.includes(MAP_INPUT)) content = 'academy-map';
      else content = 'none';
    } else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) content = SENDOFF_TEXT;
    else if (prompt.includes('達成条件が、ここまでの会話で満たされたか') || prompt.includes('研究会の達成条件')) content = 'false';
    else if (prompt.includes('継続したいと思うか')) content = prompt.includes(END_INPUT) ? 'false' : 'true';
    else if (prompt.includes('好感度の変化量を判定する')) content = '0';
    else if (prompt.includes('MP温存ライン')) content = '30';
    else if (prompt.includes('増減したユーザーの所持金を判定する') || prompt.includes('所持金判定')) content = '0';
    else if (prompt.includes('を手渡した')) content = GIFT_REACTION; // the gift_reaction turn
    else if ([FIRST_INPUT, SECOND_INPUT, REVEAL_TYPING_INPUT, SCROLL_INPUT, DRAWER_INPUT, STAGE_POPUP_INPUT, PARTNER_POPUP_INPUT, END_INPUT, MAP_INPUT].some((input) => prompt.includes(input))) content = REPLY_TEXT;
    else content = OPENING_TEXT;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, prompts, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function writeManifest(root) {
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
  // The errand type catalog is read from <resourceRoot>/data/definitions/errand_types.json — seed the repo's file.
  await fs.mkdir(path.join(root, 'data/definitions'), { recursive: true });
  await fs.copyFile(path.join(PROJECT_ROOT, 'data/definitions/errand_types.json'), path.join(root, 'data/definitions/errand_types.json'));
}

async function makeFixture(slug) {
  const root = await fixtureRoot(`day-focus-${slug}-`);
  await writeManifest(root);
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), `day-focus-${slug}-settings-`));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: PERSONA_VARIANT }, null, 2)}\n`, 'utf8');
  cleanupPaths.push(root, settingsDir);
  return { root, settingsPath };
}

async function startGameServer({ root, settingsPath, activeRoot = null }) {
  const server = createServer({
    root,
    ...(activeRoot ? { activeRoot } : {}),
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function activeSlotStatePath(root) {
  const active = JSON.parse(await fs.readFile(path.join(resolvePlayRoot(root), 'active_slot.json'), 'utf8'));
  const slotId = active.active_slot_id ?? active.slot_id ?? active.active_slot;
  if (!slotId) throw new Error(`active_slot.json carries no slot id: ${JSON.stringify(active)}`);
  return path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json');
}

// Seed the active slot's inventory (a fresh new-game leaves player_inventory.json absent). Runs after new-game.
async function seedActiveSlotInventory(root, items) {
  const statePath = await activeSlotStatePath(root);
  await fs.writeFile(path.join(path.dirname(statePath), 'player_inventory.json'), `${JSON.stringify({ money: 99999, items }, null, 2)}\n`, 'utf8');
}

async function mutateActiveSlotState(root, mutate) {
  const statePath = await activeSlotStatePath(root);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  mutate(state);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
// Closing a scenario's window must not quit before the next scenario opens one.
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

// Attach CDP once a real page is loaded (a command sent while the window still holds its initial blank page never
// returns). A hidden window is never the OS-focused window; emulate page focus so focus()/activeElement and CDP key
// input behave as in the player's focused window.
async function enableCdp(win) {
  if (win.webContents.debugger.isAttached()) return;
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);
const cdp = (win, method, params = {}) => win.webContents.debugger.sendCommand(method, params);

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

// Record every focus() call on the daytime input: the options passed and the stream / page scroll positions right
// before and after it. Installed per page load (a reload drops it).
async function installFocusProbe(win) {
  await enableCdp(win);
  await js(win, `(() => {
    if (window.__dayFocusLog) return true;
    window.__dayFocusLog = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focusProbe(options) {
      if (this.id !== 'conversation-day-input') return original.call(this, options);
      const stream = document.querySelector('#conversation-day-message-stream');
      const entry = {
        options: options ?? null,
        streamScrollBefore: stream.scrollTop,
        pageScrollBefore: document.scrollingElement.scrollTop
      };
      original.call(this, options);
      entry.streamScrollAfter = stream.scrollTop;
      entry.pageScrollAfter = document.scrollingElement.scrollTop;
      entry.activeIsInput = document.activeElement === this;
      window.__dayFocusLog.push(entry);
    };
    return true;
  })()`);
}

const focusLogLength = (win) => js(win, `window.__dayFocusLog.length`);

function readFocusState(win) {
  return js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
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

const dayScreenReady = `
  document.querySelector('#conversation-day-screen')?.classList.contains('active')
  && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  && !document.querySelector('#conversation-day-input')?.disabled
  && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
`;

// A daytime turn is in flight while the input is disabled (setControlsDisabled covers the whole turn, reveal
// included). Wait for it to start, then for it to finish (or for the screen to leave on a terminal turn).
async function waitTurnStarted(win) {
  return waitFor(win, `document.querySelector('#conversation-day-input').disabled`, { tries: 100, intervalMs: 20 });
}
async function waitTurnFinished(win) {
  return waitFor(win, `!document.querySelector('#conversation-day-input').disabled`, { tries: 600, intervalMs: 100 });
}

// Send a turn by keyboard only: CDP text insertion into whatever holds focus + a CDP Enter. No click, no focus().
async function keyboardTurn(win, text) {
  const before = lm.prompts.length;
  await cdpType(win, text);
  await cdpEnter(win);
  const started = await waitTurnStarted(win);
  return { started, before };
}

function lmSawInput(sinceIndex, text) {
  return lm.prompts.slice(sinceIndex).some((prompt) => prompt.includes(text));
}

// The opening check: right after landing — no click, no harness focus() — the opening has revealed (the input is
// re-enabled only in the start's finally, after the opening's reveal) and the input already holds focus.
// Page-focus emulation is enabled here (not earlier) so the check sees the app's own focus() on landing; with it on,
// :focus matches as in the player's focused window and the shot shows the focus ring.
async function openingFocusCheck(win, kind, landed) {
  await enableCdp(win);
  const after = await readFocusState(win);
  const matchesFocus = await js(win, `document.querySelector('#conversation-day-input').matches(':focus')`);
  const streamTail = await js(win, `(document.querySelector('#conversation-day-message-stream')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(-40)`);
  // The state above is read at landing; the shot waits for the just-landed stage (image, focus ring) to paint.
  await sleep(500);
  const openingShot = await shot(win, `${kind}-after-opening-focused`);
  const matchesFocusAtShot = await js(win, `document.querySelector('#conversation-day-input').matches(':focus')`);
  check(`${kind}: after the partner's opening has revealed, document.activeElement is #conversation-day-input (no click)`,
    landed && after.activeIsInput && matchesFocus && matchesFocusAtShot && after.activeScreenId === 'conversation-day-screen',
    { landed, ...after, matchesFocus, matchesFocusAtShot, streamTail, shot: openingShot });
}

// The core per-kind check (acceptance 2): click + type the first utterance, then after the reveal the input holds
// focus; the second utterance goes out by keys alone and reaches the LM; focus returns again after it.
async function coreKindCheck(win, kind) {
  await installFocusProbe(win);
  await cdpClick(win, '#conversation-day-input');
  const first = await keyboardTurn(win, FIRST_INPUT);
  const firstDone = first.started && await waitTurnFinished(win);
  const afterFirst = await readFocusState(win);
  const firstShot = await shot(win, `${kind}-after-reply-focused`);
  check(`${kind}: after the partner's reply has revealed, document.activeElement is #conversation-day-input`,
    firstDone && afterFirst.activeIsInput && afterFirst.activeScreenId === 'conversation-day-screen',
    { firstDone, ...afterFirst, shot: firstShot });

  const second = await keyboardTurn(win, SECOND_INPUT);
  const secondDone = second.started && await waitTurnFinished(win);
  const secondBubble = await js(win, `(document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(SECOND_INPUT)})`);
  const afterSecond = await readFocusState(win);
  const secondShot = await shot(win, `${kind}-keyboard-only-second-turn`);
  check(`${kind}: the next utterance is typed + sent with keys only (no click / focus()) and reaches the LM`,
    secondDone && secondBubble && lmSawInput(second.before, SECOND_INPUT) && afterSecond.activeIsInput,
    { secondDone, secondBubble, lmSawSecondInput: lmSawInput(second.before, SECOND_INPUT), ...afterSecond, shot: secondShot });
}

// A turn during which an overlay is opened (by clicking its opener mid-reveal): after the turn the refocus must not
// fire (no focus() call recorded), focus stays off the input, and the overlay is still open.
async function overlayTurn(win, kind, { input, label, open, overlaySelector, close }) {
  await cdpClick(win, '#conversation-day-input');
  const logBefore = await focusLogLength(win);
  const turn = await keyboardTurn(win, input);
  await sleep(300);
  await js(win, `(() => { ${open} })(); true`);
  const opened = await waitFor(win, `document.querySelector(${JSON.stringify(overlaySelector)})?.hidden === false`, { tries: 50, intervalMs: 50 });
  const done = turn.started && await waitTurnFinished(win);
  await sleep(200);
  const after = await readFocusState(win);
  const overlayStillOpen = await js(win, `document.querySelector(${JSON.stringify(overlaySelector)})?.hidden === false`);
  const logAfter = await focusLogLength(win);
  const overlayShot = await shot(win, `${kind}-${label}-open-no-focus`);
  check(`${kind}: with the ${label} open when the reply finishes, focus is NOT put into the input`,
    opened && done && overlayStillOpen && !after.activeIsInput && logAfter === logBefore,
    { opened, done, overlayStillOpen, focusCallsDuringTurn: logAfter - logBefore, ...after, shot: overlayShot });
  await js(win, `(() => { ${close} })(); true`);
  await waitFor(win, `document.querySelector(${JSON.stringify(overlaySelector)})?.hidden === true`, { tries: 50, intervalMs: 50 });
}

// ── scenarios ────────────────────────────────────────────────────────────────
async function newGameFetch(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
}

async function hubTurn(win, text) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
    const fired = await js(win, `(() => {
      const el = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!el || !send || send.disabled) return false;
      el.value = ${JSON.stringify(text)};
      send.click();
      return true;
    })()`);
    if (fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 })) return true;
    await sleep(400);
  }
  return false;
}

async function newGameToHub(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1200);
  await js(win, `document.querySelector('#start-new-game').click(); true`);
  return waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-send')?.disabled
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `);
}

async function scenarioRoster() {
  const fixture = await makeFixture('roster');
  const base = await startGameServer(fixture);
  const win = await openWindow();
  await newGameFetch(win, base);
  // A real gift-category id from the live routing alchemy book, owned so the drawer offers 渡す.
  const giftItem = await js(win, `fetch('/api/alchemy').then((r) => r.json()).then((book) => book.recipes.find((r) => r.result.category === 'gift')?.result ?? null)`);
  if (!giftItem) throw new Error('alchemy book has no gift-category recipe');
  await seedActiveSlotInventory(fixture.root, [{ item_id: giftItem.item_id, quantity: 1 }]);
  await win.loadURL(`${base}/?initialScreen=conversation-day`);
  const landed = await waitFor(win, dayScreenReady, { tries: 400, intervalMs: 120 });
  check('roster: the 学院マップ相手 conversation lands on #conversation-day-screen', landed);
  await openingFocusCheck(win, 'roster', landed);
  await coreKindCheck(win, 'roster');

  // Typing during the reveal: the input is disabled for the whole turn, so keys typed mid-reveal land nowhere and
  // nothing the player had in the input is dropped; after the reveal focus returns and typing continues there.
  {
    const turn = await keyboardTurn(win, REVEAL_TYPING_INPUT);
    await sleep(400);
    const midReveal = await readFocusState(win);
    await cdpType(win, DRAFT_TEXT);
    const afterMidTyping = await readFocusState(win);
    const done = turn.started && await waitTurnFinished(win);
    const afterTurn = await readFocusState(win);
    await cdpType(win, DRAFT_TEXT);
    const afterResumeTyping = await readFocusState(win);
    const draftShot = await shot(win, 'roster-typing-after-reveal-draft-kept');
    check('roster: keys typed during the reveal do not land in (or clear) the input; after the reveal focus returns and a draft typed there stays intact',
      done && midReveal.inputDisabled && afterMidTyping.inputValue === '' && afterTurn.activeIsInput && afterTurn.inputValue === ''
        && afterResumeTyping.inputValue === DRAFT_TEXT && afterResumeTyping.activeIsInput,
      { midReveal, afterMidTyping, afterTurn, afterResumeTyping, shot: draftShot });
    // Clear the draft with keys (select-all + delete) so the next turn starts from an empty input.
    await js(win, `document.querySelector('#conversation-day-input').select(); true`);
    await cdp(win, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp(win, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  }

  // Scrolled-up read position: scroll the stream to the top mid-reveal; the refocus must use preventScroll and leave
  // the stream (and page) scroll untouched.
  {
    const overflow = await js(win, `(() => { const s = document.querySelector('#conversation-day-message-stream'); return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight }; })()`);
    const logBefore = await focusLogLength(win);
    const turn = await keyboardTurn(win, SCROLL_INPUT);
    await sleep(500);
    await js(win, `document.querySelector('#conversation-day-message-stream').scrollTop = 0; true`);
    const done = turn.started && await waitTurnFinished(win);
    await sleep(200);
    const after = await readFocusState(win);
    const entries = await js(win, `window.__dayFocusLog.slice(${logBefore})`);
    const finalScroll = await js(win, `document.querySelector('#conversation-day-message-stream').scrollTop`);
    const scrollShot = await shot(win, 'roster-scrolled-up-kept');
    const entry = entries[0] ?? null;
    check('roster: a scrolled-up read position is not pulled back — focus() uses preventScroll and the stream/page scroll are unchanged across it',
      overflow.scrollHeight > overflow.clientHeight && done && entries.length === 1 && entry.options?.preventScroll === true
        && entry.streamScrollBefore === 0 && entry.streamScrollAfter === 0 && entry.pageScrollBefore === entry.pageScrollAfter
        && finalScroll === 0 && after.activeIsInput,
      { overflow, done, entries, finalScroll, ...after, shot: scrollShot });
    await js(win, `(() => { const s = document.querySelector('#conversation-day-message-stream'); s.scrollTop = s.scrollHeight; })(); true`);
  }

  await overlayTurn(win, 'roster', {
    input: DRAWER_INPUT,
    label: 'info-drawer',
    open: `document.querySelector('.conversation-day-category-button[data-day-category="inventory"]').click();`,
    overlaySelector: '#conversation-day-info-popup',
    close: `document.querySelector('#conversation-day-info-popup .night-band-close').click();`
  });
  await overlayTurn(win, 'roster', {
    input: STAGE_POPUP_INPUT,
    label: 'stage-popup',
    open: `document.querySelector('#conversation-day-stage-image').click();`,
    overlaySelector: '#conversation-day-stage-popup',
    close: `document.querySelector('#conversation-day-stage-popup [data-day-popup-close]').click();`
  });
  await overlayTurn(win, 'roster', {
    input: PARTNER_POPUP_INPUT,
    label: 'character-popup',
    open: `document.querySelector('#conversation-day-message-stream .message-speaker').click();`,
    overlaySelector: '#conversation-day-character-popup',
    close: `document.querySelector('#conversation-day-character-popup [data-day-popup-close]').click();`
  });

  // Gift: 渡す from the inventory drawer (the click takes focus onto the button; the handler closes the drawer
  // before the reveal). Once the hand-over + reaction have revealed, exactly one refocus lands in the input.
  {
    await js(win, `document.querySelector('.conversation-day-category-button[data-day-category="inventory"]').click(); true`);
    const giveShown = await waitFor(win, `!!document.querySelector('#conversation-day-info-popup-body .conversation-day-info-ledger-give:not([disabled])')`, { tries: 100, intervalMs: 50 });
    const logBefore = await focusLogLength(win);
    const clicked = giveShown && await js(win, `(() => {
      window.confirm = () => true;
      const give = document.querySelector('#conversation-day-info-popup-body .conversation-day-info-ledger-give:not([disabled])');
      give.focus();
      give.click();
      return true;
    })()`);
    const started = clicked && await waitTurnStarted(win);
    const duringGift = await readFocusState(win);
    const done = started && await waitTurnFinished(win);
    await sleep(200);
    const after = await readFocusState(win);
    const reacted = await js(win, `(document.querySelector('#conversation-day-message-stream')?.textContent || '').includes(${JSON.stringify(GIFT_REACTION.slice(-8))})`);
    const drawerHidden = await js(win, `document.querySelector('#conversation-day-info-popup').hidden`);
    const logAfter = await focusLogLength(win);
    const giftShot = await shot(win, 'roster-after-gift-reaction-focused');
    check('roster: after a gift\'s reaction has revealed, document.activeElement is #conversation-day-input',
      clicked && done && reacted && drawerHidden && !duringGift.activeIsInput && after.activeIsInput
        && after.activeScreenId === 'conversation-day-screen' && logAfter - logBefore === 1,
      { giftItemId: giftItem.item_id, clicked, done, reacted, drawerHidden, duringGift, focusCallsDuringGift: logAfter - logBefore, ...after, shot: giftShot });
  }

  // Terminal: the continuation judgment says false → auto-end → the conversation closes and the screen leaves the
  // daytime screen; the refocus must not fire and must not take focus from the destination.
  {
    await cdpClick(win, '#conversation-day-input');
    const logBefore = await focusLogLength(win);
    const turn = await keyboardTurn(win, END_INPUT);
    const left = turn.started && await waitFor(win, `!document.querySelector('#conversation-day-screen')?.classList.contains('active')`, { tries: 400, intervalMs: 100 });
    const settled = await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 600, intervalMs: 100 });
    // The auto-end awaits the whole hub entry inside the daytime turn, so the turn's finally (which re-enables the
    // daytime controls and runs the refocus) comes after the hub is up — measure only once it has run.
    const turnFinallyRan = await waitTurnFinished(win);
    await sleep(300);
    const after = await readFocusState(win);
    const logAfter = await focusLogLength(win);
    const endShot = await shot(win, 'roster-terminal-auto-end-no-focus');
    check('roster: a terminal turn (auto-end → hub) does not put focus into the daytime input',
      left && settled && turnFinallyRan && !after.activeIsInput && logAfter === logBefore && after.activeScreenId === 'routing-hub-screen',
      { left, settled, turnFinallyRan, focusCallsDuringTurn: logAfter - logBefore, ...after, shot: endShot });
  }
  win.destroy();
}

async function scenarioEvent() {
  const fixture = await makeFixture('event');
  const base = await startGameServer(fixture);
  const win = await openWindow();
  const onHub = await newGameToHub(win, base);
  await mutateActiveSlotState(fixture.root, (state) => {
    state.global_flags = { ...(state.global_flags ?? {}), [EVENT_FLAG_ID]: true };
    state.event_flag_sources = {
      ...(state.event_flag_sources ?? {}),
      [EVENT_FLAG_ID]: { character_id: EVENT_CHARACTER_ID, conversation_id: null, achieved_at: new Date().toISOString(), source_type: 'conversation' }
    };
  });
  const sent = onHub && await hubTurn(win, MAP_INPUT);
  const landed = sent && await waitFor(win, dayScreenReady, { tries: 900, intervalMs: 120 });
  const pendingFlag = await js(win, `fetch('/api/state').then((r) => r.json()).then((s) => s?.pending_interaction_context?.event_flag_id ?? null)`);
  check('event: the hub → academy-map dispatch auto-starts the pending event conversation on #conversation-day-screen',
    landed && pendingFlag === EVENT_FLAG_ID, { onHub, sent, landed, pendingFlag });
  await openingFocusCheck(win, 'event', landed);
  await coreKindCheck(win, 'event');
  win.destroy();
}

async function scenarioOffer(kind, { initialScreen, cardButton }) {
  const fixture = await makeFixture(kind);
  const base = await startGameServer(fixture);
  const win = await openWindow();
  await newGameFetch(win, base);
  await win.loadURL(`${base}/?initialScreen=${initialScreen}`);
  const cards = await waitFor(win, `!!document.querySelector(${JSON.stringify(cardButton)})`, { tries: 400, intervalMs: 120 });
  if (cards) await js(win, `document.querySelector(${JSON.stringify(cardButton)}).click(); true`);
  const landed = cards && await waitFor(win, dayScreenReady, { tries: 400, intervalMs: 120 });
  check(`${kind}: selecting an offer lands its conversation on #conversation-day-screen`, landed, { cards, landed });
  await openingFocusCheck(win, kind, landed);
  await coreKindCheck(win, kind);
  win.destroy();
}

async function scenarioAtelier() {
  const root = await fixtureRoot('day-focus-atelier-');
  await writeManifest(root);
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'day-focus-atelier-settings-'));
  cleanupPaths.push(root, settingsDir);
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: PERSONA_VARIANT }, null, 2)}\n`, 'utf8');
  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: PERSONA_VARIANT });
  const slotRoot = initialized.root;
  const parameters = (keys, value) => Object.fromEntries(keys.map((key) => [key, value]));
  await writeJson(slotRoot, 'game_data/homunculi.json', {
    version: 1,
    active: [{ homunculus_id: HOMUNCULUS_ID, display_name: HOMUNCULUS_NAME, face_id: HOMUNCULUS_FACE_ID, created_week: 3 }],
    nameplates: []
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/profile.json`, {
    character_id: HOMUNCULUS_ID,
    display_name: HOMUNCULUS_NAME,
    visual_set_id: HOMUNCULUS_FACE_ID,
    prompt_description: '穏やかで人懐こいホムンクルス。',
    speaking_basis: '一人称は「私」。やわらかい丁寧語で話す。',
    parameters: {
      magic: parameters(['light', 'dark', 'fire', 'water', 'earth', 'wind'], 40),
      abilities: parameters(['strength', 'agility', 'academics', 'magical_power', 'charisma'], 40)
    }
  });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/flags.json`, { character_id: HOMUNCULUS_ID, flags: {} });
  await writeJson(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/skills.json`, { character_id: HOMUNCULUS_ID, skills: [] });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/memory`), { recursive: true });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${HOMUNCULUS_ID}/work_records`), { recursive: true });
  // The atelier unlocks on magic mastery; seed an unlocked player.
  const meter = (label, value) => ({ min: 0, max: 100, label, value });
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', {
    magic: Object.fromEntries(['light', 'dark', 'fire', 'water', 'earth', 'wind'].map((key) => [key, meter(`${key}魔法習熟度`, 85)])),
    abilities: Object.fromEntries(['strength', 'agility', 'academics', 'magical_power', 'charisma'].map((key) => [key, meter(key, 50)]))
  });
  const statePath = path.join(slotRoot, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state, current_screen: 'academy-atelier', current_interaction_character_id: null, pending_interaction_context: null, elapsed_weeks: 5
  });
  const base = await startGameServer({ root, settingsPath, activeRoot: resolvePlayRoot(root) });
  const win = await openWindow();
  await win.loadURL(`${base}/?initialScreen=academy-atelier`);
  const talk = await waitFor(win, `!!document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk')`, { tries: 300, intervalMs: 120 });
  if (talk) await js(win, `document.querySelector('#academy-atelier-slots .academy-atelier-slot-talk').click(); true`);
  const landed = talk && await waitFor(win, dayScreenReady, { tries: 500, intervalMs: 120 });
  check('atelier: 会いに行く lands the うちの子 conversation on #conversation-day-screen', landed, { talk, landed });
  await openingFocusCheck(win, 'atelier', landed);
  await coreKindCheck(win, 'atelier');
  await overlayTurn(win, 'atelier', {
    input: PARTNER_POPUP_INPUT,
    label: 'homunculus-popup',
    open: `document.querySelector('#conversation-day-message-stream .message-speaker').click();`,
    overlaySelector: '#conversation-day-homunculus-popup',
    close: `document.querySelector('#conversation-day-homunculus-popup [data-day-popup-close]').click();`
  });
  win.destroy();
}

const SCENARIOS = {
  roster: scenarioRoster,
  event: scenarioEvent,
  errand: () => scenarioOffer('errand', { initialScreen: 'academy-errand', cardButton: '#academy-errand-offers .academy-errand-card .academy-errand-card-button' }),
  'study-circle': () => scenarioOffer('study-circle', { initialScreen: 'academy-study-circle', cardButton: '#academy-study-circle-offers .academy-study-circle-card .academy-study-circle-card-button' }),
  atelier: scenarioAtelier
};

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  lm = await startStubLm();
  await app.whenReady();
  const only = process.env.CD_FOCUS_ONLY ? process.env.CD_FOCUS_ONLY.split(',') : Object.keys(SCENARIOS);
  for (const name of only) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    log('scenario', { name });
    await scenario();
  }
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
