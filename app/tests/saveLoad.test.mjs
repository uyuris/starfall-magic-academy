// 残す (a): save slot の作成・読込・note 更新と play_mode の刻印 script が、その slot と他の slot の記録を失わせる・上書きする壊れ方から、プレイヤーの save を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSaveSlot as createSaveSlotCore, loadSaveSlot, listSaveSlots, updateSaveSlotNote } from '../src/saveLoad.mjs';
import { fixtureRoot, readJson } from './helpers.mjs';
import { projectRoot } from './testPaths.mjs';

const execFileAsync = promisify(execFile);
const stampSlotPlayModeScript = path.join(projectRoot, 'scripts/stamp-slot-play-mode.mjs');

function createSaveSlot(options) {
  return createSaveSlotCore({ playMode: 'loop', ...options });
}

async function runStampSlotPlayMode(root, args) {
  return await execFileAsync(process.execPath, [stampSlotPlayModeScript, ...args], {
    cwd: root,
    // Pin the play-mode sidecar the script reads to this fixture root (mirroring the script's own
    // root-relative fallback), so an ambient MAGIC_ACADEMY_PLAY_MODE_SETTINGS — the developer machine's
    // real play settings, e.g. a routing sidecar with a pre-replacement variant — cannot leak into the gate.
    env: { ...process.env, FORCE_COLOR: '0', MAGIC_ACADEMY_PLAY_MODE_SETTINGS: path.join(root, 'app/config/play-mode.json') }
  });
}

async function writePlayModeSettings(root, settings) {
  await writeSplitJson(root, 'app/config/play-mode.json', settings);
}

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function saveFixtureRoot() {
  const root = await fixtureRoot('magic-adv-save-');
  await fs.rm(path.join(root, 'game_data/save_slots'), { recursive: true, force: true });
  return root;
}

test('createSaveSlot snapshots runtime and character flags without embedding conversation logs, and loadSaveSlot restores them', async () => {
  const root = await saveFixtureRoot();
  await writeSplitJson(root, 'game_data/gathering_stock.json', {
    version: 1,
    stocks: {
      sanrin_trailhead_silverleaf_patch: 1,
      sanrin_conifer_forest_resin_cluster: 3,
      sanrin_stream_bank_mica_pebbles: 3,
      sanrin_mossy_shrine_blue_moss: 3
    }
  });
  await writeSplitJson(root, 'game_data/mp_reserve.json', { version: 1, reserves: { character_007: 45 } });
  const saved = await createSaveSlot({ root, slotId: 'slot_001', label: '薬草園の異常前', now: '2026-05-05T06:00:00.000+09:00' });
  assert.equal(saved.slot_id, 'slot_001');
  assert.equal(saved.label, '薬草園の異常前');
  assert.equal(saved.snapshot.runtime_state.current_location_id, 'herbology_garden');
  assert.equal(saved.snapshot.logs_embedded, false);

  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'old_corridor';
  state.global_flags['story.archive_intro_done'] = true;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), `${JSON.stringify(state, null, 2)}\n`);
  await writeSplitJson(root, 'game_data/gathering_stock.json', {
    version: 1,
    stocks: {
      sanrin_trailhead_silverleaf_patch: 0,
      sanrin_conifer_forest_resin_cluster: 0,
      sanrin_stream_bank_mica_pebbles: 0,
      sanrin_mossy_shrine_blue_moss: 0
    }
  });

  const restored = await loadSaveSlot({ root, slotId: 'slot_001' });
  assert.equal(restored.runtime_state.current_location_id, 'herbology_garden');
  assert.equal(restored.runtime_state.global_flags['story.archive_intro_done'], false);
  const restoredGatheringStock = await readJson(root, 'game_data/play/slots/slot_001/game_data/gathering_stock.json');
  assert.equal(restoredGatheringStock.stocks.sanrin_trailhead_silverleaf_patch, 1);
  // The mp_reserve mutable player surface is carried into the slot by the canonical clone.
  const restoredMpReserve = await readJson(root, 'game_data/play/slots/slot_001/game_data/mp_reserve.json');
  assert.deepEqual(restoredMpReserve, { version: 1, reserves: { character_007: 45 } });

  const { slots } = await listSaveSlots({ root });
  assert.deepEqual(slots.map((slot) => slot.slot_id), ['slot_001']);
});

test('stamp-slot-play-mode stamps one legacy slot and rejects unknown invalid or already-stamped input', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_legacy', label: 'legacy slot', now: '2026-05-05T06:00:00.000+09:00' });
  const metaPath = path.join(root, 'game_data/play/slots/slot_legacy/meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  delete meta.play_mode;
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await writePlayModeSettings(root, { mode: 'routing', routing_persona_variant: 'fallen_star' });

  const stamped = await runStampSlotPlayMode(root, ['slot_legacy', 'routing']);
  assert.match(stamped.stdout, /slot_legacy/);
  assert.equal((await readJson(root, 'game_data/play/slots/slot_legacy/meta.json')).play_mode, 'routing');
  assert.equal((await readJson(root, 'game_data/play/slots/slot_legacy/meta.json')).routing_persona_variant, 'fallen_star');

  await createSaveSlot({ root, slotId: 'slot_invalid_mode', label: 'invalid mode target', now: '2026-05-05T06:10:00.000+09:00' });
  const invalidModeMetaPath = path.join(root, 'game_data/play/slots/slot_invalid_mode/meta.json');
  const invalidModeMeta = JSON.parse(await fs.readFile(invalidModeMetaPath, 'utf8'));
  delete invalidModeMeta.play_mode;
  await fs.writeFile(invalidModeMetaPath, `${JSON.stringify(invalidModeMeta, null, 2)}\n`, 'utf8');

  await assert.rejects(
    runStampSlotPlayMode(root, ['slot_missing', 'routing']),
    /unknown slot/
  );
  await assert.rejects(
    runStampSlotPlayMode(root, ['slot_invalid_mode', 'banana']),
    /mode must be one of/
  );
  await assert.rejects(
    runStampSlotPlayMode(root, ['slot_legacy', 'loop']),
    /already has play_mode/
  );
});

test('updateSaveSlotNote stores one trimmed player note per slot without cross-slot leakage', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_001', label: 'slot one', now: '2026-05-05T06:00:00.000+09:00' });
  await createSaveSlot({ root, slotId: 'slot_002', label: 'slot two', now: '2026-05-05T06:30:00.000+09:00' });

  const longBody = 'あ'.repeat(2105);
  const updated = await updateSaveSlotNote({
    root,
    slotId: 'slot_001',
    playerNote: `  図書塔前 / リナ会話前\n${longBody}  `,
    now: '2026-05-05T07:00:00.000+09:00'
  });
  const expected = `図書塔前 / リナ会話前\n${longBody}`.slice(0, 2000);

  assert.equal(updated.slot_id, 'slot_001');
  assert.equal(updated.player_note, expected);
  assert.equal(updated.player_note.length, 2000);
  assert.equal(updated.updated_at, '2026-05-05T07:00:00.000+09:00');

  const slotOneMeta = await readJson(root, 'game_data/play/slots/slot_001/meta.json');
  const slotTwoMeta = await readJson(root, 'game_data/play/slots/slot_002/meta.json');
  assert.equal(slotOneMeta.player_note, expected);
  assert.equal(slotTwoMeta.player_note ?? '', '');

  const { slots } = await listSaveSlots({ root });
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_001')?.player_note, expected);
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_001')?.player_note.length, 2000);
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_002')?.player_note ?? '', '');
});
