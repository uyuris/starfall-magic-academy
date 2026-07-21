import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createRuntimePaths, defaultRuntimePaths } from '../src/runtimePaths.mjs';

const execFileAsync = promisify(execFile);

test('defaultRuntimePaths derive self-contained next-project roots from the root runtime surface', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(testDir, '../..');

  assert.equal(defaultRuntimePaths.projectRoot, projectRoot);
  assert.equal(defaultRuntimePaths.runtimeRoot, path.join(projectRoot, 'app/src'));
  assert.equal(defaultRuntimePaths.publicRoot, path.join(projectRoot, 'app/public'));
  assert.equal(defaultRuntimePaths.configRoot, path.join(projectRoot, 'app/config'));
  assert.equal(defaultRuntimePaths.testsRoot, path.join(projectRoot, 'app/tests'));
  assert.equal(defaultRuntimePaths.canonicalAssetsRoot, path.join(projectRoot, 'assets/canonical'));
  assert.equal(defaultRuntimePaths.definitionsRoot, path.join(projectRoot, 'data/definitions/game_data'));
  assert.equal(defaultRuntimePaths.seedsRoot, path.join(projectRoot, 'data/seeds/game_data'));
  assert.equal(defaultRuntimePaths.mutableRoot, path.join(projectRoot, 'data/mutable/game_data'));
  assert.equal(defaultRuntimePaths.characterContentRoot, path.join(projectRoot, 'content/characters'));
  assert.equal(defaultRuntimePaths.canonicalVisualSetsRoot, path.join(projectRoot, 'assets/canonical/character_visual_sets'));
  assert.equal('sourceArchiveVisualSetsRoot' in defaultRuntimePaths, false);
});

test('createRuntimePaths resolves overrides against the next-project root', () => {
  const projectRoot = '/tmp/magic-adv-next';
  const paths = createRuntimePaths({ projectRoot });

  assert.equal(paths.projectRoot, projectRoot);
  assert.equal(paths.publicRoot, path.join(projectRoot, 'app/public'));
  assert.equal(paths.runtimeRoot, path.join(projectRoot, 'app/src'));
  assert.equal(paths.configRoot, path.join(projectRoot, 'app/config'));
  assert.equal(paths.testsRoot, path.join(projectRoot, 'app/tests'));
  assert.equal(paths.canonicalAssetsRoot, path.join(projectRoot, 'assets/canonical'));
  assert.equal('sourceArchiveVisualSetsRoot' in paths, false);
  assert.equal('assetsRoot' in paths, false);
});

test('canonical visual sets are materialized directories so zip copies do not depend on symlink preservation', async () => {
  const entries = await fs.readdir(defaultRuntimePaths.canonicalVisualSetsRoot, { withFileTypes: true });
  const visualSetEntries = entries.filter((entry) => /^visual_set_\d{3}$/.test(entry.name));
  assert.ok(visualSetEntries.length >= 50);
  for (const entry of visualSetEntries) {
    assert.equal(entry.isSymbolicLink(), false, `${entry.name} should be a real directory, not a symlink`);
    assert.equal(entry.isDirectory(), true, `${entry.name} should be a directory`);
  }
});

test('generated compatibility routes no longer require centralized runtime export trees or duplicated public mirrors', async () => {
  const duplicatedRoots = [
    path.join(defaultRuntimePaths.projectRoot, 'imports/snapshots/runtime-staging/public_generated_reference'),
    path.join(defaultRuntimePaths.projectRoot, 'imports/snapshots/runtime-staging/public_reference/generated'),
    path.join(defaultRuntimePaths.projectRoot, 'assets/runtime_exports')
  ];

  for (const duplicatedRoot of duplicatedRoots) {
    const exists = await fs.access(duplicatedRoot).then(() => true).catch(() => false);
    assert.equal(exists, false, `${duplicatedRoot} should not exist once generated compatibility resolves without runtime export mirrors`);
  }

  await fs.access(path.join(defaultRuntimePaths.canonicalAssetsRoot, 'title/title_night.jpg'));
  await fs.access(path.join(defaultRuntimePaths.canonicalAssetsRoot, 'backgrounds/manifest.json'));
});

test('canonical runtime asset roots exist for live-served browser images', async () => {
  for (const relativePath of [
    'character_visual_sets/visual_set_001/scene_standee/scene_standee_character_05.jpg',
    'backgrounds/background_001.jpg',
    'academy_map/overview.jpg',
    'title/title_night.jpg',
    'load/loading_night.jpg',
    'ui/card_images/artifact_appraisal.jpg'
  ]) {
    await fs.access(path.join(defaultRuntimePaths.canonicalAssetsRoot, relativePath));
  }
});

test('tracked PNG assets under assets are limited to retained transparent or packaging roots', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.png'], {
    cwd: defaultRuntimePaths.projectRoot,
    maxBuffer: 1024 * 1024
  });
  const candidates = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((assetPath) => assetPath.startsWith('assets/'));
  const pngPaths = [];
  for (const assetPath of candidates) {
    const absolutePath = path.join(defaultRuntimePaths.projectRoot, assetPath);
    const exists = await fs.access(absolutePath).then(() => true).catch(() => false);
    if (exists) pngPaths.push(assetPath);
  }
  const retainedPngRoots = [
    'assets/app-icons/',
    // Dungeon UI icon frames/items/enemies require alpha transparency.
    'assets/canonical/dungeon/',
    'assets/canonical/routing/',
    'assets/canonical/star_cradle/',
    'assets/canonical/academy_map/',
    'assets/canonical/conversation_day/',
    'assets/canonical/equipment/icons/',
    'assets/canonical/gathering/material-icons/',
    'assets/canonical/gathering/points/',
    'assets/canonical/map_pin_candidates/',
    'assets/canonical/map_pins/'
  ];
  const retainedPngFiles = [
    'assets/canonical/arena/corner_arena.png',
    'assets/canonical/arena/plate.png',
    'assets/canonical/atelier/corner_atelier.png',
    'assets/canonical/atelier/nameplate.png',
    'assets/canonical/auction/ui/gavel.png',
    'assets/canonical/library/corner_library.png',
    'assets/canonical/library/ex_libris.png'
  ];
  assert.deepEqual(
    pngPaths.filter(
      (assetPath) =>
        !retainedPngFiles.includes(assetPath) &&
        !retainedPngRoots.some((root) => assetPath.startsWith(root))
    ),
    []
  );
});
