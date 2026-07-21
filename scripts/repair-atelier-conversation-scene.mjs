#!/usr/bin/env node

import { repairAtelierConversationScene } from '../app/src/repairAtelierConversationScene.mjs';

const command = 'node scripts/repair-atelier-conversation-scene.mjs';

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

try {
  const { apply, slotId, root } = parseArgs(process.argv.slice(2));
  const result = await repairAtelierConversationScene({ root, slotId, apply });
  console.log(JSON.stringify(result, null, 2));
  if (!result.applied) {
    const changeCount = result.conversation_repairs.length + result.finalization_repairs.length;
    console.error(changeCount > 0
      ? `dry-run: ${changeCount} change(s) planned. Re-run with --apply to write.`
      : 'dry-run: nothing to repair.');
  }
} catch (error) {
  console.error(`repair-atelier-conversation-scene failed: ${error.message}`);
  process.exitCode = 1;
}
