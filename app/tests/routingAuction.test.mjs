import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { projectRoot } from './testPaths.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import {
  AUCTION_ITEM_CATEGORIES,
  AUCTION_MIN_BIDDERS,
  AUCTION_MAX_BIDDERS,
  AUCTION_SOLD_LEDGER_STATE_KEY,
  ROUTING_AUCTION_STATE_KEY,
  ROUTING_AUCTION_CONSIGNMENT_STATE_KEY,
  auctionCatalogItem,
  buildAuctionSlot,
  deriveAuctionEquipmentInstance,
  drawWeeklyAuctionLots,
  generateAuctionBeingParameters,
  isAuctionClosedForWeek,
  loadAuctionCatalog,
  loadAuctionInventoryItems,
  nextAuctionSoldLedger,
  planStaleAuctionBidderStateRemoval,
  readAuctionSlot,
  readAuctionSlotForWeek,
  readAuctionSoldLedger,
  recordAuctionLotAward,
  validateAuctionCatalog,
  validateAuctionSlot
} from '../src/routingAuction.mjs';
import {
  awardAuctionBeingToPlayer,
  awardAuctionEquipmentToPlayer,
  awardAuctionItemToPlayer,
  canAdoptAuctionBeing
} from '../src/auctionAward.mjs';
import { loadInventory } from '../src/economy.mjs';
import { loadEquipmentSurface, validateEquipmentInstance } from '../src/equipment.mjs';
import { loadHomunculiSurface, isAuctionFaceId } from '../src/homunculusSurface.mjs';
import { availableFaceLanes } from '../src/homunculusPool.mjs';

function rosterOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    character_id: `character_${String(index + 1).padStart(3, '0')}`,
    display_name: `キャラ${index + 1}`
  }));
}

async function loadCatalog() {
  return loadAuctionCatalog({ root: projectRoot });
}

// ----- catalog -----

test('the authored auction catalog loads with the full 52-item vocabulary and closed being face set', async () => {
  const catalog = await loadCatalog();
  assert.equal(catalog.items.length, 52);
  const byCategory = new Map(AUCTION_ITEM_CATEGORIES.map((category) => [category, 0]));
  for (const item of catalog.items) byCategory.set(item.category, byCategory.get(item.category) + 1);
  assert.deepEqual(Object.fromEntries(byCategory), { weapon_amulet: 12, treasure: 10, being: 15, flavor: 15 });

  const faceIds = catalog.items.filter((item) => item.category === 'being').map((item) => item.face_id).sort();
  assert.deepEqual(faceIds, Array.from({ length: 15 }, (_, index) => `ab_${String(index + 1).padStart(3, '0')}`));
  // Every band in the catalog is drawn from the closed price-band vocabulary.
  for (const item of catalog.items) assert.ok(['C', 'B', 'A', 'S'].includes(item.band), `band ${item.band}`);
  assert.deepEqual(Object.keys(catalog.price_bands).sort(), ['A', 'B', 'C', 'S']);
});

test('the auction catalog validator fails fast on structural corruption', async () => {
  const base = await loadCatalog();
  const clone = () => JSON.parse(JSON.stringify(base));

  const badCategory = clone();
  badCategory.items[0].category = 'relic';
  assert.throws(() => validateAuctionCatalog(badCategory), /category must be one of/);

  const dupId = clone();
  dupId.items[1].item_id = dupId.items[0].item_id;
  assert.throws(() => validateAuctionCatalog(dupId), /item_id must be unique/);

  const wrongCount = clone();
  wrongCount.items.pop();
  assert.throws(() => validateAuctionCatalog(wrongCount), /must contain exactly 52 items/);

  const badFace = clone();
  const being = badFace.items.find((item) => item.category === 'being');
  being.face_id = 'ab_099';
  assert.throws(() => validateAuctionCatalog(badFace), /face_id must match ab_NNN|must cover ab_/);

  const badBand = clone();
  badBand.items[0].band = 'Z';
  assert.throws(() => validateAuctionCatalog(badBand), /band must be one of/);

  const badEffect = clone();
  const treasure = badEffect.items.find((item) => item.category === 'treasure');
  treasure.effect = { category: 'gift', affinity_bonus: 0 };
  assert.throws(() => validateAuctionCatalog(badEffect), /affinity_bonus must be a positive integer/);
});

// ----- weekly draw -----

test('the weekly auction draw is deterministic and lot-band consistent, and locks fixed-seed values', async () => {
  const catalog = await loadCatalog();
  const roster = rosterOf(8);
  const draw = drawWeeklyAuctionLots({ week: 3, roster, soldLedger: [], previousLotItemIds: [], catalog });
  const again = drawWeeklyAuctionLots({ week: 3, roster, soldLedger: [], previousLotItemIds: [], catalog });
  assert.deepEqual(draw, again);

  // Locked fixed-seed expectations (roster character_001..008, week 3): per-lot seeded item pick, lot 1 = C〜B.
  assert.deepEqual(draw.bidders.map((bidder) => bidder.character_id), ['character_004', 'character_002', 'character_003']);
  assert.deepEqual(draw.lots.map((lot) => lot.item.item_id), ['auction_wa_01', 'auction_being_09', 'auction_item_04']);
  assert.deepEqual(draw.lots.map((lot) => lot.initial_price), [3970, 7647, 39057]);

  // Bidder count is in range; each lot's band matches its slot's band set and its price sits inside the band.
  assert.ok(draw.bidders.length >= AUCTION_MIN_BIDDERS && draw.bidders.length <= AUCTION_MAX_BIDDERS);
  const lotBands = [['C', 'B'], ['B', 'A'], ['A', 'S']];
  const seenItems = new Set();
  draw.lots.forEach((lot, index) => {
    assert.ok(lotBands[index].includes(lot.band), `lot ${index} band ${lot.band}`);
    const bandDef = catalog.price_bands[lot.band];
    assert.ok(lot.initial_price >= bandDef.price_min && lot.initial_price <= bandDef.price_max);
    assert.equal(lot.min_increment, bandDef.min_increment);
    assert.equal(Object.keys(lot.npc_budgets).length, draw.bidders.length);
    assert.ok(!seenItems.has(lot.item.item_id), 'lots are distinct items');
    seenItems.add(lot.item.item_id);
  });
});

test('the draw excludes sold one-of-a-kind items and suppresses ANY prior-week item (all categories, incl. one-of-a-kind)', async () => {
  const catalog = await loadCatalog();
  const roster = rosterOf(8);

  // The un-constrained week-3 lot 1 is the being auction_being_09; marking it sold removes it from the draw.
  const withSold = drawWeeklyAuctionLots({ week: 3, roster, soldLedger: ['auction_being_09'], previousLotItemIds: [], catalog });
  assert.ok(!withSold.lots.some((lot) => lot.item.item_id === 'auction_being_09'));

  // Prior-week suppression is now whole-catalog: the un-constrained week-3 lot 0 is the ONE-OF-A-KIND weapon
  // auction_wa_01, and listing it the prior week suppresses it (a 流札 unique gets a one-week cooldown — the old
  // behavior only suppressed re-listable treasure/flavor).
  const withPrev = drawWeeklyAuctionLots({ week: 3, roster, soldLedger: [], previousLotItemIds: ['auction_wa_01'], catalog });
  assert.ok(!withPrev.lots.some((lot) => lot.item.item_id === 'auction_wa_01'));
});

test('per-lot seeded picks give lineup variety: no adjacent-week repeat, lot 1 is not flavor-locked, broad coverage', async () => {
  const catalog = await loadCatalog();
  const roster = rosterOf(8);

  // Simulate the week-progression carry: each week suppresses the prior week's three item_ids (the session's
  // auction_previous_lots contract), the same shape drawWeeklyAuctionLots consumes.
  const WEEKS = 24;
  const lot1Categories = new Set();
  const distinctPerLot = [new Set(), new Set(), new Set()];
  let previousLotItemIds = [];
  let previousIds = null;
  let adjacentRepeats = 0;
  for (let week = 0; week < WEEKS; week += 1) {
    const draw = drawWeeklyAuctionLots({ week, roster, soldLedger: [], previousLotItemIds, catalog });
    const ids = draw.lots.map((lot) => lot.item.item_id);
    // No item repeats from the immediately prior week (whole-catalog one-week cooldown).
    if (previousIds) for (const id of ids) if (previousIds.includes(id)) adjacentRepeats += 1;
    lot1Categories.add(draw.lots[0].item.category);
    draw.lots.forEach((lot, index) => distinctPerLot[index].add(lot.item.item_id));
    previousIds = ids;
    previousLotItemIds = ids;
  }
  assert.equal(adjacentRepeats, 0, 'no item appears in two consecutive weeks');
  // Lot 1 is no longer pinned to the four flavor/C items — over 24 weeks it draws non-flavor categories too.
  assert.ok(lot1Categories.size >= 2, `lot 1 spans multiple categories: ${[...lot1Categories].join(',')}`);
  assert.ok([...lot1Categories].some((category) => category !== 'flavor'), 'lot 1 draws a non-flavor category');
  // Per-lot item coverage is broad (the FNV-min ordering funneled specific items to the head): each lot uses
  // well more than the 4-item rotation the investigation measured for the old lot 1.
  for (const distinct of distinctPerLot) assert.ok(distinct.size >= 10, `a lot covers ${distinct.size} distinct items over ${WEEKS} weeks`);
});

test('the draw fails fast when the roster cannot seat the minimum bidders', async () => {
  const catalog = await loadCatalog();
  assert.throws(
    () => drawWeeklyAuctionLots({ week: 1, roster: rosterOf(AUCTION_MIN_BIDDERS - 1), soldLedger: [], previousLotItemIds: [], catalog }),
    new RegExp(`at least ${AUCTION_MIN_BIDDERS} selectable characters`)
  );
  // A roster of exactly the minimum seats a full minimum bidder set.
  const drawn = drawWeeklyAuctionLots({ week: 1, roster: rosterOf(AUCTION_MIN_BIDDERS), soldLedger: [], previousLotItemIds: [], catalog });
  assert.equal(drawn.bidders.length, AUCTION_MIN_BIDDERS);
});

test('the seated-bidder range is pinned to 3..5, seats distinct bidders, and reaches both boundaries', async () => {
  assert.equal(AUCTION_MIN_BIDDERS, 3);
  assert.equal(AUCTION_MAX_BIDDERS, 5);

  const catalog = await loadCatalog();
  const roster = rosterOf(8);
  const seenCounts = new Set();
  for (let week = 0; week < 200; week += 1) {
    const draw = drawWeeklyAuctionLots({ week, roster, soldLedger: [], previousLotItemIds: [], catalog });
    assert.ok(
      draw.bidders.length >= AUCTION_MIN_BIDDERS && draw.bidders.length <= AUCTION_MAX_BIDDERS,
      `week ${week} seated ${draw.bidders.length} bidders`
    );
    // No character is seated twice, and every lot's non-public budget map covers exactly the seated set.
    assert.equal(new Set(draw.bidders.map((bidder) => bidder.character_id)).size, draw.bidders.length);
    for (const lot of draw.lots) assert.equal(Object.keys(lot.npc_budgets).length, draw.bidders.length);
    seenCounts.add(draw.bidders.length);
  }
  assert.ok(seenCounts.has(AUCTION_MIN_BIDDERS), 'the 3-bidder minimum boundary is reachable');
  assert.ok(seenCounts.has(AUCTION_MAX_BIDDERS), 'the 5-bidder maximum boundary is reachable');
});

test('the strict slot validator rejects a persisted bidder count outside 3..5', async () => {
  const catalog = await loadCatalog();
  const slot = buildAuctionSlot(drawWeeklyAuctionLots({ week: 11, roster: rosterOf(8), soldLedger: [], previousLotItemIds: [], catalog }));
  const bidderEntries = (count) => Array.from({ length: count }, (_, index) => ({
    character_id: `character_${String(index + 1).padStart(3, '0')}`,
    display_name: `キャラ${index + 1}`
  }));
  // bidders are validated before lots, so a count outside the range throws on the range check regardless of npc_budgets.
  assert.throws(() => validateAuctionSlot({ ...slot, bidders: bidderEntries(AUCTION_MIN_BIDDERS - 1) }), /must hold 3\.\.5 bidders/);
  assert.throws(() => validateAuctionSlot({ ...slot, bidders: bidderEntries(AUCTION_MAX_BIDDERS + 1) }), /must hold 3\.\.5 bidders/);
});

test('planStaleAuctionBidderStateRemoval removes only out-of-range auction residue and preserves everything else', async () => {
  const catalog = await loadCatalog();
  const slot = buildAuctionSlot(drawWeeklyAuctionLots({ week: 2, roster: rosterOf(8), soldLedger: [], previousLotItemIds: [], catalog }));

  // An in-range persisted slot alongside unrelated keys: nothing to clean.
  const healthy = {
    [ROUTING_AUCTION_STATE_KEY]: slot,
    [AUCTION_SOLD_LEDGER_STATE_KEY]: ['auction_being_03'],
    current_screen: 'routing-hub'
  };
  assert.deepEqual(planStaleAuctionBidderStateRemoval(healthy), { removed: [], next: null });

  // A below-range (old 2-bidder) slot is stale residue: the slot key is dropped, unrelated keys preserved.
  const staleSlot = { ...slot, bidders: slot.bidders.slice(0, 2) };
  const slotPlan = planStaleAuctionBidderStateRemoval({
    [ROUTING_AUCTION_STATE_KEY]: staleSlot,
    [AUCTION_SOLD_LEDGER_STATE_KEY]: ['auction_being_03']
  });
  assert.deepEqual(slotPlan.removed, [ROUTING_AUCTION_STATE_KEY]);
  assert.deepEqual(slotPlan.next, { [AUCTION_SOLD_LEDGER_STATE_KEY]: ['auction_being_03'] });

  // A consignment whose npc_budgets holds an out-of-range count is dropped; a skipped record (no budgets) stays.
  const staleConsignment = { week: 2, status: 'listed', npc_budgets: { character_001: 100, character_002: 200 } };
  assert.deepEqual(
    planStaleAuctionBidderStateRemoval({ [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]: staleConsignment }).removed,
    [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]
  );
  assert.deepEqual(
    planStaleAuctionBidderStateRemoval({ [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]: { week: 2, status: 'skipped' } }),
    { removed: [], next: null }
  );

  // Idempotent: an already-clean state is a no-op.
  assert.deepEqual(planStaleAuctionBidderStateRemoval({}), { removed: [], next: null });
});

// ----- slot state -----

test('the auction slot builds, records awards through to closed, and rejects malformed state', async () => {
  const catalog = await loadCatalog();
  const draw = drawWeeklyAuctionLots({ week: 5, roster: rosterOf(8), soldLedger: [], previousLotItemIds: [], catalog });
  const slot = buildAuctionSlot(draw);
  assert.equal(slot.status, 'in_progress');
  assert.equal(slot.current_lot_index, 0);
  assert.deepEqual(slot.awards, []);

  const winner = draw.bidders[0].character_id;
  const afterLot0 = recordAuctionLotAward(slot, { lotIndex: 0, outcome: 'awarded', winnerCharacterId: 'player', amount: slot.lots[0].initial_price });
  assert.equal(afterLot0.current_lot_index, 1);
  assert.equal(afterLot0.status, 'in_progress');
  const afterLot1 = recordAuctionLotAward(afterLot0, { lotIndex: 1, outcome: 'passed_in' });
  const afterLot2 = recordAuctionLotAward(afterLot1, { lotIndex: 2, outcome: 'awarded', winnerCharacterId: winner, amount: slot.lots[2].initial_price + slot.lots[2].min_increment });
  assert.equal(afterLot2.status, 'closed');
  assert.equal(afterLot2.current_lot_index, 3);
  assert.equal(afterLot2.awards.length, 3);
  assert.equal(afterLot2.awards[1].winner_character_id, null);

  // A closed auction takes no more awards; an out-of-order lot index is rejected.
  assert.throws(() => recordAuctionLotAward(afterLot2, { lotIndex: 3, outcome: 'passed_in' }), /already closed/);
  assert.throws(() => recordAuctionLotAward(afterLot0, { lotIndex: 2, outcome: 'passed_in' }), /must resolve the current lot/);

  // Malformed persisted slots fail fast.
  const statusMismatch = { ...afterLot0, status: 'closed' };
  assert.throws(() => validateAuctionSlot(statusMismatch), /does not match current_lot_index/);
  const underpaid = JSON.parse(JSON.stringify(afterLot0));
  underpaid.awards[0].amount = slot.lots[0].initial_price - 1;
  assert.throws(() => validateAuctionSlot(underpaid), /at least the lot initial price/);
});

test('the slot reader is week-scoped and the closed judgment drives 同週再訪=閉場', async () => {
  const catalog = await loadCatalog();
  const draw = drawWeeklyAuctionLots({ week: 7, roster: rosterOf(8), soldLedger: [], previousLotItemIds: [], catalog });
  let slot = buildAuctionSlot(draw);
  slot = recordAuctionLotAward(slot, { lotIndex: 0, outcome: 'passed_in' });
  slot = recordAuctionLotAward(slot, { lotIndex: 1, outcome: 'passed_in' });
  slot = recordAuctionLotAward(slot, { lotIndex: 2, outcome: 'passed_in' });
  const state = { [ROUTING_AUCTION_STATE_KEY]: slot };
  assert.deepEqual(readAuctionSlot(state), slot);
  assert.equal(readAuctionSlotForWeek(state, 7)?.status, 'closed');
  assert.equal(readAuctionSlotForWeek(state, 8), null); // stale earlier week reads as not held this week
  assert.equal(isAuctionClosedForWeek(state, 7), true);
  assert.equal(isAuctionClosedForWeek(state, 8), false);
  assert.equal(readAuctionSlot({}), null); // 不在=未開催
});

test('the sold ledger records only one-of-a-kind awards, idempotently', async () => {
  const catalog = await loadCatalog();
  assert.deepEqual(readAuctionSoldLedger({}), []);
  const afterBeing = nextAuctionSoldLedger({ ledger: [], catalog, itemId: 'auction_being_03' });
  assert.deepEqual(afterBeing, ['auction_being_03']);
  // A re-listable treasure is never recorded; a duplicate append is a no-op.
  assert.deepEqual(nextAuctionSoldLedger({ ledger: afterBeing, catalog, itemId: 'auction_item_02' }), afterBeing);
  assert.deepEqual(nextAuctionSoldLedger({ ledger: afterBeing, catalog, itemId: 'auction_being_03' }), afterBeing);
  const afterWeapon = nextAuctionSoldLedger({ ledger: afterBeing, catalog, itemId: 'auction_wa_03' });
  assert.deepEqual(afterWeapon, ['auction_being_03', 'auction_wa_03']);
  assert.throws(() => readAuctionSoldLedger({ [AUCTION_SOLD_LEDGER_STATE_KEY]: ['auction_being_03', 'auction_being_03'] }), /duplicate entry/);
});

// ----- pure derivations -----

test('being parameters are deterministic and band-scaled', async () => {
  const s = generateAuctionBeingParameters({ band: 'S', itemId: 'auction_being_01' });
  const sAgain = generateAuctionBeingParameters({ band: 'S', itemId: 'auction_being_01' });
  assert.deepEqual(s, sAgain);
  assert.equal(s.magic.light.value, 73);
  assert.equal(s.abilities.strength.value, 90);
  // Every rolled value sits inside the S band range [60, 90].
  for (const group of ['magic', 'abilities']) {
    for (const key of Object.keys(s[group])) {
      assert.ok(s[group][key].value >= 60 && s[group][key].value <= 90, `${group}.${key}=${s[group][key].value}`);
    }
  }
  const b = generateAuctionBeingParameters({ band: 'B', itemId: 'auction_being_13' });
  for (const key of Object.keys(b.magic)) assert.ok(b.magic[key].value >= 30 && b.magic[key].value <= 60);
  assert.throws(() => generateAuctionBeingParameters({ band: 'C', itemId: 'auction_being_01' }), /parameter range/);
});

test('weapon/amulet equipment derivation is deterministic, valid, and graded by band', async () => {
  const catalog = await loadCatalog();
  const sword = auctionCatalogItem(catalog, 'auction_wa_03'); // 銘匠の剣, band S
  const instance = deriveAuctionEquipmentInstance({ item: sword, week: 3, name: '銘', flavor: '来歴' });
  assert.deepEqual(instance, deriveAuctionEquipmentInstance({ item: sword, week: 3, name: '銘', flavor: '来歴' }));
  validateEquipmentInstance(instance);
  assert.equal(instance.kind, 'weapon');
  assert.equal(instance.weapon_type, 'sword');
  assert.equal(instance.tier, 4);
  assert.equal(instance.quality, 'masterwork'); // S格=傑作
  assert.equal(instance.name, '銘');
  assert.equal(instance.instance_id, 'auction_equip_auction_wa_03_w3');

  const businessSword = auctionCatalogItem(catalog, 'auction_wa_01'); // 業物の剣, band B
  const bInstance = deriveAuctionEquipmentInstance({ item: businessSword, week: 3, name: '銘', flavor: '来歴' });
  assert.equal(bInstance.tier, 3);
  assert.equal(bInstance.quality, 'excellent'); // B格=優

  const amulet = auctionCatalogItem(catalog, 'auction_wa_11'); // 逸品の護符, band A
  const aInstance = deriveAuctionEquipmentInstance({ item: amulet, week: 3, name: '銘', flavor: '来歴' });
  assert.equal(aInstance.kind, 'amulet');
  assert.equal(aInstance.quality, 'masterwork');
  assert.ok(!('element_spell_power' in aInstance.bonus_effects)); // weapon-only effect never lands on an amulet
});

// ----- inventory item definitions -----

test('treasure and flavor items become known inventory definitions', async () => {
  const items = await loadAuctionInventoryItems({ root: projectRoot });
  assert.equal(items.length, 25); // 10 treasure + 15 flavor
  const byId = new Map(items.map((item) => [item.item_id, item]));
  assert.equal(byId.get('auction_item_01').name, '星降りの夜の蒸留酒');
  assert.equal(byId.get('auction_flavor_02').name, '欠けた星の欠片');
  assert.equal(byId.get('auction_flavor_02').description, '役目を終えた星の残光が閉じた石。手のひらでほんのり温かい');
  for (const item of items) assert.equal(item.sell_price, 0);
  // No one-of-a-kind (weapon/being) item leaks into the inventory definition set.
  assert.ok(!items.some((item) => item.item_id.startsWith('auction_wa_') || item.item_id.startsWith('auction_being_')));
});

// ----- ownership writers (split-layout root) -----

async function splitAuctionRoot({ money = 60000, activeHomunculi = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-'));
  const write = (relativePath, value) => fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true })
    .then(() => fs.writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8'));
  await write('data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await write('data/definitions/game_data/shop_catalog.json', { shop_name: '学院購買部', items: [] });
  await write('data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await write('data/definitions/game_data/stage_flags.json', { flags: [] });
  await write('data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '設定', world_condition_texts: []
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await write('data/seeds/game_data/player_inventory.json', { money, items: [] });
  await write('data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: 4, global_flags: {}, characters: {} });
  if (activeHomunculi.length > 0) {
    await write('data/mutable/game_data/homunculi.json', { version: 1, active: activeHomunculi, nameplates: [] });
  }
  return root;
}

// Reads the effective inventory: the mutable copy once a transaction has written it, else the seed copy (the
// pre-transaction source of truth a fail-fast leaves untouched).
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

test('the equipment writer debits the bid and appends the instance atomically', async (t) => {
  const root = await splitAuctionRoot({ money: 60000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const item = auctionCatalogItem(catalog, 'auction_wa_02');
  const result = await awardAuctionEquipmentToPlayer({ root, item, week: 4, price: 9000, name: '暁の一振り', flavor: '来歴の触れ込み' });
  assert.equal(result.instance.kind, 'weapon');
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1);
  assert.equal(surface.instances[0].name, '暁の一振り');
  assert.equal((await readMutableInventory(root)).money, 51000);
});

test('the equipment writer consumes nothing when the player cannot afford the bid', async (t) => {
  const root = await splitAuctionRoot({ money: 500 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const item = auctionCatalogItem(catalog, 'auction_wa_02');
  await assert.rejects(awardAuctionEquipmentToPlayer({ root, item, week: 4, price: 9000, name: '銘', flavor: '来歴' }), /insufficient_money/);
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 0);
});

test('the treasure/flavor writer grants the item and it is a decorated known inventory item', async (t) => {
  const root = await splitAuctionRoot({ money: 20000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const result = await awardAuctionItemToPlayer({ root, catalog, itemId: 'auction_item_05', price: 6000 });
  assert.equal(result.item_id, 'auction_item_05');
  assert.equal((await readMutableInventory(root)).money, 14000);
  const inventory = await loadInventory({ root });
  const owned = inventory.items.find((entry) => entry.item_id === 'auction_item_05');
  assert.ok(owned);
  assert.equal(owned.name, '星海の霊墨');
  assert.equal(owned.quantity, 1);
});

test('the being writer consumes an atelier slot, seeds the actor profile with species/origin, and debits the bid', async (t) => {
  const root = await splitAuctionRoot({ money: 40000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const result = await awardAuctionBeingToPlayer({
    root, catalog, itemId: 'auction_being_06', price: 22000,
    promptDescription: '光の匂いの話をする穏やかな精霊。', speakingBasis: '柔らかく面倒見のよい口調。'
  });
  assert.match(result.being.homunculus_id, /^homunculus_\d{3}$/);
  assert.equal(result.being.face_id, 'ab_006');
  assert.equal(result.being.species, 'spirit');
  assert.equal((await readMutableInventory(root)).money, 18000);

  const surface = await loadHomunculiSurface({ root });
  assert.equal(surface.active.length, 1);
  assert.equal(surface.active[0].face_id, 'ab_006');

  const profile = JSON.parse(await fs.readFile(path.join(root, `data/mutable/game_data/homunculi/${result.being.homunculus_id}/profile.json`), 'utf8'));
  assert.equal(profile.species, 'spirit');
  assert.equal(profile.origin, 'auction');
  assert.equal(profile.element, 'light');
  assert.equal(profile.prompt_description, '光の匂いの話をする穏やかな精霊。');
  assert.equal(profile.visual_set_id, 'ab_006');
  assert.ok(profile.parameters.magic.light.value >= 60);

  // The auction being's ab_* face lives on the surface but never occupies an atelier hp lane.
  assert.ok(isAuctionFaceId(surface.active[0].face_id));
  assert.equal(availableFaceLanes(surface).length, 50);
});

test('the being writer fails fast on a full roster and consumes nothing', async (t) => {
  const activeHomunculi = [1, 2, 3].map((n) => ({
    homunculus_id: `homunculus_00${n}`, display_name: `子${n}`, face_id: `hp_00${n}`, created_week: 1
  }));
  const root = await splitAuctionRoot({ money: 40000, activeHomunculi });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const surfaceBefore = await loadHomunculiSurface({ root });
  assert.equal(canAdoptAuctionBeing(surfaceBefore), false);
  await assert.rejects(
    awardAuctionBeingToPlayer({ root, catalog, itemId: 'auction_being_06', price: 22000, promptDescription: '説明', speakingBasis: '口調' }),
    /already holds the maximum/i
  );
  assert.equal((await readMutableInventory(root)).money, 40000);
  const surfaceAfter = await loadHomunculiSurface({ root });
  assert.equal(surfaceAfter.active.length, 3);
});
