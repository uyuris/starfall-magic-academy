// Arena combat engine (C-26): a fixed-board, team-symmetric, AI-driven pure combat engine
// reusing the shared grid-combat core (combatResolution / combatGeometry / combatAi /
// combatConsumables). Covers 1v1 and 2v2, all-AI and player-controlled matches, the
// deterministic auto replay, the round cap + HP-ratio decision, the shared MP-reserve /
// archetype / self-heal / wall-LoS disciplines manifesting in the arena, player consumables
// (attack_single / heal / revive) with the dungeon consume discipline, the no-reward/
// no-write invariant on defeat, and every fail-fast condition.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { definitionsRoot } from './testPaths.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { hasLineOfSight } from '../src/dungeon/combatGeometry.mjs';
import { deriveCombatStats, healingSpellAmount } from '../src/dungeon/dungeonStats.mjs';
import { COMBAT_HEAL_MULTIPLIER, COMBAT_HP_MULTIPLIER } from '../src/dungeon/combatResolution.mjs';
import { applyEquipmentToCombatStats } from '../src/equipment.mjs';
import { normalizeParameters } from '../src/parameters.mjs';
import { createArenaBoard } from '../src/arena/arenaBoard.mjs';
import {
  ARENA_MAX_ROUNDS, arenaMatchView, arenaStep, createArenaMatch, runArenaMatchAuto
} from '../src/arena/arenaEngine.mjs';

const ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];

// Builds one actor descriptor. `o` overrides ability/magic values and match flags.
function actor(id, o = {}) {
  const magic = Object.fromEntries(ELEMENTS.map((key) => [key, { value: o[key] ?? o.mag ?? 10 }]));
  const abilities = {
    strength: { value: o.str ?? 20 },
    agility: { value: o.agi ?? 20 },
    academics: { value: o.academics ?? 20 },
    magical_power: { value: o.pow ?? 20 },
    charisma: { value: o.charisma ?? 20 }
  };
  return {
    actor_id: id,
    name: o.name ?? id,
    kind: o.kind ?? 'character',
    parameters: { magic, abilities },
    equipment: o.equipment ?? null,
    mp_reserve_percent: o.reserve ?? 30,
    controller: o.controller ?? 'ai'
  };
}

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

// A root carrying the alchemy catalog + dungeon materials + gathering catalog (the economy
// consume validates against the full known-item set) and a player_inventory with the given items.
async function arenaRoot(items = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-arena-'));
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await fs.copyFile(
    path.join(definitionsRoot, 'gathering_points.json'),
    path.join(root, 'data/definitions/game_data/gathering_points.json')
  );
  await writeJson(root, 'data/mutable/game_data/player_inventory.json', {
    money: 100000, items, applied_money_delta_conversation_ids: []
  });
  return root;
}

async function inventoryQuantity(root, itemId) {
  const inventory = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  return inventory.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
}

// ----- match creation / board -----

test('createArenaMatch places a 1v1 on the fixed board with symmetric wings and full vitals', () => {
  const match = createArenaMatch({ seed: 1, teamA: [actor('a1')], teamB: [actor('b1')] });
  assert.equal(match.status, 'active');
  assert.equal(match.winner, null);
  assert.equal(match.board.width, 11);
  assert.equal(match.board.height, 9);
  const a1 = match.actors.find((a) => a.actor_id === 'a1');
  const b1 = match.actors.find((a) => a.actor_id === 'b1');
  assert.deepEqual({ x: a1.x, y: a1.y }, { x: 1, y: 4 });
  assert.deepEqual({ x: b1.x, y: b1.y }, { x: 9, y: 4 });
  // Mirror symmetry across the vertical center (x=5).
  assert.equal(a1.x + b1.x, 10);
  // Vitals initialize from the equipment-folded max.
  assert.equal(a1.hp, a1.max_hp);
  assert.equal(a1.mp, a1.max_mp);
  assert.ok(a1.max_hp > 0 && a1.max_mp > 0);
});

test('createArenaMatch places a 2v2 with both fighters flanking the center row', () => {
  const match = createArenaMatch({ seed: 1, teamA: [actor('a1'), actor('a2')], teamB: [actor('b1'), actor('b2')] });
  const pos = Object.fromEntries(match.actors.map((a) => [a.actor_id, { x: a.x, y: a.y }]));
  assert.deepEqual(pos.a1, { x: 1, y: 3 });
  assert.deepEqual(pos.a2, { x: 1, y: 5 });
  assert.deepEqual(pos.b1, { x: 9, y: 3 });
  assert.deepEqual(pos.b2, { x: 9, y: 5 });
});

// ----- spectator replay initial frame -----

test('runArenaMatchAuto prepends the true spawn placement as the first replay frame (1v1 and 2v2)', async () => {
  // 1v1: the first replay frame must be the board at match creation (before any AI turn).
  const teamA = [actor('a1', { str: 60, agi: 50 })];
  const teamB = [actor('b1', { mag: 70, pow: 40 })];
  const seed = 12345;
  const spawn1v1 = createArenaMatch({ seed, teamA, teamB });
  const expected1v1 = spawn1v1.actors.map((a) => ({ id: a.actor_id, x: a.x, y: a.y }));
  const replay1v1 = await runArenaMatchAuto({ root: null, seed, teamA, teamB });
  const first1v1 = replay1v1.turns[0].view.actors.map((a) => ({ id: a.actor_id, x: a.x, y: a.y }));
  assert.deepEqual(first1v1, expected1v1, '1v1 first frame is the spawn placement');
  assert.deepEqual(replay1v1.turns[0].events, [], '1v1 first frame carries no events');

  // 2v2: same invariant for the flanking spawn placement.
  const tA = [actor('a1', { str: 55, agi: 45 }), actor('a2', { mag: 65, pow: 50 })];
  const tB = [actor('b1', { str: 50, agi: 40 }), actor('b2', { mag: 60, pow: 45 })];
  const seed2 = 999;
  const spawn2v2 = createArenaMatch({ seed: seed2, teamA: tA, teamB: tB });
  const expected2v2 = spawn2v2.actors.map((a) => ({ id: a.actor_id, x: a.x, y: a.y }));
  const replay2v2 = await runArenaMatchAuto({ root: null, seed: seed2, teamA: tA, teamB: tB });
  const first2v2 = replay2v2.turns[0].view.actors.map((a) => ({ id: a.actor_id, x: a.x, y: a.y }));
  assert.deepEqual(first2v2, expected2v2, '2v2 first frame is the spawn placement');
  assert.deepEqual(replay2v2.turns[0].events, [], '2v2 first frame carries no events');

  // The prepended frame is not a round step: winner/rounds keep their meaning.
  assert.ok(replay1v1.winner === 'a' || replay1v1.winner === 'b');
  assert.ok(replay1v1.rounds <= ARENA_MAX_ROUNDS);
});

// ----- determinism + convergence -----

test('runArenaMatchAuto is deterministic: same input yields byte-identical output (1v1 and 2v2)', async () => {
  const teamA = [actor('a1', { str: 60, agi: 50 })];
  const teamB = [actor('b1', { mag: 70, pow: 40 })];
  const r1 = await runArenaMatchAuto({ root: null, seed: 12345, teamA, teamB });
  const r2 = await runArenaMatchAuto({ root: null, seed: 12345, teamA, teamB });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  assert.ok(r1.winner === 'a' || r1.winner === 'b');
  assert.ok(r1.turns.length > 0);

  const tA = [actor('a1', { str: 55, agi: 45 }), actor('a2', { mag: 65, pow: 50 })];
  const tB = [actor('b1', { str: 50, agi: 40 }), actor('b2', { mag: 60, pow: 45 })];
  const s1 = await runArenaMatchAuto({ root: null, seed: 999, teamA: tA, teamB: tB });
  const s2 = await runArenaMatchAuto({ root: null, seed: 999, teamA: tA, teamB: tB });
  assert.equal(JSON.stringify(s1), JSON.stringify(s2));
  assert.ok(s1.winner === 'a' || s1.winner === 'b');
});

test('an AI-vs-AI match always decides a winner within ARENA_MAX_ROUNDS', async () => {
  for (const seed of [1, 7, 33, 128, 5000]) {
    const r = await runArenaMatchAuto({
      root: null, seed,
      teamA: [actor('a1', { str: 40 + (seed % 20), agi: 30, mag: 20 })],
      teamB: [actor('b1', { mag: 50, pow: 40, agi: 25 })]
    });
    assert.ok(r.winner === 'a' || r.winner === 'b', `seed ${seed} decided`);
    assert.ok(r.rounds <= ARENA_MAX_ROUNDS, `seed ${seed} rounds ${r.rounds} <= ${ARENA_MAX_ROUNDS}`);
  }
});

test('a stalemate hits the round cap and is settled by team HP ratio (draw impossible)', async () => {
  // reserve=100 → mpAboveReserve is never true, so neither actor ever spends MP on an attack;
  // nobody can damage anyone → the match runs to the cap and is decided by HP ratio.
  const r = await runArenaMatchAuto({ root: null, seed: 42, teamA: [actor('a', { reserve: 100 })], teamB: [actor('b', { reserve: 100 })] });
  assert.equal(r.rounds, ARENA_MAX_ROUNDS);
  assert.ok(r.winner === 'a' || r.winner === 'b');
});

// ----- shared disciplines manifesting in the arena -----

test('the MP-reserve line gates arena attacks: reserve=100 deals no damage, reserve=0 does', async () => {
  const pacifist = await runArenaMatchAuto({ root: null, seed: 3, teamA: [actor('a', { reserve: 100 })], teamB: [actor('b', { reserve: 100 })] });
  // No actor's HP ever drops below its max across the entire replay.
  const anyDamage = pacifist.turns.some((turn) => turn.view.actors.some((a) => a.hp < a.max_hp));
  assert.equal(anyDamage, false);

  const fighters = await runArenaMatchAuto({ root: null, seed: 3, teamA: [actor('a', { str: 60, reserve: 0 })], teamB: [actor('b', { str: 55, reserve: 0 })] });
  const damaged = fighters.turns.some((turn) => turn.view.actors.some((a) => a.hp < a.max_hp));
  assert.equal(damaged, true);
});

test('caster and melee archetypes drive the expected arena combat events', async () => {
  const casters = await runArenaMatchAuto({
    root: null, seed: 5,
    teamA: [actor('c1', { mag: 90, pow: 80, str: 5, agi: 5, reserve: 0 })],
    teamB: [actor('c2', { mag: 85, pow: 75, str: 5, agi: 5, reserve: 0 })]
  });
  const casterKinds = new Set(casters.turns.flatMap((t) => t.events.map((e) => e.kind)));
  assert.ok(casterKinds.has('cast'), 'casters cast');

  const melee = await runArenaMatchAuto({
    root: null, seed: 5,
    teamA: [actor('m1', { str: 80, agi: 60, mag: 5, reserve: 0 })],
    teamB: [actor('m2', { str: 75, agi: 55, mag: 5, reserve: 0 })]
  });
  const meleeKinds = new Set(melee.turns.flatMap((t) => t.events.map((e) => e.kind)));
  assert.ok(meleeKinds.has('melee'), 'melee fighters bump');
});

test('a wounded arena actor self-heals via the shared AI discipline', async () => {
  const healer = actor('healer', { light: 90, water: 90, pow: 80, str: 60, mag: 90, reserve: 20 });
  const bruiser = actor('bruiser', { str: 90, agi: 70, mag: 5, reserve: 0 });
  const r = await runArenaMatchAuto({ root: null, seed: 1, teamA: [healer], teamB: [bruiser] });
  const selfHealed = r.turns.some((turn) => turn.view.log.some((line) => line.includes('回復魔法')));
  assert.equal(selfHealed, true);
});

test('the arena board keeps the magic-wall LoS rule (pillars block a straight line)', () => {
  const board = createArenaBoard();
  // Row 4 (the 1v1 lane) is open end to end.
  assert.equal(hasLineOfSight(board, { x: 1, y: 4 }, { x: 9, y: 4 }), true);
  // Row 3 runs through the pillars at (3,3) and (7,3): the straight line is blocked.
  assert.equal(hasLineOfSight(board, { x: 1, y: 3 }, { x: 9, y: 3 }), false);
});

// ----- player-controlled match -----

test('a player match view exposes the player supplies and steps to a decision', async () => {
  const root = await arenaRoot([]);
  let match = createArenaMatch({
    seed: 7,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', str: 80, agi: 60, reserve: 0 })],
    teamB: [actor('foe', { str: 30, agi: 10, mag: 10, reserve: 0 })]
  });
  const initial = arenaMatchView(match);
  assert.equal(initial.player_actor_id, 'hero');
  assert.equal(initial.castable_elements.length, 6);
  assert.ok(initial.healing_spell && typeof initial.healing_spell.mp_cost === 'number');
  assert.equal(initial.revive_used, false);
  assert.equal(initial.consumables, null); // standalone view (no root) does not load consumables

  // Step to a decision with wait actions; each step returns a view + events.
  let steps = 0;
  while (match.status === 'active' && steps < 200) {
    const result = await arenaStep({ root, match, action: { type: 'wait' } });
    match = result.match;
    assert.ok(Array.isArray(result.view.actors));
    assert.ok(Array.isArray(result.events));
    steps += 1;
  }
  assert.ok(match.status === 'a_won' || match.status === 'b_won');
  // A step after the match is finished fails fast (409).
  await assert.rejects(() => arenaStep({ root, match, action: { type: 'wait' } }), (error) => error.statusCode === 409);
});

test('an invalid player action returns an action_error without consuming the turn', async () => {
  const root = await arenaRoot([]);
  const match = createArenaMatch({
    seed: 2,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', agi: 90, reserve: 0 })],
    teamB: [actor('foe', { agi: 5, reserve: 0 })]
  });
  // hero is faster → it is up first. Casting an element with 0 mastery still costs MP it has,
  // but a wall-free lane has a target; instead force "no_target" by walling? Simpler: an
  // unknown element is a clean turn-non-consuming action_error.
  const before = match.turn_index;
  const result = await arenaStep({ root, match, action: { type: 'cast', element: 'not_an_element' } });
  assert.equal(result.view.action_error, 'unknown_element');
  assert.equal(result.match.turn_index, before); // turn not consumed
  assert.equal(result.match.status, 'active');
});

// ----- player consumables (dungeon consume + effect discipline) -----

test('player use_consumable attack_single throws a bomb for flat damage and consumes one item', async () => {
  const root = await arenaRoot([{ item_id: 'alchemy_fire_throwing_bomb', quantity: 2 }]);
  let match = createArenaMatch({
    seed: 11,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', agi: 95, reserve: 0 })],
    teamB: [actor('foe', { str: 40, agi: 5, reserve: 0 })]
  });
  const foeMaxHp = match.actors.find((a) => a.actor_id === 'foe').max_hp;
  assert.ok(foeMaxHp < 520, 'the 520-power bomb one-shots this foe');
  const result = await arenaStep({ root, match, action: { type: 'use_consumable', item_id: 'alchemy_fire_throwing_bomb' } });
  match = result.match;
  const foe = match.actors.find((a) => a.actor_id === 'foe');
  assert.equal(foe.down, true);
  assert.equal(match.winner, 'a');
  assert.equal(await inventoryQuantity(root, 'alchemy_fire_throwing_bomb'), 1); // exactly one consumed
  assert.ok(result.events.some((e) => e.kind === 'cast'));
});

test('player use_consumable heal restores HP (isolated by branching wait vs heal from one wounded state)', async () => {
  // A modest foe caster closes and wounds the tanky hero. From the identical wounded state
  // (structuredClone), one branch waits and one drinks a healing elixir. Same seed/round →
  // identical leading/trailing damage in both, so the HP gap is exactly the heal.
  const root = await arenaRoot([{ item_id: 'alchemy_healing_elixir', quantity: 1 }]);
  let match = createArenaMatch({
    seed: 1,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', str: 80, agi: 10, light: 50, water: 50, pow: 40, reserve: 0 })],
    teamB: [actor('foe', { mag: 55, pow: 30, agi: 55, str: 5, reserve: 0 })]
  });
  let guard = 0;
  while (match.status === 'active' && guard < 40) {
    const hero = match.actors.find((a) => a.actor_id === 'hero');
    if (hero.hp > 0 && hero.hp < hero.max_hp) break;
    match = (await arenaStep({ root, match, action: { type: 'wait' } })).match;
    guard += 1;
  }
  const woundedHero = match.actors.find((a) => a.actor_id === 'hero');
  assert.ok(woundedHero.hp > 0 && woundedHero.hp < woundedHero.max_hp, 'the foe wounded the hero (precondition)');

  const waited = await arenaStep({ root, match: structuredClone(match), action: { type: 'wait' } });
  const healed = await arenaStep({ root, match: structuredClone(match), action: { type: 'use_consumable', item_id: 'alchemy_healing_elixir', target: 'hero' } });
  const heroWait = waited.match.actors.find((a) => a.actor_id === 'hero');
  const heroHeal = healed.match.actors.find((a) => a.actor_id === 'hero');
  assert.ok(heroHeal.hp > heroWait.hp, 'the heal consumable restored HP');
  assert.equal(await inventoryQuantity(root, 'alchemy_healing_elixir'), 0); // consumed exactly once by the heal branch
});

test('player use_consumable revive stands a downed ally back up, once per match', async () => {
  const root = await arenaRoot([{ item_id: 'alchemy_revival_droplet', quantity: 2 }]);
  let match = createArenaMatch({
    seed: 1,
    teamA: [
      actor('hero', { controller: 'player', kind: 'protagonist', str: 80, agi: 5, mag: 5, pow: 20, reserve: 0 }),
      actor('ally', { str: 5, agi: 5, mag: 5, pow: 5, reserve: 100 })
    ],
    teamB: [actor('foe1', { str: 90, agi: 90, mag: 5, reserve: 0 }), actor('foe2', { str: 90, agi: 85, mag: 5, reserve: 0 })]
  });
  // Wait until the pacifist ally is downed while the hero survives.
  let guard = 0;
  while (match.status === 'active' && guard < 40) {
    const ally = match.actors.find((a) => a.actor_id === 'ally');
    if (ally.down) break;
    match = (await arenaStep({ root, match, action: { type: 'wait' } })).match;
    guard += 1;
  }
  const allyDown = match.actors.find((a) => a.actor_id === 'ally');
  assert.equal(allyDown.down, true);
  assert.equal(match.status, 'active');

  const revived = await arenaStep({ root, match, action: { type: 'use_consumable', item_id: 'alchemy_revival_droplet', target: 'ally' } });
  match = revived.match;
  const ally = match.actors.find((a) => a.actor_id === 'ally');
  assert.equal(ally.down, false);
  assert.ok(ally.hp > 0);
  assert.equal(match.revive_used, true);
  assert.equal(await inventoryQuantity(root, 'alchemy_revival_droplet'), 1); // one consumed

  // A second revive attempt is refused by the once-per-match gate (turn not consumed, item kept).
  // Re-down the ally is unnecessary: the gate rejects before any target check.
  match.actors.find((a) => a.actor_id === 'ally').down = true;
  const second = await arenaStep({ root, match, action: { type: 'use_consumable', item_id: 'alchemy_revival_droplet', target: 'ally' } });
  assert.equal(second.view.action_error, 'revive_used');
  assert.equal(await inventoryQuantity(root, 'alchemy_revival_droplet'), 1); // not consumed again
});

test('the arena view lists an owned auction dungeon_consumable (彗星の大爆薬) from the merged definition source', async () => {
  const root = await arenaRoot([{ item_id: 'auction_item_10', quantity: 1 }]);
  const match = createArenaMatch({
    seed: 11,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', agi: 95, reserve: 0 })],
    teamB: [actor('foe', { agi: 5, reserve: 0 })]
  });
  // A rooted step loads the usable consumables into the view (the standalone arenaMatchView(match) loads none).
  const result = await arenaStep({ root, match, action: { type: 'wait' } });
  const comet = result.view.consumables.find((row) => row.item_id === 'auction_item_10');
  assert.ok(comet, 'the arena view lists the auction consumable (same merged source the use path resolves from)');
  assert.equal(comet.name, '彗星の大爆薬');
  assert.equal(comet.effect_kind, 'attack_area');
  assert.equal(comet.target_mode, 'aim');
  assert.equal(comet.power, 620);
  assert.equal(comet.radius, 5);
});

test('player use_consumable resolves an auction dungeon_consumable (彗星の大爆薬) in the arena — flat area damage, one consumed', async () => {
  const root = await arenaRoot([{ item_id: 'auction_item_10', quantity: 1 }]);
  const match = createArenaMatch({
    seed: 11,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', agi: 95, reserve: 0 })],
    teamB: [actor('foe', { str: 20, agi: 5, mag: 5, pow: 5, reserve: 0 })]
  });
  const foeMaxHp = match.actors.find((a) => a.actor_id === 'foe').max_hp;
  assert.ok(foeMaxHp < 620, 'the 620-power comet blast one-shots this foe');
  // Hero at (1,4), foe at (9,4) on the open center row: aim at the foe's tile (manhattan 0 ≤ radius 5), clear LoS.
  const result = await arenaStep({ root, match, action: { type: 'use_consumable', item_id: 'auction_item_10', aim: { x: 9, y: 4 } } });
  const foe = result.match.actors.find((a) => a.actor_id === 'foe');
  assert.equal(foe.down, true, 'the auction blast fells the foe in radius (use path resolved the merged definition)');
  assert.equal(await inventoryQuantity(root, 'auction_item_10'), 0, 'exactly one auction item is consumed');
  assert.ok(result.events.some((e) => e.kind === 'cast' && e.element === 'fire'), 'the blast reuses the element-tinted cast event');
});

test('an all-AI match view carries no player supplies and no consumables', () => {
  const match = createArenaMatch({ seed: 8, teamA: [actor('a1')], teamB: [actor('b1')] });
  const view = arenaMatchView(match);
  assert.equal(view.player_actor_id, undefined);
  assert.equal(view.castable_elements, undefined);
  assert.equal(view.consumables, undefined);
});

// ----- no reward / no write on defeat -----

test('defeating an opponent writes nothing (no reward, drop, or parameter/inventory write)', async () => {
  const root = await arenaRoot([{ item_id: 'alchemy_fire_throwing_bomb', quantity: 1 }]);
  const inventoryBefore = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  let match = createArenaMatch({
    seed: 21,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', str: 90, agi: 90, reserve: 0 })],
    teamB: [actor('foe', { str: 20, agi: 5, mag: 5, reserve: 100 })]
  });
  const heroParamsBefore = JSON.stringify(match.actors.find((a) => a.actor_id === 'hero').parameters);
  // Close in and defeat the foe with melee moves (a non-consumable action), so no item is spent.
  let guard = 0;
  while (match.status === 'active' && guard < 60) {
    match = (await arenaStep({ root, match, action: { type: 'move', direction: 'right' } })).match;
    guard += 1;
  }
  assert.ok(match.status === 'a_won' || match.status === 'b_won');
  // player_inventory untouched (no material drop deposited, no consumable spent).
  assert.deepEqual(await readJson(root, 'data/mutable/game_data/player_inventory.json'), inventoryBefore);
  // No runtime_state ever written by the engine.
  await assert.rejects(() => fs.access(path.join(root, 'data/mutable/game_data/runtime_state.json')));
  // The actor's academy parameters are never mutated.
  assert.equal(JSON.stringify(match.actors.find((a) => a.actor_id === 'hero').parameters), heroParamsBefore);
});

// ----- arena balance multipliers (HP 3×, heal 2×) -----

test('arena scales max HP to 3× the shared-core max, leaving MP and damage stats untouched', () => {
  const heroDesc = actor('hero', { str: 60, pow: 40, agi: 35 });
  const match = createArenaMatch({ seed: 1, teamA: [heroDesc], teamB: [actor('foe')] });
  const hero = match.actors.find((a) => a.actor_id === 'hero');
  const core = applyEquipmentToCombatStats(deriveCombatStats(normalizeParameters(heroDesc.parameters)), null);
  assert.equal(COMBAT_HP_MULTIPLIER, 3);
  assert.equal(hero.max_hp, core.max_hp * COMBAT_HP_MULTIPLIER);
  assert.equal(hero.hp, hero.max_hp);
  // MP pool and every damage/speed stat stay at the unscaled shared-core value.
  assert.equal(hero.max_mp, core.max_mp);
  assert.equal(hero.stats.melee_attack, core.melee_attack);
  assert.equal(hero.stats.spell_power.fire, core.spell_power.fire);
  assert.equal(hero.stats.speed, core.speed);
});

test('arena self-heal spell reports 2× the shared-core heal amount in the player view', () => {
  const heroDesc = actor('hero', { controller: 'player', kind: 'protagonist', light: 80, water: 80, pow: 60, reserve: 0 });
  const match = createArenaMatch({ seed: 1, teamA: [heroDesc], teamB: [actor('foe', { reserve: 100 })] });
  const base = healingSpellAmount(normalizeParameters(heroDesc.parameters));
  const view = arenaMatchView(match);
  assert.equal(COMBAT_HEAL_MULTIPLIER, 2);
  assert.equal(view.healing_spell.heal_amount, base * COMBAT_HEAL_MULTIPLIER);
});

test('arena self-heal spell applies exactly the doubled amount (wait-vs-heal branch isolation)', async () => {
  const root = await arenaRoot([]);
  const heroDesc = actor('hero', { controller: 'player', kind: 'protagonist', light: 80, water: 80, pow: 60, str: 80, agi: 99, reserve: 0 });
  const match = createArenaMatch({ seed: 4, teamA: [heroDesc], teamB: [actor('foe', { agi: 1, reserve: 100 })] });
  const base = healingSpellAmount(normalizeParameters(heroDesc.parameters));
  // Wound deep enough that the doubled heal never hits the max_hp cap; foe is a slower pacifist
  // (reserve=100 never attacks), so both branches take identical (zero) incoming damage and the
  // same round-end regen — the HP gap is exactly the heal applied.
  match.actors.find((a) => a.actor_id === 'hero').hp = 50;
  const waited = await arenaStep({ root, match: structuredClone(match), action: { type: 'wait' } });
  const healed = await arenaStep({ root, match: structuredClone(match), action: { type: 'heal_spell' } });
  const hpWait = waited.match.actors.find((a) => a.actor_id === 'hero').hp;
  const hpHeal = healed.match.actors.find((a) => a.actor_id === 'hero').hp;
  assert.equal(hpHeal - hpWait, base * COMBAT_HEAL_MULTIPLIER);
});

test('arena heal consumable restores 2× the item heal_amount (wait-vs-heal branch isolation)', async () => {
  const root = await arenaRoot([{ item_id: 'alchemy_healing_elixir', quantity: 1 }]);
  const heroDesc = actor('hero', { controller: 'player', kind: 'protagonist', str: 80, agi: 99, reserve: 0 });
  const match = createArenaMatch({ seed: 6, teamA: [heroDesc], teamB: [actor('foe', { agi: 1, reserve: 100 })] });
  match.actors.find((a) => a.actor_id === 'hero').hp = 50; // headroom > 100 so the doubled 50→100 heal never caps
  const waited = await arenaStep({ root, match: structuredClone(match), action: { type: 'wait' } });
  const healed = await arenaStep({ root, match: structuredClone(match), action: { type: 'use_consumable', item_id: 'alchemy_healing_elixir', target: 'hero' } });
  const hpWait = waited.match.actors.find((a) => a.actor_id === 'hero').hp;
  const hpHeal = healed.match.actors.find((a) => a.actor_id === 'hero').hp;
  assert.equal(hpHeal - hpWait, 50 * COMBAT_HEAL_MULTIPLIER); // item heal_amount 50, doubled
});

test('arena mp_restore consumable restores 2× the item mp_amount (wait-vs-restore branch isolation)', async () => {
  const root = await arenaRoot([{ item_id: 'alchemy_mana_elixir', quantity: 1 }]);
  // pow/academics high → max_mp well above the doubled 25→50 restore so it does not cap.
  const heroDesc = actor('hero', { controller: 'player', kind: 'protagonist', pow: 90, academics: 90, agi: 99, reserve: 0 });
  const match = createArenaMatch({ seed: 6, teamA: [heroDesc], teamB: [actor('foe', { agi: 1, reserve: 100 })] });
  match.actors.find((a) => a.actor_id === 'hero').mp = 0;
  const waited = await arenaStep({ root, match: structuredClone(match), action: { type: 'wait' } });
  const restored = await arenaStep({ root, match: structuredClone(match), action: { type: 'use_consumable', item_id: 'alchemy_mana_elixir', target: 'hero' } });
  const mpWait = waited.match.actors.find((a) => a.actor_id === 'hero').mp;
  const mpRestore = restored.match.actors.find((a) => a.actor_id === 'hero').mp;
  assert.equal(mpRestore - mpWait, 25 * COMBAT_HEAL_MULTIPLIER); // item mp_amount 25, doubled
});

test('arena matches still resolve deterministically at the scaled numbers, KO well within the cap', async () => {
  const teamA = [actor('a1', { str: 60, agi: 50, mag: 5, reserve: 0 })];
  const teamB = [actor('b1', { str: 55, agi: 45, mag: 5, reserve: 0 })];
  const r1 = await runArenaMatchAuto({ root: null, seed: 12345, teamA, teamB });
  const r2 = await runArenaMatchAuto({ root: null, seed: 12345, teamA, teamB });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2)); // byte-identical replay preserved
  assert.ok(r1.winner === 'a' || r1.winner === 'b');
  // With 3× HP a real KO takes longer but stays far under the proportionally raised cap.
  assert.ok(r1.rounds > 1 && r1.rounds < ARENA_MAX_ROUNDS, `rounds ${r1.rounds} within cap ${ARENA_MAX_ROUNDS}`);
});

// ----- fail-fast -----

test('createArenaMatch fail-fasts on malformed input', () => {
  const ok = actor('x');
  assert.throws(() => createArenaMatch({ seed: 1.5, teamA: [actor('a')], teamB: [actor('b')] }), /seed must be an integer/);
  assert.throws(() => createArenaMatch({ seed: 1, teamA: [], teamB: [] }), /teamA must have 1 or 2/);
  assert.throws(() => createArenaMatch({ seed: 1, teamA: [actor('a1'), actor('a2'), actor('a3')], teamB: [actor('b1')] }), /teamA must have 1 or 2/);
  assert.throws(() => createArenaMatch({ seed: 1, teamA: [actor('a1'), actor('a2')], teamB: [actor('b1')] }), /same size/);
  assert.throws(() => createArenaMatch({
    seed: 1,
    teamA: [actor('a', { controller: 'player' })],
    teamB: [actor('b', { controller: 'player' })]
  }), /at most one player controller/);
  assert.throws(() => createArenaMatch({ seed: 1, teamA: [{ ...ok, actor_id: 'dup' }], teamB: [{ ...actor('y'), actor_id: 'dup' }] }), /not unique/);
});

test('createArenaMatch fail-fasts on malformed actor descriptors', () => {
  const base = actor('a');
  const bad = (mut) => () => createArenaMatch({ seed: 1, teamA: [mut(actor('a'))], teamB: [actor('b')] });
  assert.throws(bad((d) => ({ ...d, kind: 'creature' })), /kind must be one of/);
  assert.throws(bad((d) => ({ ...d, controller: 'npc' })), /controller must be/);
  assert.throws(bad((d) => ({ ...d, mp_reserve_percent: 150 })), /mp_reserve_percent must be an integer from 0 to 100/);
  assert.throws(bad((d) => ({ ...d, mp_reserve_percent: 30.5 })), /mp_reserve_percent must be an integer/);
  assert.throws(bad((d) => ({ ...d, name: '' })), /name must be a non-empty string/);
  // Missing one of the 11 parameters.
  assert.throws(bad((d) => {
    const p = structuredClone(d.parameters);
    delete p.magic.fire;
    return { ...d, parameters: p };
  }), /missing magic\.fire/);
  assert.throws(bad((d) => {
    const p = structuredClone(d.parameters);
    delete p.abilities.strength;
    return { ...d, parameters: p };
  }), /missing abilities\.strength/);
  // Malformed equipment (effects missing a numeric key).
  assert.throws(bad((d) => ({ ...d, equipment: { slots: {}, effects: { attack: 1 } } })), /equipment\.effects\.defense must be a number/);
  assert.ok(base);
});

test('arenaStep fail-fasts on an unknown action type and a missing root', async () => {
  const root = await arenaRoot([]);
  const match = createArenaMatch({
    seed: 1,
    teamA: [actor('hero', { controller: 'player', kind: 'protagonist', agi: 90, reserve: 0 })],
    teamB: [actor('foe', { agi: 5 })]
  });
  await assert.rejects(() => arenaStep({ root, match, action: { type: 'descend' } }), /unknown arena action type/);
  await assert.rejects(() => arenaStep({ match, action: { type: 'wait' } }), /root is required/);
});

test('runArenaMatchAuto refuses a match that contains a player controller', async () => {
  await assert.rejects(
    () => runArenaMatchAuto({ root: null, seed: 1, teamA: [actor('hero', { controller: 'player', kind: 'protagonist' })], teamB: [actor('foe')] }),
    /requires an all-AI match/
  );
});
