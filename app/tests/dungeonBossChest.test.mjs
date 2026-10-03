// 残す (a): ダンジョンの run 終了で装備を確定する処理が、既に所持している装備を上書き・削減する壊れ方から、プレイヤーの装備を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { enterDungeon, dungeonAction } from '../src/dungeon/dungeonEngine.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { rollBossTreasureEquipment } from '../src/dungeon/dungeonEquipmentDrops.mjs';
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

async function chestRoot({ inventory = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-chest-'));
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
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  if (inventory) await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory);
  return root;
}

async function mutateRun(root, mutate) {
  const state = await readJson(root, RUNTIME_STATE_PATH);
  mutate(state.dungeon_run, state);
  await writeJson(root, RUNTIME_STATE_PATH, state);
}

test('a kept run (retreat) confirms opened equipment into player_equipment; owned instances are never reduced', async (t) => {
  const preOwned = rollBossTreasureEquipment({ seed: 777, floor: 5 });
  const root = await chestRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, 'data/mutable/game_data/player_equipment.json', { version: 1, instances: [preOwned] });

  const chestInstance = rollBossTreasureEquipment({ seed: 4242, floor: 10 });
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.equipment_buffer = [chestInstance]; });

  // The player starts on the entrance, so retreat is a valid solo (synchronous) commit.
  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'retreat' } });
  assert.equal(result.status, 'retreated');
  assert.equal(result.equipment.retained, true);
  assert.deepEqual(result.equipment.items, [chestInstance]);

  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 2, 'the opened chest equipment is appended, the pre-owned instance is kept');
  assert.ok(surface.instances.some((i) => i.instance_id === chestInstance.instance_id));
  assert.ok(surface.instances.some((i) => i.instance_id === preOwned.instance_id));
});

test('a wiped run (dead) discards the equipment buffer and never touches owned equipment', async (t) => {
  const preOwned = rollBossTreasureEquipment({ seed: 777, floor: 5 });
  const root = await chestRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, 'data/mutable/game_data/player_equipment.json', { version: 1, instances: [preOwned] });

  const chestInstance = rollBossTreasureEquipment({ seed: 4242, floor: 10 });
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    run.equipment_buffer = [chestInstance];
    run.player.hp = 0; // the next resolved action ends the run as dead deterministically
  });

  const result = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'wait' } });
  assert.equal(result.status, 'dead');
  assert.equal(result.equipment.retained, false);
  assert.deepEqual(result.equipment.items, [chestInstance], 'the result still lists what was lost');

  const surface = await loadEquipmentSurface({ root });
  assert.deepEqual(surface.instances, [preOwned], 'the wiped buffer is discarded and owned equipment is untouched');
});
