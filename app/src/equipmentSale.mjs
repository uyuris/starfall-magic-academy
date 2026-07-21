// Selling a one-off equipment instance back for money. It sits on top of the equipment
// surface (equipment.mjs) and the inventory transaction (economy.mjs), the same way
// equipmentCraft.mjs sits on top of both to craft one.
//
// Design (shop-equipment-sell-backend):
//   - Price is a deterministic function of (tier, quality): the tier's craft money base
//     (MONEY_COST_BY_TIER, the single source, imported from equipmentCraft.mjs) times a
//     per-quality coefficient, ceiled to a positive integer. No env fallback, no second
//     copy of the base.
//   - A sale removes the instance from the surface AND credits the money in one atomic
//     transaction (economy.consumeInventoryItems' beforeWrite/rollback hooks), so a failed
//     write never leaves the instance gone without the money or the money paid without the
//     instance removed.
//   - An instance currently worn by any owner (the hero or a companion) cannot be sold: it
//     is rejected before any write. There is no silent auto-unequip. An unknown instance id
//     is likewise rejected before any write.

import { createStorageApi } from './storage.mjs';
import {
  EQUIPMENT_SLOTS,
  loadEquipmentSurface,
  findEquipmentInstance,
  writeEquipmentSurface,
  readAllEquipmentSlots,
  equipmentInstanceSummary
} from './equipment.mjs';
import { MONEY_COST_BY_TIER } from './equipmentCraft.mjs';
import { consumeInventoryItems } from './economy.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

// ----- price rule (deterministic, tunable, single definition) -----

// Sell price = the tier's craft money base (MONEY_COST_BY_TIER) times a per-quality
// coefficient, ceiled to a positive integer. Coefficients are held as exact fractions so
// the ceil is integer-exact regardless of how the tier bases are later tuned (a float 0.9
// makes e.g. 150 * 0.9 = 135.0000…2, whose naive ceil would wrongly be 136).
// Decimal coefficients: common 0.4, fine 0.6, excellent 0.9, masterwork 1.4.
const SELL_QUALITY_COEFFICIENT = {
  common: { numerator: 2, denominator: 5 },
  fine: { numerator: 3, denominator: 5 },
  excellent: { numerator: 9, denominator: 10 },
  masterwork: { numerator: 7, denominator: 5 }
};

// The deterministic sell price for an (tier, quality) pair. Unknown tier or quality fails
// fast — there is no fallback price.
export function equipmentSellPrice({ tier, quality }) {
  const base = MONEY_COST_BY_TIER[tier];
  if (base === undefined) throw new Error(`no sale price for equipment tier: ${tier}`);
  const coefficient = SELL_QUALITY_COEFFICIENT[quality];
  if (coefficient === undefined) throw new Error(`no sale price for equipment quality: ${quality}`);
  const { numerator, denominator } = coefficient;
  // Integer ceil of base * numerator / denominator.
  return Math.floor((base * numerator + denominator - 1) / denominator);
}

// ----- equipped set -----

// Every instance id worn by any owner (the hero plus every companion). Reuses the
// whole-picture read so the "is it equipped?" answer used to reject a sale matches the
// same-picture answer surfaced to the UI. readAllEquipmentSlots additionally rejects a
// persisted state that shares one instance across owners (corrupt state throws).
export function equippedInstanceIds(state) {
  const all = readAllEquipmentSlots(state);
  const ids = new Set();
  for (const slot of EQUIPMENT_SLOTS) {
    if (all.player[slot] !== null) ids.add(all.player[slot]);
  }
  for (const slots of Object.values(all.companions)) {
    for (const slot of EQUIPMENT_SLOTS) {
      if (slots[slot] !== null) ids.add(slots[slot]);
    }
  }
  return ids;
}

function requiredInstanceId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('equipment_instance_id_required');
  return value;
}

// ----- public atomic sale -----

// Sells one unequipped equipment instance: removes it from the surface and credits the
// deterministic sell price to the wallet in one atomic transaction. An unknown instance id
// (`unknown_equipment_instance`) or one currently worn by any owner
// (`equipment_instance_equipped`) is rejected before any write, so a rejected sale leaves
// the surface and the wallet untouched. The surface removal and the money credit are never
// partially applied: if the wallet write fails after the surface write, the surface is
// restored.
export async function sellEquipmentInstance({ root, storage, instance_id } = {}) {
  const api = storage ?? createStorageApi({ root });
  const instanceId = requiredInstanceId(instance_id);

  const surface = await loadEquipmentSurface({ storage: api });
  const instance = findEquipmentInstance(surface, instanceId);
  if (!instance) throw new Error('unknown_equipment_instance');

  const state = await api.readJson(RUNTIME_STATE_PATH);
  if (equippedInstanceIds(state).has(instanceId)) throw new Error('equipment_instance_equipped');

  const sellPrice = equipmentSellPrice(instance);

  let priorSurface = null;
  const transaction = await consumeInventoryItems({
    root: api.paths.projectRoot,
    itemCosts: [],
    moneyCost: 0,
    moneyReward: sellPrice,
    rewards: [],
    beforeWrite: async () => {
      priorSurface = surface;
      const next = { version: 1, instances: surface.instances.filter((candidate) => candidate.instance_id !== instanceId) };
      return await writeEquipmentSurface({ storage: api, surface: next });
    },
    rollbackBeforeWrite: async () => {
      await writeEquipmentSurface({ storage: api, surface: priorSurface });
    }
  });

  return {
    sold_instance: equipmentInstanceSummary(instance),
    sell_price: sellPrice,
    inventory: transaction.inventory
  };
}
