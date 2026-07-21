import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneGameDataFixture, isolatedServerOptions } from './helpers.mjs';
import { definitionsRoot, projectRoot } from './testPaths.mjs';
import { finalizeConversation as finalizeConversationCore, runConversationOpening } from '../src/llm/conversationPipeline.mjs';
import { createServer } from '../src/server.mjs';
import { loadEventFlags, getEventFlagStatus, selectEventCompletionJudgmentTargets, selectEventFlagJudgmentTargets, selectEventParticipantOverrideJudgmentTargets, setAllEventFlagsActive, startEventFlagInteraction } from '../src/eventFlags.mjs';
import { loadStageFlags } from '../src/stageFlags.mjs';
import { loadWorldSettings } from '../src/worldSettings.mjs';
import { initializeNewPlayArea as initializeNewPlayAreaCore } from '../src/playSession.mjs';

const stagingRoot = projectRoot;
const livePublicRoot = path.join(projectRoot, 'app/public');

function initializeNewPlayArea(options) {
  return initializeNewPlayAreaCore({ playMode: 'loop', ...options });
}

function finalizeConversation(args) {
  return finalizeConversationCore({ affinityDeltaProvider: async () => '0', ...args });
}

async function fixtureRoot(prefix = 'magic-adv-flags-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await cloneGameDataFixture(root);
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify({
    version: 1,
    current_location_id: 'forbidden_archive_door',
    time_slot: 'after_school',
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    global_flags: {
      'stage.forbidden_archive.teatime_inside_done': false,
      'stage.forbidden_archive.necromancy_book_found': false,
      'stage.herbology_garden.test_done': false,
      'stage.forbidden_archive.already_done': true
    },
    visited_locations: ['forbidden_archive_door'],
    active_character_ids: ['lina'],
    last_conversation_id: 'conv_forbidden_archive_teatime',
    characters: {
      lina: {
        flags: {
          'knowledge.lina.player_checked_garden_label': false,
          'relationship.lina.trust': 0,
          'condition.minor.lina_worried': false
        }
      }
    }
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/stage_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'stage.forbidden_archive.teatime_inside_done',
        label: '禁書庫内のお茶会',
        location_id: 'forbidden_archive_door',
        condition: '禁書庫の舞台で、禁書庫の中に入ってティータイム、お茶会をする。',
        question: '禁書庫に入り、その中でお茶会を開いたか',
        reward_on_inventory_open: {
          item_id: 'fairy_doll',
          quantity: 1
        }
      },
      {
        id: 'stage.forbidden_archive.necromancy_book_found',
        label: '禁書庫の死霊術本発見',
        location_id: 'forbidden_archive_door',
        condition: '禁書庫の舞台で、死霊術についての本を見つける。',
        question: '禁書庫で死霊術についての本を見つけたか',
        reward_on_inventory_open: {
          item_id: 'necromancy_book',
          quantity: 1
        }
      },
      {
        id: 'stage.forbidden_archive.margin_starmap_bookmark_found',
        label: '禁書庫の余白星図の栞',
        location_id: 'forbidden_archive_door',
        condition: '禁書庫の舞台で、白紙や余白だけの本を開き、そこに浮かぶ星図や星座の栞を見つける。',
        question: '禁書庫で白紙や余白だけの本を開き、そこに浮かぶ星図や星座の栞を見つけたか',
        reward_on_inventory_open: {
          item_id: 'margin_starmap_bookmark',
          quantity: 1
        }
      },
      {
        id: 'stage.herbology_garden.test_done',
        label: '薬草園テスト',
        location_id: 'herbology_garden',
        condition: '薬草園で別条件を満たす。'
      },
      {
        id: 'stage.forbidden_archive.already_done',
        label: '既にオンの条件',
        location_id: 'forbidden_archive_door',
        condition: '既にオンならLLMへ渡さない。'
      }
    ]
  }, null, 2), 'utf8');
  await fs.mkdir(path.join(root, 'game_data/logs/conversations'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_forbidden_archive_teatime.json'), JSON.stringify({
    id: 'conv_forbidden_archive_teatime',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-06T13:00:00.000+09:00',
    updated_at: '2026-05-06T13:10:00.000+09:00',
    source_type: 'field',
    location_id: 'forbidden_archive_door',
    time_slot: 'after_school',
    prompt: '禁書庫前で会話する。',
    messages: [
      { role: 'user', content: '禁書庫の中に入って、秘密のティータイムにしよう。' },
      { role: 'assistant', content: 'それなら奥の机にカップを置いて、静かなお茶会にしましょう。' }
    ]
  }, null, 2), 'utf8');
  return root;
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function readDefinitionsJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(definitionsRoot, relativePath), 'utf8'));
}

async function withServer(t, root) {
  const server = createServer(await isolatedServerOptions(t, { root, publicRoot: livePublicRoot }, 'magic-adv-flags-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('graduation ending flag is excluded from generic conversation-end event judgment targets', async () => {
  const root = await fixtureRoot('magic-adv-flags-graduation-targets-');
  const definitions = await loadEventFlags({ root });
  const runtimeState = await readJson(root, 'game_data/runtime_state.json');
  runtimeState.global_flags ??= {};
  runtimeState.global_flags['event.graduation_ending.ready'] = false;
  runtimeState.elapsed_weeks = 49;
  const targets = selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: runtimeState,
    inventory: { money: 0, items: [] },
    conversation: { id: 'conv_forbidden_archive_teatime' }
  });
  assert.equal(targets.some((flag) => flag.id === 'event.graduation_ending.ready'), false);
});

test('graduation ending flag carries no event-completion judgment and is never a completion-judgment target', async () => {
  const rawDefinitions = await readDefinitionsJson('event_flags.json');
  const rawGraduation = rawDefinitions.flags.find((flag) => flag.id === 'event.graduation_ending.ready');
  assert.ok(rawGraduation, 'graduation ending flag must exist in the definitions');
  assert.equal(Object.hasOwn(rawGraduation, 'completion_judgment'), false, 'graduation ending definition must not carry a completion_judgment block');

  const definitions = await loadEventFlags({ root: projectRoot });
  const graduation = definitions.flags.find((flag) => flag.id === 'event.graduation_ending.ready');
  assert.ok(graduation, 'graduation ending flag must load');
  assert.equal(graduation.completion_judgment, null, 'graduation ending flag must not expose a completion judgment');

  const targets = selectEventCompletionJudgmentTargets({
    flags: definitions.flags,
    state: {
      global_flags: {
        'event.graduation_ending.ready': true,
        'event.graduation_ending.completed': false
      }
    },
    conversation: { location_id: 'front_gate_morning' }
  });
  assert.equal(targets.some((flag) => flag.id === 'event.graduation_ending.ready'), false, 'the ending conversation must not trigger an LLM event-completion judgment for graduation');
});

async function jsonFetch(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
    body: options?.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options?.body
  });
  const text = await response.text();
  assert.equal(response.ok, true, `${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

test('conversation finalization judges only off stage flags for the conversation location after continuity updates', async () => {
  const root = await fixtureRoot();
  const providerCalls = [];
  const writeOrder = [];

  const result = await finalizeConversation({
    root,
    conversationId: 'conv_forbidden_archive_teatime',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => {
      writeOrder.push('memory');
      return { memory_record: { id: 'mem_flag_test', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と禁書庫の中でお茶会をする相談をした。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } };
    },
    skillUpdateProvider: async ({ conversation, workRecordId }) => {
      writeOrder.push('skill');
      return { skill_record: { id: 'skill_flag_test', character_id: conversation.character_id, type: 'self_change', name: '静かな企て', description: 'リナは禁書庫で静かにお茶会をする相談に応じる柔軟さを得た。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } };
    },
    workRecordProvider: async ({ conversation, workRecordId }) => {
      writeOrder.push('work_record');
      return { work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '禁書庫でお茶会をする相談をした', summary: '主人公は禁書庫の中に入ってティータイムにしようと提案した。リナは奥の机にカップを置いて静かなお茶会にしようと応じた。', flag_update_candidates: [], warnings: [] } };
    },
    stageFlagJudgmentProvider: async ({ conversation, candidateFlags, workRecordId }) => {
      providerCalls.push({ conversation, candidateFlags, writeOrder: [...writeOrder] });
      assert.equal(workRecordId, 'wr_conv_forbidden_archive_teatime');
      assert.equal(candidateFlags[0].question, '禁書庫に入り、その中でお茶会を開いたか');
      assert.equal(candidateFlags[1].question, '禁書庫で死霊術についての本を見つけたか');
      assert.equal(candidateFlags[2].question, '禁書庫で白紙や余白だけの本を開き、そこに浮かぶ星図や星座の栞を見つけたか');
      return {
        flag_results: [
          { flag_id: 'stage.forbidden_archive.teatime_inside_done', achieved: true },
          { flag_id: 'stage.forbidden_archive.necromancy_book_found', achieved: false },
          { flag_id: 'stage.forbidden_archive.margin_starmap_bookmark_found', achieved: true }
        ]
      };
    },
    skillFlowRollProvider: () => 0.1
  });

  assert.deepEqual(writeOrder.sort(), ['memory', 'skill', 'work_record'].sort());
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0].candidateFlags.map((flag) => flag.id), [
    'stage.forbidden_archive.teatime_inside_done',
    'stage.forbidden_archive.necromancy_book_found',
    'stage.forbidden_archive.margin_starmap_bookmark_found'
  ]);
  assert.equal(providerCalls[0].conversation.location_id, 'forbidden_archive_door');
  assert.deepEqual(providerCalls[0].writeOrder.sort(), ['memory', 'skill', 'work_record'].sort());
  assert.equal(result.stage_flags.accepted[0].flag_id, 'stage.forbidden_archive.teatime_inside_done');
  const awardedInventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(awardedInventory.items.find((item) => item.item_id === 'fairy_doll')?.quantity, 1);
  assert.equal(awardedInventory.items.find((item) => item.item_id === 'margin_starmap_bookmark')?.quantity, 1);
  assert.deepEqual(result.stage_flags.raw_result, {
    flag_results: [
      {
        flag_id: 'stage.forbidden_archive.teatime_inside_done',
        achieved: true,
        reason: ''
      },
      {
        flag_id: 'stage.forbidden_archive.necromancy_book_found',
        achieved: false,
        reason: ''
      },
      {
        flag_id: 'stage.forbidden_archive.margin_starmap_bookmark_found',
        achieved: true,
        reason: ''
      }
    ]
  });
  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.global_flags['stage.forbidden_archive.teatime_inside_done'], true);
  assert.equal(state.global_flags['stage.forbidden_archive.margin_starmap_bookmark_found'], true);
  assert.equal(state.global_flags['stage.herbology_garden.test_done'], false);
  assert.equal(await fs.readFile(path.join(root, 'game_data/logs/stage_flag_judgments/conv_forbidden_archive_teatime.json'), 'utf8').then((text) => JSON.parse(text).candidate_flags.length), 3);
  await fs.rm(root, { recursive: true, force: true });
});

test('opening inventory does not claim stage rewards or clear completed stage flags', async (t) => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['stage.forbidden_archive.teatime_inside_done'] = true;
  state.global_flags['stage.forbidden_archive.necromancy_book_found'] = true;
  state.global_flags['stage.forbidden_archive.margin_starmap_bookmark_found'] = true;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [] }, null, 2), 'utf8');
  const base = await withServer(t, root);

  const first = await jsonFetch(`${base}/api/inventory`);
  assert.equal(first.items.find((item) => item.item_id === 'fairy_doll') ?? null, null);
  assert.equal(first.items.find((item) => item.item_id === 'necromancy_book') ?? null, null);
  assert.equal(first.items.find((item) => item.item_id === 'margin_starmap_bookmark') ?? null, null);
  assert.equal((await readJson(root, 'game_data/runtime_state.json')).global_flags['stage.forbidden_archive.teatime_inside_done'], true);
  assert.equal((await readJson(root, 'game_data/runtime_state.json')).global_flags['stage.forbidden_archive.necromancy_book_found'], true);
  assert.equal((await readJson(root, 'game_data/runtime_state.json')).global_flags['stage.forbidden_archive.margin_starmap_bookmark_found'], true);

  const second = await jsonFetch(`${base}/api/inventory`);
  assert.equal(second.items.find((item) => item.item_id === 'fairy_doll') ?? null, null);
  assert.equal(second.items.find((item) => item.item_id === 'necromancy_book') ?? null, null);
  assert.equal(second.items.find((item) => item.item_id === 'margin_starmap_bookmark') ?? null, null);
});

test('current stage flag definitions keep judgeable text and progression invariants without relying on staging workspace mirrors', async () => {
  const definitions = await readDefinitionsJson('stage_flags.json');
  const motifKeys = new Set();
  const motifFamilies = new Set();

  for (const flag of definitions.flags) {
    assert.equal(typeof flag.condition, 'string', `${flag.id} should have a condition`);
    assert.equal(typeof flag.question, 'string', `${flag.id} should have a question`);
    assert.ok(flag.condition.trim().length > 0, `${flag.id} condition should not be empty`);
    assert.ok(flag.question.trim().length > 0, `${flag.id} question should not be empty`);
    assert.doesNotMatch(flag.condition, /(?:で|から|に|へ|を|と|応え)。$/u, `${flag.id} condition should not end with a malformed trailing fragment`);
    assert.doesNotMatch(flag.question, /(?:で|から|に|へ|を|と|応え)か$/u, `${flag.id} question should not end with a malformed trailing fragment`);
    assert.equal(typeof flag.motif_key, 'string', `${flag.id} should keep a motif_key`);
    assert.ok(flag.motif_key.length > 0, `${flag.id} motif_key should not be empty`);
    assert.equal(typeof flag.motif_family, 'string', `${flag.id} should keep a motif_family`);
    assert.ok(flag.motif_family.length > 0, `${flag.id} motif_family should not be empty`);
    assert.equal(motifKeys.has(flag.motif_key), false, `${flag.id} motif_key should stay unique`);
    motifKeys.add(flag.motif_key);
    motifFamilies.add(flag.motif_family);
  }

  assert.equal(definitions.flags.some((flag) => flag.motif_family.startsWith('forbidden_archive_door::')), true);
  assert.equal(definitions.flags.some((flag) => flag.motif_family.startsWith('herbology_garden::')), true);
  assert.deepEqual(definitions.flags.filter((flag) => flag.reward_on_inventory_open?.item_id === 'eternel_cube').map((flag) => flag.id), ['stage.sealed_ritual_room.sealed_ritual_room_sealed_recipe_card']);
  assert.deepEqual(definitions.flags.filter((flag) => flag.reward_on_inventory_open?.item_id === 'necromancy_book').map((flag) => flag.id), ['stage.forbidden_archive.necromancy_book_found']);
  assert.deepEqual(definitions.flags.filter((flag) => flag.reward_on_inventory_open?.item_id === 'cleaning_golem_access_token').map((flag) => flag.id), ['stage.janitor_room_old_cabinet.cleaning_golem_access_token_found']);
});


test('inventory reward display data uses stage flag reward metadata only for already-owned items', async (t) => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['stage.herbology_garden.test_done'] = true;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  const definitions = await readJson(root, 'game_data/stage_flags.json');
  const herbologyFlag = definitions.flags.find((flag) => flag.id === 'stage.herbology_garden.test_done');
  herbologyFlag.reward_on_inventory_open = {
    item_id: 'pressed_leaf_ticket',
    quantity: 1,
    name: '押し葉の整理券',
    description: '薬草園テストの会話内容に対応する押し葉の整理券。'
  };
  await fs.writeFile(path.join(root, 'game_data/stage_flags.json'), JSON.stringify(definitions, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({
    money: 120,
    items: [{ item_id: 'pressed_leaf_ticket', quantity: 1 }]
  }, null, 2), 'utf8');
  const base = await withServer(t, root);

  const inventory = await jsonFetch(`${base}/api/inventory`);
  // A stage-reward ticket is neither a 購買 stat 霊薬 nor a self_boost (usable:false), and it is not a deliverable
  // gift (gift_category:null) — both additive server-authoritative action annotations.
  assert.deepEqual(inventory.items.find((item) => item.item_id === 'pressed_leaf_ticket'), {
    item_id: 'pressed_leaf_ticket',
    name: '押し葉の整理券',
    description: '薬草園テストの会話内容に対応する押し葉の整理券。',
    quantity: 1,
    sell_price: 0,
    usable: false,
    gift_category: null
  });
});

test('inventory open does not surface an unowned reward item solely because the stage flag is complete', async (t) => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['stage.herbology_garden.test_done'] = true;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  const definitions = await readJson(root, 'game_data/stage_flags.json');
  const herbologyFlag = definitions.flags.find((flag) => flag.id === 'stage.herbology_garden.test_done');
  herbologyFlag.reward_on_inventory_open = {
    item_id: 'pressed_leaf_ticket',
    quantity: 1,
    name: '押し葉の整理券',
    description: '薬草園テストの会話内容に対応する押し葉の整理券。'
  };
  await fs.writeFile(path.join(root, 'game_data/stage_flags.json'), JSON.stringify(definitions, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [] }, null, 2), 'utf8');
  const base = await withServer(t, root);

  const inventory = await jsonFetch(`${base}/api/inventory`);
  assert.equal(inventory.items.some((item) => item.item_id === 'pressed_leaf_ticket'), false);
});

test('debug flag API can toggle one stage flag and turn every stage flag on', async (t) => {
  const root = await fixtureRoot();
  const base = await withServer(t, root);

  const firstToggle = await jsonFetch(`${base}/api/flags/set`, {
    method: 'POST',
    body: { flag_id: 'stage.herbology_garden.test_done', active: true }
  });
  assert.equal(firstToggle.flags.find((flag) => flag.id === 'stage.herbology_garden.test_done').active, true);
  assert.equal((await readJson(root, 'game_data/runtime_state.json')).global_flags['stage.herbology_garden.test_done'], true);

  const secondToggle = await jsonFetch(`${base}/api/flags/set`, {
    method: 'POST',
    body: { flag_id: 'stage.herbology_garden.test_done', active: false }
  });
  assert.equal(secondToggle.flags.find((flag) => flag.id === 'stage.herbology_garden.test_done').active, false);
  assert.equal((await readJson(root, 'game_data/runtime_state.json')).global_flags['stage.herbology_garden.test_done'], false);

  const allOn = await jsonFetch(`${base}/api/flags/all-on`, { method: 'POST', body: {} });
  assert.equal(allOn.flags.every((flag) => flag.active === true), true);
  const state = await readJson(root, 'game_data/runtime_state.json');
  for (const flag of allOn.flags) assert.equal(state.global_flags[flag.id], true, `${flag.id} should be true`);
});

test('disabled stage flag judgment flow is skipped until re-enabled from debug API', async (t) => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.disabled_stage_flag_judgment_flows = {
    'stage.forbidden_archive.teatime_inside_done': true
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');

  const providerCalls = [];
  const firstResult = await finalizeConversation({
    root,
    conversationId: 'conv_forbidden_archive_teatime',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_stage_flow_disabled', character_id: conversation.character_id, type: 'relationship_change', text: 'リナと禁書庫のお茶会を約束した。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '禁書庫でお茶会を約束した', summary: 'リナと禁書庫でお茶会をする約束をした。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async ({ candidateFlags }) => {
      providerCalls.push(candidateFlags.map((flag) => flag.id));
      return { flag_results: candidateFlags.map((flag) => ({ flag_id: flag.id, achieved: true })) };
    },
    skillFlowRollProvider: () => 1
  });

  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], [
    'stage.forbidden_archive.necromancy_book_found',
    'stage.forbidden_archive.margin_starmap_bookmark_found'
  ]);
  assert.equal(firstResult.stage_flags.candidate_flags.some((flag) => flag.id === 'stage.forbidden_archive.teatime_inside_done'), false);
  assert.equal((await readJson(root, 'game_data/runtime_state.json')).global_flags['stage.forbidden_archive.teatime_inside_done'], false);

  const base = await withServer(t, root);
  const disabledStatus = await jsonFetch(`${base}/api/flags`);
  assert.equal(disabledStatus.flags.find((flag) => flag.id === 'stage.forbidden_archive.teatime_inside_done').judgment_flow_enabled, false);

  const enabledStatus = await jsonFetch(`${base}/api/flags/judgment-flow`, {
    method: 'POST',
    body: { flag_id: 'stage.forbidden_archive.teatime_inside_done', enabled: true }
  });
  assert.equal(enabledStatus.flags.find((flag) => flag.id === 'stage.forbidden_archive.teatime_inside_done').judgment_flow_enabled, true);
  assert.deepEqual((await readJson(root, 'game_data/runtime_state.json')).disabled_stage_flag_judgment_flows, {});
});

test('conversation finalization judges event flags after stage flags when flag and inventory prerequisites are met', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'herbology_garden';
  state.global_flags['stage.forbidden_archive.teatime_inside_done'] = false;
  state.global_flags['story.archive_intro_done'] = true;
  state.global_flags['event.school_festival_promise.ready'] = false;
  state.global_flags['event.school_festival_promise.completed'] = false;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({
    money: 120,
    items: [{ item_id: 'fairy_doll', quantity: 1 }]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'event.school_festival_promise.ready',
        label: '禁書庫のお茶会イベント準備',
        condition: '妖精さんの人形を持ち、リナと禁書庫でのお茶会を約束する。',
        question: 'リナと禁書庫でのお茶会をする約束が成立したか',
        required_global_flags: ['story.archive_intro_done'],
        required_inventory_items: [{ item_id: 'fairy_doll', quantity: 1 }],
        completed_flag_id: 'event.school_festival_promise.completed'
      },
      {
        id: 'event.missing_item.ready',
        label: '未所持アイテムイベント',
        condition: '未所持アイテムが必要。',
        required_inventory_items: [{ item_id: 'missing_key', quantity: 1 }]
      },
      {
        id: 'event.missing_flag.ready',
        label: '未成立フラグイベント',
        condition: '未成立フラグが必要。',
        required_global_flags: ['story.not_ready']
      }
    ]
  }, null, 2), 'utf8');

  const order = [];
  const eventProviderCalls = [];
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_forbidden_archive_teatime',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_event_test', character_id: conversation.character_id, type: 'relationship_change', text: 'リナと禁書庫のお茶会を約束した。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '禁書庫でお茶会を約束した', summary: 'リナと禁書庫でお茶会をする約束をした。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => {
      order.push('stage');
      return { flag_results: [{ flag_id: 'stage.forbidden_archive.teatime_inside_done', achieved: true }] };
    },
    eventFlagJudgmentProvider: async ({ candidateFlags, conversation }) => {
      order.push('event');
      eventProviderCalls.push({ candidateFlags, conversation });
      return { flag_results: [{ flag_id: 'event.school_festival_promise.ready', achieved: true }] };
    },
    skillFlowRollProvider: () => 1
  });

  assert.deepEqual(order, ['stage', 'event']);
  assert.equal(eventProviderCalls.length, 1);
  assert.deepEqual(eventProviderCalls[0].candidateFlags.map((flag) => flag.id), ['event.school_festival_promise.ready']);
  assert.equal(eventProviderCalls[0].conversation.location_id, 'forbidden_archive_door', 'event flags should not be filtered by conversation location');
  assert.equal(result.event_flags.accepted[0].flag_id, 'event.school_festival_promise.ready');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['stage.forbidden_archive.teatime_inside_done'], true);
  assert.equal(nextState.global_flags['event.school_festival_promise.ready'], true);
  assert.deepEqual(nextState.event_flag_sources['event.school_festival_promise.ready'], {
    character_id: 'lina',
    conversation_id: 'conv_forbidden_archive_teatime',
    achieved_at: '2026-05-06T13:11:00.000+09:00'
  });
  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.items.find((item) => item.item_id === 'fairy_doll').quantity, 2, 'event flags should not consume inventory items');
  const eventLog = await readJson(root, 'game_data/logs/event_flag_judgments/conv_forbidden_archive_teatime.json');
  assert.deepEqual(eventLog.candidate_flags.map((flag) => flag.id), ['event.school_festival_promise.ready']);
  await fs.rm(root, { recursive: true, force: true });
});


test('snow, rain, and mirror events become ready and pending when judged as achieved', async () => {
  const cases = [
    {
      readyFlagId: 'event.snow_topic_followup.ready',
      completedFlagId: 'event.snow_topic_followup.completed',
      locationId: 'snowy_inner_garden',
      prompt: '雪の中庭に移る前の会話をする。',
      conversationId: 'conv_snow_topic_source',
      label: '雪の話',
      memoryText: 'リナは主人公と雪の話をした。',
      workRecordTitle: '雪の話をした',
      workRecordSummary: '主人公とリナは雪の話をした。'
    },
    {
      readyFlagId: 'event.rain_topic_followup.ready',
      completedFlagId: 'event.rain_topic_followup.completed',
      locationId: 'rainy_cloister',
      prompt: '雨の回廊に移る前の会話をする。',
      conversationId: 'conv_rain_topic_source',
      label: '雨の話',
      memoryText: 'リナは主人公と雨の話をした。',
      workRecordTitle: '雨の話をした',
      workRecordSummary: '主人公とリナは雨の話をした。'
    },
    {
      readyFlagId: 'event.heart_mirror_topic_followup.ready',
      completedFlagId: 'event.heart_mirror_topic_followup.completed',
      locationId: 'mirror_hall',
      prompt: '鏡の間に移る前の会話をする。',
      conversationId: 'conv_heart_mirror_topic_source',
      label: '心を映す鏡の話',
      memoryText: 'リナは主人公と心を映す鏡の話をした。',
      workRecordTitle: '心を映す鏡の話をした',
      workRecordSummary: '主人公とリナは心を映す鏡の話をした。'
    }
  ];

  for (const [index, event] of cases.entries()) {
    const root = await fixtureRoot(`magic-adv-extra-event-ready-${index}-`);
    const state = await readJson(root, 'game_data/runtime_state.json');
    state.current_location_id = 'forbidden_archive_door';
    state.current_interaction_character_id = 'lina';
    state.global_flags[event.readyFlagId] = false;
    state.global_flags[event.completedFlagId] = false;
    await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
    await fs.writeFile(path.join(root, `game_data/logs/conversations/${event.conversationId}.json`), JSON.stringify({
      id: event.conversationId,
      character_id: 'lina',
      character_name: 'リナ・クラウゼ',
      created_at: '2026-05-08T15:00:00.000+09:00',
      updated_at: '2026-05-08T15:10:00.000+09:00',
      source_type: 'field',
      location_id: 'forbidden_archive_door',
      time_slot: 'after_school',
      prompt: event.prompt,
      messages: [
        { role: 'user', content: `${event.label}につながる話を続けよう。` },
        { role: 'assistant', content: `リナは${event.label}につながるやり取りを受け止め、主人公とその話を深めた。` }
      ]
    }, null, 2), 'utf8');

    const eventProviderCalls = [];
    const result = await finalizeConversation({
      root,
      conversationId: event.conversationId,
      characterId: 'lina',
      now: '2026-05-08T15:11:00.000+09:00',
      memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: `mem_${index}_event_ready`, character_id: conversation.character_id, type: 'relationship_change', text: event.memoryText, source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
      skillUpdateProvider: async () => ({ skipped: true }),
      workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: event.workRecordTitle, summary: event.workRecordSummary, flag_update_candidates: [], warnings: [] } }),
      stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
      eventFlagJudgmentProvider: async ({ candidateFlags, conversation }) => {
        eventProviderCalls.push({ candidateFlags, conversation });
        return { flag_results: [{ flag_id: event.readyFlagId, achieved: true, reason: `${event.label}が成立した` }] };
      },
      skillFlowRollProvider: () => 1
    });

    assert.equal(eventProviderCalls.length, 1);
    assert.equal(eventProviderCalls[0].candidateFlags.some((flag) => flag.id === event.readyFlagId), true, event.readyFlagId);
    assert.equal(result.event_flags.accepted[0].flag_id, event.readyFlagId);
    const nextState = await readJson(root, 'game_data/runtime_state.json');
    assert.equal(nextState.global_flags[event.readyFlagId], true);
    assert.deepEqual(nextState.event_flag_sources[event.readyFlagId], {
      character_id: 'lina',
      conversation_id: event.conversationId,
      achieved_at: '2026-05-08T15:11:00.000+09:00'
    });
    const status = await getEventFlagStatus({ root });
    const pendingEvent = status.pending_events.find((candidate) => candidate.id === event.readyFlagId);
    assert.equal(Boolean(pendingEvent), true, event.readyFlagId);
    assert.equal(pendingEvent.character_id, 'lina');
    assert.equal(pendingEvent.interaction.location_id, event.locationId);
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('event participant override lets preparation dialogue replace the ready event companion', async () => {
  const root = await fixtureRoot('magic-adv-event-participant-override-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['knowledge.necromancer_sealed_in_ritual_room_discussed'] = true;
  state.global_flags['event.necromancer_seal_released.ready'] = true;
  state.global_flags['event.necromancer_seal_released.completed'] = false;
  state.event_flag_sources = {
    'event.necromancer_seal_released.ready': {
      character_id: 'mira',
      conversation_id: 'conv_old_mira_preparation',
      achieved_at: '2026-05-06T12:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [{ item_id: 'necromancy_book', quantity: 1 }] }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'event.necromancer_seal_released.ready',
        label: 'ネクロマンサーの封印解除',
        condition: '死霊術の本を持った状態で、伝説のネクロマンサーが封印儀式室に封印されている話をしていること。',
        question: '主人公と会話相手が伝説のネクロマンサーの封印を解く準備について話したか',
        required_global_flags: ['knowledge.necromancer_sealed_in_ritual_room_discussed'],
        required_inventory_items: [{ item_id: 'necromancy_book', quantity: 1 }],
        completed_flag_id: 'event.necromancer_seal_released.completed',
        auto_ready_when_prerequisites_met: true,
        participant_override_judgment: {
          condition: 'ネクロマンサーの封印解除イベントへ会話相手と向かう準備描写が成立していること。',
          question: '主人公と会話相手が、ネクロマンサーの封印解除イベントへ一緒に向かう準備について話したか'
        },
        interaction: { location_id: 'unsealed_necromancer_ritual_room', source_type: 'event', opening_context: 'ネクロマンサーの封印解除イベント。' }
      }
    ]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_forbidden_archive_teatime.json'), JSON.stringify({
    id: 'conv_forbidden_archive_teatime',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-06T13:00:00.000+09:00',
    updated_at: '2026-05-06T13:10:00.000+09:00',
    source_type: 'field',
    location_id: 'forbidden_archive_door',
    time_slot: 'after_school',
    prompt: '禁書庫前で会話する。',
    messages: [
      { role: 'user', content: '封印解除はリナと一緒に行きたい。準備して封印儀式室へ向かおう。' },
      { role: 'assistant', content: 'リナはうなずき、死霊術の本を抱えて一緒に封印儀式室へ向かう準備を整えた。' }
    ]
  }, null, 2), 'utf8');

  const definitions = await loadEventFlags({ root });
  const beforeTargets = selectEventParticipantOverrideJudgmentTargets({
    flags: definitions.flags,
    state,
    inventory: { items: [{ item_id: 'necromancy_book', quantity: 1 }] },
    conversation: { id: 'conv_forbidden_archive_teatime', character_id: 'lina' }
  });
  assert.deepEqual(beforeTargets.map((flag) => [flag.id, flag.question]), [
    ['event.necromancer_seal_released.ready', '主人公と会話相手が、ネクロマンサーの封印解除イベントへ一緒に向かう準備について話したか']
  ]);

  const overrideProviderCalls = [];
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_forbidden_archive_teatime',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_event_participant_override_test', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と封印解除へ向かう準備をした。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '封印解除に向かう準備をした', summary: '主人公とリナはネクロマンサーの封印解除へ一緒に向かう準備をした。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventParticipantOverrideJudgmentProvider: async ({ candidateFlags, conversation }) => {
      overrideProviderCalls.push({ candidateFlags, conversation });
      return { flag_results: [{ flag_id: 'event.necromancer_seal_released.ready', achieved: true }] };
    },
    skillFlowRollProvider: () => 1
  });

  assert.equal(overrideProviderCalls.length, 1);
  assert.deepEqual(overrideProviderCalls[0].candidateFlags.map((flag) => flag.id), ['event.necromancer_seal_released.ready']);
  assert.equal(result.event_participant_overrides.accepted[0].flag_id, 'event.necromancer_seal_released.ready');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.deepEqual(nextState.event_flag_sources['event.necromancer_seal_released.ready'], {
    character_id: 'lina',
    conversation_id: 'conv_forbidden_archive_teatime',
    achieved_at: '2026-05-06T13:11:00.000+09:00',
    participant_override: true,
    previous_character_id: 'mira',
    previous_conversation_id: 'conv_old_mira_preparation'
  });
  const started = await startEventFlagInteraction({ root, flagId: 'event.necromancer_seal_released.ready' });
  assert.equal(started.character_id, 'lina');
  const overrideLog = await readJson(root, 'game_data/logs/event_participant_override_judgments/conv_forbidden_archive_teatime.json');
  assert.deepEqual(overrideLog.candidate_flags.map((flag) => flag.id), ['event.necromancer_seal_released.ready']);
  await fs.rm(root, { recursive: true, force: true });
});


test('event participant override can run after final knowledge before key item acquisition', async () => {
  const root = await fixtureRoot('magic-adv-event-participant-override-before-item-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['knowledge.necromancer_sealed_in_ritual_room_discussed'] = true;
  state.global_flags['knowledge.dragon_blood_under_crystal_cave_discussed'] = true;
  state.global_flags['knowledge.runaway_cleaning_golem_discussed'] = true;
  state.global_flags['event.necromancer_seal_released.completed'] = false;
  state.global_flags['event.age_of_gods_elixir_brewing.completed'] = false;
  state.global_flags['event.cleaning_golem_shutdown.completed'] = false;
  state.event_flag_sources = {
    'knowledge.necromancer_sealed_in_ritual_room_discussed': {
      character_id: 'mira',
      conversation_id: 'conv_mira_necromancer_stage3',
      achieved_at: '2026-05-06T12:00:00.000+09:00'
    },
    'knowledge.dragon_blood_under_crystal_cave_discussed': {
      character_id: 'mira',
      conversation_id: 'conv_mira_elixir_stage3',
      achieved_at: '2026-05-06T12:10:00.000+09:00'
    },
    'knowledge.runaway_cleaning_golem_discussed': {
      character_id: 'mira',
      conversation_id: 'conv_mira_golem_stage3',
      achieved_at: '2026-05-06T12:20:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [] }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_stage3_pre_item_preparation.json'), JSON.stringify({
    id: 'conv_stage3_pre_item_preparation',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-06T13:00:00.000+09:00',
    updated_at: '2026-05-06T13:10:00.000+09:00',
    source_type: 'field',
    location_id: 'old_corridor',
    time_slot: 'after_school',
    prompt: '旧廊下で会話する。',
    messages: [
      { role: 'user', content: '死霊術の本や龍の血やアクセストークンを探しに行く前に、イベントはリナと一緒に行く準備をしておきたい。ネクロマンサーもパナケイアも掃除ゴーレムも一緒に向かおう。' },
      { role: 'assistant', content: 'リナはうなずき、必要なキーアイテムが見つかったら三つの件を一緒に進める準備を整えた。' }
    ]
  }, null, 2), 'utf8');

  const definitions = await loadEventFlags({ root });
  const beforeTargets = selectEventParticipantOverrideJudgmentTargets({
    flags: definitions.flags,
    state,
    inventory: { items: [] },
    conversation: { id: 'conv_stage3_pre_item_preparation', character_id: 'lina' }
  });
  assert.deepEqual(beforeTargets.map((flag) => flag.id).sort(), [
    'event.age_of_gods_elixir_brewing.ready',
    'event.cleaning_golem_shutdown.ready',
    'event.necromancer_seal_released.ready'
  ].sort());

  const overrideProviderCalls = [];
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_stage3_pre_item_preparation',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_event_participant_override_before_item_test', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公とキーアイテム入手後にイベントへ向かう準備をした。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: 'イベント同行準備をした', summary: '主人公とリナはキーアイテム入手後にネクロマンサー、パナケイア、掃除ゴーレムの各イベントへ一緒に向かう準備をした。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventParticipantOverrideJudgmentProvider: async ({ candidateFlags, conversation }) => {
      overrideProviderCalls.push({ candidateFlags, conversation });
      return { flag_results: candidateFlags.map((flag) => ({ flag_id: flag.id, achieved: true })) };
    },
    skillFlowRollProvider: () => 1
  });

  assert.equal(overrideProviderCalls.length, 1);
  assert.deepEqual(overrideProviderCalls[0].candidateFlags.map((flag) => flag.id).sort(), beforeTargets.map((flag) => flag.id).sort());
  assert.deepEqual(result.event_participant_overrides.accepted.map((entry) => entry.flag_id).sort(), beforeTargets.map((flag) => flag.id).sort());
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  for (const flagId of beforeTargets.map((flag) => flag.id)) {
    assert.equal(nextState.global_flags[flagId], undefined, `${flagId} should not become ready before its key item is owned`);
    assert.equal(nextState.event_flag_sources[flagId].character_id, 'lina');
    assert.equal(nextState.event_flag_sources[flagId].conversation_id, 'conv_stage3_pre_item_preparation');
    assert.equal(nextState.event_flag_sources[flagId].participant_override, true);
    assert.equal(nextState.event_flag_sources[flagId].previous_character_id, 'mira');
  }
  const statusWithoutItems = await getEventFlagStatus({ root });
  assert.equal(statusWithoutItems.pending_events.some((entry) => beforeTargets.map((flag) => flag.id).includes(entry.id)), false, 'events should remain not pending until their key items are owned');
  await fs.rm(root, { recursive: true, force: true });
});


test('knowledge-driven world text activates from current world settings without staging workspace mirrors', async () => {
  const root = await fixtureRoot('magic-adv-world-text-live-');
  await fs.copyFile(path.join(definitionsRoot, 'world/settings.json'), path.join(root, 'game_data/world/settings.json'));

  const base = await loadWorldSettings({ root, state: { global_flags: {} } });
  assert.doesNotMatch(base.world_description, /伝説のネクロマンサーは封印儀式室に封印されている/);

  const withLegend = await loadWorldSettings({
    root,
    state: { global_flags: { 'knowledge.legendary_necromancer_discussed': true } }
  });
  assert.match(withLegend.world_description, /伝説のネクロマンサーは封印儀式室に封印されている/);
  assert.doesNotMatch(withLegend.world_description, /死霊術の本が必要/);

  const withSealLore = await loadWorldSettings({
    root,
    state: { global_flags: { 'knowledge.necromancer_sealed_in_ritual_room_discussed': true } }
  });
  assert.match(withSealLore.world_description, /死霊術の本が必要/);
});


test('opening mentor intro is seeded mechanically and skipped by conversation-end event judgment', async () => {
  const eventDefinitions = await loadEventFlags({ root: stagingRoot });
  const openingMentor = eventDefinitions.flags.find((entry) => entry.id === 'event.opening_mentor_intro.ready');

  assert.equal(openingMentor.conversation_end_judgment, false);
  assert.equal(selectEventFlagJudgmentTargets({
    flags: eventDefinitions.flags,
    state: { global_flags: {}, event_flag_sources: {} },
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.opening_mentor_intro.ready'), false, 'opening mentor readiness is seeded by new game state, not inferred by an LLM from ordinary conversation evidence');
});

test('auto-ready elixir event definition keeps observable prerequisites and completes on event conversation end', async () => {
  const definitions = await readDefinitionsJson('event_flags.json');
  const ready = definitions.flags.find((entry) => entry.id === 'event.age_of_gods_elixir_brewing.ready');

  assert.equal(ready.label, '神代のパナケイアの調合');
  assert.deepEqual(ready.required_global_flags, ['knowledge.dragon_blood_under_crystal_cave_discussed']);
  assert.deepEqual(ready.required_inventory_items, [{ item_id: 'dragon_blood', quantity: 1 }]);
  assert.equal(ready.completed_flag_id, 'event.age_of_gods_elixir_brewing.completed');
  assert.equal(ready.complete_on_conversation_end, true);
  assert.equal(ready.auto_ready_when_prerequisites_met, true);
  assert.equal(ready.interaction.location_id, 'age_of_gods_elixir_brewing_stage');
  assert.match(ready.interaction.opening_context, /龍の血/);
  assert.equal(ready.completion_judgment, undefined);

  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: { 'knowledge.dragon_blood_under_crystal_cave_discussed': true }, event_flag_sources: {} },
    inventory: { items: [{ item_id: 'dragon_blood', quantity: 1 }] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.age_of_gods_elixir_brewing.ready'), false, 'auto-ready event should not create a conversation-end ready judgment flow');

  const root = await fixtureRoot('magic-adv-elixir-auto-ready-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['knowledge.dragon_blood_under_crystal_cave_discussed'] = true;
  state.event_flag_sources = {
    'knowledge.dragon_blood_under_crystal_cave_discussed': {
      character_id: 'lina',
      conversation_id: 'conv_dragon_blood_lore',
      achieved_at: '2026-05-09T12:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [{ item_id: 'dragon_blood', quantity: 1 }] }, null, 2), 'utf8');
  await fs.mkdir(path.join(root, 'game_data/characters/lina/work_records'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/characters/lina/work_records/wr_conv_dragon_blood_lore.md'), '# 龍の血の出所\n\n龍の血は水晶洞の地下で見つかると共有した。\n', 'utf8');

  const status = await getEventFlagStatus({ root });
  const pendingElixir = status.pending_events.find((entry) => entry.id === 'event.age_of_gods_elixir_brewing.ready');
  assert.equal(pendingElixir?.character_id, 'lina');
  assert.equal(pendingElixir?.source_conversation_id, 'conv_dragon_blood_lore');

  const started = await startEventFlagInteraction({ root, flagId: 'event.age_of_gods_elixir_brewing.ready' });
  assert.equal(started.location_id, 'age_of_gods_elixir_brewing_stage');
  assert.equal(started.character_id, 'lina');
  assert.equal(started.state.pending_interaction_context.source_type, 'event');
  assert.equal(started.state.pending_interaction_context.event_flag_id, 'event.age_of_gods_elixir_brewing.ready');
  assert.equal(started.state.pending_interaction_context.source_conversation_id, 'conv_dragon_blood_lore');
  assert.match(started.state.pending_interaction_context.opening_context, /龍の血/);

  const opening = await runConversationOpening({
    root,
    id: 'conv_age_of_gods_elixir_opening',
    characterId: 'lina',
    now: '2026-05-09T12:05:00.000+09:00',
    chatProvider: async () => '龍の血を慎重に注ごう。'
  });
  assert.equal(opening.conversation.source_type, 'event');
  assert.equal(opening.conversation.event_flag_id, 'event.age_of_gods_elixir_brewing.ready');
  assert.equal(opening.conversation.location_id, 'age_of_gods_elixir_brewing_stage');
  assert.equal(opening.conversation.source_conversation_id, 'conv_dragon_blood_lore');
  assert.match(opening.conversation.prompt, /イベント文脈: .*龍の血/);
  assert.match(opening.conversation.prompt, /成立元会話ワークレコード:/);
  assert.match(opening.conversation.prompt, /龍の血は水晶洞の地下で見つかる/);

  await fs.rm(root, { recursive: true, force: true });
});

test('necromancer event completion is judged only in the unsealed ritual room and writes the completed flag', async () => {
  const root = await fixtureRoot('magic-adv-event-completion-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'unsealed_necromancer_ritual_room';
  state.global_flags['event.necromancer_seal_released.ready'] = true;
  state.global_flags['event.necromancer_seal_released.completed'] = false;
  state.event_flag_sources = {
    'event.necromancer_seal_released.ready': {
      character_id: 'lina',
      conversation_id: 'conv_necromancer_battle',
      achieved_at: '2026-05-06T12:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'event.necromancer_seal_released.ready',
        label: 'ネクロマンサーの封印解除',
        condition: '死霊術の本を持った状態で、伝説のネクロマンサーが封印儀式室に封印されている話をしていること。',
        question: '主人公と会話相手が伝説のネクロマンサーの封印を解く準備について具体的に話したか',
        required_inventory_items: [{ item_id: 'necromancy_book', quantity: 1 }],
        completed_flag_id: 'event.necromancer_seal_released.completed',
        interaction: { location_id: 'unsealed_necromancer_ritual_room', source_type: 'event', opening_context: 'ネクロマンサーの封印解除イベント。' },
        completion_judgment: {
          location_id: 'unsealed_necromancer_ritual_room',
          completed_flag_id: 'event.necromancer_seal_released.completed',
          condition: 'ネクロマンサーの封印が解かれた儀式の間で、伝説のネクロマンサーを倒すこと。',
          question: '主人公と会話相手が伝説のネクロマンサーを倒したか'
        }
      }
    ]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_necromancer_battle.json'), JSON.stringify({
    id: 'conv_necromancer_battle',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-06T13:00:00.000+09:00',
    updated_at: '2026-05-06T13:10:00.000+09:00',
    source_type: 'event',
    location_id: 'unsealed_necromancer_ritual_room',
    time_slot: 'after_school',
    prompt: '封印が解かれた儀式の間で会話する。',
    messages: [
      { role: 'user', content: '今だ、光で核を砕くよ。' },
      { role: 'assistant', content: 'リナは光を重ね、ネクロマンサーの核が崩れ落ちるのを確認した。' }
    ]
  }, null, 2), 'utf8');

  const order = [];
  const completionProviderCalls = [];
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_necromancer_battle',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_event_completion_test', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公とネクロマンサーを倒した。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: 'ネクロマンサーを倒した', summary: '主人公とリナは封印が解かれた儀式の間でネクロマンサーを倒した。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => { order.push('stage'); return { flag_results: [] }; },
    eventFlagJudgmentProvider: async () => { order.push('event'); return { flag_results: [] }; },
    eventCompletionJudgmentProvider: async ({ candidateFlags, conversation }) => {
      order.push('completion');
      completionProviderCalls.push({ candidateFlags, conversation });
      return { flag_results: [{ flag_id: 'event.necromancer_seal_released.ready', achieved: true }] };
    },
    skillFlowRollProvider: () => 1
  });

  assert.deepEqual(order, ['completion']);
  assert.equal(completionProviderCalls.length, 1);
  assert.deepEqual(completionProviderCalls[0].candidateFlags.map((flag) => [flag.id, flag.completion_flag_id, flag.question]), [
    ['event.necromancer_seal_released.ready', 'event.necromancer_seal_released.completed', '主人公と会話相手が伝説のネクロマンサーを倒したか']
  ]);
  assert.equal(result.event_completions.accepted[0].completed_flag_id, 'event.necromancer_seal_released.completed');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.necromancer_seal_released.completed'], true);
  assert.deepEqual(nextState.event_completion_sources['event.necromancer_seal_released.completed'], {
    event_flag_id: 'event.necromancer_seal_released.ready',
    character_id: 'lina',
    conversation_id: 'conv_necromancer_battle',
    achieved_at: '2026-05-06T13:11:00.000+09:00'
  });
  const completionLog = await readJson(root, 'game_data/logs/event_completion_judgments/conv_necromancer_battle.json');
  assert.deepEqual(completionLog.candidate_flags.map((flag) => flag.id), ['event.necromancer_seal_released.ready']);
  await fs.rm(root, { recursive: true, force: true });
});

test('school festival promise event completes when its event conversation ends without an LLM completion judgment', async () => {
  const root = await fixtureRoot('magic-adv-school-festival-complete-on-end-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'festival_plaza_night';
  state.current_interaction_character_id = 'lina';
  state.global_flags['event.school_festival_promise.ready'] = true;
  state.global_flags['event.school_festival_promise.completed'] = false;
  state.event_flag_sources = {
    'event.school_festival_promise.ready': {
      character_id: 'lina',
      conversation_id: 'conv_school_festival_promise_source',
      achieved_at: '2026-05-08T12:00:00.000+09:00'
    }
  };
  state.pending_interaction_context = {
    source_type: 'event',
    event_flag_id: 'event.school_festival_promise.ready',
    event_label: '学院祭の約束',
    source_conversation_id: 'conv_school_festival_promise_source',
    opening_context: '学院祭の約束イベント。'
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'event.school_festival_promise.ready',
        label: '学院祭の約束',
        condition: '学院祭に一緒に行く約束をすること。',
        question: '主人公と会話相手が学院祭に一緒に行く約束をしたか',
        completed_flag_id: 'event.school_festival_promise.completed',
        complete_on_conversation_end: true,
        interaction: { location_id: 'festival_plaza_night', source_type: 'event', opening_context: '学院祭の約束イベント。' }
      }
    ]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_school_festival_event.json'), JSON.stringify({
    id: 'conv_school_festival_event',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-08T13:00:00.000+09:00',
    updated_at: '2026-05-08T13:10:00.000+09:00',
    source_type: 'event',
    location_id: 'festival_plaza_night',
    time_slot: 'after_school',
    prompt: '夜祭の広場で会話する。',
    messages: [
      { role: 'user', content: '今日は一緒に回れてよかった。' },
      { role: 'assistant', content: 'リナは小さく頷き、また来年も来ようと笑った。' }
    ]
  }, null, 2), 'utf8');

  let completionProviderCalled = false;
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_school_festival_event',
    characterId: 'lina',
    now: '2026-05-08T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_school_festival_end', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と学院祭を一緒に過ごした。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '学院祭を一緒に過ごした', summary: '主人公とリナは学院祭の約束イベントを終えた。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventCompletionJudgmentProvider: async () => { completionProviderCalled = true; return { flag_results: [] }; },
    skillFlowRollProvider: () => 1
  });

  assert.equal(completionProviderCalled, false, 'conversation-end completion should not ask the LLM to rejudge the event');
  assert.equal(result.event_completions.accepted[0].completed_flag_id, 'event.school_festival_promise.completed');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.school_festival_promise.completed'], true);
  assert.deepEqual(nextState.event_completion_sources['event.school_festival_promise.completed'], {
    event_flag_id: 'event.school_festival_promise.ready',
    character_id: 'lina',
    conversation_id: 'conv_school_festival_event',
    achieved_at: '2026-05-08T13:11:00.000+09:00',
    completed_on_conversation_end: true
  });
  const completionLog = await readJson(root, 'game_data/logs/event_completion_judgments/conv_school_festival_event.json');
  assert.deepEqual(completionLog.accepted.map((flag) => flag.completed_flag_id), ['event.school_festival_promise.completed']);
  await fs.rm(root, { recursive: true, force: true });
});

test('artificial spirit crafting promise event completes when its event conversation ends without an LLM completion judgment', async () => {
  const root = await fixtureRoot('magic-adv-artificial-spirit-complete-on-end-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'magic_tool_workshop';
  state.current_interaction_character_id = 'lina';
  state.global_flags['event.artificial_spirit_crafting_promise.ready'] = true;
  state.global_flags['event.artificial_spirit_crafting_promise.completed'] = false;
  state.event_flag_sources = {
    'event.artificial_spirit_crafting_promise.ready': {
      character_id: 'lina',
      conversation_id: 'conv_artificial_spirit_promise_source',
      achieved_at: '2026-05-08T12:30:00.000+09:00'
    }
  };
  state.pending_interaction_context = {
    source_type: 'event',
    event_flag_id: 'event.artificial_spirit_crafting_promise.ready',
    event_label: '人工精霊づくりの約束',
    source_conversation_id: 'conv_artificial_spirit_promise_source'
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_artificial_spirit_event.json'), JSON.stringify({
    id: 'conv_artificial_spirit_event',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-08T13:20:00.000+09:00',
    updated_at: '2026-05-08T13:30:00.000+09:00',
    source_type: 'event',
    location_id: 'magic_tool_workshop',
    time_slot: 'after_school',
    prompt: '魔道具工房で会話する。',
    messages: [
      { role: 'user', content: 'まずは小さな灯りに反応する人工精霊から作ってみよう。' },
      { role: 'assistant', content: 'リナは工具を並べ、核にする術式の組み方を一緒に考えようと応じた。' }
    ]
  }, null, 2), 'utf8');

  let completionProviderCalled = false;
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_artificial_spirit_event',
    characterId: 'lina',
    now: '2026-05-08T13:31:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_artificial_spirit_end', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と人工精霊づくりに取り組んだ。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '人工精霊づくりの約束イベントを終えた', summary: '主人公とリナは人工精霊づくりの約束イベントを終えた。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventCompletionJudgmentProvider: async () => { completionProviderCalled = true; return { flag_results: [] }; },
    skillFlowRollProvider: () => 1
  });

  assert.equal(completionProviderCalled, false, 'conversation-end completion should not ask the LLM to rejudge the event');
  assert.equal(result.event_completions.accepted[0].completed_flag_id, 'event.artificial_spirit_crafting_promise.completed');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.artificial_spirit_crafting_promise.completed'], true);
  assert.deepEqual(nextState.event_completion_sources['event.artificial_spirit_crafting_promise.completed'], {
    event_flag_id: 'event.artificial_spirit_crafting_promise.ready',
    character_id: 'lina',
    conversation_id: 'conv_artificial_spirit_event',
    achieved_at: '2026-05-08T13:31:00.000+09:00',
    completed_on_conversation_end: true
  });
  const completionLog = await readJson(root, 'game_data/logs/event_completion_judgments/conv_artificial_spirit_event.json');
  assert.deepEqual(completionLog.accepted.map((flag) => flag.completed_flag_id), ['event.artificial_spirit_crafting_promise.completed']);
  await fs.rm(root, { recursive: true, force: true });
});

test('natural spirit search promise event completes when its event conversation ends without an LLM completion judgment', async () => {
  const root = await fixtureRoot('magic-adv-natural-spirit-complete-on-end-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'herbology_garden';
  state.current_interaction_character_id = 'lina';
  state.global_flags['event.natural_spirit_search_promise.ready'] = true;
  state.global_flags['event.natural_spirit_search_promise.completed'] = false;
  state.event_flag_sources = {
    'event.natural_spirit_search_promise.ready': {
      character_id: 'lina',
      conversation_id: 'conv_natural_spirit_promise_source',
      achieved_at: '2026-05-08T12:45:00.000+09:00'
    }
  };
  state.pending_interaction_context = {
    source_type: 'event',
    event_flag_id: 'event.natural_spirit_search_promise.ready',
    event_label: '天然精霊探しの約束',
    source_conversation_id: 'conv_natural_spirit_promise_source'
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_natural_spirit_event.json'), JSON.stringify({
    id: 'conv_natural_spirit_event',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-08T13:40:00.000+09:00',
    updated_at: '2026-05-08T13:50:00.000+09:00',
    source_type: 'event',
    location_id: 'herbology_garden',
    time_slot: 'after_school',
    prompt: '薬草温室で会話する。',
    messages: [
      { role: 'user', content: '温室の光に集まる気配を追って、天然精霊の手がかりを探してみよう。' },
      { role: 'assistant', content: 'リナは葉の陰に揺れる魔力粒を見つめながら、まずは足跡になりそうな反応を一緒に追おうと応じた。' }
    ]
  }, null, 2), 'utf8');

  let completionProviderCalled = false;
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_natural_spirit_event',
    characterId: 'lina',
    now: '2026-05-08T13:51:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_natural_spirit_end', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と天然精霊探しに取り組んだ。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '天然精霊探しの約束イベントを終えた', summary: '主人公とリナは天然精霊探しの約束イベントを終えた。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventCompletionJudgmentProvider: async () => { completionProviderCalled = true; return { flag_results: [] }; },
    skillFlowRollProvider: () => 1
  });

  assert.equal(completionProviderCalled, false, 'conversation-end completion should not ask the LLM to rejudge the event');
  assert.equal(result.event_completions.accepted[0].completed_flag_id, 'event.natural_spirit_search_promise.completed');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.natural_spirit_search_promise.completed'], true);
  assert.deepEqual(nextState.event_completion_sources['event.natural_spirit_search_promise.completed'], {
    event_flag_id: 'event.natural_spirit_search_promise.ready',
    character_id: 'lina',
    conversation_id: 'conv_natural_spirit_event',
    achieved_at: '2026-05-08T13:51:00.000+09:00',
    completed_on_conversation_end: true
  });
  const completionLog = await readJson(root, 'game_data/logs/event_completion_judgments/conv_natural_spirit_event.json');
  assert.deepEqual(completionLog.accepted.map((flag) => flag.completed_flag_id), ['event.natural_spirit_search_promise.completed']);
  await fs.rm(root, { recursive: true, force: true });
});

test('stargazing promise event completes when its event conversation ends without an LLM completion judgment', async () => {
  const root = await fixtureRoot('magic-adv-stargazing-complete-on-end-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'astronomy_tower_observatory';
  state.current_interaction_character_id = 'lina';
  state.global_flags['event.stargazing_promise.ready'] = true;
  state.global_flags['event.stargazing_promise.completed'] = false;
  state.event_flag_sources = {
    'event.stargazing_promise.ready': {
      character_id: 'lina',
      conversation_id: 'conv_stargazing_promise_source',
      achieved_at: '2026-05-08T14:30:00.000+09:00'
    }
  };
  state.pending_interaction_context = {
    source_type: 'event',
    event_flag_id: 'event.stargazing_promise.ready',
    event_label: '天体観測の約束',
    source_conversation_id: 'conv_stargazing_promise_source'
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_stargazing_event.json'), JSON.stringify({
    id: 'conv_stargazing_event',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-08T14:40:00.000+09:00',
    updated_at: '2026-05-08T14:50:00.000+09:00',
    source_type: 'event',
    location_id: 'astronomy_tower_observatory',
    time_slot: 'night',
    prompt: '天文塔の観測室で会話する。',
    messages: [
      { role: 'user', content: '今夜は北の空から見て、魔力の尾を引く星も探してみよう。' },
      { role: 'assistant', content: 'リナは星図を広げ、まずは望遠鏡の角度を合わせてからゆっくり追ってみようと応じた。' }
    ]
  }, null, 2), 'utf8');

  let completionProviderCalled = false;
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_stargazing_event',
    characterId: 'lina',
    now: '2026-05-08T14:51:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_stargazing_end', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と天体観測をした。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '天体観測の約束イベントを終えた', summary: '主人公とリナは天体観測の約束イベントを終えた。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventCompletionJudgmentProvider: async () => { completionProviderCalled = true; return { flag_results: [] }; },
    skillFlowRollProvider: () => 1
  });

  assert.equal(completionProviderCalled, false, 'conversation-end completion should not ask the LLM to rejudge the event');
  assert.equal(result.event_completions.accepted[0].completed_flag_id, 'event.stargazing_promise.completed');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.stargazing_promise.completed'], true);
  assert.deepEqual(nextState.event_completion_sources['event.stargazing_promise.completed'], {
    event_flag_id: 'event.stargazing_promise.ready',
    character_id: 'lina',
    conversation_id: 'conv_stargazing_event',
    achieved_at: '2026-05-08T14:51:00.000+09:00',
    completed_on_conversation_end: true
  });
  const completionLog = await readJson(root, 'game_data/logs/event_completion_judgments/conv_stargazing_event.json');
  assert.deepEqual(completionLog.accepted.map((flag) => flag.completed_flag_id), ['event.stargazing_promise.completed']);
  await fs.rm(root, { recursive: true, force: true });
});

test('test of courage promise event completes when its event conversation ends without an LLM completion judgment', async () => {
  const root = await fixtureRoot('magic-adv-test-of-courage-complete-on-end-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'old_corridor';
  state.current_interaction_character_id = 'lina';
  state.global_flags['event.test_of_courage_promise.ready'] = true;
  state.global_flags['event.test_of_courage_promise.completed'] = false;
  state.event_flag_sources = {
    'event.test_of_courage_promise.ready': {
      character_id: 'lina',
      conversation_id: 'conv_test_of_courage_promise_source',
      achieved_at: '2026-05-08T15:00:00.000+09:00'
    }
  };
  state.pending_interaction_context = {
    source_type: 'event',
    event_flag_id: 'event.test_of_courage_promise.ready',
    event_label: '肝試しの約束',
    source_conversation_id: 'conv_test_of_courage_promise_source'
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_test_of_courage_event.json'), JSON.stringify({
    id: 'conv_test_of_courage_event',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-08T15:10:00.000+09:00',
    updated_at: '2026-05-08T15:20:00.000+09:00',
    source_type: 'event',
    location_id: 'old_corridor',
    time_slot: 'night',
    prompt: '旧廊下で会話する。',
    messages: [
      { role: 'user', content: '無理に奥までは行かず、音がした場所だけ確かめよう。' },
      { role: 'assistant', content: 'リナは灯りを少し持ち上げ、まずは足音の反響を確かめながら進もうと応じた。' }
    ]
  }, null, 2), 'utf8');

  let completionProviderCalled = false;
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_test_of_courage_event',
    characterId: 'lina',
    now: '2026-05-08T15:21:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_test_of_courage_end', character_id: conversation.character_id, type: 'relationship_change', text: 'リナは主人公と肝試しに向かった。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '肝試しの約束イベントを終えた', summary: '主人公とリナは肝試しの約束イベントを終えた。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventCompletionJudgmentProvider: async () => { completionProviderCalled = true; return { flag_results: [] }; },
    skillFlowRollProvider: () => 1
  });

  assert.equal(completionProviderCalled, false, 'conversation-end completion should not ask the LLM to rejudge the event');
  assert.equal(result.event_completions.accepted[0].completed_flag_id, 'event.test_of_courage_promise.completed');
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.test_of_courage_promise.completed'], true);
  assert.deepEqual(nextState.event_completion_sources['event.test_of_courage_promise.completed'], {
    event_flag_id: 'event.test_of_courage_promise.ready',
    character_id: 'lina',
    conversation_id: 'conv_test_of_courage_event',
    achieved_at: '2026-05-08T15:21:00.000+09:00',
    completed_on_conversation_end: true
  });
  const completionLog = await readJson(root, 'game_data/logs/event_completion_judgments/conv_test_of_courage_event.json');
  assert.deepEqual(completionLog.accepted.map((flag) => flag.completed_flag_id), ['event.test_of_courage_promise.completed']);
  await fs.rm(root, { recursive: true, force: true });
});


test('snow, rain, and mirror events complete on conversation end without an LLM completion judgment', async () => {
  const cases = [
    {
      rootPrefix: 'magic-adv-snow-topic-complete-on-end-',
      readyFlagId: 'event.snow_topic_followup.ready',
      completedFlagId: 'event.snow_topic_followup.completed',
      locationId: 'snowy_inner_garden',
      eventLabel: '雪の話',
      sourceConversationId: 'conv_snow_topic_source',
      conversationId: 'conv_snow_topic_event',
      achievedAt: '2026-05-08T16:30:00.000+09:00',
      createdAt: '2026-05-08T16:40:00.000+09:00',
      updatedAt: '2026-05-08T16:50:00.000+09:00',
      now: '2026-05-08T16:51:00.000+09:00',
      timeSlot: 'after_school',
      prompt: '雪の中庭で会話する。',
      userMessage: '積もる前の静けさって、不思議と声まで澄んで聞こえるね。',
      assistantMessage: 'リナは白くなり始めた庭を見渡し、雪の匂いまで分かる気がすると答えた。',
      memoryText: 'リナは主人公と雪の話をした。',
      workRecordTitle: '雪の話イベントを終えた',
      workRecordSummary: '主人公とリナは雪の話イベントを終えた。'
    },
    {
      rootPrefix: 'magic-adv-rain-topic-complete-on-end-',
      readyFlagId: 'event.rain_topic_followup.ready',
      completedFlagId: 'event.rain_topic_followup.completed',
      locationId: 'rainy_cloister',
      eventLabel: '雨の話',
      sourceConversationId: 'conv_rain_topic_source',
      conversationId: 'conv_rain_topic_event',
      achievedAt: '2026-05-08T17:00:00.000+09:00',
      createdAt: '2026-05-08T17:10:00.000+09:00',
      updatedAt: '2026-05-08T17:20:00.000+09:00',
      now: '2026-05-08T17:21:00.000+09:00',
      timeSlot: 'after_school',
      prompt: '雨の回廊で会話する。',
      userMessage: '屋根を打つ音だけで、同じ回廊でも別の場所みたいに感じる。',
      assistantMessage: 'リナは柱の影で耳を澄まし、足音まで柔らかくなると言って笑った。',
      memoryText: 'リナは主人公と雨の話をした。',
      workRecordTitle: '雨の話イベントを終えた',
      workRecordSummary: '主人公とリナは雨の話イベントを終えた。'
    },
    {
      rootPrefix: 'magic-adv-heart-mirror-topic-complete-on-end-',
      readyFlagId: 'event.heart_mirror_topic_followup.ready',
      completedFlagId: 'event.heart_mirror_topic_followup.completed',
      locationId: 'mirror_hall',
      eventLabel: '心を映す鏡の話',
      sourceConversationId: 'conv_heart_mirror_topic_source',
      conversationId: 'conv_heart_mirror_topic_event',
      achievedAt: '2026-05-08T17:30:00.000+09:00',
      createdAt: '2026-05-08T17:40:00.000+09:00',
      updatedAt: '2026-05-08T17:50:00.000+09:00',
      now: '2026-05-08T17:51:00.000+09:00',
      timeSlot: 'night',
      prompt: '鏡の間で会話する。',
      userMessage: '本当に心が映るなら、最初に見えるのは願いかな、それとも迷いかな。',
      assistantMessage: 'リナは鏡面の奥を見つめ、映るのは隠したつもりのものかもしれないと囁いた。',
      memoryText: 'リナは主人公と心を映す鏡の話をした。',
      workRecordTitle: '心を映す鏡の話イベントを終えた',
      workRecordSummary: '主人公とリナは心を映す鏡の話イベントを終えた。'
    }
  ];

  for (const event of cases) {
    const root = await fixtureRoot(event.rootPrefix);
    const state = await readJson(root, 'game_data/runtime_state.json');
    state.current_location_id = event.locationId;
    state.current_interaction_character_id = 'lina';
    state.global_flags[event.readyFlagId] = true;
    state.global_flags[event.completedFlagId] = false;
    state.event_flag_sources = {
      [event.readyFlagId]: {
        character_id: 'lina',
        conversation_id: event.sourceConversationId,
        achieved_at: event.achievedAt
      }
    };
    state.pending_interaction_context = {
      source_type: 'event',
      event_flag_id: event.readyFlagId,
      event_label: event.eventLabel,
      source_conversation_id: event.sourceConversationId
    };
    await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
    await fs.writeFile(path.join(root, `game_data/logs/conversations/${event.conversationId}.json`), JSON.stringify({
      id: event.conversationId,
      character_id: 'lina',
      character_name: 'リナ・クラウゼ',
      created_at: event.createdAt,
      updated_at: event.updatedAt,
      source_type: 'event',
      location_id: event.locationId,
      time_slot: event.timeSlot,
      prompt: event.prompt,
      messages: [
        { role: 'user', content: event.userMessage },
        { role: 'assistant', content: event.assistantMessage }
      ]
    }, null, 2), 'utf8');

    let completionProviderCalled = false;
    const result = await finalizeConversation({
      root,
      conversationId: event.conversationId,
      characterId: 'lina',
      now: event.now,
      memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: `mem_${event.conversationId}_end`, character_id: conversation.character_id, type: 'relationship_change', text: event.memoryText, source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
      skillUpdateProvider: async () => ({ skipped: true }),
      workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: event.workRecordTitle, summary: event.workRecordSummary, flag_update_candidates: [], warnings: [] } }),
      stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
      eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
      eventCompletionJudgmentProvider: async () => { completionProviderCalled = true; return { flag_results: [] }; },
      skillFlowRollProvider: () => 1
    });

    assert.equal(completionProviderCalled, false, event.readyFlagId);
    assert.equal(result.event_completions.accepted[0].completed_flag_id, event.completedFlagId);
    const nextState = await readJson(root, 'game_data/runtime_state.json');
    assert.equal(nextState.global_flags[event.completedFlagId], true);
    assert.deepEqual(nextState.event_completion_sources[event.completedFlagId], {
      event_flag_id: event.readyFlagId,
      character_id: 'lina',
      conversation_id: event.conversationId,
      achieved_at: event.now,
      completed_on_conversation_end: true
    });
    const completionLog = await readJson(root, `game_data/logs/event_completion_judgments/${event.conversationId}.json`);
    assert.deepEqual(completionLog.accepted.map((flag) => flag.completed_flag_id), [event.completedFlagId]);
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('school festival promise event definition has no judgment prerequisites and uses the promise condition', async () => {
  const definitions = await loadEventFlags({ root: stagingRoot });
  const flag = definitions.flags.find((entry) => entry.id === 'event.school_festival_promise.ready');

  assert.equal(flag.label, '学院祭の約束');
  assert.equal(flag.condition, '学院祭に一緒に行く約束をすること。');
  assert.equal(flag.question, '主人公と会話相手が学院祭に一緒に行く約束をしたか');
  assert.deepEqual(flag.required_global_flags, []);
  assert.deepEqual(flag.required_inventory_items, []);
  assert.equal(flag.completed_flag_id, 'event.school_festival_promise.completed');
  assert.equal(flag.complete_on_conversation_end, true);
  assert.deepEqual(flag.interaction, {
    location_id: 'festival_plaza_night',
    source_type: 'event',
    opening_context: '学院祭の約束イベント。フラグが成立した会話相手と、夜祭の広場で学院祭の約束を受けて会話を始める。'
  });
});

test('artificial spirit crafting promise event definition has no judgment prerequisites and uses the agreed workshop route', async () => {
  const root = await fixtureRoot('magic-adv-artificial-spirit-definition-');
  const definitions = await loadEventFlags({ root });
  const flag = definitions.flags.find((entry) => entry.id === 'event.artificial_spirit_crafting_promise.ready');

  assert.equal(flag.label, '人工精霊づくりの約束');
  assert.equal(flag.condition, '一緒に人工精霊を作ることに合意すること。');
  assert.equal(flag.question, '主人公と会話相手が一緒に人工精霊を作ることに合意したか');
  assert.deepEqual(flag.required_global_flags, []);
  assert.deepEqual(flag.required_inventory_items, []);
  assert.equal(flag.completed_flag_id, 'event.artificial_spirit_crafting_promise.completed');
  assert.equal(flag.complete_on_conversation_end, true);
  assert.equal(flag.interaction.location_id, 'magic_tool_workshop');
  assert.equal(flag.interaction.source_type, 'event');
  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: {}, event_flag_sources: {} },
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.artificial_spirit_crafting_promise.ready'), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('natural spirit search promise event definition has no judgment prerequisites and uses the agreed greenhouse route', async () => {
  const root = await fixtureRoot('magic-adv-natural-spirit-definition-');
  const definitions = await loadEventFlags({ root });
  const flag = definitions.flags.find((entry) => entry.id === 'event.natural_spirit_search_promise.ready');

  assert.equal(flag.label, '天然精霊探しの約束');
  assert.equal(flag.condition, '一緒に天然精霊を探しにいくことに合意すること。');
  assert.equal(flag.question, '主人公と会話相手が一緒に天然精霊を探しにいくことに合意したか');
  assert.deepEqual(flag.required_global_flags, []);
  assert.deepEqual(flag.required_inventory_items, []);
  assert.equal(flag.completed_flag_id, 'event.natural_spirit_search_promise.completed');
  assert.equal(flag.complete_on_conversation_end, true);
  assert.equal(flag.interaction.location_id, 'herbology_garden');
  assert.equal(flag.interaction.source_type, 'event');
  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: {}, event_flag_sources: {} },
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.natural_spirit_search_promise.ready'), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('stargazing promise event definition has no judgment prerequisites and uses the agreed observatory route', async () => {
  const root = await fixtureRoot('magic-adv-stargazing-definition-');
  const definitions = await loadEventFlags({ root });
  const flag = definitions.flags.find((entry) => entry.id === 'event.stargazing_promise.ready');

  assert.equal(flag.label, '天体観測の約束');
  assert.equal(flag.condition, '一緒に天体観測することに合意すること。');
  assert.equal(flag.question, '主人公と会話相手が一緒に天体観測することに合意したか');
  assert.deepEqual(flag.required_global_flags, []);
  assert.deepEqual(flag.required_inventory_items, []);
  assert.equal(flag.completed_flag_id, 'event.stargazing_promise.completed');
  assert.equal(flag.complete_on_conversation_end, true);
  assert.equal(flag.interaction.location_id, 'astronomy_tower_observatory');
  assert.equal(flag.interaction.source_type, 'event');
  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: {}, event_flag_sources: {} },
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.stargazing_promise.ready'), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('test of courage promise event definition has no judgment prerequisites and uses the agreed old corridor route', async () => {
  const root = await fixtureRoot('magic-adv-test-of-courage-definition-');
  const definitions = await loadEventFlags({ root });
  const flag = definitions.flags.find((entry) => entry.id === 'event.test_of_courage_promise.ready');

  assert.equal(flag.label, '肝試しの約束');
  assert.equal(flag.condition, '一緒に肝試しに行くことに合意すること。');
  assert.equal(flag.question, '主人公と会話相手が一緒に肝試しに行くことに合意したか');
  assert.deepEqual(flag.required_global_flags, []);
  assert.deepEqual(flag.required_inventory_items, []);
  assert.equal(flag.completed_flag_id, 'event.test_of_courage_promise.completed');
  assert.equal(flag.complete_on_conversation_end, true);
  assert.equal(flag.interaction.location_id, 'old_corridor');
  assert.equal(flag.interaction.source_type, 'event');
  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: {}, event_flag_sources: {} },
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.test_of_courage_promise.ready'), true);
  await fs.rm(root, { recursive: true, force: true });
});


test('snow, rain, and mirror event definitions use the agreed routes and remain conversation-end judgments', async () => {
  const root = await fixtureRoot('magic-adv-extra-event-definitions-');
  const definitions = await loadEventFlags({ root });
  const cases = [
    {
      readyFlagId: 'event.snow_topic_followup.ready',
      label: '雪の話',
      condition: '雪について話すこと。',
      question: '主人公と会話相手が雪について話したか',
      completedFlagId: 'event.snow_topic_followup.completed',
      locationId: 'snowy_inner_garden'
    },
    {
      readyFlagId: 'event.rain_topic_followup.ready',
      label: '雨の話',
      condition: '雨について話すこと。',
      question: '主人公と会話相手が雨について話したか',
      completedFlagId: 'event.rain_topic_followup.completed',
      locationId: 'rainy_cloister',
      openingContext: '雨の話をして間もなく雨が降り始め、あなたは主人公と雨の回廊で会話を始めた。'
    },
    {
      readyFlagId: 'event.heart_mirror_topic_followup.ready',
      label: '心を映す鏡の話',
      condition: '心の中を映す鏡について話すこと。',
      question: '主人公と会話相手が心の中を映す鏡について話したか',
      completedFlagId: 'event.heart_mirror_topic_followup.completed',
      locationId: 'mirror_hall'
    }
  ];

  for (const event of cases) {
    const flag = definitions.flags.find((entry) => entry.id === event.readyFlagId);
    assert.equal(flag.label, event.label);
    assert.equal(flag.condition, event.condition);
    assert.equal(flag.question, event.question);
    assert.deepEqual(flag.required_global_flags, []);
    assert.deepEqual(flag.required_inventory_items, []);
    assert.equal(flag.completed_flag_id, event.completedFlagId);
    assert.equal(flag.complete_on_conversation_end, true);
    assert.equal(flag.interaction.location_id, event.locationId);
    assert.equal(flag.interaction.source_type, 'event');
    if (event.openingContext) assert.equal(flag.interaction.opening_context, event.openingContext);
    assert.equal(selectEventFlagJudgmentTargets({
      flags: definitions.flags,
      state: { global_flags: {}, event_flag_sources: {} },
      inventory: { items: [] },
      conversation: { character_id: 'lina' }
    }).map((entry) => entry.id).includes(event.readyFlagId), true, event.readyFlagId);
  }

  await fs.rm(root, { recursive: true, force: true });
});


test('necromancer seal release definition keeps observable prerequisites, runtime handoff, and conversation-end completion linkage', async () => {
  const definitions = await readDefinitionsJson('event_flags.json');
  const flag = definitions.flags.find((entry) => entry.id === 'event.necromancer_seal_released.ready');

  assert.equal(flag.label, 'ネクロマンサーの封印解除');
  assert.equal(flag.auto_ready_when_prerequisites_met, true);
  assert.deepEqual(flag.required_global_flags, ['knowledge.necromancer_sealed_in_ritual_room_discussed']);
  assert.deepEqual(flag.required_inventory_items, [{ item_id: 'necromancy_book', quantity: 1 }]);
  assert.equal(flag.completed_flag_id, 'event.necromancer_seal_released.completed');
  assert.equal(flag.complete_on_conversation_end, true);
  assert.equal(flag.completion_judgment, undefined);
  assert.equal(flag.interaction.location_id, 'unsealed_necromancer_ritual_room');
  assert.equal(flag.interaction.source_type, 'event');
  assert.match(flag.interaction.opening_context, /伝説のネクロマンサーとの邂逅/);

  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: {}, event_flag_sources: {} },
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.necromancer_seal_released.ready'), false);
  assert.equal(selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: { 'knowledge.necromancer_sealed_in_ritual_room_discussed': true }, event_flag_sources: {} },
    inventory: { items: [{ item_id: 'necromancy_book', quantity: 1 }] },
    conversation: { character_id: 'lina' }
  }).map((entry) => entry.id).includes('event.necromancer_seal_released.ready'), false, 'necromancy book should make the event ready mechanically without an extra seal-release judgment flow');

  const root = await fixtureRoot('magic-adv-necromancer-auto-ready-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['knowledge.necromancer_sealed_in_ritual_room_discussed'] = true;
  state.event_flag_sources = {
    'knowledge.necromancer_sealed_in_ritual_room_discussed': {
      character_id: 'lina',
      conversation_id: 'conv_necromancer_lore',
      achieved_at: '2026-05-09T13:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [{ item_id: 'necromancy_book', quantity: 1 }] }, null, 2), 'utf8');
  await fs.mkdir(path.join(root, 'game_data/characters/lina/work_records'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/characters/lina/work_records/wr_conv_necromancer_lore.md'), '# 封印儀式室の伝承\n\n封印儀式室でネクロマンサーの封印を解く備えが整ったと共有した。\n', 'utf8');

  const status = await getEventFlagStatus({ root });
  const pending = status.pending_events.find((entry) => entry.id === 'event.necromancer_seal_released.ready');
  assert.equal(pending?.character_id, 'lina');
  assert.equal(pending?.source_conversation_id, 'conv_necromancer_lore');

  const started = await startEventFlagInteraction({ root, flagId: 'event.necromancer_seal_released.ready' });
  assert.equal(started.location_id, 'unsealed_necromancer_ritual_room');
  assert.equal(started.character_id, 'lina');
  assert.equal(started.state.pending_interaction_context.source_type, 'event');
  assert.equal(started.state.pending_interaction_context.event_flag_id, 'event.necromancer_seal_released.ready');
  assert.equal(started.state.pending_interaction_context.source_conversation_id, 'conv_necromancer_lore');
  assert.match(started.state.pending_interaction_context.opening_context, /伝説のネクロマンサー/);

  const opening = await runConversationOpening({
    root,
    id: 'conv_necromancer_event_opening',
    characterId: 'lina',
    now: '2026-05-09T13:05:00.000+09:00',
    chatProvider: async () => '封印の綻びが見える。'
  });
  assert.equal(opening.conversation.source_type, 'event');
  assert.equal(opening.conversation.event_flag_id, 'event.necromancer_seal_released.ready');
  assert.equal(opening.conversation.location_id, 'unsealed_necromancer_ritual_room');
  assert.equal(opening.conversation.source_conversation_id, 'conv_necromancer_lore');
  assert.match(opening.conversation.prompt, /イベント文脈: .*ネクロマンサー/);
  assert.match(opening.conversation.prompt, /成立元会話ワークレコード:/);
  assert.match(opening.conversation.prompt, /封印儀式室でネクロマンサーの封印を解く備えが整った/);

  assert.deepEqual(selectEventCompletionJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: { 'event.necromancer_seal_released.ready': true, 'event.necromancer_seal_released.completed': false } },
    conversation: { location_id: 'unsealed_necromancer_ritual_room' }
  }).map((entry) => entry.id), [], 'conversation-end completion event should not enter the LLM success-judgment flow');
  assert.deepEqual(selectEventCompletionJudgmentTargets({
    flags: definitions.flags,
    state: { global_flags: { 'event.necromancer_seal_released.ready': true, 'event.necromancer_seal_released.completed': false } },
    conversation: { location_id: 'forbidden_archive_door' }
  }).map((entry) => entry.id), []);

  await fs.rm(root, { recursive: true, force: true });
});

test('field API includes the current event location detail for interaction headers', async (t) => {
  const root = await fixtureRoot('magic-adv-event-location-');
  const { root: activeRoot } = await initializeNewPlayArea({ root, slotId: 'slot_event_location' });
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_screen = 'interaction';
  state.current_location_id = 'unsealed_necromancer_ritual_room';
  state.current_interaction_character_id = 'lina';
  await fs.writeFile(path.join(activeRoot, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  const base = await withServer(t, root);

  const field = await jsonFetch(`${base}/api/field`);

  assert.equal(field.current_location.id, 'unsealed_necromancer_ritual_room');
  assert.match(field.current_location.display_name, /ネクロマンサーの封印が解かれた儀式/);
  assert.match(field.current_location.visible_situation, /伝説のネクロマンサーが静かに佇んでいる/);
  assert.equal(field.locations.some((location) => location.id === 'unsealed_necromancer_ritual_room'), false);
});

test('event flag target selection keeps a single global flow by skipping already-active flags for every character', () => {
  const flags = [
    {
      id: 'knowledge.first',
      condition: '最初の知識。',
      required_global_flags: [],
      required_inventory_items: []
    },
    {
      id: 'knowledge.second',
      condition: '次の知識。',
      required_global_flags: ['knowledge.first'],
      required_inventory_items: []
    }
  ];
  const state = {
    global_flags: {
      'knowledge.first': true,
      'knowledge.second': false
    },
    event_flag_sources: {
      'knowledge.first': { character_id: 'lina', conversation_id: 'conv_lina_old', achieved_at: '2026-05-06T12:00:00.000+09:00' }
    }
  };

  assert.deepEqual(selectEventFlagJudgmentTargets({ flags, state, inventory: { items: [] }, conversation: { character_id: 'lina' } }).map((flag) => flag.id), ['knowledge.second']);
  assert.deepEqual(selectEventFlagJudgmentTargets({ flags, state, inventory: { items: [] }, conversation: { character_id: 'character_001' } }).map((flag) => flag.id), ['knowledge.second']);
});

test('event flags do not rejudge already-active flags for a different character', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['story.archive_intro_done'] = true;
  state.global_flags['event.school_festival_promise.ready'] = true;
  state.event_flag_sources = {
    'event.school_festival_promise.ready': {
      character_id: 'character_001',
      conversation_id: 'conv_character_001_old',
      achieved_at: '2026-05-06T12:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [{
      id: 'event.school_festival_promise.ready',
      label: '禁書庫のお茶会イベント準備',
      condition: '誰かと禁書庫でのお茶会を約束する。',
      question: '禁書庫でのお茶会をする約束が成立したか',
      required_global_flags: ['story.archive_intro_done'],
      completed_flag_id: 'event.school_festival_promise.completed'
    }]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_forbidden_archive_teatime.json'), JSON.stringify({
    id: 'conv_forbidden_archive_teatime',
    character_id: 'lina',
    character_name: '別の生徒',
    created_at: '2026-05-06T13:00:00.000+09:00',
    updated_at: '2026-05-06T13:10:00.000+09:00',
    source_type: 'field',
    location_id: 'forbidden_archive_door',
    messages: [
      { role: 'user', content: '禁書庫のお茶会を君とも進めよう。' },
      { role: 'assistant', content: 'では私が後から登録する準備を引き受けます。' }
    ]
  }, null, 2), 'utf8');

  const eventProviderCalls = [];
  await finalizeConversation({
    root,
    conversationId: 'conv_forbidden_archive_teatime',
    characterId: 'lina',
    now: '2026-05-06T13:11:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_event_other_character', character_id: conversation.character_id, type: 'relationship_change', text: '別の生徒とも禁書庫のお茶会を約束した。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '別の生徒と禁書庫のお茶会を約束した', summary: '主人公は別の生徒とも禁書庫のお茶会を進める約束をした。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async ({ candidateFlags }) => {
      eventProviderCalls.push(candidateFlags.map((flag) => flag.id));
      return { flag_results: [{ flag_id: 'event.school_festival_promise.ready', achieved: true }] };
    },
    skillFlowRollProvider: () => 1
  });

  assert.deepEqual(eventProviderCalls, []);
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.school_festival_promise.ready'], true);
  assert.deepEqual(nextState.event_flag_sources['event.school_festival_promise.ready'], {
    character_id: 'character_001',
    conversation_id: 'conv_character_001_old',
    achieved_at: '2026-05-06T12:00:00.000+09:00'
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('starting the school festival promise event opens interaction with source character at the night festival plaza', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_screen = 'event';
  state.current_location_id = 'herbology_garden';
  state.current_interaction_character_id = null;
  state.last_conversation_id = null;
  state.global_flags['event.school_festival_promise.ready'] = true;
  state.global_flags['event.school_festival_promise.completed'] = false;
  state.event_flag_sources = {
    'event.school_festival_promise.ready': {
      character_id: 'character_001',
      conversation_id: 'conv_school_festival_promise',
      achieved_at: '2026-05-06T18:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [{
      id: 'event.school_festival_promise.ready',
      label: '学院祭の約束',
      condition: '学院祭に一緒に行く約束をすること。',
      question: '主人公と会話相手が学院祭に一緒に行く約束をしたか',
      required_global_flags: [],
      required_inventory_items: [],
      completed_flag_id: 'event.school_festival_promise.completed',
      interaction: {
        location_id: 'festival_plaza_night',
        source_type: 'event',
        opening_context: '学院祭の約束イベント。フラグが成立した会話相手と、夜祭の広場で学院祭の約束を受けて会話を始める。'
      }
    }]
  }, null, 2), 'utf8');

  const result = await startEventFlagInteraction({ root, flagId: 'event.school_festival_promise.ready' });

  assert.equal(result.event_flag.id, 'event.school_festival_promise.ready');
  assert.equal(result.character_id, 'character_001');
  assert.equal(result.location_id, 'festival_plaza_night');
  assert.equal(result.state.current_screen, 'interaction');
  assert.equal(result.state.current_interaction_character_id, 'character_001');
  assert.equal(result.state.current_location_id, 'festival_plaza_night');
  assert.equal(result.state.last_conversation_id, null);
  assert.deepEqual(result.state.pending_interaction_context, {
    source_type: 'event',
    event_flag_id: 'event.school_festival_promise.ready',
    event_label: '学院祭の約束',
    source_conversation_id: 'conv_school_festival_promise',
    opening_context: '学院祭の約束イベント。フラグが成立した会話相手と、夜祭の広場で学院祭の約束を受けて会話を始める。'
  });
  const saved = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(saved.current_screen, 'interaction');
  assert.equal(saved.current_interaction_character_id, 'character_001');
  assert.equal(saved.current_location_id, 'festival_plaza_night');
  await fs.rm(root, { recursive: true, force: true });
});

test('school festival event opening records the conversation session as an event source', async () => {
  const root = await fixtureRoot('magic-adv-school-festival-opening-source-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_screen = 'event';
  state.current_location_id = 'herbology_garden';
  state.current_interaction_character_id = null;
  state.last_conversation_id = null;
  const sourceCharacterId = state.active_character_ids[0];
  state.global_flags['event.school_festival_promise.ready'] = true;
  state.global_flags['event.school_festival_promise.completed'] = false;
  state.event_flag_sources = {
    'event.school_festival_promise.ready': {
      character_id: sourceCharacterId,
      conversation_id: 'conv_school_festival_promise',
      achieved_at: '2026-05-06T18:00:00.000+09:00'
    }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [{
      id: 'event.school_festival_promise.ready',
      label: '学院祭の約束',
      condition: '学院祭に一緒に行く約束をすること。',
      question: '主人公と会話相手が学院祭に一緒に行く約束をしたか',
      completed_flag_id: 'event.school_festival_promise.completed',
      complete_on_conversation_end: true,
      interaction: {
        location_id: 'festival_plaza_night',
        source_type: 'event',
        opening_context: '学院祭の約束イベント。'
      }
    }]
  }, null, 2), 'utf8');

  await startEventFlagInteraction({ root, flagId: 'event.school_festival_promise.ready' });
  const opening = await runConversationOpening({
    root,
    id: 'conv_school_festival_event_opening',
    characterId: sourceCharacterId,
    now: '2026-05-06T18:10:00.000+09:00',
    chatProvider: async () => '学院祭の灯りが見えるね。'
  });

  assert.equal(opening.conversation.source_type, 'event');
  assert.equal(opening.conversation.event_flag_id, 'event.school_festival_promise.ready');
  assert.equal(opening.conversation.location_id, 'festival_plaza_night');
  assert.equal(opening.conversation.character_id, sourceCharacterId);

  const stateAfterOpening = await readJson(root, 'game_data/runtime_state.json');
  const persistedConversation = await readJson(root, `game_data/logs/conversations/${opening.conversation.id}.json`);
  delete persistedConversation.event_flag_id;
  delete persistedConversation.event_label;
  delete persistedConversation.source_conversation_id;
  await fs.writeFile(path.join(root, `game_data/logs/conversations/${opening.conversation.id}.json`), JSON.stringify(persistedConversation, null, 2), 'utf8');
  stateAfterOpening.current_screen = 'academy-training';
  stateAfterOpening.current_interaction_character_id = null;
  stateAfterOpening.pending_interaction_context = null;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(stateAfterOpening, null, 2), 'utf8');

  const result = await finalizeConversation({
    root,
    conversationId: opening.conversation.id,
    characterId: sourceCharacterId,
    now: '2026-05-06T18:15:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({ memory_record: { id: 'mem_school_festival_event_opening', character_id: conversation.character_id, type: 'relationship_change', text: 'リナと学院祭の灯りを見た。', source_conversation_id: conversation.id, work_record_id: workRecordId, visibility: 'character_known', tags: [] } }),
    skillUpdateProvider: async () => ({ skipped: true }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({ work_record: { id: workRecordId, character_id: conversation.character_id, source_conversation_id: conversation.id, title: '学院祭の約束イベントで話した', summary: '主人公とリナは学院祭の約束イベントで夜祭の広場に立った。', flag_update_candidates: [], warnings: [] } }),
    stageFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventFlagJudgmentProvider: async () => ({ flag_results: [] }),
    eventCompletionJudgmentProvider: async () => {
      throw new Error('complete_on_conversation_end should not call the LLM completion judgment provider');
    },
    skillFlowRollProvider: () => 1,
    moneyDeltaProvider: async () => '0',
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false'
  });

  assert.equal(result.event_completions.accepted[0].flag_id, 'event.school_festival_promise.ready');
  assert.equal(result.event_completions.accepted[0].completed_on_conversation_end, true);
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.school_festival_promise.ready'], true);
  assert.equal(nextState.global_flags['event.school_festival_promise.completed'], true);
  assert.equal(nextState.event_completion_sources['event.school_festival_promise.completed'].completed_on_conversation_end, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('configured event interactions preserve event source type for every playable event conversation opening', async () => {
  const root = await fixtureRoot('magic-adv-all-event-opening-source-');
  const playableEvents = [
    {
      id: 'event.school_festival_promise.ready',
      label: '学院祭の約束',
      completedFlagId: 'event.school_festival_promise.completed',
      locationId: 'festival_plaza_night',
      openingContext: '学院祭の約束イベント。'
    },
    {
      id: 'event.artificial_spirit_crafting_promise.ready',
      label: '人工精霊づくりの約束',
      completedFlagId: 'event.artificial_spirit_crafting_promise.completed',
      locationId: 'magic_tool_workshop',
      openingContext: '人工精霊づくりの約束イベント。'
    },
    {
      id: 'event.natural_spirit_search_promise.ready',
      label: '天然精霊探しの約束',
      completedFlagId: 'event.natural_spirit_search_promise.completed',
      locationId: 'herbology_garden',
      openingContext: '天然精霊探しの約束イベント。'
    },
    {
      id: 'event.stargazing_promise.ready',
      label: '天体観測の約束',
      completedFlagId: 'event.stargazing_promise.completed',
      locationId: 'astronomy_tower_observatory',
      openingContext: '天体観測の約束イベント。'
    },
    {
      id: 'event.test_of_courage_promise.ready',
      label: '肝試しの約束',
      completedFlagId: 'event.test_of_courage_promise.completed',
      locationId: 'old_corridor',
      openingContext: '肝試しの約束イベント。'
    },
    {
      id: 'event.necromancer_seal_released.ready',
      label: 'ネクロマンサーの封印解除',
      completedFlagId: 'event.necromancer_seal_released.completed',
      locationId: 'unsealed_necromancer_ritual_room',
      openingContext: 'ネクロマンサーの封印解除イベント。'
    },
    {
      id: 'event.age_of_gods_elixir_brewing.ready',
      label: '神代のパナケイアの調合',
      completedFlagId: 'event.age_of_gods_elixir_brewing.completed',
      locationId: 'age_of_gods_elixir_brewing_stage',
      openingContext: '神代のパナケイアの調合イベント。'
    },
    {
      id: 'event.cleaning_golem_shutdown.ready',
      label: '暴走掃除ゴーレム停止',
      completedFlagId: 'event.cleaning_golem_shutdown.completed',
      locationId: 'main_hall_runaway_golem',
      openingContext: '暴走掃除ゴーレム停止イベント。'
    }
  ];
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: playableEvents.map((event) => ({
      id: event.id,
      label: event.label,
      condition: `${event.label}を開始できる。`,
      question: `${event.label}を開始できるか`,
      completed_flag_id: event.completedFlagId,
      interaction: {
        location_id: event.locationId,
        source_type: 'event',
        opening_context: event.openingContext
      }
    }))
  }, null, 2), 'utf8');

  for (const [index, event] of playableEvents.entries()) {
    const state = await readJson(root, 'game_data/runtime_state.json');
    state.current_screen = 'event';
    state.current_location_id = 'herbology_garden';
    state.current_interaction_character_id = null;
    state.last_conversation_id = null;
    state.pending_interaction_context = null;
    state.global_flags = Object.fromEntries(playableEvents.flatMap((candidate) => [
      [candidate.id, candidate.id === event.id],
      [candidate.completedFlagId, false]
    ]));
    const sourceCharacterId = state.active_character_ids[0];
    state.event_flag_sources = {
      [event.id]: {
        character_id: sourceCharacterId,
        conversation_id: `conv_${index}_source`,
        achieved_at: '2026-05-06T18:00:00.000+09:00'
      }
    };
    await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');

    await startEventFlagInteraction({ root, flagId: event.id });
    const opening = await runConversationOpening({
      root,
      id: `conv_${index}_event_opening`,
      characterId: sourceCharacterId,
      now: `2026-05-06T18:${10 + index}:00.000+09:00`,
      chatProvider: async () => `${event.label}の会話を始める。`
    });

    assert.equal(opening.conversation.source_type, 'event', event.id);
    assert.equal(opening.conversation.event_flag_id, event.id, event.id);
    assert.equal(opening.conversation.location_id, event.locationId, event.id);
    assert.equal(opening.conversation.character_id, sourceCharacterId, event.id);
  }

  await fs.rm(root, { recursive: true, force: true });
});

test('debug event flag API can toggle event flags and completion flags without consuming inventory', async (t) => {
  const root = await fixtureRoot();
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [{
      id: 'event.school_festival_promise.ready',
      label: '禁書庫のお茶会イベント準備',
      condition: '禁書庫でお茶会ができる。',
      completed_flag_id: 'event.school_festival_promise.completed'
    }]
  }, null, 2), 'utf8');
  const base = await withServer(t, root);

  const firstToggle = await jsonFetch(`${base}/api/event-flags/set`, {
    method: 'POST',
    body: { flag_id: 'event.school_festival_promise.ready', active: true }
  });
  const firstFlag = firstToggle.flags.find((flag) => flag.id === 'event.school_festival_promise.ready');
  assert.equal(firstFlag.active, true);
  assert.equal(firstFlag.completed, false);
  assert.deepEqual(firstToggle.pending_events.map((flag) => flag.id), ['event.school_festival_promise.ready']);

  const completionOn = await jsonFetch(`${base}/api/event-flags/completion/set`, {
    method: 'POST',
    body: { flag_id: 'event.school_festival_promise.ready', active: true }
  });
  const completedFlag = completionOn.flags.find((flag) => flag.id === 'event.school_festival_promise.ready');
  assert.equal(completedFlag.active, true);
  assert.equal(completedFlag.completed, true);
  assert.equal(completedFlag.completion_source.event_flag_id, 'event.school_festival_promise.ready');
  assert.deepEqual(completionOn.pending_events.map((flag) => flag.id), []);

  const completionOff = await jsonFetch(`${base}/api/event-flags/completion/set`, {
    method: 'POST',
    body: { flag_id: 'event.school_festival_promise.ready', active: false }
  });
  const reopenedFlag = completionOff.flags.find((flag) => flag.id === 'event.school_festival_promise.ready');
  assert.equal(reopenedFlag.active, true);
  assert.equal(reopenedFlag.completed, false);
  assert.equal(reopenedFlag.completion_source, null);
  assert.deepEqual(completionOff.pending_events.map((flag) => flag.id), ['event.school_festival_promise.ready']);

  const status = await jsonFetch(`${base}/api/event-flags`);
  assert.equal(status.flags.find((flag) => flag.id === 'event.school_festival_promise.ready').active, true);
  assert.equal(status.flags.find((flag) => flag.id === 'event.school_festival_promise.ready').completed, false);
  assert.deepEqual(status.pending_events.map((flag) => flag.id), ['event.school_festival_promise.ready']);
});

test('debug event flag API can turn all event and completion flags off', async (t) => {
  const root = await fixtureRoot();
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'event.school_festival_promise.ready',
        label: '学院祭の約束',
        condition: '学院祭に一緒に行く。',
        completed_flag_id: 'event.school_festival_promise.completed'
      },
      {
        id: 'knowledge.herbology_discussed',
        label: '薬草学の話を聞いた',
        condition: '薬草学について話す。',
        hidden_from_event_status: true
      }
    ]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify({
    global_flags: {
      'event.school_festival_promise.ready': true,
      'event.school_festival_promise.completed': true,
      'knowledge.herbology_discussed': true,
      'story.unrelated': true
    },
    event_flag_sources: {
      'event.school_festival_promise.ready': { character_id: 'lina', conversation_id: 'conv_event', achieved_at: '2026-05-10T00:00:00.000Z' },
      'knowledge.herbology_discussed': { character_id: 'lina', conversation_id: 'conv_lore', achieved_at: '2026-05-10T00:00:00.000Z' }
    },
    event_completion_sources: {
      'event.school_festival_promise.completed': { event_flag_id: 'event.school_festival_promise.ready', character_id: 'lina', conversation_id: 'conv_done', achieved_at: '2026-05-10T00:00:00.000Z' }
    }
  }, null, 2), 'utf8');
  const base = await withServer(t, root);

  const off = await jsonFetch(`${base}/api/event-flags/all-off`, { method: 'POST', body: {} });
  assert.equal(off.flags.find((flag) => flag.id === 'event.school_festival_promise.ready').active, false);
  assert.equal(off.flags.find((flag) => flag.id === 'event.school_festival_promise.ready').completed, false);
  assert.equal(off.flags.find((flag) => flag.id === 'event.school_festival_promise.ready').source, null);
  assert.equal(off.flags.find((flag) => flag.id === 'event.school_festival_promise.ready').completion_source, null);
  assert.equal(off.flags.find((flag) => flag.id === 'knowledge.herbology_discussed').active, false);
  assert.deepEqual(off.pending_events.map((flag) => flag.id), []);

  const saved = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(saved.global_flags['event.school_festival_promise.ready'], false);
  assert.equal(saved.global_flags['event.school_festival_promise.completed'], false);
  assert.equal(saved.global_flags['knowledge.herbology_discussed'], false);
  assert.equal(saved.global_flags['story.unrelated'], true);
  assert.deepEqual(saved.event_flag_sources, {});
  assert.deepEqual(saved.event_completion_sources, {});
});

test('event flag start can target academy conversation session for training-complete auto events', async () => {
  const root = await fixtureRoot();
  await fs.writeFile(path.join(root, 'game_data/event_flags.json'), JSON.stringify({
    flags: [
      {
        id: 'event.school_festival_promise.ready',
        label: '学院祭の約束',
        condition: '学院祭に一緒に行く。',
        completed_flag_id: 'event.school_festival_promise.completed',
        interaction: {
          location_id: 'festival_plaza_night',
          source_type: 'event',
          opening_context: '学院祭の約束イベント。'
        }
      }
    ]
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify({
    version: 1,
    current_location_id: 'courtyard_fountain',
    current_screen: 'academy-training',
    current_interaction_character_id: null,
    last_conversation_id: null,
    global_flags: {
      'event.school_festival_promise.ready': true,
      'event.school_festival_promise.completed': false
    },
    event_flag_sources: {
      'event.school_festival_promise.ready': { character_id: 'lina', conversation_id: 'conv_event_source', achieved_at: '2026-05-10T00:00:00.000Z' }
    }
  }, null, 2), 'utf8');

  const result = await startEventFlagInteraction({
    root,
    flagId: 'event.school_festival_promise.ready',
    screen: 'academy-conversation-session'
  });

  assert.equal(result.state.current_screen, 'academy-conversation-session');
  assert.equal(result.state.current_location_id, 'festival_plaza_night');
  assert.equal(result.state.current_interaction_character_id, 'lina');
  assert.equal(result.state.last_conversation_id, null);
  assert.equal(result.state.pending_interaction_context.event_flag_id, 'event.school_festival_promise.ready');
  const saved = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(saved.current_screen, 'academy-conversation-session');
});

test('debug UI exposes stage flag titles and manual flag toggle controls', async () => {
  const html = await fs.readFile(path.join(livePublicRoot, 'index.html'), 'utf8');
  assert.match(html, /id="flag-title-list"/);
  assert.match(html, /id="set-all-flags-on"[\s\S]*すべてオン/);
  assert.match(html, /id="flag-detail-dialog"/);
  assert.match(html, /id="flag-detail-body"/);
  assert.match(html, /id="toggle-flag-active"[\s\S]*フラグ/);
  assert.match(html, /aria-label="stage flags"/);
  assert.match(html, /id="event-flag-title-list"/);
  assert.match(html, /id="set-all-event-flags-on"[\s\S]*すべてオン/);
  assert.match(html, /id="set-all-event-flags-off"[\s\S]*すべてオフ/);
  assert.match(html, /id="event-flag-detail-dialog"/);
  assert.match(html, /id="event-flag-detail-body"/);
  assert.match(html, /id="toggle-event-flag-active"[\s\S]*イベントフラグ/);
  assert.match(html, /id="toggle-event-completion-active"[\s\S]*完了フラグ/);
  assert.match(html, /aria-label="event flags"/);
  assert.match(html, /id="llm-request-list"/);
  assert.match(html, /id="llm-request-detail-dialog"/);
  assert.match(html, /id="llm-request-detail-input"/);
  assert.match(html, /id="llm-request-detail-output"/);
  const js = await fs.readFile(path.join(livePublicRoot, 'app.js'), 'utf8');
  assert.match(js, /\/api\/flags/);
  assert.match(js, /\/api\/event-flags/);
  assert.match(js, /postJson\('\/api\/flags\/set'/);
  assert.match(js, /postJson\('\/api\/flags\/judgment-flow'/);
  assert.match(js, /postJson\('\/api\/event-flags\/set'/);
  assert.match(js, /postJson\('\/api\/event-flags\/completion\/set'/);
  assert.match(js, /postJson\('\/api\/flags\/all-on'/);
  assert.match(js, /postJson\('\/api\/event-flags\/all-on'/);
  assert.match(js, /postJson\('\/api\/event-flags\/all-off'/);
  assert.match(js, /function refreshFlagStatus\(\)/);
  assert.match(js, /function refreshEventFlagStatus\(\)/);
  assert.match(js, /function openFlagDetail\(flagId\)/);
  assert.match(js, /function openEventFlagDetail\(flagId\)/);
  assert.match(js, /function setAllFlagsOn\(\)/);
  assert.match(js, /function setAllEventFlagsOn\(\)/);
  assert.match(js, /function setAllEventFlagsOff\(\)/);
  assert.match(js, /function toggleCurrentFlagFromDetail\(\)/);
  assert.match(js, /function toggleCurrentEventFlagFromDetail\(\)/);
  assert.match(js, /function toggleCurrentEventCompletionFromDetail\(\)/);
  assert.match(js, /#flag-title-list/);
  assert.match(js, /#event-flag-title-list/);
  assert.match(js, /#set-all-flags-on/);
  assert.match(js, /#set-all-event-flags-on/);
  assert.match(js, /#set-all-event-flags-off/);
  assert.match(js, /#toggle-flag-active/);
  assert.match(js, /#toggle-event-flag-active/);
  assert.match(js, /#toggle-event-completion-active/);
  assert.match(js, /\/api\/debug\/llm-requests/);
  assert.match(js, /function refreshLlmRequestLog\(\)/);
  assert.match(js, /function openLlmRequestDetail\(/);
  assert.match(js, /setStreamStatus\('reflection: completed'\)/);
  assert.match(js, /finalization_status: 'running'/);
});

test('a leftover save flag for an event no longer in the definitions is inert, not a runtime error', async () => {
  // Deleting an event definition must let an old save that still carries its
  // ready/completed global flags progress normally: judgment targets and the
  // event status list are built from the definition set, so an orphan flag is
  // simply never visited (no throw, no phantom pending event).
  const root = await fixtureRoot('magic-adv-orphan-event-flag-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['event.removed_promise_example.ready'] = true;
  state.global_flags['event.removed_promise_example.completed'] = false;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');

  const definitions = await loadEventFlags({ root });
  assert.equal(definitions.flags.some((flag) => flag.id === 'event.removed_promise_example.ready'), false);

  const targets = selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state,
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  });
  assert.equal(targets.some((entry) => entry.id === 'event.removed_promise_example.ready'), false);

  const status = await getEventFlagStatus({ root });
  assert.equal(status.pending_events.some((entry) => entry.id === 'event.removed_promise_example.ready'), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('a save that still carries the removed 一緒に食事する約束 event flags is inert through the full event status read path', async () => {
  // The concrete deletion: an old save with event.shared_meal_promise.ready/completed and their sources must
  // load and read (event status / pending) without throwing and without the removed event reappearing.
  const root = await fixtureRoot('magic-adv-shared-meal-orphan-');
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.global_flags['event.shared_meal_promise.ready'] = true;
  state.global_flags['event.shared_meal_promise.completed'] = true;
  state.event_flag_sources = {
    ...(state.event_flag_sources ?? {}),
    'event.shared_meal_promise.ready': { character_id: 'lina', conversation_id: 'conv_shared_meal_source', achieved_at: '2026-05-08T15:11:00.000+09:00' }
  };
  state.event_completion_sources = {
    ...(state.event_completion_sources ?? {}),
    'event.shared_meal_promise.completed': { event_flag_id: 'event.shared_meal_promise.ready', character_id: 'lina', conversation_id: 'conv_shared_meal_event', achieved_at: '2026-05-08T15:51:00.000+09:00' }
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');

  const definitions = await loadEventFlags({ root });
  assert.equal(definitions.flags.some((flag) => flag.id === 'event.shared_meal_promise.ready'), false);

  const targets = selectEventFlagJudgmentTargets({
    flags: definitions.flags,
    state,
    inventory: { items: [] },
    conversation: { character_id: 'lina' }
  });
  assert.equal(targets.some((entry) => entry.id === 'event.shared_meal_promise.ready'), false);

  const status = await getEventFlagStatus({ root });
  assert.equal(status.flags.some((entry) => entry.id === 'event.shared_meal_promise.ready'), false);
  assert.equal(status.pending_events.some((entry) => entry.id === 'event.shared_meal_promise.ready'), false);
  await fs.rm(root, { recursive: true, force: true });
});
