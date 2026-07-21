#!/usr/bin/env node
// Smoke test: boot the local runtime server and confirm the playable browser
// shell is served (HTTP 200 on `/`), then shut the server down.
//
// This is the user-visible behavior gate for `make smoke`: a fresh checkout
// should serve the game shell even without LM Studio configured.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const serverEntry = path.join('app', 'src', 'server.mjs');

const host = '127.0.0.1';
const port = Number(process.env.SMOKE_PORT ?? process.env.PORT ?? 4173);
const startupTimeoutMs = 20000;
const pollIntervalMs = 300;

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const output = [];
const child = spawn(process.execPath, [serverEntry], {
  cwd: projectRoot,
  env: { ...process.env, PORT: String(port), HOST: host },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => output.push(chunk));
child.stderr.on('data', (chunk) => output.push(chunk));

let childExited = false;
let childExitInfo = null;
child.on('exit', (code, signal) => {
  childExited = true;
  childExitInfo = { code, signal };
});

function dumpServerOutput() {
  const text = Buffer.concat(output).toString('utf8').trim();
  if (text) {
    process.stderr.write('--- server output ---\n');
    process.stderr.write(text + '\n');
    process.stderr.write('---------------------\n');
  }
}

async function shutdown() {
  if (childExited) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && !childExited; i += 1) {
    await sleep(50);
  }
  if (!childExited) child.kill('SIGKILL');
}

async function main() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (childExited) {
      dumpServerOutput();
      throw new Error(
        `server exited before responding (code=${childExitInfo?.code}, signal=${childExitInfo?.signal})`,
      );
    }
    const status = await probe();
    if (status === 200) {
      console.log(`smoke ok: GET http://${host}:${port}/ -> 200`);
      return;
    }
    await sleep(pollIntervalMs);
  }
  dumpServerOutput();
  throw new Error(`server did not return 200 on http://${host}:${port}/ within ${startupTimeoutMs}ms`);
}

try {
  await main();
  await shutdown();
  process.exit(0);
} catch (error) {
  await shutdown();
  console.error(`smoke failed: ${error.message}`);
  process.exit(1);
}
