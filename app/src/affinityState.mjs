import { createStorageApi } from './storage.mjs';
import {
  characterAffinityPath,
  normalizeCharacterAffinityFile
} from './affinitySchema.mjs';
import {
  CHARACTER_AFFINITY_MAX,
  CHARACTER_AFFINITY_MIN
} from './affinityConstants.mjs';

export {
  BUDDY_AFFINITY_DELTA,
  CHARACTER_AFFINITY_INITIAL_VALUE,
  CHARACTER_AFFINITY_MAX,
  CHARACTER_AFFINITY_MIN,
  ENEMY_AFFINITY_DELTA
} from './affinityConstants.mjs';

export {
  characterAffinityPath,
  defaultCharacterAffinityFile,
  normalizeCharacterAffinityFile,
  parseAffinityDeltaAnswer
} from './affinitySchema.mjs';

function assertIntegerDelta(name, value) {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
}

function clampAffinity(value) {
  return Math.max(CHARACTER_AFFINITY_MIN, Math.min(CHARACTER_AFFINITY_MAX, value));
}

export async function applyCharacterAffinityDelta({
  root,
  characterId,
  conversationId,
  conversationDelta,
  buddyDelta,
  enemyDelta
}) {
  if (!root) throw new Error('root is required');
  const normalizedConversationId = String(conversationId ?? '').trim();
  if (!normalizedConversationId) throw new Error('conversationId is required');
  assertIntegerDelta('conversationDelta', conversationDelta);
  assertIntegerDelta('buddyDelta', buddyDelta);
  assertIntegerDelta('enemyDelta', enemyDelta);

  const storage = createStorageApi({ root });
  const relativePath = characterAffinityPath(characterId);
  const current = normalizeCharacterAffinityFile(await storage.readJsonIfExists(relativePath), characterId);
  const totalDelta = conversationDelta + buddyDelta + enemyDelta;

  if (current.applied_affinity_conversation_ids.includes(normalizedConversationId)) {
    return {
      character_id: current.character_id,
      conversation_id: normalizedConversationId,
      conversation_delta: conversationDelta,
      buddy_delta: buddyDelta,
      enemy_delta: enemyDelta,
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
    character_id: current.character_id,
    affinity: afterAffinity,
    applied_affinity_conversation_ids: [
      ...current.applied_affinity_conversation_ids,
      normalizedConversationId
    ]
  };
  await storage.writeJson(relativePath, next);
  return {
    character_id: current.character_id,
    conversation_id: normalizedConversationId,
    conversation_delta: conversationDelta,
    buddy_delta: buddyDelta,
    enemy_delta: enemyDelta,
    total_delta: totalDelta,
    before_affinity: beforeAffinity,
    after_affinity: afterAffinity,
    already_applied: false,
    affinity: next
  };
}
