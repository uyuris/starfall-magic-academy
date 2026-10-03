// 残す (a): LLM の命名を挟む装備クラフトが、命名の失敗や LM の不通で止まったときに、差し出した素材を減らす・装備を半端に足す壊れ方から、プレイヤーの所持品を守る（操作の原子性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  CRAFT_FLAVOR_MAX_LENGTH,
  craftWithLlmNaming
} from '../src/llm/craftNaming.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from '../src/dungeonMaterialCatalog.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

// ----- craft fixture (mirrors equipmentCraft.test.mjs) -----

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

function craftParams({ academics = 50, charisma = 50, magic = {} } = {}) {
  const magicGroup = {};
  for (const element of MATERIAL_ELEMENTS) magicGroup[element] = { value: magic[element] ?? 10 };
  return {
    magic: magicGroup,
    abilities: {
      strength: { value: 20 }, agility: { value: 20 }, academics: { value: academics },
      magical_power: { value: 20 }, charisma: { value: charisma }
    }
  };
}

function richInventory() {
  const items = [];
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) items.push({ item_id: `material_${element}_t${tier}`, quantity: 99 });
  }
  return { money: 100000, items };
}

async function seedEconomyDefinitions(root) {
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
}

async function craftRoot({ parameters, inventory, elapsedWeeks = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-craft-naming-'));
  await seedEconomyDefinitions(root);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: elapsedWeeks, characters: {} });
  if (parameters) await writeJson(root, 'data/mutable/game_data/runtime/player_parameters.json', parameters);
  if (inventory) await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory);
  return root;
}

async function namingRoot() {
  return craftRoot({ parameters: craftParams({ academics: 80, magic: { fire: 80 } }), inventory: richInventory(), elapsedWeeks: 4 });
}

const INVENTORY_PATH = 'data/mutable/game_data/player_inventory.json';
const NAMING_CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'test-model', timeout_ms: 5000 };

// A fetchImpl that replies with one OpenAI-compatible structured-JSON completion
// whose content is `content` (already a string, so a valid { name, flavor } candidate
// is JSON.stringify'd by the caller). Records every request so tests can assert the
// requested schema and count calls.
function structuredJsonFetch(content, calls) {
  return async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
}

async function inventorySnapshot(root) {
  const inventory = await readJson(root, INVENTORY_PATH);
  return { money: inventory.money, items: inventory.items };
}

// ----- craftWithLlmNaming (orchestration) -----

test('craftWithLlmNaming fails fast on each gate violation with nothing consumed and no retry', async () => {
  const recipeId = 'craft_weapon_sword_fire_t2';
  const violations = [
    { label: 'wrong schema', content: JSON.stringify({ name: '刀' }), match: /keys must be exactly/ },
    { label: 'extra key', content: JSON.stringify({ name: '刀', flavor: 'x', rarity: 'S' }), match: /keys must be exactly/ },
    { label: 'empty name', content: JSON.stringify({ name: '', flavor: '説明。' }), match: /name must not be empty/ },
    { label: 'over-long flavor', content: JSON.stringify({ name: '刀', flavor: 'あ'.repeat(CRAFT_FLAVOR_MAX_LENGTH + 1) }), match: /flavor must be at most/ },
    { label: 'forbidden symbol', content: JSON.stringify({ name: '「刀」', flavor: '説明。' }), match: /must not contain quotation or bracket symbols/ },
    { label: 'malformed json', content: 'not json at all', match: /structured JSON parse failed/ }
  ];

  for (const violation of violations) {
    const root = await namingRoot();
    const calls = [];
    const before = await inventorySnapshot(root);

    await assert.rejects(
      craftWithLlmNaming({ root, recipe_id: recipeId, config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(violation.content, calls) }),
      violation.match,
      violation.label
    );

    assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] }, `${violation.label}: no instance was appended`);
    assert.deepEqual(await inventorySnapshot(root), before, `${violation.label}: inventory is untouched`);
    assert.equal(calls.length, 1, `${violation.label}: the LLM was called once and not retried`);
  }
});

test('craftWithLlmNaming fails fast when the LLM transport is unreachable, consuming nothing', async () => {
  const root = await namingRoot();
  const before = await inventorySnapshot(root);
  const unreachableFetch = async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:9');
    error.code = 'ECONNREFUSED';
    throw error;
  };

  await assert.rejects(
    craftWithLlmNaming({ root, recipe_id: 'craft_weapon_sword_fire_t2', config: NAMING_CONFIG, fetchImpl: unreachableFetch }),
    (error) => error.code === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );

  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] });
  assert.deepEqual(await inventorySnapshot(root), before);
});

test('craftWithLlmNaming fails fast when LM Studio is not configured, consuming nothing', async () => {
  const root = await namingRoot();
  const before = await inventorySnapshot(root);

  await assert.rejects(
    craftWithLlmNaming({ root, recipe_id: 'craft_weapon_sword_fire_t2', config: { base_url: '', chat_model: '' }, fetchImpl: async () => { throw new Error('fetch must not be reached when unconfigured'); } }),
    (error) => error.code === 'LMSTUDIO_CONFIG_REQUIRED'
  );

  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] });
  assert.deepEqual(await inventorySnapshot(root), before);
});
