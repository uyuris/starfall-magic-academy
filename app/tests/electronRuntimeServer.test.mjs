import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';

import { listenInternalServer } from '../src/electron/runtimeServer.mjs';

test('listenInternalServer returns localhost base URL for a fixed-port server', async (t) => {
  const server = createHttpServer((req, res) => res.end('ok'));
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  const started = await listenInternalServer({ server, host: '127.0.0.1', port: 0 });
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(started.url);
  assert.equal(await response.text(), 'ok');
});

test('listenInternalServer throws a user-facing port-conflict error when the fixed port is occupied', async (t) => {
  const occupied = createHttpServer((req, res) => res.end('busy'));
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => occupied.close(resolve));
  });
  const port = occupied.address().port;
  const server = createHttpServer((req, res) => res.end('never'));

  await assert.rejects(
    () => listenInternalServer({ server, host: '127.0.0.1', port }),
    /port .* already in use|起動できません/i
  );
});