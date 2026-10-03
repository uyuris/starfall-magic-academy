// Process-wide LM concurrency: the one place that bounds how many inference requests this process keeps in
// flight against LM Studio, and the helper that runs a bundle of mutually independent requests side by side.
//
// Two semaphores, both fixed constants (no env / config read, no default fallback):
//   - the request semaphore (`LM_CONCURRENCY_LIMIT` = 4) wraps the HTTP issue-and-read of EVERY chat completion
//     that goes through `lmStudioClient.postChatCompletion` — the sole inference transport — so the conversation
//     main line, prompt prewarm, and the bundles below all share one ceiling. LM Studio accepts up to 4
//     concurrent predictions without rejecting; independent-request throughput peaks there.
//   - the bundle semaphore (`BUNDLE_CONCURRENCY_LIMIT` = LIMIT − 1 = 3) is shared by every independent bundle
//     (lounge finalize chains, weekly errand / study-circle offers). A bundle item takes a bundle slot before it
//     runs and the transport inside it then takes a request slot, so bundle-originated in-flight requests never
//     exceed 3 process-wide even when two bundles overlap — one request slot always stays free of bundles for
//     the conversation main line, which therefore only ever competes with prewarm, as before.
//
// A caller that exceeds a limit waits in FIFO order; nothing is rejected or dropped for being over the limit.

export const LM_CONCURRENCY_LIMIT = 4;
export const BUNDLE_CONCURRENCY_LIMIT = LM_CONCURRENCY_LIMIT - 1;

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };
  const release = () => {
    const next = waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter: `active` stays as-is, so the count never dips below the
      // number of runners that actually hold a slot.
      next();
      return;
    }
    active -= 1;
  };
  return async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const withRequestSlot = createSemaphore(LM_CONCURRENCY_LIMIT);
const withBundleSlot = createSemaphore(BUNDLE_CONCURRENCY_LIMIT);

// Runs `fn` holding one of the process-wide LM request slots. `lmStudioClient.postChatCompletion` issues its
// HTTP request (and reads the whole response, streamed or not) inside this, so the slot covers the request's
// full residence on the LM Studio side.
export function runWithLmRequestSlot(fn) {
  if (typeof fn !== 'function') throw new Error('runWithLmRequestSlot requires a function');
  return withRequestSlot(fn);
}

// Runs `run(item, index)` for every item of an independent bundle, each inside a bundle slot, and resolves to the
// results in INPUT order regardless of completion order. Any single rejection rejects the whole bundle with that
// error: no partial result array is ever returned and no failed item is silently skipped. Items already running
// when a sibling fails run to completion (they cannot be cancelled); their outcomes are discarded and never
// surface as unhandled rejections.
export async function runIndependentBundle(items, { run } = {}) {
  if (!Array.isArray(items)) throw new Error('runIndependentBundle requires an items array');
  if (typeof run !== 'function') throw new Error('runIndependentBundle requires a run function');
  return await Promise.all(items.map((item, index) => withBundleSlot(() => run(item, index))));
}
