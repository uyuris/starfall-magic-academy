// Turn-based grid roguelike engine: the practical-training dungeon.
//
// One run descends up to MAX_FLOORS auto-generated floors. The player walks a
// grid, bumps enemies to attack or casts elemental spells, and descends via
// stairs. Deeper floors are deadlier and richer. Experience accrues as pending
// parameter gains during the run; retreating banks them into the real 11
// parameters (the same store basic training grows) and a wipe discards them.
//
// Player AND companion combat performance are derived mechanically from their
// 11 parameters (see dungeonStats), closing the train -> stronger -> deeper ->
// more reward loop.
//
// This subsystem is fully self-contained: it does not reuse the creature
// catalog (C-05) or field encounters (C-08 fieldRuntime).

import { createStorageApi } from '../storage.mjs';
import { loadWorldSettings, updatePlayerParameters } from '../worldSettings.mjs';
import { normalizeParameters, magicParameterDefinitions } from '../parameters.mjs';
import { createRng, deriveSeed } from './dungeonRng.mjs';
import { homunculusCompanionViewFields } from './dungeonCompanion.mjs';
import { deriveCombatStats } from './dungeonStats.mjs';
import { generateFloor, itemKinds } from './dungeonGeneration.mjs';
import { COMBAT_HEAL_MULTIPLIER, castSelfHealingSpell, combatMaxHp, equippedEvasionSpellState, equippedHealingSpellState, equippedPierceSpellState, equippedSpellManaCost, magicElementLabel, meleeOutcome, recoverActorVitals, spellOutcome, spendMeleeMana } from './combatResolution.mjs';
import { EVASION_SPELL_DURATION } from './dungeonStats.mjs';
import { canSeeCellWithinRadius, hasLineOfSight, isWalkable, manhattan, nearestFreeTile, pierceLineCells, stepToward } from './combatGeometry.mjs';
import { runActorAiTurn } from './combatAi.mjs';
import { applyConsumableAttack, consumableHealAmount, consumableMpAmount, loadRunConsumables, loadDungeonConsumableDefinitions } from './combatConsumables.mjs';
import { accrueEnemyDefeat, accrueFloorClear, accrueRunClear, bankPendingGains, emptyPendingGains, summarizePendingGains } from './dungeonRewards.mjs';
import { ROUTING_CONTENT_RESULT_STATE_KEY, buildDungeonContentResult, requireRoutingContentWeek } from '../routingContentResult.mjs';
import { addMaterialToBuffer, emptyMaterialBuffer, materialBufferEntries, readMaterialBuffer, rollEnemyMaterialDrop } from './dungeonMaterials.mjs';
import { addEquipmentToBuffer, emptyEquipmentBuffer, equipmentBufferItems, readEquipmentBuffer, rollBossTreasureEquipment } from './dungeonEquipmentDrops.mjs';
import { dungeonMaterialDisplayNames, loadDungeonMaterialDefinitions } from '../dungeonMaterialCatalog.mjs';
import { consumeInventoryItems, depositDungeonMaterials, grantInventoryRewards } from '../economy.mjs';
import { rollDungeonWarmEgg, STAR_CRADLE_DUNGEON_EGG_ITEM } from '../starCradleDungeonDrop.mjs';
import { PLAYER_EQUIP_TARGET, addEquipmentInstance, applyEquipmentToCombatStats, resolveRunEquipment } from '../equipment.mjs';
import { MP_RESERVE_MAX, MP_RESERVE_MIN, loadMpReserveSurface, mpReservePercentFor } from '../mpReserve.mjs';

export const MAX_FLOORS = 10;
// The per-turn regen constants live in the shared combat-resolution module now; re-export
// TURN_MANA_REGEN for the dungeon's public contract (consumers import it from here).
export { TURN_HEALTH_REGEN, TURN_MANA_REGEN } from './combatResolution.mjs';
const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
// The companion conversation prompt summarizes the most recent N action-log lines
// (buildDungeonCompanionPromptTailContext's 直近ログ), so the LLM can react to how
// the run is going.
const PROMPT_RECENT_LOG_LIMIT = 30;
// The run retains at least the prompt window so that summary can always be filled;
// the on-screen action log (#dungeon-log) scrolls this same retained tail.
const LOG_LIMIT = PROMPT_RECENT_LOG_LIMIT;
// The protagonist's action-log subject. Companion log lines name their actor via
// the companion's own name; the player has no per-run name, so this single
// constant is the one source for the protagonist's subject across every log line.
const PLAYER_LOG_NAME = '主人公';
const ENEMY_SPELL_RANGE = 4;
const ENEMY_SPELL_CADENCE_TURNS = 5;
const ENEMY_SPELL_POWER_MULTIPLIER = 0.75;

function storageApiFor(rootOrStorage) {
  if (rootOrStorage && typeof rootOrStorage.readJson === 'function' && typeof rootOrStorage.writeJson === 'function') {
    return rootOrStorage;
  }
  return createStorageApi({ root: rootOrStorage });
}

async function loadRuntimeState(root) {
  return storageApiFor(root).readJson(RUNTIME_STATE_PATH);
}

async function saveRuntimeState(root, state) {
  await storageApiFor(root).writeJson(RUNTIME_STATE_PATH, state);
}

// ----- occupancy -----
//
// The grid geometry (inBounds / isWalkable / chebyshev / manhattan / pathKey /
// hasLineOfSight) lives in the shared combatGeometry module, called with `run` as the
// board (run carries width/height/tiles). Occupancy below is dungeon-specific: the
// player + single companion + enemy list.

function livingEnemyAt(run, x, y) {
  return run.enemies.find((enemy) => enemy.hp > 0 && enemy.x === x && enemy.y === y) ?? null;
}

function actorAt(run, x, y, { ignore } = {}) {
  if (run.player.x === x && run.player.y === y && ignore !== 'player') return 'player';
  if (run.companion && !run.companion.down && run.companion.x === x && run.companion.y === y && ignore !== 'companion') return 'companion';
  if (livingEnemyAt(run, x, y)) return 'enemy';
  return null;
}

function stairsAt(run, x, y) {
  if (!run.stairs || !Number.isInteger(run.stairs.x) || !Number.isInteger(run.stairs.y)) {
    throw new Error('dungeon stairs coordinates are required for companion movement');
  }
  return run.stairs.x === x && run.stairs.y === y;
}

function swapPlayerAndCompanion(run, companion) {
  const playerX = run.player.x;
  const playerY = run.player.y;
  run.player.x = companion.x;
  run.player.y = companion.y;
  companion.x = playerX;
  companion.y = playerY;
}

// ----- combat -----
//
// The damage/hit/variance math, self-heal state + cast, equipment effect readers,
// melee-mana spend, and per-turn vitals regen live in the shared combatResolution
// module. The dungeon keeps only the hero-scoped wrappers that bind the hero's entry
// equipment snapshot (`run.equipment`) to those shared formulas.

// Hero spell cost / self-heal, over the hero's entry equipment snapshot.
function playerSpellManaCost(run, element) {
  return equippedSpellManaCost(element, run.parameters, run.equipment);
}

function playerHealingSpellState(run) {
  return equippedHealingSpellState(run.player, run.parameters, run.equipment);
}

// Composite spell states (player-only v1), over the hero's entry equipment snapshot. Evasion additionally
// reflects the live run buff so its view state shows active / remaining turns.
function playerPierceSpellState(run) {
  return equippedPierceSpellState(run.player, run.parameters, run.equipment);
}
function playerEvasionSpellState(run) {
  return equippedEvasionSpellState(run.player, run.parameters, run.equipment, run.player_evasion_buff ?? null);
}

// The player's active evasion buff bonus (0 when none). Absent buff = inactive (not a masked error).
function activePlayerEvasionBonus(run) {
  const buff = run.player_evasion_buff;
  return buff && buff.turns_remaining > 0 ? buff.bonus : 0;
}

// The player's defender profile for an incoming attack: the base stats, plus the active evasion-buff bonus
// on the rollHit evasion side. With no buff it returns the SAME stats object (byte-identical resolution).
function playerDefenderStats(run) {
  const bonus = activePlayerEvasionBonus(run);
  if (bonus <= 0) return run.player_stats;
  return { ...run.player_stats, evasion: run.player_stats.evasion + bonus };
}

// Ticks the evasion buff down one turn (called once per resolved player turn, after the enemy phase that the
// buff protected). It expires — and is removed from run state — when it reaches zero.
function tickPlayerEvasionBuff(run) {
  const buff = run.player_evasion_buff;
  if (!buff || buff.turns_remaining <= 0) return;
  buff.turns_remaining -= 1;
  if (buff.turns_remaining <= 0) delete run.player_evasion_buff;
}

function recoverTurnVitals(run) {
  recoverActorVitals(run.player);
  if (run.companion && !run.companion.down) recoverActorVitals(run.companion);
}

function pushLog(run, message) {
  run.log.push(message);
  if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
}

// Structured combat events for the just-resolved action, consumed by the frontend to animate
// who did what to whom (caster/attacker -> target, by tile, tinted by element). Reset at the
// start of each action and exposed read-only on the view; carries no gameplay effect.
// `from`/`to` are tile coords captured at event time (targets do not move when struck).
function pushEvent(run, event) {
  if (!run.turn_events) run.turn_events = [];
  run.turn_events.push(event);
}

// ----- floor lifecycle -----

function buildExplored(run) {
  return Array.from({ length: run.height }, () => Array.from({ length: run.width }, () => false));
}

function revealAround(run, actor, stats, actorLabel, purpose) {
  const visible = buildVisibleCellsForActor(run, actor, stats, actorLabel, purpose);
  for (let y = 0; y < run.height; y += 1) {
    for (let x = 0; x < run.width; x += 1) {
      if (visible[y][x]) run.explored[y][x] = true;
    }
  }
}

function loadFloor(run, floor) {
  const generated = generateFloor({ seed: run.seed, floor });
  run.floor = floor;
  run.width = generated.width;
  run.height = generated.height;
  run.tiles = generated.tiles;
  run.entrance = generated.entrance;
  run.stairs = generated.stairs;
  run.enemies = generated.enemies;
  run.items = generated.items;
  run.player.x = generated.entrance.x;
  run.player.y = generated.entrance.y;
  if (run.companion && !run.companion.down) {
    run.companion.x = generated.entrance.x;
    run.companion.y = generated.entrance.y;
  }
  run.explored = buildExplored(run);
  revealAround(run, run.player, run.player_stats, 'player', 'floor reveal');
}

// ----- enemy turns -----
//
// The deterministic BFS movement (stepToward + its path helpers) is shared from
// combatGeometry, driven by an occupancy predicate the caller supplies. The dungeon's
// occupancy is `actorAt(run, x, y) !== null` (player / companion / living enemy).

function occupiedTile(run) {
  return (x, y) => actorAt(run, x, y) !== null;
}

function livingEnemies(run) {
  return run.enemies.filter((enemy) => enemy.hp > 0);
}

function nearestLivingEnemyVisibleToActor(run, actor, stats, actorLabel, purpose) {
  let best = null;
  let bestDist = Infinity;
  for (const enemy of livingEnemies(run)) {
    if (!actorCanSeeCell(run, actor, stats, actorLabel, purpose, enemy.x, enemy.y)) continue;
    const dist = manhattan(actor.x, actor.y, enemy.x, enemy.y);
    if (dist < bestDist) {
      best = enemy;
      bestDist = dist;
    }
  }
  return best;
}

// How many times an enemy acts this turn, derived from its speed against the
// player's speed (the reflection of agility into turn order): an enemy much
// faster than the player acts twice; one much slower acts only every other
// turn; otherwise once. Raising agility raises player speed and so suppresses
// enemy double-actions.
const ENEMY_FAST_MARGIN = 30;
const ENEMY_SLOW_MARGIN = 30;

export function enemyActionCount(enemySpeed, referenceSpeed, turn) {
  if (enemySpeed >= referenceSpeed + ENEMY_FAST_MARGIN) return 2;
  if (enemySpeed <= referenceSpeed - ENEMY_SLOW_MARGIN) return turn % 2 === 0 ? 1 : 0;
  return 1;
}

function enemyAct(run, enemy, rng) {
  if (enemy.hp <= 0) return;
  // Prefer attacking the player; attack the companion only if it is the one adjacent.
  const companion = run.companion && !run.companion.down ? run.companion : null;
  const adjacentToPlayer = manhattan(enemy.x, enemy.y, run.player.x, run.player.y) === 1;
  const adjacentToCompanion = companion && manhattan(enemy.x, enemy.y, companion.x, companion.y) === 1;
  if (adjacentToPlayer) {
    const outcome = meleeOutcome(rng, enemy, playerDefenderStats(run));
    pushEvent(run, { kind: 'enemy_attack', from: { x: enemy.x, y: enemy.y }, to: { x: run.player.x, y: run.player.y }, element: enemy.element, hit: outcome.hit });
    if (outcome.hit) {
      run.player.hp = Math.max(0, run.player.hp - outcome.damage);
      pushLog(run, `${enemy.name}が${PLAYER_LOG_NAME}に${outcome.damage}ダメージ。`);
    } else {
      pushLog(run, `${PLAYER_LOG_NAME}が${enemy.name}の攻撃を回避した。`);
    }
  } else if (adjacentToCompanion) {
    const outcome = meleeOutcome(rng, enemy, companion.stats);
    pushEvent(run, { kind: 'enemy_attack', from: { x: enemy.x, y: enemy.y }, to: { x: companion.x, y: companion.y }, element: enemy.element, hit: outcome.hit });
    if (outcome.hit) {
      companion.hp = Math.max(0, companion.hp - outcome.damage);
      if (companion.hp <= 0) {
        companion.down = true;
        pushLog(run, `${companion.name}は倒れて戦線を離れた。`);
      } else {
        pushLog(run, `${enemy.name}が${companion.name}に${outcome.damage}ダメージ。`);
      }
    }
  } else {
    const spellTarget = enemySpellReady(run, enemy) ? enemySpellTarget(run, enemy, companion) : null;
    if (spellTarget) {
      enemyCast(run, enemy, spellTarget, rng);
      return;
    }
    // Chase the nearest of player/companion.
    const targets = [run.player];
    if (companion) targets.push(companion);
    const focus = targets.reduce((best, candidate) => (
      manhattan(enemy.x, enemy.y, candidate.x, candidate.y) < manhattan(enemy.x, enemy.y, best.x, best.y) ? candidate : best
    ), targets[0]);
    stepToward(run, enemy, focus, occupiedTile(run));
  }
}

function enemySpellReady(run, enemy) {
  if (typeof enemy.uid !== 'string' || enemy.uid.length === 0) {
    throw new Error('enemy uid is required for magic cadence');
  }
  let offset = 0;
  for (const char of enemy.uid) offset += char.charCodeAt(0);
  return (run.turn + (offset % ENEMY_SPELL_CADENCE_TURNS)) % ENEMY_SPELL_CADENCE_TURNS === 0;
}

function enemySpellTarget(run, enemy, companion) {
  const candidates = [
    { actor: run.player, stats: run.player_stats, name: PLAYER_LOG_NAME, priority: 0, kind: 'player' }
  ];
  if (companion) {
    candidates.push({ actor: companion, stats: companion.stats, name: companion.name, priority: 1, kind: 'companion' });
  }
  return candidates
    .map((candidate) => ({
      ...candidate,
      distance: manhattan(enemy.x, enemy.y, candidate.actor.x, candidate.actor.y)
    }))
    .filter((candidate) => (
      candidate.distance > 1
      && candidate.distance <= ENEMY_SPELL_RANGE
      && hasLineOfSight(run, enemy, candidate.actor)
    ))
    .sort((a, b) => a.priority - b.priority || a.distance - b.distance)[0] ?? null;
}

function enemySpellPower(enemy) {
  if (!Number.isFinite(enemy.attack)) throw new Error(`enemy attack is required for magic: ${enemy.uid}`);
  return Math.max(1, Math.round(enemy.attack * ENEMY_SPELL_POWER_MULTIPLIER));
}

function enemyCast(run, enemy, target, rng) {
  const elementLabel = magicElementLabel(enemy.element);
  const outcome = spellOutcome(rng, enemySpellPower(enemy), enemy.element, target.stats);
  pushEvent(run, { kind: 'cast', from: { x: enemy.x, y: enemy.y }, to: { x: target.actor.x, y: target.actor.y }, element: enemy.element, hit: true });
  target.actor.hp = Math.max(0, target.actor.hp - outcome.damage);
  if (target.kind === 'companion' && target.actor.hp <= 0) {
    target.actor.down = true;
    pushLog(run, `${target.name}は倒れて戦線を離れた。`);
    return;
  }
  pushLog(run, `${enemy.name}の${elementLabel}。${target.name}に${outcome.damage}ダメージ。`);
}

function runEnemyTurns(run, rng) {
  for (const enemy of run.enemies) {
    if (enemy.hp <= 0) continue;
    const actions = enemyActionCount(enemy.speed, run.player_stats.speed, run.turn);
    for (let i = 0; i < actions; i += 1) {
      if (enemy.hp <= 0 || run.player.hp <= 0) break;
      enemyAct(run, enemy, rng);
    }
    if (run.player.hp <= 0) return;
  }
}

// The dungeon companion runs the shared companion-style combat AI (combatAi), which
// owns the whole discipline: self-heal when hurt, pick the nearest enemy it can see,
// then kite (caster) or close and strike (melee), holding MP below its reserve line.
// The dungeon supplies the battlefield adapter — its enemies are `run.enemies`, its
// regroup anchor is the player, its board is `run`, a downed target routes through the
// dungeon's reward-bearing defeatEnemy, and the companion avoids standing on the stairs
// (the one dungeon-specific reposition constraint the arena has no analogue for).
function dungeonCompanionField(run, rng) {
  return {
    board: run,
    rng,
    opposingActors: run.enemies,
    regroupTarget: run.player,
    visionRadius: (actor) => actorVisionRadius(actor.stats, 'companion', 'AI target'),
    occupiedTile: occupiedTile(run),
    canStand: (actor, x, y) => isWalkable(run, x, y) && !stairsAt(run, x, y) && actorAt(run, x, y, { ignore: 'companion' }) === null,
    spellManaCost: (actor, element) => equippedSpellManaCost(element, actor.parameters, actor.equipment),
    healingSpellState: (actor) => equippedHealingSpellState(actor, actor.parameters, actor.equipment),
    pushLog: (message) => pushLog(run, message),
    pushEvent: (event) => pushEvent(run, event),
    onDefeat: (target) => defeatEnemy(run, target)
  };
}

function runCompanionTurn(run, rng) {
  const companion = run.companion;
  if (!companion || companion.down) return;
  runActorAiTurn(dungeonCompanionField(run, rng), companion);
}

function defeatEnemy(run, enemy) {
  accrueEnemyDefeat(run.pending_gains, enemy.archetype_id, run.floor);
  pushLog(run, `${enemy.name}を倒した。`);
  // A defeated enemy may drop its element's material for the current floor's tier
  // (a boss always drops T4). The roll is derived from (seed, floor, uid), so it is
  // reproducible and never perturbs the shared combat RNG.
  const droppedItemId = rollEnemyMaterialDrop({ seed: run.seed, floor: run.floor, enemy });
  if (droppedItemId) {
    run.material_buffer = addMaterialToBuffer(readMaterialBuffer(run), droppedItemId);
  }
  // A milestone boss additionally leaves a treasure chest on its tile: a normal floor item (picked up
  // by walking onto it) whose `use_item` opens it into a (seed, floor)-deterministic equipment instance.
  // The chest carries the floor it dropped on so opening it rolls that floor's band regardless of when
  // it is opened. Additive — the boss's guaranteed T4 material drop above is unchanged.
  if (enemy.boss === true) {
    run.items.push({ uid: `chest_f${run.floor}`, kind: 'treasure_chest', x: enemy.x, y: enemy.y, floor: run.floor });
    pushLog(run, `${enemy.name}が守っていた宝箱が現れた。`);
  }
}

// ----- player actions -----

function pickUpItemAt(run, x, y) {
  const index = run.items.findIndex((item) => item.x === x && item.y === y);
  if (index === -1) return;
  const [item] = run.items.splice(index, 1);
  if (item.kind === 'treasure_chest') {
    // A chest is a unique boss reward carrying the floor whose band it rolls; it is never merged into a
    // stacked consumable count, so each chest keeps its own floor and opens its own (seed, floor) equipment.
    run.inventory.push({ kind: item.kind, count: 1, floor: item.floor });
  } else {
    const existing = run.inventory.find((entry) => entry.kind === item.kind);
    if (existing) existing.count += 1;
    else run.inventory.push({ kind: item.kind, count: 1 });
  }
  pushLog(run, `${PLAYER_LOG_NAME}が${itemKinds[item.kind].name}を拾った。`);
}

function playerMove(run, rng, dx, dy) {
  const nx = run.player.x + dx;
  const ny = run.player.y + dy;
  const enemy = livingEnemyAt(run, nx, ny);
  if (enemy) {
    const payment = spendMeleeMana(run.player, run.parameters, 'dungeon player');
    if (!payment.paid) return { acted: false, error: 'insufficient_mp' };
    const outcome = meleeOutcome(rng, { ...run.player_stats, attack: run.player_stats.melee_attack, element: null }, enemy);
    pushEvent(run, { kind: 'melee', from: { x: run.player.x, y: run.player.y }, to: { x: enemy.x, y: enemy.y }, element: null, hit: outcome.hit });
    if (outcome.hit) {
      enemy.hp = Math.max(0, enemy.hp - outcome.damage);
      pushLog(run, outcome.crit ? `${PLAYER_LOG_NAME}の会心の一撃。${enemy.name}に${outcome.damage}ダメージ。` : `${PLAYER_LOG_NAME}が${enemy.name}に${outcome.damage}ダメージ。`);
      if (enemy.hp <= 0) defeatEnemy(run, enemy);
    } else {
      pushLog(run, `${PLAYER_LOG_NAME}の攻撃は${enemy.name}に外れた。`);
    }
    return { acted: true };
  }
  // Moving into a living companion swaps the two: a companion standing on the
  // only path to the stairs or exit must never be able to trap the player. The
  // companion only ever stands on floor tiles, and the player's current tile is
  // walkable (they stand on it), so the swap target is always valid — only a
  // wall still blocks. Enemies and obstacles keep their original behavior.
  const companion = run.companion;
  const swapWithCompanion = Boolean(companion) && !companion.down && companion.x === nx && companion.y === ny;
  if (!swapWithCompanion && !isWalkable(run, nx, ny)) return { acted: false, error: 'blocked' };
  if (swapWithCompanion) {
    swapPlayerAndCompanion(run, companion);
  } else {
    run.player.x = nx;
    run.player.y = ny;
  }
  pickUpItemAt(run, nx, ny);
  return { acted: true };
}

function playerCast(run, rng, element) {
  if (!magicParameterDefinitions.some((definition) => definition.key === element)) {
    return { acted: false, error: 'unknown_element' };
  }
  const cost = playerSpellManaCost(run, element);
  if (run.player.mp < cost) return { acted: false, error: 'insufficient_mp' };
  const target = nearestVisibleEnemy(run);
  if (!target) return { acted: false, error: 'no_target' };
  run.player.mp -= cost;
  const outcome = spellOutcome(rng, run.player_stats.spell_power[element], element, target);
  pushEvent(run, { kind: 'cast', from: { x: run.player.x, y: run.player.y }, to: { x: target.x, y: target.y }, element, hit: true });
  target.hp = Math.max(0, target.hp - outcome.damage);
  pushLog(run, `${PLAYER_LOG_NAME}の${magicElementLabel(element)}。${target.name}に${outcome.damage}ダメージ。`);
  if (target.hp <= 0) defeatEnemy(run, target);
  return { acted: true };
}

function playerHealingSpell(run) {
  return castSelfHealingSpell(run.player, playerHealingSpellState(run), PLAYER_LOG_NAME, (message) => pushLog(run, message));
}

// 貫通魔法 (dark + fire): a defense-IGNORING line attack. The first target is auto-selected exactly like
// `cast` (nearest visible enemy with LoS; none → no_target); the spell then flies straight through it, hitting
// every living enemy standing on the ray until the line leaves the board or meets a wall (enemies never stop
// it, walls do — the magic-wall invariant still holds). MP short → turn-non-consuming action_error. Each hit
// is resolved caster-near to caster-far so the variance rolls are drawn in a fixed order (deterministic), all
// at the same power and MP cost (one cast). Every hit reuses the existing {kind:'cast'} dark event (no new kind).
const PIERCE_EVENT_ELEMENT = 'dark';
function playerPierce(run, rng) {
  const state = playerPierceSpellState(run);
  if (run.player.mp < state.mp_cost) return { acted: false, error: 'insufficient_mp' };
  const target = nearestVisibleEnemy(run);
  if (!target) return { acted: false, error: 'no_target' };
  run.player.mp -= state.mp_cost;
  // The ray from the caster through the first target, extended to the board edge or the first wall.
  // Collect the living enemies on it in caster-near→far order (each cell holds at most one enemy).
  const line = pierceLineCells(run, run.player, target);
  const hits = [];
  for (const cell of line) {
    const enemy = livingEnemyAt(run, cell.x, cell.y);
    if (enemy) hits.push(enemy);
  }
  for (const enemy of hits) {
    const outcome = spellOutcome(rng, state.power, PIERCE_EVENT_ELEMENT, enemy, { ignoreDefense: true });
    pushEvent(run, { kind: 'cast', from: { x: run.player.x, y: run.player.y }, to: { x: enemy.x, y: enemy.y }, element: PIERCE_EVENT_ELEMENT, hit: true });
    enemy.hp = Math.max(0, enemy.hp - outcome.damage);
    pushLog(run, `${PLAYER_LOG_NAME}の貫通魔法。${enemy.name}の防御を貫き${outcome.damage}ダメージ。`);
    if (enemy.hp <= 0) defeatEnemy(run, enemy);
  }
  return { acted: true };
}

// 回避魔法 (earth + wind): a self buff that raises the player's evasion for EVASION_SPELL_DURATION turns.
// Re-casting refreshes the duration (it never stacks). MP short → turn-non-consuming action_error.
function playerEvasion(run) {
  const state = playerEvasionSpellState(run);
  if (run.player.mp < state.mp_cost) return { acted: false, error: 'insufficient_mp' };
  run.player.mp -= state.mp_cost;
  run.player_evasion_buff = { turns_remaining: EVASION_SPELL_DURATION, bonus: state.evasion_bonus };
  pushLog(run, `${PLAYER_LOG_NAME}の回避魔法。${EVASION_SPELL_DURATION}ターンのあいだ攻撃を避けやすくなる。`);
  return { acted: true };
}

function nearestVisibleEnemy(run) {
  return nearestLivingEnemyVisibleToActor(run, run.player, run.player_stats, 'player', 'spell target');
}

function playerUseItem(run, kind) {
  const entry = run.inventory.find((item) => item.kind === kind && item.count > 0);
  if (!entry) return { acted: false, error: 'no_item' };
  const definition = itemKinds[kind];
  if (!definition) return { acted: false, error: 'unknown_item' };
  if (definition.effect === 'treasure') {
    // Open a boss chest: roll the (seed, floor)-deterministic equipment for the floor this chest carries
    // and add it to the run equipment buffer (kept until finalize on the same greed ladder as materials).
    if (!Number.isInteger(entry.floor)) throw new Error('treasure chest inventory entry is missing its floor');
    const instance = rollBossTreasureEquipment({ seed: run.seed, floor: entry.floor });
    run.equipment_buffer = addEquipmentToBuffer(readEquipmentBuffer(run), instance);
    pushLog(run, `${PLAYER_LOG_NAME}が宝箱を開けた。${instance.name}を手に入れた。`);
    entry.count -= 1;
    if (entry.count <= 0) run.inventory.splice(run.inventory.indexOf(entry), 1);
    return { acted: true };
  }
  // Charisma's fortune raises the quality of consumables (more is restored), and the whole
  // restore is scaled by the combat heal multiplier like every other healing effect.
  const potency = (definition.amount + Math.max(0, run.player_stats.fortune)) * COMBAT_HEAL_MULTIPLIER;
  if (definition.effect === 'heal') {
    run.player.hp = Math.min(run.player.max_hp, run.player.hp + potency);
    pushLog(run, `${PLAYER_LOG_NAME}が${definition.name}でHPを回復した。`);
  } else if (definition.effect === 'mana') {
    run.player.mp = Math.min(run.player.max_mp, run.player.mp + potency);
    pushLog(run, `${PLAYER_LOG_NAME}が${definition.name}で魔力を回復した。`);
  }
  entry.count -= 1;
  if (entry.count <= 0) run.inventory.splice(run.inventory.indexOf(entry), 1);
  return { acted: true };
}

// ----- dungeon consumables (alchemy `dungeon_consumable` items used mid-run) -----
//
// The consumable view helpers (target mode, summary, owned-quantity read, usable-list
// loader) and the flat-damage application live in the shared combatConsumables module.
// The dungeon keeps only its own targeting orchestration (planConsumable), because its
// aim validity binds to the run's fog (`run.explored`) and its ally vocabulary is
// player / companion.

// Whether this run's one-per-run revive (蘇生の雫) has already been spent. Absent flag = not yet used —
// a new run initializes it false, and a run predating the feature has revived no one. An explicit
// contract (like material_buffer's "absent = zero"), not a silent default fallback.
function reviveAlreadyUsed(run) {
  return run.revive_used === true;
}

// The heal/MP target actor for a target selector, or null when the selection is invalid: 'player' is
// always the hero; 'companion' resolves only to a living (not downed) companion. A downed companion is
// not a valid heal/MP target — revive is its own effect.
function consumableAllyTarget(run, target) {
  if (target === 'player') return { actor: run.player, name: PLAYER_LOG_NAME };
  if (target === 'companion') {
    if (!run.companion || run.companion.down) return null;
    return { actor: run.companion, name: run.companion.name };
  }
  return null;
}

// The dungeon's flat consumable damage binds the shared applyConsumableAttack to the run:
// the blast originates at the hero's tile, and a lethal hit routes through defeatEnemy so a
// consumable kill accrues rewards / drops exactly like any other kill.
function dungeonConsumableAttack(run, enemy, power, element) {
  applyConsumableAttack({
    target: enemy,
    power,
    element,
    from: { x: run.player.x, y: run.player.y },
    pushEvent: (event) => pushEvent(run, event),
    onDefeat: (target) => defeatEnemy(run, target)
  });
}

// Validates a consumable use against the current run WITHOUT mutating it, returning either
// { error } (a turn-non-consuming action_error) or an { execute } closure that applies the effect once
// the item is consumed. Validate-before-consume keeps every invalid use (no target, bad aim, wrong
// target, exhausted revive) free of both an item spend and a passed turn.
function planConsumable(run, item, action) {
  const kind = item.effect_kind;
  if (kind === 'attack_single') {
    const target = nearestVisibleEnemy(run);
    if (!target) return { error: 'no_target' };
    return {
      execute: () => {
        pushLog(run, `${PLAYER_LOG_NAME}が${item.name}を投げつけた。${target.name}に${item.power}ダメージ。`);
        dungeonConsumableAttack(run, target, item.power, item.element);
      }
    };
  }
  if (kind === 'attack_area') {
    const aim = action.aim;
    if (!aim || !Number.isInteger(aim.x) || !Number.isInteger(aim.y) || !isWalkable(run, aim.x, aim.y) || !run.explored[aim.y][aim.x]) {
      return { error: 'invalid_aim' };
    }
    // The blast cannot be thrown through walls: a clear line to the landing tile is required.
    if (!hasLineOfSight(run, run.player, aim)) return { error: 'blocked' };
    return {
      execute: () => {
        const targets = run.enemies.filter((enemy) => enemy.hp > 0 && manhattan(enemy.x, enemy.y, aim.x, aim.y) <= item.radius);
        pushLog(run, targets.length > 0
          ? `${PLAYER_LOG_NAME}が${item.name}を投げつけ、${targets.length}体を巻き込んだ。`
          : `${PLAYER_LOG_NAME}が${item.name}を投げたが、巻き込む敵はいなかった。`);
        // Allies are never caught (味方誤爆なし): only living enemies in radius take the flat power.
        for (const enemy of targets) dungeonConsumableAttack(run, enemy, item.power, item.element);
        // A whiff (no enemies in radius) still shows the blast at the landing tile so it animates.
        if (targets.length === 0) {
          pushEvent(run, { kind: 'cast', from: { x: run.player.x, y: run.player.y }, to: { x: aim.x, y: aim.y }, element: item.element, hit: false });
        }
      }
    };
  }
  if (kind === 'heal' || kind === 'heal_full') {
    const ally = consumableAllyTarget(run, action.target);
    if (!ally) return { error: 'invalid_target' };
    return {
      execute: () => {
        const amount = consumableHealAmount(item, ally.actor);
        ally.actor.hp = Math.min(ally.actor.max_hp, ally.actor.hp + amount);
        pushLog(run, `${PLAYER_LOG_NAME}が${item.name}を使い、${ally.name}のHPを回復した。`);
      }
    };
  }
  if (kind === 'mp_restore' || kind === 'mp_restore_full') {
    const ally = consumableAllyTarget(run, action.target);
    if (!ally) return { error: 'invalid_target' };
    return {
      execute: () => {
        const amount = consumableMpAmount(item, ally.actor);
        ally.actor.mp = Math.min(ally.actor.max_mp, ally.actor.mp + amount);
        pushLog(run, `${PLAYER_LOG_NAME}が${item.name}を使い、${ally.name}の魔力を回復した。`);
      }
    };
  }
  // revive: the downed companion only, once per run.
  if (reviveAlreadyUsed(run)) return { error: 'revive_used' };
  if (!run.companion || !run.companion.down) return { error: 'invalid_target' };
  const tile = nearestFreeTile(run, run.player, (x, y) => actorAt(run, x, y, { ignore: 'companion' }) === null);
  if (!tile) throw new Error('dungeon revive found no free tile to stand the companion on');
  return {
    execute: () => {
      run.companion.down = false;
      run.companion.x = tile.x;
      run.companion.y = tile.y;
      run.companion.hp = Math.max(1, Math.round(run.companion.max_hp * item.revive_hp_ratio));
      // A revived companion starts its AI kiting state fresh.
      run.companion.caster_reposition_baseline = null;
      run.revive_used = true;
      pushLog(run, `${PLAYER_LOG_NAME}が${item.name}を使い、${run.companion.name}が復帰した。`);
    }
  };
}

// Uses one owned `dungeon_consumable` from player_inventory during a run. Validates the item is a
// dungeon consumable and its target/aim is legal (a turn-non-consuming action_error otherwise), then
// atomically consumes exactly one via the economy consume (the ownership gate — not owning it is a
// turn-non-consuming `no_item`, not a thrown error), then resolves the effect. player_inventory and the
// dungeon_run live in separate files, so this consume never clobbers the run state saved at action end.
async function playerUseConsumable({ root, run, action }) {
  const itemId = action.item_id;
  if (typeof itemId !== 'string' || !itemId) return { acted: false, error: 'invalid_consumable' };
  const definitions = await loadDungeonConsumableDefinitions(root);
  const item = definitions.find((candidate) => candidate.item_id === itemId);
  if (!item) return { acted: false, error: 'unknown_consumable' };
  const plan = planConsumable(run, item, action);
  if (plan.error) return { acted: false, error: plan.error };
  try {
    await consumeInventoryItems({ root, itemCosts: [{ item_id: itemId, quantity: 1 }], moneyCost: 0, rewards: [] });
  } catch (error) {
    if (error?.message === 'insufficient_item_quantity') return { acted: false, error: 'no_item' };
    throw error;
  }
  plan.execute(run);
  return { acted: true };
}

// Whether the player is standing on the down-stair.
function onStairs(run) {
  return run.player.x === run.stairs.x && run.player.y === run.stairs.y;
}

// Whether the player is standing on this floor's entrance.
function onEntrance(run) {
  return run.player.x === run.entrance.x && run.player.y === run.entrance.y;
}

// ----- run state <-> view -----

function actorVisionRadius(stats, actorLabel, purpose) {
  const radius = Number(stats?.vision_radius);
  if (!Number.isFinite(radius)) throw new Error(`dungeon ${actorLabel} vision radius is required for ${purpose}`);
  return radius;
}

// The player/companion cell-visibility built for the view and prompt context reuses the
// shared radius+LoS primitive (canSeeCellWithinRadius) over `run` as the board.
function actorCanSeeCell(run, actor, stats, actorLabel, purpose, x, y) {
  const radius = actorVisionRadius(stats, actorLabel, purpose);
  return canSeeCellWithinRadius(run, actor, radius, x, y);
}

function buildVisibleCellsForActor(run, actor, stats, actorLabel, purpose) {
  const radius = actorVisionRadius(stats, actorLabel, purpose);
  return Array.from({ length: run.height }, (_, y) => Array.from({ length: run.width }, (_, x) => (
    canSeeCellWithinRadius(run, actor, radius, x, y)
  )));
}

function entriesVisibleToActor(run, entries, actor, stats, actorLabel, purpose) {
  const radius = actorVisionRadius(stats, actorLabel, purpose);
  return [...entries].filter((entry) => canSeeCellWithinRadius(run, actor, radius, entry.x, entry.y));
}

function distanceFromActor(actor, entry) {
  return manhattan(actor.x, actor.y, entry.x, entry.y);
}

function dungeonItemDefinition(kind) {
  const definition = itemKinds[kind];
  if (!definition) throw new Error(`unknown dungeon item kind: ${kind}`);
  return definition;
}

function buildView(run, { availability = null, materialDisplayNames, consumables } = {}) {
  if (!(materialDisplayNames instanceof Map)) {
    throw new Error('buildView requires a materialDisplayNames Map to attach material buffer display names');
  }
  if (!Array.isArray(consumables)) {
    throw new Error('buildView requires a consumables array for the usable dungeon consumables view');
  }
  const visible = buildVisibleCellsForActor(run, run.player, run.player_stats, 'player', 'view');
  const enemies = entriesVisibleToActor(
    run,
    run.enemies.filter((enemy) => enemy.hp > 0),
    run.player,
    run.player_stats,
    'player',
    'view'
  )
    .map((enemy) => ({ uid: enemy.uid, archetype_id: enemy.archetype_id, name: enemy.name, element: enemy.element, glyph: enemy.glyph, x: enemy.x, y: enemy.y, hp: enemy.hp, max_hp: enemy.max_hp, boss: enemy.boss === true, elite: enemy.elite === true }));
  const items = run.items
    .filter((item) => run.explored[item.y][item.x])
    .map((item) => {
      const definition = dungeonItemDefinition(item.kind);
      return { uid: item.uid, kind: item.kind, name: definition.name, glyph: definition.glyph, x: item.x, y: item.y };
    });
  return {
    // A run awaiting its deferred finalize is not playable: report it as inactive
    // (with the marker) so the screen resumes the finalize instead of resuming play.
    active: run.status === 'active' && !run.pending_finalize,
    pending_finalize: run.pending_finalize ?? null,
    // For a held run, the exact deltas the deferred finalize will bank (clamped), so a resumed
    // exit shows the same result the action's preview did. Null for normal play views.
    applied_gains_preview: run.pending_finalize
      ? (run.pending_finalize.outcome === 'dead' ? { magic: {}, abilities: {} } : bankPendingGains(run.parameters, run.pending_gains).applied)
      : null,
    run_id: run.run_id,
    floor: run.floor,
    max_floors: run.max_floors,
    turn: run.turn,
    status: run.status,
    width: run.width,
    height: run.height,
    tiles: run.tiles,
    explored: run.explored,
    visible,
    entrance: run.entrance,
    stairs: run.stairs,
    on_stairs: onStairs(run),
    on_entrance: onEntrance(run),
    can_retreat: onStairs(run) || onEntrance(run),
    player: { ...run.player },
    player_stats: run.player_stats,
    enemies,
    items,
    inventory: run.inventory.map((entry) => ({ kind: entry.kind, name: itemKinds[entry.kind].name, glyph: itemKinds[entry.kind].glyph, count: entry.count })),
    // Materials accrued this run so far, each carrying the server-authoritative display
    // name (item_id + display_name + quantity, item_id-sorted) — the same enrichment the
    // run-end result gives its carried items. Additive and separate from the run's
    // in-dungeon consumables (`inventory`); a buffer id absent from the catalog throws
    // (materialResultItems), never a silently unnamed row.
    material_buffer: materialResultItems(readMaterialBuffer(run), materialDisplayNames),
    // Boss-chest equipment opened this run so far, each a full C-08 instance (instance_id-sorted).
    // Additive and separate from equipped gear (`equipment`); banked on 踏破/撤退, discarded on 全滅.
    equipment_buffer: equipmentBufferItems(readEquipmentBuffer(run)),
    // Usable dungeon consumables: every owned alchemy `dungeon_consumable` with its effect summary
    // (item_id / name / description / effect_kind / target_mode / kind tunables / quantity), item_id-sorted.
    // The frontend uses target_mode to drive each item's targeting UI (auto / aim / ally / revive).
    consumables,
    // Whether this run's single revive (蘇生の雫) has been spent — the 1-run-1-use gate, surfaced so the
    // frontend can disable the revive action once it has been used.
    revive_used: run.revive_used === true,
    pending_gains_preview: summarizePendingGains(run.pending_gains),
    // A homunculus companion additionally carries its entry-snapshot face_url and C-12 normalized
    // parameters (homunculusCompanionViewFields — the same shape resolveActiveHomunculusActor / the atelier
    // arrival entry expose), so the frontend renders the detail popup (顔＋名前＋11 パラメーター) with no
    // extra fetch. A selectable companion omits both, keeping its view.companion byte-identical to before.
    companion: run.companion
      ? { character_id: run.companion.character_id, name: run.companion.name, x: run.companion.x, y: run.companion.y, hp: run.companion.hp, max_hp: run.companion.max_hp, mp: run.companion.mp, max_mp: run.companion.max_mp, element: run.companion.element, down: run.companion.down, conversation_id: run.companion.conversation_id, equipment: run.companion.equipment ?? null, ...homunculusCompanionViewFields(run.companion) }
      : null,
    castable_elements: magicParameterDefinitions.map((definition) => ({ element: definition.key, label: definition.label, mp_cost: playerSpellManaCost(run, definition.key), power: run.player_stats.spell_power[definition.key] })),
    healing_spell: playerHealingSpellState(run),
    // Composite spell states (player-only v1), supplied the same way as healing_spell so the UI renders the
    // buttons without recomputing power / cost / duration. Evasion carries its live active / remaining-turns.
    pierce_spell: playerPierceSpellState(run),
    evasion_spell: playerEvasionSpellState(run),
    // Equipped weapon/amulet summary (per-slot instance detail + aggregated effect
    // totals), or null when unequipped. Additive: the combat numbers already reflect
    // equipment via run.player_stats and the spell/heal consumers.
    equipment: run.equipment ?? null,
    log: [...run.log],
    events: [...(run.turn_events ?? [])],
    availability
  };
}

function companionVisibleEntries(run, entries) {
  return entriesVisibleToActor(run, entries, run.companion, run.companion.stats, 'companion', 'prompt context')
    .sort((a, b) => distanceFromActor(run.companion, a) - distanceFromActor(run.companion, b));
}

function renderCompanionVisibleList(run, entries, render) {
  const visible = companionVisibleEntries(run, entries);
  if (visible.length === 0) return 'なし';
  return visible.map((entry) => render(entry, distanceFromActor(run.companion, entry))).join('、');
}

export function buildDungeonCompanionPromptTailContext(run) {
  if (!run || typeof run !== 'object') throw new Error('dungeon run is required');
  if (!run.player || !run.player_stats) throw new Error('dungeon run player state is required');
  if (!run.companion) throw new Error('dungeon companion is required for prompt context');
  actorVisionRadius(run.companion.stats, 'companion', 'prompt context');
  const companionDown = run.companion.down ? ' (戦線離脱)' : '';
  const enemyText = renderCompanionVisibleList(
    run,
    run.enemies.filter((enemy) => enemy.hp > 0),
    (enemy, distance) => `${enemy.name} HP ${enemy.hp}/${enemy.max_hp} 距離${distance}`
  );
  const itemText = renderCompanionVisibleList(
    run,
    run.items,
    (item, distance) => `${dungeonItemDefinition(item.kind).name} 距離${distance}`
  );
  const recentLog = run.log?.length ? run.log.slice(-PROMPT_RECENT_LOG_LIMIT).join(' / ') : 'なし';
  // The prompt renderer already labels this block ("追加の現在状況:") and the scene
  // line already states the dungeon floor, so this builder carries only what shifts
  // the companion's reply: how deep the run is, both parties' HP/MP, every
  // threat/item within the companion's vision by distance, and recent events. Raw grid coordinates are
  // mechanical detail a natural speaker cannot use, so they are left out.
  return [
    `- 階層: 第${run.floor}層 / 全${run.max_floors}層`,
    `- 主人公: HP ${run.player.hp}/${run.player.max_hp}, MP ${run.player.mp}/${run.player.max_mp}`,
    `- 同行者 ${run.companion.name}: HP ${run.companion.hp}/${run.companion.max_hp}, MP ${run.companion.mp}/${run.companion.max_mp}${companionDown}`,
    `- 近くの敵: ${enemyText}`,
    `- 近くのアイテム: ${itemText}`,
    `- 直近ログ: ${recentLog}`
  ].join('\n');
}

// ----- public API -----

export async function loadDungeonRun({ root } = {}) {
  if (!root) throw new Error('root is required');
  const state = await loadRuntimeState(root);
  return state.dungeon_run ?? null;
}

// Loads the server-authoritative material display-name lookup for a run's view. The
// live view attaches each buffer material's catalog display name the same way the
// run-end result does; a missing/broken catalog throws (fail-fast), never an unnamed view.
async function loadMaterialDisplayNames(root) {
  return dungeonMaterialDisplayNames(await loadDungeonMaterialDefinitions({ root }));
}

export async function getDungeonView({ root } = {}) {
  const run = await loadDungeonRun({ root });
  if (!run) return { active: false, run: null };
  const materialDisplayNames = await loadMaterialDisplayNames(root);
  const consumables = await loadRunConsumables(root);
  return buildView(run, { materialDisplayNames, consumables });
}

// Builds a fresh run object WITHOUT persisting it. Reads the player's parameters
// and rejects (409) when a run is already active. Keeping the build separate from
// persistence lets a streamed enter render the board and stream the companion
// opening, then commit the run only once the opening succeeds — a failed opening
// leaves no run, exactly the fail-fast the one-shot enter had.
export async function prepareDungeonRun({ root, seed, companion = null } = {}) {
  if (!root) throw new Error('root is required');
  const world = await loadWorldSettings({ root });
  const state = await loadRuntimeState(root);
  // Never overwrite an in-progress run: that would discard its pending gains
  // outside the retreat/wipe rules. A run is left/resumed via state, not re-enter.
  if (state.dungeon_run && state.dungeon_run.status === 'active') {
    const error = new Error('a dungeon run is already active');
    error.statusCode = 409;
    throw error;
  }
  const parameters = normalizeParameters(world.player_parameters);
  // Equipment is validated and resolved once, at entry: the hero's combat snapshot
  // folds in the stat-shaped effects here, so a mid-run equip change never touches
  // an in-progress run. run.parameters stays the pure academy values — equipment must
  // never leak into bankPendingGains and pollute the persisted player parameters.
  const equipment = await resolveRunEquipment({ root, state, target: PLAYER_EQUIP_TARGET });
  const playerStats = applyEquipmentToCombatStats(deriveCombatStats(parameters), equipment);
  // The selected companion's own equipment is resolved the same way, keyed by its
  // character id, and snapshot onto run.companion — the same entry-snapshot contract,
  // so a mid-run companion equip change never touches an in-progress run either.
  const companionEquipment = companion
    ? await resolveRunEquipment({ root, state, target: companion.character_id })
    : null;
  // The companion's MP reserve line is read once, at entry, and snapshot onto run.companion — the
  // same entry-snapshot contract as equipment, so a mid-run conversation that changes the line never
  // touches an in-progress run. Absent = the spec initial line (not a silent fallback).
  const companionMpReserve = companion
    ? mpReservePercentFor(await loadMpReserveSurface({ root }), companion.character_id)
    : null;
  const runSeed = seed === undefined ? Math.floor(Math.random() * 2147483646) + 1 : Number(seed);

  const run = {
    run_id: `dr_${runSeed}`,
    seed: runSeed,
    status: 'active',
    floor: 1,
    max_floors: MAX_FLOORS,
    turn: 0,
    parameters,
    player_stats: playerStats,
    equipment,
    player: { x: 0, y: 0, hp: combatMaxHp(playerStats.max_hp), max_hp: combatMaxHp(playerStats.max_hp), mp: playerStats.max_mp, max_mp: playerStats.max_mp },
    enemies: [],
    items: [],
    inventory: [],
    material_buffer: emptyMaterialBuffer(),
    // Opened boss-chest equipment, kept on the same greed ladder as materials (banked on 踏破/撤退,
    // discarded on 全滅). A fresh run holds none.
    equipment_buffer: emptyEquipmentBuffer(),
    // The one-per-run dungeon-consumable revive gate; a used revive flips this so a second is rejected.
    revive_used: false,
    pending_gains: emptyPendingGains(),
    log: [],
    companion: companion ? buildCompanionRunState(companion, companionEquipment, companionMpReserve) : null,
    width: 0,
    height: 0,
    tiles: [],
    entrance: { x: 0, y: 0 },
    stairs: { x: 0, y: 0 },
    explored: []
  };
  loadFloor(run, 1);
  pushLog(run, run.companion ? `${run.companion.name}と遭遇し、ここから一緒に潜ることになった。` : 'ダンジョンへ潜った。');
  return run;
}

// Persists a prepared run, marking the dungeon active. Re-reads the latest state
// so any writes made while a companion opening streamed are preserved.
export async function commitEnteredRun({ root, run } = {}) {
  if (!root) throw new Error('root is required');
  if (!run) throw new Error('run is required');
  const latestState = await loadRuntimeState(root);
  await saveRuntimeState(root, { ...latestState, current_screen: 'academy-dungeon', dungeon_run: run });
  const materialDisplayNames = await loadMaterialDisplayNames(root);
  const consumables = await loadRunConsumables(root);
  return buildView(run, { materialDisplayNames, consumables });
}

// View for an in-memory (possibly not-yet-persisted) run, with optional availability —
// lets the streamed enter send the board before the run is committed. The material
// display names come from the catalog (root-scoped), so a freshly entered run's empty
// buffer already rides the same server-authoritative enrichment as a mid-run view.
export async function dungeonRunView(run, { availability = null, root } = {}) {
  if (!root) throw new Error('root is required to attach material display names');
  const materialDisplayNames = await loadMaterialDisplayNames(root);
  const consumables = await loadRunConsumables(root);
  return buildView(run, { availability, materialDisplayNames, consumables });
}

export async function enterDungeon({ root, seed, companion = null } = {}) {
  const run = await prepareDungeonRun({ root, seed, companion });
  return commitEnteredRun({ root, run });
}

function buildCompanionRunState(companion, equipment, mpReservePercent) {
  if (!Number.isInteger(mpReservePercent) || mpReservePercent < MP_RESERVE_MIN || mpReservePercent > MP_RESERVE_MAX) {
    throw new Error(`dungeon companion mp_reserve_percent must be an integer from ${MP_RESERVE_MIN} to ${MP_RESERVE_MAX}: ${mpReservePercent}`);
  }
  const parameters = normalizeParameters(companion.parameters ?? {});
  // Symmetric to the hero: the companion's stat-shaped equipment effects fold into the
  // entry combat snapshot, so HP/MP initialize from the equipment-boosted max and
  // element_spell_power lifts the equipped element. Absent equipment folds nothing.
  const stats = applyEquipmentToCombatStats(deriveCombatStats(parameters), equipment);
  // Primary element: the companion's strongest magic mastery.
  const element = magicParameterDefinitions
    .map((definition) => ({ key: definition.key, value: Number(parameters.magic[definition.key].value) }))
    .reduce((best, candidate) => (candidate.value > best.value ? candidate : best)).key;
  return {
    character_id: companion.character_id,
    name: companion.name,
    parameters,
    stats,
    equipment: equipment ?? null,
    element,
    x: 0,
    y: 0,
    hp: combatMaxHp(stats.max_hp),
    max_hp: combatMaxHp(stats.max_hp),
    mp: stats.max_mp,
    max_mp: stats.max_mp,
    down: false,
    // Kiting re-close guard: the score/target the caster improved past on its last
    // reposition (null when its last action was not a reposition). A later turn whose
    // position has fallen back to that score against the same target is the dance.
    caster_reposition_baseline: null,
    // Entry-snapshot MP reserve line: below this share of MP the AI stops spending MP on attacks and
    // holds the rest for self-heal. Fixed for the whole run (mid-run conversation changes do not apply).
    mp_reserve_percent: mpReservePercent,
    conversation_id: companion.conversation_id ?? null,
    // A homunculus companion carries its own face_url (it is not resolvable from the selectable roster on
    // the frontend). A selectable companion omits it, keeping the persisted run.companion byte-identical.
    ...(companion.face_url ? { face_url: companion.face_url } : {})
  };
}

const MOVE_VECTORS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0]
};

// Resolves one player action plus the ensuing companion and enemy turns.
// Returns either an ongoing view ({ active: true, ... }) or an ended result.
//
// finalizeCompanion (optional): an async callback the caller supplies to finalize
// the companion conversation when a run ends. It runs BEFORE any banking/clearing
// so that a failure leaves the run fully intact (fail-fast + state consistency).
export async function dungeonAction({ root, action, postDungeonScreen, routing = false, now = new Date().toISOString() } = {}) {
  if (!root) throw new Error('root is required');
  if (!action || typeof action.type !== 'string') throw new Error('action.type is required');
  const resolvedPostDungeonScreen = assertPostDungeonScreen(postDungeonScreen);
  const state = await loadRuntimeState(root);
  const run = state.dungeon_run;
  if (!run || run.status !== 'active') {
    const error = new Error('no active dungeon run');
    error.statusCode = 409;
    throw error;
  }
  // A run whose end is awaiting its deferred finalize takes no further play
  // actions — it can only be finalized (dungeonFinalizeRun).
  if (run.pending_finalize) {
    const error = new Error('dungeon run is finalizing');
    error.statusCode = 409;
    throw error;
  }
  // Every ongoing view returned below attaches the server-authoritative material display
  // names, so a mid-run buffer reads the same enriched shape as the state/enter views.
  const materialDisplayNames = await loadMaterialDisplayNames(root);
  // Usable-consumables snapshot for the returned views. Only a successful use_consumable mutates
  // player_inventory, so it refreshes this afterward; every other action leaves inventory untouched.
  let consumables = await loadRunConsumables(root);
  // Collect this action's animation events; never persisted (stripped on save).
  run.turn_events = [];

  if (action.type === 'retreat') {
    // Greed ladder: you can only bank from a safe point — this floor's entrance
    // or its down-stair — so retreating deep means walking back through danger.
    if (!onStairs(run) && !onEntrance(run)) {
      return { ...buildView(run, { materialDisplayNames, consumables }), action_error: 'retreat_not_here' };
    }
    return routeRunEnd({ root, state, run, outcome: 'retreated', postDungeonScreen: resolvedPostDungeonScreen, routing, now });
  }
  if (action.type === 'descend') {
    if (!onStairs(run)) return { ...buildView(run, { materialDisplayNames, consumables }), action_error: 'not_on_stairs' };
    if (run.floor >= run.max_floors) {
      accrueRunClear(run.pending_gains);
      return routeRunEnd({ root, state, run, outcome: 'cleared', postDungeonScreen: resolvedPostDungeonScreen, routing, now });
    }
    accrueFloorClear(run.pending_gains, run.floor);
    loadFloor(run, run.floor + 1);
    recoverTurnVitals(run);
    run.turn += 1;
    pushLog(run, `${run.floor}階へ降りた。`);
    await saveRuntimeState(root, { ...state, dungeon_run: { ...run, turn_events: [] } });
    return buildView(run, { materialDisplayNames, consumables });
  }

  const rng = createRng(deriveSeed(run.seed, 100000 + run.turn));
  let result;
  if (action.type === 'move') {
    const vector = MOVE_VECTORS[action.direction];
    if (!vector) throw new Error(`invalid direction: ${action.direction}`);
    result = playerMove(run, rng, vector[0], vector[1]);
  } else if (action.type === 'cast') {
    result = playerCast(run, rng, action.element);
  } else if (action.type === 'heal_spell') {
    result = playerHealingSpell(run);
  } else if (action.type === 'pierce_spell') {
    result = playerPierce(run, rng);
  } else if (action.type === 'evasion_spell') {
    result = playerEvasion(run);
  } else if (action.type === 'use_item') {
    result = playerUseItem(run, action.item_kind);
  } else if (action.type === 'use_consumable') {
    result = await playerUseConsumable({ root, run, action });
    // A successful use spent one item; refresh the snapshot so the returned view shows the new count.
    if (result.acted) consumables = await loadRunConsumables(root);
  } else if (action.type === 'wait') {
    result = { acted: true };
  } else {
    throw new Error(`unknown action type: ${action.type}`);
  }

  if (!result.acted) {
    // An invalid action (wall, no target, no mp) does not pass a turn.
    return { ...buildView(run, { materialDisplayNames, consumables }), action_error: result.error };
  }

  // Player acted -> reveal, then companion + enemies take their turn (the enemy phase resolves against the
  // player's active evasion buff), then the buff ticks down one turn.
  revealAround(run, run.player, run.player_stats, 'player', 'turn reveal');
  runCompanionTurn(run, rng);
  if (run.player.hp > 0) runEnemyTurns(run, rng);
  if (run.player.hp > 0) recoverTurnVitals(run);
  tickPlayerEvasionBuff(run);
  run.turn += 1;
  revealAround(run, run.player, run.player_stats, 'player', 'turn reveal');

  if (run.player.hp <= 0) {
    pushLog(run, '力尽きた。道中の経験は失われた。');
    return routeRunEnd({ root, state, run, outcome: 'dead', postDungeonScreen: resolvedPostDungeonScreen, routing, now });
  }

  await saveRuntimeState(root, { ...state, dungeon_run: { ...run, turn_events: [] } });
  return buildView(run, { materialDisplayNames, consumables });
}

// Routes a run end. A companion-backed run defers its (slow LLM) finalize so the
// UI can show the result and slip back to the room at once, banking on a follow-up
// finalize call (dungeonFinalizeRun). A solo run has nothing to finalize, so it
// commits synchronously right here.
function assertPostDungeonScreen(screen) {
  if (typeof screen !== 'string' || !screen) throw new Error('postDungeonScreen is required');
  return screen;
}

function routeRunEnd({ root, state, run, outcome, postDungeonScreen, routing = false, now = new Date().toISOString() }) {
  // A companion run defers its commit to dungeonFinalizeRun; the routing content
  // record is written by commitRunEnd, so beginRunEnd needs no routing/now.
  if (run.companion?.conversation_id) return beginRunEnd({ root, state, run, outcome, postDungeonScreen });
  return commitRunEnd({ root, state, run, outcome, finalizeCompanion: null, postDungeonScreen, routing, now });
}

// Step 1 of a companion run end: record the outcome and persist the run as
// "finalizing" WITHOUT banking or clearing. Returns a preview result (the gains
// that WILL be banked) so the UI shows the outcome immediately while the deferred
// finalize -> bank -> clear runs in dungeonFinalizeRun. The pending_finalize marker
// blocks further play actions and keeps re-enter rejected until the finalize lands.
// The run-end result surface carries the server-authoritative display name for each
// carried material (same "server owns the display name" grammar as alchemy/workshop
// costs), resolved from the material catalog. A buffer id absent from the catalog is
// corrupt run state and throws, matching depositDungeonMaterials' fail-fast.
function materialResultItems(buffer, displayNames) {
  return materialBufferEntries(buffer).map(({ item_id, quantity }) => {
    const display_name = displayNames.get(item_id);
    if (!display_name) throw new Error(`dungeon material id is not in the catalog: ${item_id}`);
    return { item_id, display_name, quantity };
  });
}

async function beginRunEnd({ root, state, run, outcome, postDungeonScreen }) {
  const resolvedPostDungeonScreen = assertPostDungeonScreen(postDungeonScreen);
  const displayNames = dungeonMaterialDisplayNames(await loadDungeonMaterialDefinitions({ root }));
  run.pending_finalize = { outcome };
  const events = [...(run.turn_events ?? [])];
  await saveRuntimeState(root, { ...state, dungeon_run: { ...run, turn_events: [] } });
  // The preview must be exactly what the deferred finalize will bank — same per-run cap AND the
  // 0-100 clamp (bankPendingGains), not the unclamped HUD summary — so the result surface never
  // shows a gain larger than what is actually applied (e.g. a parameter already near the 100 cap).
  const previewGains = outcome === 'dead' ? { magic: {}, abilities: {} } : bankPendingGains(run.parameters, run.pending_gains).applied;
  return {
    ended: true,
    pending_finalize: true,
    active: false,
    status: outcome,
    run_id: run.run_id,
    floor_reached: run.floor,
    max_floors: run.max_floors,
    applied_gains: previewGains,
    // The materials the deferred finalize will keep (踏破/撤退) or discard (敗北).
    // Same buffer the finalize reads, so the result screen shows what actually lands.
    materials: { items: materialResultItems(readMaterialBuffer(run), displayNames), retained: outcome !== 'dead' },
    // The boss-chest equipment the deferred finalize will confirm into player_equipment (踏破/撤退)
    // or discard (敗北) — same greed ladder as materials.
    equipment: { items: equipmentBufferItems(readEquipmentBuffer(run)), retained: outcome !== 'dead' },
    companion: run.companion ? { character_id: run.companion.character_id, name: run.companion.name, conversation_id: run.companion.conversation_id } : null,
    log: [...run.log],
    // The run-ending turn's combat (e.g. the fatal blow) so the frontend can play it before
    // the result screen. Empty for non-combat ends (retreat / cleared-by-descend).
    events,
    transition: { next_screen: resolvedPostDungeonScreen }
  };
}

// Commits a run end: finalize (if any) FIRST, then bank pending gains (retreat/
// clear) or discard them (death), then clear the run from runtime state. A finalize
// failure throws BEFORE any bank/clear, so the run stays intact — a failed finalize
// never leaves a half-confirmed result.
async function commitRunEnd({ root, state, run, outcome, finalizeCompanion = null, postDungeonScreen, routing = false, now = new Date().toISOString() }) {
  const resolvedPostDungeonScreen = assertPostDungeonScreen(postDungeonScreen);
  if (finalizeCompanion && run.companion?.conversation_id) {
    await finalizeCompanion({ conversationId: run.companion.conversation_id, characterId: run.companion.character_id });
  }

  run.status = outcome;
  delete run.pending_finalize;
  const banked = outcome === 'dead'
    ? { parameters: normalizeParameters(run.parameters), applied: { magic: {}, abilities: {} }, total_applied: 0 }
    : bankPendingGains(run.parameters, run.pending_gains);

  let world = null;
  if (outcome !== 'dead' && banked.total_applied > 0) {
    world = await updatePlayerParameters({ root, playerParameters: banked.parameters });
  } else {
    world = await loadWorldSettings({ root });
  }

  // Kept run ends (踏破/撤退) merge this run's material buffer into player_inventory;
  // death discards the whole buffer. Either way, previously-owned items are never
  // reduced. The merge runs BEFORE the state clear, so a failure leaves the run intact
  // (fail-fast, like the companion finalize above).
  const materialBuffer = readMaterialBuffer(run);
  const displayNames = dungeonMaterialDisplayNames(await loadDungeonMaterialDefinitions({ root }));
  const materialsResult = { items: materialResultItems(materialBuffer, displayNames), retained: outcome !== 'dead' };
  if (materialsResult.retained && materialsResult.items.length > 0) {
    await depositDungeonMaterials({ root, materials: materialBuffer });
  }
  // 星の揺り籠 rare drop: a kept ROUTING run may additionally yield a ほのかに温かい卵 (deterministic per run
  // seed, off the combat stream). Loop mode never rolls it, so loop dungeon runs stay byte-identical.
  if (routing && materialsResult.retained && rollDungeonWarmEgg(run.seed)) {
    await grantInventoryRewards({ root, rewards: [{ item_id: STAR_CRADLE_DUNGEON_EGG_ITEM, quantity: 1 }] });
  }

  // Kept run ends also confirm this run's opened boss-chest equipment into player_equipment as
  // validated one-of-a-kind C-08 instances; death discards the whole buffer. Runs BEFORE the state
  // clear (same fail-fast ordering as the material deposit), so a failed append leaves the run intact.
  const equipmentBuffer = readEquipmentBuffer(run);
  const equipmentResult = { items: equipmentBufferItems(equipmentBuffer), retained: outcome !== 'dead' };
  if (equipmentResult.retained) {
    for (const instance of equipmentBuffer) {
      await addEquipmentInstance({ root, instance });
    }
  }
  // The routing content result records only the display identity (no base/bonus effects — those are combat
  // detail carried on the run result / view), so project the full instances to the content-result display
  // shape before recording. Passing the full instances would fail the content-result validator's exact-key set.
  const equipmentContentResult = {
    retained: equipmentResult.retained,
    items: equipmentResult.items.map(({ base_effects, bonus_effects, ...display }) => display)
  };

  // Re-read so any runtime_state changes finalize made (work records, flags,
  // relationship) are preserved when we clear the run.
  const latestState = await loadRuntimeState(root);
  const nextState = { ...latestState, current_screen: resolvedPostDungeonScreen, dungeon_run: null };
  // Loop mode is a pure spread here (byte-identical to pre-feature): it adds no
  // routing-only fields and removes none. Only routing writes the dungeon record.
  if (routing) {
    // Bind the routing content result into the same write that clears the run and
    // sets the post-dungeon screen — no separate write to go inconsistent on a crash.
    // Loop mode never sets this, keeping loop runtime_state byte-identical.
    nextState[ROUTING_CONTENT_RESULT_STATE_KEY] = buildDungeonContentResult({
      week: requireRoutingContentWeek(latestState),
      now,
      outcome,
      floorReached: run.floor,
      maxFloors: run.max_floors,
      appliedGains: banked.applied,
      totalApplied: banked.total_applied,
      companionCharacterId: run.companion?.character_id ?? null,
      materials: materialsResult,
      equipment: equipmentContentResult
    });
  }
  await saveRuntimeState(root, nextState);

  return {
    ended: true,
    pending_finalize: false,
    active: false,
    status: outcome,
    run_id: run.run_id,
    floor_reached: run.floor,
    max_floors: run.max_floors,
    applied_gains: banked.applied,
    total_applied: banked.total_applied,
    materials: materialsResult,
    equipment: equipmentResult,
    companion: run.companion ? { character_id: run.companion.character_id, name: run.companion.name, conversation_id: run.companion.conversation_id } : null,
    world,
    state: nextState,
    log: [...run.log],
    events: [...(run.turn_events ?? [])],
    transition: { next_screen: resolvedPostDungeonScreen }
  };
}

// Step 2 of a companion run end (the deferred finalize). Loads the finalizing run
// and runs finalize -> bank -> clear. Fail-fast: a run not awaiting finalize is a
// 409; a finalize failure throws and leaves the run intact, so the UI can surface
// it and the run can retry its finalize.
export async function dungeonFinalizeRun({ root, finalizeCompanion = null, postDungeonScreen, routing = false, now = new Date().toISOString() } = {}) {
  if (!root) throw new Error('root is required');
  const resolvedPostDungeonScreen = assertPostDungeonScreen(postDungeonScreen);
  const state = await loadRuntimeState(root);
  const run = state.dungeon_run;
  if (!run || !run.pending_finalize) {
    const error = new Error('no dungeon run awaiting finalize');
    error.statusCode = 409;
    throw error;
  }
  return commitRunEnd({ root, state, run, outcome: run.pending_finalize.outcome, finalizeCompanion, postDungeonScreen: resolvedPostDungeonScreen, routing, now });
}
