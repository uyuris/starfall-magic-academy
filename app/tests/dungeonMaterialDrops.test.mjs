import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { enterDungeon, dungeonAction, dungeonFinalizeRun, getDungeonView, MAX_FLOORS } from '../src/dungeon/dungeonEngine.mjs';
import { loadInventory } from '../src/economy.mjs';
import { TILE_FLOOR } from '../src/dungeon/dungeonGeneration.mjs';
import { bossArchetypes } from '../src/dungeon/dungeonEnemies.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

const POST_SCREEN = 'academy-room';
const RUNTIME_STATE_PATH = 'data/mutable/game_data/runtime_state.json';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

function baselineParameters() {
  return {
    magic: { light: { value: 20 }, dark: { value: 20 }, fire: { value: 20 }, water: { value: 20 }, earth: { value: 20 }, wind: { value: 20 } },
    abilities: { strength: { value: 25 }, agility: { value: 25 }, academics: { value: 25 }, magical_power: { value: 25 }, charisma: { value: 25 } }
  };
}

async function dropsRoot({ inventory = null, runtimeState = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-drops-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '学院購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', baselineParameters());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}, ...runtimeState
  });
  if (inventory) await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory);
  return root;
}

// Loads the persisted run, applies an in-place mutation, and writes it back — the
// deterministic way to drive a finalize with a known material buffer / outcome.
async function mutateRun(root, mutate) {
  const state = await readJson(root, RUNTIME_STATE_PATH);
  mutate(state.dungeon_run, state);
  await writeJson(root, RUNTIME_STATE_PATH, state);
}

test('a kept run (retreat) merges the material buffer into player_inventory with catalog enrichment', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.material_buffer = { material_fire_t1: 2, material_wind_t3: 1 }; });

  // The player starts on the entrance, so retreat is a valid solo (synchronous) commit.
  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'retreat' } });
  assert.equal(result.status, 'retreated');
  assert.equal(result.materials.retained, true);
  assert.deepEqual(result.materials.items, [
    { item_id: 'material_fire_t1', display_name: '熾火の欠片', quantity: 2 },
    { item_id: 'material_wind_t3', display_name: '烈風の翠角', quantity: 1 }
  ]);

  const inventory = await loadInventory({ root });
  const fire = inventory.items.find((item) => item.item_id === 'material_fire_t1');
  const wind = inventory.items.find((item) => item.item_id === 'material_wind_t3');
  assert.equal(fire.quantity, 2);
  assert.equal(wind.quantity, 1);
  assert.equal(fire.name, '熾火の欠片');
  assert.equal(fire.description.length > 0, true);
  assert.equal(fire.sell_price, 10);
  assert.equal(fire.icon, '/canonical/dungeon/material-icons/material_fire_t1.png');
  // Dungeon material items carry element/tier meta from the catalog (id-derived).
  assert.equal(fire.element, 'fire');
  assert.equal(fire.tier, 1);
  assert.equal(wind.element, 'wind');
  assert.equal(wind.tier, 3);
});

test('a cleared run (descend at the last floor) merges the material buffer into player_inventory', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    // Stand on the last floor's down-stair so a descend clears the run.
    run.floor = MAX_FLOORS;
    run.player.x = run.stairs.x;
    run.player.y = run.stairs.y;
    run.material_buffer = { material_dark_t4: 1 };
  });

  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'descend' } });
  assert.equal(result.status, 'cleared');
  assert.deepEqual(result.materials, { items: [{ item_id: 'material_dark_t4', display_name: '深淵の王珠', quantity: 1 }], retained: true });

  const inventory = await loadInventory({ root });
  const dark = inventory.items.find((item) => item.item_id === 'material_dark_t4');
  assert.equal(dark.quantity, 1);
  assert.equal(dark.name, '深淵の王珠');
});

test('a companion run defers its merge to the finalize phase, then deposits on commit', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    // A companion (with a conversation id) routes the run end through the deferred
    // two-phase finalize (beginRunEnd -> later dungeonFinalizeRun -> commitRunEnd).
    run.companion = { character_id: 'char_x', name: '相棒', conversation_id: 'conv_x', down: false };
    run.material_buffer = { material_light_t2: 2 };
  });

  // Phase 1: retreat previews the carried materials but does NOT deposit yet.
  const begun = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'retreat' } });
  assert.equal(begun.pending_finalize, true);
  assert.deepEqual(begun.materials, { items: [{ item_id: 'material_light_t2', display_name: '暁光の露珠', quantity: 2 }], retained: true });
  const beforeFinalize = await loadInventory({ root });
  assert.equal(beforeFinalize.items.some((item) => item.item_id === 'material_light_t2'), false, 'begin does not deposit');

  // Phase 2: the deferred finalize commits the merge (no companion LLM needed).
  const committed = await dungeonFinalizeRun({ root, postDungeonScreen: POST_SCREEN });
  assert.equal(committed.status, 'retreated');
  assert.deepEqual(committed.materials, { items: [{ item_id: 'material_light_t2', display_name: '暁光の露珠', quantity: 2 }], retained: true });

  const inventory = await loadInventory({ root });
  const light = inventory.items.find((item) => item.item_id === 'material_light_t2');
  assert.equal(light.quantity, 2);
  assert.equal(light.name, '暁光の露珠');
});

test('a wiped run (dead) discards its material buffer and never reduces owned items', async (t) => {
  const root = await dropsRoot({ inventory: { money: 80, items: [{ item_id: 'material_fire_t1', quantity: 5 }] } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    run.material_buffer = { material_water_t2: 3 };
    // Player HP already 0: the next resolved action ends the run as dead deterministically.
    run.player.hp = 0;
  });

  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'wait' } });
  assert.equal(result.status, 'dead');
  assert.equal(result.materials.retained, false);
  assert.deepEqual(result.materials.items, [{ item_id: 'material_water_t2', display_name: '清冽の氷華', quantity: 3 }]);

  const inventory = await loadInventory({ root });
  const fire = inventory.items.find((item) => item.item_id === 'material_fire_t1');
  assert.equal(fire.quantity, 5, 'previously-owned materials are never reduced on death');
  assert.equal(inventory.items.some((item) => item.item_id === 'material_water_t2'), false, 'the wiped buffer is discarded');
  assert.equal(inventory.money, 80);
});

test('a run saved before the material buffer reads as empty and finalizes cleanly', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { delete run.material_buffer; });

  const view = await getDungeonView({ root });
  assert.deepEqual(view.material_buffer, []);

  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'retreat' } });
  assert.equal(result.status, 'retreated');
  assert.deepEqual(result.materials, { items: [], retained: true });
});

test('a corrupt material buffer fails fast on read', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.material_buffer = 'broken'; });

  await assert.rejects(() => getDungeonView({ root }), /material buffer must be an object/);
});

test('the run view enriches each buffer material with its catalog display name, item_id-sorted', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  // Insertion order is deliberately not item_id order, to prove the view sorts.
  await mutateRun(root, (run) => { run.material_buffer = { material_wind_t3: 1, material_fire_t1: 2 }; });

  const view = await getDungeonView({ root });
  assert.deepEqual(view.material_buffer, [
    { item_id: 'material_fire_t1', display_name: '熾火の欠片', quantity: 2 },
    { item_id: 'material_wind_t3', display_name: '烈風の翠角', quantity: 1 }
  ]);
});

test('a buffer id absent from the material catalog fails fast in the view (no unnamed row)', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.material_buffer = { material_fire_t1: 1, material_ghost_t1: 1 }; });

  await assert.rejects(() => getDungeonView({ root }), /dungeon material id is not in the catalog: material_ghost_t1/);
});

test('routing mode records carried materials additively on the dungeon content result', async (t) => {
  const root = await dropsRoot({ runtimeState: { elapsed_weeks: 3 } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.material_buffer = { material_earth_t2: 4 }; });

  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, routing: true, action: { type: 'retreat' } });
  assert.equal(result.status, 'retreated');

  const state = await readJson(root, RUNTIME_STATE_PATH);
  const record = state.last_routing_content_result;
  assert.equal(record.kind, 'dungeon');
  assert.equal(record.week, 3);
  assert.deepEqual(record.detail.materials, { items: [{ item_id: 'material_earth_t2', display_name: '鉱脈の磁鉄', quantity: 4 }], retained: true });
});

test('defeating a boss accrues its guaranteed T4 material into the run buffer view', async (t) => {
  const root = await dropsRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const boss = bossArchetypes[0];
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    // A single real-archetype boss on an adjacent floor tile: a spell then
    // deterministically kills it (spell damage is never gated by a hit roll), so the
    // guaranteed T4 drop lands.
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => ({ x: run.player.x + dx, y: run.player.y + dy }))
      .find((cell) => run.tiles[cell.y]?.[cell.x] === TILE_FLOOR
        && !(cell.x === run.stairs.x && cell.y === run.stairs.y));
    if (!spot) throw new Error('no adjacent floor tile for the test boss');
    run.enemies = [{
      uid: 'boss1', archetype_id: boss.id, name: boss.name, element: boss.element, glyph: boss.glyph,
      x: spot.x, y: spot.y, hp: 1, max_hp: 1, attack: 6, defense: 0, speed: 8, boss: true
    }];
    run.material_buffer = {};
    run.player.mp = 999;
    run.player.max_mp = 999;
  });

  const view = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'cast', element: 'fire' } });
  assert.equal(view.active, true);
  // The live view attaches each buffer material's server-authoritative display name (same enrichment
  // as the run-end result), so the in-run 持ち帰り screen can show 表示名 without a client-side lookup.
  assert.deepEqual(view.material_buffer, [{ item_id: `material_${boss.element}_t4`, display_name: '天光の宝冠', quantity: 1 }]);
});
