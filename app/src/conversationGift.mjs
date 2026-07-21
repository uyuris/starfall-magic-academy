// In-conversation gift delivery: the player hands a crafted alchemy item to the character they are talking
// with. Two item categories are deliverable — a `gift` raises that character's affinity by a fixed bonus,
// an `ally_boost` raises that character's per-slot parameters. Both share ONE gift gate per conversation
// (at most one delivery of either category per conversation), whose marker lives on the conversation record.
//
// The order is: generate the recipient's reaction first (the caller's LLM seam), then consume + apply
// atomically. Consumption, effect persistence, the reaction append, and the gate marker are bundled into a
// single economy transaction (consumeInventoryItems beforeWrite) so a failed inventory write rolls the whole
// delivery back — the item is never consumed without the effect, and the effect is never applied without the
// item consumed. Every rejection (non-eligible item, not owned, already given, malformed state) fails fast
// with a structured error; there is no silent fallback.

import { createStorageApi } from './storage.mjs';
import { consumeInventoryItems, loadInventory } from './economy.mjs';
import { DELIVERABLE_GIFT_CATEGORIES, loadGiftResolutionSources } from './auctionEffectItems.mjs';
import { applyCharacterParameterEffects } from './characterCatalog.mjs';
import {
  applyCharacterAffinityDelta,
  characterAffinityPath,
  defaultCharacterAffinityFile
} from './affinityState.mjs';

// The only item categories that can be handed over in conversation. Every other category (self_boost /
// dungeon_consumable / product) is rejected here, the same way the economy `use` path rejects them: delivery is
// the single legitimate consumption route for gifts and ally boosts. The vocabulary lives with the deliverable
// merge (auctionEffectItems) so the resolver and the merged source agree on what "deliverable" means.
export const CONVERSATION_GIFT_ITEM_CATEGORIES = DELIVERABLE_GIFT_CATEGORIES;

function giftError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function conversationLogRelativePath(conversationId) {
  return `game_data/logs/conversations/${conversationId}.json`;
}

// The affinity-delta idempotency key for a gift. It is deliberately distinct from the plain conversation id
// that the conversation-end finalization uses for its ±10 affinity judgment, so a gift's fixed bonus and the
// finalization delta are applied independently (neither blocks or double-counts the other) while each stays
// idempotent on its own key.
export function giftAffinityIdempotencyKey(conversationId) {
  const normalized = String(conversationId ?? '').trim();
  if (!normalized) throw new Error('conversationId is required for the gift affinity key');
  return `${normalized}#gift`;
}

// True once any gift / ally-boost has been handed over in this conversation (the shared one-per-conversation
// gate). The marker is the conversation record's `gift_given` field, so the gate survives a reload and resets
// naturally when a new conversation starts.
export function conversationGiftAlreadyGiven(conversation) {
  return Object.prototype.hasOwnProperty.call(conversation ?? {}, 'gift_given') && conversation.gift_given != null;
}

// Resolves an item id to its eligible gift / ally-boost entry from the merged deliverable source (alchemy gift +
// ally_boost and auction gift treasure items). A truly unknown id — one that is not a known effect-bearing catalog
// item at all — is `GIFT_ITEM_UNKNOWN`; a known effect item whose category is not deliverable (self_boost /
// dungeon_consumable / product) is `GIFT_ITEM_NOT_ELIGIBLE`. Both are 400.
export async function resolveGiftItem({ root, itemId }) {
  const normalizedItemId = String(itemId ?? '').trim();
  if (!normalizedItemId) throw giftError('item_id is required', 400, 'GIFT_ITEM_ID_REQUIRED');
  const { deliverable, knownEffectItemIds } = await loadGiftResolutionSources({ root });
  const item = deliverable.find((candidate) => candidate.item_id === normalizedItemId);
  if (item) return item;
  if (knownEffectItemIds.has(normalizedItemId)) {
    throw giftError(`item is not a deliverable gift: ${normalizedItemId}`, 400, 'GIFT_ITEM_NOT_ELIGIBLE');
  }
  throw giftError(`unknown gift item: ${normalizedItemId}`, 400, 'GIFT_ITEM_UNKNOWN');
}

// Fail-fast ownership pre-check so an unowned item is rejected (400) before the LLM reaction is generated.
export async function assertGiftItemOwned({ root, itemId }) {
  const inventory = await loadInventory({ root });
  const owned = (inventory.items ?? []).find((entry) => entry.item_id === itemId)?.quantity ?? 0;
  if (owned < 1) throw giftError(`gift item is not owned: ${itemId}`, 400, 'GIFT_ITEM_NOT_OWNED');
}

// Applies the item's effect and returns a rollback closure that restores the exact prior surface. Gift raises
// the recipient's affinity (independent idempotency key); ally_boost raises the recipient's per-slot
// parameters. The prior surface is captured before the write so a downstream failure leaves no partial effect.
async function applyGiftEffect({ storage, root, authoringRoot, item, conversation, characterId }) {
  if (item.category === 'gift') {
    const affinityRelativePath = characterAffinityPath(characterId);
    const priorAffinity = await storage.readJsonIfExists(affinityRelativePath);
    const applied = await applyCharacterAffinityDelta({
      root,
      characterId,
      conversationId: giftAffinityIdempotencyKey(conversation.id),
      conversationDelta: item.affinity_bonus,
      buddyDelta: 0,
      enemyDelta: 0
    });
    return {
      effect: {
        affinity_before: applied.before_affinity,
        affinity_after: applied.after_affinity,
        bonus: item.affinity_bonus
      },
      rollback: async () => {
        await storage.writeJson(
          affinityRelativePath,
          priorAffinity ?? defaultCharacterAffinityFile(characterId)
        );
      }
    };
  }
  const applied = await applyCharacterParameterEffects({
    root,
    authoringRoot,
    characterId,
    parameterEffects: item.parameter_effects
  });
  return {
    effect: { parameter_effects: applied.effects },
    rollback: async () => {
      await storage.writeJson(applied.profile_relative_path, applied.prior_profile);
    }
  };
}

// Atomically consumes one unit of the item and applies its effect, appends the hand-over narration + reaction
// to the conversation record, and stamps the shared gift gate — all bundled into one economy transaction.
// A gate re-check inside the transaction rejects a concurrent double delivery, and either write failure
// (reaction/effect or inventory) rolls the whole delivery back, so no partial state survives.
export async function applyConversationGift({
  root,
  authoringRoot = root,
  item,
  conversation,
  characterId,
  reactionText,
  handoverNarration,
  now
}) {
  if (!root) throw new Error('root is required');
  const reaction = String(reactionText ?? '').trim();
  if (!reaction) throw new Error('reactionText is required');
  const narration = String(handoverNarration ?? '').trim();
  if (!narration) throw new Error('handoverNarration is required');
  const timestamp = String(now ?? '').trim();
  if (!timestamp) throw new Error('now is required');
  const storage = createStorageApi({ root });
  const conversationRelativePath = conversationLogRelativePath(conversation.id);

  const transaction = await consumeInventoryItems({
    root,
    itemCosts: [{ item_id: item.item_id, quantity: 1 }],
    moneyCost: 0,
    rewards: [],
    beforeWrite: async () => {
      const freshConversation = await storage.readJson(conversationRelativePath);
      if (conversationGiftAlreadyGiven(freshConversation)) {
        throw giftError('a gift has already been given in this conversation', 409, 'GIFT_ALREADY_GIVEN');
      }
      if (freshConversation.discarded_after_work_record_id) {
        throw giftError('the active conversation is already finalized', 409, 'GIFT_CONVERSATION_FINALIZED');
      }
      const effectApplied = await applyGiftEffect({ storage, root, authoringRoot, item, conversation: freshConversation, characterId });
      try {
        const nextConversation = {
          ...freshConversation,
          updated_at: timestamp,
          gift_given: { item_id: item.item_id, category: item.category, given_at: timestamp },
          messages: [
            ...(freshConversation.messages ?? []),
            { role: 'user', content: narration },
            { role: 'assistant', content: reaction }
          ]
        };
        await storage.writeJson(conversationRelativePath, nextConversation);
        return {
          priorConversation: freshConversation,
          nextConversation,
          effect: effectApplied.effect,
          effectRollback: effectApplied.rollback
        };
      } catch (error) {
        // The reaction/gate write failed after the effect was applied: undo the effect so beforeWrite leaves
        // no partial state, then propagate (the inventory is never written when beforeWrite throws).
        await effectApplied.rollback();
        throw error;
      }
    },
    rollbackBeforeWrite: async ({ beforeWriteResult }) => {
      if (!beforeWriteResult) return;
      await storage.writeJson(conversationRelativePath, beforeWriteResult.priorConversation);
      await beforeWriteResult.effectRollback();
    }
  });

  return {
    effect: transaction.beforeWriteResult.effect,
    inventory: transaction.inventory,
    conversation: transaction.beforeWriteResult.nextConversation
  };
}
