import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// Event-flag conversations land on the daytime screen. Routing is the official mode, so there is no legacy
// landing choice: all three event-conversation entry points (academy-map arrival, the manual event tab, the
// new-game mentor intro) go through the shared daytime landing startConversationDayFromPendingEvent, which sets
// the interaction up through /api/event-flags/start (preserving source_type:'event' + the event context + the
// event location) — NOT through /api/interaction/start (which would make it source_type:'field' and break event
// completion).
test('event-flag conversations land on the daytime screen, keeping the event setup (no legacy landing choice)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The shared daytime event landing.
  const dayLanding = js.match(/async function startConversationDayFromPendingEvent\(flagId[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.notEqual(dayLanding, '', 'startConversationDayFromPendingEvent (the shared daytime event landing) should exist');
  assert.match(dayLanding, /\{ loadingAlreadyVisible = false, allowDuringInFlight = false, copyKey = null \} = \{\}/, 'the daytime event landing should mirror the session landing options (loadingAlreadyVisible / allowDuringInFlight) plus a copyKey for the intro loading copy');
  assert.match(dayLanding, /if \(conversationRequestInFlight && !allowDuringInFlight\) \{[\s\S]*showProcessingToast\(\);[\s\S]*return;[\s\S]*\}/, 'the daytime event landing keeps the single-flight guard with the allowDuringInFlight opt-in (routing in-turn map arrival)');
  assert.match(dayLanding, /postJson\('\/api\/event-flags\/start', \{ flag_id: flagId, screen: 'conversation-day' \}\)/, 'the daytime event landing must set the interaction up through /api/event-flags/start (preserving source_type:event + the event context), not /api/interaction/start');
  assert.doesNotMatch(dayLanding, /postJson\('\/api\/interaction\/start'/, 'the daytime event landing must NOT start a field interaction — that would drop source_type:event and break event completion');
  assert.match(dayLanding, /conversationDayStage\.surface\.setHistory\(\[\]\)/, 'the daytime event landing clears the daytime chat surface before the opening');
  assert.match(dayLanding, /ensureConversationDayOpening\(\{ onAssistantStreamStart: markOpeningStreamStarted \}\)/, 'the daytime event landing generates the opening through the daytime opening flow');
  assert.match(dayLanding, /Promise\.race\(\[openingStreamStarted, openingPromise\]\)/, 'the daytime event landing releases the loading screen at opening stream start (or an opening failure), not after the full first reply');
  assert.match(dayLanding, /if \(loadingAlreadyVisible\) \{[\s\S]*await readiness;[\s\S]*showScreen\('conversation-day'\)[\s\S]*\} else \{[\s\S]*showAcademyLoadingScreenUntilReady\(\{[\s\S]*nextScreen: 'conversation-day'[\s\S]*refreshBeforeNextScreen: false[\s\S]*\}\)[\s\S]*\}/, 'the daytime event landing reuses an already-visible loading screen or shows its own, landing on the conversation-day screen either way');
  assert.match(dayLanding, /renderConversationDayStage\(\)/, 'the daytime event landing paints the daytime stage frame (the event location field stage — no event-specific map)');

  // (1) Academy-map arrival landing delegates straight to the daytime landing (covers routePendingEventFromAcademyMap,
  // the loop post-training route, and the routing in-turn map arrival — all call this shared function).
  assert.match(js, /async function startAcademyConversationSessionFromPendingEvent\(flagId, \{ loadingAlreadyVisible = false, allowDuringInFlight = false \} = \{\}\) \{[\s\S]*?await startConversationDayFromPendingEvent\(flagId, \{ loadingAlreadyVisible, allowDuringInFlight \}\);[\s\S]*?\n\}/, 'the academy-map event landing delegates straight to the daytime landing (forwarding loadingAlreadyVisible/allowDuringInFlight)');

  // (2) The manual event-tab start delegates straight to the daytime landing.
  assert.match(js, /async function startEventFlagInteractionFromScreen\(flagId\) \{[\s\S]*?await startConversationDayFromPendingEvent\(flagId\);[\s\S]*?\n\}/, 'the manual event-tab start delegates straight to the daytime landing');

  // (3) The new-game mentor intro delegates straight to the daytime landing (keeping its intro-specific loading copy).
  assert.match(js, /async function routeNewGameIntroFromTitle\(\)[\s\S]*?if \(!introFlag\) return false;[\s\S]*?await startConversationDayFromPendingEvent\(introFlag\.id, \{ copyKey: 'new-game-intro' \}\);[\s\S]*?return true;[\s\S]*?\n\}/, 'the new-game mentor intro delegates straight to the daytime landing (with the new-game-intro loading copy)');

  // No legacy immediate-session-start branch remains in these event entry points, and they no longer read a
  // landing preference.
  assert.doesNotMatch(js, /academyConversationLandingScreen/, 'the event entry points no longer read a landing preference (routing is official)');
  const mapEntry = js.match(/async function startAcademyConversationSessionFromPendingEvent\([\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.doesNotMatch(mapEntry, /screen: 'academy-conversation-session'|showScreen\('academy-conversation-session'\)/, 'the academy-map event landing has no legacy immediate-session-start body');
  const tabEntry = js.match(/async function startEventFlagInteractionFromScreen\([\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.doesNotMatch(tabEntry, /event-flags\/start|showScreen\(screen\)/, 'the manual event-tab start has no legacy immediate-session-start body');
});

// The graduation ending event conversation (loop week 50 direct / routing guide selection phase 2) lands on the
// daytime screen: routing is the official mode, so a newly entered graduation conversation always lands there.
// Its interaction is ALREADY set up server-side, so the day landing adopts the started state and opens the
// daytime surface WITHOUT re-calling /api/event-flags/start. The legacy graduation session landing survives only
// for the load/resume phase-2 re-entry (picked by the SAVED screen in reenterGraduationPhase2).
test('the graduation ending conversation lands on the daytime screen (legacy session kept only for saved-screen re-entry)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // routeGraduationEndingSession lands a newly entered graduation conversation on the daytime graduation landing.
  const routeSession = js.match(/async function routeGraduationEndingSession\(started[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.notEqual(routeSession, '', 'routeGraduationEndingSession should exist');
  assert.match(routeSession, /await routeGraduationEndingSessionDay\(started, \{ loadingAlreadyVisible \}\);/, 'graduation ending lands on the daytime graduation landing');
  assert.doesNotMatch(routeSession, /academyConversationLandingScreen|routeGraduationEndingSessionLegacy/, 'the live graduation entry no longer branches on a landing preference (routing is official)');
  // The legacy graduation session landing still exists as its own named function, reached only by the
  // load/resume phase-2 re-entry (reenterGraduationPhase2) by the SAVED screen.
  const legacyLanding = js.match(/async function routeGraduationEndingSessionLegacy\(started[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.notEqual(legacyLanding, '', 'routeGraduationEndingSessionLegacy should exist');
  assert.match(legacyLanding, /ensureOpeningUtterance\(\{ onAssistantStreamStart: markOpeningStreamStarted \}\)[\s\S]*?showScreen\('academy-conversation-session'\)/, 'the legacy graduation session landing is preserved (byte-equivalent) in its own named function');
  assert.doesNotMatch(legacyLanding, /\/api\/event-flags\/start|\/api\/interaction\/start/, 'the legacy graduation landing must NOT re-start the interaction — the graduation event is already set up server-side');

  // The daytime graduation landing: adopt the already-set-up state and open the daytime surface, NOT a second
  // /api/event-flags/start (the graduation interaction is already started server-side).
  const dayLanding = js.match(/async function routeGraduationEndingSessionDay\(started[\s\S]*?\n\}\n/)?.[0] ?? '';
  assert.notEqual(dayLanding, '', 'routeGraduationEndingSessionDay should exist');
  assert.doesNotMatch(dayLanding, /\/api\/event-flags\/start|\/api\/interaction\/start/, 'the daytime graduation landing must NOT re-start the interaction — the graduation event is already set up server-side');
  assert.match(dayLanding, /conversationDayStage\.surface\.setHistory\(\[\]\)/, 'the daytime graduation landing clears the daytime chat surface before the opening');
  assert.match(dayLanding, /ensureConversationDayOpening\(\{ onAssistantStreamStart: markOpeningStreamStarted \}\)/, 'the daytime graduation landing generates the opening through the daytime opening flow');
  assert.match(dayLanding, /if \(loadingAlreadyVisible\) \{[\s\S]*?await readiness;[\s\S]*?showScreen\('conversation-day'\)[\s\S]*?\} else \{[\s\S]*?showAcademyLoadingScreenUntilReady\(\{[\s\S]*?nextScreen: 'conversation-day'[\s\S]*?refreshBeforeNextScreen: false[\s\S]*?copyKey: 'graduation-ending-start'[\s\S]*?\}\)[\s\S]*?\}/, 'the daytime graduation landing reuses an already-visible loading screen or shows its own graduation-ending-start loading, landing on conversation-day either way (M-2026-07-06-001)');
  assert.match(dayLanding, /renderConversationDayStage\(\)/, 'the daytime graduation landing paints the daytime stage frame (the event location field stage)');
  assert.match(dayLanding, /conversationDayStage\.setControlsDisabled\(false\)/, 'the daytime graduation landing re-enables the daytime controls in its finally');

  // Both graduation entries — the loop 50-week direct and the routing guide selection (phase 2) — hand off
  // through routeGraduationEndingSession, so both inherit the preset branch (day / legacy) above.
  assert.match(js, /async function openAcademyRoomTraining\(\)[\s\S]*?await routeGraduationEndingSession\(started, \{ loadingAlreadyVisible: true \}\)/, 'the loop 50-week graduation entry lands through routeGraduationEndingSession');
  assert.match(js, /async function startRoutingGraduationEndingFromSelection\(\{ result, loadingAlreadyVisible \}\)[\s\S]*?await routeGraduationEndingSession\(\{[\s\S]*?character_id: characterId,[\s\S]*?state: result\.state,[\s\S]*?flag_id: 'event\.graduation_ending\.ready'[\s\S]*?\}, \{ loadingAlreadyVisible \}\)/, 'the routing guide selection (phase 2) lands through the shared routeGraduationEndingSession');

  // Day-landing graduation end → title, for BOTH loop and routing. The daytime end button routes through the
  // shared endConversationDay → endConversation, which is screen-independent and unchanged: a graduation
  // conversation (pending_interaction_context.event_flag_id === 'event.graduation_ending.ready') takes the
  // graduation-ending-complete → title terminal (play-mode removed), and routing graduation is excluded from the
  // hub drain-on-exit (isRoutingGraduationEndingConversation). This is the identical terminal every graduation
  // takes; the day landing does not add a daytime-only end path.
  assert.match(js, /document\.querySelector\('#conversation-day-end'\)\.addEventListener\('click', \(\) => \{\s*\n\s*endConversationDay\(\)\.catch\(reportError\);/, 'the daytime end button routes graduation end through the shared endConversationDay');
  assert.match(js, /function endConversationDay\(options = \{\}\) \{[\s\S]*?if \(isActiveErrandConversation\(\)\) \{[\s\S]*?return endRoutingConversation\(\);[\s\S]*?\}[\s\S]*?return endConversation\(options\);/, 'a non-errand daytime end (a loop-mode graduation on the day screen) ends through the shared endConversation');
  assert.match(js, /async function endConversation\([\s\S]*?if \(currentPlayMode === 'routing' && !isRoutingGraduationEndingConversation\(\)\) \{[\s\S]*?await endRoutingConversation\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?pending_interaction_context\?\.event_flag_id === 'event\.graduation_ending\.ready'[\s\S]*?next_screen: 'title', loading_copy_key: 'graduation-ending-complete'/, 'endConversation sends a graduation conversation (loop, or routing phase 2) to the graduation-ending-complete title terminal — the day landing reuses this unchanged shared end');
});
