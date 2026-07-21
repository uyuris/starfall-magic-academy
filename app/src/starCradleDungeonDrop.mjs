// The 星の揺り籠 dungeon acquisition seam: a routing-only kept-run may yield a ほのかに温かい卵 (the egg whose
// creatures are the rarer 気配系 pool). It is a deterministic per-run BONUS derived from the run seed through a
// distinct namespace — it never touches the per-enemy combat material stream (rollEnemyMaterialDrop), so combat
// resolution and loop-mode dungeon runs stay byte-identical. Only a kept routing run rolls it, and it deposits
// through the ordinary additive inventory grant.

import { createRng, deriveSeed } from './dungeon/dungeonRng.mjs';

export const STAR_CRADLE_DUNGEON_EGG_ITEM = 'star_cradle_warm_egg';
// A distinct seed namespace so this bonus never collides with the generation / combat / material-drop streams.
const DUNGEON_EGG_SEED_NAMESPACE = 820000;
// Rare-drop probability for a kept routing run. Tunable from this one constant.
export const STAR_CRADLE_DUNGEON_EGG_CHANCE = 0.1;

// Whether a kept routing run (identified by its run seed) yields the bonus egg. Deterministic: the same run
// seed always gives the same answer, so a reloaded/re-finalized run does not double-grant.
export function rollDungeonWarmEgg(runSeed) {
  return createRng(deriveSeed(runSeed, DUNGEON_EGG_SEED_NAMESPACE)).next() < STAR_CRADLE_DUNGEON_EGG_CHANCE;
}
