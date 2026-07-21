import test from 'node:test';
import assert from 'node:assert/strict';
import { createLmStudioProviders } from '../src/llm/lmStudioClient.mjs';
import { ERRAND_SOURCE_TYPE, STUDY_CIRCLE_SOURCE_TYPE } from '../src/routingMetaContext.mjs';

// Captures the prompt every reflection-text / judgment call sends and answers with a canned response, so the
// finalization providers (memory / work_record generation and stage-flag judgment) can be exercised without a
// real LM. The stage-flag judgment parses the canned text as "not true" — the result is irrelevant here; the
// captured prompt is what the assertions inspect. (Mirror of dungeonFinalizePrompt.test.mjs.)
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

// The observed bug's conversations: an errand / study circle turn recorded with the residual field location.
// After the fix each record declares its own source_type and carries its session scene instead.
const injectedSceneConversations = [
  {
    label: 'errand',
    conversation: {
      id: 'conv_errand_5_help_003_53254628',
      character_id: 'character_003',
      character_name: '三番',
      source_type: ERRAND_SOURCE_TYPE,
      // Errand records legitimately omit field location_id / time_slot; the errand 舞台 rides on the record.
      location_name: '依頼の現場',
      visible_situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。',
      messages: [
        { role: 'assistant', content: 'ここが分からなくて。教えてもらえますか。' },
        { role: 'user', content: 'いいよ、一緒に見よう。' }
      ]
    }
  },
  {
    label: 'study circle',
    conversation: {
      id: 'conv_study_circle_5_star_005_53254628',
      character_id: 'character_005',
      character_name: '五番',
      source_type: STUDY_CIRCLE_SOURCE_TYPE,
      location_name: '第三観測室',
      visible_situation: '観測机に、星図と観測記録が種類ごとに並べて置かれている。',
      messages: [
        { role: 'assistant', content: '観測手順を一緒に整理しましょう。' },
        { role: 'user', content: 'はい、お願いします。' }
      ]
    }
  }
];

const fieldConversation = {
  id: 'conv_field_generation_003',
  character_id: 'character_001',
  character_name: 'セラ・アストルーペ',
  source_type: 'field',
  location_id: 'herbology_garden',
  time_slot: 'after_school',
  messages: [
    { role: 'assistant', content: '薬草園を見ていきましょう。' },
    { role: 'user', content: 'お願いします。' }
  ]
};

for (const { label, conversation } of injectedSceneConversations) {
  test(`${label} memory/work_record/stage-flag prompts carry the session scene and drop field location residual`, async () => {
    const captured = [];
    const providers = capturingProviders(captured);
    const workRecordId = `wr_${conversation.id}`;
    await providers.memoryUpdateProvider({ conversation, workRecordId });
    await providers.workRecordProvider({ conversation, workRecordId });
    await providers.stageFlagJudgmentProvider({
      conversation,
      workRecordId,
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
      assert.match(prompt, new RegExp(`"source_type": "${conversation.source_type}"`));
      assert.match(prompt, new RegExp(`"location_name": "${conversation.location_name}"`));
      assert.ok(prompt.includes(conversation.visible_situation), 'the session visible_situation is present');
      assert.doesNotMatch(prompt, /"location_id"/);
      assert.doesNotMatch(prompt, /"time_slot"/);
      assert.doesNotMatch(prompt, /herbology_garden/);
      assert.doesNotMatch(prompt, /after_school/);
    }
  });
}

test('field memory/work_record generation prompts keep source_type/location_id/time_slot unchanged', async () => {
  const captured = [];
  const providers = capturingProviders(captured);
  await providers.memoryUpdateProvider({ conversation: fieldConversation, workRecordId: 'wr_conv_field_generation_003' });
  await providers.workRecordProvider({ conversation: fieldConversation, workRecordId: 'wr_conv_field_generation_003' });

  const memoryPrompt = captured.find((prompt) => prompt.includes('memory_recordの本文だけを平文で出力する'));
  const workRecordPrompt = captured.find((prompt) => prompt.includes('work_recordのタイトルと本文を平文で出力する'));
  for (const prompt of [memoryPrompt, workRecordPrompt]) {
    assert.match(prompt, /"source_type": "field"/);
    assert.match(prompt, /"location_id": "herbology_garden"/);
    assert.match(prompt, /"time_slot": "after_school"/);
    assert.doesNotMatch(prompt, /location_name/);
  }
});
