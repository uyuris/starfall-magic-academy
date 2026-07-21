// Experience accrual and banking. Experience is held as fractional pending
// gains per parameter during a run and only converted into real player
// parameters on retreat (confirmed) — a wipe discards them (lost). There is no
// intermediate XP/level layer: the dungeon trains the same 11-parameter store
// as basic training.
//
// Tuning target (うゆりすさん): one successful full clear (floors 1-10, no wipe,
// every normal enemy and both milestone bosses defeated) raises each of the 11
// parameters by ~20 in expectation (~2 per floor). Enemy defeats feed themed
// parameters — an element's magic plus that archetype's trained ability —
// which is uneven across the roster; the floor/run completion bonus is
// distributed across all 11 parameters with per-parameter weights that offset
// that unevenness so every parameter converges on the +20 target. RUN_GAIN_CAP
// sits above the full-clear total and only guards against outliers.

import { abilityParameterDefinitions, magicParameterDefinitions, normalizeParameters } from '../parameters.mjs';
import { enemyArchetype } from './dungeonEnemies.mjs';

const ENEMY_REWARD_POOL = 0.16;   // point pool granted by a defeat on floor 1
const FLOOR_DEPTH_MULT = 0.5;     // each floor deeper multiplies enemy/clear reward
const FLOOR_CLEAR_BONUS = 4.4;    // pool granted for clearing (descending past) a floor
const RUN_CLEAR_BONUS = 8;        // pool granted for clearing the whole dungeon
const RUN_GAIN_CAP = 260;         // ceiling on total points banked from one run (outlier guard, above the ~220 full-clear total)

export function emptyPendingGains() {
  return {
    magic: Object.fromEntries(magicParameterDefinitions.map((definition) => [definition.key, 0])),
    abilities: Object.fromEntries(abilityParameterDefinitions.map((definition) => [definition.key, 0]))
  };
}

function depthMultiplier(floor) {
  return 1 + FLOOR_DEPTH_MULT * Math.max(0, Math.floor(floor) - 1);
}

function addToPending(pending, group, key, amount) {
  if (!(group in pending) || !(key in pending[group])) throw new Error(`unknown parameter target: ${group}.${key}`);
  pending[group][key] += amount;
}

// Distributes a point pool across a set of weighted parameter targets.
function distribute(pending, targets, pool) {
  const totalWeight = targets.reduce((sum, target) => sum + target.weight, 0);
  if (totalWeight <= 0) return;
  for (const target of targets) {
    addToPending(pending, target.group, target.key, pool * (target.weight / totalWeight));
  }
}

// The floor/run completion bonus reaches every parameter, not only abilities:
// clearing floors consolidates all of a delver's training. The weights offset
// the uneven parameter pull of enemy defeats (elements with fewer archetypes
// and abilities that combat trains rarely receive more) so a full clear brings
// each parameter to the shared +20 target.
const completionBonusTargets = [
  { group: 'magic', key: 'light', weight: 9 },
  { group: 'magic', key: 'dark', weight: 9 },
  { group: 'magic', key: 'fire', weight: 9 },
  { group: 'magic', key: 'water', weight: 9 },
  { group: 'magic', key: 'earth', weight: 13 },
  { group: 'magic', key: 'wind', weight: 13 },
  { group: 'abilities', key: 'strength', weight: 13 },
  { group: 'abilities', key: 'agility', weight: 10 },
  { group: 'abilities', key: 'academics', weight: 12 },
  { group: 'abilities', key: 'magical_power', weight: 15 },
  { group: 'abilities', key: 'charisma', weight: 15 }
];

export function accrueEnemyDefeat(pending, archetypeId, floor) {
  const archetype = enemyArchetype(archetypeId);
  distribute(pending, archetype.grants, ENEMY_REWARD_POOL * depthMultiplier(floor));
  return pending;
}

export function accrueFloorClear(pending, floor) {
  distribute(pending, completionBonusTargets, FLOOR_CLEAR_BONUS * depthMultiplier(floor));
  return pending;
}

export function accrueRunClear(pending) {
  distribute(pending, completionBonusTargets, RUN_CLEAR_BONUS);
  return pending;
}

function totalPending(pending) {
  let total = 0;
  for (const group of Object.values(pending)) {
    for (const value of Object.values(group)) total += value;
  }
  return total;
}

// Rounded preview of the pending gains, for live HUD display.
export function summarizePendingGains(pending) {
  const scale = scaleFor(pending);
  const summary = { magic: {}, abilities: {} };
  for (const [group, values] of Object.entries(pending)) {
    for (const [key, value] of Object.entries(values)) {
      const rounded = Math.round(value * scale);
      if (rounded > 0) summary[group][key] = rounded;
    }
  }
  return summary;
}

function scaleFor(pending) {
  const total = totalPending(pending);
  return total > RUN_GAIN_CAP ? RUN_GAIN_CAP / total : 1;
}

// Applies pending gains onto the parameter store (clamped 0-100), honoring the
// per-run cap. Returns the next normalized parameters and the applied deltas.
export function bankPendingGains(rawParameters, pending) {
  const normalized = normalizeParameters(rawParameters ?? {});
  const scale = scaleFor(pending);
  const applied = { magic: {}, abilities: {} };
  let totalApplied = 0;
  for (const [group, values] of Object.entries(pending)) {
    for (const [key, value] of Object.entries(values)) {
      const delta = Math.round(value * scale);
      if (delta <= 0) continue;
      const before = normalized[group][key].value;
      const after = Math.max(0, Math.min(100, before + delta));
      const realDelta = after - before;
      if (realDelta > 0) {
        normalized[group][key].value = after;
        applied[group][key] = realDelta;
        totalApplied += realDelta;
      }
    }
  }
  return { parameters: normalized, applied, total_applied: totalApplied };
}

export const rewardTuning = {
  ENEMY_REWARD_POOL,
  FLOOR_DEPTH_MULT,
  FLOOR_CLEAR_BONUS,
  RUN_CLEAR_BONUS,
  RUN_GAIN_CAP
};
