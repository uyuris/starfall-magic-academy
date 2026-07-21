// The week-event save-cleanup script: it strips every fixed-week-event trace from a save so the cleaned save
// loads, progresses, and shows the diary without throwing (a W10-stuck save returns to the routing hub). The
// fixture seeds the full residue a real save could carry and the tests drive the module directly (no server).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fixtureRoot, readJson, writeJson } from './helpers.mjs';
import { initializeNewPlayArea } from '../src/playSession.mjs';
import { removeWeekEventSaveData } from '../src/removeWeekEventSaveData.mjs';
import { readRoutingContentResult } from '../src/routingContentResult.mjs';
import { sortMemoriesByChronology } from '../src/llm/continuityPromptContext.mjs';

const NOW = '2026-07-10T00:00:00.000Z';

// A runtime_state carrying the full week-event residue a save could hold: the stuck screen, the strict marker,
// and a graded week-event content-result slot — plus unrelated keys that must survive untouched.
function residualRuntimeState() {
  return {
    elapsed_weeks: 9,
    current_screen: 'academy-week-event',
    current_buddy_character_id: null,
    routing_active_week_event: { conversation_id: 'conv_hub_001', event_id: 'exam_basic_practical' },
    last_routing_content_result: {
      kind: 'week_event',
      destination_id: 'week_event',
      week: 9,
      recorded_at: NOW,
      trigger: 'week_event_completed',
      detail: { event_id: 'exam_basic_practical', event_label: '初級実技試験', event_kind: 'exam', score: 85, grade: 'S', reward: { money: 500 } }
    }
  };
}

function weekEventMemory(id, characterId) {
  return {
    id,
    character_id: characterId,
    visibility: 'character_known',
    type: 'week_event',
    text: `${characterId} が覚えている固定週イベントの記憶。`,
    source_conversation_id: '0009_week_event_exam_basic_practical',
    work_record_id: `wr_${id.slice('mem_'.length)}`,
    tags: ['week_event']
  };
}

function normalMemory(id, characterId) {
  return {
    id,
    character_id: characterId,
    visibility: 'character_known',
    type: 'conversation',
    text: '普通の会話の記憶。',
    source_conversation_id: 'conv_normal_001',
    work_record_id: 'wr_conv_normal_001',
    tags: []
  };
}

// Builds a routing play area (slot_001) and overwrites it with the full week-event residue.
async function seedResidualSave(t) {
  const root = await fixtureRoot('remove-week-event-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });
  const slotRoot = initialized.root;

  await writeJson(slotRoot, 'game_data/runtime_state.json', residualRuntimeState());

  // lina holds a graded week-event memory; character_005 holds a festival week-event memory plus a normal one.
  await writeJson(slotRoot, 'game_data/characters/lina/memory/mem_week_event_0010_exam_basic_practical.json', weekEventMemory('mem_week_event_0010_exam_basic_practical', 'lina'));
  await writeJson(slotRoot, 'game_data/characters/character_005/memory/mem_week_event_0030_starfall_festival.json', weekEventMemory('mem_week_event_0030_starfall_festival', 'character_005'));
  await writeJson(slotRoot, 'game_data/characters/character_005/memory/mem_conv_normal_001.json', normalMemory('mem_conv_normal_001', 'character_005'));

  // Festival affinity audit log + affinity idempotency ledger; graded money idempotency ledger. Each ledger
  // keeps an unrelated entry that must survive.
  await writeJson(slotRoot, 'game_data/logs/affinity_updates/week_event_0030_starfall_festival.json', { conversation_id: 'week_event_0030_starfall_festival' });
  await writeJson(slotRoot, 'game_data/characters/character_005/affinity.json', { character_id: 'character_005', affinity: 35, applied_affinity_conversation_ids: ['conv_other_001', 'week_event_0030_starfall_festival'] });
  await writeJson(slotRoot, 'game_data/player_inventory.json', { money: 1000, items: [], applied_money_delta_conversation_ids: ['conv_shop_001', 'week_event_0010_exam_basic_practical'] });

  return { root, slotRoot };
}

test('a residual week-event content result is a load-blocker after the mechanism is removed', () => {
  // The read the routing hub does on entry now fail-fasts on the unknown kind — the reason the cleanup exists.
  assert.throws(() => readRoutingContentResult(residualRuntimeState()), /kind must be one of/);
});

test('dry-run reports every week-event residue and writes nothing', async (t) => {
  const { root, slotRoot } = await seedResidualSave(t);
  const plan = await removeWeekEventSaveData({ root, slotId: 'slot_001', apply: false });

  assert.equal(plan.applied, false);
  assert.deepEqual(plan.runtime_state_changes, {
    removed_marker: true,
    removed_content_result: true,
    reset_screen: { from: 'academy-week-event', to: 'routing-hub' }
  });
  assert.deepEqual([...plan.removed_memory_files].sort(), [
    'game_data/characters/character_005/memory/mem_week_event_0030_starfall_festival.json',
    'game_data/characters/lina/memory/mem_week_event_0010_exam_basic_practical.json'
  ]);
  assert.deepEqual(plan.removed_affinity_audit_files, ['game_data/logs/affinity_updates/week_event_0030_starfall_festival.json']);
  assert.deepEqual(plan.removed_money_idempotency_keys, ['week_event_0010_exam_basic_practical']);
  assert.deepEqual(plan.removed_affinity_idempotency_keys, [{ character_id: 'character_005', removed_keys: ['week_event_0030_starfall_festival'] }]);

  // Nothing was written.
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(state.current_screen, 'academy-week-event');
  assert.ok(Object.prototype.hasOwnProperty.call(state, 'routing_active_week_event'));
  assert.ok(Object.prototype.hasOwnProperty.call(state, 'last_routing_content_result'));
  const linaMem = await fs.readdir(path.join(slotRoot, 'game_data/characters/lina/memory'));
  assert.deepEqual(linaMem, ['mem_week_event_0010_exam_basic_practical.json']);
  const inventory = await readJson(slotRoot, 'game_data/player_inventory.json');
  assert.deepEqual(inventory.applied_money_delta_conversation_ids, ['conv_shop_001', 'week_event_0010_exam_basic_practical']);
});

test('apply removes every residue; the cleaned save loads and shows the diary without throwing', async (t) => {
  const { root, slotRoot } = await seedResidualSave(t);
  const result = await removeWeekEventSaveData({ root, slotId: 'slot_001', apply: true });
  assert.equal(result.applied, true);

  // runtime_state: marker + content-result gone, stuck screen reset to the hub, unrelated keys preserved.
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(state.current_screen, 'routing-hub');
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'routing_active_week_event'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'last_routing_content_result'), false);
  assert.equal(state.elapsed_weeks, 9, 'unrelated runtime_state is preserved');
  assert.equal(state.current_buddy_character_id, null);

  // Load tolerance: the routing-hub content-result read no longer throws (returns the honest "no result").
  assert.equal(readRoutingContentResult(state), null);

  // Diary tolerance: the week-event memories are gone; the normal memory remains and sorts fine.
  assert.deepEqual(await fs.readdir(path.join(slotRoot, 'game_data/characters/lina/memory')), []);
  const char5Mem = (await fs.readdir(path.join(slotRoot, 'game_data/characters/character_005/memory'))).sort();
  assert.deepEqual(char5Mem, ['mem_conv_normal_001.json']);
  const remaining = [await readJson(slotRoot, 'game_data/characters/character_005/memory/mem_conv_normal_001.json')];
  assert.doesNotThrow(() => sortMemoriesByChronology(remaining));

  // Festival affinity audit log gone.
  assert.deepEqual(await fs.readdir(path.join(slotRoot, 'game_data/logs/affinity_updates')), []);

  // Idempotency ledgers keep only the non-week-event entries.
  const inventory = await readJson(slotRoot, 'game_data/player_inventory.json');
  assert.deepEqual(inventory.applied_money_delta_conversation_ids, ['conv_shop_001']);
  assert.equal(inventory.money, 1000, 'the money balance is untouched');
  const affinity = await readJson(slotRoot, 'game_data/characters/character_005/affinity.json');
  assert.deepEqual(affinity.applied_affinity_conversation_ids, ['conv_other_001']);
  assert.equal(affinity.affinity, 35, 'the affinity value is untouched');
});

test('the cleanup is idempotent: a second run finds nothing to clean', async (t) => {
  const { root } = await seedResidualSave(t);
  await removeWeekEventSaveData({ root, slotId: 'slot_001', apply: true });
  const second = await removeWeekEventSaveData({ root, slotId: 'slot_001', apply: true });
  assert.deepEqual(second.runtime_state_changes, { removed_marker: false, removed_content_result: false, reset_screen: null });
  assert.deepEqual(second.removed_memory_files, []);
  assert.deepEqual(second.removed_affinity_audit_files, []);
  assert.deepEqual(second.removed_money_idempotency_keys, []);
  assert.deepEqual(second.removed_affinity_idempotency_keys, []);
});

test('cleanup fails fast on a malformed idempotency ledger, before writing anything', async (t) => {
  const { root, slotRoot } = await seedResidualSave(t);
  await writeJson(slotRoot, 'game_data/player_inventory.json', { money: 0, applied_money_delta_conversation_ids: 'not-an-array' });
  await assert.rejects(
    removeWeekEventSaveData({ root, slotId: 'slot_001', apply: true }),
    /applied_money_delta_conversation_ids must be an array/
  );
  // The plan-phase throw fires before any write: the stuck screen is still there (nothing partially cleaned).
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(state.current_screen, 'academy-week-event');
});

test('a clean save (no week-event residue) yields an empty plan and no throw', async (t) => {
  const root = await fixtureRoot('remove-week-event-clean-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeNewPlayArea({ root, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });
  const plan = await removeWeekEventSaveData({ root, slotId: 'slot_001', apply: false });
  assert.deepEqual(plan.runtime_state_changes, { removed_marker: false, removed_content_result: false, reset_screen: null });
  assert.deepEqual(plan.removed_memory_files, []);
  assert.deepEqual(plan.removed_affinity_audit_files, []);
  assert.deepEqual(plan.removed_money_idempotency_keys, []);
  assert.deepEqual(plan.removed_affinity_idempotency_keys, []);
});
