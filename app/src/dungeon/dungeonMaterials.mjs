// Material drops for dungeon enemy defeats, and the run-scoped buffer that accrues
// them until finalize.
//
// A defeated enemy drops the material for its element at the tier of the current
// floor. The roll is derived from (run seed, floor, enemy uid) through the same
// Park–Miller path as generation and combat, so it reproduces per (seed, floor)
// and never draws from the shared combat RNG. A milestone boss drops the element's
// T4 material at 100%.
//
// The run buffer is a plain { item_id: count } map kept on the run, separate from
// player_inventory: nothing here writes owned items. An absent buffer (a run saved
// before this feature) reads as empty — absence is zero, not a masked error — while
// a present-but-non-object buffer is corrupt state and throws.

import { createRng, deriveSeed } from './dungeonRng.mjs';
import { dungeonFloorNumber } from './dungeonScaling.mjs';
import { MATERIAL_ELEMENTS, materialItemId } from '../dungeonMaterialCatalog.mjs';

const MATERIAL_ELEMENT_SET = new Set(MATERIAL_ELEMENTS);

// Base per-kill drop probability for a normal enemy; a boss ignores it (guaranteed
// drop). Tune the drop economy from this one constant.
export const MATERIAL_BASE_DROP_RATE = 1 / 3;

// A distinct seed namespace so a drop stream never collides with the generation
// stream (deriveSeed(seed, floor)) or the combat stream (deriveSeed(seed, 100000 + turn)).
const MATERIAL_DROP_SEED_NAMESPACE = 700000;

// Floor → material tier band: 1-3F → T1, 4-6F → T2, 7-9F → T3, 10F → T4.
export function tierForFloor(floor) {
  const value = dungeonFloorNumber(floor);
  if (value <= 3) return 1;
  if (value <= 6) return 2;
  if (value <= 9) return 3;
  return 4;
}

function assertEnemyElement(element, uid) {
  if (typeof element !== 'string' || !MATERIAL_ELEMENT_SET.has(element)) {
    throw new Error(`dungeon enemy element is not a known material element: ${element} (enemy ${uid})`);
  }
  return element;
}

function uidOffset(uid) {
  if (typeof uid !== 'string' || uid.length === 0) throw new Error('enemy uid is required for material drop roll');
  let offset = 0;
  for (const char of uid) offset += char.charCodeAt(0);
  return offset;
}

// Deterministic per-enemy drop, fully determined by (seed, floor, enemy.uid).
// Returns the dropped material item_id, or null on no drop. A boss always drops the
// element's T4 material; an element outside the six magic keys fails fast.
export function rollEnemyMaterialDrop({ seed, floor, enemy }) {
  if (!enemy || typeof enemy !== 'object') throw new Error('enemy is required for material drop roll');
  const floorNumber = dungeonFloorNumber(floor);
  const element = assertEnemyElement(enemy.element, enemy.uid);
  if (enemy.boss === true) return materialItemId(element, 4);
  // An elite ("光る個体") guarantees the floor band's next tier up (T4 cap) — the same flag-driven guaranteed
  // drop as the boss's T4, one tier below it. Decided by the enemy's `elite` flag, not a roll.
  if (enemy.elite === true) return materialItemId(element, Math.min(tierForFloor(floorNumber) + 1, 4));
  const dropSeed = deriveSeed(deriveSeed(seed, MATERIAL_DROP_SEED_NAMESPACE + floorNumber), uidOffset(enemy.uid));
  const rng = createRng(dropSeed);
  if (!rng.chance(MATERIAL_BASE_DROP_RATE)) return null;
  return materialItemId(element, tierForFloor(floorNumber));
}

// ----- run material buffer -----

export function emptyMaterialBuffer() {
  return {};
}

// Reads the run's material buffer as a normalized { item_id: count } map. Absent
// (older save) reads as empty; a present non-object, or any non-positive-integer
// count, is corrupt state and throws.
export function readMaterialBuffer(run) {
  if (!run || typeof run !== 'object') throw new Error('dungeon run is required to read material buffer');
  const buffer = run.material_buffer;
  if (buffer === undefined || buffer === null) return {};
  if (typeof buffer !== 'object' || Array.isArray(buffer)) {
    throw new Error('dungeon material buffer must be an object of item_id -> count');
  }
  const normalized = {};
  for (const [itemId, count] of Object.entries(buffer)) {
    if (typeof itemId !== 'string' || !itemId) throw new Error('dungeon material buffer item_id must be a non-empty string');
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`dungeon material buffer count must be a positive integer: ${itemId}=${count}`);
    }
    normalized[itemId] = count;
  }
  return normalized;
}

export function addMaterialToBuffer(buffer, itemId, amount = 1) {
  if (!buffer || typeof buffer !== 'object' || Array.isArray(buffer)) throw new Error('material buffer must be an object');
  if (typeof itemId !== 'string' || !itemId) throw new Error('material item_id is required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('material amount must be a positive integer');
  return { ...buffer, [itemId]: (buffer[itemId] ?? 0) + amount };
}

export function materialBufferEntries(buffer) {
  return Object.entries(buffer)
    .map(([item_id, quantity]) => ({ item_id, quantity }))
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
}
