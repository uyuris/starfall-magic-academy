import test from 'node:test';
import assert from 'node:assert/strict';
import { createLmStudioProviders } from '../src/llm/lmStudioClient.mjs';
import {
  ROUTING_HUB_LOCATION_NAME,
  ROUTING_HUB_SOURCE_TYPE,
  ROUTING_HUB_VISIBLE_SITUATION
} from '../src/routingMetaContext.mjs';

// Captures the prompt every reflection-text call sends and answers with a canned plain record, so a
// finalization generation provider (memory / skill / work_record) can be exercised without a real LM.
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

const hubConversation = {
  id: 'conv_hub_generation_001',
  character_id: 'lina',
  character_name: 'ルミ',
  source_type: ROUTING_HUB_SOURCE_TYPE,
  // Routing hub records legitimately omit field location_id / time_slot.
  messages: [
    { role: 'assistant', content: '新しい週を、ここから一緒に選びましょう。' },
    { role: 'user', content: '今週はダンジョンにしようと思います。' }
  ]
};

const fieldConversation = {
  id: 'conv_field_generation_001',
  character_id: 'character_001',
  character_name: 'セラ・アストルーペ',
  source_type: 'field',
  location_id: 'herbology_garden',
  time_slot: 'after_school',
  messages: [
    { role: 'assistant', content: '棚札を確認しましょう。' },
    { role: 'user', content: 'お願いします。' }
  ]
};

test('routing hub memory/work_record generation prompts carry the hub scene and drop field location residual', async () => {
  const captured = [];
  const providers = capturingProviders(captured);
  await providers.memoryUpdateProvider({ conversation: hubConversation, workRecordId: 'wr_conv_hub_generation_001' });
  await providers.workRecordProvider({ conversation: hubConversation, workRecordId: 'wr_conv_hub_generation_001' });

  const memoryPrompt = captured.find((prompt) => prompt.includes('memory_recordの本文だけを平文で出力する'));
  const workRecordPrompt = captured.find((prompt) => prompt.includes('work_recordのタイトルと本文を平文で出力する'));
  assert.ok(memoryPrompt, 'memory generation prompt is sent');
  assert.ok(workRecordPrompt, 'work_record generation prompt is sent');

  for (const prompt of [memoryPrompt, workRecordPrompt]) {
    assert.match(prompt, /"source_type": "routing_hub"/);
    assert.match(prompt, new RegExp(`"location_name": "${ROUTING_HUB_LOCATION_NAME}"`));
    assert.match(prompt, new RegExp(`"visible_situation": "${ROUTING_HUB_VISIBLE_SITUATION}"`));
    assert.doesNotMatch(prompt, /"location_id"/);
    assert.doesNotMatch(prompt, /"time_slot"/);
    assert.doesNotMatch(prompt, /herbology_garden/);
    assert.doesNotMatch(prompt, /after_school/);
  }
});

test('field memory/work_record generation prompts keep source_type/location_id/time_slot unchanged', async () => {
  const captured = [];
  const providers = capturingProviders(captured);
  await providers.memoryUpdateProvider({ conversation: fieldConversation, workRecordId: 'wr_conv_field_generation_001' });
  await providers.workRecordProvider({ conversation: fieldConversation, workRecordId: 'wr_conv_field_generation_001' });

  const memoryPrompt = captured.find((prompt) => prompt.includes('memory_recordの本文だけを平文で出力する'));
  const workRecordPrompt = captured.find((prompt) => prompt.includes('work_recordのタイトルと本文を平文で出力する'));
  for (const prompt of [memoryPrompt, workRecordPrompt]) {
    assert.match(prompt, /"source_type": "field"/);
    assert.match(prompt, /"location_id": "herbology_garden"/);
    assert.match(prompt, /"time_slot": "after_school"/);
    assert.doesNotMatch(prompt, /location_name/);
  }
});
