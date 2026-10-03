// 残す (a): ホムンクルスの錬成が失敗したとき（枠が満杯・素材不足・生成の失敗）に、差し出した素材を減らす壊れ方から、プレイヤーの所持品を守る（操作の原子性）。
// 錬成室 backend B2: synthesis atomicity. The LLM-backed paths are exercised with a deterministic mock fetchImpl
// (no live LM).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fixtureRoot, baselineRuntimeState, writeJson, readJson } from './helpers.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { loadHomunculiSurface } from '../src/homunculusSurface.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from '../src/dungeonMaterialCatalog.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions } from '../src/parameters.mjs';
import {
  synthesizeHomunculus
} from '../src/homunculusAtelier.mjs';

const NOW = '2026-07-08T00:00:00.000Z';

// A deterministic LM: canned persona / skeleton / face / farewell / epitaph responses keyed off the prompt.
// The face selection picks the FIRST candidate id listed in the prompt (whatever the closed set actually is),
// so the mock always chooses a valid, used-excluded face without knowing the surface.
function mockLmConfig() {
  return { base_url: 'http://mock.local/v1', chat_model: 'mock-chat', stream: false, timeout_ms: 5000, thinking_effort: null };
}

function cannedFor(prompt) {
  if (prompt.includes('【紹介文の書き方】')) {
    return '紹介文: しずかで優しいテスト用ホムンクルス。錬成室で灯された身を受け止め、創り主のそばにいられることを大切に思っている。\n話し方: 一人称は「わたし」。おだやかに、ゆっくりと話す。';
  }
  if (prompt.includes('人物の種（骨子）を考える')) {
    return 'しずかで夜が似合う。星の残光をながめるのが好きな、少し内向的な気質。';
  }
  if (prompt.includes('候補の顔一覧')) {
    const match = /\bhp_\d{3}\b/.exec(prompt);
    if (!match) throw new Error('mock face selection found no candidate in the prompt');
    return JSON.stringify({ face_id: match[0] });
  }
  if (prompt.includes('別れを告げる')) {
    return 'あなたに灯してもらえて、わたしは本当に幸せでした。一緒に過ごした時間を、決して忘れません。灯が消えても、あなたへの想いは変わりません。どうか、どうか、お元気で。さようなら、わたしの創り主さん。';
  }
  if (prompt.includes('銘（銘文）')) {
    return '静かな夜を愛した、優しい灯。';
  }
  throw new Error(`unexpected mock prompt:\n${prompt.slice(0, 120)}`);
}

function mockFetch() {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.messages[0].content;
    const content = cannedFor(prompt);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
}

// A fetchImpl that always fails the chat call (unreachable LM) — for the "generation failure spends nothing".
function failingFetch() {
  return async () => {
    const error = new TypeError('fetch failed');
    throw error;
  };
}

const MAGIC_KEYS = magicParameterDefinitions.map((definition) => definition.key);
const ABILITY_KEYS = abilityParameterDefinitions.map((definition) => definition.key);

// A uniform hero parameter block at a single value (raw {value} shape, which the raw-read accepts).
function uniformPlayerParameters(value) {
  return {
    magic: Object.fromEntries(MAGIC_KEYS.map((key) => [key, { value }])),
    abilities: Object.fromEntries(ABILITY_KEYS.map((key) => [key, { value }]))
  };
}

const DEFAULT_PLAYER_PARAMETERS = uniformPlayerParameters(50);

// A rich inventory holding every one of the 24 element×tier dungeon materials (overridable per id), so a
// synthesis can pick any 10-material combination. money is irrelevant now (there is no money cost).
function materialInventory(overrides = {}) {
  const items = [];
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) {
      const itemId = `material_${element}_t${tier}`;
      items.push({ item_id: itemId, quantity: overrides[itemId] ?? 40 });
    }
  }
  return { money: 0, items };
}

// The default synthesis materials arg: exactly 10 (a T4-light stack) — a valid, catalog-real 10-total pick.
const TEN_MATERIALS = [{ item_id: 'material_light_t4', quantity: 10 }];

// A fixed rng (r = 1.0, deterministic ability picks) for synthesis tests that do not assert exact parameters.
const fixedRng = () => 0.5;

async function atelierRoot(t, { elapsedWeeks = 5, inventory = materialInventory(), parameters = DEFAULT_PLAYER_PARAMETERS } = {}) {
  const root = await fixtureRoot('magic-adv-atelier-', {
    runtimeState: { ...baselineRuntimeState, elapsed_weeks: elapsedWeeks }
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, 'game_data/player_inventory.json', inventory);
  if (parameters) await writeJson(root, 'game_data/runtime/player_parameters.json', parameters);
  return root;
}

async function actorDirExists(root, homunculusId) {
  try {
    await fs.access(path.join(root, 'game_data/homunculi', homunculusId, 'profile.json'));
    return true;
  } catch {
    return false;
  }
}

// ----- synthesis (atomic) -----

test('a full roster fails fast before consuming anything', async (t) => {
  const root = await atelierRoot(t);
  for (const name of ['a', 'b', 'c']) {
    await synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name, skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW });
  }
  const before = await readJson(root, 'game_data/player_inventory.json');
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: mockFetch(), mode: 'manual', name: 'd', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW }),
    (error) => error.statusCode === 409 && error.errorCode === 'HOMUNCULUS_ROSTER_FULL'
  );
  assert.deepEqual(await readJson(root, 'game_data/player_inventory.json'), before, 'a full-roster reject spends nothing');
});

test('an insufficient-material synthesis fails fast before any generation and spends nothing', async (t) => {
  // Own only 3 of the requested 10 material_light_t4 (every other material also short of 10).
  const root = await atelierRoot(t, { inventory: { money: 0, items: [{ item_id: 'material_light_t4', quantity: 3 }] } });
  const before = await readJson(root, 'game_data/player_inventory.json');
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW }),
    /insufficient_item_quantity/
  );
  assert.deepEqual(await readJson(root, 'game_data/player_inventory.json'), before);
  assert.equal((await loadHomunculiSurface({ storage: createStorageApi({ root }) })).active.length, 0);
});

test('a generation failure leaves materials unconsumed and no actor directory', async (t) => {
  const root = await atelierRoot(t);
  const before = await readJson(root, 'game_data/player_inventory.json');
  await assert.rejects(
    synthesizeHomunculus({ root, config: mockLmConfig(), fetchImpl: failingFetch(), mode: 'manual', name: 'x', skeleton: 'x', materials: TEN_MATERIALS, rng: fixedRng, now: NOW })
  );
  assert.deepEqual(await readJson(root, 'game_data/player_inventory.json'), before, 'materials untouched on generation failure');
  assert.equal(await actorDirExists(root, 'homunculus_001'), false, 'no actor directory seeded');
  assert.equal((await loadHomunculiSurface({ storage: createStorageApi({ root }) })).active.length, 0);
});
