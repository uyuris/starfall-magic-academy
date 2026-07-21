// 談話室 (lounge) routing state helpers: the active-lounge runtime_state pointer and the group conversation id
// maker. The lounge cursor's single source of truth is the group record (loungeGroupRecord) — this pointer only
// names which conversation the current lounge session is, so the utterance / player-turn / end routes can fail
// fast when a request names a conversation that is not the active one. There is no reload resume: re-entering the
// same week starts a FRESH conversation (a new id + record) and overwrites this pointer, so a stale pointer left
// behind by a save/load is simply replaced on the next enter (the in-flight record is abandoned, never resumed).

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

export const ROUTING_ACTIVE_LOUNGE_STATE_KEY = 'routing_active_lounge';

export const LOUNGE_ACTIVE_PARTICIPANT_COUNT = 3;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validConversationId(id) {
  const normalized = requiredString(id, 'lounge conversation id');
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`lounge conversation id must be a valid conversation id: ${normalized}`);
  return normalized;
}

// Deterministic-shaped, collision-resistant group conversation id: `conv_lounge_<week>_<timestamp>`. The
// timestamp is the ISO instant stripped to alphanumerics, so two enters in the same week get distinct ids as long
// as their `now` differs (the caller stamps `now` per request).
export function makeLoungeConversationId({ now, week }) {
  const stamp = requiredString(now, 'now').replace(/[^0-9A-Za-z]/g, '');
  return validConversationId(`conv_lounge_${nonNegativeInteger(week, 'week')}_${stamp}`);
}

function validateActiveRoutingLounge(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('active routing lounge must be an object');
  const conversationId = validConversationId(value.conversation_id);
  const week = nonNegativeInteger(value.week, 'active routing lounge week');
  const startedAt = requiredString(value.started_at, 'active routing lounge started_at');
  return { conversation_id: conversationId, week, started_at: startedAt };
}

// Builds the active-lounge pointer written onto runtime_state at enter. It names only the conversation id + week +
// start instant — the participants, transcript, and cursor all live in the group record.
export function buildActiveRoutingLounge({ conversationId, week, startedAt }) {
  return validateActiveRoutingLounge({ conversation_id: conversationId, week, started_at: startedAt });
}

export function readActiveRoutingLounge(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the active routing lounge');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_ACTIVE_LOUNGE_STATE_KEY)) return null;
  return validateActiveRoutingLounge(state[ROUTING_ACTIVE_LOUNGE_STATE_KEY]);
}
