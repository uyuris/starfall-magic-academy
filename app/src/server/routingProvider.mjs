// The routing content surfaces (errand / study-circle / library) accept an explicit provider
// override on the request — `?provider=` in the query and `provider` in the JSON body — whose
// only intentionally-recognized value is the deterministic `mock` test seam. An absent override
// (null / undefined) means the real LM path. A present-but-unrecognized value is rejected outright
// with 400 UNSUPPORTED_PROVIDER rather than silently falling through to the real LM (silent
// fallback is forbidden). This is the single source for that closed set across the three surfaces.

export const RECOGNIZED_ROUTING_PROVIDERS = new Set(['mock']);

// Validates a requested provider value and returns it unchanged. null/undefined pass through as
// "absent → real LM". Any present value outside RECOGNIZED_ROUTING_PROVIDERS throws a 400-tagged
// error; recognized values are returned as-is for the caller's `=== 'mock'` resolution.
export function assertRecognizedRoutingProvider(value) {
  if (value === null || value === undefined) return value;
  if (!RECOGNIZED_ROUTING_PROVIDERS.has(value)) {
    const error = new Error(`unsupported provider: ${value}`);
    error.statusCode = 400;
    error.errorCode = 'UNSUPPORTED_PROVIDER';
    throw error;
  }
  return value;
}
