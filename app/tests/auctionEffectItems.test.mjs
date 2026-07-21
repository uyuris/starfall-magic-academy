import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  DELIVERABLE_GIFT_CATEGORIES,
  auctionGiftItemDefinitions,
  auctionSelfBoostItemDefinitions,
  mergeDeliverableGiftDefinitions,
  mergeSelfBoostDefinitions,
  loadGiftResolutionSources,
  loadSelfBoostDefinitions
} from '../src/auctionEffectItems.mjs';
import { loadAuctionCatalog, validateAuctionCatalog } from '../src/routingAuction.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition, realAuctionCatalog } from './auctionCatalogFixture.mjs';

// The authored treasure effect items (real catalog): gift 3 品 (01..03), self_boost 6 品 (04..09), dungeon 1 品 (10).
const AUCTION_GIFTS = ['auction_item_01', 'auction_item_02', 'auction_item_03'];
const AUCTION_SELF_BOOSTS = ['auction_item_04', 'auction_item_05', 'auction_item_06', 'auction_item_07', 'auction_item_08', 'auction_item_09'];
const AUCTION_DUNGEON_CONSUMABLE = 'auction_item_10';

async function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2), 'utf8');
}

async function effectItemsRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-effect-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  return root;
}

test('DELIVERABLE_GIFT_CATEGORIES is the gift + ally_boost vocabulary', () => {
  assert.deepEqual([...DELIVERABLE_GIFT_CATEGORIES], ['gift', 'ally_boost']);
});

test('auction projections read the authored effect values and the inventory name/description', async () => {
  const catalog = await loadAuctionCatalog({ root: await effectItemsRoot() });

  const gifts = auctionGiftItemDefinitions(catalog);
  assert.deepEqual(gifts.map((g) => g.item_id).sort(), [...AUCTION_GIFTS].sort());
  for (const gift of gifts) {
    assert.equal(gift.category, 'gift');
    assert.equal(typeof gift.name, 'string');
    assert.ok(gift.name.length > 0, 'name is projected from the auction inventory definition');
    assert.ok(Number.isInteger(gift.affinity_bonus) && gift.affinity_bonus > 0, 'affinity_bonus is the authored value');
  }
  // 月蝕の香炉 (auction_item_02): the reported symptom item — affinity_bonus 15 per the catalog.
  assert.equal(gifts.find((g) => g.item_id === 'auction_item_02').affinity_bonus, 15);

  const selfBoosts = auctionSelfBoostItemDefinitions(catalog);
  assert.deepEqual(selfBoosts.map((s) => s.item_id).sort(), [...AUCTION_SELF_BOOSTS].sort());
  for (const selfBoost of selfBoosts) {
    assert.equal(selfBoost.category, 'self_boost');
    assert.ok(Array.isArray(selfBoost.parameter_effects) && selfBoost.parameter_effects.length > 0);
  }
  // The dungeon_consumable treasure is NOT projected into either gift or self_boost.
  assert.equal(gifts.some((g) => g.item_id === AUCTION_DUNGEON_CONSUMABLE), false);
  assert.equal(selfBoosts.some((s) => s.item_id === AUCTION_DUNGEON_CONSUMABLE), false);
});

test('the merged sources contain both the alchemy and the auction items', async () => {
  const root = await effectItemsRoot();
  const catalog = await loadAuctionCatalog({ root });
  const alchemyDefinitions = { items: minimalValidAlchemyDefinitions().items };

  const gifts = mergeDeliverableGiftDefinitions({ alchemyDefinitions, auctionCatalog: catalog });
  const giftIds = new Set(gifts.map((g) => g.item_id));
  for (const id of AUCTION_GIFTS) assert.ok(giftIds.has(id), `deliverable gifts include the auction gift ${id}`);
  assert.ok(gifts.some((g) => g.category === 'gift' && g.item_id.startsWith('alchemy_')), 'alchemy gifts remain');
  assert.ok(gifts.some((g) => g.category === 'ally_boost'), 'alchemy ally_boosts remain deliverable');

  const selfBoosts = mergeSelfBoostDefinitions({ alchemyDefinitions, auctionCatalog: catalog });
  const selfBoostIds = new Set(selfBoosts.map((s) => s.item_id));
  for (const id of AUCTION_SELF_BOOSTS) assert.ok(selfBoostIds.has(id), `self_boosts include the auction self_boost ${id}`);
  assert.ok(selfBoosts.some((s) => s.item_id.startsWith('alchemy_')), 'alchemy self_boosts remain');
});

test('an unknown / malformed treasure effect category is rejected at the catalog load boundary (never silently dropped by the projection)', async () => {
  // The projections filter by effect.category, so a treasure item with an UNKNOWN effect.category would be
  // silently omitted from every merge — unless the catalog loader rejects it first. It does: validateAuctionCatalog
  // (validateTreasureEffect) throws on any effect.category outside {gift, self_boost, dungeon_consumable}. So the
  // projections only ever run over a validated catalog and can never receive an unknown effect category. This pins
  // design point 5 ("未知の効果カテゴリは load/解決時に throw") at the load boundary.
  const unknownCategory = await realAuctionCatalog();
  const treasure = unknownCategory.items.find((item) => item.category === 'treasure');
  treasure.effect = { category: 'teleport', affinity_bonus: 3 };
  assert.throws(() => validateAuctionCatalog(unknownCategory), /category must be one of/);

  // A category/shape mismatch (a gift effect carrying self_boost fields) is likewise rejected — the executable
  // category and the catalog effect shape cannot diverge silently.
  const shapeMismatch = await realAuctionCatalog();
  const treasure2 = shapeMismatch.items.find((item) => item.category === 'treasure');
  treasure2.effect = { category: 'gift', parameter_effects: [{ group: 'abilities', key: 'strength', amount: 3 }] };
  assert.throws(() => validateAuctionCatalog(shapeMismatch), /unexpected key|missing required key/);
});

test('a duplicate item_id across sources fails fast (no silent shadowing)', async () => {
  const catalog = await loadAuctionCatalog({ root: await effectItemsRoot() });
  // Inject an alchemy item that collides with an auction gift id.
  const collidingAlchemy = { items: [{ item_id: 'auction_item_01', category: 'gift', name: 'x', description: 'y', affinity_bonus: 1 }] };
  assert.throws(() => mergeDeliverableGiftDefinitions({ alchemyDefinitions: collidingAlchemy, auctionCatalog: catalog }), /duplicate deliverable gift definition: auction_item_01/);

  const collidingSelfBoost = { items: [{ item_id: 'auction_item_04', category: 'self_boost', name: 'x', description: 'y', parameter_effects: [] }] };
  assert.throws(() => mergeSelfBoostDefinitions({ alchemyDefinitions: collidingSelfBoost, auctionCatalog: catalog }), /duplicate self_boost definition: auction_item_04/);
});

test('loadGiftResolutionSources exposes the deliverable list and every known effect item id', async () => {
  const { deliverable, knownEffectItemIds } = await loadGiftResolutionSources({ root: await effectItemsRoot() });
  const deliverableIds = new Set(deliverable.map((d) => d.item_id));
  for (const id of AUCTION_GIFTS) assert.ok(deliverableIds.has(id));
  // A self_boost and the dungeon_consumable are known effect items but NOT deliverable.
  for (const id of [...AUCTION_SELF_BOOSTS, AUCTION_DUNGEON_CONSUMABLE]) {
    assert.ok(knownEffectItemIds.has(id), `${id} is a known effect item`);
    assert.equal(deliverableIds.has(id), false, `${id} is not deliverable`);
  }
  assert.equal(knownEffectItemIds.has('totally_unknown_id'), false);
});

test('loadSelfBoostDefinitions loads the merged self_boost list from disk', async () => {
  const selfBoosts = await loadSelfBoostDefinitions({ root: await effectItemsRoot() });
  const ids = new Set(selfBoosts.map((s) => s.item_id));
  for (const id of AUCTION_SELF_BOOSTS) assert.ok(ids.has(id));
  assert.equal(ids.has(AUCTION_GIFTS[0]), false, 'a gift is not a self_boost');
});
