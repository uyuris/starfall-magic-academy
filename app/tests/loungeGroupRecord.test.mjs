// 談話室 group record: strict validator (participants / speaker-scoped messages / cursor determinism /
// participant lifecycle projection / no top-level actor completion), plus the create + apply cursor progression
// (NPC round → player → next round) including the v2 optional departure appended atomically with the normal
// utterance and the cursor's fast-forward over inactive suffix positions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { INJECTED_SCENE_SOURCE_TYPES, LOUNGE_SOURCE_TYPE } from '../src/routingMetaContext.mjs';
import {
  createLoungeGroupRecord,
  validateLoungeGroupRecord,
  currentLoungeSpeaker,
  loungeActorContextFor,
  applyLoungeAssistantTurn,
  appendLoungePlayerMessage,
  loungeAllParticipantsExited,
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

test('createLoungeGroupRecord builds a validated round-1 record with an empty transcript and all participants active', () => {
  const record = baseRecord();
  assert.equal(record.source_type, 'lounge');
  assert.equal(record.messages.length, 0);
  assert.equal(record.cursor.round_number, 1);
  assert.equal(record.cursor.next_speaker_index, 0);
  assert.equal(record.cursor.speaker_order.length, LOUNGE_PARTICIPANT_COUNT);
  assert.deepEqual([...record.cursor.speaker_order].sort(), PARTICIPANTS.map((p) => p.character_id).sort());
  assert.equal(loungeActorContextFor(record, 'character_003').sections[0].entries[0].title, 'モナ');
  // Lifecycle projection: exactly one entry per original participant, all active, no exit boundary yet.
  assert.equal(record.participant_lifecycle.length, LOUNGE_PARTICIPANT_COUNT);
  assert.deepEqual(record.participant_lifecycle.map((entry) => entry.character_id), PARTICIPANTS.map((p) => p.character_id));
  for (const entry of record.participant_lifecycle) {
    assert.equal(entry.status, 'active');
    assert.equal(Object.hasOwn(entry, 'exited_after_message_count'), false, 'active entries carry no boundary field');
  }
  assert.equal(loungeAllParticipantsExited(record), false);
});

test('applyLoungeAssistantTurn (continue) advances the NPC cursor in speaker-order, stamping speaker identity', () => {
  let record = baseRecord();
  const spokenIds = [];
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    const speaker = currentLoungeSpeaker(record);
    assert.ok(speaker, 'an NPC is due to speak');
    spokenIds.push(speaker.character_id);
    record = applyLoungeAssistantTurn(record, { characterId: speaker.character_id, content: `${speaker.character_name}の発話${turn}`, emotion: EMOTION });
    const last = record.messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.equal(last.character_id, speaker.character_id);
    assert.equal(last.character_name, speaker.character_name);
    assert.equal(last.expression, 'joy');
    assert.equal(last.face_emotion_variant_id, 'face_joy');
    // No departure → all participants remain active.
    assert.ok(record.participant_lifecycle.every((entry) => entry.status === 'active'));
  }
  assert.deepEqual(spokenIds, record.cursor.speaker_order, 'NPCs speak in the round speaker order');
  assert.equal(record.cursor.next_speaker_index, LOUNGE_PARTICIPANT_COUNT);
  assert.equal(currentLoungeSpeaker(record), null, 'the player is due after all NPCs');
});

test('applyLoungeAssistantTurn rejects a speaker who is not the cursor turn', () => {
  const record = baseRecord();
  const notCurrent = PARTICIPANTS.find((participant) => participant.character_id !== currentLoungeSpeaker(record).character_id);
  assert.throws(() => applyLoungeAssistantTurn(record, { characterId: notCurrent.character_id, content: 'x', emotion: EMOTION }), /cursor turn/);
});

test('applyLoungeAssistantTurn rejects an NPC utterance when the player is due', () => {
  let record = baseRecord();
  for (let turn = 0; turn < LOUNGE_PARTICIPANT_COUNT; turn += 1) {
    const speaker = currentLoungeSpeaker(record);
    record = applyLoungeAssistantTurn(record, { characterId: speaker.character_id, content: 'x', emotion: EMOTION });
  }
  const first = PARTICIPANTS[0];
  assert.throws(() => applyLoungeAssistantTurn(record, { characterId: first.character_id, content: 'x', emotion: EMOTION }), /player speaks next/);
});

test('applyLoungeAssistantTurn (departure) appends both messages atomically, transitions lifecycle to exited, and fast-forwards over the inactive suffix', () => {
  let record = baseRecord();
  const firstSpeaker = currentLoungeSpeaker(record);
  record = applyLoungeAssistantTurn(record, {
    characterId: firstSpeaker.character_id,
    content: 'ここまでにしよう。',
    emotion: EMOTION,
    departure: { content: 'それじゃあ、みんなはこのままゆっくり。', emotion: EMOTION }
  });
  // Two assistant messages appended in one transition, both same speaker, both same emotion.
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[0].character_id, firstSpeaker.character_id);
  assert.equal(record.messages[0].content, 'ここまでにしよう。');
  assert.equal(record.messages[1].character_id, firstSpeaker.character_id);
  assert.equal(record.messages[1].content, 'それじゃあ、みんなはこのままゆっくり。');
  assert.equal(record.messages[0].expression, 'joy');
  assert.equal(record.messages[1].expression, 'joy');
  // Lifecycle: only this speaker exited, boundary = 2 (both appended messages).
  const exitedEntry = record.participant_lifecycle.find((entry) => entry.character_id === firstSpeaker.character_id);
  assert.equal(exitedEntry.status, 'exited');
  assert.equal(exitedEntry.exited_after_message_count, 2);
  const otherEntries = record.participant_lifecycle.filter((entry) => entry.character_id !== firstSpeaker.character_id);
  assert.ok(otherEntries.every((entry) => entry.status === 'active'));
  // Cursor advanced by one and did NOT fast-forward past active NPCs (only the first speaker exited).
  assert.equal(record.cursor.next_speaker_index, 1);
  assert.equal(currentLoungeSpeaker(record).character_id, record.cursor.speaker_order[1]);
});

test('applyLoungeAssistantTurn fast-forwards the cursor over an inactive tail so the player turn opens when no active NPC remains this round', () => {
  let record = baseRecord();
  // First two speakers exit in the same round. After the second exit the tail (index 2) may be active or exited —
  // it depends on the deterministic order — but the cursor advance must skip inactive positions and stop at the
  // next active or at index 3.
  const speaker1 = currentLoungeSpeaker(record);
  record = applyLoungeAssistantTurn(record, {
    characterId: speaker1.character_id,
    content: 'x',
    emotion: EMOTION,
    departure: { content: 'y', emotion: EMOTION }
  });
  const speaker2 = currentLoungeSpeaker(record);
  assert.ok(speaker2, 'a second active NPC is still due');
  record = applyLoungeAssistantTurn(record, {
    characterId: speaker2.character_id,
    content: 'x2',
    emotion: EMOTION,
    departure: { content: 'y2', emotion: EMOTION }
  });
  // After two exits, only speaker_order[2] can be active. The cursor is either at that index (still due to speak
  // this round) or at LOUNGE_PARTICIPANT_COUNT if speaker_order[2] is one of the exited ones (already skipped).
  const activeSet = new Set(record.participant_lifecycle.filter((entry) => entry.status === 'active').map((entry) => entry.character_id));
  assert.equal(activeSet.size, 1);
  const thirdSlotId = record.cursor.speaker_order[2];
  if (activeSet.has(thirdSlotId)) {
    assert.equal(record.cursor.next_speaker_index, 2);
    assert.equal(currentLoungeSpeaker(record).character_id, thirdSlotId);
  } else {
    assert.equal(record.cursor.next_speaker_index, LOUNGE_PARTICIPANT_COUNT);
    assert.equal(currentLoungeSpeaker(record), null);
  }
});

test('applyLoungeAssistantTurn refuses an already-exited speaker (no re-activation path)', () => {
  let record = baseRecord();
  const firstSpeaker = currentLoungeSpeaker(record);
  record = applyLoungeAssistantTurn(record, {
    characterId: firstSpeaker.character_id,
    content: 'x',
    emotion: EMOTION,
    departure: { content: 'y', emotion: EMOTION }
  });
  // Even if the caller forged the cursor to point at the exited speaker, the strict validator + write-boundary
  // active check must refuse the turn (belt-and-suspenders). Rewinding the cursor is a corrupted record path, not
  // a supported re-entry.
  const forged = { ...record, cursor: { ...record.cursor, next_speaker_index: 0 } };
  assert.throws(() => applyLoungeAssistantTurn(forged, { characterId: firstSpeaker.character_id, content: 'x', emotion: EMOTION }), /not active/);
});

test('appendLoungePlayerMessage opens the next round with a fresh deterministic order and skips exited participants at the front', () => {
  let record = baseRecord();
  assert.throws(() => appendLoungePlayerMessage(record, 'まだ早い'), /not open/);
  // Round 1: first speaker exits, other two speak normally.
  const speaker1 = currentLoungeSpeaker(record);
  record = applyLoungeAssistantTurn(record, {
    characterId: speaker1.character_id,
    content: 'x',
    emotion: EMOTION,
    departure: { content: 'y', emotion: EMOTION }
  });
  while (currentLoungeSpeaker(record) !== null) {
    const speaker = currentLoungeSpeaker(record);
    record = applyLoungeAssistantTurn(record, { characterId: speaker.character_id, content: 'z', emotion: EMOTION });
  }
  record = appendLoungePlayerMessage(record, 'なるほど、みんなの意見はわかった。');
  assert.equal(record.messages.at(-1).role, 'user');
  assert.equal(record.cursor.round_number, 2);
  assert.deepEqual([...record.cursor.speaker_order].sort(), PARTICIPANTS.map((p) => p.character_id).sort(), 'round 2 order is still a permutation of the ORIGINAL three participants');
  // The opening index is at the first active NPC in the new round's deterministic order.
  const openingSlotId = record.cursor.speaker_order[record.cursor.next_speaker_index];
  const openingEntry = record.participant_lifecycle.find((entry) => entry.character_id === openingSlotId);
  assert.equal(openingEntry.status, 'active');
  // And every earlier slot (if any) is an exited participant.
  for (let index = 0; index < record.cursor.next_speaker_index; index += 1) {
    const skippedId = record.cursor.speaker_order[index];
    assert.equal(record.participant_lifecycle.find((entry) => entry.character_id === skippedId).status, 'exited');
  }
});

test('appendLoungePlayerMessage rejects a player turn when every participant has already exited', () => {
  let record = baseRecord();
  // Force all three participants to exit in round 1.
  while (currentLoungeSpeaker(record) !== null) {
    const speaker = currentLoungeSpeaker(record);
    record = applyLoungeAssistantTurn(record, {
      characterId: speaker.character_id,
      content: 'x',
      emotion: EMOTION,
      departure: { content: 'y', emotion: EMOTION }
    });
  }
  assert.equal(loungeAllParticipantsExited(record), true);
  assert.equal(record.cursor.next_speaker_index, LOUNGE_PARTICIPANT_COUNT);
  assert.equal(currentLoungeSpeaker(record), null);
  assert.throws(() => appendLoungePlayerMessage(record, 'まだ話したい'), /every participant has exited/);
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

test('validator rejects a malformed participant_lifecycle: wrong length, wrong order, extra key on active, missing/OOB boundary on exited', () => {
  const record = baseRecord();

  // Wrong length.
  assert.throws(() => validateLoungeGroupRecord({ ...record, participant_lifecycle: record.participant_lifecycle.slice(0, 2) }), /exactly 3/);

  // Character order must match participants order.
  const swapped = [record.participant_lifecycle[1], record.participant_lifecycle[0], record.participant_lifecycle[2]];
  assert.throws(() => validateLoungeGroupRecord({ ...record, participant_lifecycle: swapped }), /must match participants/);

  // An active entry may not carry the boundary field (exact-key strict).
  const activeWithBoundary = record.participant_lifecycle.map((entry, index) => (index === 0 ? { ...entry, exited_after_message_count: 1 } : entry));
  assert.throws(() => validateLoungeGroupRecord({ ...record, participant_lifecycle: activeWithBoundary }), /unexpected key/);

  // An exited entry must carry a boundary within 1..messages.length.
  const exitedNoBoundary = record.participant_lifecycle.map((entry, index) => (index === 0 ? { character_id: entry.character_id, status: 'exited' } : entry));
  assert.throws(() => validateLoungeGroupRecord({ ...record, participant_lifecycle: exitedNoBoundary }), /missing required key/);

  const exitedOutOfRange = record.participant_lifecycle.map((entry, index) => (index === 0 ? { character_id: entry.character_id, status: 'exited', exited_after_message_count: 5 } : entry));
  assert.throws(() => validateLoungeGroupRecord({ ...record, participant_lifecycle: exitedOutOfRange }), /exited_after_message_count/);

  // Unknown status value.
  const unknownStatus = record.participant_lifecycle.map((entry, index) => (index === 0 ? { character_id: entry.character_id, status: 'left' } : entry));
  assert.throws(() => validateLoungeGroupRecord({ ...record, participant_lifecycle: unknownStatus }), /active or exited/);
});
