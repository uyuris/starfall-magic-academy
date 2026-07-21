// Pure, headless-testable contract validators + label maps for the 闘技会 (arena) HTTP surface, shared by
// app.js and unit tests so the fail-fast paths — a malformed GET /api/arena/state, a POST /api/arena/enter
// tournament view, a POST /api/arena/match/start / action engine view, and a GET /api/arena/match/:id/replay
// envelope — are verified without a browser. The backend (app/src/arena/* + app/src/server/arenaApi.mjs) is
// the source of truth for these shapes; the frontend still refuses a malformed envelope BEFORE any DOM
// mutation so a broken response can never render an empty bracket, a headless board, or a phantom match
// (no silent fallback, no default-value fill).

// The three participate forms, mirroring the backend closed set (arenaTournament.mjs ARENA_MODES). The labels
// are the selection-card presentation; the ids are the exact values POST /api/arena/enter accepts.
export const ARENA_MODES = Object.freeze(['solo', 'pair', 'spectate']);
export const ARENA_MODE_LABELS = Object.freeze({ solo: '一人で参加', pair: '二人で参加', spectate: 'バディー参加の観戦' });
export const ARENA_MODE_DESCRIPTIONS = Object.freeze({
  solo: '主人公が 1 対 1 のトーナメントに出場します。',
  pair: '主人公と現バディーのペアで 2 対 2 のトーナメントに出場します。',
  spectate: 'バディーが 1 対 1 のトーナメントに単独出場し、あなたは観戦します。'
});

// The arena phases the state view can carry. selection = no tournament built this week; tournament = the
// bracket (with the player's live match attached when one is in progress).
export const ARENA_PHASES = Object.freeze(['selection', 'tournament']);

// The bracket shape constants, mirroring the backend (arenaTournament.mjs).
export const ARENA_BRACKET_UNIT_COUNT = 16;
export const ARENA_ROUND_COUNT = 4;

// The tournament outcomes and their headline labels (arenaTournament.mjs ARENA_OUTCOMES). A spectated outcome
// is the buddy's run seen from the stands. Unknown outcome throws (no default label).
export const ARENA_OUTCOMES = Object.freeze(['champion', 'eliminated', 'spectated_champion', 'spectated_eliminated']);
export const ARENA_OUTCOME_LABELS = Object.freeze({
  champion: '優勝',
  eliminated: '敗退',
  spectated_champion: 'バディー優勝',
  spectated_eliminated: 'バディー敗退'
});
export function arenaOutcomeLabel(outcome) {
  if (!Object.prototype.hasOwnProperty.call(ARENA_OUTCOME_LABELS, outcome)) {
    throw new Error(`unknown arena outcome: ${JSON.stringify(outcome)}`);
  }
  return ARENA_OUTCOME_LABELS[outcome];
}

// The selection card's disabled reason. The only reason a mode is unavailable is a missing buddy; an unknown
// reason is a desync and throws rather than painting a blank note.
export const ARENA_MODE_UNAVAILABLE_REASONS = Object.freeze({ no_buddy: 'バディーがいません' });
export function arenaModeUnavailableReasonText(reason) {
  if (!Object.prototype.hasOwnProperty.call(ARENA_MODE_UNAVAILABLE_REASONS, reason)) {
    throw new Error(`unknown arena mode unavailable reason: ${JSON.stringify(reason)}`);
  }
  return ARENA_MODE_UNAVAILABLE_REASONS[reason];
}

// The closed set of arena action_error codes the engine can surface (move / cast / heal_spell /
// use_consumable), each mapped to a player-readable line. A code outside this set is a real engine⇄frontend
// desync, so it throws (fail-fast) rather than silently painting a generic message. The arena board is
// all-visible (no fog), so invalid_aim reads "床を狙ってください" without the dungeon's 探索済み qualifier.
export const ARENA_ACTION_ERROR_MESSAGES = Object.freeze({
  blocked: 'そちらへは進めません。',
  no_target: '射程内に対象がいません。',
  insufficient_mp: 'MP が足りません。',
  unknown_element: '使えない魔法です。',
  invalid_aim: 'そこには投げられません（床を狙ってください）。',
  invalid_target: 'その相手には使えません。',
  revive_used: 'この試合では、もう蘇生させられません。',
  no_item: 'そのアイテムを持っていません。',
  unknown_consumable: 'その消耗品は使えません。',
  invalid_consumable: 'その消耗品は使えません。'
});
export function arenaActionErrorText(code) {
  if (!Object.prototype.hasOwnProperty.call(ARENA_ACTION_ERROR_MESSAGES, code)) {
    throw new Error(`unknown arena action_error code: ${JSON.stringify(code)}`);
  }
  return ARENA_ACTION_ERROR_MESSAGES[code];
}

// ----- primitive assertions (fail-fast, no default fill) -----

function arenaString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`arena: ${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function arenaInteger(value, label, { min = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value) || (min !== null && value < min)) {
    throw new Error(`arena: ${label} must be an integer${min !== null ? ` >= ${min}` : ''} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function arenaBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`arena: ${label} must be a boolean (got ${JSON.stringify(value)})`);
  return value;
}

function arenaObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`arena: ${label} must be an object (got ${JSON.stringify(value)})`);
  }
  return value;
}

function arenaArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`arena: ${label} must be an array (got ${JSON.stringify(value)})`);
  return value;
}

// ----- engine match view -----

// Every arena actor (bracket identity / match-view row) carries its entry-snapshot parameters (the 11-value magic +
// ability meters) and equipment (a run-equipment {slots, effects} object, or null for a bare NPC entrant). The
// name-click detail reads THESE snapshot values (not a roster / current-world re-resolve), so they are a required
// part of the actor contract — a missing / malformed snapshot fails fast before any detail renders.
function validateArenaActorParameters(value, label) {
  const parameters = arenaObject(value, label);
  arenaObject(parameters.magic, `${label}.magic`);
  arenaObject(parameters.abilities, `${label}.abilities`);
  return parameters;
}

function validateArenaActorEquipment(value, label) {
  if (value === null) return null;
  const equipment = arenaObject(value, label);
  arenaObject(equipment.slots, `${label}.slots`);
  return equipment;
}

// One actor row in the all-visible match view: identity + team/controller + board position + vitals + the
// entry-snapshot parameters / equipment. The element is one of the 6 magic keys (its ring tint); down marks a
// fallen actor kept off the board.
function validateArenaActor(entry, label) {
  arenaObject(entry, label);
  return {
    actor_id: arenaString(entry.actor_id, `${label}.actor_id`),
    name: arenaString(entry.name, `${label}.name`),
    kind: arenaString(entry.kind, `${label}.kind`),
    team: entry.team === 'a' || entry.team === 'b' ? entry.team : (() => { throw new Error(`arena: ${label}.team must be 'a' or 'b' (got ${JSON.stringify(entry.team)})`); })(),
    controller: entry.controller === 'player' || entry.controller === 'ai' ? entry.controller : (() => { throw new Error(`arena: ${label}.controller must be 'player' or 'ai' (got ${JSON.stringify(entry.controller)})`); })(),
    x: arenaInteger(entry.x, `${label}.x`, { min: 0 }),
    y: arenaInteger(entry.y, `${label}.y`, { min: 0 }),
    hp: arenaInteger(entry.hp, `${label}.hp`, { min: 0 }),
    max_hp: arenaInteger(entry.max_hp, `${label}.max_hp`, { min: 0 }),
    mp: arenaInteger(entry.mp, `${label}.mp`, { min: 0 }),
    max_mp: arenaInteger(entry.max_mp, `${label}.max_mp`, { min: 0 }),
    element: arenaString(entry.element, `${label}.element`),
    down: arenaBoolean(entry.down, `${label}.down`),
    parameters: validateArenaActorParameters(entry.parameters, `${label}.parameters`),
    equipment: validateArenaActorEquipment(entry.equipment, `${label}.equipment`)
  };
}

// The all-visible spectator/player view of a single match: board dimensions + tiles, both teams' actors,
// round / status / winner, log, and the last turn's events. When a living player controller is present it
// also carries that fighter's castable elements, self-heal state, revive gate, and usable consumables — a
// present-but-malformed player block fails fast. A standalone (no-player / replay) view carries none.
const ARENA_MATCH_STATUSES = Object.freeze(['active', 'a_won', 'b_won']);
export function validateArenaMatchView(view, label = 'arena match view') {
  arenaObject(view, label);
  if (!ARENA_MATCH_STATUSES.includes(view.status)) {
    throw new Error(`arena: ${label}.status must be one of ${ARENA_MATCH_STATUSES.join('/')} (got ${JSON.stringify(view.status)})`);
  }
  if (view.winner !== null && view.winner !== 'a' && view.winner !== 'b') {
    throw new Error(`arena: ${label}.winner must be null / 'a' / 'b' (got ${JSON.stringify(view.winner)})`);
  }
  const width = arenaInteger(view.width, `${label}.width`, { min: 1 });
  const height = arenaInteger(view.height, `${label}.height`, { min: 1 });
  const tiles = arenaArray(view.tiles, `${label}.tiles`);
  if (tiles.length !== height) throw new Error(`arena: ${label}.tiles must have ${height} rows (got ${tiles.length})`);
  for (let y = 0; y < height; y += 1) {
    const row = arenaArray(tiles[y], `${label}.tiles[${y}]`);
    if (row.length !== width) throw new Error(`arena: ${label}.tiles[${y}] must have ${width} cells (got ${row.length})`);
  }
  arenaBoolean(view.active, `${label}.active`);
  const actors = arenaArray(view.actors, `${label}.actors`).map((actor, index) => validateArenaActor(actor, `${label}.actors[${index}]`));
  arenaArray(view.log, `${label}.log`);
  arenaArray(view.events, `${label}.events`);
  // The player block is present exactly when a living player controller is up (arenaMatchView attaches it).
  const hasPlayerBlock = Object.prototype.hasOwnProperty.call(view, 'player_actor_id');
  if (hasPlayerBlock) {
    arenaString(view.player_actor_id, `${label}.player_actor_id`);
    const castable = arenaArray(view.castable_elements, `${label}.castable_elements`);
    for (let index = 0; index < castable.length; index += 1) {
      const spell = arenaObject(castable[index], `${label}.castable_elements[${index}]`);
      arenaString(spell.element, `${label}.castable_elements[${index}].element`);
      arenaInteger(spell.mp_cost, `${label}.castable_elements[${index}].mp_cost`, { min: 0 });
    }
    const healing = arenaObject(view.healing_spell, `${label}.healing_spell`);
    if (healing.action_type !== 'heal_spell') throw new Error(`arena: ${label}.healing_spell.action_type must be 'heal_spell' (got ${JSON.stringify(healing.action_type)})`);
    arenaInteger(healing.mp_cost, `${label}.healing_spell.mp_cost`, { min: 0 });
    arenaInteger(healing.heal_amount, `${label}.healing_spell.heal_amount`, { min: 0 });
    arenaBoolean(healing.can_use, `${label}.healing_spell.can_use`);
    arenaArray(view.consumables, `${label}.consumables`);
    arenaBoolean(view.revive_used, `${label}.revive_used`);
  }
  return view;
}

// ----- tournament / selection state view -----

function validateArenaUnit(entry, index) {
  const label = `state.units[${index}]`;
  arenaObject(entry, label);
  arenaString(entry.unit_id, `${label}.unit_id`);
  arenaBoolean(entry.is_player_unit, `${label}.is_player_unit`);
  const actors = arenaArray(entry.actors, `${label}.actors`);
  if (actors.length === 0) throw new Error(`arena: ${label}.actors must not be empty`);
  for (let i = 0; i < actors.length; i += 1) {
    const actor = arenaObject(actors[i], `${label}.actors[${i}]`);
    arenaString(actor.actor_id, `${label}.actors[${i}].actor_id`);
    arenaString(actor.name, `${label}.actors[${i}].name`);
    arenaString(actor.kind, `${label}.actors[${i}].kind`);
    arenaString(actor.controller, `${label}.actors[${i}].controller`);
    validateArenaActorParameters(actor.parameters, `${label}.actors[${i}].parameters`);
    validateArenaActorEquipment(actor.equipment, `${label}.actors[${i}].equipment`);
  }
  return entry;
}

function validateArenaBracketMatch(entry, round, index) {
  const label = `state.bracket.rounds[${round}][${index}]`;
  arenaObject(entry, label);
  arenaString(entry.match_id, `${label}.match_id`);
  arenaInteger(entry.round, `${label}.round`, { min: 0 });
  arenaInteger(entry.index, `${label}.index`, { min: 0 });
  // Rounds 1-3 start with null participants (filled as winners resolve); round 0 is seeded. Both are valid.
  if (entry.team_a_unit_id !== null) arenaString(entry.team_a_unit_id, `${label}.team_a_unit_id`);
  if (entry.team_b_unit_id !== null) arenaString(entry.team_b_unit_id, `${label}.team_b_unit_id`);
  if (entry.winner_unit_id !== null) arenaString(entry.winner_unit_id, `${label}.winner_unit_id`);
  arenaBoolean(entry.is_player_match, `${label}.is_player_match`);
  arenaBoolean(entry.is_auto, `${label}.is_auto`);
  arenaBoolean(entry.resolved, `${label}.resolved`);
  return entry;
}

function validateArenaSelectionView(payload) {
  const modes = arenaArray(payload.modes, 'state.modes');
  if (modes.length !== ARENA_MODES.length) throw new Error(`arena: state.modes must list ${ARENA_MODES.length} modes (got ${modes.length})`);
  for (let index = 0; index < modes.length; index += 1) {
    const mode = arenaObject(modes[index], `state.modes[${index}]`);
    if (!ARENA_MODES.includes(mode.mode)) throw new Error(`arena: state.modes[${index}].mode must be one of ${ARENA_MODES.join('/')} (got ${JSON.stringify(mode.mode)})`);
    arenaBoolean(mode.available, `state.modes[${index}].available`);
    if (mode.reason !== null) arenaModeUnavailableReasonText(mode.reason);
  }
  if (payload.buddy !== null) {
    const buddy = arenaObject(payload.buddy, 'state.buddy');
    arenaString(buddy.character_id, 'state.buddy.character_id');
    arenaString(buddy.display_name, 'state.buddy.display_name');
    arenaString(buddy.kind, 'state.buddy.kind');
  }
  return {
    phase: 'selection',
    week: arenaInteger(payload.week, 'state.week', { min: 0 }),
    modes: payload.modes,
    buddy: payload.buddy
  };
}

function validateArenaTournamentStateView(payload) {
  if (!ARENA_MODES.includes(payload.mode)) throw new Error(`arena: state.mode must be one of ${ARENA_MODES.join('/')} (got ${JSON.stringify(payload.mode)})`);
  if (payload.status !== 'active' && payload.status !== 'concluded') {
    throw new Error(`arena: state.status must be 'active' / 'concluded' (got ${JSON.stringify(payload.status)})`);
  }
  arenaString(payload.player_unit_id, 'state.player_unit_id');
  arenaInteger(payload.wins, 'state.wins', { min: 0 });
  arenaBoolean(payload.terminal, 'state.terminal');
  if (payload.outcome !== null) arenaOutcomeLabel(payload.outcome);
  const units = arenaArray(payload.units, 'state.units');
  if (units.length !== ARENA_BRACKET_UNIT_COUNT) throw new Error(`arena: state.units must list ${ARENA_BRACKET_UNIT_COUNT} units (got ${units.length})`);
  units.forEach(validateArenaUnit);
  const bracket = arenaObject(payload.bracket, 'state.bracket');
  const rounds = arenaArray(bracket.rounds, 'state.bracket.rounds');
  if (rounds.length !== ARENA_ROUND_COUNT) throw new Error(`arena: state.bracket.rounds must have ${ARENA_ROUND_COUNT} rounds (got ${rounds.length})`);
  rounds.forEach((round, roundIndex) => {
    arenaArray(round, `state.bracket.rounds[${roundIndex}]`).forEach((match, index) => validateArenaBracketMatch(match, roundIndex, index));
  });
  if (payload.current_match_id !== null) arenaString(payload.current_match_id, 'state.current_match_id');
  if (payload.content_result !== null) arenaObject(payload.content_result, 'state.content_result');
  if (payload.current_match !== null) validateArenaMatchView(payload.current_match, 'state.current_match');
  return {
    phase: 'tournament',
    week: arenaInteger(payload.week, 'state.week', { min: 0 }),
    mode: payload.mode,
    status: payload.status,
    player_unit_id: payload.player_unit_id,
    wins: payload.wins,
    terminal: payload.terminal,
    outcome: payload.outcome,
    units: payload.units,
    bracket: payload.bracket,
    current_match_id: payload.current_match_id,
    content_result: payload.content_result,
    current_match: payload.current_match
  };
}

// Validate + normalize the whole GET /api/arena/state (or POST enter / action tournament) envelope. Fail-fast
// on any malformed field BEFORE the selection cards / bracket render, so a broken response never paints a
// partial arena.
export function validateArenaState(payload) {
  arenaObject(payload, 'arena state');
  if (!ARENA_PHASES.includes(payload.phase)) {
    throw new Error(`arena: state.phase must be one of ${ARENA_PHASES.join('/')} (got ${JSON.stringify(payload.phase)})`);
  }
  return payload.phase === 'selection'
    ? validateArenaSelectionView(payload)
    : validateArenaTournamentStateView(payload);
}

// Validate the arena content-result detail (the reward + outcome shown on the terminal result panel). A
// missing/mis-shaped detail is a broken contract and throws before the result panel renders.
export function validateArenaContentResult(detail) {
  arenaObject(detail, 'arena content_result');
  arenaOutcomeLabel(detail.outcome);
  if (!ARENA_MODES.includes(detail.mode)) throw new Error(`arena: content_result.mode must be one of ${ARENA_MODES.join('/')} (got ${JSON.stringify(detail.mode)})`);
  arenaInteger(detail.wins, 'content_result.wins', { min: 0 });
  arenaInteger(detail.prize_money, 'content_result.prize_money', { min: 0 });
  const materials = arenaArray(detail.materials, 'content_result.materials');
  const validatedMaterials = materials.map((item, index) => {
    arenaObject(item, `content_result.materials[${index}]`);
    return {
      item_id: arenaString(item.item_id, `content_result.materials[${index}].item_id`),
      display_name: arenaString(item.display_name, `content_result.materials[${index}].display_name`),
      quantity: arenaInteger(item.quantity, `content_result.materials[${index}].quantity`, { min: 1 })
    };
  });
  return { outcome: detail.outcome, mode: detail.mode, wins: detail.wins, prize_money: detail.prize_money, materials: validatedMaterials };
}

// Validate the POST /api/arena/match/intro envelope: the match id + the generated 口上. A malformed / empty
// intro fails fast before the intro banner paints (no silent blank flavor).
export function validateArenaIntroResponse(payload) {
  arenaObject(payload, 'arena intro');
  return {
    match_id: arenaString(payload.match_id, 'intro.match_id'),
    intro: arenaString(payload.intro, 'intro.intro')
  };
}

// Validate the POST /api/arena/result-flavor envelope: the outcome + the generated 実況一文. Fail-fast on a
// malformed outcome / empty flavor before the result panel updates.
export function validateArenaResultFlavorResponse(payload) {
  arenaObject(payload, 'arena result flavor');
  arenaOutcomeLabel(payload.outcome);
  return {
    outcome: payload.outcome,
    flavor: arenaString(payload.flavor, 'result_flavor.flavor')
  };
}

// Validate the GET /api/arena/match/:id/replay envelope: the resolved auto match's identity + the full
// per-turn log (each turn a {view, events}) recomputed from the seed. A malformed turn / view fails fast
// before the replay plays.
export function validateArenaReplay(payload) {
  arenaObject(payload, 'arena replay');
  arenaString(payload.match_id, 'replay.match_id');
  arenaInteger(payload.round, 'replay.round', { min: 0 });
  arenaString(payload.winner_unit_id, 'replay.winner_unit_id');
  const turns = arenaArray(payload.turns, 'replay.turns');
  if (turns.length === 0) throw new Error('arena: replay.turns must not be empty');
  turns.forEach((turn, index) => {
    arenaObject(turn, `replay.turns[${index}]`);
    validateArenaMatchView(turn.view, `replay.turns[${index}].view`);
    arenaArray(turn.events, `replay.turns[${index}].events`);
  });
  return payload;
}
