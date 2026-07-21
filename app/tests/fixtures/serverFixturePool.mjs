// Fixture pool for serverApi.test.mjs.
//
// The dominant per-test cost in the legacy fixture is `fs.cp` of the full
// character authoring tree (content/characters) into every isolated root. That
// authoring surface is read-only during play: the storage layer routes every
// mutable character write (flags/skills/affinity/memory/work_records) to
// `mutableRoot`, and only profile/appearance authoring resolves to
// `characterContentRoot` (see app/src/storage.mjs resolveLegacy{Read,Write}Path).
//
// This pool builds the authoring tree exactly once, shares it read-only across
// every pooled root, and gives each test only a fresh, cheap `game_data` root
// for its mutable surfaces. The manifest points `characterContentRoot` at the
// shared tree while keeping `mutableRoot` per-test, so the legacy layout's
// on-disk mutable contract is unchanged.
//
// Isolation and fail-fast:
// - The shared authoring files are chmod 0o444. Any in-place authoring write
//   (only api/characters/profile → updateCharacterProfileText does this) hits
//   EACCES and fails the test loudly instead of silently polluting siblings.
//   Tests that legitimately persist authoring must use a private (non-pooled)
//   fixture root.
// - Mutable character writes create fresh entries under the per-test
//   `game_data/characters/<id>/`, never touching the shared inodes.

import { promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { baselineRuntimeState, writeJson } from '../helpers.mjs';
import {
  characterContentRoot,
  definitionsRoot,
  seedsRoot,
  testsFixtureRoot
} from '../testPaths.mjs';

const eventFlagsFixturePath = path.join(testsFixtureRoot, 'event_flags.fixture.json');
const linaProfilePath = path.join(characterContentRoot, 'lina/profile.json');

const definitionFiles = [
  'alchemy_recipes.json',
  'auction_catalog.json',
  'creature_encounters.json',
  'dungeon_materials.json',
  'event_flags.json',
  'gathering_points.json',
  'locations.json',
  'shop_catalog.json',
  'star_cradle_catalog.json',
  'stage_flags.json',
  'study_circles.json',
  'study_circle_types.json',
  'world/settings.json',
  'prompt/character_speech_constraints.json'
];

async function makeTreeFilesReadOnly(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeTreeFilesReadOnly(full);
    else await fs.chmod(full, 0o444);
  }
}

let sharedAuthoringPromise = null;

async function buildSharedAuthoringRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-shared-authoring-'));
  await fs.cp(characterContentRoot, dir, { recursive: true });
  // Mirror helpers.seedLegacyCharacterAuthoring: lina's authoring profile is the
  // canonical content/characters/lina/profile.json (identical bytes), so the
  // shared copy already matches. Read-only enforcement is the guard below.
  const linaProfile = JSON.parse(await fs.readFile(linaProfilePath, 'utf8'));
  await fs.writeFile(
    path.join(dir, 'lina/profile.json'),
    `${JSON.stringify(linaProfile, null, 2)}\n`,
    'utf8'
  );
  await makeTreeFilesReadOnly(dir);
  process.once('exit', () => {
    // Files are 0o444 but their directories stay writable, so unlink succeeds.
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Shared read-only character authoring tree. Built once per test process.
export function sharedAuthoringRoot() {
  if (!sharedAuthoringPromise) sharedAuthoringPromise = buildSharedAuthoringRoot();
  return sharedAuthoringPromise;
}

async function seedDefinitions(root) {
  for (const relativePath of definitionFiles) {
    const source = path.join(definitionsRoot, relativePath);
    const destination = path.join(root, 'game_data', relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  const seedRuntimeStateSource = path.join(seedsRoot, 'runtime_state.json');
  const seedRuntimeStateDestination = path.join(root, 'game_data/runtime_state.json');
  await fs.copyFile(seedRuntimeStateSource, seedRuntimeStateDestination);

  const fixtureEventFlags = JSON.parse(await fs.readFile(eventFlagsFixturePath, 'utf8'));
  await writeJson(root, 'game_data/event_flags.json', fixtureEventFlags);
}

async function seedLinaMutableState(root) {
  await writeJson(root, 'game_data/characters/lina/skills.json', { character_id: 'lina', skills: [] });
  await writeJson(root, 'game_data/characters/lina/flags.json', {
    character_id: 'lina',
    flags: {
      'knowledge.lina.player_checked_garden_label': false,
      'relationship.lina.trust': 0,
      'condition.minor.lina_worried': false
    }
  });
  await fs.mkdir(path.join(root, 'game_data/characters/lina/memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'game_data/characters/lina/work_records'), { recursive: true });
  await fs.mkdir(path.join(root, 'game_data/runtime'), { recursive: true });
}

async function writePooledManifest(root, { authoringRoot, manifestFilename, canonicalAssetsRoot, publicRoot }) {
  const manifest = {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: authoringRoot,
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot,
    publicRoot,
    resourceRoot: root
  };
  await fs.writeFile(path.join(root, manifestFilename), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// Build a legacy-layout fixture root that shares the read-only authoring tree
// instead of copying it. `manifestFilename`, `canonicalAssetsRoot`, and
// `publicRoot` come from the caller so the pool stays independent of test-file
// path constants. Returns the root path.
export async function pooledLegacyFixtureRoot({
  manifestFilename,
  canonicalAssetsRoot,
  publicRoot,
  runtimeState = baselineRuntimeState
} = {}) {
  if (!manifestFilename) throw new Error('pooledLegacyFixtureRoot requires manifestFilename');
  if (!canonicalAssetsRoot) throw new Error('pooledLegacyFixtureRoot requires canonicalAssetsRoot');
  if (!publicRoot) throw new Error('pooledLegacyFixtureRoot requires publicRoot');
  const authoringRoot = await sharedAuthoringRoot();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-server-api-'));
  await seedDefinitions(root);
  await seedLinaMutableState(root);
  await writeJson(root, 'game_data/runtime_state.json', runtimeState);
  await writePooledManifest(root, { authoringRoot, manifestFilename, canonicalAssetsRoot, publicRoot });
  return root;
}
