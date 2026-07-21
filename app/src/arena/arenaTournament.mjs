// Arena tournament layer (B2): the weekly, seeded, single-elimination bracket built on top of the
// pure arena combat engine (C-26). This module is the deterministic state machine over a
// JSON-serializable tournament SLOT — it builds the 16-unit bracket, resolves NPC-vs-NPC matches
// through the real engine (never a result-only simulation), advances the bracket as the player's
// own matches resolve, and computes the win-count reward. It reads and returns slots and never
// touches runtime_state or the economy (the HTTP layer B2/arenaApi owns persistence, descriptor
// gathering, and reward granting).
//
// The whole outcome is a pure function of (seed, mode, the entry-snapshot descriptors): the same
// (roster, elapsed_weeks, mode) reproduces the same bracket and the same winners. The player's own
// matches are the only ones NOT resolved here — they are played interactively through the engine's
// arenaStep by the caller, and their result is recorded back with recordPlayerMatchWinner.

import { createRng, deriveSeed } from '../dungeon/dungeonRng.mjs';
import { materialItemId, MATERIAL_ELEMENTS } from '../dungeonMaterialCatalog.mjs';
import { runArenaMatchAuto } from './arenaEngine.mjs';

export const ARENA_MODES = Object.freeze(['solo', 'pair', 'spectate']);
export const ARENA_BRACKET_UNIT_COUNT = 16;
export const ARENA_ROUND_COUNT = 4; // 8 -> 4 -> 2 -> 1; the champion wins 4 matches.
export const ARENA_TOURNAMENT_STATE_KEY = 'routing_arena_tournament';
// The slot carries the LLM flavor persistence (match_intros / result_flavor), so a schema bump.
const ARENA_SLOT_VERSION = 2;

// The per-round 番付 labels woven into the match-intro 口上 (§3 {round_label}) — the same vocabulary the frontend
// bracket labels use. One label per round; the last is the final.
export const ARENA_ROUND_LABELS = Object.freeze(['1回戦', '準々決勝', '準決勝', '決勝']);
if (ARENA_ROUND_LABELS.length !== ARENA_ROUND_COUNT) {
  throw new Error('ARENA_ROUND_LABELS must have one label per round');
}
// The 形式 label woven into the intro 口上 (§3 {format_label}): 1v1 / 2v2 by unit size.
const ARENA_FORMAT_LABELS = Object.freeze({ 1: '一対一', 2: '二対二' });
const ARENA_STATUSES = Object.freeze(['active', 'concluded']);
const ARENA_ACTOR_KINDS = Object.freeze(['protagonist', 'character', 'homunculus']);
const ARENA_CONTROLLERS = Object.freeze(['player', 'ai']);
export const ARENA_OUTCOMES = Object.freeze(['champion', 'eliminated', 'spectated_champion', 'spectated_eliminated']);

// A fixed base mixed with elapsed_weeks into the tournament's week seed, so a new week is a new bracket
// and the same week is byte-identical. Tunable.
const ARENA_WEEK_SEED_BASE = 0x51ac_e5ee | 0;

// The win-count reward table (Lead-fixed v1 defaults, tunable). money is a flat prize; materials are
// tier/quantity lines whose element is rolled deterministically from the week seed at grant time.
export const ARENA_REWARD_TABLE = Object.freeze({
  0: Object.freeze({ money: 0, materials: Object.freeze([]) }),
  1: Object.freeze({ money: 100, materials: Object.freeze([Object.freeze({ tier: 1, quantity: 2 })]) }),
  2: Object.freeze({ money: 300, materials: Object.freeze([Object.freeze({ tier: 1, quantity: 4 })]) }),
  3: Object.freeze({ money: 700, materials: Object.freeze([Object.freeze({ tier: 1, quantity: 4 }), Object.freeze({ tier: 2, quantity: 2 })]) }),
  4: Object.freeze({ money: 1600, materials: Object.freeze([Object.freeze({ tier: 1, quantity: 4 }), Object.freeze({ tier: 2, quantity: 4 })]) })
});

// ----- small helpers -----

function assertMode(mode) {
  if (!ARENA_MODES.includes(mode)) throw new Error(`arena mode must be one of ${ARENA_MODES.join('/')}: ${mode}`);
  return mode;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer: ${value}`);
  return value;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer: ${value}`);
  return value;
}

function charSum(text) {
  let sum = 0;
  for (const char of String(text)) sum += char.codePointAt(0);
  return sum;
}

export function arenaWeekSeed(week) {
  return deriveSeed(ARENA_WEEK_SEED_BASE, assertNonNegativeInteger(week, 'arena week'));
}

// Per-match deterministic seed from (week seed, round, index). Same card in the same week always
// reproduces the same match, which is what makes NPC resolution and spectator replay deterministic.
function arenaMatchSeed(weekSeed, round, index) {
  return deriveSeed(deriveSeed(weekSeed, (round + 1) * 1000), index + 1);
}

// The unit size for a mode: pair is 2v2, solo and spectate are 1v1.
export function arenaUnitSizeForMode(mode) {
  return assertMode(mode) === 'pair' ? 2 : 1;
}

// ----- opponent selection (deterministic, enemy-priority) -----

// Selects `count` opponent character ids from the selectable roster pool for this week, deterministically.
// Enemies (the 因縁 rivals) are guaranteed inclusion first, then the rest of the pool fills the remaining
// slots. Both groups are ordered by a (seed, id) hash so the same (seed, pool, enemies) reproduces the same
// selection and a new week reshuffles it. Fail-fast: an enemy id outside the pool, or a pool too small to
// fill `count`, throws (never a silent short bracket).
export function selectArenaOpponentCharacterIds({ seed, pool, enemyIds, count }) {
  assertInteger(seed, 'arena opponent seed');
  if (!Array.isArray(pool)) throw new Error('arena opponent pool must be an array');
  assertNonNegativeInteger(count, 'arena opponent count');
  const poolIds = pool.map((entry, index) => {
    if (typeof entry !== 'string' || !entry) throw new Error(`arena opponent pool[${index}] must be a non-empty character id`);
    return entry;
  });
  const poolSet = new Set(poolIds);
  if (poolSet.size !== poolIds.length) throw new Error('arena opponent pool must not contain duplicate ids');
  const enemies = [];
  const seenEnemies = new Set();
  for (const enemyId of enemyIds ?? []) {
    if (typeof enemyId !== 'string' || !enemyId) throw new Error('arena enemy id must be a non-empty string');
    if (!poolSet.has(enemyId)) throw new Error(`arena enemy id is not in the selectable opponent pool: ${enemyId}`);
    if (seenEnemies.has(enemyId)) continue;
    seenEnemies.add(enemyId);
    enemies.push(enemyId);
  }
  if (poolIds.length < count) {
    throw new Error(`arena opponent pool is too small to fill the bracket: need ${count}, have ${poolIds.length}`);
  }
  const score = (id) => deriveSeed(seed, charSum(id));
  const byScore = (a, b) => score(a) - score(b) || (a < b ? -1 : a > b ? 1 : 0);
  const orderedEnemies = [...enemies].sort(byScore);
  const rest = poolIds.filter((id) => !seenEnemies.has(id)).sort(byScore);
  const selected = [...orderedEnemies, ...rest].slice(0, count);
  if (selected.length !== count) throw new Error(`arena opponent selection produced ${selected.length}, expected ${count}`);
  return selected;
}

// ----- unit / descriptor validation -----

function assertActorDescriptor(descriptor, label) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error(`${label} must be an object`);
  if (typeof descriptor.actor_id !== 'string' || !descriptor.actor_id) throw new Error(`${label}.actor_id is required`);
  if (typeof descriptor.name !== 'string' || !descriptor.name) throw new Error(`${label}.name is required`);
  if (!ARENA_ACTOR_KINDS.includes(descriptor.kind)) throw new Error(`${label}.kind must be one of ${ARENA_ACTOR_KINDS.join('/')}: ${descriptor.kind}`);
  if (!ARENA_CONTROLLERS.includes(descriptor.controller)) throw new Error(`${label}.controller must be 'player' or 'ai': ${descriptor.controller}`);
  if (!descriptor.parameters || typeof descriptor.parameters !== 'object') throw new Error(`${label}.parameters is required`);
  if (!Number.isInteger(descriptor.mp_reserve_percent)) throw new Error(`${label}.mp_reserve_percent must be an integer`);
  if (descriptor.equipment !== null && (typeof descriptor.equipment !== 'object' || Array.isArray(descriptor.equipment))) {
    throw new Error(`${label}.equipment must be a run-equipment object or null`);
  }
  return descriptor;
}

function assertUnit(unit, expectedSize, label) {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) throw new Error(`${label} must be an object`);
  if (typeof unit.unit_id !== 'string' || !unit.unit_id) throw new Error(`${label}.unit_id is required`);
  if (!Array.isArray(unit.actors) || unit.actors.length !== expectedSize) {
    throw new Error(`${label}.actors must have exactly ${expectedSize} actor(s)`);
  }
  unit.actors.forEach((actor, index) => assertActorDescriptor(actor, `${label}.actors[${index}]`));
  return unit;
}

// ----- unit assembly (from gathered entry-snapshot inputs) -----

function protagonistDescriptor(protagonist) {
  if (!protagonist || typeof protagonist !== 'object') throw new Error('arena protagonist input is required');
  return {
    actor_id: 'protagonist',
    name: '主人公',
    kind: 'protagonist',
    controller: 'player',
    parameters: protagonist.parameters,
    equipment: protagonist.equipment ?? null,
    mp_reserve_percent: protagonist.mp_reserve_percent
  };
}

function buddyDescriptor(buddy) {
  if (!buddy || typeof buddy !== 'object') throw new Error('arena buddy input is required for this mode');
  if (buddy.kind !== 'character' && buddy.kind !== 'homunculus') {
    throw new Error(`arena buddy kind must be 'character' or 'homunculus': ${buddy.kind}`);
  }
  return {
    actor_id: buddy.character_id,
    name: buddy.display_name,
    kind: buddy.kind,
    controller: 'ai',
    parameters: buddy.parameters,
    equipment: buddy.equipment ?? null,
    mp_reserve_percent: buddy.mp_reserve_percent
  };
}

function opponentDescriptor(opponent) {
  if (!opponent || typeof opponent !== 'object') throw new Error('arena opponent input is required');
  return {
    actor_id: opponent.character_id,
    name: opponent.display_name,
    kind: 'character',
    controller: 'ai',
    parameters: opponent.parameters,
    equipment: null, // NPC entrants fight with parameters only (no equipment) — Lead-fixed v1.
    mp_reserve_percent: opponent.mp_reserve_percent
  };
}

// Assembles the 16 units (1 player unit + 15 opponent units) from the gathered entry-snapshot inputs.
// The player unit is the protagonist alone (solo), the protagonist + buddy pair (pair), or the buddy alone
// (spectate); the opponents fill single units (1v1 modes) or paired units (2v2). Fail-fast: a mode needing a
// buddy without one, or an opponent count that does not exactly fill the bracket, throws.
export function assembleArenaUnits({ mode, protagonist, buddy = null, opponents }) {
  assertMode(mode);
  const unitSize = arenaUnitSizeForMode(mode);
  let playerActors;
  if (mode === 'solo') {
    playerActors = [protagonistDescriptor(protagonist)];
  } else if (mode === 'pair') {
    playerActors = [protagonistDescriptor(protagonist), buddyDescriptor(buddy)];
  } else {
    playerActors = [buddyDescriptor(buddy)];
  }
  const requiredOpponents = (ARENA_BRACKET_UNIT_COUNT - 1) * unitSize;
  if (!Array.isArray(opponents) || opponents.length !== requiredOpponents) {
    throw new Error(`arena ${mode} mode requires exactly ${requiredOpponents} opponent characters: got ${Array.isArray(opponents) ? opponents.length : 'non-array'}`);
  }
  const opponentDescriptors = opponents.map(opponentDescriptor);
  const opponentUnits = [];
  for (let index = 0; index < ARENA_BRACKET_UNIT_COUNT - 1; index += 1) {
    opponentUnits.push({
      unit_id: `u${index + 1}`,
      actors: opponentDescriptors.slice(index * unitSize, index * unitSize + unitSize)
    });
  }
  return { playerUnit: { unit_id: 'u0', actors: playerActors }, opponentUnits };
}

// ----- slot construction -----

// Builds a fresh tournament slot: places the 16 units into bracket leaves in a seeded order, lays out the
// 4-round match skeleton (round 0 participants filled from the leaf order, later rounds empty until winners
// resolve), and marks it active with no rewards paid. `playerUnit` is the unit the player has stake in
// (solo=protagonist, pair=protagonist+buddy, spectate=buddy alone); `opponentUnits` are the 15 NPC units.
export function createArenaTournamentSlot({ seed, week, mode, playerUnit, opponentUnits }) {
  assertInteger(seed, 'arena tournament seed');
  assertNonNegativeInteger(week, 'arena tournament week');
  assertMode(mode);
  const unitSize = arenaUnitSizeForMode(mode);
  if (!Array.isArray(opponentUnits) || opponentUnits.length !== ARENA_BRACKET_UNIT_COUNT - 1) {
    throw new Error(`arena tournament requires exactly ${ARENA_BRACKET_UNIT_COUNT - 1} opponent units: got ${Array.isArray(opponentUnits) ? opponentUnits.length : 'non-array'}`);
  }
  assertUnit(playerUnit, unitSize, 'arena player unit');
  opponentUnits.forEach((unit, index) => assertUnit(unit, unitSize, `arena opponent unit[${index}]`));

  const playerUnitId = playerUnit.unit_id;
  const units = [playerUnit, ...opponentUnits];
  const unitIds = units.map((unit) => unit.unit_id);
  if (new Set(unitIds).size !== unitIds.length) throw new Error('arena tournament unit ids must be unique');
  // Every actor across the whole field must be unique so no character is drafted into two units.
  const actorIds = units.flatMap((unit) => unit.actors.map((actor) => actor.actor_id));
  if (new Set(actorIds).size !== actorIds.length) throw new Error('arena tournament actor ids must be unique across all units');

  const leafOrder = createRng(deriveSeed(seed, 101)).shuffle(unitIds);
  const matches = buildBracketSkeleton({ seed, leafOrder });

  return {
    version: ARENA_SLOT_VERSION,
    week,
    seed,
    mode,
    status: 'active',
    rewards_paid: false,
    player_unit_id: playerUnitId,
    leaf_order: leafOrder,
    units,
    matches,
    current_match: null,
    current_match_id: null,
    outcome: null,
    content_result: null,
    // LLM flavor persistence (idempotent): a per-match intro map (match_id -> 口上) and the single tournament
    // result flavor 一文. Independent of the combat / reward / terminal commit — a flavor generation failure never
    // touches these being empty.
    match_intros: {},
    result_flavor: null
  };
}

// The 15-match skeleton: round 0's 8 matches take the leaf order pairwise; rounds 1-3 start with empty
// participants (filled as winners resolve). Match ids are stable (`r<round>_m<index>`).
function buildBracketSkeleton({ seed, leafOrder }) {
  const matches = [];
  let roundSize = ARENA_BRACKET_UNIT_COUNT;
  for (let round = 0; round < ARENA_ROUND_COUNT; round += 1) {
    const matchCount = roundSize / 2;
    for (let index = 0; index < matchCount; index += 1) {
      matches.push({
        match_id: `r${round}_m${index}`,
        round,
        index,
        team_a_unit_id: round === 0 ? leafOrder[index * 2] : null,
        team_b_unit_id: round === 0 ? leafOrder[index * 2 + 1] : null,
        seed: arenaMatchSeed(seed, round, index),
        winner_unit_id: null
      });
    }
    roundSize = matchCount;
  }
  return matches;
}

// ----- slot validation (strict) -----

const SLOT_KEYS = Object.freeze([
  'version', 'week', 'seed', 'mode', 'status', 'rewards_paid', 'player_unit_id',
  'leaf_order', 'units', 'matches', 'current_match', 'current_match_id', 'outcome', 'content_result',
  'match_intros', 'result_flavor'
]);

function assertExactKeys(value, expectedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

export function validateArenaTournamentSlot(slot) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw new Error('arena tournament slot must be an object');
  assertExactKeys(slot, SLOT_KEYS, 'arena tournament slot');
  if (slot.version !== ARENA_SLOT_VERSION) throw new Error(`arena tournament slot version must be ${ARENA_SLOT_VERSION}: ${slot.version}`);
  assertNonNegativeInteger(slot.week, 'arena tournament slot week');
  assertInteger(slot.seed, 'arena tournament slot seed');
  assertMode(slot.mode);
  if (!ARENA_STATUSES.includes(slot.status)) throw new Error(`arena tournament slot status must be one of ${ARENA_STATUSES.join('/')}: ${slot.status}`);
  if (typeof slot.rewards_paid !== 'boolean') throw new Error('arena tournament slot rewards_paid must be a boolean');
  if (typeof slot.player_unit_id !== 'string' || !slot.player_unit_id) throw new Error('arena tournament slot player_unit_id is required');
  const unitSize = arenaUnitSizeForMode(slot.mode);
  if (!Array.isArray(slot.units) || slot.units.length !== ARENA_BRACKET_UNIT_COUNT) {
    throw new Error(`arena tournament slot must have exactly ${ARENA_BRACKET_UNIT_COUNT} units`);
  }
  const unitIds = new Set();
  slot.units.forEach((unit, index) => {
    assertUnit(unit, unitSize, `arena tournament slot units[${index}]`);
    if (unitIds.has(unit.unit_id)) throw new Error(`arena tournament slot unit_id must be unique: ${unit.unit_id}`);
    unitIds.add(unit.unit_id);
  });
  if (!unitIds.has(slot.player_unit_id)) throw new Error(`arena tournament slot player_unit_id is not a real unit: ${slot.player_unit_id}`);
  if (!Array.isArray(slot.leaf_order) || slot.leaf_order.length !== ARENA_BRACKET_UNIT_COUNT) {
    throw new Error(`arena tournament slot leaf_order must list ${ARENA_BRACKET_UNIT_COUNT} units`);
  }
  for (const leafId of slot.leaf_order) {
    if (!unitIds.has(leafId)) throw new Error(`arena tournament slot leaf_order contains an unknown unit: ${leafId}`);
  }
  if (new Set(slot.leaf_order).size !== ARENA_BRACKET_UNIT_COUNT) throw new Error('arena tournament slot leaf_order must not repeat a unit');
  validateBracketMatches(slot, unitIds);
  if (slot.current_match !== null && (typeof slot.current_match !== 'object' || Array.isArray(slot.current_match))) {
    throw new Error('arena tournament slot current_match must be a match object or null');
  }
  if (slot.current_match_id !== null && (typeof slot.current_match_id !== 'string' || !slot.current_match_id)) {
    throw new Error('arena tournament slot current_match_id must be a non-empty string or null');
  }
  if ((slot.current_match === null) !== (slot.current_match_id === null)) {
    throw new Error('arena tournament slot current_match and current_match_id must be present together');
  }
  if (slot.outcome !== null && !ARENA_OUTCOMES.includes(slot.outcome)) {
    throw new Error(`arena tournament slot outcome must be null or one of ${ARENA_OUTCOMES.join('/')}: ${slot.outcome}`);
  }
  if (slot.status === 'concluded' && slot.outcome === null) throw new Error('a concluded arena tournament requires an outcome');
  if (slot.content_result !== null && (typeof slot.content_result !== 'object' || Array.isArray(slot.content_result))) {
    throw new Error('arena tournament slot content_result must be an object or null');
  }
  validateFlavorFields(slot);
  return slot;
}

// The LLM flavor fields: match_intros is a plain map of known match_id -> non-empty 口上 string; result_flavor is
// a non-empty 一文 or null. Malformed shape / unknown match id fails fast (no silent normalization).
function validateFlavorFields(slot) {
  const intros = slot.match_intros;
  if (!intros || typeof intros !== 'object' || Array.isArray(intros)) {
    throw new Error('arena tournament slot match_intros must be an object');
  }
  const matchIds = new Set(slot.matches.map((match) => match.match_id));
  for (const [matchId, intro] of Object.entries(intros)) {
    if (!matchIds.has(matchId)) throw new Error(`arena tournament slot match_intros references an unknown match: ${matchId}`);
    if (typeof intro !== 'string' || !intro.trim()) throw new Error(`arena tournament slot match_intros[${matchId}] must be a non-empty string`);
  }
  if (slot.result_flavor !== null && (typeof slot.result_flavor !== 'string' || !slot.result_flavor.trim())) {
    throw new Error('arena tournament slot result_flavor must be a non-empty string or null');
  }
}

function validateBracketMatches(slot, unitIds) {
  if (!Array.isArray(slot.matches) || slot.matches.length !== ARENA_BRACKET_UNIT_COUNT - 1) {
    throw new Error(`arena tournament slot must have exactly ${ARENA_BRACKET_UNIT_COUNT - 1} matches`);
  }
  const byId = new Set();
  for (const match of slot.matches) {
    if (!match || typeof match !== 'object' || Array.isArray(match)) throw new Error('arena tournament match must be an object');
    assertExactKeys(match, ['match_id', 'round', 'index', 'team_a_unit_id', 'team_b_unit_id', 'seed', 'winner_unit_id'], 'arena tournament match');
    if (typeof match.match_id !== 'string' || !match.match_id) throw new Error('arena tournament match_id is required');
    if (byId.has(match.match_id)) throw new Error(`arena tournament match_id must be unique: ${match.match_id}`);
    byId.add(match.match_id);
    assertNonNegativeInteger(match.round, 'arena tournament match round');
    assertNonNegativeInteger(match.index, 'arena tournament match index');
    assertInteger(match.seed, 'arena tournament match seed');
    for (const key of ['team_a_unit_id', 'team_b_unit_id', 'winner_unit_id']) {
      const value = match[key];
      if (value !== null && !unitIds.has(value)) throw new Error(`arena tournament match ${key} must be a known unit or null: ${value}`);
    }
    if (match.winner_unit_id !== null && match.winner_unit_id !== match.team_a_unit_id && match.winner_unit_id !== match.team_b_unit_id) {
      throw new Error(`arena tournament match winner ${match.winner_unit_id} is not a participant of ${match.match_id}`);
    }
  }
}

// ----- bracket queries -----

function matchById(slot, matchId) {
  return slot.matches.find((match) => match.match_id === matchId) ?? null;
}

function unitById(slot, unitId) {
  const unit = slot.units.find((candidate) => candidate.unit_id === unitId);
  if (!unit) throw new Error(`arena tournament unit not found: ${unitId}`);
  return unit;
}

function isBothParticipantsKnown(match) {
  return match.team_a_unit_id !== null && match.team_b_unit_id !== null;
}

// A player interactive match is one on the player's path (mode is solo/pair, one participant is the player
// unit) that has not been resolved yet. Spectate has none (the player unit is AI-driven like everyone else).
export function isPlayerInteractiveMatch(slot, match) {
  if (slot.mode === 'spectate') return false;
  if (match.winner_unit_id !== null) return false;
  return match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id;
}

// The player's current interactive match (participants known, not yet resolved). Null when the player has
// no match to play right now — eliminated, champion, spectate mode, or the next opponent not yet determined.
export function findPlayerCurrentMatch(slot) {
  return slot.matches.find((match) => isPlayerInteractiveMatch(slot, match) && isBothParticipantsKnown(match)) ?? null;
}

// The parent match a winner advances into, and which slot (a/b) it fills.
function parentOf(slot, match) {
  if (match.round >= ARENA_ROUND_COUNT - 1) return null;
  const parent = matchById(slot, `r${match.round + 1}_m${Math.floor(match.index / 2)}`);
  if (!parent) throw new Error(`arena tournament bracket is missing the parent of ${match.match_id}`);
  return { parent, slotKey: match.index % 2 === 0 ? 'team_a_unit_id' : 'team_b_unit_id' };
}

// ----- deterministic auto-resolution -----

function unitDescriptors(slot, unitId) {
  return unitById(slot, unitId).actors.map((actor) => ({
    actor_id: actor.actor_id,
    name: actor.name,
    kind: actor.kind,
    parameters: actor.parameters,
    equipment: actor.equipment,
    mp_reserve_percent: actor.mp_reserve_percent,
    controller: actor.controller
  }));
}

// The descriptors for one bracket match, team_a first (bracket order), so the engine's winner side ('a'/'b')
// maps back to team_a_unit_id / team_b_unit_id with no re-mapping.
export function arenaMatchTeams(slot, match) {
  if (!isBothParticipantsKnown(match)) throw new Error(`arena match ${match.match_id} has an unknown participant`);
  return {
    teamA: unitDescriptors(slot, match.team_a_unit_id),
    teamB: unitDescriptors(slot, match.team_b_unit_id)
  };
}

function winnerUnitIdForSide(match, side) {
  if (side === 'a') return match.team_a_unit_id;
  if (side === 'b') return match.team_b_unit_id;
  throw new Error(`arena match ${match.match_id} produced an invalid winner side: ${side}`);
}

// Records the resolved winner of a match and advances it into the parent slot. Shared by NPC auto-resolution
// and the interactive player-match result.
function setMatchWinner(slot, match, winnerUnitId) {
  if (winnerUnitId !== match.team_a_unit_id && winnerUnitId !== match.team_b_unit_id) {
    throw new Error(`arena winner ${winnerUnitId} is not a participant of ${match.match_id}`);
  }
  match.winner_unit_id = winnerUnitId;
  const parent = parentOf(slot, match);
  if (parent) parent.parent[parent.slotKey] = winnerUnitId;
}

// Resolves every ready NPC-vs-NPC match through the real engine (never a result-only roll), filling winners
// and next-round participants, until only the player's own unresolved match (if any) remains. In spectate
// mode nothing is a player match, so this resolves the whole bracket. Deterministic: same slot -> same
// winners. `root` is threaded to runArenaMatchAuto for API parity (an all-AI match reads no storage).
export async function advanceArenaTournament(slot, { root } = {}) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const match of slot.matches) {
      if (match.winner_unit_id !== null) continue;
      if (!isBothParticipantsKnown(match)) continue;
      if (isPlayerInteractiveMatch(slot, match)) continue;
      const { teamA, teamB } = arenaMatchTeams(slot, match);
      const result = await runArenaMatchAuto({ root, seed: match.seed, teamA, teamB });
      setMatchWinner(slot, match, winnerUnitIdForSide(match, result.winner));
      progressed = true;
    }
  }
  return slot;
}

// Records the result of the player's interactive match (its winner side from arenaStep) and advances the
// bracket. The caller then re-runs advanceArenaTournament to resolve the newly-reachable NPC matches.
export function recordPlayerMatchWinner(slot, matchId, winnerSide) {
  const match = matchById(slot, matchId);
  if (!match) throw new Error(`arena tournament match not found: ${matchId}`);
  if (!isPlayerInteractiveMatch(slot, match)) throw new Error(`arena match is not the player's current match: ${matchId}`);
  setMatchWinner(slot, match, winnerUnitIdForSide(match, winnerSide));
  slot.current_match = null;
  slot.current_match_id = null;
  return slot;
}

// ----- terminal / wins / outcome -----

export function arenaTournamentWins(slot) {
  return slot.matches.filter((match) => match.winner_unit_id === slot.player_unit_id).length;
}

function playerEliminated(slot) {
  return slot.matches.some((match) => (
    match.winner_unit_id !== null
    && (match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id)
    && match.winner_unit_id !== slot.player_unit_id
  ));
}

function playerChampion(slot) {
  const final = slot.matches.find((match) => match.round === ARENA_ROUND_COUNT - 1);
  return final?.winner_unit_id === slot.player_unit_id;
}

// The tournament is over once the player unit has either been eliminated or won the final. Because the
// player's path is the only thing that can gate the bracket, this is the single terminal test for every mode.
export function isArenaTournamentTerminal(slot) {
  return playerEliminated(slot) || playerChampion(slot);
}

export function arenaTournamentOutcome(slot) {
  if (!isArenaTournamentTerminal(slot)) throw new Error('arena tournament is not terminal yet');
  const champion = playerChampion(slot);
  if (slot.mode === 'spectate') return champion ? 'spectated_champion' : 'spectated_eliminated';
  return champion ? 'champion' : 'eliminated';
}

// ----- reward -----

// The deterministic reward for a win count: the table money plus material lines whose element is rolled per
// tier from the week seed. Returns { money, materials: [{ item_id, element, tier, quantity }] } — the HTTP
// layer resolves display names and grants it.
export function computeArenaReward({ seed, wins }) {
  assertInteger(seed, 'arena reward seed');
  if (!Number.isInteger(wins) || wins < 0 || wins > ARENA_ROUND_COUNT) {
    throw new Error(`arena reward wins must be an integer 0..${ARENA_ROUND_COUNT}: ${wins}`);
  }
  const band = ARENA_REWARD_TABLE[wins];
  if (!band) throw new Error(`arena reward table has no band for wins=${wins}`);
  const materials = band.materials.map((line) => {
    const element = MATERIAL_ELEMENTS[deriveSeed(seed, line.tier) % MATERIAL_ELEMENTS.length];
    return { item_id: materialItemId(element, line.tier), element, tier: line.tier, quantity: line.quantity };
  });
  // Combine any lines that rolled the same element+tier so a grant carries one entry per item id.
  const byItem = new Map();
  for (const material of materials) {
    const existing = byItem.get(material.item_id);
    if (existing) existing.quantity += material.quantity;
    else byItem.set(material.item_id, { ...material });
  }
  return { money: band.money, materials: [...byItem.values()] };
}

// ----- views -----

function actorIdentity(actor) {
  // Every bracket actor carries its entry-snapshot parameters + equipment so the name-click detail reads the arena
  // entry snapshot for ALL actors (protagonist / roster character / homunculus) — snapshot strict, never a roster or
  // current-world re-resolve. The descriptor was validated at assembly (parameters required; equipment a
  // run-equipment object or null — an NPC entrant fields null), so both are present here.
  return {
    actor_id: actor.actor_id,
    name: actor.name,
    kind: actor.kind,
    controller: actor.controller,
    parameters: actor.parameters,
    equipment: actor.equipment ?? null
  };
}

function unitView(slot, unit) {
  return {
    unit_id: unit.unit_id,
    is_player_unit: unit.unit_id === slot.player_unit_id,
    actors: unit.actors.map(actorIdentity)
  };
}

function matchView(slot, match) {
  return {
    match_id: match.match_id,
    round: match.round,
    index: match.index,
    team_a_unit_id: match.team_a_unit_id,
    team_b_unit_id: match.team_b_unit_id,
    winner_unit_id: match.winner_unit_id,
    is_player_match: slot.mode !== 'spectate'
      && (match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id),
    // An auto (spectator-replayable) match is a resolved match that is not a player match.
    is_auto: match.winner_unit_id !== null && !(slot.mode !== 'spectate'
      && (match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id)),
    resolved: match.winner_unit_id !== null
  };
}

// The bracket view (identity + standings only — no combat state). The player's live match view, when one is
// in progress, is attached by the HTTP layer (it needs the engine's arenaMatchView with root for
// consumables), so this stays a pure projection of the slot.
export function arenaTournamentView(slot) {
  validateArenaTournamentSlot(slot);
  const rounds = [];
  for (let round = 0; round < ARENA_ROUND_COUNT; round += 1) {
    rounds.push(slot.matches.filter((match) => match.round === round).map((match) => matchView(slot, match)));
  }
  const terminal = isArenaTournamentTerminal(slot);
  return {
    week: slot.week,
    mode: slot.mode,
    status: slot.status,
    player_unit_id: slot.player_unit_id,
    wins: arenaTournamentWins(slot),
    terminal,
    outcome: slot.outcome,
    units: slot.units.map((unit) => unitView(slot, unit)),
    bracket: { rounds },
    current_match_id: slot.current_match_id,
    content_result: slot.content_result
  };
}

// The bracket match to replay for a spectator: it must be a resolved auto (non-player) match, so its result
// is deterministically recomputable from its seed. A player match, an unresolved match, or an unknown id
// fails fast.
export function findArenaReplayMatch(slot, matchId) {
  const match = matchById(slot, matchId);
  if (!match) {
    const error = new Error(`arena match not found: ${matchId}`);
    error.statusCode = 404;
    throw error;
  }
  if (match.winner_unit_id === null) {
    const error = new Error(`arena match is not resolved yet: ${matchId}`);
    error.statusCode = 409;
    throw error;
  }
  const isPlayerMatch = slot.mode !== 'spectate'
    && (match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id);
  if (isPlayerMatch) {
    const error = new Error(`arena player match has no spectator replay: ${matchId}`);
    error.statusCode = 409;
    throw error;
  }
  return match;
}

// ----- LLM flavor: pure derivation, readers, and idempotent writers -----

// A unit's display name for a flavor prompt: the single fighter's name (1v1) or "A と B" (2v2).
function unitDisplayName(slot, unitId) {
  return unitById(slot, unitId).actors.map((actor) => actor.name).join(' と ');
}

function isResolvedAutoMatch(slot, match) {
  if (match.winner_unit_id === null) return false;
  const isPlayerMatch = slot.mode !== 'spectate'
    && (match.team_a_unit_id === slot.player_unit_id || match.team_b_unit_id === slot.player_unit_id);
  return !isPlayerMatch;
}

// The match a player-facing intro can be generated for: the player's current interactive match (unresolved, both
// participants known) or a resolved auto (spectator-replayable) match. A future-round match with an undetermined
// participant, or a resolved player match (no re-generation — the persisted intro is returned by the caller
// before this gate), fails fast.
export function findArenaIntroMatch(slot, matchId) {
  const match = matchById(slot, matchId);
  if (!match) {
    const error = new Error(`arena match not found: ${matchId}`);
    error.statusCode = 404;
    throw error;
  }
  if (!isBothParticipantsKnown(match)) {
    const error = new Error(`arena match participants are not determined yet: ${matchId}`);
    error.statusCode = 409;
    throw error;
  }
  if (!isPlayerInteractiveMatch(slot, match) && !isResolvedAutoMatch(slot, match)) {
    const error = new Error(`arena match has no player-facing intro: ${matchId}`);
    error.statusCode = 409;
    throw error;
  }
  return match;
}

// The intro prompt inputs for a viewable match (§3/§5): 番付 / 形式 / 東方 / 西方 display strings from the bracket,
// plus the visit's prior intros for the 散らし handoff. team_a is 東方, team_b is 西方 (bracket order preserved).
export function arenaIntroPromptInputs(slot, matchId) {
  const match = findArenaIntroMatch(slot, matchId);
  const unitSize = arenaUnitSizeForMode(slot.mode);
  const formatLabel = ARENA_FORMAT_LABELS[unitSize];
  if (!formatLabel) throw new Error(`arena has no format label for unit size ${unitSize}`);
  const roundLabel = ARENA_ROUND_LABELS[match.round];
  if (!roundLabel) throw new Error(`arena has no round label for round ${match.round}`);
  return {
    roundLabel,
    formatLabel,
    eastNames: unitDisplayName(slot, match.team_a_unit_id),
    westNames: unitDisplayName(slot, match.team_b_unit_id),
    priorIntros: Object.entries(slot.match_intros)
      .filter(([id]) => id !== matchId)
      .map(([, intro]) => intro)
  };
}

// The player's own losing match (single elimination -> at most one). Used to name the defeat 番付 + 相手 in the
// eliminated / spectated_eliminated flavor.
function playerDefeatMatch(slot) {
  const match = slot.matches.find((candidate) => (
    candidate.winner_unit_id !== null
    && (candidate.team_a_unit_id === slot.player_unit_id || candidate.team_b_unit_id === slot.player_unit_id)
    && candidate.winner_unit_id !== slot.player_unit_id
  ));
  if (!match) throw new Error('arena result flavor: the player has no defeat match');
  return match;
}

// The result-flavor prompt inputs for a terminal tournament (§4/§5): the outcome plus the outcome-specific
// names — ALWAYS resolving the real champion so it can be named in every branch (§7-1 忠実性の要).
export function arenaResultPromptInputs(slot) {
  const outcome = arenaTournamentOutcome(slot); // throws if not terminal
  const finalMatch = slot.matches.find((match) => match.round === ARENA_ROUND_COUNT - 1);
  if (!finalMatch || finalMatch.winner_unit_id === null) {
    throw new Error('arena result flavor: the final is not resolved');
  }
  const championUnitId = finalMatch.winner_unit_id;
  const inputs = { outcome, championName: unitDisplayName(slot, championUnitId) };
  if (outcome === 'champion') {
    const finalistUnitId = finalMatch.team_a_unit_id === championUnitId ? finalMatch.team_b_unit_id : finalMatch.team_a_unit_id;
    inputs.finalistName = unitDisplayName(slot, finalistUnitId);
  } else if (outcome === 'spectated_champion') {
    inputs.buddyName = unitDisplayName(slot, slot.player_unit_id);
  } else {
    const defeatMatch = playerDefeatMatch(slot);
    inputs.defeatRoundLabel = ARENA_ROUND_LABELS[defeatMatch.round];
    inputs.defeaterName = unitDisplayName(slot, defeatMatch.winner_unit_id);
    if (outcome === 'spectated_eliminated') inputs.buddyName = unitDisplayName(slot, slot.player_unit_id);
  }
  return inputs;
}

// Reader: the persisted intro for a match (null when not yet generated).
export function arenaMatchIntro(slot, matchId) {
  const intro = slot.match_intros[matchId];
  return typeof intro === 'string' && intro.trim() ? intro : null;
}

// Idempotent writer: returns a validated slot with the match intro recorded. Re-recording an already-present
// intro is a no-op (never a re-generation — the first generation is the persisted truth).
export function setArenaMatchIntro(slot, matchId, intro) {
  findArenaIntroMatch(slot, matchId); // the intro must belong to a viewable match
  const existing = arenaMatchIntro(slot, matchId);
  if (existing) return validateArenaTournamentSlot(slot);
  const trimmed = typeof intro === 'string' ? intro.trim() : '';
  if (!trimmed) throw new Error('arena match intro must be a non-empty string');
  return validateArenaTournamentSlot({ ...slot, match_intros: { ...slot.match_intros, [matchId]: trimmed } });
}

// Reader: the persisted tournament result flavor (null when not yet generated).
export function arenaResultFlavor(slot) {
  return typeof slot.result_flavor === 'string' && slot.result_flavor.trim() ? slot.result_flavor : null;
}

// Idempotent writer: returns a validated slot with the result flavor recorded. The tournament must be terminal
// (the result is only meaningful after conclusion); re-recording is a no-op.
export function setArenaResultFlavor(slot, flavor) {
  if (!isArenaTournamentTerminal(slot)) throw new Error('cannot record arena result flavor before the tournament is terminal');
  const existing = arenaResultFlavor(slot);
  if (existing) return validateArenaTournamentSlot(slot);
  const trimmed = typeof flavor === 'string' ? flavor.trim() : '';
  if (!trimmed) throw new Error('arena result flavor must be a non-empty string');
  return validateArenaTournamentSlot({ ...slot, result_flavor: trimmed });
}

export function readArenaTournamentSlot(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the arena tournament slot');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ARENA_TOURNAMENT_STATE_KEY)) return null;
  const slot = state[ARENA_TOURNAMENT_STATE_KEY];
  if (slot === null) return null;
  return validateArenaTournamentSlot(slot);
}
