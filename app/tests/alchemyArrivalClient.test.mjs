import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALCHEMY_RECIPE_COUNT,
  ALCHEMY_ITEM_CATEGORIES,
  ALCHEMY_CATEGORY_ORDER,
  ALCHEMY_CATEGORY_LABELS,
  alchemyCategoryLabel,
  assertAlchemyString,
  assertAlchemyNumber,
  assertAlchemyInteger,
  validateAlchemyResult,
  validateAlchemyCosts,
  validateAlchemyRecipe,
  validateAlchemyBookPayload,
  sortAlchemyRecipes,
  buildAlchemyChoiceMaterials,
  resolveAlchemyCraft
} from '../public/alchemyArrivalClient.js';

// A recipe with a fixed material + money cost, affordable by default. The result carries the backend-decorated
// effect_summary alongside the item identity/display.
function fixedRecipe(overrides = {}) {
  return {
    recipe_id: 'alchemy_light_secret_elixir',
    result: {
      item_id: 'alchemy_light_secret_elixir',
      name: '光の秘薬',
      description: '自らの光魔法を大きく伸ばす秘蔵の一品。',
      category: 'self_boost',
      effect_summary: '光魔法習熟度 +4'
    },
    costs: {
      items: [{ item_id: 'material_light_t4', display_name: '光の結晶（T4）', required: 3, held: 5 }],
      money: { required: 5000, held: 9000 }
    },
    affordable: true,
    ...overrides
  };
}

// A choice-cost recipe (任意1系統 tN×M): the player pays M of a single chosen element at tier N. The row exposes
// the 6 element materials at that tier with held counts (the picker options).
function choiceRecipe(overrides = {}) {
  return {
    recipe_id: 'alchemy_stardust_trinket',
    result: {
      item_id: 'alchemy_stardust_trinket',
      name: '星屑の細工玉',
      description: '市場でそこそこの値で引き取られる小さな細工玉。',
      category: 'product',
      effect_summary: '売値 300G'
    },
    costs: {
      choice: {
        tier: 1,
        quantity: 4,
        options: [
          { item_id: 'material_light_t1', display_name: '光の欠片（T1）', element: 'light', held: 4 },
          { item_id: 'material_dark_t1', display_name: '闇の欠片（T1）', element: 'dark', held: 1 },
          { item_id: 'material_fire_t1', display_name: '火の欠片（T1）', element: 'fire', held: 0 },
          { item_id: 'material_water_t1', display_name: '水の欠片（T1）', element: 'water', held: 9 },
          { item_id: 'material_earth_t1', display_name: '土の欠片（T1）', element: 'earth', held: 2 },
          { item_id: 'material_wind_t1', display_name: '風の欠片（T1）', element: 'wind', held: 0 }
        ]
      },
      money: { required: 0, held: 1000 }
    },
    affordable: true,
    ...overrides
  };
}

// Build a full 56-recipe book (the shape the payload validator requires). Every recipe is a valid fixed recipe
// with a unique id; overrides.recipes replaces the set for count / malformed tests.
function bookPayload(overrides = {}) {
  const recipes = overrides.recipes ?? Array.from({ length: ALCHEMY_RECIPE_COUNT }, (_v, i) => fixedRecipe({ recipe_id: `alchemy_r${i}` }));
  return { week: 4, recipes, post_content_screen: 'interaction', ...overrides };
}

test('the shared constants mirror the backend alchemy book contract', () => {
  assert.equal(ALCHEMY_RECIPE_COUNT, 56);
  assert.deepEqual([...ALCHEMY_ITEM_CATEGORIES], ['gift', 'ally_boost', 'self_boost', 'dungeon_consumable', 'product']);
  assert.deepEqual([...ALCHEMY_CATEGORY_ORDER], ['gift', 'ally_boost', 'self_boost', 'dungeon_consumable', 'product']);
  assert.deepEqual(ALCHEMY_CATEGORY_LABELS, {
    gift: '贈り物', ally_boost: '仲間強化', self_boost: '自分用強化', dungeon_consumable: 'ダンジョン消耗品', product: '換金品'
  });
});

test('alchemyCategoryLabel resolves each known category and fail-fasts on an unknown one (no silent raw fallback)', () => {
  assert.equal(alchemyCategoryLabel('gift'), '贈り物');
  assert.equal(alchemyCategoryLabel('dungeon_consumable'), 'ダンジョン消耗品');
  for (const bad of ['parameter', 'item', '', null, undefined]) {
    assert.throws(() => alchemyCategoryLabel(bad), /alchemy category is not a known value/);
  }
});

test('assertAlchemyString / assertAlchemyNumber / assertAlchemyInteger enforce their shapes', () => {
  assert.equal(assertAlchemyString('x', 'label'), 'x');
  for (const bad of ['', '   ', null, undefined, 3, {}, []]) {
    assert.throws(() => assertAlchemyString(bad, 'label'), /label must be a non-empty string/);
  }
  assert.equal(assertAlchemyNumber(0, 'n'), 0);
  for (const bad of [-1, NaN, Infinity, '3', null]) assert.throws(() => assertAlchemyNumber(bad, 'n'), /n must be a non-negative finite number/);
  assert.equal(assertAlchemyNumber(1, 'n', { positive: true }), 1);
  assert.throws(() => assertAlchemyNumber(0, 'n', { positive: true }), /n must be a positive finite number/);
  assert.equal(assertAlchemyInteger(2, 'n', { min: 1, max: 4 }), 2);
  for (const bad of [0, 5, 1.5, NaN, '2']) assert.throws(() => assertAlchemyInteger(bad, 'n', { min: 1, max: 4 }), /n must be an integer in 1\.\.4/);
});

test('validateAlchemyResult normalizes to identity + display and rejects an unknown category / empty field / non-object', () => {
  assert.deepEqual(validateAlchemyResult(fixedRecipe().result), {
    item_id: 'alchemy_light_secret_elixir',
    name: '光の秘薬',
    description: '自らの光魔法を大きく伸ばす秘蔵の一品。',
    category: 'self_boost',
    effect_summary: '光魔法習熟度 +4'
  });
  // Each of the 5 categories is accepted.
  for (const category of ALCHEMY_ITEM_CATEGORIES) {
    assert.equal(validateAlchemyResult({ item_id: 'i', name: 'n', description: 'd', category, effect_summary: 's' }).category, category);
  }
  assert.throws(() => validateAlchemyResult({ item_id: 'i', name: 'n', description: 'd', category: 'parameter', effect_summary: 's' }), /result\.category must be one of gift\/ally_boost\/self_boost\/dungeon_consumable\/product/);
  assert.throws(() => validateAlchemyResult({ item_id: '', name: 'n', description: 'd', category: 'gift', effect_summary: 's' }), /result\.item_id must be a non-empty string/);
  assert.throws(() => validateAlchemyResult({ item_id: 'i', name: 'n', description: 'd', category: 'gift', effect_summary: '' }), /result\.effect_summary must be a non-empty string/);
  assert.throws(() => validateAlchemyResult(null), /result must be an object/);
});

test('validateAlchemyCosts (fixed mode) computes per-row + money short flags', () => {
  const costs = validateAlchemyCosts({
    items: [
      { item_id: 'material_light_t4', display_name: '光の結晶', required: 3, held: 5 },
      { item_id: 'material_dark_t4', display_name: '闇の結晶', required: 2, held: 1 }
    ],
    money: { required: 5000, held: 3000 }
  });
  assert.equal(costs.mode, 'fixed');
  assert.equal(costs.items[0].short, false, 'held 5 >= required 3');
  assert.equal(costs.items[1].short, true, 'held 1 < required 2 → short');
  assert.equal(costs.money.short, true, 'held 3000 < required 5000 → short');
});

test('validateAlchemyCosts (choice mode) marks each option enough (held >= quantity)', () => {
  const costs = validateAlchemyCosts(choiceRecipe().costs);
  assert.equal(costs.mode, 'choice');
  assert.equal(costs.choice.tier, 1);
  assert.equal(costs.choice.quantity, 4);
  assert.equal(costs.choice.options.length, 6);
  assert.deepEqual(costs.choice.options.map((o) => o.enough), [true, false, false, true, false, false], 'held 4/1/0/9/2/0 vs quantity 4');
  assert.equal(costs.money.short, false);
});

test('validateAlchemyCosts fail-fasts on a payload that is not exactly ONE of items / choice, and on malformed money / rows / options', () => {
  // Neither items nor choice.
  assert.throws(() => validateAlchemyCosts({ money: { required: 0, held: 0 } }), /costs must carry exactly one of items \/ choice/);
  // Both items and choice.
  assert.throws(() => validateAlchemyCosts({ items: [], choice: { tier: 1, quantity: 1, options: [] }, money: { required: 0, held: 0 } }), /costs must carry exactly one of items \/ choice/);
  assert.throws(() => validateAlchemyCosts({ items: [], money: null }), /costs\.money must be an object/);
  assert.throws(() => validateAlchemyCosts({ items: 'x', money: { required: 0, held: 0 } }), /costs\.items must be an array/);
  assert.throws(() => validateAlchemyCosts({ items: [{ item_id: 'a', display_name: 'A', required: 0, held: 0 }], money: { required: 0, held: 0 } }), /costs\.items\[\]\.required must be a positive finite number/);
  assert.throws(() => validateAlchemyCosts({ items: [{ item_id: '', display_name: 'A', required: 1, held: 0 }], money: { required: 0, held: 0 } }), /costs\.items\[\]\.item_id must be a non-empty string/);
  assert.throws(() => validateAlchemyCosts({ choice: { tier: 5, quantity: 1, options: [{ item_id: 'i', display_name: 'n', element: 'light', held: 0 }] }, money: { required: 0, held: 0 } }), /costs\.choice\.tier must be an integer in 1\.\.4/);
  assert.throws(() => validateAlchemyCosts({ choice: { tier: 1, quantity: 1, options: [] }, money: { required: 0, held: 0 } }), /costs\.choice\.options must be a non-empty array/);
  assert.throws(() => validateAlchemyCosts({ choice: { tier: 1, quantity: 1, options: [{ item_id: 'i', display_name: 'n', element: '', held: 0 }] }, money: { required: 0, held: 0 } }), /costs\.choice\.options\[\]\.element must be a non-empty string/);
});

test('validateAlchemyRecipe normalizes a valid fixed / choice recipe (derives board category) and fail-fasts on malformed fields', () => {
  const fixed = validateAlchemyRecipe(fixedRecipe());
  assert.equal(fixed.recipe_id, 'alchemy_light_secret_elixir');
  assert.equal(fixed.category, 'self_boost', 'the board category is derived from the result category');
  assert.equal(fixed.costs.mode, 'fixed');
  assert.equal(fixed.affordable, true);
  const choice = validateAlchemyRecipe(choiceRecipe());
  assert.equal(choice.category, 'product');
  assert.equal(choice.costs.mode, 'choice');
  assert.throws(() => validateAlchemyRecipe(null), /malformed recipe/);
  assert.throws(() => validateAlchemyRecipe(fixedRecipe({ recipe_id: '' })), /recipe_id must be a non-empty string/);
  assert.throws(() => validateAlchemyRecipe(fixedRecipe({ affordable: 'yes' })), /affordable must be a boolean/);
  assert.throws(() => validateAlchemyRecipe(fixedRecipe({ result: { item_id: 'i', name: 'n', description: 'd', category: 'gold', effect_summary: 's' } })), /result\.category must be one of/);
});

test('validateAlchemyBookPayload accepts a valid 56-recipe book (with the server exit) and normalizes the recipes', () => {
  const { week, recipes, postContentScreen } = validateAlchemyBookPayload(bookPayload());
  assert.equal(week, 4);
  assert.equal(recipes.length, 56);
  assert.equal(postContentScreen, 'interaction');
  assert.equal(recipes[0].category, 'self_boost');
});

test('validateAlchemyBookPayload has NO affordability guarantee — an all-unaffordable book is valid (the exit is the way out)', () => {
  const recipes = Array.from({ length: ALCHEMY_RECIPE_COUNT }, (_v, i) => fixedRecipe({ recipe_id: `alchemy_r${i}`, affordable: false }));
  const { recipes: normalized } = validateAlchemyBookPayload(bookPayload({ recipes }));
  assert.equal(normalized.every((r) => r.affordable === false), true, 'every recipe unaffordable is a valid book (no dead-end — the exit leaves)');
});

test('validateAlchemyBookPayload fail-fasts on a non-object / bad week / wrong count / missing exit / malformed recipe', () => {
  assert.throws(() => validateAlchemyBookPayload(null), /malformed response/);
  for (const week of [undefined, null, '3', NaN, Infinity, -1, 3.5]) {
    assert.throws(() => validateAlchemyBookPayload(bookPayload({ week })), /week must be a non-negative integer/);
  }
  assert.equal(validateAlchemyBookPayload(bookPayload({ week: 0 })).week, 0, 'week 0 (第1週) is valid');
  assert.throws(() => validateAlchemyBookPayload(bookPayload({ recipes: [fixedRecipe()] })), /expected exactly 56 recipes/);
  assert.throws(() => validateAlchemyBookPayload({ week: 1, recipes: Array.from({ length: 56 }, (_v, i) => fixedRecipe({ recipe_id: `r${i}` })) }), /post_content_screen must be a non-empty string/);
  // A single malformed recipe inside the set fails the whole payload.
  const withBad = Array.from({ length: ALCHEMY_RECIPE_COUNT }, (_v, i) => (i === 10 ? fixedRecipe({ affordable: 3 }) : fixedRecipe({ recipe_id: `r${i}` })));
  assert.throws(() => validateAlchemyBookPayload(bookPayload({ recipes: withBad })), /affordable must be a boolean/);
});

test('sortAlchemyRecipes orders by 分類 (category) and preserves the authored order within a category (stable)', () => {
  const recipes = [
    validateAlchemyRecipe(fixedRecipe({ recipe_id: 'p1', result: { item_id: 'p1', name: 'n', description: 'd', category: 'product', effect_summary: 's' } })),
    validateAlchemyRecipe(fixedRecipe({ recipe_id: 'g1', result: { item_id: 'g1', name: 'n', description: 'd', category: 'gift', effect_summary: 's' } })),
    validateAlchemyRecipe(fixedRecipe({ recipe_id: 'g2', result: { item_id: 'g2', name: 'n', description: 'd', category: 'gift', effect_summary: 's' } })),
    validateAlchemyRecipe(fixedRecipe({ recipe_id: 's1', result: { item_id: 's1', name: 'n', description: 'd', category: 'self_boost', effect_summary: 's' } }))
  ];
  assert.deepEqual(sortAlchemyRecipes(recipes).map((r) => r.recipe_id), ['g1', 'g2', 's1', 'p1'], 'gift → self_boost → product; g1 before g2 (authored order preserved)');
});

test('buildAlchemyChoiceMaterials builds the single-element materials payload and rejects a bad quantity', () => {
  assert.deepEqual(buildAlchemyChoiceMaterials('material_light_t1', 4), [{ item_id: 'material_light_t1', quantity: 4 }]);
  assert.throws(() => buildAlchemyChoiceMaterials('material_light_t1', 0), /material choice quantity must be an integer/);
  assert.throws(() => buildAlchemyChoiceMaterials('', 4), /material choice item_id must be a non-empty string/);
});

// A valid POST /api/alchemy/craft response for the fixedRecipe (result.recipe_id matches, crafted_item identity
// matches the selected recipe's result).
function craftResponse(overrides = {}) {
  return {
    result: {
      week: 4,
      recipe_id: 'alchemy_light_secret_elixir',
      crafted_item: {
        item_id: 'alchemy_light_secret_elixir',
        name: '光の秘薬',
        description: '自らの光魔法を大きく伸ばす秘蔵の一品。',
        category: 'self_boost',
        effect_summary: '光魔法習熟度 +4',
        quantity: 1
      },
      consumed_costs: { item_costs: [], money_cost: 5000 },
      content_result: {},
      inventory: { money: 4000, items: [] }
    },
    state: { current_screen: 'interaction' },
    post_content_screen: 'interaction',
    ...overrides
  };
}

test('resolveAlchemyCraft ties the popup to the response (name/description/effect/quantity) and adopts the authoritative state', () => {
  const recipe = validateAlchemyRecipe(fixedRecipe());
  assert.deepEqual(resolveAlchemyCraft(craftResponse(), recipe), {
    state: { current_screen: 'interaction' },
    postContentScreen: 'interaction',
    display: {
      item_id: 'alchemy_light_secret_elixir',
      name: '光の秘薬',
      description: '自らの光魔法を大きく伸ばす秘蔵の一品。',
      category: 'self_boost',
      effect_summary: '光魔法習熟度 +4',
      quantity: 1
    }
  });
});

test('resolveAlchemyCraft fail-fasts when the crafted recipe id / item identity DIVERGES from the selected recipe', () => {
  const recipe = validateAlchemyRecipe(fixedRecipe());
  assert.throws(
    () => resolveAlchemyCraft(craftResponse({ result: { ...craftResponse().result, recipe_id: 'alchemy_other' } }), recipe),
    /the crafted recipe .* does not match the selected recipe/
  );
  assert.throws(
    () => resolveAlchemyCraft(craftResponse({ result: { ...craftResponse().result, crafted_item: { ...craftResponse().result.crafted_item, item_id: 'alchemy_other_item' } } }), recipe),
    /crafted item .* does not match the selected recipe/
  );
  assert.throws(
    () => resolveAlchemyCraft(craftResponse({ result: { ...craftResponse().result, crafted_item: { ...craftResponse().result.crafted_item, category: 'gift' } } }), recipe),
    /crafted item .* does not match the selected recipe/
  );
});

test('resolveAlchemyCraft fail-fasts on a missing selected recipe / envelope / result / state / exit / crafted_item field', () => {
  const recipe = validateAlchemyRecipe(fixedRecipe());
  assert.throws(() => resolveAlchemyCraft(craftResponse(), null), /a validated selected recipe is required/);
  assert.throws(() => resolveAlchemyCraft(null, recipe), /malformed response/);
  assert.throws(() => resolveAlchemyCraft(craftResponse({ result: undefined }), recipe), /response is missing the result/);
  assert.throws(() => resolveAlchemyCraft(craftResponse({ state: undefined }), recipe), /response is missing state/);
  assert.throws(() => resolveAlchemyCraft(craftResponse({ post_content_screen: '' }), recipe), /post_content_screen must be a non-empty string/);
  assert.throws(() => resolveAlchemyCraft(craftResponse({ result: { ...craftResponse().result, crafted_item: { ...craftResponse().result.crafted_item, quantity: 0 } } }), recipe), /crafted_item\.quantity must be an integer/);
  assert.throws(() => resolveAlchemyCraft(craftResponse({ result: { ...craftResponse().result, crafted_item: { ...craftResponse().result.crafted_item, name: '' } } }), recipe), /crafted_item\.name must be a non-empty string/);
});
