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

// Build a strict 1:1 unconsumed_routing_conversation pointer for a routing state fixture. Mirrors the shape the
// common finalizer writes at atomic promotion, so the hub reader has an eligible unconsumed target to resolve.
function oneToOnePointer({ conversationId, characterId, characterName, terminalSignalAt = '2026-05-05T06:00:00.000+09:00' }) {
  return {
    conversation_id: conversationId,
    kind: '1_to_1',
    participants: [{ character_id: characterId, character_name: characterName }],
    summary_source: {
      kind: 'validator',
      validator_log_path: `game_data/logs/validator/${conversationId}.json`
    },
    terminal_signal_at: terminalSignalAt
  };
}

// Build a strict lounge unconsumed_routing_conversation pointer for a routing state fixture. The pointer carries
// every participant's validator log path in participant order — the hub reader indexes into it to resolve each
// participant's accepted memory (or an explicit null when their validator's accepted_memory is empty).
function loungePointer({ conversationId, participants, terminalSignalAt = '2026-05-05T06:00:00.000+09:00' }) {
  return {
    conversation_id: conversationId,
    kind: 'lounge',
    participants: participants.map((entry) => ({ character_id: entry.character_id, character_name: entry.character_name })),
    summary_source: {
      kind: 'lounge_participant_validator',
      validator_log_paths: participants.map((entry) => (
        `game_data/logs/validator/${conversationId}_${entry.character_id}.json`
      ))
    },
    terminal_signal_at: terminalSignalAt
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

test('buildRoutingHubContextSnapshot resolves an unconsumed 1:1 pointer to the participant\'s accepted memory', async () => {
  const root = await fixtureRoot('routing-hub-context-memory-', {
    runtimeState: routingState({
      unconsumed_routing_conversation: oneToOnePointer({
        conversationId: 'conv_recent_memory_001',
        characterId: 'character_001',
        characterName: 'セラ・アストルーペ'
      })
    })
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

test('buildRoutingHubContextSnapshot resolves an unconsumed lounge pointer to per-participant accepted memory (all three non-empty)', async () => {
  const participants = [
    { character_id: 'character_001', character_name: 'セラ・アストルーペ' },
    { character_id: 'character_002', character_name: 'ミラ' },
    { character_id: 'character_003', character_name: 'ロシェル' }
  ];
  const root = await fixtureRoot('routing-hub-context-lounge-', {
    runtimeState: routingState({
      unconsumed_routing_conversation: loungePointer({
        conversationId: 'conv_lounge_001',
        participants
      })
    })
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_001_character_001.json', {
    accepted_memory: [{ text: 'セラは主人公と星図の印を確かめた。' }]
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_001_character_002.json', {
    accepted_memory: [{ text: 'ミラは主人公との茶葉の話を覚えている。' }]
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_001_character_003.json', {
    accepted_memory: [{ text: 'ロシェルは主人公の低い口笛の話を覚えている。' }]
  });
  const state = await readJson(root, 'game_data/runtime_state.json');

  const context = await buildRoutingHubContextSnapshot({ root, state, personaVariant: 'fallen_star' });

  assert.deepEqual(context.recent_conversation_context, {
    kind: 'lounge_conversation',
    conversation_id: 'conv_lounge_001',
    participants,
    memories: [
      { character_id: 'character_001', character_name: 'セラ・アストルーペ', memory_text: 'セラは主人公と星図の印を確かめた。' },
      { character_id: 'character_002', character_name: 'ミラ', memory_text: 'ミラは主人公との茶葉の話を覚えている。' },
      { character_id: 'character_003', character_name: 'ロシェル', memory_text: 'ロシェルは主人公の低い口笛の話を覚えている。' }
    ]
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot resolves a lounge pointer with a mix of memory-present and empty accepted_memory participants', async () => {
  const participants = [
    { character_id: 'character_001', character_name: 'セラ・アストルーペ' },
    { character_id: 'character_002', character_name: 'ミラ' },
    { character_id: 'character_003', character_name: 'ロシェル' }
  ];
  const root = await fixtureRoot('routing-hub-context-lounge-mixed-', {
    runtimeState: routingState({
      unconsumed_routing_conversation: loungePointer({
        conversationId: 'conv_lounge_mixed_001',
        participants
      })
    })
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_mixed_001_character_001.json', {
    accepted_memory: [{ text: 'セラは主人公と星図の印を確かめた。' }]
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_mixed_001_character_002.json', {
    accepted_memory: []
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_mixed_001_character_003.json', {
    accepted_memory: []
  });
  const state = await readJson(root, 'game_data/runtime_state.json');

  const context = await buildRoutingHubContextSnapshot({ root, state, personaVariant: 'fallen_star' });

  assert.deepEqual(context.recent_conversation_context, {
    kind: 'lounge_conversation',
    conversation_id: 'conv_lounge_mixed_001',
    participants,
    memories: [
      { character_id: 'character_001', character_name: 'セラ・アストルーペ', memory_text: 'セラは主人公と星図の印を確かめた。' },
      { character_id: 'character_002', character_name: 'ミラ', memory_text: null },
      { character_id: 'character_003', character_name: 'ロシェル', memory_text: null }
    ]
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot fails fast when a lounge participant validator log is missing (corrupt pointer)', async () => {
  const participants = [
    { character_id: 'character_001', character_name: 'セラ・アストルーペ' },
    { character_id: 'character_002', character_name: 'ミラ' },
    { character_id: 'character_003', character_name: 'ロシェル' }
  ];
  const root = await fixtureRoot('routing-hub-context-lounge-corrupt-', {
    runtimeState: routingState({
      unconsumed_routing_conversation: loungePointer({
        conversationId: 'conv_lounge_corrupt_001',
        participants
      })
    })
  });
  // Only two of the three validator logs are on disk — the finalizer's atomic promotion should never leave this
  // state, so the reader fails fast rather than silently nulling the missing participant's memory.
  await writeJson(root, 'game_data/logs/validator/conv_lounge_corrupt_001_character_001.json', {
    accepted_memory: [{ text: 'セラは主人公と星図の印を確かめた。' }]
  });
  await writeJson(root, 'game_data/logs/validator/conv_lounge_corrupt_001_character_003.json', {
    accepted_memory: []
  });
  const state = await readJson(root, 'game_data/runtime_state.json');

  await assert.rejects(
    buildRoutingHubContextSnapshot({ root, state, personaVariant: 'fallen_star' }),
    /validator log is missing for lounge pointer-targeted participant.*character_002/
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('buildRoutingHubContextSnapshot fails fast when the unconsumed_routing_conversation field is missing (pre-migration slot)', async () => {
  const preMigrationState = routingState();
  delete preMigrationState.unconsumed_routing_conversation;
  const root = await fixtureRoot('routing-hub-context-pre-migration-', {
    runtimeState: preMigrationState
  });
  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root,
      state: await readJson(root, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /runtime_state\.unconsumed_routing_conversation is required/
  );
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

test('buildRoutingHubContextSnapshot distinguishes null pointer, empty accepted_memory, and a corrupt (missing validator) 1:1 pointer', async () => {
  // Null pointer: after a hub finalization consumes the previous pointer OR at the very first hub entry, the
  // recent-conversation slot reports 'no_new_conversation'. Distinct from a hub-only conversation log record —
  // the pointer alone drives this now.
  const noPointerRoot = await fixtureRoot('routing-hub-context-null-pointer-', {
    runtimeState: routingState()
  });
  const noPointerContext = await buildRoutingHubContextSnapshot({
    root: noPointerRoot,
    state: await readJson(noPointerRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.equal(noPointerContext.recent_conversation_context.kind, 'no_new_conversation');
  assert.equal(noPointerContext.recent_conversation_context.conversation_id, null);

  // Empty accepted_memory: the finalizer wrote a validator log but its accepted_memory is empty (a legitimate
  // finalized-with-no-memory outcome). The hub reports conversation_without_memory with the pointer's
  // participant identity.
  const noMemoryRoot = await fixtureRoot('routing-hub-context-no-memory-', {
    runtimeState: routingState({
      unconsumed_routing_conversation: oneToOnePointer({
        conversationId: 'conv_recent_no_memory_001',
        characterId: 'character_002',
        characterName: 'ミラ'
      })
    })
  });
  await writeJson(noMemoryRoot, 'game_data/logs/validator/conv_recent_no_memory_001.json', {
    accepted_memory: []
  });
  const noMemoryContext = await buildRoutingHubContextSnapshot({
    root: noMemoryRoot,
    state: await readJson(noMemoryRoot, 'game_data/runtime_state.json'),
    personaVariant: 'fallen_star'
  });
  assert.deepEqual(noMemoryContext.recent_conversation_context, {
    kind: 'conversation_without_memory',
    conversation_id: 'conv_recent_no_memory_001',
    character_id: 'character_002',
    character_name: 'ミラ',
    memory_text: null
  });

  // Corrupt: a pointer set with no validator log. The finalizer writes the validator log inside the same atomic
  // promotion as the pointer, so a pointer targeting a missing validator is genuine corruption — fail fast.
  const corruptRoot = await fixtureRoot('routing-hub-context-corrupt-pointer-', {
    runtimeState: routingState({
      unconsumed_routing_conversation: oneToOnePointer({
        conversationId: 'conv_corrupt_pointer_001',
        characterId: 'character_001',
        characterName: 'セラ・アストルーペ'
      })
    })
  });
  await assert.rejects(
    buildRoutingHubContextSnapshot({
      root: corruptRoot,
      state: await readJson(corruptRoot, 'game_data/runtime_state.json'),
      personaVariant: 'fallen_star'
    }),
    /validator log is missing for pointer-targeted conversation/
  );

  await fs.rm(noPointerRoot, { recursive: true, force: true });
  await fs.rm(noMemoryRoot, { recursive: true, force: true });
  await fs.rm(corruptRoot, { recursive: true, force: true });
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
