import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_COLLECTION_REQUEST_PATH, parseLibraryCollectionEntries } from '../public/libraryCollectionViewClient.js';

function entry(overrides = {}) {
  return {
    entry_id: 'libentry_1',
    book_id: 'core_starfall_principle',
    title: '星降りの原理',
    category: '魔法基礎',
    layer: 'core',
    text: '羊皮紙の頁に鉄褐色の文字が並ぶ。',
    read_week: 5,
    ...overrides
  };
}

test('LIBRARY_COLLECTION_REQUEST_PATH is the fixed collection read path (no params)', () => {
  assert.equal(LIBRARY_COLLECTION_REQUEST_PATH, '/api/library/collection');
});

test('parseLibraryCollectionEntries returns entries in the received order without re-sorting (backend owns order)', () => {
  const payload = {
    entries: [
      entry({ entry_id: 'libentry_2', title: '二冊目', read_week: 2 }),
      entry({ entry_id: 'libentry_1', title: '一冊目', read_week: 7, layer: 'periphery', book_id: 'periphery_flora_fauna_01', category: '動植物誌' }),
      entry({ entry_id: 'libentry_3', title: '三冊目', read_week: 4, layer: 'generated', book_id: null, category: '生成写本' })
    ]
  };
  const entries = parseLibraryCollectionEntries(payload);
  // Order preserved exactly as received — no read_week / id re-sort on the client.
  assert.deepEqual(entries.map((e) => e.title), ['二冊目', '一冊目', '三冊目']);
  // The very same array is returned (identity), so nothing is copied/transformed that could drop entries/fields.
  assert.equal(entries, payload.entries);
});

test('parseLibraryCollectionEntries accepts an empty collection as a legitimate initial state', () => {
  assert.deepEqual(parseLibraryCollectionEntries({ entries: [] }), []);
});

test('parseLibraryCollectionEntries fails fast on a non-object payload or a non-array entries field', () => {
  assert.throws(() => parseLibraryCollectionEntries(null), /must be an object/);
  assert.throws(() => parseLibraryCollectionEntries('x'), /must be an object/);
  assert.throws(() => parseLibraryCollectionEntries({}), /requires an entries array/);
  assert.throws(() => parseLibraryCollectionEntries({ entries: 'x' }), /requires an entries array/);
});

test('parseLibraryCollectionEntries fails fast on a missing / empty rendered string field', () => {
  for (const field of ['title', 'category', 'text']) {
    assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ [field]: '' })] }), new RegExp(`non-empty ${field} string`));
    assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ [field]: 5 })] }), new RegExp(`non-empty ${field} string`));
  }
});

test('parseLibraryCollectionEntries fails fast on a layer outside the closed 装丁 set', () => {
  assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ layer: 'forbidden' })] }), /layer in \{core,periphery,generated\}/);
  assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ layer: undefined })] }), /layer in \{core,periphery,generated\}/);
});

test('parseLibraryCollectionEntries fails fast on a non-integer / negative read_week', () => {
  assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ read_week: -1 })] }), /non-negative integer read_week/);
  assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ read_week: 1.5 })] }), /non-negative integer read_week/);
  assert.throws(() => parseLibraryCollectionEntries({ entries: [entry({ read_week: '5' })] }), /non-negative integer read_week/);
});
