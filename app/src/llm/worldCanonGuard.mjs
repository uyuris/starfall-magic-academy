// The shared world-canon guard: the one wording every generation surface uses to keep invented text
// inside this world's cosmology WITHOUT naming the cosmology.
//
// A "do not contradict the canon" clause that spells out the canon's proper nouns is a vocabulary seed:
// those nouns turn up in a moss journal, a dormitory game manual, a match announcement — anywhere the
// prompt goes, whether or not the subject has anything to do with them. So the guard here names only the
// SHAPE of what must not be contradicted — where magic's power comes from, why the academy stands where it
// stands — and leaves the nouns to the surfaces that are actually about them (the library's backbone
// block for backbone-flagged books, the atelier's origin frame). A prompt that wants the canon spelled
// out imports those, not this. This module never carries a canon noun.
//
// Two constants, both string primitives (immutable, Object.isFrozen is true by definition):
//   - WORLD_CANON_GUARD_CLAUSE: the constraint sentence. Surfaces append it verbatim to the bullet that
//     already bans real-world places / modern words, or carry it as a bullet of its own.
//   - WORLD_CANON_ANCHOR_LINE: a one-sentence world sketch followed by the guard clause — the library's
//     title and footnote prompts use it where a full body prompt would be too much and no prompt would
//     let a title drift into a generic fantasy world.

export const WORLD_CANON_GUARD_CLAUSE = 'この世界の成り立ち（魔法の力がどこから来るのか・学院がなぜその地に建つのか）については、この世界に伝わる定説と食い違う断定を足さない。';

export const WORLD_CANON_ANCHOR_LINE = `この世界は、古くから魔法の営みが続いてきた学院を中心とする世界である。${WORLD_CANON_GUARD_CLAUSE}`;
