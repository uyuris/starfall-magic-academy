import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createStorageApi } from './storage.mjs';
import { runtimePathsManifestFilename } from './runtimePaths.mjs';
import { validateRoutingPersonaVariant } from './playMode.mjs';
import { isInFlightGraduationPhase2 } from './graduationEnding.mjs';
import { ensureCharacterMutableSurface, resetSlotGameDataRoot, writeRuntimePathsManifest } from './runtimeSlotBootstrap.mjs';
import {
  assertValidSlotId,
  assertValidSlotActivePlayMode,
  normalizeSlotActivePlayModeForRead,
  initializeNewPlayArea,
  isValidSlot,
  listValidSlotIds,
  readActiveSlot,
  readValidActiveSlotId,
  readSlotMeta,
  refreshSlotMetaFromRuntime,
  resolvePlayRoot,
  resolveSlotProjectRoot,
  setActiveSlot,
  writeSlotMeta
} from './playSession.mjs';
import { resolveSlotFinalizeStagingRoot } from './routingFinalizeQueue.mjs';

async function readJson(fullPath) {
  return JSON.parse(await fs.readFile(fullPath, 'utf8'));
}

async function writeJson(fullPath, value) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const SAVE_SLOT_NOTE_MAX_LENGTH = 2000;

function normalizeSaveSlotPlayerNote(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, SAVE_SLOT_NOTE_MAX_LENGTH);
}

function slotLabelFor(slotId) {
  return slotId.replaceAll('_', ' ');
}

function activeGameDataLink(root) {
  return path.join(resolvePlayRoot(root), 'game_data');
}

function activeSlotFile(root) {
  return path.join(resolvePlayRoot(root), 'active_slot.json');
}

async function activeSlotId(root) {
  const active = await readActiveSlot(root);
  return String(active?.slot_id ?? '').trim() || null;
}

async function activeSlotRoot(root) {
  const slotId = await activeSlotId(root);
  return slotId ? resolveSlotProjectRoot(root, slotId) : null;
}

async function cloneDirectory(sourcePath, targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
}

async function cloneCanonicalCharacterDataToSlotRoot(root, targetRoot) {
  const storage = createStorageApi({ root });
  const sourceCharactersRoot = storage.paths.characterContentRoot;
  const sourceMutableCharactersRoot = path.join(storage.paths.mutableRoot, 'characters');
  const entries = await fs.readdir(sourceCharactersRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceCharacterDir = path.join(sourceCharactersRoot, entry.name);
    const profilePath = path.join(sourceCharacterDir, 'profile.json');
    if (!(await pathExists(profilePath))) continue;
    const mutableCharacterDir = path.join(sourceMutableCharactersRoot, entry.name);
    const targetCharacterDir = path.join(targetRoot, 'game_data/characters', entry.name);
    await ensureCharacterMutableSurface({ root: targetRoot, characterId: entry.name });

    for (const filename of ['skills.json', 'flags.json', 'affinity.json']) {
      const sourcePath = path.join(mutableCharacterDir, filename);
      if (await pathExists(sourcePath)) {
        await fs.cp(sourcePath, path.join(targetCharacterDir, filename), { force: true, verbatimSymlinks: true });
      }
    }

    for (const dirname of ['memory', 'work_records']) {
      const sourcePath = path.join(mutableCharacterDir, dirname);
      if (await pathExists(sourcePath)) {
        await fs.cp(sourcePath, path.join(targetCharacterDir, dirname), { recursive: true, force: true, verbatimSymlinks: true });
      }
    }
  }
}

async function cloneCanonicalGameDataToSlotRoot(root, targetRoot) {
  const storage = createStorageApi({ root });
  const targetGameDataRoot = path.join(targetRoot, 'game_data');
  await resetSlotGameDataRoot(targetRoot);
  await writeRuntimePathsManifest({ root: targetRoot, sourceRoot: root, mutableRoot: targetGameDataRoot });

  for (const relativePath of ['game_data/runtime_state.json', 'game_data/player_inventory.json', 'game_data/player_equipment.json', 'game_data/library_collection.json', 'game_data/homunculi.json', 'game_data/star_cradle.json', 'game_data/star_cradle_creatures.json', 'game_data/gathering_stock.json', 'game_data/mp_reserve.json', 'game_data/runtime/player_parameters.json']) {
    const value = await storage.readJsonIfExists(relativePath);
    if (value != null) await writeJson(path.join(targetRoot, relativePath), value);
  }

  const logsSource = path.join(storage.paths.mutableRoot, 'logs');
  if (await pathExists(logsSource)) {
    await fs.cp(logsSource, path.join(targetGameDataRoot, 'logs'), { recursive: true, force: true, verbatimSymlinks: true });
  }

  await cloneCanonicalCharacterDataToSlotRoot(root, targetRoot);
}

async function readRuntimeStateForSlot(root, slotId) {
  return await readJson(path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json'));
}

// Read a slot's runtime_state for entry-contract resolution (the load/slots screen routing reads it to decide
// whether the slot is mid graduation phase 2). Validates the slot id and existence with the same fail-fast the
// other slot-scoped reads use; never returns a default state.
export async function readSaveSlotRuntimeState({ root, slotId }) {
  if (!root) throw new Error('root is required');
  if (!slotId) throw new Error('slotId is required');
  const normalizedSlotId = assertValidSlotId(slotId);
  if (!(await isValidSlot(root, normalizedSlotId))) throw invalidSlotError(normalizedSlotId);
  return await readRuntimeStateForSlot(root, normalizedSlotId);
}

async function updateRuntimeStateForSlot(root, slotId, updater) {
  const statePath = path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json');
  const current = await readJson(statePath);
  const next = updater(current);
  await writeJson(statePath, next);
  return next;
}

function slotSummary(meta) {
  const slotId = meta.slot_id;
  // Slot listing is a pure read: a stale out-of-closed-set variant is surfaced raw (read-tolerant), so
  // an existing save with a pre-replacement persona still lists rather than 400-ing the whole list.
  const activePlayMode = normalizeSlotActivePlayModeForRead({
    playMode: meta.play_mode,
    routingPersonaVariant: meta.routing_persona_variant
  }, slotId);
  return {
    slot_id: slotId,
    label: meta.label,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    player_note: meta.player_note ?? '',
    current_location_id: meta.current_location_id ?? null,
    current_screen: meta.current_screen ?? null,
    graduation_completed: meta.graduation_completed === true,
    play_mode: activePlayMode.mode,
    ...(activePlayMode.routing_persona_variant ? { routing_persona_variant: activePlayMode.routing_persona_variant } : {})
  };
}

async function readGraduationCompletedForSlot(root, slotId) {
  const state = await readRuntimeStateForSlot(root, slotId).catch(() => null);
  return state?.ending_completed === true;
}

function invalidSlotError(slotId) {
  const error = new Error(`invalid slot: ${slotId}`);
  error.code = 'INVALID_SLOT';
  error.errorCode = 'invalid_slot';
  error.statusCode = 400;
  return error;
}

async function assertSlotCanBeLoaded(root, slotId) {
  const normalizedSlotId = assertValidSlotId(slotId);
  if (!(await isValidSlot(root, normalizedSlotId))) throw invalidSlotError(normalizedSlotId);
  await readSaveSlotPlayMode({ root, slotId: normalizedSlotId });
  if (await readGraduationCompletedForSlot(root, normalizedSlotId)) {
    const error = new Error('graduation_completed: slot is already graduated');
    error.code = 'GRADUATION_COMPLETED';
    throw error;
  }
}

export async function readSaveSlotActivePlayMode({ root, slotId }) {
  if (!root) throw new Error('root is required');
  if (!slotId) throw new Error('slotId is required');
  const normalizedSlotId = assertValidSlotId(slotId);
  if (!(await isValidSlot(root, normalizedSlotId))) throw invalidSlotError(normalizedSlotId);
  const meta = await readSlotMeta(root, normalizedSlotId);
  // Dispatch/load read the active slot's play mode on every request: a stale out-of-closed-set variant is
  // carried through raw (read-tolerant) so server boot, GET /, settings, and load are not bricked. The
  // stale variant fails fast only when a routing operation builds the persona, and is recoverable by
  // re-selection.
  return normalizeSlotActivePlayModeForRead({
    playMode: meta?.play_mode,
    routingPersonaVariant: meta?.routing_persona_variant
  }, normalizedSlotId);
}

export async function readSaveSlotPlayMode({ root, slotId }) {
  return (await readSaveSlotActivePlayMode({ root, slotId })).mode;
}

// Explicit slot-scoped re-selection: update the ACTIVE routing save slot's persona variant. This is the
// save-side switch, kept distinct from the global play-mode sidecar (which stays a new-game default only,
// applied at game start). It lets an existing save whose persisted variant fell out of the closed set
// become playable again once the player re-selects for that save. The variant is validated against the
// closed set (strict — an out-of-set value throws, mapped to 400 by the route). The target must be an
// ACTIVE routing slot: no active slot, or a non-routing active slot, is an explicit error (409), never a
// silent no-op. Never maps / aliases / silent-rewrites; idempotent when the slot already holds the variant.
// Returns { slot_id, routing_persona_variant }.
export async function updateActiveRoutingSlotPersonaVariant({ root, routingPersonaVariant }) {
  if (!root) throw new Error('root is required');
  const variant = validateRoutingPersonaVariant(routingPersonaVariant);
  const slotId = await readValidActiveSlotId(root);
  if (!slotId) {
    const error = new Error('no active save slot to update the routing persona for');
    error.statusCode = 409;
    error.errorCode = 'no_active_slot';
    throw error;
  }
  const meta = await readSlotMeta(root, slotId);
  if (!meta || meta.play_mode !== 'routing') {
    const error = new Error('the active save slot is not in routing mode');
    error.statusCode = 409;
    error.errorCode = 'active_slot_not_routing';
    throw error;
  }
  if (meta.routing_persona_variant !== variant) {
    await writeSlotMeta(root, slotId, {
      ...meta,
      routing_persona_variant: variant,
      updated_at: new Date().toISOString()
    });
  }
  return { slot_id: slotId, routing_persona_variant: variant };
}

export async function createSaveSlot({ root, slotId, label, playMode, routingPersonaVariant, now = new Date().toISOString() }) {
  if (!root) throw new Error('root is required');
  if (!slotId) throw new Error('slotId is required');
  const normalizedSlotId = assertValidSlotId(slotId);
  const activePlayMode = assertValidSlotActivePlayMode({ playMode, routingPersonaVariant }, normalizedSlotId);

  const sourceRoot = await activeSlotRoot(root);

  const targetRoot = resolveSlotProjectRoot(root, normalizedSlotId);
  if (await pathExists(targetRoot)) throw new Error(`slot already exists: ${normalizedSlotId}`);
  if (sourceRoot) {
    await cloneDirectory(sourceRoot, targetRoot);
    await writeRuntimePathsManifest({ root: targetRoot, sourceRoot: root, mutableRoot: path.join(targetRoot, 'game_data') });
  } else await cloneCanonicalGameDataToSlotRoot(root, targetRoot);
  const state = await readJson(path.join(targetRoot, 'game_data/runtime_state.json'));
  const meta = {
    slot_id: normalizedSlotId,
    label: label ?? slotLabelFor(normalizedSlotId),
    created_at: now,
    updated_at: now,
    player_note: '',
    current_location_id: state.current_location_id ?? null,
    current_screen: state.current_screen ?? null,
    play_mode: activePlayMode.mode,
    ...(activePlayMode.routing_persona_variant ? { routing_persona_variant: activePlayMode.routing_persona_variant } : {})
  };
  await writeSlotMeta(root, normalizedSlotId, meta);
  return {
    slot_id: normalizedSlotId,
    label: meta.label,
    created_at: meta.created_at,
    snapshot: {
      runtime_state: state,
      logs_embedded: false
    },
    slot: meta,
    state
  };
}

export async function loadSaveSlot({ root, slotId, postLoadScreen = 'academy-room' }) {
  if (!root) throw new Error('root is required');
  if (!slotId) throw new Error('slotId is required');
  await assertSlotCanBeLoaded(root, slotId);

  const state = await updateRuntimeStateForSlot(root, slotId, (current) => {
    // An in-flight graduation phase 2 (ending) conversation is re-entered live from a slot load: its
    // conversation entry state (actor / pending event context / active conversation / persisted screen) is
    // preserved instead of wiped to the post-content landing, so the ending resumes in place rather than
    // restarting the graduation flow after the following action. Every other load lands on the resolved
    // post-content screen with the interaction context cleared (byte-equivalent to the prior behavior).
    if (isInFlightGraduationPhase2(current)) return current;
    return {
      ...current,
      current_screen: postLoadScreen,
      current_interaction_character_id: null,
      pending_interaction_context: null
    };
  });
  await setActiveSlot(root, slotId);
  const meta = await refreshSlotMetaFromRuntime(root, slotId);
  return {
    slot: meta,
    state,
    runtime_state: state,
    root: resolvePlayRoot(root)
  };
}

export async function listSaveSlots({ root }) {
  if (!root) throw new Error('root is required');
  const slots = [];
  for (const slotId of await listValidSlotIds(root)) {
    const meta = await readSlotMeta(root, slotId);
    if (!meta) continue;
    slots.push(slotSummary({
      ...meta,
      graduation_completed: await readGraduationCompletedForSlot(root, slotId)
    }));
  }
  slots.sort((a, b) => {
    const left = `${a.created_at ?? ''}:${a.slot_id}`;
    const right = `${b.created_at ?? ''}:${b.slot_id}`;
    return left.localeCompare(right);
  });
  return slots;
}

export async function describeSaveSlots({ root }) {
  if (!root) throw new Error('root is required');
  return {
    slots: await listSaveSlots({ root }),
    active_slot_id: await readValidActiveSlotId(root)
  };
}

export async function updateSaveSlotNote({ root, slotId, playerNote, now = new Date().toISOString() }) {
  if (!root) throw new Error('root is required');
  if (!slotId) throw new Error('slotId is required');
  if (!(await isValidSlot(root, slotId))) throw invalidSlotError(slotId);
  const existingMeta = await readSlotMeta(root, slotId) ?? await refreshSlotMetaFromRuntime(root, slotId);
  const nextMeta = {
    ...existingMeta,
    slot_id: slotId,
    label: existingMeta?.label ?? slotLabelFor(slotId),
    created_at: existingMeta?.created_at ?? now,
    updated_at: now,
    player_note: normalizeSaveSlotPlayerNote(playerNote)
  };
  await writeSlotMeta(root, slotId, nextMeta);
  return slotSummary(nextMeta);
}

export async function deleteSaveSlot({ root, slotId }) {
  if (!root) throw new Error('root is required');
  if (!slotId) throw new Error('slotId is required');
  if (!(await isValidSlot(root, slotId))) throw invalidSlotError(slotId);
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  const activeId = await readValidActiveSlotId(root);
  await fs.rm(slotRoot, { recursive: true, force: true });
  await fs.rm(resolveSlotFinalizeStagingRoot(root, slotId), { recursive: true, force: true });

  if (activeId === slotId) {
    await fs.rm(activeGameDataLink(root), { recursive: true, force: true });
    await fs.rm(path.join(resolvePlayRoot(root), runtimePathsManifestFilename), { force: true });
    await fs.rm(activeSlotFile(root), { force: true });
  }

  return {
    deleted_slot_id: slotId,
    active_slot_id: activeId === slotId ? null : activeId,
    slots: await listSaveSlots({ root })
  };
}
