import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { baselineRuntimeState, fixtureRoot, readJson, writeJson } from './helpers.mjs';
import { buildRoutingHubContextSnapshot } from '../src/routingHubContextSnapshot.mjs';
import { buildRoutingMetaContext, normalizeRoutingHubContext } from '../src/routingMetaContext.mjs';
import { loadStarCradleCatalog } from '../src/starCradleCatalog.mjs';
import { deriveVariety } from '../src/starCradle.mjs';

const PLANT_SEED_ITEM = 'star_cradle_hoshikusa_seed';
const CREATURE_EGG_ITEM = 'star_cradle_madara_egg';

function routingState(overrides = {}) {
  return {
    ...baselineRuntimeState,
    elapsed_weeks: 3,
    current_buddy_character_id: null,
    current_enemy_character_ids: [],
    ...overrides
  };
}

// A hub-context literal with every required field, used to exercise the renderer / normalizer in isolation (same
// shape the snapshot produces). star_cradle_context is added per test.
function baseHubContext(overrides = {}) {
  return {
    persona_variant: 'fallen_star',
    recent_conversation_context: { kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null },
    relationship_context: { buddy: null, enemies: [] },
    alchemy_context: { recipe_count: 10 },
    study_circle_context: { theme_count: 20, weekly_offer_count: 3 },
    content_result_context: null,
    ...overrides
  };
}

function potRecord({ slotIndex = 0, itemId = PLANT_SEED_ITEM, plantedWeek, seed, feed = {} }) {
  return { slot_index: slotIndex, item_id: itemId, planted_week: plantedWeek, seed, feed };
}

function creatureRecord({ slotIndex = 0, itemId = CREATURE_EGG_ITEM, plantedWeek, seed, feed = {}, name = null, lastByproductWeek }) {
  return { slot_index: slotIndex, item_id: itemId, planted_week: plantedWeek, seed, feed, name, last_byproduct_week: lastByproductWeek ?? plantedWeek };
}

async function writeGarden(root, { pots = [], creatures = [] } = {}) {
  await writeJson(root, 'game_data/star_cradle.json', { version: 1, pots, creatures });
}

async function writeCaged(root, instances) {
  await writeJson(root, 'game_data/star_cradle_creatures.json', { version: 1, instances });
}

// ----- snapshot builder -----

test('buildRoutingHubContextSnapshot renders an empty garden as empty arrays (no surface file present)', async () => {
  const root = await fixtureRoot('star-cradle-hub-empty-', { runtimeState: routingState() });
  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.deepEqual(context.star_cradle_context, { pots: [], creatures: [], caged: [] });
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot exposes disclosed status only: pre-reveal individuals never leak their hidden variety', async () => {
  const root = await fixtureRoot('star-cradle-hub-prereveal-', { runtimeState: routingState({ elapsed_weeks: 4 }) });
  // Planted this very week: elapsed 0 weeks, so neither the pot nor the egg has revealed. The egg carries a
  // player-set name (disclosed at any stage).
  await writeGarden(root, {
    pots: [potRecord({ slotIndex: 0, plantedWeek: 4, seed: 12345 })],
    creatures: [creatureRecord({ slotIndex: 0, plantedWeek: 4, seed: 54321, name: 'たまちゃん' })]
  });
  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  const [pot] = context.star_cradle_context.pots;
  assert.equal(pot.revealed, false);
  assert.equal(pot.stage, '芽');
  assert.equal(pot.seed_item_name, 'ほしくさの種');
  assert.equal(Object.hasOwn(pot, 'variety_name'), false);

  const [creature] = context.star_cradle_context.creatures;
  assert.equal(creature.revealed, false);
  assert.equal(creature.adult, false);
  assert.equal(creature.stage, '卵');
  assert.equal(creature.name, 'たまちゃん');
  assert.equal(Object.hasOwn(creature, 'variety_name'), false);
  assert.equal(Object.hasOwn(creature, 'mutation_name'), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot discloses variety after bloom / hatch and the second form once adult', async () => {
  const root = await fixtureRoot('star-cradle-hub-revealed-', { runtimeState: routingState({ elapsed_weeks: 80 }) });
  const catalog = await loadStarCradleCatalog({ root });
  // Planted long ago: the pot has bloomed and the creature is a fully-grown adult resident.
  await writeGarden(root, {
    pots: [potRecord({ slotIndex: 0, plantedWeek: 0, seed: 777 })],
    creatures: [creatureRecord({ slotIndex: 0, plantedWeek: 0, seed: 888, name: 'ミント', lastByproductWeek: 80 })]
  });
  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  const [pot] = context.star_cradle_context.pots;
  assert.equal(pot.revealed, true);
  assert.equal(pot.stage, '開花');
  assert.equal(pot.variety_name, deriveVariety(catalog, PLANT_SEED_ITEM, 777, {}).name);

  const [creature] = context.star_cradle_context.creatures;
  assert.equal(creature.revealed, true);
  assert.equal(creature.adult, true);
  assert.equal(creature.stage, '成体');
  assert.equal(creature.variety_name, deriveVariety(catalog, CREATURE_EGG_ITEM, 888, {}).name);
  // The second-form field is present for an adult (null when it did not take its mutation), never before.
  assert.equal(Object.hasOwn(creature, 'mutation_name'), true);
  assert.ok(creature.mutation_name === null || typeof creature.mutation_name === 'string');
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot reports caged one-off creatures with their disclosed name and variety', async () => {
  const root = await fixtureRoot('star-cradle-hub-caged-', { runtimeState: routingState() });
  const catalog = await loadStarCradleCatalog({ root });
  await writeCaged(root, [
    { instance_id: 'sc_creature_999', item_id: CREATURE_EGG_ITEM, seed: 999, feed: {}, name: 'こまち', caged_week: 2 }
  ]);
  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.deepEqual(context.star_cradle_context.caged, [
    { name: 'こまち', variety_name: deriveVariety(catalog, CREATURE_EGG_ITEM, 999, {}).name }
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

// ----- normalize (optional present-only passthrough + disclosure fail-fast) -----

test('normalizeRoutingHubContext passes star_cradle_context through only when supplied', () => {
  const withField = normalizeRoutingHubContext(baseHubContext({ star_cradle_context: { pots: [], creatures: [], caged: [] } }));
  assert.deepEqual(withField.star_cradle_context, { pots: [], creatures: [], caged: [] });
  // A pre-field persisted hub context (no star_cradle_context) keeps the old shape: the key is simply absent, so
  // an in-flight hub conversation started before this field does not 409.
  const withoutField = normalizeRoutingHubContext(baseHubContext());
  assert.equal(Object.hasOwn(withoutField, 'star_cradle_context'), false);
});

test('normalizeRoutingHubContext fails fast on a leaked hidden variety and impossible stages', () => {
  const leakedPotVariety = baseHubContext({
    star_cradle_context: { pots: [{ stage: '蕾', seed_item_name: 'ほしくさの種', revealed: false, variety_name: '星辰草' }], creatures: [], caged: [] }
  });
  assert.throws(() => normalizeRoutingHubContext(leakedPotVariety), /variety_name must be absent before the plant blooms/);

  const leakedCreatureVariety = baseHubContext({
    star_cradle_context: { pots: [], creatures: [{ stage: '卵', seed_item_name: 'まだらの卵', revealed: false, adult: false, name: null, variety_name: '灯り兎' }], caged: [] }
  });
  assert.throws(() => normalizeRoutingHubContext(leakedCreatureVariety), /variety_name must be absent before the egg hatches/);

  const leakedMutation = baseHubContext({
    star_cradle_context: { pots: [], creatures: [{ stage: '幼体', seed_item_name: 'まだらの卵', revealed: true, adult: false, name: null, variety_name: '灯り兎', mutation_name: '月光種' }], caged: [] }
  });
  assert.throws(() => normalizeRoutingHubContext(leakedMutation), /mutation_name must be absent before the creature is an adult/);

  const impossibleStage = baseHubContext({
    star_cradle_context: { pots: [], creatures: [{ stage: '成体', seed_item_name: 'まだらの卵', revealed: false, adult: true, name: null }], caged: [] }
  });
  assert.throws(() => normalizeRoutingHubContext(impossibleStage), /adult requires revealed/);

  const unexpectedKey = baseHubContext({ star_cradle_context: { pots: [], creatures: [], caged: [], extra: 1 } });
  assert.throws(() => normalizeRoutingHubContext(unexpectedKey), /has unexpected key: extra/);
});

// ----- renderer (buildRoutingMetaContext) -----

test('the routing meta context renders 星の揺り籠 status lines only for a non-empty garden', () => {
  const empty = buildRoutingMetaContext({
    state: { elapsed_weeks: 3 },
    routingHubContext: baseHubContext({ star_cradle_context: { pots: [], creatures: [], caged: [] } })
  });
  assert.ok(!empty.includes('星の揺り籠で育っているもの'), 'no growing line for an empty garden');
  assert.ok(!empty.includes('星の揺り籠の籠入りの生き物'), 'no caged line for an empty garden');

  // Absent star_cradle_context (a pre-field persisted context) renders nothing either.
  const absent = buildRoutingMetaContext({ state: { elapsed_weeks: 3 }, routingHubContext: baseHubContext() });
  assert.ok(!absent.includes('星の揺り籠で育っているもの'));
});

test('the routing meta context renders disclosed 星の揺り籠 status: stages/seed pre-reveal, variety after, second form and caged', () => {
  const meta = buildRoutingMetaContext({
    state: { elapsed_weeks: 3 },
    routingHubContext: baseHubContext({
      star_cradle_context: {
        pots: [
          { stage: '蕾', seed_item_name: 'ほしくさの種', revealed: false },
          { stage: '開花', seed_item_name: 'ゆらぎの球根', revealed: true, variety_name: '夜露草' }
        ],
        creatures: [
          { stage: '卵', seed_item_name: 'まだらの卵', revealed: false, adult: false, name: 'たま' },
          { stage: '成体', seed_item_name: 'まだらの卵', revealed: true, adult: true, name: 'ミント', variety_name: '灯り兎', mutation_name: '月光種' }
        ],
        caged: [{ name: 'こまち', variety_name: '砂かけ狐' }]
      }
    })
  });
  // Growing line: pre-reveal by stage + seed item (no variety leaked), revealed by variety, adult by variety + form.
  assert.match(meta, /- 星の揺り籠で育っているもの: 蕾の鉢（ほしくさの種）、開花した鉢「夜露草」、卵「たま」（まだらの卵）、成体「ミント」（灯り兎・月光種）。/);
  assert.ok(!meta.includes('蕾の鉢（ほしくさの種）」'), 'a pre-reveal pot never prints a variety');
  // Caged line.
  assert.match(meta, /- 星の揺り籠の籠入りの生き物: 「こまち」（砂かけ狐）。/);
  // The lines sit inside the persona current-status block.
  assert.match(meta, /が参照できる現在状況:/);
});
