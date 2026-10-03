// 残す (a): 会話の終了処理が、その最中に書かれた鍛錬・学院の進行を古い値で書き潰す壊れ方から、プレイヤーの save を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixtureRoot as createFixtureRoot } from './helpers.mjs';
import {
  academyPostTurnStatePolicy,
  finalizeConversation as finalizeConversationCore,
  runConversationOpening,
  runConversationTurn as runConversationTurnCore
} from '../src/llm/conversationPipeline.mjs';

function runConversationTurn(args) {
  return runConversationTurnCore({ postTurnStatePolicy: academyPostTurnStatePolicy, ...args });
}

function finalizeConversation(args) {
  return finalizeConversationCore({ affinityDeltaProvider: async () => '0', mpReserveProvider: async () => '30', ...args });
}

async function fixtureRoot() {
  return createFixtureRoot('magic-adv-pipeline-');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

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
