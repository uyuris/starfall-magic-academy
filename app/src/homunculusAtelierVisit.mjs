// The 錬成室 stay-visit conversation gate: 1 visit = 1 conversation (うゆりすさん確定・全会話共通の重み).
//
// The atelier is a week-progressing stay destination, so a fresh visit is uniquely a fresh week (each visit
// is reached by one week-progressing dispatch; you cannot re-enter the atelier in the same week without
// dispatching again). The gate therefore keys on the week:
//   - `routing_atelier_active_conversation` marks the one in-progress conversation (parallel to the active
//     errand / study-circle markers); it is set at conversation start and cleared at conversation end.
//   - `routing_atelier_conversation_spent_week` records the week whose one conversation has been completed;
//     while it equals the current week, no new atelier conversation may start.
//
// 錬成→その子との初会話 is continuous within one visit: synthesis does NOT touch either field, so a freshly
// synthesized child can be talked to immediately (the conversation gate is only spent by completing a
// conversation).

import { isHomunculusFaceId } from './homunculusSurface.mjs';

export const ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY = 'routing_atelier_active_conversation';
export const ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY = 'routing_atelier_conversation_spent_week';

const HOMUNCULUS_ID_PATTERN = /^homunculus_\d{3}$/;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

// The marker carries the child's identity (display_name / face_id) so the conversation-end handler can build
// the `conversation_completed` content result without re-reading the surface.
const ACTIVE_CONVERSATION_KEYS = ['conversation_id', 'homunculus_id', 'display_name', 'face_id', 'week'];

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`atelier ${label} must be a non-negative integer: ${value}`);
  return value;
}

// Validates a present active-conversation marker (a non-null but malformed marker is corrupt runtime_state
// and throws; absence is handled by the reader as "no active conversation").
export function validateAtelierActiveConversation(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error('atelier active conversation marker must be a non-null object');
  }
  const actual = Object.keys(marker).sort();
  const expected = [...ACTIVE_CONVERSATION_KEYS].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`atelier active conversation marker keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
  if (typeof marker.conversation_id !== 'string' || !CONVERSATION_ID_PATTERN.test(marker.conversation_id)) {
    throw new Error('atelier active conversation marker requires a valid conversation_id');
  }
  if (typeof marker.homunculus_id !== 'string' || !HOMUNCULUS_ID_PATTERN.test(marker.homunculus_id)) {
    throw new Error('atelier active conversation marker requires a homunculus_NNN homunculus_id');
  }
  if (typeof marker.display_name !== 'string' || !marker.display_name) {
    throw new Error('atelier active conversation marker requires a non-empty display_name');
  }
  if (typeof marker.face_id !== 'string' || !isHomunculusFaceId(marker.face_id)) {
    throw new Error('atelier active conversation marker requires an hp_NNN or ab_NNN face_id');
  }
  assertNonNegativeInteger(marker.week, 'active conversation marker week');
  return {
    conversation_id: marker.conversation_id,
    homunculus_id: marker.homunculus_id,
    display_name: marker.display_name,
    face_id: marker.face_id,
    week: marker.week
  };
}

// The active atelier conversation marker, or null. Absence is the honest "no atelier conversation in
// progress"; a present-but-malformed marker fails fast.
export function readActiveAtelierConversation(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the atelier active conversation');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY)) return null;
  const marker = state[ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY];
  if (marker === null) return null;
  return validateAtelierActiveConversation(marker);
}

// The week whose one atelier conversation has already been completed, or null. A present value must be a
// non-negative integer (corrupt otherwise).
export function readAtelierConversationSpentWeek(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the atelier conversation spent week');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY)) return null;
  const week = state[ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY];
  if (week === null) return null;
  return assertNonNegativeInteger(week, 'conversation spent week');
}

// Whether this visit's one conversation has already been spent: an active conversation is in progress, OR a
// conversation was already completed this (current) week.
export function isAtelierConversationSpent(state, currentWeek) {
  assertNonNegativeInteger(currentWeek, 'current week');
  if (readActiveAtelierConversation(state) !== null) return true;
  const spentWeek = readAtelierConversationSpentWeek(state);
  return spentWeek !== null && spentWeek === currentWeek;
}

// The active atelier conversation IF it is this (conversationId, characterId) conversation, else null. A
// marker for a different conversation returns null (non-interfering: it must not disturb an unrelated
// conversation's turn/end); a marker whose conversation_id matches but actor does not is corruption and fails
// fast. The conversation-turn and conversation-end handlers use this to recognize the atelier conversation
// (inject the atelier scene / write the content result) exactly like the errand / study-circle matchers.
export function matchingActiveAtelierConversation({ state, conversationId, characterId }) {
  const active = readActiveAtelierConversation(state);
  if (!active) return null;
  if (active.conversation_id !== conversationId) return null;
  if (active.homunculus_id !== characterId) {
    const error = new Error('active atelier conversation actor mismatch');
    error.statusCode = 409;
    error.errorCode = 'HOMUNCULUS_CONVERSATION_CONTEXT_MISMATCH';
    throw error;
  }
  return active;
}
