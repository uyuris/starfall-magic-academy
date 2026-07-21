// 錬成室 (homunculus atelier) HTTP surface: the stay-screen server routes for the routing destination
// `homunculus` → `academy-atelier`. It exposes the arrival view, the two-mode synthesis, the farewell, and
// the atelier conversation start; the conversation turns/end reuse the general /api/conversation and
// /api/conversation/end lifecycle (the end handler recognizes the atelier conversation via its active
// marker). Every LLM-backed route resolves the LM config first, so an unconfigured LM fails fast (503) with
// nothing consumed — the errand/study/workshop contract.
//
// The atelier is fail-closed gated: even a direct API call re-checks the parameter unlock (403 otherwise),
// so the destination gate cannot be bypassed by hitting the endpoint directly.

import { resolvePostContentScreen } from '../playMode.mjs';
import { createStorageApi } from '../storage.mjs';
import { ROUTING_CONTENT_RESULT_STATE_KEY, requireRoutingContentWeek } from '../routingContentResult.mjs';
import { atelierInjectedSceneContext } from '../homunculusScene.mjs';
import { isAtelierUnlocked } from '../homunculusUnlock.mjs';
import {
  buildAtelierArrivalView,
  farewellHomunculus,
  homunculusVisualSummary,
  synthesizeHomunculus
} from '../homunculusAtelier.mjs';
import { loadHomunculiSurface } from '../homunculusSurface.mjs';
import {
  ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY,
  isAtelierConversationSpent
} from '../homunculusAtelierVisit.mjs';

const PLAYER_PARAMETERS_PATH = 'game_data/runtime/player_parameters.json';

const ROUTES = new Set([
  'GET /api/atelier',
  'POST /api/atelier/synthesize',
  'POST /api/atelier/farewell',
  'POST /api/atelier/conversation/start'
]);

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw statusError('atelier content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

// Re-checks the fail-closed unlock on the live parameters (defense in depth: the destination gate already
// filters candidates, but a direct endpoint call must not bypass it). 403 with nothing done on a gate miss.
async function assertAtelierUnlocked(storage) {
  const playerParameters = await storage.readJsonIfExists(PLAYER_PARAMETERS_PATH);
  if (!isAtelierUnlocked(playerParameters)) {
    throw statusError('the atelier is not unlocked', 403, { errorCode: 'HOMUNCULUS_ATELIER_LOCKED' });
  }
}

// Maps a synthesis/farewell throw to a client-error status: short cost / bad name / mode is the caller's 400,
// a full roster / not-active / exhausted pool is 409/404, and the LM config/connection error carries its own
// 503. Anything else (e.g. a generation gate violation on malformed LLM output) is a genuine server failure.
function atelierClientErrorStatus(error) {
  if (error?.statusCode === 400 || error?.statusCode === 403 || error?.statusCode === 404 || error?.statusCode === 409) return error.statusCode;
  if (error?.statusCode === 503) return 503;
  if (/^insufficient_/.test(error?.message ?? '')) return 400;
  return null;
}

function sendAtelierError(res, sendJson, error) {
  const status = atelierClientErrorStatus(error);
  if (status === null) throw error;
  return sendJson(res, { error: error.message, ...(error.errorCode ? { error_code: error.errorCode } : {}) }, status);
}

export function canHandleAtelierApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

function makeAtelierConversationId({ now, week, homunculusId }) {
  const timestamp = String(now).replace(/[^0-9A-Za-z]/g, '');
  return `conv_atelier_${week}_${homunculusId}_${timestamp}`;
}

export async function handleAtelierApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode,
  resolveLmStudioConfig,
  resolveRuntimeProviders,
  runConversationOpening,
  startInteractionSession
}) {
  if (!canHandleAtelierApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const storage = createStorageApi({ root });
  await assertAtelierUnlocked(storage);
  const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });

  if (req.method === 'GET' && url.pathname === '/api/atelier') {
    const arrivalView = await buildAtelierArrivalView({ storage });
    const state = await storage.readJson('game_data/runtime_state.json');
    const week = requireRoutingContentWeek(state);
    return sendJson(res, {
      ...arrivalView,
      conversation_spent: isAtelierConversationSpent(state, week),
      post_content_screen: postContentScreen
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/atelier/synthesize') {
    const body = await readBody(req);
    const config = await resolveLmStudioConfig();
    let result;
    try {
      result = await synthesizeHomunculus({
        root,
        storage,
        config,
        mode: body.mode,
        name: body.name,
        skeleton: body.skeleton,
        materials: body.materials,
        rng: Math.random,
        now: new Date().toISOString()
      });
    } catch (error) {
      return sendAtelierError(res, sendJson, error);
    }
    // Record the `created` content result (destructively replacing any earlier result this visit); the
    // player stays in the atelier, so the screen is unchanged.
    const state = await storage.readJson('game_data/runtime_state.json');
    const nextState = { ...state, [ROUTING_CONTENT_RESULT_STATE_KEY]: result.content_result };
    await storage.writeJson('game_data/runtime_state.json', nextState);
    return sendJson(res, { result, state: nextState, post_content_screen: postContentScreen });
  }

  if (req.method === 'POST' && url.pathname === '/api/atelier/farewell') {
    const body = await readBody(req);
    const config = await resolveLmStudioConfig();
    let result;
    try {
      result = await farewellHomunculus({
        root,
        storage,
        config,
        homunculusId: body.homunculus_id,
        now: new Date().toISOString()
      });
    } catch (error) {
      return sendAtelierError(res, sendJson, error);
    }
    const state = await storage.readJson('game_data/runtime_state.json');
    const nextState = { ...state, [ROUTING_CONTENT_RESULT_STATE_KEY]: result.content_result };
    await storage.writeJson('game_data/runtime_state.json', nextState);
    return sendJson(res, { result, state: nextState, post_content_screen: postContentScreen });
  }

  if (req.method === 'POST' && url.pathname === '/api/atelier/conversation/start') {
    if (typeof resolveRuntimeProviders !== 'function') throw new Error('resolveRuntimeProviders is required');
    if (typeof runConversationOpening !== 'function') throw new Error('runConversationOpening is required');
    if (typeof startInteractionSession !== 'function') throw new Error('startInteractionSession is required');
    const body = await readBody(req);
    const config = await resolveLmStudioConfig();

    try {
      const homunculusId = String(body.homunculus_id ?? '').trim();
      const state = await storage.readJson('game_data/runtime_state.json');
      const week = requireRoutingContentWeek(state);
      // 1 visit = 1 conversation: refuse if one is active or already completed this visit.
      if (isAtelierConversationSpent(state, week)) {
        throw statusError('this atelier visit has already used its one conversation', 409, {
          errorCode: 'HOMUNCULUS_CONVERSATION_ALREADY_SPENT'
        });
      }
      const surface = await loadHomunculiSurface({ storage });
      const activeEntry = surface.active.find((entry) => entry.homunculus_id === homunculusId);
      if (!activeEntry) {
        throw statusError(`homunculus is not active in the atelier: ${homunculusId}`, 404, {
          errorCode: 'HOMUNCULUS_NOT_ACTIVE'
        });
      }

      const now = new Date().toISOString();
      const conversationId = makeAtelierConversationId({ now, week, homunculusId });
      await startInteractionSession({ root, characterId: homunculusId });
      const providers = await resolveRuntimeProviders({ requestedProvider: body.provider, context });
      const opening = await runConversationOpening({
        root,
        id: conversationId,
        characterId: homunculusId,
        now,
        dungeonSceneContext: atelierInjectedSceneContext(),
        ...providers
      });

      const stateAfterOpening = await storage.readJson('game_data/runtime_state.json');
      const nextState = {
        ...stateAfterOpening,
        current_screen: 'interaction',
        current_interaction_character_id: homunculusId,
        last_conversation_id: conversationId,
        [ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY]: {
          conversation_id: conversationId,
          homunculus_id: homunculusId,
          display_name: activeEntry.display_name,
          face_id: activeEntry.face_id,
          week
        }
      };
      await storage.writeJson('game_data/runtime_state.json', nextState);
      return sendJson(res, {
        ...opening,
        state: nextState,
        homunculus: homunculusVisualSummary({
          homunculusId,
          displayName: activeEntry.display_name,
          faceId: activeEntry.face_id
        })
      });
    } catch (error) {
      return sendAtelierError(res, sendJson, error);
    }
  }

  return sendJson(res, { error: 'not found' }, 404);
}
