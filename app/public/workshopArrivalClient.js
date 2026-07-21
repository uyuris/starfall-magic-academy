// Pure, DOM-independent workshop arrival contract checks, shared by app.js and headless unit tests so the
// fail-fast paths — malformed GET /api/workshop payloads, the per-recipe field validation, the withheld-roll
// leak guard, and POST /api/workshop/craft response validation against the selected recipe — are verifiable
// without a browser (the same headless-testable seam as alchemyArrivalClient.js).
//
// Unlike the alchemy arrival, the workshop is a STAY-and-craft destination with NO cost guarantee: every recipe
// may be unaffordable, so there is deliberately no "at least one affordable" invariant here (the arrival instead
// carries a server-authoritative exit so the screen never dead-ends). Craft outputs the confirmed roll (quality /
// bonus_effects / name / flavor) only AFTER a craft; the arrival view withholds them, so a recipe that leaks any
// roll output is malformed → fail-fast (the outlook is a coarse skill forecast, never the confirmed quality).

// The full craft catalog is 4 種別 (剣/杖/短杖 + 護符) × 6 属性 × 4 tier = 96 recipes. A GET /api/workshop payload
// that is not exactly this many recipes is a broken catalog / data desync → fail-fast (never a half catalog).
export const WORKSHOP_RECIPE_COUNT = 96;

// The frozen equipment vocabulary, mirroring the backend (app/src/equipment.mjs). A field carrying any other value
// is malformed → fail-fast.
export const WORKSHOP_EQUIPMENT_KINDS = Object.freeze(['weapon', 'amulet']);
export const WORKSHOP_WEAPON_TYPES = Object.freeze(['sword', 'staff', 'short_rod']);
export const WORKSHOP_EQUIPMENT_QUALITIES = Object.freeze(['common', 'fine', 'excellent', 'masterwork']);
export const WORKSHOP_EFFECT_KEYS = Object.freeze([
  'attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power'
]);
// The magic elements (the material / equipment element axis), in the display order used across the game surfaces.
export const WORKSHOP_ELEMENTS = Object.freeze(['light', 'dark', 'fire', 'water', 'earth', 'wind']);

// Closed-vocabulary display labels — the SAME vocabulary the hub content-result renderer announces
// (app/src/routingMetaContext.mjs), so the workshop screen and the hub read as one language. Every label map
// covers exactly its canonical key set (asserted at load below), so a future vocabulary addition fails fast here
// instead of rendering a silently mislabeled card.
export const WORKSHOP_KIND_LABELS = Object.freeze({ weapon: '武器', amulet: '護符' });
export const WORKSHOP_WEAPON_TYPE_LABELS = Object.freeze({ sword: '剣', staff: '杖', short_rod: '短杖' });
export const WORKSHOP_ELEMENT_LABELS = Object.freeze({ light: '光', dark: '闇', fire: '火', water: '水', earth: '土', wind: '風' });
export const WORKSHOP_QUALITY_LABELS = Object.freeze({ common: '並', fine: '良', excellent: '優', masterwork: '傑作' });
export const WORKSHOP_EFFECT_LABELS = Object.freeze({
  attack: '攻撃', defense: '防御', max_hp: '最大HP', max_mp: '最大MP',
  spell_mp_discount: 'スペルMP軽減', self_heal_bonus: '自己回復量', element_spell_power: '同属性スペル威力'
});
// The board 種別 (category) axis: the three weapon types followed by the amulet, in scan order. A recipe's
// category is its weapon_type (weapons) or its kind (amulet), so the 96 recipes group into 種別 × 属性 × tier.
export const WORKSHOP_CATEGORY_ORDER = Object.freeze(['sword', 'staff', 'short_rod', 'amulet']);
export const WORKSHOP_CATEGORY_LABELS = Object.freeze({ sword: '剣', staff: '杖', short_rod: '短杖', amulet: '護符' });

// The roll outputs the arrival view MUST NOT carry (they are revealed only when the player crafts): a recipe that
// leaks any of them is malformed → fail-fast, so the board can never show a confirmed quality it has no business
// knowing (the acceptance "確定 quality の漏洩表示が無い" is enforced at the contract boundary).
const WORKSHOP_WITHHELD_RECIPE_KEYS = Object.freeze(['quality', 'bonus_effects', 'instance_id']);

function assertLabelsCover(labels, keys, what) {
  const labelKeys = Object.keys(labels).sort();
  const canonical = [...keys].sort();
  const matches = labelKeys.length === canonical.length && labelKeys.every((key, index) => key === canonical[index]);
  if (!matches) throw new Error(`workshop ${what} labels must cover exactly {${canonical.join(', ')}}: got {${labelKeys.join(', ')}}`);
}

assertLabelsCover(WORKSHOP_KIND_LABELS, WORKSHOP_EQUIPMENT_KINDS, 'kind');
assertLabelsCover(WORKSHOP_WEAPON_TYPE_LABELS, WORKSHOP_WEAPON_TYPES, 'weapon_type');
assertLabelsCover(WORKSHOP_ELEMENT_LABELS, WORKSHOP_ELEMENTS, 'element');
assertLabelsCover(WORKSHOP_QUALITY_LABELS, WORKSHOP_EQUIPMENT_QUALITIES, 'quality');
assertLabelsCover(WORKSHOP_EFFECT_LABELS, WORKSHOP_EFFECT_KEYS, 'effect');
assertLabelsCover(WORKSHOP_CATEGORY_LABELS, WORKSHOP_CATEGORY_ORDER, 'category');

// A closed-vocabulary label lookup that fail-fasts on an unknown key (no silent `?? key` fallback — a value
// outside the frozen vocabulary is a contract violation, not something to render raw).
function labelFor(labels, key, what) {
  if (!Object.prototype.hasOwnProperty.call(labels, key)) throw new Error(`workshop ${what} is not a known value: ${JSON.stringify(key)}`);
  return labels[key];
}

export function workshopKindLabel(kind) { return labelFor(WORKSHOP_KIND_LABELS, kind, 'kind'); }
export function workshopWeaponTypeLabel(weaponType) { return labelFor(WORKSHOP_WEAPON_TYPE_LABELS, weaponType, 'weapon_type'); }
export function workshopElementLabel(element) { return labelFor(WORKSHOP_ELEMENT_LABELS, element, 'element'); }
export function workshopQualityLabel(quality) { return labelFor(WORKSHOP_QUALITY_LABELS, quality, 'quality'); }
export function workshopCategoryLabel(category) { return labelFor(WORKSHOP_CATEGORY_LABELS, category, 'category'); }

// A recipe's board category: its weapon_type for weapons, or its kind (amulet) otherwise. The full 種別 label a
// card shows — 武器（剣） for a weapon, 護符 for an amulet — reuses the shared kind/weapon_type vocabulary.
export function workshopRecipeCategory(recipe) {
  return recipe.kind === 'weapon' ? recipe.weapon_type : recipe.kind;
}
export function workshopKindLabelFull(recipe) {
  return recipe.kind === 'weapon'
    ? `${workshopKindLabel('weapon')}（${workshopWeaponTypeLabel(recipe.weapon_type)}）`
    : workshopKindLabel(recipe.kind);
}

// Effect entries in the canonical effect-key order (a stable, scannable order for base / bonus effect rows).
// Each entry is { key, label, value }; an unknown effect key or a non-positive-integer value is malformed → throw.
// `allowEmpty` mirrors the equipment INSTANCE-SHAPE contract (app/src/equipment.mjs validateEffects, which accepts
// an empty effect object): recipe-fixed base_effects are always present so they stay strict (allowEmpty:false),
// but the ROLL-DERIVED bonus_effects are validated with allowEmpty:true so the frontend never hard-couples to the
// backend roll table's current per-rank line count — an empty bonus set is a structurally valid instance, not
// corruption (see validateCraftedInstance). This is NOT a silent fallback: an empty set renders an honest 「なし」.
export function workshopEffectEntries(effects, label, { allowEmpty = false } = {}) {
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) {
    throw new Error(`workshop: ${label} must be an object of effect -> positive integer (got ${JSON.stringify(effects)})`);
  }
  const keys = Object.keys(effects);
  if (keys.length === 0) {
    if (allowEmpty) return [];
    throw new Error(`workshop: ${label} must carry at least one effect (got ${JSON.stringify(effects)})`);
  }
  for (const key of keys) {
    if (!WORKSHOP_EFFECT_KEYS.includes(key)) throw new Error(`workshop: ${label} has an unknown effect key ${JSON.stringify(key)}`);
    const value = effects[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`workshop: ${label} effect ${key} must be a positive integer (got ${JSON.stringify(value)})`);
    }
  }
  return WORKSHOP_EFFECT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(effects, key)).map((key) => ({
    key,
    label: labelFor(WORKSHOP_EFFECT_LABELS, key, 'effect'),
    value: effects[key]
  }));
}

export function assertWorkshopString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`workshop: ${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

// Non-negative finite number (money required/held, item held). `positive:true` additionally rejects 0 (a material
// cost row with 0 required is malformed — a zero-cost row is omitted rather than carried as a 0 one).
export function assertWorkshopNumber(value, label, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error(`workshop: ${label} must be a ${positive ? 'positive' : 'non-negative'} finite number (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function assertWorkshopInteger(value, label, { min = null, max = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || (min !== null && value < min) || (max !== null && value > max)) {
    const range = min !== null && max !== null ? ` in ${min}..${max}` : '';
    throw new Error(`workshop: ${label} must be an integer${range} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`workshop: ${label} must be one of ${allowed.join('/')} (got ${JSON.stringify(value)})`);
  return value;
}

// Validate + normalize one arrival recipe row. Returns a render-ready shape (cost rows carry their computed
// `short` flag; the recipe's board `category` is derived). Every required field is validated fail-fast, and any
// withheld roll output (quality / bonus_effects / instance_id) present is a leak → throw (the arrival never
// reveals the confirmed craftsmanship).
export function validateWorkshopRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new Error(`workshop: malformed recipe ${JSON.stringify(recipe)}`);
  }
  for (const leaked of WORKSHOP_WITHHELD_RECIPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(recipe, leaked)) {
      throw new Error(`workshop: recipe must not carry the withheld roll output ${JSON.stringify(leaked)} (the confirmed craftsmanship is revealed only on craft)`);
    }
  }
  const recipeId = assertWorkshopString(recipe.recipe_id, 'recipe_id');
  const kind = assertOneOf(recipe.kind, WORKSHOP_EQUIPMENT_KINDS, 'kind');
  let weaponType = null;
  if (kind === 'weapon') {
    weaponType = assertOneOf(recipe.weapon_type, WORKSHOP_WEAPON_TYPES, 'weapon_type');
  } else if (Object.prototype.hasOwnProperty.call(recipe, 'weapon_type')) {
    throw new Error(`workshop: a ${kind} recipe must not carry weapon_type (got ${JSON.stringify(recipe.weapon_type)})`);
  }
  const element = assertOneOf(recipe.element, WORKSHOP_ELEMENTS, 'element');
  const tier = assertWorkshopInteger(recipe.tier, 'tier', { min: 1, max: 4 });
  const baseEffects = workshopEffectEntries(recipe.base_effects, 'base_effects');

  const costs = recipe.costs;
  if (!costs || typeof costs !== 'object') throw new Error(`workshop: costs must be an object (got ${JSON.stringify(costs)})`);
  if (!Array.isArray(costs.items)) throw new Error(`workshop: costs.items must be an array (got ${JSON.stringify(costs.items)})`);
  const items = costs.items.map((cost) => {
    if (!cost || typeof cost !== 'object') throw new Error(`workshop: cost row must be an object (got ${JSON.stringify(cost)})`);
    const required = assertWorkshopNumber(cost.required, 'costs.items[].required', { positive: true });
    const held = assertWorkshopNumber(cost.held, 'costs.items[].held');
    return {
      item_id: assertWorkshopString(cost.item_id, 'costs.items[].item_id'),
      display_name: assertWorkshopString(cost.display_name, 'costs.items[].display_name'),
      required,
      held,
      short: held < required
    };
  });
  const money = costs.money;
  if (!money || typeof money !== 'object') throw new Error(`workshop: costs.money must be an object (got ${JSON.stringify(money)})`);
  const moneyRequired = assertWorkshopNumber(money.required, 'costs.money.required');
  const moneyHeld = assertWorkshopNumber(money.held, 'costs.money.held');

  if (typeof recipe.affordable !== 'boolean') throw new Error(`workshop: affordable must be a boolean (got ${JSON.stringify(recipe.affordable)})`);

  const outlook = recipe.outlook;
  if (!outlook || typeof outlook !== 'object') throw new Error(`workshop: outlook must be an object (got ${JSON.stringify(outlook)})`);
  const band = assertWorkshopInteger(outlook.band, 'outlook.band', { min: 0, max: 3 });
  const outlookLabel = assertWorkshopString(outlook.label, 'outlook.label');

  return {
    recipe_id: recipeId,
    kind,
    ...(weaponType ? { weapon_type: weaponType } : {}),
    category: kind === 'weapon' ? weaponType : kind,
    element,
    tier,
    base_effects: baseEffects,
    items,
    money: { required: moneyRequired, held: moneyHeld, short: moneyHeld < moneyRequired },
    affordable: recipe.affordable,
    outlook: { band, label: outlookLabel }
  };
}

// Validate the whole GET /api/workshop payload and return the validated week + normalized recipes + the
// server-authoritative exit. Fail-fast on a non-object response, a missing/invalid week (a non-negative integer
// elapsed_weeks — the header source), a set that is not exactly 96 recipes, any malformed recipe, or a
// missing/empty post_content_screen (the exit the stay-and-craft screen leaves through — the workshop has NO
// affordability guarantee, so the exit MUST be present rather than depending on a craftable recipe). There is
// deliberately NO "at least one affordable" invariant (every recipe may be unaffordable — that is a valid, if
// unlucky, week, and the exit is how the player leaves).
export function validateWorkshopArrivalPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error(`workshop arrival: malformed response ${JSON.stringify(payload)}`);
  if (typeof payload.week !== 'number' || !Number.isInteger(payload.week) || payload.week < 0) {
    throw new Error(`workshop arrival: week must be a non-negative integer (got ${JSON.stringify(payload.week)})`);
  }
  const recipes = payload.recipes;
  if (!Array.isArray(recipes) || recipes.length !== WORKSHOP_RECIPE_COUNT) {
    throw new Error(`workshop arrival: expected exactly ${WORKSHOP_RECIPE_COUNT} recipes, got ${Array.isArray(recipes) ? recipes.length : JSON.stringify(recipes)}`);
  }
  const postContentScreen = assertWorkshopString(payload.post_content_screen, 'post_content_screen');
  const normalized = recipes.map((recipe) => validateWorkshopRecipe(recipe));
  return { week: payload.week, recipes: normalized, postContentScreen };
}

// A stable sort of validated recipes into 種別 (category) → 属性 (element) → tier order, so the board reads as one
// scannable 種別 × 属性 grid regardless of the payload's array order.
export function sortWorkshopRecipes(recipes) {
  const categoryRank = (recipe) => WORKSHOP_CATEGORY_ORDER.indexOf(recipe.category);
  const elementRank = (recipe) => WORKSHOP_ELEMENTS.indexOf(recipe.element);
  return [...recipes].sort((a, b) =>
    categoryRank(a) - categoryRank(b) || elementRank(a) - elementRank(b) || a.tier - b.tier);
}

// The board's client-side filter is a 3-axis AND composition (種別 × ティア × 属性) over the ALREADY-VALIDATED
// normalized recipes. WORKSHOP_FILTER_ALL on an axis drops that constraint; the default filter is すべて on every
// axis (the whole board). The filter never re-fetches or re-builds the board — it only decides which rows show.
export const WORKSHOP_FILTER_ALL = 'all';

// The distinct tier values present in this week's board, ascending — the DATA-DERIVED ティア filter axis (すべて +
// each tier that actually appears), so the filter never offers a tier with no rows. 属性 is instead the frozen
// closed set (WORKSHOP_ELEMENTS); tier is data-derived because a future catalog need not carry every tier.
export function workshopTierValues(recipes) {
  const tiers = new Set();
  for (const recipe of recipes) tiers.add(recipe.tier);
  return [...tiers].sort((a, b) => a - b);
}

// Whether one normalized recipe satisfies the 3-axis AND filter: each axis is WORKSHOP_FILTER_ALL (unconstrained)
// or an exact value the recipe must equal (category / element are the frozen strings, tier is the integer). A
// recipe passes only when EVERY constrained axis matches.
export function workshopRecipeMatchesFilter(recipe, filter) {
  return (filter.category === WORKSHOP_FILTER_ALL || recipe.category === filter.category)
    && (filter.tier === WORKSHOP_FILTER_ALL || recipe.tier === filter.tier)
    && (filter.element === WORKSHOP_FILTER_ALL || recipe.element === filter.element);
}

// The subset of the board the 3-axis filter shows, preserving input order. An empty result is a real, honest state:
// the caller shows the explicit 「該当するレシピがありません」 message rather than a silently blank table.
export function workshopVisibleRecipes(recipes, filter) {
  return recipes.filter((recipe) => workshopRecipeMatchesFilter(recipe, filter));
}

// Validate + normalize one crafted instance (the POST response's confirmed item). Strict shape: weapons carry
// weapon_type, amulets do not; quality is in the frozen set; name / flavor are non-empty; base + bonus effects
// validate. The roll outputs (quality / name / flavor / bonus_effects) are knowable ONLY here (post-craft), so
// they are read from the response — but the item's IDENTITY (kind / weapon_type / element / tier) is cross-checked
// against the selected recipe by the caller so the popup badges reflect the selection.
function validateCraftedInstance(instance) {
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) throw new Error(`workshop craft: instance must be an object (got ${JSON.stringify(instance)})`);
  const kind = assertOneOf(instance.kind, WORKSHOP_EQUIPMENT_KINDS, 'instance.kind');
  let weaponType = null;
  if (kind === 'weapon') weaponType = assertOneOf(instance.weapon_type, WORKSHOP_WEAPON_TYPES, 'instance.weapon_type');
  const element = assertOneOf(instance.element, WORKSHOP_ELEMENTS, 'instance.element');
  const tier = assertWorkshopInteger(instance.tier, 'instance.tier', { min: 1, max: 4 });
  const quality = assertOneOf(instance.quality, WORKSHOP_EQUIPMENT_QUALITIES, 'instance.quality');
  const name = assertWorkshopString(instance.name, 'instance.name');
  const flavor = assertWorkshopString(instance.flavor, 'instance.flavor');
  // base_effects is recipe-fixed (always present) → strict; bonus_effects is roll-derived and the equipment
  // instance-shape contract structurally permits an empty set (validateEffects accepts {}), so it is validated
  // with allowEmpty and rendered as 「なし」 when empty — the frontend does not couple to the roll table's current
  // per-rank line count (BONUS_LINES_BY_RANK), which today floors at 1 but is a backend internal, not this shape.
  const baseEffects = workshopEffectEntries(instance.base_effects, 'instance.base_effects');
  const bonusEffects = workshopEffectEntries(instance.bonus_effects, 'instance.bonus_effects', { allowEmpty: true });
  return { kind, weaponType, element, tier, quality, name, flavor, baseEffects, bonusEffects };
}

// Validate the POST /api/workshop/craft response against the SELECTED recipe and resolve what the result popup
// shows. The response ({ result, state, post_content_screen }) is authoritative for what the server actually
// crafted; the crafted item's identity is cross-checked FIELD BY FIELD against the selection so the popup can
// never present a divergent item:
//   - `result.recipe_id` must equal the clicked recipe's id (the server crafted the recipe the player selected);
//   - the crafted instance's kind / weapon_type / element / tier must match the selected recipe's.
// The roll outputs (quality / name / flavor / bonus_effects) come from the validated response — they are knowable
// only post-craft. The workshop is a STAY screen, so the returned state is adopted and the popup keeps the player
// in the workshop; `post_content_screen` is carried only for the eventual explicit exit. Any missing field or ANY
// identity divergence (recipe id / kind / weapon_type / element / tier) is a contract violation → throw (no silent
// fallback to a stale display).
export function resolveWorkshopCraft(response, recipe) {
  if (!recipe || typeof recipe !== 'object' || typeof recipe.recipe_id !== 'string') {
    throw new Error(`workshop craft: a validated selected recipe is required (got ${JSON.stringify(recipe)})`);
  }
  if (!response || typeof response !== 'object') throw new Error(`workshop craft: malformed response ${JSON.stringify(response)}`);
  if (!response.result || typeof response.result !== 'object') throw new Error(`workshop craft: response is missing the result (got ${JSON.stringify(response.result)})`);
  if (!response.state || typeof response.state !== 'object') throw new Error(`workshop craft: response is missing state (got ${JSON.stringify(response.state)})`);
  const postContentScreen = assertWorkshopString(response.post_content_screen, 'post_content_screen');

  const craftedRecipeId = assertWorkshopString(response.result.recipe_id, 'result.recipe_id');
  if (craftedRecipeId !== recipe.recipe_id) {
    throw new Error(`workshop craft: the crafted recipe ${JSON.stringify(craftedRecipeId)} does not match the selected recipe ${JSON.stringify(recipe.recipe_id)} (the server crafted a different recipe)`);
  }
  const instance = validateCraftedInstance(response.result.instance);
  if (instance.kind !== recipe.kind) {
    throw new Error(`workshop craft: crafted kind ${JSON.stringify(instance.kind)} does not match the selected recipe kind ${JSON.stringify(recipe.kind)}`);
  }
  const selectedWeaponType = recipe.kind === 'weapon' ? recipe.weapon_type : null;
  if (instance.weaponType !== selectedWeaponType) {
    throw new Error(`workshop craft: crafted weapon_type ${JSON.stringify(instance.weaponType)} does not match the selected recipe ${JSON.stringify(selectedWeaponType)}`);
  }
  if (instance.element !== recipe.element || instance.tier !== recipe.tier) {
    throw new Error(`workshop craft: crafted ${JSON.stringify(instance.element)} T${instance.tier} does not match the selected recipe ${JSON.stringify(recipe.element)} T${recipe.tier}`);
  }
  return {
    state: response.state,
    postContentScreen,
    display: {
      recipe_id: craftedRecipeId,
      kind: instance.kind,
      ...(instance.weaponType ? { weapon_type: instance.weaponType } : {}),
      element: instance.element,
      tier: instance.tier,
      quality: instance.quality,
      name: instance.name,
      flavor: instance.flavor,
      base_effects: instance.baseEffects,
      bonus_effects: instance.bonusEffects
    }
  };
}
