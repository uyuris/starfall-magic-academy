import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { runTraining, skipTraining } from '../src/training.mjs';

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

async function splitTrainingRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-training-split-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: {
      light: { min: 0, max: 100, label: '光魔法習熟度', value: 7 },
      dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 5 },
      fire: { min: 0, max: 100, label: '火魔法習熟度', value: 4 },
      water: { min: 0, max: 100, label: '水魔法習熟度', value: 6 },
      earth: { min: 0, max: 100, label: '土魔法習熟度', value: 3 },
      wind: { min: 0, max: 100, label: '風魔法習熟度', value: 2 }
    },
    abilities: {
      strength: { min: 0, max: 100, label: '筋力', value: 8 },
      agility: { min: 0, max: 100, label: '瞬発力', value: 9 },
      academics: { min: 0, max: 100, label: '学力', value: 10 },
      magical_power: { min: 0, max: 100, label: '魔力', value: 11 },
      charisma: { min: 0, max: 100, label: 'カリスマ', value: 12 }
    }
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-training',
    training_actions_used: 0,
    training_actions_limit: 6,
    global_flags: {},
    characters: {}
  });
  return root;
}

test('training completion requires an explicit post-content screen', async () => {
  const root = await splitTrainingRoot();
  await assert.rejects(
    () => runTraining({ root, trainingId: 'library_study', randomSeed: 1 }),
    /postTrainingScreen is required/
  );
  await assert.rejects(
    () => skipTraining({ root }),
    /postTrainingScreen is required/
  );
});

test('runTraining reads split runtime state and writes mutable runtime/player parameters without creating legacy game_data files', async () => {
  const root = await splitTrainingRoot();

  const result = await runTraining({ root, trainingId: 'library_study', randomSeed: 1, postTrainingScreen: 'academy-map' });

  assert.equal(result.training.id, 'library_study');
  assert.equal(result.training_day.id, 'light_day');
  assert.equal(result.training_progress.actions_used, 1);
  assert.equal(result.state.current_screen, 'academy-training');

  const savedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const savedParameters = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(savedState.training_actions_used, 1);
  assert.equal(savedParameters.magic.light.value >= 7, true);
  assert.equal(savedParameters.abilities.academics.value >= 10, true);
  assert.equal(await pathExists(path.join(root, 'app/config/world/settings.json')), false, 'training should not create a desktop world override file');

  await assert.rejects(fs.access(path.join(root, 'game_data/runtime_state.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/runtime/player_parameters.json')), { code: 'ENOENT' });
});

test('skipTraining completes the academy training week without changing player parameters', async () => {
  const root = await splitTrainingRoot();
  const beforeWorld = await readJson(root, 'data/definitions/game_data/world/settings.json');
  const beforeParameters = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  const result = await skipTraining({ root, postTrainingScreen: 'academy-map' });

  assert.equal(result.training.id, 'skip_training');
  assert.equal(result.training.name, '鍛錬をサボる');
  assert.equal(result.training_day.id, 'light_day');
  assert.equal(result.training_progress.actions_used, 6);
  assert.equal(result.training_progress.actions_limit, 6);
  assert.equal(result.training_progress.remaining_actions, 0);
  assert.equal(result.training_progress.completed, true);
  assert.equal(result.training_progress.next_day, null);
  assert.deepEqual(result.effects, []);
  assert.equal(result.state.current_screen, 'academy-map');
  assert.equal(result.state.training_actions_used, 0);
  assert.equal(result.state.training_actions_limit, 6);

  const savedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const savedParameters = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(savedState.current_screen, 'academy-map');
  assert.equal(savedState.training_actions_used, 0);
  assert.deepEqual(savedParameters, beforeParameters);
  assert.deepEqual(result.world.player_parameters, beforeParameters);
  assert.equal(await pathExists(path.join(root, 'app/config/world/settings.json')), false, 'skip training should not create a desktop world override file');
});
