// 錬成室 (homunculus atelier): the per-slot mutable player surface that tracks the hero's homunculi —
// the up-to-3 active children living in the atelier and the append-only nameplates of the ones farewelled.
//
// It lives in a dedicated mutable file `game_data/homunculi.json` (`{ version, active, nameplates }`), the
// same player-surface convention as player_inventory / player_equipment / library_collection. An absent
// surface reads as an empty surface (the honest initial state, and what a fresh routing new-game writes);
// a present-but-malformed surface is corrupt state and throws. It is carried by slot save/load/clone like
// the other player surfaces.
//
// The persona / memory / affinity of each child live in the actor directory `game_data/homunculi/<id>/`
// (profile/flags/skills/memory/work_records/affinity), not here — this surface holds only the slot roster
// (which ids are active, which faces are taken, the persistent nameplates). Homunculus ids are never
// reused: an id appears at most once across active ∪ nameplates, so a farewelled face stays excluded.
//
// The face id is validated for FORMAT only, over two closed pools: the atelier face pool `hp_001`..`hp_050`
// and the auction being face pool `ab_001`..`ab_015`. Both mint homunculus_NNN actors on this one surface — an
// auction-adopted being (competition の子) is a homunculus-shaped actor whose species/origin live in its actor
// directory, not here. Matching against a pool ledger and excluding already-used faces is the closed-set
// selection concern of the atelier / auction domains, not this surface.

import { createStorageApi } from './storage.mjs';

export const HOMUNCULI_SURFACE_PATH = 'game_data/homunculi.json';
export const MAX_ACTIVE_HOMUNCULI = 3;
export const HOMUNCULUS_ID_PATTERN = /^homunculus_\d{3}$/;
export const HOMUNCULUS_FACE_POOL_SIZE = 50;
// The auction being face pool: 15 authored faces (ホムンクルス/精霊/魔物 各5) an auction being adopts. Fixed 1:1
// in the auction catalog; validated for format here so a being entry can live on the same surface.
export const AUCTION_FACE_POOL_SIZE = 15;
export const AUCTION_FACE_ID_PATTERN = /^ab_\d{3}$/;

// Whether a face id belongs to the auction being pool (ab_NNN in 1..15). Used by the atelier face-pool
// selection to skip auction faces (they never occupy an hp lane) without treating them as corrupt.
export function isAuctionFaceId(value) {
  if (typeof value !== 'string') return false;
  const match = AUCTION_FACE_ID_PATTERN.exec(value);
  if (!match) return false;
  const index = Number(value.slice(3));
  return index >= 1 && index <= AUCTION_FACE_POOL_SIZE;
}

// Whether a face id is a member of the closed homunculus face vocabulary: the atelier pool `hp_001`..`hp_050`
// ∪ the auction being pool `ab_001`..`ab_015`. The single source of truth for face-id membership, shared by
// this surface, the atelier active-conversation marker, and the routing content result — a homunculus-shaped
// actor (an atelier child or an adopted auction being) carries exactly one of these faces.
export function isHomunculusFaceId(value) {
  if (typeof value !== 'string') return false;
  const hpMatch = /^hp_(\d{3})$/.exec(value);
  if (hpMatch) {
    const index = Number(hpMatch[1]);
    return index >= 1 && index <= HOMUNCULUS_FACE_POOL_SIZE;
  }
  return isAuctionFaceId(value);
}

const ACTIVE_ENTRY_KEYS = ['homunculus_id', 'display_name', 'face_id', 'created_week'];
const NAMEPLATE_ENTRY_KEYS = ['homunculus_id', 'display_name', 'epitaph', 'face_id', 'farewell_week'];

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`homunculi surface ${label} must be a non-empty string`);
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`homunculi surface ${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

function assertHomunculusId(value, label) {
  nonEmptyString(value, label);
  if (!HOMUNCULUS_ID_PATTERN.test(value)) throw new Error(`homunculi surface ${label} must match homunculus_NNN: ${value}`);
  return value;
}

// Validates the face id FORMAT only, over the two closed pools: `hp_NNN` (1..50 atelier pool) or `ab_NNN`
// (1..15 auction being pool). Ledger membership / used-face exclusion is the atelier / auction closed-set
// selection concern, not this surface's.
function assertFaceId(value, label) {
  nonEmptyString(value, label);
  if (isHomunculusFaceId(value)) return value;
  // An hp_NNN that merely fell outside the 1..50 range gets a range-specific message; anything else is a
  // wholly malformed face id.
  if (/^hp_\d{3}$/.test(value)) {
    throw new Error(`homunculi surface ${label} must be within hp_001..hp_0${HOMUNCULUS_FACE_POOL_SIZE}: ${value}`);
  }
  throw new Error(`homunculi surface ${label} must match hp_NNN or ab_NNN: ${value}`);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`homunculi surface ${label} must be a non-negative integer: ${value}`);
  return value;
}

export function validateHomunculiActiveEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('homunculi surface active entry must be an object');
  assertExactKeys(entry, ACTIVE_ENTRY_KEYS, 'active entry');
  assertHomunculusId(entry.homunculus_id, 'active entry homunculus_id');
  nonEmptyString(entry.display_name, 'active entry display_name');
  assertFaceId(entry.face_id, 'active entry face_id');
  assertNonNegativeInteger(entry.created_week, 'active entry created_week');
  return entry;
}

export function validateHomunculiNameplateEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('homunculi surface nameplate entry must be an object');
  assertExactKeys(entry, NAMEPLATE_ENTRY_KEYS, 'nameplate entry');
  assertHomunculusId(entry.homunculus_id, 'nameplate entry homunculus_id');
  nonEmptyString(entry.display_name, 'nameplate entry display_name');
  nonEmptyString(entry.epitaph, 'nameplate entry epitaph');
  assertFaceId(entry.face_id, 'nameplate entry face_id');
  assertNonNegativeInteger(entry.farewell_week, 'nameplate entry farewell_week');
  return entry;
}

export function emptyHomunculiSurface() {
  return { version: 1, active: [], nameplates: [] };
}

// Validates the whole surface: version 1, active (≤3) and nameplates arrays, each entry valid, and every
// homunculus_id unique across active ∪ nameplates (ids are never reused). Extra top-level keys throw.
export function validateHomunculiSurface(surface) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) throw new Error('homunculi surface must be an object');
  assertExactKeys(surface, ['version', 'active', 'nameplates'], 'surface');
  if (surface.version !== 1) throw new Error(`homunculi surface version must be 1: ${surface.version}`);
  if (!Array.isArray(surface.active)) throw new Error('homunculi surface active must be an array');
  if (!Array.isArray(surface.nameplates)) throw new Error('homunculi surface nameplates must be an array');
  if (surface.active.length > MAX_ACTIVE_HOMUNCULI) {
    throw new Error(`homunculi surface active must hold at most ${MAX_ACTIVE_HOMUNCULI}: got ${surface.active.length}`);
  }
  const seenIds = new Set();
  for (const entry of surface.active) {
    validateHomunculiActiveEntry(entry);
    if (seenIds.has(entry.homunculus_id)) throw new Error(`duplicate homunculus_id across the surface: ${entry.homunculus_id}`);
    seenIds.add(entry.homunculus_id);
  }
  for (const entry of surface.nameplates) {
    validateHomunculiNameplateEntry(entry);
    if (seenIds.has(entry.homunculus_id)) throw new Error(`duplicate homunculus_id across the surface: ${entry.homunculus_id}`);
    seenIds.add(entry.homunculus_id);
  }
  return surface;
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

// Loads the surface. Absent (fresh routing new-game / loop save) reads as an empty surface;
// present-but-malformed throws.
export async function loadHomunculiSurface({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(HOMUNCULI_SURFACE_PATH);
  if (raw === null || raw === undefined) return emptyHomunculiSurface();
  return validateHomunculiSurface(raw);
}

function assertUnusedId(surface, homunculusId) {
  const used = surface.active.some((entry) => entry.homunculus_id === homunculusId)
    || surface.nameplates.some((entry) => entry.homunculus_id === homunculusId);
  if (used) throw new Error(`homunculus_id already exists on the surface: ${homunculusId}`);
}

// Mints a new active homunculus. Fails fast before any write when the active roster is already full
// (max 3) or the id is already used (active or nameplate) — ids are never reused.
export async function appendActiveHomunculus({ root, storage, entry } = {}) {
  const api = storageFor({ root, storage });
  const surface = await loadHomunculiSurface({ storage: api });
  validateHomunculiActiveEntry(entry);
  if (surface.active.length >= MAX_ACTIVE_HOMUNCULI) {
    throw new Error(`homunculi active roster is full (${MAX_ACTIVE_HOMUNCULI}); farewell one before minting another`);
  }
  assertUnusedId(surface, entry.homunculus_id);
  const next = { version: 1, active: [...surface.active, entry], nameplates: [...surface.nameplates] };
  await api.writeJson(HOMUNCULI_SURFACE_PATH, next);
  return next;
}

// Farewells an active homunculus: removes it from the active roster and appends its persistent nameplate
// (the sole way an id enters the nameplate list, keeping every id unique across the surface). The epitaph
// text is supplied by the caller (the atelier domain generates it); this only performs the shape move.
export async function farewellActiveHomunculus({ root, storage, homunculusId, epitaph, farewellWeek } = {}) {
  const api = storageFor({ root, storage });
  const surface = await loadHomunculiSurface({ storage: api });
  assertHomunculusId(homunculusId, 'farewell homunculus_id');
  const activeEntry = surface.active.find((entry) => entry.homunculus_id === homunculusId);
  if (!activeEntry) throw new Error(`homunculus is not active on the surface: ${homunculusId}`);
  const nameplate = {
    homunculus_id: activeEntry.homunculus_id,
    display_name: activeEntry.display_name,
    epitaph,
    face_id: activeEntry.face_id,
    farewell_week: farewellWeek
  };
  validateHomunculiNameplateEntry(nameplate);
  const next = {
    version: 1,
    active: surface.active.filter((entry) => entry.homunculus_id !== homunculusId),
    nameplates: [...surface.nameplates, nameplate]
  };
  await api.writeJson(HOMUNCULI_SURFACE_PATH, next);
  return next;
}
