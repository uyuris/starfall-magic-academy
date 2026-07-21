import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY,
  buildAlchemyContentResult,
  buildAuctionContentResult,
  buildDungeonContentResult,
  buildErrandContentResult,
  buildHomunculusContentResult,
  buildStudyCircleRoutingContentResult,
  buildTrainingContentResult,
  foldTrainingDayIntoAccumulator,
  readRoutingContentResult,
  requireRoutingContentWeek,
  validateRoutingContentResult
} from '../src/routingContentResult.mjs';
import { ROUTING_ACTIVE_ERRAND_STATE_KEY } from '../src/routingErrands.mjs';
import { runTraining, skipTraining } from '../src/training.mjs';
import { enterDungeon, dungeonAction } from '../src/dungeon/dungeonEngine.mjs';
import { rollBossTreasureEquipment } from '../src/dungeon/dungeonEquipmentDrops.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

// ---------------------------------------------------------------------------
// Pure module: validator + reader
// ---------------------------------------------------------------------------

function validTrainingRecord() {
  return {
    kind: 'training',
    destination_id: 'training',
    week: 3,
    recorded_at: '2026-07-02T00:00:00.000Z',
    trigger: 'training_completed',
    detail: {
      outcome: 'completed',
      trainings: [{ day_index: 0, day_name: '光曜', training_id: 'healing_practice', training_name: '治癒魔法実習' }],
      parameter_deltas: { magic: { light: 4 }, abilities: { magical_power: 2 } }
    }
  };
}

function validDungeonRecord() {
  return {
    kind: 'dungeon',
    destination_id: 'dungeon',
    week: 5,
    recorded_at: '2026-07-02T00:00:00.000Z',
    trigger: 'dungeon_run_committed',
    detail: {
      outcome: 'retreated',
      floor_reached: 3,
      max_floors: 10,
      applied_gains: { magic: { fire: 3 }, abilities: { strength: 6 } },
      total_applied: 9,
      companion_character_id: null
    }
  };
}

function validErrandRecord() {
  return {
    kind: 'errand',
    destination_id: 'errand',
    week: 4,
    recorded_at: '2026-07-02T00:00:00.000Z',
    trigger: 'errand_completed',
    detail: {
      outcome: 'completed',
      achieved: true,
      errand_id: 'archive_slip_sort',
      title: '資料室の貸出票整理',
      reward_money: 35,
      client_character_id: 'character_003',
      client_display_name: '三番'
    }
  };
}

function validAlchemyRecord() {
  return {
    kind: 'alchemy',
    destination_id: 'alchemy',
    week: 6,
    recorded_at: '2026-07-02T00:00:00.000Z',
    trigger: 'alchemy_recipe_completed',
    detail: {
      outcome: 'completed',
      recipe_id: 'alchemy_stardust_konpeito',
      item_id: 'alchemy_stardust_konpeito',
      name: '星屑の金平糖',
      category: 'gift',
      quantity: 1
    }
  };
}

function validStudyCircleRecord() {
  return {
    kind: 'study_circle',
    destination_id: 'study_circle',
    week: 7,
    recorded_at: '2026-07-02T00:00:00.000Z',
    trigger: 'study_circle_completed',
    detail: {
      outcome: 'completed',
      achieved: true,
      theme_id: 'healing_practice',
      theme_name: '治癒魔法実習',
      host_character_id: 'character_001',
      host_display_name: 'セラ',
      parameter_deltas: { magic: { light: 1 }, abilities: { magical_power: 1 } }
    }
  };
}

function validStudyCircleContentResult() {
  const record = validStudyCircleRecord();
  return {
    kind: record.kind,
    destination_id: record.destination_id,
    trigger: record.trigger,
    detail: record.detail
  };
}

test('validateRoutingContentResult accepts well-formed training, dungeon, errand, alchemy, and study-circle records', () => {
  assert.deepEqual(validateRoutingContentResult(validTrainingRecord()), validTrainingRecord());
  assert.deepEqual(validateRoutingContentResult(validDungeonRecord()), validDungeonRecord());
  assert.deepEqual(validateRoutingContentResult(validErrandRecord()), validErrandRecord());
  assert.deepEqual(validateRoutingContentResult(validAlchemyRecord()), validAlchemyRecord());
  assert.deepEqual(validateRoutingContentResult(validStudyCircleRecord()), validStudyCircleRecord());
});

test('validateRoutingContentResult throws on non-objects and missing required fields', () => {
  for (const bad of [null, undefined, 'x', 7, [], true]) {
    assert.throws(() => validateRoutingContentResult(bad), /non-null object/);
  }
  const cases = [
    [{ kind: 'quest' }, /kind must be one of/],
    [{ ...validTrainingRecord(), destination_id: '' }, /destination_id must be 'training'/],
    [{ ...validTrainingRecord(), week: -1 }, /non-negative integer week/],
    [{ ...validTrainingRecord(), week: 1.5 }, /non-negative integer week/],
    [{ ...validTrainingRecord(), recorded_at: '' }, /recorded_at/],
    [{ ...validTrainingRecord(), trigger: '' }, /training content result trigger must be one of/],
    [{ ...validTrainingRecord(), detail: null }, /detail object/]
  ];
  for (const [record, pattern] of cases) {
    assert.throws(() => validateRoutingContentResult(record), pattern);
  }
});

test('validateRoutingContentResult enforces enumerated, kind-consistent destination_id and trigger', () => {
  // A record whose destination_id or trigger does not match its kind is corrupt.
  assert.throws(() => validateRoutingContentResult({ ...validTrainingRecord(), destination_id: 'dungeon' }), /training content result destination_id must be 'training'/);
  assert.throws(() => validateRoutingContentResult({ ...validTrainingRecord(), destination_id: 'academy-map' }), /training content result destination_id must be 'training'/);
  assert.throws(() => validateRoutingContentResult({ ...validTrainingRecord(), trigger: 'dungeon_run_committed' }), /training content result trigger must be one of/);
  assert.throws(() => validateRoutingContentResult({ ...validTrainingRecord(), trigger: 'bogus' }), /training content result trigger must be one of/);
  assert.throws(() => validateRoutingContentResult({ ...validDungeonRecord(), destination_id: 'training' }), /dungeon content result destination_id must be 'dungeon'/);
  assert.throws(() => validateRoutingContentResult({ ...validDungeonRecord(), trigger: 'training_completed' }), /dungeon content result trigger must be 'dungeon_run_committed'/);
  assert.throws(() => validateRoutingContentResult({ ...validErrandRecord(), destination_id: 'training' }), /errand content result destination_id must be 'errand'/);
  assert.throws(() => validateRoutingContentResult({ ...validErrandRecord(), trigger: 'training_completed' }), /errand content result trigger must be 'errand_completed'/);
  assert.throws(() => validateRoutingContentResult({ ...validAlchemyRecord(), destination_id: 'training' }), /alchemy content result destination_id must be 'alchemy'/);
  assert.throws(() => validateRoutingContentResult({ ...validAlchemyRecord(), trigger: 'training_completed' }), /alchemy content result trigger must be 'alchemy_recipe_completed'/);
  assert.throws(() => validateRoutingContentResult({ ...validStudyCircleRecord(), destination_id: 'training' }), /study circle content result destination_id must be 'study_circle'/);
  assert.throws(() => validateRoutingContentResult({ ...validStudyCircleRecord(), trigger: 'training_completed' }), /study circle content result trigger must be 'study_circle_completed'/);
  // Both valid kind-consistent triggers for training are accepted.
  assert.doesNotThrow(() => validateRoutingContentResult({ ...validTrainingRecord(), trigger: 'training_skipped', detail: { ...validTrainingRecord().detail, outcome: 'skipped' } }));
  // A corrupt mismatched record is rejected by the public reader too.
  assert.throws(() => readRoutingContentResult({ [ROUTING_CONTENT_RESULT_STATE_KEY]: { ...validTrainingRecord(), trigger: 'dungeon_run_committed' } }), /trigger must be one of/);
});

test('validateRoutingContentResult enforces kind-specific detail shapes', () => {
  const badTrainingOutcome = validTrainingRecord();
  badTrainingOutcome.detail.outcome = 'abandoned';
  assert.throws(() => validateRoutingContentResult(badTrainingOutcome), /outcome must be one of/);

  const badTrainingDeltas = validTrainingRecord();
  badTrainingDeltas.detail.parameter_deltas = { magic: { light: 'lots' }, abilities: {} };
  assert.throws(() => validateRoutingContentResult(badTrainingDeltas), /parameter_deltas\.magic\.light/);

  const badTrainingList = validTrainingRecord();
  badTrainingList.detail.trainings = [{ day_index: 0, day_name: '光曜', training_id: '', training_name: 'x' }];
  assert.throws(() => validateRoutingContentResult(badTrainingList), /training_id/);

  // Every published training-entry field is enforced, including day_name and training_name.
  const missingDayName = validTrainingRecord();
  missingDayName.detail.trainings = [{ day_index: 0, training_id: 'healing_practice', training_name: '治癒魔法実習' }];
  assert.throws(() => validateRoutingContentResult(missingDayName), /day_name/);
  const missingTrainingName = validTrainingRecord();
  missingTrainingName.detail.trainings = [{ day_index: 0, day_name: '光曜', training_id: 'healing_practice' }];
  assert.throws(() => validateRoutingContentResult(missingTrainingName), /training_name/);
  const badDayIndex = validTrainingRecord();
  badDayIndex.detail.trainings = [{ day_index: -1, day_name: '光曜', training_id: 'healing_practice', training_name: '治癒魔法実習' }];
  assert.throws(() => validateRoutingContentResult(badDayIndex), /day_index/);

  const missingFloor = validDungeonRecord();
  delete missingFloor.detail.floor_reached;
  assert.throws(() => validateRoutingContentResult(missingFloor), /floor_reached/);

  const badGains = validDungeonRecord();
  badGains.detail.applied_gains = { magic: {} };
  assert.throws(() => validateRoutingContentResult(badGains), /applied_gains\.abilities/);

  const badCompanion = validDungeonRecord();
  badCompanion.detail.companion_character_id = '';
  assert.throws(() => validateRoutingContentResult(badCompanion), /companion_character_id/);

  // An achieved errand must carry a positive reward; an unachieved one must carry exactly 0. The two
  // never disagree, and achieved must be an explicit boolean.
  const badErrandReward = validErrandRecord();
  badErrandReward.detail.reward_money = 0;
  assert.throws(() => validateRoutingContentResult(badErrandReward), /achieved requires a positive reward_money/);

  const badUnachievedReward = validErrandRecord();
  badUnachievedReward.detail.achieved = false;
  assert.throws(() => validateRoutingContentResult(badUnachievedReward), /unachieved requires reward_money 0/);

  const unachievedErrand = validErrandRecord();
  unachievedErrand.detail.achieved = false;
  unachievedErrand.detail.reward_money = 0;
  assert.deepEqual(validateRoutingContentResult(unachievedErrand), unachievedErrand);

  const missingAchieved = validErrandRecord();
  delete missingAchieved.detail.achieved;
  assert.throws(() => validateRoutingContentResult(missingAchieved), /requires a boolean achieved/);

  const badErrandClient = validErrandRecord();
  badErrandClient.detail.client_character_id = '';
  assert.throws(() => validateRoutingContentResult(badErrandClient), /client_character_id/);

  const badAlchemyOutcome = validAlchemyRecord();
  badAlchemyOutcome.detail.outcome = 'failed';
  assert.throws(() => validateRoutingContentResult(badAlchemyOutcome), /alchemy content result outcome/);

  const badAlchemyCategory = validAlchemyRecord();
  badAlchemyCategory.detail.category = 'trinket';
  assert.throws(() => validateRoutingContentResult(badAlchemyCategory), /alchemy content result category must be one of/);

  const badAlchemyItemId = validAlchemyRecord();
  badAlchemyItemId.detail.item_id = 'not_alchemy';
  assert.throws(() => validateRoutingContentResult(badAlchemyItemId), /alchemy_ item_id/);

  const badAlchemyQuantity = validAlchemyRecord();
  badAlchemyQuantity.detail.quantity = 0;
  assert.throws(() => validateRoutingContentResult(badAlchemyQuantity), /positive integer quantity/);

  const badAlchemyExtraKey = validAlchemyRecord();
  badAlchemyExtraKey.detail.title = '透明水';
  assert.throws(() => validateRoutingContentResult(badAlchemyExtraKey), /alchemy content result detail has unexpected key: title/);

  const badStudyCircleDeltas = validStudyCircleRecord();
  badStudyCircleDeltas.detail.parameter_deltas = { magic: { light: 'lots' }, abilities: {} };
  assert.throws(() => validateRoutingContentResult(badStudyCircleDeltas), /study circle content result parameter_deltas\.magic\.light/);

  const badStudyCircleExtra = validStudyCircleRecord();
  badStudyCircleExtra.detail.conversation_id = 'conv_study_circle_001';
  assert.throws(() => validateRoutingContentResult(badStudyCircleExtra), /study circle content result detail has unexpected key: conversation_id/);

  // An achieved study circle must carry non-empty parameter_deltas; an unachieved one must carry none. The
  // two never disagree, and achieved must be an explicit boolean.
  const badStudyCircleAchievedNoDeltas = validStudyCircleRecord();
  badStudyCircleAchievedNoDeltas.detail.parameter_deltas = { magic: {}, abilities: {} };
  assert.throws(() => validateRoutingContentResult(badStudyCircleAchievedNoDeltas), /achieved requires non-empty parameter_deltas/);

  const badStudyCircleUnachievedDeltas = validStudyCircleRecord();
  badStudyCircleUnachievedDeltas.detail.achieved = false;
  assert.throws(() => validateRoutingContentResult(badStudyCircleUnachievedDeltas), /unachieved requires empty parameter_deltas/);

  const unachievedStudyCircle = validStudyCircleRecord();
  unachievedStudyCircle.detail.achieved = false;
  unachievedStudyCircle.detail.parameter_deltas = { magic: {}, abilities: {} };
  assert.deepEqual(validateRoutingContentResult(unachievedStudyCircle), unachievedStudyCircle);

  const missingStudyCircleAchieved = validStudyCircleRecord();
  delete missingStudyCircleAchieved.detail.achieved;
  assert.throws(() => validateRoutingContentResult(missingStudyCircleAchieved), /is missing required key: achieved/);
});

test('readRoutingContentResult distinguishes absence from a present record and fails fast on corruption', () => {
  assert.equal(readRoutingContentResult({ elapsed_weeks: 2 }), null, 'absent slot is the honest "no result"');
  assert.equal(readRoutingContentResult({ [ROUTING_CONTENT_RESULT_STATE_KEY]: null }), null, 'explicit null is "no result"');
  assert.deepEqual(readRoutingContentResult({ [ROUTING_CONTENT_RESULT_STATE_KEY]: validDungeonRecord() }), validDungeonRecord());
  assert.throws(() => readRoutingContentResult({ [ROUTING_CONTENT_RESULT_STATE_KEY]: { kind: 'training' } }), /week/);
  assert.throws(() => readRoutingContentResult({ [ROUTING_CONTENT_RESULT_STATE_KEY]: { ...validTrainingRecord(), destination_id: 'dungeon' } }), /destination_id/);
  for (const bad of [null, undefined, 'x', 3, []]) {
    assert.throws(() => readRoutingContentResult(bad), /runtime state is required/);
  }
});

test('requireRoutingContentWeek fails fast on a missing or malformed elapsed_weeks (no numeric coercion)', () => {
  assert.equal(requireRoutingContentWeek({ elapsed_weeks: 0 }), 0);
  assert.equal(requireRoutingContentWeek({ elapsed_weeks: 12 }), 12);
  // A wrong-typed stored value must fail fast, not be coerced: "2" is not accepted as 2.
  for (const bad of [{}, { elapsed_weeks: -1 }, { elapsed_weeks: 1.5 }, { elapsed_weeks: 'two' }, { elapsed_weeks: '2' }, { elapsed_weeks: null }, null]) {
    assert.throws(() => requireRoutingContentWeek(bad), /elapsed_weeks/);
  }
});

// ---------------------------------------------------------------------------
// Pure module: builders + accumulator folding
// ---------------------------------------------------------------------------

test('foldTrainingDayIntoAccumulator seeds, extends, sums signed effects, and drops net-zero entries', () => {
  const day1 = foldTrainingDayIntoAccumulator(null, {
    week: 2,
    dayIndex: 0,
    dayName: '光曜',
    trainingId: 'healing_practice',
    trainingName: '治癒魔法実習',
    effects: [
      { group: 'magic', key: 'light', amount: 2 },
      { group: 'magic', key: 'dark', amount: -1 },
      { group: 'magic', key: 'fire', amount: 0 } // zero-amount rolls contribute nothing
    ]
  });
  assert.equal(day1.destination_id, 'training');
  assert.equal(day1.week, 2);
  assert.deepEqual(day1.trainings, [{ day_index: 0, day_name: '光曜', training_id: 'healing_practice', training_name: '治癒魔法実習' }]);
  assert.deepEqual(day1.parameter_deltas, { magic: { light: 2, dark: -1 }, abilities: {} });

  const day2 = foldTrainingDayIntoAccumulator(day1, {
    week: 2,
    dayIndex: 1,
    dayName: '闇曜',
    trainingId: 'shadow_control',
    trainingName: '影制御訓練',
    effects: [
      { group: 'magic', key: 'dark', amount: 1 }, // nets with day1's -1 -> entry drops
      { group: 'abilities', key: 'strength', amount: 3 }
    ]
  });
  assert.equal(day2.trainings.length, 2);
  assert.deepEqual(day2.parameter_deltas, { magic: { light: 2 }, abilities: { strength: 3 } });
});

test('foldTrainingDayIntoAccumulator rejects an unknown effect group and a non-finite effect amount', () => {
  assert.throws(() => foldTrainingDayIntoAccumulator(null, {
    week: 0, dayIndex: 0, dayName: '光曜', trainingId: 't', trainingName: 'n',
    effects: [{ group: 'luck', key: 'fortune', amount: 1 }]
  }), /unknown training effect group/);
  assert.throws(() => foldTrainingDayIntoAccumulator(null, {
    week: 0, dayIndex: 0, dayName: '光曜', trainingId: 't', trainingName: 'n',
    effects: [{ group: 'magic', key: 'light', amount: 'lots' }]
  }), /amount must be a finite number/);
});

test('foldTrainingDayIntoAccumulator fails fast on a corrupt prior accumulator instead of silently reseeding', () => {
  const day = { week: 2, dayIndex: 1, dayName: '闇曜', trainingId: 'shadow_control', trainingName: '影制御訓練', effects: [] };
  // Null seeds a fresh week — that is legitimate, not corruption.
  assert.equal(foldTrainingDayIntoAccumulator(null, day).trainings.length, 1);
  // A non-null but malformed accumulator is corrupt runtime_state and must throw.
  assert.throws(() => foldTrainingDayIntoAccumulator('garbage', day), /must be a non-null object/);
  assert.throws(() => foldTrainingDayIntoAccumulator({ destination_id: 'training', trainings: [], parameter_deltas: { magic: {}, abilities: {} } }, day), /integer week/);
  assert.throws(() => foldTrainingDayIntoAccumulator({ week: 2, destination_id: 'training', trainings: 'x', parameter_deltas: { magic: {}, abilities: {} } }, day), /trainings array/);
  assert.throws(() => foldTrainingDayIntoAccumulator({ week: 2, destination_id: 'training', trainings: [], parameter_deltas: { magic: { light: 'x' }, abilities: {} } }, day), /parameter_deltas\.magic\.light/);
  // The accumulator's carried entries are held to the same published shape (day_name / training_name).
  assert.throws(() => foldTrainingDayIntoAccumulator({ week: 2, destination_id: 'training', trainings: [{ day_index: 0, training_id: 't', training_name: 'n' }], parameter_deltas: { magic: {}, abilities: {} } }, day), /day_name/);
  assert.throws(() => foldTrainingDayIntoAccumulator({ week: 2, destination_id: 'training', trainings: [{ day_index: 0, day_name: 'd', training_id: 't' }], parameter_deltas: { magic: {}, abilities: {} } }, day), /training_name/);
});

test('buildTrainingContentResult, buildDungeonContentResult, buildErrandContentResult, buildAlchemyContentResult, and buildStudyCircleRoutingContentResult produce validated records', () => {
  const training = buildTrainingContentResult({
    week: 4,
    now: '2026-07-02T01:02:03.000Z',
    outcome: 'skipped',
    accumulator: null
  });
  assert.equal(training.trigger, 'training_skipped');
  assert.deepEqual(training.detail, { outcome: 'skipped', trainings: [], parameter_deltas: { magic: {}, abilities: {} } });

  const dungeon = buildDungeonContentResult({
    week: 6,
    now: '2026-07-02T01:02:03.000Z',
    outcome: 'cleared',
    floorReached: 10,
    maxFloors: 10,
    appliedGains: { magic: { wind: 2 }, abilities: {} },
    totalApplied: 2,
    companionCharacterId: 'character_003'
  });
  assert.equal(dungeon.trigger, 'dungeon_run_committed');
  assert.equal(dungeon.detail.companion_character_id, 'character_003');

  const errand = buildErrandContentResult({
    week: 8,
    now: '2026-07-02T01:02:03.000Z',
    errandId: 'archive_slip_sort',
    title: '資料室の貸出票整理',
    achieved: true,
    rewardMoney: 35,
    clientCharacterId: 'character_003',
    clientDisplayName: '三番'
  });
  assert.equal(errand.trigger, 'errand_completed');
  assert.equal(errand.detail.achieved, true);
  assert.equal(errand.detail.reward_money, 35);

  const unachievedErrand = buildErrandContentResult({
    week: 8,
    now: '2026-07-02T01:02:03.000Z',
    errandId: 'archive_slip_sort',
    title: '資料室の貸出票整理',
    achieved: false,
    rewardMoney: 0,
    clientCharacterId: 'character_003',
    clientDisplayName: '三番'
  });
  assert.equal(unachievedErrand.detail.achieved, false);
  assert.equal(unachievedErrand.detail.reward_money, 0);

  const alchemy = buildAlchemyContentResult({
    week: 9,
    now: '2026-07-02T01:02:03.000Z',
    recipeId: 'alchemy_stardust_konpeito',
    itemId: 'alchemy_stardust_konpeito',
    name: '星屑の金平糖',
    category: 'gift',
    quantity: 1
  });
  assert.equal(alchemy.trigger, 'alchemy_recipe_completed');
  assert.equal(alchemy.detail.recipe_id, 'alchemy_stardust_konpeito');
  assert.equal(alchemy.detail.name, '星屑の金平糖');
  assert.equal(alchemy.detail.category, 'gift');

  const studyCircle = buildStudyCircleRoutingContentResult({
    week: 10,
    now: '2026-07-02T01:02:03.000Z',
    contentResult: {
      kind: 'study_circle',
      destination_id: 'study_circle',
      trigger: 'study_circle_completed',
      detail: {
        outcome: 'completed',
        achieved: true,
        theme_id: 'healing_practice',
        theme_name: '治癒魔法実習',
        host_character_id: 'character_001',
        host_display_name: 'セラ',
        parameter_deltas: { magic: { light: 1 }, abilities: { magical_power: 1 } }
      }
    }
  });
  assert.equal(studyCircle.kind, 'study_circle');
  assert.equal(studyCircle.week, 10);
  assert.equal(studyCircle.trigger, 'study_circle_completed');
  assert.equal(studyCircle.detail.theme_id, 'healing_practice');
  assert.equal(studyCircle.detail.achieved, true);
  assert.deepEqual(studyCircle.detail.parameter_deltas, { magic: { light: 1 }, abilities: { magical_power: 1 } });

  const unachievedStudyCircle = buildStudyCircleRoutingContentResult({
    week: 11,
    now: '2026-07-02T01:02:03.000Z',
    contentResult: {
      kind: 'study_circle',
      destination_id: 'study_circle',
      trigger: 'study_circle_completed',
      detail: {
        outcome: 'completed',
        achieved: false,
        theme_id: 'healing_practice',
        theme_name: '治癒魔法実習',
        host_character_id: 'character_001',
        host_display_name: 'セラ',
        parameter_deltas: { magic: {}, abilities: {} }
      }
    }
  });
  assert.equal(unachievedStudyCircle.detail.achieved, false);
  assert.deepEqual(unachievedStudyCircle.detail.parameter_deltas, { magic: {}, abilities: {} });

  assert.throws(() => buildTrainingContentResult({ week: 0, now: '', outcome: 'completed' }), /recorded_at/);
  assert.throws(() => buildTrainingContentResult({ week: 0, now: 'x', outcome: 'nope' }), /outcome must be one of/);
  assert.throws(() => buildDungeonContentResult({ week: -1, now: 'x', outcome: 'dead', floorReached: 1, maxFloors: 10, appliedGains: { magic: {}, abilities: {} }, totalApplied: 0 }), /week must be a non-negative integer/);
  assert.throws(() => buildErrandContentResult({ week: 1, now: 'x', errandId: 'e', title: 't', achieved: true, rewardMoney: 0, clientCharacterId: 'character_001', clientDisplayName: '一番' }), /achieved requires a positive reward_money/);
  assert.throws(() => buildErrandContentResult({ week: 1, now: 'x', errandId: 'e', title: 't', rewardMoney: 5, clientCharacterId: 'character_001', clientDisplayName: '一番' }), /requires a boolean achieved/);
  assert.throws(() => buildAlchemyContentResult({ week: 1, now: 'x', recipeId: 'alchemy_x', itemId: 'alchemy_x', name: '星屑の細工玉', category: 'product', quantity: 0 }), /positive integer quantity/);
  assert.throws(() => buildStudyCircleRoutingContentResult({ week: 1, now: 'x', contentResult: { ...validStudyCircleContentResult(), detail: { ...validStudyCircleRecord().detail, host_display_name: '' } } }), /host_display_name/);
  assert.throws(() => buildStudyCircleRoutingContentResult({ week: 1, now: 'x', contentResult: validStudyCircleRecord() }), /unexpected key: week/);
});

test('builders fail fast on malformed accumulator and malformed applied gains rather than normalizing', () => {
  // A corrupt carried accumulator must not be rewritten into a partial/empty record.
  assert.throws(() => buildTrainingContentResult({
    week: 2, now: 'x', outcome: 'skipped',
    accumulator: { week: 2, destination_id: 'training', trainings: [], parameter_deltas: { magic: { light: 'x' }, abilities: {} } }
  }), /parameter_deltas\.magic\.light/);
  assert.throws(() => buildTrainingContentResult({
    week: 2, now: 'x', outcome: 'completed', accumulator: { destination_id: 'training' }
  }), /integer week/);
  // Malformed applied gains (missing a group / non-finite value) must throw.
  assert.throws(() => buildDungeonContentResult({
    week: 1, now: 'x', outcome: 'cleared', floorReached: 3, maxFloors: 10, appliedGains: { magic: {} }, totalApplied: 0
  }), /applied_gains\.abilities/);
  assert.throws(() => buildDungeonContentResult({
    week: 1, now: 'x', outcome: 'cleared', floorReached: 3, maxFloors: 10, appliedGains: { magic: { fire: 'lots' }, abilities: {} }, totalApplied: 0
  }), /applied_gains\.magic\.fire/);
});

// ---------------------------------------------------------------------------
// Integration: training write path (routing vs loop)
// ---------------------------------------------------------------------------

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readMutableState(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/runtime_state.json'), 'utf8'));
}

async function contentRoot(runtimeStateOverrides = {}, parameters = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-routing-result-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', parameters ?? {
    magic: { light: { value: 10 }, dark: { value: 10 }, fire: { value: 10 }, water: { value: 10 }, earth: { value: 10 }, wind: { value: 10 } },
    abilities: { strength: { value: 10 }, agility: { value: 10 }, academics: { value: 10 }, magical_power: { value: 10 }, charisma: { value: 10 } }
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {},
    ...runtimeStateOverrides
  });
  // A dungeon run-end resolves each carried material's display name from the catalog,
  // so the dungeon-commit integration cases need it seeded like the real definitions.
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  // The dungeon run view enriches usable consumables from the alchemy catalog.
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  return root;
}

// A well-formed in-progress accumulator for `dayCount` already-trained days, used to
// seed the mid-week-resume scenario (the accumulator that a routing week's earlier
// days would have persisted).
function seededTrainingAccumulator(week, dayCount) {
  return {
    week,
    destination_id: 'training',
    trainings: Array.from({ length: dayCount }, (_, index) => ({
      day_index: index, day_name: `d${index}`, training_id: `t_${index}`, training_name: `n_${index}`
    })),
    parameter_deltas: { magic: {}, abilities: {} }
  };
}

// Replicates the record's signed-sum-then-drop-zero summary so the assertion is
// robust to the seeded RNG (we never hardcode which parameters a seed happens to move).
function sumEffects(effectsPerDay) {
  const deltas = { magic: {}, abilities: {} };
  for (const effects of effectsPerDay) {
    for (const effect of effects) {
      if (!Number.isFinite(effect.amount) || effect.amount === 0) continue;
      const next = (deltas[effect.group][effect.key] ?? 0) + effect.amount;
      if (next === 0) delete deltas[effect.group][effect.key];
      else deltas[effect.group][effect.key] = next;
    }
  }
  return deltas;
}

test('routing training accumulates the whole week and persists the record in the completing write', async () => {
  const root = await contentRoot({ current_screen: 'academy-training', training_actions_used: 0, elapsed_weeks: 3 });
  const dayTrainingIds = ['healing_practice', 'shadow_control', 'flame_focus', 'water_meditation', 'earth_barrier', 'wind_step'];
  const effectsPerDay = [];
  let last = null;
  for (const [index, trainingId] of dayTrainingIds.entries()) {
    last = await runTraining({ root, trainingId, randomSeed: 40 + index, postTrainingScreen: 'interaction', routing: true });
    effectsPerDay.push(last.effects);
    if (index < dayTrainingIds.length - 1) {
      // Mid-week: the accumulator is carried, but no result record is written yet.
      const midState = await readMutableState(root);
      assert.equal(Object.hasOwn(midState, ROUTING_CONTENT_RESULT_STATE_KEY), false, 'no record before completion');
      assert.equal(midState[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY].trainings.length, index + 1);
    }
  }

  assert.equal(last.training_progress.completed, true);
  // Same write: the completing runTraining result already carries the record.
  const record = last.state[ROUTING_CONTENT_RESULT_STATE_KEY];
  assert.ok(record, 'the completing training write persists the record');
  validateRoutingContentResult(record);
  assert.equal(record.kind, 'training');
  assert.equal(record.destination_id, 'training');
  assert.equal(record.week, 3);
  assert.equal(record.trigger, 'training_completed');
  assert.equal(record.detail.outcome, 'completed');
  assert.match(record.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(record.detail.trainings.map((entry) => entry.training_id), dayTrainingIds);
  assert.deepEqual(record.detail.trainings.map((entry) => entry.day_index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(record.detail.parameter_deltas, sumEffects(effectsPerDay));

  const persisted = await readMutableState(root);
  assert.deepEqual(persisted[ROUTING_CONTENT_RESULT_STATE_KEY], record);
  assert.equal(Object.hasOwn(persisted, ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY), false, 'accumulator is cleared on completion');
});

test('a new routing content result destructively overwrites the older slot (only the latest is kept)', async () => {
  // Seed an older dungeon result from a previous week, then complete a training week.
  const staleRecord = validDungeonRecord();
  staleRecord.week = 2;
  const root = await contentRoot({
    current_screen: 'academy-training',
    training_actions_used: 5,
    elapsed_weeks: 3,
    [ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY]: seededTrainingAccumulator(3, 5),
    [ROUTING_CONTENT_RESULT_STATE_KEY]: staleRecord
  });
  const completed = await runTraining({ root, trainingId: 'healing_practice', randomSeed: 16, postTrainingScreen: 'interaction', routing: true });
  assert.equal(completed.training_progress.completed, true);
  const persisted = await readMutableState(root);
  const record = persisted[ROUTING_CONTENT_RESULT_STATE_KEY];
  assert.equal(record.kind, 'training', 'the training result replaces the older dungeon result');
  assert.equal(record.week, 3);
  assert.notDeepEqual(record, staleRecord, 'the older record is gone, not merged');
  // The slot holds exactly one record — the newest.
  assert.deepEqual(record, completed.state[ROUTING_CONTENT_RESULT_STATE_KEY]);
});

test('routing training skip records a skipped week folding in the days done before skipping', async () => {
  const root = await contentRoot({ current_screen: 'academy-training', training_actions_used: 0, elapsed_weeks: 2 });
  const effectsPerDay = [];
  for (const [index, trainingId] of ['physical_drills', 'library_study'].entries()) {
    const day = await runTraining({ root, trainingId, randomSeed: 7 + index, postTrainingScreen: 'interaction', routing: true });
    effectsPerDay.push(day.effects);
  }
  const skipped = await skipTraining({ root, postTrainingScreen: 'interaction', routing: true, now: '2026-07-02T09:00:00.000Z' });
  const record = skipped.state[ROUTING_CONTENT_RESULT_STATE_KEY];
  assert.equal(record.trigger, 'training_skipped');
  assert.equal(record.detail.outcome, 'skipped');
  assert.equal(record.recorded_at, '2026-07-02T09:00:00.000Z');
  assert.deepEqual(record.detail.trainings.map((entry) => entry.training_id), ['physical_drills', 'library_study']);
  assert.deepEqual(record.detail.parameter_deltas, sumEffects(effectsPerDay));
  const persisted = await readMutableState(root);
  assert.equal(Object.hasOwn(persisted, ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY), false);
});

test('routing training skip at the start of the week records an empty skipped week', async () => {
  const root = await contentRoot({ current_screen: 'academy-map', training_actions_used: 0, elapsed_weeks: 1 });
  const skipped = await skipTraining({ root, postTrainingScreen: 'interaction', routing: true });
  const record = skipped.state[ROUTING_CONTENT_RESULT_STATE_KEY];
  assert.equal(record.detail.outcome, 'skipped');
  assert.deepEqual(record.detail.trainings, []);
  assert.deepEqual(record.detail.parameter_deltas, { magic: {}, abilities: {} });
});

test('loop training and skip never write the record or accumulator (byte-equivalent)', async () => {
  const root = await contentRoot({ current_screen: 'academy-training', training_actions_used: 0, elapsed_weeks: 3 });
  let result = null;
  for (const [index, trainingId] of ['healing_practice', 'shadow_control', 'flame_focus', 'water_meditation', 'earth_barrier', 'wind_step'].entries()) {
    result = await runTraining({ root, trainingId, randomSeed: 40 + index, postTrainingScreen: 'academy-map' });
  }
  assert.equal(result.training_progress.completed, true);
  const persisted = await readMutableState(root);
  assert.equal(Object.hasOwn(persisted, ROUTING_CONTENT_RESULT_STATE_KEY), false, 'loop training writes no record');
  assert.equal(Object.hasOwn(persisted, ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY), false, 'loop training writes no accumulator');

  const skipRoot = await contentRoot({ current_screen: 'academy-training', training_actions_used: 2, elapsed_weeks: 3 });
  const skipped = await skipTraining({ root: skipRoot, postTrainingScreen: 'academy-map' });
  assert.equal(Object.hasOwn(skipped.state, ROUTING_CONTENT_RESULT_STATE_KEY), false);
});

test('loop-mode training/skip is a pure spread: it neither writes nor removes routing-only fields (byte-equivalent)', async () => {
  // With a pre-existing routing accumulator + durable record in state (e.g. after a
  // routing→loop mode switch), a loop-mode write must be byte-equivalent to pre-feature
  // behavior: it spreads the prior state unchanged, adding no record and removing no
  // routing-only field.
  const carriedAccumulator = {
    week: 2, destination_id: 'training',
    trainings: [{ day_index: 0, day_name: '光曜', training_id: 'healing_practice', training_name: '治癒魔法実習' }],
    parameter_deltas: { magic: { light: 2 }, abilities: {} }
  };
  const durableRecord = { ...validDungeonRecord(), week: 2 };
  const carriedErrand = {
    errand_id: 'archive_slip_sort',
    title: '資料室の貸出票整理',
    situation: '資料室の机に、分類待ちの古い貸出票が積まれている。',
    prompt_tail_context: '依頼主と一緒に古い貸出票を整理する。',
    reward_money: 35,
    client_character_id: 'character_003',
    client_display_name: '三番',
    conversation_id: 'conv_errand_carried_001',
    week: 2,
    started_at: '2026-07-02T00:00:00.000Z'
  };

  const runRoot = await contentRoot({
    current_screen: 'academy-training', training_actions_used: 0, elapsed_weeks: 3,
    [ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY]: carriedAccumulator,
    [ROUTING_CONTENT_RESULT_STATE_KEY]: durableRecord,
    [ROUTING_ACTIVE_ERRAND_STATE_KEY]: carriedErrand
  });
  const ran = await runTraining({ root: runRoot, trainingId: 'physical_drills', randomSeed: 3, postTrainingScreen: 'academy-map' });
  assert.deepEqual(ran.state[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY], carriedAccumulator, 'loop training leaves the accumulator untouched (no strip write-side effect)');
  assert.deepEqual(ran.state[ROUTING_CONTENT_RESULT_STATE_KEY], durableRecord, 'loop training leaves the durable record untouched');
  assert.deepEqual(ran.state[ROUTING_ACTIVE_ERRAND_STATE_KEY], carriedErrand, 'loop training leaves an active errand marker untouched');
  const ranPersisted = await readMutableState(runRoot);
  assert.deepEqual(ranPersisted[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY], carriedAccumulator);
  assert.deepEqual(ranPersisted[ROUTING_ACTIVE_ERRAND_STATE_KEY], carriedErrand);

  const skipRoot = await contentRoot({
    current_screen: 'academy-training', training_actions_used: 2, elapsed_weeks: 3,
    [ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY]: carriedAccumulator,
    [ROUTING_CONTENT_RESULT_STATE_KEY]: validErrandRecord(),
    [ROUTING_ACTIVE_ERRAND_STATE_KEY]: carriedErrand
  });
  const skipped = await skipTraining({ root: skipRoot, postTrainingScreen: 'academy-map' });
  assert.deepEqual(skipped.state[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY], carriedAccumulator, 'loop skip leaves the accumulator untouched');
  assert.deepEqual(skipped.state[ROUTING_CONTENT_RESULT_STATE_KEY], validErrandRecord(), 'loop skip leaves an errand durable record untouched');
  assert.deepEqual(skipped.state[ROUTING_ACTIVE_ERRAND_STATE_KEY], carriedErrand, 'loop skip leaves an active errand marker untouched');
});

test('routing training fails fast when elapsed_weeks is missing from routing state', async () => {
  const root = await contentRoot({ current_screen: 'academy-training', training_actions_used: 5 });
  await assert.rejects(
    runTraining({ root, trainingId: 'healing_practice', randomSeed: 1, postTrainingScreen: 'interaction', routing: true }),
    /elapsed_weeks/
  );
});

test('routing training on a mid-week day fails fast when the accumulator is missing (no silent reseed)', async () => {
  // Day 2+ with no carried accumulator is corrupt state: a silent reseed would
  // truncate the week summary, so the write must throw instead.
  const root = await contentRoot({ current_screen: 'academy-training', training_actions_used: 3, elapsed_weeks: 2 });
  await assert.rejects(
    runTraining({ root, trainingId: 'healing_practice', randomSeed: 1, postTrainingScreen: 'interaction', routing: true }),
    /accumulator is missing on a mid-week training write/
  );
  // The first day of the week legitimately has no accumulator and must NOT throw.
  const firstDayRoot = await contentRoot({ current_screen: 'academy-map', training_actions_used: 0, elapsed_weeks: 2 });
  const firstDay = await runTraining({ root: firstDayRoot, trainingId: 'healing_practice', randomSeed: 1, postTrainingScreen: 'interaction', routing: true });
  assert.equal(firstDay.training_progress.actions_used, 1);
  assert.equal(Object.hasOwn(firstDay.state, ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY), true, 'first day seeds the accumulator');
});

test('routing skip mid-week fails fast when the accumulator is missing, but a start-of-week skip does not', async () => {
  const midWeekRoot = await contentRoot({ current_screen: 'academy-training', training_actions_used: 2, elapsed_weeks: 2 });
  await assert.rejects(
    skipTraining({ root: midWeekRoot, postTrainingScreen: 'interaction', routing: true }),
    /accumulator is missing on a mid-week training write/
  );
  // Start-of-week skip (no days trained): no accumulator expected, empty skipped record.
  const startRoot = await contentRoot({ current_screen: 'academy-map', training_actions_used: 0, elapsed_weeks: 2 });
  const skipped = await skipTraining({ root: startRoot, postTrainingScreen: 'interaction', routing: true });
  assert.deepEqual(skipped.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.trainings, []);
});

// ---------------------------------------------------------------------------
// Integration: dungeon commit path (routing vs loop)
// ---------------------------------------------------------------------------

async function dungeonContentRoot(parameters = null) {
  return contentRoot({}, parameters ?? {
    magic: { light: { value: 10 }, dark: { value: 10 }, fire: { value: 10 }, water: { value: 10 }, earth: { value: 10 }, wind: { value: 10 } },
    abilities: { strength: { value: 10 }, agility: { value: 40 }, academics: { value: 30 }, magical_power: { value: 30 }, charisma: { value: 20 } }
  });
}

test('routing dungeon commit persists the run result in the run-clearing write', async () => {
  const root = await dungeonContentRoot();
  await enterDungeon({ root, seed: 321 });
  const state = await readMutableState(root);
  state.elapsed_weeks = 4;
  state.dungeon_run.pending_gains.abilities.strength = 6;
  state.dungeon_run.pending_gains.magic.fire = 3;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const result = await dungeonAction({
    root,
    postDungeonScreen: 'interaction',
    action: { type: 'retreat' },
    routing: true,
    now: '2026-07-02T12:00:00.000Z'
  });
  assert.equal(result.status, 'retreated');

  const record = result.state[ROUTING_CONTENT_RESULT_STATE_KEY];
  assert.ok(record, 'the run-clearing write carries the record');
  validateRoutingContentResult(record);
  assert.equal(record.kind, 'dungeon');
  assert.equal(record.destination_id, 'dungeon');
  assert.equal(record.week, 4);
  assert.equal(record.recorded_at, '2026-07-02T12:00:00.000Z');
  assert.equal(record.trigger, 'dungeon_run_committed');
  assert.equal(record.detail.outcome, 'retreated');
  assert.equal(record.detail.floor_reached, 1);
  assert.equal(record.detail.max_floors, result.max_floors);
  assert.equal(record.detail.companion_character_id, null);
  assert.equal(record.detail.total_applied > 0, true);
  assert.deepEqual(record.detail.applied_gains, result.applied_gains);

  const persisted = await readMutableState(root);
  assert.equal(persisted.dungeon_run, null);
  assert.deepEqual(persisted[ROUTING_CONTENT_RESULT_STATE_KEY], record);
});

test('routing dungeon commit records opened boss-chest equipment (display shape) and confirms the full instance into player_equipment', async () => {
  const root = await dungeonContentRoot();
  await enterDungeon({ root, seed: 321 });
  // A real rolled instance (full C-08 shape, incl. base/bonus effects) sits in the run's equipment buffer.
  const instance = rollBossTreasureEquipment({ seed: 321, floor: 10 });
  const state = await readMutableState(root);
  state.elapsed_weeks = 4;
  state.dungeon_run.equipment_buffer = [instance];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const result = await dungeonAction({
    root,
    postDungeonScreen: 'interaction',
    action: { type: 'retreat' },
    routing: true,
    now: '2026-07-02T12:00:00.000Z'
  });
  assert.equal(result.status, 'retreated');

  // The persisted content result carries the DISPLAY shape (no base/bonus effects), and it validates —
  // this is the seam that would throw if commitRunEnd passed the full instance to buildDungeonContentResult.
  const record = result.state[ROUTING_CONTENT_RESULT_STATE_KEY];
  validateRoutingContentResult(record);
  const { base_effects, bonus_effects, ...displayShape } = instance;
  assert.deepEqual(record.detail.equipment, { retained: true, items: [displayShape] });
  assert.equal(Object.hasOwn(record.detail.equipment.items[0], 'base_effects'), false, 'content result drops combat effects');

  // The run result still carries the full instance, and player_equipment received it whole.
  assert.deepEqual(result.equipment, { retained: true, items: [instance] });
  const surface = await loadEquipmentSurface({ root });
  assert.deepEqual(surface.instances, [instance]);
});

test('routing dungeon death records a zero-gain wipe result', async () => {
  const root = await dungeonContentRoot({
    magic: { light: { value: 10 }, dark: { value: 10 }, fire: { value: 10 }, water: { value: 10 }, earth: { value: 10 }, wind: { value: 10 } },
    abilities: { strength: { value: 5 }, agility: { value: 1 }, academics: { value: 1 }, magical_power: { value: 1 }, charisma: { value: 1 } }
  });
  await enterDungeon({ root, seed: 4242 });
  const state = await readMutableState(root);
  state.elapsed_weeks = 7;
  const run = state.dungeon_run;
  run.player.hp = 1;
  run.pending_gains.abilities.strength = 5;
  run.enemies = [{ uid: 'e1', archetype_id: 'stone_golem', name: '石塊ゴーレム', element: 'earth', glyph: 'G', x: run.player.x + 1, y: run.player.y, hp: 80, max_hp: 80, attack: 99, defense: 5, speed: 60 }];
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  let result = null;
  for (let i = 0; i < 30 && !(result && result.status === 'dead'); i += 1) {
    result = await dungeonAction({ root, postDungeonScreen: 'interaction', action: { type: 'wait' }, routing: true });
    if (result.ended) break;
  }
  assert.equal(result.status, 'dead');
  const record = result.state[ROUTING_CONTENT_RESULT_STATE_KEY];
  assert.equal(record.detail.outcome, 'dead');
  assert.equal(record.detail.total_applied, 0);
  assert.deepEqual(record.detail.applied_gains, { magic: {}, abilities: {} });
  assert.equal(record.week, 7);
});

test('loop dungeon commit never writes the record (byte-equivalent)', async () => {
  const root = await dungeonContentRoot();
  await enterDungeon({ root, seed: 321 });
  const state = await readMutableState(root);
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const result = await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.equal(result.status, 'retreated');
  assert.equal(Object.hasOwn(result.state, ROUTING_CONTENT_RESULT_STATE_KEY), false);
  const persisted = await readMutableState(root);
  assert.equal(Object.hasOwn(persisted, ROUTING_CONTENT_RESULT_STATE_KEY), false);

  const carriedRoot = await dungeonContentRoot();
  await enterDungeon({ root: carriedRoot, seed: 321 });
  const carriedState = await readMutableState(carriedRoot);
  const carriedErrandRecord = validErrandRecord();
  carriedState[ROUTING_CONTENT_RESULT_STATE_KEY] = carriedErrandRecord;
  carriedState.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(carriedRoot, 'data/mutable/game_data/runtime_state.json', carriedState);
  const carriedResult = await dungeonAction({ root: carriedRoot, postDungeonScreen: 'academy-room', action: { type: 'retreat' } });
  assert.deepEqual(carriedResult.state[ROUTING_CONTENT_RESULT_STATE_KEY], carriedErrandRecord, 'loop dungeon leaves an unrelated errand record untouched');
});

test('dungeon commit does not mutate an unrelated pre-existing training accumulator (no extra write-side effect)', async () => {
  const root = await dungeonContentRoot();
  await enterDungeon({ root, seed: 321 });
  const state = await readMutableState(root);
  state.elapsed_weeks = 4;
  const carriedAccumulator = {
    week: 4, destination_id: 'training',
    trainings: [{ day_index: 0, day_name: '光曜', training_id: 'healing_practice', training_name: '治癒魔法実習' }],
    parameter_deltas: { magic: { light: 2 }, abilities: {} }
  };
  state[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY] = carriedAccumulator;
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  const result = await dungeonAction({ root, postDungeonScreen: 'interaction', action: { type: 'retreat' }, routing: true, now: '2026-07-02T12:00:00.000Z' });
  assert.equal(result.status, 'retreated');
  // Routing dungeon commit writes only the dungeon record; it leaves any unrelated
  // field (including a stale training accumulator) exactly as spread.
  assert.equal(result.state[ROUTING_CONTENT_RESULT_STATE_KEY].kind, 'dungeon');
  assert.deepEqual(result.state[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY], carriedAccumulator);
  const persisted = await readMutableState(root);
  assert.deepEqual(persisted[ROUTING_TRAINING_WEEK_ACCUMULATOR_STATE_KEY], carriedAccumulator);
});

test('routing dungeon commit fails fast when elapsed_weeks is missing from routing state', async () => {
  const root = await dungeonContentRoot();
  await enterDungeon({ root, seed: 321 });
  const state = await readMutableState(root);
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  await assert.rejects(
    dungeonAction({ root, postDungeonScreen: 'interaction', action: { type: 'retreat' }, routing: true }),
    /elapsed_weeks/
  );
});

test('buildDungeonContentResult records carried materials additively and omits the field when absent', () => {
  const withMaterials = buildDungeonContentResult({
    week: 5,
    now: '2026-07-05T00:00:00.000Z',
    outcome: 'retreated',
    floorReached: 3,
    maxFloors: 10,
    appliedGains: { magic: { fire: 3 }, abilities: {} },
    totalApplied: 3,
    materials: { retained: true, items: [{ item_id: 'material_fire_t1', display_name: '熾火の欠片', quantity: 2 }] }
  });
  assert.deepEqual(withMaterials.detail.materials, { retained: true, items: [{ item_id: 'material_fire_t1', display_name: '熾火の欠片', quantity: 2 }] });

  const withoutMaterials = buildDungeonContentResult({
    week: 5,
    now: '2026-07-05T00:00:00.000Z',
    outcome: 'retreated',
    floorReached: 3,
    maxFloors: 10,
    appliedGains: { magic: {}, abilities: {} },
    totalApplied: 0
  });
  assert.equal(Object.prototype.hasOwnProperty.call(withoutMaterials.detail, 'materials'), false);
});

test('validateRoutingContentResult tolerates a materials-less dungeon record and rejects a malformed one', () => {
  // A record written before the drop system has no materials field: still valid on read.
  assert.deepEqual(validateRoutingContentResult(validDungeonRecord()), validDungeonRecord());

  const withMaterials = validDungeonRecord();
  withMaterials.detail.materials = { retained: false, items: [{ item_id: 'material_wind_t2', display_name: '疾風の羽根', quantity: 1 }] };
  assert.deepEqual(validateRoutingContentResult(withMaterials), withMaterials);

  const badRetained = validDungeonRecord();
  badRetained.detail.materials = { retained: 'yes', items: [] };
  assert.throws(() => validateRoutingContentResult(badRetained), /materials\.retained must be a boolean/);

  const badQuantity = validDungeonRecord();
  badQuantity.detail.materials = { retained: true, items: [{ item_id: 'material_wind_t2', display_name: '疾風の羽根', quantity: 0 }] };
  assert.throws(() => validateRoutingContentResult(badQuantity), /material quantity must be a positive integer/);

  // The old { item_id, quantity } item shape (no display_name) is rejected — the new
  // shape carries the server-authoritative display name and nothing else.
  const missingDisplayName = validDungeonRecord();
  missingDisplayName.detail.materials = { retained: true, items: [{ item_id: 'material_wind_t2', quantity: 1 }] };
  assert.throws(() => validateRoutingContentResult(missingDisplayName), /materials item is missing required key: display_name/);

  const emptyDisplayName = validDungeonRecord();
  emptyDisplayName.detail.materials = { retained: true, items: [{ item_id: 'material_wind_t2', display_name: '', quantity: 1 }] };
  assert.throws(() => validateRoutingContentResult(emptyDisplayName), /material display_name must be a non-empty string/);

  const extraItemKey = validDungeonRecord();
  extraItemKey.detail.materials = { retained: true, items: [{ item_id: 'material_wind_t2', display_name: '疾風の羽根', quantity: 1, tier: 2 }] };
  assert.throws(() => validateRoutingContentResult(extraItemKey), /materials item has unexpected key: tier/);

  const extraKey = validDungeonRecord();
  extraKey.detail.materials = { retained: true, items: [], lost: [] };
  assert.throws(() => validateRoutingContentResult(extraKey), /materials has unexpected key/);
});

function bossEquipmentItem(overrides = {}) {
  return {
    instance_id: 'dungeon_boss_equip_s4242_f10',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 4,
    quality: 'masterwork',
    name: '傑作の烈火の剣',
    flavor: '火の力を宿す。',
    ...overrides
  };
}

test('buildDungeonContentResult records carried boss-chest equipment additively and omits the field when absent', () => {
  const withEquipment = buildDungeonContentResult({
    week: 5,
    now: '2026-07-05T00:00:00.000Z',
    outcome: 'cleared',
    floorReached: 10,
    maxFloors: 10,
    appliedGains: { magic: { fire: 3 }, abilities: {} },
    totalApplied: 3,
    equipment: { retained: true, items: [bossEquipmentItem()] }
  });
  // The persisted detail carries the display identity (no base/bonus effects — those are combat detail).
  assert.deepEqual(withEquipment.detail.equipment, { retained: true, items: [bossEquipmentItem()] });

  const withoutEquipment = buildDungeonContentResult({
    week: 5,
    now: '2026-07-05T00:00:00.000Z',
    outcome: 'retreated',
    floorReached: 3,
    maxFloors: 10,
    appliedGains: { magic: {}, abilities: {} },
    totalApplied: 0
  });
  assert.equal(Object.prototype.hasOwnProperty.call(withoutEquipment.detail, 'equipment'), false);
});

test('validateRoutingContentResult tolerates an equipment-less dungeon record and rejects a malformed one', () => {
  // An amulet carries no weapon_type; a valid record round-trips.
  const withAmulet = validDungeonRecord();
  withAmulet.detail.equipment = { retained: true, items: [bossEquipmentItem({ kind: 'amulet', weapon_type: undefined, instance_id: 'dungeon_boss_equip_s1_f5', tier: 3, quality: 'excellent' })] };
  delete withAmulet.detail.equipment.items[0].weapon_type;
  assert.deepEqual(validateRoutingContentResult(withAmulet), withAmulet);

  const badRetained = validDungeonRecord();
  badRetained.detail.equipment = { retained: 'yes', items: [] };
  assert.throws(() => validateRoutingContentResult(badRetained), /equipment\.retained must be a boolean/);

  const badKind = validDungeonRecord();
  badKind.detail.equipment = { retained: true, items: [bossEquipmentItem({ kind: 'trinket' })] };
  delete badKind.detail.equipment.items[0].weapon_type; // a non-weapon kind carries no weapon_type key
  assert.throws(() => validateRoutingContentResult(badKind), /kind must be one of/);

  const weaponMissingType = validDungeonRecord();
  weaponMissingType.detail.equipment = { retained: true, items: [bossEquipmentItem()] };
  delete weaponMissingType.detail.equipment.items[0].weapon_type;
  assert.throws(() => validateRoutingContentResult(weaponMissingType), /missing required key: weapon_type/);

  const badTier = validDungeonRecord();
  badTier.detail.equipment = { retained: true, items: [bossEquipmentItem({ tier: 5 })] };
  assert.throws(() => validateRoutingContentResult(badTier), /tier 1\.\.4/);

  const emptyName = validDungeonRecord();
  emptyName.detail.equipment = { retained: true, items: [bossEquipmentItem({ name: '' })] };
  assert.throws(() => validateRoutingContentResult(emptyName), /requires a non-empty name/);

  const extraKey = validDungeonRecord();
  extraKey.detail.equipment = { retained: true, items: [], lost: [] };
  assert.throws(() => validateRoutingContentResult(extraKey), /equipment has unexpected key/);
});

// ----- auction (競売場) content result -----

function auctionLots() {
  return [
    { item_name: '逸品の剣', category: 'weapon_amulet', band: 'A', result: 'won_by_player', price: 9000, winner_display_name: null },
    { item_name: '星海の霊墨', category: 'treasure', band: 'A', result: 'won_by_other', price: 6000, winner_display_name: 'キャラ1' },
    { item_name: '初代競売人の木槌', category: 'flavor', band: 'A', result: 'passed_in', price: null, winner_display_name: null }
  ];
}

test('buildAuctionContentResult records the closed week board with per-lot result↔price↔winner consistency', () => {
  const record = buildAuctionContentResult({ week: 4, now: '2026-07-10T00:00:00.000Z', lots: auctionLots() });
  assert.equal(record.kind, 'auction');
  assert.equal(record.destination_id, 'auction');
  assert.equal(record.trigger, 'auction_concluded');
  assert.equal(record.detail.outcome, 'closed');
  assert.deepEqual(record.detail.lots.map((lot) => [lot.result, lot.price, lot.winner_display_name]), [
    ['won_by_player', 9000, null],
    ['won_by_other', 6000, 'キャラ1'],
    ['passed_in', null, null]
  ]);
});

test('the auction content result validator rejects a mismatched result↔price↔winner shape and a bad lot count', () => {
  const wonNoPrice = auctionLots();
  wonNoPrice[0] = { ...wonNoPrice[0], price: 0 };
  assert.throws(() => buildAuctionContentResult({ week: 4, now: 'now', lots: wonNoPrice }), /must have a positive integer price/);

  const otherNoWinner = auctionLots();
  assert.throws(() => validateRoutingContentResult({
    kind: 'auction', destination_id: 'auction', week: 4, recorded_at: 'now', trigger: 'auction_concluded',
    detail: { outcome: 'closed', lots: [
      { lot_index: 0, item_name: 'x', category: 'treasure', band: 'A', result: 'won_by_other', price: 100, winner_display_name: null },
      ...otherNoWinner.slice(1).map((lot, index) => ({ lot_index: index + 1, ...lot }))
    ] }
  }), /won_by_other requires a non-empty winner_display_name/);

  assert.throws(() => buildAuctionContentResult({ week: 4, now: 'now', lots: auctionLots().slice(0, 2) }), /requires exactly 3 lots/);
});

test('a homunculus content result accepts an ab_ auction-being face id as well as an hp_ face', () => {
  const abRecord = buildHomunculusContentResult({ week: 4, now: 'now', action: 'conversation', homunculusId: 'homunculus_007', displayName: 'スピカ', faceId: 'ab_001' });
  assert.equal(abRecord.detail.face_id, 'ab_001');
  const hpRecord = buildHomunculusContentResult({ week: 4, now: 'now', action: 'conversation', homunculusId: 'homunculus_002', displayName: 'ノクス', faceId: 'hp_003' });
  assert.equal(hpRecord.detail.face_id, 'hp_003');
  assert.throws(() => buildHomunculusContentResult({ week: 4, now: 'now', action: 'conversation', homunculusId: 'homunculus_007', displayName: 'x', faceId: 'zz_001' }), /requires an hp_NNN or ab_NNN face_id/);
});
