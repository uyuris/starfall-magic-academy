// 星の揺り籠 (star cradle) domain logic: growth, the hidden three-layer roll (identity / timing wobble /
// second-form), the feed bias, harvest, weekly byproducts, naming, and the cage⇄release round-trip.
//
// Randomness discipline (うゆりすさん確定): the individual seed is captured ONCE when a seed/egg is placed and
// stored on the record. Everything downstream — which variety, how many weeks to mature/hatch, whether a plant
// is golden, whether a creature takes its second form, and every harvest/byproduct roll — derives
// deterministically from that saved seed (and, before reveal, the current feed state). So the outcome is random
// to the player yet invariant across reloads. Feed bias applies ONLY before reveal (plant bloom / creature
// hatch); after reveal the feed state is frozen (the feed op rejects a revealed individual), so the derived
// identity is stable without any reveal-time write. Growth stage is a pure function of elapsed weeks.

import { createRng, deriveSeed } from './dungeon/dungeonRng.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS, materialItemId } from './dungeonMaterialCatalog.mjs';
import { PLANT_STAGES, CREATURE_STAGES, RANDOM_ELEMENT } from './starCradleCatalog.mjs';

// Distinct salt namespaces so no two derived streams collide for the same individual seed.
const SALT = Object.freeze({
  identity: 11, mature: 12, hatch: 13, grow: 14, mutation: 15, golden: 16, harvest: 17, byproduct: 19
});

const MAX_TIER = Math.max(...MATERIAL_TIERS);

export const STAR_CRADLE_NAME_MAX_LENGTH = 24;
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f『』「」【】〈〉《》＜＞<>]/;

// Creature naming: the same closed-vocabulary rules as the atelier (non-empty, ≤24 code points, no control /
// newline / bracket-quote symbols), applied independently so the star cradle owns its own validator.
export function validateStarCradleName(name) {
  if (typeof name !== 'string') throw nameError('creature name must be a string');
  const trimmed = name.trim();
  if (!trimmed) throw nameError('creature name must not be empty');
  if ([...trimmed].length > STAR_CRADLE_NAME_MAX_LENGTH) throw nameError(`creature name must be at most ${STAR_CRADLE_NAME_MAX_LENGTH} characters`);
  if (FORBIDDEN_NAME_CHARS.test(trimmed)) throw nameError('creature name must not contain control characters, newlines, or bracket/quote symbols');
  return trimmed;
}

function nameError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errorCode = 'STAR_CRADLE_NAME_INVALID';
  return error;
}

function rng(seed, salt) {
  return createRng(deriveSeed(seed, salt));
}

function rollRange(seed, salt, range) {
  return rng(seed, salt).int(range.min, range.max);
}

// The fixed uniform identity roll of an individual (independent of feed). Combined with the feed-shaped weights
// it selects the variety; a fixed roll + changing weights is what lets feeding shift the outcome deterministically.
function identityRoll(seed) {
  return rng(seed, SALT.identity).next();
}

function feedMultiplier(element, feed, tuning) {
  if (element === null) return 1;
  const count = Math.min(feed[element] ?? 0, tuning.feed_bias_max_units);
  return 1 + tuning.feed_bias_per_unit * count;
}

// Weighted pick over a seed/egg's outcome pool: rarity base weight × feed bias for the variety's element. The
// pick uses the fixed identity roll as the cursor into the cumulative weight, so (seed, feed) fully determine it.
function resolveVariety(catalog, seedItem, seed, feed) {
  const varieties = seedItem.outcome_pool.map((id) => (seedItem.kind === 'plant' ? catalog.plantsById.get(id) : catalog.creaturesById.get(id)));
  const weights = varieties.map((variety) => catalog.tuning.rarity_weights[variety.rarity] * feedMultiplier(variety.element, feed, catalog.tuning));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = identityRoll(seed) * total;
  for (let index = 0; index < varieties.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) return varieties[index];
  }
  return varieties[varieties.length - 1];
}

// Resolves the variety a seed/egg becomes for the given (seed, feed) — the identity derivation the views use,
// exposed for the roll-determinism / feed-bias contract tests.
export function deriveVariety(catalog, itemId, seed, feed) {
  const seedItem = catalog.seedItemsById.get(itemId);
  if (!seedItem) throw new Error(`unknown star cradle seed/egg item: ${itemId}`);
  return resolveVariety(catalog, seedItem, seed, feed);
}

// ----- growth (pure functions of elapsed weeks) -----

function elapsed(record, currentWeek) {
  return Math.max(0, currentWeek - record.planted_week);
}

// Plant stage from elapsed weeks: [0, mature) split into 芽/若葉/蕾 by thirds, 開花 (revealed) at >= mature.
function plantStage(weeksElapsed, matureWeeks) {
  if (weeksElapsed >= matureWeeks) return { stage: PLANT_STAGES[3], revealed: true };
  const band = Math.min(2, Math.floor((weeksElapsed * 3) / matureWeeks));
  return { stage: PLANT_STAGES[band], revealed: false };
}

// Creature stage: 卵 before hatch, 幼体 (revealed) after hatch, 成体 (second form revealed) after hatch+grow.
function creatureStage(weeksElapsed, hatchWeeks, growWeeks) {
  if (weeksElapsed < hatchWeeks) return { stage: CREATURE_STAGES[0], revealed: false, adult: false };
  if (weeksElapsed < hatchWeeks + growWeeks) return { stage: CREATURE_STAGES[1], revealed: true, adult: false };
  return { stage: CREATURE_STAGES[2], revealed: true, adult: true };
}

// ----- material resolution (harvest / byproduct) -----

// Resolves one material grant to a concrete { item_id, quantity }, drawing a random element / a tier within a
// range from the supplied rng stream (so repeated grants in one harvest are independent yet reproducible), and
// applying a tier bonus (plant golden / creature second form), capped at the top tier.
function resolveMaterialGrant(grant, stream, tierBonus) {
  const element = grant.element === RANDOM_ELEMENT ? stream.pick(MATERIAL_ELEMENTS) : grant.element;
  const baseTier = grant.tier_max !== undefined ? stream.int(grant.tier, grant.tier_max) : grant.tier;
  const tier = Math.min(MAX_TIER, baseTier + tierBonus);
  return { item_id: materialItemId(element, tier), quantity: grant.quantity };
}

function resolveDrop(drop, stream) {
  if (!drop) return null;
  if (!stream.chance(drop.chance)) return null;
  const quantity = drop.quantity_max !== undefined ? stream.int(drop.quantity, drop.quantity_max) : drop.quantity;
  return { item_id: drop.item_id, quantity };
}

function mergeRewards(rewards) {
  const byId = new Map();
  for (const reward of rewards) byId.set(reward.item_id, (byId.get(reward.item_id) ?? 0) + reward.quantity);
  return [...byId.entries()].map(([item_id, quantity]) => ({ item_id, quantity })).sort((a, b) => a.item_id.localeCompare(b.item_id));
}

// ----- plant view / harvest -----

export function plantMatureWeeks(catalog, record) {
  return rollRange(record.seed, SALT.mature, catalog.seedItemsById.get(record.item_id).reveal_weeks);
}

export function isPlantGolden(catalog, record) {
  return rng(record.seed, SALT.golden).next() < catalog.tuning.golden_mutation_chance;
}

// The full derived view of one pot: stage, whether it has bloomed (revealed), and — once bloomed — the variety
// and whether it took the golden mutation. Feedable while still pre-bloom.
export function plantView(catalog, record, currentWeek) {
  const seedItem = catalog.seedItemsById.get(record.item_id);
  if (!seedItem || seedItem.kind !== 'plant') throw new Error(`star cradle pot references a non-plant seed item: ${record.item_id}`);
  const weeksElapsed = elapsed(record, currentWeek);
  const matureWeeks = plantMatureWeeks(catalog, record);
  const { stage, revealed } = plantStage(weeksElapsed, matureWeeks);
  const view = {
    slot_index: record.slot_index, kind: 'plant', seed_item: { item_id: seedItem.item_id, name: seedItem.name },
    stage, weeks_elapsed: weeksElapsed, mature_weeks: matureWeeks, revealed, feedable: !revealed, feed: { ...record.feed }
  };
  if (revealed) {
    const variety = resolveVariety(catalog, seedItem, record.seed, record.feed);
    view.variety = { id: variety.id, name: variety.name, element: variety.element, flavor: variety.flavor };
    view.golden = isPlantGolden(catalog, record);
    view.harvestable = true;
  }
  return view;
}

// The reward set a bloomed plant yields on harvest: its materials (golden bumps tier) plus its occasional seed.
export function plantHarvestRewards(catalog, record) {
  const seedItem = catalog.seedItemsById.get(record.item_id);
  const variety = resolveVariety(catalog, seedItem, record.seed, record.feed);
  const tierBonus = isPlantGolden(catalog, record) ? catalog.tuning.golden_harvest_tier_bonus : 0;
  const stream = rng(record.seed, SALT.harvest);
  const rewards = variety.harvest.materials.map((grant) => resolveMaterialGrant(grant, stream, tierBonus));
  const drop = resolveDrop(variety.harvest.drop, stream);
  if (drop) rewards.push(drop);
  return mergeRewards(rewards);
}

// ----- creature view / byproduct -----

export function creatureHatchWeeks(catalog, record) {
  return rollRange(record.seed, SALT.hatch, catalog.seedItemsById.get(record.item_id).reveal_weeks);
}

export function creatureGrowWeeks(catalog, variety, seed) {
  return rollRange(seed, SALT.grow, variety.grow_weeks);
}

export function creatureMutation(catalog, variety, seed) {
  if (!variety.mutation) return null;
  return rng(seed, SALT.mutation).next() < variety.mutation.chance ? variety.mutation : null;
}

function creatureTotalWeeks(catalog, record) {
  const hatch = creatureHatchWeeks(catalog, record);
  const seedItem = catalog.seedItemsById.get(record.item_id);
  const variety = resolveVariety(catalog, seedItem, record.seed, record.feed);
  return hatch + creatureGrowWeeks(catalog, variety, record.seed);
}

// The full derived view of one creature: stage, revealed variety (from hatch), adult flag, second form (from
// adulthood), name, and the count of unclaimed weekly byproducts.
export function creatureView(catalog, record, currentWeek) {
  const seedItem = catalog.seedItemsById.get(record.item_id);
  if (!seedItem || seedItem.kind !== 'creature') throw new Error(`star cradle creature references a non-creature egg item: ${record.item_id}`);
  const weeksElapsed = elapsed(record, currentWeek);
  const hatchWeeks = creatureHatchWeeks(catalog, record);
  const variety = resolveVariety(catalog, seedItem, record.seed, record.feed);
  const growWeeks = creatureGrowWeeks(catalog, variety, record.seed);
  const { stage, revealed, adult } = creatureStage(weeksElapsed, hatchWeeks, growWeeks);
  const view = {
    slot_index: record.slot_index, kind: 'creature', seed_item: { item_id: seedItem.item_id, name: seedItem.name },
    stage, weeks_elapsed: weeksElapsed, hatch_weeks: hatchWeeks, adult_weeks: hatchWeeks + growWeeks,
    revealed, adult, name: record.name, feedable: !revealed, feed: { ...record.feed }
  };
  if (revealed) {
    view.variety = { id: variety.id, name: variety.name, element: variety.element, flavor: variety.flavor };
  }
  if (adult) {
    const mutation = creatureMutation(catalog, variety, record.seed);
    view.mutation = mutation ? { id: mutation.id, name: mutation.name } : null;
    view.byproduct_pending_weeks = pendingByproductWeeks(record, hatchWeeks + growWeeks, currentWeek);
    view.cageable = true;
  }
  return view;
}

// The number of adult weeks whose byproducts have not yet been claimed: weeks strictly after last_byproduct_week
// and at/after the adult week, up to the current week. Supports まとめ受け取り of several weeks at once.
export function pendingByproductWeeks(record, adultAbsoluteWeek, currentWeek) {
  const adultWeek = record.planted_week + adultAbsoluteWeek;
  const lower = Math.max(record.last_byproduct_week + 1, adultWeek);
  return Math.max(0, currentWeek - lower + 1);
}

// The reward set for claiming all pending weekly byproducts of an adult creature. Each unclaimed adult week rolls
// its own byproduct (materials always, the occasional seed/egg), with a tier bonus when the creature took its
// second form. Returns { rewards, claimed_weeks } — claimed_weeks 0 means nothing was due.
export function creatureByproductRewards(catalog, record, currentWeek) {
  const seedItem = catalog.seedItemsById.get(record.item_id);
  const variety = resolveVariety(catalog, seedItem, record.seed, record.feed);
  const hatchWeeks = creatureHatchWeeks(catalog, record);
  const growWeeks = creatureGrowWeeks(catalog, variety, record.seed);
  const adultWeek = record.planted_week + hatchWeeks + growWeeks;
  const mutation = creatureMutation(catalog, variety, record.seed);
  const tierBonus = mutation ? mutation.byproduct_tier_bonus : 0;
  const rewards = [];
  let claimedWeeks = 0;
  for (let week = Math.max(record.last_byproduct_week + 1, adultWeek); week <= currentWeek; week += 1) {
    claimedWeeks += 1;
    const stream = createRng(deriveSeed(deriveSeed(record.seed, SALT.byproduct), week));
    for (const grant of variety.byproduct.materials) rewards.push(resolveMaterialGrant(grant, stream, tierBonus));
    const drop = resolveDrop(variety.byproduct.drop, stream);
    if (drop) rewards.push(drop);
  }
  return { rewards: mergeRewards(rewards), claimed_weeks: claimedWeeks };
}

// Resolves the adult creature identity for the cage item / release round-trip (the same derivation the view uses).
export function resolveCreatureIdentity(catalog, { item_id, seed, feed }) {
  const seedItem = catalog.seedItemsById.get(item_id);
  if (!seedItem || seedItem.kind !== 'creature') throw new Error(`star cradle identity requires a creature egg item: ${item_id}`);
  const variety = resolveVariety(catalog, seedItem, seed, feed);
  const mutation = creatureMutation(catalog, variety, seed);
  return { variety, mutation, hatch_weeks: creatureHatchWeeks(catalog, { item_id, seed }), grow_weeks: creatureGrowWeeks(catalog, variety, seed) };
}

// The planted_week a released caged creature must carry so it re-enters the garden exactly at adulthood: the
// current week minus its total (hatch + grow) weeks. Because caging required adulthood, current >= total, so this
// is non-negative.
export function releasedPlantedWeek(catalog, instance, currentWeek) {
  const { hatch_weeks, grow_weeks } = resolveCreatureIdentity(catalog, instance);
  return currentWeek - (hatch_weeks + grow_weeks);
}
