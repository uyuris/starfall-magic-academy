// 談話室 group turn orchestrator: end-to-end start + per-utterance generation over a real fixture root. Asserts
// the full 昼会話 assembly for the current speaker (persona / actor context / speech constraints / authored scene /
// default final instruction), the speaker-named shared history, one-LM-call-per-utterance append with speaker
// identity, cursor scheduling, and record persistence — all through injected provider seams (no live model).

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

function recordingProviders(replies) {
  const prompts = [];
  const emotionPrompts = [];
  let replyIndex = 0;
  return {
    prompts,
    emotionPrompts,
    chatProvider: async ({ prompt }) => {
      prompts.push(prompt);
      const reply = replies[replyIndex] ?? `既定の発話${replyIndex}`;
      replyIndex += 1;
      return reply;
    },
    emotionProvider: async ({ prompt }) => {
      emotionPrompts.push(prompt);
      return { expression: 'joy' };
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

test('runLoungeGroupTurn assembles the current speaker fully and appends with speaker identity', async (t) => {
  const root = await loungeFixtureRoot(t);
  const started = await startLoungeGroupConversation({ root, id: 'conv_lounge_turn', week: 3 });
  const firstSpeaker = currentLoungeSpeaker(started);
  const { chatProvider, emotionProvider, prompts, emotionPrompts } = recordingProviders(['まずは落ち着いて話そう。']);

  const result = await runLoungeGroupTurn({
    root,
    id: 'conv_lounge_turn',
    chatProvider,
    emotionProvider,
    characterSpeechConstraints: SPEECH_CONSTRAINTS
  });

  // One reply prompt + one emotion prompt were built for this utterance.
  assert.equal(prompts.length, 1);
  assert.equal(emotionPrompts.length, 1);
  const prompt = prompts[0];

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

  // The appended message carries the speaker identity and the chosen emotion.
  const appended = result.record.messages.at(-1);
  assert.equal(appended.role, 'assistant');
  assert.equal(appended.character_id, firstSpeaker.character_id);
  assert.equal(appended.character_name, firstSpeaker.character_name);
  assert.equal(appended.content, 'まずは落ち着いて話そう。');
  assert.equal(appended.expression, 'joy');
  assert.equal(appended.face_emotion_variant_id, 'face_joy');
  assert.equal(result.record.cursor.next_speaker_index, 1);

  // Persisted immediately.
  const reread = await readLoungeGroupRecord({ root, id: 'conv_lounge_turn' });
  assert.equal(reread.messages.length, 1);
  assert.equal(reread.messages[0].character_id, firstSpeaker.character_id);
});

test('runLoungeGroupTurn notifies the normalized emotion through onEmotion BEFORE the chat provider runs', async (t) => {
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
    onEmotion: (emotion) => { order.push(`on-emotion:${emotion.expression}`); }
  });

  // The seam fires with the normalized emotion, after emotion selection and BEFORE the chat provider starts.
  assert.deepEqual(order, ['emotion-provider', 'on-emotion:joy', 'chat-provider']);
  // The same normalized emotion reaches the chat provider and the persisted/returned result — one value.
  assert.deepEqual(emotionAtChatStart, { expression: 'joy', face_emotion_variant_id: 'face_joy' });
  assert.deepEqual(result.emotion, { expression: 'joy', face_emotion_variant_id: 'face_joy' });
  assert.equal(result.record.messages.at(-1).expression, 'joy');
  assert.equal(result.record.messages.at(-1).face_emotion_variant_id, 'face_joy');
});

test('the shared history renders each NPC under its own name across a full round', async (t) => {
  const root = await loungeFixtureRoot(t);
  const started = await startLoungeGroupConversation({ root, id: 'conv_lounge_round', week: 3 });
  const speakers = started.cursor.speaker_order.map((id) => started.participants.find((p) => p.character_id === id));
  const replies = speakers.map((speaker) => `${speaker.character_name}の一言。`);
  const { chatProvider, emotionProvider, prompts } = recordingProviders(replies);

  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    await runLoungeGroupTurn({ root, id: 'conv_lounge_round', chatProvider, emotionProvider, characterSpeechConstraints: SPEECH_CONSTRAINTS });
  }

  // The third NPC's prompt must carry the first two NPCs' named lines (speaker-named shared history), and must be
  // assembled as the third speaker's own persona — not the others'.
  const thirdPrompt = prompts[2];
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
  const { chatProvider, emotionProvider } = recordingProviders([]);
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    await runLoungeGroupTurn({ root, id: 'conv_lounge_player', chatProvider, emotionProvider });
  }
  await assert.rejects(
    runLoungeGroupTurn({ root, id: 'conv_lounge_player', chatProvider, emotionProvider }),
    /player speaks next/
  );
});

test('runLoungeGroupTurn and readLoungeGroupRecord fail fast on a missing record and bad providers', async (t) => {
  const root = await loungeFixtureRoot(t);
  await assert.rejects(readLoungeGroupRecord({ root, id: 'conv_missing' }), /not found/);
  await assert.rejects(runLoungeGroupTurn({ root, id: 'conv_missing', chatProvider: () => 'x', emotionProvider: () => ({ expression: 'neutral' }) }), /not found/);
  await startLoungeGroupConversation({ root, id: 'conv_lounge_badprov', week: 3 });
  await assert.rejects(runLoungeGroupTurn({ root, id: 'conv_lounge_badprov', chatProvider: null, emotionProvider: () => ({}) }), /chatProvider is required/);
});
