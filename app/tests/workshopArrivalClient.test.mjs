import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSHOP_RECIPE_COUNT,
  WORKSHOP_EQUIPMENT_KINDS,
  WORKSHOP_WEAPON_TYPES,
  WORKSHOP_EQUIPMENT_QUALITIES,
  WORKSHOP_EFFECT_KEYS,
  WORKSHOP_ELEMENTS,
  WORKSHOP_KIND_LABELS,
  WORKSHOP_WEAPON_TYPE_LABELS,
  WORKSHOP_ELEMENT_LABELS,
  WORKSHOP_QUALITY_LABELS,
  WORKSHOP_EFFECT_LABELS,
  WORKSHOP_CATEGORY_ORDER,
  WORKSHOP_CATEGORY_LABELS,
  workshopKindLabel,
  workshopElementLabel,
  workshopQualityLabel,
  workshopCategoryLabel,
  workshopRecipeCategory,
  workshopKindLabelFull,
  workshopEffectEntries,
  assertWorkshopString,
  assertWorkshopNumber,
  assertWorkshopInteger,
  validateWorkshopRecipe,
  validateWorkshopArrivalPayload,
  sortWorkshopRecipes,
  WORKSHOP_FILTER_ALL,
  workshopTierValues,
  workshopRecipeMatchesFilter,
  workshopVisibleRecipes,
  resolveWorkshopCraft
} from '../public/workshopArrivalClient.js';

// An affordable weapon recipe (all materials/money covered). The arrival view carries only recipe-fixed
// base_effects + the S-derived outlook — NEVER the roll outputs (quality / bonus_effects / instance_id).
function weaponRecipe(overrides = {}) {
  return {
    recipe_id: 'craft_weapon_sword_fire_t2',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    base_effects: { attack: 7 },
    costs: { items: [{ item_id: 'material_fire_t2', display_name: '火の結晶', required: 4, held: 99 }], money: { required: 0, held: 100000 } },
    affordable: true,
    outlook: { band: 3, label: '練達の域' },
    ...overrides
  };
}

// An amulet recipe the player can't afford (held < required on the material). Amulets carry no weapon_type.
function amuletRecipe(overrides = {}) {
  return {
    recipe_id: 'craft_amulet_water_t2',
    kind: 'amulet',
    element: 'water',
    tier: 2,
    base_effects: { defense: 4 },
    costs: { items: [{ item_id: 'material_water_t2', display_name: '水の雫', required: 4, held: 1 }], money: { required: 200, held: 50 } },
    affordable: false,
    outlook: { band: 1, label: 'まずまず' },
    ...overrides
  };
}

// A full valid 96-recipe payload (the count the backend guarantees). Each recipe is a distinct, valid weapon row.
function fullRecipeSet({ affordable = true } = {}) {
  return Array.from({ length: WORKSHOP_RECIPE_COUNT }, (unused, index) =>
    weaponRecipe({ recipe_id: `craft_test_${index}`, affordable }));
}

function arrivalPayload(overrides = {}) {
  return { week: 4, recipes: fullRecipeSet(), post_content_screen: 'interaction', ...overrides };
}

test('the shared constants mirror the backend workshop / equipment contract', () => {
  assert.equal(WORKSHOP_RECIPE_COUNT, 96);
  assert.deepEqual([...WORKSHOP_EQUIPMENT_KINDS], ['weapon', 'amulet']);
  assert.deepEqual([...WORKSHOP_WEAPON_TYPES], ['sword', 'staff', 'short_rod']);
  assert.deepEqual([...WORKSHOP_EQUIPMENT_QUALITIES], ['common', 'fine', 'excellent', 'masterwork']);
  assert.deepEqual([...WORKSHOP_EFFECT_KEYS], ['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power']);
  assert.deepEqual([...WORKSHOP_ELEMENTS], ['light', 'dark', 'fire', 'water', 'earth', 'wind']);
  assert.deepEqual([...WORKSHOP_CATEGORY_ORDER], ['sword', 'staff', 'short_rod', 'amulet']);
});

test('the display label maps match the hub content-result vocabulary (routingMetaContext) so the screens read as one language', () => {
  assert.deepEqual(WORKSHOP_KIND_LABELS, { weapon: '武器', amulet: '護符' });
  assert.deepEqual(WORKSHOP_WEAPON_TYPE_LABELS, { sword: '剣', staff: '杖', short_rod: '短杖' });
  assert.deepEqual(WORKSHOP_ELEMENT_LABELS, { light: '光', dark: '闇', fire: '火', water: '水', earth: '土', wind: '風' });
  assert.deepEqual(WORKSHOP_QUALITY_LABELS, { common: '並', fine: '良', excellent: '優', masterwork: '傑作' });
  assert.deepEqual(WORKSHOP_EFFECT_LABELS, { attack: '攻撃', defense: '防御', max_hp: '最大HP', max_mp: '最大MP', spell_mp_discount: 'スペルMP軽減', self_heal_bonus: '自己回復量', element_spell_power: '同属性スペル威力' });
  assert.deepEqual(WORKSHOP_CATEGORY_LABELS, { sword: '剣', staff: '杖', short_rod: '短杖', amulet: '護符' });
});

test('the label accessors fail-fast on an unknown value (no silent raw fallback)', () => {
  assert.equal(workshopKindLabel('weapon'), '武器');
  assert.equal(workshopElementLabel('fire'), '火');
  assert.equal(workshopQualityLabel('masterwork'), '傑作');
  assert.equal(workshopCategoryLabel('short_rod'), '短杖');
  assert.throws(() => workshopKindLabel('gadget'), /kind is not a known value/);
  assert.throws(() => workshopElementLabel('plasma'), /element is not a known value/);
  assert.throws(() => workshopQualityLabel('legendary'), /quality is not a known value/);
  assert.throws(() => workshopCategoryLabel('lance'), /category is not a known value/);
});

test('workshopRecipeCategory / workshopKindLabelFull derive the 種別 axis (weapon → weapon_type, amulet → kind)', () => {
  assert.equal(workshopRecipeCategory({ kind: 'weapon', weapon_type: 'staff' }), 'staff');
  assert.equal(workshopRecipeCategory({ kind: 'amulet' }), 'amulet');
  assert.equal(workshopKindLabelFull({ kind: 'weapon', weapon_type: 'sword' }), '武器（剣）');
  assert.equal(workshopKindLabelFull({ kind: 'amulet' }), '護符');
});

test('workshopEffectEntries orders by the canonical effect keys and rejects malformed effects', () => {
  assert.deepEqual(workshopEffectEntries({ defense: 3, attack: 7 }, 'base_effects'), [
    { key: 'attack', label: '攻撃', value: 7 },
    { key: 'defense', label: '防御', value: 3 }
  ]);
  assert.throws(() => workshopEffectEntries({}, 'base_effects'), /must carry at least one effect/);
  // allowEmpty (the roll-derived bonus_effects path) accepts an empty set → [] (the equipment instance-shape
  // contract structurally permits an empty effect object; base_effects stays strict without the option).
  assert.deepEqual(workshopEffectEntries({}, 'bonus_effects', { allowEmpty: true }), []);
  assert.throws(() => workshopEffectEntries({ luck: 2 }, 'base_effects'), /unknown effect key/);
  assert.throws(() => workshopEffectEntries({ attack: 0 }, 'base_effects'), /must be a positive integer/);
  assert.throws(() => workshopEffectEntries({ attack: 1.5 }, 'base_effects'), /must be a positive integer/);
  assert.throws(() => workshopEffectEntries(null, 'base_effects'), /must be an object of effect/);
});

test('assertWorkshopString / Number / Integer enforce their shapes', () => {
  assert.equal(assertWorkshopString('x', 'l'), 'x');
  for (const bad of ['', '  ', null, 3, {}]) assert.throws(() => assertWorkshopString(bad, 'l'), /must be a non-empty string/);
  assert.equal(assertWorkshopNumber(0, 'n'), 0);
  for (const bad of [-1, NaN, Infinity, '3']) assert.throws(() => assertWorkshopNumber(bad, 'n'), /must be a non-negative finite number/);
  assert.throws(() => assertWorkshopNumber(0, 'n', { positive: true }), /must be a positive finite number/);
  assert.equal(assertWorkshopInteger(2, 'n', { min: 1, max: 4 }), 2);
  for (const bad of [0, 5, 2.5, NaN]) assert.throws(() => assertWorkshopInteger(bad, 'n', { min: 1, max: 4 }), /must be an integer in 1\.\.4/);
});

test('validateWorkshopRecipe normalizes a weapon (derived category, per-row short flags) and an amulet (no weapon_type)', () => {
  assert.deepEqual(validateWorkshopRecipe(weaponRecipe()), {
    recipe_id: 'craft_weapon_sword_fire_t2',
    kind: 'weapon',
    weapon_type: 'sword',
    category: 'sword',
    element: 'fire',
    tier: 2,
    base_effects: [{ key: 'attack', label: '攻撃', value: 7 }],
    items: [{ item_id: 'material_fire_t2', display_name: '火の結晶', required: 4, held: 99, short: false }],
    money: { required: 0, held: 100000, short: false },
    affordable: true,
    outlook: { band: 3, label: '練達の域' }
  });
  const amulet = validateWorkshopRecipe(amuletRecipe());
  assert.equal(amulet.category, 'amulet');
  assert.equal(Object.prototype.hasOwnProperty.call(amulet, 'weapon_type'), false);
  // Short flags: held 1 < required 4 (material), held 50 < required 200 (money).
  assert.equal(amulet.items[0].short, true);
  assert.equal(amulet.money.short, true);
});

test('validateWorkshopRecipe fail-fasts on a leaked roll output (quality / bonus_effects / instance_id) — the arrival withholds the confirmed craftsmanship', () => {
  for (const leaked of [{ quality: 'masterwork' }, { bonus_effects: { attack: 3 } }, { instance_id: 'equip_x' }]) {
    assert.throws(() => validateWorkshopRecipe(weaponRecipe(leaked)), /must not carry the withheld roll output/);
  }
});

test('validateWorkshopRecipe fail-fasts on every malformed required field (no silent placeholder)', () => {
  assert.throws(() => validateWorkshopRecipe(null), /malformed recipe/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ recipe_id: '' })), /recipe_id must be a non-empty string/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ kind: 'gadget' })), /kind must be one of weapon\/amulet/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ weapon_type: 'lance' })), /weapon_type must be one of sword\/staff\/short_rod/);
  // An amulet must NOT carry weapon_type.
  assert.throws(() => validateWorkshopRecipe(amuletRecipe({ weapon_type: 'sword' })), /a amulet recipe must not carry weapon_type/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ element: 'plasma' })), /element must be one of/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ tier: 5 })), /tier must be an integer in 1\.\.4/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ base_effects: {} })), /base_effects must carry at least one effect/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ costs: null })), /costs must be an object/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ costs: { items: 'x', money: { required: 0, held: 0 } } })), /costs\.items must be an array/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ costs: { items: [{ item_id: 'a', display_name: 'A', required: 0, held: 0 }], money: { required: 0, held: 0 } } })), /costs\.items\[\]\.required must be a positive finite number/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ costs: { items: [{ item_id: 'a', display_name: '', required: 1, held: 0 }], money: { required: 0, held: 0 } } })), /costs\.items\[\]\.display_name must be a non-empty string/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ costs: { items: [], money: { required: -1, held: 0 } } })), /costs\.money\.required must be a non-negative finite number/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ affordable: 'yes' })), /affordable must be a boolean/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ outlook: { band: 4, label: 'x' } })), /outlook\.band must be an integer in 0\.\.3/);
  assert.throws(() => validateWorkshopRecipe(weaponRecipe({ outlook: { band: 2, label: '' } })), /outlook\.label must be a non-empty string/);
});

test('validateWorkshopArrivalPayload accepts exactly 96 recipes with a server-authoritative exit', () => {
  const { week, recipes, postContentScreen } = validateWorkshopArrivalPayload(arrivalPayload());
  assert.equal(week, 4);
  assert.equal(recipes.length, 96);
  assert.equal(postContentScreen, 'interaction');
  assert.equal(recipes[0].category, 'sword');
});

test('validateWorkshopArrivalPayload accepts an all-unaffordable week — the workshop has NO affordability guarantee (the exit is the way out)', () => {
  const { recipes } = validateWorkshopArrivalPayload(arrivalPayload({ recipes: fullRecipeSet({ affordable: false }) }));
  assert.equal(recipes.length, 96);
  assert.equal(recipes.some((recipe) => recipe.affordable), false);
});

test('validateWorkshopArrivalPayload fail-fasts on a non-object / bad week / wrong count / missing exit / malformed recipe', () => {
  assert.throws(() => validateWorkshopArrivalPayload(null), /malformed response/);
  for (const week of [undefined, '3', NaN, -1, 3.5]) {
    assert.throws(() => validateWorkshopArrivalPayload(arrivalPayload({ week })), /week must be a non-negative integer/);
  }
  assert.equal(validateWorkshopArrivalPayload(arrivalPayload({ week: 0 })).week, 0);
  assert.throws(() => validateWorkshopArrivalPayload(arrivalPayload({ recipes: fullRecipeSet().slice(0, 95) })), /expected exactly 96 recipes/);
  assert.throws(() => validateWorkshopArrivalPayload(arrivalPayload({ recipes: [...fullRecipeSet(), weaponRecipe()] })), /expected exactly 96 recipes/);
  assert.throws(() => validateWorkshopArrivalPayload(arrivalPayload({ post_content_screen: '' })), /post_content_screen must be a non-empty string/);
  const broken = fullRecipeSet();
  broken[10] = weaponRecipe({ tier: 9 });
  assert.throws(() => validateWorkshopArrivalPayload(arrivalPayload({ recipes: broken })), /tier must be an integer in 1\.\.4/);
});

test('sortWorkshopRecipes orders the board by 種別 (category) → 属性 (element) → tier', () => {
  const recipes = [
    validateWorkshopRecipe(amuletRecipe({ recipe_id: 'a1', affordable: true, costs: { items: [], money: { required: 0, held: 0 } } })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'w_short_wind', weapon_type: 'short_rod', element: 'wind', tier: 1 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'w_sword_fire_t3', tier: 3 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'w_sword_fire_t1', tier: 1 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'w_sword_light', element: 'light', tier: 4 }))
  ];
  const order = sortWorkshopRecipes(recipes).map((recipe) => recipe.recipe_id);
  // sword before short_rod before amulet; within sword: light before fire; within sword-fire: t1 before t3.
  assert.deepEqual(order, ['w_sword_light', 'w_sword_fire_t1', 'w_sword_fire_t3', 'w_short_wind', 'a1']);
});

test('workshopTierValues returns the distinct tiers present, ascending (the data-derived ティア filter axis, すべて chip aside)', () => {
  const recipes = [
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'a', tier: 3 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'b', tier: 1 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'c', tier: 3 })),
    validateWorkshopRecipe(amuletRecipe({ recipe_id: 'd', tier: 2, affordable: true, costs: { items: [], money: { required: 0, held: 0 } } }))
  ];
  assert.deepEqual(workshopTierValues(recipes), [1, 2, 3]);
  assert.deepEqual(workshopTierValues([]), []);
});

test('workshopRecipeMatchesFilter is a 3-axis AND (種別 × ティア × 属性); WORKSHOP_FILTER_ALL drops an axis, any single mismatch excludes', () => {
  const recipe = validateWorkshopRecipe(weaponRecipe({ weapon_type: 'staff', element: 'light', tier: 3 })); // category = staff
  const all = { category: WORKSHOP_FILTER_ALL, tier: WORKSHOP_FILTER_ALL, element: WORKSHOP_FILTER_ALL };
  assert.equal(workshopRecipeMatchesFilter(recipe, all), true);
  // Each axis matches on its exact value (tier is the integer, category / element are the frozen strings).
  assert.equal(workshopRecipeMatchesFilter(recipe, { ...all, category: 'staff' }), true);
  assert.equal(workshopRecipeMatchesFilter(recipe, { ...all, tier: 3 }), true);
  assert.equal(workshopRecipeMatchesFilter(recipe, { ...all, element: 'light' }), true);
  // A fully-specified match: staff × T3 × 光.
  assert.equal(workshopRecipeMatchesFilter(recipe, { category: 'staff', tier: 3, element: 'light' }), true);
  // Any one diverging axis fails the AND.
  assert.equal(workshopRecipeMatchesFilter(recipe, { ...all, category: 'sword' }), false);
  assert.equal(workshopRecipeMatchesFilter(recipe, { ...all, tier: 2 }), false);
  assert.equal(workshopRecipeMatchesFilter(recipe, { ...all, element: 'fire' }), false);
  // Two axes match but the third diverges → still excluded (AND, not OR).
  assert.equal(workshopRecipeMatchesFilter(recipe, { category: 'staff', tier: 3, element: 'fire' }), false);
});

test('workshopVisibleRecipes returns the filtered subset in order, and a combination on no recipe yields [] (the explicit empty state)', () => {
  const recipes = [
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'sword_fire_t1', weapon_type: 'sword', element: 'fire', tier: 1 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'staff_water_t2', weapon_type: 'staff', element: 'water', tier: 2 })),
    validateWorkshopRecipe(weaponRecipe({ recipe_id: 'staff_water_t1', weapon_type: 'staff', element: 'water', tier: 1 }))
  ];
  const all = { category: WORKSHOP_FILTER_ALL, tier: WORKSHOP_FILTER_ALL, element: WORKSHOP_FILTER_ALL };
  assert.deepEqual(workshopVisibleRecipes(recipes, all).map((recipe) => recipe.recipe_id), ['sword_fire_t1', 'staff_water_t2', 'staff_water_t1']);
  assert.deepEqual(workshopVisibleRecipes(recipes, { ...all, category: 'staff' }).map((recipe) => recipe.recipe_id), ['staff_water_t2', 'staff_water_t1']);
  assert.deepEqual(workshopVisibleRecipes(recipes, { category: 'staff', tier: 1, element: 'water' }).map((recipe) => recipe.recipe_id), ['staff_water_t1']);
  // sword exists only at T1, so sword × T2 matches nothing → empty subset (the board shows the explicit message).
  assert.deepEqual(workshopVisibleRecipes(recipes, { category: 'sword', tier: 2, element: WORKSHOP_FILTER_ALL }), []);
});

// A valid POST /api/workshop/craft response for the selected weapon recipe (result.recipe_id matches; the crafted
// instance identity matches; the roll outputs — quality / name / flavor / bonus_effects — are revealed here).
function weaponInstance(overrides = {}) {
  return {
    instance_id: 'equip_test_w4_craft_weapon_sword_fire_t2',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    quality: 'masterwork',
    name: '紅蓮の一刀',
    flavor: '熾火を宿した刃。',
    base_effects: { attack: 7 },
    bonus_effects: { attack: 3, max_hp: 5 },
    ...overrides
  };
}

function craftResponse(overrides = {}) {
  return {
    result: { recipe_id: 'craft_weapon_sword_fire_t2', week: 4, quality: 'masterwork', instance: weaponInstance() },
    state: { current_screen: 'academy-workshop', last_routing_content_result: { kind: 'workshop' } },
    post_content_screen: 'interaction',
    ...overrides
  };
}

test('resolveWorkshopCraft ties the popup to the response: name/flavor/quality from the crafted instance, identity cross-checked against the selection', () => {
  const recipe = validateWorkshopRecipe(weaponRecipe());
  const resolved = resolveWorkshopCraft(craftResponse(), recipe);
  assert.equal(resolved.postContentScreen, 'interaction');
  assert.deepEqual(resolved.state, { current_screen: 'academy-workshop', last_routing_content_result: { kind: 'workshop' } });
  assert.deepEqual(resolved.display, {
    recipe_id: 'craft_weapon_sword_fire_t2',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    quality: 'masterwork',
    name: '紅蓮の一刀',
    flavor: '熾火を宿した刃。',
    base_effects: [{ key: 'attack', label: '攻撃', value: 7 }],
    bonus_effects: [{ key: 'attack', label: '攻撃', value: 3 }, { key: 'max_hp', label: '最大HP', value: 5 }]
  });
});

test('resolveWorkshopCraft resolves an amulet craft (no weapon_type on either side)', () => {
  const recipe = validateWorkshopRecipe(amuletRecipe({ affordable: true, costs: { items: [], money: { required: 0, held: 0 } } }));
  const amuletInstance = { instance_id: 'equip_x', kind: 'amulet', element: 'water', tier: 2, quality: 'fine', name: '澪の護符', flavor: '水面の護り。', base_effects: { defense: 4 }, bonus_effects: { max_hp: 2 } };
  const resolved = resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_amulet_water_t2', week: 4, quality: 'fine', instance: amuletInstance } }), recipe);
  assert.equal(Object.prototype.hasOwnProperty.call(resolved.display, 'weapon_type'), false);
  assert.equal(resolved.display.quality, 'fine');
  assert.equal(resolved.display.name, '澪の護符');
});

test('resolveWorkshopCraft fail-fasts when the crafted recipe or item identity DIVERGES from the selection', () => {
  const recipe = validateWorkshopRecipe(weaponRecipe());
  // Different recipe id → throw.
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_other', instance: weaponInstance() } }), recipe), /crafted recipe .* does not match the selected recipe/);
  // Same recipe id but a divergent crafted kind → throw.
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ kind: 'amulet', weapon_type: undefined, bonus_effects: { max_hp: 2 } }) } }), recipe), /crafted kind .* does not match/);
  // Divergent weapon_type → throw.
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ weapon_type: 'staff' }) } }), recipe), /crafted weapon_type .* does not match/);
  // Divergent element / tier → throw.
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ element: 'water' }) } }), recipe), /does not match the selected recipe/);
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ tier: 3 }) } }), recipe), /does not match the selected recipe/);
});

test('resolveWorkshopCraft fail-fasts on a missing selected recipe / envelope / result / state / exit / instance field', () => {
  const recipe = validateWorkshopRecipe(weaponRecipe());
  assert.throws(() => resolveWorkshopCraft(craftResponse(), null), /a validated selected recipe is required/);
  assert.throws(() => resolveWorkshopCraft(null, recipe), /malformed response/);
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: undefined }), recipe), /response is missing the result/);
  assert.throws(() => resolveWorkshopCraft(craftResponse({ state: undefined }), recipe), /response is missing state/);
  assert.throws(() => resolveWorkshopCraft(craftResponse({ post_content_screen: '' }), recipe), /post_content_screen must be a non-empty string/);
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ quality: 'legendary' }) } }), recipe), /instance\.quality must be one of/);
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ name: '' }) } }), recipe), /instance\.name must be a non-empty string/);
  // base_effects (recipe-fixed) stays strict: an empty set is corruption → throw.
  assert.throws(() => resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ base_effects: {} }) } }), recipe), /instance\.base_effects must carry at least one effect/);
});

test('resolveWorkshopCraft accepts an empty bonus_effects (a structurally valid roll-derived set) and renders it as an empty 付加性能 list', () => {
  // BONUS_LINES_BY_RANK floors at 1 today, but the equipment instance-shape contract (equipment.mjs validateEffects
  // accepts {}) structurally permits an empty bonus set — the frontend must not hard-fail a valid craft on it.
  const recipe = validateWorkshopRecipe(weaponRecipe());
  const resolved = resolveWorkshopCraft(craftResponse({ result: { recipe_id: 'craft_weapon_sword_fire_t2', instance: weaponInstance({ bonus_effects: {} }) } }), recipe);
  assert.deepEqual(resolved.display.bonus_effects, []);
  // base_effects is still populated (recipe-fixed).
  assert.deepEqual(resolved.display.base_effects, [{ key: 'attack', label: '攻撃', value: 7 }]);
});
