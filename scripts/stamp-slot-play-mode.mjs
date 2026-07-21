#!/usr/bin/env node

import path from 'node:path';

import { assertValidSlotId, isValidSlot, readSlotMeta, writeSlotMeta } from '../app/src/playSession.mjs';
import { resolveActivePlayMode, validatePlayMode } from '../app/src/playMode.mjs';

const command = 'node scripts/stamp-slot-play-mode.mjs';

function usageError() {
  return new Error(`usage: ${command} <slot_id> <loop|routing>`);
}

async function resolveRoutingPersonaVariantForStamp(root) {
  const settingsPath = process.env.MAGIC_ACADEMY_PLAY_MODE_SETTINGS ?? path.join(root, 'app/config/play-mode.json');
  const settings = await resolveActivePlayMode(settingsPath);
  if (settings.mode !== 'routing' || !settings.routing_persona_variant) {
    throw new Error(`routing stamp requires routing play-mode settings with routing_persona_variant at ${settingsPath}`);
  }
  return settings.routing_persona_variant;
}

async function main() {
  const [slotIdArg, modeArg, ...extraArgs] = process.argv.slice(2);
  if (!slotIdArg || !modeArg || extraArgs.length) throw usageError();

  const slotId = assertValidSlotId(slotIdArg);
  const playMode = validatePlayMode(modeArg);
  const root = process.cwd();

  if (!(await isValidSlot(root, slotId))) throw new Error(`unknown slot: ${slotId}`);
  const meta = await readSlotMeta(root, slotId);
  if (Object.prototype.hasOwnProperty.call(meta ?? {}, 'play_mode')) {
    throw new Error(`slot ${slotId} already has play_mode`);
  }
  const routingPersonaVariant = playMode === 'routing'
    ? await resolveRoutingPersonaVariantForStamp(root)
    : null;

  const nextMeta = {
    ...meta,
    play_mode: playMode,
    ...(routingPersonaVariant ? { routing_persona_variant: routingPersonaVariant } : {})
  };
  await writeSlotMeta(root, slotId, nextMeta);
  console.log(JSON.stringify({ slot_id: slotId, play_mode: playMode }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`stamp-slot-play-mode failed: ${error.message}`);
  process.exitCode = 1;
}
