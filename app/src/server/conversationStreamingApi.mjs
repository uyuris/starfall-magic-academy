import { academyPostTurnStatePolicy, companionPostTurnStatePolicy } from '../llm/conversationPipeline.mjs';
import { buildRoutingErrandSceneContext, readActiveRoutingErrand } from '../routingErrands.mjs';
import { buildRoutingStudyCircleSceneContext, readActiveRoutingStudyCircle } from '../routingStudyCircle.mjs';
import { matchingActiveAtelierConversation } from '../homunculusAtelierVisit.mjs';
import { atelierInjectedSceneContext } from '../homunculusScene.mjs';
import { attachRoutingErrandCompletion, attachRoutingGraduationGuideSelection, attachRoutingStudyCircleCompletion, attachRoutingTurnDispatch, graduationPersonaVariantForActivePlayMode, resolveConversationTurnRequest, resolveRoutingGraduationGuideContext, routingPersonaVisualForGraduationPhase2 } from './conversationLifecycleApi.mjs';

const CONVERSATION_STREAMING_ROUTES = new Set([
  'POST /api/conversation/opening/stream',
  'POST /api/conversation/stream'
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

export function canHandleConversationStreamingApiRoute(method, pathname) {
  return CONVERSATION_STREAMING_ROUTES.has(`${method} ${pathname}`);
}

export function isConversationOpeningStreamRoute(method, pathname) {
  return method === 'POST' && pathname === '/api/conversation/opening/stream';
}

export function serializeStreamError(error) {
  const payload = { error: error.message };
  if (error?.errorCode) payload.error_code = error.errorCode;
  return payload;
}

export async function streamConversationTurnSse({
  res,
  root,
  context,
  body,
  resolveConversationId,
  resolveCharacterId,
  resolveDungeonSceneContext = null,
  resolveRoutingHubContext = null,
  resolveRoutingGraduationGuideContext = null,
  resolveErrandJudgmentContext = null,
  resolveStudyCircleJudgmentContext = null,
  finalizeTurnResult = null,
  postTurnStatePolicy,
  graduationPersonaVariant,
  resolveRuntimeProviders,
  runConversationTurn,
  sendSseEvent
}) {
  if (typeof resolveConversationId !== 'function') throw new Error('resolveConversationId is required');
  if (typeof resolveCharacterId !== 'function') throw new Error('resolveCharacterId is required');
  if (resolveDungeonSceneContext !== null && typeof resolveDungeonSceneContext !== 'function') {
    throw new Error('resolveDungeonSceneContext must be a function when provided');
  }
  if (resolveRoutingHubContext !== null && typeof resolveRoutingHubContext !== 'function') {
    throw new Error('resolveRoutingHubContext must be a function when provided');
  }
  if (resolveRoutingGraduationGuideContext !== null && typeof resolveRoutingGraduationGuideContext !== 'function') {
    throw new Error('resolveRoutingGraduationGuideContext must be a function when provided');
  }
  if (resolveErrandJudgmentContext !== null && typeof resolveErrandJudgmentContext !== 'function') {
    throw new Error('resolveErrandJudgmentContext must be a function when provided');
  }
  if (resolveStudyCircleJudgmentContext !== null && typeof resolveStudyCircleJudgmentContext !== 'function') {
    throw new Error('resolveStudyCircleJudgmentContext must be a function when provided');
  }
  if (finalizeTurnResult !== null && typeof finalizeTurnResult !== 'function') {
    throw new Error('finalizeTurnResult must be a function when provided');
  }
  if (typeof postTurnStatePolicy !== 'function') throw new Error('postTurnStatePolicy is required');
  sendSseEvent(res, 'status', { phase: 'chat_started' });
  try {
    const conversationId = await resolveConversationId(body);
    const characterId = await resolveCharacterId(body);
    const routingHubContext = resolveRoutingHubContext ? await resolveRoutingHubContext(body) : undefined;
    // Graduation guide (routing week 50): only a routing hub turn resolves it, and only while the guide phase
    // is active (the resolver returns undefined otherwise). When present, the turn judges the player's chosen
    // graduation partner instead of a routing destination.
    const routingGraduationGuideContext = resolveRoutingGraduationGuideContext
      ? await resolveRoutingGraduationGuideContext(body)
      : undefined;
    // Academy turns pass no resolver and keep their field-location scene (scene
    // stays undefined). An injected-scene turn (dungeon companion / errand / study
    // circle) injects a resolver that MUST yield its scene: a resolver resolving to
    // undefined is a bug, not an opt-out, so fail fast instead of silently degrading
    // to the academy field scene. Any other value (incl. null/malformed) flows to
    // runConversationTurn, whose scene builder validates it and throws on a bad shape.
    let dungeonSceneContext;
    if (resolveDungeonSceneContext) {
      dungeonSceneContext = await resolveDungeonSceneContext(body);
      if (dungeonSceneContext === undefined) {
        throw new Error('resolveDungeonSceneContext must resolve to a dungeon scene, not undefined');
      }
    }
    // Errand turns inject the per-turn achievement judgment context (the authored condition_text). Only an
    // errand turn passes a resolver; every other turn keeps errandJudgmentContext undefined, so the
    // achievement judgment never runs and the turn stays byte-equivalent.
    const errandJudgmentContext = resolveErrandJudgmentContext ? await resolveErrandJudgmentContext(body) : undefined;
    // A study circle turn injects the same per-turn achievement judgment context as errand (the authored
    // condition_text). Only a study circle turn passes a resolver; every other turn keeps
    // studyCircleJudgmentContext undefined, so the achievement judgment never runs and the turn stays
    // byte-equivalent.
    const studyCircleJudgmentContext = resolveStudyCircleJudgmentContext ? await resolveStudyCircleJudgmentContext(body) : undefined;
    const providers = await resolveRuntimeProviders({
      requestedProvider: body.provider,
      context,
      onChatDelta: (delta) => sendSseEvent(res, 'assistant_delta', { delta })
    });
    const result = await runConversationTurn({
      root,
      id: conversationId,
      characterId,
      playerInput: body.player_input,
      now: new Date().toISOString(),
      ...providers,
      dungeonSceneContext,
      errandJudgmentContext,
      studyCircleJudgmentContext,
      routingHubContext,
      routingGraduationGuideContext,
      graduationPersonaVariant,
      onEmotion: (emotion) => sendSseEvent(res, 'assistant_emotion', emotion),
      onAssistantComplete: ({ content, emotion }) => sendSseEvent(res, 'assistant_complete', { content, ...emotion }),
      postTurnStatePolicy
    });
    // Drain-on-exit: a decided routing turn runs its full pending-finalization drain in
    // finalizeTurnResult (attachRoutingTurnDispatch) after the send-off has already streamed. Emit a
    // routing_draining signal here — after the send-off (assistant_complete), before the drain — so the
    // client shows the loading screen WHILE the drain runs (the send-off is shown first, not hidden),
    // matching the loading-during-drain of the conversation-end path.
    if (result?.routing_destination) {
      sendSseEvent(res, 'routing_draining', { destination_id: result.routing_destination.destination_id ?? null });
    }
    // Drain-on-exit for an achievement auto-end: an achieved errand / study circle turn runs its completion
    // drain in finalizeTurnResult (attachRoutingErrandCompletion / attachRoutingStudyCircleCompletion) after
    // the wrap-up assistant_complete has already streamed. Emit an achievement_draining signal here — after
    // the wrap-up, before the drain — so the client covers the drain with the loading screen (the wrap-up is
    // shown first, not hidden), the same layer and流儀 as routing_draining. The emit predicate is the exact
    // pair-key the completion attach uses (errand_achievement / study_circle_achievement), so the signal
    // cannot be emitted on a stream whose finalization does not attach the matching completion result, and
    // the matching completion result cannot be attached without this signal: no half-signal in either
    // direction. errand and study circle are mutually exclusive on a single turn (the stream setup throws if
    // both are active), so at most one kind is present.
    if (result?.errand_achievement || result?.study_circle_achievement) {
      sendSseEvent(res, 'achievement_draining', { kind: result.errand_achievement ? 'errand' : 'study_circle' });
    }
    // Drain-on-exit for the graduation guide selection (routing phase 2): when the guide turn picked a partner,
    // finalizeTurnResult (attachRoutingGraduationGuideSelection) drains the hub conversation and starts the
    // character event after the reply has streamed. Emit a graduation_guide_draining signal here — after the
    // reply, before the drain — so the client covers the drain with the loading screen, the same流儀 as
    // routing_draining.
    if (result?.routing_graduation_guide_selection) {
      sendSseEvent(res, 'graduation_guide_draining', { character_id: result.routing_graduation_guide_selection.character_id ?? null });
    }
    // In-turn finalization progress: the drain that finalizeTurnResult runs (routing dispatch / achievement
    // auto-end / graduation guide) emits its block boundaries on this already-open SSE as finalization_progress
    // events. They sit AFTER the *_draining signal above and BEFORE the result below, so the loading screen the
    // client raises during the drain advances the constellation per block. When no finalizeTurnResult is wired
    // (no drain), the reporter is never called and no such event is sent.
    const finalizationProgressReporter = ({ phase, character_id }) => {
      sendSseEvent(res, 'finalization_progress', { phase, character_id });
    };
    const responseResult = finalizeTurnResult ? await finalizeTurnResult(result, finalizationProgressReporter) : result;
    sendSseEvent(res, 'result', responseResult);
  } catch (error) {
    sendSseEvent(res, 'error', serializeStreamError(error));
  } finally {
    res.end();
  }
}

export async function handleConversationStreamingApi({
  req,
  res,
  url,
  context,
  readBody,
  readJson,
  readJsonIfExists,
  writeJson,
  resolveRuntimeProviders,
  runConversationOpening,
  runConversationTurn,
  runConversationFinalization,
  markGraduationEndingComplete,
  isGraduationEndingContext,
  openSse,
  sendSseEvent,
  activePlayMode
}) {
  const root = context.activeRoot ?? context.root;

  if (req.method === 'POST' && url.pathname === '/api/conversation/opening/stream') {
    const body = await readBody(req);
    const conversationId = assertValidConversationIdForApi(body.id, 'id');
    openSse(res);
    try {
      sendSseEvent(res, 'status', { phase: 'opening_started' });
      const providers = await resolveRuntimeProviders({
        requestedProvider: body.provider,
        context,
        onChatDelta: (delta) => sendSseEvent(res, 'assistant_delta', { delta })
      });
      const characterId = body.character_id ?? 'lina';
      const result = await runConversationOpening({
        root,
        id: conversationId,
        characterId,
        now: new Date().toISOString(),
        graduationPersonaVariant: graduationPersonaVariantForActivePlayMode(activePlayMode),
        onAssistantComplete: ({ content }) => sendSseEvent(res, 'assistant_complete', { content }),
        ...providers
      });
      // A guide-persona graduation phase 2 opening (immediate hand-off after selection, or a restore re-open
      // of an in-progress phase 2) carries the routing persona visual so the frontend renders the persona's
      // own art hub-outside; every other opening attaches nothing.
      const openingState = await readJson(root, 'game_data/runtime_state.json');
      const routingPersonaVisual = await routingPersonaVisualForGraduationPhase2({
        root,
        characterId,
        state: openingState,
        activePlayMode
      });
      sendSseEvent(res, 'result', routingPersonaVisual ? { ...result, routing_persona_visual: routingPersonaVisual } : result);
    } catch (error) {
      sendSseEvent(res, 'error', serializeStreamError(error));
    } finally {
      res.end();
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/conversation/stream') {
    const body = await readBody(req);
    const conversationId = assertValidConversationIdForApi(body.id, 'id');
    let turnRequest = null;
    let activeErrand = undefined;
    let activeStudyCircle = undefined;
    let activeAtelier = undefined;
    const getTurnRequest = async () => {
      turnRequest ??= await resolveConversationTurnRequest({
        root,
        body,
        activePlayMode,
        readJson,
        readJsonIfExists
      });
      return turnRequest;
    };
    const getActiveErrand = async () => {
      if (activeErrand !== undefined) return activeErrand;
      const request = await getTurnRequest();
      const state = await readJson(root, 'game_data/runtime_state.json');
      activeErrand = activePlayMode?.mode === 'routing'
        ? matchingActiveErrandForConversation({
            state,
            conversationId: request.conversationId,
            characterId: request.characterId
          })
        : null;
      return activeErrand;
    };
    const getActiveStudyCircle = async () => {
      if (activeStudyCircle !== undefined) return activeStudyCircle;
      const request = await getTurnRequest();
      const state = await readJson(root, 'game_data/runtime_state.json');
      activeStudyCircle = activePlayMode?.mode === 'routing'
        ? matchingActiveStudyCircleForConversation({
            state,
            conversationId: request.conversationId,
            characterId: request.characterId
          })
        : null;
      return activeStudyCircle;
    };
    // The atelier conversation (錬成室のうちの子) is the third injected-scene companion conversation: its 舞台 (the
    // authored atelier scene) must be re-supplied each streamed turn like errand/study, or the streamed record
    // inherits source_type 'homunculus' while dropping location_name/visible_situation and finalization
    // fail-fasts. It carries no achievement judgment and takes the companion post-turn policy.
    const getActiveAtelier = async () => {
      if (activeAtelier !== undefined) return activeAtelier;
      const request = await getTurnRequest();
      const state = await readJson(root, 'game_data/runtime_state.json');
      activeAtelier = activePlayMode?.mode === 'routing'
        ? matchingActiveAtelierConversation({
            state,
            conversationId: request.conversationId,
            characterId: request.characterId
          })
        : null;
      return activeAtelier;
    };
    openSse(res);
    try {
      const errandForStream = await getActiveErrand();
      const studyCircleForStream = await getActiveStudyCircle();
      const atelierForStream = await getActiveAtelier();
      // Mirrors the non-stream /api/conversation guard: errand and study circle cannot both be active. The
      // atelier matcher keys on the same conversation id + actor as errand/study, so it cannot co-match with
      // either for one conversation; scene selection below prefers errand > study > atelier, matching the
      // non-stream lifecycle handler exactly.
      if (errandForStream && studyCircleForStream) {
        throw routingStudyCircleContextMismatch('routing errand and study circle are both active');
      }
      const injectedSceneForStream = errandForStream || studyCircleForStream || atelierForStream;
      await streamConversationTurnSse({
        res,
        root,
        context,
        body,
        resolveConversationId: async () => (await getTurnRequest()).conversationId ?? conversationId,
        resolveCharacterId: async () => (await getTurnRequest()).characterId,
        resolveRoutingHubContext: async () => (await getTurnRequest()).routingHubContext,
        resolveRoutingGraduationGuideContext: async () => {
          const request = await getTurnRequest();
          if (activePlayMode?.mode !== 'routing' || request.routingHubContext === undefined) return undefined;
          const state = await readJson(root, 'game_data/runtime_state.json');
          return resolveRoutingGraduationGuideContext({ root, authoringRoot: context.root, state });
        },
        ...(injectedSceneForStream ? {
          resolveDungeonSceneContext: async () => errandForStream
            ? buildRoutingErrandSceneContext(errandForStream)
            : studyCircleForStream
              ? buildRoutingStudyCircleSceneContext(studyCircleForStream)
              : atelierInjectedSceneContext()
        } : {}),
        ...(errandForStream ? {
          resolveErrandJudgmentContext: async () => ({ condition_text: errandForStream.condition_text })
        } : {}),
        ...(studyCircleForStream ? {
          resolveStudyCircleJudgmentContext: async () => ({ condition_text: studyCircleForStream.condition_text })
        } : {}),
        postTurnStatePolicy: injectedSceneForStream ? companionPostTurnStatePolicy : academyPostTurnStatePolicy,
        graduationPersonaVariant: graduationPersonaVariantForActivePlayMode(activePlayMode),
        resolveRuntimeProviders,
        runConversationTurn,
        sendSseEvent,
        // A streaming turn is finalized through all in-turn seams: a decided routing hub sendoff drains via
        // attachRoutingTurnDispatch, an achieved errand auto-ends via attachRoutingErrandCompletion, and an
        // achieved study circle auto-ends via attachRoutingStudyCircleCompletion. Each is a no-op unless its own
        // signal (routing_destination / errand_achievement / study_circle_achievement) is on the turn, and hub /
        // errand / study circle are mutually exclusive, so chaining them returns the right completion contract.
        finalizeTurnResult: async (turnResult, progressReporter) => {
          const dispatched = await attachRoutingTurnDispatch({
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
            progressReporter
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
            activePlayMode,
            progressReporter
          });
          const completedStudyCircle = await attachRoutingStudyCircleCompletion({
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
            activePlayMode,
            progressReporter
          });
          return attachRoutingGraduationGuideSelection({
            root,
            context,
            body,
            turnResult: completedStudyCircle,
            resolveRuntimeProviders,
            readJson,
            writeJson,
            runConversationFinalization,
            activePlayMode,
            progressReporter
          });
        }
      });
    } catch (error) {
      sendSseEvent(res, 'status', { phase: 'chat_started' });
      sendSseEvent(res, 'error', serializeStreamError(error));
      res.end();
    }
    return true;
  }

  return false;
}
