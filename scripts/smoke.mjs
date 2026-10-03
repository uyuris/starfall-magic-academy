#!/usr/bin/env node
// Smoke test: boot the runtime server over a fresh temporary root and confirm the playable browser shell
// is served (HTTP 200 on `/`), then shut the server down and remove the temporary root.
//
// This is the user-visible behavior gate for `make smoke`. The server never sees this repository's saves
// (data/mutable) or local config (app/config): its root and its LM Studio config path both live in the
// temporary root, so smoke runs without LM Studio configured and does not contend for the one-server lock
// a repository server holds. The shell itself (app/public) and the canonical assets are read from the repo.

import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { shutdownServer, startServer } from '../app/src/server.mjs';

const host = '127.0.0.1';
const port = Number(process.env.SMOKE_PORT ?? process.env.PORT ?? 4173);

function probe() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error(`GET http://${host}:${port}/ timed out`)));
    req.on('error', reject);
  });
}

async function main(root) {
  const { server } = await startServer({
    root,
    host,
    port,
    lmStudioConfigPath: path.join(root, 'config', 'lmstudio.json'),
  });
  try {
    const status = await probe();
    if (status !== 200) throw new Error(`GET http://${host}:${port}/ -> ${status}, expected 200`);
    console.log(`smoke ok: GET http://${host}:${port}/ -> 200 (root ${root})`);
  } finally {
    await shutdownServer(server);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starfall-smoke-'));
try {
  await main(root);
} catch (error) {
  console.error(`smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit();
