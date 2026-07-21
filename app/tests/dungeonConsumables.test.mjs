// Dungeon consumables engine: the `use_consumable` action that spends an owned alchemy
// `dungeon_consumable` mid-run. Covers all seven effect kinds (attack_single / attack_area /
// heal / heal_full / mp_restore / mp_restore_full / revive), the atomic one-item consume, the
// turn-non-consuming fail-fast on invalid uses, the tunable temperature anchors, kill parity with
// a normal defeat, and the run-view consumables contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { definitionsRoot } from './testPaths.mjs';
import { normalizeParameters } from '../src/parameters.mjs';
import { deriveCombatStats } from '../src/dungeon/dungeonStats.mjs';
import { COMBAT_HEAL_MULTIPLIER } from '../src/dungeon/combatResolution.mjs';
import { TILE_FLOOR, TILE_WALL } from '../src/dungeon/dungeonGeneration.mjs';
import { scaledEnemyStats, enemyArchetype } from '../src/dungeon/dungeonEnemies.mjs';
import { enterDungeon, dungeonAction, getDungeonView, loadDungeonRun } from '../src/dungeon/dungeonEngine.mjs';
import { loadAlchemyDefinitions } from '../src/alchemyDefinitions.mjs';
import { consumableSummary, consumableHealAmount, consumableMpAmount } from '../src/dungeon/combatConsumables.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

const RUNTIME_STATE = 'data/mutable/game_data/runtime_state.json';
const INVENTORY = 'data/mutable/game_data/player_inventory.json';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

function parametersWith(magic = {}, abilities = {}) {
  return {
    magic: {
      light: { value: magic.light ?? 10 }, dark: { value: magic.dark ?? 10 },
      fire: { value: magic.fire ?? 10 }, water: { value: magic.water ?? 10 },
      earth: { value: magic.earth ?? 10 }, wind: { value: magic.wind ?? 10 }
    },
    abilities: {
      strength: { value: abilities.strength ?? 20 }, agility: { value: abilities.agility ?? 20 },
      academics: { value: abilities.academics ?? 20 }, magical_power: { value: abilities.magical_power ?? 20 },
      charisma: { value: abilities.charisma ?? 20 }
    }
  };
}

// A split-layout root with everything the consumable path needs: world/params/runtime_state, the
// dungeon material + alchemy catalogs (view enrichment), and the gathering catalog (the economy
// consume validates against the full known-item set).
async function consumableRoot(parameters = parametersWith()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-consumable-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', parameters);
  await writeJson(root, RUNTIME_STATE, {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await fs.copyFile(
    path.join(definitionsRoot, 'gathering_points.json'),
    path.join(root, 'data/definitions/game_data/gathering_points.json')
  );
  return root;
}

async function setInventory(root, items, money = 100000) {
  await writeJson(root, INVENTORY, { money, items, applied_money_delta_conversation_ids: [] });
}

async function inventoryQuantity(root, itemId) {
  const inventory = await readJson(root, INVENTORY);
  return inventory.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
}

function boxedTiles(rows) {
  return rows.map((row) => [...row].map((tile) => (tile === '#' ? TILE_WALL : TILE_FLOOR)));
}

// Marks the whole floor explored so aim validation (探索済み範囲内) and item pickup do not gate on
// step-by-step reveal in these focused tests.
function markAllExplored(run) {
  run.explored = run.tiles.map((row) => row.map(() => true));
}

async function mutateRun(root, mutate) {
  const state = await readJson(root, RUNTIME_STATE);
  mutate(state.dungeon_run, state);
  await writeJson(root, RUNTIME_STATE, state);
  return state.dungeon_run;
}

function testEnemy(overrides = {}) {
  return {
    uid: overrides.uid ?? 'e1',
    archetype_id: overrides.archetype_id ?? 'mire_slime',
    name: overrides.name ?? '澱みスライム',
    element: overrides.element ?? 'water',
    glyph: overrides.glyph ?? 's',
    x: overrides.x ?? 3,
    y: overrides.y ?? 1,
    hp: overrides.hp ?? 300,
    max_hp: overrides.max_hp ?? overrides.hp ?? 300,
    attack: overrides.attack ?? 1,
    defense: overrides.defense ?? 0,
    speed: overrides.speed ?? 100
  };
}

function makeCompanion(overrides = {}) {
  const parameters = normalizeParameters(parametersWith({ light: 30, water: 30 }, { strength: 30, agility: 30, academics: 30, magical_power: 30 }));
  const stats = deriveCombatStats(parameters);
  return {
    character_id: 'character_test',
    name: 'テスト同行者',
    parameters,
    stats,
    equipment: null,
    element: 'fire',
    x: 2,
    y: 1,
    hp: overrides.hp ?? stats.max_hp,
    max_hp: overrides.max_hp ?? stats.max_hp,
    mp: overrides.mp ?? stats.max_mp,
    max_mp: overrides.max_mp ?? stats.max_mp,
    down: overrides.down ?? false,
    caster_reposition_baseline: null,
    mp_reserve_percent: 0,
    conversation_id: null,
    ...overrides
  };
}

async function consumableDef(root, itemId) {
  const definitions = await loadAlchemyDefinitions({ root });
  const item = definitions.items.find((candidate) => candidate.item_id === itemId);
  assert.ok(item, `catalog is missing ${itemId}`);
  return item;
}

// A one-row corridor with the player at the west end, used for the single-target / consume tests.
async function corridorRun(root, { seed = 246, enemies = [], playerOverrides = {} } = {}) {
  await enterDungeon({ root, seed });
  return mutateRun(root, (run) => {
    run.width = 7;
    run.height = 3;
    run.tiles = boxedTiles([
      '#######',
      '#.....#',
      '#######'
    ]);
    markAllExplored(run);
    run.player.x = 1;
    run.player.y = 1;
    run.player.hp = run.player.max_hp;
    run.player.mp = run.player.max_mp;
    run.player_stats.vision_radius = 6;
    Object.assign(run.player, playerOverrides);
    run.enemies = enemies;
    run.items = [];
  });
}

// ---------------------------------------------------------------------------
// attack_single
// ---------------------------------------------------------------------------

test('attack_single deals exactly the flat catalog power — no defense, element advantage, or variance', async () => {
  const root = await consumableRoot();
  const def = await consumableDef(root, 'alchemy_light_throwing_bomb');
  // A dark enemy with heavy defense and enough HP that only a flat, un-amplified hit leaves it at
  // precisely power+extra-power: any defense mitigation, light>dark advantage, or variance would change it.
  const extra = 137;
  await corridorRun(root, {
    enemies: [testEnemy({ uid: 'flat', element: 'dark', archetype_id: 'creeping_shade', name: '這い寄る影', glyph: 'x', x: 4, hp: def.power + extra, defense: 99 })]
  });
  await setInventory(root, [{ item_id: 'alchemy_light_throwing_bomb', quantity: 2 }]);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_light_throwing_bomb' } });
  const enemy = view.enemies.find((candidate) => candidate.uid === 'flat');
  assert.ok(enemy, 'the enemy survives the fixed hit');
  assert.equal(enemy.hp, extra, 'damage is exactly the item power (defense/advantage/variance ignored)');
  assert.equal(view.turn, 1, 'a valid use passes the turn');
  assert.equal(await inventoryQuantity(root, 'alchemy_light_throwing_bomb'), 1, 'exactly one item is consumed');
  // The attack reuses the {kind:'cast'} event (frontend draw-compat), tinted by the item element.
  assert.ok(view.events.some((event) => event.kind === 'cast' && event.element === 'light' && event.to.x === 4 && event.to.y === 1 && event.hit === true));
  assert.match(view.log.join('\n'), /光の投擲弾/);
});

test('attack_single one-shots a mid-floor normal enemy and lands a heavy hit on a boss (temperature anchor)', async () => {
  const root = await consumableRoot();
  const def = await consumableDef(root, 'alchemy_fire_throwing_bomb');
  // 温度感: the catalog power one-shots a same-floor normal enemy…
  const normalHp = scaledEnemyStats(enemyArchetype('mire_slime'), 5).max_hp;
  assert.ok(def.power >= normalHp, `single power ${def.power} should one-shot a mid-floor normal (${normalHp} HP)`);
  // …and is a heavy but non-lethal blow to a boss (ボスに大打撃).
  const bossHp = scaledEnemyStats(enemyArchetype('volcanic_matron'), 5).max_hp;
  assert.ok(def.power < bossHp && def.power >= bossHp * 0.2, `single power ${def.power} should heavily dent a boss (${bossHp} HP) without one-shotting it`);

  await corridorRun(root, {
    enemies: [testEnemy({ uid: 'norm', element: 'water', x: 4, hp: normalHp, defense: 8 })]
  });
  await setInventory(root, [{ item_id: 'alchemy_fire_throwing_bomb', quantity: 1 }]);
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_fire_throwing_bomb' } });
  assert.equal(view.enemies.some((candidate) => candidate.uid === 'norm'), false, 'the mid-floor normal is one-shot');
  assert.match(view.log.join('\n'), /倒した/);
});

test('attack_single with no visible enemy is a turn-non-consuming action_error and spends no item', async () => {
  const root = await consumableRoot();
  await corridorRun(root, { enemies: [] });
  await setInventory(root, [{ item_id: 'alchemy_light_throwing_bomb', quantity: 3 }]);
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_light_throwing_bomb' } });
  assert.equal(view.action_error, 'no_target');
  assert.equal(view.turn, 0, 'an invalid use does not pass the turn');
  assert.equal(await inventoryQuantity(root, 'alchemy_light_throwing_bomb'), 3, 'no item is consumed on a failed use');
});

// ---------------------------------------------------------------------------
// attack_area
// ---------------------------------------------------------------------------

test('attack_area wipes a clustered pack within radius, spares an out-of-radius enemy, and never hits allies', async () => {
  const root = await consumableRoot();
  const def = await consumableDef(root, 'alchemy_fire_great_blast');
  const clusterHp = def.power - 60; // comfortably inside the "一帯壊滅" band
  await enterDungeon({ root, seed: 101 });
  const companion = makeCompanion({ x: 1, y: 1 });
  await mutateRun(root, (run) => {
    run.width = 9;
    run.height = 5;
    run.tiles = boxedTiles([
      '#########',
      '#.......#',
      '#.......#',
      '#.......#',
      '#########'
    ]);
    markAllExplored(run);
    run.player.x = 1;
    run.player.y = 2;
    run.player.hp = run.player.max_hp;
    run.player_stats.vision_radius = 8;
    run.companion = companion;
    run.enemies = [
      testEnemy({ uid: 'c1', x: 2, y: 2, hp: clusterHp }),
      testEnemy({ uid: 'c2', x: 2, y: 1, hp: clusterHp }),
      testEnemy({ uid: 'c3', x: 3, y: 2, hp: clusterHp }),
      testEnemy({ uid: 'far', x: 7, y: 2, hp: clusterHp }) // manhattan 5 from the aim — out of radius 4
    ];
    run.items = [];
  });
  await setInventory(root, [{ item_id: 'alchemy_fire_great_blast', quantity: 1 }]);

  const view = await dungeonAction({
    root,
    postDungeonScreen: 'academy-room',
    action: { type: 'use_consumable', item_id: 'alchemy_fire_great_blast', aim: { x: 2, y: 2 } }
  });
  const survivors = new Set(view.enemies.map((enemy) => enemy.uid));
  assert.equal(survivors.has('c1'), false, 'cluster enemy in radius is wiped');
  assert.equal(survivors.has('c2'), false, 'cluster enemy in radius is wiped');
  assert.equal(survivors.has('c3'), false, 'cluster enemy in radius is wiped');
  assert.equal(survivors.has('far'), true, 'the out-of-radius enemy survives');
  assert.equal(view.companion.hp, companion.max_hp, 'the companion inside the blast radius is never caught (味方誤爆なし)');
  assert.equal(await inventoryQuantity(root, 'alchemy_fire_great_blast'), 0, 'the blast consumes one item');
  assert.equal(view.turn, 1);
});

test('attack_area on a valid aim with no enemies in radius still consumes and passes the turn (whiff)', async () => {
  const root = await consumableRoot();
  await enterDungeon({ root, seed: 202 });
  await mutateRun(root, (run) => {
    run.width = 9;
    run.height = 5;
    run.tiles = boxedTiles([
      '#########',
      '#.......#',
      '#.......#',
      '#.......#',
      '#########'
    ]);
    markAllExplored(run);
    run.player.x = 1;
    run.player.y = 2;
    run.player.hp = run.player.max_hp;
    run.player_stats.vision_radius = 8;
    run.enemies = [testEnemy({ uid: 'far', x: 7, y: 3, hp: 200 })]; // outside radius 4 of the aim
    run.items = [];
  });
  await setInventory(root, [{ item_id: 'alchemy_water_great_blast', quantity: 2 }]);

  const view = await dungeonAction({
    root,
    postDungeonScreen: 'academy-room',
    action: { type: 'use_consumable', item_id: 'alchemy_water_great_blast', aim: { x: 2, y: 2 } }
  });
  assert.equal(view.action_error, undefined, 'a valid aim with no hits is not an error');
  assert.equal(view.turn, 1, 'the whiff still passes the turn');
  assert.equal(await inventoryQuantity(root, 'alchemy_water_great_blast'), 1, 'the whiff still consumes one item');
  assert.equal(view.enemies.find((enemy) => enemy.uid === 'far').hp, 200, 'the out-of-radius enemy is untouched');
  assert.match(view.log.join('\n'), /巻き込む敵はいなかった/);
});

test('attack_area fails fast (turn/item non-consuming) on an unexplored aim or one blocked by a wall', async () => {
  const root = await consumableRoot();
  await enterDungeon({ root, seed: 303 });
  await mutateRun(root, (run) => {
    run.width = 5;
    run.height = 5;
    run.tiles = boxedTiles([
      '#####',
      '#.#.#',
      '#.#.#',
      '#.#.#',
      '#####'
    ]);
    markAllExplored(run);
    run.player.x = 1;
    run.player.y = 1;
    run.player.hp = run.player.max_hp;
    run.player_stats.vision_radius = 8;
    run.enemies = [testEnemy({ uid: 'behind', x: 3, y: 1, hp: 200 })];
    run.items = [];
  });
  await setInventory(root, [{ item_id: 'alchemy_earth_great_blast', quantity: 2 }]);

  // A tile behind the central wall column is unreachable by throw (no clear line).
  const blocked = await dungeonAction({
    root,
    postDungeonScreen: 'academy-room',
    action: { type: 'use_consumable', item_id: 'alchemy_earth_great_blast', aim: { x: 3, y: 1 } }
  });
  assert.equal(blocked.action_error, 'blocked');
  assert.equal(blocked.turn, 0);

  // An unexplored tile cannot be targeted.
  await mutateRun(root, (run) => { run.explored = run.tiles.map((row) => row.map(() => false)); });
  const unexplored = await dungeonAction({
    root,
    postDungeonScreen: 'academy-room',
    action: { type: 'use_consumable', item_id: 'alchemy_earth_great_blast', aim: { x: 1, y: 1 } }
  });
  assert.equal(unexplored.action_error, 'invalid_aim');
  assert.equal(unexplored.turn, 0);
  assert.equal(await inventoryQuantity(root, 'alchemy_earth_great_blast'), 2, 'neither failed aim consumes an item');
});

// ---------------------------------------------------------------------------
// heal / heal_full / mp_restore / mp_restore_full
// ---------------------------------------------------------------------------

test('heal and heal_full restore the selected ally (self or companion) and reject a downed companion', async () => {
  const root = await consumableRoot();
  const healDef = await consumableDef(root, 'alchemy_healing_elixir');
  await corridorRun(root, { enemies: [], playerOverrides: { hp: 5 } });
  const companion = makeCompanion({ x: 2, y: 1, hp: 40, max_hp: 200, mp: 0, max_mp: 50 });
  await mutateRun(root, (run) => { run.companion = companion; run.player.hp = 5; run.player.max_hp = 200; });
  await setInventory(root, [
    { item_id: 'alchemy_healing_elixir', quantity: 2 },
    { item_id: 'alchemy_full_healing_elixir', quantity: 1 }
  ]);

  // heal targeting the hero: +heal_amount (×combat heal multiplier), then the end-of-turn +1 regen.
  const healedSelf = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_healing_elixir', target: 'player' } });
  assert.equal(healedSelf.player.hp, 5 + healDef.heal_amount * COMBAT_HEAL_MULTIPLIER + 1);
  assert.equal(await inventoryQuantity(root, 'alchemy_healing_elixir'), 1);

  // heal_full targeting the companion: to its max (then regen clamps at max).
  const healedAlly = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_full_healing_elixir', target: 'companion' } });
  assert.equal(healedAlly.companion.hp, 200);

  // A downed companion is not a heal target (revive is its own effect).
  await mutateRun(root, (run) => { run.companion.down = true; run.companion.hp = 0; });
  const rejected = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_healing_elixir', target: 'companion' } });
  assert.equal(rejected.action_error, 'invalid_target');
  assert.equal(await inventoryQuantity(root, 'alchemy_healing_elixir'), 1, 'the rejected heal consumes nothing');
});

test('mp_restore and mp_restore_full restore the selected ally MP; a missing/invalid target is a non-consuming error', async () => {
  const root = await consumableRoot();
  const mpDef = await consumableDef(root, 'alchemy_mana_elixir');
  await corridorRun(root, { enemies: [] });
  await mutateRun(root, (run) => { run.player.mp = 1; run.player.max_mp = 200; });
  await setInventory(root, [
    { item_id: 'alchemy_mana_elixir', quantity: 1 },
    { item_id: 'alchemy_full_moon_elixir', quantity: 1 }
  ]);

  const restored = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_mana_elixir', target: 'player' } });
  assert.equal(restored.player.mp, 1 + mpDef.mp_amount * COMBAT_HEAL_MULTIPLIER + 1); // +mp_amount (×combat heal multiplier) then +1 regen

  // target 'companion' with no companion present is invalid.
  const noAlly = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_full_moon_elixir', target: 'companion' } });
  assert.equal(noAlly.action_error, 'invalid_target');

  // a missing/invalid target selector is invalid too.
  const noTarget = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_full_moon_elixir' } });
  assert.equal(noTarget.action_error, 'invalid_target');
  assert.equal(await inventoryQuantity(root, 'alchemy_full_moon_elixir'), 1, 'the invalid MP uses consume nothing');
});

// ---------------------------------------------------------------------------
// revive
// ---------------------------------------------------------------------------

test('revive stands a downed companion back up at half HP near the hero, once per run', async () => {
  const root = await consumableRoot();
  const def = await consumableDef(root, 'alchemy_revival_droplet');
  await corridorRun(root, { enemies: [] });
  const companion = makeCompanion({ x: 5, y: 1, hp: 0, max_hp: 200, mp: 0, max_mp: 50, down: true });
  await mutateRun(root, (run) => { run.companion = companion; });
  await setInventory(root, [{ item_id: 'alchemy_revival_droplet', quantity: 2 }]);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_revival_droplet' } });
  assert.equal(view.companion.down, false, 'the companion is revived');
  assert.equal(view.companion.hp, Math.round(200 * def.revive_hp_ratio) + 1, 'revived at the HP ratio, then +1 turn regen');
  assert.equal(Math.abs(view.companion.x - view.player.x) + Math.abs(view.companion.y - view.player.y), 1, 'revived adjacent to the hero on a valid tile');
  assert.equal(view.revive_used, true, 'the once-per-run revive is now spent');
  assert.equal(await inventoryQuantity(root, 'alchemy_revival_droplet'), 1);

  // A second revive is rejected even with a droplet in hand and the companion downed again.
  await mutateRun(root, (run) => { run.companion.down = true; run.companion.hp = 0; });
  const second = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_revival_droplet' } });
  assert.equal(second.action_error, 'revive_used');
  assert.equal(second.turn, view.turn, 'the rejected second revive does not pass the turn');
  assert.equal(await inventoryQuantity(root, 'alchemy_revival_droplet'), 1, 'the rejected second revive consumes nothing');
});

test('revive is rejected for a living or absent companion without consuming', async () => {
  const root = await consumableRoot();
  await corridorRun(root, { enemies: [] });
  await setInventory(root, [{ item_id: 'alchemy_revival_droplet', quantity: 1 }]);

  // No companion at all.
  const absent = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_revival_droplet' } });
  assert.equal(absent.action_error, 'invalid_target');

  // A living companion is not revivable.
  await mutateRun(root, (run) => { run.companion = makeCompanion({ x: 2, y: 1 }); });
  const living = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_revival_droplet' } });
  assert.equal(living.action_error, 'invalid_target');
  assert.equal(await inventoryQuantity(root, 'alchemy_revival_droplet'), 1);
});

// ---------------------------------------------------------------------------
// ownership / catalog fail-fast
// ---------------------------------------------------------------------------

test('using an unowned consumable is a turn-non-consuming no_item, and a non-consumable id is unknown_consumable', async () => {
  const root = await consumableRoot();
  await corridorRun(root, { enemies: [testEnemy({ uid: 'target', x: 3, hp: 200 })] });
  await setInventory(root, [{ item_id: 'alchemy_stardust_konpeito', quantity: 3 }]); // a gift, not a consumable

  // Owned zero of the bomb (target present, so the plan is valid): the consume is the ownership gate.
  const unowned = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_light_throwing_bomb' } });
  assert.equal(unowned.action_error, 'no_item');
  assert.equal(unowned.turn, 0);

  // A real alchemy item of the wrong category is not a consumable.
  const wrongCategory = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_stardust_konpeito' } });
  assert.equal(wrongCategory.action_error, 'unknown_consumable');

  // An id absent from the catalog is unknown too.
  const unknown = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'not_a_real_item' } });
  assert.equal(unknown.action_error, 'unknown_consumable');
  assert.equal(await inventoryQuantity(root, 'alchemy_stardust_konpeito'), 3, 'none of the failed uses consume anything');
});

// ---------------------------------------------------------------------------
// reward / material-drop parity with a normal defeat
// ---------------------------------------------------------------------------

test('a consumable kill accrues the same reward and material drop as any other defeat', async () => {
  // Two identical runs (same seed / floor / enemy uid+archetype): one kill via a consumable, one via a
  // spell. defeatEnemy is the single shared path, so the banked pending gains and the material drop match.
  const enemyFor = () => testEnemy({ uid: 'parity', archetype_id: 'ember_imp', name: '火の子鬼', element: 'fire', glyph: 'i', x: 3, hp: 1, defense: 0 });

  const consumableSide = await consumableRoot();
  await corridorRun(consumableSide, { seed: 555, enemies: [enemyFor()], playerOverrides: { mp: 50 } });
  await setInventory(consumableSide, [{ item_id: 'alchemy_light_throwing_bomb', quantity: 1 }]);
  await dungeonAction({ root: consumableSide, postDungeonScreen: 'academy-room', action: { type: 'use_consumable', item_id: 'alchemy_light_throwing_bomb' } });
  const consumableRunState = await loadDungeonRun({ root: consumableSide });

  const castSide = await consumableRoot();
  await corridorRun(castSide, { seed: 555, enemies: [enemyFor()], playerOverrides: { mp: 50 } });
  await dungeonAction({ root: castSide, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'water' } });
  const castRunState = await loadDungeonRun({ root: castSide });

  assert.deepEqual(consumableRunState.pending_gains, castRunState.pending_gains, 'defeat reward accrual is identical regardless of kill method');
  assert.deepEqual(consumableRunState.material_buffer, castRunState.material_buffer, 'material drop is identical regardless of kill method');
});

// ---------------------------------------------------------------------------
// run view contract
// ---------------------------------------------------------------------------

test('the run view exposes owned consumables (summary + quantity), sorted, and the revive_used gate', async () => {
  const root = await consumableRoot();
  await corridorRun(root, { enemies: [] });
  await setInventory(root, [
    { item_id: 'alchemy_fire_great_blast', quantity: 2 },
    { item_id: 'alchemy_light_throwing_bomb', quantity: 5 },
    { item_id: 'alchemy_healing_elixir', quantity: 1 },
    { item_id: 'alchemy_revival_droplet', quantity: 1 },
    { item_id: 'alchemy_stardust_konpeito', quantity: 4 } // a gift — must NOT appear in consumables
  ]);

  const view = await getDungeonView({ root });
  const ids = view.consumables.map((row) => row.item_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), 'consumables are item_id-sorted');
  assert.equal(ids.includes('alchemy_stardust_konpeito'), false, 'non-consumable alchemy items are excluded');
  assert.deepEqual(ids, ['alchemy_fire_great_blast', 'alchemy_healing_elixir', 'alchemy_light_throwing_bomb', 'alchemy_revival_droplet']);

  const single = view.consumables.find((row) => row.item_id === 'alchemy_light_throwing_bomb');
  assert.equal(single.quantity, 5);
  assert.equal(single.target_mode, 'auto');
  assert.equal(single.effect_kind, 'attack_single');
  assert.ok(Number.isInteger(single.power) && single.power > 0);

  const area = view.consumables.find((row) => row.item_id === 'alchemy_fire_great_blast');
  assert.equal(area.target_mode, 'aim');
  assert.ok(Number.isInteger(area.radius) && area.radius > 0);

  assert.equal(view.consumables.find((row) => row.item_id === 'alchemy_healing_elixir').target_mode, 'ally');
  assert.equal(view.consumables.find((row) => row.item_id === 'alchemy_revival_droplet').target_mode, 'revive');
  assert.equal(view.revive_used, false, 'revive is available at the start of the run');
});

test('the combat dock summary heal/mp amount equals the applied amount (single definition, not the authored value)', async () => {
  const root = await consumableRoot();
  const { items } = await loadAlchemyDefinitions({ root });
  const healDef = items.find((item) => item.effect_kind === 'heal');
  const mpDef = items.find((item) => item.effect_kind === 'mp_restore');

  // The dock label reads row.heal_amount / row.mp_amount; the combat resolution restores
  // consumableHealAmount / consumableMpAmount. These must be the same value from the same definition,
  // so the label matches the actual heal — asserted against the multiplier constant, not a hardcoded
  // authored number, so a multiplier change keeps both in lockstep without touching this test.
  const healSummary = consumableSummary(healDef, 1);
  assert.equal(healSummary.heal_amount, consumableHealAmount(healDef), 'heal dock label uses the applied heal definition');
  assert.equal(healSummary.heal_amount, healDef.heal_amount * COMBAT_HEAL_MULTIPLIER);

  const mpSummary = consumableSummary(mpDef, 1);
  assert.equal(mpSummary.mp_amount, consumableMpAmount(mpDef), 'mp dock label uses the applied mp definition');
  assert.equal(mpSummary.mp_amount, mpDef.mp_amount * COMBAT_HEAL_MULTIPLIER);

  // Guard against a no-op scaling: with the multiplier > 1 the displayed amount must diverge from the
  // authored value, i.e. the bug (label showing the authored amount) would fail here.
  assert.ok(COMBAT_HEAL_MULTIPLIER > 1);
  assert.notEqual(healSummary.heal_amount, healDef.heal_amount);
  assert.notEqual(mpSummary.mp_amount, mpDef.mp_amount);

  // And the wired run view carries that same applied amount on the dock row.
  await corridorRun(root, { enemies: [] });
  await setInventory(root, [
    { item_id: 'alchemy_healing_elixir', quantity: 1 },
    { item_id: 'alchemy_mana_elixir', quantity: 1 }
  ]);
  const view = await getDungeonView({ root });
  const elixirDef = items.find((item) => item.item_id === 'alchemy_healing_elixir');
  const manaDef = items.find((item) => item.item_id === 'alchemy_mana_elixir');
  assert.equal(view.consumables.find((row) => row.item_id === 'alchemy_healing_elixir').heal_amount, consumableHealAmount(elixirDef));
  assert.equal(view.consumables.find((row) => row.item_id === 'alchemy_mana_elixir').mp_amount, consumableMpAmount(manaDef));
});

// ---------------------------------------------------------------------------
// auction-sourced dungeon consumable (merged definition source)
// ---------------------------------------------------------------------------
//
// 彗星の大爆薬 (auction_item_10) is an auction-catalog treasure whose effect.category is dungeon_consumable.
// The merged loader (loadDungeonConsumableDefinitions) projects it into the same normalized shape as an
// alchemy dungeon_consumable, so it lists and resolves identically. The authored values (name 彗星の大爆薬,
// attack_area, element fire, power 620, radius 5) are the auction_catalog.json truth for this item.

test('an owned auction dungeon_consumable (彗星の大爆薬) is listed in the run view alongside alchemy consumables', async () => {
  const root = await consumableRoot();
  await corridorRun(root, { enemies: [] });
  await setInventory(root, [
    { item_id: 'auction_item_10', quantity: 1 },
    { item_id: 'alchemy_fire_great_blast', quantity: 2 }
  ]);

  const view = await getDungeonView({ root });
  const ids = view.consumables.map((row) => row.item_id);
  assert.deepEqual(ids, ['alchemy_fire_great_blast', 'auction_item_10'], 'the auction consumable lists with the alchemy one, item_id-sorted');

  const comet = view.consumables.find((row) => row.item_id === 'auction_item_10');
  assert.equal(comet.name, '彗星の大爆薬');
  assert.equal(comet.effect_kind, 'attack_area');
  assert.equal(comet.target_mode, 'aim', 'attack_area surfaces the aim target mode');
  assert.equal(comet.element, 'fire');
  assert.equal(comet.power, 620);
  assert.equal(comet.radius, 5);
  assert.equal(comet.quantity, 1);
});

test('use_consumable resolves an auction dungeon_consumable (彗星の大爆薬) — flat area damage, atomic consume, turn cost', async () => {
  const root = await consumableRoot();
  await enterDungeon({ root, seed: 202 });
  const companion = makeCompanion({ x: 1, y: 1 });
  await mutateRun(root, (run) => {
    run.width = 11;
    run.height = 5;
    run.tiles = boxedTiles([
      '###########',
      '#.........#',
      '#.........#',
      '#.........#',
      '###########'
    ]);
    markAllExplored(run);
    run.player.x = 1;
    run.player.y = 2;
    run.player.hp = run.player.max_hp;
    run.player_stats.vision_radius = 10;
    run.companion = companion; // (1,1): manhattan 3 from the aim — inside the blast but an ally, never caught
    run.enemies = [
      testEnemy({ uid: 'c1', x: 3, y: 2, hp: 560 }), // manhattan 0 from the aim → wiped by the flat 620
      testEnemy({ uid: 'c2', x: 4, y: 2, hp: 560 }), // manhattan 1 → wiped
      testEnemy({ uid: 'far', x: 9, y: 2, hp: 560 }) // manhattan 6 from the aim — out of radius 5
    ];
    run.items = [];
  });
  await setInventory(root, [{ item_id: 'auction_item_10', quantity: 1 }]);

  const view = await dungeonAction({
    root,
    postDungeonScreen: 'academy-room',
    action: { type: 'use_consumable', item_id: 'auction_item_10', aim: { x: 3, y: 2 } }
  });
  const survivors = new Set(view.enemies.map((enemy) => enemy.uid));
  assert.equal(survivors.has('c1'), false, 'a clustered enemy in radius is wiped by the flat 620 blast');
  assert.equal(survivors.has('c2'), false, 'a clustered enemy in radius is wiped');
  assert.equal(survivors.has('far'), true, 'the out-of-radius enemy survives (radius 5)');
  assert.equal(view.companion.hp, companion.max_hp, 'the companion inside the blast radius is never caught (味方誤爆なし)');
  assert.equal(await inventoryQuantity(root, 'auction_item_10'), 0, 'exactly one auction item is consumed (atomic)');
  assert.equal(view.turn, 1, 'a valid use passes the turn');
  assert.ok(view.events.some((event) => event.kind === 'cast' && event.element === 'fire' && event.hit === true), 'the blast reuses the element-tinted cast event');
});
