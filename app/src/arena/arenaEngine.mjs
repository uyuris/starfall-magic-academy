// Arena combat engine (C-26): a pure,探索なしの純戦闘 resolved on a fixed small board
// with two symmetric teams (1v1 or 2v2), driven by the shared grid-combat core. It is a
// pure API over a JSON-serializable match object — it reads and returns matches and never
// touches runtime_state (the tournament layer B2 owns persistence and rewards). Combat
// numbers, AI discipline, geometry, and the carried-consumable machinery are the same
// shared modules the practical-training dungeon (C-23) uses; nothing here re-defines a
// formula or an AI 規律. No reward accrual, material drop, or parameter/inventory write
// ever happens — a defeat only decides the match (consumable spend is the one exception).

import { abilityParameterDefinitions, magicParameterDefinitions, normalizeParameters } from '../parameters.mjs';
import { deriveCombatStats } from '../dungeon/dungeonStats.mjs';
import { applyEquipmentToCombatStats } from '../equipment.mjs';
import { createRng, deriveSeed } from '../dungeon/dungeonRng.mjs';
import {
  castSelfHealingSpell, combatMaxHp, equippedHealingSpellState, equippedSpellManaCost,
  magicElementLabel, meleeOutcome, recoverActorVitals, spellOutcome, spendMeleeMana
} from '../dungeon/combatResolution.mjs';
import { hasLineOfSight, isWalkable, manhattan, nearestFreeTile } from '../dungeon/combatGeometry.mjs';
import { runActorAiTurn } from '../dungeon/combatAi.mjs';
import { applyConsumableAttack, consumableHealAmount, consumableMpAmount, loadRunConsumables, loadDungeonConsumableDefinitions } from '../dungeon/combatConsumables.mjs';
import { MP_RESERVE_MAX, MP_RESERVE_MIN } from '../mpReserve.mjs';
import { consumeInventoryItems } from '../economy.mjs';
import { arenaSpawnPositions, createArenaBoard } from './arenaBoard.mjs';

// Combat balance (HP ×3, healing ×2) is defined once in the shared combat core
// (combatResolution: COMBAT_HP_MULTIPLIER / COMBAT_HEAL_MULTIPLIER, combatMaxHp, and the
// scaled equippedHealingSpellState / consumable amount helpers). The arena applies it through
// those shared seams, identically to the practical-training dungeon (C-23), so neither
// subsystem re-defines or double-applies the scaling.

// The无限戦闘 guard: an AI-vs-AI match undecided after this many rounds is settled by
// team HP ratio (deterministic coin on an exact tie). Scaled with the HP multiplier so a
// tripled HP pool still resolves by an actual KO rather than hitting the cap. Tunable.
export const ARENA_MAX_ROUNDS = 300;
const ARENA_LOG_LIMIT = 40;
const ARENA_ACTOR_KINDS = ['protagonist', 'character', 'homunculus'];
const ARENA_CONTROLLERS = ['player', 'ai'];
const EQUIPMENT_EFFECT_NUMBER_KEYS = ['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus'];
const MOVE_VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// ----- descriptor validation (fail-fast, no default-value normalization) -----

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`arena ${label} must be a non-empty string`);
  return value;
}

function readParamValue(entry) {
  const raw = typeof entry === 'object' && entry !== null && 'value' in entry ? entry.value : entry;
  return Number(raw);
}

function assertActorParameters(raw, actorId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`arena actor ${actorId} parameters must be an object with magic + abilities`);
  }
  for (const definition of magicParameterDefinitions) {
    const value = readParamValue(raw.magic?.[definition.key]);
    if (!Number.isFinite(value)) throw new Error(`arena actor ${actorId} is missing magic.${definition.key}`);
  }
  for (const definition of abilityParameterDefinitions) {
    const value = readParamValue(raw.abilities?.[definition.key]);
    if (!Number.isFinite(value)) throw new Error(`arena actor ${actorId} is missing abilities.${definition.key}`);
  }
}

function assertActorEquipment(equipment, actorId) {
  if (equipment === null || equipment === undefined) return null;
  if (typeof equipment !== 'object' || Array.isArray(equipment)) {
    throw new Error(`arena actor ${actorId} equipment must be a run-equipment object or null`);
  }
  const effects = equipment.effects;
  if (effects === null || typeof effects !== 'object' || Array.isArray(effects)) {
    throw new Error(`arena actor ${actorId} equipment.effects must be an object`);
  }
  for (const key of EQUIPMENT_EFFECT_NUMBER_KEYS) {
    if (!Number.isFinite(Number(effects[key]))) throw new Error(`arena actor ${actorId} equipment.effects.${key} must be a number`);
  }
  if (effects.element_spell_power === null || typeof effects.element_spell_power !== 'object' || Array.isArray(effects.element_spell_power)) {
    throw new Error(`arena actor ${actorId} equipment.effects.element_spell_power must be an object`);
  }
  return equipment;
}

function assertMpReservePercent(value, actorId) {
  if (!Number.isInteger(value) || value < MP_RESERVE_MIN || value > MP_RESERVE_MAX) {
    throw new Error(`arena actor ${actorId} mp_reserve_percent must be an integer from ${MP_RESERVE_MIN} to ${MP_RESERVE_MAX}: ${value}`);
  }
  return value;
}

function validateActorDescriptor(descriptor, seenIds) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('arena actor descriptor must be an object');
  }
  const actorId = assertNonEmptyString(descriptor.actor_id, 'actor descriptor actor_id');
  if (seenIds.has(actorId)) throw new Error(`arena actor_id is not unique: ${actorId}`);
  seenIds.add(actorId);
  assertNonEmptyString(descriptor.name, `actor ${actorId} name`);
  if (!ARENA_ACTOR_KINDS.includes(descriptor.kind)) throw new Error(`arena actor ${actorId} kind must be one of ${ARENA_ACTOR_KINDS.join('/')}: ${descriptor.kind}`);
  if (!ARENA_CONTROLLERS.includes(descriptor.controller)) throw new Error(`arena actor ${actorId} controller must be 'player' or 'ai': ${descriptor.controller}`);
  assertActorParameters(descriptor.parameters, actorId);
  assertActorEquipment(descriptor.equipment ?? null, actorId);
  assertMpReservePercent(descriptor.mp_reserve_percent, actorId);
  return descriptor;
}

// ----- actor construction -----

function strongestElement(parameters) {
  return magicParameterDefinitions
    .map((definition) => ({ key: definition.key, value: Number(parameters.magic[definition.key].value) }))
    .reduce((best, candidate) => (candidate.value > best.value ? candidate : best)).key;
}

function buildArenaActor(descriptor, team, spawn) {
  const parameters = normalizeParameters(descriptor.parameters);
  const equipment = descriptor.equipment ?? null;
  const stats = applyEquipmentToCombatStats(deriveCombatStats(parameters), equipment);
  // The combat HP pool: the equipment-folded max scaled by the shared HP multiplier. The `stats`
  // block (attack, defense, speed, spell power) is untouched, so only the HP pool scales.
  const maxHp = combatMaxHp(stats.max_hp);
  return {
    actor_id: descriptor.actor_id,
    uid: descriptor.actor_id,
    name: descriptor.name,
    kind: descriptor.kind,
    team,
    controller: descriptor.controller,
    parameters,
    equipment,
    stats,
    element: strongestElement(parameters),
    mp_reserve_percent: descriptor.mp_reserve_percent,
    x: spawn.x,
    y: spawn.y,
    hp: maxHp,
    max_hp: maxHp,
    mp: stats.max_mp,
    max_mp: stats.max_mp,
    down: false,
    // Caster kiting re-close guard, mutated by the shared AI (null or {target_uid, score}).
    caster_reposition_baseline: null
  };
}

function buildTeamActors(team, descriptors) {
  const spawns = arenaSpawnPositions(team, descriptors.length);
  return descriptors.map((descriptor, index) => buildArenaActor(descriptor, team, spawns[index]));
}

// ----- match creation -----

function assertTeam(team, label) {
  if (!Array.isArray(team) || team.length < 1 || team.length > 2) {
    throw new Error(`arena ${label} must have 1 or 2 actors`);
  }
}

export function createArenaMatch({ seed, teamA, teamB } = {}) {
  if (!Number.isInteger(seed)) throw new Error(`arena seed must be an integer: ${seed}`);
  assertTeam(teamA, 'teamA');
  assertTeam(teamB, 'teamB');
  if (teamA.length !== teamB.length) throw new Error(`arena teams must be the same size: ${teamA.length} vs ${teamB.length}`);

  const seenIds = new Set();
  for (const descriptor of [...teamA, ...teamB]) validateActorDescriptor(descriptor, seenIds);
  const playerCount = [...teamA, ...teamB].filter((descriptor) => descriptor.controller === 'player').length;
  if (playerCount > 1) throw new Error(`arena match allows at most one player controller: got ${playerCount}`);

  const actors = [...buildTeamActors('a', teamA), ...buildTeamActors('b', teamB)];
  const match = {
    match_id: `am_${seed}`,
    seed,
    round: 1,
    status: 'active',
    winner: null,
    board: createArenaBoard(),
    actors,
    turn_order: [],
    turn_index: 0,
    // The single once-per-match revive gate (consumables are player-only, at most one player).
    revive_used: false,
    log: [],
    // Per-turn animation events, reset at each resolved turn; carried on the view, not gameplay state.
    turn_events: []
  };
  startRound(match);
  return match;
}

function assertArenaMatch(match) {
  if (match === null || typeof match !== 'object' || Array.isArray(match)) throw new Error('arena match must be an object');
  if (typeof match.status !== 'string') throw new Error('arena match status is required');
  if (!Array.isArray(match.actors) || match.actors.length === 0) throw new Error('arena match actors are required');
  if (!match.board || !Number.isInteger(match.board.width) || !Number.isInteger(match.board.height) || !Array.isArray(match.board.tiles)) {
    throw new Error('arena match board is required');
  }
  if (!Array.isArray(match.turn_order)) throw new Error('arena match turn_order is required');
  if (!Number.isInteger(match.turn_index)) throw new Error('arena match turn_index is required');
  if (!Number.isInteger(match.round)) throw new Error('arena match round is required');
  if (typeof match.revive_used !== 'boolean') throw new Error('arena match revive_used is required');
  return match;
}

// ----- actor / team queries -----

function actorById(match, actorId) {
  return match.actors.find((actor) => actor.actor_id === actorId) ?? null;
}

function isOnBoard(actor) {
  return !actor.down && actor.hp > 0;
}

function livingActors(match) {
  return match.actors.filter(isOnBoard);
}

function teamAliveCount(match, team) {
  return match.actors.filter((actor) => actor.team === team && isOnBoard(actor)).length;
}

function teamHpRatio(match, team) {
  let hp = 0;
  let maxHp = 0;
  for (const actor of match.actors) {
    if (actor.team !== team) continue;
    hp += Math.max(0, actor.hp);
    maxHp += actor.max_hp;
  }
  return maxHp === 0 ? 0 : hp / maxHp;
}

function occupiedByLiving(match, x, y) {
  return match.actors.some((actor) => isOnBoard(actor) && actor.x === x && actor.y === y);
}

function occupiedByOtherLiving(match, self, x, y) {
  return match.actors.some((actor) => actor !== self && isOnBoard(actor) && actor.x === x && actor.y === y);
}

function livingEnemyAt(match, self, x, y) {
  return match.actors.find((actor) => actor.team !== self.team && isOnBoard(actor) && actor.x === x && actor.y === y) ?? null;
}

// Nearest opposing living actor with a clear line of sight (the board is all-visible, so
// vision is bounded only by walls) — the player's cast / attack_single auto-target.
function nearestVisibleEnemy(match, self) {
  let best = null;
  let bestDist = Infinity;
  for (const actor of match.actors) {
    if (actor.team === self.team || !isOnBoard(actor)) continue;
    if (!hasLineOfSight(match.board, self, actor)) continue;
    const dist = manhattan(self.x, self.y, actor.x, actor.y);
    if (dist < bestDist) {
      best = actor;
      bestDist = dist;
    }
  }
  return best;
}

// ----- log / events / defeat -----

function pushArenaLog(match, message) {
  match.log.push(message);
  if (match.log.length > ARENA_LOG_LIMIT) match.log.splice(0, match.log.length - ARENA_LOG_LIMIT);
}

function arenaDefeat(match, target) {
  target.down = true;
  pushArenaLog(match, `${target.name}は倒れた。`);
}

// ----- round / turn scheduling -----

function charSum(text) {
  let sum = 0;
  for (const char of text) sum += char.charCodeAt(0);
  return sum;
}

// Per-(round, actor) deterministic RNG: same seed + same round + same actor always
// reproduces the same rolls, which is what makes the whole match replay deterministic.
function turnRng(match, actor) {
  return createRng(deriveSeed(deriveSeed(match.seed, match.round), charSum(actor.actor_id)));
}

// Deterministic tie-break value for equal-speed ordering, varied per round so a stalemate
// does not lock the same actor first every round.
function orderTieBreak(match, actor) {
  return deriveSeed(deriveSeed(match.seed, match.round + 1), charSum(actor.actor_id));
}

function startRound(match) {
  match.turn_order = livingActors(match)
    .slice()
    .sort((a, b) => (
      b.stats.speed - a.stats.speed
      || orderTieBreak(match, a) - orderTieBreak(match, b)
      || (a.actor_id < b.actor_id ? -1 : a.actor_id > b.actor_id ? 1 : 0)
    ))
    .map((actor) => actor.actor_id);
  match.turn_index = 0;
}

function recoverAllLiving(match) {
  for (const actor of match.actors) {
    if (!isOnBoard(actor)) continue;
    recoverActorVitals(actor);
  }
}

function decideByHpRatio(match) {
  const aRatio = teamHpRatio(match, 'a');
  const bRatio = teamHpRatio(match, 'b');
  let winner;
  if (aRatio > bRatio) winner = 'a';
  else if (bRatio > aRatio) winner = 'b';
  else winner = createRng(deriveSeed(match.seed, 7)).int(0, 1) === 0 ? 'a' : 'b';
  finishMatch(match, winner);
}

function endOfRound(match) {
  recoverAllLiving(match);
  // Having played the round cap with no winner, settle by HP ratio (round stays at the cap).
  if (match.round >= ARENA_MAX_ROUNDS) {
    decideByHpRatio(match);
    return;
  }
  match.round += 1;
  startRound(match);
}

// The actor id whose turn is next, advancing round bookkeeping and skipping downed actors.
// Returns null once the match is decided.
function currentTurnActorId(match) {
  while (true) {
    if (match.status !== 'active') return null;
    if (match.turn_index >= match.turn_order.length) {
      endOfRound(match);
      if (match.status !== 'active') return null;
      continue;
    }
    const actorId = match.turn_order[match.turn_index];
    const actor = actorById(match, actorId);
    if (!actor || !isOnBoard(actor)) {
      match.turn_index += 1;
      continue;
    }
    return actorId;
  }
}

function finishMatch(match, winner) {
  match.winner = winner;
  match.status = winner === 'a' ? 'a_won' : 'b_won';
}

function checkVictory(match) {
  if (match.status !== 'active') return;
  if (teamAliveCount(match, 'b') === 0) finishMatch(match, 'a');
  else if (teamAliveCount(match, 'a') === 0) finishMatch(match, 'b');
}

// ----- AI battlefield adapter -----

function arenaAiField(match, actor, rng) {
  return {
    board: match.board,
    rng,
    // All opposing actors (the shared AI filters out the downed ones itself).
    opposingActors: match.actors.filter((candidate) => candidate.team !== actor.team),
    // No regroup anchor: a lone survivor's team has already won, so the match ends first.
    regroupTarget: null,
    // All cells are visible; only walls block sight.
    visionRadius: () => Infinity,
    occupiedTile: (x, y) => occupiedByLiving(match, x, y),
    canStand: (self, x, y) => isWalkable(match.board, x, y) && !occupiedByOtherLiving(match, self, x, y),
    spellManaCost: (self, element) => equippedSpellManaCost(element, self.parameters, self.equipment),
    healingSpellState: (self) => equippedHealingSpellState(self, self.parameters, self.equipment),
    pushLog: (message) => pushArenaLog(match, message),
    pushEvent: (event) => match.turn_events.push(event),
    onDefeat: (target) => arenaDefeat(match, target)
  };
}

// ----- player actions -----

function arenaPlayerMove(match, actor, rng, direction) {
  const vector = MOVE_VECTORS[direction];
  if (!vector) throw new Error(`invalid direction: ${direction}`);
  const nx = actor.x + vector[0];
  const ny = actor.y + vector[1];
  const enemy = livingEnemyAt(match, actor, nx, ny);
  if (enemy) {
    const payment = spendMeleeMana(actor, actor.parameters, 'arena player');
    if (!payment.paid) return { acted: false, error: 'insufficient_mp' };
    const outcome = meleeOutcome(rng, { ...actor.stats, attack: actor.stats.melee_attack, element: null }, enemy);
    match.turn_events.push({ kind: 'melee', from: { x: actor.x, y: actor.y }, to: { x: enemy.x, y: enemy.y }, element: null, hit: outcome.hit });
    if (outcome.hit) {
      enemy.hp = Math.max(0, enemy.hp - outcome.damage);
      pushArenaLog(match, outcome.crit ? `${actor.name}の会心の一撃。${enemy.name}に${outcome.damage}ダメージ。` : `${actor.name}が${enemy.name}に${outcome.damage}ダメージ。`);
      if (enemy.hp <= 0) arenaDefeat(match, enemy);
    } else {
      pushArenaLog(match, `${actor.name}の攻撃は${enemy.name}に外れた。`);
    }
    return { acted: true };
  }
  if (!isWalkable(match.board, nx, ny) || occupiedByOtherLiving(match, actor, nx, ny)) return { acted: false, error: 'blocked' };
  actor.x = nx;
  actor.y = ny;
  return { acted: true };
}

function arenaPlayerCast(match, actor, rng, element) {
  if (!magicParameterDefinitions.some((definition) => definition.key === element)) return { acted: false, error: 'unknown_element' };
  const cost = equippedSpellManaCost(element, actor.parameters, actor.equipment);
  if (actor.mp < cost) return { acted: false, error: 'insufficient_mp' };
  const target = nearestVisibleEnemy(match, actor);
  if (!target) return { acted: false, error: 'no_target' };
  actor.mp -= cost;
  const outcome = spellOutcome(rng, actor.stats.spell_power[element], element, target);
  match.turn_events.push({ kind: 'cast', from: { x: actor.x, y: actor.y }, to: { x: target.x, y: target.y }, element, hit: true });
  target.hp = Math.max(0, target.hp - outcome.damage);
  pushArenaLog(match, `${actor.name}の${magicElementLabel(element)}。${target.name}に${outcome.damage}ダメージ。`);
  if (target.hp <= 0) arenaDefeat(match, target);
  return { acted: true };
}

function arenaPlayerHeal(match, actor) {
  const spell = equippedHealingSpellState(actor, actor.parameters, actor.equipment);
  return castSelfHealingSpell(actor, spell, actor.name, (message) => pushArenaLog(match, message));
}

// The heal/MP ally target for an actor_id selector: a living (not downed) teammate — the
// player themselves included. A downed teammate is not a valid heal/MP target (revive is
// its own effect). Generalized from the dungeon's player/companion vocabulary to actor_id.
function arenaAllyTarget(match, actor, targetActorId) {
  const ally = match.actors.find((candidate) => candidate.actor_id === targetActorId && candidate.team === actor.team && isOnBoard(candidate));
  return ally ? { actor: ally, name: ally.name } : null;
}

function arenaConsumableAttack(match, actor, target, power, element) {
  applyConsumableAttack({
    target,
    power,
    element,
    from: { x: actor.x, y: actor.y },
    pushEvent: (event) => match.turn_events.push(event),
    onDefeat: (defeated) => arenaDefeat(match, defeated)
  });
}

// Validates a consumable use against the match WITHOUT mutating it, returning { error }
// (a turn-non-consuming action_error) or an { execute } closure applied after the item is
// consumed. Mirrors the dungeon discipline, generalized to actor_id targets over the
// all-visible arena board (no fog gate on an aim tile).
function planArenaConsumable(match, actor, item, action) {
  const kind = item.effect_kind;
  if (kind === 'attack_single') {
    const target = nearestVisibleEnemy(match, actor);
    if (!target) return { error: 'no_target' };
    return {
      execute: () => {
        pushArenaLog(match, `${actor.name}が${item.name}を投げつけた。${target.name}に${item.power}ダメージ。`);
        arenaConsumableAttack(match, actor, target, item.power, item.element);
      }
    };
  }
  if (kind === 'attack_area') {
    const aim = action.aim;
    if (!aim || !Number.isInteger(aim.x) || !Number.isInteger(aim.y) || !isWalkable(match.board, aim.x, aim.y)) {
      return { error: 'invalid_aim' };
    }
    if (!hasLineOfSight(match.board, actor, aim)) return { error: 'blocked' };
    return {
      execute: () => {
        const targets = match.actors.filter((candidate) => candidate.team !== actor.team && isOnBoard(candidate) && manhattan(candidate.x, candidate.y, aim.x, aim.y) <= item.radius);
        pushArenaLog(match, targets.length > 0
          ? `${actor.name}が${item.name}を投げつけ、${targets.length}体を巻き込んだ。`
          : `${actor.name}が${item.name}を投げたが、巻き込む相手はいなかった。`);
        for (const target of targets) arenaConsumableAttack(match, actor, target, item.power, item.element);
        if (targets.length === 0) {
          match.turn_events.push({ kind: 'cast', from: { x: actor.x, y: actor.y }, to: { x: aim.x, y: aim.y }, element: item.element, hit: false });
        }
      }
    };
  }
  if (kind === 'heal' || kind === 'heal_full') {
    const ally = arenaAllyTarget(match, actor, action.target);
    if (!ally) return { error: 'invalid_target' };
    return {
      execute: () => {
        const amount = consumableHealAmount(item, ally.actor);
        ally.actor.hp = Math.min(ally.actor.max_hp, ally.actor.hp + amount);
        pushArenaLog(match, `${actor.name}が${item.name}を使い、${ally.name}のHPを回復した。`);
      }
    };
  }
  if (kind === 'mp_restore' || kind === 'mp_restore_full') {
    const ally = arenaAllyTarget(match, actor, action.target);
    if (!ally) return { error: 'invalid_target' };
    return {
      execute: () => {
        const amount = consumableMpAmount(item, ally.actor);
        ally.actor.mp = Math.min(ally.actor.max_mp, ally.actor.mp + amount);
        pushArenaLog(match, `${actor.name}が${item.name}を使い、${ally.name}の魔力を回復した。`);
      }
    };
  }
  // revive: a downed teammate, once per match.
  if (match.revive_used) return { error: 'revive_used' };
  const downed = match.actors.find((candidate) => candidate.actor_id === action.target && candidate.team === actor.team && candidate.down);
  if (!downed) return { error: 'invalid_target' };
  const tile = nearestFreeTile(match.board, { x: actor.x, y: actor.y }, (x, y) => !occupiedByLiving(match, x, y));
  if (!tile) throw new Error('arena revive found no free tile to stand the ally on');
  return {
    execute: () => {
      downed.down = false;
      downed.x = tile.x;
      downed.y = tile.y;
      downed.hp = Math.max(1, Math.round(downed.max_hp * item.revive_hp_ratio));
      downed.caster_reposition_baseline = null;
      match.revive_used = true;
      pushArenaLog(match, `${actor.name}が${item.name}を使い、${downed.name}が復帰した。`);
    }
  };
}

async function arenaPlayerUseConsumable({ root, match, actor, action }) {
  const itemId = action.item_id;
  if (typeof itemId !== 'string' || !itemId) return { acted: false, error: 'invalid_consumable' };
  const definitions = await loadDungeonConsumableDefinitions(root);
  const item = definitions.find((candidate) => candidate.item_id === itemId);
  if (!item) return { acted: false, error: 'unknown_consumable' };
  const plan = planArenaConsumable(match, actor, item, action);
  if (plan.error) return { acted: false, error: plan.error };
  try {
    await consumeInventoryItems({ root, itemCosts: [{ item_id: itemId, quantity: 1 }], moneyCost: 0, rewards: [] });
  } catch (error) {
    if (error?.message === 'insufficient_item_quantity') return { acted: false, error: 'no_item' };
    throw error;
  }
  plan.execute();
  return { acted: true };
}

async function resolvePlayerAction({ root, match, actor, rng, action }) {
  if (!action || typeof action.type !== 'string') throw new Error('arena action.type is required');
  const type = action.type;
  if (type === 'move') return arenaPlayerMove(match, actor, rng, action.direction);
  if (type === 'cast') return arenaPlayerCast(match, actor, rng, action.element);
  if (type === 'heal_spell') return arenaPlayerHeal(match, actor);
  if (type === 'use_consumable') return arenaPlayerUseConsumable({ root, match, actor, action });
  if (type === 'wait') return { acted: true };
  throw new Error(`unknown arena action type: ${type}`);
}

// ----- turn resolution -----

function resolveAiTurn(match, actorId) {
  const actor = actorById(match, actorId);
  match.turn_events = [];
  runActorAiTurn(arenaAiField(match, actor, turnRng(match, actor)), actor);
  match.turn_index += 1;
  checkVictory(match);
  return [...match.turn_events];
}

async function resolvePlayerTurn({ root, match, actorId, action }) {
  const actor = actorById(match, actorId);
  match.turn_events = [];
  const result = await resolvePlayerAction({ root, match, actor, rng: turnRng(match, actor), action });
  if (!result.acted) {
    // An invalid action (blocked, no target, no MP) does not pass a turn.
    return { acted: false, error: result.error, events: [...match.turn_events] };
  }
  match.turn_index += 1;
  checkVictory(match);
  return { acted: true, events: [...match.turn_events] };
}

// Runs AI turns until the next living player controller is up, or the match ends. Sync:
// AI turns never touch storage. Accumulates each turn's events into `events`.
function runAiUntilPlayerOrEnd(match, events, hasPlayer) {
  while (match.status === 'active') {
    const actorId = currentTurnActorId(match);
    if (!actorId) break;
    const actor = actorById(match, actorId);
    if (hasPlayer && actor.controller === 'player') break;
    events.push(...resolveAiTurn(match, actorId));
  }
}

// ----- view -----

function actorView(actor) {
  const view = {
    actor_id: actor.actor_id,
    name: actor.name,
    kind: actor.kind,
    team: actor.team,
    controller: actor.controller,
    x: actor.x,
    y: actor.y,
    hp: actor.hp,
    max_hp: actor.max_hp,
    mp: actor.mp,
    max_mp: actor.max_mp,
    element: actor.element,
    down: !isOnBoard(actor)
  };
  // Every actor carries its entry-snapshot parameters + equipment so the name-click detail reads THESE snapshot
  // values (not a roster / current-world re-resolve — snapshot strict). buildArenaActor keeps both on the match
  // actor; an NPC entrant's equipment is null.
  view.parameters = actor.parameters;
  view.equipment = actor.equipment ?? null;
  return view;
}

// The all-visible spectator view of a match. Board, both teams' actors, round, status,
// winner, log, and the last turn's events. When a living player controller is present it
// also carries that fighter's castable elements, self-heal state, revive-gate flag, and —
// when `consumables` is supplied by arenaStep (which has the root) — the usable consumables
// list. A standalone view (no root) passes consumables through as null.
export function arenaMatchView(match, { consumables = null } = {}) {
  assertArenaMatch(match);
  const player = match.actors.find((actor) => actor.controller === 'player' && isOnBoard(actor));
  const view = {
    match_id: match.match_id,
    seed: match.seed,
    round: match.round,
    status: match.status,
    winner: match.winner,
    active: match.status === 'active',
    width: match.board.width,
    height: match.board.height,
    tiles: match.board.tiles,
    actors: match.actors.map(actorView),
    log: [...match.log],
    events: [...(match.turn_events ?? [])]
  };
  if (player) {
    view.player_actor_id = player.actor_id;
    view.castable_elements = magicParameterDefinitions.map((definition) => ({
      element: definition.key,
      label: definition.label,
      mp_cost: equippedSpellManaCost(definition.key, player.parameters, player.equipment),
      power: player.stats.spell_power[definition.key]
    }));
    view.healing_spell = equippedHealingSpellState(player, player.parameters, player.equipment);
    view.consumables = consumables;
    view.revive_used = match.revive_used;
  }
  return view;
}

// ----- public step API -----

// Advances a player-controlled match by one player action, resolving any AI turns that
// come before and after the player's turn in the same call (so the frontend animates the
// full exchange). `action` is required while a living player controller is up; an invalid
// action returns an `action_error` view without consuming the turn. A finished match
// fails fast (409). For an all-AI match this resolves to completion (use runArenaMatchAuto
// for the per-turn spectator replay).
export async function arenaStep({ root, match, action } = {}) {
  if (!root) throw new Error('root is required');
  assertArenaMatch(match);
  if (match.status !== 'active') {
    const error = new Error('arena match is already finished');
    error.statusCode = 409;
    throw error;
  }
  const hasPlayer = match.actors.some((actor) => actor.controller === 'player');
  const events = [];

  runAiUntilPlayerOrEnd(match, events, hasPlayer);

  if (match.status === 'active') {
    const currentId = currentTurnActorId(match);
    const current = currentId ? actorById(match, currentId) : null;
    if (current && current.controller === 'player') {
      if (!action || typeof action.type !== 'string') throw new Error('arena action is required while a player controller is alive');
      const result = await resolvePlayerTurn({ root, match, actorId: currentId, action });
      events.push(...result.events);
      if (!result.acted) {
        const consumables = await loadRunConsumables(root);
        return { match, view: { ...arenaMatchView(match, { consumables }), action_error: result.error }, events };
      }
      runAiUntilPlayerOrEnd(match, events, hasPlayer);
    }
  }

  const consumables = hasPlayer ? await loadRunConsumables(root) : null;
  return { match, view: arenaMatchView(match, { consumables }), events };
}

// Resolves an all-AI match to completion, deterministically. Returns the winner, the number
// of rounds reached, and the per-turn spectator replay (each entry is the view + that turn's
// events). Same input → identical output. Fails fast if any actor is player-controlled.
export async function runArenaMatchAuto({ root, seed, teamA, teamB } = {}) {
  const match = createArenaMatch({ seed, teamA, teamB });
  if (match.actors.some((actor) => actor.controller === 'player')) {
    throw new Error('runArenaMatchAuto requires an all-AI match (no player controller)');
  }
  // Prepend the true starting placement (spawn positions before any AI turn) so the
  // spectator replay's first frame is the board at match creation, not after the first
  // actor has moved. This frame carries no events and is not a round step.
  const turns = [{ view: arenaMatchView(match), events: [] }];
  while (match.status === 'active') {
    const actorId = currentTurnActorId(match);
    if (!actorId) break;
    const events = resolveAiTurn(match, actorId);
    turns.push({ view: arenaMatchView(match), events });
  }
  return { winner: match.winner, rounds: match.round, turns };
}
