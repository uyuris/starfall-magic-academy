// 足跡のまとめ: 「今日はここまで」（routing の title wrap-up）で門へ戻るときに、その足跡（セーブ）の遊び筋を
// 1〜2 文にまとめ、道行きの足跡の札と製品のセーブ選択の札の日時の下に出す。
//
// - 材料は hub 会話が開始時に持った束（conversation.routing_hub = buildRoutingHubContextSnapshot）の「現在状況」
//   （直近の行き先会話の記憶・直近の行き先の結果・相棒）に、束に無い好感度の順位・直近の週の行き先・今日の hub
//   会話の記憶を足したもの。
// - 生成は callLmStudioChat 1 本。出力は gate（空・複数行・上限超え・3 文以上は失敗）を通ったものだけを使い、
//   代わりの文は作らない。
// - 置き場は slot の runtime_state.json の `footprint_summary`（本文と書いた時刻）。項目が無いのは「まとめを
//   持たない」正規の状態で、札は日時だけになる。

import { promises as fs } from 'node:fs';
import { callLmStudioChat } from './lmStudioClient.mjs';
import { createStorageApi } from '../storage.mjs';
import { isSelectableCharacterId, selectableCharacterChoice } from '../characterCatalog.mjs';
import { characterAffinityPath, normalizeCharacterAffinityFile, CHARACTER_AFFINITY_INITIAL_VALUE } from '../affinityState.mjs';
import { isRoutingWeekProgressionRecordApplied } from '../graduationEnding.mjs';
import { routingDestinations } from '../routingDestinations.mjs';
import { routingPersonaDisplayName } from '../routingPersona.mjs';
import {
  normalizeRoutingHubContext,
  renderContentResultContext,
  renderRecentConversationContext
} from '../routingMetaContext.mjs';

export const FOOTPRINT_SUMMARY_STATE_KEY = 'footprint_summary';

// 札の幅（260px）で数行に収まる字数。1〜2 文の上限として gate にかける。
export const FOOTPRINT_SUMMARY_CAP = 70;

const RECENT_WEEK_COUNT = 3;
const SENTENCE_END_PATTERN = /[。！？!?]+/g;

function footprintSummaryError(message) {
  const error = new Error(message);
  error.errorCode = 'FOOTPRINT_SUMMARY_FAILED';
  return error;
}

// runtime_state の `footprint_summary` を読む。無ければ null（まとめを持たない足跡）。在るなら形を検査する。
export function readFootprintSummary(state) {
  if (!Object.prototype.hasOwnProperty.call(state, FOOTPRINT_SUMMARY_STATE_KEY)) return null;
  const record = state[FOOTPRINT_SUMMARY_STATE_KEY];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`runtime_state.${FOOTPRINT_SUMMARY_STATE_KEY} must be an object`);
  }
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error(`runtime_state.${FOOTPRINT_SUMMARY_STATE_KEY}.text must be a non-empty string`);
  }
  if (typeof record.written_at !== 'string' || Number.isNaN(Date.parse(record.written_at))) {
    throw new Error(`runtime_state.${FOOTPRINT_SUMMARY_STATE_KEY}.written_at must be an ISO timestamp`);
  }
  return { text: record.text, written_at: record.written_at };
}

export function withFootprintSummary(state, { text, writtenAt }) {
  return { ...state, [FOOTPRINT_SUMMARY_STATE_KEY]: { text, written_at: writtenAt } };
}

export function withoutFootprintSummary(state) {
  const { [FOOTPRINT_SUMMARY_STATE_KEY]: _removed, ...rest } = state;
  return rest;
}

// 相棒がいれば相棒。いなければ好感度が最も高いキャラ（同点は id の若い方）。誰も初期値を超えていなければ null。
// 名簿は学院キャラの content（characterContentRoot）から数え、好感度は全員分を 1 回ずつ読む（無い file は初期値）。
async function resolveClosestCharacter({ root, authoringRoot, relationshipContext }) {
  if (relationshipContext.buddy) {
    return { display_name: relationshipContext.buddy.display_name, reason: 'buddy' };
  }
  const storage = createStorageApi({ root });
  const characterIds = (await fs.readdir(storage.paths.characterContentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && isSelectableCharacterId(entry.name))
    .map((entry) => entry.name)
    .sort();
  let top = null;
  for (const characterId of characterIds) {
    const affinity = normalizeCharacterAffinityFile(
      await storage.readJsonIfExists(characterAffinityPath(characterId)),
      characterId
    ).affinity;
    if (!top || affinity > top.affinity) top = { characterId, affinity };
  }
  if (!top || top.affinity <= CHARACTER_AFFINITY_INITIAL_VALUE) return null;
  const choice = await selectableCharacterChoice({ root, authoringRoot, characterId: top.characterId });
  return { display_name: choice.display_name, reason: 'affinity', affinity: top.affinity };
}

function recentWeekDestinationLabels(state) {
  // 週がまだ一度も進んでいない slot は routing_week_progressions を持たない。
  if (!Object.prototype.hasOwnProperty.call(state, 'routing_week_progressions')) return [];
  if (!Array.isArray(state.routing_week_progressions)) throw new Error('runtime_state.routing_week_progressions must be an array');
  const labelById = new Map(routingDestinations.map((destination) => [destination.id, destination.label]));
  return state.routing_week_progressions
    .filter(isRoutingWeekProgressionRecordApplied)
    .slice(-RECENT_WEEK_COUNT)
    .map((record) => {
      const label = labelById.get(record.destination_id);
      if (!label) throw new Error(`unknown routing destination in week progression: ${record.destination_id}`);
      // 週の記録の elapsed_weeks は行き先を決めて進んだ後の値で、その行き先を過ごした週は第 elapsed_weeks+1 週。
      return { week: record.elapsed_weeks + 1, label };
    });
}

async function readHubConversationMemory({ root, conversationId }) {
  const storage = createStorageApi({ root });
  const validator = await storage.readJsonIfExists(`game_data/logs/validator/${conversationId}.json`);
  if (!validator) throw new Error(`validator log is missing for the wrapped-up hub conversation: ${conversationId}`);
  if (!Array.isArray(validator.accepted_memory)) {
    throw new Error(`validator accepted_memory must be an array for conversation: ${conversationId}`);
  }
  const text = validator.accepted_memory[0]?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

// まとめの材料を組む。hubConversation は wrap-up した hub 会話の記録（routing_hub を持つ）で、state は drain 後の
// runtime_state。hub 会話の記憶は drain が書いた validator log から読む。
export async function buildFootprintSummaryMaterial({ root, authoringRoot, state, hubConversation }) {
  if (!Number.isInteger(state.elapsed_weeks) || state.elapsed_weeks < 0) {
    throw new Error('runtime_state.elapsed_weeks must be a non-negative integer');
  }
  const hubContext = normalizeRoutingHubContext(hubConversation.routing_hub);
  if (hubContext === undefined) throw new Error(`hub conversation is missing routing_hub: ${hubConversation.id}`);
  const personaName = routingPersonaDisplayName(hubContext.persona_variant);
  return {
    week_number: state.elapsed_weeks + 1,
    closest: await resolveClosestCharacter({ root, authoringRoot, relationshipContext: hubContext.relationship_context }),
    recent_weeks: recentWeekDestinationLabels(state),
    current_context_lines: [
      ...renderRecentConversationContext(hubContext.recent_conversation_context, personaName),
      ...renderContentResultContext(hubContext.content_result_context)
    ],
    persona_name: personaName,
    hub_memory_text: await readHubConversationMemory({ root, conversationId: hubConversation.id })
  };
}

function renderClosest(closest) {
  if (!closest) return 'まだ特に近しい相手はいない。';
  if (closest.reason === 'buddy') return `${closest.display_name}（いまの相棒）。`;
  return `${closest.display_name}（好感度がいちばん高い。${closest.affinity}/100）。`;
}

export function buildFootprintSummaryPrompt(material) {
  const weeks = material.recent_weeks.length
    ? material.recent_weeks.map((entry) => `第${entry.week}週に${entry.label}`).join('、')
    : 'まだどこへも行っていない';
  return [
    'あなたは、魔法学院で過ごす主人公のセーブデータに添える短い覚え書きを書く。',
    '同じ主人公が遊んでいる別のセーブと並べたときに、このセーブがどういう遊び筋かが一目で見分けられるようにする。',
    '',
    'このセーブの様子:',
    `- いまは第${material.week_number}週。`,
    `- いちばん近しい相手: ${renderClosest(material.closest)}`,
    `- 直近の週の行き先: ${weeks}。`,
    ...material.current_context_lines,
    `- 今日${material.persona_name}と話したことで残った記憶: ${material.hub_memory_text ?? '特になし。'}`,
    '',
    '書き方:',
    `- 1文か2文、全体で${FOOTPRINT_SUMMARY_CAP}字以内。改行を入れない。`,
    `- 「第${material.week_number}週、」で書き始め、いちばん近しい相手と最近の出来事を、具体的な名前（人物名・行き先・書名・依頼名など）を入れた普通の文で書く。`,
    '- 句点で終わる文にする。「〜なし。」のような体言止めの断片を句点で並べない。',
    '- 近しい相手がまだいないときは、そのことには触れない。',
    '- 「ルーティングハブ」という呼び名は使わない。',
    '- 上の様子に書かれていないことは足さない。',
    '- 飾った語り口は要らない。見出し・前置き・鉤括弧は付けず、覚え書きの本文だけを書く。'
  ].join('\n');
}

export function gateFootprintSummary(text) {
  if (typeof text !== 'string' || !text.trim()) throw footprintSummaryError('footprint summary generation returned empty output');
  const trimmed = text.trim();
  if (/\n/.test(trimmed)) throw footprintSummaryError('footprint summary must be a single paragraph without line breaks');
  if (trimmed.length > FOOTPRINT_SUMMARY_CAP) {
    throw footprintSummaryError(`footprint summary exceeded the ${FOOTPRINT_SUMMARY_CAP} character cap: got ${trimmed.length}`);
  }
  const sentenceCount = trimmed.replace(SENTENCE_END_PATTERN, '。').split('。').filter((part) => part.trim()).length;
  if (sentenceCount > 2) throw footprintSummaryError(`footprint summary must be 1-2 sentences: got ${sentenceCount}`);
  return trimmed;
}

// provider=mock（決定的な test の口）のまとめ。材料の週と近しい相手から組み、LM は呼ばない。
export function mockFootprintSummary(material) {
  const scene = material.closest ? `${material.closest.display_name}と過ごした。` : '学院で過ごした。';
  return gateFootprintSummary(`第${material.week_number}週、${scene}`);
}

export async function generateFootprintSummary({ config, fetchImpl, material }) {
  if (!config) throw new Error('lmStudioConfig is required for footprint summary generation');
  const prompt = buildFootprintSummaryPrompt(material);
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: '足跡まとめ生成' });
  return gateFootprintSummary(text);
}
