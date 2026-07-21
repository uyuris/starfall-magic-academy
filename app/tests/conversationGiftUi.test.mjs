// Daytime 渡す (会話中の贈与) use-UI contract (source-regex): the deliverable-item classification from the
// server-authoritative `items[].gift_category` annotation, the render gate (routing mode + selectable partner +
// deliverable category + 1会話1回), the confirm → POST /api/conversation/gift → reaction reveal → effect toast
// flow, the in-flight guard, and the 503-unconsumed / settings-redirect error grammar. Real Blink layout + the
// interactive gift flow are verified separately by the render harness app/tests/manual/conversationGiftRender.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');
const readApp = () => readFile(path.join(publicRoot, 'app.js'), 'utf8');
const readCss = () => readFile(path.join(publicRoot, 'style.css'), 'utf8');

test('app.js declares the gift client state and no longer composes an alchemy-book gift map', async () => {
  const js = await readApp();
  // Deliverable eligibility is the server-authoritative gift_category annotation — the client no longer holds a
  // parallel item→category cache composed from the alchemy book.
  assert.doesNotMatch(js, /giftableItemCategoryById/, 'the frontend gift-map cache is gone (server-authoritative gift_category)');
  assert.doesNotMatch(js, /loadGiftableItemCategories/, 'the alchemy-book gift-map loader is gone');
  assert.doesNotMatch(js, /const CONVERSATION_GIFT_CATEGORIES/, 'the frontend deliverable-category vocabulary is gone');
  // The 1会話1回 conversation key and the POST guard remain.
  assert.match(js, /let giftGivenConversationId = null;/, 'the delivered-conversation key exists');
  assert.match(js, /let conversationGiftInFlight = false;/, 'the single-flight POST guard exists');
});

test('app.js gates the 渡す affordance on routing mode + a selectable roster partner + the 1会話1回 key', async () => {
  const js = await readApp();
  // Actor gate: routing mode AND the partner is in the selectable roster (excludes lina / creature / homunculus,
  // none of which are in the roster) — the client mirror of the backend GIFT_ACTOR_NOT_SELECTABLE / routing gate.
  assert.match(js, /function conversationGiftEligibleActor\(\) \{\s*return currentPlayMode === 'routing'\s*&& selectableCharacters\.some\(\(character\) => character\.character_id === activeCharacterId\);/, 'the actor gate requires routing mode + a selectable roster partner');
  // The already-given gate is keyed on the active conversation id, so it resets by itself on the next conversation.
  assert.match(js, /function currentDaytimeConversationId\(\) \{\s*return String\(currentRuntimeState\?\.last_conversation_id \?\? ''\)\.trim\(\);/, 'the conversation id reads runtime_state.last_conversation_id');
  assert.match(js, /function conversationGiftAlreadyGiven\(\) \{[\s\S]*?giftGivenConversationId === conversationId;/, 'already-given compares the delivered key to the current conversation id');
});

test('renderConversationDayInventoryInto gates 渡す on the server-authoritative gift_category (deliverable = non-null)', async () => {
  const js = await readApp();
  const fn = js.match(/function renderConversationDayInventoryInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  // gift_category is a required annotated field ('gift' | 'ally_boost' | null) — a malformed value is broken wiring.
  assert.match(fn, /item\.gift_category !== null && item\.gift_category !== 'gift' && item\.gift_category !== 'ally_boost'[\s\S]*?throw new Error/, 'the ledger fail-fasts on a malformed gift_category (no silent hide)');
  // The button is shown for an eligible actor whenever this owned item is a deliverable category (non-null).
  assert.match(fn, /if \(conversationGiftEligibleActor\(\) && item\.gift_category !== null\) \{/, 'the 渡す button is gated by the actor gate + a deliverable gift_category');
  assert.match(fn, /give\.className = 'conversation-day-info-ledger-give';\s*give\.textContent = '渡す';/, 'the button carries the ledger-give class and the 渡す label');
  // Disabled by the 1会話1回 gate; click hands the owned item over.
  assert.match(fn, /const alreadyGiven = conversationGiftAlreadyGiven\(\);\s*give\.disabled = alreadyGiven;/, 'the button disables once a gift has been delivered this conversation');
  assert.match(fn, /give\.addEventListener\('click', \(\) => handleConversationDayGift\(item\)\.catch\(reportError\)\);/, 'clicking hands the owned item over');
  // No lazy alchemy-book load remains — the annotation arrives with the inventory payload.
  assert.doesNotMatch(fn, /loadGiftableItemCategories/, 'no alchemy-book gift-map load in the daytime ledger');
});

test('handleConversationDayGift confirms, posts, reveals, toasts the effect, and guards double-fire', async () => {
  const js = await readApp();
  const fn = js.match(/async function handleConversationDayGift\(item\)[\s\S]*?\n\}/)?.[0] ?? '';
  // Single-flight: a turn in flight or a gift in flight shows the processing toast and returns.
  assert.match(fn, /if \(conversationRequestInFlight \|\| conversationGiftInFlight\) \{\s*showProcessingToast\(\);\s*return;/, 'a double gift / overlapping turn is blocked by the shared + dedicated in-flight guards');
  // Defensive re-check of the render gate before the network call (stale click across a conversation change).
  assert.match(fn, /if \(!conversationGiftEligibleActor\(\) \|\| conversationGiftAlreadyGiven\(\)\) return;/, 'the gate is re-checked before the POST');
  // Confirm with the partner name + the item name.
  assert.match(fn, /if \(!window\.confirm\(`「\$\{item\.name\}」を\$\{partnerName\}に渡しますか？`\)\) return;/, 'a confirm names the partner + item');
  // The gift closes the drawer so the reaction is visible on the stream, then posts by item id (conversation id
  // is resolved server-side).
  assert.match(fn, /conversationDayStage\.closeInfo\(\);/, 'the drawer closes so the reaction is visible on the stream');
  assert.match(fn, /await postJson\('\/api\/conversation\/gift', \{ item_id: item\.item_id \}\)/, 'the POST sends only item_id (server resolves the active conversation)');
  // Authoritative inventory + state adoption, the 1会話1回 key stamp, the reveal, and the effect toast.
  assert.match(fn, /currentInventory = result\.inventory;/, 'inventory is replaced with the authoritative post-consumption data');
  assert.match(fn, /giftGivenConversationId = currentDaytimeConversationId\(\);/, 'the delivered-conversation key is stamped so the affordance disables');
  assert.match(fn, /await revealConversationDayGift\(result\);\s*showEconomyMessage\(conversationGiftEffectMessage\(result\)\);/, 'the reaction reveals then the effect toasts');
  // Errors: keep the settings-redirect behavior, else surface the gift message on the daytime status line.
  assert.match(fn, /if \(handleRuntimeApiError\(error, \{ allowSettingsRedirect: true \}\)\) return;\s*conversationDayStage\.setStatus\(conversationGiftErrorMessage\(error\), \{ tone: 'error' \}\);/, 'settings-redirect stays unchanged; other errors show on the daytime status line');
});

test('revealConversationDayGift appends the handover 地の文 + reaction matching the record shape', async () => {
  const js = await readApp();
  const fn = js.match(/async function revealConversationDayGift\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /const reactionText = String\(result\?\.reaction_text \?\? ''\)\.trim\(\);\s*if \(!reactionText\) throw new Error/, 'an empty reaction is a broken response → fail fast');
  assert.match(fn, /const handover = \{ role: 'user', content: conversationGiftHandoverNarrationText\(result\.item\.name\) \};/, 'the hand-over 地の文 is a user-role message (matches the record)');
  // The reaction carries NO emotion field — the renderer defaults a missing emotion to neutral, so it renders
  // like the emotion-less record message without forcing the guarded face_neutral literal.
  assert.match(fn, /const reaction = \{\s*role: 'assistant',\s*\.\.\.conversationDayStage\.surface\.assistantIdentity\(\),\s*content: reactionText\s*\};/, 'the reaction is an assistant message with no forced emotion (renderer defaults to neutral)');
  assert.doesNotMatch(fn, /face_emotion_variant_id/, 'the reaction never pins an emotion icon literal (respects the streaming-bubble emotion guard)');
  // The two segments reveal through the shared cooldown-paced queue, then the canonical history is set.
  assert.match(fn, /const reveal = conversationDayStage\.createTurnReveal\(baseMessages\);\s*reveal\.enqueue\(displayMessages\(\[handover\]\)\);\s*reveal\.enqueue\(displayMessages\(\[reaction\]\)\);\s*await reveal\.drain\(\);/, 'both bubbles reveal one 吹き出し単位 at a time on the shared cadence');
  assert.match(fn, /conversationDayStage\.surface\.setHistory\(\[\.\.\.baseMessages, handover, reaction\]\);/, 'the canonical history is base + handover + reaction (byte-identical to the next commitState rebuild)');
  // The reproduced fixed handover line mirrors the backend narration exactly.
  assert.match(js, /function conversationGiftHandoverNarrationText\(itemName\)[\s\S]*?return `主人公が「\$\{name\}」を差し出した。`;/, 'the handover text mirrors the backend fixed 地の文');
});

test('conversationGiftEffectMessage covers both categories and fails fast on an unknown one', async () => {
  const js = await readApp();
  const fn = js.match(/function conversationGiftEffectMessage\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  // gift → 好感度 before→after (+bonus), validated numeric.
  assert.match(fn, /if \(item\.category === 'gift'\) \{[\s\S]*?typeof effect\.affinity_after !== 'number'[\s\S]*?throw new Error/, 'gift validates numeric affinity fields (no silent skip)');
  assert.match(fn, /好感度 \$\{effect\.affinity_before\} → \$\{effect\.affinity_after\}（\+\$\{effect\.bonus\}）/, 'gift shows 好感度 before → after (+bonus)');
  // ally_boost → each parameter label before→after (+amount), validated non-empty.
  assert.match(fn, /if \(item\.category === 'ally_boost'\) \{[\s\S]*?!Array\.isArray\(effect\.parameter_effects\)[\s\S]*?throw new Error/, 'ally_boost validates a non-empty parameter_effects array');
  assert.match(fn, /effect\.parameter_effects\.map\(\(entry\) => `\$\{entry\.label\} \$\{entry\.before\} → \$\{entry\.after\}（\+\$\{entry\.amount\}）`\)/, 'ally_boost shows each parameter label before → after (+amount)');
  assert.match(fn, /throw new Error\(`unexpected gift item category/, 'an unknown category is a contract break → throw');
});

test('conversationGiftErrorMessage gives the 503 unconsumed line and keeps the existing grammar otherwise', async () => {
  const js = await readApp();
  const fn = js.match(/function conversationGiftErrorMessage\(error\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /error\?\.errorCode === 'GIFT_REACTION_GENERATION_FAILED'/, 'the 503 generation failure is matched by its code');
  assert.match(fn, /アイテムは消費していません/, 'the 503 line states the item was not consumed (retryable)');
  assert.match(fn, /return errorDisplayMessage\(error\);/, 'every other error keeps the existing conversation error grammar');
});

test('style.css skins the 渡す ledger CTA in the 黒夜 amber token layer', async () => {
  const css = await readCss();
  assert.match(css, /\.conversation-day-info-ledger-give \{[\s\S]*?background: linear-gradient\(180deg, var\(--cd-night-amber-soft\), var\(--cd-night-panel-strong\)\);[\s\S]*?color: var\(--cd-night-ink-strong\);/, 'the CTA uses the daytime amber lamplight tokens (no literal color pin)');
  assert.match(css, /\.conversation-day-info-ledger-give:disabled \{[\s\S]*?opacity: 0\.5;[\s\S]*?cursor: default;/, 'the disabled (already-given) state is dimmed and non-interactive');
});
