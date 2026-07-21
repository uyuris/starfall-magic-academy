// 星の揺り籠 (star cradle) stateful operations: the transactional layer between the HTTP surface and the pure
// domain logic. Each operation loads the surface(s), derives the current truth, mutates, and — where inventory
// is involved — binds the surface write and the inventory write into the ONE atomic economy transaction
// (consumeInventoryItems' beforeWrite / rollback seam), so a failed inventory write never leaves a half-planted
// pot or an un-granted harvest. Growth/reveal are pure reads; only the player actions here ever write.

import { MATERIAL_ELEMENTS } from './dungeonMaterialCatalog.mjs';
import { consumeInventoryItems } from './economy.mjs';
import {
  loadStarCradleSurface,
  writeStarCradleSurface,
  loadStarCradleCreaturesSurface,
  writeStarCradleCreaturesSurface,
  firstFreeSlot
} from './starCradleSurface.mjs';
import {
  plantView,
  creatureView,
  plantHarvestRewards,
  creatureByproductRewards,
  resolveCreatureIdentity,
  releasedPlantedWeek,
  validateStarCradleName
} from './starCradle.mjs';

const MATERIAL_ID_PATTERN = new RegExp(`^material_(${MATERIAL_ELEMENTS.join('|')})_t([1-4])$`);

function statusError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

// A fresh individual seed captured once at planting: a positive 31-bit integer. The entropy source is injected
// (the API passes Math.random; tests pass a deterministic source) so the roll is unpredictable to the player yet
// reproducible in tests — after this the seed is stored and everything derives from it.
function makeIndividualSeed(random) {
  return Math.floor(random() * 2147483646) + 1;
}

function findRecord(records, slotIndex, label) {
  const record = records.find((entry) => entry.slot_index === slotIndex);
  if (!record) throw statusError(`no star cradle ${label} at slot ${slotIndex}`, 404, 'STAR_CRADLE_SLOT_EMPTY');
  return record;
}

// The caged creature's display view: its resolved variety and second form (derived from the preserved seed/feed).
function cagedView(catalog, instance) {
  const { variety, mutation } = resolveCreatureIdentity(catalog, instance);
  const seedItem = catalog.seedItemsById.get(instance.item_id);
  return {
    instance_id: instance.instance_id,
    name: instance.name,
    seed_item: { item_id: instance.item_id, name: seedItem.name },
    variety: { id: variety.id, name: variety.name, element: variety.element, flavor: variety.flavor },
    mutation: mutation ? { id: mutation.id, name: mutation.name } : null,
    caged_week: instance.caged_week
  };
}

// The whole garden view: pots, creatures, caged items, and the free-slot counts.
export async function buildStarCradleView({ storage, catalog, currentWeek }) {
  const [surface, cagedSurface] = await Promise.all([
    loadStarCradleSurface({ storage }),
    loadStarCradleCreaturesSurface({ storage })
  ]);
  const potSlots = catalog.tuning.pot_slots;
  const creatureSlots = catalog.tuning.creature_slots;
  return {
    pot_slots: potSlots,
    creature_slots: creatureSlots,
    free_pot_slots: potSlots - surface.pots.length,
    free_creature_slots: creatureSlots - surface.creatures.length,
    pots: surface.pots.map((record) => plantView(catalog, record, currentWeek)),
    creatures: surface.creatures.map((record) => creatureView(catalog, record, currentWeek)),
    caged: cagedSurface.instances.map((instance) => cagedView(catalog, instance))
  };
}

// Plants a seed / sets an egg: consumes one of the item from inventory and appends a fresh individual to the
// matching garden array. Fails fast on an unknown seed item, a full garden, or insufficient inventory (the
// consume transaction rolls the surface back if the inventory write fails).
export async function plantStarCradleSeed({ root, storage, catalog, itemId, currentWeek, random = Math.random }) {
  const seedItem = catalog.seedItemsById.get(itemId);
  if (!seedItem) throw statusError(`not a star cradle seed/egg item: ${itemId}`, 400, 'STAR_CRADLE_NOT_A_SEED');
  const surface = await loadStarCradleSurface({ storage });
  const isPlant = seedItem.kind === 'plant';
  const records = isPlant ? surface.pots : surface.creatures;
  const maxSlots = isPlant ? catalog.tuning.pot_slots : catalog.tuning.creature_slots;
  const slotIndex = firstFreeSlot(records, maxSlots);
  if (slotIndex === null) throw statusError(`the star cradle ${isPlant ? 'pots' : 'creature slots'} are full`, 409, 'STAR_CRADLE_FULL');

  const seed = makeIndividualSeed(random);
  const record = isPlant
    ? { slot_index: slotIndex, item_id: itemId, planted_week: currentWeek, seed, feed: {} }
    : { slot_index: slotIndex, item_id: itemId, planted_week: currentWeek, seed, feed: {}, name: null, last_byproduct_week: currentWeek };
  const nextSurface = isPlant
    ? { ...surface, pots: [...surface.pots, record] }
    : { ...surface, creatures: [...surface.creatures, record] };

  const result = await consumeInventoryItems({
    root,
    itemCosts: [{ item_id: itemId, quantity: 1 }],
    moneyCost: 0,
    rewards: [],
    beforeWrite: () => writeStarCradleSurface({ storage, surface: nextSurface }),
    rollbackBeforeWrite: () => writeStarCradleSurface({ storage, surface })
  });
  return { planted: { kind: seedItem.kind, slot_index: slotIndex }, inventory: result.inventory };
}

function materialElement(materialItemId) {
  const match = MATERIAL_ID_PATTERN.exec(materialItemId);
  if (!match) throw statusError(`not an attribute material: ${materialItemId}`, 400, 'STAR_CRADLE_NOT_A_MATERIAL');
  return match[1];
}

// Feeds one attribute material to a pre-reveal individual, biasing its outcome toward that element. Rejected once
// the individual has revealed (a bloomed plant / hatched creature no longer takes a bias). Consumes one material.
export async function feedStarCradleIndividual({ root, storage, catalog, kind, slotIndex, materialItemId, currentWeek }) {
  const element = materialElement(materialItemId);
  const surface = await loadStarCradleSurface({ storage });
  const isPlant = kind === 'plant';
  const records = isPlant ? surface.pots : surface.creatures;
  const record = findRecord(records, slotIndex, isPlant ? 'pot' : 'creature');
  const view = isPlant ? plantView(catalog, record, currentWeek) : creatureView(catalog, record, currentWeek);
  if (!view.feedable) throw statusError('this individual has already revealed and can no longer be fed', 409, 'STAR_CRADLE_NOT_FEEDABLE');

  const nextRecord = { ...record, feed: { ...record.feed, [element]: (record.feed[element] ?? 0) + 1 } };
  const nextRecords = records.map((entry) => (entry.slot_index === slotIndex ? nextRecord : entry));
  const nextSurface = isPlant ? { ...surface, pots: nextRecords } : { ...surface, creatures: nextRecords };

  const result = await consumeInventoryItems({
    root,
    itemCosts: [{ item_id: materialItemId, quantity: 1 }],
    moneyCost: 0,
    rewards: [],
    beforeWrite: () => writeStarCradleSurface({ storage, surface: nextSurface }),
    rollbackBeforeWrite: () => writeStarCradleSurface({ storage, surface })
  });
  const nextView = isPlant ? plantView(catalog, nextRecord, currentWeek) : creatureView(catalog, nextRecord, currentWeek);
  return { fed_element: element, individual: nextView, inventory: result.inventory };
}

// Harvests a bloomed plant: grants its materials (＋the occasional seed) additively and frees the pot. Rejected
// before bloom.
export async function harvestStarCradlePlant({ root, storage, catalog, slotIndex, currentWeek }) {
  const surface = await loadStarCradleSurface({ storage });
  const record = findRecord(surface.pots, slotIndex, 'pot');
  const view = plantView(catalog, record, currentWeek);
  if (!view.revealed) throw statusError('the plant has not bloomed yet', 409, 'STAR_CRADLE_NOT_HARVESTABLE');
  const rewards = plantHarvestRewards(catalog, record);
  const nextSurface = { ...surface, pots: surface.pots.filter((entry) => entry.slot_index !== slotIndex) };

  const result = await consumeInventoryItems({
    root,
    itemCosts: [],
    moneyCost: 0,
    rewards,
    beforeWrite: () => writeStarCradleSurface({ storage, surface: nextSurface }),
    rollbackBeforeWrite: () => writeStarCradleSurface({ storage, surface })
  });
  return { harvested: view.variety, golden: view.golden, rewards: result.granted_rewards, inventory: result.inventory };
}

// Claims all pending weekly byproducts of an adult resident creature (まとめ受け取り of several weeks), advancing
// its claim watermark to the current week. Rejected when the creature is not adult or nothing is due.
export async function claimStarCradleByproduct({ root, storage, catalog, slotIndex, currentWeek }) {
  const surface = await loadStarCradleSurface({ storage });
  const record = findRecord(surface.creatures, slotIndex, 'creature');
  const view = creatureView(catalog, record, currentWeek);
  if (!view.adult) throw statusError('the creature is not an adult resident yet', 409, 'STAR_CRADLE_NOT_ADULT');
  const { rewards, claimed_weeks } = creatureByproductRewards(catalog, record, currentWeek);
  if (claimed_weeks === 0) throw statusError('no byproducts are due this week', 409, 'STAR_CRADLE_NO_BYPRODUCT');
  const nextRecord = { ...record, last_byproduct_week: currentWeek };
  const nextSurface = { ...surface, creatures: surface.creatures.map((entry) => (entry.slot_index === slotIndex ? nextRecord : entry)) };

  const result = await consumeInventoryItems({
    root,
    itemCosts: [],
    moneyCost: 0,
    rewards,
    beforeWrite: () => writeStarCradleSurface({ storage, surface: nextSurface }),
    rollbackBeforeWrite: () => writeStarCradleSurface({ storage, surface })
  });
  return { claimed_weeks, rewards: result.granted_rewards, inventory: result.inventory };
}

// Names a creature (creatures only; plants show their variety name). Idempotent surface write, no inventory.
export async function nameStarCradleCreature({ storage, catalog, slotIndex, name, currentWeek }) {
  const surface = await loadStarCradleSurface({ storage });
  const record = findRecord(surface.creatures, slotIndex, 'creature');
  const validName = validateStarCradleName(name);
  const nextRecord = { ...record, name: validName };
  const nextSurface = { ...surface, creatures: surface.creatures.map((entry) => (entry.slot_index === slotIndex ? nextRecord : entry)) };
  await writeStarCradleSurface({ storage, surface: nextSurface });
  return { creature: creatureView(catalog, nextRecord, currentWeek) };
}

// Restores one surface after a two-surface move fails so no half-move persists.
async function restoreGarden(storage, surface) {
  await writeStarCradleSurface({ storage, surface });
}

// Puts an adult resident into a one-off cage item (preserving its seed / feed / name for a lossless round-trip),
// freeing its garden slot. The garden write lands first; if the caged-surface write fails the garden is restored.
export async function cageStarCradleCreature({ storage, catalog, slotIndex, currentWeek }) {
  const [surface, cagedSurface] = await Promise.all([
    loadStarCradleSurface({ storage }),
    loadStarCradleCreaturesSurface({ storage })
  ]);
  const record = findRecord(surface.creatures, slotIndex, 'creature');
  const view = creatureView(catalog, record, currentWeek);
  if (!view.adult) throw statusError('only an adult creature can be caged', 409, 'STAR_CRADLE_NOT_ADULT');
  const instance = {
    instance_id: `sc_creature_${record.seed}`,
    item_id: record.item_id,
    seed: record.seed,
    feed: record.feed,
    name: record.name,
    caged_week: currentWeek
  };
  const nextSurface = { ...surface, creatures: surface.creatures.filter((entry) => entry.slot_index !== slotIndex) };
  const nextCaged = { ...cagedSurface, instances: [...cagedSurface.instances, instance] };
  await writeStarCradleSurface({ storage, surface: nextSurface });
  try {
    await writeStarCradleCreaturesSurface({ storage, surface: nextCaged });
  } catch (error) {
    await restoreGarden(storage, surface);
    throw error;
  }
  return { caged: cagedView(catalog, instance) };
}

// Releases a caged creature back into the garden at adulthood (the round-trip reproduces the exact same
// creature). Fails fast with zero consumption when the creature slots are full or the instance is unknown.
export async function releaseStarCradleCreature({ storage, catalog, instanceId, currentWeek }) {
  const [surface, cagedSurface] = await Promise.all([
    loadStarCradleSurface({ storage }),
    loadStarCradleCreaturesSurface({ storage })
  ]);
  const instance = cagedSurface.instances.find((entry) => entry.instance_id === instanceId);
  if (!instance) throw statusError(`no caged creature: ${instanceId}`, 404, 'STAR_CRADLE_NO_CAGED');
  const slotIndex = firstFreeSlot(surface.creatures, catalog.tuning.creature_slots);
  if (slotIndex === null) throw statusError('the star cradle creature slots are full', 409, 'STAR_CRADLE_FULL');
  const plantedWeek = releasedPlantedWeek(catalog, instance, currentWeek);
  if (plantedWeek < 0) throw statusError('caged creature has an inconsistent age', 409, 'STAR_CRADLE_CORRUPT_AGE');
  const record = {
    slot_index: slotIndex,
    item_id: instance.item_id,
    planted_week: plantedWeek,
    seed: instance.seed,
    feed: instance.feed,
    name: instance.name,
    last_byproduct_week: currentWeek
  };
  const nextSurface = { ...surface, creatures: [...surface.creatures, record] };
  const nextCaged = { ...cagedSurface, instances: cagedSurface.instances.filter((entry) => entry.instance_id !== instanceId) };
  await writeStarCradleSurface({ storage, surface: nextSurface });
  try {
    await writeStarCradleCreaturesSurface({ storage, surface: nextCaged });
  } catch (error) {
    await restoreGarden(storage, surface);
    throw error;
  }
  return { released: creatureView(catalog, record, currentWeek) };
}
