import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../src/server.mjs';

// Isolate EVERY local surface the server reads from the machine to a fresh empty temp root: the project
// `root` (so it reads NO real data/mutable save data — a real active slot with a pre-replacement persona
// variant would otherwise put the gate into routing mode and 400 the dispatch), plus every config sidecar
// (LM Studio config, play-mode, conversation-popup), passed explicitly so they also override any
// MAGIC_ACADEMY_* env var / real app/config file. This guarantees the startup gate reads ZERO real
// app/config and ZERO real save data by construction: without it the gate picks up the developer/CI
// machine's persisted state, making startup behavior non-deterministic. Under the empty temp root there is
// no active slot and no sidecar, so the server starts on its documented empty-config loop baseline. Any
// future server-read path must be added to `serverConfig` here so the "no real machine reads" guarantee
// stays complete rather than degrading to per-file whack-a-mole.
async function makeIsolatedStartupOptions() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-startup-'));
  const configDir = path.join(root, 'config');
  return {
    root,
    serverConfig: {
      root,
      lmStudioConfigPath: path.join(configDir, 'lmstudio.json'),
      playModeSettingsPath: path.join(configDir, 'play-mode.json'),
      conversationPopupSettingsPath: path.join(configDir, 'conversation-popup.json')
    }
  };
}

test('startServer starts on localhost without an LM Studio config file', async (t) => {
  const { root, serverConfig } = await makeIsolatedStartupOptions();
  const started = await startServer({ port: 0, host: '127.0.0.1', silent: true, ...serverConfig });
  t.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(started.host, '127.0.0.1');
  assert.equal(started.lmStudioConfig, null);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(started.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /STARFALL MAGIC ACADEMY|<html/i);

  const settingsResponse = await fetch(`${started.url}/api/settings/lmstudio`);
  assert.equal(settingsResponse.status, 200);
  const settingsBody = await settingsResponse.json();
  assert.equal(settingsBody.connection_mode, 'localhost');

  const openingResponse = await fetch(`${started.url}/api/conversation/opening`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_001', provider: 'lmstudio' })
  });
  assert.equal(openingResponse.status, 503);
  const openingBody = await openingResponse.json();
  assert.equal(openingBody.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
});

test('startServer honors an explicit localhost host instead of broad default exposure', async (t) => {
  const { root, serverConfig } = await makeIsolatedStartupOptions();
  const started = await startServer({ port: 0, host: '127.0.0.1', silent: true, ...serverConfig });
  t.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(started.host, '127.0.0.1');
});

test('startServer rejects listen errors instead of hanging when the port is already occupied', async (t) => {
  const { root, serverConfig } = await makeIsolatedStartupOptions();
  const first = await startServer({ port: 0, host: '127.0.0.1', silent: true, ...serverConfig });
  t.after(async () => {
    await new Promise((resolve) => first.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    startServer({ port: first.port, host: '127.0.0.1', silent: true, ...serverConfig }),
    /EADDRINUSE|address already in use/
  );
});
