// 談話室 (lounge) HTTP surface: the routing-destination server routes for `lounge` → `academy-lounge`. It exposes
// the group-conversation lifecycle a 3 NPC + プレイヤー round talk needs — enter (fresh week slot / same-week
// re-entry), the per-utterance streamed NPC turn (SSE, 1 request = 1 scheduled speaker), the player's
// round-closing turn, and end (aggregate finalization + content result). It is a DEDICATED module, not optional
// fields mixed into the 1:1 conversation lifecycle/streaming API — the group cursor, speaker identity, and
// participant validation are a separate strict contract (upstream schema investigation Evidence 4).
//
// The persisted group record is the authoritative transcript + cursor: every request carries its cursor view and
// the server re-validates it against the record before generating, so a stale/duplicated client request fails
// fast instead of desyncing the round. There is NO reload resume — re-entering the same week starts a fresh
// conversation (same three participants via the week seed, new transcript); a save/load leaves any in-flight
// record abandoned (never finalized). Every LM-backed route resolves the LM config first so an unconfigured LM
// fails fast (503) with nothing generated (the errand/study/auction contract). All routes are routing-only.

import { resolvePostContentScreen } from '../playMode.mjs';
import { createStorageApi } from '../storage.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import {
  startLoungeGroupConversation,
  runLoungeGroupTurn,
  readLoungeGroupRecord,
  appendLoungePlayerTurn
} from '../llm/loungeGroupTurn.mjs';
import { currentLoungeSpeaker } from '../llm/loungeGroupRecord.mjs';
import { finalizeLoungeGroupConversationAtomic } from '../llm/loungeGroupFinalize.mjs';
import {
  ROUTING_ACTIVE_LOUNGE_STATE_KEY,
  buildActiveRoutingLounge,
  makeLoungeConversationId,
  readActiveRoutingLounge
} from '../routingLounge.mjs';
import { ROUTING_CONTENT_RESULT_STATE_KEY, buildLoungeContentResult } from '../routingContentResult.mjs';

const ROUTES = new Set([
  'POST /api/lounge/enter',
  'POST /api/lounge/utterance/stream',
  'POST /api/lounge/player-turn',
  'POST /api/lounge/end'
]);

const STREAM_ROUTES = new Set([
  'POST /api/lounge/utterance/stream'
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
    throw statusError('lounge content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

function requiredConversationId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw statusError('lounge conversation id is required', 400, { errorCode: 'LOUNGE_CONVERSATION_ID_REQUIRED' });
  return normalized;
}

function requiredContent(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw statusError('lounge player turn content is required', 400, { errorCode: 'LOUNGE_CONTENT_REQUIRED' });
  }
  return value.trim();
}

function integerField(value, label) {
  if (!Number.isInteger(value)) throw statusError(`lounge ${label} must be an integer`, 400, { errorCode: 'LOUNGE_CURSOR_FIELD_REQUIRED' });
  return value;
}

function requireLoungeWeek(state) {
  const week = state?.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw statusError('lounge requires state.elapsed_weeks to be a non-negative integer', 409, { errorCode: 'LOUNGE_WEEK_UNAVAILABLE' });
  }
  return week;
}

// The active-lounge pointer must be present and must name exactly the conversation the request targets. A request
// for any other id (or with no active lounge) fails fast — the client never drives a conversation the server does
// not consider active.
function assertActiveLoungeMatches(state, requestedId) {
  const active = readActiveRoutingLounge(state);
  if (!active) throw statusError('no active lounge conversation', 409, { errorCode: 'LOUNGE_NOT_ACTIVE' });
  const normalizedId = requiredConversationId(requestedId);
  if (active.conversation_id !== normalizedId) {
    throw statusError(`lounge conversation is not active: ${normalizedId}`, 409, { errorCode: 'LOUNGE_CONVERSATION_MISMATCH' });
  }
  return active;
}

// The request-carried cursor must match the persisted record's authoritative cursor exactly, and it must be an
// NPC's turn (not the player's). A mismatch is a stale/duplicated request or a client desync — fail fast rather
// than generate an utterance for the wrong speaker.
function assertUtteranceCursor(record, body) {
  const roundNumber = integerField(body.round_number, 'round_number');
  const nextSpeakerIndex = integerField(body.next_speaker_index, 'next_speaker_index');
  if (record.cursor.round_number !== roundNumber || record.cursor.next_speaker_index !== nextSpeakerIndex) {
    throw statusError(
      `lounge cursor mismatch: request round ${roundNumber}/index ${nextSpeakerIndex} != record round ${record.cursor.round_number}/index ${record.cursor.next_speaker_index}`,
      409,
      { errorCode: 'LOUNGE_CURSOR_MISMATCH' }
    );
  }
  if (!currentLoungeSpeaker(record)) {
    throw statusError('lounge turn is the player, not an NPC', 409, { errorCode: 'LOUNGE_NOT_NPC_TURN' });
  }
}

// The player's round-closing turn: the request cursor must match the record and it must actually be the player's
// turn (all of the round's NPCs have spoken). appendLoungePlayerMessage re-checks the record cursor at the write
// boundary, but this gives a clean request-shaped 409.
function assertPlayerTurnCursor(record, body) {
  const roundNumber = integerField(body.round_number, 'round_number');
  const nextSpeakerIndex = integerField(body.next_speaker_index, 'next_speaker_index');
  if (record.cursor.round_number !== roundNumber || record.cursor.next_speaker_index !== nextSpeakerIndex) {
    throw statusError(
      `lounge cursor mismatch: request round ${roundNumber}/index ${nextSpeakerIndex} != record round ${record.cursor.round_number}/index ${record.cursor.next_speaker_index}`,
      409,
      { errorCode: 'LOUNGE_CURSOR_MISMATCH' }
    );
  }
  if (currentLoungeSpeaker(record)) {
    throw statusError('lounge round still has an NPC to speak before the player', 409, { errorCode: 'LOUNGE_NOT_PLAYER_TURN' });
  }
}

// The frontend-facing conversation shape (the upstream contract the frontend task consumes). Speaker identity
// (`character_id` / `character_name`) is preserved on every assistant message and on `next_speaker`; the cursor is
// the two client-carried fields (round + next NPC index).
function loungeConversationView(record) {
  const speaker = currentLoungeSpeaker(record);
  return {
    id: record.id,
    week: record.week,
    location_name: record.location_name,
    visible_situation: record.visible_situation,
    participants: record.participants.map((participant) => ({
      character_id: participant.character_id,
      character_name: participant.character_name
    })),
    messages: record.messages.map((message) => (message.role === 'assistant'
      ? {
        role: 'assistant',
        character_id: message.character_id,
        character_name: message.character_name,
        content: message.content,
        expression: message.expression,
        face_emotion_variant_id: message.face_emotion_variant_id
      }
      : { role: 'user', content: message.content })),
    cursor: { round_number: record.cursor.round_number, next_speaker_index: record.cursor.next_speaker_index },
    next_speaker: speaker ? { character_id: speaker.character_id, character_name: speaker.character_name } : null
  };
}

function loungeClientErrorStatus(error) {
  if (error?.statusCode === 400 || error?.statusCode === 404 || error?.statusCode === 409) return error.statusCode;
  if (error?.statusCode === 503) return 503;
  return null;
}

function loungeErrorPayload(error) {
  return { error: error.message, ...(error.errorCode ? { error_code: error.errorCode } : {}) };
}

function sendLoungeError(res, sendJson, error) {
  const status = loungeClientErrorStatus(error);
  if (status === null) throw error;
  return sendJson(res, loungeErrorPayload(error), status);
}

export function canHandleLoungeApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// Streams one NPC utterance over SSE: opens the stream, notifies the chosen emotion FIRST (from the turn's
// onEmotion seam, which fires before the chat provider), then forwards each chat delta as assistant_delta, the
// completed content, and a result carrying the speaker identity and the advanced conversation view. The
// emotion-before-delta order lets the client fix the turn's face before the first bubble reveals, so a 括弧分割
// utterance renders every face row with the same emotion. There is NO post-generation assistant_emotion send. The
// LM config + the cursor were already validated as JSON before the stream opened, so an in-stream error here is a
// generation failure only.
async function runLoungeUtteranceStream({ res, openSse, sendSseEvent, generate }) {
  openSse(res);
  try {
    sendSseEvent(res, 'status', { phase: 'chat_started' });
    const result = await generate({
      onEmotion: (emotion) => sendSseEvent(res, 'assistant_emotion', {
        expression: emotion.expression,
        face_emotion_variant_id: emotion.face_emotion_variant_id
      }),
      onDelta: (delta) => sendSseEvent(res, 'assistant_delta', { delta })
    });
    sendSseEvent(res, 'assistant_complete', { content: result.content });
    sendSseEvent(res, 'result', {
      speaker: { character_id: result.speaker.character_id, character_name: result.speaker.character_name },
      emotion: {
        expression: result.emotion.expression,
        face_emotion_variant_id: result.emotion.face_emotion_variant_id
      },
      content: result.content,
      conversation: loungeConversationView(result.record)
    });
  } catch (error) {
    sendSseEvent(res, 'error', loungeErrorPayload(error));
  } finally {
    res.end();
  }
}

export async function handleLoungeApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode,
  resolveLmStudioConfig,
  resolveRuntimeProviders,
  resolveLoungeFinalizationProviders,
  openSse,
  sendSseEvent
}) {
  if (!canHandleLoungeApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const authoringRoot = context.root;
  const storage = createStorageApi({ root });
  const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });
  const route = `${req.method} ${url.pathname}`;

  // The one streamed route resolves the LM config (JSON 503) and validates the cursor (JSON 409) BEFORE opening
  // the SSE stream, so an unconfigured LM or a stale cursor is a clean JSON error, not an in-stream one.
  if (STREAM_ROUTES.has(route)) {
    const body = await readBody(req);
    const requestedProvider = assertRecognizedRoutingProvider(body.provider);
    let record;
    try {
      await resolveLmStudioConfig();
      const state = await storage.readJson('game_data/runtime_state.json');
      const active = assertActiveLoungeMatches(state, body.id);
      record = await readLoungeGroupRecord({ root, id: active.conversation_id });
      assertUtteranceCursor(record, body);
    } catch (error) {
      return sendLoungeError(res, sendJson, error);
    }
    return runLoungeUtteranceStream({
      res,
      openSse,
      sendSseEvent,
      generate: async ({ onEmotion, onDelta }) => {
        const providers = await resolveRuntimeProviders({ requestedProvider, context, onChatDelta: onDelta });
        return runLoungeGroupTurn({
          root,
          authoringRoot,
          id: record.id,
          chatProvider: providers.chatProvider,
          emotionProvider: providers.emotionProvider,
          characterSpeechConstraints: providers.characterSpeechConstraints,
          onEmotion
        });
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/lounge/enter') {
    const body = await readBody(req);
    assertRecognizedRoutingProvider(body.provider);
    try {
      // The participant + scene draw is LM-free, but every subsequent utterance needs the model, so gate the
      // whole session on a configured LM here (nothing is persisted before the gate passes).
      await resolveLmStudioConfig();
      const state = await storage.readJson('game_data/runtime_state.json');
      const week = requireLoungeWeek(state);
      const now = new Date().toISOString();
      // Always start FRESH: re-entering the same week reconstructs the same three participants (week seed) with a
      // new transcript and overwrites any prior active-lounge pointer. There is no resume of an in-flight record.
      const conversationId = makeLoungeConversationId({ now, week });
      const record = await startLoungeGroupConversation({ root, authoringRoot, id: conversationId, week });
      const nextState = {
        ...state,
        current_screen: 'academy-lounge',
        [ROUTING_ACTIVE_LOUNGE_STATE_KEY]: buildActiveRoutingLounge({ conversationId, week, startedAt: now })
      };
      await storage.writeJson('game_data/runtime_state.json', nextState);
      return sendJson(res, {
        conversation: loungeConversationView(record),
        state: nextState,
        post_content_screen: postContentScreen
      });
    } catch (error) {
      return sendLoungeError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/lounge/player-turn') {
    const body = await readBody(req);
    try {
      const state = await storage.readJson('game_data/runtime_state.json');
      const active = assertActiveLoungeMatches(state, body.id);
      const record = await readLoungeGroupRecord({ root, id: active.conversation_id });
      assertPlayerTurnCursor(record, body);
      const content = requiredContent(body.content);
      const nextRecord = await appendLoungePlayerTurn({ root, id: active.conversation_id, content });
      return sendJson(res, { conversation: loungeConversationView(nextRecord), state });
    } catch (error) {
      return sendLoungeError(res, sendJson, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/lounge/end') {
    const body = await readBody(req);
    try {
      if (typeof resolveLoungeFinalizationProviders !== 'function') throw new Error('resolveLoungeFinalizationProviders is required');
      const state = await storage.readJson('game_data/runtime_state.json');
      const active = assertActiveLoungeMatches(state, body.id);
      const now = new Date().toISOString();
      // Resolve the finalization providers (config resolution → 503 if unconfigured) before the atomic finalize.
      const finalizationProviders = await resolveLoungeFinalizationProviders();
      const finalization = await finalizeLoungeGroupConversationAtomic({
        root,
        conversationId: active.conversation_id,
        now,
        ...finalizationProviders
      });
      // Content result + interaction screen + active-pointer clear as the authoritative post-finalize write. The
      // aggregate finalization already promoted (transcript discarded, three participants finalized); this records
      // WHO the player talked with for the next hub entry and returns to the routing interaction screen.
      const contentResult = buildLoungeContentResult({
        week: finalization.record.week,
        now,
        participants: finalization.record.participants
      });
      const { [ROUTING_ACTIVE_LOUNGE_STATE_KEY]: _clearedActiveLounge, ...promotedState } = finalization.state;
      const nextState = {
        ...promotedState,
        current_screen: 'interaction',
        [ROUTING_CONTENT_RESULT_STATE_KEY]: contentResult
      };
      await storage.writeJson('game_data/runtime_state.json', nextState);
      return sendJson(res, {
        finalization_status: 'completed',
        lounge_result: contentResult.detail,
        transition: { next_screen: 'interaction' },
        post_content_screen: 'interaction',
        state: nextState
      });
    } catch (error) {
      return sendLoungeError(res, sendJson, error);
    }
  }

  return sendJson(res, { error: 'not found' }, 404);
}
