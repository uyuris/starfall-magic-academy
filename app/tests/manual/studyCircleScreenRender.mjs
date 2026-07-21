// Render-backed study circle arrival screen check (Electron / real Blink layout + real client flow).
//
// `node --test` cannot run app.js (no fetch / DOM / real layout), so the study circle arrival screen
// (#academy-study-circle-screen — the routing "study_circle"/研究会 destination's landing surface) is verified
// here against the REAL client in Electron. This file is intentionally NOT named *.test.mjs and lives under
// app/tests/manual/, so `npm test` (node --test app/tests/*.test.mjs) skips it; run it by hand:
//
//   ./node_modules/.bin/electron app/tests/manual/studyCircleScreenRender.mjs
//
// It boots an isolated server in ROUTING mode with a DETERMINISTIC local LM stub, does a routing new-game
// (which materializes the fixture roster + runtime state so GET /api/study-circle can pick real selectable-roster
// hosts and decorate their faces), and drives the REAL study circle flow against real Blink layout:
//   1. ARRIVAL: ?initialScreen=academy-study-circle renders the dedicated #academy-study-circle-screen with this
//      week's three offer cards — each carrying a title / theme / venue / situation / reward deltas / host name +
//      FACE — in a horizontally placed, internally scrolling board on the RIGHT, beside a 1:1 stage-image column on
//      the LEFT (/canonical/study_circle/stage.jpg) with the week header (第N週 / 50) overlaid (conversation-day 黒夜
//      chrome, 星藍 accent). This is the dev entry AND the shape a routing dispatch to study circle lands on.
//   2. SELECT → CONVERSATION: click a card → the academy loading screen (#academy-loading-screen) covers the
//      POST /api/study-circle/start wait (no freeze / 留まる区間 on the arrival) → the host's conversation opens on the
//      DAYTIME conversation screen (#conversation-day-screen) with the host's NAME (chat bubble) and the 主催 STANDEE
//      in the stage frame (#conversation-day-stage-image, NOT a field stage image), the opening revealed in the
//      daytime stream. Clicking the stage frame (the 主催 standee) opens the detail popup, which shows the venue + the
//      theme / situation over the new 1:1 study circle stage image (study_circle/stage.jpg).
//   3. TURN: type + send a real turn (/api/conversation/stream) on the daytime screen; the player utterance + the
//      reply appear. The daytime turn body carries the study circle conversation id (routingTurnRequestBody's study
//      circle branch) — a missing id would 409 the turn as a context mismatch, so a successful turn proves the id
//      was sent.
//   4. END → HUB RETURN: click 会話を終える (#conversation-day-end) → the EXISTING routing drain-on-exit end path
//      (endRoutingConversation) drains the study circle finalization (parameter deltas applied server-side) and
//      returns to the hub (#routing-hub-screen), proving the study_circle content result does not break the existing
//      content-return path.
//   5. REAL DISPATCH: a hub turn the stub decides toward study circle lands on the arrival via
//      performRoutingTurnDispatch (the in-turn dispatch entry, not just the dev entry).
//
// NEGATIVE CONTROL (documented in the task report): reverting the wiring (remove the screens['academy-study-circle']
// registry entry / the showScreen refreshStudyCircleScreen hook, or the #academy-study-circle-screen section) makes
// step 1 FAIL — the arrival never renders; removing the study_circle dispatch mirror entry makes step 5 FAIL (the
// decided hub turn throws unknown destination_id). Per ref-camera the harness is fire-and-forget (no top-level
// await main(); whenReady would deadlock).
import { app, BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'app/public');
const REPO_CANONICAL = path.join(PROJECT_ROOT, 'assets/canonical');
const WIN_W = Number(process.env.SC_WIN_W ?? 1200);
const WIN_H = Number(process.env.SC_WIN_H ?? 820);
// Deterministic conversation text the local LM stub answers so the study circle opening / turn / drain run
// end-to-end (the study circle conversation is an ordinary routing-mode character conversation).
const TURN_INPUT = process.env.SC_INPUT ?? 'この研究会、参加します。今日は何を学べますか？';
const OPENING_TEXT = 'よく来てくれました。さあ、今日の研究会を始めましょう。';
const TURN_REPLY = 'いい問いですね。では、そこから深めていきましょう。';
// The hub-dispatch leg: the player's hub turn the stub decides toward the study circle destination, and the
// send-off utterance streamed before performRoutingTurnDispatch navigates to the study circle arrival.
const HUB_DISPATCH_INPUT = process.env.SC_HUB_INPUT ?? '今日はじっくり研究に打ち込みたい気分です。';
const SENDOFF_TEXT = 'では、研究会の会場へ向かいましょう。';
// The weekly-offer generation LM calls: GET /api/study-circle generates each offer's structured title /
// situation / motivation via the study_circle_offer_record schema AND the appeal (主催者当人の語り) via a
// separate chat call. The stub answers both with gate-clean text. The appeal is the card's主表示; situation
// is the daytime scene.
const OFFER_TITLE = '研究会の相談';
const OFFER_SITUATION = '実習台に、支度が種類ごとに並べて置かれている。';
const OFFER_MOTIVATION = '主催者が、会話を通じてこの研究会に付き合ってほしいと考えている。';
const OFFER_APPEAL = 'ねえ、少し時間はあるかな。今日の研究会を開くから、あなたにも一緒に来てほしいんだ。あなたとなら楽しくやれそうだと思って、声をかけたの。';

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

// Deterministic routing character-conversation LM stub: answers the emotion / work-record / continuation LM calls of
// the ordinary conversation pipeline, returns the turn reply when the transcript carries the player's input, and
// otherwise a generic line (the study circle opening, the drain's freeform reflection, and the hub re-opening welcome
// all fall here). This drives the study circle opening / turn / drain and the hub re-open with no real LM Studio —
// the same shape the errand render harness uses.
async function startStubLm() {
  const requests = [];
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
    // GET /api/study-circle now generates the offer text (title / situation / motivation) through the 2-stage gate;
    // the stub returns a gate-clean pure-scene offer so the weekly slot persists and the three cards render.
    else if (schemaName === 'study_circle_offer_record') content = JSON.stringify({ title: OFFER_TITLE, situation: OFFER_SITUATION, motivation: OFFER_MOTIVATION });
    else if (prompt.includes('この研究会を自分の口から持ちかける')) content = OFFER_APPEAL; // study circle appeal (当人の語り) chat call
    else if (prompt.includes('場所移動の合意')) content = 'false'; // stage-move agreement (disabled here) → no move
    else if (prompt.includes('location_idを1つだけ返す')) content = 'none'; // stage-move destination selection → none
    else if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) content = 'study_circle'; // hub destination judgment → study circle
    else if (prompt.includes('行き先が確定したプレイヤーを送り出す')) content = SENDOFF_TEXT; // hub send-off utterance
    // The active study circle turn REPLACES the continuation judgment with the per-turn achievement judgment;
    // return false so the study circle keeps going and the harness ends it via the button (step 4).
    else if (prompt.includes('研究会の達成条件')) content = 'false'; // study circle achievement judgment → not yet achieved
    else if (prompt.includes('継続したいと思うか')) content = 'true'; // continuation judgment → keep going (end via button)
    else if (prompt.includes('好感度の変化量を判定する')) content = '0'; // affinity delta judgment → neutral (contract: integer -10..10)
    else if (prompt.includes('MP温存ライン')) content = '30'; // mp reserve line judgment → neutral (contract: integer 0..100)
    else if (prompt.includes(TURN_INPUT)) content = TURN_REPLY; // the reply (transcript carries the player input)
    else content = OPENING_TEXT; // study circle opening / hub opening & re-opening / drain reflection
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

// Routing-mode fixture. The runtime-paths manifest points the definitions/seeds/mutable roots at the fixture's
// game_data (so new-game materializes the roster + state there) and resourceRoot at the fixture root. The study
// circle definitions (study_circles.json) and the authored type catalog (study_circle_types.json) are already
// provisioned into game_data by fixtureRoot's seedLegacyGameDataDefinitions (both load from <definitionsRoot> — the
// fixture's game_data), so no extra copy is needed here (unlike the errand harness, whose errand_types.json loads
// from resourceRoot/data/definitions).
async function routingFixture() {
  const root = await fixtureRoot('study-circle-screen-render-');
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
  const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-circle-screen-render-settings-'));
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

// Routing new-game materializes runtime state + the fixture roster, then reload the study circle dev screen: boot's
// refresh() adopts that state (currentPlayMode=routing from GET /api/slots), and ?initialScreen=academy-study-circle
// shows the arrival, whose showScreen hook fetches GET /api/study-circle and renders the three offer cards.
async function newGameThenStudyCircle(win, base) {
  await win.loadURL(`${base}/`);
  await sleep(1000);
  await js(win, `fetch('/api/new-game', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
  await win.loadURL(`${base}/?initialScreen=academy-study-circle`);
  return waitFor(win, `
    document.querySelector('#academy-study-circle-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length === 3
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
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  log('server', { base, playMode: 'routing' });

  await app.whenReady();
  const win = new BrowserWindow({ width: WIN_W, height: WIN_H, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.log(`renderer-error: ${message}`); });

  // ── 1) ARRIVAL: the study circle board renders three offer cards on the night full-screen surface ──
  const onStudyCircle = await newGameThenStudyCircle(win, base);
  const arrival = await js(win, `(() => {
    const active = document.querySelector('.screen.active');
    const cards = [...document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card')];
    const readCard = (card) => {
      const face = card.querySelector('.academy-study-circle-card-face');
      return {
        themeId: card.querySelector('.academy-study-circle-card-button')?.dataset.themeId || '',
        hostName: (card.querySelector('.academy-study-circle-card-host-name')?.textContent || '').trim(),
        title: (card.querySelector('.academy-study-circle-card-title')?.textContent || '').trim(),
        theme: (card.querySelector('.academy-study-circle-card-theme')?.textContent || '').trim(),
        venue: (card.querySelector('.academy-study-circle-card-venue')?.textContent || '').trim(),
        // The card body element (the -situation class is the shared body-text styling hook) now carries the appeal.
        appeal: (card.querySelector('.academy-study-circle-card-situation')?.textContent || '').trim(),
        rewards: (card.querySelector('.academy-study-circle-card-rewards')?.textContent || '').trim(),
        // 達成条件 is the internal judgment value only — the card must render NO condition element (never shown).
        hasCondition: !!card.querySelector('.academy-study-circle-card-condition'),
        faceSrc: face?.getAttribute('src') || '',
        faceVisible: face ? getComputedStyle(face).visibility !== 'hidden' : false
      };
    };
    return {
      activeScreenId: active ? active.id : null,
      routingActive: !!document.querySelector('#routing-hub-screen.active'),
      sessionActive: !!document.querySelector('#academy-conversation-session-screen.active'),
      hasTab: !!document.querySelector('[data-screen="academy-study-circle"]'),
      weekText: (document.querySelector('#academy-study-circle-week')?.textContent || '').trim(),
      stageBg: (() => { const b = document.querySelector('.academy-study-circle-stage-image'); return b ? getComputedStyle(b).backgroundImage : ''; })(),
      // Direct-background (いきなり背景) standard: the layout has padding:0 so the flat obsidian screen fills it
      // edge-to-edge with no navy-gradient border inset.
      layoutPadding: (() => { const l = document.querySelector('.layout'); return l ? getComputedStyle(l).padding : ''; })(),
      cards: cards.map(readCard)
    };
  })()`);
  log('arrival', arrival);
  check('ARRIVAL lands on the dedicated #academy-study-circle-screen (not routing hub / session), no tab',
    onStudyCircle && arrival.activeScreenId === 'academy-study-circle-screen' && !arrival.routingActive && !arrival.sessionActive && !arrival.hasTab,
    { activeScreenId: arrival.activeScreenId, hasTab: arrival.hasTab });
  check('ARRIVAL renders exactly three offer cards with the week header 第N週 / 50',
    arrival.cards.length === 3 && /^第\d+週 \/ 50$/.test(arrival.weekText), { weekText: arrival.weekText, cardCount: arrival.cards.length });
  const everyCardComplete = arrival.cards.every((c) => c.themeId && c.hostName && c.title && c.theme && c.venue && c.appeal && c.rewards && c.faceSrc && c.faceVisible);
  check('ARRIVAL each card carries title / theme / venue / appeal (当人の語り) / reward deltas / host name + a visible host face',
    everyCardComplete, { cards: arrival.cards.map((c) => ({ id: c.themeId, host: c.hostName, title: !!c.title, theme: !!c.theme, venue: !!c.venue, rewards: c.rewards, face: c.faceVisible })) });
  check('ARRIVAL the three theme ids and the three hosts are unique (deterministic offer set)',
    new Set(arrival.cards.map((c) => c.themeId)).size === 3 && new Set(arrival.cards.map((c) => c.hostName)).size === 3,
    { ids: arrival.cards.map((c) => c.themeId), hosts: arrival.cards.map((c) => c.hostName) });
  // STAGE COLUMN: the conversation-day 黒夜 chrome (星藍 accent) frames the new 1:1 study circle stage image (the
  // screen's face) in the left column — a real background-image on .academy-study-circle-stage-image.
  check('ARRIVAL the 1:1 stage-image column paints the new study circle stage image (a real background-image, not none)',
    arrival.stageBg && arrival.stageBg !== 'none' && arrival.stageBg.includes('/canonical/study_circle/stage.jpg'),
    { stageBg: arrival.stageBg.slice(0, 90) });
  // CONDITION REMOVAL: 達成条件 is the internal judgment value only — no card renders a condition element.
  check('ARRIVAL no offer card renders a 達成条件 element (condition is internal only, never shown to the player)',
    arrival.cards.length > 0 && arrival.cards.every((c) => c.hasCondition === false),
    { hasCondition: arrival.cards.map((c) => c.hasCondition) });
  // BACKGROUND (いきなり背景): the study circle layout is edge-to-edge (padding:0) so the flat obsidian screen fills
  // it with no navy-gradient border inset behind it (the frame's own padding holds the content余白).
  check('ARRIVAL the study circle layout is edge-to-edge (layout padding:0) — no navy-gradient border inset behind the obsidian screen',
    arrival.layoutPadding === '0px', { layoutPadding: arrival.layoutPadding });

  // REWARD BADGE LAYOUT: every reward balloon renders at a uniform height regardless of the offer's reward count or
  // label length, and the rewards row never cross-axis-stretches its badges (align-items:flex-start) — so a card
  // with few / short rewards does not 間延び below its content. Measured against real Blink layout: (a) the natural
  // three cards (varying reward counts) share one badge height; (b) a synthetic long-label badge injected into a real
  // card's rewards row (real card width) stays single-line (white-space:nowrap), so its height equals a normal badge
  // — proving the fix removes the wrap-driven stretch even in the width-constrained card.
  const badges = await js(win, `(() => {
    const round = (n) => Math.round(n * 100) / 100;
    const cards = [...document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card')];
    const perCard = cards.map((card) => {
      const row = card.querySelector('.academy-study-circle-card-rewards');
      const chips = [...card.querySelectorAll('.academy-study-circle-card-reward')];
      return {
        rowAlign: row ? getComputedStyle(row).alignItems : '',
        count: chips.length,
        heights: chips.map((c) => round(c.getBoundingClientRect().height))
      };
    });
    const allHeights = perCard.flatMap((c) => c.heights);
    // Synthetic stress: inject a very long-label badge into the first card's real rewards row and compare its height
    // to that same card's first (short) badge. white-space:nowrap keeps it one line, so heights must match.
    const firstRow = cards[0]?.querySelector('.academy-study-circle-card-rewards');
    const firstChip = cards[0]?.querySelector('.academy-study-circle-card-reward');
    let stress = null;
    if (firstRow && firstChip) {
      const long = document.createElement('span');
      long.className = 'academy-study-circle-card-reward';
      long.textContent = '非常に長い報酬パラメータ名の見本ラベル +9999';
      firstRow.append(long);
      stress = {
        normalHeight: round(firstChip.getBoundingClientRect().height),
        longHeight: round(long.getBoundingClientRect().height),
        longWhiteSpace: getComputedStyle(long).whiteSpace
      };
      long.remove();
    }
    return { perCard, allHeights, stress };
  })()`);
  log('reward_badges', badges);
  const uniformHeight = badges.allHeights.length >= 3
    && badges.allHeights.every((h) => Math.abs(h - badges.allHeights[0]) < 0.5);
  const noStretch = badges.perCard.every((c) => c.rowAlign === 'flex-start');
  check('REWARD BADGES: every reward balloon across the three cards renders at one uniform height, and the rewards row does not cross-axis-stretch (align-items:flex-start)',
    uniformHeight && noStretch,
    { rowAligns: badges.perCard.map((c) => c.rowAlign), counts: badges.perCard.map((c) => c.count), allHeights: badges.allHeights });
  check('REWARD BADGES: a long-label badge injected at real card width stays single-line (white-space:nowrap) and keeps the uniform badge height (no wrap-driven vertical stretch / 間延び)',
    !!badges.stress && badges.stress.longWhiteSpace === 'nowrap'
    && Math.abs(badges.stress.longHeight - badges.stress.normalHeight) < 0.5,
    badges.stress);

  const shotPath = path.join(os.tmpdir(), 'study-circle-arrival-render.png');
  try { await sleep(500); await fs.writeFile(shotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${shotPath}`); }
  catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }

  // ── 1b) OFFER-FETCH RETRY (the errand mirror): a failed weekly-offer fetch clears the board and surfaces the
  // error banner + the explicit retry button; clicking retry re-runs refreshStudyCircleScreen and recovers the
  // board. The arrival has no back / skip (会話終了 is the only hub return, arrival = the week is spent), so the
  // retry button is the only in-place recovery from a failed generation. Force GET /api/study-circle to fail,
  // invoke the refresh through the retry button, assert the empty-board error state, then restore the fetch and
  // click retry again to recover the three cards. Leaves a clean arrival for the SELECT leg below. ──
  await js(win, `(() => {
    const orig = window.fetch;
    window.__origFetch = orig;
    window.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      if (u.includes('/api/study-circle') && !u.includes('/api/study-circle/start')) {
        return Promise.resolve(new Response('{"error":"forced offer-fetch failure"}', { status: 500, headers: { 'content-type': 'application/json' } }));
      }
      return orig(input, init);
    };
    return true;
  })()`);
  await js(win, `document.querySelector('#academy-study-circle-retry')?.click()`);
  const retryFailState = await waitFor(win, `
    document.querySelector('#academy-study-circle-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length === 0
    && document.querySelector('#academy-study-circle-retry')?.hidden === false
    && (() => { const s = document.querySelector('#academy-study-circle-status'); return !!s && s.hidden === false && (s.textContent || '').trim().length > 0; })()
  `, { tries: 300, intervalMs: 60 });
  const retryFail = await js(win, `(() => {
    const s = document.querySelector('#academy-study-circle-status');
    const r = document.querySelector('#academy-study-circle-retry');
    return {
      cards: document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length,
      retryVisible: !!r && r.hidden === false,
      statusShown: !!s && s.hidden === false && (s.textContent || '').trim().length > 0,
      statusTone: s?.dataset.tone ?? ''
    };
  })()`);
  log('retry_fail', { retryFailState, ...retryFail });
  check('RETRY: a failed weekly-offer fetch clears the board and surfaces the error banner + the explicit retry button (the arrival has no back / skip)',
    retryFailState && retryFail.cards === 0 && retryFail.retryVisible && retryFail.statusShown && retryFail.statusTone === 'error',
    { cards: retryFail.cards, retryVisible: retryFail.retryVisible, statusShown: retryFail.statusShown, statusTone: retryFail.statusTone });
  const retryShotPath = path.join(os.tmpdir(), 'study-circle-arrival-retry.png');
  try { await sleep(300); await fs.writeFile(retryShotPath, (await win.webContents.capturePage()).toPNG()); console.log(`screenshot: ${retryShotPath}`); } catch (e) { console.log(`screenshot: FAILED ${e?.message ?? e}`); }
  await js(win, `(() => { if (window.__origFetch) { window.fetch = window.__origFetch; delete window.__origFetch; } return true; })()`);
  await js(win, `document.querySelector('#academy-study-circle-retry')?.click()`);
  const retryRecovered = await waitFor(win, `
    document.querySelector('#academy-study-circle-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length === 3
    && document.querySelector('#academy-study-circle-retry')?.hidden === true
    && document.querySelector('#academy-study-circle-status')?.hidden === true
  `, { tries: 400, intervalMs: 120 });
  const retryRecover = await js(win, `(() => ({
    cards: document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length,
    retryHidden: document.querySelector('#academy-study-circle-retry')?.hidden === true,
    statusHidden: document.querySelector('#academy-study-circle-status')?.hidden === true
  }))()`);
  log('retry_recover', { retryRecovered, ...retryRecover });
  check('RETRY: clicking the retry button re-runs refreshStudyCircleScreen and recovers the board (three cards back, retry hidden, status cleared)',
    retryRecovered && retryRecover.cards === 3 && retryRecover.retryHidden && retryRecover.statusHidden,
    { cards: retryRecover.cards, retryHidden: retryRecover.retryHidden, statusHidden: retryRecover.statusHidden });

  // ── 2) SELECT → CONVERSATION: a card starts the host's conversation on the DAYTIME screen ──
  const chosenHost = arrival.cards[0]?.hostName ?? '';
  const chosenTheme = arrival.cards[0]?.theme ?? '';
  const chosenVenue = arrival.cards[0]?.venue ?? '';
  // The daytime stage popup shows the pure scene (situation), NOT the card's appeal body — compare against
  // the stub's situation (the offer's situation flows start-response → activeStudyCircleScene → popup).
  const chosenSituation = OFFER_SITUATION;
  const clicked = await js(win, `(() => {
    const btn = document.querySelector('#academy-study-circle-offers .academy-study-circle-card .academy-study-circle-card-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  // The freeze fix (mirror of the errand arrival): selecting an offer shows the academy loading screen WHILE the
  // (session + opening) start POST runs, so the player never sits frozen on the arrival. showScreen('academy-loading')
  // is synchronous at the start of showAcademyLoadingScreenUntilReady — ahead of the async start POST resolving — so
  // the loading interstitial replaces the arrival in the same click, and it holds for at least ACADEMY_LOADING_MINIMUM_MS.
  const loadingCovered = clicked && await waitFor(win, `
    document.querySelector('#academy-loading-screen')?.classList.contains('active')
  `, { tries: 400, intervalMs: 15 });
  check('SELECT → LOADING: selecting an offer shows the academy loading screen while the study circle start runs (no freeze / 留まる区間 on the arrival)',
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
      studyCircleActive: !!document.querySelector('#academy-study-circle-screen.active'),
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
  log('day', { chosenHost, ...day });
  check('SELECT lands the study circle conversation on the daytime screen (not session / hub / arrival) with the host bound as speaker',
    onDay && day.activeScreenId === 'conversation-day-screen' && !day.studyCircleActive && !day.routingActive && !day.sessionActive
    && day.speakerName.length > 0 && day.speakerName === chosenHost && day.speakerName !== '選択中のキャラ',
    { activeScreenId: day.activeScreenId, speakerName: day.speakerName, chosenHost });
  check('SELECT paints the 主催 standee in the daytime stage frame (the study circle venue, independent of the field stage — a real background-image, labelled by the venue)',
    day.frameBg && day.frameBg !== 'none' && day.frameBg.includes('url(') && (chosenVenue ? day.frameLabel.includes(chosenVenue) : day.frameLabel.length > 0),
    { frameBg: day.frameBg.slice(0, 80), frameLabel: day.frameLabel });
  check('SELECT reveals the study circle opening in the daytime stream with the host face (POST /api/study-circle/start, one call)',
    day.messageCount > 0 && day.faceSrc.length > 0 && day.streamText.includes('研究会を始めましょう'),
    { messageCount: day.messageCount, faceSrc: day.faceSrc, hasOpening: day.streamText.includes('研究会を始めましょう') });

  // ── 2b) STAGE DETAIL POPUP: clicking the stage frame (the 主催 standee) shows the venue + the theme / situation
  // over the new 1:1 study circle stage image (study_circle/stage.jpg, data-scene="study-circle" → square, viewport-fit). ──
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
  check('STAGE POPUP: the stage-frame click opens the detail popup showing the venue + the theme / situation over the new 1:1 study circle stage image (square, viewport-fit)',
    popup.visible && (chosenVenue ? popup.title === chosenVenue : popup.title.length > 0) && popup.scene === 'study-circle'
    && (chosenTheme ? popup.text.includes(chosenTheme) : true) && (chosenSituation ? popup.text.includes(chosenSituation) : true)
    && popup.popupBg && popup.popupBg.includes('/canonical/study_circle/stage.jpg') && popup.popupAspect === '1/1',
    { title: popup.title, scene: popup.scene, popupAspect: popup.popupAspect, popupBg: popup.popupBg.slice(0, 80) });
  check('STAGE POPUP: the detail popup shows NO 達成条件 (the condition is internal only, never shown to the player)',
    popup.visible && !popup.text.includes('達成条件'), { text: popup.text.slice(0, 80) });

  // ── 3) TURN over the character conversation API (/api/conversation/stream) on the daytime screen ──
  // A successful turn proves the study circle id was carried in the turn body — a missing id 409s the turn.
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
      hasReply: text.includes('深めていきましょう'),
      stillDay: !!document.querySelector('#conversation-day-screen.active')
    };
  })()`);
  log('turn', { beforeTurn, fired, sent, settled, ...turn });
  check('TURN: a daytime study circle turn flows end-to-end (player utterance + reply appended, stays on the daytime screen) — proves the study circle id rode the turn body',
    sent && settled && turn.rowCount >= beforeTurn + 2 && turn.hasPlayerInput && turn.hasReply && turn.stillDay,
    { beforeTurn, rowCount: turn.rowCount, hasPlayerInput: turn.hasPlayerInput, hasReply: turn.hasReply });

  // ── 4) END → HUB RETURN via the EXISTING routing drain-on-exit end path (the daytime end button, study circle branch) ──
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
    studyCircleActive: !!document.querySelector('#academy-study-circle-screen.active'),
    hubOpeningLen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').trim().length
  }))()`);
  log('end', { ended, ...hub });
  check('END → HUB: the daytime end button (study circle branch → endRoutingConversation) returns to the hub (#routing-hub-screen) — not stranded on the daytime screen / arrival',
    onHub && hub.activeScreenId === 'routing-hub-screen' && !hub.dayActive && !hub.studyCircleActive && hub.hubOpeningLen > 0,
    { activeScreenId: hub.activeScreenId, hubOpeningLen: hub.hubOpeningLen });

  // ── 5) REAL DISPATCH: a hub turn the stub decides toward study circle lands on the arrival via performRoutingTurnDispatch ──
  // Closes the arrival's other accepted entry (the in-turn routing dispatch, not just the dev entry): from the hub, a
  // decided turn carries routing_dispatch(study_circle) → the SSE seam consumes it in-turn → the loading interstitial
  // navigates to #academy-study-circle-screen and its showScreen hook renders this (next) week's offers.
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
    document.querySelector('#academy-study-circle-screen')?.classList.contains('active')
    && document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length === 3
  `, { tries: 600, intervalMs: 150 });
  await sleep(300);
  const dispatch = await js(win, `(() => ({
    activeScreenId: document.querySelector('.screen.active')?.id ?? null,
    cardCount: document.querySelectorAll('#academy-study-circle-offers .academy-study-circle-card').length,
    weekText: (document.querySelector('#academy-study-circle-week')?.textContent || '').trim(),
    sendoffSeen: (document.querySelector('#routing-hub-message-stream')?.textContent || '').includes(${JSON.stringify(SENDOFF_TEXT)})
  }))()`);
  log('dispatch', { dispatchFired, dispatched, ...dispatch });
  check('DISPATCH: a decided routing hub turn (study_circle) lands on #academy-study-circle-screen via performRoutingTurnDispatch with the three offer cards rendered',
    dispatched && dispatch.activeScreenId === 'academy-study-circle-screen' && dispatch.cardCount === 3 && /^第\d+週 \/ 50$/.test(dispatch.weekText),
    { activeScreenId: dispatch.activeScreenId, cardCount: dispatch.cardCount, weekText: dispatch.weekText, sendoffSeen: dispatch.sendoffSeen });

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\nSTUDY CIRCLE SCREEN RENDER: ${passCount}/${results.length} checks passed`);
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
