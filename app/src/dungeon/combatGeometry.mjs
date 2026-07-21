// Shared grid geometry and deterministic pathfinding for turn-based combat boards.
// Everything here operates on a plain board `{ width, height, tiles }` (tiles is a
// row-major array whose walkable cells are TILE_FLOOR) plus an `occupied(x, y)`
// predicate the caller supplies to describe actor occupancy. This keeps the geometry
// and BFS free of any run/match actor model, so the dungeon (C-23) and the arena
// engine (C-26) share one definition of walkability, line of sight, distance, and
// stepwise movement.

import { TILE_FLOOR } from './dungeonGeneration.mjs';

export const CARDINAL_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function inBounds(board, x, y) {
  return x >= 0 && y >= 0 && x < board.width && y < board.height;
}

export function isWalkable(board, x, y) {
  return inBounds(board, x, y) && board.tiles[y][x] === TILE_FLOOR;
}

export function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function pathKey(x, y) {
  return `${x},${y}`;
}

// A clear straight-line trace between two tiles: blocked by any wall (or out-of-bounds)
// on the interpolated cells between them. The magic-wall LoS rule shared by casting and
// ranged targeting — the same discipline in dungeon and arena.
export function hasLineOfSight(board, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  for (let step = 1; step < steps; step += 1) {
    const x = Math.round(from.x + (dx * step) / steps);
    const y = Math.round(from.y + (dy * step) / steps);
    if (!inBounds(board, x, y) || board.tiles[y][x] !== TILE_FLOOR) return false;
  }
  return true;
}

// The ordered floor cells a straight ray passes through, starting one cell past `from` toward
// `through` and continuing along the SAME interpolated line past `through` until it leaves the
// board or meets a wall (a non-floor tile). It extends the exact rasterization hasLineOfSight
// uses (round of the per-step interpolation with steps = the Chebyshev span of from→through),
// so casting line-of-sight and this pierce ray agree cell-for-cell up to `through`; the ray
// merely keeps stepping beyond it. `through` must be a distinct cell from `from`. Occupancy is
// not consulted here — actors never stop the ray; only walls and the board edge do.
export function pierceLineCells(board, from, through) {
  const dx = through.x - from.x;
  const dy = through.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) throw new Error('pierce line requires from and through to be distinct cells');
  const cells = [];
  for (let step = 1; ; step += 1) {
    const x = Math.round(from.x + (dx * step) / steps);
    const y = Math.round(from.y + (dy * step) / steps);
    if (!inBounds(board, x, y) || board.tiles[y][x] !== TILE_FLOOR) break;
    cells.push({ x, y });
  }
  return cells;
}

// Whether a cell is visible to an actor: within its vision radius (Chebyshev) and with a
// clear line of sight. A radius of Infinity (the arena's all-visible board) reduces this
// to the LoS test alone.
export function canSeeCellWithinRadius(board, actor, radius, x, y) {
  return inBounds(board, x, y)
    && chebyshev(actor.x, actor.y, x, y) <= radius
    && hasLineOfSight(board, actor, { x, y });
}

// ----- deterministic BFS movement -----

// Cardinal steps sorted by how much closer each brings `from` to `target` (Manhattan),
// ties broken by a fixed direction index — the tie-break that makes movement reproducible.
export function orderedPathDirections(from, target) {
  return CARDINAL_DIRECTIONS
    .map(([dx, dy], index) => ({ dx, dy, index, distance: manhattan(from.x + dx, from.y + dy, target.x, target.y) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
}

// Walks the cameFrom chain back to the first step off the actor's start tile and moves
// the actor one cell along it. Mutates actor.x/actor.y.
export function pathStepFrom(actor, destinationKey, cameFrom, cells) {
  const startKey = pathKey(actor.x, actor.y);
  let stepKey = destinationKey;
  let previousKey = cameFrom.get(stepKey);
  while (previousKey && previousKey !== startKey) {
    stepKey = previousKey;
    previousKey = cameFrom.get(stepKey);
  }
  const step = cells.get(stepKey);
  actor.x = step.x;
  actor.y = step.y;
  return true;
}

// The set of walkable, unoccupied cells cardinally adjacent to a target — the goal tiles
// a chaser wants to reach so it stands beside the target.
export function approachGoalKeys(board, target, occupied) {
  return new Set(CARDINAL_DIRECTIONS
    .map(([dx, dy]) => ({ x: target.x + dx, y: target.y + dy }))
    .filter((cell) => isWalkable(board, cell.x, cell.y) && !occupied(cell.x, cell.y))
    .map((cell) => pathKey(cell.x, cell.y)));
}

// Moves an actor one step along the shortest path toward standing adjacent to a target,
// over walkable, unoccupied cells (BFS with the deterministic direction order). When no
// path to an adjacent cell exists it moves toward the cell that got Manhattan-closest.
// Returns false when it is already adjacent or cannot improve its position. Mutates the actor.
export function stepToward(board, actor, target, occupied) {
  const startKey = pathKey(actor.x, actor.y);
  const goals = approachGoalKeys(board, target, occupied);
  if (goals.has(startKey)) return false;

  const cameFrom = new Map([[startKey, null]]);
  const cells = new Map([[startKey, { x: actor.x, y: actor.y }]]);
  const queue = [{ x: actor.x, y: actor.y, key: startKey }];
  let bestKey = startKey;
  let bestDistance = manhattan(actor.x, actor.y, target.x, target.y);

  while (queue.length) {
    const current = queue.shift();
    for (const { dx, dy } of orderedPathDirections(current, target)) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = pathKey(nx, ny);
      if (cameFrom.has(key)) continue;
      if (!isWalkable(board, nx, ny) || occupied(nx, ny)) continue;

      cameFrom.set(key, current.key);
      cells.set(key, { x: nx, y: ny });

      if (goals.has(key)) return pathStepFrom(actor, key, cameFrom, cells);

      const distance = manhattan(nx, ny, target.x, target.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = key;
      }
      queue.push({ x: nx, y: ny, key });
    }
  }

  if (bestKey !== startKey) return pathStepFrom(actor, bestKey, cameFrom, cells);
  return false;
}

// Nearest walkable tile outward from an origin (deterministic BFS) for which `isFree(x, y)` holds —
// used to stand a revived ally back on the board near the reviver. Returns null only when the whole
// connected board is occupied (impossible on a real board), so callers fail-fast on null.
export function nearestFreeTile(board, origin, isFree) {
  const startKey = pathKey(origin.x, origin.y);
  const seen = new Set([startKey]);
  const queue = [{ x: origin.x, y: origin.y }];
  while (queue.length) {
    const current = queue.shift();
    for (const [dx, dy] of CARDINAL_DIRECTIONS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const key = pathKey(nx, ny);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isWalkable(board, nx, ny)) continue;
      if (isFree(nx, ny)) return { x: nx, y: ny };
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}
