import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isCreatureId } from './creatureCatalog.mjs';
import { createStorageApi } from './storage.mjs';

function storageApiFor(rootOrStorage) {
  if (rootOrStorage && typeof rootOrStorage.readJson === 'function' && typeof rootOrStorage.writeJson === 'function') {
    return rootOrStorage;
  }
  return createStorageApi({ root: rootOrStorage });
}

async function readJson(rootOrStorage, relativePath) {
  return await storageApiFor(rootOrStorage).readJson(relativePath);
}

async function writeJson(rootOrStorage, relativePath, value) {
  await storageApiFor(rootOrStorage).writeJson(relativePath, value);
}

async function readCreatureEncounterDefinition(storage) {
  const definitionPath = path.join(storage.paths.definitionsRoot, 'creature_encounters.json');
  let raw = '';
  try {
    raw = await fs.readFile(definitionPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`missing creature encounter definition: ${definitionPath}`);
    throw error;
  }
  return JSON.parse(raw);
}

function validateCreatureEncounterProbability(definition) {
  if (typeof definition?.encounter_probability !== 'number' || !Number.isFinite(definition.encounter_probability)) {
    throw new Error('creature encounter probability is required');
  }
  if (definition.encounter_probability < 0 || definition.encounter_probability > 1) {
    throw new Error(`creature encounter probability must be between 0 and 1: ${definition.encounter_probability}`);
  }
  return definition.encounter_probability;
}

function validateCreatureEncounterDefinition({ definition, locations }) {
  if (definition?.version !== 1) throw new Error(`unsupported creature encounter definition version: ${definition?.version ?? '(missing)'}`);
  const probability = validateCreatureEncounterProbability(definition);
  const configuredLocations = definition?.locations;
  if (!configuredLocations || typeof configuredLocations !== 'object' || Array.isArray(configuredLocations)) {
    throw new Error('creature encounter locations must be an object');
  }
  const locationById = new Map(locations.map((location) => [location.id, location]));
  for (const [locationId, creatureIds] of Object.entries(configuredLocations)) {
    const location = locationById.get(locationId);
    if (!location) throw new Error(`unknown creature encounter location: ${locationId}`);
    if (location.region !== 'sanrin') throw new Error(`creature encounter location is not Sanrin: ${locationId}`);
    if (!Array.isArray(creatureIds) || creatureIds.length === 0) {
      throw new Error(`creature encounter candidates are required for ${locationId}`);
    }
    for (const creatureId of creatureIds) {
      if (!isCreatureId(creatureId)) throw new Error(`unknown creature encounter candidate for ${locationId}: ${creatureId}`);
    }
  }
  return { probability, locations: configuredLocations };
}

function randomUnit(random, label) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${label} random value must be in [0, 1): ${value}`);
  }
  return value;
}

function drawPlacementsFromDefinition({ definition, random }) {
  const placements = {};
  // Every authored Sanrin location is placed (lead-confirmed: 全地点に必ず1体), one
  // creature chosen uniformly from that location's authored candidate list.
  for (const [locationId, candidates] of Object.entries(definition.locations)) {
    placements[locationId] = candidates[Math.floor(randomUnit(random, `sanrin placement candidate ${locationId}`) * candidates.length)];
  }
  return placements;
}

// Draws the fixed Sanrin creature placement: one creature per configured Sanrin field
// location. There is no silent fallback — the definition is validated and missing data
// fails fast.
export async function drawSanrinCreaturePlacements({ root, random = Math.random }) {
  const storage = storageApiFor(root);
  const locations = await readJson(storage, 'game_data/locations.json');
  const definition = validateCreatureEncounterDefinition({
    definition: await readCreatureEncounterDefinition(storage),
    locations
  });
  return drawPlacementsFromDefinition({ definition, random });
}

// Validates a persisted Sanrin placement value. `undefined` means "not yet assigned"
// (the ensure-if-unassigned case). Any other present-but-malformed value is corrupted
// runtime state and fails fast — never silently redrawn over, ignored, or suppressed.
// When `expectedLocationIds` is given, the mapping must cover exactly that location set
// (every Sanrin location has exactly one fixed creature — no partial/extra/mismatched).
export function validateSanrinCreaturePlacements(value, { expectedLocationIds = null } = {}) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`sanrin_creature_placements must be a {locationId: creatureId} object: ${JSON.stringify(value)}`);
  }
  for (const [locationId, creatureId] of Object.entries(value)) {
    if (typeof creatureId !== 'string' || !isCreatureId(creatureId)) {
      throw new Error(`sanrin_creature_placements has an invalid creature for ${locationId}: ${JSON.stringify(creatureId)}`);
    }
  }
  if (expectedLocationIds) {
    const expected = new Set(expectedLocationIds);
    const keys = Object.keys(value);
    if (keys.length !== expected.size || !keys.every((key) => expected.has(key))) {
      throw new Error(`sanrin_creature_placements must cover exactly the Sanrin locations [${[...expected].sort().join(', ')}]: got [${[...keys].sort().join(', ')}]`);
    }
  }
  return value;
}

// Fixes the Sanrin creature placement in runtime state. With `force` (a new week) it
// re-draws; otherwise it draws only when no placement exists yet (ensure-if-unassigned),
// mirroring how the academy map fixes its stage occupants once and keeps them. A present
// placement is validated against the authored Sanrin location set (shape, creature ids,
// and full coverage) and fails fast on any malformed/partial value — never silently redrawn.
export async function ensureSanrinCreaturePlacements({ root, random = Math.random, force = false }) {
  const storage = storageApiFor(root);
  const [state, locations] = await Promise.all([
    readJson(storage, 'game_data/runtime_state.json'),
    readJson(storage, 'game_data/locations.json')
  ]);
  const { placements, state: nextState } = await prepareSanrinCreaturePlacementsForState({
    root: storage,
    state,
    locations,
    random,
    force
  });
  if (nextState !== state) await writeJson(storage, 'game_data/runtime_state.json', nextState);
  return placements;
}

export async function prepareSanrinCreaturePlacementsForState({
  root,
  state,
  locations = null,
  random = Math.random,
  force = false
}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to prepare Sanrin creature placements');
  }
  const storage = storageApiFor(root);
  const resolvedLocations = locations ?? await readJson(storage, 'game_data/locations.json');
  const definition = validateCreatureEncounterDefinition({
    definition: await readCreatureEncounterDefinition(storage),
    locations: resolvedLocations
  });
  const expectedLocationIds = Object.keys(definition.locations);
  // A present placement must always be well-formed; a corrupted value fails fast even on a
  // forced (weekly) reroll — it is never silently redrawn/overwritten or ignored.
  const existing = validateSanrinCreaturePlacements(state.sanrin_creature_placements, { expectedLocationIds });
  if (!force && existing !== undefined) return { placements: existing, state };
  const placements = drawPlacementsFromDefinition({ definition, random });
  return {
    placements,
    state: {
      ...state,
      sanrin_creature_placements: placements
    }
  };
}


function readFlag(state, flag) {
  if (Object.prototype.hasOwnProperty.call(state.global_flags ?? {}, flag)) return state.global_flags[flag];
  for (const character of Object.values(state.characters ?? {})) {
    if (Object.prototype.hasOwnProperty.call(character.flags ?? {}, flag)) return character.flags[flag];
  }
  return undefined;
}

function conditionMatches(state, condition) {
  const actual = readFlag(state, condition.flag);
  if (condition.op === 'eq') return actual === condition.value;
  if (condition.op === 'neq') return actual !== condition.value;
  throw new Error(`unsupported location condition op: ${condition.op}`);
}

function conditionGroupMatches(state, group) {
  const all = group?.all ?? [];
  return all.every((condition) => conditionMatches(state, condition));
}

function evaluateHotspotForState({ state, hotspot }) {
  if (hotspot.visible_if && !conditionGroupMatches(state, hotspot.visible_if)) return null;
  const enabled = hotspot.enabled_if ? conditionGroupMatches(state, hotspot.enabled_if) : true;
  return {
    ...hotspot,
    disabled: !enabled,
    ...(enabled ? {} : { disabled_reason: hotspot.disabled_reason ?? 'まだ移動条件を満たしていません。' })
  };
}

function locationDescriptionVariants(location) {
  return Array.from(new Set([
    location.visible_situation,
    ...(location.visible_situation_variants ?? []),
    ...(location.description_variants ?? [])
  ].map((value) => String(value ?? '').trim()).filter(Boolean)));
}

export function selectRandomLocationSituation({ location, random = Math.random }) {
  const variants = locationDescriptionVariants(location);
  if (variants.length === 0) return null;
  const index = Math.floor(randomUnit(random, 'location situation selection') * variants.length);
  return variants[index];
}

// The academy map renders academy-region field locations. Their stage descriptions reroll on every
// routing academy-map arrival (see prepareAcademyStageSituationsForState). Sanrin and event-screen
// locations are never part of that surface.
function isAcademyStageLocation(location) {
  return location?.region === 'academy' && (!location.screen || location.screen === 'field');
}

// Validates the persisted per-arrival stage selection map `runtime_state.academy_stage_situations`.
// `undefined` is the one legitimate absence — "not yet rerolled", every stage shows its authored default
// (old saves read cleanly). A present value must be a plain object whose keys are academy map stages and
// whose values are one of that stage's authored description variants. Any other present value is corrupted
// runtime state and fails fast — it is never silently ignored, defaulted, or redrawn over.
export function validateAcademyStageSituations(value, { locationsById }) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`academy_stage_situations must be a {locationId: situation} object: ${JSON.stringify(value)}`);
  }
  for (const [locationId, situation] of Object.entries(value)) {
    const location = locationsById.get(locationId);
    if (!location || !isAcademyStageLocation(location)) {
      throw new Error(`academy_stage_situations has an unknown academy map stage: ${locationId}`);
    }
    if (typeof situation !== 'string' || !locationDescriptionVariants(location).includes(situation)) {
      throw new Error(`academy_stage_situations situation for ${locationId} is not one of its variants: ${JSON.stringify(situation)}`);
    }
  }
  return value;
}

// The single place the stage-description precedence lives, so the map DOM and the reroll's "previous
// value" read the same truth: the current stage's persisted current_location_visible_situation wins (set
// by moveToLocation / event start / in-session stage move), then a persisted per-arrival
// academy_stage_situations selection, then the authored default. Assumes academy_stage_situations has
// already passed validateAcademyStageSituations.
function resolveLocationVisibleSituation(location, state) {
  const current = String(state.current_location_visible_situation ?? '').trim();
  if (current && location.id === state.current_location_id && locationDescriptionVariants(location).includes(current)) {
    return current;
  }
  const selected = state.academy_stage_situations?.[location.id];
  if (selected !== undefined) return selected;
  return location.visible_situation ?? '';
}

// Selects a stage situation for a routing academy-map arrival: uniformly from the location's authored
// description variants, excluding the value it currently shows so the description always changes on
// arrival. Only a single-variant stage may repeat (there is nothing else to pick). RNG is injectable so
// tests are deterministic.
export function selectRerolledLocationSituation({ location, previousSituation, random = Math.random }) {
  const variants = locationDescriptionVariants(location);
  if (variants.length === 0) return null;
  const previous = String(previousSituation ?? '').trim();
  const candidates = variants.filter((variant) => variant !== previous);
  const pool = candidates.length > 0 ? candidates : variants;
  const index = Math.floor(randomUnit(random, `academy stage situation ${location.id}`) * pool.length);
  return pool[index];
}

// Rerolls every academy map stage's visible situation for a routing academy-map arrival and returns the
// next runtime state. Each stage gets a fresh selection that differs from what it currently shows (the map
// truth), so entering the map always presents new descriptions. The current stage's
// current_location_visible_situation is kept in sync with its new selection, so the academy map and the
// conversation context read the same persisted truth (the map reads academy_stage_situations directly; the
// conversation reads current_location_visible_situation for the current stage and the value moveToLocation
// carries for the others). A present-but-malformed academy_stage_situations fails fast before rerolling —
// it is never silently redrawn over.
export function prepareAcademyStageSituationsForState({ state, locations, random = Math.random }) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to prepare academy stage situations');
  }
  const locationsById = new Map(locations.map((location) => [location.id, location]));
  validateAcademyStageSituations(state.academy_stage_situations, { locationsById });
  const situations = {};
  for (const location of locations) {
    if (!isAcademyStageLocation(location)) continue;
    const previousSituation = resolveLocationVisibleSituation(location, state);
    const selected = selectRerolledLocationSituation({ location, previousSituation, random });
    if (selected !== null) situations[location.id] = selected;
  }
  const nextState = { ...state, academy_stage_situations: situations };
  const currentLocation = locationsById.get(state.current_location_id);
  if (currentLocation && isAcademyStageLocation(currentLocation) && situations[currentLocation.id] !== undefined) {
    nextState.current_location_visible_situation = situations[currentLocation.id];
  }
  return { situations, state: nextState };
}

function applySelectedLocationSituation(location, state) {
  const resolved = resolveLocationVisibleSituation(location, state);
  if (resolved === (location.visible_situation ?? '')) return location;
  return { ...location, visible_situation: resolved };
}

export function evaluateLocationsForState({ state, locations }) {
  const locationsById = new Map(locations.map((location) => [location.id, location]));
  validateAcademyStageSituations(state.academy_stage_situations, { locationsById });
  return locations
    .filter((location) => !location.screen || location.screen === 'field')
    .map((location) => ({
      ...applySelectedLocationSituation(location, state),
      hotspots: (location.hotspots ?? [])
        .map((hotspot) => evaluateHotspotForState({ state, hotspot }))
        .filter(Boolean)
    }));
}

export function resolveSelectedLocationSituation({ location, selectedVisibleSituation }) {
  const selected = String(selectedVisibleSituation ?? '').trim();
  if (!selected) return location.visible_situation ?? '';
  const variants = locationDescriptionVariants(location);
  if (!variants.includes(selected)) {
    throw new Error(`selectedVisibleSituation must match a description variant for ${location.id}`);
  }
  return selected;
}

export async function moveToLocation({ root, locationId, selectedVisibleSituation = null }) {
  if (!root) throw new Error('root is required');
  if (!locationId) throw new Error('locationId is required');

  const storage = storageApiFor(root);
  const [state, locations] = await Promise.all([
    readJson(storage, 'game_data/runtime_state.json'),
    readJson(storage, 'game_data/locations.json')
  ]);
  const location = locations.find((item) => item.id === locationId);
  if (!location) throw new Error(`unknown location: ${locationId}`);
  if (location.screen && location.screen !== 'field') throw new Error(`location is not a field location: ${locationId}`);

  const currentLocationExists = locations.some((item) => item.id === state.current_location_id);
  if (!currentLocationExists) throw new Error(`unknown current location: ${state.current_location_id}`);
  const selectedSituation = resolveSelectedLocationSituation({ location, selectedVisibleSituation });

  const nextState = JSON.parse(JSON.stringify(state));
  nextState.current_location_id = location.id;
  nextState.current_location_visible_situation = selectedSituation;
  nextState.current_screen = 'field';
  nextState.current_interaction_character_id = null;
  nextState.pending_interaction_context = null;
  // Creature presence is a fixed per-location placement (drawn on the Sanrin map and
  // re-drawn weekly), not a per-move roll; moving no longer rolls an encounter. Any legacy
  // per-move encounter on the persisted state is cleared so no stale trace survives.
  delete nextState.creature_encounter;
  const visited = nextState.visited_locations ?? [];
  nextState.visited_locations = visited.includes(location.id) ? visited : [...visited, location.id];
  await writeJson(storage, 'game_data/runtime_state.json', nextState);
  return { location: { ...location, visible_situation: selectedSituation }, state: nextState };
}
