// Routing "last dispatched content result" record.
//
// A single overwrite-only slot on runtime_state that captures what happened at
// the most recent routing dispatch's content destination — a training week, a
// dungeon run, an errand, an alchemy recipe, or a fixed week event — so the routing hub (ルミ) can be told,
// on the next hub entry, what the player actually did where they were sent.
//
// Invariants:
// - Only routing mode writes this record. Loop-mode training/dungeon never
//   touches it, so loop runtime_state stays byte-identical.
// - The slot holds only the latest result (no history); every new content result
//   destructively replaces it.
// - The record carries `week` + `destination_id` + `trigger` (+ `recorded_at`) so
//   a reader can judge freshness: whether it is the result of the most recent
//   dispatch, or an older one that a later academy-map (conversation) dispatch has
//   since outdated. Academy-map dispatches never write a record — their result is
//   picked up on the conversation-memory side — so a map dispatch simply leaves the
//   older training/dungeon/errand/alchemy record in place with a now-stale `week`.
// - Absence of the slot is the honest "no recent content result" state; it is never
//   fabricated into an empty record. A present-but-malformed record fails fast.

import { EQUIPMENT_KINDS, WEAPON_TYPES, EQUIPMENT_QUALITIES } from './equipment.mjs';
import { ALCHEMY_ITEM_CATEGORIES } from './alchemyDefinitions.mjs';
import { isHomunculusFaceId } from './homunculusSurface.mjs';

export const ROUTING_CONTENT_RESULT_STATE_KEY = 'last_routing_content_result';
export const ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY = 'routing_training_week_accumulator';

const CONTENT_KINDS = Object.freeze(['training', 'dungeon', 'errand', 'alchemy', 'study_circle', 'workshop', 'library', 'homunculus', 'arena', 'auction', 'lounge']);
// The layer vocabulary shared by library collection entries and library content-result books:
// core / periphery are catalog books (book_id present), generated is a catalog-external book (book_id null).
const LIBRARY_BOOK_LAYERS = Object.freeze(['core', 'periphery', 'generated']);
const TRAINING_OUTCOMES = Object.freeze(['completed', 'skipped']);
const EFFECT_GROUPS = Object.freeze(['magic', 'abilities']);
// destination_id and trigger are enumerated and kind-consistent: a training record
// is always destination 'training' with a training_* trigger, a dungeon record is
// always destination 'dungeon' with the dungeon_run_committed trigger. A mismatched
// pair (e.g. kind training + trigger dungeon_run_committed) is corrupt and fails fast.
const TRAINING_TRIGGERS = Object.freeze(['training_completed', 'training_skipped']);
const DUNGEON_TRIGGER = 'dungeon_run_committed';
const ERRAND_TRIGGER = 'errand_completed';
const ALCHEMY_TRIGGER = 'alchemy_recipe_completed';
const STUDY_CIRCLE_TRIGGER = 'study_circle_completed';
const WORKSHOP_TRIGGER = 'workshop_craft_completed';
const LIBRARY_TRIGGER = 'library_reading_committed';
const ARENA_TRIGGER = 'arena_tournament_concluded';
const AUCTION_TRIGGER = 'auction_concluded';
const LOUNGE_TRIGGER = 'lounge_concluded';
// The 談話室 content result summarizes one week's group talk: the three学友 who sat in the round (identity only).
// The raw transcript is discarded at finalization, so the hub only recalls WHO the player talked with, not what
// was said. The vocabulary is a fixed three-participant set so a corrupt persisted detail fails fast.
const LOUNGE_PARTICIPANT_COUNT = 3;
// The 競売場 content result summarizes one week's closed auction (all three lots resolved): per lot, the
// item's identity and how it resolved. `won_by_player` is what the player acquired this week; `won_by_other`
// is an NPC win (a one-of-a-kind that left the world); `passed_in` is 流札 (no bid). The vocabulary is closed
// so a corrupt persisted detail fails fast rather than reaching the hub renderer.
const AUCTION_LOT_RESULTS = Object.freeze(['won_by_player', 'won_by_other', 'passed_in']);
const AUCTION_DETAIL_CATEGORIES = Object.freeze(['weapon_amulet', 'treasure', 'being', 'flavor', 'caged_creature']);
const AUCTION_DETAIL_BANDS = Object.freeze(['C', 'B', 'A', 'S']);
const AUCTION_WEEKLY_LOT_COUNT = 3;
// The 闘技会 outcome vocabulary: champion / eliminated for a participated tournament (solo / pair), and the
// spectated_* pair for a バディー観戦 tournament. The mode↔outcome consistency is enforced below.
const ARENA_OUTCOMES = Object.freeze(['champion', 'eliminated', 'spectated_champion', 'spectated_eliminated']);
const ARENA_MODES = Object.freeze(['solo', 'pair', 'spectate']);
const ARENA_MAX_WINS = 4;
// The 錬成室 content result is one kind with three narrow triggers: the player synthesized a child, talked
// to one, or farewelled one. Only the farewell trigger carries an epitaph (the nameplate line left on the
// shelf); the other two carry the child's hub-relevant identity only.
const HOMUNCULUS_CREATED_TRIGGER = 'homunculus_created';
const HOMUNCULUS_CONVERSATION_TRIGGER = 'homunculus_conversation_completed';
const HOMUNCULUS_FAREWELL_TRIGGER = 'homunculus_farewelled';
const HOMUNCULUS_TRIGGERS = Object.freeze([HOMUNCULUS_CREATED_TRIGGER, HOMUNCULUS_CONVERSATION_TRIGGER, HOMUNCULUS_FAREWELL_TRIGGER]);
// Format-only checks (the surface owns the authoritative id/face validation); a corrupt persisted content
// result fails fast here rather than reaching the hub renderer.
const HOMUNCULUS_CONTENT_ID_PATTERN = /^homunculus_\d{3}$/;
// A homunculus-shaped actor's face is either an atelier pool face (hp_NNN) or an auction being pool face
// (ab_NNN): an auction-adopted being (競売場の子) is a homunculus-shaped actor whose conversation content result
// must carry its ab_ face. Both pools mint homunculus_NNN actors on the one 錬成室 surface (C-27). Membership
// is checked through the surface's `isHomunculusFaceId` so the closed face vocabulary has one source of truth.

function assertRecordedAt(now) {
  if (typeof now !== 'string' || !now) {
    throw new Error('routing content result requires a non-empty recorded_at timestamp');
  }
  return now;
}

// The freshness key. Routing state always carries a non-negative integer
// elapsed_weeks; a missing or malformed value is a corrupt state, not a default.
// The stored value must already BE a non-negative integer — no numeric coercion,
// so a wrong-typed `"2"` fails fast rather than being silently accepted as 2.
export function requireRoutingContentWeek(state) {
  const week = state?.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw new Error('routing content result requires state.elapsed_weeks to be a non-negative integer');
  }
  return week;
}

function assertNonNegativeIntegerWeek(week) {
  if (!Number.isInteger(week) || week < 0) {
    throw new Error(`routing content result week must be a non-negative integer: ${week}`);
  }
  return week;
}

function validateParameterDeltaMap(map, label) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${label} must be a { magic, abilities } object`);
  }
  for (const key of Object.keys(map)) {
    if (!EFFECT_GROUPS.includes(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const group of EFFECT_GROUPS) {
    const groupMap = map[group];
    if (!groupMap || typeof groupMap !== 'object' || Array.isArray(groupMap)) {
      throw new Error(`${label}.${group} must be an object`);
    }
    for (const [key, value] of Object.entries(groupMap)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label}.${group}.${key} must be a finite number`);
      }
    }
  }
}

// Strictly validates a { magic, abilities } delta/gain map and returns a faithful
// deep copy. A malformed map (missing group, non-object group, non-finite value)
// throws rather than being silently normalized into a partial map.
function assertAndCopyParameterDeltaMap(map, label) {
  validateParameterDeltaMap(map, label);
  const result = { magic: {}, abilities: {} };
  for (const group of EFFECT_GROUPS) {
    for (const [key, value] of Object.entries(map[group])) result[group][key] = value;
  }
  return result;
}

// Validates a present training week accumulator (the in-progress runtime_state
// field). A non-null but malformed accumulator is corrupt state and throws; a null
// accumulator is the legitimate "seed a fresh week" signal handled by callers.
function assertTrainingWeekAccumulator(accumulator) {
  if (!accumulator || typeof accumulator !== 'object' || Array.isArray(accumulator)) {
    throw new Error('routing training week accumulator must be a non-null object');
  }
  if (!Number.isInteger(accumulator.week) || accumulator.week < 0) {
    throw new Error('routing training week accumulator requires a non-negative integer week');
  }
  if (accumulator.destination_id !== 'training') {
    throw new Error("routing training week accumulator destination_id must be 'training'");
  }
  validateTrainingEntries(accumulator.trainings, 'routing training week accumulator');
  validateParameterDeltaMap(accumulator.parameter_deltas, 'routing training week accumulator parameter_deltas');
  return accumulator;
}

// Validates the per-day training entry list against the published shape: each entry
// is an object with a non-negative integer day_index and non-empty day_name,
// training_id, and training_name strings.
function validateTrainingEntries(trainings, label) {
  if (!Array.isArray(trainings)) {
    throw new Error(`${label} requires a trainings array`);
  }
  for (const entry of trainings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} trainings entries must be objects`);
    }
    if (!Number.isInteger(entry.day_index) || entry.day_index < 0) {
      throw new Error(`${label} entry requires a non-negative integer day_index`);
    }
    if (typeof entry.day_name !== 'string' || !entry.day_name) {
      throw new Error(`${label} entry requires a non-empty day_name`);
    }
    if (typeof entry.training_id !== 'string' || !entry.training_id) {
      throw new Error(`${label} entry requires a non-empty training_id`);
    }
    if (typeof entry.training_name !== 'string' || !entry.training_name) {
      throw new Error(`${label} entry requires a non-empty training_name`);
    }
  }
}

function validateTrainingDetail(detail) {
  if (!TRAINING_OUTCOMES.includes(detail.outcome)) {
    throw new Error(`routing training content result outcome must be one of: ${TRAINING_OUTCOMES.join(', ')}`);
  }
  validateTrainingEntries(detail.trainings, 'routing training content result');
  validateParameterDeltaMap(detail.parameter_deltas, 'routing training content result parameter_deltas');
}

// Carried/lost run materials. Additive: absent on records written before the drop
// system, so a missing field is the honest "no material record" and is tolerated on
// read; a present field must be a well-formed { items, retained }.
function validateDungeonMaterialsDetail(materials) {
  if (!materials || typeof materials !== 'object' || Array.isArray(materials)) {
    throw new Error('routing dungeon content result materials must be an object');
  }
  assertExactKeys(materials, new Set(['items', 'retained']), 'routing dungeon content result materials');
  if (typeof materials.retained !== 'boolean') {
    throw new Error('routing dungeon content result materials.retained must be a boolean');
  }
  if (!Array.isArray(materials.items)) {
    throw new Error('routing dungeon content result materials.items must be an array');
  }
  for (const item of materials.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('routing dungeon content result materials.items entries must be objects');
    }
    assertExactKeys(item, new Set(['item_id', 'display_name', 'quantity']), 'routing dungeon content result materials item');
    if (typeof item.item_id !== 'string' || !item.item_id) {
      throw new Error('routing dungeon content result material item_id must be a non-empty string');
    }
    if (typeof item.display_name !== 'string' || !item.display_name) {
      throw new Error('routing dungeon content result material display_name must be a non-empty string');
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error('routing dungeon content result material quantity must be a positive integer');
    }
  }
}

function copyDungeonMaterials(materials) {
  validateDungeonMaterialsDetail(materials);
  return {
    retained: materials.retained,
    items: materials.items.map((item) => ({ item_id: item.item_id, display_name: item.display_name, quantity: item.quantity }))
  };
}

// Carried/lost boss-chest equipment. Additive: absent on records written before the boss-chest
// feature. Same { items, retained } greed-ladder shape as materials, but each item is a finished
// weapon/amulet identity (instance_id + kind/weapon_type/element/tier/quality + name/flavor) in the
// frozen equipment vocabulary — a corrupt persisted detail fails fast rather than reaching the hub.
function validateDungeonEquipmentItem(item, label) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} must be an object`);
  const baseKeys = ['instance_id', 'kind', 'element', 'tier', 'quality', 'name', 'flavor'];
  assertExactKeys(item, new Set(item.kind === 'weapon' ? [...baseKeys, 'weapon_type'] : baseKeys), label);
  if (typeof item.instance_id !== 'string' || !item.instance_id) throw new Error(`${label} requires a non-empty instance_id`);
  if (!EQUIPMENT_KINDS.includes(item.kind)) throw new Error(`${label} kind must be one of: ${EQUIPMENT_KINDS.join(', ')}`);
  if (item.kind === 'weapon' && !WEAPON_TYPES.includes(item.weapon_type)) {
    throw new Error(`${label} weapon_type must be one of: ${WEAPON_TYPES.join(', ')}`);
  }
  if (typeof item.element !== 'string' || !item.element) throw new Error(`${label} requires a non-empty element`);
  if (!Number.isInteger(item.tier) || item.tier < 1 || item.tier > 4) throw new Error(`${label} requires an integer tier 1..4`);
  if (!EQUIPMENT_QUALITIES.includes(item.quality)) throw new Error(`${label} quality must be one of: ${EQUIPMENT_QUALITIES.join(', ')}`);
  if (typeof item.name !== 'string' || !item.name) throw new Error(`${label} requires a non-empty name`);
  if (typeof item.flavor !== 'string' || !item.flavor) throw new Error(`${label} requires a non-empty flavor`);
}

function validateDungeonEquipmentDetail(equipment) {
  if (!equipment || typeof equipment !== 'object' || Array.isArray(equipment)) {
    throw new Error('routing dungeon content result equipment must be an object');
  }
  assertExactKeys(equipment, new Set(['items', 'retained']), 'routing dungeon content result equipment');
  if (typeof equipment.retained !== 'boolean') {
    throw new Error('routing dungeon content result equipment.retained must be a boolean');
  }
  if (!Array.isArray(equipment.items)) {
    throw new Error('routing dungeon content result equipment.items must be an array');
  }
  equipment.items.forEach((item, index) => validateDungeonEquipmentItem(item, `routing dungeon content result equipment item[${index}]`));
}

function copyDungeonEquipment(equipment) {
  validateDungeonEquipmentDetail(equipment);
  return {
    retained: equipment.retained,
    items: equipment.items.map((item) => ({
      instance_id: item.instance_id,
      kind: item.kind,
      ...(item.kind === 'weapon' ? { weapon_type: item.weapon_type } : {}),
      element: item.element,
      tier: item.tier,
      quality: item.quality,
      name: item.name,
      flavor: item.flavor
    }))
  };
}

function validateDungeonDetail(detail) {
  if (typeof detail.outcome !== 'string' || !detail.outcome) {
    throw new Error('routing dungeon content result requires a non-empty outcome');
  }
  if (!Number.isInteger(detail.floor_reached) || detail.floor_reached < 0) {
    throw new Error('routing dungeon content result requires a non-negative integer floor_reached');
  }
  if (!Number.isInteger(detail.max_floors) || detail.max_floors < 0) {
    throw new Error('routing dungeon content result requires a non-negative integer max_floors');
  }
  validateParameterDeltaMap(detail.applied_gains, 'routing dungeon content result applied_gains');
  if (!Number.isInteger(detail.total_applied) || detail.total_applied < 0) {
    throw new Error('routing dungeon content result requires a non-negative integer total_applied');
  }
  if (detail.companion_character_id !== null
    && (typeof detail.companion_character_id !== 'string' || !detail.companion_character_id)) {
    throw new Error('routing dungeon content result companion_character_id must be a non-empty string or null');
  }
  if (detail.materials !== undefined) validateDungeonMaterialsDetail(detail.materials);
  if (detail.equipment !== undefined) validateDungeonEquipmentDetail(detail.equipment);
}

function validateErrandDetail(detail) {
  if (detail.outcome !== 'completed') {
    throw new Error("routing errand content result outcome must be 'completed'");
  }
  if (typeof detail.achieved !== 'boolean') {
    throw new Error('routing errand content result requires a boolean achieved');
  }
  if (typeof detail.errand_id !== 'string' || !detail.errand_id) {
    throw new Error('routing errand content result requires a non-empty errand_id');
  }
  if (typeof detail.title !== 'string' || !detail.title) {
    throw new Error('routing errand content result requires a non-empty title');
  }
  // reward_money is the amount actually paid: a positive band reward when the condition was met,
  // exactly 0 when the errand was left unachieved. The two must agree so an unachieved record can
  // never carry a paid reward and an achieved one can never carry none.
  if (!Number.isInteger(detail.reward_money) || detail.reward_money < 0) {
    throw new Error('routing errand content result requires a non-negative integer reward_money');
  }
  if (detail.achieved && detail.reward_money <= 0) {
    throw new Error('routing errand content result achieved requires a positive reward_money');
  }
  if (!detail.achieved && detail.reward_money !== 0) {
    throw new Error('routing errand content result unachieved requires reward_money 0');
  }
  if (typeof detail.client_character_id !== 'string' || !detail.client_character_id) {
    throw new Error('routing errand content result requires a non-empty client_character_id');
  }
  if (typeof detail.client_display_name !== 'string' || !detail.client_display_name) {
    throw new Error('routing errand content result requires a non-empty client_display_name');
  }
}

// The crafted item summary for one alchemy craft: the recipe, the produced item's identity
// (item_id / name / category), and how many were made. All alchemy results are items now (the
// effect lives in the item's own definition), so the detail is a flat item record.
const ALCHEMY_CONTENT_ITEM_ID_PATTERN = /^alchemy_[a-z0-9_]+$/;

function validateAlchemyDetail(detail) {
  assertExactKeys(detail, new Set(['outcome', 'recipe_id', 'item_id', 'name', 'category', 'quantity']), 'routing alchemy content result detail');
  if (detail.outcome !== 'completed') {
    throw new Error("routing alchemy content result outcome must be 'completed'");
  }
  if (typeof detail.recipe_id !== 'string' || !detail.recipe_id) {
    throw new Error('routing alchemy content result requires a non-empty recipe_id');
  }
  if (typeof detail.item_id !== 'string' || !ALCHEMY_CONTENT_ITEM_ID_PATTERN.test(detail.item_id)) {
    throw new Error('routing alchemy content result requires an alchemy_ item_id');
  }
  if (typeof detail.name !== 'string' || !detail.name) {
    throw new Error('routing alchemy content result requires a non-empty name');
  }
  if (!ALCHEMY_ITEM_CATEGORIES.includes(detail.category)) {
    throw new Error(`routing alchemy content result category must be one of: ${ALCHEMY_ITEM_CATEGORIES.join(', ')}`);
  }
  if (!Number.isInteger(detail.quantity) || detail.quantity <= 0) {
    throw new Error('routing alchemy content result requires a positive integer quantity');
  }
}

function parameterDeltaMapHasEntries(map) {
  return EFFECT_GROUPS.some((group) => Object.keys(map[group] ?? {}).length > 0);
}

function validateStudyCircleDetail(detail) {
  const expectedKeys = new Set(['outcome', 'achieved', 'theme_id', 'theme_name', 'host_character_id', 'host_display_name', 'parameter_deltas']);
  for (const key of Object.keys(detail)) {
    if (!expectedKeys.has(key)) throw new Error(`study circle content result detail has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(detail, key)) throw new Error(`study circle content result detail is missing required key: ${key}`);
  }
  if (detail.outcome !== 'completed') {
    throw new Error("routing study circle content result outcome must be 'completed'");
  }
  if (typeof detail.achieved !== 'boolean') {
    throw new Error('routing study circle content result requires a boolean achieved');
  }
  if (typeof detail.theme_id !== 'string' || !detail.theme_id) {
    throw new Error('routing study circle content result requires a non-empty theme_id');
  }
  if (typeof detail.theme_name !== 'string' || !detail.theme_name) {
    throw new Error('routing study circle content result requires a non-empty theme_name');
  }
  if (typeof detail.host_character_id !== 'string' || !detail.host_character_id) {
    throw new Error('routing study circle content result requires a non-empty host_character_id');
  }
  if (typeof detail.host_display_name !== 'string' || !detail.host_display_name) {
    throw new Error('routing study circle content result requires a non-empty host_display_name');
  }
  validateParameterDeltaMap(detail.parameter_deltas, 'routing study circle content result parameter_deltas');
  // parameter_deltas is the reward actually applied: the band deltas when achieved, none when unachieved.
  // The two must agree so an unachieved record can never carry a grant and an achieved one can never carry none.
  const hasDeltas = parameterDeltaMapHasEntries(detail.parameter_deltas);
  if (detail.achieved && !hasDeltas) {
    throw new Error('routing study circle content result achieved requires non-empty parameter_deltas');
  }
  if (!detail.achieved && hasDeltas) {
    throw new Error('routing study circle content result unachieved requires empty parameter_deltas');
  }
}

// A finished-craft summary: the recipe, the item identity (kind/weapon_type/element/
// tier), the rolled quality, and the LLM-supplied name/flavor. Weapons carry a
// weapon_type; amulets do not. The vocabulary is the frozen equipment vocabulary, so
// a corrupt persisted detail fails fast rather than being silently accepted.
function validateWorkshopDetail(detail) {
  const baseKeys = ['outcome', 'recipe_id', 'kind', 'element', 'tier', 'quality', 'name', 'flavor'];
  assertExactKeys(detail, new Set(detail.kind === 'weapon' ? [...baseKeys, 'weapon_type'] : baseKeys), 'routing workshop content result detail');
  if (detail.outcome !== 'completed') {
    throw new Error("routing workshop content result outcome must be 'completed'");
  }
  if (!EQUIPMENT_KINDS.includes(detail.kind)) {
    throw new Error(`routing workshop content result kind must be one of: ${EQUIPMENT_KINDS.join(', ')}`);
  }
  if (detail.kind === 'weapon' && !WEAPON_TYPES.includes(detail.weapon_type)) {
    throw new Error(`routing workshop content result weapon_type must be one of: ${WEAPON_TYPES.join(', ')}`);
  }
  if (typeof detail.recipe_id !== 'string' || !detail.recipe_id) {
    throw new Error('routing workshop content result requires a non-empty recipe_id');
  }
  if (typeof detail.element !== 'string' || !detail.element) {
    throw new Error('routing workshop content result requires a non-empty element');
  }
  if (!Number.isInteger(detail.tier) || detail.tier < 1 || detail.tier > 4) {
    throw new Error('routing workshop content result requires an integer tier 1..4');
  }
  if (!EQUIPMENT_QUALITIES.includes(detail.quality)) {
    throw new Error(`routing workshop content result quality must be one of: ${EQUIPMENT_QUALITIES.join(', ')}`);
  }
  if (typeof detail.name !== 'string' || !detail.name) {
    throw new Error('routing workshop content result requires a non-empty name');
  }
  if (typeof detail.flavor !== 'string' || !detail.flavor) {
    throw new Error('routing workshop content result requires a non-empty flavor');
  }
}

function assertExactKeys(value, expectedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

// One read book in a library content result: identity only (no text — the fragment lives in
// the collection surface). layer is core / periphery / generated; generated ⟺ book_id null,
// a catalog book carries a non-empty book_id.
function copyLibraryBook(book, label) {
  if (!book || typeof book !== 'object' || Array.isArray(book)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(book, new Set(['book_id', 'title', 'category', 'layer']), label);
  if (!LIBRARY_BOOK_LAYERS.includes(book.layer)) {
    throw new Error(`${label} layer must be one of: ${LIBRARY_BOOK_LAYERS.join(', ')}`);
  }
  if (typeof book.title !== 'string' || !book.title) throw new Error(`${label} requires a non-empty title`);
  if (typeof book.category !== 'string' || !book.category) throw new Error(`${label} requires a non-empty category`);
  if (book.layer === 'generated') {
    if (book.book_id !== null) throw new Error(`${label} generated book book_id must be null`);
  } else if (typeof book.book_id !== 'string' || !book.book_id) {
    throw new Error(`${label} ${book.layer} book requires a non-empty book_id`);
  }
  return { book_id: book.book_id, title: book.title, category: book.category, layer: book.layer };
}

function validateLibraryDetail(detail) {
  assertExactKeys(detail, new Set(['outcome', 'books']), 'routing library content result detail');
  if (detail.outcome !== 'completed') {
    throw new Error("routing library content result outcome must be 'completed'");
  }
  if (!Array.isArray(detail.books) || detail.books.length === 0) {
    throw new Error('routing library content result requires a non-empty books array');
  }
  detail.books.forEach((book, index) => copyLibraryBook(book, `routing library content result books[${index}]`));
}

// The 錬成室 detail: identity (homunculus_id / display_name / face_id) for every trigger, plus an epitaph
// ONLY for the farewell trigger (the nameplate line). The trigger selects the closed key set; a key mismatch
// inside a trigger, a malformed id/face, or an empty string fails fast.
function validateHomunculusDetail(detail, trigger) {
  const baseKeys = ['action', 'homunculus_id', 'display_name', 'face_id'];
  const isFarewell = trigger === HOMUNCULUS_FAREWELL_TRIGGER;
  assertExactKeys(detail, new Set(isFarewell ? [...baseKeys, 'epitaph'] : baseKeys), 'routing homunculus content result detail');
  const expectedAction = trigger === HOMUNCULUS_CREATED_TRIGGER
    ? 'created'
    : trigger === HOMUNCULUS_CONVERSATION_TRIGGER
      ? 'conversation'
      : 'farewell';
  if (detail.action !== expectedAction) {
    throw new Error(`routing homunculus content result action must be '${expectedAction}' for trigger ${trigger}`);
  }
  if (typeof detail.homunculus_id !== 'string' || !HOMUNCULUS_CONTENT_ID_PATTERN.test(detail.homunculus_id)) {
    throw new Error('routing homunculus content result requires a homunculus_NNN homunculus_id');
  }
  if (typeof detail.display_name !== 'string' || !detail.display_name) {
    throw new Error('routing homunculus content result requires a non-empty display_name');
  }
  if (typeof detail.face_id !== 'string' || !isHomunculusFaceId(detail.face_id)) {
    throw new Error('routing homunculus content result requires an hp_NNN or ab_NNN face_id');
  }
  if (isFarewell && (typeof detail.epitaph !== 'string' || !detail.epitaph)) {
    throw new Error('routing homunculus content result farewell requires a non-empty epitaph');
  }
}

// The 闘技会 content result detail: the outcome, the entry mode, the win count (0..4), the paid prize money,
// and the granted materials (identity + quantity, possibly empty). The vocabulary is closed and the
// mode↔outcome↔wins↔reward relationships are enforced so a corrupt persisted detail fails fast rather than
// reaching the hub renderer.
function validateArenaMaterials(materials) {
  if (!Array.isArray(materials)) throw new Error('routing arena content result materials must be an array');
  const seen = new Set();
  for (const item of materials) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('routing arena content result materials entries must be objects');
    }
    assertExactKeys(item, new Set(['item_id', 'display_name', 'quantity']), 'routing arena content result material');
    if (typeof item.item_id !== 'string' || !item.item_id) {
      throw new Error('routing arena content result material item_id must be a non-empty string');
    }
    if (seen.has(item.item_id)) throw new Error(`routing arena content result material item_id must be unique: ${item.item_id}`);
    seen.add(item.item_id);
    if (typeof item.display_name !== 'string' || !item.display_name) {
      throw new Error('routing arena content result material display_name must be a non-empty string');
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error('routing arena content result material quantity must be a positive integer');
    }
  }
}

function validateArenaDetail(detail) {
  assertExactKeys(detail, new Set(['outcome', 'mode', 'wins', 'prize_money', 'materials']), 'routing arena content result detail');
  if (!ARENA_OUTCOMES.includes(detail.outcome)) {
    throw new Error(`routing arena content result outcome must be one of: ${ARENA_OUTCOMES.join(', ')}`);
  }
  if (!ARENA_MODES.includes(detail.mode)) {
    throw new Error(`routing arena content result mode must be one of: ${ARENA_MODES.join(', ')}`);
  }
  if (!Number.isInteger(detail.wins) || detail.wins < 0 || detail.wins > ARENA_MAX_WINS) {
    throw new Error(`routing arena content result wins must be an integer 0..${ARENA_MAX_WINS}`);
  }
  if (!Number.isInteger(detail.prize_money) || detail.prize_money < 0) {
    throw new Error('routing arena content result prize_money must be a non-negative integer');
  }
  validateArenaMaterials(detail.materials);
  // A spectate tournament always reports a spectated_* outcome, a participated one always champion/eliminated.
  const spectatedOutcome = detail.outcome === 'spectated_champion' || detail.outcome === 'spectated_eliminated';
  if ((detail.mode === 'spectate') !== spectatedOutcome) {
    throw new Error(`routing arena content result mode ${detail.mode} does not match outcome ${detail.outcome}`);
  }
  // Champion ⇔ 4 wins; any eliminated outcome ⇔ fewer than 4.
  const championOutcome = detail.outcome === 'champion' || detail.outcome === 'spectated_champion';
  if (championOutcome !== (detail.wins === ARENA_MAX_WINS)) {
    throw new Error(`routing arena content result outcome ${detail.outcome} does not match wins ${detail.wins}`);
  }
  // The reward actually paid must agree with the win count: no wins pays nothing, any win pays a prize.
  if (detail.wins === 0 && (detail.prize_money !== 0 || detail.materials.length > 0)) {
    throw new Error('routing arena content result with 0 wins must carry no prize_money and no materials');
  }
  if (detail.wins > 0 && detail.prize_money <= 0) {
    throw new Error('routing arena content result with wins must carry a positive prize_money');
  }
}

// One resolved lot in the auction content result: the item identity (name / category / band), how it
// resolved, the price paid, and the winner's display name. `passed_in` carries no price and no winner;
// `won_by_player` carries the paid price and a null winner (the player is implicit); `won_by_other` carries
// the paid price and the NPC's display name.
function validateAuctionLotResult(lot, index) {
  if (!lot || typeof lot !== 'object' || Array.isArray(lot)) {
    throw new Error(`routing auction content result lots[${index}] must be an object`);
  }
  assertExactKeys(lot, new Set(['lot_index', 'item_name', 'category', 'band', 'result', 'price', 'winner_display_name']), `routing auction content result lots[${index}]`);
  if (lot.lot_index !== index) {
    throw new Error(`routing auction content result lots[${index}].lot_index must equal ${index}: got ${lot.lot_index}`);
  }
  if (typeof lot.item_name !== 'string' || !lot.item_name) {
    throw new Error(`routing auction content result lots[${index}] requires a non-empty item_name`);
  }
  if (!AUCTION_DETAIL_CATEGORIES.includes(lot.category)) {
    throw new Error(`routing auction content result lots[${index}].category must be one of: ${AUCTION_DETAIL_CATEGORIES.join(', ')}`);
  }
  if (!AUCTION_DETAIL_BANDS.includes(lot.band)) {
    throw new Error(`routing auction content result lots[${index}].band must be one of: ${AUCTION_DETAIL_BANDS.join(', ')}`);
  }
  if (!AUCTION_LOT_RESULTS.includes(lot.result)) {
    throw new Error(`routing auction content result lots[${index}].result must be one of: ${AUCTION_LOT_RESULTS.join(', ')}`);
  }
  if (lot.result === 'passed_in') {
    if (lot.price !== null) throw new Error(`routing auction content result lots[${index}] passed_in must have price null`);
    if (lot.winner_display_name !== null) throw new Error(`routing auction content result lots[${index}] passed_in must have winner_display_name null`);
    return;
  }
  if (!Number.isInteger(lot.price) || lot.price <= 0) {
    throw new Error(`routing auction content result lots[${index}] ${lot.result} must have a positive integer price`);
  }
  if (lot.result === 'won_by_player') {
    if (lot.winner_display_name !== null) throw new Error(`routing auction content result lots[${index}] won_by_player must have winner_display_name null`);
    return;
  }
  // won_by_other
  if (typeof lot.winner_display_name !== 'string' || !lot.winner_display_name) {
    throw new Error(`routing auction content result lots[${index}] won_by_other requires a non-empty winner_display_name`);
  }
}

function validateAuctionDetail(detail) {
  assertExactKeys(detail, new Set(['outcome', 'lots']), 'routing auction content result detail');
  if (detail.outcome !== 'closed') {
    throw new Error("routing auction content result outcome must be 'closed'");
  }
  if (!Array.isArray(detail.lots) || detail.lots.length !== AUCTION_WEEKLY_LOT_COUNT) {
    throw new Error(`routing auction content result requires exactly ${AUCTION_WEEKLY_LOT_COUNT} lots`);
  }
  detail.lots.forEach((lot, index) => validateAuctionLotResult(lot, index));
}

function validateStudyCircleDomainContentResult(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('study circle content result must be an object');
  }
  const expectedKeys = new Set(['kind', 'destination_id', 'trigger', 'detail']);
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) throw new Error(`study circle content result has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`study circle content result is missing required key: ${key}`);
  }
  if (record.kind !== 'study_circle') throw new Error("study circle content result kind must be 'study_circle'");
  if (record.destination_id !== 'study_circle') throw new Error("study circle content result destination_id must be 'study_circle'");
  if (record.trigger !== STUDY_CIRCLE_TRIGGER) throw new Error(`study circle content result trigger must be '${STUDY_CIRCLE_TRIGGER}'`);
  validateStudyCircleDetail(record.detail);
  return record;
}

// Public shape validator. Throws on a non-object or any missing/malformed required
// field. Callers that read the slot should treat absence as null (no result) and
// only pass a present value here.
function validateLoungeDetail(detail) {
  assertExactKeys(detail, new Set(['participants']), 'routing lounge content result detail');
  if (!Array.isArray(detail.participants) || detail.participants.length !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`routing lounge content result requires exactly ${LOUNGE_PARTICIPANT_COUNT} participants`);
  }
  const seen = new Set();
  for (const participant of detail.participants) {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) {
      throw new Error('routing lounge content result participant must be an object');
    }
    assertExactKeys(participant, new Set(['character_id', 'character_name']), 'routing lounge content result participant');
    if (typeof participant.character_id !== 'string' || !participant.character_id) {
      throw new Error('routing lounge content result participant requires a non-empty character_id');
    }
    if (typeof participant.character_name !== 'string' || !participant.character_name) {
      throw new Error('routing lounge content result participant requires a non-empty character_name');
    }
    if (seen.has(participant.character_id)) {
      throw new Error(`routing lounge content result has a duplicate participant: ${participant.character_id}`);
    }
    seen.add(participant.character_id);
  }
}

export function validateRoutingContentResult(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('routing content result must be a non-null object');
  }
  if (!CONTENT_KINDS.includes(record.kind)) {
    throw new Error(`routing content result kind must be one of: ${CONTENT_KINDS.join(', ')}`);
  }
  if (!Number.isInteger(record.week) || record.week < 0) {
    throw new Error('routing content result requires a non-negative integer week');
  }
  if (typeof record.recorded_at !== 'string' || !record.recorded_at) {
    throw new Error('routing content result requires a non-empty recorded_at');
  }
  if (!record.detail || typeof record.detail !== 'object' || Array.isArray(record.detail)) {
    throw new Error('routing content result requires a detail object');
  }
  if (record.kind === 'training') {
    if (record.destination_id !== 'training') {
      throw new Error("routing training content result destination_id must be 'training'");
    }
    if (!TRAINING_TRIGGERS.includes(record.trigger)) {
      throw new Error(`routing training content result trigger must be one of: ${TRAINING_TRIGGERS.join(', ')}`);
    }
    validateTrainingDetail(record.detail);
  } else if (record.kind === 'dungeon') {
    if (record.destination_id !== 'dungeon') {
      throw new Error("routing dungeon content result destination_id must be 'dungeon'");
    }
    if (record.trigger !== DUNGEON_TRIGGER) {
      throw new Error(`routing dungeon content result trigger must be '${DUNGEON_TRIGGER}'`);
    }
    validateDungeonDetail(record.detail);
  } else if (record.kind === 'errand') {
    if (record.destination_id !== 'errand') {
      throw new Error("routing errand content result destination_id must be 'errand'");
    }
    if (record.trigger !== ERRAND_TRIGGER) {
      throw new Error(`routing errand content result trigger must be '${ERRAND_TRIGGER}'`);
    }
    validateErrandDetail(record.detail);
  } else if (record.kind === 'alchemy') {
    if (record.destination_id !== 'alchemy') {
      throw new Error("routing alchemy content result destination_id must be 'alchemy'");
    }
    if (record.trigger !== ALCHEMY_TRIGGER) {
      throw new Error(`routing alchemy content result trigger must be '${ALCHEMY_TRIGGER}'`);
    }
    validateAlchemyDetail(record.detail);
  } else if (record.kind === 'study_circle') {
    if (record.destination_id !== 'study_circle') {
      throw new Error("routing study circle content result destination_id must be 'study_circle'");
    }
    if (record.trigger !== STUDY_CIRCLE_TRIGGER) {
      throw new Error(`routing study circle content result trigger must be '${STUDY_CIRCLE_TRIGGER}'`);
    }
    validateStudyCircleDetail(record.detail);
  } else if (record.kind === 'workshop') {
    if (record.destination_id !== 'workshop') {
      throw new Error("routing workshop content result destination_id must be 'workshop'");
    }
    if (record.trigger !== WORKSHOP_TRIGGER) {
      throw new Error(`routing workshop content result trigger must be '${WORKSHOP_TRIGGER}'`);
    }
    validateWorkshopDetail(record.detail);
  } else if (record.kind === 'library') {
    if (record.destination_id !== 'library') {
      throw new Error("routing library content result destination_id must be 'library'");
    }
    if (record.trigger !== LIBRARY_TRIGGER) {
      throw new Error(`routing library content result trigger must be '${LIBRARY_TRIGGER}'`);
    }
    validateLibraryDetail(record.detail);
  } else if (record.kind === 'homunculus') {
    if (record.destination_id !== 'homunculus') {
      throw new Error("routing homunculus content result destination_id must be 'homunculus'");
    }
    if (!HOMUNCULUS_TRIGGERS.includes(record.trigger)) {
      throw new Error(`routing homunculus content result trigger must be one of: ${HOMUNCULUS_TRIGGERS.join(', ')}`);
    }
    validateHomunculusDetail(record.detail, record.trigger);
  } else if (record.kind === 'arena') {
    if (record.destination_id !== 'arena') {
      throw new Error("routing arena content result destination_id must be 'arena'");
    }
    if (record.trigger !== ARENA_TRIGGER) {
      throw new Error(`routing arena content result trigger must be '${ARENA_TRIGGER}'`);
    }
    validateArenaDetail(record.detail);
  } else if (record.kind === 'auction') {
    if (record.destination_id !== 'auction') {
      throw new Error("routing auction content result destination_id must be 'auction'");
    }
    if (record.trigger !== AUCTION_TRIGGER) {
      throw new Error(`routing auction content result trigger must be '${AUCTION_TRIGGER}'`);
    }
    validateAuctionDetail(record.detail);
  } else if (record.kind === 'lounge') {
    if (record.destination_id !== 'lounge') {
      throw new Error("routing lounge content result destination_id must be 'lounge'");
    }
    if (record.trigger !== LOUNGE_TRIGGER) {
      throw new Error(`routing lounge content result trigger must be '${LOUNGE_TRIGGER}'`);
    }
    validateLoungeDetail(record.detail);
  }
  return record;
}

// Reads the slot from runtime_state. Absence (or an explicit null) is the honest
// "no recent content result" and returns null; a present record is validated
// (fail-fast on corruption) and returned.
export function readRoutingContentResult(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the routing content result');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_CONTENT_RESULT_STATE_KEY)) return null;
  const record = state[ROUTING_CONTENT_RESULT_STATE_KEY];
  if (record === null) return null;
  return validateRoutingContentResult(record);
}

// Sums a training day's effects into a running per-week delta map (mutated in
// place). `effect.amount` is the actually-applied signed delta (weekday bonus and
// drawbacks folded in): a zero-amount roll contributes nothing and a net cancel
// drops the entry. A non-finite amount or unknown group is malformed input and
// fails fast.
function foldEffectsIntoDeltas(deltas, effects) {
  for (const effect of effects ?? []) {
    if (!effect || typeof effect !== 'object') throw new Error('training effect must be an object');
    const { group, key, amount } = effect;
    if (!EFFECT_GROUPS.includes(group)) throw new Error(`unknown training effect group: ${group}`);
    if (typeof key !== 'string' || !key) throw new Error('training effect requires a key');
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('training effect amount must be a finite number');
    if (amount === 0) continue;
    const next = (deltas[group][key] ?? 0) + amount;
    if (next === 0) delete deltas[group][key];
    else deltas[group][key] = next;
  }
  return deltas;
}

function copyAccumulatorTrainings(trainings) {
  return trainings.map((entry) => ({
    day_index: entry.day_index,
    day_name: entry.day_name,
    training_id: entry.training_id,
    training_name: entry.training_name
  }));
}

// Folds one training day into the week accumulator. A null/undefined accumulator
// seeds a fresh week (the first day); a present accumulator is strictly validated
// first, so corrupt runtime_state fails fast instead of being silently reseeded.
// The accumulator lives on runtime_state between day actions and is finalized into
// the record on completion/skip.
export function foldTrainingDayIntoAccumulator(accumulator, { week, dayIndex, dayName, trainingId, trainingName, effects }) {
  const base = accumulator === null || accumulator === undefined ? null : assertTrainingWeekAccumulator(accumulator);
  const trainings = base ? copyAccumulatorTrainings(base.trainings) : [];
  trainings.push({
    day_index: dayIndex,
    day_name: dayName,
    training_id: trainingId,
    training_name: trainingName
  });
  const deltas = base
    ? assertAndCopyParameterDeltaMap(base.parameter_deltas, 'routing training week accumulator parameter_deltas')
    : { magic: {}, abilities: {} };
  return {
    week: assertNonNegativeIntegerWeek(week),
    destination_id: 'training',
    trainings,
    parameter_deltas: foldEffectsIntoDeltas(deltas, effects)
  };
}

export function buildTrainingContentResult({ week, now, outcome, accumulator = null }) {
  if (!TRAINING_OUTCOMES.includes(outcome)) {
    throw new Error(`routing training content result outcome must be one of: ${TRAINING_OUTCOMES.join(', ')}`);
  }
  // A present accumulator must be well-formed; null is the legitimate empty week
  // (skip at the start of the week, or a completing day with no carried accumulator).
  const validated = accumulator === null || accumulator === undefined
    ? null
    : assertTrainingWeekAccumulator(accumulator);
  return validateRoutingContentResult({
    kind: 'training',
    destination_id: 'training',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: outcome === 'skipped' ? 'training_skipped' : 'training_completed',
    detail: {
      outcome,
      trainings: validated ? copyAccumulatorTrainings(validated.trainings) : [],
      parameter_deltas: validated
        ? assertAndCopyParameterDeltaMap(validated.parameter_deltas, 'routing training content result parameter_deltas')
        : { magic: {}, abilities: {} }
    }
  });
}

export function buildDungeonContentResult({
  week,
  now,
  outcome,
  floorReached,
  maxFloors,
  appliedGains,
  totalApplied,
  companionCharacterId = null,
  materials = null,
  equipment = null
}) {
  return validateRoutingContentResult({
    kind: 'dungeon',
    destination_id: 'dungeon',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: 'dungeon_run_committed',
    detail: {
      outcome,
      floor_reached: floorReached,
      max_floors: maxFloors,
      applied_gains: assertAndCopyParameterDeltaMap(appliedGains, 'routing dungeon content result applied_gains'),
      total_applied: totalApplied,
      companion_character_id: companionCharacterId ?? null,
      ...(materials === null ? {} : { materials: copyDungeonMaterials(materials) }),
      ...(equipment === null ? {} : { equipment: copyDungeonEquipment(equipment) })
    }
  });
}

export function buildErrandContentResult({
  week,
  now,
  errandId,
  title,
  achieved,
  rewardMoney,
  clientCharacterId,
  clientDisplayName
}) {
  if (typeof achieved !== 'boolean') throw new Error('buildErrandContentResult requires a boolean achieved');
  return validateRoutingContentResult({
    kind: 'errand',
    destination_id: 'errand',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: ERRAND_TRIGGER,
    detail: {
      outcome: 'completed',
      achieved,
      errand_id: errandId,
      title,
      reward_money: rewardMoney,
      client_character_id: clientCharacterId,
      client_display_name: clientDisplayName
    }
  });
}

export function buildAlchemyContentResult({
  week,
  now,
  recipeId,
  itemId,
  name,
  category,
  quantity
}) {
  return validateRoutingContentResult({
    kind: 'alchemy',
    destination_id: 'alchemy',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: ALCHEMY_TRIGGER,
    detail: {
      outcome: 'completed',
      recipe_id: recipeId,
      item_id: itemId,
      name,
      category,
      quantity
    }
  });
}

export function buildStudyCircleRoutingContentResult({
  week,
  now,
  contentResult
}) {
  const domainResult = validateStudyCircleDomainContentResult(contentResult);
  return validateRoutingContentResult({
    kind: 'study_circle',
    destination_id: 'study_circle',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: STUDY_CIRCLE_TRIGGER,
    detail: {
      outcome: domainResult.detail.outcome,
      achieved: domainResult.detail.achieved,
      theme_id: domainResult.detail.theme_id,
      theme_name: domainResult.detail.theme_name,
      host_character_id: domainResult.detail.host_character_id,
      host_display_name: domainResult.detail.host_display_name,
      parameter_deltas: assertAndCopyParameterDeltaMap(
        domainResult.detail.parameter_deltas,
        'routing study circle content result parameter_deltas'
      )
    }
  });
}

// Builds a workshop content result from a finished craft instance (the object
// completeCraft/craftWithLlmNaming returns) plus its recipe id. The detail is a
// faithful summary of the finished item; the validator enforces the shape.
export function buildWorkshopContentResult({ week, now, recipeId, instance }) {
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
    throw new Error('routing workshop content result requires a finished instance');
  }
  return validateRoutingContentResult({
    kind: 'workshop',
    destination_id: 'workshop',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: WORKSHOP_TRIGGER,
    detail: {
      outcome: 'completed',
      recipe_id: recipeId,
      kind: instance.kind,
      ...(instance.kind === 'weapon' ? { weapon_type: instance.weapon_type } : {}),
      element: instance.element,
      tier: instance.tier,
      quality: instance.quality,
      name: instance.name,
      flavor: instance.flavor
    }
  });
}

// Builds a library content result from the books read in one 大書庫 stay. The detail is the
// read identities only (title/category/layer/book_id); the fragment text is persisted separately
// in the collection surface. Writing the record onto runtime_state is the B2 dispatch's job —
// this only produces and validates the shape.
export function buildLibraryContentResult({ week, now, books }) {
  if (!Array.isArray(books)) throw new Error('routing library content result requires a books array');
  return validateRoutingContentResult({
    kind: 'library',
    destination_id: 'library',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: LIBRARY_TRIGGER,
    detail: {
      outcome: 'completed',
      books: books.map((book, index) => copyLibraryBook(book, `routing library content result books[${index}]`))
    }
  });
}

// The三つの錬成室 triggers. `action` is one of created / conversation / farewell; an epitaph is supplied
// (and required) only for a farewell. The validator enforces the trigger↔action↔key-set consistency.
export const HOMUNCULUS_CONTENT_ACTIONS = Object.freeze({
  created: { action: 'created', trigger: HOMUNCULUS_CREATED_TRIGGER },
  conversation: { action: 'conversation', trigger: HOMUNCULUS_CONVERSATION_TRIGGER },
  farewell: { action: 'farewell', trigger: HOMUNCULUS_FAREWELL_TRIGGER }
});

// Builds a 闘技会 content result from a concluded tournament: the outcome, entry mode, win count, and the
// prize (money + materials) that was granted. The validator enforces the mode↔outcome↔wins↔reward shape;
// writing the record onto runtime_state is the arena dispatch's job.
export function buildArenaContentResult({ week, now, outcome, mode, wins, prizeMoney, materials }) {
  return validateRoutingContentResult({
    kind: 'arena',
    destination_id: 'arena',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: ARENA_TRIGGER,
    detail: {
      outcome,
      mode,
      wins,
      prize_money: prizeMoney,
      materials: (Array.isArray(materials) ? materials : []).map((item) => ({
        item_id: item.item_id,
        display_name: item.display_name,
        quantity: item.quantity
      }))
    }
  });
}

// Builds a 談話室 content result from a concluded group talk: the three学友 who sat in the round (identity only).
// The raw transcript is discarded at finalization, so the record carries only who took part; writing it onto
// runtime_state is the lounge end route's job (after the aggregate finalization).
export function buildLoungeContentResult({ week, now, participants }) {
  if (!Array.isArray(participants)) throw new Error('routing lounge content result requires a participants array');
  return validateRoutingContentResult({
    kind: 'lounge',
    destination_id: 'lounge',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: LOUNGE_TRIGGER,
    detail: {
      participants: participants.map((participant) => ({
        character_id: participant.character_id,
        character_name: participant.character_name
      }))
    }
  });
}

// Builds a 競売場 content result from a closed weekly auction: the three lots' resolved identities and outcomes.
// The validator enforces the per-lot result↔price↔winner shape; writing the record onto runtime_state is the
// auction session's job (at closure).
export function buildAuctionContentResult({ week, now, lots }) {
  if (!Array.isArray(lots)) throw new Error('routing auction content result requires a lots array');
  return validateRoutingContentResult({
    kind: 'auction',
    destination_id: 'auction',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: AUCTION_TRIGGER,
    detail: {
      outcome: 'closed',
      lots: lots.map((lot, index) => ({
        lot_index: index,
        item_name: lot.item_name,
        category: lot.category,
        band: lot.band,
        result: lot.result,
        price: lot.result === 'passed_in' ? null : lot.price,
        winner_display_name: lot.result === 'won_by_other' ? lot.winner_display_name : null
      }))
    }
  });
}

export function buildHomunculusContentResult({ week, now, action, homunculusId, displayName, faceId, epitaph = null }) {
  const actionSpec = HOMUNCULUS_CONTENT_ACTIONS[action];
  if (!actionSpec) {
    throw new Error(`routing homunculus content result action must be one of: ${Object.keys(HOMUNCULUS_CONTENT_ACTIONS).join(', ')}`);
  }
  const detail = {
    action: actionSpec.action,
    homunculus_id: homunculusId,
    display_name: displayName,
    face_id: faceId,
    ...(action === 'farewell' ? { epitaph } : {})
  };
  return validateRoutingContentResult({
    kind: 'homunculus',
    destination_id: 'homunculus',
    week: assertNonNegativeIntegerWeek(week),
    recorded_at: assertRecordedAt(now),
    trigger: actionSpec.trigger,
    detail
  });
}
