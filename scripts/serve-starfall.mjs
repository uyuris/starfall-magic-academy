#!/usr/bin/env node
// 配信版の起動口。テレグラフが SERVE_PORT・SERVE_HOST を渡して
// 1本 exec する。このリポのセーブ（data/mutable）で製品サーバーを前景のまま動かし、process group への
// SIGTERM で書きかけを終えてから止まる。子 process は作らない。

import { runRepositoryServerEntry } from '../app/src/server.mjs';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: the serve frame passes it to this entry`);
  return value;
}

const rawPort = requiredEnv('SERVE_PORT');
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`SERVE_PORT must be a TCP port number, got: ${rawPort}`);
}
const host = requiredEnv('SERVE_HOST');

await runRepositoryServerEntry({ owner: '配信版', host, port });
