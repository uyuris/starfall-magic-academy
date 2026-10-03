// 残す (a): 入札者残滓の掃除 script が範囲外の残滓以外の state を消す壊れ方と、落札の書き込みが失敗したときに所持金や錬成室の枠を減らす壊れ方から、プレイヤーの save を守る。
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
  AUCTION_SOLD_LEDGER_STATE_KEY,
  ROUTING_AUCTION_STATE_KEY,
  ROUTING_AUCTION_CONSIGNMENT_STATE_KEY,
  auctionCatalogItem,
  buildAuctionSlot,
  drawWeeklyAuctionLots,
  loadAuctionCatalog,
  planStaleAuctionBidderStateRemoval
} from '../src/routingAuction.mjs';
import {
  awardAuctionBeingToPlayer,
  awardAuctionEquipmentToPlayer,
  canAdoptAuctionBeing
} from '../src/auctionAward.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { loadHomunculiSurface } from '../src/homunculusSurface.mjs';

function rosterOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    character_id: `character_${String(index + 1).padStart(3, '0')}`,
    display_name: `キャラ${index + 1}`
  }));
}

async function loadCatalog() {
  return loadAuctionCatalog({ root: projectRoot });
}

// ----- stale bidder state cleanup -----

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

test('the equipment writer consumes nothing when the player cannot afford the bid', async (t) => {
  const root = await splitAuctionRoot({ money: 500 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadAuctionCatalog({ root });
  const item = auctionCatalogItem(catalog, 'auction_wa_02');
  await assert.rejects(awardAuctionEquipmentToPlayer({ root, item, week: 4, price: 9000, name: '銘', flavor: '来歴' }), /insufficient_money/);
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 0);
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
