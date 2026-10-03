// 残す (a): キャラ削除 script が save と slot の識別子を取り違えて書き換える壊れ方と、dry-run が save や slot に書き込む壊れ方から、プレイヤーの save を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharacterDeletionPlan, deleteFlaggedCharacters } from '../src/characterDeletion.mjs';

function pad(index) {
  return String(index).padStart(3, '0');
}

function characterId(index) {
  return `character_${pad(index)}`;
}

function visualSetId(index) {
  return `visual_set_${pad(index)}`;
}

async function pathExists(targetPath) {
  return await fs.access(targetPath).then(() => true).catch(() => false);
}

async function writeText(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, value, 'utf8');
}

async function writeJson(root, relativePath, value) {
  await writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function readText(root, relativePath) {
  return await fs.readFile(path.join(root, relativePath), 'utf8');
}

function fixtureProfile(index) {
  const id = characterId(index);
  const visualId = visualSetId(index);
  return {
    character_id: id,
    display_name: `Character ${pad(index)}`,
    identity: `Identity ${pad(index)}`,
    visual_set_id: visualId,
    source_image: `character_visual_sets/${visualId}/face_emotions/neutral.jpg`,
    asset_state: {
      character_id: id,
      visual_set_id: visualId,
      standee_variant_id: 'standee_character_01'
    }
  };
}

function fixtureVisualManifest(index) {
  const visualId = visualSetId(index);
  return {
    visual_set_id: visualId,
    fixture_marker: `Visual ${pad(index)}`,
    source_sheet: {
      path: `../../source_images/${visualId}_emotion16_source_sheet.jpg`,
      width: 2000,
      height: 2000
    }
  };
}

function fixtureRuntimeState() {
  return {
    version: 1,
    current_interaction_character_id: null,
    active_character_ids: [],
    current_enemy_character_ids: [],
    current_buddy_character_id: null,
    ending_character_id: null,
    characters: {},
    event_flag_sources: {},
    event_completion_sources: {}
  };
}

async function listSnapshot(root) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push([
          path.relative(root, fullPath).split(path.sep).join('/'),
          await fs.readFile(fullPath, 'utf8')
        ]);
      }
    }
  }
  await walk(root);
  return files;
}

async function makeFixture(t, { count, flagged }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-character-delete-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await writeText(root, 'app/src/characterCatalog.mjs', `const characterCount = ${count};\nexport { characterCount };\n`);
  await writeJson(root, 'content/characters/delete-flags.json', { flagged });
  await writeJson(root, 'content/characters/manifest.json', [
    ...Array.from({ length: Math.min(50, count) }, (_, index) => ({
      character_id: characterId(index + 1),
      copied_files: ['profile.json', 'skills.json']
    })),
    { character_id: 'lina', copied_files: ['profile.json'] }
  ]);
  await writeJson(root, 'data/seeds/game_data/runtime_state.json', fixtureRuntimeState());

  for (let index = 1; index <= count; index += 1) {
    const id = characterId(index);
    const visualId = visualSetId(index);
    await writeJson(root, `content/characters/${id}/profile.json`, fixtureProfile(index));
    await writeJson(root, `assets/canonical/character_visual_sets/${visualId}/manifest.json`, fixtureVisualManifest(index));
    await writeText(root, `assets/canonical/character_visual_sets/${visualId}/identity_notes.md`, `# ${visualId} Identity Notes\n\nVisual ${pad(index)}\n`);
    await writeText(root, `assets/canonical/source_images/${visualId}_emotion16_source_sheet.jpg`, `sheet-${pad(index)}\n`);
  }
  await writeJson(root, 'content/creatures/creature_001/profile.json', {
    creature_id: 'creature_001',
    character_id: characterId(count),
    note: 'creature references are not playable character slots'
  });
  return root;
}

test('seed and mutable save data clear deleted identities before remapping moved identities', async (t) => {
  const root = await makeFixture(t, { count: 6, flagged: ['character_003'] });
  const runtimeState = {
    version: 1,
    current_interaction_character_id: 'character_006',
    active_character_ids: ['character_003', 'character_006', 'character_004'],
    current_enemy_character_ids: ['character_003', 'character_006'],
    current_buddy_character_id: 'character_003',
    ending_character_id: 'character_003',
    characters: {
      character_003: {
        character_id: 'character_003',
        flags: {
          'relationship.character_003.buddy': true
        }
      },
      character_006: {
        character_id: 'character_006',
        flags: {
          'relationship.character_006.enemy': true
        }
      }
    },
    event_flag_sources: {
      deleted: { character_id: 'character_003' },
      moved: { character_id: 'character_006' }
    },
    event_completion_sources: {
      moved: { character_id: 'character_006' }
    }
  };
  await writeJson(root, 'data/seeds/game_data/runtime_state.json', runtimeState);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', runtimeState);
  await writeJson(root, 'data/mutable/game_data/characters/character_003/flags.json', {
    character_id: 'character_003',
    flags: {
      'relationship.character_003.buddy': true
    }
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_006/flags.json', {
    character_id: 'character_006',
    flags: {
      'relationship.character_006.buddy': true,
      'relationship.character_003.enemy': true
    }
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_006/memory/memory_001.json', {
    character_id: 'character_006',
    tags: ['character_006', 'character_003', 'keep']
  });
  await writeText(root, 'data/mutable/game_data/characters/character_006/work_records/note.md', 'work by character_006\n');
  await writeJson(root, 'data/mutable/game_data/logs/conversations/log_001.json', {
    actor: 'character_006',
    participants: ['character_003', 'character_006'],
    flags: {
      'relationship.character_003.buddy': true,
      'relationship.character_006.enemy': true
    }
  });
  await writeJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/characters/character_006/skills.json', {
    character_id: 'character_006',
    skills: [{ owner: 'character_006' }]
  });

  await deleteFlaggedCharacters({ root, apply: true });

  const seedState = await readJson(root, 'data/seeds/game_data/runtime_state.json');
  assert.equal(seedState.current_interaction_character_id, 'character_003');
  assert.deepEqual(seedState.active_character_ids, ['character_003', 'character_004']);
  assert.deepEqual(seedState.current_enemy_character_ids, ['character_003']);
  assert.equal(seedState.current_buddy_character_id, null);
  assert.equal(seedState.ending_character_id, null);
  assert.deepEqual(Object.keys(seedState.characters), ['character_003']);
  assert.equal(seedState.characters.character_003.character_id, 'character_003');
  assert.deepEqual(seedState.characters.character_003.flags, {
    'relationship.character_003.enemy': true
  });
  assert.equal(seedState.event_flag_sources.deleted.character_id, null);
  assert.equal(seedState.event_flag_sources.moved.character_id, 'character_003');

  assert.equal(await pathExists(path.join(root, 'data/mutable/game_data/characters/character_006')), false);
  assert.equal(await pathExists(path.join(root, 'data/mutable/game_data/characters/character_003')), true);
  const movedFlags = await readJson(root, 'data/mutable/game_data/characters/character_003/flags.json');
  assert.deepEqual(movedFlags, {
    character_id: 'character_003',
    flags: {
      'relationship.character_003.buddy': true
    }
  });
  assert.deepEqual(await readJson(root, 'data/mutable/game_data/characters/character_003/memory/memory_001.json'), {
    character_id: 'character_003',
    tags: ['character_003', 'keep']
  });
  assert.equal(await readText(root, 'data/mutable/game_data/characters/character_003/work_records/note.md'), 'work by character_003\n');
  assert.deepEqual(await readJson(root, 'data/mutable/game_data/logs/conversations/log_001.json'), {
    actor: 'character_003',
    participants: ['character_003'],
    flags: {
      'relationship.character_003.enemy': true
    }
  });
  assert.deepEqual(await readJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/characters/character_003/skills.json'), {
    character_id: 'character_003',
    skills: [{ owner: 'character_003' }]
  });
});

test('dry-run reports mutable save and slot impact paths without mutating them', async (t) => {
  const root = await makeFixture(t, { count: 6, flagged: ['character_003'] });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    current_interaction_character_id: 'character_006',
    active_character_ids: ['character_003', 'character_006']
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_003/flags.json', {
    character_id: 'character_003',
    flags: {}
  });
  await writeJson(root, 'data/mutable/game_data/characters/character_006/memory/memory_001.json', {
    character_id: 'character_006',
    tags: ['character_006']
  });
  await writeJson(root, 'data/mutable/game_data/logs/conversations/log_001.json', {
    actor: 'character_006',
    participants: ['character_003', 'character_006']
  });
  await writeJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/characters/character_003/flags.json', {
    character_id: 'character_003',
    flags: {}
  });
  await writeJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/characters/character_006/skills.json', {
    character_id: 'character_006',
    skills: []
  });
  const before = await listSnapshot(root);

  const plan = await createCharacterDeletionPlan({ root });

  assert.ok(plan.affected_files.includes('data/mutable/game_data/runtime_state.json'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/characters/character_003'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/characters/character_006'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/characters/character_003/memory/memory_001.json'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/logs/conversations/log_001.json'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/play/slots/slot_001/game_data/characters/character_003'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/play/slots/slot_001/game_data/characters/character_006'));
  assert.ok(plan.affected_files.includes('data/mutable/game_data/play/slots/slot_001/game_data/characters/character_003/skills.json'));
  assert.deepEqual(await listSnapshot(root), before);
});
