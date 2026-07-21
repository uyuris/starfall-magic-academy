import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_MODES,
  ARENA_MODE_LABELS,
  ARENA_MODE_DESCRIPTIONS,
  ARENA_OUTCOMES,
  arenaOutcomeLabel,
  arenaActionErrorText,
  arenaModeUnavailableReasonText,
  validateArenaState,
  validateArenaMatchView,
  validateArenaContentResult,
  validateArenaReplay
} from '../public/arenaClient.js';

// ----- fixtures -----

// The entry-snapshot parameters every arena actor carries (11-value magic + ability meters). Only the {magic,
// abilities} object shape is part of the client contract; the deep value validation lives at render time.
function fixtureParameters() {
  return {
    magic: { light: { value: 10 }, dark: { value: 10 }, fire: { value: 10 }, water: { value: 10 }, earth: { value: 10 }, wind: { value: 10 } },
    abilities: { strength: { value: 10 }, agility: { value: 10 }, academics: { value: 10 }, magical_power: { value: 10 }, charisma: { value: 10 } }
  };
}

function matchActor(overrides = {}) {
  return {
    actor_id: 'a1', name: '主人公', kind: 'protagonist', team: 'a', controller: 'player',
    x: 1, y: 1, hp: 40, max_hp: 40, mp: 20, max_mp: 20, element: 'fire', down: false,
    parameters: fixtureParameters(), equipment: null, ...overrides
  };
}

function matchView(overrides = {}) {
  return {
    match_id: 'r0_m0', seed: 7, round: 0, status: 'active', winner: null, active: true,
    width: 3, height: 2,
    tiles: [['floor', 'floor', 'floor'], ['floor', 'wall', 'floor']],
    actors: [matchActor(), matchActor({ actor_id: 'b1', name: '相手', team: 'b', controller: 'ai', x: 2, y: 0 })],
    log: ['試合開始'], events: [],
    ...overrides
  };
}

function playerMatchView(overrides = {}) {
  return matchView({
    player_actor_id: 'a1',
    castable_elements: [{ element: 'fire', label: '火', mp_cost: 4, power: 30 }],
    healing_spell: { action_type: 'heal_spell', mp_cost: 6, heal_amount: 12, recoverable_hp: 12, can_use: true },
    consumables: [],
    revive_used: false,
    ...overrides
  });
}

function bracketUnits() {
  return Array.from({ length: 16 }, (_, index) => ({
    unit_id: `u${index}`,
    is_player_unit: index === 0,
    actors: [{ actor_id: `u${index}a`, name: `選手${index}`, kind: index === 0 ? 'protagonist' : 'character', controller: index === 0 ? 'player' : 'ai', parameters: fixtureParameters(), equipment: null }]
  }));
}

function bracketRounds() {
  // Round 0: 8 seeded matches; rounds 1-3 start with null participants (filled as winners resolve).
  const rounds = [];
  const roundSizes = [8, 4, 2, 1];
  roundSizes.forEach((count, round) => {
    rounds.push(Array.from({ length: count }, (_, index) => ({
      match_id: `r${round}_m${index}`,
      round,
      index,
      team_a_unit_id: round === 0 ? `u${index * 2}` : null,
      team_b_unit_id: round === 0 ? `u${index * 2 + 1}` : null,
      winner_unit_id: null,
      is_player_match: round === 0 && index === 0,
      is_auto: false,
      resolved: false
    })));
  });
  return rounds;
}

function tournamentState(overrides = {}) {
  return {
    phase: 'tournament', week: 3, mode: 'solo', status: 'active', player_unit_id: 'u0', wins: 0,
    terminal: false, outcome: null, units: bracketUnits(), bracket: { rounds: bracketRounds() },
    current_match_id: null, content_result: null, current_match: null, ...overrides
  };
}

function selectionState(overrides = {}) {
  return {
    phase: 'selection', week: 3,
    modes: [
      { mode: 'solo', available: true, reason: null },
      { mode: 'pair', available: false, reason: 'no_buddy' },
      { mode: 'spectate', available: false, reason: 'no_buddy' }
    ],
    buddy: null, ...overrides
  };
}

// ----- label maps -----

test('the arena mode labels/descriptions cover exactly the three modes', () => {
  assert.deepEqual(ARENA_MODES, ['solo', 'pair', 'spectate']);
  for (const mode of ARENA_MODES) {
    assert.equal(typeof ARENA_MODE_LABELS[mode], 'string');
    assert.equal(typeof ARENA_MODE_DESCRIPTIONS[mode], 'string');
  }
});

test('arenaOutcomeLabel maps every outcome and throws on an unknown one', () => {
  for (const outcome of ARENA_OUTCOMES) assert.equal(typeof arenaOutcomeLabel(outcome), 'string');
  assert.throws(() => arenaOutcomeLabel('draw'), /unknown arena outcome/);
});

test('arenaActionErrorText maps the closed engine error set and throws on an unknown code', () => {
  for (const code of ['blocked', 'no_target', 'insufficient_mp', 'unknown_element', 'invalid_aim', 'invalid_target', 'revive_used', 'no_item', 'unknown_consumable', 'invalid_consumable']) {
    assert.equal(typeof arenaActionErrorText(code), 'string');
  }
  assert.throws(() => arenaActionErrorText('not_on_stairs'), /unknown arena action_error code/);
  assert.throws(() => arenaActionErrorText('descend'), /unknown arena action_error code/);
});

test('arenaModeUnavailableReasonText maps no_buddy and throws on an unknown reason', () => {
  assert.equal(arenaModeUnavailableReasonText('no_buddy'), 'バディーがいません');
  assert.throws(() => arenaModeUnavailableReasonText('busy'), /unknown arena mode unavailable reason/);
});

// ----- validateArenaState: selection -----

test('validateArenaState accepts a well-formed selection view', () => {
  const view = validateArenaState(selectionState());
  assert.equal(view.phase, 'selection');
  assert.equal(view.week, 3);
});

test('validateArenaState accepts a selection view with a buddy', () => {
  const view = validateArenaState(selectionState({
    modes: [
      { mode: 'solo', available: true, reason: null },
      { mode: 'pair', available: true, reason: null },
      { mode: 'spectate', available: true, reason: null }
    ],
    buddy: { character_id: 'character_004', display_name: 'リナ', kind: 'character' }
  }));
  assert.equal(view.buddy.display_name, 'リナ');
});

test('validateArenaState fail-fasts on an unknown phase', () => {
  assert.throws(() => validateArenaState({ phase: 'lobby' }), /state.phase must be one of/);
  assert.throws(() => validateArenaState(null), /arena state must be an object/);
});

test('validateArenaState fail-fasts on a malformed selection (wrong mode count / unknown reason)', () => {
  assert.throws(() => validateArenaState(selectionState({ modes: [{ mode: 'solo', available: true, reason: null }] })), /state.modes must list 3 modes/);
  assert.throws(() => validateArenaState(selectionState({
    modes: [
      { mode: 'solo', available: false, reason: 'busy' },
      { mode: 'pair', available: false, reason: 'no_buddy' },
      { mode: 'spectate', available: false, reason: 'no_buddy' }
    ]
  })), /unknown arena mode unavailable reason/);
});

// ----- validateArenaState: tournament -----

test('validateArenaState accepts a well-formed tournament view', () => {
  const view = validateArenaState(tournamentState());
  assert.equal(view.phase, 'tournament');
  assert.equal(view.units.length, 16);
  assert.equal(view.bracket.rounds.length, 4);
});

test('validateArenaState accepts a terminal tournament with an attached content_result', () => {
  const view = validateArenaState(tournamentState({
    status: 'concluded', terminal: true, outcome: 'champion', wins: 4,
    content_result: { outcome: 'champion', mode: 'solo', wins: 4, prize_money: 1600, materials: [] }
  }));
  assert.equal(view.terminal, true);
});

test('validateArenaState accepts a tournament with the player live match attached', () => {
  const view = validateArenaState(tournamentState({ current_match_id: 'r0_m0', current_match: playerMatchView() }));
  assert.equal(view.current_match.match_id, 'r0_m0');
});

test('validateArenaState fail-fasts on a malformed tournament (unit count / round count / bad status)', () => {
  assert.throws(() => validateArenaState(tournamentState({ units: bracketUnits().slice(0, 15) })), /state.units must list 16 units/);
  assert.throws(() => validateArenaState(tournamentState({ bracket: { rounds: bracketRounds().slice(0, 3) } })), /state.bracket.rounds must have 4 rounds/);
  assert.throws(() => validateArenaState(tournamentState({ status: 'paused' })), /state.status must be/);
});

// ----- validateArenaMatchView -----

test('validateArenaMatchView accepts a standalone (no player block) view', () => {
  assert.doesNotThrow(() => validateArenaMatchView(matchView()));
});

test('validateArenaMatchView accepts a player view and validates its player block', () => {
  assert.doesNotThrow(() => validateArenaMatchView(playerMatchView()));
});

test('validateArenaMatchView fail-fasts on a malformed present player block', () => {
  assert.throws(() => validateArenaMatchView(playerMatchView({ healing_spell: { action_type: 'heal', mp_cost: 6, heal_amount: 12, can_use: true } })), /healing_spell.action_type must be 'heal_spell'/);
  assert.throws(() => validateArenaMatchView(playerMatchView({ consumables: 'none' })), /consumables must be an array/);
});

test('validateArenaMatchView fail-fasts on a bad status, team, or tiles shape', () => {
  assert.throws(() => validateArenaMatchView(matchView({ status: 'draw' })), /status must be one of/);
  assert.throws(() => validateArenaMatchView(matchView({ actors: [matchActor({ team: 'c' })] })), /team must be 'a' or 'b'/);
  assert.throws(() => validateArenaMatchView(matchView({ tiles: [['floor', 'floor', 'floor']] })), /tiles must have 2 rows/);
});

test('validateArenaMatchView requires each actor to carry its entry-snapshot parameters + equipment', () => {
  // Every actor (protagonist / character / homunculus) carries the snapshot the name-click detail reads.
  const { parameters, ...noParams } = matchActor();
  assert.throws(() => validateArenaMatchView(matchView({ actors: [noParams] })), /parameters must be an object/);
  const { equipment, ...noEquip } = matchActor();
  assert.throws(() => validateArenaMatchView(matchView({ actors: [noEquip] })), /equipment must be an object/);
  assert.throws(() => validateArenaMatchView(matchView({ actors: [matchActor({ parameters: { magic: {} } })] })), /parameters.abilities must be an object/);
  // An equipped actor (a run-equipment {slots,...} object) and a bare NPC entrant (equipment: null) both pass.
  assert.doesNotThrow(() => validateArenaMatchView(matchView({ actors: [matchActor({ equipment: { slots: { weapon: null, amulet: null }, effects: {} } })] })));
  assert.doesNotThrow(() => validateArenaMatchView(matchView({ actors: [matchActor({ kind: 'homunculus', equipment: null })] })));
});

// ----- validateArenaContentResult -----

test('validateArenaContentResult accepts a well-formed reward detail with materials', () => {
  const detail = validateArenaContentResult({
    outcome: 'eliminated', mode: 'pair', wins: 2, prize_money: 300,
    materials: [{ item_id: 'mat_fire_t1', display_name: '火の欠片', quantity: 4 }]
  });
  assert.equal(detail.wins, 2);
  assert.equal(detail.materials[0].display_name, '火の欠片');
});

test('validateArenaContentResult fail-fasts on a broken reward detail', () => {
  assert.throws(() => validateArenaContentResult({ outcome: 'nope', mode: 'solo', wins: 0, prize_money: 0, materials: [] }), /unknown arena outcome/);
  assert.throws(() => validateArenaContentResult({ outcome: 'champion', mode: 'solo', wins: 4, prize_money: 1600, materials: [{ item_id: 'x', display_name: '', quantity: 1 }] }), /display_name must be a non-empty string/);
});

// ----- validateArenaReplay -----

test('validateArenaReplay accepts a well-formed replay envelope', () => {
  assert.doesNotThrow(() => validateArenaReplay({
    match_id: 'r0_m1', round: 0, winner_unit_id: 'u3', seed: 9,
    turns: [{ view: matchView(), events: [] }, { view: matchView({ status: 'a_won', active: false, winner: 'a' }), events: [] }]
  }));
});

test('validateArenaReplay fail-fasts on an empty turn list or a malformed turn view', () => {
  assert.throws(() => validateArenaReplay({ match_id: 'r0_m1', round: 0, winner_unit_id: 'u3', seed: 9, turns: [] }), /replay.turns must not be empty/);
  assert.throws(() => validateArenaReplay({ match_id: 'r0_m1', round: 0, winner_unit_id: 'u3', seed: 9, turns: [{ view: matchView({ width: 5 }), events: [] }] }), /tiles\[0\] must have 5 cells/);
});
