// 収蔵庫 (library collection): the per-slot mutable player surface that keeps every book
// fragment the hero has read, point-in-time.
//
// It lives in a dedicated mutable file `game_data/library_collection.json`
// (`{ version, entries }`), the same player-surface convention as player_inventory /
// player_equipment. An absent surface reads as an empty collection (the honest initial
// state, and what a fresh new-game writes); a present-but-malformed surface is corrupt state
// and throws. It is carried by slot save/load/clone like the other player surfaces.
//
// Each entry preserves the exact fragment actually read: `text` is the specific文面 shown
// (periphery and generated books vary per read, so the read copy is stored, not a pointer).
// `layer` is core | periphery | generated; `book_id` names the catalog book for core/periphery
// and is null for a generated (catalog-external) book. Append validates one read against the
// catalog and rejects a book_id that does not exist or an entry_id that collides.

import { createStorageApi } from './storage.mjs';

export const LIBRARY_COLLECTION_PATH = 'game_data/library_collection.json';
export const LIBRARY_COLLECTION_LAYERS = Object.freeze(['core', 'periphery', 'generated']);

const LAYER_SET = new Set(LIBRARY_COLLECTION_LAYERS);
const ENTRY_KEYS = ['entry_id', 'book_id', 'title', 'category', 'layer', 'text', 'read_week'];

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`library collection ${label} must be a non-empty string`);
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`library collection ${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

// Validates one entry's exact shape. When `validBookIds` is provided (append/write path), a
// core/periphery book_id must exist in the catalog; the read path omits it so reading never
// requires the catalog. A generated entry must carry book_id null; a core/periphery entry must
// carry a non-empty book_id.
export function validateLibraryCollectionEntry(entry, { validBookIds = null } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('library collection entry must be an object');
  assertExactKeys(entry, ENTRY_KEYS, 'entry');
  nonEmptyString(entry.entry_id, 'entry_id');
  if (!LAYER_SET.has(entry.layer)) throw new Error(`library collection entry layer must be one of ${LIBRARY_COLLECTION_LAYERS.join('/')}: ${entry.layer}`);
  nonEmptyString(entry.title, 'title');
  nonEmptyString(entry.category, 'category');
  nonEmptyString(entry.text, 'text');
  if (!Number.isInteger(entry.read_week) || entry.read_week < 0) throw new Error(`library collection entry read_week must be a non-negative integer: ${entry.read_week}`);
  if (entry.layer === 'generated') {
    if (entry.book_id !== null) throw new Error('library collection generated entry book_id must be null');
  } else {
    nonEmptyString(entry.book_id, 'book_id');
    if (validBookIds && !validBookIds.has(entry.book_id)) {
      throw new Error(`library collection entry book_id is not in the catalog: ${entry.book_id}`);
    }
  }
  return entry;
}

export function emptyLibraryCollection() {
  return { version: 1, entries: [] };
}

// Validates the whole surface: version 1, entries array, each entry valid, entry_id unique.
// Extra top-level keys throw. `validBookIds` is threaded to entry validation on the write path.
export function validateLibraryCollection(surface, { validBookIds = null } = {}) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) throw new Error('library collection surface must be an object');
  assertExactKeys(surface, ['version', 'entries'], 'surface');
  if (surface.version !== 1) throw new Error(`library collection version must be 1: ${surface.version}`);
  if (!Array.isArray(surface.entries)) throw new Error('library collection entries must be an array');
  const seen = new Set();
  for (const entry of surface.entries) {
    validateLibraryCollectionEntry(entry, { validBookIds });
    if (seen.has(entry.entry_id)) throw new Error(`duplicate library collection entry_id: ${entry.entry_id}`);
    seen.add(entry.entry_id);
  }
  return surface;
}

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

// Loads the collection. Absent (fresh default / older save) reads as an empty collection;
// present-but-malformed throws. Structural read only — no catalog needed.
export async function loadLibraryCollection({ root, storage } = {}) {
  const raw = await storageFor({ root, storage }).readJsonIfExists(LIBRARY_COLLECTION_PATH);
  if (raw === null || raw === undefined) return emptyLibraryCollection();
  return validateLibraryCollection(raw);
}

// Appends one validated read. `catalogBookIds` is the set of catalog book ids (core/periphery)
// a non-generated entry's book_id must exist in. A duplicate entry_id throws before any write.
export async function appendLibraryCollectionEntry({ root, storage, entry, catalogBookIds } = {}) {
  if (!(catalogBookIds instanceof Set)) throw new Error('appendLibraryCollectionEntry requires a catalogBookIds Set');
  const api = storageFor({ root, storage });
  const surface = await loadLibraryCollection({ storage: api });
  validateLibraryCollectionEntry(entry, { validBookIds: catalogBookIds });
  if (surface.entries.some((existing) => existing.entry_id === entry.entry_id)) {
    throw new Error(`library collection entry_id already exists: ${entry.entry_id}`);
  }
  const next = { version: 1, entries: [...surface.entries, entry] };
  await api.writeJson(LIBRARY_COLLECTION_PATH, next);
  return next;
}
