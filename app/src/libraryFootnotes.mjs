// 脚注 (library footnotes): the 「関連する本」 that closes a book the hero has just read.
//
// A footnote run is a SECOND pass over a book whose body is already read and already 収蔵された.
// It is deliberately not part of the read: the body's success is banked in the collection first,
// and this module works from that stored entry, so a slow or failed footnote costs nothing that was
// already earned and a retry is just another call with the same entry_id. Nothing here writes.
//
// The subject of a footnote run is one 収蔵 entry. A core entry resolves its references from the
// authored 中核関連宣言 (libraryCatalog's core reference table) and touches no generator at all; a
// periphery or generated entry hands its own stored 題/分類/本文 to one structured LLM call
// (`generators.generateFootnotes`) whose candidate list is 書誌情報 only.
//
// Two invariants shape the projection:
//   - 同題解決: a generated title that exactly matches a catalog title IS that catalog book
//     (`resolveLibraryCatalogTitle`, the same function the read route applies to `generated_title`),
//     so a 禁書 can never be walked around by asking for its 題 as if it were a new book.
//   - The reference projection carries the 題 and 可読 only. `readable` is decided by the hero's
//     CURRENT parameters through the same fail-closed gate the read route re-verifies, and no body,
//     skeleton, category or gate value is projected — a gated book shows as a title one cannot open.
//
// The whole run walks the 531-entry catalog a bounded number of times regardless of how many books
// are 収蔵されている: one index build, one candidate projection, then Map lookups per reference.

import { isLibraryBookReadable, libraryCatalogIndex, resolveLibraryCatalogTitle } from './libraryCatalog.mjs';
import { validateLibraryFootnotes } from './llm/libraryGeneration.mjs';

// A stored entry naming a catalog book that the CURRENT catalog cannot resolve. This is refused
// loudly instead of being re-read as a generated book: silently downgrading the layer would invent a
// catalog-external book out of a catalog one and hide the drift.
function unresolvedEntryBookError(bookId) {
  const error = new Error(`library collection entry names a book that is not in the catalog: ${bookId}`);
  error.statusCode = 500;
  error.errorCode = 'LIBRARY_FOOTNOTE_ENTRY_BOOK_UNRESOLVED';
  return error;
}

// A reference that survived the generation gate but breaks once resolved against the catalog. It is
// the same class of unusable output as a malformed generation, so it carries the same 503 tag.
function footnoteReferenceError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = 'LIBRARY_GENERATION_FAILED';
  return error;
}

function assertFootnoteGenerators(generators) {
  if (!generators || typeof generators !== 'object') throw new Error('library footnote generators are required');
  if (typeof generators.generateFootnotes !== 'function') {
    throw new Error('library footnote generators.generateFootnotes must be a function');
  }
  return generators;
}

// The book a footnote run is about, drawn from one stored 収蔵 entry. A core/periphery entry is
// re-resolved against the current catalog (so the 正本 title is used and drift is caught); a
// generated entry is its own subject with book_id null.
export function resolveLibraryFootnoteSubject({ entry, index } = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('library footnote subject requires a collection entry');
  if (!index || !(index.byId instanceof Map)) throw new Error('library footnote subject requires a catalog index');
  if (entry.layer === 'generated') {
    return {
      entry_id: entry.entry_id,
      layer: 'generated',
      book_id: null,
      title: entry.title,
      category: entry.category,
      text: entry.text
    };
  }
  const book = index.byId.get(entry.book_id);
  if (!book) throw unresolvedEntryBookError(entry.book_id);
  return {
    entry_id: entry.entry_id,
    layer: book.layer,
    book_id: book.id,
    title: book.title,
    category: book.category,
    text: entry.text
  };
}

// Canonicalizes one validated reference list against the catalog: every generated title that names
// an existing 題 becomes that catalog book, and the post-resolution list is re-checked for the two
// collisions resolution can create — the same book named twice under different spellings, and a
// reference that resolves back to the book being read.
export function canonicalizeLibraryFootnoteReferences({ references, index, subject } = {}) {
  if (!index || !(index.byId instanceof Map)) throw new Error('library footnote canonicalization requires a catalog index');
  if (!subject || typeof subject !== 'object') throw new Error('library footnote canonicalization requires a subject');
  if (!Array.isArray(references)) throw new Error('library footnote canonicalization requires a reference array');
  const canonical = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  for (const reference of references) {
    let bookId = null;
    let title = null;
    if (Object.prototype.hasOwnProperty.call(reference, 'book_id')) {
      const book = index.byId.get(reference.book_id);
      if (!book) throw footnoteReferenceError(`library footnote names an id outside the catalog: ${reference.book_id}`);
      bookId = book.id;
      title = book.title;
    } else {
      const resolved = resolveLibraryCatalogTitle(index, reference.generated_title);
      bookId = resolved === null ? null : resolved.id;
      title = resolved === null ? reference.generated_title : resolved.title;
    }
    if (bookId !== null && bookId === subject.book_id) {
      throw footnoteReferenceError(`library footnote resolves back to the book being read: ${bookId}`);
    }
    if (title === subject.title) {
      throw footnoteReferenceError(`library footnote resolves back to the book being read: ${title}`);
    }
    if (bookId !== null && seenIds.has(bookId)) {
      throw footnoteReferenceError(`library footnote resolves to the same book twice: ${bookId}`);
    }
    if (seenTitles.has(title)) throw footnoteReferenceError(`library footnote resolves to the same title twice: ${title}`);
    if (bookId !== null) seenIds.add(bookId);
    seenTitles.add(title);
    canonical.push({ book_id: bookId, title });
  }
  return canonical;
}

// Projects canonical references into what the reader is allowed to see: 題・層・可読 only. The layer is the
// catalog layer for a catalog reference and 'generated' for a catalog-external title, so the screen can dress the
// next book's cover before its read answers. A catalog reference is readable when the hero's current parameters
// open its gate (fail-closed, the same predicate the read route re-verifies); a catalog-external title has no gate
// and is always readable.
export function projectLibraryFootnoteReferences({ references, index, playerParameters } = {}) {
  if (!index || !(index.byId instanceof Map)) throw new Error('library footnote projection requires a catalog index');
  return references.map((reference) => {
    if (reference.book_id === null) return { book_id: null, title: reference.title, layer: 'generated', readable: true };
    const book = index.byId.get(reference.book_id);
    if (!book) throw footnoteReferenceError(`library footnote names an id outside the catalog: ${reference.book_id}`);
    return { book_id: book.id, title: book.title, layer: book.layer, readable: isLibraryBookReadable(book, playerParameters) };
  });
}

// The references an authored core book declares, in declaration order. A core book with no declared
// relation legitimately yields none — the empty list is the declaration, not a missing one.
export function coreLibraryFootnoteReferences({ subject, coreReferences } = {}) {
  if (!(coreReferences instanceof Map)) throw new Error('library core footnotes require a core reference Map');
  const declared = coreReferences.get(subject.book_id);
  if (declared === undefined) throw new Error(`library core references do not declare ${subject.book_id}`);
  return declared.map((bookId) => ({ book_id: bookId }));
}

// Builds the footnotes for one stored 収蔵 entry. Core reads the authored table (no generator call);
// periphery and generated run one structured generation over 書誌情報 candidates — the whole catalog,
// gated books included, because a 禁書 may be named as a thread. The generator's output passes the
// same closed gate the real generator applies, so an injected mock cannot widen the contract.
// Returns `{ entry_id, references:[{book_id,title,layer,readable}] }` and writes nothing.
export async function buildLibraryFootnotes({ entry, catalog, coreReferences, playerParameters, generators } = {}) {
  if (!Array.isArray(catalog)) throw new Error('library footnotes require a catalog array');
  const index = libraryCatalogIndex(catalog);
  const subject = resolveLibraryFootnoteSubject({ entry, index });
  let validated;
  if (subject.layer === 'core') {
    validated = coreLibraryFootnoteReferences({ subject, coreReferences });
  } else {
    assertFootnoteGenerators(generators);
    const candidates = catalog.map((book) => ({
      id: book.id,
      title: book.title,
      category: book.category,
      layer: book.layer
    }));
    const generated = await generators.generateFootnotes({
      title: subject.title,
      category: subject.category,
      text: subject.text,
      candidates,
      selfBookId: subject.book_id
    });
    validated = validateLibraryFootnotes(
      { references: generated },
      {
        candidateIds: new Set(candidates.map((candidate) => candidate.id)),
        selfBookId: subject.book_id,
        selfTitle: subject.title
      }
    );
  }
  const canonical = canonicalizeLibraryFootnoteReferences({ references: validated, index, subject });
  return {
    entry_id: subject.entry_id,
    references: projectLibraryFootnoteReferences({ references: canonical, index, playerParameters })
  };
}
