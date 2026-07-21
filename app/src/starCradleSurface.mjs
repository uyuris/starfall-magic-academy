// 星の揺り籠 (star cradle): the per-slot mutable player surfaces for the hub sandbox.
//
// Two surfaces live here, both the same player-surface convention as player_inventory / player_equipment /
// homunculi (absent = the honest empty state a fresh routing new-game writes; present-but-malformed throws;
// carried by slot save/load/clone):
//
//   • `game_data/star_cradle.json` = `{ version, pots, creatures }` — the garden itself. `pots` holds the up-to-3
//     growing plants and `creatures` the up-to-3 growing/resident creatures. Each record stores ONLY the durable
//     facts: the seed/egg item type, the week it was placed, the individual seed (entropy captured once at
//     planting), the feed state (attribute → count, the pre-reveal bias), and — creatures only — the player name
//     and the last week its weekly byproducts were claimed. The variety, growth stage, golden/second-form roll and
//     harvest/byproduct are all DERIVED from (seed, feed, item_id, elapsed weeks); nothing derived is persisted, so
//     reveal is a pure read.
//
//   • `game_data/star_cradle_creatures.json` = `{ version, instances }` — the one-off "caged" creature items. An
//     adult resident can be put into a cage: a unique individual item (装備 instance と同じ一点物 surface 流儀)
//     that preserves its seed / feed / name so releasing it back into the garden reproduces the exact same creature.
//     This is the hand-off shape a future 競売 listing/award will move a creature through.

import { createStorageApi } from './storage.mjs';

export const STAR_CRADLE_SURFACE_PATH = 'game_data/star_cradle.json';
export const STAR_CRADLE_CREATURES_SURFACE_PATH = 'game_data/star_cradle_creatures.json';

const POT_KEYS = ['slot_index', 'item_id', 'planted_week', 'seed', 'feed'];
const CREATURE_KEYS = ['slot_index', 'item_id', 'planted_week', 'seed', 'feed', 'name', 'last_byproduct_week'];
const CAGED_KEYS = ['instance_id', 'item_id', 'seed', 'feed', 'name', 'caged_week'];

function fail(message) {
  throw new Error(`star cradle surface: ${message}`);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer: ${value}`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer: ${value}`);
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) fail(`${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

// The feed state: attribute (magic element) → positive integer count. Absent element = zero fed. An empty
// object is the honest "unfed". Keys are validated as non-empty strings and values as positive integers; the
// element vocabulary itself is the domain's concern (feeding validates the element against the catalog).
function validateFeed(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const [element, count] of Object.entries(value)) {
    nonEmptyString(element, `${label} key`);
    positiveInteger(count, `${label}.${element}`);
  }
  return value;
}

function validatePotRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('pot record must be an object');
  assertExactKeys(record, POT_KEYS, 'pot record');
  nonNegativeInteger(record.slot_index, 'pot slot_index');
  nonEmptyString(record.item_id, 'pot item_id');
  nonNegativeInteger(record.planted_week, 'pot planted_week');
  positiveInteger(record.seed, 'pot seed');
  validateFeed(record.feed, 'pot feed');
  return record;
}

function validateCreatureRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('creature record must be an object');
  assertExactKeys(record, CREATURE_KEYS, 'creature record');
  nonNegativeInteger(record.slot_index, 'creature slot_index');
  nonEmptyString(record.item_id, 'creature item_id');
  nonNegativeInteger(record.planted_week, 'creature planted_week');
  positiveInteger(record.seed, 'creature seed');
  validateFeed(record.feed, 'creature feed');
  if (record.name !== null) nonEmptyString(record.name, 'creature name');
  nonNegativeInteger(record.last_byproduct_week, 'creature last_byproduct_week');
  return record;
}

function assertUniqueSlots(records, label) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.slot_index)) fail(`duplicate ${label} slot_index: ${record.slot_index}`);
    seen.add(record.slot_index);
  }
}

export function emptyStarCradleSurface() {
  return { version: 1, pots: [], creatures: [] };
}

export function validateStarCradleSurface(surface) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) fail('surface must be an object');
  assertExactKeys(surface, ['version', 'pots', 'creatures'], 'surface');
  if (surface.version !== 1) fail(`surface version must be 1: ${surface.version}`);
  if (!Array.isArray(surface.pots)) fail('surface pots must be an array');
  if (!Array.isArray(surface.creatures)) fail('surface creatures must be an array');
  surface.pots.forEach(validatePotRecord);
  surface.creatures.forEach(validateCreatureRecord);
  assertUniqueSlots(surface.pots, 'pot');
  assertUniqueSlots(surface.creatures, 'creature');
  return surface;
}

function validateCagedInstance(instance) {
  if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) fail('caged instance must be an object');
  assertExactKeys(instance, CAGED_KEYS, 'caged instance');
  nonEmptyString(instance.instance_id, 'caged instance_id');
  nonEmptyString(instance.item_id, 'caged item_id');
  positiveInteger(instance.seed, 'caged seed');
  validateFeed(instance.feed, 'caged feed');
  if (instance.name !== null) nonEmptyString(instance.name, 'caged name');
  nonNegativeInteger(instance.caged_week, 'caged caged_week');
  return instance;
}

export function emptyStarCradleCreaturesSurface() {
  return { version: 1, instances: [] };
}

export function validateStarCradleCreaturesSurface(surface) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) fail('caged surface must be an object');
  assertExactKeys(surface, ['version', 'instances'], 'caged surface');
  if (surface.version !== 1) fail(`caged surface version must be 1: ${surface.version}`);
  if (!Array.isArray(surface.instances)) fail('caged surface instances must be an array');
  const seen = new Set();
  for (const instance of surface.instances) {
    validateCagedInstance(instance);
    if (seen.has(instance.instance_id)) fail(`duplicate caged instance_id: ${instance.instance_id}`);
    seen.add(instance.instance_id);
  }
  return surface;
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

export async function loadStarCradleSurface({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(STAR_CRADLE_SURFACE_PATH);
  if (raw === null || raw === undefined) return emptyStarCradleSurface();
  return validateStarCradleSurface(raw);
}

export async function writeStarCradleSurface({ root, storage, surface } = {}) {
  const api = storageFor({ root, storage });
  validateStarCradleSurface(surface);
  await api.writeJson(STAR_CRADLE_SURFACE_PATH, surface);
  return surface;
}

export async function loadStarCradleCreaturesSurface({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(STAR_CRADLE_CREATURES_SURFACE_PATH);
  if (raw === null || raw === undefined) return emptyStarCradleCreaturesSurface();
  return validateStarCradleCreaturesSurface(raw);
}

export async function writeStarCradleCreaturesSurface({ root, storage, surface } = {}) {
  const api = storageFor({ root, storage });
  validateStarCradleCreaturesSurface(surface);
  await api.writeJson(STAR_CRADLE_CREATURES_SURFACE_PATH, surface);
  return surface;
}

// The lowest slot index in [0, maxSlots) not occupied by any record, or null when full. The garden fills
// pots/creature slots densely from 0 so the frontend can lay them out by index.
export function firstFreeSlot(records, maxSlots) {
  const used = new Set(records.map((record) => record.slot_index));
  for (let index = 0; index < maxSlots; index += 1) {
    if (!used.has(index)) return index;
  }
  return null;
}
