// Unit tests for the migration script that adds the top-level `unconsumed_routing_conversation` field to every
// pre-change save slot. Pins the CLI contract that Stage 2 will call from the frontend: dry-run reports what
// would change without writing, `--apply` writes null into missing keys and leaves populated ones untouched, and
// running twice in a row is a no-op (idempotent). The script is fail-fast: a non-object runtime_state throws
// with a descriptive error rather than silently skipping.
//
// The migration is exercised through its exported entry (`addUnconsumedRoutingConversationPointer`) so the tests
// do not require a real product-shaped play root; each test constructs the minimum slot skeleton the walker
// needs (a slot meta + runtime_state.json under the resolved slot project path).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePlaySlotsRoot, resolveSlotProjectRoot } from '../src/playSession.mjs';
import { addUnconsumedRoutingConversationPointer } from '../../scripts/add-unconsumed-routing-conversation-pointer.mjs';

async function createPlayRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-hub-pointer-migration-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  // The migration reader (`listValidSlotIds`) requires the slots root to exist as a directory. Create it so an
  // otherwise-empty play root reports zero slots instead of throwing on directory absence.
  await fs.mkdir(resolvePlaySlotsRoot(root), { recursive: true });
  return root;
}

// Writes a minimal-but-valid slot skeleton: a `runtime_state.json` (with the state's shape guaranteed by the
// caller) and a `meta.json` naming the slot's play_mode. The migration's slot walker (`listValidSlotIds`) accepts
// a slot as valid iff both files parse; the pointer walk does not read the character catalog or the seed logs, so
// no further scaffolding is needed for the migration.
async function writeSlotSkeleton(root, slotId, { state, playMode = 'loop' }) {
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  await fs.mkdir(path.join(slotRoot, 'game_data'), { recursive: true });
  await fs.writeFile(path.join(slotRoot, 'game_data/runtime_state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(slotRoot, 'meta.json'), `${JSON.stringify({
    slot_id: slotId,
    label: slotId,
    play_mode: playMode
  }, null, 2)}\n`, 'utf8');
}

async function readRuntimeState(root, slotId) {
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  return JSON.parse(await fs.readFile(path.join(slotRoot, 'game_data/runtime_state.json'), 'utf8'));
}

function preMigrationState() {
  return {
    version: 1,
    elapsed_weeks: 3,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-map',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    last_conversation_id: null
  };
}

test('dry-run reports missing pointers without writing, --apply writes null, second run is a no-op', async (t) => {
  const root = await createPlayRoot(t);
  await writeSlotSkeleton(root, 'slot_001', { state: preMigrationState() });
  await writeSlotSkeleton(root, 'slot_002', { state: preMigrationState() });

  const dryRun = await addUnconsumedRoutingConversationPointer({ root, apply: false });
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.total, 2);
  assert.equal(dryRun.added, 2);
  assert.equal(dryRun.skipped_already_present, 0);
  assert.deepEqual(dryRun.added_targets.sort(), ['slot:slot_001', 'slot:slot_002']);
  // Dry-run wrote nothing: the field is still absent.
  const stateAfterDryRun = await readRuntimeState(root, 'slot_001');
  assert.equal(Object.prototype.hasOwnProperty.call(stateAfterDryRun, 'unconsumed_routing_conversation'), false);

  const applied = await addUnconsumedRoutingConversationPointer({ root, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.added, 2);
  assert.equal(applied.skipped_already_present, 0);

  const state001 = await readRuntimeState(root, 'slot_001');
  const state002 = await readRuntimeState(root, 'slot_002');
  assert.equal(state001.unconsumed_routing_conversation, null);
  assert.equal(state002.unconsumed_routing_conversation, null);

  const secondRun = await addUnconsumedRoutingConversationPointer({ root, apply: true });
  assert.equal(secondRun.added, 0);
  assert.equal(secondRun.skipped_already_present, 2);
  assert.deepEqual(secondRun.added_targets, []);
});

test('a slot that already carries the pointer is skipped, preserving its exact value', async (t) => {
  const root = await createPlayRoot(t);
  const seededPointer = {
    conversation_id: 'conv_prior_eligible_001',
    kind: '1_to_1',
    participants: [{ character_id: 'character_001', character_name: 'セラ・アストルーペ' }],
    summary_source: { kind: 'validator', validator_log_path: 'game_data/logs/validator/conv_prior_eligible_001.json' },
    terminal_signal_at: '2026-07-24T05:00:00.000Z'
  };
  await writeSlotSkeleton(root, 'slot_001', {
    state: { ...preMigrationState(), unconsumed_routing_conversation: seededPointer }
  });

  const applied = await addUnconsumedRoutingConversationPointer({ root, apply: true });
  assert.equal(applied.added, 0);
  assert.equal(applied.skipped_already_present, 1);

  const stateAfter = await readRuntimeState(root, 'slot_001');
  assert.deepEqual(stateAfter.unconsumed_routing_conversation, seededPointer, 'the existing pointer is preserved byte-for-byte');
});

test('the migration walks every valid slot and reports each target under a stable label', async (t) => {
  const root = await createPlayRoot(t);
  for (const slotId of ['slot_001', 'slot_002', 'slot_003']) {
    await writeSlotSkeleton(root, slotId, { state: preMigrationState() });
  }
  const dryRun = await addUnconsumedRoutingConversationPointer({ root, apply: false });
  assert.deepEqual(dryRun.added_targets.sort(), ['slot:slot_001', 'slot:slot_002', 'slot:slot_003']);
  assert.equal(dryRun.total, 3);
});

test('a malformed runtime_state (non-object) fails fast rather than silently skipping the slot', async (t) => {
  const root = await createPlayRoot(t);
  // Write the skeleton first so the slot is valid to the walker, then overwrite the runtime state with a JSON
  // array — a valid JSON parse but not a runtime state object. The strict shape check must reject it before it
  // silently reads as "already has the key" (arrays have no own property named after the pointer).
  await writeSlotSkeleton(root, 'slot_001', { state: preMigrationState() });
  const slotRoot = resolveSlotProjectRoot(root, 'slot_001');
  await fs.writeFile(path.join(slotRoot, 'game_data/runtime_state.json'), '[]\n', 'utf8');
  await assert.rejects(
    addUnconsumedRoutingConversationPointer({ root, apply: false }),
    /runtime_state must be an object/
  );
});
