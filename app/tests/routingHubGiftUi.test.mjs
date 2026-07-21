// Routing hub 渡す (会話中の贈与 to the 案内人) use-UI contract (source-regex): the render gate (hub conversation
// active + a gift-category item + 1会話1回), the server-authoritative gift_category annotation, the confirm → POST
// /api/conversation/gift → reaction reveal on the hub stage → effect toast flow, the in-flight guard, and the
// clean-chat reveal discipline. The daytime (roster) gift shares the effect / handover / error helpers; only the
// reveal targets the hub stage. The hub guide accepts only the affinity `gift` category (ally_boost is 400ed by
// the backend), so the render gate requires gift_category === 'gift'.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');
const readApp = () => readFile(path.join(publicRoot, 'app.js'), 'utf8');
const readCss = () => readFile(path.join(publicRoot, 'style.css'), 'utf8');

test('the hub inventory ledger adds 渡す only to a gift-category row in an active hub conversation', async () => {
  const js = await readApp();
  const fn = js.match(/function renderRoutingHubInventoryLedgerInto\(bodyEl, feedback = null\)[\s\S]*?\n\}/)?.[0] ?? '';
  // gift_category is a required annotated field ('gift' | 'ally_boost' | null) — a malformed value is broken wiring.
  assert.match(fn, /item\.gift_category !== null && item\.gift_category !== 'gift' && item\.gift_category !== 'ally_boost'[\s\S]*?throw new Error/, 'the hub ledger fail-fasts on a malformed gift_category (no silent hide)');
  // Actor gate: an active hub conversation (the guide accepts the gift via its routing_hub snapshot). Category gate:
  // only the affinity `gift` category is deliverable to the guide — ally_boost is excluded (it 400s), so the
  // server-authoritative annotation must be exactly 'gift', not merely non-null (which the daytime side allows).
  assert.match(fn, /if \(isRoutingHubActive\(\) && item\.gift_category === 'gift'\) \{\s*row\.append\(routingHubGiftAction\(item\)\);/, 'the 渡す button is gated by an active hub conversation + a gift-category item (ally_boost excluded)');
});

test('renderRoutingHubInventoryInto no longer composes an alchemy-book gift map', async () => {
  const js = await readApp();
  const fn = js.match(/function renderRoutingHubInventoryInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  // Deliverable eligibility arrives with the inventory payload (server-authoritative gift_category), so there is no
  // lazy alchemy-book load / drawer re-render dance anymore.
  assert.doesNotMatch(fn, /loadGiftableItemCategories/, 'no alchemy-book gift-map load in the hub inventory render');
});

test('routingHubGiftAlreadyGiven is keyed on the hub conversation id', async () => {
  const js = await readApp();
  const fn = js.match(/function routingHubGiftAlreadyGiven\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  // The gate compares the delivered key to the LIVE hub conversation id (not the daytime last_conversation_id), so
  // it resets by itself when the next hub conversation starts.
  assert.match(fn, /return isRoutingHubActive\(\) && giftGivenConversationId === routingHubConversationId;/, 'already-given compares the delivered key to the live hub conversation id');
});

test('routingHubGiftAction carries the ledger-give class, the 渡す label, and disables once given', async () => {
  const js = await readApp();
  const fn = js.match(/function routingHubGiftAction\(item\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /give\.className = 'routing-hub-info-ledger-give';\s*give\.textContent = '渡す';/, 'the button carries the routing ledger-give class and the 渡す label');
  assert.match(fn, /const alreadyGiven = routingHubGiftAlreadyGiven\(\);\s*give\.disabled = alreadyGiven;/, 'the button disables once a gift has been delivered this hub conversation');
  assert.match(fn, /give\.addEventListener\('click', \(\) => handleRoutingHubGift\(item\)\.catch\(reportError\)\);/, 'clicking hands the owned item over');
});

test('handleRoutingHubGift confirms, posts, reveals on the hub stage, toasts the effect, and guards double-fire', async () => {
  const js = await readApp();
  const fn = js.match(/async function handleRoutingHubGift\(item\)[\s\S]*?\n\}/)?.[0] ?? '';
  // Single-flight: a turn in flight or a gift in flight shows the processing toast and returns (shared guards with
  // the daytime gift — a gift never overlaps a hub turn).
  assert.match(fn, /if \(conversationRequestInFlight \|\| conversationGiftInFlight\) \{\s*showProcessingToast\(\);\s*return;/, 'a double gift / overlapping turn is blocked by the shared + dedicated in-flight guards');
  // Defensive re-check of the render gate before the network call (stale click across a conversation change).
  assert.match(fn, /if \(!isRoutingHubActive\(\) \|\| routingHubGiftAlreadyGiven\(\)\) return;/, 'the gate is re-checked before the POST');
  // Confirm with the guide's variant name (activeCharacter is the routing persona while hub-active) + the item name.
  assert.match(fn, /const partnerName = activeCharacter\(\)\.display_name;/, 'the confirm names the current hub partner (the routing persona guide)');
  assert.match(fn, /if \(!window\.confirm\(`「\$\{item\.name\}」を\$\{partnerName\}に渡しますか？`\)\) return;/, 'a confirm names the partner + item');
  // The gift closes the drawer so the reaction is visible on the hub stream, then posts by item id (conversation id
  // is resolved server-side from runtime_state).
  assert.match(fn, /routingHubStage\.closeInfo\(\);/, 'the drawer closes so the reaction is visible on the hub stream');
  assert.match(fn, /await postJson\('\/api\/conversation\/gift', \{ item_id: item\.item_id \}\)/, 'the POST sends only item_id (server resolves the active hub conversation)');
  // Authoritative inventory + state adoption, the 1会話1回 key stamp (the hub conversation id), the reveal, the toast.
  assert.match(fn, /currentInventory = result\.inventory;/, 'inventory is replaced with the authoritative post-consumption data');
  assert.match(fn, /giftGivenConversationId = routingHubConversationId;/, 'the delivered-conversation key is stamped with the hub conversation id so the affordance disables');
  assert.match(fn, /await revealRoutingHubGift\(result\);\s*showEconomyMessage\(conversationGiftEffectMessage\(result\)\);/, 'the reaction reveals then the effect toasts (shared effect message helper)');
  // Errors: keep the settings-redirect behavior, else surface the gift message on the hub error banner.
  assert.match(fn, /if \(handleRuntimeApiError\(error, \{ allowSettingsRedirect: true \}\)\) return;\s*routingHubStage\.setStatus\(conversationGiftErrorMessage\(error\), \{ tone: 'error' \}\);/, 'settings-redirect stays unchanged; other errors show on the hub error banner');
});

test('revealRoutingHubGift appends the handover 地の文 + reaction on the hub stage matching the record shape', async () => {
  const js = await readApp();
  const fn = js.match(/async function revealRoutingHubGift\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /const reactionText = String\(result\?\.reaction_text \?\? ''\)\.trim\(\);\s*if \(!reactionText\) throw new Error/, 'an empty reaction is a broken response → fail fast');
  assert.match(fn, /const handover = \{ role: 'user', content: conversationGiftHandoverNarrationText\(result\.item\.name\) \};/, 'the hand-over 地の文 is a user-role message (matches the record, shared handover text)');
  // The reaction carries NO emotion field — the renderer defaults a missing emotion to neutral.
  assert.match(fn, /const reaction = \{\s*role: 'assistant',\s*\.\.\.routingHubStage\.surface\.assistantIdentity\(\),\s*content: reactionText\s*\};/, 'the reaction is an assistant message on the hub stage identity with no forced emotion');
  assert.doesNotMatch(fn, /face_emotion_variant_id/, 'the reaction never pins an emotion icon literal');
  // The two segments reveal through the hub stage's own cooldown-paced queue, then its canonical history is set —
  // the shared academy chat is never touched (clean-chat).
  assert.match(fn, /const reveal = routingHubStage\.createTurnReveal\(baseMessages\);\s*reveal\.enqueue\(displayMessages\(\[handover\]\)\);\s*reveal\.enqueue\(displayMessages\(\[reaction\]\)\);\s*await reveal\.drain\(\);/, 'both bubbles reveal one 吹き出し単位 at a time on the hub stage queue');
  assert.match(fn, /routingHubStage\.surface\.setHistory\(\[\.\.\.baseMessages, handover, reaction\]\);/, 'the hub canonical history is base + handover + reaction (byte-identical to the next commitState rebuild)');
  assert.doesNotMatch(fn, /\bmessageHistory\b|academyChatSurface/, 'the hub gift reveal never reads or writes the shared academy chat (clean-chat)');
});

test('style.css skins the hub 渡す ledger CTA in the routing token layer', async () => {
  const css = await readCss();
  assert.match(css, /\.routing-hub-info-ledger-give \{[\s\S]*?background: var\(--routing-panel-strong\);[\s\S]*?color: var\(--routing-silver-strong\);/, 'the CTA uses the routing deep-night silver tokens (no literal color pin)');
  assert.doesNotMatch(css.match(/\.routing-hub-info-ledger-give \{[^}]*\}/)?.[0] ?? '', /rgb\(|#[0-9a-fA-F]{3,8}/, 'the hub give CTA carries no literal color pin (--routing-* token-only)');
  assert.match(css, /\.routing-hub-info-ledger-give:disabled \{[\s\S]*?opacity: 0\.5;[\s\S]*?cursor: default;/, 'the disabled (already-given) state is dimmed and non-interactive');
});
