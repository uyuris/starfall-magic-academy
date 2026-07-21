import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { writeStarCradleCatalogDefinitionSplit } from './starCradleFixture.mjs';
import { handleAuctionApi } from '../src/server/auctionApi.mjs';
import { loadAuctionCatalog, auctionCatalogItem, buildAuctionSlot, ROUTING_AUCTION_STATE_KEY } from '../src/routingAuction.mjs';

// Exercises the HTTP boundary (handleAuctionApi) directly with fake req/res and sendJson / openSse /
// sendSseEvent / readBody spies — the branching the session-layer tests do not touch: the routing-mode gate,
// the resolve-config-before-SSE discipline, the runAuctionSpeechStream event sequence, the bid dispatch, and
// the client-error status mapping.

const WEEK = 4;
const RUNTIME_STATE_MUTABLE = 'data/mutable/game_data/runtime_state.json';
const BIDDERS = [{ character_id: 'character_001', display_name: 'キャラ1' }, { character_id: 'character_002', display_name: 'キャラ2' }, { character_id: 'character_003', display_name: 'キャラ3' }];
const BUDGETS = { character_001: 50000, character_002: 50000, character_003: 50000 };
const CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'm', reflection_model: 'm', timeout_ms: 5000, stream: true };

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function apiRoot({ money = 60000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-api-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeStarCradleCatalogDefinitionSplit(root);
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money, items: [] });
  await writeJson(root, RUNTIME_STATE_MUTABLE, { version: 1, elapsed_weeks: WEEK, global_flags: {}, characters: {} });
  return root;
}

async function seedSlot(root, itemIds, { initialPrices = [6000, 9000, 8000], increments = [300, 300, 300] } = {}) {
  const catalog = await loadAuctionCatalog({ root });
  const lots = itemIds.map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index, item, band: item.band, initial_price: initialPrices[index], min_increment: increments[index], npc_budgets: { ...BUDGETS } };
  });
  const slot = buildAuctionSlot({ week: WEEK, bidders: BIDDERS, lots });
  const state = JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
  await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, [ROUTING_AUCTION_STATE_KEY]: slot });
}

// Invokes handleAuctionApi with spies. `resolveLmStudioConfig` defaults to a config resolver; pass a throwing
// one to simulate an unconfigured LM. Returns the recorded spy activity and any thrown error.
async function callHandler({ method, pathname, body = {}, root, mode = 'routing', resolveLmStudioConfig = async () => CONFIG }) {
  const jsonCalls = [];
  const sseEvents = [];
  let openSseCount = 0;
  const res = { end() {} };
  const args = {
    req: { method },
    res,
    url: { pathname },
    context: { root, activeRoot: root },
    sendJson: (_res, value, status = 200) => jsonCalls.push({ value, status }),
    readBody: async () => body,
    activePlayMode: { mode },
    resolveLmStudioConfig,
    openSse: () => { openSseCount += 1; },
    sendSseEvent: (_res, event, data) => sseEvents.push({ event, data })
  };
  let threw = null;
  try {
    await handleAuctionApi(args);
  } catch (error) {
    threw = error;
  }
  return { jsonCalls, sseEvents, openSseCount, threw };
}

function sseFetch(deltas) {
  return async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: (async function* () {
      for (const delta of deltas) yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
      yield Buffer.from('data: [DONE]\n\n');
    })()
  });
}

// ----- routing-mode gate -----

test('a non-routing request is rejected with a 409 ROUTING_MODE_REQUIRED', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { threw } = await callHandler({ method: 'GET', pathname: '/api/auction/state', root, mode: 'loop' });
  assert.ok(threw);
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.errorCode, 'ROUTING_MODE_REQUIRED');
});

// ----- resolve-config-before-SSE -----

test('a stream route with an unconfigured LM returns a JSON 503 and never opens the SSE stream', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  const unconfigured = async () => {
    const error = new Error('LM Studio unconfigured');
    error.statusCode = 503;
    error.errorCode = 'LMSTUDIO_CONFIG_REQUIRED';
    throw error;
  };
  const { jsonCalls, openSseCount } = await callHandler({ method: 'POST', pathname: '/api/auction/lot/opening/stream', body: { lot_index: 0 }, root, resolveLmStudioConfig: unconfigured });
  assert.equal(openSseCount, 0);
  assert.equal(jsonCalls.length, 1);
  assert.equal(jsonCalls[0].status, 503);
  assert.equal(jsonCalls[0].value.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
});

// ----- SSE event sequence + error event -----

test('a streamed master opening emits status → assistant_delta(s) → assistant_complete → result', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  const deltas = ['さあ皆様、', '今宵の白眉を。'];
  const original = globalThis.fetch;
  globalThis.fetch = sseFetch(deltas);
  try {
    const { sseEvents, openSseCount } = await callHandler({ method: 'POST', pathname: '/api/auction/lot/opening/stream', body: { lot_index: 0 }, root });
    assert.equal(openSseCount, 1);
    assert.deepEqual(sseEvents.map((entry) => entry.event), ['status', 'assistant_delta', 'assistant_delta', 'assistant_complete', 'result']);
    assert.deepEqual(sseEvents.slice(1, 3).map((entry) => entry.data.delta), deltas);
    assert.equal(sseEvents[3].data.content, deltas.join(''));
    assert.equal(sseEvents[4].data.utterance, deltas.join(''));
  } finally {
    globalThis.fetch = original;
  }
});

test('a generation failure inside an opened stream is emitted as an SSE error event, not a JSON error', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  // lot_index 2 is not the current lot (0) → streamMasterOpening throws 409 AFTER the stream is opened.
  const { sseEvents, openSseCount, jsonCalls } = await callHandler({ method: 'POST', pathname: '/api/auction/lot/opening/stream', body: { lot_index: 2 }, root });
  assert.equal(openSseCount, 1);
  assert.equal(jsonCalls.length, 0);
  assert.deepEqual(sseEvents.map((entry) => entry.event), ['status', 'error']);
  assert.equal(sseEvents[1].data.error_code, 'AUCTION_LOT_NOT_CURRENT');
});

// ----- player bid dispatch -----

test('POST /api/auction/bid dispatches a pass vs an add_amount raise', async (t) => {
  const root = await apiRoot({ money: 20000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);

  const passed = await callHandler({ method: 'POST', pathname: '/api/auction/bid', body: { lot_index: 0, pass: true }, root });
  assert.deepEqual(passed.jsonCalls[0].value, { lot_index: 0, player_active: false });

  const raised = await callHandler({ method: 'POST', pathname: '/api/auction/bid', body: { lot_index: 0, current: 6000, add_amount: 300 }, root });
  assert.equal(raised.jsonCalls[0].value.current, 6300);
  assert.equal(raised.jsonCalls[0].value.highest_bidder, 'player');

  const bad = await callHandler({ method: 'POST', pathname: '/api/auction/bid', body: { lot_index: 0, current: 6000, add_amount: 100 }, root });
  assert.equal(bad.jsonCalls[0].status, 400);
  assert.equal(bad.jsonCalls[0].value.error_code, 'AUCTION_BELOW_MIN_INCREMENT');
});

// ----- client-error status mapping -----

test('a player win the player cannot afford maps the writer insufficient_money throw to a 400', async (t) => {
  const root = await apiRoot({ money: 3000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']); // lot 0 = treasure (no LLM on award)
  const { jsonCalls } = await callHandler({ method: 'POST', pathname: '/api/auction/lot/resolve', body: { lot_index: 0, winner: 'player', amount: 6000 }, root });
  assert.equal(jsonCalls.length, 1);
  assert.equal(jsonCalls[0].status, 400);
});

test('a malformed bid history is a 400, not a 500', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  const { jsonCalls } = await callHandler({
    method: 'POST',
    pathname: '/api/auction/npc-bid',
    body: { lot_index: 0, character_id: 'character_001', current: 6000, history: [{ display_name: 'x', action: 'raise' }] },
    root
  });
  assert.equal(jsonCalls.length, 1);
  assert.equal(jsonCalls[0].status, 400);
  assert.equal(jsonCalls[0].value.error_code, 'AUCTION_BAD_REQUEST');
});

// ----- consignment (player-listed lot・出品側) HTTP surface -----

test('the consignment window routes are gated by routing mode like the rest of the auction surface', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(callHandler({ method: 'GET', pathname: '/api/auction/consignment/options', root, mode: 'loop' }).then((r) => { if (r.threw) throw r.threw; }),
    (error) => error.statusCode === 409 && error.errorCode === 'ROUTING_MODE_REQUIRED');
});

test('consignment submit → resolve runs end-to-end through the HTTP handler, and resolve is LM-free (never calls resolveLmStudioConfig)', async (t) => {
  const root = await apiRoot({ money: 1000 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money: 1000, items: [{ item_id: 'material_light_t3', quantity: 1 }] });
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);

  // options lists the sell_price>0 item
  const options = await callHandler({ method: 'GET', pathname: '/api/auction/consignment/options', root });
  assert.equal(options.jsonCalls[0].status, 200);
  assert.ok(options.jsonCalls[0].value.items.some((entry) => entry.item_id === 'material_light_t3'));

  // submit lists it as the consignment lot
  const submit = await callHandler({ method: 'POST', pathname: '/api/auction/consignment/submit', body: { source: { kind: 'item', item_id: 'material_light_t3' } }, root });
  assert.equal(submit.jsonCalls[0].status, 200);
  assert.equal(submit.jsonCalls[0].value.status, 'listed');
  const winPrice = submit.jsonCalls[0].value.initial_price + submit.jsonCalls[0].value.min_increment;

  // resolve to an NPC — the throwing LM resolver proves the route never touches the model
  const resolve = await callHandler({
    method: 'POST',
    pathname: '/api/auction/consignment/resolve',
    body: { winner: 'character_002', amount: winPrice },
    root,
    resolveLmStudioConfig: async () => { throw new Error('resolve must not call the LM'); }
  });
  assert.equal(resolve.threw, null);
  assert.equal(resolve.jsonCalls[0].status, 200);
  assert.equal(resolve.jsonCalls[0].value.resolution.outcome, 'awarded');
  assert.equal(resolve.jsonCalls[0].value.payout.money, 1000 + winPrice);
});

test('a streamed consignment opening emits the full status → assistant_delta(s) → assistant_complete → result sequence', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money: 1000, items: [{ item_id: 'material_light_t3', quantity: 1 }] });
  await seedSlot(root, ['auction_item_05', 'auction_wa_02', 'auction_being_11']);
  await callHandler({ method: 'POST', pathname: '/api/auction/consignment/submit', body: { source: { kind: 'item', item_id: 'material_light_t3' } }, root });

  const deltas = ['さあ皆様、常連の方が手放された', '委託の品にございます。'];
  const original = globalThis.fetch;
  globalThis.fetch = sseFetch(deltas);
  try {
    const { sseEvents, openSseCount } = await callHandler({ method: 'POST', pathname: '/api/auction/consignment/opening/stream', body: { prior_utterances: [] }, root });
    assert.equal(openSseCount, 1);
    assert.deepEqual(sseEvents.map((entry) => entry.event), ['status', 'assistant_delta', 'assistant_delta', 'assistant_complete', 'result']);
    assert.equal(sseEvents[4].data.utterance, deltas.join(''));
  } finally {
    globalThis.fetch = original;
  }
});

test('a consignment stream route with an unconfigured LM is a JSON 503 that never opens the SSE stream', async (t) => {
  const root = await apiRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { jsonCalls, openSseCount } = await callHandler({
    method: 'POST',
    pathname: '/api/auction/consignment/opening/stream',
    body: { prior_utterances: [] },
    root,
    resolveLmStudioConfig: async () => { const error = new Error('LM not configured'); error.statusCode = 503; error.errorCode = 'LMSTUDIO_CONFIG_REQUIRED'; throw error; }
  });
  assert.equal(openSseCount, 0);
  assert.equal(jsonCalls[0].status, 503);
});
