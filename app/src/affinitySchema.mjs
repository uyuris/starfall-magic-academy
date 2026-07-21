import { resolveDialogueActor } from './llm/dialogueActor.mjs';
import {
  CHARACTER_AFFINITY_INITIAL_VALUE,
  CHARACTER_AFFINITY_MAX,
  CHARACTER_AFFINITY_MIN
} from './affinityConstants.mjs';

function resolveAffinityCharacterActor(characterId) {
  const actor = resolveDialogueActor(characterId);
  if (actor.kind !== 'character') {
    throw new Error(`affinity is only supported for academy characters: ${actor.id}`);
  }
  return actor;
}

export function characterAffinityPath(characterId) {
  return `${resolveAffinityCharacterActor(characterId).basePath}/affinity.json`;
}

export function defaultCharacterAffinityFile(characterId) {
  const actor = resolveAffinityCharacterActor(characterId);
  return {
    character_id: actor.id,
    affinity: CHARACTER_AFFINITY_INITIAL_VALUE,
    applied_affinity_conversation_ids: []
  };
}

function invalidAffinityFileError(characterId, reason) {
  return new Error(`invalid affinity state for ${characterId}: ${reason}`);
}

export function normalizeCharacterAffinityFile(affinityFile, characterId) {
  const actor = resolveAffinityCharacterActor(characterId);
  if (affinityFile == null) return defaultCharacterAffinityFile(actor.id);
  if (typeof affinityFile !== 'object' || Array.isArray(affinityFile)) {
    throw invalidAffinityFileError(actor.id, 'payload must be an object');
  }
  const fileCharacterId = String(affinityFile.character_id ?? '').trim();
  if (fileCharacterId !== actor.id) {
    throw invalidAffinityFileError(actor.id, `character_id must be ${actor.id}`);
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
    character_id: actor.id,
    affinity: affinityFile.affinity,
    applied_affinity_conversation_ids: appliedIds
  };
}

export function parseAffinityDeltaAnswer(answer) {
  const raw = String(answer ?? '').trim();
  if (!/^[+\-\u2212]?\d+$/u.test(raw)) {
    throw new Error(`affinity delta answer must be an integer from -10 to 10: ${raw}`);
  }
  const delta = Number(raw.replace(/^\u2212/u, '-'));
  if (!Number.isInteger(delta) || delta < -10 || delta > 10) {
    throw new Error(`affinity delta answer must be an integer from -10 to 10: ${raw}`);
  }
  return delta;
}
