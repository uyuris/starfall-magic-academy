import { promises as fs } from 'node:fs';
import path from 'node:path';

const defaultFlagsPath = 'content/characters/delete-flags.json';
const characterIdPattern = /^character_(\d{3})$/;
const characterTokenPattern = /character_\d{3}(?!\d)/g;
const deletedValue = Symbol('deleted-character-reference');

function pad(index) {
  return String(index).padStart(3, '0');
}

function characterId(index) {
  return `character_${pad(index)}`;
}

function visualSetId(index) {
  return `visual_set_${pad(index)}`;
}

function sourceSheetFilename(visualId) {
  return `${visualId}_emotion16_source_sheet.jpg`;
}

function sourceImagePath(root, visualId) {
  return path.join(root, 'assets/canonical/source_images', sourceSheetFilename(visualId));
}

function resolveRoot(root) {
  if (!root) throw new Error('root is required');
  return path.resolve(root);
}

function resolveRootPath(root, relativeOrAbsolutePath) {
  if (path.isAbsolute(relativeOrAbsolutePath)) return path.resolve(relativeOrAbsolutePath);
  return path.join(root, relativeOrAbsolutePath);
}

function displayPath(root, fullPath) {
  const relative = path.relative(root, fullPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return fullPath;
  return relative.split(path.sep).join('/');
}

async function pathExists(targetPath) {
  return await fs.access(targetPath).then(() => true).catch(() => false);
}

async function isDirectory(targetPath) {
  return await fs.stat(targetPath).then((stat) => stat.isDirectory()).catch(() => false);
}

async function readTextFile(fullPath, label) {
  try {
    return await fs.readFile(fullPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`missing ${label}: ${fullPath}`);
    throw error;
  }
}

async function readJsonFile(fullPath, label) {
  const source = await readTextFile(fullPath, label);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${fullPath}: ${error.message}`);
  }
}

async function writeTextFile(fullPath, value) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, value, 'utf8');
}

async function writeJsonFile(fullPath, value) {
  await writeTextFile(fullPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readCharacterCount(root) {
  const catalogPath = path.join(root, 'app/src/characterCatalog.mjs');
  const source = await readTextFile(catalogPath, 'character catalog');
  const matches = [...source.matchAll(/const characterCount = (\d+);/g)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one characterCount declaration in ${displayPath(root, catalogPath)}`);
  }
  const count = Number.parseInt(matches[0][1], 10);
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid characterCount: ${matches[0][1]}`);
  return { count, catalogPath, source };
}

function catalogSourceWithCount(source, nextCount) {
  const matches = [...source.matchAll(/const characterCount = \d+;/g)];
  if (matches.length !== 1) throw new Error('expected exactly one characterCount declaration before writing catalog');
  return source.replace(/const characterCount = \d+;/, `const characterCount = ${nextCount};`);
}

function parseCharacterIndex(rawId) {
  if (typeof rawId !== 'string') throw new Error(`invalid flagged character id: ${String(rawId)}`);
  const match = characterIdPattern.exec(rawId);
  if (!match) throw new Error(`invalid flagged character id: ${rawId}`);
  return Number.parseInt(match[1], 10);
}

async function readDeleteFlags(root, flagsPath) {
  const fullPath = resolveRootPath(root, flagsPath);
  const flags = await readJsonFile(fullPath, 'delete flags');
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
    throw new Error('delete flags must be an object with a flagged array');
  }
  const keys = Object.keys(flags);
  if (keys.length !== 1 || keys[0] !== 'flagged') {
    throw new Error('delete flags schema must contain only the flagged array');
  }
  if (!Array.isArray(flags.flagged)) throw new Error('delete flags flagged must be an array');

  const seen = new Set();
  const flagged = flags.flagged.map((rawId) => {
    const index = parseCharacterIndex(rawId);
    if (seen.has(rawId)) throw new Error(`duplicate flagged character id: ${rawId}`);
    seen.add(rawId);
    return { id: rawId, index };
  });
  return { fullPath, flagged };
}

async function requireDirectory(root, fullPath, message) {
  if (!await isDirectory(fullPath)) throw new Error(message);
}

async function requireFile(root, fullPath, label) {
  if (!await pathExists(fullPath)) throw new Error(`missing ${label}: ${displayPath(root, fullPath)}`);
}

function buildMovePlan({ count, flagged }) {
  for (const item of flagged) {
    if (item.index < 1 || item.index > count) throw new Error(`flagged character out of range: ${item.id}`);
  }

  const flaggedIndices = new Set(flagged.map((item) => item.index));
  const deletedIndices = [...flaggedIndices].sort((left, right) => left - right);
  const newCount = count - deletedIndices.length;
  if (newCount < 1) throw new Error('cannot delete all selectable characters');

  const lowDeleteIndices = [];
  for (let index = 1; index <= newCount; index += 1) {
    if (flaggedIndices.has(index)) lowDeleteIndices.push(index);
  }

  const tailSurvivorIndices = [];
  for (let index = count; index > newCount; index -= 1) {
    if (!flaggedIndices.has(index)) tailSurvivorIndices.push(index);
  }

  if (lowDeleteIndices.length !== tailSurvivorIndices.length) {
    throw new Error('internal swap-and-pop mismatch between low deletes and tail survivors');
  }

  const moves = lowDeleteIndices.map((toIndex, moveIndex) => {
    const fromIndex = tailSurvivorIndices[moveIndex];
    return {
      from: characterId(fromIndex),
      to: characterId(toIndex),
      from_index: fromIndex,
      to_index: toIndex,
      visual_from: visualSetId(fromIndex),
      visual_to: visualSetId(toIndex)
    };
  });

  const truncates = deletedIndices
    .filter((index) => index > newCount)
    .map((index) => ({
      character_id: characterId(index),
      index,
      visual_set_id: visualSetId(index)
    }));

  return {
    old_count: count,
    new_count: newCount,
    deleted_ids: deletedIndices.map(characterId),
    moves,
    truncates
  };
}

async function collectAffectedFiles(root, plan, flagsFullPath) {
  const affected = new Set([
    displayPath(root, path.join(root, 'app/src/characterCatalog.mjs')),
    displayPath(root, flagsFullPath)
  ]);
  if (plan.deleted_ids.length === 0) return [...affected].sort();

  const manifestPath = path.join(root, 'content/characters/manifest.json');
  const seedRuntimePath = path.join(root, 'data/seeds/game_data/runtime_state.json');
  await requireFile(root, manifestPath, 'character manifest');
  await requireFile(root, seedRuntimePath, 'seed runtime state');
  affected.add(displayPath(root, manifestPath));
  affected.add(displayPath(root, seedRuntimePath));

  for (const move of plan.moves) {
    const fromContentDir = path.join(root, 'content/characters', move.from);
    const toContentDir = path.join(root, 'content/characters', move.to);
    const fromVisualDir = path.join(root, 'assets/canonical/character_visual_sets', move.visual_from);
    const toVisualDir = path.join(root, 'assets/canonical/character_visual_sets', move.visual_to);
    await requireDirectory(root, fromContentDir, `missing character content directory: ${move.from}`);
    await requireDirectory(root, toContentDir, `missing character content directory: ${move.to}`);
    await requireDirectory(root, fromVisualDir, `missing visual set directory: ${move.visual_from}`);
    await requireDirectory(root, toVisualDir, `missing visual set directory: ${move.visual_to}`);
    await requireFile(root, path.join(fromContentDir, 'profile.json'), 'moved character profile');
    await requireFile(root, path.join(fromVisualDir, 'manifest.json'), 'moved visual manifest');
    await requireFile(root, path.join(fromVisualDir, 'identity_notes.md'), 'moved visual identity notes');

    affected.add(displayPath(root, fromContentDir));
    affected.add(displayPath(root, toContentDir));
    affected.add(displayPath(root, fromVisualDir));
    affected.add(displayPath(root, toVisualDir));
    const fromSheet = sourceImagePath(root, move.visual_from);
    const toSheet = sourceImagePath(root, move.visual_to);
    if (await pathExists(fromSheet)) affected.add(displayPath(root, fromSheet));
    if (await pathExists(toSheet)) affected.add(displayPath(root, toSheet));
  }

  for (const truncate of plan.truncates) {
    const contentDir = path.join(root, 'content/characters', truncate.character_id);
    const visualDir = path.join(root, 'assets/canonical/character_visual_sets', truncate.visual_set_id);
    await requireDirectory(root, contentDir, `missing character content directory: ${truncate.character_id}`);
    await requireDirectory(root, visualDir, `missing visual set directory: ${truncate.visual_set_id}`);
    affected.add(displayPath(root, contentDir));
    affected.add(displayPath(root, visualDir));
    const sheet = sourceImagePath(root, truncate.visual_set_id);
    if (await pathExists(sheet)) affected.add(displayPath(root, sheet));
  }

  for (const affectedPath of await collectDataAffectedFiles(root, plan)) {
    affected.add(displayPath(root, affectedPath));
  }

  return [...affected].sort();
}

export async function createCharacterDeletionPlan({ root } = {}) {
  const resolvedRoot = resolveRoot(root);
  const [{ count }, flags] = await Promise.all([
    readCharacterCount(resolvedRoot),
    readDeleteFlags(resolvedRoot, defaultFlagsPath)
  ]);
  const movePlan = buildMovePlan({ count, flagged: flags.flagged });
  const affectedFiles = await collectAffectedFiles(resolvedRoot, movePlan, flags.fullPath);
  return {
    root: resolvedRoot,
    flags_path: displayPath(resolvedRoot, flags.fullPath),
    old_count: movePlan.old_count,
    new_count: movePlan.new_count,
    deleted_ids: movePlan.deleted_ids,
    moves: movePlan.moves,
    truncates: movePlan.truncates,
    affected_files: affectedFiles
  };
}

function createRemap(plan) {
  const deleteSet = new Set(plan.deleted_ids);
  const moveMap = new Map(plan.moves.map((move) => [move.from, move.to]));
  return { deleteSet, moveMap };
}

function rewriteCharacterTokens(value, { deleteSet, moveMap }) {
  let deleted = false;
  const next = value.replace(characterTokenPattern, (token) => {
    if (deleteSet.has(token)) {
      deleted = true;
      return token;
    }
    return moveMap.get(token) ?? token;
  });
  return deleted ? { deleted: true, value } : { deleted: false, value: next };
}

function transformJsonValue(value, remap) {
  if (typeof value === 'string') {
    const rewritten = rewriteCharacterTokens(value, remap);
    if (rewritten.deleted) return deletedValue;
    return rewritten.value;
  }
  if (Array.isArray(value)) {
    const next = [];
    for (const item of value) {
      const transformed = transformJsonValue(item, remap);
      if (transformed !== deletedValue) next.push(transformed);
    }
    return next;
  }
  if (!value || typeof value !== 'object') return value;

  const next = {};
  for (const [key, rawChildValue] of Object.entries(value)) {
    const rewrittenKey = rewriteCharacterTokens(key, remap);
    if (rewrittenKey.deleted) continue;
    if (Object.prototype.hasOwnProperty.call(next, rewrittenKey.value)) {
      throw new Error(`character deletion remap collision at object key: ${rewrittenKey.value}`);
    }
    const transformed = transformJsonValue(rawChildValue, remap);
    next[rewrittenKey.value] = transformed === deletedValue ? null : transformed;
  }
  return next;
}

function transformTextValue(value, remap, relativePath) {
  const rewritten = rewriteCharacterTokens(value, remap);
  if (rewritten.deleted) {
    throw new Error(`cannot safely clear deleted character reference in text file: ${relativePath}`);
  }
  return rewritten.value;
}

function jsonChanged(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function prepareCatalogWrite(root, plan) {
  const { catalogPath, source } = await readCharacterCount(root);
  const nextSource = catalogSourceWithCount(source, plan.new_count);
  if (nextSource === source) return null;
  return { type: 'text', path: catalogPath, value: nextSource };
}

function rewrittenProfile(profile, move) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`moved profile must be an object: ${move.from}`);
  }
  if (!profile.asset_state || typeof profile.asset_state !== 'object' || Array.isArray(profile.asset_state)) {
    throw new Error(`moved profile missing asset_state object: ${move.from}`);
  }
  const next = cloneJson(profile);
  next.character_id = move.to;
  next.visual_set_id = move.visual_to;
  next.source_image = `character_visual_sets/${move.visual_to}/face_emotions/neutral.jpg`;
  next.asset_state.character_id = move.to;
  next.asset_state.visual_set_id = move.visual_to;
  return next;
}

function rewrittenVisualManifest(manifest, move) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`moved visual manifest must be an object: ${move.visual_from}`);
  }
  if (!manifest.source_sheet || typeof manifest.source_sheet !== 'object' || Array.isArray(manifest.source_sheet)) {
    throw new Error(`moved visual manifest missing source_sheet object: ${move.visual_from}`);
  }
  const next = cloneJson(manifest);
  next.visual_set_id = move.visual_to;
  next.source_sheet.path = `../../source_images/${sourceSheetFilename(move.visual_to)}`;
  return next;
}

function rewrittenIdentityNotes(source, move) {
  const expectedHeading = /^# visual_set_\d{3} Identity Notes/m;
  if (!expectedHeading.test(source)) {
    throw new Error(`moved identity notes missing visual_set heading: ${move.visual_from}`);
  }
  return source.replace(expectedHeading, `# ${move.visual_to} Identity Notes`);
}

async function prepareMovedContentWrites(root, plan) {
  const writes = [];
  for (const move of plan.moves) {
    const fromContentDir = path.join(root, 'content/characters', move.from);
    const toContentDir = path.join(root, 'content/characters', move.to);
    const profile = await readJsonFile(path.join(fromContentDir, 'profile.json'), `profile for ${move.from}`);
    writes.push({
      type: 'json',
      path: path.join(toContentDir, 'profile.json'),
      value: rewrittenProfile(profile, move)
    });

    const fromVisualDir = path.join(root, 'assets/canonical/character_visual_sets', move.visual_from);
    const toVisualDir = path.join(root, 'assets/canonical/character_visual_sets', move.visual_to);
    const manifest = await readJsonFile(path.join(fromVisualDir, 'manifest.json'), `visual manifest for ${move.visual_from}`);
    writes.push({
      type: 'json',
      path: path.join(toVisualDir, 'manifest.json'),
      value: rewrittenVisualManifest(manifest, move)
    });

    const identityNotes = await readTextFile(path.join(fromVisualDir, 'identity_notes.md'), `identity notes for ${move.visual_from}`);
    writes.push({
      type: 'text',
      path: path.join(toVisualDir, 'identity_notes.md'),
      value: rewrittenIdentityNotes(identityNotes, move)
    });
  }
  return writes;
}

async function prepareCharacterManifestWrite(root, plan) {
  const manifestPath = path.join(root, 'content/characters/manifest.json');
  const manifest = await readJsonFile(manifestPath, 'character manifest');
  if (!Array.isArray(manifest)) throw new Error('character manifest must be an array');

  const byId = new Map();
  for (const entry of manifest) {
    const id = entry?.character_id;
    if (typeof id !== 'string' || !id) throw new Error('character manifest entry missing character_id');
    if (byId.has(id)) throw new Error(`duplicate character manifest entry: ${id}`);
    byId.set(id, entry);
  }

  const next = [];
  for (let index = 1; index <= Math.min(50, plan.new_count); index += 1) {
    const id = characterId(index);
    const entry = byId.get(id);
    if (!entry) throw new Error(`missing character manifest entry: ${id}`);
    next.push(entry);
  }
  const lina = byId.get('lina');
  if (!lina) throw new Error('missing character manifest entry: lina');
  next.push(lina);

  if (!jsonChanged(manifest, next)) return null;
  return { type: 'json', path: manifestPath, value: next };
}

function isUnderDeletedCharacterDirectory(fullPath, remap) {
  const parts = fullPath.split(path.sep);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === 'characters' && characterIdPattern.test(parts[index + 1])) {
      return remap.deleteSet.has(parts[index + 1]);
    }
  }
  return false;
}

function remapMutableFilePath(fullPath, remap) {
  const parts = fullPath.split(path.sep);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === 'characters' && characterIdPattern.test(parts[index + 1])) {
      const id = parts[index + 1];
      if (remap.deleteSet.has(id)) return null;
      if (remap.moveMap.has(id)) {
        const nextParts = [...parts];
        nextParts[index + 1] = remap.moveMap.get(id);
        return nextParts.join(path.sep);
      }
      return fullPath;
    }
  }
  return fullPath;
}

async function collectFiles(root) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  if (await isDirectory(root)) await walk(root);
  return files.sort();
}

async function prepareJsonRewrite(fullPath, targetPath, root, remap) {
  const value = await readJsonFile(fullPath, displayPath(root, fullPath));
  const next = transformJsonValue(value, remap);
  const finalValue = next === deletedValue ? null : next;
  if (targetPath !== fullPath || jsonChanged(value, finalValue)) {
    return { type: 'json', path: targetPath, value: finalValue };
  }
  return null;
}

async function prepareTextRewrite(fullPath, targetPath, root, remap) {
  const source = await readTextFile(fullPath, displayPath(root, fullPath));
  const next = transformTextValue(source, remap, displayPath(root, fullPath));
  if (targetPath !== fullPath || next !== source) return { type: 'text', path: targetPath, value: next };
  return null;
}

async function prepareDataWrites(root, plan) {
  const remap = createRemap(plan);
  const writes = [];
  const seedRuntimePath = path.join(root, 'data/seeds/game_data/runtime_state.json');
  const seedWrite = await prepareJsonRewrite(seedRuntimePath, seedRuntimePath, root, remap);
  if (seedWrite) writes.push(seedWrite);

  const mutableRoot = path.join(root, 'data/mutable/game_data');
  if (!await isDirectory(mutableRoot)) return writes;

  const files = await collectFiles(mutableRoot);
  const targetPaths = new Set(writes.map((write) => write.path));
  for (const file of files) {
    if (isUnderDeletedCharacterDirectory(file, remap)) continue;
    const targetPath = remapMutableFilePath(file, remap);
    if (!targetPath) continue;

    let write = null;
    if (file.endsWith('.json')) {
      write = await prepareJsonRewrite(file, targetPath, root, remap);
    } else if (file.endsWith('.md') && file.split(path.sep).includes('work_records')) {
      write = await prepareTextRewrite(file, targetPath, root, remap);
    }
    if (!write) continue;
    if (targetPaths.has(write.path)) throw new Error(`duplicate prepared write path: ${displayPath(root, write.path)}`);
    targetPaths.add(write.path);
    writes.push(write);
  }
  return writes;
}

async function collectMutableCharacterDirectoryAffected(root, plan) {
  const affected = new Set();
  for (const parent of await findMutableCharacterParents(root)) {
    for (const move of plan.moves) {
      const fromPath = path.join(parent, move.from);
      const toPath = path.join(parent, move.to);
      const hasFrom = await isDirectory(fromPath);
      const hasTo = await isDirectory(toPath);
      if (hasFrom) {
        affected.add(fromPath);
        affected.add(toPath);
      } else if (hasTo) {
        affected.add(toPath);
      }
    }
    for (const truncate of plan.truncates) {
      const truncatePath = path.join(parent, truncate.character_id);
      if (await isDirectory(truncatePath)) affected.add(truncatePath);
    }
  }
  return [...affected].sort();
}

async function collectDataAffectedFiles(root, plan) {
  const affected = new Set();
  for (const write of await prepareDataWrites(root, plan)) {
    affected.add(write.path);
  }
  for (const affectedDirectory of await collectMutableCharacterDirectoryAffected(root, plan)) {
    affected.add(affectedDirectory);
  }
  return [...affected].sort();
}

async function prepareApply(root, plan) {
  const writes = [];
  const catalogWrite = await prepareCatalogWrite(root, plan);
  if (catalogWrite) writes.push(catalogWrite);
  writes.push(...await prepareMovedContentWrites(root, plan));
  const manifestWrite = await prepareCharacterManifestWrite(root, plan);
  if (manifestWrite) writes.push(manifestWrite);
  writes.push(...await prepareDataWrites(root, plan));
  writes.push({
    type: 'json',
    path: path.join(root, plan.flags_path),
    value: { flagged: [] }
  });
  return { writes };
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function renameIfExists(fromPath, toPath) {
  if (!await pathExists(fromPath)) return;
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.rename(fromPath, toPath);
}

async function applyCharacterDirectoryMoves(parent, plan, { requireSources }) {
  if (!await isDirectory(parent)) {
    if (requireSources) throw new Error(`missing character directory parent: ${parent}`);
    return;
  }
  for (const move of plan.moves) await removeIfExists(path.join(parent, move.to));
  for (const truncate of plan.truncates) await removeIfExists(path.join(parent, truncate.character_id));
  for (const move of plan.moves) {
    const fromPath = path.join(parent, move.from);
    const toPath = path.join(parent, move.to);
    if (requireSources) await fs.rename(fromPath, toPath);
    else await renameIfExists(fromPath, toPath);
  }
}

async function applyVisualDirectoryMoves(root, plan) {
  const parent = path.join(root, 'assets/canonical/character_visual_sets');
  for (const move of plan.moves) await removeIfExists(path.join(parent, move.visual_to));
  for (const truncate of plan.truncates) await removeIfExists(path.join(parent, truncate.visual_set_id));
  for (const move of plan.moves) {
    await fs.rename(path.join(parent, move.visual_from), path.join(parent, move.visual_to));
  }
}

async function applySourceSheetMoves(root, plan) {
  for (const move of plan.moves) {
    const toPath = sourceImagePath(root, move.visual_to);
    const fromPath = sourceImagePath(root, move.visual_from);
    await removeIfExists(toPath);
    await renameIfExists(fromPath, toPath);
  }
  for (const truncate of plan.truncates) await removeIfExists(sourceImagePath(root, truncate.visual_set_id));
}

async function findMutableCharacterParents(root) {
  const parents = [];
  const directParent = path.join(root, 'data/mutable/game_data/characters');
  if (await isDirectory(directParent)) parents.push(directParent);

  const slotsRoot = path.join(root, 'data/mutable/game_data/play/slots');
  if (!await isDirectory(slotsRoot)) return parents;
  const slotEntries = await fs.readdir(slotsRoot, { withFileTypes: true });
  for (const entry of slotEntries) {
    if (!entry.isDirectory()) continue;
    const characterParent = path.join(slotsRoot, entry.name, 'game_data/characters');
    if (await isDirectory(characterParent)) parents.push(characterParent);
  }
  return parents;
}

async function applyPrepared(root, plan, prepared) {
  if (plan.deleted_ids.length === 0) {
    for (const write of prepared.writes) {
      if (write.type === 'json') await writeJsonFile(write.path, write.value);
      else await writeTextFile(write.path, write.value);
    }
    return;
  }

  await applyCharacterDirectoryMoves(path.join(root, 'content/characters'), plan, { requireSources: true });
  await applyVisualDirectoryMoves(root, plan);
  await applySourceSheetMoves(root, plan);
  for (const parent of await findMutableCharacterParents(root)) {
    await applyCharacterDirectoryMoves(parent, plan, { requireSources: false });
  }

  for (const write of prepared.writes) {
    if (write.type === 'json') await writeJsonFile(write.path, write.value);
    else await writeTextFile(write.path, write.value);
  }
}

export async function deleteFlaggedCharacters({ root, apply = false } = {}) {
  const plan = await createCharacterDeletionPlan({ root });
  if (!apply) return { applied: false, plan };
  if (plan.deleted_ids.length === 0) return { applied: true, plan };

  const resolvedRoot = resolveRoot(root);
  const prepared = await prepareApply(resolvedRoot, plan);
  await applyPrepared(resolvedRoot, plan, prepared);
  return { applied: true, plan };
}
