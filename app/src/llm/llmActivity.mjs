// Additive in-memory tracker of whether the single LM Studio instance is
// currently occupied by background LLM work (conversation finalization /
// reflection). The dungeon's two-mode availability check reads this so it can
// make an explicit "LLM is busy" decision instead of silently failing a call.
//
// This does not change conversation behavior: finalization simply wraps its
// work in begin/end. Process-local and synchronous by design — it mirrors the
// single local LM Studio process the runtime talks to.

let activeCount = 0;

export function beginLlmActivity() {
  activeCount += 1;
  let released = false;
  return function endLlmActivity() {
    if (released) return;
    released = true;
    activeCount = Math.max(0, activeCount - 1);
  };
}

export function isLlmBusy() {
  return activeCount > 0;
}

export function llmActivitySnapshot() {
  return { busy: activeCount > 0, active_count: activeCount };
}

// Test hook: clears the counter between cases.
export function resetLlmActivity() {
  activeCount = 0;
}
