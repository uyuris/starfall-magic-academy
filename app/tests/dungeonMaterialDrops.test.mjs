// 残す (a): ダンジョンの run 終了で素材を持ち帰る処理が、既に所持している品を上書き・削減する壊れ方から、プレイヤーの所持品を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { enterDungeon, dungeonAction } from '../src/dungeon/dungeonEngine.mjs';
import { loadInventory } from '../src/economy.mjs';
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
