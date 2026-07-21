#!/usr/bin/env node

import { removeWeekEventSaveData } from '../app/src/removeWeekEventSaveData.mjs';

const command = 'node scripts/remove-week-event-save-data.mjs';

function usageError() {
  return new Error(`usage: ${command} [--apply] [--slot <slot_id>]`);
}

function parseArgs(args) {
  let apply = false;
  let slotId = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--slot') {
      slotId = args[i + 1];
      if (slotId == null) throw usageError();
      i += 1;
    } else {
      throw usageError();
    }
  }
  return { apply, slotId, root: process.cwd() };
}

function changeCount(result) {
  const rs = result.runtime_state_changes;
  return (rs.removed_marker ? 1 : 0)
    + (rs.removed_content_result ? 1 : 0)
    + (rs.reset_screen ? 1 : 0)
    + result.removed_memory_files.length
    + result.removed_affinity_audit_files.length
    + result.removed_money_idempotency_keys.length
    + result.removed_affinity_idempotency_keys.reduce((sum, entry) => sum + entry.removed_keys.length, 0);
}

try {
  const { apply, slotId, root } = parseArgs(process.argv.slice(2));
  const result = await removeWeekEventSaveData({ root, slotId, apply });
  console.log(JSON.stringify(result, null, 2));
  if (!result.applied) {
    const count = changeCount(result);
    console.error(count > 0
      ? `dry-run: ${count} change(s) planned. Re-run with --apply to write.`
      : 'dry-run: nothing to clean.');
  }
} catch (error) {
  console.error(`remove-week-event-save-data failed: ${error.message}`);
  process.exitCode = 1;
}
