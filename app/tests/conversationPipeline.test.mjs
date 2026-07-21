import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureRoot as createFixtureRoot } from './helpers.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import {
  academyPostTurnStatePolicy,
  companionPostTurnStatePolicy,
  editConversationUserMessage,
  finalizeConversation as finalizeConversationCore,
  resetContinuityRecords,
  runConversationOpening,
  runConversationTurn as runConversationTurnCore,
  startInteractionSession
} from '../src/llm/conversationPipeline.mjs';
import { streamConversationTurnSse } from '../src/server/conversationStreamingApi.mjs';
import { ensureSelectableCharacterStorage } from '../src/characterCatalog.mjs';
import { trainingDefinitions } from '../src/training.mjs';
import {
  conversationFinalizationStageFields,
  DUNGEON_SOURCE_TYPE,
  ERRAND_SOURCE_TYPE,
  STUDY_CIRCLE_SOURCE_TYPE,
  ROUTING_HUB_LOCATION_NAME,
  ROUTING_HUB_SOURCE_TYPE,
  ROUTING_HUB_VISIBLE_SITUATION
} from '../src/routingMetaContext.mjs';

function runConversationTurn(args) {
  return runConversationTurnCore({ postTurnStatePolicy: academyPostTurnStatePolicy, ...args });
}

// Seeds a selectable character's mutable surface (flags/skills) so it can be a
// conversation actor. Buddy/enemy relationship establishment is restricted to
// the selectable roster; the routing persona `lina` is excluded from it.
async function seedSelectableConversationActor(root, characterId) {
  await ensureSelectableCharacterStorage({ root, characterId });
}

function actorContextPromptBlock(prompt) {
  const start = prompt.indexOf('会話相手コンテキスト:');
  assert.ok(start >= 0, 'actor context block should be present');
  const tail = prompt.slice(start);
  const sceneBoundary = /\n(?:ワールド設定:|学院:|舞台:)/.exec(tail);
  assert.ok(sceneBoundary, 'actor context block should precede scene lines');
  return tail.slice(0, sceneBoundary.index);
}

function affinityContextLine(affinity) {
  return `主人公への好感度: ${affinity}/100（0=強い忌避・25=同級生の標準的な距離感・50=気安い相手・70=親しい友人・90以上=特別な存在）`;
}

function assertAffinityActorContextSection(prompt, affinity) {
  const block = actorContextPromptBlock(prompt);
  const lines = block.trimEnd().split('\n');
  const sectionIndex = lines.indexOf('好感度:');
  assert.ok(sectionIndex >= 0, 'affinity section should be present');
  assert.deepEqual(lines.slice(sectionIndex), [
    '好感度:',
    '- 主人公への好感度:',
    affinityContextLine(affinity)
  ]);
}

function finalizeConversation(args) {
  return finalizeConversationCore({ affinityDeltaProvider: async () => '0', mpReserveProvider: async () => '30', ...args });
}

function routingHubContext(personaVariant = 'fallen_star', overrides = {}) {
  return {
    persona_variant: personaVariant,
    recent_conversation_context: {
      kind: 'no_new_conversation',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    },
    relationship_context: {
      buddy: null,
      enemies: []
    },
    alchemy_context: {
      recipe_count: 8
    },
    study_circle_context: {
      theme_count: trainingDefinitions.length,
      weekly_offer_count: 3
    },
    content_result_context: null,
    ...overrides
  };
}

function routingTrainingContentResultContext() {
  return {
    record: {
      kind: 'training',
      destination_id: 'training',
      week: 0,
      recorded_at: '2026-05-05T06:10:00.000+09:00',
      trigger: 'training_completed',
      detail: {
        outcome: 'completed',
        trainings: [{
          day_index: 0,
          day_name: '光曜',
          training_id: 'healing_practice',
          training_name: '治癒魔法実習'
        }],
        parameter_deltas: {
          magic: { light: 2 },
          abilities: { strength: -1 }
        }
      }
    },
    companion: null
  };
}

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-pipeline-split-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', [{ id: 'herbology_garden', name: '薬草園', description: 'split pipeline fixture' }]);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'split pipeline fixture',
    world_condition_texts: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'field',
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    disabled_stage_flag_judgment_flows: {},
    visited_locations: ['herbology_garden'],
    active_character_ids: ['lina'],
    last_conversation_id: null,
    characters: { lina: { flags: {} } },
    pending_interaction_context: null,
    training_actions_used: 0,
    training_actions_limit: 6,
    elapsed_weeks: 0,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/player_inventory.json', { money: 0, items: [] });
  await writeSplitJson(root, 'data/mutable/game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/flags.json', { character_id: 'lina', flags: {} });
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    character_id: 'lina',
    display_name: 'リナ',
    identity: '薬草園の生徒',
    visual_set_id: 'lina',
    prompt_description: '薬草の観察が得意。',
    speaking_basis: '丁寧に話す。',
    available_expressions: ['neutral', 'happy'],
    parameters: { magic: {}, abilities: {} }
  });
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/skills.json', { character_id: 'lina', skills: [] });
  return root;
}

async function creatureDialogueRoot() {
  const root = await splitFixtureRoot();
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', [{
    id: 'sanrin_mossy_shrine',
    display_name: '苔むした古祠',
    visible_situation: '苔むした石灯籠が淡く光っている。'
  }]);
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    ...state,
    current_location_id: 'sanrin_mossy_shrine',
    current_location_visible_situation: '苔むした石灯籠が淡く光っている。',
    creatures: {}
  });
  await writeSplitJson(root, 'content/creatures/creature_001/profile.json', {
    character_id: 'creature_001',
    display_name: '苔火',
    kind: 'spirit',
    kind_label: '精霊',
    habitat: '山林の苔むした古祠',
    hostility: 'none',
    identity: '学院には属さない山林の灯火精霊。',
    prompt_description: '石灯籠の青緑の火として、ゆっくり穏やかに話す。',
    speaking_basis: '古い灯がまたたくように、短く静かに話す。',
    parameters: { magic: {}, abilities: {} }
  });
  await writeSplitJson(root, 'data/mutable/game_data/creatures/creature_001/flags.json', {
    character_id: 'creature_001',
    flags: { 'knowledge.creature_001.lantern_seen': false }
  });
  await writeSplitJson(root, 'data/mutable/game_data/creatures/creature_001/skills.json', {
    character_id: 'creature_001',
    skills: []
  });
  await fs.mkdir(path.join(root, 'data/mutable/game_data/creatures/creature_001/memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/mutable/game_data/creatures/creature_001/work_records'), { recursive: true });
  return root;
}

async function fixtureRoot() {
  return createFixtureRoot('magic-adv-pipeline-');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function exists(root, relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(assertion, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

test('runConversationTurn requires an explicit post-turn state policy', async () => {
  const root = await fixtureRoot();

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_policy_required_001',
      characterId: 'lina',
      playerInput: 'policy が無いと進めない確認です',
      now: '2026-05-05T06:00:00.000+09:00',
      chatProvider: async () => 'これは到達しません。'
    }),
    /postTurnStatePolicy is required/
  );
});

test('companion post-turn policy preserves dungeon state and skips stage movement', async () => {
  const root = await fixtureRoot();
  const conversationId = 'conv_companion_policy_001';
  const beforeState = {
    ...await readJson(root, 'game_data/runtime_state.json'),
    current_screen: 'academy-dungeon',
    current_interaction_character_id: null,
    last_conversation_id: conversationId,
    current_location_id: 'forbidden_archive_door',
    current_location_visible_situation: '禁書庫の扉の前にいる。',
    dungeon_run: {
      run_id: 'dr_policy',
      status: 'active',
      companion: { character_id: 'lina', conversation_id: conversationId }
    }
  };
  await writeSplitJson(root, 'game_data/runtime_state.json', beforeState);
  await writeSplitJson(root, `game_data/logs/conversations/${conversationId}.json`, {
    id: conversationId,
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T05:59:00.000+09:00',
    updated_at: '2026-05-05T05:59:00.000+09:00',
    source_type: DUNGEON_SOURCE_TYPE,
    location_name: '実践ダンジョンの第1層',
    visible_situation: '実践ダンジョンの第1層。禁書庫の扉の前で主人公と合流した。',
    conversation_actor_context: null,
    prompt: 'opening prompt',
    messages: [{ role: 'assistant', content: '足元に気をつけてください。' }]
  });
  let stageMoveAgreementCalled = false;

  const result = await runConversationTurnCore({
    root,
    id: conversationId,
    characterId: 'lina',
    playerInput: '少し話してから進もう',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    // A dungeon companion turn re-supplies the dungeon scene every turn (the real dungeon path does the same);
    // the injected-scene invariant requires it for a dungeon-source_type conversation. The scene carries its own
    // prompt_tail_context so this policy-focused test does not depend on full dungeon-run player state.
    dungeonSceneContext: {
      source_type: DUNGEON_SOURCE_TYPE,
      location_name: '実践ダンジョンの第1層',
      visible_situation: '実践ダンジョンの第1層を主人公と一緒に探索している。',
      prompt_tail_context: '実践ダンジョンを主人公と一緒に探索している同行者としての状況。'
    },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'はい。足音を抑えて進みましょう。',
    conversationContinuationProvider: async () => 'true',
    stageMoveAgreementProvider: async () => {
      stageMoveAgreementCalled = true;
      return 'true';
    },
    stageMoveDestinationProvider: async () => {
      throw new Error('companion policy must skip stage-move destination selection');
    },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(stageMoveAgreementCalled, false);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
  assert.equal(result.state.current_screen, 'academy-dungeon');
  assert.equal(result.state.current_interaction_character_id, null);
  assert.equal(result.state.last_conversation_id, conversationId);
  assert.equal(result.state.current_location_id, 'forbidden_archive_door');
  assert.equal(result.state.current_location_visible_situation, '禁書庫の扉の前にいる。');
  const persistedState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(persistedState.current_screen, 'academy-dungeon');
  assert.equal(persistedState.current_interaction_character_id, null);
  assert.equal(persistedState.last_conversation_id, conversationId);
  assert.equal(persistedState.current_location_id, 'forbidden_archive_door');
  assert.equal(persistedState.current_location_visible_situation, '禁書庫の扉の前にいる。');
  const persistedConversation = await readJson(root, `game_data/logs/conversations/${conversationId}.json`);
  assert.deepEqual(persistedConversation.messages.map((message) => message.content), [
    '足元に気をつけてください。',
    '少し話してから進もう',
    'はい。足音を抑えて進みましょう。'
  ]);
});

test('runConversationOpening with a dungeon scene context frames the opening as a dungeon encounter, not the field location', async () => {
  const root = await fixtureRoot();
  let openingPrompt = '';
  await runConversationOpening({
    root,
    id: 'conv_dungeon_dr_4242',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    dungeonSceneContext: {
      location_name: '実践ダンジョン 第1層',
      visible_situation: '実践ダンジョンの第1層。探索の途中で主人公と出会い、ここから一緒に潜ることになった。'
    },
    chatProvider: async ({ prompt }) => {
      openingPrompt = prompt;
      return 'ここで会うとは。さあ、一緒に進みましょう。';
    }
  });

  assert.match(openingPrompt, /舞台: 実践ダンジョン 第1層/);
  assert.match(openingPrompt, /探索の途中で主人公と出会い、ここから一緒に潜ることになった。/);
  assert.doesNotMatch(openingPrompt, /舞台: 薬草温室/);
});

test('runConversationTurn with a dungeon scene context renders the dungeon floor scene instead of the field location', async () => {
  const root = await fixtureRoot();
  let turnPrompt = '';
  await runConversationTurnCore({
    root,
    id: 'conv_dungeon_dr_4242',
    characterId: 'lina',
    playerInput: 'この階、敵が多いね',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: {
      location_name: '実践ダンジョン 第3層',
      visible_situation: '実践ダンジョンの第3層を主人公と一緒に探索している。'
    },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ prompt }) => {
      turnPrompt = prompt;
      return '気を抜かないで。私が前に出ます。';
    },
    conversationContinuationProvider: async () => 'true',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.match(turnPrompt, /舞台: 実践ダンジョン 第3層/);
  assert.match(turnPrompt, /実践ダンジョンの第3層を主人公と一緒に探索している。/);
  assert.doesNotMatch(turnPrompt, /舞台: 薬草温室/);
});

test('runConversationTurn places dungeon companion status context below world settings and the reply can use it', async () => {
  const root = await fixtureRoot();
  let turnPrompt = '';
  const result = await runConversationTurnCore({
    root,
    id: 'conv_dungeon_tail_001',
    characterId: 'lina',
    playerInput: '今の状況を見て、どう動く？',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: {
      location_name: '実践ダンジョン 第2層',
      visible_situation: '実践ダンジョンの第2層を主人公と一緒に探索している。',
      prompt_tail_context: [
        '- 階層: 第2層 / 全5層',
        '- 主人公: HP 5/96, MP 3/48',
        '- 同行者 リナ・クラウゼ: HP 7/88, MP 4/42',
        '- 近くの敵: 石塊ゴーレム HP 40/80 距離1',
        '- 近くのアイテム: 癒し草 距離1'
      ].join('\n')
    },
    emotionProvider: async () => ({ expression: 'worried' }),
    chatProvider: async ({ prompt }) => {
      turnPrompt = prompt;
      return prompt.includes('主人公: HP 5/96') && prompt.includes('近くの敵: 石塊ゴーレム')
        ? 'HPが危険です。癒し草を拾ってから、石塊ゴーレムを避けて下がりましょう。'
        : '周囲を見てから進みましょう。';
    },
    conversationContinuationProvider: async () => 'true',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  const worldIndex = turnPrompt.indexOf('ワールド設定:');
  const statusIndex = turnPrompt.indexOf('追加の現在状況:');
  const stageIndex = turnPrompt.indexOf('舞台: 実践ダンジョン 第2層');
  const playerInputIndex = turnPrompt.indexOf('プレイヤーの発言: 今の状況を見て、どう動く？');
  assert.ok(worldIndex >= 0, 'world settings remain present');
  assert.ok(statusIndex > worldIndex, 'dungeon status context sits after world settings');
  assert.ok(statusIndex < stageIndex, 'dungeon status context sits before the stage line');
  assert.ok(statusIndex < playerInputIndex, 'dungeon status context is no longer appended after the turn input');
  assert.match(turnPrompt, /主人公: HP 5\/96, MP 3\/48/);
  assert.match(turnPrompt, /同行者 リナ・クラウゼ: HP 7\/88, MP 4\/42/);
  assert.match(turnPrompt, /近くの敵: 石塊ゴーレム HP 40\/80/);
  assert.match(turnPrompt, /近くのアイテム: 癒し草/);
  assert.equal(result.conversation.messages.at(-1).content, 'HPが危険です。癒し草を拾ってから、石塊ゴーレムを避けて下がりましょう。');
});

test('without a dungeon scene context the opening keeps the academy field location scene (academy unaffected)', async () => {
  const root = await fixtureRoot();
  let openingPrompt = '';
  await runConversationOpening({
    root,
    id: 'conv_field_scene_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async ({ prompt }) => {
      openingPrompt = prompt;
      return '棚札の並びを見てから話しましょう。';
    }
  });

  assert.match(openingPrompt, /舞台: 薬草温室/);
  assert.doesNotMatch(openingPrompt, /実践ダンジョン/);
});

test('routingHubContext undefined is byte-equivalent to omitting it', async () => {
  const omittedRoot = await fixtureRoot();
  const explicitUndefinedRoot = await fixtureRoot();
  let omittedPrompt = '';
  let explicitUndefinedPrompt = '';

  await runConversationOpening({
    root: omittedRoot,
    id: 'conv_undefined_equivalence_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async ({ prompt }) => {
      omittedPrompt = prompt;
      return '棚札の並びを見てから話しましょう。';
    }
  });
  await runConversationOpening({
    root: explicitUndefinedRoot,
    id: 'conv_undefined_equivalence_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    routingHubContext: undefined,
    chatProvider: async ({ prompt }) => {
      explicitUndefinedPrompt = prompt;
      return '棚札の並びを見てから話しましょう。';
    }
  });

  assert.equal(explicitUndefinedPrompt, omittedPrompt);
  assert.doesNotMatch(explicitUndefinedPrompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(explicitUndefinedPrompt, /ルミ/);
});

test('runConversationOpening with routingHubContext uses routing persona and meta instead of the disk lina profile', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 0 });
  const profile = await readJson(root, 'game_data/characters/lina/profile.json');
  await writeSplitJson(root, 'game_data/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 80, dark: 0, fire: 0, water: 0, earth: 0, wind: 0 },
      abilities: {}
    }
  });
  let openingPrompt = '';
  const opened = await runConversationOpening({
    root,
    id: 'conv_routing_hub_opening_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    routingHubContext: routingHubContext('fallen_star'),
    chatProvider: async ({ prompt, profile, playerInput }) => {
      openingPrompt = prompt;
      assert.equal(profile.character_id, 'lina');
      assert.equal(profile.display_name, 'ルミ');
      assert.equal(playerInput, null);
      return '新しい週を、ここから一緒に選びましょう。';
    }
  });

  assert.equal(opened.conversation.character_name, 'ルミ');
  assert.deepEqual(opened.conversation.routing_hub, routingHubContext('fallen_star'));
  assert.match(openingPrompt, /会話相手コンテキスト:\n系統知識:/);
  assert.match(openingPrompt, /光魔法の基礎。光は生成・集束・定着の三段で扱い/);
  assert.match(openingPrompt, /光魔法の応用。高位治癒では対象の魔力路そのものを整え/);
  assert.match(openingPrompt, /あなたはルミである。/);
  assert.match(openingPrompt, /名前をどこかに落としてしまった小さな星/);
  assert.match(openingPrompt, /ルーティング会話メタ情報:/);
  assert.match(openingPrompt, /このオープニングの文脈:/);
  assert.match(openingPrompt, /ルーティングハブopening誘導:/);
  assert.match(openingPrompt, /体調・気分・近況を伺う世間話/);
  assert.match(openingPrompt, /行き先の確認・催促から入らない/);
  assert.match(openingPrompt, /世間話から入る/);
  const worldIndex = openingPrompt.indexOf('ワールド設定:');
  const statusIndex = openingPrompt.indexOf('追加の現在状況:');
  const stageIndex = openingPrompt.indexOf('舞台: ルーティングハブ');
  assert.ok(statusIndex > worldIndex, 'routing meta context sits after world settings');
  assert.ok(statusIndex < stageIndex, 'routing meta context sits before the routing hub stage line');
  assert.match(openingPrompt, /現在は第1週/);
  assert.match(openingPrompt, /学院マップ/);
  assert.match(openingPrompt, /鍛錬/);
  assert.match(openingPrompt, /ダンジョン/);
  assert.match(openingPrompt, /数値範囲は0〜100/);
  assert.match(openingPrompt, /カリスマ:/);
  assert.doesNotMatch(openingPrompt, /薬草の観察が得意/);
});

test('runConversationOpening with routingHubContext renders every opening smalltalk guidance branch', async () => {
  const scenarios = [
    {
      id: 'memory',
      context: routingHubContext('fallen_star', {
        recent_conversation_context: {
          kind: 'conversation_memory',
          conversation_id: 'conv_recent_memory_branch_001',
          character_id: 'character_001',
          character_name: 'セラ・アストルーペ',
          memory_text: '主人公は星図の読み方を少し覚えた。'
        }
      }),
      expected: /主人公は星図の読み方を少し覚えた。/
    },
    {
      id: 'without_memory',
      context: routingHubContext('fallen_star', {
        recent_conversation_context: {
          kind: 'conversation_without_memory',
          conversation_id: 'conv_recent_without_memory_branch_001',
          character_id: 'character_002',
          character_name: 'ミラ',
          memory_text: null
        }
      }),
      expected: /記憶を捏造しない/
    },
    {
      id: 'content_result',
      context: routingHubContext('fallen_star', {
        content_result_context: routingTrainingContentResultContext()
      }),
      expected: /直近コンテンツ結果: 鍛錬（完了）/
    },
    {
      id: 'generic',
      context: routingHubContext('fallen_star'),
      expected: /体調・気分・近況を伺う世間話/
    }
  ];

  for (const scenario of scenarios) {
    const root = await fixtureRoot();
    const state = await readJson(root, 'game_data/runtime_state.json');
    await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 0 });
    let openingPrompt = '';
    await runConversationOpening({
      root,
      id: `conv_routing_hub_guidance_${scenario.id}_001`,
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      routingHubContext: scenario.context,
      chatProvider: async ({ prompt }) => {
        openingPrompt = prompt;
        return '少し話してから、今週のことを一緒に考えましょう。';
      }
    });

    assert.match(openingPrompt, /このオープニングの文脈:/);
    assert.match(openingPrompt, /ルーティングハブopening誘導:/);
    assert.match(openingPrompt, scenario.expected);
    assert.match(openingPrompt, /行き先の確認・催促から入らない/);
    assert.match(openingPrompt, /世間話がひと段落してから/);
  }
});

test('runConversationOpening with routingHubContext fails fast when explicitly pointed at a non-routing conversation', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  const existingConversationId = 'conv_existing_lina_route_boundary_003';
  await writeSplitJson(root, `game_data/logs/conversations/${existingConversationId}.json`, {
    id: existingConversationId,
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T05:00:00.000+09:00',
    updated_at: '2026-05-05T05:10:00.000+09:00',
    academy_week_number: 1,
    academy_elapsed_weeks_at_start: 0,
    source_type: 'field',
    location_id: state.current_location_id,
    time_slot: state.time_slot,
    prompt: 'old prompt',
    messages: [{ role: 'assistant', content: 'OLD_ACTIVE_ASSISTANT_MARKER' }]
  });
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 0 });

  await assert.rejects(
    runConversationOpening({
      root,
      id: existingConversationId,
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      routingHubContext: routingHubContext('fallen_star'),
      chatProvider: async () => 'ここには到達しません。'
    }),
    /routingHubContext cannot open over a non-routing conversation/
  );
});

test('runConversationTurn carries routingHubContext through reply and helper prompts', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 0 });
  const profile = await readJson(root, 'game_data/characters/lina/profile.json');
  await writeSplitJson(root, 'game_data/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 0, dark: 0, fire: 80, water: 0, earth: 0, wind: 0 },
      abilities: {}
    }
  });
  let replyPrompt = '';
  let continuationPrompt = '';
  const result = await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_turn_001',
    characterId: 'lina',
    playerInput: '今週はどう動ける？',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('dethroned_constellation'),
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ prompt, profile }) => {
      replyPrompt = prompt;
      assert.equal(profile.display_name, 'アステリア・スタークラウン');
      return '行き先を三つ並べます。選ぶのはあなたです。';
    },
    conversationContinuationProvider: async ({ prompt, profile }) => {
      continuationPrompt = prompt;
      assert.equal(profile.display_name, 'アステリア・スタークラウン');
      return 'true';
    },
    routingDestinationProvider: async () => 'none',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.match(replyPrompt, /星の座を降ろされた/);
  assert.match(replyPrompt, /会話相手コンテキスト:\n系統知識:/);
  assert.match(replyPrompt, /火魔法の基礎。火は起こす・保つ・止めるの三段で扱い/);
  assert.match(replyPrompt, /火魔法の応用。魔導工学の炉心は、燃料でなく術式で燃え続ける/);
  assert.match(replyPrompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(replyPrompt, /このオープニングの文脈:/);
  assert.doesNotMatch(replyPrompt, /ルーティングハブopening誘導:/);
  assert.match(continuationPrompt, /アステリア・スタークラウンとして、この発言を行ったプレイヤーとの会話を継続したいと思うか。/);
  assert.doesNotMatch(continuationPrompt, /ルーティングハブopening誘導:/);
  assert.equal(result.conversation.character_name, 'アステリア・スタークラウン');
  assert.deepEqual(result.conversation.routing_hub, routingHubContext('dethroned_constellation'));
});

test('runConversationTurn with routingHubContext judges a closed-catalog destination once and only writes transition text', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 4 });
  const order = [];
  let destinationPrompt = '';
  let transitionPrompt = '';
  const assistantCompletes = [];

  const result = await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_destination_001',
    characterId: 'lina',
    playerInput: '今週は鍛錬に集中したい',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    emotionProvider: async () => ({ expression: 'joy' }),
    chatProvider: async () => {
      order.push('chat');
      return '鍛錬ですね。今の伸ばしたい力にも合っています。';
    },
    conversationContinuationProvider: async () => {
      order.push('continuation');
      return 'true';
    },
    routingDestinationProvider: async ({ prompt, destinations, currentConversation }) => {
      order.push('routing_destination');
      destinationPrompt = prompt;
      assert.deepEqual(destinations.map((destination) => destination.id), ['academy-map', 'training', 'dungeon', 'errand', 'alchemy', 'study_circle', 'workshop', 'library', 'arena', 'auction', 'lounge', 'title']);
      assert.deepEqual(currentConversation.map((message) => message.content), [
        '今週は鍛錬に集中したい',
        '鍛錬ですね。今の伸ばしたい力にも合っています。'
      ]);
      return 'training';
    },
    routingTransitionProvider: async ({ prompt, destination, generatedAssistantText }) => {
      order.push('routing_transition');
      transitionPrompt = prompt;
      assert.equal(destination.id, 'training');
      assert.equal(generatedAssistantText, '鍛錬ですね。今の伸ばしたい力にも合っています。');
      return 'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。';
    },
    stageMoveAgreementProvider: async () => {
      throw new Error('routing hub must not run field stage-move agreement');
    },
    workRecordRecallProvider: async () => ({ work_record_ids: [] }),
    onAssistantComplete: ({ content }) => {
      assistantCompletes.push(content);
    }
  });

  assert.deepEqual(order, ['chat', 'continuation', 'routing_destination', 'routing_transition']);
  assert.match(destinationPrompt, /ルーティングハブ会話内容/);
  assert.match(destinationPrompt, /返答は対応表にあるdestination_idを1つだけ返す/);
  assert.match(destinationPrompt, /学院マップ: academy-map/);
  assert.match(destinationPrompt, /鍛錬: training/);
  assert.match(destinationPrompt, /ダンジョン: dungeon/);
  assert.match(destinationPrompt, /調合: alchemy/);
  assert.match(destinationPrompt, /研究会: study_circle/);
  assert.doesNotMatch(destinationPrompt, /location_id/);
  assert.match(transitionPrompt, /行き先が確定したプレイヤーを送り出す/);
  assert.match(transitionPrompt, /先ほど自分が生成した発言: 鍛錬ですね。今の伸ばしたい力にも合っています。/);
  assert.deepEqual(assistantCompletes, [
    '鍛錬ですね。今の伸ばしたい力にも合っています。',
    'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。'
  ]);
  assert.deepEqual(result.routing_destination, {
    destination_id: 'training',
    destination_label: '鍛錬',
    transition_assistant_text: 'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。',
    narration: '行き先は鍛錬に決まった。六つの行動で一週間の鍛錬を進め、魔法習熟度と基礎能力のパラメーターを増減させる。'
  });
  assert.equal(result.conversation.routing_destination_judgment.destination_id, 'training');
  assert.equal(result.conversation.routing_destination_judgment.decided, true);
  assert.equal(result.conversation.routing_destination_judgment.model_response, 'training');
  assert.match(result.conversation.routing_destination_judgment.prompt, /destination_id/);
  assert.deepEqual(result.conversation.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'system']);
  assert.deepEqual(result.conversation.messages.map((message) => message.content), [
    '今週は鍛錬に集中したい',
    '鍛錬ですね。今の伸ばしたい力にも合っています。',
    'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。',
    '行き先は鍛錬に決まった。六つの行動で一週間の鍛錬を進め、魔法習熟度と基礎能力のパラメーターを増減させる。'
  ]);
  assert.equal(result.state.current_location_id, state.current_location_id);
  assert.equal(result.state.elapsed_weeks, 4);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
});

test('runConversationTurn with routingHubContext keeps talking when the destination is still undecided', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 1 });
  let transitionCalled = false;

  const result = await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_destination_none_001',
    characterId: 'lina',
    playerInput: 'もう少し相談したい',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('hourglass_grain'),
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'まだ形はひとつに定まっていません。',
    conversationContinuationProvider: async () => 'true',
    routingDestinationProvider: async () => 'none',
    routingTransitionProvider: async () => {
      transitionCalled = true;
      return 'ここには到達しません。';
    },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(transitionCalled, false);
  assert.equal(Object.hasOwn(result, 'routing_destination'), false);
  assert.equal(result.conversation.routing_destination_judgment.decided, false);
  assert.equal(result.conversation.routing_destination_judgment.destination_id, null);
  assert.deepEqual(result.conversation.messages.map((message) => message.content), [
    'もう少し相談したい',
    'まだ形はひとつに定まっていません。'
  ]);
  assert.equal(result.state.current_location_id, state.current_location_id);
  assert.equal(result.state.elapsed_weeks, 1);
});

test('runConversationTurn with routingHubContext fails fast on unknown routing destination output', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 2 });

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_routing_hub_destination_bad_001',
      characterId: 'lina',
      playerInput: '鍛錬かダンジョンで迷っている',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: academyPostTurnStatePolicy,
      routingHubContext: routingHubContext('stardust_sweeper'),
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => '候補は二つ残っています。',
      conversationContinuationProvider: async () => 'true',
      routingDestinationProvider: async () => 'training,dungeon',
      routingTransitionProvider: async () => 'ここには到達しません。'
    }),
    /unknown routing destination/
  );

  assert.equal(await exists(root, 'game_data/logs/conversations/conv_routing_hub_destination_bad_001.json'), false);
});

test('runConversationTurn with routingHubContext fails fast on invalid conversation continuation output before persistence', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 2 });

  let captured;
  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_routing_hub_continuation_invalid_001',
      characterId: 'lina',
      playerInput: '鍛錬にするか迷っている',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: academyPostTurnStatePolicy,
      routingHubContext: routingHubContext('fallen_star'),
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => '候補はまだ絞れていません。',
      // Invalid continuation judgment output (neither true nor false): it must fail fast with a
      // structured error, not be silently rounded to false and end the hub conversation with no decided
      // destination (which stranded the client on the loading screen).
      conversationContinuationProvider: async () => 'maybe',
      routingDestinationProvider: async () => 'none',
      routingTransitionProvider: async () => 'ここには到達しません。',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    (error) => {
      captured = error;
      return /conversation continuation judgment must be true or false/.test(error.message);
    }
  );
  assert.equal(captured.errorCode, 'INVALID_LLM_CONTINUATION_OUTPUT');
  assert.equal(captured.statusCode, 503);
  assert.equal(await exists(root, 'game_data/logs/conversations/conv_routing_hub_continuation_invalid_001.json'), false);
});

test('runConversationTurn fails fast on invalid conversation continuation output on the shared academy path', async () => {
  const root = await fixtureRoot();

  // Continuation strictness lives on the shared turn path, so loop / academy conversations fail fast on
  // invalid output too — not only routing hub turns.
  await assert.rejects(
    runConversationTurn({
      root,
      id: 'conv_academy_continuation_invalid_001',
      characterId: 'lina',
      playerInput: 'もう少し話そう',
      now: '2026-05-05T06:05:00.000+09:00',
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい、続けましょう。',
      conversationContinuationProvider: async () => '',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    /conversation continuation judgment must be true or false/
  );
  assert.equal(await exists(root, 'game_data/logs/conversations/conv_academy_continuation_invalid_001.json'), false);
});

test('runConversationTurn with routingHubContext does not inherit a non-routing active lina conversation', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  const existingConversationId = 'conv_existing_lina_route_boundary_001';
  const existingConversation = {
    id: existingConversationId,
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T05:00:00.000+09:00',
    updated_at: '2026-05-05T05:10:00.000+09:00',
    academy_week_number: 1,
    academy_elapsed_weeks_at_start: 0,
    source_type: 'field',
    location_id: state.current_location_id,
    time_slot: state.time_slot,
    prompt: 'old prompt',
    messages: [
      { role: 'user', content: 'OLD_ACTIVE_USER_MARKER' },
      { role: 'assistant', content: 'OLD_ACTIVE_ASSISTANT_MARKER' }
    ]
  };
  await writeSplitJson(root, `game_data/logs/conversations/${existingConversationId}.json`, existingConversation);
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 0,
    last_conversation_id: existingConversationId,
    current_screen: 'interaction',
    current_interaction_character_id: 'lina'
  });

  let replyPrompt = '';
  const result = await runConversationTurnCore({
    root,
    characterId: 'lina',
    playerInput: '今週の行き先を選びたい',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ prompt, profile }) => {
      replyPrompt = prompt;
      assert.equal(profile.display_name, 'ルミ');
      return 'ここから行き先を選びましょう。';
    },
    conversationContinuationProvider: async () => true,
    routingDestinationProvider: async () => 'none',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.notEqual(result.conversation.id, existingConversationId);
  assert.equal(result.conversation.character_name, 'ルミ');
  assert.deepEqual(result.conversation.messages.map((message) => message.content), [
    '今週の行き先を選びたい',
    'ここから行き先を選びましょう。'
  ]);
  assert.doesNotMatch(replyPrompt, /OLD_ACTIVE_USER_MARKER/);
  assert.doesNotMatch(replyPrompt, /OLD_ACTIVE_ASSISTANT_MARKER/);
  assert.equal(result.state.last_conversation_id, result.conversation.id);
  assert.equal((await readJson(root, `game_data/logs/conversations/${existingConversationId}.json`)).character_name, 'リナ・クラウゼ');
});

test('runConversationTurn with routingHubContext fails fast when explicitly pointed at a non-routing conversation', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  const existingConversationId = 'conv_existing_lina_route_boundary_002';
  await writeSplitJson(root, `game_data/logs/conversations/${existingConversationId}.json`, {
    id: existingConversationId,
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T05:00:00.000+09:00',
    updated_at: '2026-05-05T05:10:00.000+09:00',
    academy_week_number: 1,
    academy_elapsed_weeks_at_start: 0,
    source_type: 'field',
    location_id: state.current_location_id,
    time_slot: state.time_slot,
    prompt: 'old prompt',
    messages: [{ role: 'assistant', content: 'OLD_ACTIVE_ASSISTANT_MARKER' }]
  });
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    last_conversation_id: existingConversationId,
    current_screen: 'interaction',
    current_interaction_character_id: 'lina'
  });

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: existingConversationId,
      characterId: 'lina',
      playerInput: 'この古い会話ではなくルーティングで話したい',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: academyPostTurnStatePolicy,
      routingHubContext: routingHubContext('fallen_star'),
      chatProvider: async () => 'ここには到達しません。'
    }),
    /routingHubContext cannot continue a non-routing conversation/
  );
});

test('academy conversation prompts do not include dungeon companion tail context markers', async () => {
  const root = await fixtureRoot();
  let academyPrompt = '';
  await runConversationTurn({
    root,
    id: 'conv_academy_no_dungeon_tail_001',
    characterId: 'lina',
    playerInput: '薬草棚を見よう',
    now: '2026-05-05T06:00:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ prompt }) => {
      academyPrompt = prompt;
      return '棚札の順番から見ていきましょう。';
    },
    conversationContinuationProvider: async () => 'true',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.match(academyPrompt, /舞台: 薬草温室/);
  assert.doesNotMatch(academyPrompt, /追加の現在状況:/);
  assert.doesNotMatch(academyPrompt, /実践ダンジョン同行状況/);
  assert.doesNotMatch(academyPrompt, /近くの敵:/);
});

test('runConversationTurn with a graduation guide context judges the graduation partner instead of a routing destination', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 49 });
  const order = [];
  let replyPrompt = '';
  let selectionPrompt = '';
  const guideContext = {
    candidates: [
      { character_id: 'character_008', display_name: 'エイト' },
      { character_id: 'character_001', display_name: 'ワン' },
      { character_id: 'character_002', display_name: 'ツー' }
    ]
  };

  const result = await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_guide_001',
    characterId: 'lina',
    playerInput: 'ずっと一緒だったエイトと最後を過ごしたい',
    now: '2026-05-26T06:00:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    routingGraduationGuideContext: guideContext,
    emotionProvider: async () => ({ expression: 'joy' }),
    chatProvider: async ({ prompt }) => {
      order.push('chat');
      replyPrompt = prompt;
      return 'ええ、あなたの学院生活の締めくくりですね。';
    },
    routingGraduationGuideProvider: async ({ prompt, candidates }) => {
      order.push('guide_selection');
      selectionPrompt = prompt;
      // The judgment set is the memory-ranked candidates plus the guide persona (案内人自身・lina).
      assert.deepEqual(candidates.map((candidate) => candidate.character_id), ['character_008', 'character_001', 'character_002', 'lina']);
      return 'character_008';
    },
    routingDestinationProvider: async () => { throw new Error('destination selection must not run during the guide'); },
    conversationContinuationProvider: async () => { throw new Error('the continuation judgment must not run during the guide'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.deepEqual(order, ['chat', 'guide_selection']);
  // The reply prompt presents the graduation guide framing, the three candidate names, and the guide-self
  // option (criterion 2). Candidates are listed by display name only (no character_id) and the guide names
  // them again in the dedicated final instruction.
  assert.match(replyPrompt, /卒業ガイド【最優先・今週で唯一の目的】/);
  assert.match(replyPrompt, /締めくくりの相手候補（この名前を会話の中で必ず挙げる）:/);
  assert.match(replyPrompt, /締めくくりの相手の候補（エイト、ワン、ツー、そして案内人自身のルミ）/);
  assert.match(replyPrompt, /- ルミ（案内人自身。/);
  assert.match(selectionPrompt, /締めくくりの相手の名称とcharacter_idの対応表/);
  assert.match(selectionPrompt, /エイト: character_008/);
  // The guide persona is in the judgment table as the effective variant name → lina.
  assert.match(selectionPrompt, /ルミ: lina/);
  // The selection resolves and this turn ends so phase 2 (the character event) can begin (criterion 3).
  assert.equal(result.routing_graduation_guide_selection.character_id, 'character_008');
  assert.equal(result.routing_destination, undefined);
  assert.equal(result.conversation.graduation_guide_judgment.decided, true);
  assert.equal(result.conversation.graduation_guide_judgment.character_id, 'character_008');
  assert.equal(result.conversation.routing_destination_judgment, undefined);
  const lastMessage = result.conversation.messages.at(-1);
  assert.equal(lastMessage.role, 'system');
  assert.match(lastMessage.content, /エイト/);
});

test('runConversationTurn with a graduation guide context continues the conversation when no partner is chosen', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 49 });
  const guideContext = {
    candidates: [
      { character_id: 'character_008', display_name: 'エイト' },
      { character_id: 'character_001', display_name: 'ワン' }
    ]
  };

  const result = await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_guide_none_001',
    characterId: 'lina',
    playerInput: 'うーん、まだ決められない',
    now: '2026-05-26T06:05:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    routingGraduationGuideContext: guideContext,
    emotionProvider: async () => ({ expression: 'joy' }),
    chatProvider: async () => 'ゆっくり選んでいいんですよ。',
    routingGraduationGuideProvider: async () => 'none',
    routingDestinationProvider: async () => { throw new Error('destination selection must not run during the guide'); },
    conversationContinuationProvider: async () => { throw new Error('the continuation judgment must not run during the guide'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(result.routing_graduation_guide_selection, undefined);
  assert.equal(result.conversation.graduation_guide_judgment.decided, false);
  assert.equal(result.conversation.graduation_guide_judgment.character_id, null);
  // No selection narration is appended; the reply is the last message and the conversation continues.
  assert.equal(result.conversation.messages.at(-1).role, 'assistant');
  assert.equal(result.conversation.messages.at(-1).content, 'ゆっくり選んでいいんですよ。');
});

test('runConversationTurn with a graduation guide context can select the guide persona itself as the partner', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 49 });
  const guideContext = {
    candidates: [
      { character_id: 'character_008', display_name: 'エイト' },
      { character_id: 'character_001', display_name: 'ワン' }
    ]
  };

  const result = await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_guide_persona_001',
    characterId: 'lina',
    playerInput: 'ずっと見守ってくれたあなたと最後を過ごしたい',
    now: '2026-05-26T06:10:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    routingGraduationGuideContext: guideContext,
    emotionProvider: async () => ({ expression: 'joy' }),
    chatProvider: async () => 'わたしと、ですか。',
    routingGraduationGuideProvider: async () => 'lina',
    routingDestinationProvider: async () => { throw new Error('destination selection must not run during the guide'); },
    conversationContinuationProvider: async () => { throw new Error('the continuation judgment must not run during the guide'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  // The guide persona (lina) is confirmed as the graduation partner; its display name is the effective
  // variant proper name (fallen_star = ルミ).
  assert.equal(result.routing_graduation_guide_selection.character_id, 'lina');
  assert.equal(result.routing_graduation_guide_selection.display_name, 'ルミ');
  assert.equal(result.conversation.graduation_guide_judgment.decided, true);
  assert.equal(result.conversation.graduation_guide_judgment.character_id, 'lina');
  const lastMessage = result.conversation.messages.at(-1);
  assert.equal(lastMessage.role, 'system');
  assert.equal(lastMessage.content, '卒業の締めくくりを共に過ごす相手はルミに決まった。');
});

// Prompt contract for the graduation guide reply prompt (A+B+C) vs a normal routing hub reply prompt. Locks
// the strengthened framing, the dedicated final instruction, and the removed destination catalog on the guide
// turn, and confirms a non-guide hub turn is unaffected (default instruction + catalog, no guide wording).
const DEFAULT_REPLY_INSTRUCTION_MARKER = /気になった一点にだけ触れて反応する/;
const GUIDE_REPLY_INSTRUCTION_MARKERS = [
  /いまは学院生活を締めくくる卒業の局面であり、次の行き先を決める通常の週ではない。/,
  /「誰と最後の時を過ごしたいか」を主人公に尋ねて選択を促す。/,
  /発話は一度に3〜5文程度にする。/
];
const OLD_WEAK_GUIDE_PHRASES = [/これまで特に深く関わった相手/, /次の行き先を選ぶ会話ではなく/, /急かさず、会話を続ける/];

test('graduation guide reply prompt uses the dedicated instruction, lists candidates, and omits the destination catalog', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 49 });
  const guideContext = {
    candidates: [
      { character_id: 'character_008', display_name: 'エイト' },
      { character_id: 'character_001', display_name: 'ワン' },
      { character_id: 'character_002', display_name: 'ツー' }
    ]
  };
  let replyPrompt = '';
  await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_guide_contract_001',
    characterId: 'lina',
    playerInput: '次は鍛錬とダンジョンどっちがいいと思う？',
    now: '2026-05-26T06:30:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    routingGraduationGuideContext: guideContext,
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ prompt }) => { replyPrompt = prompt; return '卒業の締めくくりの話をしましょう。'; },
    routingGraduationGuideProvider: async () => 'none',
    routingDestinationProvider: async () => { throw new Error('destination selection must not run during the guide'); },
    conversationContinuationProvider: async () => { throw new Error('the continuation judgment must not run during the guide'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  // (a) dedicated instruction + candidate display names (context block and final instruction both name them).
  for (const marker of GUIDE_REPLY_INSTRUCTION_MARKERS) assert.match(replyPrompt, marker);
  assert.match(replyPrompt, /卒業ガイド【最優先・今週で唯一の目的】/);
  assert.match(replyPrompt, /締めくくりの相手の候補（エイト、ワン、ツー、そして案内人自身のルミ）/);
  assert.match(replyPrompt, /- エイト\n/);
  assert.match(replyPrompt, /- ルミ（案内人自身。/);
  // (b) the default reply instruction is absent.
  assert.doesNotMatch(replyPrompt, DEFAULT_REPLY_INSTRUCTION_MARKER);
  // (c) the destination catalog headings are absent.
  assert.doesNotMatch(replyPrompt, /- 行き先:/);
  assert.doesNotMatch(replyPrompt, /- 行き先の仕組み:/);
  // (d) the old weak guide block phrasing is gone without a trace.
  for (const phrase of OLD_WEAK_GUIDE_PHRASES) assert.doesNotMatch(replyPrompt, phrase);
});

test('normal routing hub reply prompt keeps the default instruction and destination catalog and carries no guide wording', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 4 });
  let replyPrompt = '';
  await runConversationTurnCore({
    root,
    id: 'conv_routing_hub_normal_contract_001',
    characterId: 'lina',
    playerInput: '今週はどこに行こうかな',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    routingHubContext: routingHubContext('fallen_star'),
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ prompt }) => { replyPrompt = prompt; return '行き先を一緒に考えましょう。'; },
    conversationContinuationProvider: async () => 'true',
    routingDestinationProvider: async () => 'none',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  // (e) default instruction + catalog present, no guide-specific wording.
  assert.match(replyPrompt, DEFAULT_REPLY_INSTRUCTION_MARKER);
  assert.match(replyPrompt, /- 行き先:/);
  assert.match(replyPrompt, /- 行き先の仕組み:/);
  assert.doesNotMatch(replyPrompt, /卒業ガイド/);
  for (const marker of GUIDE_REPLY_INSTRUCTION_MARKERS) assert.doesNotMatch(replyPrompt, marker);
});

test('runConversationOpening for the guide graduation phase 2 with lina speaks as the routing persona, not the disk lina profile', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  // Guide graduation phase 2: an ordinary event conversation on the persona actor (lina), carrying the
  // graduation ending event context and NO routing hub context. The persona is resolved from the supplied
  // effective variant.
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: false,
    ending_character_id: 'lina',
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    global_flags: { ...(state.global_flags ?? {}), 'event.graduation_ending.ready': true },
    pending_interaction_context: {
      event_flag_id: 'event.graduation_ending.ready',
      source_type: 'graduation_ending',
      opening_context: '卒業の日。{{persona_name}}と学院生活の最後の時を過ごす。'
    }
  });

  let openingPrompt = '';
  const opened = await runConversationOpening({
    root,
    id: 'conv_graduation_phase2_persona_001',
    characterId: 'lina',
    now: '2026-05-26T06:20:00.000+09:00',
    graduationPersonaVariant: 'fallen_star',
    chatProvider: async ({ prompt, profile }) => {
      openingPrompt = prompt;
      assert.equal(profile.character_id, 'lina');
      assert.equal(profile.display_name, 'ルミ');
      return 'とうとう、この日が来ましたね。';
    }
  });

  // The conversation names the persona (variant proper name), and the greeting prompt uses the routing
  // persona description with the persona-name token interpolated to the variant — not the disk lina profile.
  assert.equal(opened.conversation.character_name, 'ルミ');
  assert.match(openingPrompt, /あなたはルミである。/);
  assert.match(openingPrompt, /名前をどこかに落としてしまった小さな星/);
  assert.match(openingPrompt, /ルミと学院生活の最後の時を過ごす。/);
  assert.doesNotMatch(openingPrompt, /薬草の観察が得意/);

  // A continuing (reply) turn of the same phase 2 also speaks as the routing persona (not the disk lina
  // profile): the gate is the state's graduation ending context + the persona actor, independent of the hub.
  let replyPrompt = '';
  const reply = await runConversationTurnCore({
    root,
    id: 'conv_graduation_phase2_persona_001',
    characterId: 'lina',
    playerInput: 'あなたと過ごせて良かったです',
    now: '2026-05-26T06:21:00.000+09:00',
    postTurnStatePolicy: academyPostTurnStatePolicy,
    graduationPersonaVariant: 'fallen_star',
    emotionProvider: async () => ({ expression: 'joy' }),
    chatProvider: async ({ prompt, profile }) => {
      replyPrompt = prompt;
      assert.equal(profile.character_id, 'lina');
      assert.equal(profile.display_name, 'ルミ');
      return 'こちらこそ、あなたの一週間を見送れて幸せでした。';
    },
    conversationContinuationProvider: async () => true,
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(reply.conversation.messages.at(-1).content, 'こちらこそ、あなたの一週間を見送れて幸せでした。');
  assert.match(replyPrompt, /あなたはルミである。/);
  assert.doesNotMatch(replyPrompt, /薬草の観察が得意/);
});

test('the guide graduation phase 2 with lina fails fast when the effective persona variant is not supplied', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: false,
    ending_character_id: 'lina',
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    global_flags: { ...(state.global_flags ?? {}), 'event.graduation_ending.ready': true },
    pending_interaction_context: { event_flag_id: 'event.graduation_ending.ready', source_type: 'graduation_ending' }
  });

  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_graduation_phase2_persona_missing_001',
      characterId: 'lina',
      now: '2026-05-26T06:25:00.000+09:00',
      chatProvider: async () => 'これは到達しません。'
    }),
    /graduationPersonaVariant is required/
  );
});

test('runConversationOpening re-enters an in-flight graduation phase 2 (guide persona lina) by reusing the active conversation with messages, generating one only when absent', async () => {
  const root = await fixtureRoot();
  const baseState = await readJson(root, 'game_data/runtime_state.json');
  const phase2State = {
    ...baseState,
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: false,
    ending_character_id: 'lina',
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    last_conversation_id: null,
    global_flags: { ...(baseState.global_flags ?? {}), 'event.graduation_ending.ready': true },
    pending_interaction_context: {
      event_flag_id: 'event.graduation_ending.ready',
      source_type: 'event',
      opening_context: '卒業の日。{{persona_name}}と学院生活の最後の時を過ごす。'
    }
  };

  // No opening yet (last_conversation_id null): the restore re-open generates exactly one phase 2 opening.
  await writeSplitJson(root, 'game_data/runtime_state.json', phase2State);
  let generateCalls = 0;
  const generated = await runConversationOpening({
    root,
    id: null,
    characterId: 'lina',
    now: '2026-05-26T06:20:00.000+09:00',
    graduationPersonaVariant: 'fallen_star',
    chatProvider: async () => { generateCalls += 1; return 'とうとう、この日が来ましたね。'; }
  });
  assert.equal(generateCalls, 1, 'a phase 2 with no active conversation generates exactly one opening');
  assert.equal(generated.conversation.character_id, 'lina');
  assert.equal(generated.conversation.character_name, 'ルミ');
  assert.equal(generated.conversation.source_type, 'event');
  assert.equal(generated.conversation.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(generated.state.last_conversation_id, generated.conversation.id);

  // The active conversation now has messages: the restore re-open reuses it without regenerating (the
  // reuse path returns before any chatProvider call), so a resumed phase 2 keeps its existing opening line.
  let reuseCalls = 0;
  const reused = await runConversationOpening({
    root,
    id: null,
    characterId: 'lina',
    now: '2026-05-26T06:25:00.000+09:00',
    graduationPersonaVariant: 'fallen_star',
    chatProvider: async () => { reuseCalls += 1; return 'REGENERATED_SHOULD_NOT_HAPPEN'; }
  });
  assert.equal(reuseCalls, 0, 'a phase 2 with an active conversation reuses it and does not regenerate');
  assert.equal(reused.conversation.id, generated.conversation.id);
  assert.deepEqual(reused.conversation.messages, generated.conversation.messages);
});

test('runConversationOpening re-enters an in-flight graduation phase 2 (roster candidate) by reusing the active conversation with messages, generating one only when absent', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  const baseState = await readJson(root, 'game_data/runtime_state.json');
  const phase2State = {
    ...baseState,
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: false,
    ending_character_id: 'character_001',
    current_screen: 'interaction',
    current_interaction_character_id: 'character_001',
    last_conversation_id: null,
    global_flags: { ...(baseState.global_flags ?? {}), 'event.graduation_ending.ready': true },
    pending_interaction_context: {
      event_flag_id: 'event.graduation_ending.ready',
      source_type: 'event',
      opening_context: '卒業の日。学院生活の最後の時を過ごす。'
    }
  };

  // A roster candidate phase 2 is an ordinary event conversation on the selectable actor (no persona
  // variant): no active conversation → generate exactly one opening.
  await writeSplitJson(root, 'game_data/runtime_state.json', phase2State);
  let generateCalls = 0;
  const generated = await runConversationOpening({
    root,
    id: null,
    characterId: 'character_001',
    now: '2026-05-26T06:20:00.000+09:00',
    chatProvider: async () => { generateCalls += 1; return 'この一年、ありがとうございました。'; }
  });
  assert.equal(generateCalls, 1);
  assert.equal(generated.conversation.character_id, 'character_001');
  assert.equal(generated.conversation.source_type, 'event');
  assert.equal(generated.conversation.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(generated.state.last_conversation_id, generated.conversation.id);

  // Active conversation present → reuse without regenerating.
  let reuseCalls = 0;
  const reused = await runConversationOpening({
    root,
    id: null,
    characterId: 'character_001',
    now: '2026-05-26T06:25:00.000+09:00',
    chatProvider: async () => { reuseCalls += 1; return 'REGENERATED_SHOULD_NOT_HAPPEN'; }
  });
  assert.equal(reuseCalls, 0);
  assert.equal(reused.conversation.id, generated.conversation.id);
  assert.deepEqual(reused.conversation.messages, generated.conversation.messages);
});

test('malformed routingHubContext fails fast instead of using the field profile', async () => {
  const root = await fixtureRoot();

  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_routing_hub_bad_001',
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      routingHubContext: null,
      chatProvider: async () => 'これは到達しません。'
    }),
    /routingHubContext must be an object/
  );

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_routing_hub_bad_002',
      characterId: 'lina',
      playerInput: '進めよう',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: academyPostTurnStatePolicy,
      routingHubContext: routingHubContext('banana'),
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'これは到達しません。'
    }),
    /routing persona variant/
  );
});

test('a malformed dungeon scene context fails fast instead of degrading to the field scene', async () => {
  const root = await fixtureRoot();

  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_dungeon_dr_9001',
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      dungeonSceneContext: { visible_situation: '場所名が無い。' },
      chatProvider: async () => 'これは到達しません。'
    }),
    /dungeonSceneContext.location_name is required/
  );

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_dungeon_dr_9001',
      characterId: 'lina',
      playerInput: '進もう',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: { location_name: '実践ダンジョン 第1層', visible_situation: 123 },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'これは到達しません。'
    }),
    /dungeonSceneContext.visible_situation must be a string/
  );

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_dungeon_dr_9001',
      characterId: 'lina',
      playerInput: '進もう',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: {
        location_name: '実践ダンジョン 第1層',
        visible_situation: '実践ダンジョンの第1層を主人公と一緒に探索している。',
        prompt_tail_context: ''
      },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'これは到達しません。'
    }),
    /dungeonSceneContext.prompt_tail_context must not be empty/
  );

  // A provided-but-falsy value (null) is NOT "unspecified": it must fail fast,
  // not silently degrade to the academy field scene.
  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_dungeon_dr_9002',
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      dungeonSceneContext: null,
      chatProvider: async () => 'これは到達しません。'
    }),
    /dungeonSceneContext must be an object/
  );
});

test('the companion turn stream fails fast (SSE error) when the scene resolver yields an invalid scene', async () => {
  const root = await fixtureRoot();
  const events = [];
  const res = { ended: false, end() { this.ended = true; } };
  const sendSseEvent = (_res, event, data) => events.push({ event, data });
  const base = {
    res,
    root,
    context: {},
    body: { player_input: 'いくよ' },
    resolveConversationId: () => 'conv_dungeon_dr_7',
    resolveCharacterId: () => 'lina',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    resolveRuntimeProviders: async () => ({
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'ここには到達しません。',
      conversationContinuationProvider: async () => 'true',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    runConversationTurn: runConversationTurnCore,
    sendSseEvent
  };

  // resolver yields null → must surface as an SSE error (no silent academy-scene success).
  events.length = 0;
  await streamConversationTurnSse({ ...base, resolveDungeonSceneContext: async () => null });
  assert.equal(events.some((event) => event.event === 'result'), false, 'no result event when the scene is invalid');
  const nullError = events.find((event) => event.event === 'error');
  assert.ok(nullError, 'an SSE error is emitted when the resolver yields null');
  assert.match(nullError.data.error, /dungeonSceneContext must be an object/);
  assert.equal(res.ended, true);

  // resolver yields undefined → fail fast at the stream layer (not an opt-out).
  events.length = 0;
  await streamConversationTurnSse({ ...base, resolveDungeonSceneContext: async () => undefined });
  assert.equal(events.some((event) => event.event === 'result'), false, 'no result event when the resolver yields undefined');
  const undefinedError = events.find((event) => event.event === 'error');
  assert.ok(undefinedError, 'an SSE error is emitted when the resolver yields undefined');
  assert.match(undefinedError.data.error, /must resolve to a dungeon scene, not undefined/);
});

test('runConversationOpening creates an LLM-generated first assistant utterance before player input and reset clears generated continuity records', async () => {
  const root = await fixtureRoot();
  let openingPrompt = '';
  const opened = await runConversationOpening({
    root,
    id: 'conv_opening_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async ({ prompt, playerInput }) => {
      openingPrompt = prompt;
      assert.equal(playerInput, null);
      return 'ここ、少し空気が乾いています。古い掲示板の跡を見てから話しましょう。';
    }
  });

  assert.equal(opened.conversation.id, 'conv_opening_001');
  assert.equal(opened.conversation.messages.length, 1);
  assert.deepEqual(opened.conversation.messages[0], {
    role: 'assistant',
    content: 'ここ、少し空気が乾いています。古い掲示板の跡を見てから話しましょう。'
  });
  assert.match(openingPrompt, /プレイヤーはまだ発言していない/);
  assert.match(openingPrompt, /発話は一度に1〜3文程度/);

  await finalizeConversation({ root, conversationId: 'conv_opening_001', characterId: 'lina', now: '2026-05-05T06:01:00.000+09:00', skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' }) });
  assert.equal((await readJson(root, 'game_data/characters/lina/skills.json')).skills.some((skill) => skill.type === 'self_change'), true);
  assert.equal(await exists(root, 'game_data/characters/lina/memory/mem_conv_opening_001.json'), true);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_opening_001.md'), true);
  const openingWorkRecordMarkdown = await fs.readFile(path.join(root, 'game_data/characters/lina/work_records/wr_conv_opening_001.md'), 'utf8');
  assert.match(openingWorkRecordMarkdown, /## 第1週のサマリー/);
  assert.doesNotMatch(openingWorkRecordMarkdown, /## Summary/);

  const reset = await resetContinuityRecords({ root, characterId: 'lina', target: 'all' });
  assert.deepEqual(reset.reset_targets, ['memory', 'skills', 'work_records']);
  assert.equal((await readJson(root, 'game_data/characters/lina/skills.json')).skills.some((skill) => skill.type === 'self_change'), false);
  assert.equal(await exists(root, 'game_data/characters/lina/memory/mem_conv_opening_001.json'), false);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_opening_001.md'), false);
});

test('runConversationOpening keeps omitted dialogue actor default as lina', async () => {
  const root = await fixtureRoot();
  const opened = await runConversationOpening({
    root,
    id: 'conv_default_lina_001',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async ({ profile }) => {
      assert.equal(profile.character_id, 'lina');
      return 'ここから話しましょう。';
    }
  });

  assert.equal(opened.conversation.character_id, 'lina');
  assert.equal(opened.state.current_interaction_character_id, 'lina');
});

test('runConversationOpening snapshots actor context and later turns reuse the record copy', async () => {
  const root = await splitFixtureRoot();
  const profile = await readJson(root, 'content/characters/lina/profile.json');
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/affinity.json', {
    character_id: 'lina',
    affinity: 73,
    applied_affinity_conversation_ids: []
  });
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 80, dark: 10, fire: 50, water: 40, earth: 20, wind: 30 },
      abilities: {}
    }
  });

  let openingPrompt;
  const opened = await runConversationOpening({
    root,
    id: 'conv_actor_context_opening_001',
    characterId: 'lina',
    chatProvider: async ({ prompt }) => {
      openingPrompt = prompt;
      return '光の扱いは、まず安定から見ます。';
    },
    now: '2026-05-05T06:01:00.000+09:00'
  });

  assert.equal(opened.conversation.conversation_actor_context.sections[0].title, '系統知識');
  assert.match(openingPrompt, /会話相手コンテキスト:\n系統知識:/);
  assert.match(openingPrompt, /光魔法の基礎。光は生成・集束・定着の三段で扱い/);
  assert.match(openingPrompt, /光魔法の応用。高位治癒では対象の魔力路そのものを整え/);
  assert.match(openingPrompt, /火魔法の基礎。火は起こす・保つ・止めるの三段で扱い/);
  assert.doesNotMatch(openingPrompt, /水魔法の基礎。水は無から生めない/);
  assertAffinityActorContextSection(openingPrompt, 73);
  const openingActorContextBlock = actorContextPromptBlock(openingPrompt);

  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/affinity.json', {
    character_id: 'lina',
    affinity: 90,
    applied_affinity_conversation_ids: ['conv_before_snapshot_mutation']
  });
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 0, dark: 0, fire: 0, water: 0, earth: 0, wind: 0 },
      abilities: {}
    }
  });

  let turnPrompt;
  const turn = await runConversationTurn({
    root,
    id: 'conv_actor_context_opening_001',
    characterId: 'lina',
    playerInput: 'さっきの光の話、続けて。',
    chatProvider: async ({ prompt }) => {
      turnPrompt = prompt;
      return '続けます。光は無理に強めないことが大切です。';
    },
    stageMoveAgreementProvider: async () => 'false',
    now: '2026-05-05T06:02:00.000+09:00'
  });

  assert.deepEqual(turn.conversation.conversation_actor_context, opened.conversation.conversation_actor_context);
  assert.equal(actorContextPromptBlock(turnPrompt), openingActorContextBlock);
  assert.match(turnPrompt, /光魔法の基礎。光は生成・集束・定着の三段で扱い/);
  assert.match(turnPrompt, /火魔法の基礎。火は起こす・保つ・止めるの三段で扱い/);
  assert.doesNotMatch(turnPrompt, /水魔法の基礎。水は無から生めない/);
  assertAffinityActorContextSection(turnPrompt, 73);
  assert.doesNotMatch(turnPrompt, /主人公への好感度: 90\/100/);
});

test('runConversationTurn snapshots actor context when it creates the conversation record', async () => {
  const root = await splitFixtureRoot();
  const profile = await readJson(root, 'content/characters/lina/profile.json');
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 10, dark: 80, fire: 0, water: 0, earth: 50, wind: 49 },
      abilities: {}
    }
  });

  let firstPrompt;
  const first = await runConversationTurn({
    root,
    id: 'conv_actor_context_turn_001',
    characterId: 'lina',
    playerInput: '闇と土について相談したい。',
    chatProvider: async ({ prompt }) => {
      firstPrompt = prompt;
      return '順番に見ていきましょう。';
    },
    stageMoveAgreementProvider: async () => 'false',
    now: '2026-05-05T06:03:00.000+09:00'
  });

  assert.equal(first.conversation.conversation_actor_context.sections[0].entries.length, 3);
  assert.match(firstPrompt, /闇魔法の基礎。闇は光の欠如ではなく/);
  assert.match(firstPrompt, /闇魔法の応用。封印術式は錨・鎖・封の三層で編まれ/);
  assert.match(firstPrompt, /土魔法の基礎。土は六系統でもっとも遅く/);
  assert.doesNotMatch(firstPrompt, /風魔法の基礎。風は掴めない/);
  assertAffinityActorContextSection(firstPrompt, 25);
});

test('actor context knowledge gate ignores player parameters while affinity uses the missing-file initial value', async () => {
  const root = await splitFixtureRoot();
  const profile = await readJson(root, 'content/characters/lina/profile.json');
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 0, dark: 0, fire: 0, water: 0, earth: 0, wind: 0 },
      abilities: {}
    }
  });
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'split pipeline fixture',
    world_condition_texts: [],
    player_parameters: {
      magic: { light: 100, dark: 100, fire: 100, water: 100, earth: 100, wind: 100 },
      abilities: {}
    }
  });

  let prompt;
  const opened = await runConversationOpening({
    root,
    id: 'conv_actor_context_low_actor_001',
    characterId: 'lina',
    chatProvider: async ({ prompt: openingPrompt }) => {
      prompt = openingPrompt;
      return '今日は基礎から確認しましょう。';
    },
    now: '2026-05-05T06:04:00.000+09:00'
  });

  assert.equal(Object.hasOwn(opened.conversation, 'conversation_actor_context'), true);
  assert.deepEqual(opened.conversation.conversation_actor_context.sections.map((section) => section.title), ['好感度']);
  assertAffinityActorContextSection(prompt, 25);
  assert.doesNotMatch(prompt, /光魔法の基礎。光は生成・集束・定着の三段で扱い/);
});

test('runConversationOpening fails fast when persisted affinity state is malformed', async () => {
  const root = await splitFixtureRoot();
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/affinity.json', {
    character_id: 'lina',
    affinity: 101,
    applied_affinity_conversation_ids: []
  });

  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_actor_context_bad_affinity_001',
      characterId: 'lina',
      chatProvider: async () => 'ここには到達しません。',
      now: '2026-05-05T06:04:30.000+09:00'
    }),
    /invalid affinity state for lina/
  );
});

test('runConversationTurn fails fast when an active conversation is missing actor-context snapshot state', async () => {
  const root = await splitFixtureRoot();
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  await writeSplitJson(root, 'data/mutable/game_data/logs/conversations/conv_missing_actor_context_001.json', {
    id: 'conv_missing_actor_context_001',
    character_id: 'lina',
    character_name: 'リナ',
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:00:00.000+09:00',
    academy_week_number: 1,
    academy_elapsed_weeks_at_start: 0,
    source_type: 'field',
    location_id: state.current_location_id,
    time_slot: state.time_slot,
    prompt: 'legacy prompt without actor context snapshot',
    messages: [{ role: 'assistant', content: '古い会話です。' }]
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    ...state,
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    last_conversation_id: 'conv_missing_actor_context_001'
  });

  await assert.rejects(
    runConversationTurn({
      root,
      id: 'conv_missing_actor_context_001',
      characterId: 'lina',
      playerInput: '続けよう。',
      chatProvider: async () => 'ここには到達しません。',
      now: '2026-05-05T06:05:00.000+09:00'
    }),
    /active conversation is missing conversation_actor_context/
  );
});

test('split-root conversation pipeline reads and writes continuity surfaces without creating legacy game_data roots', async (t) => {
  const root = await splitFixtureRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const opened = await runConversationOpening({
    root,
    id: 'conv_split_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => '薬草園の棚札、順番が少し変わっています。'
  });
  assert.equal(opened.conversation.messages[0].content, '薬草園の棚札、順番が少し変わっています。');

  await finalizeConversation({
    root,
    conversationId: 'conv_split_001',
    characterId: 'lina',
    now: '2026-05-05T06:01:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' })
  });

  const splitSkills = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/characters/lina/skills.json'), 'utf8'));
  assert.equal(splitSkills.skills.some((skill) => skill.type === 'self_change'), true);
  assert.equal(await exists(root, 'data/mutable/game_data/characters/lina/memory/mem_conv_split_001.json'), true);
  assert.equal(await exists(root, 'data/mutable/game_data/characters/lina/work_records/wr_conv_split_001.md'), true);
  assert.equal(await exists(root, 'data/mutable/game_data/logs/conversations/conv_split_001.json'), true);

  const reset = await resetContinuityRecords({ root, characterId: 'lina', target: 'all' });
  assert.deepEqual(reset.reset_targets, ['memory', 'skills', 'work_records']);
  const resetSkills = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/characters/lina/skills.json'), 'utf8'));
  assert.equal(resetSkills.skills.some((skill) => skill.type === 'self_change'), false);
  assert.equal(await exists(root, 'data/mutable/game_data/characters/lina/memory/mem_conv_split_001.json'), false);
  assert.equal(await exists(root, 'data/mutable/game_data/characters/lina/work_records/wr_conv_split_001.md'), false);

  await assert.rejects(fs.access(path.join(root, 'game_data/logs/conversations/conv_split_001.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/memory/mem_conv_split_001.json')), { code: 'ENOENT' });
});

test('creature dialogue uses creature profile and mutable continuity while skipping academy relationships', async (t) => {
  const root = await creatureDialogueRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const started = await startInteractionSession({ root, characterId: 'creature_001' });
  assert.equal(started.state.current_interaction_character_id, 'creature_001');

  let openingPrompt = '';
  const opened = await runConversationOpening({
    root,
    id: 'conv_creature_001',
    characterId: 'creature_001',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async ({ prompt, profile }) => {
      openingPrompt = prompt;
      assert.equal(profile.display_name, '苔火');
      return '……灯は、まだここにある。';
    }
  });
  assert.equal(opened.conversation.character_id, 'creature_001');
  assert.match(openingPrompt, /山林/);
  assert.match(openingPrompt, /苔火/);
  assert.doesNotMatch(openingPrompt, /所属未設定/);
  assert.doesNotMatch(openingPrompt, /生徒/);
  assert.doesNotMatch(openingPrompt, /主人公への好感度:/);

  const turn = await runConversationTurn({
    root,
    id: 'conv_creature_001',
    characterId: 'creature_001',
    playerInput: 'この祠の灯りは君なの？',
    now: '2026-05-05T06:01:00.000+09:00',
    emotionProvider: async () => ({ expression: 'caring' }),
    chatProvider: async ({ profile }) => {
      assert.equal(profile.character_id, 'creature_001');
      return '……そうだ。苔の下で、長く灯っている。';
    }
  });
  assert.equal(turn.conversation.messages.at(-1).expression, 'caring');

  let buddyProviderCalled = false;
  let enemyProviderCalled = false;
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_creature_001',
    characterId: 'creature_001',
    now: '2026-05-05T06:02:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({
      memory_record: {
        character_id: 'creature_001',
        id: 'mem_creature_001_seen',
        type: 'relationship_change',
        text: '主人公は苔火が祠の灯りだと知った。',
        visibility: 'private',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: ['苔火']
      }
    }),
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' }),
    skillUpdateProvider: async ({ conversation, workRecordId }) => ({
      skill_record: {
        character_id: 'creature_001',
        id: 'skill_creature_001_soft_light',
        type: 'self_change',
        name: '会話からの自己変化',
        description: '苔火は主人公へ灯りを少し強く向けるようになった。',
        visibility: 'private',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: ['苔火']
      }
    }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: 'creature_001',
        source_conversation_id: conversation.id,
        title: '古祠で苔火と話した',
        summary: '主人公は古祠の灯りについて苔火に尋ねた。苔火は自分が長く祠に灯っている精霊だと静かに答えた。',
        flag_update_candidates: [
          { character_id: 'creature_001', flag: 'knowledge.creature_001.lantern_seen', op: 'set', value: true }
        ]
      }
    }),
    stageFlagJudgmentProvider: async () => ({ judgments: [] }),
    eventFlagJudgmentProvider: async () => ({ judgments: [] }),
    eventParticipantOverrideJudgmentProvider: async () => ({ judgments: [] }),
    eventCompletionJudgmentProvider: async () => ({ completions: [] }),
    moneyDeltaProvider: async () => ({ delta: 0 }),
    buddyAgreementProvider: async () => {
      buddyProviderCalled = true;
      return 'true';
    },
    enemyHostilityProvider: async () => {
      enemyProviderCalled = true;
      return 'true';
    }
  });

  assert.equal(buddyProviderCalled, false);
  assert.equal(enemyProviderCalled, false);
  assert.equal(finalized.buddy_update.skipped, true);
  assert.equal(finalized.buddy_update.reason, 'creature_actor');
  assert.equal(finalized.enemy_update.skipped, true);
  assert.equal(finalized.enemy_update.reason, 'creature_actor');
  // A creature never becomes a dungeon companion, so its MP reserve line is skipped too.
  assert.equal(finalized.mp_reserve_update.skipped, true);
  assert.equal(finalized.mp_reserve_update.reason, 'creature_actor');
  assert.deepEqual(finalized.state.current_enemy_character_ids, []);
  assert.equal(finalized.state.current_buddy_character_id, null);
  assert.equal(finalized.state.creatures.creature_001.flags['knowledge.creature_001.lantern_seen'], true);

  assert.equal(await exists(root, 'data/mutable/game_data/creatures/creature_001/memory/mem_creature_001_seen.json'), true);
  assert.equal(await exists(root, 'data/mutable/game_data/creatures/creature_001/work_records/wr_conv_creature_001.md'), true);
  const creatureSkills = await readJson(root, 'data/mutable/game_data/creatures/creature_001/skills.json');
  assert.equal(creatureSkills.skills.some((skill) => skill.id === 'skill_creature_001_soft_light'), true);
  const creatureFlagsFile = await readJson(root, 'data/mutable/game_data/creatures/creature_001/flags.json');
  const creatureFlags = creatureFlagsFile.flags ?? creatureFlagsFile;
  assert.equal(creatureFlags['knowledge.creature_001.lantern_seen'], true);
  assert.equal(await exists(root, 'data/mutable/game_data/characters/creature_001/memory/mem_creature_001_seen.json'), false);
  assert.equal(await exists(root, 'data/mutable/game_data/characters/creature_001/work_records/wr_conv_creature_001.md'), false);

  // Byte-equivalent on-disk artifacts: a creature (relationship skipped) still writes its skipped
  // buddy_updates / enemy_updates log records, exactly as before the buddy/enemy policy split.
  const creatureBuddyLog = await readJson(root, 'data/mutable/game_data/logs/buddy_updates/conv_creature_001.json');
  assert.equal(creatureBuddyLog.skipped, true);
  assert.equal(creatureBuddyLog.reason, 'creature_actor');
  const creatureEnemyLog = await readJson(root, 'data/mutable/game_data/logs/enemy_updates/conv_creature_001.json');
  assert.equal(creatureEnemyLog.skipped, true);
  assert.equal(creatureEnemyLog.reason, 'creature_actor');
});

test('finalizeConversation skips buddy/enemy judgment for the routing persona (lina) without writing relationship state, while affinity still runs', async () => {
  const root = await fixtureRoot();
  await runConversationTurn({
    root,
    id: 'conv_lina_routing_finalize_001',
    characterId: 'lina',
    playerInput: '今日から正式にバディになろう。',
    now: '2026-07-05T00:00:00.000Z',
    chatProvider: async () => 'うん。私があなたのバディになる。'
  });

  let buddyProviderCalled = false;
  let enemyProviderCalled = false;
  let affinityProviderCalled = false;
  let mpReserveProviderCalled = false;
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_lina_routing_finalize_001',
    characterId: 'lina',
    now: '2026-07-05T00:01:00.000Z',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => {
      buddyProviderCalled = true;
      return 'true';
    },
    enemyHostilityProvider: async () => {
      enemyProviderCalled = true;
      return 'true';
    },
    affinityDeltaProvider: async () => {
      affinityProviderCalled = true;
      return '3';
    },
    mpReserveProvider: async () => {
      mpReserveProviderCalled = true;
      return '50';
    }
  });

  assert.equal(buddyProviderCalled, false);
  assert.equal(enemyProviderCalled, false);
  assert.equal(finalized.buddy_update.skipped, true);
  assert.equal(finalized.buddy_update.reason, 'routing_persona');
  assert.equal(finalized.buddy_update.established, undefined);
  assert.equal(finalized.enemy_update.skipped, true);
  assert.equal(finalized.enemy_update.reason, 'routing_persona');
  assert.equal(finalized.enemy_update.established, undefined);

  // No buddy/enemy relationship state is written for the routing persona.
  assert.equal(finalized.state.current_buddy_character_id, null);
  assert.deepEqual(finalized.state.current_enemy_character_ids, []);
  const linaFlags = await readJson(root, 'game_data/characters/lina/flags.json');
  const linaFlagValues = linaFlags.flags ?? linaFlags;
  assert.equal(linaFlagValues['relationship.lina.buddy'], undefined);
  assert.equal(linaFlagValues['relationship.lina.enemy'], undefined);

  // Byte-equivalent on-disk artifacts: the routing persona (relationship skipped) still writes its skipped
  // buddy_updates / enemy_updates log records, exactly as before the buddy/enemy policy split.
  const linaBuddyLog = await readJson(root, 'game_data/logs/buddy_updates/conv_lina_routing_finalize_001.json');
  assert.equal(linaBuddyLog.skipped, true);
  assert.equal(linaBuddyLog.reason, 'routing_persona');
  const linaEnemyLog = await readJson(root, 'game_data/logs/enemy_updates/conv_lina_routing_finalize_001.json');
  assert.equal(linaEnemyLog.skipped, true);
  assert.equal(linaEnemyLog.reason, 'routing_persona');

  // Affinity (and other finalization side effects) still run for the routing persona.
  assert.equal(affinityProviderCalled, true);
  assert.equal(finalized.affinity_update.skipped, undefined);
  assert.equal(finalized.affinity_update.conversation_delta, 3);
  assert.equal(finalized.affinity_update.buddy_delta, 0);
  assert.equal(finalized.affinity_update.enemy_delta, 0);

  // The MP reserve line is skipped for lina (a non-selectable character can never be a dungeon companion).
  assert.equal(mpReserveProviderCalled, false);
  assert.equal(finalized.mp_reserve_update.skipped, true);
  assert.equal(finalized.mp_reserve_update.reason, 'non_selectable_character');
  assert.equal(finalized.mp_reserve_update.after_percent, undefined);
});

test('conversationFinalizationStageFields carries the hub scene for routing_hub records and passes field location/time_slot through otherwise', async () => {
  // Routing hub record: the field-only location_id / time_slot are dropped (「該当しない」) and replaced by
  // the canonical hub scene, so the stage descriptor names the hub, not a residual field location.
  assert.deepEqual(
    conversationFinalizationStageFields({ source_type: ROUTING_HUB_SOURCE_TYPE, location_id: 'herbology_garden', time_slot: 'after_school' }),
    { source_type: ROUTING_HUB_SOURCE_TYPE, location_name: ROUTING_HUB_LOCATION_NAME, visible_situation: ROUTING_HUB_VISIBLE_SITUATION }
  );
  assert.deepEqual(
    Object.keys(conversationFinalizationStageFields({ source_type: ROUTING_HUB_SOURCE_TYPE })),
    ['source_type', 'location_name', 'visible_situation']
  );
  // Every other field-anchored source_type keeps its field descriptor byte-for-byte (same keys, order, values).
  for (const sourceType of ['field', 'event', 'new_game', 'graduation_ending']) {
    assert.deepEqual(
      conversationFinalizationStageFields({ source_type: sourceType, location_id: 'herbology_garden', time_slot: 'after_school' }),
      { source_type: sourceType, location_id: 'herbology_garden', time_slot: 'after_school' }
    );
  }
});

test('conversationFinalizationStageFields carries the dungeon floor scene from the record and drops field residual', () => {
  // Dungeon record: the dynamic floor 舞台 is carried on the record itself (unlike the hub constant), so the
  // stage descriptor reads it straight back and drops the residual field location_id / time_slot.
  assert.deepEqual(
    conversationFinalizationStageFields({
      source_type: DUNGEON_SOURCE_TYPE,
      location_name: '実践ダンジョン 第3層',
      visible_situation: '実践ダンジョンの第3層を主人公と一緒に探索している。',
      location_id: 'sanrin_mossy_shrine',
      time_slot: 'after_school'
    }),
    {
      source_type: DUNGEON_SOURCE_TYPE,
      location_name: '実践ダンジョン 第3層',
      visible_situation: '実践ダンジョンの第3層を主人公と一緒に探索している。'
    }
  );
  assert.deepEqual(
    Object.keys(conversationFinalizationStageFields({
      source_type: DUNGEON_SOURCE_TYPE,
      location_name: '実践ダンジョン 第1層',
      visible_situation: ''
    })),
    ['source_type', 'location_name', 'visible_situation']
  );
  // A dungeon record missing its stamped scene is a defect, not something to silently degrade to a field record.
  assert.throws(
    () => conversationFinalizationStageFields({ source_type: DUNGEON_SOURCE_TYPE, location_id: 'sanrin_mossy_shrine', time_slot: 'after_school' }),
    /dungeon conversation record must carry a non-empty location_name/
  );
});

test('conversationFinalizationStageFields carries the errand / study circle scene from the record and drops field residual', () => {
  // Errand and study circle records are injected-scene sessions like the dungeon: the per-session 舞台 is carried
  // on the record itself, so the stage descriptor reads it straight back and drops the residual field location.
  for (const { sourceType, locationName, visibleSituation } of [
    { sourceType: ERRAND_SOURCE_TYPE, locationName: '依頼の現場', visibleSituation: '机に、二人分の教本と走り書きのノートが開いて置かれている。' },
    { sourceType: STUDY_CIRCLE_SOURCE_TYPE, locationName: '第三観測室', visibleSituation: '観測机に、星図と観測記録が種類ごとに並べて置かれている。' }
  ]) {
    assert.deepEqual(
      conversationFinalizationStageFields({
        source_type: sourceType,
        location_name: locationName,
        visible_situation: visibleSituation,
        location_id: 'herbology_garden',
        time_slot: 'after_school'
      }),
      { source_type: sourceType, location_name: locationName, visible_situation: visibleSituation }
    );
    assert.deepEqual(
      Object.keys(conversationFinalizationStageFields({
        source_type: sourceType,
        location_name: locationName,
        visible_situation: ''
      })),
      ['source_type', 'location_name', 'visible_situation']
    );
    // A record of an injected-scene source_type missing its stamped scene is a defect, not a silent field degrade.
    assert.throws(
      () => conversationFinalizationStageFields({ source_type: sourceType, location_id: 'herbology_garden', time_slot: 'after_school' }),
      new RegExp(`${sourceType} conversation record must carry a non-empty location_name`)
    );
  }
});

test('routing hub conversation records declare routing_hub source_type without field location/time_slot residual', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 0,
    current_location_id: 'herbology_garden',
    current_location_visible_situation: '放課後の薬草園にいる。',
    time_slot: 'after_school'
  });

  const opened = await runConversationOpening({
    root,
    id: 'conv_hub_meta_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    routingHubContext: routingHubContext('fallen_star'),
    chatProvider: async () => '新しい週を、ここから一緒に選びましょう。'
  });
  assert.equal(opened.conversation.source_type, ROUTING_HUB_SOURCE_TYPE);
  assert.equal(Object.hasOwn(opened.conversation, 'location_id'), false);
  assert.equal(Object.hasOwn(opened.conversation, 'time_slot'), false);
  const persistedOpen = await readJson(root, 'game_data/logs/conversations/conv_hub_meta_001.json');
  assert.equal(persistedOpen.source_type, ROUTING_HUB_SOURCE_TYPE);
  assert.equal(Object.hasOwn(persistedOpen, 'location_id'), false);
  assert.equal(Object.hasOwn(persistedOpen, 'time_slot'), false);

  // A continuing hub turn keeps the same contract (no field residual creeps back on later turns).
  const turned = await runConversationTurn({
    root,
    id: 'conv_hub_meta_001',
    characterId: 'lina',
    playerInput: 'まだ少し迷っています。',
    now: '2026-05-05T06:02:00.000+09:00',
    routingHubContext: routingHubContext('fallen_star'),
    chatProvider: async () => 'ゆっくり選んで大丈夫ですよ。',
    conversationContinuationProvider: async () => false,
    conversationCutoffProvider: async () => 'また落ち着いたら続けましょう。'
  });
  assert.equal(turned.conversation.source_type, ROUTING_HUB_SOURCE_TYPE);
  assert.equal(Object.hasOwn(turned.conversation, 'location_id'), false);
  assert.equal(Object.hasOwn(turned.conversation, 'time_slot'), false);
});

test('finalizing a routing hub conversation feeds hub stage info (not field residual) to post-processing prompts', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 0,
    current_location_id: 'herbology_garden',
    current_location_visible_situation: '放課後の薬草園にいる。',
    time_slot: 'after_school'
  });

  await runConversationOpening({
    root,
    id: 'conv_hub_finalize_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    routingHubContext: routingHubContext('fallen_star'),
    chatProvider: async () => '新しい週を、ここから一緒に選びましょう。'
  });

  let moneyPrompt = '';
  let affinityPrompt = '';
  const finalized = await finalizeConversationCore({
    root,
    conversationId: 'conv_hub_finalize_001',
    characterId: 'lina',
    now: '2026-05-05T06:05:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    moneyDeltaProvider: async ({ prompt }) => { moneyPrompt = prompt; return '0'; },
    affinityDeltaProvider: async ({ prompt }) => { affinityPrompt = prompt; return '0'; }
  });

  for (const prompt of [moneyPrompt, affinityPrompt]) {
    assert.match(prompt, /"source_type": "routing_hub"/);
    assert.match(prompt, new RegExp(`"location_name": "${ROUTING_HUB_LOCATION_NAME}"`));
    assert.match(prompt, new RegExp(`"visible_situation": "${ROUTING_HUB_VISIBLE_SITUATION}"`));
    assert.doesNotMatch(prompt, /herbology_garden/);
    assert.doesNotMatch(prompt, /after_school/);
    assert.doesNotMatch(prompt, /"location_id"/);
    assert.doesNotMatch(prompt, /"time_slot"/);
  }
  // Absent field fields do not break finalization: the hub work record and memory are still produced.
  assert.ok(finalized.validator.accepted_work_record);
  const memoryUpdate = await readJson(root, 'game_data/logs/memory_updates/conv_hub_finalize_001.json');
  assert.ok(memoryUpdate.memory_record);
});

test('finalizing a routing hub conversation skips the event-flag judgment trio (no LM call, no logs, no state writes) while money and affinity still run', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 0,
    current_location_id: 'herbology_garden',
    current_location_visible_situation: '放課後の薬草園にいる。',
    time_slot: 'after_school'
  });

  await runConversationOpening({
    root,
    id: 'conv_hub_event_skip_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    routingHubContext: routingHubContext('fallen_star'),
    chatProvider: async () => '約束していた食事、一緒に行きましょう。雪の話もしましたね。'
  });

  let eventFlagProviderCalled = false;
  let eventParticipantOverrideProviderCalled = false;
  let eventCompletionProviderCalled = false;
  let moneyProviderCalled = false;
  let affinityProviderCalled = false;
  const finalized = await finalizeConversationCore({
    root,
    conversationId: 'conv_hub_event_skip_001',
    characterId: 'lina',
    now: '2026-05-05T06:05:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    eventFlagJudgmentProvider: async () => { eventFlagProviderCalled = true; return { flag_results: [{ flag_id: 'event.snow_topic_followup.ready', achieved: true }] }; },
    eventParticipantOverrideJudgmentProvider: async () => { eventParticipantOverrideProviderCalled = true; return { flag_results: [] }; },
    eventCompletionJudgmentProvider: async () => { eventCompletionProviderCalled = true; return { flag_results: [] }; },
    moneyDeltaProvider: async () => { moneyProviderCalled = true; return '0'; },
    affinityDeltaProvider: async () => { affinityProviderCalled = true; return '3'; }
  });

  // No LM call for any of the three event judgments.
  assert.equal(eventFlagProviderCalled, false);
  assert.equal(eventParticipantOverrideProviderCalled, false);
  assert.equal(eventCompletionProviderCalled, false);

  // Explicit skip records with the hub reason, not a judged empty result.
  for (const judgment of [finalized.event_flags, finalized.event_participant_overrides, finalized.event_completions]) {
    assert.equal(judgment.skipped, true);
    assert.equal(judgment.reason, 'routing_hub_conversation');
    assert.deepEqual(judgment.accepted, []);
  }

  // No event_*_judgments log is written.
  assert.equal(await exists(root, 'game_data/logs/event_flag_judgments/conv_hub_event_skip_001.json'), false);
  assert.equal(await exists(root, 'game_data/logs/event_participant_override_judgments/conv_hub_event_skip_001.json'), false);
  assert.equal(await exists(root, 'game_data/logs/event_completion_judgments/conv_hub_event_skip_001.json'), false);

  // No event flag / source / completion is written to runtime state, even though the conversation content
  // would satisfy a candidate event.
  const nextState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(nextState.global_flags['event.snow_topic_followup.ready'], undefined);
  assert.deepEqual(nextState.event_flag_sources ?? {}, {});
  assert.deepEqual(nextState.event_completion_sources ?? {}, {});

  // The rest of finalization still runs at the hub: money and affinity are judged, memory/work record produced.
  assert.equal(moneyProviderCalled, true);
  assert.equal(finalized.money_update.skipped, undefined);
  assert.equal(affinityProviderCalled, true);
  assert.equal(finalized.affinity_update.conversation_delta, 3);
  assert.ok(finalized.validator.accepted_work_record);
});

test('finalizing a non-hub (field) conversation still runs the event-flag judgment trio', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    current_location_id: 'snowy_inner_garden',
    current_location_visible_situation: '雪の降る中庭にいる。',
    time_slot: 'after_school'
  });

  await runConversationTurn({
    root,
    id: 'conv_field_event_run_001',
    characterId: 'lina',
    playerInput: '雪について話しましょう。',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => '雪の匂いまで分かる気がします。'
  });

  let eventFlagProviderCalled = false;
  const finalized = await finalizeConversationCore({
    root,
    conversationId: 'conv_field_event_run_001',
    characterId: 'lina',
    now: '2026-05-05T06:05:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    eventFlagJudgmentProvider: async ({ candidateFlags }) => {
      eventFlagProviderCalled = true;
      return { flag_results: candidateFlags.map((flag) => ({ flag_id: flag.id, achieved: false })) };
    },
    affinityDeltaProvider: async () => '0'
  });

  assert.equal(eventFlagProviderCalled, true);
  assert.equal(finalized.event_flags.skipped, undefined);
  assert.ok(await exists(root, 'game_data/logs/event_flag_judgments/conv_field_event_run_001.json'));
});

test('finalizing a field conversation still feeds field location_id/time_slot to post-processing prompts (unchanged)', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    current_location_id: 'herbology_garden',
    current_location_visible_situation: '放課後の薬草園にいる。',
    time_slot: 'after_school'
  });

  await runConversationTurn({
    root,
    id: 'conv_field_stage_001',
    characterId: 'lina',
    playerInput: '棚札を一緒に確認しましょう。',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => '記録と現場を落ち着いて見比べましょう。'
  });

  let moneyPrompt = '';
  await finalizeConversationCore({
    root,
    conversationId: 'conv_field_stage_001',
    characterId: 'lina',
    now: '2026-05-05T06:05:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    moneyDeltaProvider: async ({ prompt }) => { moneyPrompt = prompt; return '0'; },
    affinityDeltaProvider: async () => '0'
  });
  assert.match(moneyPrompt, /"source_type": "field"/);
  assert.match(moneyPrompt, /"location_id": "herbology_garden"/);
  assert.match(moneyPrompt, /"time_slot": "after_school"/);
  assert.doesNotMatch(moneyPrompt, /location_name/);
});

test('dungeon companion conversation records declare dungeon source_type with the floor scene and no field residual', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  // Reproduce the bug precondition: the player just held a 山林/field conversation, so the runtime carries a
  // residual field location_id + time_slot that a following dungeon conversation must NOT inherit.
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    current_location_id: 'sanrin_mossy_shrine',
    current_location_visible_situation: '苔むした古祠にいる。',
    time_slot: 'after_school'
  });

  const encounterScene = {
    source_type: DUNGEON_SOURCE_TYPE,
    location_name: '実践ダンジョン 第1層',
    visible_situation: '実践ダンジョンの第1層。探索の途中で主人公と出会い、ここから一緒に潜ることになった。'
  };
  const opened = await runConversationOpening({
    root,
    id: 'conv_dungeon_dr_5150',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    dungeonSceneContext: encounterScene,
    chatProvider: async () => 'ここで会うとは。さあ、一緒に進みましょう。'
  });
  assert.equal(opened.conversation.source_type, DUNGEON_SOURCE_TYPE);
  assert.equal(opened.conversation.location_name, '実践ダンジョン 第1層');
  assert.equal(opened.conversation.visible_situation, encounterScene.visible_situation);
  assert.equal(Object.hasOwn(opened.conversation, 'location_id'), false);
  assert.equal(Object.hasOwn(opened.conversation, 'time_slot'), false);
  const persistedOpen = await readJson(root, 'game_data/logs/conversations/conv_dungeon_dr_5150.json');
  assert.equal(persistedOpen.source_type, DUNGEON_SOURCE_TYPE);
  assert.equal(persistedOpen.location_name, '実践ダンジョン 第1層');
  assert.equal(Object.hasOwn(persistedOpen, 'location_id'), false);
  assert.equal(Object.hasOwn(persistedOpen, 'time_slot'), false);

  // A continuing exploration turn stamps the CURRENT floor's scene and still carries no field residual.
  const explorationScene = {
    source_type: DUNGEON_SOURCE_TYPE,
    location_name: '実践ダンジョン 第3層',
    visible_situation: '実践ダンジョンの第3層を主人公と一緒に探索している。'
  };
  const turned = await runConversationTurnCore({
    root,
    id: 'conv_dungeon_dr_5150',
    characterId: 'lina',
    playerInput: 'この階、敵が多いね',
    now: '2026-05-05T06:02:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: explorationScene,
    conversationContinuationProvider: async () => 'true',
    chatProvider: async () => '気を抜かないで。私が前に出ます。',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });
  assert.equal(turned.conversation.source_type, DUNGEON_SOURCE_TYPE);
  assert.equal(turned.conversation.location_name, '実践ダンジョン 第3層');
  assert.equal(turned.conversation.visible_situation, explorationScene.visible_situation);
  assert.equal(Object.hasOwn(turned.conversation, 'location_id'), false);
  assert.equal(Object.hasOwn(turned.conversation, 'time_slot'), false);
  const persistedTurn = await readJson(root, 'game_data/logs/conversations/conv_dungeon_dr_5150.json');
  assert.equal(persistedTurn.source_type, DUNGEON_SOURCE_TYPE);
  assert.equal(persistedTurn.location_name, '実践ダンジョン 第3層');
  assert.equal(Object.hasOwn(persistedTurn, 'location_id'), false);
  assert.equal(Object.hasOwn(persistedTurn, 'time_slot'), false);
});

test('finalizing a dungeon companion conversation feeds the dungeon floor scene (not field residual) to post-processing prompts', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', {
    ...state,
    current_location_id: 'sanrin_mossy_shrine',
    current_location_visible_situation: '苔むした古祠にいる。',
    time_slot: 'after_school'
  });

  await runConversationOpening({
    root,
    id: 'conv_dungeon_dr_6161',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    dungeonSceneContext: {
      source_type: DUNGEON_SOURCE_TYPE,
      location_name: '実践ダンジョン 第2層',
      visible_situation: '実践ダンジョンの第2層を主人公と一緒に探索している。'
    },
    chatProvider: async () => '足元に気をつけて。'
  });

  let moneyPrompt = '';
  let affinityPrompt = '';
  await finalizeConversationCore({
    root,
    conversationId: 'conv_dungeon_dr_6161',
    characterId: 'lina',
    now: '2026-05-05T06:05:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    moneyDeltaProvider: async ({ prompt }) => { moneyPrompt = prompt; return '0'; },
    affinityDeltaProvider: async ({ prompt }) => { affinityPrompt = prompt; return '0'; }
  });

  for (const prompt of [moneyPrompt, affinityPrompt]) {
    assert.match(prompt, /"source_type": "dungeon"/);
    assert.match(prompt, /"location_name": "実践ダンジョン 第2層"/);
    assert.match(prompt, /実践ダンジョンの第2層を主人公と一緒に探索している。/);
    assert.doesNotMatch(prompt, /sanrin_mossy_shrine/);
    assert.doesNotMatch(prompt, /after_school/);
    assert.doesNotMatch(prompt, /"location_id"/);
    assert.doesNotMatch(prompt, /"time_slot"/);
  }

  // After finalization the record is trimmed (discardConversationContent); it must keep the same contract:
  // dungeon source_type, no field location_id / time_slot residual.
  const discarded = await readJson(root, 'game_data/logs/conversations/conv_dungeon_dr_6161.json');
  assert.equal(discarded.prompt_discarded, true);
  assert.equal(discarded.source_type, DUNGEON_SOURCE_TYPE);
  assert.equal(Object.hasOwn(discarded, 'location_id'), false);
  assert.equal(Object.hasOwn(discarded, 'time_slot'), false);
});

// The errand and study circle conversations are injected-scene sessions (same mechanism as the dungeon):
// each scene builder declares its own source_type, so the record stamps that source_type + the session 舞台
// and drops the residual field location_id / time_slot. One parametrized pair covers both.
for (const { label, sourceType, scene, id } of [
  {
    label: 'errand',
    sourceType: ERRAND_SOURCE_TYPE,
    id: 'conv_errand_9_lina_scene',
    scene: {
      source_type: ERRAND_SOURCE_TYPE,
      location_name: '依頼の現場',
      visible_situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。'
    }
  },
  {
    label: 'study circle',
    sourceType: STUDY_CIRCLE_SOURCE_TYPE,
    id: 'conv_study_circle_9_lina_scene',
    scene: {
      source_type: STUDY_CIRCLE_SOURCE_TYPE,
      location_name: '第三観測室',
      visible_situation: '観測机に、星図と観測記録が種類ごとに並べて置かれている。'
    }
  }
]) {
  test(`${label} conversation records declare their source_type with the session scene and no field residual`, async () => {
    const root = await fixtureRoot();
    const state = await readJson(root, 'game_data/runtime_state.json');
    // Reproduce the bug precondition: a residual field location_id + time_slot that the following errand /
    // study circle conversation must NOT inherit.
    await writeSplitJson(root, 'game_data/runtime_state.json', {
      ...state,
      current_location_id: 'herbology_garden',
      current_location_visible_situation: '放課後の薬草園にいる。',
      time_slot: 'after_school'
    });

    const opened = await runConversationOpening({
      root,
      id,
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      dungeonSceneContext: scene,
      chatProvider: async () => 'それじゃ、始めましょうか。'
    });
    assert.equal(opened.conversation.source_type, sourceType);
    assert.equal(opened.conversation.location_name, scene.location_name);
    assert.equal(opened.conversation.visible_situation, scene.visible_situation);
    assert.equal(Object.hasOwn(opened.conversation, 'location_id'), false);
    assert.equal(Object.hasOwn(opened.conversation, 'time_slot'), false);
    const persistedOpen = await readJson(root, `game_data/logs/conversations/${id}.json`);
    assert.equal(persistedOpen.source_type, sourceType);
    assert.equal(persistedOpen.location_name, scene.location_name);
    assert.equal(Object.hasOwn(persistedOpen, 'location_id'), false);
    assert.equal(Object.hasOwn(persistedOpen, 'time_slot'), false);

    // A continuing turn re-stamps the session scene and still carries no field residual.
    const turned = await runConversationTurnCore({
      root,
      id,
      characterId: 'lina',
      playerInput: 'ここ、こう考えるといいのかな',
      now: '2026-05-05T06:02:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: scene,
      conversationContinuationProvider: async () => 'true',
      chatProvider: async () => 'うん、その調子です。',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    });
    assert.equal(turned.conversation.source_type, sourceType);
    assert.equal(turned.conversation.location_name, scene.location_name);
    assert.equal(Object.hasOwn(turned.conversation, 'location_id'), false);
    assert.equal(Object.hasOwn(turned.conversation, 'time_slot'), false);
    const persistedTurn = await readJson(root, `game_data/logs/conversations/${id}.json`);
    assert.equal(persistedTurn.source_type, sourceType);
    assert.equal(persistedTurn.location_name, scene.location_name);
    assert.equal(Object.hasOwn(persistedTurn, 'location_id'), false);
    assert.equal(Object.hasOwn(persistedTurn, 'time_slot'), false);
  });

  test(`finalizing a ${label} conversation feeds the session scene (not field residual) to post-processing prompts and keeps the discard contract`, async () => {
    const root = await fixtureRoot();
    const state = await readJson(root, 'game_data/runtime_state.json');
    await writeSplitJson(root, 'game_data/runtime_state.json', {
      ...state,
      current_location_id: 'herbology_garden',
      current_location_visible_situation: '放課後の薬草園にいる。',
      time_slot: 'after_school'
    });
    const finalizeId = `${id}_finalize`;
    await runConversationOpening({
      root,
      id: finalizeId,
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      dungeonSceneContext: scene,
      chatProvider: async () => 'それじゃ、始めましょうか。'
    });

    let moneyPrompt = '';
    let affinityPrompt = '';
    await finalizeConversationCore({
      root,
      conversationId: finalizeId,
      characterId: 'lina',
      now: '2026-05-05T06:05:00.000+09:00',
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      moneyDeltaProvider: async ({ prompt }) => { moneyPrompt = prompt; return '0'; },
      affinityDeltaProvider: async ({ prompt }) => { affinityPrompt = prompt; return '0'; }
    });

    for (const prompt of [moneyPrompt, affinityPrompt]) {
      assert.match(prompt, new RegExp(`"source_type": "${sourceType}"`));
      assert.match(prompt, new RegExp(`"location_name": "${scene.location_name}"`));
      assert.ok(prompt.includes(scene.visible_situation), 'the session visible_situation is present');
      assert.doesNotMatch(prompt, /herbology_garden/);
      assert.doesNotMatch(prompt, /after_school/);
      assert.doesNotMatch(prompt, /"location_id"/);
      assert.doesNotMatch(prompt, /"time_slot"/);
    }

    // After finalization the record is trimmed (discardConversationContent); it keeps the same contract as the
    // dungeon precedent: the session source_type is preserved and no field location_id / time_slot residual.
    const discarded = await readJson(root, `game_data/logs/conversations/${finalizeId}.json`);
    assert.equal(discarded.prompt_discarded, true);
    assert.equal(discarded.source_type, sourceType);
    assert.equal(Object.hasOwn(discarded, 'location_id'), false);
    assert.equal(Object.hasOwn(discarded, 'time_slot'), false);
  });
}

test('an injected scene context declaring an out-of-set source_type is a caller bug and fails fast (no field degrade)', async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_errand_badsource_001',
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      dungeonSceneContext: {
        source_type: 'field',
        location_name: '依頼の現場',
        visible_situation: '机に教本が開いて置かれている。'
      },
      chatProvider: async () => 'should not run'
    }),
    /injected scene context source_type must be one of/
  );
});

test('runConversationTurn preserves newer 16-expression choices instead of collapsing them to neutral', async () => {
  const root = await fixtureRoot();
  const result = await runConversationTurn({
    root,
    id: 'conv_emotion_16_001',
    characterId: 'lina',
    playerInput: 'その決意、顔にも出てるね',
    now: '2026-05-05T06:20:00.000+09:00',
    emotionProvider: async ({ prompt }) => {
      assert.match(prompt, /caring, confident, sadness, worried, anger, surprised, embarrassed, shy, serious, determined, panic, tired, sick, smug/);
      return { expression: 'determined' };
    },
    chatProvider: async () => '……はい。今は迷わず、やるべきことを進めます。'
  });

  assert.equal(result.conversation.messages.at(-1).expression, 'determined');
  assert.equal(result.conversation.messages.at(-1).face_emotion_variant_id, 'face_determined');
});

test('runConversationTurn replaces the most recent prompt memories with matching work records and keeps missing matches as memories', async () => {
  const root = await fixtureRoot();
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });

  const memoryRecords = [
    { id: 'mem_recent_prompt_01', text: 'MEMORY-01-oldest-kept', work_record_id: 'wr_recent_prompt_01' },
    { id: 'mem_recent_prompt_02', text: 'MEMORY-02-older-kept', work_record_id: 'wr_recent_prompt_02' },
    { id: 'mem_recent_prompt_03', text: 'MEMORY-03-recent-linked-replaced', work_record_id: 'wr_recent_prompt_03' },
    { id: 'mem_recent_prompt_04', text: 'MEMORY-04-recent-source-fallback-replaced', source_conversation_id: 'conv_recent_prompt_04' },
    { id: 'mem_recent_prompt_05', text: 'MEMORY-05-recent-missing-work-record-kept', source_conversation_id: 'conv_recent_prompt_05', work_record_id: 'wr_recent_prompt_missing_05' },
    { id: 'mem_recent_prompt_06_hidden', visibility: 'hidden_story', text: 'MEMORY-06-hidden-not-a-prompt-candidate', source_conversation_id: 'conv_recent_prompt_06', work_record_id: 'wr_hidden_recent_prompt_06' }
  ];
  for (const memory of memoryRecords) {
    await fs.writeFile(path.join(memoryDir, `${memory.id}.json`), JSON.stringify({
      character_id: 'lina',
      visibility: 'character_known',
      type: 'relationship_change',
      ...memory
    }, null, 2), 'utf8');
  }
  await fs.writeFile(path.join(workRecordDir, 'wr_recent_prompt_03.md'), '# recent prompt 03\n\nID: wr_recent_prompt_03\n\n## Summary\n\nWORK-03-detail-from-linked-work-record.\n', 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_conv_recent_prompt_04.md'), '# recent prompt 04\n\nID: wr_conv_recent_prompt_04\n\n## Summary\n\nWORK-04-detail-from-source-conversation-fallback.\n', 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_conv_recent_prompt_05.md'), '# recent prompt 05 fallback should not be used\n\nID: wr_conv_recent_prompt_05\n\n## Summary\n\nWORK-05-fallback-should-not-replace-explicit-missing-link.\n', 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_hidden_recent_prompt_06.md'), '# hidden recent prompt 06\n\nID: wr_hidden_recent_prompt_06\n\n## Summary\n\nHIDDEN-WORK-06-should-not-leak.\n', 'utf8');

  let prompt = '';
  await runConversationTurn({
    root,
    id: 'conv_recent_prompt_turn_001',
    characterId: 'lina',
    playerInput: '今日は別件の確認だけしたい。',
    now: '2026-05-05T06:30:00.000+09:00',
    chatProvider: async ({ prompt: receivedPrompt }) => {
      prompt = receivedPrompt;
      return '別件ですね。順番に確認します。';
    }
  });

  assert.match(prompt, /MEMORY-01-oldest-kept/);
  assert.match(prompt, /MEMORY-02-older-kept/);
  assert.match(prompt, /MEMORY-05-recent-missing-work-record-kept/);
  assert.doesNotMatch(prompt, /MEMORY-03-recent-linked-replaced/);
  assert.doesNotMatch(prompt, /MEMORY-04-recent-source-fallback-replaced/);
  assert.doesNotMatch(prompt, /MEMORY-06-hidden-not-a-prompt-candidate/);
  assert.match(prompt, /WORK-03-detail-from-linked-work-record/);
  assert.match(prompt, /WORK-04-detail-from-source-conversation-fallback/);
  assert.doesNotMatch(prompt, /WORK-05-fallback-should-not-replace-explicit-missing-link/);
  assert.doesNotMatch(prompt, /HIDDEN-WORK-06-should-not-leak/);
});


test('editing a past user message rewinds the active conversation to that turn and regenerates from the edited text', async () => {
  const root = await fixtureRoot();
  await runConversationOpening({
    root,
    id: 'conv_edit_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => 'ここから話しましょう。'
  });
  await runConversationTurn({
    root,
    id: 'conv_edit_001',
    characterId: 'lina',
    playerInput: '最初の発言',
    now: '2026-05-05T06:01:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async ({ playerInput }) => `返答:${playerInput}`
  });
  await runConversationTurn({
    root,
    id: 'conv_edit_001',
    characterId: 'lina',
    playerInput: '後続の発言',
    now: '2026-05-05T06:02:00.000+09:00',
    emotionProvider: async () => ({ expression: 'happy' }),
    chatProvider: async ({ playerInput }) => `後続返答:${playerInput}`
  });
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), `${JSON.stringify({
    money: 150,
    items: [{ item_id: 'eternel_cube', quantity: 1 }]
  }, null, 2)}
`, 'utf8');

  const edited = await editConversationUserMessage({
    root,
    characterId: 'lina',
    messageIndex: 1,
    content: '編集後の最初の発言',
    now: '2026-05-05T06:03:00.000+09:00',
    emotionProvider: async ({ playerInput, currentConversation }) => {
      assert.equal(playerInput, '編集後の最初の発言');
      assert.deepEqual(currentConversation.map((message) => message.content), ['ここから話しましょう。']);
      return { expression: 'surprised' };
    },
    chatProvider: async ({ playerInput }) => `編集後返答:${playerInput}`
  });

  assert.deepEqual(edited.conversation.messages.map((message) => message.content), [
    'ここから話しましょう。',
    '編集後の最初の発言',
    '編集後返答:編集後の最初の発言'
  ]);
  assert.equal(edited.conversation.messages[2].expression, 'surprised');
  assert.equal(edited.rewound_from_message_count, 5);
  assert.equal(edited.edited_message_index, 1);
  const persisted = await readJson(root, 'game_data/logs/conversations/conv_edit_001.json');
  assert.deepEqual(persisted.messages.map((message) => message.content), edited.conversation.messages.map((message) => message.content));
});


test('editing a past user message requires the Eterneru Cube inventory item', async () => {
  const root = await fixtureRoot();
  await runConversationOpening({
    root,
    id: 'conv_edit_requires_cube_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => 'ここから話しましょう。'
  });
  await runConversationTurn({
    root,
    id: 'conv_edit_requires_cube_001',
    characterId: 'lina',
    playerInput: '最初の発言',
    now: '2026-05-05T06:01:00.000+09:00',
    chatProvider: async ({ playerInput }) => `返答:${playerInput}`
  });

  await assert.rejects(
    editConversationUserMessage({
      root,
      characterId: 'lina',
      messageIndex: 1,
      content: '編集できない発言',
      now: '2026-05-05T06:02:00.000+09:00'
    }),
    /conversation_edit_item_required/
  );

  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), `${JSON.stringify({
    money: 150,
    items: [{ item_id: 'eternel_cube', quantity: 1 }]
  }, null, 2)}
`, 'utf8');

  const edited = await editConversationUserMessage({
    root,
    characterId: 'lina',
    messageIndex: 1,
    content: '編集できる発言',
    now: '2026-05-05T06:03:00.000+09:00',
    chatProvider: async ({ playerInput }) => `編集後返答:${playerInput}`
  });

  assert.deepEqual(edited.conversation.messages.map((message) => message.content), [
    'ここから話しましょう。',
    '編集できる発言',
    '編集後返答:編集できる発言'
  ]);
});


test('finalizeConversation always writes memory and work record, and only writes a skill when the necessity pass says true', async () => {
  const root = await fixtureRoot();
  await runConversationTurn({
    root,
    id: 'conv_skill_gate_false_001',
    characterId: 'lina',
    playerInput: '今日は記録だけ残しておこう',
    now: '2026-05-05T06:10:00.000+09:00',
    chatProvider: async () => '……はい。記録に残すことを優先しましょう。'
  });

  let skillWriterCalled = false;
  const skipped = await finalizeConversation({
    root,
    conversationId: 'conv_skill_gate_false_001',
    characterId: 'lina',
    now: '2026-05-05T06:11:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    skillUpdateProvider: async () => {
      skillWriterCalled = true;
      throw new Error('skill writer should not run when the necessity pass says false');
    }
  });

  assert.equal(skillWriterCalled, false);
  assert.equal(skipped.skill_update.skipped, true);
  assert.equal(skipped.skill_update.reason, 'no_decisive_behavior_change');
  assert.equal(skipped.skill_update.raw_answer, 'false');
  assert.equal(skipped.validator.accepted_memory.length, 1);
  assert.deepEqual(skipped.validator.accepted_skills, []);
  assert.deepEqual(skipped.validator.rejected_skills, []);
  assert.equal(Boolean(skipped.validator.accepted_work_record), true);
  assert.equal(await exists(root, 'game_data/characters/lina/memory/mem_conv_skill_gate_false_001.json'), true);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_skill_gate_false_001.md'), true);
  assert.equal((await readJson(root, 'game_data/characters/lina/skills.json')).skills.some((skill) => skill.id === 'skill_conv_skill_gate_false_001'), false);

  await runConversationTurn({
    root,
    id: 'conv_skill_gate_true_001',
    characterId: 'lina',
    playerInput: '今度は少し変わった気がする',
    now: '2026-05-05T06:12:00.000+09:00',
    chatProvider: async () => '……はい。その変化も、短く確かめておきましょう。'
  });

  const occurred = await finalizeConversation({
    root,
    conversationId: 'conv_skill_gate_true_001',
    characterId: 'lina',
    now: '2026-05-05T06:13:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' })
  });

  assert.equal(occurred.skill_update.skipped, undefined);
  assert.equal(occurred.validator.accepted_memory.length, 1);
  assert.equal(occurred.validator.accepted_skills.length, 1);
  assert.equal(Boolean(occurred.validator.accepted_work_record), true);
  assert.equal((await readJson(root, 'game_data/characters/lina/skills.json')).skills.some((skill) => skill.id === 'skill_conv_skill_gate_true_001'), true);

  await runConversationTurn({
    root,
    id: 'conv_skill_gate_invalid_001',
    characterId: 'lina',
    playerInput: '曖昧な変化だったかもしれない',
    now: '2026-05-05T06:14:00.000+09:00',
    chatProvider: async () => '……まだ言葉にするには早いかもしれません。'
  });

  let invalidSkillWriterCalled = false;
  const invalid = await finalizeConversation({
    root,
    conversationId: 'conv_skill_gate_invalid_001',
    characterId: 'lina',
    now: '2026-05-05T06:15:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: null, raw_answer: 'maybe' }),
    skillUpdateProvider: async () => {
      invalidSkillWriterCalled = true;
      throw new Error('skill writer should not run when the necessity answer is invalid');
    }
  });

  assert.equal(invalidSkillWriterCalled, false);
  assert.equal(invalid.skill_update.skipped, true);
  assert.equal(invalid.skill_update.reason, 'invalid_skill_necessity_answer');
  assert.equal(invalid.skill_update.raw_answer, 'maybe');
  assert.deepEqual(invalid.validator.accepted_skills, []);
  assert.equal((await readJson(root, 'game_data/characters/lina/skills.json')).skills.some((skill) => skill.id === 'skill_conv_skill_gate_invalid_001'), false);
});


test('runConversationTurn appends active turns; finalize separately writes memory, skill, work record and discards session text', async () => {
  const root = await fixtureRoot();
  const initialState = await readJson(root, 'game_data/runtime_state.json');
  await writeSplitJson(root, 'game_data/runtime_state.json', { ...initialState, elapsed_weeks: 2 });
  let secondPrompt = '';
  let firstEmotionPrompt = '';
  const emotionAndChatOrder = [];
  const first = await runConversationTurn({
    root,
    id: 'conv_test_001',
    characterId: 'lina',
    playerInput: '棚札の順番、確認してもいい？',
    now: '2026-05-05T05:45:00.000+09:00',
    emotionProvider: async ({ prompt, playerInput, profile }) => {
      emotionAndChatOrder.push('emotion');
      assert.equal(playerInput, '棚札の順番、確認してもいい？');
      assert.equal(profile.display_name, 'リナ・クラウゼ');
      firstEmotionPrompt = prompt;
      assert.match(prompt.trim().split('\n').at(-1), /リナ・クラウゼとして、彼我の能力値を参照した上で、数値と言動が矛盾しないよう注意しつつ、現在の場面に自然に続く感情を次から1つだけ選択する。/);
      assert.doesNotMatch(prompt, /次のプレイヤー入力を受け取った直後のリナ・クラウゼの感情/);
      return { expression: 'worried' };
    },
    onEmotion: (emotion) => {
      assert.deepEqual(emotion, { expression: 'worried', face_emotion_variant_id: 'face_worried' });
    },
    chatProvider: async ({ prompt }) => {
      emotionAndChatOrder.push('chat');
      assert.deepEqual(emotionAndChatOrder, ['emotion', 'chat']);
      assert.deepEqual(firstEmotionPrompt.trim().split('\n').slice(0, -1), prompt.trim().split('\n').slice(0, -1));
      assert.match(prompt.trim().split('\n').at(-1), /リナ・クラウゼとして、あなた自身の話し方の口調を保ったまま、彼我の能力値と言動が矛盾しないよう注意しつつ、現在の場面に自然に続く返答だけを書く。「見えている状況」は丸ごと説明し直さず、気になった一点にだけ触れて反応する。相手の言葉をそのまま言い換えて返すオウム返しや、説明口調で理屈を並べる受け答えはしない。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いや仕草には丸括弧をつける。発話すること自体が不自然な場合は振る舞いなどのみを書く。/);
      assert.match(prompt, /^星灯魔法学院の2年生、薬草学研究会に所属するリナ・クラウゼへの完全な没入によって応答する。/);
      assert.doesNotMatch(prompt, /prompt builderの除外確認用/);
      assert.doesNotMatch(prompt, /イベント背景/);
      return '……はい。棚札と水やりの記録を、順番に見比べてみましょう。';
    }
  });

  assert.equal(first.conversation.id, 'conv_test_001');
  assert.equal(first.state.current_screen, 'interaction');
  assert.equal(first.state.current_interaction_character_id, 'lina');
  assert.equal(first.state.last_conversation_id, 'conv_test_001');
  assert.equal(first.conversation.messages.at(-1).expression, 'worried');
  assert.equal(first.conversation.messages.at(-1).face_emotion_variant_id, 'face_worried');
  assert.equal(await exists(root, 'game_data/logs/conversations/conv_test_001.json'), true);
  assert.equal(await exists(root, 'game_data/logs/memory_updates/conv_test_001.json'), false);
  assert.equal(await exists(root, 'game_data/logs/skill_updates/conv_test_001.json'), false);
  assert.equal(await exists(root, 'game_data/logs/work_record_updates/conv_test_001.json'), false);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_test_001.md'), false);

  const second = await runConversationTurn({
    root,
    characterId: 'lina',
    playerInput: '水やりの記録はどこにある？',
    now: '2026-05-05T05:46:00.000+09:00',
    chatProvider: async ({ prompt }) => {
      secondPrompt = prompt;
      assert.match(prompt, /直前までの会話:/);
      assert.match(prompt, /プレイヤー: 棚札の順番、確認してもいい？/);
      assert.match(prompt, /リナ・クラウゼ: ……はい。棚札と水やりの記録/);
      return '薬草園の記録棚にあります。日付順に見れば、入れ替わった場所が分かるはずです。';
    }
  });

  assert.equal(second.conversation.id, 'conv_test_001');
  assert.equal(second.conversation.messages.length, 4);
  assert.match(secondPrompt, /水やりの記録はどこにある？/);
  assert.equal(await exists(root, 'game_data/logs/memory_updates/conv_test_001.json'), false);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_test_001.md'), false);

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_test_001',
    characterId: 'lina',
    now: '2026-05-05T05:47:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({
      memory_record: {
        character_id: 'lina',
        id: 'mem_from_conv_test_001',
        type: 'relationship_change',
        text: 'リナは、主人公が棚札の違いを一緒に確認したことで、主人公を丁寧に状況確認できる相手として少し信頼した。',
        visibility: 'private',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: ['リナ', '薬草園', '棚札']
      }
    }),
    skillUpdateProvider: async ({ conversation, workRecordId }) => ({
      skill_record: {
        character_id: 'lina',
        id: 'skill_from_conv_test_001',
        type: 'self_change',
        name: '会話からの自己変化',
        description: 'リナは主人公と棚札の順番を確認した経験から、気になる点を一人で抱え込まず共有して調べる意識を強めた。',
        visibility: 'private',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: ['リナ', '自己変化']
      }
    }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: 'lina',
        source_conversation_id: conversation.id,
        title: '放課後の薬草園で棚札の順番について話した',
        summary: '主人公は棚札の順番が記録と違うと考え、リナに確認した。リナは棚札と水やりの記録を見比べ、落ち着いて原因を探そうとした。主人公が記録の場所について続けて聞いたことで、二人は現場の違和感を一緒に確認する流れを作った。',
        participants: ['player', 'lina'],
        future_hooks: ['薬草園の記録棚を確認する'],
        retrieval_tags: ['リナ', '薬草園', '棚札'],
        flag_update_candidates: [
          { character_id: 'lina', flag: 'knowledge.lina.player_checked_garden_label', op: 'set', value: true },
          { character_id: 'lina', flag: 'relationship.lina.trust', op: 'increment', value: 1 },
          { character_id: 'lina', flag: 'story.archive_intro_done', op: 'set', value: true }
        ],
        warnings: []
      }
    }),
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' })
  });

  assert.equal(finalized.validator.accepted_flags.length, 3);
  assert.equal(finalized.validator.accepted_memory[0].work_record_id, 'wr_conv_test_001');
  assert.equal(finalized.validator.accepted_memory[0].visibility, 'character_known');
  assert.equal(finalized.validator.accepted_skills[0].work_record_id, 'wr_conv_test_001');
  assert.equal(finalized.validator.accepted_skills[0].visibility, 'character_known');
  assert.equal(finalized.validator.accepted_work_record.title, '放課後の薬草園で棚札の順番について話した');
  assert.equal(finalized.validator.accepted_work_record.academy_week_number, 3);
  assert.equal(finalized.validator.accepted_work_record.academy_elapsed_weeks_at_start, 2);
  assert.equal(finalized.validator.accepted_work_record.participants, undefined);
  assert.equal(finalized.validator.accepted_work_record.future_hooks, undefined);
  assert.equal(finalized.validator.accepted_work_record.retrieval_tags, undefined);
  assert.equal(finalized.state.current_screen, 'academy-room');
  assert.equal(finalized.state.current_interaction_character_id, null);
  assert.equal(finalized.state.characters.lina.flags['knowledge.lina.player_checked_garden_label'], true);
  assert.equal(finalized.state.characters.lina.flags['relationship.lina.trust'], 1);
  assert.equal(finalized.state.global_flags['story.archive_intro_done'], true);
  assert.equal(await exists(root, 'game_data/logs/memory_updates/conv_test_001.json'), true);
  assert.equal(await exists(root, 'game_data/logs/skill_updates/conv_test_001.json'), true);
  assert.equal(await exists(root, 'game_data/logs/work_record_updates/conv_test_001.json'), true);
  assert.equal(await exists(root, 'game_data/logs/validator/conv_test_001.json'), true);
  assert.equal(await exists(root, 'game_data/logs/finalization/conv_test_001.json'), true);
  const finalizationMarker = await readJson(root, 'game_data/logs/finalization/conv_test_001.json');
  assert.deepEqual(finalizationMarker, {
    conversation_id: 'conv_test_001',
    work_record_id: 'wr_conv_test_001',
    finalized_at: '2026-05-05T05:47:00.000+09:00'
  });
  assert.equal(await exists(root, 'game_data/characters/lina/memory/mem_from_conv_test_001.json'), true);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_test_001.md'), true);

  const conversationLog = await readJson(root, 'game_data/logs/conversations/conv_test_001.json');
  assert.equal(conversationLog.academy_week_number, 3);
  assert.equal(conversationLog.academy_elapsed_weeks_at_start, 2);
  assert.equal(conversationLog.discarded_after_work_record_id, 'wr_conv_test_001');
  assert.equal(conversationLog.messages.length, 0);
  assert.equal(conversationLog.prompt_discarded, true);
  const workRecordMarkdown = await fs.readFile(path.join(root, 'game_data/characters/lina/work_records/wr_conv_test_001.md'), 'utf8');
  assert.doesNotMatch(workRecordMarkdown, /record_role:/);
  assert.match(workRecordMarkdown, /# 放課後の薬草園で棚札の順番について話した/);
  assert.match(workRecordMarkdown, /ID: wr_conv_test_001/);
  assert.match(workRecordMarkdown, /## 第3週のサマリー/);
  assert.doesNotMatch(workRecordMarkdown, /## Summary/);
  assert.doesNotMatch(workRecordMarkdown, /## Participants/);
  assert.doesNotMatch(workRecordMarkdown, /## Future hooks/);
  assert.doesNotMatch(workRecordMarkdown, /## Retrieval tags/);
  assert.doesNotMatch(workRecordMarkdown, /水やりの記録はどこにある？/);

  const skills = await readJson(root, 'game_data/characters/lina/skills.json');
  assert.equal(skills.skills.some((skill) => skill.id === 'skill_from_conv_test_001' && skill.work_record_id === 'wr_conv_test_001' && skill.visibility === 'character_known'), true);
  const memory = await readJson(root, 'game_data/characters/lina/memory/mem_from_conv_test_001.json');
  assert.equal(memory.visibility, 'character_known');
  const characterFlags = await readJson(root, 'game_data/characters/lina/flags.json');
  assert.equal(characterFlags['knowledge.lina.player_checked_garden_label'], true);
  assert.equal(characterFlags['relationship.lina.trust'], 1);
});

test('finalizeConversation preserves character flag precedence when a flag also exists globally', async (t) => {
  const root = await splitFixtureRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    ...state,
    global_flags: { ...state.global_flags, 'knowledge.shared.route': false },
    characters: {
      ...state.characters,
      lina: { flags: { ...(state.characters?.lina?.flags ?? {}), 'knowledge.shared.route': false } }
    }
  });
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/flags.json', {
    character_id: 'lina',
    flags: { 'knowledge.shared.route': false }
  });

  await runConversationOpening({
    root,
    id: 'conv_character_flag_precedence_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => '棚札を一緒に確認しましょう。'
  });
  await runConversationTurn({
    root,
    id: 'conv_character_flag_precedence_001',
    characterId: 'lina',
    playerInput: 'この印、覚えてる？',
    now: '2026-05-05T06:01:00.000+09:00',
    chatProvider: async () => 'はい、リナ側の記録として覚えています。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_character_flag_precedence_001',
    characterId: 'lina',
    now: '2026-05-05T06:02:00.000+09:00',
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: 'lina',
        source_conversation_id: conversation.id,
        title: '共有名のフラグ更新先を確認した',
        summary: '主人公とリナは同じ名前のフラグが全体とリナ側にある場合の記録先を確認した。',
        flag_update_candidates: [
          { character_id: 'lina', flag: 'knowledge.shared.route', op: 'set', value: true }
        ],
        warnings: []
      }
    }),
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' })
  });

  assert.equal(finalized.state.characters.lina.flags['knowledge.shared.route'], true);
  assert.equal(finalized.state.global_flags['knowledge.shared.route'], false);
  const runtimeState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(runtimeState.characters.lina.flags['knowledge.shared.route'], true);
  assert.equal(runtimeState.global_flags['knowledge.shared.route'], false);
  const characterFlags = await readJson(root, 'data/mutable/game_data/characters/lina/flags.json');
  assert.equal(characterFlags['knowledge.shared.route'], true);
});


test('finalizeConversation preserves training progress written while finalization is running', async () => {
  const root = await fixtureRoot();
  await runConversationOpening({
    root,
    id: 'conv_training_race_001',
    characterId: 'lina',
    now: '2026-05-05T06:00:00.000+09:00',
    chatProvider: async () => 'ここから話しましょう。'
  });
  await runConversationTurn({
    root,
    id: 'conv_training_race_001',
    characterId: 'lina',
    playerInput: '鍛錬に入る前に確認したい',
    now: '2026-05-05T06:01:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => '確認できました。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_training_race_001',
    characterId: 'lina',
    now: '2026-05-05T06:02:00.000+09:00',
    memoryUpdateProvider: async ({ state }) => {
      await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), `${JSON.stringify({
        ...state,
        current_screen: 'academy-room',
        current_interaction_character_id: null,
        training_actions_used: 3,
        training_actions_limit: 6
      }, null, 2)}\n`, 'utf8');
      return { memories: [] };
    },
    skillUpdateProvider: async () => ({ skills: [] }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: 'lina',
        source_conversation_id: conversation.id,
        title: '鍛錬前の確認',
        summary: '主人公とリナは鍛錬に入る前の確認をした。',
        flag_update_candidates: []
      }
    }),
    stageFlagJudgmentProvider: async () => ({ judgments: [] }),
    eventFlagJudgmentProvider: async () => ({ judgments: [] }),
    eventParticipantOverrideJudgmentProvider: async () => ({ judgments: [] }),
    eventCompletionJudgmentProvider: async () => ({ completions: [] }),
    moneyDeltaProvider: async () => ({ delta: 0 }),
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false',
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' })
  });

  assert.equal(finalized.state.current_screen, 'academy-room');
  assert.equal(finalized.state.training_actions_used, 3);
  assert.equal(finalized.state.training_actions_limit, 6);
  const persisted = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(persisted.training_actions_used, 3);
});


test('finalizeConversation preserves newer academy progression written while finalization is running', async () => {
  const root = await fixtureRoot();
  await runConversationOpening({
    root,
    id: 'conv_week_race_001',
    characterId: 'lina',
    now: '2026-05-05T06:03:00.000+09:00',
    chatProvider: async () => 'ここから話しましょう。'
  });
  await runConversationTurn({
    root,
    id: 'conv_week_race_001',
    characterId: 'lina',
    playerInput: '次の週へ進む前に少しだけ話したい',
    now: '2026-05-05T06:04:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => '分かりました。ここで区切って進めましょう。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_week_race_001',
    characterId: 'lina',
    now: '2026-05-05T06:05:00.000+09:00',
    memoryUpdateProvider: async ({ state }) => {
      await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), `${JSON.stringify({
        ...state,
        current_screen: 'academy-map',
        current_interaction_character_id: null,
        training_actions_used: 0,
        training_actions_limit: 6,
        elapsed_weeks: 1,
        ending_started: true,
        ending_completed: false,
        ending_character_id: 'lina'
      }, null, 2)}\n`, 'utf8');
      return { memories: [] };
    },
    skillUpdateProvider: async () => ({ skills: [] }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: 'lina',
        source_conversation_id: conversation.id,
        title: '次週進行前の会話',
        summary: '主人公とリナは次の週へ進む前に短く話した。',
        flag_update_candidates: []
      }
    }),
    stageFlagJudgmentProvider: async () => ({ judgments: [] }),
    eventFlagJudgmentProvider: async () => ({ judgments: [] }),
    eventParticipantOverrideJudgmentProvider: async () => ({ judgments: [] }),
    eventCompletionJudgmentProvider: async () => ({ completions: [] }),
    moneyDeltaProvider: async () => ({ delta: 0 }),
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false',
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' })
  });

  assert.equal(finalized.state.current_screen, 'academy-map');
  assert.equal(finalized.state.elapsed_weeks, 1);
  assert.equal(finalized.state.training_actions_used, 0);
  assert.equal(finalized.state.ending_started, true);
  assert.equal(finalized.state.ending_completed, false);
  assert.equal(finalized.state.ending_character_id, 'lina');
  const persisted = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(persisted.current_screen, 'academy-map');
  assert.equal(persisted.elapsed_weeks, 1);
  assert.equal(persisted.ending_started, true);
  assert.equal(persisted.ending_character_id, 'lina');
  assert.equal(finalized.validator.accepted_work_record.academy_week_number, 1);
  assert.equal(finalized.validator.accepted_work_record.academy_elapsed_weeks_at_start, 0);
  const workRecordMarkdown = await fs.readFile(path.join(root, 'game_data/characters/lina/work_records/wr_conv_week_race_001.md'), 'utf8');
  assert.match(workRecordMarkdown, /## 第1週のサマリー/);
  assert.doesNotMatch(workRecordMarkdown, /## 第2週のサマリー/);
});


test('finalizeConversation keeps five-sentence memory text before validation so work-record success does not discard memory detail', async () => {
  const root = await fixtureRoot();
  await runConversationTurn({
    root,
    id: 'conv_memory_clamp_001',
    characterId: 'lina',
    playerInput: 'この棚札、昨日と違う気がする',
    now: '2026-05-05T05:55:00.000+09:00',
    chatProvider: async () => '……はい。記録と現物を見比べて、変わった箇所を一緒に確かめましょう。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_memory_clamp_001',
    characterId: 'lina',
    now: '2026-05-05T05:56:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({
      memory_record: {
        character_id: 'lina',
        id: 'mem_memory_clamp_001',
        type: 'relationship_change',
        text: '主人公は棚札の違いに気づいた。リナはその観察を具体的な手がかりとして受け止めた。二人は記録と現物を見比べる流れになった。リナは主人公の着眼点を信頼した。次も違和感を共有してよい相手だと感じた。',
        visibility: 'character_known',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: ['棚札']
      }
    }),
    skillUpdateProvider: async ({ conversation, workRecordId }) => ({
      skill_record: {
        character_id: 'lina',
        id: 'skill_memory_clamp_001',
        type: 'self_change',
        name: '観察共有への意識',
        description: 'リナは主人公の観察を手がかりとして受け止め、一緒に確認する姿勢を強めた。',
        visibility: 'character_known',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: []
      }
    }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: 'lina',
        source_conversation_id: conversation.id,
        title: '棚札の違いを一緒に確認した',
        summary: '主人公は棚札の違いに気づき、リナに確認を求めた。リナは記録と現物を見比べて、変わった箇所を一緒に確かめようとした。',
        flag_update_candidates: [],
        warnings: []
      }
    }),
    skillNecessityProvider: async () => ({ necessary: true, raw_answer: 'true' })
  });

  assert.equal(finalized.validator.rejected_memory.length, 0);
  assert.equal(finalized.validator.accepted_memory[0].text, '主人公は棚札の違いに気づいた。リナはその観察を具体的な手がかりとして受け止めた。二人は記録と現物を見比べる流れになった。リナは主人公の着眼点を信頼した。次も違和感を共有してよい相手だと感じた。');
  const memory = await readJson(root, 'game_data/characters/lina/memory/mem_memory_clamp_001.json');
  assert.equal(memory.text, finalized.validator.accepted_memory[0].text);
  assert.equal(await exists(root, 'game_data/characters/lina/work_records/wr_conv_memory_clamp_001.md'), true);
});

test('runConversationTurn judges continuation after generated speech and before work-record recall', async () => {
  const root = await fixtureRoot();
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'mem_continue_judgment.json'), JSON.stringify({
    id: 'mem_continue_judgment',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'リナは主人公が会話継続を丁寧に確認したことを覚えている。',
    work_record_id: 'wr_continue_judgment'
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_continue_judgment.md'), '# 会話継続確認\n\nID: wr_continue_judgment\n\n## Summary\n\n主人公は話し続けてよいか確認した。\n', 'utf8');
  const order = [];
  let judgmentPrompt = '';
  let recallSawFinalMessages = false;

  const result = await runConversationTurn({
    root,
    id: 'conv_continue_judgment_001',
    characterId: 'lina',
    playerInput: 'まだ話していてもいい？',
    now: '2026-05-05T06:05:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => {
      order.push('chat');
      return '……はい。もう少しなら続けられます。';
    },
    conversationContinuationProvider: async ({ prompt, generatedAssistantText, currentConversation }) => {
      order.push('continuation');
      judgmentPrompt = prompt;
      assert.equal(generatedAssistantText, '……はい。もう少しなら続けられます。');
      assert.deepEqual(currentConversation.map((message) => message.content), ['まだ話していてもいい？', '……はい。もう少しなら続けられます。']);
      assert.match(prompt, /プレイヤーの発言: まだ話していてもいい？/);
      assert.match(prompt.trim().split('\n').at(-1), /会話を継続したいと思うか。/);
      return 'true';
    },
    onAssistantComplete: ({ content }) => {
      order.push('assistant_complete');
      assert.equal(content, '……はい。もう少しなら続けられます。');
    },
    workRecordRecallProvider: async ({ currentConversation }) => {
      order.push('recall');
      recallSawFinalMessages = currentConversation.at(-1)?.content === '……はい。もう少しなら続けられます。';
      return { work_record_ids: [] };
    }
  });

  assert.deepEqual(order, ['chat', 'assistant_complete', 'continuation', 'recall']);
  assert.equal(recallSawFinalMessages, true);
  assert.match(judgmentPrompt, /継続したい場合はtrue。継続したくない場合はfalse。/);
  assert.equal(result.conversation.conversation_continuation.continue_conversation, true);
  assert.equal(result.conversation.messages.at(-1).content, '……はい。もう少しなら続けられます。');
});

test('runConversationTurn appends a cutoff reply after the generated speech when continuation judgment is false', async () => {
  const root = await fixtureRoot();
  const order = [];
  let cutoffPrompt = '';

  const result = await runConversationTurn({
    root,
    id: 'conv_cutoff_001',
    characterId: 'lina',
    playerInput: 'これ以上ずっと付き合ってよ',
    now: '2026-05-05T06:06:00.000+09:00',
    emotionProvider: async () => ({ expression: 'tired' }),
    chatProvider: async () => {
      order.push('chat');
      return '……ええ、必要ならまだ聞きます。';
    },
    conversationContinuationProvider: async () => {
      order.push('continuation');
      return 'false';
    },
    conversationCutoffProvider: async ({ prompt, generatedAssistantText }) => {
      order.push('cutoff');
      cutoffPrompt = prompt;
      assert.equal(generatedAssistantText, '……ええ、必要ならまだ聞きます。');
      assert.match(prompt, /プレイヤーの発言: これ以上ずっと付き合ってよ/);
      assert.match(prompt, /先ほど自分が生成した発言: ……ええ、必要ならまだ聞きます。/);
      assert.match(prompt.trim().split('\n').at(-1), /この会話を切り上げる。/);
      return 'すみません、今日はここで区切ります。（薬瓶の位置を静かに整える）また必要な時に声をかけてください。';
    },
    onAssistantComplete: ({ content }) => {
      order.push('assistant_complete');
      if (order.filter((item) => item === 'assistant_complete').length === 1) {
        assert.equal(content, '……ええ、必要ならまだ聞きます。');
        return;
      }
      assert.match(content, /今日はここで区切ります/);
    },
    workRecordRecallProvider: async () => {
      order.push('recall');
      return { work_record_ids: [] };
    }
  });

  assert.deepEqual(order, ['chat', 'assistant_complete', 'continuation', 'cutoff', 'assistant_complete']);
  assert.match(cutoffPrompt, /発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。/);
  assert.equal(result.conversation.conversation_continuation.continue_conversation, false);
  assert.equal(result.conversation.conversation_continuation.generated_assistant_text, '……ええ、必要ならまだ聞きます。');
  assert.equal(result.conversation.conversation_continuation.cutoff_assistant_text, 'すみません、今日はここで区切ります。（薬瓶の位置を静かに整える）また必要な時に声をかけてください。');
  assert.deepEqual(result.conversation.messages.slice(-2).map((message) => message.content), [
    '……ええ、必要ならまだ聞きます。',
    'すみません、今日はここで区切ります。（薬瓶の位置を静かに整える）また必要な時に声をかけてください。'
  ]);
});

test('runConversationTurn does not run stage-move judgment when continuation judgment is false', async () => {
  const root = await fixtureRoot();
  let stageMoveAgreementCalled = false;

  const result = await runConversationTurn({
    root,
    id: 'conv_stage_move_continuation_false_001',
    characterId: 'lina',
    playerInput: 'もう今日は終わりにしよう',
    now: '2026-05-05T06:07:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => '……はい。今日はここで区切りましょう。',
    conversationContinuationProvider: async () => 'false',
    conversationCutoffProvider: async () => 'では、片付けを済ませます。また必要なら声をかけてください。',
    stageMoveAgreementProvider: async () => {
      stageMoveAgreementCalled = true;
      return true;
    },
    stageMoveDestinationProvider: async () => {
      throw new Error('stage move destination should not run when continuation is false');
    },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(stageMoveAgreementCalled, false);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
  assert.deepEqual(result.conversation.messages.slice(-2).map((message) => message.content), [
    '……はい。今日はここで区切りましょう。',
    'では、片付けを済ませます。また必要なら声をかけてください。'
  ]);
});

test('runConversationTurn runs stage-move Stage1 on the recent three exchanges and skips Stage2 when Stage1 is false', async () => {
  const root = await fixtureRoot();
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_screen = 'interaction';
  state.current_interaction_character_id = 'lina';
  state.last_conversation_id = 'conv_stage_move_window_001';
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify(state, null, 2), 'utf8');
  await fs.mkdir(path.join(root, 'game_data/logs/conversations'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_stage_move_window_001.json'), JSON.stringify({
    id: 'conv_stage_move_window_001',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:04:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    time_slot: 'after_school',
    conversation_actor_context: null,
    prompt: 'old prompt',
    messages: [
      { role: 'user', content: '古い発言1' },
      { role: 'assistant', content: '古い返答1' },
      { role: 'user', content: '古い発言2' },
      { role: 'assistant', content: '古い返答2' },
      { role: 'user', content: '最近の発言1' },
      { role: 'assistant', content: '最近の返答1' },
      { role: 'user', content: '最近の発言2' },
      { role: 'assistant', content: '最近の返答2' }
    ]
  }, null, 2), 'utf8');
  const order = [];
  let stage1Prompt = '';

  const result = await runConversationTurn({
    root,
    id: 'conv_stage_move_window_001',
    characterId: 'lina',
    playerInput: '図書館の話はまた今度にしよう',
    now: '2026-05-05T06:08:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => {
      order.push('chat');
      return '……はい。では薬草園の確認を続けましょう。';
    },
    conversationContinuationProvider: async () => {
      order.push('continuation');
      return 'true';
    },
    stageMoveAgreementProvider: async ({ prompt, currentConversation }) => {
      order.push('stage1');
      stage1Prompt = prompt;
      assert.deepEqual(currentConversation.map((message) => message.content), [
        '最近の発言1',
        '最近の返答1',
        '最近の発言2',
        '最近の返答2',
        '図書館の話はまた今度にしよう',
        '……はい。では薬草園の確認を続けましょう。'
      ]);
      assert.doesNotMatch(prompt, /古い発言1/);
      assert.doesNotMatch(prompt, /古い返答2/);
      assert.match(prompt, /最近の発言1/);
      assert.match(prompt, /図書館の話はまた今度にしよう/);
      assert.doesNotMatch(prompt, /大図書館の閲覧ホール: library_reading_room/);
      assert.doesNotMatch(prompt, /移動可能な移動先の名称とlocation_idの対応表/);
      return 'false';
    },
    stageMoveDestinationProvider: async () => {
      throw new Error('Stage2 should not run when Stage1 is false');
    },
    workRecordRecallProvider: async () => {
      order.push('recall');
      return { work_record_ids: [] };
    }
  });

  assert.deepEqual(order, ['chat', 'continuation', 'stage1']);
  assert.match(stage1Prompt.trim().split('\n').at(-1), /場所移動の合意が形成されたか/);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
  assert.equal(result.state.current_location_id, 'herbology_garden');
});

test('runConversationTurn runs Stage2 only after Stage1 and leaves state unchanged when Stage2 returns none', async () => {
  const root = await fixtureRoot();
  const order = [];
  let destinationPrompt = '';

  const result = await runConversationTurn({
    root,
    id: 'conv_stage_move_none_001',
    characterId: 'lina',
    playerInput: '図書館に行く話、まだ曖昧だったね',
    now: '2026-05-05T06:09:00.000+09:00',
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => {
      order.push('chat');
      return '……そうですね。今はまだ薬草園に残りましょう。';
    },
    conversationContinuationProvider: async () => {
      order.push('continuation');
      return 'true';
    },
    stageMoveAgreementProvider: async () => {
      order.push('stage1');
      return 'true';
    },
    stageMoveDestinationProvider: async ({ prompt, destinations }) => {
      order.push('stage2');
      destinationPrompt = prompt;
      assert.equal(destinations.some((destination) => destination.location_id === 'herbology_garden'), false);
      assert.equal(destinations.some((destination) => destination.location_id === 'library_reading_room'), true);
      return 'none';
    },
    stageMoveCutoffProvider: async () => {
      throw new Error('move cutoff should not run when Stage2 returns none');
    },
    stageMoveOpeningProvider: async () => {
      throw new Error('move opening should not run when Stage2 returns none');
    },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.deepEqual(order, ['chat', 'continuation', 'stage1', 'stage2']);
  assert.match(destinationPrompt, /返答は対応表にあるlocation_idを1つだけ返す/);
  assert.match(destinationPrompt, /大図書館の閲覧ホール: library_reading_room/);
  assert.doesNotMatch(destinationPrompt, /薬草園: herbology_garden/);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
  assert.equal(result.state.current_location_id, 'herbology_garden');
});

test('runConversationTurn applies an in-session stage move with cutoff, structured result, state update, and moved-context opening prompt', async () => {
  const root = await fixtureRoot();
  const locations = await readJson(root, 'game_data/locations.json');
  const library = locations.find((location) => location.id === 'library_reading_room');
  const order = [];
  let openingPrompt = '';
  const assistantCompletes = [];

  const result = await runConversationTurn({
    root,
    id: 'conv_stage_move_apply_001',
    characterId: 'lina',
    playerInput: '大図書館の閲覧ホールへ一緒に行こう',
    now: '2026-05-05T06:10:00.000+09:00',
    emotionProvider: async () => ({ expression: 'joy' }),
    chatProvider: async () => {
      order.push('chat');
      return '……はい。閲覧ホールなら、古い薬草事典も確認できます。';
    },
    conversationContinuationProvider: async () => {
      order.push('continuation');
      return 'true';
    },
    stageMoveAgreementProvider: async () => {
      order.push('stage1');
      return 'true';
    },
    stageMoveDestinationProvider: async () => {
      order.push('stage2');
      return 'library_reading_room';
    },
    stageMoveLocationSituationRandom: () => 0,
    stageMoveCutoffProvider: async ({ prompt, generatedAssistantText }) => {
      order.push('move_cutoff');
      assert.equal(generatedAssistantText, '……はい。閲覧ホールなら、古い薬草事典も確認できます。');
      assert.match(prompt, /移動して場面を移すための発言/);
      return 'では、閲覧ホールへ移りましょう。（持っていた薬草メモを閉じる）';
    },
    stageMoveOpeningProvider: async ({ prompt, currentConversation, location }) => {
      order.push('move_opening');
      openingPrompt = prompt;
      assert.equal(location.location_id, 'library_reading_room');
      assert.deepEqual(currentConversation.map((message) => message.content), [
        '大図書館の閲覧ホールへ一緒に行こう',
        '……はい。閲覧ホールなら、古い薬草事典も確認できます。',
        'では、閲覧ホールへ移りましょう。（持っていた薬草メモを閉じる）',
        `舞台は${library.display_name}へ移った。${library.visible_situation}`,
        'この先に続く自然な発話を生成する。'
      ]);
      return '閲覧ホールに着きました。まずこの棚の分類から見てみましょう。';
    },
    onAssistantComplete: ({ content }) => {
      assistantCompletes.push(content);
    }
  });

  assert.deepEqual(order, ['chat', 'continuation', 'stage1', 'stage2', 'move_cutoff', 'move_opening']);
  assert.deepEqual(assistantCompletes, [
    '……はい。閲覧ホールなら、古い薬草事典も確認できます。',
    'では、閲覧ホールへ移りましょう。（持っていた薬草メモを閉じる）'
  ]);
  const promptOrder = [
    openingPrompt.indexOf('プレイヤー: 大図書館の閲覧ホールへ一緒に行こう'),
    openingPrompt.indexOf('リナ・クラウゼ: ……はい。閲覧ホールなら、古い薬草事典も確認できます。'),
    openingPrompt.indexOf('リナ・クラウゼ: では、閲覧ホールへ移りましょう。'),
    openingPrompt.indexOf(`システム: 舞台は${library.display_name}へ移った。${library.visible_situation}`),
    openingPrompt.indexOf('システム: この先に続く自然な発話を生成する。')
  ];
  assert.equal(promptOrder.every((index) => index >= 0), true);
  assert.deepEqual([...promptOrder].sort((a, b) => a - b), promptOrder);
  assert.match(openingPrompt, new RegExp(`舞台: ${library.display_name}`));
  assert.match(openingPrompt, /現在の場面に自然に続く返答だけを書く/);

  assert.deepEqual(result.conversation.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'system', 'system', 'assistant']);
  assert.equal(result.conversation.messages.at(-1).content, '閲覧ホールに着きました。まずこの棚の分類から見てみましょう。');
  assert.equal(result.conversation.location_id, 'library_reading_room');
  assert.deepEqual(result.stage_move, {
    to_location_id: 'library_reading_room',
    to_location_name: library.display_name,
    to_visible_situation: library.visible_situation,
    cutoff_assistant_text: 'では、閲覧ホールへ移りましょう。（持っていた薬草メモを閉じる）',
    narration: `舞台は${library.display_name}へ移った。${library.visible_situation}`,
    next_assistant_message: {
      role: 'assistant',
      content: '閲覧ホールに着きました。まずこの棚の分類から見てみましょう。',
      expression: 'joy',
      face_emotion_variant_id: 'face_joy'
    }
  });
  assert.equal(result.state.current_location_id, 'library_reading_room');
  assert.equal(result.state.current_location_visible_situation, library.visible_situation);

  const persistedState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(persistedState.current_location_id, 'library_reading_room');
  assert.equal(persistedState.current_location_visible_situation, library.visible_situation);
});

test('runConversationTurn selects in-session stage move visible situation from variants with injected RNG', async () => {
  async function runMoveWithVariantIndex({ id, variantIndex }) {
    const root = await fixtureRoot();
    const locations = await readJson(root, 'game_data/locations.json');
    const library = locations.find((location) => location.id === 'library_reading_room');
    const variants = Array.from(new Set([
      library.visible_situation,
      ...(library.visible_situation_variants ?? []),
      ...(library.description_variants ?? [])
    ].map((value) => String(value ?? '').trim()).filter(Boolean)));
    const randomValue = (variantIndex + 0.1) / variants.length;
    let openingPrompt = '';

    const result = await runConversationTurn({
      root,
      id,
      characterId: 'lina',
      playerInput: '大図書館の閲覧ホールへ一緒に行こう',
      now: '2026-05-05T06:10:00.000+09:00',
      stageMoveLocationSituationRandom: () => randomValue,
      emotionProvider: async () => ({ expression: 'joy' }),
      chatProvider: async () => '……はい。閲覧ホールなら、古い薬草事典も確認できます。',
      conversationContinuationProvider: async () => 'true',
      stageMoveAgreementProvider: async () => 'true',
      stageMoveDestinationProvider: async () => 'library_reading_room',
      stageMoveCutoffProvider: async () => 'では、閲覧ホールへ移りましょう。',
      stageMoveOpeningProvider: async ({ prompt }) => {
        openingPrompt = prompt;
        return '閲覧ホールに着きました。まずこの棚の分類から見てみましょう。';
      },
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    });

    return {
      library,
      variants,
      result,
      openingPrompt,
      persistedState: await readJson(root, 'game_data/runtime_state.json')
    };
  }

  const canonical = await runMoveWithVariantIndex({ id: 'conv_stage_move_random_001', variantIndex: 0 });
  const alternate = await runMoveWithVariantIndex({ id: 'conv_stage_move_random_002', variantIndex: 1 });
  const alternateRepeat = await runMoveWithVariantIndex({ id: 'conv_stage_move_random_003', variantIndex: 1 });
  const expectedAlternate = canonical.variants[1];

  assert.notEqual(expectedAlternate, canonical.variants[0]);
  assert.equal(canonical.result.stage_move.to_visible_situation, canonical.variants[0]);
  assert.equal(alternate.result.stage_move.to_visible_situation, expectedAlternate);
  assert.equal(alternateRepeat.result.stage_move.to_visible_situation, expectedAlternate);
  assert.equal(alternate.result.state.current_location_visible_situation, expectedAlternate);
  assert.equal(alternate.persistedState.current_location_visible_situation, expectedAlternate);
  assert.equal(
    alternate.result.stage_move.narration,
    `舞台は${alternate.library.display_name}へ移った。${expectedAlternate}`
  );
  assert.equal(
    alternate.result.conversation.messages.find((message) => message.role === 'system')?.content,
    `舞台は${alternate.library.display_name}へ移った。${expectedAlternate}`
  );
  assert.ok(alternate.openingPrompt.includes(`見えている状況: ${expectedAlternate}`));
});

test('finalizeConversation asks for a numeric money delta after conversation and applies it to player inventory', async () => {
  const root = await fixtureRoot();
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [] }, null, 2), 'utf8');
  await runConversationTurn({
    root,
    id: 'conv_money_delta_001',
    characterId: 'lina',
    playerInput: 'この銀葉を30マナで譲るよ',
    now: '2026-05-05T06:20:00.000+09:00',
    chatProvider: async () => '助かります。では30マナを渡します。'
  });

  let moneyPrompt = '';
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_money_delta_001',
    characterId: 'lina',
    now: '2026-05-05T06:21:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    moneyDeltaProvider: async ({ prompt, conversation, currentMoney }) => {
      moneyPrompt = prompt;
      assert.equal(conversation.id, 'conv_money_delta_001');
      assert.equal(currentMoney, 120);
      assert.match(prompt, /会話前後で増減したユーザーの所持金/);
      assert.match(prompt, /数値のみ/);
      assert.match(prompt, /この銀葉を30マナで譲るよ/);
      assert.doesNotMatch(prompt, /会話全文をそのまま別用途へ転載しない/);
      assert.doesNotMatch(prompt, /memory、skill\/self_change、work_record、舞台フラグ、所持金判定は別々に扱われる/);
      assert.doesNotMatch(prompt, /現在のユーザー所持金:/);
      const expectedEvidence = JSON.stringify({
        conversation_id: 'conv_money_delta_001',
        character_id: 'lina',
        character_name: 'リナ・クラウゼ',
        work_record_id: 'wr_conv_money_delta_001',
        source_type: 'field',
        location_id: 'herbology_garden',
        time_slot: 'after_school',
        messages: [
          { role: 'user', content: 'この銀葉を30マナで譲るよ' },
          { role: 'assistant', content: '助かります。では30マナを渡します。', expression: 'neutral', face_emotion_variant_id: 'face_neutral' }
        ]
      }, null, 2);
      assert.equal(prompt.split('\n\n').slice(0, 2).join('\n\n'), [
        '次の会話セッションだけを根拠に、会話終了後の処理を1つ実行する。',
        '根拠はここに示す会話セッションだけ。',
        '',
        expectedEvidence
      ].join('\n'));
      return '30';
    }
  });

  assert.match(moneyPrompt, /30マナを渡します/);
  assert.equal(finalized.money_update.delta, 30);
  assert.equal(finalized.money_update.before_money, 120);
  assert.equal(finalized.money_update.after_money, 150);
  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.money, 150);
  const moneyLog = await readJson(root, 'game_data/logs/money_updates/conv_money_delta_001.json');
  assert.equal(moneyLog.delta, 30);
  assert.equal(moneyLog.raw_answer, '30');
});


test('finalizeConversation does not apply the same money delta twice when retried after a later failure', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  await fs.writeFile(path.join(root, 'game_data/player_inventory.json'), JSON.stringify({ money: 120, items: [] }, null, 2), 'utf8');
  await runConversationTurn({
    root,
    id: 'conv_money_retry_001',
    characterId: 'character_001',
    playerInput: 'この銀葉を30マナで譲るよ',
    now: '2026-05-05T06:22:00.000+09:00',
    chatProvider: async () => '助かります。では30マナを渡します。'
  });

  await assert.rejects(
    finalizeConversation({
      root,
      conversationId: 'conv_money_retry_001',
      characterId: 'character_001',
      now: '2026-05-05T06:23:00.000+09:00',
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      moneyDeltaProvider: async () => '30',
      buddyAgreementProvider: async () => {
        throw new Error('buddy_update_failed_after_money');
      }
    }),
    /buddy_update_failed_after_money/
  );

  const inventoryAfterFailure = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventoryAfterFailure.money, 150);

  const retried = await finalizeConversation({
    root,
    conversationId: 'conv_money_retry_001',
    characterId: 'character_001',
    now: '2026-05-05T06:24:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    moneyDeltaProvider: async () => '30',
    buddyAgreementProvider: async () => 'false'
  });

  assert.equal(retried.money_update.delta, 30);
  assert.equal(retried.money_update.before_money, 120);
  assert.equal(retried.money_update.after_money, 150);
  assert.equal(retried.money_update.already_applied, true);
  const inventoryAfterRetry = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventoryAfterRetry.money, 150);
  const moneyLog = await readJson(root, 'game_data/logs/money_updates/conv_money_retry_001.json');
  assert.equal(moneyLog.after_money, 150);
  assert.equal(moneyLog.already_applied, true);
});


test('finalizeConversation authors a roster character MP reserve line from the conversation and persists it (current line fed as context)', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  await runConversationTurn({
    root,
    id: 'conv_mp_reserve_001',
    characterId: 'character_001',
    playerInput: 'ダンジオンではMPを半分くらい残して、無理はしないで。',
    now: '2026-05-05T07:00:00.000+09:00',
    chatProvider: async () => '……分かりました。余力は残しておきます。'
  });

  let mpReservePrompt = '';
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_mp_reserve_001',
    characterId: 'character_001',
    now: '2026-05-05T07:01:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    mpReserveProvider: async ({ prompt, characterId, currentReservePercent }) => {
      mpReservePrompt = prompt;
      assert.equal(characterId, 'character_001');
      assert.equal(currentReservePercent, 30); // absent surface → initial line, fed to the judgment as context
      return '50';
    }
  });

  assert.match(mpReservePrompt, /MP温存ライン/);
  assert.match(mpReservePrompt, /現在設定しているMP温存ラインは 30 %/);
  assert.equal(finalized.mp_reserve_update.skipped, undefined);
  assert.equal(finalized.mp_reserve_update.before_percent, 30);
  assert.equal(finalized.mp_reserve_update.after_percent, 50);
  assert.equal(finalized.mp_reserve_update.raw_answer, '50');

  const surface = await readJson(root, 'game_data/mp_reserve.json');
  assert.equal(surface.reserves.character_001, 50);
  const log = await readJson(root, 'game_data/logs/mp_reserve_updates/conv_mp_reserve_001.json');
  assert.equal(log.character_id, 'character_001');
  assert.equal(log.before_percent, 30);
  assert.equal(log.after_percent, 50);

  // A later conversation reads the stored line as its context and overwrites it.
  await runConversationTurn({
    root,
    id: 'conv_mp_reserve_002',
    characterId: 'character_001',
    playerInput: 'やっぱりMPは出し惜しみせず攻めていいよ。',
    now: '2026-05-05T08:00:00.000+09:00',
    chatProvider: async () => '……了解です。攻めます。'
  });
  let secondContext = null;
  await finalizeConversation({
    root,
    conversationId: 'conv_mp_reserve_002',
    characterId: 'character_001',
    now: '2026-05-05T08:01:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    mpReserveProvider: async ({ currentReservePercent }) => {
      secondContext = currentReservePercent;
      return '10';
    }
  });
  assert.equal(secondContext, 50); // the previously authored line is the new context
  assert.equal((await readJson(root, 'game_data/mp_reserve.json')).reserves.character_001, 10);
});

test('finalizeConversation fails fast on a non-integer / out-of-range MP reserve answer (never silently keeps the old line)', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  await runConversationTurn({
    root,
    id: 'conv_mp_reserve_bad_001',
    characterId: 'character_001',
    playerInput: 'どれくらい温存する？',
    now: '2026-05-05T07:10:00.000+09:00',
    chatProvider: async () => '……そうですね。'
  });

  await assert.rejects(
    finalizeConversation({
      root,
      conversationId: 'conv_mp_reserve_bad_001',
      characterId: 'character_001',
      now: '2026-05-05T07:11:00.000+09:00',
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      mpReserveProvider: async () => '150' // out of the 0..100 range
    }),
    /mp reserve answer must be an integer/
  );
  // The bad answer never became a stored line (the throw is before setMpReservePercent).
  await assert.rejects(readJson(root, 'game_data/mp_reserve.json'), { code: 'ENOENT' });
});


test('finalizeConversation judges mutual buddy agreement after conversation and persists the character buddy flag', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  await runConversationTurn({
    root,
    id: 'conv_buddy_agreement_001',
    characterId: 'character_001',
    playerInput: 'これからは二人でバディになろう。いい？',
    now: '2026-05-05T06:30:00.000+09:00',
    chatProvider: async () => '……はい。セラも、あなたとバディになります。'
  });

  let buddyPrompt = '';
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_buddy_agreement_001',
    characterId: 'character_001',
    now: '2026-05-05T06:31:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async ({ prompt, conversation, characterId, characterName }) => {
      buddyPrompt = prompt;
      assert.equal(conversation.id, 'conv_buddy_agreement_001');
      assert.equal(characterId, 'character_001');
      assert.equal(characterName, 'セラ・アストルーペ');
      assert.match(prompt, /バディになる合意が相互に成立したか/);
      assert.match(prompt, /回答はtrueもしくはfalseのみ/);
      assert.match(prompt, /二人でバディになろう/);
      assert.match(prompt, /セラも、あなたとバディになります/);
      assert.doesNotMatch(prompt, /現在のバディ状態:/);
      const expectedEvidence = JSON.stringify({
        conversation_id: 'conv_buddy_agreement_001',
        character_id: 'character_001',
        character_name: 'セラ・アストルーペ',
        work_record_id: 'wr_conv_buddy_agreement_001',
        source_type: 'field',
        location_id: 'herbology_garden',
        time_slot: 'after_school',
        messages: [
          { role: 'user', content: 'これからは二人でバディになろう。いい？' },
          { role: 'assistant', content: '……はい。セラも、あなたとバディになります。', expression: 'neutral', face_emotion_variant_id: 'face_neutral' }
        ]
      }, null, 2);
      assert.equal(prompt.split('\n\n').slice(0, 2).join('\n\n'), [
        '次の会話セッションだけを根拠に、会話終了後の処理を1つ実行する。',
        '根拠はここに示す会話セッションだけ。',
        '',
        expectedEvidence
      ].join('\n'));
      return 'true';
    }
  });

  assert.match(buddyPrompt, /バディになる合意/);
  assert.equal(finalized.buddy_update.established, true);
  assert.equal(finalized.buddy_update.flag, 'relationship.character_001.buddy');
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.buddy'], true);
  const characterFlags = await readJson(root, 'game_data/characters/character_001/flags.json');
  assert.equal(characterFlags['relationship.character_001.buddy'], true);
  const buddyLog = await readJson(root, 'game_data/logs/buddy_updates/conv_buddy_agreement_001.json');
  assert.equal(buddyLog.established, true);
  assert.equal(buddyLog.raw_answer, 'true');
});


test('finalizeConversation registers multiple enemies from conversation-end hostility judgment', async () => {
  const root = await fixtureRoot();
  const statePath = path.join(root, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.current_enemy_character_ids = ['character_001'];
  state.characters ??= {};
  state.characters.character_001 = { flags: { 'relationship.character_001.enemy': true } };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));

  await seedSelectableConversationActor(root, 'character_002');
  await runConversationTurn({
    root,
    id: 'conv_enemy_001',
    characterId: 'character_002',
    playerInput: 'もうお前とは敵同士だ。次は容赦しない。',
    now: '2026-05-05T06:35:00.000+09:00',
    chatProvider: async () => '……分かった。私も、あなたを敵として扱う。'
  });

  let enemyPrompt = '';
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_enemy_001',
    characterId: 'character_002',
    now: '2026-05-05T06:36:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    enemyHostilityProvider: async ({ prompt, characterId, characterName }) => {
      enemyPrompt = prompt;
      assert.equal(characterId, 'character_002');
      assert.equal(characterName, 'ノノカ・コッパーリム');
      assert.match(prompt, /敵対関係が相互に成立したか/);
      assert.match(prompt, /回答はtrueもしくはfalseのみ/);
      assert.match(prompt, /敵同士/);
      return 'true';
    }
  });

  assert.match(enemyPrompt, /敵対関係/);
  assert.equal(finalized.enemy_update.established, true);
  assert.equal(finalized.enemy_update.flag, 'relationship.character_002.enemy');
  assert.deepEqual(finalized.state.current_enemy_character_ids, ['character_001', 'character_002']);
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.enemy'], true);
  assert.equal(finalized.state.characters.character_002.flags['relationship.character_002.enemy'], true);
  const enemyLog = await readJson(root, 'game_data/logs/enemy_updates/conv_enemy_001.json');
  assert.equal(enemyLog.established, true);
  assert.equal(enemyLog.raw_answer, 'true');
});


test('finalizeConversation preserves an existing current buddy when the same character does not form a new buddy agreement', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  const statePath = path.join(root, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.current_buddy_character_id = 'character_001';
  state.characters ??= {};
  state.characters.character_001 = { flags: { 'relationship.character_001.buddy': true } };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));

  await runConversationTurn({
    root,
    id: 'conv_buddy_preserve_false_001',
    characterId: 'character_001',
    playerInput: '今日は普通に話そう。',
    now: '2026-05-05T06:37:00.000+09:00',
    chatProvider: async () => 'はい。いつものように話しましょう。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_buddy_preserve_false_001',
    characterId: 'character_001',
    now: '2026-05-05T06:38:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => 'false'
  });

  assert.equal(finalized.buddy_update.established, false);
  assert.equal(finalized.state.current_buddy_character_id, 'character_001');
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.buddy'], true);
  const characterFlags = await readJson(root, 'game_data/characters/character_001/flags.json');
  assert.equal(characterFlags['relationship.character_001.buddy'], true);
});


test('finalizeConversation preserves existing enemies when hostility judgment is false', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  const statePath = path.join(root, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.current_enemy_character_ids = ['character_001'];
  state.characters ??= {};
  state.characters.character_001 = { flags: { 'relationship.character_001.enemy': true } };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));

  await runConversationTurn({
    root,
    id: 'conv_enemy_preserve_false_001',
    characterId: 'character_001',
    playerInput: '今日は敵対するつもりはない。',
    now: '2026-05-05T06:38:00.000+09:00',
    chatProvider: async () => '……分かりました。今は争いません。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_enemy_preserve_false_001',
    characterId: 'character_001',
    now: '2026-05-05T06:39:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    enemyHostilityProvider: async () => 'false'
  });

  assert.equal(finalized.enemy_update.established, false);
  assert.deepEqual(finalized.state.current_enemy_character_ids, ['character_001']);
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.enemy'], true);
  const characterFlags = await readJson(root, 'game_data/characters/character_001/flags.json');
  assert.equal(characterFlags['relationship.character_001.enemy'], true);
});


test('finalizeConversation keeps only one current buddy when a new mutual buddy agreement is established', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_002');
  const statePath = path.join(root, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.current_buddy_character_id = 'character_001';
  state.characters ??= {};
  state.characters.character_001 = { flags: { 'relationship.character_001.buddy': true } };
  state.characters.character_002 = { flags: { 'relationship.character_002.buddy': true } };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  for (const characterId of ['character_001', 'character_002']) {
    const dir = path.join(root, `game_data/characters/${characterId}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'flags.json'), JSON.stringify({
      [`relationship.${characterId}.buddy`]: true
    }, null, 2));
  }

  await runConversationTurn({
    root,
    id: 'conv_single_buddy_001',
    characterId: 'character_002',
    playerInput: '今日から正式にバディになろう。',
    now: '2026-05-05T06:40:00.000+09:00',
    chatProvider: async () => 'うん。私があなたのバディになる。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_single_buddy_001',
    characterId: 'character_002',
    now: '2026-05-05T06:41:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => 'true'
  });

  assert.equal(finalized.state.current_buddy_character_id, 'character_002');
  assert.equal(finalized.state.characters.character_002.flags['relationship.character_002.buddy'], true);
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.buddy'], undefined);
  const newBuddyFlags = await readJson(root, 'game_data/characters/character_002/flags.json');
  const previousBuddyFlags = await readJson(root, 'game_data/characters/character_001/flags.json');
  assert.equal(newBuddyFlags['relationship.character_002.buddy'], true);
  assert.equal(previousBuddyFlags['relationship.character_001.buddy'], undefined);
});

test('finalizeConversation clears a homunculus buddy when an academy character forms a new buddy agreement (roster-crossing)', async () => {
  const root = await fixtureRoot();
  await seedSelectableConversationActor(root, 'character_001');
  const statePath = path.join(root, 'game_data/runtime_state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.current_buddy_character_id = 'homunculus_001';
  state.homunculi ??= {};
  state.homunculi.homunculus_001 = { flags: { 'relationship.homunculus_001.buddy': true } };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  const homunculusDir = path.join(root, 'game_data/homunculi/homunculus_001');
  await fs.mkdir(homunculusDir, { recursive: true });
  await fs.writeFile(path.join(homunculusDir, 'flags.json'), JSON.stringify({
    character_id: 'homunculus_001',
    flags: { 'relationship.homunculus_001.buddy': true }
  }, null, 2));

  await runConversationTurn({
    root,
    id: 'conv_cross_char_buddy_001',
    characterId: 'character_001',
    playerInput: '今日からきみとバディになりたい。',
    now: '2026-05-05T06:42:00.000+09:00',
    chatProvider: async () => 'はい。セラは、あなたのバディになります。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_cross_char_buddy_001',
    characterId: 'character_001',
    now: '2026-05-05T06:43:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => 'true'
  });

  assert.equal(finalized.buddy_update.established, true);
  assert.equal(finalized.state.current_buddy_character_id, 'character_001');
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.buddy'], true);
  // the previous homunculus buddy flag is cleared in state and in its actor flags file
  assert.equal(finalized.state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], undefined);
  const homunculusFlags = await readJson(root, 'game_data/homunculi/homunculus_001/flags.json');
  assert.equal(homunculusFlags['relationship.homunculus_001.buddy'], undefined);
});

test('finalizeConversation judges affinity delta from the shared finalization prompt and starts missing character affinity at 25', async () => {
  const root = await fixtureRoot();
  await runConversationTurn({
    root,
    id: 'conv_affinity_delta_001',
    characterId: 'lina',
    playerInput: '今日は話せてよかった。君の観察を信じるよ。',
    now: '2026-05-05T06:45:00.000+09:00',
    chatProvider: async () => 'ありがとうございます。その言葉は、きっと覚えておきます。'
  });

  let affinityPrompt = '';
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_affinity_delta_001',
    characterId: 'lina',
    now: '2026-05-05T06:46:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false',
    affinityDeltaProvider: async ({ prompt, conversation, characterId, characterName }) => {
      affinityPrompt = prompt;
      assert.equal(conversation.id, 'conv_affinity_delta_001');
      assert.equal(characterId, 'lina');
      assert.equal(characterName, 'リナ・クラウゼ');
      assert.match(prompt, /好感度の変化量を判定する/);
      assert.match(prompt, /回答は−10〜\+10 の整数のみを出力する/);
      assert.match(prompt, /説明・単位・JSON・Markdown・ラベル禁止/);
      assert.match(prompt, /10=距離が決定的に縮まる出来事があった／\+5=心に残る良い会話／\+1〜3=感じの良い会話／0=特筆なし／−1〜3=引っかかり／−5=明確な不快／−10=決定的な失望・裏切り/);
      assert.match(prompt, /君の観察を信じるよ/);
      return '+3';
    }
  });

  assert.match(affinityPrompt, /次の会話セッションだけを根拠に/);
  assert.equal(finalized.affinity_update.conversation_delta, 3);
  assert.equal(finalized.affinity_update.buddy_delta, 0);
  assert.equal(finalized.affinity_update.enemy_delta, 0);
  assert.equal(finalized.affinity_update.total_delta, 3);
  assert.equal(finalized.affinity_update.before_affinity, 25);
  assert.equal(finalized.affinity_update.after_affinity, 28);
  assert.equal(finalized.affinity_update.already_applied, false);

  const affinity = await readJson(root, 'game_data/characters/lina/affinity.json');
  assert.deepEqual(affinity, {
    character_id: 'lina',
    affinity: 28,
    applied_affinity_conversation_ids: ['conv_affinity_delta_001']
  });
  const affinityLog = await readJson(root, 'game_data/logs/affinity_updates/conv_affinity_delta_001.json');
  assert.equal(affinityLog.raw_answer, '+3');
  assert.equal(affinityLog.before_affinity, 25);
  assert.equal(affinityLog.after_affinity, 28);
  assert.equal(affinityLog.prompt, affinityPrompt);
});

test('finalizeConversation requires an affinity delta provider for academy characters', async () => {
  const root = await fixtureRoot();
  await runConversationTurn({
    root,
    id: 'conv_affinity_missing_provider_001',
    characterId: 'lina',
    playerInput: '好感度判定 provider の必須化を確認する。',
    now: '2026-05-05T06:46:10.000+09:00',
    chatProvider: async () => '確認します。'
  });

  await assert.rejects(
    finalizeConversationCore({
      root,
      conversationId: 'conv_affinity_missing_provider_001',
      characterId: 'lina',
      now: '2026-05-05T06:46:20.000+09:00',
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      buddyAgreementProvider: async () => 'false',
      enemyHostilityProvider: async () => 'false'
    }),
    /affinityDeltaProvider is required/
  );
});

test('finalizeConversation persists affinity for a numbered academy character through the dialogue actor resolver', async () => {
  const root = await fixtureRoot();
  const characterId = 'character_007';
  await fs.mkdir(path.join(root, `game_data/characters/${characterId}/memory`), { recursive: true });
  await fs.mkdir(path.join(root, `game_data/characters/${characterId}/work_records`), { recursive: true });
  await fs.writeFile(path.join(root, `game_data/characters/${characterId}/flags.json`), JSON.stringify({
    character_id: characterId,
    flags: {}
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, `game_data/characters/${characterId}/skills.json`), JSON.stringify({
    character_id: characterId,
    skills: []
  }, null, 2), 'utf8');

  await runConversationTurn({
    root,
    id: 'conv_affinity_character_007_001',
    characterId,
    playerInput: '今日は助かったよ。',
    now: '2026-05-05T06:46:30.000+09:00',
    chatProvider: async () => 'こちらこそ。次も力になります。'
  });

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_affinity_character_007_001',
    characterId,
    now: '2026-05-05T06:46:40.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false',
    affinityDeltaProvider: async () => '2'
  });

  assert.equal(finalized.affinity_update.character_id, characterId);
  assert.equal(finalized.affinity_update.before_affinity, 25);
  assert.equal(finalized.affinity_update.after_affinity, 27);
  const affinity = await readJson(root, `game_data/characters/${characterId}/affinity.json`);
  assert.deepEqual(affinity, {
    character_id: characterId,
    affinity: 27,
    applied_affinity_conversation_ids: ['conv_affinity_character_007_001']
  });
});

test('finalizeConversation applies buddy and enemy fixed affinity deltas independently and clamps both bounds', async () => {
  async function finalizeWithAffinity({ id, initialAffinity, conversationDelta, buddyAnswer, enemyAnswer }) {
    const root = await fixtureRoot();
    await seedSelectableConversationActor(root, 'character_001');
    await fs.writeFile(path.join(root, 'game_data/characters/character_001/affinity.json'), JSON.stringify({
      character_id: 'character_001',
      affinity: initialAffinity,
      applied_affinity_conversation_ids: []
    }, null, 2), 'utf8');
    await runConversationTurn({
      root,
      id,
      characterId: 'character_001',
      playerInput: 'この会話で関係が大きく動いた。',
      now: '2026-05-05T06:47:00.000+09:00',
      chatProvider: async () => 'はい。関係は、確かに変わりました。'
    });

    return await finalizeConversation({
      root,
      conversationId: id,
      characterId: 'character_001',
      now: '2026-05-05T06:48:00.000+09:00',
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      buddyAgreementProvider: async () => buddyAnswer,
      enemyHostilityProvider: async () => enemyAnswer,
      affinityDeltaProvider: async () => String(conversationDelta)
    });
  }

  const upper = await finalizeWithAffinity({
    id: 'conv_affinity_upper_clamp_001',
    initialAffinity: 95,
    conversationDelta: 10,
    buddyAnswer: 'true',
    enemyAnswer: 'false'
  });
  assert.equal(upper.affinity_update.conversation_delta, 10);
  assert.equal(upper.affinity_update.buddy_delta, 10);
  assert.equal(upper.affinity_update.enemy_delta, 0);
  assert.equal(upper.affinity_update.total_delta, 20);
  assert.equal(upper.affinity_update.before_affinity, 95);
  assert.equal(upper.affinity_update.after_affinity, 100);

  const lower = await finalizeWithAffinity({
    id: 'conv_affinity_lower_clamp_001',
    initialAffinity: 5,
    conversationDelta: -10,
    buddyAnswer: 'false',
    enemyAnswer: 'true'
  });
  assert.equal(lower.affinity_update.conversation_delta, -10);
  assert.equal(lower.affinity_update.buddy_delta, 0);
  assert.equal(lower.affinity_update.enemy_delta, -10);
  assert.equal(lower.affinity_update.total_delta, -20);
  assert.equal(lower.affinity_update.before_affinity, 5);
  assert.equal(lower.affinity_update.after_affinity, 0);
});

test('finalizeConversation rejects invalid affinity delta answers instead of converting them to zero', async () => {
  for (const [index, answer] of ['', '1.5', '11', '-11', 'delta: 3'].entries()) {
    const root = await fixtureRoot();
    const id = `conv_affinity_invalid_${index}`;
    await runConversationTurn({
      root,
      id,
      characterId: 'lina',
      playerInput: '好感度判定の不正値を確認する。',
      now: '2026-05-05T06:49:00.000+09:00',
      chatProvider: async () => '確認します。'
    });

    await assert.rejects(
      finalizeConversation({
        root,
        conversationId: id,
        characterId: 'lina',
        now: '2026-05-05T06:50:00.000+09:00',
        skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
        buddyAgreementProvider: async () => 'false',
        enemyHostilityProvider: async () => 'false',
        affinityDeltaProvider: async () => answer
      }),
      /affinity delta answer must be an integer from -10 to 10/
    );
  }
});

test('finalizeConversation fails fast on malformed persisted affinity state', async () => {
  const malformedAffinityFiles = [
    [],
    { character_id: 'character_999', affinity: 25, applied_affinity_conversation_ids: [] },
    { character_id: 'lina', affinity: 25.5, applied_affinity_conversation_ids: [] },
    { character_id: 'lina', affinity: 25, applied_affinity_conversation_ids: ['conv_a', 'conv_a'] }
  ];

  for (const [index, affinityFile] of malformedAffinityFiles.entries()) {
    const root = await fixtureRoot();
    const id = `conv_affinity_malformed_${index}`;
    await runConversationTurn({
      root,
      id,
      characterId: 'lina',
      playerInput: '保存済み好感度の不正形式を確認する。',
      now: '2026-05-05T06:50:10.000+09:00',
      chatProvider: async () => '確認します。'
    });
    await fs.writeFile(path.join(root, 'game_data/characters/lina/affinity.json'), JSON.stringify(affinityFile, null, 2), 'utf8');

    await assert.rejects(
      finalizeConversation({
        root,
        conversationId: id,
        characterId: 'lina',
        now: '2026-05-05T06:50:20.000+09:00',
        skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
        buddyAgreementProvider: async () => 'false',
        enemyHostilityProvider: async () => 'false',
        affinityDeltaProvider: async () => '1'
      }),
      /invalid affinity state for lina/
    );
  }
});

test('finalizeConversation does not apply the same affinity update twice when retried after a later failure', async () => {
  const root = await fixtureRoot();
  await runConversationTurn({
    root,
    id: 'conv_affinity_retry_001',
    characterId: 'lina',
    playerInput: '今日は助けてくれてありがとう。',
    now: '2026-05-05T06:51:00.000+09:00',
    chatProvider: async () => 'こちらこそ、言ってくれてうれしいです。'
  });

  await assert.rejects(
    finalizeConversation({
      root,
      conversationId: 'conv_affinity_retry_001',
      characterId: 'lina',
      now: '2026-05-05T06:52:00.000+09:00',
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      buddyAgreementProvider: async () => 'false',
      enemyHostilityProvider: async () => 'false',
      affinityDeltaProvider: async () => '5',
      finalStateTransform: () => {
        throw new Error('failure_after_affinity_update');
      }
    }),
    /failure_after_affinity_update/
  );

  const afterFailure = await readJson(root, 'game_data/characters/lina/affinity.json');
  assert.equal(afterFailure.affinity, 30);
  assert.deepEqual(afterFailure.applied_affinity_conversation_ids, ['conv_affinity_retry_001']);

  const retried = await finalizeConversation({
    root,
    conversationId: 'conv_affinity_retry_001',
    characterId: 'lina',
    now: '2026-05-05T06:53:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false',
    affinityDeltaProvider: async () => '5'
  });

  assert.equal(retried.affinity_update.already_applied, true);
  assert.equal(retried.affinity_update.before_affinity, 25);
  assert.equal(retried.affinity_update.after_affinity, 30);
  const afterRetry = await readJson(root, 'game_data/characters/lina/affinity.json');
  assert.equal(afterRetry.affinity, 30);
  assert.deepEqual(afterRetry.applied_affinity_conversation_ids, ['conv_affinity_retry_001']);
});

test('creature finalization skips affinity judgment and does not create academy affinity state', async (t) => {
  const root = await creatureDialogueRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await startInteractionSession({ root, characterId: 'creature_001' });
  await runConversationOpening({
    root,
    id: 'conv_creature_affinity_001',
    characterId: 'creature_001',
    now: '2026-05-05T06:54:00.000+09:00',
    chatProvider: async () => '……灯は、ここにある。'
  });
  await runConversationTurn({
    root,
    id: 'conv_creature_affinity_001',
    characterId: 'creature_001',
    playerInput: '君の灯りはあたたかいね。',
    now: '2026-05-05T06:55:00.000+09:00',
    chatProvider: async () => '……少し、明るくなった。'
  });

  let affinityProviderCalled = false;
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_creature_affinity_001',
    characterId: 'creature_001',
    now: '2026-05-05T06:56:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    affinityDeltaProvider: async () => {
      affinityProviderCalled = true;
      return '10';
    }
  });

  assert.equal(affinityProviderCalled, false);
  assert.equal(finalized.affinity_update.skipped, true);
  assert.equal(finalized.affinity_update.reason, 'creature_actor');
  assert.equal(await exists(root, 'data/mutable/game_data/characters/creature_001/affinity.json'), false);
});


test('runConversationTurn offers all linked work-record candidates so later relevant memories can be recalled', async () => {
  const root = await fixtureRoot();
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });

  for (const index of [1, 2, 3, 4]) {
    const id = `wr_recall_candidate_${index}`;
    await fs.writeFile(path.join(memoryDir, `mem_recall_candidate_${index}.json`), JSON.stringify({
      id: `mem_recall_candidate_${index}`,
      character_id: 'lina',
      visibility: 'character_known',
      type: 'relationship_change',
      text: index === 4
        ? 'リナは主人公から「使い道がない」と言われた場面について、他にも重要な言葉があったことを覚えている。'
        : `リナは別件の記憶${index}を覚えている。`,
      work_record_id: id
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(workRecordDir, `${id}.md`), `# recall candidate ${index}\n\nID: ${id}\n\n## Summary\n\n${index === 4 ? '主人公は「使い道がない」と言った後、他にもセレナが思い出すべき条件を話していた。' : `別件の会話記録${index}。`}\n`, 'utf8');
  }

  let recallPrompt = '';
  let prewarmPrompt = '';
  const result = await runConversationTurn({
    root,
    id: 'conv_recall_candidate_001',
    characterId: 'lina',
    playerInput: '「使い道がない」と言った時、他のことも言ってたと思うんだけど思い出して',
    now: '2026-05-05T07:05:00.000+09:00',
    emotionProvider: async () => ({ expression: 'worried' }),
    chatProvider: async () => '記録を確認します。少々お待ちください。',
    workRecordRecallProvider: async ({ prompt, candidateWorkRecordIds }) => {
      recallPrompt = prompt;
      assert.deepEqual(candidateWorkRecordIds, [
        'wr_recall_candidate_1',
        'wr_recall_candidate_2',
        'wr_recall_candidate_3',
        'wr_recall_candidate_4'
      ]);
      assert.match(prompt, /指定できるwork_record_idは候補に含まれるIDだけ/);
      assert.match(prompt, /候補work_record_id: wr_recall_candidate_1, wr_recall_candidate_2, wr_recall_candidate_3, wr_recall_candidate_4/);
      return { work_record_ids: ['wr_recall_candidate_4'] };
    },
    promptPrewarmProvider: async ({ prompt, recalledWorkRecords }) => {
      prewarmPrompt = prompt;
      assert.deepEqual(recalledWorkRecords.map((record) => record.id), ['wr_recall_candidate_4']);
      return '「使い道がない」と言われた場面の詳細記録を接続する。';
    }
  });

  assert.match(recallPrompt, /出力形式: \{"work_record_ids":\["wr_recall_candidate_1"\]\}/);
  assert.deepEqual(result.conversation.work_record_recall.recalled_work_record_ids, ['wr_recall_candidate_4']);
  assert.match(prewarmPrompt, /# recall candidate 4/);
  assert.match(result.conversation.next_prompt_cache.prompt, /主人公は「使い道がない」と言った後/);
});


test('runConversationTurn lets the LLM request linked work records after a reply and prewarms the next shared prompt prefix', async () => {
  const root = await fixtureRoot();
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'mem_archival_key.json'), JSON.stringify({
    id: 'mem_archival_key',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'リナは主人公が古い封印札の違和感に気づいたことを覚えている。',
    work_record_id: 'wr_archival_key',
    tags: ['封印札', '古い記録']
  }, null, 2), 'utf8');
  for (const index of [1, 2, 3]) {
    await fs.writeFile(path.join(memoryDir, `mem_recall_newer_${index}.json`), JSON.stringify({
      id: `mem_recall_newer_${index}`,
      character_id: 'lina',
      visibility: 'character_known',
      type: 'relationship_change',
      text: `リナは別件の新しい出来事${index}を覚えている。`,
      tags: ['別件']
    }, null, 2), 'utf8');
  }
  await fs.writeFile(path.join(workRecordDir, 'wr_archival_key.md'), '# 古い封印札について話した\n\nID: wr_archival_key\n\n## Summary\n\n主人公は旧校舎の封印札に薄い擦れ跡があるとリナに伝えた。リナは擦れ跡が最近触れられた可能性を示すと考えた。\n', 'utf8');

  const providerOrder = [];
  let recallPrompt = '';
  let prewarmPrompt = '';
  const result = await runConversationTurn({
    root,
    id: 'conv_recall_001',
    characterId: 'lina',
    playerInput: '前に見た封印札の擦れ跡、今の話と関係ある？',
    now: '2026-05-05T07:00:00.000+09:00',
    emotionProvider: async () => ({ expression: 'serious' }),
    chatProvider: async () => {
      providerOrder.push('chat');
      return '……関係があるかもしれません。前に見た跡のことを、もう少し正確に思い出したいです。';
    },
    onAssistantComplete: ({ content, emotion }) => {
      providerOrder.push('assistant_complete');
      assert.equal(content, '……関係があるかもしれません。前に見た跡のことを、もう少し正確に思い出したいです。');
      assert.equal(emotion.expression, 'serious');
    },
    workRecordRecallProvider: async ({ prompt, candidateWorkRecordIds }) => {
      providerOrder.push('recall');
      recallPrompt = prompt;
      assert.deepEqual(candidateWorkRecordIds, ['wr_archival_key']);
      assert.match(prompt, /リナは主人公が古い封印札の違和感に気づいたことを覚えている。/);
      assert.match(prompt, /work_record_id: wr_archival_key/);
      assert.match(prompt, /より詳細化したい"この場で参照する記憶"があれば/);
      assert.match(prompt, /それと対応するwork_record_idを次の形式で指定する/);
      assert.match(prompt, /出力形式: \{"work_record_ids":\["wr_archival_key"\]\}/);
      assert.match(prompt, /指定できるwork_record_idは候補に含まれるIDだけ/);
      assert.match(prompt, /候補work_record_id: wr_archival_key/);
      assert.match(prompt, /詳細化したい"この場で参照する記憶"がなければ空配列を返す。/);
      assert.match(prompt, /リナ・クラウゼ: ……関係があるかもしれません。/);
      return { work_record_ids: ['wr_archival_key'] };
    },
    promptPrewarmProvider: async ({ prompt, recalledWorkRecords }) => {
      providerOrder.push('prewarm');
      prewarmPrompt = prompt;
      assert.deepEqual(recalledWorkRecords.map((record) => record.id), ['wr_archival_key']);
      assert.match(prompt, /# 古い封印札について話した/);
      assert.match(prompt, /薄い擦れ跡があるとリナに伝えた/);
      assert.match(prompt.trim().split('\n').at(-1), /次のプレイヤー発言に備えて/);
      return '封印札の擦れ跡を会話の直前文脈として保持する。';
    }
  });

  assert.deepEqual(providerOrder, ['chat', 'assistant_complete', 'recall', 'prewarm']);
  assert.equal(result.conversation.work_record_recall.recalled_work_record_ids[0], 'wr_archival_key');
  assert.equal(result.conversation.work_record_recall.prompt, recallPrompt);
  assert.deepEqual(result.conversation.work_record_recall.model_response, { work_record_ids: ['wr_archival_key'] });
  assert.equal(result.conversation.next_prompt_cache.prewarm_text, null);
  await waitFor(async () => {
    const storedConversation = await readJson(root, 'game_data/logs/conversations/conv_recall_001.json');
    assert.equal(storedConversation.next_prompt_cache.prewarm_text, '封印札の擦れ跡を会話の直前文脈として保持する。');
  });

  const retainedPrompts = [];
  for (let turn = 1; turn <= 11; turn += 1) {
    await runConversationTurn({
      root,
      characterId: 'lina',
      playerInput: turn === 1 ? 'じゃあ擦れ跡の場所をもう一度教えて' : `続きの確認 ${turn}`,
      now: `2026-05-05T07:${String(turn).padStart(2, '0')}:00.000+09:00`,
      workRecordRecallProvider: async () => ({ work_record_ids: [] }),
      promptPrewarmProvider: async () => {
        throw new Error('prewarm should not run when no new work record is recalled');
      },
      chatProvider: async ({ prompt }) => {
        retainedPrompts.push(prompt);
        return turn === 1
          ? '封印札の端です。前に見た薄い擦れ跡と同じ場所を確認しましょう。'
          : `続き ${turn} を確認しましょう。`;
      }
    });
  }
  assert.equal(retainedPrompts.length, 11);
  for (const prompt of retainedPrompts.slice(0, 10)) {
    assert.match(prompt, /# 古い封印札について話した/);
  }
  assert.doesNotMatch(retainedPrompts[10], /# 古い封印札について話した/);
  const retainedConversation = await readJson(root, 'game_data/logs/conversations/conv_recall_001.json');
  assert.deepEqual(retainedConversation.pending_recalled_work_records, []);
  assert.deepEqual(
    prewarmPrompt.trim().split('\n').slice(0, -1),
    result.conversation.next_prompt_cache.prompt.trim().split('\n').slice(0, -1)
  );
});

test('runConversationTurn returns the visible result before slow prompt prewarm resolves', async () => {
  const root = await fixtureRoot();
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'mem_slow_prewarm_key.json'), JSON.stringify({
    id: 'mem_slow_prewarm_key',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'リナは主人公が封印札の擦れ跡に気づいたことを覚えている。',
    work_record_id: 'wr_slow_prewarm_key'
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_slow_prewarm_key.md'), '# 封印札の擦れ跡\n\nID: wr_slow_prewarm_key\n\n## Summary\n\n主人公は旧校舎の封印札に薄い擦れ跡があるとリナに伝えた。\n', 'utf8');

  let markPrewarmStarted;
  let releasePrewarm;
  let prewarmResolved = false;
  const prewarmStarted = new Promise((resolve) => {
    markPrewarmStarted = resolve;
  });
  const prewarmRelease = new Promise((resolve) => {
    releasePrewarm = (value = '封印札の擦れ跡を次ターン用に接続する。') => {
      prewarmResolved = true;
      resolve(value);
    };
  });
  let turnReturned = false;

  const turnPromise = runConversationTurn({
    root,
    id: 'conv_slow_prewarm_001',
    characterId: 'lina',
    playerInput: '封印札の擦れ跡、今の話に関係ある？',
    now: '2026-05-05T07:15:00.000+09:00',
    emotionProvider: async () => ({ expression: 'serious' }),
    chatProvider: async () => '前に見た擦れ跡と関係があるかもしれません。',
    workRecordRecallProvider: async () => ({ work_record_ids: ['wr_slow_prewarm_key'] }),
    promptPrewarmProvider: async ({ recalledWorkRecords }) => {
      assert.deepEqual(recalledWorkRecords.map((record) => record.id), ['wr_slow_prewarm_key']);
      markPrewarmStarted();
      return prewarmRelease;
    }
  }).then((result) => {
    turnReturned = true;
    return result;
  });

  try {
    await withTimeout(prewarmStarted, 1500, 'prompt prewarm should start for recalled work records');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(turnReturned, true, 'visible result should be returned while prompt prewarm is still unresolved');
    const result = await turnPromise;
    assert.equal(prewarmResolved, false, 'test should observe the result before releasing prewarm');
    assert.deepEqual(result.conversation.pending_recalled_work_record_ids, ['wr_slow_prewarm_key']);
    assert.equal(result.conversation.next_prompt_cache.prewarm_text, null);
  } finally {
    if (!prewarmResolved) releasePrewarm();
    await turnPromise;
  }

  await waitFor(async () => {
    const storedConversation = await readJson(root, 'game_data/logs/conversations/conv_slow_prewarm_001.json');
    assert.equal(storedConversation.next_prompt_cache.prewarm_text, '封印札の擦れ跡を次ターン用に接続する。');
  });
});

test('runConversationTurn records prompt prewarm errors without failing the visible result', async () => {
  const root = await fixtureRoot();
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'mem_prewarm_error_key.json'), JSON.stringify({
    id: 'mem_prewarm_error_key',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'リナは主人公が封印札の擦れ跡を気にしていたことを覚えている。',
    work_record_id: 'wr_prewarm_error_key'
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_prewarm_error_key.md'), '# 封印札の擦れ跡\n\nID: wr_prewarm_error_key\n\n## Summary\n\n主人公は旧校舎の封印札に薄い擦れ跡があるとリナに伝えた。\n', 'utf8');

  const result = await runConversationTurn({
    root,
    id: 'conv_prewarm_error_001',
    characterId: 'lina',
    playerInput: '封印札の擦れ跡について、もう一度考えよう',
    now: '2026-05-05T07:20:00.000+09:00',
    emotionProvider: async () => ({ expression: 'serious' }),
    chatProvider: async () => '前の擦れ跡の話を覚えています。',
    workRecordRecallProvider: async () => ({ work_record_ids: ['wr_prewarm_error_key'] }),
    promptPrewarmProvider: async () => {
      throw new Error('prewarm transport failed');
    }
  });

  assert.equal(result.conversation.messages.at(-1).content, '前の擦れ跡の話を覚えています。');
  assert.deepEqual(result.conversation.pending_recalled_work_record_ids, ['wr_prewarm_error_key']);
  assert.equal(result.conversation.next_prompt_cache.prewarm_text, null);
  await waitFor(async () => {
    const errorLog = await readJson(root, 'game_data/logs/prompt_prewarm_errors/conv_prewarm_error_001.json');
    assert.equal(errorLog.conversation_id, 'conv_prewarm_error_001');
    assert.deepEqual(errorLog.recalled_work_record_ids, ['wr_prewarm_error_key']);
    assert.equal(errorLog.error.message, 'prewarm transport failed');
    const storedConversation = await readJson(root, 'game_data/logs/conversations/conv_prewarm_error_001.json');
    assert.equal(storedConversation.next_prompt_cache.prewarm_error.message, 'prewarm transport failed');
  });
});

test('conversation pipeline rejects conversation ids outside the allowed conv_* format before writing logs', async () => {
  const root = await fixtureRoot();
  let providerCalled = false;

  await assert.rejects(
    runConversationOpening({
      root,
      id: '../escape',
      characterId: 'lina',
      now: '2026-05-05T06:00:00.000+09:00',
      chatProvider: async () => {
        providerCalled = true;
        return 'should not run';
      }
    }),
    /conversation/i
  );
  assert.equal(providerCalled, false);

  await runConversationOpening({
    root,
    id: 'conv_safe_001',
    characterId: 'lina',
    now: '2026-05-05T06:01:00.000+09:00',
    chatProvider: async () => 'opening'
  });

  await assert.rejects(
    runConversationTurn({
      root,
      id: 'conv_safe_001/../../runtime_state',
      characterId: 'lina',
      playerInput: 'bad path',
      now: '2026-05-05T06:02:00.000+09:00',
      chatProvider: async () => 'should not run'
    }),
    /conversation/i
  );
});

// ----- errand per-turn achievement judgment -----

const ERRAND_SCENE = {
  source_type: ERRAND_SOURCE_TYPE,
  location_name: '依頼の現場',
  visible_situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。',
  prompt_tail_context: '試験前で不安があり、話しながら理解を確かめたい。'
};
const ERRAND_CONDITION = '主人公が依頼主の苦手な内容を説明し、依頼主が理解を示した。';

test('an errand turn achieves: it runs the achievement judgment instead of the continuation judgment, generates a wrap-up 発話, and returns an errand_achievement signal', async () => {
  const root = await fixtureRoot();
  let achievementPrompt = '';
  let wrapUpCalled = false;
  const result = await runConversationTurnCore({
    root,
    id: 'conv_errand_ach_001',
    characterId: 'lina',
    playerInput: '苦手なところ、こう考えると分かるよ',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: ERRAND_SCENE,
    errandJudgmentContext: { condition_text: ERRAND_CONDITION },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'なるほど、そういうことだったんですね。よく分かりました。',
    errandAchievementProvider: async ({ prompt }) => { achievementPrompt = prompt; return 'true'; },
    errandWrapUpProvider: async () => { wrapUpCalled = true; return 'それじゃ、今日はここまで。本当にありがとう。'; },
    conversationContinuationProvider: async () => { throw new Error('an errand turn must not run the continuation judgment'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.ok(result.errand_achievement, 'the achieved turn returns the achievement signal');
  assert.equal(result.errand_achievement.condition_text, ERRAND_CONDITION);
  assert.equal(result.errand_achievement.wrap_up_assistant_text, 'それじゃ、今日はここまで。本当にありがとう。');
  assert.equal(wrapUpCalled, true);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
  assert.match(achievementPrompt, /達成条件: 主人公が依頼主の苦手な内容を説明し、依頼主が理解を示した。/);
  assert.match(achievementPrompt, /true もしくは false 以外は返さない/);

  const conversation = await readJson(root, 'game_data/logs/conversations/conv_errand_ach_001.json');
  assert.equal(conversation.messages.at(-1).content, 'それじゃ、今日はここまで。本当にありがとう。');
  assert.equal(conversation.errand_achievement_judgment.achieved, true);
  assert.equal(conversation.errand_achievement_judgment.wrap_up_assistant_text, 'それじゃ、今日はここまで。本当にありがとう。');
  assert.equal(Object.hasOwn(conversation, 'conversation_continuation'), false, 'the achievement judgment replaces the continuation judgment');
});

test('an errand turn that does not achieve continues without a wrap-up or completion signal', async () => {
  const root = await fixtureRoot();
  const result = await runConversationTurnCore({
    root,
    id: 'conv_errand_cont_001',
    characterId: 'lina',
    playerInput: 'まだ途中だね',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: ERRAND_SCENE,
    errandJudgmentContext: { condition_text: ERRAND_CONDITION },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'そうですね、もう少し続けましょう。',
    errandAchievementProvider: async () => 'false',
    errandWrapUpProvider: async () => { throw new Error('the wrap-up must not run when the errand is not achieved'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(Object.hasOwn(result, 'errand_achievement'), false, 'an unachieved turn returns no completion signal');
  const conversation = await readJson(root, 'game_data/logs/conversations/conv_errand_cont_001.json');
  assert.equal(conversation.errand_achievement_judgment.achieved, false);
  assert.equal(conversation.messages.at(-1).content, 'そうですね、もう少し続けましょう。', 'no wrap-up 発話 is appended when not achieved');
});

test('an invalid errand achievement output fails fast with INVALID_LLM_ERRAND_JUDGMENT_OUTPUT before the turn is persisted', async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_errand_bad_001',
      characterId: 'lina',
      playerInput: '達成した？',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: ERRAND_SCENE,
      errandJudgmentContext: { condition_text: ERRAND_CONDITION },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい。',
      errandAchievementProvider: async () => 'maybe',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    (error) => {
      assert.equal(error.errorCode, 'INVALID_LLM_ERRAND_JUDGMENT_OUTPUT');
      assert.equal(error.statusCode, 503);
      return true;
    }
  );
  assert.equal(await exists(root, 'game_data/logs/conversations/conv_errand_bad_001.json'), false, 'the turn is not persisted on an invalid judgment');
});

test('an errand turn requires an errandAchievementProvider, and an empty wrap-up fails fast', async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_errand_noprov_001',
      characterId: 'lina',
      playerInput: 'やあ',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: ERRAND_SCENE,
      errandJudgmentContext: { condition_text: ERRAND_CONDITION },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい。',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    /errandAchievementProvider is required/
  );

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_errand_emptywrap_001',
      characterId: 'lina',
      playerInput: '終わった',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: ERRAND_SCENE,
      errandJudgmentContext: { condition_text: ERRAND_CONDITION },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい。',
      errandAchievementProvider: async () => 'true',
      errandWrapUpProvider: async () => '   ',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    /errand wrap-up reply is required/
  );
});

test('a companion turn without errand judgment context keeps the continuation judgment and never runs the errand achievement provider (byte-equivalent)', async () => {
  const root = await fixtureRoot();
  await runConversationTurnCore({
    root,
    id: 'conv_dungeon_noerrand_001',
    characterId: 'lina',
    playerInput: '先に進もう',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: {
      location_name: '実践ダンジョン 第1層',
      visible_situation: '実践ダンジョンの第1層を主人公と一緒に探索している。'
    },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'はい、進みましょう。',
    conversationContinuationProvider: async () => 'true',
    errandAchievementProvider: async () => { throw new Error('the achievement provider must not run without errand judgment context'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  const conversation = await readJson(root, 'game_data/logs/conversations/conv_dungeon_noerrand_001.json');
  assert.equal(conversation.conversation_continuation.continue_conversation, true);
  assert.equal(Object.hasOwn(conversation, 'errand_achievement_judgment'), false, 'a non-errand companion turn carries no errand judgment');
});

// ----- study circle per-turn achievement judgment (mirror of the errand judgment above) -----

const STUDY_CIRCLE_SCENE = {
  source_type: STUDY_CIRCLE_SOURCE_TYPE,
  location_name: '第三観測室',
  visible_situation: '観測机に、星図と観測記録が種類ごとに並べて置かれている。',
  prompt_tail_context: '主催者が、会話を通じてこの研究会に付き合ってほしいと考えている。'
};
const STUDY_CIRCLE_CONDITION = '主人公が主催者の問いに沿って観測手順を筋道立てて説明した。';

test('a study circle turn achieves: it runs the achievement judgment instead of the continuation judgment, generates a wrap-up 発話, and returns a study_circle_achievement signal', async () => {
  const root = await fixtureRoot();
  let achievementPrompt = '';
  let wrapUpCalled = false;
  const result = await runConversationTurnCore({
    root,
    id: 'conv_study_circle_ach_001',
    characterId: 'lina',
    playerInput: '観測手順はこう組み立てます',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: STUDY_CIRCLE_SCENE,
    studyCircleJudgmentContext: { condition_text: STUDY_CIRCLE_CONDITION },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'なるほど、筋が通っていますね。',
    studyCircleAchievementProvider: async ({ prompt }) => { achievementPrompt = prompt; return 'true'; },
    studyCircleWrapUpProvider: async () => { wrapUpCalled = true; return 'では、今日の研究会はここまで。よく付き合ってくれました。'; },
    conversationContinuationProvider: async () => { throw new Error('a study circle turn must not run the continuation judgment'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.ok(result.study_circle_achievement, 'the achieved turn returns the achievement signal');
  assert.equal(result.study_circle_achievement.condition_text, STUDY_CIRCLE_CONDITION);
  assert.equal(result.study_circle_achievement.wrap_up_assistant_text, 'では、今日の研究会はここまで。よく付き合ってくれました。');
  assert.equal(wrapUpCalled, true);
  assert.equal(Object.hasOwn(result, 'stage_move'), false);
  assert.match(achievementPrompt, /達成条件: 主人公が主催者の問いに沿って観測手順を筋道立てて説明した。/);
  assert.match(achievementPrompt, /true もしくは false 以外は返さない/);

  const conversation = await readJson(root, 'game_data/logs/conversations/conv_study_circle_ach_001.json');
  assert.equal(conversation.messages.at(-1).content, 'では、今日の研究会はここまで。よく付き合ってくれました。');
  assert.equal(conversation.study_circle_achievement_judgment.achieved, true);
  assert.equal(conversation.study_circle_achievement_judgment.wrap_up_assistant_text, 'では、今日の研究会はここまで。よく付き合ってくれました。');
  assert.equal(Object.hasOwn(conversation, 'conversation_continuation'), false, 'the achievement judgment replaces the continuation judgment');
});

test('a study circle turn that does not achieve continues without a wrap-up or completion signal', async () => {
  const root = await fixtureRoot();
  const result = await runConversationTurnCore({
    root,
    id: 'conv_study_circle_cont_001',
    characterId: 'lina',
    playerInput: 'まだ整理しきれていません',
    now: '2026-05-05T06:00:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: STUDY_CIRCLE_SCENE,
    studyCircleJudgmentContext: { condition_text: STUDY_CIRCLE_CONDITION },
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => 'そうですね、もう少し進めましょう。',
    studyCircleAchievementProvider: async () => 'false',
    studyCircleWrapUpProvider: async () => { throw new Error('the wrap-up must not run when the study circle is not achieved'); },
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });

  assert.equal(Object.hasOwn(result, 'study_circle_achievement'), false, 'an unachieved turn returns no completion signal');
  const conversation = await readJson(root, 'game_data/logs/conversations/conv_study_circle_cont_001.json');
  assert.equal(conversation.study_circle_achievement_judgment.achieved, false);
  assert.equal(conversation.messages.at(-1).content, 'そうですね、もう少し進めましょう。', 'no wrap-up 発話 is appended when not achieved');
});

test('an invalid study circle achievement output fails fast with INVALID_LLM_STUDY_CIRCLE_JUDGMENT_OUTPUT before the turn is persisted', async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_study_circle_bad_001',
      characterId: 'lina',
      playerInput: '達成した？',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: STUDY_CIRCLE_SCENE,
      studyCircleJudgmentContext: { condition_text: STUDY_CIRCLE_CONDITION },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい。',
      studyCircleAchievementProvider: async () => 'maybe',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    (error) => {
      assert.equal(error.errorCode, 'INVALID_LLM_STUDY_CIRCLE_JUDGMENT_OUTPUT');
      assert.equal(error.statusCode, 503);
      return true;
    }
  );
  assert.equal(await exists(root, 'game_data/logs/conversations/conv_study_circle_bad_001.json'), false, 'the turn is not persisted on an invalid judgment');
});

test('a study circle turn requires a studyCircleAchievementProvider, and an empty wrap-up fails fast', async () => {
  const root = await fixtureRoot();
  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_study_circle_noprov_001',
      characterId: 'lina',
      playerInput: 'やあ',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: STUDY_CIRCLE_SCENE,
      studyCircleJudgmentContext: { condition_text: STUDY_CIRCLE_CONDITION },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい。',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    /studyCircleAchievementProvider is required/
  );

  await assert.rejects(
    runConversationTurnCore({
      root,
      id: 'conv_study_circle_emptywrap_001',
      characterId: 'lina',
      playerInput: '終わった',
      now: '2026-05-05T06:00:00.000+09:00',
      postTurnStatePolicy: companionPostTurnStatePolicy,
      dungeonSceneContext: STUDY_CIRCLE_SCENE,
      studyCircleJudgmentContext: { condition_text: STUDY_CIRCLE_CONDITION },
      emotionProvider: async () => ({ expression: 'neutral' }),
      chatProvider: async () => 'はい。',
      studyCircleAchievementProvider: async () => 'true',
      studyCircleWrapUpProvider: async () => '   ',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    /study circle wrap-up reply is required/
  );
});
