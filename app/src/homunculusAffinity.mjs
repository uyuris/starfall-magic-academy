// Homunculus affinity: a dedicated per-homunculus affinity path, distinct from the academy relationship
// state. The academy `characterAffinityPath` / `applyCharacterAffinityDelta` are character-only (they throw
// for non-character actors and open at 25); a homunculus opens at 50 and is stored under its own actor
// directory `game_data/homunculi/<id>/affinity.json`. Sharing only the universal 0..100 bounds and the same
// ±10 conversation-end judgment (parseAffinityDeltaAnswer), never the academy state itself.

import { createStorageApi } from './storage.mjs';
import { resolveDialogueActor } from './llm/dialogueActor.mjs';
import {
  CHARACTER_AFFINITY_MAX,
  CHARACTER_AFFINITY_MIN,
  HOMUNCULUS_AFFINITY_INITIAL_VALUE
} from './affinityConstants.mjs';

export { HOMUNCULUS_AFFINITY_INITIAL_VALUE } from './affinityConstants.mjs';

function resolveHomunculusActor(homunculusId) {
  const actor = resolveDialogueActor(homunculusId);
  if (actor.kind !== 'homunculus') {
    throw new Error(`homunculus affinity is only supported for homunculus actors: ${actor.id}`);
  }
  return actor;
}

export function homunculusAffinityPath(homunculusId) {
  return `${resolveHomunculusActor(homunculusId).basePath}/affinity.json`;
}

export function defaultHomunculusAffinityFile(homunculusId) {
  const actor = resolveHomunculusActor(homunculusId);
  return {
    homunculus_id: actor.id,
    affinity: HOMUNCULUS_AFFINITY_INITIAL_VALUE,
    applied_affinity_conversation_ids: []
  };
}

function invalidAffinityFileError(homunculusId, reason) {
  return new Error(`invalid homunculus affinity state for ${homunculusId}: ${reason}`);
}

export function normalizeHomunculusAffinityFile(affinityFile, homunculusId) {
  const actor = resolveHomunculusActor(homunculusId);
  if (affinityFile == null) return defaultHomunculusAffinityFile(actor.id);
  if (typeof affinityFile !== 'object' || Array.isArray(affinityFile)) {
    throw invalidAffinityFileError(actor.id, 'payload must be an object');
  }
  const fileHomunculusId = String(affinityFile.homunculus_id ?? '').trim();
  if (fileHomunculusId !== actor.id) {
    throw invalidAffinityFileError(actor.id, `homunculus_id must be ${actor.id}`);
  }
  if (!Number.isInteger(affinityFile.affinity) || affinityFile.affinity < CHARACTER_AFFINITY_MIN || affinityFile.affinity > CHARACTER_AFFINITY_MAX) {
    throw invalidAffinityFileError(actor.id, 'affinity must be an integer from 0 to 100');
  }
  if (!Array.isArray(affinityFile.applied_affinity_conversation_ids)) {
    throw invalidAffinityFileError(actor.id, 'applied_affinity_conversation_ids must be an array');
  }
  const appliedIds = affinityFile.applied_affinity_conversation_ids.map((id) => {
    if (typeof id !== 'string') throw invalidAffinityFileError(actor.id, 'applied conversation ids must be strings');
    const normalized = id.trim();
    if (!normalized) throw invalidAffinityFileError(actor.id, 'applied conversation ids must be non-empty');
    return normalized;
  });
  if (new Set(appliedIds).size !== appliedIds.length) {
    throw invalidAffinityFileError(actor.id, 'applied conversation ids must be unique');
  }
  return {
    homunculus_id: actor.id,
    affinity: affinityFile.affinity,
    applied_affinity_conversation_ids: appliedIds
  };
}

function clampAffinity(value) {
  return Math.max(CHARACTER_AFFINITY_MIN, Math.min(CHARACTER_AFFINITY_MAX, value));
}

// Applies one conversation's affinity delta to a homunculus, clamped to 0..100 and idempotent per
// conversation id (re-applying the same conversation is a no-op that reports the unchanged value). A
// homunculus can be made a buddy, so establishing a buddy adds the same +10 buddy delta as the academy
// path; it can never be an enemy, so there is no enemy delta. The applied total is
// `conversationDelta + buddyDelta`.
export async function applyHomunculusAffinityDelta({ root, storage, homunculusId, conversationId, conversationDelta, buddyDelta = 0 }) {
  const actor = resolveHomunculusActor(homunculusId);
  const normalizedConversationId = String(conversationId ?? '').trim();
  if (!normalizedConversationId) throw new Error('conversationId is required');
  if (!Number.isInteger(conversationDelta)) throw new Error('conversationDelta must be an integer');
  if (!Number.isInteger(buddyDelta)) throw new Error('buddyDelta must be an integer');

  const api = storage ?? createStorageApi({ root });
  const relativePath = homunculusAffinityPath(actor.id);
  const current = normalizeHomunculusAffinityFile(await api.readJsonIfExists(relativePath), actor.id);
  const totalDelta = conversationDelta + buddyDelta;

  if (current.applied_affinity_conversation_ids.includes(normalizedConversationId)) {
    return {
      homunculus_id: current.homunculus_id,
      conversation_id: normalizedConversationId,
      conversation_delta: conversationDelta,
      buddy_delta: buddyDelta,
      total_delta: totalDelta,
      before_affinity: current.affinity,
      after_affinity: current.affinity,
      already_applied: true,
      affinity: current
    };
  }

  const beforeAffinity = current.affinity;
  const afterAffinity = clampAffinity(beforeAffinity + totalDelta);
  const next = {
    homunculus_id: current.homunculus_id,
    affinity: afterAffinity,
    applied_affinity_conversation_ids: [...current.applied_affinity_conversation_ids, normalizedConversationId]
  };
  await api.writeJson(relativePath, next);
  return {
    homunculus_id: current.homunculus_id,
    conversation_id: normalizedConversationId,
    conversation_delta: conversationDelta,
    buddy_delta: buddyDelta,
    total_delta: totalDelta,
    before_affinity: beforeAffinity,
    after_affinity: afterAffinity,
    already_applied: false,
    affinity: next
  };
}
