// Shared turn-based combat AI: the "companion-style" discipline that drives an actor
// through one turn — self-heal when hurt, pick the nearest enemy it can see, then kite
// (caster) or close and strike (melee), spending MP only above its reserve line. The
// dungeon (C-23) drives its single companion with it; the arena engine (C-26) drives
// every AI actor with it. The subsystem-specific parts (which actors are enemies, how a
// downed target is handled, whether a lone actor regroups) are injected through a
// `field` adapter so the discipline itself is defined once.
//
// `field` adapter contract:
//   board                       { width, height, tiles }
//   rng                         seeded RNG for this turn
//   opposingActors              array of the actor's enemies (may include downed; hp>0 filtered here)
//   regroupTarget               actor to move toward when no enemy remains, or null
//   visionRadius(actor)         Chebyshev sight radius (Infinity = all-visible board)
//   occupiedTile(x, y)          any living actor stands on (x,y) — movement blocker
//   canStand(actor, x, y)       actor may reposition onto (x,y) (walkable, not avoided, no other actor)
//   spellManaCost(actor, elem)  equipment-adjusted spell MP cost
//   healingSpellState(actor)    equipment-adjusted self-heal state
//   pushLog(message)            append an action-log line
//   pushEvent(event)            append a combat animation event
//   onDefeat(target)            handle a target dropped to 0 HP (rewards/removal + log)

import { companionAiArchetype } from './dungeonStats.mjs';
import { castSelfHealingSpell, magicElementLabel, meleeOutcome, mpAboveReserve, spellOutcome, spendMeleeMana } from './combatResolution.mjs';
import { CARDINAL_DIRECTIONS, canSeeCellWithinRadius, hasLineOfSight, manhattan, orderedPathDirections, pathKey, pathStepFrom, stepToward } from './combatGeometry.mjs';

const SPELL_MIN_RANGE = 2;
const SPELL_MAX_RANGE = 4;

// ----- target selection -----

function livingEnemies(field) {
  return field.opposingActors.filter((enemy) => enemy.hp > 0);
}

function nearestLivingEnemy(field, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const enemy of field.opposingActors) {
    if (enemy.hp <= 0) continue;
    const dist = manhattan(x, y, enemy.x, enemy.y);
    if (dist < bestDist) {
      best = enemy;
      bestDist = dist;
    }
  }
  return best;
}

function actorCanSeeCell(field, actor, x, y) {
  return canSeeCellWithinRadius(field.board, actor, field.visionRadius(actor), x, y);
}

function nearestLivingEnemyVisibleToActor(field, actor) {
  let best = null;
  let bestDist = Infinity;
  for (const enemy of livingEnemies(field)) {
    if (!actorCanSeeCell(field, actor, enemy.x, enemy.y)) continue;
    const dist = manhattan(actor.x, actor.y, enemy.x, enemy.y);
    if (dist < bestDist) {
      best = enemy;
      bestDist = dist;
    }
  }
  return best;
}

// ----- attack primitives -----

function castAt(field, actor, target, element, manaCost) {
  actor.mp -= manaCost;
  const outcome = spellOutcome(field.rng, actor.stats.spell_power[element], element, target);
  field.pushEvent({ kind: 'cast', from: { x: actor.x, y: actor.y }, to: { x: target.x, y: target.y }, element, hit: true });
  target.hp = Math.max(0, target.hp - outcome.damage);
  field.pushLog(`${actor.name}の${magicElementLabel(element)}。${target.name}に${outcome.damage}ダメージ。`);
  if (target.hp <= 0) field.onDefeat(target);
}

function meleeAttack(field, actor, target) {
  // Below the reserve line the actor holds its MP for self-heal and does not bump: the same
  // "no melee this turn" outcome as being unable to pay the melee mana cost (見送り, not an error).
  if (!mpAboveReserve(actor)) return false;
  const payment = spendMeleeMana(actor, actor.parameters, 'combat actor');
  if (!payment.paid) return false;
  const outcome = meleeOutcome(field.rng, { ...actor.stats, attack: actor.stats.melee_attack }, target);
  field.pushEvent({ kind: 'melee', from: { x: actor.x, y: actor.y }, to: { x: target.x, y: target.y }, element: null, hit: outcome.hit });
  if (outcome.hit) {
    target.hp = Math.max(0, target.hp - outcome.damage);
    field.pushLog(`${actor.name}が${target.name}に${outcome.damage}ダメージ。`);
    if (target.hp <= 0) field.onDefeat(target);
  }
  return true;
}

function canCastWithClearLine(field, actor, target, manaCost) {
  return mpAboveReserve(actor) && actor.mp >= manaCost && hasLineOfSight(field.board, actor, target);
}

function canCastAt(field, actor, target, manaCost) {
  const distance = manhattan(actor.x, actor.y, target.x, target.y);
  return distance >= SPELL_MIN_RANGE
    && distance <= SPELL_MAX_RANGE
    && canCastWithClearLine(field, actor, target, manaCost);
}

// ----- caster kiting -----

function casterRangeScore(distance) {
  if (distance < SPELL_MIN_RANGE) return distance;
  if (distance <= SPELL_MAX_RANGE) return 1000 + distance;
  return 100 - (distance - SPELL_MAX_RANGE);
}

function casterPositionScore(field, cell, target) {
  const distance = manhattan(cell.x, cell.y, target.x, target.y);
  const clearLine = hasLineOfSight(field.board, cell, target);
  return casterRangeScore(distance) + (clearLine ? 20 : 0);
}

function moveActorForReposition(field, actor, step) {
  if (!field.canStand(actor, step.x, step.y)) return false;
  actor.x = step.x;
  actor.y = step.y;
  return true;
}

function repositionCaster(field, actor, target) {
  const current = { x: actor.x, y: actor.y };
  const currentScore = casterPositionScore(field, current, target);
  const candidates = CARDINAL_DIRECTIONS
    .map(([dx, dy], index) => ({ x: actor.x + dx, y: actor.y + dy, index }))
    .filter((cell) => field.canStand(actor, cell.x, cell.y))
    .map((cell) => ({
      ...cell,
      score: casterPositionScore(field, cell, target),
      distance: manhattan(cell.x, cell.y, target.x, target.y)
    }))
    .filter((cell) => cell.score > currentScore)
    .sort((a, b) => b.score - a.score || b.distance - a.distance || a.index - b.index);
  const step = candidates[0];
  if (!step) return false;
  return moveActorForReposition(field, actor, step);
}

function runCorneredCasterFallback(field, actor, target, element, manaCost) {
  if (canCastWithClearLine(field, actor, target, manaCost)) {
    castAt(field, actor, target, element, manaCost);
    return true;
  }
  if (manhattan(actor.x, actor.y, target.x, target.y) === 1) {
    return meleeAttack(field, actor, target);
  }
  return false;
}

function casterCellHasSpellLine(field, cell, enemies) {
  return enemies.some((enemy) => {
    const distance = manhattan(cell.x, cell.y, enemy.x, enemy.y);
    return distance >= SPELL_MIN_RANGE
      && distance <= SPELL_MAX_RANGE
      && hasLineOfSight(field.board, cell, enemy);
  });
}

function moveCasterTowardCastingPosition(field, actor, focus) {
  const enemies = livingEnemies(field);
  if (enemies.length === 0) return false;
  const startKey = pathKey(actor.x, actor.y);
  const cameFrom = new Map([[startKey, null]]);
  const cells = new Map([[startKey, { x: actor.x, y: actor.y }]]);
  const queue = [{ x: actor.x, y: actor.y, key: startKey }];

  while (queue.length) {
    const current = queue.shift();
    for (const { dx, dy } of orderedPathDirections(current, focus)) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = pathKey(nx, ny);
      if (cameFrom.has(key)) continue;
      if (!field.canStand(actor, nx, ny)) continue;

      cameFrom.set(key, current.key);
      cells.set(key, { x: nx, y: ny });
      if (casterCellHasSpellLine(field, { x: nx, y: ny }, enemies)) {
        return pathStepFrom(actor, key, cameFrom, cells);
      }
      queue.push({ x: nx, y: ny, key });
    }
  }

  return stepToward(field.board, actor, focus, field.occupiedTile);
}

function runCasterTurn(field, actor, target, element, manaCost) {
  const baseline = actor.caster_reposition_baseline;
  if (baseline !== null
    && (typeof baseline !== 'object'
      || typeof baseline.target_uid !== 'string'
      || !Number.isFinite(baseline.score))) {
    throw new Error('combat actor caster_reposition_baseline state is required (null or {target_uid, score})');
  }
  // A preferred-range cast is the kiting-success signal: cast and forget the
  // baseline, so a caster that can still cast at range is never pre-empted.
  if (canCastAt(field, actor, target, manaCost)) {
    castAt(field, actor, target, element, manaCost);
    actor.caster_reposition_baseline = null;
    return;
  }
  // Detect the actual re-close loop (the dance), not a fixed turn count: last turn we
  // repositioned against this same target to improve past baseline.score, yet our
  // position is now no better than it was BEFORE that reposition — the target closed
  // the gap we opened, so kiting is not converging. Stop dodging and commit through
  // the cornered fallback (point-blank cast, then adjacent melee). A reposition that
  // DID hold its ground (score still above the old baseline) is still converging, so
  // a legitimate multi-turn approach to preferred range is never pre-empted.
  const currentScore = casterPositionScore(field, { x: actor.x, y: actor.y }, target);
  const reClosed = baseline !== null
    && baseline.target_uid === target.uid
    && currentScore <= baseline.score;
  if (!reClosed) {
    if (repositionCaster(field, actor, target)) {
      actor.caster_reposition_baseline = { target_uid: target.uid, score: currentScore };
      return;
    }
    // No score-improving reposition exists (cornered): no open gap remains for the
    // baseline to describe, so clear it before committing.
    actor.caster_reposition_baseline = null;
  }
  runCorneredCasterFallback(field, actor, target, element, manaCost);
}

// ----- one full AI turn for an actor -----

// Resolves a single acting turn for `actor` against `field`. The actor must be alive
// and on the board (the caller skips downed actors). Mutates actor/target/field state
// and appends any log/event lines through the field writers.
export function runActorAiTurn(field, actor) {
  const healingSpell = field.healingSpellState(actor);
  if (healingSpell.can_use && actor.hp <= Math.floor(actor.max_hp / 2)) {
    castSelfHealingSpell(actor, healingSpell, actor.name, field.pushLog);
    return;
  }
  const visibleTarget = nearestLivingEnemyVisibleToActor(field, actor);
  const objective = visibleTarget ?? nearestLivingEnemy(field, actor.x, actor.y);
  if (!objective) {
    // No enemies remain: regroup toward the anchor if the field defines one.
    if (field.regroupTarget && manhattan(actor.x, actor.y, field.regroupTarget.x, field.regroupTarget.y) > 1) {
      stepToward(field.board, actor, field.regroupTarget, field.occupiedTile);
    }
    return;
  }
  // Cast its strongest element at range when it has the mana for it.
  const bestElement = actor.element;
  const manaCost = field.spellManaCost(actor, bestElement);
  const archetype = companionAiArchetype(actor.parameters);
  if (archetype === 'caster' && !visibleTarget) {
    moveCasterTowardCastingPosition(field, actor, objective);
    return;
  }
  if (!visibleTarget) {
    stepToward(field.board, actor, objective, field.occupiedTile);
    return;
  }
  const target = visibleTarget;
  if (archetype === 'caster') {
    runCasterTurn(field, actor, target, bestElement, manaCost);
    return;
  }
  if (canCastAt(field, actor, target, manaCost)) {
    castAt(field, actor, target, bestElement, manaCost);
    return;
  }
  const distance = manhattan(actor.x, actor.y, target.x, target.y);
  if (distance === 1) {
    meleeAttack(field, actor, target);
    return;
  }
  stepToward(field.board, actor, objective, field.occupiedTile);
}
