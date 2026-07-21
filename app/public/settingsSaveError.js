// Terminal error text for a failed settings save, shared by app.js and headless unit tests so the
// three failure modes are verifiable without a browser (jsdom cannot render the live shell).
//
// A settings category save (LM Studio / conversation popup / audio) sets a "saving" status before the
// PATCH and, on success, a completion status. On failure the category status must also reach a terminal
// state — a concrete error in the category panel — instead of staying stuck on the saving text. This
// derives that terminal message from the rejection, covering the three failure modes:
//   1. PATCH non-OK response  → the server's JSON `{ error }` body reason (e.g. an EACCES persist path).
//   2. fetch reject (network) → the fetch TypeError message.
//   3. malformed success body → the save action's shape-check Error message.
// It never invents a reason and never swallows the error: it only formats it. The caller rethrows the
// original error to reportError so console/global reporting is unchanged.

// The reason string carried by the rejection. createApiError (readJsonResponse) attaches the parsed
// response body as `error.payload`, so a non-OK PATCH exposes the server's `{ error }` message there.
// Network rejects and malformed-success throws are plain Errors, so their `message` is the reason.
export function settingsSaveErrorReason(error) {
  const payloadError = error?.payload?.error;
  if (typeof payloadError === 'string' && payloadError.trim()) return payloadError.trim();
  const message = error?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return '原因不明のエラー';
}

// The category panel's terminal error line: names the category and includes the concrete reason.
export function settingsSaveErrorMessage(error, categoryLabel) {
  return `保存に失敗しました（${categoryLabel}）: ${settingsSaveErrorReason(error)}`;
}
