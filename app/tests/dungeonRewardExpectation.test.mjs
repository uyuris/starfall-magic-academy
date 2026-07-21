import test from 'node:test';
import assert from 'node:assert/strict';

import { magicParameterDefinitions, abilityParameterDefinitions, defaultPlayerParameters } from '../src/parameters.mjs';
import {
  emptyPendingGains,
  accrueEnemyDefeat,
  accrueFloorClear,
  accrueRunClear,
  bankPendingGains,
  rewardTuning
} from '../src/dungeon/dungeonRewards.mjs';
import { enemyArchetypes, bossArchetypes, enemyCountForFloor } from '../src/dungeon/dungeonEnemies.mjs';
import { MILESTONE_FLOORS } from '../src/dungeon/dungeonGeneration.mjs';

const MAX_FLOORS = 10;
const PARAM_KEYS = [
  ...magicParameterDefinitions.map((definition) => ['magic', definition.key]),
  ...abilityParameterDefinitions.map((definition) => ['abilities', definition.key])
];

// Adds `factor` copies of `src`'s fractional gains into `dst`. Used to weight a
// single defeat by the expected number of times that archetype is fought.
function addScaled(dst, src, factor) {
  for (const [group, values] of Object.entries(src)) {
    for (const [key, value] of Object.entries(values)) dst[group][key] += value * factor;
  }
}

// Exact expected pending gains of a full clear, computed in closed form from the
// real reward functions (no seed sweep). Each floor spawns enemyCountForFloor
// normal enemies, each an independent uniform pick over enemyArchetypes; the two
// milestone floors add one boss each, a uniform pick over bossArchetypes.
function expectedFullClearPending() {
  const pending = emptyPendingGains();
  for (let floor = 1; floor <= MAX_FLOORS; floor += 1) {
    const count = enemyCountForFloor(floor);
    for (const archetype of enemyArchetypes) {
      const one = emptyPendingGains();
      accrueEnemyDefeat(one, archetype.id, floor);
      addScaled(pending, one, count / enemyArchetypes.length);
    }
  }
  for (const floor of MILESTONE_FLOORS) {
    for (const boss of bossArchetypes) {
      const one = emptyPendingGains();
      accrueEnemyDefeat(one, boss.id, floor);
      addScaled(pending, one, 1 / bossArchetypes.length);
    }
  }
  for (let floor = 1; floor < MAX_FLOORS; floor += 1) accrueFloorClear(pending, floor);
  accrueRunClear(pending);
  return pending;
}

// A wipe-free descent that never fights: only the floor/run completion bonus.
function zeroKillPending() {
  const pending = emptyPendingGains();
  for (let floor = 1; floor < MAX_FLOORS; floor += 1) accrueFloorClear(pending, floor);
  accrueRunClear(pending);
  return pending;
}

function totalPending(pending) {
  let total = 0;
  for (const values of Object.values(pending)) {
    for (const value of Object.values(values)) total += value;
  }
  return total;
}

test('a full clear raises every parameter by ~+20 in expectation', () => {
  const pending = expectedFullClearPending();
  // Inner band [18.5, 21.5] on the expected raw gain. bankPendingGains applies
  // Math.round per parameter, and |Math.round(x) - x| < 0.5, so the expected
  // applied value stays inside [18, 22] for every parameter.
  for (const [group, key] of PARAM_KEYS) {
    const value = pending[group][key];
    assert.ok(value >= 18.5 && value <= 21.5, `${group}.${key} expected raw gain ${value.toFixed(3)} should sit in [18.5, 21.5]`);
  }
});

test('the run cap sits above the full-clear total and does not scale it down', () => {
  const total = totalPending(expectedFullClearPending());
  // The full-clear total is deterministic (every defeat banks its whole pool
  // regardless of which archetype it was), so a cap above it never scales a
  // real full clear — it only guards against outliers.
  assert.ok(total < rewardTuning.RUN_GAIN_CAP, `full-clear total ${total.toFixed(2)} should be below the cap ${rewardTuning.RUN_GAIN_CAP}`);
  assert.ok(rewardTuning.RUN_GAIN_CAP <= total + 60, `cap ${rewardTuning.RUN_GAIN_CAP} should stay a snug outlier guard above ${total.toFixed(2)}`);
});

test('banking the expected full clear applies +18..+22 to each parameter with no cap scaling', () => {
  const pending = expectedFullClearPending();
  const banked = bankPendingGains(defaultPlayerParameters(), pending);
  // No cap scaling: the applied total equals the sum of per-parameter rounds.
  const roundedTotal = PARAM_KEYS.reduce((sum, [group, key]) => sum + Math.round(pending[group][key]), 0);
  assert.equal(banked.total_applied, roundedTotal, 'no cap scaling should occur for a full clear');
  for (const [group, key] of PARAM_KEYS) {
    const applied = banked.applied[group][key];
    assert.ok(applied >= 18 && applied <= 22, `${group}.${key} applied ${applied} should sit in [18, 22]`);
  }
});

test('avoiding every fight never beats fighting, per parameter and in total', () => {
  const full = expectedFullClearPending();
  const zero = zeroKillPending();
  for (const [group, key] of PARAM_KEYS) {
    assert.ok(zero[group][key] <= full[group][key], `${group}.${key}: skipping fights (${zero[group][key].toFixed(2)}) must not beat clearing (${full[group][key].toFixed(2)})`);
  }
  assert.ok(totalPending(zero) < totalPending(full), 'skipping every fight must total strictly less than a full clear');
});
