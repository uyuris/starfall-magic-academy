// Procedural floor generation: rooms joined by corridors, an entrance, a
// down-stair, scattered enemies and items. Fully determined by (seed, floor)
// so a run reproduces exactly while varying whenever the run seed varies.

import { createRng, deriveSeed } from './dungeonRng.mjs';
import { bossArchetypes, enemyArchetypes, enemyCombatMaxHp, enemyCountForFloor, scaledEnemyStats } from './dungeonEnemies.mjs';
import { dungeonFloorNumber } from './dungeonScaling.mjs';

export const TILE_WALL = 'wall';
export const TILE_FLOOR = 'floor';
export const MILESTONE_FLOORS = [5, 10];

// Elite ("光る個体") enemies: a rare, unexpected "当たり" on a non-milestone floor. One placed normal enemy
// may be promoted in-place to an elite — buffed HP/attack, a name prefix, an `elite` flag — with a guaranteed
// one-tier-up material drop (handled in dungeonMaterials). Tunables:
// - ELITE_ENEMY_SPAWN_RATE: per-floor probability the promotion fires (≈0.2 → ~1 elite every 5 non-milestone
//   floors, inside the intended 0.15–0.25 expected-per-floor band; count-unchanged, so it is a per-floor
//   Bernoulli, not a per-enemy roll).
// - ELITE_ENEMY_HP_MULTIPLIER / ELITE_ENEMY_ATTACK_MULTIPLIER: clearly stronger than a normal enemy, below a
//   same-floor boss.
export const ELITE_ENEMY_SPAWN_RATE = 0.2;
const ELITE_ENEMY_HP_MULTIPLIER = 1.8;
const ELITE_ENEMY_ATTACK_MULTIPLIER = 1.5;
const ELITE_ENEMY_NAME_PREFIX = '輝く';
// A distinct seed namespace so the elite roll never collides with the generation stream (deriveSeed(seed,
// floor)), the combat stream (deriveSeed(seed, 100000 + turn)), the material-drop stream (700000 + floor),
// or the boss-treasure stream (800000 + floor).
const ELITE_ENEMY_SEED_NAMESPACE = 900000;

export const itemKinds = {
  heal_herb: { id: 'heal_herb', name: '癒し草', glyph: '+', effect: 'heal', amount: 18 },
  mana_dew: { id: 'mana_dew', name: '魔力の雫', glyph: '*', effect: 'mana', amount: 12 },
  // The boss treasure chest is never scattered as floor loot (SCATTERED_ITEM_KINDS excludes it);
  // dungeonEngine places it on a defeated milestone boss's tile, and `use_item` opens it.
  treasure_chest: { id: 'treasure_chest', name: '宝箱', glyph: '▣', effect: 'treasure' }
};

// The item kinds that spawn as scattered floor loot during generation. The treasure chest is a
// boss reward, not scattered, so it is deliberately absent here.
const SCATTERED_ITEM_KINDS = [itemKinds.heal_herb, itemKinds.mana_dew];

function floorSize(floor) {
  const grown = Math.min(Math.max(0, Math.floor(floor) - 1), 3);
  const size = 24 + grown * 2;
  return { width: size, height: size };
}

function roomCountForFloor(floor) {
  return Math.min(6 + Math.floor(floor), 12);
}

function createGrid(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => TILE_WALL));
}

function roomsOverlap(a, b) {
  return a.x <= b.x + b.w + 1 && a.x + a.w + 1 >= b.x && a.y <= b.y + b.h + 1 && a.y + a.h + 1 >= b.y;
}

function carveRoom(tiles, room) {
  for (let y = room.y; y < room.y + room.h; y += 1) {
    for (let x = room.x; x < room.x + room.w; x += 1) {
      tiles[y][x] = TILE_FLOOR;
    }
  }
}

function carveCorridor(tiles, from, to, rng) {
  const horizontalFirst = rng.chance(0.5);
  const carveH = (y, x0, x1) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) tiles[y][x] = TILE_FLOOR;
  };
  const carveV = (x, y0, y1) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) tiles[y][x] = TILE_FLOOR;
  };
  if (horizontalFirst) {
    carveH(from.y, from.x, to.x);
    carveV(to.x, from.y, to.y);
  } else {
    carveV(from.x, from.y, to.y);
    carveH(to.y, from.x, to.x);
  }
}

function roomCenter(room) {
  return { x: Math.floor(room.x + room.w / 2), y: Math.floor(room.y + room.h / 2) };
}

function placeRooms(rng, width, height, targetCount) {
  const rooms = [];
  let attempts = 0;
  while (rooms.length < targetCount && attempts < targetCount * 12) {
    attempts += 1;
    const w = rng.int(4, 6);
    const h = rng.int(4, 6);
    const x = rng.int(1, width - w - 1);
    const y = rng.int(1, height - h - 1);
    const candidate = { x, y, w, h };
    if (rooms.some((room) => roomsOverlap(room, candidate))) continue;
    rooms.push(candidate);
  }
  return rooms;
}

function collectFloorTiles(tiles) {
  const cells = [];
  for (let y = 0; y < tiles.length; y += 1) {
    for (let x = 0; x < tiles[y].length; x += 1) {
      if (tiles[y][x] === TILE_FLOOR) cells.push({ x, y });
    }
  }
  return cells;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function cellKey(cell) {
  return `${cell.x},${cell.y}`;
}

function isMilestoneFloor(floor) {
  return MILESTONE_FLOORS.includes(floor);
}

// On a non-milestone floor, a dedicated non-colliding (seed, floor) stream may promote exactly one already-
// placed normal enemy to an elite: buffed HP/attack, a name prefix, and an `elite` flag (which drives the
// guaranteed one-tier-up drop and the frontend glow). The stream is independent of every generation/combat/
// drop stream, so a floor whose roll does not fire is byte-identical to the pre-feature floor, and the enemy
// count is unchanged (an in-place promotion, never an extra spawn). Milestone floors carry the boss instead.
function maybePromoteEliteEnemy({ seed, floorNumber, enemies }) {
  if (isMilestoneFloor(floorNumber)) return;
  if (enemies.length === 0) return;
  const rng = createRng(deriveSeed(seed, ELITE_ENEMY_SEED_NAMESPACE + floorNumber));
  if (!rng.chance(ELITE_ENEMY_SPAWN_RATE)) return;
  const enemy = enemies[rng.int(0, enemies.length - 1)];
  enemy.elite = true;
  enemy.name = `${ELITE_ENEMY_NAME_PREFIX}${enemy.name}`;
  enemy.max_hp = Math.round(enemy.max_hp * ELITE_ENEMY_HP_MULTIPLIER);
  enemy.hp = enemy.max_hp;
  enemy.attack = Math.round(enemy.attack * ELITE_ENEMY_ATTACK_MULTIPLIER);
}

function bossSpawnCandidates(spawnable, occupied, stairs) {
  return spawnable
    .filter((cell) => !occupied.has(cellKey(cell)))
    .sort((a, b) => {
      const distance = manhattan(a, stairs) - manhattan(b, stairs);
      if (distance !== 0) return distance;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
}

export function buildMilestoneBossEnemy({ floorNumber, rng, spawnable, occupied, stairs, uid = 'boss1' }) {
  if (bossArchetypes.length === 0) throw new Error(`milestone floor ${floorNumber} requires at least one boss archetype`);
  const bossCells = bossSpawnCandidates(spawnable, occupied, stairs);
  if (bossCells.length === 0) throw new Error(`milestone floor ${floorNumber} has no available boss spawn tile`);
  const cell = bossCells[0];
  const archetype = rng.pick(bossArchetypes);
  const stats = scaledEnemyStats(archetype, floorNumber);
  return {
    uid,
    archetype_id: archetype.id,
    name: archetype.name,
    element: archetype.element,
    glyph: archetype.glyph,
    x: cell.x,
    y: cell.y,
    hp: enemyCombatMaxHp(stats.max_hp),
    max_hp: enemyCombatMaxHp(stats.max_hp),
    attack: stats.attack,
    defense: stats.defense,
    speed: stats.speed,
    boss: true
  };
}

export function generateFloor({ seed, floor }) {
  const floorNumber = dungeonFloorNumber(floor);
  const rng = createRng(deriveSeed(seed, floorNumber));
  const { width, height } = floorSize(floorNumber);
  const tiles = createGrid(width, height);

  const rooms = placeRooms(rng, width, height, roomCountForFloor(floorNumber));
  if (rooms.length < 2) {
    // Guarantee a minimally playable floor even on a pathological seed.
    rooms.push({ x: 1, y: 1, w: 3, h: 3 }, { x: width - 4, y: height - 4, w: 3, h: 3 });
  }
  rooms.forEach((room) => carveRoom(tiles, room));
  for (let i = 1; i < rooms.length; i += 1) {
    carveCorridor(tiles, roomCenter(rooms[i - 1]), roomCenter(rooms[i]), rng);
  }

  const entrance = roomCenter(rooms[0]);
  // Stairs go in the room whose center is farthest from the entrance.
  const stairsRoom = rooms.slice(1).reduce((best, room) => (
    manhattan(roomCenter(room), entrance) > manhattan(roomCenter(best), entrance) ? room : best
  ), rooms[rooms.length - 1]);
  const stairs = roomCenter(stairsRoom);

  const occupied = new Set([`${entrance.x},${entrance.y}`, `${stairs.x},${stairs.y}`]);
  const spawnable = rng.shuffle(collectFloorTiles(tiles).filter((cell) => {
    const key = `${cell.x},${cell.y}`;
    if (occupied.has(key)) return false;
    // Keep a small safe radius around the entrance so the player is not
    // attacked on the first turn.
    return manhattan(cell, entrance) > 2;
  }));

  const enemies = [];
  const enemyCount = Math.min(enemyCountForFloor(floorNumber), spawnable.length);
  for (let i = 0; i < enemyCount; i += 1) {
    const cell = spawnable[i];
    const archetype = rng.pick(enemyArchetypes);
    const stats = scaledEnemyStats(archetype, floorNumber);
    enemies.push({
      uid: `e${i + 1}`,
      archetype_id: archetype.id,
      name: archetype.name,
      element: archetype.element,
      glyph: archetype.glyph,
      x: cell.x,
      y: cell.y,
      hp: enemyCombatMaxHp(stats.max_hp),
      max_hp: enemyCombatMaxHp(stats.max_hp),
      attack: stats.attack,
      defense: stats.defense,
      speed: stats.speed
    });
    occupied.add(cellKey(cell));
  }

  if (isMilestoneFloor(floorNumber)) {
    const boss = buildMilestoneBossEnemy({ floorNumber, rng, spawnable, occupied, stairs });
    enemies.push(boss);
    occupied.add(cellKey(boss));
  }

  // A rare in-place elite promotion on non-milestone floors (its own stream — does not perturb the placement
  // above, and leaves positions/occupied/item scatter unchanged).
  maybePromoteEliteEnemy({ seed, floorNumber, enemies });

  const items = [];
  const itemCount = rng.int(1, 2);
  const itemPool = SCATTERED_ITEM_KINDS;
  const itemSpawnable = spawnable.slice(enemyCount).filter((cell) => !occupied.has(cellKey(cell)));
  for (let i = 0; i < itemCount; i += 1) {
    const cell = itemSpawnable[i];
    if (!cell) break;
    const kind = rng.pick(itemPool);
    items.push({ uid: `it${i + 1}`, kind: kind.id, x: cell.x, y: cell.y });
    occupied.add(cellKey(cell));
  }

  return {
    width,
    height,
    tiles,
    entrance,
    stairs,
    rooms,
    enemies,
    items
  };
}
