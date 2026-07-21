// Pure, DOM-independent library-collection-view contract checks, shared by app.js and headless unit tests so the
// fail-fast paths — the GET /api/library/collection response shape — are verifiable without a browser (the same
// headless-testable seam as diaryViewClient.js / routingDispatchClient.js).
//
// The 収蔵庫 read API (GET /api/library/collection) returns { entries }, where entries is the player's saved
// point-in-time book fragments ALREADY in the order the backend stores them (append order). The frontend renders
// them AS RECEIVED — parseLibraryCollectionEntries never re-sorts, filters, drops, or fabricates, so the backend
// order stays the single source of truth. Each entry is a saved reading; the renderer reads title / category /
// layer / text / read_week, so those are the fields this contract requires (the closed layer set drives the 装丁
// tone). An absent / empty collection is a legitimate initial state (the empty array is honest, not an error).

export const LIBRARY_COLLECTION_REQUEST_PATH = '/api/library/collection';

const LIBRARY_COLLECTION_LAYERS = new Set(['core', 'periphery', 'generated']);

// Validate the GET /api/library/collection payload and return its entries IN THE RECEIVED ORDER (no client
// re-sort — the backend owns order). A non-object payload, a missing/non-array entries field, or an entry missing
// a rendered field (title / category / text non-empty string, layer in the closed set, read_week a non-negative
// integer) is broken state → fail fast (never a silent empty list). The same array is returned (identity), so no
// copy/transform can silently drop entries or fields.
export function parseLibraryCollectionEntries(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`library collection response must be an object, got ${JSON.stringify(payload)}`);
  }
  const entries = payload.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`library collection response requires an entries array, got ${JSON.stringify(entries)}`);
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`library collection entry must be an object, got ${JSON.stringify(entry)}`);
    }
    for (const field of ['title', 'category', 'text']) {
      if (typeof entry[field] !== 'string' || entry[field] === '') {
        throw new Error(`library collection entry requires a non-empty ${field} string, got ${JSON.stringify(entry)}`);
      }
    }
    if (!LIBRARY_COLLECTION_LAYERS.has(entry.layer)) {
      throw new Error(`library collection entry requires a layer in {core,periphery,generated}, got ${JSON.stringify(entry.layer)}`);
    }
    if (!Number.isInteger(entry.read_week) || entry.read_week < 0) {
      throw new Error(`library collection entry requires a non-negative integer read_week, got ${JSON.stringify(entry.read_week)}`);
    }
  }
  return entries;
}
