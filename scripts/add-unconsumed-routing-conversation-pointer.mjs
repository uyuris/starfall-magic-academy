#!/usr/bin/env node

// One-shot migration: adds the top-level `unconsumed_routing_conversation` field (initialized to null) to every
// existing save slot's `runtime_state.json` that does not yet carry it. Fresh saves already receive the field
// via `freshRuntimeState`, and the routing hub reader is strict — a required-own-property check fails fast if
// the field is missing — so this script is the one-time bridge between pre-change slots and the strict reader.
//
// Modes:
//   dry-run (default): walks every target file, reports what would change, writes nothing.
//   --apply: writes `null` into every target file that is missing the key. Already-populated files are skipped
//   (idempotent no-op). Running the script twice in a row yields the same {added: 0} result.
//
// Strict I/O: any read/parse/write failure throws with a descriptive error — never silent-skip, never partial.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  listValidSlotIds,
  resolvePlayRoot,
  resolveSlotProjectRoot
} from '../app/src/playSession.mjs';

const RUNTIME_STATE_RELATIVE_PATH = 'game_data/runtime_state.json';
const UNCONSUMED_ROUTING_CONVERSATION_KEY = 'unconsumed_routing_conversation';
const command = 'node scripts/add-unconsumed-routing-conversation-pointer.mjs';

function usageError() {
  return new Error(`usage: ${command} [--apply]`);
}

function parseArgs(args) {
  let apply = false;
  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
    } else {
      throw usageError();
    }
  }
  return { apply, root: process.cwd() };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(fullPath) {
  return JSON.parse(await fs.readFile(fullPath, 'utf8'));
}

async function writeJson(fullPath, value) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function collectTargetPaths(root) {
  const targets = [];
  // Legacy top-level runtime_state.json (pre-slot layout): included only when it exists on disk. `resolvePlayRoot`
  // is not consulted because the legacy file lives at <root>/game_data/, not under the play/slots tree.
  const legacyPath = path.join(root, RUNTIME_STATE_RELATIVE_PATH);
  if (await pathExists(legacyPath)) {
    targets.push({ label: 'legacy_top_level', path: legacyPath });
  }
  // Every valid save slot under the play root.
  const slotIds = await listValidSlotIds(root);
  for (const slotId of slotIds) {
    const slotRuntimePath = path.join(resolveSlotProjectRoot(root, slotId), RUNTIME_STATE_RELATIVE_PATH);
    if (await pathExists(slotRuntimePath)) {
      targets.push({ label: `slot:${slotId}`, path: slotRuntimePath });
    }
  }
  return targets;
}

function inspectState(state, label) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`${label}: runtime_state must be an object`);
  }
  return Object.prototype.hasOwnProperty.call(state, UNCONSUMED_ROUTING_CONVERSATION_KEY);
}

export async function addUnconsumedRoutingConversationPointer({ root, apply = false } = {}) {
  if (!root) throw new Error('root is required');
  const targets = await collectTargetPaths(root);
  let added = 0;
  let skippedAlreadyPresent = 0;
  const addedTargets = [];
  const skippedTargets = [];
  for (const target of targets) {
    const state = await readJson(target.path);
    const hasKey = inspectState(state, target.label);
    if (hasKey) {
      skippedAlreadyPresent += 1;
      skippedTargets.push(target.label);
      continue;
    }
    added += 1;
    addedTargets.push(target.label);
    if (apply) {
      // Additive rewrite: insert the new key right after `last_conversation_id` when present (keeps the on-disk
      // shape near neighboring identity fields), else at the tail. Property order is cosmetic; the strict reader
      // does not depend on it.
      const nextState = {};
      let inserted = false;
      for (const [key, value] of Object.entries(state)) {
        nextState[key] = value;
        if (!inserted && key === 'last_conversation_id') {
          nextState[UNCONSUMED_ROUTING_CONVERSATION_KEY] = null;
          inserted = true;
        }
      }
      if (!inserted) nextState[UNCONSUMED_ROUTING_CONVERSATION_KEY] = null;
      await writeJson(target.path, nextState);
    }
  }
  return {
    root,
    applied: apply,
    total: targets.length,
    added,
    skipped_already_present: skippedAlreadyPresent,
    added_targets: addedTargets,
    skipped_targets: skippedTargets
  };
}

// The play root is resolved via `resolvePlayRoot` (referenced for side-effect free assertion): unresolvable
// paths throw the same way `listValidSlotIds` would, so an unusable working directory fails fast at CLI start.
export function assertResolvablePlayRoot(root) {
  return resolvePlayRoot(root);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { apply, root } = parseArgs(process.argv.slice(2));
    assertResolvablePlayRoot(root);
    const result = await addUnconsumedRoutingConversationPointer({ root, apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) {
      console.error(result.added > 0
        ? `dry-run: ${result.added} slot(s) would be updated. Re-run with --apply to write.`
        : 'dry-run: nothing to update.');
    }
  } catch (error) {
    console.error(`add-unconsumed-routing-conversation-pointer failed: ${error.message}`);
    process.exitCode = 1;
  }
}
