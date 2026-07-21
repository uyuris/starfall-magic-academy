import test from 'node:test';
import assert from 'node:assert/strict';
import { createLmStudioProviders } from '../src/llm/lmStudioClient.mjs';
import { DUNGEON_SOURCE_TYPE } from '../src/routingMetaContext.mjs';

// Captures the prompt every reflection-text / judgment call sends and answers with a canned response, so the
// finalization providers (memory / work_record generation and stage-flag judgment) can be exercised without a
// real LM. The stage-flag judgment parses the canned text as "not true" — the result is irrelevant here; the
// captured prompt is what the assertions inspect.
function capturingProviders(captured, content = 'タイトル: テスト記録\n本文: テスト本文。') {
  const fetchImpl = async (_url, options) => {
    captured.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
  return createLmStudioProviders({
    config: { base_url: 'http://stub.invalid/v1', reflection_model: 'reflection-model', chat_model: 'chat-model', timeout_ms: 5000, thinking_effort: null },
    fetchImpl
  });
}

// The observed bug's conversation: a dungeon companion turn recorded with the residual field location. After
// the fix the record declares source_type 'dungeon' and carries the dynamic floor scene instead.
const dungeonConversation = {
  id: 'conv_dungeon_dr_53254628',
  character_id: 'character_018',
  character_name: 'フロス・スノウリエ',
  source_type: DUNGEON_SOURCE_TYPE,
  // Dungeon records legitimately omit field location_id / time_slot; the floor 舞台 rides on the record.
  location_name: '実践ダンジョン 第3層',
  visible_situation: '実践ダンジョンの第3層を主人公と一緒に探索している。',
  messages: [
    { role: 'assistant', content: 'この階は視界が悪い。私の後ろに。' },
    { role: 'user', content: '分かった、頼りにしてる。' }
  ]
};

const fieldConversation = {
  id: 'conv_field_generation_002',
  character_id: 'character_001',
  character_name: 'セラ・アストルーペ',
  source_type: 'field',
  location_id: 'sanrin_mossy_shrine',
  time_slot: 'after_school',
  messages: [
    { role: 'assistant', content: '苔むした祠を見ていきましょう。' },
    { role: 'user', content: 'お願いします。' }
  ]
};

test('dungeon memory/work_record/stage-flag prompts carry the dungeon floor scene and drop field location residual', async () => {
  const captured = [];
  const providers = capturingProviders(captured);
  await providers.memoryUpdateProvider({ conversation: dungeonConversation, workRecordId: 'wr_conv_dungeon_dr_53254628' });
  await providers.workRecordProvider({ conversation: dungeonConversation, workRecordId: 'wr_conv_dungeon_dr_53254628' });
  await providers.stageFlagJudgmentProvider({
    conversation: dungeonConversation,
    workRecordId: 'wr_conv_dungeon_dr_53254628',
    candidateFlags: [{
      id: 'stage.example.some_flag',
      label: '例のフラグ',
      location_id: 'example_location',
      condition: '例の条件。',
      question: '例の条件が成立したか'
    }]
  });

  const memoryPrompt = captured.find((prompt) => prompt.includes('memory_recordの本文だけを平文で出力する'));
  const workRecordPrompt = captured.find((prompt) => prompt.includes('work_recordのタイトルと本文を平文で出力する'));
  const stageFlagPrompt = captured.find((prompt) => prompt.includes('これは舞台フラグ判定であり'));
  assert.ok(memoryPrompt, 'memory generation prompt is sent');
  assert.ok(workRecordPrompt, 'work_record generation prompt is sent');
  assert.ok(stageFlagPrompt, 'stage flag judgment prompt is sent');

  for (const prompt of [memoryPrompt, workRecordPrompt, stageFlagPrompt]) {
    assert.match(prompt, /"source_type": "dungeon"/);
    assert.match(prompt, /"location_name": "実践ダンジョン 第3層"/);
    assert.match(prompt, /実践ダンジョンの第3層を主人公と一緒に探索している。/);
    assert.doesNotMatch(prompt, /"location_id"/);
    assert.doesNotMatch(prompt, /"time_slot"/);
    assert.doesNotMatch(prompt, /sanrin_mossy_shrine/);
    assert.doesNotMatch(prompt, /after_school/);
  }
});

test('field memory/work_record generation prompts keep source_type/location_id/time_slot unchanged', async () => {
  const captured = [];
  const providers = capturingProviders(captured);
  await providers.memoryUpdateProvider({ conversation: fieldConversation, workRecordId: 'wr_conv_field_generation_002' });
  await providers.workRecordProvider({ conversation: fieldConversation, workRecordId: 'wr_conv_field_generation_002' });

  const memoryPrompt = captured.find((prompt) => prompt.includes('memory_recordの本文だけを平文で出力する'));
  const workRecordPrompt = captured.find((prompt) => prompt.includes('work_recordのタイトルと本文を平文で出力する'));
  for (const prompt of [memoryPrompt, workRecordPrompt]) {
    assert.match(prompt, /"source_type": "field"/);
    assert.match(prompt, /"location_id": "sanrin_mossy_shrine"/);
    assert.match(prompt, /"time_slot": "after_school"/);
    assert.doesNotMatch(prompt, /location_name/);
  }
});
