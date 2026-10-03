// 残す (a): data/mutable の収蔵を v2 から v3 へ書き換える migration が、項目を落として上書きする壊れ方から、プレイヤーの収蔵を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import {
  LIBRARY_COLLECTION_SCAN_ROOT,
  PRESERVED_ENTRY_FIELDS,
  migrateLibraryCollectionV3,
  preservedFieldsDigest
} from '../src/libraryCollectionMigration.mjs';
import { validateLibraryCollection } from '../src/libraryCollection.mjs';

// A v2 entry: the exact 8 preserved fields (favorite included, alternating so the mark is seen to
// survive), no style_id.
function v2Entry(index) {
  return {
    entry_id: `libentry_2026_${index}`,
    book_id: index % 3 === 0 ? null : `core_book_${index}`,
    title: `蔵書${index}`,
    category: index % 3 === 0 ? '生成写本' : '世界の理',
    layer: index % 3 === 0 ? 'generated' : 'core',
    text: `第${index}の一節。羊皮紙に鉄褐色の文字が並ぶ。`,
    read_week: index,
    favorite: index % 2 === 0
  };
}

function v2Surface(entryCount) {
  return { version: 2, entries: Array.from({ length: entryCount }, (_unused, index) => v2Entry(index + 1)) };
}

async function writeJsonFile(fullPath, value) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonFile(fullPath) {
  return JSON.parse(await fs.readFile(fullPath, 'utf8'));
}

// A fixture project root whose data/mutable carries one library_collection.json per named slot. The
// declared shape drives the expected counts — the assertions below derive 対象数 from this map, never
// from a constant that mirrors production.
async function fixtureProjectRoot(t, slots) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-library-migrate-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const paths = new Map();
  for (const [slotId, surface] of Object.entries(slots)) {
    const relativePath = path.join(LIBRARY_COLLECTION_SCAN_ROOT, 'game_data/play/slots', slotId, 'game_data/library_collection.json');
    const fullPath = path.join(root, relativePath);
    await writeJsonFile(fullPath, surface);
    paths.set(slotId, { relativePath, fullPath });
  }
  return { root, paths };
}

async function fileSha(fullPath) {
  return createHash('sha256').update(await fs.readFile(fullPath, 'utf8'), 'utf8').digest('hex');
}

async function shaBySlot(paths) {
  const shas = new Map();
  for (const [slotId, entry] of paths) shas.set(slotId, await fileSha(entry.fullPath));
  return shas;
}

test('apply converts v2 to v3 keeping all eight fields, and a second apply changes nothing', async (t) => {
  const slots = { slot_001: v2Surface(4), slot_002: v2Surface(2) };
  const { root, paths } = await fixtureProjectRoot(t, slots);
  const expectedFileCount = Object.keys(slots).length;

  const applied = await migrateLibraryCollectionV3({ root, mode: 'apply' });
  assert.equal(applied.file_count, expectedFileCount);
  assert.equal(applied.changed_count, expectedFileCount);
  assert.equal(applied.written_count, expectedFileCount);
  assert.deepEqual(applied.files.map((file) => file.written), applied.files.map(() => true));

  for (const [slotId, surface] of Object.entries(slots)) {
    const { fullPath } = paths.get(slotId);
    const migrated = await readJsonFile(fullPath);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.entries.length, surface.entries.length);
    // every preserved field is identical, entry for entry (the favorite mark included), and style_id
    // null is the only thing added — a pre-style_id body went through no style stage
    for (const [index, entry] of migrated.entries.entries()) {
      for (const field of PRESERVED_ENTRY_FIELDS) assert.deepEqual(entry[field], surface.entries[index][field]);
      assert.equal(entry.style_id, null);
      assert.deepEqual(Object.keys(entry).sort(), [...PRESERVED_ENTRY_FIELDS, 'style_id'].sort());
    }
    assert.deepEqual(PRESERVED_ENTRY_FIELDS, ['entry_id', 'book_id', 'title', 'category', 'layer', 'text', 'read_week', 'favorite']);
    assert.equal(preservedFieldsDigest(migrated.entries), preservedFieldsDigest(surface.entries));
    // and the result is exactly what the runtime reader accepts (loadLibraryCollection validates the
    // bytes it reads through this same validator)
    assert.doesNotThrow(() => validateLibraryCollection(migrated));
  }

  const afterFirst = await shaBySlot(paths);
  const second = await migrateLibraryCollectionV3({ root, mode: 'apply' });
  assert.equal(second.file_count, expectedFileCount);
  assert.equal(second.changed_count, 0);
  assert.equal(second.written_count, 0);
  for (const file of second.files) {
    assert.equal(file.before.version, 3);
    assert.equal(file.after.version, 3);
    assert.equal(file.before.sha256, file.after.sha256);
    assert.equal(file.changed, false);
    assert.equal(file.written, false);
    assert.equal(file.preserved.ok, true);
  }
  assert.deepEqual([...(await shaBySlot(paths))], [...afterFirst]);
});
