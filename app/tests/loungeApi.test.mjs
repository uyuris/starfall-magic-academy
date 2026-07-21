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
  canHandleLoungeApiRoute
} from '../src/server/loungeApi.mjs';
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
// stream callback into the chat provider in production.
function turnProviders({ onChatDelta } = {}) {
  return {
    chatProvider: async () => {
      if (onChatDelta) {
        onChatDelta('やあ、');
        onChatDelta('よく来たね。');
      }
      return 'やあ、よく来たね。';
    },
    emotionProvider: async () => ({ expression: 'joy' }),
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
