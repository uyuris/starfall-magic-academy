import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixtureRoot } from './helpers.mjs';
import { runtimeTestsReferenceRoot } from './testPaths.mjs';

const eventFlagsFixturePath = path.join(runtimeTestsReferenceRoot, 'fixtures/event_flags.fixture.json');

async function exists(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('fixtureRoot does not copy live mutable player, flag, conversation, or character continuity state', async () => {
  const root = await fixtureRoot('magic-adv-fixture-hygiene-');
  try {
    assert.equal(await exists(path.join(root, 'game_data/runtime/player_parameters.json')), false);
    assert.equal(await exists(path.join(root, 'game_data/player_inventory.json')), false);
    assert.equal(await exists(path.join(root, 'game_data/logs/conversations')), false);
    assert.equal(await exists(path.join(root, 'game_data/save_slots')), false);
    const eventFlags = JSON.parse(await fs.readFile(path.join(root, 'game_data/event_flags.json'), 'utf8'));
    const fixtureEventFlags = JSON.parse(await fs.readFile(eventFlagsFixturePath, 'utf8'));
    assert.deepEqual(eventFlags, fixtureEventFlags);
    assert.equal(eventFlags.flags.some((flag) => flag.id === 'event.opening_mentor_intro.ready'), true);
    assert.deepEqual(await fs.readdir(path.join(root, 'game_data/characters/lina/memory')), []);
    assert.deepEqual(await fs.readdir(path.join(root, 'game_data/characters/lina/work_records')), []);
    const linaFlags = JSON.parse(await fs.readFile(path.join(root, 'game_data/characters/lina/flags.json'), 'utf8'));
    assert.deepEqual(linaFlags, {
      character_id: 'lina',
      flags: {
        'knowledge.lina.player_checked_garden_label': false,
        'relationship.lina.trust': 0,
        'condition.minor.lina_worried': false
      }
    });
    assert.equal(await exists(path.join(root, 'game_data/characters/character_001/profile.json')), true);
    assert.equal(await exists(path.join(root, 'game_data/characters/character_001/flags.json')), false);
    assert.equal(await exists(path.join(root, 'game_data/characters/character_001/skills.json')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
