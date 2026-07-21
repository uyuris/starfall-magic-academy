import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;

// The academy-loading interstitial covers the wait for many transitions. The shared helper
// (showAcademyLoadingScreenUntilReady) reports a failure through reportLoadingError — which redirects an
// LM-config / invalid-LLM-output error to the settings screen — and then RETHROWS without switching screens.
// For any OTHER (non-settings) failure the loader therefore stays active unless the caller un-strands. The
// upstream investigation (loading-progress-signals-investigation §4/8) enumerated the sites that had NO such
// un-strand and could leave the player stranded on the loading screen: the graduation routes, the phase-2
// re-entry, the room-training flows, the companion / daytime / event conversation starts, the in-session stage
// move, and the auction entry.
//
// Every fix uses the SAME established loading-residual defense line already proven on runRoutingHubConversation
// (upstream precedent): guard on isAcademyLoadingScreenActive() so a settings redirect (which already left the
// loader) is never overridden and a sub-flow that already un-stranded is not double-handled, un-strand to the
// same-surface operable screen, show the cause on that surface's existing status line where it has one, and
// re-raise so the caller's own reporter still logs the failure once (no silent swallow, no auto-retry).
function extractFn(js, signature) {
  const fn = js.match(new RegExp(`${signature}[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  assert.notEqual(fn, '', `${signature} should be found in app.js`);
  return fn;
}

test('the loading-residual defense guard helper exists (isAcademyLoadingScreenActive)', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');
  assert.match(js, /function isAcademyLoadingScreenActive\(\) \{[\s\S]*?screens\['academy-loading'\]\.classList\.contains\('active'\)/,
    'a helper reports whether the academy-loading interstitial is the active screen (the guard every un-strand reads)');
});

test('graduation ending routes un-strand a non-settings failure to their own graduation surface, then re-raise', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');

  const legacyFn = extractFn(js, 'async function routeGraduationEndingSessionLegacy\\(started');
  assert.match(legacyFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('academy-conversation-session'\);[\s\S]*?setConversationStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the legacy graduation landing un-strands to the conversation session (its status line carries the cause) for non-settings failures and re-raises — never stranded on the loading screen');

  const dayFn = extractFn(js, 'async function routeGraduationEndingSessionDay\\(started');
  assert.match(dayFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('conversation-day'\);[\s\S]*?conversationDayStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the daytime graduation landing un-strands to conversation-day (cause on its status line) for non-settings failures and re-raises');
});

test('graduation phase-2 re-entry un-strands its own pre-route failures to the saved graduation surface', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');
  const fn = extractFn(js, 'async function reenterGraduationPhase2\\(reentry\\)');
  // The re-entry's /api/state read + preserved-context validation run before the route function, so they never
  // reach the route function's un-strand: the re-entry catches them itself and picks the saved surface.
  assert.match(fn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?reentry\.screen === 'academy-conversation-session'[\s\S]*?showScreen\('academy-conversation-session'\);[\s\S]*?setConversationStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?showScreen\('conversation-day'\);[\s\S]*?conversationDayStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the re-entry un-strands a non-settings pre-route failure to the surface the saved screen would have re-entered (legacy → conversation session, else daytime), then re-raises');
});

test('room-training flows un-strand a behind-the-loader failure to the 自室 (academy-room)', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');

  const trainFn = extractFn(js, 'async function openAcademyRoomTraining\\(\\)');
  assert.match(trainFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) showScreen\('academy-room'\);[\s\S]*?throw error;/,
    'openAcademyRoomTraining un-strands the graduation-week behind-the-loader failure to academy-room and re-raises');

  const skipFn = extractFn(js, 'async function openAcademyRoomSkipTraining\\(\\)');
  assert.match(skipFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) showScreen\('academy-room'\);[\s\S]*?throw error;/,
    'openAcademyRoomSkipTraining un-strands the graduation-week behind-the-loader failure to academy-room and re-raises');
});

test('loop training completion un-strands its map-branch failure to the academy map', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');
  const fn = extractFn(js, 'async function routeAfterCompletedAcademyTraining\\(postContentScreen\\)');
  // The 'academy-map' loop branch raises the loading screen directly (showScreen('academy-loading')), so its
  // readiness / event scan / refresh failures must un-strand. (The 'interaction' branch delegates to
  // returnToRoutingHubThroughLoadingScreen, which un-strands to the hub itself.)
  assert.match(fn, /showScreen\('academy-loading'\);[\s\S]*?\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) showScreen\('academy-map'\);[\s\S]*?throw error;/,
    'the loop map branch un-strands a non-settings failure to academy-map and re-raises');
});

test('the companion / daytime / event conversation starts un-strand to their conversation surface', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');

  const companionFn = extractFn(js, 'async function startAcademyConversationSessionFromCompanion\\(characterId\\)');
  assert.match(companionFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('academy-conversation-session'\);[\s\S]*?setConversationStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the companion (loop) conversation start un-strands to the conversation session with the cause on its status line, then re-raises');

  const dayFn = extractFn(js, 'async function startConversationDay\\(characterId\\)');
  assert.match(dayFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('conversation-day'\);[\s\S]*?conversationDayStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the daytime conversation start un-strands to conversation-day, then re-raises');

  const eventFn = extractFn(js, 'async function startConversationDayFromPendingEvent\\(flagId');
  assert.match(eventFn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('conversation-day'\);[\s\S]*?conversationDayStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the event conversation start un-strands to conversation-day, then re-raises');
});

test('the in-session stage move un-strands a failed refresh back to the conversation session', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');
  const fn = extractFn(js, 'async function performStageMoveTransition\\(\\{ result, stageMove \\}\\)');
  assert.match(fn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('academy-conversation-session'\);[\s\S]*?setConversationStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the stage move (same-session) un-strands to the conversation session with the cause on its status line, then re-raises');
});

test('the auction entry un-strands to the routing hub (routing content), then re-raises', async () => {
  const js = await readUiSource(path.join(root, 'app.js'), 'utf8');
  const fn = extractFn(js, 'async function runAuctionSession\\(\\)');
  assert.match(fn, /\} catch \(error\) \{[\s\S]*?if \(isAcademyLoadingScreenActive\(\) && settingsRedirectErrorMessage\(error\) == null\) \{[\s\S]*?showScreen\('routing-hub'\);[\s\S]*?routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\}[\s\S]*?throw error;/,
    'the auction entry un-strands to the routing hub (like the dungeon direct entry) with the cause on the hub status, then re-raises');
});
