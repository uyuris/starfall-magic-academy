import { startInteractionSession } from '../llm/conversationPipeline.mjs';
import { startEventFlagInteraction } from '../eventFlags.mjs';
import { buildRoutingHubContextSnapshot } from '../routingHubContextSnapshot.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../routingPersona.mjs';
import { isRoutingOpeningEventPending, ROUTING_OPENING_EVENT_FLAG_ID } from '../routingOpeningEvent.mjs';
import { buildRoutingPersonaVisualSummary } from '../routingPersonaVisual.mjs';
import {
  isInFlightGraduationPhase2,
  readRoutingGraduationGuide,
  selectGraduationEndingCharacterIds,
  GRADUATION_ENDING_WEEK,
  GRADUATION_GUIDE_CANDIDATE_LIMIT,
  ROUTING_GRADUATION_GUIDE_STATE_KEY
} from '../graduationEnding.mjs';
import { createStorageApi } from '../storage.mjs';

const ROUTING_HUB_START_ROUTE = 'POST /api/routing/hub/start';
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertValidConversationIdForApi(value, fieldName = 'id') {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (CONVERSATION_ID_PATTERN.test(normalized)) return normalized;
  throw statusError(`invalid ${fieldName}: ${value}`, 400, { errorCode: 'invalid_conversation_id' });
}

export function canHandleRoutingHubRoute(method, pathname) {
  return ROUTING_HUB_START_ROUTE === `${method} ${pathname}`;
}

export async function handleRoutingHubApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  resolveRuntimeProviders,
  runConversationOpening,
  activePlayMode
}) {
  if (!canHandleRoutingHubRoute(req.method, url.pathname)) return false;
  if (typeof resolveRuntimeProviders !== 'function') throw new Error('resolveRuntimeProviders is required');
  if (typeof runConversationOpening !== 'function') throw new Error('runConversationOpening is required');

  const body = await readBody(req);
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw statusError('routing hub start requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }

  const root = context.activeRoot ?? context.root;
  const conversationId = assertValidConversationIdForApi(body.id, 'id');
  const stateBeforeStart = await createStorageApi({ root }).readJson('game_data/runtime_state.json');
  // An in-flight graduation phase 2 (ending) conversation must never be overwritten by a hub greeting: the
  // hub start would replace the pending ending context and active conversation with a fresh hub conversation,
  // restarting the graduation flow. The normal frontend flow re-enters phase 2 through the load/slots entry
  // contract and never reaches here; this guard structurally closes the overwrite path fail-fast.
  if (isInFlightGraduationPhase2(stateBeforeStart)) {
    throw statusError(
      'routing hub start is not allowed during an in-flight graduation phase 2 conversation',
      409,
      { errorCode: 'GRADUATION_PHASE2_IN_FLIGHT' }
    );
  }
  const routingHubContext = await buildRoutingHubContextSnapshot({
    root,
    authoringRoot: context.root,
    state: stateBeforeStart,
    personaVariant: activePlayMode.routing_persona_variant
  });
  const providers = await resolveRuntimeProviders({ context });
  // Drain-on-exit owns all post-processing: every routing exit fully drains the pending-finalization
  // queue before it transitions, so the hub always opens on an empty queue. There is no entry pre-drain
  // here — the opening starts immediately.
  //
  // First hub greeting of a routing new game: start the opening event through the shared event
  // mechanism so its opening_context is injected as this actor's event context. keepCurrentLocation
  // holds the routing meta-surface (the hub is not a field location, so the opening must not move
  // current_location_id). Any later visit finds the event completed (complete_when_started) and takes
  // the normal startInteractionSession path, which is byte-identical to the pre-event hub greeting.
  if (isRoutingOpeningEventPending(stateBeforeStart)) {
    await startEventFlagInteraction({ root, flagId: ROUTING_OPENING_EVENT_FLAG_ID, keepCurrentLocation: true });
  } else {
    await startInteractionSession({ root, characterId: ROUTING_PERSONA_CHARACTER_ID });
  }
  const result = await runConversationOpening({
    root,
    id: conversationId,
    characterId: ROUTING_PERSONA_CHARACTER_ID,
    now: new Date().toISOString(),
    routingHubContext,
    ...providers
  });
  // Graduation guide: the routing graduation guide is created here, at hub start, when the displayed graduation
  // week (elapsed_weeks GRADUATION_ENDING_WEEK - 1) begins. Its presence makes every continuation turn of this hub
  // conversation run the guide (top-N partner selection) instead of routing destination selection; the opening
  // above is untouched (smalltalk, no guide context). elapsed_weeks stays at GRADUATION_ENDING_WEEK - 1 through the
  // guide — the ending conversation is what advances it. Idempotent: a re-start with the guide already present
  // does not re-select or overwrite it. This runs after the opening writes so those writes cannot clobber it. An
  // in-flight ending (guarded above) never reaches here; a degenerate empty roster creates no guide.
  const stateAfterOpening = await createStorageApi({ root }).readJson('game_data/runtime_state.json');
  if (
    stateAfterOpening.elapsed_weeks >= GRADUATION_ENDING_WEEK - 1
    && stateAfterOpening.ending_started !== true
    && stateAfterOpening.ending_completed !== true
    && readRoutingGraduationGuide(stateAfterOpening) === null
  ) {
    const candidateCharacterIds = await selectGraduationEndingCharacterIds(root, { limit: GRADUATION_GUIDE_CANDIDATE_LIMIT });
    if (candidateCharacterIds.length > 0) {
      await createStorageApi({ root }).writeJson('game_data/runtime_state.json', {
        ...stateAfterOpening,
        [ROUTING_GRADUATION_GUIDE_STATE_KEY]: {
          candidate_character_ids: candidateCharacterIds,
          started_at: new Date().toISOString()
        }
      });
    }
  }
  // Expose the routing persona's non-selectable actor visual summary so the frontend can render ルミ's
  // own face / standee / speaker icon instead of falling back to the selectable roster. The visual set
  // follows the session's effective variant (server authoritative: the same routing_persona_variant that
  // drove the context snapshot above), so switching variant switches every routing display surface.
  const routingPersonaVisual = await buildRoutingPersonaVisualSummary({
    root,
    personaVariant: activePlayMode.routing_persona_variant
  });
  sendJson(res, { ...result, routing_persona_visual: routingPersonaVisual });
  return true;
}
