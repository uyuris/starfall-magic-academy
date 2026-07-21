import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStorageApi } from '../src/storage.mjs';
import { fixtureRoot } from './helpers.mjs';
import { projectRoot } from './testPaths.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function nextProjectPaths(overrides = {}) {
  return {
    projectRoot,
    definitionsRoot: path.join(projectRoot, 'data/definitions/game_data'),
    seedsRoot: path.join(projectRoot, 'data/seeds/game_data'),
    mutableRoot: path.join(projectRoot, 'data/mutable/game_data'),
    characterContentRoot: path.join(projectRoot, 'content/characters'),
    ...overrides
  };
}

test('createStorageApi reads split next-project definitions seeds and character content through legacy game_data paths', async () => {
  const storage = createStorageApi({ paths: nextProjectPaths() });

  const [locations, runtimeState, playerParameters, lina] = await Promise.all([
    storage.readJson('game_data/locations.json'),
    storage.readJson('game_data/runtime_state.json'),
    storage.readJson('game_data/runtime/player_parameters.json'),
    storage.readCharacter('lina')
  ]);

  assert.equal(Array.isArray(locations), true);
  assert.equal(locations.length > 0, true);
  assert.equal(typeof runtimeState.current_location_id, 'string');
  assert.equal(playerParameters.magic.light.value >= 0, true);
  assert.equal(lina.profile.character_id, 'lina');
  assert.equal(lina.skills.character_id, 'lina');
  assert.equal(lina.flags.character_id, 'lina');
  assert.equal(typeof lina.flags.flags, 'object');
});

test('createStorageApi writes mutable character flags and lists work records from the mutable surface without mutating authored content', async (t) => {
  const mutableRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-next-storage-'));
  t.after(async () => {
    await fs.rm(mutableRoot, { recursive: true, force: true });
  });

  const storage = createStorageApi({
    paths: nextProjectPaths({ mutableRoot })
  });

  const nextFlags = {
    character_id: 'lina',
    flags: {
      'relationship.lina.trust': 7,
      'condition.minor.lina_worried': true
    }
  };

  await storage.writeJson('game_data/characters/lina/flags.json', nextFlags);
  await fs.mkdir(path.join(mutableRoot, 'characters/lina/work_records'), { recursive: true });
  await fs.writeFile(path.join(mutableRoot, 'characters/lina/work_records/first_contact.md'), '初対面の印象', 'utf8');

  const [lina, records, writtenFlags] = await Promise.all([
    storage.readCharacter('lina'),
    storage.listMarkdownRecords('game_data/characters/lina/work_records'),
    fs.readFile(path.join(mutableRoot, 'characters/lina/flags.json'), 'utf8')
  ]);

  assert.deepEqual(JSON.parse(writtenFlags), nextFlags);
  assert.deepEqual(lina.flags, nextFlags);
  assert.equal(lina.profile.character_id, 'lina');
  assert.deepEqual(records.map((item) => item.id), ['first_contact']);
  assert.equal(records[0].body, '初対面の印象');

  await assert.rejects(
    fs.access(path.join(projectRoot, 'content/characters/lina/flags.json')),
    { code: 'ENOENT' }
  );
});

test('createStorageApi can target a legacy fixture root with a concrete game_data tree during incremental migration', async (t) => {
  const root = await fixtureRoot('magic-adv-storage-legacy-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const storage = createStorageApi({ root });
  const [runtimeState, lina] = await Promise.all([
    storage.readJson('game_data/runtime_state.json'),
    storage.readCharacter('lina')
  ]);

  assert.equal(runtimeState.current_location_id, 'herbology_garden');
  assert.equal(lina.profile.character_id, 'lina');
  assert.equal(lina.flags.character_id, 'lina');
});

test('the mp_reserve surface routes to the mutable root for both read and write (mutable player surface)', async (t) => {
  const mutableRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-mp-reserve-storage-'));
  const seedsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-mp-reserve-seeds-'));
  t.after(async () => {
    await fs.rm(mutableRoot, { recursive: true, force: true });
    await fs.rm(seedsRoot, { recursive: true, force: true });
  });
  const storage = createStorageApi({ paths: nextProjectPaths({ mutableRoot, seedsRoot }) });

  // Write always lands in mutable.
  const writePath = storage.resolveWritePath('game_data/mp_reserve.json');
  assert.equal(writePath, path.join(mutableRoot, 'mp_reserve.json'));

  // Read prefers mutable when present, falling back to seeds otherwise (same routing as player_equipment).
  await storage.writeJson('game_data/mp_reserve.json', { version: 1, reserves: { character_001: 42 } });
  const readPath = await storage.resolveReadPath('game_data/mp_reserve.json');
  assert.equal(readPath, path.join(mutableRoot, 'mp_reserve.json'));
  const surface = await storage.readJson('game_data/mp_reserve.json');
  assert.deepEqual(surface, { version: 1, reserves: { character_001: 42 } });
});

test('createStorageApi rejects legacy game_data paths that resolve outside the routed surface root', async (t) => {
  const root = await fixtureRoot('magic-adv-storage-containment-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const storage = createStorageApi({ root });

  await assert.rejects(
    storage.resolveReadPath('game_data/logs/conversations/../../runtime_state.json'),
    /path|contain|outside/i
  );
  await assert.rejects(
    storage.writeJson('game_data/logs/conversations/../../runtime_state.json', { bad: true }),
    /path|contain|outside/i
  );
});
