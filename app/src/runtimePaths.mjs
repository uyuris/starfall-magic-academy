import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const inferredProjectRoot = path.resolve(moduleDir, '../..');

export const runtimePathsManifestFilename = '.magic-academy-runtime-paths.json';

function resolveFromProjectRoot(projectRoot, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
}

export function createRuntimePaths({
  projectRoot = inferredProjectRoot,
  runtimeRoot = 'app/src',
  publicRoot = 'app/public',
  configRoot = 'app/config',
  testsRoot = 'app/tests',
  canonicalAssetsRoot = 'assets/canonical',
  definitionsRoot = 'data/definitions/game_data',
  seedsRoot = 'data/seeds/game_data',
  mutableRoot = 'data/mutable/game_data',
  characterContentRoot = 'content/characters',
  canonicalVisualSetsRoot = 'assets/canonical/character_visual_sets'
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  return {
    projectRoot: resolvedProjectRoot,
    appRoot: path.join(resolvedProjectRoot, 'app'),
    runtimeRoot: resolveFromProjectRoot(resolvedProjectRoot, runtimeRoot),
    publicRoot: resolveFromProjectRoot(resolvedProjectRoot, publicRoot),
    configRoot: resolveFromProjectRoot(resolvedProjectRoot, configRoot),
    testsRoot: resolveFromProjectRoot(resolvedProjectRoot, testsRoot),
    canonicalAssetsRoot: resolveFromProjectRoot(resolvedProjectRoot, canonicalAssetsRoot),
    definitionsRoot: resolveFromProjectRoot(resolvedProjectRoot, definitionsRoot),
    seedsRoot: resolveFromProjectRoot(resolvedProjectRoot, seedsRoot),
    mutableRoot: resolveFromProjectRoot(resolvedProjectRoot, mutableRoot),
    characterContentRoot: resolveFromProjectRoot(resolvedProjectRoot, characterContentRoot),
    canonicalVisualSetsRoot: resolveFromProjectRoot(resolvedProjectRoot, canonicalVisualSetsRoot)
  };
}

export const defaultRuntimePaths = createRuntimePaths();
export const projectRoot = defaultRuntimePaths.projectRoot;
