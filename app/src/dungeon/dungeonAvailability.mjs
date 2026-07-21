// Explicit two-mode availability decision for the dungeon. This is NOT a silent
// fallback: the caller asks whether the LLM-backed companion mode is available
// and gets a clear yes/no plus a reason. When unavailable the dungeon runs the
// mandatory solo mechanical mode; the reason is surfaced to the player.

import { isLlmBusy } from '../llm/llmActivity.mjs';

export const AVAILABILITY_REASONS = {
  AVAILABLE: 'available',
  NOT_CONFIGURED: 'lmstudio_not_configured',
  BUSY: 'llm_busy'
};

// lmStudioConfigured: whether the runtime currently has an LM Studio config.
// busy: whether background LLM work (conversation finalization) is in flight.
export function evaluateDungeonLlmAvailability({ lmStudioConfigured, busy = isLlmBusy() } = {}) {
  if (!lmStudioConfigured) {
    return { available: false, reason: AVAILABILITY_REASONS.NOT_CONFIGURED };
  }
  if (busy) {
    return { available: false, reason: AVAILABILITY_REASONS.BUSY };
  }
  return { available: true, reason: AVAILABILITY_REASONS.AVAILABLE };
}
