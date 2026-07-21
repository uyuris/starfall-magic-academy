// Maps the 11 player/character parameters (6 magic + 5 abilities) onto the
// combat and exploration stats that drive the turn-based grid roguelike.
// This is the mechanical reflection that closes the loop:
//   train -> parameters rise -> dungeon performance rises -> more reward.
// The same mapping is applied to a companion character so their parameters
// also affect gameplay.

import { normalizeParameters } from '../parameters.mjs';
import { magicParameterDefinitions } from '../parameters.mjs';

const elementKeys = magicParameterDefinitions.map((definition) => definition.key);

function abilityValue(parameters, key) {
  return Number(parameters.abilities?.[key]?.value ?? 0);
}

function magicValue(parameters, key) {
  return Number(parameters.magic?.[key]?.value ?? 0);
}

function requiredParameterValue(parameters, group, key, purpose) {
  const entry = parameters?.[group]?.[key];
  const raw = typeof entry === 'object' && entry !== null && 'value' in entry ? entry.value : entry;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${group}.${key} is required for ${purpose}`);
  return value;
}

// Spell power for one element: the element mastery is the main driver, with
// raw magical_power as a shared amplifier across all elements.
function spellPowerFor(parameters, element) {
  const mastery = magicValue(parameters, element);
  const power = abilityValue(parameters, 'magical_power');
  return 4 + Math.round(mastery * 0.55 + power * 0.3);
}

function manaCostForMastery(mastery) {
  // Higher mastery makes a spell cheaper to cast, floored so spells always cost.
  return Math.max(2, 6 - Math.floor(mastery / 25));
}

export function spellManaCost(element, parameters) {
  const mastery = magicValue(parameters, element);
  return manaCostForMastery(mastery);
}

export function meleeManaCost(parameters) {
  const purpose = 'melee mana cost';
  const strength = requiredParameterValue(parameters, 'abilities', 'strength', purpose);
  const agility = requiredParameterValue(parameters, 'abilities', 'agility', purpose);
  return manaCostForMastery((strength + agility) / 2);
}

export function companionAiArchetype(parameters) {
  const purpose = 'companion AI archetype';
  const strength = requiredParameterValue(parameters, 'abilities', 'strength', purpose);
  const agility = requiredParameterValue(parameters, 'abilities', 'agility', purpose);
  const physicalAverage = (strength + agility) / 2;
  const topMagicMastery = Math.max(...elementKeys.map((element) => requiredParameterValue(parameters, 'magic', element, purpose)));
  return topMagicMastery > physicalAverage ? 'caster' : 'melee';
}

function strictSpellPowerFor(parameters, element, purpose) {
  const mastery = requiredParameterValue(parameters, 'magic', element, purpose);
  const power = requiredParameterValue(parameters, 'abilities', 'magical_power', purpose);
  return 4 + Math.round(mastery * 0.55 + power * 0.3);
}

export function healingSpellAmount(parameters) {
  const purpose = 'healing spell amount';
  const lightPower = strictSpellPowerFor(parameters, 'light', purpose);
  const waterPower = strictSpellPowerFor(parameters, 'water', purpose);
  return Math.max(8, Math.round((lightPower + waterPower) / 3));
}

export function healingSpellManaCost(parameters) {
  const purpose = 'healing spell mana cost';
  const lightMastery = requiredParameterValue(parameters, 'magic', 'light', purpose);
  const waterMastery = requiredParameterValue(parameters, 'magic', 'water', purpose);
  const averageMastery = (lightMastery + waterMastery) / 2;
  return Math.max(3, 7 - Math.floor(averageMastery / 25));
}

// ----- composite spells (v1): 貫通 (dark + fire) and 回避 (earth + wind) -----
// These mirror the self-heal's composite-derivation grammar: the power/bonus scales off the two elements'
// spell powers (or masteries), and the MP cost drops with the two masteries' average.

// 貫通魔法 (pierce): a defense-ignoring single-target attack. Its power is the two casters' spell powers
// averaged and lifted by a tunable coefficient, floored so it always lands a meaningful hit. The defense-
// bypass (resolved in combat) is the real payoff, so the raw power sits near a single-element cast's.
const PIERCE_SPELL_POWER_COEFFICIENT = 1.15;
export function pierceSpellPower(parameters) {
  const purpose = 'pierce spell power';
  const darkPower = strictSpellPowerFor(parameters, 'dark', purpose);
  const firePower = strictSpellPowerFor(parameters, 'fire', purpose);
  return Math.max(8, Math.round(((darkPower + firePower) / 2) * PIERCE_SPELL_POWER_COEFFICIENT));
}

// Pierce MP cost is deliberately heavier than a normal cast (2–6) or the self-heal (3–7): a 4–8 band that
// drops with the dark/fire mastery average.
export function pierceSpellManaCost(parameters) {
  const purpose = 'pierce spell mana cost';
  const darkMastery = requiredParameterValue(parameters, 'magic', 'dark', purpose);
  const fireMastery = requiredParameterValue(parameters, 'magic', 'fire', purpose);
  const averageMastery = (darkMastery + fireMastery) / 2;
  return Math.max(4, 8 - Math.floor(averageMastery / 25));
}

// 回避魔法 (evasion): an N-turn self evasion buff. The bonus (added to the caster's evasion on the rollHit
// evasion side while active) scales off the earth/wind mastery average from a tunable base; the duration is
// fixed and tunable.
export const EVASION_SPELL_DURATION = 4;
const EVASION_SPELL_BONUS_BASE = 10;
const EVASION_SPELL_BONUS_COEFFICIENT = 0.2;
export function evasionSpellBonus(parameters) {
  const purpose = 'evasion spell bonus';
  const earthMastery = requiredParameterValue(parameters, 'magic', 'earth', purpose);
  const windMastery = requiredParameterValue(parameters, 'magic', 'wind', purpose);
  return EVASION_SPELL_BONUS_BASE + Math.round(((earthMastery + windMastery) / 2) * EVASION_SPELL_BONUS_COEFFICIENT);
}

// Evasion MP cost shares the self-heal's 3–7 band (earth/wind mastery average).
export function evasionSpellManaCost(parameters) {
  const purpose = 'evasion spell mana cost';
  const earthMastery = requiredParameterValue(parameters, 'magic', 'earth', purpose);
  const windMastery = requiredParameterValue(parameters, 'magic', 'wind', purpose);
  const averageMastery = (earthMastery + windMastery) / 2;
  return Math.max(3, 7 - Math.floor(averageMastery / 25));
}

// Derives the full combat profile for an actor from its parameters.
export function deriveCombatStats(rawParameters) {
  const parameters = normalizeParameters(rawParameters ?? {});
  const strength = abilityValue(parameters, 'strength');
  const agility = abilityValue(parameters, 'agility');
  const academics = abilityValue(parameters, 'academics');
  const power = abilityValue(parameters, 'magical_power');
  const charisma = abilityValue(parameters, 'charisma');

  const spellPower = Object.fromEntries(elementKeys.map((element) => [element, spellPowerFor(parameters, element)]));

  return {
    max_hp: 32 + Math.round(strength * 0.7 + power * 0.3),
    max_mp: 8 + Math.round(power * 0.5 + academics * 0.25),
    melee_attack: 5 + Math.round(strength * 0.45 + agility * 0.1),
    defense: 2 + Math.round(strength * 0.18 + agility * 0.12),
    accuracy: 78 + Math.round(agility * 0.18),
    evasion: Math.round(agility * 0.16),
    crit_chance: Math.round(academics * 0.14),
    // Exploration reflection: sharper minds reveal more of the floor each step.
    vision_radius: 3 + Math.floor(academics / 45),
    // Agility sets the actor's speed, which governs turn order: an enemy much
    // faster than you acts twice per turn, one much slower acts every other
    // turn. Raising agility keeps fast enemies from out-speeding you.
    speed: 95 + Math.round(agility * 0.55),
    // Charisma improves the odds and quality of items found in the dungeon.
    fortune: Math.round(charisma * 0.2),
    spell_power: spellPower,
    elements: elementKeys
  };
}

export { elementKeys };
