// The buddy / companion / equip-target vocabulary. Historically these surfaces only spoke selectable
// roster ids (character_001..character_127). A buddy — and therefore a run companion and an equip owner —
// can now also be an ACTIVE homunculus. This module is the single definition of that union so equipment,
// mp-reserve, the debug relationship setter, the routing hub snapshot, and the dungeon companion all share
// one notion of "who can be a companion" instead of each re-deriving selectable ∪ active-homunculus.
//
// Two layers of validity, kept deliberately distinct (the same split equipment already uses for selectable
// ids, which are checked by format/range, not by "does this character exist"):
//   - FORMAT: isHomunculusIdFormat is a pure `homunculus_NNN` shape test. The equipment / mp-reserve domain
//     accepts a homunculus companion key by format, exactly as it accepts a selectable id by format.
//   - ACTIVE MEMBERSHIP: the request-boundary surfaces that own the homunculi surface (equipment API,
//     dungeon enter, debug setter, routing hub) load it and reject a non-active homunculus target
//     (fail-fast, never a silent drop) via the active id set. enemy relationships are NOT part of this
//     union — an enemy stays selectable-only.

import { isSelectableCharacterId } from './characterCatalog.mjs';
import { HOMUNCULUS_ID_PATTERN, loadHomunculiSurface } from './homunculusSurface.mjs';

// Pure `homunculus_NNN` shape test (format only, not active membership).
export function isHomunculusIdFormat(id) {
  return typeof id === 'string' && HOMUNCULUS_ID_PATTERN.test(id);
}

// The set of ACTIVE homunculus ids from an already-loaded surface.
export function activeHomunculusIdSet(surface) {
  return new Set(surface.active.map((entry) => entry.homunculus_id));
}

// Loads the ACTIVE homunculus id set from storage. An absent surface (fresh routing new-game / loop save)
// reads as the empty set (no active homunculi), the honest initial state — not a silent fallback.
export async function loadActiveHomunculusIdSet({ root, storage } = {}) {
  return activeHomunculusIdSet(await loadHomunculiSurface({ root, storage }));
}

// Whether an id is a valid non-player companion/buddy target for this save: a selectable roster character
// OR an ACTIVE homunculus. The active set is required (no default), so a caller can never accidentally
// validate against "no homunculi" when a surface was simply not loaded.
export function isCompanionCharacterId(id, activeHomunculusIds) {
  if (!(activeHomunculusIds instanceof Set)) throw new Error('activeHomunculusIds set is required');
  return isSelectableCharacterId(id) || activeHomunculusIds.has(id);
}
