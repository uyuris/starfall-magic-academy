import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { loadWorldSettings, updatePlayerParameters, updateWorldDescription } from '../src/worldSettings.mjs';
import { projectRoot as repoProjectRoot } from './testPaths.mjs';

const sourceProjectRoot = repoProjectRoot;

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createSplitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-world-settings-'));
  await fs.mkdir(path.join(root, 'data/definitions/game_data/world'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/seeds/game_data/runtime'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/mutable/game_data'), { recursive: true });
  await fs.mkdir(path.join(root, 'app/config'), { recursive: true });

  await fs.copyFile(
    path.join(sourceProjectRoot, 'data/definitions/game_data/world/settings.json'),
    path.join(root, 'data/definitions/game_data/world/settings.json')
  );
  await fs.copyFile(
    path.join(sourceProjectRoot, 'data/seeds/game_data/runtime/player_parameters.json'),
    path.join(root, 'data/seeds/game_data/runtime/player_parameters.json')
  );
  return root;
}

test('loadWorldSettings reads split next-project settings and seeds through the migrated layout', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const settings = await loadWorldSettings({
    root,
    state: {
      global_flags: {
        'story.archive_intro_done': true
      }
    }
  });

  assert.equal(typeof settings.academy_name, 'string');
  assert.equal(typeof settings.player_name, 'string');
  assert.equal(typeof settings.world_description_base, 'string');
  assert.equal(typeof settings.player_parameters, 'object');
  assert.equal(typeof settings.player_parameters.magic?.light?.value, 'number');
  assert.equal(typeof settings.player_parameters.abilities?.strength?.value, 'number');
  assert.equal(await pathExists(path.join(root, 'app/config/world/settings.json')), false, 'loading canonical settings alone should not materialize a desktop override file');
});

test('updateWorldDescription persists only explicit desktop override fields under configRoot without mutating canonical definitions', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const updated = await updateWorldDescription({
    root,
    playerName: '綾乃',
    worldDescription: '新しい学院設定'
  });

  assert.equal(updated.player_name, '綾乃');
  assert.equal(updated.world_description, '新しい学院設定');

  const savedSettings = await readJson(root, 'app/config/world/settings.json');
  const authoredSettings = await readJson(root, 'data/definitions/game_data/world/settings.json');

  assert.deepEqual(savedSettings, {
    player_name: '綾乃',
    world_description: '新しい学院設定'
  }, 'desktop override should store only explicitly overridden world fields');
  assert.notEqual(authoredSettings.player_name, '綾乃');
  assert.notEqual(authoredSettings.world_description, '新しい学院設定');
  assert.equal(await pathExists(path.join(root, 'data/mutable/game_data/runtime/player_parameters.json')), false, 'world static update should not create mutable player-parameter files as a side effect');

  await assert.rejects(fs.access(path.join(root, 'game_data/world/settings.json')), { code: 'ENOENT' });
});

test('updatePlayerParameters persists mutable player parameters without creating a desktop world override file', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const updated = await updatePlayerParameters({
    root,
    playerParameters: {
      magic: {
        light: 42
      },
      abilities: {
        strength: 17
      }
    }
  });

  const savedParameters = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(savedParameters.magic.light.value, 42);
  assert.equal(savedParameters.abilities.strength.value, 17);
  assert.equal(updated.player_parameters.magic.light.value, 42);
  assert.equal(await pathExists(path.join(root, 'app/config/world/settings.json')), false, 'stat-only updates should not create a world override file');
});

test('loadWorldSettings merges partial desktop world overrides onto authored definitions', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await writeJson(root, 'app/config/world/settings.json', {
    player_name: 'エア',
    world_description: 'config side world settings'
  });

  const settings = await loadWorldSettings({ root });

  assert.equal(settings.academy_name, '星灯魔法学院');
  assert.equal(settings.player_name, 'エア');
  assert.equal(settings.world_description_base, 'config side world settings');
  assert.equal(Array.isArray(settings.world_condition_texts), true);
});


test('authored world description keeps model speech constraints in prompt definitions instead of world settings', async () => {
  const authoredSettings = await readJson(sourceProjectRoot, 'data/definitions/game_data/world/settings.json');
  const promptDefinitions = await readJson(sourceProjectRoot, 'data/definitions/game_data/prompt/character_speech_constraints.json');

  assert.doesNotMatch(authoredSettings.world_description, /「最高」|直前までの会話|自らの肩書き|センスオブワンダー|行動の主体/);
  assert.equal(Array.isArray(authoredSettings.world_condition_texts), true);
  assert.equal(authoredSettings.world_condition_texts.some((entry) => entry.id === 'knowledge.necromancy_discussed.world_text'), true);

  const gemmaProfile = promptDefinitions.profiles?.find((profile) => profile.id === 'gemma4_31b');
  assert.ok(gemmaProfile, 'Gemma4 31B speech-constraint profile should exist');
  assert.ok(
    Array.isArray(gemmaProfile.constraints) && gemmaProfile.constraints.length > 0,
    'Gemma4 31B speech-constraint profile should carry constraints in prompt definitions'
  );
});
