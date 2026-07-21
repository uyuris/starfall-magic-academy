import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  moveToLocation,
  drawSanrinCreaturePlacements,
  ensureSanrinCreaturePlacements,
  evaluateLocationsForState,
  prepareAcademyStageSituationsForState,
  selectRerolledLocationSituation,
  validateAcademyStageSituations
} from '../src/fieldRuntime.mjs';
import { isCreatureId } from '../src/creatureCatalog.mjs';
import { projectRoot } from '../src/storage.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

function fixedRandomSequence(values) {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('fixed random sequence exhausted');
    return queue.shift();
  };
}

function creatureEncounterDefinition() {
  return {
    version: 1,
    encounter_probability: 1,
    locations: {
      sanrin_trailhead: ['creature_001', 'creature_004', 'creature_010', 'creature_012'],
      sanrin_conifer_forest: ['creature_002', 'creature_005', 'creature_009', 'creature_013', 'creature_014'],
      sanrin_stream_bank: ['creature_003', 'creature_006', 'creature_011', 'creature_015'],
      sanrin_mossy_shrine: ['creature_001', 'creature_003', 'creature_007', 'creature_008', 'creature_015']
    }
  };
}

async function splitFieldRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-field-split-'));
  await writeJson(root, 'data/definitions/game_data/locations.json', [
    {
      id: 'herbology_garden',
      region: 'academy',
      screen: 'field',
      visible_situation: '庭にいる。',
      visible_situation_variants: ['庭にいる。', '夕方の庭にいる。'],
      hotspots: []
    },
    {
      id: 'front_gate_morning',
      region: 'academy',
      screen: 'field',
      visible_situation: '門前にいる。',
      visible_situation_variants: ['門前にいる。', '朝の門前にいる。'],
      hotspots: []
    },
    {
      id: 'sanrin_trailhead',
      region: 'sanrin',
      screen: 'field',
      visible_situation: '山道入口にいる。',
      visible_situation_variants: ['山道入口にいる。'],
      hotspots: []
    },
    {
      id: 'sanrin_conifer_forest',
      region: 'sanrin',
      screen: 'field',
      visible_situation: '深い針葉樹林にいる。',
      visible_situation_variants: ['深い針葉樹林にいる。'],
      hotspots: []
    },
    {
      id: 'sanrin_stream_bank',
      region: 'sanrin',
      screen: 'field',
      visible_situation: '渓流のほとりにいる。',
      visible_situation_variants: ['渓流のほとりにいる。'],
      hotspots: []
    },
    {
      id: 'sanrin_mossy_shrine',
      region: 'sanrin',
      screen: 'field',
      visible_situation: '苔むした古祠にいる。',
      visible_situation_variants: ['苔むした古祠にいる。'],
      hotspots: []
    }
  ]);
  await writeJson(root, 'data/definitions/game_data/creature_encounters.json', creatureEncounterDefinition());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-map',
    visited_locations: ['herbology_garden'],
    global_flags: {},
    characters: {}
  });
  return root;
}

test('moveToLocation reads split locations/runtime state and writes mutable runtime state without creating legacy game_data files', async () => {
  const root = await splitFieldRoot();

  const result = await moveToLocation({ root, locationId: 'front_gate_morning', selectedVisibleSituation: '朝の門前にいる。' });

  assert.equal(result.location.id, 'front_gate_morning');
  assert.equal(result.location.visible_situation, '朝の門前にいる。');
  assert.equal(result.state.current_location_id, 'front_gate_morning');

  const savedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(savedState.current_location_id, 'front_gate_morning');
  assert.equal(savedState.current_location_visible_situation, '朝の門前にいる。');
  assert.equal(savedState.visited_locations.includes('front_gate_morning'), true);

  await assert.rejects(fs.access(path.join(root, 'game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('canonical creature encounter definition maps Sanrin field locations to valid creature ids', async () => {
  const definition = await readJson(projectRoot, 'data/definitions/game_data/creature_encounters.json');

  assert.equal(definition.version, 1);
  assert.equal(definition.encounter_probability, 1);
  assert.deepEqual(definition.locations, creatureEncounterDefinition().locations);
  for (const [locationId, creatureIds] of Object.entries(definition.locations)) {
    assert.match(locationId, /^sanrin_/);
    assert.equal(Array.isArray(creatureIds), true);
    assert.equal(creatureIds.length > 0, true);
    assert.equal(creatureIds.every((creatureId) => isCreatureId(creatureId)), true);
  }
});

test('drawSanrinCreaturePlacements fixes one creature per Sanrin field location from its candidate list', async (t) => {
  const root = await splitFieldRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Two random units per location (presence gate, then candidate index), in definition order.
  const placements = await drawSanrinCreaturePlacements({
    root,
    random: fixedRandomSequence([0, 0, 0, 0, 0, 0, 0, 0])
  });

  assert.deepEqual(placements, {
    sanrin_trailhead: 'creature_001',
    sanrin_conifer_forest: 'creature_002',
    sanrin_stream_bank: 'creature_003',
    sanrin_mossy_shrine: 'creature_001'
  });
  // Every placed creature is one of that location's authored candidates (prob=1 => all placed).
  for (const [locationId, creatureId] of Object.entries(placements)) {
    assert.equal(creatureEncounterDefinition().locations[locationId].includes(creatureId), true);
  }
});

test('moveToLocation no longer rolls a per-move creature encounter (placement is fixed)', async (t) => {
  const root = await splitFieldRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const moved = await moveToLocation({ root, locationId: 'sanrin_mossy_shrine' });
  assert.equal(moved.state.current_location_id, 'sanrin_mossy_shrine');
  assert.equal(Object.prototype.hasOwnProperty.call(moved.state, 'creature_encounter'), false);

  const saved = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'creature_encounter'), false);
});

test('ensureSanrinCreaturePlacements draws once, keeps it without force, and re-draws on force', async (t) => {
  const root = await splitFieldRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // One random unit per location (candidate index), in definition order; every location placed.
  const first = await ensureSanrinCreaturePlacements({ root, random: fixedRandomSequence([0, 0, 0, 0]) });
  assert.deepEqual(first, {
    sanrin_trailhead: 'creature_001',
    sanrin_conifer_forest: 'creature_002',
    sanrin_stream_bank: 'creature_003',
    sanrin_mossy_shrine: 'creature_001'
  });
  const saved = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.deepEqual(saved.sanrin_creature_placements, first);

  // Without force and with an existing full placement, ensure returns it without re-drawing.
  const again = await ensureSanrinCreaturePlacements({ root, random: () => { throw new Error('ensure must not re-draw without force'); } });
  assert.deepEqual(again, first);

  // Force re-draws (this time the last candidate of each location).
  const redrawn = await ensureSanrinCreaturePlacements({
    root,
    force: true,
    random: fixedRandomSequence([0.999, 0.999, 0.999, 0.999])
  });
  assert.deepEqual(redrawn, {
    sanrin_trailhead: 'creature_012',
    sanrin_conifer_forest: 'creature_014',
    sanrin_stream_bank: 'creature_015',
    sanrin_mossy_shrine: 'creature_015'
  });
});

test('drawSanrinCreaturePlacements fails fast for missing or invalid Sanrin creature encounter config', async (t) => {
  const missingRoot = await splitFieldRoot();
  const invalidRoot = await splitFieldRoot();
  const invalidCreatureRoot = await splitFieldRoot();
  t.after(async () => {
    await fs.rm(missingRoot, { recursive: true, force: true });
    await fs.rm(invalidRoot, { recursive: true, force: true });
    await fs.rm(invalidCreatureRoot, { recursive: true, force: true });
  });

  await fs.rm(path.join(missingRoot, 'data/definitions/game_data/creature_encounters.json'));
  await assert.rejects(
    () => drawSanrinCreaturePlacements({ root: missingRoot, random: () => 0 }),
    /missing creature encounter definition/
  );

  await writeJson(invalidRoot, 'data/definitions/game_data/creature_encounters.json', {
    ...creatureEncounterDefinition(),
    encounter_probability: 1.5
  });
  await assert.rejects(
    () => drawSanrinCreaturePlacements({ root: invalidRoot, random: () => 0 }),
    /creature encounter probability must be between 0 and 1/
  );

  await writeJson(invalidCreatureRoot, 'data/definitions/game_data/creature_encounters.json', {
    ...creatureEncounterDefinition(),
    locations: {
      ...creatureEncounterDefinition().locations,
      sanrin_stream_bank: ['creature_999']
    }
  });
  await assert.rejects(
    () => drawSanrinCreaturePlacements({ root: invalidCreatureRoot, random: () => 0 }),
    /unknown creature encounter candidate for sanrin_stream_bank: creature_999/
  );
});

test('ensureSanrinCreaturePlacements fails fast on a present but malformed placement (no silent redraw)', async (t) => {
  const root = await splitFieldRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const fullPlacement = {
    sanrin_trailhead: 'creature_001',
    sanrin_conifer_forest: 'creature_002',
    sanrin_stream_bank: 'creature_003',
    sanrin_mossy_shrine: 'creature_001'
  };

  // Each is present (not undefined) but not a valid full {locationId: creatureId} mapping
  // covering exactly the authored Sanrin locations.
  const malformedCases = [
    [],                                                          // not an object
    'creature_001',                                             // not an object
    42,                                                          // not an object
    null,                                                        // not an object
    { ...fullPlacement, sanrin_stream_bank: 'not_a_creature' }, // invalid creature id
    { ...fullPlacement, sanrin_stream_bank: 'creature_999' },   // out-of-range creature id
    { sanrin_stream_bank: 'creature_003' },                     // partial: missing other locations
    { ...fullPlacement, sanrin_unknown_grove: 'creature_001' }  // extra unknown location
  ];
  for (const malformed of malformedCases) {
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', { ...base, sanrin_creature_placements: malformed });
    // Fails fast both on the ensure-if-unassigned path and on the forced (weekly) reroll path
    // — a corrupted placement is never silently redrawn/overwritten.
    await assert.rejects(
      () => ensureSanrinCreaturePlacements({ root, random: () => 0 }),
      /sanrin_creature_placements/
    );
    await assert.rejects(
      () => ensureSanrinCreaturePlacements({ root, force: true, random: () => 0 }),
      /sanrin_creature_placements/
    );
  }

  // A valid full placement is returned unchanged on the non-force path (no redraw)...
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { ...base, sanrin_creature_placements: fullPlacement });
  const kept = await ensureSanrinCreaturePlacements({ root, random: () => { throw new Error('valid placement must not redraw'); } });
  assert.deepEqual(kept, fullPlacement);

  // ...and is re-drawn on the force path (weekly reroll over a valid placement).
  const redrawn = await ensureSanrinCreaturePlacements({ root, force: true, random: fixedRandomSequence([0.999, 0.999, 0.999, 0.999]) });
  assert.deepEqual(redrawn, {
    sanrin_trailhead: 'creature_012',
    sanrin_conifer_forest: 'creature_014',
    sanrin_stream_bank: 'creature_015',
    sanrin_mossy_shrine: 'creature_015'
  });
});

// Academy-map arrival stage-situation reroll (routing academy-map arrival contract). The engine functions
// are pure (state + locations + injectable RNG), so these build plain objects instead of touching fs.
function academyStageLocations() {
  return [
    {
      id: 'herbology_garden',
      region: 'academy',
      screen: 'field',
      visible_situation: 'H0',
      visible_situation_variants: ['H0', 'H1', 'H2'],
      hotspots: []
    },
    {
      id: 'courtyard_fountain',
      region: 'academy',
      screen: 'field',
      visible_situation: 'C0',
      visible_situation_variants: ['C0', 'C1', 'C2'],
      hotspots: []
    },
    {
      // Event-screen academy location: rendered on no map surface, never part of the reroll or the
      // evaluated field.
      id: 'sealed_ritual_room',
      region: 'academy',
      screen: 'event',
      visible_situation: 'E0',
      visible_situation_variants: ['E0', 'E1'],
      hotspots: []
    },
    {
      // Single-variant academy stage: the one case where the reroll may repeat (nothing else to pick).
      id: 'lonely_stage',
      region: 'academy',
      screen: 'field',
      visible_situation: 'L0',
      visible_situation_variants: ['L0'],
      hotspots: []
    },
    {
      id: 'sanrin_trailhead',
      region: 'sanrin',
      screen: 'field',
      visible_situation: 'S0',
      visible_situation_variants: ['S0', 'S1'],
      hotspots: []
    }
  ];
}

function academyStageState(overrides = {}) {
  return {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-map',
    global_flags: {},
    characters: {},
    ...overrides
  };
}

test('routing academy-map arrival rerolls every academy stage from its variants, excludes the previous value, and stays deterministic under injected RNG', () => {
  const locations = academyStageLocations();
  const state = academyStageState();

  // Reroll order follows locations order over academy field stages only: herbology_garden, then
  // courtyard_fountain, then lonely_stage (event/sanrin stages consume no RNG).
  const first = prepareAcademyStageSituationsForState({
    state,
    locations,
    random: fixedRandomSequence([0, 0, 0])
  });

  // herbology previous='H0' -> candidates ['H1','H2'] -> index 0 -> 'H1'.
  // courtyard previous='C0' -> candidates ['C1','C2'] -> index 0 -> 'C1'.
  // lonely_stage has a single variant equal to its previous value, so the pool falls back to that
  // variant and it repeats — the only same-value case.
  assert.deepEqual(first.situations, {
    herbology_garden: 'H1',
    courtyard_fountain: 'C1',
    lonely_stage: 'L0'
  });
  assert.equal(Object.prototype.hasOwnProperty.call(first.situations, 'sealed_ritual_room'), false, 'event-screen academy locations are never rerolled');
  assert.equal(Object.prototype.hasOwnProperty.call(first.situations, 'sanrin_trailhead'), false, 'sanrin (non-academy) stages are never rerolled');
  assert.deepEqual(first.state.academy_stage_situations, first.situations);
  // The current stage's precedence stamp is synced to its new selection so the map + conversation agree.
  assert.equal(first.state.current_location_visible_situation, 'H1');

  // Every selected value belongs to that stage's variants and differs from what it previously showed
  // (except the single-variant stage).
  for (const [locationId, situation] of Object.entries(first.situations)) {
    const location = locations.find((item) => item.id === locationId);
    assert.equal(location.visible_situation_variants.includes(situation), true);
  }
  assert.notEqual(first.situations.herbology_garden, 'H0');
  assert.notEqual(first.situations.courtyard_fountain, 'C0');

  // A second arrival from the persisted state changes every multi-variant stage again: herbology now
  // excludes 'H1' (its persisted current-stage value), courtyard excludes 'C1'.
  const second = prepareAcademyStageSituationsForState({
    state: first.state,
    locations,
    random: fixedRandomSequence([0.99, 0.99, 0])
  });
  // herbology previous='H1' -> candidates ['H0','H2'] -> index floor(0.99*2)=1 -> 'H2'.
  // courtyard previous='C1' -> candidates ['C0','C2'] -> index 1 -> 'C2'.
  assert.deepEqual(second.situations, {
    herbology_garden: 'H2',
    courtyard_fountain: 'C2',
    lonely_stage: 'L0'
  });
  assert.equal(second.state.current_location_visible_situation, 'H2');
  assert.notEqual(second.situations.herbology_garden, first.situations.herbology_garden);
  assert.notEqual(second.situations.courtyard_fountain, first.situations.courtyard_fountain);
});

test('evaluateLocationsForState reads the persisted stage situations: current-stage precedence, per-arrival selection, authored default', () => {
  const locations = academyStageLocations();
  const state = academyStageState({
    current_location_id: 'herbology_garden',
    current_location_visible_situation: 'H2',
    academy_stage_situations: { herbology_garden: 'H1', courtyard_fountain: 'C1' }
  });

  const evaluated = evaluateLocationsForState({ state, locations });
  const byId = Object.fromEntries(evaluated.map((location) => [location.id, location]));

  // Current stage: current_location_visible_situation wins over the per-arrival selection.
  assert.equal(byId.herbology_garden.visible_situation, 'H2');
  // Non-current academy stage with a persisted selection reads it.
  assert.equal(byId.courtyard_fountain.visible_situation, 'C1');
  // Academy stage without a persisted selection shows its authored default.
  assert.equal(byId.lonely_stage.visible_situation, 'L0');
  // Sanrin (non-academy) stage is untouched by academy_stage_situations.
  assert.equal(byId.sanrin_trailhead.visible_situation, 'S0');
  // Event-screen academy locations are filtered out of the evaluated field entirely.
  assert.equal(Object.prototype.hasOwnProperty.call(byId, 'sealed_ritual_room'), false);
});

test('after a routing academy-map arrival the map and the conversation context read the same persisted value for the current stage', () => {
  const locations = academyStageLocations();
  const state = academyStageState();

  const arrival = prepareAcademyStageSituationsForState({
    state,
    locations,
    random: fixedRandomSequence([0.99, 0, 0])
  });

  // The map DOM reads the evaluated field's visible_situation; the conversation context reads
  // current_location_visible_situation for the current stage. They must be the same value.
  const evaluated = evaluateLocationsForState({ state: arrival.state, locations });
  const currentStage = evaluated.find((location) => location.id === arrival.state.current_location_id);
  assert.equal(currentStage.visible_situation, arrival.state.current_location_visible_situation);
  // And that value is a real reroll (not the authored default it started from).
  assert.notEqual(currentStage.visible_situation, 'H0');
});

test('an old save with no academy_stage_situations reads authored defaults and does not reroll on read', () => {
  const locations = academyStageLocations();
  const state = academyStageState();
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'academy_stage_situations'), false);

  const before = JSON.stringify(state);
  const evaluated = evaluateLocationsForState({ state, locations });
  const byId = Object.fromEntries(evaluated.map((location) => [location.id, location]));
  assert.equal(byId.herbology_garden.visible_situation, 'H0');
  assert.equal(byId.courtyard_fountain.visible_situation, 'C0');
  assert.equal(byId.lonely_stage.visible_situation, 'L0');
  // Reading the field is a pure evaluation — it never selects or persists a situation (idempotent).
  assert.equal(JSON.stringify(state), before, 'evaluateLocationsForState must not mutate state');
});

test('reading the field is idempotent: repeated evaluations return the same stage descriptions and never mutate state', () => {
  const locations = academyStageLocations();
  const arrival = prepareAcademyStageSituationsForState({
    state: academyStageState(),
    locations,
    random: fixedRandomSequence([0, 0, 0])
  });
  const persisted = JSON.stringify(arrival.state);

  const first = evaluateLocationsForState({ state: arrival.state, locations });
  const second = evaluateLocationsForState({ state: arrival.state, locations });
  const third = evaluateLocationsForState({ state: arrival.state, locations });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(JSON.stringify(arrival.state), persisted, 'repeated /api/field-style reads never rewrite the persisted situations');
});

test('malformed academy_stage_situations fails fast on read and on reroll — never silently ignored or redrawn', () => {
  const locations = academyStageLocations();
  const malformedCases = [
    'H1',                                          // not an object
    42,                                            // not an object
    null,                                          // not an object
    ['H1'],                                        // array, not an object
    { herbology_garden: 'H9' },                    // situation outside the stage's variants
    { herbology_garden: 42 },                      // non-string situation
    { unknown_stage: 'H1' },                       // unknown location id
    { sealed_ritual_room: 'E1' },                  // event-screen academy location is not a map stage
    { sanrin_trailhead: 'S1' }                     // sanrin (non-academy) location is not a map stage
  ];
  for (const malformed of malformedCases) {
    const state = academyStageState({ academy_stage_situations: malformed });
    assert.throws(() => evaluateLocationsForState({ state, locations }), /academy_stage_situations/);
    // The forced arrival reroll validates the present value first — a corrupted map is never redrawn over.
    assert.throws(
      () => prepareAcademyStageSituationsForState({ state, locations, random: () => 0 }),
      /academy_stage_situations/
    );
  }

  // A well-formed value passes both paths.
  const validState = academyStageState({ academy_stage_situations: { herbology_garden: 'H1' } });
  assert.deepEqual(validateAcademyStageSituations(validState.academy_stage_situations, {
    locationsById: new Map(locations.map((location) => [location.id, location]))
  }), { herbology_garden: 'H1' });
});

test('selectRerolledLocationSituation excludes the previous value and only repeats for a single-variant stage', () => {
  const multi = { id: 'multi', visible_situation_variants: ['A', 'B', 'C'] };
  // previous='A' -> candidates ['B','C']; index 0 -> 'B'.
  assert.equal(selectRerolledLocationSituation({ location: multi, previousSituation: 'A', random: () => 0 }), 'B');
  // previous='A' -> candidates ['B','C']; index floor(0.99*2)=1 -> 'C'.
  assert.equal(selectRerolledLocationSituation({ location: multi, previousSituation: 'A', random: () => 0.99 }), 'C');

  const single = { id: 'single', visible_situation_variants: ['ONLY'] };
  // Only one variant: the pool falls back to the full variants list and repeats.
  assert.equal(selectRerolledLocationSituation({ location: single, previousSituation: 'ONLY', random: () => 0 }), 'ONLY');
});
