// 星の揺り籠 (star cradle) authored catalog: the seed/egg item types, the plant varieties, and the creature
// varieties, with the tunable growth/roll numbers. It is a read-only definitions file
// (`game_data/star_cradle_catalog.json`), loaded strict — a missing file, a malformed entry, an unknown
// element/rarity/kind/tier, or a dangling outcome-pool id fails fast rather than silently degrading.
//
// The catalog is the single source of truth for: which varieties each seed/egg can become (outcome_pool),
// each variety's element / rarity / harvest or byproduct, the reveal timing ranges (plant mature_weeks,
// creature hatch_weeks + per-variety grow_weeks), the plant golden-mutation and creature second-form rolls,
// and the seed/egg item definitions the inventory display enriches with.

import { createStorageApi } from './storage.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from './dungeonMaterialCatalog.mjs';

export const STAR_CRADLE_CATALOG_PATH = 'game_data/star_cradle_catalog.json';

export const STAR_CRADLE_KINDS = Object.freeze(['plant', 'creature']);
export const STAR_CRADLE_RARITIES = Object.freeze(['common', 'rare']);
// The plant/creature growth stage vocabularies (ordered). Identity is revealed at the reveal stage
// (plant 開花 / creature 幼体); a creature's second form is revealed at 成体.
export const PLANT_STAGES = Object.freeze(['芽', '若葉', '蕾', '開花']);
export const CREATURE_STAGES = Object.freeze(['卵', '幼体', '成体']);
// A harvest/byproduct material grant may target a concrete magic element or a seed-rolled random element.
export const RANDOM_ELEMENT = 'random';

const ELEMENT_SET = new Set(MATERIAL_ELEMENTS);
const TIER_SET = new Set(MATERIAL_TIERS);
const KIND_SET = new Set(STAR_CRADLE_KINDS);
const RARITY_SET = new Set(STAR_CRADLE_RARITIES);
const PLANT_ID_PATTERN = /^p\d{2}$/;
const CREATURE_ID_PATTERN = /^c\d{2}$/;
const SEED_ITEM_ID_PATTERN = /^star_cradle_[a-z_]+$/;

function fail(message) {
  throw new Error(`star cradle catalog: ${message}`);
}

function requiredObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer: ${value}`);
  return value;
}

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer: ${value}`);
  return value;
}

function chanceValue(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`${label} must be a number in [0,1]: ${value}`);
  return value;
}

function weekRange(value, label) {
  const range = requiredObject(value, label);
  const min = positiveInt(range.min, `${label}.min`);
  const max = positiveInt(range.max, `${label}.max`);
  if (max < min) fail(`${label}.max must be >= min: ${min}..${max}`);
  const extra = Object.keys(range).filter((key) => key !== 'min' && key !== 'max');
  if (extra.length) fail(`${label} has unexpected keys: ${extra.join(', ')}`);
  return { min, max };
}

function elementValue(value, label, { allowNull = false, allowRandom = false } = {}) {
  if (value === null) {
    if (allowNull) return null;
    fail(`${label} must not be null`);
  }
  if (allowRandom && value === RANDOM_ELEMENT) return RANDOM_ELEMENT;
  if (typeof value !== 'string' || !ELEMENT_SET.has(value)) {
    fail(`${label} must be one of ${MATERIAL_ELEMENTS.join('/')}${allowRandom ? `/${RANDOM_ELEMENT}` : ''}${allowNull ? '/null' : ''}: ${value}`);
  }
  return value;
}

function materialGrant(value, label) {
  const grant = requiredObject(value, label);
  const element = elementValue(grant.element, `${label}.element`, { allowRandom: true });
  const tier = grant.tier;
  if (!TIER_SET.has(tier)) fail(`${label}.tier must be one of ${MATERIAL_TIERS.join('/')}: ${tier}`);
  const result = { element, tier, quantity: positiveInt(grant.quantity, `${label}.quantity`) };
  const allowed = new Set(['element', 'tier', 'quantity']);
  if (grant.tier_max !== undefined) {
    if (!TIER_SET.has(grant.tier_max) || grant.tier_max < tier) fail(`${label}.tier_max must be a tier >= tier: ${grant.tier_max}`);
    result.tier_max = grant.tier_max;
    allowed.add('tier_max');
  }
  const extra = Object.keys(grant).filter((key) => !allowed.has(key));
  if (extra.length) fail(`${label} has unexpected keys: ${extra.join(', ')}`);
  return result;
}

function dropGrant(value, label, seedItemIds) {
  if (value === null) return null;
  const drop = requiredObject(value, label);
  const itemId = nonEmptyString(drop.item_id, `${label}.item_id`);
  if (seedItemIds && !seedItemIds.has(itemId)) fail(`${label}.item_id is not a seed/egg item: ${itemId}`);
  const result = {
    item_id: itemId,
    chance: chanceValue(drop.chance, `${label}.chance`),
    quantity: positiveInt(drop.quantity, `${label}.quantity`)
  };
  const allowed = new Set(['item_id', 'chance', 'quantity']);
  if (drop.quantity_max !== undefined) {
    result.quantity_max = positiveInt(drop.quantity_max, `${label}.quantity_max`);
    if (result.quantity_max < result.quantity) fail(`${label}.quantity_max must be >= quantity: ${result.quantity_max}`);
    allowed.add('quantity_max');
  }
  const extra = Object.keys(drop).filter((key) => !allowed.has(key));
  if (extra.length) fail(`${label} has unexpected keys: ${extra.join(', ')}`);
  return result;
}

function harvestOrByproduct(value, label, seedItemIds) {
  const block = requiredObject(value, label);
  if (!Array.isArray(block.materials)) fail(`${label}.materials must be an array`);
  const materials = block.materials.map((grant, index) => materialGrant(grant, `${label}.materials[${index}]`));
  const drop = dropGrant(block.drop ?? null, `${label}.drop`, seedItemIds);
  const extra = Object.keys(block).filter((key) => key !== 'materials' && key !== 'drop');
  if (extra.length) fail(`${label} has unexpected keys: ${extra.join(', ')}`);
  return { materials, drop };
}

function validateTuning(value) {
  const tuning = requiredObject(value, 'tuning');
  const result = {
    rarity_weights: {},
    feed_bias_per_unit: nonNegativeInt(tuning.feed_bias_per_unit, 'tuning.feed_bias_per_unit'),
    feed_bias_max_units: nonNegativeInt(tuning.feed_bias_max_units, 'tuning.feed_bias_max_units'),
    golden_mutation_chance: chanceValue(tuning.golden_mutation_chance, 'tuning.golden_mutation_chance'),
    golden_harvest_tier_bonus: nonNegativeInt(tuning.golden_harvest_tier_bonus, 'tuning.golden_harvest_tier_bonus'),
    pot_slots: positiveInt(tuning.pot_slots, 'tuning.pot_slots'),
    creature_slots: positiveInt(tuning.creature_slots, 'tuning.creature_slots')
  };
  const rarityWeights = requiredObject(tuning.rarity_weights, 'tuning.rarity_weights');
  for (const rarity of STAR_CRADLE_RARITIES) {
    result.rarity_weights[rarity] = positiveInt(rarityWeights[rarity], `tuning.rarity_weights.${rarity}`);
  }
  return result;
}

function validatePlant(value, label) {
  const plant = requiredObject(value, label);
  const id = nonEmptyString(plant.id, `${label}.id`);
  if (!PLANT_ID_PATTERN.test(id)) fail(`${label}.id must match p<NN>: ${id}`);
  if (!RARITY_SET.has(plant.rarity)) fail(`${label}.rarity must be one of ${STAR_CRADLE_RARITIES.join('/')}: ${plant.rarity}`);
  return {
    id,
    name: nonEmptyString(plant.name, `${label}.name`),
    element: elementValue(plant.element, `${label}.element`, { allowNull: true }),
    rarity: plant.rarity,
    flavor: nonEmptyString(plant.flavor, `${label}.flavor`),
    harvest: plant.harvest
  };
}

function validateMutation(value, label) {
  if (value === null) return null;
  const mutation = requiredObject(value, label);
  const result = {
    id: nonEmptyString(mutation.id, `${label}.id`),
    name: nonEmptyString(mutation.name, `${label}.name`),
    chance: chanceValue(mutation.chance, `${label}.chance`),
    byproduct_tier_bonus: nonNegativeInt(mutation.byproduct_tier_bonus, `${label}.byproduct_tier_bonus`)
  };
  const extra = Object.keys(mutation).filter((key) => !['id', 'name', 'chance', 'byproduct_tier_bonus'].includes(key));
  if (extra.length) fail(`${label} has unexpected keys: ${extra.join(', ')}`);
  return result;
}

function validateCreature(value, label) {
  const creature = requiredObject(value, label);
  const id = nonEmptyString(creature.id, `${label}.id`);
  if (!CREATURE_ID_PATTERN.test(id)) fail(`${label}.id must match c<NN>: ${id}`);
  if (!RARITY_SET.has(creature.rarity)) fail(`${label}.rarity must be one of ${STAR_CRADLE_RARITIES.join('/')}: ${creature.rarity}`);
  return {
    id,
    name: nonEmptyString(creature.name, `${label}.name`),
    element: elementValue(creature.element, `${label}.element`, { allowNull: true }),
    rarity: creature.rarity,
    flavor: nonEmptyString(creature.flavor, `${label}.flavor`),
    grow_weeks: weekRange(creature.grow_weeks, `${label}.grow_weeks`),
    mutation: validateMutation(creature.mutation ?? null, `${label}.mutation`),
    byproduct: creature.byproduct
  };
}

function validateSeedItem(value, label, plantIds, creatureIds) {
  const item = requiredObject(value, label);
  const itemId = nonEmptyString(item.item_id, `${label}.item_id`);
  if (!SEED_ITEM_ID_PATTERN.test(itemId)) fail(`${label}.item_id must match star_cradle_<name>: ${itemId}`);
  if (!KIND_SET.has(item.kind)) fail(`${label}.kind must be one of ${STAR_CRADLE_KINDS.join('/')}: ${item.kind}`);
  const timingKey = item.kind === 'plant' ? 'mature_weeks' : 'hatch_weeks';
  const timing = weekRange(item[timingKey], `${label}.${timingKey}`);
  if (!Array.isArray(item.outcome_pool) || item.outcome_pool.length === 0) fail(`${label}.outcome_pool must be a non-empty array`);
  const validIds = item.kind === 'plant' ? plantIds : creatureIds;
  for (const outcomeId of item.outcome_pool) {
    if (!validIds.has(outcomeId)) fail(`${label}.outcome_pool references an unknown ${item.kind} id: ${outcomeId}`);
  }
  return {
    item_id: itemId,
    name: nonEmptyString(item.name, `${label}.name`),
    description: nonEmptyString(item.description, `${label}.description`),
    kind: item.kind,
    buy_price: nonNegativeInt(item.buy_price, `${label}.buy_price`),
    sell_price: nonNegativeInt(item.sell_price, `${label}.sell_price`),
    reveal_weeks: timing,
    outcome_pool: [...item.outcome_pool]
  };
}

// Validates and indexes the whole catalog. All cross-references (outcome pool ids, drop item ids) are checked;
// anything malformed throws.
export function validateStarCradleCatalog(raw) {
  const catalog = requiredObject(raw, 'root');
  if (catalog.version !== 1) fail(`version must be 1: ${catalog.version}`);
  const tuning = validateTuning(catalog.tuning);

  if (!Array.isArray(catalog.plants)) fail('plants must be an array');
  if (!Array.isArray(catalog.creatures)) fail('creatures must be an array');
  if (!Array.isArray(catalog.seed_items)) fail('seed_items must be an array');

  const plants = catalog.plants.map((plant, index) => validatePlant(plant, `plants[${index}]`));
  const creatures = catalog.creatures.map((creature, index) => validateCreature(creature, `creatures[${index}]`));
  const plantIds = new Set();
  for (const plant of plants) { if (plantIds.has(plant.id)) fail(`duplicate plant id: ${plant.id}`); plantIds.add(plant.id); }
  const creatureIds = new Set();
  for (const creature of creatures) { if (creatureIds.has(creature.id)) fail(`duplicate creature id: ${creature.id}`); creatureIds.add(creature.id); }

  const seedItems = catalog.seed_items.map((item, index) => validateSeedItem(item, `seed_items[${index}]`, plantIds, creatureIds));
  const seedItemIds = new Set();
  for (const item of seedItems) { if (seedItemIds.has(item.item_id)) fail(`duplicate seed item id: ${item.item_id}`); seedItemIds.add(item.item_id); }

  // Second pass now that seed item ids are known: validate harvest/byproduct drop item ids against them.
  for (const plant of plants) plant.harvest = harvestOrByproduct(plant.harvest, `plants(${plant.id}).harvest`, seedItemIds);
  for (const creature of creatures) creature.byproduct = harvestOrByproduct(creature.byproduct, `creatures(${creature.id}).byproduct`, seedItemIds);

  return {
    version: 1,
    tuning,
    seedItems,
    plants,
    creatures,
    seedItemsById: new Map(seedItems.map((item) => [item.item_id, item])),
    plantsById: new Map(plants.map((plant) => [plant.id, plant])),
    creaturesById: new Map(creatures.map((creature) => [creature.id, creature]))
  };
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

// Loads the catalog strict. A missing file fails fast (it is authored content that must ship), unlike the
// player surfaces whose absence is a legitimate empty state.
export async function loadStarCradleCatalog({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(STAR_CRADLE_CATALOG_PATH);
  if (raw === null || raw === undefined) fail(`definitions file is missing: ${STAR_CRADLE_CATALOG_PATH}`);
  return validateStarCradleCatalog(raw);
}

