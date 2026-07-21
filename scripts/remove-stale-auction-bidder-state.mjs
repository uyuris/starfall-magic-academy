#!/usr/bin/env node

// Save cleanup for the earlier auction NPC-bidder range.
//
// The weekly seated-bidder range moved to AUCTION_MIN_BIDDERS..AUCTION_MAX_BIDDERS. A save written under an
// earlier range can still carry a routing_auction slot or routing_auction_consignment record whose seated
// bidder count is now outside that range. readAuctionSlot / readConsignment run their strict validators BEFORE
// the week-staleness check, so such residue throws on the next auction visit and blocks entry instead of being
// rebuilt by the weekly draw. This script removes exactly that residue (planStaleAuctionBidderStateRemoval) from
// every valid save slot (or an explicit --slot), so the next visit rebuilds a fresh in-range week. It is dry-run
// by default (computes the plan, writes nothing); pass --apply to write. It is idempotent (a cleaned save yields
// an empty plan) and fail-fast (a non-object runtime_state aborts rather than being silently skipped).

import { createStorageApi } from '../app/src/storage.mjs';
import { assertValidSlotId, isValidSlot, listValidSlotIds, resolveSlotProjectRoot } from '../app/src/playSession.mjs';
import { planStaleAuctionBidderStateRemoval } from '../app/src/routingAuction.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
const command = 'node scripts/remove-stale-auction-bidder-state.mjs';

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
  return { apply, slotId };
}

async function resolveSlotIds(root, slotId) {
  if (slotId) {
    assertValidSlotId(slotId);
    if (!(await isValidSlot(root, slotId))) throw new Error(`unknown slot: ${slotId}`);
    return [slotId];
  }
  return listValidSlotIds(root);
}

async function cleanSlot(root, slotId, apply) {
  const storage = createStorageApi({ root: resolveSlotProjectRoot(root, slotId) });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const { removed, next } = planStaleAuctionBidderStateRemoval(state);
  if (apply && next) await storage.writeJson(RUNTIME_STATE_PATH, next);
  return { slot_id: slotId, removed_keys: removed };
}

try {
  const { apply, slotId } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const slotIds = await resolveSlotIds(root, slotId);
  const slots = [];
  for (const id of slotIds) slots.push(await cleanSlot(root, id, apply));
  const result = { applied: apply, slots };
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    const changeCount = slots.reduce((sum, slot) => sum + slot.removed_keys.length, 0);
    console.error(changeCount > 0
      ? `dry-run: ${changeCount} change(s) planned across ${slots.length} slot(s). Re-run with --apply to write.`
      : 'dry-run: nothing to clean.');
  }
} catch (error) {
  console.error(`remove-stale-auction-bidder-state failed: ${error.message}`);
  process.exitCode = 1;
}
