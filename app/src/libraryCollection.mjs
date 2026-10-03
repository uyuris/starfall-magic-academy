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
// and is null for a generated (catalog-external) book. `favorite` is the player's shelf mark,
// a required boolean written explicitly false on every new 収蔵. `style_id` is the 文体 the
// fragment was written under: one of the closed LIBRARY_STYLE_IDS for a periphery/generated read,
// null for a core (authored) read. Append validates one read against the catalog and rejects a
// book_id that does not exist or an entry_id that collides.
//
// The surface is version 3. A version-2 surface (the pre-style_id shape) is corrupt state to
// this reader — there is no compatibility reader and no implicit style_id default; an existing
// save is converted once, explicitly, by scripts/migrate-library-collection-v3.mjs.
//
// Entry order on disk is append order and this module never re-orders it: 並び替え is the
// frontend's display state, not stored state.

import { createStorageApi } from './storage.mjs';

export const LIBRARY_COLLECTION_PATH = 'game_data/library_collection.json';
export const LIBRARY_COLLECTION_VERSION = 3;
export const LIBRARY_COLLECTION_LAYERS = Object.freeze(['core', 'periphery', 'generated']);

// The closed set of 文体 ids a 収蔵 entry may record, in fixed order. This surface module is the
// owner because it is the leaf: the LLM stage (llm/libraryGeneration.mjs) builds its LIBRARY_STYLES
// over these ids, and importing the LM module from here would pull lmStudioClient into the
// storage → playSession → libraryCollection import cycle.
export const LIBRARY_STYLE_IDS = Object.freeze(['light', 'solemn', 'dry', 'intimate']);

const LAYER_SET = new Set(LIBRARY_COLLECTION_LAYERS);
const STYLE_ID_SET = new Set(LIBRARY_STYLE_IDS);
const ENTRY_KEYS = ['entry_id', 'book_id', 'title', 'category', 'layer', 'text', 'read_week', 'favorite', 'style_id'];

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

// An addressed entry that is not on the shelf. Carries the HTTP mapping the API surfaces
// verbatim (the same domain-error convention as auctionAward / homunculusAtelier).
function entryNotFoundError(entryId) {
  const error = new Error(`library collection entry not found: ${entryId}`);
  error.statusCode = 404;
  error.errorCode = 'LIBRARY_COLLECTION_ENTRY_NOT_FOUND';
  return error;
}

// Validates one entry's exact shape. When `validBookIds` is provided (append/write path), a
// core/periphery book_id must exist in the catalog; the read path omits it so reading never
// requires the catalog. A generated entry must carry book_id null; a core/periphery entry must
// carry a non-empty book_id. style_id is null or one of the closed style ids (the runtime writes
// null for core and the chosen id for periphery/generated; the validator checks the value set,
// not the layer pairing).
export function validateLibraryCollectionEntry(entry, { validBookIds = null } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('library collection entry must be an object');
  assertExactKeys(entry, ENTRY_KEYS, 'entry');
  nonEmptyString(entry.entry_id, 'entry_id');
  if (!LAYER_SET.has(entry.layer)) throw new Error(`library collection entry layer must be one of ${LIBRARY_COLLECTION_LAYERS.join('/')}: ${entry.layer}`);
  nonEmptyString(entry.title, 'title');
  nonEmptyString(entry.category, 'category');
  nonEmptyString(entry.text, 'text');
  if (!Number.isInteger(entry.read_week) || entry.read_week < 0) throw new Error(`library collection entry read_week must be a non-negative integer: ${entry.read_week}`);
  if (typeof entry.favorite !== 'boolean') throw new Error(`library collection entry favorite must be a boolean: ${entry.favorite}`);
  if (entry.style_id !== null && !STYLE_ID_SET.has(entry.style_id)) {
    throw new Error(`library collection entry style_id must be null or one of ${LIBRARY_STYLE_IDS.join('/')}: ${JSON.stringify(entry.style_id)}`);
  }
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
  return { version: LIBRARY_COLLECTION_VERSION, entries: [] };
}

// Validates the whole surface: version 3, entries array, each entry valid, entry_id unique.
// Extra top-level keys throw. A version-2 surface names the one-shot conversion CLI in its error
// (the only way forward for an existing save). `validBookIds` is threaded to entry validation on
// the write path.
export function validateLibraryCollection(surface, { validBookIds = null } = {}) {
  if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) throw new Error('library collection surface must be an object');
  assertExactKeys(surface, ['version', 'entries'], 'surface');
  if (surface.version === 2) {
    throw new Error(`library collection version must be ${LIBRARY_COLLECTION_VERSION}: 2 — convert this save once with node scripts/migrate-library-collection-v3.mjs --root <absolute-project-root> --mode check|apply`);
  }
  if (surface.version !== LIBRARY_COLLECTION_VERSION) throw new Error(`library collection version must be ${LIBRARY_COLLECTION_VERSION}: ${surface.version}`);
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

// Loads the collection. Absent (fresh default / a slot that never read a book) reads as an empty
// collection; present-but-malformed throws. Structural read only — no catalog needed.
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
  const next = { version: LIBRARY_COLLECTION_VERSION, entries: [...surface.entries, entry] };
  await api.writeJson(LIBRARY_COLLECTION_PATH, next);
  return next;
}

// Sets one entry's shelf mark. Load → replace that one entry → validate the whole surface → write,
// the same read-modify-write discipline `appendLibraryCollectionEntry` uses, so a favorite never
// writes back a snapshot older than a concurrent append. An unknown entry_id throws (404) before
// any write, and a rejected surface leaves the file byte-identical. Returns the saved entries in
// storage (append) order.
export async function setLibraryCollectionFavorite({ root, storage, entryId, favorite } = {}) {
  const id = nonEmptyString(entryId, 'entryId');
  if (typeof favorite !== 'boolean') throw new Error(`library collection favorite must be a boolean: ${favorite}`);
  const api = storageFor({ root, storage });
  const surface = await loadLibraryCollection({ storage: api });
  let found = false;
  const entries = surface.entries.map((entry) => {
    if (entry.entry_id !== id) return entry;
    found = true;
    return { ...entry, favorite };
  });
  if (!found) throw entryNotFoundError(id);
  const next = validateLibraryCollection({ version: LIBRARY_COLLECTION_VERSION, entries });
  await api.writeJson(LIBRARY_COLLECTION_PATH, next);
  return next.entries;
}

// Removes one entry from the shelf (処分). The favorite mark is not a guard here — a favorited book
// is disposed through this same call; the confirmation step is the UI's responsibility, so there is
// no second delete path and no force flag. An unknown entry_id throws (404) before any write.
// Returns the remaining entries in storage (append) order.
export async function removeLibraryCollectionEntry({ root, storage, entryId } = {}) {
  const id = nonEmptyString(entryId, 'entryId');
  const api = storageFor({ root, storage });
  const surface = await loadLibraryCollection({ storage: api });
  const entries = surface.entries.filter((entry) => entry.entry_id !== id);
  if (entries.length === surface.entries.length) throw entryNotFoundError(id);
  const next = validateLibraryCollection({ version: LIBRARY_COLLECTION_VERSION, entries });
  await api.writeJson(LIBRARY_COLLECTION_PATH, next);
  return next.entries;
}
