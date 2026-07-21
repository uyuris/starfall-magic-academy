import { promises as fs } from 'node:fs';
import { faceExpressions } from '../faceExpressions.mjs';
import { conversationFinalizationStageFields } from '../routingMetaContext.mjs';
import { recordLlmRequest } from './llmRequestLog.mjs';

function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`LM Studio request timed out after ${timeoutMs}ms`)), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const LMSTUDIO_CONFIG_REQUIRED_MESSAGE = 'LM Studioの設定が必要です。設定画面で接続先とモデルを保存してください。';
const LMSTUDIO_CONNECTION_UNAVAILABLE_MESSAGE = 'LM Studioの接続が確認できません。LM Studioを起動し、設定画面で接続先とモデルを確認してください。';
const allowedThinkingEfforts = new Set(['low', 'medium', 'high']);

export function normalizeLmStudioThinkingEffort(value) {
  if (value === null || value === undefined) return null;
  return allowedThinkingEfforts.has(value) ? value : null;
}

function reasoningEffortForLmStudioConfig(config = {}) {
  return normalizeLmStudioThinkingEffort(config.thinking_effort) ?? 'none';
}

function lmStudioConfigRequiredError() {
  const error = new Error(LMSTUDIO_CONFIG_REQUIRED_MESSAGE);
  error.code = 'LMSTUDIO_CONFIG_REQUIRED';
  error.errorCode = 'LMSTUDIO_CONFIG_REQUIRED';
  error.statusCode = 503;
  return error;
}

function lmStudioConnectionUnavailableError(cause) {
  const error = new Error(LMSTUDIO_CONNECTION_UNAVAILABLE_MESSAGE);
  error.code = 'LMSTUDIO_CONNECTION_UNAVAILABLE';
  error.errorCode = 'LMSTUDIO_CONNECTION_UNAVAILABLE';
  error.statusCode = 503;
  error.cause = cause;
  return error;
}

function isLmStudioTransportError(error) {
  const name = String(error?.name ?? '');
  const code = String(error?.code ?? error?.cause?.code ?? '');
  const message = String(error?.message ?? error?.cause?.message ?? '');
  return name === 'AbortError'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH'
    || code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_SOCKET'
    || /fetch failed|failed to fetch|connection refused|connect timeout|timed out|bad port|terminated/i.test(message);
}

async function readLmStudioJsonBody(response, contentType) {
  try {
    return contentType.includes('application/json') ? await response.json() : JSON.parse(await response.text());
  } catch (error) {
    if (isLmStudioTransportError(error)) throw lmStudioConnectionUnavailableError(error);
    throw error;
  }
}

async function readLmStudioTextBody(response) {
  try {
    return await response.text();
  } catch (error) {
    if (isLmStudioTransportError(error)) throw lmStudioConnectionUnavailableError(error);
    throw error;
  }
}

const memoryUpdateResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'memory_update_record',
    schema: {
      type: 'object',
      properties: {
        memory_record: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            character_id: { type: 'string' },
            visibility: { type: 'string' },
            type: { type: 'string' },
            text: { type: 'string' },
            source_conversation_id: { type: 'string' },
            work_record_id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['id', 'character_id', 'visibility', 'type', 'text', 'source_conversation_id', 'work_record_id', 'tags']
        }
      },
      required: ['memory_record']
    }
  }
};

const skillUpdateResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'skill_update_record',
    schema: {
      type: 'object',
      properties: {
        skill_record: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            character_id: { type: 'string' },
            visibility: { type: 'string' },
            type: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            source_conversation_id: { type: 'string' },
            work_record_id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['id', 'character_id', 'visibility', 'type', 'name', 'description', 'source_conversation_id', 'work_record_id', 'tags']
        }
      },
      required: ['skill_record']
    }
  }
};

const faceExpressionChoices = faceExpressions;

const emotionChoiceResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'character_emotion_choice',
    schema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          enum: faceExpressionChoices
        }
      },
      required: ['expression']
    }
  }
};

const workRecordRecallResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'work_record_recall_choice',
    schema: {
      type: 'object',
      properties: {
        work_record_ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['work_record_ids']
    }
  }
};

const workRecordUpdateResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'work_record_update_record',
    schema: {
      type: 'object',
      properties: {
        work_record: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            character_id: { type: 'string' },
            source_conversation_id: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            flag_update_candidates: { type: 'array', items: { type: 'object' } },
            warnings: { type: 'array', items: { type: 'string' } }
          },
          required: ['id', 'character_id', 'source_conversation_id', 'title', 'summary', 'flag_update_candidates', 'warnings']
        }
      },
      required: ['work_record']
    }
  }
};

const stageFlagJudgmentResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'stage_flag_judgment_record',
    schema: {
      type: 'object',
      properties: {
        flag_results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              flag_id: { type: 'string' },
              achieved: { type: 'boolean' },
              reason: { type: 'string' }
            },
            required: ['flag_id', 'achieved', 'reason']
          }
        }
      },
      required: ['flag_results']
    }
  }
};

async function postChatCompletion({ config, model, messages, stream = false, responseFormat, fetchImpl = fetch, onDelta, title = 'LM Studio request', kind = 'unknown' }) {
  const baseUrl = trimSlash(config.base_url);
  if (!baseUrl) throw lmStudioConfigRequiredError();
  const modelId = String(model ?? '').trim();
  if (!modelId) throw lmStudioConfigRequiredError();
  const timeoutMs = Number(config.timeout_ms ?? 120000);
  const timeout = timeoutSignal(timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: timeout.signal,
        body: JSON.stringify({
          model: modelId,
          messages,
          stream,
          reasoning_effort: reasoningEffortForLmStudioConfig(config),
          ...(responseFormat ? { response_format: responseFormat } : {})
        })
      });
    } catch (error) {
      if (isLmStudioTransportError(error)) throw lmStudioConnectionUnavailableError(error);
      throw error;
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!response.ok) {
      const errorText = await readLmStudioTextBody(response);
      throw new Error(`LM Studio ${response.status}: ${errorText}`);
    }
    if (stream) {
      let streamedText;
      try {
        streamedText = await readSseText(response, onDelta);
      } catch (error) {
        if (isLmStudioTransportError(error)) throw lmStudioConnectionUnavailableError(error);
        throw error;
      }
      recordLlmRequest({ title, kind, input: messages.map((message) => message.content ?? '').join('\n\n'), output: streamedText });
      return streamedText;
    }
    const body = await readLmStudioJsonBody(response, contentType);
    const text = body.choices?.[0]?.message?.content ?? '';
    recordLlmRequest({ title, kind, input: messages.map((message) => message.content ?? '').join('\n\n'), output: text });
    return text;
  } finally {
    timeout.clear();
  }
}

async function readSseText(response, onDelta) {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const applyPayload = (payload) => {
    if (!payload || payload === '[DONE]') return;
    const event = JSON.parse(payload);
    const delta = event.choices?.[0]?.delta?.content ?? '';
    if (!delta) return;
    text += delta;
    onDelta?.(delta);
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        applyPayload(trimmed.slice(5).trim());
      }
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      applyPayload(trimmed.slice(5).trim());
    }
  }
  return text;
}

export function normalizeLmStudioConfig(config = {}) {
  return {
    timeout_ms: 120000,
    stream: true,
    mock_provider_enabled: true,
    ...config,
    stream: config.stream === undefined ? true : config.stream === true,
    thinking_effort: normalizeLmStudioThinkingEffort(config.thinking_effort)
  };
}

export async function loadLmStudioConfig(path) {
  return normalizeLmStudioConfig(JSON.parse(await fs.readFile(path, 'utf8')));
}

export async function callLmStudioChat({ config, prompt, fetchImpl, onDelta, title = 'キャラクター会話' }) {
  if (!prompt) throw new Error('prompt is required');
  return postChatCompletion({
    config,
    model: config.chat_model,
    messages: [{ role: 'user', content: prompt }],
    stream: config.stream === true,
    fetchImpl,
    onDelta,
    title,
    kind: 'chat'
  });
}

export async function callLmStudioStructuredJson({ config, prompt, fetchImpl, responseFormat, title = '構造化LLMリクエスト' }) {
  if (!prompt) throw new Error('prompt is required');
  const text = await postChatCompletion({
    config,
    model: config.reflection_model ?? config.chat_model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    responseFormat,
    fetchImpl,
    title,
    kind: 'structured_json'
  });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`LM Studio structured JSON parse failed: ${error.message}`);
  }
}

export async function callLmStudioReflectionText({ config, prompt, fetchImpl, title = '継続記録LLMリクエスト' }) {
  if (!prompt) throw new Error('prompt is required');
  return postChatCompletion({
    config,
    model: config.reflection_model ?? config.chat_model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    fetchImpl,
    title,
    kind: 'reflection_text'
  });
}

function stripPlainRecordFences(text) {
  return String(text ?? '').trim().replace(/^```(?:text|plain)?\s*/i, '').replace(/```$/i, '').trim();
}

function parsePlainTitleBody(text, fallbackTitle = '会話からの記録') {
  const source = stripPlainRecordFences(text);
  const titleMatch = source.match(/(?:^|\n)\s*タイトル\s*[:：]\s*(.*)/u);
  const bodyMatch = source.match(/(?:^|\n)\s*(?:本文|内容)\s*[:：]\s*([\s\S]*)/u);
  if (titleMatch || bodyMatch) {
    const rawTitle = titleMatch?.[1]?.trim() || fallbackTitle;
    const title = rawTitle.split('\n')[0].trim() || fallbackTitle;
    const body = (bodyMatch?.[1] ?? source.replace(titleMatch?.[0] ?? '', '')).trim();
    return { title, body: body || title };
  }
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = lines[0] || fallbackTitle;
  const body = lines.slice(1).join('\n').trim() || title;
  return { title, body };
}

function buildMemoryUpdateFromPlainText({ text, conversation, workRecordId }) {
  const body = stripPlainRecordFences(text);
  return {
    memory_record: {
      id: `mem_${conversation.id}`,
      character_id: conversation.character_id,
      visibility: 'character_known',
      type: 'relationship_change',
      text: body,
      source_conversation_id: conversation.id,
      work_record_id: workRecordId,
      tags: []
    }
  };
}

function buildSkillUpdateFromPlainText({ text, conversation, workRecordId }) {
  const parsed = parsePlainTitleBody(text, '会話からの自己変化');
  return {
    skill_record: {
      id: `skill_${conversation.id}`,
      character_id: conversation.character_id,
      visibility: 'character_known',
      type: 'self_change',
      name: parsed.title,
      description: parsed.body,
      source_conversation_id: conversation.id,
      work_record_id: workRecordId,
      tags: []
    }
  };
}

function buildWorkRecordUpdateFromPlainText({ text, conversation, workRecordId }) {
  const parsed = parsePlainTitleBody(text, '会話記録');
  return {
    work_record: {
      id: workRecordId,
      character_id: conversation.character_id,
      source_conversation_id: conversation.id,
      work_record_id: workRecordId,
      title: parsed.title,
      summary: parsed.body,
      flag_update_candidates: [],
      warnings: []
    }
  };
}

function buildEmotionChoicePrompt({ profile, currentConversation = [], playerInput }) {
  const displayName = profile?.display_name ?? 'キャラクター';
  const conversationText = currentConversation.length === 0 ? '- なし' : currentConversation.map((message) => {
    const speaker = message.role === 'assistant' ? displayName : 'プレイヤー';
    return `- ${speaker}: ${message.content ?? ''}`;
  }).join('\n');
  return [
    `次のプレイヤー入力を受け取った直後の${displayName}の感情を、顔アイコン用に1つだけ選ぶ。`,
    '返答本文はまだ書かない。expressionだけをJSONで返す。',
    `使えるexpression: ${faceExpressionChoices.join(', ')}`,
    '',
    '直前までの会話:',
    conversationText,
    '',
    `プレイヤーの発言: ${playerInput ?? ''}`
  ].join('\n');
}

function buildContinuityUpdatePrompt({ conversation, workRecordId, finalInstruction }) {
  return [
    '次の会話セッションだけを根拠に、キャラクターの継続記録を1レコード作成する。',
    '"role": "assistant"がキャラクターの発言であり、"role": "user"が主人公の発言である。記録はキャラクター目線で作成する。',
    '根拠はここに示す会話セッションだけ。会話全文を出力レコードへ転載しない。',
    '',
    JSON.stringify({
      conversation_id: conversation.id,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      work_record_id: workRecordId,
      ...conversationFinalizationStageFields(conversation),
      messages: conversation.messages
    }, null, 2),
    '',
    finalInstruction
  ].join('\n');
}

const continuitySubjectRule = 'キャラクター(assistant側)の行動・発言・変容などを記載する際は、必ずキャラクター名を主語として表記し、「AI」「assistant」「キャラクター」などの役割名では書かない。主人公(User側)の行動・発言を記載する際は、会話から名前が特定できる場合は必ずその名前を使い、そうでない場合は「主人公」を主語として使用する。';

function buildMemoryUpdatePrompt({ conversation, workRecordId }) {
  return buildContinuityUpdatePrompt({
    conversation,
    workRecordId,
    finalInstruction: `memory_recordの本文だけを平文で出力する。memory_recordの責務は、主人公との関係性変化と、その変化がどの経験・会話から生じたかを残すこと。textは最大5文。可能な限り具体的な情報を盛り込み、誰が何を言った・したか、どの場面や対象から変化が生じたかを省略しすぎない。${continuitySubjectRule}`
  });
}

function buildSkillNecessityPrompt({ conversation, workRecordId }) {
  return buildContinuityUpdatePrompt({
    conversation,
    workRecordId,
    finalInstruction: 'skill_record作成の必要性判定だけを行う。今後の振る舞いに決定的な影響を与える自己変化がこの会話で実際に起きた場合だけtrue、それ以外はfalse。回答はtrueもしくはfalseのみを返す。説明文、理由、補足、JSON、Markdownコードブロックは出力しない。'
  });
}

function buildSkillUpdatePrompt({ conversation, workRecordId }) {
  return buildContinuityUpdatePrompt({
    conversation,
    workRecordId,
    finalInstruction: `skill_recordのタイトルと本文を平文で出力する。出力形式は必ず「タイトル: ...」改行「本文: ...」だけにする。責務は、キャラクター自身の変化と、その変化がどの経験・会話から生じたかを残すこと。descriptionは必ず1文。${continuitySubjectRule}`
  });
}

function buildWorkRecordUpdatePrompt({ conversation, workRecordId }) {
  return buildContinuityUpdatePrompt({
    conversation,
    workRecordId,
    finalInstruction: `work_recordのタイトルと本文を平文で出力する。出力形式は必ず「タイトル: ...」改行「本文: ...」だけにする。work_recordの責務は、その会話セッションで行われたやり取りを、タイトルと最大20文の本文として残すこと。タイトルは1行。summaryは最大20文。具体的な情報をすべて盛り込み、誰が何を言った・したか、どの場面・対象・判断・変化があったかを決して省略せず、漏れが一切ないよう記述する。${continuitySubjectRule}`
  });
}

function buildConversationEndProcessingPrompt({ conversation, workRecordId, finalInstruction }) {
  return [
    '次の会話セッションだけを根拠に、会話終了後の処理を1つ実行する。',
    '根拠はここに示す会話セッションだけ。',
    '',
    JSON.stringify({
      conversation_id: conversation.id,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      work_record_id: workRecordId,
      ...conversationFinalizationStageFields(conversation),
      messages: conversation.messages
    }, null, 2),
    '',
    finalInstruction
  ].join('\n');
}

function buildStageFlagJudgmentPrompt({ conversation, workRecordId, flag }) {
  return buildConversationEndProcessingPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      'これは舞台フラグ判定であり、memory_record、skill_record、work_recordは出力しない。',
      '回答はtrueもしくはfalseのみを返す。',
      '会話内で具体的に成立している場合だけtrue。曖昧な連想、舞台名だけ、これから行う約束だけではfalse。',
      'JSON、Markdownコードブロック、理由、補足、ラベル、IDは出力しない。',
      `質問: ${flag.question ?? flag.condition}`
    ].join('\n')
  });
}

function buildEventFlagJudgmentPrompt({ conversation, workRecordId, flag }) {
  return buildConversationEndProcessingPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      'これはイベントフラグ判定であり、memory_record、skill_record、work_recordは出力しない。',
      '回答はtrueもしくはfalseのみを返す。',
      '会話内で具体的に成立している場合だけtrue。会話が行われた舞台は問わないが、曖昧な連想やこれから確認するだけの話はfalse。',
      'JSON、Markdownコードブロック、理由、補足、ラベル、IDは出力しない。',
      `質問: ${flag.question ?? flag.condition}`
    ].join('\n')
  });
}

function buildEventCompletionJudgmentPrompt({ conversation, workRecordId, flag }) {
  return buildConversationEndProcessingPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      'これはイベント完了フラグ判定であり、memory_record、skill_record、work_recordは出力しない。',
      `質問: ${flag.question ?? flag.condition}`,
      '回答はtrueもしくはfalseのみを返す。',
      'この会話内でイベント完了条件が具体的に成立している場合だけtrue。曖昧な示唆、これから倒す宣言、戦闘開始だけではfalse。',
      'JSON、Markdownコードブロック、理由、補足、ラベル、IDは出力しない。'
    ].join('\n')
  });
}

function buildEventParticipantOverrideJudgmentPrompt({ conversation, workRecordId, flag }) {
  return buildConversationEndProcessingPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      'これはイベント同行メンバー上書き判定であり、memory_record、skill_record、work_recordは出力しない。',
      `質問: ${flag.question ?? flag.condition}`,
      '回答はtrueもしくはfalseのみを返す。',
      'trueにするのは、主人公と会話相手が、この既に準備可能なイベントへ一緒に向かう・一緒に実行する準備をこの会話内で具体的に描写または合意した場合だけ。',
      '単なるイベントの噂、知識共有、将来いつか行こうという曖昧な約束、別の人物と行く話、現在の会話相手が同行する意思を示していない場合はfalse。',
      'JSON、Markdownコードブロック、理由、補足、ラベル、IDは出力しない。'
    ].join('\n')
  });
}

function parseBooleanOnlyAnswer(text) {
  return String(text ?? '').trim().toLowerCase() === 'true';
}

function parseSkillNecessityAnswer(text) {
  const rawAnswer = String(text ?? '').trim();
  const normalized = rawAnswer.toLowerCase();
  if (normalized === 'true') return { necessary: true, raw_answer: rawAnswer };
  if (normalized === 'false') return { necessary: false, raw_answer: rawAnswer };
  return { necessary: null, raw_answer: rawAnswer };
}

export function createLmStudioProviders({ config, fetchImpl, onChatDelta } = {}) {
  if (!config) throw new Error('config is required');
  return {
    chatProvider: ({ prompt }) => callLmStudioChat({ config, prompt, fetchImpl, onDelta: onChatDelta, title: 'キャラクター会話生成' }),
    emotionProvider: ({ profile, currentConversation, playerInput, prompt }) => callLmStudioStructuredJson({
      config,
      prompt: prompt ?? buildEmotionChoicePrompt({ profile, currentConversation, playerInput }),
      fetchImpl,
      responseFormat: emotionChoiceResponseFormat,
      title: '顔アイコン感情選択'
    }),
    workRecordRecallProvider: ({ prompt }) => callLmStudioStructuredJson({
      config,
      prompt,
      fetchImpl,
      responseFormat: workRecordRecallResponseFormat,
      title: 'work_record追加読込判定'
    }),
    conversationContinuationProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話終了判定'
    }),
    conversationCutoffProvider: ({ prompt }) => callLmStudioChat({
      config,
      prompt,
      fetchImpl,
      title: '会話切上げ発言生成'
    }),
    errandAchievementProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '依頼達成判定'
    }),
    errandWrapUpProvider: ({ prompt }) => callLmStudioChat({
      config,
      prompt,
      fetchImpl,
      title: '依頼切上げ発言生成'
    }),
    studyCircleAchievementProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '研究会達成判定'
    }),
    studyCircleWrapUpProvider: ({ prompt }) => callLmStudioChat({
      config,
      prompt,
      fetchImpl,
      title: '研究会切上げ発言生成'
    }),
    stageMoveAgreementProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話中移動合意判定'
    }),
    stageMoveDestinationProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話中移動先選択'
    }),
    stageMoveCutoffProvider: ({ prompt }) => callLmStudioChat({
      config,
      prompt,
      fetchImpl,
      title: '舞台移動カットオフ発言生成'
    }),
    stageMoveOpeningProvider: ({ prompt }) => callLmStudioChat({
      config,
      prompt,
      fetchImpl,
      title: '舞台移動後先行発話生成'
    }),
    routingDestinationProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: 'ルーティング行き先判定'
    }),
    routingTransitionProvider: ({ prompt }) => callLmStudioChat({
      config,
      prompt,
      fetchImpl,
      title: 'ルーティング見送り発話生成'
    }),
    routingGraduationGuideProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '卒業ガイド締めくくり相手判定'
    }),
    promptPrewarmProvider: ({ prompt }) => callLmStudioChat({ config, prompt, fetchImpl, title: 'プロンプト事前ウォーム' }),
    memoryUpdateProvider: async ({ conversation, workRecordId }) => buildMemoryUpdateFromPlainText({
      text: await callLmStudioReflectionText({
        config,
        prompt: buildMemoryUpdatePrompt({ conversation, workRecordId }),
        fetchImpl,
        title: 'memory更新作成'
      }),
      conversation,
      workRecordId
    }),
    skillNecessityJudgmentProvider: async ({ conversation, workRecordId }) => parseSkillNecessityAnswer(await callLmStudioReflectionText({
      config,
      prompt: buildSkillNecessityPrompt({ conversation, workRecordId }),
      fetchImpl,
      title: 'skill更新必要性判定'
    })),
    skillUpdateProvider: async ({ conversation, workRecordId }) => buildSkillUpdateFromPlainText({
      text: await callLmStudioReflectionText({
        config,
        prompt: buildSkillUpdatePrompt({ conversation, workRecordId }),
        fetchImpl,
        title: 'skill更新作成'
      }),
      conversation,
      workRecordId
    }),
    workRecordProvider: async ({ conversation, workRecordId }) => buildWorkRecordUpdateFromPlainText({
      text: await callLmStudioReflectionText({
        config,
        prompt: buildWorkRecordUpdatePrompt({ conversation, workRecordId }),
        fetchImpl,
        title: 'work_record更新作成'
      }),
      conversation,
      workRecordId
    }),
    moneyDeltaProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話後所持金増減判定'
    }),
    buddyAgreementProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話後バディ合意判定'
    }),
    enemyHostilityProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話後エネミー敵対判定'
    }),
    affinityDeltaProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話後好感度変化量判定'
    }),
    mpReserveProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '会話後MP温存ライン判定'
    }),
    stageFlagJudgmentProvider: async ({ conversation, workRecordId, candidateFlags }) => {
      const flagResults = [];
      for (const flag of candidateFlags) {
        const rawAnswer = await callLmStudioReflectionText({
          config,
          prompt: buildStageFlagJudgmentPrompt({ conversation, workRecordId, flag }),
          fetchImpl,
          title: `舞台フラグ判定: ${flag.label ?? flag.id}`
        });
        flagResults.push({
          flag_id: flag.id,
          achieved: parseBooleanOnlyAnswer(rawAnswer),
          raw_answer: String(rawAnswer ?? '').trim()
        });
      }
      return { flag_results: flagResults };
    },
    eventFlagJudgmentProvider: async ({ conversation, workRecordId, candidateFlags }) => {
      const flagResults = [];
      for (const flag of candidateFlags) {
        const rawAnswer = await callLmStudioReflectionText({
          config,
          prompt: buildEventFlagJudgmentPrompt({ conversation, workRecordId, flag }),
          fetchImpl,
          title: `イベントフラグ判定: ${flag.label ?? flag.id}`
        });
        flagResults.push({
          flag_id: flag.id,
          achieved: parseBooleanOnlyAnswer(rawAnswer),
          raw_answer: String(rawAnswer ?? '').trim()
        });
      }
      return { flag_results: flagResults };
    },
    eventParticipantOverrideJudgmentProvider: async ({ conversation, workRecordId, candidateFlags }) => {
      const flagResults = [];
      for (const flag of candidateFlags) {
        const rawAnswer = await callLmStudioReflectionText({
          config,
          prompt: buildEventParticipantOverrideJudgmentPrompt({ conversation, workRecordId, flag }),
          fetchImpl,
          title: `イベント同行メンバー上書き判定: ${flag.label ?? flag.id}`
        });
        flagResults.push({
          flag_id: flag.id,
          achieved: parseBooleanOnlyAnswer(rawAnswer),
          raw_answer: String(rawAnswer ?? '').trim()
        });
      }
      return { flag_results: flagResults };
    },
    eventCompletionJudgmentProvider: async ({ conversation, workRecordId, candidateFlags }) => {
      const flagResults = [];
      for (const flag of candidateFlags) {
        const rawAnswer = await callLmStudioReflectionText({
          config,
          prompt: buildEventCompletionJudgmentPrompt({ conversation, workRecordId, flag }),
          fetchImpl,
          title: `イベント完了フラグ判定: ${flag.label ?? flag.id}`
        });
        flagResults.push({
          flag_id: flag.id,
          achieved: parseBooleanOnlyAnswer(rawAnswer),
          raw_answer: String(rawAnswer ?? '').trim()
        });
      }
      return { flag_results: flagResults };
    }
  };
}

// 談話室 (lounge) group finalization providers: the 5 LM seams the aggregate lounge finalizer calls, once per
// seated participant. Unlike createLmStudioProviders' single-actor finalization providers (which build their own
// 1:1 prompt from a `conversation`), these consume the group-aware `prompt` the lounge finalizer pre-builds — a
// named, multi-speaker transcript with the target participant named — and shape the LM output into the same
// record shapes (`{memory_record}` / `{necessary,raw_answer}` / `{skill_record}` / `{work_record}` / a raw
// −10..+10 affinity string). The participant projection carries the group conversation id and the target
// participant identity so the produced record ids/attribution match the finalizer's participant-scoped write.
export function createLoungeFinalizationProviders({ config, fetchImpl } = {}) {
  if (!config) throw new Error('config is required');
  const projectionFor = (record, participant) => ({
    id: record.id,
    character_id: participant.character_id,
    character_name: participant.character_name
  });
  return {
    memoryUpdateProvider: async ({ prompt, record, participant, workRecordId }) => buildMemoryUpdateFromPlainText({
      text: await callLmStudioReflectionText({ config, prompt, fetchImpl, title: '談話memory更新作成' }),
      conversation: projectionFor(record, participant),
      workRecordId
    }),
    skillNecessityProvider: async ({ prompt }) => parseSkillNecessityAnswer(await callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '談話skill更新必要性判定'
    })),
    skillUpdateProvider: async ({ prompt, record, participant, workRecordId }) => buildSkillUpdateFromPlainText({
      text: await callLmStudioReflectionText({ config, prompt, fetchImpl, title: '談話skill更新作成' }),
      conversation: projectionFor(record, participant),
      workRecordId
    }),
    workRecordProvider: async ({ prompt, record, participant, workRecordId }) => buildWorkRecordUpdateFromPlainText({
      text: await callLmStudioReflectionText({ config, prompt, fetchImpl, title: '談話work_record更新作成' }),
      conversation: projectionFor(record, participant),
      workRecordId
    }),
    affinityDeltaProvider: ({ prompt }) => callLmStudioReflectionText({
      config,
      prompt,
      fetchImpl,
      title: '談話好感度変化量判定'
    })
  };
}
