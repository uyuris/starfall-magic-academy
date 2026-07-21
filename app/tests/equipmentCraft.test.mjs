import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  EQUIPMENT_CRAFT_RECIPES,
  listCraftRecipes,
  getCraftRecipe,
  previewCraft,
  completeCraft
} from '../src/equipmentCraft.mjs';
import { EQUIPMENT_QUALITIES, PLAYER_EQUIP_TARGET, equipItem, loadEquipmentSurface } from '../src/equipment.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from '../src/dungeonMaterialCatalog.mjs';
import { enterDungeon } from '../src/dungeon/dungeonEngine.mjs';
import { writeRuntimePathsManifest } from '../src/runtimeSlotBootstrap.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

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

// consumeInventoryItems resolves the full known-item universe (shop / stage / gathering
// / alchemy products / dungeon materials), so those definitions must be seeded even
// though craft only ever charges dungeon-material costs.
async function seedEconomyDefinitions(root) {
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
}

async function craftRoot({ parameters, inventory, elapsedWeeks = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-craft-'));
  await seedEconomyDefinitions(root);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: elapsedWeeks, characters: {} });
  if (parameters) await writeJson(root, 'data/mutable/game_data/runtime/player_parameters.json', parameters);
  if (inventory) await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory);
  return root;
}

async function craftDungeonRoot({ academics = 80, charisma = 50, magic = {}, elapsedWeeks = 0 } = {}) {
  const root = await craftRoot({ parameters: craftParams({ academics, charisma, magic }), inventory: richInventory(), elapsedWeeks });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.current_screen = 'academy-map';
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
  return root;
}

test('recipe catalog is the closed 72 weapon + 24 amulet matrix with element×tier costs', () => {
  const recipes = listCraftRecipes();
  assert.equal(recipes, EQUIPMENT_CRAFT_RECIPES);
  const weapons = recipes.filter((recipe) => recipe.kind === 'weapon');
  const amulets = recipes.filter((recipe) => recipe.kind === 'amulet');
  assert.equal(weapons.length, 72, '3 weapon types × 6 elements × 4 tiers');
  assert.equal(amulets.length, 24, '6 elements × 4 tiers');
  assert.equal(recipes.length, 96);
  assert.equal(new Set(recipes.map((recipe) => recipe.recipe_id)).size, 96, 'recipe ids are unique');
  for (const recipe of recipes) {
    assert.equal(recipe.material_costs.length, 1);
    assert.equal(recipe.material_costs[0].item_id, `material_${recipe.element}_t${recipe.tier}`);
    assert.equal(recipe.material_costs[0].quantity > 0, true);
    assert.equal(recipe.money_cost >= 0, true);
  }
  // element_spell_power lives in a weapon base (staff) only, never an amulet base.
  for (const amulet of amulets) assert.equal('element_spell_power' in amulet.base_effects, false);
  const staff = recipes.find((recipe) => recipe.weapon_type === 'staff');
  assert.equal('element_spell_power' in staff.base_effects, true);
  assert.throws(() => getCraftRecipe('craft_weapon_sword_fire_t9'), /unknown craft recipe/);
});

test('the roll is deterministic per (slot, week, recipe) and preview matches complete', async () => {
  const root = await craftRoot({ parameters: craftParams({ academics: 60, magic: { fire: 60 } }), inventory: richInventory(), elapsedWeeks: 3 });
  const recipeId = 'craft_weapon_sword_fire_t2';
  const preview1 = await previewCraft({ root, recipe_id: recipeId });
  const preview2 = await previewCraft({ root, recipe_id: recipeId });
  assert.deepEqual(preview1, preview2, 'repeated preview is byte-identical');

  const done = await completeCraft({ root, recipe_id: recipeId, name: 'テスト刀', flavor: 'ためしの刃。' });
  assert.equal(done.quality, preview1.quality);
  assert.deepEqual(done.instance.bonus_effects, preview1.bonus_effects);
  assert.deepEqual(done.instance.base_effects, preview1.base_effects);
  assert.equal(done.instance.instance_id, preview1.instance_id);
});

test('the roll can change with the week (a different week is the only re-roll)', async () => {
  const recipeId = 'craft_weapon_sword_fire_t2';
  const rolls = new Set();
  for (let week = 0; week <= 20; week += 1) {
    const root = await craftRoot({ parameters: craftParams({ academics: 60, magic: { fire: 60 } }), inventory: richInventory(), elapsedWeeks: week });
    const preview = await previewCraft({ root, recipe_id: recipeId });
    rolls.add(`${preview.quality}:${JSON.stringify(preview.bonus_effects)}`);
  }
  assert.equal(rolls.size > 1, true, 'the roll is not constant across weeks');
});

test('quality is monotone non-decreasing in the skill score and all four ranks are reachable', async () => {
  const recipeId = 'craft_amulet_water_t2';
  const seen = new Set();
  let lastIndex = -1;
  for (let s = 0; s <= 100; s += 5) {
    const root = await craftRoot({ parameters: craftParams({ charisma: s, magic: { water: s } }), inventory: richInventory(), elapsedWeeks: 7 });
    const preview = await previewCraft({ root, recipe_id: recipeId });
    assert.equal(preview.skill_score, s, 'S equals charisma/mastery average');
    const index = EQUIPMENT_QUALITIES.indexOf(preview.quality);
    assert.equal(index >= lastIndex, true, `quality dropped as S rose (S=${s} -> ${preview.quality})`);
    lastIndex = index;
    seen.add(preview.quality);
  }
  assert.deepEqual([...seen].sort(), [...EQUIPMENT_QUALITIES].sort(), 'every rank is reachable across the S range');
});

test('bonus effects escalate by rank and stay within the closed vocabulary', async () => {
  const recipeId = 'craft_weapon_staff_fire_t3';
  async function rollAt(s) {
    const root = await craftRoot({ parameters: craftParams({ academics: s, magic: { fire: s } }), inventory: richInventory(), elapsedWeeks: 2 });
    return previewCraft({ root, recipe_id: recipeId });
  }
  const low = await rollAt(0);
  const high = await rollAt(100);
  assert.equal(low.quality, 'common');
  assert.equal(high.quality, 'masterwork');
  assert.equal(Object.keys(high.bonus_effects).length > Object.keys(low.bonus_effects).length, true, 'masterwork has more bonus lines');
  for (const value of Object.values(low.bonus_effects)) assert.equal(value, 1, 'common bonus band is [1,1]');
  for (const value of Object.values(high.bonus_effects)) assert.equal(value >= 3 && value <= 5, true, 'masterwork bonus band is [3,5]');
  const allowed = new Set(['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power']);
  for (const key of Object.keys(high.bonus_effects)) assert.equal(allowed.has(key), true);
});

test('amulet crafts never carry the weapon-only element_spell_power bonus', async () => {
  const recipeId = 'craft_amulet_earth_t4';
  for (let s = 0; s <= 100; s += 10) {
    const root = await craftRoot({ parameters: craftParams({ charisma: s, magic: { earth: s } }), inventory: richInventory(), elapsedWeeks: 5 });
    const preview = await previewCraft({ root, recipe_id: recipeId });
    assert.equal('element_spell_power' in preview.bonus_effects, false);
    assert.equal('element_spell_power' in preview.base_effects, false);
  }
});

test('completeCraft is atomic: an empty name or short materials leaves inventory and surface untouched', async () => {
  const recipeId = 'craft_weapon_sword_fire_t2'; // tier 2 needs 4 material_fire_t2
  const root = await craftRoot({ parameters: craftParams({ academics: 50, magic: { fire: 50 } }), inventory: { money: 100000, items: [{ item_id: 'material_fire_t2', quantity: 4 }] }, elapsedWeeks: 1 });

  await assert.rejects(completeCraft({ root, recipe_id: recipeId, name: '', flavor: 'x' }), /name must be a non-empty string/);
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] }, 'no instance added on a bad name');
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).items[0].quantity, 4, 'materials untouched on a bad name');

  await writeJson(root, 'data/mutable/game_data/player_inventory.json', { money: 100000, items: [{ item_id: 'material_fire_t2', quantity: 1 }] });
  await assert.rejects(completeCraft({ root, recipe_id: recipeId, name: '刀', flavor: 'x' }), /insufficient_item_quantity/);
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] }, 'no instance added on short materials');
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).items[0].quantity, 1, 'materials untouched on short materials');
});

test('a successful craft consumes materials and adds the instance; a same-week recraft fails fast', async () => {
  const recipeId = 'craft_weapon_sword_fire_t2';
  const root = await craftRoot({ parameters: craftParams({ academics: 80, magic: { fire: 80 } }), inventory: richInventory(), elapsedWeeks: 4 });
  const ownedBefore = (await readJson(root, 'data/mutable/game_data/player_inventory.json')).items.find((item) => item.item_id === 'material_fire_t2').quantity;

  const done = await completeCraft({ root, recipe_id: recipeId, name: '紅蓮刀', flavor: '熾火の刃。' });
  const after = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  assert.equal(after.items.find((item) => item.item_id === 'material_fire_t2').quantity, ownedBefore - 4, 'materials consumed');
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1);
  assert.equal(surface.instances[0].instance_id, done.instance.instance_id);
  assert.equal(surface.instances[0].name, '紅蓮刀');

  // Same week + same recipe → duplicate instance_id → fail-fast, and nothing more is spent.
  await assert.rejects(completeCraft({ root, recipe_id: recipeId, name: '別の名', flavor: 'x' }), /instance_id already exists/);
  const afterDup = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  assert.equal(afterDup.items.find((item) => item.item_id === 'material_fire_t2').quantity, ownedBefore - 4, 'the failed recraft consumed nothing');
});

test('a crafted weapon equips and its attack reflects into a dungeon run (v1 backend integration)', async () => {
  const root = await craftDungeonRoot({ academics: 80, charisma: 50, magic: { fire: 80 }, elapsedWeeks: 4 });
  const recipeId = 'craft_weapon_sword_fire_t2';
  const done = await completeCraft({ root, recipe_id: recipeId, name: '紅蓮刀', flavor: '熾火の刃。' });

  const base = await enterDungeon({ root, seed: 100 });
  // Leave the run so we can re-enter equipped from the same state.
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run = null;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  await equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon', instance_id: done.instance.instance_id });
  const equipped = await enterDungeon({ root, seed: 100 });

  const attackBonus = done.instance.base_effects.attack + (done.instance.bonus_effects.attack ?? 0);
  assert.equal(equipped.player_stats.melee_attack, base.player_stats.melee_attack + attackBonus, 'crafted weapon attack reflects in the run');
  assert.equal(equipped.equipment.slots.weapon.instance_id, done.instance.instance_id);
});

test('under active-slot routing the seed identity is the slot id, so distinct slots roll and id distinctly', async () => {
  // Mirror real routed play: a shared source root holds definitions, and each save
  // slot's game_data lives at .../play/slots/<slot_id>/game_data, reached through the
  // runtime-paths manifest that resolveValidActivePlayRoot writes. slotSeedIdentity =
  // basename(dirname(mutableRoot)) therefore resolves to <slot_id>.
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-craft-src-'));

  async function routedSlot(slotId) {
    const slotGameData = path.join(sourceRoot, 'data/mutable/play/slots', slotId, 'game_data');
    await fs.mkdir(path.join(slotGameData, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(slotGameData, 'runtime_state.json'), `${JSON.stringify({ version: 1, elapsed_weeks: 4, characters: {} }, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(slotGameData, 'runtime/player_parameters.json'), `${JSON.stringify(craftParams({ academics: 60, magic: { fire: 60 } }), null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(slotGameData, 'player_inventory.json'), `${JSON.stringify(richInventory(), null, 2)}\n`, 'utf8');
    const playRoot = path.join(sourceRoot, 'data/mutable/play', `active_${slotId}`);
    await fs.mkdir(playRoot, { recursive: true });
    await writeRuntimePathsManifest({ root: playRoot, sourceRoot, mutableRoot: slotGameData });
    return playRoot;
  }

  const rootA = await routedSlot('slot_alpha');
  const rootB = await routedSlot('slot_beta');
  const recipeId = 'craft_weapon_sword_fire_t2';
  const a = await previewCraft({ root: rootA, recipe_id: recipeId });
  const b = await previewCraft({ root: rootB, recipe_id: recipeId });

  // The seed identity is the real slot id (proven by the instance_id it derives), so
  // the same week+recipe yields per-slot-distinct ids across two different saves.
  assert.equal(a.instance_id, 'equip_slot_alpha_w4_craft_weapon_sword_fire_t2');
  assert.equal(b.instance_id, 'equip_slot_beta_w4_craft_weapon_sword_fire_t2');
  assert.notEqual(a.instance_id, b.instance_id, 'distinct slots derive distinct instance ids');
});

test('craft fails fast on unknown recipe, missing player parameters, or missing elapsed_weeks', async () => {
  const good = await craftRoot({ parameters: craftParams({}), inventory: richInventory(), elapsedWeeks: 0 });
  await assert.rejects(previewCraft({ root: good, recipe_id: 'craft_weapon_sword_fire_t9' }), /unknown craft recipe/);

  const noParams = await craftRoot({ inventory: richInventory(), elapsedWeeks: 0 });
  await assert.rejects(previewCraft({ root: noParams, recipe_id: 'craft_weapon_sword_fire_t1' }), /player parameters are required/);

  const noWeek = await craftRoot({ parameters: craftParams({}), inventory: richInventory() });
  const state = await readJson(noWeek, 'data/mutable/game_data/runtime_state.json');
  delete state.elapsed_weeks;
  await writeJson(noWeek, 'data/mutable/game_data/runtime_state.json', state);
  await assert.rejects(previewCraft({ root: noWeek, recipe_id: 'craft_weapon_sword_fire_t1' }), /elapsed_weeks must be a non-negative integer/);

  // A missing inventory file is a hard error for preview, not a silently-empty wallet.
  const noInventory = await craftRoot({ parameters: craftParams({}), elapsedWeeks: 0 });
  await assert.rejects(previewCraft({ root: noInventory, recipe_id: 'craft_weapon_sword_fire_t1' }), /player inventory is required/);
});
