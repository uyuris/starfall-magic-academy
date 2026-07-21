import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConversationRecordUpdates, validateReflectionCandidates } from '../src/llm/validator.mjs';

test('validateReflectionCandidates accepts LLM-chosen known flag updates and only rejects structurally invalid candidates', () => {
  const result = validateReflectionCandidates({
    sourceType: 'dialogue',
    state: {
      global_flags: { 'story.garden_intro_done': false },
      characters: {
        lina: {
          flags: {
            'knowledge.lina.player_checked_garden_label': false,
            'relationship.lina.trust': 0
          }
        }
      }
    },
    reflection: {
      source_conversation_id: 'conv_0001',
      memory_update_candidates: [
        { character_id: 'lina', id: 'mem_lina_garden_label', text: 'プレイヤーは薬草園の棚札の順番を確認した。', visibility: 'character_known', tags: ['薬草園', '棚札'] }
      ],
      flag_update_candidates: [
        { character_id: 'lina', flag: 'knowledge.lina.player_checked_garden_label', op: 'set', value: true },
        { character_id: 'lina', flag: 'story.garden_intro_done', op: 'set', value: true },
        { character_id: 'lina', flag: 'relationship.lina.trust', op: 'increment', value: 1 },
        { character_id: 'lina', flag: 'unknown.llm_hallucinated_flag', op: 'set', value: true }
      ],
      work_record_draft: {
        title: '放課後の薬草園で棚札の順番を確認した',
        scene: '放課後の薬草園',
        participants: ['player', 'lina'],
        what_player_did: '棚札の順番が記録と違うと指摘した。',
        what_character_did: 'リナは棚札と水やり記録を確認した。',
        character_interpretation: '記録の付け間違いか、鉢の移動があった可能性がある。',
        uncertainty: '棚札が入れ替わった理由は未確認。',
        future_hooks: ['薬草園の記録棚を調べる'],
        retrieval_tags: ['リナ', '薬草園', '棚札']
      }
    }
  });

  assert.deepEqual(result.accepted_flags, [
    { character_id: 'lina', flag: 'knowledge.lina.player_checked_garden_label', op: 'set', value: true },
    { character_id: 'lina', flag: 'story.garden_intro_done', op: 'set', value: true },
    { character_id: 'lina', flag: 'relationship.lina.trust', op: 'increment', value: 1 }
  ]);
  assert.equal(result.rejected_flags.length, 1);
  assert.equal(result.rejected_flags[0].flag, 'unknown.llm_hallucinated_flag');
  assert.match(result.rejected_flags[0].reason, /unknown flag/);
  assert.equal(result.accepted_memory.length, 1);
  assert.equal(result.accepted_work_record.title, '放課後の薬草園で棚札の順番を確認した');
});

test('validateConversationRecordUpdates accepts work-record summaries up to 20 sentences and rejects 21', () => {
  const state = { characters: { lina: { flags: {} } }, global_flags: {} };
  const memoryRecord = {
    character_id: 'lina',
    id: 'mem_work_record_limit',
    type: 'relationship_change',
    text: 'リナは主人公との会話を覚えた。',
    visibility: 'character_known',
    source_conversation_id: 'conv_work_record_limit',
    work_record_id: 'wr_work_record_limit'
  };
  const skillRecord = {
    character_id: 'lina',
    id: 'skill_work_record_limit',
    type: 'self_change',
    name: '会話からの自己変化',
    description: 'リナは会話を通じて落ち着いて確認する意識を強めた。',
    visibility: 'character_known',
    source_conversation_id: 'conv_work_record_limit',
    work_record_id: 'wr_work_record_limit'
  };
  const twentySentenceSummary = Array.from({ length: 20 }, (_, index) => `記録${index + 1}を残した。`).join('');
  const accepted = validateConversationRecordUpdates({
    sourceType: 'dialogue',
    state,
    memoryRecord,
    skillRecord,
    workRecordDraft: {
      id: 'wr_work_record_limit',
      character_id: 'lina',
      source_conversation_id: 'conv_work_record_limit',
      work_record_id: 'wr_work_record_limit',
      title: '20文の会話記録',
      summary: twentySentenceSummary
    }
  });

  assert.equal(accepted.rejected_work_record, null);
  assert.equal(accepted.accepted_work_record.summary, twentySentenceSummary);

  const rejected = validateConversationRecordUpdates({
    sourceType: 'dialogue',
    state,
    memoryRecord,
    skillRecord,
    workRecordDraft: {
      id: 'wr_work_record_limit_over',
      character_id: 'lina',
      source_conversation_id: 'conv_work_record_limit',
      work_record_id: 'wr_work_record_limit_over',
      title: '21文の会話記録',
      summary: `${twentySentenceSummary}記録21を残した。`
    }
  });

  assert.match(rejected.rejected_work_record.reason, /20 sentences or fewer/);
});
