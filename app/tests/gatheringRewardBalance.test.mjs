import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { definitionsRoot } from './testPaths.mjs';

// Reward-balance v2 (2026-07-12): 学院採取 is the lowest channel. The four sellable materials drop to
// 4/6/3/5G (full haul 54G), while the 星の揺り籠 seed/bulb/egg stay at sell_price 0.
test('gathering material sell prices match the balance v2 schedule (full haul 54G)', async () => {
  const raw = await fs.readFile(path.join(definitionsRoot, 'gathering_points.json'), 'utf8');
  const { materials, points } = JSON.parse(raw);
  const sellById = new Map(materials.map((material) => [material.item_id, material.sell_price]));

  assert.equal(sellById.get('silverleaf_sprout'), 4);
  assert.equal(sellById.get('star_resin_amber'), 6);
  assert.equal(sellById.get('mica_stream_pebble'), 3);
  assert.equal(sellById.get('ancient_shrine_moss'), 5);

  // The 星の揺り籠 items remain non-sellable.
  assert.equal(sellById.get('star_cradle_yuragi_bulb'), 0);
  assert.equal(sellById.get('star_cradle_madara_egg'), 0);
  assert.equal(sellById.get('star_cradle_warm_egg'), 0);

  // Full haul = every point's stock_max sold at its material's sell_price.
  const fullHaul = points.reduce((sum, point) => {
    const sellPrice = sellById.get(point.material.item_id);
    return sum + point.stock_max * point.material.quantity * sellPrice;
  }, 0);
  assert.equal(fullHaul, 54);
});
