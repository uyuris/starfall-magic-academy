import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSelectableCharacterStorage, listSelectableCharacters, updateCharacterProfileText } from '../src/characterCatalog.mjs';
import { createStorageApi } from '../src/storage.mjs';

const repoCharactersRoot = fileURLToPath(new URL('../../content/characters/', import.meta.url));
const repoCanonicalVisualSetsRoot = fileURLToPath(new URL('../../assets/canonical/character_visual_sets/', import.meta.url));

function pad(index) {
  return String(index).padStart(3, '0');
}

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function seedVisualSetStandeeManifest(root, visualSetId) {
  const sourceManifest = JSON.parse(await fs.readFile(path.join(repoCanonicalVisualSetsRoot, visualSetId, 'manifest.json'), 'utf8'));
  await writeJson(root, `assets/canonical/character_visual_sets/${visualSetId}/manifest.json`, {
    scene_standee: sourceManifest.scene_standee
  });
  const standeePath = path.join(root, 'assets/canonical/character_visual_sets', visualSetId, sourceManifest.scene_standee.path);
  await fs.mkdir(path.dirname(standeePath), { recursive: true });
  await fs.writeFile(standeePath, 'standee');
}

async function splitCharacterCatalogRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-character-split-'));
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'courtyard_fountain',
    current_screen: 'academy-map',
    current_buddy_character_id: 'character_002',
    current_enemy_character_ids: ['character_003'],
    global_flags: {},
    characters: {}
  });
  await fs.cp(repoCharactersRoot, path.join(root, 'content/characters'), { recursive: true });
  for (let index = 1; index <= 172; index += 1) {
    await seedVisualSetStandeeManifest(root, `visual_set_${pad(index)}`);
  }
  return root;
}

test('split-root character profile edits persist authored content under content/characters and mutable files under data/mutable without creating legacy game_data files', async (t) => {
  const root = await splitCharacterCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const saved = await updateCharacterProfileText({
    root,
    characterId: 'character_007',
    promptDescription: 'split-root では authoring profile に保存される。',
    speakingBasis: 'split-root では会話基準も authoring profile に保存される。'
  });

  assert.equal(saved.prompt_description, 'split-root では authoring profile に保存される。');
  assert.equal(saved.speaking_basis, 'split-root では会話基準も authoring profile に保存される。');

  const authoredProfile = JSON.parse(await fs.readFile(path.join(root, 'content/characters/character_007/profile.json'), 'utf8'));
  assert.equal(authoredProfile.prompt_description, saved.prompt_description);
  assert.equal(authoredProfile.speaking_basis, saved.speaking_basis);

  const mutableFlags = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/characters/character_007/flags.json'), 'utf8'));
  const mutableSkills = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/characters/character_007/skills.json'), 'utf8'));
  assert.deepEqual(mutableFlags, { character_id: 'character_007', flags: {} });
  assert.deepEqual(mutableSkills, { character_id: 'character_007', skills: [] });

  await fs.access(path.join(root, 'data/mutable/game_data/characters/character_007/memory'));
  await fs.access(path.join(root, 'data/mutable/game_data/characters/character_007/work_records'));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_007/profile.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_007/flags.json')), { code: 'ENOENT' });
});

test('split-root character catalog reads buddy and enemy state from authored profiles plus data/mutable runtime_state', async (t) => {
  const root = await splitCharacterCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const characters = await listSelectableCharacters({ root });

  assert.equal(characters.length, 172);
  assert.equal(characters[1].character_id, 'character_002');
  assert.equal(characters[1].is_buddy, true);
  assert.deepEqual(characters[1].buddy_flags, ['relationship.character_002.buddy']);
  assert.equal(characters[2].character_id, 'character_003');
  assert.equal(characters[2].is_enemy, true);
  assert.deepEqual(characters[2].enemy_flags, ['relationship.character_003.enemy']);
  assert.equal(characters[0].is_buddy, false);
  assert.equal(characters[0].is_enemy, false);
  assert.equal(characters[50].character_id, 'character_051');
  assert.equal(characters[51].character_id, 'character_052');
  assert.equal(characters[54].character_id, 'character_055');
  assert.match(characters[54].source_image_url, /^\/canonical\/character_visual_sets\/visual_set_055\/face_emotions\/neutral\.jpg$/);
  assert.match(characters[54].standee_url, /^\/canonical\/character_visual_sets\/visual_set_055\/scene_standee\/scene_standee_character_01\.jpg$/);
  assert.match(characters[6].standee_url, /^\/canonical\/character_visual_sets\/visual_set_007\/scene_standee\/scene_standee_character_05\.jpg$/);

  await assert.rejects(fs.access(path.join(root, 'game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('character catalog rejects missing authored selectable profiles instead of inventing fallback data', async (t) => {
  const root = await splitCharacterCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.rm(path.join(root, 'content/characters/character_007/profile.json'));

  await assert.rejects(
    updateCharacterProfileText({
      root,
      characterId: 'character_007',
      promptDescription: 'missing profile should fail',
      speakingBasis: 'missing profile should fail'
    }),
    /missing selectable character profile: character_007/
  );
});

test('character catalog rejects missing scene standee manifests instead of guessing extensions', async (t) => {
  const root = await splitCharacterCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.rm(path.join(root, 'assets/canonical/character_visual_sets/visual_set_055/manifest.json'));

  await assert.rejects(
    listSelectableCharacters({ root }),
    /missing visual set manifest: visual_set_055/
  );
});

test('selectable character bootstrap succeeds without symlink privilege and keeps canonical profile reads in authored content', async (t) => {
  const authoringRoot = await splitCharacterCatalogRoot();
  const slotRoot = path.join(authoringRoot, 'data/mutable/game_data/play/slots/slot_001');
  const originalSymlink = fs.symlink;
  fs.symlink = async () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  t.after(async () => {
    fs.symlink = originalSymlink;
    await fs.rm(authoringRoot, { recursive: true, force: true });
  });

  const saved = await ensureSelectableCharacterStorage({ root: slotRoot, authoringRoot, characterId: 'character_007' });
  const storage = createStorageApi({ root: slotRoot });

  assert.equal(saved.profile.character_id, 'character_007');
  assert.equal(await storage.resolveReadPath('game_data/characters/character_007/profile.json'), path.join(authoringRoot, 'content/characters/character_007/profile.json'));
  const flags = await storage.readJson('game_data/characters/character_007/flags.json');
  const skills = await storage.readJson('game_data/characters/character_007/skills.json');
  assert.deepEqual(flags, { character_id: 'character_007', flags: {} });
  assert.deepEqual(skills, { character_id: 'character_007', skills: [] });
});

test('character catalog does not reintroduce manifest reads or code-side fallback profiles for selectable character summaries', async () => {
  const sourcePath = fileURLToPath(new URL('../src/characterCatalog.mjs', import.meta.url));
  const source = await fs.readFile(sourcePath, 'utf8');

  assert.doesNotMatch(source, /const manifestPath = path\.join\(v5AssetsRoot, 'character_visual_sets', visualSetId, 'manifest\.json'\);/);
  assert.doesNotMatch(source, /const manifest = await readJsonIfExists\(manifestPath\);/);
  assert.doesNotMatch(source, /characterSummary\(\{ profile, currentBuddyCharacterId, currentEnemyCharacterIds, manifest, index, sceneStandeeFilename \}\)/);
  assert.doesNotMatch(source, /const characterProfiles = \[/);
  assert.doesNotMatch(source, /function defaultProfile\(/);
});
