// 競売場 (auction house) backend — the LM-non-involved pure domain layer.
//
// This module owns everything about the auction that does NOT call the model: the authored 52-item catalog
// (strict loader + validator), the deterministic weekly-seed lot draw (three lots, NPC bidders, NPC budgets,
// one-of-a-kind exclusion, B/D re-list suppression), the single-week slot state (validate / read / build /
// record award / closed judgment), the persistent sold ledger, and the pure derivations the ownership writers
// need — a being's parameters and a weapon/amulet lot's equipment instance. Session progression (the bid
// loop), the LLM provider (master 口上 / bid extraction / being 紹介文), and the HTTP surface are the next
// stage (B2) and consume this module's exports as their upstream contract.
//
// Everything here fails fast: an unknown category, a band/face outside the closed vocabulary, an id clash, a
// malformed slot, or an exhausted eligible pool throws. There is no silent fallback and no default-value fill.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { createRng, deriveSeed } from './dungeon/dungeonRng.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions, normalizeParameters } from './parameters.mjs';
import { EQUIPMENT_QUALITIES, WEAPON_TYPES, validateEquipmentInstance } from './equipment.mjs';
import { AUCTION_FACE_ID_PATTERN, AUCTION_FACE_POOL_SIZE } from './homunculusSurface.mjs';
import { resolveCreatureIdentity } from './starCradle.mjs';

const AUCTION_CATALOG_FILENAME = 'auction_catalog.json';

export const ROUTING_AUCTION_STATE_KEY = 'routing_auction';
export const AUCTION_SOLD_LEDGER_STATE_KEY = 'auction_sold_ledger';
// The player-consigned lot for the current week (出品側). Kept as its OWN runtime_state key — NOT inside the
// auction slot — so the house 3-lot slot schema (validateAuctionSlot / AUCTION_LOT_KEYS) is entirely unchanged.
export const ROUTING_AUCTION_CONSIGNMENT_STATE_KEY = 'routing_auction_consignment';

export const AUCTION_WEEKLY_LOT_COUNT = 3;
export const AUCTION_MIN_BIDDERS = 3;
export const AUCTION_MAX_BIDDERS = 5;

export const AUCTION_ITEM_CATEGORIES = Object.freeze(['weapon_amulet', 'treasure', 'being', 'flavor']);
export const AUCTION_BANDS = Object.freeze(['C', 'B', 'A', 'S']);
export const AUCTION_BEING_SPECIES = Object.freeze(['homunculus', 'spirit', 'monster']);
export const AUCTION_WEAPON_KINDS = Object.freeze(['sword', 'staff', 'short_rod', 'amulet']);

// The 星の揺り籠 (C-28) connection: a caged creature can be listed as a house lot (落札側) or consigned by the
// player (出品側). Both sides share one band rule — a common, non-mutated individual sits at band C, a rare OR
// mutated (変貌) individual at band B (a caged creature never reaches A/S). No new price constant: the band's
// authored price definition supplies the numbers.
export const AUCTION_CAGED_CREATURE_BANDS = Object.freeze(['C', 'B']);

// The weekly probability (week-seed deterministic) that the house lot 1 is replaced by a 籠入りの生き物 lot instead
// of a catalog item. A domain-owned tunable — not env-configurable.
export const AUCTION_CREATURE_LOT_CHANCE = 0.25;

// Per-category authored counts (the catalog is transcribed from auction-catalog-draft.md; a drifted count
// fails the loader). weapon_amulet 12 / treasure 10 / being 15 / flavor 15 = 52.
const AUCTION_CATEGORY_COUNTS = Object.freeze({ weapon_amulet: 12, treasure: 10, being: 15, flavor: 15 });
const AUCTION_ITEM_COUNT = Object.values(AUCTION_CATEGORY_COUNTS).reduce((sum, count) => sum + count, 0);

const AUCTION_ITEM_ID_PATTERN = /^auction_[a-z0-9_]+$/;
const CHARACTER_ID_PATTERN = /^character_\d{3}$/;

const MAGIC_KEYS = Object.freeze(magicParameterDefinitions.map((definition) => definition.key));
const ABILITY_KEYS = Object.freeze(abilityParameterDefinitions.map((definition) => definition.key));
const MAGIC_KEY_SET = new Set(MAGIC_KEYS);

// ----- alchemy-vocabulary effect for treasure (B) items -----
// The B effects are held to the existing item vocabulary so a later stage can wire them into the gift /
// self-boost / dungeon-consumable flows without a new effect language. Kept local (not imported from
// alchemyDefinitions) so the auction domain does not depend on the 56-recipe loader.
const TREASURE_EFFECT_CATEGORIES = Object.freeze(['gift', 'self_boost', 'dungeon_consumable']);
const DUNGEON_EFFECT_KINDS = Object.freeze([
  'attack_single', 'attack_area', 'heal', 'heal_full', 'mp_restore', 'mp_restore_full', 'revive'
]);

// ----- tunable economy / performance constants (this layer is the authority; not env-configurable) -----

// The week-seed base so the auction draw is independent of the dungeon/arena/errand draws for the same week.
const AUCTION_WEEK_SEED_BASE = 0x41554354; // 'AUCT'

// Which lot draws from which bands: lot 1 小物枠 = C〜B, lot 2 中堅枠 = B〜A, lot 3 目玉枠 = A〜S. Lot 1 spans
// C〜B (not C alone) so it is not pinned to the four authored C-band flavor items — it draws across categories.
const AUCTION_LOT_BANDS = Object.freeze([
  Object.freeze(['C', 'B']),
  Object.freeze(['B', 'A']),
  Object.freeze(['A', 'S'])
]);

// NPC budget ceiling: the band's price_max scaled up, so a bidder's deterministic budget spans from the band
// floor to somewhat above the ceiling ("今週は強敵が本気" vs a "拾い週").
const AUCTION_NPC_BUDGET_CEILING_NUMERATOR = 6;
const AUCTION_NPC_BUDGET_CEILING_DENOMINATOR = 5; // ×1.2

// A being's 11 parameters are rolled deterministically from (band, item_id) inside a band-scaled range — the
// auction being has no material cost to derive from, so the band fixes its strength tier. Week-independent so a
// given being always has the same stats.
const AUCTION_BEING_PARAMETER_RANGE = Object.freeze({
  B: Object.freeze({ min: 30, max: 60 }),
  A: Object.freeze({ min: 45, max: 75 }),
  S: Object.freeze({ min: 60, max: 90 })
});

// A weapon/amulet lot's equipment: band → tier / quality (B格=優=excellent, A格=傑作=masterwork, S格=傑作+付加増し),
// and the bonus-effect roll shape (line count + value band) per grade. The element is week-rolled.
const AUCTION_EQUIP_TIER_BY_BAND = Object.freeze({ B: 3, A: 4, S: 4 });
const AUCTION_EQUIP_QUALITY_BY_BAND = Object.freeze({ B: 'excellent', A: 'masterwork', S: 'masterwork' });
const AUCTION_EQUIP_BONUS_BY_BAND = Object.freeze({
  B: Object.freeze({ lines: 2, band: Object.freeze([2, 3]) }),
  A: Object.freeze({ lines: 3, band: Object.freeze([3, 5]) }),
  S: Object.freeze({ lines: 3, band: Object.freeze([4, 6]) })
});
const AUCTION_WEAPON_BONUS_POOL = Object.freeze(['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power']);
const AUCTION_AMULET_BONUS_POOL = Object.freeze(['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus']);

// The one-of-a-kind categories: a weapon/amulet 骨子 and a being are unique — once awarded (to the player or an
// NPC) they leave the world and are excluded from future draws. Treasure/flavor are re-listable.
const ONE_OF_A_KIND_CATEGORIES = new Set(['weapon_amulet', 'being']);
const RE_LISTABLE_CATEGORIES = new Set(['treasure', 'flavor']);

// ----- small validators -----

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
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
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

// FNV-1a over a string: the deterministic ordering key (same family as the study circle host permutation).
function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// ----- catalog -----

function validateAuctionPriceBands(value) {
  requiredObject(value, 'auction catalog price_bands');
  assertExactKeys(value, AUCTION_BANDS, 'auction catalog price_bands');
  const bands = {};
  for (const band of AUCTION_BANDS) {
    const entry = requiredObject(value[band], `auction catalog price_bands.${band}`);
    assertExactKeys(entry, ['price_min', 'price_max', 'min_increment'], `auction catalog price_bands.${band}`);
    const priceMin = positiveInteger(entry.price_min, `auction catalog price_bands.${band}.price_min`);
    const priceMax = positiveInteger(entry.price_max, `auction catalog price_bands.${band}.price_max`);
    if (priceMin > priceMax) throw new Error(`auction catalog price_bands.${band}.price_min must not exceed price_max`);
    bands[band] = {
      price_min: priceMin,
      price_max: priceMax,
      min_increment: positiveInteger(entry.min_increment, `auction catalog price_bands.${band}.min_increment`)
    };
  }
  // Bands ascend and touch (C.price_max === B.price_min etc.); a lower band's ceiling above the next band's
  // floor is authoring drift.
  for (let i = 1; i < AUCTION_BANDS.length; i += 1) {
    const lower = bands[AUCTION_BANDS[i - 1]];
    const higher = bands[AUCTION_BANDS[i]];
    if (lower.price_max > higher.price_min) {
      throw new Error(`auction catalog price_bands ${AUCTION_BANDS[i - 1]} ceiling must not exceed ${AUCTION_BANDS[i]} floor`);
    }
  }
  return bands;
}

function validateTreasureEffect(effect, label) {
  requiredObject(effect, label);
  const category = requiredString(effect.category, `${label}.category`);
  if (!TREASURE_EFFECT_CATEGORIES.includes(category)) {
    throw new Error(`${label}.category must be one of: ${TREASURE_EFFECT_CATEGORIES.join(', ')}`);
  }
  if (category === 'gift') {
    assertExactKeys(effect, ['category', 'affinity_bonus'], label);
    return { category, affinity_bonus: positiveInteger(effect.affinity_bonus, `${label}.affinity_bonus`) };
  }
  if (category === 'self_boost') {
    assertExactKeys(effect, ['category', 'parameter_effects'], label);
    if (!Array.isArray(effect.parameter_effects) || effect.parameter_effects.length === 0) {
      throw new Error(`${label}.parameter_effects must be a non-empty array`);
    }
    const groups = { magic: MAGIC_KEY_SET, abilities: new Set(ABILITY_KEYS) };
    const parameterEffects = effect.parameter_effects.map((entry, index) => {
      const e = requiredObject(entry, `${label}.parameter_effects[${index}]`);
      assertExactKeys(e, ['group', 'key', 'amount'], `${label}.parameter_effects[${index}]`);
      const group = requiredString(e.group, `${label}.parameter_effects[${index}].group`);
      if (!groups[group]) throw new Error(`${label}.parameter_effects[${index}].group must be magic or abilities`);
      const key = requiredString(e.key, `${label}.parameter_effects[${index}].key`);
      if (!groups[group].has(key)) throw new Error(`${label}.parameter_effects[${index}] unknown ${group} key: ${key}`);
      return { group, key, amount: positiveInteger(e.amount, `${label}.parameter_effects[${index}].amount`) };
    });
    return { category, parameter_effects: parameterEffects };
  }
  // dungeon_consumable
  const effectKind = requiredString(effect.effect_kind, `${label}.effect_kind`);
  if (!DUNGEON_EFFECT_KINDS.includes(effectKind)) {
    throw new Error(`${label}.effect_kind must be one of: ${DUNGEON_EFFECT_KINDS.join(', ')}`);
  }
  if (effectKind === 'attack_area') {
    assertExactKeys(effect, ['category', 'effect_kind', 'element', 'power', 'radius'], label);
    const element = requiredString(effect.element, `${label}.element`);
    if (!MAGIC_KEY_SET.has(element)) throw new Error(`${label}.element must be a magic element: ${element}`);
    return {
      category,
      effect_kind: effectKind,
      element,
      power: positiveInteger(effect.power, `${label}.power`),
      radius: positiveInteger(effect.radius, `${label}.radius`)
    };
  }
  if (effectKind === 'attack_single') {
    assertExactKeys(effect, ['category', 'effect_kind', 'element', 'power'], label);
    const element = requiredString(effect.element, `${label}.element`);
    if (!MAGIC_KEY_SET.has(element)) throw new Error(`${label}.element must be a magic element: ${element}`);
    return { category, effect_kind: effectKind, element, power: positiveInteger(effect.power, `${label}.power`) };
  }
  if (effectKind === 'heal') {
    assertExactKeys(effect, ['category', 'effect_kind', 'heal_amount'], label);
    return { category, effect_kind: effectKind, heal_amount: positiveInteger(effect.heal_amount, `${label}.heal_amount`) };
  }
  if (effectKind === 'mp_restore') {
    assertExactKeys(effect, ['category', 'effect_kind', 'mp_amount'], label);
    return { category, effect_kind: effectKind, mp_amount: positiveInteger(effect.mp_amount, `${label}.mp_amount`) };
  }
  if (effectKind === 'revive') {
    assertExactKeys(effect, ['category', 'effect_kind', 'revive_hp_ratio'], label);
    const ratio = effect.revive_hp_ratio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      throw new Error(`${label}.revive_hp_ratio must be a number in (0, 1]`);
    }
    return { category, effect_kind: effectKind, revive_hp_ratio: ratio };
  }
  // heal_full / mp_restore_full carry no tunables beyond the kind.
  assertExactKeys(effect, ['category', 'effect_kind'], label);
  return { category, effect_kind: effectKind };
}

function validateAuctionItem(entry, index) {
  requiredObject(entry, `auction catalog items[${index}]`);
  const itemId = requiredString(entry.item_id, `auction catalog items[${index}].item_id`);
  if (!AUCTION_ITEM_ID_PATTERN.test(itemId)) throw new Error(`auction catalog items[${index}].item_id must match ${AUCTION_ITEM_ID_PATTERN}: ${itemId}`);
  const label = `auction catalog item ${itemId}`;
  const category = requiredString(entry.category, `${label}.category`);
  if (!AUCTION_ITEM_CATEGORIES.includes(category)) throw new Error(`${label}.category must be one of: ${AUCTION_ITEM_CATEGORIES.join(', ')}`);
  const band = requiredString(entry.band, `${label}.band`);
  if (!AUCTION_BANDS.includes(band)) throw new Error(`${label}.band must be one of: ${AUCTION_BANDS.join(', ')}`);
  const name = requiredString(entry.name, `${label}.name`);

  if (category === 'weapon_amulet') {
    assertExactKeys(entry, ['item_id', 'category', 'name', 'weapon_kind', 'band'], label);
    const weaponKind = requiredString(entry.weapon_kind, `${label}.weapon_kind`);
    if (!AUCTION_WEAPON_KINDS.includes(weaponKind)) throw new Error(`${label}.weapon_kind must be one of: ${AUCTION_WEAPON_KINDS.join(', ')}`);
    return { item_id: itemId, category, name, weapon_kind: weaponKind, band };
  }
  if (category === 'treasure') {
    assertExactKeys(entry, ['item_id', 'category', 'name', 'description', 'band', 'effect'], label);
    return {
      item_id: itemId,
      category,
      name,
      description: requiredString(entry.description, `${label}.description`),
      band,
      effect: validateTreasureEffect(entry.effect, `${label}.effect`)
    };
  }
  if (category === 'flavor') {
    assertExactKeys(entry, ['item_id', 'category', 'name', 'band', 'appeal_seed'], label);
    return { item_id: itemId, category, name, band, appeal_seed: requiredString(entry.appeal_seed, `${label}.appeal_seed`) };
  }
  // being
  const species = requiredString(entry.species, `${label}.species`);
  if (!AUCTION_BEING_SPECIES.includes(species)) throw new Error(`${label}.species must be one of: ${AUCTION_BEING_SPECIES.join(', ')}`);
  const faceId = requiredString(entry.face_id, `${label}.face_id`);
  if (!AUCTION_FACE_ID_PATTERN.test(faceId)) throw new Error(`${label}.face_id must match ab_NNN in the auction face pool: ${faceId}`);
  const temperamentSeed = requiredString(entry.temperament_seed, `${label}.temperament_seed`);
  const baseKeys = ['item_id', 'category', 'name', 'species', 'face_id', 'band', 'temperament_seed'];
  if (species === 'spirit') {
    assertExactKeys(entry, [...baseKeys, 'element'], label);
    const element = requiredString(entry.element, `${label}.element`);
    if (!MAGIC_KEY_SET.has(element)) throw new Error(`${label}.element must be a magic element: ${element}`);
    return { item_id: itemId, category, name, species, element, face_id: faceId, band, temperament_seed: temperamentSeed };
  }
  if (species === 'monster') {
    assertExactKeys(entry, [...baseKeys, 'form_seed'], label);
    return { item_id: itemId, category, name, species, form_seed: requiredString(entry.form_seed, `${label}.form_seed`), face_id: faceId, band, temperament_seed: temperamentSeed };
  }
  assertExactKeys(entry, baseKeys, label);
  return { item_id: itemId, category, name, species, face_id: faceId, band, temperament_seed: temperamentSeed };
}

export function validateAuctionCatalog(raw) {
  const value = requiredObject(raw, 'auction catalog');
  if (value.version !== 1) throw new Error(`auction catalog version must be 1: ${value.version}`);
  const priceBands = validateAuctionPriceBands(value.price_bands);
  if (!Array.isArray(value.items)) throw new Error('auction catalog items must be an array');
  if (value.items.length !== AUCTION_ITEM_COUNT) {
    throw new Error(`auction catalog must contain exactly ${AUCTION_ITEM_COUNT} items: got ${value.items.length}`);
  }
  const seenIds = new Set();
  const perCategory = new Map(AUCTION_ITEM_CATEGORIES.map((category) => [category, 0]));
  const beingFaceIds = new Set();
  const items = value.items.map((entry, index) => {
    const item = validateAuctionItem(entry, index);
    if (seenIds.has(item.item_id)) throw new Error(`auction catalog item_id must be unique: ${item.item_id}`);
    seenIds.add(item.item_id);
    perCategory.set(item.category, perCategory.get(item.category) + 1);
    if (item.category === 'being') {
      if (beingFaceIds.has(item.face_id)) throw new Error(`auction catalog being face_id must be unique: ${item.face_id}`);
      beingFaceIds.add(item.face_id);
    }
    return item;
  });
  for (const [category, count] of perCategory) {
    if (count !== AUCTION_CATEGORY_COUNTS[category]) {
      throw new Error(`auction catalog category ${category} must have exactly ${AUCTION_CATEGORY_COUNTS[category]} items: got ${count}`);
    }
  }
  // The being faces are the closed 1:1 set ab_001..ab_0NN (each used exactly once).
  for (let index = 1; index <= AUCTION_FACE_POOL_SIZE; index += 1) {
    const faceId = `ab_${String(index).padStart(3, '0')}`;
    if (!beingFaceIds.has(faceId)) throw new Error(`auction catalog being faces must cover ${faceId}`);
  }
  return { version: 1, price_bands: priceBands, items };
}

export async function loadAuctionCatalog({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const catalogPath = path.join(storage.paths.definitionsRoot, AUCTION_CATALOG_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`auction catalog file is missing: ${catalogPath}`);
    throw error;
  }
  return validateAuctionCatalog(JSON.parse(raw));
}

function auctionItemById(catalog) {
  return new Map(catalog.items.map((item) => [item.item_id, item]));
}

export function auctionCatalogItem(catalog, itemId) {
  const item = auctionItemById(catalog).get(requiredString(itemId, 'auction item_id'));
  if (!item) throw new Error(`unknown auction catalog item: ${itemId}`);
  return item;
}

// ----- inventory item definitions (treasure + flavor → economy known-item / decorate set) -----

// The B (treasure) and D (flavor) items become inventory item definitions so the economy's known-item gate
// admits them and the decorated inventory shows their name/description. Functional/flavor items sell for 0
// (the same sell_price-0 convention as gift / self-boost / consumable alchemy items).
export function auctionInventoryItemDefinitions(catalog) {
  const normalized = catalog?.items ? catalog : validateAuctionCatalog(catalog);
  return normalized.items
    .filter((item) => RE_LISTABLE_CATEGORIES.has(item.category))
    .map((item) => ({
      item_id: item.item_id,
      name: item.name,
      description: item.category === 'flavor' ? item.appeal_seed : item.description,
      buy_price: 0,
      sell_price: 0
    }));
}

export async function loadAuctionInventoryItems({ root } = {}) {
  return auctionInventoryItemDefinitions(await loadAuctionCatalog({ root }));
}

// ----- deterministic weekly lot draw -----

export function auctionWeekSeed(week) {
  return deriveSeed(AUCTION_WEEK_SEED_BASE, nonNegativeInteger(week, 'auction week'));
}

function normalizeRoster(roster) {
  if (!Array.isArray(roster)) throw new Error('auction roster must be an array of selectable characters');
  const seen = new Set();
  return roster.map((entry, index) => {
    const value = requiredObject(entry, `auction roster[${index}]`);
    const characterId = requiredString(value.character_id, `auction roster[${index}].character_id`);
    if (!CHARACTER_ID_PATTERN.test(characterId)) throw new Error(`auction roster[${index}].character_id must be a selectable character id: ${characterId}`);
    if (seen.has(characterId)) throw new Error(`auction roster has a duplicate character_id: ${characterId}`);
    seen.add(characterId);
    return { character_id: characterId, display_name: requiredString(value.display_name, `auction roster[${index}].display_name`) };
  });
}

// Selects the NPC bidders for the week: AUCTION_MIN_BIDDERS..AUCTION_MAX_BIDDERS distinct selectable characters,
// week-fixed. Fails fast when the roster is too small to seat the minimum.
function selectAuctionBidders({ roster, seed }) {
  if (roster.length < AUCTION_MIN_BIDDERS) {
    throw new Error(`auction requires at least ${AUCTION_MIN_BIDDERS} selectable characters to seat bidders: got ${roster.length}`);
  }
  const rng = createRng(deriveSeed(seed, 0x42494400)); // 'BID'
  const max = Math.min(AUCTION_MAX_BIDDERS, roster.length);
  const count = rng.int(AUCTION_MIN_BIDDERS, max);
  return rng.shuffle(roster).slice(0, count).map((bidder) => ({ character_id: bidder.character_id, display_name: bidder.display_name }));
}

// Draws the deterministic weekly skeleton: three distinct lots (band-filtered pools, one-of-a-kind sold items
// excluded, prior-week treasure/flavor suppressed), each with a band-rolled initial price, the band's minimum
// increment, and a per-bidder non-public budget. NPC bidders are fixed for the week. No LLM, no prose.
export function drawWeeklyAuctionLots({ week, roster, soldLedger = [], previousLotItemIds = [], catalog }) {
  const normalizedWeek = nonNegativeInteger(week, 'auction week');
  const normalizedCatalog = catalog?.items ? catalog : validateAuctionCatalog(catalog);
  const normalizedRoster = normalizeRoster(roster);
  const soldSet = new Set(readAuctionSoldLedger({ [AUCTION_SOLD_LEDGER_STATE_KEY]: soldLedger }));
  const previousSet = new Set((Array.isArray(previousLotItemIds) ? previousLotItemIds : [])
    .map((id) => requiredString(id, 'previousLotItemIds entry')));
  const seed = auctionWeekSeed(normalizedWeek);
  const bidders = selectAuctionBidders({ roster: normalizedRoster, seed });
  const priceBands = normalizedCatalog.price_bands;

  const chosen = new Set();
  const lots = AUCTION_LOT_BANDS.map((bands, lotIndex) => {
    const bandSet = new Set(bands);
    const eligible = normalizedCatalog.items.filter((item) => {
      if (!bandSet.has(item.band)) return false;
      if (chosen.has(item.item_id)) return false;
      if (ONE_OF_A_KIND_CATEGORIES.has(item.category) && soldSet.has(item.item_id)) return false;
      // Prior-week suppression is a whole-catalog invariant: no item — re-listable OR one-of-a-kind — repeats in
      // the immediately following week (a 流札 unique stays in the world but gets a one-week cooldown).
      if (previousSet.has(item.item_id)) return false;
      return true;
    });
    if (eligible.length === 0) {
      throw new Error(`auction lot ${lotIndex} has no eligible item for week ${normalizedWeek} (bands ${bands.join('/')}): the pool is exhausted`);
    }
    // Per-lot seeded pick from the week seed (independent salt per lot), so the long-run item frequency is even —
    // the FNV-min-value ordering skewed specific items to the pool head. Deterministic in (week, soldLedger,
    // previousLotItemIds, roster) because the eligible order and the seed are fixed. No compat draw / hash fallback.
    const itemRng = createRng(deriveSeed(seed, stableHash(`auction-item:${lotIndex}`)));
    const item = itemRng.pick(eligible);
    chosen.add(item.item_id);
    const bandDef = priceBands[item.band];

    const priceRng = createRng(deriveSeed(seed, stableHash(`auction-price:${lotIndex}:${item.item_id}`)));
    const initialPrice = priceRng.int(bandDef.price_min, bandDef.price_max);

    const budgetCeiling = Math.floor(bandDef.price_max * AUCTION_NPC_BUDGET_CEILING_NUMERATOR / AUCTION_NPC_BUDGET_CEILING_DENOMINATOR);
    const npcBudgets = {};
    for (const bidder of bidders) {
      const budgetRng = createRng(deriveSeed(seed, stableHash(`auction-budget:${lotIndex}:${bidder.character_id}:${item.item_id}`)));
      npcBudgets[bidder.character_id] = budgetRng.int(bandDef.price_min, budgetCeiling);
    }

    return {
      lot_index: lotIndex,
      item,
      band: item.band,
      initial_price: initialPrice,
      min_increment: bandDef.min_increment,
      npc_budgets: npcBudgets
    };
  });

  return { week: normalizedWeek, bidders, lots };
}

// ----- caged creature house lot (星の揺り籠 connection・落札側) -----

// The shared band rule for a caged creature (both the house lot and the player consignment): a common,
// non-mutated individual is band C; a rare OR mutated (変貌) individual is band B. `mutation` is the C-28
// second-form roll (null when the individual did not take it).
export function auctionCagedCreatureBand({ variety, mutation }) {
  const rarity = requiredString(variety?.rarity, 'caged creature variety.rarity');
  return (rarity === 'common' && (mutation === null || mutation === undefined)) ? 'C' : 'B';
}

// Whether this week's house lot 1 is a 籠入りの生き物 lot (week-seed deterministic, AUCTION_CREATURE_LOT_CHANCE).
// Uses its own salt so the decision never disturbs the three catalog lot draws — a non-creature week's lineup is
// byte-identical to a draw with no creature lot at all.
export function auctionCreatureLotForWeek(week) {
  const seed = auctionWeekSeed(nonNegativeInteger(week, 'auction week'));
  return createRng(deriveSeed(seed, stableHash('auction-creature-lot'))).chance(AUCTION_CREATURE_LOT_CHANCE);
}

// Builds the caged-creature house lot for lot index 0: picks a creature 種卵 from the star cradle catalog and an
// instance seed (both week-seed deterministic), derives the individual's variety/変貌 with C-28's roll, maps that
// to a band (auctionCagedCreatureBand), and rolls the band-connected initial price + per-bidder budgets exactly the
// way a catalog lot does. The lot item stores the 種卵 item_id + instance seed (the identity source) plus the
// derived presentation (品名/触れ込み); it is NOT a catalog item. `bidders` are the week's seated slot bidders.
export function buildAuctionCreatureLot({ week, bidders, catalog, starCradleCatalog }) {
  const normalizedWeek = nonNegativeInteger(week, 'auction week');
  const normalizedCatalog = catalog?.price_bands ? catalog : validateAuctionCatalog(catalog);
  const seatedBidders = validateAuctionBidders(bidders, 'auction creature lot bidders');
  if (!starCradleCatalog?.seedItems) throw new Error('auction creature lot requires the star cradle catalog');
  const creatureSeedItems = starCradleCatalog.seedItems.filter((item) => item.kind === 'creature');
  if (creatureSeedItems.length === 0) throw new Error('star cradle catalog has no creature 種卵 for an auction creature lot');

  const seed = auctionWeekSeed(normalizedWeek);
  const seedItem = createRng(deriveSeed(seed, stableHash('auction-creature-egg'))).pick(creatureSeedItems);
  const instanceSeed = deriveSeed(seed, stableHash('auction-creature-seed'));
  const { variety, mutation } = resolveCreatureIdentity(starCradleCatalog, { item_id: seedItem.item_id, seed: instanceSeed, feed: {} });
  const band = auctionCagedCreatureBand({ variety, mutation });
  const bandDef = normalizedCatalog.price_bands[band];

  const item = {
    category: 'caged_creature',
    item_id: seedItem.item_id,
    seed: instanceSeed,
    band,
    name: `籠入りの${variety.name}`,
    blurb: mutation ? `${variety.flavor}（${mutation.name}）` : variety.flavor
  };

  const initialPrice = createRng(deriveSeed(seed, stableHash(`auction-creature-price:${seedItem.item_id}`))).int(bandDef.price_min, bandDef.price_max);
  const budgetCeiling = Math.floor(bandDef.price_max * AUCTION_NPC_BUDGET_CEILING_NUMERATOR / AUCTION_NPC_BUDGET_CEILING_DENOMINATOR);
  const npcBudgets = {};
  for (const bidder of seatedBidders) {
    npcBudgets[bidder.character_id] = createRng(deriveSeed(seed, stableHash(`auction-creature-budget:${bidder.character_id}`))).int(bandDef.price_min, budgetCeiling);
  }

  return { lot_index: 0, item, band, initial_price: initialPrice, min_increment: bandDef.min_increment, npc_budgets: npcBudgets };
}

// ----- slot state (runtime_state.routing_auction) -----

const AUCTION_LOT_KEYS = ['lot_index', 'item', 'band', 'initial_price', 'min_increment', 'npc_budgets'];
const AUCTION_AWARD_OUTCOMES = Object.freeze(['awarded', 'passed_in']);

function validateAuctionBidders(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length < AUCTION_MIN_BIDDERS || value.length > AUCTION_MAX_BIDDERS) {
    throw new Error(`${label} must hold ${AUCTION_MIN_BIDDERS}..${AUCTION_MAX_BIDDERS} bidders: got ${value.length}`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const bidder = requiredObject(entry, `${label}[${index}]`);
    assertExactKeys(bidder, ['character_id', 'display_name'], `${label}[${index}]`);
    const characterId = requiredString(bidder.character_id, `${label}[${index}].character_id`);
    if (!CHARACTER_ID_PATTERN.test(characterId)) throw new Error(`${label}[${index}].character_id must be a selectable character id: ${characterId}`);
    if (seen.has(characterId)) throw new Error(`${label} has a duplicate bidder: ${characterId}`);
    seen.add(characterId);
    return { character_id: characterId, display_name: requiredString(bidder.display_name, `${label}[${index}].display_name`) };
  });
}

function validateAuctionNpcBudgets(value, { bidderIds, label }) {
  requiredObject(value, label);
  const keys = Object.keys(value);
  if (keys.length !== bidderIds.length) throw new Error(`${label} must carry a budget for exactly the ${bidderIds.length} bidders`);
  const budgets = {};
  for (const bidderId of bidderIds) {
    if (!Object.prototype.hasOwnProperty.call(value, bidderId)) throw new Error(`${label} is missing bidder budget: ${bidderId}`);
    budgets[bidderId] = positiveInteger(value[bidderId], `${label}.${bidderId}`);
  }
  return budgets;
}

// A caged-creature lot item (星の揺り籠 connection・落札側): a generated one-off, NOT a catalog item, so it carries
// its own presentation (name/blurb) + provenance (the 種卵 item_id + the instance seed) instead of resolving from
// the auction catalog. The variety/変貌 identity is re-derived from (item_id, seed) via C-28's deterministic roll —
// this shape stores only the durable facts + the derived presentation, never a second copy of the identity.
const CAGED_CREATURE_LOT_ITEM_KEYS = ['category', 'item_id', 'seed', 'band', 'name', 'blurb'];

function validateCagedCreatureLotItem(value, index) {
  requiredObject(value, `auction slot lot[${index}].item`);
  assertExactKeys(value, CAGED_CREATURE_LOT_ITEM_KEYS, `auction slot lot[${index}].item`);
  const band = requiredString(value.band, `auction slot lot[${index}].item.band`);
  if (!AUCTION_CAGED_CREATURE_BANDS.includes(band)) {
    throw new Error(`auction caged creature lot band must be one of: ${AUCTION_CAGED_CREATURE_BANDS.join(', ')}: ${band}`);
  }
  return {
    category: 'caged_creature',
    // The 種卵 item_id (a star_cradle_<name> seed/egg id — the star cradle catalog is its authority; the auction
    // only carries it so the award can re-derive the individual).
    item_id: requiredString(value.item_id, `auction slot lot[${index}].item.item_id`),
    seed: positiveInteger(value.seed, `auction slot lot[${index}].item.seed`),
    band,
    name: requiredString(value.name, `auction slot lot[${index}].item.name`),
    blurb: requiredString(value.blurb, `auction slot lot[${index}].item.blurb`)
  };
}

// A slot lot item is either a normalized auction catalog item (weapon_amulet/treasure/being/flavor) or a generated
// caged_creature item. Fails fast on an unknown category — no silent fallback.
function validateAuctionLotItem(value, index) {
  requiredObject(value, `auction slot lot[${index}].item`);
  if (value.category === 'caged_creature') return validateCagedCreatureLotItem(value, index);
  return validateAuctionItem(value, index);
}

function validateAuctionLot(value, index, { bidderIds }) {
  requiredObject(value, `auction slot lot[${index}]`);
  assertExactKeys(value, AUCTION_LOT_KEYS, `auction slot lot[${index}]`);
  if (value.lot_index !== index) throw new Error(`auction slot lot[${index}].lot_index must equal ${index}: got ${value.lot_index}`);
  const item = validateAuctionLotItem(value.item, index);
  const band = requiredString(value.band, `auction slot lot[${index}].band`);
  if (band !== item.band) throw new Error(`auction slot lot[${index}].band must equal the item band: ${band} vs ${item.band}`);
  return {
    lot_index: index,
    item,
    band,
    initial_price: positiveInteger(value.initial_price, `auction slot lot[${index}].initial_price`),
    min_increment: positiveInteger(value.min_increment, `auction slot lot[${index}].min_increment`),
    npc_budgets: validateAuctionNpcBudgets(value.npc_budgets, { bidderIds, label: `auction slot lot[${index}].npc_budgets` })
  };
}

function validateAuctionAward(value, index, { lots, bidderIds }) {
  requiredObject(value, `auction slot awards[${index}]`);
  if (value.lot_index !== index) throw new Error(`auction slot awards[${index}].lot_index must equal ${index}: got ${value.lot_index}`);
  const outcome = requiredString(value.outcome, `auction slot awards[${index}].outcome`);
  if (!AUCTION_AWARD_OUTCOMES.includes(outcome)) throw new Error(`auction slot awards[${index}].outcome must be one of: ${AUCTION_AWARD_OUTCOMES.join(', ')}`);
  if (outcome === 'passed_in') {
    // 流札: no winner, no price paid.
    assertExactKeys(value, ['lot_index', 'outcome', 'winner_character_id', 'amount'], `auction slot awards[${index}]`);
    if (value.winner_character_id !== null) throw new Error(`auction slot awards[${index}] passed_in must have winner_character_id null`);
    if (value.amount !== null) throw new Error(`auction slot awards[${index}] passed_in must have amount null`);
    return { lot_index: index, outcome, winner_character_id: null, amount: null };
  }
  // awarded: a winner (the player 'player' or one of the week's bidders) paid at least the initial price.
  assertExactKeys(value, ['lot_index', 'outcome', 'winner_character_id', 'amount'], `auction slot awards[${index}]`);
  const winner = requiredString(value.winner_character_id, `auction slot awards[${index}].winner_character_id`);
  if (winner !== 'player' && !bidderIds.includes(winner)) {
    throw new Error(`auction slot awards[${index}].winner_character_id must be 'player' or a seated bidder: ${winner}`);
  }
  const amount = positiveInteger(value.amount, `auction slot awards[${index}].amount`);
  if (amount < lots[index].initial_price) {
    throw new Error(`auction slot awards[${index}].amount must be at least the lot initial price: ${amount} < ${lots[index].initial_price}`);
  }
  return { lot_index: index, outcome, winner_character_id: winner, amount };
}

export function validateAuctionSlot(slot) {
  requiredObject(slot, 'auction slot');
  assertExactKeys(slot, ['week', 'bidders', 'lots', 'status', 'current_lot_index', 'awards'], 'auction slot');
  const week = nonNegativeInteger(slot.week, 'auction slot week');
  const bidders = validateAuctionBidders(slot.bidders, 'auction slot bidders');
  const bidderIds = bidders.map((bidder) => bidder.character_id);
  if (!Array.isArray(slot.lots) || slot.lots.length !== AUCTION_WEEKLY_LOT_COUNT) {
    throw new Error(`auction slot must hold exactly ${AUCTION_WEEKLY_LOT_COUNT} lots`);
  }
  const seenItemIds = new Set();
  const lots = slot.lots.map((lot, index) => {
    const normalized = validateAuctionLot(lot, index, { bidderIds });
    if (seenItemIds.has(normalized.item.item_id)) throw new Error(`auction slot lots must be distinct items: ${normalized.item.item_id}`);
    seenItemIds.add(normalized.item.item_id);
    return normalized;
  });
  if (slot.status !== 'in_progress' && slot.status !== 'closed') {
    throw new Error(`auction slot status must be 'in_progress' or 'closed': ${slot.status}`);
  }
  const currentLotIndex = nonNegativeInteger(slot.current_lot_index, 'auction slot current_lot_index');
  if (currentLotIndex > AUCTION_WEEKLY_LOT_COUNT) throw new Error(`auction slot current_lot_index must be 0..${AUCTION_WEEKLY_LOT_COUNT}: got ${currentLotIndex}`);
  if (!Array.isArray(slot.awards)) throw new Error('auction slot awards must be an array');
  if (slot.awards.length !== currentLotIndex) {
    throw new Error(`auction slot awards length must equal current_lot_index (${currentLotIndex}): got ${slot.awards.length}`);
  }
  const awards = slot.awards.map((award, index) => validateAuctionAward(award, index, { lots, bidderIds }));
  // Progress ↔ status: the auction is closed exactly when all three lots have resolved.
  const closed = currentLotIndex === AUCTION_WEEKLY_LOT_COUNT;
  if (closed !== (slot.status === 'closed')) {
    throw new Error(`auction slot status ${slot.status} does not match current_lot_index ${currentLotIndex}`);
  }
  return { week, bidders, lots, status: slot.status, current_lot_index: currentLotIndex, awards };
}

export function readAuctionSlot(state) {
  requiredObject(state, 'runtime state is required to read the auction slot');
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_AUCTION_STATE_KEY)) return null;
  return validateAuctionSlot(state[ROUTING_AUCTION_STATE_KEY]);
}

// The auction slot for the current week, or null when none has been built for it (不在=未開催). A slot whose
// week differs from the current week is a stale earlier week and reads as "not held this week".
export function readAuctionSlotForWeek(state, week) {
  const slot = readAuctionSlot(state);
  if (!slot) return null;
  return slot.week === nonNegativeInteger(week, 'auction week') ? slot : null;
}

// Whether the current week's auction has closed (all three lots resolved) — the 同週再訪=閉場表示 judgment.
export function isAuctionClosedForWeek(state, week) {
  const slot = readAuctionSlotForWeek(state, week);
  return slot !== null && slot.status === 'closed';
}

// Builds the initial (un-started) slot from a weekly draw: all lots present, no lot resolved yet.
export function buildAuctionSlot({ week, bidders, lots }) {
  return validateAuctionSlot({
    week,
    bidders,
    lots,
    status: 'in_progress',
    current_lot_index: 0,
    awards: []
  });
}

// Records the resolution of the current lot (an award to the player or a bidder, or a pass-in) and advances
// the progress cursor, closing the auction after the third lot. Fails fast when the auction is already closed
// or the lot index is out of order. Returns the next validated slot.
export function recordAuctionLotAward(slot, { lotIndex, outcome, winnerCharacterId = null, amount = null }) {
  const current = validateAuctionSlot(slot);
  if (current.status === 'closed') throw new Error('cannot record an award: the auction is already closed');
  if (lotIndex !== current.current_lot_index) {
    throw new Error(`auction award must resolve the current lot ${current.current_lot_index}: got ${lotIndex}`);
  }
  const award = outcome === 'passed_in'
    ? { lot_index: lotIndex, outcome, winner_character_id: null, amount: null }
    : { lot_index: lotIndex, outcome, winner_character_id: winnerCharacterId, amount };
  const nextCursor = current.current_lot_index + 1;
  return validateAuctionSlot({
    ...current,
    current_lot_index: nextCursor,
    status: nextCursor === AUCTION_WEEKLY_LOT_COUNT ? 'closed' : 'in_progress',
    awards: [...current.awards, award]
  });
}

// ----- consignment (player-listed lot・出品側) -----
//
// The player consigns ONE owned asset per visit (an unequipped equipment instance or a sell_price>0 inventory
// item). It is a player asset, NOT a catalog item, so it carries its own presentation + provenance `source` and
// lives in its own state key. The seated NPC bidders are the week's slot bidders; the NPC-only bid loop settles
// exactly like a house lot (min increment / budgets / range re-validation are shared), but the player never bids.

const AUCTION_CONSIGNMENT_STATUSES = Object.freeze(['listed', 'resolved', 'skipped']);
// The consignable asset kinds: an unequipped equipment instance, a sell_price>0 inventory item, or a 星の揺り籠
// caged creature (a one-off instance from star_cradle_creatures.json・C-28 connection).
const AUCTION_CONSIGNMENT_SOURCE_KINDS = Object.freeze(['equipment', 'item', 'star_cradle_creature']);

// The consignment 市場評価額 (auction market value) multipliers. A player's shop/workshop sale price is far below the
// house落札 band 金額感 (C=300..1500 / B=1500..5000 / A=5000..15000 / S=15000..40000G), so the consignment band /
// initial price / NPC budget are calibrated off the sale price scaled up to a market value instead of the raw sale
// price. The multipliers are domain-owned tunables (not env-configurable, no default-value fallback), calibrated so
// the house equipment 写像 stays consistent on resale — tier3 excellent (sell 135)→2700=B, tier4 masterwork
// (sell 448)→8960=A — and 調合 product (sell 300/900/2600/7000)→900/2700/7800/21000=C/B/A/S.
export const AUCTION_CONSIGNMENT_EQUIPMENT_VALUE_MULTIPLIER = 20;
export const AUCTION_CONSIGNMENT_ITEM_VALUE_MULTIPLIER = 3;

// The market value of a consignable equipment instance: its deterministic sell price × the equipment multiplier. The
// sell price must be a positive integer (equipmentSellPrice's contract) — a non-positive value fails fast here rather
// than silently banding low.
export function auctionConsignmentEquipmentMarketValue(sellPrice) {
  return positiveInteger(sellPrice, 'consignment equipment sell price') * AUCTION_CONSIGNMENT_EQUIPMENT_VALUE_MULTIPLIER;
}

// The market value of a consignable inventory item: its sell_price × the item multiplier. Same positive-integer
// contract — a zero/negative sell_price item is not consignable and is rejected upstream, never banded from a fallback.
export function auctionConsignmentItemMarketValue(sellPrice) {
  return positiveInteger(sellPrice, 'consignment item sell price') * AUCTION_CONSIGNMENT_ITEM_VALUE_MULTIPLIER;
}

// Maps a player asset's G market value (equipment/item 市場評価額, or a caged creature's band floor) to an auction
// band: the lowest band whose price_max covers the value (a value at/below C's floor lands in C; above S's ceiling
// lands in S). Deterministic, no fallback band — the returned band drives the initial price / increment / budgets.
export function bandForConsignmentValue(catalog, valueAnchor) {
  const normalizedCatalog = catalog?.price_bands ? catalog : validateAuctionCatalog(catalog);
  const anchor = positiveInteger(valueAnchor, 'consignment value anchor');
  for (const band of AUCTION_BANDS) {
    if (anchor <= normalizedCatalog.price_bands[band].price_max) return band;
  }
  return AUCTION_BANDS[AUCTION_BANDS.length - 1];
}

function normalizeConsignmentSource(value) {
  const source = requiredObject(value, 'auction consignment source');
  const kind = requiredString(source.kind, 'auction consignment source.kind');
  if (!AUCTION_CONSIGNMENT_SOURCE_KINDS.includes(kind)) {
    throw new Error(`auction consignment source.kind must be one of: ${AUCTION_CONSIGNMENT_SOURCE_KINDS.join(', ')}`);
  }
  if (kind === 'equipment' || kind === 'star_cradle_creature') {
    assertExactKeys(source, ['kind', 'instance_id'], 'auction consignment source');
    return { kind, instance_id: requiredString(source.instance_id, 'auction consignment source.instance_id') };
  }
  assertExactKeys(source, ['kind', 'item_id'], 'auction consignment source');
  return { kind, item_id: requiredString(source.item_id, 'auction consignment source.item_id') };
}

function normalizeConsignmentPresentation(value) {
  const presentation = requiredObject(value, 'auction consignment presentation');
  assertExactKeys(presentation, ['name', 'category_label', 'blurb'], 'auction consignment presentation');
  return {
    name: requiredString(presentation.name, 'auction consignment presentation.name'),
    category_label: requiredString(presentation.category_label, 'auction consignment presentation.category_label'),
    blurb: requiredString(presentation.blurb, 'auction consignment presentation.blurb')
  };
}

function normalizeConsignmentBudgets(value) {
  requiredObject(value, 'auction consignment npc_budgets');
  const ids = Object.keys(value);
  if (ids.length < AUCTION_MIN_BIDDERS || ids.length > AUCTION_MAX_BIDDERS) {
    throw new Error(`auction consignment npc_budgets must carry ${AUCTION_MIN_BIDDERS}..${AUCTION_MAX_BIDDERS} bidder budgets`);
  }
  const budgets = {};
  for (const id of ids) {
    if (!CHARACTER_ID_PATTERN.test(id)) throw new Error(`auction consignment npc_budgets key must be a selectable character id: ${id}`);
    budgets[id] = positiveInteger(value[id], `auction consignment npc_budgets.${id}`);
  }
  return budgets;
}

// The consignment award: the winner is ALWAYS a seated NPC (never 'player' — the consigner does not bid on their
// own lot) or null (流札). An awarded consignment paid at least the initial price.
function validateConsignmentAward(value, { initialPrice }) {
  const award = requiredObject(value, 'auction consignment award');
  const outcome = requiredString(award.outcome, 'auction consignment award.outcome');
  if (!AUCTION_AWARD_OUTCOMES.includes(outcome)) {
    throw new Error(`auction consignment award.outcome must be one of: ${AUCTION_AWARD_OUTCOMES.join(', ')}`);
  }
  assertExactKeys(award, ['outcome', 'winner_character_id', 'amount'], 'auction consignment award');
  if (outcome === 'passed_in') {
    if (award.winner_character_id !== null) throw new Error('auction consignment passed_in award must have winner_character_id null');
    if (award.amount !== null) throw new Error('auction consignment passed_in award must have amount null');
    return { outcome, winner_character_id: null, amount: null };
  }
  const winner = requiredString(award.winner_character_id, 'auction consignment award.winner_character_id');
  if (!CHARACTER_ID_PATTERN.test(winner)) {
    throw new Error(`auction consignment award.winner_character_id must be a seated bidder id: ${winner}`);
  }
  const amount = positiveInteger(award.amount, 'auction consignment award.amount');
  if (amount < initialPrice) throw new Error(`auction consignment award.amount must be at least the initial price: ${amount} < ${initialPrice}`);
  return { outcome, winner_character_id: winner, amount };
}

// Validates a consignment record. `skipped` (the player declined to consign this visit) carries only week+status;
// `listed` / `resolved` carry the full lot. status ⟺ award: listed has award null, resolved has a non-null award.
export function validateConsignment(record) {
  const value = requiredObject(record, 'auction consignment');
  const status = requiredString(value.status, 'auction consignment status');
  if (!AUCTION_CONSIGNMENT_STATUSES.includes(status)) {
    throw new Error(`auction consignment status must be one of: ${AUCTION_CONSIGNMENT_STATUSES.join(', ')}`);
  }
  const week = nonNegativeInteger(value.week, 'auction consignment week');
  if (status === 'skipped') {
    assertExactKeys(value, ['week', 'status'], 'auction consignment');
    return { week, status };
  }
  assertExactKeys(value, ['week', 'status', 'source', 'presentation', 'band', 'initial_price', 'min_increment', 'npc_budgets', 'award'], 'auction consignment');
  const band = requiredString(value.band, 'auction consignment band');
  if (!AUCTION_BANDS.includes(band)) throw new Error(`auction consignment band must be one of: ${AUCTION_BANDS.join(', ')}`);
  const initialPrice = positiveInteger(value.initial_price, 'auction consignment initial_price');
  const award = value.award === null || value.award === undefined ? null : validateConsignmentAward(value.award, { initialPrice });
  if (status === 'listed' && award !== null) throw new Error('auction consignment status listed must have award null');
  if (status === 'resolved' && award === null) throw new Error('auction consignment status resolved must have a non-null award');
  return {
    week,
    status,
    source: normalizeConsignmentSource(value.source),
    presentation: normalizeConsignmentPresentation(value.presentation),
    band,
    initial_price: initialPrice,
    min_increment: positiveInteger(value.min_increment, 'auction consignment min_increment'),
    npc_budgets: normalizeConsignmentBudgets(value.npc_budgets),
    award
  };
}

// Builds the listed consignment lot from the player's chosen asset: the caller-resolved band, initial price =
// the value anchor clamped into the band, the band's minimum increment, and a per-bidder non-public budget rolled
// the same band-connected way house lots use (rng.int(price_min, price_max×1.2)), keyed on the source asset so a
// given asset always draws the same budgets in a given week. `bidders` are the week's seated slot bidders. The band
// is an explicit input (equipment/item map their value anchor through bandForConsignmentValue; a caged creature
// bands by its rarity/変貌 rule) — there is no hidden default band derivation here.
export function buildConsignmentLot({ week, source, presentation, band, valueAnchor, bidders, catalog }) {
  const normalizedWeek = nonNegativeInteger(week, 'auction week');
  const normalizedCatalog = catalog?.price_bands ? catalog : validateAuctionCatalog(catalog);
  const normalizedSource = normalizeConsignmentSource(source);
  const normalizedPresentation = normalizeConsignmentPresentation(presentation);
  const anchor = positiveInteger(valueAnchor, 'consignment value anchor');
  const seatedBidders = validateAuctionBidders(bidders, 'auction consignment bidders');
  const normalizedBand = requiredString(band, 'consignment band');
  if (!AUCTION_BANDS.includes(normalizedBand)) throw new Error(`consignment band must be one of: ${AUCTION_BANDS.join(', ')}: ${normalizedBand}`);
  const bandDef = normalizedCatalog.price_bands[normalizedBand];
  const initialPrice = Math.max(bandDef.price_min, Math.min(bandDef.price_max, anchor));
  const sourceKey = normalizedSource.kind === 'item' ? normalizedSource.item_id : normalizedSource.instance_id;
  const seed = auctionWeekSeed(normalizedWeek);
  const budgetCeiling = Math.floor(bandDef.price_max * AUCTION_NPC_BUDGET_CEILING_NUMERATOR / AUCTION_NPC_BUDGET_CEILING_DENOMINATOR);
  const npcBudgets = {};
  for (const bidder of seatedBidders) {
    const budgetRng = createRng(deriveSeed(seed, stableHash(`auction-consign-budget:${bidder.character_id}:${sourceKey}`)));
    npcBudgets[bidder.character_id] = budgetRng.int(bandDef.price_min, budgetCeiling);
  }
  return validateConsignment({
    week: normalizedWeek,
    status: 'listed',
    source: normalizedSource,
    presentation: normalizedPresentation,
    band: normalizedBand,
    initial_price: initialPrice,
    min_increment: bandDef.min_increment,
    npc_budgets: npcBudgets,
    award: null
  });
}

// The skipped consignment (the player chose not to list anything this visit): a terminal per-week decision.
export function buildConsignmentSkip(week) {
  return validateConsignment({ week: nonNegativeInteger(week, 'auction week'), status: 'skipped' });
}

export function readConsignment(state) {
  requiredObject(state, 'runtime state is required to read the auction consignment');
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_AUCTION_CONSIGNMENT_STATE_KEY)) return null;
  return validateConsignment(state[ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]);
}

// The consignment for the current week, or null when none has been decided for it. A record from an earlier week
// reads as "not decided this week" (a fresh visit re-decides), matching readAuctionSlotForWeek.
export function readConsignmentForWeek(state, week) {
  const record = readConsignment(state);
  if (!record) return null;
  return record.week === nonNegativeInteger(week, 'auction week') ? record : null;
}

// ----- stale bidder-range save cleanup -----

// Whether a persisted bidder count sits outside the current seated range. The strict validators accept exactly
// AUCTION_MIN_BIDDERS..AUCTION_MAX_BIDDERS, so a count outside it is residue from an earlier range.
function bidderCountOutsideRange(count) {
  return count < AUCTION_MIN_BIDDERS || count > AUCTION_MAX_BIDDERS;
}

// Plans removal of stale auction state whose seated bidder count is outside the current range. validateAuctionSlot
// / validateConsignment run on read BEFORE the week-staleness check (readAuctionSlot → validateAuctionSlot), so a
// persisted routing_auction slot or routing_auction_consignment record left by an earlier bidder range throws on
// the next auction visit and blocks entry instead of being rebuilt by the weekly draw. This planner deletes exactly
// that residue — a routing_auction whose `bidders` array, or a routing_auction_consignment whose `npc_budgets`
// object, holds a count outside the current range — so the next visit rebuilds a fresh in-range week. It keys ONLY
// on the seated bidder count: any other malformed shape is left untouched for the strict validators to surface (no
// silent normalization, no compat fill). A skipped consignment carries no npc_budgets and is never touched. Returns
// the removed keys and the next state (null when nothing changed). Pure: no filesystem, no mutation of the input.
export function planStaleAuctionBidderStateRemoval(state) {
  requiredObject(state, 'runtime state is required to plan stale auction bidder-state removal');
  const removed = [];
  const next = { ...state };

  const slot = next[ROUTING_AUCTION_STATE_KEY];
  if (isPlainObject(slot) && Array.isArray(slot.bidders) && bidderCountOutsideRange(slot.bidders.length)) {
    delete next[ROUTING_AUCTION_STATE_KEY];
    removed.push(ROUTING_AUCTION_STATE_KEY);
  }

  const consignment = next[ROUTING_AUCTION_CONSIGNMENT_STATE_KEY];
  if (isPlainObject(consignment) && isPlainObject(consignment.npc_budgets)
    && bidderCountOutsideRange(Object.keys(consignment.npc_budgets).length)) {
    delete next[ROUTING_AUCTION_CONSIGNMENT_STATE_KEY];
    removed.push(ROUTING_AUCTION_CONSIGNMENT_STATE_KEY);
  }

  return { removed, next: removed.length > 0 ? next : null };
}

// Records the resolution of the listed consignment (an NPC award or a 流札). Fails fast unless currently `listed`.
export function recordConsignmentResolution(record, { outcome, winnerCharacterId = null, amount = null }) {
  const current = validateConsignment(record);
  if (current.status !== 'listed') throw new Error(`cannot resolve auction consignment in status ${current.status}`);
  const award = outcome === 'passed_in'
    ? { outcome, winner_character_id: null, amount: null }
    : { outcome, winner_character_id: winnerCharacterId, amount };
  return validateConsignment({ ...current, status: 'resolved', award });
}

// ----- persistent sold ledger (one-of-a-kind removal across weeks) -----

export function readAuctionSoldLedger(state) {
  requiredObject(state, 'runtime state is required to read the auction sold ledger');
  if (!Object.prototype.hasOwnProperty.call(state, AUCTION_SOLD_LEDGER_STATE_KEY)) return [];
  const value = state[AUCTION_SOLD_LEDGER_STATE_KEY];
  if (!Array.isArray(value)) throw new Error('auction sold ledger must be an array of item_ids');
  const seen = new Set();
  const ledger = [];
  for (const entry of value) {
    const itemId = requiredString(entry, 'auction sold ledger entry');
    if (!AUCTION_ITEM_ID_PATTERN.test(itemId)) throw new Error(`auction sold ledger entry must be an auction item_id: ${itemId}`);
    if (seen.has(itemId)) throw new Error(`auction sold ledger has a duplicate entry: ${itemId}`);
    seen.add(itemId);
    ledger.push(itemId);
  }
  return ledger;
}

// The next sold ledger after a one-of-a-kind item is awarded (to the player OR an NPC — a sold unique item
// leaves the world either way). A re-listable (treasure/flavor) item is never recorded; a duplicate append is
// a no-op (idempotent). The item must be a known catalog item.
export function nextAuctionSoldLedger({ ledger, catalog, itemId }) {
  const current = readAuctionSoldLedger({ [AUCTION_SOLD_LEDGER_STATE_KEY]: ledger });
  const item = auctionCatalogItem(catalog, itemId);
  if (!ONE_OF_A_KIND_CATEGORIES.has(item.category)) return current;
  if (current.includes(item.item_id)) return current;
  return [...current, item.item_id];
}

// ----- being parameters (band-scaled, deterministic from item_id) -----

export function generateAuctionBeingParameters({ band, itemId }) {
  const range = AUCTION_BEING_PARAMETER_RANGE[requiredString(band, 'auction being band')];
  if (!range) throw new Error(`auction being band must have a parameter range (B/A/S): ${band}`);
  const normalizedId = requiredString(itemId, 'auction being item_id');
  const rng = createRng(deriveSeed(stableHash(`auction-being-params:${normalizedId}`), 1));
  const magic = Object.fromEntries(MAGIC_KEYS.map((key) => [key, rng.int(range.min, range.max)]));
  const abilities = Object.fromEntries(ABILITY_KEYS.map((key) => [key, rng.int(range.min, range.max)]));
  return normalizeParameters({ magic, abilities });
}

// ----- weapon/amulet equipment derivation (deterministic from item + week) -----

function auctionBaseEffects(kind, weaponType, tier) {
  if (kind === 'amulet') return { defense: 2 + tier, max_hp: 4 + 3 * tier };
  if (weaponType === 'sword') return { attack: 3 + 2 * tier, max_hp: 2 + 2 * tier };
  if (weaponType === 'staff') return { max_mp: 2 + 2 * tier, element_spell_power: 2 + 2 * tier };
  if (weaponType === 'short_rod') return { spell_mp_discount: tier, max_mp: 1 + 2 * tier };
  throw new Error(`unknown auction weapon_type for base effects: ${weaponType}`);
}

function auctionBonusEffects({ kind, band, rng }) {
  const shape = AUCTION_EQUIP_BONUS_BY_BAND[band];
  if (!shape) throw new Error(`auction equipment band must have a bonus shape (B/A/S): ${band}`);
  const pool = kind === 'weapon' ? AUCTION_WEAPON_BONUS_POOL : AUCTION_AMULET_BONUS_POOL;
  const [low, high] = shape.band;
  const bonus = {};
  for (const key of rng.shuffle(pool).slice(0, shape.lines)) {
    bonus[key] = rng.int(low, high);
  }
  return bonus;
}

// Previews the confirmed one-of-a-kind roll for a weapon/amulet lot WITHOUT the LLM 銘/来歴: kind/weapon_type
// from the 骨子, tier/quality from the 格 (band), a week-rolled element, and deterministically rolled base and
// bonus effects. Byte-identical to what deriveAuctionEquipmentInstance will build (they share this roll), so
// the naming prompt can be built from the exact item the award will mint — the same preview→name→build gate
// discipline as the workshop's previewCraft. Returns the roll summary { instance_id, kind, weapon_type?,
// element, tier, quality, base_effects, bonus_effects }.
export function previewAuctionEquipmentRoll({ item, week }) {
  const normalizedItem = validateAuctionItem(item, 0);
  if (normalizedItem.category !== 'weapon_amulet') throw new Error(`auction equipment derivation requires a weapon_amulet item: ${normalizedItem.category}`);
  const normalizedWeek = nonNegativeInteger(week, 'auction week');
  const kind = normalizedItem.weapon_kind === 'amulet' ? 'amulet' : 'weapon';
  const weaponType = kind === 'weapon' ? normalizedItem.weapon_kind : null;
  if (kind === 'weapon' && !WEAPON_TYPES.includes(weaponType)) throw new Error(`auction weapon_kind is not a weapon type: ${weaponType}`);
  const tier = AUCTION_EQUIP_TIER_BY_BAND[normalizedItem.band];
  const quality = AUCTION_EQUIP_QUALITY_BY_BAND[normalizedItem.band];
  if (!tier || !quality || !EQUIPMENT_QUALITIES.includes(quality)) {
    throw new Error(`auction weapon/amulet band must have a tier and quality (B/A/S): ${normalizedItem.band}`);
  }
  const rng = createRng(deriveSeed(auctionWeekSeed(normalizedWeek), stableHash(`auction-equip:${normalizedItem.item_id}`)));
  const element = rng.pick(MAGIC_KEYS);
  return {
    instance_id: `auction_equip_${normalizedItem.item_id}_w${normalizedWeek}`,
    kind,
    ...(kind === 'weapon' ? { weapon_type: weaponType } : {}),
    element,
    tier,
    quality,
    base_effects: auctionBaseEffects(kind, weaponType, tier),
    bonus_effects: auctionBonusEffects({ kind, band: normalizedItem.band, rng })
  };
}

// Derives the one-of-a-kind equipment instance for a weapon/amulet lot: the confirmed roll (previewAuction-
// EquipmentRoll) plus the LLM-supplied 銘/来歴 (name/flavor — input to this layer, never generated here).
// Returns a validated equipment instance.
export function deriveAuctionEquipmentInstance({ item, week, name, flavor }) {
  const craftedName = requiredString(name, 'auction equipment name');
  const craftedFlavor = requiredString(flavor, 'auction equipment flavor');
  const roll = previewAuctionEquipmentRoll({ item, week });
  return validateEquipmentInstance({ ...roll, name: craftedName, flavor: craftedFlavor });
}
