// 星見の窓 (overlook) HTTP surface over the feature owner (routingOverlook.mjs). Every route requires routing
// mode (409 ROUTING_MODE_REQUIRED) and, except enter, an active entry session of the slot (409
// OVERLOOK_NOT_ACTIVE).
//   POST /api/overlook/enter                     {} (?provider=mock)  → { field, places, post_content_screen }
//   GET  /api/overlook/field                                          → { field }
//   POST /api/overlook/focus                     { encounter_id }     → { focus, field }
//   GET  /api/overlook/conversation?conversation_id=<id>              → { conversation }
//   POST /api/overlook/conversation/next         { conversation_id }  → SSE: assistant_delta* → message | error
//   POST /api/overlook/conversation/return       { conversation_id }  → { field }
//   POST /api/overlook/writings                  { place_id, text }   → { writing, field }
//   POST /api/overlook/roster/swap               { character_id }     → { swap: { leaving, arriving }, field }
//   POST /api/overlook/exit                      {}                   → { content_result, post_content_screen }
// Enter resolves the LM config first (an unconfigured LM is a JSON 503 with nothing drawn or persisted) and binds
// the session's generators; the provider seam (?provider=mock) exists on enter only. A session whose LM work
// failed rethrows that failure on every route (the LM 503 the client routes to the settings screen). The next
// route validates before the stream opens; once open, a failure closes it with an `error` event.

import { resolvePostContentScreen } from '../playMode.mjs';
import { createStorageApi } from '../storage.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import { resolveCharacterSpeechConstraints } from '../llm/characterSpeechConstraints.mjs';
import { createOverlookGenerators } from '../llm/overlookGeneration.mjs';
import { errorResponsePayload } from './lmStudioSettingsApi.mjs';
import {
  assertNextOverlookLineAllowed,
  enterOverlook,
  exitOverlook,
  overlookConversationViewFor,
  overlookFieldView,
  pickOverlookFocus,
  requireOverlookSession,
  returnFromOverlookConversation,
  sendOffOverlookChild,
  showNextOverlookLine,
  writeOverlookLine
} from '../routingOverlook.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

const ROUTE_BODY_KEYS = Object.freeze({
  'POST /api/overlook/enter': [],
  'GET /api/overlook/field': null,
  'POST /api/overlook/focus': ['encounter_id'],
  'GET /api/overlook/conversation': null,
  'POST /api/overlook/conversation/next': ['conversation_id'],
  'POST /api/overlook/conversation/return': ['conversation_id'],
  'POST /api/overlook/writings': ['place_id', 'text'],
  'POST /api/overlook/roster/swap': ['character_id'],
  'POST /api/overlook/exit': []
});

function statusError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

export function canHandleOverlookApiRoute(method, pathname) {
  return Object.prototype.hasOwnProperty.call(ROUTE_BODY_KEYS, `${method} ${pathname}`);
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') throw statusError('overlook content requires routing mode', 409, 'ROUTING_MODE_REQUIRED');
}

// A body is closed to the route's keys: a missing key and an extra key are both refused.
function assertBody(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw statusError('request body must be an object', 400, 'OVERLOOK_BODY_INVALID');
  const unexpected = Object.keys(body).filter((key) => !keys.includes(key));
  if (unexpected.length) throw statusError(`unexpected body key(s) for this route: ${unexpected.join(', ')}`, 400, 'OVERLOOK_BODY_UNEXPECTED_KEY');
  for (const key of keys) {
    if (typeof body[key] !== 'string' || !body[key].trim()) throw statusError(`${key} must be a non-empty string`, 400, 'OVERLOOK_BODY_FIELD_REQUIRED');
  }
  return body;
}

// The provider seam is enter's query string only; on any other route it is a caller believing in an affordance
// the route does not have.
function assertProviderQuery(url, route) {
  const provider = url.searchParams.get('provider');
  if (route === 'POST /api/overlook/enter') return assertRecognizedRoutingProvider(provider);
  if (provider !== null) throw statusError('provider is fixed when the session is entered', 400, 'OVERLOOK_PROVIDER_FIXED_AT_ENTER');
  return null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Deterministic, gate-clean generators with no LM call (the ?provider=mock affordance for tests and the UI).
export function mockOverlookGenerators() {
  const keepState = (state, partnerName) => ({
    feeling_label: '関心',
    feeling_text: `${partnerName}のことが少し気になる`,
    concerns: state.concerns.map((concern) => concern.text),
    mood: state.mood
  });
  return {
    decideWish: async ({ child, trigger, roster, places }) => {
      const others = roster.filter((entry) => entry.id !== child.id);
      const actions = ['会う', '探す', '籠もる', '確かめる', '避ける'];
      const hash = stableHash(`${child.id}:${trigger.kind}`);
      const action = actions[hash % actions.length];
      if (action === '籠もる' || action === '確かめる') {
        const place = places[hash % places.length];
        return { action, target: { kind: 'place', id: place.id }, line: `${place.name}で過ごしたい` };
      }
      const other = others[hash % others.length];
      return { action, target: { kind: 'child', id: other.id }, line: `${other.name}のことが気になる` };
    },
    generateSeed: async ({ initiator, partner }) => ({ line: `${initiator.name}が${partner.name}に気づいて足を止めた。` }),
    generateUtterance: async ({ speaker, partner, onDelta }) => {
      const content = `${partner.name}、少し話せる？（${speaker.name}は小さく手を振った）`;
      onDelta?.(content);
      return { content, emotion: { expression: 'neutral', face_emotion_variant_id: 'face_neutral' } };
    },
    judgeOutcome: async ({ history, initiatorWish, partner }) => (history.length >= 4 ? (initiatorWish?.target.kind === 'child' && initiatorWish.target.id !== partner.id ? '別の決着' : '果たされた') : '続く'),
    judgeStagnation: async () => false,
    rewriteState: async ({ state, partner }) => keepState(state, partner.name),
    resolveOffscreen: async ({ initiator, partner, states }) => ({
      seed: `${initiator.name}が${partner.name}に気づいて足を止めた。`,
      outcome: '別の決着',
      trace: `${initiator.name}が、${partner.name}と話し込んだ`,
      initiator: keepState(states[initiator.id], partner.name),
      partner: keepState(states[partner.id], initiator.name)
    })
  };
}

async function realOverlookGenerators({ root, resolveLmStudioConfig }) {
  const config = await resolveLmStudioConfig();
  const characterSpeechConstraints = await resolveCharacterSpeechConstraints({ root, chatModel: config.chat_model });
  return createOverlookGenerators({ config, characterSpeechConstraints });
}

function writingPayload(writing) {
  return { writing_id: writing.id, place_id: writing.place_id, text: writing.text };
}

async function streamNextLine({ res, openSse, sendSseEvent, session, conversationId }) {
  openSse(res);
  try {
    const conversation = await showNextOverlookLine(session, {
      conversationId,
      onDelta: (delta) => sendSseEvent(res, 'assistant_delta', { delta })
    });
    sendSseEvent(res, 'message', { conversation });
  } catch (error) {
    sendSseEvent(res, 'error', errorResponsePayload(error));
  } finally {
    res.end();
  }
}

export async function handleOverlookApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode,
  resolveLmStudioConfig,
  clock,
  openSse,
  sendSseEvent
}) {
  const route = `${req.method} ${url.pathname}`;
  if (!canHandleOverlookApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const provider = assertProviderQuery(url, route);
  const keys = ROUTE_BODY_KEYS[route];
  const body = keys === null ? null : assertBody(await readBody(req), keys);
  const root = context.activeRoot ?? context.root;
  const storage = createStorageApi({ root });

  if (route === 'POST /api/overlook/enter') {
    const generators = provider === 'mock' ? mockOverlookGenerators() : await realOverlookGenerators({ root, resolveLmStudioConfig });
    const state = await storage.readJson(RUNTIME_STATE_PATH);
    const session = await enterOverlook({ root, authoringRoot: context.root, storage, state, generators, clock });
    // The 24 places ride on enter only (they never move): map px position, the normalized radius as authored,
    // and the locations.json display name. The field poll does not repeat them.
    const places = session.graph.places.map((place) => ({
      place_id: place.location_id,
      name: session.placeNames.get(place.location_id),
      x: place.x,
      y: place.y,
      radius: place.radius
    }));
    return sendJson(res, {
      field: overlookFieldView(session),
      places,
      post_content_screen: resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' })
    });
  }

  const session = requireOverlookSession(root);

  if (route === 'GET /api/overlook/field') return sendJson(res, { field: overlookFieldView(session) });

  if (route === 'POST /api/overlook/focus') {
    const focus = pickOverlookFocus(session, { encounterId: body.encounter_id });
    return sendJson(res, { focus: { encounter_id: focus.encounter_id, source: focus.source }, field: overlookFieldView(session) });
  }

  if (route === 'GET /api/overlook/conversation') {
    const conversationId = url.searchParams.get('conversation_id');
    if (!conversationId) throw statusError('conversation_id is required', 400, 'OVERLOOK_BODY_FIELD_REQUIRED');
    return sendJson(res, { conversation: overlookConversationViewFor(session, conversationId) });
  }

  if (route === 'POST /api/overlook/conversation/next') {
    // Validates the conversation before the stream opens (404 / 409 as JSON).
    assertNextOverlookLineAllowed(session, { conversationId: body.conversation_id });
    return streamNextLine({ res, openSse, sendSseEvent, session, conversationId: body.conversation_id });
  }

  if (route === 'POST /api/overlook/conversation/return') {
    returnFromOverlookConversation(session, { conversationId: body.conversation_id });
    return sendJson(res, { field: overlookFieldView(session) });
  }

  if (route === 'POST /api/overlook/writings') {
    try {
      const writing = writeOverlookLine(session, { placeId: body.place_id, text: body.text });
      return sendJson(res, { writing: writingPayload(writing), field: overlookFieldView(session) });
    } catch (error) {
      if (error.errorCode !== 'OVERLOOK_WRITING_LIMITED') throw error;
      return sendJson(res, { ...errorResponsePayload(error), next_available_at: error.nextAvailableAt }, 409);
    }
  }

  if (route === 'POST /api/overlook/roster/swap') {
    const swap = sendOffOverlookChild(session, { characterId: body.character_id });
    return sendJson(res, { swap, field: overlookFieldView(session) });
  }

  // POST /api/overlook/exit
  const contentResult = await exitOverlook(session, { now: new Date(clock.now()).toISOString() });
  return sendJson(res, {
    content_result: contentResult,
    post_content_screen: resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' })
  });
}
