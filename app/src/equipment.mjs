// One-off equipment instances (weapon / amulet) and the player's two equip slots.
//
// Equipment is unlike the quantity ledger in player_inventory: each crafted piece
// is a unique instance carrying its own tier/quality/name/flavor/effects, so it
// lives in a dedicated mutable surface `game_data/player_equipment.json`
// (`{ version, instances }`). An absent surface reads as "no instances" so existing
// saves need no rewrite; a present-but-malformed surface is corrupt state and throws.
//
// Equip owners each carry two slots (weapon / amulet). The hero's slots live on
// runtime_state as the optional `equipment_slots` field; a companion's slots live in
// the optional `companion_equipment_slots` map keyed by companion id — a selectable
// character id or a homunculus id (`{ <companion_id>: { weapon?, amulet? } }`). For both
// surfaces absent means unequipped, and any present value is strictly validated (allowed
// keys only, each a non-empty instance id that resolves to an instance whose kind matches
// the slot; a companion key must be a selectable character or homunculus id). Nothing here silently falls back —
// a missing surface/field/entry is the ONLY "empty" reading; everything else fails
// fast. Only occupied slots are ever persisted: a fully-unequipped owner leaves no
// entry and an emptied map leaves no field, so no empty residue is written.
//
// Every equip target is named explicitly (`'player'`, a selectable character id, or a
// homunculus id); there is no implicit default owner. Instances are one-of-a-kind: an instance may be
// worn by at most one owner slot, enforced on the equip write and re-checked when the
// whole equip picture is read (a shared instance in persisted state is corrupt and
// throws, never silently auto-unequipped).
//
// Effects use a closed vocabulary. `element_spell_power` is weapon-only and applies
// to the instance's own element; the rest are scalar combat modifiers. Effects are
// split into `base_effects` (recipe + tier fixed) and `bonus_effects` (rolled);
// combat sums them.

import { createStorageApi } from './storage.mjs';
import { magicParameterDefinitions } from './parameters.mjs';
import { isSelectableCharacterId } from './characterCatalog.mjs';
import { isHomunculusIdFormat } from './companionRoster.mjs';

const EQUIPMENT_SURFACE_PATH = 'game_data/player_equipment.json';
const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

// The hero equip target. Companions are targeted by their selectable character id.
export const PLAYER_EQUIP_TARGET = 'player';

export const EQUIPMENT_KINDS = ['weapon', 'amulet'];
export const EQUIPMENT_SLOTS = ['weapon', 'amulet'];
export const WEAPON_TYPES = ['sword', 'staff', 'short_rod'];
export const EQUIPMENT_QUALITIES = ['common', 'fine', 'excellent', 'masterwork'];
export const EQUIPMENT_EFFECT_KEYS = ['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power'];
const WEAPON_ONLY_EFFECT_KEYS = new Set(['element_spell_power']);

const ELEMENT_KEYS = new Set(magicParameterDefinitions.map((definition) => definition.key));
const KIND_SET = new Set(EQUIPMENT_KINDS);
const SLOT_SET = new Set(EQUIPMENT_SLOTS);
const WEAPON_TYPE_SET = new Set(WEAPON_TYPES);
const QUALITY_SET = new Set(EQUIPMENT_QUALITIES);
const EFFECT_KEY_SET = new Set(EQUIPMENT_EFFECT_KEYS);

const AMULET_INSTANCE_KEYS = ['instance_id', 'kind', 'element', 'tier', 'quality', 'name', 'flavor', 'base_effects', 'bonus_effects'];
const WEAPON_INSTANCE_KEYS = [...AMULET_INSTANCE_KEYS, 'weapon_type'];

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`equipment ${label} must be a non-empty string`);
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`equipment ${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

function validateEffects(effects, kind, label) {
  if (effects === null || typeof effects !== 'object' || Array.isArray(effects)) {
    throw new Error(`equipment ${label} must be an object of effect -> positive integer`);
  }
  for (const [key, value] of Object.entries(effects)) {
    if (!EFFECT_KEY_SET.has(key)) throw new Error(`unknown equipment effect: ${key}`);
    if (WEAPON_ONLY_EFFECT_KEYS.has(key) && kind !== 'weapon') throw new Error(`equipment effect ${key} is weapon-only, not valid on a ${kind}`);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`equipment effect ${key} must be a positive integer: ${value}`);
  }
  return effects;
}

// Strict, exact-shape instance validator. Weapons carry weapon_type; amulets do not.
export function validateEquipmentInstance(instance) {
  if (instance === null || typeof instance !== 'object' || Array.isArray(instance)) throw new Error('equipment instance must be an object');
  if (!KIND_SET.has(instance.kind)) throw new Error(`equipment instance kind must be one of ${EQUIPMENT_KINDS.join('/')}: ${instance.kind}`);
  assertExactKeys(instance, instance.kind === 'weapon' ? WEAPON_INSTANCE_KEYS : AMULET_INSTANCE_KEYS, `${instance.kind} instance`);
  nonEmptyString(instance.instance_id, 'instance_id');
  if (instance.kind === 'weapon' && !WEAPON_TYPE_SET.has(instance.weapon_type)) {
    throw new Error(`equipment weapon_type must be one of ${WEAPON_TYPES.join('/')}: ${instance.weapon_type}`);
  }
  if (!ELEMENT_KEYS.has(instance.element)) throw new Error(`equipment element must be a magic element: ${instance.element}`);
  if (!Number.isInteger(instance.tier) || instance.tier < 1 || instance.tier > 4) throw new Error(`equipment tier must be an integer 1..4: ${instance.tier}`);
  if (!QUALITY_SET.has(instance.quality)) throw new Error(`equipment quality must be one of ${EQUIPMENT_QUALITIES.join('/')}: ${instance.quality}`);
  nonEmptyString(instance.name, 'name');
  nonEmptyString(instance.flavor, 'flavor');
  validateEffects(instance.base_effects, instance.kind, 'base_effects');
  validateEffects(instance.bonus_effects, instance.kind, 'bonus_effects');
  return instance;
}

export function emptyEquipmentSurface() {
  return { version: 1, instances: [] };
}

// Validates the whole surface: version 1, instances array, each instance valid,
// instance_id unique. Extra top-level keys throw.
export function validateEquipmentSurface(surface) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) throw new Error('player_equipment surface must be an object');
  assertExactKeys(surface, ['version', 'instances'], 'surface');
  if (surface.version !== 1) throw new Error(`player_equipment version must be 1: ${surface.version}`);
  if (!Array.isArray(surface.instances)) throw new Error('player_equipment instances must be an array');
  const seen = new Set();
  for (const instance of surface.instances) {
    validateEquipmentInstance(instance);
    if (seen.has(instance.instance_id)) throw new Error(`duplicate equipment instance_id: ${instance.instance_id}`);
    seen.add(instance.instance_id);
  }
  return surface;
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

// Loads the surface. Absent (older save / fresh default) reads as an empty surface;
// present-but-malformed throws.
export async function loadEquipmentSurface({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(EQUIPMENT_SURFACE_PATH);
  if (raw === null || raw === undefined) return emptyEquipmentSurface();
  return validateEquipmentSurface(raw);
}

export function findEquipmentInstance(surface, instanceId) {
  return surface.instances.find((instance) => instance.instance_id === instanceId) ?? null;
}

// Appends a validated instance. A duplicate instance_id throws before any write.
export async function addEquipmentInstance({ root, storage, instance } = {}) {
  const api = storageFor({ root, storage });
  const surface = await loadEquipmentSurface({ storage: api });
  validateEquipmentInstance(instance);
  if (findEquipmentInstance(surface, instance.instance_id)) throw new Error(`equipment instance_id already exists: ${instance.instance_id}`);
  const next = { version: 1, instances: [...surface.instances, instance] };
  await api.writeJson(EQUIPMENT_SURFACE_PATH, next);
  return next;
}

// Writes a whole validated surface. Used to restore a captured prior surface when a
// wider transaction that added an instance must roll back (the surface write cannot
// be left partially applied).
export async function writeEquipmentSurface({ root, storage, surface } = {}) {
  const api = storageFor({ root, storage });
  validateEquipmentSurface(surface);
  await api.writeJson(EQUIPMENT_SURFACE_PATH, surface);
  return surface;
}

// A non-player equip owner: a selectable companion character OR a homunculus companion, validated by
// FORMAT only (`character_NNN` in range, or `homunculus_NNN` shape) — the same format-level check the
// domain already applies to selectable ids. "Is this homunculus currently active" is a save-level
// relationship concern enforced by the request-boundary callers (equipment API, dungeon enter) that own
// the homunculi surface, exactly as "does this selectable character exist" is not the domain's concern.
function isCompanionEquipKey(target) {
  return typeof target === 'string' && (isSelectableCharacterId(target) || isHomunculusIdFormat(target));
}

// The equip target is an explicit owner: the hero (`'player'`) or a companion (selectable character or
// homunculus). There is no implicit default — callers must name the owner.
function assertEquipTarget(target) {
  if (target === PLAYER_EQUIP_TARGET) return target;
  if (isCompanionEquipKey(target)) return target;
  throw new Error(`equip target must be '${PLAYER_EQUIP_TARGET}' or a selectable character id or a homunculus id: ${target}`);
}

// Structural read of one owner's two slots. Absent (undefined) reads as fully
// unequipped; a present value must be an object of allowed slot -> non-empty instance
// id; explicit null, empty string, unknown key, or a non-object throws. Resolution
// against the surface (existence + kind match) is a separate step.
function parseSlotObject(rawSlots, label) {
  if (rawSlots === undefined) return { weapon: null, amulet: null };
  if (rawSlots === null || typeof rawSlots !== 'object' || Array.isArray(rawSlots)) {
    throw new Error(`${label} must be an object of slot -> instance_id`);
  }
  const result = { weapon: null, amulet: null };
  for (const [slot, instanceId] of Object.entries(rawSlots)) {
    if (!SLOT_SET.has(slot)) throw new Error(`unknown equipment slot: ${slot}`);
    result[slot] = nonEmptyString(instanceId, `slot ${slot} instance_id`);
  }
  return result;
}

// Validates runtime_state.companion_equipment_slots into { character_id: {weapon,amulet} }.
// Absent field = no companion equipped. A present value must be an object; each key a
// selectable character id (catalog predicate) and each value a slot object. Empty
// entries read as unequipped (the writer never persists them), matching the hero read.
function readCompanionSlotMap(state) {
  const raw = state?.companion_equipment_slots;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('runtime_state.companion_equipment_slots must be an object of character_id -> slots');
  }
  const map = {};
  for (const [characterId, rawSlots] of Object.entries(raw)) {
    if (!isCompanionEquipKey(characterId)) throw new Error(`unknown companion equipment character: ${characterId}`);
    map[characterId] = parseSlotObject(rawSlots, `companion_equipment_slots.${characterId}`);
  }
  return map;
}

// Structural read of one explicit owner's slots from runtime_state.
export function readEquipmentSlots(state, target) {
  assertEquipTarget(target);
  if (target === PLAYER_EQUIP_TARGET) return parseSlotObject(state?.equipment_slots, 'runtime_state.equipment_slots');
  return readCompanionSlotMap(state)[target] ?? { weapon: null, amulet: null };
}

// The label an owner slot is reported under in exclusivity errors.
function ownerSlotLabel(owner, slot) {
  return `${owner} ${slot}`;
}

// Every occupied (owner, slot, instance_id) reference across the whole equip picture:
// the hero's slots followed by every companion entry's slots.
function* iterateEquippedReferences({ player, companions }) {
  for (const slot of EQUIPMENT_SLOTS) {
    if (player[slot] !== null) yield { owner: PLAYER_EQUIP_TARGET, slot, instance_id: player[slot] };
  }
  for (const [characterId, slots] of Object.entries(companions)) {
    for (const slot of EQUIPMENT_SLOTS) {
      if (slots[slot] !== null) yield { owner: characterId, slot, instance_id: slots[slot] };
    }
  }
}

// Fails fast when one instance_id is worn by more than one owner slot. A one-of-a-kind
// item is exclusive; persisted state that shares one across owners is corrupt and is
// never silently auto-unequipped.
function assertUniqueEquippedInstances(all) {
  const seen = new Map();
  for (const { owner, slot, instance_id } of iterateEquippedReferences(all)) {
    if (seen.has(instance_id)) {
      throw new Error(`equipment instance ${instance_id} is equipped by multiple owners: ${seen.get(instance_id)} and ${ownerSlotLabel(owner, slot)}`);
    }
    seen.set(instance_id, ownerSlotLabel(owner, slot));
  }
}

// Reads every equip owner's slots at once — the hero plus every companion entry — with
// the same strict validation, and additionally rejects a persisted state where one
// instance is shared across owners. This is the whole-picture read face used by the
// equip exclusivity check and by consumers that must see every owner.
export function readAllEquipmentSlots(state) {
  const player = parseSlotObject(state?.equipment_slots, 'runtime_state.equipment_slots');
  const companions = readCompanionSlotMap(state);
  assertUniqueEquippedInstances({ player, companions });
  return { player, companions };
}

// Resolves each occupied slot to its instance, requiring the instance to exist and
// its kind to match the slot. Never falls back to unequipped on a bad reference.
export function resolveEquippedInstances({ slots, surface }) {
  const resolved = { weapon: null, amulet: null };
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = slots[slot];
    if (instanceId === null) continue;
    const instance = findEquipmentInstance(surface, instanceId);
    if (!instance) throw new Error(`equipment slot ${slot} references unknown instance: ${instanceId}`);
    if (instance.kind !== slot) throw new Error(`equipment slot ${slot} requires a ${slot}, but ${instanceId} is a ${instance.kind}`);
    resolved[slot] = instance;
  }
  return resolved;
}

// Sums base + bonus effects across the equipped instances into combat totals.
// element_spell_power accrues to the contributing (weapon) instance's own element.
export function aggregateEquipmentEffects(resolved) {
  const effects = { attack: 0, defense: 0, max_hp: 0, max_mp: 0, spell_mp_discount: 0, self_heal_bonus: 0, element_spell_power: {} };
  for (const slot of EQUIPMENT_SLOTS) {
    const instance = resolved[slot];
    if (!instance) continue;
    for (const source of [instance.base_effects, instance.bonus_effects]) {
      for (const [key, value] of Object.entries(source)) {
        if (key === 'element_spell_power') effects.element_spell_power[instance.element] = (effects.element_spell_power[instance.element] ?? 0) + value;
        else effects[key] += value;
      }
    }
  }
  return effects;
}

// Additive display summary of an equipped instance for the run view.
export function equipmentInstanceSummary(instance) {
  return {
    instance_id: instance.instance_id,
    kind: instance.kind,
    ...(instance.kind === 'weapon' ? { weapon_type: instance.weapon_type } : {}),
    element: instance.element,
    tier: instance.tier,
    quality: instance.quality,
    name: instance.name,
    flavor: instance.flavor,
    base_effects: { ...instance.base_effects },
    bonus_effects: { ...instance.bonus_effects }
  };
}

// Builds the per-run equipment snapshot: per-slot display summaries plus the
// aggregated combat effect totals. Returns null when nothing is equipped.
export function buildRunEquipment({ slots, surface }) {
  const resolved = resolveEquippedInstances({ slots, surface });
  if (!resolved.weapon && !resolved.amulet) return null;
  return {
    slots: {
      weapon: resolved.weapon ? equipmentInstanceSummary(resolved.weapon) : null,
      amulet: resolved.amulet ? equipmentInstanceSummary(resolved.amulet) : null
    },
    effects: aggregateEquipmentEffects(resolved)
  };
}

// Resolves one explicit owner's run equipment snapshot from runtime_state at entry
// (`'player'` or a selectable companion character id). Unequipped (absent slots)
// short-circuits to null without touching the surface. The target is required —
// `readEquipmentSlots` fails fast on an omitted or invalid owner.
export async function resolveRunEquipment({ root, storage, state, target } = {}) {
  const slots = readEquipmentSlots(state, target);
  if (slots.weapon === null && slots.amulet === null) return null;
  const surface = await loadEquipmentSurface({ storage: storageFor({ root, storage }) });
  return buildRunEquipment({ slots, surface });
}

// Folds the equipment effect totals onto a derived combat stat block. Stat-shaped
// effects merge into the snapshot the dungeon persists at entry; spell MP discount
// and self-heal bonus are applied by their consumers, not stored here. A null
// snapshot returns the stats unchanged (no equipment = no numeric change).
export function applyEquipmentToCombatStats(stats, equipment) {
  if (!equipment) return stats;
  const effects = equipment.effects;
  const spellPower = { ...stats.spell_power };
  for (const [element, bonus] of Object.entries(effects.element_spell_power)) {
    spellPower[element] = (spellPower[element] ?? 0) + bonus;
  }
  return {
    ...stats,
    max_hp: stats.max_hp + effects.max_hp,
    max_mp: stats.max_mp + effects.max_mp,
    melee_attack: stats.melee_attack + effects.attack,
    defense: stats.defense + effects.defense,
    spell_power: spellPower
  };
}

// Occupied-only projection of one owner's slots (drops unequipped slots).
function occupiedSlots(slots) {
  const occupied = {};
  for (const slot of EQUIPMENT_SLOTS) {
    if (slots[slot] !== null) occupied[slot] = slots[slot];
  }
  return occupied;
}

// Serializes the whole equip picture back onto runtime_state, keeping the
// "absent field = unequipped" invariant on both surfaces: only occupied slots are
// stored, a fully-unequipped hero drops `equipment_slots`, an emptied companion entry
// is removed, and an emptied companion map drops `companion_equipment_slots`. No empty
// residue is ever written.
function writeAllEquipmentSlots(state, all) {
  const next = { ...state };
  const playerOccupied = occupiedSlots(all.player);
  if (Object.keys(playerOccupied).length === 0) delete next.equipment_slots;
  else next.equipment_slots = playerOccupied;

  const map = {};
  for (const [characterId, slots] of Object.entries(all.companions)) {
    const occupied = occupiedSlots(slots);
    if (Object.keys(occupied).length > 0) map[characterId] = occupied;
  }
  if (Object.keys(map).length === 0) delete next.companion_equipment_slots;
  else next.companion_equipment_slots = map;
  return next;
}

// Rejects equipping an instance already worn by any owner slot other than the exact
// target slot being written (re-equipping the same instance into the same slot is a
// no-op, not a conflict). Enforces one-of-a-kind exclusivity before any write, so a
// rejected equip leaves no partial state.
function assertInstanceFree({ all, instanceId, target, slot }) {
  for (const ref of iterateEquippedReferences(all)) {
    if (ref.instance_id !== instanceId) continue;
    if (ref.owner === target && ref.slot === slot) continue;
    throw new Error(`cannot equip ${instanceId}: already equipped by ${ownerSlotLabel(ref.owner, ref.slot)}`);
  }
}

// Returns the mutable slot object for an explicit owner within a read-all picture,
// creating an empty companion entry the first time that companion is equipped.
function targetSlotsIn(all, target) {
  if (target === PLAYER_EQUIP_TARGET) return all.player;
  return (all.companions[target] ??= { weapon: null, amulet: null });
}

// Equips an instance into an explicit owner's slot after verifying the instance
// exists, its kind matches the slot, and it is free of every other owner, then
// persists runtime_state. The whole equip picture is validated on read.
export async function equipItem({ root, storage, target, slot, instance_id } = {}) {
  assertEquipTarget(target);
  if (!SLOT_SET.has(slot)) throw new Error(`unknown equipment slot: ${slot}`);
  const instanceId = nonEmptyString(instance_id, 'instance_id');
  const api = storageFor({ root, storage });
  const surface = await loadEquipmentSurface({ storage: api });
  const instance = findEquipmentInstance(surface, instanceId);
  if (!instance) throw new Error(`cannot equip unknown instance: ${instanceId}`);
  if (instance.kind !== slot) throw new Error(`equipment slot ${slot} requires a ${slot}, but ${instanceId} is a ${instance.kind}`);
  const state = await api.readJson(RUNTIME_STATE_PATH);
  const all = readAllEquipmentSlots(state);
  assertInstanceFree({ all, instanceId, target, slot });
  targetSlotsIn(all, target)[slot] = instanceId;
  const nextState = writeAllEquipmentSlots(state, all);
  await api.writeJson(RUNTIME_STATE_PATH, nextState);
  return nextState;
}

// Clears an explicit owner's slot and persists runtime_state. The whole equip picture
// is validated on read.
export async function unequipItem({ root, storage, target, slot } = {}) {
  assertEquipTarget(target);
  if (!SLOT_SET.has(slot)) throw new Error(`unknown equipment slot: ${slot}`);
  const api = storageFor({ root, storage });
  const state = await api.readJson(RUNTIME_STATE_PATH);
  const all = readAllEquipmentSlots(state);
  targetSlotsIn(all, target)[slot] = null;
  const nextState = writeAllEquipmentSlots(state, all);
  await api.writeJson(RUNTIME_STATE_PATH, nextState);
  return nextState;
}
