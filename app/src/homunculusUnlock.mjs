// The 錬成室 (homunculus atelier) unlock gate: fail-closed, parameter-thresholded, the same 高位閾値 shape as
// the禁書 gate. The atelier destination is not even offered until the hero has reached the threshold in any
// magic系統. This module is the single source of that predicate; it is pure (parameters in, ids out) so both
// the hub-context snapshot (which loads the parameters) and any test can reuse it.

import { magicParameterDefinitions } from './parameters.mjs';

// いずれかの魔法系統の習熟 ≥ 80 で解放（Lead 確定・ブリーフの目安値）。
export const HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD = 80;

// Reads one magic proficiency value, tolerating both the decorated `{ value }` shape and a bare number (the
// same两形 the craft skill-score reader accepts). A missing/non-finite entry reads as 0 — an absent
// proficiency is genuinely not at threshold, which keeps the gate closed rather than masking anything.
function magicProficiencyValue(playerParameters, key) {
  const entry = playerParameters?.magic?.[key];
  const raw = entry !== null && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

// True once any magic系統 reaches the threshold. A null/absent parameters object keeps the gate closed
// (fail-closed): the atelier is a gated existence, so "cannot verify the gate" means "not offered", never a
// default-open fallback.
export function isAtelierUnlocked(playerParameters) {
  if (!playerParameters || typeof playerParameters !== 'object' || Array.isArray(playerParameters)) return false;
  return magicParameterDefinitions.some(
    (definition) => magicProficiencyValue(playerParameters, definition.key) >= HOMUNCULUS_ATELIER_UNLOCK_MAGIC_THRESHOLD
  );
}

// The unlocked gated-destination-id list for these parameters — the exact value stamped onto the hub context
// snapshot and threaded into the destination candidate set. `['homunculus']` when unlocked, `[]` otherwise.
export function unlockedGatedDestinationIdsForParameters(playerParameters) {
  return isAtelierUnlocked(playerParameters) ? ['homunculus'] : [];
}
