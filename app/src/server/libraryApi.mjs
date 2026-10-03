import { resolvePostContentScreen } from '../playMode.mjs';
import { requireRoutingContentWeek } from '../routingContentResult.mjs';
import { createStorageApi } from '../storage.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import {
  isLibraryBookReadable,
  libraryCatalogIndex,
  loadLibraryCatalog,
  loadLibraryCoreReferences,
  resolveLibraryCatalogTitle
} from '../libraryCatalog.mjs';
import { buildLibraryFootnotes } from '../libraryFootnotes.mjs';
import {
  loadLibraryCollection,
  removeLibraryCollectionEntry,
  setLibraryCollectionFavorite
} from '../libraryCollection.mjs';
import {
  LIBRARY_TITLE_RETRY_LIMIT,
  buildLibrarySearch,
  commitLibraryRead,
  readLibraryCatalogBook,
  readLibraryGeneratedBook
} from '../routingLibrary.mjs';
import {
  LIBRARY_STYLE_IDS,
  generateLibraryFootnotes,
  generateLibraryFragmentText,
  generateLibrarySkeleton,
  generateLibraryTitles,
  selectLibraryBookIds,
  selectLibraryStyle
} from '../llm/libraryGeneration.mjs';

const PLAYER_PARAMETERS_PATH = 'game_data/runtime/player_parameters.json';

const ROUTES = new Set([
  'GET /api/library',
  'POST /api/library/search',
  'POST /api/library/read',
  'POST /api/library/footnotes',
  'GET /api/library/collection',
  'POST /api/library/collection/favorite',
  'POST /api/library/collection/dispose'
]);

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertRoutingMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (activePlayMode.mode !== 'routing') {
    throw statusError('library content requires routing mode', 409, { errorCode: 'ROUTING_MODE_REQUIRED' });
  }
}

function requiredTheme(value) {
  // Strict string (mirrors the book_id / generated_title handling in the read route): a non-string
  // theme is 不正 input rejected with 400, not silently coerced (123 -> "123") into a valid search.
  if (typeof value !== 'string' || !value.trim()) {
    throw statusError('theme must be a non-empty string', 400, { errorCode: 'LIBRARY_THEME_REQUIRED' });
  }
  return value.trim();
}

export function canHandleLibraryApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

// The 収蔵 mutation bodies are closed: exactly the declared keys, nothing more. An extra key is a
// caller that believes in an affordance this API does not have (a confirm flag, a provider hint),
// so it is refused rather than ignored — the shelf mutations touch no generator and take no options.
function assertExactBodyKeys(body, expectedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw statusError('request body must be an object', 400, { errorCode: 'LIBRARY_COLLECTION_BODY_INVALID' });
  }
  const unexpected = Object.keys(body).filter((key) => !expectedKeys.includes(key));
  if (unexpected.length > 0) {
    throw statusError(
      `unexpected body key(s) for this route: ${unexpected.join(', ')}`,
      400,
      { errorCode: 'LIBRARY_COLLECTION_BODY_UNEXPECTED_KEY' }
    );
  }
  return body;
}

// entry_id addresses a stored 収蔵 entry verbatim — it is never trimmed or coerced, so a missing,
// empty or non-string id is 400 here and never reaches the surface as a lookup that would 404.
function requiredEntryId(value) {
  if (typeof value !== 'string' || value === '') {
    throw statusError('entry_id must be a non-empty string', 400, { errorCode: 'LIBRARY_COLLECTION_ENTRY_ID_REQUIRED' });
  }
  return value;
}

// The footnote body is closed the same way: `entry_id` plus the provider seam every generating
// library route accepts, and nothing else. The read book's 本文 / 分類 / layer are NOT accepted from
// the client — the stored 収蔵 entry is the only authority for what is being footnoted.
function assertFootnoteBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw statusError('request body must be an object', 400, { errorCode: 'LIBRARY_FOOTNOTES_BODY_INVALID' });
  }
  const unexpected = Object.keys(body).filter((key) => key !== 'entry_id' && key !== 'provider');
  if (unexpected.length > 0) {
    throw statusError(
      `unexpected body key(s) for this route: ${unexpected.join(', ')}`,
      400,
      { errorCode: 'LIBRARY_FOOTNOTES_BODY_UNEXPECTED_KEY' }
    );
  }
  return body;
}

function requiredFootnoteEntryId(value) {
  if (typeof value !== 'string' || value === '') {
    throw statusError('entry_id must be a non-empty string', 400, { errorCode: 'LIBRARY_FOOTNOTES_ENTRY_ID_REQUIRED' });
  }
  return value;
}

function requiredFavorite(value) {
  if (typeof value !== 'boolean') {
    throw statusError('favorite must be a boolean', 400, { errorCode: 'LIBRARY_COLLECTION_FAVORITE_REQUIRED' });
  }
  return value;
}

// The mock style choice: a deterministic pick from the closed set by the title's code points, so
// the same title always reads under the same style and different titles spread over the 4 ids.
function mockLibraryStyleId(title) {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.codePointAt(0)) % 0x7fffffff;
  return LIBRARY_STYLE_IDS[hash % LIBRARY_STYLE_IDS.length];
}

// The mock generators produce deterministic, gate-clean output without touching the LLM (the
// ?provider=mock affordance for tests). Selection picks the leading readable candidates so a
// search covers both catalog rows and generation-fill; titles are theme-bound for both the fill and
// the free row (the two rows are told apart by their presentation column, not by the title text);
// the style is a title hash over the closed set.
function mockLibraryGenerators() {
  const MOCK_SELECT_COUNT = 3;
  return {
    selectBookIds: async ({ candidates }) => candidates.slice(0, MOCK_SELECT_COUNT).map((candidate) => candidate.id),
    generateTitles: async ({ count, excludedTitles }) => {
      const titles = [];
      for (let number = 1; titles.length < count; number += 1) {
        const title = `蔵書写本${number}`;
        if (!excludedTitles.includes(title)) titles.push(title);
      }
      return titles;
    },
    generateSkeleton: async ({ title }) => `『${title}』の緩い骨子。何の本か・眼差し・味わいを端的に示す短いスケッチ。`,
    selectStyle: async ({ title }) => mockLibraryStyleId(title),
    generateFragment: async ({ title, category }) => `${title}（${category}）の一節。羊皮紙の頁に鉄褐色の文字が静かに並んでいる。`,
    // Three references covering the two reference kinds and both catalog layers: the leading core
    // book (whose gate the projection then decides), the leading periphery book, and one
    // catalog-external title. Deterministic and never self-referential.
    generateFootnotes: async ({ title, candidates, selfBookId }) => {
      const core = candidates.find((candidate) => candidate.layer === 'core' && candidate.id !== selfBookId);
      const periphery = candidates.find((candidate) => candidate.layer === 'periphery' && candidate.id !== selfBookId);
      if (!core || !periphery) throw new Error('mock library footnotes need a core and a periphery candidate');
      return [{ book_id: core.id }, { book_id: periphery.id }, { generated_title: `${title}余聞` }];
    }
  };
}

// Resolves the library generators for this request. The mock set is used when ?provider=mock;
// otherwise the real generators resolve the LM config LAZILY on first call, so a core read (which
// calls no generator) never touches LM config and succeeds with LM unconfigured.
function resolveLibraryGenerators({ requestedProvider, resolveLmStudioConfig }) {
  if (requestedProvider === 'mock') return mockLibraryGenerators();
  if (typeof resolveLmStudioConfig !== 'function') throw new Error('resolveLmStudioConfig is required');
  let configPromise = null;
  const config = async () => {
    if (!configPromise) configPromise = resolveLmStudioConfig();
    return configPromise;
  };
  return {
    selectBookIds: async ({ theme, candidates }) => selectLibraryBookIds({ config: await config(), theme, candidates }),
    generateTitles: async ({ theme, count, excludedTitles }) => generateLibraryTitles({ config: await config(), theme, count, excludedTitles }),
    generateSkeleton: async ({ title }) => generateLibrarySkeleton({ config: await config(), title }),
    selectStyle: async ({ title, category, skeleton }) => selectLibraryStyle({ config: await config(), title, category, skeleton }),
    generateFragment: async ({ title, category, skeleton, backbone, style_id }) => generateLibraryFragmentText({
      config: await config(),
      title,
      category,
      skeleton,
      backbone,
      style_id
    }),
    generateFootnotes: async ({ title, category, text, candidates, selfBookId }) => generateLibraryFootnotes({
      config: await config(),
      title,
      category,
      text,
      candidates,
      selfBookId,
      retryLimit: LIBRARY_TITLE_RETRY_LIMIT
    })
  };
}

async function loadPlayerParameters(storage) {
  const parameters = await storage.readJsonIfExists(PLAYER_PARAMETERS_PATH);
  if (parameters === null || parameters === undefined) throw new Error('player parameters are required for the library');
  return parameters;
}

function requestedProviderFor({ url, body }) {
  const value = url.searchParams.get('provider') ?? (body && typeof body === 'object' ? body.provider : undefined) ?? undefined;
  return assertRecognizedRoutingProvider(value);
}

export async function handleLibraryApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  activePlayMode,
  resolveLmStudioConfig
}) {
  if (!canHandleLibraryApiRoute(req.method, url.pathname)) return false;
  assertRoutingMode(activePlayMode);
  const root = context.activeRoot ?? context.root;
  const storage = createStorageApi({ root });

  if (req.method === 'GET' && url.pathname === '/api/library') {
    // Arrival view for the stay-type library screen: the current week (display header) and the
    // server-authoritative exit destination, so the frontend never hardcodes where 「書庫を出る」 goes
    // (the workshop/alchemy grammar). LM is not touched — the library is a routing-only stay screen and
    // the exit resolves identically to the other content screens (routing → the routing hub).
    const state = await storage.readJson('game_data/runtime_state.json');
    const week = requireRoutingContentWeek(state);
    const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-map' });
    return sendJson(res, { week, post_content_screen: postContentScreen });
  }

  if (req.method === 'GET' && url.pathname === '/api/library/collection') {
    const surface = await loadLibraryCollection({ storage });
    return sendJson(res, { entries: surface.entries });
  }

  // The two shelf mutations (お気に入り / 処分) are pure storage edits inside the same routing-mode
  // gate as the rest of the library: no generator, no LM config touch, and nothing written outside
  // library_collection.json (no content result, no player parameters, no conversation record).
  if (req.method === 'POST' && url.pathname === '/api/library/collection/favorite') {
    const body = assertExactBodyKeys(await readBody(req), ['entry_id', 'favorite']);
    const entries = await setLibraryCollectionFavorite({
      storage,
      entryId: requiredEntryId(body.entry_id),
      favorite: requiredFavorite(body.favorite)
    });
    return sendJson(res, { entries });
  }

  if (req.method === 'POST' && url.pathname === '/api/library/collection/dispose') {
    const body = assertExactBodyKeys(await readBody(req), ['entry_id']);
    const entries = await removeLibraryCollectionEntry({ storage, entryId: requiredEntryId(body.entry_id) });
    return sendJson(res, { entries });
  }

  if (req.method === 'POST' && url.pathname === '/api/library/search') {
    const body = await readBody(req);
    const theme = requiredTheme(body.theme);
    const catalog = await loadLibraryCatalog({ root });
    const playerParameters = await loadPlayerParameters(storage);
    const generators = resolveLibraryGenerators({
      requestedProvider: requestedProviderFor({ url, body }),
      resolveLmStudioConfig
    });
    const result = await buildLibrarySearch({ theme, catalog, playerParameters, generators });
    return sendJson(res, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/library/footnotes') {
    // The 脚注 call is separate from the read on purpose: the body it is about is already read and
    // already 収蔵されている, so this route writes NOTHING (no collection entry, no content result, no
    // parameters) and a failure here costs the reader nothing but the footnotes. A retry is the very
    // same request again, and 収蔵 の読み返し uses this same route with the same entry_id.
    const body = assertFootnoteBody(await readBody(req));
    const entryId = requiredFootnoteEntryId(body.entry_id);
    // The request is settled before any file is touched: a malformed body or an unrecognized
    // provider is refused without reading the shelf or the catalog.
    const generators = resolveLibraryGenerators({
      requestedProvider: requestedProviderFor({ url, body }),
      resolveLmStudioConfig
    });
    const surface = await loadLibraryCollection({ storage });
    const entry = surface.entries.find((candidate) => candidate.entry_id === entryId);
    if (!entry) {
      throw statusError(`library collection entry not found: ${entryId}`, 404, {
        errorCode: 'LIBRARY_COLLECTION_ENTRY_NOT_FOUND'
      });
    }
    const catalog = await loadLibraryCatalog({ root });
    // The authored core table is read only when it is the answer; a periphery/generated footnote
    // never touches it.
    const coreReferences = entry.layer === 'core'
      ? await loadLibraryCoreReferences({ root, catalog })
      : null;
    const playerParameters = await loadPlayerParameters(storage);
    const footnotes = await buildLibraryFootnotes({
      entry,
      catalog,
      coreReferences,
      playerParameters,
      generators
    });
    return sendJson(res, footnotes);
  }

  if (req.method === 'POST' && url.pathname === '/api/library/read') {
    const body = await readBody(req);
    const bookId = typeof body.book_id === 'string' ? body.book_id.trim() : '';
    const generatedTitle = typeof body.generated_title === 'string' ? body.generated_title.trim() : '';
    if (bookId && generatedTitle) {
      throw statusError('provide exactly one of book_id or generated_title', 400, { errorCode: 'LIBRARY_READ_TARGET_AMBIGUOUS' });
    }
    if (!bookId && !generatedTitle) {
      throw statusError('book_id or generated_title is required', 400, { errorCode: 'LIBRARY_READ_TARGET_REQUIRED' });
    }
    const catalog = await loadLibraryCatalog({ root });
    const index = libraryCatalogIndex(catalog);
    const catalogBookIds = new Set(index.byId.keys());
    const generators = resolveLibraryGenerators({
      requestedProvider: requestedProviderFor({ url, body }),
      resolveLmStudioConfig
    });

    // 同題解決: a `generated_title` that exactly names a catalog book IS that book, so the lazy
    // generation chain never produces a second copy of an authored 題 — and a 禁書 cannot be walked
    // around by asking for its title as though it were catalog-external (the gate below still runs).
    let book = null;
    if (bookId) {
      book = index.byId.get(bookId);
      if (!book) throw statusError(`library book not found: ${bookId}`, 404, { errorCode: 'LIBRARY_BOOK_NOT_FOUND' });
    } else {
      book = resolveLibraryCatalogTitle(index, generatedTitle);
    }

    let readResult;
    if (book) {
      // Re-verify the gate on the resolved book (fail-closed even when reached through a filtered
      // candidate or a footnote), and refuse the body without generating anything on a gate miss.
      const playerParameters = await loadPlayerParameters(storage);
      if (!isLibraryBookReadable(book, playerParameters)) {
        throw statusError(`library book is gated: ${book.id}`, 403, { errorCode: 'LIBRARY_BOOK_GATED' });
      }
      readResult = await readLibraryCatalogBook({ book, generators });
    } else {
      readResult = await readLibraryGeneratedBook({ generatedTitle, generators });
    }

    const commit = await commitLibraryRead({
      storage,
      readResult,
      catalogBookIds,
      now: new Date().toISOString()
    });
    return sendJson(res, {
      title: readResult.title,
      category: readResult.category,
      layer: readResult.layer,
      text: readResult.text,
      collection_entry_id: commit.collection_entry_id,
      style_id: readResult.style_id
    });
  }

  return sendJson(res, { error: 'not found' }, 404);
}
