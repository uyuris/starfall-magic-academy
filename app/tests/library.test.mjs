import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';
import { loadLibraryCatalog } from '../src/libraryCatalog.mjs';
import {
  LIBRARY_FREE_BOOK_COUNT,
  LIBRARY_SEARCH_BOOK_COUNT,
  buildLibrarySearch,
  commitLibraryRead,
  makeLibraryCollectionEntryId,
  mergeLibraryContentResult,
  readLibraryCatalogBook,
  readLibraryGeneratedBook
} from '../src/routingLibrary.mjs';
import { buildLibraryContentResult, buildWorkshopContentResult } from '../src/routingContentResult.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import { runtimePathsManifestFilename } from '../src/runtimePaths.mjs';
import { projectRoot } from './testPaths.mjs';

const NOW = '2026-07-07T12:00:00.000Z';
const livePublicRoot = path.join(projectRoot, 'app/public');
const repoCanonicalAssetsRoot = path.join(projectRoot, 'assets/canonical');

// A generators double that fails if a surface is used unexpectedly; a test overrides only the
// method it exercises so an accidental extra generation is caught.
function noopGenerators(overrides = {}) {
  const fail = (name) => async () => { throw new Error(`unexpected library generator call: ${name}`); };
  return {
    selectBookIds: overrides.selectBookIds ?? fail('selectBookIds'),
    generateTitles: overrides.generateTitles ?? fail('generateTitles'),
    generateSkeleton: overrides.generateSkeleton ?? fail('generateSkeleton'),
    generateFragment: overrides.generateFragment ?? fail('generateFragment')
  };
}

// A minimal in-memory storage implementing exactly the JSON surface routingLibrary touches.
function memStorage(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async readJson(relativePath) {
      if (!files.has(relativePath)) throw new Error(`missing ${relativePath}`);
      return structuredClone(files.get(relativePath));
    },
    async readJsonIfExists(relativePath) {
      return files.has(relativePath) ? structuredClone(files.get(relativePath)) : null;
    },
    async writeJson(relativePath, value) {
      files.set(relativePath, structuredClone(value));
    }
  };
}

// ===== routingLibrary orchestration (injected generators, in-memory storage) =====

test('buildLibrarySearch fills 5 shelf books (selection + generation) plus 3 free books', async () => {
  const catalog = await loadLibraryCatalog({ root: projectRoot });
  const titleCalls = [];
  const result = await buildLibrarySearch({
    theme: '星と夜',
    catalog,
    playerParameters: {},
    generators: noopGenerators({
      selectBookIds: async ({ candidates }) => [candidates[0].id, candidates[1].id],
      generateTitles: async ({ theme, count }) => {
        titleCalls.push({ theme, count });
        return Array.from({ length: count }, (_unused, index) => `生成_${theme}_${index}`);
      }
    })
  });
  assert.equal(result.theme, '星と夜');
  assert.equal(result.catalog_books.length, 2);
  for (const book of result.catalog_books) {
    assert.deepEqual(Object.keys(book).sort(), ['category', 'id', 'layer', 'title']);
  }
  // generation fills the remaining slots up to 5, and the free row is always 3
  assert.equal(result.generated_books.length, LIBRARY_SEARCH_BOOK_COUNT - 2);
  assert.equal(result.free_books.length, LIBRARY_FREE_BOOK_COUNT);
  // both the generation-fill row and the free (catalog-external) row are bound to the search theme
  assert.deepEqual(titleCalls, [
    { theme: '星と夜', count: 3 },
    { theme: '星と夜', count: LIBRARY_FREE_BOOK_COUNT }
  ]);
});

test('buildLibrarySearch with a full selection makes no generation-fill call', async () => {
  const catalog = await loadLibraryCatalog({ root: projectRoot });
  let titleThemes = [];
  const result = await buildLibrarySearch({
    theme: 'いっぱい',
    catalog,
    playerParameters: {},
    generators: noopGenerators({
      selectBookIds: async ({ candidates }) => candidates.slice(0, 5).map((candidate) => candidate.id),
      generateTitles: async ({ theme, count }) => {
        titleThemes.push(theme);
        return Array.from({ length: count }, (_unused, index) => `蔵書${index}`);
      }
    })
  });
  assert.equal(result.catalog_books.length, 5);
  assert.equal(result.generated_books.length, 0);
  assert.equal(result.free_books.length, 3);
  // no theme-bound fill ran (selection was full); only the free row generated, itself theme-bound
  assert.deepEqual(titleThemes, ['いっぱい']);
});

test('readLibraryCatalogBook returns core authored text WITHOUT calling any generator', async () => {
  const catalog = await loadLibraryCatalog({ root: projectRoot });
  const core = catalog.find((book) => book.id === 'core_starfall_principle');
  const readResult = await readLibraryCatalogBook({ book: core, generators: noopGenerators() });
  assert.equal(readResult.layer, 'core');
  assert.equal(readResult.book_id, 'core_starfall_principle');
  assert.equal(readResult.text, core.text);
  assert.ok(readResult.text.length > 0);
});

test('readLibraryCatalogBook generates a periphery fragment from the authored skeleton + backbone', async () => {
  const catalog = await loadLibraryCatalog({ root: projectRoot });
  const periphery = catalog.find((book) => book.id === 'periphery_essay_01');
  const fragmentArgs = [];
  const readResult = await readLibraryCatalogBook({
    book: periphery,
    generators: noopGenerators({
      generateFragment: async (args) => { fragmentArgs.push(args); return 'PERIPHERY_FRAGMENT'; }
    })
  });
  assert.equal(readResult.layer, 'periphery');
  assert.equal(readResult.book_id, 'periphery_essay_01');
  assert.equal(readResult.text, 'PERIPHERY_FRAGMENT');
  assert.deepEqual(fragmentArgs, [{
    title: periphery.title,
    category: periphery.category,
    skeleton: periphery.skeleton,
    backbone: periphery.backbone
  }]);
  assert.equal(periphery.backbone, true);
});

test('readLibraryGeneratedBook runs the lazy skeleton -> fragment chain with backbone withheld', async () => {
  const skeletonArgs = [];
  const fragmentArgs = [];
  const readResult = await readLibraryGeneratedBook({
    generatedTitle: '夜霧の写本',
    generators: noopGenerators({
      generateSkeleton: async (args) => { skeletonArgs.push(args); return 'LAZY_SKELETON'; },
      generateFragment: async (args) => { fragmentArgs.push(args); return 'GENERATED_FRAGMENT'; }
    })
  });
  assert.deepEqual(readResult, {
    title: '夜霧の写本',
    category: '生成写本',
    layer: 'generated',
    text: 'GENERATED_FRAGMENT',
    book_id: null
  });
  assert.deepEqual(skeletonArgs, [{ title: '夜霧の写本' }]);
  assert.deepEqual(fragmentArgs, [{ title: '夜霧の写本', category: '生成写本', skeleton: 'LAZY_SKELETON', backbone: false }]);
});

test('mergeLibraryContentResult appends within the same library week and replaces otherwise', () => {
  const bookA = { book_id: 'core_starfall_principle', title: '星降りの理', category: '世界の理', layer: 'core' };
  const bookB = { book_id: null, title: '自由本', category: '生成写本', layer: 'generated' };

  const fresh = mergeLibraryContentResult({ existing: null, week: 3, now: NOW, book: bookA });
  assert.equal(fresh.detail.books.length, 1);

  const appended = mergeLibraryContentResult({ existing: fresh, week: 3, now: NOW, book: bookB });
  assert.deepEqual(appended.detail.books, [bookA, bookB]);

  // a later week replaces (does not append)
  const nextWeek = mergeLibraryContentResult({ existing: appended, week: 4, now: NOW, book: bookA });
  assert.deepEqual(nextWeek.detail.books, [bookA]);

  // a non-library slot is replaced
  const workshop = buildWorkshopContentResult({
    week: 3, now: NOW, recipeId: 'craft_weapon_sword_fire_t2',
    instance: {
      instance_id: 'e1', kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 2,
      quality: 'fine', name: '刃', flavor: '炎の刃。', base_effects: { attack: 4 }, bonus_effects: { attack: 1 }
    }
  });
  const replacedWorkshop = mergeLibraryContentResult({ existing: workshop, week: 3, now: NOW, book: bookA });
  assert.equal(replacedWorkshop.kind, 'library');
  assert.deepEqual(replacedWorkshop.detail.books, [bookA]);
});

test('makeLibraryCollectionEntryId is unique per read sequence', () => {
  assert.equal(makeLibraryCollectionEntryId({ now: NOW, seq: 0 }), 'libentry_20260707T120000000Z_0');
  assert.notEqual(
    makeLibraryCollectionEntryId({ now: NOW, seq: 0 }),
    makeLibraryCollectionEntryId({ now: NOW, seq: 1 })
  );
});

test('commitLibraryRead appends 収蔵 first, then folds the read into the content-result slot (append within week)', async () => {
  const catalog = await loadLibraryCatalog({ root: projectRoot });
  const catalogBookIds = new Set(catalog.map((book) => book.id));
  const storage = memStorage({ 'game_data/runtime_state.json': { version: 1, elapsed_weeks: 5 } });

  const first = await commitLibraryRead({
    storage,
    catalogBookIds,
    now: NOW,
    readResult: { title: '星降りの理', category: '世界の理', layer: 'core', text: '本文A', book_id: 'core_starfall_principle' }
  });
  const collection1 = storage.files.get('game_data/library_collection.json');
  assert.equal(collection1.entries.length, 1);
  assert.equal(collection1.entries[0].read_week, 5);
  assert.equal(collection1.entries[0].entry_id, first.collection_entry_id);
  const state1 = storage.files.get('game_data/runtime_state.json');
  assert.equal(state1.last_routing_content_result.kind, 'library');
  assert.equal(state1.last_routing_content_result.week, 5);
  assert.equal(state1.last_routing_content_result.detail.books.length, 1);

  const second = await commitLibraryRead({
    storage,
    catalogBookIds,
    now: '2026-07-07T12:05:00.000Z',
    readResult: { title: '自由本', category: '生成写本', layer: 'generated', text: '本文B', book_id: null }
  });
  const collection2 = storage.files.get('game_data/library_collection.json');
  assert.equal(collection2.entries.length, 2);
  assert.notEqual(first.collection_entry_id, second.collection_entry_id);
  const state2 = storage.files.get('game_data/runtime_state.json');
  // same week -> the content result appended the second book
  assert.deepEqual(
    state2.last_routing_content_result.detail.books.map((book) => book.title),
    ['星降りの理', '自由本']
  );
});

test('commitLibraryRead leaves the content-result slot untouched when the 収蔵 append fails', async () => {
  const catalog = await loadLibraryCatalog({ root: projectRoot });
  const catalogBookIds = new Set(catalog.map((book) => book.id));
  const storage = memStorage({ 'game_data/runtime_state.json': { version: 1, elapsed_weeks: 2 } });
  await assert.rejects(
    () => commitLibraryRead({
      storage,
      catalogBookIds,
      now: NOW,
      // a periphery entry whose book_id is not in the catalog: append validates and throws first
      readResult: { title: 'ghost', category: '怪談・七不思議', layer: 'periphery', text: 'x', book_id: 'not_in_catalog' }
    }),
    /not in the catalog/
  );
  assert.equal(storage.files.has('game_data/library_collection.json'), false);
  assert.equal('last_routing_content_result' in storage.files.get('game_data/runtime_state.json'), false);
});

// ===== hub context narration =====

test('the routing hub meta context narrates a library content result like other kinds', () => {
  const libraryRecord = {
    kind: 'library',
    destination_id: 'library',
    week: 8,
    recorded_at: NOW,
    trigger: 'library_reading_committed',
    detail: {
      outcome: 'completed',
      books: [
        { book_id: 'core_starfall_principle', title: '星降りの理', category: '世界の理', layer: 'core' },
        { book_id: null, title: '夜霧の写本', category: '生成写本', layer: 'generated' }
      ]
    }
  };
  const meta = buildRoutingMetaContext({
    state: { elapsed_weeks: 8 },
    routingHubContext: {
      persona_variant: 'fallen_star',
      recent_conversation_context: {
        kind: 'no_new_conversation', conversation_id: null, character_id: null, character_name: null, memory_text: null
      },
      relationship_context: { buddy: null, enemies: [] },
      alchemy_context: { recipe_count: 3 },
      study_circle_context: { theme_count: 5, weekly_offer_count: 2 },
      content_result_context: { record: libraryRecord, companion: null }
    }
  });
  assert.match(meta, /直近コンテンツ結果: 大書庫で読書。読んだ本: 『星降りの理』（世界の理）、『夜霧の写本』（生成写本）。/);
});

// ===== HTTP surface (createServer, mock provider) =====

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRuntimeManifest(root) {
  await writeJson(root, runtimePathsManifestFilename, {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'data/definitions/game_data'),
    mutableRoot: path.join(root, 'data/mutable/game_data'),
    characterContentRoot: path.join(projectRoot, 'content/characters'),
    creatureContentRoot: path.join(projectRoot, 'content/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  });
}

async function writeSlotRuntimeManifest(slotRoot, sourceRoot) {
  await writeJson(slotRoot, runtimePathsManifestFilename, {
    configRoot: path.join(sourceRoot, 'app/config'),
    definitionsRoot: path.join(sourceRoot, 'data/definitions/game_data'),
    seedsRoot: path.join(sourceRoot, 'data/definitions/game_data'),
    mutableRoot: path.join(slotRoot, 'game_data'),
    characterContentRoot: path.join(projectRoot, 'content/characters'),
    creatureContentRoot: path.join(projectRoot, 'content/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: sourceRoot
  });
}

async function libraryServerRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-library-api-'));
  const slotRoot = path.join(root, 'data/mutable/game_data/play/slots/slot_001');
  await writeRuntimeManifest(root);
  await writeSlotRuntimeManifest(slotRoot, root);
  await fs.mkdir(path.join(root, 'data/definitions/game_data'), { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/library_catalog.json'),
    path.join(root, 'data/definitions/game_data/library_catalog.json')
  );
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    version: 1,
    current_screen: 'academy-library',
    current_interaction_character_id: null,
    last_conversation_id: null,
    elapsed_weeks: 5,
    current_buddy_character_id: null,
    current_enemy_character_ids: [],
    pending_finalizations: [],
    routing_week_progressions: []
  });
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  return { sourceRoot: root, slotRoot };
}

async function writePlayModeSettings(root) {
  const settingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return settingsPath;
}

async function withLibraryServer(t) {
  const { sourceRoot, slotRoot } = await libraryServerRoot();
  const playModeSettingsPath = await writePlayModeSettings(sourceRoot);
  const server = createServer({
    root: sourceRoot,
    activeRoot: slotRoot,
    publicRoot: livePublicRoot,
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    playModeSettingsPath,
    lmStudioConfigPath: path.join(sourceRoot, 'missing-lmstudio.json')
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });
  return { slotRoot, base: `http://127.0.0.1:${server.address().port}` };
}

async function rawFetch(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
    body: options?.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options?.body
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('POST /api/library/search (mock) returns catalog selection + generation-fill + 3 free books', async (t) => {
  const { base } = await withLibraryServer(t);
  const { status, body } = await rawFetch(`${base}/api/library/search?provider=mock`, {
    method: 'POST',
    body: { theme: '夜と星' }
  });
  assert.equal(status, 200);
  assert.equal(body.theme, '夜と星');
  // mock selects the first 3 readable candidates; fill brings the shelf to 5; free is always 3
  assert.equal(body.catalog_books.length, 3);
  assert.equal(body.generated_books.length, LIBRARY_SEARCH_BOOK_COUNT - 3);
  assert.equal(body.free_books.length, LIBRARY_FREE_BOOK_COUNT);
  for (const book of body.catalog_books) {
    assert.deepEqual(Object.keys(book).sort(), ['category', 'id', 'layer', 'title']);
  }
  for (const book of [...body.generated_books, ...body.free_books]) {
    assert.deepEqual(Object.keys(book), ['title']);
  }
});

test('POST /api/library/read (mock) reads a periphery book, appends 収蔵 and writes the content result', async (t) => {
  const { base } = await withLibraryServer(t);
  const { status, body } = await rawFetch(`${base}/api/library/read?provider=mock`, {
    method: 'POST',
    body: { book_id: 'periphery_flora_fauna_01' }
  });
  assert.equal(status, 200);
  assert.equal(body.layer, 'periphery');
  assert.equal(body.category, '動植物誌');
  assert.ok(body.text.length > 0);
  assert.ok(body.collection_entry_id.startsWith('libentry_'));

  const collection = await rawFetch(`${base}/api/library/collection`, { method: 'GET' });
  assert.equal(collection.status, 200);
  assert.equal(collection.body.entries.length, 1);
  assert.equal(collection.body.entries[0].book_id, 'periphery_flora_fauna_01');
  assert.equal(collection.body.entries[0].read_week, 5);
});

test('POST /api/library/read (mock) reads a generated book by title as layer generated / book_id null', async (t) => {
  const { base } = await withLibraryServer(t);
  const { status, body } = await rawFetch(`${base}/api/library/read?provider=mock`, {
    method: 'POST',
    body: { generated_title: '夜半の写し書き' }
  });
  assert.equal(status, 200);
  assert.equal(body.title, '夜半の写し書き');
  assert.equal(body.layer, 'generated');
  assert.equal(body.category, '生成写本');
  assert.ok(body.text.length > 0);
});

test('POST /api/library/read reads a core book with NO LM configured', async (t) => {
  const { base } = await withLibraryServer(t);
  // no provider=mock and no LM config: a core read must still succeed (LM 不関与)
  const { status, body } = await rawFetch(`${base}/api/library/read`, {
    method: 'POST',
    body: { book_id: 'core_starfall_principle' }
  });
  assert.equal(status, 200);
  assert.equal(body.layer, 'core');
  assert.ok(body.text.length > 0);
});

test('POST /api/library/read fail-closes a gated book (403) and reports an unknown id (404)', async (t) => {
  const { base } = await withLibraryServer(t);
  // knowledge_light_basic gates on light>=50; the save has light=25
  const gated = await rawFetch(`${base}/api/library/read?provider=mock`, {
    method: 'POST',
    body: { book_id: 'knowledge_light_basic' }
  });
  assert.equal(gated.status, 403);
  assert.equal(gated.body.error_code, 'LIBRARY_BOOK_GATED');

  const unknown = await rawFetch(`${base}/api/library/read?provider=mock`, {
    method: 'POST',
    body: { book_id: 'no_such_book' }
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error_code, 'LIBRARY_BOOK_NOT_FOUND');
});

test('POST /api/library/read rejects an ambiguous or empty target (400)', async (t) => {
  const { base } = await withLibraryServer(t);
  const both = await rawFetch(`${base}/api/library/read?provider=mock`, {
    method: 'POST',
    body: { book_id: 'core_starfall_principle', generated_title: 'x' }
  });
  assert.equal(both.status, 400);
  assert.equal(both.body.error_code, 'LIBRARY_READ_TARGET_AMBIGUOUS');

  const neither = await rawFetch(`${base}/api/library/read?provider=mock`, { method: 'POST', body: {} });
  assert.equal(neither.status, 400);
  assert.equal(neither.body.error_code, 'LIBRARY_READ_TARGET_REQUIRED');
});

test('POST /api/library/search fails with a structured 503 when LM is unconfigured', async (t) => {
  const { base } = await withLibraryServer(t);
  const { status, body } = await rawFetch(`${base}/api/library/search`, {
    method: 'POST',
    body: { theme: '星' }
  });
  assert.equal(status, 503);
  assert.equal(body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
});

test('POST /api/library/read fails with a structured 503 for periphery / generated books when LM is unconfigured', async (t) => {
  const { base } = await withLibraryServer(t);
  // periphery read needs the fragment generator, so an unconfigured LM fails fast (nothing persisted)
  const periphery = await rawFetch(`${base}/api/library/read`, {
    method: 'POST',
    body: { book_id: 'periphery_flora_fauna_01' }
  });
  assert.equal(periphery.status, 503);
  assert.equal(periphery.body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');

  // generated read needs the skeleton + fragment generators, likewise 503 with no LM
  const generated = await rawFetch(`${base}/api/library/read`, {
    method: 'POST',
    body: { generated_title: '夜半の写し書き' }
  });
  assert.equal(generated.status, 503);
  assert.equal(generated.body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');

  // and nothing was written to 収蔵 on either failed read
  const collection = await rawFetch(`${base}/api/library/collection`, { method: 'GET' });
  assert.deepEqual(collection.body, { entries: [] });
});

test('GET /api/library/collection succeeds with NO LM configured and starts empty', async (t) => {
  const { base } = await withLibraryServer(t);
  const { status, body } = await rawFetch(`${base}/api/library/collection`, { method: 'GET' });
  assert.equal(status, 200);
  assert.deepEqual(body, { entries: [] });
});

test('POST /api/library/search rejects an empty or non-string theme (400)', async (t) => {
  const { base } = await withLibraryServer(t);
  const whitespace = await rawFetch(`${base}/api/library/search?provider=mock`, {
    method: 'POST',
    body: { theme: '   ' }
  });
  assert.equal(whitespace.status, 400);
  assert.equal(whitespace.body.error_code, 'LIBRARY_THEME_REQUIRED');

  // a non-string theme is 不正 input, rejected rather than coerced (123 -> "123")
  const nonString = await rawFetch(`${base}/api/library/search?provider=mock`, {
    method: 'POST',
    body: { theme: 123 }
  });
  assert.equal(nonString.status, 400);
  assert.equal(nonString.body.error_code, 'LIBRARY_THEME_REQUIRED');
});

test('library provider seam rejects a present-but-unrecognized value (400 UNSUPPORTED_PROVIDER); mock unchanged', async (t) => {
  const { base } = await withLibraryServer(t);
  // query seam
  const searchQuery = await rawFetch(`${base}/api/library/search?provider=real`, {
    method: 'POST',
    body: { theme: '夜と星' }
  });
  assert.equal(searchQuery.status, 400);
  assert.equal(searchQuery.body.error_code, 'UNSUPPORTED_PROVIDER');
  // body seam (read route)
  const readBodySeam = await rawFetch(`${base}/api/library/read`, {
    method: 'POST',
    body: { book_id: 'periphery_flora_fauna_01', provider: 'real' }
  });
  assert.equal(readBodySeam.status, 400);
  assert.equal(readBodySeam.body.error_code, 'UNSUPPORTED_PROVIDER');
  // mock still works
  const mockOk = await rawFetch(`${base}/api/library/search?provider=mock`, {
    method: 'POST',
    body: { theme: '夜と星' }
  });
  assert.equal(mockOk.status, 200);
});

// A loop-mode variant of withLibraryServer: the same seeded save, but the global play-mode is loop, so the
// routing-only library routes must 409 instead of serving content.
async function withLoopModeLibraryServer(t) {
  const { sourceRoot, slotRoot } = await libraryServerRoot();
  const playModeSettingsPath = path.join(sourceRoot, 'play-mode.json');
  await fs.writeFile(playModeSettingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');
  const server = createServer({
    root: sourceRoot,
    activeRoot: slotRoot,
    publicRoot: livePublicRoot,
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    playModeSettingsPath,
    lmStudioConfigPath: path.join(sourceRoot, 'missing-lmstudio.json')
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });
  return { slotRoot, base: `http://127.0.0.1:${server.address().port}` };
}

test('GET /api/library returns the week + server-authoritative exit with NO LM configured (routing hub exit)', async (t) => {
  const { base } = await withLibraryServer(t);
  // no provider=mock and no LM config: the arrival envelope must still resolve (the library is a routing-only stay
  // screen whose exit is resolved like the workshop/alchemy screens — routing → the routing hub 'interaction').
  const { status, body } = await rawFetch(`${base}/api/library`, { method: 'GET' });
  assert.equal(status, 200);
  // the seeded save is elapsed_weeks: 5; the arrival carries the raw week (the frontend renders 第(week+1)週)
  assert.equal(body.week, 5);
  assert.equal(body.post_content_screen, 'interaction');
  assert.deepEqual(Object.keys(body).sort(), ['post_content_screen', 'week']);
});

test('GET /api/library requires routing mode (409 in loop mode)', async (t) => {
  const { base } = await withLoopModeLibraryServer(t);
  const { status, body } = await rawFetch(`${base}/api/library`, { method: 'GET' });
  assert.equal(status, 409);
  assert.equal(body.error_code, 'ROUTING_MODE_REQUIRED');
});
