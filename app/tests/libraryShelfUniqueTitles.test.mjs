// 残す: task library-shelf-unique-titles の発注で置く — 大書庫の一つの棚に同じ題が並ばない一か所（除く・頼み直す・埋まらなければ 503）を、LM を stub して守る。
import test from 'node:test';
import assert from 'node:assert/strict';

import { LIBRARY_TITLE_RETRY_LIMIT, buildLibrarySearch } from '../src/routingLibrary.mjs';

const CATALOG = [
  { id: 'periphery_a', title: '星読みの航海記', category: '天文', layer: 'periphery', gate: null },
  { id: 'periphery_b', title: '潮の暦', category: '天文', layer: 'periphery', gate: null }
];

// Stub generators: `selectBookIds` returns `selected`; each generateTitles call takes the next
// scripted answer (a function of the request) and records the request.
function stubGenerators({ selected, titleAnswers }) {
  const calls = [];
  const generators = {
    selectBookIds: async () => selected,
    generateTitles: async (request) => {
      calls.push(request);
      const answer = titleAnswers[calls.length - 1];
      if (!answer) throw new Error(`unscripted generateTitles call #${calls.length}`);
      return answer(request);
    },
    generateSkeleton: async () => { throw new Error('not used'); },
    selectStyle: async () => { throw new Error('not used'); },
    generateFragment: async () => { throw new Error('not used'); }
  };
  return { generators, calls };
}

function numbered(prefix, count) {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${index + 1}`);
}

function shelfTitles(result) {
  return [...result.catalog_books, ...result.generated_books, ...result.free_books].map((book) => book.title);
}

function search(generators) {
  return buildLibrarySearch({ theme: '海を渡った星読み', catalog: CATALOG, playerParameters: {}, generators });
}

test('(a) the free row never repeats a fill-row title: it is asked to avoid them, and a repeat is dropped and re-asked', async () => {
  const { generators, calls } = stubGenerators({
    selected: [],
    titleAnswers: [
      ({ count }) => numbered('補充', count),
      () => ['補充1', ...numbered('自由', 5)],
      ({ count }) => numbered('追加', count)
    ]
  });
  const result = await search(generators);
  const titles = shelfTitles(result);
  assert.equal(titles.length, 15);
  assert.equal(new Set(titles).size, 15);
  assert.deepEqual(result.free_books.map((book) => book.title), [...numbered('自由', 5), '追加1']);
  assert.deepEqual(calls[1].excludedTitles, numbered('補充', 9));
  assert.equal(calls[2].count, 1);
  assert.ok(calls[2].excludedTitles.includes('補充1') && calls[2].excludedTitles.includes('自由5'));
});

test('(b) a title repeated inside one answer is kept once and the missing slot is re-asked', async () => {
  const { generators, calls } = stubGenerators({
    selected: [],
    titleAnswers: [
      () => ['重題', '重題', ...numbered('補充', 7)],
      ({ count }) => numbered('追加', count),
      ({ count }) => numbered('自由', count)
    ]
  });
  const result = await search(generators);
  assert.deepEqual(result.generated_books.map((book) => book.title), ['重題', ...numbered('補充', 7), '追加1']);
  assert.equal(new Set(shelfTitles(result)).size, 15);
  assert.equal(calls[1].count, 1);
});

test('(c) a generated title equal to a catalog title on the same shelf is dropped; the catalog book stays', async () => {
  const { generators, calls } = stubGenerators({
    selected: ['periphery_a', 'periphery_b'],
    titleAnswers: [
      ({ count }) => ['星読みの航海記', ...numbered('補充', count - 1)],
      ({ count }) => numbered('追加', count),
      ({ count }) => numbered('自由', count)
    ]
  });
  const result = await search(generators);
  assert.deepEqual(result.catalog_books.map((book) => book.title), ['星読みの航海記', '潮の暦']);
  assert.equal(result.generated_books.length, 7);
  assert.ok(!result.generated_books.some((book) => book.title === '星読みの航海記'));
  assert.equal(new Set(shelfTitles(result)).size, 15);
  assert.deepEqual(calls[0].excludedTitles, ['星読みの航海記', '潮の暦']);
});

test('a row still short after the declared retries fails the search with the generation 503', async () => {
  const { generators, calls } = stubGenerators({
    selected: [],
    titleAnswers: [
      ({ count }) => numbered('補充', count),
      ...Array.from({ length: LIBRARY_TITLE_RETRY_LIMIT + 1 }, () => ({ count }) => numbered('補充', count))
    ]
  });
  await assert.rejects(search(generators), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.errorCode, 'LIBRARY_GENERATION_FAILED');
    return true;
  });
  assert.equal(calls.length, 1 + LIBRARY_TITLE_RETRY_LIMIT + 1);
});
