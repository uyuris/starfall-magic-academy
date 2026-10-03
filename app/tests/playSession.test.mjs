// 残す (a): 新規ゲームの slot 採番が既存の有効な slot の id を取り、その save を上書きする壊れ方から、プレイヤーの save を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { initializeNewPlayArea as initializeNewPlayAreaCore } from '../src/playSession.mjs';
import { baselineRuntimeState } from './helpers.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

function initializeNewPlayArea(options) {
  return initializeNewPlayAreaCore({ playMode: 'loop', ...options });
}

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitPlaySessionRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-play-session-split-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    ...baselineRuntimeState,
    disabled_stage_flag_judgment_flows: {
      'stage.herbology_garden.herbology_garden_blue_glass_token': true
    }
  });
  await writeSplitJson(root, 'content/characters/character_001/profile.json', packagedSelectableCharacterProfile('character_001'));
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    character_id: 'lina',
    display_name: 'リナ',
    identity: '薬草園の案内役',
    visual_set_id: 'visual_set_001',
    prompt_description: 'split root mentor',
    speaking_basis: 'split root speaking',
    available_expressions: ['neutral'],
    parameters: {
      magic: {
        light: { min: 0, max: 100, label: '光魔法習熟度', value: 50 },
        dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 40 },
        fire: { min: 0, max: 100, label: '火魔法習熟度', value: 30 },
        water: { min: 0, max: 100, label: '水魔法習熟度', value: 20 },
        earth: { min: 0, max: 100, label: '土魔法習熟度', value: 10 },
        wind: { min: 0, max: 100, label: '風魔法習熟度', value: 60 }
      },
      abilities: {
        strength: { min: 0, max: 100, label: '筋力', value: 50 },
        agility: { min: 0, max: 100, label: '瞬発力', value: 45 },
        academics: { min: 0, max: 100, label: '学力', value: 65 },
        magical_power: { min: 0, max: 100, label: '魔力', value: 55 },
        charisma: { min: 0, max: 100, label: 'カリスマ', value: 35 }
      }
    }
  });
  return root;
}

function packagedSelectableCharacterProfile(characterId = 'character_001') {
  return {
    character_id: characterId,
    display_name: 'テスト生徒',
    identity: '静かな図書委員',
    parameter_attitude_type: 'equal_any_respect_average',
    prompt_description: '図書室で静かに案内する。',
    speaking_basis: '丁寧で落ち着いた口調。',
    available_expressions: ['neutral'],
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

test('initializeNewPlayArea generates the next slot id from valid slots only when orphan directories exist', async (t) => {
  const root = await splitPlaySessionRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  for (let n = 1; n <= 10; n += 1) {
    await fs.mkdir(path.join(root, 'data/mutable/game_data/play/slots', `slot_${String(n).padStart(3, '0')}`), { recursive: true });
  }
  await initializeNewPlayArea({ root, slotId: 'slot_011' });
  await initializeNewPlayArea({ root, slotId: 'slot_012' });

  const initialized = await initializeNewPlayArea({ root });

  assert.equal(initialized.slot.slot_id, 'slot_013');
});
