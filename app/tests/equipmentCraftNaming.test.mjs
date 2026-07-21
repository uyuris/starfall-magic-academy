import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  CRAFT_NAME_MAX_LENGTH,
  CRAFT_FLAVOR_MAX_LENGTH,
  CRAFT_FLAVOR_SOFT_TARGET_LENGTH,
  CRAFT_FLAVOR_CONSTRAINTS,
  buildCraftNamingPrompt,
  selectCraftFlavorConstraint,
  validateCraftNaming,
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

// ----- buildCraftNamingPrompt (pure) -----

test('buildCraftNamingPrompt embeds kind, element, tier, quality, and the bonus summary of the confirmed roll', () => {
  const prompt = buildCraftNamingPrompt({
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    quality: 'masterwork',
    base_effects: { attack: 7, max_hp: 6 },
    bonus_effects: { attack: 3, max_hp: 4 }
  });
  assert.match(prompt, /種別: 武器（剣）/);
  assert.match(prompt, /属性: 火/);
  assert.match(prompt, /階級（格）: T2/);
  assert.match(prompt, /出来栄え（作りの精巧さ）: 傑作/);
  assert.match(prompt, /付加性能: 攻撃\+3、最大HP\+4/);
  assert.match(prompt, /基礎性能: 攻撃\+7、最大HP\+6/);
  assert.match(prompt, new RegExp(`最大${CRAFT_NAME_MAX_LENGTH}文字`));
  assert.match(prompt, new RegExp(`最大${CRAFT_FLAVOR_MAX_LENGTH}文字`));
});

test('buildCraftNamingPrompt renders an amulet without a weapon type', () => {
  const prompt = buildCraftNamingPrompt({
    kind: 'amulet',
    element: 'water',
    tier: 3,
    quality: 'fine',
    base_effects: { defense: 5, max_hp: 13 },
    bonus_effects: { defense: 1, max_hp: 2 }
  });
  assert.match(prompt, /種別: 護符/);
  assert.doesNotMatch(prompt, /武器/);
  assert.match(prompt, /属性: 水/);
  assert.match(prompt, /出来栄え（作りの精巧さ）: 良/);
});

test('buildCraftNamingPrompt fails fast on an unknown vocabulary value or a bad tier', () => {
  assert.throws(() => buildCraftNamingPrompt({ kind: 'trinket', element: 'fire', tier: 1, quality: 'common', base_effects: {}, bonus_effects: {} }), /kind must be weapon or amulet/);
  assert.throws(() => buildCraftNamingPrompt({ kind: 'weapon', weapon_type: 'axe', element: 'fire', tier: 1, quality: 'common', base_effects: {}, bonus_effects: {} }), /weapon_type is not a known value/);
  assert.throws(() => buildCraftNamingPrompt({ kind: 'amulet', element: 'plasma', tier: 1, quality: 'common', base_effects: {}, bonus_effects: {} }), /element is not a known value/);
  assert.throws(() => buildCraftNamingPrompt({ kind: 'amulet', element: 'fire', tier: 9, quality: 'common', base_effects: {}, bonus_effects: {} }), /tier must be an integer 1\.\.4/);
});

// ----- prompt contract: 2-axis guard, label-echo ban, constraint / prior-name lines -----

const SAMPLE_ROLL = { kind: 'weapon', weapon_type: 'staff', element: 'fire', tier: 4, quality: 'common', base_effects: { max_mp: 10 }, bonus_effects: { attack: 1 } };

test('buildCraftNamingPrompt renders the role reframe, both 2-axis-guard bullets, the label-echo ban and the anti-repeat line, and drops the old flat-label form', () => {
  const prompt = buildCraftNamingPrompt(SAMPLE_ROLL);
  // role reframe + tier=格 / quality=精巧さ axis glosses
  assert.match(prompt, /この工房で銘を刻む者として/);
  assert.match(prompt, /階級（格）: T4（格＝/);
  assert.match(prompt, /出来栄え（作りの精巧さ）: 並（作りの精巧さ＝/);
  // 2-axis independence guard — both bullets and the mixed-combo line
  assert.match(prompt, /格は装備の位。高い格は風格・重み・凄みを/);
  assert.match(prompt, /出来栄えは仕上げの精度だけ。/);
  assert.match(prompt, /格が高く出来栄えが低い装備は「位は高いが仕上げは粗い」/);
  // label-echo ban + anti-repeat + soft target
  assert.match(prompt, /ラベル語そのものを銘やフレーバーに書き写さない/);
  assert.match(prompt, /陳腐な決まり文句や毎回同じ言い回し/);
  assert.match(prompt, new RegExp(`${CRAFT_FLAVOR_SOFT_TARGET_LENGTH}文字程度、最大${CRAFT_FLAVOR_MAX_LENGTH}文字`));
  // old flat-label form is fully removed (no compat residue)
  assert.doesNotMatch(prompt, /階級（tier）:/);
  assert.doesNotMatch(prompt, /完成した装備に、固有の名前とフレーバー文を付ける/);
});

test('buildCraftNamingPrompt injects the 佇まい constraint with a world guard when supplied and omits it otherwise', () => {
  const withConstraint = buildCraftNamingPrompt(SAMPLE_ROLL, { flavor_constraint: { category: '量感', value: '岩のように重く無骨な' } });
  assert.match(withConstraint, /この一振りの佇まいには「岩のように重く無骨な」趣がある/);
  assert.match(withConstraint, /世界観（星灯魔法学院・魔法と属性の世界）から外れる語や現代語・実在の地名人名は使わない/);

  const withoutConstraint = buildCraftNamingPrompt(SAMPLE_ROLL);
  assert.doesNotMatch(withoutConstraint, /佇まい/);
});

test('buildCraftNamingPrompt hands off prior names only when the list is non-empty', () => {
  const withNames = buildCraftNamingPrompt(SAMPLE_ROLL, { prior_names: ['紅蓮の芯杖', '陽炎の理杖'] });
  assert.match(withNames, /この工房で既に付けた名前（重複・酷似を避ける）: 紅蓮の芯杖、陽炎の理杖/);

  const emptyNames = buildCraftNamingPrompt(SAMPLE_ROLL, { prior_names: [] });
  assert.doesNotMatch(emptyNames, /既に付けた名前/);
});

test('buildCraftNamingPrompt fails fast on invalid namingInputs', () => {
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, null), /namingInputs must be an object/);
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, []), /namingInputs must be an object/);
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, { flavor_constraint: { category: '未知', value: 'x' } }), /flavor_constraint category is not a known value/);
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, { flavor_constraint: { category: '量感', value: '存在しない趣' } }), /flavor_constraint value is not in category 量感/);
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, { flavor_constraint: { category: '量感' } }), /flavor_constraint keys must be exactly \{category, value\}/);
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, { prior_names: '紅蓮の芯杖' }), /prior_names must be an array/);
  assert.throws(() => buildCraftNamingPrompt(SAMPLE_ROLL, { prior_names: ['紅蓮の芯杖', ''] }), /prior_names must contain only non-empty strings/);
});

test('CRAFT_FLAVOR_CONSTRAINTS is a frozen closed set of unique values', () => {
  assert.ok(Object.isFrozen(CRAFT_FLAVOR_CONSTRAINTS));
  const all = [];
  for (const values of Object.values(CRAFT_FLAVOR_CONSTRAINTS)) {
    assert.ok(Object.isFrozen(values));
    assert.ok(values.length > 0);
    all.push(...values);
  }
  assert.equal(new Set(all).size, all.length, 'every constraint value is unique across categories');
});

test('selectCraftFlavorConstraint is deterministic, closed-set, and varies across seeds', () => {
  const first = selectCraftFlavorConstraint('slot|4|craft_weapon_staff_fire_t2|0');
  assert.deepEqual(selectCraftFlavorConstraint('slot|4|craft_weapon_staff_fire_t2|0'), first, 'same seed yields the same constraint');
  assert.ok(CRAFT_FLAVOR_CONSTRAINTS[first.category], 'category is a member of the closed set');
  assert.ok(CRAFT_FLAVOR_CONSTRAINTS[first.category].includes(first.value), 'value is a member of its category');
  const picks = new Set();
  for (let i = 0; i < 20; i += 1) picks.add(JSON.stringify(selectCraftFlavorConstraint(`seed|${i}`)));
  assert.ok(picks.size >= 2, 'different seeds produce more than one distinct constraint');
  assert.throws(() => selectCraftFlavorConstraint(''), /seedKey must be a non-empty string/);
});

// ----- validateCraftNaming (pure gate) -----

test('validateCraftNaming accepts a clean { name, flavor } and returns it unchanged', () => {
  const result = validateCraftNaming({ name: '紅蓮の一刀', flavor: '熾火を宿した刃。振るうたびに火の粉が舞う。' });
  assert.deepEqual(result, { name: '紅蓮の一刀', flavor: '熾火を宿した刃。振るうたびに火の粉が舞う。' });
});

test('validateCraftNaming rejects a non-exact schema', () => {
  assert.throws(() => validateCraftNaming({ name: '刀' }), /keys must be exactly \{name, flavor\}/);
  assert.throws(() => validateCraftNaming({ name: '刀', flavor: 'x', extra: 1 }), /keys must be exactly \{name, flavor\}/);
  assert.throws(() => validateCraftNaming({ name: 123, flavor: 'x' }), /name must be a string/);
  assert.throws(() => validateCraftNaming({ name: '刀', flavor: 456 }), /flavor must be a string/);
  assert.throws(() => validateCraftNaming(null), /candidate must be an object/);
  assert.throws(() => validateCraftNaming(['name', 'flavor']), /candidate must be an object/);
});

test('validateCraftNaming rejects empty or whitespace-only fields', () => {
  assert.throws(() => validateCraftNaming({ name: '', flavor: 'x' }), /name must not be empty/);
  assert.throws(() => validateCraftNaming({ name: '   ', flavor: 'x' }), /name must not be empty/);
  assert.throws(() => validateCraftNaming({ name: '刀', flavor: '' }), /flavor must not be empty/);
});

test('validateCraftNaming rejects fields over the length caps', () => {
  assert.throws(() => validateCraftNaming({ name: 'あ'.repeat(CRAFT_NAME_MAX_LENGTH + 1), flavor: 'x' }), new RegExp(`name must be at most ${CRAFT_NAME_MAX_LENGTH} characters`));
  assert.throws(() => validateCraftNaming({ name: '刀', flavor: 'あ'.repeat(CRAFT_FLAVOR_MAX_LENGTH + 1) }), new RegExp(`flavor must be at most ${CRAFT_FLAVOR_MAX_LENGTH} characters`));
  // exactly at the cap is allowed
  assert.doesNotThrow(() => validateCraftNaming({ name: 'あ'.repeat(CRAFT_NAME_MAX_LENGTH), flavor: 'い'.repeat(CRAFT_FLAVOR_MAX_LENGTH) }));
});

test('validateCraftNaming rejects quotation, bracket, and newline symbols', () => {
  assert.throws(() => validateCraftNaming({ name: '「紅蓮刀」', flavor: 'x' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateCraftNaming({ name: '紅蓮"刀"', flavor: 'x' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateCraftNaming({ name: '紅蓮刀', flavor: '刃(ためし)。' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateCraftNaming({ name: '紅蓮刀', flavor: '一行目\n二行目' }), /must not contain quotation or bracket symbols/);
});

// ----- craftWithLlmNaming (orchestration) -----

test('craftWithLlmNaming names, gates, and completes atomically on a valid LLM response', async () => {
  const root = await namingRoot();
  const recipeId = 'craft_weapon_sword_fire_t2';
  const candidate = { name: '紅蓮の一刀', flavor: '熾火を宿した刃。' };
  const calls = [];
  const before = await inventorySnapshot(root);

  const result = await craftWithLlmNaming({
    root,
    recipe_id: recipeId,
    config: NAMING_CONFIG,
    fetchImpl: structuredJsonFetch(JSON.stringify(candidate), calls)
  });

  assert.equal(result.instance.name, candidate.name, 'the instance carries the LLM-produced name');
  assert.equal(result.instance.flavor, candidate.flavor, 'the instance carries the LLM-produced flavor');
  assert.equal(result.recipe_id, recipeId);

  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1, 'exactly one instance was appended');
  assert.equal(surface.instances[0].name, candidate.name);
  assert.equal(surface.instances[0].instance_id, result.instance.instance_id);

  const after = await inventorySnapshot(root);
  assert.equal(after.items.find((item) => item.item_id === 'material_fire_t2').quantity, before.items.find((item) => item.item_id === 'material_fire_t2').quantity - 4, 'tier-2 material cost was consumed');

  // The LLM was asked exactly once, using the craft naming schema, with a prompt that
  // reflects the confirmed roll.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].response_format.json_schema.name, 'craft_naming_record');
  assert.deepEqual(calls[0].response_format.json_schema.schema.required, ['name', 'flavor']);
  assert.match(calls[0].messages[0].content, /種別: 武器（剣）/);
  assert.match(calls[0].messages[0].content, /属性: 火/);
  // the naming-only inputs are wired in: a deterministic 佇まい constraint is present,
  // and on the first craft there are no prior names to hand off.
  assert.match(calls[0].messages[0].content, /この一振りの佇まいには「.+」趣がある/);
  assert.doesNotMatch(calls[0].messages[0].content, /既に付けた名前/);
});

test('craftWithLlmNaming hands the workshop\'s existing instance names off to the next craft\'s prompt', async () => {
  const root = await namingRoot();
  const calls = [];
  // First craft names a sword; it lands on the equipment surface.
  await craftWithLlmNaming({
    root,
    recipe_id: 'craft_weapon_sword_fire_t2',
    config: NAMING_CONFIG,
    fetchImpl: structuredJsonFetch(JSON.stringify({ name: '紅蓮の一刀', flavor: '熾火を宿した刃。' }), calls)
  });
  // A second craft of a different recipe hands off the first name as a repeat-avoidance list.
  const secondCalls = [];
  await craftWithLlmNaming({
    root,
    recipe_id: 'craft_amulet_fire_t2',
    config: NAMING_CONFIG,
    fetchImpl: structuredJsonFetch(JSON.stringify({ name: '灼熱の護り', flavor: '静かな熱を宿す護符。' }), secondCalls)
  });
  assert.match(secondCalls[0].messages[0].content, /この工房で既に付けた名前（重複・酷似を避ける）: 紅蓮の一刀/);
  assert.match(secondCalls[0].messages[0].content, /この一振りの佇まいには「.+」趣がある/);
});

test('craftWithLlmNaming keeps the same 佇まい constraint when a failed naming is retried (nothing consumed)', async () => {
  const root = await namingRoot();
  const recipeId = 'craft_weapon_sword_fire_t2';
  const constraintLine = (content) => content.split('\n').find((line) => line.startsWith('この一振りの佇まいには'));

  const firstCalls = [];
  await assert.rejects(
    craftWithLlmNaming({ root, recipe_id: recipeId, config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '刀' }), firstCalls) }),
    /keys must be exactly/
  );
  const secondCalls = [];
  await assert.rejects(
    craftWithLlmNaming({ root, recipe_id: recipeId, config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '刀' }), secondCalls) }),
    /keys must be exactly/
  );

  const firstLine = constraintLine(firstCalls[0].messages[0].content);
  assert.ok(firstLine, 'the retried prompt carries a 佇まい constraint line');
  assert.equal(constraintLine(secondCalls[0].messages[0].content), firstLine, 'a retry with nothing consumed keeps the same constraint');
});

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

test('craftWithLlmNaming requires an lmStudioConfig', async () => {
  const root = await namingRoot();
  await assert.rejects(
    craftWithLlmNaming({ root, recipe_id: 'craft_weapon_sword_fire_t2', fetchImpl: async () => ({}) }),
    /lmStudioConfig is required/
  );
});
