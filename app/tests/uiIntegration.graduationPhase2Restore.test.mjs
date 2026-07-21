import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const readFile = readUiSource;

// task graduation-phase2-restore-frontend — a mid-phase-2 卒業 conversation (締めくくり相手 = candidate character_###
// or 案内人 lina) is re-entered live from a slot load / resume, instead of dropping the player to the hub /
// academy-room (which restarts the graduation flow). The backend preserves the conversation entry state and
// exposes a graduation_phase2_reentry contract on POST /api/slots/load and GET /api/slots. This suite pins the
// frontend consumption: the contract reader wiring, the re-entry routine (persona-before-refresh ordering, saved
// screen branch, opening re-use, loading coverage), the three play-entry branches, and the no-hub-start defense.
// (Source-regex UI test; the live flow is the Electron harness app/tests/manual/graduationPhase2RestoreRender.mjs.)
test('graduation phase-2 restore: load/resume re-enter the phase-2 conversation via the entry contract (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const fn = (name) => {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  };

  // ── The pure contract reader is imported from the DOM-independent client seam (unit-tested headlessly) ──────
  assert.match(js, /import \{ parseGraduationPhase2Reentry \} from '\.\/graduationPhase2ReentryClient\.js';/, 'app.js consumes the phase-2 re-entry contract reader from its client module (not an inline re-implementation)');
  assert.match(js, /let slotLoadGraduationPhase2Reentry = null;/, 'the resume path caches the phase-2 re-entry contract from the latest GET /api/slots (resume has no load response of its own)');

  // ── refreshSaveSlots resolves the contract alongside the play-mode route (the shared /api/slots read) ───────
  assert.match(fn('refreshSaveSlots'), /slotLoadEntryRoute = resolvePlayModeEntryRoute\(response, '\/api\/slots'\);\s*\n\s*slotLoadGraduationPhase2Reentry = parseGraduationPhase2Reentry\(response, '\/api\/slots'\);/, 'refreshSaveSlots stores the phase-2 re-entry contract from the same /api/slots response that resolves the route');

  // ── routeGraduationEndingSession lands a newly entered graduation conversation on the daytime screen ─────────
  // Routing is the official mode, so the live selection/loop entry always lands on the daytime graduation screen.
  assert.match(fn('routeGraduationEndingSession'), /await routeGraduationEndingSessionDay\(started, \{ loadingAlreadyVisible \}\);/, 'the live selection/loop entry lands on the daytime graduation landing');
  assert.doesNotMatch(fn('routeGraduationEndingSession'), /routeGraduationEndingSessionLegacy|academyConversationLandingScreen/, 'the live entry no longer branches on a landing preference (routing is official)');
  // The legacy landing survives only for the load/resume phase-2 re-entry (picked by the SAVED screen in
  // reenterGraduationPhase2). It keeps the no-re-start discipline (adopts started state, never re-issues start).
  const legacyFn = fn('routeGraduationEndingSessionLegacy');
  assert.match(legacyFn, /activeCharacterId = started\.character_id \?\? activeCharacterId;\s*\n\s*currentRuntimeState = started\.state \?\? currentRuntimeState;/, 'routeGraduationEndingSessionLegacy adopts the started actor/state');
  assert.match(legacyFn, /ensureOpeningUtterance\(\{ onAssistantStreamStart: markOpeningStreamStarted \}\)/, 'routeGraduationEndingSessionLegacy runs the legacy opening (active-conversation re-use, no explicit id)');
  assert.doesNotMatch(legacyFn, /event-flags\/start/, 'routeGraduationEndingSessionLegacy never re-issues /api/event-flags/start (the graduation interaction is already set up)');

  // ── reenterGraduationPhase2: persona-before-refresh ordering, saved-screen branch, loading coverage ─────────
  const reenterFn = fn('reenterGraduationPhase2');
  assert.match(reenterFn, /if \(reentry\.is_guide_persona\) \{[\s\S]*?registerGraduationPersonaVisual\(reentry\.routing_persona_visual\);[\s\S]*?\}/, 'the 案内人 persona visual is registered from the entry contract; a candidate carries none');
  // The registration precedes the state read and the route function's refresh (the whole readiness body).
  assert.match(reenterFn, /registerGraduationPersonaVisual\(reentry\.routing_persona_visual\);[\s\S]*?const readiness = \(async \(\) => \{[\s\S]*?const state = await getJson\('\/api\/state'\);/, 'the persona registers BEFORE the /api/state read and the route function refresh (so refreshCharacters preserves lina)');
  // The preserved graduation event context is read strictly from /api/state — a missing/mismatched context
  // throws (fail-fast), never substitutes a hardcoded flag id / default (absolute-rules: no default fallback).
  assert.match(reenterFn, /const pending = state\?\.pending_interaction_context;\s*\n\s*if \(pending\?\.event_flag_id !== 'event\.graduation_ending\.ready'\) \{\s*\n\s*throw new Error/, 're-entry fail-fasts when the preserved state does not carry the graduation ending event context');
  assert.doesNotMatch(reenterFn, /\?\? 'event\.graduation_ending\.ready'|pending_interaction_context\?\.location_id \?\?/, 're-entry introduces no default-value fallback for the graduation flag id / location id');
  assert.match(reenterFn, /activeCharacterId = reentry\.character_id;\s*\n\s*currentRuntimeState = state;/, 'the preserved runtime state (graduation event context) is adopted up front so the guide survives refreshCharacters');
  assert.match(reenterFn, /if \(reentry\.screen === 'academy-conversation-session'\) \{\s*\n\s*await routeGraduationEndingSessionLegacy\(started, \{ loadingAlreadyVisible: true \}\);\s*\n\s*\} else \{\s*\n\s*await routeGraduationEndingSessionDay\(started, \{ loadingAlreadyVisible: true \}\);\s*\n\s*\}/, 'the surface is chosen by the SAVED screen, not the current preference (legacy → legacy, otherwise daytime)');
  assert.match(reenterFn, /await showAcademyLoadingScreenUntilReady\(\{\s*\n\s*readiness,\s*\n\s*refreshBeforeNextScreen: false,\s*\n\s*copyKey: 'graduation-ending-start'\s*\n\s*\}\);/, 'the state read + opening are covered by the loading screen under the graduation-ending-start copy (M-2026-07-06-001)');
  assert.doesNotMatch(reenterFn, /routing\/hub\/start|enterRoutingHub/, 're-entry never touches the routing hub start (the in-flight phase 2 is 409-defended server-side)');

  // ── loadSpecificSlot: branch to re-entry before the refresh / hub / academy-room landing, then return ───────
  const loadFn = fn('loadSpecificSlot');
  assert.match(loadFn, /const graduationPhase2Reentry = parseGraduationPhase2Reentry\(result, '\/api\/slots\/load'\);\s*\n\s*if \(graduationPhase2Reentry\) \{\s*\n\s*document\.body\.classList\.add\('play-mode'\);\s*\n\s*await reenterGraduationPhase2\(graduationPhase2Reentry\);\s*\n\s*return;\s*\n\s*\}/, 'loadSpecificSlot reads the load response contract and re-enters phase 2 (returning before the hub / academy-room landing)');
  // The re-entry branch precedes both the routing hub entry and the loop academy-room landing.
  assert.match(loadFn, /if \(graduationPhase2Reentry\) \{[\s\S]*?return;\s*\n\s*\}\s*\n\s*await refresh\(\);[\s\S]*?if \(route\.mode === 'routing'\) \{\s*\n\s*await enterRoutingHubFromPlayEntry\('slot-load'\);/, 'the phase-2 branch runs before the ordinary refresh + routing-hub / academy-room landing');

  // ── resumePlayFromSlotLoad: re-enter using the cached contract, before the hub / academy-room landing ───────
  const resumeFn = fn('resumePlayFromSlotLoad');
  assert.match(resumeFn, /if \(slotLoadGraduationPhase2Reentry\) \{\s*\n\s*await reenterGraduationPhase2\(slotLoadGraduationPhase2Reentry\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(slotLoadEntryRoute\.mode === 'routing'\) \{\s*\n\s*await enterRoutingHubFromPlayEntry\('slot-load'\);/, 'resume re-enters phase 2 from the cached contract before the routing-hub / academy-room landing');
});
