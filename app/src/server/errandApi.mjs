import {
  listSelectableCharacters,
  selectableCharacterChoice,
  ensureSelectableCharacterStorage
} from '../characterCatalog.mjs';
import { createStorageApi } from '../storage.mjs';
import { loadWorldSettings } from '../worldSettings.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import { generateErrandOfferText } from '../llm/errandOffer.mjs';
import { buildOrLoadWeeklyErrandOffers } from '../routingErrandOffers.mjs';
import {
  ROUTING_ACTIVE_ERRAND_STATE_KEY,
  buildActiveRoutingErrand,
  buildRoutingErrandSceneContext,
  findPersistedErrandOffer,
  loadErrandTypeCatalog,
  makeErrandConversationId,
  readActiveRoutingErrand,
  readWeeklyErrandOffers,
  toPublicErrandOffer
} from '../routingErrands.mjs';

const ROUTES = new Set([
  'GET /api/errand',
  'POST /api/errand/start'
]);

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw statusError('errand content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

function requiredErrandId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw statusError('errand_id is required', 400, { errorCode: 'ERRAND_ID_REQUIRED' });
  }
  return normalized;
}

export function canHandleErrandApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// The mock provider produces deterministic, gate-clean offer text without touching the
// LLM (the ?provider=mock affordance for tests). It never embeds the type name, which may
// carry parentheses that the offer gate forbids; the type id (an ascii slug) is safe. The
// appeal is the own-voice pitch (persona is ignored by the mock — it is deterministic).
function mockErrandOfferText({ type, clientDisplayName }) {
  return {
    title: `${clientDisplayName}からの依頼`,
    situation: `作業台に、${type.id}に使う道具が種類ごとに並べて置かれている。`,
    motivation: `${clientDisplayName}が、会話を通じて相談に乗ってほしいと考えている。`,
    appeal: `ねえ、少しだけいいかな。${type.id}のことで手を貸してほしいんだ。あなたとなら落ち着いて話せそうだから、声をかけたんだよ。`
  };
}

// Resolves the offer-text generator for this request. The mock generator is used when
// ?provider=mock; otherwise the real generator resolves the LM config AND the world
// description LAZILY on first call, so a fresh-week fetch that returns persisted offers never
// touches either and a pure re-fetch cannot fail on an unconfigured LM or missing world.
function resolveOfferTextGenerator({ requestedProvider, resolveLmStudioConfig, resolveWorldDescription }) {
  if (requestedProvider === 'mock') {
    return async ({ type, clientDisplayName }) => mockErrandOfferText({ type, clientDisplayName });
  }
  if (typeof resolveLmStudioConfig !== 'function') throw new Error('resolveLmStudioConfig is required');
  if (typeof resolveWorldDescription !== 'function') throw new Error('resolveWorldDescription is required');
  let configPromise = null;
  let worldPromise = null;
  return async ({ type, clientDisplayName, persona, memories }) => {
    if (!configPromise) configPromise = resolveLmStudioConfig();
    if (!worldPromise) worldPromise = resolveWorldDescription();
    const [config, world] = await Promise.all([configPromise, worldPromise]);
    return generateErrandOfferText({ config, type, clientDisplayName, persona, memories, world });
  };
}

export async function handleErrandApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  resolveRuntimeProviders,
  resolveLmStudioConfig,
  runConversationOpening,
  startInteractionSession,
  activePlayMode
}) {
  if (!canHandleErrandApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const authoringRoot = context.root;
  const storage = createStorageApi({ root });

  if (req.method === 'GET' && url.pathname === '/api/errand') {
    const catalog = await loadErrandTypeCatalog({ root });
    const characters = await listSelectableCharacters({ root, authoringRoot });
    const generateOfferText = resolveOfferTextGenerator({
      requestedProvider: assertRecognizedRoutingProvider(url.searchParams.get('provider')),
      resolveLmStudioConfig,
      resolveWorldDescription: async () => {
        const world = await loadWorldSettings({ root });
        const description = String(world?.world_description ?? '').trim();
        if (!description) throw new Error('world_description is required for errand offer generation');
        return description;
      }
    });
    const { week, offers } = await buildOrLoadWeeklyErrandOffers({
      storage,
      catalog,
      characters,
      memoriesFor: (clientCharacterId) => storage.listJson(`game_data/characters/${clientCharacterId}/memory`),
      generateOfferText
    });
    const displayNameById = new Map(characters.map((character) => [character.character_id, character.display_name]));
    const publicOffers = offers.map((offer) => {
      const displayName = displayNameById.get(offer.client_character_id);
      if (!displayName) throw new Error(`errand client is not a selectable character: ${offer.client_character_id}`);
      return toPublicErrandOffer(offer, displayName);
    });
    return sendJson(res, { week, errands: publicOffers });
  }

  if (req.method === 'POST' && url.pathname === '/api/errand/start') {
    if (typeof resolveRuntimeProviders !== 'function') throw new Error('resolveRuntimeProviders is required');
    if (typeof runConversationOpening !== 'function') throw new Error('runConversationOpening is required');
    if (typeof startInteractionSession !== 'function') throw new Error('startInteractionSession is required');

    const body = await readBody(req);
    const requestedProvider = assertRecognizedRoutingProvider(body.provider);
    const errandId = requiredErrandId(body.errand_id);
    const state = await storage.readJson('game_data/runtime_state.json');
    const currentActiveErrand = readActiveRoutingErrand(state);
    if (currentActiveErrand) {
      throw statusError(`routing errand is already active: ${currentActiveErrand.conversation_id}`, 409, {
        errorCode: 'ROUTING_ERRAND_ALREADY_ACTIVE'
      });
    }
    // Start resolves ONLY from the persisted weekly slot; it never (re)generates. A missing
    // slot or a slot for a past week means the week's offers have not been fetched — the
    // caller must GET /api/errand first.
    const offers = readWeeklyErrandOffers(state);
    if (!offers) {
      throw statusError('weekly errand offers have not been generated yet', 409, { errorCode: 'ERRAND_OFFERS_NOT_READY' });
    }
    if (offers.week !== state.elapsed_weeks) {
      throw statusError(`weekly errand offers are stale: offers week ${offers.week} != current week ${state.elapsed_weeks}`, 409, {
        errorCode: 'ERRAND_OFFERS_NOT_READY'
      });
    }
    const offer = findPersistedErrandOffer({ offers, errandId });
    const client = await selectableCharacterChoice({ root, authoringRoot, characterId: offer.client_character_id });
    await ensureSelectableCharacterStorage({ root, authoringRoot, characterId: offer.client_character_id });

    const now = new Date().toISOString();
    const conversationId = makeErrandConversationId({
      now,
      week: offers.week,
      errandId: offer.errand_id,
      clientCharacterId: offer.client_character_id
    });
    const activeErrand = buildActiveRoutingErrand({
      offer,
      clientDisplayName: client.display_name,
      conversationId,
      week: offers.week,
      startedAt: now
    });
    await startInteractionSession({ root, characterId: offer.client_character_id });
    const providers = await resolveRuntimeProviders({ requestedProvider, context });
    const opening = await runConversationOpening({
      root,
      id: conversationId,
      characterId: offer.client_character_id,
      now,
      dungeonSceneContext: buildRoutingErrandSceneContext(activeErrand),
      ...providers
    });

    const stateAfterOpening = await storage.readJson('game_data/runtime_state.json');
    const nextState = {
      ...stateAfterOpening,
      current_screen: 'interaction',
      current_interaction_character_id: offer.client_character_id,
      last_conversation_id: conversationId,
      [ROUTING_ACTIVE_ERRAND_STATE_KEY]: activeErrand
    };
    await storage.writeJson('game_data/runtime_state.json', nextState);
    return sendJson(res, {
      ...opening,
      state: nextState,
      errand: toPublicErrandOffer(offer, client.display_name)
    });
  }

  return sendJson(res, { error: 'not found' }, 404);
}
