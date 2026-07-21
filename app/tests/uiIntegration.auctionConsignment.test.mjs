import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// Extract a top-level `function name(...) { ... }` body from app.js (brace-matched), so an assertion targets one
// function without matching an unrelated line elsewhere. (Mirrors the helper in uiIntegration.auction.test.mjs.)
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

// ── screen markup (index.html): 出品 picker + consignor badge extend the same academy-auction screen ──────────

test('the auction screen carries a 出品 picker overlay and a consignor board badge (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const block = html.match(/<section id="academy-auction-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'the auction screen section exists');
  // The consignment phase is part of the same screen (no new screen).
  assert.match(block, /id="academy-auction-consignment"[^>]*hidden/, 'the 出品 picker overlay exists, hidden by default');
  assert.match(block, /id="academy-auction-consignment-options"/, 'the picker lists the consignable assets');
  assert.match(block, /id="academy-auction-consignment-empty"[^>]*hidden/, 'the picker has an explicit empty note (no silent hide), hidden by default');
  assert.match(block, /id="academy-auction-consignment-skip"/, 'the picker carries the 出品しない affordance');
  // The board marks the player's own listing.
  assert.match(block, /id="academy-auction-consignor-badge"[^>]*hidden/, 'the board carries an あなたの出品 badge, hidden by default');
});

// ── app.js wiring ─────────────────────────────────────────────────────────────────────────────────────────

test('showAuctionLive and resetAuctionScreenView account for the consignment phase (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const showLive = appFunction(js, 'showAuctionLive');
  assert.match(showLive, /#academy-auction-consignment'\)/, 'showAuctionLive resolves the picker node');
  assert.match(showLive, /consignment\.hidden = true/, 'showAuctionLive hides the picker when the live board is shown');
  const reset = appFunction(js, 'resetAuctionScreenView');
  assert.match(reset, /auctionConsignmentView = null/, 'reset drops any prior-visit listed consignment');
  assert.match(reset, /auctionConsignmentChoiceResolve = null/, 'reset drops any dangling picker promise');
  assert.match(reset, /academy-auction-consignment-options'\)[\s\S]*replaceChildren\(\)/, 'reset clears the picker options DOM');
  assert.match(reset, /setAuctionConsignorBadge\(false\)/, 'reset clears the consignor badge');
  assert.match(reset, /hideAuctionConsignmentPicker\(\)/, 'reset hides the picker overlay (no re-entry residue)');
});

// Regression: the static skip button (#academy-auction-consignment-skip) is a single node reused across visits, so
// a picker choice's setAuctionConsignmentPickerBusy(true) left it disabled=true, and the next visit's picker showed
// 出品しない unclickable (option buttons are rebuilt fresh, so only the skip button residued). resetAuctionScreenView
// must clear the busy residue so every picker element the busy mechanism disables is operable again next visit.
test('reset clears the picker busy residue so 出品しない is operable on the next visit (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const reset = appFunction(js, 'resetAuctionScreenView');
  assert.match(reset, /setAuctionConsignmentPickerBusy\(false\)/, 'reset re-enables the picker controls (the static skip button stays disabled across visits otherwise)');
  // The busy mechanism is the single seam that disables picker controls: it must cover BOTH the static skip button
  // and the (rebuilt) option buttons, so clearing it in reset re-enables every element the choice handlers disable.
  const busy = appFunction(js, 'setAuctionConsignmentPickerBusy');
  assert.match(busy, /#academy-auction-consignment-skip'\)[\s\S]*\.disabled = busy/, 'busy toggles the static skip button');
  assert.match(busy, /\.academy-auction-consignment-option'\)[\s\S]*\.disabled = busy/, 'busy toggles the option buttons');
  // The choice handlers set busy=true (double-press guard) but never clear it — reset is the sole clearing seam.
  for (const name of ['submitAuctionConsignmentChoice', 'skipAuctionConsignmentChoice']) {
    const fn = appFunction(js, name);
    assert.match(fn, /setAuctionConsignmentPickerBusy\(true\)/, `${name} keeps the double-press guard (busy=true)`);
    assert.doesNotMatch(fn, /setAuctionConsignmentPickerBusy\(false\)/, `${name} does not itself clear busy (reset owns re-enabling)`);
  }
});

test('the entry session branches into picker / listed-resume / house by the consignment sub-state (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const needsPicker = appFunction(js, 'auctionConsignmentNeedsPicker');
  assert.match(needsPicker, /view\.consignment === null && view\.current_lot_index === 0/, 'the picker opens only in the 未決 consignment window (before house lot 1)');
  const session = appFunction(js, 'runAuctionSession');
  assert.match(session, /auctionConsignmentNeedsPicker\(view\)/, 'the entry checks the consignment window');
  assert.match(session, /runAuctionConsignmentPhaseAfterPicker\(\)/, 'the picker path drives submit / skip as the session promise');
  assert.match(session, /view\.consignment\.status === 'listed'[\s\S]*runAuctionConsignmentLot/, 'a still-listed consignment resumes the consignment lot');
  assert.match(session, /auctionPhase === 'consignment'\) renderAuctionConsignmentBoardFromState/, 'the post-cover render picks the consignment board for the consignment phase');
});

test('the consignment lot runs NPC-only 数珠つなぎ with no player turn (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const init = appFunction(js, 'initAuctionConsignmentBidState');
  assert.match(init, /playerActive: false/, 'the player is permanently inactive on their own consignment lot (no player bid)');
  const subRound = appFunction(js, 'runAuctionConsignmentNpcSubRound');
  assert.match(subRound, /let pending = askList\.length \? requestAuctionConsignmentNpcBid/, 'the sub-round primes the first NPC request');
  assert.match(subRound, /pending = \(i \+ 1 < askList\.length\) \? requestAuctionConsignmentNpcBid/, 'the sub-round fires the next request one ahead (1本先行・並列発射なし)');
  const request = appFunction(js, 'requestAuctionConsignmentNpcBid');
  assert.match(request, /\/api\/auction\/consignment\/npc-bid/, 'the NPC bid posts the consignment npc-bid route');
  assert.doesNotMatch(request, /lot_index/, 'the consignment npc-bid body carries no lot_index (single lot)');
});

test('the consignment lot streams the 出品 opening/reaction and resolves NPC-or-流札 with the payout-authoritative money (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const lot = appFunction(js, 'runAuctionConsignmentLot');
  assert.match(lot, /\/api\/auction\/consignment\/opening\/stream/, 'the lot opens with the 出品 opening stream');
  assert.match(lot, /\/api\/auction\/consignment\/reaction\/stream/, 'the seated bidders react over the consignment reaction stream');
  assert.match(lot, /recordAuctionMasterUtterance/, 'the 出品 opening 口上 feeds the shared master-utterance handoff (carried to the house lots)');
  const resolve = appFunction(js, 'resolveAuctionConsignmentLot');
  assert.match(resolve, /\/api\/auction\/consignment\/resolve/, 'resolve posts the consignment resolve route');
  assert.match(resolve, /winner === null \? null : auctionBidState\.current/, 'the winner is the standing NPC (or null 流札) — never player-priced');
  assert.match(resolve, /outcome === 'awarded'[\s\S]*\/api\/auction\/consignment\/hammer\/stream/, 'an awarded lot streams the hammer (passed_in does not)');
  assert.match(resolve, /auctionMoney = result\.payout\.money/, 'the credited money is taken from the authoritative payout, not recomputed client-side');
  assert.match(resolve, /AUCTION_CONSIGNMENT_PASSED_IN_NARRATION/, 'a 流札 shows the authored 品が手元に残る narration');
  assert.match(resolve, /runAuctionLot\(auctionSlotView\.current_lot_index\)/, 'the flow proceeds to the house lots after the consignment lot');
});

test('the consignment board never renders the player as the highest bidder and marks the listing (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const board = appFunction(js, 'renderAuctionConsignmentBoardFromState');
  assert.match(board, /auctionConsignmentView\.presentation/, 'the board renders the consignment presentation (not a house lot view)');
  assert.match(board, /setAuctionConsignorBadge\(true\)/, 'the board shows the あなたの出品 badge');
  assert.doesNotMatch(board, /AUCTION_PLAYER_WINNER_ID/, 'the player is never the highest bidder on their own lot');
});

test('the 出品 picker submits / skips through the consignment routes and is wired to the skip control (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const phase = appFunction(js, 'runAuctionConsignmentPhaseAfterPicker');
  assert.match(phase, /\/api\/auction\/consignment\/submit/, 'a chosen asset is submitted to the consignment submit route');
  assert.match(phase, /\/api\/auction\/consignment\/skip/, 'declining posts the consignment skip route');
  assert.match(js, /#academy-auction-consignment-skip'\)\.addEventListener\('click', \(\) => skipAuctionConsignmentChoice\(\)\)/, 'the 出品しない control is wired');
});

// ── CSS token layer: the new consignment rules stay --auction-* token-only ──────────────────────────────────

test('the consignment picker CSS consumes only the --auction-* layer (style.css)', async () => {
  const css = await readFile(path.join(root, 'style.css'), 'utf8');
  for (const selector of ['.academy-auction-consignment-card', '.academy-auction-consignment-option', '.academy-auction-consignor-badge']) {
    const block = cssRuleBlock(css, selector);
    assert.notEqual(block, '', `${selector} is defined`);
    assert.match(block, /var\(--auction-/, `${selector} consumes the auction token layer`);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, `${selector} pins no literal hex color`);
    assert.doesNotMatch(block, /--cd-night-|--arena-|--routing-/, `${selector} does not borrow another screen token layer`);
  }
});
