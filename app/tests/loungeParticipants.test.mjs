// 談話室 participant selection + per-round speaker order: week-seed determinism, roster<3 fail-fast, distinctness,
// and (conversation id, round number) determinism of the NPC speaking order.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectLoungeParticipants,
  loungeRoundSpeakerOrder,
  LOUNGE_PARTICIPANT_COUNT
} from '../src/llm/loungeParticipants.mjs';

function roster(count) {
  return Array.from({ length: count }, (_, index) => {
    const id = `character_${String(index + 1).padStart(3, '0')}`;
    return { character_id: id, character_name: `名前${index + 1}` };
  });
}

test('lounge seats exactly three participants', () => {
  const participants = selectLoungeParticipants({ roster: roster(10), week: 4 });
  assert.equal(participants.length, LOUNGE_PARTICIPANT_COUNT);
  assert.equal(LOUNGE_PARTICIPANT_COUNT, 3);
  const ids = participants.map((participant) => participant.character_id);
  assert.equal(new Set(ids).size, 3, 'participants are distinct');
  for (const participant of participants) {
    assert.match(participant.character_id, /^character_\d{3}$/);
    assert.ok(participant.character_name);
  }
});

test('lounge participant selection is week-seed deterministic and week-varying', () => {
  const week4a = selectLoungeParticipants({ roster: roster(30), week: 4 });
  const week4b = selectLoungeParticipants({ roster: roster(30), week: 4 });
  assert.deepEqual(week4a, week4b, 'same week yields the same three participants in the same order');

  const week5 = selectLoungeParticipants({ roster: roster(30), week: 5 });
  const differs = week4a.some((participant, index) => participant.character_id !== week5[index]?.character_id);
  assert.ok(differs, 'a different week yields a different draw');
});

test('lounge participant selection throws when the roster is smaller than three', () => {
  assert.throws(() => selectLoungeParticipants({ roster: roster(2), week: 0 }), /at least 3/);
});

test('lounge participant selection fail-fasts on malformed roster entries and duplicates', () => {
  assert.throws(() => selectLoungeParticipants({ roster: [{ character_id: 'lina', character_name: 'リナ' }, ...roster(3)], week: 0 }), /selectable character id/);
  assert.throws(() => selectLoungeParticipants({ roster: [{ character_id: 'character_001', character_name: '' }, ...roster(3)], week: 0 }), /character_name is required/);
  const dup = [{ character_id: 'character_001', character_name: 'A' }, { character_id: 'character_001', character_name: 'B' }, ...roster(3)];
  assert.throws(() => selectLoungeParticipants({ roster: dup, week: 0 }), /duplicate character_id/);
  assert.throws(() => selectLoungeParticipants({ roster: 'nope', week: 0 }), /must be an array/);
  assert.throws(() => selectLoungeParticipants({ roster: roster(5), week: -1 }), /non-negative integer/);
});

test('lounge round speaker order is a per-round permutation, deterministic in (conversation id, round)', () => {
  const participantIds = ['character_007', 'character_003', 'character_020'];
  const round1a = loungeRoundSpeakerOrder({ conversationId: 'conv_lounge_x', roundNumber: 1, participantIds });
  const round1b = loungeRoundSpeakerOrder({ conversationId: 'conv_lounge_x', roundNumber: 1, participantIds });
  assert.deepEqual(round1a, round1b, 'same (id, round) is deterministic');
  assert.deepEqual([...round1a].sort(), [...participantIds].sort(), 'the order is a permutation of the participants');

  const roundsDiffer = [];
  for (let round = 1; round <= 6; round += 1) {
    roundsDiffer.push(loungeRoundSpeakerOrder({ conversationId: 'conv_lounge_x', roundNumber: round, participantIds }).join(','));
  }
  assert.ok(new Set(roundsDiffer).size > 1, 'the order varies across rounds');

  // The conversation id is an independent seed axis: sweeping round-1 orders across several ids yields more than
  // one distinct order (a single fixed order across all ids would mean the id did not seed the draw).
  const acrossConversations = new Set();
  for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f']) {
    acrossConversations.add(loungeRoundSpeakerOrder({ conversationId: `conv_lounge_${suffix}`, roundNumber: 1, participantIds }).join(','));
  }
  assert.ok(acrossConversations.size > 1, 'a different conversation id is an independent draw');
});

test('lounge round speaker order fail-fasts on wrong participant count / bad ids / bad round', () => {
  assert.throws(() => loungeRoundSpeakerOrder({ conversationId: 'conv_x', roundNumber: 1, participantIds: ['character_001', 'character_002'] }), /exactly 3/);
  assert.throws(() => loungeRoundSpeakerOrder({ conversationId: 'conv_x', roundNumber: 1, participantIds: ['character_001', 'character_002', 'lina'] }), /selectable character id/);
  assert.throws(() => loungeRoundSpeakerOrder({ conversationId: 'conv_x', roundNumber: 1, participantIds: ['character_001', 'character_001', 'character_002'] }), /distinct/);
  assert.throws(() => loungeRoundSpeakerOrder({ conversationId: '', roundNumber: 1, participantIds: ['character_001', 'character_002', 'character_003'] }), /conversation id/);
  assert.throws(() => loungeRoundSpeakerOrder({ conversationId: 'conv_x', roundNumber: 0, participantIds: ['character_001', 'character_002', 'character_003'] }), /positive integer|round number/);
});
