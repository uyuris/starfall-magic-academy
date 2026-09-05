import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';
import {
  _saveDataRepairInFlightForTest,
  _saveDataRepairUnconsumedPointerPath
} from '../src/server/saveDataRepairApi.mjs';

// The 「セーブデータ修正」 API surface: POST /api/settings/save-data-repair/unconsumed-routing-conversation-pointer
// spawns the idempotent migration script, parses its stdout JSON, wraps it as { status: 'ok', result }, and returns
// 500 { error, code: 'migration_failed' } when the script fails / returns non-JSON. A concurrent second request while
// one is in flight is rejected with 409 { code: 'already_running' }. The single-flight gate clears when the request
// finishes, so a follow-up POST can run again.

const ENDPOINT = _saveDataRepairUnconsumedPointerPath;

async function bootServer(t, extraOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-save-data-repair-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const server = createServer({ root, ...extraOptions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, root };
}

async function post(base) {
  const response = await fetch(`${base}${ENDPOINT}`, { method: 'POST' });
  return { status: response.status, body: await response.json() };
}

test('save-data-repair pointer endpoint spawns the migration script and returns its parsed result', async (t) => {
  const stubResult = {
    root: '/tmp/whatever',
    applied: true,
    total: 3,
    added: 1,
    skipped_already_present: 2,
    added_targets: ['slot:save_slot_02'],
    skipped_targets: ['legacy_top_level', 'slot:save_slot_01']
  };
  const { base } = await bootServer(t, {
    saveDataRepairRunnerForTest: async () => stubResult
  });

  const { status, body } = await post(base);
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok', result: stubResult });
  assert.equal(_saveDataRepairInFlightForTest().size, 0, 'in-flight gate clears after success');
});

test('save-data-repair pointer endpoint returns 500 with error code when the migration runner throws', async (t) => {
  const { base } = await bootServer(t, {
    saveDataRepairRunnerForTest: async () => {
      throw new Error('boom: script exited with code 1');
    }
  });

  const { status, body } = await post(base);
  assert.equal(status, 500);
  assert.equal(body.code, 'migration_failed');
  assert.match(body.error, /boom/);
  assert.equal(_saveDataRepairInFlightForTest().size, 0, 'in-flight gate clears after failure');
});

test('save-data-repair pointer endpoint rejects a concurrent second call with 409 already_running', async (t) => {
  let releaseFirst;
  const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
  const { base } = await bootServer(t, {
    saveDataRepairRunnerForTest: async () => {
      await firstDone;
      return { root: '/tmp/whatever', applied: true, total: 0, added: 0, skipped_already_present: 0, added_targets: [], skipped_targets: [] };
    }
  });

  const first = post(base);
  // Yield a couple of ticks so the first request registers itself in the in-flight map before the second lands.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await post(base);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'already_running');
  assert.match(second.body.error, /is already running/);

  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.status, 200);
  assert.equal(firstResult.body.status, 'ok');

  // After the first call finishes, a follow-up POST is accepted again (the gate cleared).
  const followUp = await post(base);
  assert.equal(followUp.status, 200);
  assert.equal(followUp.body.status, 'ok');
});

test('save-data-repair pointer endpoint really spawns the on-disk migration script when no runner override is supplied', async (t) => {
  // The default path uses the real child_process.spawn of scripts/add-...mjs. Fresh empty save root has no legacy
  // runtime file yet (mkdtemp only) so the script returns total=0/added=0 — proof that spawn → stdout parse works.
  const { base, root } = await bootServer(t);
  const { status, body } = await post(base);
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.result.applied, true);
  assert.equal(typeof body.result.total, 'number');
  assert.equal(typeof body.result.added, 'number');
  assert.equal(typeof body.result.skipped_already_present, 'number');
  // On macOS /var → /private/var symlink means the child process reports the realpath; compare via realpath.
  assert.equal(body.result.root, await fs.realpath(root));
});
