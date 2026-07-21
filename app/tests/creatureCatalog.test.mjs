import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  creatureCount,
  creatureIdForIndex,
  creatureIndexFromId,
  ensureCreatureStorage,
  isCreatureId,
  listCreatures,
  visualSetIdForCreature
} from '../src/creatureCatalog.mjs';
import { isSelectableCharacterId, listSelectableCharacters } from '../src/characterCatalog.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { projectRoot } from './testPaths.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function seedCreatureVisualSet(root, visualSetId) {
  const sourceManifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'assets/canonical/character_visual_sets', visualSetId, 'manifest.json'), 'utf8'));
  await writeJson(root, `assets/canonical/character_visual_sets/${visualSetId}/manifest.json`, {
    scene_standee: sourceManifest.scene_standee
  });
  const standeePath = path.join(root, 'assets/canonical/character_visual_sets', visualSetId, sourceManifest.scene_standee.path);
  await fs.mkdir(path.dirname(standeePath), { recursive: true });
  await fs.writeFile(standeePath, 'standee');
}

function creatureProfile(id, displayName, overrides = {}) {
  return {
    character_id: id,
    display_name: displayName,
    identity: `${displayName} identity`,
    speaking_basis: `${displayName} speaking basis`,
    parameter_attitude_type: 'respect_any_superior',
    parameters: {
      magic: { light: 60, dark: 30, fire: 45, water: 25, earth: 55, wind: 20 },
      abilities: { strength: 35, agility: 40, academics: 65, magical_power: 70, charisma: 50 }
    },
    ...overrides
  };
}

async function creatureCatalogRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-creature-catalog-'));
  await writeJson(root, 'content/creatures/creature_001/profile.json', creatureProfile('creature_001', '灯火の小精霊'));
  await writeJson(root, 'content/creatures/creature_002/profile.json', creatureProfile('creature_002', '鈴羽の妖精'));
  await writeJson(root, 'content/creatures/creature_003/profile.json', creatureProfile('creature_003', '苔角の魔物'));
  await writeJson(root, 'content/creatures/creature_004/profile.json', creatureProfile('creature_004', '葉風'));
  await writeJson(root, 'content/creatures/creature_005/profile.json', creatureProfile('creature_005', '紅環'));
  await writeJson(root, 'content/creatures/creature_006/profile.json', creatureProfile('creature_006', '泡沫'));
  await writeJson(root, 'content/creatures/creature_007/profile.json', creatureProfile('creature_007', '花蔓'));
  await writeJson(root, 'content/creatures/creature_008/profile.json', creatureProfile('creature_008', '雫花'));
  await writeJson(root, 'content/creatures/creature_009/profile.json', creatureProfile('creature_009', '赤笠'));
  await writeJson(root, 'content/creatures/creature_010/profile.json', creatureProfile('creature_010', '照葉'));
  await writeJson(root, 'content/creatures/creature_011/profile.json', creatureProfile('creature_011', '水沫'));
  await writeJson(root, 'content/creatures/creature_012/profile.json', creatureProfile('creature_012', '坂守'));
  await writeJson(root, 'content/creatures/creature_013/profile.json', creatureProfile('creature_013', '焔角'));
  await writeJson(root, 'content/creatures/creature_014/profile.json', creatureProfile('creature_014', '木隠'));
  await writeJson(root, 'content/creatures/creature_015/profile.json', creatureProfile('creature_015', '霧曳'));
  await seedCreatureVisualSet(root, 'creature_001');
  await seedCreatureVisualSet(root, 'creature_002');
  await seedCreatureVisualSet(root, 'creature_003');
  await seedCreatureVisualSet(root, 'creature_004');
  await seedCreatureVisualSet(root, 'creature_005');
  await seedCreatureVisualSet(root, 'creature_006');
  await seedCreatureVisualSet(root, 'creature_007');
  await seedCreatureVisualSet(root, 'creature_008');
  await seedCreatureVisualSet(root, 'creature_009');
  await seedCreatureVisualSet(root, 'creature_010');
  await seedCreatureVisualSet(root, 'creature_011');
  await seedCreatureVisualSet(root, 'creature_012');
  await seedCreatureVisualSet(root, 'creature_013');
  await seedCreatureVisualSet(root, 'creature_014');
  await seedCreatureVisualSet(root, 'creature_015');
  return root;
}

test('creature catalog lists the fifteen cataloged creatures from content/creatures only', async (t) => {
  const root = await creatureCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const creatures = await listCreatures({ root });

  assert.equal(creatureCount, 15);
  assert.deepEqual(creatures.map((creature) => creature.character_id), [
    'creature_001',
    'creature_002',
    'creature_003',
    'creature_004',
    'creature_005',
    'creature_006',
    'creature_007',
    'creature_008',
    'creature_009',
    'creature_010',
    'creature_011',
    'creature_012',
    'creature_013',
    'creature_014',
    'creature_015'
  ]);
  assert.equal(creatures[0].display_name, '灯火の小精霊');
  assert.equal(creatures[0].visual_set_id, 'creature_001');
  assert.equal(creatures[0].face_url, '/canonical/character_visual_sets/creature_001/face_emotions/neutral.jpg');
  assert.equal(creatures[0].selection_icon_url, creatures[0].face_url);
  assert.equal(creatures[0].standee_url, '/canonical/character_visual_sets/creature_001/scene_standee/scene_standee_character_01.jpg');
  // Creatures carry academy-style stats as real values; the catalog normalizes them
  // into the same magic/ability meter shape students use.
  assert.equal(creatures[0].parameter_attitude_type, 'respect_any_superior');
  assert.equal(creatures[0].parameters.magic.light.value, 60);
  assert.equal(creatures[0].parameters.magic.light.label, '光魔法習熟度');
  assert.equal(creatures[0].parameters.abilities.magical_power.value, 70);
  assert.equal(creatures.at(-1).display_name, '霧曳');
  assert.equal(creatures.at(-1).visual_set_id, 'creature_015');
  assert.equal(creatures.at(-1).face_url, '/canonical/character_visual_sets/creature_015/face_emotions/neutral.jpg');
});

test('creature catalog fails fast on missing parameters and invalid attitude instead of zero-filling', async (t) => {
  const root = await creatureCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const missingParameters = creatureProfile('creature_001', '灯火の小精霊');
  delete missingParameters.parameters;
  await writeJson(root, 'content/creatures/creature_001/profile.json', missingParameters);
  await assert.rejects(listCreatures({ root }), /missing parameters for creature_001/);

  const missingMagicKey = creatureProfile('creature_001', '灯火の小精霊');
  delete missingMagicKey.parameters.magic.wind;
  await writeJson(root, 'content/creatures/creature_001/profile.json', missingMagicKey);
  await assert.rejects(listCreatures({ root }), /missing magic parameter wind for creature_001/);

  const missingAbilityKey = creatureProfile('creature_001', '灯火の小精霊');
  delete missingAbilityKey.parameters.abilities.charisma;
  await writeJson(root, 'content/creatures/creature_001/profile.json', missingAbilityKey);
  await assert.rejects(listCreatures({ root }), /missing abilities parameter charisma for creature_001/);

  await writeJson(root, 'content/creatures/creature_001/profile.json', creatureProfile('creature_001', '灯火の小精霊', { parameter_attitude_type: 'unknown_type' }));
  await assert.rejects(listCreatures({ root }), /invalid parameter_attitude_type for creature_001: unknown_type/);
});

test('creature id helpers reject non-creature and out-of-range ids instead of falling back', () => {
  assert.equal(creatureIdForIndex(1), 'creature_001');
  assert.equal(visualSetIdForCreature(2), 'creature_002');
  assert.equal(creatureIndexFromId('creature_003'), 3);
  assert.equal(creatureIndexFromId('creature_015'), 15);
  assert.equal(isCreatureId('creature_001'), true);
  assert.equal(isCreatureId('creature_015'), true);
  assert.equal(isCreatureId('character_001'), false);
  assert.equal(isCreatureId('creature_016'), false);

  assert.throws(() => creatureIdForIndex(0), /unknown creature: creature_000/);
  assert.throws(() => creatureIndexFromId('character_001'), /unknown creature: character_001/);
  assert.throws(() => creatureIndexFromId('creature_016'), /unknown creature: creature_016/);
});

test('creature catalog rejects missing profiles and out-of-range content directories', async (t) => {
  const root = await creatureCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.rm(path.join(root, 'content/creatures/creature_002/profile.json'));
  await assert.rejects(
    listCreatures({ root }),
    /missing creature profile: creature_002/
  );

  await writeJson(root, 'content/creatures/creature_002/profile.json', creatureProfile('creature_002', '鈴羽の妖精'));
  await writeJson(root, 'content/creatures/creature_016/profile.json', creatureProfile('creature_016', '範囲外'));
  await assert.rejects(
    listCreatures({ root }),
    /unknown creature: creature_016/
  );
});

test('creature catalog rejects missing scene standee files instead of guessing extensions', async (t) => {
  const root = await creatureCatalogRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.rm(path.join(root, 'assets/canonical/character_visual_sets/creature_001/scene_standee/scene_standee_character_01.jpg'));

  await assert.rejects(
    listCreatures({ root }),
    /missing scene standee asset for creature_001/
  );
});

test('ensureCreatureStorage creates mutable creature records under game_data/creatures', async (t) => {
  const authoringRoot = await creatureCatalogRoot();
  const slotRoot = path.join(authoringRoot, 'data/mutable/game_data/play/slots/slot_001');
  t.after(async () => {
    await fs.rm(authoringRoot, { recursive: true, force: true });
  });

  const saved = await ensureCreatureStorage({ root: slotRoot, authoringRoot, creatureId: 'creature_002' });
  const storage = createStorageApi({ root: slotRoot });

  assert.equal(saved.profile.character_id, 'creature_002');
  assert.deepEqual(saved.flags, { character_id: 'creature_002', flags: {} });
  assert.deepEqual(saved.skills, { character_id: 'creature_002', skills: [] });
  assert.equal(
    await storage.resolveReadPath('game_data/creatures/creature_002/profile.json'),
    path.join(authoringRoot, 'content/creatures/creature_002/profile.json')
  );

  const flags = await storage.readJson('game_data/creatures/creature_002/flags.json');
  const skills = await storage.readJson('game_data/creatures/creature_002/skills.json');
  assert.deepEqual(flags, { character_id: 'creature_002', flags: {} });
  assert.deepEqual(skills, { character_id: 'creature_002', skills: [] });
  await fs.access(path.join(slotRoot, 'game_data/creatures/creature_002/memory'));
  await fs.access(path.join(slotRoot, 'game_data/creatures/creature_002/work_records'));
  await assert.rejects(fs.access(path.join(slotRoot, 'game_data/characters/creature_002/flags.json')), { code: 'ENOENT' });
});

test('creatures stay out of the academy selectable character catalog', async () => {
  assert.equal(isSelectableCharacterId('creature_001'), false);

  const characters = await listSelectableCharacters({ root: projectRoot });
  assert.equal(characters.length, 172);
  assert.equal(characters[0].character_id, 'character_001');
  assert.equal(characters.at(-1).character_id, 'character_172');
});
