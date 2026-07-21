import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { baselineRuntimeState, fixtureRoot, readJson, writeJson } from './helpers.mjs';
import { buildRoutingHubContextSnapshot } from '../src/routingHubContextSnapshot.mjs';
import { setRelationshipDebugState } from '../src/relationshipState.mjs';
import { trainingDefinitions } from '../src/training.mjs';

function routingState(overrides = {}) {
  return {
    ...baselineRuntimeState,
    elapsed_weeks: 3,
    current_buddy_character_id: null,
    current_enemy_character_ids: [],
    ...overrides
  };
}

function withoutProperty(object, propertyName) {
  const copy = { ...object };
  delete copy[propertyName];
  return copy;
}

function appliedProgression({ conversationId = 'conv_dispatch_001', destinationId = 'training', elapsedWeeks = 3 } = {}) {
  return {
    idempotency_key: `${conversationId}:${destinationId}`,
    conversation_id: conversationId,
    destination_id: destinationId,
    phase: 'applied',
    route: destinationId === 'academy-map' ? 'academy-map' : `academy-${destinationId}`,
    applied_at: '2026-05-05T06:00:00.000+09:00',
    elapsed_weeks: elapsedWeeks
  };
}

function trainingRecord({ week = 3 } = {}) {
  return {
    kind: 'training',
    destination_id: 'training',
    week,
    recorded_at: '2026-05-05T06:10:00.000+09:00',
    trigger: 'training_completed',
    detail: {
      outcome: 'completed',
      trainings: [{
        day_index: 0,
        day_name: '光曜',
        training_id: 'healing_practice',
        training_name: '治癒魔法実習'
      }],
      parameter_deltas: {
        magic: { light: 2 },
        abilities: { strength: -1 }
      }
    }
  };
}

function dungeonRecord({ companionCharacterId = null } = {}) {
  return {
    kind: 'dungeon',
    destination_id: 'dungeon',
    week: 3,
    recorded_at: '2026-05-05T06:20:00.000+09:00',
    trigger: 'dungeon_run_committed',
    detail: {
      outcome: 'retreated',
      floor_reached: 4,
      max_floors: 10,
      applied_gains: {
        magic: { fire: 1 },
        abilities: { agility: 2 }
      },
      total_applied: 3,
      companion_character_id: companionCharacterId
    }
  };
}

test('buildRoutingHubContextSnapshot captures the last non-routing conversation accepted memory', async () => {
  const root = await fixtureRoot('routing-hub-context-memory-', {
    runtimeState: routingState({ last_conversation_id: 'conv_recent_memory_001' })
  });
  await writeJson(root, 'game_data/logs/conversations/conv_recent_memory_001.json', {
    id: 'conv_recent_memory_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    messages: [{ role: 'assistant', content: 'また観測しましょう。' }]
  });
  await writeJson(root, 'game_data/logs/validator/conv_recent_memory_001.json', {
    accepted_memory: [{ text: '主人公は星図の読み方を少し覚えた。' }]
  });
  const state = await readJson(root, 'game_data/runtime_state.json');

  const context = await buildRoutingHubContextSnapshot({ root, state, personaVariant: 'fallen_star' });

  assert.deepEqual(context.alchemy_context, {
    recipe_count: 56
  });
  assert.deepEqual(context.study_circle_context, {
    theme_count: trainingDefinitions.length,
    weekly_offer_count: 3
  });
  assert.deepEqual(context.recent_conversation_context, {
    kind: 'conversation_memory',
    conversation_id: 'conv_recent_memory_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    memory_text: '主人公は星図の読み方を少し覚えた。'
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot derives alchemy mechanics from loaded definitions and fails fast on malformed definitions', async () => {
  const root = await fixtureRoot('routing-hub-context-alchemy-', {
    runtimeState: routingState()
  });
  const definitions = await readJson(root, 'game_data/alchemy_recipes.json');
  await writeJson(root, 'game_data/alchemy_recipes.json', {
    ...definitions,
    recipes: definitions.recipes.slice(0, 55)
  });

  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: await readJson(root, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /alchemy recipes must contain exactly 56 entries/
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot derives study-circle mechanics from loaded definitions and fails fast on malformed definitions', async () => {
  const root = await fixtureRoot('routing-hub-context-study-circle-', {
    runtimeState: routingState()
  });
  const definitions = await readJson(root, 'game_data/study_circles.json');
  await writeJson(root, 'game_data/study_circles.json', definitions.slice(0, -1));

  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: await readJson(root, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /study circle theme set must match training definitions/
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot distinguishes no memory, no new conversation, unfinished opening, and corrupt recent conversation state', async () => {
  const noMemoryRoot = await fixtureRoot('routing-hub-context-no-memory-', {
    runtimeState: routingState({ last_conversation_id: 'conv_recent_no_memory_001' })
  });
  await writeJson(noMemoryRoot, 'game_data/logs/conversations/conv_recent_no_memory_001.json', {
    id: 'conv_recent_no_memory_001',
    character_id: 'character_002',
    character_name: 'ミラ',
    messages: []
  });
  await writeJson(noMemoryRoot, 'game_data/logs/validator/conv_recent_no_memory_001.json', {
    accepted_memory: []
  });
  const noMemoryContext = await buildRoutingHubContextSnapshot({
    root: noMemoryRoot,
    state: await readJson(noMemoryRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.equal(noMemoryContext.recent_conversation_context.kind, 'conversation_without_memory');

  const routingLogRoot = await fixtureRoot('routing-hub-context-routing-log-', {
    runtimeState: routingState({ last_conversation_id: 'conv_prior_hub_001' })
  });
  await writeJson(routingLogRoot, 'game_data/logs/conversations/conv_prior_hub_001.json', {
    id: 'conv_prior_hub_001',
    character_id: 'lina',
    character_name: 'ルミ',
    routing_hub: { persona_variant: 'fallen_star' },
    messages: []
  });
  const routingLogContext = await buildRoutingHubContextSnapshot({
    root: routingLogRoot,
    state: await readJson(routingLogRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.equal(routingLogContext.recent_conversation_context.kind, 'no_new_conversation');

  const danglingRoot = await fixtureRoot('routing-hub-context-dangling-', {
    runtimeState: routingState({ last_conversation_id: 'conv_missing_recent_001' })
  });
  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root: danglingRoot,
      state: await readJson(danglingRoot, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /last conversation log is missing/
  );

  // slot_009 shape: a non-routing opening that was never finalized — no validator log and no finalization
  // marker. This is a legitimate runtime state, not corruption: the hub reports conversation_without_memory.
  const unfinishedOpeningRoot = await fixtureRoot('routing-hub-context-unfinished-opening-', {
    runtimeState: routingState({ last_conversation_id: 'conv_unfinished_opening_001' })
  });
  await writeJson(unfinishedOpeningRoot, 'game_data/logs/conversations/conv_unfinished_opening_001.json', {
    id: 'conv_unfinished_opening_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    source_type: 'field',
    location_id: 'courtyard_fountain',
    time_slot: 'after_school',
    messages: [{ role: 'assistant', content: 'こんにちは。' }]
  });
  const unfinishedOpeningContext = await buildRoutingHubContextSnapshot({
    root: unfinishedOpeningRoot,
    state: await readJson(unfinishedOpeningRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.deepEqual(unfinishedOpeningContext.recent_conversation_context, {
    kind: 'conversation_without_memory',
    conversation_id: 'conv_unfinished_opening_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    memory_text: null
  });

  // Corrupt: a finalization marker present but its validator log lost. The marker proves the conversation was
  // finalized, so the missing validator is genuine corruption and still fails fast.
  const corruptFinalizedRoot = await fixtureRoot('routing-hub-context-corrupt-finalized-', {
    runtimeState: routingState({ last_conversation_id: 'conv_corrupt_finalized_001' })
  });
  await writeJson(corruptFinalizedRoot, 'game_data/logs/conversations/conv_corrupt_finalized_001.json', {
    id: 'conv_corrupt_finalized_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    messages: []
  });
  await writeJson(corruptFinalizedRoot, 'game_data/logs/finalization/conv_corrupt_finalized_001.json', {
    conversation_id: 'conv_corrupt_finalized_001',
    work_record_id: 'wr_conv_corrupt_finalized_001',
    finalized_at: '2026-05-05T06:00:00.000+09:00'
  });
  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root: corruptFinalizedRoot,
      state: await readJson(corruptFinalizedRoot, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /validator log is missing/
  );

  await fs.rm(noMemoryRoot, { recursive: true, force: true });
  await fs.rm(routingLogRoot, { recursive: true, force: true });
  await fs.rm(danglingRoot, { recursive: true, force: true });
  await fs.rm(unfinishedOpeningRoot, { recursive: true, force: true });
  await fs.rm(corruptFinalizedRoot, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot resolves relationship names and fresh content results', async () => {
  const root = await fixtureRoot('routing-hub-context-current-state-', {
    runtimeState: routingState({
      current_buddy_character_id: 'character_001',
      current_enemy_character_ids: ['character_002'],
      routing_week_progressions: [appliedProgression()],
      last_routing_content_result: trainingRecord()
    })
  });

  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'hourglass_grain'
  });

  assert.equal(context.relationship_context.buddy.character_id, 'character_001');
  assert.equal(typeof context.relationship_context.buddy.display_name, 'string');
  assert.equal(context.relationship_context.enemies[0].character_id, 'character_002');
  assert.deepEqual(context.content_result_context.record, trainingRecord());

  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: routingState({ current_buddy_character_id: 'character_999' }),
      personaVariant: 'fallen_star'
    }),
    /unknown selectable character/
  );

  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: withoutProperty(routingState(), 'current_buddy_character_id'),
      personaVariant: 'fallen_star'
    }),
    /runtime_state.current_buddy_character_id is required/
  );

  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: withoutProperty(routingState(), 'current_enemy_character_ids'),
      personaVariant: 'fallen_star'
    }),
    /runtime_state.current_enemy_character_ids is required/
  );

  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: routingState({ current_enemy_character_ids: [''] }),
      personaVariant: 'fallen_star'
    }),
    /runtime_state.current_enemy_character_ids\[0\] is required/
  );

  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot recovers after an invalid saved buddy=lina is cleared through the debug relationship API', async () => {
  const root = await fixtureRoot('routing-hub-context-lina-recovery-', {
    runtimeState: routingState({ current_buddy_character_id: 'lina' })
  });

  // Before recovery: the snapshot fails fast on the dangling routing-persona buddy id.
  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: await readJson(root, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /unknown selectable character: lina/
  );

  // Recovery: clearing the buddy through the debug relationship path resolves the dangling id.
  const recovered = await setRelationshipDebugState({ root, buddyCharacterId: null, enemyCharacterIds: [] });
  assert.equal(recovered.relationship.current_buddy_character_id, null);

  // After recovery: routing hub entry no longer fails fast and reports no buddy.
  const context = await buildRoutingHubContextSnapshot({
    root,
    state: await readJson(root, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.equal(context.relationship_context.buddy, null);

  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot renders only fresh content result records and resolves dungeon companions', async () => {
  const staleRoot = await fixtureRoot('routing-hub-context-stale-result-', {
    runtimeState: routingState({
      routing_week_progressions: [appliedProgression({ destinationId: 'academy-map' })],
      last_routing_content_result: trainingRecord()
    })
  });
  const staleContext = await buildRoutingHubContextSnapshot({
    root: staleRoot,
    state: await readJson(staleRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.equal(staleContext.content_result_context, null);

  const dungeonRoot = await fixtureRoot('routing-hub-context-dungeon-result-', {
    runtimeState: routingState({
      routing_week_progressions: [appliedProgression({ destinationId: 'dungeon' })],
      last_routing_content_result: dungeonRecord({ companionCharacterId: 'character_003' })
    })
  });
  const dungeonContext = await buildRoutingHubContextSnapshot({
    root: dungeonRoot,
    state: await readJson(dungeonRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.equal(dungeonContext.content_result_context.record.kind, 'dungeon');
  assert.equal(dungeonContext.content_result_context.companion.character_id, 'character_003');
  assert.equal(typeof dungeonContext.content_result_context.companion.display_name, 'string');

  await fs.rm(staleRoot, { recursive: true, force: true });
  await fs.rm(dungeonRoot, { recursive: true, force: true });
});
