import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// Extract a top-level `function name(...) { ... }` body from app.js (brace-matched), the routing-suite helper so
// an assertion targets one function without matching an unrelated line elsewhere.
function appFunction(js, name) {
  const start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function not found in app.js: ${name}`);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = start + `function ${name}`.length; i < js.length; i += 1) {
    const ch = js[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') { parenDepth -= 1; if (parenDepth === 0) { bodyStart = js.indexOf('{', i); break; } }
  }
  if (bodyStart === -1) throw new Error(`could not find body for app.js function: ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < js.length; i += 1) {
    const ch = js[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return js.slice(start, i + 1); }
  }
  throw new Error(`unterminated function in app.js: ${name}`);
}

// ── screen markup (index.html) ───────────────────────────────────────────────

test('the auction is a dedicated no-tab screen with a board slot, chat panel, numeric bid bar, and closed view (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const block = html.match(/<section id="academy-auction-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-auction-screen section should exist');
  assert.match(block, /class="screen academy-auction-screen"/, 'the screen carries the academy-auction-screen token-layer host class');
  // Board slot (the auction analogue of the daytime stage-image slot): product identity + figures + history.
  assert.match(block, /id="academy-auction-live"/, 'the live surface wraps board + chat (toggled against the closed view)');
  assert.match(block, /id="academy-auction-board"/, 'the board exists');
  assert.match(block, /id="academy-auction-board-name"/, 'the board shows the lot name');
  assert.match(block, /id="academy-auction-board-category"/, 'the board shows the category label');
  assert.match(block, /id="academy-auction-board-blurb"/, 'the board shows the blurb');
  assert.match(block, /id="academy-auction-current"/, 'the board shows the current amount');
  assert.match(block, /id="academy-auction-highest"/, 'the board shows the highest bidder');
  assert.match(block, /id="academy-auction-increment"/, 'the board shows the minimum increment');
  assert.match(block, /id="academy-auction-lot-progress"/, 'the board shows the lot progress (n/3)');
  assert.match(block, /id="academy-auction-history"/, 'the board shows the bid history');
  // Chat panel: streamed speeches + status.
  assert.match(block, /id="academy-auction-message-stream"[^>]*aria-live="polite"/, 'the auction chat has its own live message stream');
  assert.match(block, /<p id="academy-auction-status"[^>]*aria-live="polite" hidden>/, 'the auction chat has its own status live region, hidden by default (error banner only)');
  // Numeric bid bar (add amount + 降りる), with a reason-bearing note region.
  assert.match(block, /id="academy-auction-bid-bar"/, 'the numeric bid bar exists');
  assert.match(block, /<input id="academy-auction-bid-input"[^>]*type="number"/, 'the bid bar is a numeric add-amount input, not a text composer');
  assert.match(block, /id="academy-auction-bid"[\s\S]*?id="academy-auction-drop"/, 'the bid bar has a 入札する and a 降りる control');
  assert.match(block, /id="academy-auction-bid-note"/, 'the bid bar carries a reason-bearing note region (validation / 入札不可)');
  // Closed view: week results + hub-return affordance.
  assert.match(block, /id="academy-auction-closed"[^>]*hidden/, 'the closed view exists, hidden by default');
  assert.match(block, /id="academy-auction-closed-results"/, 'the closed view lists the week results');
  assert.match(block, /id="academy-auction-exit"/, 'the closed view carries the ハブへ戻る affordance');
});

// ── app.js wiring ────────────────────────────────────────────────────────────

test('the auction screen is registered and driven through showScreen + the dev entry (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /'academy-auction': document\.querySelector\('#academy-auction-screen'\)/, 'the screen is in the screens registry');
  const showScreen = appFunction(js, 'showScreen');
  assert.match(showScreen, /name === 'academy-auction'\) enterOrResumeAuctionScreen\(\)\.catch\(reportAuctionScreenError\)/, 'showScreen enters/resumes the auction on show');
  assert.match(showScreen, /name !== 'academy-auction'\) auctionStage\.stopAmbient\(\)/, 'showScreen stops the auction ambient when leaving the screen');
  assert.match(js, /function requestedInitialAcademyAuction\(\)/, 'a dev entry predicate exists');
  const override = appFunction(js, 'applyInitialScreenOverride');
  assert.match(override, /if \(requestedInitialAcademyAuction\(\)\) \{ showScreen\('academy-auction'\); return; \}/, 'the dev entry lands on the auction screen');
});

test('the auction reuses the shared conversation stage and a consumer-owned SSE reader; the master resolves through the non-selectable actor registry (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  // The chat reuses the shared stage part (like the hub / daytime screens), not a forked chat implementation.
  assert.match(js, /const auctionStage = createConversationStage\(/, 'the auction chat is a createConversationStage consumer');
  // The auction result shape ({ lot_index, utterance, ... }) is not conversation-shaped, so the SSE reader is
  // owned by the auction (not the shared runAssistantSseStream).
  assert.match(js, /async function readAuctionSpeechSse\(/, 'the auction owns its SSE reader');
  // The authored master resolves through the non-selectable actor registry seam in sourceSheetImageUrl.
  const sourceSheet = appFunction(js, 'sourceSheetImageUrl');
  assert.match(sourceSheet, /\?\? auctionActorById\(characterId\)/, 'the master face resolves through auctionActorById in the actor chain');
  assert.match(js, /character_id: 'auction_garou'/, 'the authored master carries the auction_garou visual set id');
  assert.match(js, /競売人ガロウ/, 'the authored master is 競売人ガロウ');
  assert.match(js, /\/canonical\/character_visual_sets\/auction_garou\/face_emotions\/neutral\.jpg/, 'the master face is its authored neutral face');
});

test('the auction bid loop enforces the numeric bid rules, the being 入札不可 case, and the 1本先行 request pipeline (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const submitBid = appFunction(js, 'submitAuctionPlayerBid');
  assert.match(submitBid, /add < lot\.min_increment/, 'client-side minimum-increment validation (reason-bearing)');
  assert.match(submitBid, /nextPrice > auctionMoney/, 'client-side money-cap validation (reason-bearing)');
  assert.match(submitBid, /\/api\/auction\/bid/, 'the player raise posts to the bid endpoint');
  const bidReason = appFunction(js, 'auctionBidErrorReason');
  assert.match(bidReason, /AUCTION_BELOW_MIN_INCREMENT/, 'server 400 increment reason is surfaced');
  assert.match(bidReason, /AUCTION_INSUFFICIENT_MONEY/, 'server 400 money reason is surfaced');
  const bidLoop = appFunction(js, 'runAuctionBidLoop');
  assert.match(bidLoop, /lot\.category === 'being' && lot\.adoptable === false/, 'a being lot with no free 錬成室 slot disables bidding');
  assert.match(bidLoop, /錬成室の枠が空いていない/, 'the 入札不可 reason is shown (not a silent hide)');
  // 数珠つなぎ: the next NPC request is fired one ahead of the current reveal (no parallel LM fan-out).
  const subRound = appFunction(js, 'runAuctionNpcSubRound');
  assert.match(subRound, /let pending = askList\.length \? requestAuctionNpcBid/, 'the sub-round primes the first request');
  assert.match(subRound, /pending = \(i \+ 1 < askList\.length\) \? requestAuctionNpcBid/, 'the sub-round fires the next request one ahead of the current reveal');
});

test('every auction entry resets the prior-visit view (chat stream, bid history, session state) before deciding closed vs live (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  // The on-show entry resets FIRST, then fetches state — so no prior visit's chat/board survives on screen.
  const entry = appFunction(js, 'enterOrResumeAuctionScreen');
  assert.match(entry, /if \(auctionFlowInFlight\) return;\s*\n\s*resetAuctionScreenView\(\);/, 'the entry resets the view right after the re-entrant guard, before the state fetch');
  assert.ok(entry.indexOf('resetAuctionScreenView()') < entry.indexOf("getJson('/api/auction/state')"), 'the reset runs before the state GET (closed / live both start clean)');
  // The reset repaints the stream EMPTY — setHistory alone would leave the prior visit's rows in the DOM.
  const reset = appFunction(js, 'resetAuctionScreenView');
  assert.match(reset, /auctionStage\.renderStream\(\[\]\)/, 'the reset repaints the message stream empty (DOM), not just the history model');
  assert.match(reset, /#academy-auction-history[\s\S]*replaceChildren\(\)/, 'the reset clears the bid-history list DOM directly (it does not go through a board render)');
  assert.match(reset, /auctionSlotView = null/, 'the reset drops the prior slot view');
  assert.match(reset, /auctionBidState = null/, 'the reset drops the prior bid state');
  assert.match(reset, /auctionMasterUtterances = \[\]/, 'the reset drops the prior visit 反復回避ハンドオフ accumulator');
  assert.match(reset, /setAuctionBidBarActive\(false\)/, 'the reset disables the bid bar (no prior-visit active控え)');
  // The reset is the single clear: the readiness path no longer re-clears with setHistory (no redundant/dead clear).
  const session = appFunction(js, 'runAuctionSession');
  assert.doesNotMatch(session, /surface\.setHistory\(\[\]\)/, 'runAuctionSession does not re-clear history (the entry reset owns the clear)');
});

test('each house lot switches the product board at its opening 口上 stream start, showing the fresh lot (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const runLot = appFunction(js, 'runAuctionLot');
  // The prior lot's bid figures are dropped so the switch shows this lot's 初期額 / まだなし / empty 履歴 (the bid
  // loop's initAuctionBidState only runs later, after the reactions).
  assert.match(runLot, /auctionBidState = null;/, 'runAuctionLot drops the prior lot bid state so the board switch shows the fresh lot');
  // The board is painted the instant the opening 口上 stream begins (onStreamStart = first token), composed with any
  // caller hook (e.g. the entry loading-cover release on the first lot) — not after the reactions have played out.
  assert.match(runLot, /onStreamStart: \(\) => \{ renderAuctionBoardFromState\(\); onOpeningStreamStart\?\.\(\); \}/, 'the board switches in the opening 口上 onStreamStart, composing the caller hook');
  // A null bid state clears the history rows so no prior-lot bids linger beneath the fresh lot's board.
  const renderHistory = appFunction(js, 'renderAuctionHistory');
  assert.match(renderHistory, /if \(!auctionBidState\) \{ list\.replaceChildren\(\); return; \}/, 'a null bid state clears the history rows (no stale rows under the fresh lot)');
});

test('the third lot 決着 holds the closing speech for the shared reading pause before the closed view (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const resolveLot = appFunction(js, 'resolveAuctionCurrentLot');
  // On close, the final 決着 speech (hammer 口上 reveal / 流札演出) is held for DRAIN_READING_PAUSE_MS — the shared
  // single-source read-pause (hub 見送り / 昼会話 達成自動終了 と同一定数) — before the closed view swaps in.
  assert.match(resolveLot, /if \(result\.resolution\.closed\) \{[\s\S]*await sleep\(DRAIN_READING_PAUSE_MS\);[\s\S]*renderAuctionClosed\(auctionSlotView\);/, 'the closed branch pauses for DRAIN_READING_PAUSE_MS before rendering the closed view');
  assert.ok(
    resolveLot.indexOf('await sleep(DRAIN_READING_PAUSE_MS)') < resolveLot.indexOf('renderAuctionClosed(auctionSlotView)'),
    'the reading pause runs before the closed view render (the closing words are legible first)'
  );
  // The pause shares the single-source constant — no new 5000 literal.
  assert.doesNotMatch(resolveLot, /5000/, 'the closing pause reuses DRAIN_READING_PAUSE_MS, not a duplicated 5000 literal');
});

// ── style.css: viewport-fit + internal chat scroll (the play-screen height discipline) ──

test('the auction screen is bound to the viewport and its chat absorbs new utterances into an internal scroll (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  // The .layout is pinned to the viewport height (minus the runtime topbar) with overflow hidden, so the
  // screen's height:100% resolves against a fixed height instead of tracking the growing chat content.
  const layout = cssRuleBlock(css, 'body:has(#academy-auction-screen.active) .layout');
  assert.notEqual(layout, '', 'the auction viewport-height constraint on .layout exists');
  assert.match(layout, /height:\s*calc\(100dvh - var\(--runtime-topbar-height[^)]*\)\)/, 'the .layout is bound to the viewport height minus the runtime topbar');
  assert.match(layout, /overflow:\s*hidden/, 'the .layout clips overflow so the page cannot grow past the viewport');
  assert.match(layout, /min-height:\s*0/, 'the .layout allows its grid child to shrink (min-height:0)');
  // The screen host itself is a fixed-height, clipped surface (its height:100% now resolves).
  const screenBlock = cssRuleBlock(css, '.academy-auction-screen');
  assert.match(screenBlock, /height:\s*100%/, 'the screen host fills its (now fixed-height) .layout');
  assert.match(screenBlock, /overflow:\s*hidden/, 'the screen host clips so only the chat scrolls internally');
  // The chat stream owns the internal scroll via the flex:1 / min-height:0 / overflow-y:auto chain.
  const stream = cssRuleBlock(css, '.academy-auction-message-stream');
  assert.notEqual(stream, '', 'the auction message stream rule exists');
  assert.match(stream, /flex:\s*1 1 auto/, 'the message stream is the flexible row that takes the remaining height');
  assert.match(stream, /min-height:\s*0/, 'the message stream can shrink below content height (min-height:0)');
  assert.match(stream, /overflow-y:\s*auto/, 'the message stream scrolls internally instead of growing the page');
  // The board panel and the numeric bid bar stay fixed (they are not pushed off by chat growth).
  const bidBar = cssRuleBlock(css, '.academy-auction-bid-bar');
  assert.match(bidBar, /flex:\s*0 0 auto/, 'the numeric bid bar keeps a fixed size (never pushed off-screen by chat)');
  const boardPanel = cssRuleBlock(css, '.academy-auction-board-panel');
  assert.match(boardPanel, /flex:\s*0 1 42%/, 'the board panel holds the stage-slot column (not squeezed by chat growth)');
});

// ── style.css: --auction-* token layer (test-by-token, no literal color pin outside the definition) ──

test('the auction defines its own --auction-* screen token layer and consuming rules pin no literal colors (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  const screenBlock = cssRuleBlock(css, '.academy-auction-screen');
  assert.notEqual(screenBlock, '', 'the .academy-auction-screen token host block exists');
  assert.match(screenBlock, /--auction-bg-0:[\s\S]*--auction-ink:[\s\S]*--auction-crimson:[\s\S]*--auction-brass:[\s\S]*--auction-amber:/, 'the layer defines its obsidian / ink / crimson / brass / amber tokens');
  assert.doesNotMatch(screenBlock, /--cd-night-|--arena-|--routing-/, 'the --auction-* layer does not redefine or borrow another screen token layer');
  // Consuming rules are token-only (literals live only in the definition block above): test-by-token.
  const button = cssRuleBlock(css, '.academy-auction-action-button');
  assert.notEqual(button, '', 'the auction action button rule exists');
  assert.match(button, /var\(--auction-/, 'the action button consumes --auction-* tokens');
  assert.doesNotMatch(button, /#[0-9a-fA-F]{3,8}|rgba?\(/, 'the action button pins no literal color (token-only)');
  const board = cssRuleBlock(css, '.academy-auction-board');
  assert.match(board, /var\(--auction-/, 'the board consumes --auction-* tokens');
  assert.doesNotMatch(board, /#[0-9a-fA-F]{3,8}|rgba?\(/, 'the board pins no literal color (token-only)');
});
