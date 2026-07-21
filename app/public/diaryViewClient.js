// Pure, DOM-independent diary-view contract checks, shared by app.js and headless unit tests so the fail-fast
// paths — the diary request path (missing character_id) and the GET /api/diary response shape — are verifiable
// without a browser (the same headless-testable seam as alchemyArrivalClient.js / routingDispatchClient.js).
//
// The diary read API (GET /api/diary?character_id=<id>) returns { character_id, entries }, where entries is the
// character's saved conversation-derived memories ALREADY in chronological order. The frontend renders them AS
// RECEIVED — parseDiaryEntries never re-sorts, filters, drops, or fabricates, so the backend chronology stays the
// single source of truth. The raw type / tags metadata is not surfaced; only entry.text is read, so that is the
// one field this contract requires.

export function diaryRequestPath(characterId) {
  if (typeof characterId !== 'string' || characterId === '') {
    throw new Error(`diary request requires a non-empty character_id string, got ${JSON.stringify(characterId)}`);
  }
  return `/api/diary?character_id=${encodeURIComponent(characterId)}`;
}

// Validate the GET /api/diary payload and return its entries IN THE RECEIVED ORDER (no client re-sort — the
// backend owns chronology). A non-object payload, a missing/non-array entries field, or an entry without a text
// string is broken state → fail fast (never a silent empty list). The same array is returned (identity), so no
// copy/transform can silently drop entries or fields; the renderer reads only entry.text but the other fields are
// left intact.
export function parseDiaryEntries(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`diary response must be an object, got ${JSON.stringify(payload)}`);
  }
  const entries = payload.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`diary response requires an entries array, got ${JSON.stringify(entries)}`);
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`diary entry must be an object, got ${JSON.stringify(entry)}`);
    }
    if (typeof entry.text !== 'string') {
      throw new Error(`diary entry requires a text string, got ${JSON.stringify(entry)}`);
    }
  }
  return entries;
}
