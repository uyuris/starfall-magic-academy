import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { assertValidSlotId, resolvePlayRoot } from './playSession.mjs';
import { writeRuntimePathsManifest } from './runtimeSlotBootstrap.mjs';

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;
const routingReadScopes = new AsyncLocalStorage();
const routingReadScopeRequirements = new AsyncLocalStorage();

let promotionEpoch = 0;

function assertValidConversationId(conversationId) {
  const normalized = String(conversationId ?? '').trim();
  if (!CONVERSATION_ID_PATTERN.test(normalized)) {
    const error = new Error(`invalid conversationId: ${conversationId}`);
    error.code = 'INVALID_CONVERSATION_ID';
    error.errorCode = 'invalid_conversation_id';
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function withTrailingSep(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

async function readJsonIfExists(fullPath) {
  try {
    return JSON.parse(await fs.readFile(fullPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function rootLooksLikePlayRoot(root) {
  const resolved = path.resolve(root);
  return existsSync(path.join(resolved, 'active_slot.json')) || existsSync(path.join(resolved, 'slots'));
}

function rootLooksLikeSlotRoot(root) {
  const resolved = path.resolve(root);
  return path.basename(path.dirname(resolved)) === 'slots' && /^slot_[A-Za-z0-9_-]+$/.test(path.basename(resolved));
}

export function resolveFinalizeStagingRoot(root) {
  const resolved = path.resolve(root);
  if (rootLooksLikePlayRoot(resolved)) return path.join(resolved, 'finalize_staging');
  if (rootLooksLikeSlotRoot(resolved)) return path.join(path.dirname(path.dirname(resolved)), 'finalize_staging');
  return path.join(resolvePlayRoot(resolved), 'finalize_staging');
}

export function resolveSlotFinalizeStagingRoot(root, slotId) {
  return path.join(resolveFinalizeStagingRoot(root), assertValidSlotId(slotId));
}

export function resolveFinalizeStagingDir(root, slotId, conversationId) {
  return path.join(resolveSlotFinalizeStagingRoot(root, slotId), assertValidConversationId(conversationId));
}

function promotingSentinelPath(stagingDir) {
  return path.join(stagingDir, 'promoting');
}

async function readActiveSlotIdFromPlayRoot(playRoot) {
  const active = await readJsonIfExists(path.join(playRoot, 'active_slot.json'));
  const slotId = String(active?.slot_id ?? '').trim();
  return slotId ? assertValidSlotId(slotId) : null;
}

async function resolvePlayContext(root, explicitSlotId = null) {
  const resolved = path.resolve(root);
  if (rootLooksLikeSlotRoot(resolved)) {
    return {
      playRoot: path.dirname(path.dirname(resolved)),
      slotId: assertValidSlotId(explicitSlotId ?? path.basename(resolved))
    };
  }
  const playRoot = rootLooksLikePlayRoot(resolved) ? resolved : resolvePlayRoot(resolved);
  const slotId = explicitSlotId ? assertValidSlotId(explicitSlotId) : await readActiveSlotIdFromPlayRoot(playRoot);
  if (!slotId) throw new Error(`active slot is required for routing finalize queue: ${root}`);
  return { playRoot, slotId };
}

export function routingReadRaceError() {
  const error = new Error('routing read raced an in-flight finalize promotion; retry the request');
  error.code = 'ROUTING_READ_RACED_FINALIZE';
  error.errorCode = 'routing_read_raced_finalize';
  error.statusCode = 409;
  error.retryable = true;
  return error;
}

export function routingReadScopeRequiredError() {
  const error = new Error('routing mutable read requires an active routing read scope');
  error.code = 'ROUTING_READ_SCOPE_REQUIRED';
  error.errorCode = 'routing_read_scope_required';
  error.statusCode = 500;
  return error;
}

export function advancePromotionEpochForRoutingFinalize() {
  promotionEpoch += 1;
  return promotionEpoch;
}

export function getPromotionEpochForRoutingFinalize() {
  return promotionEpoch;
}

export async function hasPromotingSentinel({ root, slotId }) {
  const { playRoot, slotId: resolvedSlotId } = await resolvePlayContext(root, slotId);
  const slotStagingRoot = resolveSlotFinalizeStagingRoot(playRoot, resolvedSlotId);
  let entries;
  try {
    entries = await fs.readdir(slotStagingRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await pathExists(promotingSentinelPath(path.join(slotStagingRoot, entry.name)))) return true;
  }
  return false;
}

export async function hasAnyPromotingSentinel({ root }) {
  const stagingRoot = resolveFinalizeStagingRoot(root);
  let slotEntries;
  try {
    slotEntries = await fs.readdir(stagingRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const slotEntry of slotEntries) {
    if (!slotEntry.isDirectory()) continue;
    const slotStagingRoot = path.join(stagingRoot, slotEntry.name);
    const conversationEntries = await fs.readdir(slotStagingRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const conversationEntry of conversationEntries) {
      if (!conversationEntry.isDirectory()) continue;
      if (await pathExists(promotingSentinelPath(path.join(slotStagingRoot, conversationEntry.name)))) return true;
    }
  }
  return false;
}

export async function runRoutingReadScope({ root, slotId = null }, callback) {
  if (typeof callback !== 'function') throw new Error('routing read scope callback is required');
  const context = await resolvePlayContext(root, slotId);
  return routingReadScopes.run({ ...context, baselineEpoch: null }, callback);
}

export async function runRoutingReadScopeIfActive({ root, slotId = null }, callback) {
  if (typeof callback !== 'function') throw new Error('routing read scope callback is required');
  let context;
  try {
    context = await resolvePlayContext(root, slotId);
  } catch (error) {
    if (/active slot is required/.test(error?.message ?? '')) return await callback();
    throw error;
  }
  return routingReadScopes.run({ ...context, baselineEpoch: null }, callback);
}

export async function runRoutingReadScopeWithRecoveryIfActive({ root, slotId = null }, callback) {
  if (typeof callback !== 'function') throw new Error('routing read scope callback is required');
  let context;
  try {
    context = await resolvePlayContext(root, slotId);
  } catch (error) {
    if (/active slot is required/.test(error?.message ?? '')) return await callback();
    throw error;
  }
  await recoverPromotingFinalizations({ root: context.playRoot, slotId: context.slotId });
  return routingReadScopes.run({ ...context, baselineEpoch: null }, callback);
}

export function runRoutingReadScopeRequired(callback) {
  if (typeof callback !== 'function') throw new Error('routing read scope requirement callback is required');
  return routingReadScopeRequirements.run({ required: true }, callback);
}

export function runOutsideRoutingReadScope(callback) {
  if (typeof callback !== 'function') throw new Error('routing read scope exit callback is required');
  return routingReadScopes.exit(() => routingReadScopeRequirements.exit(callback));
}

function currentRoutingReadScope() {
  return routingReadScopes.getStore() ?? null;
}

function isRoutingReadScopeRequired() {
  return routingReadScopeRequirements.getStore()?.required === true;
}

export function isMutableRoutingReadPath({ fullPath, storagePaths }) {
  const resolvedPath = path.resolve(fullPath);
  const mutableRoot = path.resolve(storagePaths.mutableRoot);
  return resolvedPath === mutableRoot || resolvedPath.startsWith(withTrailingSep(mutableRoot));
}

async function assertRoutingReadFence({ fullPath, storagePaths, phase, requireScope = false }) {
  if (!isMutableRoutingReadPath({ fullPath, storagePaths })) return;
  const scope = currentRoutingReadScope();
  if (!scope) {
    if (requireScope || isRoutingReadScopeRequired()) throw routingReadScopeRequiredError();
    return;
  }
  if (await hasPromotingSentinel({ root: scope.playRoot, slotId: scope.slotId })) throw routingReadRaceError();
  if (scope.baselineEpoch == null) {
    if (phase !== 'pre') throw routingReadRaceError();
    scope.baselineEpoch = promotionEpoch;
  }
  if (promotionEpoch !== scope.baselineEpoch) throw routingReadRaceError();
}

export async function routingReadPreFence(args) {
  await assertRoutingReadFence({ ...args, phase: 'pre' });
}

export async function routingReadPostFence(args) {
  await assertRoutingReadFence({ ...args, phase: 'post' });
}

function pendingFinalizationsStateError() {
  const error = new Error('runtime_state.pending_finalizations must be an array when present');
  error.code = 'INVALID_PENDING_FINALIZATIONS';
  error.errorCode = 'invalid_pending_finalizations';
  error.statusCode = 500;
  return error;
}

function pendingFinalizationRecordError(message) {
  const error = new Error(message);
  error.code = 'INVALID_PENDING_FINALIZATIONS';
  error.errorCode = 'invalid_pending_finalizations';
  error.statusCode = 500;
  return error;
}

function readPendingFinalizationsFromState(state) {
  if (!Object.prototype.hasOwnProperty.call(state, 'pending_finalizations')) return [];
  if (!Array.isArray(state.pending_finalizations)) throw pendingFinalizationsStateError();
  return state.pending_finalizations;
}

function normalizeExistingPendingFinalizationRecord(job) {
  const conversationId = assertValidConversationId(job?.conversation_id);
  const characterId = String(job?.character_id ?? '').trim();
  if (!characterId) throw pendingFinalizationRecordError('pending finalization character_id is required');
  const enqueuedAt = String(job?.enqueued_at ?? '').trim();
  if (!enqueuedAt) throw pendingFinalizationRecordError('pending finalization enqueued_at is required');
  const status = String(job?.status ?? '').trim();
  if (status !== 'pending' && status !== 'failed') {
    throw pendingFinalizationRecordError(`pending finalization status must be pending or failed: ${status}`);
  }
  const attempts = Number(job?.attempts);
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw pendingFinalizationRecordError(`pending finalization attempts must be a non-negative integer: ${job?.attempts}`);
  }
  return {
    ...job,
    conversation_id: conversationId,
    character_id: characterId,
    enqueued_at: enqueuedAt,
    status,
    attempts
  };
}

export function listDrainablePendingFinalizations(state) {
  const blockedCharacters = new Set();
  const drainable = [];
  for (const job of readPendingFinalizationsFromState(state)) {
    const normalizedJob = normalizeExistingPendingFinalizationRecord(job);
    if (normalizedJob.status === 'failed') {
      blockedCharacters.add(normalizedJob.character_id);
      continue;
    }
    if (!blockedCharacters.has(normalizedJob.character_id)) drainable.push(normalizedJob);
  }
  return drainable;
}

export function selectNextPendingFinalizationForDrain(state) {
  return listDrainablePendingFinalizations(state)[0] ?? null;
}

function normalizePendingFinalizationCharacterId(characterId) {
  const normalized = String(characterId ?? '').trim();
  if (!normalized) throw pendingFinalizationRecordError('pending finalization character_id is required');
  return normalized;
}

export function selectRetryableFailedPendingFinalizationForCharacter(state, characterId) {
  const normalizedCharacterId = normalizePendingFinalizationCharacterId(characterId);
  for (const job of readPendingFinalizationsFromState(state)) {
    const normalizedJob = normalizeExistingPendingFinalizationRecord(job);
    if (normalizedJob.character_id !== normalizedCharacterId) continue;
    return normalizedJob.status === 'failed' ? normalizedJob : null;
  }
  return null;
}

function normalizePendingFinalizationJob(job) {
  const conversationId = assertValidConversationId(job?.conversation_id);
  const characterId = String(job?.character_id ?? '').trim();
  if (!characterId) throw new Error('pending finalization character_id is required');
  const enqueuedAt = String(job?.enqueued_at ?? '').trim();
  if (!enqueuedAt) throw new Error('pending finalization enqueued_at is required');
  if (Object.prototype.hasOwnProperty.call(job ?? {}, 'attempts')) {
    throw pendingFinalizationRecordError('pending finalization attempts is managed internally');
  }
  return {
    conversation_id: conversationId,
    character_id: characterId,
    enqueued_at: enqueuedAt,
    status: 'pending',
    attempts: 0
  };
}

export async function enqueuePendingFinalization({ root, job }) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const state = await storage.readJson('game_data/runtime_state.json');
  const next = enqueuePendingFinalizationInState(state, job);
  if (next === state) return state;
  await storage.writeJson('game_data/runtime_state.json', next);
  return next;
}

export function enqueuePendingFinalizationInState(state, job) {
  const pending = readPendingFinalizationsFromState(state).map((pendingJob) => normalizeExistingPendingFinalizationRecord(pendingJob));
  const normalizedJob = normalizePendingFinalizationJob(job);
  if (pending.some((pendingJob) => pendingJob.conversation_id === normalizedJob.conversation_id)) return state;
  return {
    ...state,
    pending_finalizations: [...pending, normalizedJob]
  };
}

function pendingFinalizationDrainError(message) {
  const error = pendingFinalizationRecordError(message);
  error.retryable = true;
  return error;
}

function pendingFinalizationErrorPayload(error) {
  return {
    message: String(error?.message ?? error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.errorCode ? { error_code: error.errorCode } : {}),
    ...(error?.stack ? { stack: error.stack } : {})
  };
}

function pendingFinalizationMatches(left, right) {
  return normalizeExistingPendingFinalizationRecord(left).conversation_id === right.conversation_id;
}

async function removePendingFinalizationJob({ root, job }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson('game_data/runtime_state.json');
  const pending = readPendingFinalizationsFromState(state).map((pendingJob) => normalizeExistingPendingFinalizationRecord(pendingJob));
  const nextPending = pending.filter((pendingJob) => !pendingFinalizationMatches(pendingJob, job));
  const next = {
    ...state,
    pending_finalizations: nextPending
  };
  await storage.writeJson('game_data/runtime_state.json', next);
  return next;
}

async function markPendingFinalizationFailed({ root, job, error }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson('game_data/runtime_state.json');
  const pending = readPendingFinalizationsFromState(state).map((pendingJob) => normalizeExistingPendingFinalizationRecord(pendingJob));
  let matched = false;
  const nextPending = pending.map((pendingJob) => {
    if (!pendingFinalizationMatches(pendingJob, job)) return pendingJob;
    matched = true;
    return {
      ...pendingJob,
      status: 'failed',
      attempts: pendingJob.attempts + 1,
      failed_at: new Date().toISOString(),
      error: pendingFinalizationErrorPayload(error)
    };
  });
  if (!matched) return state;
  const next = {
    ...state,
    pending_finalizations: nextPending
  };
  await storage.writeJson('game_data/runtime_state.json', next);
  return next;
}

export function preparePendingFinalizationRetryInState(state, job) {
  const selectedJob = normalizeExistingPendingFinalizationRecord(job);
  if (selectedJob.status !== 'failed') {
    throw pendingFinalizationDrainError(`pending finalization changed before retry prepare: ${selectedJob.conversation_id}`);
  }
  const pending = readPendingFinalizationsFromState(state).map((pendingJob) => normalizeExistingPendingFinalizationRecord(pendingJob));
  let retryJob = null;
  for (const pendingJob of pending) {
    if (!pendingFinalizationMatches(pendingJob, selectedJob)) continue;
    if (pendingJob.status !== 'failed') break;
    const { failed_at: _failedAt, error: _error, ...rest } = pendingJob;
    retryJob = {
      ...rest,
      status: 'pending',
      retry_started_at: new Date().toISOString()
    };
    break;
  }
  if (!retryJob) {
    throw pendingFinalizationDrainError(`pending finalization changed before retry prepare: ${selectedJob.conversation_id}`);
  }
  return { job: retryJob, state };
}

async function drainPendingFinalizationJob({ root, job, finalizeJob }) {
  try {
    const finalization = await finalizeJob(job);
    const state = await removePendingFinalizationJob({ root, job });
    return { job, finalization, state };
  } catch (error) {
    await markPendingFinalizationFailed({ root, job, error });
    throw error;
  }
}

export async function retryPendingFinalizationForCharacter({ root, characterId, finalizeJob }) {
  if (!root) throw new Error('root is required');
  if (typeof finalizeJob !== 'function') throw new Error('pending finalization retry finalizeJob is required');
  const normalizedCharacterId = normalizePendingFinalizationCharacterId(characterId);
  return await runOutsideRoutingReadScope(async () => {
    const storage = createStorageApi({ root });
    const state = await storage.readJson('game_data/runtime_state.json');
    const retryCandidate = selectRetryableFailedPendingFinalizationForCharacter(state, normalizedCharacterId);
    if (!retryCandidate) return { retried: null, drained: [], state };
    const retried = preparePendingFinalizationRetryInState(state, retryCandidate);
    const drained = await drainPendingFinalizationJob({ root, job: retried.job, finalizeJob });
    return { retried: retried.job, drained: [drained], state: drained.state };
  });
}

export async function drainAllPendingFinalizations({ root, finalizeJob }) {
  if (!root) throw new Error('root is required');
  if (typeof finalizeJob !== 'function') throw new Error('pending finalization drain finalizeJob is required');
  return await runOutsideRoutingReadScope(async () => {
    const drained = [];
    while (true) {
      const storage = createStorageApi({ root });
      const state = await storage.readJson('game_data/runtime_state.json');
      const pending = readPendingFinalizationsFromState(state).map((job) => normalizeExistingPendingFinalizationRecord(job));
      if (pending.length === 0) return { drained, state };
      const job = selectNextPendingFinalizationForDrain(state);
      if (!job) {
        throw pendingFinalizationDrainError('pending finalizations are blocked by failed jobs');
      }
      const drainedEntry = await drainPendingFinalizationJob({ root, job, finalizeJob });
      const nextState = drainedEntry.state;
      drained.push({ job: drainedEntry.job, finalization: drainedEntry.finalization });
      if (readPendingFinalizationsFromState(nextState).length === 0) return { drained, state: nextState };
    }
  });
}

async function writeFileAtomic(fullPath, bytes) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const tempPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, fullPath);
}

async function copyFileAtomic(sourcePath, targetPath) {
  await writeFileAtomic(targetPath, await fs.readFile(sourcePath));
}

async function readDirectoryEntriesOrEmpty(targetRoot) {
  try {
    return await fs.readdir(targetRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function mirrorDirectoryFilesAtomic(sourceRoot, targetRoot) {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const sourceNames = new Set(entries.map((entry) => entry.name));
  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      const targetStat = await fs.lstat(targetPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (targetStat && !targetStat.isDirectory()) await fs.rm(targetPath, { recursive: true, force: true });
      await mirrorDirectoryFilesAtomic(sourcePath, targetPath);
    } else if (entry.isFile()) {
      const targetStat = await fs.lstat(targetPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (targetStat?.isDirectory()) await fs.rm(targetPath, { recursive: true, force: true });
      await copyFileAtomic(sourcePath, targetPath);
    } else {
      throw new Error(`unsupported finalize staging entry type: ${sourcePath}`);
    }
  }
  for (const targetEntry of await readDirectoryEntriesOrEmpty(targetRoot)) {
    if (!sourceNames.has(targetEntry.name)) {
      await fs.rm(path.join(targetRoot, targetEntry.name), { recursive: true, force: true });
    }
  }
}

function preserveScreenOwnership(state, liveState) {
  return {
    ...state,
    current_screen: liveState.current_screen ?? null,
    current_interaction_character_id: liveState.current_interaction_character_id ?? null,
    pending_interaction_context: liveState.pending_interaction_context ?? null
  };
}

export async function runAtomicFinalizationWithStaging({
  root,
  conversationId,
  finalStateTransform = null,
  finalizer
}) {
  if (!root) throw new Error('root is required');
  const normalizedConversationId = assertValidConversationId(conversationId);
  if (typeof finalizer !== 'function') throw new Error('atomic finalizer is required');

  const liveStorage = createStorageApi({ root });
  const liveMutableRoot = liveStorage.paths.mutableRoot;
  const slotProjectRoot = path.dirname(liveMutableRoot);
  const slotId = assertValidSlotId(path.basename(slotProjectRoot));
  const playRoot = path.dirname(path.dirname(slotProjectRoot));
  const stagingDir = resolveFinalizeStagingDir(playRoot, slotId, normalizedConversationId);
  const workspaceRoot = path.join(stagingDir, 'workspace');
  if (await pathExists(stagingDir)) throw new Error(`finalize staging already exists: ${stagingDir}`);

  const liveState = await liveStorage.readJson('game_data/runtime_state.json');
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    await fs.cp(slotProjectRoot, workspaceRoot, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
    await writeRuntimePathsManifest({ root: workspaceRoot, sourceRoot: root, mutableRoot: path.join(workspaceRoot, 'game_data') });
    const result = await finalizer({
      root: workspaceRoot,
      finalStateTransform: (state) => {
        const transformed = typeof finalStateTransform === 'function' ? finalStateTransform(state) : state;
        return preserveScreenOwnership(transformed, liveState);
      }
    });

    await writeFileAtomic(promotingSentinelPath(stagingDir), '1\n');
    await mirrorDirectoryFilesAtomic(path.join(workspaceRoot, 'game_data'), liveMutableRoot);
    advancePromotionEpochForRoutingFinalize();
    await fs.rm(stagingDir, { recursive: true, force: true });

    const promotedState = await liveStorage.readJson('game_data/runtime_state.json');
    const promotedConversation = await liveStorage.readJsonIfExists(`game_data/logs/conversations/${normalizedConversationId}.json`);
    return {
      ...result,
      finalization_status: 'completed',
      state: promotedState,
      conversation: promotedConversation ?? result?.conversation ?? null
    };
  } catch (error) {
    if (!(await pathExists(promotingSentinelPath(stagingDir)))) {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function recoverPromotingFinalizations({ root, slotId = null }) {
  const { playRoot, slotId: resolvedSlotId } = await resolvePlayContext(root, slotId);
  const slotStagingRoot = resolveSlotFinalizeStagingRoot(playRoot, resolvedSlotId);
  const liveMutableRoot = path.join(playRoot, 'slots', resolvedSlotId, 'game_data');
  let entries;
  try {
    entries = await fs.readdir(slotStagingRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const recovered = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stagingDir = path.join(slotStagingRoot, entry.name);
    if (!(await pathExists(promotingSentinelPath(stagingDir)))) continue;
    const workspaceGameData = path.join(stagingDir, 'workspace/game_data');
    await mirrorDirectoryFilesAtomic(workspaceGameData, liveMutableRoot);
    advancePromotionEpochForRoutingFinalize();
    await fs.rm(stagingDir, { recursive: true, force: true });
    recovered.push(entry.name);
  }
  return recovered;
}
