import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  EXPECTED_CORE_COUNT,
  EXPECTED_PERIPHERY_COUNT,
  LIBRARY_CATALOG_FILENAME,
  LIBRARY_MAGIC_KEYS,
  LIBRARY_PERIPHERY_CATEGORIES,
  filterReadableLibraryBooks,
  isLibraryBookReadable,
  loadLibraryCatalog,
  normalizeLibraryCatalog,
  validateLibraryGate
} from '../src/libraryCatalog.mjs';
import { MAGIC_KNOWLEDGE_TEXTS } from '../src/llm/conversationActorContext.mjs';
import { projectRoot, definitionsRoot } from './testPaths.mjs';

async function realCatalogRaw() {
  return JSON.parse(await fs.readFile(path.join(definitionsRoot, LIBRARY_CATALOG_FILENAME), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bookByTitle(books, title) {
  const book = books.find((entry) => entry.title === title);
  assert.ok(book, `book "${title}" exists in the catalog`);
  return book;
}

function magic(values) {
  return { magic: values };
}

test('the authored library catalog loads as 31 core + 500 periphery = 531 entries', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  assert.equal(books.length, 531);
  assert.equal(EXPECTED_CORE_COUNT, 31);
  assert.equal(EXPECTED_PERIPHERY_COUNT, 500);
  assert.equal(books.filter((book) => book.layer === 'core').length, EXPECTED_CORE_COUNT);
  assert.equal(books.filter((book) => book.layer === 'periphery').length, EXPECTED_PERIPHERY_COUNT);
  const ids = new Set(books.map((book) => book.id));
  assert.equal(ids.size, 531, 'ids are unique');
  for (const book of books) assert.match(book.id, /^[a-z0-9_]+$/);
});

test('the 12 knowledge books resolve their body from the actor-context source of truth, not a duplicated copy', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const knowledge = books.filter((book) => book.knowledge_ref);
  assert.equal(knowledge.length, 12);
  for (const book of knowledge) {
    assert.equal(book.category, '系統知識');
    assert.ok(!Object.prototype.hasOwnProperty.call(book, 'skeleton'));
    const { element, tier } = book.knowledge_ref;
    assert.equal(book.text, MAGIC_KNOWLEDGE_TEXTS[element][tier], `${book.id} resolves the canonical knowledge text`);
    // basic gates on ≥50 of its element, advanced on ≥80.
    assert.deepEqual(book.gate, { kind: 'magic', key: element, min: tier === 'basic' ? 50 : 80 });
  }
});

test('the 19 authored core lore books carry text and the catalog gates match the draft table', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const lore = books.filter((book) => book.layer === 'core' && !book.knowledge_ref);
  assert.equal(lore.length, 19);
  // Every lore book carries authored text (no knowledge_ref) and no executor-only メタ/注記 leaks in.
  for (const book of lore) {
    assert.equal(typeof book.text, 'string');
    assert.ok(book.text.trim().length > 0, `${book.id} has text`);
    assert.doesNotMatch(book.text, /注記/);
    assert.doesNotMatch(book.text, /^- (分類|ゲート|開示):/m);
  }
  // Gate table (design/library-catalog-draft.md「中核本（19冊）」): only these are gated.
  assert.equal(bookByTitle(books, '星降りの理').gate ?? null, null);
  assert.deepEqual(bookByTitle(books, '地脈考 — 大地に沁みた光').gate, { kind: 'magic', key: 'earth', min: 50 });
  assert.deepEqual(bookByTitle(books, '月の文字盤の空間について').gate, { kind: 'magic_any', min: 80 });
  assert.deepEqual(bookByTitle(books, '星の終わり、月の裏').gate, { kind: 'magic', key: 'dark', min: 80 });
  assert.deepEqual(bookByTitle(books, '外法考 — 奪う術の系譜').gate, { kind: 'magic', key: 'dark', min: 80 });
  assert.deepEqual(bookByTitle(books, '器に灯る — 造られた命について').gate, { kind: 'magic', key: 'dark', min: 80 });
  assert.deepEqual(bookByTitle(books, '夢の管理局 覚書・抄').gate, { kind: 'magic_any', min: 80 });
  assert.deepEqual(bookByTitle(books, '封じの系譜 — 禁を破った者たちの末路').gate, { kind: 'magic', key: 'dark', min: 80 });
  // The non-禁書 lore books added in the expansion (draft No.7–13) are ungated.
  for (const title of [
    '残光濃度考 — 素材の階級', '星降りの地理 — 光の落ち方と土地柄', '役目の星々 — 照らす星、数える星、導く星',
    '相克と相生 — 六相のあいだ', '卒業の星課 — 認められるとは何か', '星の揺り籠考 — 卵と変貌', '銘打ちの流儀 — 名は器に何を貸すか'
  ]) {
    assert.equal(bookByTitle(books, title).gate ?? null, null, `${title} is ungated`);
  }
  // Exactly 7 core lore books carry a gate (地脈考 + 6 禁書); the other 12 are gate-free.
  assert.equal(lore.filter((book) => (book.gate ?? null) !== null).length, 7);
});

test('the expansion core lore books carry their confirmed category labels', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const expected = {
    '残光濃度考 — 素材の階級': '素材論',
    '星降りの地理 — 光の落ち方と土地柄': '地理誌',
    '役目の星々 — 照らす星、数える星、導く星': '星誌',
    '相克と相生 — 六相のあいだ': '系統論',
    '卒業の星課 — 認められるとは何か': '学院史',
    '星の揺り籠考 — 卵と変貌': '博物誌',
    '銘打ちの流儀 — 名は器に何を貸すか': '工芸論',
    '器に灯る — 造られた命について': '禁書',
    '夢の管理局 覚書・抄': '禁書',
    '封じの系譜 — 禁を破った者たちの末路': '禁書'
  };
  for (const [title, category] of Object.entries(expected)) {
    assert.equal(bookByTitle(books, title).category, category, `${title} category`);
  }
});

test('the periphery shelf is exactly the 20 closed-set categories, 25 books each, in draft order', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const periphery = books.filter((book) => book.layer === 'periphery');
  assert.equal(LIBRARY_PERIPHERY_CATEGORIES.length, 20);
  // Every periphery category is in the closed set, and every closed-set category has exactly 25 books.
  const counts = new Map(LIBRARY_PERIPHERY_CATEGORIES.map((category) => [category, 0]));
  for (const book of periphery) {
    assert.ok(counts.has(book.category), `periphery category is in the closed set: ${book.category}`);
    counts.set(book.category, counts.get(book.category) + 1);
  }
  for (const category of LIBRARY_PERIPHERY_CATEGORIES) {
    assert.equal(counts.get(category), 25, `${category} has 25 books`);
  }
  // The categories appear grouped in the draft's declared order (no interleaving).
  const orderInCatalog = [];
  for (const book of periphery) {
    if (orderInCatalog[orderInCatalog.length - 1] !== book.category) orderInCatalog.push(book.category);
  }
  assert.deepEqual(orderInCatalog, [...LIBRARY_PERIPHERY_CATEGORIES]);
});

test('every authored title/text/skeleton is verbatim from the Lead-authored design drafts (0 mismatch)', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const catalogDraft = await fs.readFile(path.join(projectRoot, '.agents/docs/design/library-catalog-draft.md'), 'utf8');
  const coreDraft = await fs.readFile(path.join(projectRoot, '.agents/docs/design/library-core-texts-draft.md'), 'utf8');
  const peripheryDraft = await fs.readFile(path.join(projectRoot, '.agents/docs/design/library-periphery-skeletons-draft.md'), 'utf8');

  // Core lore: each authored body appears verbatim (contiguously) in the core-texts draft.
  const lore = books.filter((book) => book.layer === 'core' && !book.knowledge_ref);
  for (const book of lore) {
    assert.ok(coreDraft.includes(book.text), `core text verbatim in draft: ${book.title}`);
  }
  // Periphery: each skeleton sits verbatim directly under its ### 『title』 heading in the skeleton draft.
  const periphery = books.filter((book) => book.layer === 'periphery');
  for (const book of periphery) {
    assert.ok(peripheryDraft.includes(`### 『${book.title}』\n${book.skeleton}\n`), `skeleton verbatim in draft: ${book.title}`);
  }
  // Titles: every core/periphery title is a 『』 entry in the title 正本 (catalog draft).
  for (const book of [...lore, ...periphery]) {
    assert.ok(catalogDraft.includes(`『${book.title}』`), `title present in catalog draft: ${book.title}`);
  }
});

test('the JSON entry order matches the draft order (core No.1–19 and periphery per-category 記載順)', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const coreDraft = await fs.readFile(path.join(projectRoot, '.agents/docs/design/library-core-texts-draft.md'), 'utf8');
  const peripheryDraft = await fs.readFile(path.join(projectRoot, '.agents/docs/design/library-periphery-skeletons-draft.md'), 'utf8');

  // Core lore titles, in JSON order, equal the core-texts draft ## N. [禁書]『title』 sequence (No.1–19).
  const coreOrderFromDraft = [...coreDraft.matchAll(/^## \d+\. (?:禁書)?『(.+)』\s*$/gm)].map((m) => m[1]);
  assert.equal(coreOrderFromDraft.length, 19);
  const coreOrderFromJson = books.filter((book) => book.layer === 'core' && !book.knowledge_ref).map((book) => book.title);
  assert.deepEqual(coreOrderFromJson, coreOrderFromDraft);

  // Periphery (category, title) pairs, in JSON order, equal the skeleton draft's full ## / ### sequence.
  const peripheryOrderFromDraft = [];
  let draftCategory = null;
  for (const line of peripheryDraft.split('\n')) {
    if (line.startsWith('## ')) { draftCategory = line.slice(3).trim(); continue; }
    const heading = line.match(/^### 『(.+)』\s*$/);
    if (heading && draftCategory) peripheryOrderFromDraft.push(`${draftCategory}／${heading[1]}`);
  }
  assert.equal(peripheryOrderFromDraft.length, 500);
  const peripheryOrderFromJson = books
    .filter((book) => book.layer === 'periphery')
    .map((book) => `${book.category}／${book.title}`);
  assert.deepEqual(peripheryOrderFromJson, peripheryOrderFromDraft);
});

test('the backbone flag follows the mechanical rule (星図・天文誌 or 星降り/残光/月夜 in title/skeleton)', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const periphery = books.filter((book) => book.layer === 'periphery');
  // All 25 星図・天文誌 books are backbone by category.
  const starcharts = periphery.filter((book) => book.category === '星図・天文誌');
  assert.equal(starcharts.length, 25);
  assert.ok(starcharts.every((book) => book.backbone === true));
  // Title matches the substring rule.
  assert.equal(bookByTitle(books, '星降りの晩の散歩').backbone, true);
  assert.equal(bookByTitle(books, '月夜文庫 短篇集').backbone, true);
  assert.equal(bookByTitle(books, '星降りの夜に外へ出てはいけない').backbone, true);
  // Ordinary periphery books are not backbone.
  assert.equal(bookByTitle(books, '寮の夜食帖').backbone, false);
  assert.equal(bookByTitle(books, '月光苔の観察記').backbone, false);
  // Every backbone flag equals the mechanical rule recomputed here; the count is the total that satisfy it.
  for (const book of periphery) {
    const expected = book.category === '星図・天文誌' || /星降り|残光|月夜/.test(book.title) || /星降り|残光|月夜/.test(book.skeleton);
    assert.equal(book.backbone, expected, `${book.title} backbone`);
  }
  assert.equal(periphery.filter((book) => book.backbone).length, 35);
});

test('the gate filter is fail-closed: a gated book appears only when its parameter is met', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const readableTitles = (params) => new Set(filterReadableLibraryBooks(books, params).map((book) => book.title));

  // 地脈考: 土 ≥ 50 passes, 49 does not.
  assert.equal(readableTitles(magic({ earth: 50 })).has('地脈考 — 大地に沁みた光'), true);
  assert.equal(readableTitles(magic({ earth: 49 })).has('地脈考 — 大地に沁みた光'), false);

  // 月の文字盤の空間について: any系統 ≥ 80.
  assert.equal(readableTitles(magic({ fire: 80 })).has('月の文字盤の空間について'), true);
  assert.equal(readableTitles(magic({ fire: 79, water: 40 })).has('月の文字盤の空間について'), false);

  // The two 闇 ≥ 80 禁書 lore books.
  const darkEighty = readableTitles(magic({ dark: 80 }));
  assert.equal(darkEighty.has('星の終わり、月の裏'), true);
  assert.equal(darkEighty.has('外法考 — 奪う術の系譜'), true);
  const darkSeventyNine = readableTitles(magic({ dark: 79 }));
  assert.equal(darkSeventyNine.has('星の終わり、月の裏'), false);
  assert.equal(darkSeventyNine.has('外法考 — 奪う術の系譜'), false);

  // An ungated book is always readable.
  assert.equal(isLibraryBookReadable(bookByTitle(books, '星降りの理'), {}), true);
});

test('missing parameters exclude every gated book (禁書全滅) and keep the ungated set', async () => {
  const books = await loadLibraryCatalog({ root: projectRoot });
  const readable = filterReadableLibraryBooks(books, {});
  // No gated book survives absent parameters.
  assert.ok(readable.every((book) => (book.gate ?? null) === null));
  // The ungated set is the 12 gate-free core lore books + all 500 periphery books.
  assert.equal(readable.length, 512);
  const readableTitles = new Set(readable.map((book) => book.title));
  for (const title of ['地脈考 — 大地に沁みた光', '月の文字盤の空間について', '外法考 — 奪う術の系譜', '厚土魔法基礎理論']) {
    assert.equal(readableTitles.has(title), false, `${title} is gated and excluded`);
  }
});

// ---------------------------------------------------------------------------
// strict loader fail-fast
// ---------------------------------------------------------------------------

test('loadLibraryCatalog fails fast when the catalog file is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-library-cat-'));
  await assert.rejects(() => loadLibraryCatalog({ root }), /library catalog file is missing/);
});

test('normalizeLibraryCatalog fails fast on wrong shape and count', async () => {
  assert.throws(() => normalizeLibraryCatalog(null), /library catalog must be an object/);
  assert.throws(() => normalizeLibraryCatalog({}), /library catalog books must be an array/);
  assert.throws(() => normalizeLibraryCatalog({ books: [] }), /exactly 31 core books/);

  const raw = await realCatalogRaw();
  const missingCore = clone(raw);
  const coreIdx = missingCore.books.findIndex((book) => book.layer === 'core');
  missingCore.books.splice(coreIdx, 1);
  assert.throws(() => normalizeLibraryCatalog(missingCore), /exactly 31 core books/);

  const missingPeriphery = clone(raw);
  const periIdx = missingPeriphery.books.findIndex((book) => book.layer === 'periphery');
  missingPeriphery.books.splice(periIdx, 1);
  assert.throws(() => normalizeLibraryCatalog(missingPeriphery), /exactly 500 periphery books/);
});

test('normalizeLibraryCatalog fails fast on duplicate id, bad id pattern, and bad layer', async () => {
  const raw = await realCatalogRaw();

  const dup = clone(raw);
  dup.books[1].id = dup.books[0].id;
  assert.throws(() => normalizeLibraryCatalog(dup), /duplicate library catalog id/);

  const badId = clone(raw);
  badId.books[0].id = 'Bad-ID';
  assert.throws(() => normalizeLibraryCatalog(badId), /must match/);

  const badLayer = clone(raw);
  badLayer.books[0].layer = 'middle';
  assert.throws(() => normalizeLibraryCatalog(badLayer), /layer must be one of/);
});

test('normalizeLibraryCatalog fails fast on unresolvable knowledge_ref and text/knowledge_ref presence rules', async () => {
  const raw = await realCatalogRaw();

  const badRef = clone(raw);
  const knowledgeBook = badRef.books.find((book) => book.knowledge_ref);
  knowledgeBook.knowledge_ref.tier = 'legendary';
  assert.throws(() => normalizeLibraryCatalog(badRef), /knowledge_ref\.tier must be one of/);

  const unresolved = clone(raw);
  const knowledgeBook2 = unresolved.books.find((book) => book.knowledge_ref);
  knowledgeBook2.knowledge_ref.element = 'plasma';
  assert.throws(() => normalizeLibraryCatalog(unresolved), /knowledge_ref\.element must be a magic key/);

  const both = clone(raw);
  const knowledgeBook3 = both.books.find((book) => book.knowledge_ref);
  knowledgeBook3.text = 'authored body';
  assert.throws(() => normalizeLibraryCatalog(both), /exactly one of text \/ knowledge_ref/);

  const neither = clone(raw);
  const loreBook = neither.books.find((book) => book.layer === 'core' && book.text);
  delete neither.books[neither.books.indexOf(loreBook)].text;
  assert.throws(() => normalizeLibraryCatalog(neither), /exactly one of text \/ knowledge_ref/);
});

test('normalizeLibraryCatalog fails fast on a bad gate and periphery backbone violations', async () => {
  const raw = await realCatalogRaw();

  const badGate = clone(raw);
  const gatedBook = badGate.books.find((book) => book.gate?.kind === 'magic');
  gatedBook.gate = { kind: 'ability', key: 'strength', min: 50 };
  assert.throws(() => normalizeLibraryCatalog(badGate), /gate\.kind must be one of/);

  const negMin = clone(raw);
  const gatedBook2 = negMin.books.find((book) => book.gate?.kind === 'magic');
  gatedBook2.gate = { kind: 'magic', key: gatedBook2.gate.key, min: 0 };
  assert.throws(() => normalizeLibraryCatalog(negMin), /gate\.min must be a positive integer/);

  const missingBackbone = clone(raw);
  const peripheryBook = missingBackbone.books.find((book) => book.layer === 'periphery');
  delete missingBackbone.books[missingBackbone.books.indexOf(peripheryBook)].backbone;
  assert.throws(() => normalizeLibraryCatalog(missingBackbone), /missing required key: backbone/);

  const flippedBackbone = clone(raw);
  const starchart = flippedBackbone.books.find((book) => book.category === '星図・天文誌');
  starchart.backbone = false;
  assert.throws(() => normalizeLibraryCatalog(flippedBackbone), /backbone must follow the mechanical rule/);

  const peripheryGate = clone(raw);
  const peripheryBook2 = peripheryGate.books.find((book) => book.layer === 'periphery');
  peripheryBook2.gate = { kind: 'magic_any', min: 50 };
  assert.throws(() => normalizeLibraryCatalog(peripheryGate), /periphery book must not carry a gate/);
});

test('validateLibraryGate accepts the three closed forms and rejects everything else', () => {
  assert.deepEqual(validateLibraryGate({ kind: 'magic', key: 'dark', min: 80 }, 'g'), { kind: 'magic', key: 'dark', min: 80 });
  assert.deepEqual(validateLibraryGate({ kind: 'magic_any', min: 80 }, 'g'), { kind: 'magic_any', min: 80 });
  assert.throws(() => validateLibraryGate({ kind: 'magic', key: 'luck', min: 80 }, 'g'), /gate\.key must be one of/);
  assert.throws(() => validateLibraryGate({ kind: 'magic', key: 'dark', min: 80, extra: 1 }, 'g'), /unexpected key: extra/);
  assert.throws(() => validateLibraryGate({ kind: 'weather' }, 'g'), /gate\.kind must be one of/);
  assert.throws(() => validateLibraryGate(null, 'g'), /gate must be an object/);
});

test('the magic key vocabulary is the six canonical magic parameter keys', () => {
  assert.deepEqual([...LIBRARY_MAGIC_KEYS], ['light', 'dark', 'fire', 'water', 'earth', 'wind']);
});
