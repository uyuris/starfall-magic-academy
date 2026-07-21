import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStorageApi } from '../src/storage.mjs';
import {
  MP_RESERVE_INITIAL_PERCENT,
  MP_RESERVE_SURFACE_PATH,
  emptyMpReserveSurface,
  loadMpReserveSurface,
  mpReservePercentFor,
  parseMpReservePercentAnswer,
  setMpReservePercent,
  validateMpReserveSurface
} from '../src/mpReserve.mjs';

async function tempStorage(t) {
  const mutableRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-mp-reserve-'));
  t.after(async () => {
    await fs.rm(mutableRoot, { recursive: true, force: true });
  });
  return createStorageApi({ paths: { mutableRoot } });
}

test('an absent surface reads as empty and every character reads the initial line (30)', async (t) => {
  const storage = await tempStorage(t);
  const surface = await loadMpReserveSurface({ storage });
  assert.deepEqual(surface, emptyMpReserveSurface());
  assert.equal(mpReservePercentFor(surface, 'character_001'), MP_RESERVE_INITIAL_PERCENT);
  assert.equal(MP_RESERVE_INITIAL_PERCENT, 30);
});

test('setMpReservePercent upserts one character and persists a 0..100 line; a stored 0 is not the initial default', async (t) => {
  const storage = await tempStorage(t);
  await setMpReservePercent({ storage, characterId: 'character_003', percent: 55 });
  await setMpReservePercent({ storage, characterId: 'character_010', percent: 0 });

  const surface = await loadMpReserveSurface({ storage });
  assert.equal(mpReservePercentFor(surface, 'character_003'), 55);
  // 0 is a real authored line (conserve nothing), distinct from the absent-initial 30 — ?? does not
  // collapse it.
  assert.equal(mpReservePercentFor(surface, 'character_010'), 0);
  assert.equal(mpReservePercentFor(surface, 'character_099'), MP_RESERVE_INITIAL_PERCENT);

  const raw = JSON.parse(await fs.readFile(await storage.resolveReadPath(MP_RESERVE_SURFACE_PATH), 'utf8'));
  assert.deepEqual(raw, { version: 1, reserves: { character_003: 55, character_010: 0 } });
});

test('setMpReservePercent overwrites an existing line (conversation authors it fresh each time)', async (t) => {
  const storage = await tempStorage(t);
  await setMpReservePercent({ storage, characterId: 'character_003', percent: 40 });
  await setMpReservePercent({ storage, characterId: 'character_003', percent: 70 });
  assert.equal(mpReservePercentFor(await loadMpReserveSurface({ storage }), 'character_003'), 70);
});

test('parseMpReservePercentAnswer accepts a 0..100 integer and fails fast otherwise', () => {
  assert.equal(parseMpReservePercentAnswer('0'), 0);
  assert.equal(parseMpReservePercentAnswer('100'), 100);
  assert.equal(parseMpReservePercentAnswer(' 42 '), 42);
  assert.equal(parseMpReservePercentAnswer('+30'), 30);
  for (const bad of ['', '  ', 'abc', '4.5', '101', '-5', '30%', 'MP:30', null, undefined]) {
    assert.throws(() => parseMpReservePercentAnswer(bad), /mp reserve answer must be an integer/);
  }
});

test('a present-but-malformed surface throws (corrupt state is never silently normalized)', () => {
  assert.throws(() => validateMpReserveSurface(null), /surface must be an object/);
  assert.throws(() => validateMpReserveSurface([]), /surface must be an object/);
  assert.throws(() => validateMpReserveSurface({ version: 2, reserves: {} }), /version must be 1/);
  assert.throws(() => validateMpReserveSurface({ version: 1 }), /keys must be exactly/);
  assert.throws(() => validateMpReserveSurface({ version: 1, reserves: [] }), /reserves must be an object/);
  assert.throws(() => validateMpReserveSurface({ version: 1, reserves: { character_001: 101 } }), /must be an integer from 0 to 100/);
  assert.throws(() => validateMpReserveSurface({ version: 1, reserves: { character_001: 4.5 } }), /must be an integer from 0 to 100/);
  assert.throws(() => validateMpReserveSurface({ version: 1, reserves: { lina: 30 } }), /only supported for selectable roster/);
});

test('the surface supports selectable roster and homunculus ids; creatures / routing persona / bad ids are rejected', async (t) => {
  const storage = await tempStorage(t);
  // A homunculus companion carries a reserve line by format (like affinity, a stored line for a
  // since-farewelled homunculus is harmless), so a homunculus id is accepted for read and write.
  assert.equal(mpReservePercentFor(emptyMpReserveSurface(), 'homunculus_001'), MP_RESERVE_INITIAL_PERCENT);
  await setMpReservePercent({ storage, characterId: 'homunculus_007', percent: 45 });
  assert.equal(mpReservePercentFor(await loadMpReserveSurface({ storage }), 'homunculus_007'), 45);
  assert.deepEqual(validateMpReserveSurface({ version: 1, reserves: { homunculus_007: 45 } }), { version: 1, reserves: { homunculus_007: 45 } });
  // The routing persona, creatures, and out-of-range/garbage ids are still rejected (fail-fast).
  for (const nonRoster of ['lina', 'creature_004', 'character_999', 'homunculus_1', 'homunculus_0001']) {
    assert.throws(() => mpReservePercentFor(emptyMpReserveSurface(), nonRoster), /only supported for selectable roster/);
    await assert.rejects(() => setMpReservePercent({ storage, characterId: nonRoster, percent: 30 }), /only supported for selectable roster/);
  }
});

test('setMpReservePercent rejects an out-of-range or non-integer percent before writing', async (t) => {
  const storage = await tempStorage(t);
  for (const bad of [-1, 101, 4.5, '30', null]) {
    await assert.rejects(() => setMpReservePercent({ storage, characterId: 'character_002', percent: bad }), /must be an integer from 0 to 100/);
  }
  // No partial write: the surface stays absent/empty after the rejected writes.
  assert.deepEqual(await loadMpReserveSurface({ storage }), emptyMpReserveSurface());
});
