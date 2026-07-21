// Server-authoritative per-item action annotations for inventory items: the 使う (usable) gate and the 渡す
// (gift_category) gate. Both are decided here on the server (never by a frontend id/name list): GET /api/inventory
// and POST /api/inventory/use carry an additive `usable` boolean and an additive `gift_category`
// ('gift' | 'ally_boost' | null) per item so the routing-hub drawer and the daytime conversation drawer read them
// directly.
//
//   - usable mirrors the two accept branches of economy.useInventoryItem exactly: a 購買 stat 霊薬 (shop catalog
//     item with a stat_effect group && key) and a self_boost item resolved from the merged self-boost source
//     (調合 self_boost ＋ オークション treasure の self_boost). Every other category, every dungeon material, and any
//     unknown id is not usable — matching useInventoryItem's item_is_not_usable / unknown_inventory_item rejection.
//   - gift_category mirrors conversationGift.resolveGiftItem's deliverable set (調合 gift/ally_boost ＋ オークション
//     gift). A non-deliverable item is null. The daytime drawer shows 渡す on any non-null category; the hub guide
//     drawer shows it only for 'gift' (the guide holds no parameter surface), matching the gift API's own guard.
//
// economy.mjs / conversationGift.mjs own the write paths; this owns the read-only projection of the same rules,
// and inventoryUsability.test.mjs pins them together so they cannot drift.

import { loadShopCatalog } from '../economy.mjs';
import { loadAlchemyDefinitions } from '../alchemyDefinitions.mjs';
import { loadAuctionCatalog } from '../routingAuction.mjs';
import { mergeSelfBoostDefinitions, mergeDeliverableGiftDefinitions } from '../auctionEffectItems.mjs';

// Whether POST /api/inventory/use would accept this item id (before quantity checks). Pure over the supplied
// sources so it is trivially testable and shares no hidden state with the write path.
export function isInventoryItemUsable(itemId, { shopCatalog, selfBoostItemIds }) {
  if (!shopCatalog || !Array.isArray(shopCatalog.items)) {
    throw new Error('isInventoryItemUsable requires a shopCatalog with an items array');
  }
  if (!(selfBoostItemIds instanceof Set)) {
    throw new Error('isInventoryItemUsable requires a selfBoostItemIds set');
  }
  const shopItem = shopCatalog.items.find((candidate) => candidate.item_id === itemId);
  if (shopItem?.stat_effect?.group && shopItem?.stat_effect?.key) return true;
  return selfBoostItemIds.has(itemId);
}

// The deliverable gift category ('gift' | 'ally_boost') POST /api/conversation/gift would resolve this id to, or
// null when the item is not a deliverable gift. Pure over the supplied sources.
export function inventoryItemGiftCategory(itemId, { giftCategoryById }) {
  if (!(giftCategoryById instanceof Map)) {
    throw new Error('inventoryItemGiftCategory requires a giftCategoryById map');
  }
  return giftCategoryById.get(itemId) ?? null;
}

// Loads the definition sources the action rules need (the same sources economy.useInventoryItem and
// conversationGift.resolveGiftItem read) and derives the per-item lookup structures once.
export async function loadInventoryItemActionSources({ root }) {
  const [shopCatalog, alchemyDefinitions, auctionCatalog] = await Promise.all([
    loadShopCatalog({ root }),
    loadAlchemyDefinitions({ root }),
    loadAuctionCatalog({ root })
  ]);
  const selfBoostItemIds = new Set(
    mergeSelfBoostDefinitions({ alchemyDefinitions, auctionCatalog }).map((definition) => definition.item_id)
  );
  const giftCategoryById = new Map(
    mergeDeliverableGiftDefinitions({ alchemyDefinitions, auctionCatalog }).map((definition) => [definition.item_id, definition.category])
  );
  return { shopCatalog, selfBoostItemIds, giftCategoryById };
}

// Returns a copy of a decorated inventory ({ money, items }) with additive `usable` and `gift_category` fields on
// every item. Existing fields are preserved untouched (additive); existing consumers that ignore them are unaffected.
export function annotateInventoryItemActions(inventory, sources) {
  if (!inventory || !Array.isArray(inventory.items)) {
    throw new Error('annotateInventoryItemActions requires an inventory with an items array');
  }
  return {
    ...inventory,
    items: inventory.items.map((item) => ({
      ...item,
      usable: isInventoryItemUsable(item.item_id, sources),
      gift_category: inventoryItemGiftCategory(item.item_id, sources)
    }))
  };
}
