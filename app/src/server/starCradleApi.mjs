// 星の揺り籠 (star cradle) HTTP surface: the hub sandbox server routes. The garden is a routing-only hub
// side-activity (not a week destination), so every route is gated to routing mode (409 otherwise), exactly like
// the other hub-only APIs. No route touches the LM — the whole feature works with LM Studio unconfigured.
//
// The response shapes here are the upstream contract for the frontend task: the GET state view (pots / creatures
// / caged items with their derived stages and rewards-ready flags) and the per-action results.

import { createStorageApi } from '../storage.mjs';
import { requireRoutingContentWeek } from '../routingContentResult.mjs';
import { loadStarCradleCatalog } from '../starCradleCatalog.mjs';
import { annotateInventoryItemActions, loadInventoryItemActionSources } from './inventoryUsability.mjs';
import {
  buildStarCradleView,
  plantStarCradleSeed,
  feedStarCradleIndividual,
  harvestStarCradlePlant,
  claimStarCradleByproduct,
  nameStarCradleCreature,
  cageStarCradleCreature,
  releaseStarCradleCreature
} from '../starCradleOperations.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

const ROUTES = new Set([
  'GET /api/star-cradle',
  'POST /api/star-cradle/plant',
  'POST /api/star-cradle/feed',
  'POST /api/star-cradle/harvest',
  'POST /api/star-cradle/byproduct',
  'POST /api/star-cradle/name',
  'POST /api/star-cradle/cage',
  'POST /api/star-cradle/release'
]);

function statusError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw statusError('star cradle content requires routing mode', 409, 'ROUTING_MODE_REQUIRED');
  }
}

// A caller-error status (bad request / missing slot / gate conflict) is returned as JSON; anything else is a
// genuine server failure and re-throws.
function starCradleClientErrorStatus(error) {
  if (error?.statusCode === 400 || error?.statusCode === 404 || error?.statusCode === 409) return error.statusCode;
  if (/^insufficient_/.test(error?.message ?? '')) return 400;
  return null;
}

function sendStarCradleError(res, sendJson, error) {
  const status = starCradleClientErrorStatus(error);
  if (status === null) throw error;
  return sendJson(res, { error: error.message, ...(error.errorCode ? { error_code: error.errorCode } : {}) }, status);
}

export function canHandleStarCradleApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// The inventory-returning routes (plant/feed/harvest/byproduct) hand their `inventory` straight to the routing
// hub drawer, which requires the server-authoritative `items[].usable` / `items[].gift_category` annotations.
// Annotate with the single shared helper and the same sources GET /api/inventory / POST /api/inventory/use use, so
// a star-cradle response and a plain inventory fetch agree for the same state. Routes that return no `inventory`
// are untouched.
async function annotateResultInventory({ root, result }) {
  const sources = await loadInventoryItemActionSources({ root });
  return { ...result, inventory: annotateInventoryItemActions(result.inventory, sources) };
}

export async function handleStarCradleApi({ req, res, url, context, sendJson, readBody, activePlayMode }) {
  if (!canHandleStarCradleApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const storage = createStorageApi({ root });
  const catalog = await loadStarCradleCatalog({ storage });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const currentWeek = requireRoutingContentWeek(state);

  try {
    if (req.method === 'GET' && url.pathname === '/api/star-cradle') {
      return sendJson(res, await buildStarCradleView({ storage, catalog, currentWeek }));
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/plant') {
      const body = await readBody(req);
      const result = await plantStarCradleSeed({ root, storage, catalog, itemId: body.item_id, currentWeek });
      return sendJson(res, { ...await annotateResultInventory({ root, result }), view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/feed') {
      const body = await readBody(req);
      const result = await feedStarCradleIndividual({ root, storage, catalog, kind: body.kind, slotIndex: body.slot_index, materialItemId: body.material_item_id, currentWeek });
      return sendJson(res, { ...await annotateResultInventory({ root, result }), view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/harvest') {
      const body = await readBody(req);
      const result = await harvestStarCradlePlant({ root, storage, catalog, slotIndex: body.slot_index, currentWeek });
      return sendJson(res, { ...await annotateResultInventory({ root, result }), view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/byproduct') {
      const body = await readBody(req);
      const result = await claimStarCradleByproduct({ root, storage, catalog, slotIndex: body.slot_index, currentWeek });
      return sendJson(res, { ...await annotateResultInventory({ root, result }), view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/name') {
      const body = await readBody(req);
      const result = await nameStarCradleCreature({ storage, catalog, slotIndex: body.slot_index, name: body.name, currentWeek });
      return sendJson(res, { ...result, view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/cage') {
      const body = await readBody(req);
      const result = await cageStarCradleCreature({ storage, catalog, slotIndex: body.slot_index, currentWeek });
      return sendJson(res, { ...result, view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/star-cradle/release') {
      const body = await readBody(req);
      const result = await releaseStarCradleCreature({ storage, catalog, instanceId: body.instance_id, currentWeek });
      return sendJson(res, { ...result, view: await buildStarCradleView({ storage, catalog, currentWeek }) });
    }
  } catch (error) {
    return sendStarCradleError(res, sendJson, error);
  }
  return sendJson(res, { error: 'not found' }, 404);
}
