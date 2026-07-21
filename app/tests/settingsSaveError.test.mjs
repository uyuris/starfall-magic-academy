import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsSaveErrorReason, settingsSaveErrorMessage } from '../public/settingsSaveError.js';

// The settings save error surfacing helper (shared by app.js and these headless tests). A settings
// category save that fails must reach a terminal error state carrying the concrete reason instead of
// staying stuck on its saving text. The helper formats that terminal message from the rejection across
// the three failure modes: PATCH non-OK response, fetch reject (network), and a malformed success body.
// jsdom cannot render the live settings shell (see .agents/docs/ref-camera.md), so the save actions'
// use of this helper is guarded by source-text checks in uiIntegration.metaScreens.test.mjs; here the
// pure reason/formatting is verified directly.

// A PATCH non-OK response is turned into an error by readJsonResponse/createApiError with the parsed
// server body attached as error.payload; its { error } string is the fs/API reason (e.g. an EACCES path).
function nonOkError(serverErrorMessage) {
  const error = new Error(serverErrorMessage);
  error.statusCode = 500;
  error.payload = { error: serverErrorMessage };
  return error;
}

test('reason from a PATCH non-OK response uses the server error body', () => {
  const error = nonOkError('EACCES /Users/x/runtime-project/app/config/audio.json');
  assert.equal(settingsSaveErrorReason(error), 'EACCES /Users/x/runtime-project/app/config/audio.json');
});

test('reason from a fetch reject (network error) uses the error message', () => {
  // A fetch network failure rejects with a TypeError before any response exists — no payload.
  const error = new TypeError('Failed to fetch');
  assert.equal(settingsSaveErrorReason(error), 'Failed to fetch');
});

test('reason from a malformed success response uses the thrown shape-check message', () => {
  // A 200 response whose body fails the save action's strict shape check throws a plain Error (no payload).
  const error = new Error('conversation popup settings must include numeric cooldown_ms');
  assert.equal(settingsSaveErrorReason(error), 'conversation popup settings must include numeric cooldown_ms');
});

test('reason prefers the response body reason over the generic error message', () => {
  // createApiError sets message to the payload error too, but an assembled message could differ; the
  // response body reason is the authoritative one to show.
  const error = new Error('/api/settings/audio: 500 EACCES ...');
  error.statusCode = 500;
  error.payload = { error: 'EACCES /path/audio.json' };
  assert.equal(settingsSaveErrorReason(error), 'EACCES /path/audio.json');
});

test('reason falls back to a fixed marker when neither a payload reason nor a message exists', () => {
  assert.equal(settingsSaveErrorReason({}), '原因不明のエラー');
  assert.equal(settingsSaveErrorReason(null), '原因不明のエラー');
  assert.equal(settingsSaveErrorReason(new Error('')), '原因不明のエラー');
  assert.equal(settingsSaveErrorReason({ payload: { error: '   ' }, message: '  ' }), '原因不明のエラー');
});

test('the terminal message names the category and includes the concrete reason', () => {
  const error = nonOkError('EACCES /path/lmstudio.json');
  const message = settingsSaveErrorMessage(error, 'LM Studio');
  assert.match(message, /^保存に失敗しました（LM Studio）: /, 'the message names the failing category');
  assert.match(message, /EACCES \/path\/lmstudio\.json/, 'the message carries the concrete reason');
  // It must not be a saving/pending phrase — the whole point is a terminal error state.
  assert.doesNotMatch(message, /保存中です|反映中です/);
});

test('the terminal message covers all three failure modes for each of the three categories', () => {
  const modes = {
    'non-OK response': nonOkError('EACCES /path/config.json'),
    'network reject': new TypeError('Failed to fetch'),
    'malformed success': new Error('settings save returned no body')
  };
  for (const label of ['LM Studio', '会話ポップアップ', '音声']) {
    for (const [mode, error] of Object.entries(modes)) {
      const message = settingsSaveErrorMessage(error, label);
      assert.match(message, new RegExp(`^保存に失敗しました（${label}）: `), `${label} / ${mode} names the category`);
      assert.doesNotMatch(message, /保存中です|反映中です/, `${label} / ${mode} is a terminal error, not a saving phrase`);
      assert.ok(settingsSaveErrorReason(error).length > 0, `${label} / ${mode} carries a non-empty reason`);
    }
  }
});
