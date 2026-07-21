import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { projectRoot } from './testPaths.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { writeStarCradleCatalogDefinitionSplit } from './starCradleFixture.mjs';
import {
  ROUTING_AUCTION_STATE_KEY,
  AUCTION_SOLD_LEDGER_STATE_KEY,
  AUCTION_CAGED_CREATURE_BANDS,
  AUCTION_CREATURE_LOT_CHANCE,
  loadAuctionCatalog,
  auctionCatalogItem,
  auctionCagedCreatureBand,
  auctionCreatureLotForWeek,
  buildAuctionCreatureLot,
  buildAuctionSlot,
  validateAuctionSlot,
  buildConsignmentLot,
  bandForConsignmentValue,
  readAuctionSoldLedger,
  readAuctionSlotForWeek
} from '../src/routingAuction.mjs';
import { auctionLotPresentation } from '../src/llm/auctionGeneration.mjs';
import { buildAuctionContentResult } from '../src/routingContentResult.mjs';
import { awardAuctionCagedCreatureToPlayer, payoutConsignmentToPlayer } from '../src/auctionAward.mjs';
import {
  listConsignableItems,
  submitConsignment,
  resolveConsignmentLot,
  resolveAuctionLot,
  enterAuction
} from '../src/routingAuctionSession.mjs';
import { loadStarCradleCatalog } from '../src/starCradleCatalog.mjs';
import { loadStarCradleCreaturesSurface } from '../src/starCradleSurface.mjs';
import { resolveCreatureIdentity } from '../src/starCradle.mjs';
import { loadInventory } from '../src/economy.mjs';

const RUNTIME_STATE_MUTABLE = 'data/mutable/game_data/runtime_state.json';
const CAGED_MUTABLE = 'data/mutable/game_data/star_cradle_creatures.json';
const WEEK = 4;
const CREATURE_WEEK = 10; // auctionCreatureLotForWeek(10) === true (locked below)
const BIDDERS = [
  { character_id: 'character_001', display_name: 'キャラ1' },
  { character_id: 'character_002', display_name: 'キャラ2' },
  { character_id: 'character_003', display_name: 'キャラ3' }
];
const BUDGETS = { character_001: 50000, character_002: 50000, character_003: 50000 };
const LM_CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'm', reflection_model: 'm', timeout_ms: 5000, stream: false };

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

async function readCagedSurface(root) {
  return loadStarCradleCreaturesSurface({ root });
}

// A split-layout root carrying the auction + star cradle catalogs, inventory, runtime_state, and optional caged
// creatures on the star cradle cage surface.
async function connectionRoot({ money = 60000, cagedInstances = [], week = WEEK } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-cradle-'));
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
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money, items: [] });
  await writeJson(root, RUNTIME_STATE_MUTABLE, { version: 1, elapsed_weeks: week, global_flags: {}, characters: {} });
  if (cagedInstances.length > 0) await writeJson(root, CAGED_MUTABLE, { version: 1, instances: cagedInstances });
  return root;
}

// Builds a 3-lot house slot (current_lot_index 0) so the consignment window is open with seated bidders.
async function seedSlot(root, { lots = null } = {}) {
  const catalog = await loadAuctionCatalog({ root });
  const builtLots = lots ?? ['auction_item_05', 'auction_wa_02', 'auction_being_11'].map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index, item, band: item.band, initial_price: [6000, 9000, 8000][index], min_increment: 300, npc_budgets: { ...BUDGETS } };
  });
  const state = await readState(root);
  const slot = buildAuctionSlot({ week: state.elapsed_weeks, bidders: BIDDERS, lots: builtLots });
  await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, [ROUTING_AUCTION_STATE_KEY]: slot });
  return slot;
}

// A caged instance whose identity (variety/変貌) is derived from a chosen seed. Returns { instance, identity, band }.
async function cagedInstanceForSeed(root, { itemId = 'star_cradle_madara_egg', seed, name = null, feed = {} }) {
  const starCradleCatalog = await loadStarCradleCatalog({ root });
  const instance = { instance_id: `sc_creature_${seed}`, item_id: itemId, seed, feed, name, caged_week: 1 };
  const { variety, mutation } = resolveCreatureIdentity(starCradleCatalog, instance);
  return { instance, identity: { variety, mutation }, band: auctionCagedCreatureBand({ variety, mutation }) };
}

// ===== domain: band rule =====

test('auctionCagedCreatureBand: common non-mutated is C; rare OR 変貌 is B', () => {
  assert.equal(auctionCagedCreatureBand({ variety: { rarity: 'common' }, mutation: null }), 'C');
  assert.equal(auctionCagedCreatureBand({ variety: { rarity: 'rare' }, mutation: null }), 'B');
  assert.equal(auctionCagedCreatureBand({ variety: { rarity: 'common' }, mutation: { id: 'c06m', name: '月影の大猫' } }), 'B');
  assert.equal(auctionCagedCreatureBand({ variety: { rarity: 'rare' }, mutation: { id: 'c04m', name: '九尾の露狐' } }), 'B');
  assert.deepEqual([...AUCTION_CAGED_CREATURE_BANDS], ['C', 'B']);
});

// ===== domain: weekly creature-lot draw (落札側) =====

test('auctionCreatureLotForWeek is week-seed deterministic and reflects AUCTION_CREATURE_LOT_CHANCE across weeks', () => {
  assert.equal(AUCTION_CREATURE_LOT_CHANCE, 0.25);
  for (const week of [0, 4, 10]) assert.equal(auctionCreatureLotForWeek(week), auctionCreatureLotForWeek(week));
  assert.equal(auctionCreatureLotForWeek(CREATURE_WEEK), true, 'week 10 draws a creature lot (locked seed)');
  assert.equal(auctionCreatureLotForWeek(WEEK), false, 'week 4 does not (locked seed)');
  const hits = [];
  for (let week = 0; week < 200; week += 1) if (auctionCreatureLotForWeek(week)) hits.push(week);
  assert.ok(hits.length > 20 && hits.length < 80, `~25% of weeks draw a creature lot: ${hits.length}/200`);
});

test('buildAuctionCreatureLot builds a deterministic caged_creature lot that validates through the slot schema', async (t) => {
  const root = await connectionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const starCradleCatalog = await loadStarCradleCatalog({ root });

  const lot = buildAuctionCreatureLot({ week: CREATURE_WEEK, bidders: BIDDERS, catalog, starCradleCatalog });
  const again = buildAuctionCreatureLot({ week: CREATURE_WEEK, bidders: BIDDERS, catalog, starCradleCatalog });
  assert.deepEqual(lot, again); // deterministic in (week, bidders, catalog, starCradleCatalog)

  assert.equal(lot.lot_index, 0);
  assert.equal(lot.item.category, 'caged_creature');
  assert.deepEqual(Object.keys(lot.item).sort(), ['band', 'blurb', 'category', 'item_id', 'name', 'seed']);
  assert.ok(starCradleCatalog.seedItemsById.get(lot.item.item_id)?.kind === 'creature', 'item_id is a creature 種卵');
  assert.ok(AUCTION_CAGED_CREATURE_BANDS.includes(lot.item.band));
  assert.equal(lot.band, lot.item.band);
  assert.match(lot.item.name, /^籠入りの/);
  assert.ok(Number.isInteger(lot.item.seed) && lot.item.seed > 0);

  // The lot's band matches C-28's derived identity for the same (item_id, seed).
  const { variety, mutation } = resolveCreatureIdentity(starCradleCatalog, { item_id: lot.item.item_id, seed: lot.item.seed, feed: {} });
  assert.equal(lot.band, auctionCagedCreatureBand({ variety, mutation }));

  const bandDef = catalog.price_bands[lot.band];
  assert.ok(lot.initial_price >= bandDef.price_min && lot.initial_price <= bandDef.price_max);
  assert.equal(lot.min_increment, bandDef.min_increment);
  assert.deepEqual(Object.keys(lot.npc_budgets).sort(), ['character_001', 'character_002', 'character_003']);

  // The caged_creature lot is a valid slot lot alongside catalog lots.
  const catalogLots = ['auction_wa_02', 'auction_being_11'].map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index + 1, item, band: item.band, initial_price: 9000, min_increment: 300, npc_budgets: { ...BUDGETS } };
  });
  const slot = buildAuctionSlot({ week: CREATURE_WEEK, bidders: BIDDERS, lots: [lot, ...catalogLots] });
  assert.equal(slot.lots[0].item.category, 'caged_creature');
});

test('the slot schema fail-fasts on a malformed caged_creature lot item', async (t) => {
  const root = await connectionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const starCradleCatalog = await loadStarCradleCatalog({ root });
  const lot = buildAuctionCreatureLot({ week: CREATURE_WEEK, bidders: BIDDERS, catalog, starCradleCatalog });
  const other = ['auction_wa_02', 'auction_being_11'].map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index + 1, item, band: item.band, initial_price: 9000, min_increment: 300, npc_budgets: { ...BUDGETS } };
  });
  const build = (mutateItem) => () => validateAuctionSlot({
    week: CREATURE_WEEK, bidders: BIDDERS, status: 'in_progress', current_lot_index: 0, awards: [],
    lots: [{ ...lot, item: mutateItem({ ...lot.item }), band: mutateItem({ ...lot.item }).band ?? lot.band }, ...other]
  });
  // missing key
  assert.throws(() => validateAuctionSlot({
    week: CREATURE_WEEK, bidders: BIDDERS, status: 'in_progress', current_lot_index: 0, awards: [],
    lots: [{ ...lot, item: { category: 'caged_creature', item_id: lot.item.item_id, seed: lot.item.seed, band: lot.band, name: lot.item.name } }, ...other]
  }), /missing required key: blurb/);
  // A/S band is not a caged-creature band
  assert.throws(build((item) => ({ ...item, band: 'A' })), /caged creature lot band must be one of/);
  // non-positive seed
  assert.throws(build((item) => ({ ...item, seed: 0 })), /seed must be a positive integer/);
});

// ===== presentation =====

test('auctionLotPresentation surfaces a caged_creature lot under the fixed 分類 label', () => {
  const presentation = auctionLotPresentation({ category: 'caged_creature', item_id: 'star_cradle_madara_egg', seed: 5, band: 'C', name: '籠入りの星兎', blurb: '跳ねると星屑が散る。' });
  assert.deepEqual(presentation, { name: '籠入りの星兎', category_label: '籠入りの生き物', blurb: '跳ねると星屑が散る。' });
  assert.throws(() => auctionLotPresentation({ category: 'caged_creature', name: 'x', blurb: '' }), /caged_creature.blurb is required/);
});

// ===== content result =====

test('buildAuctionContentResult accepts a caged_creature lot category', () => {
  const record = buildAuctionContentResult({
    week: CREATURE_WEEK,
    now: '2026-07-11T00:00:00.000Z',
    lots: [
      { item_name: '籠入りの星兎', category: 'caged_creature', band: 'C', result: 'won_by_player', price: 900, winner_display_name: null },
      { item_name: '刃', category: 'weapon_amulet', band: 'B', result: 'passed_in', price: null, winner_display_name: null },
      { item_name: '子', category: 'being', band: 'A', result: 'won_by_other', price: 12000, winner_display_name: 'キャラ2' }
    ]
  });
  assert.equal(record.detail.lots[0].category, 'caged_creature');
  assert.equal(record.detail.lots[0].result, 'won_by_player');
});

// ===== award writer (落札側): caged creature → 籠入りへ append =====

test('awardAuctionCagedCreatureToPlayer debits money and appends a nameless caged instance atomically', async (t) => {
  const root = await connectionRoot({ money: 5000, week: CREATURE_WEEK });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = { category: 'caged_creature', item_id: 'star_cradle_madara_egg', seed: 777, band: 'C', name: '籠入りの星兎', blurb: 'flavor' };

  const result = await awardAuctionCagedCreatureToPlayer({ root, item, week: CREATURE_WEEK, price: 900 });
  assert.equal(result.price, 900);
  assert.equal((await readMutableInventory(root)).money, 4100);
  const caged = await readCagedSurface(root);
  assert.equal(caged.instances.length, 1);
  assert.deepEqual(caged.instances[0], { instance_id: 'sc_creature_777', item_id: 'star_cradle_madara_egg', seed: 777, feed: {}, name: null, caged_week: CREATURE_WEEK });

  // insufficient money → no append, money untouched
  const poor = await connectionRoot({ money: 100, week: CREATURE_WEEK });
  t.after(() => fs.rm(poor, { recursive: true, force: true }));
  await assert.rejects(awardAuctionCagedCreatureToPlayer({ root: poor, item, week: CREATURE_WEEK, price: 900 }), /insufficient_money/);
  assert.equal((await readCagedSurface(poor)).instances.length, 0);
  assert.equal((await readMutableInventory(poor)).money, 100);
});

// ===== payout writer (出品側): caged creature leaves the cage surface for the winning bid =====

test('payoutConsignmentToPlayer (star_cradle_creature) removes the caged instance and credits the bid; unknown rejects before any write', async (t) => {
  const { instance } = await cagedInstanceForSeed(await connectionRoot(), { seed: 4242 });
  const root = await connectionRoot({ money: 1000, cagedInstances: [instance] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const payout = await payoutConsignmentToPlayer({ root, source: { kind: 'star_cradle_creature', instance_id: instance.instance_id }, amount: 700 });
  assert.equal(payout.amount, 700);
  assert.equal((await readMutableInventory(root)).money, 1700);
  assert.equal((await readCagedSurface(root)).instances.length, 0);

  // unknown caged instance → rejected, nothing written
  const root2 = await connectionRoot({ money: 1000, cagedInstances: [instance] });
  t.after(() => fs.rm(root2, { recursive: true, force: true }));
  await assert.rejects(payoutConsignmentToPlayer({ root: root2, source: { kind: 'star_cradle_creature', instance_id: 'sc_creature_999' }, amount: 700 }), /unknown_star_cradle_creature/);
  assert.equal((await readMutableInventory(root2)).money, 1000);
  assert.equal((await readCagedSurface(root2)).instances.length, 1);
});

// ===== consignment session (出品側): options / submit / resolve =====

test('listConsignableItems includes caged creatures with the rarity/変貌 band and that band floor as the anchor', async (t) => {
  const seed = 20260711;
  const built = await cagedInstanceForSeed(await connectionRoot(), { seed, name: 'ほしの子' });
  const root = await connectionRoot({ cagedInstances: [built.instance] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });

  const options = await listConsignableItems({ root });
  assert.equal(options.week, WEEK);
  assert.ok(Array.isArray(options.caged));
  const entry = options.caged.find((candidate) => candidate.instance_id === built.instance.instance_id);
  assert.ok(entry, 'the caged creature is listed');
  assert.equal(entry.kind, 'star_cradle_creature');
  assert.equal(entry.category_label, '籠入りの生き物');
  assert.match(entry.name, /^籠入りの/);
  assert.match(entry.name, /「ほしの子」$/); // the individual name is appended
  assert.equal(entry.band, built.band);
  assert.equal(entry.value_anchor, catalog.price_bands[built.band].price_min);
});

test('submit + resolve a caged consignment: NPC award credits the bid and removes the instance; 流札 keeps it', async (t) => {
  const built = await cagedInstanceForSeed(await connectionRoot(), { seed: 555111 });
  const root = await connectionRoot({ money: 2000, cagedInstances: [built.instance] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);

  const view = await submitConsignment({ root, authoringRoot: root, source: { kind: 'star_cradle_creature', instance_id: built.instance.instance_id } });
  assert.equal(view.status, 'listed');
  assert.equal(view.band, built.band); // rarity/変貌 band, not bandForConsignmentValue of the floor
  assert.equal(view.source.kind, 'star_cradle_creature');
  assert.equal(view.npc_budgets, undefined);

  const winPrice = view.initial_price + view.min_increment;
  const result = await resolveConsignmentLot({ root, authoringRoot: root, winner: 'character_002', amount: winPrice });
  assert.equal(result.resolution.outcome, 'awarded');
  assert.equal(result.payout.amount, winPrice);
  assert.equal((await readMutableInventory(root)).money, 2000 + winPrice);
  assert.equal((await readCagedSurface(root)).instances.length, 0); // instance handed over

  // 流札 on a fresh listing leaves the instance with the player
  const built2 = await cagedInstanceForSeed(await connectionRoot(), { seed: 666222 });
  const root2 = await connectionRoot({ money: 2000, cagedInstances: [built2.instance] });
  t.after(() => fs.rm(root2, { recursive: true, force: true }));
  await seedSlot(root2);
  await submitConsignment({ root: root2, authoringRoot: root2, source: { kind: 'star_cradle_creature', instance_id: built2.instance.instance_id } });
  const flop = await resolveConsignmentLot({ root: root2, authoringRoot: root2, winner: null, amount: null });
  assert.equal(flop.resolution.outcome, 'passed_in');
  assert.equal(flop.payout, null);
  assert.equal((await readMutableInventory(root2)).money, 2000);
  assert.equal((await readCagedSurface(root2)).instances.length, 1);
});

test('submitConsignment rejects an unknown caged instance before persisting anything', async (t) => {
  const root = await connectionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  await assert.rejects(
    submitConsignment({ root, authoringRoot: root, source: { kind: 'star_cradle_creature', instance_id: 'sc_creature_1' } }),
    (error) => error.statusCode === 404 && error.errorCode === 'AUCTION_CONSIGNMENT_UNKNOWN_ASSET'
  );
});

// ===== house lot integration (落札側): enter builds a caged lot; player win → 籠入りへ; NPC/流札 untouched =====

test('enterAuction on a creature week overlays a caged_creature house lot 0 (deterministic)', async (t) => {
  const root = await connectionRoot({ week: CREATURE_WEEK });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entered = await enterAuction({ root, authoringRoot: projectRoot, postContentScreen: 'academy-map' });
  assert.equal(entered.lots[0].category, 'caged_creature');
  assert.equal(entered.lots[0].category_label, '籠入りの生き物');
  assert.ok(AUCTION_CAGED_CREATURE_BANDS.includes(entered.lots[0].band));
  // lots 2/3 remain catalog categories
  for (const lot of entered.lots.slice(1)) assert.notEqual(lot.category, 'caged_creature');
});

test('a player win of a caged_creature house lot lands the instance in 籠入り with no sold-ledger / prior-week entry; NPC win leaves the cage surface untouched', async (t) => {
  const root = await connectionRoot({ money: 100000, week: CREATURE_WEEK });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const starCradleCatalog = await loadStarCradleCatalog({ root });
  const cagedLot = buildAuctionCreatureLot({ week: CREATURE_WEEK, bidders: BIDDERS, catalog, starCradleCatalog });
  const catalogLots = ['auction_wa_02', 'auction_being_11'].map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index + 1, item, band: item.band, initial_price: 9000, min_increment: 300, npc_budgets: { ...BUDGETS } };
  });
  await seedSlot(root, { lots: [cagedLot, ...catalogLots] });

  const price = cagedLot.initial_price;
  const result = await resolveAuctionLot({ root, authoringRoot: projectRoot, config: LM_CONFIG, fetchImpl: async () => { throw new Error('LM must not be called for a caged award'); }, lotIndex: 0, winner: 'player', amount: price, postContentScreen: 'academy-map' });
  assert.equal(result.resolution.outcome, 'awarded');
  const caged = await readCagedSurface(root);
  assert.equal(caged.instances.length, 1);
  assert.equal(caged.instances[0].instance_id, `sc_creature_${cagedLot.item.seed}`);
  assert.equal(caged.instances[0].name, null);
  assert.deepEqual(caged.instances[0].feed, {});
  // one-of-a-kind sold ledger is NOT touched by a caged lot
  assert.deepEqual(readAuctionSoldLedger(await readState(root)), []);

  // NPC win of a (fresh) caged lot leaves the player's cage surface + money untouched
  const root2 = await connectionRoot({ money: 100000, week: CREATURE_WEEK });
  t.after(() => fs.rm(root2, { recursive: true, force: true }));
  await seedSlot(root2, { lots: [cagedLot, ...catalogLots] });
  const npc = await resolveAuctionLot({ root: root2, authoringRoot: projectRoot, config: LM_CONFIG, fetchImpl: async () => { throw new Error('LM must not be called'); }, lotIndex: 0, winner: 'character_001', amount: cagedLot.initial_price, postContentScreen: 'academy-map' });
  assert.equal(npc.resolution.winner_character_id, 'character_001');
  assert.equal((await readCagedSurface(root2)).instances.length, 0);
  assert.equal((await readMutableInventory(root2)).money, 100000);
});
