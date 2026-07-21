// Workshop: the routing "工房" destination (the 6th content destination).
//
// This is the feature owner for the workshop routing surface. Catalog registration
// (routingDestinations) and the dispatch mapping (routingDispatch → academy-workshop,
// a normal week-progressing destination) live in those shared modules; this module
// owns the arrival view and the craft-execution orchestration.
//
// The arrival view lists the full 96-recipe craft catalog in the same
// "material cost + held" grammar the alchemy arrival uses, plus a qualitative
// craftsmanship OUTLOOK derived only from the skill score S. The confirmed roll's
// quality is deliberately withheld: the actual craftsmanship is revealed only when the
// player crafts. Craft execution runs the frozen craftWithLlmNaming pipeline (preview →
// LLM naming → gate → atomic complete) and, on success, builds the workshop content
// result. Any failure leaves materials unconsumed (craftWithLlmNaming is atomic and
// fails fast before completeCraft); there is no automatic naming fallback.

import { createStorageApi } from './storage.mjs';
import { listCraftRecipes, previewCraft } from './equipmentCraft.mjs';
import { craftWithLlmNaming } from './llm/craftNaming.mjs';
import { loadDungeonMaterialDefinitions } from './dungeonMaterialCatalog.mjs';
import { buildWorkshopContentResult } from './routingContentResult.mjs';

export const WORKSHOP_DESTINATION_ID = 'workshop';

// Qualitative craftsmanship outlook, derived only from the skill score S (0..100). It
// is a coarse skill forecast, NOT the confirmed quality rank — the two intentionally
// use different vocabularies so the outlook never leaks the rolled quality. Ordered
// ascending by the minimum S that reaches the band.
const WORKSHOP_OUTLOOK_BANDS = Object.freeze([
  Object.freeze({ min: 0, label: 'おぼつかない' }),
  Object.freeze({ min: 25, label: 'まずまず' }),
  Object.freeze({ min: 50, label: '確かな手応え' }),
  Object.freeze({ min: 75, label: '練達の域' })
]);

export function workshopSkillOutlook(skillScore) {
  if (!Number.isInteger(skillScore) || skillScore < 0) {
    throw new Error(`workshop skill outlook requires a non-negative integer skill score: ${skillScore}`);
  }
  let band = 0;
  for (let index = 0; index < WORKSHOP_OUTLOOK_BANDS.length; index += 1) {
    if (skillScore >= WORKSHOP_OUTLOOK_BANDS[index].min) band = index;
  }
  return { band, label: WORKSHOP_OUTLOOK_BANDS[band].label };
}

function materialDisplayName(materialNameById, itemId) {
  const name = materialNameById.get(itemId);
  if (!name) throw new Error(`unknown workshop material item_id: ${itemId}`);
  return name;
}

// Maps a previewCraft result to an arrival-view recipe row. Base effects are
// recipe-fixed (known before crafting) and are exposed; the roll outputs
// (quality / bonus_effects / instance_id) are deliberately withheld so the arrival
// view never reveals the confirmed craftsmanship.
function toArrivalRecipe(preview, materialNameById) {
  const items = preview.material_costs.map((cost) => ({
    item_id: cost.item_id,
    display_name: materialDisplayName(materialNameById, cost.item_id),
    required: cost.quantity,
    held: cost.owned
  }));
  return {
    recipe_id: preview.recipe_id,
    kind: preview.kind,
    ...(preview.kind === 'weapon' ? { weapon_type: preview.weapon_type } : {}),
    element: preview.element,
    tier: preview.tier,
    base_effects: { ...preview.base_effects },
    costs: {
      items,
      money: { required: preview.money_cost, held: preview.money_owned }
    },
    affordable: preview.affordable,
    outlook: workshopSkillOutlook(preview.skill_score)
  };
}

// Builds the workshop arrival view: the full recipe catalog priced against the save's
// current inventory, with the S-derived outlook per recipe. Reuses the deterministic
// previewCraft (rather than duplicating the skill-score formula) and drops the roll
// outputs. Returns { week, recipes }.
export async function buildWorkshopArrivalView({ root, storage } = {}) {
  const api = storage ?? createStorageApi({ root });
  const materials = await loadDungeonMaterialDefinitions({ root: api.paths.projectRoot });
  const materialNameById = new Map(materials.map((material) => [material.item_id, material.name]));
  const recipes = listCraftRecipes();
  let week = null;
  const rows = [];
  for (const recipe of recipes) {
    const preview = await previewCraft({ storage: api, recipe_id: recipe.recipe_id });
    week = preview.week;
    rows.push(toArrivalRecipe(preview, materialNameById));
  }
  return { week, recipes: rows };
}

// Executes one craft: names it via the frozen craftWithLlmNaming pipeline, then builds
// the workshop content result. `now` is validated up front so a missing timestamp
// fails fast BEFORE any materials are consumed. Returns craftWithLlmNaming's result
// (recipe_id, week, quality, instance, consumed_costs, inventory) plus content_result.
export async function executeWorkshopCraft({ root, storage, recipe_id, config, fetchImpl, now } = {}) {
  if (typeof now !== 'string' || !now) throw new Error('workshop craft requires a recorded_at timestamp');
  const api = storage ?? createStorageApi({ root });
  const crafted = await craftWithLlmNaming({ storage: api, recipe_id, config, fetchImpl });
  const contentResult = buildWorkshopContentResult({
    week: crafted.week,
    now,
    recipeId: crafted.recipe_id,
    instance: crafted.instance
  });
  return { ...crafted, content_result: contentResult };
}
