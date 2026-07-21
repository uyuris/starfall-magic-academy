import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { isSelectableCharacterId } from './characterCatalog.mjs';
import { trainingDefinitions } from './training.mjs';

export const STUDY_CIRCLE_DEFINITIONS_FILENAME = 'study_circles.json';

const MIN_HOST_CANDIDATES = 3;
const trainingById = new Map(trainingDefinitions.map((definition) => [definition.id, definition]));

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function selectableCharacterId(value, label) {
  const normalized = requiredString(value, label);
  if (!isSelectableCharacterId(normalized)) throw new Error(`${label} must be a selectable character_001..127 id: ${normalized}`);
  return normalized;
}

function validateStudyCircleDefinition(entry, index) {
  const value = requiredObject(entry, `study circle definition[${index}]`);
  const themeId = requiredString(value.theme_id, `study circle definition[${index}].theme_id`);
  if (!Array.isArray(value.host_candidate_ids)) {
    throw new Error(`${themeId}.host_candidate_ids must be an array`);
  }
  if (value.host_candidate_ids.length < MIN_HOST_CANDIDATES) {
    throw new Error(`${themeId}.host_candidate_ids must contain at least three selectable characters`);
  }

  const seenHosts = new Set();
  const hostCandidateIds = value.host_candidate_ids.map((hostId, hostIndex) => {
    const normalized = selectableCharacterId(hostId, `${themeId}.host_candidate_ids[${hostIndex}]`);
    if (seenHosts.has(normalized)) throw new Error(`duplicate host_candidate_id in ${themeId}: ${normalized}`);
    seenHosts.add(normalized);
    return normalized;
  });

  return {
    theme_id: themeId,
    venue: requiredString(value.venue, `${themeId}.venue`),
    host_candidate_ids: hostCandidateIds
  };
}

export function validateStudyCircleDefinitions(value) {
  if (!Array.isArray(value)) throw new Error('study circle definitions must be an array');
  const normalized = value.map(validateStudyCircleDefinition);
  const byThemeId = new Map();
  for (const definition of normalized) {
    if (byThemeId.has(definition.theme_id)) throw new Error(`duplicate study circle theme_id: ${definition.theme_id}`);
    byThemeId.set(definition.theme_id, definition);
  }

  const expectedThemeIds = new Set(trainingDefinitions.map((definition) => definition.id));
  const actualThemeIds = new Set(byThemeId.keys());
  const missing = [...expectedThemeIds].filter((themeId) => !actualThemeIds.has(themeId));
  const extra = [...actualThemeIds].filter((themeId) => !expectedThemeIds.has(themeId));
  if (missing.length > 0 || extra.length > 0 || actualThemeIds.size !== expectedThemeIds.size) {
    throw new Error(`study circle theme set must match training definitions exactly; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }

  return trainingDefinitions.map((training) => byThemeId.get(training.id));
}

async function displayNameForHost(storage, characterId) {
  const profile = requiredObject(
    await storage.readJson(`game_data/characters/${characterId}/profile.json`),
    `${characterId} profile`
  );
  if (Object.hasOwn(profile, 'character_id') && profile.character_id !== characterId) {
    throw new Error(`study circle host profile id mismatch: ${characterId} != ${profile.character_id}`);
  }
  return requiredString(profile.display_name, `${characterId}.display_name`);
}

async function attachHostCandidates({ storage, definitions }) {
  const displayNames = new Map();
  for (const characterId of new Set(definitions.flatMap((definition) => definition.host_candidate_ids))) {
    displayNames.set(characterId, await displayNameForHost(storage, characterId));
  }
  return definitions.map((definition) => ({
    ...definition,
    host_candidates: definition.host_candidate_ids.map((characterId) => ({
      character_id: characterId,
      display_name: displayNames.get(characterId)
    }))
  }));
}

export async function loadStudyCircleDefinitions({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const definitionsPath = path.join(storage.paths.definitionsRoot, STUDY_CIRCLE_DEFINITIONS_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(definitionsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`study circle definitions file is missing: ${definitionsPath}`);
    throw error;
  }
  return await attachHostCandidates({
    storage,
    definitions: validateStudyCircleDefinitions(JSON.parse(raw))
  });
}

export function studyCircleTrainingDefinition(themeId) {
  const normalizedThemeId = requiredString(themeId, 'theme_id');
  const training = trainingById.get(normalizedThemeId);
  if (!training) throw new Error(`unknown study circle theme_id: ${normalizedThemeId}`);
  return training;
}
