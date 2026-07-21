import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ensureSelectableCharacterStorage } from '../src/characterCatalog.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { ensureElectronRuntimeWorkspace } from '../src/electron/runtimeWorkspace.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, value, 'utf8');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function selectableCharacterProfile(characterId = 'character_001') {
  return {
    character_id: characterId,
    display_name: 'テスト生徒',
    school_year: '1年',
    club: '図書委員',
    identity: '静かな図書委員',
    prompt_description: '図書室で静かに案内する。',
    speaking_basis: '丁寧で落ち着いた口調。',
    parameter_attitude_type: 'equal_any_respect_average',
    asset_state: {
      expression: 'neutral',
      standee_variant_id: 'standee_character_01',
      face_emotion_variant_id: 'face_neutral'
    },
    parameters: {
      magic: {
        light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 },
        dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 20 },
        fire: { min: 0, max: 100, label: '火魔法習熟度', value: 18 },
        water: { min: 0, max: 100, label: '水魔法習熟度', value: 22 },
        earth: { min: 0, max: 100, label: '土魔法習熟度', value: 19 },
        wind: { min: 0, max: 100, label: '風魔法習熟度', value: 21 }
      },
      abilities: {
        strength: { min: 0, max: 100, label: '筋力', value: 24 },
        agility: { min: 0, max: 100, label: '瞬発力', value: 26 },
        academics: { min: 0, max: 100, label: '学力', value: 61 },
        magical_power: { min: 0, max: 100, label: '魔力', value: 35 },
        charisma: { min: 0, max: 100, label: 'カリスマ', value: 29 }
      }
    }
  };
}

test('ensureElectronRuntimeWorkspace materializes writable desktop roots without resource symlinks and still routes reads to packaged resources', async (t) => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-resources-'));
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-userdata-'));
  t.after(async () => {
    await fs.rm(resourceRoot, { recursive: true, force: true });
    await fs.rm(userDataRoot, { recursive: true, force: true });
  });

  await writeText(resourceRoot, 'app/public/index.html', '<!doctype html><html><body>electron runtime</body></html>');
  await writeJson(resourceRoot, 'app/config/lmstudio.example.json', {
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 120000,
    stream: true,
    mock_provider_enabled: true
  });
  await writeJson(resourceRoot, 'data/definitions/game_data/locations.json', [{ id: 'courtyard', name: '中庭' }]);
  await writeJson(resourceRoot, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'resource world settings',
    world_condition_texts: []
  });
  await writeJson(resourceRoot, 'data/seeds/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'courtyard'
  });
  await writeText(resourceRoot, 'content/characters/lina/profile.json', JSON.stringify({ character_id: 'lina' }));
  await writeText(resourceRoot, 'assets/canonical/title/title.jpg', 'jpg');

  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot, userDataRoot });

  assert.equal(workspace.projectRoot, path.join(userDataRoot, 'runtime-project'));
  assert.equal(workspace.publicRoot, path.join(resourceRoot, 'app/public'));
  assert.equal(workspace.canonicalAssetsRoot, path.join(resourceRoot, 'assets/canonical'));
  assert.equal(workspace.definitionsRoot, path.join(resourceRoot, 'data/definitions/game_data'));
  assert.equal(workspace.seedsRoot, path.join(resourceRoot, 'data/seeds/game_data'));
  assert.equal(workspace.characterContentRoot, path.join(resourceRoot, 'content/characters'));
  assert.equal(workspace.mutableRoot, path.join(workspace.projectRoot, 'data/mutable/game_data'));
  assert.equal(workspace.configRoot, path.join(workspace.projectRoot, 'app/config'));
  assert.equal(workspace.lmStudioConfigPath, path.join(workspace.configRoot, 'lmstudio.json'));

  const lmStudioConfig = JSON.parse(await fs.readFile(workspace.lmStudioConfigPath, 'utf8'));
  assert.equal(lmStudioConfig.stream, true);
  assert.equal(lmStudioConfig.thinking_effort, null);

  assert.equal(await pathExists(path.join(workspace.projectRoot, 'data/definitions')), false);
  assert.equal(await pathExists(path.join(workspace.projectRoot, 'data/seeds')), false);
  assert.equal(await pathExists(path.join(workspace.projectRoot, 'content/characters')), false);
  assert.equal(await pathExists(path.join(workspace.projectRoot, 'assets/canonical')), false);

  const storage = createStorageApi({ root: workspace.projectRoot });
  const [locations, lina] = await Promise.all([
    storage.readJson('game_data/locations.json'),
    storage.readCharacter('lina')
  ]);
  assert.deepEqual(locations, [{ id: 'courtyard', name: '中庭' }]);
  assert.equal(lina.profile.character_id, 'lina');

  await storage.writeJson('game_data/runtime_state.json', { version: 2, current_location_id: 'courtyard' });
  assert.equal(await pathExists(path.join(resourceRoot, 'data/mutable/game_data/runtime_state.json')), false);
  assert.equal(await pathExists(path.join(workspace.projectRoot, 'data/mutable/game_data/runtime_state.json')), true);
});

test('ensureElectronRuntimeWorkspace repairs an existing lmstudio.json that is missing stream', async (t) => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-resources-'));
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-userdata-'));
  t.after(async () => {
    await fs.rm(resourceRoot, { recursive: true, force: true });
    await fs.rm(userDataRoot, { recursive: true, force: true });
  });

  await writeJson(resourceRoot, 'app/config/lmstudio.example.json', {
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 120000,
    stream: true,
    mock_provider_enabled: true
  });
  await fs.mkdir(path.join(userDataRoot, 'runtime-project/app/config'), { recursive: true });
  await fs.writeFile(path.join(userDataRoot, 'runtime-project/app/config/lmstudio.json'), `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://192.168.11.3:1234/v1',
    chat_model: 'lmstudio-community/gemma-4-31b-it',
    reflection_model: 'lmstudio-community/gemma-4-31b-it'
  }, null, 2)}\n`, 'utf8');

  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot, userDataRoot });
  const lmStudioConfig = JSON.parse(await fs.readFile(workspace.lmStudioConfigPath, 'utf8'));
  assert.equal(lmStudioConfig.stream, true);
  assert.equal(lmStudioConfig.thinking_effort, null);
  assert.equal(lmStudioConfig.base_url, 'http://192.168.11.3:1234/v1');
});

test('ensureElectronRuntimeWorkspace preserves explicit stream false while repairing missing thinking effort', async (t) => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-resources-'));
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-userdata-'));
  t.after(async () => {
    await fs.rm(resourceRoot, { recursive: true, force: true });
    await fs.rm(userDataRoot, { recursive: true, force: true });
  });

  await writeJson(resourceRoot, 'app/config/lmstudio.example.json', {
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 120000,
    stream: true,
    thinking_effort: null,
    mock_provider_enabled: true
  });
  await fs.mkdir(path.join(userDataRoot, 'runtime-project/app/config'), { recursive: true });
  await fs.writeFile(path.join(userDataRoot, 'runtime-project/app/config/lmstudio.json'), `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://192.168.11.3:1234/v1',
    chat_model: 'lmstudio-community/gemma-4-31b-it',
    reflection_model: 'lmstudio-community/gemma-4-31b-it',
    stream: false
  }, null, 2)}\n`, 'utf8');

  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot, userDataRoot });
  const lmStudioConfig = JSON.parse(await fs.readFile(workspace.lmStudioConfigPath, 'utf8'));
  assert.equal(lmStudioConfig.stream, false);
  assert.equal(lmStudioConfig.thinking_effort, null);
  assert.equal(lmStudioConfig.base_url, 'http://192.168.11.3:1234/v1');
});

test('packaged runtime character initialization keeps canonical profiles read-only while creating only mutable character state', async (t) => {
  const resourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-character-resources-'));
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-electron-character-userdata-'));
  t.after(async () => {
    await fs.rm(resourceRoot, { recursive: true, force: true });
    await fs.rm(userDataRoot, { recursive: true, force: true });
  });

  await writeJson(resourceRoot, 'content/characters/character_001/profile.json', selectableCharacterProfile('character_001'));
  const workspace = await ensureElectronRuntimeWorkspace({ resourceRoot, userDataRoot });
  const canonicalProfilePath = path.join(resourceRoot, 'content/characters/character_001/profile.json');
  const before = await fs.stat(canonicalProfilePath);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const initialized = await ensureSelectableCharacterStorage({ root: workspace.projectRoot, characterId: 'character_001' });
  const after = await fs.stat(canonicalProfilePath);

  assert.equal(initialized.profile.character_id, 'character_001');
  assert.equal(after.mtimeMs, before.mtimeMs, 'packaged canonical profile should remain read-only during runtime initialization');

  const mutableCharacterRoot = path.join(workspace.projectRoot, 'data/mutable/game_data/characters/character_001');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(mutableCharacterRoot, 'flags.json'), 'utf8')), {
    character_id: 'character_001',
    flags: {}
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(mutableCharacterRoot, 'skills.json'), 'utf8')), {
    character_id: 'character_001',
    skills: []
  });
  await fs.access(path.join(mutableCharacterRoot, 'memory'));
  await fs.access(path.join(mutableCharacterRoot, 'work_records'));
});
