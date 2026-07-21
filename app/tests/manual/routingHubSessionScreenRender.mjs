// Render-backed routing hub screen check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch/DOM/real layout/SSE pump), so the dedicated routing hub
// screen is verified here against the REAL client in Electron. This file is intentionally NOT named
// *.test.mjs and lives under app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips
// it; run it by hand with the Electron binary:
//
//   ./node_modules/.bin/electron app/tests/manual/routingHubSessionScreenRender.mjs
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC local LM Studio stub (decides the
// 鍛錬/training destination), loads the real client, and drives the REAL routing flow to measure, against
// real layout, the task's acceptance path:
//   1. ENTRY: title #start-new-game -> enterRoutingHub() -> lands on the dedicated #routing-hub-screen
//      with ルミ's 迎え opening rendered in the hub's own chat stream (NOT academy-conversation-session).
//   1.4 SCROLL-FOLLOW: drive several REAL continuation turns (the stub decides no destination so the player
//      stays on the hub) and assert the newest ルミ reply stays pinned to the bottom and fully visible after
//      each settles — i.e. the 送信しています… status line shrinking the stream between the player's optimistic
//      render and ルミの応答 render no longer flips the at-bottom gate to false. NEGATIVE CONTROL: with the
//      setRoutingHubStatus re-pin reverted, these checks FAIL (newest reply stranded below the fold).
//   2. SHELL: 6 category buttons (self/buddy/enemy/inventory/money/diary), week counter, ルミ standee loaded; a settled screenshot.
//   3. INFO DRAWER: each category (self/buddy/enemy/inventory/money) opens the [hidden]-toggled drawer
//      with body content in the running UI, marks its rail button selected, and closes (clearing it). The
//      drawer geometry is measured against real layout: it opens as a LEFT drawer from the rail's right
//      edge (left-hugging, roughly full height) with the chat panel still visible beside it.
//   4. CONVERSATION CONTINUATION + DESTINATION DECISION + TRANSITION: type a turn and send; the decided
//      turn reveals the send-off in the hub stream (continuation), fires ② (player-spoke) and, on the
//      routing_draining signal, ③ (dispatch climax) + the drain loading screen, then transitions to the
//      content screen (academy-training).
//   5. RESTORE: the routing hub re-opens cleanly via enterRoutingHub — the same entry function the
//      content-return 復帰 (navigateToPostContentScreen('interaction')) reuses. (The hub is left only via
//      a decided destination; ending it with no decision correctly fail-fasts.)
//   6. REDUCED MOTION: with prefers-reduced-motion:reduce emulated (CDP), the decor drift / ①②③
//      animations are disabled and the starfield is drawn static (no rAF loop).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = 1200;
const WIN_H = 820;
const PERSONA_VARIANT = 'fallen_star';
const PLAYER_INPUT = '今週は鍛錬する';
// A continuation input that keeps the player on the hub (the stub decides no destination for it), so the
// scroll-follow section can drive several real turns whose 送信しています… status shrinks the stream between
// the player's optimistic render and ルミの応答 render. It must NOT contain PLAYER_INPUT as a substring.
const CONTINUE_INPUT = 'まだ迷っているの、もう少し話を聞かせて';
const OPENING_TEXT = '新しい週をここから始めましょう。';
const CONTINUE_REPLY = 'ふふ、ゆっくりでいいですよ。今の気持ちを、もう少しだけ聞かせてくださいね。あなたの一歩を、ここで一緒に選びましょう。';
// The 見送り reply carries a 地の文 (parenthetical), so the client splits it into three 吹き出し単位
// (発話・地の文・発話) — this exercises the 統一出現規律 (等間隔 pop-pop) during the send-off. The rendered
// stream drops the parentheses, so the visible-text checks use the paren-free first/last speech fragments.
const SENDOFF_TEXT = 'では、鍛錬へ向かいましょう。（あなたの背をそっと押す）新しい一週間をそこから始めます。';
const SENDOFF_FIRST = 'では、鍛錬へ向かいましょう';
const SENDOFF_LAST = '新しい一週間をそこから始めます';
// A distinct input that decides the 学院マップ (academy-map) destination, used by the academy-map arrival
// freshness + weekly-reroll section. It must NOT be a substring of PLAYER_INPUT / CONTINUE_INPUT and vice
// versa, so the deterministic stub can discriminate it in the accumulated transcript.
const MAP_INPUT = '今週は学院マップで過ごす';
const MAP_SENDOFF_TEXT = 'では、学院マップへ向かいましょう。新しい一週間を、学院のどこかから始めます。';
// A distinct input that decides the ダンジョン (dungeon) destination, used by the dungeon direct-entry
// section. It must NOT be a substring of PLAYER_INPUT / CONTINUE_INPUT / MAP_INPUT and vice versa, so the
// deterministic stub can discriminate it in the accumulated transcript.
const DUNGEON_INPUT = '今週はダンジョンに潜る';
const DUNGEON_SENDOFF_TEXT = 'では、実践へ潜りましょう。最初の階から、一歩ずつ進んでいきます。';

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

// Deterministic routing LM stub (mirrors serverApi.test.mjs routingTurnLmResponder): answers each LM
// round-trip of the hub opening + a decided turn so the turn resolves to the 鍛錬 destination.
function routingTurnLmResponder({ body, prompt, requestIndex }) {
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  // Post-turn finalization (drain) judgments. The decided routing turn runs the shared conversationPipeline
  // finalization AFTER routing_draining; its strict-parse judgments must get a valid answer or the drain
  // throws (renderer-error) and the dispatch never lands on the destination screen. The integer-contract
  // judgments (affinity delta / 所持金) need an integer — a generic non-integer reply throws
  // `affinity delta answer must be an integer from -10 to 10`. These MUST come before the generic
  // transcript-matching branches below (`requestIndex === 0` / `includes(CONTINUE_INPUT)` / the freeform
  // else), which the finalization prompts would otherwise false-match through the embedded transcript.
  // (ref-camera.md: an END-driven render harness LM stub must answer every finalization LLM judgment; the
  // affinity delta branch goes before the generic transcript branches.)
  if (prompt.includes('好感度の変化量を判定する')) return '0'; // affinity delta → neutral (contract: integer -10..10)
  if (prompt.includes('MP温存ライン')) return '30'; // mp reserve line judgment → neutral (contract: integer 0..100)
  if (prompt.includes('所持金判定')) return '0'; // money delta → none (contract: integer)
  // Stage-move judgments: the academy-map stage conversation driven in the content-return leg (the shared
  // conversation-day screen) evaluates a stage-move agreement (strict true/false — a freeform reply throws
  // `stage move agreement must be true or false`) and, on agreement, a destination selection. The routing hub
  // turn never runs these, but the return-leg conversation does; answer them (no move) so its END drain
  // completes. (mirrors the alchemy/errand render-harness stubs for the same shared pipeline.)
  if (prompt.includes('場所移動の合意')) return 'false'; // stage-move agreement → no move
  if (prompt.includes('location_idを1つだけ返す')) return 'none'; // stage-move destination → none
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) {
    // The explicit 学院マップ request (MAP_INPUT) decides the academy-map destination; the explicit 鍛錬
    // request (PLAYER_INPUT) decides training; every other (continuation) turn returns 'none' so the player
    // stays on the hub. Discriminating on the explicit inputs (not CONTINUE_INPUT) is robust once the
    // transcript accumulates earlier continuation lines.
    if (prompt.includes(MAP_INPUT)) return 'academy-map';
    if (prompt.includes(DUNGEON_INPUT)) return 'dungeon';
    return prompt.includes(PLAYER_INPUT) ? 'training' : 'none';
  }
  // The send-off prompt carries the decided destination; discriminate on the player's own request in the
  // transcript (MAP_INPUT / DUNGEON_INPUT), not the destination catalog (which lists every destination for
  // every dispatch), so each send-off keeps its own flavor.
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) {
    if (prompt.includes(MAP_INPUT)) return MAP_SENDOFF_TEXT;
    if (prompt.includes(DUNGEON_INPUT)) return DUNGEON_SENDOFF_TEXT;
    return SENDOFF_TEXT;
  }
  if (requestIndex === 0) return OPENING_TEXT;
  if (prompt.includes(CONTINUE_INPUT)) return CONTINUE_REPLY;
  return '鍛錬ですね。今の伸ばしたい力にも合っています。';
}

// The prompt marker of the post-turn finalization drain calls (会話終了後の処理 / キャラクターの継続記録 — the
// `会話終了後の処理` finalization work run inside finalizeTurnResult, i.e. AFTER the server has already sent
// routing_draining). Holding the first such call delays the whole drain — and hence the server's `result`
// event — past the client's 見送り読みポーズ, exercising the pause-first ordering (Order B). It must target a
// call that runs AFTER routing_draining: the in-turn work-record recall (work_record_recall_choice) runs
// BEFORE routing_draining, so delaying by schema would push back routing_draining itself instead of the drain.
const FINALIZATION_DRAIN_PROMPT_MARKER = '次の会話セッションだけを根拠に';

async function startStubLm() {
  const requests = [];
  // Injectable backend-drain delay. The test sets control.finalizationDelayMs before a decided turn; the stub
  // then holds the first post-routing_draining finalization round-trip of that turn's drain for that long
  // (one-shot, armed on the send-off), pushing `result` past the client's reading pause. Zero (the default)
  // leaves the drain fast (Order A: the result arrives within the pause).
  const control = { finalizationDelayMs: 0, pendingDrainDelayMs: 0 };
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    requests.push({ url: req.url });
    const prompt = body.messages?.[0]?.content ?? '';
    const content = routingTurnLmResponder({ body, prompt, requestIndex: requests.length - 1 });
    // Hold the first finalization drain round-trip of the current dispatch (armed on the preceding send-off).
    if (control.pendingDrainDelayMs > 0 && prompt.includes(FINALIZATION_DRAIN_PROMPT_MARKER)) {
      const held = control.pendingDrainDelayMs;
      control.pendingDrainDelayMs = 0;
      await sleep(held);
    }
    // Arm the delay for this dispatch's drain once its send-off has been generated.
    if (prompt.includes('行き先が確定したプレイヤーを送り出す')) control.pendingDrainDelayMs = control.finalizationDelayMs;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, control, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function routingFixture() {
  const root = await fixtureRoot('routing-hub-screen-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-screen-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: PERSONA_VARIANT }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 200, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Poll for a transient truthy condition (e.g. a class toggled for a few hundred ms) and report whether
// it was ever observed within the window.
async function observeTransient(win, predicate, { tries = 120, intervalMs = 20 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// Poll a decided routing turn against real timing (relative to when the send fires), capturing: when the
// FIRST and LAST send-off 吹き出し reveal on the hub, when the drain loading screen first appears, when the
// destination screen goes active, and whether the ③ dispatch-climax flare was observed. Used for both the
// result-first (Order A) and pause-first (Order B) orderings, so the pause behaviour is measured against real
// Blink layout, not inferred. Runs until the destination transition or the poll budget elapses.
async function measureDispatchTiming(win, { sendoffFirst, sendoffLast, destinationSelector }) {
  let firstSendoffAt = null, allSendoffAt = null, loadingAt = null, transitionAt = null, climaxSeen = false;
  const pollStart = Date.now();
  for (let i = 0; i < 500 && transitionAt === null; i += 1) {
    const s = await js(win, `(() => {
      const stream = document.querySelector('#routing-hub-message-stream');
      const text = (stream?.textContent || '');
      const screen = document.querySelector('#routing-hub-screen');
      return {
        first: text.includes(${JSON.stringify(sendoffFirst)}),
        all: text.includes(${JSON.stringify(sendoffLast)}),
        loading: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
        climax: !!screen?.classList.contains('is-dispatch-climax'),
        arrived: !!document.querySelector(${JSON.stringify(destinationSelector)})?.classList.contains('active')
      };
    })()`);
    const now = Date.now() - pollStart;
    if (s.first && firstSendoffAt === null) firstSendoffAt = now;
    if (s.all && !s.loading && allSendoffAt === null) allSendoffAt = now;
    if (s.climax) climaxSeen = true;
    if (s.loading && loadingAt === null) loadingAt = now;
    if (s.arrived && transitionAt === null) transitionAt = now;
    await sleep(80);
  }
  const sendoffSpanMs = (firstSendoffAt !== null && allSendoffAt !== null) ? allSendoffAt - firstSendoffAt : -1;
  const readingPauseMs = (allSendoffAt !== null && loadingAt !== null) ? loadingAt - allSendoffAt : -1;
  const postLoadingMs = (loadingAt !== null && transitionAt !== null) ? transitionAt - loadingAt : -1;
  return { firstSendoffAt, allSendoffAt, loadingAt, transitionAt, climaxSeen, sendoffSpanMs, readingPauseMs, postLoadingMs };
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

// From the routing hub, send the MAP_INPUT turn and wait for the decided dispatch to land on the academy
// map. Same choreography as the primary training dispatch, but the stub decides 学院マップ.
async function dispatchFromHubToMap(win) {
  // The hub send button is not disabled during the opening reveal (enterRoutingHub disables the shared
  // conversation controls, not the hub controls), yet conversationRequestInFlight is still true then, so a
  // too-early click is a silent in-flight no-op. Retry the send until it actually fires — the real send
  // synchronously clears the input, so a still-populated input means the turn did not start.
  let sent = false;
  for (let attempt = 0; attempt < 20 && !sent; attempt += 1) {
    await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
    const fired = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!input || !send || send.disabled) return false;
      input.value = ${JSON.stringify(MAP_INPUT)};
      send.click();
      return true;
    })()`);
    sent = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 });
    if (!sent) await sleep(400);
  }
  const landed = sent && await waitFor(win, `document.querySelector('#academy-map-screen')?.classList.contains('active')`, { tries: 400, intervalMs: 120 });
  log('map_dispatch_send_diag', { sent, landed, activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), hubRows: await js(win, `document.querySelectorAll('#routing-hub-message-stream .chat-message').length`) });
  return landed;
}

// From the routing hub, send the DUNGEON_INPUT turn and wait for the decided dispatch to enter the dungeon
// run DIRECTLY — the streamed run board (#dungeon-play), NOT the operable pre-entry screen (#dungeon-entry).
// Same send choreography as the map/training dispatch, but the stub decides the dungeon destination and the
// direct-entry auto-runs the enter under the loading screen, landing on the run board.
async function dispatchFromHubToDungeon(win) {
  let sent = false;
  for (let attempt = 0; attempt < 20 && !sent; attempt += 1) {
    await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
    const fired = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!input || !send || send.disabled) return false;
      input.value = ${JSON.stringify(DUNGEON_INPUT)};
      send.click();
      return true;
    })()`);
    sent = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 });
    if (!sent) await sleep(400);
  }
  // Direct-entry landing: the dungeon screen active with the streamed run board shown (#dungeon-play) — not
  // a stop on the operable pre-entry (#dungeon-entry). The enter streams a companion opening, so allow ample
  // time.
  const landed = sent && await waitFor(win, `
    document.querySelector('#academy-dungeon-screen')?.classList.contains('active')
    && document.querySelector('#dungeon-play') && !document.querySelector('#dungeon-play').hidden
  `, { tries: 600, intervalMs: 120 });
  log('dungeon_dispatch_send_diag', { sent, landed, activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), playHidden: await js(win, `document.querySelector('#dungeon-play')?.hidden ?? null`), entryHidden: await js(win, `document.querySelector('#dungeon-entry')?.hidden ?? null`) });
  return landed;
}

// Capture an academy-map arrival for the freshness / weekly-reroll checks: the live server field truth
// (/api/field) + week (/api/state), and — by dispatching a real mouseenter on every rendered academy-map
// node — each node's hover stage description and its assigned occupant names. The hover path is read-only
// (it opens no modal), so it sweeps every node without navigating away.
async function captureAcademyMapArrival(win) {
  await sleep(400); // let the arrival's field render + placement reroll settle
  return js(win, `(async () => {
    const [field, state] = await Promise.all([
      fetch('/api/field').then((r) => r.json()),
      fetch('/api/state').then((r) => r.json())
    ]);
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    const stages = [];
    for (const node of nodes) {
      node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const desc = (document.querySelector('#academy-map-hover-description')?.textContent || '').trim();
      const occ = (document.querySelector('#academy-map-hover-occupants-names')?.textContent || '').replace(/\\s+/g, ' ').trim();
      stages.push({ desc, occ });
      node.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
    return {
      elapsedWeeks: Number(state?.elapsed_weeks),
      currentSituation: (field?.current_location?.visible_situation || '').trim(),
      fieldSituations: (field?.locations || []).map((l) => (l.visible_situation || '').trim()).filter(Boolean),
      nodeCount: nodes.length,
      occupantsSignature: JSON.stringify(stages.map((s) => s.occ)),
      descriptions: stages.map((s) => s.desc),
      occupiedStages: stages.filter((s) => s.occ.length > 0).length
    };
  })()`);
}

// Measure the "day academy" layer on the arrived map against real layout: the sun week glyph text
// (第N週), the left 5-category rail, the 9-slice frame + 4 corner ornaments, and a read-only exercise of
// the rail → info drawer (open self, confirm it renders + marks its rail button, then close). This is the
// positive layout measurement the frontend-A task adds on top of the existing freshness/reroll checks.
async function captureAcademyMapDayLayout(win) {
  return js(win, `(() => {
    const week = (document.querySelector('#academy-map-week')?.textContent || '').trim();
    const railCount = document.querySelectorAll('.academy-map-category-button').length;
    const hasFrame = Boolean(document.querySelector('.academy-map-frame'));
    const cornerCount = document.querySelectorAll('.academy-map-corner').length;
    const popup = document.querySelector('#academy-map-info-popup');
    // Open self.
    const selfButton = document.querySelector('.academy-map-category-button[data-am-category="self"]');
    selfButton?.click();
    const drawerOpen = Boolean(popup && !popup.hidden);
    const drawerBodyFilled = (document.querySelector('#academy-map-info-popup-body')?.childElementCount || 0) > 0;
    const railActive = Boolean(selfButton?.classList.contains('is-active'));
    // While the drawer is open, the rail must stay usable: a real hit-test at the buddy button's center must
    // resolve to the rail (it sits ABOVE the info popup backdrop), and clicking it must switch category
    // WITHOUT closing first (hub-style switch-while-open).
    const buddyButton = document.querySelector('.academy-map-category-button[data-am-category="buddy"]');
    const rect = buddyButton ? buddyButton.getBoundingClientRect() : null;
    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    const railHittableWhileOpen = Boolean(hit && buddyButton && (hit === buddyButton || buddyButton.contains(hit)));
    buddyButton?.click();
    const switchedTitle = (document.querySelector('#academy-map-info-popup-title')?.textContent || '').trim();
    const stillOpenAfterSwitch = Boolean(popup && !popup.hidden);
    const buddyActiveAfterSwitch = Boolean(buddyButton && buddyButton.classList.contains('is-active'));
    const selfClearedAfterSwitch = !selfButton?.classList.contains('is-active');
    // Close.
    for (const closer of document.querySelectorAll('#academy-map-info-popup [data-am-popup-close]')) { closer.click(); break; }
    const drawerClosed = Boolean(popup && popup.hidden);
    const railCleared = !buddyButton?.classList.contains('is-active');
    return { week, railCount, hasFrame, cornerCount, drawerOpen, drawerBodyFilled, railActive,
      railHittableWhileOpen, switchedTitle, stillOpenAfterSwitch, buddyActiveAfterSwitch, selfClearedAfterSwitch,
      drawerClosed, railCleared };
  })()`);
}

// Return from the academy map to the routing hub through a REAL stage conversation (the routing
// content-return that re-opens the hub). Pick an academy stage that has an occupant, start a conversation
// with the first occupant, send one turn, then end it.
async function returnFromAcademyMapToHub(win) {
  const nodeIndex = await js(win, `(() => {
    const nodes = [...document.querySelectorAll('#academy-map-stage-layer .academy-map-node')];
    for (let i = 0; i < nodes.length; i += 1) {
      nodes[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const occ = (document.querySelector('#academy-map-hover-occupants-names')?.textContent || '').trim();
      nodes[i].dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      if (occ.length > 0) return i;
    }
    return -1;
  })()`);
  if (nodeIndex < 0) { log('return_diag', { step: 'no-occupant-node', nodeIndex }); return false; }
  await js(win, `document.querySelectorAll('#academy-map-stage-layer .academy-map-node')[${nodeIndex}].click(); true`);
  const dialogOpen = await waitFor(win, `document.querySelector('#academy-map-location-dialog')?.open && (document.querySelector('#academy-map-go-button')?.textContent || '').includes('ここに行く')`, { tries: 60, intervalMs: 50 });
  if (!dialogOpen) { log('return_diag', { step: 'location-dialog', nodeIndex, goText: await js(win, `document.querySelector('#academy-map-go-button')?.textContent ?? null`), dialogOpen: await js(win, `document.querySelector('#academy-map-location-dialog')?.open ?? null`) }); return false; }
  await js(win, `document.querySelector('#academy-map-go-button').click(); true`);
  // A confirmed move lands back on the map and opens the day-styled conversation-partner popup; clicking a
  // candidate card starts the conversation directly (the academy stage conversation now presents on the shared
  // conversation-day screen #conversation-day-screen — the conversation-day restyle — not the legacy
  // #academy-conversation-session-screen; no detail dialog in between).
  const onPopup = await waitFor(win, `document.querySelector('#academy-map-companion-popup') && !document.querySelector('#academy-map-companion-popup').hidden && document.querySelectorAll('#academy-map-companion-popup-body .academy-map-companion-card').length > 0`, { tries: 200, intervalMs: 120 });
  if (!onPopup) { log('return_diag', { step: 'companion-popup', activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), popupHidden: await js(win, `document.querySelector('#academy-map-companion-popup')?.hidden ?? null`), cardCount: await js(win, `document.querySelectorAll('#academy-map-companion-popup-body .academy-map-companion-card').length`) }); return false; }
  await js(win, `document.querySelector('#academy-map-companion-popup-body .academy-map-companion-card').click(); true`);
  const onSession = await waitFor(win, `document.querySelector('#conversation-day-screen')?.classList.contains('active') && !document.querySelector('#conversation-day-send')?.disabled`, { tries: 300, intervalMs: 120 });
  if (!onSession) { log('return_diag', { step: 'conversation-day', activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), sendDisabled: await js(win, `document.querySelector('#conversation-day-send')?.disabled ?? null`) }); return false; }
  // Send one real turn. The shared conversation surface clears the input synchronously on a fired send, so a
  // still-populated input marks an in-flight silent no-op — retry, mirroring the routing hub send trap.
  let convoSent = false;
  for (let attempt = 0; attempt < 20 && !convoSent; attempt += 1) {
    const fired = await js(win, `(() => {
      const input = document.querySelector('#conversation-day-input');
      const send = document.querySelector('#conversation-day-send');
      if (!input || !send || send.disabled) return false;
      input.value = 'こんにちは、今日はよろしくお願いします。';
      send.click();
      return true;
    })()`);
    convoSent = fired && await waitFor(win, `document.querySelector('#conversation-day-input').value === ''`, { tries: 40, intervalMs: 50 });
    if (!convoSent) await sleep(400);
  }
  if (!convoSent) { log('return_diag', { step: 'conversation-day-send', sendDisabled: await js(win, `document.querySelector('#conversation-day-send')?.disabled ?? null`) }); return false; }
  await waitFor(win, `!document.querySelector('#conversation-day-send')?.disabled && !document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 300, intervalMs: 120 });
  await js(win, `document.querySelector('#conversation-day-end').click(); true`);
  const backOnHub = await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 400, intervalMs: 120 });
  if (!backOnHub) log('return_diag', { step: 'end-to-hub', activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), loadingActive: await js(win, `!!document.querySelector('#academy-loading-screen')?.classList.contains('active')`) });
  return backOnHub;
}

async function main() {
  lm = await startStubLm();
  const { root, settingsDir, settingsPath } = await routingFixture();
  cleanupPaths = [root, settingsDir];

  server = createServer({
    root,
    publicRoot: PUBLIC_ROOT,
    canonicalAssetsRoot: REPO_CANONICAL,
    playModeSettingsPath: settingsPath,
    // timeout_ms must exceed the injected finalization-drain delay (Order B holds one drain LM round-trip past
    // the client's 5s reading pause); a 5s timeout would turn the intentional slow drain into an LM timeout.
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing', variant: PERSONA_VARIANT });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // ── 1) ENTRY + SHELL ────────────────────────────────────────────────────
  const onHub = await newGameToHub(win, base);
  const entry = await js(win, `(() => {
    const active = document.querySelector('.screen.active');
    const stream = document.querySelector('#routing-hub-message-stream');
    const standee = document.querySelector('#routing-hub-standee');
    return {
      activeScreenId: active ? active.id : null,
      sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
      messageCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      streamText: (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim(),
      categoryButtons: document.querySelectorAll('#routing-hub-screen .routing-hub-category-button').length,
      weekText: (document.querySelector('#routing-hub-week')?.textContent || '').trim(),
      standeeLoaded: !!(standee && standee.getAttribute('src')),
      hasSpeakerCaption: !!document.querySelector('#routing-hub-speaker-name'),
      starfieldMode: document.querySelector('#routing-hub-starfield')?.dataset.starfield || null
    };
  })()`);
  log('entry', entry);
  check('ENTRY lands on dedicated #routing-hub-screen (not academy session)',
    onHub && entry.activeScreenId === 'routing-hub-screen' && !entry.sessionActive, { activeScreenId: entry.activeScreenId });
  check('迎え opening rendered in the hub chat stream',
    entry.messageCount > 0 && entry.streamText.includes('新しい週'), { messageCount: entry.messageCount });
  // The hub rail renders 6 category buttons — self/buddy/enemy/inventory/money/diary — after the 日記 sixth
  // category was added (product truth: the six `.routing-hub-category-button` in app/public/index.html).
  check('hub shell: 6 category buttons, week counter, ルミ standee loaded, no speaker caption (no text label)',
    entry.categoryButtons === 6 && entry.weekText.includes('週') && entry.standeeLoaded && !entry.hasSpeakerCaption,
    { categoryButtons: entry.categoryButtons, weekText: entry.weekText, standeeLoaded: entry.standeeLoaded, hasSpeakerCaption: entry.hasSpeakerCaption });
  check('AMBIENT: starfield runs animated under normal motion (rAF loop)',
    entry.starfieldMode === 'animated', { starfieldMode: entry.starfieldMode });

  const endReady = await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-end')?.disabled
  `, { tries: 100, intervalMs: 100 });
  let endClicked = false;
  let endRequestStarted = false;
  const beforeEndRequests = lm.requests.length;
  for (let attempt = 0; attempt < 20 && endReady && !endRequestStarted; attempt += 1) {
    endClicked = await js(win, `(() => {
      const end = document.querySelector('#routing-hub-end');
      if (!end || end.disabled) return false;
      end.click();
      return true;
    })()`);
    endRequestStarted = endClicked && await waitFor(win, `document.querySelector('#academy-loading-screen')?.classList.contains('active')`, { tries: 40, intervalMs: 50 });
    if (!endRequestStarted) await sleep(400);
  }
  const endToTitle = endClicked && await waitFor(win, `
    document.querySelector('#title-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 500, intervalMs: 120 });
  const endClickState = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
    titleActive: !!document.querySelector('#title-screen')?.classList.contains('active')
  }))()`);
  log('end_click_to_title', { endReady, endClicked, endRequestStarted, lmRequestsBefore: beforeEndRequests, lmRequestsAfter: lm.requests.length, endToTitle, ...endClickState });
  check('END-CLICK: clicking 今日はここまで from the routing hub returns to #title-screen without terminal loading',
    Boolean(endReady && endClicked && endRequestStarted && endToTitle && endClickState.titleActive && !endClickState.loadingActive), { endReady, endClicked, endRequestStarted, ...endClickState });

  const hubResetAfterEndClick = await newGameToHub(win, base);
  log('end_click_reset_to_hub', { hubResetAfterEndClick, activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`) });

  const shotPath = path.join(os.tmpdir(), 'routing-hub-render.png');
  try { await sleep(1000); await fs.writeFile(shotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${shotPath}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // ── 1.3) DECOR PLACEMENT (this task) ──────────────────────────────────────
  // The moving decoration (.routing-hub-decor-1) is repositioned from the SCREEN top-left into the empty
  // space above the shortened (60%) standee frame — the top-right of the standee window, hugging the
  // bottom-right corner of that empty space. Measure it against REAL layout: it must sit in the right part
  // of the standee column, above the standee frame's top edge (not covering the frame/standee), and near
  // the bottom of the empty space — and it must NO LONGER be at the screen's far-left (the negative control
  // that distinguishes the new placement from the pre-move top-left position).
  // NEGATIVE CONTROL: reverting .routing-hub-decor-1 to `top: 8%; left: 6%;` FAILS this check — the decor's
  // center-x lands in the left half of the screen (left of the standee column) so both the top-right and
  // not-top-left assertions fail — proving the check discriminates the fix and does not pass on unfixed CSS.
  const decorPlacement = await js(win, `(() => {
    const screen = document.querySelector('#routing-hub-screen');
    const decor = document.querySelector('.routing-hub-decor-1');
    const standeeFrame = document.querySelector('.routing-hub-standee-frame');
    const stage = document.querySelector('.routing-hub-stage');
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) }; };
    const decorRect = r(decor), frameRect = r(standeeFrame), stageRect = r(stage), screenRect = r(screen);
    return {
      screen: screenRect,
      decor: { ...decorRect, cx: decorRect.left + Math.round(decorRect.width / 2), cy: decorRect.top + Math.round(decorRect.height / 2) },
      standeeFrame: frameRect,
      stage: stageRect,
      emptySpaceHeight: frameRect.top - stageRect.top
    };
  })()`);
  log('decor_placement', decorPlacement);
  {
    const d = decorPlacement.decor, sf = decorPlacement.standeeFrame, st = decorPlacement.stage, scr = decorPlacement.screen;
    const standeeColW = sf.right - sf.left;
    const emptyH = sf.top - st.top;
    // Top-right of the standee window: decor sits in the right portion of the standee column, its right edge
    // near (or just inside) the frame's right edge, not spilling out of the column.
    const inStandeeColumnRightSide = d.cx >= sf.left + standeeColW * 0.35 && d.right <= sf.right + 24 && d.left >= sf.left - 24;
    // In the empty space above the standee frame (does not cover the frame), near its bottom-right corner
    // (decor bottom close to the frame's top edge, not stranded up near the stage top).
    const inEmptySpaceBottom = d.bottom <= sf.top + 8 && d.top >= st.top - 8 && d.bottom >= sf.top - emptyH * 0.75;
    // Negative control vs the pre-move top-left (left:6% ≈ screen*0.06): the decor is well off the far-left.
    const notTopLeft = d.left >= scr.left + scr.width * 0.12;
    check('DECOR: the moving decoration sits at the top-right of the standee window (bottom-right of the empty space above the standee frame), not the screen top-left',
      inStandeeColumnRightSide && inEmptySpaceBottom && notTopLeft,
      { decor: d, standeeFrame: sf, stageTop: st.top, emptyH, inStandeeColumnRightSide, inEmptySpaceBottom, notTopLeft });
  }

  // ── 1.4) NO IN-PROGRESS STATUS TEXT + SCROLL-FOLLOW ACROSS REAL CONTINUATION TURNS (this task) ──
  // Runs BEFORE the static layout probe below, while the entry state (reader pinned to the bottom of the
  // opening) is still pristine. The routing hub no longer surfaces in-progress status text ("送信しています…" /
  // "応答を準備しています…" / "ルミが応答しています…") — the ① responding glow conveys that a turn is in flight —
  // so its status line (an error banner only now) stays hidden through a normal turn and never shrinks the
  // stream. Drive several REAL continuation turns (the stub keeps the player on the hub by deciding no
  // destination) and assert: (a) the status line never shows text at any point during a turn, and (b) after
  // each settles, the newest ルミ reply is pinned to the bottom and fully visible (no status-driven jank).
  // NEGATIVE CONTROL (documented in the task report): re-adding any in-progress setRoutingHubStatus('…') text
  // (revert this task) makes the status line show text mid-turn, so check (a) FAILS — proving this section
  // detects the change and does not pass on unfixed code.
  const followMeasurements = [];
  let followTurns = 0;
  let statusTextEverShownDuringTurn = false;
  for (let i = 0; i < 3; i += 1) {
    const before = await js(win, `document.querySelectorAll('#routing-hub-message-stream .chat-message').length`);
    // The send only fires when it is not in-flight; the real send synchronously clears the input, so an
    // in-flight silent no-op is caught by the input-cleared retry (a routing hub render-harness timing trap).
    const fired = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!input || !send || send.disabled) return false;
      input.value = ${JSON.stringify(CONTINUE_INPUT)};
      send.click();
      return true;
    })()`);
    const sent = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 60, intervalMs: 40 });
    if (!sent) break;
    // (a) While the turn runs, the in-progress status line must NEVER show text. observeTransient returns
    // true if the status is ever visible with non-empty text within the window (old code set 送信/応答 text
    // here synchronously on send and on every delta); with the text removed it stays hidden → returns false.
    const shownThisTurn = await observeTransient(win, `(() => { const s = document.querySelector('#routing-hub-status'); return !!s && s.hidden === false && (s.textContent || '').trim().length > 0; })()`, { tries: 130, intervalMs: 20 });
    if (shownThisTurn) statusTextEverShownDuringTurn = true;
    // Full continuation cycle settled back on the hub: controls re-enabled, ルミ reply appended (player +
    // reply = +2 rows), status hidden (never shown at all), not stranded on the loading screen.
    const settled = await waitFor(win, `
      document.querySelector('#routing-hub-screen')?.classList.contains('active')
      && !document.querySelector('#routing-hub-send')?.disabled
      && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
      && document.querySelectorAll('#routing-hub-message-stream .chat-message').length >= ${before} + 2
      && document.querySelector('#routing-hub-status')?.hidden === true
    `, { tries: 300, intervalMs: 100 });
    if (!settled) break;
    await sleep(400); // let the reply's face image finish loading and the re-pin land
    const measured = await js(win, `(() => {
      const stream = document.querySelector('#routing-hub-message-stream');
      const rows = stream.querySelectorAll('.chat-message');
      const lastRow = rows[rows.length - 1];
      const streamRect = stream.getBoundingClientRect();
      const lastRowRect = lastRow.getBoundingClientRect();
      const bottomGap = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
      const statusEl = document.querySelector('#routing-hub-status');
      return {
        rowCount: rows.length,
        scrollTop: Math.round(stream.scrollTop), scrollHeight: stream.scrollHeight, clientHeight: stream.clientHeight,
        bottomGap: Math.round(bottomGap), atBottom: bottomGap <= 24,
        lastRowVisible: lastRowRect.bottom <= streamRect.bottom + 2,
        overflowing: stream.scrollHeight > stream.clientHeight + 1,
        statusHidden: !!statusEl?.hidden, statusText: (statusEl?.textContent || '').trim()
      };
    })()`);
    followTurns += 1;
    followMeasurements.push(measured);
    log(`follow_turn_${i + 1}`, measured);
  }
  check('NO STATUS TEXT: the in-progress status line never shows text during a normal turn (progress is the ① responding glow, not text)',
    followTurns === 3 && !statusTextEverShownDuringTurn && followMeasurements.every((m) => m.statusHidden && m.statusText === ''),
    { followTurns, statusTextEverShownDuringTurn, settledStatus: followMeasurements.map((m) => ({ hidden: m.statusHidden, text: m.statusText })) });
  const followOverflowed = followMeasurements.some((m) => m.overflowing);
  const followAllStuck = followMeasurements.length > 0 && followMeasurements.every((m) => m.atBottom && m.lastRowVisible);
  check('SCROLL-FOLLOW: after every continuation turn settles, the newest ルミ reply is pinned to the bottom and fully visible (no status-line shrink now that the in-progress text is gone)',
    followTurns === 3 && followAllStuck && followOverflowed, { followTurns, followOverflowed, measurements: followMeasurements });

  // ── 1.5) LAYOUT / WIDTH / VERTICAL-FIT / SCROLL-FOLLOW (task acceptance 1-4) ──
  // Inject a tall history with one very long unbroken run, measure real layout, then restore the true
  // history so the real turn flow below is unaffected. Long text must not widen the panel; the log must
  // scroll internally with the frame/stream/standee inside the viewport; the newest row must be stuck to
  // the bottom and visible; and the standee frame must carry a decorative border.
  // app.js is an ES module, so its internals are not reachable here. Build message rows directly in the
  // DOM (the same structure createMessageRows emits) to exercise the real CSS layout, save/restore the
  // stream's markup so the real turn flow below is unaffected.
  const layoutProbe = await js(win, `(() => {
    const stream = document.querySelector('#routing-hub-message-stream');
    const savedHtml = stream.innerHTML;
    const panel = document.querySelector('.routing-hub-chat-panel');
    const widthBefore = panel.getBoundingClientRect().width;
    const longRun = 'あ'.repeat(400) + ' https://example.com/' + 'x'.repeat(320);
    const faceSrc = document.querySelector('#routing-hub-standee')?.getAttribute('src') || '';
    const rowsHtml = [];
    for (let i = 0; i < 10; i += 1) {
      rowsHtml.push('<article class="chat-message player-message"><div class="message-bubble"><p>短い発言' + i + '</p></div></article>');
      const content = i === 9 ? longRun : ('ルミの応答' + i);
      rowsHtml.push('<article class="chat-message character-message"><div class="message-face"><img src="' + faceSrc + '" alt=""></div><div class="message-bubble"><strong class="message-speaker">ルミ</strong><p>' + content + '</p></div></article>');
    }
    stream.innerHTML = rowsHtml.join('');
    stream.scrollTop = stream.scrollHeight; // emulate the app's stick-to-bottom after a new message
    const standee = document.querySelector('#routing-hub-standee');
    const frameEl = document.querySelector('.routing-hub-frame');
    const standeeFrame = document.querySelector('.routing-hub-standee-frame');
    const rows = stream.querySelectorAll('.chat-message');
    const lastRow = rows[rows.length - 1];
    const stageEl = document.querySelector('.routing-hub-stage');
    const panelRect = panel.getBoundingClientRect();
    const streamRect = stream.getBoundingClientRect();
    const lastRowRect = lastRow.getBoundingClientRect();
    const standeeRect = standee.getBoundingClientRect();
    const standeeFrameRect = standeeFrame.getBoundingClientRect();
    const stageRect = stageEl.getBoundingClientRect();
    const framePseudo = getComputedStyle(standeeFrame, '::before');
    const result = {
      innerW: window.innerWidth, innerH: window.innerHeight,
      widthBefore, widthAfter: panelRect.width, widthDelta: Math.abs(panelRect.width - widthBefore),
      panelRight: panelRect.right, lastRowRight: lastRowRect.right,
      streamScrollH: stream.scrollHeight, streamClientH: stream.clientHeight, streamScrollTop: stream.scrollTop,
      atBottom: (stream.scrollTop + stream.clientHeight) >= (stream.scrollHeight - 3),
      lastRowBottom: lastRowRect.bottom, streamBottom: streamRect.bottom,
      standeeTop: standeeRect.top, standeeBottom: standeeRect.bottom, standeeLeft: standeeRect.left, standeeRight: standeeRect.right,
      standeeZ: getComputedStyle(standee).zIndex, standeeObjectFit: getComputedStyle(standee).objectFit,
      frameBottom: frameEl.getBoundingClientRect().bottom,
      // Standee frame vs chat panel + stage: the frame is ~60% of the stage height, bottom-aligned with the
      // full-height chat panel, leaving empty space above the FRAME; the standee image now FILLS the frame.
      stageTop: stageRect.top, stageBottom: stageRect.bottom, stageHeight: stageRect.height,
      standeeFrameTop: standeeFrameRect.top, standeeFrameBottom: standeeFrameRect.bottom, standeeFrameHeight: standeeFrameRect.height,
      standeeFrameLeft: standeeFrameRect.left, standeeFrameRight: standeeFrameRect.right,
      chatPanelTop: panelRect.top, chatPanelBottom: panelRect.bottom, chatPanelHeight: panelRect.height,
      standeeFrameBorderImage: getComputedStyle(standeeFrame).borderImageSource,
      standeeFramePseudoBg: framePseudo.backgroundImage,
      standeeFramePseudoZ: framePseudo.zIndex,
      // The send/end button row is the lowest chat control; its bottom staying within the viewport is the
      // real "chat does not overflow below the fold" evidence (the box-sizing overflow clipped it before).
      buttonRowBottom: document.querySelector('.routing-hub-button-row').getBoundingClientRect().bottom
    };
    stream.innerHTML = savedHtml;
    return result;
  })()`);
  log('layout_probe', layoutProbe);
  check('WIDTH fixed: long ルミ text does not widen the chat panel and stays within the viewport',
    layoutProbe.widthDelta < 1 && layoutProbe.panelRight <= layoutProbe.innerW + 1 && layoutProbe.lastRowRight <= layoutProbe.innerW + 1,
    { widthBefore: layoutProbe.widthBefore, widthAfter: layoutProbe.widthAfter, panelRight: layoutProbe.panelRight, innerW: layoutProbe.innerW });
  check('VERTICAL fit: log scrolls internally; frame/stream/standee/buttons stay within the viewport',
    layoutProbe.streamScrollH > layoutProbe.streamClientH && layoutProbe.frameBottom <= layoutProbe.innerH + 1 && layoutProbe.streamBottom <= layoutProbe.innerH + 1 && layoutProbe.standeeBottom <= layoutProbe.innerH + 1 && layoutProbe.buttonRowBottom <= layoutProbe.innerH + 1,
    { frameBottom: layoutProbe.frameBottom, streamBottom: layoutProbe.streamBottom, standeeBottom: layoutProbe.standeeBottom, buttonRowBottom: layoutProbe.buttonRowBottom, innerH: layoutProbe.innerH });
  check('SCROLL follow: newest message sticks to the bottom and is visible in the log',
    layoutProbe.atBottom && layoutProbe.lastRowBottom <= layoutProbe.streamBottom + 2,
    { atBottom: layoutProbe.atBottom, lastRowBottom: layoutProbe.lastRowBottom, streamBottom: layoutProbe.streamBottom });
  check('STANDEE decorative frame present (border-image or ::before ornament)',
    (layoutProbe.standeeFrameBorderImage && layoutProbe.standeeFrameBorderImage !== 'none') || (layoutProbe.standeeFramePseudoBg && layoutProbe.standeeFramePseudoBg !== 'none'),
    { borderImage: layoutProbe.standeeFrameBorderImage, pseudoBg: layoutProbe.standeeFramePseudoBg });
  // STANDEE FRAME HEIGHT SHRINK (this task): the standee frame is ~60% of the stage height and bottom-aligned
  // with the full-height chat panel, so their bottoms line up and empty space opens above the standee frame.
  const heightRatio = layoutProbe.standeeFrameHeight / layoutProbe.stageHeight;
  const spaceAboveFrame = layoutProbe.standeeFrameTop - layoutProbe.stageTop;
  check('STANDEE frame is ~60% of the stage height (shorter than the chat window)',
    Math.abs(heightRatio - 0.6) <= 0.06 && layoutProbe.standeeFrameHeight < layoutProbe.chatPanelHeight - 20,
    { standeeFrameHeight: layoutProbe.standeeFrameHeight, stageHeight: layoutProbe.stageHeight, heightRatio: Number(heightRatio.toFixed(3)), chatPanelHeight: layoutProbe.chatPanelHeight });
  check('STANDEE frame bottom aligns with the chat window frame bottom',
    Math.abs(layoutProbe.standeeFrameBottom - layoutProbe.chatPanelBottom) <= 2,
    { standeeFrameBottom: layoutProbe.standeeFrameBottom, chatPanelBottom: layoutProbe.chatPanelBottom });
  check('STANDEE frame leaves empty space above the FRAME (it is 60% of the stage) — the frame dimensions are unchanged',
    spaceAboveFrame >= layoutProbe.stageHeight * 0.3,
    { spaceAboveFrame: Number(spaceAboveFrame.toFixed(1)), stageHeight: layoutProbe.stageHeight, standeeFrameTop: layoutProbe.standeeFrameTop });

  // STANDEE FILLS THE FRAME (this task): the ルミ standee fills the frame edge-to-edge with NO余白 — every gap
  // between the standee element box and the frame is only the 1px border (≤2px tolerance for the border +
  // sub-pixel rounding). object-fit:cover crops the overflow; the frame's own rounded corners are the only
  // allowed逃げ. Measured against REAL Blink layout (the element box, not the source-image bytes).
  const fillGaps = {
    top: layoutProbe.standeeTop - layoutProbe.standeeFrameTop,
    bottom: layoutProbe.standeeFrameBottom - layoutProbe.standeeBottom,
    left: layoutProbe.standeeLeft - layoutProbe.standeeFrameLeft,
    right: layoutProbe.standeeFrameRight - layoutProbe.standeeRight
  };
  const maxFillGap = Math.max(fillGaps.top, fillGaps.bottom, fillGaps.left, fillGaps.right);
  check('STANDEE fills the frame edge-to-edge (no余白: every standee↔frame gap is the 1px border only) via object-fit:cover',
    maxFillGap <= 2 && Math.abs(fillGaps.top) <= 2 && Math.abs(fillGaps.bottom) <= 2 && Math.abs(fillGaps.left) <= 2 && Math.abs(fillGaps.right) <= 2 && layoutProbe.standeeObjectFit === 'cover',
    { fillGaps, maxFillGap, objectFit: layoutProbe.standeeObjectFit });
  // The corner ornaments hug the corners OVER the image (::before z-index 3 > standee z-index 1), so they かかる
  // on the image edge instead of sitting behind it.
  check('STANDEE ornaments overlap the image (::before z-index > standee z-index, 少しかかる)',
    Number(layoutProbe.standeeFramePseudoZ) > Number(layoutProbe.standeeZ),
    { ornamentZ: layoutProbe.standeeFramePseudoZ, standeeZ: layoutProbe.standeeZ });

  // ── 1.55) SPEAKER-SIDE BUBBLE ALIGNMENT (this task) ───────────────────────
  // Inject one long line of each of the four routing message types, measure real Blink layout, then restore.
  // ルミ側 (character-message 発話 / narration-message 地の文) hug the LEFT of the icon-excluded area; 主人公側
  // (player-message 発話 / player-narration-message 地の文) hug the RIGHT; every bubble's resolved max-width is
  // 80% of (row width − icon column 129px face + 12px gap = 141px); and a long 主人公 line never crosses into
  // ルミの顔アイコン列 (its left edge stays right of the 141px column).
  const alignProbe = await js(win, `(() => {
    const stream = document.querySelector('#routing-hub-message-stream');
    const savedHtml = stream.innerHTML;
    const faceSrc = document.querySelector('#routing-hub-standee')?.getAttribute('src') || '';
    const long = 'あ'.repeat(300);
    stream.innerHTML = [
      '<article class="chat-message character-message" data-t="lumi"><div class="message-face"><img src="' + faceSrc + '" alt=""></div><div class="message-bubble"><strong class="message-speaker">ルミ</strong><p>' + long + '</p></div></article>',
      '<article class="chat-message narration-message" data-t="lumiNarr"><div class="message-bubble"><p>' + long + '</p></div></article>',
      '<article class="chat-message player-message" data-t="player"><div class="message-bubble"><p>' + long + '</p></div></article>',
      '<article class="chat-message player-narration-message" data-t="playerNarr"><div class="message-bubble"><p>' + long + '</p></div></article>'
    ].join('');
    const ICON = 129 + 12;
    const measure = (t) => {
      const row = stream.querySelector('.chat-message[data-t="' + t + '"]');
      const bubble = row.querySelector('.message-bubble');
      const cs = getComputedStyle(bubble);
      const sr = stream.getBoundingClientRect();
      const br = bubble.getBoundingClientRect();
      // .message-bubble is content-box, so its content width is capped at the max-width. A long line fills
      // it, so the measured content width (border-box minus padding + border) equals the 80% cap.
      const contentW = br.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      return {
        leftInset: Math.round((br.left - sr.left) * 10) / 10,
        rightInset: Math.round((sr.right - br.right) * 10) / 10,
        contentW: Math.round(contentW * 10) / 10,
        expectedCap: Math.round(0.8 * (row.clientWidth - ICON) * 10) / 10,
        iconCol: ICON
      };
    };
    const result = {
      lumi: measure('lumi'), lumiNarr: measure('lumiNarr'),
      player: measure('player'), playerNarr: measure('playerNarr')
    };
    stream.innerHTML = savedHtml;
    return result;
  })()`);
  log('align_probe', alignProbe);
  const capOk = (m) => Math.abs(m.contentW - m.expectedCap) <= 2;
  check('SPEAKER-SIDE: every message type caps at 80% of the icon-excluded row width (resolved max-width; no unclassified type)',
    capOk(alignProbe.lumi) && capOk(alignProbe.lumiNarr) && capOk(alignProbe.player) && capOk(alignProbe.playerNarr), alignProbe);
  check('SPEAKER-SIDE: ルミの発話・地の文 hug the LEFT of the icon-excluded area (bubble starts at the 141px icon column)',
    Math.abs(alignProbe.lumi.leftInset - alignProbe.lumi.iconCol) <= 3 && Math.abs(alignProbe.lumiNarr.leftInset - alignProbe.lumiNarr.iconCol) <= 3,
    { lumiLeftInset: alignProbe.lumi.leftInset, lumiNarrLeftInset: alignProbe.lumiNarr.leftInset });
  check('SPEAKER-SIDE: 主人公の発話・地の文 hug the RIGHT and never cross into ルミの顔アイコン列 (left inset ≥ 141px column, right inset ~0)',
    alignProbe.player.rightInset <= 10 && alignProbe.playerNarr.rightInset <= 10
    && alignProbe.player.leftInset >= alignProbe.player.iconCol && alignProbe.playerNarr.leftInset >= alignProbe.playerNarr.iconCol,
    { playerLeftInset: alignProbe.player.leftInset, playerRightInset: alignProbe.player.rightInset, playerNarrLeftInset: alignProbe.playerNarr.leftInset, playerNarrRightInset: alignProbe.playerNarr.rightInset });

  // ── 1.6) CORNER ORNAMENT ORIENTATION + POSITION (this task) ────────────────
  // The chat panel corners are both corner_01: the top-left seats UPRIGHT, the bottom-right is its 180° point
  // reflection (scale(-1,-1) = 上下左右反転) composed after the same calibration translate. The standee frame
  // carries its horizontal-mirror family, corner_02, with its bottom-right the 180° point reflection of its
  // top-left. Verified against the REAL computed transforms in Blink (matrix values, tolerance for float
  // rounding on the ±90° rotations), the corner assets, and the chat corner img seating relative to the panel
  // corner. Each transform carries its baked calibration translate; the expected matrices below fold in those
  // baked offsets (scale(-1,-1) about the img centre leaves its bounding rect unchanged, so the BR seating is
  // still the -6px base + baked translate):
  //   chat    TL: translate(-6,-8)             => matrix(1,0,0,1,-6,-8)   (corner_01 upright)
  //   chat    BR: translate(7,9) scale(-1,-1)  => matrix(-1,0,0,-1,7,9)   (corner_01 point reflection of the TL)
  //   standee ::before TL: translate(-1,-6) rotate(-90deg) => matrix(0,-1,1,0,-1,-6)  (corner_02, top-left)
  //   standee ::after  BR: translate(2,6)   rotate(+90deg) => matrix(0,1,-1,0,2,6)    (= TL + 180°, bottom-right)
  const cornerProbe = await js(win, `(() => {
    const norm = (t) => (!t || t === 'none' ? 'none' : t.replace(/\\s+/g, ''));
    const chatTL = document.querySelector('.routing-hub-corner-tl');
    const chatBR = document.querySelector('.routing-hub-corner-br');
    const panel = document.querySelector('.routing-hub-chat-panel');
    const sframe = document.querySelector('.routing-hub-standee-frame');
    const before = getComputedStyle(sframe, '::before');
    const after = getComputedStyle(sframe, '::after');
    const pr = panel.getBoundingClientRect();
    const tlr = chatTL.getBoundingClientRect();
    const brr = chatBR.getBoundingClientRect();
    return {
      chatTLsrc: chatTL.getAttribute('src'), chatBRsrc: chatBR.getAttribute('src'),
      chatTLtransform: norm(getComputedStyle(chatTL).transform), chatBRtransform: norm(getComputedStyle(chatBR).transform),
      beforeBg: before.backgroundImage, afterBg: after.backgroundImage,
      beforeContent: before.content, afterContent: after.content,
      beforeTransform: norm(before.transform), afterTransform: norm(after.transform),
      beforeTop: parseFloat(before.top), beforeLeft: parseFloat(before.left),
      afterBottom: parseFloat(after.bottom), afterRight: parseFloat(after.right),
      // chat corner img seating vs the panel corners: TL box at (-6,-6), BR box at (+6,+6) from the corner.
      chatTL_dx: tlr.left - pr.left, chatTL_dy: tlr.top - pr.top,
      chatBR_dx: brr.right - pr.right, chatBR_dy: brr.bottom - pr.bottom
    };
  })()`);
  log('corner_probe', cornerProbe);
  // Parse a normalized `matrix(a,b,c,d,e,f)` and compare component-wise with tolerance (Blink serializes 90°
  // rotations with a tiny cos(90°) epsilon, so an exact string match would be fragile).
  const parseMatrix = (t) => { const m = /^matrix\(([^)]+)\)$/.exec(t); return m ? m[1].split(',').map(Number) : null; };
  const matrixApprox = (t, expected) => { const g = parseMatrix(t); return !!g && g.length === expected.length && expected.every((v, i) => Math.abs(g[i] - v) <= 1e-4); };
  check('CORNER chat (corner_01 on both): TL=corner_01 upright, BR=corner_01 point-reflected scale(-1,-1) (= the 180° point reflection of the TL) — each with its baked calibration translate',
    /corner_01\.png$/.test(cornerProbe.chatTLsrc) && /corner_01\.png$/.test(cornerProbe.chatBRsrc)
    && matrixApprox(cornerProbe.chatTLtransform, [1, 0, 0, 1, -6, -8]) && matrixApprox(cornerProbe.chatBRtransform, [-1, 0, 0, -1, 7, 9]),
    { chatTLsrc: cornerProbe.chatTLsrc, chatBRsrc: cornerProbe.chatBRsrc, chatTLtransform: cornerProbe.chatTLtransform, chatBRtransform: cornerProbe.chatBRtransform });
  check('CORNER standee (corner_02 system): ::before=corner_02 rotate(-90deg) TL, ::after=corner_02 rotate(+90deg) BR (= TL + 180°, point reflection) — each with its baked calibration translate',
    cornerProbe.afterContent !== 'none' && cornerProbe.afterContent !== 'normal'
    && /corner_02\.png/.test(cornerProbe.beforeBg) && /corner_02\.png/.test(cornerProbe.afterBg)
    && matrixApprox(cornerProbe.beforeTransform, [0, -1, 1, 0, -1, -6]) && matrixApprox(cornerProbe.afterTransform, [0, 1, -1, 0, 2, 6]),
    { beforeBg: cornerProbe.beforeBg, afterBg: cornerProbe.afterBg, beforeTransform: cornerProbe.beforeTransform, afterTransform: cornerProbe.afterTransform, afterContent: cornerProbe.afterContent });
  // Chat corner img seating measured against REAL Blink layout. TL box seats at ≈(-11,-14) from the panel
  // corner (bottom/right base -6px + baked translate, over the panel's 1px border). The BR box seats at
  // ≈(+12,+14): the `scale(-1,-1)` flip reflects the box about its centre before the composed translate, so
  // its bottom-edge offset is the flip's counterpart, not the +9 the raw --rh-chat-corner-br-dy suggests — the
  // earlier (+11,+9) expectation was a harness-side hand-derivation of the flip that under-counted the bottom
  // edge by ~5px (the routing-hub corner CSS/vars and corner_01 asset are unchanged; this only corrects the
  // measured seating expectation to the actual render). The corner_01 point-reflection correctness itself is
  // verified independently by the transform-matrix check above. Standee ::before/::after keep their static
  // -6px top/left/bottom/right (the translate rides in the transform, not these offsets).
  check('CORNER position: chat corners seat at the -6px base + baked translate (TL≈-11,-14 ; BR≈+12,+14) and standee corners are pinned at -6px (TL top/left, BR bottom/right)',
    Math.abs(cornerProbe.chatTL_dx + 11) <= 3 && Math.abs(cornerProbe.chatTL_dy + 14) <= 3
    && Math.abs(cornerProbe.chatBR_dx - 12) <= 3 && Math.abs(cornerProbe.chatBR_dy - 14) <= 3
    && Math.abs(cornerProbe.beforeTop + 6) <= 1 && Math.abs(cornerProbe.beforeLeft + 6) <= 1
    && Math.abs(cornerProbe.afterBottom + 6) <= 1 && Math.abs(cornerProbe.afterRight + 6) <= 1,
    { chatTL_dx: cornerProbe.chatTL_dx, chatTL_dy: cornerProbe.chatTL_dy, chatBR_dx: cornerProbe.chatBR_dx, chatBR_dy: cornerProbe.chatBR_dy, beforeTop: cornerProbe.beforeTop, beforeLeft: cornerProbe.beforeLeft, afterBottom: cornerProbe.afterBottom, afterRight: cornerProbe.afterRight });

  // ── 2) INFO DRAWER (each category opens with content as a rail-linked drawer, marks its rail button
  //       selected, then closes and clears the selection) ────────────────────
  for (const category of ['self', 'buddy', 'enemy', 'inventory', 'money']) {
    await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="${category}"]').click(); true`);
    const opened = await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden && (document.querySelector('#routing-hub-info-popup-body')?.childElementCount || 0) > 0`, { tries: 40, intervalMs: 40 });
    const title = await js(win, `document.querySelector('#routing-hub-info-popup-title')?.textContent || ''`);
    check(`info drawer [${category}] opens with content`, opened, { title });
    // Selected rail state: exactly the opened category's rail button carries .is-active while open.
    const selected = await js(win, `[...document.querySelectorAll('#routing-hub-screen .routing-hub-category-button')].filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.routingCategory)`);
    check(`info drawer [${category}] marks exactly its rail button selected`,
      selected.length === 1 && selected[0] === category, { selected });
    await js(win, `document.querySelector('#routing-hub-info-popup .routing-hub-info-popup-close').click(); true`);
    await waitFor(win, `document.querySelector('#routing-hub-info-popup').hidden === true`, { tries: 40, intervalMs: 40 });
    const clearedAfterClose = await js(win, `[...document.querySelectorAll('#routing-hub-screen .routing-hub-category-button')].every((b) => !b.classList.contains('is-active'))`);
    check(`info drawer [${category}] clears the selected rail state on close`, clearedAfterClose, { clearedAfterClose });
  }

  // Drawer geometry (task acceptance 1): the info popup opens as a LEFT drawer from the rail's right edge —
  // left-hugging (not centered), roughly full frame height, and the chat panel stays visible beside it
  // (ルミと会話が見え続ける). Measured against real Blink layout.
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="self"]').click(); true`);
  await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden`, { tries: 40, intervalMs: 40 });
  const drawer = await js(win, `(() => {
    const card = document.querySelector('#routing-hub-info-popup .routing-hub-info-popup-card');
    const rail = document.querySelector('#routing-hub-screen .routing-hub-category-rail');
    const chat = document.querySelector('#routing-hub-screen .routing-hub-chat-panel');
    const frame = document.querySelector('#routing-hub-screen .routing-hub-frame');
    const cr = card.getBoundingClientRect();
    return {
      winW: window.innerWidth,
      cardLeft: cr.left, cardRight: cr.right, cardHeight: cr.height,
      railRight: rail.getBoundingClientRect().right,
      chatLeft: chat.getBoundingClientRect().left, chatRight: chat.getBoundingClientRect().right,
      frameHeight: frame.getBoundingClientRect().height
    };
  })()`);
  log('drawer_geometry', drawer);
  check('DRAWER: opens from the rail right edge, left-hugging (not centered), roughly full height',
    drawer.cardLeft >= drawer.railRight - 2
    && ((drawer.winW - drawer.cardRight) - drawer.cardLeft) > 120
    && drawer.cardHeight >= drawer.frameHeight * 0.85, drawer);
  check('DRAWER: the chat panel stays visible beside the drawer (chat left >= card right)',
    drawer.chatLeft >= drawer.cardRight - 8 && drawer.chatRight <= drawer.winW + 1, drawer);
  await js(win, `document.querySelector('#routing-hub-info-popup .routing-hub-info-popup-close').click(); true`);
  await waitFor(win, `document.querySelector('#routing-hub-info-popup').hidden === true`, { tries: 40, intervalMs: 40 });

  // Category SWITCH WHILE OPEN (task acceptance カテゴリ切替): open self, then click buddy WITHOUT closing.
  // The drawer must stay open with the body / title / header icon / selected rail state all swapped to buddy.
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="self"]').click(); true`);
  await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden`, { tries: 40, intervalMs: 40 });
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="buddy"]').click(); true`);
  const switched = await js(win, `(() => {
    const popup = document.querySelector('#routing-hub-info-popup');
    const active = [...document.querySelectorAll('#routing-hub-screen .routing-hub-category-button')].filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.routingCategory);
    return {
      stillOpen: !popup.hidden,
      title: document.querySelector('#routing-hub-info-popup-title')?.textContent || '',
      iconSrc: document.querySelector('#routing-hub-info-popup-icon')?.getAttribute('src') || '',
      bodyChildren: document.querySelector('#routing-hub-info-popup-body')?.childElementCount || 0,
      active
    };
  })()`);
  log('category_switch_while_open', switched);
  check('SWITCH: clicking another category while the drawer is open swaps content + selection without closing',
    switched.stillOpen && switched.title === 'バディ' && switched.iconSrc.includes('/routing/icons/buddy.png')
    && switched.bodyChildren > 0 && switched.active.length === 1 && switched.active[0] === 'buddy', switched);

  // BACKDROP-CLICK DISMISSAL (task 出方: v1 keeps modal dismissal): clicking the thin backdrop closes the drawer.
  const backdropClosed = await js(win, `(() => {
    document.querySelector('#routing-hub-info-popup .routing-hub-info-popup-backdrop').click();
    return true;
  })()`).then(() => waitFor(win, `document.querySelector('#routing-hub-info-popup').hidden === true`, { tries: 40, intervalMs: 40 }));
  check('BACKDROP: clicking the backdrop dismisses the drawer', backdropClosed, {});

  // RUNTIME FAIL-FAST (broken markup): with the header icon node's id broken, opening a category still throws
  // in conversationStage.openInfo ('…info popup icon node is missing (broken markup wiring)'), but the rail
  // click handler wraps openInfo in `try { … } catch (error) { reportError(error) }`, so the throw is SURFACED
  // through reportError (→ console.error, a level≥3 renderer console error) rather than a silent no-op — and the
  // drawer stays hidden with no rail button selected. (The throw itself is unchanged; the conversation-stage
  // component generalization moved its surfacing from an uncaught window error to the caught reportError path,
  // so this check watches the surfaced console error instead of a window 'error' event.) Capture the surfaced
  // broken-markup console error on the Node side, then restore the id so later sections are unaffected.
  let brokenMarkupErrorSurfaced = false;
  const onBrokenMarkupConsole = (_e, level, message) => { if (level >= 3 && message.includes('broken markup wiring')) brokenMarkupErrorSurfaced = true; };
  win.webContents.on('console-message', onBrokenMarkupConsole);
  await js(win, `document.querySelector('#routing-hub-info-popup-icon').id = 'routing-hub-info-popup-icon-broken'; true`);
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="self"]').click(); true`);
  await sleep(200); // let the renderer→main console-message IPC for the surfaced reportError console.error arrive
  win.webContents.off('console-message', onBrokenMarkupConsole);
  const iconFailFast = await js(win, `(() => {
    document.querySelector('#routing-hub-info-popup-icon-broken').id = 'routing-hub-info-popup-icon';
    const active = [...document.querySelectorAll('#routing-hub-screen .routing-hub-category-button')].some((b) => b.classList.contains('is-active'));
    return { hidden: document.querySelector('#routing-hub-info-popup').hidden, anyActive: active };
  })()`);
  iconFailFast.errorSurfaced = brokenMarkupErrorSurfaced;
  log('icon_fail_fast', iconFailFast);
  check('FAIL-FAST: a broken header icon node makes opening a category throw and surface via reportError (no silent no-op), leaving the drawer hidden',
    iconFailFast.errorSurfaced && iconFailFast.hidden && !iconFailFast.anyActive, iconFailFast);

  // Close-button redesign (task acceptance 5): open one popup and measure the close button is styled
  // with the routing tone (a real filled/bordered control, not the bare default). Then close.
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="self"]').click(); true`);
  await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden`, { tries: 40, intervalMs: 40 });
  const closeBtn = await js(win, `(() => {
    const btn = document.querySelector('#routing-hub-info-popup .routing-hub-info-popup-close');
    const cs = getComputedStyle(btn);
    const before = getComputedStyle(btn, '::before');
    return {
      borderRadius: cs.borderRadius, background: cs.backgroundImage, backgroundColor: cs.backgroundColor,
      boxShadow: cs.boxShadow, borderColor: cs.borderColor, hasGlyphBefore: before.content && before.content !== 'none' && before.content !== 'normal'
    };
  })()`);
  log('close_button', closeBtn);
  check('POPUP close button is redesigned in the routing tone (filled/gradient or glow, not the bare default)',
    (closeBtn.background && closeBtn.background !== 'none') || (closeBtn.boxShadow && closeBtn.boxShadow !== 'none') || closeBtn.hasGlyphBefore,
    closeBtn);
  await js(win, `document.querySelector('#routing-hub-info-popup .routing-hub-info-popup-close').click(); true`);
  await waitFor(win, `document.querySelector('#routing-hub-info-popup').hidden === true`, { tries: 40, intervalMs: 40 });

  // ── 3) CONTINUATION + DESTINATION DECISION + 統一出現規律 + 見送り読みポーズ + TRANSITION + ①②③ (this task) ──
  await waitFor(win, `!document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
  // Leave a category popup OPEN before the dispatch, to prove it does not persist onto the restored hub.
  await js(win, `document.querySelector('.routing-hub-category-button[data-routing-category="self"]').click(); true`);
  const popupOpenBeforeDispatch = await waitFor(win, `!document.querySelector('#routing-hub-info-popup').hidden`, { tries: 40, intervalMs: 40 });
  await js(win, `(() => {
    document.querySelector('#routing-hub-input').value = ${JSON.stringify(PLAYER_INPUT)};
    document.querySelector('#routing-hub-send').click();
    return true;
  })()`);
  const spoke = await observeTransient(win, `document.querySelector('#routing-hub-screen').classList.contains('is-player-spoke')`);
  check('② player-spoke flare fires on send', spoke);
  const responding = await observeTransient(win, `document.querySelector('#routing-hub-screen').classList.contains('is-lumi-responding')`, { tries: 250, intervalMs: 20 });
  check('① ルミ-responding class fires while the reply streams', responding);

  // ORDER A — result-first. The stub drain is fast (no injected delay), so the backend `result` arrives WHILE
  // the ~5s 見送り読みポーズ is still running. Measure the two task behaviours against real timing:
  //   (a) 統一出現規律: the send-off 吹き出し (発話・地の文・発話) appear one at a time, spaced by the popup
  //       cooldown — the span between the FIRST and LAST send-off 吹き出し is ~2×cooldown, not ~0 (all-at-once).
  //   (b) 見送り読みポーズ: the full send-off is held visible on the hub with NO loading screen for ~5s (the hub
  //       stays up for the whole pause EVEN THOUGH the drain already finished), THEN the loading screen takes
  //       over and, since the result is already in hand, the transition follows promptly (small postLoadingMs).
  // NEGATIVE CONTROLS (documented in the report): reverting to the all-at-once reveal collapses the span in (a)
  // to ~0; reverting the concurrency so the pause is serialized after the drain does not change (b) here because
  // the drain is fast — Order B below is the case that discriminates the concurrency fix.
  const timingA = await measureDispatchTiming(win, { sendoffFirst: SENDOFF_FIRST, sendoffLast: SENDOFF_LAST, destinationSelector: '#academy-training-screen' });
  log('dispatch_timing_orderA_resultFirst', timingA);
  check('③ dispatch climax / drain loading screen fires on the decided turn', timingA.climaxSeen || timingA.loadingAt !== null, { climaxSeen: timingA.climaxSeen, loadingAt: timingA.loadingAt });
  check('統一出現規律: the send-off 吹き出し appear one at a time spaced by the popup cooldown (not all-at-once)',
    timingA.firstSendoffAt !== null && timingA.allSendoffAt !== null && timingA.sendoffSpanMs >= 600, { firstSendoffAt: timingA.firstSendoffAt, allSendoffAt: timingA.allSendoffAt, sendoffSpanMs: timingA.sendoffSpanMs });
  check('見送り読みポーズ (Order A / result-first): the full send-off is held visible on the hub (no loading screen) ~5s before the loading screen, and the transition follows promptly since the result was already in hand',
    timingA.allSendoffAt !== null && timingA.loadingAt !== null && timingA.loadingAt > timingA.allSendoffAt && timingA.readingPauseMs >= 4000 && timingA.postLoadingMs >= 0 && timingA.postLoadingMs <= 3500,
    { allSendoffAt: timingA.allSendoffAt, loadingAt: timingA.loadingAt, readingPauseMs: timingA.readingPauseMs, postLoadingMs: timingA.postLoadingMs });

  const dispatched = timingA.transitionAt !== null;
  await sleep(300);
  const sendoffSeen = await js(win, `(document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(SENDOFF_LAST)})`);
  check('CONTINUATION + DESTINATION: send-off revealed in the hub stream, then transitions to the decided content screen (academy-training)',
    dispatched && sendoffSeen, { finalScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`), sendoffSeen });

  // ── 4) RESTORE (見送り→コンテンツ→復帰 通し): complete the dispatched training IN-SESSION. For routing,
  //    routeAfterCompletedAcademyTraining('interaction') returns to the hub via enterRoutingHub — the real
  //    post-content 復帰 route (NOT a fresh new game). Drive the training option cards until the hub returns.
  const onTraining = await js(win, `document.querySelector('#academy-training-screen')?.classList.contains('active')`);
  let returnedToHub = false;
  let trainingActions = 0;
  for (let i = 0; i < 16 && !returnedToHub; i += 1) {
    const clicked = await js(win, `(() => {
      const card = document.querySelector('#academy-training-options button.training-option-card:not([disabled])');
      if (!card) return false;
      card.click();
      return true;
    })()`);
    if (!clicked) { await sleep(200); }
    else { trainingActions += 1; }
    // Let the action (effect / day-transition animations, LM round-trip) settle, or the hub reappear.
    await waitFor(win, `
      document.querySelector('#routing-hub-screen')?.classList.contains('active')
      || document.querySelector('#academy-training-options button.training-option-card:not([disabled])')
    `, { tries: 100, intervalMs: 150 });
    returnedToHub = await js(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active')`);
  }
  check('RESTORE (見送り→コンテンツ→復帰): completing the dispatched training returns to the routing hub IN-SESSION (routeAfterCompletedAcademyTraining -> enterRoutingHub)',
    onTraining && returnedToHub, { trainingActions, activeScreen: await js(win, `document.querySelector('.screen.active')?.id ?? null`) });

  // The info popup was left OPEN before the dispatch; the restored hub must not carry it over (常時は出さない).
  const popupHiddenAfterRestore = await js(win, `document.querySelector('#routing-hub-info-popup').hidden === true`);
  check('POPUP RESET: an info popup left open before dispatch does not persist onto the restored hub (常時は出さない)',
    popupOpenBeforeDispatch && returnedToHub && popupHiddenAfterRestore, { popupOpenBeforeDispatch, popupHiddenAfterRestore });

  // ── 4.5) ORDER B — pause-first (backend drain outlasts the 見送り読みポーズ) (this task) ─────────────────
  // Inject a slow backend drain (hold the first finalization round-trip 9s, past the client's 5s reading
  // pause), then dispatch a decided training turn from the restored hub. The concurrency fix must:
  //   • keep the reading pause ~5s (measured send-off-reveal → loading screen): it runs CONCURRENTLY with the
  //     drain, so it does NOT balloon to (drain + 5s); and
  //   • raise the drain loading screen the moment the pause elapses (before the result), then transition only
  //     once the slow drain delivers the result (a clearly non-trivial postLoadingMs).
  // NEGATIVE CONTROL (documented in the report): with the pre-concurrency serial flow the pause only starts
  // AFTER the result, so with this 9s drain readingPauseMs would be ~13-14s (not ~5s) — the readingPauseMs
  // upper bound below FAILs, so this section discriminates the concurrency fix rather than passing on unfixed code.
  const orderBReady = returnedToHub && await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 200, intervalMs: 100 });
  lm.control.finalizationDelayMs = 9000;
  let orderBSent = false;
  for (let attempt = 0; attempt < 20 && orderBReady && !orderBSent; attempt += 1) {
    const fired = await js(win, `(() => {
      const input = document.querySelector('#routing-hub-input');
      const send = document.querySelector('#routing-hub-send');
      if (!input || !send || send.disabled) return false;
      input.value = ${JSON.stringify(PLAYER_INPUT)};
      send.click();
      return true;
    })()`);
    orderBSent = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 });
    if (!orderBSent) await sleep(400);
  }
  const timingB = orderBSent
    ? await measureDispatchTiming(win, { sendoffFirst: SENDOFF_FIRST, sendoffLast: SENDOFF_LAST, destinationSelector: '#academy-training-screen' })
    : null;
  lm.control.finalizationDelayMs = 0; // disarm so the later sections' drains stay fast (Order A)
  log('dispatch_timing_orderB_pauseFirst', timingB);
  check('見送り読みポーズ (Order B / pause-first): with a slow (9s) drain the reading pause still runs ~5s CONCURRENTLY with the drain (readingPauseMs does not balloon to drain+5s); the drain loading screen appears when the pause elapses (before the result); the transition only lands once the slow drain delivers the result (non-trivial postLoadingMs)',
    Boolean(timingB && timingB.allSendoffAt !== null && timingB.loadingAt !== null && timingB.transitionAt !== null
      && timingB.readingPauseMs >= 4000 && timingB.readingPauseMs <= 7500 && timingB.postLoadingMs >= 2000),
    timingB ?? { orderBSent, orderBReady });

  // ── 5) ACADEMY-MAP ARRIVAL FRESHNESS + WEEKLY REROLL (this task) ───────────
  // A routing dispatch to 学院マップ must (Goal 1) refresh the server-evaluated field under the loading
  // screen so the map's stage descriptions match server truth, and (Goal 2) force a weekly placement reroll
  // so characters move between stages week over week. Drive TWO real routing academy-map arrivals separated
  // by a real stage conversation (the routing content-return that re-opens the hub) and measure both against
  // real layout / the live server field.
  // NEGATIVE CONTROL (documented in the task report): reverting the fix (performRoutingTurnDispatch back to
  // refreshBeforeNextScreen:false with no rerollAcademyMap) leaves currentField stale (the current-stage
  // description no longer equals the live /api/field truth) and preserves last week's placement (the
  // occupants signature is identical across the two arrivals) — both checks below FAIL, so they discriminate
  // the fix rather than passing on unfixed code.
  const mapReset = await newGameToHub(win, base);
  const dispatched1 = mapReset && await dispatchFromHubToMap(win);
  const arrival1 = dispatched1 ? await captureAcademyMapArrival(win) : null;
  log('academy_map_arrival_1', arrival1 ? { elapsedWeeks: arrival1.elapsedWeeks, nodeCount: arrival1.nodeCount, occupiedStages: arrival1.occupiedStages, currentSituation: arrival1.currentSituation.slice(0, 28) } : null);
  check('ACADEMY-MAP arrival 1: a routing 学院マップ dispatch lands on the academy map',
    Boolean(dispatched1 && arrival1 && arrival1.nodeCount > 0), { dispatched1, nodeCount: arrival1?.nodeCount });
  check('FRESHNESS (Goal 1): after the routing arrival the map shows the live server-evaluated current-stage situation (fresh /api/field), not a stale cached description',
    Boolean(arrival1 && arrival1.currentSituation && arrival1.descriptions.includes(arrival1.currentSituation)),
    { currentSituation: arrival1?.currentSituation?.slice(0, 40), matched: Boolean(arrival1 && arrival1.descriptions.includes(arrival1.currentSituation)) });

  const dayLayout = dispatched1 ? await captureAcademyMapDayLayout(win) : null;
  log('academy_map_day_layout', dayLayout);
  check('DAY LAYER: the arrived academy map wears the day layout — sun week glyph (第N週), left 5-category rail, 9-slice frame + 4 corner ornaments, and the rail opens/closes the day info drawer with rendered content',
    Boolean(dayLayout
      && /第\d+週/.test(dayLayout.week)
      && dayLayout.railCount === 5
      && dayLayout.hasFrame
      && dayLayout.cornerCount === 4
      && dayLayout.drawerOpen && dayLayout.drawerBodyFilled && dayLayout.railActive
      && dayLayout.drawerClosed && dayLayout.railCleared),
    dayLayout);
  check('DAY LAYER rail-switch: with the drawer open the rail stays usable (real hit-test resolves to the rail, not the backdrop) and clicking another category switches content+selection WITHOUT closing first',
    Boolean(dayLayout
      && dayLayout.railHittableWhileOpen
      && dayLayout.stillOpenAfterSwitch
      && dayLayout.switchedTitle === 'バディ'
      && dayLayout.buddyActiveAfterSwitch
      && dayLayout.selfClearedAfterSwitch),
    dayLayout);

  const returned = arrival1 ? await returnFromAcademyMapToHub(win) : false;
  check('RETURN: a real academy stage conversation returns to the routing hub (routing content-return re-opens the hub)', returned, {});
  const dispatched2 = returned && await dispatchFromHubToMap(win);
  const arrival2 = dispatched2 ? await captureAcademyMapArrival(win) : null;
  log('academy_map_arrival_2', arrival2 ? { elapsedWeeks: arrival2.elapsedWeeks, occupiedStages: arrival2.occupiedStages, currentSituation: arrival2.currentSituation.slice(0, 28) } : null);
  check('FRESHNESS (Goal 1) week 2: the map still shows the live server current-stage situation after the second arrival',
    Boolean(arrival2 && arrival2.currentSituation && arrival2.descriptions.includes(arrival2.currentSituation)),
    { currentSituation: arrival2?.currentSituation?.slice(0, 40) });
  const weekAdvanced = Boolean(arrival1 && arrival2 && Number.isFinite(arrival1.elapsedWeeks) && Number.isFinite(arrival2.elapsedWeeks) && arrival2.elapsedWeeks > arrival1.elapsedWeeks);
  const placementChanged = Boolean(arrival1 && arrival2 && arrival1.occupantsSignature !== arrival2.occupantsSignature && arrival1.occupiedStages > 0 && arrival2.occupiedStages > 0);
  check('WEEKLY REROLL (Goal 2): the academy-map placement changes across weeks (occupants shuffle between stages) and the week advanced',
    weekAdvanced && placementChanged,
    { week1: arrival1?.elapsedWeeks, week2: arrival2?.elapsedWeeks, weekAdvanced, placementChanged, occupied1: arrival1?.occupiedStages, occupied2: arrival2?.occupiedStages });

  // ── 5.5) ROUTING ARRIVAL FIELD-REFRESH FAIL-FAST (this task, Goal 3) ───────
  // A failed /api/field refresh on the routing academy-map arrival must fail-fast: the destination must NOT
  // be rendered on a stale field, and the player must not be stranded on the loading screen. Fail every
  // /api/field request via CDP once the hub is open, drive a routing 学院マップ dispatch, and assert the map
  // is not shown, the loading screen is not terminal, and the failure is surfaced (recover to the hub with
  // the cause). NEGATIVE CONTROL (documented in the report): with the resilient (non-strict) refresh, the
  // arrival would still render the academy map on the stale cached field — mapActive would be true and this
  // check would FAIL.
  let fieldFailArmed = false;
  const failFieldHandler = (_event, method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const isField = (params.request?.url || '').includes('/api/field');
    if (fieldFailArmed && isField) {
      win.webContents.debugger.sendCommand('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }).catch(() => {});
    } else {
      win.webContents.debugger.sendCommand('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    }
  };
  let failFast = { reached: false };
  try {
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', failFieldHandler);
    await win.webContents.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*/api/field' }] });
    const hubForFail = await newGameToHub(win, base); // field still available here (not armed yet)
    fieldFailArmed = true; // now every /api/field fetch fails — including the arrival's strict refresh
    let sentFail = false;
    for (let attempt = 0; attempt < 20 && !sentFail; attempt += 1) {
      await waitFor(win, `document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled`, { tries: 100, intervalMs: 100 });
      const fired = await js(win, `(() => { const i=document.querySelector('#routing-hub-input'); const s=document.querySelector('#routing-hub-send'); if(!i||!s||s.disabled) return false; i.value=${JSON.stringify(MAP_INPUT)}; s.click(); return true; })()`);
      sentFail = fired && await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 50 });
      if (!sentFail) await sleep(400);
    }
    // Wait for the arrival to FULLY settle (past the ~5s 見送り読みポーズ + loading screen): recovered to an
    // interactive hub with the send re-enabled (fix), stranded on the academy map (bug — stale render), or a
    // settings redirect (LM-class errors; not this /api/field case). Gating on the re-enabled hub send avoids
    // matching the pre-loading send-off pause (hub active but the turn still in flight).
    await waitFor(win, `
      (document.querySelector('#routing-hub-screen')?.classList.contains('active') && !document.querySelector('#routing-hub-send')?.disabled && !document.querySelector('#academy-loading-screen')?.classList.contains('active'))
      || document.querySelector('#academy-map-screen')?.classList.contains('active')
      || document.querySelector('#settings-screen')?.classList.contains('active')
    `, { tries: 600, intervalMs: 120 });
    await sleep(300);
    failFast = {
      reached: true, sentFail,
      mapActive: await js(win, `!!document.querySelector('#academy-map-screen')?.classList.contains('active')`),
      loadingActive: await js(win, `!!document.querySelector('#academy-loading-screen')?.classList.contains('active')`),
      hubActive: await js(win, `!!document.querySelector('#routing-hub-screen')?.classList.contains('active')`),
      hubSendEnabled: await js(win, `!document.querySelector('#routing-hub-send')?.disabled`)
    };
  } finally {
    fieldFailArmed = false;
    try { await win.webContents.debugger.sendCommand('Fetch.disable'); } catch { /* ignore */ }
    try { win.webContents.debugger.off('message', failFieldHandler); } catch { /* ignore */ }
    try { win.webContents.debugger.detach(); } catch { /* ignore */ }
  }
  log('field_fail_fast', failFast);
  check('FAIL-FAST (Goal 3): a failed /api/field refresh on the routing arrival does not render the academy map (no stale-field draw) and does not strand the loading screen',
    Boolean(failFast.reached && failFast.sentFail && !failFast.mapActive && !failFast.loadingActive), failFast);
  check('FAIL-FAST (Goal 3): the failed routing arrival un-strands to an interactive hub (loading screen is not terminal; the error is surfaced through reportLoadingError)',
    Boolean(failFast.reached && failFast.hubActive && failFast.hubSendEnabled), failFast);

  // ── 5.7) ROUTING DUNGEON DIRECT-ENTRY (this task) ─────────────────────────
  // A routing dispatch to the dungeon (destination_id=dungeon) must enter the RUN directly — hub → loading
  // screen → dungeon run board — with NO manual step on the operable pre-entry screen (academy-dungeon /
  // #dungeon-entry). Drive a real routing dungeon dispatch and measure the landing against real layout: the
  // dungeon screen is active with the streamed run board shown (#dungeon-play), the operable pre-entry
  // (#dungeon-entry + its enter button) is NOT the landing, the loading screen is not terminal, and the
  // week advanced (the dispatch progressed the week server-side before the auto-enter — the week/drain
  // contract is unchanged).
  // NEGATIVE CONTROL (documented in the task report): reverting the direct-entry so the dispatch lands on
  // the academy-dungeon pre-entry screen and stops leaves #dungeon-entry shown and #dungeon-play hidden —
  // the landing checks FAIL, so they discriminate the fix rather than passing on unfixed code.
  const dungeonReset = await newGameToHub(win, base);
  const weekBeforeDungeon = await js(win, `(async () => { const s = await fetch('/api/state').then((r) => r.json()); return Number(s?.elapsed_weeks); })()`);
  const dungeonDirect = dungeonReset && await dispatchFromHubToDungeon(win);
  await sleep(300);
  const dungeonLanding = await js(win, `(() => {
    const screen = document.querySelector('#academy-dungeon-screen');
    const play = document.querySelector('#dungeon-play');
    const entry = document.querySelector('#dungeon-entry');
    return {
      dungeonScreenActive: !!screen?.classList.contains('active'),
      playShown: !!(play && !play.hidden),
      entryShown: !!(entry && !entry.hidden),
      loadingActive: !!document.querySelector('#academy-loading-screen')?.classList.contains('active'),
      gridPresent: !!document.querySelector('#dungeon-grid')?.childElementCount
    };
  })()`);
  const weekAfterDungeon = await js(win, `(async () => { const s = await fetch('/api/state').then((r) => r.json()); return Number(s?.elapsed_weeks); })()`);
  log('dungeon_direct_entry', { dungeonReset, dungeonDirect, weekBeforeDungeon, weekAfterDungeon, ...dungeonLanding });
  check('DUNGEON DIRECT-ENTRY: a routing dungeon dispatch lands directly on the dungeon run board (hub → loading → run), not stranded on the loading screen',
    Boolean(dungeonDirect && dungeonLanding.dungeonScreenActive && dungeonLanding.playShown && dungeonLanding.gridPresent && !dungeonLanding.loadingActive), dungeonLanding);
  check('DUNGEON DIRECT-ENTRY: the operable pre-entry screen (#dungeon-entry) is not the landing — no manual enter step is shown',
    Boolean(dungeonLanding.dungeonScreenActive && !dungeonLanding.entryShown), dungeonLanding);
  check('DUNGEON DIRECT-ENTRY: the dispatch progressed the week server-side before the auto-enter (week/drain contract unchanged)',
    Boolean(Number.isFinite(weekBeforeDungeon) && Number.isFinite(weekAfterDungeon) && weekAfterDungeon > weekBeforeDungeon), { weekBeforeDungeon, weekAfterDungeon });

  // ── 6) REDUCED MOTION: emulate prefers-reduced-motion:reduce, re-render the hub, and verify the CSS
  //    animations are disabled AND the starfield runs static (single draw, no rAF loop).
  try {
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
  } catch (e) { console.log(`cdp emulate: ${e?.message ?? e}`); }
  await newGameToHub(win, base);
  const rm = await js(win, `(() => {
    const decor = document.querySelector('#routing-hub-screen .routing-hub-decor');
    const canvas = document.querySelector('#routing-hub-starfield');
    // Inject a revealed (pop-in) ルミ 吹き出し and read its resolved animation: under reduced motion the
    // fade is disabled (即時出現) while the reveal queue still spaces 吹き出し by the cooldown (間隔規律は維持).
    const stream = document.querySelector('#routing-hub-message-stream');
    const savedHtml = stream.innerHTML;
    stream.insertAdjacentHTML('beforeend', '<article class="chat-message character-message pop-in" data-rm-probe="1"><div class="message-bubble"><p>ルミ</p></div></article>');
    const popInAnimation = getComputedStyle(stream.querySelector('[data-rm-probe="1"]')).animationName;
    stream.innerHTML = savedHtml;
    return {
      prefersReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      decorAnimationName: decor ? getComputedStyle(decor).animationName : null,
      starfieldMode: canvas ? (canvas.dataset.starfield || null) : null,
      popInAnimation
    };
  })()`);
  check('REDUCED MOTION: emulated; hub decor animation disabled AND starfield runs static (no rAF loop)',
    rm.prefersReduced && rm.decorAnimationName === 'none' && rm.starfieldMode === 'static', rm);
  check('REDUCED MOTION: the routing hub 吹き出し pop-in fade is disabled (即時出現; interval discipline kept by the reveal queue)',
    rm.prefersReduced && rm.popInAnimation === 'none', { popInAnimation: rm.popInAnimation });

  console.log(`stub LM requests: ${lm.requests.length}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  if (failed.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { lm?.server?.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) { try { await fs.rm(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(exitCode);
});
