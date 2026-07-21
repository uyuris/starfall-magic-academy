// Strict loader for the standing alchemy recipe book (56 recipes / 56 crafted items).
//
// The data is a permanent catalog (no weekly offers): an `items` table of every craftable
// alchemy item and a `recipes` table that consumes dungeon materials to produce one item each.
// Each item carries the effect metadata that its category needs — gifts carry an affinity bonus,
// ally/self boosts carry a parameter-effect list, dungeon consumables carry an effect kind plus its
// tunables, products carry a sell price. Recipe costs reference the 24-entry dungeon material catalog
// (`material_<element>_t<tier>`); an E-series "任意系統 tN×M" cost is a single-element choice resolved
// at craft time. The loader rejects any catalog that is not exactly the 56 well-formed pairs.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions } from './parameters.mjs';
import { loadDungeonMaterialDefinitions, MATERIAL_TIERS } from './dungeonMaterialCatalog.mjs';

const ALCHEMY_DEFINITIONS_FILENAME = 'alchemy_recipes.json';
const ALCHEMY_ID_PATTERN = /^alchemy_[a-z0-9_]+$/;
const EXPECTED_RECIPE_COUNT = 56;

export const ALCHEMY_ITEM_CATEGORIES = Object.freeze(['gift', 'ally_boost', 'self_boost', 'dungeon_consumable', 'product']);
export const ALCHEMY_DUNGEON_EFFECT_KINDS = Object.freeze([
  'attack_single', 'attack_area', 'heal', 'heal_full', 'mp_restore', 'mp_restore_full', 'revive'
]);

const PARAMETER_KEYS_BY_GROUP = Object.freeze({
  magic: new Set(magicParameterDefinitions.map((definition) => definition.key)),
  abilities: new Set(abilityParameterDefinitions.map((definition) => definition.key))
});
// Attack consumables are bound to a magic element (the dungeon material catalog's element vocabulary).
const MATERIAL_ELEMENTS = new Set(magicParameterDefinitions.map((definition) => definition.key));

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

function normalizeParameterEffects(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((entry, index) => {
    const effect = requiredObject(entry, `${label}[${index}]`);
    assertExactKeys(effect, ['group', 'key', 'amount'], `${label}[${index}]`);
    const group = requiredString(effect.group, `${label}[${index}].group`);
    if (!PARAMETER_KEYS_BY_GROUP[group]) throw new Error(`${label}[${index}].group must be one of: magic, abilities`);
    const key = requiredString(effect.key, `${label}[${index}].key`);
    if (!PARAMETER_KEYS_BY_GROUP[group].has(key)) throw new Error(`${label}[${index}] unknown ${group} parameter key: ${key}`);
    return { group, key, amount: positiveInteger(effect.amount, `${label}[${index}].amount`) };
  });
}

function normalizeDungeonEffect(item, label) {
  const effectKind = requiredString(item.effect_kind, `${label}.effect_kind`);
  if (!ALCHEMY_DUNGEON_EFFECT_KINDS.includes(effectKind)) {
    throw new Error(`${label}.effect_kind must be one of: ${ALCHEMY_DUNGEON_EFFECT_KINDS.join(', ')}`);
  }
  const base = ['item_id', 'name', 'description', 'category', 'effect_kind'];
  if (effectKind === 'attack_single') {
    assertExactKeys(item, [...base, 'element', 'power'], label);
    const element = requiredString(item.element, `${label}.element`);
    if (!MATERIAL_ELEMENTS.has(element)) throw new Error(`${label}.element must be a magic element: ${element}`);
    return { effect_kind: effectKind, element, power: positiveInteger(item.power, `${label}.power`) };
  }
  if (effectKind === 'attack_area') {
    assertExactKeys(item, [...base, 'element', 'power', 'radius'], label);
    const element = requiredString(item.element, `${label}.element`);
    if (!MATERIAL_ELEMENTS.has(element)) throw new Error(`${label}.element must be a magic element: ${element}`);
    return {
      effect_kind: effectKind,
      element,
      power: positiveInteger(item.power, `${label}.power`),
      radius: positiveInteger(item.radius, `${label}.radius`)
    };
  }
  if (effectKind === 'heal') {
    assertExactKeys(item, [...base, 'heal_amount'], label);
    return { effect_kind: effectKind, heal_amount: positiveInteger(item.heal_amount, `${label}.heal_amount`) };
  }
  if (effectKind === 'mp_restore') {
    assertExactKeys(item, [...base, 'mp_amount'], label);
    return { effect_kind: effectKind, mp_amount: positiveInteger(item.mp_amount, `${label}.mp_amount`) };
  }
  if (effectKind === 'revive') {
    assertExactKeys(item, [...base, 'revive_hp_ratio'], label);
    const ratio = item.revive_hp_ratio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      throw new Error(`${label}.revive_hp_ratio must be a number in (0, 1]`);
    }
    return { effect_kind: effectKind, revive_hp_ratio: ratio };
  }
  // heal_full / mp_restore_full carry no tunables beyond the kind.
  assertExactKeys(item, base, label);
  return { effect_kind: effectKind };
}

function normalizeItem(rawItem, index) {
  const item = requiredObject(rawItem, `alchemy items[${index}]`);
  const itemId = requiredString(item.item_id, `alchemy items[${index}].item_id`);
  if (!ALCHEMY_ID_PATTERN.test(itemId)) throw new Error(`alchemy item_id must match ${ALCHEMY_ID_PATTERN}: ${itemId}`);
  const label = `alchemy item ${itemId}`;
  const category = requiredString(item.category, `${label}.category`);
  if (!ALCHEMY_ITEM_CATEGORIES.includes(category)) {
    throw new Error(`${label}.category must be one of: ${ALCHEMY_ITEM_CATEGORIES.join(', ')}`);
  }
  const common = {
    item_id: itemId,
    name: requiredString(item.name, `${label}.name`),
    description: requiredString(item.description, `${label}.description`),
    category
  };
  if (category === 'gift') {
    assertExactKeys(item, ['item_id', 'name', 'description', 'category', 'affinity_bonus'], label);
    return { ...common, affinity_bonus: positiveInteger(item.affinity_bonus, `${label}.affinity_bonus`) };
  }
  if (category === 'ally_boost' || category === 'self_boost') {
    assertExactKeys(item, ['item_id', 'name', 'description', 'category', 'parameter_effects'], label);
    return { ...common, parameter_effects: normalizeParameterEffects(item.parameter_effects, `${label}.parameter_effects`) };
  }
  if (category === 'product') {
    assertExactKeys(item, ['item_id', 'name', 'description', 'category', 'sell_price'], label);
    return { ...common, sell_price: positiveInteger(item.sell_price, `${label}.sell_price`) };
  }
  return { ...common, ...normalizeDungeonEffect(item, label) };
}

function normalizeMaterialCosts(rawCosts, recipeId, materialItemIds) {
  if (!Array.isArray(rawCosts) || rawCosts.length === 0) {
    throw new Error(`${recipeId}.material_costs must be a non-empty array`);
  }
  const seen = new Set();
  return rawCosts.map((cost, index) => {
    const value = requiredObject(cost, `${recipeId}.material_costs[${index}]`);
    assertExactKeys(value, ['item_id', 'quantity'], `${recipeId}.material_costs[${index}]`);
    const itemId = requiredString(value.item_id, `${recipeId}.material_costs[${index}].item_id`);
    if (!materialItemIds.has(itemId)) throw new Error(`unknown alchemy material cost item_id: ${itemId}`);
    if (seen.has(itemId)) throw new Error(`duplicate alchemy material cost item_id in ${recipeId}: ${itemId}`);
    seen.add(itemId);
    return { item_id: itemId, quantity: positiveInteger(value.quantity, `${recipeId}.material_costs[${index}].quantity`) };
  });
}

function normalizeMaterialChoiceCost(rawChoice, recipeId) {
  const value = requiredObject(rawChoice, `${recipeId}.material_choice_cost`);
  assertExactKeys(value, ['tier', 'quantity'], `${recipeId}.material_choice_cost`);
  const tier = value.tier;
  if (!MATERIAL_TIERS.includes(tier)) throw new Error(`${recipeId}.material_choice_cost.tier must be one of: ${MATERIAL_TIERS.join(', ')}`);
  return { tier, quantity: positiveInteger(value.quantity, `${recipeId}.material_choice_cost.quantity`) };
}

// A recipe carries exactly one cost mode: fixed `material_costs`, or a single-element `material_choice_cost`.
// Both share `money_cost`. Mixing the two, or omitting both, is malformed.
function normalizeRecipe(rawRecipe, index, { itemById, materialItemIds }) {
  const recipe = requiredObject(rawRecipe, `alchemy recipes[${index}]`);
  const recipeId = requiredString(recipe.recipe_id, `alchemy recipes[${index}].recipe_id`);
  if (!ALCHEMY_ID_PATTERN.test(recipeId)) throw new Error(`alchemy recipe_id must match ${ALCHEMY_ID_PATTERN}: ${recipeId}`);
  const resultItem = requiredString(recipe.result_item, `${recipeId}.result_item`);
  if (!itemById.has(resultItem)) throw new Error(`unknown alchemy result_item: ${resultItem}`);
  const hasFixed = Object.prototype.hasOwnProperty.call(recipe, 'material_costs');
  const hasChoice = Object.prototype.hasOwnProperty.call(recipe, 'material_choice_cost');
  if (hasFixed === hasChoice) {
    throw new Error(`${recipeId} must carry exactly one of material_costs or material_choice_cost`);
  }
  if (hasFixed) {
    assertExactKeys(recipe, ['recipe_id', 'result_item', 'material_costs', 'money_cost'], `alchemy recipe ${recipeId}`);
  } else {
    assertExactKeys(recipe, ['recipe_id', 'result_item', 'material_choice_cost', 'money_cost'], `alchemy recipe ${recipeId}`);
  }
  return {
    recipe_id: recipeId,
    result_item: resultItem,
    money_cost: nonNegativeInteger(recipe.money_cost, `${recipeId}.money_cost`),
    ...(hasFixed
      ? { material_costs: normalizeMaterialCosts(recipe.material_costs, recipeId, materialItemIds) }
      : { material_choice_cost: normalizeMaterialChoiceCost(recipe.material_choice_cost, recipeId) })
  };
}

export async function validateAlchemyDefinitions(value, { root } = {}) {
  if (!root) throw new Error('root is required');
  const raw = requiredObject(value, 'alchemy definitions');
  if (!Array.isArray(raw.items)) throw new Error('alchemy items must be an array');
  if (!Array.isArray(raw.recipes)) throw new Error('alchemy recipes must be an array');
  if (raw.recipes.length !== EXPECTED_RECIPE_COUNT) {
    throw new Error(`alchemy recipes must contain exactly ${EXPECTED_RECIPE_COUNT} entries`);
  }
  if (raw.items.length !== EXPECTED_RECIPE_COUNT) {
    throw new Error(`alchemy items must contain exactly ${EXPECTED_RECIPE_COUNT} entries`);
  }

  const items = raw.items.map(normalizeItem);
  const itemById = new Map();
  for (const item of items) {
    if (itemById.has(item.item_id)) throw new Error(`duplicate alchemy item_id: ${item.item_id}`);
    itemById.set(item.item_id, item);
  }

  const materialItemIds = new Set((await loadDungeonMaterialDefinitions({ root })).map((material) => material.item_id));

  const recipeIds = new Set();
  const producedItemIds = new Set();
  const recipes = raw.recipes.map((recipe, index) => {
    const normalized = normalizeRecipe(recipe, index, { itemById, materialItemIds });
    if (recipeIds.has(normalized.recipe_id)) throw new Error(`duplicate alchemy recipe_id: ${normalized.recipe_id}`);
    recipeIds.add(normalized.recipe_id);
    if (producedItemIds.has(normalized.result_item)) throw new Error(`alchemy result_item is produced by more than one recipe: ${normalized.result_item}`);
    producedItemIds.add(normalized.result_item);
    return normalized;
  });
  for (const item of items) {
    if (!producedItemIds.has(item.item_id)) throw new Error(`alchemy item is not produced by any recipe: ${item.item_id}`);
  }
  return { items, recipes };
}

export async function loadAlchemyDefinitions({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const definitionsPath = path.join(storage.paths.definitionsRoot, ALCHEMY_DEFINITIONS_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(definitionsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`alchemy definitions file is missing: ${definitionsPath}`);
    throw error;
  }
  return await validateAlchemyDefinitions(JSON.parse(raw), { root });
}
