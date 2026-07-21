// The single strict resolution of every executable auction-treasure effect that shares a runtime with an
// alchemy item — gift delivery and self-boost — the same way `dungeon/combatConsumables.mjs` already resolves the
// auction `dungeon_consumable` effect alongside its alchemy siblings. The auction catalog is the effect authority
// (`data/definitions/game_data/auction_catalog.json` → `effect`), so the projections here read those authored
// values (affinity_bonus / parameter_effects) rather than copying them; a treasure item's name/description reuse
// the auction inventory-definition projection so the display fields have a single source of truth.
//
// Every consumer resolves from ONE merged definition list — conversation gift from the deliverable-gift merge,
// inventory use / usability from the self-boost merge — so a listing↔use drift is structurally impossible. An
// item_id shared across the two sources throws (fail-fast); a treasure effect item with no inventory definition
// throws. Selection is by the `effect.category` predicate, so a newly authored auction gift / self_boost is
// picked up automatically (no item_id hardcode).

import { loadAlchemyDefinitions } from './alchemyDefinitions.mjs';
import { loadAuctionCatalog, auctionInventoryItemDefinitions } from './routingAuction.mjs';

// The alchemy categories that are hand-over-able in conversation: a `gift` raises affinity, an `ally_boost`
// raises the recipient's parameters. The auction side contributes only `gift` treasure items (it authors no
// ally_boost). Defined here as the single vocabulary so both the deliverable merge and conversationGift's
// resolver agree on what "deliverable" means.
export const DELIVERABLE_GIFT_CATEGORIES = Object.freeze(['gift', 'ally_boost']);

// item_id → the auction inventory definition (name/description) the economy already shows for these items.
function auctionInventoryDefinitionsById(catalog) {
  return new Map(auctionInventoryItemDefinitions(catalog).map((definition) => [definition.item_id, definition]));
}

// Projects the auction treasure items whose `effect.category` matches into the same normalized item shape as the
// corresponding alchemy items (item_id / name / description / category + the category's effect fields). The auction
// catalog loader (`routingAuction.validateTreasureEffect`) has already rejected any effect.category outside
// {gift, self_boost, dungeon_consumable} and validated each category's exact shape at load time, so an unknown /
// malformed effect never reaches here to be silently dropped — the authored effect fields map straight through. A
// treasure item without an inventory definition throws (fail-fast), never a silently unnamed row.
function projectAuctionEffectItems(catalog, effectCategory, projectEffectFields) {
  const inventoryById = auctionInventoryDefinitionsById(catalog);
  return catalog.items
    .filter((item) => item.effect?.category === effectCategory)
    .map((item) => {
      const inventoryDefinition = inventoryById.get(item.item_id);
      if (!inventoryDefinition) {
        throw new Error(`auction ${effectCategory} item is missing an inventory definition: ${item.item_id}`);
      }
      return {
        item_id: item.item_id,
        name: inventoryDefinition.name,
        description: inventoryDefinition.description,
        ...projectEffectFields(item.effect)
      };
    });
}

// The auction `gift` treasure items as deliverable gift definitions (same shape as an alchemy `gift` item).
export function auctionGiftItemDefinitions(catalog) {
  return projectAuctionEffectItems(catalog, 'gift', (effect) => ({ category: 'gift', affinity_bonus: effect.affinity_bonus }));
}

// The auction `self_boost` treasure items as self-boost definitions (same shape as an alchemy `self_boost` item).
export function auctionSelfBoostItemDefinitions(catalog) {
  return projectAuctionEffectItems(catalog, 'self_boost', (effect) => ({ category: 'self_boost', parameter_effects: effect.parameter_effects }));
}

// Rejects an item_id that appears in more than one source (alchemy vs auction) rather than silently shadowing one
// definition. In practice the id patterns (`alchemy_*` vs `auction_*`) never collide, but the guard makes a future
// authoring clash a load-time failure instead of a silent runtime divergence.
function assertUniqueItemIds(definitions, label) {
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition.item_id)) throw new Error(`duplicate ${label} definition: ${definition.item_id}`);
    seen.add(definition.item_id);
  }
  return definitions;
}

// The merged deliverable-gift definition list: alchemy gift + ally_boost items and auction gift treasure items.
export function mergeDeliverableGiftDefinitions({ alchemyDefinitions, auctionCatalog }) {
  return assertUniqueItemIds([
    ...alchemyDefinitions.items.filter((item) => DELIVERABLE_GIFT_CATEGORIES.includes(item.category)),
    ...auctionGiftItemDefinitions(auctionCatalog)
  ], 'deliverable gift');
}

// The merged self-boost definition list: alchemy self_boost items and auction self_boost treasure items.
export function mergeSelfBoostDefinitions({ alchemyDefinitions, auctionCatalog }) {
  return assertUniqueItemIds([
    ...alchemyDefinitions.items.filter((item) => item.category === 'self_boost'),
    ...auctionSelfBoostItemDefinitions(auctionCatalog)
  ], 'self_boost');
}

// Loads both effect sources once and returns everything gift resolution needs: the merged deliverable-gift list,
// and the set of every known effect-bearing item id (all alchemy items ∪ all auction treasure items) so the
// resolver can tell a truly unknown id from a known-but-not-deliverable one.
export async function loadGiftResolutionSources({ root }) {
  const [alchemyDefinitions, auctionCatalog] = await Promise.all([
    loadAlchemyDefinitions({ root }),
    loadAuctionCatalog({ root })
  ]);
  const deliverable = mergeDeliverableGiftDefinitions({ alchemyDefinitions, auctionCatalog });
  const knownEffectItemIds = new Set([
    ...alchemyDefinitions.items.map((item) => item.item_id),
    ...auctionCatalog.items.filter((item) => item.category === 'treasure').map((item) => item.item_id)
  ]);
  return { deliverable, knownEffectItemIds };
}

// The merged self-boost definition list loaded from disk — the single source both economy.useInventoryItem and
// the inventory usability annotation resolve from.
export async function loadSelfBoostDefinitions({ root }) {
  const [alchemyDefinitions, auctionCatalog] = await Promise.all([
    loadAlchemyDefinitions({ root }),
    loadAuctionCatalog({ root })
  ]);
  return mergeSelfBoostDefinitions({ alchemyDefinitions, auctionCatalog });
}
