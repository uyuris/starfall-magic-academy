import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createServer } from '../src/server.mjs';
import { fixtureRoot } from './helpers.mjs';

// PATCH /api/settings/lmstudio persist-failure error classification (the stuck-"反映中です" fix): a
// client-input reject stays 400, an fs-origin persist failure (EACCES writing the config) surfaces as 500
// (consistent with the outer createServer catch's statusCode ?? 500), never mislabeled as a client 400.

async function isolatedConfigPath(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-lmstudio-settings-'));
  t.after(async () => {
    await fs.chmod(dir, 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, configPath: path.join(dir, 'lmstudio.json') };
}

async function bootServer(t, lmStudioConfigPath) {
  const root = await fixtureRoot('magic-adv-lmstudio-settings-root-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const server = createServer({ root, lmStudioConfigPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function patchLmStudio(base, body) {
  const response = await fetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const VALID_UPDATE = { connection_mode: 'localhost', port: 1234, model: 'test-model' };

test('lmstudio PATCH persists a valid settings update', async (t) => {
  const { configPath } = await isolatedConfigPath(t);
  const base = await bootServer(t, configPath);
  const { status, body } = await patchLmStudio(base, VALID_UPDATE);
  assert.equal(status, 200);
  assert.equal(body.base_url, 'http://127.0.0.1:1234/v1');
  assert.equal(body.model, 'test-model');
  const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(persisted.chat_model, 'test-model');
});

test('lmstudio PATCH rejects invalid client input with a 400', async (t) => {
  const { configPath } = await isolatedConfigPath(t);
  const base = await bootServer(t, configPath);
  for (const [label, body] of [
    ['missing model', { connection_mode: 'localhost', port: 1234 }],
    ['bad connection_mode', { connection_mode: 'wan', port: 1234, model: 'm' }],
    ['out-of-range port', { connection_mode: 'localhost', port: 70000, model: 'm' }],
    ['bad thinking_effort', { ...VALID_UPDATE, thinking_effort: 'extreme' }]
  ]) {
    const { status, body: response } = await patchLmStudio(base, body);
    assert.equal(status, 400, `${label} should be a client 400`);
    assert.ok(response.error, `${label} should carry an error message`);
  }
});

test('lmstudio PATCH classifies an fs-origin persist failure as 500, not 400', async (t) => {
  const { dir, configPath } = await isolatedConfigPath(t);
  const base = await bootServer(t, configPath);
  await fs.chmod(dir, 0o555);

  const { status, body } = await patchLmStudio(base, VALID_UPDATE);
  assert.equal(status, 500, 'an EACCES persist failure is a server failure (500), not a client 400');
  assert.match(body.error, /EACCES/, 'the fs error reason is surfaced in the response body');
});
