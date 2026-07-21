import { ensureSelectableCharacterStorage, publicCanonicalFaceUrl } from '../characterCatalog.mjs';
import { createStorageApi } from '../storage.mjs';
import { loadWorldSettings } from '../worldSettings.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import { generateStudyCircleOfferText } from '../llm/studyCircleOffer.mjs';
import { buildOrLoadWeeklyStudyCircleOffers } from '../routingStudyCircleOffers.mjs';
import { loadStudyCircleDefinitions } from '../studyCircleDefinitions.mjs';
import {
  ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY,
  buildActiveRoutingStudyCircle,
  buildRoutingStudyCircleSceneContext,
  findPersistedStudyCircleOffer,
  loadStudyCircleTypeCatalog,
  makeStudyCircleConversationId,
  readActiveRoutingStudyCircle,
  readWeeklyStudyCircleOffers,
  toPublicStudyCircleOffer
} from '../routingStudyCircle.mjs';
import { readActiveRoutingErrand } from '../routingErrands.mjs';

const ROUTES = new Set([
  'GET /api/study-circle',
  'POST /api/study-circle/start'
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
    throw statusError('study circle content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

function requiredThemeId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw statusError('theme_id is required', 400, { errorCode: 'STUDY_CIRCLE_THEME_ID_REQUIRED' });
  }
  return normalized;
}

export function canHandleStudyCircleApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// The mock provider produces deterministic, gate-clean offer text without touching the LLM
// (the ?provider=mock affordance for tests). It never embeds the type name, which may carry
// parentheses that the offer gate forbids; the type id (an ascii slug) is safe. The appeal
// is the own-voice invitation (persona is ignored by the mock — it is deterministic).
function mockStudyCircleOfferText({ type, hostDisplayName }) {
  return {
    title: `${hostDisplayName}の研究会`,
    situation: `実習台に、${type.id}の支度が種類ごとに並べて置かれている。`,
    motivation: `${hostDisplayName}が、会話を通じてこの研究会に付き合ってほしいと考えている。`,
    appeal: `ねえ、少し時間はあるかな。${type.id}の研究会を開くから、あなたにも一緒に来てほしいんだ。あなたとなら楽しくやれそうだと思って、声をかけたんだよ。`
  };
}

// Resolves the offer-text generator for this request. The mock generator is used when
// ?provider=mock; otherwise the real generator resolves the LM config AND the world
// description LAZILY on first call, so a fresh-week fetch that returns persisted offers never
// touches either and a pure re-fetch cannot fail on an unconfigured LM or missing world.
function resolveOfferTextGenerator({ requestedProvider, resolveLmStudioConfig, resolveWorldDescription }) {
  if (requestedProvider === 'mock') {
    return async ({ type, hostDisplayName }) => mockStudyCircleOfferText({ type, hostDisplayName });
  }
  if (typeof resolveLmStudioConfig !== 'function') throw new Error('resolveLmStudioConfig is required');
  if (typeof resolveWorldDescription !== 'function') throw new Error('resolveWorldDescription is required');
  let configPromise = null;
  let worldPromise = null;
  return async ({ type, hostDisplayName, persona, memories }) => {
    if (!configPromise) configPromise = resolveLmStudioConfig();
    if (!worldPromise) worldPromise = resolveWorldDescription();
    const [config, world] = await Promise.all([configPromise, worldPromise]);
    return generateStudyCircleOfferText({ config, type, hostDisplayName, persona, memories, world });
  };
}

// Resolves the host persona (name / standing / character description / speaking basis) the
// character-fit skeleton and the own-voice appeal need. The host profile is read through
// ensureSelectableCharacterStorage (the same materialize path decorateStudyCircleOffer already
// runs for every offer at GET time, whose prompt_description is the sanitized conversation
// version), so this adds no new side effect beyond the existing per-GET host materialization.
async function studyCircleHostPersona({ root, authoringRoot, hostCharacterId }) {
  const { profile } = await ensureSelectableCharacterStorage({ root, authoringRoot, characterId: hostCharacterId });
  return {
    display_name: profile.display_name,
    school_year: profile.school_year,
    identity: profile.identity,
    prompt_description: profile.prompt_description,
    speaking_basis: profile.speaking_basis
  };
}

// Decorates a public offer with the host's server-resolved face url. host_display_name is
// already carried on the persisted offer; the visual_set_id / face url is resolved here.
async function decorateStudyCircleOffer({ root, authoringRoot, offer }) {
  const { profile } = await ensureSelectableCharacterStorage({
    root,
    authoringRoot,
    characterId: offer.host_character_id
  });
  const visualSetId = String(profile.visual_set_id ?? '').trim();
  if (!visualSetId) throw new Error(`study circle host visual_set_id is required: ${offer.host_character_id}`);
  const faceUrl = publicCanonicalFaceUrl(visualSetId, 'neutral');
  return {
    ...offer,
    host_visual_set_id: visualSetId,
    host_face_url: faceUrl,
    host_selection_icon_url: faceUrl
  };
}

export async function handleStudyCircleApi({
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
  if (!canHandleStudyCircleApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const authoringRoot = context.root;
  const storage = createStorageApi({ root });

  if (req.method === 'GET' && url.pathname === '/api/study-circle') {
    const catalog = await loadStudyCircleTypeCatalog({ root });
    const definitions = await loadStudyCircleDefinitions({ root });
    const generateOfferText = resolveOfferTextGenerator({
      requestedProvider: assertRecognizedRoutingProvider(url.searchParams.get('provider')),
      resolveLmStudioConfig,
      resolveWorldDescription: async () => {
        const world = await loadWorldSettings({ root });
        const description = String(world?.world_description ?? '').trim();
        if (!description) throw new Error('world_description is required for study circle offer generation');
        return description;
      }
    });
    const { week, offers } = await buildOrLoadWeeklyStudyCircleOffers({
      storage,
      catalog,
      definitions,
      memoriesFor: (hostCharacterId) => storage.listJson(`game_data/characters/${hostCharacterId}/memory`),
      personaFor: (hostCharacterId) => studyCircleHostPersona({ root, authoringRoot, hostCharacterId }),
      generateOfferText
    });
    const decoratedOffers = await Promise.all(
      offers.map((offer) => decorateStudyCircleOffer({ root, authoringRoot, offer: toPublicStudyCircleOffer(offer) }))
    );
    return sendJson(res, { week, offers: decoratedOffers });
  }

  if (req.method === 'POST' && url.pathname === '/api/study-circle/start') {
    if (typeof resolveRuntimeProviders !== 'function') throw new Error('resolveRuntimeProviders is required');
    if (typeof runConversationOpening !== 'function') throw new Error('runConversationOpening is required');
    if (typeof startInteractionSession !== 'function') throw new Error('startInteractionSession is required');

    const body = await readBody(req);
    const requestedProvider = assertRecognizedRoutingProvider(body.provider);
    const themeId = requiredThemeId(body.theme_id);
    const state = await storage.readJson('game_data/runtime_state.json');
    const currentActiveStudyCircle = readActiveRoutingStudyCircle(state);
    if (currentActiveStudyCircle) {
      throw statusError(`routing study circle is already active: ${currentActiveStudyCircle.conversation_id}`, 409, {
        errorCode: 'ROUTING_STUDY_CIRCLE_ALREADY_ACTIVE'
      });
    }
    const currentActiveErrand = readActiveRoutingErrand(state);
    if (currentActiveErrand) {
      throw statusError(`routing errand is already active: ${currentActiveErrand.conversation_id}`, 409, {
        errorCode: 'ROUTING_ERRAND_ALREADY_ACTIVE'
      });
    }
    // Start resolves ONLY from the persisted weekly slot; it never (re)generates. A missing
    // slot or a slot for a past week means the week's offers have not been fetched — the
    // caller must GET /api/study-circle first.
    const offers = readWeeklyStudyCircleOffers(state);
    if (!offers) {
      throw statusError('weekly study circle offers have not been generated yet', 409, { errorCode: 'STUDY_CIRCLE_OFFERS_NOT_READY' });
    }
    if (offers.week !== state.elapsed_weeks) {
      throw statusError(`weekly study circle offers are stale: offers week ${offers.week} != current week ${state.elapsed_weeks}`, 409, {
        errorCode: 'STUDY_CIRCLE_OFFERS_NOT_READY'
      });
    }
    const offer = findPersistedStudyCircleOffer({ offers, themeId });
    // decorateStudyCircleOffer already runs ensureSelectableCharacterStorage for the host, so
    // the host's runtime storage is materialized before the conversation opening below.
    const decoratedOffer = await decorateStudyCircleOffer({ root, authoringRoot, offer: toPublicStudyCircleOffer(offer) });

    const now = new Date().toISOString();
    const conversationId = makeStudyCircleConversationId({
      now,
      week: offers.week,
      themeId: offer.theme_id,
      hostCharacterId: offer.host_character_id
    });
    const activeStudyCircle = buildActiveRoutingStudyCircle({
      offer,
      conversationId,
      week: offers.week,
      startedAt: now
    });
    await startInteractionSession({ root, characterId: offer.host_character_id });
    const providers = await resolveRuntimeProviders({ requestedProvider, context });
    const opening = await runConversationOpening({
      root,
      id: conversationId,
      characterId: offer.host_character_id,
      now,
      dungeonSceneContext: buildRoutingStudyCircleSceneContext(activeStudyCircle),
      ...providers
    });

    const stateAfterOpening = await storage.readJson('game_data/runtime_state.json');
    const nextState = {
      ...stateAfterOpening,
      current_screen: 'interaction',
      current_interaction_character_id: offer.host_character_id,
      last_conversation_id: conversationId,
      [ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY]: activeStudyCircle
    };
    await storage.writeJson('game_data/runtime_state.json', nextState);
    return sendJson(res, {
      ...opening,
      state: nextState,
      study_circle: decoratedOffer
    });
  }

  return sendJson(res, { error: 'not found' }, 404);
}
