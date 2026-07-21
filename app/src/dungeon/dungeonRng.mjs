// Deterministic seeded RNG for dungeon generation and combat resolution.
// A Park–Miller LCG (same family as training.mjs) so a given seed always
// reproduces the same dungeon, which keeps generation testable while still
// varying every run when the entry seed varies.

const MODULUS = 2147483647;
const MULTIPLIER = 48271;

function normalizeSeed(seed) {
  const value = Math.floor(Number(seed));
  if (!Number.isFinite(value)) throw new Error(`invalid rng seed: ${seed}`);
  const wrapped = ((value % MODULUS) + MODULUS) % MODULUS;
  return wrapped === 0 ? 1 : wrapped;
}

// Mixes a base seed with an integer salt (e.g. floor number) into a fresh seed
// so each floor of a run is independent yet reproducible from the run seed.
export function deriveSeed(baseSeed, salt) {
  const base = normalizeSeed(baseSeed);
  const mixedSalt = Math.floor(Number(salt) || 0);
  let mixed = (base ^ ((mixedSalt + 1) * 2654435761)) >>> 0;
  mixed = (mixed * MULTIPLIER) % MODULUS;
  return normalizeSeed(mixed);
}

export function createRng(seed) {
  let state = normalizeSeed(seed);
  function next() {
    state = (state * MULTIPLIER) % MODULUS;
    return state / MODULUS;
  }
  return {
    // float in [0, 1)
    next,
    // integer in [min, max] inclusive
    int(min, max) {
      const low = Math.ceil(min);
      const high = Math.floor(max);
      if (high < low) throw new Error(`invalid int range: ${min}..${max}`);
      return low + Math.floor(next() * (high - low + 1));
    },
    // true with the given probability
    chance(probability) {
      return next() < probability;
    },
    // a random element of a non-empty array
    pick(items) {
      if (!Array.isArray(items) || items.length === 0) throw new Error('pick requires a non-empty array');
      return items[Math.floor(next() * items.length)];
    },
    // Fisher–Yates copy
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    }
  };
}
