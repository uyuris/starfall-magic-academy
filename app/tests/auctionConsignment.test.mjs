import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { writeStarCradleCatalogDefinitionSplit } from './starCradleFixture.mjs';
import {
  ROUTING_AUCTION_STATE_KEY,
  ROUTING_AUCTION_CONSIGNMENT_STATE_KEY,
  loadAuctionCatalog,
  auctionCatalogItem,
  buildAuctionSlot,
  deriveAuctionEquipmentInstance,
  bandForConsignmentValue,
  auctionConsignmentEquipmentMarketValue,
  auctionConsignmentItemMarketValue,
  AUCTION_CONSIGNMENT_EQUIPMENT_VALUE_MULTIPLIER,
  AUCTION_CONSIGNMENT_ITEM_VALUE_MULTIPLIER,
  buildConsignmentLot,
  buildConsignmentSkip,
  validateConsignment,
  recordConsignmentResolution,
  readConsignmentForWeek
} from '../src/routingAuction.mjs';
import { buildMasterOpeningPrompt, buildNpcBidPrompt } from '../src/llm/auctionGeneration.mjs';
import { payoutConsignmentToPlayer } from '../src/auctionAward.mjs';
import { equipmentSellPrice } from '../src/equipmentSale.mjs';
import {
  getAuctionState,
  listConsignableItems,
  submitConsignment,
  skipConsignment,
  resolveConsignmentLot
} from '../src/routingAuctionSession.mjs';
import { canHandleAuctionApiRoute } from '../src/server/auctionApi.mjs';
import { loadInventory } from '../src/economy.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';

const RUNTIME_STATE_MUTABLE = 'data/mutable/game_data/runtime_state.json';
const EQUIPMENT_MUTABLE = 'data/mutable/game_data/player_equipment.json';
const WEEK = 4;
const BIDDERS = [
  { character_id: 'character_001', display_name: 'キャラ1' },
  { character_id: 'character_002', display_name: 'キャラ2' },
  { character_id: 'character_003', display_name: 'キャラ3' }
];
const BUDGETS = { character_001: 50000, character_002: 50000, character_003: 50000 };
const SELL_ITEM = 'material_light_t3'; // a known dungeon material, sell_price 120 (> 0)

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readState(root) {
  return JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
}

async function readMutableInventory(root) {
  for (const relativePath of ['data/mutable/game_data/player_inventory.json', 'data/seeds/game_data/player_inventory.json']) {
    try {
      return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('no player inventory found');
}

// A consignment-capable root: definitions the economy/equipment paths read + inventory + runtime_state. Optionally
// seeds an equipment instance and/or inventory items so the consignable-asset paths resolve.
async function consignmentRoot({ money = 60000, inventoryItems = [], equipmentInstances = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-consign-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '設定', world_condition_texts: []
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeStarCradleCatalogDefinitionSplit(root);
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money, items: inventoryItems });
  await writeJson(root, RUNTIME_STATE_MUTABLE, { version: 1, elapsed_weeks: WEEK, global_flags: {}, characters: {} });
  if (equipmentInstances.length > 0) await writeJson(root, EQUIPMENT_MUTABLE, { version: 1, instances: equipmentInstances });
  return root;
}

// Builds a 3-lot house slot so the consignment window (current_lot_index 0) is open with seated bidders.
async function seedSlot(root, itemIds = ['auction_item_05', 'auction_wa_02', 'auction_being_11']) {
  const catalog = await loadAuctionCatalog({ root });
  const lots = itemIds.map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index, item, band: item.band, initial_price: [6000, 9000, 8000][index], min_increment: 300, npc_budgets: { ...BUDGETS } };
  });
  const slot = buildAuctionSlot({ week: WEEK, bidders: BIDDERS, lots });
  const state = await readState(root);
  await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, [ROUTING_AUCTION_STATE_KEY]: slot });
  return slot;
}

async function mintEquipmentInstance(root) {
  const catalog = await loadAuctionCatalog({ root });
  const item = auctionCatalogItem(catalog, 'auction_wa_01'); // a B-band sword 骨子
  return deriveAuctionEquipmentInstance({ item, week: WEEK, name: '暁の一振り', flavor: '柄に星屑の名残が滲む一振り' });
}

// ----- domain: band mapping -----

test('bandForConsignmentValue maps a value anchor to the lowest band whose ceiling covers it (clamped C..S)', async () => {
  const catalog = await loadAuctionCatalog({ root: await consignmentRoot() });
  assert.equal(bandForConsignmentValue(catalog, 120), 'C');   // below C floor -> C
  assert.equal(bandForConsignmentValue(catalog, 1500), 'C');  // C ceiling -> C (bands touch)
  assert.equal(bandForConsignmentValue(catalog, 1501), 'B');
  assert.equal(bandForConsignmentValue(catalog, 5000), 'B');
  assert.equal(bandForConsignmentValue(catalog, 12000), 'A');
  assert.equal(bandForConsignmentValue(catalog, 40000), 'S');
  assert.equal(bandForConsignmentValue(catalog, 999999), 'S'); // above S ceiling -> S
});

test('consignment market value (sale price × multiplier) calibrates equipment/item bands to the house price 金額感', async () => {
  const catalog = await loadAuctionCatalog({ root: await consignmentRoot() });
  assert.equal(AUCTION_CONSIGNMENT_EQUIPMENT_VALUE_MULTIPLIER, 20);
  assert.equal(AUCTION_CONSIGNMENT_ITEM_VALUE_MULTIPLIER, 3);

  // 装備: sell price × 20. tier3 excellent (135) → 2700 = B, tier4 masterwork (448) → 8960 = A.
  const excellentT3 = equipmentSellPrice({ tier: 3, quality: 'excellent' });
  const masterworkT4 = equipmentSellPrice({ tier: 4, quality: 'masterwork' });
  assert.equal(auctionConsignmentEquipmentMarketValue(excellentT3), 2700);
  assert.equal(auctionConsignmentEquipmentMarketValue(masterworkT4), 8960);
  assert.equal(bandForConsignmentValue(catalog, auctionConsignmentEquipmentMarketValue(excellentT3)), 'B');
  assert.equal(bandForConsignmentValue(catalog, auctionConsignmentEquipmentMarketValue(masterworkT4)), 'A');

  // 所持品: sell_price × 3. dungeon 素材 (max 400) → 1200 = C; 調合 product 300/900/2600/7000 → 900/2700/7800/21000 = C/B/A/S.
  assert.equal(auctionConsignmentItemMarketValue(400), 1200);
  assert.equal(bandForConsignmentValue(catalog, auctionConsignmentItemMarketValue(400)), 'C');
  assert.deepEqual(
    [300, 900, 2600, 7000].map((sell) => bandForConsignmentValue(catalog, auctionConsignmentItemMarketValue(sell))),
    ['C', 'B', 'A', 'S']
  );

  // no silent low band: a non-positive sale price fails fast rather than banding at the floor.
  assert.throws(() => auctionConsignmentEquipmentMarketValue(0), /must be a positive integer/);
  assert.throws(() => auctionConsignmentItemMarketValue(-1), /must be a positive integer/);
});

test('落札時入金 ≥ shop/工房売却額: the consignment initial price never dips below the asset sale price (equipment + item, representative + boundary)', async () => {
  const catalog = await loadAuctionCatalog({ root: await consignmentRoot() });
  // 装備: every tier/quality — market value = sell × 20, band covers it, initial = clamp(market, floor, ceil) ≥ sell.
  for (const tier of [1, 2, 3, 4]) {
    for (const quality of ['common', 'fine', 'excellent', 'masterwork']) {
      const salePrice = equipmentSellPrice({ tier, quality });
      const valueAnchor = auctionConsignmentEquipmentMarketValue(salePrice);
      const band = bandForConsignmentValue(catalog, valueAnchor);
      const lot = buildConsignmentLot({ week: WEEK, source: { kind: 'equipment', instance_id: 'x' }, presentation: { name: 'n', category_label: '武器', blurb: 'b' }, band, valueAnchor, bidders: BIDDERS, catalog });
      assert.ok(lot.initial_price >= salePrice, `equip tier${tier} ${quality}: initial ${lot.initial_price} >= sale ${salePrice}`);
      // an awarded bid is validated as ≥ initial_price, so the payout is ≥ sale price by transitivity.
      assert.throws(() => validateConsignment({ ...lot, status: 'resolved', award: { outcome: 'awarded', winner_character_id: 'character_001', amount: salePrice - 1 } }), /at least the initial price/);
    }
  }
  // 所持品: dungeon 素材 (10/400) + 調合 product 300/900/2600/7000 across all four bands.
  for (const salePrice of [10, 400, 300, 900, 2600, 7000]) {
    const valueAnchor = auctionConsignmentItemMarketValue(salePrice);
    const band = bandForConsignmentValue(catalog, valueAnchor);
    const lot = buildConsignmentLot({ week: WEEK, source: { kind: 'item', item_id: 'x' }, presentation: { name: 'n', category_label: '所持品', blurb: 'b' }, band, valueAnchor, bidders: BIDDERS, catalog });
    assert.ok(lot.initial_price >= salePrice, `item sale ${salePrice}: initial ${lot.initial_price} >= sale ${salePrice}`);
  }
});

// ----- domain: buildConsignmentLot / validate / resolve / skip -----

test('buildConsignmentLot derives band/initial(clamped)/increment/per-bidder budgets deterministically, and roundtrips through validateConsignment', async () => {
  const catalog = await loadAuctionCatalog({ root: await consignmentRoot() });
  const source = { kind: 'item', item_id: 'my_relic' };
  const presentation = { name: '古い遺物', category_label: '所持品', blurb: '触れ込み' };
  const lot = buildConsignmentLot({ week: WEEK, source, presentation, band: bandForConsignmentValue(catalog, 200), valueAnchor: 200, bidders: BIDDERS, catalog });
  assert.equal(lot.status, 'listed');
  assert.equal(lot.band, 'C');
  assert.equal(lot.initial_price, 300);           // 200 clamped up into [300,1500]
  assert.equal(lot.min_increment, catalog.price_bands.C.min_increment);
  assert.deepEqual(Object.keys(lot.npc_budgets).sort(), ['character_001', 'character_002', 'character_003']);
  for (const budget of Object.values(lot.npc_budgets)) assert.ok(budget >= catalog.price_bands.C.price_min);
  assert.equal(lot.award, null);
  // deterministic for the same (week, source, bidders)
  const again = buildConsignmentLot({ week: WEEK, source, presentation, band: bandForConsignmentValue(catalog, 200), valueAnchor: 200, bidders: BIDDERS, catalog });
  assert.deepEqual(again.npc_budgets, lot.npc_budgets);
  // validateConsignment accepts the built record verbatim
  assert.deepEqual(validateConsignment(lot), lot);
});

test('validateConsignment fail-fasts on a bad status, listed-with-award, resolved-without-award, and non-character winner', async () => {
  const catalog = await loadAuctionCatalog({ root: await consignmentRoot() });
  const base = buildConsignmentLot({ week: WEEK, source: { kind: 'item', item_id: 'x' }, presentation: { name: 'n', category_label: 'c', blurb: 'b' }, band: bandForConsignmentValue(catalog, 200), valueAnchor: 200, bidders: BIDDERS, catalog });
  assert.throws(() => validateConsignment({ ...base, status: 'weird' }), /status must be one of/);
  assert.throws(() => validateConsignment({ ...base, award: { outcome: 'awarded', winner_character_id: 'character_001', amount: base.initial_price } }), /listed must have award null/);
  assert.throws(() => validateConsignment({ ...base, status: 'resolved', award: null }), /resolved must have a non-null award/);
  assert.throws(() => validateConsignment({ ...base, status: 'resolved', award: { outcome: 'awarded', winner_character_id: 'player', amount: base.initial_price } }), /winner_character_id must be a seated bidder id/);
});

test('recordConsignmentResolution records an awarded / passed_in outcome and refuses a non-listed record; buildConsignmentSkip is terminal', async () => {
  const catalog = await loadAuctionCatalog({ root: await consignmentRoot() });
  const listed = buildConsignmentLot({ week: WEEK, source: { kind: 'item', item_id: 'x' }, presentation: { name: 'n', category_label: 'c', blurb: 'b' }, band: bandForConsignmentValue(catalog, 4000), valueAnchor: 4000, bidders: BIDDERS, catalog });
  const awarded = recordConsignmentResolution(listed, { outcome: 'awarded', winnerCharacterId: 'character_002', amount: listed.initial_price + listed.min_increment });
  assert.equal(awarded.status, 'resolved');
  assert.equal(awarded.award.winner_character_id, 'character_002');
  const flopped = recordConsignmentResolution(listed, { outcome: 'passed_in' });
  assert.equal(flopped.status, 'resolved');
  assert.deepEqual(flopped.award, { outcome: 'passed_in', winner_character_id: null, amount: null });
  assert.throws(() => recordConsignmentResolution(awarded, { outcome: 'passed_in' }), /cannot resolve auction consignment in status resolved/);
  const skip = buildConsignmentSkip(WEEK);
  assert.deepEqual(skip, { week: WEEK, status: 'skipped' });
});

// ----- prompt contract: 出品 variant 3差分 + 出品明示行 -----

test('the master opening consignment variant adds exactly the three 出品 diffs and the house form has none of them', () => {
  const lot = { initial_price: 3000, min_increment: 100 };
  const presentation = { name: '暁の一振り', category_label: '武器', blurb: '柄に星屑の名残が滲む一振り' };
  const consign = buildMasterOpeningPrompt({ lot, presentation, consignment: true });
  const house = buildMasterOpeningPrompt({ lot, presentation, consignment: false });
  assert.match(consign, /お客から持ち込まれた品を客たちに披露し/);
  assert.match(consign, /- 出どころ: この会場の常連客が手放すために持ち込んだ委託の品/);
  assert.match(consign, /この品が客の持ち込んだ委託品であることが伝わるよう口火を切る。/);
  assert.match(consign, /品名: 暁の一振り/); // presentation override is used, not auctionLotPresentation
  for (const marker of ['お客から持ち込まれた品を客たちに披露し', '出どころ: この会場の常連客', '委託品であることが伝わるよう']) {
    assert.equal(house.includes(marker), false, `house opening must not contain: ${marker}`);
  }
  assert.match(house, /次の品を客たちに披露し/);
});

test('the NPC bid consignment flag adds the 委託品 status line; the house form omits it', () => {
  const lot = { initial_price: 3000, min_increment: 100 };
  const presentation = { name: '暁の一振り', category_label: '武器', blurb: '柄に星屑の名残が滲む一振り' };
  const common = { lot, presentation, bidder: { display_name: 'セラ', school_year: '一年', identity: '生徒', prompt_description: '人物像', speaking_basis: '話し方' }, budget: 8000, current: 3000, currentBidderName: null, minNext: 3100 };
  const consign = buildNpcBidPrompt({ ...common, consignment: true });
  const house = buildNpcBidPrompt({ ...common, consignment: false });
  assert.match(consign, /- この出品物は、この会場のお客（主人公）が持ち込んだ委託品である。会場の主催者の品ではない。/);
  assert.equal(house.includes('この会場のお客（主人公）が持ち込んだ委託品'), false);
  assert.match(consign, /出品物: 暁の一振り（武器）／柄に星屑の名残が滲む一振り/);
});

// ----- payout writer: atomic asset removal + money credit -----

test('payoutConsignmentToPlayer (equipment) removes the instance and credits the winning bid; rejects an unknown or equipped instance before any write', async (t) => {
  const instance = await mintEquipmentInstance(await consignmentRoot());
  const root = await consignmentRoot({ money: 1000, equipmentInstances: [instance] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const payout = await payoutConsignmentToPlayer({ root, source: { kind: 'equipment', instance_id: instance.instance_id }, amount: 5000 });
  assert.equal(payout.amount, 5000);
  assert.equal((await readMutableInventory(root)).money, 6000);
  assert.equal((await loadEquipmentSurface({ root })).instances.length, 0);

  // unknown instance -> rejected, nothing written
  await assert.rejects(payoutConsignmentToPlayer({ root, source: { kind: 'equipment', instance_id: 'nope' }, amount: 5000 }), /unknown_equipment_instance/);

  // equipped instance -> rejected before any write
  const root2 = await consignmentRoot({ money: 1000, equipmentInstances: [instance] });
  t.after(() => fs.rm(root2, { recursive: true, force: true }));
  const state = await readState(root2);
  await writeJson(root2, RUNTIME_STATE_MUTABLE, { ...state, equipment_slots: { weapon: instance.instance_id } });
  await assert.rejects(payoutConsignmentToPlayer({ root: root2, source: { kind: 'equipment', instance_id: instance.instance_id }, amount: 5000 }), /equipment_instance_equipped/);
  assert.equal((await readMutableInventory(root2)).money, 1000); // untouched
  assert.equal((await loadEquipmentSurface({ root: root2 })).instances.length, 1); // untouched
});

test('payoutConsignmentToPlayer (item) removes one unit and credits the winning bid', async (t) => {
  const root = await consignmentRoot({ money: 500, inventoryItems: [{ item_id: SELL_ITEM, quantity: 2 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payout = await payoutConsignmentToPlayer({ root, source: { kind: 'item', item_id: SELL_ITEM }, amount: 300 });
  assert.equal(payout.amount, 300);
  assert.equal((await readMutableInventory(root)).money, 800);
  const inventory = await loadInventory({ root });
  assert.equal(inventory.items.find((entry) => entry.item_id === SELL_ITEM).quantity, 1);
});

// ----- session: options / submit / skip / window guards -----

test('listConsignableItems returns unequipped equipment + sell_price>0 items, each with the band its anchor maps to', async (t) => {
  const instance = await mintEquipmentInstance(await consignmentRoot());
  const root = await consignmentRoot({ inventoryItems: [{ item_id: SELL_ITEM, quantity: 3 }], equipmentInstances: [instance] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = await listConsignableItems({ root });
  assert.equal(options.week, WEEK);
  const equip = options.equipment.find((entry) => entry.instance_id === instance.instance_id);
  assert.ok(equip, 'unequipped instance is listed');
  // value anchor is the market value (sell price × 20), not the raw sell price; a B-band 骨子 (tier3 excellent) resells at B.
  assert.equal(equip.value_anchor, equipmentSellPrice({ tier: instance.tier, quality: instance.quality }) * AUCTION_CONSIGNMENT_EQUIPMENT_VALUE_MULTIPLIER);
  assert.equal(equip.value_anchor, 2700);
  assert.equal(equip.band, 'B');
  assert.equal(equip.category_label, '武器');
  const item = options.items.find((entry) => entry.item_id === SELL_ITEM);
  assert.ok(item, 'sell_price>0 item is listed');
  assert.equal(item.value_anchor, 120 * AUCTION_CONSIGNMENT_ITEM_VALUE_MULTIPLIER); // 360, a dungeon material stays C
  assert.equal(item.band, 'C');

  // an equipped instance drops out of the list
  const state = await readState(root);
  await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, equipment_slots: { weapon: instance.instance_id } });
  const afterEquip = await listConsignableItems({ root });
  assert.equal(afterEquip.equipment.find((entry) => entry.instance_id === instance.instance_id), undefined);
});

test('submitConsignment lists the chosen asset (persisted, budgets hidden from the view), and skip / already-decided / window-passed guards fail fast', async (t) => {
  const root = await consignmentRoot({ inventoryItems: [{ item_id: SELL_ITEM, quantity: 1 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);

  const view = await submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } });
  assert.equal(view.status, 'listed');
  assert.equal(view.band, 'C');
  assert.equal(view.presentation.name, '白曜の輝石');
  assert.equal(view.npc_budgets, undefined); // never leaked
  // persisted under its own state key with budgets present
  const persisted = readConsignmentForWeek(await readState(root), WEEK);
  assert.deepEqual(Object.keys(persisted.npc_budgets).sort(), ['character_001', 'character_002', 'character_003']);

  // already decided -> 409
  await assert.rejects(submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } }),
    (error) => error.statusCode === 409 && error.errorCode === 'AUCTION_CONSIGNMENT_DECIDED');
  await assert.rejects(skipConsignment({ root }),
    (error) => error.statusCode === 409 && error.errorCode === 'AUCTION_CONSIGNMENT_DECIDED');
});

test('submitConsignment rejects an unknown / no-sell-value asset before persisting anything', async (t) => {
  const root = await consignmentRoot({ inventoryItems: [{ item_id: 'auction_item_05', quantity: 1 }] }); // treasure: sell_price 0
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  await assert.rejects(submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: 'auction_item_05' } }),
    (error) => error.statusCode === 409 && error.errorCode === 'AUCTION_CONSIGNMENT_NOT_CONSIGNABLE');
  await assert.rejects(submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: 'ghost' } }),
    (error) => error.statusCode === 404 && error.errorCode === 'AUCTION_CONSIGNMENT_UNKNOWN_ASSET');
  assert.equal(readConsignmentForWeek(await readState(root), WEEK), null); // nothing persisted
});

test('skipConsignment records a terminal skipped decision', async (t) => {
  const root = await consignmentRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  const view = await skipConsignment({ root });
  assert.deepEqual(view, { status: 'skipped', week: WEEK });
  assert.equal(readConsignmentForWeek(await readState(root), WEEK).status, 'skipped');
});

// ----- session: resolve (settle / 流札) with the payout writer -----

test('resolveConsignmentLot awards to an NPC: the winning bid is credited, the item is removed, and the record is resolved', async (t) => {
  const root = await consignmentRoot({ money: 1000, inventoryItems: [{ item_id: SELL_ITEM, quantity: 1 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  await submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } });
  const listed = readConsignmentForWeek(await readState(root), WEEK);
  const winPrice = listed.initial_price + listed.min_increment;

  const result = await resolveConsignmentLot({ root, authoringRoot: root, winner: 'character_002', amount: winPrice });
  assert.equal(result.resolution.outcome, 'awarded');
  assert.equal(result.resolution.winner_character_id, 'character_002');
  assert.equal(result.payout.amount, winPrice);
  assert.equal((await readMutableInventory(root)).money, 1000 + winPrice);
  assert.equal((await loadInventory({ root })).items.find((entry) => entry.item_id === SELL_ITEM), undefined); // removed
  assert.equal(readConsignmentForWeek(await readState(root), WEEK).status, 'resolved');
});

test('resolveConsignmentLot 流札 (winner null) leaves the asset with the player and records passed_in', async (t) => {
  const root = await consignmentRoot({ money: 1000, inventoryItems: [{ item_id: SELL_ITEM, quantity: 1 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  await submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } });

  const result = await resolveConsignmentLot({ root, authoringRoot: root, winner: null, amount: null });
  assert.equal(result.resolution.outcome, 'passed_in');
  assert.equal(result.payout, null);
  assert.equal((await readMutableInventory(root)).money, 1000); // unchanged
  assert.equal((await loadInventory({ root })).items.find((entry) => entry.item_id === SELL_ITEM).quantity, 1); // asset stays
  assert.equal(readConsignmentForWeek(await readState(root), WEEK).status, 'resolved');
});

test('resolveConsignmentLot rejects a winner that is not a seated bidder', async (t) => {
  const root = await consignmentRoot({ inventoryItems: [{ item_id: SELL_ITEM, quantity: 1 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  await submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } });
  await assert.rejects(resolveConsignmentLot({ root, authoringRoot: root, winner: 'character_099', amount: 400 }),
    (error) => error.statusCode === 400 && error.errorCode === 'AUCTION_UNKNOWN_BIDDER');
});

// ----- state view + API surface -----

test('getAuctionState surfaces the consignment sub-state alongside the house slot', async (t) => {
  const root = await consignmentRoot({ inventoryItems: [{ item_id: SELL_ITEM, quantity: 1 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  assert.equal((await getAuctionState({ root, authoringRoot: root })).consignment, null);
  await submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } });
  const view = await getAuctionState({ root, authoringRoot: root });
  assert.equal(view.consignment.status, 'listed');
  assert.equal(view.consignment.npc_budgets, undefined);
});

test('the consignment HTTP routes are registered on the auction router', () => {
  for (const [method, pathname] of [
    ['GET', '/api/auction/consignment/options'],
    ['POST', '/api/auction/consignment/submit'],
    ['POST', '/api/auction/consignment/skip'],
    ['POST', '/api/auction/consignment/opening/stream'],
    ['POST', '/api/auction/consignment/reaction/stream'],
    ['POST', '/api/auction/consignment/hammer/stream'],
    ['POST', '/api/auction/consignment/npc-bid'],
    ['POST', '/api/auction/consignment/resolve']
  ]) {
    assert.equal(canHandleAuctionApiRoute(method, pathname), true, `${method} ${pathname} must be routed`);
  }
});
