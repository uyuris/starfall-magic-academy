import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot, runtimeSourceReferenceRoot, projectRoot } from './testPaths.mjs';
import { readUiSource, cssRuleBlock, assertBigframeShell, assertNoCoolOrSoftBorderToken } from './fixtures/uiSource.mjs';

const root = runtimePublicReferenceRoot;
const sourceRoot = runtimeSourceReferenceRoot;
const readFile = readUiSource;

test('start/load/resume choose loop vs routing from the backend-resolved play mode (routing opens the hub, loop unchanged)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The mode reader is explicit on both sides: an unrecognized mode or a missing post_content_screen
  // is a fail-fast throw, never a silent fall-through to the loop route.
  assert.match(js, /function resolvePlayModeEntryRoute\(result, source\)[\s\S]*?const mode = result\?\.active_play_mode\?\.mode;[\s\S]*?mode !== 'loop' && mode !== 'routing'[\s\S]*?throw new Error/, 'the play-mode reader should fail fast on an unrecognized active_play_mode.mode');
  assert.match(js, /function resolvePlayModeEntryRoute\(result, source\)[\s\S]*?result\?\.post_content_screen[\s\S]*?throw new Error\(`\$\{source\}: missing post_content_screen`\)/, 'the play-mode reader should fail fast on a missing post_content_screen');

  // Routing entry opens the hub conversation on the dedicated routing hub screen (routing-hub, with its
  // own clean chat surface — not the shared academy conversation session) in one call, binds the active
  // character from the returned conversation, and routes LM-config errors to settings (no silent loop
  // degrade); non-LM errors propagate.
  assert.match(js, /async function enterRoutingHub\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?postJson\('\/api\/routing\/hub\/start', \{\}\)/, 'routing entry should start the hub through POST /api/routing/hub/start');
  assert.match(js, /async function enterRoutingHub\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?enterRoutingHubConversation\(result\.conversation\);[\s\S]*?showScreen\('routing-hub'\);[\s\S]*?revealResultSequentially\(routingHubStage\.surface, result\)/, 'routing entry should adopt the hub conversation (binding the routing actor + id) and render its opening on the dedicated routing hub screen (routing-hub) via its clean stage chat surface');
  assert.match(js, /async function enterRoutingHub\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?handleRuntimeApiError\(error, \{ allowSettingsRedirect: true \}\)[\s\S]*?throw error/, 'routing entry should redirect LM-config errors to settings and rethrow other errors (no silent loop degrade)');
  // (task errand-completion-transition-fix, symptom-1) enterRoutingHub takes an explicit allowDuringInFlight
  // opt-in: the in-flight guard blocks re-entry UNLESS the caller opts in. The errand achievement auto-end
  // (completeErrandFromTurnResult → navigateToPostContentScreen('interaction')) is the one opt-in caller,
  // returning to the hub from inside its still-in-flight turn; the play/training entries keep the plain guard.
  assert.match(js, /async function enterRoutingHub\(\{ allowDuringInFlight = false \} = \{\}\) \{\s*\n\s*if \(conversationRequestInFlight && !allowDuringInFlight\) \{/, 'enterRoutingHub gates re-entry on the in-flight flag unless the caller explicitly opts in with allowDuringInFlight');

  // New game: routing branches to the hub (through the loading-screen entry wrapper) before — and instead
  // of — the loop intro/academy-map path, which stays exactly as before for loop.
  assert.match(js, /async function startNewGame\(\)[\s\S]*?const route = resolvePlayModeEntryRoute\(result, '\/api\/new-game'\);[\s\S]*?if \(route\.mode === 'routing'\) \{[\s\S]*?await enterRoutingHubFromPlayEntry\('title'\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?if \(await routeNewGameIntroFromTitle\(\)\) return;[\s\S]*?showScreen\('academy-map', \{ rerollAcademyMap: true \}\)/, 'new game should route to the hub (via the loading-screen entry wrapper, origin title) for routing and keep the loop intro/academy-map path otherwise');

  // Load: routing branches to the hub through the loading-screen entry wrapper, loop keeps landing on
  // academy-room with no loading screen (byte-equivalent).
  assert.match(js, /async function loadSpecificSlot\(slotId\)[\s\S]*?const route = resolvePlayModeEntryRoute\(result, '\/api\/slots\/load'\);[\s\S]*?if \(route\.mode === 'routing'\) \{[\s\S]*?await enterRoutingHubFromPlayEntry\('slot-load'\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?showScreen\('academy-room'\)/, 'slot load should route to the hub (via the loading-screen entry wrapper, origin slot-load) for routing and keep the loop academy-room landing otherwise');

  // Resume: it does not re-load a slot, so it reads the mode stored from the latest GET /api/slots,
  // and fails fast if that route is absent rather than silently treating absence as loop.
  assert.match(js, /slotLoadEntryRoute = resolvePlayModeEntryRoute\(response, '\/api\/slots'\)/, 'the slots refresh should store the resolved route for the resume action');
  assert.match(js, /async function resumePlayFromSlotLoad\(\)[\s\S]*?if \(!slotLoadEntryRoute\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?if \(slotLoadEntryRoute\.mode === 'routing'\) \{[\s\S]*?await enterRoutingHubFromPlayEntry\('slot-load'\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?showScreen\('academy-room'\)/, 'resume should fail fast on a missing stored route, route to the hub (via the loading-screen entry wrapper, origin slot-load) for routing, and keep the loop academy-room landing otherwise');

  // Routing entry loading flow (押下→ロード画面→hub 表示): the shared entry wrapper shows the academy
  // loading screen with the hub-entry copy WHILE the non-streaming hub start runs, then enterRoutingHub
  // switches to the routing hub screen and reveals the 迎え opening the moment the start resolves. This is
  // routing-only — the loop entries keep their direct landing with no loading screen (asserted above).
  assert.match(js, /const ROUTING_HUB_ENTRY_LOADING_COPY = Object\.freeze\(\{\s*\n\s*title: 'ハブへ移動しています',\s*\n\s*status: '案内人が出迎えの支度をしています。'\s*\n\s*\}\);/, 'the routing entry loading copy is a frozen title/status pair shown during the hub start');
  assert.match(js, /async function enterRoutingHubFromPlayEntry\(originScreen\) \{\s*\n\s*setAcademyLoadingDestinationCopy\(null, \{ loadingCopy: ROUTING_HUB_ENTRY_LOADING_COPY \}\);\s*\n\s*showScreen\('academy-loading'\);\s*\n\s*try \{\s*\n\s*await enterRoutingHub\(\);/, 'the routing entry wrapper shows the academy loading screen with the hub-entry copy before awaiting enterRoutingHub, so the hub start runs under the loading screen');
  // Failure contract preserved and the loading screen is never terminal: a settings-redirect hub-start
  // error already left the loading screen for the settings screen inside enterRoutingHub (no catch here);
  // any other error threw before the hub switch (the loading screen is still active), so un-strand back to
  // the entry's origin screen — the existing error path — and rethrow. A post-switch failure leaves the
  // hub screen up because the loading screen is no longer active.
  assert.match(js, /async function enterRoutingHubFromPlayEntry\(originScreen\)[\s\S]*?catch \(error\) \{\s*\n\s*if \(document\.querySelector\('#academy-loading-screen'\)\?\.classList\.contains\('active'\)\) \{\s*\n\s*showScreen\(originScreen\);\s*\n\s*\}\s*\n\s*throw error;\s*\n\s*\}/, 'a non-settings hub-start failure un-strands from the still-active loading screen back to the entry origin screen and rethrows (loading screen never terminal); a post-switch failure leaves the hub up');

  // Shared routing hub-return-through-loading primitive (終了→ロード画面→迎え会話ストリーミング開始でハブ表示):
  // shows the academy loading screen with the hub-entry copy WHILE the non-streaming hub start runs, then
  // enterRoutingHub switches to the hub the moment its 迎え opening begins to stream — so a content-completed
  // player never waits on a silent hub during the return request (the loading screen covers the whole hub-return
  // wait). Shared by 鍛錬 completion, the 調合/工房 content return (returnToRoutingHubFromContent), and the errand
  // achievement auto-return (completeErrandFromTurnResult), which threads allowDuringInFlight straight to
  // enterRoutingHub's re-entry gate because it runs inside the daytime turn's still-in-flight window.
  assert.match(js, /async function returnToRoutingHubThroughLoadingScreen\(\{ allowDuringInFlight = false \} = \{\}\) \{\s*\n\s*setAcademyLoadingDestinationCopy\(null, \{ loadingCopy: ROUTING_HUB_ENTRY_LOADING_COPY \}\);\s*\n\s*showScreen\('academy-loading'\);\s*\n\s*try \{\s*\n\s*await enterRoutingHub\(\{ allowDuringInFlight \}\);/, 'the shared hub-return wrapper shows the academy loading screen with the hub-entry copy before awaiting enterRoutingHub (forwarding the allowDuringInFlight opt-in), so the hub-return request runs under the loading screen');
  // Failure defense follows endRoutingConversation's hub-return contract (not the play-entry origin un-strand):
  // a settings-redirect hub-start error already left the loading screen for settings inside enterRoutingHub
  // (loading screen no longer active → skipped); any other hub-start failure is still on the active loading
  // screen, so un-strand to the hub and surface the cause on the hub status line; a post-switch failure is
  // rethrown (the loading screen is no longer active).
  assert.match(js, /async function returnToRoutingHubThroughLoadingScreen\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?catch \(error\) \{\s*\n\s*if \(!isAcademyLoadingScreenActive\(\)\) throw error;\s*\n\s*showScreen\('routing-hub'\);\s*\n\s*routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);\s*\n\s*\}/, 'a non-settings hub-return failure un-strands from the still-active loading screen back to the routing hub with the cause shown on the hub status (endRoutingConversation-style defense), never stranding on the loading screen; a post-switch failure is rethrown');

  // The 調合/工房 content return reuses that shared primitive through returnToRoutingHubFromContent: both endpoints
  // are routing-only (backend 409s a non-routing reach), so post_content_screen is always the hub ('interaction');
  // an unexpected value fail-fasts (no default screen), and the return itself is the shared loading-covered hub
  // return — no bespoke parallel transition mechanism.
  assert.match(js, /async function returnToRoutingHubFromContent\(postContentScreen\) \{\s*\n\s*if \(postContentScreen !== 'interaction'\) \{\s*\n\s*throw new Error\(`routing content return: unexpected post_content_screen \$\{JSON\.stringify\(postContentScreen\)\}`\);\s*\n\s*\}\s*\n\s*await returnToRoutingHubThroughLoadingScreen\(\);\s*\n\s*\}/, 'the shared routing content return fail-fasts on a non-interaction post_content_screen and otherwise reuses the loading-covered hub return (no bespoke parallel transition)');
});

test('routing send-off dispatch and content-return wiring (queued conversation end, training/dungeon return to the hub, loop unchanged)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The global play mode is tracked from the same resolved slots route so conversation end can pick
  // its flow (loop optimistic-detached vs routing immediate-queued) before the request.
  assert.match(js, /slotLoadEntryRoute = resolvePlayModeEntryRoute\(response, '\/api\/slots'\);[\s\S]*?currentPlayMode = slotLoadEntryRoute\.mode;/, 'the slots refresh should track the active global play mode');

  // navigateToPostContentScreen: 'interaction' re-opens the hub; any other screen is shown through the
  // loading interstitial; a missing next screen fail-fasts (no default screen).
  assert.match(js, /async function navigateToPostContentScreen\(nextScreen, \{ loadingCopy = null, copyKey = null, refreshField = false, allowDuringInFlight = false \} = \{\}\)[\s\S]*?typeof nextScreen !== 'string' \|\| nextScreen === ''[\s\S]*?throw new Error[\s\S]*?nextScreen === 'interaction'[\s\S]*?await enterRoutingHub\(\{ allowDuringInFlight \}\);[\s\S]*?return;[\s\S]*?showAcademyLoadingScreenUntilReady\(/, 'post-content navigation re-opens the hub for interaction (forwarding the allowDuringInFlight opt-in), shows the loading screen otherwise, and fail-fasts on a missing next screen');

  // routingDispatchLoadingCopy reflects the chosen destination label and fail-fasts when it is absent.
  assert.match(js, /function routingDispatchLoadingCopy\(dispatch\)[\s\S]*?dispatch\?\.destination_label[\s\S]*?throw new Error[\s\S]*?\$\{label\}へ向かいます/, 'the dispatch loading copy reflects the destination label and fail-fasts when it is missing');

  // Routing conversation end: branch before the loop body, await the drained response (drain-on-exit),
  // navigate via the authoritative transition.next_screen and routing_dispatch, and release the
  // in-flight flag before navigating (so a content-return can re-open the hub). It must NOT set the loop
  // finalization gate.
  assert.match(js, /async function endConversation\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?conversationRequestInFlight && !allowDuringInFlight[\s\S]*?return;[\s\S]*?if \(currentPlayMode === 'routing' && !isRoutingGraduationEndingConversation\(\)\) \{[\s\S]*?await endRoutingConversation\(\);[\s\S]*?return;[\s\S]*?\}/, 'conversation end should dispatch to the routing flow when the play mode is routing (except the phase-2 graduation ending conversation, which takes the loop graduation title route), before the loop body');
  // The in-flight flag is released right after the drain response resolves (before the dispatch / content-return
  // validation + navigation, so the 'interaction' content-return can re-enter enterRoutingHub against a settled
  // flag), then the response is validated and the transition taken.
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?postJson\('\/api\/conversation\/end'[\s\S]*?const result = await endRequest;[\s\S]*?conversationRequestInFlight = false;[\s\S]*?const dispatch = result\.routing_dispatch \?\? null;[\s\S]*?if \(dispatch\) \{[\s\S]*?assertRoutingDispatchFinalization\(dispatch, result\.finalization_status\);[\s\S]*?assertDrainedRoutingFinalization\(result\.finalization_status\);[\s\S]*?navigateToPostContentScreen\(result\.transition\?\.next_screen, \{/, 'routing conversation end awaits the drained response, releases the in-flight flag before navigating, asserts the drained finalization status, then navigates via the authoritative transition (content-return asserts drained)');
  // (task errand-completion-transition-fix, symptom-2) The un-strand defense covers the WHOLE routing end,
  // including the post-response validation: a single catch wraps the drain request AND the drained-finalization
  // check + navigation, so a post-response contract violation (e.g. a non-'drained' finalization_status on an
  // already-finalized stale end) recovers to the hub with the error shown instead of stranding on the loading
  // screen; the finally is the idempotent in-flight backstop.
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?assertDrainedRoutingFinalization\(result\.finalization_status\);[\s\S]*?\} catch \(error\) \{[\s\S]*?settingsRedirectErrorMessage\(error\) == null[\s\S]*?showScreen\('routing-hub'\);\s*\n\s*routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);[\s\S]*?\} finally \{[\s\S]*?conversationRequestInFlight = false;/, 'the post-response validation runs inside the same try as the drain request, so its throw un-strands to the hub with the cause shown (never a terminal loading screen); the finally is the idempotent in-flight backstop');
  // Drain-on-exit UX: the loading screen is shown WHILE the drain-backed end request runs (readiness =
  // endRequest), not after — so the exit is visible under the loading screen instead of a cleared stall.
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?const endRequest = postJson\('\/api\/conversation\/end'[\s\S]*?await showAcademyLoadingScreenUntilReady\(\{\s*\n\s*readiness: endRequest,\s*\n\s*nextScreen: null,[\s\S]*?\}\);\s*\n\s*const result = await endRequest;/, 'the routing end shows the loading screen while the drain-backed end request runs (readiness = endRequest), before resolving the transition');
  // "今日はここまで" (hub end button): the request opts into the explicit backend title wrap-up contract with
  // wrap_up:'title' so an undecided hub no longer 409s (the response is the decided-title dispatch shape the
  // title branch above consumes via showRoutingWrapUpTitleTransition). EXCEPT during the graduation guide week:
  // the backend 409s an explicit wrap_up while routing_graduation_guide is active, and only a wrap_up-absent hub
  // end reaches the guide continuation contract, so the opt-in is additionally gated on
  // !isRoutingGraduationGuideActive(). endRoutingConversation is ALSO reached by a non-hub routing content-stage
  // end (content-return re-opens the hub), which must NOT send wrap_up (the backend 400s it outside a hub
  // conversation), so the opt-in is gated on the pre-clear hubActive snapshot. The end request is built from the
  // pre-clear identity snapshot (endActorId), never the post-clear global, and a 錬成室 content-return end sends
  // its captured conversation id explicitly (no last_conversation_id fallback), so a drifted global actor can
  // never re-target the end at the wrong conversation.
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?const endBody = \{ character_id: endActorId, provider \};\s*\n\s*if \(hubActive && !isRoutingGraduationGuideActive\(\)\) endBody\.wrap_up = 'title';[\s\S]*?if \(endingAtelierConversation\) endBody\.conversation_id = atelierConversationId;\s*\n\s*const endRequest = postJson\('\/api\/conversation\/end', endBody\);/, 'the hub end button sends wrap_up:\'title\' only for an active routing hub conversation OUTSIDE the graduation guide (an undecided hub drains to the title wrap-up instead of 409ing; a guide-week hub end omits wrap_up to reach the guide continuation contract), a non-hub content-return end sends no wrap_up, and a 錬成室 end sends its captured conversation_id explicitly — all built from the pre-clear identity snapshot');
  // The guide-week gate reads the guide presence from the runtime state (正本) with no ?? currentRuntimeState
  // default: a hub end always has a live runtime state, so a missing one fail-fasts rather than silently
  // deciding "not a guide" and sending the 409-bound wrap_up.
  assert.match(js, /function isRoutingGraduationGuideActive\(\) \{\s*\n\s*if \(!currentRuntimeState \|\| typeof currentRuntimeState !== 'object'\) \{\s*\n\s*throw new Error\([^\n]*runtime state is missing[^\n]*\);\s*\n\s*\}\s*\n\s*const guide = currentRuntimeState\.routing_graduation_guide;\s*\n\s*return Boolean\(guide\) && typeof guide === 'object';\s*\n\s*\}/, 'isRoutingGraduationGuideActive reads routing_graduation_guide presence from the runtime state and fail-fasts on a missing runtime state (no silent default to a non-guide wrap_up path)');
  // The identity snapshot is captured BEFORE clearVisibleConversation() tears down the atelier id / actor,
  // so the end request never rebuilds from a post-turn-refresh-drifted global actor.
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?const hubActive = isRoutingHubActive\(\);\s*\n\s*const endingAtelierConversation = isActiveAtelierConversation\(\);\s*\n\s*const atelierConversationId = endingAtelierConversation \? activeAtelierConversationId : null;\s*\n\s*const endActorId = endingAtelierConversation \? activeAtelierActor\.character_id : activeCharacterId;\s*\n\s*clearVisibleConversation\(\);/, 'the end-request identity (hub/atelier kind, atelier conversation id, actor id) is captured before clearVisibleConversation() destroys the atelier state');
  // In-turn dispatch loading-during-drain: the stream emits routing_draining after the send-off and
  // before the backend drain; the client shows the loading screen on it so the post-processing runs under
  // the loading screen (the send-off was shown while streaming, then performRoutingTurnDispatch navigates
  // from the loading screen on the result event). Same "loading while drain runs" contract as the end path.
  assert.match(js, /if \(event === 'routing_draining'\) \{\s*\n\s*onRoutingDraining\?\.\(data\);/, 'the SSE stream surfaces the routing_draining signal to the caller');
  assert.match(js, /onRoutingDispatch: performRoutingTurnDispatch,\s*\n\s*onRoutingDraining: showRoutingDrainLoadingScreen/, 'the conversation stream wires the routing_draining signal to the drain loading screen');
  assert.match(js, /function showRoutingDrainLoadingScreen\(\) \{\s*\n\s*setAcademyLoadingDestinationCopy\(null, \{ loadingCopy: ROUTING_EXIT_DRAIN_LOADING_COPY \}\);\s*\n\s*showScreen\('academy-loading'\);\s*\n\s*\}/, 'the routing_draining signal shows the academy loading screen with the post-processing drain copy');
  // Drain-on-exit: every routing end fully drains server-side, so the content-return case fail-fasts
  // unless finalization_status is 'drained', and a hub dispatch asserts 'drained' for every destination,
  // validated against the allowed destination set (destination_id + screen) with a transition
  // consistency check. The wrap-up destination ('title') leaves play mode for the title screen; every
  // other destination keeps the content navigation with its destination loading copy. The pure
  // validators come from the shared module.
  assert.match(js, /import \{ assertDrainedRoutingFinalization, assertRoutingDispatchFinalization, validateRoutingDispatchScreen \} from '\.\/routingDispatchClient\.js'/, 'app.js imports the headless-testable routing dispatch validators');
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?if \(dispatch\) \{[\s\S]*?assertRoutingDispatchFinalization\(dispatch, result\.finalization_status\);[\s\S]*?const dispatchScreen = validateRoutingDispatchScreen\(dispatch\);[\s\S]*?result\.transition\?\.next_screen !== dispatchScreen[\s\S]*?throw new Error[\s\S]*?if \(dispatchScreen === 'title'\) \{[\s\S]*?showRoutingWrapUpTitleTransition\(\)[\s\S]*?\}[\s\S]*?loadingCopy: routingDispatchLoadingCopy\(dispatch\)/, 'a present routing dispatch validates its finalization status and destination against the authoritative transition, wraps up to the title screen for the title destination, and otherwise navigates with the destination loading copy');
  // The conversation-end dispatch branch adopts the authoritative post-dispatch state and fail-fasts when
  // it is missing/invalid (no silent fallback to stale client state), matching performRoutingTurnDispatch.
  assert.match(js, /async function endRoutingConversation\(\)[\s\S]*?if \(dispatch\) \{[\s\S]*?if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?currentRuntimeState = result\.state;[\s\S]*?clearRoutingHubConversation\(\)/, 'the conversation-end dispatch path fail-fasts on missing/invalid post-dispatch state before adopting it and navigating');
  assert.doesNotMatch(js.match(/async function endRoutingConversation\(\)[\s\S]*?\n}\n/)?.[0] ?? '', /conversationFinalizationInFlight/, 'routing conversation end must not hold the loop finalization gate (its queue is server-side)');

  // Training/dungeon routing return: completed training returns to the hub for 'interaction' through the
  // loading interstitial (the hub-return request is covered by the loading screen); the dungeon exit trusts
  // the response transition (mode-resolved) and only falls back to the mode for a held-finalize resume that
  // has no transition.
  assert.match(js, /async function routeAfterCompletedAcademyTraining\(postContentScreen\)[\s\S]*?postContentScreen === 'interaction'[\s\S]*?await returnToRoutingHubThroughLoadingScreen\(\);[\s\S]*?return;/, 'routing training completion returns to the hub through the loading interstitial');
  assert.match(js, /async function dungeonExitToRoom\(result\)[\s\S]*?result\.transition\?\.next_screen[\s\S]*?currentPlayMode === 'routing' \? 'interaction' : 'academy-room'[\s\S]*?navigateToPostContentScreen\(nextScreen/, 'dungeon exit trusts the response transition and resolves the held-resume recovery screen from the global mode');

  // Loop byte-equivalence: the loop conversation-end body still optimistically targets academy-room and
  // detaches finalization; loop dungeon still lands on academy-room via the response; loop training
  // still uses the academy-map route.
  assert.match(js, /async function endConversation\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?conversationFinalizationInFlight = true;[\s\S]*?next_screen: 'academy-room'[\s\S]*?const finalization = \(async \(\) => \{[\s\S]*?postJson\('\/api\/conversation\/end'/, 'the loop conversation-end body is unchanged (optimistic academy-room target with detached finalization)');
});

test('routing content arrival refreshes the server-evaluated field and rerolls academy-map placement, leaving loop transitions byte-equivalent', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // (Goal 1) FIELD FRESHNESS: a routing dispatch progressed the week server-side, so the in-turn dispatch
  // refreshes the server-evaluated field (/api/field, via refresh()) under the loading screen before the
  // destination renders. The academy map reads its stage descriptions live from currentField, so a stale
  // field would freeze last week's descriptions. The fix adds NO client-side situation fallback — the
  // stage-description truth source stays the server field.
  const dispatchFn = js.match(/async function performRoutingTurnDispatch\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(dispatchFn, /refreshBeforeNextScreen: true/, 'the in-turn routing dispatch refreshes the server field before rendering the destination (no stale currentField)');
  assert.match(js, /function selectedAcademyStageSituation\(locationOrId\)[\s\S]*?return location\.visible_situation \?\? ''/, 'stage description stays read live from the server field visible_situation — the fix adds no client-side fallback');

  // (Goal 2) PLACEMENT REROLL: a routing academy-map arrival force-rerolls placement via the existing
  // explicit force path (showScreen -> ensureAcademyMapCharacterAssignments({ force })). The in-turn dispatch
  // routes a map destination into the shared arriveAtRoutingAcademyMap helper (the placement-reroll +
  // pending-event-scan arrival), and the helper force-rerolls when it shows the map. It does NOT reintroduce
  // the removed implicit signature-diff reroll.
  assert.match(dispatchFn, /dispatchScreen === 'academy-map'[\s\S]*?await arriveAtRoutingAcademyMap\(\{ loadingCopy: routingDispatchLoadingCopy\(dispatch\), allowDuringInFlight: true \}\);[\s\S]*?return;/, 'the in-turn routing dispatch routes a map arrival into the shared arriveAtRoutingAcademyMap helper');
  const mapArrivalFn = js.match(/async function arriveAtRoutingAcademyMap\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(mapArrivalFn, /showScreen\('academy-map', \{ rerollAcademyMap: true \}\)/, 'the map arrival helper force-rerolls the academy-map placement when it shows the map (no pending event)');
  assert.doesNotMatch(js, /signature !== academyMapAssignmentSignature/, 'the routing reroll is the explicit force flag only; the fix must not reintroduce implicit signature-diff reroll');

  // (Goal 1+2, end-button path) CONTENT-RETURN / END-BUTTON DISPATCH: endRoutingConversation threads
  // refreshField: true into navigateToPostContentScreen on both the dispatch and content-return branches,
  // so the same field-freshness + map-reroll guarantee applies when the destination is reached via the end
  // button. navigateToPostContentScreen pre-branches a routing map arrival into the shared
  // arriveAtRoutingAcademyMap helper (placement reroll + pending event scan), and forwards refreshField to the
  // strict loading refresh for the remaining content destinations.
  const endFn = js.match(/async function endRoutingConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(endFn, /navigateToPostContentScreen\(result\.transition\?\.next_screen, \{[\s\S]*?refreshField: true[\s\S]*?\}\);[\s\S]*?return;/, 'the end-button dispatch branch requests the field refresh + map reroll (refreshField: true)');
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(navFn, /if \(refreshField && nextScreen === 'academy-map'\) \{[\s\S]*?await arriveAtRoutingAcademyMap\(\{ loadingCopy, copyKey \}\);[\s\S]*?return;[\s\S]*?\}/, 'the end-button map arrival is pre-branched into the shared arriveAtRoutingAcademyMap helper (placement reroll + pending event scan)');
  assert.match(navFn, /refreshBeforeNextScreen: refreshField,[\s\S]*?strictFieldRefresh: refreshField/, 'the generic post-content navigation still forwards the routing refresh flag to the strict loading refresh for the remaining content destinations');

  // (Goal 3) FAIL-FAST ON REFRESH FAILURE: the routing arrival refreshes with a STRICT field fetch, so a
  // failed /api/field throws and the destination is NOT rendered on a stale field (the loading helper runs
  // the refresh inside the try and only reaches showScreen after it — asserted separately). refresh()'s
  // strict branch fetches /api/field directly (no resilient fallback), while the default/loop path keeps the
  // last-known field. Each routing arrival requests the strict refresh and recovers to the hub on failure
  // (never a stale-field render, never a terminal loading screen); the loop navigation keeps its resilient,
  // byte-equivalent propagation.
  assert.match(js, /const \[state, field\] = await Promise\.all\(\[[\s\S]*?runRefreshTask\('state', \(\) => getJson\('\/api\/state'\), \{ fallbackValue: currentRuntimeState \}\),[\s\S]*?strictField[\s\S]*?\? getJson\('\/api\/field'\)[\s\S]*?: runRefreshTask\('field', \(\) => getJson\('\/api\/field'\), \{ fallbackValue: currentField \}\)/, 'refresh strict field branch fetches /api/field directly (throws on failure), while the default resilient branch keeps the last-known field (loop/other callers byte-equivalent)');
  assert.match(dispatchFn, /strictFieldRefresh: true/, 'the in-turn routing dispatch requests the strict field refresh (a failed /api/field must not render the destination)');
  assert.match(dispatchFn, /catch \(error\) \{[\s\S]*?settingsRedirectErrorMessage\(error\) == null[\s\S]*?showScreen\('routing-hub'\)/, 'a failed routing-dispatch field refresh un-strands to the hub (never a stale-field render, never a terminal loading screen); the error is already surfaced through reportLoadingError');
  assert.match(navFn, /strictFieldRefresh: refreshField/, 'post-content navigation runs the strict field refresh for the routing arrival');
  assert.match(navFn, /catch \(error\) \{[\s\S]*?if \(!refreshField\) throw error;[\s\S]*?settingsRedirectErrorMessage\(error\) == null[\s\S]*?showScreen\('routing-hub'\)/, 'only the routing arrival (refreshField) fail-fasts to the hub on a failed refresh; the loop/non-routing navigation keeps its original propagation (resilient refresh, byte-equivalent)');

  // (Goal 4) LOOP BYTE-EQUIVALENCE: refreshField defaults to false, and the loop dungeon exit
  // (dungeonExitToRoom -> academy-room) does not pass it, so that transition adds no refresh and no reroll
  // (unchanged). The routing dungeon exit returns via 'interaction' (enterRoutingHub, which refreshes on its
  // own). Loop conversation-end still owns its own refresh + force reroll, untouched by this fix.
  assert.match(js, /async function navigateToPostContentScreen\(nextScreen, \{ loadingCopy = null, copyKey = null, refreshField = false, allowDuringInFlight = false \} = \{\}\)/, 'refreshField defaults to false so non-routing callers keep byte-equivalent navigation');
  const dungeonExitFn = js.match(/async function dungeonExitToRoom\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(dungeonExitFn, /refreshField/, 'the dungeon exit does not opt into the routing field refresh (loop academy-room stays byte-equivalent; routing returns via the hub)');
});

test('routing academy-map arrival auto-starts a pending event before showing the map (both dispatch paths), satisfying the dispatch contract first and never silently dropping onto the map, with the loop map route unchanged', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  const mapArrivalFn = js.match(/async function arriveAtRoutingAcademyMap\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(mapArrivalFn, '', 'arriveAtRoutingAcademyMap should exist (the shared routing map arrival)');

  // BOTH DISPATCH PATHS route a routing map arrival into the shared helper — the sibling of the dungeon
  // direct entry — never the generic showAcademyLoadingScreenUntilReady map show: the in-turn
  // performRoutingTurnDispatch (still in-flight → allowDuringInFlight: true) and the end-button
  // navigateToPostContentScreen (in-flight already released → default false).
  const dispatchFn = js.match(/async function performRoutingTurnDispatch\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(dispatchFn, /if \(dispatchScreen === 'academy-map'\) \{[\s\S]*?await arriveAtRoutingAcademyMap\(\{ loadingCopy: routingDispatchLoadingCopy\(dispatch\), allowDuringInFlight: true \}\);[\s\S]*?return;[\s\S]*?\}/, 'the in-turn dispatch routes a map arrival into arriveAtRoutingAcademyMap with allowDuringInFlight: true (still in-flight)');
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(navFn, /if \(refreshField && nextScreen === 'academy-map'\) \{[\s\S]*?await arriveAtRoutingAcademyMap\(\{ loadingCopy, copyKey \}\);[\s\S]*?return;[\s\S]*?\}/, 'the end-button dispatch routes a routing map arrival into arriveAtRoutingAcademyMap (no allowDuringInFlight — the turn already released the flag)');
  // The generic (non-map) content path no longer carries the now-dead map reroll — the map arrival is
  // pre-branched, so the reroll lives inside the helper.
  assert.doesNotMatch(dispatchFn, /rerollAcademyMap: dispatchScreen === 'academy-map'/, 'the generic in-turn content path drops the now-dead map reroll (the map arrival is pre-branched)');
  assert.doesNotMatch(navFn, /rerollAcademyMap: refreshField && nextScreen === 'academy-map'/, 'the generic end-button content path drops the now-dead map reroll (the map arrival is pre-branched)');

  // ORDER (dispatch contract first, AC2): drained + post-dispatch state are adopted by the caller upstream;
  // the helper holds the loading screen, completes the STRICT field refresh, THEN fresh-scans pending events
  // over GET /api/event-flags (refreshEventFlagStatus) with the SAME predicate as the loop map route (an
  // event flag carrying an interaction location + source character) — so the routing arrival contract is
  // fully satisfied before the event decision, never from stale client state.
  assert.match(mapArrivalFn, /showScreen\('academy-loading'\);[\s\S]*?await refresh\(\{ strictField: true \}\);[\s\S]*?const status = await refreshEventFlagStatus\(\);[\s\S]*?autoStartFlag = \(status\.pending_events \?\? \[\]\)\.find\(\(flag\) => flag\.interaction\?\.location_id && flag\.character_id\)/, 'the map arrival holds the loading screen, strictly refreshes the field, THEN fresh-scans pending events (same predicate as the loop map route)');

  // NO-EVENT (AC3): with no startable pending event the reroll'd academy map is shown (byte-equivalent to the
  // plain routing arrival). The map show is reached ONLY in this no-event branch.
  assert.match(mapArrivalFn, /if \(!autoStartFlag\) \{[\s\S]*?showScreen\('academy-map', \{ rerollAcademyMap: true \}\);[\s\S]*?return;[\s\S]*?\}/, 'with no pending event the reroll\'d academy map is shown (byte-equivalent to the plain routing arrival)');

  // DIVERT (AC1): a startable pending event keeps the loading screen up and hands off to the loading-aware
  // event start (loadingAlreadyVisible + forwarded allowDuringInFlight), AFTER the no-event map branch — so
  // the map is never shown on the divert path (学院マップを経ずにイベント直行).
  assert.match(mapArrivalFn, /if \(!autoStartFlag\) \{[\s\S]*?\}[\s\S]*?await startAcademyConversationSessionFromPendingEvent\(autoStartFlag\.id, \{ loadingAlreadyVisible: true, allowDuringInFlight \}\)/, 'a startable pending event hands off to the loading-aware event start (loadingAlreadyVisible + forwarded allowDuringInFlight) after the no-event map branch — the map is never shown on the divert');

  // FAIL-FAST / NO SILENT MAP DROP (AC5/AC6): a failed strict field refresh or pending-event scan surfaces
  // through reportLoadingError and un-strands to the hub (never a stale-field map, never a silent map drop); a
  // failed event start un-strands to the hub off the loading screen (the start already surfaced its own
  // cause). No default screen, no silent fallback.
  assert.match(mapArrivalFn, /catch \(error\) \{[\s\S]*?reportLoadingError\(error\);[\s\S]*?if \(settingsRedirectErrorMessage\(error\) == null\) showScreen\('routing-hub'\);[\s\S]*?return;[\s\S]*?\}/, 'a failed field refresh / event scan surfaces through reportLoadingError and un-strands to the hub (no silent map drop)');
  assert.match(mapArrivalFn, /await startAcademyConversationSessionFromPendingEvent\([\s\S]*?\} catch \(error\) \{[\s\S]*?if \(settingsRedirectErrorMessage\(error\) == null\) showScreen\('routing-hub'\);[\s\S]*?\}/, 'a failed event start un-strands to the hub off the loading screen (never a silent map drop)');

  // EVENT-START allowDuringInFlight OPT-IN (AC5): the shared event-start guard becomes
  // conversationRequestInFlight && !allowDuringInFlight (the errand achievement auto-end 流儀), so the in-turn
  // map dispatch can start the event from inside its still-in-flight turn without clearing the flag early.
  assert.match(js, /async function startAcademyConversationSessionFromPendingEvent\(flagId, \{ loadingAlreadyVisible = false, allowDuringInFlight = false \} = \{\}\)[\s\S]*?if \(conversationRequestInFlight && !allowDuringInFlight\) \{[\s\S]*?showProcessingToast\(\);[\s\S]*?return;[\s\S]*?\}/, 'the event start opts into allowDuringInFlight (guard: conversationRequestInFlight && !allowDuringInFlight)');

  // AC4 (end returns to the hub via the EXISTING contract): the arrival adds NO event end / transition — a
  // routing event conversation ends through the unchanged endRoutingConversation content-return (hub return).
  assert.doesNotMatch(mapArrivalFn, /endRoutingConversation|navigateToPostContentScreen|next_screen|transition/, 'the map arrival adds no end/transition contract — the event end reuses the existing routing content-return');

  // AC6 (loop map route unchanged): the loop 鍛錬→学院マップ route still starts a pending event with only
  // loadingAlreadyVisible (no allowDuringInFlight — loop is never in-flight here), and never touches the
  // routing arrival helper.
  const loopRouteFn = js.match(/async function routeAfterCompletedAcademyTraining\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(loopRouteFn, /const autoStartFlag = \(status\.pending_events \?\? \[\]\)\.find\(\(flag\) => flag\.interaction\?\.location_id && flag\.character_id\)[\s\S]*?await startAcademyConversationSessionFromPendingEvent\(autoStartFlag\.id, \{ loadingAlreadyVisible: true \}\)/, 'the loop map route is unchanged — it starts the pending event with only loadingAlreadyVisible (no allowDuringInFlight)');
  assert.doesNotMatch(loopRouteFn, /arriveAtRoutingAcademyMap|allowDuringInFlight/, 'the loop map route does not use the routing arrival helper or the in-flight opt-in (byte-equivalent)');
});

test('routing turn-result dispatch consumes the in-turn send-off and moves to the destination on both the stream and non-stream paths', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // The shared SSE controller takes an in-turn routing-dispatch handler, the sibling of the stage-move
  // handler, and reads the canonical top-level routing_dispatch from the final result only when one is
  // provided (loop / ordinary academy streams pass no handler and are unaffected).
  assert.match(js, /async function runAssistantSseStream\(\{[\s\S]*?onStageMove = null, onRoutingDispatch = null, onRoutingDraining = null, onEvent = null \}\)/, 'the SSE controller should accept the in-turn routing-dispatch and routing-draining handlers alongside the stage-move handler');
  assert.match(js, /const routingDispatch = onRoutingDispatch \? \(finalResult\.routing_dispatch \?\? null\) : null;/, 'the SSE controller should read the canonical top-level routing_dispatch only when a dispatch handler is provided');

  // A stage move and a routing dispatch are mutually exclusive; a result carrying both fail-fasts
  // instead of silently preferring one branch.
  assert.match(js, /if \(stageMove && routingDispatch\) \{[\s\S]*?throw new Error\('conversation turn result carries both stage_move and routing_dispatch \(mutually exclusive\)'\);[\s\S]*?\}/, 'a final turn result carrying both stage_move and routing_dispatch should fail fast');

  // On a decided routing turn the stream reveals the entire send-off (no opening line to hold back),
  // commits the post-dispatch state, then defers to the in-turn dispatch handler — modelled on the
  // stage-move branch, not the normal final reveal.
  assert.match(js, /\} else if \(routingDispatch\) \{[\s\S]*?await finishAssistantSegmentReveal\(\);[\s\S]*?surface\.commitState\(finalResult\);[\s\S]*?await onRoutingDispatch\(\{ result: finalResult, dispatch: routingDispatch \}\);[\s\S]*?\} else \{/, 'on a decided routing turn the stream reveals the whole send-off, commits state, then hands the dispatch to the in-turn handler');

  // The conversation turn stream opts into the routing dispatch choreography next to the stage move.
  assert.match(js, /async function runConversationStream\(\{ playerInput, provider, refreshAfter = true \}\)[\s\S]*?onStageMove: performStageMoveTransition,[\s\S]*?onRoutingDispatch: performRoutingTurnDispatch/, 'the conversation turn stream should route an in-turn routing dispatch through performRoutingTurnDispatch');

  // The in-turn dispatch is routing-gated and present only on a decided turn.
  assert.match(js, /function isRoutingTurnDispatch\(result\)[\s\S]*?currentPlayMode === 'routing' && Boolean\(result\?\.routing_dispatch\)/, 'an in-turn routing dispatch is gated on routing mode and the presence of routing_dispatch');

  // performRoutingTurnDispatch reuses the shared fail-fast validators against the authoritative
  // transition, asserts the dispatch-aware finalization status (queued for content, drained for the
  // wrap-up exit), fail-fasts on missing/invalid post-dispatch state then adopts it (no default-value
  // fallback, no double week application), wraps up to the title screen for the wrap-up destination, routes a
  // map arrival into the shared arriveAtRoutingAcademyMap helper (strict field refresh + placement reroll +
  // pending event scan), and otherwise refreshes the server-evaluated field under the loading screen (the
  // dispatch progressed the week server-side) before showing the remaining content destinations.
  assert.match(js, /async function performRoutingTurnDispatch\(\{ result, dispatch \}\)[\s\S]*?const dispatchScreen = validateRoutingDispatchScreen\(dispatch\);[\s\S]*?assertRoutingDispatchFinalization\(dispatch, result\.finalization_status\);[\s\S]*?result\.transition\?\.next_screen !== dispatchScreen[\s\S]*?throw new Error[\s\S]*?if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?currentRuntimeState = result\.state;[\s\S]*?if \(dispatchScreen === 'title'\) \{[\s\S]*?showRoutingWrapUpTitleTransition\(\)[\s\S]*?\}[\s\S]*?if \(dispatchScreen === 'academy-map'\) \{[\s\S]*?await arriveAtRoutingAcademyMap\(\{ loadingCopy: routingDispatchLoadingCopy\(dispatch\), allowDuringInFlight: true \}\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?showAcademyLoadingScreenUntilReady\(\{[\s\S]*?nextScreen: dispatchScreen,[\s\S]*?refreshBeforeNextScreen: true,[\s\S]*?strictFieldRefresh: true,[\s\S]*?loadingCopy: routingDispatchLoadingCopy\(dispatch\)[\s\S]*?\}\);/, 'the in-turn dispatch validates the dispatch + finalization status against the authoritative transition, fail-fasts on missing post-dispatch state then adopts it, wraps up to the title screen for the wrap-up exit, routes a map arrival into the shared arriveAtRoutingAcademyMap helper, and otherwise refreshes the field behind the loading screen before showing the destination');

  // The in-turn dispatch must NOT reuse the end-path content-return navigation: the destination is
  // always a content screen, never a hub re-open.
  const dispatchFn = js.match(/async function performRoutingTurnDispatch\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(dispatchFn, /navigateToPostContentScreen|enterRoutingHub/, 'the in-turn dispatch must not reuse the end-path content-return navigation (no navigateToPostContentScreen / hub re-open)');
  assert.doesNotMatch(dispatchFn, /\?\? currentRuntimeState/, 'the in-turn dispatch must not introduce a default-value fallback on the authoritative post-dispatch state');

  // runConversation, stream path: a dispatched routing turn returns immediately (the queue drained
  // during the turn) instead of auto-ending or refreshing the now-closed hub.
  assert.match(js, /const result = await runConversationStream\(\{ playerInput, provider, refreshAfter: false \}\);[\s\S]*?if \(isRoutingTurnDispatch\(result\)\) return;[\s\S]*?if \(await autoEndConversationAfterFinalReply\(result\)\) return;[\s\S]*?await refresh\(\)/, 'the streaming turn path returns after an in-turn routing dispatch instead of auto-ending/refreshing the closed hub');

  // runConversation, non-stream path: the same dispatch is consumed here (the non-stream turn never
  // reaches the SSE seam); the send-off renders sequentially, then the dispatch moves on and returns.
  assert.match(js, /if \(conversationShouldAutoEnd\(result\) \|\| isRoutingTurnDispatch\(result\) \|\| isRoutingGraduationGuideSelection\(result\)\) \{[\s\S]*?await renderConversationResultSequentially\(result\);[\s\S]*?\} else \{[\s\S]*?renderConversationResult\(result, \{ revealAssistant: true \}\);[\s\S]*?\}[\s\S]*?if \(isRoutingTurnDispatch\(result\)\) \{[\s\S]*?await performRoutingTurnDispatch\(\{ result, dispatch: result\.routing_dispatch \}\);[\s\S]*?return;[\s\S]*?\}/, 'the non-stream turn path renders the send-off (dispatch or graduation guide selection) sequentially then consumes the in-turn routing dispatch before the loop auto-end');

  // Drain-on-exit: runConversation's finally only clears the in-flight flag and re-enables controls —
  // there is no background idle-drain re-trigger, because the dispatch itself fully drained the queue.
  assert.match(js, /\} finally \{\s*\n\s*conversationRequestInFlight = false;\s*\n\s*setConversationControlsDisabled\(false\);\s*\n\s*\}/, 'runConversation settles by clearing the in-flight flag and controls, with no background idle-drain re-trigger');
  assert.doesNotMatch(js, /routingDispatched|maybeDriveRoutingIdleFinalizeDrain|activeRoutingIdleContentScreen/, 'the removed dispatch-settle idle-drain re-trigger and its helper must not remain');
});

test('routing dungeon dispatch enters the run directly (hub → loading → dungeon board) instead of the operable pre-entry screen, on both the in-turn and end-button paths', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // Both routing dispatch paths intercept the dungeon destination and hand off to the shared direct-entry
  // helper, returning BEFORE the generic destination navigation — so the operable academy-dungeon pre-entry
  // screen is never shown as the landing screen. The in-turn dispatch branches before its
  // showAcademyLoadingScreenUntilReady block; the end-button navigator branches as the sibling of the
  // 'interaction' hub re-open (a destination that needs an action, not just a screen show).
  const dispatchFn = js.match(/async function performRoutingTurnDispatch\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(dispatchFn, /if \(dispatchScreen === 'academy-dungeon'\) \{[\s\S]*?await performRoutingDungeonDirectEntry\(\{ loadingCopy: routingDispatchLoadingCopy\(dispatch\) \}\);[\s\S]*?return;[\s\S]*?\}/, 'the in-turn dispatch enters the dungeon run directly for the dungeon destination and returns before the generic navigation');
  const navFn = js.match(/async function navigateToPostContentScreen\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(navFn, /if \(nextScreen === 'academy-dungeon'\) \{[\s\S]*?await performRoutingDungeonDirectEntry\(\{ loadingCopy \}\);[\s\S]*?return;[\s\S]*?\}/, 'the end-button post-content navigation enters the dungeon run directly for the dungeon destination and returns before the generic navigation');

  // performRoutingDungeonDirectEntry: keep the loading screen up, strictly refresh the week-progressed
  // field (fail-fast, un-strand to the hub — the same routing content-arrival contract), then auto-run the
  // SAME enter path the pre-entry screen's enter button drives (shared SSE controller + dungeon surface,
  // board buffered on dungeon_enter, board revealed by showPlay on the first opening token / after the
  // minimum hold). Only then does the run board render — no operable intermediate screen is shown.
  const directFn = js.match(/async function performRoutingDungeonDirectEntry\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(directFn, 'performRoutingDungeonDirectEntry exists');
  assert.match(directFn, /showScreen\('academy-loading'\);[\s\S]*?await refresh\(\{ strictField: true \}\);/, 'the direct entry holds the loading screen and strictly refreshes the server field (no stale-field dungeon entry)');
  assert.match(directFn, /catch \(error\) \{[\s\S]*?reportLoadingError\(error\);[\s\S]*?settingsRedirectErrorMessage\(error\) == null[\s\S]*?showScreen\('routing-hub'\);[\s\S]*?return;[\s\S]*?\}/, 'a failed field refresh surfaces the cause and un-strands to the hub (never a terminal loading screen, never a stale-field render)');
  assert.match(directFn, /surface: dungeonChatSurface,[\s\S]*?endpoint: '\/api\/dungeon\/enter',[\s\S]*?onEvent: \(event, data\) => \{ if \(event === 'dungeon_enter'\) \{ bufferedView = data\.view; notifyAcademyLoadingProgress\(\); \} \},[\s\S]*?onAssistantStreamStart: \(\) => showPlay\(\)/, 'the direct entry reuses the existing dungeon enter stream (shared SSE controller, dungeon surface, buffered board, showPlay on the first opening token)');
  assert.match(directFn, /const showPlay = \(\) => \{[\s\S]*?showScreen\('academy-dungeon', \{ skipDungeonRefresh: true \}\);\s*renderDungeonPlay\(bufferedView\);/, 'the direct entry reveals the buffered run board (skipDungeonRefresh), never the operable pre-entry screen');

  // Fail-fast landing: an enter/opening failure (LM unavailable, an already-active/held run, ...) is
  // surfaced and lands on the OPERABLE pre-entry screen (academy-dungeon → refreshDungeonScreen resumes a
  // held run or shows the entry to retry) — NOT the loop room, and never a silent retry / silent fallback.
  const enterCatch = directFn.match(/onAssistantStreamStart: \(\) => showPlay\(\)[\s\S]*?\}\);[\s\S]*?showPlay\(\);[\s\S]*?\} catch \(error\) \{[\s\S]*?\n  \} finally \{/)?.[0] ?? '';
  assert.match(enterCatch, /showScreen\('academy-dungeon'\);\s*reportError\(error\);/, 'an enter failure lands on the operable dungeon pre-entry screen and surfaces the error');
  assert.doesNotMatch(enterCatch, /academy-room/, 'the routing direct-entry enter failure lands on academy-dungeon (routing), not the loop academy-room');

  // Boardless-success guard: if the enter stream resolves WITHOUT a dungeon_enter board event, bufferedView
  // stays null and showPlay is a no-op — the loading screen would be terminal. The direct entry fail-fasts
  // (throws) so the enter catch above lands the player on the operable pre-entry screen and surfaces the
  // error, instead of silently stranding the loader (a failed /api/dungeon/enter already throws upstream).
  assert.match(directFn, /await minimumDisplay;[\s\S]*?if \(!bufferedView\) \{[\s\S]*?throw new Error\('dungeon enter: stream completed without a dungeon_enter board event'\);[\s\S]*?\}[\s\S]*?showPlay\(\);/, 'the direct entry fail-fasts when the enter stream delivered no board (never a terminal loading screen)');

  // Loop byte-equivalence: enterDungeon (the pre-entry screen's enter button) is untouched — it still shows
  // its own loading screen and lands on academy-room on failure, so loop dungeon entry is unchanged.
  assert.match(js, /async function enterDungeon\(\)[\s\S]*?showScreen\('academy-loading'\)[\s\S]*?catch \(error\) \{[\s\S]*?showScreen\('academy-room'\)[\s\S]*?reportError\(error\)/, 'the loop enterDungeon path is unchanged (own loading screen, academy-room on failure)');
});

test('routing hub conversation shows ルミ with her persona variant visual (never セラ/character_001) on the routing hub stage, preserves the routing actor, and sends the routing id + actor on turns', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const fn = (name) => {
    const match = js.match(new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`function not found in app.js: ${name}`);
    return match[0];
  };

  // Identity: the routing hub is identified exactly as the backend does — the routing_hub marker plus
  // the routing persona actor id — reusing the shared constant rather than baking in ad-hoc 'lina'
  // literals. The display name is per-variant, so it is not part of the identity.
  assert.match(js, /function isRoutingHubConversation\(conversation\)[\s\S]*?conversation\?\.routing_hub[\s\S]*?conversation\.character_id === ROUTING_PERSONA_CHARACTER_ID/, 'the routing hub identity mirrors the backend marker (routing_hub + routing persona id)');

  // Adopt: entering the hub fail-fasts on a non-hub response AND on a missing/empty conversation id
  // (a concrete id is the source of the deterministic-continuation contract), then pins the routing
  // actor and remembers the hub conversation id.
  assert.match(fn('enterRoutingHubConversation'), /if \(!isRoutingHubConversation\(conversation\)\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?if \(typeof conversationId !== 'string' \|\| conversationId === ''\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?routingHubConversationId = conversationId;[\s\S]*?activeCharacterId = conversation\.character_id;/, 'adopting the hub fail-fasts on a non-hub response and on a missing/empty conversation id, then binds the routing conversation id and actor');
  // The active-state predicate requires a concrete id string, so an undefined/empty id is never treated
  // as an active hub (a turn body must not send id: undefined and silently drop to implicit continuation).
  assert.match(fn('isRoutingHubActive'), /typeof routingHubConversationId === 'string' && routingHubConversationId !== ''/, 'isRoutingHubActive requires a concrete conversation id string, not merely !== null');

  // Actor preservation: while the hub is active, refreshCharacters() must not reset the routing actor to
  // the selectable-roster head (character_001 / セラ). Preservation runs through the single
  // non-selectable-actor predicate, which keeps the routing persona inside a live hub.
  assert.match(js, /function activeActorIsRoutingPersona\(\)[\s\S]*?isRoutingHubActive\(\) && activeCharacterId === ROUTING_PERSONA_CHARACTER_ID/, 'the routing persona actor is the preserved lina slot inside a live hub');
  assert.match(fn('refreshCharacters'), /if \(!isNonSelectableActiveActorId\(activeCharacterId\)\)/, 'refreshCharacters preserves non-selectable active actors (routing persona / creatures / homunculus) through the single predicate instead of resetting to the roster head');
  assert.match(fn('isNonSelectableActiveActorId'), /isRoutingHubActive\(\) && characterId === ROUTING_PERSONA_CHARACTER_ID/, 'the non-selectable-actor predicate preserves the routing persona while the hub is live');

  // Speaker name = the active variant's display name, face = her persona variant set: the routing
  // persona actor is the registered non-selectable visual summary, so activeCharacter() resolves it
  // before the roster head and the face/standee render the persona's own art — never セラ / character_001.
  const personaActor = fn('routingPersonaActor');
  assert.match(personaActor, /if \(!routingPersonaVisual\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?return routingPersonaVisual;/, 'the routing persona actor returns the registered visual summary and fail-fasts when it is not registered (no blank fallback)');
  assert.doesNotMatch(personaActor, /character_001|selectableCharacters/, 'the routing persona actor must not borrow another character or the selectable roster');
  // The visual summary is registered from the backend routing-hub-start response and validated for the
  // routing actor id + a non-empty per-variant display name + the full variant visual fields (no blank /
  // roster-head fallback).
  assert.match(fn('registerRoutingPersonaVisual'), /summary\.character_id !== ROUTING_PERSONA_CHARACTER_ID[\s\S]*?typeof summary\.display_name !== 'string'[\s\S]*?summary\.display_name === ''[\s\S]*?throw new Error[\s\S]*?!summary\.visual_set_id \|\| !summary\.face_url \|\| !summary\.selection_icon_url \|\| !summary\.standee_url[\s\S]*?throw new Error[\s\S]*?routingPersonaVisual = summary;/, 'registering the routing persona visual fail-fasts on the wrong actor or missing display name / visual fields, then stores the summary');
  assert.match(fn('enterRoutingHub'), /registerRoutingPersonaVisual\(result\.routing_persona_visual\)/, 'entering the hub registers the routing persona visual from the backend response');
  assert.match(fn('activeCharacter'), /if \(activeActorIsRoutingPersona\(\)\) return routingPersonaActor\(\);/, 'activeCharacter resolves the routing persona before the selectable-roster head');

  // Routing-scoped visual resolution: sourceSheetImageUrl resolves the non-selectable routing actor
  // registry BEFORE the selectable roster, so ルミ's face uses her variant set; the old routing-persona
  // blank branch is gone, and a missing visual_set_id still fail-fasts.
  assert.match(fn('routingActorById'), /if \(characterId !== ROUTING_PERSONA_CHARACTER_ID\) return null;[\s\S]*?if \(!activeActorIsRoutingPersona\(\)\) return null;[\s\S]*?return routingPersonaActor\(\);/, 'the routing actor registry resolves only the routing persona id while the hub is live (routing-scoped)');
  assert.match(fn('sourceSheetImageUrl'), /const character = routingActorById\(characterId\)[\s\S]*?\?\? selectableCharacters\.find/, 'sourceSheetImageUrl resolves the routing actor registry before the selectable roster');
  assert.doesNotMatch(fn('sourceSheetImageUrl'), /=== ROUTING_PERSONA_CHARACTER_ID\) return '';/, 'the routing-persona blank-face branch is removed (ルミ renders her real variant face)');
  assert.match(fn('sourceSheetImageUrl'), /if \(!visualSetId\) throw new Error/, 'an actor with no visual_set_id fails fast instead of silently blanking or requesting a /undefined/ face');
  assert.match(fn('setActorImageSource'), /if \(!url\) \{[\s\S]*?image\.removeAttribute\('src'\);[\s\S]*?image\.style\.visibility = 'hidden';[\s\S]*?return;[\s\S]*?\}/, 'the actor image setter still hides an empty/broken source (creatures, broken images)');
  assert.match(js, /setActorImageSource\(face, sourceSheetImageUrl\(\{ expression:[^}]*view: 'face'/, 'the message face image goes through the image setter');
  assert.match(fn('renderAcademyConversationSessionScreen'), /setActorImageSource\(standee, characterSceneStandeeUrl\(selected\)\)/, 'the session standee goes through the image setter');

  // Stage = ルーティングハブ (blank background). The conversation-session stage card follows the hub stage
  // while the hub is active regardless of the field location that refresh()/renderField feeds in.
  assert.match(js, /const ROUTING_HUB_STAGE = Object\.freeze\(\{[\s\S]*?display_name: 'ルーティングハブ',[\s\S]*?background_url: ''[\s\S]*?\}\);/, 'the routing hub stage is a blank-background meta location named ルーティングハブ');
  assert.match(fn('renderInteractionLocation'), /const sessionLocation = isRoutingHubActive\(\) \? ROUTING_HUB_STAGE : location;/, 'the conversation-session stage card follows the routing hub stage while the hub is active (field location otherwise)');

  // Turn send: a routing turn carries the routing conversation id + the preserved routing actor; a
  // non-routing turn omits id (loop / normal interaction byte-equivalent). Both send paths build the
  // body through the shared helper.
  assert.match(fn('routingTurnRequestBody'), /const body = \{ character_id: activeCharacterId, \.\.\.extra \};[\s\S]*?if \(isRoutingHubActive\(\)\) body\.id = routingHubConversationId;[\s\S]*?return body;/, 'the turn body sends the routing conversation id only while a hub is active, keeping the preserved actor');
  assert.match(js, /body: routingTurnRequestBody\(\{ player_input: playerInput, provider: provider \}\)/, 'the streaming turn body is built through routingTurnRequestBody');
  assert.match(js, /postJson\('\/api\/conversation', routingTurnRequestBody\(\{ player_input: playerInput, provider: provider \}\)\)/, 'the non-stream turn body is built through routingTurnRequestBody');

  // Leaving the hub clears the routing id so a destination content screen / later normal interaction is
  // not treated as a routing hub.
  assert.match(fn('performRoutingTurnDispatch'), /clearRoutingHubConversation\(\);/, 'an in-turn dispatch clears the routing hub state before moving to the destination');
  assert.match(fn('endRoutingConversation'), /clearRoutingHubConversation\(\);/, 'routing conversation end clears the routing hub state');
  assert.match(fn('startAcademyConversationSessionFromCompanion'), /clearRoutingHubConversation\(\);/, 'starting a field / academy-map companion conversation clears any routing hub state (migrated from the removed field-interaction start)');

  // Restore/resume: every play-entry point (new game / load / resume) resets the routing hub state
  // before its mode branch. A routing entry re-adopts the hub through the loading-screen entry wrapper
  // enterRoutingHubFromPlayEntry (which shows the loading screen, then enterRoutingHub re-opens /
  // resumes the persisted hub and re-binds lina + the routing id); a loop entry must not inherit a
  // stale hub id (and its actor / stage / turn-id behavior) from a prior in-run routing session.
  assert.match(fn('startNewGame'), /clearRoutingHubConversation\(\);[\s\S]*?if \(route\.mode === 'routing'\) \{[\s\S]*?await enterRoutingHubFromPlayEntry\('title'\);/, 'starting a new game clears stale routing hub state, then a routing entry re-adopts via the loading-screen entry wrapper');
  assert.match(fn('loadSpecificSlot'), /clearRoutingHubConversation\(\);[\s\S]*?if \(route\.mode === 'routing'\) \{[\s\S]*?await enterRoutingHubFromPlayEntry\('slot-load'\);/, 'loading a slot clears stale routing hub state, then a routing slot re-adopts via the loading-screen entry wrapper');
  assert.match(fn('resumePlayFromSlotLoad'), /clearRoutingHubConversation\(\);[\s\S]*?if \(slotLoadEntryRoute\.mode === 'routing'\) \{[\s\S]*?await enterRoutingHubFromPlayEntry\('slot-load'\);/, 'resuming play clears stale routing hub state, then a routing resume re-adopts via the loading-screen entry wrapper');
});

test('routing hub is a dedicated screen with its own moonlit shell, category rail, and info popup (index.html)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const block = html.match(/<section id="routing-hub-screen"[\s\S]*?<\/section>\s*\n\s*<section id="academy-training-screen"/)?.[0] ?? '';
  assert.notEqual(block, '', 'a dedicated #routing-hub-screen section should exist before the academy training screen');

  // Metaphysical moonlit backdrop: static background image, starfield canvas, floating decor PNGs.
  assert.match(block, /class="routing-hub-background"/, 'the hub should carry its own metaphysical background layer');
  assert.match(block, /<canvas id="routing-hub-starfield"/, 'the hub should carry a starfield canvas');
  assert.match(block, /src="\/canonical\/routing\/decor\/decor_01\.png"[\s\S]*decor_02\.png[\s\S]*decor_03\.png/, 'the hub should place the three generated floating decor PNGs');

  // Subtle top week + moon phase.
  assert.match(block, /id="routing-hub-moon-phase"[\s\S]*id="routing-hub-week"/, 'the topbar should carry the moon-phase glyph and the week counter');

  // Left category rail: the seven confirmed categories (self/buddy/enemy/inventory/money + diary + the hub-only
  // 収蔵庫 library collection), each with its generated icon.
  for (const [category, icon] of [['self', 'self'], ['buddy', 'buddy'], ['enemy', 'enemy'], ['inventory', 'inventory'], ['money', 'money'], ['diary', 'diary'], ['library', 'library']]) {
    assert.match(block, new RegExp(`data-routing-category="${category}"[\\s\\S]*?src="/canonical/routing/icons/${icon}\\.png"`), `the ${category} category button should carry its generated icon`);
  }

  // ルミ standee (no speaker caption — no text label around the frame) + dedicated chat panel (own message
  // stream / status / input / send / end).
  assert.match(block, /<img id="routing-hub-standee"[^>]*class="routing-hub-standee"/, 'the stage carries the ルミ standee image');
  assert.doesNotMatch(block, /routing-hub-speaker-name/, 'the stage no longer carries a speaker-name caption (no character/stage text label around the frame)');
  assert.match(block, /id="routing-hub-message-stream"[^>]*aria-live="polite"/, 'the hub chat has its own live message stream');
  assert.match(block, /<p id="routing-hub-status"[^>]*aria-live="polite" hidden>/, 'the hub chat has its own status live region, hidden by default');
  assert.match(block, /<textarea id="routing-hub-input"/, 'the hub chat has its own composer input');
  assert.match(block, /id="routing-hub-send"[\s\S]*id="routing-hub-end"/, 'the hub chat has its own send + end controls');

  // Info popup toggled via the hidden attribute (guarded), with a close affordance.
  assert.match(block, /<div id="routing-hub-info-popup" class="routing-hub-info-popup" hidden>/, 'the info popup starts hidden (toggled via the hidden attribute)');
  assert.match(block, /data-routing-popup-close="true"/, 'the info popup has a close affordance');

  // The persona name is never hardcoded in the hub markup (it appears only in the chat bubbles at render,
   // via assistantIdentity — the standee frame carries no caption). Mirrors the settings-card no-hardcoded-name rule.
  assert.doesNotMatch(block, /ルミ/, 'the hub markup must not hardcode a persona name (it renders in the chat bubbles only, not a frame caption)');
});

test('routing hub uses a clean dedicated chat separate from the shared academy session chat (app.js + conversationStage.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  // The reusable conversation-stage component (conversationStage.js) owns the invariant chat mechanics; the
  // routing hub is its first consumer (createConversationStage bound to the #routing-hub-* scope). The pins
  // below verify the mechanic in the shared module AND the routing consumer wiring, at the same strength as
  // when the machinery lived inline in app.js (the rename follows the extraction; nothing is weakened).
  const stageJs = await readFile(path.join(root, 'conversationStage.js'), 'utf8');

  // Registered screen + render hook + entry rewired to the dedicated screen (rendered through the stage).
  assert.match(js, /'routing-hub': document\.querySelector\('#routing-hub-screen'\)/, 'the routing hub should be a registered screen');
  assert.match(js, /if \(name === 'routing-hub'\) routingHubStage\.renderScreen\(\);/, 'showScreen should render the routing hub through the shared stage');
  assert.match(js, /async function enterRoutingHub\(\{ allowDuringInFlight = false \} = \{\}\)[\s\S]*?showScreen\('routing-hub'\);[\s\S]*?revealResultSequentially\(routingHubStage\.surface, result\)/, 'routing entry opens the dedicated hub screen and reveals the opening on its own stage chat surface');

  // Dedicated stage instance with its own history + surface, distinct from the shared messageHistory /
  // academyChatSurface: the routing hub instantiates createConversationStage over the #routing-hub-* scope,
  // and the stage owns its own history behind getHistory/setHistory.
  assert.match(js, /const routingHubStage = createConversationStage\(\{[\s\S]*?screenSelector: '#routing-hub-screen'/, 'the routing hub is a consumer of the shared conversation stage (its own #routing-hub-* scoped instance)');

  // The frame still shows the ルミ standee (standeeSelector kept, unlike the daytime consumer) but no longer a
  // speaker-name caption: the speakerSelector is dropped so renderScreen's speaker block is a guarded no-op.
  assert.match(js, /const routingHubStage = createConversationStage\(\{[\s\S]*?standeeSelector: '#routing-hub-standee',/, 'the routing hub still renders the ルミ standee (standeeSelector kept)');
  assert.doesNotMatch(js, /const routingHubStage = createConversationStage\(\{[\s\S]*?speakerSelector:[\s\S]*?\}, \{/, 'the routing hub stage config no longer passes a speakerSelector (no speaker-name caption)');
  assert.match(stageJs, /export function createConversationStage\(config, deps\)[\s\S]*?let history = \[\];[\s\S]*?getHistory\(\) \{ return history; \}[\s\S]*?setHistory\(messages\) \{ history = messages; \}/, 'the stage keeps its own message history behind get/setHistory (separate from the shared messageHistory)');
  assert.match(stageJs, /surface: \{[\s\S]*?getHistory: \(\) => history/, 'the stage exposes a chat surface over its own history');

  // 統一出現規律: every 吹き出し種別 (主人公の発話/地の文・ルミの発話/地の文・見送り) is revealed as a 完成した
  // 吹き出し単位 through ONE cooldown-paced queue (the stage's createTurnReveal over the module's
  // createConversationStageTurnReveal), each carrying the pop-in animation — never partial characters, never
  // all-at-once. The old live partial-prefix reveal (routingHubRevealablePrefix / renderLive) is gone.
  assert.doesNotMatch(js, /routingHubRevealablePrefix|function renderLive\b/, 'the live partial-text reveal (routingHubRevealablePrefix / renderLive) is removed in favour of the unified completed-吹き出し queue');
  const turnRevealFn = stageJs.match(/export function createConversationStageTurnReveal\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(turnRevealFn, '', 'createConversationStageTurnReveal should exist in the shared stage module');
  const stageCreateTurnReveal = stageJs.match(/createTurnReveal\(baseMessages\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(stageCreateTurnReveal, /popFromDisplayIndex: baseDisplayCount \+ revealed\.length - 1/, 'only the newest revealed 吹き出し pops in (its display index); earlier 吹き出し stay put');
  assert.match(turnRevealFn, /await cooldownGate;[\s\S]*?cooldownGate = sleep\(cooldownMs\(\)\);/, 'the reveal queue spaces every 吹き出し by the injected cooldown (等間隔・設定値から導出、独自定数への hardcode なし)');
  assert.match(stageCreateTurnReveal, /cooldownMs: deps\.conversationPopupCooldownMs/, 'the routing stage feeds the configurable popup cooldown into the reveal queue (no独自定数 hardcode)');
  const hubTurnStreamFn1 = js.match(/async function runRoutingHubTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(hubTurnStreamFn1, /reveal\.enqueue\(displayMessages\(\[\{ role: 'user', content: playerInput \}\]\)\)/, 'the player utterance is revealed through the same queue as ルミの応答 (主人公も同一規律)');
  assert.match(hubTurnStreamFn1, /if \(event === 'assistant_delta'\) \{[\s\S]*?enqueueAssistantSegments\(completedAssistantPrefix\(assistantText\)\)/, 'streamed deltas are folded into 完成した吹き出し単位 (completedAssistantPrefix), never streamed in char by char');

  // Bug avoided #2 (status swallowed): the stage status writes immediately (no rAF debounce).
  const routingHubStatusFn = stageJs.match(/setStatus\(text[\s\S]*?\n    \},/)?.[0] ?? '';
  assert.notEqual(routingHubStatusFn, '', 'the stage setStatus should exist in the shared module');
  assert.match(routingHubStatusFn, /status\.textContent = message;\s*\n\s*status\.dataset\.tone = tone;/, 'the stage status writes to its live region immediately');
  assert.doesNotMatch(routingHubStatusFn, /requestAnimationFrame/, 'the stage status must not defer through requestAnimationFrame');

  // Bug avoided #6 (a status-line toggle shrinks the stream and breaks bottom-follow): the status row sits
  // below the stream and claims layout height when shown (flex:0 0 auto; min-height:1.2em), so toggling
  // it visible shrinks the stream's clientHeight and flips the NEXT render's at-bottom gate to false —
  // stranding ルミの応答 below the fold. The hub no longer surfaces in-progress status text, so this now
  // guards the error banner's show/hide (the endRoutingConversation defense line). setStatus samples the
  // at-bottom state BEFORE the toggle and re-pins to the bottom after it only when the reader was there (a
  // scrolled-up reader is left in place). Status-height companion to the image-load re-pin.
  assert.match(routingHubStatusFn, /const stream = el\(config\.streamSelector\);\s*\n\s*const stick = stream \? stage\.streamIsAtBottom\(stream\) : false;/, 'setStatus samples at-bottom BEFORE toggling the status line (its visibility shrinks/grows the stream)');
  assert.match(routingHubStatusFn, /if \(stick && stream\) stream\.scrollTop = stream\.scrollHeight;/, 'setStatus re-pins the stream to the bottom after the toggle only when the reader was at the bottom');

  // Bug avoided #3 (forced scroll): only sticks to the bottom when already at the bottom (a scrolled-up
  // reader keeps their position; the stick branch returns early when not at the bottom).
  const renderStreamFn0 = stageJs.match(/renderStream\(messages = history[\s\S]*?\n    \},/)?.[0] ?? '';
  assert.notEqual(renderStreamFn0, '', 'the stage renderStream should exist in the shared module');
  assert.match(renderStreamFn0, /const stick = stage\.streamIsAtBottom\(stream\);[\s\S]*?if \(!stick\) return;\s*\n\s*stream\.scrollTop = stream\.scrollHeight;/, 'the stage stream only auto-scrolls when the reader is already at the bottom');

  // Bug avoided #5 (edit loses routing context): the stage renders rows with allowEdit=false, so there is
  // no past-message edit affordance / edit path in the routing hub at all.
  assert.match(renderStreamFn0, /deps\.createMessageRows\(deps\.displayMessages\(messages\), popFromDisplayIndex, false\)/, 'the stage renders messages with no edit affordance');

  // Bug avoided #4 (no rollback): the hub send (the routing consumer) snapshots history + input before the
  // optimistic render and restores both on failure — over the stage's own surface history.
  assert.match(js, /async function runRoutingHubConversation\(\)[\s\S]*?const historySnapshot = \[\.\.\.routingHubStage\.surface\.getHistory\(\)\];[\s\S]*?const inputSnapshot = /, 'the hub send snapshots history + input before the optimistic render');
  assert.match(js, /async function runRoutingHubConversation\(\)[\s\S]*?catch \(error\) \{[\s\S]*?routingHubStage\.surface\.setHistory\(historySnapshot\);[\s\S]*?routingHubStage\.renderStream\(historySnapshot\);[\s\S]*?input\.value = inputSnapshot;/, 'a failed hub send restores the pre-send history and input');

  // Byte-equivalence guard: the routing hub chat does not touch the shared academy chat state, so loop /
  // academy conversations are unchanged. The shared runConversation / academyChatSurface stay intact.
  assert.match(js, /const academyChatSurface = \{[\s\S]*?getHistory: \(\) => messageHistory/, 'the shared academy chat surface over messageHistory is untouched');
  const routingHubSendFn = js.match(/async function runRoutingHubConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(routingHubSendFn, '', 'runRoutingHubConversation should exist');
  assert.doesNotMatch(routingHubSendFn, /\bmessageHistory\b/, 'the routing hub send must not read or write the shared messageHistory (its own stage surface only)');

  // The hub mirrors the backend routing contract via the shared navigation (drain-on-exit dispatch).
  assert.match(js, /async function runRoutingHubTurnStream\([\s\S]*?performRoutingTurnDispatch\(\{ result: finalResult, dispatch: routingDispatch \}\)/, 'a decided hub turn hands off to the shared in-turn dispatch');
  // 見送り読みポーズ (並行): a 行き先確定 turn starts the ~5s reading pause the moment routing_draining reveals the
  // dispatch MID-STREAM, and runs it CONCURRENTLY with the backend drain (the SSE read loop stays open) instead
  // of serially after the result. The pause itself raises the drain loading screen only if it elapses before the
  // result arrives; if the result arrives first, the hub stays visible for the whole pause. The single 5s
  // constant and the SSE event order are unchanged.
  assert.match(js, /const DRAIN_READING_PAUSE_MS = 5000;/, 'the 見送り読みポーズ is a single 5s constant defined in one place (shared with the daytime 達成読みポーズ — no 5000 リテラル二重宣言)');
  assert.doesNotMatch(js, /ROUTING_SENDOFF_READING_PAUSE_MS/, 'the routing-specific reading-pause constant name is gone (superseded by the neutral shared DRAIN_READING_PAUSE_MS)');
  // Start-on-routing_draining is exactly what overlaps the pause with the drain: starting it after the read loop
  // would serialize it after the result (= after the drain), which was the old 直列 bug.
  assert.match(hubTurnStreamFn1, /if \(event === 'routing_draining'\) \{\s*\n\s*beginSendoffReadingPause\(\);/, 'routing_draining starts the 見送り読みポーズ mid-stream so it overlaps the backend drain');
  // The pause pipeline: drain the send-off 吹き出し, hold the ~5s read, then — only if the drain has not yet
  // delivered the result — play ③ and raise the drain loading screen (streamFailed suppresses that after an
  // error, so a failed send that restored the hub does not spawn a late loading screen).
  const sendoffPauseFn = hubTurnStreamFn1.match(/function beginSendoffReadingPause\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(sendoffPauseFn, '', 'beginSendoffReadingPause should exist inside runRoutingHubTurnStream');
  assert.match(sendoffPauseFn, /await reveal\.drain\(\);[\s\S]*?await sleep\(DRAIN_READING_PAUSE_MS\);[\s\S]*?if \(!finalResult && !streamFailed\) \{\s*\n\s*routingHubStage\.flashDispatchClimax\(\);\s*\n\s*showRoutingDrainLoadingScreen\(\);/, 'the pause drains the send-off, holds the ~5s read, then raises the drain loading screen ONLY if the result has not yet arrived (result 先着ならハブ表示のまま)');
  // The dispatch branch awaits the concurrent pause, then hands off — playing ③ here only if the pause did not
  // already raise the loading screen, so ③ fires exactly once per decided turn.
  assert.match(hubTurnStreamFn1, /if \(routingDispatch\) \{[\s\S]*?await sendoffReadingPause;[\s\S]*?if \(!drainLoadingShown\) routingHubStage\.flashDispatchClimax\(\);\s*\n\s*await performRoutingTurnDispatch/, 'a decided turn awaits the concurrent 見送り読みポーズ, then plays ③ (once) and hands off to the dispatch');
  // Contract pairing: the pause is started iff the turn dispatches; a half-signalled stream (dispatch without a
  // drain signal, or a drain signal without dispatch) fails fast rather than degrading silently.
  assert.match(hubTurnStreamFn1, /Boolean\(routingDispatch\) !== Boolean\(sendoffReadingPause\)[\s\S]*?throw new Error/, 'the turn fails fast on a routing_draining / routing_dispatch mismatch (no silent tolerance)');
});

test('routing hub chat shows no in-progress status text — only the error banner remains (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const turnStreamFn = js.match(/async function runRoutingHubTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  const sendFn = js.match(/async function runRoutingHubConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  const endFn = js.match(/async function endRoutingConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(turnStreamFn, '', 'runRoutingHubTurnStream should exist');
  assert.notEqual(sendFn, '', 'runRoutingHubConversation should exist');
  assert.notEqual(endFn, '', 'endRoutingConversation should exist');

  // The decision: the routing hub does not display in-progress status text (the ① responding glow conveys
  // that a turn is in flight). All removed progress strings are gone from the client, comments included.
  assert.doesNotMatch(js, /応答を準備しています/, 'the "preparing response" progress text is removed');
  assert.doesNotMatch(js, /ルミが応答しています/, 'the "ルミ is responding" progress text is removed');
  assert.doesNotMatch(js, /送信しています/, 'the "sending" progress text is removed');

  // The SSE status event no longer surfaces a status line; assistant_delta keeps the responding glow and
  // folds completed 吹き出し単位 into the reveal queue, but sets no status text.
  assert.doesNotMatch(turnStreamFn, /event === 'status'/, 'the SSE status event no longer surfaces an in-progress status line');
  assert.match(turnStreamFn, /if \(event === 'assistant_delta'\) \{\s*\n\s*routingHubStage\.setResponding\(true\);[\s\S]*?enqueueAssistantSegments\(completedAssistantPrefix\(assistantText\)\);\s*\n\s*\}/, 'assistant_delta keeps the responding glow + queues completed 吹き出し but sets no status text');

  // Non-error stage-status calls clear the line (setStatus('')): the only non-empty hub status text is the error
  // banner (tone:error), on a failed send or a failed end. The turn stream itself carries no error banner (its
  // setStatus calls all clear); the send path's catch shows the banner. A revert that re-adds in-progress progress
  // text fails here.
  assert.doesNotMatch(turnStreamFn, /routingHubStage\.setStatus\((?!'')/, 'the turn stream sets no non-empty hub status text (in-progress text removed)');
  assert.doesNotMatch(sendFn, /routingHubStage\.setStatus\((?!''|errorDisplayMessage\(error\))/, 'the send path sets no non-empty hub status text other than the error banner (no in-progress text)');
  assert.match(sendFn, /routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\)/, 'a failed hub send shows the cause on the hub error banner (tone:error), the same surface as the routing-end defense');

  // Error banner preserved: the endRoutingConversation defense line also surfaces the cause with tone:error.
  assert.match(endFn, /routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\)/, 'the routing-end defense line still shows the error cause on the hub status (tone:error)');
});

test('a failed routing hub decision turn shows the cause on the hub error banner, not the conversation-session status (app.js)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const sendFn = js.match(/async function runRoutingHubConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(sendFn, '', 'runRoutingHubConversation should exist');

  // A decision-turn (send) failure must be visible on the hub the player is returned to. The cause is shown on the
  // hub error banner (routingHubStage.setStatus(..., {tone:'error'})) — the same display surface and discipline as
  // endRoutingConversation's failed-end defense — inside the send path's own catch.
  assert.match(sendFn, /catch \(error\) \{[\s\S]*?routingHubStage\.setStatus\(errorDisplayMessage\(error\), \{ tone: 'error' \}\);/, 'a failed hub decision turn shows the cause on the hub error banner (tone:error)');
  // The misrouting is gone: the hub send no longer reports through reportConversationError, which writes the
  // conversation-session status (#academy-conversation-session-status) that the routing hub player never sees.
  assert.doesNotMatch(sendFn, /reportConversationError/, 'the hub send does not route the failure to the conversation-session status (reportConversationError) — the hub player would never see it');
  // Pre-send snapshot restore is preserved: a failed send restores the committed history + input over the stage's
  // own surface, un-rendering the optimistic utterance instead of leaving it stranded.
  assert.match(sendFn, /catch \(error\) \{[\s\S]*?routingHubStage\.surface\.setHistory\(historySnapshot\);[\s\S]*?routingHubStage\.renderStream\(historySnapshot\);[\s\S]*?input\.value = inputSnapshot;/, 'the pre-send history + input snapshot restore is preserved on a failed send');
  // Settings-redirect is unchanged: invalid LLM output / LM Studio config failures still route to the settings
  // screen with the cause and return before the hub banner.
  assert.match(sendFn, /if \(handleRuntimeApiError\(error, \{ allowSettingsRedirect: true \}\)\) return;/, 'the settings-redirect path is unchanged (invalid LLM output / LM Studio config failures still route to settings)');
});

test('routing hub category rail opens info popups and the conversation-responsive animations are reduced-motion aware (app.js + conversationStage.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const stageJs = await readFile(path.join(root, 'conversationStage.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Category rail → drawer wiring (routing consumer → the stage's openInfo), close, and the [hidden]-toggle
  // (owned by the stage, never display:!important).
  assert.match(js, /for \(const button of document\.querySelectorAll\('\.routing-hub-category-button'\)\) \{[\s\S]*?routingHubStage\.openInfo\(button\.dataset\.routingCategory\)/, 'each category button opens the info drawer for its category through the stage');
  assert.match(stageJs, /closeInfo\(\) \{[\s\S]*?popup\.hidden = true;/, 'the drawer closes via the hidden attribute');
  assert.match(stageJs, /openInfo\(category\) \{[\s\S]*?popup\.hidden = false;/, 'the drawer opens via the hidden attribute');
  // 常時は出さない: the drawer is reset closed on every stage render and when leaving the hub, so it never
  // persists across a dispatch + restore.
  assert.match(stageJs, /renderScreen\(\) \{\s*\n\s*stage\.closeInfo\(\);/, 'the stage resets the info drawer closed on every render (no persistence onto the restored hub)');
  assert.match(js, /if \(name !== 'routing-hub'\) \{[\s\S]*?routingHubStage\.closeInfo\(\);/, 'leaving the routing hub closes the info drawer');
  // Info content reuses the same data sources the academy room surfaced (routing consumer category renderers).
  // The self panel renders the shared parameter groups (buildParameterGroups) into a パラメーター section.
  assert.match(js, /function renderRoutingHubSelfInto\(bodyEl\)[\s\S]*?const params = routingHubInfoSection\('パラメーター'\);[\s\S]*?params\.body\.append\(\.\.\.buildParameterGroups\(parameters\)\)/, 'the self category renders the shared parameter groups (over a validated parameter source) into a パラメーター section');
  assert.match(js, /selectedAcademyBuddyCharacterId\(\)[\s\S]*?selectedAcademyEnemyCharacterIds\(\)/, 'buddy/enemy categories reuse the academy relationship selectors');
  // Fail-fast (absolute-rules): unknown category, invalid week source, missing popup / icon nodes, and
  // broken info-data sources (player parameters / inventory items / money) surface the broken routing-home
  // state instead of degrading into a generic popup, a fabricated week, or empty/default data. The
  // category-set / node fail-fast is owned by the stage; the per-category data fail-fast is in the routing
  // renderers; the week fail-fast is in the shared conversationStageWeek fed by the routing consumer.
  assert.match(stageJs, /export function resolveConversationStageInfoCategoryTitle\(category, titles\)[\s\S]*?if \(!title\) \{[\s\S]*?throw new Error/, 'the stage fails fast on an unknown info category (no generic-title fallback)');
  assert.match(stageJs, /openInfo\(category\) \{\s*\n\s*const categoryTitle = resolveConversationStageInfoCategoryTitle\(category, config\.categoryTitles\);/, 'openInfo validates the category against the fixed set before opening');
  assert.match(js, /categoryTitles: ROUTING_HUB_CATEGORY_TITLES/, 'the routing consumer passes its fixed five-category title set to the stage');
  assert.match(stageJs, /openInfo\(category\)[\s\S]*?if \(!popup \|\| !title \|\| !bodyEl\) \{[\s\S]*?throw new Error/, 'openInfo fails fast when the popup nodes are missing (no silent no-op)');
  assert.match(js, /self: \(bodyEl\) => renderRoutingHubSelfInto\(bodyEl\)/, 'the self category delegates to the person-panel renderer');
  const selfPanelFn = js.match(/function renderRoutingHubSelfInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(selfPanelFn, '', 'renderRoutingHubSelfInto should exist');
  assert.match(selfPanelFn, /const parameters = currentWorld\?\.player_parameters;[\s\S]*?if \(!parameters[\s\S]*?throw new Error/, 'the self category fails fast on a missing player-parameter source (no ?? {} fallback)');
  assert.match(selfPanelFn, /loadRoutingHubPersonEquipInto\('self', 'player', equipment\.body\)\.catch\(reportError\)/, 'the self panel loads the hero 装備欄 (target player) below the parameters');
  assert.match(js, /function renderRoutingHubInventoryLedgerInto\(bodyEl, feedback = null\)[\s\S]*?const items = currentInventory\?\.items;[\s\S]*?if \(!Array\.isArray\(items\)\) \{[\s\S]*?throw new Error/, 'the inventory ledger fails fast on a missing/invalid inventory (empty array stays legitimate; no ?? [] fallback)');
  assert.match(js, /money: \(bodyEl\) => \{[\s\S]*?if \(!currentInventory[\s\S]*?throw new Error/, 'the money category fails fast on a missing currentInventory.money');
  const stageWeekFn = stageJs.match(/export function conversationStageWeek\(elapsedWeeks\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(stageWeekFn, /!Number\.isFinite\(elapsed\)[\s\S]*?throw new Error/, 'conversationStageWeek fails fast on a missing/invalid elapsed_weeks');
  assert.doesNotMatch(stageWeekFn, /Math\.min|Math\.max|: 1;/, 'conversationStageWeek must not fabricate a week or silently clamp the range');
  // The routing consumer feeds the runtime elapsed_weeks into the shared fail-fast week helper with no
  // guide-phase special-casing: the graduation guide holds elapsed_weeks at 49, so elapsed_weeks+1 already
  // reads 第50週 / 50 through the same derivation (the shared conversationStageWeek contract stays untouched —
  // no clamp, no pinned total-weeks branch, no guide-active helper).
  assert.match(js, /currentWeek: \(\) => conversationStageWeek\(currentRuntimeState\?\.elapsed_weeks\)/, 'the routing consumer feeds the runtime elapsed_weeks into the shared week helper with no guide-phase pin');
  assert.doesNotMatch(js, /routingGraduationGuideActive/, 'the guide-active week pin and its helper are removed (the guide week derives 第50週 / 50 from elapsed_weeks=49, not from a pinned branch)');

  // Conversation-responsive animation hooks on the SSE seams (routing consumer → the stage flashes).
  assert.match(js, /if \(event === 'assistant_delta'\) \{\s*\n\s*routingHubStage\.setResponding\(true\);/, '① the hub marks ルミ responding while streaming');
  assert.match(js, /routingHubStage\.flashPlayerSpoke\(\);/, '② the hub flares when the player speaks');
  // ③ the destination-decided climax (~900ms 月フレア) plays once per decided turn as the hub hands to the loading
  // screen: before performRoutingTurnDispatch when the result arrived within the ~5s pause (hub stayed visible),
  // OR before the drain loading screen inside the 見送り読みポーズ when the pause elapsed before the result. Both are
  // the same flashDispatchClimax hook (reduced-motion aware below).
  assert.match(js, /if \(!drainLoadingShown\) routingHubStage\.flashDispatchClimax\(\);\s*\n\s*await performRoutingTurnDispatch/, '③ plays on the hub before the in-turn dispatch when the hub stayed visible for the whole pause');
  assert.match(js, /routingHubStage\.flashDispatchClimax\(\);\s*\n\s*showRoutingDrainLoadingScreen\(\);/, '③ plays before the drain loading screen when the 見送り読みポーズ elapsed before the result');

  // Starfield honours reduced motion (static field, no rAF loop) — the codebase's reduced-motion rule; the
  // ambient strategy is the stage module's createStarfieldAmbient, which the routing consumer instantiates.
  assert.match(stageJs, /createStarfieldAmbient\([\s\S]*?matchMedia\('\(prefers-reduced-motion: reduce\)'\)/, 'the starfield ambient reads the reduced-motion preference');
  assert.match(stageJs, /start\(\) \{[\s\S]*?if \(reducedMotion\.matches\) \{[\s\S]*?draw\(ctx, width, height, 0\);\s*\n\s*return;/, 'reduced motion draws a static starfield without the animation loop');
  assert.match(js, /ambient: createStarfieldAmbient\(\{ canvasSelector: '#routing-hub-starfield'/, 'the routing consumer instantiates the starfield ambient over its own canvas');

  // Dedicated token layer (deep night / silver / navy / starlight), the [hidden] guard, moon phases,
  // and the reduced-motion disable — all scoped to the hub, academy tokens untouched.
  const screenBlock = cssRuleBlock(css, '.routing-hub-screen');
  assert.match(screenBlock, /--routing-night-0:[\s\S]*--routing-silver:[\s\S]*--routing-starlight:/, 'the hub defines its own night/silver/starlight token layer');
  assert.match(css, /#routing-hub-screen \[hidden\] \{\s*\n\s*display: none;/, 'the hub carries the id-scoped [hidden] guard for its popup');
  // The moon is a real image asset now (a circular-framed phase render): the frame clips its <img> to the
  // circle and shares the .moon-phase-image cover rule; the old per-phase CSS gradient rules are fully gone.
  assert.match(css, /\.routing-hub-moon-glyph \{[\s\S]*?overflow: hidden;[\s\S]*?\}/, 'the routing moon frame clips its phase image to the circular frame');
  assert.doesNotMatch(css, /\.routing-hub-moon-glyph\[data-phase/, 'the CSS glyph per-phase rules are fully removed (no data-phase残骸)');
  assert.match(css, /\.moon-phase-image \{[\s\S]*?object-fit: cover;[\s\S]*?\}/, 'the shared moon-phase-image rule cover-fits the phase image into its frame');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.routing-hub-decor,[\s\S]*?\.is-dispatch-climax[\s\S]*?animation: none;/, 'reduced motion disables the hub decor drift and the ①②③ animations');
  // 出現アニメーション無効 (reduced-motion): the routing hub 吹き出し pop-in fade is disabled (即時出現) while
  // the reveal queue keeps the 間隔規律. Routing-scoped so the shared loop/academy/dungeon pop-in stays
  // byte-equal — the disable selector must carry the .routing-hub-message-stream scope.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.routing-hub-message-stream \.chat-message\.pop-in[\s\S]*?animation: none;/, 'reduced motion disables the routing hub 吹き出し pop-in (即時出現) — the interval discipline is kept by the reveal queue, not the animation');
  // Byte-equal guard: the reduced-motion pop-in disable is only ever the routing-scoped selector; a bare
  // `.chat-message.pop-in { animation: none }` (which would also silence the shared academy/dungeon chat)
  // must not appear.
  for (const rmBlock of css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? []) {
    assert.doesNotMatch(rmBlock, /(^|[,{]\s*)\.chat-message\.pop-in\b/, 'no unscoped .chat-message.pop-in disable under reduced motion (keeps the shared chat pop-in byte-equal)');
  }
});

test('routing hub chat/standee polish: width lock, viewport-fit, bottom-follow, decorated standee frame, redesigned close button — routing-scoped so loop/academy/dungeon stay byte-equal (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // 1. WIDTH LOCK: the chat panel is grow-sized (flex-basis:0, not auto=max-content) so a long unbroken
  //    ルミ line cannot pry it wider; the stream clips horizontal overflow; the bubble wraps long text.
  const chatPanelCss = cssRuleBlock(css, '.routing-hub-chat-panel');
  assert.match(chatPanelCss, /flex:\s*1 1 0;/, 'the chat panel is grow-sized from a 0 basis so its width never follows content max-content');
  const streamCss = cssRuleBlock(css, '.routing-hub-message-stream');
  assert.match(streamCss, /min-width:\s*0;/, 'the message stream can shrink below content width');
  assert.match(streamCss, /overflow-x:\s*hidden;/, 'the message stream clips horizontal overflow instead of widening');
  const routingBubbleCss = cssRuleBlock(css, '.routing-hub-message-stream .message-bubble');
  assert.match(routingBubbleCss, /overflow-wrap:\s*anywhere;/, 'long ルミ text wraps inside the routing bubble');
  assert.match(routingBubbleCss, /max-width:\s*100%;/, 'the routing bubble is capped to its column instead of the shared min(680px, 78%)');

  // 2. VIEWPORT FIT: box-sizing:border-box so the padded frame/standee-frame include their padding in
  //    height:100% and never push the composer / send buttons below the clipped screen edge.
  const frameCss = cssRuleBlock(css, '.routing-hub-frame');
  assert.match(frameCss, /box-sizing:\s*border-box;/, 'the hub frame includes its padding in height:100% (no below-the-fold overflow of the chat controls)');
  // Fixed-size composer (うゆりす's 可変→固定 request): a fixed height + resize:none, absorbing overflow with an
  // internal scroll instead of a user-dragged handle changing the box height.
  const hubComposerTextareaCss = cssRuleBlock(css, '.routing-hub-composer textarea');
  assert.match(hubComposerTextareaCss, /height:\s*3\.2em;[\s\S]*?resize:\s*none;[\s\S]*?overflow-y:\s*auto;/, 'the hub composer input is a fixed 3.2em height, not user-resizable, absorbing overflow with an internal scroll');
  assert.doesNotMatch(hubComposerTextareaCss, /min-height:|resize:\s*vertical/, 'the hub composer input no longer uses the variable min-height / vertical drag-resize');
  // 2b. BOTTOM-RIGHT CONTROLS: the send + end row is right-aligned, so with the send-before-end DOM order
  //     (pinned above) 今日はここまで seats in the far bottom-right corner and 送信 sits to its left.
  const hubButtonRowCss = cssRuleBlock(css, '.routing-hub-button-row');
  assert.match(hubButtonRowCss, /justify-content:\s*flex-end;/, 'the hub send + end controls hug the bottom-right corner (今日はここまで rightmost, 送信 to its left)');

  // 3. BOTTOM-FOLLOW: the stage's renderStream re-pins to the bottom after each face image loads, so a new
  //    utterance is never left off-screen when the async face grows its row after the initial scroll.
  const stageJs = await readFile(path.join(root, 'conversationStage.js'), 'utf8');
  const renderStreamFn = stageJs.match(/renderStream\(messages = history[\s\S]*?\n    \},/)?.[0] ?? '';
  assert.notEqual(renderStreamFn, '', 'the stage renderStream should exist in the shared module');
  assert.match(renderStreamFn, /if \(!stick\) return;\s*\n\s*stream\.scrollTop = stream\.scrollHeight;/, 'a stuck stream pins to the bottom on render');
  assert.match(renderStreamFn, /querySelectorAll\('\.message-face img'\)[\s\S]*?addEventListener\('load', \(\) => \{ stream\.scrollTop = stream\.scrollHeight; \}, \{ once: true \}\)/, 'the stream re-pins to the bottom after each face image finishes loading');

  // 4. DECORATED STANDEE FRAME: a framed, cornered alcove (reusing the routing corner ornaments) so the
  //    standee reads as part of the space, box-sized to stay within the viewport.
  const standeeFrameCss = cssRuleBlock(css, '.routing-hub-standee-frame');
  assert.match(standeeFrameCss, /box-sizing:\s*border-box;/, 'the standee frame keeps its border within the stage height (box-sized)');
  assert.match(standeeFrameCss, /border:\s*1px solid var\(--routing-line\)/, 'the standee frame carries the routing silver border');
  assert.match(standeeFrameCss, /background:\s*linear-gradient/, 'the standee frame carries a silver-night panel fill (not a bare sticker)');
  // The standee frame carries corner ornaments via ::before/::after (the point-reflection orientation is
  // pinned by the dedicated corner-rotation test below).
  assert.match(css, /\.routing-hub-standee-frame::before,\s*\n\s*\.routing-hub-standee-frame::after \{[\s\S]*?url\('\/canonical\/routing\/ui\/corner_02\.png'\)/, 'the standee frame carries corner ornaments via its ::before/::after pseudo-elements');

  // 5. CLOSE BUTTON REDESIGN: the info popup close control is a round silver-night token (radius/gradient/
  //    glow in the --routing-* palette), not the bare default square.
  const closeCss = cssRuleBlock(css, '.routing-hub-info-popup-close');
  assert.match(closeCss, /border-radius:\s*999px;/, 'the close button is a round token');
  assert.match(closeCss, /radial-gradient/, 'the close button carries a routing-tone gradient fill');
  assert.match(closeCss, /box-shadow:[\s\S]*rgb\(159 180 255/, 'the close button carries a silver glow');

  // 6. BYTE-EQUAL: all wrap/width/frame overrides are routing-scoped. The shared academy chat stream keeps
  //    its exact fixed height and the global .message-bubble is untouched (loop/academy/dungeon unchanged).
  const sharedStreamCss = cssRuleBlock(css, '.message-stream');
  assert.match(sharedStreamCss, /height:\s*430px;/, 'the shared academy chat stream height is unchanged');
  const sharedBubbleCss = cssRuleBlock(css, '.message-bubble');
  assert.doesNotMatch(sharedBubbleCss, /overflow-wrap:\s*anywhere/, 'the shared bubble is not given the routing wrap (routing scopes it under .routing-hub-message-stream)');
});

test('routing hub standee frame is shortened to ~60% of the stage height and bottom-aligned with the chat window (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The standee frame no longer stretches to the full stage height alongside the chat panel: it is 60% of
  // the stage height (~6割) and bottom-aligned (align-self:flex-end) so its lower edge lines up with the
  // full-height chat panel's frame bottom, leaving deliberate empty space above the FRAME. Its dimensions are
  // preserved (the frame-fill change below fills it with the image, it does not resize the frame).
  const standeeFrameCss = cssRuleBlock(css, '.routing-hub-standee-frame');
  assert.match(standeeFrameCss, /height:\s*60%;/, 'the standee frame is shortened to 60% of the stage height (~6割)');
  assert.match(standeeFrameCss, /align-self:\s*flex-end;/, 'the standee frame is bottom-aligned so its bottom lines up with the full-height chat panel bottom');

  // Byte-equivalence guard: the chat panel keeps stretching to the full stage height (no height override or
  // realignment added to it), so its layout and viewport-fit are unchanged.
  const chatPanelCss = cssRuleBlock(css, '.routing-hub-chat-panel');
  assert.doesNotMatch(chatPanelCss, /height:\s*60%|align-self:/, 'the chat panel is not shortened or realigned (its full-height layout is unchanged)');

  // The moving ambient decoration (.routing-hub-decor-1) is repositioned OUT of the screen top-left and INTO
  // the empty space above the shortened standee frame: it is anchored to the standee window's top-right via
  // right + bottom (hugging the bottom-right corner of that empty space), not the old top/left screen corner.
  // decor-1 is a single-line rule (cssRuleBlock needs a `\n}` close), so it is matched against the full css.
  // The real-layout placement (decor rect vs standee-frame rect) is measured by
  // app/tests/manual/routingHubSessionScreenRender.mjs; a static grep can only pin the source anchor + direction.
  assert.match(css, /\.routing-hub-decor-1 \{[^}]*\bright:\s*57%[^}]*\bbottom:\s*58%[^}]*\}/, 'the moving decoration is anchored to the standee window top-right (right + bottom into the empty space above the frame)');
  assert.doesNotMatch(css, /\.routing-hub-decor-1 \{[^}]*\b(?:top|left):/, 'the moving decoration no longer carries a top/left screen-corner anchor (moved off the screen top-left)');
});

test('routing hub standee fills the frame edge-to-edge with the ornaments over it, carrying no speaker caption (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The ルミ standee is the frame's sole content, filling it edge-to-edge (inset:0 = no余白 gap), cover-cropped
  // from the top (object-position: center top keeps her face, the feet crop first), clipping itself with its own
  // rounded corners (角丸の逃げ). The frame dimensions are unchanged (height:60%); only the image now fills them.
  const standeeCss = cssRuleBlock(css, '.routing-hub-standee');
  assert.match(standeeCss, /position:\s*absolute;[\s\S]*?inset:\s*0;/, 'the standee fills the frame edge-to-edge (inset:0 — no余白 gap)');
  assert.match(standeeCss, /z-index:\s*1;/, 'the standee sits below the corner ornaments');
  assert.match(standeeCss, /object-fit:\s*cover;/, 'the standee cover-fills the frame (crop, no distortion, no gap)');
  assert.match(standeeCss, /object-position:\s*center top;/, 'the standee cover-crops from the top so her face is kept (feet crop first)');
  assert.match(standeeCss, /border-radius:\s*17px;/, 'the standee tucks inside the frame rounded border (角丸の逃げ)');
  assert.doesNotMatch(standeeCss, /object-fit:\s*contain/, 'the standee no longer letterboxes inside the frame (contain → cover)');
  // Token-only: the standee shadow consumes --routing-shadow, no literal color pin.
  assert.match(standeeCss, /filter:\s*drop-shadow\(0 8px 30px var\(--routing-shadow\)\);/, 'the standee shadow consumes the --routing-shadow token');
  assert.doesNotMatch(standeeCss, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the standee carries no literal color pin (--routing-* token-only)');

  // The frame has no inner padding gap and no overflow clip (the image reaches the border and clips itself).
  const standeeFrameCss = cssRuleBlock(css, '.routing-hub-standee-frame');
  assert.doesNotMatch(standeeFrameCss, /padding:/, 'the standee frame has no inner padding gap (the image reaches the frame edge)');
  assert.doesNotMatch(standeeFrameCss, /overflow:\s*hidden/, 'the standee frame does not clip its ornaments (the image clips itself)');

  // The corner ornaments sit ABOVE the standee image (z-index 3 > 1) so they hug the corners over the image edge.
  const standeeCornerRule = css.match(/\.routing-hub-standee-frame::before,\s*\n\s*\.routing-hub-standee-frame::after \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(standeeCornerRule, /z-index:\s*3;/, 'the standee corner ornaments are raised above the image so they overlap its corners (画像に少しかかる)');

  // The speaker-name caption CSS is gone (no text label around the frame).
  assert.doesNotMatch(css, /\.routing-hub-speaker-name/, 'the speaker-name caption CSS is removed (no text label around the frame)');
});

test('routing hub chat bubbles hug the speaker side (ルミ left / player right) and cap at 80% of the icon-excluded width, routing-scoped so loop/academy/dungeon stay byte-equal (app.js + style.css)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Every routing-stream row carries exactly one of four side-classified role classes. Pinning the shared
  // createMessageRows mapping keeps the CSS classification complete: a new/renamed role could not slip into
  // the routing stream unclassified without failing here (acceptance: 全メッセージ種別が左右いずれかに分類).
  assert.match(js, /message\.role === 'user' \? 'player-message' : message\.role === 'player-narration' \? 'player-narration-message' : message\.role === 'narration' \? 'narration-message' : 'character-message'/,
    'chat rows map every role to one of the four side-classified classes (player/player-narration/narration/character)');

  // LEFT (ルミ side): the assistant utterance (character-message, has the 129px face) and the assistant
  // ground text (narration-message, offset past the icon column by the shared margin-left:calc(129px+12px))
  // both hug the left of the icon-excluded area.
  assert.match(css, /\.routing-hub-message-stream \.character-message,\s*\n\s*\.routing-hub-message-stream \.narration-message \{\s*\n\s*justify-content:\s*flex-start;/,
    'ルミの発話 (character-message) と地の文 (narration-message) は左寄せ');

  // RIGHT (player side): the player utterance (player-message) and the player ground text
  // (player-narration-message) both hug the right of the icon-excluded area.
  assert.match(css, /\.routing-hub-message-stream \.player-message,\s*\n\s*\.routing-hub-message-stream \.player-narration-message \{\s*\n\s*justify-content:\s*flex-end;/,
    '主人公の発話 (player-message) と地の文 (player-narration-message) は右寄せ');

  // MAX WIDTH: every routing bubble caps at 80% of the stream width minus the icon column (129px face +
  // 12px gap), so a long line never crosses into ルミの顔アイコン列 or over to the opposite side.
  assert.match(css, /\.routing-hub-message-stream \.chat-message \.message-bubble \{\s*\n\s*max-width:\s*calc\(\(100% - 129px - 12px\) \* 0\.8\);/,
    'routing bubbles cap at 80% of the icon-excluded stream width');

  // BYTE-EQUAL: the alignment/width caps are all routing-scoped. The shared bubble keeps its exact
  // min(680px,78%) cap and the shared row-side rules (player-message / narration-message) are untouched,
  // so loop/academy/dungeon chat is unchanged.
  const sharedBubbleCss = cssRuleBlock(css, '.message-bubble');
  assert.match(sharedBubbleCss, /max-width:\s*min\(680px, 78%\);/, 'the shared bubble max-width is unchanged (routing scopes its own cap)');
  assert.doesNotMatch(sharedBubbleCss, /calc\(\(100% - 129px - 12px\)/, 'the 80% icon-excluded cap is not applied to the shared bubble');
  const sharedPlayerCss = cssRuleBlock(css, '.player-message');
  assert.match(sharedPlayerCss, /justify-content:\s*flex-end;/, 'the shared player-message row side is unchanged');
  const sharedNarrationCss = cssRuleBlock(css, '.narration-message');
  assert.match(sharedNarrationCss, /justify-content:\s*flex-start;/, 'the shared narration-message row side is unchanged');
});

test('routing hub info popup is a rail-linked left drawer with a common icon header and a selected rail state (index.html + app.js + conversationStage.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const stageJs = await readFile(path.join(root, 'conversationStage.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // DRAWER FORM: the overlay hugs the left (flex-start / stretch) instead of centering; the card is a
  // full-height drawer of min(380px, 34vw) opened past the rail (rail width + body gap), with the header
  // fixed and the body owning the internal scroll.
  const popupCss = cssRuleBlock(css, '.routing-hub-info-popup');
  assert.match(popupCss, /justify-content:\s*flex-start;/, 'the drawer overlay hugs the left rail side (not centered)');
  assert.match(popupCss, /align-items:\s*stretch;/, 'the drawer stretches to the full frame height');
  const cardCss = cssRuleBlock(css, '.routing-hub-info-popup-card');
  assert.match(cardCss, /width:\s*min\(380px, 34vw\);/, 'the drawer is min(380px, 34vw) wide');
  assert.match(cardCss, /height:\s*100%;/, 'the drawer spans the full frame height');
  assert.match(cardCss, /margin-left:\s*calc\(clamp\(56px, 6vw, 76px\) \+ clamp\(10px, 1\.6vw, 20px\)\);/, 'the drawer opens from the right edge of the left rail (clears rail width + body gap)');
  assert.match(cardCss, /flex-direction:\s*column;/, 'the drawer stacks a fixed header over a scrolling body');
  const bodyCss = cssRuleBlock(css, '.routing-hub-info-popup-body');
  assert.match(bodyCss, /flex:\s*1 1 auto;/, 'the drawer body grows to fill the card');
  assert.match(bodyCss, /min-height:\s*0;/, 'the drawer body can shrink so its overflow scrolls');
  assert.match(bodyCss, /overflow-y:\s*auto;/, 'the drawer body owns the internal scroll for tall content');

  // THIN BACKDROP: ルミ立ち絵と会話欄 read through it (rail-linked, not a full-cover modal). Token-only.
  const backdropCss = cssRuleBlock(css, '.routing-hub-info-popup-backdrop');
  assert.match(backdropCss, /background:\s*var\(--routing-scrim\);/, 'the drawer backdrop consumes the thin routing scrim token');

  // TOKEN-ONLY (Goal 4): the drawer overlay / backdrop / card consume --routing-* tokens with no literal
  // color pin; the thin scrim + drop shadow are defined as routing tokens on .routing-hub-screen.
  assert.match(cardCss, /box-shadow:\s*0 20px 60px var\(--routing-shadow\);/, 'the drawer shadow consumes the routing shadow token (no literal color pin)');
  const routingScreenCss = cssRuleBlock(css, '.routing-hub-screen');
  assert.match(routingScreenCss, /--routing-scrim:\s*rgb\(5 6 15 \/ 0\.32\);/, 'the thin drawer scrim is defined as a routing token');
  assert.match(routingScreenCss, /--routing-shadow:\s*rgb\(5 6 15 \/ 0\.6\);/, 'the drawer drop-shadow color is defined as a routing token');
  assert.doesNotMatch(backdropCss, /rgb\(/, 'the drawer backdrop has no literal color pin (token-only)');
  assert.doesNotMatch(cardCss, /rgb\(/, 'the drawer card has no literal color pin (token-only)');

  // RAIL-LINKED DECOR: a starlight light-rail down the drawer's left edge (控えめ), token-consumed.
  assert.match(css, /\.routing-hub-info-popup-card::before \{[\s\S]*?background:\s*linear-gradient\(180deg, var\(--routing-starlight\), var\(--routing-line-strong\)\);/, 'the drawer carries a starlight light-rail on its left edge');

  // COMMON ICON HEADER: the header carries a category icon element the stage sets at open from the
  // (validated) category, via the routing consumer's categoryIconUrl.
  assert.match(html, /<img id="routing-hub-info-popup-icon" class="routing-hub-info-popup-icon"/, 'the drawer header carries a category icon element');
  assert.match(stageJs, /icon\.src = config\.categoryIconUrl\(category\)/, 'opening the drawer sets the header icon from the consumer categoryIconUrl');
  assert.match(js, /categoryIconUrl: \(category\) => `\/canonical\/routing\/icons\/\$\{category\}\.png`/, 'the routing consumer maps a category to its rail asset');
  // Fail-fast: a missing icon node is broken markup, not a silent no-op.
  assert.match(stageJs, /const icon = el\(config\.infoIconSelector\);\s*\n\s*if \(!icon\) \{[\s\S]*?throw new Error/, 'openInfo fails fast when the header icon node is missing');
  assert.match(js, /infoIconSelector: '#routing-hub-info-popup-icon'/, 'the routing consumer wires the header icon selector');

  // SELECTED RAIL STATE: exactly one rail button is marked selected while its drawer is open; opening sets
  // it, closing clears it (null), and the CSS gives it a starlight border + faint glow.
  assert.match(stageJs, /setActiveCategory\(category\) \{[\s\S]*?button\.classList\.toggle\('is-active', isActive\)/, 'setActiveCategory toggles the selected rail button');
  assert.match(stageJs, /openInfo\(category\)[\s\S]*?stage\.setActiveCategory\(category\);/, 'opening the drawer marks its rail button selected');
  assert.match(stageJs, /closeInfo\(\)[\s\S]*?stage\.setActiveCategory\(null\);/, 'closing the drawer clears the selected rail state');
  const activeBtnCss = cssRuleBlock(css, '.routing-hub-category-button.is-active');
  assert.match(activeBtnCss, /border-color:\s*var\(--routing-starlight\);/, 'the selected rail button carries a starlight border');
  assert.match(activeBtnCss, /box-shadow:\s*0 0 12px var\(--routing-glow\);/, 'the selected rail button carries a faint glow');

  // BACKDROP DISMISS (modal dismissal preserved after the redesign): the backdrop carries the shared close
  // hook and the closer loop binds every [data-routing-popup-close] inside the popup to the close handler,
  // so a backdrop click still dismisses the drawer (runtime dismissal is exercised by the render harness).
  assert.match(html, /class="routing-hub-info-popup-backdrop" data-routing-popup-close="true"/, 'the drawer backdrop carries the close hook (backdrop-click dismissal)');
  assert.match(js, /for \(const closer of document\.querySelectorAll\('#routing-hub-info-popup \[data-routing-popup-close\]'\)\) \{[\s\S]*?routingHubStage\.closeInfo\(\)/, 'every close hook (backdrop + button) closes the drawer through the stage');

  // SWITCH WHILE OPEN: opening a category unconditionally re-renders the body, re-sets the header, and
  // re-marks the selected rail button — there is no already-open guard — so switching categories while the
  // drawer is open swaps content + selection cleanly (runtime switch is exercised by the render harness).
  const openFn = stageJs.match(/openInfo\(category\) \{[\s\S]*?\n    \},/)?.[0] ?? '';
  assert.notEqual(openFn, '', 'the stage openInfo should exist');
  assert.match(openFn, /stage\.renderInfoCategory\(category, bodyEl\);/, 'opening always re-renders the category body (switch-while-open swaps content)');
  assert.match(openFn, /stage\.setActiveCategory\(category\);/, 'opening always re-marks the selected rail button (switch-while-open moves the selection)');
  assert.doesNotMatch(openFn, /if \(!popup\.hidden\)\s*return|already open/, 'opening has no already-open guard that would block switching categories while open');
  const renderCategoryFn = stageJs.match(/renderInfoCategory\(category, bodyEl\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(renderCategoryFn, /bodyEl\.replaceChildren\(\);/, 'rendering a category clears the previous category content first (clean switch)');
  assert.match(renderCategoryFn, /const renderer = config\.categoryRenderers\[category\];\s*\n\s*if \(!renderer\) \{[\s\S]*?throw new Error/, 'rendering a category dispatches to the consumer renderer and fail-fasts on an unknown category (contract break, not an empty popup)');
});

test('routing hub info drawer enriches each category to the hub design level, routing-scoped so shared parameter meters stay byte-equal (app.js + style.css + index.html)', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');

  // BUDDY: async against the GET /api/relationships/buddy truth source — a person panel with the hero card
  // (portrait + name + meta), then the shared parameter groups (selectable only — 現行同等) + the buddy's 装備欄
  // (target the buddy id, a homunculus id too); a titled empty-state CARD (not a bare line) when absent. A
  // homunculus buddy shows the endpoint face / name + a 好感度 affinity chip, and no parameter section.
  const buddyFn = js.match(/function renderRoutingHubBuddyInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buddyFn, '', 'renderRoutingHubBuddyInto should exist');
  assert.match(buddyFn, /loadRoutingHubBuddyInto\(bodyEl\)\.catch\(reportError\)/, 'the buddy category delegates to the async endpoint loader (errors → reportError)');
  const buddyLoaderFn = js.match(/async function loadRoutingHubBuddyInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(buddyLoaderFn, '', 'loadRoutingHubBuddyInto should exist');
  assert.match(buddyLoaderFn, /const view = await fetchBuddyView\(\)[\s\S]*popup\.dataset\.category !== 'buddy'/, 'the loader fetches the endpoint and guards staleness + still-on-buddy');
  assert.match(buddyLoaderFn, /routingHubInfoEmptyCard\('バディー記録なし'/, 'an absent buddy renders a titled empty-state card, not a one-line text');
  assert.match(buddyLoaderFn, /if \(subject\.kind === 'character'\) \{\s*const params = routingHubInfoSection\('パラメーター'\);\s*params\.body\.append\(\.\.\.buildParameterGroups\(subject\.roster\.parameters\)\)/, 'the selectable buddy panel renders the shared parameter groups (現行同等); a homunculus renders none');
  assert.match(buddyLoaderFn, /routingHubPersonEquipToken \+= 1;\s*loadRoutingHubPersonEquipInto\('buddy', subject\.characterId, equipment\.body\)\.catch\(reportError\)/, 'the buddy panel bumps the person-equip token and loads the buddy 装備欄 (target the buddy id — a homunculus id too)');
  const buddyHeroFn = js.match(/function routingHubBuddyHeroCard\(subject\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(buddyHeroFn, /'routing-hub-info-buddy-card'[\s\S]*?'routing-hub-info-portrait'[\s\S]*?routingHubInfoMetaChips\(buddy\)/, 'a selectable buddy renders a portrait hero card with roster meta chips (現行同等)');
  assert.match(buddyHeroFn, /buddyAffinityChip\(buddy\.affinity, 'routing-hub-info-chip'\)/, 'a homunculus buddy renders a 好感度 affinity chip');

  // ENEMY: count summary + compact roster cards when present; a titled empty-state card when 0件.
  const enemyFn = js.match(/function renderRoutingHubEnemiesInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(enemyFn, '', 'renderRoutingHubEnemiesInto should exist');
  assert.match(enemyFn, /routingHubInfoEmptyCard\('エネミー記録なし'/, 'zero enemies render a titled empty-state card');
  assert.match(enemyFn, /routingHubInfoSummary\(`\$\{enemies\.length\}件`, 'エネミー'\)[\s\S]*?routingHubInfoRosterCard/, 'enemies render a count summary over compact roster cards');

  // INVENTORY: a two-section drawer — a 装備 section (a DISPLAY-ONLY list of the owned equipment not equipped by any
  // owner) above the 所持品欄 (the item ledger). Equipping moved to the person panels (自分 / バディー), so the
  // inventory drawer only browses the un-equipped gear. The orchestrator bumps the inventory drawer token, shows a
  // loading card immediately, builds the ledger synchronously (its fail-fast surfaces before any append/fetch),
  // appends the two sections in order, then starts the equipment loader routing a failure to reportError.
  const inventoryOrchestrator = js.match(/function renderRoutingHubInventoryInto\(bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(inventoryOrchestrator, '', 'renderRoutingHubInventoryInto should exist');
  assert.match(inventoryOrchestrator, /routingHubInventoryToken \+= 1;/, 're-opening the inventory category bumps the inventory drawer token (abandons an in-flight fetch / use re-render)');
  assert.match(inventoryOrchestrator, /routingHubInfoSection\('装備'\)[\s\S]*?routingHubEquipmentLoadingCard\(\)[\s\S]*?routingHubInfoSection\('持ち物'\)[\s\S]*?renderRoutingHubInventoryLedgerInto\(items\.body\)/, 'the drawer stacks the 装備 section (with a loading card) above the 持ち物 ledger section');
  assert.match(inventoryOrchestrator, /bodyEl\.append\(equipment\.section, items\.section\);\s*\n\s*loadRoutingHubInventoryEquipmentInto\(equipment\.body\)\.catch\(reportError\);/, 'the two sections are appended in order, then the display-only equipment loader runs (a fetch failure routes to reportError)');

  // The 所持品欄 ledger: a 種類 count summary + a name/quantity/description ledger that reads the enriched item.name
  // (the old display_name always fell through to item_id) and OMITS the description line when the item has none (no
  // empty slot). It now also carries the 使う 導線 (below) and an optional transient feedback line above the list.
  const inventoryFn = js.match(/function renderRoutingHubInventoryLedgerInto\(bodyEl, feedback = null\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(inventoryFn, '', 'renderRoutingHubInventoryLedgerInto should exist');
  assert.match(inventoryFn, /routingHubInfoEmptyCard\('持ち物なし'/, 'an empty inventory renders a titled empty-state card');
  assert.match(inventoryFn, /routingHubInfoSummary\(`\$\{items\.length\}種類`, '持ち物'\)/, 'inventory renders a 種類 count summary');
  assert.match(inventoryFn, /name\.textContent = item\.name;/, 'the ledger reads the enriched item.name directly (not display_name)');
  // Fail-fast (absolute-rules): broken enriched item data surfaces instead of being masked with item_id /
  // 0 / an empty slot.
  assert.match(inventoryFn, /if \(typeof item\.name !== 'string' \|\| item\.name === ''\) \{[\s\S]*?throw new Error/, 'the ledger fails fast on a missing/empty item name (no item_id fallback)');
  assert.match(inventoryFn, /if \(typeof item\.quantity !== 'number' \|\| !Number\.isFinite\(item\.quantity\)\) \{[\s\S]*?throw new Error/, 'the ledger fails fast on a non-numeric quantity (no ?? 0 fallback)');
  assert.match(inventoryFn, /if \(typeof item\.description !== 'string'\) \{[\s\S]*?throw new Error/, 'the ledger fails fast on a non-string description');
  assert.match(inventoryFn, /if \(typeof item\.usable !== 'boolean'\) \{[\s\S]*?throw new Error/, 'the ledger fails fast on a missing/invalid server-authoritative usable flag (broken wiring is surfaced, not read as not-usable)');
  assert.doesNotMatch(inventoryFn, /item\.name \?\? item\.item_id|Number\(item\.quantity \?\? 0\)/, 'no silent/default fallbacks remain for enriched item fields');
  assert.match(inventoryFn, /if \(item\.description\.trim\(\) !== ''\) \{/, 'the ledger omits the description line when the item description is empty (no empty slot)');
  assert.match(css, /\.routing-hub-info-ledger-desc \{[\s\S]*?-webkit-line-clamp:\s*2;/, 'a long item description is 2-line clamped in the drawer');

  // 使う 導線: only rows whose enriched item carries the server-authoritative `usable` flag get a 使う button.
  // The server decides usability (購買 stat 霊薬 ∪ 調合/オークション self_boost) — the front never guesses by
  // category, stat_effect presence, or a hardcoded item id / name list. gift / ally_boost / dungeon_consumable /
  // material rows are usable:false and carry no button.
  assert.match(inventoryFn, /if \(item\.usable\) row\.append\(routingHubInventoryUseAction\(item, bodyEl\)\);/, 'a 使う 導線 is appended only to rows the server marks usable (gift / ally_boost / dungeon_consumable / material rows get none)');
  assert.doesNotMatch(inventoryFn, /item\.item_id === |item\.name === '剛力|includes\(item\.item_id\)|if \(item\.stat_effect\) row\.append/, 'usability is decided by the server usable flag, not a hardcoded item id / name list or a frontend stat_effect guess');
  const useActionFn = js.match(/function routingHubInventoryUseAction\(item, bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(useActionFn, '', 'routingHubInventoryUseAction should exist');
  assert.match(useActionFn, /use\.textContent = '1個使う';/, 'the single-use button is labelled 1個使う');
  assert.match(useActionFn, /use\.addEventListener\('click', \(\) => useRoutingHubInventoryItem\(item\.item_id, 1, use, bodyEl\)\.catch\(reportError\)\);/, 'clicking 1個使う uses one unit through useRoutingHubInventoryItem (rejection → reportError)');
  assert.match(useActionFn, /useAll\.textContent = '全部使う';/, 'a second button is labelled 全部使う');
  assert.match(useActionFn, /useAll\.addEventListener\('click', \(\) => useRoutingHubInventoryItem\(item\.item_id, item\.quantity, useAll, bodyEl\)\.catch\(reportError\)\);/, 'clicking 全部使う uses the owned quantity in one use through useRoutingHubInventoryItem');
  assert.match(useActionFn, /actions\.append\(use, useAll\);/, 'both use buttons live in the ledger action row');

  // The use flow: single-flight (no duplicate POST), server-authoritative usability + effect, fail-fast surfacing.
  const useFn = js.match(/async function useRoutingHubInventoryItem\(itemId, quantity, button, bodyEl\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(useFn, '', 'useRoutingHubInventoryItem should exist');
  assert.match(useFn, /if \(routingHubInventoryUseInFlight\) return;\s*\n\s*routingHubInventoryUseInFlight = true;\s*\n\s*button\.disabled = true;/, 'a use is single-flight and disables the pressed button immediately (no duplicate POST / 連打)');
  assert.match(useFn, /const token = routingHubInventoryToken;/, 'the use captures the inventory drawer token before awaiting (stale-race guard)');
  assert.match(useFn, /postJson\('\/api\/inventory\/use', \{ item_id: itemId, quantity \}\)/, 'the use posts the requested quantity (1 for 1個使う, 所持数 for 全部使う) to POST /api/inventory/use');
  assert.match(useFn, /currentInventory = result\.inventory;\s*\n\s*currentWorld = result\.world;/, 'the authoritative POST result refreshes the global inventory + world (self / money reflect it on next render)');
  assert.match(useFn, /if \(routingHubInventoryIsCurrent\(token\)\) \{[\s\S]*?renderRoutingHubInventoryLedgerInto\(bodyEl, \{ message: routingHubInventoryUseMessage\(result\), tone: 'success' \}\)/, 'a success commits the ledger re-render + success line only while still the current inventory generation');
  assert.match(useFn, /catch \(error\) \{\s*\n\s*if \(!routingHubInventoryIsCurrent\(token\)\) throw error;[\s\S]*?renderRoutingHubInventoryLedgerInto\(bodyEl, \{ message: errorDisplayMessage\(error\), tone: 'error' \}\)/, 'an error surfaces the fail-fast API message in the ledger (never silent); a stale error re-throws to reportError');
  assert.match(useFn, /finally \{\s*\n\s*routingHubInventoryUseInFlight = false;/, 'the single-flight guard always clears');
  assert.doesNotMatch(useFn, /\?\? \{\}|catch \{\s*\}|\/\/ ignore/, 'the use flow has no silent fallback / swallowed error');

  // The success line reads the server-authoritative POST result (never recomputes a value) and handles BOTH use
  // shapes: a 購買 stat 霊薬's single `effect`, and an alchemy self_boost's `effects` array + top-level used_quantity.
  const useMessageFn = js.match(/function routingHubInventoryUseMessage\(result\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(useMessageFn, '', 'routingHubInventoryUseMessage should exist');
  assert.match(useMessageFn, /if \(result\.effect\) \{[\s\S]*?\$\{item\.name\}を\$\{effect\.used_quantity\}個使いました（\$\{effect\.label\} \$\{effect\.before\} → \$\{effect\.after\}）/, 'the shop stat 霊薬 branch reports how many were used and the server-authoritative single parameter move');
  assert.match(useMessageFn, /if \(!Array\.isArray\(result\.effects\)\) \{[\s\S]*?throw new Error/, 'a result carrying neither effect nor effects fails fast (no silent fallback)');
  assert.match(useMessageFn, /result\.effects\.map\(\(effect\) => `\$\{effect\.label\} \$\{effect\.before\} → \$\{effect\.after\}`\)\.join\(' \/ '\)[\s\S]*?\$\{item\.name\}を\$\{result\.used_quantity\}個使いました（\$\{moves\}）/, 'the self_boost branch joins every raised parameter move and reads the top-level used_quantity');

  // The transient feedback line is a role=status card toned by data-tone.
  const feedbackFn = js.match(/function routingHubInventoryFeedbackCard\(\{ message, tone \}\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(feedbackFn, '', 'routingHubInventoryFeedbackCard should exist');
  assert.match(feedbackFn, /card\.dataset\.tone = tone;/, 'the feedback card carries its tone as data-tone');
  assert.match(feedbackFn, /card\.setAttribute\('role', 'status'\);/, 'the feedback card is an aria status region');

  // STYLE: the 使う button + feedback consume the routing token layer only (no literal color pin — test-by-token).
  const useCss = css.match(/\.routing-hub-info-ledger-use \{[\s\S]*?\.routing-hub-info-ledger-feedback\[data-tone="error"\] \{[\s\S]*?\}/)?.[0] ?? '';
  assert.notEqual(useCss, '', 'the 使う button + feedback CSS block should exist');
  assert.match(useCss, /\.routing-hub-info-ledger-use:disabled \{[\s\S]*?cursor:\s*not-allowed;/, 'the disabled 使う button shows a not-allowed cursor (send-in-flight cue)');
  assert.match(useCss, /\.routing-hub-info-ledger-feedback\[data-tone="success"\] \{[\s\S]*?var\(--routing-starlight\)/, 'the success tone is starlight-accented (routing token)');
  assert.doesNotMatch(useCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the 使う button + feedback CSS pins no literal color (routing token layer only)');

  // 装備 (inventory, display-only): GET /api/equipment is the single source of truth, validated fail-fast through the
  // SHARED validateDungeonEquipmentSnapshot (no second validator). The inventory 装備 section lists only the instances
  // NOT equipped by ANY owner — filtered by the authoritative sales[].equipped flag (via the shared
  // validateShopEquipmentSales). The loader mirrors the diary async discipline: capture the module token, commit only
  // if still current (token + still on inventory), and on a GET failure / malformed snapshot paint an in-section
  // error card (never a silent empty/placeholder) and re-throw so reportError also surfaces it.
  const inventoryEquipLoader = js.match(/async function loadRoutingHubInventoryEquipmentInto\(sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(inventoryEquipLoader, '', 'loadRoutingHubInventoryEquipmentInto should exist');
  assert.match(inventoryEquipLoader, /const token = routingHubInventoryToken;/, 'the loader captures the inventory drawer token before awaiting (stale-race guard)');
  assert.match(inventoryEquipLoader, /getJson\('\/api\/equipment'\)/, 'the 装備 section consumes GET /api/equipment as the single source of truth');
  assert.match(inventoryEquipLoader, /if \(!routingHubInventoryIsCurrent\(token\)\) return;\s*\n\s*const view = validateDungeonEquipmentSnapshot\(snapshot\);/, 'a resolved fetch commits only if still current, then validates through the shared dungeon snapshot validator (fail-fast on malformed slots/instances)');
  assert.match(inventoryEquipLoader, /const sales = validateShopEquipmentSales\(snapshot\.sales, view\.instances\);\s*\n\s*const unequipped = sales\.filter\(\(entry\) => !entry\.equipped\)\.map\(\(entry\) => entry\.view\);/, 'the inventory list is the instances NOT equipped by any owner (filtered by the authoritative sales[].equipped flag)');
  assert.match(inventoryEquipLoader, /sectionBody\.replaceChildren\(\.\.\.routingHubInventoryEquipmentList\(unequipped\)\);/, 'the loader renders the un-equipped list into the section body');
  assert.match(inventoryEquipLoader, /catch \(error\) \{[\s\S]*?if \(routingHubInventoryIsCurrent\(token\)\) sectionBody\.replaceChildren\(routingHubEquipmentErrorCard\(\)\);[\s\S]*?throw error;/, 'a GET failure / malformed snapshot paints an in-section error card (when current) and re-throws to reportError — no silent empty/placeholder degrade');

  // The inventory 装備 list content: a 件数 summary + the un-equipped rows (each opens the shared detail popup), or a
  // quiet titled empty state (an empty pool is not an error).
  const inventoryEquipListFn = js.match(/function routingHubInventoryEquipmentList\(unequipped\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(inventoryEquipListFn, '', 'routingHubInventoryEquipmentList should exist');
  assert.match(inventoryEquipListFn, /routingHubInfoEmptyCard\('未装備の装備品なし'/, 'an empty un-equipped pool is a quiet titled empty state (not an error)');
  assert.match(inventoryEquipListFn, /routingHubInfoSummary\(`\$\{unequipped\.length\}件`, '未装備の装備品'\)/, 'the un-equipped instances carry a 件数 summary');
  assert.match(inventoryEquipListFn, /unequipped\.map\(\(entry\) => routingHubEquipmentOwnedRow\(entry\)\)/, 'each row receives the full validated instance view (so the detail popup has the effects too)');

  // The stale-race guard (shared by the equipment fetch AND the use re-render) checks BOTH the token AND that the
  // drawer is still on the inventory category.
  const equipCurrentFn = js.match(/function routingHubInventoryIsCurrent\(token\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(equipCurrentFn, /if \(token !== routingHubInventoryToken\) return false;/, 'a re-open / newer fetch abandons this one (token mismatch)');
  assert.match(equipCurrentFn, /popup\.dataset\.category === 'inventory'/, 'a category switch away from inventory abandons the in-flight equipment fetch / use re-render');

  // ── Person 装備欄 (self / buddy panels) ──
  // A separate person-equip token/guard governs the self / buddy 装備欄 generation: opening either bumps the token,
  // and the guard checks the drawer is still on that SAME person category. routingHubPersonEquipSlots resolves the
  // owner's slots (player → view.slots; a buddy id → the snapshot buddy's slots, fail-fast on a mismatch).
  const personEquipCurrentFn = js.match(/function routingHubPersonEquipIsCurrent\(token, category\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(personEquipCurrentFn, '', 'routingHubPersonEquipIsCurrent should exist');
  assert.match(personEquipCurrentFn, /if \(token !== routingHubPersonEquipToken\) return false;/, 'a re-open / newer fetch abandons this one (token mismatch)');
  assert.match(personEquipCurrentFn, /popup\.dataset\.category === category/, 'a switch away from the opened person category abandons the in-flight equipment fetch / re-render');

  const personSlotsFn = js.match(/function routingHubPersonEquipSlots\(view, target\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(personSlotsFn, '', 'routingHubPersonEquipSlots should exist');
  assert.match(personSlotsFn, /if \(target === 'player'\) return view\.slots;/, "target 'player' resolves the hero slots");
  assert.match(personSlotsFn, /if \(!view\.buddy \|\| view\.buddy\.characterId !== target\) \{[\s\S]*?throw new Error/, 'a buddy target fail-fasts when the snapshot buddy is absent or a different id (no silent coerce to empty / the other owner)');
  assert.match(personSlotsFn, /return view\.buddy\.slots;/, 'a matching buddy target resolves the snapshot buddy slots');

  // The person loader mirrors the diary async discipline: capture the person-equip token, validate through the shared
  // validator, resolve the owner slots, render the slot cards; a GET failure / malformed snapshot paints an
  // in-section error card (when current) and re-throws so reportError also surfaces it. It carries an optional
  // feedback line (a failed action's message).
  const personLoader = js.match(/async function loadRoutingHubPersonEquipInto\(category, target, sectionBody, feedback = null\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(personLoader, '', 'loadRoutingHubPersonEquipInto should exist (with an optional feedback line)');
  assert.match(personLoader, /const token = routingHubPersonEquipToken;/, 'the person loader captures the person-equip token before awaiting');
  assert.match(personLoader, /getJson\('\/api\/equipment'\)/, 'the person 装備欄 consumes GET /api/equipment as the single source of truth');
  assert.match(personLoader, /if \(!routingHubPersonEquipIsCurrent\(token, category\)\) return;\s*\n\s*const view = validateDungeonEquipmentSnapshot\(snapshot\);\s*\n\s*const slots = routingHubPersonEquipSlots\(view, target\);/, 'a resolved fetch commits only if still current, validates through the shared validator, then resolves this owner slots');
  assert.match(personLoader, /sectionBody\.replaceChildren\(\.\.\.routingHubPersonEquipCards\(category, target, slots, view\.instances, sectionBody, feedback\)\);/, 'the loader threads category/target/sectionBody/feedback into the card builder (so the slot 導線 re-render into the same body)');
  assert.match(personLoader, /catch \(error\) \{[\s\S]*?if \(routingHubPersonEquipIsCurrent\(token, category\)\) sectionBody\.replaceChildren\(routingHubEquipmentErrorCard\(\)\);[\s\S]*?throw error;/, 'a GET failure / malformed snapshot paints an in-section error card (when current) and re-throws to reportError');

  // Labels come ONLY from the shared workshopArrivalClient closed-set vocabulary (via workshopKindLabel /
  // dungeonEquipmentInstanceMetaText) — the equipment builders define no private translation map.
  const personCardsFn = js.match(/function routingHubPersonEquipCards\(category, target, slots, instances, sectionBody, feedback = null\)[\s\S]*?\n\}/)?.[0] ?? '';
  const slotCardFn = js.match(/function routingHubPersonEquipSlotCard\(category, target, slot, equippedView, instances, sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  const equippedFn = js.match(/function routingHubPersonEquipEquipped\(category, target, slot, view, sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  const emptyFn = js.match(/function routingHubPersonEquipEmpty\(category, target, slot, candidates, sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  const candidateFn = js.match(/function routingHubPersonEquipCandidate\(category, target, slot, instance, sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  const ownedRowFn = js.match(/function routingHubEquipmentOwnedRow\(view\)[\s\S]*?\n\}/)?.[0] ?? '';
  const equipBuilders = [
    personCardsFn,
    slotCardFn,
    equippedFn,
    emptyFn,
    candidateFn,
    js.match(/function routingHubEquipmentEquippedDetail\(view\)[\s\S]*?\n\}/)?.[0] ?? '',
    ownedRowFn
  ].join('\n');
  assert.notEqual(slotCardFn, '', 'routingHubPersonEquipSlotCard should exist');
  assert.notEqual(ownedRowFn, '', 'routingHubEquipmentOwnedRow should exist (taking the full instance view)');
  assert.match(equipBuilders, /head\.textContent = `\$\{workshopKindLabel\(slot\)\}スロット`;/, 'the slot label reads the shared kind vocabulary (workshopKindLabel)');
  assert.match(equipBuilders, /meta\.textContent = dungeonEquipmentInstanceMetaText\(instance\);/, 'the identity line reuses the shared dungeonEquipmentInstanceMetaText (shared closed-set labels — no private translation)');
  assert.doesNotMatch(equipBuilders, /武器|護符|剣|杖|短杖|[光闇火水土風]|並|良|優|傑作/, 'the equipment builders pin no literal vocabulary (every label comes from the shared closed-set helpers)');

  // Each person panel carries the SAME button grammar as the dungeon entry, now targeting its owner: an occupied slot
  // carries a 解除 button (→ unequipRoutingHubPersonSlot), an empty slot offers the owned instances of its kind as 装備
  // candidate buttons (→ equipRoutingHubPersonSlot). Both re-render into the threaded sectionBody.
  assert.match(personCardsFn, /if \(feedback\) nodes\.push\(routingHubEquipmentFeedbackCard\(feedback\)\);/, 'a feedback line (a failed action message) is prepended above the slots when present');
  assert.match(personCardsFn, /for \(const slot of WORKSHOP_EQUIPMENT_KINDS\)[\s\S]*?routingHubPersonEquipSlotCard\(category, target, slot, slots\[slot\], instances, sectionBody\)/, 'the two slots (weapon / amulet) render from the owner slots, carrying category/target/instances/sectionBody for the equip 導線');
  assert.match(slotCardFn, /card\.append\(routingHubPersonEquipEquipped\(category, target, slot, equippedView, sectionBody\)\);/, 'an occupied slot renders the equipped detail + 解除 導線');
  assert.match(slotCardFn, /routingHubPersonEquipEmpty\(category, target, slot, instances\.filter\(\(view\) => view\.instance\.kind === slot\), sectionBody\)/, 'an empty slot offers the owned instances of its kind (the same kind-filter as the dungeon entry)');
  assert.match(equippedFn, /unequip\.textContent = '解除';/, 'the occupied-slot action button is labelled 解除');
  assert.match(equippedFn, /unequip\.addEventListener\('click', \(event\) => \{\s*\n\s*event\.stopPropagation\(\);\s*\n\s*unequipRoutingHubPersonSlot\(category, target, slot, sectionBody\)\.catch\(reportError\);/, 'clicking 解除 unequips this owner slot (rejection → reportError) and stops propagation so it never opens the detail popup');
  assert.match(emptyFn, /note\.textContent = '未装備';/, 'an empty slot shows the quiet 未装備 note');
  assert.match(emptyFn, /if \(candidates\.length > 0\)[\s\S]*?candidates\.map\(\(view\) => routingHubPersonEquipCandidate\(category, target, slot, view\.instance, sectionBody\)\)/, 'a slot with owned candidates of its kind lists them as 装備 buttons (none → only the quiet note)');
  assert.match(candidateFn, /button\.addEventListener\('click', \(\) => equipRoutingHubPersonSlot\(category, target, slot, instance\.instance_id, sectionBody\)\.catch\(reportError\)\);/, 'clicking a candidate equips it into this owner slot through equipRoutingHubPersonSlot (rejection → reportError)');
  assert.match(candidateFn, /meta\.textContent = dungeonEquipmentInstanceMetaText\(instance\);/, 'a candidate reads the shared identity line (no private translation)');
  // Candidate buttons stay equip-only (no detail popup) — misclick prevention, per the task.
  assert.doesNotMatch(candidateFn, /openRoutingHubEquipmentPopup/, 'a candidate button never opens the detail popup (it is equip-only)');

  // Detail popup 導線: the equipped card body opens it with equipped:true; the inventory owned (未装備) row with
  // equipped:false. Openers wrap in try/catch → reportError (fail-fast markup surfaced), mirroring the character-popup opener.
  assert.match(equippedFn, /wrap\.addEventListener\('click', \(\) => \{\s*\n\s*try \{ openRoutingHubEquipmentPopup\(view, \{ equipped: true \}\); \} catch \(error\) \{ reportError\(error\); \}/, 'clicking the equipped card body opens the instance detail popup (装備中)');
  assert.match(ownedRowFn, /row\.addEventListener\('click', \(\) => \{\s*\n\s*try \{ openRoutingHubEquipmentPopup\(view, \{ equipped: false \}\); \} catch \(error\) \{ reportError\(error\); \}/, 'clicking an owned (未装備) row opens the instance detail popup (未装備)');
  assert.match(ownedRowFn, /const \{ instance \} = view;/, 'the owned row destructures the instance from the full view (so the popup has the effects too)');

  // The equip / unequip 導線 post to the shared equipmentApi with the panel's target ('player' or the buddy id), then
  // re-fetch the authoritative snapshot and re-render.
  const equipFn = js.match(/function equipRoutingHubPersonSlot\(category, target, slot, instanceId, sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  const unequipFn = js.match(/function unequipRoutingHubPersonSlot\(category, target, slot, sectionBody\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(equipFn, /postJson\('\/api\/equipment\/equip', \{ target, slot, instance_id: instanceId \}\)/, 'equip posts to /api/equipment/equip for this owner slot');
  assert.match(unequipFn, /postJson\('\/api\/equipment\/unequip', \{ target, slot \}\)/, 'unequip posts to /api/equipment/unequip for this owner slot');

  // The shared equip / unequip runner: single-flight (no duplicate POST), never adopts the action snapshot
  // optimistically (re-fetches GET /api/equipment on success), and on failure re-renders from the authoritative
  // snapshot with an in-section error line AND re-throws to reportError (no silent no-op / placeholder degrade).
  const equipActionFn = js.match(/async function runRoutingHubPersonEquipAction\(category, target, sectionBody, action\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(equipActionFn, '', 'runRoutingHubPersonEquipAction should exist');
  assert.match(equipActionFn, /if \(routingHubPersonEquipInFlight\) return;\s*\n\s*routingHubPersonEquipInFlight = true;/, 'an equip/unequip is single-flight (a second click while one is pending is dropped — no duplicate POST)');
  assert.match(equipActionFn, /const token = routingHubPersonEquipToken;/, 'the action captures the person-equip token before awaiting (stale-race guard)');
  assert.match(equipActionFn, /await action\(\);\s*\n\s*if \(routingHubPersonEquipIsCurrent\(token, category\)\) await loadRoutingHubPersonEquipInto\(category, target, sectionBody\);/, 'a successful action re-fetches GET /api/equipment and re-renders (only while still current — never an optimistic slot mutation)');
  assert.match(equipActionFn, /catch \(error\) \{\s*\n\s*if \(!routingHubPersonEquipIsCurrent\(token, category\)\) throw error;\s*\n\s*await loadRoutingHubPersonEquipInto\(category, target, sectionBody, \{ message: errorDisplayMessage\(error\), tone: 'error' \}\);\s*\n\s*throw error;/, 'a failure re-renders the authoritative snapshot with an in-section error line AND re-throws to reportError (both surfaces — never a silent no-op)');
  assert.match(equipActionFn, /finally \{\s*\n\s*routingHubPersonEquipInFlight = false;/, 'the single-flight guard always clears');
  assert.doesNotMatch(equipActionFn, /\?\? \{\}|catch \{\s*\}|\/\/ ignore/, 'the equip/unequip runner has no silent fallback / swallowed error');

  // The transient equip / unequip feedback line is a role=status card toned by data-tone.
  const equipFeedbackFn = js.match(/function routingHubEquipmentFeedbackCard\(\{ message, tone \}\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(equipFeedbackFn, '', 'routingHubEquipmentFeedbackCard should exist');
  assert.match(equipFeedbackFn, /card\.className = 'routing-hub-info-equip-feedback';/, 'the equip feedback wears the 装備欄 feedback class (routing token layer)');
  assert.match(equipFeedbackFn, /card\.setAttribute\('role', 'status'\);/, 'the equip feedback card is an aria status region');

  // ── 装備 detail popup ──────────────────────────────────────────────────────
  // Opening fills the name (title) + the body sections and toggles the shared [hidden] modal (NO extra fetch — the
  // already-validated instance view is the only source). Fail-fast on broken markup.
  const equipPopupOpenFn = js.match(/function openRoutingHubEquipmentPopup\(view, \{ equipped \}\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(equipPopupOpenFn, '', 'openRoutingHubEquipmentPopup should exist');
  assert.match(equipPopupOpenFn, /if \(!popup \|\| !title \|\| !body\) \{[\s\S]*?throw new Error/, 'the opener fail-fasts on broken popup markup (no silent no-op)');
  assert.match(equipPopupOpenFn, /title\.textContent = instance\.name;/, 'the popup title is the instance name (name as the main display)');
  assert.match(equipPopupOpenFn, /body\.replaceChildren\(\.\.\.routingHubEquipmentPopupSections\(view, equipped\)\);/, 'the body renders the detail sections from the validated view');
  assert.match(equipPopupOpenFn, /popup\.hidden = false;/, 'opening toggles the shared [hidden] modal (the #routing-hub-screen [hidden] guard hides it otherwise)');
  assert.doesNotMatch(equipPopupOpenFn, /getJson|fetch\(|postJson/, 'the popup performs no additional fetch (uses the already-rendered snapshot instance)');

  // The popup body: 装備中/未装備 status + identity line + flavor 全文 + 基礎/付加 effect rows (reusing the shared
  // effect-row builder so the closed-set vocabulary / 「なし」 match the 装備欄).
  const equipPopupSectionsFn = js.match(/function routingHubEquipmentPopupSections\(view, equipped\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(equipPopupSectionsFn, '', 'routingHubEquipmentPopupSections should exist');
  assert.match(equipPopupSectionsFn, /status\.textContent = equipped \? '装備中' : '未装備';/, 'the status line reads 装備中 / 未装備 from the equipped flag');
  assert.match(equipPopupSectionsFn, /status\.dataset\.state = equipped \? 'equipped' : 'unequipped';/, 'the status carries its state as data-state (for the token-styled chip)');
  assert.match(equipPopupSectionsFn, /meta\.textContent = dungeonEquipmentInstanceMetaText\(instance\);/, 'the identity line reuses the shared dungeonEquipmentInstanceMetaText (no private translation)');
  assert.match(equipPopupSectionsFn, /flavor\.textContent = instance\.flavor;/, 'the flavor 全文 is shown (validator-guaranteed non-empty)');
  assert.match(equipPopupSectionsFn, /routingHubEquipmentEffectRow\('基礎性能', baseEffects\)[\s\S]*?routingHubEquipmentEffectRow\('付加性能', bonusEffects\)/, 'the 基礎 / 付加 effect rows reuse the shared effect-row builder (empty → 「なし」)');

  // Close mirrors the character/info popup close contract (fail-fast on broken markup, [hidden]-toggle, no re-fetch).
  const equipPopupCloseFn = js.match(/function closeRoutingHubEquipmentPopup\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(equipPopupCloseFn, '', 'closeRoutingHubEquipmentPopup should exist');
  assert.match(equipPopupCloseFn, /throw new Error\('routing hub equipment popup node #routing-hub-equipment-popup is missing/, 'close fail-fasts on broken markup');
  assert.match(equipPopupCloseFn, /popup\.hidden = true;/, 'close toggles the shared [hidden] modal');
  assert.match(js, /for \(const closer of document\.querySelectorAll\('#routing-hub-equipment-popup \[data-routing-popup-close\]'\)\)[\s\S]*?closeRoutingHubEquipmentPopup\(\)/, 'the popup close button + backdrop dismiss it (data-routing-popup-close), matching the info/character popup wiring');

  // MARKUP: the popup follows the routing hub popup grammar (backdrop + role=dialog card + aria-labelledby title +
  // the shared close button), hidden by default under the #routing-hub-screen [hidden] guard. Scoped to the popup
  // block so the shared close-button assert can't drift onto the info / character popup.
  const equipPopupHtml = html.match(/<div id="routing-hub-equipment-popup"[\s\S]*?id="routing-hub-equipment-popup-body"[^>]*><\/div>/)?.[0] ?? '';
  assert.notEqual(equipPopupHtml, '', 'the equipment popup markup should exist');
  assert.match(equipPopupHtml, /^<div id="routing-hub-equipment-popup" class="routing-hub-equipment-popup" hidden>/, 'the equipment popup ships hidden by default');
  assert.match(equipPopupHtml, /<div class="routing-hub-equipment-popup-backdrop" data-routing-popup-close="true"><\/div>/, 'a backdrop dismisses the popup');
  assert.match(equipPopupHtml, /<div class="routing-hub-equipment-popup-card" role="dialog" aria-modal="true" aria-labelledby="routing-hub-equipment-popup-title">/, 'the card is an aria dialog labelled by its title');
  assert.match(equipPopupHtml, /<button type="button" class="routing-hub-info-popup-close" data-routing-popup-close="true" aria-label="閉じる">×<\/button>/, 'the popup reuses the shared close button');
  assert.match(equipPopupHtml, /<div id="routing-hub-equipment-popup-body" class="routing-hub-equipment-popup-body"><\/div>/, 'the popup carries the body container the opener renders into');

  // STYLE: the 装備 detail popup consumes the routing token layer only (no literal color pin — test-by-token).
  const equipPopupCss = css.match(/\.routing-hub-equipment-popup \{[\s\S]*?\.routing-hub-equipment-popup-effects \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(equipPopupCss, '', 'the 装備 detail popup CSS block should exist');
  assert.match(equipPopupCss, /\.routing-hub-equipment-popup-card \{[\s\S]*?background:\s*var\(--routing-panel-strong\);/, 'the popup card wears a routing panel token');
  assert.match(equipPopupCss, /\.routing-hub-equipment-popup-status\[data-state="equipped"\] \{[\s\S]*?border-color:\s*var\(--routing-starlight\);/, 'the 装備中 status chip reads the starlight token');
  assert.doesNotMatch(equipPopupCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the 装備 detail popup CSS pins no literal color (routing token layer only)');
  // The now-clickable owned row + equipped card body carry a cursor affordance, still token-only.
  assert.match(css, /\.routing-hub-info-equip-owned-row:hover \{[\s\S]*?box-shadow:\s*0 0 12px var\(--routing-glow\);/, 'the clickable owned row shows a routing-glow hover affordance');
  assert.match(css, /\.routing-hub-info-equip-equipped \{[\s\S]*?cursor:\s*pointer;/, 'the clickable equipped card body shows a pointer affordance');

  // STYLE: the section chrome + 装備欄 (incl. the equip/unequip candidate & action buttons + feedback line) consume
  // the routing token layer only (no literal color pin — test-by-token).
  const equipCss = css.match(/\/\* Inventory drawer sections[\s\S]*?\/\* Money:/)?.[0] ?? '';
  assert.notEqual(equipCss, '', 'the inventory-section + 装備欄 CSS block should exist');
  assert.match(equipCss, /\.routing-hub-info-equip-slot \{[\s\S]*?background:\s*var\(--routing-panel\);/, 'the slot cards wear a routing panel token');
  assert.match(equipCss, /\.routing-hub-info-equip-candidate \{[\s\S]*?background:\s*var\(--routing-panel\);/, 'the 装備 candidate button wears a routing panel token');
  assert.match(equipCss, /\.routing-hub-info-equip-candidate:hover,\s*\n\.routing-hub-info-equip-candidate:focus-visible \{[\s\S]*?box-shadow:\s*0 0 12px var\(--routing-glow\);/, 'the candidate hover/focus reads the routing glow token');
  assert.match(equipCss, /\.routing-hub-info-equip-action \{[\s\S]*?background:\s*var\(--routing-panel-strong\);/, 'the 解除 action button wears a routing panel token');
  assert.match(equipCss, /\.routing-hub-info-equip-feedback\[data-tone="error"\] \{[\s\S]*?var\(--routing-silver-strong\)/, 'the error feedback tone reads a routing silver token (no danger red — the text carries the failure)');
  assert.doesNotMatch(equipCss, /#[0-9a-fA-F]{3,6}\b|rgba?\(/, 'the 装備欄 CSS pins no literal color (routing token layer only)');

  // MONEY: the money block delegates to a large numeric tile + short label (source is currentInventory.money).
  assert.match(js, /money: \(bodyEl\) => \{[\s\S]*?renderRoutingHubMoneyInto\(bodyEl, currentInventory\.money\)/, 'the money category renders through the numeric-tile builder');
  assert.match(js, /function renderRoutingHubMoneyInto\(bodyEl, money\)[\s\S]*?moneyText\(money\)[\s\S]*?'routing-hub-info-money-label'/, 'money is a large numeric tile (moneyText) with a short label');

  // SELF: still the shared player-parameter renderer, re-skinned to routing silver/starlight but SCOPED to
  // the drawer body so the academy / dungeon parameter meters stay byte-equal.
  assert.match(css, /\.routing-hub-info-popup-body \.character-parameter-item meter::-webkit-meter-optimum-value \{\s*\n\s*background:\s*var\(--routing-starlight\);/, 'the self meters are re-skinned to starlight, scoped to the drawer body');
  assert.match(css, /\.routing-hub-info-popup-body \.character-parameter-section \{[\s\S]*?background:\s*var\(--routing-panel\);/, 'each self parameter group reads as a routing card, scoped to the drawer body');
  const sharedSectionH4 = cssRuleBlock(css, '.character-parameter-section h4');
  assert.match(sharedSectionH4, /color:\s*var\(--accent-gold\);/, 'the shared parameter heading keeps its academy gold tone (routing scopes its own re-skin)');
  const sharedItem = cssRuleBlock(css, '.character-parameter-item');
  assert.match(sharedItem, /background:\s*var\(--surface-character-parameter-item\);/, 'the shared parameter item keeps its academy surface (routing scopes its own re-skin)');
});

test('routing hub corner ornaments: chat panel corners are corner_01 with the top-left upright and the bottom-right its 180° point reflection (scale(-1,-1)) / standee frame carries the corner_02 (mirror) system with its bottom-right the 180° point reflection of its top-left, seated flush (index.html + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // Chat panel corners are <img> whose src is fixed in markup: BOTH are corner_01. The top-left seats upright
  // (calibration translate only); the bottom-right is its 180° point reflection — the same corner_01 asset with
  // scale(-1, -1) (上下左右反転) — each hugging its own corner at -6px. The calibration translate is composed IN
  // FRONT of the flip (same ordering as the standee corners), so dragging stays natural and the baked offsets
  // seat each corner.
  assert.match(html, /class="routing-hub-corner routing-hub-corner-tl"[^>]*src="\/canonical\/routing\/ui\/corner_01\.png"/, 'the chat top-left ornament img is corner_01');
  assert.match(html, /class="routing-hub-corner routing-hub-corner-br"[^>]*src="\/canonical\/routing\/ui\/corner_01\.png"/, 'the chat bottom-right ornament img is corner_01 (same asset as the top-left)');
  assert.match(css, /\.routing-hub-corner-tl \{[^}]*top:\s*-6px[^}]*left:\s*-6px[^}]*\}/, 'the chat top-left ornament hugs the corner at -6px');
  assert.match(css, /\.routing-hub-corner-tl \{[^}]*transform:\s*translate\(var\(--rh-chat-corner-tl-dx\), var\(--rh-chat-corner-tl-dy\)\);[^}]*\}/, 'the chat top-left ornament carries only the calibration translate offset');
  assert.doesNotMatch(css, /\.routing-hub-corner-tl \{[^}]*(?:rotate|scale)[^}]*\}/, 'the chat top-left ornament stays upright (calibration translate only, no flip/rotate)');
  assert.match(css, /\.routing-hub-corner-br \{[^}]*bottom:\s*-6px[^}]*right:\s*-6px[^}]*transform:\s*translate\(var\(--rh-chat-corner-br-dx\), var\(--rh-chat-corner-br-dy\)\) scale\(-1, -1\);[^}]*\}/, 'the chat bottom-right ornament is the 180° point reflection of the top-left: the same calibration translate composed in front of a scale(-1, -1) flip, hugging the corner at -6px');

  // Standee frame corners are ::before (top-left) + ::after (bottom-right), BOTH the single corner_02 asset
  // (the standee's design system, the mirror partner of the chat's corner_01). corner_02 seats at a top-right
  // corner, so ::before rotates it -90° to seat at the top-left and ::after rotates it +90° to seat at the
  // bottom-right — and +90° = -90° + 180°, so the bottom-right is the point reflection of the top-left. Each is
  // a tile-sized square box pinned at its own corner (-6px, matching the chat corners) and rotated about its
  // own centre. Each transform carries a leading calibration translate composed in front of the rotation; the
  // baked offsets seat each ornament.
  const standeeCornerRule = css.match(/\.routing-hub-standee-frame::before,\s*\n\s*\.routing-hub-standee-frame::after \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.notEqual(standeeCornerRule, '', 'the standee frame defines its corner ornaments via a shared ::before/::after rule');
  assert.match(standeeCornerRule, /width:\s*clamp\(30px, 3\.2vw, 48px\);/, 'the standee corner ornaments are tile-sized square boxes (so they rotate about their own centre and stay seated)');
  assert.match(standeeCornerRule, /background-image: url\('\/canonical\/routing\/ui\/corner_02\.png'\);/, 'both standee corners use the single corner_02 asset (the mirror-partner design system of the chat panel)');
  assert.match(standeeCornerRule, /background-size: contain;/, 'the corner_02 tile is contained within each square corner box');
  assert.doesNotMatch(standeeCornerRule, /corner_01/, 'the standee corners no longer use corner_01 (they are the corner_02 mirror system)');
  assert.match(css, /\.routing-hub-standee-frame::before \{\s*\n\s*top:\s*-6px;\s*\n\s*left:\s*-6px;\s*\n\s*transform:\s*translate\(var\(--rh-standee-corner-tl-dx\), var\(--rh-standee-corner-tl-dy\)\) rotate\(-90deg\);\s*\n\}/, 'the standee top-left ornament (::before) is corner_02 seated at the top-left via rotate(-90deg), after the calibration translate, hugging the corner at -6px');
  assert.match(css, /\.routing-hub-standee-frame::after \{\s*\n\s*bottom:\s*-6px;\s*\n\s*right:\s*-6px;\s*\n\s*transform:\s*translate\(var\(--rh-standee-corner-br-dx\), var\(--rh-standee-corner-br-dy\)\) rotate\(90deg\);\s*\n\}/, 'the standee bottom-right ornament (::after) is corner_02 rotate(90deg) = the -90deg top-left plus a 180° half-turn (point reflection), seated at the bottom-right and hugging the corner at -6px');
});

test('routing hub frame decorations offset through baked calibration custom properties, and the dev calibration UI never ships in normal-play markup (index.html + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');

  // The four corner-offset custom-property pairs are defined as real declarations on .routing-hub-screen,
  // baked from the dev drag-calibration tool (test-by-token: each token is defined at its confirmed value,
  // and the rules consume var(--token) with no fallback).
  const routingScreenCss = cssRuleBlock(css, '.routing-hub-screen');
  for (const [varName, value] of [
    ['--rh-standee-corner-tl-dx', '-1px'], ['--rh-standee-corner-tl-dy', '-6px'],
    ['--rh-standee-corner-br-dx', '2px'], ['--rh-standee-corner-br-dy', '6px'],
    ['--rh-chat-corner-tl-dx', '-6px'], ['--rh-chat-corner-tl-dy', '-8px'],
    ['--rh-chat-corner-br-dx', '7px'], ['--rh-chat-corner-br-dy', '9px']
  ]) {
    assert.match(routingScreenCss, new RegExp(`${varName}:\\s*${value};`), `${varName} is baked to ${value} on .routing-hub-screen`);
  }

  // The drag-calibration UI is injected by app.js ONLY under ?calibrate=<screen>, so the shipped markup that
  // normal play serves must carry none of it (校正 UI は通常プレイに露出しない).
  assert.doesNotMatch(html, /frame-decoration-calibration/, 'the calibration overlay markup must not be present in the shipped index.html (dev-only, injected on ?calibrate=)');
});

// ── Shared conversation stage: DOM-independent core (headless behavioral unit tests) ────────────────
// conversationStage.js is the reusable 会話ステージ 部品 (routing hub is its first consumer; the daytime
// conversation screen will be the second). Its DOM-independent core is exercised here by importing and
// calling it directly — the headless split matching routingDispatchClient / dungeonCamera / mapHoverPlacement.
// The DOM factory (createConversationStage) + starfield ambient are covered against real Blink layout by
// app/tests/manual/routingHubSessionScreenRender.mjs.

test('routing hub speaker name opens ルミの一枚絵 character popup (standee + name, no ability section) — token-only, fail-fast, other screens byte-equal (index.html + app.js + style.css)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');
  const css = await readFile(`${root}/style.css`, 'utf8');
  const block = html.match(/<section id="routing-hub-screen"[\s\S]*?<\/section>\s*\n\s*<section id="academy-training-screen"/)?.[0] ?? '';
  assert.notEqual(block, '', 'the routing hub screen section should exist');

  // Markup: a hidden-toggled routing character popup with a backdrop + close affordance, a name title, and a
  // standee image — no ability section (the routing persona is a non-selectable actor with no parameters). The
  // fixed persona name is never hardcoded (it renders at open via JS), mirroring the frame-caption no-name rule.
  assert.match(block, /<div id="routing-hub-character-popup" class="routing-hub-character-popup" hidden>/, 'the routing character popup starts hidden (toggled via the hidden attribute)');
  assert.match(block, /class="routing-hub-character-popup-backdrop" data-routing-popup-close="true"/, 'the routing character popup has a backdrop-click close affordance');
  assert.match(block, /id="routing-hub-character-popup"[\s\S]*?class="routing-hub-info-popup-close" data-routing-popup-close="true"[\s\S]*?id="routing-hub-character-popup-standee"/, 'the routing character popup has a close button and a standee image');
  assert.match(block, /<h3 id="routing-hub-character-popup-title"/, 'the routing character popup carries a name title (set from the persona at open)');
  assert.doesNotMatch(block, /routing-hub-character-popup-parameters|character-parameter/, 'the routing character popup shows no ability section (the routing persona carries no parameters)');
  assert.doesNotMatch(block, /ルミ/, 'the routing character popup markup must not hardcode a persona name (it renders from the persona at open)');

  // Open/close JS: resolves the routing persona actor (fail-fast if unregistered) + the shared standee helper, sets
  // the name, and shows/hides via the hidden attribute — no fabricated profile field beyond the name.
  assert.match(js, /function openRoutingHubCharacterPopup\(\) \{[\s\S]*?routingPersonaActor\(\)[\s\S]*?characterSceneStandeeUrl\(persona\)[\s\S]*?popup\.hidden = false;/, 'openRoutingHubCharacterPopup resolves the routing persona + shared standee helper and shows the popup');
  assert.match(js, /function closeRoutingHubCharacterPopup\(\) \{[\s\S]*?popup\.hidden = true;/, 'closeRoutingHubCharacterPopup hides the popup');
  // The speaker-name click is delegated on the hub stream: only the 相手側 (character) bubble carries a
  // .message-speaker, so the 主人公側 is never clickable.
  assert.match(js, /#routing-hub-message-stream'\)\.addEventListener\('click'[\s\S]*?closest\('\.message-speaker'\)[\s\S]*?openRoutingHubCharacterPopup\(\)/, 'the hub speaker name opens the popup via delegated click on the stream (character side only)');
  assert.match(js, /#routing-hub-character-popup \[data-routing-popup-close\]'\)[\s\S]*?closeRoutingHubCharacterPopup\(\)/, 'the routing character popup close button + backdrop dismiss it');

  // CSS: token-only (--routing-*, no literal color pin); the standee cover-fills its frame; the speaker name shows a
  // clickable hover affordance; the shared .message-speaker stays non-clickable (the affordance is routing-scoped).
  const cardCss = cssRuleBlock(css, '.routing-hub-character-popup-card');
  assert.match(cardCss, /background:\s*var\(--routing-panel-strong\);/, 'the routing character popup card consumes the --routing-* panel token');
  assert.doesNotMatch(cardCss, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the routing character popup card has no literal color pin (token-only)');
  const standeeCss = cssRuleBlock(css, '.routing-hub-character-popup-standee');
  assert.match(standeeCss, /object-fit:\s*cover;/, 'the routing character popup standee cover-fills its frame');
  const nameCss = cssRuleBlock(css, '.routing-hub-message-stream .message-speaker');
  assert.match(nameCss, /cursor:\s*pointer;/, 'the hub speaker name shows a clickable affordance (cursor pointer)');
  const sharedSpeaker = cssRuleBlock(css, '.message-speaker');
  assert.doesNotMatch(sharedSpeaker, /cursor:\s*pointer/, 'the shared .message-speaker stays non-clickable (the affordance is routing/day-scoped)');
});

test('収蔵庫 (library collection) is the routing hub 7th info-drawer category — hub-only, diary-async grammar, saved-fragment re-read, no re-fetch, empty-legit (index.html + app.js + libraryCollectionViewClient.js)', async () => {
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // HUB-ONLY: the routing hub rail carries the 7th 収蔵庫 button (after diary) with its generated icon; the
  // conversation-day rail does NOT gain a library category (stays at six — byte-equal 導線).
  const hubBlock = html.match(/<nav class="routing-hub-category-rail"[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.notEqual(hubBlock, '', 'the routing hub category rail should exist');
  assert.match(hubBlock, /data-routing-category="diary"[\s\S]*?data-routing-category="library"[\s\S]*?src="\/canonical\/routing\/icons\/library\.png"[\s\S]*?収蔵庫/, 'the hub rail carries the 収蔵庫 library button after diary with its generated icon');
  const dayBlock = html.match(/<nav class="conversation-day-category-rail"[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.notEqual(dayBlock, '', 'the conversation-day category rail should exist');
  assert.doesNotMatch(dayBlock, /data-day-category="library"/, 'the conversation-day rail does NOT gain the library category (hub-only)');

  // Title set + renderer wired for the routing hub only; conversation-day title set unchanged (no library).
  assert.match(js, /const ROUTING_HUB_CATEGORY_TITLES = Object\.freeze\(\{[\s\S]*?diary: '日記',\s*\n\s*library: '収蔵庫'\s*\n\s*\}\)/, 'the routing hub title set gains the 収蔵庫 library category (after diary)');
  const dayTitles = js.match(/const CONVERSATION_DAY_CATEGORY_TITLES = Object\.freeze\(\{[\s\S]*?\}\)/)?.[0] ?? '';
  assert.doesNotMatch(dayTitles, /library:/, 'the conversation-day title set does NOT gain a library category (hub-only)');
  assert.match(js, /library: \(bodyEl\) => renderRoutingHubLibraryCollectionInto\(bodyEl\)/, 'the routing stage wires the library collection renderer');

  // The read + parse contract lives in the headless-tested client module; app.js imports it (no re-implementation).
  assert.match(js, /import \{ LIBRARY_COLLECTION_REQUEST_PATH, parseLibraryCollectionEntries \} from '\.\/libraryCollectionViewClient\.js'/, 'app.js imports the collection request-path + response-parse helpers from the headless client module');
  const fetchFn = js.match(/async function fetchLibraryCollection\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fetchFn, '', 'fetchLibraryCollection should exist');
  assert.match(fetchFn, /fetch\(LIBRARY_COLLECTION_REQUEST_PATH\)/, 'the collection fetch builds its URL through the client request-path constant');
  assert.match(fetchFn, /if \(!response\.ok\) \{[\s\S]*?throw new Error/, 'a non-OK collection response fails fast (no silent empty shelf)');
  assert.match(fetchFn, /return parseLibraryCollectionEntries\(await response\.json\(\)\)/, 'the response is validated through the client parser (entries in received order)');

  // DIARY ASYNC GRAMMAR: the sync renderer bumps the token, shows a loading card synchronously, and fires the
  // async loader routing a failure to reportError. The async loader discards a stale (token) / category-switched
  // fetch before rendering the shelf.
  const syncFn = js.match(/function renderRoutingHubLibraryCollectionInto\(bodyEl\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(syncFn, '', 'renderRoutingHubLibraryCollectionInto should exist');
  assert.match(syncFn, /const token = \(libraryCollectionFetchToken \+= 1\);/, 're-opening 収蔵庫 bumps the fetch token (abandons an in-flight fetch)');
  assert.match(syncFn, /bodyEl\.replaceChildren\(routingHubLibraryLoadingCard\(\)\);/, 'a loading card shows synchronously before the async load');
  assert.match(syncFn, /loadRoutingHubLibraryCollection\(bodyEl, token\)\.catch\(reportError\);/, 'the async loader is fired with the captured token, routing a failure to reportError');
  const loadFn = js.match(/async function loadRoutingHubLibraryCollection\(bodyEl, token\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(loadFn, '', 'loadRoutingHubLibraryCollection should exist');
  assert.match(loadFn, /const entries = await fetchLibraryCollection\(\);/, 'the loader fetches the collection through the shared fetch');
  assert.match(loadFn, /if \(token !== libraryCollectionFetchToken\) return;/, 'a stale (re-opened) fetch is discarded before render');
  assert.match(loadFn, /if \(!popup \|\| popup\.dataset\.category !== 'library'\) return;/, 'a category-switched fetch is discarded before render (no stale flash)');
  assert.match(loadFn, /renderRoutingHubLibraryShelf\(bodyEl, entries\);/, 'only a current + on-category fetch renders the shelf');

  // SHELF: entries render in the RECEIVED ORDER (no client re-sort); an empty collection is a legitimate initial
  // state (a quiet empty card, not an error).
  const shelfFn = js.match(/function renderRoutingHubLibraryShelf\(bodyEl, entries\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(shelfFn, '', 'renderRoutingHubLibraryShelf should exist');
  assert.match(shelfFn, /for \(const entry of entries\) \{[\s\S]*?shelf\.append\(routingHubLibrarySpineButton\(bodyEl, entry, entries\)\)/, 'the shelf renders spines in the received order');
  assert.doesNotMatch(shelfFn, /\.sort\(/, 'the shelf does not re-sort entries (backend order is authoritative)');
  assert.match(shelfFn, /if \(entries\.length === 0\) \{[\s\S]*?routingHubInfoEmptyCard\('まだ何も収蔵されていません'/, 'an empty collection shows a quiet empty card (not an error)');

  // SPINE: layer picks the 装丁 tone (data-layer); clicking re-reads the saved fragment.
  const spineFn = js.match(/function routingHubLibrarySpineButton\(bodyEl, entry, entries\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(spineFn, '', 'routingHubLibrarySpineButton should exist');
  assert.match(spineFn, /button\.dataset\.layer = entry\.layer;/, 'the spine 装丁 tone is chosen by the book layer (data-layer)');
  assert.match(spineFn, /button\.addEventListener\('click', \(\) => showRoutingHubLibraryEntry\(bodyEl, entry, entries\)\)/, 'clicking a spine re-reads that book');

  // RE-READ: the saved text is shown AS-IS — no re-fetch / re-generation. ← 棚に戻る re-renders the shelf from the
  // same in-memory entries (no re-fetch), and the read view reads only the entry's own saved text + read_week.
  const showFn = js.match(/function showRoutingHubLibraryEntry\(bodyEl, entry, entries\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(showFn, '', 'showRoutingHubLibraryEntry should exist');
  assert.match(showFn, /text\.textContent = entry\.text;/, 're-reading shows the entry saved text as-is');
  assert.doesNotMatch(showFn, /fetch\(|getJson\(|postJson\(/, 're-reading a collected book does NOT re-fetch / re-generate (the entry carries its own fragment)');
  const backFn = js.match(/function routingHubLibraryBackButton\(bodyEl, entries\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(backFn, /button\.addEventListener\('click', \(\) => renderRoutingHubLibraryShelf\(bodyEl, entries\)\)/, '← 棚に戻る re-renders the shelf from the cached entries (no re-fetch)');
  const headerFn = js.match(/function routingHubLibraryEntryHeader\(entry\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(headerFn, /第\$\{conversationStageWeek\(entry\.read_week\)\}週に読んだ/, 'the read view labels the book with its 分類 + the 1-based read week');
});

test('収蔵庫 drawer CSS: the 自分の書斎棚 reuses the diary drawer grammar, layer-toned spines, and consumes --routing-* tokens only (style.css)', async () => {
  const css = await readFile(`${root}/style.css`, 'utf8');

  const shelfCss = cssRuleBlock(css, '.routing-hub-info-library-shelf');
  assert.notEqual(shelfCss, '', 'the .routing-hub-info-library-shelf rule should exist');
  assert.match(shelfCss, /flex-wrap:\s*wrap;/, 'the shelf wraps spines onto the next row');
  assert.doesNotMatch(shelfCss, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the shelf rule has no literal color pin (token-only)');

  const spineCss = cssRuleBlock(css, '.routing-hub-info-library-spine');
  assert.notEqual(spineCss, '', 'the .routing-hub-info-library-spine rule should exist');
  assert.match(spineCss, /border-top:\s*4px solid var\(--spine-accent\);/, 'the spine 装丁 tone rides the --spine-accent token (set per data-layer)');
  assert.doesNotMatch(spineCss, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the spine rule has no literal color pin (token-only)');
  // Each layer sets --spine-accent to a distinct --routing-* token (no literal color).
  assert.match(css, /\.routing-hub-info-library-spine\[data-layer='core'\] \{\s*\n\s*--spine-accent: var\(--routing-moon\);/, 'core spines take the 月光 accent token');
  assert.match(css, /\.routing-hub-info-library-spine\[data-layer='periphery'\] \{\s*\n\s*--spine-accent: var\(--routing-starlight\);/, 'periphery spines take the 星明かり accent token');
  assert.match(css, /\.routing-hub-info-library-spine\[data-layer='generated'\] \{\s*\n\s*--spine-accent: var\(--routing-silver-dim\);/, 'generated spines take the くすんだ銀 accent token');

  const titleCss = cssRuleBlock(css, '.routing-hub-info-library-spine-title');
  assert.match(titleCss, /writing-mode:\s*vertical-rl;/, 'the spine title runs vertically (背表紙 lettering)');
  assert.match(titleCss, /text-overflow:\s*ellipsis;/, 'a long title truncates rather than overflowing the spine');

  const textCss = cssRuleBlock(css, '.routing-hub-info-library-entry-text');
  assert.match(textCss, /color:\s*var\(--routing-silver\);/, 'the re-read text consumes the routing silver token');
  assert.match(textCss, /white-space:\s*pre-wrap;/, 'the re-read text preserves the saved fragment line breaks');
  assert.doesNotMatch(textCss, /rgb\(|#[0-9a-fA-F]{3,8}/, 'the re-read text rule has no literal color pin (token-only)');
});

test('routing graduation guide (routing week 50): the selection turn transitions to the character graduation event, the guide end keeps the hub alive, and phase 2 ends to the title', async () => {
  const js = await readFile(path.join(root, 'app.js'), 'utf8');

  // (Goal 1, in-turn) The in-turn graduation guide START contract is removed: the guide now begins at hub start
  // (POST /api/routing/hub/start seeds routing_graduation_guide at the displayed week 50), never on a decided
  // turn, so no turn response carries graduation_guide with no dispatch. The hub send handler therefore has NO
  // graduation_guide branch — it returns early for an in-turn dispatch and for a confirmed selection, then falls
  // through to the normal auto-end.
  const hubSendFn = js.match(/async function runRoutingHubConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(hubSendFn, '', 'runRoutingHubConversation should exist');
  assert.match(hubSendFn, /if \(isRoutingTurnDispatch\(result\)\) return;\s*\n[\s\S]*?if \(isRoutingGraduationGuideSelection\(result\)\) return;\s*\n\s*if \(await autoEndConversationAfterFinalReply\(result\)\) return;/, 'the hub send handler returns early for an in-turn dispatch and a confirmed selection, then falls through to the normal auto-end (no in-turn guide-start branch)');
  assert.doesNotMatch(hubSendFn, /if \(result\.graduation_guide\)/, 'the hub send handler has no in-turn graduation guide start branch (removed contract)');

  // The guide-active condition and the selection gate are routing-gated state reads (no fabricated data).
  assert.match(js, /function isRoutingGraduationGuideSelection\(result\) \{[\s\S]*?currentPlayMode === 'routing' && Boolean\(result\?\.routing_graduation_guide_selection\)/, 'a graduation guide selection is gated on routing mode and the presence of routing_graduation_guide_selection');
  assert.match(js, /function isRoutingGraduationEndingConversation\(\) \{[\s\S]*?currentRuntimeState\?\.pending_interaction_context\?\.event_flag_id === 'event\.graduation_ending\.ready'/, 'the phase-2 graduation conversation is identified by the graduation ending event flag in the pending-interaction context');

  // (Goal 3, stream) The selection turn's SSE emits graduation_guide_draining (same層 as routing_draining); the
  // hub turn stream starts a graduation 見送り読みポーズ on it, runs it concurrently with the backend drain, and — on
  // the routing_graduation_guide_selection result — awaits the pause, drops the hub id, and hands off to the loop
  // graduation entry. A half-signalled selection stream fails fast the same way the dispatch pairing does.
  const hubTurnStreamFn = js.match(/async function runRoutingHubTurnStream\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(hubTurnStreamFn, '', 'runRoutingHubTurnStream should exist');
  assert.match(hubTurnStreamFn, /if \(event === 'graduation_guide_draining'\) \{\s*\n\s*beginGraduationSelectionPause\(\);/, 'graduation_guide_draining starts the graduation 見送り読みポーズ mid-stream so it overlaps the backend drain');
  const gradPauseFn = hubTurnStreamFn.match(/function beginGraduationSelectionPause\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(gradPauseFn, '', 'beginGraduationSelectionPause should exist inside runRoutingHubTurnStream');
  assert.match(gradPauseFn, /await reveal\.drain\(\);[\s\S]*?routingHubStage\.setResponding\(false\);[\s\S]*?await sleep\(DRAIN_READING_PAUSE_MS\);[\s\S]*?if \(!finalResult && !streamFailed\) \{[\s\S]*?routingHubStage\.flashDispatchClimax\(\);\s*\n\s*showGraduationEndingStartLoadingScreen\(\);\s*\n\s*drainLoadingShown = true;/, 'the graduation reading pause drains the send-off, holds ~5s concurrently with the drain, and (pause-first) raises the graduation-ending-start loading screen');
  assert.match(hubTurnStreamFn, /if \(Boolean\(guideSelection\) !== Boolean\(graduationSelectionPause\)\) \{[\s\S]*?throw new Error/, 'the turn fails fast on a graduation_guide_draining / routing_graduation_guide_selection mismatch (no silent tolerance)');
  assert.match(hubTurnStreamFn, /if \(guideSelection\) \{[\s\S]*?await graduationSelectionPause;\s*\n\s*clearRoutingHubConversation\(\);\s*\n\s*if \(!drainLoadingShown\) routingHubStage\.flashDispatchClimax\(\);\s*\n\s*await startRoutingGraduationEndingFromSelection\(\{ result: finalResult, loadingAlreadyVisible: drainLoadingShown \}\);/, 'a confirmed selection awaits the concurrent graduation reading pause, drops the hub id, plays ③ once, and hands off to the graduation event entry');

  // The dispatch pairing check is preserved and unchanged, and no graduation_guide branch precedes it any more:
  // the in-turn guide START contract is removed (the guide begins at hub start, never on a decided turn), so the
  // pairing check follows the result destructuring directly.
  assert.match(hubTurnStreamFn, /const guideSelection = finalResult\.routing_graduation_guide_selection \?\? null;\s*\n\s*\/\/[\s\S]*?if \(Boolean\(routingDispatch\) !== Boolean\(sendoffReadingPause\)\) \{[\s\S]*?throw new Error/, 'the dispatch pairing check follows the result destructuring directly, with no in-turn graduation guide start branch before it');
  assert.doesNotMatch(hubTurnStreamFn, /if \(finalResult\.graduation_guide\)/, 'the hub turn stream has no in-turn graduation guide start branch (removed contract)');

  // The selection transition reuses the loop graduation entry: it validates the selected character + post-state
  // (fail-fast on missing), then routeGraduationEndingSession opens the event on the academy_conversation_screen
  // preset landing (daytime by default, legacy session on 'legacy' — its own branch, asserted in
  // uiIntegration.eventConversationDay) under the graduation-ending-start loading (loadingAlreadyVisible when the
  // pause already raised it).
  const selectionFn = js.match(/async function startRoutingGraduationEndingFromSelection\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(selectionFn, '', 'startRoutingGraduationEndingFromSelection should exist');
  assert.match(selectionFn, /const characterId = result\?\.graduation_ending\?\.character_id;[\s\S]*?throw new Error/, 'the selection transition fails fast on a missing graduation_ending.character_id');
  assert.match(selectionFn, /if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error/, 'the selection transition fails fast on a missing post-selection state (no stale-state fallback)');
  assert.match(selectionFn, /await routeGraduationEndingSession\(\{\s*\n\s*character_id: characterId,\s*\n\s*state: result\.state,\s*\n\s*flag_id: 'event\.graduation_ending\.ready',[\s\S]*?\}, \{ loadingAlreadyVisible \}\)/, 'the selection transition reuses the shared loop graduation entry (routeGraduationEndingSession)');
  assert.match(js, /function showGraduationEndingStartLoadingScreen\(\) \{\s*\n\s*setAcademyLoadingDestinationCopy\(null, \{ copyKey: 'graduation-ending-start' \}\);\s*\n\s*showScreen\('academy-loading'\);\s*\n\}/, 'the graduation selection loading screen uses the shared graduation-ending-start copy');

  // (Goal 3, non-stream) The POST /api/conversation path reaches the same landing: it reveals the 見送り
  // sequentially then starts the graduation event, mirroring the in-turn dispatch handling.
  const runConversationFn = js.match(/async function runConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(runConversationFn, /if \(conversationShouldAutoEnd\(result\) \|\| isRoutingTurnDispatch\(result\) \|\| isRoutingGraduationGuideSelection\(result\)\) \{[\s\S]*?renderConversationResultSequentially\(result\)/, 'the non-stream turn renders a graduation guide selection send-off sequentially');
  assert.match(runConversationFn, /if \(isRoutingGraduationGuideSelection\(result\)\) \{\s*\n\s*await startRoutingGraduationEndingFromSelection\(\{ result, loadingAlreadyVisible: false \}\);\s*\n\s*return;\s*\n\s*\}/, 'the non-stream turn starts the graduation event for a confirmed selection (same landing as the stream path)');

  // (Goal 1, end) Ending via 今日はここまで during / into the graduation guide keeps the hub alive: the routing
  // end branches on graduation_guide (no dispatch) BEFORE the drained-finalization content-return assertion (which
  // would throw on the 'idle' guide-continue status), adopts the state, returns to the hub, and reveals ルミ's
  // guide reply through the hub reveal — never clearing routingHubConversationId or navigating away.
  const endFn = js.match(/async function endRoutingConversation\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(endFn, '', 'endRoutingConversation should exist');
  assert.match(endFn, /const dispatch = result\.routing_dispatch \?\? null;\s*\n\s*if \(result\.graduation_guide\) \{[\s\S]*?if \(dispatch\) \{[\s\S]*?throw new Error[\s\S]*?\}[\s\S]*?if \(!result\.state \|\| typeof result\.state !== 'object'\) \{[\s\S]*?throw new Error[\s\S]*?\}\s*\n\s*currentRuntimeState = result\.state;\s*\n\s*showScreen\('routing-hub'\);\s*\n\s*await revealResultSequentially\(routingHubStage\.surface, result\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(dispatch\) \{/, 'a graduation guide end stays on the hub (fail-fast on missing state or a dispatch alongside it, adopt state, reveal the guide reply) before the dispatch / content-return branches');

  // (Goal 5) Phase 2 (the selected character's graduation event on academy-conversation-session) ends through the
  // SHARED loop graduation title route, not the hub drain-on-exit: endConversation skips the routing delegation
  // for the graduation ending conversation so it reaches the existing graduation-ending-complete → title body.
  assert.match(js, /if \(currentPlayMode === 'routing' && !isRoutingGraduationEndingConversation\(\)\) \{\s*\n\s*await endRoutingConversation\(\);\s*\n\s*return;\s*\n\s*\}/, 'the phase-2 graduation ending conversation takes the loop graduation title route (endConversation skips the routing hub drain-on-exit for it)');
});
