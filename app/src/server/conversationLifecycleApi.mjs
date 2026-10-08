import { academyPostTurnStatePolicy, companionPostTurnStatePolicy } from '../llm/conversationPipeline.mjs';
import { resolvePostContentScreen } from '../playMode.mjs';
import { resetGatheringStocks } from '../economy.mjs';
import { prepareAcademyStageSituationsForState, prepareSanrinCreaturePlacementsForState } from '../fieldRuntime.mjs';
import { guideGraduationSceneContext, normalizeRoutingHubContext } from '../routingMetaContext.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../routingPersona.mjs';
import { isGraduationEndingContext as isGraduationEndingContextForState } from '../graduationEnding.mjs';
import { resolveAcademyConversationLandingScreen } from './conversationPopupSettingsApi.mjs';
import {
  ROUTING_ACTIVE_ERRAND_STATE_KEY,
  buildRoutingErrandSceneContext,
  readActiveRoutingErrand
} from '../routingErrands.mjs';
import {
  ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY,
  applyStudyCircleCompletion,
  buildRoutingStudyCircleSceneContext,
  readActiveRoutingStudyCircle
} from '../routingStudyCircle.mjs';
import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  buildErrandContentResult,
  buildHomunculusContentResult,
  buildStudyCircleRoutingContentResult
} from '../routingContentResult.mjs';
import {
  ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY,
  ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY,
  matchingActiveAtelierConversation
} from '../homunculusAtelierVisit.mjs';
import { atelierInjectedSceneContext } from '../homunculusScene.mjs';
import {
  buildRoutingWeekProgressionKey,
  findRoutingWeekProgression,
  findRoutingWeekProgressionByConversation,
  isGuideGraduationInFlight,
  isRoutingWeekProgressionRecordApplied,
  readRoutingGraduationGuide,
  startGraduationEndingConversationForCharacter,
  startGuideGraduationConversation,
  startNextAcademyWeek
} from '../graduationEnding.mjs';
import { selectableCharacterChoice } from '../characterCatalog.mjs';
import {
  assertNoFailedPendingFinalizations,
  drainAllPendingFinalizations,
  enqueuePendingFinalization,
  enqueuePendingFinalizationInState,
  removePendingFinalizationInState,
  retryPendingFinalizationForCharacter,
  runOutsideRoutingReadScope,
  runRoutingReadScopeIfActive
} from '../routingFinalizeQueue.mjs';
import { isRoutingTitleDispatch, resolveRoutingDestinationDispatch, resolveRoutingHubDispatch } from '../routingDispatch.mjs';
import { ensureLmStudioConversationConfig } from './lmStudioSettingsApi.mjs';
import {
  buildFootprintSummaryMaterial,
  generateFootprintSummary,
  mockFootprintSummary,
  withFootprintSummary,
  withoutFootprintSummary
} from '../llm/footprintSummary.mjs';
import { runExclusiveConversationWork } from './conversationTurnExclusion.mjs';
import { readGraduationRoad } from '../graduationRoad.mjs';

const CONVERSATION_LIFECYCLE_ROUTES = new Set([
  'POST /api/conversation/opening',
  'POST /api/conversation',
  'POST /api/conversation/finalize/retry',
  'POST /api/conversation/end',
  'GET /api/graduation/road'
]);

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

function assertValidConversationIdForApi(value, fieldName = 'id') {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (CONVERSATION_ID_PATTERN.test(normalized)) return normalized;
  const error = new Error(`invalid ${fieldName}: ${value}`);
  error.code = 'INVALID_CONVERSATION_ID';
  error.errorCode = 'invalid_conversation_id';
  error.statusCode = 400;
  throw error;
}

export function canHandleConversationLifecycleApiRoute(method, pathname) {
  return CONVERSATION_LIFECYCLE_ROUTES.has(`${method} ${pathname}`);
}

export function isConversationOpeningRoute(method, pathname) {
  return method === 'POST' && pathname === '/api/conversation/opening';
}

function assertActivePlayMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object' || Array.isArray(activePlayMode)) {
    throw new Error('activePlayMode is required');
  }
  if (activePlayMode.mode !== 'loop' && activePlayMode.mode !== 'routing') {
    throw new Error(`activePlayMode.mode must be loop or routing: ${activePlayMode.mode}`);
  }
  return activePlayMode;
}

// The routing persona variant the 案内人's graduation conversation speaks in (its turns, and the opening that restores it
// on a load): the save's effective variant, supplied only in routing mode. Loop mode passes undefined, so the pipeline
// keeps the disk-profile behavior and only the guide graduation (gated in the pipeline: the persona actor + the
// graduation ending context, no hub context) consumes it.
export function graduationPersonaVariantForActivePlayMode(activePlayMode) {
  return activePlayMode?.mode === 'routing' ? activePlayMode.routing_persona_variant : undefined;
}

function routingTurnContextMismatch(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.errorCode = 'ROUTING_TURN_CONTEXT_MISMATCH';
  return error;
}

// A turn on the 案内人's graduation conversation (the guide conversation going on as the graduation conversation on the
// terrace) takes the terrace scene as its injected 舞台 every turn, and the companion post-turn policy with it, so the
// terrace never moves the stage. Returns that scene context, or null for every other turn. While the 案内人's graduation
// is in flight, a turn naming another actor or conversation is a context mismatch (fail-fast).
export function guideGraduationSceneContextForTurn({ activePlayMode, state, conversationId, characterId }) {
  if (activePlayMode?.mode !== 'routing' || !isGuideGraduationInFlight(state)) return null;
  if (characterId !== ROUTING_PERSONA_CHARACTER_ID || (conversationId && conversationId !== state.last_conversation_id)) {
    throw routingTurnContextMismatch('a turn during the guide graduation must continue the guide graduation conversation');
  }
  return guideGraduationSceneContext();
}

function routingErrandContextMismatch(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.errorCode = 'ROUTING_ERRAND_CONTEXT_MISMATCH';
  return error;
}

function routingStudyCircleContextMismatch(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.errorCode = 'ROUTING_STUDY_CIRCLE_CONTEXT_MISMATCH';
  return error;
}

function normalizeConversationRoutingHubContext(conversation) {
  if (!Object.prototype.hasOwnProperty.call(conversation ?? {}, 'routing_hub')) return undefined;
  return normalizeRoutingHubContext(conversation.routing_hub);
}

function requestIncludesCharacterId(body) {
  return Object.prototype.hasOwnProperty.call(body ?? {}, 'character_id') && body.character_id != null;
}

function expectsActiveRoutingHubTurn({ playMode, state, activeConversationId }) {
  return playMode.mode === 'routing'
    && Boolean(activeConversationId)
    && state.current_screen === 'interaction'
    && state.current_interaction_character_id === ROUTING_PERSONA_CHARACTER_ID
    // The 案内人's graduation conversation is the guide conversation gone on past the selection, on the same actor id
    // (lina) and the interaction screen, but it is no longer a hub conversation: it carries the graduation ending
    // event context and no routing_hub, so it must not be held to the strict hub-conversation shape.
    && !isGraduationEndingContextForState(state, null);
}

function normalizeStrictRoutingHubContext(conversation, label) {
  if (!conversation) {
    throw routingTurnContextMismatch(`${label} conversation file is missing`);
  }
  if (!Object.prototype.hasOwnProperty.call(conversation, 'routing_hub')) {
    throw routingTurnContextMismatch(`${label} conversation is missing routing_hub`);
  }
  try {
    return normalizeRoutingHubContext(conversation.routing_hub);
  } catch (error) {
    throw routingTurnContextMismatch(`${label} conversation has invalid routing_hub: ${error.message}`);
  }
}

async function readConversationForRoutingTurn({ root, conversationId, readJsonIfExists, requiredLabel = null }) {
  try {
    const conversation = await readJsonIfExists(root, `game_data/logs/conversations/${conversationId}.json`);
    if (requiredLabel) normalizeStrictRoutingHubContext(conversation, requiredLabel);
    return conversation;
  } catch (error) {
    if (requiredLabel && error?.errorCode !== 'ROUTING_TURN_CONTEXT_MISMATCH') {
      throw routingTurnContextMismatch(`${requiredLabel} conversation file is unreadable: ${error.message}`);
    }
    throw error;
  }
}

export async function resolveConversationTurnRequest({
  root,
  body,
  activePlayMode,
  readJson,
  readJsonIfExists
}) {
  const conversationId = assertValidConversationIdForApi(body.id, 'id');
  const characterId = body.character_id ?? 'lina';
  const state = await readJson(root, 'game_data/runtime_state.json');
  const activeConversationId = assertValidConversationIdForApi(state.last_conversation_id, 'last_conversation_id');
  const candidateConversationId = conversationId ?? activeConversationId;
  if (!candidateConversationId) return { conversationId, characterId, routingHubContext: undefined };

  const playMode = assertActivePlayMode(activePlayMode);
  const expectsActiveHub = expectsActiveRoutingHubTurn({ playMode, state, activeConversationId });
  if (expectsActiveHub && conversationId && conversationId !== activeConversationId) {
    throw routingTurnContextMismatch('explicit conversation id does not match the active routing hub conversation');
  }

  const candidateConversation = await readConversationForRoutingTurn({
    root,
    conversationId: candidateConversationId,
    readJsonIfExists,
    requiredLabel: expectsActiveHub && candidateConversationId === activeConversationId ? 'active routing hub' : null
  });
  const routingHubContext = normalizeConversationRoutingHubContext(candidateConversation);
  if (routingHubContext === undefined) {
    return { conversationId, characterId, routingHubContext: undefined };
  }

  if (playMode.mode !== 'routing') {
    throw routingTurnContextMismatch('routing hub conversation turn requires routing play mode');
  }
  if (candidateConversation.id !== activeConversationId) {
    throw routingTurnContextMismatch('routing hub conversation id must match the active conversation');
  }
  if (candidateConversation.character_id !== ROUTING_PERSONA_CHARACTER_ID) {
    throw routingTurnContextMismatch(`routing hub conversation actor must be ${ROUTING_PERSONA_CHARACTER_ID}`);
  }
  if (state.current_interaction_character_id !== candidateConversation.character_id) {
    throw routingTurnContextMismatch('active routing hub actor mismatch');
  }
  if (conversationId && requestIncludesCharacterId(body) && String(body.character_id).trim() !== candidateConversation.character_id) {
    throw routingTurnContextMismatch('explicit routing conversation actor mismatch');
  }
  return {
    conversationId: candidateConversation.id,
    characterId: candidateConversation.character_id,
    routingHubContext
  };
}

function transitionForScreen(screen, { graduationEnding = false } = {}) {
  if (graduationEnding) return { next_screen: 'title', loading_copy_key: 'graduation-ending-complete' };
  if (screen === 'academy-room') return { next_screen: screen, loading_copy_key: 'academy-room' };
  return { next_screen: screen };
}

function transitionForWeekProgression(result) {
  if (result?.route === 'graduation-ending') {
    return { next_screen: result.state.current_screen, loading_copy_key: 'graduation-ending-start' };
  }
  return transitionForScreen(result.state.current_screen);
}

function routingWeekProgressionForDispatch({ conversation, routingDispatch }) {
  const conversationId = assertValidConversationIdForApi(conversation?.id, 'conversation_id');
  const destinationId = String(routingDispatch?.destination_id ?? '').trim();
  const idempotencyKey = buildRoutingWeekProgressionKey({ conversationId, destinationId });
  return {
    idempotency_key: idempotencyKey,
    conversation_id: conversationId,
    destination_id: destinationId
  };
}

function findPendingFinalization(state, conversationId) {
  return (Array.isArray(state?.pending_finalizations) ? state.pending_finalizations : [])
    .find((job) => job?.conversation_id === conversationId) ?? null;
}

// Builds the routing graduation guide prompt/judgment context from the active guide state: the presented
// candidates paired with their display names. Returns undefined when the guide is not active, so a normal
// routing hub turn passes no guide context and runs the routing destination selection unchanged. The display
// names are resolved from the authoring root (the same selectable-character read the roster surfaces use).
export async function resolveRoutingGraduationGuideContext({ root, authoringRoot, state }) {
  const guide = readRoutingGraduationGuide(state);
  if (!guide) return undefined;
  // Resolving each candidate's display name reads the slot's mutable character profile first, which requires
  // an active routing read scope; establish one (or run directly for a non-slot root) so the read is fenced
  // the same way the turn's other slot reads are.
  return await runRoutingReadScopeIfActive({ root }, async () => {
    const candidates = [];
    for (const characterId of guide.candidate_character_ids) {
      const choice = await selectableCharacterChoice({ root, authoringRoot, characterId });
      candidates.push({ character_id: choice.id, display_name: choice.display_name });
    }
    return { candidates };
  });
}

function routingModeRequiredError() {
  const error = new Error('routing finalization drain requires routing mode');
  error.statusCode = 409;
  error.errorCode = 'ROUTING_MODE_REQUIRED';
  return error;
}

function routingActiveRootRequiredError() {
  const error = new Error('routing conversation lifecycle requires a resolved active play slot root');
  error.statusCode = 409;
  error.errorCode = 'ROUTING_ACTIVE_ROOT_REQUIRED';
  return error;
}

// Routing conversation-lifecycle endpoints (opening/turn/edit/finalize-retry/end) all operate on the
// active play slot's runtime_state and pending-finalization queue. The active slot root must be resolved
// (context.activeRoot); routing mode never legitimately targets the parent authoring root. Fail fast
// instead of silently falling back to context.root, which would read the parent baseline runtime_state
// and report a slot-queue endpoint as a false "idle". Loop mode has no slot queue here and keeps the
// parent-root resolution.
export function resolveConversationLifecycleRoot(context, activePlayMode) {
  if (activePlayMode?.mode === 'routing') {
    if (!context.activeRoot) throw routingActiveRootRequiredError();
    return context.activeRoot;
  }
  return context.activeRoot ?? context.root;
}

function conversationEndWrapUpError(message, { statusCode = 400 } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = statusCode === 409 ? 'ROUTING_WRAP_UP_CONFLICT' : 'INVALID_CONVERSATION_WRAP_UP';
  return error;
}

function normalizeConversationEndWrapUp(body) {
  if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'wrap_up')) return null;
  if (body.wrap_up === 'title') return 'title';
  throw conversationEndWrapUpError(`unknown conversation end wrap_up: ${body.wrap_up}`);
}

function resolveExplicitConversationEndWrapUpDispatch({ wrapUp, routingMode, conversation, characterId }) {
  if (!wrapUp) return null;
  if (!routingMode) throw conversationEndWrapUpError('conversation end wrap_up requires routing mode');
  const routingHubContext = normalizeConversationRoutingHubContext(conversation);
  if (!conversation || conversation.character_id !== characterId || routingHubContext === undefined) {
    throw conversationEndWrapUpError('conversation end wrap_up requires a routing hub conversation');
  }
  if (conversation.routing_destination_judgment?.decided === true) {
    throw conversationEndWrapUpError('conversation end wrap_up cannot override a decided routing destination', { statusCode: 409 });
  }
  return resolveRoutingDestinationDispatch(wrapUp);
}

function matchingActiveErrandForConversation({ state, conversationId, characterId }) {
  const activeErrand = readActiveRoutingErrand(state);
  if (!activeErrand) return null;
  if (conversationId !== activeErrand.conversation_id) {
    throw routingErrandContextMismatch('active routing errand conversation mismatch');
  }
  if (characterId !== activeErrand.client_character_id) {
    throw routingErrandContextMismatch('active routing errand actor mismatch');
  }
  return activeErrand;
}

function matchingActiveStudyCircleForConversation({ state, conversationId, characterId }) {
  const activeStudyCircle = readActiveRoutingStudyCircle(state);
  if (!activeStudyCircle) return null;
  if (conversationId !== activeStudyCircle.conversation_id) {
    throw routingStudyCircleContextMismatch('active routing study circle conversation mismatch');
  }
  if (characterId !== activeStudyCircle.host_character_id) {
    throw routingStudyCircleContextMismatch('active routing study circle actor mismatch');
  }
  return activeStudyCircle;
}

// The errand reward is conditional on achievement: the band reward is paid only when the errand was
// achieved (its condition met, auto-ended within a turn). An unachieved manual exit pays exactly 0 —
// the money path is still driven (delta 0) rather than skipped, so the money_update record carries the
// explicit reason (delta 0) instead of silently vanishing.
function errandPaidReward(activeErrand, errandAchieved) {
  return errandAchieved ? activeErrand.reward_money : 0;
}

function providersForRoutingErrandFinalization(providers, activeErrand, job, errandAchieved) {
  if (!activeErrand || job.conversation_id !== activeErrand.conversation_id) return providers;
  const paidReward = errandPaidReward(activeErrand, errandAchieved);
  return {
    ...providers,
    moneyDeltaProvider: async () => String(paidReward)
  };
}

async function routingErrandMoneyUpdateForResponse({ root, readJsonIfExists, drainResult, activeErrand, errandAchieved }) {
  const expectedReward = errandPaidReward(activeErrand, errandAchieved);
  const drainedEntry = (drainResult?.drained ?? [])
    .find((entry) => entry?.job?.conversation_id === activeErrand.conversation_id);
  const moneyUpdate = drainedEntry?.finalization?.money_update
    ?? await readJsonIfExists(root, `game_data/logs/money_updates/${activeErrand.conversation_id}.json`);
  if (!moneyUpdate) throw new Error('routing errand finalization money update is missing');
  if (moneyUpdate.conversation_id !== activeErrand.conversation_id) {
    throw new Error('routing errand finalization money update conversation mismatch');
  }
  if (moneyUpdate.delta !== expectedReward) {
    throw new Error('routing errand finalization money update reward mismatch');
  }
  return moneyUpdate;
}

// 足跡のまとめ（title wrap-up の drain の後に LM 1 本）。まとめの 1 本（LM 呼び出しと出力の gate）だけが
// 落ちたときは、その足跡のまとめを消して wrap-up は成功で返す（札は日時だけになる）。材料組みと LM 設定の
// 失敗は wrap-up ごと throw する。drain そのものの失敗はここへ来る前に throw している。
// provider=mock のときは mock のまとめ（LM も LM 設定も使わない）。
async function applyFootprintSummary({ root, context, requestedProvider, state, hubConversation }) {
  const material = await buildFootprintSummaryMaterial({ root, authoringRoot: context.root, state, hubConversation });
  const config = requestedProvider === 'mock' ? null : await ensureLmStudioConversationConfig(context);
  try {
    const text = requestedProvider === 'mock'
      ? mockFootprintSummary(material)
      : await generateFootprintSummary({ config, material });
    const writtenAt = new Date().toISOString();
    return {
      state: withFootprintSummary(state, { text, writtenAt }),
      footprintSummary: { status: 'written', text, written_at: writtenAt }
    };
  } catch (error) {
    return {
      state: withoutFootprintSummary(state),
      footprintSummary: { status: 'failed', error: error.message }
    };
  }
}

function drainResponsePayload(result, extra = {}) {
  return {
    finalization_status: result.drained.length > 0 ? 'drained' : 'idle',
    drained: result.drained,
    state: result.state,
    ...extra
  };
}

function retryResponsePayload(result, extra = {}) {
  return drainResponsePayload(result, {
    retry_status: result.retried ? 'retried' : 'idle',
    retried: result.retried,
    ...extra
  });
}

async function buildConversationEndPayload({
  root,
  context,
  body,
  resolveRuntimeProviders,
  readJson,
  readJsonIfExists,
  writeJson,
  runConversationFinalization,
  markGraduationEndingComplete,
  isGraduationEndingContext,
  activePlayMode,
  errandAchieved,
  studyCircleAchieved,
  progressReporter = null
}) {
  if (typeof errandAchieved !== 'boolean') throw new Error('buildConversationEndPayload requires a boolean errandAchieved');
  if (typeof studyCircleAchieved !== 'boolean') throw new Error('buildConversationEndPayload requires a boolean studyCircleAchieved');
  const playMode = assertActivePlayMode(activePlayMode);
  const explicitWrapUp = normalizeConversationEndWrapUp(body);
  const routingMode = playMode.mode === 'routing';
  if (explicitWrapUp && !routingMode) throw conversationEndWrapUpError('conversation end wrap_up requires routing mode');
  const providers = routingMode ? null : await resolveRuntimeProviders({ requestedProvider: body.provider, context });
  const state = await readJson(root, 'game_data/runtime_state.json');
  const characterId = body.character_id ?? state.current_interaction_character_id ?? 'lina';
  const conversationId = assertValidConversationIdForApi(body.conversation_id ?? state.last_conversation_id, 'conversation_id');
  const activeErrand = routingMode ? readActiveRoutingErrand(state) : null;
  const activeStudyCircle = routingMode ? readActiveRoutingStudyCircle(state) : null;
  // The atelier conversation (錬成室のうちの子) matched to THIS conversation. Unlike errand/study it never
  // dispatches or progresses the week (the week was progressed at the hub dispatch that landed on the
  // atelier); ending it writes the `conversation_completed` content result, spends the visit's one
  // conversation, and returns to the atelier stay screen. Non-interfering with other conversations.
  const activeAtelierConversation = routingMode
    ? matchingActiveAtelierConversation({ state, conversationId, characterId })
    : null;
  if (activeErrand && activeStudyCircle) {
    throw routingStudyCircleContextMismatch('routing errand and study circle are both active');
  }
  if (activeErrand && !conversationId) {
    throw routingErrandContextMismatch('active routing errand conversation id is missing');
  }
  if (activeStudyCircle && !conversationId) {
    throw routingStudyCircleContextMismatch('active routing study circle conversation id is missing');
  }
  if (activeErrand) {
    matchingActiveErrandForConversation({ state, conversationId, characterId });
  }
  if (activeStudyCircle) {
    matchingActiveStudyCircleForConversation({ state, conversationId, characterId });
  }
  const conversation = conversationId ? await readJsonIfExists(root, `game_data/logs/conversations/${conversationId}.json`) : null;
  const routingWeekProgressionForConversation = routingMode && conversation
    ? findRoutingWeekProgressionByConversation(state, conversation.id)
    : null;
  // Graduation guide active: the ending of a guide (hub) conversation stays in the guide (kept alive below); it is
  // never a destination dispatch nor a title wrap-up (the run cannot leave graduation once the guide begins, and
  // the guide conversation has no decided routing destination). Resolve no dispatch here, and reject an explicit
  // wrap-up so the guide cannot be side-stepped into an exit.
  const activeGuideForEnd = routingMode ? readRoutingGraduationGuide(state) : null;
  if (activeGuideForEnd && explicitWrapUp) {
    throw conversationEndWrapUpError('conversation end wrap_up is not allowed during the graduation guide', { statusCode: 409 });
  }
  const explicitWrapUpDispatch = activeGuideForEnd ? null : resolveExplicitConversationEndWrapUpDispatch({
    wrapUp: explicitWrapUp,
    routingMode,
    conversation,
    characterId
  });
  const routingDispatch = !activeGuideForEnd && routingMode && conversation?.character_id === characterId
    ? explicitWrapUpDispatch ?? resolveRoutingHubDispatch(conversation)
    : null;
  const graduationEnding = routingDispatch ? false : isGraduationEndingContext(state, conversation);
  const fallbackScreen = graduationEnding
    ? 'title'
    : activeAtelierConversation
      ? 'academy-atelier'
      : routingDispatch?.next_screen ?? resolvePostContentScreen({ mode: playMode.mode, loopScreen: 'academy-room' });
  const transition = transitionForScreen(fallbackScreen, { graduationEnding });
  if (activeErrand && !conversation) {
    throw routingErrandContextMismatch('active routing errand conversation file is missing');
  }
  if (activeStudyCircle && !conversation) {
    throw routingStudyCircleContextMismatch('active routing study circle conversation file is missing');
  }
  if (activeErrand && conversation.character_id !== activeErrand.client_character_id) {
    throw routingErrandContextMismatch('active routing errand conversation actor mismatch');
  }
  if (activeStudyCircle && conversation.character_id !== activeStudyCircle.host_character_id) {
    throw routingStudyCircleContextMismatch('active routing study circle conversation actor mismatch');
  }
  if (!conversationId || !conversation || conversation.character_id !== characterId) {
    const nextState = { ...state, current_screen: fallbackScreen, current_interaction_character_id: null, pending_interaction_context: null };
    await writeJson(root, 'game_data/runtime_state.json', nextState);
    return { skipped: true, reason: 'no_active_conversation', character_id: characterId, state: nextState, transition };
  }
  if (conversation.discarded_after_work_record_id && !routingDispatch && !activeErrand && !activeStudyCircle) {
    const appliedRoutingWeekProgression = isRoutingWeekProgressionRecordApplied(routingWeekProgressionForConversation)
      ? routingWeekProgressionForConversation
      : null;
    if (appliedRoutingWeekProgression) {
      return {
        finalization_status: 'drained',
        conversation,
        character_id: characterId,
        state,
        transition: transitionForWeekProgression({ route: appliedRoutingWeekProgression.route, state }),
        week_progression: {
          route: appliedRoutingWeekProgression.route,
          ...appliedRoutingWeekProgression,
          status: 'already_applied'
        }
      };
    }
    const nextState = { ...state, current_screen: fallbackScreen, current_interaction_character_id: null, pending_interaction_context: null };
    await writeJson(root, 'game_data/runtime_state.json', nextState);
    return { skipped: true, reason: 'already_finalized', conversation, state: nextState, transition };
  }
  if (routingMode && !graduationEnding) {
    return await runOutsideRoutingReadScope(async () => {
      // Graduation guide phase active: this exit stays in the guide conversation. A manual end ("今日はここまで")
      // during the guide is neither a title wrap-up nor a destination dispatch — the run cannot leave graduation
      // once week 50 is reached — so it keeps the hub conversation alive and reports the guide phase unchanged.
      // The player leaves the guide only by choosing a partner (judged per-turn), which starts phase 2.
      const activeGuide = readRoutingGraduationGuide(state);
      if (activeGuide) {
        return {
          finalization_status: 'idle',
          conversation,
          character_id: characterId,
          state,
          transition: { next_screen: state.current_screen },
          graduation_guide: { phase: 'guide', candidate_character_ids: activeGuide.candidate_character_ids }
        };
      }
      // A hub exit (wrap-up or send-off) refuses on a failed job before it writes anything — the week commit, this
      // conversation's enqueue, the cleared interaction — so the same exit passes once the retry clears the job.
      if (routingDispatch) assertNoFailedPendingFinalizations(state);
      const nextState = {
        ...state,
        current_screen: fallbackScreen,
        current_interaction_character_id: null,
        pending_interaction_context: null
      };
      const now = new Date().toISOString();
      let queuedState = nextState;
      let pendingFinalization = null;
      let weekResult = null;
      let gathering = null;
      if (routingDispatch && isRoutingTitleDispatch(routingDispatch)) {
        // Wrap-up ('区切りをつける'): a neutral exit to the title screen that does NOT progress the
        // week. Enqueue this hub conversation's finalization (once) and fully drain the whole
        // pending-finalization queue before confirming the title screen — the same full-drain
        // mechanism the graduation dispatch uses, minus the week increment, sanrin redraw, and
        // graduation firing. A finalized hub conversation on a dispatch retry is the idempotency
        // signal: skip the re-enqueue but still drain the (now empty or newly filled) queue.
        if (!conversation.discarded_after_work_record_id) {
          queuedState = enqueuePendingFinalizationInState(nextState, {
            conversation_id: conversationId,
            character_id: characterId,
            enqueued_at: now
          });
        }
        await writeJson(root, 'game_data/runtime_state.json', queuedState);
        pendingFinalization = findPendingFinalization(queuedState, conversationId);
        let finalizationProviders = null;
        const drainResult = await drainAllPendingFinalizations({
          root,
          finalizeJob: async (job) => {
            finalizationProviders ??= await resolveRuntimeProviders({ requestedProvider: body.provider, context });
            return await runConversationFinalization({
              root,
              conversationId: job.conversation_id,
              characterId: job.character_id,
              providers: finalizationProviders,
              progressReporter
            });
          }
        });
        // The footprint summary is written after the drain (it reads the hub conversation's own memory the
        // drain just wrote) and lands in the same final write as the title screen.
        const summarized = await applyFootprintSummary({
          root,
          context,
          requestedProvider: body.provider,
          state: drainResult.state,
          hubConversation: conversation
        });
        // Re-confirm the title screen + interaction cleanup as the authoritative final state after the
        // drain: a drained finalization can rewrite current_screen / interaction context, so the wrap-up
        // owns the last write. A failed/blocked job leaves drainAllPendingFinalizations throwing, so we
        // never reach here half-drained (fail-fast, retryable).
        const titleState = {
          ...summarized.state,
          current_screen: fallbackScreen,
          current_interaction_character_id: null,
          pending_interaction_context: null
        };
        await writeJson(root, 'game_data/runtime_state.json', titleState);
        return {
          finalization_status: 'drained',
          conversation,
          character_id: characterId,
          state: titleState,
          transition,
          routing_dispatch: routingDispatch,
          footprint_summary: summarized.footprintSummary
        };
      }
      if (routingDispatch) {
        const routingWeekProgression = routingWeekProgressionForDispatch({ conversation, routingDispatch });
        const existingWeekProgression = findRoutingWeekProgression(state, routingWeekProgression.idempotency_key);
        const alreadyApplied = isRoutingWeekProgressionRecordApplied(existingWeekProgression);
        if (!alreadyApplied && conversation.discarded_after_work_record_id) {
          throw new Error(`finalized routing dispatch is missing week progression: ${conversation.id}`);
        }
        // Routing never dispatches into graduation: the graduation week runs as the guide (created at hub start),
        // which gates off destination selection, so a decided-destination dispatch only ever advances a normal
        // week. startNextAcademyWeek fail-fasts if a routing progression would reach the graduation week.
        const currentFinalizationJob = {
          conversation_id: conversationId,
          character_id: characterId,
          enqueued_at: now
        };
        if (!alreadyApplied) {
          queuedState = nextState;
        } else {
          queuedState = state;
        }
        pendingFinalization = findPendingFinalization(queuedState, conversationId);
        const prepareRoutingWeekState = !alreadyApplied
          ? async (weekState) => {
              // This hub conversation's finalization is enqueued into the same week-commit write, so the week
              // advance and the queued exit finalization land atomically.
              let preparedState = enqueuePendingFinalizationInState({
                ...weekState,
                current_interaction_character_id: null,
                pending_interaction_context: null
              }, currentFinalizationJob);
              preparedState = (await prepareSanrinCreaturePlacementsForState({ root, state: preparedState, force: true })).state;
              // Academy-map arrival owns the stage-description reroll: on the one dispatch that lands on the
              // academy map, reselect every academy stage's visible situation in this same week-commit write
              // (never a separate write / partial apply) so the map and the conversation context present new
              // descriptions on every arrival. Other destinations do not touch academy_stage_situations.
              if (routingDispatch.next_screen === 'academy-map') {
                const locations = await readJson(root, 'game_data/locations.json');
                preparedState = prepareAcademyStageSituationsForState({ state: preparedState, locations }).state;
              }
              return preparedState;
            }
          : null;
        weekResult = await startNextAcademyWeek({
          root,
          authoringRoot: context.root,
          nextScreen: routingDispatch.next_screen,
          now,
          prepareWeekState: prepareRoutingWeekState,
          routingWeekProgression
        });
        if (!pendingFinalization) {
          pendingFinalization = findPendingFinalization(weekResult.state, conversationId);
        }
        if (weekResult.routing_week_progression?.status === 'applied') {
          gathering = await resetGatheringStocks({ root });
        }
      } else {
        await writeJson(root, 'game_data/runtime_state.json', nextState);
        if (conversation.discarded_after_work_record_id) {
          queuedState = nextState;
        } else {
          queuedState = await enqueuePendingFinalization({
            root,
            job: {
              conversation_id: conversationId,
              character_id: characterId,
              enqueued_at: now
            }
          });
        }
        pendingFinalization = findPendingFinalization(queuedState, conversationId);
      }
      // drain-on-exit: every routing exit fully drains the pending-finalization queue before it
      // transitions — the same full-drain the wrap-up ('title') exit uses. The dispatch branch enqueued this
      // hub conversation's finalization into the week state (persisted by startNextAcademyWeek); the
      // content-return branch enqueued it above. Drain the whole queue now so it is empty at the transition
      // and no post-processing runs after the exit (this removes the need for entry pre-drains and background
      // idle drains). A failed/blocked job leaves drainAllPendingFinalizations throwing (fail-fast,
      // retryable), so a half-drained exit never transitions. Routing never graduates here (the graduation
      // week runs as the guide), so there is no graduation drain to skip.
      let drainProviders = null;
      const drainResult = await drainAllPendingFinalizations({
        root,
        finalizeJob: async (job) => {
          drainProviders ??= await resolveRuntimeProviders({ requestedProvider: body.provider, context });
          const providersForJob = providersForRoutingErrandFinalization(drainProviders, activeErrand, job, errandAchieved);
          return await runConversationFinalization({
            root,
            conversationId: job.conversation_id,
            characterId: job.character_id,
            providers: providersForJob,
            progressReporter
          });
        }
      });
      // Re-assert the exit's screen + interaction cleanup as the authoritative last write after the
      // drain (a drained finalization can rewrite current_screen / interaction context). fallbackScreen
      // is the dispatch destination for a hub dispatch and the resolved hub-return screen otherwise.
      let responseState = {
        ...drainResult.state,
        current_screen: fallbackScreen,
        current_interaction_character_id: null,
        pending_interaction_context: null
      };
      const responseTransition = weekResult ? transitionForWeekProgression(weekResult) : transition;
      let errandResult = null;
      let studyCircleResult = null;
      let atelierConversationResult = null;
      if (activeErrand) {
        const paidReward = errandPaidReward(activeErrand, errandAchieved);
        const money = await routingErrandMoneyUpdateForResponse({
          root,
          readJsonIfExists,
          drainResult,
          activeErrand,
          errandAchieved
        });
        const errandRecord = buildErrandContentResult({
          week: activeErrand.week,
          now,
          errandId: activeErrand.errand_id,
          title: activeErrand.title,
          achieved: errandAchieved,
          rewardMoney: paidReward,
          clientCharacterId: activeErrand.client_character_id,
          clientDisplayName: activeErrand.client_display_name
        });
        responseState = {
          ...responseState,
          [ROUTING_CONTENT_RESULT_STATE_KEY]: errandRecord
        };
        delete responseState[ROUTING_ACTIVE_ERRAND_STATE_KEY];
        errandResult = {
          errand_id: activeErrand.errand_id,
          title: activeErrand.title,
          achieved: errandAchieved,
          reward_money: paidReward,
          client_character_id: activeErrand.client_character_id,
          client_display_name: activeErrand.client_display_name,
          record: errandRecord,
          money
        };
      }
      if (activeStudyCircle) {
        const studyCircleContentResult = await applyStudyCircleCompletion({
          root,
          activeStudyCircle,
          achieved: studyCircleAchieved,
          now
        });
        const studyCircleRecord = buildStudyCircleRoutingContentResult({
          week: activeStudyCircle.week,
          now,
          contentResult: studyCircleContentResult
        });
        responseState = {
          ...responseState,
          [ROUTING_CONTENT_RESULT_STATE_KEY]: studyCircleRecord
        };
        delete responseState[ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY];
        studyCircleResult = {
          theme_id: activeStudyCircle.theme_id,
          theme_name: activeStudyCircle.theme_name,
          host_character_id: activeStudyCircle.host_character_id,
          host_display_name: activeStudyCircle.host_display_name,
          achieved: studyCircleAchieved,
          record: studyCircleRecord,
          content_result: studyCircleContentResult
        };
      }
      if (activeAtelierConversation) {
        // The atelier conversation completed: write the `conversation_completed` content result, spend this
        // visit's one conversation (spent_week = the marker week), and clear the active marker. No reward, no
        // dispatch — the player returns to the atelier stay screen (fallbackScreen).
        const atelierRecord = buildHomunculusContentResult({
          week: activeAtelierConversation.week,
          now,
          action: 'conversation',
          homunculusId: activeAtelierConversation.homunculus_id,
          displayName: activeAtelierConversation.display_name,
          faceId: activeAtelierConversation.face_id
        });
        responseState = {
          ...responseState,
          [ROUTING_CONTENT_RESULT_STATE_KEY]: atelierRecord,
          [ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY]: activeAtelierConversation.week
        };
        delete responseState[ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY];
        atelierConversationResult = {
          homunculus_id: activeAtelierConversation.homunculus_id,
          display_name: activeAtelierConversation.display_name,
          face_id: activeAtelierConversation.face_id,
          record: atelierRecord
        };
      }
      // The re-asserted exit state is always the authoritative last write here: routing never graduates on this
      // path (the graduation week runs as the guide), so there is no graduation write to defer to.
      await writeJson(root, 'game_data/runtime_state.json', responseState);
      return {
        finalization_status: 'drained',
        conversation,
        character_id: characterId,
        state: responseState,
        transition: responseTransition,
        ...(activeErrand ? { post_content_screen: fallbackScreen, errand_result: errandResult } : {}),
        ...(activeStudyCircle ? { post_content_screen: fallbackScreen, study_circle_result: studyCircleResult } : {}),
        ...(activeAtelierConversation ? { post_content_screen: fallbackScreen, homunculus_conversation_result: atelierConversationResult } : {}),
        ...(routingDispatch ? { routing_dispatch: routingDispatch } : {}),
        ...(weekResult ? {
          week_progression: {
            route: weekResult.route,
            ...weekResult.routing_week_progression
          }
        } : {}),
        ...(gathering ? { gathering } : {})
      };
    });
  }
  const nextState = {
    ...state,
    current_screen: fallbackScreen,
    current_interaction_character_id: null,
    pending_interaction_context: null
  };
  if (graduationEnding) {
    // The graduation conversation is never finalized: its end calls no LM and makes no record (memory, skill,
    // work record, flags, affinity). The graduation is complete the moment the conversation ends.
    const graduatedState = markGraduationEndingComplete(nextState);
    await writeJson(root, 'game_data/runtime_state.json', graduatedState);
    return {
      finalization_status: 'skipped',
      conversation,
      character_id: characterId,
      state: graduatedState,
      transition
    };
  }
  await writeJson(root, 'game_data/runtime_state.json', nextState);
  const finalizationProviders = providers ?? await resolveRuntimeProviders({ requestedProvider: body.provider, context });
  const finalization = await runConversationFinalization({ root, conversationId, characterId, providers: finalizationProviders });
  const finalizationState = finalization.state ?? nextState;
  return {
    finalization_status: 'completed',
    finalization,
    conversation: finalization.conversation ?? conversation,
    character_id: characterId,
    state: finalizationState,
    transition
  };
}

export async function attachRoutingTurnDispatch({
  root,
  context,
  body,
  turnResult,
  resolveRuntimeProviders,
  readJson,
  readJsonIfExists,
  writeJson,
  runConversationFinalization,
  markGraduationEndingComplete,
  isGraduationEndingContext,
  activePlayMode,
  progressReporter = null
}) {
  if (!turnResult?.routing_destination) return turnResult;
  const dispatchPayload = await buildConversationEndPayload({
    root,
    context,
    body: {
      ...body,
      character_id: turnResult.conversation.character_id,
      conversation_id: turnResult.conversation.id
    },
    resolveRuntimeProviders,
    readJson,
    readJsonIfExists,
    writeJson,
    runConversationFinalization,
    markGraduationEndingComplete,
    isGraduationEndingContext,
    activePlayMode,
    errandAchieved: false,
    studyCircleAchieved: false,
    progressReporter
  });
  return {
    ...turnResult,
    ...dispatchPayload,
    routing_destination: turnResult.routing_destination
  };
}

// The guide (hub) conversation record carried on as the 案内人's graduation conversation: the hub snapshot drops (no hub
// turn follows it), the record takes the terrace 舞台 and the graduation event identity from the started interaction,
// and its id, messages, actor context, and judgments stay as they are.
function guideGraduationConversationRecord(conversation, pendingContext) {
  const { routing_hub: _routingHub, ...record } = conversation;
  const scene = guideGraduationSceneContext();
  return {
    ...record,
    source_type: scene.source_type,
    location_name: scene.location_name,
    visible_situation: scene.visible_situation,
    event_flag_id: pendingContext.event_flag_id,
    event_label: pendingContext.event_label,
    source_conversation_id: pendingContext.source_conversation_id
  };
}

// The in-turn graduation guide selection (routing phase 2): a guide turn whose partner-selection judgment picked a
// partner carries routing_graduation_guide_selection. An academy person: finalize the hub (guide) conversation via the
// same drain discipline every routing exit uses, then start that person's graduation event on the daytime conversation
// screen. The 案内人 herself: nothing is finalized and no conversation is opened — the guide conversation goes on as the
// graduation conversation on the terrace (same id, one history), and it is finalized as the graduation when it ends. A
// turn without a selection is returned untouched, so the guide conversation simply continues.
export async function attachRoutingGraduationGuideSelection({
  root,
  context,
  body,
  turnResult,
  resolveRuntimeProviders,
  readJson,
  writeJson,
  runConversationFinalization,
  activePlayMode,
  progressReporter = null
}) {
  if (!turnResult?.routing_graduation_guide_selection) return turnResult;
  const playMode = assertActivePlayMode(activePlayMode);
  if (playMode.mode !== 'routing') throw new Error('graduation guide selection requires routing mode');
  const characterId = turnResult.routing_graduation_guide_selection.character_id;
  // Read the post-turn state in the ambient routing read scope (the same place buildConversationEndPayload
  // reads it); the enqueue/drain/character-event work then runs outside the scope like every other routing exit.
  const state = await readJson(root, 'game_data/runtime_state.json');
  // Refuse on a failed job before this turn writes its waiting state, so the guide goes on untouched and the
  // player can name the partner again once the retry clears the job.
  assertNoFailedPendingFinalizations(state);
  if (characterId === ROUTING_PERSONA_CHARACTER_ID) {
    return await runOutsideRoutingReadScope(async () => {
      const started = await startGuideGraduationConversation({ root, now: new Date().toISOString() });
      if (started.conversation_id !== turnResult.conversation.id) {
        throw new Error(`guide graduation started on ${started.conversation_id}, not the selecting guide conversation ${turnResult.conversation.id}`);
      }
      const conversation = guideGraduationConversationRecord(turnResult.conversation, started.state.pending_interaction_context);
      await writeJson(root, `game_data/logs/conversations/${conversation.id}.json`, conversation);
      return {
        ...turnResult,
        conversation,
        state: started.state,
        graduation_ending: { character_id: characterId },
        routing_graduation_guide_selection: turnResult.routing_graduation_guide_selection
      };
    });
  }
  return await runOutsideRoutingReadScope(async () => {
    const now = new Date().toISOString();
    const hubConversationId = turnResult.conversation.id;
    const hubCharacterId = turnResult.conversation.character_id;
    // Finalize the guide (hub) conversation: enqueue it (unless it was already discarded/finalized) and drain
    // the whole pending queue, the same full-drain the destination dispatch and title wrap-up use. A
    // failed/blocked job leaves drainAllPendingFinalizations throwing (fail-fast, retryable).
    let queuedState = { ...state, current_interaction_character_id: null, pending_interaction_context: null };
    let enqueuedHubJob = false;
    if (!turnResult.conversation.discarded_after_work_record_id) {
      const enqueuedState = enqueuePendingFinalizationInState(queuedState, {
        conversation_id: hubConversationId,
        character_id: hubCharacterId,
        enqueued_at: now
      });
      enqueuedHubJob = enqueuedState !== queuedState;
      queuedState = enqueuedState;
    }
    await writeJson(root, 'game_data/runtime_state.json', queuedState);
    let finalizationProviders = null;
    try {
      await drainAllPendingFinalizations({
        root,
        finalizeJob: async (job) => {
          finalizationProviders ??= await resolveRuntimeProviders({ requestedProvider: body.provider, context });
          return await runConversationFinalization({
            root,
            conversationId: job.conversation_id,
            characterId: job.character_id,
            providers: finalizationProviders,
            progressReporter
          });
        }
      });
    } catch (error) {
      // When the failed drain did not finalize the guide conversation, the guide goes on: take back what this
      // turn wrote before the drain (this turn's enqueue of the guide conversation, whether it failed or still
      // waits behind a failed job, and the cleared interaction) so the next turn of the same guide conversation
      // passes and the player can name the partner again. The other jobs keep whatever the drain did to them.
      const failedState = await runRoutingReadScopeIfActive({ root }, () => readJson(root, 'game_data/runtime_state.json'));
      const guideJobFinalized = enqueuedHubJob && !findPendingFinalization(failedState, hubConversationId);
      if (!guideJobFinalized) {
        const restoredState = enqueuedHubJob ? removePendingFinalizationInState(failedState, hubConversationId) : failedState;
        await writeJson(root, 'game_data/runtime_state.json', {
          ...restoredState,
          current_interaction_character_id: state.current_interaction_character_id,
          pending_interaction_context: state.pending_interaction_context
        });
      }
      throw error;
    }
    // The selected character's graduation event lands on the fixed daytime conversation screen — the same
    // landing every event conversation follows — so both the interaction's persisted current_screen (via the
    // startEventFlagInteraction screen arg) and this response's transition next_screen stay truthful to where the
    // frontend actually lands. It opens like any event conversation (the conversation passage).
    const landingScreen = resolveAcademyConversationLandingScreen();
    const started = await startGraduationEndingConversationForCharacter({
      root,
      authoringRoot: context.root,
      characterId,
      screen: landingScreen,
      now
    });
    return {
      ...turnResult,
      finalization_status: 'drained',
      state: started.state,
      transition: { next_screen: landingScreen },
      graduation_ending: { character_id: characterId },
      routing_graduation_guide_selection: turnResult.routing_graduation_guide_selection
    };
  });
}

// The in-turn errand auto-end: when a turn's per-turn achievement judgment fired (turnResult carries
// errand_achievement, the client-side wrap-up 発話 is already on the turn), reuse the exact end path the
// manual exit takes — finalize the errand conversation, pay the reward (errandAchieved: true), write the
// achieved content result, clear the active errand, and return the post_content_screen — all inside the
// turn response so a non-streaming and a streaming errand turn return the same completion contract. The
// mirror of attachRoutingTurnDispatch for routing hub sendoffs. A turn with no achievement is returned
// untouched (no completion), so the completion result and the wrap-up 発話 are never half-signalled.
export async function attachRoutingErrandCompletion({
  root,
  context,
  body,
  turnResult,
  resolveRuntimeProviders,
  readJson,
  readJsonIfExists,
  writeJson,
  runConversationFinalization,
  markGraduationEndingComplete,
  isGraduationEndingContext,
  activePlayMode,
  progressReporter = null
}) {
  if (!turnResult?.errand_achievement) return turnResult;
  const completionPayload = await buildConversationEndPayload({
    root,
    context,
    body: {
      ...body,
      character_id: turnResult.conversation.character_id,
      conversation_id: turnResult.conversation.id
    },
    resolveRuntimeProviders,
    readJson,
    readJsonIfExists,
    writeJson,
    runConversationFinalization,
    markGraduationEndingComplete,
    isGraduationEndingContext,
    activePlayMode,
    errandAchieved: true,
    studyCircleAchieved: false,
    progressReporter
  });
  // An achieved turn MUST finalize into an errand completion. A payload without errand_result means the
  // wrap-up 発話 was signalled but the reward/record/active-errand clear did not run — a half-signalled
  // response. Fail fast rather than returning a turn that claims achievement without completing it.
  if (!completionPayload?.errand_result) {
    throw new Error('errand achievement did not produce an errand completion result');
  }
  return {
    ...turnResult,
    ...completionPayload,
    errand_achievement: turnResult.errand_achievement
  };
}

// The in-turn study circle auto-end: the exact mirror of attachRoutingErrandCompletion. When a turn's
// per-turn achievement judgment fired (turnResult carries study_circle_achievement, the host's wrap-up 発話
// is already on the turn), reuse the exact end path the manual exit takes — finalize the study circle
// conversation, apply the reward (studyCircleAchieved: true), write the achieved content result, clear the
// active study circle, and return the post_content_screen — all inside the turn response so a non-streaming
// and a streaming study circle turn return the same completion contract. A turn with no achievement is
// returned untouched, so the completion result and the wrap-up 発話 are never half-signalled.
export async function attachRoutingStudyCircleCompletion({
  root,
  context,
  body,
  turnResult,
  resolveRuntimeProviders,
  readJson,
  readJsonIfExists,
  writeJson,
  runConversationFinalization,
  markGraduationEndingComplete,
  isGraduationEndingContext,
  activePlayMode,
  progressReporter = null
}) {
  if (!turnResult?.study_circle_achievement) return turnResult;
  const completionPayload = await buildConversationEndPayload({
    root,
    context,
    body: {
      ...body,
      character_id: turnResult.conversation.character_id,
      conversation_id: turnResult.conversation.id
    },
    resolveRuntimeProviders,
    readJson,
    readJsonIfExists,
    writeJson,
    runConversationFinalization,
    markGraduationEndingComplete,
    isGraduationEndingContext,
    activePlayMode,
    errandAchieved: false,
    studyCircleAchieved: true,
    progressReporter
  });
  // An achieved turn MUST finalize into a study circle completion. A payload without study_circle_result
  // means the wrap-up 発話 was signalled but the reward/record/active-study-circle clear did not run — a
  // half-signalled response. Fail fast rather than returning a turn that claims achievement without completing it.
  if (!completionPayload?.study_circle_result) {
    throw new Error('study circle achievement did not produce a study circle completion result');
  }
  return {
    ...turnResult,
    ...completionPayload,
    study_circle_achievement: turnResult.study_circle_achievement
  };
}

export async function handleConversationLifecycleApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  resolveRuntimeProviders,
  readJson,
  readJsonIfExists,
  writeJson,
  runConversationOpening,
  runConversationTurn,
  runConversationFinalization,
  markGraduationEndingComplete,
  isGraduationEndingContext,
  activePlayMode
}) {
  const root = resolveConversationLifecycleRoot(context, activePlayMode);

  if (req.method === 'POST' && url.pathname === '/api/conversation/opening') {
    const body = await readBody(req);
    const conversationId = assertValidConversationIdForApi(body.id, 'id');
    const characterId = body.character_id ?? 'lina';
    const providers = await resolveRuntimeProviders({ requestedProvider: body.provider, context });
    const result = await runConversationOpening({
      root,
      id: conversationId,
      characterId,
      now: new Date().toISOString(),
      graduationPersonaVariant: graduationPersonaVariantForActivePlayMode(activePlayMode),
      ...providers
    });
    return sendJson(res, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/conversation') {
    const body = await readBody(req);
    // A turn holds the conversation it continues: the explicit id, else the active conversation the turn resolves to.
    const { last_conversation_id: activeConversationId } = await readJson(root, 'game_data/runtime_state.json');
    const heldConversationId = assertValidConversationIdForApi(body.id, 'id')
      ?? assertValidConversationIdForApi(activeConversationId, 'last_conversation_id');
    return await runExclusiveConversationWork({ root, conversationId: heldConversationId }, async () => {
      const turnRequest = await resolveConversationTurnRequest({
        root,
        body,
        activePlayMode,
        readJson,
        readJsonIfExists
      });
      const turnState = await readJson(root, 'game_data/runtime_state.json');
      const activeErrand = activePlayMode?.mode === 'routing'
        ? matchingActiveErrandForConversation({
            state: turnState,
            conversationId: turnRequest.conversationId,
            characterId: turnRequest.characterId
          })
        : null;
      const activeStudyCircle = activePlayMode?.mode === 'routing'
        ? matchingActiveStudyCircleForConversation({
            state: turnState,
            conversationId: turnRequest.conversationId,
            characterId: turnRequest.characterId
          })
        : null;
      // The atelier conversation (錬成室のうちの子) is a non-field companion conversation: its 舞台 (the atelier
      // injected scene) must be re-supplied each turn like errand/study, and it takes the companion post-turn
      // policy (no academy-field side effects). It carries no achievement judgment.
      const activeAtelierConversation = activePlayMode?.mode === 'routing'
        ? matchingActiveAtelierConversation({
            state: turnState,
            conversationId: turnRequest.conversationId,
            characterId: turnRequest.characterId
          })
        : null;
      if (activeErrand && activeStudyCircle) {
        throw routingStudyCircleContextMismatch('routing errand and study circle are both active');
      }
      const guideGraduationScene = guideGraduationSceneContextForTurn({
        activePlayMode,
        state: turnState,
        conversationId: turnRequest.conversationId,
        characterId: turnRequest.characterId
      });
      // Graduation guide (routing week 50): a hub turn while the guide phase is active presents the top-N
      // characters and judges the player's chosen graduation partner instead of a routing destination. Only a
      // routing hub turn resolves it; every other turn leaves it undefined and stays byte-equivalent.
      const routingGraduationGuideContext = activePlayMode?.mode === 'routing' && turnRequest.routingHubContext !== undefined
        ? await resolveRoutingGraduationGuideContext({ root, authoringRoot: context.root, state: turnState })
        : undefined;
      const providers = await resolveRuntimeProviders({ requestedProvider: body.provider, context });
      const now = new Date().toISOString();
      const result = await runConversationTurn({
        root,
        id: turnRequest.conversationId,
        characterId: turnRequest.characterId,
        playerInput: body.player_input,
        now,
        ...providers,
        dungeonSceneContext: activeErrand
          ? buildRoutingErrandSceneContext(activeErrand)
          : activeStudyCircle
            ? buildRoutingStudyCircleSceneContext(activeStudyCircle)
            : activeAtelierConversation
              ? atelierInjectedSceneContext()
              : guideGraduationScene ?? undefined,
        errandJudgmentContext: activeErrand ? { condition_text: activeErrand.condition_text } : undefined,
        studyCircleJudgmentContext: activeStudyCircle ? { condition_text: activeStudyCircle.condition_text } : undefined,
        routingHubContext: turnRequest.routingHubContext,
        routingGraduationGuideContext,
        graduationPersonaVariant: graduationPersonaVariantForActivePlayMode(activePlayMode),
        postTurnStatePolicy: activeErrand || activeStudyCircle || activeAtelierConversation || guideGraduationScene ? companionPostTurnStatePolicy : academyPostTurnStatePolicy
      });
      const dispatched = await attachRoutingTurnDispatch({
        root,
        context,
        body,
        turnResult: result,
        resolveRuntimeProviders,
        readJson,
        readJsonIfExists,
        writeJson,
        runConversationFinalization,
        markGraduationEndingComplete,
        isGraduationEndingContext,
        activePlayMode
      });
      const completedErrand = await attachRoutingErrandCompletion({
        root,
        context,
        body,
        turnResult: dispatched,
        resolveRuntimeProviders,
        readJson,
        readJsonIfExists,
        writeJson,
        runConversationFinalization,
        markGraduationEndingComplete,
        isGraduationEndingContext,
        activePlayMode
      });
      const response = await attachRoutingStudyCircleCompletion({
        root,
        context,
        body,
        turnResult: completedErrand,
        resolveRuntimeProviders,
        readJson,
        readJsonIfExists,
        writeJson,
        runConversationFinalization,
        markGraduationEndingComplete,
        isGraduationEndingContext,
        activePlayMode
      });
      const finalResponse = await attachRoutingGraduationGuideSelection({
        root,
        context,
        body,
        turnResult: response,
        resolveRuntimeProviders,
        readJson,
        writeJson,
        runConversationFinalization,
        activePlayMode
      });
      return sendJson(res, finalResponse);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/conversation/finalize/retry') {
    const playMode = assertActivePlayMode(activePlayMode);
    if (playMode.mode !== 'routing') throw routingModeRequiredError();
    const body = await readBody(req);
    // Retrying an older conversation's finalization leaves last_conversation_id on the conversation the player is
    // in now (the hub), so every route that defaults to it keeps naming the current conversation.
    const { last_conversation_id: currentConversationId } = await readJson(root, 'game_data/runtime_state.json');
    let finalizationProviders = null;
    const finalizeJob = async (job) => {
      finalizationProviders ??= await resolveRuntimeProviders({ requestedProvider: body.provider, context });
      return await runConversationFinalization({
        root,
        conversationId: job.conversation_id,
        characterId: job.character_id,
        providers: finalizationProviders,
        finalStateTransform: (state) => ({ ...state, last_conversation_id: currentConversationId })
      });
    };
    const characterId = String(body.character_id ?? '').trim();
    const result = await retryPendingFinalizationForCharacter({ root, characterId, finalizeJob });
    return sendJson(res, retryResponsePayload(result, { character_id: characterId }));
  }

  // 卒業の星の道の材料（一年の人と相手の最後の一言）。卒業の会話を締める前に frontend が読む（締めると本文が消える）。LM は呼ばない。
  if (req.method === 'GET' && url.pathname === '/api/graduation/road') {
    if (activePlayMode.mode !== 'routing') {
      const error = new Error('graduation road requires routing mode');
      error.statusCode = 409;
      error.errorCode = 'GRADUATION_ROAD_UNAVAILABLE';
      throw error;
    }
    return sendJson(res, await readGraduationRoad({
      root,
      authoringRoot: context.root,
      readJson,
      readJsonIfExists,
      personaVariant: activePlayMode.routing_persona_variant
    }));
  }

  if (req.method === 'POST' && url.pathname === '/api/conversation/end') {
    const body = await readBody(req);
    // The end holds the conversation it ends (the same resolution buildConversationEndPayload makes), so it is
    // refused while a turn of that conversation is still post-processing.
    const { last_conversation_id: activeConversationId } = await readJson(root, 'game_data/runtime_state.json');
    const endedConversationId = assertValidConversationIdForApi(body.conversation_id ?? activeConversationId, 'conversation_id');
    return await runExclusiveConversationWork({ root, conversationId: endedConversationId }, async () => {
      // A manual /api/conversation/end is always an unachieved exit: an achieved errand / study circle auto-ends
      // inside its own turn (attachRoutingErrandCompletion / attachRoutingStudyCircleCompletion) and never reaches
      // the end button, so a manual end applies no reward (errandAchieved / studyCircleAchieved: false → errand
      // delta 0 & record achieved:false; study circle no parameter grant & record achieved:false). The week is
      // consumed regardless.
      const payload = await buildConversationEndPayload({
        root,
        context,
        body,
        resolveRuntimeProviders,
        readJson,
        readJsonIfExists,
        writeJson,
        runConversationFinalization,
        markGraduationEndingComplete,
        isGraduationEndingContext,
        activePlayMode,
        errandAchieved: false,
        studyCircleAchieved: false
      });
      return sendJson(res, payload);
    });
  }

  return false;
}
