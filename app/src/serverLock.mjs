import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One server at a time may touch a repository's data/mutable. The mark lives next to the saves it guards
// and records the holder's pid and kind; a mark whose pid is no longer alive is taken over.
export function serverLockPath(projectRoot) {
  return path.join(projectRoot, 'data', 'mutable', 'server.lock');
}

export class ServerLockHeldError extends Error {
  constructor(holder) {
    super(`スターフォールはすでに別のサーバー（pid ${holder.pid}・${holder.owner}）がこのセーブで動いているため起こせません`);
    this.name = 'ServerLockHeldError';
    this.holder = holder;
  }
}

function readHolder(lockPath) {
  const text = fs.readFileSync(lockPath, 'utf8');
  const holder = JSON.parse(text);
  if (!Number.isInteger(holder?.pid) || holder.pid <= 0 || typeof holder.owner !== 'string' || !holder.owner) {
    throw new Error(`server lock ${lockPath} does not hold a pid and owner: ${text}`);
  }
  return holder;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

// The mark is written whole to a private file and linked into place, so it appears complete or not at all
// and two starters cannot both create it.
function tryCreate(lockPath, holder) {
  const staged = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(staged, `${JSON.stringify(holder)}\n`, { flag: 'wx' });
  try {
    fs.linkSync(staged, lockPath);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.unlinkSync(staged);
  }
}

function readHolderIfPresent(lockPath) {
  try {
    return readHolder(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Moves a dead holder's mark aside. Another starter may have moved it first (the mark is gone) or already
// replaced it with its own live mark (put that one back).
function retakeFrom(lockPath, deadHolder) {
  const aside = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (readHolder(aside).pid === deadHolder.pid) fs.unlinkSync(aside);
  else fs.renameSync(aside, lockPath);
}

// Takes the lock for the rest of this process's life and removes the mark on exit. Throws
// ServerLockHeldError while a live process holds it.
export function holdServerLockForProcess({ projectRoot, owner }) {
  const lockPath = serverLockPath(projectRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (!tryCreate(lockPath, { pid: process.pid, owner })) {
    const current = readHolderIfPresent(lockPath);
    if (!current) continue;
    if (isAlive(current.pid)) throw new ServerLockHeldError(current);
    retakeFrom(lockPath, current);
  }
  process.on('exit', () => {
    if (readHolderIfPresent(lockPath)?.pid === process.pid) fs.unlinkSync(lockPath);
  });
  return lockPath;
}
