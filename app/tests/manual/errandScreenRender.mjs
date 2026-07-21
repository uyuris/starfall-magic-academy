// Render-backed errand arrival screen check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch / DOM / real layout), so the errand arrival screen
// (#academy-errand-screen — the routing "errand"/依頼 destination's landing surface) is verified here
// against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives under
// app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/errandScreenRender.mjs
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC local LM stub, does a routing new-game
// (which materializes the fixture roster + runtime state so GET /api/errand can pick real selectable-roster
// clients), and drives the REAL errand flow against real Blink layout:
//   1. ARRIVAL: ?initialScreen=academy-errand renders the dedicated #academy-errand-screen with this week's
//      three offer cards — each carrying a title / situation / reward / client name + FACE — in a horizontally
//      placed, internally scrolling board on the RIGHT, beside a 1:1 stage-image column on the LEFT
//      (/canonical/errand/stage.jpg) with the week header (第N週 / 50) overlaid (conversation-day 黒夜 chrome, no
//      ambient). This is the dev entry AND the shape a routing dispatch to errand lands on.
//   2. SELECT → CONVERSATION: click a card → the academy loading screen (#academy-loading-screen) covers the
//      POST /api/errand/start wait (no freeze / 留まる区間 on the arrival) → the client's conversation opens on the
//      DAYTIME conversation screen (#conversation-day-screen) with the client's NAME (chat bubble) and the
//      依頼主 STANDEE in the stage frame (#conversation-day-stage-image, NOT a field stage image), the opening
//      revealed in the daytime stream. Clicking the stage frame (the 依頼主 standee) opens the detail popup, which
//      shows 依頼の現場 + the errand title / situation over the new 1:1 errand stage image (errand/stage.jpg).
//   3. TURN: type + send a real turn (/api/conversation/stream) on the daytime screen; the player utterance +
//      the reply appear. The daytime turn body carries the errand conversation id (routingTurnRequestBody's
//      errand branch) — a missing id would 409 ROUTING_ERRAND_CONTEXT_MISMATCH, so a successful turn proves the
//      id was sent.
//   4. END → HUB RETURN: click 会話を終える (#conversation-day-end) → the EXISTING routing drain-on-exit end path
//      (endRoutingConversation) drains the errand finalization (reward applied server-side) and returns to the
//      hub (#routing-hub-screen), proving the errand_result on the end response does not break the existing
//      content-return path.
//
// It also covers the errand COMPLETION transitions (task errand-completion-transition-fix):
//   ACHIEVED → HUB (symptom-1 fix): an achieved errand turn (the stub reads the achieve utterance as 達成)
//     auto-ends inside the turn, reveals the 切り上げ (wrap-up) 発話 on the daytime screen, and returns to the
//     hub (#routing-hub-screen) from INSIDE the still-in-flight originating turn via the allowDuringInFlight
//     opt-in — before the fix enterRoutingHub's in-flight guard stranded it on the daytime screen. The return
//     now COVERS the non-streaming hub start with the academy loading screen (returnToRoutingHubThroughLoadingScreen,
//     allowDuringInFlight) — #academy-loading-screen activates during the return, no freeze on the daytime screen.
//   MANUAL END POST-RESPONSE FAILURE (symptom-2 fix, content-return rule): a one-shot fetch shim forces the next
//     /api/conversation/end to answer like an already-finalized skip (no finalization_status); the client's
//     post-response validation (assertDrainedRoutingFinalization) throws AFTER the loading screen shows, and the
//     extended defense line un-strands from #academy-loading-screen. Per the integrated content-return
//     end-failure rule (endRoutingConversation discriminates by the pre-clear conversation kind), an errand is a
//     CONTENT conversation, so the failed end STAYS on the daytime conversation screen (#conversation-day-screen)
//     with the cause on #conversation-day-status (tone=error) — it does NOT eject to the hub.
//
// NEGATIVE CONTROL (documented in the task report): reverting the wiring (remove the screens['academy-errand']
// registry entry / the showScreen refreshErrandScreen hook, or the #academy-errand-screen section) makes step 1
// FAIL — the arrival never renders; reverting startErrand's daytime landing back to the v1 session makes step 2
// FAIL (the daytime screen never activates and the stage frame never shows the 依頼主 standee); reverting the
// loading-covered start back to an in-place await (drop showAcademyLoadingScreenUntilReady) makes the SELECT →
// LOADING check FAIL — the arrival stays frozen and #academy-loading-screen never activates. Per ref-camera
// the harness is fire-and-forget (no top-level await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.ER_WIN_W ?? 1200);
const WIN_H = Number(process.env.ER_WIN_H ?? 820);
// Deterministic conversation text the local LM stub answers so the errand opening / turn / drain run
// end-to-end (the errand conversation is an ordinary routing-mode character conversation).
const TURN_INPUT = process.env.ER_INPUT ?? 'その依頼、引き受けます。何をすればいいですか？';
const OPENING_TEXT = 'よく来てくれました。ちょっと手を貸してほしいことがあるんです。';
const TURN_REPLY = 'ありがとう。では、さっそく取りかかりましょう。';
// The hub-dispatch leg: the player's hub turn the stub decides toward the errand destination, and the
// send-off utterance streamed before performRoutingTurnDispatch navigates to the errand arrival.
const HUB_DISPATCH_INPUT = process.env.ER_HUB_INPUT ?? '今日は誰かの手伝いに行きたい気分です。';
const SENDOFF_TEXT = 'では、依頼の現場へ向かいましょう。';
// The weekly-offer generation LM calls: GET /api/errand generates each offer's structured title / situation /
// motivation via the errand_offer_record schema AND the appeal (依頼主当人の語り) via a separate chat call.
// The stub answers both with gate-clean text. The appeal is the card's主表示; situation is the daytime scene.
const OFFER_TITLE = '依頼の相談';
const OFFER_SITUATION = '作業台に、依頼に使う道具が種類ごとに並べて置かれている。';
const OFFER_MOTIVATION = '手を貸してほしいことがあり、会話の相手を探している。';
const OFFER_APPEAL = 'ねえ、少しだけいいかな。手を貸してほしいことがあって、あなたとなら落ち着いて話せそうだから声をかけたんだ。お願い、力を貸して。';
// The achieved leg (symptom-1): a distinct player utterance the stub's errand achievement judgment reads as
// 「達成」so the errand auto-ends inside the turn, plus the 切り上げ (wrap-up) reply the stub returns for the
// errand_wrap_up_reply turn — asserted as the 切り上げ発話 rendered on the daytime screen before the in-flight
// hub return. Neither text is a substring of the other conversation texts, so the stub gates cleanly on it.
const ACHIEVE_INPUT = process.env.ER_ACHIEVE_INPUT ?? '頼まれたことをやり切りました。もう達成です。';
const ACHIEVE_WRAP_UP = 'こちらこそ、本当に助かりました。今日はここまでにしましょう。';
// The prompt marker of the post-turn finalization drain calls (会話終了後の処理 / キャラクターの継続記録) that run
// inside finalizeTurnResult — i.e. AFTER the server has already emitted achievement_draining. Holding the first
// such call of the achieved turn's completion drain pushes the server's `result` event past the client's
// 達成読みポーズ, exercising the pause-first ordering (Order B). It must target a call that runs AFTER
// achievement_draining: the in-turn work-record recall runs BEFORE it, so we discriminate on this
// finalization-drain marker (mirrors the routing hub render harness's FINALIZATION_DRAIN_PROMPT_MARKER).
const FINALIZATION_DRAIN_PROMPT_MARKER = '次の会話セッションだけを根拠に';

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

// Deterministic routing character-conversation LM stub: answers the emotion / work-record / continuation LM
// calls of the ordinary conversation pipeline, returns the turn reply when the transcript carries the player's
// input, and otherwise a generic line (the errand opening, the drain's freeform reflection, and the hub
// re-opening welcome all fall here). This drives the errand opening / turn / drain and the hub re-open with no
// real LM Studio — the same shape the routing dispatch render harness uses.
async function startStubLm() {
  const requests = [];
  // Injectable backend completion-drain delay. The test sets control.finalizationDelayMs before the achieved turn;
  // the stub then holds the first post-achievement_draining finalization round-trip of that turn's completion drain
  // (one-shot, armed on the errand wrap-up reply), pushing `result` past the client's 達成読みポーズ (Order B). Zero
  // (the default) leaves the drain fast (Order A: the result arrives within the pause).
  const control = { finalizationDelayMs: 0, pendingDrainDelayMs: 0 };
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* opening probe */ }
    requests.push({ url: req.url });
    const prompt = body.messages?.[0]?.content ?? '';
    const schemaName = body.response_format?.json_schema?.name ?? '';
    // Order matters: the judgment prompts (stage-move agreement / destination / continuation) also embed the
    // player input in their transcript, so they must be matched before the reply's `includes(TURN_INPUT)`.
    let content;
    if (schemaName === 'character_emotion_choice') content = JSON.stringify({ expression: 'joy' });
    else if (schemaName === 'work_record_recall_choice') content = JSON.stringify({ work_record_ids: [] });
    else if (schemaName === 'errand_offer_record') content = JSON.stringify({ title: OFFER_TITLE, situation: OFFER_SITUATION, motivation: OFFER_MOTIVATION });
    else if (prompt.includes('この依頼を自分の口から持ちかける')) content = OFFER_APPEAL; // errand appeal (当人の語り) chat call
    else if (prompt.includes('この研究会を自分の口から持ちかける')) content = OFFER_APPEAL; // study circle appeal (shared stub shape)
    else if (prompt.includes('場所移動の合意')) content = 'false'; // stage-move agreement (disabled for errand) → no move
    else if (prompt.includes('location_idを1つだけ返す')) content = 'none'; // stage-move destination selection → none
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) content = 'errand'; // hub destination judgment → errand
    else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) content = SENDOFF_TEXT; // hub send-off utterance
    else if (prompt.includes('依頼のやり取りを締めくくる')) content = ACHIEVE_WRAP_UP; // errand wrap-up (切り上げ) reply on an achieved turn
    else if (prompt.includes('達成条件が、ここまでの会話で満たされたか')) content = prompt.includes(ACHIEVE_INPUT) ? 'true' : 'false'; // errand achievement judgment → true only for the achieve utterance
    else if (prompt.includes('継続したいと思うか')) content = 'true'; // continuation judgment → keep going (end via button)
    else if (prompt.includes('好感度の変化量を判定する')) content = '0'; // affinity delta judgment → neutral (contract: integer -10..10)
    else if (prompt.includes('MP温存ライン')) content = '30'; // mp reserve line judgment → neutral (contract: integer 0..100)
    else if (prompt.includes(TURN_INPUT)) content = TURN_REPLY; // the reply (transcript carries the player input)
    else content = OPENING_TEXT; // errand opening / hub opening & re-opening / drain reflection
    // Hold the first finalization drain round-trip of the current achieved turn's completion (armed on the wrap-up).
    if (control.pendingDrainDelayMs > 0 && prompt.includes(FINALIZATION_DRAIN_PROMPT_MARKER)) {
      const held = control.pendingDrainDelayMs;
      control.pendingDrainDelayMs = 0;
      await sleep(held);
    }
    // Arm the delay for this achieved turn's completion drain once its wrap-up (切り上げ) reply has been generated
    // (the wrap-up is emitted right before achievement_draining, so the next finalization call is the completion drain).
    if (prompt.includes('依頼のやり取りを締めくくる')) control.pendingDrainDelayMs = control.finalizationDelayMs;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, control, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// Routing-mode fixture. The runtime-paths manifest points the definitions/seeds/mutable roots at the fixture's
// game_data (so new-game materializes the roster + state there) and resourceRoot at the fixture root — where
// the errand type catalog is read from (loadErrandTypeCatalog reads <resourceRoot>/data/definitions/errand_types.json,
// resolved through the nearest manifest for the play-area activeRoot too). errand_types.json is copied there.
async function routingFixture() {
  const root = await fixtureRoot('errand-screen-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'errand-screen-render-settings-'));
  const settingsPath = path.join(settingsDir, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return { root, settingsDir, settingsPath };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let server;
let lm;
let cleanupPaths = [];
let exitCode = 0;

async function waitFor(win, predicate, { tries = 300, intervalMs = 120 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${predicate}); } catch (e) { return false; } })()`);
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

const js = (win, expr) => win.webContents.executeJavaScript(expr);

// Routing new-game materializes runtime state + the fixture roster, then reload the errand dev screen: boot's
// refresh() adopts that state (currentPlayMode=routing from GET /api/slots), and ?initialScreen=academy-errand
// shows the arrival, whose showScreen hook fetches GET /api/errand and renders the three offer cards.
async function newGameThenErrand(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
  await win.loadURL(`${base}/?initialScreen=academy-errand`);
  return waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 3
  `, { tries: 400, intervalMs: 120 });
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
    // timeout_ms must exceed the injected finalization-drain delay (the delayed leg holds one completion-drain LM
    // round-trip past the ~5s 達成読みポーズ to force Order B), so the held call does not time out into an LM error.
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 30000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // ── 1) ARRIVAL: the errand board renders three offer cards ────────────────────
  const onErrand = await newGameThenErrand(win, base);
  const arrival = await js(win, `(() => {
    const active = document.querySelector('.screen.active');
    const cards = [...document.querySelectorAll('#academy-errand-offers .academy-errand-card')];
    const readCard = (card) => {
      const face = card.querySelector('.academy-errand-card-face');
      return {
        errandId: card.querySelector('.academy-errand-card-button')?.dataset.errandId || '',
        clientName: (card.querySelector('.academy-errand-card-client-name')?.textContent || '').trim(),
        title: (card.querySelector('.academy-errand-card-title')?.textContent || '').trim(),
        // The card body element (the -situation class is the shared body-text styling hook) now carries the appeal.
        appeal: (card.querySelector('.academy-errand-card-situation')?.textContent || '').trim(),
        // The reward is now a labeled footer (報酬 label + money chip); read the whole footer so the 報酬 marker is present.
        reward: (card.querySelector('.academy-errand-card-footer')?.textContent || '').trim(),
        // 達成条件 is the internal judgment value only — the card must render NO condition element (never shown).
        hasCondition: !!card.querySelector('.academy-errand-card-condition'),
        faceSrc: face?.getAttribute('src') || '',
        faceVisible: face ? getComputedStyle(face).visibility !== 'hidden' : false
      };
    };
    return {
      activeScreenId: active ? active.id : null,
      routingActive: !!document.querySelector('#routing-hub-screen.active'),
      sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
      hasTab: !!document.querySelector('[data-screen="academy-errand"]'),
      weekText: (document.querySelector('#academy-errand-week')?.textContent || '').trim(),
      stageBg: (() => { const b = document.querySelector('.academy-errand-stage-image'); return b ? getComputedStyle(b).backgroundImage : ''; })(),
      // Direct-background (いきなり背景) standard: the layout has padding:0 so the flat obsidian screen fills it
      // edge-to-edge with no navy-gradient border inset.
      layoutPadding: (() => { const l = document.querySelector('.layout'); return l ? getComputedStyle(l).padding : ''; })(),
      cards: cards.map(readCard)
    };
  })()`);
  log('arrival', arrival);
  check('ARRIVAL lands on the dedicated #academy-errand-screen (not routing hub / session), no tab',
    onErrand && arrival.activeScreenId === 'academy-errand-screen' && !arrival.routingActive && !arrival.sessionActive && !arrival.hasTab,
    { activeScreenId: arrival.activeScreenId, hasTab: arrival.hasTab });
  check('ARRIVAL renders exactly three offer cards with the week header 第N週 / 50',
    arrival.cards.length === 3 && /^第\d+週 \/ 50$/.test(arrival.weekText), { weekText: arrival.weekText, cardCount: arrival.cards.length });
  const everyCardComplete = arrival.cards.every((c) => c.errandId && c.clientName && c.title && c.appeal && c.reward.includes('報酬') && c.faceSrc && c.faceVisible);
  check('ARRIVAL each card carries title / appeal (当人の語り) / reward / client name + a visible client face',
    everyCardComplete, { cards: arrival.cards.map((c) => ({ id: c.errandId, client: c.clientName, hasTitle: !!c.title, hasAppeal: !!c.appeal, reward: c.reward, face: c.faceVisible })) });
  check('ARRIVAL the three errand ids and the three clients are unique (deterministic offer set)',
    new Set(arrival.cards.map((c) => c.errandId)).size === 3 && new Set(arrival.cards.map((c) => c.clientName)).size === 3,
    { ids: arrival.cards.map((c) => c.errandId), clients: arrival.cards.map((c) => c.clientName) });
  // STAGE COLUMN: the conversation-day 黒夜 chrome frames the new 1:1 errand stage image (the screen's face) in
  // the left column — a real background-image on .academy-errand-stage-image (/canonical/errand/stage.jpg).
  check('ARRIVAL the 1:1 stage-image column paints the new errand stage image (a real background-image, not none)',
    arrival.stageBg && arrival.stageBg !== 'none' && arrival.stageBg.includes('/canonical/errand/stage.jpg'),
    { stageBg: arrival.stageBg.slice(0, 90) });
  // CONDITION REMOVAL: 達成条件 is the internal judgment value only — no card renders a condition element.
  check('ARRIVAL no offer card renders a 達成条件 element (condition is internal only, never shown to the player)',
    arrival.cards.length > 0 && arrival.cards.every((c) => c.hasCondition === false),
    { hasCondition: arrival.cards.map((c) => c.hasCondition) });
  // BACKGROUND RESTYLE (いきなり背景): the errand layout is edge-to-edge (padding:0) so the flat obsidian screen
  // fills it with no navy-gradient border inset — the conversation-day 黒夜 chrome standard.
  check('ARRIVAL the errand layout is edge-to-edge (layout padding:0) — no navy-gradient border inset behind the obsidian screen',
    arrival.layoutPadding === '0px', { layoutPadding: arrival.layoutPadding });

  const shotPath = path.join(os.tmpdir(), 'errand-arrival-render.png');
  try { await sleep(500); await fs.writeFile(shotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${shotPath}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // ── 1b) OFFER-FETCH RETRY: a failed weekly-offer fetch clears the board and surfaces the error banner + the
  // explicit retry button; clicking retry re-runs refreshErrandScreen and recovers the board. The arrival has no
  // back / skip (会話終了 is the only hub return, arrival = the week is spent), so the retry button is the only
  // in-place recovery from a failed generation. Force GET /api/errand to fail, invoke the refresh through the
  // retry button (it is the refresh trigger), assert the empty-board error state, then restore the fetch and
  // click retry again to recover the three cards. Leaves a clean arrival for the SELECT leg below. ──
  await js(win, `(() => {
    const orig = window.fetch;
    window.__origFetch = orig;
    window.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      if (u.includes('/api/errand') && !u.includes('/api/errand/start')) {
        return Promise.resolve(new Response('{"error":"forced offer-fetch failure"}', { status: 500, headers: { 'content-type': 'application/json' } }));
      }
      return orig(input, init);
    };
    return true;
  })()`);
  await js(win, `document.querySelector('#academy-errand-retry')?.click()`);
  const retryFailState = await waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 0
    && document.querySelector('#academy-errand-retry')?.hidden === false
    && (() => { const s = document.querySelector('#academy-errand-status'); return !!s && s.hidden === false && (s.textContent || '').trim().length > 0; })()
  `, { tries: 300, intervalMs: 60 });
  const retryFail = await js(win, `(() => {
    const s = document.querySelector('#academy-errand-status');
    const r = document.querySelector('#academy-errand-retry');
    return {
      cards: document.querySelectorAll('#academy-errand-offers .academy-errand-card').length,
      retryVisible: !!r && r.hidden === false,
      statusShown: !!s && s.hidden === false && (s.textContent || '').trim().length > 0,
      statusTone: s?.dataset.tone ?? ''
    };
  })()`);
  log('retry_fail', { retryFailState, ...retryFail });
  check('RETRY: a failed weekly-offer fetch clears the board and surfaces the error banner + the explicit retry button (the arrival has no back / skip)',
    retryFailState && retryFail.cards === 0 && retryFail.retryVisible && retryFail.statusShown && retryFail.statusTone === 'error',
    { cards: retryFail.cards, retryVisible: retryFail.retryVisible, statusShown: retryFail.statusShown, statusTone: retryFail.statusTone });
  const retryShotPath = path.join(os.tmpdir(), 'errand-arrival-retry.png');
  try { await sleep(300); await fs.writeFile(retryShotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${retryShotPath}`); } catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }
  await js(win, `(() => { if (window.__origFetch) { window.fetch = window.__origFetch; delete window.__origFetch; } return true; })()`);
  await js(win, `document.querySelector('#academy-errand-retry')?.click()`);
  const retryRecovered = await waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 3
    && document.querySelector('#academy-errand-retry')?.hidden === true
    && document.querySelector('#academy-errand-status')?.hidden === true
  `, { tries: 400, intervalMs: 120 });
  const retryRecover = await js(win, `(() => ({
    cards: document.querySelectorAll('#academy-errand-offers .academy-errand-card').length,
    retryHidden: document.querySelector('#academy-errand-retry')?.hidden === true,
    statusHidden: document.querySelector('#academy-errand-status')?.hidden === true
  }))()`);
  log('retry_recover', { retryRecovered, ...retryRecover });
  check('RETRY: clicking the retry button re-runs refreshErrandScreen and recovers the board (three cards back, retry hidden, status cleared)',
    retryRecovered && retryRecover.cards === 3 && retryRecover.retryHidden && retryRecover.statusHidden,
    { cards: retryRecover.cards, retryHidden: retryRecover.retryHidden, statusHidden: retryRecover.statusHidden });

  // ── 2) SELECT → CONVERSATION: a card starts the client's conversation on the DAYTIME screen ──
  const chosenClient = arrival.cards[0]?.clientName ?? '';
  const chosenTitle = arrival.cards[0]?.title ?? '';
  // The daytime stage popup shows the pure scene (situation), NOT the card's appeal body — compare against
  // the stub's situation (the offer's situation flows start-response → activeErrandScene → popup).
  const chosenSituation = OFFER_SITUATION;
  const clicked = await js(win, `(() => {
    const btn = document.querySelector('#academy-errand-offers .academy-errand-card .academy-errand-card-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  // The freeze fix: selecting an offer shows the academy loading screen WHILE the (session + opening) start POST
  // runs, so the player never sits frozen on the arrival. showScreen('academy-loading') is synchronous at the
  // start of showAcademyLoadingScreenUntilReady — ahead of the async start POST resolving — so the loading
  // interstitial replaces the arrival in the same click, and it holds for at least ACADEMY_LOADING_MINIMUM_MS,
  // making it reliably observable here before the daytime screen lands.
  const loadingCovered = clicked && await waitFor(win, `
    document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 400, intervalMs: 15 });
  check('SELECT → LOADING: selecting an offer shows the academy loading screen while the errand start runs (no freeze / 留まる区間 on the arrival)',
    loadingCovered, { loadingCovered });
  const onDay = clicked && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
  `, { tries: 400, intervalMs: 120 });
  const day = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const frame = document.querySelector('#conversation-day-stage-image');
    const faceImg = stream?.querySelector('.message-face img');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      errandActive: !!document.querySelector('#academy-errand-screen.active'),
      routingActive: !!document.querySelector('#routing-hub-screen.active'),
      sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
      speakerName: (stream?.querySelector('.message-speaker')?.textContent || '').trim(),
      frameBg: frame ? getComputedStyle(frame).backgroundImage : '',
      frameLabel: frame?.getAttribute('aria-label') || '',
      messageCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      streamText: (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim(),
      faceSrc: faceImg ? (faceImg.getAttribute('src') || '') : ''
    };
  })()`);
  log('day', { chosenClient, ...day });
  check('SELECT lands the errand conversation on the daytime screen (not session / hub / arrival) with the client bound as speaker',
    onDay && day.activeScreenId === 'conversation-day-screen' && !day.errandActive && !day.routingActive && !day.sessionActive
    && day.speakerName.length > 0 && day.speakerName === chosenClient && day.speakerName !== '選択中のキャラ',
    { activeScreenId: day.activeScreenId, speakerName: day.speakerName, chosenClient });
  check('SELECT paints the 依頼主 standee in the daytime stage frame (依頼の現場, independent of the field stage — a real background-image, not none)',
    day.frameBg && day.frameBg !== 'none' && day.frameBg.includes('url(') && day.frameLabel.includes('依頼の現場'),
    { frameBg: day.frameBg.slice(0, 80), frameLabel: day.frameLabel });
  check('SELECT reveals the errand opening in the daytime stream with the client face (POST /api/errand/start, one call)',
    day.messageCount > 0 && day.faceSrc.length > 0 && day.streamText.includes('手を貸してほしい'),
    { messageCount: day.messageCount, faceSrc: day.faceSrc, hasOpening: day.streamText.includes('手を貸してほしい') });

  // ── 2b) STAGE DETAIL POPUP: clicking the stage frame (the 依頼主 standee) shows 依頼の現場 + the errand title /
  // situation over the new 1:1 errand stage image (errand/stage.jpg, data-scene="errand" → square, viewport-fit). ──
  const popup = await js(win, `(() => {
    const frame = document.querySelector('#conversation-day-stage-image');
    if (frame) frame.click();
    const el = document.querySelector('#conversation-day-stage-popup');
    const title = (document.querySelector('#conversation-day-stage-popup-title')?.textContent || '').trim();
    const text = (document.querySelector('#conversation-day-stage-popup-text')?.textContent || '').trim();
    const popupImage = document.querySelector('#conversation-day-stage-popup-image');
    const result = {
      visible: el ? el.hidden === false : false,
      scene: el ? (el.dataset.scene || '') : '',
      title,
      text,
      popupBg: popupImage ? getComputedStyle(popupImage).backgroundImage : '',
      popupAspect: popupImage ? (getComputedStyle(popupImage).aspectRatio || '').replace(/\\s+/g, '') : ''
    };
    // Close it so the modal does not block the turn controls below.
    document.querySelector('#conversation-day-stage-popup [data-day-popup-close]')?.click();
    return result;
  })()`);
  log('stage_popup', popup);
  check('STAGE POPUP: the stage-frame click opens the detail popup showing 依頼の現場 + the errand title / situation over the new 1:1 errand stage image (square, viewport-fit)',
    popup.visible && popup.title === '依頼の現場' && popup.scene === 'errand'
    && (chosenTitle ? popup.text.includes(chosenTitle) : true) && (chosenSituation ? popup.text.includes(chosenSituation) : true)
    && popup.popupBg && popup.popupBg.includes('/canonical/errand/stage.jpg') && popup.popupAspect === '1/1',
    { title: popup.title, scene: popup.scene, popupAspect: popup.popupAspect, popupBg: popup.popupBg.slice(0, 80) });
  check('STAGE POPUP: the detail popup shows NO 達成条件 (the condition is internal only, never shown to the player)',
    popup.visible && !popup.text.includes('達成条件'), { text: popup.text.slice(0, 80) });

  // ── 3) TURN over the character conversation API (/api/conversation/stream) on the daytime screen ──
  // A successful turn proves the errand id was carried in the turn body — a missing id 409s the errand turn.
  const beforeTurn = await js(win, `document.querySelectorAll('#conversation-day-message-stream .chat-message').length`);
  const fired = await js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
    const send = document.querySelector('#conversation-day-send');
    if (!input || !send || send.disabled) return false;
    input.value = ${JSON.stringify(TURN_INPUT)};
    send.click();
    return true;
  })()`);
  const sent = fired && await waitFor(win, `document.querySelector('#conversation-day-input').value === ''`, { tries: 80, intervalMs: 50 });
  const settled = sent && await waitFor(win, `
    !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length >= ${beforeTurn} + 2
  `, { tries: 500, intervalMs: 120 });
  await sleep(300);
  const turn = await js(win, `(() => {
    const stream = document.querySelector('#conversation-day-message-stream');
    const text = (stream ? stream.textContent : '').replace(/\\s+/g, ' ').trim();
    return {
      rowCount: stream ? stream.querySelectorAll('.chat-message').length : 0,
      hasPlayerInput: text.includes(${JSON.stringify(TURN_INPUT)}),
      hasReply: text.includes('さっそく取りかかり'),
      stillDay: !!document.querySelector('#conversation-day-screen.active')
    };
  })()`);
  log('turn', { beforeTurn, fired, sent, settled, ...turn });
  check('TURN: a daytime errand turn flows end-to-end (player utterance + reply appended, stays on the daytime screen) — proves the errand id rode the turn body',
    sent && settled && turn.rowCount >= beforeTurn + 2 && turn.hasPlayerInput && turn.hasReply && turn.stillDay,
    { beforeTurn, rowCount: turn.rowCount, hasPlayerInput: turn.hasPlayerInput, hasReply: turn.hasReply });

  // ── 4) END → HUB RETURN via the EXISTING routing drain-on-exit end path (the daytime end button, errand branch) ──
  const moneyBefore = await js(win, `fetch('/api/state').then((r) => r.json()).then((s) => s?.money ?? null).catch(() => null)`);
  const ended = await js(win, `(() => {
    const end = document.querySelector('#conversation-day-end');
    if (!end) return false;
    end.click();
    return true;
  })()`);
  const onHub = ended && await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 600, intervalMs: 120 });
  await sleep(400);
  const hub = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    dayActive: !!document.querySelector('#conversation-day-screen.active'),
    errandActive: !!document.querySelector('#academy-errand-screen.active'),
    hubOpeningLen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length
  }))()`);
  log('end', { ended, moneyBefore, ...hub });
  check('END → HUB: the daytime end button (errand branch → endRoutingConversation) returns to the hub (#routing-hub-screen) with errand_result on the response — not stranded on the daytime screen / arrival',
    onHub && hub.activeScreenId === 'routing-hub-screen' && !hub.dayActive && !hub.errandActive && hub.hubOpeningLen > 0,
    { activeScreenId: hub.activeScreenId, hubOpeningLen: hub.hubOpeningLen });

  // ── 5) REAL DISPATCH: a hub turn the stub decides toward errand lands on the arrival via performRoutingTurnDispatch ──
  // Closes the arrival's other accepted entry (the in-turn routing dispatch, not just the dev entry): from the
  // hub, a decided turn carries routing_dispatch(errand) → the SSE seam consumes it in-turn → the loading
  // interstitial navigates to #academy-errand-screen and its showScreen hook renders this (next) week's offers.
  let dispatchFired = false;
  if (onHub) {
    await waitFor(win, `!document.querySelector('#routing-hub-send')?.disabled && !!document.querySelector('#routing-hub-input')`, { tries: 200, intervalMs: 120 });
    for (let attempt = 0; attempt < 6 && !dispatchFired; attempt += 1) {
      await js(win, `(() => {
        const input = document.querySelector('#routing-hub-input');
        const send = document.querySelector('#routing-hub-send');
        if (!input || !send || send.disabled) return false;
        input.value = ${JSON.stringify(HUB_DISPATCH_INPUT)};
        send.click();
        return true;
      })()`);
      // The real send synchronously clears the input; a still-populated input is the in-flight silent no-op.
      dispatchFired = await waitFor(win, `document.querySelector('#routing-hub-input').value === ''`, { tries: 40, intervalMs: 80 });
    }
  }
  // The decided turn reveals the send-off, holds the reading pause (~5s), then dispatches to the arrival.
  const dispatched = dispatchFired && await waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 3
  `, { tries: 600, intervalMs: 150 });
  await sleep(300);
  const dispatch = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    cardCount: document.querySelectorAll('#academy-errand-offers .academy-errand-card').length,
    weekText: (document.querySelector('#academy-errand-week')?.textContent || '').trim(),
    sendoffSeen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(SENDOFF_TEXT)})
  }))()`);
  log('dispatch', { dispatchFired, dispatched, ...dispatch });
  check('DISPATCH: a decided routing hub turn (errand) lands on #academy-errand-screen via performRoutingTurnDispatch with the three offer cards rendered',
    dispatched && dispatch.activeScreenId === 'academy-errand-screen' && dispatch.cardCount === 3 && /^第\d+週 \/ 50$/.test(dispatch.weekText),
    { activeScreenId: dispatch.activeScreenId, cardCount: dispatch.cardCount, weekText: dispatch.weekText, sendoffSeen: dispatch.sendoffSeen });

  // ── 6) ACHIEVED AUTO-END → HUB RETURN (symptom-1 fix) ─────────────────────────────────────────────────
  // Start a fresh errand and send the achievement utterance: the turn auto-ends server-side (drain-on-exit),
  // reveals the 切り上げ (wrap-up) 発話 on the daytime screen, then completeErrandFromTurnResult takes the hub
  // re-open (navigateToPostContentScreen('interaction')) from INSIDE the still-in-flight turn. Before the fix
  // enterRoutingHub's in-flight guard early-returned and stranded the player on the daytime screen; the
  // allowDuringInFlight opt-in now lets the return complete. Reload to a clean arrival (no active errand).
  await win.loadURL(`${base}/?initialScreen=academy-errand`);
  const onErrandAchieve = await waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 3
  `, { tries: 400, intervalMs: 120 });
  const achieveStarted = onErrandAchieve && await js(win, `(() => {
    const btn = document.querySelector('#academy-errand-offers .academy-errand-card .academy-errand-card-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const onAchieveDay = achieveStarted && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
  `, { tries: 400, intervalMs: 120 });
  const achieveFired = onAchieveDay && await js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
    const send = document.querySelector('#conversation-day-send');
    if (!input || !send || send.disabled) return false;
    input.value = ${JSON.stringify(ACHIEVE_INPUT)};
    send.click();
    return true;
  })()`);
  // Fast-drain (Order A) achieved return: the completion drain is fast (no injected delay), so the `result` arrives
  // within the ~5s 達成読みポーズ — the daytime screen stays visible for the read (no achievement drain loading
  // screen), then completeErrandFromTurnResult → returnToRoutingHubThroughLoadingScreen COVERS the non-streaming
  // hub start with the academy loading screen (allowDuringInFlight) before the hub lands. That hub-return loading
  // holds for ACADEMY_LOADING_MINIMUM_MS, so catch it here. (The pause-first ordering with the ACHIEVEMENT drain
  // loading screen is exercised by the delayed leg below.)
  const achieveLoadingCovered = achieveFired && await waitFor(win, `
    document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 800, intervalMs: 60 });
  // The achieved turn reveals the main reply + the 切り上げ (wrap-up) 発話, holds it for the ~5s 達成読みポーズ (run
  // concurrently with the fast completion drain), then returns to the hub through the loading screen. The daytime
  // stream DOM keeps the wrap-up (only the next errand entry clears it), so it is still readable after the hub
  // return as proof it rendered on the daytime screen.
  const onAchieveHub = achieveFired && await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 800, intervalMs: 120 });
  await sleep(400);
  const achieved = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    dayActive: !!document.querySelector('#conversation-day-screen.active'),
    errandActive: !!document.querySelector('#academy-errand-screen.active'),
    loadingActive: !!document.querySelector('#academy-loading-screen.active'),
    hubOpeningLen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length,
    wrapUpSeen: (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes('今日はここまでにしましょう')
  }))()`);
  log('achieved', { onErrandAchieve, achieveStarted, onAchieveDay, achieveFired, achieveLoadingCovered, onAchieveHub, ...achieved });
  check('ACHIEVED: the achieved errand turn revealed the 切り上げ (wrap-up) 発話 on the daytime screen before the transition',
    achieved.wrapUpSeen, { wrapUpSeen: achieved.wrapUpSeen });
  check('ACHIEVED → LOADING (loading coverage): the achieved hub return covers the non-streaming hub start with the academy loading screen (returnToRoutingHubThroughLoadingScreen — no freeze on the daytime screen during the return)',
    achieveLoadingCovered, { achieveLoadingCovered });
  check('ACHIEVED → HUB (symptom-1 fix): the achieved auto-end returns to #routing-hub-screen with a re-opening (hubOpeningLen>0) from inside the still-in-flight turn — not stranded on the daytime / loading screen',
    onAchieveHub && achieved.activeScreenId === 'routing-hub-screen' && !achieved.dayActive && !achieved.errandActive && !achieved.loadingActive && achieved.hubOpeningLen > 0,
    { activeScreenId: achieved.activeScreenId, hubOpeningLen: achieved.hubOpeningLen, dayActive: achieved.dayActive, loadingActive: achieved.loadingActive });

  // ── 6b) DELAYED COMPLETION DRAIN → PAUSE-FIRST ACHIEVEMENT LOADING (task delayed leg) ──────────────────
  // Force the backend completion drain to OUTLAST the ~5s 達成読みポーズ (arm a one-shot 9s hold on the first
  // finalization drain round-trip of the achieved turn). Order B then plays out and is measured against real Blink
  // timing: the 切り上げ (wrap-up) 発話 reveals on the daytime screen → the 達成読みポーズ elapses first → it raises
  // the ACHIEVEMENT drain loading screen (the 依頼の後処理 copy, distinct from the hub-entry copy) → the delayed
  // `result` finally arrives → the hub return continues from that already-raised loading screen (continuous
  // loading, no flash back to the daytime screen). This proves the concurrent pause + drain coverage — the very
  // non-covered wait the task removes — not just the fast-result path of step 6.
  lm.control.finalizationDelayMs = 9000;
  await win.loadURL(`${base}/?initialScreen=academy-errand`);
  const onErrandSlow = await waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 3
  `, { tries: 400, intervalMs: 120 });
  const slowStarted = onErrandSlow && await js(win, `(() => {
    const btn = document.querySelector('#academy-errand-offers .academy-errand-card .academy-errand-card-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const onSlowDay = slowStarted && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
  `, { tries: 400, intervalMs: 120 });
  const slowFired = onSlowDay && await js(win, `(() => {
    const input = document.querySelector('#conversation-day-input');
    const send = document.querySelector('#conversation-day-send');
    if (!input || !send || send.disabled) return false;
    input.value = ${JSON.stringify(ACHIEVE_INPUT)};
    send.click();
    return true;
  })()`);
  // Order B evidence: the ACHIEVEMENT drain loading screen (the 依頼の後処理 post-processing copy) must appear —
  // the 達成読みポーズ raised it because the completion drain (9s) outlasted the ~5s read. Its title distinguishes it
  // from the hub-entry loading copy that returnToRoutingHubThroughLoadingScreen swaps in once the result arrives.
  const achievementDrainLoadingSeen = slowFired && await waitFor(win, `
    document.querySelector('#academy-loading-screen')?.classList.contains('active')
    && (document.querySelector('#academy-loading-title')?.textContent || '').trim() === '依頼の後処理をしています'
  `, { tries: 500, intervalMs: 30 });
  // The delayed result then arrives and the hub return continues from the already-raised loading screen.
  const onSlowHub = slowFired && await waitFor(win, `
    document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length > 0
  `, { tries: 1200, intervalMs: 120 });
  await sleep(400);
  const slow = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    dayActive: !!document.querySelector('#conversation-day-screen.active'),
    errandActive: !!document.querySelector('#academy-errand-screen.active'),
    loadingActive: !!document.querySelector('#academy-loading-screen.active'),
    hubOpeningLen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length,
    wrapUpSeen: (document.querySelector('#conversation-day-message-stream')?.textContent || '').includes('今日はここまでにしましょう')
  }))()`);
  lm.control.finalizationDelayMs = 0; // disarm so the next leg's drain is fast again
  log('slow', { onErrandSlow, slowStarted, onSlowDay, slowFired, achievementDrainLoadingSeen, onSlowHub, ...slow });
  check('DELAYED (Order B): the 切り上げ (wrap-up) 発話 revealed on the daytime screen before the transition',
    slow.wrapUpSeen, { wrapUpSeen: slow.wrapUpSeen });
  check('DELAYED (Order B): when the completion drain OUTLASTS the ~5s 達成読みポーズ, the pause raises the ACHIEVEMENT drain loading screen (依頼の後処理 copy) before the result — the previously non-covered wait is now covered',
    achievementDrainLoadingSeen, { achievementDrainLoadingSeen });
  check('DELAYED (Order B): after the delayed result the hub return continues from the loading screen to #routing-hub-screen (daytime / loading no longer active)',
    onSlowHub && slow.activeScreenId === 'routing-hub-screen' && !slow.dayActive && !slow.errandActive && !slow.loadingActive && slow.hubOpeningLen > 0,
    { activeScreenId: slow.activeScreenId, hubOpeningLen: slow.hubOpeningLen, loadingActive: slow.loadingActive });

  // ── 7) MANUAL END POST-RESPONSE VALIDATION FAILURE (symptom-2 fix, content-return rule) ────────────────
  // The symptom-1 fix removes the natural stranded state that produced symptom 2, so exercise the client's
  // post-response defense directly: start a fresh errand, force the NEXT /api/conversation/end to answer like
  // an already-finalized skip (no finalization_status) with a one-shot fetch shim, then click 会話を終える. The
  // client's assertDrainedRoutingFinalization throws AFTER the loading screen shows; the extended defense line
  // must un-strand from #academy-loading-screen. Per the integrated content-return end-failure rule
  // (endRoutingConversation discriminates by the pre-clear conversation kind), an ERRAND is a CONTENT
  // conversation, so the failed end STAYS on the daytime conversation screen (#conversation-day-screen) with the
  // cause on that screen's status line (#conversation-day-status, tone=error) — it must NOT eject to the hub (that
  // would surface the pre-content hub history as if it were live). This leaves the errand active server-side (the
  // real end never runs), so it is the last leg.
  await win.loadURL(`${base}/?initialScreen=academy-errand`);
  const onErrandS2 = await waitFor(win, `
    document.querySelector('#academy-errand-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-errand-offers .academy-errand-card').length === 3
  `, { tries: 400, intervalMs: 120 });
  const s2Started = onErrandS2 && await js(win, `(() => {
    const btn = document.querySelector('#academy-errand-offers .academy-errand-card .academy-errand-card-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const onS2Day = s2Started && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#conversation-day-send')?.disabled
    && document.querySelectorAll('#conversation-day-message-stream .chat-message').length > 0
  `, { tries: 400, intervalMs: 120 });
  // One-shot fetch shim: only the manual end response is forced to an already-finalized skip shape.
  const shimInstalled = onS2Day && await js(win, `(() => {
    const orig = window.fetch;
    window.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      if (u.includes('/api/conversation/end')) {
        window.fetch = orig;
        return Promise.resolve(new Response('{"reason":"already_finalized","state":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return orig(input, init);
    };
    return typeof window.fetch === 'function';
  })()`);
  const s2EndFired = shimInstalled && await js(win, `(() => {
    const end = document.querySelector('#conversation-day-end');
    if (!end) return false;
    end.click();
    return true;
  })()`);
  // The content-return failure STAYS on the daytime screen with the cause on #conversation-day-status, and never
  // strands on the loading screen or ejects to the hub (the integrated content-return end-failure rule).
  const s2Recovered = s2EndFired && await waitFor(win, `
    document.querySelector('#conversation-day-screen')?.classList.contains('active')
    && !document.querySelector('#academy-loading-screen')?.classList.contains('active')
    && !document.querySelector('#routing-hub-screen')?.classList.contains('active')
    && (() => { const s = document.querySelector('#conversation-day-status'); return !!s && s.hidden === false && (s.textContent || '').trim().length > 0; })()
  `, { tries: 400, intervalMs: 120 });
  await sleep(300);
  const symptom2 = await js(win, `(() => {
    const s = document.querySelector('#conversation-day-status');
    return {
      activeScreenId: document.querySelector('.screen.active')?.id ?? null,
      loadingActive: !!document.querySelector('#academy-loading-screen.active'),
      dayActive: !!document.querySelector('#conversation-day-screen.active'),
      hubActive: !!document.querySelector('#routing-hub-screen.active'),
      statusShown: !!s && s.hidden === false && (s.textContent || '').trim().length > 0,
      statusTone: s?.dataset.tone ?? ''
    };
  })()`);
  log('symptom2', { onErrandS2, s2Started, onS2Day, shimInstalled, s2EndFired, s2Recovered, ...symptom2 });
  check('SYMPTOM-2 (content-return rule): a manual errand end whose post-response validation throws STAYS on #conversation-day-screen with the cause on #conversation-day-status (tone=error), never stranded on #academy-loading-screen and never ejected to the hub',
    s2Recovered && symptom2.activeScreenId === 'conversation-day-screen' && !symptom2.loadingActive && !symptom2.hubActive && symptom2.statusShown && symptom2.statusTone === 'error',
    { activeScreenId: symptom2.activeScreenId, loadingActive: symptom2.loadingActive, hubActive: symptom2.hubActive, statusShown: symptom2.statusShown, statusTone: symptom2.statusTone });

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\nERRAND SCREEN RENDER: ${passCount}/${results.length} checks passed`);
  if (passCount !== results.length) exitCode = 1;
  app.quit();
}

app.on('window-all-closed', () => {});
main().catch((e) => { console.error('HARNESS_ERROR', e?.stack ?? e); exitCode = 3; app.quit(); });
app.on('quit', () => {
  try { server?.close(); } catch {}
  try { lm?.server?.close(); } catch {}
  for (const p of cleanupPaths) fs.rm(p, { recursive: true, force: true }).catch(() => {});
  process.exit(exitCode);
});
