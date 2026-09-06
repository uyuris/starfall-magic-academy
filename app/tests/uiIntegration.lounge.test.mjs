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
// (jsdom cannot render app.js's live shell — see the settings-screen test precedent — so the
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
  // v2 契約 (Stage 3): the depart turn's 2nd message also uses this same immutable emotion — the reveal builds
  // displayMessages([...committed, loungeMessage(speaker, text, turnEmotion)]) so the in-progress message's face
  // matches the previously committed message's face on the same turn (both continue and depart messages share it).
  assert.match(reveal, /displayMessages\(\[\.\.\.committed, loungeMessage\(speaker, text, turnEmotion\)\]\)/, 'reveal segments are built from the one immutable turn emotion, spread onto every message the turn commits (continue message + depart message on the depart turn)');
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

test('the lounge is round-driven: NPCs stream with the input closed, then the player turn opens; an auto-completion result exits before the player turn (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const drive = appFunction(js, 'runLoungeConversation');
  assert.match(drive, /while \(loungeConversation\.next_speaker\)/, 'NPC utterances stream while the server cursor names a next speaker');
  assert.match(drive, /loungeStage\.setControlsDisabled\(true\)/, 'the input is closed while NPCs respond');
  assert.match(drive, /await runLoungePlayerTurn\(\)/, 'the player turn opens at the round boundary');
  assert.match(drive, /if \(outcome\.ended\) return/, 'an explicit end leaves the round loop');
  // v2 契約 (Stage 3): if a terminal utterance result carries finalization_status, the round loop returns to the
  // auto-completion handoff BEFORE opening the player turn (the all-exited path never opens the player input).
  // Presence is checked with `'finalization_status' in result` — silent推測 fallback にしない.
  assert.match(drive, /if \('finalization_status' in result\) \{\s*\n\s*await runLoungeAutoCompletion\(result\);\s*\n\s*return;\s*\n\s*\}/, 'an all-exited auto completion is detected on the terminal utterance result and hands off to runLoungeAutoCompletion before the player turn opens');
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
  // Both the explicit exit and the auto path go through the shared promoteLoungeCompletion helper so the frontend
  // has a SINGLE hub-return path for lounge completion (returnToRoutingHubFromContent lives inside the shared
  // helper — see the promoteLoungeCompletion test below).
  assert.match(exit, /await promoteLoungeCompletion\(result\);/, 'the explicit end delegates strict-validate + adopt + hub return to the shared completion helper');
});

// The lounge exit's loading-cover contract: mirrors the 1:1 routing end (endRoutingConversation). The
// /api/lounge/end request — which drains the 3-participant aggregate finalization server-side — is the loading
// screen's readiness, so the whole finalization is covered by the shared academy-loading interstitial from the
// moment 退出 is pressed (M-2026-07-06-001), rather than stranding the player on the lounge screen while the
// longest post-processing block runs. The result is awaited AFTER the loader is up, strict-validated (no
// default-value fallback for state / next_screen / post_content_screen), and handed off to the shared content
// return which keeps the loader running through the hub start.
test('lounge exit covers the aggregate-finalization drain with the loading screen and delegates strict-validate + hub return to the shared helper (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const exit = appFunction(js, 'exitLounge');
  // The end request is captured as a promise BEFORE the loader is shown, and that same promise is the loader
  // readiness (readiness = endRequest, nextScreen: null) — matches endRoutingConversation's contract.
  assert.match(exit, /const endRequest = postJson\('\/api\/lounge\/end', \{ id: loungeConversation\.id \}\);/, 'the end request is captured as a promise (not awaited) before the loader');
  assert.match(exit, /await showAcademyLoadingScreenUntilReady\(\{\s*\n\s*readiness: endRequest,\s*\n\s*nextScreen: null,\s*\n\s*refreshBeforeNextScreen: false,\s*\n\s*loadingCopy: ROUTING_EXIT_DRAIN_LOADING_COPY\s*\n\s*\}\);/, 'the loading screen covers the whole aggregate-finalization drain (readiness = the end request, no target screen — the shared completion helper owns the switch)');
  // Result is awaited AFTER the loader is up.
  assert.match(exit, /await showAcademyLoadingScreenUntilReady\([\s\S]*?\}\);\s*\n\s*const result = await endRequest;/, 'the end response is awaited only after the loading screen is up');
  // Strict-validate + adopt + hub return is delegated to the shared promoteLoungeCompletion helper — both the
  // explicit exit and the auto (all-exited) path go through it, so the frontend has ONE hub-return path for lounge
  // completion (Stage 3 acceptance: no duplicated completion path).
  assert.match(exit, /await promoteLoungeCompletion\(result\);/, 'exitLounge delegates the strict-validate + adopt + hub return to the shared completion helper');
  // The strict-validate contract lives in assertLoungeCompletion (split from promoteLoungeCompletion so callers
  // can validate BEFORE raising any loading cover — a malformed payload rejects without wasting a full drain
  // cover cycle on state that is about to be rejected). promoteLoungeCompletion delegates to it and then adopts
  // + hands off.
  const validate = appFunction(js, 'assertLoungeCompletion');
  assert.match(validate, /completion\.finalization_status !== 'completed'/, 'finalization_status must be completed');
  assert.match(validate, /completion\.transition\?\.next_screen !== 'interaction'/, 'transition.next_screen must be interaction');
  assert.match(validate, /completion\.post_content_screen !== 'interaction'/, 'post_content_screen must be interaction');
  assert.match(validate, /!completion\.state \|\| typeof completion\.state !== 'object'/, 'the post-finalize state must be present and an object');
  // No default-value fallback on runtime state (the M-2026-07-06-001 investigation flagged this — the malformed
  // success ?? currentRuntimeState continuation is gone).
  assert.doesNotMatch(validate, /completion\.state \?\? currentRuntimeState/, 'no default-value fallback for the post-finalize state (fail-fast instead of continuing on pre-finalization state)');
  const promote = appFunction(js, 'promoteLoungeCompletion');
  assert.match(promote, /assertLoungeCompletion\(completion\);/, 'the shared helper delegates strict validation to assertLoungeCompletion');
  assert.match(promote, /currentRuntimeState = completion\.state;/, 'the helper adopts the post-finalize state');
  assert.match(promote, /loungeStage\.stopAmbient\(\);/, 'the helper stops the ambient before the hub return');
  // Loader → hub handoff continues through the shared content return (starfield/constellation are preserved across
  // the loader → loader re-show — the continuous cover survives the handoff).
  assert.match(promote, /await returnToRoutingHubFromContent\(completion\.post_content_screen\);/, 'the helper hands off through the shared content return, keeping the loader up');
});

// Error un-strand contract: the failure branches split on where the failure landed. Pre-atomic-promote (endRequest
// reject) restores the lounge for retry (finalizer discarded staging, so nothing is written); post-atomic-promote
// (validation or hub-start after endRequest resolves) un-strands to the routing hub instead — the marker is written
// and the finalizer would reject a re-finalization. Settings-redirect errors are owned by the shared loader helper.
test('lounge exit un-strands to the lounge on pre-promote failure and to the hub on post-promote failure (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const exit = appFunction(js, 'exitLounge');
  // Endstate flag flips only after the response is captured and before the strict validation runs, so a validation
  // throw is treated as post-promote and a request reject as pre-promote.
  assert.match(exit, /const result = await endRequest;\s*\n\s*endResolved = true;/, 'endResolved flips right after the response is captured (before strict validation) so validation throws are post-promote');
  // Settings-redirect errors: the loader helper already redirected to settings, so the un-strand skips.
  assert.match(exit, /if \(settingsRedirectErrorMessage\(error\) != null\) \{[\s\S]*?reportLoungeScreenError\(error\);\s*\n\s*\} else if \(!endResolved\)/, 'a settings-redirect error is owned by the loader helper (do not overwrite the settings screen)');
  // Pre-promote path: restore the lounge screen + chrome + player-turn resolver so the round can be retried.
  assert.match(exit, /\} else if \(!endResolved\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\)\) \{\s*\n\s*showScreen\('academy-lounge'\);\s*\n\s*renderLoungeScreenChrome\(\);\s*\n\s*\}[\s\S]*?if \(loungePlayerResolve\) loungeStage\.setControlsDisabled\(false\);[\s\S]*?reportLoungeScreenError\(error\);/, 'a pre-promote failure restores the lounge screen + chrome + player-turn controls for retry (no showScreen(academy-lounge) via runLoungeSession — renderLoungeScreenChrome repaints directly to bypass loungeFlowInFlight)');
  // Post-promote path: un-strand to the routing hub through the shared loading-covered hub return with the cause on
  // the hub status (never re-show the lounge — the finalizer would reject a re-finalization).
  assert.match(exit, /\} else \{[\s\S]*?await returnToRoutingHubThroughLoadingScreen\(\);\s*\n\s*routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);/, 'a post-promote failure un-strands to the routing hub with the cause on the hub status (never re-show the lounge — the finalizer rejects re-finalization)');
});

// v2 SSE reader contract (Stage 3): each assistant_complete finalizes the CURRENT in-progress assistant message
// (backend Stage 2 pin: SSE order 契約 guarantees the delta stream for that message has already ended by the time
// its complete arrives), and the reveal loop MUST reset its in-progress buffer per complete so the NEXT complete
// starts a fresh segment. Turn termination is decided by the SSE `result` event, NOT by the count of completes —
// on a continue turn there is exactly one complete + one message, and on a depart turn there are two completes +
// two messages (both carrying the SAME immutable turn emotion — the depart turn's normal-utterance face and
// departure-utterance face match by construction). The reader also forwards the backend's lounge_draining and
// lounge_finalization_progress events as loading-progress signals — the terminal `result` merges the completion
// payload (same fields the manual `/api/lounge/end` returns) when the depart turn exits the last active
// participant.
test('the SSE reader forwards multiple assistant_complete events and the lounge_draining / lounge_finalization_progress progress signals; turn end is the `result` event (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const reader = appFunction(js, 'readLoungeUtteranceSse');
  // Each assistant_complete calls onComplete unconditionally — no "first-complete-only" guard that would silently
  // drop the depart turn's 2nd complete on the floor.
  assert.match(reader, /event === 'assistant_complete'[\s\S]*?onComplete\(data\.content \?\? ''\)/, 'each assistant_complete forwards its content through onComplete (no first-only guard)');
  // The lounge_draining event is the all-exited signal that the backend is about to run the atomic finalize —
  // forwarded as loading-progress here so the frontend's constellation advances during the finalization.
  assert.match(reader, /event === 'lounge_draining'[\s\S]*?notifyAcademyLoadingProgress\(\)/, 'lounge_draining is forwarded as loading-progress');
  assert.match(reader, /event === 'lounge_finalization_progress'[\s\S]*?notifyAcademyLoadingProgress\(\)/, 'lounge_finalization_progress is forwarded as loading-progress');
  // Turn termination is the `result` event. Absence of the `result` throws (see the reader's tail check).
  assert.match(reader, /event === 'result'[\s\S]*?finalResult = data/, 'the terminal result is captured on the result event (turn end is result — not a complete-count推測)');
  assert.match(reader, /throw new Error\('lounge utterance stream ended without a final result'\)/, 'a stream that ends without a `result` fails fast');
});

test('revealLoungeUtterance commits each assistant_complete as one message, resets the in-progress buffer per complete, and spreads the one turn emotion onto every committed message (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const reveal = appFunction(js, 'revealLoungeUtterance');
  // A per-utterance `committed` array accumulates the finalized assistant messages of THIS turn (continue turn = 1,
  // depart turn = 2), used as the prefix for the next in-progress message's reveal segments so the fresh-tail slice
  // only picks up rows belonging to the new message.
  assert.match(reveal, /const committed = \[\];/, 'a per-utterance committed array collects finalized messages within the same turn');
  // Each onComplete: flushes final text via enqueueFrom, pushes to committed, resets the in-progress buffer.
  assert.match(reveal, /onComplete: \(content\) => \{[\s\S]*?fullText = content \|\| fullText;[\s\S]*?enqueueFrom\(fullText\);[\s\S]*?committed\.push\(loungeMessage\(speaker, fullText, turnEmotion\)\);[\s\S]*?fullText = '';[\s\S]*?segCount = 0;/, 'each assistant_complete flushes final text, commits the message with the turn emotion, and resets fullText / segCount for the next message');
  // enqueueFrom builds segments from [...committed, in-progress], slicing off the already-committed SEGMENTS
  // (not messages — displayMessages 括弧分割 can split one message into multiple rows, so the prefix must be
  // measured in segments so the next message's fresh tail does not include the previous message's trailing face
  // row). segCount tracks fresh segments within the current in-progress message; reset on each complete.
  assert.match(reveal, /const committedSegments = displayMessages\(committed\)\.filter\(\(segment\) => \(segment\.content \?\? ''\)\.trim\(\)\);/, 'the committed prefix is measured in segments (displayMessages(committed) filtered), not in messages');
  assert.match(reveal, /displayMessages\(\[\.\.\.committed, loungeMessage\(speaker, text, turnEmotion\)\]\)[\s\S]*?\.filter\(\(segment\) => \(segment\.content \?\? ''\)\.trim\(\)\)[\s\S]*?\.slice\(committedSegments\.length\);/, 'segments are derived from committed + in-progress and sliced past the committed SEGMENTS (safe against 括弧分割)');
  assert.match(reveal, /const fresh = segments\.slice\(segCount\);\s*\n\s*segCount \+= fresh\.length;/, 'segCount counts fresh segments within the CURRENT in-progress message (reset on each complete)');
});

// v2 auto completion (Stage 3): the terminal utterance SSE `result` carries the same completion payload the
// manual /api/lounge/end returns (backend Stage 2 merges the completion helper's return into the result event).
// runLoungeConversation hands off to runLoungeAutoCompletion, which raises the drain loading cover with a
// pre-resolved readiness (the backend has already promoted by the time the terminal result arrives — the
// completion payload IS the proof of promote) and delegates the strict-validate + adopt + hub return to the
// SHARED promoteLoungeCompletion helper. This is how the frontend has ONE hub-return path for lounge completion
// (auto + manual go through the same helper — no duplicated completion path per Stage 3 acceptance). The
// single-flight guard routingContentReturnInFlight is the same one exitLounge sets.
test('runLoungeAutoCompletion covers the finalization drain with the loading screen, delegates to the shared completion helper, and races the exit-button single-flight guard (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const auto = appFunction(js, 'runLoungeAutoCompletion');
  // Single-flight guard: same variable exitLounge uses. Concurrent exit press fails loud on the auto path — never
  // silently drops the auto completion.
  assert.match(auto, /if \(routingContentReturnInFlight\) \{[\s\S]*?throw new Error/, 'auto completion fails loud on a concurrent exit-button single-flight collision (no silent drop)');
  assert.match(auto, /routingContentReturnInFlight = true;/, 'auto completion sets the single-flight guard (same one exitLounge uses)');
  assert.match(auto, /\} finally \{\s*\n\s*routingContentReturnInFlight = false;\s*\n\s*\}/, 'the single-flight guard is always released');
  // The auto path never opens the player turn — asserted so a future refactor that opens it here fails loud.
  assert.match(auto, /if \(loungePlayerResolve\) \{[\s\S]*?throw new Error/, 'auto completion fails loud if the player turn resolver is unexpectedly held (must never be opened on the auto path)');
  // Validation runs BEFORE the drain cover raise (review Finding 3 / Minor) so a malformed payload rejects
  // without wasting a full drain-cover cycle on state that is about to be rejected.
  assert.match(auto, /assertLoungeCompletion\(result\);[\s\S]*?await showAcademyLoadingScreenUntilReady/, 'auto completion validates the payload BEFORE raising the drain loading cover');
  // Drain loading cover: readiness is pre-resolved (the backend has already promoted); nextScreen:null so the
  // shared content return owns the final switch. Same loadingCopy the explicit exit uses.
  assert.match(auto, /await showAcademyLoadingScreenUntilReady\(\{\s*\n\s*readiness: Promise\.resolve\(\),\s*\n\s*nextScreen: null,\s*\n\s*refreshBeforeNextScreen: false,\s*\n\s*loadingCopy: ROUTING_EXIT_DRAIN_LOADING_COPY\s*\n\s*\}\);/, 'auto completion raises the drain loading cover with a pre-resolved readiness and no target screen');
  // Delegates to the shared completion helper (SAME path as exitLounge). promoteLoungeCompletion re-runs the
  // validation (via assertLoungeCompletion) so the exit path's single call site still passes; the double check on
  // the auto path is a no-cost defensive re-validation after the cover raise.
  assert.match(auto, /await promoteLoungeCompletion\(result\);/, 'auto completion delegates adopt + hub return to the shared promoteLoungeCompletion helper (single hub-return path)');
  // Post-promote failure un-strands to the routing hub (same discipline as exitLounge's post-promote branch — the
  // backend already promoted before sending the terminal result, so we cannot re-show the lounge).
  assert.match(auto, /await returnToRoutingHubThroughLoadingScreen\(\);\s*\n\s*routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);/, 'auto completion post-promote failure un-strands to the routing hub with the cause on the hub status');
  // Settings-redirect errors are owned by the shared loader helper.
  assert.match(auto, /if \(settingsRedirectErrorMessage\(error\) != null\) \{[\s\S]*?reportLoungeScreenError\(error\);/, 'a settings-redirect error is owned by the loader helper (do not overwrite the settings screen)');
});

test('the clicked speaker popup resolves off the clicked row data-character-id (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /document\.querySelector\('#academy-lounge-message-stream'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?event\.target\.closest\('\.chat-message'\)[\s\S]*?row\.dataset\.characterId[\s\S]*?openLoungeCharacterPopup\(row\.dataset\.characterId\)/, 'clicking a bubble opens the CLICKED participant, resolved from the row data-character-id (not one active character)');
});

// ── behavioral fake-SSE harnesses (v2 contract) ─────────────────────────────
// The lounge functions read module-level state (loungeStage, loungeConversation, routingContentReturnInFlight,
// loungePlayerResolve, currentRuntimeState, …) and use browser globals. Because jsdom cannot render the full app.js
// shell (see assistantSseReveal.test.mjs precedent), we extract the target function source via the
// same appFunction() helper, then compile it with new Function(...) with every dependency injected as a free
// parameter — the assistantSseReveal.test.mjs pattern. This lets us drive real behavior with a fake SSE reader:
// depart-turn 2-message reveal (including 括弧分割 in message 1), continue-turn 1-message reveal, and terminal-
// result auto-completion handoff without opening the player turn.

// appFunction strips a leading `async` keyword (its match anchor is `function ${name}(`), so tests that eval the
// source must re-prepend `async` for functions whose bodies use `await` — otherwise `new Function(...)` throws
// "await is only valid in async functions".
function extractFunctionSource(js, name, { async: asyncKeyword = false } = {}) {
  const src = appFunction(js, name);
  return asyncKeyword ? `async ${src}` : src;
}

// A tiny reveal queue that flushes segments synchronously and records them as they land. Mirrors the minimal
// contract revealLoungeUtterance needs from loungeStage.createTurnReveal(base): enqueue(segments), drain(), cancel().
// The recorded segments are the SEGMENT objects displayMessages produced, in the order they were revealed — the
// primary observation for the depart-turn face-row bookkeeping test.
function createRecordingReveal(recorded) {
  return {
    enqueue: (segments) => {
      for (const segment of segments) recorded.push(segment);
    },
    drain: async () => {},
    cancel: () => {}
  };
}

// Minimal loungeStage stub for revealLoungeUtterance. `history` is the pre-turn base and the post-turn setHistory
// target; renderStream captures the last DOM write; createTurnReveal returns the recording reveal above.
function createFakeLoungeStage() {
  const historyRef = { value: [] };
  const revealed = [];
  const renderCalls = [];
  return {
    stage: {
      surface: {
        getHistory: () => [...historyRef.value],
        setHistory: (messages) => { historyRef.value = messages; }
      },
      createTurnReveal: () => createRecordingReveal(revealed),
      renderStream: (messages) => { renderCalls.push(messages); },
      stopAmbient: () => {}
    },
    revealed,
    renderCalls,
    historyRef
  };
}

// A trivial displayMessages that splits an assistant message's content on '|' into multiple face rows (mirrors the
// 括弧分割 that yields two face rows — the acceptance criterion). Each split preserves the source message's speaker
// identity and emotion. User messages pass through unchanged.
function fakeDisplayMessages(messages) {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message];
    return String(message.content ?? '')
      .split('|')
      .map((content) => ({ ...message, content }));
  });
}

// A trivial completedAssistantPrefix that treats the entire in-progress buffer as completed (delta events feed the
// whole text on each tick — matches the effect completedAssistantPrefix has in the reveal loop for our purposes).
function fakeCompletedAssistantPrefix(text) {
  return text;
}

// Compile revealLoungeUtterance with every free identifier it touches injected as a parameter. The function's
// closure resolves loungeStage, readLoungeUtteranceSse, displayMessages, loungeMessage, completedAssistantPrefix,
// and loungeMessagesFromConversation from the module scope — we bind them from the New Function args.
function compileRevealLoungeUtterance({ loungeStage, readLoungeUtteranceSse, displayMessages, completedAssistantPrefix, loungeMessagesFromConversation }) {
  const source = extractFunctionSource(latestAppSource, 'revealLoungeUtterance', { async: true });
  // The loungeMessage function's own source, so it validates the emotion + throws when required (matches the
  // module's real loungeMessage — we don't stub away the fail-fast checks). loungeMessage is a plain function
  // (no await), so no async prefix is needed.
  const loungeMessageSrc = extractFunctionSource(latestAppSource, 'loungeMessage');
  return new Function(
    'loungeStage',
    'readLoungeUtteranceSse',
    'displayMessages',
    'completedAssistantPrefix',
    'loungeMessagesFromConversation',
    `${loungeMessageSrc}; ${source}; return revealLoungeUtterance;`
  )(loungeStage, readLoungeUtteranceSse, displayMessages, completedAssistantPrefix, loungeMessagesFromConversation);
}

// A fake readLoungeUtteranceSse that walks a pre-built event list and calls the callbacks in order, returning the
// final `result` payload. Mirrors the real reader's callback contract exactly (onEmotion / onDelta / onComplete /
// onStreamStart); does NOT model the network layer — this is the behavioral seam under test.
function fakeReadLoungeUtteranceSse(events) {
  return async (_body, { onEmotion, onDelta, onComplete, onStreamStart }) => {
    let finalResult = null;
    for (const event of events) {
      if (event.type === 'stream_start') onStreamStart?.();
      else if (event.type === 'emotion') onEmotion?.(event.emotion);
      else if (event.type === 'delta') onDelta(event.delta);
      else if (event.type === 'complete') onComplete(event.content);
      else if (event.type === 'result') finalResult = event.data;
      else throw new Error(`unknown fake event ${event.type}`);
    }
    if (!finalResult) throw new Error('fake stream ended without a final result');
    return finalResult;
  };
}

// Loaded once and shared across the behavioral tests (avoids re-reading app.js on every test).
let latestAppSource = null;

test('depart turn: two assistant_complete events reveal a 通常発話 followed by a 退出発話, both with the same immutable emotion, and the 括弧分割 in message 1 does not re-reveal its trailing face row in message 2 (behavioral fake SSE)', async () => {
  latestAppSource = await readFile(path.join(root, 'app.js'), 'utf8');
  const stage = createFakeLoungeStage();
  const speaker = { character_id: 'char_042', character_name: '花'};
  const emotion = { expression: 'smile_soft', face_emotion_variant_id: 'face_neutral_00' };
  // 通常発話 uses '|' to force displayMessages into TWO face rows (the 括弧分割 that Finding 1 hinges on). 退出発話
  // is a single face row. Both must share the one turn emotion by construction.
  const events = [
    { type: 'emotion', emotion },
    { type: 'delta', delta: 'こんにちは|それじゃ' },
    { type: 'complete', content: 'こんにちは|それじゃ' },
    { type: 'complete', content: 'また明日' },
    {
      type: 'result',
      data: {
        speaker,
        emotion,
        content: 'また明日',
        conversation: {
          messages: [
            { role: 'user', content: '?' },
            { role: 'assistant', character_id: speaker.character_id, character_name: speaker.character_name, content: 'こんにちは|それじゃ', expression: emotion.expression, face_emotion_variant_id: emotion.face_emotion_variant_id },
            { role: 'assistant', character_id: speaker.character_id, character_name: speaker.character_name, content: 'また明日', expression: emotion.expression, face_emotion_variant_id: emotion.face_emotion_variant_id }
          ]
        }
      }
    }
  ];
  const revealLoungeUtterance = compileRevealLoungeUtterance({
    loungeStage: stage.stage,
    readLoungeUtteranceSse: fakeReadLoungeUtteranceSse(events),
    displayMessages: fakeDisplayMessages,
    completedAssistantPrefix: fakeCompletedAssistantPrefix,
    loungeMessagesFromConversation: (conversation) => conversation.messages
  });
  await revealLoungeUtterance({ speaker, id: 'conv_1', cursor: { round_number: 0, next_speaker_index: 0 } });
  // Every revealed segment carries the SAME emotion — the depart turn's 通常発話 and 退出発話 share one face by
  // construction (the primary v2 acceptance for emotion spread).
  for (const segment of stage.revealed) {
    assert.equal(segment.expression, emotion.expression, `every revealed segment shares the turn emotion (expression) — got ${JSON.stringify(segment)}`);
    assert.equal(segment.face_emotion_variant_id, emotion.face_emotion_variant_id, `every revealed segment shares the turn emotion (face_emotion_variant_id) — got ${JSON.stringify(segment)}`);
    assert.equal(segment.character_id, speaker.character_id, `every revealed segment carries the current speaker's identity — got ${JSON.stringify(segment)}`);
  }
  // 括弧分割 in message 1 yields 2 face rows; message 2 is 1 face row. So exactly 3 fresh segments are enqueued —
  // 4 or more would mean a trailing committed segment was re-revealed under the message-count slice (Finding 1).
  assert.equal(stage.revealed.length, 3, `depart turn should enqueue exactly 3 fresh segments (msg1 = 2 rows via 括弧分割, msg2 = 1 row); got ${stage.revealed.length}: ${JSON.stringify(stage.revealed.map((s) => s.content))}`);
  assert.deepEqual(
    stage.revealed.map((segment) => segment.content),
    ['こんにちは', 'それじゃ', 'また明日'],
    'depart turn reveal order: 通常発話 の 2 分割 → 退出発話 の 1 row (no re-revealed row from the segment-count slice fix)'
  );
});

test('continue turn: one assistant_complete reveals one message (behavioral fake SSE)', async () => {
  latestAppSource ??= await readFile(path.join(root, 'app.js'), 'utf8');
  const stage = createFakeLoungeStage();
  const speaker = { character_id: 'char_010', character_name: '風' };
  const emotion = { expression: 'calm', face_emotion_variant_id: 'face_calm_00' };
  const events = [
    { type: 'emotion', emotion },
    { type: 'delta', delta: 'そうだね' },
    { type: 'complete', content: 'そうだね' },
    {
      type: 'result',
      data: {
        speaker,
        emotion,
        content: 'そうだね',
        conversation: {
          messages: [
            { role: 'assistant', character_id: speaker.character_id, character_name: speaker.character_name, content: 'そうだね', expression: emotion.expression, face_emotion_variant_id: emotion.face_emotion_variant_id }
          ],
          next_speaker: { character_id: 'char_011', character_name: '光' }
        }
      }
    }
  ];
  const revealLoungeUtterance = compileRevealLoungeUtterance({
    loungeStage: stage.stage,
    readLoungeUtteranceSse: fakeReadLoungeUtteranceSse(events),
    displayMessages: fakeDisplayMessages,
    completedAssistantPrefix: fakeCompletedAssistantPrefix,
    loungeMessagesFromConversation: (conversation) => conversation.messages
  });
  const result = await revealLoungeUtterance({ speaker, id: 'conv_2', cursor: { round_number: 1, next_speaker_index: 0 } });
  assert.equal(stage.revealed.length, 1, `continue turn should enqueue exactly 1 fresh segment; got ${stage.revealed.length}`);
  assert.equal(stage.revealed[0].content, 'そうだね');
  assert.equal(stage.revealed[0].expression, emotion.expression);
  assert.equal(result.conversation.next_speaker.character_id, 'char_011', 'the continue turn advances the server cursor (next_speaker set)');
  assert.equal('finalization_status' in result, false, 'a continue turn has no finalization_status on the terminal result');
});

test('emotion 2 回目到達は throw / emotion 未確定のまま delta 到達は throw (behavioral fake SSE)', async () => {
  latestAppSource ??= await readFile(path.join(root, 'app.js'), 'utf8');
  const speaker = { character_id: 'char_001', character_name: 'テスト' };
  const emotion = { expression: 'smile', face_emotion_variant_id: 'face_smile_00' };

  // Second assistant_emotion is a protocol violation.
  {
    const stage = createFakeLoungeStage();
    const events = [
      { type: 'emotion', emotion },
      { type: 'emotion', emotion: { expression: 'sad', face_emotion_variant_id: 'face_sad_00' } }
    ];
    const revealLoungeUtterance = compileRevealLoungeUtterance({
      loungeStage: stage.stage,
      readLoungeUtteranceSse: fakeReadLoungeUtteranceSse(events),
      displayMessages: fakeDisplayMessages,
      completedAssistantPrefix: fakeCompletedAssistantPrefix,
      loungeMessagesFromConversation: (conversation) => conversation.messages
    });
    await assert.rejects(
      () => revealLoungeUtterance({ speaker, id: 'x', cursor: { round_number: 0, next_speaker_index: 0 } }),
      /assistant_emotion more than once/
    );
  }

  // assistant_delta before assistant_emotion is a protocol violation.
  {
    const stage = createFakeLoungeStage();
    const events = [
      { type: 'delta', delta: 'ぱ' }
    ];
    const revealLoungeUtterance = compileRevealLoungeUtterance({
      loungeStage: stage.stage,
      readLoungeUtteranceSse: fakeReadLoungeUtteranceSse(events),
      displayMessages: fakeDisplayMessages,
      completedAssistantPrefix: fakeCompletedAssistantPrefix,
      loungeMessagesFromConversation: (conversation) => conversation.messages
    });
    await assert.rejects(
      () => revealLoungeUtterance({ speaker, id: 'y', cursor: { round_number: 0, next_speaker_index: 0 } }),
      /content before assistant_emotion \(protocol violation\)/
    );
  }
});

// Auto-completion behavioral test: drives runLoungeConversation through a mocked revealLoungeUtterance that returns
// a terminal result carrying `finalization_status`. Pins that (a) the round loop never calls runLoungePlayerTurn on
// the auto path, and (b) runLoungeAutoCompletion is invoked with the terminal result. Because the real function
// reads module-level loungeConversation / loungeStage, we inject them (and the auto-completion + player-turn +
// reveal seams) as free parameters via new Function.
test('runLoungeConversation on a terminal result with finalization_status hands off to runLoungeAutoCompletion and never opens the player turn (behavioral)', async () => {
  latestAppSource ??= await readFile(path.join(root, 'app.js'), 'utf8');
  const runLoungeConversationSrc = extractFunctionSource(latestAppSource, 'runLoungeConversation', { async: true });
  const setControlsCalls = [];
  const setRespondingCalls = [];
  const fakeStage = {
    setControlsDisabled: (v) => { setControlsCalls.push(v); },
    setResponding: (v) => { setRespondingCalls.push(v); }
  };
  const initialConversation = {
    id: 'conv_auto',
    next_speaker: { character_id: 'char_090', character_name: '終' },
    cursor: { round_number: 0, next_speaker_index: 0 }
  };
  const terminalResult = {
    speaker: initialConversation.next_speaker,
    emotion: { expression: 'smile', face_emotion_variant_id: 'face_smile_00' },
    content: 'さようなら',
    conversation: { messages: [], next_speaker: null },
    finalization_status: 'completed',
    lounge_result: {},
    transition: { next_screen: 'interaction' },
    post_content_screen: 'interaction',
    state: { current_screen: 'interaction' }
  };
  let playerTurnOpened = false;
  const autoCalls = [];
  const revealCalls = [];
  const scope = {
    loungeConversation: initialConversation,
    loungeStage: fakeStage,
    revealLoungeUtterance: async (args) => {
      revealCalls.push(args);
      return terminalResult;
    },
    runLoungePlayerTurn: async () => {
      playerTurnOpened = true;
      return { ended: false, conversation: initialConversation };
    },
    runLoungeAutoCompletion: async (result) => {
      autoCalls.push(result);
    }
  };
  const compiled = new Function(
    'scope',
    `let loungeConversation = scope.loungeConversation;
     const loungeStage = scope.loungeStage;
     const revealLoungeUtterance = scope.revealLoungeUtterance;
     const runLoungePlayerTurn = scope.runLoungePlayerTurn;
     const runLoungeAutoCompletion = scope.runLoungeAutoCompletion;
     ${runLoungeConversationSrc}; return runLoungeConversation;`
  )(scope);
  await compiled({});
  assert.equal(playerTurnOpened, false, 'the auto path must NOT open the player turn — round loop returns before runLoungePlayerTurn');
  assert.equal(autoCalls.length, 1, 'runLoungeAutoCompletion is invoked exactly once on the terminal auto-completion result');
  assert.equal(autoCalls[0], terminalResult, 'the auto handler receives the terminal result carrying finalization_status');
  assert.equal(revealCalls.length, 1, 'the round loop streams exactly one NPC utterance — the terminal one carrying the auto completion');
});

// ── CSS ──────────────────────────────────────────────────────────────────────

test('the lounge screen gets the full-viewport layout constraint and a [hidden] popup guard (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');
  assert.match(css, /body:has\(#academy-lounge-screen\.active\) \.layout \{[\s\S]*?height: calc\(100dvh - var\(--runtime-topbar-height, 0px\)\)/, 'the lounge is a full-screen play surface so the chat scroll absorbs into a fixed height (the daytime constraint)');
  assert.match(css, /#academy-lounge-screen \[hidden\] \{\s*display: none;/, 'the lounge popups honour the UA [hidden] rule over any display rule');
});
