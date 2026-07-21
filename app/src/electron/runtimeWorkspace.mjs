import path from 'node:path';
import { promises as fs } from 'node:fs';

import { runtimePathsManifestFilename } from '../runtimePaths.mjs';
import { normalizeLmStudioConfig } from '../llm/lmStudioClient.mjs';

async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function writeRuntimePathsManifest(projectRoot, manifest) {
  const manifestPath = path.join(projectRoot, runtimePathsManifestFilename);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

async function readJsonIfExists(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureLmStudioConfig({ resourceRoot, lmStudioConfigPath }) {
  const template = await readJsonIfExists(path.join(resourceRoot, 'app/config/lmstudio.example.json'))
    ?? await readJsonIfExists(path.join(resourceRoot, 'app/config/lmstudio.json'))
    ?? {};
  const existing = await readJsonIfExists(lmStudioConfigPath);
  const normalized = normalizeLmStudioConfig({
    ...template,
    ...(existing ?? {})
  });
  if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
    await fs.writeFile(lmStudioConfigPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  }
}

export async function ensureElectronRuntimeWorkspace({ resourceRoot, userDataRoot }) {
  if (!resourceRoot) throw new Error('resourceRoot is required');
  if (!userDataRoot) throw new Error('userDataRoot is required');

  const resolvedResourceRoot = path.resolve(resourceRoot);
  const resolvedUserDataRoot = path.resolve(userDataRoot);
  const projectRoot = path.join(resolvedUserDataRoot, 'runtime-project');
  const publicRoot = path.join(resolvedResourceRoot, 'app/public');
  const canonicalAssetsRoot = path.join(resolvedResourceRoot, 'assets/canonical');
  const definitionsRoot = path.join(resolvedResourceRoot, 'data/definitions/game_data');
  const seedsRoot = path.join(resolvedResourceRoot, 'data/seeds/game_data');
  const characterContentRoot = path.join(resolvedResourceRoot, 'content/characters');
  const mutableRoot = path.join(projectRoot, 'data/mutable/game_data');
  const configRoot = path.join(projectRoot, 'app/config');
  const lmStudioConfigPath = path.join(configRoot, 'lmstudio.json');

  await ensureDirectory(projectRoot);
  await ensureDirectory(mutableRoot);
  await ensureDirectory(configRoot);
  await ensureLmStudioConfig({ resourceRoot: resolvedResourceRoot, lmStudioConfigPath });

  const manifestPath = await writeRuntimePathsManifest(projectRoot, {
    projectRoot,
    resourceRoot: resolvedResourceRoot,
    publicRoot,
    canonicalAssetsRoot,
    definitionsRoot,
    seedsRoot,
    mutableRoot,
    characterContentRoot,
    configRoot
  });

  return {
    projectRoot,
    resourceRoot: resolvedResourceRoot,
    publicRoot,
    canonicalAssetsRoot,
    canonicalVisualSetsRoot: path.join(canonicalAssetsRoot, 'character_visual_sets'),
    definitionsRoot,
    seedsRoot,
    mutableRoot,
    characterContentRoot,
    configRoot,
    lmStudioConfigPath,
    runtimePathsManifestPath: manifestPath
  };
}
