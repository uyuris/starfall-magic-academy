import { isSelectableCharacterId } from '../characterCatalog.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../routingPersona.mjs';
import { createStorageApi } from '../storage.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import { runConversationGiftReaction } from '../llm/conversationPipeline.mjs';
import {
  applyConversationGift,
  assertGiftItemOwned,
  conversationGiftAlreadyGiven,
  resolveGiftItem
} from '../conversationGift.mjs';
import { buildRoutingErrandSceneContext, readActiveRoutingErrand } from '../routingErrands.mjs';
import { buildRoutingStudyCircleSceneContext, readActiveRoutingStudyCircle } from '../routingStudyCircle.mjs';

const ROUTES = new Set(['POST /api/conversation/gift']);

function giftError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw giftError('conversation gift requires routing mode', 409, 'ROUTING_MODE_REQUIRED');
  }
}

export function canHandleConversationGiftApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// The 舞台 to inject into the reaction prompt. An errand / study-circle conversation carries its own injected
// scene (re-supplied each turn); a plain field conversation uses the field scene derived from runtime state
// (dungeonSceneContext undefined). The active errand / study circle only supplies its scene when it is THIS
// conversation.
function giftReactionSceneContext({ state, conversationId }) {
  const activeErrand = readActiveRoutingErrand(state);
  if (activeErrand && activeErrand.conversation_id === conversationId) {
    return buildRoutingErrandSceneContext(activeErrand);
  }
  const activeStudyCircle = readActiveRoutingStudyCircle(state);
  if (activeStudyCircle && activeStudyCircle.conversation_id === conversationId) {
    return buildRoutingStudyCircleSceneContext(activeStudyCircle);
  }
  return undefined;
}

export async function handleConversationGiftApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  resolveRuntimeProviders,
  activePlayMode
}) {
  if (!canHandleConversationGiftApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  if (typeof resolveRuntimeProviders !== 'function') throw new Error('resolveRuntimeProviders is required');

  const root = context.activeRoot ?? context.root;
  const authoringRoot = context.root;
  const storage = createStorageApi({ root });

  const body = await readBody(req);
  const requestedProvider = assertRecognizedRoutingProvider(body.provider);

  const state = await storage.readJson('game_data/runtime_state.json');
  const conversationId = String(state.last_conversation_id ?? '').trim();
  const characterId = String(state.current_interaction_character_id ?? '').trim();
  if (state.current_screen !== 'interaction' || !conversationId || !characterId) {
    throw giftError('no active conversation is open for a gift', 409, 'GIFT_NO_ACTIVE_CONVERSATION');
  }
  const conversation = await storage.readJsonIfExists(`game_data/logs/conversations/${conversationId}.json`);
  if (!conversation || conversation.character_id !== characterId) {
    throw giftError('no active conversation is open for a gift', 409, 'GIFT_NO_ACTIVE_CONVERSATION');
  }
  // The routing hub guide (persona `lina`) is an explicitly accepted gift recipient: a persisted hub
  // conversation carries a `routing_hub` snapshot, and on the routing persona actor that snapshot bypasses the
  // selectable-roster guard (same explicit-acceptance shape the graduation phase-2 guide uses). Every other
  // non-selectable actor — creature, homunculus, or a lina conversation with no hub snapshot — stays rejected.
  const isRoutingHubGuideGift = characterId === ROUTING_PERSONA_CHARACTER_ID
    && Object.prototype.hasOwnProperty.call(conversation, 'routing_hub');
  if (!isRoutingHubGuideGift && !isSelectableCharacterId(characterId)) {
    throw giftError(`conversation gift is only supported for selectable roster characters: ${characterId}`, 409, 'GIFT_ACTOR_NOT_SELECTABLE');
  }
  if (conversation.discarded_after_work_record_id) {
    throw giftError('the active conversation is already finalized', 409, 'GIFT_CONVERSATION_FINALIZED');
  }
  if (conversationGiftAlreadyGiven(conversation)) {
    throw giftError('a gift has already been given in this conversation', 409, 'GIFT_ALREADY_GIVEN');
  }

  const item = await resolveGiftItem({ root, itemId: body.item_id });
  // The hub guide holds no per-slot parameter surface, so only the affinity `gift` category is eligible there;
  // an `ally_boost` (which raises parameters) is rejected. A roster recipient keeps both categories.
  if (isRoutingHubGuideGift && item.category !== 'gift') {
    throw giftError(`item is not eligible for a routing hub guide gift: ${item.item_id} (${item.category})`, 400, 'GIFT_ITEM_NOT_ELIGIBLE');
  }
  await assertGiftItemOwned({ root, itemId: item.item_id });

  const providers = await resolveRuntimeProviders({ requestedProvider, context });
  const now = new Date().toISOString();
  const reaction = await runConversationGiftReaction({
    root,
    conversationId,
    characterId,
    giftItem: item,
    chatProvider: providers.chatProvider,
    characterSpeechConstraints: providers.characterSpeechConstraints ?? [],
    dungeonSceneContext: giftReactionSceneContext({ state, conversationId })
  });

  const applied = await applyConversationGift({
    root,
    authoringRoot,
    item,
    conversation: reaction.conversation,
    characterId,
    reactionText: reaction.reaction_text,
    handoverNarration: reaction.handover_narration,
    now
  });

  const stateAfter = await storage.readJson('game_data/runtime_state.json');
  return sendJson(res, {
    result: {
      item: { item_id: item.item_id, name: item.name, category: item.category },
      reaction_text: reaction.reaction_text,
      effect: applied.effect,
      inventory: applied.inventory
    },
    state: stateAfter
  });
}
