// 大書庫 (library): the routing "大書庫" destination orchestration (the 7th content destination).
//
// Catalog strict-loading + fail-closed gate filter live in libraryCatalog.mjs; the 収蔵庫 mutable
// surface lives in libraryCollection.mjs; the content-result shape lives in routingContentResult.mjs.
// This module is the feature owner that composes them into search and read, and owns the read
// write-path (収蔵 append + content-result merge). The HTTP surface (server/libraryApi.mjs) stays thin.
//
// Search is stateless (都度検索・週内固定 slot なし): gate-filter the catalog, let the LLM pick <=9
// theme-matching ids over the readable candidates, generation-fill the remaining slots with
// theme-bound titles, and add 6 free (catalog-external) books whose titles are likewise theme-bound
// (all lazy — titles only, no body). The free row is 一から全 LLM 生成, not a theme-free row. The two
// rows together are the shelf's 15 books: 目録N + 補充(9-N) + 自由6. No two books on one shelf share
// a title (generated books are identified by title): every generated title enters the shelf through
// one place that drops a title the shelf already holds and re-asks for the dropped count, naming the
// shelf's titles as ones not to use; a shelf still short after the declared retries is a 503. The same
// place drops a title longer than a cover can set (LIBRARY_GENERATED_TITLE_MAX_CHARS) and re-asks for it.
// Read resolves one book to its 文面: core = authored text (LM 不関与), periphery = skeleton ->
// style -> fragment from the authored skeleton, generated = lazy skeleton -> style -> fragment. The
// style stage picks one style_id (closed set of 4) from the 骨子 and the fragment prompt carries it;
// the chosen id travels on the readResult (core: null) into the 収蔵 entry. Committing a read appends
// the exact fragment to 収蔵 (the permanent surface, written first) and then folds the read identity
// into the routing content-result slot (append within the same library week, else a fresh record —
// the content result carries no style_id).
//
// The LLM is injected as a `generators` object ({ selectBookIds, generateTitles, generateSkeleton,
// selectStyle, generateFragment }) so this module carries no LM config; the API resolves mock vs
// real. A core read touches no generator, so it succeeds with LM unconfigured.

import { filterReadableLibraryBooks } from './libraryCatalog.mjs';
import { appendLibraryCollectionEntry, loadLibraryCollection } from './libraryCollection.mjs';
import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  buildLibraryContentResult,
  readRoutingContentResult,
  requireRoutingContentWeek
} from './routingContentResult.mjs';
import {
  LIBRARY_GENERATED_CATEGORY,
  LIBRARY_GENERATED_TITLE_MAX_CHARS,
  libraryGenerationError,
  libraryTitleFitsCover
} from './llm/libraryGeneration.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

// The search fills exactly this many "shelf" books (catalog selection + generation-fill), plus a
// separate row of free books. 9 + 6 = the 15 books the 書架 shows in one view.
export const LIBRARY_SEARCH_BOOK_COUNT = 9;
export const LIBRARY_FREE_BOOK_COUNT = 6;

// How many times one row may re-ask for the titles it lost to a duplicate or to the cover's length
// before the search fails. The footnote re-ask takes the same number.
export const LIBRARY_TITLE_RETRY_LIMIT = 2;

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`library ${label} is required`);
  return value.trim();
}

function assertGenerators(generators) {
  if (!generators || typeof generators !== 'object') throw new Error('library generators are required');
  for (const key of ['selectBookIds', 'generateTitles', 'generateSkeleton', 'generateFragment', 'selectStyle']) {
    if (typeof generators[key] !== 'function') throw new Error(`library generators.${key} must be a function`);
  }
  return generators;
}

// The identity a catalog/read book contributes to search rows and the content result: no text.
function catalogBookIdentity(book) {
  return { id: book.id, title: book.title, category: book.category, layer: book.layer };
}

// Builds one library search result. `catalog` is the normalized catalog; `playerParameters` gate the
// readable candidates (fail-closed). Returns { theme, catalog_books, generated_books, free_books }.
export async function buildLibrarySearch({ theme, catalog, playerParameters, generators } = {}) {
  const normalizedTheme = requireNonEmptyString(theme, 'search theme');
  if (!Array.isArray(catalog)) throw new Error('library search requires a catalog array');
  assertGenerators(generators);

  const candidates = filterReadableLibraryBooks(catalog, playerParameters);
  const candidateById = new Map(candidates.map((book) => [book.id, book]));
  const selectedIds = await generators.selectBookIds({
    theme: normalizedTheme,
    candidates: candidates.map((book) => ({ id: book.id, title: book.title, category: book.category }))
  });
  const catalogBooks = selectedIds.map((id) => {
    const book = candidateById.get(id);
    // selectBookIds is closed against the candidate id set, so a miss here is a contract break.
    if (!book) throw new Error(`library selection returned a non-candidate id: ${id}`);
    return catalogBookIdentity(book);
  });

  // The shelf's titles so far. Catalog titles are unique by the catalog's own contract, so they seed
  // the set; each generated row then adds only titles the set does not hold yet.
  const shelfTitles = new Set(catalogBooks.map((book) => book.title));
  const fillCount = LIBRARY_SEARCH_BOOK_COUNT - catalogBooks.length;
  const generatedBooks = fillCount > 0
    ? (await generateDistinctTitles({ theme: normalizedTheme, count: fillCount, shelfTitles, generators })).map((title) => ({ title }))
    : [];
  const freeBooks = (await generateDistinctTitles({ theme: normalizedTheme, count: LIBRARY_FREE_BOOK_COUNT, shelfTitles, generators }))
    .map((title) => ({ title }));

  return {
    theme: normalizedTheme,
    catalog_books: catalogBooks,
    generated_books: generatedBooks,
    free_books: freeBooks
  };
}

// The one place a generated title enters the shelf: asks for `count` titles excluding every title
// already in `shelfTitles`, keeps each returned title that fits a cover and that the shelf does not hold
// yet (in order, adding it to `shelfTitles`), and re-asks for the missing count up to
// LIBRARY_TITLE_RETRY_LIMIT times. A row still short after that is a 503 — never a silently shorter
// or truncated shelf. Returns exactly `count` titles.
async function generateDistinctTitles({ theme, count, shelfTitles, generators }) {
  const row = [];
  for (let attempt = 0; attempt <= LIBRARY_TITLE_RETRY_LIMIT && row.length < count; attempt += 1) {
    const titles = await generators.generateTitles({ theme, count: count - row.length, excludedTitles: [...shelfTitles] });
    for (const title of titles) {
      if (row.length < count && libraryTitleFitsCover(title) && !shelfTitles.has(title)) {
        shelfTitles.add(title);
        row.push(title);
      }
    }
  }
  if (row.length < count) {
    throw libraryGenerationError(
      `library search could not fill ${count} distinct titles of at most ${LIBRARY_GENERATED_TITLE_MAX_CHARS} characters after ${LIBRARY_TITLE_RETRY_LIMIT} retries: got ${row.length}`
    );
  }
  return row;
}

// Resolves a catalog book to its read 文面. Core returns the authored text (no generator call,
// style_id null); periphery selects a style from the authored skeleton and generates a fragment
// from that skeleton (+backbone flag) under the chosen style. The caller has already re-verified
// the gate. Returns { title, category, layer, text, book_id, style_id }.
export async function readLibraryCatalogBook({ book, generators } = {}) {
  if (!book || typeof book !== 'object') throw new Error('library read requires a catalog book');
  assertGenerators(generators);
  if (book.layer === 'core') {
    return {
      title: book.title,
      category: book.category,
      layer: 'core',
      text: requireNonEmptyString(book.text, `core book ${book.id} text`),
      book_id: book.id,
      style_id: null
    };
  }
  if (book.layer === 'periphery') {
    const styleId = await generators.selectStyle({
      title: book.title,
      category: book.category,
      skeleton: book.skeleton
    });
    const text = await generators.generateFragment({
      title: book.title,
      category: book.category,
      skeleton: book.skeleton,
      backbone: book.backbone,
      style_id: styleId
    });
    return { title: book.title, category: book.category, layer: 'periphery', text, book_id: book.id, style_id: styleId };
  }
  throw new Error(`library read cannot resolve book layer: ${book.layer}`);
}

// Resolves a generated (catalog-external) book by title through the lazy chain skeleton -> style
// -> fragment (backbone always withheld). Returns { title, category, layer:'generated', text,
// book_id:null, style_id }.
export async function readLibraryGeneratedBook({ generatedTitle, generators } = {}) {
  const title = requireNonEmptyString(generatedTitle, 'generated_title');
  assertGenerators(generators);
  const skeleton = await generators.generateSkeleton({ title });
  const styleId = await generators.selectStyle({ title, category: LIBRARY_GENERATED_CATEGORY, skeleton });
  const text = await generators.generateFragment({
    title,
    category: LIBRARY_GENERATED_CATEGORY,
    skeleton,
    backbone: false,
    style_id: styleId
  });
  return { title, category: LIBRARY_GENERATED_CATEGORY, layer: 'generated', text, book_id: null, style_id: styleId };
}

// Folds one read into the routing content-result slot. Within the same library-reading week the new
// book APPENDS to the existing library record's books; any other current slot (different week, or a
// non-library kind) is destructively replaced by a fresh library record. Pure.
export function mergeLibraryContentResult({ existing, week, now, book } = {}) {
  const priorBooks = existing !== null && existing !== undefined
    && existing.kind === 'library' && existing.week === week
    ? existing.detail.books
    : [];
  return buildLibraryContentResult({
    week,
    now,
    books: [...priorBooks, { book_id: book.book_id, title: book.title, category: book.category, layer: book.layer }]
  });
}

// A read's 収蔵 entry id: stable within a save from the read timestamp plus the current entry count,
// so successive reads never collide.
export function makeLibraryCollectionEntryId({ now, seq }) {
  const stamp = requireNonEmptyString(now, 'collection entry now').replace(/[^0-9A-Za-z]/g, '');
  if (!Number.isInteger(seq) || seq < 0) throw new Error('library collection entry seq must be a non-negative integer');
  return `libentry_${stamp}_${seq}`;
}

// Commits one resolved read: append the exact fragment to 収蔵 (permanent surface, written first),
// then merge the read identity into the routing content-result slot. `catalogBookIds` is the catalog
// id set the collection append validates a core/periphery book_id against. Returns
// { collection_entry_id, content_result, week }.
export async function commitLibraryRead({ storage, readResult, catalogBookIds, now } = {}) {
  if (!storage) throw new Error('library commit requires storage');
  if (!readResult || typeof readResult !== 'object') throw new Error('library commit requires a readResult');
  const recordedAt = requireNonEmptyString(now, 'commit now');
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = requireRoutingContentWeek(state);

  const surface = await loadLibraryCollection({ storage });
  const entryId = makeLibraryCollectionEntryId({ now: recordedAt, seq: surface.entries.length });
  await appendLibraryCollectionEntry({
    storage,
    catalogBookIds,
    entry: {
      entry_id: entryId,
      book_id: readResult.book_id,
      title: readResult.title,
      category: readResult.category,
      layer: readResult.layer,
      text: readResult.text,
      read_week: week,
      // A fresh 収蔵 is never pre-marked: favorite is written explicitly false rather than left to
      // a reader default, so the v3 shape is complete the moment the entry is stored.
      favorite: false,
      // The style the read was written under (core: null). Taken from the readResult as-is — the
      // collection validator, not a default here, is what refuses a missing or unknown id.
      style_id: readResult.style_id
    }
  });

  const existing = readRoutingContentResult(state);
  const record = mergeLibraryContentResult({ existing, week, now: recordedAt, book: readResult });
  await storage.writeJson(RUNTIME_STATE_PATH, { ...state, [ROUTING_CONTENT_RESULT_STATE_KEY]: record });

  return { collection_entry_id: entryId, content_result: record, week };
}
