// 談話室 group record: strict validator (participants / speaker-scoped messages / cursor determinism /
// no top-level actor completion), plus the create + append cursor progression (NPC round → player → next round).

import test from 'node:test';
import assert from 'node:assert/strict';

import { INJECTED_SCENE_SOURCE_TYPES, LOUNGE_SOURCE_TYPE } from '../src/routingMetaContext.mjs';
import {
  createLoungeGroupRecord,
  validateLoungeGroupRecord,
  currentLoungeSpeaker,
  loungeActorContextFor,
  appendLoungeAssistantMessage,
  appendLoungePlayerMessage,
  LOUNGE_PARTICIPANT_COUNT
} from '../src/llm/loungeGroupRecord.mjs';

function actorContext(title) {
  return { sections: [{ title: '系統知識', entries: [{ title, body: `${title}の本文。` }] }] };
}

const PARTICIPANTS = [
  { character_id: 'character_007', character_name: 'ミラ' },
  { character_id: 'character_003', character_name: 'モナ' },
  { character_id: 'character_020', character_name: 'レオナ' }
];

function actorContexts() {
  return PARTICIPANTS.map((participant) => ({
    character_id: participant.character_id,
    conversation_actor_context: actorContext(participant.character_name)
  }));
}

function baseRecord() {
  return createLoungeGroupRecord({
    id: 'conv_lounge_test',
    week: 3,
    participants: PARTICIPANTS,
    conversationActorContexts: actorContexts(),
    locationName: '寮の談話室',
    visibleSituation: '夜の談話室。三人がソファに沈み込んでいる。'
  });
}

const EMOTION = { expression: 'joy', face_emotion_variant_id: 'face_joy' };

test('lounge source_type is registered in the injected-scene closed set', () => {
  assert.equal(LOUNGE_SOURCE_TYPE, 'lounge');
  assert.ok(INJECTED_SCENE_SOURCE_TYPES.has('lounge'));
});

test('createLoungeGroupRecord builds a validated round-1 record with an empty transcript', () => {
  const record = baseRecord();
  assert.equal(record.source_type, 'lounge');
  assert.equal(record.messages.length, 0);
  assert.equal(record.cursor.round_number, 1);
  assert.equal(record.cursor.next_speaker_index, 0);
  assert.equal(record.cursor.speaker_order.length, LOUNGE_PARTICIPANT_COUNT);
  assert.deepEqual([...record.cursor.speaker_order].sort(), PARTICIPANTS.map((p) => p.character_id).sort());
  assert.equal(loungeActorContextFor(record, 'character_003').sections[0].entries[0].title, 'モナ');
});

test('appendLoungeAssistantMessage advances the NPC cursor in speaker-order, stamping speaker identity', () => {
  let record = baseRecord();
  const spokenIds = [];
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    const speaker = currentLoungeSpeaker(record);
    assert.ok(speaker, 'an NPC is due to speak');
    spokenIds.push(speaker.character_id);
    record = appendLoungeAssistantMessage(record, { characterId: speaker.character_id, content: `${speaker.character_name}の発話${turn}`, emotion: EMOTION });
    const last = record.messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.equal(last.character_id, speaker.character_id);
    assert.equal(last.character_name, speaker.character_name);
    assert.equal(last.expression, 'joy');
    assert.equal(last.face_emotion_variant_id, 'face_joy');
  }
  assert.deepEqual(spokenIds, record.cursor.speaker_order, 'NPCs speak in the round speaker order');
  assert.equal(record.cursor.next_speaker_index, LOUNGE_PARTICIPANT_COUNT);
  assert.equal(currentLoungeSpeaker(record), null, 'the player is due after all NPCs');
});

test('appendLoungeAssistantMessage rejects a speaker who is not the cursor turn', () => {
  const record = baseRecord();
  const notCurrent = PARTICIPANTS.find((participant) => participant.character_id !== currentLoungeSpeaker(record).character_id);
  assert.throws(() => appendLoungeAssistantMessage(record, { characterId: notCurrent.character_id, content: 'x', emotion: EMOTION }), /cursor turn/);
});

test('appendLoungeAssistantMessage rejects an NPC utterance when the player is due', () => {
  let record = baseRecord();
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    const speaker = currentLoungeSpeaker(record);
    record = appendLoungeAssistantMessage(record, { characterId: speaker.character_id, content: 'x', emotion: EMOTION });
  }
  const first = PARTICIPANTS[0];
  assert.throws(() => appendLoungeAssistantMessage(record, { characterId: first.character_id, content: 'x', emotion: EMOTION }), /player speaks next/);
});

test('appendLoungePlayerMessage opens the next round with a fresh deterministic order', () => {
  let record = baseRecord();
  assert.throws(() => appendLoungePlayerMessage(record, 'まだ早い'), /not open/);
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    const speaker = currentLoungeSpeaker(record);
    record = appendLoungeAssistantMessage(record, { characterId: speaker.character_id, content: 'x', emotion: EMOTION });
  }
  const round1Order = record.cursor.speaker_order;
  record = appendLoungePlayerMessage(record, 'なるほど、みんなの意見はわかった。');
  assert.equal(record.messages.at(-1).role, 'user');
  assert.equal(record.cursor.round_number, 2);
  assert.equal(record.cursor.next_speaker_index, 0);
  assert.deepEqual([...record.cursor.speaker_order].sort(), PARTICIPANTS.map((p) => p.character_id).sort());
  assert.ok(currentLoungeSpeaker(record), 'an NPC opens round 2');
  // Round 2 order is independently drawn; assert it is still a valid permutation (may or may not equal round 1).
  assert.equal(new Set(record.cursor.speaker_order).size, LOUNGE_PARTICIPANT_COUNT);
  void round1Order;
});

test('validator rejects a malformed record: bad participant count, non-participant speaker, top-level completion', () => {
  const record = baseRecord();

  assert.throws(() => validateLoungeGroupRecord({ ...record, participants: record.participants.slice(0, 2) }), /exactly 3/);

  // A message whose speaker is not among the participants must not be completed from a top-level actor.
  const foreignSpeaker = {
    ...record,
    messages: [{ role: 'assistant', character_id: 'character_099', character_name: '部外者', content: 'x', expression: 'joy', face_emotion_variant_id: 'face_joy' }]
  };
  assert.throws(() => validateLoungeGroupRecord(foreignSpeaker), /not a participant/);

  // A user message may not carry a character_id (no actor identity on the player line).
  const userWithActor = {
    ...record,
    messages: [{ role: 'user', content: 'x', character_id: 'character_007' }]
  };
  assert.throws(() => validateLoungeGroupRecord(userWithActor), /unexpected key/);

  // An assistant message whose display name disagrees with the participant is rejected.
  const nameMismatch = {
    ...record,
    messages: [{ role: 'assistant', character_id: 'character_007', character_name: '別名', content: 'x', expression: 'joy', face_emotion_variant_id: 'face_joy' }]
  };
  assert.throws(() => validateLoungeGroupRecord(nameMismatch), /does not match the participant/);

  // A face variant that disagrees with the expression is rejected.
  const badFace = {
    ...record,
    messages: [{ role: 'assistant', character_id: 'character_007', character_name: 'ミラ', content: 'x', expression: 'joy', face_emotion_variant_id: 'face_anger' }]
  };
  assert.throws(() => validateLoungeGroupRecord(badFace), /face_joy/);
});

test('validator rejects a forged cursor whose speaker order is not the deterministic round order', () => {
  const record = baseRecord();
  const reversed = [...record.cursor.speaker_order].reverse();
  // reversed is only guaranteed to differ when the deterministic order is not a palindrome; construct a definitely
  // wrong order by rotating until it differs.
  let forged = reversed;
  if (forged.every((id, index) => id === record.cursor.speaker_order[index])) {
    forged = [record.cursor.speaker_order[1], record.cursor.speaker_order[2], record.cursor.speaker_order[0]];
  }
  assert.throws(() => validateLoungeGroupRecord({ ...record, cursor: { ...record.cursor, speaker_order: forged } }), /does not match the deterministic order/);
});

test('validator rejects an actor context that is missing a participant or null', () => {
  const record = baseRecord();
  assert.throws(() => validateLoungeGroupRecord({ ...record, conversation_actor_contexts: record.conversation_actor_contexts.slice(0, 2) }), /exactly 3/);
  const withNull = {
    ...record,
    conversation_actor_contexts: record.conversation_actor_contexts.map((entry, index) => (index === 0 ? { ...entry, conversation_actor_context: { sections: [] } } : entry))
  };
  assert.throws(() => validateLoungeGroupRecord(withNull), /sections must not be empty/);
});
