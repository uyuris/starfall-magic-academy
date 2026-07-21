// 談話室 (lounge) group conversation record: the single source of truth for a 3 NPC + プレイヤー round conversation.
// Unlike a 1:1 conversation record (one top-level actor, every assistant message that actor's), a group record
// carries the three seated participants, an actor-context snapshot per participant, a transcript whose every
// assistant message names its own speaker, and an authoritative cursor (round number, that round's NPC speaking
// order, and the index of the next NPC to speak). A strict validator runs at the write boundary: it never
// completes a message speaker from a top-level actor, rejects a speaker outside the participant set, and rejects a
// cursor whose speaker order disagrees with the deterministic (conversation id, round number) shuffle. Malformed
// input throws — there is no silent repair.

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
  // shuffle — a stored order that disagrees is a corrupted/forged cursor, not a variant to accept.
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
// and (later) the finalizer draw from a record — who the participants are, who spoke each line, whose turn is
// next — is pinned here at the write boundary, so a malformed record can never reach generation or persistence.
export function validateLoungeGroupRecord(record) {
  const object = requiredObject(record, 'lounge record');
  assertExactKeys(
    object,
    ['id', 'source_type', 'week', 'location_name', 'visible_situation', 'participants', 'conversation_actor_contexts', 'messages', 'cursor'],
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
  const cursor = validateCursor(object.cursor, { conversationId: id, participantIds });
  return {
    id,
    source_type: LOUNGE_SOURCE_TYPE,
    week,
    location_name: locationName,
    visible_situation: visibleSituation,
    participants,
    conversation_actor_contexts: conversationActorContexts,
    messages,
    cursor
  };
}

// Builds the initial lounge record: no messages yet, cursor at round 1 with that round's deterministic NPC order
// and the first NPC to speak (index 0). The result is validated before it is returned, so a bad scene / participant
// / actor-context input fails here rather than at the first turn.
export function createLoungeGroupRecord({ id, week, participants, conversationActorContexts, locationName, visibleSituation }) {
  const normalizedId = requiredString(id, 'lounge record id');
  if (!CONVERSATION_ID_PATTERN.test(normalizedId)) throw new Error(`lounge record id must be a valid conversation id: ${normalizedId}`);
  const validatedParticipants = validateParticipants(participants);
  const participantIds = validatedParticipants.map((participant) => participant.character_id);
  const speakerOrder = loungeRoundSpeakerOrder({ conversationId: normalizedId, roundNumber: 1, participantIds });
  return validateLoungeGroupRecord({
    id: normalizedId,
    source_type: LOUNGE_SOURCE_TYPE,
    week,
    location_name: locationName,
    visible_situation: visibleSituation,
    participants: validatedParticipants,
    conversation_actor_contexts: conversationActorContexts,
    messages: [],
    cursor: { round_number: 1, speaker_order: speakerOrder, next_speaker_index: 0 }
  });
}

// The participant whose NPC turn it is, or null when all NPCs of the round have spoken and the player is next.
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

// Appends the current NPC speaker's generated utterance and advances the cursor to the next NPC. It is a write-time
// error to append a speaker other than the one the cursor points at, or to append an NPC utterance when it is the
// player's turn — the cursor is authoritative, not the caller's claim.
export function appendLoungeAssistantMessage(record, { characterId, content, emotion }) {
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
  const participant = validated.participants.find((entry) => entry.character_id === normalizedId);
  const emotionObject = requiredObject(emotion, 'lounge assistant message emotion');
  const expression = requiredString(emotionObject.expression, 'lounge assistant message emotion.expression');
  const faceVariant = requiredString(emotionObject.face_emotion_variant_id, 'lounge assistant message emotion.face_emotion_variant_id');
  const message = {
    role: 'assistant',
    character_id: normalizedId,
    character_name: participant.character_name,
    content: requiredString(content, 'lounge assistant message content'),
    expression,
    face_emotion_variant_id: faceVariant
  };
  return validateLoungeGroupRecord({
    ...validated,
    messages: [...validated.messages, message],
    cursor: { ...validated.cursor, next_speaker_index: nextSpeakerIndex + 1 }
  });
}

// Appends the player's round-closing utterance and opens the next round: round_number advances, the next round's
// deterministic NPC order is computed, and the cursor rewinds to the first NPC. The player may only speak once all
// NPCs of the current round have spoken (cursor at the round boundary), so a premature player message throws.
export function appendLoungePlayerMessage(record, content) {
  const validated = validateLoungeGroupRecord(record);
  if (validated.cursor.next_speaker_index !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error('lounge player turn is not open — NPCs of this round have not all spoken');
  }
  const nextRound = validated.cursor.round_number + 1;
  const participantIds = validated.participants.map((participant) => participant.character_id);
  const speakerOrder = loungeRoundSpeakerOrder({ conversationId: validated.id, roundNumber: nextRound, participantIds });
  return validateLoungeGroupRecord({
    ...validated,
    messages: [...validated.messages, { role: 'user', content: requiredString(content, 'lounge player message content') }],
    cursor: { round_number: nextRound, speaker_order: speakerOrder, next_speaker_index: 0 }
  });
}
