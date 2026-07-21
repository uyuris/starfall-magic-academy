import { resolvePostContentScreen } from '../playMode.mjs';
import { requireRoutingContentWeek } from '../routingContentResult.mjs';
import { createStorageApi } from '../storage.mjs';
import { assertRecognizedRoutingProvider } from './routingProvider.mjs';
import { isLibraryBookReadable, libraryCatalogById, loadLibraryCatalog } from '../libraryCatalog.mjs';
import { loadLibraryCollection } from '../libraryCollection.mjs';
import {
  buildLibrarySearch,
  commitLibraryRead,
  readLibraryCatalogBook,
  readLibraryGeneratedBook
} from '../routingLibrary.mjs';
import {
  generateLibraryFragmentText,
  generateLibrarySkeleton,
  generateLibraryTitles,
  selectLibraryBookIds
} from '../llm/libraryGeneration.mjs';

const PLAYER_PARAMETERS_PATH = 'game_data/runtime/player_parameters.json';

const ROUTES = new Set([
  'GET /api/library',
  'POST /api/library/search',
  'POST /api/library/read',
  'GET /api/library/collection'
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

// The mock generators produce deterministic, gate-clean output without touching the LLM (the
// ?provider=mock affordance for tests). Selection picks the leading readable candidates so a
// search covers both catalog rows and generation-fill; titles are theme-bound for both the fill and
// the free row (the two rows are told apart by their presentation column, not by the title text).
function mockLibraryGenerators() {
  const MOCK_SELECT_COUNT = 3;
  return {
    selectBookIds: async ({ candidates }) => candidates.slice(0, MOCK_SELECT_COUNT).map((candidate) => candidate.id),
    generateTitles: async ({ count }) => Array.from({ length: count }, (_unused, index) => `蔵書写本${index + 1}`),
    generateSkeleton: async ({ title }) => `『${title}』の緩い骨子。何の本か・眼差し・味わいを端的に示す短いスケッチ。`,
    generateFragment: async ({ title, category }) => `${title}（${category}）の一節。羊皮紙の頁に鉄褐色の文字が静かに並んでいる。`
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
    generateTitles: async ({ theme, count }) => generateLibraryTitles({ config: await config(), theme, count }),
    generateSkeleton: async ({ title }) => generateLibrarySkeleton({ config: await config(), title }),
    generateFragment: async ({ title, category, skeleton, backbone }) => generateLibraryFragmentText({
      config: await config(),
      title,
      category,
      skeleton,
      backbone
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
    const catalogBookIds = new Set(catalog.map((book) => book.id));
    const generators = resolveLibraryGenerators({
      requestedProvider: requestedProviderFor({ url, body }),
      resolveLmStudioConfig
    });

    let readResult;
    if (bookId) {
      const book = libraryCatalogById(catalog).get(bookId);
      if (!book) throw statusError(`library book not found: ${bookId}`, 404, { errorCode: 'LIBRARY_BOOK_NOT_FOUND' });
      // Re-verify the gate on the direct id (fail-closed even when reached through a filtered
      // candidate), and refuse the body without generating anything on a gate miss.
      const playerParameters = await loadPlayerParameters(storage);
      if (!isLibraryBookReadable(book, playerParameters)) {
        throw statusError(`library book is gated: ${bookId}`, 403, { errorCode: 'LIBRARY_BOOK_GATED' });
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
      collection_entry_id: commit.collection_entry_id
    });
  }

  return sendJson(res, { error: 'not found' }, 404);
}
