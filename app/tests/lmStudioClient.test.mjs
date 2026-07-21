import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callLmStudioChat, callLmStudioStructuredJson, createLmStudioProviders, loadLmStudioConfig } from '../src/llm/lmStudioClient.mjs';
import { clearLlmRequestLog, getRecentLlmRequests } from '../src/llm/llmRequestLog.mjs';

async function withStubServer(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, body: parsed });
    await handler(req, res, parsed);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test('callLmStudioChat posts OpenAI-compatible chat completion and returns assistant text', async (t) => {
  const { baseUrl, requests } = await withStubServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'リナの返答です。' } }] }));
  });

  const text = await callLmStudioChat({
    config: { base_url: baseUrl, chat_model: 'gemma-4-31b', timeout_ms: 5000, stream: false },
    prompt: '星灯魔法学院のリナとして返答する。'
  });

  assert.equal(text, 'リナの返答です。');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.model, 'gemma-4-31b');
  assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: '星灯魔法学院のリナとして返答する。' }]);
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.reasoning, undefined);
  assert.equal(requests[0].body.reasoning_effort, 'none');
});

test('callLmStudioChat can accumulate streamed OpenAI-compatible SSE deltas', async (t) => {
  const { baseUrl, requests } = await withStubServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"……はい"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"、調べましょう。"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });

  const text = await callLmStudioChat({
    config: { base_url: baseUrl, chat_model: 'gemma-4-31b', timeout_ms: 5000, stream: true },
    prompt: 'stream test'
  });

  assert.equal(text, '……はい、調べましょう。');
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.reasoning_effort, 'none');
});

test('loadLmStudioConfig defaults missing stream to true', async (t) => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-lmstudio-config-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const configPath = path.join(root, 'lmstudio.json');
  await fs.writeFile(configPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it'
  }, null, 2)}\n`, 'utf8');

  const loaded = await loadLmStudioConfig(configPath);
  assert.equal(loaded.stream, true);
  assert.equal(loaded.thinking_effort, null);
});

test('loadLmStudioConfig preserves allowed thinking effort values and normalizes invalid values to None', async (t) => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-lmstudio-config-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const validConfigPath = path.join(root, 'lmstudio-valid.json');
  const invalidConfigPath = path.join(root, 'lmstudio-invalid.json');
  const uppercaseConfigPath = path.join(root, 'lmstudio-uppercase.json');
  const spacedConfigPath = path.join(root, 'lmstudio-spaced.json');
  await fs.writeFile(validConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    thinking_effort: 'high'
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(invalidConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    thinking_effort: 'ultra'
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(uppercaseConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    thinking_effort: 'LOW'
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(spacedConfigPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    thinking_effort: ' low '
  }, null, 2)}\n`, 'utf8');

  assert.equal((await loadLmStudioConfig(validConfigPath)).thinking_effort, 'high');
  assert.equal((await loadLmStudioConfig(invalidConfigPath)).thinking_effort, null);
  assert.equal((await loadLmStudioConfig(uppercaseConfigPath)).thinking_effort, null);
  assert.equal((await loadLmStudioConfig(spacedConfigPath)).thinking_effort, null);
});

test('loadLmStudioConfig preserves explicit stream false', async (t) => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-lmstudio-config-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const configPath = path.join(root, 'lmstudio.json');
  await fs.writeFile(configPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    stream: false
  }, null, 2)}\n`, 'utf8');

  const loaded = await loadLmStudioConfig(configPath);
  assert.equal(loaded.stream, false);
});

test('callLmStudioStructuredJson requests the supplied json_schema and parses object output', async (t) => {
  const memoryUpdate = {
    memory_record: {
      id: 'mem_conv_test',
      character_id: 'lina',
      visibility: 'private',
      type: 'relationship_change',
      text: 'リナは主人公が薬草園の棚札を一緒に確認したことを覚えた。',
      source_conversation_id: 'conv_test',
      work_record_id: 'wr_conv_test',
      tags: ['棚札', '主人公']
    }
  };
  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'memory_update_record',
      schema: {
        type: 'object',
        properties: { memory_record: { type: 'object' } },
        required: ['memory_record']
      }
    }
  };
  const { baseUrl, requests } = await withStubServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(memoryUpdate) } }] }));
  });

  const parsed = await callLmStudioStructuredJson({
    config: { base_url: baseUrl, reflection_model: 'gemma-4-31b-it', timeout_ms: 5000, thinking_effort: 'low' },
    prompt: 'memory update prompt',
    responseFormat
  });

  assert.deepEqual(parsed, memoryUpdate);
  assert.equal(requests[0].body.model, 'gemma-4-31b-it');
  assert.equal(requests[0].body.reasoning, undefined);
  assert.equal(requests[0].body.reasoning_effort, 'low');
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.equal(requests[0].body.response_format.json_schema.name, 'memory_update_record');
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.required, ['memory_record']);
});

test('createLmStudioProviders returns chat and separate continuity update providers for the conversation pipeline', async (t) => {
  const { baseUrl, requests } = await withStubServer(t, async (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!body.response_format) {
      const prompt = body.messages?.[0]?.content ?? '';
      const content = prompt.includes('会話を継続したいと思うか')
        ? 'true'
        : prompt.includes('この会話を切り上げる')
          ? '今日はここで区切ります。'
          : prompt.includes('場所移動の合意が形成されたか')
            ? 'false'
            : prompt.includes('移動可能な移動先の名称とlocation_idの対応表')
              ? 'library_reading_room'
              : prompt.includes('移動して場面を移すための発言')
                ? 'では、閲覧ホールへ移りましょう。'
                : prompt.includes('舞台移動後先行発話')
                  ? '閲覧ホールに着きました。'
          : prompt.includes('必要性判定')
            ? 'true'
            : prompt.includes('memory_record')
              ? '主人公との関係性が変化した。リナは主人公の観察を手がかりとして受け止めた。二人は棚札について話した。リナは次も相談してよい相手だと感じた。主人公への信頼が少し強まった。'
              : prompt.includes('skill_record')
                ? 'タイトル: 慎重な観察\n本文: リナは主人公との会話から慎重に観察する姿勢を強めた。'
                : prompt.includes('work_record')
                  ? 'タイトル: 棚札について話した\n本文: 主人公とリナは棚札の扱いについて話した。'
                  : 'LM Studio character line';
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    const schemaName = body.response_format.json_schema.name;
    const contentBySchema = {
      character_emotion_choice: JSON.stringify({ expression: 'serious' })
    };
    res.end(JSON.stringify({ choices: [{ message: { content: contentBySchema[schemaName] } }] }));
  });
  const conversation = { id: 'conv_x', character_id: 'lina', location_id: 'herbology_garden', time_slot: 'after_school', source_type: 'field', messages: [] };
  const providers = createLmStudioProviders({ config: { base_url: baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false, thinking_effort: 'high' } });

  assert.equal(await providers.chatProvider({ prompt: 'character prompt' }), 'LM Studio character line');
  const emotion = await providers.emotionProvider({ profile: { display_name: 'リナ・クラウゼ' }, playerInput: '棚札を見て', currentConversation: [], prompt: 'cache-friendly shared character prompt\nリナ・クラウゼとして、現在の場面に自然に続く感情を次から1つだけ選択する。' });
  const shouldContinue = await providers.conversationContinuationProvider({ prompt: 'リナ・クラウゼとして、この発言を行ったプレイヤーとの会話を継続したいと思うか。' });
  const cutoffText = await providers.conversationCutoffProvider({ prompt: 'リナ・クラウゼとして、この会話を切り上げる。' });
  const stageMoveAgreement = await providers.stageMoveAgreementProvider({ prompt: 'リナ・クラウゼとして、場所移動の合意が形成されたか。' });
  const stageMoveDestination = await providers.stageMoveDestinationProvider({ prompt: '移動可能な移動先の名称とlocation_idの対応表:\n大図書館の閲覧ホール: library_reading_room' });
  const stageMoveCutoff = await providers.stageMoveCutoffProvider({ prompt: 'リナ・クラウゼとして、移動して場面を移すための発言だけを書く。' });
  const stageMoveOpening = await providers.stageMoveOpeningProvider({ prompt: '舞台移動後先行発話。' });
  const memory = await providers.memoryUpdateProvider({ conversation, workRecordId: 'wr_conv_x' });
  const skillNecessity = await providers.skillNecessityJudgmentProvider({ conversation, workRecordId: 'wr_conv_x' });
  const skill = await providers.skillUpdateProvider({ conversation, workRecordId: 'wr_conv_x' });
  const workRecord = await providers.workRecordProvider({ conversation, workRecordId: 'wr_conv_x' });

  assert.deepEqual(emotion, { expression: 'serious' });
  assert.deepEqual(requests[1].body.response_format.json_schema.schema.properties.expression.enum, [
    'neutral', 'joy', 'caring', 'confident', 'sadness', 'worried', 'anger', 'surprised', 'embarrassed', 'shy', 'serious', 'determined', 'panic', 'tired', 'sick', 'smug'
  ]);
  // The continuation provider returns the raw reflection text (like stageMoveAgreementProvider); the
  // conversation pipeline is the single place that strict-parses it to a boolean.
  assert.equal(shouldContinue, 'true');
  assert.equal(cutoffText, '今日はここで区切ります。');
  assert.equal(stageMoveAgreement, 'false');
  assert.equal(stageMoveDestination, 'library_reading_room');
  assert.equal(stageMoveCutoff, 'では、閲覧ホールへ移りましょう。');
  assert.equal(stageMoveOpening, '閲覧ホールに着きました。');
  assert.equal(memory.memory_record.work_record_id, 'wr_conv_x');
  assert.equal(memory.memory_record.text, '主人公との関係性が変化した。リナは主人公の観察を手がかりとして受け止めた。二人は棚札について話した。リナは次も相談してよい相手だと感じた。主人公への信頼が少し強まった。');
  assert.deepEqual(memory.memory_record.tags, []);
  assert.deepEqual(skillNecessity, { necessary: true, raw_answer: 'true' });
  assert.equal(skill.skill_record.work_record_id, 'wr_conv_x');
  assert.equal(skill.skill_record.name, '慎重な観察');
  assert.equal(skill.skill_record.description, 'リナは主人公との会話から慎重に観察する姿勢を強めた。');
  assert.equal(workRecord.work_record.id, 'wr_conv_x');
  assert.equal(workRecord.work_record.title, '棚札について話した');
  assert.equal(workRecord.work_record.summary, '主人公とリナは棚札の扱いについて話した。');
  assert.deepEqual(requests.slice(1).map((request) => request.body.response_format?.json_schema?.name ?? null), [
    'character_emotion_choice',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null
  ]);
  assert.deepEqual(requests.map((request) => request.body.reasoning_effort), Array.from({ length: requests.length }, () => 'high'));
  assert.match(requests[1].body.messages[0].content, /cache-friendly shared character prompt/);
  assert.doesNotMatch(requests[1].body.messages[0].content, /次のプレイヤー入力を受け取った直後のリナ・クラウゼの感情/);
  assert.match(requests[2].body.messages[0].content, /この発言を行ったプレイヤーとの会話を継続したいと思うか/);
  assert.match(requests[3].body.messages[0].content, /この会話を切り上げる/);
  assert.match(requests[4].body.messages[0].content, /場所移動の合意が形成されたか/);
  assert.match(requests[5].body.messages[0].content, /移動可能な移動先の名称とlocation_idの対応表/);
  assert.match(requests[6].body.messages[0].content, /移動して場面を移すための発言/);
  assert.match(requests[7].body.messages[0].content, /舞台移動後先行発話/);
  const memoryPromptLines = requests[8].body.messages[0].content.trim().split('\n');
  const skillNecessityPromptLines = requests[9].body.messages[0].content.trim().split('\n');
  const skillPromptLines = requests[10].body.messages[0].content.trim().split('\n');
  const workRecordPromptLines = requests[11].body.messages[0].content.trim().split('\n');
  assert.deepEqual(memoryPromptLines.slice(0, -1), skillNecessityPromptLines.slice(0, -1));
  assert.deepEqual(memoryPromptLines.slice(0, -1), skillPromptLines.slice(0, -1));
  assert.deepEqual(memoryPromptLines.slice(0, -1), workRecordPromptLines.slice(0, -1));
  const sharedContinuityPrefix = memoryPromptLines.slice(0, -1).join('\n');
  assert.match(sharedContinuityPrefix, /"role": "assistant"がキャラクターの発言であり、"role": "user"が主人公の発言である/);
  assert.match(sharedContinuityPrefix, /記録はキャラクター目線で作成する/);
  for (const prompt of [requests[8].body.messages[0].content, requests[9].body.messages[0].content, requests[10].body.messages[0].content, requests[11].body.messages[0].content]) {
    assert.doesNotMatch(prompt, /出力ではIDやJSON構造を作らず/);
    assert.doesNotMatch(prompt, /memory、skill\/self_change、work_recordは別々に保存される/);
    assert.doesNotMatch(prompt, /プログラム側でvisibility/);
  }
  assert.match(memoryPromptLines.at(-1), /memory_recordの本文だけを平文で出力する/);
  assert.doesNotMatch(memoryPromptLines.at(-1), /タイトル/);
  assert.match(memoryPromptLines.at(-1), /textは最大5文/);
  assert.match(memoryPromptLines.at(-1), /可能な限り具体的な情報/);
  const expectedContinuitySubjectRule = 'キャラクター(assistant側)の行動・発言・変容などを記載する際は、必ずキャラクター名を主語として表記し、「AI」「assistant」「キャラクター」などの役割名では書かない。主人公(User側)の行動・発言を記載する際は、会話から名前が特定できる場合は必ずその名前を使い、そうでない場合は「主人公」を主語として使用する。';
  assert.equal(memoryPromptLines.at(-1).endsWith(expectedContinuitySubjectRule), true);
  assert.doesNotMatch(memoryPromptLines.at(-1), /JSON、Markdownコードブロック、見出し/);
  assert.doesNotMatch(memoryPromptLines.at(-1), /後でtextとしてそのまま保存/);
  assert.match(skillNecessityPromptLines.at(-1), /必要性判定/);
  assert.match(skillNecessityPromptLines.at(-1), /回答はtrueもしくはfalseのみを返す/);
  assert.match(skillNecessityPromptLines.at(-1), /今後の振る舞いに決定的な影響を与える/);
  assert.doesNotMatch(skillNecessityPromptLines.at(-1), /タイトル/);
  assert.doesNotMatch(skillNecessityPromptLines.at(-1), /本文/);
  assert.match(skillPromptLines.at(-1), /skill_recordのタイトルと本文を平文で出力する/);
  assert.match(skillPromptLines.at(-1), /descriptionは必ず1文/);
  assert.equal(skillPromptLines.at(-1).endsWith(expectedContinuitySubjectRule), true);
  assert.doesNotMatch(skillPromptLines.at(-1), /JSON、Markdownコードブロック/);
  assert.doesNotMatch(skillPromptLines.at(-1), /Hermes Agentのスキルではなく/);
  assert.doesNotMatch(skillPromptLines.at(-1), /後でnameとして保存/);
  assert.doesNotMatch(skillPromptLines.at(-1), /後でdescriptionとして保存/);
  assert.match(workRecordPromptLines.at(-1), /work_recordのタイトルと本文を平文で出力する/);
  assert.match(workRecordPromptLines.at(-1), /タイトルは1行/);
  assert.match(workRecordPromptLines.at(-1), /summaryは最大20文/);
  assert.match(workRecordPromptLines.at(-1), /具体的な情報をすべて盛り込み/);
  assert.match(workRecordPromptLines.at(-1), /誰が何を言った・したか、どの場面・対象・判断・変化があったかを決して省略せず、漏れが一切ないよう記述する/);
  assert.doesNotMatch(workRecordPromptLines.at(-1), /可能な限り具体的な情報/);
  assert.doesNotMatch(workRecordPromptLines.at(-1), /省略しすぎない/);
  assert.doesNotMatch(workRecordPromptLines.at(-1), /JSON、Markdownコードブロック/);
  assert.doesNotMatch(workRecordPromptLines.at(-1), /本文は後でsummaryとして保存/);
  assert.equal(workRecordPromptLines.at(-1).endsWith(expectedContinuitySubjectRule), true);
  assert.doesNotMatch(requests[11].body.messages[0].content, /future_hooks/);
  assert.equal(requests[11].body.response_format, undefined);
});

test('conversation continuation provider returns the raw reflection text without rounding invalid output', async (t) => {
  const { baseUrl } = await withStubServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'maybe' } }] }));
  });
  const providers = createLmStudioProviders({ config: { base_url: baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false } });
  // The provider is transport only: it surfaces the raw judgment text verbatim (no silent map of a
  // non-true value to false). The conversation pipeline strict-parses it and fails fast on invalid text.
  assert.equal(await providers.conversationContinuationProvider({ prompt: '会話を継続したいと思うか。' }), 'maybe');
});

test('stage flag provider asks a plain true/false question using the shared conversation-end prefix and structures the answer in code', async (t) => {
  const { baseUrl, requests } = await withStubServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'true' } }] }));
  });
  const conversation = {
    id: 'conv_stage_flag',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    location_id: 'forbidden_archive_door',
    time_slot: 'after_school',
    source_type: 'field',
    messages: [
      { role: 'user', content: '禁書庫の中に入って、お茶会を開こう。' },
      { role: 'assistant', content: '奥の机で静かにティータイムにしましょう。' }
    ]
  };
  const providers = createLmStudioProviders({ config: { base_url: baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false } });

  const result = await providers.stageFlagJudgmentProvider({
    conversation,
    workRecordId: 'wr_conv_stage_flag',
    candidateFlags: [{
      id: 'stage.forbidden_archive.teatime_inside_done',
      label: '禁書庫内のお茶会',
      location_id: 'forbidden_archive_door',
      condition: '禁書庫の舞台で、禁書庫の中に入ってティータイム、お茶会をする。',
      question: '禁書庫に入り、その中でお茶会を開いたか'
    }]
  });

  assert.deepEqual(result, {
    flag_results: [{
      flag_id: 'stage.forbidden_archive.teatime_inside_done',
      achieved: true,
      raw_answer: 'true'
    }]
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.response_format, undefined);
  const prompt = requests[0].body.messages[0].content;
  const expectedSharedPrefix = [
    '次の会話セッションだけを根拠に、会話終了後の処理を1つ実行する。',
    '根拠はここに示す会話セッションだけ。',
    '',
    JSON.stringify({
      conversation_id: conversation.id,
      character_id: conversation.character_id,
      character_name: conversation.character_name,
      work_record_id: 'wr_conv_stage_flag',
      source_type: conversation.source_type,
      location_id: conversation.location_id,
      time_slot: conversation.time_slot,
      messages: conversation.messages
    }, null, 2),
    ''
  ].join('\n');
  assert.equal(prompt.slice(0, expectedSharedPrefix.length), expectedSharedPrefix);
  assert.doesNotMatch(prompt, /次の会話セッションだけを根拠に、キャラクターの継続記録を1レコード作成する。/);
  assert.doesNotMatch(prompt, /"role": "assistant"がキャラクターの発言であり、"role": "user"が主人公の発言である/);
  assert.doesNotMatch(prompt, /記録はキャラクター目線で作成する/);
  assert.doesNotMatch(prompt, /memory、skill\/self_change、work_recordは別々に保存される/);
  assert.match(prompt, /禁書庫に入り、その中でお茶会を開いたか/);
  assert.match(prompt, /回答はtrueもしくはfalseのみを返す/);
  assert.ok(prompt.indexOf('JSON、Markdownコードブロック、理由、補足、ラベル、IDは出力しない。') < prompt.indexOf('質問: 禁書庫に入り、その中でお茶会を開いたか'));
  assert.doesNotMatch(prompt, /candidate_flags/);
  assert.doesNotMatch(prompt, /flag_results/);

  const eventResult = await providers.eventFlagJudgmentProvider({
    conversation,
    workRecordId: 'wr_conv_stage_flag',
    candidateFlags: [{
      id: 'event.archive_teatime.ready',
      label: '禁書庫のお茶会イベント準備',
      condition: '禁書庫でのお茶会について、リナと主人公の間で具体的に行く約束が成立している。',
      question: 'リナと主人公が禁書庫でのお茶会へ向かう約束を具体的に成立させたか'
    }]
  });
  assert.deepEqual(eventResult, {
    flag_results: [{
      flag_id: 'event.archive_teatime.ready',
      achieved: true,
      raw_answer: 'true'
    }]
  });
  assert.equal(requests.length, 2);
  const eventPrompt = requests[1].body.messages[0].content;
  assert.match(eventPrompt, /これはイベントフラグ判定/);
  assert.match(eventPrompt, /リナと主人公が禁書庫でのお茶会へ向かう約束を具体的に成立させたか/);
  assert.match(eventPrompt, /回答はtrueもしくはfalseのみを返す/);
  assert.ok(eventPrompt.indexOf('JSON、Markdownコードブロック、理由、補足、ラベル、IDは出力しない。') < eventPrompt.indexOf('質問: リナと主人公が禁書庫でのお茶会へ向かう約束を具体的に成立させたか'));
  assert.doesNotMatch(eventPrompt, /candidate_flags/);
  assert.doesNotMatch(eventPrompt, /flag_results/);
});

test('emotion provider exposes every face_emotions variant in schema and prompt', async (t) => {
  const { baseUrl, requests } = await withStubServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ expression: 'determined' }) } }] }));
  });
  const providers = createLmStudioProviders({ config: { base_url: baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false } });

  const result = await providers.emotionProvider({
    profile: { display_name: 'セラ・アストルーペ' },
    currentConversation: [],
    playerInput: 'その羅針盤、今どっちを指してる？'
  });

  assert.deepEqual(result, { expression: 'determined' });
  const prompt = requests[0].body.messages[0].content;
  const enumValues = requests[0].body.response_format.json_schema.schema.properties.expression.enum;
  assert.deepEqual(enumValues, ['neutral', 'joy', 'caring', 'confident', 'sadness', 'worried', 'anger', 'surprised', 'embarrassed', 'shy', 'serious', 'determined', 'panic', 'tired', 'sick', 'smug']);
  assert.match(prompt, /使えるexpression: neutral, joy, caring, confident, sadness, worried, anger, surprised, embarrassed, shy, serious, determined, panic, tired, sick, smug/);
});

test('LM Studio requests keep the latest thirty titled input/output pairs for debug UI', async (t) => {
  clearLlmRequestLog();
  const { baseUrl } = await withStubServer(t, async (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `応答:${body.messages[0].content}` } }] }));
  });

  for (let index = 0; index < 35; index += 1) {
    await callLmStudioChat({
      config: { base_url: baseUrl, chat_model: 'gemma-4-31b', timeout_ms: 5000, stream: false },
      title: `テストリクエスト ${index}`,
      prompt: `入力 ${index}`
    });
  }

  const log = getRecentLlmRequests();
  assert.equal(log.requests.length, 30);
  assert.equal(log.requests[0].title, 'テストリクエスト 5');
  assert.equal(log.requests.at(-1).title, 'テストリクエスト 34');
  assert.equal(log.requests.at(-1).input, '入力 34');
  assert.equal(log.requests.at(-1).output, '応答:入力 34');
  assert.equal(log.requests.at(-1).kind, 'chat');
});
