// 談話室 group turn orchestrator: end-to-end start + per-utterance generation over a real fixture root. Asserts
// the full 昼会話 assembly for the current speaker (persona / actor context / speech constraints / authored scene /
// default final instruction), the speaker-named shared history, the v2 per-speaker continuation judgment inserted
// after the normal utterance but before persist, the optional in-round departure reply appended atomically together
// with the normal utterance under one persist, the participant lifecycle transition, cursor fast-forward over the
// inactive suffix, and the multi-emit `onAssistantComplete` seam — all through injected provider seams (no live
// model).

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fixtureRoot, baselineRuntimeState } from './helpers.mjs';
import {
  startLoungeGroupConversation,
  runLoungeGroupTurn,
  readLoungeGroupRecord
} from '../src/llm/loungeGroupTurn.mjs';
import { currentLoungeSpeaker, LOUNGE_PARTICIPANT_COUNT } from '../src/llm/loungeGroupRecord.mjs';

const SPEECH_CONSTRAINTS = ['「最高」という単語は禁忌である。'];

async function loungeFixtureRoot(t) {
  const root = await fixtureRoot('magic-adv-lounge-turn-', {
    runtimeState: { ...baselineRuntimeState, elapsed_weeks: 3 }
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

// Provider bundle for the v2 group turn. Every provider records its prompts so tests can assert what the seam saw.
// Continuation defaults to `true` (stay) and cutoff to a fixed departure line; a test may override either via
// `continuationReplies` (indexed) or `cutoffReplies` (indexed).
function recordingProviders({ replies = [], continuationReplies = [], cutoffReplies = [] } = {}) {
  const prompts = [];
  const emotionPrompts = [];
  const continuationPrompts = [];
  const cutoffPrompts = [];
  let replyIndex = 0;
  let continuationIndex = 0;
  let cutoffIndex = 0;
  return {
    prompts,
    emotionPrompts,
    continuationPrompts,
    cutoffPrompts,
    chatProvider: async ({ prompt }) => {
      prompts.push(prompt);
      const reply = replies[replyIndex] ?? `既定の発話${replyIndex}`;
      replyIndex += 1;
      return reply;
    },
    emotionProvider: async ({ prompt }) => {
      emotionPrompts.push(prompt);
      return { expression: 'joy' };
    },
    conversationContinuationProvider: async ({ prompt }) => {
      continuationPrompts.push(prompt);
      const answer = continuationReplies[continuationIndex] ?? 'true';
      continuationIndex += 1;
      return answer;
    },
    conversationCutoffProvider: async ({ prompt }) => {
      cutoffPrompts.push(prompt);
      const reply = cutoffReplies[cutoffIndex] ?? `既定の退出発話${cutoffIndex}`;
      cutoffIndex += 1;
      return reply;
    }
  };
}

test('startLoungeGroupConversation seats three participants, snapshots contexts, and persists the record', async (t) => {
  const root = await loungeFixtureRoot(t);
  const record = await startLoungeGroupConversation({ root, id: 'conv_lounge_start', week: 3 });
  assert.equal(record.source_type, 'lounge');
  assert.equal(record.week, 3);
  assert.equal(record.location_name, '寮の談話室');
  assert.ok(record.visible_situation);
  assert.equal(record.participants.length, LOUNGE_PARTICIPANT_COUNT);
  assert.equal(record.conversation_actor_contexts.length, LOUNGE_PARTICIPANT_COUNT);
  assert.equal(record.messages.length, 0);
  // Lifecycle projection: all three active on start.
  assert.equal(record.participant_lifecycle.length, LOUNGE_PARTICIPANT_COUNT);
  assert.ok(record.participant_lifecycle.every((entry) => entry.status === 'active'));

  // Persisted and re-readable through the store.
  const reread = await readLoungeGroupRecord({ root, id: 'conv_lounge_start' });
  assert.deepEqual(reread, record);
  const onDisk = path.join(root, 'game_data/logs/lounge/conv_lounge_start.json');
  assert.ok(await fs.access(onDisk).then(() => true).catch(() => false), 'the record is written to the lounge log path');
});

test('the same week reconstructs the same participants and scene (week-seed determinism)', async (t) => {
  const root = await loungeFixtureRoot(t);
  const a = await startLoungeGroupConversation({ root, id: 'conv_lounge_a', week: 5 });
  const b = await startLoungeGroupConversation({ root, id: 'conv_lounge_b', week: 5 });
  assert.deepEqual(a.participants, b.participants, 'same week seats the same participants');
  assert.equal(a.visible_situation, b.visible_situation, 'same week draws the same scene');
});

test('runLoungeGroupTurn: on continue, one message appended and the normal-utterance prompt is byte-equivalent to v1', async (t) => {
  const root = await loungeFixtureRoot(t);
  const started = await startLoungeGroupConversation({ root, id: 'conv_lounge_turn', week: 3 });
  const firstSpeaker = currentLoungeSpeaker(started);
  const providers = recordingProviders({ replies: ['まずは落ち着いて話そう。'] });

  const result = await runLoungeGroupTurn({
    root,
    id: 'conv_lounge_turn',
    chatProvider: providers.chatProvider,
    emotionProvider: providers.emotionProvider,
    conversationContinuationProvider: providers.conversationContinuationProvider,
    conversationCutoffProvider: providers.conversationCutoffProvider,
    characterSpeechConstraints: SPEECH_CONSTRAINTS
  });

  // One normal-utterance prompt + one emotion prompt + one continuation prompt, no cutoff.
  assert.equal(providers.prompts.length, 1);
  assert.equal(providers.emotionPrompts.length, 1);
  assert.equal(providers.continuationPrompts.length, 1);
  assert.equal(providers.cutoffPrompts.length, 0);
  const prompt = providers.prompts[0];

  // Full assembly: current speaker's persona, authored scene, speech constraints, actor context, default final
  // instruction, and an empty-history opening turn line.
  assert.ok(prompt.includes(`あなたは${firstSpeaker.character_name}である。`), 'the current speaker persona is injected');
  assert.ok(prompt.includes('舞台: 寮の談話室'), 'the authored location is the scene');
  assert.ok(prompt.includes(`見えている状況: ${started.visible_situation}`), 'the authored visible situation is the scene');
  assert.ok(prompt.includes('キャラクター発話上の禁止事項:'), 'the speech constraints block renders');
  assert.ok(prompt.includes('会話相手コンテキスト:'), 'the actor context block renders');
  assert.ok(prompt.includes('主人公への好感度'), 'the affinity actor context renders');
  assert.ok(prompt.includes('直前までの会話:\n- なし'), 'the opening turn has an empty shared history');
  assert.ok(prompt.includes('現在の場面に自然に続く返答だけを書く'), 'the default (unmodified) final instruction is used');

  // The continuation prompt is the third-person verdict over the transcript (not the 1:1 「プレイヤーとの会話」 form and
  // not the retired first-person role-play question, which made the model emit an utterance instead of the boolean).
  const continuationPrompt = providers.continuationPrompts[0];
  assert.ok(continuationPrompt.includes(`この記録を読み、${firstSpeaker.character_name}が自分の今の発話を終えたあとも、この談話の場に残っていたいと思っているかを判定する。`), 'the third-person verdict instruction is used');
  assert.ok(continuationPrompt.includes('出力はtrueもしくはfalseの1語だけとする。'), 'the single-word output contract is used');
  assert.ok(continuationPrompt.includes('以上が談話の記録である。'), 'the closed-record turn line is used');
  assert.ok(!continuationPrompt.includes('として、自分の今の発話を終えたあとも'), 'the first-person role-play question is NOT used');
  assert.ok(!continuationPrompt.includes('プレイヤーの次の発言を待っている。'), 'the between-turns marker is NOT used');
  assert.ok(!continuationPrompt.includes('この発言を行ったプレイヤーとの会話'), 'the 1:1 continuation instruction is NOT used');
  // The continuation prompt sees the provisional history including the just-generated utterance.
  assert.ok(continuationPrompt.includes(`- ${firstSpeaker.character_name}: まずは落ち着いて話そう。`), 'the continuation prompt sees the normal utterance as history');

  // The appended message carries the speaker identity and the chosen emotion; only one assistant message.
  assert.equal(result.record.messages.length, 1);
  const appended = result.record.messages.at(-1);
  assert.equal(appended.role, 'assistant');
  assert.equal(appended.character_id, firstSpeaker.character_id);
  assert.equal(appended.character_name, firstSpeaker.character_name);
  assert.equal(appended.content, 'まずは落ち着いて話そう。');
  assert.equal(appended.expression, 'joy');
  assert.equal(appended.face_emotion_variant_id, 'face_joy');
  assert.equal(result.record.cursor.next_speaker_index, 1);
  // Lifecycle unchanged.
  assert.ok(result.record.participant_lifecycle.every((entry) => entry.status === 'active'));
  // Result carries the judgment outcome and no departure.
  assert.equal(result.continuation.continued, true);
  assert.equal(result.departure, null);

  // Persisted immediately.
  const reread = await readLoungeGroupRecord({ root, id: 'conv_lounge_turn' });
  assert.equal(reread.messages.length, 1);
  assert.equal(reread.messages[0].character_id, firstSpeaker.character_id);
});

test('runLoungeGroupTurn: on false continuation, appends normal + departure atomically with the same emotion and transitions lifecycle', async (t) => {
  const root = await loungeFixtureRoot(t);
  const started = await startLoungeGroupConversation({ root, id: 'conv_lounge_departure', week: 3 });
  const firstSpeaker = currentLoungeSpeaker(started);
  const providers = recordingProviders({
    replies: ['やっぱり、もう部屋に戻るね。'],
    continuationReplies: ['false'],
    cutoffReplies: ['それじゃあ、また明日。']
  });

  const result = await runLoungeGroupTurn({
    root,
    id: 'conv_lounge_departure',
    chatProvider: providers.chatProvider,
    emotionProvider: providers.emotionProvider,
    conversationContinuationProvider: providers.conversationContinuationProvider,
    conversationCutoffProvider: providers.conversationCutoffProvider,
    characterSpeechConstraints: SPEECH_CONSTRAINTS
  });

  // Exactly one normal + one continuation + one departure prompt.
  assert.equal(providers.prompts.length, 1);
  assert.equal(providers.continuationPrompts.length, 1);
  assert.equal(providers.cutoffPrompts.length, 1);
  const departurePrompt = providers.cutoffPrompts[0];
  assert.ok(departurePrompt.includes('この談話の場から自分だけが退出する'), 'the departure instruction is the lounge-specific single-speaker exit');
  assert.ok(!departurePrompt.includes('この会話を切り上げる'), 'the 1:1 cutoff instruction is NOT used');
  assert.ok(departurePrompt.includes(`先ほど自分が生成した発言: やっぱり、もう部屋に戻るね。`), 'the departure prompt re-injects the normal utterance');

  // Two assistant messages appended atomically, same speaker, same emotion.
  assert.equal(result.record.messages.length, 2);
  assert.equal(result.record.messages[0].character_id, firstSpeaker.character_id);
  assert.equal(result.record.messages[0].content, 'やっぱり、もう部屋に戻るね。');
  assert.equal(result.record.messages[1].character_id, firstSpeaker.character_id);
  assert.equal(result.record.messages[1].content, 'それじゃあ、また明日。');
  assert.equal(result.record.messages[0].expression, 'joy');
  assert.equal(result.record.messages[1].expression, 'joy');
  // The first speaker exited; boundary = messages.length after both were appended.
  const firstEntry = result.record.participant_lifecycle.find((entry) => entry.character_id === firstSpeaker.character_id);
  assert.equal(firstEntry.status, 'exited');
  assert.equal(firstEntry.exited_after_message_count, 2);
  // Others still active.
  const otherEntries = result.record.participant_lifecycle.filter((entry) => entry.character_id !== firstSpeaker.character_id);
  assert.ok(otherEntries.every((entry) => entry.status === 'active'));
  // Cursor advanced by one; the next active speaker is due (no cascade of exits, so no fast-forward).
  assert.equal(result.record.cursor.next_speaker_index, 1);
  assert.equal(currentLoungeSpeaker(result.record).character_id, result.record.cursor.speaker_order[1]);
  // Result carries the judgment + departure summary.
  assert.equal(result.continuation.continued, false);
  assert.equal(result.departure.content, 'それじゃあ、また明日。');
  assert.deepEqual(result.departure.emotion, { expression: 'joy', face_emotion_variant_id: 'face_joy' });

  // Persisted immediately as one write (both messages present after reread).
  const reread = await readLoungeGroupRecord({ root, id: 'conv_lounge_departure' });
  assert.equal(reread.messages.length, 2);
});

test('runLoungeGroupTurn: malformed continuation output throws before persist and leaves the record untouched', async (t) => {
  const root = await loungeFixtureRoot(t);
  await startLoungeGroupConversation({ root, id: 'conv_lounge_malformed', week: 3 });
  const before = await readLoungeGroupRecord({ root, id: 'conv_lounge_malformed' });
  const providers = recordingProviders({
    replies: ['x'],
    continuationReplies: ['maybe']
  });
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_lounge_malformed',
      chatProvider: providers.chatProvider,
      emotionProvider: providers.emotionProvider,
      conversationContinuationProvider: providers.conversationContinuationProvider,
      conversationCutoffProvider: providers.conversationCutoffProvider
    }),
    /lounge continuation judgment must be true or false/
  );
  const after = await readLoungeGroupRecord({ root, id: 'conv_lounge_malformed' });
  assert.deepEqual(after, before, 'no partial turn was persisted');
});

test('runLoungeGroupTurn: an empty departure reply from the cutoff provider throws before persist and leaves the record untouched', async (t) => {
  const root = await loungeFixtureRoot(t);
  await startLoungeGroupConversation({ root, id: 'conv_lounge_departfail', week: 3 });
  const before = await readLoungeGroupRecord({ root, id: 'conv_lounge_departfail' });
  const providers = recordingProviders({
    replies: ['x'],
    continuationReplies: ['false'],
    cutoffReplies: ['   ']
  });
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_lounge_departfail',
      chatProvider: providers.chatProvider,
      emotionProvider: providers.emotionProvider,
      conversationContinuationProvider: providers.conversationContinuationProvider,
      conversationCutoffProvider: providers.conversationCutoffProvider
    }),
    /lounge departure reply is required/
  );
  const after = await readLoungeGroupRecord({ root, id: 'conv_lounge_departfail' });
  assert.deepEqual(after, before, 'no partial turn was persisted');
});

test('runLoungeGroupTurn notifies the normalized emotion through onEmotion BEFORE the chat provider runs (unchanged v1 seam)', async (t) => {
  const root = await loungeFixtureRoot(t);
  await startLoungeGroupConversation({ root, id: 'conv_lounge_emotion_seam', week: 3 });
  const order = [];
  let emotionAtChatStart = null;
  const result = await runLoungeGroupTurn({
    root,
    id: 'conv_lounge_emotion_seam',
    emotionProvider: async () => { order.push('emotion-provider'); return { expression: 'joy' }; },
    chatProvider: async ({ emotion }) => {
      order.push('chat-provider');
      emotionAtChatStart = emotion;
      return 'やあ。';
    },
    conversationContinuationProvider: async () => { order.push('continuation-provider'); return 'true'; },
    conversationCutoffProvider: async () => { order.push('cutoff-provider'); return 'departure'; },
    onEmotion: (emotion) => { order.push(`on-emotion:${emotion.expression}`); }
  });

  // The seam fires with the normalized emotion, after emotion selection and BEFORE the chat provider starts.
  // The continuation provider runs AFTER the chat provider. The cutoff provider does not run (continue=true).
  assert.deepEqual(order, ['emotion-provider', 'on-emotion:joy', 'chat-provider', 'continuation-provider']);
  // The same normalized emotion reaches the chat provider and the persisted/returned result — one value.
  assert.deepEqual(emotionAtChatStart, { expression: 'joy', face_emotion_variant_id: 'face_joy' });
  assert.deepEqual(result.emotion, { expression: 'joy', face_emotion_variant_id: 'face_joy' });
  assert.equal(result.record.messages.at(-1).expression, 'joy');
  assert.equal(result.record.messages.at(-1).face_emotion_variant_id, 'face_joy');
});

test('runLoungeGroupTurn: onAssistantComplete fires once for a continue turn and twice for a departure turn', async (t) => {
  const root = await loungeFixtureRoot(t);
  await startLoungeGroupConversation({ root, id: 'conv_lounge_complete_seam', week: 3 });

  // Continue turn: one complete.
  const continueEvents = [];
  await runLoungeGroupTurn({
    root,
    id: 'conv_lounge_complete_seam',
    chatProvider: async () => 'stay',
    emotionProvider: async () => ({ expression: 'joy' }),
    conversationContinuationProvider: async () => 'true',
    conversationCutoffProvider: async () => 'unused',
    onAssistantComplete: (event) => continueEvents.push(event)
  });
  assert.equal(continueEvents.length, 1);
  assert.equal(continueEvents[0].content, 'stay');
  assert.deepEqual(continueEvents[0].emotion, { expression: 'joy', face_emotion_variant_id: 'face_joy' });

  // Departure turn: two completes, same emotion.
  const departEvents = [];
  await runLoungeGroupTurn({
    root,
    id: 'conv_lounge_complete_seam',
    chatProvider: async () => 'stay-for-now',
    emotionProvider: async () => ({ expression: 'joy' }),
    conversationContinuationProvider: async () => 'false',
    conversationCutoffProvider: async () => 'i-leave',
    onAssistantComplete: (event) => departEvents.push(event)
  });
  assert.equal(departEvents.length, 2);
  assert.equal(departEvents[0].content, 'stay-for-now');
  assert.equal(departEvents[1].content, 'i-leave');
  assert.deepEqual(departEvents[0].emotion, departEvents[1].emotion, 'both messages carry the same emotion');
});

test('the shared history renders each NPC under its own name across a full continue-only round', async (t) => {
  const root = await loungeFixtureRoot(t);
  const started = await startLoungeGroupConversation({ root, id: 'conv_lounge_round', week: 3 });
  const speakers = started.cursor.speaker_order.map((id) => started.participants.find((p) => p.character_id === id));
  const replies = speakers.map((speaker) => `${speaker.character_name}の一言。`);
  const providers = recordingProviders({ replies });

  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    await runLoungeGroupTurn({
      root,
      id: 'conv_lounge_round',
      chatProvider: providers.chatProvider,
      emotionProvider: providers.emotionProvider,
      conversationContinuationProvider: providers.conversationContinuationProvider,
      conversationCutoffProvider: providers.conversationCutoffProvider,
      characterSpeechConstraints: SPEECH_CONSTRAINTS
    });
  }

  // The third NPC's prompt must carry the first two NPCs' named lines (speaker-named shared history), and must be
  // assembled as the third speaker's own persona — not the others'.
  const thirdPrompt = providers.prompts[2];
  assert.ok(thirdPrompt.includes(`- ${speakers[0].character_name}: ${replies[0]}`), 'the first NPC line is named in the history');
  assert.ok(thirdPrompt.includes(`- ${speakers[1].character_name}: ${replies[1]}`), 'the second NPC line is named in the history');
  assert.ok(thirdPrompt.includes(`あなたは${speakers[2].character_name}である。`), 'the third turn is assembled as the third speaker');
  assert.ok(!thirdPrompt.includes('直前までの会話:\n- なし'), 'the history is no longer empty by the third turn');

  const record = await readLoungeGroupRecord({ root, id: 'conv_lounge_round' });
  assert.deepEqual(record.messages.map((m) => m.character_id), started.cursor.speaker_order);
  assert.equal(currentLoungeSpeaker(record), null, 'the player is due after the NPC round');
});

test('runLoungeGroupTurn throws when it is the player\'s turn', async (t) => {
  const root = await loungeFixtureRoot(t);
  await startLoungeGroupConversation({ root, id: 'conv_lounge_player', week: 3 });
  const providers = recordingProviders();
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    await runLoungeGroupTurn({
      root,
      id: 'conv_lounge_player',
      chatProvider: providers.chatProvider,
      emotionProvider: providers.emotionProvider,
      conversationContinuationProvider: providers.conversationContinuationProvider,
      conversationCutoffProvider: providers.conversationCutoffProvider
    });
  }
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_lounge_player',
      chatProvider: providers.chatProvider,
      emotionProvider: providers.emotionProvider,
      conversationContinuationProvider: providers.conversationContinuationProvider,
      conversationCutoffProvider: providers.conversationCutoffProvider
    }),
    /player speaks next/
  );
});

test('runLoungeGroupTurn and readLoungeGroupRecord fail fast on a missing record and bad providers', async (t) => {
  const root = await loungeFixtureRoot(t);
  await assert.rejects(readLoungeGroupRecord({ root, id: 'conv_missing' }), /not found/);
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_missing',
      chatProvider: () => 'x',
      emotionProvider: () => ({ expression: 'neutral' }),
      conversationContinuationProvider: () => 'true',
      conversationCutoffProvider: () => 'y'
    }),
    /not found/
  );
  await startLoungeGroupConversation({ root, id: 'conv_lounge_badprov', week: 3 });
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_lounge_badprov',
      chatProvider: null,
      emotionProvider: () => ({}),
      conversationContinuationProvider: () => 'true',
      conversationCutoffProvider: () => 'y'
    }),
    /chatProvider is required/
  );
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_lounge_badprov',
      chatProvider: () => 'x',
      emotionProvider: () => ({ expression: 'neutral' }),
      conversationContinuationProvider: null,
      conversationCutoffProvider: () => 'y'
    }),
    /conversationContinuationProvider is required/
  );
  await assert.rejects(
    runLoungeGroupTurn({
      root,
      id: 'conv_lounge_badprov',
      chatProvider: () => 'x',
      emotionProvider: () => ({ expression: 'neutral' }),
      conversationContinuationProvider: () => 'true',
      conversationCutoffProvider: null
    }),
    /conversationCutoffProvider is required/
  );
});
