// Shared dungeon-consumable machinery for combat subsystems: the merged definition source
// (alchemy `dungeon_consumable` items + auction `effect.category === 'dungeon_consumable'`
// treasure items), the target-mode classification, the view-row summary, the owned-quantity
// read from player_inventory, the usable-consumables view loader, and the flat-damage
// application. The dungeon (C-23) and the arena engine (C-26) both surface and apply the same
// carried consumables (attack_single / attack_area / heal / mp / revive) to a player-controlled
// fighter, resolving the used item from that one merged definition source so the usable list and
// the use path can never diverge; the per-subsystem targeting orchestration (who is an ally, aim
// validity) stays in each engine because it binds to that engine's actor model.

import { createStorageApi } from '../storage.mjs';
import { loadAlchemyDefinitions } from '../alchemyDefinitions.mjs';
import { loadAuctionCatalog, auctionInventoryItemDefinitions } from '../routingAuction.mjs';
import { COMBAT_HEAL_MULTIPLIER } from './combatResolution.mjs';

// The HP a heal consumable restores: `heal_full` tops the ally off to its (scaled) max; a
// fixed-amount `heal` restores its authored amount scaled by the combat heal multiplier. Defined
// once here so the dungeon (C-23) and arena (C-26) apply identical scaling with no double-apply.
export function consumableHealAmount(item, allyActor) {
  return item.effect_kind === 'heal_full' ? allyActor.max_hp : item.heal_amount * COMBAT_HEAL_MULTIPLIER;
}

// The MP an MP-restore consumable restores: `mp_restore_full` tops the ally's MP off; a
// fixed-amount `mp_restore` restores its authored amount scaled by the combat heal multiplier.
export function consumableMpAmount(item, allyActor) {
  return item.effect_kind === 'mp_restore_full' ? allyActor.max_mp : item.mp_amount * COMBAT_HEAL_MULTIPLIER;
}

// The player-facing target mode for a consumable's effect kind, surfaced on the view so the frontend
// knows what input to collect: attack_single auto-targets the nearest visible enemy, attack_area needs
// an aim tile, heal/MP pick an ally, revive is a downed ally.
export function consumableTargetMode(effectKind) {
  if (effectKind === 'attack_single') return 'auto';
  if (effectKind === 'attack_area') return 'aim';
  if (effectKind === 'revive') return 'revive';
  return 'ally'; // heal / heal_full / mp_restore / mp_restore_full
}

// One view row for an owned consumable: identity + quantity + the effect kind's tunables, so the
// frontend can label the item and drive its targeting UI without re-reading the alchemy catalog. The
// heal/mp_restore rows carry the *applied* amount — the same value the combat resolution will restore,
// read from the single applied definition (`consumableHealAmount`/`consumableMpAmount`) so the dock
// label matches the actual heal even when the combat multiplier changes. Those fixed-amount kinds do
// not depend on the ally actor, so the summary passes none.
export function consumableSummary(def, quantity) {
  const base = {
    item_id: def.item_id,
    name: def.name,
    description: def.description,
    effect_kind: def.effect_kind,
    target_mode: consumableTargetMode(def.effect_kind),
    quantity
  };
  if (def.effect_kind === 'attack_single') return { ...base, element: def.element, power: def.power };
  if (def.effect_kind === 'attack_area') return { ...base, element: def.element, power: def.power, radius: def.radius };
  if (def.effect_kind === 'heal') return { ...base, heal_amount: consumableHealAmount(def) };
  if (def.effect_kind === 'mp_restore') return { ...base, mp_amount: consumableMpAmount(def) };
  if (def.effect_kind === 'revive') return { ...base, revive_hp_ratio: def.revive_hp_ratio };
  return base; // heal_full / mp_restore_full carry no extra tunables
}

// Owned-quantity map for the consumables view, read straight from player_inventory. A deliberately
// light read that avoids economy's full known-item load (which pulls in gathering / stage-flag
// definitions the combat view otherwise never needs). Absent inventory = own nothing — the same
// explicit "absent = empty" contract economy's fallbackInventory uses, not a masked default.
export async function playerInventoryQuantities(root) {
  const raw = await createStorageApi({ root }).readJsonIfExists('game_data/player_inventory.json');
  const quantities = new Map();
  for (const entry of Array.isArray(raw?.items) ? raw.items : []) {
    const itemId = entry?.item_id;
    const quantity = Math.floor(Number(entry?.quantity));
    if (typeof itemId === 'string' && itemId && Number.isInteger(quantity) && quantity > 0) {
      quantities.set(itemId, (quantities.get(itemId) ?? 0) + quantity);
    }
  }
  return quantities;
}

// The auction-catalog `dungeon_consumable` items projected into the same normalized consumable-definition
// shape as an alchemy `dungeon_consumable` (item_id / name / description / category / effect_kind + the
// kind's tunables). A treasure item's effect metadata (effect_kind / element / power / radius / …) is already
// validated by the auction catalog loader, so it maps straight through with `effect.category` dropped and the
// item `category` set to 'dungeon_consumable'. name/description reuse the auction inventory-definition
// projection — the exact values the economy already shows for these items — so the display fields have a
// single source of truth. A treasure consumable with no inventory definition throws (fail-fast), never a
// silently unnamed row. Selected by the `effect.category` predicate, so a newly authored auction dungeon
// consumable is picked up automatically (no item_id hardcode).
function auctionDungeonConsumableDefinitions(catalog) {
  const inventoryById = new Map(auctionInventoryItemDefinitions(catalog).map((definition) => [definition.item_id, definition]));
  return catalog.items
    .filter((item) => item.effect?.category === 'dungeon_consumable')
    .map((item) => {
      const inventoryDefinition = inventoryById.get(item.item_id);
      if (!inventoryDefinition) {
        throw new Error(`auction dungeon consumable is missing an inventory definition: ${item.item_id}`);
      }
      const { category: _effectCategory, ...effectFields } = item.effect;
      return {
        item_id: item.item_id,
        name: inventoryDefinition.name,
        description: inventoryDefinition.description,
        category: 'dungeon_consumable',
        ...effectFields
      };
    });
}

// The single merged source of every dungeon-consumable DEFINITION (not ownership-filtered): the alchemy
// catalog's `dungeon_consumable` items plus the auction catalog's `effect.category === 'dungeon_consumable'`
// treasure items, projected to one normalized shape. Both the usable-list view (loadRunConsumables) and every
// engine's use path resolve the used item from THIS list, so a listing↔use drift is structurally impossible.
// A missing catalog throws (fail-fast), never a silently empty list; an item_id shared across the two sources
// throws rather than silently shadowing one definition.
export async function loadDungeonConsumableDefinitions(root) {
  const [alchemy, auctionCatalog] = await Promise.all([
    loadAlchemyDefinitions({ root }),
    loadAuctionCatalog({ root })
  ]);
  const definitions = [
    ...alchemy.items.filter((item) => item.category === 'dungeon_consumable'),
    ...auctionDungeonConsumableDefinitions(auctionCatalog)
  ];
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition.item_id)) throw new Error(`duplicate dungeon consumable definition: ${definition.item_id}`);
    seen.add(definition.item_id);
  }
  return definitions;
}

// The usable consumables for a run/match view: every owned dungeon consumable (alchemy `dungeon_consumable`
// OR auction `effect.category === 'dungeon_consumable'`), enriched with its effect summary, item_id-sorted.
// Reads the single merged definition source (loadDungeonConsumableDefinitions) — the same source the use path
// resolves from — so the list and the use path can never disagree. A missing catalog throws (fail-fast).
export async function loadRunConsumables(root) {
  const [definitions, quantities] = await Promise.all([
    loadDungeonConsumableDefinitions(root),
    playerInventoryQuantities(root)
  ]);
  return definitions
    .filter((item) => (quantities.get(item.item_id) ?? 0) > 0)
    .map((item) => consumableSummary(item, quantities.get(item.item_id)))
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
}

// Deals a consumable's flat, deterministic damage to one target: exactly the item's own `power`,
// with no equipment/mastery/variance/elemental-advantage/defense modifier (装備・習熟の補正を受けない
// 固定値). The element only tints the reused {kind:'cast'} event so the frontend animates it like any
// other cast. A lethal hit routes through the supplied onDefeat, so a consumable kill is handled the
// same as any other kill (撃破手段で差をつけない).
export function applyConsumableAttack({ target, power, element, from, pushEvent, onDefeat }) {
  target.hp = Math.max(0, target.hp - power);
  pushEvent({ kind: 'cast', from, to: { x: target.x, y: target.y }, element, hit: true });
  if (target.hp <= 0) onDefeat(target);
}
