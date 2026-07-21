import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promises as fs } from 'node:fs';

import {
  WORKSHOP_DESTINATION_ID,
  workshopSkillOutlook,
  buildWorkshopArrivalView,
  executeWorkshopCraft
} from '../src/routingWorkshop.mjs';
import { routingDestinations, parseRoutingDestinationAnswer } from '../src/routingDestinations.mjs';
import { resolveRoutingDestinationDispatch, isRoutingTitleDispatch } from '../src/routingDispatch.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';
import {
  buildWorkshopContentResult,
  validateRoutingContentResult,
  buildAlchemyContentResult
} from '../src/routingContentResult.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { canHandleWorkshopApiRoute, handleWorkshopApi } from '../src/server/workshopApi.mjs';
import { ROUTING_HUB_SCREEN } from '../src/playMode.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from '../src/dungeonMaterialCatalog.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

// ----- craft fixture (split layout, mirrors equipmentCraft tests) -----

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

async function craftRoot({ parameters, inventory, elapsedWeeks = 4 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-workshop-'));
  await seedEconomyDefinitions(root);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: elapsedWeeks, characters: {}, current_screen: 'academy-workshop' });
  if (parameters) await writeJson(root, 'data/mutable/game_data/runtime/player_parameters.json', parameters);
  if (inventory) await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory);
  return root;
}

async function workshopRoot(overrides = {}) {
  return craftRoot({ parameters: craftParams({ academics: 80, magic: { fire: 80, water: 60 } }), inventory: richInventory(), ...overrides });
}

const RUNTIME_STATE_PATH = 'data/mutable/game_data/runtime_state.json';
const INVENTORY_PATH = 'data/mutable/game_data/player_inventory.json';
const NAMING_CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'test-model', timeout_ms: 5000 };
const NOW = '2026-07-05T00:00:00.000Z';

function structuredJsonFetch(content) {
  return async () => ({
    ok: true,
    headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ choices: [{ message: { content } }] })
  });
}

async function inventorySnapshot(root) {
  return readJson(root, INVENTORY_PATH);
}

// ----- catalog / dispatch / selection -----

test('workshop is a published routing destination that dispatches to academy-workshop as a normal week-progressing destination', () => {
  assert.equal(WORKSHOP_DESTINATION_ID, 'workshop');
  const entry = routingDestinations.find((destination) => destination.id === 'workshop');
  assert.ok(entry, 'workshop is in the routing catalog');
  assert.equal(entry.label, '工房');

  const parsed = parseRoutingDestinationAnswer('workshop');
  assert.equal(parsed.id, 'workshop');

  const dispatch = resolveRoutingDestinationDispatch('workshop');
  assert.equal(dispatch.next_screen, 'academy-workshop');
  assert.equal(dispatch.destination_label, '工房');
  // A normal content destination: not the neutral title exit.
  assert.equal(isRoutingTitleDispatch(dispatch), false);
});

test('workshop is offered in the default routing candidate set', () => {
  const candidates = routingDestinationsForState({ elapsed_weeks: 0 });
  assert.equal(candidates.some((destination) => destination.id === 'workshop'), true);
});

// ----- content result closed-vocab extension -----

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
    bonus_effects: { attack: 3 },
    ...overrides
  };
}

test('buildWorkshopContentResult builds a valid workshop record from a finished instance', () => {
  const record = buildWorkshopContentResult({ week: 4, now: NOW, recipeId: 'craft_weapon_sword_fire_t2', instance: weaponInstance() });
  assert.equal(record.kind, 'workshop');
  assert.equal(record.destination_id, 'workshop');
  assert.equal(record.trigger, 'workshop_craft_completed');
  assert.equal(record.week, 4);
  assert.deepEqual(record.detail, {
    outcome: 'completed',
    recipe_id: 'craft_weapon_sword_fire_t2',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    quality: 'masterwork',
    name: '紅蓮の一刀',
    flavor: '熾火を宿した刃。'
  });
  // Round-trips through the public validator.
  assert.deepEqual(validateRoutingContentResult(record), record);
});

test('an amulet workshop record carries no weapon_type', () => {
  const amulet = { instance_id: 'equip_test_w4_craft_amulet_water_t2', kind: 'amulet', element: 'water', tier: 2, quality: 'fine', name: '澪の護符', flavor: '水面の護り。', base_effects: { defense: 4 }, bonus_effects: { max_hp: 2 } };
  const record = buildWorkshopContentResult({ week: 4, now: NOW, recipeId: 'craft_amulet_water_t2', instance: amulet });
  assert.equal(Object.prototype.hasOwnProperty.call(record.detail, 'weapon_type'), false);
  assert.deepEqual(validateRoutingContentResult(record), record);
});

test('workshop content result validation fails fast on corruption and leaves other kinds intact', () => {
  const good = buildWorkshopContentResult({ week: 4, now: NOW, recipeId: 'craft_weapon_sword_fire_t2', instance: weaponInstance() });
  assert.throws(() => validateRoutingContentResult({ ...good, trigger: 'alchemy_recipe_completed' }), /trigger must be 'workshop_craft_completed'/);
  assert.throws(() => validateRoutingContentResult({ ...good, destination_id: 'alchemy' }), /destination_id must be 'workshop'/);
  assert.throws(() => validateRoutingContentResult({ ...good, detail: { ...good.detail, quality: 'legendary' } }), /quality must be one of/);
  assert.throws(() => validateRoutingContentResult({ ...good, detail: { ...good.detail, extra: 1 } }), /unexpected key/);
  // A weapon detail missing weapon_type is corrupt.
  const { weapon_type, ...withoutWeaponType } = good.detail;
  assert.throws(() => validateRoutingContentResult({ ...good, detail: withoutWeaponType }), /missing required key: weapon_type/);

  // The other kinds' contract is unchanged.
  const alchemy = buildAlchemyContentResult({ week: 4, now: NOW, recipeId: 'alchemy_x', itemId: 'alchemy_x', name: '星屑の金平糖', category: 'gift', quantity: 1 });
  assert.deepEqual(validateRoutingContentResult(alchemy), alchemy);
});

// ----- skill outlook (S-derived, never the confirmed quality) -----

test('workshopSkillOutlook is a monotone S-derived band and rejects a bad score', () => {
  assert.equal(workshopSkillOutlook(0).band, 0);
  assert.equal(workshopSkillOutlook(24).band, 0);
  assert.equal(workshopSkillOutlook(25).band, 1);
  assert.equal(workshopSkillOutlook(50).band, 2);
  assert.equal(workshopSkillOutlook(75).band, 3);
  assert.equal(workshopSkillOutlook(100).band, 3);
  let last = -1;
  for (let s = 0; s <= 100; s += 5) {
    const band = workshopSkillOutlook(s).band;
    assert.equal(band >= last, true, `outlook band dropped as S rose (S=${s})`);
    last = band;
  }
  assert.throws(() => workshopSkillOutlook(-1), /non-negative integer/);
});

// ----- arrival view -----

test('buildWorkshopArrivalView returns the priced 96-recipe catalog with an S-outlook and never the confirmed quality', async () => {
  const root = await workshopRoot();
  const view = await buildWorkshopArrivalView({ root });
  assert.equal(view.week, 4);
  assert.equal(view.recipes.length, 96);

  const weaponRow = view.recipes.find((recipe) => recipe.recipe_id === 'craft_weapon_sword_fire_t2');
  assert.equal(weaponRow.kind, 'weapon');
  assert.equal(weaponRow.weapon_type, 'sword');
  assert.equal(weaponRow.element, 'fire');
  assert.equal(weaponRow.tier, 2);
  assert.equal(weaponRow.costs.items[0].item_id, 'material_fire_t2');
  assert.equal(typeof weaponRow.costs.items[0].display_name, 'string');
  assert.equal(weaponRow.costs.items[0].required, 4);
  assert.equal(weaponRow.costs.items[0].held, 99);
  assert.equal(weaponRow.costs.money.held, 100000);
  assert.equal(weaponRow.affordable, true);
  // Skill score for a fire weapon at academics 80 / fire 80 is 80 → top band.
  assert.equal(weaponRow.outlook.band, 3);
  assert.equal(typeof weaponRow.outlook.label, 'string');
  // The roll outputs are withheld; base effects (recipe-fixed) are exposed.
  assert.equal(Object.prototype.hasOwnProperty.call(weaponRow, 'quality'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(weaponRow, 'bonus_effects'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(weaponRow, 'instance_id'), false);
  assert.ok(weaponRow.base_effects.attack > 0);

  const amuletRow = view.recipes.find((recipe) => recipe.recipe_id === 'craft_amulet_water_t2');
  assert.equal(amuletRow.kind, 'amulet');
  assert.equal(Object.prototype.hasOwnProperty.call(amuletRow, 'weapon_type'), false);
});

test('buildWorkshopArrivalView marks a recipe unaffordable when materials are short', async () => {
  const root = await craftRoot({ parameters: craftParams({ academics: 40, magic: { fire: 40 } }), inventory: { money: 100000, items: [{ item_id: 'material_fire_t2', quantity: 1 }] } });
  const view = await buildWorkshopArrivalView({ root });
  const row = view.recipes.find((recipe) => recipe.recipe_id === 'craft_weapon_sword_fire_t2');
  assert.equal(row.costs.items[0].held, 1);
  assert.equal(row.costs.items[0].required, 4);
  assert.equal(row.affordable, false);
});

// ----- craft execution (domain orchestration) -----

test('executeWorkshopCraft crafts, names, and produces a workshop content result on success', async () => {
  const root = await workshopRoot();
  const candidate = { name: '紅蓮の一刀', flavor: '熾火を宿した刃。' };
  const before = await inventorySnapshot(root);

  const result = await executeWorkshopCraft({
    root,
    recipe_id: 'craft_weapon_sword_fire_t2',
    config: NAMING_CONFIG,
    fetchImpl: structuredJsonFetch(JSON.stringify(candidate)),
    now: NOW
  });

  assert.equal(result.instance.name, candidate.name);
  assert.equal(result.instance.flavor, candidate.flavor);
  assert.equal(result.content_result.kind, 'workshop');
  assert.equal(result.content_result.detail.recipe_id, 'craft_weapon_sword_fire_t2');
  assert.equal(result.content_result.detail.name, candidate.name);
  assert.equal(result.content_result.detail.quality, result.instance.quality);

  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1);
  const after = await inventorySnapshot(root);
  assert.equal(after.items.find((item) => item.item_id === 'material_fire_t2').quantity, before.items.find((item) => item.item_id === 'material_fire_t2').quantity - 4);
});

test('executeWorkshopCraft can craft multiple different recipes in one visit', async () => {
  const root = await workshopRoot();
  const first = await executeWorkshopCraft({ root, recipe_id: 'craft_weapon_sword_fire_t2', config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '紅蓮刀', flavor: '火の刃。' })), now: NOW });
  const second = await executeWorkshopCraft({ root, recipe_id: 'craft_amulet_water_t2', config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '澪の護符', flavor: '水の護り。' })), now: NOW });
  assert.notEqual(first.instance.instance_id, second.instance.instance_id);
  assert.equal(second.content_result.detail.recipe_id, 'craft_amulet_water_t2');
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 2);
});

test('executeWorkshopCraft fails fast with nothing consumed on gate, transport, and cost failures', async () => {
  // gate violation (empty name)
  const gateRoot = await workshopRoot();
  const gateBefore = await inventorySnapshot(gateRoot);
  await assert.rejects(
    executeWorkshopCraft({ root: gateRoot, recipe_id: 'craft_weapon_sword_fire_t2', config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '', flavor: 'x' })), now: NOW }),
    /name must not be empty/
  );
  assert.deepEqual(await loadEquipmentSurface({ root: gateRoot }), { version: 1, instances: [] });
  assert.deepEqual(await inventorySnapshot(gateRoot), gateBefore);

  // LM transport unreachable
  const netRoot = await workshopRoot();
  const netBefore = await inventorySnapshot(netRoot);
  const unreachable = async () => { const error = new Error('connect ECONNREFUSED'); error.code = 'ECONNREFUSED'; throw error; };
  await assert.rejects(
    executeWorkshopCraft({ root: netRoot, recipe_id: 'craft_weapon_sword_fire_t2', config: NAMING_CONFIG, fetchImpl: unreachable, now: NOW }),
    (error) => error.code === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );
  assert.deepEqual(await loadEquipmentSurface({ root: netRoot }), { version: 1, instances: [] });
  assert.deepEqual(await inventorySnapshot(netRoot), netBefore);

  // insufficient materials
  const shortRoot = await craftRoot({ parameters: craftParams({ academics: 50, magic: { fire: 50 } }), inventory: { money: 100000, items: [{ item_id: 'material_fire_t2', quantity: 1 }] } });
  await assert.rejects(
    executeWorkshopCraft({ root: shortRoot, recipe_id: 'craft_weapon_sword_fire_t2', config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '刀', flavor: '刃。' })), now: NOW }),
    /insufficient_/
  );
  assert.deepEqual(await loadEquipmentSurface({ root: shortRoot }), { version: 1, instances: [] });
  assert.equal((await inventorySnapshot(shortRoot)).items[0].quantity, 1);
});

test('executeWorkshopCraft requires a recorded_at timestamp before consuming anything', async () => {
  const root = await workshopRoot();
  await assert.rejects(
    executeWorkshopCraft({ root, recipe_id: 'craft_weapon_sword_fire_t2', config: NAMING_CONFIG, fetchImpl: structuredJsonFetch(JSON.stringify({ name: '刀', flavor: '刃。' })) }),
    /requires a recorded_at timestamp/
  );
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] });
});

// ----- HTTP handler (route-match + routing gate + craft) -----

function fakeSendJson() {
  const calls = [];
  return { calls, sendJson: (_res, payload, status = 200) => { calls.push({ payload, status }); return true; } };
}

async function invokeWorkshop({ method, pathname, root, activePlayMode, body = {}, resolveLmStudioConfig = async () => { throw new Error('config must not be resolved'); } }) {
  const { calls, sendJson } = fakeSendJson();
  await handleWorkshopApi({
    req: { method },
    res: {},
    url: new URL(`http://local${pathname}`),
    context: { root, activeRoot: null },
    sendJson,
    readBody: async () => body,
    activePlayMode,
    resolveLmStudioConfig
  });
  return calls[0];
}

async function stubLmServer(t, content) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

// Binds a port then closes it, so a connect attempt to that base_url fails fast with
// ECONNREFUSED — a deterministic "LM Studio unreachable" for the craft path.
async function unreachableBaseUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

test('canHandleWorkshopApiRoute pairs exactly the two workshop routes', () => {
  assert.equal(canHandleWorkshopApiRoute('GET', '/api/workshop'), true);
  assert.equal(canHandleWorkshopApiRoute('POST', '/api/workshop/craft'), true);
  assert.equal(canHandleWorkshopApiRoute('POST', '/api/workshop'), false);
  assert.equal(canHandleWorkshopApiRoute('GET', '/api/workshop/craft'), false);
  assert.equal(canHandleWorkshopApiRoute('GET', '/api/workshop/unknown'), false);
});

test('GET /api/workshop returns the arrival view with a server-authoritative exit and 409s outside routing', async () => {
  const root = await workshopRoot();
  const ok = await invokeWorkshop({ method: 'GET', pathname: '/api/workshop', root, activePlayMode: { mode: 'routing' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.week, 4);
  assert.equal(ok.payload.recipes.length, 96);
  assert.equal(Object.prototype.hasOwnProperty.call(ok.payload.recipes[0], 'quality'), false);
  // The arrival response carries the exit destination so the stay-and-craft screen has a
  // way out even with zero crafts; in routing mode it resolves to the routing hub.
  assert.equal(ok.payload.post_content_screen, ROUTING_HUB_SCREEN);

  await assert.rejects(
    invokeWorkshop({ method: 'GET', pathname: '/api/workshop', root, activePlayMode: { mode: 'loop' } }),
    (error) => error.statusCode === 409 && error.errorCode === 'ROUTING_MODE_REQUIRED'
  );
});

test('POST /api/workshop/craft crafts and records the workshop content result into runtime_state', async (t) => {
  const root = await workshopRoot();
  const base = await stubLmServer(t, JSON.stringify({ name: '紅蓮の一刀', flavor: '熾火を宿した刃。' }));
  const result = await invokeWorkshop({
    method: 'POST',
    pathname: '/api/workshop/craft',
    root,
    activePlayMode: { mode: 'routing' },
    body: { recipe_id: 'craft_weapon_sword_fire_t2' },
    resolveLmStudioConfig: async () => ({ base_url: base, chat_model: 'test-model', timeout_ms: 5000 })
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.result.instance.name, '紅蓮の一刀');
  assert.equal(result.payload.state.last_routing_content_result.kind, 'workshop');

  const persisted = await readJson(root, RUNTIME_STATE_PATH);
  assert.equal(persisted.last_routing_content_result.detail.recipe_id, 'craft_weapon_sword_fire_t2');
  assert.equal(persisted.last_routing_content_result.detail.name, '紅蓮の一刀');
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1);
});

test('GET /api/workshop and POST /api/workshop/craft resolve the same server-authoritative post_content_screen', async (t) => {
  const root = await workshopRoot();
  const base = await stubLmServer(t, JSON.stringify({ name: '紅蓮の一刀', flavor: '熾火を宿した刃。' }));
  const arrival = await invokeWorkshop({ method: 'GET', pathname: '/api/workshop', root, activePlayMode: { mode: 'routing' } });
  const crafted = await invokeWorkshop({
    method: 'POST',
    pathname: '/api/workshop/craft',
    root,
    activePlayMode: { mode: 'routing' },
    body: { recipe_id: 'craft_weapon_sword_fire_t2' },
    resolveLmStudioConfig: async () => ({ base_url: base, chat_model: 'test-model', timeout_ms: 5000 })
  });
  // The arrival exit is the craft exit: same field, same resolved value.
  assert.equal(arrival.payload.post_content_screen, ROUTING_HUB_SCREEN);
  assert.equal(crafted.payload.post_content_screen, ROUTING_HUB_SCREEN);
  assert.equal(arrival.payload.post_content_screen, crafted.payload.post_content_screen);
});

test('POST /api/workshop/craft rejects a missing recipe_id (400) and non-routing mode (409)', async () => {
  const root = await workshopRoot();
  await assert.rejects(
    invokeWorkshop({ method: 'POST', pathname: '/api/workshop/craft', root, activePlayMode: { mode: 'routing' }, body: {}, resolveLmStudioConfig: async () => NAMING_CONFIG }),
    (error) => error.statusCode === 400 && error.errorCode === 'WORKSHOP_RECIPE_ID_REQUIRED'
  );
  await assert.rejects(
    invokeWorkshop({ method: 'POST', pathname: '/api/workshop/craft', root, activePlayMode: { mode: 'loop' }, body: { recipe_id: 'craft_weapon_sword_fire_t2' } }),
    (error) => error.statusCode === 409 && error.errorCode === 'ROUTING_MODE_REQUIRED'
  );
});

test('POST /api/workshop/craft surfaces an unconfigured LM as 503 with nothing consumed', async () => {
  const root = await workshopRoot();
  const before = await inventorySnapshot(root);
  const result = await invokeWorkshop({
    method: 'POST',
    pathname: '/api/workshop/craft',
    root,
    activePlayMode: { mode: 'routing' },
    body: { recipe_id: 'craft_weapon_sword_fire_t2' },
    resolveLmStudioConfig: async () => { const error = new Error('LM Studio config required'); error.statusCode = 503; error.errorCode = 'LMSTUDIO_CONFIG_REQUIRED'; throw error; }
  }).catch((error) => ({ thrown: error }));
  // The 503 propagates to the server's outer catch (it is not a craft client error).
  assert.equal(result.thrown.statusCode, 503);
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] });
  assert.deepEqual(await inventorySnapshot(root), before);
});

test('POST /api/workshop/craft maps a craft-time LM connection failure to HTTP 503 with nothing consumed', async () => {
  const root = await workshopRoot();
  const before = await inventorySnapshot(root);
  // LM Studio is configured but unreachable: the naming call inside executeWorkshopCraft
  // throws LMSTUDIO_CONNECTION_UNAVAILABLE (statusCode 503) before completeCraft, so the
  // handler answers 503 and materials stay unconsumed.
  const base = await unreachableBaseUrl();
  const result = await invokeWorkshop({
    method: 'POST',
    pathname: '/api/workshop/craft',
    root,
    activePlayMode: { mode: 'routing' },
    body: { recipe_id: 'craft_weapon_sword_fire_t2' },
    resolveLmStudioConfig: async () => ({ base_url: base, chat_model: 'test-model', timeout_ms: 2000 })
  });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error_code, 'LMSTUDIO_CONNECTION_UNAVAILABLE');
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] });
  assert.deepEqual(await inventorySnapshot(root), before);
});
