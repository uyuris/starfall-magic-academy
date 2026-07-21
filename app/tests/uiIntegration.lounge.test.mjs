import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// Extract a top-level `function name(...) { ... }` body from app.js (brace-matched), so an assertion targets one
// function without matching an unrelated line elsewhere (the routing-suite helper).
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

test('the lounge is a dedicated conversation-day-family screen with a stage image, chat panel, composer, and speaker popups (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const block = html.match(/<section id="academy-lounge-screen"[\s\S]*?<\/section>\s*\n\s*<\/main>/)?.[0]
    ?? html.match(/<section id="academy-lounge-screen"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #academy-lounge-screen section should exist');
  // Reuses the daytime 黒夜 token layer + presentation (conversation-day-screen host class) — the taste is the
  // conversation-day content screen's, not a forked token set (M-2026-07-04-001 conversation-day norm).
  assert.match(block, /class="screen conversation-day-screen academy-lounge-screen"/, 'the lounge reuses the conversation-day 黒夜 token/presentation layer via the shared host class');
  // conversation-day themed backdrop + ambient + topbar week/moon.
  assert.match(block, /id="academy-lounge-motes"/, 'the lounge has its own daytime-motes ambient canvas');
  assert.match(block, /id="academy-lounge-week"/, 'the lounge shows the week');
  assert.match(block, /id="academy-lounge-moon-phase"/, 'the lounge shows the moon phase');
  // Stage frame (寮の談話室 舞台画像, clickable → stage detail).
  assert.match(block, /<button type="button" id="academy-lounge-stage-image"/, 'the lounge has a clickable stage image');
  // Chat panel: streamed multi-speaker messages + status (error banner only).
  assert.match(block, /id="academy-lounge-message-stream"[^>]*aria-live="polite"/, 'the lounge chat has its own live message stream');
  assert.match(block, /<p id="academy-lounge-status"[^>]*aria-live="polite" hidden>/, 'the lounge chat has its own status live region, hidden by default (error banner only)');
  // Composer: a text input (round-closing player turn) + 送信 + 退出.
  assert.match(block, /<textarea id="academy-lounge-input"/, 'the lounge composer is a text input for the player round-closing turn');
  assert.match(block, /id="academy-lounge-send"[\s\S]*?id="academy-lounge-end"/, 'the composer carries a 送信 and an explicit 退出 (end) control');
  // Stage detail popup (authored scene) + clicked-speaker character popup.
  assert.match(block, /id="academy-lounge-stage-popup"[^>]*hidden/, 'the stage-detail popup exists, hidden by default');
  assert.match(block, /id="academy-lounge-stage-popup-text"/, 'the stage-detail popup shows the authored visible_situation text');
  assert.match(block, /id="academy-lounge-character-popup"[^>]*hidden/, 'the clicked-speaker character popup exists, hidden by default');
  assert.match(block, /id="academy-lounge-character-popup-standee"/, 'the character popup shows the participant standee');
  assert.match(block, /id="academy-lounge-character-popup-parameters"/, 'the character popup shows the participant parameters');
});

// ── dispatch mirror (routingDispatchClient.js) ───────────────────────────────

test('the frontend dispatch mirror maps the lounge destination to the lounge screen', async () => {
  const js = await readFile(path.join(root, 'routingDispatchClient.js'), 'utf8');
  assert.match(js, /lounge: 'academy-lounge'/, 'the dispatch mirror maps lounge → academy-lounge (mirrors the backend routingDispatch)');
});

// ── app.js wiring ────────────────────────────────────────────────────────────

test('the lounge screen is registered and entered through showScreen (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /'academy-lounge': document\.querySelector\('#academy-lounge-screen'\)/, 'the screen is in the screens registry');
  const showScreen = appFunction(js, 'showScreen');
  assert.match(showScreen, /name === 'academy-lounge'\) enterLoungeScreen\(\)\.catch\(reportLoungeScreenError\)/, 'showScreen enters the lounge on show');
  assert.match(showScreen, /name !== 'academy-lounge'\) loungeStage\.stopAmbient\(\)/, 'showScreen stops the lounge ambient when leaving');
});

test('the lounge stage image points at the dedicated 寮の談話室 asset, not a shared stand-in (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /const LOUNGE_STAGE_IMAGE_URL = '\/canonical\/lounge\/stage\.jpg';/, 'the lounge uses its own dedicated stage art');
  assert.doesNotMatch(js, /LOUNGE_STAGE_IMAGE_URL = '\/canonical\/conversation_day\/background\.jpg'/, 'no stand-in reference to the shared conversation-day background remains on the lounge path');
});

test('the lounge builds a conversation-day-themed stage over its own selectors (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const stageBlock = js.match(/const loungeStage = createConversationStage\(\{[\s\S]*?\n\}, \{[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.notEqual(stageBlock, '', 'loungeStage is built through the shared createConversationStage');
  assert.match(stageBlock, /screenSelector: '#academy-lounge-screen'/, 'the stage is scoped to the lounge screen');
  assert.match(stageBlock, /streamSelector: '#academy-lounge-message-stream'/, 'the stage owns the lounge message stream');
  assert.match(stageBlock, /controlSelectors: \['#academy-lounge-input', '#academy-lounge-send', '#academy-lounge-end'\]/, 'the stage disables the input + send + end together during NPC responses');
  assert.match(stageBlock, /createConversationDayAmbient\(\{ canvasSelector: '#academy-lounge-motes'/, 'the lounge reuses the conversation-day light-motes ambient (daytime taste)');
  // The group mapper (not the 1:1 messagesFromConversation) is injected so per-message speaker identity survives.
  assert.match(stageBlock, /messagesFromConversation: loungeMessagesFromConversation/, 'the stage is fed the group-aware message mapper, not the 1:1 re-labeling one');
});

test('the group message mapper keeps each assistant bubble its OWN speaker identity (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const mapper = appFunction(js, 'loungeMessagesFromConversation');
  // The 1:1 messagesFromConversation re-labels every assistant to activeCharacterId; the group mapper must read
  // the per-message identity instead (the multi-speaker fix).
  assert.match(mapper, /character_id: message\.character_id/, 'each assistant keeps its own character_id');
  assert.match(mapper, /character_name: message\.character_name/, 'each assistant keeps its own character_name');
  assert.doesNotMatch(mapper, /activeCharacterId/, 'the group mapper never re-labels a bubble to one active character');
  // createMessageRows carries the identity onto the row so a click can resolve WHICH participant it is.
  const rows = appFunction(js, 'createMessageRows');
  assert.match(rows, /row\.dataset\.characterId = message\.character_id \?\? activeCharacterId/, 'character rows carry data-character-id so a group consumer can resolve the clicked speaker');
});

test('the lounge streams NPC utterances per-utterance and honours the server cursor (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const reader = appFunction(js, 'readLoungeUtteranceSse');
  assert.match(reader, /'\/api\/lounge\/utterance\/stream'/, 'the reader posts to the per-utterance SSE route');
  assert.match(reader, /event === 'assistant_emotion'/, 'the reader forwards the chosen emotion (per-NPC face)');
  assert.match(reader, /event === 'result'/, 'the reader captures the authoritative result (speaker + advanced conversation view)');
  const reveal = appFunction(js, 'revealLoungeUtterance');
  assert.match(reveal, /round_number: cursor\.round_number, next_speaker_index: cursor\.next_speaker_index/, 'each utterance request carries the client cursor for the server to re-validate');
  // Completion reconcile adopts the server-authoritative history into BOTH the surface state AND the DOM (setHistory
  // alone leaves the just-revealed rows in the DOM), so a completed turn's faces match the record immediately.
  assert.match(reveal, /const authoritative = loungeMessagesFromConversation\(result\.conversation\);/, 'the reconcile derives the server-authoritative history once');
  assert.match(reveal, /loungeStage\.surface\.setHistory\(authoritative\);\s*\n\s*loungeStage\.renderStream\(authoritative\);/, 'after the reveal the stage adopts the authoritative view into state AND re-renders the DOM');
});

// The face-emotion-order contract: emotion is confirmed before any bubble reveals and is immutable for the turn, so
// every assistant segment of one utterance — including a 括弧分割 that yields two face rows — is built from the SAME
// emotion. There is no neutral fallback anywhere on the reveal path; content before a confirmed emotion fails fast.
// (jsdom cannot render app.js's live shell — see ref-camera.md / the settings-screen test precedent — so the
// two-face-row visual is pinned here structurally: a single immutable turnEmotion feeds every segment, and
// displayMessages spreads that emotion onto each split assistant row.)
test('one utterance builds every reveal segment from a single immutable, confirmed emotion (no neutral fallback, fail-fast) (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const reveal = appFunction(js, 'revealLoungeUtterance');
  // The turn emotion starts unconfirmed and is set ONLY inside the assistant_emotion handler (immutable thereafter).
  assert.match(reveal, /let turnEmotion = null;/, 'the turn emotion starts unconfirmed');
  assert.match(reveal, /onEmotion: \(chosen\) => \{[\s\S]*?turnEmotion = chosen;/, 'the emotion is confirmed from the assistant_emotion event');
  assert.match(reveal, /onEmotion: \(chosen\) => \{[\s\S]*?if \(turnEmotion\) throw/, 'a second assistant_emotion is a protocol violation (fail-fast)');
  // Every reveal segment is built from that single confirmed emotion (so a 括弧分割 shares one face across rows).
  assert.match(reveal, /displayMessages\(\[loungeMessage\(speaker, text, turnEmotion\)\]\)/, 'reveal segments are built from the one immutable turn emotion');
  // Assistant content before the emotion is confirmed fails fast — no neutral continuation.
  assert.match(reveal, /if \(!turnEmotion\) throw new Error\([^)]*protocol violation/, 'content before a confirmed emotion fails fast (no neutral fallback)');
  assert.doesNotMatch(reveal, /neutral/, 'the reveal path carries no neutral fallback');
  // loungeMessage itself requires a confirmed emotion — the neutral default/fallback is gone.
  const message = appFunction(js, 'loungeMessage');
  assert.match(message, /function loungeMessage\(speaker, content, emotion\)/, 'loungeMessage takes a required emotion (no default)');
  assert.match(message, /throw new Error\([^)]*confirmed emotion/, 'loungeMessage fails fast on a missing emotion');
  assert.doesNotMatch(message, /neutral/, 'loungeMessage has no neutral fallback');
  // The authoritative mapper also rejects (does not mask) a malformed assistant message missing its emotion.
  const mapper = appFunction(js, 'loungeMessagesFromConversation');
  assert.match(mapper, /is missing emotion fields/, 'the authoritative mapper rejects a malformed emotion-less assistant message');
  assert.doesNotMatch(mapper, /'neutral'|'face_neutral'/, 'the authoritative mapper has no neutral fallback');
});

test('the lounge is round-driven: NPCs stream with the input closed, then the player turn opens (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const drive = appFunction(js, 'runLoungeConversation');
  assert.match(drive, /while \(loungeConversation\.next_speaker\)/, 'NPC utterances stream while the server cursor names a next speaker');
  assert.match(drive, /loungeStage\.setControlsDisabled\(true\)/, 'the input is closed while NPCs respond');
  assert.match(drive, /await runLoungePlayerTurn\(\)/, 'the player turn opens at the round boundary');
  assert.match(drive, /if \(outcome\.ended\) return/, 'an explicit end leaves the round loop');
  const playerTurn = appFunction(js, 'runLoungePlayerTurn');
  assert.match(playerTurn, /loungeStage\.setControlsDisabled\(false\)/, 'the player turn re-opens the input');
  const submit = appFunction(js, 'submitLoungePlayerTurn');
  assert.match(submit, /'\/api\/lounge\/player-turn'/, 'the player round-closing turn posts to the player-turn route');
});

test('the lounge enters under a loading cover and ends through the content-return (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const session = appFunction(js, 'runLoungeSession');
  assert.match(session, /postJson\('\/api\/lounge\/enter'/, 'the session posts the enter route');
  assert.match(session, /showAcademyLoadingScreenUntilReady\(\{[\s\S]*?nextScreen: 'academy-lounge'/, 'the entry wait is covered by the loading screen (M-2026-07-06-001)');
  assert.match(session, /onFirstStreamStart: markOpeningStarted/, 'the loading cover releases on the first NPC utterance stream');
  const exit = appFunction(js, 'exitLounge');
  assert.match(exit, /postJson\('\/api\/lounge\/end'/, 'the explicit end posts the end route (aggregate finalization + content result)');
  assert.match(exit, /returnToRoutingHubFromContent\(result\.post_content_screen\)/, 'ending returns to the routing hub through the shared content-return');
});

test('the clicked speaker popup resolves off the clicked row data-character-id (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /document\.querySelector\('#academy-lounge-message-stream'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?event\.target\.closest\('\.chat-message'\)[\s\S]*?row\.dataset\.characterId[\s\S]*?openLoungeCharacterPopup\(row\.dataset\.characterId\)/, 'clicking a bubble opens the CLICKED participant, resolved from the row data-character-id (not one active character)');
});

// ── CSS ──────────────────────────────────────────────────────────────────────

test('the lounge screen gets the full-viewport layout constraint and a [hidden] popup guard (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');
  assert.match(css, /body:has\(#academy-lounge-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 0px\)\)/, 'the lounge is a full-screen play surface so the chat scroll absorbs into a fixed height (the daytime constraint)');
  assert.match(css, /#academy-lounge-screen \[hidden\] \{\s*display: none;/, 'the lounge popups honour the UA [hidden] rule over any display rule');
});
