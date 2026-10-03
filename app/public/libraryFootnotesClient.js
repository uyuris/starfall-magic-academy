// Pure, DOM-independent library-footnotes contract checks, shared by app.js and headless unit tests so the
// fail-fast paths — the POST /api/library/footnotes response shape and the read target a 関連する本 link sends —
// are verifiable without a browser (the same headless-testable seam as libraryCollectionViewClient.js).
//
// 脚注 (footnotes) are fetched INDEPENDENTLY of the body: POST /api/library/read banks the fragment into the
// 収蔵庫 and returns collection_entry_id, and a SECOND request — POST /api/library/footnotes { entry_id } —
// answers { entry_id, references: [{ book_id, title, layer, readable }] }. The backend never converts a failure into an
// empty list, so "0 references" and "the call failed" are distinct states; this module keeps that distinction by
// refusing anything that is not the declared shape instead of degrading it into an empty 関連する本 box.
//
// book_id is a catalog id for a catalog reference and null for a generated one (the XOR the read API expects);
// readable says whether the CURRENT 主人公パラメータ can open it, so an unreadable (禁書) reference renders as a
// title plus 今は開けない and carries NO read target at all.

export const LIBRARY_FOOTNOTES_REQUEST_PATH = '/api/library/footnotes';

const LIBRARY_FOOTNOTE_LAYERS = new Set(['core', 'periphery', 'generated']);
// Per-layer count bands, pinned to the backend contract: 中核 answers from the authored 関連宣言 (0-3, and 0 is a
// legitimate declaration → no 関連する本 box at all), 周縁/生成 answer from generation (2-3, never fewer).
const LIBRARY_FOOTNOTE_COUNTS = Object.freeze({
  core: { min: 0, max: 3 },
  periphery: { min: 2, max: 3 },
  generated: { min: 2, max: 3 }
});
const LIBRARY_FOOTNOTE_REFERENCE_KEYS = Object.freeze(['book_id', 'title', 'layer', 'readable']);

function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

// Validate the POST /api/library/footnotes payload for the book it was requested for and return its references IN
// THE RECEIVED ORDER. A payload naming another entry_id, an unknown shape, a count outside the layer's band, a
// duplicate, or a generated reference claiming to be unreadable is broken state → fail fast (never an empty list,
// never a blanked field). The same array is returned (identity), so no copy can silently drop a reference.
export function parseLibraryFootnotes(payload, { entryId, layer } = {}) {
  if (typeof entryId !== 'string' || entryId === '') {
    throw new Error(`library footnotes require a non-empty entryId to check against, got ${JSON.stringify(entryId)}`);
  }
  if (!LIBRARY_FOOTNOTE_LAYERS.has(layer)) {
    throw new Error(`library footnotes require a layer in {core,periphery,generated}, got ${JSON.stringify(layer)}`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`library footnotes response must be an object, got ${JSON.stringify(payload)}`);
  }
  if (payload.entry_id !== entryId) {
    throw new Error(`library footnotes response entry_id must be ${entryId}, got ${JSON.stringify(payload.entry_id)}`);
  }
  const references = payload.references;
  if (!Array.isArray(references)) {
    throw new Error(`library footnotes response requires a references array, got ${JSON.stringify(references)}`);
  }
  const { min, max } = LIBRARY_FOOTNOTE_COUNTS[layer];
  if (references.length < min || references.length > max) {
    throw new Error(`library footnotes for a ${layer} book require ${min}-${max} references, got ${references.length}`);
  }
  const seenBookIds = new Set();
  const seenTitles = new Set();
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') {
      throw new Error(`library footnote reference must be an object, got ${JSON.stringify(reference)}`);
    }
    if (!hasExactKeys(reference, LIBRARY_FOOTNOTE_REFERENCE_KEYS)) {
      throw new Error(`library footnote reference requires the exact keys {book_id,title,layer,readable}, got ${JSON.stringify(reference)}`);
    }
    if (typeof reference.title !== 'string' || reference.title === '') {
      throw new Error(`library footnote reference requires a non-empty title string, got ${JSON.stringify(reference)}`);
    }
    if (reference.book_id !== null && (typeof reference.book_id !== 'string' || reference.book_id === '')) {
      throw new Error(`library footnote reference requires a non-empty book_id string or null, got ${JSON.stringify(reference)}`);
    }
    // layer is the catalog layer of a catalog reference and 'generated' for a catalog-external one (book_id null).
    const expectedLayers = reference.book_id === null ? ['generated'] : ['core', 'periphery'];
    if (!expectedLayers.includes(reference.layer)) {
      throw new Error(`library footnote reference requires a layer in {${expectedLayers.join(',')}}, got ${JSON.stringify(reference)}`);
    }
    if (typeof reference.readable !== 'boolean') {
      throw new Error(`library footnote reference requires a boolean readable, got ${JSON.stringify(reference)}`);
    }
    // A generated reference has no catalog gate to fail — an unreadable one would be a title nothing can ever open.
    if (reference.book_id === null && reference.readable !== true) {
      throw new Error(`library footnote generated reference must be readable, got ${JSON.stringify(reference)}`);
    }
    if (reference.book_id !== null) {
      if (seenBookIds.has(reference.book_id)) {
        throw new Error(`library footnotes carry a duplicate reference book_id ${JSON.stringify(reference.book_id)}`);
      }
      seenBookIds.add(reference.book_id);
    }
    if (seenTitles.has(reference.title)) {
      throw new Error(`library footnotes carry a duplicate reference title ${JSON.stringify(reference.title)}`);
    }
    seenTitles.add(reference.title);
  }
  return references;
}

// The read target a 関連する本 link sends to POST /api/library/read: { book_id } for a catalog reference,
// { generated_title } for a generated one — the exact XOR the backend accepts. An unreadable reference is a title
// on the page, not a link, so asking for its target is a wiring bug → throw (never a silently skipped request).
export function libraryFootnoteReadTarget(reference) {
  if (!reference || typeof reference !== 'object') {
    throw new Error(`library footnote reference must be an object, got ${JSON.stringify(reference)}`);
  }
  if (reference.readable !== true) {
    throw new Error(`library footnote unreadable reference has no read target: ${JSON.stringify(reference)}`);
  }
  if (reference.book_id === null) {
    if (typeof reference.title !== 'string' || reference.title === '') {
      throw new Error(`library footnote generated reference requires a title, got ${JSON.stringify(reference)}`);
    }
    return { generated_title: reference.title };
  }
  if (typeof reference.book_id !== 'string' || reference.book_id === '') {
    throw new Error(`library footnote reference requires a non-empty book_id string or null, got ${JSON.stringify(reference)}`);
  }
  return { book_id: reference.book_id };
}
