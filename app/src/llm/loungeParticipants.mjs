// 談話室 (lounge) participant selection and per-round speaker order — the two deterministic seeded draws the group
// conversation depends on. Both are pure functions of their inputs (no storage, no clock), so the same week always
// seats the same three participants and the same (conversation id, round number) always yields the same NPC order.
// The RNG is the shared dungeon LCG (createRng/deriveSeed), the same family the auction weekly draw uses.

import { createRng, deriveSeed } from '../dungeon/dungeonRng.mjs';

// The week-seed base so the lounge participant draw is independent of the dungeon / arena / errand / auction
// draws for the same week (each feature owns its own base).
const LOUNGE_PARTICIPANT_SEED_BASE = 0x4c4f554e; // 'LOUN'
const LOUNGE_PARTICIPANT_COUNT = 3;

const CHARACTER_ID_PATTERN = /^character_\d{3}$/;

// FNV-1a over a string → a 32-bit ordering key that mixes a string salt into deriveSeed's integer salt input
// (the same key family the auction / study-circle permutations use). Kept local so this module does not depend on
// the auction catalog loader.
function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function normalizeRosterEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`lounge roster[${index}] must be an object`);
  }
  const characterId = String(entry.character_id ?? '').trim();
  if (!CHARACTER_ID_PATTERN.test(characterId)) {
    throw new Error(`lounge roster[${index}].character_id must be a selectable character id: ${characterId || '(empty)'}`);
  }
  const characterName = String(entry.character_name ?? '').trim();
  if (!characterName) throw new Error(`lounge roster[${index}].character_name is required`);
  return { character_id: characterId, character_name: characterName };
}

// Seats LOUNGE_PARTICIPANT_COUNT distinct selectable characters for the given week, week-seed deterministic (salt
// `lounge-participants:<week>`). The whole roster is shuffled from the week seed and the head is taken, so the same
// week always yields the same three participants in the same seated order. A roster with fewer than three entries
// throws — the lounge cannot seat a round.
export function selectLoungeParticipants({ roster, week } = {}) {
  if (!Array.isArray(roster)) throw new Error('lounge roster must be an array');
  const normalizedWeek = nonNegativeInteger(week, 'lounge week');
  const normalizedRoster = roster.map(normalizeRosterEntry);
  const seenIds = new Set();
  for (const entry of normalizedRoster) {
    if (seenIds.has(entry.character_id)) throw new Error(`lounge roster has a duplicate character_id: ${entry.character_id}`);
    seenIds.add(entry.character_id);
  }
  if (normalizedRoster.length < LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge requires at least ${LOUNGE_PARTICIPANT_COUNT} selectable characters, got ${normalizedRoster.length}`);
  }
  const rng = createRng(deriveSeed(LOUNGE_PARTICIPANT_SEED_BASE, stableHash(`lounge-participants:${normalizedWeek}`)));
  return rng.shuffle(normalizedRoster).slice(0, LOUNGE_PARTICIPANT_COUNT);
}

// The NPC speaking order for one round, deterministic in (conversation id, round number): a fresh shuffle of the
// participant ids per round, so round 1 may be [A,B,C] and round 2 [C,A,B]. The player always speaks last in a
// round, after these NPC turns, so the player is not part of this order.
export function loungeRoundSpeakerOrder({ conversationId, roundNumber, participantIds } = {}) {
  const normalizedConversationId = String(conversationId ?? '').trim();
  if (!normalizedConversationId) throw new Error('lounge round speaker order requires a conversation id');
  const normalizedRoundNumber = positiveInteger(roundNumber, 'lounge round number');
  if (!Array.isArray(participantIds) || participantIds.length !== LOUNGE_PARTICIPANT_COUNT) {
    throw new Error(`lounge round speaker order requires exactly ${LOUNGE_PARTICIPANT_COUNT} participant ids`);
  }
  const ids = participantIds.map((id, index) => {
    const normalized = String(id ?? '').trim();
    if (!CHARACTER_ID_PATTERN.test(normalized)) {
      throw new Error(`lounge round speaker order participant[${index}] must be a selectable character id: ${normalized || '(empty)'}`);
    }
    return normalized;
  });
  if (new Set(ids).size !== ids.length) throw new Error('lounge round speaker order participant ids must be distinct');
  const rng = createRng(deriveSeed(stableHash(`lounge-round:${normalizedConversationId}`), normalizedRoundNumber));
  return rng.shuffle(ids);
}

export { LOUNGE_PARTICIPANT_COUNT };
