// Save cleanup for the removed fixed-week-event mechanism.
//
// The fixed week event (W10/20/30/40/47 forced destination) is gone. A save made while that mechanism existed
// can still carry its residue. Most of it is inert after removal (an unread runtime_state key, a diary memory
// the reader passes through, an orphan idempotency ledger entry), but two pieces are load-blocking:
//   - runtime_state.last_routing_content_result of kind 'week_event' — readRoutingContentResult fail-fasts on
//     the now-unknown kind, so the routing hub cannot build its context.
//   - runtime_state.current_screen 'academy-week-event' — the arrival screen no longer exists, so a save
//     dispatched to it (a W10-stuck save) cannot render.
//
// This script removes every week-event trace from a save so it loads, progresses, and shows the diary without
// throwing, and a W10-stuck save returns to the routing hub. It is dry-run by default (computes the full plan,
// writes nothing); pass apply: true to write. It is idempotent: a cleaned save yields an empty plan. It is
// fail-fast, never silent-skip: a runtime_state that is not a plain object, or a malformed idempotency ledger,
// aborts the whole cleanup rather than partially removing residue.

import { promises as fs } from 'node:fs';

import { createStorageApi } from './storage.mjs';
import { assertValidSlotId, isValidSlot, readValidActiveSlotId, resolveSlotProjectRoot } from './playSession.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
const INVENTORY_PATH = 'game_data/player_inventory.json';
const CHARACTERS_DIR = 'game_data/characters';
const AFFINITY_UPDATES_DIR = 'game_data/logs/affinity_updates';

const ROUTING_ACTIVE_WEEK_EVENT_KEY = 'routing_active_week_event';
const ROUTING_CONTENT_RESULT_KEY = 'last_routing_content_result';
const WEEK_EVENT_SCREEN = 'academy-week-event';
const ROUTING_HUB_SCREEN = 'routing-hub';
// week-event idempotency keys / audit file stems are `week_event_<week4>_<event_id>`; week-event memory files
// are `mem_week_event_<week4>_<event_id>.json`.
const WEEK_EVENT_IDEMPOTENCY_PREFIX = 'week_event_';
const WEEK_EVENT_MEMORY_FILE_PREFIX = 'mem_week_event_';
const WEEK_EVENT_AUDIT_FILE_PREFIX = 'week_event_';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// A directory that does not exist yet (a save that never wrote it) is the honest empty case and returns [].
// Only ENOENT from readdir is treated that way; every other error — including a resolve failure — propagates,
// so a real fault is never silently read as "nothing to clean". resolveReadPath returns a path without
// asserting existence, so it is not wrapped: a throw from it is a genuine fault, not an absent directory.
async function listDirEntries(storage, relativeDir, keep) {
  const fullDir = await storage.resolveReadPath(relativeDir);
  let entries;
  try {
    entries = await fs.readdir(fullDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(keep).map((entry) => entry.name).sort();
}

function listFileNames(storage, relativeDir) {
  return listDirEntries(storage, relativeDir, (entry) => entry.isFile());
}

function listSubdirNames(storage, relativeDir) {
  return listDirEntries(storage, relativeDir, (entry) => entry.isDirectory());
}

// Removes the week-event residue from runtime_state, returning the change record and the next state (or null
// when there is nothing to change). Fail-fast: a non-object runtime_state, or an idempotency-key list that is
// present but not an array, aborts rather than being silently normalized.
function planRuntimeStateChanges(state) {
  if (!isPlainObject(state)) throw new Error('runtime_state.json must be a JSON object');
  const change = { removed_marker: false, removed_content_result: false, reset_screen: null };
  const next = { ...state };

  if (Object.prototype.hasOwnProperty.call(next, ROUTING_ACTIVE_WEEK_EVENT_KEY)) {
    delete next[ROUTING_ACTIVE_WEEK_EVENT_KEY];
    change.removed_marker = true;
  }

  const contentResult = next[ROUTING_CONTENT_RESULT_KEY];
  if (isPlainObject(contentResult) && contentResult.kind === 'week_event') {
    delete next[ROUTING_CONTENT_RESULT_KEY];
    change.removed_content_result = true;
  }

  if (next.current_screen === WEEK_EVENT_SCREEN) {
    next.current_screen = ROUTING_HUB_SCREEN;
    change.reset_screen = { from: WEEK_EVENT_SCREEN, to: ROUTING_HUB_SCREEN };
  }

  const changed = change.removed_marker || change.removed_content_result || change.reset_screen !== null;
  return { change, next: changed ? next : null };
}

// Filters `week_event_*` entries out of an idempotency-conversation-id array on a persisted file. Returns the
// removed keys and the next file (or null when nothing changed). A present-but-non-array field is corrupt and
// fails fast.
function planIdempotencyArrayRemoval(fileValue, arrayKey) {
  if (!isPlainObject(fileValue)) return { removed: [], next: null };
  if (!Object.prototype.hasOwnProperty.call(fileValue, arrayKey)) return { removed: [], next: null };
  const ids = fileValue[arrayKey];
  if (!Array.isArray(ids)) throw new Error(`${arrayKey} must be an array when present`);
  const removed = ids.filter((id) => typeof id === 'string' && id.startsWith(WEEK_EVENT_IDEMPOTENCY_PREFIX));
  if (removed.length === 0) return { removed: [], next: null };
  const kept = ids.filter((id) => !(typeof id === 'string' && id.startsWith(WEEK_EVENT_IDEMPOTENCY_PREFIX)));
  return { removed, next: { ...fileValue, [arrayKey]: kept } };
}

export async function removeWeekEventSaveData({ root, slotId = null, apply = false } = {}) {
  if (!root) throw new Error('root is required');
  const resolvedSlotId = slotId ? assertValidSlotId(slotId) : await readValidActiveSlotId(root);
  if (!resolvedSlotId) {
    throw new Error('no target slot: pass an explicit slot id or set an active slot before cleaning');
  }
  if (!(await isValidSlot(root, resolvedSlotId))) throw new Error(`unknown slot: ${resolvedSlotId}`);

  const slotProjectRoot = resolveSlotProjectRoot(root, resolvedSlotId);
  const storage = createStorageApi({ root: slotProjectRoot });

  // ---- Plan phase: read and validate everything before any write. Every fail-fast (non-object runtime_state,
  // non-array idempotency ledger) fires here, so the apply phase never leaves a save partially cleaned. ----

  // 1. runtime_state: marker, content-result slot, stuck screen.
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const { change: runtimeStateChanges, next: nextState } = planRuntimeStateChanges(state);

  const characterIds = await listSubdirNames(storage, CHARACTERS_DIR);

  // 2. character diary memories of type week_event (mem_week_event_*.json under every character's memory dir).
  const removedMemoryFiles = [];
  for (const characterId of characterIds) {
    const memoryDir = `${CHARACTERS_DIR}/${characterId}/memory`;
    for (const fileName of await listFileNames(storage, memoryDir)) {
      if (fileName.startsWith(WEEK_EVENT_MEMORY_FILE_PREFIX) && fileName.endsWith('.json')) {
        removedMemoryFiles.push(`${memoryDir}/${fileName}`);
      }
    }
  }

  // 3. festival affinity audit logs (week_event_*.json under the affinity_updates log dir).
  const removedAffinityAuditFiles = [];
  for (const fileName of await listFileNames(storage, AFFINITY_UPDATES_DIR)) {
    if (fileName.startsWith(WEEK_EVENT_AUDIT_FILE_PREFIX) && fileName.endsWith('.json')) {
      removedAffinityAuditFiles.push(`${AFFINITY_UPDATES_DIR}/${fileName}`);
    }
  }

  // 4. money idempotency ledger entries (applied_money_delta_conversation_ids on the inventory).
  const inventory = await storage.readJsonIfExists(INVENTORY_PATH);
  const moneyRemoval = planIdempotencyArrayRemoval(inventory, 'applied_money_delta_conversation_ids');

  // 5. affinity idempotency ledger entries (applied_affinity_conversation_ids on each character's affinity file).
  const affinityWrites = [];
  const removedAffinityIdempotency = [];
  for (const characterId of characterIds) {
    const affinityPath = `${CHARACTERS_DIR}/${characterId}/affinity.json`;
    const affinityFile = await storage.readJsonIfExists(affinityPath);
    const removal = planIdempotencyArrayRemoval(affinityFile, 'applied_affinity_conversation_ids');
    if (removal.removed.length > 0) {
      affinityWrites.push({ path: affinityPath, next: removal.next });
      removedAffinityIdempotency.push({ character_id: characterId, removed_keys: removal.removed });
    }
  }

  // ---- Apply phase: every read/validation above passed. ----
  if (apply) {
    if (nextState) await storage.writeJson(RUNTIME_STATE_PATH, nextState);
    for (const relativePath of removedMemoryFiles) await fs.rm(storage.resolveWritePath(relativePath), { force: true });
    for (const relativePath of removedAffinityAuditFiles) await fs.rm(storage.resolveWritePath(relativePath), { force: true });
    if (moneyRemoval.next) await storage.writeJson(INVENTORY_PATH, moneyRemoval.next);
    for (const write of affinityWrites) await storage.writeJson(write.path, write.next);
  }

  return {
    slot_id: resolvedSlotId,
    applied: apply,
    runtime_state_changes: runtimeStateChanges,
    removed_memory_files: removedMemoryFiles,
    removed_affinity_audit_files: removedAffinityAuditFiles,
    removed_money_idempotency_keys: moneyRemoval.removed,
    removed_affinity_idempotency_keys: removedAffinityIdempotency
  };
}
