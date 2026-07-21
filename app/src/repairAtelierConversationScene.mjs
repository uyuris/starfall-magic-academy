// Targeted recovery for saves corrupted by the pre-fix atelier-stream bug: a homunculus atelier conversation
// advanced through /api/conversation/stream (before the stream atelier branch existed) wrote its record with
// source_type 'homunculus' but dropped location_name / visible_situation, so conversationFinalizationStageFields
// fail-fasts and the finalization job is left failed — which then blocks every routing drain.
//
// The atelier 舞台 is a single authored constant reused by every atelier conversation (homunculusScene.mjs), so
// restoring it onto a corrupt record is deterministic, not fabrication. This script re-stamps that authored
// scene onto each corrupt atelier record and drops the residual field descriptor (location_id / time_slot) so
// the record matches the canonical injected-scene shape, then resets each failed homunculus finalization job to
// a retryable pending state so the next routing drain finalizes it.
//
// Dry-run by default: it computes and returns the full plan without writing. Pass apply: true to write.
// Fail-fast, never silent-skip: a corrupt record without an id, or a failed homunculus job whose conversation
// record is missing or still not a healthy atelier record, aborts the whole repair.

import { promises as fs } from 'node:fs';

import { createStorageApi } from './storage.mjs';
import { assertValidSlotId, isValidSlot, readValidActiveSlotId, resolveSlotProjectRoot } from './playSession.mjs';
import { ATELIER_LOCATION_NAME, ATELIER_VISIBLE_SITUATION } from './homunculusScene.mjs';
import { HOMUNCULUS_SOURCE_TYPE } from './routingMetaContext.mjs';

const HOMUNCULUS_ID_PATTERN = /^homunculus_\d{3}$/;
const CONVERSATIONS_DIR = 'game_data/logs/conversations';
const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmptyLocationName(record) {
  return typeof record.location_name === 'string' && record.location_name.trim().length > 0;
}

// A homunculus record that dropped its atelier 舞台 (no non-empty location_name) — the exact corruption the
// pre-fix stream turn produced.
function isCorruptAtelierRecord(record) {
  return isPlainObject(record) && record.source_type === HOMUNCULUS_SOURCE_TYPE && !hasNonEmptyLocationName(record);
}

// A homunculus record that already carries the atelier 舞台 (nothing to repair, and a valid finalization target).
function isHealthyAtelierRecord(record) {
  return isPlainObject(record)
    && record.source_type === HOMUNCULUS_SOURCE_TYPE
    && hasNonEmptyLocationName(record)
    && typeof record.visible_situation === 'string';
}

// Re-stamp the authored atelier scene and remove the residual field descriptor so the record matches what a
// correct atelier turn writes (injected-scene shape: location_name / visible_situation, no location_id / time_slot).
function repairAtelierRecord(record) {
  const { location_id: _locationId, time_slot: _timeSlot, ...rest } = record;
  return {
    ...rest,
    location_name: ATELIER_LOCATION_NAME,
    visible_situation: ATELIER_VISIBLE_SITUATION
  };
}

async function listConversationFileNames(conversationsDir) {
  let entries;
  try {
    entries = await fs.readdir(conversationsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

// Reset a failed job to the canonical retryable pending record (exactly the enqueue keys), dropping the
// failure metadata (failed_at / error / retry_started_at) and the attempt count. This mirrors the queue's
// own failed→pending retry-prepare semantics so the next drain treats it as drainable.
function toRetryablePendingJob(job) {
  return {
    conversation_id: job.conversation_id,
    character_id: job.character_id,
    enqueued_at: job.enqueued_at,
    status: 'pending',
    attempts: 0
  };
}

export async function repairAtelierConversationScene({ root, slotId = null, apply = false } = {}) {
  if (!root) throw new Error('root is required');
  const resolvedSlotId = slotId ? assertValidSlotId(slotId) : await readValidActiveSlotId(root);
  if (!resolvedSlotId) {
    throw new Error('no target slot: pass an explicit slot id or set an active slot before repairing');
  }
  if (!(await isValidSlot(root, resolvedSlotId))) throw new Error(`unknown slot: ${resolvedSlotId}`);

  const slotProjectRoot = resolveSlotProjectRoot(root, resolvedSlotId);
  const storage = createStorageApi({ root: slotProjectRoot });

  // 1. Corrupt atelier conversation records → re-stamp the authored scene.
  const conversationsDir = await storage.resolveReadPath(CONVERSATIONS_DIR);
  const conversationFileNames = await listConversationFileNames(conversationsDir);
  const conversationRepairs = [];
  // Conversation ids that are (after this pass) a healthy atelier record — the safe targets for a failed-job reset.
  const healthyAtelierConversationIds = new Set();
  for (const fileName of conversationFileNames) {
    const relativePath = `${CONVERSATIONS_DIR}/${fileName}`;
    const record = await storage.readJson(relativePath);
    if (isHealthyAtelierRecord(record)) {
      healthyAtelierConversationIds.add(record.id);
      continue;
    }
    if (!isCorruptAtelierRecord(record)) continue;
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error(`corrupt atelier record has no usable id: ${fileName}`);
    }
    const repaired = repairAtelierRecord(record);
    conversationRepairs.push({
      conversation_id: record.id,
      file: fileName,
      before_location_name: record.location_name ?? null,
      had_field_location_id: Object.prototype.hasOwnProperty.call(record, 'location_id'),
      after_location_name: ATELIER_LOCATION_NAME
    });
    healthyAtelierConversationIds.add(record.id);
    if (apply) await storage.writeJson(relativePath, repaired);
  }

  // 2. Failed homunculus finalization jobs → reset to retryable pending.
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  if (Object.prototype.hasOwnProperty.call(state, 'pending_finalizations') && !Array.isArray(state.pending_finalizations)) {
    throw new Error('runtime_state.pending_finalizations must be an array when present');
  }
  const pending = Array.isArray(state.pending_finalizations) ? state.pending_finalizations : [];
  const finalizationRepairs = [];
  const nextPending = pending.map((job) => {
    const characterId = String(job?.character_id ?? '').trim();
    const isFailedHomunculusJob = job?.status === 'failed' && HOMUNCULUS_ID_PATTERN.test(characterId);
    if (!isFailedHomunculusJob) return job;
    const conversationId = String(job?.conversation_id ?? '').trim();
    if (!healthyAtelierConversationIds.has(conversationId)) {
      throw new Error(
        `cannot make failed homunculus finalization retryable: conversation ${conversationId || '(missing id)'} is not a healthy atelier record`
      );
    }
    finalizationRepairs.push({
      conversation_id: conversationId,
      character_id: characterId,
      before_status: 'failed',
      after_status: 'pending'
    });
    return toRetryablePendingJob({ ...job, conversation_id: conversationId, character_id: characterId });
  });

  if (apply && finalizationRepairs.length > 0) {
    await storage.writeJson(RUNTIME_STATE_PATH, { ...state, pending_finalizations: nextPending });
  }

  return {
    slot_id: resolvedSlotId,
    applied: apply,
    conversation_repairs: conversationRepairs,
    finalization_repairs: finalizationRepairs
  };
}
