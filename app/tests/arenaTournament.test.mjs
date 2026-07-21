// Arena tournament layer (B2): the weekly seeded 16-unit single-elimination bracket, entry modes, NPC
// auto-resolution through the real engine, deterministic spectator replay, the interactive player-match
// flow (start / action / resume / auto-conclude / 4-win championship), the win-count reward (money +
// materials, granted exactly once), the kind-arena content result, the routing wiring, and every fail-fast.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { definitionsRoot, projectRoot } from './testPaths.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

import {
  ARENA_BRACKET_UNIT_COUNT, ARENA_MODES,
  arenaWeekSeed, arenaUnitSizeForMode, selectArenaOpponentCharacterIds, assembleArenaUnits,
  createArenaTournamentSlot, validateArenaTournamentSlot, advanceArenaTournament,
  findPlayerCurrentMatch, arenaTournamentWins, isArenaTournamentTerminal, arenaTournamentOutcome,
  computeArenaReward, ARENA_REWARD_TABLE, arenaMatchTeams, findArenaReplayMatch, arenaTournamentView,
  ARENA_TOURNAMENT_STATE_KEY
} from '../src/arena/arenaTournament.mjs';
import { runArenaMatchAuto, createArenaMatch } from '../src/arena/arenaEngine.mjs';
import {
  getArenaState, enterArenaTournament, startArenaMatch, applyArenaMatchAction,
  concludeArenaTournament, replayArenaMatch
} from '../src/arena/arenaSession.mjs';
import { buildArenaContentResult, validateRoutingContentResult, readRoutingContentResult } from '../src/routingContentResult.mjs';
import { routingDestinations } from '../src/routingDestinations.mjs';
import { resolveRoutingDestinationDispatch } from '../src/routingDispatch.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import { canHandleArenaApiRoute, handleArenaApi } from '../src/server/arenaApi.mjs';

const ELEMENTS = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];

function params(value) {
  const magic = Object.fromEntries(ELEMENTS.map((key) => [key, { value }]));
  const abilities = {
    strength: { value }, agility: { value }, academics: { value }, magical_power: { value }, charisma: { value }
  };
  return { magic, abilities };
}

function protagonistInput(value) {
  return { parameters: params(value), equipment: null, mp_reserve_percent: 30 };
}

function buddyInput(value, { kind = 'character', characterId = 'character_100' } = {}) {
  return { character_id: characterId, display_name: `buddy-${characterId}`, kind, parameters: params(value), equipment: null, mp_reserve_percent: 30 };
}

// `count` opponent inputs with distinct ids and (optionally varied) strength.
function opponentInputs(count, valueFor = () => 5, startIndex = 1) {
  return Array.from({ length: count }, (_, i) => {
    const id = `character_${String(startIndex + i).padStart(3, '0')}`;
    return { character_id: id, display_name: `opp-${id}`, parameters: params(valueFor(i)), mp_reserve_percent: 30 };
  });
}

function buildSlot({ mode, week = 3, protagonist, buddy = null, opponents }) {
  const seed = arenaWeekSeed(week);
  const { playerUnit, opponentUnits } = assembleArenaUnits({ mode, protagonist, buddy, opponents });
  return createArenaTournamentSlot({ seed, week, mode, playerUnit, opponentUnits });
}

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

// A root carrying the material catalog + alchemy + gathering + inventory (so arenaStep's consumable
// loading and the reward grant resolve), plus a runtime_state carrying the injected tournament slot.
async function arenaRoot({ money = 1000, state = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-arena-b2-'));
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await fs.copyFile(
    path.join(definitionsRoot, 'gathering_points.json'),
    path.join(root, 'data/definitions/game_data/gathering_points.json')
  );
  await writeJson(root, 'data/mutable/game_data/player_inventory.json', {
    money, items: [], applied_money_delta_conversation_ids: []
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    elapsed_weeks: 3, current_buddy_character_id: null, current_enemy_character_ids: [], ...state
  });
  return root;
}

async function injectSlot(root, slot) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { ...state, [ARENA_TOURNAMENT_STATE_KEY]: slot });
}

async function readInventory(root) {
  return readJson(root, 'data/mutable/game_data/player_inventory.json');
}

// A root carrying the real selectable roster (content/characters + seeded standee manifests) plus the
// economy definitions and a runtime_state, so enterArenaTournament's full descriptor-gathering path runs.
function pad(index) {
  return String(index).padStart(3, '0');
}

async function seedVisualSetStandeeManifest(root, visualSetId) {
  const sourcePath = path.join(projectRoot, 'assets/canonical/character_visual_sets', visualSetId, 'manifest.json');
  const sourceManifest = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  await writeJson(root, `assets/canonical/character_visual_sets/${visualSetId}/manifest.json`, {
    scene_standee: sourceManifest.scene_standee
  });
  const standeePath = path.join(root, 'assets/canonical/character_visual_sets', visualSetId, sourceManifest.scene_standee.path);
  await fs.mkdir(path.dirname(standeePath), { recursive: true });
  await fs.writeFile(standeePath, 'standee');
}

async function arenaEnterRoot({ week = 3, buddy = null, enemies = [], money = 1000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-arena-enter-'));
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await fs.copyFile(
    path.join(definitionsRoot, 'gathering_points.json'),
    path.join(root, 'data/definitions/game_data/gathering_points.json')
  );
  await writeJson(root, 'data/mutable/game_data/player_inventory.json', {
    money, items: [], applied_money_delta_conversation_ids: []
  });
  await fs.cp(path.join(projectRoot, 'content/characters'), path.join(root, 'content/characters'), { recursive: true });
  for (let index = 1; index <= 172; index += 1) {
    await seedVisualSetStandeeManifest(root, `visual_set_${pad(index)}`);
  }
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, elapsed_weeks: week, current_screen: 'interaction',
    current_buddy_character_id: buddy, current_enemy_character_ids: enemies, global_flags: {}, characters: {}
  });
  return root;
}

// ----- routing wiring -----

test('闘技会 is a permanent (non-gated) routing destination that dispatches to academy-arena', () => {
  const arena = routingDestinations.find((destination) => destination.id === 'arena');
  assert.ok(arena, 'arena destination is registered');
  assert.equal(arena.label, '闘技会');

  const dispatch = resolveRoutingDestinationDispatch('arena');
  assert.equal(dispatch.next_screen, 'academy-arena');

  // Non-gated: it is auto-included in the candidate set with no unlock signal.
  const state = { elapsed_weeks: 3 };
  const ids = routingDestinationsForState(state, []).map((destination) => destination.id);
  assert.ok(ids.includes('arena'), 'arena is a default candidate');
});

test('the routing meta context renders the 闘技会 仕組み line only when arena_context is present', () => {
  const base = {
    persona_variant: 'fallen_star',
    recent_conversation_context: { kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null },
    relationship_context: { buddy: null, enemies: [] },
    alchemy_context: { recipe_count: 10 },
    study_circle_context: { theme_count: 20, weekly_offer_count: 3 },
    content_result_context: null
  };
  // The destination catalog line ('- 闘技会: <description>') always renders; the 仕組み line (unique phrase
  // 'シングルエリミネーション') renders only when arena_context is supplied.
  const withoutArena = buildRoutingMetaContext({ state: { elapsed_weeks: 3 }, routingHubContext: base });
  assert.ok(!withoutArena.includes('シングルエリミネーション'), 'no 仕組み line without arena_context');
  const withArena = buildRoutingMetaContext({ state: { elapsed_weeks: 3 }, routingHubContext: { ...base, arena_context: { bracket_size: 16 } } });
  assert.ok(withArena.includes('闘技会: 週替わりの16枠シングルエリミネーション'), 'renders the arena 仕組み line');
});

// ----- content result -----

test('buildArenaContentResult validates the kind-arena detail shape and enforces reward consistency', () => {
  const champion = buildArenaContentResult({
    week: 3, now: '2026-07-10T00:00:00.000Z', outcome: 'champion', mode: 'solo', wins: 4,
    prizeMoney: 1600, materials: [{ item_id: 'material_fire_t1', display_name: '火片', quantity: 4 }]
  });
  assert.equal(champion.kind, 'arena');
  assert.equal(champion.destination_id, 'arena');
  assert.equal(champion.detail.wins, 4);
  // Round-trips through the public validator.
  assert.deepEqual(validateRoutingContentResult(champion), champion);

  // 0 wins must carry no prize.
  assert.throws(() => buildArenaContentResult({
    week: 3, now: 't', outcome: 'eliminated', mode: 'solo', wins: 0, prizeMoney: 100, materials: []
  }), /0 wins/);
  // spectate mode requires a spectated_* outcome.
  assert.throws(() => buildArenaContentResult({
    week: 3, now: 't', outcome: 'champion', mode: 'spectate', wins: 4, prizeMoney: 1600, materials: []
  }), /does not match outcome/);
  // champion must be 4 wins.
  assert.throws(() => buildArenaContentResult({
    week: 3, now: 't', outcome: 'champion', mode: 'solo', wins: 3, prizeMoney: 700, materials: []
  }), /does not match wins/);
});

// ----- deterministic bracket construction per mode -----

test('each mode builds a 16-unit bracket with the correct unit sizes and player-unit placement', () => {
  const solo = buildSlot({ mode: 'solo', protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  validateArenaTournamentSlot(solo);
  assert.equal(solo.units.length, ARENA_BRACKET_UNIT_COUNT);
  assert.ok(solo.units.every((unit) => unit.actors.length === 1));
  const soloPlayer = solo.units.find((unit) => unit.unit_id === solo.player_unit_id);
  assert.equal(soloPlayer.actors[0].kind, 'protagonist');
  assert.equal(soloPlayer.actors[0].controller, 'player');

  const pair = buildSlot({ mode: 'pair', protagonist: protagonistInput(30), buddy: buddyInput(25), opponents: opponentInputs(30) });
  validateArenaTournamentSlot(pair);
  assert.ok(pair.units.every((unit) => unit.actors.length === 2), 'every pair unit has 2 actors');
  const pairPlayer = pair.units.find((unit) => unit.unit_id === pair.player_unit_id);
  assert.deepEqual(pairPlayer.actors.map((a) => a.controller), ['player', 'ai']);

  const spectate = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: buddyInput(25), opponents: opponentInputs(15) });
  validateArenaTournamentSlot(spectate);
  const spectatePlayer = spectate.units.find((unit) => unit.unit_id === spectate.player_unit_id);
  assert.equal(spectatePlayer.actors.length, 1);
  assert.equal(spectatePlayer.actors[0].actor_id, 'character_100'); // the buddy fights alone
  assert.equal(spectatePlayer.actors[0].controller, 'ai');
});

test('a homunculus buddy fields in pair (2v2) and spectate brackets', () => {
  const homBuddy = buddyInput(40, { kind: 'homunculus', characterId: 'homunculus_001' });
  const pair = buildSlot({ mode: 'pair', protagonist: protagonistInput(30), buddy: homBuddy, opponents: opponentInputs(30) });
  const pairPlayer = pair.units.find((unit) => unit.unit_id === pair.player_unit_id);
  assert.equal(pairPlayer.actors[1].kind, 'homunculus');
  const spectate = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: homBuddy, opponents: opponentInputs(15) });
  const spectatePlayer = spectate.units.find((unit) => unit.unit_id === spectate.player_unit_id);
  assert.equal(spectatePlayer.actors[0].kind, 'homunculus');
});

// The bracket unit view carries every actor's entry-snapshot parameters + equipment so the name-click detail reads
// the arena snapshot for ALL actors (snapshot strict). A protagonist / buddy carries its equipment; an NPC opponent
// fields equipment: null.
test('the bracket unit view projects entry-snapshot parameters + equipment for every actor', () => {
  const homBuddy = buddyInput(40, { kind: 'homunculus', characterId: 'homunculus_001' });
  const pair = buildSlot({ mode: 'pair', protagonist: protagonistInput(30), buddy: homBuddy, opponents: opponentInputs(30) });
  const view = arenaTournamentView(pair);
  const player = view.units.find((unit) => unit.unit_id === view.player_unit_id);
  const protagonist = player.actors.find((actor) => actor.kind === 'protagonist');
  const homunculus = player.actors.find((actor) => actor.kind === 'homunculus');
  assert.ok(protagonist.parameters && protagonist.parameters.magic && protagonist.parameters.abilities, 'the protagonist identity carries its snapshot parameters');
  assert.equal(protagonist.equipment, null, 'the protagonist equipment (none set here) projects as null');
  assert.ok(homunculus.parameters && homunculus.parameters.magic && homunculus.parameters.abilities, 'the homunculus identity carries its snapshot parameters');
  assert.ok('equipment' in homunculus, 'the homunculus identity carries its equipment field');
  // A character opponent carries its parameters and a null equipment (NPC entrants fight bare — Lead-fixed v1).
  const opponentUnit = view.units.find((unit) => unit.unit_id !== view.player_unit_id);
  assert.ok(opponentUnit.actors.every((actor) => actor.parameters && actor.parameters.magic && actor.parameters.abilities), 'a character opponent identity carries its snapshot parameters');
  assert.ok(opponentUnit.actors.every((actor) => actor.equipment === null), 'a character opponent identity carries equipment: null');
});

// End-to-end read-path enrich: entering with an active homunculus buddy fills the homunculus actor's face_url in
// the bracket unit view and the live match view, from the atelier (character / protagonist untouched).
test('an active homunculus buddy is enriched with its face_url across the arena views (session)', async () => {
  const homunculusId = 'homunculus_001';
  const faceId = 'hp_007';
  const root = await arenaEnterRoot({ buddy: homunculusId });
  await writeJson(root, 'data/mutable/game_data/homunculi.json', {
    version: 1,
    active: [{ homunculus_id: homunculusId, display_name: 'ヴィオラ', face_id: faceId, created_week: 3 }],
    nameplates: []
  });
  await writeJson(root, `data/mutable/game_data/homunculi/${homunculusId}/profile.json`, {
    character_id: homunculusId, display_name: 'ヴィオラ',
    prompt_description: 'x', speaking_basis: 'y', parameters: params(40)
  });
  await enterArenaTournament({ root, mode: 'pair', postContentScreen: 'interaction' });

  const state = await getArenaState({ root });
  const player = state.units.find((unit) => unit.unit_id === state.player_unit_id);
  const homunculus = player.actors.find((actor) => actor.kind === 'homunculus');
  assert.ok(homunculus, 'the player unit has a homunculus actor');
  assert.match(homunculus.face_url, new RegExp(faceId), 'the bracket homunculus actor is enriched with its atelier face_url');
  const protagonist = player.actors.find((actor) => actor.kind === 'protagonist');
  assert.ok(!('face_url' in protagonist), 'the protagonist is not enriched with a face_url');

  const started = await startArenaMatch({ root });
  const matchHomunculus = started.view.actors.find((actor) => actor.kind === 'homunculus');
  assert.ok(matchHomunculus, 'the live match board carries the homunculus actor');
  assert.match(matchHomunculus.face_url, new RegExp(faceId), 'the match-view homunculus actor is enriched with its face_url');
  assert.ok(matchHomunculus.parameters?.magic, 'the match-view homunculus actor carries its parameters');
  const matchProtagonist = started.view.actors.find((actor) => actor.kind === 'protagonist');
  assert.ok(!('face_url' in matchProtagonist), 'the protagonist match actor is not face-enriched (no face_url)');
  assert.ok(matchProtagonist.parameters?.magic, 'the protagonist match actor carries its snapshot parameters');
  assert.ok('equipment' in matchProtagonist, 'the protagonist match actor carries its equipment field');
});

test('the same (seed, mode, roster) reproduces the same bracket; a new week changes it', () => {
  const a = buildSlot({ mode: 'solo', week: 3, protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  const b = buildSlot({ mode: 'solo', week: 3, protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  const c = buildSlot({ mode: 'solo', week: 8, protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  assert.notDeepEqual(a.leaf_order, c.leaf_order);
});

test('pair mode pairs opponents consecutively into 2-actor units', () => {
  const opponents = opponentInputs(30);
  const { opponentUnits } = assembleArenaUnits({ mode: 'pair', protagonist: protagonistInput(30), buddy: buddyInput(25), opponents });
  assert.equal(opponentUnits.length, ARENA_BRACKET_UNIT_COUNT - 1);
  assert.deepEqual(opponentUnits[0].actors.map((a) => a.actor_id), ['character_001', 'character_002']);
  assert.deepEqual(opponentUnits[1].actors.map((a) => a.actor_id), ['character_003', 'character_004']);
});

// ----- opponent selection: enemy priority + fail-fast -----

test('selectArenaOpponentCharacterIds includes enemies first, is deterministic, and fails fast', () => {
  const pool = Array.from({ length: 40 }, (_, i) => `character_${String(i + 1).padStart(3, '0')}`);
  const seed = arenaWeekSeed(3);
  const selected = selectArenaOpponentCharacterIds({ seed, pool, enemyIds: ['character_037', 'character_012'], count: 15 });
  assert.equal(selected.length, 15);
  assert.ok(selected.includes('character_037') && selected.includes('character_012'), 'enemies are guaranteed inclusion');
  const again = selectArenaOpponentCharacterIds({ seed, pool, enemyIds: ['character_037', 'character_012'], count: 15 });
  assert.deepEqual(selected, again, 'deterministic');

  assert.throws(() => selectArenaOpponentCharacterIds({ seed, pool, enemyIds: ['character_999'], count: 15 }), /not in the selectable opponent pool/);
  assert.throws(() => selectArenaOpponentCharacterIds({ seed, pool: pool.slice(0, 10), enemyIds: [], count: 15 }), /too small to fill/);
});

test('enemy characters are guaranteed a seat in the built bracket', () => {
  const pool = Array.from({ length: 40 }, (_, i) => `character_${String(i + 1).padStart(3, '0')}`);
  const seed = arenaWeekSeed(3);
  const selectedIds = selectArenaOpponentCharacterIds({ seed, pool, enemyIds: ['character_030'], count: 15 });
  const opponents = selectedIds.map((id) => ({ character_id: id, display_name: id, parameters: params(5), mp_reserve_percent: 30 }));
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(30), opponents });
  const allActorIds = slot.units.flatMap((unit) => unit.actors.map((a) => a.actor_id));
  assert.ok(allActorIds.includes('character_030'), 'the enemy is drafted into the bracket');
});

// ----- NPC auto-resolution + deterministic replay -----

test('spectate brackets resolve every match through the real engine, deterministically, and replay identically', async () => {
  const root = await arenaRoot();
  const opponents = opponentInputs(15, (i) => 8 + i);
  const slot = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: buddyInput(20), opponents });
  await advanceArenaTournament(slot, { root });
  // Every match resolved (no player match gates a spectate bracket).
  assert.ok(slot.matches.every((match) => match.winner_unit_id !== null), 'all matches resolved');
  assert.ok(isArenaTournamentTerminal(slot), 'the buddy path reached a terminal result');

  // Determinism: a second independent build resolves to identical winners.
  const slot2 = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: buddyInput(20), opponents });
  await advanceArenaTournament(slot2, { root });
  assert.deepEqual(slot.matches.map((m) => m.winner_unit_id), slot2.matches.map((m) => m.winner_unit_id));

  await injectSlot(root, slot);
  const round0 = slot.matches.find((match) => match.round === 0);
  const replayA = await replayArenaMatch({ root, matchId: round0.match_id });
  const replayB = await replayArenaMatch({ root, matchId: round0.match_id });
  assert.deepEqual(replayA.turns, replayB.turns, 'identical replay for the same match');
  assert.ok(replayA.turns.length > 0);
  // The replay's engine winner agrees with the recorded bracket winner.
  const { teamA, teamB } = arenaMatchTeams(slot, round0);
  const engine = await runArenaMatchAuto({ root, seed: round0.seed, teamA, teamB });
  const recorded = engine.winner === 'a' ? round0.team_a_unit_id : round0.team_b_unit_id;
  assert.equal(recorded, round0.winner_unit_id);
});

test('the spectator replay first frame through replayArenaMatch is the spawn placement, not one AI move later', async () => {
  const root = await arenaRoot();
  const opponents = opponentInputs(15, (i) => 8 + i);
  const slot = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: buddyInput(20), opponents });
  await advanceArenaTournament(slot, { root });
  await injectSlot(root, slot);
  const round0 = slot.matches.find((match) => match.round === 0);
  const replay = await replayArenaMatch({ root, matchId: round0.match_id });

  // The true start is createArenaMatch's spawn placement, before any resolveAiTurn.
  const { teamA, teamB } = arenaMatchTeams(slot, round0);
  const spawnMatch = createArenaMatch({ seed: round0.seed, teamA, teamB });
  const expectedSpawn = spawnMatch.actors.map((a) => ({ id: a.actor_id, x: a.x, y: a.y }));
  const firstFrame = replay.turns[0].view.actors.map((a) => ({ id: a.actor_id, x: a.x, y: a.y }));
  assert.deepEqual(firstFrame, expectedSpawn, 'first spectator frame is the spawn placement');
  assert.deepEqual(replay.turns[0].events, [], 'the spawn frame carries no events');
});

// ----- interactive player-match flow -----

// Drives the player through their matches with a fixed action until the tournament concludes.
async function playThrough(root, action) {
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
    const slot = state[ARENA_TOURNAMENT_STATE_KEY];
    if (slot.status === 'concluded') return slot;
    await startArenaMatch({ root, authoringRoot: root });
    let ended = false;
    let innerGuard = 0;
    while (!ended && innerGuard < 200) {
      innerGuard += 1;
      const result = await applyArenaMatchAction({ root, authoringRoot: root, action, postContentScreen: 'interaction' });
      if (result.view.status !== 'active') {
        ended = true;
        if (result.concluded) return (await readJson(root, 'data/mutable/game_data/runtime_state.json'))[ARENA_TOURNAMENT_STATE_KEY];
      }
    }
    assert.ok(ended, 'the player match resolved');
  }
  throw new Error('playThrough did not converge');
}

test('a dominant protagonist plays start/action across 4 rounds to the championship, then rewards land once', async () => {
  const root = await arenaRoot({ money: 1000 });
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(99), opponents: opponentInputs(15, () => 1) });
  await advanceArenaTournament(slot, { root });
  assert.equal(arenaTournamentWins(slot), 0);
  await injectSlot(root, slot);

  const concluded = await playThrough(root, { type: 'cast', element: 'fire' });
  assert.equal(concluded.status, 'concluded');
  assert.equal(concluded.outcome, 'champion');
  assert.equal(arenaTournamentWins(concluded), 4);

  const inventory = await readInventory(root);
  assert.equal(inventory.money, 1000 + ARENA_REWARD_TABLE[4].money, 'champion prize money paid');
  const materialCount = inventory.items.reduce((sum, item) => sum + item.quantity, 0);
  assert.equal(materialCount, 4 + 4, 'T1x4 + T2x4 deposited');

  // The content result was written for the hub.
  const record = readRoutingContentResult(await readJson(root, 'data/mutable/game_data/runtime_state.json'));
  assert.equal(record.kind, 'arena');
  assert.equal(record.detail.outcome, 'champion');
  assert.equal(record.detail.wins, 4);
  assert.equal(record.detail.prize_money, ARENA_REWARD_TABLE[4].money);
});

test('when the protagonist is eliminated the rest of the bracket auto-resolves and the tournament concludes', async () => {
  const root = await arenaRoot({ money: 500 });
  // A frail protagonist against fast, strong opponents: the leading AI turn ends the match.
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(1), opponents: opponentInputs(15, () => 99) });
  await advanceArenaTournament(slot, { root });
  await injectSlot(root, slot);

  const concluded = await playThrough(root, { type: 'wait' });
  assert.equal(concluded.status, 'concluded');
  assert.equal(concluded.outcome, 'eliminated');
  assert.equal(arenaTournamentWins(concluded), 0);
  assert.ok(concluded.matches.every((match) => match.winner_unit_id !== null), 'remaining bracket auto-resolved');

  const inventory = await readInventory(root);
  assert.equal(inventory.money, 500, 'no prize for 0 wins');
  assert.equal(inventory.items.length, 0, 'no materials for 0 wins');
  const record = readRoutingContentResult(await readJson(root, 'data/mutable/game_data/runtime_state.json'));
  assert.equal(record.detail.prize_money, 0);
  assert.deepEqual(record.detail.materials, []);
});

test('a player match resumes from persisted state (start is idempotent while a match is in progress)', async () => {
  const root = await arenaRoot();
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(50), opponents: opponentInputs(15, () => 40) });
  await advanceArenaTournament(slot, { root });
  await injectSlot(root, slot);
  const first = await startArenaMatch({ root, authoringRoot: root });
  const firstMatchId = first.tournament.current_match_id;
  assert.ok(firstMatchId, 'a match is in progress');
  const resumed = await startArenaMatch({ root, authoringRoot: root });
  assert.equal(resumed.tournament.current_match_id, firstMatchId, 'resume returns the same in-progress match, not a new one');
});

// ----- reward idempotency -----

test('conclude pays the reward exactly once; a re-conclude is a no-op and the money key blocks a double pay', async () => {
  const root = await arenaRoot({ money: 1000 });
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(99), opponents: opponentInputs(15, () => 1) });
  await advanceArenaTournament(slot, { root });
  await injectSlot(root, slot);
  await playThrough(root, { type: 'cast', element: 'fire' });
  const afterFirst = (await readInventory(root)).money;
  assert.equal(afterFirst, 1000 + ARENA_REWARD_TABLE[4].money);

  // Re-conclude on the concluded slot: no-op.
  const concludedSlot = (await readJson(root, 'data/mutable/game_data/runtime_state.json'))[ARENA_TOURNAMENT_STATE_KEY];
  const again = await concludeArenaTournament({ root, slot: concludedSlot, postContentScreen: 'interaction', setScreen: false });
  assert.equal(again.alreadyConcluded, true);
  assert.equal((await readInventory(root)).money, afterFirst, 'no additional pay on re-conclude');

  // Crash-retry hardening: force a fresh active terminal slot (same week/seed, rewards_paid reset) and
  // conclude again. The economy synthetic key blocks a second money payment.
  const retrySlot = { ...concludedSlot, status: 'active', rewards_paid: false, outcome: null, content_result: null };
  await concludeArenaTournament({ root, slot: retrySlot, postContentScreen: 'interaction', setScreen: false });
  assert.equal((await readInventory(root)).money, afterFirst, 'the arena:<week> money key prevents a double pay');
});

test('ARENA_REWARD_TABLE win-count prize money matches the balance v2 schedule', () => {
  // Reward-balance v2 (2026-07-12): arena sits between dungeon T2 and T3. Material lines are unchanged.
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((wins) => ARENA_REWARD_TABLE[wins].money),
    [0, 100, 300, 700, 1600]
  );
});

test('computeArenaReward is deterministic per (seed, wins) and matches the table money', () => {
  const seed = arenaWeekSeed(3);
  for (const wins of [0, 1, 2, 3, 4]) {
    const reward = computeArenaReward({ seed, wins });
    assert.equal(reward.money, ARENA_REWARD_TABLE[wins].money);
    const expectedQty = ARENA_REWARD_TABLE[wins].materials.reduce((sum, line) => sum + line.quantity, 0);
    const gotQty = reward.materials.reduce((sum, material) => sum + material.quantity, 0);
    assert.equal(gotQty, expectedQty);
    assert.deepEqual(reward, computeArenaReward({ seed, wins }));
  }
});

// ----- state view + availability -----

test('the arena state returns the participate-form selection with buddy-gated modes', async () => {
  const root = await arenaRoot({ state: { current_buddy_character_id: null } });
  const view = await getArenaState({ root, authoringRoot: root });
  assert.equal(view.phase, 'selection');
  const byMode = Object.fromEntries(view.modes.map((entry) => [entry.mode, entry]));
  assert.equal(byMode.solo.available, true);
  assert.equal(byMode.pair.available, false);
  assert.equal(byMode.pair.reason, 'no_buddy');
  assert.equal(byMode.spectate.available, false);
  assert.equal(byMode.spectate.reason, 'no_buddy');
  assert.equal(view.buddy, null);
});

test('the arena state returns the bracket view once a tournament is built for the week', async () => {
  const root = await arenaRoot();
  const slot = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: buddyInput(20), opponents: opponentInputs(15, (i) => 8 + i) });
  await advanceArenaTournament(slot, { root });
  await injectSlot(root, slot);
  const view = await getArenaState({ root, authoringRoot: root });
  assert.equal(view.phase, 'tournament');
  assert.equal(view.mode, 'spectate');
  assert.equal(view.bracket.rounds.length, 4);
  assert.equal(view.bracket.rounds[0].length, 8);
});

// ----- fail-fast -----

test('enter fails fast on an unknown mode, a buddy-less pair/spectate, and a re-entry within the same week', async () => {
  const root = await arenaRoot({ state: { elapsed_weeks: 3, current_buddy_character_id: null } });
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'bogus', postContentScreen: 'interaction' }),
    (error) => error.errorCode === 'invalid_mode'
  );
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'pair', postContentScreen: 'interaction' }),
    (error) => error.errorCode === 'no_buddy'
  );
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'spectate', postContentScreen: 'interaction' }),
    (error) => error.errorCode === 'no_buddy'
  );

  const slot = buildSlot({ mode: 'solo', week: 3, protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  await injectSlot(root, slot);
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'solo', postContentScreen: 'interaction' }),
    (error) => error.errorCode === 'already_entered'
  );
});

test('enter fails fast on a missing post-content screen (caller must own the return screen)', async () => {
  const root = await arenaRoot();
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'solo', postContentScreen: '' }),
    /postContentScreen is required/
  );
});

test('start/action fail fast on spectate, a concluded tournament, and a missing active match', async () => {
  const root = await arenaRoot();
  const spectate = buildSlot({ mode: 'spectate', protagonist: protagonistInput(30), buddy: buddyInput(20), opponents: opponentInputs(15, (i) => 8 + i) });
  await advanceArenaTournament(spectate, { root });
  await injectSlot(root, spectate);
  await assert.rejects(() => startArenaMatch({ root, authoringRoot: root }), (error) => error.errorCode === 'spectate_no_match');
  await assert.rejects(
    () => applyArenaMatchAction({ root, authoringRoot: root, action: { type: 'wait' }, postContentScreen: 'interaction' }),
    (error) => error.errorCode === 'no_active_match'
  );

  const soloConcluded = buildSlot({ mode: 'solo', protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  const concluded = validateArenaTournamentSlot({ ...soloConcluded, status: 'concluded', rewards_paid: true, outcome: 'eliminated' });
  await injectSlot(root, concluded);
  await assert.rejects(() => startArenaMatch({ root, authoringRoot: root }), (error) => error.errorCode === 'concluded');
});

test('replay fails fast for a player match, an unresolved match, and an unknown id', async () => {
  const root = await arenaRoot();
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(50), opponents: opponentInputs(15, () => 40) });
  await advanceArenaTournament(slot, { root });
  await injectSlot(root, slot);
  const playerMatch = findPlayerCurrentMatch(slot);
  assert.ok(playerMatch, 'a player match is pending');
  // A player match has no spectator replay.
  assert.throws(() => findArenaReplayMatch(slot, playerMatch.match_id), (error) => error.statusCode === 409);
  // An unresolved future match.
  assert.throws(() => findArenaReplayMatch(slot, 'r3_m0'), (error) => error.statusCode === 409);
  // An unknown id.
  await assert.rejects(() => replayArenaMatch({ root, matchId: 'nope' }), (error) => error.statusCode === 404);
});

test('slot validation rejects a corrupt vocabulary and a malformed shape', () => {
  const slot = buildSlot({ mode: 'solo', protagonist: protagonistInput(30), opponents: opponentInputs(15) });
  assert.throws(() => validateArenaTournamentSlot({ ...slot, status: 'weird' }), /status must be one of/);
  assert.throws(() => validateArenaTournamentSlot({ ...slot, mode: 'duel' }), /mode must be one of/);
  const { player_unit_id, ...missing } = slot;
  assert.throws(() => validateArenaTournamentSlot(missing), /missing required key/);
});

// ----- routing-only HTTP guard (loop mode never reaches arena) -----

// ----- enterArenaTournament success path (full session orchestration over the real roster) -----

test('spectate enter builds + fully resolves the bracket, pays the buddy-win reward once, and writes a spectated content result', async (t) => {
  const root = await arenaEnterRoot({ week: 3, buddy: 'character_002', money: 1000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const view = await enterArenaTournament({ root, authoringRoot: root, mode: 'spectate', postContentScreen: 'interaction' });
  assert.equal(view.phase, 'tournament');
  assert.equal(view.mode, 'spectate');
  assert.equal(view.status, 'concluded');
  assert.ok(['spectated_champion', 'spectated_eliminated'].includes(view.outcome), 'a spectated outcome');
  const wins = view.wins;

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const record = readRoutingContentResult(state);
  assert.equal(record.kind, 'arena');
  assert.equal(record.detail.mode, 'spectate');
  assert.equal(record.detail.outcome, view.outcome);
  assert.equal(record.detail.wins, wins);

  const inventory = await readInventory(root);
  assert.equal(inventory.money, 1000 + ARENA_REWARD_TABLE[wins].money, 'buddy win-count prize paid');
  const expectedMaterials = ARENA_REWARD_TABLE[wins].materials.reduce((sum, line) => sum + line.quantity, 0);
  assert.equal(inventory.items.reduce((sum, item) => sum + item.quantity, 0), expectedMaterials, 'buddy win-count materials deposited');
});

test('solo enter persists a valid 16-unit bracket with enemy priority, auto-resolves the non-player matches, and sets the arena screen', async (t) => {
  const root = await arenaEnterRoot({ week: 5, buddy: null, enemies: ['character_050'] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const view = await enterArenaTournament({ root, authoringRoot: root, mode: 'solo', postContentScreen: 'interaction' });
  assert.equal(view.phase, 'tournament');
  assert.equal(view.mode, 'solo');
  assert.equal(view.status, 'active');
  assert.equal(view.units.length, 16);
  const playerUnit = view.units.find((unit) => unit.is_player_unit);
  assert.equal(playerUnit.actors[0].kind, 'protagonist');
  assert.equal(playerUnit.actors[0].controller, 'player');

  const allActorIds = view.units.flatMap((unit) => unit.actors.map((actor) => actor.actor_id));
  assert.ok(allActorIds.includes('character_050'), 'the enemy is drafted into the bracket');

  const round0 = view.bracket.rounds[0];
  const playerMatches = round0.filter((match) => match.is_player_match);
  assert.equal(playerMatches.length, 1, 'exactly one player match in round 0');
  assert.equal(playerMatches[0].resolved, false, 'the player match is pending interactive play');
  assert.ok(round0.filter((match) => !match.is_player_match).every((match) => match.resolved), 'non-player round-0 matches auto-resolved');

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(state.current_screen, 'academy-arena', 'the arena screen is set while active');
});

test('enter fails fast on a non-active homunculus buddy and on a non-selectable enemy id (session layer)', async (t) => {
  const root = await arenaEnterRoot({ week: 3 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // A homunculus buddy that is not active in the atelier (no surface) throws — never a silent drop.
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, elapsed_weeks: 3, current_screen: 'interaction',
    current_buddy_character_id: 'homunculus_001', current_enemy_character_ids: [], global_flags: {}, characters: {}
  });
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'spectate', postContentScreen: 'interaction' }),
    /not active in the atelier/
  );

  // An enemy id outside the selectable roster is corrupt input and throws.
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, elapsed_weeks: 3, current_screen: 'interaction',
    current_buddy_character_id: null, current_enemy_character_ids: ['homunculus_009'], global_flags: {}, characters: {}
  });
  await assert.rejects(
    () => enterArenaTournament({ root, authoringRoot: root, mode: 'solo', postContentScreen: 'interaction' }),
    /not a selectable character/
  );
});

test('the arena HTTP handler rejects loop mode so loop runtime_state is never touched', async () => {
  assert.equal(canHandleArenaApiRoute('GET', '/api/arena/state'), true);
  assert.equal(canHandleArenaApiRoute('GET', '/api/arena/match/r0_m1/replay'), true);
  assert.equal(canHandleArenaApiRoute('POST', '/api/arena/nope'), false);

  let captured = null;
  const sendJson = (res, body, statusCode = 200) => { captured = { body, statusCode }; };
  await handleArenaApi({
    req: { method: 'GET' },
    res: {},
    url: { pathname: '/api/arena/state' },
    context: { root: '/tmp/unused' },
    sendJson,
    readBody: async () => ({}),
    activePlayMode: { mode: 'loop' }
  });
  assert.equal(captured.statusCode, 409);
  assert.equal(captured.body.error_code, 'ROUTING_MODE_REQUIRED');
});
