import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  loadStageFlags,
  judgeStageFlagsAfterConversation,
  setStageFlagActive,
  setStageFlagJudgmentFlowEnabled
} from '../src/stageFlags.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function createSplitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-stageflags-split-'));
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', {
    flags: [
      {
        id: 'stage.festival_arch.rune_banner_alignment',
        label: 'ルーン幕の位置合わせ',
        location_id: 'festival_arch',
        condition: '祭門の幕に刻まれたルーンを正しい順に合わせる。',
        question: '祭門の幕に刻まれたルーンを正しい順に合わせたか',
        reward_on_inventory_open: {
          item_id: 'rune_banner_alignment',
          quantity: 1
        }
      },
      {
        id: 'stage.festival_arch.mirror_lantern_reply',
        label: '鏡灯籠の返事',
        location_id: 'festival_arch',
        condition: '鏡灯籠の返事を聞き取る。',
        question: '鏡灯籠の返事を聞き取ったか',
        reward_on_inventory_open: {
          item_id: 'mirror_lantern_reply',
          quantity: 1
        }
      }
    ]
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    global_flags: {
      'stage.festival_arch.rune_banner_alignment': false,
      'stage.festival_arch.mirror_lantern_reply': false
    },
    disabled_stage_flag_judgment_flows: {}
  });
  return root;
}

test('loadStageFlags returns no definitions when the canonical file is missing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-stageflags-empty-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const definitions = await loadStageFlags({ root });
  assert.deepEqual(definitions, { flags: [] });
});

test('split-root stage flags read definitions and write judgment/runtime state only under data/mutable without recreating legacy game_data files', async (t) => {
  const root = await createSplitRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const definitions = await loadStageFlags({ root });
  assert.deepEqual(definitions.flags.map((flag) => flag.id), [
    'stage.festival_arch.rune_banner_alignment',
    'stage.festival_arch.mirror_lantern_reply'
  ]);

  const judgment = await judgeStageFlagsAfterConversation({
    root,
    state: {
      global_flags: {
        'stage.festival_arch.rune_banner_alignment': false,
        'stage.festival_arch.mirror_lantern_reply': false
      },
      disabled_stage_flag_judgment_flows: {}
    },
    conversation: {
      id: 'conv_stage_split_001',
      location_id: 'festival_arch'
    },
    stageFlagJudgmentProvider: async ({ candidateFlags }) => ({
      flag_results: [
        { flag_id: candidateFlags[0].id, achieved: true, reason: 'ルーンが揃った' },
        { flag_id: candidateFlags[1].id, achieved: false, reason: '返事はまだ聞こえない' }
      ]
    }),
    now: '2026-05-18T02:34:56.000Z'
  });

  assert.equal(judgment.accepted[0].flag_id, 'stage.festival_arch.rune_banner_alignment');
  const log = await readJson(root, 'data/mutable/game_data/logs/stage_flag_judgments/conv_stage_split_001.json');
  assert.equal(log.accepted[0].flag_id, 'stage.festival_arch.rune_banner_alignment');

  const activeStatus = await setStageFlagActive({
    root,
    flagId: 'stage.festival_arch.rune_banner_alignment',
    active: true
  });
  assert.equal(activeStatus.flags.find((flag) => flag.id === 'stage.festival_arch.rune_banner_alignment').active, true);

  const flowStatus = await setStageFlagJudgmentFlowEnabled({
    root,
    flagId: 'stage.festival_arch.mirror_lantern_reply',
    enabled: false
  });
  assert.equal(flowStatus.flags.find((flag) => flag.id === 'stage.festival_arch.mirror_lantern_reply').judgment_flow_enabled, false);

  const savedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(savedState.global_flags['stage.festival_arch.rune_banner_alignment'], true);
  assert.equal(savedState.disabled_stage_flag_judgment_flows['stage.festival_arch.mirror_lantern_reply'], true);

  await assert.rejects(fs.access(path.join(root, 'game_data/stage_flags.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/runtime_state.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/logs/stage_flag_judgments/conv_stage_split_001.json')), { code: 'ENOENT' });
});
