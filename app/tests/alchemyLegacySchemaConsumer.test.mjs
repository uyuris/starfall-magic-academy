// Regression lock for the alchemy legacy-schema consumer fix.
//
// Background: the alchemy book revamp replaced the alchemy definitions schema from the old
// `{ products, recipes }` weekly-offer shape to the standing `{ items, recipes }` book shape, and
// removed the old strict loader that validated `products` (the source of the "alchemy products must
// be an array" error). A residual consumer applying the removed old-schema validation to the new data
// would surface on the routing "会話終了 → ローディング → ハブ帰還" path, because the hub re-entry
// snapshot loads the alchemy definitions (`alchemy_context`) and reads the persisted routing content
// result. うゆりすさん observed exactly this after ending a 研究会 (study circle) conversation, and asked
// to confirm the 依頼 (errand) return does not hit the same break.
//
// These tests build the real hub-return snapshot (buildRoutingHubContextSnapshot, the exact
// end→hub-return build) against the REAL committed alchemy definitions, with a study_circle and an
// errand content result persisted on runtime_state — the two destinations whose end→hub return the
// symptom covers. They assert the snapshot builds with the NEW-shape `alchemy_context` and never applies
// old-schema validation, and they pin the committed data to the new `{ items }` shape so the removed
// `products` validator can never be re-satisfied by the data. A reintroduced old-schema alchemy consumer
// on this path — or a data regression back to `products` — fails these.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { baselineRuntimeState, fixtureRoot, readJson } from './helpers.mjs';
import { buildRoutingHubContextSnapshot } from '../src/routingHubContextSnapshot.mjs';
import { loadAlchemyDefinitions } from '../src/alchemyDefinitions.mjs';

function routingState(overrides = {}) {
  return {
    ...baselineRuntimeState,
    elapsed_weeks: 3,
    current_buddy_character_id: null,
    current_enemy_character_ids: [],
    ...overrides
  };
}

function appliedProgression(destinationId) {
  return {
    idempotency_key: `conv_end_hub_001:${destinationId}`,
    conversation_id: 'conv_end_hub_001',
    destination_id: destinationId,
    phase: 'applied',
    route: `academy-${destinationId}`,
    applied_at: '2026-05-05T06:00:00.000+09:00',
    elapsed_weeks: 3
  };
}

function studyCircleRecord() {
  return {
    kind: 'study_circle',
    destination_id: 'study_circle',
    week: 3,
    recorded_at: '2026-05-05T06:30:00.000+09:00',
    trigger: 'study_circle_completed',
    detail: {
      outcome: 'completed',
      achieved: true,
      theme_id: 'barrier_weaving',
      theme_name: '結界編み込み実習',
      host_character_id: 'character_001',
      host_display_name: 'セラ・アストルーペ',
      parameter_deltas: { magic: { light: 3 }, abilities: {} }
    }
  };
}

function errandRecord() {
  return {
    kind: 'errand',
    destination_id: 'errand',
    week: 3,
    recorded_at: '2026-05-05T06:40:00.000+09:00',
    trigger: 'errand_completed',
    detail: {
      outcome: 'completed',
      achieved: true,
      errand_id: 'life_28',
      title: '資料室の貸出票整理',
      reward_money: 15,
      client_character_id: 'character_001',
      client_display_name: 'セラ・アストルーペ'
    }
  };
}

test('the 研究会 end→hub-return snapshot builds against the new alchemy schema (no old-schema products validation)', async () => {
  const root = await fixtureRoot('alchemy-legacy-study-circle-return-', {
    runtimeState: routingState({
      routing_week_progressions: [appliedProgression('study_circle')],
      last_routing_content_result: studyCircleRecord()
    })
  });

  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });

  // The hub re-entry loads the standing recipe book — the new shape, count 56, not the removed weekly-offer shape.
  assert.deepEqual(context.alchemy_context, { recipe_count: 56 });
  // The persisted study circle content result was read and validated on the return — the symptom's exact leg.
  assert.equal(context.content_result_context.record.kind, 'study_circle');
  assert.equal(context.content_result_context.record.detail.theme_id, 'barrier_weaving');
  assert.equal(context.content_result_context.companion, null);

  await fs.rm(root, { recursive: true, force: true });
});

test('the 依頼 end→hub-return snapshot builds against the new alchemy schema (same leg, errand destination)', async () => {
  const root = await fixtureRoot('alchemy-legacy-errand-return-', {
    runtimeState: routingState({
      routing_week_progressions: [appliedProgression('errand')],
      last_routing_content_result: errandRecord()
    })
  });

  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });

  assert.deepEqual(context.alchemy_context, { recipe_count: 56 });
  assert.equal(context.content_result_context.record.kind, 'errand');
  assert.equal(context.content_result_context.record.detail.errand_id, 'life_28');

  await fs.rm(root, { recursive: true, force: true });
});

test('the committed alchemy definitions carry the new { items } book shape, never the removed { products } shape', async () => {
  const root = await fixtureRoot('alchemy-legacy-data-shape-', { runtimeState: routingState() });

  // The raw committed data has no `products` key — the exact table the removed loader required, so the
  // "alchemy products must be an array" validation can never be re-satisfied by the data.
  const raw = await readJson(root, 'game_data/alchemy_recipes.json');
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'products'), false);
  assert.equal(Array.isArray(raw.items), true);
  assert.equal(Array.isArray(raw.recipes), true);

  // The strict loader the hub-return path uses returns the new-shape items/recipes tables.
  const definitions = await loadAlchemyDefinitions({ root });
  assert.equal(definitions.items.length, 56);
  assert.equal(definitions.recipes.length, 56);
  assert.equal(Object.prototype.hasOwnProperty.call(definitions, 'products'), false);

  await fs.rm(root, { recursive: true, force: true });
});
