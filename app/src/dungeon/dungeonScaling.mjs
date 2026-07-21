export const DIFFICULTY_FLOOR_OFFSET = 7;

export function dungeonFloorNumber(floor) {
  const value = Number(floor);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid dungeon floor: ${floor}`);
  }
  return value;
}

export function difficultyFloorFor(floor) {
  return dungeonFloorNumber(floor) + DIFFICULTY_FLOOR_OFFSET;
}
