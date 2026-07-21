// Workshop crafting: the deterministic domain that turns a recipe + the hero's
// skill into a finished equipment instance. It sits on top of the equipment
// surface (equipment.mjs) and the inventory transaction (economy.mjs).
//
// Design (equipment-craft-brief):
//   - A closed recipe matrix, code-defined: weapons (weapon_type × element × tier)
//     and amulets (element × tier). Base performance is fixed by the recipe; bonus
//     performance is rolled.
//   - Crafting never fully fails. A deterministic two-stage roll picks the quality
//     rank (monotone in the skill score S) and then the bonus effects; the same
//     (slot, week, recipe) always yields the same roll, so a re-roll is only
//     possible by crafting in a different week.
//   - Naming is out of scope: name/flavor are supplied by the caller. completeCraft
//     binds material spend and the surface append into one atomic transaction so a
//     failure (bad name, short materials, duplicate) leaves nothing consumed.
//
// Nothing here draws from Math.random or the clock. Missing player parameters, an
// unknown recipe, malformed week state, short costs, and empty name/flavor all fail
// fast — there are no silent fallbacks and no env-var-tunable knobs.

import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { magicParameterDefinitions } from './parameters.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS, materialItemId } from './dungeonMaterialCatalog.mjs';
import { EQUIPMENT_QUALITIES, WEAPON_TYPES, addEquipmentInstance, loadEquipmentSurface, writeEquipmentSurface } from './equipment.mjs';
import { consumeInventoryItems } from './economy.mjs';

const INVENTORY_PATH = 'game_data/player_inventory.json';
const PLAYER_PARAMETERS_PATH = 'game_data/runtime/player_parameters.json';
const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

const ELEMENTS = magicParameterDefinitions.map((definition) => definition.key);
const TIERS = [...MATERIAL_TIERS];

// ----- tunable economy / performance constants -----
// Material and money cost climb with tier (recipe requires the matching element×tier
// dungeon material). Tunable; not env-configurable.
const MATERIAL_COST_BY_TIER = { 1: 3, 2: 4, 3: 5, 4: 6 };
// The tier money base is the single source for both the craft cost and the equipment
// sale price (equipmentSale.mjs derives the sell price from it), so it is exported to
// keep that base defined exactly once.
export const MONEY_COST_BY_TIER = { 1: 20, 2: 60, 3: 150, 4: 320 };

// Skill score weights: primary ability (academics for weapons, charisma for amulets)
// and the recipe element's magic mastery. S is their weighted average, 0..100.
const SKILL_WEIGHT_PRIMARY = 1;
const SKILL_WEIGHT_ELEMENT = 1;

// Quality roll: S plus a seed-derived noise in [-RANK_NOISE, RANK_NOISE], bucketed
// into the four ranks. Noise is drawn independently of S, so at a fixed seed the rank
// is monotone non-decreasing in S; the band width guarantees every rank is reachable.
const RANK_NOISE = 20;
const RANK_THRESHOLDS = [
  { max: 30, quality: 'common' },
  { max: 55, quality: 'fine' },
  { max: 80, quality: 'excellent' }
];
const TOP_QUALITY = 'masterwork';

// Bonus effects by rank: line count and per-line value band both escalate.
const BONUS_LINES_BY_RANK = { common: 1, fine: 2, excellent: 2, masterwork: 3 };
const BONUS_BAND_BY_RANK = { common: [1, 1], fine: [1, 2], excellent: [2, 3], masterwork: [3, 5] };

// element_spell_power is weapon-only, so it is never offered as an amulet bonus (an
// amulet carrying it would fail equipment surface validation).
const WEAPON_BONUS_POOL = ['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power'];
const AMULET_BONUS_POOL = ['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus'];

// ----- recipe catalog (closed matrix) -----

function baseEffectsFor(kind, weaponType, tier) {
  if (kind === 'amulet') return { defense: 2 + tier, max_hp: 4 + 3 * tier };
  if (weaponType === 'sword') return { attack: 3 + 2 * tier, max_hp: 2 + 2 * tier };
  if (weaponType === 'staff') return { max_mp: 2 + 2 * tier, element_spell_power: 2 + 2 * tier };
  if (weaponType === 'short_rod') return { spell_mp_discount: tier, max_mp: 1 + 2 * tier };
  throw new Error(`unknown weapon_type for base effects: ${weaponType}`);
}

function buildRecipe({ kind, weaponType, element, tier }) {
  return Object.freeze({
    recipe_id: kind === 'weapon' ? `craft_weapon_${weaponType}_${element}_t${tier}` : `craft_amulet_${element}_t${tier}`,
    kind,
    ...(kind === 'weapon' ? { weapon_type: weaponType } : {}),
    element,
    tier,
    material_costs: Object.freeze([Object.freeze({ item_id: materialItemId(element, tier), quantity: MATERIAL_COST_BY_TIER[tier] })]),
    money_cost: MONEY_COST_BY_TIER[tier],
    base_effects: Object.freeze(baseEffectsFor(kind, weaponType, tier))
  });
}

function buildRecipeCatalog() {
  const recipes = [];
  for (const element of ELEMENTS) {
    for (const tier of TIERS) {
      for (const weaponType of WEAPON_TYPES) {
        recipes.push(buildRecipe({ kind: 'weapon', weaponType, element, tier }));
      }
      recipes.push(buildRecipe({ kind: 'amulet', element, tier }));
    }
  }
  return recipes;
}

export const EQUIPMENT_CRAFT_RECIPES = Object.freeze(buildRecipeCatalog());
const RECIPE_BY_ID = new Map(EQUIPMENT_CRAFT_RECIPES.map((recipe) => [recipe.recipe_id, recipe]));

export function listCraftRecipes() {
  return EQUIPMENT_CRAFT_RECIPES;
}

export function getCraftRecipe(recipeId) {
  const recipe = RECIPE_BY_ID.get(recipeId);
  if (!recipe) throw new Error(`unknown craft recipe: ${recipeId}`);
  return recipe;
}

// ----- deterministic roll -----

// Park–Miller LCG seeded from a string, so a roll reproduces from (slot, week,
// recipe) without touching Math.random or the clock.
function stringSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function createRoll(seedString) {
  const modulus = 2147483647;
  let state = stringSeed(seedString) % modulus;
  if (state <= 0) state += modulus - 1;
  const next = () => {
    state = (state * 48271) % modulus;
    return state / modulus;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    // Deterministic Fisher–Yates pick of `count` distinct items.
    pickDistinct(items, count) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.slice(0, count);
    }
  };
}

function qualityForPoints(points) {
  for (const band of RANK_THRESHOLDS) {
    if (points < band.max) return band.quality;
  }
  return TOP_QUALITY;
}

// The two-stage roll: (1) quality rank from S + independent noise, (2) bonus effects
// (count and value band by rank). Returns the rolled quality and bonus_effects.
function rollCraft({ recipe, skillScore, seedString }) {
  const rng = createRoll(seedString);
  const quality = qualityForPoints(skillScore + rng.int(-RANK_NOISE, RANK_NOISE));
  const lineCount = BONUS_LINES_BY_RANK[quality];
  const [bandLow, bandHigh] = BONUS_BAND_BY_RANK[quality];
  const pool = recipe.kind === 'weapon' ? WEAPON_BONUS_POOL : AMULET_BONUS_POOL;
  const bonusEffects = {};
  for (const key of rng.pickDistinct(pool, lineCount)) {
    bonusEffects[key] = rng.int(bandLow, bandHigh);
  }
  return { quality, bonus_effects: bonusEffects };
}

// ----- skill score -----

function requiredParameterValue(parameters, group, key) {
  const entry = parameters?.[group]?.[key];
  const raw = entry !== null && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`player parameter ${group}.${key} is required for craft`);
  return value;
}

function craftSkillScore(recipe, parameters) {
  const primary = recipe.kind === 'weapon'
    ? requiredParameterValue(parameters, 'abilities', 'academics')
    : requiredParameterValue(parameters, 'abilities', 'charisma');
  const mastery = requiredParameterValue(parameters, 'magic', recipe.element);
  return Math.round((primary * SKILL_WEIGHT_PRIMARY + mastery * SKILL_WEIGHT_ELEMENT) / (SKILL_WEIGHT_PRIMARY + SKILL_WEIGHT_ELEMENT));
}

// ----- week / slot seed inputs -----

function assertElapsedWeeks(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`runtime_state.elapsed_weeks must be a non-negative integer for craft: ${value}`);
  return value;
}

// The save slot's stable identifier: the directory that holds the active save's
// game_data. In routing play that is the slot id; it is fixed for the life of a save
// and reachable purely through the storage layer that already routes to the active
// slot. Used only as a seed input, so the roll is save-scoped, never global.
function slotSeedIdentity(storage) {
  return path.basename(path.dirname(storage.paths.mutableRoot));
}

function seedStringFor({ slotIdentity, week, recipeId }) {
  return `${slotIdentity}|${week}|${recipeId}`;
}

function craftInstanceId({ slotIdentity, week, recipeId }) {
  return `equip_${slotIdentity}_w${week}_${recipeId}`;
}

// ----- shared resolution -----

async function resolveCraftRoll({ storage, recipeId }) {
  const recipe = getCraftRecipe(recipeId);
  const [playerParameters, state] = await Promise.all([
    storage.readJsonIfExists(PLAYER_PARAMETERS_PATH),
    storage.readJsonIfExists(RUNTIME_STATE_PATH)
  ]);
  if (playerParameters === null) throw new Error('player parameters are required for craft');
  const week = assertElapsedWeeks(state?.elapsed_weeks);
  const slotIdentity = slotSeedIdentity(storage);
  const skillScore = craftSkillScore(recipe, playerParameters);
  const roll = rollCraft({ recipe, skillScore, seedString: seedStringFor({ slotIdentity, week, recipeId: recipe.recipe_id }) });
  return {
    recipe,
    week,
    slotIdentity,
    skillScore,
    quality: roll.quality,
    bonus_effects: roll.bonus_effects,
    instance_id: craftInstanceId({ slotIdentity, week, recipeId: recipe.recipe_id })
  };
}

function craftedInstanceFields(resolved) {
  const { recipe } = resolved;
  return {
    instance_id: resolved.instance_id,
    kind: recipe.kind,
    ...(recipe.kind === 'weapon' ? { weapon_type: recipe.weapon_type } : {}),
    element: recipe.element,
    tier: recipe.tier,
    quality: resolved.quality,
    base_effects: { ...recipe.base_effects },
    bonus_effects: { ...resolved.bonus_effects }
  };
}

// ----- public read-only preview -----

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`craft ${label} must be a non-empty string`);
  return value;
}

// Read-only preview of a craft: the (quantity-checked) cost, the skill score, and the
// deterministic roll result — everything about the resulting instance except its
// caller-supplied name/flavor. Being deterministic, it matches completeCraft exactly.
export async function previewCraft({ root, storage, recipe_id } = {}) {
  const api = storage ?? createStorageApi({ root });
  const resolved = await resolveCraftRoll({ storage: api, recipeId: recipe_id });
  // A real save always materializes player_inventory.json, so an absent or malformed
  // one is a hard error, not a silently-empty wallet. (A material simply absent from
  // the ledger genuinely means zero owned — that is the ledger's meaning, not a mask.)
  const inventory = await api.readJsonIfExists(INVENTORY_PATH);
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory) || !Array.isArray(inventory.items) || !Number.isFinite(Number(inventory.money))) {
    throw new Error('player inventory is required and must be a { money, items } object for craft preview');
  }
  const ownedOf = (itemId) => inventory.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
  const costs = resolved.recipe.material_costs.map((cost) => ({ item_id: cost.item_id, quantity: cost.quantity, owned: ownedOf(cost.item_id) }));
  const moneyOwned = Number(inventory.money);
  const affordable = moneyOwned >= resolved.recipe.money_cost && costs.every((cost) => cost.owned >= cost.quantity);
  return {
    recipe_id: resolved.recipe.recipe_id,
    kind: resolved.recipe.kind,
    ...(resolved.recipe.kind === 'weapon' ? { weapon_type: resolved.recipe.weapon_type } : {}),
    element: resolved.recipe.element,
    tier: resolved.recipe.tier,
    week: resolved.week,
    skill_score: resolved.skillScore,
    quality: resolved.quality,
    base_effects: { ...resolved.recipe.base_effects },
    bonus_effects: { ...resolved.bonus_effects },
    instance_id: resolved.instance_id,
    material_costs: costs,
    money_cost: resolved.recipe.money_cost,
    money_owned: moneyOwned,
    affordable
  };
}

// ----- public atomic complete -----

// Completes a craft: with caller-supplied name/flavor, spends the recipe cost and
// appends the finished instance to the equipment surface in one transaction. Any
// failure (empty name/flavor, unknown recipe, short cost, or a same-week/same-recipe
// duplicate id) throws before materials are consumed, so a naming retry is always
// possible. The append and the material spend are never partially applied.
export async function completeCraft({ root, storage, recipe_id, name, flavor } = {}) {
  const api = storage ?? createStorageApi({ root });
  const craftedName = nonEmptyString(name, 'name');
  const craftedFlavor = nonEmptyString(flavor, 'flavor');
  const resolved = await resolveCraftRoll({ storage: api, recipeId: recipe_id });
  const instance = { ...craftedInstanceFields(resolved), name: craftedName, flavor: craftedFlavor };

  let priorSurface = null;
  const transaction = await consumeInventoryItems({
    root: api.paths.projectRoot,
    itemCosts: resolved.recipe.material_costs,
    moneyCost: resolved.recipe.money_cost,
    rewards: [],
    beforeWrite: async () => {
      priorSurface = await loadEquipmentSurface({ storage: api });
      return await addEquipmentInstance({ storage: api, instance });
    },
    rollbackBeforeWrite: async () => {
      await writeEquipmentSurface({ storage: api, surface: priorSurface });
    }
  });

  return {
    recipe_id: resolved.recipe.recipe_id,
    week: resolved.week,
    quality: resolved.quality,
    instance,
    consumed_costs: { item_costs: transaction.item_costs, money_cost: transaction.money_cost },
    inventory: transaction.inventory
  };
}
