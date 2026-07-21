import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { createRuntimePaths, defaultRuntimePaths, runtimePathsManifestFilename } from './runtimePaths.mjs';
import { routingReadPostFence, routingReadPreFence } from './routingFinalizeQueue.mjs';

export const projectRoot = defaultRuntimePaths.projectRoot;
export const gameDataRoot = path.join(projectRoot, 'game_data');

function withTrailingSep(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function pathExists(fullPath) {
  return fs.access(fullPath).then(() => true).catch(() => false);
}

function defaultFlagsFor(characterId) {
  return { character_id: characterId, flags: {} };
}

function defaultSkillsFor(characterId) {
  return { character_id: characterId, skills: [] };
}

function loadRuntimePathsManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, runtimePathsManifestFilename);
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function findNearestRuntimePathsManifest(startRoot) {
  let current = path.resolve(startRoot);
  while (true) {
    const manifest = loadRuntimePathsManifest(current);
    if (manifest) return { projectRoot: current, manifest };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizePaths({ root, ...paths } = {}) {
  const explicitProjectRoot = root ?? paths.projectRoot;
  const resolvedProjectRoot = path.resolve(explicitProjectRoot ?? defaultRuntimePaths.projectRoot);
  const legacyGameDataRoot = path.join(resolvedProjectRoot, 'game_data');
  const useLegacyProjectLayout = root != null && existsSync(legacyGameDataRoot);
  if (useLegacyProjectLayout) {
    const inheritedRuntime = findNearestRuntimePathsManifest(resolvedProjectRoot);
    if (inheritedRuntime) {
      const { manifest } = inheritedRuntime;
      const resourceRoot = path.resolve(paths.resourceRoot ?? manifest.resourceRoot);
      return {
        projectRoot: resolvedProjectRoot,
        configRoot: path.resolve(paths.configRoot ?? manifest.configRoot),
        definitionsRoot: path.resolve(paths.definitionsRoot ?? manifest.definitionsRoot),
        seedsRoot: path.resolve(paths.seedsRoot ?? manifest.seedsRoot),
        mutableRoot: legacyGameDataRoot,
        characterContentRoot: path.resolve(paths.characterContentRoot ?? manifest.characterContentRoot),
        creatureContentRoot: path.resolve(paths.creatureContentRoot ?? manifest.creatureContentRoot ?? path.join(resourceRoot, 'content/creatures')),
        canonicalAssetsRoot: path.resolve(paths.canonicalAssetsRoot ?? manifest.canonicalAssetsRoot),
        publicRoot: path.resolve(paths.publicRoot ?? manifest.publicRoot),
        resourceRoot
      };
    }
    return {
      projectRoot: resolvedProjectRoot,
      configRoot: path.join(resolvedProjectRoot, 'app', 'config'),
      definitionsRoot: legacyGameDataRoot,
      seedsRoot: legacyGameDataRoot,
      mutableRoot: legacyGameDataRoot,
      characterContentRoot: path.join(legacyGameDataRoot, 'characters'),
      creatureContentRoot: path.join(legacyGameDataRoot, 'creatures'),
      canonicalAssetsRoot: path.join(resolvedProjectRoot, 'assets', 'canonical'),
      publicRoot: path.join(resolvedProjectRoot, 'app', 'public'),
      resourceRoot: resolvedProjectRoot
    };
  }
  const manifest = loadRuntimePathsManifest(resolvedProjectRoot);
  if (manifest) {
    const resourceRoot = path.resolve(paths.resourceRoot ?? manifest.resourceRoot);
    return {
      projectRoot: resolvedProjectRoot,
      configRoot: path.resolve(paths.configRoot ?? manifest.configRoot),
      definitionsRoot: path.resolve(paths.definitionsRoot ?? manifest.definitionsRoot),
      seedsRoot: path.resolve(paths.seedsRoot ?? manifest.seedsRoot),
      mutableRoot: path.resolve(paths.mutableRoot ?? manifest.mutableRoot),
      characterContentRoot: path.resolve(paths.characterContentRoot ?? manifest.characterContentRoot),
      creatureContentRoot: path.resolve(paths.creatureContentRoot ?? manifest.creatureContentRoot ?? path.join(resourceRoot, 'content/creatures')),
      canonicalAssetsRoot: path.resolve(paths.canonicalAssetsRoot ?? manifest.canonicalAssetsRoot),
      publicRoot: path.resolve(paths.publicRoot ?? manifest.publicRoot),
      resourceRoot
    };
  }
  const projectScopedDefaults = root != null
    ? createRuntimePaths({ projectRoot: resolvedProjectRoot })
    : defaultRuntimePaths;
  const resourceRoot = path.resolve(paths.resourceRoot ?? resolvedProjectRoot);
  return {
    projectRoot: resolvedProjectRoot,
    configRoot: path.resolve(paths.configRoot ?? projectScopedDefaults.configRoot),
    definitionsRoot: path.resolve(paths.definitionsRoot ?? projectScopedDefaults.definitionsRoot),
    seedsRoot: path.resolve(paths.seedsRoot ?? projectScopedDefaults.seedsRoot),
    mutableRoot: path.resolve(paths.mutableRoot ?? projectScopedDefaults.mutableRoot),
    characterContentRoot: path.resolve(paths.characterContentRoot ?? projectScopedDefaults.characterContentRoot),
    creatureContentRoot: path.resolve(paths.creatureContentRoot ?? path.join(resourceRoot, 'content/creatures')),
    canonicalAssetsRoot: path.resolve(paths.canonicalAssetsRoot ?? projectScopedDefaults.canonicalAssetsRoot),
    publicRoot: path.resolve(paths.publicRoot ?? projectScopedDefaults.publicRoot),
    resourceRoot
  };
}

function resolveCharacterContentPath(paths, characterId, filename) {
  return path.join(paths.characterContentRoot, characterId, filename);
}

function resolveMutableCharacterPath(paths, characterId, relativePath) {
  return path.join(paths.mutableRoot, 'characters', characterId, relativePath);
}

function isMutableCharacterLeaf(leaf) {
  return leaf === 'skills.json'
    || leaf === 'flags.json'
    || leaf === 'affinity.json'
    || leaf === 'memory'
    || leaf.startsWith(`memory${path.sep}`)
    || leaf === 'work_records'
    || leaf.startsWith(`work_records${path.sep}`);
}

function isMutableCreatureLeaf(leaf) {
  return leaf === 'skills.json'
    || leaf === 'flags.json'
    || leaf === 'memory'
    || leaf.startsWith(`memory${path.sep}`)
    || leaf === 'work_records'
    || leaf.startsWith(`work_records${path.sep}`);
}

function isLegacyGameDataPath(relativePath) {
  return relativePath === 'game_data' || relativePath.startsWith(`game_data${path.sep}`) || relativePath.startsWith('game_data/');
}

function splitLegacyGameDataPath(relativePath) {
  if (!isLegacyGameDataPath(relativePath)) return null;
  const normalized = relativePath.split('/').join(path.sep);
  if (normalized === 'game_data') return '';
  return normalized.replace(/^game_data[\\/]/, '');
}

function invalidStoragePathError(relativePath, baseRoot) {
  const error = new Error(`resolved path escapes storage surface: ${relativePath} -> ${baseRoot}`);
  error.code = 'INVALID_STORAGE_PATH';
  error.errorCode = 'invalid_storage_path';
  error.statusCode = 400;
  return error;
}

function resolveWithinBase(baseRoot, relativePath) {
  const resolvedBase = path.resolve(baseRoot);
  const resolvedPath = path.resolve(resolvedBase, relativePath ?? '.');
  const relativeToBase = path.relative(resolvedBase, resolvedPath);
  if (relativeToBase === '' || (!relativeToBase.startsWith('..') && !path.isAbsolute(relativeToBase))) {
    return resolvedPath;
  }
  throw invalidStoragePathError(relativePath, resolvedBase);
}

async function resolveLegacyReadPath(paths, relativePath) {
  const rest = splitLegacyGameDataPath(relativePath);
  if (rest == null) return resolveWithinBase(paths.projectRoot, relativePath);
  if (!rest) return resolveWithinBase(paths.projectRoot, 'game_data');

  if (rest === 'locations.json' || rest === 'event_flags.json' || rest === 'stage_flags.json' || rest === 'shop_catalog.json' || rest === 'gathering_points.json' || rest === 'star_cradle_catalog.json' || rest.startsWith(`prompt${path.sep}`)) {
    return resolveWithinBase(paths.definitionsRoot, rest);
  }
  if (rest === path.join('world', 'settings.json')) {
    const configCandidate = resolveWithinBase(paths.configRoot, path.join('world', 'settings.json'));
    if (await pathExists(configCandidate)) return configCandidate;
    return resolveWithinBase(paths.definitionsRoot, rest);
  }
  if (rest === 'runtime_state.json' || rest === 'player_inventory.json' || rest === 'player_equipment.json' || rest === 'library_collection.json' || rest === 'homunculi.json' || rest === 'star_cradle.json' || rest === 'star_cradle_creatures.json' || rest === 'gathering_stock.json' || rest === 'mp_reserve.json' || rest === path.join('runtime', 'player_parameters.json')) {
    const mutableCandidate = resolveWithinBase(paths.mutableRoot, rest);
    if (await pathExists(mutableCandidate)) return mutableCandidate;
    return resolveWithinBase(paths.seedsRoot, rest);
  }
  if (rest.startsWith(`logs${path.sep}`)) {
    const mutableCandidate = resolveWithinBase(path.join(paths.mutableRoot, 'logs'), rest.slice(`logs${path.sep}`.length));
    if (await pathExists(mutableCandidate)) return mutableCandidate;
    return mutableCandidate;
  }
  if (rest.startsWith(`characters${path.sep}`)) {
    const [, characterId, ...segments] = rest.split(path.sep);
    const leaf = segments.join(path.sep);
    if (!characterId || !leaf) return resolveWithinBase(paths.projectRoot, relativePath);
    if (leaf === 'profile.json' || leaf === 'appearance.json') {
      return resolveWithinBase(path.join(paths.characterContentRoot, characterId), leaf);
    }
    if (isMutableCharacterLeaf(leaf)) {
      return resolveWithinBase(path.join(paths.mutableRoot, 'characters', characterId), leaf);
    }
  }
  if (rest.startsWith(`creatures${path.sep}`)) {
    const [, creatureId, ...segments] = rest.split(path.sep);
    const leaf = segments.join(path.sep);
    if (!creatureId || !leaf) return resolveWithinBase(paths.projectRoot, relativePath);
    if (leaf === 'profile.json' || leaf === 'appearance.json') {
      return resolveWithinBase(path.join(paths.creatureContentRoot, creatureId), leaf);
    }
    if (isMutableCreatureLeaf(leaf)) {
      return resolveWithinBase(path.join(paths.mutableRoot, 'creatures', creatureId), leaf);
    }
  }
  if (rest.startsWith(`homunculi${path.sep}`)) {
    // A homunculus actor directory is wholly per-slot mutable (no authored content root): every leaf
    // (profile/flags/skills/memory/work_records/affinity) resolves under the mutable root.
    const [, homunculusId, ...segments] = rest.split(path.sep);
    const leaf = segments.join(path.sep);
    if (!homunculusId || !leaf) return resolveWithinBase(paths.projectRoot, relativePath);
    return resolveWithinBase(path.join(paths.mutableRoot, 'homunculi', homunculusId), leaf);
  }
  return resolveWithinBase(paths.projectRoot, relativePath);
}

function resolveLegacyWritePath(paths, relativePath) {
  const rest = splitLegacyGameDataPath(relativePath);
  if (rest == null) return resolveWithinBase(paths.projectRoot, relativePath);
  if (!rest) return resolveWithinBase(paths.projectRoot, 'game_data');

  if (rest === 'locations.json' || rest === 'event_flags.json' || rest === 'stage_flags.json' || rest === 'shop_catalog.json' || rest === 'gathering_points.json' || rest === 'star_cradle_catalog.json' || rest.startsWith(`prompt${path.sep}`)) {
    return resolveWithinBase(paths.definitionsRoot, rest);
  }
  if (rest === path.join('world', 'settings.json')) {
    return resolveWithinBase(paths.configRoot, path.join('world', 'settings.json'));
  }
  if (rest === 'runtime_state.json' || rest === 'player_inventory.json' || rest === 'player_equipment.json' || rest === 'library_collection.json' || rest === 'homunculi.json' || rest === 'star_cradle.json' || rest === 'star_cradle_creatures.json' || rest === 'gathering_stock.json' || rest === 'mp_reserve.json' || rest === path.join('runtime', 'player_parameters.json')) {
    return resolveWithinBase(paths.mutableRoot, rest);
  }
  if (rest.startsWith(`logs${path.sep}`)) {
    return resolveWithinBase(path.join(paths.mutableRoot, 'logs'), rest.slice(`logs${path.sep}`.length));
  }
  if (rest.startsWith(`characters${path.sep}`)) {
    const [, characterId, ...segments] = rest.split(path.sep);
    const leaf = segments.join(path.sep);
    if (isMutableCharacterLeaf(leaf)) {
      return resolveWithinBase(path.join(paths.mutableRoot, 'characters', characterId), leaf);
    }
    if (leaf === 'profile.json' || leaf === 'appearance.json') {
      return resolveWithinBase(path.join(paths.characterContentRoot, characterId), leaf);
    }
  }
  if (rest.startsWith(`creatures${path.sep}`)) {
    const [, creatureId, ...segments] = rest.split(path.sep);
    const leaf = segments.join(path.sep);
    if (isMutableCreatureLeaf(leaf)) {
      return resolveWithinBase(path.join(paths.mutableRoot, 'creatures', creatureId), leaf);
    }
    if (leaf === 'profile.json' || leaf === 'appearance.json') {
      return resolveWithinBase(path.join(paths.creatureContentRoot, creatureId), leaf);
    }
  }
  if (rest.startsWith(`homunculi${path.sep}`)) {
    const [, homunculusId, ...segments] = rest.split(path.sep);
    const leaf = segments.join(path.sep);
    if (!homunculusId || !leaf) return resolveWithinBase(paths.projectRoot, relativePath);
    return resolveWithinBase(path.join(paths.mutableRoot, 'homunculi', homunculusId), leaf);
  }
  return resolveWithinBase(paths.projectRoot, relativePath);
}

export function createStorageApi(options = {}) {
  const { root, paths = {}, readOperationHooks = {}, requireRoutingReadScope = false } = options;
  const resolvedPaths = normalizePaths(root == null ? paths : { root, ...paths });

  async function readJson(relativePath) {
    const fullPath = await resolveLegacyReadPath(resolvedPaths, relativePath);
    await routingReadPreFence({ fullPath, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
    const raw = await fs.readFile(fullPath, 'utf8');
    if (typeof readOperationHooks.afterReadFile === 'function') {
      await readOperationHooks.afterReadFile({ relativePath, fullPath });
    }
    await routingReadPostFence({ fullPath, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
    return JSON.parse(raw);
  }

  async function resolveReadPath(relativePath) {
    return await resolveLegacyReadPath(resolvedPaths, relativePath);
  }

  function resolveWritePath(relativePath) {
    return resolveLegacyWritePath(resolvedPaths, relativePath);
  }

  async function readJsonIfExists(relativePath) {
    try {
      return await readJson(relativePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeJson(relativePath, value) {
    const fullPath = resolveLegacyWritePath(resolvedPaths, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async function writeJsonAtomic(relativePath, value) {
    const fullPath = resolveLegacyWritePath(resolvedPaths, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const tempPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${process.pid}.${randomUUID()}.tmp`);
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, fullPath);
  }

  async function readCharacter(characterId) {
    const base = `game_data/characters/${characterId}`;
    const [profile, flags, skills] = await Promise.all([
      readJson(`${base}/profile.json`),
      readJsonIfExists(`${base}/flags.json`),
      readJsonIfExists(`${base}/skills.json`)
    ]);
    return {
      profile,
      flags: flags ?? defaultFlagsFor(characterId),
      skills: skills ?? defaultSkillsFor(characterId)
    };
  }

  async function listJson(relativeDir) {
    const fullDir = await resolveLegacyReadPath(resolvedPaths, relativeDir);
    let names = [];
    try {
      await routingReadPreFence({ fullPath: fullDir, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
      names = await fs.readdir(fullDir);
      if (typeof readOperationHooks.afterReaddir === 'function') {
        await readOperationHooks.afterReaddir({ relativePath: relativeDir, fullPath: fullDir });
      }
      await routingReadPostFence({ fullPath: fullDir, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const jsonNames = names.filter((name) => name.endsWith('.json')).sort();
    return Promise.all(jsonNames.map((name) => readJson(path.join(relativeDir, name))));
  }

  async function listMarkdownRecords(relativeDir) {
    const fullDir = await resolveLegacyReadPath(resolvedPaths, relativeDir);
    let names = [];
    try {
      await routingReadPreFence({ fullPath: fullDir, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
      names = await fs.readdir(fullDir);
      if (typeof readOperationHooks.afterReaddir === 'function') {
        await readOperationHooks.afterReaddir({ relativePath: relativeDir, fullPath: fullDir });
      }
      await routingReadPostFence({ fullPath: fullDir, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const mdNames = names.filter((name) => name.endsWith('.md')).sort();
    return Promise.all(mdNames.map(async (name) => ({
      id: name.replace(/\.md$/, ''),
      visibility: 'character_known',
      title: name.replace(/\.md$/, '').replaceAll('_', ' '),
      body: await (async () => {
        const fullPath = path.join(fullDir, name);
        await routingReadPreFence({ fullPath, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
        const raw = await fs.readFile(fullPath, 'utf8');
        if (typeof readOperationHooks.afterReadFile === 'function') {
          await readOperationHooks.afterReadFile({ relativePath: path.join(relativeDir, name), fullPath });
        }
        await routingReadPostFence({ fullPath, storagePaths: resolvedPaths, requireScope: requireRoutingReadScope });
        return raw;
      })(),
      tags: []
    })));
  }

  return {
    paths: resolvedPaths,
    resolveReadPath,
    resolveWritePath,
    readJson,
    readJsonIfExists,
    writeJson,
    writeJsonAtomic,
    readCharacter,
    listJson,
    listMarkdownRecords
  };
}

export const defaultStorageApi = createStorageApi();
export const readJson = defaultStorageApi.readJson;
export const readJsonIfExists = defaultStorageApi.readJsonIfExists;
export const writeJson = defaultStorageApi.writeJson;
export const writeJsonAtomic = defaultStorageApi.writeJsonAtomic;
export const readCharacter = defaultStorageApi.readCharacter;
export const listJson = defaultStorageApi.listJson;
export const listMarkdownRecords = defaultStorageApi.listMarkdownRecords;
