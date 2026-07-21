// Pure, DOM-independent alchemy book contract checks, shared by app.js and headless unit tests so the
// fail-fast paths — malformed GET /api/alchemy book payloads, the per-recipe field validation, the material /
// choice cost normalization, and POST /api/alchemy/craft response validation against the selected recipe — are
// verifiable without a browser (the same headless-testable seam as workshopArrivalClient.js).
//
// Alchemy is a STANDING RECIPE BOOK, stay-and-craft destination (工房と同文法) with NO cost guarantee: every
// recipe may be unaffordable, so there is deliberately no "at least one affordable" invariant here (the arrival
// instead carries a server-authoritative exit so the screen never dead-ends). The whole 56-recipe catalog is
// always visible; the player crafts as many as they can afford in one visit, and each craft re-prices the board.

// The full standing catalog is 56 recipes (each producing one of 56 items). A GET /api/alchemy payload that is
// not exactly this many recipes is a broken catalog / data desync → fail-fast (never a half catalog).
export const ALCHEMY_RECIPE_COUNT = 56;

// The frozen item-category vocabulary, mirroring the backend (app/src/alchemyDefinitions.mjs
// ALCHEMY_ITEM_CATEGORIES). A recipe result carrying any other category is malformed → fail-fast.
export const ALCHEMY_ITEM_CATEGORIES = Object.freeze(['gift', 'ally_boost', 'self_boost', 'dungeon_consumable', 'product']);

// The 分類 label + scan order for the board's category filter chips and the stable row sort. Covers exactly the
// frozen category set (asserted at load below), so a future category addition fails fast here instead of
// rendering a silently mislabeled row.
export const ALCHEMY_CATEGORY_ORDER = Object.freeze(['gift', 'ally_boost', 'self_boost', 'dungeon_consumable', 'product']);
export const ALCHEMY_CATEGORY_LABELS = Object.freeze({
  gift: '贈り物',
  ally_boost: '仲間強化',
  self_boost: '自分用強化',
  dungeon_consumable: 'ダンジョン消耗品',
  product: '換金品'
});

function assertLabelsCover(labels, keys, what) {
  const labelKeys = Object.keys(labels).sort();
  const canonical = [...keys].sort();
  const matches = labelKeys.length === canonical.length && labelKeys.every((key, index) => key === canonical[index]);
  if (!matches) throw new Error(`alchemy ${what} labels must cover exactly {${canonical.join(', ')}}: got {${labelKeys.join(', ')}}`);
}

assertLabelsCover(ALCHEMY_CATEGORY_LABELS, ALCHEMY_ITEM_CATEGORIES, 'category');

// A closed-vocabulary category label lookup that fail-fasts on an unknown key (no silent `?? key` fallback — a
// value outside the frozen vocabulary is a contract violation, not something to render raw).
export function alchemyCategoryLabel(category) {
  if (!Object.prototype.hasOwnProperty.call(ALCHEMY_CATEGORY_LABELS, category)) {
    throw new Error(`alchemy category is not a known value: ${JSON.stringify(category)}`);
  }
  return ALCHEMY_CATEGORY_LABELS[category];
}

export function assertAlchemyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`alchemy: ${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

// Non-negative finite number (money required/held, item held). `positive:true` additionally rejects 0 (a material
// cost row with 0 required is malformed — a zero-cost row is omitted rather than carried as a 0 one).
export function assertAlchemyNumber(value, label, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error(`alchemy: ${label} must be a ${positive ? 'positive' : 'non-negative'} finite number (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function assertAlchemyInteger(value, label, { min = null, max = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || (min !== null && value < min) || (max !== null && value > max)) {
    const range = min !== null && max !== null ? ` in ${min}..${max}` : '';
    throw new Error(`alchemy: ${label} must be an integer${range} (got ${JSON.stringify(value)})`);
  }
  return value;
}

// Validate + normalize the recipe result (the crafted item's identity + display). The backend attaches a human
// `effect_summary` per category (routingAlchemy.effectSummary), so the frontend never re-derives the effect from
// the category-specific tunables — it renders name / description / category / effect_summary. A missing/unknown
// category or an empty display field is malformed → throw (no fabricated label / summary).
export function validateAlchemyResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`alchemy: result must be an object (got ${JSON.stringify(result)})`);
  }
  const category = assertAlchemyString(result.category, 'result.category');
  if (!ALCHEMY_ITEM_CATEGORIES.includes(category)) {
    throw new Error(`alchemy: result.category must be one of ${ALCHEMY_ITEM_CATEGORIES.join('/')} (got ${JSON.stringify(category)})`);
  }
  return {
    item_id: assertAlchemyString(result.item_id, 'result.item_id'),
    name: assertAlchemyString(result.name, 'result.name'),
    description: assertAlchemyString(result.description, 'result.description'),
    category,
    effect_summary: assertAlchemyString(result.effect_summary, 'result.effect_summary')
  };
}

// A material / money cost row → { item_id, display_name, required, held, short }. `short` is held < required (the
// 不足 affordance). Every field is validated fail-fast (no silent placeholder).
function validateCostRow(cost) {
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) {
    throw new Error(`alchemy: cost row must be an object (got ${JSON.stringify(cost)})`);
  }
  const required = assertAlchemyNumber(cost.required, 'costs.items[].required', { positive: true });
  const held = assertAlchemyNumber(cost.held, 'costs.items[].held');
  return {
    item_id: assertAlchemyString(cost.item_id, 'costs.items[].item_id'),
    display_name: assertAlchemyString(cost.display_name, 'costs.items[].display_name'),
    required,
    held,
    short: held < required
  };
}

// A single choice option (one element's material at the recipe tier) → { item_id, display_name, element, held }.
function validateChoiceOption(option) {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new Error(`alchemy: choice option must be an object (got ${JSON.stringify(option)})`);
  }
  return {
    item_id: assertAlchemyString(option.item_id, 'costs.choice.options[].item_id'),
    display_name: assertAlchemyString(option.display_name, 'costs.choice.options[].display_name'),
    element: assertAlchemyString(option.element, 'costs.choice.options[].element'),
    held: assertAlchemyNumber(option.held, 'costs.choice.options[].held')
  };
}

// Validate + normalize a recipe's costs. A recipe carries EITHER a fixed material list (`costs.items`) OR a
// single-element choice cost (`costs.choice`), never both, plus a money cost (`costs.money`). The two cost modes
// are exclusive at the contract boundary — a payload with both, or neither, is malformed → throw. Each returned
// row carries its computed `short` flag; a choice option carries an `enough` flag (held >= quantity) so the
// picker can disable insufficient options.
export function validateAlchemyCosts(costs) {
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) {
    throw new Error(`alchemy: costs must be an object (got ${JSON.stringify(costs)})`);
  }
  const money = costs.money;
  if (!money || typeof money !== 'object' || Array.isArray(money)) {
    throw new Error(`alchemy: costs.money must be an object (got ${JSON.stringify(money)})`);
  }
  const moneyRequired = assertAlchemyNumber(money.required, 'costs.money.required');
  const moneyHeld = assertAlchemyNumber(money.held, 'costs.money.held');
  const normalizedMoney = { required: moneyRequired, held: moneyHeld, short: moneyHeld < moneyRequired };

  const hasItems = Object.prototype.hasOwnProperty.call(costs, 'items');
  const hasChoice = Object.prototype.hasOwnProperty.call(costs, 'choice');
  if (hasItems === hasChoice) {
    throw new Error(`alchemy: costs must carry exactly one of items / choice (got ${JSON.stringify({ items: hasItems, choice: hasChoice })})`);
  }
  if (hasItems) {
    if (!Array.isArray(costs.items)) throw new Error(`alchemy: costs.items must be an array (got ${JSON.stringify(costs.items)})`);
    return { mode: 'fixed', items: costs.items.map((cost) => validateCostRow(cost)), money: normalizedMoney };
  }
  const choice = costs.choice;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
    throw new Error(`alchemy: costs.choice must be an object (got ${JSON.stringify(choice)})`);
  }
  const tier = assertAlchemyInteger(choice.tier, 'costs.choice.tier', { min: 1, max: 4 });
  const quantity = assertAlchemyInteger(choice.quantity, 'costs.choice.quantity', { min: 1 });
  if (!Array.isArray(choice.options) || choice.options.length === 0) {
    throw new Error(`alchemy: costs.choice.options must be a non-empty array (got ${JSON.stringify(choice.options)})`);
  }
  const options = choice.options.map((option) => {
    const normalized = validateChoiceOption(option);
    return { ...normalized, enough: normalized.held >= quantity };
  });
  return { mode: 'choice', choice: { tier, quantity, options }, money: normalizedMoney };
}

// Validate + normalize one book recipe row → a render-ready shape (result decorated, costs normalized with
// short/enough flags, the board `category` derived from the result for filtering/sorting). Every required field
// is validated fail-fast (no silent placeholder), so the board never renders a recipe with a missing/mistyped
// field.
export function validateAlchemyRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new Error(`alchemy: malformed recipe ${JSON.stringify(recipe)}`);
  }
  const recipeId = assertAlchemyString(recipe.recipe_id, 'recipe_id');
  const result = validateAlchemyResult(recipe.result);
  const costs = validateAlchemyCosts(recipe.costs);
  if (typeof recipe.affordable !== 'boolean') {
    throw new Error(`alchemy: affordable must be a boolean (got ${JSON.stringify(recipe.affordable)})`);
  }
  return {
    recipe_id: recipeId,
    category: result.category,
    result,
    costs,
    affordable: recipe.affordable
  };
}

// Validate the whole GET /api/alchemy book payload and return the validated week + normalized recipes + the
// server-authoritative exit. Fail-fast on a non-object response, a missing/invalid week (a non-negative integer
// elapsed_weeks — the header source), a set that is not exactly 56 recipes, any malformed recipe, or a
// missing/empty post_content_screen (the exit the stay-and-craft screen leaves through — alchemy has NO
// affordability guarantee, so the exit MUST be present rather than depending on an affordable recipe). There is
// deliberately NO "at least one affordable" invariant (every recipe may be unaffordable — a valid, if unlucky,
// visit — and the exit is how the player leaves).
export function validateAlchemyBookPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error(`alchemy book: malformed response ${JSON.stringify(payload)}`);
  if (typeof payload.week !== 'number' || !Number.isInteger(payload.week) || payload.week < 0) {
    throw new Error(`alchemy book: week must be a non-negative integer (got ${JSON.stringify(payload.week)})`);
  }
  const recipes = payload.recipes;
  if (!Array.isArray(recipes) || recipes.length !== ALCHEMY_RECIPE_COUNT) {
    throw new Error(`alchemy book: expected exactly ${ALCHEMY_RECIPE_COUNT} recipes, got ${Array.isArray(recipes) ? recipes.length : JSON.stringify(recipes)}`);
  }
  const postContentScreen = assertAlchemyString(payload.post_content_screen, 'post_content_screen');
  const normalized = recipes.map((recipe) => validateAlchemyRecipe(recipe));
  return { week: payload.week, recipes: normalized, postContentScreen };
}

// A stable sort of validated recipes into 分類 (category) order, preserving the authored order within a category
// (Array.prototype.sort is stable), so the board reads as one scannable, category-grouped list regardless of the
// payload's array order.
export function sortAlchemyRecipes(recipes) {
  const categoryRank = (recipe) => ALCHEMY_CATEGORY_ORDER.indexOf(recipe.category);
  return [...recipes].sort((a, b) => categoryRank(a) - categoryRank(b));
}

// The `materials` payload for a choice craft: the player picks one element option, and the backend expects
// exactly one dungeon-material id at the recipe's quantity ([{ item_id, quantity }]). A non-positive-integer
// quantity is malformed → throw (never send a 0 / fractional material choice).
export function buildAlchemyChoiceMaterials(itemId, quantity) {
  assertAlchemyString(itemId, 'material choice item_id');
  assertAlchemyInteger(quantity, 'material choice quantity', { min: 1 });
  return [{ item_id: itemId, quantity }];
}

// Validate + normalize the crafted item from a POST /api/alchemy/craft response → the result popup's display.
// The item's IDENTITY (item_id / category) is cross-checked against the selected recipe by resolveAlchemyCraft so
// the popup reflects the selection; the display fields (name / description / effect_summary / quantity) are read
// from the response (what the server actually crafted, not a blindly-trusted stale row).
function validateCraftedItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`alchemy craft: crafted_item must be an object (got ${JSON.stringify(item)})`);
  }
  const category = assertAlchemyString(item.category, 'crafted_item.category');
  if (!ALCHEMY_ITEM_CATEGORIES.includes(category)) {
    throw new Error(`alchemy craft: crafted_item.category must be one of ${ALCHEMY_ITEM_CATEGORIES.join('/')} (got ${JSON.stringify(category)})`);
  }
  return {
    item_id: assertAlchemyString(item.item_id, 'crafted_item.item_id'),
    name: assertAlchemyString(item.name, 'crafted_item.name'),
    description: assertAlchemyString(item.description, 'crafted_item.description'),
    category,
    effect_summary: assertAlchemyString(item.effect_summary, 'crafted_item.effect_summary'),
    quantity: assertAlchemyInteger(item.quantity, 'crafted_item.quantity', { min: 1 })
  };
}

// Validate the POST /api/alchemy/craft response against the SELECTED recipe and resolve what the result popup
// shows. The response ({ result, state, post_content_screen }) is authoritative for what the server actually
// crafted; the crafted item's identity is cross-checked FIELD BY FIELD against the selection so the popup can
// never present a divergent item:
//   - `result.recipe_id` must equal the clicked recipe's id (the server crafted the recipe the player selected);
//   - the crafted item's item_id / category must match the selected recipe's result.
// The display fields (name / description / effect_summary / quantity) come from the validated response. Alchemy is
// a STAY screen, so the returned state is adopted and the popup keeps the player in the lab; `post_content_screen`
// is carried only for the eventual explicit exit (validated non-empty). Any missing field or ANY identity
// divergence (recipe id / item id / category) is a contract violation → throw (no silent fallback to a stale
// display).
export function resolveAlchemyCraft(response, recipe) {
  if (!recipe || typeof recipe !== 'object' || typeof recipe.recipe_id !== 'string' || !recipe.result || typeof recipe.result !== 'object') {
    throw new Error(`alchemy craft: a validated selected recipe is required (got ${JSON.stringify(recipe)})`);
  }
  if (!response || typeof response !== 'object') throw new Error(`alchemy craft: malformed response ${JSON.stringify(response)}`);
  if (!response.result || typeof response.result !== 'object') throw new Error(`alchemy craft: response is missing the result (got ${JSON.stringify(response.result)})`);
  if (!response.state || typeof response.state !== 'object') throw new Error(`alchemy craft: response is missing state (got ${JSON.stringify(response.state)})`);
  const postContentScreen = assertAlchemyString(response.post_content_screen, 'post_content_screen');

  const craftedRecipeId = assertAlchemyString(response.result.recipe_id, 'result.recipe_id');
  if (craftedRecipeId !== recipe.recipe_id) {
    throw new Error(`alchemy craft: the crafted recipe ${JSON.stringify(craftedRecipeId)} does not match the selected recipe ${JSON.stringify(recipe.recipe_id)} (the server crafted a different recipe)`);
  }
  const item = validateCraftedItem(response.result.crafted_item);
  if (item.item_id !== recipe.result.item_id || item.category !== recipe.result.category) {
    throw new Error(`alchemy craft: crafted item (${JSON.stringify(item.item_id)} / ${JSON.stringify(item.category)}) does not match the selected recipe (${JSON.stringify(recipe.result.item_id)} / ${JSON.stringify(recipe.result.category)})`);
  }
  return {
    state: response.state,
    postContentScreen,
    display: {
      item_id: item.item_id,
      name: item.name,
      description: item.description,
      category: item.category,
      effect_summary: item.effect_summary,
      quantity: item.quantity
    }
  };
}
