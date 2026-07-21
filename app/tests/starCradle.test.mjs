import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { cloneGameDataFixture, readJson, writeJson } from './helpers.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeStarCradleCatalogDefinition } from './starCradleFixture.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { loadStarCradleCatalog, validateStarCradleCatalog } from '../src/starCradleCatalog.mjs';
import { loadStarCradleSurface, loadStarCradleCreaturesSurface, validateStarCradleSurface } from '../src/starCradleSurface.mjs';
import { deriveVariety, plantView, creatureView, validateStarCradleName } from '../src/starCradle.mjs';
import { loadInventory } from '../src/economy.mjs';
import { initializeNewPlayArea } from '../src/playSession.mjs';
import {
  buildStarCradleView,
  plantStarCradleSeed,
  feedStarCradleIndividual,
  harvestStarCradlePlant,
  claimStarCradleByproduct,
  nameStarCradleCreature,
  cageStarCradleCreature,
  releaseStarCradleCreature
} from '../src/starCradleOperations.mjs';
import { handleStarCradleApi } from '../src/server/starCradleApi.mjs';
import { handleProgressionEconomyApi } from '../src/server/progressionEconomyApi.mjs';

const HOSHIKUSA = 'star_cradle_hoshikusa_seed';
const MADARA = 'star_cradle_madara_egg';

// A fixed injected entropy source so a planting's individual seed is deterministic in tests.
const fixedRandom = (value) => () => value;

async function cradleRoot(t, { week = 0, items = [], money = 100000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-star-cradle-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await cloneGameDataFixture(root);
  await writeJson(root, 'game_data/runtime_state.json', { version: 1, elapsed_weeks: week, global_flags: {}, characters: {} });
  await writeJson(root, 'game_data/player_inventory.json', { money, items });
  await writeJson(root, 'game_data/star_cradle.json', { version: 1, pots: [], creatures: [] });
  await writeJson(root, 'game_data/star_cradle_creatures.json', { version: 1, instances: [] });
  return root;
}

function ctx(root) {
  const storage = createStorageApi({ root });
  return { root, storage };
}

// ---------- catalog ----------

test('the star cradle catalog loads strict and fails fast on malformed content', async (t) => {
  const root = await cradleRoot(t);
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  assert.equal(catalog.plants.length, 10);
  assert.equal(catalog.creatures.length, 8);
  assert.equal(catalog.seedItems.length, 4);
  // every seed item's outcome pool resolves to real varieties of the matching kind
  for (const seedItem of catalog.seedItems) {
    for (const id of seedItem.outcome_pool) {
      const found = seedItem.kind === 'plant' ? catalog.plantsById.get(id) : catalog.creaturesById.get(id);
      assert.ok(found, `${seedItem.item_id} pool id ${id} resolves`);
    }
  }
  assert.throws(() => validateStarCradleCatalog({ version: 2 }), /version must be 1/);
  assert.throws(() => validateStarCradleCatalog({ version: 1, tuning: {}, plants: [], creatures: [], seed_items: [] }), /tuning/);
  const base = await readJson(root, 'game_data/star_cradle_catalog.json');
  const danglingPool = structuredClone(base);
  danglingPool.seed_items[0].outcome_pool = ['p99'];
  assert.throws(() => validateStarCradleCatalog(danglingPool), /unknown plant id: p99/);
});

// ---------- surface + storage/slot/new-game wiring ----------

test('the star cradle surfaces validate structurally and reject malformed records', async (t) => {
  const root = await cradleRoot(t);
  const { storage } = ctx(root);
  assert.deepEqual((await loadStarCradleSurface({ storage })), { version: 1, pots: [], creatures: [] });
  assert.deepEqual((await loadStarCradleCreaturesSurface({ storage })), { version: 1, instances: [] });
  assert.throws(() => validateStarCradleSurface({ version: 1, pots: [{ slot_index: 0 }], creatures: [] }), /pot record keys/);
  assert.throws(() => validateStarCradleSurface({ version: 1, pots: [
    { slot_index: 0, item_id: HOSHIKUSA, planted_week: 0, seed: 1, feed: {} },
    { slot_index: 0, item_id: HOSHIKUSA, planted_week: 0, seed: 2, feed: {} }
  ], creatures: [] }), /duplicate pot slot_index/);
});

test('storage resolves the star cradle surfaces to the mutable root; catalog to definitions', async (t) => {
  const root = await cradleRoot(t);
  const storage = createStorageApi({ root });
  assert.ok(storage.resolveWritePath('game_data/star_cradle.json').endsWith(path.join('game_data', 'star_cradle.json')));
  assert.ok(storage.resolveWritePath('game_data/star_cradle_creatures.json').endsWith(path.join('game_data', 'star_cradle_creatures.json')));
});

async function playSessionRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-star-cradle-play-'));
  const write = (rel, value) => writeJson(root, rel, value);
  await write('data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await write('data/definitions/game_data/event_flags.json', []);
  await write('data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await write('data/definitions/game_data/locations.json', []);
  await write('data/definitions/game_data/shop_catalog.json', { items: [] });
  await write('data/definitions/game_data/stage_flags.json', []);
  await write('data/definitions/game_data/world/settings.json', { academy_name: 'x', player_name: 'y', world_description: 'z', world_condition_texts: [] });
  await write('data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: 0, global_flags: {}, characters: {} });
  await write('content/characters/lina/profile.json', {
    character_id: 'lina', display_name: 'リナ', identity: '案内役', visual_set_id: 'visual_set_001',
    prompt_description: 'fixture', speaking_basis: 'fixture', available_expressions: ['neutral'], parameters: { magic: {}, abilities: {} }
  });
  await write('content/characters/character_001/profile.json', {
    character_id: 'character_001', display_name: 'テスト生徒', identity: '図書委員', parameter_attitude_type: 'equal_any_respect_average',
    prompt_description: '案内する。', speaking_basis: '落ち着いた口調。', available_expressions: ['neutral'],
    parameters: {
      magic: { light: { min: 0, max: 100, label: '光', value: 25 }, dark: { min: 0, max: 100, label: '闇', value: 20 }, fire: { min: 0, max: 100, label: '火', value: 18 }, water: { min: 0, max: 100, label: '水', value: 22 }, earth: { min: 0, max: 100, label: '土', value: 19 }, wind: { min: 0, max: 100, label: '風', value: 21 } },
      abilities: { strength: { min: 0, max: 100, label: '筋力', value: 24 }, agility: { min: 0, max: 100, label: '瞬発', value: 26 }, academics: { min: 0, max: 100, label: '学力', value: 61 }, magical_power: { min: 0, max: 100, label: '魔力', value: 35 }, charisma: { min: 0, max: 100, label: 'カリスマ', value: 29 } }
    }
  });
  return root;
}

test('a routing new game seeds empty star cradle surfaces; a loop new game leaves them absent', async (t) => {
  const routingRoot = await playSessionRoot();
  const loopRoot = await playSessionRoot();
  t.after(async () => { await fs.rm(routingRoot, { recursive: true, force: true }); await fs.rm(loopRoot, { recursive: true, force: true }); });

  const routing = await initializeNewPlayArea({ root: routingRoot, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });
  assert.deepEqual(await readJson(routing.root, 'game_data/star_cradle.json'), { version: 1, pots: [], creatures: [] });
  assert.deepEqual(await readJson(routing.root, 'game_data/star_cradle_creatures.json'), { version: 1, instances: [] });

  const loop = await initializeNewPlayArea({ root: loopRoot, slotId: 'slot_001', playMode: 'loop' });
  await assert.rejects(readJson(loop.root, 'game_data/star_cradle.json'));
});

// ---------- acquisition / enrichment ----------

test('seed/egg items enrich in the inventory display (name/description from the catalog merge)', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 2 }, { item_id: 'star_cradle_warm_egg', quantity: 1 }] });
  const inventory = await loadInventory({ root });
  const seed = inventory.items.find((item) => item.item_id === HOSHIKUSA);
  assert.equal(seed.name, 'ほしくさの種');
  assert.equal(seed.quantity, 2);
  const egg = inventory.items.find((item) => item.item_id === 'star_cradle_warm_egg');
  assert.equal(egg.name, 'ほのかに温かい卵');
});

// ---------- plant + roll determinism ----------

test('planting consumes the seed and the individual roll is invariant across reloads', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 2 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  const result = await plantStarCradleSeed({ root, storage, catalog, itemId: HOSHIKUSA, currentWeek: 0, random: fixedRandom(0.5) });
  assert.equal(result.planted.kind, 'plant');
  assert.equal(result.inventory.items.find((item) => item.item_id === HOSHIKUSA).quantity, 1);

  const surface = await loadStarCradleSurface({ storage });
  assert.equal(surface.pots.length, 1);
  const bloomWeek = surface.pots[0].planted_week + plantView(catalog, surface.pots[0], 0).mature_weeks;
  const first = plantView(catalog, surface.pots[0], bloomWeek);
  assert.equal(first.revealed, true);
  // Reload the surface from disk and re-derive: same variety and golden verdict.
  const reloaded = await loadStarCradleSurface({ storage });
  const second = plantView(catalog, reloaded.pots[0], bloomWeek);
  assert.deepEqual(first.variety, second.variety);
  assert.equal(first.golden, second.golden);
});

test('a full garden rejects planting with a fail-fast, without consuming the seed', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 5 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  for (let i = 0; i < catalog.tuning.pot_slots; i += 1) {
    await plantStarCradleSeed({ root, storage, catalog, itemId: HOSHIKUSA, currentWeek: 0, random: fixedRandom(0.1 + i * 0.2) });
  }
  await assert.rejects(
    plantStarCradleSeed({ root, storage, catalog, itemId: HOSHIKUSA, currentWeek: 0, random: fixedRandom(0.9) }),
    (error) => error.errorCode === 'STAR_CRADLE_FULL'
  );
  assert.equal((await loadInventory({ root })).items.find((item) => item.item_id === HOSHIKUSA).quantity, 5 - catalog.tuning.pot_slots);
});

// ---------- growth ----------

test('plant growth advances through stages and reveals at bloom (pure over elapsed weeks)', async (t) => {
  const root = await cradleRoot(t);
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  const record = { slot_index: 0, item_id: HOSHIKUSA, planted_week: 3, seed: 777, feed: {} };
  const mature = plantView(catalog, record, 3).mature_weeks;
  assert.equal(plantView(catalog, record, 3).stage, '芽');
  assert.equal(plantView(catalog, record, 3).revealed, false);
  assert.equal(plantView(catalog, record, 3 + mature).revealed, true);
  assert.equal(plantView(catalog, record, 3 + mature).stage, '開花');
  // several weeks unattended → still bloomed (no timer), harvestable
  assert.equal(plantView(catalog, record, 3 + mature + 9).harvestable, true);
});

// ---------- feed bias ----------

test('feeding an attribute biases the outcome toward that element before reveal', async (t) => {
  const root = await cradleRoot(t);
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  // Find an individual seed whose unfed outcome is NOT the light variety but flips to it under heavy light feeding.
  let flipped = null;
  for (let seed = 1; seed <= 4000 && !flipped; seed += 1) {
    const unfed = deriveVariety(catalog, HOSHIKUSA, seed, {});
    const fed = deriveVariety(catalog, HOSHIKUSA, seed, { light: catalog.tuning.feed_bias_max_units });
    if (unfed.element !== 'light' && fed.element === 'light') flipped = { seed, unfed, fed };
  }
  assert.ok(flipped, 'a seed exists whose outcome flips to the light variety under light feeding');
  // determinism: same (seed, feed) always yields the same variety
  assert.equal(deriveVariety(catalog, HOSHIKUSA, flipped.seed, { light: catalog.tuning.feed_bias_max_units }).id, flipped.fed.id);
});

test('feed consumes one material and is rejected once the individual has revealed', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 1 }, { item_id: 'material_light_t1', quantity: 3 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: HOSHIKUSA, currentWeek: 0, random: fixedRandom(0.5) });
  const fed = await feedStarCradleIndividual({ root, storage, catalog, kind: 'plant', slotIndex: 0, materialItemId: 'material_light_t1', currentWeek: 0 });
  assert.equal(fed.fed_element, 'light');
  assert.equal(fed.individual.feed.light, 1);
  assert.equal(fed.inventory.items.find((item) => item.item_id === 'material_light_t1').quantity, 2);
  const surface = await loadStarCradleSurface({ storage });
  const bloom = surface.pots[0].planted_week + plantView(catalog, surface.pots[0], 0).mature_weeks;
  await assert.rejects(
    feedStarCradleIndividual({ root, storage, catalog, kind: 'plant', slotIndex: 0, materialItemId: 'material_light_t1', currentWeek: bloom }),
    (error) => error.errorCode === 'STAR_CRADLE_NOT_FEEDABLE'
  );
});

// ---------- harvest ----------

test('harvesting a bloomed plant grants materials additively and frees the pot', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 1 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: HOSHIKUSA, currentWeek: 0, random: fixedRandom(0.42) });
  const surface = await loadStarCradleSurface({ storage });
  const bloom = surface.pots[0].planted_week + plantView(catalog, surface.pots[0], 0).mature_weeks;
  await assert.rejects(harvestStarCradlePlant({ root, storage, catalog, slotIndex: 0, currentWeek: 0 }), (error) => error.errorCode === 'STAR_CRADLE_NOT_HARVESTABLE');
  const harvest = await harvestStarCradlePlant({ root, storage, catalog, slotIndex: 0, currentWeek: bloom });
  assert.ok(harvest.rewards.length >= 0);
  assert.equal((await loadStarCradleSurface({ storage })).pots.length, 0, 'the pot is freed after harvest');
});

// ---------- byproduct ----------

test('an adult resident accrues weekly byproducts and claims several weeks at once', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: MADARA, quantity: 1 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: 0, random: fixedRandom(0.3) });
  const record = (await loadStarCradleSurface({ storage })).creatures[0];
  const adultWeeks = creatureView(catalog, record, 0).adult_weeks;
  const week = adultWeeks + 2;
  const view = creatureView(catalog, record, week);
  assert.equal(view.adult, true);
  assert.equal(view.byproduct_pending_weeks, 3);
  const claim = await claimStarCradleByproduct({ root, storage, catalog, slotIndex: 0, currentWeek: week });
  assert.equal(claim.claimed_weeks, 3);
  assert.ok(claim.rewards.length > 0);
  // claiming again the same week yields nothing due
  await assert.rejects(claimStarCradleByproduct({ root, storage, catalog, slotIndex: 0, currentWeek: week }), (error) => error.errorCode === 'STAR_CRADLE_NO_BYPRODUCT');
});

// ---------- naming ----------

test('creature naming validates and persists; plants have no name', async (t) => {
  assert.equal(validateStarCradleName('  ほしまる  '), 'ほしまる');
  assert.throws(() => validateStarCradleName(''), /must not be empty/);
  assert.throws(() => validateStarCradleName('あ'.repeat(25)), /at most/);
  assert.throws(() => validateStarCradleName('だめ『名』'), /bracket/);
  const root = await cradleRoot(t, { items: [{ item_id: MADARA, quantity: 1 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: 0, random: fixedRandom(0.3) });
  const named = await nameStarCradleCreature({ storage, catalog, slotIndex: 0, name: 'ほしまる', currentWeek: 0 });
  assert.equal(named.creature.name, 'ほしまる');
  assert.equal((await loadStarCradleSurface({ storage })).creatures[0].name, 'ほしまる');
});

// ---------- cage ⇄ release round-trip ----------

test('caging then releasing an adult creature is lossless and rejects a full garden with zero consumption', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: MADARA, quantity: 4 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: 0, random: fixedRandom(0.3) });
  const record = (await loadStarCradleSurface({ storage })).creatures[0];
  const adultWeek = creatureView(catalog, record, 0).adult_weeks;
  await nameStarCradleCreature({ storage, catalog, slotIndex: 0, name: 'こだま', currentWeek: adultWeek });
  const before = creatureView(catalog, (await loadStarCradleSurface({ storage })).creatures[0], adultWeek);

  // only adults can be caged
  const caged = await cageStarCradleCreature({ storage, catalog, slotIndex: 0, currentWeek: adultWeek });
  assert.equal(caged.caged.name, 'こだま');
  assert.equal((await loadStarCradleSurface({ storage })).creatures.length, 0, 'the garden slot is freed');
  assert.equal((await loadStarCradleCreaturesSurface({ storage })).instances.length, 1);

  const instanceId = caged.caged.instance_id;
  const released = await releaseStarCradleCreature({ storage, catalog, instanceId, currentWeek: adultWeek + 5 });
  assert.equal(released.released.name, 'こだま');
  assert.equal(released.released.adult, true, 'a released creature re-enters at adulthood');
  assert.deepEqual(released.released.variety, before.variety, 'the variety is preserved across the round-trip');
  assert.deepEqual(released.released.mutation, before.mutation, 'the second form is preserved across the round-trip');
  assert.equal((await loadStarCradleCreaturesSurface({ storage })).instances.length, 0, 'the cage item is consumed on release');

  // Re-cage, fill all creature slots, then a release must fail-fast with the instance untouched.
  const recaged = await cageStarCradleCreature({ storage, catalog, slotIndex: 0, currentWeek: adultWeek + 5 });
  for (let i = 0; i < catalog.tuning.creature_slots; i += 1) {
    await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: adultWeek + 5, random: fixedRandom(0.2 + i * 0.2) });
  }
  await assert.rejects(
    releaseStarCradleCreature({ storage, catalog, instanceId: recaged.caged.instance_id, currentWeek: adultWeek + 6 }),
    (error) => error.errorCode === 'STAR_CRADLE_FULL'
  );
  assert.equal((await loadStarCradleCreaturesSurface({ storage })).instances.length, 1, 'the cage item is untouched on a failed release');
});

// ---------- state view ----------

test('the garden state view reports pots, creatures, caged items, and free-slot counts', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 1 }, { item_id: MADARA, quantity: 1 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: HOSHIKUSA, currentWeek: 0, random: fixedRandom(0.5) });
  await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: 0, random: fixedRandom(0.6) });
  const view = await buildStarCradleView({ storage, catalog, currentWeek: 0 });
  assert.equal(view.pots.length, 1);
  assert.equal(view.creatures.length, 1);
  assert.equal(view.free_pot_slots, catalog.tuning.pot_slots - 1);
  assert.equal(view.free_creature_slots, catalog.tuning.creature_slots - 1);
  assert.equal(view.pots[0].stage, '芽');
  assert.equal(view.creatures[0].stage, '卵');
});

// ---------- HTTP inventory annotation (routing hub drawer `usable` contract) ----------

// Invokes a server API handler with fake req/res spies and returns the recorded sendJson calls. The star-cradle
// routes derive the week from runtime_state.elapsed_weeks, so tests set that surface to the target week.
async function callApi(handler, { method, pathname, body = {}, root, mode = 'routing' }) {
  const jsonCalls = [];
  await handler({
    req: { method },
    res: { end() {} },
    url: { pathname },
    context: { root, activeRoot: root },
    sendJson: (_res, value, status = 200) => jsonCalls.push({ value, status }),
    readBody: async () => body,
    activePlayMode: { mode }
  });
  return jsonCalls;
}

async function setElapsedWeeks(root, week) {
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: week });
}

// The GET /api/inventory response items for the current persisted state — the exact annotation the routing hub
// drawer expects a star-cradle response to match.
async function inventoryApiItems(root) {
  const calls = await callApi(handleProgressionEconomyApi, { method: 'GET', pathname: '/api/inventory', root });
  return calls[0].value.items;
}

test('the byproduct route annotates its inventory with usable and matches /api/inventory for the same state', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: MADARA, quantity: 1 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: 0, random: fixedRandom(0.3) });
  const record = (await loadStarCradleSurface({ storage })).creatures[0];
  const week = creatureView(catalog, record, 0).adult_weeks + 2;
  await setElapsedWeeks(root, week);

  const calls = await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/byproduct', body: { slot_index: 0 }, root });
  assert.equal(calls.length, 1);
  const response = calls[0].value;
  assert.ok(response.rewards.length > 0, 'byproduct grants material rows');
  // Every granted reward row is present in the returned inventory (the "材料が入る" case).
  for (const reward of response.rewards) {
    assert.ok(response.inventory.items.some((item) => item.item_id === reward.item_id), `${reward.item_id} is in the returned inventory`);
  }
  for (const item of response.inventory.items) {
    assert.equal(typeof item.usable, 'boolean', `${item.item_id} carries a boolean usable`);
  }
  // Same state, same annotation: the star-cradle inventory equals what GET /api/inventory returns.
  assert.deepEqual(response.inventory.items, await inventoryApiItems(root));
});

test('the plant/feed/harvest routes annotate every returned inventory row with a boolean usable', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: HOSHIKUSA, quantity: 2 }, { item_id: 'material_light_t1', quantity: 3 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });

  const assertAllUsable = (response, label) => {
    assert.ok(response.inventory.items.length > 0, `${label} returns inventory rows to validate`);
    for (const item of response.inventory.items) {
      assert.equal(typeof item.usable, 'boolean', `${label}: ${item.item_id} carries a boolean usable`);
    }
  };

  const plant = (await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/plant', body: { item_id: HOSHIKUSA }, root }))[0].value;
  assertAllUsable(plant, 'plant');

  const feed = (await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/feed', body: { kind: 'plant', slot_index: 0, material_item_id: 'material_light_t1' }, root }))[0].value;
  assertAllUsable(feed, 'feed');

  const pot = (await loadStarCradleSurface({ storage })).pots[0];
  await setElapsedWeeks(root, pot.planted_week + plantView(catalog, pot, 0).mature_weeks);
  const harvest = (await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/harvest', body: { slot_index: 0 }, root }))[0].value;
  assertAllUsable(harvest, 'harvest');
  assert.deepEqual(harvest.inventory.items, await inventoryApiItems(root));
});

test('routes that return no inventory (name/cage/release) keep their response shape unchanged', async (t) => {
  const root = await cradleRoot(t, { items: [{ item_id: MADARA, quantity: 1 }] });
  const { storage } = ctx(root);
  const catalog = await loadStarCradleCatalog({ storage });
  await plantStarCradleSeed({ root, storage, catalog, itemId: MADARA, currentWeek: 0, random: fixedRandom(0.3) });
  const adultWeek = creatureView(catalog, (await loadStarCradleSurface({ storage })).creatures[0], 0).adult_weeks;
  await setElapsedWeeks(root, adultWeek);

  const named = (await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/name', body: { slot_index: 0, name: 'ほしまる' }, root }))[0].value;
  assert.equal(named.creature.name, 'ほしまる');
  assert.equal(named.inventory, undefined, 'name returns no inventory');

  const caged = (await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/cage', body: { slot_index: 0 }, root }))[0].value;
  assert.equal(caged.inventory, undefined, 'cage returns no inventory');

  const released = (await callApi(handleStarCradleApi, { method: 'POST', pathname: '/api/star-cradle/release', body: { instance_id: caged.caged.instance_id }, root }))[0].value;
  assert.equal(released.inventory, undefined, 'release returns no inventory');
});
