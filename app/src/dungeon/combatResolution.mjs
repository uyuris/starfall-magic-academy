// Shared grid-combat resolution: the damage/hit/variance math, element advantage,
// mana costs, self-heal state, per-turn regeneration, equipment effect readers, and
// the MP-reserve line compare. These are pure formulas over an actor + its parameters
// + its entry equipment snapshot — no board, occupancy, or run/match structure. The
// practical-training dungeon (C-23) and the arena combat engine (C-26) both import
// them, so a single definition drives both subsystems' numbers.

import { magicParameterDefinitions } from '../parameters.mjs';
import { EVASION_SPELL_DURATION, evasionSpellBonus, evasionSpellManaCost, healingSpellAmount, healingSpellManaCost, meleeManaCost, pierceSpellManaCost, pierceSpellPower, spellManaCost } from './dungeonStats.mjs';
import { MP_RESERVE_MAX, MP_RESERVE_MIN } from '../mpReserve.mjs';

// Per-turn vitals regeneration, applied once to every living actor at a round's end.
export const TURN_MANA_REGEN = 1;
export const TURN_HEALTH_REGEN = 1;

// Combat balance multipliers, shared by both grid-combat subsystems (the practical-training
// dungeon C-23 and the arena engine C-26) so the scaling is defined exactly once and neither
// subsystem double-applies. Every combatant's HP pool is its stat-derived (equipment-folded)
// max × COMBAT_HP_MULTIPLIER; every fixed healing amount (self-heal spell, HP/MP restore
// consumables, dungeon pickup restores) is scaled by COMBAT_HEAL_MULTIPLIER. Damage, defense,
// speed, MP pool, and per-turn regen are untouched; max-ratio effects (heal_full, revive) follow
// the scaled HP pool automatically. Tunable.
export const COMBAT_HP_MULTIPLIER = 3;
export const COMBAT_HEAL_MULTIPLIER = 2;

// The combat HP pool for an actor whose stat-derived (equipment-folded) max is `baseMaxHp`.
// The single definition every combatant-construction site seeds its hp/max_hp from.
export function combatMaxHp(baseMaxHp) {
  return baseMaxHp * COMBAT_HP_MULTIPLIER;
}

const elementalAdvantage = { light: 'dark', dark: 'light', fire: 'wind', wind: 'earth', earth: 'water', water: 'fire' };
const magicElementLabels = new Map(magicParameterDefinitions.map((definition) => [
  definition.key,
  definition.label.replace(/習熟度$/, '')
]));

export function magicElementLabel(element) {
  const label = magicElementLabels.get(element);
  if (!label) throw new Error(`unknown magic element: ${element}`);
  return label;
}

// ----- damage / hit resolution -----

function advantageMultiplier(attackerElement, defenderElement) {
  if (attackerElement && elementalAdvantage[attackerElement] === defenderElement) return 1.4;
  return 1;
}

function rollHit(rng, accuracy, evasion) {
  const chance = Math.max(5, Math.min(99, accuracy - evasion));
  return rng.int(1, 100) <= chance;
}

function variance(rng) {
  return rng.int(82, 118) / 100;
}

export function meleeOutcome(rng, attacker, defender) {
  if (!rollHit(rng, attacker.accuracy ?? 80, defender.evasion ?? 0)) {
    return { hit: false, damage: 0, crit: false };
  }
  const raw = Math.round((attacker.attack ?? attacker.melee_attack ?? 1) * variance(rng));
  const crit = rng.int(1, 100) <= (attacker.crit_chance ?? 0);
  const advantage = advantageMultiplier(attacker.element ?? null, defender.element ?? null);
  const damage = Math.max(1, Math.round(raw * advantage * (crit ? 1.5 : 1)) - (defender.defense ?? 0));
  return { hit: true, damage, crit };
}

// `ignoreDefense` (default false) bypasses the defender's defense term — used by the composite 貫通 spell.
// It draws exactly the same single `variance` roll either way, so an existing 4-arg caller (arena, the normal
// cast, the AI) is byte-identical: the option only zeroes the defense subtraction it opts into.
export function spellOutcome(rng, power, element, defender, { ignoreDefense = false } = {}) {
  const raw = Math.round(power * variance(rng));
  const advantage = advantageMultiplier(element, defender.element ?? null);
  const defenseTerm = ignoreDefense ? 0 : Math.floor((defender.defense ?? 0) / 2);
  const damage = Math.max(1, Math.round(raw * advantage) - defenseTerm);
  return { damage };
}

// ----- self-heal spell state -----

function healingSpellState(actor, parameters) {
  if (!Number.isFinite(actor.hp) || !Number.isFinite(actor.max_hp)) {
    throw new Error('combat actor HP is required for healing spell');
  }
  if (!Number.isFinite(actor.mp) || !Number.isFinite(actor.max_mp)) {
    throw new Error('combat actor MP is required for healing spell');
  }
  const mpCost = healingSpellManaCost(parameters);
  const amount = healingSpellAmount(parameters);
  const recoverableHp = Math.min(amount, Math.max(0, actor.max_hp - actor.hp));
  return {
    action_type: 'heal_spell',
    mp_cost: mpCost,
    heal_amount: amount,
    recoverable_hp: recoverableHp,
    can_use: actor.mp >= mpCost && recoverableHp > 0
  };
}

// Casts a self-heal that a caller already validated as usable. Mutates the actor's
// HP/MP and appends the log line through the supplied writer. Returns the same
// acted/error shape the AI and player paths branch on.
export function castSelfHealingSpell(actor, spell, casterName, pushLog) {
  if (actor.mp < spell.mp_cost) return { acted: false, error: 'insufficient_mp' };
  if (spell.recoverable_hp <= 0) return { acted: false, error: 'hp_full' };
  actor.mp -= spell.mp_cost;
  actor.hp = Math.min(actor.max_hp, actor.hp + spell.heal_amount);
  pushLog(`${casterName}の回復魔法。HPが${spell.recoverable_hp}回復。`);
  return { acted: true };
}

// ----- equipment effect readers over an entry equipment snapshot -----
// Absent equipment is a zero modifier, so an unequipped actor is numerically identical.

function equipmentSpellMpDiscount(equipment) {
  return equipment ? equipment.effects.spell_mp_discount : 0;
}

function equipmentSelfHealBonus(equipment) {
  return equipment ? equipment.effects.self_heal_bonus : 0;
}

// Spell MP cost for an actor with its equipment discount applied, floored at 1 so a
// spell is never free.
export function equippedSpellManaCost(element, parameters, equipment) {
  return Math.max(1, spellManaCost(element, parameters) - equipmentSpellMpDiscount(equipment));
}

// An actor's self-heal state with the equipment MP discount (floored at 1) and
// self-heal bonus applied on top of the parameter-derived base.
export function equippedHealingSpellState(actor, parameters, equipment) {
  const base = healingSpellState(actor, parameters);
  const mpCost = Math.max(1, base.mp_cost - equipmentSpellMpDiscount(equipment));
  // The equipment-adjusted heal, scaled by the combat heal multiplier (recoverable_hp / can_use
  // recompute against the scaled HP pool, so preview and applied heal always agree).
  const healAmount = (base.heal_amount + equipmentSelfHealBonus(equipment)) * COMBAT_HEAL_MULTIPLIER;
  const recoverableHp = Math.min(healAmount, Math.max(0, actor.max_hp - actor.hp));
  return {
    action_type: 'heal_spell',
    mp_cost: mpCost,
    heal_amount: healAmount,
    recoverable_hp: recoverableHp,
    can_use: actor.mp >= mpCost && recoverableHp > 0
  };
}

// ----- composite spell states (v1): 貫通 (pierce) and 回避 (evasion), player-only -----
// Both mirror the self-heal state grammar: the front end renders the button straight from this state and
// never recomputes power / cost / duration. Equipment applies only the shared spell MP discount (floored at
// 1); the composite power/bonus is parameter-derived (like the self-heal amount). `can_use` gates on MP only —
// target availability (pierce) is resolved at cast time and surfaced as a turn-non-consuming action_error.

export function equippedPierceSpellState(actor, parameters, equipment) {
  if (!Number.isFinite(actor.mp) || !Number.isFinite(actor.max_mp)) {
    throw new Error('combat actor MP is required for pierce spell');
  }
  const mpCost = Math.max(1, pierceSpellManaCost(parameters) - equipmentSpellMpDiscount(equipment));
  return {
    action_type: 'pierce_spell',
    mp_cost: mpCost,
    power: pierceSpellPower(parameters),
    can_use: actor.mp >= mpCost
  };
}

// `buff` is the caster's live evasion buff ({ turns_remaining, bonus }) or null/undefined when inactive —
// absence reads as "no active buff" (0 turns), never a masked error.
export function equippedEvasionSpellState(actor, parameters, equipment, buff = null) {
  if (!Number.isFinite(actor.mp) || !Number.isFinite(actor.max_mp)) {
    throw new Error('combat actor MP is required for evasion spell');
  }
  const mpCost = Math.max(1, evasionSpellManaCost(parameters) - equipmentSpellMpDiscount(equipment));
  const turnsRemaining = buff && Number.isFinite(buff.turns_remaining) ? Math.max(0, buff.turns_remaining) : 0;
  return {
    action_type: 'evasion_spell',
    mp_cost: mpCost,
    duration: EVASION_SPELL_DURATION,
    evasion_bonus: evasionSpellBonus(parameters),
    turns_remaining: turnsRemaining,
    active: turnsRemaining > 0,
    can_use: actor.mp >= mpCost
  };
}

// `actorLabel` is the full subject phrase in the fail-fast message (e.g. 'dungeon player'),
// so each caller keeps its own exact wording while sharing this one MP-spend definition.
export function spendMeleeMana(actor, parameters, actorLabel) {
  if (!Number.isFinite(actor.mp) || !Number.isFinite(actor.max_mp)) {
    throw new Error(`${actorLabel} MP is required for melee attack`);
  }
  const cost = meleeManaCost(parameters);
  if (actor.mp < cost) return { paid: false, cost };
  actor.mp -= cost;
  return { paid: true, cost };
}

export function recoverActorVitals(actor) {
  if (!Number.isFinite(actor.hp) || !Number.isFinite(actor.max_hp)) {
    throw new Error('combat actor HP is required for turn regeneration');
  }
  if (!Number.isFinite(actor.mp) || !Number.isFinite(actor.max_mp)) {
    throw new Error('combat actor MP is required for turn mana regeneration');
  }
  actor.hp = Math.min(actor.max_hp, actor.hp + TURN_HEALTH_REGEN);
  actor.mp = Math.min(actor.max_mp, actor.mp + TURN_MANA_REGEN);
}

// ----- MP-reserve line -----

// The actor's entry-snapshot MP reserve line, validated on read. A corrupt / older snapshot missing
// the field fails fast — never normalized to a default.
export function mpReservePercent(actor) {
  const percent = actor.mp_reserve_percent;
  if (!Number.isInteger(percent) || percent < MP_RESERVE_MIN || percent > MP_RESERVE_MAX) {
    throw new Error(`combat actor mp_reserve_percent snapshot must be an integer from ${MP_RESERVE_MIN} to ${MP_RESERVE_MAX}: ${percent}`);
  }
  return percent;
}

// Whether the actor will spend MP on an attack this turn: true only when its current MP share is
// strictly ABOVE the reserve line. At or below the line it conserves MP for self-heal, declining cast
// and melee exactly as if it could not afford them. Integer compare avoids float:
// mp/max_mp*100 <= line  ⟺  mp*100 <= line*max_mp. A line of 0 leaves behavior identical to before
// (mp*100 > 0 whenever mp > 0, and a 0-MP actor could not attack anyway).
export function mpAboveReserve(actor) {
  return actor.mp * 100 > mpReservePercent(actor) * actor.max_mp;
}
