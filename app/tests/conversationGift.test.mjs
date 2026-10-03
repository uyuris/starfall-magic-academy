// 残す (a): 会話中の贈り物が失敗したとき（対象外の品・相手・二度目・反応の生成失敗）に、差し出した品を減らす・効果だけを当てる壊れ方から、プレイヤーの所持品と記録を守る（操作の原子性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { fixtureRoot } from './helpers.mjs';
import { createStorageApi } from '../src/storage.mjs';
import {
  runConversationOpening,
  startInteractionSession
} from '../src/llm/conversationPipeline.mjs';
import { ensureSelectableCharacterStorage } from '../src/characterCatalog.mjs';
import { grantInventoryRewards, loadInventory } from '../src/economy.mjs';
import {
  characterAffinityPath
} from '../src/affinityState.mjs';
import { handleConversationGiftApi } from '../src/server/conversationGiftApi.mjs';

const GIFT_ITEM_ID = 'alchemy_stardust_konpeito'; // gift, affinity_bonus 3
const ALLY_BOOST_ITEM_ID = 'alchemy_light_resonance_tonic'; // ally_boost, magic.light +4
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
