// 談話室 (lounge) HTTP surface: exercises handleLoungeApi directly with fake req/res + sendJson / openSse /
// sendSseEvent / readBody spies over a real per-slot fixture root. Pins the routing-mode gate, the
// resolve-config-before-SSE / before-work discipline (LM未設定 503), the enter fresh-start + active pointer, the
// same-week re-entry restart (no resume), the per-utterance cursor re-validation + SSE speaker identity, the
// player round-closing turn, and the end → aggregate finalization + content result + interaction screen. It also
// pins the routing registration (catalog candidate + dispatch target) and the lounge content-result build/render.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectRoot } from './testPaths.mjs';
import { writeRuntimePathsManifest } from '../src/runtimeSlotBootstrap.mjs';
import {
  handleLoungeApi,
  canHandleLoungeApiRoute,
  createLoungeCompletionHelper
} from '../src/server/loungeApi.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { routingDestinations } from '../src/routingDestinations.mjs';
import { resolveRoutingDestinationDispatch } from '../src/routingDispatch.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';
import { buildLoungeContentResult, validateRoutingContentResult } from '../src/routingContentResult.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import { readActiveRoutingLounge } from '../src/routingLounge.mjs';

const CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'm', reflection_model: 'm', timeout_ms: 5000, stream: true };

function lmUnconfiguredError() {
  const error = new Error('LM Studioの設定が必要です。');
  error.statusCode = 503;
  error.errorCode = 'LMSTUDIO_CONFIG_REQUIRED';
  return error;
}

// Deterministic turn providers (chat streams two deltas, emotion is fixed). The chatProvider closes over the
// onChatDelta the handler passes into resolveRuntimeProviders, mirroring how createLmStudioProviders bakes the
// stream callback into the chat provider in production. The v2 group-turn seam also runs a per-speaker
// continuation judgment (default: `true` — stay) after the normal utterance, and only calls the cutoff provider
// when a test opts a speaker into departure by pinning `continuationAnswer: 'false'`.
function turnProviders({ onChatDelta, continuationAnswer = 'true', departureText = 'それじゃあ、また明日。' } = {}) {
  return {
    chatProvider: async () => {
      if (onChatDelta) {
        onChatDelta('やあ、');
        onChatDelta('よく来たね。');
      }
      return 'やあ、よく来たね。';
    },
    emotionProvider: async () => ({ expression: 'joy' }),
    conversationContinuationProvider: async () => continuationAnswer,
    conversationCutoffProvider: async () => departureText,
    characterSpeechConstraints: []
  };
}

// Deterministic finalization providers (skill necessity false → no skill record; memory/work-record minimal;
// affinity fixed +3), matching the shape the aggregate lounge finalizer consumes per participant.
function finalizationProviders() {
  return {
    memoryUpdateProvider: async ({ participant, workRecordId }) => ({
      memory_record: {
        id: `mem_${workRecordId}`,
        character_id: participant.character_id,
        type: 'relationship_change',
        text: `${participant.character_name}は談話室で主人公と言葉を交わした。`,
        tags: [participant.character_id]
      }
    }),
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    skillUpdateProvider: async () => { throw new Error('skillUpdateProvider must not run when necessity is false'); },
    workRecordProvider: async ({ participant, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: participant.character_id,
        title: `${participant.character_name}の談話`,
        summary: '談話室で言葉を交わした。',
        flag_update_candidates: [],
        warnings: []
      }
    }),
    affinityDeltaProvider: async () => '3'
  };
}

// Builds the `<playRoot>/slots/slot_001/game_data` slot layout the atomic finalizer resolves through, with the
// manifest pointing content/definitions at the real repo so the roster / profiles / lounge scenes load.
async function slotLoungeRoot(t, { elapsedWeeks = 3 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-lounge-api-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const playRoot = path.join(base, 'play');
  const slotRoot = path.join(playRoot, 'slots', 'slot_001');
  const slotGameData = path.join(slotRoot, 'game_data');
  await fs.mkdir(slotGameData, { recursive: true });
  await fs.writeFile(path.join(slotGameData, 'runtime_state.json'), `${JSON.stringify({
    version: 1,
    current_screen: 'academy-lounge',
    current_location_id: 'herbology_garden',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: elapsedWeeks
  }, null, 2)}\n`, 'utf8');
  await writeRuntimePathsManifest({ root: slotRoot, sourceRoot: projectRoot, mutableRoot: slotGameData });
  await writeRuntimePathsManifest({ root: playRoot, sourceRoot: projectRoot, mutableRoot: slotGameData });
  await fs.writeFile(path.join(playRoot, 'active_slot.json'), `${JSON.stringify({ slot_id: 'slot_001' }, null, 2)}\n`, 'utf8');
  return { playRoot, slotGameData };
}

// Invokes handleLoungeApi with spies. Returns recorded JSON responses, SSE activity, and any thrown error.
async function callHandler({
  method,
  pathname,
  body = {},
  playRoot,
  mode = 'routing',
  resolveLmStudioConfig = async () => CONFIG,
  resolveRuntimeProviders = async (args) => turnProviders(args),
  resolveLoungeFinalizationProviders = async () => finalizationProviders()
}) {
  const jsonCalls = [];
  const sseEvents = [];
  let openSseCount = 0;
  const args = {
    req: { method },
    res: { end() {} },
    url: { pathname },
    context: { root: playRoot, activeRoot: playRoot },
    sendJson: (_res, value, status = 200) => jsonCalls.push({ value, status }),
    readBody: async () => body,
    activePlayMode: { mode },
    resolveLmStudioConfig,
    resolveRuntimeProviders,
    resolveLoungeFinalizationProviders,
    openSse: () => { openSseCount += 1; },
    sendSseEvent: (_res, event, data) => sseEvents.push({ event, data })
  };
  let threw = null;
  let handled;
  try {
    handled = await handleLoungeApi(args);
  } catch (error) {
    threw = error;
  }
  return { jsonCalls, sseEvents, openSseCount, threw, handled };
}

async function enter(playRoot) {
  const { jsonCalls } = await callHandler({ method: 'POST', pathname: '/api/lounge/enter', playRoot });
  assert.equal(jsonCalls.length, 1);
  assert.equal(jsonCalls[0].status, 200);
  return jsonCalls[0].value;
}

// Drives one NPC utterance through the SSE route, asserting the event sequence and returning the `result` payload.
async function utter(playRoot, conversation) {
  const { jsonCalls, sseEvents, openSseCount } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index }
  });
  assert.equal(jsonCalls.length, 0, 'a valid utterance streams (no JSON error)');
  assert.equal(openSseCount, 1, 'the SSE stream opened');
  const names = sseEvents.map((event) => event.event);
  assert.deepEqual(names.slice(0, 1), ['status']);
  assert.ok(names.includes('assistant_delta'), 'chat deltas streamed');
  assert.ok(names.includes('assistant_emotion'), 'the chosen emotion streamed');
  // Emotion-before-delta is the invariant even though turnProviders streams its deltas synchronously inside the
  // chat provider: the emotion is notified from the onEmotion seam, which fires before the chat provider runs.
  assert.ok(names.indexOf('assistant_emotion') < names.indexOf('assistant_delta'), 'the emotion is notified before the first chat delta');
  assert.equal(names.at(-1), 'result', 'the terminal event is result');
  return sseEvents.find((event) => event.event === 'result').data;
}

// ---- routing registration ----

test('the lounge destination is a non-gated catalog candidate labelled 談話室', () => {
  const lounge = routingDestinations.find((destination) => destination.id === 'lounge');
  assert.ok(lounge, 'the catalog carries a lounge destination');
  assert.equal(lounge.label, '談話室');
  // It is in the candidate set the destination-selection gate offers ルミ (non-gated → present with no unlocks).
  const candidates = routingDestinationsForState({ elapsed_weeks: 3 });
  assert.ok(candidates.some((destination) => destination.id === 'lounge'), 'lounge is a routing candidate');
});

test('the lounge destination dispatches to the academy-lounge screen (week-progressing normal destination)', () => {
  const dispatch = resolveRoutingDestinationDispatch('lounge');
  assert.equal(dispatch.destination_id, 'lounge');
  assert.equal(dispatch.next_screen, 'academy-lounge');
  assert.equal(dispatch.transition.next_screen, 'academy-lounge');
});

// ---- content result build + hub render ----

test('buildLoungeContentResult produces a valid lounge content result and the hub renders it', () => {
  const participants = [
    { character_id: 'character_001', character_name: 'アリア' },
    { character_id: 'character_002', character_name: 'ベル' },
    { character_id: 'character_003', character_name: 'カイ' }
  ];
  const result = buildLoungeContentResult({ week: 4, now: '2026-07-17T00:00:00.000Z', participants });
  assert.equal(result.kind, 'lounge');
  assert.equal(result.destination_id, 'lounge');
  assert.equal(result.trigger, 'lounge_concluded');
  assert.deepEqual(result.detail.participants, participants);
  // Re-validates through the closed vocabulary (kind added to CONTENT_KINDS).
  assert.doesNotThrow(() => validateRoutingContentResult(result));
  // A duplicate / wrong-count participant set fails fast.
  assert.throws(() => buildLoungeContentResult({ week: 4, now: '2026-07-17T00:00:00.000Z', participants: participants.slice(0, 2) }), /exactly 3 participants/);

  // The hub context renderer has an explicit lounge branch (no desync throw) and names the三人.
  const rendered = buildRoutingMetaContext({
    state: { elapsed_weeks: 4 },
    routingHubContext: {
      persona_variant: 'fallen_star',
      recent_conversation_context: { kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null },
      relationship_context: { buddy: null, enemies: [] },
      alchemy_context: { recipe_count: 8 },
      study_circle_context: { theme_count: 1, weekly_offer_count: 3 },
      content_result_context: { record: result, companion: null }
    }
  });
  assert.ok(rendered.includes('談話室'), 'the hub context mentions the lounge');
  assert.ok(rendered.includes('アリア') && rendered.includes('ベル') && rendered.includes('カイ'), 'the hub context names the three participants');
});

// ---- route-match / gate ----

test('canHandleLoungeApiRoute matches exactly the four lounge routes', () => {
  assert.equal(canHandleLoungeApiRoute('POST', '/api/lounge/enter'), true);
  assert.equal(canHandleLoungeApiRoute('POST', '/api/lounge/utterance/stream'), true);
  assert.equal(canHandleLoungeApiRoute('POST', '/api/lounge/player-turn'), true);
  assert.equal(canHandleLoungeApiRoute('POST', '/api/lounge/end'), true);
  assert.equal(canHandleLoungeApiRoute('GET', '/api/lounge/enter'), false);
  assert.equal(canHandleLoungeApiRoute('POST', '/api/lounge/unknown'), false);
});

test('an unhandled method/path returns false (dispatch falls through, no hang)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { handled } = await callHandler({ method: 'GET', pathname: '/api/lounge/state', playRoot });
  assert.equal(handled, false);
});

test('the lounge routes require routing mode (loop is rejected 409)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { threw } = await callHandler({ method: 'POST', pathname: '/api/lounge/enter', playRoot, mode: 'loop' });
  assert.equal(threw?.statusCode, 409);
  assert.equal(threw?.errorCode, 'ROUTING_MODE_REQUIRED');
});

test('enter fails fast 503 with nothing persisted when the LM is unconfigured', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t);
  const { jsonCalls } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/enter',
    playRoot,
    resolveLmStudioConfig: async () => { throw lmUnconfiguredError(); }
  });
  assert.equal(jsonCalls[0].status, 503);
  const state = JSON.parse(await fs.readFile(path.join(slotGameData, 'runtime_state.json'), 'utf8'));
  assert.equal(readActiveRoutingLounge(state), null, 'no active lounge pointer was written');
});

test('the utterance stream resolves the LM config as JSON 503 before opening the SSE stream', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const conversation = await enter(playRoot);
  const { jsonCalls, openSseCount } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: 1, next_speaker_index: 0 },
    resolveLmStudioConfig: async () => { throw lmUnconfiguredError(); }
  });
  assert.equal(openSseCount, 0, 'the stream never opened');
  assert.equal(jsonCalls[0].status, 503);
});

// ---- enter / fresh start ----

test('enter seats three participants, sets the active pointer, and screens to academy-lounge', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t, { elapsedWeeks: 5 });
  const value = await enter(playRoot);
  assert.equal(value.conversation.week, 5);
  assert.equal(value.conversation.location_name, '寮の談話室');
  assert.equal(value.conversation.participants.length, 3);
  assert.equal(value.conversation.messages.length, 0);
  assert.equal(value.conversation.cursor.round_number, 1);
  assert.equal(value.conversation.cursor.next_speaker_index, 0);
  assert.ok(value.conversation.next_speaker.character_id, 'the first NPC speaker is named');
  assert.equal(value.post_content_screen, 'interaction');

  const state = JSON.parse(await fs.readFile(path.join(slotGameData, 'runtime_state.json'), 'utf8'));
  assert.equal(state.current_screen, 'academy-lounge');
  const active = readActiveRoutingLounge(state);
  assert.equal(active.conversation_id, value.conversation.id);
  assert.equal(active.week, 5);
});

test('re-entering the same week restarts fresh (same three participants, new id, empty transcript — no resume)', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t, { elapsedWeeks: 5 });
  const first = await enter(playRoot);
  // Advance the first conversation by one NPC utterance so it has an in-flight transcript.
  await utter(playRoot, first.conversation);
  const firstRecord = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${first.conversation.id}.json`), 'utf8'));
  assert.equal(firstRecord.messages.length, 1, 'the first conversation is in-flight');

  const second = await enter(playRoot);
  assert.notEqual(second.conversation.id, first.conversation.id, 're-entry mints a new conversation id');
  assert.equal(second.conversation.messages.length, 0, 're-entry starts a fresh transcript (no resume)');
  assert.deepEqual(
    second.conversation.participants,
    first.conversation.participants,
    'the same week seats the same three participants'
  );
  const active = readActiveRoutingLounge(JSON.parse(await fs.readFile(path.join(slotGameData, 'runtime_state.json'), 'utf8')));
  assert.equal(active.conversation_id, second.conversation.id, 'the active pointer now names the fresh conversation');
});

// ---- utterance cursor discipline ----

test('an utterance generates one NPC turn and the SSE result carries the speaker identity', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const result = await utter(playRoot, conversation);
  assert.equal(result.speaker.character_id, conversation.next_speaker.character_id);
  assert.equal(result.speaker.character_name, conversation.next_speaker.character_name);
  assert.equal(result.emotion.expression, 'joy');
  const assistantMessages = result.conversation.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].character_id, conversation.next_speaker.character_id);
  assert.equal(assistantMessages[0].character_name, conversation.next_speaker.character_name);
  assert.equal(result.conversation.cursor.next_speaker_index, 1, 'the cursor advanced to the next NPC');
});

test('the utterance SSE fixes the whole event order emotion < first delta < complete < result (synchronous delta provider)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const { sseEvents } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index }
  });
  const names = sseEvents.map((event) => event.event);
  // status first, exactly one assistant_emotion, then the deltas, then complete, then result — the terminal order.
  assert.equal(names[0], 'status');
  assert.equal(names.filter((name) => name === 'assistant_emotion').length, 1, 'assistant_emotion is sent exactly once');
  const emotionAt = names.indexOf('assistant_emotion');
  const firstDeltaAt = names.indexOf('assistant_delta');
  const completeAt = names.indexOf('assistant_complete');
  const resultAt = names.indexOf('result');
  assert.ok(emotionAt < firstDeltaAt, 'emotion precedes the first delta');
  assert.ok(firstDeltaAt < completeAt, 'the first delta precedes assistant_complete');
  assert.ok(completeAt < resultAt, 'assistant_complete precedes result');
  assert.equal(resultAt, names.length - 1, 'result is the terminal event');
  // No delayed emotion send: assistant_emotion never appears after a delta.
  assert.ok(names.lastIndexOf('assistant_emotion') < firstDeltaAt, 'there is no post-generation assistant_emotion send');
  // The single emotion event and the result carry the same face.
  const emotionEvent = sseEvents.find((event) => event.event === 'assistant_emotion').data;
  const resultEmotion = sseEvents.find((event) => event.event === 'result').data.emotion;
  assert.deepEqual(emotionEvent, { expression: 'joy', face_emotion_variant_id: 'face_joy' });
  assert.deepEqual(resultEmotion, { expression: 'joy', face_emotion_variant_id: 'face_joy' });
});

test('the utterance route passes the two new v2 provider seams into the group turn (provider injection contract)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  let sawContinuation = false;
  let sawCutoff = false;
  await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index },
    resolveRuntimeProviders: async ({ onChatDelta } = {}) => ({
      chatProvider: async () => { if (onChatDelta) onChatDelta('x'); return 'x'; },
      emotionProvider: async () => ({ expression: 'joy' }),
      conversationContinuationProvider: async () => { sawContinuation = true; return 'true'; },
      conversationCutoffProvider: async () => { sawCutoff = true; return 'unused'; },
      characterSpeechConstraints: []
    })
  });
  assert.equal(sawContinuation, true, 'the continuation provider ran (post-utterance judgment fires every turn)');
  assert.equal(sawCutoff, false, 'the cutoff provider did NOT run when the speaker chose to stay');
});

test('a continue turn fires exactly one assistant_complete (v2 SSE count contract for the stay branch)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const { sseEvents } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index }
  });
  const names = sseEvents.map((event) => event.event);
  assert.equal(names.filter((n) => n === 'assistant_complete').length, 1, 'a continue turn fires assistant_complete exactly once');
});

test('the utterance route runs the departure branch when the continuation judgment is false (record carries 2 assistant messages + exited lifecycle)', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const result = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index },
    resolveRuntimeProviders: async (args) => turnProviders({ ...args, continuationAnswer: 'false', departureText: 'それじゃあ、部屋に戻る。' })
  });
  // The SSE terminal `result` still fires exactly once for Stage 1 (multi-`assistant_complete` payload lands in a
  // later stage); what this test pins is the record-level v2 contract: 2 assistant messages + exited lifecycle
  // for the speaker + cursor advanced by one, all persisted atomically.
  const record = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${conversation.id}.json`), 'utf8'));
  assert.equal(record.messages.length, 2, 'both the normal utterance and the departure utterance were appended');
  assert.equal(record.messages[0].character_id, conversation.next_speaker.character_id);
  assert.equal(record.messages[1].character_id, conversation.next_speaker.character_id, 'the departure utterance carries the same speaker identity');
  assert.equal(record.messages[0].expression, record.messages[1].expression, 'both messages carry the same emotion');
  const exitedEntry = record.participant_lifecycle.find((entry) => entry.character_id === conversation.next_speaker.character_id);
  assert.equal(exitedEntry.status, 'exited');
  assert.equal(exitedEntry.exited_after_message_count, 2);
  assert.equal(record.cursor.next_speaker_index, 1, 'the cursor advanced by one slot');
  // The other two entries remain active.
  const active = record.participant_lifecycle.filter((entry) => entry.status === 'active');
  assert.equal(active.length, 2);
  // The final SSE `result` still reflects the advanced cursor.
  const resultEvent = result.sseEvents.find((event) => event.event === 'result').data;
  assert.equal(resultEvent.conversation.cursor.next_speaker_index, 1);
});

test('the utterance route surfaces a malformed continuation judgment as an SSE error (fail-fast, no record write)', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const { sseEvents } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index },
    resolveRuntimeProviders: async (args) => turnProviders({ ...args, continuationAnswer: 'maybe' })
  });
  const errorEvent = sseEvents.find((event) => event.event === 'error');
  assert.ok(errorEvent, 'a malformed judgment surfaces as an SSE error');
  assert.equal(errorEvent.data.error_code, 'INVALID_LLM_LOUNGE_CONTINUATION_OUTPUT');
  // No half-appended turn was persisted: the record still has an empty transcript.
  const record = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${conversation.id}.json`), 'utf8'));
  assert.equal(record.messages.length, 0, 'the malformed-judgment turn wrote nothing to the record');
});

test('a cursor mismatch fails fast 409 before opening the SSE stream', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const { jsonCalls, openSseCount } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: 1, next_speaker_index: 2 }
  });
  assert.equal(openSseCount, 0);
  assert.equal(jsonCalls[0].status, 409);
  assert.equal(jsonCalls[0].value.error_code, 'LOUNGE_CURSOR_MISMATCH');
});

test('an utterance for a conversation that is not the active one fails fast 409', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  await enter(playRoot);
  const { jsonCalls, openSseCount } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: 'conv_lounge_5_bogus', round_number: 1, next_speaker_index: 0 }
  });
  assert.equal(openSseCount, 0);
  assert.equal(jsonCalls[0].status, 409);
  assert.equal(jsonCalls[0].value.error_code, 'LOUNGE_CONVERSATION_MISMATCH');
});

test('an utterance requested on the player boundary (all NPCs spoke) fails fast as not-an-NPC-turn', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  let { conversation } = await enter(playRoot);
  // Speak all three NPCs so the cursor sits at the player boundary (index 3).
  for (let i = 0; i < 3; i += 1) {
    const result = await utter(playRoot, conversation);
    conversation = result.conversation;
  }
  assert.equal(conversation.cursor.next_speaker_index, 3);
  assert.equal(conversation.next_speaker, null);
  const { jsonCalls, openSseCount } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: conversation.id, round_number: 1, next_speaker_index: 3 }
  });
  assert.equal(openSseCount, 0);
  assert.equal(jsonCalls[0].status, 409);
  assert.equal(jsonCalls[0].value.error_code, 'LOUNGE_NOT_NPC_TURN');
});

// ---- player turn ----

test('the player turn closes the round and opens the next (cursor rewinds to round 2, first NPC)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  let { conversation } = await enter(playRoot);
  for (let i = 0; i < 3; i += 1) {
    const result = await utter(playRoot, conversation);
    conversation = result.conversation;
  }
  const { jsonCalls } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/player-turn',
    playRoot,
    body: { id: conversation.id, round_number: 1, next_speaker_index: 3, content: 'みんな元気そうで何より。' }
  });
  assert.equal(jsonCalls[0].status, 200);
  const view = jsonCalls[0].value.conversation;
  assert.equal(view.cursor.round_number, 2);
  assert.equal(view.cursor.next_speaker_index, 0);
  assert.equal(view.messages.filter((message) => message.role === 'user').length, 1);
});

test('a player turn before the round is over fails fast 409', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  const { conversation } = await enter(playRoot);
  const { jsonCalls } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/player-turn',
    playRoot,
    body: { id: conversation.id, round_number: 1, next_speaker_index: 0, content: '早すぎる。' }
  });
  assert.equal(jsonCalls[0].status, 409);
  assert.equal(jsonCalls[0].value.error_code, 'LOUNGE_NOT_PLAYER_TURN');
});

// ---- end → finalization + content result ----

test('end runs the aggregate finalization, writes the lounge content result, clears the pointer, and screens to interaction', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t, { elapsedWeeks: 6 });
  let { conversation } = await enter(playRoot);
  for (let i = 0; i < 3; i += 1) {
    const result = await utter(playRoot, conversation);
    conversation = result.conversation;
  }
  const { jsonCalls } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/end',
    playRoot,
    body: { id: conversation.id }
  });
  assert.equal(jsonCalls[0].status, 200);
  const value = jsonCalls[0].value;
  assert.equal(value.finalization_status, 'completed');
  assert.equal(value.transition.next_screen, 'interaction');
  assert.equal(value.post_content_screen, 'interaction');
  assert.equal(value.lounge_result.participants.length, 3);

  // The aggregate finalization promoted: group marker present, transcript discarded, each participant's affinity applied.
  assert.ok(await fs.access(path.join(slotGameData, `logs/finalization/${conversation.id}.json`)).then(() => true).catch(() => false), 'the group finalization marker is promoted');
  const record = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${conversation.id}.json`), 'utf8'));
  assert.equal(record.messages.length, 0, 'the transcript was discarded');
  for (const participant of conversation.participants) {
    const affinity = JSON.parse(await fs.readFile(path.join(slotGameData, `characters/${participant.character_id}/affinity.json`), 'utf8'));
    assert.equal(affinity.affinity, 28, 'the participant affinity delta (+3) was applied');
  }

  // runtime_state: content result recorded, active pointer cleared, screen returned to interaction.
  const state = JSON.parse(await fs.readFile(path.join(slotGameData, 'runtime_state.json'), 'utf8'));
  assert.equal(state.current_screen, 'interaction');
  assert.equal(readActiveRoutingLounge(state), null, 'the active lounge pointer was cleared');
  assert.equal(state.last_routing_content_result.kind, 'lounge');
  assert.equal(state.last_routing_content_result.week, 6);
  assert.equal(state.last_routing_content_result.detail.participants.length, 3);
});

test('end on a conversation that is not active fails fast 409', async (t) => {
  const { playRoot } = await slotLoungeRoot(t);
  await enter(playRoot);
  const { jsonCalls } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/end',
    playRoot,
    body: { id: 'conv_lounge_3_bogus' }
  });
  assert.equal(jsonCalls[0].status, 409);
  assert.equal(jsonCalls[0].value.error_code, 'LOUNGE_CONVERSATION_MISMATCH');
});

// ---- Stage 2 v2 auto-completion contract ----

// Drives three consecutive utterance turns where every NPC departs. After the third departure every participant
// is exited, so the utterance-stream auto attach must fire the shared completion helper. Returns the last SSE
// stream's events, the final on-disk state, and each conversation view along the way.
async function utterAllDepart(playRoot, initialConversation) {
  let conversation = initialConversation;
  const turnSseByIndex = [];
  const jsonCallsByIndex = [];
  for (let i = 0; i < 3; i += 1) {
    const call = await callHandler({
      method: 'POST',
      pathname: '/api/lounge/utterance/stream',
      playRoot,
      body: { id: conversation.id, round_number: conversation.cursor.round_number, next_speaker_index: conversation.cursor.next_speaker_index },
      resolveRuntimeProviders: async (args) => turnProviders({ ...args, continuationAnswer: 'false', departureText: `退出発話${i + 1}` })
    });
    turnSseByIndex.push(call.sseEvents);
    jsonCallsByIndex.push(call.jsonCalls);
    const resultEvent = call.sseEvents.find((event) => event.event === 'result');
    if (resultEvent?.data?.conversation) conversation = resultEvent.data.conversation;
  }
  return { conversation, turnSseByIndex, jsonCallsByIndex };
}

test('the utterance route auto-completes when the last participant departs (helper shared with /end, terminal result carries the completion payload)', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t, { elapsedWeeks: 4 });
  const { conversation } = await enter(playRoot);
  const { turnSseByIndex } = await utterAllDepart(playRoot, conversation);

  // The first two departure turns do NOT trigger auto-completion — someone remains active — so no
  // lounge_draining / lounge_finalization_progress / completion fields appear.
  for (let i = 0; i < 2; i += 1) {
    const names = turnSseByIndex[i].map((event) => event.event);
    assert.ok(!names.includes('lounge_draining'), `turn ${i + 1} does not drain`);
    assert.ok(!names.includes('lounge_finalization_progress'), `turn ${i + 1} does not emit finalization progress`);
    const result = turnSseByIndex[i].find((event) => event.event === 'result').data;
    assert.equal(result.finalization_status, undefined, `turn ${i + 1} carries no completion payload`);
  }

  // Third turn: the last active NPC departs. The SSE fires TWO assistant_complete events (normal + depart), the
  // drain signal after them, one or more finalization_progress events, and merges the completion payload into
  // the terminal `result`.
  const lastEvents = turnSseByIndex[2];
  const names = lastEvents.map((event) => event.event);
  const completeIndices = names.reduce((acc, name, idx) => (name === 'assistant_complete' ? [...acc, idx] : acc), []);
  assert.equal(completeIndices.length, 2, 'depart turn fires two assistant_complete events (normal + depart)');
  const drainingAt = names.indexOf('lounge_draining');
  assert.ok(drainingAt > completeIndices[1], 'lounge_draining follows the departure assistant_complete');
  const firstProgressAt = names.indexOf('lounge_finalization_progress');
  assert.ok(firstProgressAt > drainingAt, 'finalization_progress follows lounge_draining');
  const resultAt = names.indexOf('result');
  assert.equal(resultAt, names.length - 1, 'result is the terminal event');
  assert.ok(names.filter((name) => name === 'assistant_emotion').length === 1, 'only one assistant_emotion is sent even on a departure turn');

  const terminal = lastEvents.find((event) => event.event === 'result').data;
  assert.equal(terminal.finalization_status, 'completed');
  assert.equal(terminal.transition.next_screen, 'interaction');
  assert.equal(terminal.post_content_screen, 'interaction');
  assert.equal(terminal.state.current_screen, 'interaction');
  assert.ok(terminal.lounge_result, 'the completion payload carries the lounge content result detail');
  assert.equal(terminal.lounge_result.participants.length, 3);

  // The on-disk state matches: active pointer cleared, content result written, screen = interaction — same
  // shape a manual /end write leaves behind (helper is shared).
  const state = JSON.parse(await fs.readFile(path.join(slotGameData, 'runtime_state.json'), 'utf8'));
  assert.equal(state.current_screen, 'interaction');
  assert.equal(readActiveRoutingLounge(state), null, 'auto attach cleared the active lounge pointer');
  assert.equal(state.last_routing_content_result.kind, 'lounge');
  assert.equal(state.last_routing_content_result.detail.participants.length, 3);
});

test('the auto attach and the manual /end produce field-equivalent completion payloads across every non-conversation-id field (helper is shared)', async (t) => {
  // Auto path: run three departures on one slot; capture the terminal `result` payload.
  const auto = await slotLoungeRoot(t, { elapsedWeeks: 4 });
  const autoEnter = await enter(auto.playRoot);
  const autoRun = await utterAllDepart(auto.playRoot, autoEnter.conversation);
  const autoTerminal = autoRun.turnSseByIndex[2].find((event) => event.event === 'result').data;

  // Manual path: on a separate slot, run three continuing turns then /end. Capture the JSON body.
  const manual = await slotLoungeRoot(t, { elapsedWeeks: 4 });
  let { conversation } = await enter(manual.playRoot);
  for (let i = 0; i < 3; i += 1) {
    const result = await utter(manual.playRoot, conversation);
    conversation = result.conversation;
  }
  const { jsonCalls: manualJson } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/end',
    playRoot: manual.playRoot,
    body: { id: conversation.id }
  });
  const manualBody = manualJson[0].value;

  // The completion payload shape is defined at the helper's return: the auto path merges the payload into the
  // SSE terminal `result` (which also carries speaker/emotion/content/conversation) and the manual path
  // returns the payload directly as its JSON body. Assert every helper-owned field agrees across paths, then
  // list the auto-only extras (the utterance-level speaker/emotion/content/conversation the terminal `result`
  // carries alongside the merged completion) explicitly so the divergence is documented, not silent.
  const HELPER_FIELDS = ['finalization_status', 'transition', 'post_content_screen'];
  for (const field of HELPER_FIELDS) {
    assert.deepEqual(autoTerminal[field], manualBody[field], `${field} agrees across auto and manual`);
  }
  // Content result: two conversation ids seat the same three participants (week seed), so the detail
  // participants list agrees; conversation-id-derived fields (id, timestamps) differ per run and are not
  // compared here.
  assert.deepEqual(autoTerminal.lounge_result.participants, manualBody.lounge_result.participants);

  // The `state` field is helper-owned but nearly every field inside it derives from the promoted conversation
  // (unconsumed_routing_conversation pointer, last_routing_content_result), so pin only the invariants both
  // completions must land on: current_screen and the active-lounge-pointer clear.
  assert.equal(autoTerminal.state.current_screen, manualBody.state.current_screen);
  assert.equal(autoTerminal.state.current_screen, 'interaction');
  assert.equal(readActiveRoutingLounge(autoTerminal.state), null);
  assert.equal(readActiveRoutingLounge(manualBody.state), null);

  // Documented divergence: the terminal SSE result carries per-utterance keys (speaker/emotion/content/
  // conversation) that the manual JSON body does not — because manual /end does not run an utterance turn.
  const autoOnlyKeys = Object.keys(autoTerminal).filter((k) => !(k in manualBody));
  assert.deepEqual(autoOnlyKeys.sort(), ['content', 'conversation', 'emotion', 'speaker']);
  // Nothing in the manual body is absent from the auto terminal (the auto path is the manual body superset).
  const manualOnlyKeys = Object.keys(manualBody).filter((k) => !(k in autoTerminal));
  assert.deepEqual(manualOnlyKeys, []);
});

test('post-promote failure: a second promote of the same conversation id fails fast (finalizer already-finalized reject; SSE surfaces error, no retry silently re-finalizes)', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t, { elapsedWeeks: 4 });
  let { conversation } = await enter(playRoot);
  for (let i = 0; i < 3; i += 1) {
    const result = await utter(playRoot, conversation);
    conversation = result.conversation;
  }
  // First manual /end succeeds and promotes atomically: the group marker + validator logs + discarded transcript
  // land on disk.
  const first = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/end',
    playRoot,
    body: { id: conversation.id }
  });
  assert.equal(first.jsonCalls[0].status, 200);
  assert.equal(first.jsonCalls[0].value.finalization_status, 'completed');
  const markerPath = path.join(slotGameData, `logs/finalization/${conversation.id}.json`);
  assert.ok(await fs.access(markerPath).then(() => true).catch(() => false), 'the group marker landed on the first end');
  // Restore the active-lounge pointer (which the first /end cleared) so the second /end reaches the finalizer
  // path with a "still active" gate — this simulates a second promote attempt that got past the request-time
  // pointer clear (e.g. a stale client retry that races the pointer write). The finalizer's own
  // already-finalized reject is the last line of defense, and it fires here.
  const state = JSON.parse(await fs.readFile(path.join(slotGameData, 'runtime_state.json'), 'utf8'));
  state.routing_active_lounge = { conversation_id: conversation.id, week: 4, started_at: '2026-07-18T00:00:00.000Z' };
  await fs.writeFile(path.join(slotGameData, 'runtime_state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const second = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/end',
    playRoot,
    body: { id: conversation.id }
  });
  // The second /end propagates the finalizer's `already finalized` throw. sendLoungeError only converts
  // errors whose statusCode is 400/404/409/503; any other error re-throws out of the handler.
  assert.ok(second.threw, 'the second /end fails fast (the finalizer\'s already-finalized reject surfaces)');
  assert.ok(/already finalized/i.test(String(second.threw?.message ?? '')), 'the error message names the already-finalized state');
});

test('the shared completion helper fail-fasts on a second call from the same instance (per-request one-shot guard)', async (t) => {
  const { playRoot } = await slotLoungeRoot(t, { elapsedWeeks: 4 });
  let { conversation } = await enter(playRoot);
  // Drive the utterance turns manually with `continuationAnswer: 'true'` (no departure) so the record ends
  // with three assistant lines and no auto attach; then the helper is invoked directly (out-of-band from any
  // HTTP handler) exactly like the auto path and manual `/end` handler do it — the first call promotes, the
  // second call throws before reaching the finalizer's own already-finalized guard.
  for (let i = 0; i < 3; i += 1) {
    const result = await utter(playRoot, conversation);
    conversation = result.conversation;
  }
  const storage = createStorageApi({ root: playRoot });
  const state = await storage.readJson('game_data/runtime_state.json');
  const active = readActiveRoutingLounge(state);
  const helper = createLoungeCompletionHelper();
  const first = await helper({
    root: playRoot,
    storage,
    active,
    resolveLoungeFinalizationProviders: async () => finalizationProviders(),
    postContentScreen: 'interaction',
    now: '2026-07-18T00:00:00.000Z'
  });
  assert.equal(first.finalization_status, 'completed');
  await assert.rejects(
    helper({
      root: playRoot,
      storage,
      active,
      resolveLoungeFinalizationProviders: async () => finalizationProviders(),
      postContentScreen: 'interaction',
      now: '2026-07-18T00:00:01.000Z'
    }),
    /cannot promote twice/
  );
});

test('an auto attach failure (finalization providers unconfigured) surfaces as SSE error and does NOT promote the record', async (t) => {
  const { playRoot, slotGameData } = await slotLoungeRoot(t, { elapsedWeeks: 4 });
  const { conversation } = await enter(playRoot);
  // Two turns depart cleanly (utterAllDepart uses the default finalization providers).
  const firstTwo = [];
  let running = conversation;
  for (let i = 0; i < 2; i += 1) {
    const call = await callHandler({
      method: 'POST',
      pathname: '/api/lounge/utterance/stream',
      playRoot,
      body: { id: running.id, round_number: running.cursor.round_number, next_speaker_index: running.cursor.next_speaker_index },
      resolveRuntimeProviders: async (args) => turnProviders({ ...args, continuationAnswer: 'false', departureText: `退出${i + 1}` })
    });
    firstTwo.push(call);
    running = call.sseEvents.find((event) => event.event === 'result').data.conversation;
  }
  // Third depart: swap the finalization provider resolver to throw a synthetic pre-promote error.
  const badResolver = async () => { throw new Error('finalization provider synthetic failure'); };
  const call = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/utterance/stream',
    playRoot,
    body: { id: running.id, round_number: running.cursor.round_number, next_speaker_index: running.cursor.next_speaker_index },
    resolveRuntimeProviders: async (args) => turnProviders({ ...args, continuationAnswer: 'false', departureText: '退出3' }),
    resolveLoungeFinalizationProviders: badResolver
  });
  const names = call.sseEvents.map((event) => event.event);
  const errorAt = names.indexOf('error');
  const resultAt = names.indexOf('result');
  assert.ok(errorAt >= 0, 'the failed auto attach surfaces as an SSE error event');
  assert.equal(resultAt, -1, 'the terminal result event is NOT sent on failure (SSE terminates with error)');
  // The record has NOT been promoted: the transcript still carries the exited participants' messages, and no
  // group finalization marker landed. The next retry / manual /end can still complete the conversation.
  const record = JSON.parse(await fs.readFile(path.join(slotGameData, `logs/lounge/${running.id}.json`), 'utf8'));
  assert.ok(record.messages.length >= 6, 'the transcript survived the failed auto attach (6 assistant messages: 3× normal + 3× depart)');
  const markerExists = await fs.access(path.join(slotGameData, `logs/finalization/${running.id}.json`))
    .then(() => true)
    .catch(() => false);
  assert.equal(markerExists, false, 'no group finalization marker landed on pre-promote failure');
  // A manual /end still works because the record is still active — recovery via retry.
  const { jsonCalls: recovery } = await callHandler({
    method: 'POST',
    pathname: '/api/lounge/end',
    playRoot,
    body: { id: running.id }
  });
  assert.equal(recovery[0].status, 200);
  assert.equal(recovery[0].value.finalization_status, 'completed');
});
