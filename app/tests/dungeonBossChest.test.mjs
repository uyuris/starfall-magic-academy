import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { enterDungeon, dungeonAction, dungeonFinalizeRun } from '../src/dungeon/dungeonEngine.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { rollBossTreasureEquipment } from '../src/dungeon/dungeonEquipmentDrops.mjs';
import { TILE_FLOOR } from '../src/dungeon/dungeonGeneration.mjs';
import { bossArchetypes, enemyArchetypes } from '../src/dungeon/dungeonEnemies.mjs';
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

// The first adjacent floor tile that is not the down-stair — a valid spot to place a test enemy.
function adjacentSpot(run) {
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ dx, dy, x: run.player.x + dx, y: run.player.y + dy }))
    .find((cell) => run.tiles[cell.y]?.[cell.x] === TILE_FLOOR && !(cell.x === run.stairs.x && cell.y === run.stairs.y));
  if (!spot) throw new Error('no adjacent floor tile for the test enemy');
  return spot;
}

function directionOf(dx, dy) {
  if (dx === 1) return 'right';
  if (dx === -1) return 'left';
  if (dy === 1) return 'down';
  return 'up';
}

test('a milestone boss defeat drops a chest on its tile; walking onto it then use_item opens the (seed,floor) equipment', async (t) => {
  const root = await chestRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const boss = bossArchetypes[0];
  await enterDungeon({ root, seed: 4242 });
  let spot;
  await mutateRun(root, (run) => {
    run.floor = 5; // a milestone floor: the chest carries this floor and opens its band
    spot = adjacentSpot(run);
    run.enemies = [{
      uid: 'boss1', archetype_id: boss.id, name: boss.name, element: boss.element, glyph: boss.glyph,
      x: spot.x, y: spot.y, hp: 1, max_hp: 1, attack: 6, defense: 0, speed: 8, boss: true
    }];
    run.player.mp = 999;
    run.player.max_mp = 999;
  });

  // Kill the boss from range: the chest drops on its tile, appears as a floor item, and is NOT yet owned.
  const afterKill = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'cast', element: 'fire' } });
  assert.equal(afterKill.active, true);
  assert.equal(afterKill.items.some((item) => item.kind === 'treasure_chest'), true, 'a chest floor item appears on the boss tile');
  assert.deepEqual(afterKill.equipment_buffer, [], 'the chest is unopened, so the equipment buffer is still empty');

  // Walk onto the chest tile to pick it up (the existing floor-item pickup mechanism).
  const afterPickup = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'move', direction: directionOf(spot.dx, spot.dy) } });
  assert.equal(afterPickup.inventory.some((item) => item.kind === 'treasure_chest'), true, 'the chest is now carried');
  assert.deepEqual(afterPickup.equipment_buffer, [], 'carrying a chest does not open it');

  // Open it with use_item: the (seed, floor)-deterministic equipment lands in the run buffer.
  const afterOpen = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'use_item', item_kind: 'treasure_chest' } });
  const expected = rollBossTreasureEquipment({ seed: 4242, floor: 5 });
  assert.deepEqual(afterOpen.equipment_buffer, [expected], 'the opened chest yields the deterministic instance');
  assert.equal(afterOpen.inventory.some((item) => item.kind === 'treasure_chest'), false, 'the chest is consumed on open');
});

test('a normal (non-boss) enemy defeat drops no chest', async (t) => {
  const root = await chestRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const archetype = enemyArchetypes[0];
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    run.floor = 5;
    const spot = adjacentSpot(run);
    run.enemies = [{
      uid: 'e1', archetype_id: archetype.id, name: archetype.name, element: archetype.element, glyph: archetype.glyph,
      x: spot.x, y: spot.y, hp: 1, max_hp: 1, attack: 6, defense: 0, speed: 8
    }];
    run.player.mp = 999;
    run.player.max_mp = 999;
  });

  const view = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'cast', element: 'fire' } });
  assert.equal(view.items.some((item) => item.kind === 'treasure_chest'), false, 'only a boss drops a chest');
});

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

test('a companion run defers the equipment confirm to finalize, then appends on commit', async (t) => {
  const root = await chestRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const chestInstance = rollBossTreasureEquipment({ seed: 4242, floor: 5 });
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    run.companion = { character_id: 'char_x', name: '相棒', conversation_id: 'conv_x', down: false };
    run.equipment_buffer = [chestInstance];
  });

  const begun = await dungeonAction({ root, postDungeonScreen: POST_SCREEN, action: { type: 'retreat' } });
  assert.equal(begun.pending_finalize, true);
  assert.deepEqual(begun.equipment, { items: [chestInstance], retained: true });
  const before = await loadEquipmentSurface({ root });
  assert.equal(before.instances.length, 0, 'begin does not append yet');

  const committed = await dungeonFinalizeRun({ root, postDungeonScreen: POST_SCREEN });
  assert.equal(committed.status, 'retreated');
  assert.deepEqual(committed.equipment, { items: [chestInstance], retained: true });
  const after = await loadEquipmentSurface({ root });
  assert.deepEqual(after.instances, [chestInstance]);
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
