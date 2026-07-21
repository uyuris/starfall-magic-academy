import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  LIBRARY_COLLECTION_LAYERS,
  LIBRARY_COLLECTION_PATH,
  appendLibraryCollectionEntry,
  emptyLibraryCollection,
  loadLibraryCollection,
  validateLibraryCollection,
  validateLibraryCollectionEntry
} from '../src/libraryCollection.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { initializeNewPlayArea } from '../src/playSession.mjs';
import { createSaveSlot } from '../src/saveLoad.mjs';
import { fixtureRoot, readJson, writeJson } from './helpers.mjs';

function validEntry(overrides = {}) {
  return {
    entry_id: 'lib_read_0001',
    book_id: 'core_starfall_principle',
    title: '星降りの理',
    category: '世界の理',
    layer: 'core',
    text: '夜空の星は、ただ光っているのではない。',
    read_week: 3,
    ...overrides
  };
}

async function tmpRoot(prefix = 'magic-adv-library-coll-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('empty collection is version 1 with no entries', () => {
  assert.deepEqual(emptyLibraryCollection(), { version: 1, entries: [] });
  assert.deepEqual([...LIBRARY_COLLECTION_LAYERS], ['core', 'periphery', 'generated']);
  assert.equal(LIBRARY_COLLECTION_PATH, 'game_data/library_collection.json');
});

test('validateLibraryCollectionEntry accepts a valid entry and rejects malformed ones', () => {
  assert.doesNotThrow(() => validateLibraryCollectionEntry(validEntry()));
  assert.doesNotThrow(() => validateLibraryCollectionEntry(validEntry({ layer: 'periphery', book_id: 'periphery_essay_01' })));
  assert.doesNotThrow(() => validateLibraryCollectionEntry(validEntry({ layer: 'generated', book_id: null })));

  // extra / missing keys
  assert.throws(() => validateLibraryCollectionEntry({ ...validEntry(), extra: 1 }), /keys must be exactly/);
  const missing = validEntry();
  delete missing.read_week;
  assert.throws(() => validateLibraryCollectionEntry(missing), /keys must be exactly/);

  // layer / book_id consistency
  assert.throws(() => validateLibraryCollectionEntry(validEntry({ layer: 'middle' })), /layer must be one of/);
  assert.throws(() => validateLibraryCollectionEntry(validEntry({ layer: 'generated', book_id: 'core_starfall_principle' })), /generated entry book_id must be null/);
  assert.throws(() => validateLibraryCollectionEntry(validEntry({ book_id: null })), /book_id must be a non-empty string/);

  // field types
  assert.throws(() => validateLibraryCollectionEntry(validEntry({ text: '' })), /text must be a non-empty string/);
  assert.throws(() => validateLibraryCollectionEntry(validEntry({ read_week: -1 })), /read_week must be a non-negative integer/);
  assert.throws(() => validateLibraryCollectionEntry(validEntry({ read_week: 1.5 })), /read_week must be a non-negative integer/);

  // catalog existence is checked only when the id set is supplied (write path)
  assert.throws(
    () => validateLibraryCollectionEntry(validEntry({ book_id: 'core_unknown' }), { validBookIds: new Set(['core_starfall_principle']) }),
    /book_id is not in the catalog/
  );
  assert.doesNotThrow(() => validateLibraryCollectionEntry(validEntry(), { validBookIds: new Set(['core_starfall_principle']) }));
});

test('validateLibraryCollection enforces the surface shape and unique entry_id', () => {
  assert.doesNotThrow(() => validateLibraryCollection(emptyLibraryCollection()));
  assert.doesNotThrow(() => validateLibraryCollection({ version: 1, entries: [validEntry()] }));

  assert.throws(() => validateLibraryCollection(null), /surface must be an object/);
  assert.throws(() => validateLibraryCollection({ version: 2, entries: [] }), /version must be 1/);
  assert.throws(() => validateLibraryCollection({ version: 1 }), /keys must be exactly/);
  assert.throws(() => validateLibraryCollection({ version: 1, entries: {} }), /keys must be exactly|entries must be an array/);
  assert.throws(
    () => validateLibraryCollection({ version: 1, entries: [validEntry(), validEntry({ book_id: 'core_six_aspects', title: 'x', category: 'y' })] }),
    /duplicate library collection entry_id/
  );
});

test('loadLibraryCollection treats absence as empty and fails fast on a malformed present surface', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await loadLibraryCollection({ root }), { version: 1, entries: [] });

  const storage = createStorageApi({ root });
  await storage.writeJson(LIBRARY_COLLECTION_PATH, { version: 3, entries: [] });
  await assert.rejects(() => loadLibraryCollection({ root }), /version must be 1/);
});

test('appendLibraryCollectionEntry validates against the catalog, appends, and rejects entry_id collisions', async () => {
  const root = await tmpRoot();
  const catalogBookIds = new Set(['core_starfall_principle', 'periphery_essay_01']);

  const first = await appendLibraryCollectionEntry({ root, entry: validEntry(), catalogBookIds });
  assert.equal(first.entries.length, 1);
  assert.deepEqual(await loadLibraryCollection({ root }), first);

  // a generated read carries book_id null and needs no catalog entry
  const second = await appendLibraryCollectionEntry({
    root,
    entry: validEntry({ entry_id: 'lib_read_0002', layer: 'generated', book_id: null, title: '自由枠の写本', category: '生成' }),
    catalogBookIds
  });
  assert.equal(second.entries.length, 2);

  // entry_id collision fails fast before any write
  await assert.rejects(
    () => appendLibraryCollectionEntry({ root, entry: validEntry(), catalogBookIds }),
    /entry_id already exists/
  );
  assert.equal((await loadLibraryCollection({ root })).entries.length, 2);

  // a catalog-layer book_id outside the catalog is rejected (fail-closed on write)
  await assert.rejects(
    () => appendLibraryCollectionEntry({ root, entry: validEntry({ entry_id: 'lib_read_0003', book_id: 'core_ghost' }), catalogBookIds }),
    /book_id is not in the catalog/
  );

  // the catalog id set is required
  await assert.rejects(
    () => appendLibraryCollectionEntry({ root, entry: validEntry({ entry_id: 'lib_read_0004' }) }),
    /requires a catalogBookIds Set/
  );
});

test('a new routing game initializes an empty library collection', async (t) => {
  const root = await fixtureRoot('magic-adv-library-newgame-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const initialized = await initializeNewPlayArea({
    root,
    slotId: 'slot_001',
    playMode: 'routing',
    routingPersonaVariant: 'fallen_star'
  });
  const collection = await readJson(initialized.root, 'game_data/library_collection.json');
  assert.deepEqual(collection, { version: 1, entries: [] });
  // and it reads back through the surface loader
  assert.deepEqual(await loadLibraryCollection({ root: initialized.root }), { version: 1, entries: [] });
});

test('a new loop game leaves the routing-only library collection absent (loop mutable surface unchanged)', async (t) => {
  const root = await fixtureRoot('magic-adv-library-loop-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001', playMode: 'loop' });
  await assert.rejects(() => readJson(initialized.root, 'game_data/library_collection.json'), { code: 'ENOENT' });
  // absence still reads as an empty collection for any reader.
  assert.deepEqual(await loadLibraryCollection({ root: initialized.root }), { version: 1, entries: [] });
});

test('createSaveSlot carries the library collection into the cloned slot', async (t) => {
  const root = await fixtureRoot('magic-adv-library-roundtrip-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const collection = { version: 1, entries: [validEntry({ read_week: 5 })] };
  await writeJson(root, 'game_data/library_collection.json', collection);

  await createSaveSlot({ root, slotId: 'slot_001', playMode: 'loop', label: 'library round-trip', now: '2026-07-07T00:00:00.000Z' });

  const slotRoot = path.join(root, 'game_data/play/slots/slot_001');
  const carried = await readJson(slotRoot, 'game_data/library_collection.json');
  assert.deepEqual(carried, collection);
  assert.deepEqual(await loadLibraryCollection({ root: slotRoot }), collection);
});
