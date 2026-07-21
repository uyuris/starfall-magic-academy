import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { magicParameterDefinitions, normalizeParameters } from '../src/parameters.mjs';
import { DIFFICULTY_FLOOR_OFFSET, difficultyFloorFor } from '../src/dungeon/dungeonScaling.mjs';
import { buildMilestoneBossEnemy, generateFloor, MILESTONE_FLOORS, TILE_FLOOR, TILE_WALL } from '../src/dungeon/dungeonGeneration.mjs';
import { bossArchetypes, enemyArchetype, enemyArchetypes, enemyCombatMaxHp, enemyCountForFloor, scaledEnemyStats, validateEnemyArchetypeIdentities } from '../src/dungeon/dungeonEnemies.mjs';
import { deriveCombatStats, healingSpellAmount, healingSpellManaCost, meleeManaCost, spellManaCost } from '../src/dungeon/dungeonStats.mjs';
import { COMBAT_HEAL_MULTIPLIER, COMBAT_HP_MULTIPLIER } from '../src/dungeon/combatResolution.mjs';
import { bankPendingGains, emptyPendingGains, accrueEnemyDefeat, accrueFloorClear, accrueRunClear, summarizePendingGains, rewardTuning } from '../src/dungeon/dungeonRewards.mjs';
import { evaluateDungeonLlmAvailability, AVAILABILITY_REASONS } from '../src/dungeon/dungeonAvailability.mjs';
import { enterDungeon, dungeonAction, loadDungeonRun, getDungeonView, enemyActionCount, MAX_FLOORS, TURN_MANA_REGEN, buildDungeonCompanionPromptTailContext } from '../src/dungeon/dungeonEngine.mjs';
import { selectCompanion, companionDescriptor, homunculusCompanionViewFields, dungeonEnterCompanionEvent } from '../src/dungeon/dungeonCompanion.mjs';
import { createRng, deriveSeed } from '../src/dungeon/dungeonRng.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

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

async function dungeonRoot(parameters = parametersWith()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-dungeon-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', parameters);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  // A kept run end merges dropped materials into player_inventory, which needs the
  // material catalog resolvable in the split-layout definitions.
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  // The run view enriches usable dungeon consumables from the alchemy catalog, so every
  // view-building path (enter / action / state) needs it resolvable.
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  return root;
}

function floorTileCount(generated) {
  return floorCells(generated).length;
}

function floorCells(generated) {
  const cells = [];
  for (let y = 0; y < generated.tiles.length; y += 1) {
    for (let x = 0; x < generated.tiles[y].length; x += 1) {
      if (generated.tiles[y][x] === TILE_FLOOR) cells.push({ x, y });
    }
  }
  return cells;
}

function reachable(generated, from, to) {
  const seen = new Set([`${from.x},${from.y}`]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === to.x && cur.y === to.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (ny < 0 || nx < 0 || ny >= generated.height || nx >= generated.width) continue;
      if (generated.tiles[ny][nx] !== TILE_FLOOR) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return false;
}

function boxedTiles(rows) {
  return rows.map((row) => [...row].map((tile) => (tile === '#' ? TILE_WALL : TILE_FLOOR)));
}

function testEnemy(overrides = {}) {
  return {
    uid: overrides.uid ?? 'e1',
    archetype_id: overrides.archetype_id ?? 'mire_slime',
    name: overrides.name ?? '澱みスライム',
    element: overrides.element ?? 'water',
    glyph: overrides.glyph ?? 's',
    x: overrides.x ?? 1,
    y: overrides.y ?? 1,
    hp: overrides.hp ?? 120,
    max_hp: overrides.max_hp ?? overrides.hp ?? 120,
    attack: overrides.attack ?? 1,
    defense: overrides.defense ?? 0,
    speed: overrides.speed ?? 100
  };
}

function legacyScaledEnemyStats(archetype, floor) {
  const depth = floor - 1;
  return {
    max_hp: archetype.base_hp + Math.round(archetype.base_hp * 0.38 * depth),
    attack: archetype.base_attack + depth,
    defense: archetype.base_defense + Math.floor(depth / 2),
    speed: archetype.speed
  };
}

function rebasedLegacyEnemyAttack(archetype, floor) {
  return legacyScaledEnemyStats(archetype, floor).attack;
}

function actionRngForRun(run) {
  return createRng(deriveSeed(run.seed, 100000 + run.turn));
}

function expectedNeutralEnemyMeleeDamage(run, enemy, defender) {
  const rng = actionRngForRun(run);
  const hitChance = Math.max(5, Math.min(99, (enemy.accuracy ?? 80) - (defender.evasion ?? 0)));
  assert.equal(rng.int(1, 100) <= hitChance, true, 'test setup should make the enemy melee hit');
  const raw = Math.round((enemy.attack ?? enemy.melee_attack ?? 1) * (rng.int(82, 118) / 100));
  const crit = rng.int(1, 100) <= (enemy.crit_chance ?? 0);
  return Math.max(1, Math.round(raw * (crit ? 1.5 : 1)) - (defender.defense ?? 0));
}

function expectedNeutralEnemySpellDamage(run, power, defender) {
  const rng = actionRngForRun(run);
  const raw = Math.round(power * (rng.int(82, 118) / 100));
  return Math.max(1, raw - Math.floor((defender.defense ?? 0) / 2));
}

function legacyEnemyCountForFloor(floor) {
  return 4 + floor;
}

function manhattanDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

function generatedSpawnableCells(generated) {
  return floorCells(generated).filter((cell) => {
    if (cell.x === generated.entrance.x && cell.y === generated.entrance.y) return false;
    if (cell.x === generated.stairs.x && cell.y === generated.stairs.y) return false;
    return manhattanDistance(cell, generated.entrance) > 2;
  });
}

function bossSpawnExpectation(generated) {
  const occupied = new Set(generated.enemies.filter((enemy) => enemy.boss !== true).map(cellKey));
  return generatedSpawnableCells(generated)
    .filter((cell) => !occupied.has(cellKey(cell)))
    .sort((a, b) => {
      const distance = manhattanDistance(a, generated.stairs) - manhattanDistance(b, generated.stairs);
      if (distance !== 0) return distance;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    })[0];
}

test('generateFloor is deterministic for a seed and varies across seeds', () => {
  const a = generateFloor({ seed: 42, floor: 1 });
  const b = generateFloor({ seed: 42, floor: 1 });
  const c = generateFloor({ seed: 99, floor: 1 });
  assert.deepEqual(a.tiles, b.tiles, 'same seed reproduces the same map');
  assert.deepEqual(a.enemies, b.enemies, 'same seed reproduces the same enemies');
  const differs = JSON.stringify(a.tiles) !== JSON.stringify(c.tiles) || JSON.stringify(a.enemies) !== JSON.stringify(c.enemies);
  assert.equal(differs, true, 'a different seed produces a different floor');
});

test('the dungeon bestiary has a broad normal roster with coherent training grants', () => {
  const magicKeys = new Set(magicParameterDefinitions.map((definition) => definition.key));
  const abilityKeys = new Set(['strength', 'agility', 'academics', 'magical_power', 'charisma']);
  const ids = new Set();
  const glyphs = new Set();
  const elements = new Map();

  assert.equal(enemyArchetypes.length, 22);
  for (const archetype of enemyArchetypes) {
    assert.equal(ids.has(archetype.id), false, `${archetype.id} id should be unique`);
    ids.add(archetype.id);
    assert.equal(glyphs.has(archetype.glyph), false, `${archetype.id} glyph should be unique`);
    glyphs.add(archetype.glyph);

    assert.ok(magicKeys.has(archetype.element), `${archetype.id} element should be a known magic key`);
    elements.set(archetype.element, (elements.get(archetype.element) ?? 0) + 1);
    assert.equal(archetype.base_hp >= 64 && archetype.base_hp <= 116, true, `${archetype.id} HP should stay in the normal enemy band`);
    assert.equal(archetype.base_attack >= 9 && archetype.base_attack <= 14, true, `${archetype.id} attack should stay in the normal enemy band`);
    assert.equal(archetype.base_defense >= 2 && archetype.base_defense <= 9, true, `${archetype.id} defense should stay in the normal enemy band`);
    assert.equal(archetype.speed >= 60 && archetype.speed <= 140, true, `${archetype.id} speed should stay in the normal enemy band`);

    const magicGrant = archetype.grants.find((grant) => grant.group === 'magic' && grant.key === archetype.element);
    assert.ok(magicGrant, `${archetype.id} should train its own element`);
    assert.equal(magicGrant.weight >= 2, true, `${archetype.id} own-element grant should have useful weight`);
    assert.equal(archetype.grants.some((grant) => grant.group === 'abilities'), true, `${archetype.id} should also train an ability`);
    for (const grant of archetype.grants) {
      assert.equal(Number.isInteger(grant.weight) && grant.weight > 0, true, `${archetype.id} grants should use positive integer weights`);
      if (grant.group === 'magic') assert.ok(magicKeys.has(grant.key), `${archetype.id} magic grant ${grant.key} should be valid`);
      else if (grant.group === 'abilities') assert.ok(abilityKeys.has(grant.key), `${archetype.id} ability grant ${grant.key} should be valid`);
      else assert.fail(`${archetype.id} grant group ${grant.group} should be known`);
    }
  }

  for (const definition of magicParameterDefinitions) {
    assert.equal((elements.get(definition.key) ?? 0) >= 3, true, `${definition.key} should have at least three normal archetypes`);
  }
});

test('boss archetypes are separate, stronger, unique, and reward-capable', () => {
  const normalIds = new Set(enemyArchetypes.map((archetype) => archetype.id));
  const glyphs = new Set(enemyArchetypes.map((archetype) => archetype.glyph));

  assert.equal(bossArchetypes.length, 4);
  for (const boss of bossArchetypes) {
    assert.equal(boss.boss, true, `${boss.id} should be marked as a boss`);
    assert.equal(normalIds.has(boss.id), false, `${boss.id} should not reuse a normal enemy id`);
    assert.equal(glyphs.has(boss.glyph), false, `${boss.id} glyph should not collide with normal enemies or bosses`);
    glyphs.add(boss.glyph);
    assert.equal(boss.base_hp >= 200 && boss.base_hp <= 350, true, `${boss.id} HP should be in the boss band`);
    assert.equal(boss.base_attack >= 18 && boss.base_attack <= 26, true, `${boss.id} attack should be in the boss band`);
    assert.equal(boss.base_defense >= 10 && boss.base_defense <= 16, true, `${boss.id} defense should be in the boss band`);
    assert.equal(enemyArchetype(boss.id), boss, `${boss.id} should resolve through the reward archetype lookup`);
  }
  assert.throws(() => enemyArchetype('missing_boss'), /unknown enemy archetype/);
});

test('enemy archetype identity validation fails fast on broken roster entries', () => {
  assert.throws(
    () => validateEnemyArchetypeIdentities([{ id: 'duplicate_id', glyph: '1' }, { id: 'duplicate_id', glyph: '2' }]),
    /duplicate enemy archetype id: duplicate_id/
  );
  assert.throws(
    () => validateEnemyArchetypeIdentities([{ id: 'glyph_one', glyph: '!' }, { id: 'glyph_two', glyph: '!' }]),
    /duplicate enemy archetype glyph: !/
  );
  assert.throws(
    () => validateEnemyArchetypeIdentities([{ glyph: '?' }]),
    /enemy archetype is missing id/
  );
  assert.throws(
    () => validateEnemyArchetypeIdentities([{ id: 'missing_glyph' }]),
    /enemy archetype missing_glyph is missing glyph/
  );
});

test('milestone floors add one deterministic boss near the stairs without replacing normal enemies', () => {
  assert.deepEqual(MILESTONE_FLOORS, [5, 10]);

  for (const floor of MILESTONE_FLOORS) {
    const generated = generateFloor({ seed: 2026, floor });
    const again = generateFloor({ seed: 2026, floor });
    const bosses = generated.enemies.filter((enemy) => enemy.boss === true);

    assert.deepEqual(generated.enemies, again.enemies, `floor ${floor} enemy generation should be deterministic`);
    assert.equal(bosses.length, 1, `floor ${floor} should spawn exactly one boss`);
    assert.equal(generated.enemies.filter((enemy) => enemy.boss !== true).length, enemyCountForFloor(floor), `floor ${floor} normal count should be preserved`);
    assert.equal(manhattanDistance(bosses[0], generated.stairs) <= 6, true, `floor ${floor} boss should spawn close to the stairs`);
    assert.deepEqual(
      { x: bosses[0].x, y: bosses[0].y },
      bossSpawnExpectation(generated),
      `floor ${floor} boss should use the nearest remaining spawnable tile`
    );
  }

  const nonMilestone = generateFloor({ seed: 2026, floor: 4 });
  assert.equal(nonMilestone.enemies.some((enemy) => enemy.boss === true), false, 'non-milestone floors should not spawn bosses');
  assert.equal(nonMilestone.enemies.length, enemyCountForFloor(4), 'non-milestone floors should keep the normal enemy count');
});

test('milestone boss generation fails fast for empty boss pool and exhausted spawnable tiles', () => {
  const savedBosses = bossArchetypes.splice(0);
  try {
    assert.throws(
      () => generateFloor({ seed: 2026, floor: 5 }),
      /milestone floor 5 requires at least one boss archetype/
    );
  } finally {
    bossArchetypes.push(...savedBosses);
  }

  assert.throws(
    () => buildMilestoneBossEnemy({
      floorNumber: 5,
      rng: { pick: (items) => items[0] },
      spawnable: [{ x: 4, y: 4 }],
      occupied: new Set(['4,4']),
      stairs: { x: 4, y: 5 }
    }),
    /milestone floor 5 has no available boss spawn tile/
  );
});

test('generated floors are connected: the stairs are reachable from the entrance', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    for (let floor = 1; floor <= MAX_FLOORS; floor += 1) {
      const generated = generateFloor({ seed, floor });
      assert.equal(generated.tiles[generated.entrance.y][generated.entrance.x], TILE_FLOOR);
      assert.equal(generated.tiles[generated.stairs.y][generated.stairs.x], TILE_FLOOR);
      assert.equal(reachable(generated, generated.entrance, generated.stairs), true, `seed ${seed} floor ${floor} stairs unreachable`);
    }
  }
});

test('deeper floors scale through the tenth floor', () => {
  assert.equal(MAX_FLOORS, 10);
  const f1 = generateFloor({ seed: 7, floor: 1 });
  const f10 = generateFloor({ seed: 7, floor: 10 });
  assert.equal(f10.enemies.length > f1.enemies.length, true);
  assert.equal(f10.width >= f1.width, true);
  assert.equal(floorTileCount(f10) > 0, true);

  const archetype = enemyArchetypes[0];
  const floor5Stats = scaledEnemyStats(archetype, 5);
  const floor10Stats = scaledEnemyStats(archetype, 10);
  assert.equal(floor10Stats.max_hp > floor5Stats.max_hp, true, 'enemy HP keeps scaling after floor 5');
  assert.equal(floor10Stats.attack > floor5Stats.attack, true, 'enemy attack keeps scaling after floor 5');
  assert.equal(floor10Stats.defense >= floor5Stats.defense, true, 'enemy defense never drops on deeper floors');
  assert.equal(enemyCountForFloor(10), enemyCountForFloor(5) + 5, 'enemy count keeps its +1/floor pace');
});

test('dungeon difficulty is rebased and enemy attack uses the rebased roster value', () => {
  assert.equal(MAX_FLOORS, 10);
  assert.equal(DIFFICULTY_FLOOR_OFFSET, 7);
  assert.equal(difficultyFloorFor(1), 8);
  assert.equal(difficultyFloorFor(3), 10);
  assert.equal(difficultyFloorFor(10), 17);

  for (const archetype of enemyArchetypes) {
    assert.deepEqual(scaledEnemyStats(archetype, 1), {
      ...legacyScaledEnemyStats(archetype, 8),
      attack: rebasedLegacyEnemyAttack(archetype, 8)
    }, `${archetype.id} floor 1 should use rebased old floor 8 stats`);
    assert.deepEqual(scaledEnemyStats(archetype, 3), {
      ...legacyScaledEnemyStats(archetype, 10),
      attack: rebasedLegacyEnemyAttack(archetype, 10)
    }, `${archetype.id} floor 3 should use rebased old floor 10 stats`);
    assert.deepEqual(scaledEnemyStats(archetype, 10), {
      ...legacyScaledEnemyStats(archetype, 17),
      attack: rebasedLegacyEnemyAttack(archetype, 17)
    }, `${archetype.id} floor 10 should extrapolate to rebased old floor 17 stats`);
    assert.equal(
      scaledEnemyStats(archetype, 1).attack,
      legacyScaledEnemyStats(archetype, 8).attack,
      `${archetype.id} floor 1 attack should exactly use the rebased pressure`
    );
  }

  assert.equal(enemyCountForFloor(1), legacyEnemyCountForFloor(8));
  assert.equal(enemyCountForFloor(3), legacyEnemyCountForFloor(10));
  assert.equal(enemyCountForFloor(10), legacyEnemyCountForFloor(17));
  assert.equal(enemyCountForFloor(10) - enemyCountForFloor(1), 9, 'enemy count keeps the old +1/floor increment');
});

test('dungeon floor scaling fails fast for missing or invalid floor numbers', () => {
  assert.throws(() => difficultyFloorFor(), /invalid dungeon floor/);
  assert.throws(() => difficultyFloorFor(0), /invalid dungeon floor/);
  assert.throws(() => difficultyFloorFor(1.5), /invalid dungeon floor/);
  assert.throws(() => enemyCountForFloor(0), /invalid dungeon floor/);
  assert.throws(() => scaledEnemyStats(enemyArchetypes[0], 1.5), /invalid dungeon floor/);
  assert.throws(() => generateFloor({ seed: 42, floor: 0 }), /invalid dungeon floor/);
});

test('parameters mechanically drive combat stats (the train -> stronger loop)', () => {
  const weak = deriveCombatStats(parametersWith({}, { strength: 5, magical_power: 5, agility: 5, academics: 5 }));
  const strong = deriveCombatStats(parametersWith({ fire: 90 }, { strength: 90, magical_power: 90, agility: 90, academics: 90 }));
  assert.equal(strong.max_hp > weak.max_hp, true);
  assert.equal(strong.melee_attack > weak.melee_attack, true);
  assert.equal(strong.spell_power.fire > weak.spell_power.fire, true);
  assert.equal(strong.vision_radius >= weak.vision_radius, true);
  assert.equal(strong.speed > weak.speed, true, 'agility raises speed (turn order)');
});

test('meleeManaCost uses the shared spell cost table with strength and agility average', () => {
  assert.equal(meleeManaCost(parametersWith({}, { strength: 0, agility: 0 })), 6);
  assert.equal(meleeManaCost(parametersWith({}, { strength: 100, agility: 0 })), 4);
  assert.equal(meleeManaCost(parametersWith({}, { strength: 100, agility: 100 })), 2);
  assert.equal(
    meleeManaCost(parametersWith({}, { strength: 70, agility: 30 })),
    spellManaCost('fire', parametersWith({ fire: 50 })),
    'melee cost rides the same mastery cost table as spells'
  );

  const missingStrength = parametersWith({}, { agility: 30 });
  delete missingStrength.abilities.strength;
  assert.throws(() => meleeManaCost(missingStrength), /abilities\.strength is required for melee mana cost/);

  const missingAgility = parametersWith({}, { strength: 30 });
  delete missingAgility.abilities.agility;
  assert.throws(() => meleeManaCost(missingAgility), /abilities\.agility is required for melee mana cost/);
});

test('enemyActionCount reflects agility-driven player speed into enemy turn order', () => {
  // A much faster enemy acts twice against a slow player.
  assert.equal(enemyActionCount(150, 100, 0), 2);
  // Even speed: one action.
  assert.equal(enemyActionCount(100, 100, 0), 1);
  // A much slower enemy acts only every other turn.
  assert.equal(enemyActionCount(60, 100, 0), 1);
  assert.equal(enemyActionCount(60, 100, 1), 0);
  // Raising the player's speed (agility) suppresses the fast enemy's double action.
  assert.equal(enemyActionCount(150, 130, 0), 1);
});

test('retreat is only allowed from the entrance or stairs (greed ladder)', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 777 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  // Move the player onto a floor tile that is neither the entrance nor stairs.
  let spot = null;
  for (let y = 0; y < run.height && !spot; y += 1) {
    for (let x = 0; x < run.width; x += 1) {
      const isFloor = run.tiles[y][x] === 'floor';
      const isEntrance = x === run.entrance.x && y === run.entrance.y;
      const isStairs = x === run.stairs.x && y === run.stairs.y;
      if (isFloor && !isEntrance && !isStairs) { spot = { x, y }; break; }
    }
  }
  run.player.x = spot.x;
  run.player.y = spot.y;
  run.enemies = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const blocked = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(blocked.status, 'active', 'retreat from an unsafe tile does not end the run');
  assert.equal(blocked.action_error, 'retreat_not_here');

  // Standing on the entrance, retreat succeeds.
  const onEntrance = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  onEntrance.dungeon_run.player.x = onEntrance.dungeon_run.entrance.x;
  onEntrance.dungeon_run.player.y = onEntrance.dungeon_run.entrance.y;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', onEntrance);
  const done = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(done.status, 'retreated');
});

test('dungeon run end accepts a post-content screen for routing hub return', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 777 });

  const done = await dungeonAction({
    root,
    action: { type: 'retreat' },
    postDungeonScreen: 'interaction'
  });

  assert.equal(done.status, 'retreated');
  assert.equal(done.transition.next_screen, 'interaction');
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(state.current_screen, 'interaction');
});

test('dungeon actions require an explicit post-content screen', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 777 });

  await assert.rejects(
    () => dungeonAction({ root, action: { type: 'retreat' } }),
    /postDungeonScreen is required/
  );
});

test('reward accrual + banking lands within the per-run cap and raises parameters', () => {
  const pending = emptyPendingGains();
  // Simulate a full clear killing several enemies per floor.
  for (let floor = 1; floor <= MAX_FLOORS; floor += 1) {
    for (let i = 0; i < 5; i += 1) accrueEnemyDefeat(pending, 'ember_imp', floor);
    if (floor < MAX_FLOORS) accrueFloorClear(pending, floor);
  }
  accrueRunClear(pending);
  const base = parametersWith({}, { strength: 10, agility: 10, academics: 10, magical_power: 10, charisma: 10 });
  const banked = bankPendingGains(base, pending);
  assert.equal(banked.total_applied > 0, true, 'a clear grants gains');
  assert.equal(banked.total_applied <= rewardTuning.RUN_GAIN_CAP, true, 'run gains are capped');
  // ~2x a basic-training week (a week ~6-12 points): a full clear should be a meaningful chunk.
  assert.equal(banked.total_applied >= 10, true, 'a full clear is worth a meaningful amount');
});

test('summarizePendingGains previews only positive rounded gains', () => {
  const pending = emptyPendingGains();
  // Small single gains round to 0; accumulate enough to surface in the preview.
  for (let i = 0; i < 6; i += 1) accrueEnemyDefeat(pending, 'stone_golem', 3);
  const summary = summarizePendingGains(pending);
  const keys = [...Object.keys(summary.magic), ...Object.keys(summary.abilities)];
  for (const group of [summary.magic, summary.abilities]) {
    for (const value of Object.values(group)) assert.equal(value > 0, true);
  }
  assert.equal(keys.length > 0, true);
});

test('two-mode availability is an explicit decision, not a silent fallback', () => {
  assert.deepEqual(evaluateDungeonLlmAvailability({ lmStudioConfigured: false, busy: false }), { available: false, reason: AVAILABILITY_REASONS.NOT_CONFIGURED });
  assert.deepEqual(evaluateDungeonLlmAvailability({ lmStudioConfigured: true, busy: true }), { available: false, reason: AVAILABILITY_REASONS.BUSY });
  assert.deepEqual(evaluateDungeonLlmAvailability({ lmStudioConfigured: true, busy: false }), { available: true, reason: AVAILABILITY_REASONS.AVAILABLE });
});

test('enterDungeon starts a solo run at the entrance with full vitals', async () => {
  const root = await dungeonRoot();
  const view = await enterDungeon({ root, seed: 123 });
  assert.equal(view.active, true);
  assert.equal(view.floor, 1);
  assert.equal(view.max_floors, MAX_FLOORS);
  assert.equal(view.companion, null);
  assert.equal(view.player.hp, view.player.max_hp);
  assert.equal(view.player.x, view.entrance.x);
  assert.equal(view.player.y, view.entrance.y);
  const run = await loadDungeonRun({ root });
  assert.equal(run.status, 'active');
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(state.current_screen, 'academy-dungeon');
});

test('waiting passes a turn; an invalid move does not', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 555 });
  const afterWait = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(afterWait.turn, 1);
  // Moving into a wall (pick a direction that is blocked) must not advance the turn.
  const blocked = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'up' } });
  // Either it moved (turn 2) or it was blocked (turn stays 1 with action_error).
  if (blocked.action_error) assert.equal(blocked.turn, 1);
  else assert.equal(blocked.turn, 2);
});

test('completed turns regenerate player and companion HP/MP by one without exceeding max values', async () => {
  const root = await dungeonRoot(parametersWith({ water: 80 }, { magical_power: 80, academics: 80 }));
  const companion = {
    character_id: 'character_016',
    name: 'テスト同行者',
    parameters: parametersWith({ fire: 80 }, { magical_power: 80, agility: 40 })
  };
  await enterDungeon({ root, seed: 555, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.enemies = [];
  run.player.hp = run.player.max_hp - 2;
  run.player.mp = 0;
  run.companion.hp = run.companion.max_hp - 1;
  run.companion.mp = run.companion.max_mp - 1;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(view.turn, 1);
  assert.equal(TURN_MANA_REGEN, 1);
  assert.equal(view.player.hp, run.player.max_hp - 1, 'the player recovers one HP per completed turn');
  assert.equal(view.player.mp, 1, 'the player recovers one MP per completed turn');
  assert.equal(view.companion.hp, view.companion.max_hp, 'companion HP recovery clamps at max HP');
  assert.equal(view.companion.mp, view.companion.max_mp, 'companion recovery clamps at max MP');

  const persisted = await loadDungeonRun({ root });
  assert.equal(persisted.player.hp, persisted.player.max_hp - 1);
  assert.equal(persisted.player.mp, 1);
  assert.equal(persisted.companion.hp, persisted.companion.max_hp);
  assert.equal(persisted.companion.mp, persisted.companion.max_mp);
});

test('turn regeneration applies on descend but not on invalid actions', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 555 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player.hp = run.player.max_hp - 4;
  run.player.mp = 0;
  run.enemies = [];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const blocked = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'up' } });
  assert.equal(blocked.action_error, 'blocked');
  assert.equal(blocked.turn, 0);
  assert.equal(blocked.player.hp, run.player.max_hp - 4);
  assert.equal(blocked.player.mp, 0);

  const descendState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  descendState.dungeon_run.player.x = descendState.dungeon_run.stairs.x;
  descendState.dungeon_run.player.y = descendState.dungeon_run.stairs.y;
  descendState.dungeon_run.player.hp = descendState.dungeon_run.player.max_hp - 4;
  descendState.dungeon_run.player.mp = 0;
  descendState.dungeon_run.enemies = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', descendState);

  const descended = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'descend' } });
  assert.equal(descended.floor, 2);
  assert.equal(descended.turn, 1);
  assert.equal(descended.player.hp, descended.player.max_hp - 3);
  assert.equal(descended.player.mp, 1);
});

test('view exposes healing spell cost, expected self-heal amount, and usability', async () => {
  const root = await dungeonRoot(parametersWith({ light: 80, water: 40 }, { magical_power: 60, academics: 40 }));
  await enterDungeon({ root, seed: 246 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.player.hp = run.player.max_hp - 20;
  run.player.mp = run.player.max_mp;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await getDungeonView({ root });
  assert.deepEqual(Object.keys(view.healing_spell).sort(), ['action_type', 'can_use', 'heal_amount', 'mp_cost', 'recoverable_hp'].sort());
  assert.equal(view.healing_spell.action_type, 'heal_spell');
  assert.equal(view.healing_spell.can_use, true);
  assert.equal(view.healing_spell.mp_cost > 0, true);
  assert.equal(view.healing_spell.heal_amount > 0, true);
  assert.equal(view.healing_spell.recoverable_hp, Math.min(20, view.healing_spell.heal_amount));

  const lowWaterRoot = await dungeonRoot(parametersWith({ light: 80, water: 5 }, { magical_power: 60, academics: 40 }));
  await enterDungeon({ root: lowWaterRoot, seed: 246 });
  const lowWaterView = await getDungeonView({ root: lowWaterRoot });
  assert.equal(view.healing_spell.heal_amount > lowWaterView.healing_spell.heal_amount, true, 'water mastery contributes to the heal amount');

  const lowLightRoot = await dungeonRoot(parametersWith({ light: 5, water: 40 }, { magical_power: 60, academics: 40 }));
  await enterDungeon({ root: lowLightRoot, seed: 246 });
  const lowLightView = await getDungeonView({ root: lowLightRoot });
  assert.equal(view.healing_spell.heal_amount > lowLightView.healing_spell.heal_amount, true, 'light mastery contributes to the heal amount');
});

test('healing spell view fails fast when required light, water, or magical power values are missing', async () => {
  for (const missing of ['light', 'water', 'magical_power']) {
    const root = await dungeonRoot(parametersWith({ light: 80, water: 40 }, { magical_power: 60, academics: 40 }));
    await enterDungeon({ root, seed: 246 });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    if (missing === 'magical_power') delete state.dungeon_run.parameters.abilities.magical_power;
    else delete state.dungeon_run.parameters.magic[missing];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

    await assert.rejects(
      () => getDungeonView({ root }),
      new RegExp(missing === 'magical_power' ? 'abilities\\.magical_power is required for healing spell amount' : `magic\\.${missing} is required for healing spell`)
    );
  }
});

test('player healing spell is self-targeted, spends MP, and insufficient MP is a non-turn action', async () => {
  const root = await dungeonRoot(parametersWith({ light: 80, water: 40 }, { magical_power: 60, academics: 40 }));
  await enterDungeon({ root, seed: 246 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.enemies = [];
  run.player.hp = run.player.max_hp - 40;
  run.player.mp = run.player.max_mp;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const before = await getDungeonView({ root });

  const healed = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'heal_spell' } });
  assert.equal(healed.turn, 1);
  assert.equal(healed.enemies.length, 0);
  assert.equal(healed.player.hp, Math.min(before.player.max_hp, before.player.hp + before.healing_spell.heal_amount + 1));
  assert.equal(healed.player.mp, before.player.mp - before.healing_spell.mp_cost + 1);
  assert.match(healed.log.join('\n'), /回復魔法/);

  const lowMpState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  lowMpState.dungeon_run.player.hp = lowMpState.dungeon_run.player.max_hp - 20;
  lowMpState.dungeon_run.player.mp = 0;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', lowMpState);
  const blocked = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'heal_spell' } });
  assert.equal(blocked.action_error, 'insufficient_mp');
  assert.equal(blocked.turn, 1);
  assert.equal(blocked.player.hp, lowMpState.dungeon_run.player.max_hp - 20);
  assert.equal(blocked.player.mp, 0);
});

test('player melee bump spends the strength/agility MP cost and insufficient MP is a non-turn action', async () => {
  const parameters = parametersWith({}, { strength: 50, agility: 50, magical_power: 20, academics: 20 });
  const cost = meleeManaCost(parameters);
  const root = await dungeonRoot(parameters);
  await enterDungeon({ root, seed: 246 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player.mp = cost + 2;
  run.player_stats.accuracy = 1000;
  run.player_stats.melee_attack = 999;
  run.enemies = [testEnemy({ uid: 'bump_target', x: 2, y: 1, hp: 1, speed: run.player_stats.speed })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const hit = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'right' } });
  assert.equal(hit.turn, 1);
  assert.equal(hit.player.mp, cost + 2 - cost + 1, 'melee spends cost, then valid-turn MP regeneration applies');
  assert.ok(hit.events.find((event) => event.kind === 'melee' && event.to.x === 2 && event.to.y === 1));
  assert.equal(hit.enemies.some((enemy) => enemy.uid === 'bump_target'), false);

  const lowMpState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  lowMpState.dungeon_run.player.x = 1;
  lowMpState.dungeon_run.player.y = 1;
  lowMpState.dungeon_run.player.hp = lowMpState.dungeon_run.player.max_hp - 10;
  lowMpState.dungeon_run.player.mp = cost - 1;
  lowMpState.dungeon_run.enemies = [testEnemy({ uid: 'blocked_target', x: 2, y: 1, hp: 120, speed: lowMpState.dungeon_run.player_stats.speed })];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', lowMpState);

  const blocked = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'right' } });
  assert.equal(blocked.action_error, 'insufficient_mp');
  assert.equal(blocked.turn, 1);
  assert.equal(blocked.player.hp, lowMpState.dungeon_run.player.max_hp - 10);
  assert.equal(blocked.player.mp, cost - 1);
  assert.equal(blocked.enemies.find((enemy) => enemy.uid === 'blocked_target').hp, 120);
});

test('player melee bump fails fast when required MP state is missing', async () => {
  for (const missing of ['mp', 'max_mp']) {
    const parameters = parametersWith({}, { strength: 50, agility: 50, magical_power: 20, academics: 20 });
    const root = await dungeonRoot(parameters);
    await enterDungeon({ root, seed: 246 });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    run.width = 5;
    run.height = 5;
    run.tiles = boxedTiles([
      '#####',
      '#...#',
      '#...#',
      '#...#',
      '#####'
    ]);
    run.player.x = 1;
    run.player.y = 1;
    delete run.player[missing];
    run.enemies = [testEnemy({ uid: 'mp_contract_target', x: 2, y: 1, hp: 120, speed: run.player_stats.speed })];
    run.items = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

    await assert.rejects(
      () => dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'right' } }),
      /dungeon player MP is required for melee attack/
    );
  }
});

test('retreat banks pending gains into persisted player parameters', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 10, agility: 40, academics: 30, magical_power: 30, charisma: 20 }));
  await enterDungeon({ root, seed: 321 });
  // Inject pending gains as if the run earned them, then retreat.
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run.pending_gains.abilities.strength = 6;
  state.dungeon_run.pending_gains.magic.fire = 3;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');
  const result = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(result.status, 'retreated');
  assert.equal(result.total_applied > 0, true);

  const saved = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(saved.abilities.strength.value > before.abilities.strength.value, true);
  assert.equal(saved.magic.fire.value > before.magic.fire.value, true);
  const endState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(endState.dungeon_run, null);
  // The dungeon now returns to the player's room (mirrors the conversation post-flow).
  assert.equal(endState.current_screen, 'academy-room');
});

test('a wipe discards the run gains: parameters are unchanged on death', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 5, agility: 1, academics: 1, magical_power: 1, charisma: 1 }));
  await enterDungeon({ root, seed: 4242 });
  // Cripple the player and drop a lethal enemy next to them, with pending gains banked.
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.player.hp = 1;
  run.pending_gains.abilities.strength = 5;
  run.enemies = [{ uid: 'e1', archetype_id: 'stone_golem', name: '石塊ゴーレム', element: 'earth', glyph: 'G', x: run.player.x + 1, y: run.player.y, hp: 80, max_hp: 80, attack: 99, defense: 5, speed: 60 }];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  let result = null;
  for (let i = 0; i < 30 && !(result && result.status === 'dead'); i += 1) {
    result = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    if (result.ended) break;
  }
  assert.equal(result.status, 'dead');
  assert.equal(result.total_applied, 0);
  assert.deepEqual(result.applied_gains, { magic: {}, abilities: {} });
  // Death must not have banked anything: no mutable parameter file is written.
  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/runtime/player_parameters.json')), { code: 'ENOENT' });
  assert.equal(result.world.player_parameters.abilities.strength.value, before.abilities.strength.value);
  const endState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(endState.dungeon_run, null);
});

test('companion is fixed to the buddy across every seed with no roll', () => {
  const characters = Array.from({ length: 5 }, (_, i) => ({ character_id: `character_00${i + 1}`, display_name: `c${i + 1}`, parameters: {} }));
  const buddyId = 'character_003';
  // A set buddy IS the companion — the same one for every seed, never rolled.
  for (let seed = 1; seed <= 400; seed += 1) {
    assert.equal(selectCompanion({ characters, currentBuddyCharacterId: buddyId, seed }).character_id, buddyId);
  }
  // The pick does not depend on the seed at all: it holds with the seed omitted.
  assert.equal(selectCompanion({ characters, currentBuddyCharacterId: buddyId }).character_id, buddyId);
});

test('companion with no buddy is uniform-random over the roster, deterministic per seed', () => {
  const characters = Array.from({ length: 5 }, (_, i) => ({ character_id: `character_00${i + 1}`, display_name: `c${i + 1}`, parameters: {} }));
  // Deterministic for a fixed seed.
  assert.equal(
    selectCompanion({ characters, currentBuddyCharacterId: null, seed: 11 }).character_id,
    selectCompanion({ characters, currentBuddyCharacterId: null, seed: 11 }).character_id
  );
  const counts = new Map();
  const trials = 400;
  for (let seed = 1; seed <= trials; seed += 1) {
    const id = selectCompanion({ characters, currentBuddyCharacterId: null, seed }).character_id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // Without a buddy every roster member can appear and none dominates the way a
  // weighted buddy would: selection stays uniform, the pre-existing behavior.
  assert.equal(counts.size, characters.length, 'every roster member can be the companion');
  for (const character of characters) {
    const share = counts.get(character.character_id) ?? 0;
    assert.equal(share > 0, true, `${character.character_id} never appeared`);
    assert.equal(share < trials / 2, true, `${character.character_id} dominated selection: ${share}/${trials}`);
  }
});

test('companion selection throws when the buddy is not a selectable candidate', () => {
  const characters = Array.from({ length: 3 }, (_, i) => ({ character_id: `character_00${i + 1}`, display_name: `c${i + 1}`, parameters: {} }));
  // A buddy id that does not resolve is a hard error, never a silent drop to random.
  assert.throws(
    () => selectCompanion({ characters, currentBuddyCharacterId: 'character_999', seed: 7 }),
    /buddy character character_999 is not among the selectable companion candidates/
  );
});

test('a homunculus companion enters with its descriptor face_url and default entry snapshot', async () => {
  const root = await dungeonRoot();
  // A homunculus buddy descriptor carries face_url (a homunculus is not resolvable from the selectable
  // roster on the frontend) and normalized parameters, and no equipment/mp-reserve is authored yet.
  const companion = companionDescriptor(
    { character_id: 'homunculus_001', display_name: 'ノクス', parameters: parametersWith({ fire: 40 }, { magical_power: 40 }) },
    'conv_dungeon_dr_777',
    { faceUrl: '/canonical/character_visual_sets/hp_007/face_emotions/neutral.jpg' }
  );
  await enterDungeon({ root, seed: 777, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const runCompanion = state.dungeon_run.companion;
  assert.equal(runCompanion.character_id, 'homunculus_001');
  assert.equal(runCompanion.name, 'ノクス');
  assert.equal(runCompanion.face_url, '/canonical/character_visual_sets/hp_007/face_emotions/neutral.jpg');
  // Absent equipment / mp-reserve read as the spec initial state (unequipped, reserve 30), not a fallback.
  assert.equal(runCompanion.equipment, null);
  assert.equal(runCompanion.mp_reserve_percent, 30);
  // The run view exposes the companion face_url for the frontend icon, plus the C-12 normalized parameters
  // snapshot (so the frontend renders the detail popup — 顔＋名前＋11 パラメーター — with no extra fetch).
  const view = await getDungeonView({ root });
  assert.equal(view.companion.face_url, runCompanion.face_url);
  // The exposed parameters are the entry snapshot on run.companion, in the C-12 normalized shape (6 magic +
  // 5 ability keys, each { min, max, label, value }), matching what resolveActiveHomunculusActor returns.
  assert.deepEqual(view.companion.parameters, runCompanion.parameters);
  assert.deepEqual(view.companion.parameters, normalizeParameters(parametersWith({ fire: 40 }, { magical_power: 40 })));
  assert.equal(view.companion.parameters.magic.fire.value, 40);
  assert.equal(view.companion.parameters.abilities.magical_power.value, 40);
  assert.deepEqual(Object.keys(view.companion.parameters), ['magic', 'abilities']);
});

test('a homunculus companion parameters snapshot is fixed at entry and survives a held resume', async () => {
  const root = await dungeonRoot();
  const companion = companionDescriptor(
    { character_id: 'homunculus_001', display_name: 'ノクス', parameters: parametersWith({ fire: 40 }, { magical_power: 40 }) },
    'conv_dungeon_dr_808',
    { faceUrl: '/canonical/character_visual_sets/hp_007/face_emotions/neutral.jpg' }
  );
  await enterDungeon({ root, seed: 808, companion });
  const entered = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const snapshot = entered.dungeon_run.companion.parameters;
  assert.equal(snapshot.magic.fire.value, 40);

  // The parameters are fixed on run state at entry (the same discipline as equipment / mp_reserve_percent):
  // the engine never re-resolves them mid-run, so a held run that resumes off the persisted state shows the
  // entry snapshot value. Exercised by taking a turn and re-reading the persisted view.
  entered.dungeon_run.enemies = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', entered);
  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const resumedView = await getDungeonView({ root });
  assert.deepEqual(resumedView.companion.parameters, snapshot, 'the held resume view shows the entry-snapshot parameters');
});

test('a selectable companion view carries no parameters field (homunculus marker absent)', async () => {
  const root = await dungeonRoot();
  // A selectable companion descriptor has no faceUrl, so run.companion carries neither face_url nor the
  // parameters view field: the frontend resolves a selectable companion from the roster. The view.companion
  // shape stays exactly as before this change (byte-identical).
  const companion = { character_id: 'character_016', name: 'エマ', parameters: parametersWith({ fire: 40 }, { magical_power: 40 }) };
  await enterDungeon({ root, seed: 909, companion });
  const view = await getDungeonView({ root });
  assert.equal(Object.hasOwn(view.companion, 'parameters'), false, 'a selectable companion view has no parameters field');
  assert.equal(Object.hasOwn(view.companion, 'face_url'), false, 'a selectable companion view has no face_url field');
  assert.deepEqual(
    Object.keys(view.companion),
    ['character_id', 'name', 'x', 'y', 'hp', 'max_hp', 'mp', 'max_mp', 'element', 'down', 'conversation_id', 'equipment']
  );
});

test('the companion view/enter marker fields carry face_url + parameters only for a homunculus', () => {
  const parameters = normalizeParameters(parametersWith({ fire: 40 }, { magical_power: 40 }));
  const homunculusCompanion = { character_id: 'homunculus_001', name: 'ノクス', conversation_id: 'conv_1', face_url: '/canonical/character_visual_sets/hp_007/face_emotions/neutral.jpg', parameters };
  const selectableCompanion = { character_id: 'character_016', name: 'エマ', conversation_id: 'conv_2', parameters };

  // The shared marker projection: face_url + parameters together for a homunculus, {} for a selectable
  // companion (so every payload spreading it stays byte-identical for a selectable companion).
  assert.deepEqual(homunculusCompanionViewFields(homunculusCompanion), { face_url: homunculusCompanion.face_url, parameters });
  assert.deepEqual(homunculusCompanionViewFields(selectableCompanion), {});

  // The streamed dungeon_enter companion payload: identity plus the marker fields for a homunculus.
  assert.deepEqual(dungeonEnterCompanionEvent(homunculusCompanion), {
    character_id: 'homunculus_001', name: 'ノクス', conversation_id: 'conv_1', face_url: homunculusCompanion.face_url, parameters
  });
  assert.deepEqual(dungeonEnterCompanionEvent(selectableCompanion), {
    character_id: 'character_016', name: 'エマ', conversation_id: 'conv_2'
  });
  assert.equal(dungeonEnterCompanionEvent(null), null);
});

test('a mid-run buddy change does not re-roll an in-progress run companion', async () => {
  const root = await dungeonRoot();
  const companion = {
    character_id: 'character_016',
    name: 'エントリー同行者',
    parameters: parametersWith({ fire: 40 }, { magical_power: 40 })
  };
  // The buddy at entry becomes the run companion, persisted in dungeon_run.
  await enterDungeon({ root, seed: 555, companion });
  const entered = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(entered.dungeon_run.companion.character_id, 'character_016');

  // A buddy swap after the run has started must not touch the in-progress companion:
  // the run is fixed at entry and the engine reads dungeon_run, never re-selecting.
  entered.current_buddy_character_id = 'character_099';
  entered.dungeon_run.enemies = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', entered);

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  const afterAction = await loadDungeonRun({ root });
  assert.equal(afterAction.companion.character_id, 'character_016', 'the in-progress run keeps its entry companion');
});

test('charisma (fortune) raises item quality: more is restored from the same item', async () => {
  async function healedHp(charisma) {
    const root = await dungeonRoot(parametersWith({}, { strength: 80, agility: 20, academics: 20, magical_power: 20, charisma }));
    await enterDungeon({ root, seed: 50 });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    run.player.hp = 1;
    run.inventory = [{ kind: 'heal_herb', count: 1 }];
    run.enemies = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
    const result = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'use_item', item_kind: 'heal_herb' } });
    return result.player.hp;
  }
  const low = await healedHp(0);
  const high = await healedHp(100);
  assert.equal(high > low, true, `higher charisma restores more from the same item (${high} vs ${low})`);
});

test('entering while a run is active fails fast — no overwrite of a run with pending gains', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 1 });
  await assert.rejects(enterDungeon({ root, seed: 2 }), (error) => error.statusCode === 409);
});

test('descending all floors clears the run and banks the accumulated gains', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 20, agility: 20, academics: 20, magical_power: 20, charisma: 20 }));
  await enterDungeon({ root, seed: 9090 });
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  let result = null;
  for (let floor = 1; floor <= MAX_FLOORS; floor += 1) {
    // Teleport onto the stairs (combat navigation is exercised elsewhere) and descend.
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    assert.equal(run.floor, floor);
    run.enemies = []; // clear the floor so the descent is unobstructed
    run.player.x = run.stairs.x;
    run.player.y = run.stairs.y;
    // Give the run some accrued gains to bank on clear.
    run.pending_gains.abilities.strength += 2;
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
    result = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'descend' } });
  }
  assert.equal(result.status, 'cleared');
  assert.equal(result.total_applied > 0, true);
  const saved = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(saved.abilities.strength.value > before.abilities.strength.value, true);
  const endState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(endState.dungeon_run, null);
});

test('the enemy view exposes archetype_id and boss marker for icon resolution', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 111 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.enemies = [{ uid: 'e1', archetype_id: 'abyss_prefect', name: '深淵の寮監', element: 'dark', glyph: 'Y', x: run.player.x + 1, y: run.player.y, hp: 120, max_hp: 120, attack: 20, defense: 12, speed: 105, boss: true }];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const enemy = view.enemies.find((entry) => entry.uid === 'e1');
  assert.ok(enemy, 'the adjacent enemy is visible in the view');
  assert.equal(enemy.archetype_id, 'abyss_prefect', 'the view carries archetype_id for per-enemy art');
  assert.equal(enemy.boss, true, 'the view carries the boss marker for boss presentation');
});

test('the dungeon view keeps explored items visible even when they leave the current vision radius', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 111 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 6;
  run.height = 4;
  run.tiles = boxedTiles([
    '......',
    '......',
    '......',
    '......'
  ]);
  run.explored = Array.from({ length: run.height }, () => Array.from({ length: run.width }, () => false));
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 1;
  run.enemies = [];
  run.items = [{ uid: 'remembered_item', kind: 'heal_herb', x: 4, y: 1 }];
  run.explored[1][4] = true;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await getDungeonView({ root });

  assert.equal(view.visible[1][4], false, 'the item tile is explored but no longer in current vision');
  assert.equal(view.items.some((item) => item.uid === 'remembered_item'), true, 'explored items remain visible in the player-facing view');
});

test('the dungeon view hides wall-obscured cells and enemies from current vision', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 111 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#.#.#',
    '#####'
  ]);
  run.explored = Array.from({ length: run.height }, () => Array.from({ length: run.width }, () => true));
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 5;
  run.enemies = [testEnemy({ uid: 'behind_wall', name: '壁裏の番人', x: 3, y: 1, hp: 120 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await getDungeonView({ root });

  assert.equal(view.visible[1][2], true, 'the blocking wall itself is visible');
  assert.equal(view.visible[1][3], false, 'floor behind a wall is not currently visible');
  assert.equal(view.enemies.some((enemy) => enemy.uid === 'behind_wall'), false, 'wall-obscured enemies are absent from the player-facing view');
});

test('a companion joins combat and its parameters drive its performance', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60 }) };
  const view = await enterDungeon({ root, seed: 246, companion });
  assert.equal(view.companion.character_id, 'character_016');
  assert.equal(view.companion.hp, view.companion.max_hp);
  // The companion's strong parameters give it more HP than a baseline actor.
  const baseline = deriveCombatStats(parametersWith());
  assert.equal(view.companion.max_hp > baseline.max_hp, true);
  const run = await loadDungeonRun({ root });
  assert.equal(run.companion.element, 'fire', 'strongest magic mastery becomes the primary element');
});

test('dungeon companion prompt tail context summarizes floor, nearby threats/items, and party HP/MP', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  const nearX = Math.min(run.width - 1, run.player.x + 1);
  const nearY = run.player.y;
  run.floor = 2;
  run.player.hp = 5;
  run.player.mp = 3;
  run.companion.name = 'リナ・クラウゼ';
  run.companion.hp = 7;
  run.companion.mp = 4;
  run.enemies = [
    testEnemy({ uid: 'near_enemy', name: '石塊ゴーレム', x: nearX, y: nearY, hp: 40, max_hp: 80 }),
    testEnemy({ uid: 'far_enemy', name: '遠くの火の子鬼', x: run.width - 1, y: run.height - 1, hp: 12, max_hp: 20 })
  ];
  run.items = [{ uid: 'near_item', kind: 'heal_herb', x: nearX, y: nearY }];
  run.explored[nearY][nearX] = true;

  const context = buildDungeonCompanionPromptTailContext(run);

  assert.match(context, /階層: 第2層 \/ 全10層/);
  assert.match(context, /主人公: HP 5\/\d+, MP 3\/\d+/);
  assert.match(context, /同行者 リナ・クラウゼ: HP 7\/\d+, MP 4\/\d+/);
  assert.match(context, /近くの敵: 石塊ゴーレム HP 40\/80/);
  assert.match(context, /近くのアイテム: 癒し草/);
  assert.doesNotMatch(context, /遠くの火の子鬼/);
  // Necessary-and-sufficient: raw grid coordinates carry no speech value and are
  // omitted, and the block header is not duplicated (the prompt renderer adds
  // "追加の現在状況:" already).
  assert.doesNotMatch(context, /位置\(/);
  assert.doesNotMatch(context, /実践ダンジョン同行状況/);
});

test('dungeon companion prompt tail context uses companion vision and lists every visible threat/item', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'リナ・クラウゼ', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60, academics: 5 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;

  run.width = 9;
  run.height = 9;
  run.tiles = boxedTiles([
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........'
  ]);
  run.explored = Array.from({ length: run.height }, () => Array.from({ length: run.width }, () => true));
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 1;
  run.companion.x = 5;
  run.companion.y = 5;
  run.companion.stats.vision_radius = 2;
  run.enemies = [
    testEnemy({ uid: 'player_only', name: '主人公側の火の子鬼', x: 2, y: 1, hp: 10, max_hp: 20 }),
    testEnemy({ uid: 'north', name: '北の石塊ゴーレム', x: 5, y: 3, hp: 30, max_hp: 80 }),
    testEnemy({ uid: 'east', name: '東の澱みスライム', x: 7, y: 5, hp: 31, max_hp: 70 }),
    testEnemy({ uid: 'south', name: '南の火の子鬼', x: 5, y: 7, hp: 32, max_hp: 60 }),
    testEnemy({ uid: 'west', name: '西の影コウモリ', x: 3, y: 5, hp: 33, max_hp: 50 }),
    testEnemy({ uid: 'outside', name: '遠方の番人', x: 8, y: 8, hp: 34, max_hp: 90 })
  ];
  run.items = [
    { uid: 'player_item', kind: 'heal_herb', x: 1, y: 2 },
    { uid: 'north_item', kind: 'heal_herb', x: 5, y: 4 },
    { uid: 'east_item', kind: 'mana_dew', x: 7, y: 5 },
    { uid: 'south_item', kind: 'heal_herb', x: 5, y: 7 },
    { uid: 'west_item', kind: 'mana_dew', x: 3, y: 5 },
    { uid: 'outside_item', kind: 'mana_dew', x: 8, y: 8 }
  ];

  const context = buildDungeonCompanionPromptTailContext(run);

  assert.doesNotMatch(context, /主人公側の火の子鬼/);
  assert.match(context, /北の石塊ゴーレム HP 30\/80 距離2/);
  assert.match(context, /東の澱みスライム HP 31\/70 距離2/);
  assert.match(context, /南の火の子鬼 HP 32\/60 距離2/);
  assert.match(context, /西の影コウモリ HP 33\/50 距離2/);
  assert.doesNotMatch(context, /遠方の番人/);
  assert.equal([...context.matchAll(/癒し草/g)].length, 2);
  assert.equal([...context.matchAll(/魔力の雫/g)].length, 2);
});

test('dungeon companion prompt tail context hides wall-obscured threats and items', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'リナ・クラウゼ', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60, academics: 5 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;

  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#.#.#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 1;
  run.companion.y = 1;
  run.companion.stats.vision_radius = 5;
  run.enemies = [testEnemy({ uid: 'behind_wall', name: '壁裏の番人', x: 3, y: 1, hp: 30, max_hp: 80 })];
  run.items = [{ uid: 'behind_wall_item', kind: 'heal_herb', x: 3, y: 1 }];

  const context = buildDungeonCompanionPromptTailContext(run);

  assert.match(context, /近くの敵: なし/);
  assert.match(context, /近くのアイテム: なし/);
  assert.doesNotMatch(context, /壁裏の番人/);
  assert.doesNotMatch(context, /癒し草/);
});

test('dungeon companion prompt tail context distinguishes one-on-one from being surrounded', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'リナ・クラウゼ', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60, academics: 5 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;

  run.width = 9;
  run.height = 9;
  run.tiles = boxedTiles([
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........'
  ]);
  run.explored = Array.from({ length: run.height }, () => Array.from({ length: run.width }, () => true));
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 1;
  run.companion.x = 5;
  run.companion.y = 5;
  run.companion.stats.vision_radius = 1;

  run.enemies = [
    testEnemy({ uid: 'east', name: '東の澱みスライム', x: 6, y: 5, hp: 31, max_hp: 70 })
  ];
  const oneOnOneContext = buildDungeonCompanionPromptTailContext(run);

  run.enemies = [
    testEnemy({ uid: 'east', name: '東の澱みスライム', x: 6, y: 5, hp: 31, max_hp: 70 }),
    testEnemy({ uid: 'north', name: '北の石塊ゴーレム', x: 5, y: 4, hp: 30, max_hp: 80 }),
    testEnemy({ uid: 'south', name: '南の火の子鬼', x: 5, y: 6, hp: 32, max_hp: 60 }),
    testEnemy({ uid: 'west', name: '西の影コウモリ', x: 4, y: 5, hp: 33, max_hp: 50 })
  ];
  const surroundedContext = buildDungeonCompanionPromptTailContext(run);

  assert.match(oneOnOneContext, /近くの敵: 東の澱みスライム HP 31\/70 距離1/);
  assert.doesNotMatch(oneOnOneContext, /北の石塊ゴーレム|南の火の子鬼|西の影コウモリ/);
  assert.match(surroundedContext, /東の澱みスライム HP 31\/70 距離1/);
  assert.match(surroundedContext, /北の石塊ゴーレム HP 30\/80 距離1/);
  assert.match(surroundedContext, /南の火の子鬼 HP 32\/60 距離1/);
  assert.match(surroundedContext, /西の影コウモリ HP 33\/50 距離1/);
  assert.notEqual(oneOnOneContext, surroundedContext);
});

test('dungeon companion prompt tail context fails fast for missing required context', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'リナ・クラウゼ', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60 }) };
  await enterDungeon({ root, seed: 246, companion });
  const run = await loadDungeonRun({ root });

  assert.throws(() => buildDungeonCompanionPromptTailContext(null), /dungeon run is required/);
  assert.throws(() => buildDungeonCompanionPromptTailContext({ ...run, player: null }), /dungeon run player state is required/);
  assert.throws(() => buildDungeonCompanionPromptTailContext({ ...run, companion: null }), /dungeon companion is required for prompt context/);
  assert.throws(
    () => buildDungeonCompanionPromptTailContext({ ...run, companion: { ...run.companion, stats: { ...run.companion.stats, vision_radius: Number.NaN } } }),
    /dungeon companion vision radius is required for prompt context/
  );
});

test('dungeon companion prompt tail context tracks the situation: safe vs near-death with an adjacent enemy', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'リナ・クラウゼ', parameters: parametersWith({ fire: 80 }, { strength: 80, magical_power: 80, agility: 60 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;

  // Safe: no enemies in sight, the party at full HP.
  run.enemies = [];
  run.items = [];
  const safeContext = buildDungeonCompanionPromptTailContext(run);
  assert.match(safeContext, /近くの敵: なし/);
  assert.match(safeContext, new RegExp(`主人公: HP ${run.player.max_hp}\\/${run.player.max_hp}`));

  // Danger: the protagonist near death with an enemy right beside the party.
  const nearX = Math.min(run.width - 1, run.player.x + 1);
  const nearY = run.player.y;
  run.player.hp = 4;
  run.enemies = [testEnemy({ uid: 'adjacent', name: '石塊ゴーレム', x: nearX, y: nearY, hp: 50, max_hp: 80 })];
  const dangerContext = buildDungeonCompanionPromptTailContext(run);
  assert.match(dangerContext, /近くの敵: 石塊ゴーレム HP 50\/80 距離1/);
  assert.match(dangerContext, new RegExp(`主人公: HP 4\\/${run.player.max_hp}`));

  // The injected wording actually differs with the situation.
  assert.notEqual(safeContext, dangerContext);
});

test('companion pathing routes around a wall-line target instead of staying blocked', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 80 }, { strength: 40, magical_power: 40, agility: 40 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.#...#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 5;
  run.player.y = 3;
  run.companion.x = 1;
  run.companion.y = 2;
  run.companion.mp = 0;
  run.enemies = [testEnemy({ x: 3, y: 2, hp: 120, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(view.action_error, undefined);
  const after = await loadDungeonRun({ root });
  assert.notDeepEqual(
    { x: after.companion.x, y: after.companion.y },
    { x: 1, y: 2 },
    'companion should take a pathing step instead of repeatedly pushing into the wall'
  );
  assert.equal(after.tiles[after.companion.y][after.companion.x], TILE_FLOOR);
});

test('enemy pathing routes around a wall-line target instead of staying blocked', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 246 });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.#...#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 1;
  run.player.y = 2;
  run.enemies = [testEnemy({ x: 3, y: 2, hp: 120, speed: run.player_stats.speed })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const after = await loadDungeonRun({ root });
  assert.notDeepEqual(
    { x: after.enemies[0].x, y: after.enemies[0].y },
    { x: 3, y: 2 },
    'enemy should take a pathing step instead of repeatedly pushing into the wall'
  );
  assert.equal(after.tiles[after.enemies[0].y][after.enemies[0].x], TILE_FLOOR);
});

test('player cast does not target an enemy behind a wall', async () => {
  const root = await dungeonRoot(parametersWith({ fire: 80 }, { magical_power: 80, academics: 80 }));
  await enterDungeon({ root, seed: 246 });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#.#.#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.enemies = [testEnemy({ x: 3, y: 1, hp: 120 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const before = await loadDungeonRun({ root });
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'fire' } });
  const after = await loadDungeonRun({ root });
  assert.equal(view.action_error, 'no_target');
  assert.equal(view.turn, 0, 'blocked casts do not spend a turn');
  assert.equal(after.player.mp, before.player.mp, 'blocked casts do not spend MP');
  assert.equal(after.enemies[0].hp, before.enemies[0].hp, 'blocked casts do not damage through walls');
  assert.deepEqual(view.events, [], 'blocked casts do not emit hit events');
});

test('enemies cast ranged magic through the existing combat event contract', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 40, magical_power: 40, agility: 40, academics: 40 }));
  await enterDungeon({ root, seed: 246 });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 6;
  run.height = 3;
  run.tiles = boxedTiles([
    '######',
    '#....#',
    '######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.enemies = [testEnemy({ archetype_id: 'ember_imp', name: '火の子鬼', element: 'fire', x: 4, y: 1, hp: 120, attack: 80, speed: run.player_stats.speed })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const before = await loadDungeonRun({ root });
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const after = await loadDungeonRun({ root });
  const cast = view.events.find((event) => event.kind === 'cast');
  assert.ok(cast, 'enemy ranged magic is reported as a cast event');
  assert.equal(cast.element, 'fire', 'the event carries the raw element id for frontend tinting');
  assert.deepEqual(cast.from, { x: 4, y: 1 });
  assert.deepEqual(cast.to, { x: 1, y: 1 });
  assert.equal(after.enemies[0].x, before.enemies[0].x, 'a casting enemy does not spend the action moving');
  assert.equal(after.player.hp < before.player.hp, true, 'ranged magic damages the target');
  assert.match(view.log.join('\n'), /火の子鬼の火魔法/);
});

test('generated enemy melee damage uses the rebased roster attack value', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 40, magical_power: 40, agility: 40, academics: 40 }));
  await enterDungeon({ root, seed: 246 });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  const archetype = enemyArchetype('stone_golem');
  const generatedAttack = scaledEnemyStats(archetype, 1).attack;
  const expectedAttack = rebasedLegacyEnemyAttack(archetype, difficultyFloorFor(1));
  assert.equal(generatedAttack, expectedAttack, 'melee test enemy attack is the exact rebased generated value');
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.defense = 0;
  run.player_stats.evasion = 0;
  run.enemies = [testEnemy({
    uid: 'strengthened_melee',
    archetype_id: archetype.id,
    name: archetype.name,
    element: archetype.element,
    glyph: archetype.glyph,
    x: 2,
    y: 1,
    hp: 120,
    attack: generatedAttack,
    speed: run.player_stats.speed,
    accuracy: 1000
  })];
  run.items = [];
  const expectedDamage = expectedNeutralEnemyMeleeDamage(run, run.enemies[0], run.player_stats);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  // Enemy melee on the protagonist is logged with the 主人公 subject:
  // `${enemy.name}が主人公に${damage}ダメージ。` (mirrors the companion-target line).
  const damageLine = view.log.find((line) => line.includes(`${archetype.name}が主人公に`));
  const damage = Number(damageLine?.match(/(\d+)ダメージ/)?.[1]);

  assert.equal(Number.isFinite(damage), true, 'enemy melee damage is logged');
  assert.equal(damage, expectedDamage, 'melee damage is resolved from the exact rebased generated attack');
});

test('generated enemy ranged magic damage uses the rebased roster attack value and buffed magic multiplier', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 40, magical_power: 40, agility: 40, academics: 40 }));
  await enterDungeon({ root, seed: 246 });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  const archetype = enemyArchetype('ember_imp');
  const generatedAttack = scaledEnemyStats(archetype, 1).attack;
  const expectedAttack = rebasedLegacyEnemyAttack(archetype, difficultyFloorFor(1));
  const expectedSpellPower = Math.round(expectedAttack * 0.75);
  assert.equal(generatedAttack, expectedAttack, 'ranged magic test enemy attack is the exact rebased generated value');
  run.width = 6;
  run.height = 3;
  run.tiles = boxedTiles([
    '######',
    '#....#',
    '######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.defense = 0;
  run.enemies = [testEnemy({
    uid: 'e1',
    archetype_id: archetype.id,
    name: archetype.name,
    element: archetype.element,
    glyph: archetype.glyph,
    x: 4,
    y: 1,
    hp: 120,
    attack: generatedAttack,
    speed: run.player_stats.speed
  })];
  run.items = [];
  const expectedDamage = expectedNeutralEnemySpellDamage(run, expectedSpellPower, run.player_stats);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const damageLine = view.log.find((line) => line.includes(`${archetype.name}の火魔法`));
  const damage = Number(damageLine?.match(/(\d+)ダメージ/)?.[1]);
  const generatedSpellPower = Math.round(generatedAttack * 0.75);

  assert.equal(Number.isFinite(damage), true, 'enemy ranged magic damage is logged');
  assert.equal(generatedSpellPower, expectedSpellPower, 'ranged magic power is round(exact rebased generated attack * 0.75)');
  assert.equal(damage, expectedDamage, 'ranged magic damage is resolved from the exact rebased generated attack spell power');
});

test('enemy ranged magic is blocked by walls and emits no cast event', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 40, magical_power: 40, agility: 40, academics: 40 }));
  await enterDungeon({ root, seed: 246 });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#.#.#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.enemies = [testEnemy({ archetype_id: 'ember_imp', name: '火の子鬼', element: 'fire', x: 3, y: 1, hp: 120, attack: 20, speed: run.player_stats.speed })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const before = await loadDungeonRun({ root });
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const after = await loadDungeonRun({ root });
  assert.equal(view.events.some((event) => event.kind === 'cast'), false, 'wall-blocked enemy magic emits no cast event');
  assert.equal(after.player.hp, before.player.hp, 'wall-blocked enemy magic does not damage through walls');
});

test('player spell logs render every magic element in Japanese', async () => {
  for (const definition of magicParameterDefinitions) {
    const root = await dungeonRoot(parametersWith({ [definition.key]: 100 }, { magical_power: 100, academics: 80 }));
    await enterDungeon({ root, seed: 246 });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    run.width = 5;
    run.height = 3;
    run.tiles = boxedTiles([
      '#####',
      '#...#',
      '#####'
    ]);
    run.player.x = 1;
    run.player.y = 1;
    run.enemies = [testEnemy({ x: 3, y: 1, hp: 999, speed: 60 })];
    run.items = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: definition.key } });
    const spellName = definition.label.replace(/習熟度$/, '');
    const logText = view.log.join('\n');
    // The protagonist's cast names 主人公 as the subject, mirroring the companion
    // line's `${name}の${element}` form, and renders the Japanese element label.
    assert.match(logText, new RegExp(`主人公の${spellName}`));
    assert.doesNotMatch(logText, new RegExp(`${definition.key}魔法`));
  }
});

test('dungeon player melee log names 主人公 as the acting subject', async () => {
  const parameters = parametersWith({}, { strength: 50, agility: 50, magical_power: 20, academics: 20 });
  const root = await dungeonRoot(parameters);
  await enterDungeon({ root, seed: 246 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player.mp = 99;
  run.player_stats.accuracy = 1000;
  run.player_stats.melee_attack = 999;
  run.enemies = [testEnemy({ uid: 'subject_target', name: '火の子鬼', x: 2, y: 1, hp: 99999, speed: 1 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'right' } });
  // Mirrors the companion melee line `${companion.name}が${target}に${dmg}ダメージ`: a
  // protagonist hit (or crit) names 主人公 as the subject, never an anonymous line.
  assert.match(view.log.join('\n'), /主人公(が火の子鬼に\d+ダメージ|の会心の一撃。火の子鬼に\d+ダメージ)/);
});

test('dungeon player action subject is reflected in the companion prompt log summary', async () => {
  const root = await dungeonRoot(parametersWith({ fire: 100 }, { magical_power: 100, academics: 80 }));
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 80 }, { magical_power: 80, agility: 40 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 1;
  run.companion.y = 1;
  run.enemies = [testEnemy({ x: 3, y: 1, hp: 99999, speed: 1 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'fire' } });
  const after = await loadDungeonRun({ root });
  // The single log path puts the subject into both the on-screen log and the
  // prompt's 直近ログ summary, so the LLM sees the protagonist's action attributed.
  assert.match(after.log.join('\n'), /主人公の火魔法。/);
  const context = buildDungeonCompanionPromptTailContext(after);
  assert.match(context, /直近ログ:.*主人公の火魔法/);
});

test('dungeon companion prompt summarizes up to ~30 recent action-log lines, not just a few', async () => {
  const root = await dungeonRoot(parametersWith({ fire: 100 }, { magical_power: 100, academics: 80 }));
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 80 }, { magical_power: 80, agility: 40 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 1;
  run.companion.y = 1;
  run.enemies = [testEnemy({ x: 3, y: 1, hp: 99999, speed: 1 })];
  run.items = [];
  // Seed more than the retention window of prior lines; the run keeps the most
  // recent ~30 (up from the old handful) so the prompt window can fill end-to-end.
  run.log = Array.from({ length: 40 }, (_, index) => `seed-${String(index).padStart(2, '0')}`);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'fire' } });
  const after = await loadDungeonRun({ root });
  // Retention: the run keeps the most recent 30 lines, dropping the oldest seeds.
  assert.equal(after.log.length, 30);
  assert.equal(after.log.includes('seed-00'), false);
  assert.equal(after.log.includes('seed-39'), true);

  // Prompt summary: 直近ログ carries those ~30 recent lines (the old slice took only a few).
  const context = buildDungeonCompanionPromptTailContext(after);
  const recentLogLine = context.split('\n').find((line) => line.startsWith('- 直近ログ:'));
  assert.ok(recentLogLine, '直近ログ line present');
  assert.equal(recentLogLine.replace('- 直近ログ: ', '').split(' / ').length, 30);
});

test('companion spell logs render its magic element in Japanese', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ dark: 100 }, { magical_power: 100, agility: 40 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 3;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 1;
  run.companion.y = 1;
  run.enemies = [testEnemy({ x: 3, y: 1, hp: 999, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const logText = view.log.join('\n');
  assert.match(logText, /テスト同行者の闇魔法/);
  assert.doesNotMatch(logText, /dark魔法/);
});

test('companion AI uses the self-healing spell when badly wounded', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ light: 80, water: 70 }, { magical_power: 60, agility: 40 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.enemies = [];
  run.companion.hp = Math.floor(run.companion.max_hp / 3);
  run.companion.mp = run.companion.max_mp;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const beforeHp = run.companion.hp;
  const beforeMp = run.companion.mp;

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.equal(view.turn, 1);
  assert.equal(view.companion.hp > beforeHp + 1, true, 'companion recovered more than passive HP regeneration');
  assert.equal(view.companion.mp < beforeMp, true, 'companion spent MP on the healing spell');
  assert.match(view.log.join('\n'), /テスト同行者の回復魔法/);
});

test('magic-heavy companion keeps distance instead of meleeing when adjacent', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 3;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.companion.stats.accuracy = 1000;
  run.companion.stats.melee_attack = 999;
  run.enemies = [testEnemy({ uid: 'adjacent_target', x: 4, y: 2, hp: 120, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const target = view.enemies.find((enemy) => enemy.uid === 'adjacent_target');

  assert.equal(view.turn, 2);
  assert.ok(target, 'caster archetype should leave the adjacent enemy alive instead of melee-killing it');
  assert.equal(target.hp, 120, 'caster archetype does not bump-melee the adjacent enemy');
  assert.equal(view.events.some((event) => event.kind === 'melee' && event.from.x === 3 && event.from.y === 2), false);
  assert.notDeepEqual({ x: view.companion.x, y: view.companion.y }, { x: 3, y: 2 }, 'caster archetype moves to open distance');
  assert.equal(manhattanDistance(view.companion, target) > 1, true);
});

test('magic-heavy companion casts at range without moving when line of sight and MP are ready', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ dark: 100 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 2;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.enemies = [testEnemy({ uid: 'range_target', x: 5, y: 2, hp: 120, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const cast = view.events.find((event) => event.kind === 'cast' && event.from.x === 2 && event.from.y === 2);

  assert.ok(cast, 'caster archetype casts from clear range');
  assert.equal(cast.element, 'dark');
  assert.deepEqual({ x: view.companion.x, y: view.companion.y }, { x: 2, y: 2 });
  assert.equal(view.companion.mp < run.companion.max_mp, true);
});

test('magic-heavy cornered caster casts at point blank instead of waiting when it cannot reposition', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 3;
  run.player.y = 1;
  run.player_stats.speed = 100;
  run.companion.x = 1;
  run.companion.y = 1;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.stairs = { x: 1, y: 3 };
  run.enemies = [testEnemy({ uid: 'corner_cast_target', x: 2, y: 1, hp: 500, max_hp: 500, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const target = view.enemies.find((enemy) => enemy.uid === 'corner_cast_target');
  const cast = view.events.find((event) => event.kind === 'cast' && event.from.x === 1 && event.from.y === 1);

  assert.ok(cast, 'cornered caster should use close-range magic before waiting');
  assert.equal(cast.element, 'fire');
  assert.ok(target);
  assert.equal(target.hp < 500, true);
  assert.deepEqual({ x: view.companion.x, y: view.companion.y }, { x: 1, y: 1 });
  assert.equal(view.companion.mp < run.companion.max_mp, true);
});

test('magic-heavy cornered caster bump-melees an adjacent enemy when close casting is unavailable', async () => {
  const companionParameters = parametersWith({ dark: 90, fire: 10 }, { strength: 80, agility: 80, magical_power: 80, academics: 20 });
  const meleeCost = meleeManaCost(companionParameters);
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: companionParameters };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 3;
  run.player.y = 1;
  run.player_stats.speed = 100;
  run.companion.x = 1;
  run.companion.y = 1;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = meleeCost;
  run.companion.mp_reserve_percent = 0; // isolate the pre-reserve melee/cast behavior this test asserts
  run.companion.element = 'fire';
  run.companion.stats.accuracy = 1000;
  run.companion.stats.melee_attack = 999;
  run.stairs = { x: 1, y: 3 };
  run.enemies = [testEnemy({ uid: 'corner_melee_target', x: 2, y: 1, hp: 1, max_hp: 1, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.equal(view.events.some((event) => event.kind === 'cast'), false);
  assert.ok(view.events.find((event) => event.kind === 'melee' && event.from.x === 1 && event.from.y === 1));
  assert.equal(view.enemies.some((enemy) => enemy.uid === 'corner_melee_target'), false);
  assert.equal(view.companion.mp, TURN_MANA_REGEN);
});

test('magic-heavy cornered caster waits only when close casting and adjacent melee are both unavailable', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#####',
    '#...#',
    '#####'
  ]);
  run.player.x = 3;
  run.player.y = 1;
  run.player_stats.speed = 100;
  run.companion.x = 1;
  run.companion.y = 1;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = 0;
  run.stairs = { x: 1, y: 3 };
  run.enemies = [testEnemy({ uid: 'corner_wait_target', x: 2, y: 1, hp: 120, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const target = view.enemies.find((enemy) => enemy.uid === 'corner_wait_target');

  assert.ok(target, 'target remains when no fallback can be paid');
  assert.equal(target.hp, 120);
  assert.deepEqual({ x: view.companion.x, y: view.companion.y }, { x: 1, y: 1 });
  assert.equal(view.events.some((event) => event.kind === 'cast' || event.kind === 'melee'), false);
});

test('caster companion that cannot escape an adjacent chaser commits to combat within bounded turns instead of dancing forever', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 11;
  run.height = 9;
  run.tiles = boxedTiles([
    '###########',
    '#.........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '###########'
  ]);
  // Player tucked in a far corner so the enemy always chases the companion (its
  // nearest target) and re-closes every turn — the open-ground kiting loop.
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.speed = 40;
  run.companion.x = 5;
  run.companion.y = 4;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  // 'chaser' char-sum % 5 == 0 keeps enemySpellReady false on turns 1-4, so the
  // enemy stays in chase mode (re-closing) rather than casting: a clean dance where
  // a score-improving reposition exists every turn yet never yields a cast.
  run.enemies = [testEnemy({ uid: 'chaser', x: 4, y: 4, hp: 9999, max_hp: 9999, speed: 40 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const startEnemyHp = run.enemies[0].hp;
  let movedWhileKiting = false;
  let committed = false;
  let last = { x: run.companion.x, y: run.companion.y };
  for (let i = 0; i < 4; i += 1) {
    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    if (view.companion.x !== last.x || view.companion.y !== last.y) movedWhileKiting = true;
    last = { x: view.companion.x, y: view.companion.y };
    // The player only waits and the enemy cannot cast on these turns, so any cast or
    // companion-melee event is the caster committing to combat.
    if (view.events.some((event) => event.kind === 'cast' || event.kind === 'melee')) committed = true;
  }

  const afterRun = await loadDungeonRun({ root });
  const enemyAfter = afterRun.enemies.find((enemy) => enemy.uid === 'chaser');

  assert.equal(movedWhileKiting, true, 'the caster first tries to kite (repositions) before committing');
  assert.equal(committed, true, 'the caster commits (cast/melee) within bounded turns instead of only repositioning');
  assert.equal(enemyAfter.hp < startEnemyHp, true, 'committing deals damage — the caster no longer dances without contributing');
});

test('caster companion that can hold range keeps casting and is never pushed into a melee commit', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 100, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 9;
  run.height = 5;
  run.tiles = boxedTiles([
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.speed = 100;
  run.companion.x = 2;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.companion.stats.vision_radius = 5;
  // A slow enemy within vision at preferred range with clear LoS: kiting genuinely
  // works, so the loop guard must never pre-empt the ranged casts (no reposition,
  // no melee commit).
  run.enemies = [testEnemy({ uid: 'holds_still', x: 5, y: 2, hp: 9999, max_hp: 9999, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const startEnemyHp = run.enemies[0].hp;
  let casts = 0;
  for (let i = 0; i < 3; i += 1) {
    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    assert.deepEqual({ x: view.companion.x, y: view.companion.y }, { x: 2, y: 2 }, 'caster holds its casting position instead of repositioning');
    assert.equal(view.events.some((event) => event.kind === 'melee'), false, 'caster never bump-melees while it can hold range');
    if (view.events.some((event) => event.kind === 'cast' && event.from.x === 2 && event.from.y === 2)) casts += 1;
  }

  const afterRun = await loadDungeonRun({ root });
  const enemyAfter = afterRun.enemies.find((enemy) => enemy.uid === 'holds_still');

  assert.equal(casts, 3, 'caster casts at range every turn when kiting works');
  assert.equal(enemyAfter.hp < startEnemyHp, true, 'ranged casting steadily damages the enemy');
});

test('caster companion makes a multi-turn approach to preferred range without a premature long-range commit', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 100, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 11;
  run.height = 4;
  run.tiles = boxedTiles([
    '###########',
    '#.........#',
    '#.........#',
    '###########'
  ]);
  // Caster far from a visible, slow target down an open lane: each reposition gains
  // ground (kiting is converging), so even though it takes 3 repositions to reach
  // preferred range, the loop guard must NOT cut the approach into a long-range
  // commit. The progress-based guard (not a turn cap) only fires on a real re-close.
  run.player.x = 1;
  run.player.y = 2;
  run.player_stats.speed = 100;
  run.companion.x = 1;
  run.companion.y = 1;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.companion.stats.vision_radius = 9;
  // uid char-sum % 5 == 0 keeps the enemy from casting on turns 1-4, so the only
  // cast events are the caster's own.
  run.enemies = [testEnemy({ uid: 'farcast', x: 9, y: 1, hp: 9999, max_hp: 9999, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  let firstCastTurn = -1;
  let movesBeforeCast = 0;
  const castDistances = [];
  let last = { x: run.companion.x, y: run.companion.y };
  for (let i = 0; i < 4; i += 1) {
    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    const moved = view.companion.x !== last.x || view.companion.y !== last.y;
    last = { x: view.companion.x, y: view.companion.y };
    for (const event of view.events.filter((e) => e.kind === 'cast')) {
      castDistances.push(manhattanDistance(event.from, event.to));
      if (firstCastTurn === -1) firstCastTurn = i;
    }
    if (firstCastTurn === -1 && moved) movesBeforeCast += 1;
  }

  assert.equal(castDistances.length >= 1, true, 'the caster reaches range and casts');
  assert.equal(castDistances.every((distance) => distance <= 4), true, 'every cast is at preferred range — no premature long-range commit');
  assert.equal(movesBeforeCast >= 3, true, 'a converging approach keeps repositioning past 2 turns instead of being capped');
});

test('magic-heavy companion approaches into spell range when the visible target starts too far away', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 11;
  run.height = 5;
  run.tiles = boxedTiles([
    '###########',
    '#.........#',
    '#.........#',
    '#.........#',
    '###########'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.speed = 100;
  run.player_stats.vision_radius = 8;
  run.companion.x = 2;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.stairs = { x: 9, y: 3 };
  run.enemies = [testEnemy({ uid: 'far_cast_target', x: 8, y: 2, hp: 120, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const firstView = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.deepEqual({ x: firstView.companion.x, y: firstView.companion.y }, { x: 3, y: 2 });

  const secondView = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const target = secondView.enemies.find((enemy) => enemy.uid === 'far_cast_target');

  assert.deepEqual({ x: secondView.companion.x, y: secondView.companion.y }, { x: 4, y: 2 });
  assert.ok(target, 'caster should approach the far target instead of stalling');
  assert.equal(manhattanDistance(secondView.companion, target) <= 4, true);
});

test('magic-heavy companion moves toward a line-of-sight casting position for a wall-obscured target', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.#.#.#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 5;
  run.player.y = 3;
  run.player_stats.speed = 100;
  run.companion.x = 1;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.companion.stats.vision_radius = 6;
  run.stairs = { x: 5, y: 1 };
  run.enemies = [testEnemy({ uid: 'hidden_cast_target', x: 5, y: 2, hp: 120, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.equal(view.action_error, undefined);
  assert.deepEqual({ x: view.companion.x, y: view.companion.y }, { x: 1, y: 3 });
  assert.equal(view.events.some((event) => event.kind === 'cast' || event.kind === 'melee'), false);
});

test('magic-heavy companion repositions instead of charging when casting is unavailable', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 5;
  run.companion.x = 3;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = 0;
  run.enemies = [testEnemy({ uid: 'dry_target', x: 5, y: 2, hp: 120, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const beforeDistance = manhattanDistance(run.companion, run.enemies[0]);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const target = view.enemies.find((enemy) => enemy.uid === 'dry_target');

  assert.equal(view.action_error, undefined);
  assert.equal(view.turn, 2);
  assert.ok(target, 'caster archetype should not melee-kill while unable to cast');
  assert.equal(target.hp, 120);
  assert.equal(view.events.some((event) => event.kind === 'melee' || event.kind === 'cast'), false);
  assert.equal(manhattanDistance(view.companion, target) > beforeDistance, true, 'caster archetype opens distance instead of closing to melee');
});

test('magic-heavy companion reposition does not push or swap the player off its cell (AI never moves the player)', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 2;
  run.player.y = 2;
  run.player_stats.vision_radius = 5;
  run.companion.x = 3;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = 0;
  // The enemy is on the companion's far side, so opening distance points back toward the player's
  // tile (2,2). The companion must NOT take that cell (no swap) — it picks a free non-player cell
  // and leaves the player exactly where it stood.
  run.enemies = [testEnemy({ uid: 'swap_escape_target', x: 4, y: 2, hp: 120, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.deepEqual({ x: view.player.x, y: view.player.y }, { x: 2, y: 2 }, 'the player is not pushed/swapped off its cell by the companion AI');
  assert.notDeepEqual({ x: view.companion.x, y: view.companion.y }, { x: 2, y: 2 }, 'the companion does not step onto the player tile');
  assert.notDeepEqual({ x: view.companion.x, y: view.companion.y }, { x: 3, y: 2 }, 'the companion still repositions (gives up the player cell, takes a free one)');
});

test('a companion whose only opening cell is the player gives it up (no AI swap, no softlock)', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 3;
  run.height = 5;
  // A 1-wide vertical corridor: player above the companion, enemy below it. The companion's only
  // walkable non-enemy neighbor is the player's tile, so the (now removed) AI swap would have pushed
  // the player up. With the swap gone the companion gives up that cell and falls back in place; the
  // player must stay put and the turn must resolve (no softlock).
  run.tiles = boxedTiles([
    '###',
    '#.#',
    '#.#',
    '#.#',
    '###'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 5;
  run.companion.x = 1;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = 0;
  run.enemies = [testEnemy({ uid: 'corridor_target', x: 1, y: 3, hp: 120, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.equal(view.action_error, undefined, 'the turn resolves without a softlock');
  assert.deepEqual({ x: view.player.x, y: view.player.y }, { x: 1, y: 1 }, 'the player is not pushed off its cell even when it is the only escape cell');
  assert.notDeepEqual({ x: view.companion.x, y: view.companion.y }, { x: 1, y: 1 }, 'the companion never lands on the player tile');
});

test('magic-heavy companion reposition does not move onto the stairs when opening distance', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player_stats.vision_radius = 5;
  run.companion.x = 3;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = 0;
  run.stairs = { x: 2, y: 2 };
  run.enemies = [testEnemy({ uid: 'stairs_escape_target', x: 4, y: 2, hp: 120, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.notDeepEqual({ x: view.companion.x, y: view.companion.y }, run.stairs);
  assert.equal(manhattanDistance(view.companion, view.enemies.find((enemy) => enemy.uid === 'stairs_escape_target')) > 1, true);
  assert.equal(view.events.some((event) => event.kind === 'melee' || event.kind === 'cast'), false);
});

test('physical-or-equal companion keeps the existing adjacent melee behavior', async () => {
  const companionParameters = parametersWith({ fire: 50 }, { strength: 50, agility: 50, magical_power: 20, academics: 20 });
  const cost = meleeManaCost(companionParameters);
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: companionParameters };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 3;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = cost + 2;
  run.companion.mp_reserve_percent = 0; // isolate the pre-reserve melee behavior this test asserts
  run.companion.stats.accuracy = 1000;
  run.companion.stats.melee_attack = 999;
  run.enemies = [testEnemy({ uid: 'equal_target', x: 4, y: 2, hp: 1, speed: 60 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.equal(view.enemies.some((enemy) => enemy.uid === 'equal_target'), false);
  assert.ok(view.events.find((event) => event.kind === 'melee' && event.from.x === 3 && event.from.y === 2));
  assert.equal(view.companion.mp, cost + 2 - cost + 1);
});

test('companion AI archetype fails fast when required physical or magic mastery values are missing', async () => {
  for (const missing of ['strength', 'agility', 'fire']) {
    const root = await dungeonRoot();
    const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
    await enterDungeon({ root, seed: 246, companion });

    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    if (missing === 'fire') delete run.companion.parameters.magic.fire;
    else delete run.companion.parameters.abilities[missing];
    run.turn = 1;
    run.width = 7;
    run.height = 5;
    run.tiles = boxedTiles([
      '#######',
      '#.....#',
      '#.....#',
      '#.....#',
      '#######'
    ]);
    run.player.x = 1;
    run.player.y = 1;
    run.companion.x = 3;
    run.companion.y = 2;
    run.enemies = [testEnemy({ uid: 'contract_target', x: 5, y: 2, hp: 120, speed: 60 })];
    run.items = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

    await assert.rejects(
      () => dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } }),
      new RegExp(missing === 'fire' ? 'magic\\.fire is required for companion AI archetype' : `abilities\\.${missing} is required for companion AI archetype`)
    );
  }
});

test('companion melee spends the same MP cost and waits instead of attacking when it cannot pay', async () => {
  const companionParameters = parametersWith({}, { strength: 50, agility: 50, magical_power: 20, academics: 20 });
  const cost = meleeManaCost(companionParameters);
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: companionParameters };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.companion.x = 2;
  run.companion.y = 1;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = cost + 2;
  run.companion.mp_reserve_percent = 0; // isolate the pre-reserve "can/cannot pay melee" behavior this test asserts
  run.companion.stats.accuracy = 1000;
  run.companion.stats.melee_attack = 999;
  run.enemies = [testEnemy({ uid: 'companion_target', x: 3, y: 1, hp: 1, speed: run.player_stats.speed })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const hit = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(hit.turn, 1);
  assert.equal(hit.companion.mp, cost + 2 - cost + 1);
  assert.equal(hit.enemies.some((enemy) => enemy.uid === 'companion_target'), false);
  assert.match(hit.log.join('\n'), /テスト同行者が澱みスライムに/);

  const lowMpState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  lowMpState.dungeon_run.player.x = 1;
  lowMpState.dungeon_run.player.y = 1;
  lowMpState.dungeon_run.companion.x = 2;
  lowMpState.dungeon_run.companion.y = 1;
  lowMpState.dungeon_run.companion.hp = lowMpState.dungeon_run.companion.max_hp;
  lowMpState.dungeon_run.companion.mp = 0;
  lowMpState.dungeon_run.enemies = [testEnemy({ uid: 'unpaid_companion_target', x: 3, y: 1, hp: 120, attack: 1, speed: lowMpState.dungeon_run.player_stats.speed })];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', lowMpState);

  const waited = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(waited.turn, 2);
  assert.equal(waited.enemies.find((enemy) => enemy.uid === 'unpaid_companion_target').hp, 120);
  assert.equal(waited.companion.mp, 1, 'the companion did not spend unpaid melee MP and only received valid-turn regeneration');
  assert.equal(waited.events.some((event) => event.kind === 'melee' && event.from.x === 2 && event.from.y === 1), false);
});

test('the companion MP reserve line is read from the surface at entry and snapshot onto the run (mid-run surface change is ignored)', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ dark: 100 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await writeJson(root, 'data/mutable/game_data/mp_reserve.json', { version: 1, reserves: { character_016: 65 } });
  await enterDungeon({ root, seed: 246, companion });

  const entered = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(entered.dungeon_run.companion.mp_reserve_percent, 65, 'entry snapshot reads the surface line');

  // A conversation changing the line mid-run must not touch the in-progress run (entry-snapshot rule).
  await writeJson(root, 'data/mutable/game_data/mp_reserve.json', { version: 1, reserves: { character_016: 10 } });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 5; run.height = 5;
  run.tiles = boxedTiles(['#####', '#...#', '#...#', '#...#', '#####']);
  run.player.x = 1; run.player.y = 1;
  run.companion.x = 2; run.companion.y = 2;
  run.enemies = [];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const after = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(after.dungeon_run.companion.mp_reserve_percent, 65, 'the active run keeps its entry line');
  assert.ok(view);
});

test('a caster companion at/below its MP reserve line does not cast (it repositions), and casts once above the line', async () => {
  const buildRun = async (reservePercent) => {
    const root = await dungeonRoot();
    const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ dark: 100 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
    await enterDungeon({ root, seed: 246, companion });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    run.turn = 1;
    run.width = 7; run.height = 5;
    run.tiles = boxedTiles(['#######', '#.....#', '#.....#', '#.....#', '#######']);
    run.player.x = 1; run.player.y = 1;
    run.companion.x = 2; run.companion.y = 2;
    run.companion.hp = run.companion.max_hp; // full HP → no self-heal, so the attack gate is what is tested
    run.companion.mp = run.companion.max_mp; // full MP, so only the reserve line (not affordability) can gate it
    run.companion.mp_reserve_percent = reservePercent;
    run.enemies = [testEnemy({ uid: 'reserve_caster_target', x: 5, y: 2, hp: 120, speed: 60 })];
    run.items = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
    return dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  };

  // Reserve 100%: full MP is still "at/below" the line, so the caster holds its MP — no cast (no damage),
  // and no attack MP is spent. It repositions instead of committing (the existing cornered/kite discipline).
  const reserved = await buildRun(100);
  assert.equal(reserved.events.some((event) => event.kind === 'cast'), false, 'a reserved caster does not cast');
  assert.equal(reserved.companion.mp, reserved.companion.max_mp, 'no attack MP was spent (only capped regen)');

  // Reserve 0%: identical geometry casts at range (the pre-reserve behavior boundary).
  const attacking = await buildRun(0);
  assert.ok(attacking.events.find((event) => event.kind === 'cast' && event.from.x === 2 && event.from.y === 2), 'a line-0 caster casts as before');
});

test('a melee companion at/below its MP reserve line does not bump (見送り), and bumps once above the line', async () => {
  const buildRun = async (reservePercent) => {
    const companionParameters = parametersWith({ fire: 50 }, { strength: 50, agility: 50, magical_power: 20, academics: 20 });
    const root = await dungeonRoot();
    const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: companionParameters };
    await enterDungeon({ root, seed: 246, companion });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    run.turn = 1;
    run.width = 5; run.height = 5;
    run.tiles = boxedTiles(['#####', '#...#', '#...#', '#...#', '#####']);
    run.player.x = 1; run.player.y = 2;
    run.companion.x = 2; run.companion.y = 1;
    run.companion.hp = run.companion.max_hp;
    run.companion.mp = run.companion.max_mp;
    run.companion.mp_reserve_percent = reservePercent;
    run.companion.stats.accuracy = 1000;
    run.companion.stats.melee_attack = 999;
    run.enemies = [testEnemy({ uid: 'reserve_melee_target', x: 3, y: 1, hp: 1, attack: 0, speed: 0 })];
    run.items = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
    return dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  };

  const reserved = await buildRun(100);
  assert.equal(reserved.events.some((event) => event.kind === 'melee'), false, 'a reserved melee does not bump');
  assert.equal(reserved.enemies.some((enemy) => enemy.uid === 'reserve_melee_target'), true, 'the adjacent enemy survives (no attack)');

  const attacking = await buildRun(0);
  assert.ok(attacking.events.find((event) => event.kind === 'melee' && event.from.x === 2 && event.from.y === 1), 'a line-0 melee bumps as before');
  assert.equal(attacking.enemies.some((enemy) => enemy.uid === 'reserve_melee_target'), false, 'the enemy is defeated');
});

test('a companion below its MP reserve line still self-heals (the reserve exists to keep MP for healing)', async () => {
  const companionParameters = parametersWith({ light: 80, water: 80 }, { strength: 30, agility: 30, magical_power: 40, academics: 20 });
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: companionParameters };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 5; run.height = 5;
  run.tiles = boxedTiles(['#####', '#...#', '#...#', '#...#', '#####']);
  run.player.x = 1; run.player.y = 1;
  run.companion.x = 2; run.companion.y = 2;
  run.companion.max_hp = 40;
  run.companion.hp = 10; // at/below half → self-heal is preferred, and it is exempt from the reserve line
  run.companion.mp = run.companion.max_mp;
  run.companion.mp_reserve_percent = 100; // fully reserved: attacks are off, but self-heal is not
  run.enemies = [testEnemy({ uid: 'reserve_heal_bystander', x: 4, y: 2, hp: 120, attack: 0, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(view.companion.hp > 10, true, 'a reserved companion still spends MP on self-heal');
  assert.equal(view.companion.mp < run.companion.max_mp, true, 'self-heal MP was spent under the reserve line');
  assert.equal(view.events.some((event) => event.kind === 'cast' || event.kind === 'melee'), false, 'no attack was made');
});

test('a cornered caster below its MP reserve line falls through to a clean wait (cast + bump both held, no softlock / action_error)', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 5; run.height = 5;
  // Row-1 corridor: the companion at (1,1) is walled on three sides with the enemy on the fourth, so no
  // reposition can improve its score (the same cornered geometry the pre-reserve cornered/wait test uses).
  run.tiles = boxedTiles(['#####', '#...#', '#####', '#...#', '#####']);
  run.player.x = 3; run.player.y = 1;
  run.player_stats.speed = 100;
  run.companion.x = 1; run.companion.y = 1;
  run.companion.hp = run.companion.max_hp; // full HP → no self-heal, isolating the attack gate
  run.companion.mp = run.companion.max_mp; // full MP → only the reserve line (not affordability) blocks it
  run.companion.mp_reserve_percent = 100; // fully reserved
  run.stairs = { x: 1, y: 3 };
  run.enemies = [testEnemy({ uid: 'reserve_corner_target', x: 2, y: 1, hp: 120, attack: 0, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  // Below the line + cornered: cast is blocked, the point-blank bump is held for reserve, no reposition
  // improves score → it commits to a clean wait (the existing cornered/can't-pay discipline, unregressed).
  assert.equal(view.events.some((event) => event.kind === 'cast' || event.kind === 'melee'), false);
  assert.equal(view.enemies.find((enemy) => enemy.uid === 'reserve_corner_target').hp, 120, 'enemy untouched');
  assert.deepEqual({ x: view.companion.x, y: view.companion.y }, { x: 1, y: 1 }, 'companion held its cell (waited)');
  assert.equal(view.companion.mp, run.companion.max_mp, 'no attack MP was spent under the reserve line');
  assert.equal(view.action_error ?? null, null, 'a held attack is 見送り, never an action_error');
});

test('a run companion snapshot missing / out-of-range mp_reserve_percent fails fast on its turn', async () => {
  for (const badValue of [undefined, 4.5, 101, -1]) {
    const root = await dungeonRoot();
    const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ dark: 100 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
    await enterDungeon({ root, seed: 246, companion });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const run = state.dungeon_run;
    run.turn = 1;
    run.width = 5; run.height = 5;
    run.tiles = boxedTiles(['#####', '#...#', '#...#', '#...#', '#####']);
    run.player.x = 1; run.player.y = 1;
    run.companion.x = 2; run.companion.y = 2;
    run.companion.hp = run.companion.max_hp;
    if (badValue === undefined) delete run.companion.mp_reserve_percent;
    else run.companion.mp_reserve_percent = badValue;
    run.enemies = [testEnemy({ uid: 'reserve_corrupt_target', x: 4, y: 2, hp: 120, speed: 60 })];
    run.items = [];
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

    await assert.rejects(
      () => dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } }),
      /mp_reserve_percent snapshot must be an integer/
    );
  }
});

test('enemy melee remains unchanged and does not require MP', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 50, agility: 50, magical_power: 20, academics: 20 }));
  await enterDungeon({ root, seed: 246 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.width = 5;
  run.height = 5;
  run.tiles = boxedTiles([
    '#####',
    '#...#',
    '#...#',
    '#...#',
    '#####'
  ]);
  run.player.x = 1;
  run.player.y = 1;
  run.player.hp = run.player.max_hp;
  const beforeHp = run.player.hp;
  const enemy = testEnemy({ uid: 'mp_less_enemy', x: 2, y: 1, hp: 120, attack: 30, speed: run.player_stats.speed });
  enemy.accuracy = 1000;
  run.enemies = [enemy];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  assert.equal(view.turn, 1);
  assert.ok(view.events.find((event) => event.kind === 'enemy_attack' && event.from.x === 2 && event.from.y === 1));
  assert.equal(view.player.hp < beforeHp, true);
});

test('wait-only companion support cannot clean out first-floor enemy mixes by itself', async () => {
  for (const seed of [1, 2, 3, 42, 246]) {
    const root = await dungeonRoot();
    const companion = {
      character_id: 'character_016',
      name: 'テスト同行者',
      parameters: parametersWith({ fire: 72 }, { strength: 40, magical_power: 60, agility: 52, academics: 64, charisma: 58 })
    };
    await enterDungeon({ root, seed, companion });
    let ended = null;
    for (let i = 0; i < 8; i += 1) {
      const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
      if (view.ended) {
        ended = view;
        break;
      }
    }
    if (ended) {
      assert.equal(ended.status, 'dead', `seed ${seed}: wait-only pressure should only end by player defeat`);
    } else {
      const run = await loadDungeonRun({ root });
      assert.equal(run.enemies.some((enemy) => enemy.hp > 0), true, `seed ${seed}: a companion acting alone should not clear the rebased first floor in eight waits`);
    }
  }
});

test('high-output player spell support survives and makes progress on rebased first-floor pressure', async () => {
  for (const seed of [1, 42, 246]) {
    const root = await dungeonRoot(parametersWith({ water: 90 }, { strength: 90, magical_power: 90, agility: 90, academics: 90, charisma: 40 }));
    const companion = {
      character_id: 'character_016',
      name: 'テスト同行者',
      parameters: parametersWith({ fire: 90 }, { strength: 90, magical_power: 90, agility: 90, academics: 90, charisma: 58 })
    };
    await enterDungeon({ root, seed, companion });
    // The floor is larger than the player's vision, so the seeded enemies spawn beyond the
    // entrance and the player would walk up to them before casting. Model that approach by
    // gathering the naturally-spawned roster (its seeded count and scaled stats unchanged)
    // into the cells the player can see, so the pressure check exercises the real enemies
    // regardless of map size.
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const spawned = state.dungeon_run;
    const visibleCells = [];
    for (let y = 0; y < spawned.height; y += 1) {
      for (let x = 0; x < spawned.width; x += 1) {
        if (spawned.tiles[y][x] !== TILE_FLOOR) continue;
        if (x === spawned.player.x && y === spawned.player.y) continue;
        if (Math.abs(x - spawned.player.x) + Math.abs(y - spawned.player.y) <= 1) continue;
        if (Math.max(Math.abs(x - spawned.player.x), Math.abs(y - spawned.player.y)) <= spawned.player_stats.vision_radius) {
          visibleCells.push({ x, y });
        }
      }
    }
    assert.equal(visibleCells.length >= spawned.enemies.length, true, `seed ${seed}: needs one visible floor cell per spawned enemy`);
    spawned.enemies.forEach((enemy, index) => { enemy.x = visibleCells[index].x; enemy.y = visibleCells[index].y; });
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

    // The player supports with water while MP lasts and a target is in view, and waits otherwise to
    // keep the floor under pressure so the fire companion finishes — a finite real run rather than
    // infinite MP. Rebased enemies fall fast, so a surviving one can wander out of sight; the support
    // casts only when a visible enemy remains (so never no_target) and only while MP allows (so never
    // insufficient_mp), so every turn resolves without an action error.
    let run = await loadDungeonRun({ root });
    let waterCost = null;
    let targetInView = true; // every spawned enemy was gathered into the player's vision above
    for (let i = 0; i < 16 && run.enemies.some((enemy) => enemy.hp > 0); i += 1) {
      const canCast = targetInView && (waterCost === null || run.player.mp >= waterCost);
      const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: canCast ? { type: 'cast', element: 'water' } : { type: 'wait' } });
      if (canCast && waterCost === null) waterCost = view.castable_elements.find((spell) => spell.element === 'water').mp_cost;
      assert.equal(view.action_error, undefined, `seed ${seed}: support turn should resolve (cast only with a visible target, else wait)`);
      assert.equal(view.active, true, `seed ${seed}: high-output player support should survive turn ${i + 1}`);
      targetInView = view.enemies.some((enemy) => enemy.hp > 0);
      run = await loadDungeonRun({ root });
    }
    assert.equal(run.player.hp > 0, true, `seed ${seed}: player involvement should not require a wipe`);
    assert.equal(run.companion.down, false, `seed ${seed}: player involvement should not require a companion wipe`);
    assert.equal(run.enemies.some((enemy) => enemy.hp <= 0), true, `seed ${seed}: high-output water support should defeat at least one rebased first-floor enemy`);
  }
});

test('lower-output player support no longer survives a controlled rebased first-floor pressure check', async () => {
  const root = await dungeonRoot(parametersWith({ water: 28 }, { strength: 28, magical_power: 28, agility: 28, academics: 28, charisma: 20 }));
  const companion = {
    character_id: 'character_016',
    name: 'テスト同行者',
    parameters: parametersWith({ fire: 72 }, { strength: 40, magical_power: 60, agility: 52, academics: 64, charisma: 58 })
  };
  await enterDungeon({ root, seed: 1, companion });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  const visibleCells = [];
  for (let y = 0; y < run.height; y += 1) {
    for (let x = 0; x < run.width; x += 1) {
      if (run.tiles[y][x] !== TILE_FLOOR) continue;
      if (x === run.player.x && y === run.player.y) continue;
      if (Math.abs(x - run.player.x) + Math.abs(y - run.player.y) <= 1) continue;
      const distance = Math.max(Math.abs(x - run.player.x), Math.abs(y - run.player.y));
      if (distance <= run.player_stats.vision_radius) visibleCells.push({ x, y, distance });
    }
  }
  visibleCells.sort((a, b) => a.distance - b.distance);
  const pressureArchetypes = enemyArchetypes.slice(0, visibleCells.length);
  assert.equal(pressureArchetypes.length >= enemyCountForFloor(1), true, 'controlled pressure check needs at least one generated first-floor wave of visible enemies');
  run.enemies = pressureArchetypes.map((archetype, index) => {
    const stats = scaledEnemyStats(archetype, 1);
    const cell = visibleCells[index];
    return {
      uid: `e${index + 1}`,
      archetype_id: archetype.id,
      name: archetype.name,
      element: archetype.element,
      glyph: archetype.glyph,
      x: cell.x,
      y: cell.y,
      hp: stats.max_hp,
      max_hp: stats.max_hp,
      attack: stats.attack,
      defense: stats.defense,
      speed: stats.speed
    };
  });
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  let ended = null;
  for (let i = 0; i < 5; i += 1) {
    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'water' } });
    if (view.ended) {
      ended = view;
      break;
    }
  }
  assert.ok(ended, 'lower-output support should be defeated by the rebased first-floor pressure');
  assert.equal(ended.status, 'dead');
});

test('rebased final-floor enemy scaling stays survivable only for capped active player support', async () => {
  for (const seed of [1, 42, 246]) {
    const root = await dungeonRoot(parametersWith({ water: 100 }, { strength: 100, magical_power: 100, agility: 100, academics: 100, charisma: 40 }));
    const companion = {
      character_id: 'character_016',
      name: 'テスト同行者',
      parameters: parametersWith({ fire: 100 }, { strength: 100, magical_power: 100, agility: 100, academics: 100, charisma: 58 })
    };
    await enterDungeon({ root, seed, companion });
    let run = null;
    for (let floor = 1; floor < MAX_FLOORS; floor += 1) {
      const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
      run = state.dungeon_run;
      run.player.x = run.stairs.x;
      run.player.y = run.stairs.y;
      await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
      const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'descend' } });
      assert.equal(view.active, true, `seed ${seed}: controlled descent to floor ${floor + 1} should keep the run active`);
    }

    run = await loadDungeonRun({ root });
    for (let i = 0; i < 8 && run.enemies.some((enemy) => enemy.hp > 0); i += 1) {
      let view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'water' } });
      if (view.action_error === 'no_target' || view.action_error === 'insufficient_mp') {
        view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
      }
      assert.equal(view.active, true, `seed ${seed}: capped active support should survive floor ${MAX_FLOORS} action ${i + 1}`);
      assert.equal(view.player.hp > 0, true, `seed ${seed}: capped active support should keep the player alive`);
      run = await loadDungeonRun({ root });
    }
    assert.equal(run.player.hp > 0, true, `seed ${seed}: capped active support should survive floor ${MAX_FLOORS} pressure`);
    assert.equal(run.companion.down, false, `seed ${seed}: floor ${MAX_FLOORS} pressure should not require a companion wipe`);
    assert.equal(run.enemies.some((enemy) => enemy.hp > 0), true, `seed ${seed}: floor ${MAX_FLOORS} should remain threatening after eight actions`);
  }
});

test('moving into the companion swaps places instead of being blocked (no path trap)', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith() };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.enemies = []; // isolate the swap from combat/enemy turns
  run.items = [];
  const px = run.player.x;
  const py = run.player.y;
  // Put the companion on a walkable tile next to the player and move toward it.
  // A connected floor guarantees the player's tile has at least one floor neighbor.
  const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  let chosen = null;
  for (const [direction, [dx, dy]] of Object.entries(dirs)) {
    const nx = px + dx;
    const ny = py + dy;
    if (ny >= 0 && nx >= 0 && ny < run.height && nx < run.width && run.tiles[ny][nx] === TILE_FLOOR) {
      chosen = { direction, nx, ny };
      break;
    }
  }
  assert.ok(chosen, 'the player tile should have a walkable neighbor on a connected floor');
  run.companion.x = chosen.nx;
  run.companion.y = chosen.ny;
  run.companion.down = false;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: chosen.direction } });
  assert.equal(view.action_error, undefined, 'moving into a companion is a valid action, not an error');
  // The player took the companion's tile; the companion took the player's old tile.
  assert.equal(view.player.x, chosen.nx);
  assert.equal(view.player.y, chosen.ny);
  assert.equal(view.companion.x, px);
  assert.equal(view.companion.y, py);
});

test('moving into a caster companion cannot be swapped back by same-turn reposition', async () => {
  const root = await dungeonRoot();
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 90 }, { strength: 10, agility: 10, magical_power: 80, academics: 20 }) };
  await enterDungeon({ root, seed: 246, companion });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.turn = 1;
  run.width = 7;
  run.height = 5;
  run.tiles = boxedTiles([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######'
  ]);
  run.player.x = 2;
  run.player.y = 2;
  run.player_stats.speed = 100;
  run.companion.x = 3;
  run.companion.y = 2;
  run.companion.hp = run.companion.max_hp;
  run.companion.mp = run.companion.max_mp;
  run.enemies = [testEnemy({ uid: 'swap_undo_target', x: 2, y: 1, hp: 120, speed: 0 })];
  run.items = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'right' } });

  assert.equal(view.action_error, undefined);
  assert.deepEqual({ x: view.player.x, y: view.player.y }, { x: 3, y: 2 });
  assert.notDeepEqual({ x: view.companion.x, y: view.companion.y }, { x: 3, y: 2 });
});

test('dungeon actions report structured combat events (cast / melee / enemy attack), not persisted', async () => {
  const root = await dungeonRoot(parametersWith({ water: 60 }, { strength: 40, magical_power: 60, agility: 40, academics: 60, charisma: 20 }));
  await enterDungeon({ root, seed: 5 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  // A tanky enemy planted right of the player: in vision (cast target) and adjacent (it attacks
  // back and can be bumped). High HP so it survives across the asserted turns.
  const ex = run.player.x + 1;
  const ey = run.player.y;
  run.tiles[ey][ex] = 'floor';
  run.enemies = [{ uid: 'e1', archetype_id: 'stone_golem', name: '石塊ゴーレム', element: 'earth', glyph: 'G', x: ex, y: ey, hp: 999, max_hp: 999, attack: 7, defense: 2, speed: 60 }];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  // cast: a cast event from the player to the enemy tile, tinted by element; the adjacent enemy
  // attacks back -> an enemy_attack event toward the player.
  const castView = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'cast', element: 'water' } });
  const cast = castView.events.find((e) => e.kind === 'cast');
  assert.ok(cast, 'a cast event is reported');
  assert.equal(cast.element, 'water');
  assert.deepEqual(cast.from, { x: run.player.x, y: run.player.y }, 'cast originates at the caster');
  assert.deepEqual(cast.to, { x: ex, y: ey }, 'cast targets the enemy tile');
  const atk = castView.events.find((e) => e.kind === 'enemy_attack');
  assert.ok(atk, 'the adjacent enemy attack is reported');
  assert.deepEqual(atk.to, { x: run.player.x, y: run.player.y }, 'enemy attack targets the player');

  // melee bump: moving into the enemy reports a melee event from the player to the enemy.
  const bumpView = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'move', direction: 'right' } });
  const melee = bumpView.events.find((e) => e.kind === 'melee');
  assert.ok(melee, 'a melee event is reported on a bump attack');
  assert.deepEqual(melee.to, { x: ex, y: ey }, 'melee targets the bumped enemy tile');

  // events are render-only: a plain state read carries none (not persisted to runtime_state).
  const stateView = await getDungeonView({ root });
  assert.deepEqual(stateView.events, [], 'turn events are not persisted into state reads');
});

test('a run-ending fatal blow still reports its combat event on the ended result', async () => {
  const root = await dungeonRoot(parametersWith({}, { strength: 20, magical_power: 20, agility: 5, academics: 30, charisma: 20 }));
  await enterDungeon({ root, seed: 9 });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  run.player.hp = 1; // a single connecting hit ends the run
  const ex = run.player.x + 1;
  const ey = run.player.y;
  run.tiles[ey][ex] = 'floor';
  run.enemies = [{ uid: 'e1', archetype_id: 'stone_golem', name: '石塊ゴーレム', element: 'earth', glyph: 'G', x: ex, y: ey, hp: 999, max_hp: 999, attack: 99, defense: 0, speed: 200, accuracy: 999 }];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  let ended = null;
  for (let i = 0; i < 8; i += 1) {
    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    if (view.ended) { ended = view; break; }
  }
  assert.ok(ended, 'the adjacent attacker ends the run');
  assert.equal(ended.status, 'dead');
  const fatal = (ended.events ?? []).find((e) => e.kind === 'enemy_attack');
  assert.ok(fatal, 'the fatal enemy attack is reported on the ended result so the frontend can play it');
  assert.deepEqual(fatal.to, { x: run.player.x, y: run.player.y }, 'the fatal blow targets the player');
});

// ----- deferred companion finalize (run end split) -----

import { dungeonFinalizeRun, prepareDungeonRun, commitEnteredRun } from '../src/dungeon/dungeonEngine.mjs';

function companionWithConversation(conversationId = 'conv_dungeon_dr_321') {
  return { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 60 }, { strength: 40, magical_power: 40, agility: 30 }), conversation_id: conversationId };
}

test('a companion run end defers the finalize: the action returns a preview and the run is held, not banked or cleared', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 321, companion: companionWithConversation() });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  const preview = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(preview.ended, true);
  assert.equal(preview.pending_finalize, true, 'a companion run end is deferred (preview, not committed)');
  assert.equal(preview.status, 'retreated');
  assert.equal(preview.applied_gains.abilities.strength, 6, 'the preview shows the gains that will be banked');

  // Held, not committed: the run is still present (marked finalizing) and nothing is banked.
  const held = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.notEqual(held.dungeon_run, null, 'the run is held until the deferred finalize commits');
  assert.deepEqual(held.dungeon_run.pending_finalize, { outcome: 'retreated' });
  const params = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');
  assert.equal(params.abilities.strength.value, before.abilities.strength.value, 'gains are not banked until the deferred finalize');

  // A finalizing run takes no further play actions, and the view reports it as inactive-with-marker.
  await assert.rejects(dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } }), (error) => error.statusCode === 409);
  const view = await getDungeonView({ root });
  assert.equal(view.active, false);
  assert.deepEqual(view.pending_finalize, { outcome: 'retreated' });
});

test('dungeonFinalizeRun runs finalize FIRST, then banks and clears the run', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 321, companion: companionWithConversation() });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');
  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });

  const calls = [];
  const finalizeCompanion = async (args) => {
    // Ordering proof: finalize observes the run still present (not yet cleared/banked).
    const mid = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    calls.push({ args, runStillPresent: mid.dungeon_run != null });
  };
  const result = await dungeonFinalizeRun({ root, postDungeonScreen: 'academy-room', finalizeCompanion });
  assert.equal(result.ended, true);
  assert.equal(result.pending_finalize, false);
  assert.equal(result.status, 'retreated');
  assert.equal(result.total_applied > 0, true);
  assert.equal(calls.length, 1, 'the companion conversation is finalized exactly once');
  assert.deepEqual(calls[0].args, { conversationId: 'conv_dungeon_dr_321', characterId: 'character_016' });
  assert.equal(calls[0].runStillPresent, true, 'finalize runs before the run is banked/cleared');

  const after = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(after.dungeon_run, null, 'the run is cleared after the deferred finalize');
  assert.equal(after.current_screen, 'academy-room');
  const params = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(params.abilities.strength.value > before.abilities.strength.value, true, 'gains bank on the deferred finalize');
});

test('a failed deferred finalize leaves the run intact and unbanked (no half-confirmed result)', async () => {
  const root = await dungeonRoot();
  await enterDungeon({ root, seed: 321, companion: companionWithConversation() });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');
  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });

  const failing = async () => { throw new Error('finalize boom'); };
  await assert.rejects(dungeonFinalizeRun({ root, postDungeonScreen: 'academy-room', finalizeCompanion: failing }), /finalize boom/);

  const after = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.notEqual(after.dungeon_run, null, 'a failed finalize leaves the run held (retryable)');
  assert.deepEqual(after.dungeon_run.pending_finalize, { outcome: 'retreated' });
  const params = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');
  assert.equal(params.abilities.strength.value, before.abilities.strength.value, 'a failed finalize banks nothing');

  // Retry succeeds and commits.
  const retry = await dungeonFinalizeRun({ root, postDungeonScreen: 'academy-room', finalizeCompanion: async () => {} });
  assert.equal(retry.status, 'retreated');
  const settled = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(settled.dungeon_run, null);
});

test('dungeonFinalizeRun fails fast when no run is awaiting finalize', async () => {
  const root = await dungeonRoot();
  await assert.rejects(dungeonFinalizeRun({ root, postDungeonScreen: 'academy-room', finalizeCompanion: async () => {} }), (error) => error.statusCode === 409);
});

test('dungeon deferred finalize requires an explicit post-content screen', async () => {
  const root = await dungeonRoot();
  await assert.rejects(
    () => dungeonFinalizeRun({ root, finalizeCompanion: async () => {} }),
    /postDungeonScreen is required/
  );
});

test('a solo run end still commits synchronously (no companion to finalize, no deferral)', async () => {
  const root = await dungeonRoot();
  const run = await prepareDungeonRun({ root, seed: 321 });
  await commitEnteredRun({ root, run });
  const result = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(result.ended, true);
  assert.equal(result.pending_finalize, false, 'a solo run end is not deferred');
  const after = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(after.dungeon_run, null, 'a solo run clears immediately');
});

test('a deferred preview is clamped to what will actually bank — no overstated gains at the 100 cap', async () => {
  // strength already at 99: a +6 pending gain can only bank +1 (clamped to 100). The preview must
  // show +1 (the real banked delta), not the unclamped +6.
  const root = await dungeonRoot(parametersWith({}, { strength: 99, agility: 40, academics: 30, magical_power: 30, charisma: 20 }));
  await enterDungeon({ root, seed: 321, companion: companionWithConversation() });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const preview = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(preview.pending_finalize, true);
  assert.equal(preview.applied_gains.abilities.strength, 1, 'preview is clamped to the 100 cap, not the unclamped +6');

  // The held view exposes the same clamped preview, so a resumed exit shows the same gains.
  const view = await getDungeonView({ root });
  assert.equal(view.applied_gains_preview.abilities.strength, 1);

  // The deferred finalize banks exactly what the preview promised.
  const final = await dungeonFinalizeRun({ root, postDungeonScreen: 'academy-room', finalizeCompanion: async () => {} });
  assert.deepEqual(final.applied_gains, preview.applied_gains, 'the finalize banks exactly the previewed (clamped) gains');
  const banked = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(banked.abilities.strength.value, 100, 'strength banks to the 100 cap, matching the +1 preview');
});

async function writeEquipmentSurface(root, instances) {
  await writeJson(root, 'data/mutable/game_data/player_equipment.json', { version: 1, instances });
}

async function setEquipmentSlots(root, slots) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.equipment_slots = slots;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
}

// ----- combat balance multipliers (player/companion HP ×3, heal ×2), shared with the arena (C-26) -----
// These assert the dungeon side of the single shared seam (combatResolution: combatMaxHp /
// COMBAT_HP_MULTIPLIER, the scaled equippedHealingSpellState). The arena engine tests assert the
// arena side is the same single multiple (max_hp === core × COMBAT_HP_MULTIPLIER, heal === base ×
// COMBAT_HEAL_MULTIPLIER), so jointly they guarantee neither subsystem double-applies (no ×9/×4).
// Dungeon ENEMIES are the one exception: they seed from the enemy-only pool (enemyCombatMaxHp,
// × ENEMY_HP_MULTIPLIER = 0.6 = one fifth of the ×3 value), asserted below.

test('dungeon player and companion enter at COMBAT_HP_MULTIPLIER × their shared-core max HP', async () => {
  const params = parametersWith({ fire: 30, light: 20, water: 20 }, { strength: 40, magical_power: 30, academics: 20 });
  const companion = { character_id: 'character_016', name: '同行者', parameters: parametersWith({ fire: 50 }, { strength: 50, magical_power: 40 }) };
  const root = await dungeonRoot(params);
  const view = await enterDungeon({ root, seed: 11, companion });

  // Unequipped, so the equipment fold adds nothing and the shared-core max is deriveCombatStats.
  const playerCoreMax = deriveCombatStats(normalizeParameters(params)).max_hp;
  const companionCoreMax = deriveCombatStats(normalizeParameters(companion.parameters)).max_hp;
  assert.equal(COMBAT_HP_MULTIPLIER, 3);
  assert.equal(view.player.max_hp, playerCoreMax * COMBAT_HP_MULTIPLIER);
  assert.equal(view.player.hp, view.player.max_hp, 'the player enters at full (scaled) HP');
  assert.equal(view.companion.max_hp, companionCoreMax * COMBAT_HP_MULTIPLIER);
  assert.equal(view.companion.hp, view.companion.max_hp, 'the companion enters at full (scaled) HP');
  // Exactly the single multiple, not a squared double-apply.
  assert.equal(view.player.max_hp / playerCoreMax, COMBAT_HP_MULTIPLIER);
  // The MP pool is untouched by the HP multiplier.
  assert.equal(view.player.max_mp, deriveCombatStats(normalizeParameters(params)).max_mp);
});

test('dungeon normal enemies spawn at the enemy pool (× ENEMY_HP_MULTIPLIER = one fifth of ×3), damage unscaled', () => {
  const floor = generateFloor({ seed: 7, floor: 1 });
  assert.ok(floor.enemies.length > 0, 'the floor has enemies to check');
  for (const enemy of floor.enemies) {
    const scaled = scaledEnemyStats(enemyArchetype(enemy.archetype_id), 1);
    assert.equal(enemy.max_hp, enemyCombatMaxHp(scaled.max_hp), `${enemy.archetype_id} HP is the enemy pool`);
    // Exactly one fifth of the old player-side ×COMBAT_HP_MULTIPLIER seeding (0.6 = 3 × 1/5), rounded, floored at 1.
    assert.equal(enemy.max_hp, Math.max(1, Math.round((scaled.max_hp * COMBAT_HP_MULTIPLIER) / 5)), `${enemy.archetype_id} HP is 1/5 of the ×${COMBAT_HP_MULTIPLIER} value`);
    assert.equal(enemy.hp, enemy.max_hp, 'the enemy enters at full HP');
    // Attack/defense/speed are NOT scaled by the HP multiplier.
    assert.equal(enemy.attack, scaled.attack);
    assert.equal(enemy.defense, scaled.defense);
  }
});

test('a milestone boss spawns at the enemy pool (one fifth of the ×3 value), damage unscaled', () => {
  const MILESTONE_FLOOR = 5;
  const floor = generateFloor({ seed: 7, floor: MILESTONE_FLOOR });
  const boss = floor.enemies.find((enemy) => enemy.boss === true);
  assert.ok(boss, 'the milestone floor carries a boss');
  const scaled = scaledEnemyStats(enemyArchetype(boss.archetype_id), MILESTONE_FLOOR);
  assert.equal(boss.max_hp, enemyCombatMaxHp(scaled.max_hp), 'boss HP is the enemy pool');
  assert.equal(boss.max_hp, Math.max(1, Math.round((scaled.max_hp * COMBAT_HP_MULTIPLIER) / 5)), 'boss HP is 1/5 of the ×3 value');
  assert.equal(boss.hp, boss.max_hp, 'the boss enters at full HP');
  assert.equal(boss.attack, scaled.attack, 'boss attack is unscaled by the HP knob');
  assert.equal(boss.defense, scaled.defense);
  assert.equal(boss.speed, scaled.speed);
});

test('an unequipped run reads equipment null and matches an empty-surface run exactly', async () => {
  const params = parametersWith({ fire: 30, light: 20, water: 20 }, { magical_power: 30, academics: 20 });
  const noSurfaceRoot = await dungeonRoot(params);
  const noSurfaceView = await enterDungeon({ root: noSurfaceRoot, seed: 7 });

  const emptySurfaceRoot = await dungeonRoot(params);
  await writeEquipmentSurface(emptySurfaceRoot, []);
  const emptySurfaceView = await enterDungeon({ root: emptySurfaceRoot, seed: 7 });

  assert.equal(noSurfaceView.equipment, null, 'no surface: equipment is null');
  assert.equal(emptySurfaceView.equipment, null, 'empty surface: equipment is null');
  // Adding the equipment machinery changes no numbers when unequipped.
  assert.deepEqual(emptySurfaceView.player_stats, noSurfaceView.player_stats);
  assert.deepEqual(emptySurfaceView.castable_elements, noSurfaceView.castable_elements);
  assert.deepEqual(emptySurfaceView.healing_spell, noSurfaceView.healing_spell);
  // And they match the legacy parameter-derived formulas exactly (regression boundary).
  const normalized = normalizeParameters(params);
  const fire = noSurfaceView.castable_elements.find((entry) => entry.element === 'fire');
  assert.equal(fire.mp_cost, spellManaCost('fire', normalized));
  assert.equal(noSurfaceView.healing_spell.mp_cost, healingSpellManaCost(normalized));
  assert.equal(noSurfaceView.healing_spell.heal_amount, healingSpellAmount(normalized) * COMBAT_HEAL_MULTIPLIER);
});

test('equipment folds into the entry combat snapshot: all seven effects reflect on view/action', async () => {
  const params = parametersWith({ fire: 40, light: 40, water: 40 }, { strength: 40, magical_power: 40, academics: 40 });
  const baseRoot = await dungeonRoot(params);
  const baseView = await enterDungeon({ root: baseRoot, seed: 321 });

  const root = await dungeonRoot(params);
  await writeEquipmentSurface(root, [
    { instance_id: 'w1', kind: 'weapon', weapon_type: 'staff', element: 'fire', tier: 3, quality: 'excellent', name: '火の杖', flavor: '穂先に熾火。',
      base_effects: { attack: 6, element_spell_power: 5, spell_mp_discount: 2 }, bonus_effects: { max_mp: 4 } },
    { instance_id: 'a1', kind: 'amulet', element: 'water', tier: 2, quality: 'fine', name: '守りの護符', flavor: '静かな護り。',
      base_effects: { defense: 3, max_hp: 10 }, bonus_effects: { self_heal_bonus: 7 } }
  ]);
  await setEquipmentSlots(root, { weapon: 'w1', amulet: 'a1' });
  const view = await enterDungeon({ root, seed: 321 });

  // attack -> melee_attack, defense, max_hp, max_mp (stat snapshot).
  assert.equal(view.player_stats.melee_attack, baseView.player_stats.melee_attack + 6);
  assert.equal(view.player_stats.defense, baseView.player_stats.defense + 3);
  assert.equal(view.player_stats.max_hp, baseView.player_stats.max_hp + 10);
  assert.equal(view.player_stats.max_mp, baseView.player_stats.max_mp + 4);
  // max_hp/max_mp raise the entry vitals and their regen ceiling. The HP pool is the combat
  // multiple of the equipment-folded max, so the +10 equipment bonus lands ×COMBAT_HP_MULTIPLIER.
  assert.equal(view.player.max_hp, baseView.player.max_hp + 10 * COMBAT_HP_MULTIPLIER);
  assert.equal(view.player.hp, view.player.max_hp, 'enters at the boosted full HP');
  assert.equal(view.player.max_mp, baseView.player.max_mp + 4);
  assert.equal(view.player.mp, view.player.max_mp, 'enters at the boosted full MP');
  // element_spell_power -> only the weapon's own element (fire), not others.
  assert.equal(view.player_stats.spell_power.fire, baseView.player_stats.spell_power.fire + 5);
  assert.equal(view.player_stats.spell_power.water, baseView.player_stats.spell_power.water);
  const baseFire = baseView.castable_elements.find((entry) => entry.element === 'fire');
  const fire = view.castable_elements.find((entry) => entry.element === 'fire');
  assert.equal(fire.power, baseFire.power + 5);
  // spell_mp_discount -> every spell cost (fire here) reduced by 2.
  assert.equal(fire.mp_cost, baseFire.mp_cost - 2);
  // heal spell: discount on its MP cost, self_heal_bonus on its amount (the +7 bonus lands inside
  // the combat-heal-multiplier-scaled amount, so it reflects ×COMBAT_HEAL_MULTIPLIER).
  assert.equal(view.healing_spell.mp_cost, baseView.healing_spell.mp_cost - 2);
  assert.equal(view.healing_spell.heal_amount, baseView.healing_spell.heal_amount + 7 * COMBAT_HEAL_MULTIPLIER);
  // Additive view summary of the equipped pieces.
  assert.equal(view.equipment.slots.weapon.instance_id, 'w1');
  assert.equal(view.equipment.slots.amulet.instance_id, 'a1');
  assert.equal(view.equipment.effects.attack, 6);
});

test('spell_mp_discount floors a spell cost at 1 MP, never free', async () => {
  const root = await dungeonRoot(parametersWith({ dark: 100 }, {}));
  await writeEquipmentSurface(root, [
    { instance_id: 'w', kind: 'weapon', weapon_type: 'short_rod', element: 'dark', tier: 4, quality: 'masterwork', name: '闇の短杖', flavor: '底なしの闇。',
      base_effects: { spell_mp_discount: 9 }, bonus_effects: {} }
  ]);
  await setEquipmentSlots(root, { weapon: 'w' });
  const view = await enterDungeon({ root, seed: 5 });
  const dark = view.castable_elements.find((entry) => entry.element === 'dark');
  // Base cost at 100 mastery is 2; a 9 discount clamps to the 1 MP floor, not below.
  assert.equal(dark.mp_cost, 1);
  assert.equal(view.healing_spell.mp_cost >= 1, true);
});

test('equipment does not pollute run.parameters, so it never banks into academy parameters', async () => {
  const params = parametersWith({ fire: 30 }, { strength: 30 });
  const root = await dungeonRoot(params);
  await writeEquipmentSurface(root, [
    { instance_id: 'w', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2, quality: 'fine', name: '剣', flavor: '鋼の刃。',
      base_effects: { attack: 20, max_hp: 50 }, bonus_effects: {} }
  ]);
  await setEquipmentSlots(root, { weapon: 'w' });
  const view = await enterDungeon({ root, seed: 9 });
  // The snapshot carries the buff...
  assert.equal(view.player_stats.melee_attack, deriveCombatStats(normalizeParameters(params)).melee_attack + 20);
  // ...but run.parameters (the bankPendingGains source) stays the pure academy values.
  const run = (await readJson(root, 'data/mutable/game_data/runtime_state.json')).dungeon_run;
  assert.deepEqual(run.parameters, normalizeParameters(params));
});

test('a mid-run equipment change does not affect the in-progress run', async () => {
  const root = await dungeonRoot(parametersWith({}, {}));
  await writeEquipmentSurface(root, [
    { instance_id: 'w', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 1, quality: 'common', name: '剣', flavor: '素朴な刃。',
      base_effects: { attack: 8, max_hp: 20 }, bonus_effects: {} }
  ]);
  await setEquipmentSlots(root, { weapon: 'w' });
  const entered = await enterDungeon({ root, seed: 42 });
  const meleeAtEntry = entered.player_stats.melee_attack;
  const maxHpAtEntry = entered.player.max_hp;

  // Unequip mid-run (remove the field) and clear enemies to keep the action clean.
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  delete state.equipment_slots;
  state.dungeon_run.enemies = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const afterView = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });

  assert.equal(afterView.player_stats.melee_attack, meleeAtEntry, 'the in-progress run keeps its entry attack');
  assert.equal(afterView.player.max_hp, maxHpAtEntry, 'the in-progress run keeps its entry max HP');
  assert.equal(afterView.equipment.slots.weapon.instance_id, 'w', 'the in-progress run keeps its entry equipment');
});

test('entering with equipment_slots referencing an unresolvable instance throws', async () => {
  const root = await dungeonRoot();
  await setEquipmentSlots(root, { weapon: 'ghost' });
  await assert.rejects(enterDungeon({ root, seed: 1 }), /unknown instance: ghost/);
});

test('entering with a slot/kind mismatch throws instead of dropping to unequipped', async () => {
  const root = await dungeonRoot();
  await writeEquipmentSurface(root, [
    { instance_id: 'a1', kind: 'amulet', element: 'water', tier: 1, quality: 'common', name: '護符', flavor: '涼やか。', base_effects: { defense: 2 }, bonus_effects: {} }
  ]);
  await setEquipmentSlots(root, { weapon: 'a1' });
  await assert.rejects(enterDungeon({ root, seed: 1 }), /requires a weapon, but a1 is a amulet/);
});

async function setCompanionEquipmentSlots(root, characterId, slots) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.companion_equipment_slots = { ...(state.companion_equipment_slots ?? {}), [characterId]: slots };
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
}

async function readDungeonRun(root) {
  return (await readJson(root, 'data/mutable/game_data/runtime_state.json')).dungeon_run;
}

test('companion equipment folds into its entry combat snapshot, symmetric to the hero', async () => {
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 60, light: 10, water: 10 }, { strength: 40, magical_power: 40, academics: 40 }) };

  const baseRoot = await dungeonRoot();
  const baseView = await enterDungeon({ root: baseRoot, seed: 321, companion });
  const baseRun = await readDungeonRun(baseRoot);

  const root = await dungeonRoot();
  await writeEquipmentSurface(root, [
    { instance_id: 'cw', kind: 'weapon', weapon_type: 'staff', element: 'fire', tier: 3, quality: 'excellent', name: '火の杖', flavor: '穂先に熾火。',
      base_effects: { attack: 6, element_spell_power: 5 }, bonus_effects: { max_mp: 4 } },
    { instance_id: 'ca', kind: 'amulet', element: 'water', tier: 2, quality: 'fine', name: '守りの護符', flavor: '静かな護り。',
      base_effects: { defense: 3, max_hp: 10 }, bonus_effects: {} }
  ]);
  await setCompanionEquipmentSlots(root, 'character_016', { weapon: 'cw', amulet: 'ca' });
  const view = await enterDungeon({ root, seed: 321, companion });
  const run = await readDungeonRun(root);

  // Stat-shaped effects fold into the companion's combat stats (attack -> melee_attack).
  assert.equal(run.companion.stats.melee_attack, baseRun.companion.stats.melee_attack + 6);
  assert.equal(run.companion.stats.defense, baseRun.companion.stats.defense + 3);
  assert.equal(run.companion.stats.max_hp, baseRun.companion.stats.max_hp + 10);
  assert.equal(run.companion.stats.max_mp, baseRun.companion.stats.max_mp + 4);
  // element_spell_power lifts only the weapon's own element (fire), not others.
  assert.equal(run.companion.stats.spell_power.fire, baseRun.companion.stats.spell_power.fire + 5);
  assert.equal(run.companion.stats.spell_power.water, baseRun.companion.stats.spell_power.water);
  // HP/MP enter at the equipment-boosted full max, exactly like the hero (the +10 max_hp bonus
  // lands ×COMBAT_HP_MULTIPLIER on the combat HP pool).
  assert.equal(view.companion.max_hp, baseView.companion.max_hp + 10 * COMBAT_HP_MULTIPLIER);
  assert.equal(view.companion.hp, view.companion.max_hp, 'enters at the boosted full HP');
  assert.equal(view.companion.max_mp, baseView.companion.max_mp + 4);
  assert.equal(view.companion.mp, view.companion.max_mp, 'enters at the boosted full MP');
  // Additive view summary of the equipped pieces; unequipped is null.
  assert.equal(view.companion.equipment.slots.weapon.instance_id, 'cw');
  assert.equal(view.companion.equipment.slots.amulet.instance_id, 'ca');
  assert.equal(view.companion.equipment.effects.attack, 6);
  assert.equal(baseView.companion.equipment, null);
});

test('companion spell_mp_discount and self_heal_bonus apply at action time (self-heal)', async () => {
  const companion = { character_id: 'character_016', name: 'テスト同行者', parameters: parametersWith({ fire: 60, light: 10, water: 10 }, { strength: 40, magical_power: 40, academics: 40 }) };

  // Drives one wait-turn where the wounded companion self-heals with no enemies to
  // perturb it, then returns its persisted run state. Equipped vs unequipped share the
  // exact same pre-turn HP/MP and (with a discount-only amulet) the same max HP/MP, so
  // the +1 turn regen cancels in the diff and only the equipment effect remains.
  async function selfHealRun(equipped) {
    const root = await dungeonRoot();
    if (equipped) {
      await writeEquipmentSurface(root, [
        { instance_id: 'ca', kind: 'amulet', element: 'water', tier: 2, quality: 'fine', name: '癒しの護符', flavor: '慈しみの光。',
          base_effects: { spell_mp_discount: 2, self_heal_bonus: 7 }, bonus_effects: {} }
      ]);
      await setCompanionEquipmentSlots(root, 'character_016', { amulet: 'ca' });
    }
    await enterDungeon({ root, seed: 246, companion });
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    state.dungeon_run.enemies = [];
    state.dungeon_run.companion.hp = 5;
    state.dungeon_run.companion.mp = state.dungeon_run.companion.max_mp;
    await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
    await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    return readDungeonRun(root);
  }

  const base = await selfHealRun(false);
  const equipped = await selfHealRun(true);

  // A discount-only amulet leaves max HP/MP identical, so the wounded companion self-heals
  // in both runs; the equipped run keeps 2 more MP (discount) and 7 more HP (bonus).
  assert.equal(equipped.companion.max_hp, base.companion.max_hp, 'discount-only amulet does not change max HP');
  assert.equal(equipped.companion.max_mp, base.companion.max_mp, 'discount-only amulet does not change max MP');
  assert.ok(base.companion.hp > 5, 'the wounded companion self-healed in the baseline run');
  assert.equal(equipped.companion.mp - base.companion.mp, 2, 'spell_mp_discount cuts the companion heal cost by 2');
  // self_heal_bonus adds 7 to the equipment-folded heal, which the combat heal multiplier then scales.
  assert.equal(equipped.companion.hp - base.companion.hp, 7 * COMBAT_HEAL_MULTIPLIER, 'self_heal_bonus (×heal multiplier) adds to the companion heal');
});

test('companion equipment is independent of hero equipment: an unequipped companion stays byte-equivalent', async () => {
  const companion = { character_id: 'character_016', name: '同行者', parameters: parametersWith({ fire: 50 }, { strength: 50, magical_power: 50 }) };

  const plainRoot = await dungeonRoot();
  await enterDungeon({ root: plainRoot, seed: 88, companion });
  const plainRun = await readDungeonRun(plainRoot);

  const heroEquippedRoot = await dungeonRoot();
  await writeEquipmentSurface(heroEquippedRoot, [
    { instance_id: 'w1', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2, quality: 'fine', name: '剣', flavor: '鋼の刃。', base_effects: { attack: 12, max_hp: 30 }, bonus_effects: {} }
  ]);
  await setEquipmentSlots(heroEquippedRoot, { weapon: 'w1' });
  await enterDungeon({ root: heroEquippedRoot, seed: 88, companion });
  const heroRun = await readDungeonRun(heroEquippedRoot);

  // Hero equipment moved the hero but never leaks into the companion.
  assert.deepEqual(heroRun.companion, plainRun.companion);
  assert.equal(heroRun.companion.equipment, null);
  assert.notDeepEqual(heroRun.player_stats, plainRun.player_stats, 'the hero surface did take effect');
});

test('a mid-run companion equipment change does not affect the in-progress run', async () => {
  const companion = { character_id: 'character_016', name: '同行者', parameters: parametersWith({ fire: 40 }, { strength: 40, magical_power: 40 }) };
  const root = await dungeonRoot();
  await writeEquipmentSurface(root, [
    { instance_id: 'cw', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2, quality: 'fine', name: '剣', flavor: '刃。', base_effects: { attack: 8, max_hp: 20 }, bonus_effects: {} }
  ]);
  await setCompanionEquipmentSlots(root, 'character_016', { weapon: 'cw' });
  const entered = await enterDungeon({ root, seed: 42, companion });
  const meleeAtEntry = (await readDungeonRun(root)).companion.stats.melee_attack;
  const maxHpAtEntry = entered.companion.max_hp;

  // Unequip the companion mid-run (remove the whole field) and clear enemies.
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  delete state.companion_equipment_slots;
  state.dungeon_run.enemies = [];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  const afterView = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
  const afterRun = await readDungeonRun(root);

  assert.equal(afterRun.companion.stats.melee_attack, meleeAtEntry, 'the in-progress run keeps its entry attack');
  assert.equal(afterView.companion.max_hp, maxHpAtEntry, 'the in-progress run keeps its entry max HP');
  assert.equal(afterView.companion.equipment.slots.weapon.instance_id, 'cw', 'the in-progress run keeps its entry equipment');
});

test('entering with companion_equipment_slots referencing an unresolvable instance throws', async () => {
  const companion = { character_id: 'character_016', name: '同行者', parameters: parametersWith({ fire: 30 }, {}) };
  const root = await dungeonRoot();
  await setCompanionEquipmentSlots(root, 'character_016', { weapon: 'ghost' });
  await assert.rejects(enterDungeon({ root, seed: 1, companion }), /unknown instance: ghost/);
});
