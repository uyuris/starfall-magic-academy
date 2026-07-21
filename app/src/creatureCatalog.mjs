import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { ensureCreatureMutableSurface, writeRuntimePathsManifest } from './runtimeSlotBootstrap.mjs';
import { runtimePathsManifestFilename } from './runtimePaths.mjs';
import { faceExpressions } from './faceExpressions.mjs';
import { normalizeParameters, magicParameterDefinitions, abilityParameterDefinitions } from './parameters.mjs';

export const creatureCount = 15;

const parameterAttitudeTypes = [
  'respect_any_superior',
  'equal_any_respect_average',
  'equal_average_respect_1_2',
  'equal_1_2_respect_1_5'
];

function validatedParameterAttitudeType(creatureId, value) {
  const normalized = String(value ?? '').trim();
  if (!parameterAttitudeTypes.includes(normalized)) {
    throw new Error(`invalid parameter_attitude_type for ${creatureId}: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function assertCompleteParameterGroup(creatureId, groupName, definitions, values) {
  for (const definition of definitions) {
    const raw = values?.[definition.key];
    const value = typeof raw === 'object' && raw !== null && 'value' in raw ? raw.value : raw;
    if (!Number.isFinite(Number(value))) {
      throw new Error(`missing ${groupName} parameter ${definition.key} for ${creatureId}`);
    }
  }
}

function normalizedCreatureParameters(creatureId, parameters) {
  if (!parameters || typeof parameters !== 'object') {
    throw new Error(`missing parameters for ${creatureId}`);
  }
  // normalizeParameters() zero-fills any absent key via its fallbackValue, which would
  // silently invent stats. Reject incomplete groups first so partial omissions fail fast.
  assertCompleteParameterGroup(creatureId, 'magic', magicParameterDefinitions, parameters.magic);
  assertCompleteParameterGroup(creatureId, 'abilities', abilityParameterDefinitions, parameters.abilities);
  return normalizeParameters(parameters);
}

function pad(index) {
  return String(index).padStart(3, '0');
}

function formattedCreatureIdForIndex(index) {
  const parsed = Number(index);
  if (Number.isInteger(parsed) && parsed >= 0) return `creature_${pad(parsed)}`;
  return `creature_${String(index)}`;
}

export function creatureIdForIndex(index) {
  const parsed = Number(index);
  const creatureId = formattedCreatureIdForIndex(index);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > creatureCount) {
    throw new Error(`unknown creature: ${creatureId}`);
  }
  return creatureId;
}

export function visualSetIdForCreature(index) {
  return creatureIdForIndex(index);
}

export function creatureIndexFromId(creatureId) {
  const normalizedCreatureId = String(creatureId ?? '').trim();
  const match = /^creature_(\d{3})$/.exec(normalizedCreatureId);
  if (!match) throw new Error(`unknown creature: ${normalizedCreatureId || '(empty)'}`);
  const index = Number.parseInt(match[1], 10);
  if (!Number.isInteger(index) || index < 1 || index > creatureCount) {
    throw new Error(`unknown creature: ${normalizedCreatureId}`);
  }
  return index;
}

export function isCreatureId(creatureId) {
  try {
    creatureIndexFromId(creatureId);
    return true;
  } catch {
    return false;
  }
}

function publicCanonicalUrl(relativePath) {
  return `/canonical/${relativePath.split(path.sep).join('/')}`;
}

function publicCanonicalFaceUrl(visualSetId, expression = 'neutral') {
  return publicCanonicalUrl(`character_visual_sets/${visualSetId}/face_emotions/${expression}.jpg`);
}

function publicCanonicalSceneStandeeUrl(visualSetId, filename) {
  return publicCanonicalUrl(`character_visual_sets/${visualSetId}/scene_standee/${filename}`);
}

async function sceneStandeeFilenameFromManifest({ root, visualSetId }) {
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

function normalizedCreatureProfile({ existingProfile, index }) {
  const creatureId = creatureIdForIndex(index);
  if (!existingProfile) {
    throw new Error(`missing creature profile: ${creatureId}`);
  }
  const profileCreatureId = String(existingProfile.character_id ?? '').trim();
  if (profileCreatureId !== creatureId) {
    throw new Error(`invalid creature profile id for ${creatureId}: ${profileCreatureId || '(empty)'}`);
  }
  const visualSetId = visualSetIdForCreature(index);
  return {
    ...existingProfile,
    character_id: creatureId,
    parameter_attitude_type: validatedParameterAttitudeType(creatureId, existingProfile.parameter_attitude_type),
    parameters: normalizedCreatureParameters(creatureId, existingProfile.parameters),
    visual_set_id: visualSetId,
    source_image: `character_visual_sets/${visualSetId}/face_emotions/neutral.jpg`,
    asset_pack: 'assets_v5',
    available_expressions: faceExpressions
  };
}

async function loadCreatureProfile({ root, authoringRoot = root, index }) {
  const creatureId = creatureIdForIndex(index);
  const runtimeStorage = createStorageApi({ root });
  const authoringStorage = path.resolve(authoringRoot) === path.resolve(root)
    ? runtimeStorage
    : createStorageApi({ root: authoringRoot });
  const existingProfile = await runtimeStorage.readJsonIfExists(`game_data/creatures/${creatureId}/profile.json`)
    ?? await authoringStorage.readJsonIfExists(`game_data/creatures/${creatureId}/profile.json`);
  return normalizedCreatureProfile({ existingProfile, index });
}

async function validateCreatureContentDirectories(storage) {
  let entries = [];
  try {
    entries = await fs.readdir(storage.paths.creatureContentRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`missing creature content root: ${storage.paths.creatureContentRoot}`);
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    creatureIndexFromId(entry.name);
  }
}

export function creatureSummary({ profile, index, sceneStandeeFilename }) {
  creatureIdForIndex(index);
  const visualSetId = String(profile?.visual_set_id ?? '').trim();
  if (!visualSetId) {
    throw new Error(`missing creature visual_set_id: ${profile?.character_id ?? '(unknown creature)'}`);
  }
  if (!sceneStandeeFilename) {
    throw new Error(`missing creature scene standee filename: ${profile?.character_id ?? '(unknown creature)'}`);
  }
  const faceUrl = publicCanonicalFaceUrl(visualSetId, 'neutral');
  return {
    character_id: profile.character_id,
    display_name: profile.display_name,
    kind: profile.kind,
    kind_label: profile.kind_label,
    identity: profile.identity,
    speaking_basis: profile.speaking_basis,
    parameter_attitude_type: validatedParameterAttitudeType(profile.character_id, profile.parameter_attitude_type),
    parameters: normalizedCreatureParameters(profile.character_id, profile.parameters),
    visual_set_id: visualSetId,
    available_expressions: profile.available_expressions,
    asset_pack: profile.asset_pack,
    source_image_url: faceUrl,
    standee_url: publicCanonicalSceneStandeeUrl(visualSetId, sceneStandeeFilename),
    face_url: faceUrl,
    selection_icon_url: faceUrl
  };
}

function requiredCreatureSummaryText(summary, field, creatureId) {
  const value = String(summary?.[field] ?? '').trim();
  if (!value) throw new Error(`missing creature summary ${field}: ${creatureId}`);
  return value;
}

export async function creatureEncounterSummary({ root, authoringRoot = root, creatureId } = {}) {
  if (!root) throw new Error('root is required');
  const index = creatureIndexFromId(creatureId);
  const profile = await loadCreatureProfile({ root, authoringRoot, index });
  const sceneStandeeFilename = await sceneStandeeFilenameFromManifest({ root, visualSetId: profile.visual_set_id });
  const summary = creatureSummary({
    profile,
    index,
    sceneStandeeFilename
  });
  const normalizedCreatureId = requiredCreatureSummaryText(summary, 'character_id', creatureId);
  return {
    creature_id: normalizedCreatureId,
    display_name: requiredCreatureSummaryText(summary, 'display_name', normalizedCreatureId),
    kind: requiredCreatureSummaryText(summary, 'kind', normalizedCreatureId),
    kind_label: requiredCreatureSummaryText(summary, 'kind_label', normalizedCreatureId),
    parameter_attitude_type: validatedParameterAttitudeType(normalizedCreatureId, summary.parameter_attitude_type),
    parameters: normalizedCreatureParameters(normalizedCreatureId, summary.parameters),
    visual_set_id: requiredCreatureSummaryText(summary, 'visual_set_id', normalizedCreatureId),
    face_url: requiredCreatureSummaryText(summary, 'face_url', normalizedCreatureId),
    standee_url: requiredCreatureSummaryText(summary, 'standee_url', normalizedCreatureId)
  };
}

export async function listCreatures({ root, authoringRoot = root } = {}) {
  const authoringStorage = createStorageApi({ root: authoringRoot });
  await validateCreatureContentDirectories(authoringStorage);
  const creatures = [];
  for (let index = 1; index <= creatureCount; index += 1) {
    const profile = await loadCreatureProfile({ root, authoringRoot, index });
    const sceneStandeeFilename = await sceneStandeeFilenameFromManifest({ root, visualSetId: profile.visual_set_id });
    creatures.push(creatureSummary({ profile, index, sceneStandeeFilename }));
  }
  return creatures;
}

// Every creature in the same normalized `creature_id`-keyed shape that
// `creatureEncounterSummary` produces for a single encounter (the shape the field
// payload's `creature_summary` carries). Used to list the full creature roster for
// the debug field screen independently of any encounter; each entry is validated
// and fails fast on a malformed profile rather than being zero-filled.
export async function listCreatureEncounterSummaries({ root, authoringRoot = root } = {}) {
  if (!root) throw new Error('root is required');
  const authoringStorage = createStorageApi({ root: authoringRoot });
  await validateCreatureContentDirectories(authoringStorage);
  const summaries = [];
  for (let index = 1; index <= creatureCount; index += 1) {
    summaries.push(await creatureEncounterSummary({ root, authoringRoot, creatureId: creatureIdForIndex(index) }));
  }
  return summaries;
}

export async function ensureCreatureStorage({ root, authoringRoot = root, creatureId }) {
  const index = creatureIndexFromId(creatureId);
  if (path.resolve(root) !== path.resolve(authoringRoot)) {
    const manifestPath = path.join(root, runtimePathsManifestFilename);
    const hasRuntimeManifest = await fs.access(manifestPath).then(() => true).catch(() => false);
    if (!hasRuntimeManifest) {
      await fs.mkdir(path.join(root, 'game_data'), { recursive: true });
      await writeRuntimePathsManifest({ root, sourceRoot: authoringRoot, mutableRoot: path.join(root, 'game_data') });
    }
  }
  const profile = await loadCreatureProfile({ root, authoringRoot, index });
  const { flags, skills } = await ensureCreatureMutableSurface({ root, creatureId: creatureIdForIndex(index) });
  return { profile, flags, skills };
}
