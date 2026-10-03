// 収蔵 (concert hall pieces): the per-slot mutable player surface that keeps every piece the
// performer composed for the hero, point-in-time — the score itself (the player's input on 再演)
// plus the three chosen axis ids, the selected materials and the stage narration that was spoken
// before the first performance.
//
// It lives in a dedicated mutable file `game_data/concert_hall_pieces.json` (`{ version, entries }`),
// the same player-surface convention as library_collection / homunculi. An absent surface reads as
// an empty shelf (the honest initial state, and what a fresh routing new-game writes); a
// present-but-malformed surface is corrupt state and throws. It is carried by slot save/load/clone
// like the other player surfaces (storage.mjs / saveLoad.mjs / playSession.mjs wiring).
//
// Append validates the entry's exact shape and runs the score through `validateConcertHallScore`;
// a score with any violation is refused before anything is written, so the shelf never holds a
// piece the player cannot play. Entry order on disk is append order and this module never
// re-orders it.

import { createStorageApi } from './storage.mjs';
import {
  CONCERT_HALL_GUIDANCE_LINES_RANGE,
  CONCERT_HALL_MATERIALS_MAX,
  validateConcertHallScore
} from './concertHallCatalog.mjs';

export const CONCERT_HALL_PIECES_PATH = 'game_data/concert_hall_pieces.json';
export const CONCERT_HALL_PIECES_VERSION = 1;

const ENTRY_KEYS = ['entry_id', 'title', 'direction_id', 'subject_id', 'motif_category_id', 'materials', 'narration', 'score', 'composed_week'];
const NARRATION_KEYS = ['materials', 'direction', 'guidance', 'skeleton'];
const AXIS_ID_FIELDS = ['direction_id', 'subject_id', 'motif_category_id'];
const AXIS_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`concert hall pieces ${label} must be a non-empty string`);
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) throw new Error(`concert hall pieces ${label} must be an object`);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`concert hall pieces ${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

function stringList(value, label) {
  if (!Array.isArray(value)) throw new Error(`concert hall pieces ${label} must be an array`);
  value.forEach((item, index) => nonEmptyString(item, `${label}[${index}]`));
  return value;
}

// An addressed entry that is not on the shelf. Carries the HTTP mapping the API surfaces verbatim
// (the same domain-error convention as libraryCollection).
function pieceNotFoundError(entryId) {
  const error = new Error(`concert hall piece not found: ${entryId}`);
  error.statusCode = 404;
  error.errorCode = 'CONCERT_HALL_PIECE_NOT_FOUND';
  return error;
}

// Validates one entry's exact shape: the identity fields, the closed material list, the narration
// (one line per stage, one character line per section) and a playable score.
export function validateConcertHallPieceEntry(entry) {
  assertExactKeys(entry, ENTRY_KEYS, 'entry');
  nonEmptyString(entry.entry_id, 'entry_id');
  nonEmptyString(entry.title, 'title');
  for (const field of AXIS_ID_FIELDS) {
    nonEmptyString(entry[field], field);
    if (!AXIS_ID_PATTERN.test(entry[field])) throw new Error(`concert hall pieces ${field} must be an axis id: ${entry[field]}`);
  }
  stringList(entry.materials, 'materials');
  if (entry.materials.length > CONCERT_HALL_MATERIALS_MAX) throw new Error(`concert hall pieces materials must hold at most ${CONCERT_HALL_MATERIALS_MAX} ids`);
  if (new Set(entry.materials).size !== entry.materials.length) throw new Error('concert hall pieces materials must not repeat an id');
  assertExactKeys(entry.narration, NARRATION_KEYS, 'narration');
  nonEmptyString(entry.narration.materials, 'narration.materials');
  nonEmptyString(entry.narration.direction, 'narration.direction');
  stringList(entry.narration.guidance, 'narration.guidance');
  const [linesMin, linesMax] = CONCERT_HALL_GUIDANCE_LINES_RANGE;
  if (entry.narration.guidance.length < linesMin || entry.narration.guidance.length > linesMax) {
    throw new Error(`concert hall pieces narration.guidance must hold ${linesMin}〜${linesMax} lines`);
  }
  stringList(entry.narration.skeleton, 'narration.skeleton');
  const violations = validateConcertHallScore(entry.score);
  if (violations.length) throw new Error(`concert hall pieces score is invalid: ${violations.join(', ')}`);
  if (entry.narration.skeleton.length !== entry.score.sections.length) {
    throw new Error('concert hall pieces narration.skeleton must carry one line per score section');
  }
  if (!Number.isInteger(entry.composed_week) || entry.composed_week < 0) {
    throw new Error(`concert hall pieces composed_week must be a non-negative integer: ${entry.composed_week}`);
  }
  return entry;
}

export function emptyConcertHallPieces() {
  return { version: CONCERT_HALL_PIECES_VERSION, entries: [] };
}

// Validates the whole surface: version 1, entries array, each entry valid, entry_id unique. Extra
// top-level keys throw.
export function validateConcertHallPieces(surface) {
  assertExactKeys(surface, ['version', 'entries'], 'surface');
  if (surface.version !== CONCERT_HALL_PIECES_VERSION) throw new Error(`concert hall pieces version must be ${CONCERT_HALL_PIECES_VERSION}: ${surface.version}`);
  if (!Array.isArray(surface.entries)) throw new Error('concert hall pieces entries must be an array');
  const seen = new Set();
  for (const entry of surface.entries) {
    validateConcertHallPieceEntry(entry);
    if (seen.has(entry.entry_id)) throw new Error(`duplicate concert hall pieces entry_id: ${entry.entry_id}`);
    seen.add(entry.entry_id);
  }
  return surface;
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

// Loads the shelf. Absent (fresh default / a slot that never composed) reads as an empty shelf;
// present-but-malformed throws.
export async function loadConcertHallPieces({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(CONCERT_HALL_PIECES_PATH);
  if (raw === null || raw === undefined) return emptyConcertHallPieces();
  return validateConcertHallPieces(raw);
}

// Appends one validated piece. A duplicate entry_id or an unplayable score throws before any write.
export async function appendConcertHallPiece({ root, storage, entry } = {}) {
  const api = storageFor({ root, storage });
  const surface = await loadConcertHallPieces({ storage: api });
  validateConcertHallPieceEntry(entry);
  if (surface.entries.some((existing) => existing.entry_id === entry.entry_id)) {
    throw new Error(`concert hall pieces entry_id already exists: ${entry.entry_id}`);
  }
  const next = { version: CONCERT_HALL_PIECES_VERSION, entries: [...surface.entries, entry] };
  await api.writeJson(CONCERT_HALL_PIECES_PATH, next);
  return next;
}

// Resolves one stored piece by id for 再演. An unknown id throws the 404-tagged domain error.
export async function findConcertHallPiece({ root, storage, entryId } = {}) {
  const id = nonEmptyString(entryId, 'entryId');
  const surface = await loadConcertHallPieces({ root, storage });
  const entry = surface.entries.find((candidate) => candidate.entry_id === id);
  if (!entry) throw pieceNotFoundError(id);
  return entry;
}

// A piece's 収蔵 entry id: stable within a save from the composition timestamp plus the current entry
// count, so successive compositions never collide (the libraryCollection id shape).
export function makeConcertHallEntryId({ now, seq }) {
  const stamp = nonEmptyString(now, 'entry now').replace(/[^0-9A-Za-z]/g, '');
  if (!Number.isInteger(seq) || seq < 0) throw new Error('concert hall pieces entry seq must be a non-negative integer');
  return `chpiece_${stamp}_${seq}`;
}
