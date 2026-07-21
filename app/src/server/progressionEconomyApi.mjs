import { runTraining, skipTraining } from '../training.mjs';
import { isRoutingActivePlayMode, resolvePostContentScreen } from '../playMode.mjs';
import {
  buyShopItem,
  collectGatheringPoint,
  loadGathering,
  loadInventory,
  loadShopCatalog,
  resetGatheringStocks,
  sellShopItem,
  useInventoryItem
} from '../economy.mjs';
import { sellEquipmentInstance } from '../equipmentSale.mjs';
import { startNextAcademyWeek } from '../graduationEnding.mjs';
import { ensureSanrinCreaturePlacements } from '../fieldRuntime.mjs';
import { annotateInventoryItemActions, loadInventoryItemActionSources } from './inventoryUsability.mjs';
import { resolveAcademyConversationLandingScreen } from './conversationPopupSettingsApi.mjs';

export function canHandleProgressionEconomyApiRoute(method, pathname) {
  return (
    (method === 'POST' && pathname === '/api/training/run') ||
    (method === 'POST' && pathname === '/api/training/skip') ||
    (method === 'POST' && pathname === '/api/academy/week/start') ||
    (method === 'GET' && pathname === '/api/inventory') ||
    (method === 'POST' && pathname === '/api/inventory/use') ||
    (method === 'GET' && pathname === '/api/gathering') ||
    (method === 'POST' && pathname === '/api/gathering/collect') ||
    (method === 'GET' && pathname === '/api/shop') ||
    (method === 'POST' && pathname === '/api/shop/buy') ||
    (method === 'POST' && pathname === '/api/shop/sell') ||
    (method === 'POST' && pathname === '/api/shop/sell-equipment')
  );
}

function resolvePostTrainingScreen(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  return resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });
}

export async function handleProgressionEconomyApi({ req, res, url, context, sendJson, readBody, activePlayMode }) {
  const root = context.activeRoot ?? context.root;

  if (req.method === 'POST' && url.pathname === '/api/training/run') {
    const body = await readBody(req);
    const postTrainingScreen = resolvePostTrainingScreen(activePlayMode);
    const routing = isRoutingActivePlayMode(activePlayMode);
    return sendJson(res, {
      ...await runTraining({ root, trainingId: body.training_id, randomSeed: body.random_seed, postTrainingScreen, routing }),
      post_content_screen: postTrainingScreen
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/training/skip') {
    const postTrainingScreen = resolvePostTrainingScreen(activePlayMode);
    const routing = isRoutingActivePlayMode(activePlayMode);
    return sendJson(res, {
      ...await skipTraining({ root, postTrainingScreen, routing }),
      post_content_screen: postTrainingScreen
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/academy/week/start') {
    // A new week re-draws the fixed Sanrin creature placement (same weekly rhythm as the
    // gathering-stock reset). Run it first so a present-but-corrupted placement fails fast
    // before the week is advanced — no half-applied week and no silent overwrite.
    await ensureSanrinCreaturePlacements({ root, force: true });
    // The loop 50-week branch lands the graduation event on the fixed daytime conversation screen — the same
    // landing every event conversation follows — so startNextAcademyWeek writes the truthful current_screen for
    // it. Non-graduation weeks never consume it.
    const graduationEndingScreen = resolveAcademyConversationLandingScreen();
    const result = await startNextAcademyWeek({ root, authoringRoot: context.root, graduationEndingScreen });
    const gathering = await resetGatheringStocks({ root });
    return sendJson(res, { ...result, gathering });
  }
  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const [inventory, sources] = await Promise.all([
      loadInventory({ root }),
      loadInventoryItemActionSources({ root })
    ]);
    return sendJson(res, annotateInventoryItemActions(inventory, sources));
  }
  if (req.method === 'POST' && url.pathname === '/api/inventory/use') {
    const body = await readBody(req);
    try {
      const result = await useInventoryItem({ root, itemId: body.item_id, quantity: body.quantity });
      const sources = await loadInventoryItemActionSources({ root });
      return sendJson(res, { ...result, inventory: annotateInventoryItemActions(result.inventory, sources) });
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/gathering') {
    return sendJson(res, await loadGathering({ root }));
  }
  if (req.method === 'POST' && url.pathname === '/api/gathering/collect') {
    const body = await readBody(req);
    try {
      return sendJson(res, await collectGatheringPoint({ root, pointId: body.point_id }));
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/shop') {
    return sendJson(res, await loadShopCatalog({ root }));
  }
  if (req.method === 'POST' && url.pathname === '/api/shop/buy') {
    const body = await readBody(req);
    try {
      return sendJson(res, await buyShopItem({ root, itemId: body.item_id, quantity: body.quantity }));
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/shop/sell') {
    const body = await readBody(req);
    try {
      return sendJson(res, await sellShopItem({ root, itemId: body.item_id, quantity: body.quantity }));
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }
  // Equipment instances live in a separate one-off surface (player_equipment.json), not the
  // quantity ledger, so they are sold through their own domain, not sellShopItem. The
  // domain's client-facing rejections (unknown_equipment_instance / equipment_instance_equipped)
  // surface as the 400 error code, matching the sibling shop-sell wrapping.
  if (req.method === 'POST' && url.pathname === '/api/shop/sell-equipment') {
    const body = await readBody(req);
    try {
      return sendJson(res, await sellEquipmentInstance({ root, instance_id: body.instance_id }));
    } catch (error) {
      return sendJson(res, { error: error.message }, 400);
    }
  }
}
