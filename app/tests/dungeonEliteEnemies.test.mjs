import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  ELITE_ENEMY_SPAWN_RATE,
  MILESTONE_FLOORS,
  TILE_FLOOR,
  generateFloor
} from '../src/dungeon/dungeonGeneration.mjs';
import { enemyArchetype, enemyCombatMaxHp, enemyCountForFloor, scaledEnemyStats } from '../src/dungeon/dungeonEnemies.mjs';
import { rollEnemyMaterialDrop, tierForFloor } from '../src/dungeon/dungeonMaterials.mjs';
import { materialItemId } from '../src/dungeonMaterialCatalog.mjs';
import { enterDungeon, dungeonAction } from '../src/dungeon/dungeonEngine.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

const NON_MILESTONE_FLOOR = 2;

function elitesOf(floor) {
  return floor.enemies.filter((enemy) => enemy.elite === true);
}

// The first seed in [start, start+span) whose floor F promotes an elite, and the first that does not.
function findSeeds(floorNumber, { start = 1, span = 400 } = {}) {
  let firing = null;
  let quiet = null;
  for (let seed = start; seed < start + span && (firing === null || quiet === null); seed += 1) {
    const floor = generateFloor({ seed, floor: floorNumber });
    if (elitesOf(floor).length > 0) firing ??= seed;
    else quiet ??= seed;
  }
  if (firing === null || quiet === null) throw new Error('could not find both a firing and a quiet seed');
  return { firing, quiet };
}

test('the elite spawn rate is a tunable in the intended 0.15–0.25 expected-per-floor band', () => {
  assert.ok(ELITE_ENEMY_SPAWN_RATE >= 0.15 && ELITE_ENEMY_SPAWN_RATE <= 0.25, `rate ${ELITE_ENEMY_SPAWN_RATE} is in band`);
});

test('elite promotion is (seed, floor) deterministic, in-place (count unchanged), and at most one per floor', () => {
  const { firing } = findSeeds(NON_MILESTONE_FLOOR);
  const a = generateFloor({ seed: firing, floor: NON_MILESTONE_FLOOR });
  const b = generateFloor({ seed: firing, floor: NON_MILESTONE_FLOOR });
  assert.deepEqual(a, b, 'same (seed, floor) reproduces the exact floor');
  assert.equal(a.enemies.length, enemyCountForFloor(NON_MILESTONE_FLOOR), 'enemy count is unchanged (in-place promotion)');
  const elites = elitesOf(a);
  assert.equal(elites.length, 1, 'exactly one elite when the roll fires');
  const elite = elites[0];
  assert.ok(elite.name.startsWith('輝く'), 'the elite carries the name prefix');

  // The buff is a modulation of the SAME archetype's scaled stats (no new archetype): hp/attack are scaled up,
  // and everything else (position / archetype / element / defense / speed / uid) is untouched.
  const archetype = enemyArchetype(elite.archetype_id);
  const stats = scaledEnemyStats(archetype, NON_MILESTONE_FLOOR);
  assert.equal(elite.max_hp, Math.round(enemyCombatMaxHp(stats.max_hp) * 1.8), 'elite HP is the enemy pool ×1.8');
  assert.equal(elite.hp, elite.max_hp, 'elite spawns at full (buffed) HP');
  assert.equal(elite.attack, Math.round(stats.attack * 1.5), 'elite attack is the scaled base ×1.5');
  assert.ok(elite.max_hp > enemyCombatMaxHp(stats.max_hp) && elite.attack > stats.attack, 'clearly stronger than a normal enemy');
});

test('a floor whose elite roll does not fire is unmodulated (no elite flag, base scaled stats)', () => {
  const { quiet } = findSeeds(NON_MILESTONE_FLOOR);
  const floor = generateFloor({ seed: quiet, floor: NON_MILESTONE_FLOOR });
  assert.equal(elitesOf(floor).length, 0, 'no elite when the roll does not fire');
  for (const enemy of floor.enemies) {
    assert.equal(enemy.elite, undefined, 'a normal enemy carries no elite flag');
    const stats = scaledEnemyStats(enemyArchetype(enemy.archetype_id), NON_MILESTONE_FLOOR);
    assert.equal(enemy.max_hp, enemyCombatMaxHp(stats.max_hp), 'unmodulated HP');
    assert.equal(enemy.attack, stats.attack, 'unmodulated attack');
    assert.ok(!enemy.name.startsWith('輝く'), 'no elite prefix');
  }
});

test('milestone floors never promote an elite (the boss is the floor\'s special instead)', () => {
  for (const floor of MILESTONE_FLOORS) {
    for (let seed = 1; seed <= 300; seed += 1) {
      assert.equal(elitesOf(generateFloor({ seed, floor })).length, 0, `floor ${floor} seed ${seed} has no elite`);
    }
  }
});

test('an elite guarantees the floor band\'s next tier up (T4 cap), flag-driven and deterministic', () => {
  const eliteEnemy = (floor) => ({ uid: 'e1', element: 'fire', elite: true });
  for (const [floor, expectedTier] of [[1, 2], [4, 3], [7, 4], [10, 4]]) {
    const dropped = rollEnemyMaterialDrop({ seed: 4242, floor, enemy: eliteEnemy(floor) });
    assert.equal(dropped, materialItemId('fire', Math.min(tierForFloor(floor) + 1, 4)));
    assert.equal(dropped, materialItemId('fire', expectedTier), `floor ${floor} elite drops T${expectedTier}`);
    // Flag-driven & guaranteed: it never depends on the drop rng, so it reproduces across seeds.
    assert.equal(rollEnemyMaterialDrop({ seed: 9, floor, enemy: eliteEnemy(floor) }), dropped, 'seed-independent (guaranteed)');
  }
});

test('the elite stream does not perturb the material-drop stream: a normal enemy on an elite floor drops as before', () => {
  // The normal drop for a given (seed, floor, uid) is unchanged whether or not the floor promoted an elite —
  // the two use different seed namespaces (900000 vs 700000).
  const normal = { uid: 'e3', element: 'water' };
  const a = rollEnemyMaterialDrop({ seed: 4242, floor: NON_MILESTONE_FLOOR, enemy: normal });
  const b = rollEnemyMaterialDrop({ seed: 4242, floor: NON_MILESTONE_FLOOR, enemy: normal });
  assert.equal(a, b, 'the normal drop is deterministic and independent of the elite roll');
});

// ----- integration: defeating an elite in a real run -----

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
async function eliteRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-elite-'));
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
  return root;
}

test('defeating an elite in a run surfaces elite:true + prefixed name in the view and banks the guaranteed tier+1 material', async (t) => {
  const root = await eliteRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.floor = 3; // a non-milestone floor → tierForFloor(3)=1, so an elite guarantees T2
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: run.player.x + dx, y: run.player.y + dy }))
    .find((cell) => run.tiles[cell.y]?.[cell.x] === TILE_FLOOR && !(cell.x === run.stairs.x && cell.y === run.stairs.y));
  if (!spot) throw new Error('no adjacent floor tile for the test elite');
  run.enemies = [{
    uid: 'el1', archetype_id: 'ember_imp', name: '輝く火精', element: 'fire', glyph: 'w',
    x: spot.x, y: spot.y, hp: 1, max_hp: 1, attack: 6, defense: 0, speed: 8, elite: true
  }];
  run.player.mp = 999;
  run.player.max_mp = 999;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'fire' } });
  assert.equal(view.active, true);
  // The guaranteed one-tier-up material (fire T2 for a 3F/T1-band elite) is in the buffer.
  assert.deepEqual(view.material_buffer, [{ item_id: 'material_fire_t2', display_name: '焔の凝塊', quantity: 1 }]);
});

test('a live elite (before defeat) exposes elite:true and the prefixed name in the view enemy entry', async (t) => {
  const root = await eliteRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.floor = 3;
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: run.player.x + dx, y: run.player.y + dy }))
    .find((cell) => run.tiles[cell.y]?.[cell.x] === TILE_FLOOR && !(cell.x === run.stairs.x && cell.y === run.stairs.y));
  run.enemies = [{
    uid: 'el1', archetype_id: 'ember_imp', name: '輝く火精', element: 'fire', glyph: 'w',
    x: spot.x, y: spot.y, hp: 50, max_hp: 50, attack: 6, defense: 0, speed: 8, elite: true
  }];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const seen = view.enemies.find((enemy) => enemy.uid === 'el1');
  assert.ok(seen, 'the elite is visible in the view');
  assert.equal(seen.elite, true, 'the view enemy entry carries elite:true');
  assert.equal(seen.name, '輝く火精', 'the prefixed name is surfaced');
});
