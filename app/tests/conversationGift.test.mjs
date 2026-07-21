import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { fixtureRoot } from './helpers.mjs';
import { createStorageApi } from '../src/storage.mjs';
import {
  runConversationOpening,
  startInteractionSession
} from '../src/llm/conversationPipeline.mjs';
import { ensureSelectableCharacterStorage, isSelectableCharacterId } from '../src/characterCatalog.mjs';
import { grantInventoryRewards, loadInventory } from '../src/economy.mjs';
import {
  applyCharacterAffinityDelta,
  characterAffinityPath
} from '../src/affinityState.mjs';
import {
  CONVERSATION_GIFT_ITEM_CATEGORIES,
  giftAffinityIdempotencyKey
} from '../src/conversationGift.mjs';
import { handleConversationGiftApi } from '../src/server/conversationGiftApi.mjs';

const GIFT_ITEM_ID = 'alchemy_stardust_konpeito'; // gift, affinity_bonus 3
const ALLY_BOOST_ITEM_ID = 'alchemy_light_resonance_tonic'; // ally_boost, magic.light +4
const PRODUCT_ITEM_ID = 'alchemy_stardust_trinket'; // product (ineligible)
const AUCTION_GIFT_ITEM_ID = 'auction_item_02'; // 月蝕の香炉: auction gift, affinity_bonus 15 (the reported symptom item)
const AUCTION_SELF_BOOST_ITEM_ID = 'auction_item_04'; // auction self_boost — a known effect item, not deliverable

const OPENING_LINE = '……こんにちは。今日はどうしたの。';
const REACTION_LINE = 'わあ、ありがとう。大切にするね。';

async function conversationGiftFixture(t) {
  const root = await fixtureRoot('magic-adv-conversation-gift-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

// Opens an active conversation with a selectable character the way the game does: materialize the
// character's mutable surface, start the interaction, then run the opening turn (mock chat).
async function openActiveConversation({ root, characterId }) {
  await ensureSelectableCharacterStorage({ root, characterId });
  await startInteractionSession({ root, characterId });
  const opening = await runConversationOpening({
    root,
    id: null,
    characterId,
    now: '2026-07-09T00:00:00.000Z',
    chatProvider: async () => OPENING_LINE
  });
  return opening.conversation.id;
}

// A full, valid routing_hub snapshot for a hub opening. The persisted snapshot is what the gift path
// re-derives the guide's variant persona and hub acceptance from (server-authoritatively).
function hubSnapshot(personaVariant) {
  return {
    persona_variant: personaVariant,
    recent_conversation_context: {
      kind: 'no_new_conversation',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    },
    relationship_context: { buddy: null, enemies: [] },
    alchemy_context: { recipe_count: 8 },
    study_circle_context: { theme_count: 10, weekly_offer_count: 3 },
    content_result_context: null
  };
}

// Opens an active ROUTING HUB conversation with the guide persona (routing persona `lina`) carrying a routing_hub
// snapshot, the way the routing hub opening does.
async function openActiveHubConversation({ root, personaVariant = 'fallen_star', chatProvider = async () => OPENING_LINE }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', { ...state, elapsed_weeks: state.elapsed_weeks ?? 0 });
  await startInteractionSession({ root, characterId: 'lina' });
  const opening = await runConversationOpening({
    root,
    id: null,
    characterId: 'lina',
    now: '2026-07-09T00:00:00.000Z',
    routingHubContext: hubSnapshot(personaVariant),
    chatProvider
  });
  return opening.conversation.id;
}

async function seedItem({ root, itemId, quantity = 1 }) {
  await grantInventoryRewards({ root, rewards: [{ item_id: itemId, quantity }] });
}

function reactionProvider(text = REACTION_LINE) {
  return async () => text;
}

// Drives the gift handler directly (no HTTP layer). Returns { result } on success (captured sendJson
// payload) or { error } when the handler throws its structured error (the real server's top-level catch
// turns that into the HTTP status/error_code).
async function callGift({ root, body, chatProvider = reactionProvider() }) {
  let captured = null;
  const sendJson = (_res, payload, status = 200) => { captured = { payload, status }; };
  try {
    await handleConversationGiftApi({
      req: { method: 'POST' },
      res: {},
      url: new URL('http://127.0.0.1/api/conversation/gift'),
      context: { root, activeRoot: null },
      sendJson,
      readBody: async () => body,
      resolveRuntimeProviders: async () => ({ chatProvider }),
      activePlayMode: { mode: 'routing' }
    });
  } catch (error) {
    return { error };
  }
  return { result: captured };
}

async function readConversation(root, conversationId) {
  return createStorageApi({ root }).readJson(`game_data/logs/conversations/${conversationId}.json`);
}

test('CONVERSATION_GIFT_ITEM_CATEGORIES is the deliverable set and isSelectableCharacterId gates non-roster actors', () => {
  assert.deepEqual([...CONVERSATION_GIFT_ITEM_CATEGORIES], ['gift', 'ally_boost']);
  assert.equal(isSelectableCharacterId('character_001'), true);
  assert.equal(isSelectableCharacterId('lina'), false);
  assert.equal(isSelectableCharacterId('creature_001'), false);
  assert.equal(isSelectableCharacterId('homunculus_001'), false);
});

test('gift: reaction generated, item consumed, affinity raised, record appended', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_001';
  const conversationId = await openActiveConversation({ root, characterId });
  await seedItem({ root, itemId: GIFT_ITEM_ID });

  const { result, error } = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(error, undefined);
  assert.equal(result.status, 200);

  const { item, reaction_text, effect, inventory } = result.payload.result;
  assert.deepEqual(item, { item_id: GIFT_ITEM_ID, name: '星屑の金平糖', category: 'gift' });
  assert.equal(reaction_text, REACTION_LINE);
  assert.equal(effect.bonus, 3);
  assert.equal(effect.affinity_after, effect.affinity_before + 3);
  assert.equal((inventory.items ?? []).some((entry) => entry.item_id === GIFT_ITEM_ID), false);

  // Affinity surface reflects the fixed bonus under the gift-specific idempotency key.
  const affinity = await createStorageApi({ root }).readJson(characterAffinityPath(characterId));
  assert.equal(affinity.affinity, effect.affinity_after);
  assert.ok(affinity.applied_affinity_conversation_ids.includes(giftAffinityIdempotencyKey(conversationId)));

  // Conversation record: gate stamped, exactly two new messages (hand-over narration + reaction).
  const conversation = await readConversation(root, conversationId);
  assert.equal(conversation.gift_given.item_id, GIFT_ITEM_ID);
  assert.equal(conversation.gift_given.category, 'gift');
  assert.equal(conversation.messages.length, 3); // opening + narration + reaction
  assert.equal(conversation.messages[1].role, 'user');
  assert.match(conversation.messages[1].content, /星屑の金平糖/);
  assert.deepEqual(conversation.messages[2], { role: 'assistant', content: REACTION_LINE });

  // No finalization/judgment ran: no finalization side logs, conversation not finalized, screen unchanged.
  const state = await createStorageApi({ root }).readJson('game_data/runtime_state.json');
  assert.equal(state.current_screen, 'interaction');
  assert.equal(state.current_interaction_character_id, characterId);
  assert.equal(Object.prototype.hasOwnProperty.call(conversation, 'discarded_after_work_record_id'), false);
  assert.equal(await createStorageApi({ root }).readJsonIfExists(`game_data/logs/affinity_updates/${conversationId}.json`), null);
  assert.equal(await createStorageApi({ root }).readJsonIfExists(`game_data/logs/money_updates/${conversationId}.json`), null);
});

test('auction gift (月蝕の香炉): delivered like an alchemy gift, catalog affinity_bonus applied and item consumed', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_008';
  const conversationId = await openActiveConversation({ root, characterId });
  await seedItem({ root, itemId: AUCTION_GIFT_ITEM_ID });

  const { result, error } = await callGift({ root, body: { item_id: AUCTION_GIFT_ITEM_ID } });
  assert.equal(error, undefined);
  assert.equal(result.status, 200);

  const { item, effect, inventory } = result.payload.result;
  assert.equal(item.item_id, AUCTION_GIFT_ITEM_ID);
  assert.equal(item.category, 'gift');
  assert.ok(item.name.length > 0, 'the auction gift name is resolved (not the raw id)');
  assert.equal(effect.bonus, 15, 'the affinity bonus is the catalog value, not a hardcoded default');
  assert.equal(effect.affinity_after, effect.affinity_before + 15);
  assert.equal((inventory.items ?? []).some((entry) => entry.item_id === AUCTION_GIFT_ITEM_ID), false, 'consumed');

  // Same 1会話1回 gate applies: a second delivery in this conversation is blocked.
  await seedItem({ root, itemId: GIFT_ITEM_ID });
  const second = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(second.error.errorCode, 'GIFT_ALREADY_GIVEN');

  const conversation = await readConversation(root, conversationId);
  assert.equal(conversation.gift_given.item_id, AUCTION_GIFT_ITEM_ID);
  assert.equal(conversation.gift_given.category, 'gift');
});

test('auction self_boost is a known effect item but not a deliverable gift (GIFT_ITEM_NOT_ELIGIBLE)', async (t) => {
  const root = await conversationGiftFixture(t);
  await openActiveConversation({ root, characterId: 'character_009' });
  await seedItem({ root, itemId: AUCTION_SELF_BOOST_ITEM_ID });

  const { result, error } = await callGift({ root, body: { item_id: AUCTION_SELF_BOOST_ITEM_ID } });
  assert.equal(result, undefined);
  assert.equal(error.statusCode, 400);
  assert.equal(error.errorCode, 'GIFT_ITEM_NOT_ELIGIBLE');

  // Not consumed.
  const inventory = await loadInventory({ root });
  assert.equal((inventory.items ?? []).find((entry) => entry.item_id === AUCTION_SELF_BOOST_ITEM_ID)?.quantity ?? 0, 1);
});

test('ally_boost: recipient parameters raised with clamp and reflected in the runtime profile', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_002';
  await openActiveConversation({ root, characterId });
  await seedItem({ root, itemId: ALLY_BOOST_ITEM_ID });

  const profileBefore = await createStorageApi({ root }).readJson(`game_data/characters/${characterId}/profile.json`);
  const lightBefore = Math.max(0, Math.min(100, Number(profileBefore.parameters.magic.light.value ?? profileBefore.parameters.magic.light)));

  const { result, error } = await callGift({ root, body: { item_id: ALLY_BOOST_ITEM_ID } });
  assert.equal(error, undefined);
  assert.equal(result.status, 200);

  const { item, effect } = result.payload.result;
  assert.equal(item.category, 'ally_boost');
  assert.equal(effect.parameter_effects.length, 1);
  const applied = effect.parameter_effects[0];
  assert.deepEqual(
    { group: applied.group, key: applied.key, amount: applied.amount },
    { group: 'magic', key: 'light', amount: 4 }
  );
  assert.equal(applied.before, lightBefore);
  assert.equal(applied.after, Math.min(100, lightBefore + 4));

  // Roster reads the runtime profile first, so the persisted value is what the roster reflects.
  const profileAfter = await createStorageApi({ root }).readJson(`game_data/characters/${characterId}/profile.json`);
  assert.equal(profileAfter.parameters.magic.light.value, Math.min(100, lightBefore + 4));
});

test('generation failure consumes and applies nothing (503)', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_003';
  const conversationId = await openActiveConversation({ root, characterId });
  await seedItem({ root, itemId: GIFT_ITEM_ID });

  const inventoryBefore = await loadInventory({ root });
  const affinityBefore = await createStorageApi({ root }).readJsonIfExists(characterAffinityPath(characterId));

  const { result, error } = await callGift({ root, body: { item_id: GIFT_ITEM_ID }, chatProvider: async () => '' });
  assert.equal(result, undefined);
  assert.equal(error.statusCode, 503);
  assert.equal(error.errorCode, 'GIFT_REACTION_GENERATION_FAILED');

  // Nothing consumed, no effect applied, no record change.
  const inventoryAfter = await loadInventory({ root });
  assert.deepEqual(inventoryAfter.items, inventoryBefore.items);
  const affinityAfter = await createStorageApi({ root }).readJsonIfExists(characterAffinityPath(characterId));
  assert.deepEqual(affinityAfter, affinityBefore);
  const conversation = await readConversation(root, conversationId);
  assert.equal(conversation.messages.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(conversation, 'gift_given'), false);
});

test('one gift per conversation shared across gift and ally_boost, and persists across a reload; a new conversation resets it', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_004';
  await openActiveConversation({ root, characterId });
  await seedItem({ root, itemId: GIFT_ITEM_ID });
  await seedItem({ root, itemId: ALLY_BOOST_ITEM_ID });

  const first = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(first.error, undefined);
  assert.equal(first.result.status, 200);

  // Second delivery in the same conversation — the OTHER category — is blocked by the shared gate.
  const second = await callGift({ root, body: { item_id: ALLY_BOOST_ITEM_ID } });
  assert.equal(second.result, undefined);
  assert.equal(second.error.statusCode, 409);
  assert.equal(second.error.errorCode, 'GIFT_ALREADY_GIVEN');

  // The ally_boost was not consumed (still owned).
  const inventory = await loadInventory({ root });
  assert.equal((inventory.items ?? []).some((entry) => entry.item_id === ALLY_BOOST_ITEM_ID), true);

  // The gate lives on the conversation record, so a fresh read (reload) still rejects.
  const reload = await callGift({ root, body: { item_id: ALLY_BOOST_ITEM_ID } });
  assert.equal(reload.error.errorCode, 'GIFT_ALREADY_GIVEN');

  // A different conversation can receive a gift again (per-conversation gate).
  const otherCharacterId = 'character_005';
  await openActiveConversation({ root, characterId: otherCharacterId });
  const third = await callGift({ root, body: { item_id: ALLY_BOOST_ITEM_ID } });
  assert.equal(third.error, undefined);
  assert.equal(third.result.status, 200);
});

test('gift affinity is applied independently of the finalization affinity delta (distinct idempotency key)', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_006';
  const conversationId = await openActiveConversation({ root, characterId });
  await seedItem({ root, itemId: GIFT_ITEM_ID });

  const { result } = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  const afterGift = result.payload.result.effect.affinity_after;

  // The conversation-end finalization uses the plain conversation id as its affinity idempotency key; the
  // gift used <id>#gift. The finalization delta must apply on top, not be blocked by the gift.
  const finalization = await applyCharacterAffinityDelta({
    root,
    characterId,
    conversationId,
    conversationDelta: 5,
    buddyDelta: 0,
    enemyDelta: 0
  });
  assert.equal(finalization.already_applied, false);
  assert.equal(finalization.before_affinity, afterGift);
  assert.equal(finalization.after_affinity, afterGift + 5);

  // Re-applying the gift key is idempotent (no double bonus).
  const regift = await applyCharacterAffinityDelta({
    root,
    characterId,
    conversationId: giftAffinityIdempotencyKey(conversationId),
    conversationDelta: 3,
    buddyDelta: 0,
    enemyDelta: 0
  });
  assert.equal(regift.already_applied, true);
  assert.equal(regift.after_affinity, afterGift + 5);

  const affinity = await createStorageApi({ root }).readJson(characterAffinityPath(characterId));
  assert.deepEqual(
    [...affinity.applied_affinity_conversation_ids].sort(),
    [conversationId, giftAffinityIdempotencyKey(conversationId)].sort()
  );
});

test('non-selectable actor (lina) is rejected without consuming', async (t) => {
  const root = await conversationGiftFixture(t);
  await startInteractionSession({ root, characterId: 'lina' });
  await runConversationOpening({
    root,
    id: null,
    characterId: 'lina',
    now: '2026-07-09T00:00:00.000Z',
    chatProvider: async () => OPENING_LINE
  });
  await seedItem({ root, itemId: GIFT_ITEM_ID });

  const { result, error } = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(result, undefined);
  assert.equal(error.statusCode, 409);
  assert.equal(error.errorCode, 'GIFT_ACTOR_NOT_SELECTABLE');

  const inventory = await loadInventory({ root });
  assert.equal((inventory.items ?? []).some((entry) => entry.item_id === GIFT_ITEM_ID), true);
});

test('routing hub guide gift: accepted, guide affinity raised, reaction in the variant persona, record appended', async (t) => {
  const root = await conversationGiftFixture(t);
  const conversationId = await openActiveHubConversation({ root, personaVariant: 'bureau_apprentice' });
  await seedItem({ root, itemId: GIFT_ITEM_ID });

  let reactionProfile = null;
  const { result, error } = await callGift({
    root,
    body: { item_id: GIFT_ITEM_ID },
    chatProvider: async ({ profile }) => { reactionProfile = profile; return REACTION_LINE; }
  });
  assert.equal(error, undefined);
  assert.equal(result.status, 200);

  const { item, reaction_text, effect } = result.payload.result;
  assert.deepEqual(item, { item_id: GIFT_ITEM_ID, name: '星屑の金平糖', category: 'gift' });
  assert.equal(reaction_text, REACTION_LINE);
  assert.equal(effect.bonus, 3);
  assert.equal(effect.affinity_after, effect.affinity_before + 3);

  // The reaction was generated with the save's VARIANT persona re-derived from the persisted routing_hub
  // snapshot (display name follows the variant), not the disk lina profile (リナ・クラウゼ).
  assert.equal(reactionProfile.character_id, 'lina');
  assert.equal(reactionProfile.display_name, 'リステ・ドリームレッジ');

  // Guide affinity persisted under the gift-specific idempotency key (independent of the finalization ±10).
  const affinity = await createStorageApi({ root }).readJson(characterAffinityPath('lina'));
  assert.equal(affinity.affinity, effect.affinity_after);
  assert.ok(affinity.applied_affinity_conversation_ids.includes(giftAffinityIdempotencyKey(conversationId)));

  // Conversation record: gate stamped + exactly two new messages (same effect / record shape as the day side).
  const conversation = await readConversation(root, conversationId);
  assert.equal(conversation.gift_given.item_id, GIFT_ITEM_ID);
  assert.equal(conversation.gift_given.category, 'gift');
  assert.equal(conversation.messages.length, 3); // opening + narration + reaction
  assert.equal(conversation.messages[1].role, 'user');
  assert.match(conversation.messages[1].content, /星屑の金平糖/);
  assert.deepEqual(conversation.messages[2], { role: 'assistant', content: REACTION_LINE });
});

test('routing hub guide gift: second gift in the same hub conversation is 409; a new hub conversation resets the gate', async (t) => {
  const root = await conversationGiftFixture(t);
  await openActiveHubConversation({ root });
  await seedItem({ root, itemId: GIFT_ITEM_ID, quantity: 2 });

  const first = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(first.error, undefined);
  assert.equal(first.result.status, 200);

  const second = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(second.result, undefined);
  assert.equal(second.error.statusCode, 409);
  assert.equal(second.error.errorCode, 'GIFT_ALREADY_GIVEN');

  // A fresh hub conversation resets the one-per-conversation gate.
  await openActiveHubConversation({ root });
  const third = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(third.error, undefined);
  assert.equal(third.result.status, 200);
});

test('routing hub guide gift: ally_boost is rejected (400) because the guide has no parameter surface', async (t) => {
  const root = await conversationGiftFixture(t);
  await openActiveHubConversation({ root });
  await seedItem({ root, itemId: ALLY_BOOST_ITEM_ID });

  const { result, error } = await callGift({ root, body: { item_id: ALLY_BOOST_ITEM_ID } });
  assert.equal(result, undefined);
  assert.equal(error.statusCode, 400);
  assert.equal(error.errorCode, 'GIFT_ITEM_NOT_ELIGIBLE');

  // Nothing consumed.
  const inventory = await loadInventory({ root });
  assert.equal((inventory.items ?? []).find((entry) => entry.item_id === ALLY_BOOST_ITEM_ID)?.quantity ?? 0, 1);
});

test('ineligible category, unknown item, unowned item, and no active conversation all fail fast', async (t) => {
  const root = await conversationGiftFixture(t);
  const characterId = 'character_007';

  // No active conversation yet.
  const noConversation = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(noConversation.error.statusCode, 409);
  assert.equal(noConversation.error.errorCode, 'GIFT_NO_ACTIVE_CONVERSATION');

  await openActiveConversation({ root, characterId });

  const product = await callGift({ root, body: { item_id: PRODUCT_ITEM_ID } });
  assert.equal(product.error.statusCode, 400);
  assert.equal(product.error.errorCode, 'GIFT_ITEM_NOT_ELIGIBLE');

  const unknown = await callGift({ root, body: { item_id: 'alchemy_not_a_real_item' } });
  assert.equal(unknown.error.statusCode, 400);
  assert.equal(unknown.error.errorCode, 'GIFT_ITEM_UNKNOWN');

  // Eligible item resolved but not owned.
  const unowned = await callGift({ root, body: { item_id: GIFT_ITEM_ID } });
  assert.equal(unowned.error.statusCode, 400);
  assert.equal(unowned.error.errorCode, 'GIFT_ITEM_NOT_OWNED');
});

test('gift requires routing mode', async (t) => {
  const root = await conversationGiftFixture(t);
  let threw = null;
  try {
    await handleConversationGiftApi({
      req: { method: 'POST' },
      res: {},
      url: new URL('http://127.0.0.1/api/conversation/gift'),
      context: { root, activeRoot: null },
      sendJson: () => {},
      readBody: async () => ({ item_id: GIFT_ITEM_ID }),
      resolveRuntimeProviders: async () => ({ chatProvider: reactionProvider() }),
      activePlayMode: { mode: 'loop' }
    });
  } catch (error) {
    threw = error;
  }
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.errorCode, 'ROUTING_MODE_REQUIRED');
});
