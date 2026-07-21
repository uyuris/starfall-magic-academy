import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createServer } from '../src/server.mjs';
import { fixtureRoot } from './helpers.mjs';
import { CONVERSATION_POPUP_COOLDOWN_PRESETS, CONVERSATION_POPUP_DEFAULTS } from '../src/server/conversationPopupSettingsApi.mjs';

// The conversation-popup settings sidecar: GET/PATCH /api/settings/conversation-popup, a strict self-managed
// JSON store of the single cooldown preset. This suite pins the persist-failure error classification the
// stuck-"保存中です" fix introduced: a client-input reject stays 400, an fs-origin persist failure surfaces
// as 500 (consistent with the outer createServer catch), never mislabeled as a client 400.

const VALID_PRESET = CONVERSATION_POPUP_COOLDOWN_PRESETS[0];

async function isolatedSettingsPath(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-conv-popup-settings-'));
  t.after(async () => {
    await fs.chmod(dir, 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, settingsPath: path.join(dir, 'conversation-popup.json') };
}

async function bootServer(t, conversationPopupSettingsPath) {
  const root = await fixtureRoot('magic-adv-conv-popup-settings-root-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const server = createServer({ root, conversationPopupSettingsPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function patchPopup(base, body) {
  const response = await fetch(`${base}/api/settings/conversation-popup`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function getPopup(base) {
  const response = await fetch(`${base}/api/settings/conversation-popup`);
  return { status: response.status, body: await response.json() };
}

test('conversation-popup GET returns the documented defaults when the file is absent (first run)', async (t) => {
  const { settingsPath } = await isolatedSettingsPath(t);
  const base = await bootServer(t, settingsPath);
  const { status, body } = await getPopup(base);
  assert.equal(status, 200);
  assert.deepEqual(body, { ...CONVERSATION_POPUP_DEFAULTS });
});

test('conversation-popup PATCH persists a valid preset and GET returns it', async (t) => {
  const { settingsPath } = await isolatedSettingsPath(t);
  const base = await bootServer(t, settingsPath);
  const saved = await patchPopup(base, { cooldown_ms: VALID_PRESET });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { cooldown_ms: VALID_PRESET });
  const after = await getPopup(base);
  assert.deepEqual(after.body, { cooldown_ms: VALID_PRESET });
});

test('conversation-popup PATCH rejects a non-preset cooldown with a client 400', async (t) => {
  const { settingsPath } = await isolatedSettingsPath(t);
  const base = await bootServer(t, settingsPath);
  const { status, body } = await patchPopup(base, { cooldown_ms: 999 });
  assert.equal(status, 400, 'a non-preset value is a client input error (400)');
  assert.ok(body.error, 'the rejection carries an error message');
});

test('conversation-popup PATCH classifies an fs-origin persist failure as 500, not 400', async (t) => {
  const { dir, settingsPath } = await isolatedSettingsPath(t);
  const base = await bootServer(t, settingsPath);
  await fs.chmod(dir, 0o555);

  const { status, body } = await patchPopup(base, { cooldown_ms: VALID_PRESET });
  assert.equal(status, 500, 'an EACCES persist failure is a server failure (500), not a client 400');
  assert.match(body.error, /EACCES/, 'the fs error reason is surfaced in the response body');
});
