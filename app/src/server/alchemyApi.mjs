import { resolvePostContentScreen } from '../playMode.mjs';
import { buildAlchemyBookView, craftAlchemyRecipe } from '../routingAlchemy.mjs';
import { ROUTING_CONTENT_RESULT_STATE_KEY } from '../routingContentResult.mjs';
import { createStorageApi } from '../storage.mjs';

const ROUTES = new Set([
  'GET /api/alchemy',
  'POST /api/alchemy/craft'
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
    throw statusError('alchemy content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

function requiredRecipeId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw statusError('recipe_id is required', 400, { errorCode: 'ALCHEMY_RECIPE_ID_REQUIRED' });
  }
  return normalized;
}

// Maps a craft-execution throw to a client-error status: an unknown recipe, a malformed material choice,
// or short materials/money is the caller's 400. Anything else is a genuine server failure (500). Every
// path leaves materials unconsumed (craftAlchemyRecipe fails fast before consumeInventoryItems, which is
// itself atomic).
function craftClientErrorStatus(error) {
  if (error?.statusCode === 400) return 400;
  if (/^insufficient_/.test(error?.message ?? '')) return 400;
  return null;
}

export function canHandleAlchemyApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

export async function handleAlchemyApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode
}) {
  if (!canHandleAlchemyApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  // Server-authoritative exit destination for the alchemy stay screen, resolved identically for the
  // book view and each craft. The alchemy lab is a stay-and-craft screen with no cost guarantee (a recipe
  // may be unaffordable), so the arrival response already carries the way out; the craft response returns
  // the same value. In routing mode this is the routing hub.
  const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });

  if (req.method === 'GET' && url.pathname === '/api/alchemy') {
    const bookView = await buildAlchemyBookView({ root });
    return sendJson(res, { ...bookView, post_content_screen: postContentScreen });
  }

  if (req.method === 'POST' && url.pathname === '/api/alchemy/craft') {
    const body = await readBody(req);
    const recipeId = requiredRecipeId(body.recipe_id);
    let result;
    try {
      result = await craftAlchemyRecipe({ root, recipe_id: recipeId, materials: body.materials ?? null, now: new Date().toISOString() });
    } catch (error) {
      const status = craftClientErrorStatus(error);
      if (status) return sendJson(res, { error: error.message, ...(error.errorCode ? { error_code: error.errorCode } : {}) }, status);
      throw error;
    }

    // The player stays in the alchemy lab to craft again; only the content result is recorded
    // (destructively replacing any earlier one this visit). The screen is left unchanged, so multiple
    // crafts in one visit each replace the result — the same stay-and-craft grammar as the workshop.
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
