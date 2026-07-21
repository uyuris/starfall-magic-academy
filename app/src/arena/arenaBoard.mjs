// The fixed arena board: one small, left/right-symmetric grid with a few pillar walls,
// no procedural generation, no stairs / items / fog. Every cell is always visible
// (the spectator requirement); the pillars give casters cover to kite around while
// keeping open lanes so a match always converges. Coordinates are (x column, y row);
// '#' is wall, '.' is floor. All numbers here are tunable arena constants.

import { TILE_FLOOR, TILE_WALL } from '../dungeon/dungeonGeneration.mjs';

const ARENA_LAYOUT = [
  '###########',
  '#.........#',
  '#.........#',
  '#..#...#..#',
  '#.........#',
  '#..#...#..#',
  '#.........#',
  '#.........#',
  '###########'
];

export const ARENA_BOARD_WIDTH = ARENA_LAYOUT[0].length;   // 11
export const ARENA_BOARD_HEIGHT = ARENA_LAYOUT.length;     // 9

// Start positions per team and team size, mirror-symmetric across the vertical center
// (x=1 ⇔ x=9). team_a spawns on the left wing, team_b on the right. A 2-actor team takes
// the two rows flanking the center row so both fighters have a clear lane to the enemy.
const ARENA_SPAWNS = {
  a: { 1: [{ x: 1, y: 4 }], 2: [{ x: 1, y: 3 }, { x: 1, y: 5 }] },
  b: { 1: [{ x: 9, y: 4 }], 2: [{ x: 9, y: 3 }, { x: 9, y: 5 }] }
};

// A fresh board object `{ width, height, tiles }` — the same board shape the shared grid
// geometry consumes. Tiles are rebuilt per match so a match owns an independent, mutable
// board copy (nothing ever writes tiles, but this keeps matches free of shared references).
export function createArenaBoardTiles() {
  return ARENA_LAYOUT.map((row) => [...row].map((cell) => (cell === '#' ? TILE_WALL : TILE_FLOOR)));
}

export function createArenaBoard() {
  return { width: ARENA_BOARD_WIDTH, height: ARENA_BOARD_HEIGHT, tiles: createArenaBoardTiles() };
}

// The start positions for one team of `size` actors. Fail-fast: only 1v1 and 2v2 are
// supported, so an unsupported team key/size has no spawn and throws.
export function arenaSpawnPositions(team, size) {
  const perTeam = ARENA_SPAWNS[team];
  if (!perTeam) throw new Error(`unknown arena team: ${team}`);
  const positions = perTeam[size];
  if (!positions) throw new Error(`unsupported arena team size for ${team}: ${size}`);
  return positions.map((position) => ({ ...position }));
}
