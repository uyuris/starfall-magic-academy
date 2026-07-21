import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { setRelationshipDebugState } from '../src/relationshipState.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function createSplitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-relationship-state-'));
  await writeJson(root, 'data/seeds/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'field',
    current_interaction_character_id: null,
    current_buddy_character_id: 'lina',
    current_enemy_character_ids: ['aria'],
    characters: {
      lina: { flags: { 'relationship.lina.buddy': true } },
      aria: { flags: { 'relationship.aria.enemy': true } }
    }
  });
  await writeJson(root, 'data/mutable/game_data/characters/lina/flags.json', {
    character_id: 'lina',
    flags: { 'relationship.lina.buddy': true }
  });
  await writeJson(root, 'data/mutable/game_data/characters/aria/flags.json', {
    character_id: 'aria',
    flags: { 'relationship.aria.enemy': true }
  });
  return root;
}

test('setRelationshipDebugState updates split runtime state and mutable character flag files in the migrated layout', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await setRelationshipDebugState({
    root,
    buddyCharacterId: 'character_001',
    enemyCharacterIds: ['character_002']
  });

  assert.equal(result.relationship.current_buddy_character_id, 'character_001');
  assert.deepEqual(result.relationship.current_enemy_character_ids, ['character_002']);

  const runtimeState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const linaFlags = await readJson(root, 'data/mutable/game_data/characters/lina/flags.json');
  const ariaFlags = await readJson(root, 'data/mutable/game_data/characters/aria/flags.json');
  const buddyFlags = await readJson(root, 'data/mutable/game_data/characters/character_001/flags.json');
  const enemyFlags = await readJson(root, 'data/mutable/game_data/characters/character_002/flags.json');

  assert.equal(runtimeState.current_buddy_character_id, 'character_001');
  assert.deepEqual(runtimeState.current_enemy_character_ids, ['character_002']);
  // The invalid prior relationship state (buddy=lina, enemy=aria) is cleared.
  assert.equal(linaFlags.flags['relationship.lina.buddy'], false);
  assert.equal(ariaFlags.flags['relationship.aria.enemy'], false);
  // The new selectable relationship ids are applied.
  assert.equal(buddyFlags.flags['relationship.character_001.buddy'], true);
  assert.equal(buddyFlags.flags['relationship.character_001.enemy'], false);
  assert.equal(enemyFlags.flags['relationship.character_002.enemy'], true);
  assert.equal(enemyFlags.flags['relationship.character_002.buddy'], false);

  await assert.rejects(fs.access(path.join(root, 'game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('setRelationshipDebugState rejects a non-selectable buddy id with a 400 error and writes no state', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const buddyCharacterId of ['lina', 'creature_001']) {
    await assert.rejects(
      setRelationshipDebugState({ root, buddyCharacterId, enemyCharacterIds: [] }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /buddy character is not a selectable roster character/);
        return true;
      }
    );
  }

  // No mutable state or flag files were written by the rejected calls.
  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('setRelationshipDebugState rejects a non-selectable enemy id with a 400 error and writes no state', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    setRelationshipDebugState({ root, buddyCharacterId: null, enemyCharacterIds: ['character_003', 'lina'] }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /enemy character is not a selectable roster character/);
      return true;
    }
  );

  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('setRelationshipDebugState clears an invalid saved buddy=lina when the buddy is set to null', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await setRelationshipDebugState({ root, buddyCharacterId: null, enemyCharacterIds: ['character_002'] });

  assert.equal(result.relationship.current_buddy_character_id, null);
  const runtimeState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const linaFlags = await readJson(root, 'data/mutable/game_data/characters/lina/flags.json');
  assert.equal(runtimeState.current_buddy_character_id, null);
  assert.equal(linaFlags.flags['relationship.lina.buddy'], false);
});
