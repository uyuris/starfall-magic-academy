// 残す (a): save の複製（slot の作成）と読込が、収蔵（お気に入り・本文・読んだ週）を落とす壊れ方から、プレイヤーの slot を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import {
  loadLibraryCollection
} from '../src/libraryCollection.mjs';
import { initializeNewPlayArea, resolveSlotProjectRoot, setActiveSlot } from '../src/playSession.mjs';
import { createSaveSlot, loadSaveSlot } from '../src/saveLoad.mjs';
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
    favorite: false,
    style_id: null,
    ...overrides
  };
}

test('createSaveSlot clones the ACTIVE slot library collection (favorite + text carried into the new slot)', async (t) => {
  const root = await fixtureRoot('magic-adv-library-active-clone-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const source = await initializeNewPlayArea({
    root,
    slotId: 'slot_001',
    playMode: 'routing',
    routingPersonaVariant: 'fallen_star'
  });
  await setActiveSlot(root, 'slot_001');
  const marked = validEntry({ read_week: 11, favorite: true, text: '収蔵された正確な一節。' });
  await writeJson(source.root, 'game_data/library_collection.json', { version: 3, entries: [marked] });

  await createSaveSlot({ root, slotId: 'slot_002', playMode: 'routing', routingPersonaVariant: 'fallen_star', now: '2026-09-08T00:00:00.000Z' });

  const clonedRoot = resolveSlotProjectRoot(root, 'slot_002');
  assert.deepEqual(await readJson(clonedRoot, 'game_data/library_collection.json'), { version: 3, entries: [marked] });
  assert.deepEqual((await loadLibraryCollection({ root: clonedRoot })).entries, [marked]);
});

test('loadSaveSlot leaves the library collection intact — favorite, text and read_week survive a load', async (t) => {
  const root = await fixtureRoot('magic-adv-library-load-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const initialized = await initializeNewPlayArea({
    root,
    slotId: 'slot_001',
    playMode: 'routing',
    routingPersonaVariant: 'fallen_star'
  });
  const entries = [validEntry({ favorite: true, read_week: 4 }), validEntry({ entry_id: 'lib_read_0002', title: '二冊目', read_week: 6 })];
  await writeJson(initialized.root, 'game_data/library_collection.json', { version: 3, entries });

  await loadSaveSlot({ root, slotId: 'slot_001' });

  const slotRoot = resolveSlotProjectRoot(root, 'slot_001');
  assert.deepEqual(await readJson(slotRoot, 'game_data/library_collection.json'), { version: 3, entries });
  assert.deepEqual((await loadLibraryCollection({ root: slotRoot })).entries, entries);
});
