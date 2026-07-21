import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  EVASION_SPELL_DURATION,
  evasionSpellBonus,
  evasionSpellManaCost,
  pierceSpellManaCost,
  pierceSpellPower
} from '../src/dungeon/dungeonStats.mjs';
import {
  equippedEvasionSpellState,
  equippedPierceSpellState,
  meleeOutcome,
  spellOutcome
} from '../src/dungeon/combatResolution.mjs';
import { createRng, deriveSeed } from '../src/dungeon/dungeonRng.mjs';
import { enterDungeon, dungeonAction, getDungeonView } from '../src/dungeon/dungeonEngine.mjs';
import { TILE_FLOOR } from '../src/dungeon/dungeonGeneration.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

function params(overrides = {}) {
  const magic = { light: 20, dark: 20, fire: 20, water: 20, earth: 20, wind: 20, ...overrides.magic };
  const abilities = { strength: 25, agility: 25, academics: 25, magical_power: 25, charisma: 25, ...overrides.abilities };
  return {
    magic: Object.fromEntries(Object.entries(magic).map(([k, v]) => [k, { value: v }])),
    abilities: Object.fromEntries(Object.entries(abilities).map(([k, v]) => [k, { value: v }]))
  };
}

// ----- shared-core: spellOutcome defense bypass (arena byte-equivalent default) -----

test('spellOutcome ignoreDefense removes exactly the defense term (default 4-arg call is unchanged)', () => {
  const power = 100;
  const defender = { defense: 40, element: null };
  // Two fresh rngs with the same seed draw the same variance, so the only difference is the defense term.
  const withDefense = spellOutcome(createRng(123), power, null, defender);
  const ignoring = spellOutcome(createRng(123), power, null, defender, { ignoreDefense: true });
  assert.equal(ignoring.damage - withDefense.damage, Math.floor(40 / 2), 'ignoreDefense drops floor(defense/2)');
  // The default (no options) equals the explicit ignoreDefense:false — the existing callers are byte-identical.
  assert.deepEqual(spellOutcome(createRng(7), power, null, defender), spellOutcome(createRng(7), power, null, defender, { ignoreDefense: false }));
});

test('meleeOutcome respects an evasion bonus on the rollHit evasion side (boundary flips hit -> miss)', () => {
  // Find a seed whose first rollHit roll lands strictly between the buffed and unbuffed hit chances, so the
  // same roll hits without the buff and misses with it — a deterministic proof the evasion bonus is applied.
  const attacker = { attack: 20, accuracy: 80, element: null };
  const baseDefender = { evasion: 0, defense: 0, element: null };
  const buffedDefender = { evasion: 40, defense: 0, element: null }; // chance 80 -> 40
  let flipped = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const mixed = deriveSeed(seed, 12345); // spread the seed so the first hit roll is well-distributed
    const hitBase = meleeOutcome(createRng(mixed), attacker, baseDefender).hit;
    const hitBuffed = meleeOutcome(createRng(mixed), attacker, buffedDefender).hit;
    assert.ok(!(hitBuffed && !hitBase), 'a higher evasion never turns a miss into a hit');
    if (hitBase && !hitBuffed) flipped += 1;
  }
  assert.ok(flipped > 0, 'the evasion bonus flips at least one hit into a miss');
});

// ----- parameter-derived formulas -----

test('pierce power/cost scale with dark+fire; the MP band is heavier than a normal cast (4-8)', () => {
  const low = params({ magic: { dark: 0, fire: 0 } });
  const high = params({ magic: { dark: 100, fire: 100 } });
  assert.ok(pierceSpellPower(high) > pierceSpellPower(low), 'higher dark/fire raises pierce power');
  assert.equal(pierceSpellManaCost(low), 8, 'floor mastery → top of the 4-8 band');
  assert.equal(pierceSpellManaCost(high), 4, 'high mastery → bottom of the 4-8 band');
});

test('evasion bonus/cost scale with earth+wind; the duration is the tunable constant', () => {
  const low = params({ magic: { earth: 0, wind: 0 } });
  const high = params({ magic: { earth: 100, wind: 100 } });
  assert.ok(evasionSpellBonus(high) > evasionSpellBonus(low), 'higher earth/wind raises the evasion bonus');
  assert.equal(evasionSpellManaCost(low), 7);
  assert.equal(evasionSpellManaCost(high), 3);
  assert.ok(EVASION_SPELL_DURATION >= 1, 'the duration is a positive tunable');
});

test('the equipped spell states mirror the self-heal grammar (mp discount, buff-aware evasion state)', () => {
  const actor = { hp: 30, max_hp: 40, mp: 10, max_mp: 12 };
  const equipment = { effects: { spell_mp_discount: 2, self_heal_bonus: 0 } };
  const pierce = equippedPierceSpellState(actor, params(), equipment);
  assert.equal(pierce.action_type, 'pierce_spell');
  assert.equal(pierce.mp_cost, Math.max(1, pierceSpellManaCost(params()) - 2), 'equipment MP discount applies, floored at 1');
  assert.equal(pierce.power, pierceSpellPower(params()));
  assert.equal(pierce.can_use, actor.mp >= pierce.mp_cost);

  const inactive = equippedEvasionSpellState(actor, params(), equipment, null);
  assert.equal(inactive.action_type, 'evasion_spell');
  assert.equal(inactive.duration, EVASION_SPELL_DURATION);
  assert.equal(inactive.turns_remaining, 0);
  assert.equal(inactive.active, false);
  const active = equippedEvasionSpellState(actor, params(), equipment, { turns_remaining: 3, bonus: 20 });
  assert.equal(active.turns_remaining, 3);
  assert.equal(active.active, true);
  // A low-MP actor cannot use it (can_use gates on MP only).
  assert.equal(equippedEvasionSpellState({ ...actor, mp: 0 }, params(), equipment, null).can_use, false);
});

// ----- integration -----

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}
async function compositeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-composite-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '学院購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  // A high-mastery hero so the composite powers are clearly above the def-200 floor.
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', params({ magic: { dark: 80, fire: 80, earth: 80, wind: 80 } }));
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  return root;
}
async function mutateRun(root, mutate) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  mutate(state.dungeon_run, state);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
}
async function clearRun(root) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run = null;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
}
function adjacentSpot(run) {
  const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: run.player.x + dx, y: run.player.y + dy }))
    .find((cell) => run.tiles[cell.y]?.[cell.x] === TILE_FLOOR && !(cell.x === run.stairs.x && cell.y === run.stairs.y));
  if (!spot) throw new Error('no adjacent floor tile');
  return spot;
}

test('pierce ignores enemy defense: it damages a def-200 enemy far past 1, where a normal cast is floored to 1', async (t) => {
  const root = await compositeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  async function hitDefTank(actionType, element) {
    await clearRun(root);
    await enterDungeon({ root, seed: 4242 });
    let spot;
    await mutateRun(root, (run) => {
      spot = adjacentSpot(run);
      run.enemies = [{ uid: 'tank', archetype_id: 'stone_golem', name: '岩塊', element: 'earth', glyph: 'G',
        x: spot.x, y: spot.y, hp: 9999, max_hp: 9999, attack: 6, defense: 200, speed: 1 }];
      run.player.mp = 999;
      run.player.max_mp = 999;
    });
    const view = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: element ? { type: actionType, element } : { type: actionType } });
    const tank = view.enemies.find((e) => e.uid === 'tank');
    return 9999 - tank.hp;
  }

  const pierceDamage = await hitDefTank('pierce_spell', null);
  const castDamage = await hitDefTank('cast', 'dark');
  assert.equal(castDamage, 1, 'a normal cast is floored to 1 against defense 200');
  assert.ok(pierceDamage > 1, `pierce bypasses defense (dealt ${pierceDamage})`);
});

test('pierce fails fast (turn non-consuming) on insufficient MP and on no target', async (t) => {
  const root = await compositeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // No MP: the action does not pass a turn.
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => {
    const spot = adjacentSpot(run);
    run.enemies = [{ uid: 'e1', archetype_id: 'ember_imp', name: '火の精', element: 'fire', glyph: 'w', x: spot.x, y: spot.y, hp: 50, max_hp: 50, attack: 6, defense: 0, speed: 1 }];
    run.player.mp = 0;
  });
  const noMp = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'pierce_spell' } });
  assert.equal(noMp.action_error, 'insufficient_mp');
  assert.equal(noMp.turn, 0, 'a failed pierce does not advance the turn');

  // No target in sight: also a turn-non-consuming error.
  await clearRun(root);
  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.enemies = []; run.player.mp = 999; });
  const noTarget = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'pierce_spell' } });
  assert.equal(noTarget.action_error, 'no_target');
});

test('evasion is an N-turn self buff: it activates, is surfaced in the view, ticks down, refreshes, and persists across a reload', async (t) => {
  const root = await compositeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  await mutateRun(root, (run) => { run.enemies = []; run.player.mp = 999; }); // no enemies: waits just advance turns

  const cast = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'evasion_spell' } });
  // Cast turn: the buff is set to the full duration and then ticks once for this turn.
  assert.equal(cast.evasion_spell.active, true);
  assert.equal(cast.evasion_spell.turns_remaining, EVASION_SPELL_DURATION - 1);
  assert.ok(cast.evasion_spell.evasion_bonus > 0);

  // It is persisted on run state — a fresh view read reflects the same remaining turns (reload safe).
  const reread = await getDungeonView({ root });
  assert.equal(reread.evasion_spell.turns_remaining, EVASION_SPELL_DURATION - 1);

  // Waiting ticks it down each turn until it expires.
  let turnsLeft = cast.evasion_spell.turns_remaining;
  while (turnsLeft > 0) {
    const step = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'wait' } });
    turnsLeft = step.evasion_spell.turns_remaining;
  }
  const expired = await getDungeonView({ root });
  assert.equal(expired.evasion_spell.active, false, 'the buff expires after its duration');

  // Re-casting refreshes (does not stack): another cast returns to full duration (minus this turn's tick).
  const recast = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'evasion_spell' } });
  assert.equal(recast.evasion_spell.turns_remaining, EVASION_SPELL_DURATION - 1, 're-cast refreshes to full (no stacking)');

  // Evasion with no MP is a turn-non-consuming error.
  await mutateRun(root, (run) => { run.player.mp = 0; });
  const noMp = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'evasion_spell' } });
  assert.equal(noMp.action_error, 'insufficient_mp');
});

test('the view supplies both composite spell states so the UI renders without recomputing', async (t) => {
  const root = await compositeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await enterDungeon({ root, seed: 4242 });
  const view = await getDungeonView({ root });
  assert.equal(view.pierce_spell.action_type, 'pierce_spell');
  assert.equal(typeof view.pierce_spell.power, 'number');
  assert.equal(view.evasion_spell.action_type, 'evasion_spell');
  assert.equal(view.evasion_spell.duration, EVASION_SPELL_DURATION);
});
