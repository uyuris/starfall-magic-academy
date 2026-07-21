// Alchemy: the routing "調合" destination as a standing recipe book (stay-and-craft, 工房と同文法).
//
// This module owns the arrival "book view" (the full 56-recipe catalog priced against the save's
// inventory) and the craft-execution orchestration (atomic material spend → crafted item grant →
// per-craft content result). There are no weekly offers: every recipe is always visible and the
// player crafts as many as they can afford in one visit. Catalog registration (routingDestinations)
// and dispatch mapping (routingDispatch → academy-alchemy) live in those shared modules.

import { createStorageApi } from './storage.mjs';
import { consumeInventoryItems } from './economy.mjs';
import { loadAlchemyDefinitions, validateAlchemyDefinitions } from './alchemyDefinitions.mjs';
import { loadDungeonMaterialDefinitions } from './dungeonMaterialCatalog.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions } from './parameters.mjs';
import { buildAlchemyContentResult, requireRoutingContentWeek } from './routingContentResult.mjs';

export { loadAlchemyDefinitions, validateAlchemyDefinitions };

const PARAMETER_LABELS_BY_GROUP = Object.freeze({
  magic: new Map(magicParameterDefinitions.map((definition) => [definition.key, definition.label])),
  abilities: new Map(abilityParameterDefinitions.map((definition) => [definition.key, definition.label]))
});
const MATERIAL_ELEMENTS = Object.freeze(magicParameterDefinitions.map((definition) => definition.key));

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function clientError(message, errorCode) {
  const error = new Error(message);
  error.statusCode = 400;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function parameterLabel(group, key) {
  const label = PARAMETER_LABELS_BY_GROUP[group]?.get(key);
  if (!label) throw new Error(`unknown alchemy parameter ${group}.${key}`);
  return label;
}

function itemQuantity(inventory, itemId) {
  return inventory.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
}

// A short human-readable effect summary per category, for the book row + the frontend.
function effectSummary(item) {
  if (item.category === 'gift') return `好感度 +${item.affinity_bonus}`;
  if (item.category === 'ally_boost') {
    return `仲間の${item.parameter_effects.map((effect) => `${parameterLabel(effect.group, effect.key)} +${effect.amount}`).join('、')}`;
  }
  if (item.category === 'self_boost') {
    return item.parameter_effects.map((effect) => `${parameterLabel(effect.group, effect.key)} +${effect.amount}`).join('、');
  }
  if (item.category === 'product') return `売値 ${item.sell_price}G`;
  switch (item.effect_kind) {
    case 'attack_single': return '敵単体に大ダメージ';
    case 'attack_area': return `敵範囲に大ダメージ（半径${item.radius}）`;
    case 'heal': return `HP回復 +${item.heal_amount}`;
    case 'heal_full': return 'HP全快';
    case 'mp_restore': return `MP回復 +${item.mp_amount}`;
    case 'mp_restore_full': return 'MP全快';
    case 'revive': return '倒れた同行者を蘇生';
    default: throw new Error(`unknown alchemy dungeon effect_kind: ${item.effect_kind}`);
  }
}

function materialDisplayName(materialNameById, itemId) {
  const name = materialNameById.get(itemId);
  if (!name) throw new Error(`unknown alchemy material item_id: ${itemId}`);
  return name;
}

function decorateFixedCosts(recipe, { inventory, materialNameById }) {
  const items = recipe.material_costs.map((cost) => ({
    item_id: cost.item_id,
    display_name: materialDisplayName(materialNameById, cost.item_id),
    required: cost.quantity,
    held: itemQuantity(inventory, cost.item_id)
  }));
  const money = { required: recipe.money_cost, held: inventory.money };
  const affordable = money.held >= money.required && items.every((cost) => cost.held >= cost.required);
  return { costs: { items, money }, affordable };
}

// The E-series "任意系統 tN×M" cost: the player pays M of a single chosen element at tier N. The row exposes
// the 6 element materials at that tier with held counts (the picker options) and is affordable when at least
// one of them is held in sufficient quantity.
function decorateChoiceCosts(recipe, { inventory, materialNameById }) {
  const { tier, quantity } = recipe.material_choice_cost;
  const options = MATERIAL_ELEMENTS.map((element) => {
    const itemId = `material_${element}_t${tier}`;
    return {
      item_id: itemId,
      display_name: materialDisplayName(materialNameById, itemId),
      element,
      held: itemQuantity(inventory, itemId)
    };
  });
  const money = { required: recipe.money_cost, held: inventory.money };
  const affordable = money.held >= money.required && options.some((option) => option.held >= quantity);
  return { costs: { choice: { tier, quantity, options }, money }, affordable };
}

function decorateRecipe(recipe, { itemById, inventory, materialNameById }) {
  const item = itemById.get(recipe.result_item);
  const { costs, affordable } = recipe.material_choice_cost
    ? decorateChoiceCosts(recipe, { inventory, materialNameById })
    : decorateFixedCosts(recipe, { inventory, materialNameById });
  return {
    recipe_id: recipe.recipe_id,
    result: { ...item, effect_summary: effectSummary(item) },
    costs,
    affordable
  };
}

async function loadAlchemyContext({ root, storage }) {
  const api = storage ?? createStorageApi({ root });
  const [definitions, state, materials, rawInventory] = await Promise.all([
    loadAlchemyDefinitions({ root }),
    api.readJson('game_data/runtime_state.json'),
    loadDungeonMaterialDefinitions({ root }),
    api.readJsonIfExists('game_data/player_inventory.json')
  ]);
  const week = requireRoutingContentWeek(state);
  const materialNameById = new Map(materials.map((material) => [material.item_id, material.name]));
  const materialById = new Map(materials.map((material) => [material.item_id, material]));
  const itemById = new Map(definitions.items.map((item) => [item.item_id, item]));
  const inventory = {
    money: Math.max(0, Math.floor(Number(rawInventory?.money ?? 0))),
    items: Array.isArray(rawInventory?.items) ? rawInventory.items : []
  };
  return { definitions, week, materialNameById, materialById, itemById, inventory };
}

// The alchemy arrival "book view": the full recipe catalog priced against the save's current inventory.
export async function buildAlchemyBookView({ root, storage } = {}) {
  const ctx = await loadAlchemyContext({ root, storage });
  return {
    week: ctx.week,
    recipes: ctx.definitions.recipes.map((recipe) => decorateRecipe(recipe, {
      itemById: ctx.itemById,
      inventory: ctx.inventory,
      materialNameById: ctx.materialNameById
    }))
  };
}

// Resolves the player-supplied material choice for an E-series recipe into the concrete item cost. The
// supplied materials must combine to exactly one dungeon-material id (a single element) at the recipe's
// tier, totaling the required quantity. Fails fast (400) before any consume.
function resolveChoiceCost(recipe, materials, materialById) {
  if (!Array.isArray(materials) || materials.length === 0) {
    throw clientError('this recipe requires a material choice', 'ALCHEMY_MATERIAL_CHOICE_REQUIRED');
  }
  const combined = new Map();
  for (const entry of materials) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw clientError('each alchemy material choice entry must be an object {item_id, quantity}', 'ALCHEMY_MATERIAL_CHOICE_INVALID');
    }
    const itemId = requiredString(entry.item_id, 'alchemy material choice item_id');
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw clientError(`alchemy material choice quantity must be a positive integer: ${entry.quantity}`, 'ALCHEMY_MATERIAL_CHOICE_INVALID');
    }
    combined.set(itemId, (combined.get(itemId) ?? 0) + quantity);
  }
  if (combined.size !== 1) {
    throw clientError('an alchemy material choice must be a single element (one material id)', 'ALCHEMY_MATERIAL_CHOICE_INVALID');
  }
  const [itemId, quantity] = [...combined.entries()][0];
  const material = materialById.get(itemId);
  if (!material) throw clientError(`unknown dungeon material for alchemy choice: ${itemId}`, 'ALCHEMY_MATERIAL_CHOICE_INVALID');
  if (material.tier !== recipe.material_choice_cost.tier) {
    throw clientError(`alchemy material choice must be tier ${recipe.material_choice_cost.tier}: ${itemId}`, 'ALCHEMY_MATERIAL_CHOICE_INVALID');
  }
  if (quantity !== recipe.material_choice_cost.quantity) {
    throw clientError(`alchemy material choice requires exactly ${recipe.material_choice_cost.quantity} materials; got ${quantity}`, 'ALCHEMY_MATERIAL_CHOICE_INVALID');
  }
  return [{ item_id: itemId, quantity }];
}

function unknownRecipeError(recipeId) {
  return clientError(`unknown alchemy recipe: ${recipeId}`, 'ALCHEMY_RECIPE_NOT_FOUND');
}

// Crafts one item from a recipe: resolves the item cost (fixed, or the player's single-element choice),
// atomically consumes materials + money and grants the crafted item, and builds the per-craft content
// result. `now` is validated up front so a missing timestamp fails fast before any consume.
export async function craftAlchemyRecipe({ root, storage, recipe_id, materials = null, now } = {}) {
  if (!root) throw new Error('root is required');
  if (typeof now !== 'string' || !now) throw new Error('alchemy craft requires a recorded_at timestamp');
  const recipeId = requiredString(recipe_id, 'recipe_id');
  const ctx = await loadAlchemyContext({ root, storage });
  const recipe = ctx.definitions.recipes.find((candidate) => candidate.recipe_id === recipeId);
  if (!recipe) throw unknownRecipeError(recipeId);
  const item = ctx.itemById.get(recipe.result_item);

  let itemCosts;
  if (recipe.material_choice_cost) {
    itemCosts = resolveChoiceCost(recipe, materials, ctx.materialById);
  } else {
    if (Array.isArray(materials) && materials.length > 0) {
      throw clientError('this recipe does not take a material choice', 'ALCHEMY_MATERIAL_CHOICE_UNEXPECTED');
    }
    itemCosts = recipe.material_costs;
  }

  const transaction = await consumeInventoryItems({
    root,
    itemCosts,
    moneyCost: recipe.money_cost,
    rewards: [{ item_id: item.item_id, quantity: 1 }]
  });

  const contentResult = buildAlchemyContentResult({
    week: ctx.week,
    now,
    recipeId: recipe.recipe_id,
    itemId: item.item_id,
    name: item.name,
    category: item.category,
    quantity: 1
  });

  return {
    week: ctx.week,
    recipe_id: recipe.recipe_id,
    crafted_item: { ...item, effect_summary: effectSummary(item), quantity: 1 },
    consumed_costs: { item_costs: transaction.item_costs, money_cost: transaction.money_cost },
    content_result: contentResult,
    inventory: transaction.inventory
  };
}
