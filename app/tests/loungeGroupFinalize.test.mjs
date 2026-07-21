// 談話室 aggregate finalizer: the conversation-end processing for a 3 NPC + プレイヤー group talk. These tests
// pin the group finalization policy (memory/skill/work-record + affinity only; field/relationship/MP skipped),
// the participant-scoped projection (per-participant work-record ids and logs, affinity to three separate files
// idempotent per conversation id), the speaker-named multi-speaker generation prompt, and the single-staging
// transaction (all three succeed → one group marker + one transcript discard; any failure → nothing partial
// promoted). The LM is reached only through injected provider seams — no live model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixtureRoot, baselineRuntimeState, cloneGameDataFixture, writeJson } from './helpers.mjs';
import { projectRoot } from './testPaths.mjs';
import { writeRuntimePathsManifest } from '../src/runtimeSlotBootstrap.mjs';
import { resolveFinalizeStagingDir } from '../src/routingFinalizeQueue.mjs';
import { applyCharacterAffinityDelta } from '../src/affinityState.mjs';
import {
  startLoungeGroupConversation,
  runLoungeGroupTurn,
  readLoungeGroupRecord
} from '../src/llm/loungeGroupTurn.mjs';
import {
  resolveLoungeGroupFinalizationPolicy,
  runLoungeGroupFinalization,
  finalizeLoungeGroupConversationAtomic
} from '../src/llm/loungeGroupFinalize.mjs';

const NOW = '2026-07-17T00:00:00.000Z';

async function exists(targetPath) {
  return fs.access(targetPath).then(() => true).catch(() => false);
}

async function listDir(targetPath) {
  return fs.readdir(targetPath).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
}

async function legacyLoungeRoot(t, { elapsedWeeks = 3 } = {}) {
  const root = await fixtureRoot('magic-adv-lounge-finalize-', {
    runtimeState: { ...baselineRuntimeState, elapsed_weeks: elapsedWeeks }
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

// Build the `<playRoot>/slots/slot_001/game_data` slot layout the atomic staging machinery resolves through,
// with the manifest pointing content/definitions at the real repo (so the roster and profiles load) and the
// mutable surface at the slot. Mirrors production's per-slot layout without materializing a full play area.
async function slotLoungeRoot(t, { elapsedWeeks = 3 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-lounge-finalize-slot-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  const playRoot = path.join(base, 'play');
  const slotRoot = path.join(playRoot, 'slots', 'slot_001');
  const slotGameData = path.join(slotRoot, 'game_data');
  await fs.mkdir(slotGameData, { recursive: true });
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    version: 1,
    current_screen: 'academy-map',
    current_location_id: 'herbology_garden',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: elapsedWeeks
  });
  await writeRuntimePathsManifest({ root: slotRoot, sourceRoot: projectRoot, mutableRoot: slotGameData });
  await writeRuntimePathsManifest({ root: playRoot, sourceRoot: projectRoot, mutableRoot: slotGameData });
  await fs.writeFile(path.join(playRoot, 'active_slot.json'), `${JSON.stringify({ slot_id: 'slot_001' }, null, 2)}\n`, 'utf8');
  return { base, playRoot, slotGameData };
}

// Seat the week's three participants and run one NPC round, leaving a three-line named transcript to finalize.
async function seatAndTalk({ root, id, week = 3 }) {
  const started = await startLoungeGroupConversation({ root, id, week });
  let turn = 0;
  const chatProvider = async () => {
    turn += 1;
    return `発話${turn}。`;
  };
  const emotionProvider = async () => ({ expression: 'neutral' });
  for (let i = 0; i < started.participants.length; i += 1) {
    await runLoungeGroupTurn({ root, id, chatProvider, emotionProvider });
  }
  return await readLoungeGroupRecord({ root, id });
}

// Recording finalization providers: skill necessity is false (no skill record), memory/work-record are minimal
// valid records, affinity returns a fixed +3. Every prompt is captured for the multi-speaker presentation checks.
function finalizeProviders({ affinity = '3', failOnParticipantId = null } = {}) {
  const memoryPrompts = [];
  const affinityPrompts = [];
  const workRecordPrompts = [];
  const skillNecessityPrompts = [];
  return {
    memoryPrompts,
    affinityPrompts,
    workRecordPrompts,
    skillNecessityPrompts,
    memoryUpdateProvider: async ({ prompt, participant, workRecordId }) => {
      memoryPrompts.push(prompt);
      return {
        memory_record: {
          id: `mem_${workRecordId}`,
          character_id: participant.character_id,
          type: 'relationship_change',
          text: `${participant.character_name}は談話室で主人公と言葉を交わした。`,
          created_at: NOW,
          tags: [participant.character_id, 'conversation']
        }
      };
    },
    skillNecessityProvider: async ({ prompt }) => {
      skillNecessityPrompts.push(prompt);
      return { necessary: false, raw_answer: 'false' };
    },
    skillUpdateProvider: async () => {
      throw new Error('skillUpdateProvider must not run when necessity is false');
    },
    workRecordProvider: async ({ prompt, participant, workRecordId }) => {
      workRecordPrompts.push(prompt);
      if (failOnParticipantId && participant.character_id === failOnParticipantId) {
        throw new Error(`synthetic work-record failure for ${participant.character_id}`);
      }
      return {
        work_record: {
          id: workRecordId,
          character_id: participant.character_id,
          title: `${participant.character_name}の談話`,
          summary: '談話室で三人のキャラクターと主人公が言葉を交わした。',
          flag_update_candidates: [],
          warnings: []
        }
      };
    },
    affinityDeltaProvider: async ({ prompt }) => {
      affinityPrompts.push(prompt);
      return affinity;
    }
  };
}

test('the group finalization policy explicitly skips field/relationship/MP and runs only the three-piece + affinity', () => {
  const policy = resolveLoungeGroupFinalizationPolicy();
  assert.equal(policy.source_type, 'lounge');
  assert.equal(policy.participant_count, 3);
  assert.equal(policy.runFieldJudgments, false);
  assert.equal(policy.runRelationshipJudgments, false);
  assert.equal(policy.runMpReserve, false);
  assert.equal(policy.perParticipant.memory, true);
  assert.equal(policy.perParticipant.skill, true);
  assert.equal(policy.perParticipant.workRecord, true);
  assert.equal(policy.perParticipant.affinity.mode, 'character');
  assert.equal(policy.perParticipant.affinity.buddyDelta, 0);
  assert.equal(policy.perParticipant.affinity.enemyDelta, 0);
});

test('finalizing the group writes participant-scoped records/logs, one group marker, and discards the transcript once', async (t) => {
  const root = await legacyLoungeRoot(t);
  const id = 'conv_lounge_finalize_ok';
  const record = await seatAndTalk({ root, id });
  const participantIds = record.participants.map((p) => p.character_id);

  const providers = finalizeProviders();
  const result = await runLoungeGroupFinalization({ root, conversationId: id, now: NOW, ...providers });
  assert.equal(result.participants.length, 3);

  for (const participant of record.participants) {
    const pid = participant.character_id;
    const key = `${id}_${pid}`;
    const workRecordId = `wr_${id}_${pid}`;
    // Participant-scoped ids and logs never collide across the three projections.
    const participantResult = result.participants.find((r) => r.participant_id === pid);
    assert.equal(participantResult.work_record_id, workRecordId);
    assert.ok(await exists(path.join(root, `game_data/logs/memory_updates/${key}.json`)), `${key} memory log`);
    assert.ok(await exists(path.join(root, `game_data/logs/skill_updates/${key}.json`)), `${key} skill log`);
    assert.ok(await exists(path.join(root, `game_data/logs/work_record_updates/${key}.json`)), `${key} work-record log`);
    assert.ok(await exists(path.join(root, `game_data/logs/validator/${key}.json`)), `${key} validator log`);
    assert.ok(await exists(path.join(root, `game_data/logs/affinity_updates/${key}.json`)), `${key} affinity log`);
    // The accepted memory and work-record markdown land under the participant's own actor directory.
    const memoryDir = await listDir(path.join(root, `game_data/characters/${pid}/memory`));
    assert.ok(memoryDir.some((name) => name === `mem_${workRecordId}.json`), `${pid} accepted memory saved`);
    assert.ok(await exists(path.join(root, `game_data/characters/${pid}/work_records/${workRecordId}.md`)), `${pid} work record md`);
    // Affinity applied to that participant's own file, recording the group conversation id (28 = initial 25 + 3).
    const affinity = JSON.parse(await fs.readFile(path.join(root, `game_data/characters/${pid}/affinity.json`), 'utf8'));
    assert.equal(affinity.affinity, 28);
    assert.deepEqual(affinity.applied_affinity_conversation_ids, [id]);
  }

  // No 1:1-only side effect logs are written for the group (field / relationship / MP are skipped).
  for (const skippedDir of ['money_updates', 'buddy_updates', 'enemy_updates', 'mp_reserve_updates', 'stage_reward_updates']) {
    const entries = await listDir(path.join(root, `game_data/logs/${skippedDir}`));
    assert.equal(entries.length, 0, `${skippedDir} has no group side-effect logs`);
  }

  // Exactly one group finalization marker for the whole talk (not one per participant).
  const finalizationEntries = await listDir(path.join(root, 'game_data/logs/finalization'));
  assert.deepEqual(finalizationEntries, [`${id}.json`]);
  const marker = JSON.parse(await fs.readFile(path.join(root, `game_data/logs/finalization/${id}.json`), 'utf8'));
  assert.equal(marker.conversation_id, id);
  assert.equal(marker.source_type, 'lounge');
  assert.deepEqual(marker.participants.map((entry) => entry.character_id).sort(), [...participantIds].sort());

  // The shared transcript is discarded exactly once; the record keeps its structure with empty messages.
  const discarded = await readLoungeGroupRecord({ root, id });
  assert.equal(discarded.messages.length, 0);
  assert.equal(discarded.participants.length, 3);
});

test('the three-piece and affinity prompts are speaker-named multi-speaker presentations naming the target participant', async (t) => {
  const root = await legacyLoungeRoot(t);
  const id = 'conv_lounge_finalize_prompt';
  const record = await seatAndTalk({ root, id });
  const providers = finalizeProviders();
  await runLoungeGroupFinalization({ root, conversationId: id, now: NOW, ...providers });

  const firstParticipant = record.participants[0];
  const otherParticipant = record.participants[1];
  const memoryPrompt = providers.memoryPrompts[0];
  // The target participant is named, the other participants appear in the roster, and the transcript renders each
  // line under its own speaker — the multi-speaker presentation, not the 1:1 "every assistant line is the actor".
  assert.ok(memoryPrompt.includes(firstParticipant.character_name), 'the target participant is named');
  assert.ok(memoryPrompt.includes(otherParticipant.character_name), 'the other participants are named in the roster');
  assert.ok(memoryPrompt.includes('談話:'), 'the shared transcript is presented');
  const firstLine = record.messages.find((m) => m.role === 'assistant');
  assert.ok(memoryPrompt.includes(`- ${firstLine.character_name}: ${firstLine.content}`), 'each transcript line is named by its own speaker');
  assert.ok(!memoryPrompt.includes('"role": "assistant"がキャラクターの発言'), 'the 1:1 two-party framing is not used');

  const affinityPrompt = providers.affinityPrompts[0];
  assert.ok(affinityPrompt.includes(firstParticipant.character_name), 'the affinity prompt names the target participant');
  assert.ok(affinityPrompt.includes('−10〜+10'), 'the affinity prompt carries the integer range');
  assert.ok(affinityPrompt.includes('談話:'), 'the affinity prompt presents the shared transcript');
});

test('affinity is idempotent per conversation id in each participant\'s own file', async (t) => {
  const root = await legacyLoungeRoot(t);
  const id = 'conv_lounge_finalize_idem';
  const record = await seatAndTalk({ root, id });
  const target = record.participants[0].character_id;
  // Pre-apply THIS conversation id to the first participant's affinity file (25 + 5 = 30).
  await applyCharacterAffinityDelta({ root, characterId: target, conversationId: id, conversationDelta: 5, buddyDelta: 0, enemyDelta: 0 });

  const providers = finalizeProviders({ affinity: '3' });
  const result = await runLoungeGroupFinalization({ root, conversationId: id, now: NOW, ...providers });

  const targetResult = result.participants.find((r) => r.participant_id === target);
  assert.equal(targetResult.affinity_update.already_applied, true, 'the pre-applied participant is not double-applied');
  assert.equal(targetResult.affinity_update.after_affinity, 30, 'the pre-applied affinity value is unchanged');
  const targetAffinity = JSON.parse(await fs.readFile(path.join(root, `game_data/characters/${target}/affinity.json`), 'utf8'));
  assert.equal(targetAffinity.affinity, 30);
  assert.deepEqual(targetAffinity.applied_affinity_conversation_ids, [id], 'the conversation id is recorded exactly once');

  // The other participants apply the +3 normally (25 + 3 = 28).
  for (const participant of record.participants.slice(1)) {
    const affinity = JSON.parse(await fs.readFile(path.join(root, `game_data/characters/${participant.character_id}/affinity.json`), 'utf8'));
    assert.equal(affinity.affinity, 28);
  }
});

test('a participant generation failure throws before the marker/discard land (non-atomic core)', async (t) => {
  const root = await legacyLoungeRoot(t);
  const id = 'conv_lounge_finalize_fail';
  const record = await seatAndTalk({ root, id });
  const failing = record.participants[1].character_id;

  const providers = finalizeProviders({ failOnParticipantId: failing });
  await assert.rejects(
    runLoungeGroupFinalization({ root, conversationId: id, now: NOW, ...providers }),
    /synthetic work-record failure/
  );
  // Neither the group marker nor the transcript discard happened: no partial-completion signal.
  assert.equal(await exists(path.join(root, `game_data/logs/finalization/${id}.json`)), false, 'no group marker on failure');
  const stillActive = await readLoungeGroupRecord({ root, id });
  assert.equal(stillActive.messages.length, 3, 'the transcript is not discarded on failure');
});

test('re-finalizing an already finalized lounge conversation fails fast', async (t) => {
  const root = await legacyLoungeRoot(t);
  const id = 'conv_lounge_finalize_twice';
  await seatAndTalk({ root, id });
  const providers = finalizeProviders();
  await runLoungeGroupFinalization({ root, conversationId: id, now: NOW, ...providers });
  await assert.rejects(
    runLoungeGroupFinalization({ root, conversationId: id, now: NOW, ...finalizeProviders() }),
    /already finalized/
  );
});

test('the atomic finalizer promotes all three participants in one transaction on success', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t);
  const id = 'conv_lounge_atomic_ok';
  const record = await seatAndTalk({ root: playRoot, id });

  const providers = finalizeProviders();
  const result = await finalizeLoungeGroupConversationAtomic({ root: playRoot, conversationId: id, now: NOW, ...providers });
  assert.equal(result.finalization_status, 'completed');

  // The promoted live slot carries the group marker, the emptied transcript, and each participant's affinity.
  assert.ok(await exists(path.join(slotGameData, `logs/finalization/${id}.json`)), 'the group marker is promoted');
  const record2 = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${id}.json`), 'utf8'));
  assert.equal(record2.messages.length, 0, 'the transcript is discarded in the live slot');
  for (const participant of record.participants) {
    const affinity = JSON.parse(await fs.readFile(path.join(slotGameData, `characters/${participant.character_id}/affinity.json`), 'utf8'));
    assert.equal(affinity.affinity, 28);
  }
  // No staging workspace remains for this conversation after promotion.
  assert.equal(await exists(resolveFinalizeStagingDir(playRoot, 'slot_001', id)), false, 'the staging workspace is cleaned up');
});

test('the atomic finalizer discards the staging workspace on a participant failure, leaving no partial finalize', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t);
  const id = 'conv_lounge_atomic_fail';
  const record = await seatAndTalk({ root: playRoot, id });
  const failing = record.participants[1].character_id;
  const survivor = record.participants[0].character_id;

  const providers = finalizeProviders({ failOnParticipantId: failing });
  await assert.rejects(
    finalizeLoungeGroupConversationAtomic({ root: playRoot, conversationId: id, now: NOW, ...providers }),
    /synthetic work-record failure/
  );

  // Nothing partial reached the live slot: no marker, the transcript is intact, and even the first participant's
  // (staged) memory / affinity writes were discarded with the workspace.
  assert.equal(await exists(path.join(slotGameData, `logs/finalization/${id}.json`)), false, 'no group marker promoted');
  const stillActive = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${id}.json`), 'utf8'));
  assert.equal(stillActive.messages.length, 3, 'the live transcript is intact');
  assert.equal(await exists(path.join(slotGameData, `logs/validator/${id}_${survivor}.json`)), false, 'the first participant validator log did not promote');
  assert.equal(await exists(path.join(slotGameData, `characters/${survivor}/affinity.json`)), false, 'the first participant affinity did not promote');
  // The staging workspace for this conversation was removed (no promoting sentinel left behind).
  assert.equal(await exists(resolveFinalizeStagingDir(playRoot, 'slot_001', id)), false, 'the failed staging workspace is cleaned up');
});
