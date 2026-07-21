import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createServer } from '../src/server.mjs';
import { fixtureRoot } from './helpers.mjs';

// The audio (BGM) settings sidecar: GET/PATCH /api/settings/audio, a strict self-managed JSON store with the
// two-key shape { bgm_enabled, bgm_volume }. First-run returns the documented defaults; a corrupt file fail-fasts
// on read; PATCH accepts partial updates and rejects unknown keys / wrong types / out-of-range values with 400.

async function isolatedAudioSettingsPath(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-audio-settings-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'audio.json');
}

async function bootServer(t, audioSettingsPath) {
  const root = await fixtureRoot('magic-adv-audio-settings-root-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const server = createServer({ root, audioSettingsPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function getAudio(base) {
  const response = await fetch(`${base}/api/settings/audio`);
  return { status: response.status, body: await response.json() };
}

async function patchAudio(base, body) {
  const response = await fetch(`${base}/api/settings/audio`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('audio settings GET returns the documented defaults when the file is absent (first run)', async (t) => {
  const settingsPath = await isolatedAudioSettingsPath(t);
  const base = await bootServer(t, settingsPath);

  const { status, body } = await getAudio(base);
  assert.equal(status, 200);
  assert.deepEqual(body, { bgm_enabled: true, bgm_volume: 1 });
  // First-run GET must not create the file (defaults are computed, not persisted).
  await assert.rejects(fs.access(settingsPath), 'a first-run GET does not write the settings file');
});

test('audio settings PATCH persists a partial update and GET returns the persisted values', async (t) => {
  const settingsPath = await isolatedAudioSettingsPath(t);
  const base = await bootServer(t, settingsPath);

  // Partial update of only the volume: bgm_enabled keeps the default.
  const volumeOnly = await patchAudio(base, { bgm_volume: 0.4 });
  assert.equal(volumeOnly.status, 200);
  assert.deepEqual(volumeOnly.body, { bgm_enabled: true, bgm_volume: 0.4 });

  // Partial update of only the toggle: the persisted volume is preserved.
  const enabledOnly = await patchAudio(base, { bgm_enabled: false });
  assert.equal(enabledOnly.status, 200);
  assert.deepEqual(enabledOnly.body, { bgm_enabled: false, bgm_volume: 0.4 });

  // Both keys at once.
  const both = await patchAudio(base, { bgm_enabled: true, bgm_volume: 0 });
  assert.equal(both.status, 200);
  assert.deepEqual(both.body, { bgm_enabled: true, bgm_volume: 0 });

  const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(persisted, { bgm_enabled: true, bgm_volume: 0 });

  const afterGet = await getAudio(base);
  assert.equal(afterGet.status, 200);
  assert.deepEqual(afterGet.body, { bgm_enabled: true, bgm_volume: 0 });
});

test('audio settings PATCH accepts the volume range boundaries (0 and 1)', async (t) => {
  const base = await bootServer(t, await isolatedAudioSettingsPath(t));
  assert.deepEqual((await patchAudio(base, { bgm_volume: 0 })).body, { bgm_enabled: true, bgm_volume: 0 });
  assert.deepEqual((await patchAudio(base, { bgm_volume: 1 })).body, { bgm_enabled: true, bgm_volume: 1 });
});

test('audio settings PATCH rejects unknown keys, wrong types, and out-of-range values with 400 (no clamp, no silent drop)', async (t) => {
  const settingsPath = await isolatedAudioSettingsPath(t);
  const base = await bootServer(t, settingsPath);

  for (const [label, body] of [
    ['unknown key', { bgm_enabled: true, master_volume: 0.5 }],
    ['bgm_volume above range', { bgm_volume: 1.5 }],
    ['bgm_volume below range', { bgm_volume: -0.1 }],
    ['bgm_volume as string', { bgm_volume: '0.5' }],
    ['bgm_volume NaN', { bgm_volume: Number.NaN }],
    ['bgm_enabled as number', { bgm_enabled: 1 }],
    ['bgm_enabled as string', { bgm_enabled: 'true' }],
    ['empty update', {}]
  ]) {
    const { status, body: response } = await patchAudio(base, body);
    assert.equal(status, 400, `${label} should be rejected with 400`);
    assert.ok(response.error, `${label} should return an error message`);
  }

  // A rejected PATCH must not create or mutate the store: the next GET still returns the untouched defaults.
  const afterGet = await getAudio(base);
  assert.deepEqual(afterGet.body, { bgm_enabled: true, bgm_volume: 1 });
  await assert.rejects(fs.access(settingsPath), 'a rejected PATCH must not persist anything');
});

test('audio settings GET fail-fasts on a corrupt file (invalid JSON) rather than resetting to defaults', async (t) => {
  const settingsPath = await isolatedAudioSettingsPath(t);
  const base = await bootServer(t, settingsPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, '{ this is not json', 'utf8');

  const { status, body } = await getAudio(base);
  assert.equal(status, 500, 'a corrupt settings file surfaces as a 500 (never a silent reset to defaults)');
  assert.ok(body.error, 'the corrupt-file error is reported');
});

test('audio settings GET fail-fasts on an out-of-range persisted value', async (t) => {
  const settingsPath = await isolatedAudioSettingsPath(t);
  const base = await bootServer(t, settingsPath);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ bgm_enabled: true, bgm_volume: 4 }), 'utf8');

  const { status, body } = await getAudio(base);
  assert.equal(status, 500, 'an out-of-range persisted volume fail-fasts on read');
  assert.ok(body.error);
});

test('audio settings PATCH classifies an fs-origin persist failure as 500, not 400', async (t) => {
  // The stuck-"保存中です" fix requires the backend to distinguish client input (400) from a server-side
  // persist failure (5xx): an EACCES write to a read-only config dir is a server failure, so the PATCH must
  // return 500 (consistent with the outer createServer catch's statusCode ?? 500), never a client 400.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-audio-settings-ro-'));
  const settingsPath = path.join(dir, 'audio.json');
  const base = await bootServer(t, settingsPath);
  await fs.chmod(dir, 0o555);
  t.after(async () => {
    await fs.chmod(dir, 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  const { status, body } = await patchAudio(base, { bgm_volume: 0.5 });
  assert.equal(status, 500, 'an EACCES persist failure is a server failure (500), not a client 400');
  assert.match(body.error, /EACCES/, 'the fs error reason is surfaced in the response body');

  // A validation failure stays a client 400 (the classification only re-labels fs-origin failures).
  const rejected = await patchAudio(base, { bgm_volume: 1.5 });
  assert.equal(rejected.status, 400, 'an out-of-range value is still a client 400');
});

test('audio settings GET fail-fasts on a persisted file with unknown or missing keys', async (t) => {
  for (const badShape of [
    { bgm_enabled: true, bgm_volume: 1, extra: 1 },
    { bgm_enabled: true },
    { bgm_volume: 1 }
  ]) {
    const settingsPath = await isolatedAudioSettingsPath(t);
    const base = await bootServer(t, settingsPath);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(badShape), 'utf8');
    const { status } = await getAudio(base);
    assert.equal(status, 500, `persisted shape ${JSON.stringify(badShape)} should fail-fast on read`);
  }
});
