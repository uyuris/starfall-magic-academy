import { resolvePostContentScreen } from '../playMode.mjs';
import { buildWorkshopArrivalView, executeWorkshopCraft } from '../routingWorkshop.mjs';
import { ROUTING_CONTENT_RESULT_STATE_KEY } from '../routingContentResult.mjs';
import { createStorageApi } from '../storage.mjs';

const ROUTES = new Set([
  'GET /api/workshop',
  'POST /api/workshop/craft'
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
    throw statusError('workshop content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

function requiredRecipeId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw statusError('recipe_id is required', 400, { errorCode: 'WORKSHOP_RECIPE_ID_REQUIRED' });
  }
  return normalized;
}

// Maps a craft-execution throw to a client-error status: an unknown recipe or short
// materials is the caller's 400; the LM Studio config/connection errors carry their
// own 503. Anything else (e.g. a naming-gate violation on malformed LLM output) is a
// genuine server-side failure and propagates to the 500 handler. Every path leaves
// materials unconsumed (craftWithLlmNaming fails fast before completeCraft).
function craftClientErrorStatus(error) {
  if (error?.statusCode === 400 || error?.statusCode === 409) return error.statusCode;
  if (error?.statusCode === 503) return 503;
  const message = error?.message ?? '';
  if (/^insufficient_/.test(message)) return 400;
  if (/unknown craft recipe/.test(message)) return 400;
  return null;
}

export function canHandleWorkshopApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

export async function handleWorkshopApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode,
  resolveLmStudioConfig
}) {
  if (!canHandleWorkshopApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  // Server-authoritative exit destination for the workshop, resolved identically for
  // arrival and craft. The workshop is a stay-and-craft screen with no cost guarantee
  // (every recipe may be unaffordable), so the arrival response must already carry the
  // way out instead of the frontend hardcoding it; the craft response returns the same
  // value. In routing mode this is the routing hub.
  const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });

  if (req.method === 'GET' && url.pathname === '/api/workshop') {
    const arrivalView = await buildWorkshopArrivalView({ root });
    return sendJson(res, { ...arrivalView, post_content_screen: postContentScreen });
  }

  if (req.method === 'POST' && url.pathname === '/api/workshop/craft') {
    const body = await readBody(req);
    const recipeId = requiredRecipeId(body.recipe_id);
    // Resolve the LM config before crafting: an unconfigured LM Studio fails fast here
    // (503) with nothing consumed, matching the conversation requirement level.
    const config = await resolveLmStudioConfig();
    let result;
    try {
      result = await executeWorkshopCraft({ root, recipe_id: recipeId, config, now: new Date().toISOString() });
    } catch (error) {
      const status = craftClientErrorStatus(error);
      if (status) return sendJson(res, { error: error.message, ...(error.errorCode ? { error_code: error.errorCode } : {}) }, status);
      throw error;
    }

    // The player stays in the workshop to craft again; only the content result is
    // recorded (destructively replacing any earlier one this visit). The screen is
    // left unchanged so multiple crafts in one visit each replace the result.
    const storage = createStorageApi({ root });
    const state = await storage.readJson('game_data/runtime_state.json');
    const nextState = {
      ...state,
      [ROUTING_CONTENT_RESULT_STATE_KEY]: result.content_result
    };
    await storage.writeJson('game_data/runtime_state.json', nextState);
    return sendJson(res, {
      result,
      state: nextState,
      post_content_screen: postContentScreen
    });
  }

  return sendJson(res, { error: 'not found' }, 404);
}
