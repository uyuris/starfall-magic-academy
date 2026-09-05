// 談話室 (lounge) group conversation record: the single source of truth for a 3 NPC + プレイヤー round conversation.
// Unlike a 1:1 conversation record (one top-level actor, every assistant message that actor's), a group record
// carries the three seated participants, an actor-context snapshot per participant, a transcript whose every
// assistant message names its own speaker, an authoritative cursor (round number, that round's original NPC speaking
// order, and the index of the next NPC slot to speak), and a participant lifecycle projection recording each
// participant's active/exited status and — for an exited participant — the message-count boundary at which they
// left. The original participants array never shrinks: past speech and terminal finalization scope remain the full
// three even after a mid-conversation departure. The cursor's speaker_order is always the deterministic
// (conversation id, round number) shuffle of the original three; inactive suffix positions are skipped by the
// turn transition, not removed from the order. A strict validator runs at the write boundary: it never completes a
// message speaker from a top-level actor, rejects a speaker outside the participant set, rejects a cursor whose
// speaker order disagrees with the deterministic shuffle, and rejects a lifecycle projection that disagrees with
// the participants. Malformed input throws — there is no silent repair.

import { faceExpressionSet } from '../faceExpressions.mjs';
import { LOUNGE_SOURCE_TYPE } from '../routingMetaContext.mjs';
import { normalizeConversationActorContext } from './conversationActorContext.mjs';
import { LOUNGE_PARTICIPANT_COUNT, loungeRoundSpeakerOrder } from './loungeParticipants.mjs';

export { LOUNGE_SOURCE_TYPE, LOUNGE_PARTICIPANT_COUNT };

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;
const CHARACTER_ID_PATTERN = /^character_\d{3}$/;

function assertExactKeys(value, expectedKeys, label) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has an unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function selectableCharacterId(value, label) {
  const normalized = requiredString(value, label);
  if (!CHARACTER_ID_PATTERN.test(normalized)) throw new Error(`${label} must be a selectable character id: ${normalized}`);
  return normalized;
}

function validateParticipants(value) {
  if (!Array.isArray(value) || value.length !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge record participants must be exactly ${LOUNGE_PARTICIPANT_COUNT} entries`);
  }
  const seen = new Set();
  const participants = value.map((entry, index) => {
    const object = requiredObject(entry, `lounge record participants[${index}]`);
    assertExactKeys(object, ['character_id', 'character_name'], `lounge record participants[${index}]`);
    const characterId = selectableCharacterId(object.character_id, `lounge record participants[${index}].character_id`);
    if (seen.has(characterId)) throw new Error(`lounge record participants has a duplicate character_id: ${characterId}`);
    seen.add(characterId);
    return {
      character_id: characterId,
      character_name: requiredString(object.character_name, `lounge record participants[${index}].character_name`)
    };
  });
  return participants;
}

function validateActorContexts(value, participantsById) {
  if (!Array.isArray(value) || value.length !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge record conversation_actor_contexts must be exactly ${LOUNGE_PARTICIPANT_COUNT} entries`);
  }
  const seen = new Set();
  const contexts = value.map((entry, index) => {
    const object = requiredObject(entry, `lounge record conversation_actor_contexts[${index}]`);
    assertExactKeys(object, ['character_id', 'conversation_actor_context'], `lounge record conversation_actor_contexts[${index}]`);
    const characterId = selectableCharacterId(object.character_id, `lounge record conversation_actor_contexts[${index}].character_id`);
    if (!participantsById.has(characterId)) {
      throw new Error(`lounge record conversation_actor_contexts[${index}].character_id is not a participant: ${characterId}`);
    }
    if (seen.has(characterId)) throw new Error(`lounge record conversation_actor_contexts has a duplicate character_id: ${characterId}`);
    seen.add(characterId);
    const context = normalizeConversationActorContext(object.conversation_actor_context);
    if (context === null) {
      throw new Error(`lounge record conversation_actor_contexts[${index}].conversation_actor_context must not be null`);
    }
    return { character_id: characterId, conversation_actor_context: context };
  });
  return contexts;
}

function validateMessage(entry, index, participantsById) {
  const object = requiredObject(entry, `lounge record messages[${index}]`);
  const role = requiredString(object.role, `lounge record messages[${index}].role`);
  if (role === 'user') {
    assertExactKeys(object, ['role', 'content'], `lounge record messages[${index}]`);
    return { role: 'user', content: requiredString(object.content, `lounge record messages[${index}].content`) };
  }
  if (role === 'assistant') {
    assertExactKeys(object, ['role', 'character_id', 'character_name', 'content', 'expression', 'face_emotion_variant_id'], `lounge record messages[${index}]`);
    const characterId = selectableCharacterId(object.character_id, `lounge record messages[${index}].character_id`);
    const participant = participantsById.get(characterId);
    if (!participant) throw new Error(`lounge record messages[${index}].character_id is not a participant: ${characterId}`);
    const characterName = requiredString(object.character_name, `lounge record messages[${index}].character_name`);
    if (characterName !== participant.character_name) {
      throw new Error(`lounge record messages[${index}].character_name does not match the participant: ${characterName} != ${participant.character_name}`);
    }
    const expression = requiredString(object.expression, `lounge record messages[${index}].expression`);
    if (!faceExpressionSet.has(expression)) throw new Error(`lounge record messages[${index}].expression is not a known face expression: ${expression}`);
    const faceVariant = requiredString(object.face_emotion_variant_id, `lounge record messages[${index}].face_emotion_variant_id`);
    if (faceVariant !== `face_${expression}`) {
      throw new Error(`lounge record messages[${index}].face_emotion_variant_id must be face_${expression}, got ${faceVariant}`);
    }
    return {
      role: 'assistant',
      character_id: characterId,
      character_name: characterName,
      content: requiredString(object.content, `lounge record messages[${index}].content`),
      expression,
      face_emotion_variant_id: faceVariant
    };
  }
  throw new Error(`lounge record messages[${index}].role must be user or assistant, got ${role}`);
}

// The participant lifecycle projection has exactly one entry per original participant, in the same order as
// `participants`. `active` entries carry only { character_id, status }; `exited` entries additionally carry
// `exited_after_message_count` (the messages.length boundary immediately after the participant's own departure
// utterance was appended). The active → exited transition is one-way — an entry that has recorded a boundary is
// never re-activated.
function validateParticipantLifecycle(value, participantIds, messagesLength) {
  if (!Array.isArray(value) || value.length !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge record participant_lifecycle must be exactly ${LOUNGE_PARTICIPANT_COUNT} entries`);
  }
  const lifecycle = value.map((entry, index) => {
    const object = requiredObject(entry, `lounge record participant_lifecycle[${index}]`);
    const status = requiredString(object.status, `lounge record participant_lifecycle[${index}].status`);
    if (status !== 'active' && status !== 'exited') {
      throw new Error(`lounge record participant_lifecycle[${index}].status must be active or exited, got ${status}`);
    }
    if (status === 'active') {
      assertExactKeys(object, ['character_id', 'status'], `lounge record participant_lifecycle[${index}]`);
    } else {
      assertExactKeys(object, ['character_id', 'status', 'exited_after_message_count'], `lounge record participant_lifecycle[${index}]`);
    }
    const characterId = selectableCharacterId(object.character_id, `lounge record participant_lifecycle[${index}].character_id`);
    if (characterId !== participantIds[index]) {
      throw new Error(`lounge record participant_lifecycle[${index}].character_id must match participants[${index}]: ${characterId} != ${participantIds[index]}`);
    }
    if (status === 'active') {
      return { character_id: characterId, status: 'active' };
    }
    const boundary = object.exited_after_message_count;
    if (!Number.isInteger(boundary) || boundary < 1 || boundary > messagesLength) {
      throw new Error(`lounge record participant_lifecycle[${index}].exited_after_message_count must be an integer in 1..${messagesLength}, got ${boundary}`);
    }
    return { character_id: characterId, status: 'exited', exited_after_message_count: boundary };
  });
  return lifecycle;
}

function validateCursor(value, { conversationId, participantIds }) {
  const object = requiredObject(value, 'lounge record cursor');
  assertExactKeys(object, ['round_number', 'speaker_order', 'next_speaker_index'], 'lounge record cursor');
  const roundNumber = object.round_number;
  if (!Number.isInteger(roundNumber) || roundNumber < 1) throw new Error('lounge record cursor.round_number must be a positive integer');
  if (!Array.isArray(object.speaker_order) || object.speaker_order.length !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge record cursor.speaker_order must be exactly ${LOUNGE_PARTICIPANT_COUNT} entries`);
  }
  const speakerOrder = object.speaker_order.map((id, index) => selectableCharacterId(id, `lounge record cursor.speaker_order[${index}]`));
  const participantSet = new Set(participantIds);
  if (new Set(speakerOrder).size !== speakerOrder.length || speakerOrder.some((id) => !participantSet.has(id))) {
    throw new Error('lounge record cursor.speaker_order must be a permutation of the participant ids');
  }
  // The cursor's speaker order is authoritative and must match the deterministic (conversation id, round number)
  // shuffle of the ORIGINAL participants — a stored order that disagrees is a corrupted/forged cursor, and an
  // active-only sub-order is not accepted either (the inactive suffix is skipped by the turn transition, not by
  // rewriting the order).
  const expectedOrder = loungeRoundSpeakerOrder({ conversationId, roundNumber, participantIds });
  if (speakerOrder.some((id, index) => id !== expectedOrder[index])) {
    throw new Error(`lounge record cursor.speaker_order does not match the deterministic order for round ${roundNumber}`);
  }
  const nextSpeakerIndex = object.next_speaker_index;
  if (!Number.isInteger(nextSpeakerIndex) || nextSpeakerIndex < 0 || nextSpeakerIndex > LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge record cursor.next_speaker_index must be an integer in 0..${LOUNGE_PARTICIPANT_COUNT}`);
  }
  return { round_number: roundNumber, speaker_order: speakerOrder, next_speaker_index: nextSpeakerIndex };
}

// Validates a lounge group record top to bottom and returns a normalized copy. Every conclusion the orchestrator
// and the finalizer draw from a record — who the participants are, who is still active, who spoke each line, whose
// turn is next, and where each exited participant's witness boundary lies — is pinned here at the write boundary,
// so a malformed record can never reach generation or persistence.
export function validateLoungeGroupRecord(record) {
  const object = requiredObject(record, 'lounge record');
  assertExactKeys(
    object,
    ['id', 'source_type', 'week', 'location_name', 'visible_situation', 'participants', 'conversation_actor_contexts', 'participant_lifecycle', 'messages', 'cursor'],
    'lounge record'
  );
  const id = requiredString(object.id, 'lounge record id');
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error(`lounge record id must be a valid conversation id: ${id}`);
  if (object.source_type !== LOUNGE_SOURCE_TYPE) throw new Error(`lounge record source_type must be ${LOUNGE_SOURCE_TYPE}, got ${object.source_type}`);
  const week = nonNegativeInteger(object.week, 'lounge record week');
  const locationName = requiredString(object.location_name, 'lounge record location_name');
  const visibleSituation = requiredString(object.visible_situation, 'lounge record visible_situation');
  const participants = validateParticipants(object.participants);
  const participantsById = new Map(participants.map((participant) => [participant.character_id, participant]));
  const participantIds = participants.map((participant) => participant.character_id);
  const conversationActorContexts = validateActorContexts(object.conversation_actor_contexts, participantsById);
  if (!Array.isArray(object.messages)) throw new Error('lounge record messages must be an array');
  const messages = object.messages.map((entry, index) => validateMessage(entry, index, participantsById));
  const participantLifecycle = validateParticipantLifecycle(object.participant_lifecycle, participantIds, messages.length);
  const cursor = validateCursor(object.cursor, { conversationId: id, participantIds });
  return {
    id,
    source_type: LOUNGE_SOURCE_TYPE,
    week,
    location_name: locationName,
    visible_situation: visibleSituation,
    participants,
    conversation_actor_contexts: conversationActorContexts,
    participant_lifecycle: participantLifecycle,
    messages,
    cursor
  };
}

// True when every participant lifecycle entry has transitioned to `exited`.
export function loungeAllParticipantsExited(record) {
  const validated = validateLoungeGroupRecord(record);
  return validated.participant_lifecycle.every((entry) => entry.status === 'exited');
}

// The active-projection map indexed by character_id — used by the turn transition to fast-forward the cursor and by
// the API to reject a player turn when nobody is left.
function activeSetFrom(lifecycle) {
  const set = new Set();
  for (const entry of lifecycle) {
    if (entry.status === 'active') set.add(entry.character_id);
  }
  return set;
}

// Advances the cursor over any inactive suffix positions, stopping at the next active NPC or at LOUNGE_PARTICIPANT_COUNT
// when no active NPC remains in this round. Returns the new index. The caller has already advanced the cursor past
// the just-spoken speaker; this only skips over the tail.
function fastForwardOverInactive(speakerOrder, startIndex, activeSet) {
  let index = startIndex;
  while (index < LOUNGE_PARTICIPANT_COUNT && !activeSet.has(speakerOrder[index])) {
    index += 1;
  }
  return index;
}

// Builds the initial lounge record: no messages yet, all three participants active, cursor at round 1 with that
// round's deterministic NPC order and the first NPC to speak (index 0). The result is validated before it is
// returned, so a bad scene / participant / actor-context input fails here rather than at the first turn.
export function createLoungeGroupRecord({ id, week, participants, conversationActorContexts, locationName, visibleSituation }) {
  const normalizedId = requiredString(id, 'lounge record id');
  if (!CONVERSATION_ID_PATTERN.test(normalizedId)) throw new Error(`lounge record id must be a valid conversation id: ${normalizedId}`);
  const validatedParticipants = validateParticipants(participants);
  const participantIds = validatedParticipants.map((participant) => participant.character_id);
  const speakerOrder = loungeRoundSpeakerOrder({ conversationId: normalizedId, roundNumber: 1, participantIds });
  const participantLifecycle = validatedParticipants.map((participant) => ({
    character_id: participant.character_id,
    status: 'active'
  }));
  return validateLoungeGroupRecord({
    id: normalizedId,
    source_type: LOUNGE_SOURCE_TYPE,
    week,
    location_name: locationName,
    visible_situation: visibleSituation,
    participants: validatedParticipants,
    conversation_actor_contexts: conversationActorContexts,
    participant_lifecycle: participantLifecycle,
    messages: [],
    cursor: { round_number: 1, speaker_order: speakerOrder, next_speaker_index: 0 }
  });
}

// The participant whose NPC turn it is, or null when all NPCs remaining in this round have spoken and the player is
// next. Cursor authority already accounts for inactive suffix positions (turn transition fast-forwards over them),
// so a `next_speaker_index === LOUNGE_PARTICIPANT_COUNT` means "player next" and a valid index always points at an
// active participant.
export function currentLoungeSpeaker(record) {
  const validated = validateLoungeGroupRecord(record);
  const { speaker_order: speakerOrder, next_speaker_index: nextSpeakerIndex } = validated.cursor;
  if (nextSpeakerIndex >= LOUNGE_PARTICIPANT_COUNT) return null;
  const characterId = speakerOrder[nextSpeakerIndex];
  return validated.participants.find((participant) => participant.character_id === characterId);
}

// The stored opening-time actor-context snapshot for one participant (系統知識 + 好感度), selected by character id.
export function loungeActorContextFor(record, characterId) {
  const validated = validateLoungeGroupRecord(record);
  const entry = validated.conversation_actor_contexts.find((context) => context.character_id === characterId);
  if (!entry) throw new Error(`lounge record has no actor context for participant: ${characterId}`);
  return entry.conversation_actor_context;
}

function buildAssistantMessage(participant, { content, emotion, label }) {
  const emotionObject = requiredObject(emotion, `${label} emotion`);
  const expression = requiredString(emotionObject.expression, `${label} emotion.expression`);
  const faceVariant = requiredString(emotionObject.face_emotion_variant_id, `${label} emotion.face_emotion_variant_id`);
  return {
    role: 'assistant',
    character_id: participant.character_id,
    character_name: participant.character_name,
    content: requiredString(content, `${label} content`),
    expression,
    face_emotion_variant_id: faceVariant
  };
}

// Applies one NPC turn atomically. The current speaker's normal utterance is always appended. When `departure` is
// non-null, the current speaker's departure utterance is appended immediately after the normal one AND their
// participant lifecycle entry transitions from active to exited with an `exited_after_message_count` equal to the
// new messages.length. The cursor then advances by one speaker slot and fast-forwards over any inactive suffix.
// Requirements at the write boundary:
//  - the caller-supplied `characterId` matches the cursor speaker (never a claimed identity)
//  - it is an NPC turn (cursor before the round boundary)
//  - the current speaker's lifecycle entry is `active` (already-exited participants cannot speak)
//  - departure content and emotion, when present, are strictly required strings/emotion
// A malformed input throws before any partial write — the caller receives either the fully-applied next record or
// an unchanged record via a thrown error.
export function applyLoungeAssistantTurn(record, { characterId, content, emotion, departure = null }) {
  const validated = validateLoungeGroupRecord(record);
  const { speaker_order: speakerOrder, next_speaker_index: nextSpeakerIndex } = validated.cursor;
  if (nextSpeakerIndex >= LOUNGE_PARTICIPANT_COUNT) {
    throw new Error('lounge round has no remaining NPC turn — the player speaks next');
  }
  const expectedId = speakerOrder[nextSpeakerIndex];
  const normalizedId = selectableCharacterId(characterId, 'lounge assistant message character_id');
  if (normalizedId !== expectedId) {
    throw new Error(`lounge assistant message speaker must be ${expectedId} (cursor turn), got ${normalizedId}`);
  }
  const currentEntry = validated.participant_lifecycle.find((entry) => entry.character_id === normalizedId);
  if (!currentEntry || currentEntry.status !== 'active') {
    throw new Error(`lounge assistant message speaker is not active: ${normalizedId}`);
  }
  const participant = validated.participants.find((entry) => entry.character_id === normalizedId);
  const normalMessage = buildAssistantMessage(participant, { content, emotion, label: 'lounge assistant message' });
  const appendedMessages = [normalMessage];
  let nextLifecycle = validated.participant_lifecycle;
  if (departure !== null) {
    const departureObject = requiredObject(departure, 'lounge assistant message departure');
    const departureMessage = buildAssistantMessage(participant, {
      content: departureObject.content,
      emotion: departureObject.emotion,
      label: 'lounge departure message'
    });
    appendedMessages.push(departureMessage);
    const boundary = validated.messages.length + appendedMessages.length;
    nextLifecycle = validated.participant_lifecycle.map((entry) => (
      entry.character_id === normalizedId
        ? { character_id: entry.character_id, status: 'exited', exited_after_message_count: boundary }
        : entry
    ));
  }
  const activeSet = activeSetFrom(nextLifecycle);
  const advancedIndex = fastForwardOverInactive(speakerOrder, nextSpeakerIndex + 1, activeSet);
  return validateLoungeGroupRecord({
    ...validated,
    participant_lifecycle: nextLifecycle,
    messages: [...validated.messages, ...appendedMessages],
    cursor: { ...validated.cursor, next_speaker_index: advancedIndex }
  });
}

// Appends the player's round-closing utterance and opens the next round: round_number advances, the next round's
// deterministic NPC order over the ORIGINAL three is computed, and the cursor advances to the first active NPC in
// that new order (fast-forwarding over any inactive prefix). The player may only speak once all active NPCs of the
// current round have spoken (cursor at the round boundary), so a premature player message throws. When every
// original participant has already exited, no active NPC opens the next round — the caller must handle terminal
// completion (all-exited player turn is rejected at the API gate, not silently persisted).
export function appendLoungePlayerMessage(record, content) {
  const validated = validateLoungeGroupRecord(record);
  if (validated.cursor.next_speaker_index !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error('lounge player turn is not open — NPCs of this round have not all spoken');
  }
  if (loungeAllParticipantsExited(validated)) {
    throw new Error('lounge player turn is not open — every participant has exited');
  }
  const nextRound = validated.cursor.round_number + 1;
  const participantIds = validated.participants.map((participant) => participant.character_id);
  const speakerOrder = loungeRoundSpeakerOrder({ conversationId: validated.id, roundNumber: nextRound, participantIds });
  const activeSet = activeSetFrom(validated.participant_lifecycle);
  const openingIndex = fastForwardOverInactive(speakerOrder, 0, activeSet);
  return validateLoungeGroupRecord({
    ...validated,
    messages: [...validated.messages, { role: 'user', content: requiredString(content, 'lounge player message content') }],
    cursor: { round_number: nextRound, speaker_order: speakerOrder, next_speaker_index: openingIndex }
  });
}
