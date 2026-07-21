// Per-character MP reserve line: the share of a companion's MP (0..100 percent) below which the
// dungeon companion AI stops spending MP on attacks (cast / melee bump) and keeps what is left for
// self-healing. The value is authored by the character themselves — a conversation-end judgment asks
// the LLM "what MP line does this character want to hold?" and overwrites the stored line — so telling
// a companion to conserve MP in conversation changes their behavior on the next run.
//
// It lives in a dedicated per-slot mutable surface `game_data/mp_reserve.json`
// (`{ version, reserves }`), the same player-surface convention as player_inventory /
// player_equipment. `reserves` maps a companion id — a selectable roster character or a homunculus (both
// can join a run as the buddy) — to its line. An absent surface, or an absent character within it, reads
// as the spec initial value (30) — the honest initial state, exactly like affinity's missing-file initial
// value, NOT a silent fallback. A present-but-malformed surface is corrupt state and throws. Creatures and
// the routing persona never join a run as a companion, so they never carry a line.

import { createStorageApi } from './storage.mjs';
import { isSelectableCharacterId } from './characterCatalog.mjs';
import { isHomunculusIdFormat } from './companionRoster.mjs';

export const MP_RESERVE_SURFACE_PATH = 'game_data/mp_reserve.json';
// The spec initial state for a character whose line has never been authored in conversation. Tunable.
export const MP_RESERVE_INITIAL_PERCENT = 30;
export const MP_RESERVE_MIN = 0;
export const MP_RESERVE_MAX = 100;

// A reserve line is carried by a run companion: a selectable roster character or a homunculus (both can
// join a run as the buddy). The key is validated by FORMAT (selectable id in range, or homunculus_NNN
// shape); like affinity, a stored line for a since-farewelled homunculus is harmless (never read once it
// can no longer be a companion), so active membership is not this surface's concern.
function assertCompanionCharacterId(characterId) {
  if (!isSelectableCharacterId(characterId) && !isHomunculusIdFormat(characterId)) {
    throw new Error(`mp reserve is only supported for selectable roster or homunculus actors: ${characterId}`);
  }
  return characterId;
}

// A reserve percent must be an integer within [0, 100]. Anything else is corrupt / out of contract.
function assertReservePercent(value, label) {
  if (!Number.isInteger(value) || value < MP_RESERVE_MIN || value > MP_RESERVE_MAX) {
    throw new Error(`mp reserve ${label} must be an integer from ${MP_RESERVE_MIN} to ${MP_RESERVE_MAX}: ${value}`);
  }
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`mp reserve ${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

export function emptyMpReserveSurface() {
  return { version: 1, reserves: {} };
}

// Validates the whole surface: version 1, reserves is a plain object of companion id (selectable or
// homunculus) -> 0..100 integer. Extra top-level keys, unknown character ids, and out-of-range values throw.
export function validateMpReserveSurface(surface) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) throw new Error('mp_reserve surface must be an object');
  assertExactKeys(surface, ['version', 'reserves'], 'surface');
  if (surface.version !== 1) throw new Error(`mp_reserve version must be 1: ${surface.version}`);
  if (surface.reserves === null || typeof surface.reserves !== 'object' || Array.isArray(surface.reserves)) {
    throw new Error('mp_reserve reserves must be an object of character_id -> percent');
  }
  for (const [characterId, percent] of Object.entries(surface.reserves)) {
    assertCompanionCharacterId(characterId);
    assertReservePercent(percent, `reserve for ${characterId}`);
  }
  return surface;
}

// Parses one LLM reserve-line answer into a 0..100 integer. Empty, non-integer, out-of-range, or
// label-bearing output throws (the same fail-fast contract as the affinity delta answer).
export function parseMpReservePercentAnswer(answer) {
  const raw = String(answer ?? '').trim();
  if (!/^\+?\d+$/u.test(raw)) {
    throw new Error(`mp reserve answer must be an integer from ${MP_RESERVE_MIN} to ${MP_RESERVE_MAX}: ${raw}`);
  }
  const percent = Number(raw.replace(/^\+/u, ''));
  return assertReservePercent(percent, 'answer');
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

// Loads the surface. Absent (fresh default / older save) reads as an empty surface; present-but-malformed
// throws.
export async function loadMpReserveSurface({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(MP_RESERVE_SURFACE_PATH);
  if (raw === null || raw === undefined) return emptyMpReserveSurface();
  return validateMpReserveSurface(raw);
}

// The reserve line for one companion (selectable or homunculus). An absent entry is the spec initial value
// (30) — the explicit "never authored yet" state, not a silent fallback.
export function mpReservePercentFor(surface, characterId) {
  assertCompanionCharacterId(characterId);
  const stored = surface.reserves[characterId];
  return stored ?? MP_RESERVE_INITIAL_PERCENT;
}

// Overwrites one companion's reserve line and persists the surface. The value is validated
// (0..100 integer) before any write, so a rejected write leaves no partial state.
export async function setMpReservePercent({ root, storage, characterId, percent } = {}) {
  assertCompanionCharacterId(characterId);
  assertReservePercent(percent, 'percent');
  const api = storageFor({ root, storage });
  const surface = await loadMpReserveSurface({ storage: api });
  const next = { version: 1, reserves: { ...surface.reserves, [characterId]: percent } };
  await api.writeJson(MP_RESERVE_SURFACE_PATH, next);
  return next;
}
