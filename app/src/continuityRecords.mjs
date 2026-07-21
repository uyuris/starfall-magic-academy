import { promises as fs } from 'node:fs';
import path from 'node:path';

// Continuity record retention: character memory / skills / work-record files are
// capped at this many newest entries. The conversation finalization writer prunes
// to this limit, so retention has one source of truth instead of drifting.
export const CONTINUITY_RECORD_LIMIT = 100;

// Prunes a record directory down to `limit` files, removing the oldest by
// filename sort. Returns the removed filenames. A missing directory is the
// honest "nothing to prune" and returns []. Shared by every continuity writer so
// retention is identical across seams.
export async function pruneRecordFilesToLimit({ storage, relativeDir, suffix, limit = CONTINUITY_RECORD_LIMIT }) {
  const fullDir = await storage.resolveReadPath(relativeDir);
  let names;
  try {
    names = await fs.readdir(fullDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = names.filter((name) => name.endsWith(suffix)).sort();
  const excess = entries.length - limit;
  if (excess <= 0) return [];
  const removed = entries.slice(0, excess);
  await Promise.all(removed.map((entry) => fs.rm(storage.resolveWritePath(path.join(relativeDir, entry)), { force: true })));
  return removed;
}
