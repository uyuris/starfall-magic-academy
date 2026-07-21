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
  loadAuctionCatalog,
  auctionCatalogItem,
  buildAuctionSlot,
  readAuctionSlotForWeek,
  readAuctionSoldLedger,
  ROUTING_AUCTION_STATE_KEY
} from '../src/routingAuction.mjs';
import {
  getAuctionState,
  enterAuction,
  resolveAuctionLot,
  resolveNpcBidTurn,
  streamMasterOpening,
  applyPlayerBid,
  applyPlayerPass
} from '../src/routingAuctionSession.mjs';
import { readRoutingContentResult } from '../src/routingContentResult.mjs';
import { loadInventory } from '../src/economy.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { loadHomunculiSurface } from '../src/homunculusSurface.mjs';

const RUNTIME_STATE_MUTABLE = 'data/mutable/game_data/runtime_state.json';
const WEEK = 4;
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

async function auctionSessionRoot({ money = 60000, activeHomunculi = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-session-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '設定', world_condition_texts: []
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money, items: [] });
  await writeJson(root, RUNTIME_STATE_MUTABLE, { version: 1, elapsed_weeks: WEEK, global_flags: {}, characters: {} });
  if (activeHomunculi.length > 0) await writeJson(root, 'data/mutable/game_data/homunculi.json', { version: 1, active: activeHomunculi, nameplates: [] });
  return root;
}

// Builds a 3-lot slot from real catalog items and writes it into runtime_state, so a resolve test drives lot
// award without the deterministic draw picking the items.
async function seedSlot(root, itemIds, { initialPrices = [6000, 9000, 8000], increments = [300, 300, 300] } = {}) {
  const catalog = await loadAuctionCatalog({ root });
  const lots = itemIds.map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index, item, band: item.band, initial_price: initialPrices[index], min_increment: increments[index], npc_budgets: { ...BUDGETS } };
  });
  const slot = buildAuctionSlot({ week: WEEK, bidders: BIDDERS, lots });
  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, [ROUTING_AUCTION_STATE_KEY]: slot });
  return slot;
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

async function currentSlot(root) {
  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  return readAuctionSlotForWeek(state, WEEK);
}

// A fetch that answers by response_format schema name (structured naming / bid) or as a chat completion (being
// persona). Records every request body.
function mockLlmFetch({ nameFlavor = { name: '暁の一振り', flavor: '来歴の触れ込み' }, persona = '紹介文: 礼儀正しい人物。\n話し方: 丁寧で穏やか。', bid = { utterance: '積む', action: 'bid', amount: 0 } } = {}, calls = []) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const schemaName = body.response_format?.json_schema?.name;
    let content;
    if (schemaName === 'auction_equipment_naming') content = JSON.stringify(nameFlavor);
    else if (schemaName === 'auction_bid_turn') content = JSON.stringify(bid);
    else content = persona;
    return {
      ok: true,
      headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
}

// ----- state view -----

test('getAuctionState is selection before a slot is built and in_progress once one exists', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await getAuctionState({ root, authoringRoot: root }), { phase: 'selection', week: WEEK });

  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  const view = await getAuctionState({ root, authoringRoot: root });
  assert.equal(view.phase, 'in_progress');
  assert.equal(view.current_lot_index, 0);
  assert.equal(view.awards.length, 0);
  assert.equal(view.bidders.length, 3);
  // The public lot view never leaks the non-public npc budgets.
  for (const lot of view.lots) assert.equal(lot.npc_budgets, undefined);
  // A being lot carries the adoptable flag (empty atelier roster → adoptable).
  const beingLot = view.lots.find((lot) => lot.category === 'being');
  assert.equal(beingLot.adoptable, true);
});

// ----- player bid validation -----

test('applyPlayerBid raises to current + add, and rejects below-increment and over-money bids with an explicit 400', async (t) => {
  const root = await auctionSessionRoot({ money: 10000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11'], { initialPrices: [6000, 9000, 8000] });

  const raised = await applyPlayerBid({ root, lotIndex: 0, current: 6000, addAmount: 300 });
  assert.equal(raised.current, 6300);
  assert.equal(raised.highest_bidder, 'player');

  await assert.rejects(applyPlayerBid({ root, lotIndex: 0, current: 6000, addAmount: 100 }),
    (error) => error.statusCode === 400 && error.errorCode === 'AUCTION_BELOW_MIN_INCREMENT');
  await assert.rejects(applyPlayerBid({ root, lotIndex: 0, current: 6000, addAmount: 9000 }),
    (error) => error.statusCode === 400 && error.errorCode === 'AUCTION_INSUFFICIENT_MONEY');

  const passed = await applyPlayerPass({ root, lotIndex: 0 });
  assert.deepEqual(passed, { lot_index: 0, player_active: false });
});

// ----- lot resolution: player wins -----

test('resolving a treasure lot to the player debits the bid, grants the item, advances the slot, and leaves a re-listable item off the sold ledger', async (t) => {
  const root = await auctionSessionRoot({ money: 20000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);

  const result = await resolveAuctionLot({ root, authoringRoot: root, config: LM_CONFIG, fetchImpl: mockLlmFetch(), lotIndex: 0, winner: 'player', amount: 6000 });
  assert.equal(result.resolution.outcome, 'awarded');
  assert.equal(result.resolution.closed, false);
  assert.equal((await readMutableInventory(root)).money, 14000);
  const inventory = await loadInventory({ root });
  assert.ok(inventory.items.find((entry) => entry.item_id === 'auction_item_05'));
  const slot = await currentSlot(root);
  assert.equal(slot.current_lot_index, 1);
  // treasure is re-listable → NOT recorded on the sold ledger.
  assert.deepEqual(readAuctionSoldLedger({ auction_sold_ledger: (JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8')).auction_sold_ledger) ?? [] }), []);
});

test('a weapon lot won by the player runs LLM naming, appends the instance, debits the bid, and adds the one-of-a-kind to the sold ledger', async (t) => {
  const root = await auctionSessionRoot({ money: 60000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_wa_02', 'auction_item_05', 'auction_being_11']);

  const calls = [];
  const result = await resolveAuctionLot({ root, authoringRoot: root, config: LM_CONFIG, fetchImpl: mockLlmFetch({}, calls), lotIndex: 0, winner: 'player', amount: 9000 });
  assert.equal(result.resolution.outcome, 'awarded');
  assert.ok(calls.some((body) => body.response_format?.json_schema?.name === 'auction_equipment_naming'));
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1);
  assert.equal(surface.instances[0].name, '暁の一振り');
  assert.equal((await readMutableInventory(root)).money, 51000);
  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  assert.deepEqual(state.auction_sold_ledger, ['auction_wa_02']);
});

test('a being lot won by the player runs LLM persona and mints a homunculus on the shared roster', async (t) => {
  const root = await auctionSessionRoot({ money: 40000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_being_11', 'auction_item_05', 'auction_wa_02']);

  const result = await resolveAuctionLot({ root, authoringRoot: root, config: LM_CONFIG, fetchImpl: mockLlmFetch(), lotIndex: 0, winner: 'player', amount: 8000 });
  assert.equal(result.resolution.outcome, 'awarded');
  const surface = await loadHomunculiSurface({ root });
  assert.equal(surface.active.length, 1);
  assert.equal(surface.active[0].face_id, auctionCatalogItem(await loadAuctionCatalog({ root }), 'auction_being_11').face_id);
  assert.equal((await readMutableInventory(root)).money, 32000);
});

test('a player award consumes nothing and does not advance the slot when the LLM naming output is unusable', async (t) => {
  const root = await auctionSessionRoot({ money: 60000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_wa_02', 'auction_item_05', 'auction_being_11']);

  // The naming candidate is missing its flavor → validateCraftNaming throws before any writer runs.
  const badFetch = mockLlmFetch({ nameFlavor: { name: '銘だけ' } });
  await assert.rejects(resolveAuctionLot({ root, authoringRoot: root, config: LM_CONFIG, fetchImpl: badFetch, lotIndex: 0, winner: 'player', amount: 9000 }));
  assert.equal((await readMutableInventory(root)).money, 60000);
  assert.equal((await loadEquipmentSurface({ root })).instances.length, 0);
  assert.equal((await currentSlot(root)).current_lot_index, 0);
});

// ----- lot resolution: NPC win / pass-in -----

test('an NPC win records the award and removes a one-of-a-kind from the world without touching player assets', async (t) => {
  const root = await auctionSessionRoot({ money: 60000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_wa_02', 'auction_item_05', 'auction_being_11']);

  const result = await resolveAuctionLot({ root, authoringRoot: root, config: LM_CONFIG, fetchImpl: mockLlmFetch(), lotIndex: 0, winner: 'character_001', amount: 12000 });
  assert.equal(result.resolution.winner_character_id, 'character_001');
  assert.equal((await readMutableInventory(root)).money, 60000); // no player payment for an NPC win
  assert.equal((await loadEquipmentSurface({ root })).instances.length, 0);
  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  assert.deepEqual(state.auction_sold_ledger, ['auction_wa_02']); // one-of-a-kind left the world
});

test('a passed-in lot advances with no winner and leaves a one-of-a-kind on the market (not sold)', async (t) => {
  const root = await auctionSessionRoot({ money: 60000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_wa_02', 'auction_item_05', 'auction_being_11']);

  const result = await resolveAuctionLot({ root, authoringRoot: root, config: LM_CONFIG, fetchImpl: mockLlmFetch(), lotIndex: 0, winner: null, amount: null });
  assert.equal(result.resolution.outcome, 'passed_in');
  const slot = await currentSlot(root);
  assert.equal(slot.current_lot_index, 1);
  assert.equal(slot.awards[0].outcome, 'passed_in');
  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  assert.equal(state.auction_sold_ledger, undefined); // a 流札 one-of-a-kind is not removed from the world
});

// ----- close + content result -----

test('resolving all three lots closes the auction and records the week content result', async (t) => {
  const root = await auctionSessionRoot({ money: 60000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  const config = LM_CONFIG;
  const fetchImpl = mockLlmFetch();

  await resolveAuctionLot({ root, authoringRoot: root, config, fetchImpl, lotIndex: 0, winner: 'player', amount: 6000 });
  await resolveAuctionLot({ root, authoringRoot: root, config, fetchImpl, lotIndex: 1, winner: 'character_001', amount: 12000 });
  const final = await resolveAuctionLot({ root, authoringRoot: root, config, fetchImpl, lotIndex: 2, winner: null, amount: null, postContentScreen: 'academy-map' });

  assert.equal(final.resolution.closed, true);
  assert.equal(final.post_content_screen, 'academy-map');
  assert.equal((await currentSlot(root)).status, 'closed');
  assert.equal((await getAuctionState({ root, authoringRoot: root })).phase, 'closed');

  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  const record = readRoutingContentResult(state);
  assert.equal(record.kind, 'auction');
  assert.equal(record.destination_id, 'auction');
  assert.equal(record.detail.outcome, 'closed');
  assert.equal(record.detail.lots.length, 3);
  assert.deepEqual(record.detail.lots.map((lot) => lot.result), ['won_by_player', 'won_by_other', 'passed_in']);
  assert.equal(record.detail.lots[0].winner_display_name, null); // player win
  assert.equal(record.detail.lots[1].winner_display_name, 'キャラ1'); // NPC win
  assert.equal(record.detail.lots[2].price, null); // 流札
});

// ----- current-lot guards -----

test('the step and resolve routes reject a lot that is not the current lot / a closed auction', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);

  await assert.rejects(applyPlayerBid({ root, lotIndex: 1, current: 9000, addAmount: 300 }),
    (error) => error.statusCode === 409 && error.errorCode === 'AUCTION_LOT_NOT_CURRENT');
  await assert.rejects(streamMasterOpening({ root, config: LM_CONFIG, lotIndex: 2, onDelta: () => {} }),
    (error) => error.statusCode === 409 && error.errorCode === 'AUCTION_LOT_NOT_CURRENT');
  await assert.rejects(resolveNpcBidTurn({ root, authoringRoot: root, config: LM_CONFIG, lotIndex: 0, characterId: 'character_099', current: 6000 }),
    (error) => error.statusCode === 404 && error.errorCode === 'AUCTION_UNKNOWN_BIDDER');
});

// ----- streaming (onDelta) -----

test('streamMasterOpening forwards each chat delta through onDelta and returns the assembled utterance', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);

  const deltas = ['さあ皆様、', '今宵の白眉を', '披露いたしましょう。'];
  const sseFetch = async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      for (const delta of deltas) yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
      yield Buffer.from('data: [DONE]\n\n');
    })()
  });
  const seen = [];
  const result = await streamMasterOpening({ root, config: { ...LM_CONFIG, stream: true }, lotIndex: 0, onDelta: (delta) => seen.push(delta), fetchImpl: sseFetch });
  assert.deepEqual(seen, deltas);
  assert.equal(result.utterance, deltas.join(''));
});

test('streamMasterOpening threads the visit prior 口上 into the 反復回避ハンドオフ and rejects a malformed field', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);

  let captured = null;
  const sseFetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: (async function* () {
        yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '皆様、こちらの品に。' } }] })}\n\n`);
        yield Buffer.from('data: [DONE]\n\n');
      })()
    };
  };
  await streamMasterOpening({
    root, config: { ...LM_CONFIG, stream: true }, lotIndex: 0,
    priorUtterances: ['さあ皆様、今宵の白眉を披露いたしましょう。'], onDelta: () => {}, fetchImpl: sseFetch
  });
  assert.match(captured.messages[0].content, /この競売ですでに述べた口上/);
  assert.match(captured.messages[0].content, /- さあ皆様、今宵の白眉を披露いたしましょう。/);

  // A non-array prior_utterances field is bad client input — a 400, never silently dropped.
  await assert.rejects(
    streamMasterOpening({ root, config: LM_CONFIG, lotIndex: 0, priorUtterances: 'not-an-array', onDelta: () => {} }),
    (error) => error.statusCode === 400 && error.errorCode === 'AUCTION_BAD_REQUEST'
  );
});

test('resolveNpcBidTurn syncs the 通常会話コンテクスト into the bid prompt (world + per-bidder affinity resolved)', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11'], { initialPrices: [6000, 9000, 8000] });

  const calls = [];
  await resolveNpcBidTurn({
    root, authoringRoot: projectRoot, config: LM_CONFIG,
    fetchImpl: mockLlmFetch({ bid: { utterance: '積む', action: 'bid', amount: 6300 } }, calls),
    lotIndex: 0, characterId: 'character_001', current: 6000, highestBidder: null, highestBidderName: null, history: []
  });
  const bidBody = calls.find((body) => body.response_format?.json_schema?.name === 'auction_bid_turn');
  const prompt = bidBody.messages[0].content;
  // world_description from the fixture's world settings (loadWorldSettings), injected with the shared label.
  assert.match(prompt, /ワールド設定: 設定/);
  // 会話相手コンテキスト resolved from the bidder's profile parameters + affinity (no affinity file → 25 normalization).
  assert.match(prompt, /会話相手コンテキスト:/);
  assert.match(prompt, /主人公への好感度: 25\/100/);
});

// ----- enter + resume (real roster) -----

test('enterAuction builds the weekly slot from the real roster and same-week re-entry resumes it unchanged', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const entered = await enterAuction({ root, authoringRoot: projectRoot, postContentScreen: 'academy-map' });
  assert.equal(entered.phase, 'in_progress');
  assert.equal(entered.lots.length, 3);
  assert.ok(entered.bidders.length >= 2 && entered.bidders.length <= 4);
  const firstItemIds = entered.lots.map((lot) => lot.name);

  const resumed = await enterAuction({ root, authoringRoot: projectRoot, postContentScreen: 'academy-map' });
  assert.deepEqual(resumed.lots.map((lot) => lot.name), firstItemIds); // same lineup, no re-roll
});

test('across consecutive weeks the lineup varies: no adjacent-week repeat and lot 1 is not flavor-locked (enter → close → advance)', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Drive real week progression through the persisted path: each week enter → resolve all three lots 流札 (which
  // closes the auction and writes auction_previous_lots) → advance elapsed_weeks. The next week's draw reads that
  // carried previous-lots set, so this exercises the whole-catalog one-week cooldown end-to-end.
  const WEEKS = 6;
  const lot1Categories = new Set();
  let previousNames = null;
  let adjacentRepeats = 0;
  for (let offset = 0; offset < WEEKS; offset += 1) {
    const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
    await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, elapsed_weeks: WEEK + offset });
    const view = await enterAuction({ root, authoringRoot: projectRoot, postContentScreen: 'academy-map' });
    const names = view.lots.map((lot) => lot.name);
    if (previousNames) for (const name of names) if (previousNames.includes(name)) adjacentRepeats += 1;
    lot1Categories.add(view.lots[0].category);
    previousNames = names;
    // Close the week (三品すべて流札) so auction_previous_lots is written for the next week's suppression.
    for (let lotIndex = 0; lotIndex < 3; lotIndex += 1) {
      await resolveAuctionLot({ root, authoringRoot: projectRoot, config: LM_CONFIG, fetchImpl: mockLlmFetch(), lotIndex, winner: null, amount: null, postContentScreen: 'academy-map' });
    }
  }
  assert.equal(adjacentRepeats, 0, 'no lot item repeats in two consecutive weeks');
  assert.ok([...lot1Categories].some((category) => category !== 'flavor'), `lot 1 draws a non-flavor category over ${WEEKS} weeks: ${[...lot1Categories].join(',')}`);
});

test('resolveNpcBidTurn resolves the structured decision and re-validates the amount against the slot budget', async (t) => {
  const root = await auctionSessionRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11'], { initialPrices: [6000, 9000, 8000] });

  // An in-budget bid stands.
  const bidResult = await resolveNpcBidTurn({
    root, authoringRoot: projectRoot, config: LM_CONFIG,
    fetchImpl: mockLlmFetch({ bid: { utterance: '積む', action: 'bid', amount: 6300 } }),
    lotIndex: 0, characterId: 'character_001', current: 6000, highestBidder: null, highestBidderName: null, history: []
  });
  assert.equal(bidResult.action, 'bid');
  assert.equal(bidResult.amount, 6300);
  assert.equal(bidResult.current, 6300);
  assert.equal(bidResult.highest_bidder, 'character_001');
  assert.equal(bidResult.min_next, 6300);

  // An over-budget amount is re-validated to a pass (budget 50000 is high; use an amount above it).
  const passResult = await resolveNpcBidTurn({
    root, authoringRoot: projectRoot, config: LM_CONFIG,
    fetchImpl: mockLlmFetch({ bid: { utterance: '一気にいく', action: 'bid', amount: 999999 } }),
    lotIndex: 0, characterId: 'character_001', current: 6000, highestBidder: null, highestBidderName: null, history: []
  });
  assert.equal(passResult.action, 'pass');
  assert.equal(passResult.current, 6000);
});
