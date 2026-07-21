import { isCreatureId } from '../creatureCatalog.mjs';

const CHARACTER_ID_PATTERN = /^character_\d{3}$/;
export const HOMUNCULUS_ID_PATTERN = /^homunculus_\d{3}$/;

export function normalizeDialogueActorId(actorId) {
  const normalized = String(actorId ?? '').trim();
  if (!normalized) throw new Error('dialogue actor id is required');
  return normalized;
}

export function resolveDialogueActor(actorId) {
  const id = normalizeDialogueActorId(actorId);
  if (id === 'lina' || CHARACTER_ID_PATTERN.test(id)) {
    return {
      id,
      kind: 'character',
      stateCollection: 'characters',
      basePath: `game_data/characters/${id}`
    };
  }
  if (isCreatureId(id)) {
    return {
      id,
      kind: 'creature',
      stateCollection: 'creatures',
      basePath: `game_data/creatures/${id}`
    };
  }
  if (HOMUNCULUS_ID_PATTERN.test(id)) {
    // A homunculus is a per-slot minted actor: its whole actor directory (profile/flags/skills/memory/
    // work_records/affinity) is mutable state under game_data/homunculi/<id>/, not authored content. An id
    // for which that directory does not yet exist fails fast at the profile read, the same as any actor.
    return {
      id,
      kind: 'homunculus',
      stateCollection: 'homunculi',
      basePath: `game_data/homunculi/${id}`
    };
  }
  throw new Error(`unknown dialogue actor: ${id}`);
}

export function isCreatureDialogueActor(actorId) {
  return resolveDialogueActor(actorId).kind === 'creature';
}

export function isHomunculusDialogueActor(actorId) {
  return resolveDialogueActor(actorId).kind === 'homunculus';
}

export function normalizeDialogueActorFlagsFile(flagsFile, actorId) {
  const actor = resolveDialogueActor(actorId);
  if (flagsFile == null) return {};
  if (typeof flagsFile !== 'object' || Array.isArray(flagsFile)) {
    throw new Error(`invalid dialogue actor flags for ${actor.id}`);
  }
  if (Object.prototype.hasOwnProperty.call(flagsFile, 'flags')) {
    const fileActorId = String(flagsFile.character_id ?? '').trim();
    if (fileActorId && fileActorId !== actor.id) {
      throw new Error(`invalid dialogue actor flags id for ${actor.id}: ${fileActorId}`);
    }
    const flags = flagsFile.flags ?? {};
    if (typeof flags !== 'object' || Array.isArray(flags)) {
      throw new Error(`invalid dialogue actor flags payload for ${actor.id}`);
    }
    return { ...flags };
  }
  return { ...flagsFile };
}

export function normalizeDialogueActorSkillsFile(skillsFile, actorId) {
  const actor = resolveDialogueActor(actorId);
  const source = skillsFile ?? { character_id: actor.id, skills: [] };
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`invalid dialogue actor skills for ${actor.id}`);
  }
  const fileActorId = String(source.character_id ?? actor.id).trim();
  if (fileActorId !== actor.id) {
    throw new Error(`invalid dialogue actor skills id for ${actor.id}: ${fileActorId}`);
  }
  if (!Array.isArray(source.skills)) {
    throw new Error(`invalid dialogue actor skills payload for ${actor.id}`);
  }
  return { ...source, character_id: actor.id, skills: [...source.skills] };
}
