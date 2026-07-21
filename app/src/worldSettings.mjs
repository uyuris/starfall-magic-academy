import path from 'node:path';
import { promises as fs } from 'node:fs';

import { defaultPlayerParameters, normalizeParameters } from './parameters.mjs';
import { createStorageApi } from './storage.mjs';

const worldSettingsPath = 'game_data/world/settings.json';
const playerParametersPath = 'game_data/runtime/player_parameters.json';
const runtimeStatePath = 'game_data/runtime_state.json';

const defaultWorldDescription = '星灯魔法学院は、星明かりを魔力へ変換する塔を中心にした全寮制の魔法学院。古書、薬草、天体観測、精霊との契約が日常の授業と事件に結びついている。';
const defaultPlayerName = '主人公';
const defaultAcademyName = '星灯魔法学院';

function normalizePlayerName(value) {
  const name = String(value ?? '').trim();
  return name || defaultPlayerName;
}

async function readJsonIfExists(storage, relativePath) {
  return storage.readJsonIfExists(relativePath);
}

async function writeJson(storage, relativePath, value) {
  await storage.writeJson(relativePath, value);
}

function normalizeWorldConditionTexts(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const id = String(entry?.id ?? '').trim();
    const normalized = {
      required_global_flags: Array.isArray(entry?.required_global_flags)
        ? entry.required_global_flags.map((flag) => String(flag ?? '').trim()).filter(Boolean)
        : [],
      excluded_global_flags: Array.isArray(entry?.excluded_global_flags)
        ? entry.excluded_global_flags.map((flag) => String(flag ?? '').trim()).filter(Boolean)
        : [],
      text: String(entry?.text ?? '').trim()
    };
    if (id) normalized.id = id;
    return normalized;
  }).filter((entry) => entry.required_global_flags.length > 0 && entry.text);
}

function normalizeWorldStaticSettings(value = {}) {
  return {
    academy_name: String(value?.academy_name ?? defaultAcademyName).trim() || defaultAcademyName,
    player_name: normalizePlayerName(value?.player_name),
    world_description: value?.world_description == null
      ? defaultWorldDescription
      : String(value.world_description).trim(),
    world_condition_texts: normalizeWorldConditionTexts(value?.world_condition_texts)
  };
}

function normalizeWorldOverride(value = {}) {
  const override = {};
  if (Object.hasOwn(value, 'academy_name')) {
    override.academy_name = String(value.academy_name ?? '').trim() || defaultAcademyName;
  }
  if (Object.hasOwn(value, 'player_name')) {
    override.player_name = normalizePlayerName(value.player_name);
  }
  if (Object.hasOwn(value, 'world_description')) {
    override.world_description = String(value.world_description ?? '').trim();
  }
  if (Object.hasOwn(value, 'world_condition_texts')) {
    override.world_condition_texts = normalizeWorldConditionTexts(value.world_condition_texts);
  }
  return override;
}

function mergeWorldStaticSettings(canonical, override) {
  const merged = { ...canonical };
  for (const [key, value] of Object.entries(normalizeWorldOverride(override ?? {}))) {
    merged[key] = value;
  }
  return normalizeWorldStaticSettings(merged);
}

function worldOverridePath(storage) {
  return path.join(storage.paths.configRoot, 'world/settings.json');
}

function definitionsWorldSettingsPath(storage) {
  return path.join(storage.paths.definitionsRoot, 'world/settings.json');
}

async function readWorldSettingsFileIfExists(fullPath) {
  try {
    return JSON.parse(await fs.readFile(fullPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCanonicalWorldSettings(storage) {
  const raw = await readWorldSettingsFileIfExists(definitionsWorldSettingsPath(storage));
  return normalizeWorldStaticSettings(raw ?? {});
}

async function readWorldSettingsOverride(storage) {
  const raw = await readWorldSettingsFileIfExists(worldOverridePath(storage));
  if (!raw) return null;
  return normalizeWorldOverride(raw);
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildWorldSettingsOverride(canonical, nextSettings) {
  const normalizedCanonical = normalizeWorldStaticSettings(canonical ?? {});
  const normalizedNext = normalizeWorldStaticSettings(nextSettings ?? {});
  const override = {};
  for (const key of ['academy_name', 'player_name', 'world_description', 'world_condition_texts']) {
    if (!sameJsonValue(normalizedCanonical[key], normalizedNext[key])) {
      override[key] = normalizedNext[key];
    }
  }
  return override;
}

async function writeWorldSettingsOverride(storage, override) {
  const fullPath = worldOverridePath(storage);
  const normalizedOverride = normalizeWorldOverride(override ?? {});
  if (Object.keys(normalizedOverride).length === 0) {
    await fs.rm(fullPath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(normalizedOverride, null, 2)}\n`, 'utf8');
}

async function writeDefinitionsWorldSettings(storage, value) {
  const fullPath = definitionsWorldSettingsPath(storage);
  const normalized = normalizeWorldStaticSettings(value);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function activeWorldDescription(baseDescription, conditionTexts, state) {
  const globalFlags = state?.global_flags ?? {};
  const additions = normalizeWorldConditionTexts(conditionTexts)
    .filter((entry) => entry.required_global_flags.every((flag) => globalFlags[flag] === true))
    .filter((entry) => entry.excluded_global_flags.every((flag) => globalFlags[flag] !== true))
    .map((entry) => entry.text);
  return [String(baseDescription ?? '').trim(), ...additions].filter(Boolean).join('\n');
}

export async function loadWorldSettings({ root, state = null } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const [canonicalSettings, overrideSettings, mutablePlayerParameters, runtimeState] = await Promise.all([
    readCanonicalWorldSettings(storage),
    readWorldSettingsOverride(storage),
    readJsonIfExists(storage, playerParametersPath),
    state ?? readJsonIfExists(storage, runtimeStatePath)
  ]);
  const staticSettings = mergeWorldStaticSettings(canonicalSettings, overrideSettings);
  const playerParameters = normalizeParameters(mutablePlayerParameters ?? defaultPlayerParameters());
  return {
    ...staticSettings,
    world_description_base: staticSettings.world_description,
    world_description: activeWorldDescription(staticSettings.world_description, staticSettings.world_condition_texts, runtimeState),
    world_condition_texts: normalizeWorldConditionTexts(staticSettings.world_condition_texts),
    player_parameters: playerParameters
  };
}

export async function updatePlayerParameters({ root, playerParameters } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const current = await loadWorldSettings({ root });
  const nextPlayerParameters = normalizeParameters(playerParameters ?? current.player_parameters);
  await writeJson(storage, playerParametersPath, nextPlayerParameters);
  return { ...current, player_parameters: nextPlayerParameters };
}

export async function updateWorldDescription({ root, worldDescription, playerName, persistToDefinitions = false } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const [current, canonicalSettings] = await Promise.all([
    loadWorldSettings({ root }),
    readCanonicalWorldSettings(storage)
  ]);
  const staticSettings = normalizeWorldStaticSettings({
    academy_name: current.academy_name,
    player_name: playerName ?? current.player_name,
    world_description: worldDescription ?? current.world_description_base,
    world_condition_texts: current.world_condition_texts
  });
  if (persistToDefinitions) {
    await writeDefinitionsWorldSettings(storage, staticSettings);
  } else {
    const override = buildWorldSettingsOverride(canonicalSettings, staticSettings);
    await writeWorldSettingsOverride(storage, override);
  }
  return { ...staticSettings, player_parameters: current.player_parameters };
}
