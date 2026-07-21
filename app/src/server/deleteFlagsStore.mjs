import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from '../storage.mjs';

const DELETE_FLAGS_FILENAME = 'delete-flags.json';
const CHARACTER_ID_PATTERN = /^character_\d{3}$/;

function deleteFlagsFilePath(root) {
  if (!root) throw new Error('root is required for character delete flags');
  const { paths } = createStorageApi({ root });
  return path.join(paths.characterContentRoot, DELETE_FLAGS_FILENAME);
}

function sortedUnique(ids) {
  return Array.from(new Set(ids.map((id) => String(id)))).sort();
}

function validateCharacterId(characterId) {
  const id = String(characterId ?? '').trim();
  if (!CHARACTER_ID_PATTERN.test(id)) {
    const error = new Error(`invalid character id for delete flag: ${id || '(empty)'}`);
    error.statusCode = 400;
    error.errorCode = 'invalid_character_id';
    throw error;
  }
  return id;
}

function normalizeFlaggedSet(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`delete flags file must be a JSON object: ${filePath}`);
  }
  const { flagged } = value;
  if (!Array.isArray(flagged)) {
    throw new Error(`delete flags file must contain a "flagged" array: ${filePath}`);
  }
  for (const entry of flagged) {
    if (!CHARACTER_ID_PATTERN.test(String(entry))) {
      throw new Error(`delete flags file contains an invalid character id: ${entry} (${filePath})`);
    }
  }
  return sortedUnique(flagged);
}

export async function readCharacterDeleteFlags({ root }) {
  const filePath = deleteFlagsFilePath(root);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // First run: the flags file does not exist yet. Per the task it must be
    // created (initialized) as an empty set — not merely treated as empty. A
    // missing content/characters root is a real misconfiguration, so fail fast
    // before creating anything (writeCharacterDeleteFlags only creates the file
    // inside an existing content root, never the content root itself).
    await fs.access(path.dirname(filePath));
    await writeCharacterDeleteFlags({ root, flagged: [] });
    return { flagged: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`delete flags file is not valid JSON: ${filePath}: ${error.message}`);
  }
  return { flagged: normalizeFlaggedSet(parsed, filePath) };
}

async function writeCharacterDeleteFlags({ root, flagged }) {
  const filePath = deleteFlagsFilePath(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ flagged: sortedUnique(flagged) }, null, 2)}\n`, 'utf8');
}

export async function toggleCharacterDeleteFlag({ root, characterId }) {
  const id = validateCharacterId(characterId);
  const { flagged } = await readCharacterDeleteFlags({ root });
  const set = new Set(flagged);
  const flaggedNow = !set.has(id);
  if (flaggedNow) set.add(id);
  else set.delete(id);
  const nextFlagged = sortedUnique(Array.from(set));
  await writeCharacterDeleteFlags({ root, flagged: nextFlagged });
  return { flagged: nextFlagged, character_id: id, flagged_now: flaggedNow };
}
