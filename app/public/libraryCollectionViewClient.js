// Pure, DOM-independent library-collection-view contract checks, shared by app.js and headless unit tests so the
// fail-fast paths — the GET /api/library/collection response shape — are verifiable without a browser (the same
// headless-testable seam as diaryViewClient.js / routingDispatchClient.js).
//
// The 収蔵庫 read API (GET /api/library/collection) returns { entries }, where entries is the player's saved
// point-in-time book fragments ALREADY in the order the backend stores them (append order). Parsing never
// re-sorts, filters, drops, or fabricates, so the received payload stays the single source of truth. Each entry
// is a saved reading; the renderer reads entry_id / book_id / title / category / layer / text / read_week /
// favorite, so those are the fields this contract requires (the closed layer set drives the 装丁 tone, entry_id
// is the key the favorite / dispose mutations address, and favorite is the ★ on the spine). style_id is the
// 文体 the fragment was written under (one of the closed 4 ids, or null for an authored core book): it is part
// of the entry shape and checked here, but not rendered. An absent / empty collection is a legitimate initial
// state (the empty array is honest, not an error).
//
// 並び替え is DISPLAY state, not storage: sortLibraryCollectionEntries returns a reordered COPY for the shelf and
// writes nothing, so the stored append order is untouched and the received array keeps its identity.

export const LIBRARY_COLLECTION_REQUEST_PATH = '/api/library/collection';
export const LIBRARY_COLLECTION_FAVORITE_PATH = '/api/library/collection/favorite';
export const LIBRARY_COLLECTION_DISPOSE_PATH = '/api/library/collection/dispose';

// The closed 4軸 set, in the order the 並び替え select lists them (the first is the initial 読んだ週 order).
export const LIBRARY_COLLECTION_SORT_KEYS = Object.freeze(['read_week', 'title', 'category', 'favorite']);

const LIBRARY_COLLECTION_LAYERS = new Set(['core', 'periphery', 'generated']);
// The closed style set the backend records (LIBRARY_STYLE_IDS in app/src/llm/libraryGeneration.mjs), fixed order.
const LIBRARY_COLLECTION_STYLE_IDS = new Set(['light', 'solemn', 'dry', 'intimate']);

// Validate the GET /api/library/collection payload and return its entries IN THE RECEIVED ORDER (no client
// re-sort at parse time — 並び替え is a separate display step). A non-object payload, a missing/non-array entries
// field, or an entry missing a rendered field (entry_id a non-empty string unique across the surface, title /
// category / text non-empty strings, layer in the closed set, book_id agreeing with the layer, read_week a
// non-negative integer, favorite a boolean, style_id null or in the closed style set) is broken state → fail
// fast (never a silent empty list, never a defaulted favorite or style). The same array is returned (identity), so
// no copy/transform can silently drop entries or fields.
export function parseLibraryCollectionEntries(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`library collection response must be an object, got ${JSON.stringify(payload)}`);
  }
  const entries = payload.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`library collection response requires an entries array, got ${JSON.stringify(entries)}`);
  }
  const seenEntryIds = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`library collection entry must be an object, got ${JSON.stringify(entry)}`);
    }
    if (typeof entry.entry_id !== 'string' || entry.entry_id === '') {
      throw new Error(`library collection entry requires a non-empty entry_id string, got ${JSON.stringify(entry)}`);
    }
    if (seenEntryIds.has(entry.entry_id)) {
      throw new Error(`library collection carries a duplicate entry_id ${JSON.stringify(entry.entry_id)}`);
    }
    seenEntryIds.add(entry.entry_id);
    for (const field of ['title', 'category', 'text']) {
      if (typeof entry[field] !== 'string' || entry[field] === '') {
        throw new Error(`library collection entry requires a non-empty ${field} string, got ${JSON.stringify(entry)}`);
      }
    }
    if (!LIBRARY_COLLECTION_LAYERS.has(entry.layer)) {
      throw new Error(`library collection entry requires a layer in {core,periphery,generated}, got ${JSON.stringify(entry.layer)}`);
    }
    // book_id and layer must agree: a 生成写本 has no catalog id, a catalog book always has one.
    if (entry.layer === 'generated') {
      if (entry.book_id !== null) {
        throw new Error(`library collection generated entry requires book_id null, got ${JSON.stringify(entry)}`);
      }
    } else if (typeof entry.book_id !== 'string' || entry.book_id === '') {
      throw new Error(`library collection ${entry.layer} entry requires a non-empty book_id, got ${JSON.stringify(entry)}`);
    }
    if (!Number.isInteger(entry.read_week) || entry.read_week < 0) {
      throw new Error(`library collection entry requires a non-negative integer read_week, got ${JSON.stringify(entry.read_week)}`);
    }
    if (typeof entry.favorite !== 'boolean') {
      throw new Error(`library collection entry requires a boolean favorite, got ${JSON.stringify(entry)}`);
    }
    if (entry.style_id !== null && !LIBRARY_COLLECTION_STYLE_IDS.has(entry.style_id)) {
      throw new Error(`library collection entry requires a style_id of null or in {light,solemn,dry,intimate}, got ${JSON.stringify(entry.style_id)}`);
    }
  }
  return entries;
}

// 題 / 分類 compare by the Japanese collation order (the written strings — no 読み仮名 table).
const LIBRARY_COLLECTION_JA_COLLATOR = new Intl.Collator('ja');

// The declared tie-break, applied after every axis: 読んだ週 newest first, then entry_id ascending. entry_id is
// compared with < / > (code-point order), NOT the locale collator, so the fallback order is locale-independent.
function compareLibraryCollectionTieBreak(a, b) {
  if (a.read_week !== b.read_week) return b.read_week - a.read_week;
  if (a.entry_id === b.entry_id) return 0;
  return a.entry_id < b.entry_id ? -1 : 1;
}

const LIBRARY_COLLECTION_SORT_COMPARATORS = Object.freeze({
  // 読んだ週 has no primary of its own — the tie-break IS the 週 desc → entry_id asc order.
  read_week: () => 0,
  title: (a, b) => LIBRARY_COLLECTION_JA_COLLATOR.compare(a.title, b.title),
  category: (a, b) => LIBRARY_COLLECTION_JA_COLLATOR.compare(a.category, b.category),
  favorite: (a, b) => Number(b.favorite) - Number(a.favorite)
});

// Reorder the shelf for display. The sort key is the closed 4軸 set — an unknown key is a wiring bug → throw
// (never a silent fall back to the received order). The received array is NOT mutated: a copy is sorted and
// returned, so the parsed payload stays exactly what the backend sent and nothing is written to storage.
export function sortLibraryCollectionEntries(entries, sortKey) {
  const primary = Object.prototype.hasOwnProperty.call(LIBRARY_COLLECTION_SORT_COMPARATORS, sortKey)
    ? LIBRARY_COLLECTION_SORT_COMPARATORS[sortKey]
    : null;
  if (!primary) {
    throw new Error(`library collection requires a sort key in {read_week,title,category,favorite}, got ${JSON.stringify(sortKey)}`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`library collection sort requires an entries array, got ${JSON.stringify(entries)}`);
  }
  return [...entries].sort((a, b) => primary(a, b) || compareLibraryCollectionTieBreak(a, b));
}
