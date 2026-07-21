import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createStorageApi } from './storage.mjs';
import { ensureCharacterMutableSurface, writeRuntimePathsManifest } from './runtimeSlotBootstrap.mjs';
import { runtimePathsManifestFilename } from './runtimePaths.mjs';
import { normalizeParameters } from './parameters.mjs';
import { faceExpressions } from './faceExpressions.mjs';

const characterCount = 172;
const visualRebuildVersion = 'visual-set-mbti-diverse-prompt-review-2026-05-07-v3';

const parameterAttitudeTypes = [
  'respect_any_superior',
  'equal_any_respect_average',
  'equal_average_respect_1_2',
  'equal_1_2_respect_1_5'
];

function pad(index) {
  return String(index).padStart(3, '0');
}

function characterIdForIndex(index) {
  return `character_${pad(index)}`;
}

function visualSetIdForIndex(index) {
  return `visual_set_${pad(index)}`;
}

function characterIndexFromId(characterId) {
  const match = /^character_(\d{3})$/.exec(String(characterId ?? '').trim());
  if (!match) throw new Error(`unknown selectable character: ${characterId}`);
  const index = Number.parseInt(match[1], 10);
  if (!Number.isInteger(index) || index < 1 || index > characterCount) throw new Error(`unknown selectable character: ${characterId}`);
  return index;
}

export function isSelectableCharacterId(characterId) {
  try {
    characterIndexFromId(characterId);
    return true;
  } catch {
    return false;
  }
}

function publicCanonicalUrl(relativePath) {
  return `/canonical/${relativePath.split(path.sep).join('/')}`;
}

export function publicCanonicalFaceUrl(visualSetId, expression = 'neutral') {
  return publicCanonicalUrl(`character_visual_sets/${visualSetId}/face_emotions/${expression}.jpg`);
}

export function publicCanonicalSceneStandeeUrl(visualSetId, filename) {
  if (!filename) throw new Error(`missing scene standee filename: ${visualSetId}`);
  return publicCanonicalUrl(`character_visual_sets/${visualSetId}/scene_standee/${filename}`);
}

export async function sceneStandeeFilenameFromManifest({ root, visualSetId }) {
  const storage = createStorageApi({ root });
  const visualSetRoot = path.join(storage.paths.canonicalAssetsRoot, 'character_visual_sets', visualSetId);
  const manifestPath = path.join(visualSetRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`missing visual set manifest: ${visualSetId}`);
    throw error;
  }
  const manifestStandeePath = String(manifest?.scene_standee?.path ?? '').trim().split(path.sep).join('/');
  if (!/^scene_standee\/scene_standee_character_\d+\.(?:jpg|png)$/.test(manifestStandeePath)) {
    throw new Error(`invalid scene_standee path for ${visualSetId}: ${manifestStandeePath || '(empty)'}`);
  }
  const standeePath = path.join(visualSetRoot, ...manifestStandeePath.split('/'));
  const exists = await fs.access(standeePath).then(() => true).catch(() => false);
  if (!exists) throw new Error(`missing scene standee asset for ${visualSetId}: ${manifestStandeePath}`);
  return path.basename(manifestStandeePath);
}

function sanitizePromptDescription(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('undefined')) return fallback;
  return text
    .split('\n')
    .filter((line) => !line.includes('外見の基準'))
    .join('\n')
    .replace(/\s*外見の基準[:：].*$/s, '')
    .trim() || fallback;
}

function runtimeManagedProfileFields({ characterId, visualSetId, assetState }) {
  return {
    character_id: characterId,
    visual_set_id: visualSetId,
    source_image: `character_visual_sets/${visualSetId}/face_emotions/neutral.jpg`,
    asset_pack: 'assets_v5',
    visual_rebuild_version: visualRebuildVersion,
    available_expressions: faceExpressions,
    asset_state: {
      ...assetState,
      character_id: characterId,
      visual_set_id: visualSetId,
      expression: assetState?.expression ?? 'neutral',
      standee_variant_id: assetState?.standee_variant_id ?? 'standee_character_01',
      face_emotion_variant_id: assetState?.face_emotion_variant_id ?? 'face_neutral'
    }
  };
}

function validatedParameterAttitudeType(characterId, value) {
  const normalized = String(value ?? '').trim();
  if (!parameterAttitudeTypes.includes(normalized)) {
    throw new Error(`invalid parameter_attitude_type for ${characterId}: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function normalizedCharacterParameters(characterId, parameters) {
  if (!parameters || typeof parameters !== 'object') {
    throw new Error(`missing parameters for ${characterId}`);
  }
  return normalizeParameters(parameters);
}

function normalizedSelectableCharacterProfile({ existingProfile, index }) {
  const characterId = characterIdForIndex(index);
  const visualSetId = visualSetIdForIndex(index);
  if (!existingProfile) {
    throw new Error(`missing selectable character profile: ${characterId}`);
  }
  const promptFallback = String(existingProfile.identity ?? '').trim();
  const speakingBasis = String(existingProfile.speaking_basis ?? '').trim();
  return {
    ...existingProfile,
    ...runtimeManagedProfileFields({
      characterId,
      visualSetId,
      assetState: existingProfile.asset_state
    }),
    prompt_description: sanitizePromptDescription(existingProfile.prompt_description, promptFallback),
    speaking_basis: speakingBasis,
    parameter_attitude_type: validatedParameterAttitudeType(characterId, existingProfile.parameter_attitude_type),
    parameters: normalizedCharacterParameters(characterId, existingProfile.parameters)
  };
}

async function loadSelectableCharacterProfile({ root, authoringRoot = root, index }) {
  const characterId = characterIdForIndex(index);
  const runtimeStorage = createStorageApi({ root });
  const authoringStorage = path.resolve(authoringRoot) === path.resolve(root)
    ? runtimeStorage
    : createStorageApi({ root: authoringRoot });
  const existingProfile = await runtimeStorage.readJsonIfExists(`game_data/characters/${characterId}/profile.json`)
    ?? await authoringStorage.readJsonIfExists(`game_data/characters/${characterId}/profile.json`);
  return normalizedSelectableCharacterProfile({ existingProfile, index });
}

async function ensureCharacterStorage({ root, authoringRoot = root, index }) {
  const characterId = characterIdForIndex(index);
  if (path.resolve(root) !== path.resolve(authoringRoot)) {
    const manifestPath = path.join(root, runtimePathsManifestFilename);
    const hasRuntimeManifest = await fs.access(manifestPath).then(() => true).catch(() => false);
    if (!hasRuntimeManifest) {
      await fs.mkdir(path.join(root, 'game_data'), { recursive: true });
      await writeRuntimePathsManifest({ root, sourceRoot: authoringRoot, mutableRoot: path.join(root, 'game_data') });
    }
  }
  const runtimeStorage = createStorageApi({ root });
  const authoringStorage = path.resolve(authoringRoot) === path.resolve(root)
    ? runtimeStorage
    : createStorageApi({ root: authoringRoot });
  const existingProfile = await authoringStorage.readJsonIfExists(`game_data/characters/${characterId}/profile.json`);
  const profile = normalizedSelectableCharacterProfile({ existingProfile, index });

  const { flags, skills } = await ensureCharacterMutableSurface({ root, characterId });
  return { profile, flags, skills };
}

function buddyFlagId(characterId) {
  return `relationship.${characterId}.buddy`;
}

function enemyFlagId(characterId) {
  return `relationship.${characterId}.enemy`;
}

function currentBuddyCharacterIdFromState(state) {
  const explicit = String(state?.current_buddy_character_id ?? '').trim();
  return explicit || null;
}

function currentEnemyCharacterIdsFromState(state) {
  return new Set((Array.isArray(state?.current_enemy_character_ids) ? state.current_enemy_character_ids : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean));
}

function characterSummary({ profile, currentBuddyCharacterId, currentEnemyCharacterIds, index, sceneStandeeFilename }) {
  const visualSetId = profile.visual_set_id ?? visualSetIdForIndex(index);
  const isBuddy = profile.character_id === currentBuddyCharacterId;
  const isEnemy = currentEnemyCharacterIds.has(profile.character_id);
  const buddyFlags = isBuddy ? [buddyFlagId(profile.character_id)] : [];
  const enemyFlags = isEnemy ? [enemyFlagId(profile.character_id)] : [];
  return {
    character_id: profile.character_id,
    display_name: profile.display_name,
    school_year: profile.school_year,
    club: profile.club,
    identity: profile.identity,
    speaking_basis: profile.speaking_basis,
    prompt_description: sanitizePromptDescription(profile.prompt_description, profile.identity ?? ''),
    parameter_attitude_type: validatedParameterAttitudeType(profile.character_id, profile.parameter_attitude_type),
    parameters: normalizedCharacterParameters(profile.character_id, profile.parameters),
    visual_set_id: visualSetId,
    identity_notes: '',
    is_buddy: buddyFlags.length > 0,
    buddy_flags: buddyFlags,
    is_enemy: enemyFlags.length > 0,
    enemy_flags: enemyFlags,
    available_expressions: Array.isArray(profile.available_expressions) ? profile.available_expressions : faceExpressions,
    asset_pack: 'assets_v5',
    source_image_url: publicCanonicalFaceUrl(visualSetId, 'neutral'),
    standee_url: publicCanonicalSceneStandeeUrl(visualSetId, sceneStandeeFilename),
    face_url: publicCanonicalFaceUrl(visualSetId, 'neutral'),
    selection_icon_url: publicCanonicalFaceUrl(visualSetId, 'neutral')
  };
}

export async function listSelectableCharacters({ root, authoringRoot = root } = {}) {
  const runtimeStorage = createStorageApi({ root });
  const state = await runtimeStorage.readJsonIfExists('game_data/runtime_state.json');
  const currentBuddyCharacterId = currentBuddyCharacterIdFromState(state);
  const currentEnemyCharacterIds = currentEnemyCharacterIdsFromState(state);
  const characters = [];
  for (let index = 1; index <= characterCount; index += 1) {
    const visualSetId = visualSetIdForIndex(index);
    const profile = await loadSelectableCharacterProfile({ root, authoringRoot, index });
    const sceneStandeeFilename = await sceneStandeeFilenameFromManifest({ root, visualSetId });
    characters.push(characterSummary({ profile, currentBuddyCharacterId, currentEnemyCharacterIds, index, sceneStandeeFilename }));
  }
  return characters;
}

// Lightweight { id, display_name } list of the whole selectable roster, without
// the visual-set/standee resolution that listSelectableCharacters does. Used by
// the Starfall Festival start descriptor to offer companion choices.
export async function listSelectableCharacterChoices({ root, authoringRoot = root } = {}) {
  const choices = [];
  for (let index = 1; index <= characterCount; index += 1) {
    const profile = await loadSelectableCharacterProfile({ root, authoringRoot, index });
    choices.push({ id: profile.character_id, display_name: profile.display_name });
  }
  return choices;
}

// { id, display_name } for one selectable character. Fail-fast on any id that is
// not character_001..character_127 (lina / routing persona is rejected here).
export async function selectableCharacterChoice({ root, authoringRoot = root, characterId }) {
  const index = characterIndexFromId(characterId);
  const profile = await loadSelectableCharacterProfile({ root, authoringRoot, index });
  return { id: profile.character_id, display_name: profile.display_name };
}

export async function ensureSelectableCharacterStorage({ root, authoringRoot = root, characterId }) {
  return await ensureCharacterStorage({ root, authoringRoot, index: characterIndexFromId(characterId) });
}

// The full normalized conversation profile for one selectable character — the SAME shape listSelectableCharacters
// resolves (display_name / school_year / club / prompt_description / speaking_basis / parameter_attitude_type /
// normalized parameters / character_id), WITHOUT the visual-set/standee manifest read. A caller that assembles a
// selectable character into a 昼会話 full prompt (the 談話室 group turn) uses this so buildCharacterPrompt receives a
// profile identical to the 1:1 path's. Runtime overlay is read first then the authoring source, the same order
// loadSelectableCharacterProfile uses. Fail-fast on any id that is not a selectable character.
export async function selectableCharacterPromptProfile({ root, authoringRoot = root, characterId }) {
  const index = characterIndexFromId(characterId);
  return loadSelectableCharacterProfile({ root, authoringRoot, index });
}

// { character_id, display_name, face_url } for one selectable character, without the full roster's
// standee/parameter resolution. Fail-fast on any id that is not character_001..character_127. Used by the
// current-buddy display contract so a selectable buddy resolves the same display fields a homunculus buddy
// does.
export async function selectableCharacterDisplaySummary({ root, authoringRoot = root, characterId }) {
  const index = characterIndexFromId(characterId);
  const profile = await loadSelectableCharacterProfile({ root, authoringRoot, index });
  const visualSetId = profile.visual_set_id ?? visualSetIdForIndex(index);
  return {
    character_id: profile.character_id,
    display_name: profile.display_name,
    face_url: publicCanonicalFaceUrl(visualSetId, 'neutral')
  };
}

// The conversation-persona fields for one selectable character — display_name / school_year / identity /
// prompt_description / speaking_basis — WITHOUT the visual-set/standee/parameter resolution the full roster does.
// A caller that only injects a character into a prompt (the auction reaction / bid turns) uses this so it never
// drags in the visual-set manifest read. Fail-fast on any id that is not a selectable character.
export async function selectableCharacterPersona({ root, authoringRoot = root, characterId }) {
  const index = characterIndexFromId(characterId);
  const profile = await loadSelectableCharacterProfile({ root, authoringRoot, index });
  return {
    character_id: profile.character_id,
    display_name: profile.display_name,
    school_year: profile.school_year,
    identity: profile.identity,
    prompt_description: profile.prompt_description,
    speaking_basis: profile.speaking_basis
  };
}

export async function updateCharacterProfileText({ root, characterId, promptDescription, speakingBasis }) {
  const { profile } = await ensureSelectableCharacterStorage({ root, characterId });
  const storage = createStorageApi({ root });
  const nextProfile = {
    ...profile,
    visual_rebuild_version: visualRebuildVersion,
    available_expressions: faceExpressions,
    prompt_description: sanitizePromptDescription(promptDescription, profile.identity ?? ''),
    speaking_basis: String(speakingBasis ?? profile.speaking_basis ?? '').trim(),
    parameters: normalizedCharacterParameters(characterId, profile.parameters)
  };
  await storage.writeJson(`game_data/characters/${characterId}/profile.json`, nextProfile);
  return nextProfile;
}

export async function updateCharacterPromptDescription({ root, characterId, promptDescription }) {
  return updateCharacterProfileText({ root, characterId, promptDescription });
}

function clampParameterValue(value) {
  const number = Number(value ?? 0);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? Math.round(number) : 0));
}

// Applies a list of parameter effects ({ group, key, amount }) to one selectable character's per-slot
// parameters. The runtime profile (game_data/characters/<id>/profile.json) is read with priority over the
// authoring baseline, so repeated boosts accumulate; each targeted parameter must already exist (fail-fast,
// no silent slot creation) and the result is clamped to [0,100]. The whole profile is written back
// preserving every other field, so listSelectableCharacters (which reads runtime-first) reflects the change
// on the next roster read. Returns the per-effect before/after report and the prior profile so an atomic
// caller can roll the write back on failure. A non-selectable character id (lina / persona / creature /
// homunculus) fails fast via characterIndexFromId.
export async function applyCharacterParameterEffects({ root, authoringRoot = root, characterId, parameterEffects }) {
  if (!root) throw new Error('root is required');
  characterIndexFromId(characterId);
  if (!Array.isArray(parameterEffects) || parameterEffects.length === 0) {
    throw new Error('parameterEffects must be a non-empty array');
  }
  const runtimeStorage = createStorageApi({ root });
  const authoringStorage = path.resolve(authoringRoot) === path.resolve(root)
    ? runtimeStorage
    : createStorageApi({ root: authoringRoot });
  const profileRelativePath = `game_data/characters/${characterId}/profile.json`;
  const priorProfile = await runtimeStorage.readJsonIfExists(profileRelativePath)
    ?? await authoringStorage.readJsonIfExists(profileRelativePath);
  if (!priorProfile) throw new Error(`missing selectable character profile: ${characterId}`);

  const nextParameters = normalizedCharacterParameters(characterId, priorProfile.parameters);
  const effects = parameterEffects.map((effect) => {
    const slot = nextParameters?.[effect.group]?.[effect.key];
    if (!slot || typeof slot !== 'object') {
      throw new Error(`character parameter is missing: ${effect.group}.${effect.key}`);
    }
    if (!Number.isInteger(effect.amount)) throw new Error(`parameter effect amount must be an integer: ${effect.group}.${effect.key}`);
    const before = clampParameterValue(slot.value);
    const after = clampParameterValue(before + effect.amount);
    nextParameters[effect.group][effect.key] = { ...slot, value: after };
    return { group: effect.group, key: effect.key, label: slot.label, amount: effect.amount, before, after };
  });

  const nextProfile = { ...priorProfile, parameters: nextParameters };
  await runtimeStorage.writeJson(profileRelativePath, nextProfile);
  return {
    character_id: characterId,
    parameters: nextParameters,
    effects,
    prior_profile: priorProfile,
    profile_relative_path: profileRelativePath
  };
}
