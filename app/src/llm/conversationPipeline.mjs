import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildCharacterPrompt } from './promptBuilder.mjs';
import {
  buildConversationActorContextSnapshot,
  normalizeConversationActorContext
} from './conversationActorContext.mjs';
import { appendWeeklyActivityFacts } from '../weeklyActivityFacts.mjs';
import { buildContinuityPromptContext, mergeWorkRecordsById } from './continuityPromptContext.mjs';
import { faceExpressionChoicesText, faceExpressionSet } from '../faceExpressions.mjs';
import { buildDungeonCompanionPromptTailContext } from '../dungeon/dungeonEngine.mjs';
import {
  buildRoutingOpeningSmalltalkGuidance,
  buildRoutingPromptSceneFields,
  conversationFinalizationStageFields,
  INJECTED_SCENE_SOURCE_TYPES,
  normalizeRoutingHubContext,
  ROUTING_HUB_SOURCE_TYPE
} from '../routingMetaContext.mjs';
import { buildRoutingPersona, routingPersonaDisplayName, ROUTING_PERSONA_CHARACTER_ID } from '../routingPersona.mjs';
import { isGraduationEndingContext } from '../graduationEnding.mjs';
import {
  buildRoutingDestinationNarration,
  parseRoutingDestinationAnswer
} from '../routingDestinations.mjs';
import { routingDestinationsForState } from '../routingDestinationSelection.mjs';
import {
  buildGraduationGuideSelectionNarration,
  normalizeRoutingGraduationGuideContext,
  parseGraduationGuideSelectionAnswer
} from '../routingGraduationGuide.mjs';
import { loadWorldSettings } from '../worldSettings.mjs';
import { validateConversationRecordUpdates } from './validator.mjs';
import {
  applyAcceptedStageFlags,
  collectAcceptedStageFlagRewards,
  defaultStageFlagJudgmentProvider,
  judgeStageFlagsAfterConversation
} from '../stageFlags.mjs';
import {
  applyAcceptedEventCompletions,
  applyAcceptedEventFlags,
  applyAcceptedEventParticipantOverrides,
  defaultEventCompletionJudgmentProvider,
  defaultEventFlagJudgmentProvider,
  defaultEventParticipantOverrideJudgmentProvider,
  judgeEventCompletionsAfterConversation,
  judgeEventFlagsAfterConversation,
  judgeEventParticipantOverridesAfterConversation
} from '../eventFlags.mjs';
import { loadInventory, applyPlayerMoneyDelta, grantInventoryRewards } from '../economy.mjs';
import { selectRandomLocationSituation } from '../fieldRuntime.mjs';
import { createStorageApi } from '../storage.mjs';
import { runAtomicFinalizationWithStaging, runOutsideRoutingReadScope } from '../routingFinalizeQueue.mjs';
import {
  normalizeDialogueActorFlagsFile,
  normalizeDialogueActorSkillsFile,
  resolveDialogueActor
} from './dialogueActor.mjs';
import {
  BUDDY_AFFINITY_DELTA,
  ENEMY_AFFINITY_DELTA,
  applyCharacterAffinityDelta,
  parseAffinityDeltaAnswer
} from '../affinityState.mjs';
import { applyHomunculusAffinityDelta } from '../homunculusAffinity.mjs';
import { isSelectableCharacterId } from '../characterCatalog.mjs';
import { isHomunculusIdFormat } from '../companionRoster.mjs';
import {
  loadMpReserveSurface,
  mpReservePercentFor,
  parseMpReservePercentAnswer,
  setMpReservePercent
} from '../mpReserve.mjs';
import { CONTINUITY_RECORD_LIMIT, pruneRecordFilesToLimit } from '../continuityRecords.mjs';

const RECALLED_WORK_RECORD_PROMPT_TURNS = 10;
const STAGE_MOVE_AGREEMENT_RECENT_EXCHANGES = 3;
const ALLOWED_FACE_EXPRESSIONS = faceExpressionSet;
const CONVERSATION_EDIT_ITEM_ID = 'eternel_cube';
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

function storageFor(root) {
  return createStorageApi({ root });
}

async function readJson(root, relativePath) {
  return storageFor(root).readJson(relativePath);
}

async function readJsonIfExists(root, relativePath) {
  return storageFor(root).readJsonIfExists(relativePath);
}

async function readSkillsFile(root, characterId) {
  const actor = resolveDialogueActor(characterId);
  return normalizeDialogueActorSkillsFile(await readJsonIfExists(root, `${actor.basePath}/skills.json`), actor.id);
}

async function writeJson(root, relativePath, value) {
  await storageFor(root).writeJson(relativePath, value);
}

async function writeText(root, relativePath, value) {
  const fullPath = storageFor(root).resolveWritePath(relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, value, 'utf8');
}

async function listDirEntries(root, relativeDir, suffix) {
  const fullDir = await storageFor(root).resolveReadPath(relativeDir);
  try {
    const entries = await fs.readdir(fullDir);
    return entries.filter((entry) => entry.endsWith(suffix)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listJson(root, relativeDir) {
  return storageFor(root).listJson(relativeDir);
}

async function listMarkdownRecords(root, relativeDir) {
  return storageFor(root).listMarkdownRecords(relativeDir);
}

export function mergeDialogueActorFlagsIntoState({ state, actor, flagsFile }) {
  const flags = normalizeDialogueActorFlagsFile(flagsFile, actor.id);
  state[actor.stateCollection] ??= {};
  state[actor.stateCollection][actor.id] ??= { flags: {} };
  state[actor.stateCollection][actor.id].flags = {
    ...flags,
    ...(state[actor.stateCollection][actor.id].flags ?? {})
  };
  return state[actor.stateCollection][actor.id].flags;
}

function applyAcceptedFlagToActorState(state, candidate) {
  const next = state;
  const actor = resolveDialogueActor(candidate.character_id);
  next[actor.stateCollection] ??= {};
  next[actor.stateCollection][actor.id] ??= { flags: {} };
  next[actor.stateCollection][actor.id].flags ??= {};
  const actorFlags = next[actor.stateCollection][actor.id].flags;
  if (Object.prototype.hasOwnProperty.call(actorFlags, candidate.flag)) {
    applyFlagUpdate(actorFlags, candidate);
    return next;
  }
  if (Object.prototype.hasOwnProperty.call(next.global_flags ?? {}, candidate.flag)) {
    applyFlagUpdate(next.global_flags, candidate);
    return next;
  }
  throw new Error(`accepted flag is not defined for dialogue actor or global state: ${candidate.flag}`);
}

export async function writeDialogueActorFlagsFromState({ root, state, actorId }) {
  const actor = resolveDialogueActor(actorId);
  const flags = state?.[actor.stateCollection]?.[actor.id]?.flags;
  if (!flags) return;
  await writeJson(root, `${actor.basePath}/flags.json`, flags);
}

export async function pruneFilesToLimit(root, relativeDir, suffix, limit = CONTINUITY_RECORD_LIMIT) {
  return pruneRecordFilesToLimit({ storage: storageFor(root), relativeDir, suffix, limit });
}

function applyFlagUpdate(target, candidate) {
  if (candidate.op === 'set') target[candidate.flag] = candidate.value;
  else if (candidate.op === 'increment') target[candidate.flag] = (Number(target[candidate.flag]) || 0) + candidate.value;
  else throw new Error(`unsupported accepted flag op: ${candidate.op}`);
}

export function applyAcceptedFlags(state, validator) {
  const next = JSON.parse(JSON.stringify(state));
  for (const candidate of validator.accepted_flags) {
    applyAcceptedFlagToActorState(next, candidate);
  }
  return next;
}

function academyElapsedWeeksSnapshot(state) {
  const elapsedWeeks = Number(state?.elapsed_weeks);
  return Number.isFinite(elapsedWeeks) ? Math.max(0, Math.trunc(elapsedWeeks)) : 0;
}

function academyWeekNumberFromElapsedWeeks(elapsedWeeks) {
  return Math.max(1, Math.trunc(elapsedWeeks) + 1);
}

function academyWeekSnapshotFromState(state) {
  const academyElapsedWeeksAtStart = academyElapsedWeeksSnapshot(state);
  return {
    academy_elapsed_weeks_at_start: academyElapsedWeeksAtStart,
    academy_week_number: academyWeekNumberFromElapsedWeeks(academyElapsedWeeksAtStart)
  };
}

function academyWeekSnapshotForConversation({ conversation, state }) {
  const fallback = academyWeekSnapshotFromState(state);
  const weekNumber = Number(conversation?.academy_week_number);
  const elapsedWeeksAtStart = Number(conversation?.academy_elapsed_weeks_at_start);
  return {
    academy_week_number: Number.isInteger(weekNumber) && weekNumber >= 1 ? weekNumber : fallback.academy_week_number,
    academy_elapsed_weeks_at_start: Number.isInteger(elapsedWeeksAtStart) && elapsedWeeksAtStart >= 0
      ? elapsedWeeksAtStart
      : fallback.academy_elapsed_weeks_at_start
  };
}

export function renderWorkRecordMarkdown({ id, draft }) {
  const academyWeekNumber = Number.isInteger(draft.academy_week_number) && draft.academy_week_number >= 1
    ? draft.academy_week_number
    : 1;
  return `# ${draft.title}\n\nID: ${id}\n\n## 第${academyWeekNumber}週のサマリー\n\n${draft.summary}\n`;
}

function clampSentences(text, maxSentences) {
  const source = String(text ?? '').trim();
  if (!source) return source;
  const sentenceMatches = source.match(/[^。.!?！？]+[。.!?！？]+|[^。.!?！？]+$/gu) ?? [];
  return sentenceMatches.slice(0, maxSentences).join('').trim();
}

export function normalizeMemoryRecordForSave({ memoryUpdate, conversation, workRecordId }) {
  const memoryRecord = {
    ...(memoryUpdate.memory_record ?? memoryUpdate),
    visibility: 'character_known',
    source_conversation_id: conversation.id,
    work_record_id: workRecordId
  };
  return { ...memoryRecord, text: clampSentences(memoryRecord.text, 5) };
}

async function defaultChatProvider({ playerInput } = {}) {
  if (playerInput === null) return '……はい。まずはこの場所の様子を、落ち着いて見てみましょう。';
  return '……はい。今の話を手がかりに、目の前の状況から一つずつ確かめます。';
}

function makeConversationId(now) {
  const stamp = now.replace(/[^0-9A-Za-z]/g, '').replace(/Z$/, '').slice(0, 18);
  return `conv_${stamp}_${randomUUID().slice(0, 8)}`;
}

function invalidConversationIdError(conversationId) {
  const error = new Error(`invalid conversationId: ${conversationId}`);
  error.code = 'INVALID_CONVERSATION_ID';
  error.errorCode = 'invalid_conversation_id';
  error.statusCode = 400;
  return error;
}

function assertValidConversationId(conversationId) {
  const normalized = String(conversationId ?? '').trim();
  if (!normalized) throw invalidConversationIdError(conversationId);
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw invalidConversationIdError(conversationId);
  return normalized;
}

function conversationLogPath(conversationId) {
  return `game_data/logs/conversations/${assertValidConversationId(conversationId)}.json`;
}

function firstUserText(conversation) {
  return conversation.messages.find((message) => message.role === 'user')?.content ?? '会話した';
}

function firstAssistantText(conversation) {
  return conversation.messages.find((message) => message.role === 'assistant')?.content ?? 'リナが応答した';
}

export function buildEmotionChoicePrompt({ profile, currentConversation = [], playerInput }) {
  if (!profile?.display_name) throw new Error('profile.display_name is required');
  const conversationText = currentConversation.length === 0 ? '- なし' : currentConversation.map((message) => {
    const speaker = message.role === 'assistant' ? profile.display_name : 'プレイヤー';
    return `- ${speaker}: ${message.content}`;
  }).join('\n');
  return [
    `次のプレイヤー入力を受け取った直後の${profile.display_name}の感情を、顔アイコン用に1つだけ選ぶ。`,
    `使えるexpression: ${faceExpressionChoicesText}`,
    '返答本文はまだ書かない。JSONのexpressionだけを返す。',
    '',
    '直前までの会話:',
    conversationText,
    '',
    `プレイヤーの発言: ${playerInput ?? ''}`
  ].join('\n');
}

export function normalizeEmotionChoice(choice) {
  const rawExpression = typeof choice === 'string' ? choice : choice?.expression ?? choice?.emotion ?? choice?.face_emotion_variant_id;
  const expression = String(rawExpression ?? 'neutral').replace(/^face_/, '');
  const normalized = ALLOWED_FACE_EXPRESSIONS.has(expression) ? expression : 'neutral';
  return { expression: normalized, face_emotion_variant_id: `face_${normalized}` };
}

async function defaultEmotionProvider() {
  return { expression: 'neutral' };
}

async function defaultWorkRecordRecallProvider() {
  return { work_record_ids: [] };
}

async function defaultConversationContinuationProvider() {
  return true;
}

async function defaultConversationCutoffProvider({ profile } = {}) {
  return `${profile?.display_name ?? '相手'}は、ここで会話を切り上げることにした。`;
}

async function defaultStageMoveAgreementProvider() {
  return false;
}

async function defaultStageMoveDestinationProvider() {
  return 'none';
}

async function defaultStageMoveCutoffProvider({ profile } = {}) {
  return `${profile?.display_name ?? '相手'}は、移動のために今いる場所での会話を区切った。`;
}

async function defaultStageMoveOpeningProvider({ profile } = {}) {
  return `${profile?.display_name ?? '相手'}は、新しい場所の様子を静かに確かめた。`;
}

function assertRoutingDestinationProvider(provider) {
  if (typeof provider !== 'function') throw new Error('routingDestinationProvider is required when routingHubContext is provided');
}

function assertRoutingTransitionProvider(provider) {
  if (typeof provider !== 'function') throw new Error('routingTransitionProvider is required when a routing destination is decided');
}

function assertRoutingGraduationGuideProvider(provider) {
  if (typeof provider !== 'function') throw new Error('routingGraduationGuideProvider is required when the graduation guide is active');
}

// The conversation continuation (会話終了) judgment is a strict boolean true/false. LM output that is
// neither ('', 'maybe', JSON, ...) is invalid and fails fast with a structured error carrying
// INVALID_LLM_CONTINUATION_OUTPUT, thrown before the turn is persisted, so the client can surface the
// cause and route the player to the LM settings instead of the turn silently ending the conversation.
function parseConversationContinuationChoice(choice) {
  if (typeof choice === 'boolean') return choice;
  const text = String(choice ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  const error = new Error(`conversation continuation judgment must be true or false, got ${JSON.stringify(String(choice ?? '').trim())}`);
  error.code = 'INVALID_LLM_CONTINUATION_OUTPUT';
  error.errorCode = 'INVALID_LLM_CONTINUATION_OUTPUT';
  error.statusCode = 503;
  throw error;
}

// The errand achievement (依頼達成) judgment is a strict boolean true/false: true means the authored
// achievement condition has been met in the conversation, false means it has not yet. Any other output
// ('', 'maybe', JSON, ...) is invalid and fails fast with a structured error carrying
// INVALID_LLM_ERRAND_JUDGMENT_OUTPUT, thrown before the turn is persisted, so the client surfaces the
// cause (LM misbehavior) instead of the turn silently ending or not ending the errand. This is the single
// place errand achievement output is parsed.
function parseErrandAchievementJudgment(choice) {
  if (typeof choice === 'boolean') return choice;
  const text = String(choice ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  const error = new Error(`errand achievement judgment must be true or false, got ${JSON.stringify(String(choice ?? '').trim())}`);
  error.code = 'INVALID_LLM_ERRAND_JUDGMENT_OUTPUT';
  error.errorCode = 'INVALID_LLM_ERRAND_JUDGMENT_OUTPUT';
  error.statusCode = 503;
  throw error;
}

function assertErrandAchievementProvider(provider) {
  if (typeof provider !== 'function') throw new Error('errandAchievementProvider is required for an errand turn');
}

function assertErrandWrapUpProvider(provider) {
  if (typeof provider !== 'function') throw new Error('errandWrapUpProvider is required when an errand is achieved');
}

// The study circle achievement (研究会達成) judgment is the exact mirror of the errand one: a strict boolean
// true/false where true means the authored achievement condition has been met in the conversation. Any other
// output fails fast with a structured error carrying INVALID_LLM_STUDY_CIRCLE_JUDGMENT_OUTPUT, thrown before
// the turn is persisted, so the client surfaces the LM misbehavior instead of the turn silently ending or not
// ending the study circle. This is the single place study circle achievement output is parsed.
function parseStudyCircleAchievementJudgment(choice) {
  if (typeof choice === 'boolean') return choice;
  const text = String(choice ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  const error = new Error(`study circle achievement judgment must be true or false, got ${JSON.stringify(String(choice ?? '').trim())}`);
  error.code = 'INVALID_LLM_STUDY_CIRCLE_JUDGMENT_OUTPUT';
  error.errorCode = 'INVALID_LLM_STUDY_CIRCLE_JUDGMENT_OUTPUT';
  error.statusCode = 503;
  throw error;
}

function assertStudyCircleAchievementProvider(provider) {
  if (typeof provider !== 'function') throw new Error('studyCircleAchievementProvider is required for a study circle turn');
}

function assertStudyCircleWrapUpProvider(provider) {
  if (typeof provider !== 'function') throw new Error('studyCircleWrapUpProvider is required when a study circle is achieved');
}

function normalizeStrictBooleanChoice(choice, label) {
  const raw = typeof choice === 'object' && choice !== null
    ? choice.value ?? choice.answer ?? choice.agreed ?? choice.stage_move_agreement ?? choice.stageMoveAgreement
    : choice;
  if (typeof raw === 'boolean') return raw;
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

async function defaultPromptPrewarmProvider() {
  return '';
}

function serializePromptPrewarmError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error?.stack ? { stack: error.stack } : {})
  };
}

async function updatePromptPrewarmCache({ root, conversation, update }) {
  const current = await readJsonIfExists(root, conversationLogPath(conversation.id));
  if (!current) throw new Error(`conversation not found for prompt prewarm update: ${conversation.id}`);
  if (current.updated_at !== conversation.updated_at || (current.messages?.length ?? 0) !== conversation.messages.length) {
    await writeJson(root, `game_data/logs/prompt_prewarm_skipped/${conversation.id}.json`, {
      conversation_id: conversation.id,
      character_id: conversation.character_id,
      skipped_at: new Date().toISOString(),
      reason: 'conversation_advanced_before_prompt_prewarm_completed',
      expected_updated_at: conversation.updated_at,
      current_updated_at: current.updated_at,
      expected_message_count: conversation.messages.length,
      current_message_count: current.messages?.length ?? 0
    });
    return;
  }
  const currentCache = current.next_prompt_cache && typeof current.next_prompt_cache === 'object'
    ? current.next_prompt_cache
    : {};
  await writeJson(root, conversationLogPath(conversation.id), {
    ...current,
    next_prompt_cache: {
      ...currentCache,
      ...update
    }
  });
}

async function runPostVisiblePromptPrewarm({
  root,
  conversation,
  prewarmPrompt,
  state,
  profile,
  currentConversation,
  recalledWorkRecords,
  promptPrewarmProvider
}) {
  try {
    const prewarmText = await promptPrewarmProvider({
      prompt: prewarmPrompt,
      state,
      profile,
      currentConversation,
      recalledWorkRecords
    });
    await updatePromptPrewarmCache({
      root,
      conversation,
      update: { prewarm_text: prewarmText }
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const serializedError = serializePromptPrewarmError(error);
    await writeJson(root, `game_data/logs/prompt_prewarm_errors/${conversation.id}.json`, {
      conversation_id: conversation.id,
      character_id: conversation.character_id,
      failed_at: failedAt,
      recalled_work_record_ids: recalledWorkRecords.map((record) => record.id),
      error: serializedError
    });
    await updatePromptPrewarmCache({
      root,
      conversation,
      update: {
        prewarm_text: null,
        prewarm_error: {
          failed_at: failedAt,
          message: serializedError.message
        }
      }
    });
  }
}

function startPostVisiblePromptPrewarm(args) {
  runOutsideRoutingReadScope(() => {
    void runPostVisiblePromptPrewarm(args).catch((error) => {
      console.error('prompt prewarm background task failed', error);
    });
  });
}

function uniqueExistingWorkRecordIds(ids, allWorkRecords, limit = Infinity) {
  const existingIds = new Set(allWorkRecords.map((record) => record.id));
  const result = [];
  for (const rawId of ids ?? []) {
    const id = String(rawId ?? '').trim();
    if (!id || !existingIds.has(id) || result.includes(id)) continue;
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

function linkedWorkRecordIdsFromContinuity({ memories = [], skills = [] }) {
  return Array.from(new Set([
    ...memories.map((memory) => memory.work_record_id),
    ...skills.map((skill) => skill.work_record_id)
  ].filter(Boolean)));
}

function normalizePendingRecalledWorkRecords(conversation, allWorkRecords) {
  const existingIds = new Set(allWorkRecords.map((record) => record.id));
  const byId = new Map();
  for (const rawEntry of conversation?.pending_recalled_work_records ?? []) {
    const id = String(rawEntry?.id ?? rawEntry?.work_record_id ?? '').trim();
    if (!id || !existingIds.has(id)) continue;
    const turnsRemaining = Math.trunc(Number(rawEntry?.turns_remaining ?? rawEntry?.remaining_turns ?? 0));
    if (turnsRemaining <= 0) continue;
    byId.set(id, { id, turns_remaining: turnsRemaining });
  }
  for (const id of uniqueExistingWorkRecordIds(conversation?.pending_recalled_work_record_ids ?? [], allWorkRecords)) {
    if (!byId.has(id)) byId.set(id, { id, turns_remaining: RECALLED_WORK_RECORD_PROMPT_TURNS });
  }
  return Array.from(byId.values());
}

export function pendingRecalledWorkRecordIds(conversation, allWorkRecords) {
  return normalizePendingRecalledWorkRecords(conversation, allWorkRecords).map((entry) => entry.id);
}

function updatePendingRecalledWorkRecordsAfterTurn({ pendingEntries, recalledIds }) {
  const next = new Map();
  for (const entry of pendingEntries ?? []) {
    const turnsRemaining = Math.trunc(Number(entry.turns_remaining ?? 0));
    if (turnsRemaining > 1) next.set(entry.id, { id: entry.id, turns_remaining: turnsRemaining - 1 });
  }
  for (const id of recalledIds ?? []) {
    next.set(id, { id, turns_remaining: RECALLED_WORK_RECORD_PROMPT_TURNS });
  }
  return Array.from(next.values());
}

async function defaultMemoryUpdateProvider({ conversation, workRecordId, now }) {
  return {
    memory_record: {
      id: `mem_${conversation.id}`,
      character_id: conversation.character_id,
      visibility: 'character_known',
      type: 'relationship_change',
      text: `リナは、主人公が「${firstUserText(conversation)}」と声をかけたことで、主人公が薬草園の異常を一緒に確かめようとしている相手だと受け止めた。`,
      source_conversation_id: conversation.id,
      work_record_id: workRecordId,
      created_at: now,
      tags: [conversation.character_id, 'relationship_change', 'conversation']
    }
  };
}

async function defaultSkillNecessityProvider() {
  return { necessary: true, raw_answer: 'true' };
}

async function defaultSkillUpdateProvider({ conversation, workRecordId, now }) {
  return {
    skill_record: {
      id: `skill_${conversation.id}`,
      character_id: conversation.character_id,
      visibility: 'character_known',
      type: 'self_change',
      name: '会話からの自己変化',
      description: `リナは主人公との会話を通じて、気になる点を一人で抱え込まず相手に確認を求める意識を少し強めた。`,
      source_conversation_id: conversation.id,
      work_record_id: workRecordId,
      created_at: now,
      tags: [conversation.character_id, 'self_change', 'conversation']
    }
  };
}

async function defaultWorkRecordProvider({ conversation, workRecordId }) {
  return {
    work_record: {
      id: workRecordId,
      character_id: conversation.character_id,
      source_conversation_id: conversation.id,
      title: '放課後の薬草園で棚札の確認について話した',
      summary: `主人公はリナに「${firstUserText(conversation)}」と話しかけ、薬草園の棚札を一緒に確認しようとした。リナは「${firstAssistantText(conversation)}」と返し、記録と現場を落ち着いて見比べようとした。二人の間には、違和感をその場で確認する会話の流れが生まれた。`,
      flag_update_candidates: [
        { character_id: conversation.character_id, flag: `knowledge.${conversation.character_id}.player_checked_garden_label`, op: 'set', value: true }
      ],
      warnings: []
    }
  };
}

async function defaultMoneyDeltaProvider() {
  return '0';
}

async function defaultBuddyAgreementProvider() {
  return 'false';
}

async function defaultEnemyHostilityProvider() {
  return 'false';
}

function buildConversationFinalizationPrompt({ conversation, workRecordId, finalInstruction }) {
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

function buildMoneyDeltaPrompt({ conversation, workRecordId, currentMoney }) {
  return buildConversationFinalizationPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      '会話前後で増減したユーザーの所持金を判定する。',
      'ユーザーが得た金額は正の整数、支払った金額は負の整数、所持金の移動が成立していなければ0。',
      '回答は数値のみ。説明、単位、JSON、Markdownコードブロック、ラベルは出力しない。'
    ].join('\n')
  });
}

function buildAffinityDeltaPrompt({ conversation, workRecordId }) {
  return buildConversationFinalizationPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      '会話相手の主人公への好感度の変化量を判定する。',
      '好感度の変化量を判定する基準: +10=距離が決定的に縮まる出来事があった／+5=心に残る良い会話／+1〜3=感じの良い会話／0=特筆なし／−1〜3=引っかかり／−5=明確な不快／−10=決定的な失望・裏切り',
      '回答は−10〜+10 の整数のみを出力する。説明・単位・JSON・Markdown・ラベル禁止。'
    ].join('\n')
  });
}

function buildMpReservePrompt({ conversation, workRecordId, currentReservePercent }) {
  return buildConversationFinalizationPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      'ダンジョンで同行するとき、会話相手が残りMPの何%を「MP温存ライン」にしたいかを判定する。',
      'MP温存ラインとは、残りMPがその割合以下になったら攻撃に魔法・近接でMPを使うのをやめて回復のために温存する、という下限の割合。',
      `会話相手が現在設定しているMP温存ラインは ${currentReservePercent} %。この会話で本人が温存の方針について語っていなければ、同じ値をそのまま答える。`,
      'この会話で本人がMPをもっと残したい・温存したいと望んだなら値を上げ、もっと攻撃に使いたい・出し惜しみしないと望んだなら値を下げる。',
      '回答は0〜100の整数のみを出力する。説明・単位・記号・JSON・Markdown・ラベル禁止。'
    ].join('\n')
  });
}

function buildBuddyAgreementPrompt({ conversation, workRecordId }) {
  return buildConversationFinalizationPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      '会話相手と主人公がバディになる合意が相互に成立したかを判定する。',
      'trueにするのは、主人公側がバディになる意思を示し、会話相手側もその場で明確に承諾した場合だけ。',
      '片方だけの希望、将来の約束、冗談、曖昧な協力、単なる仲良し表現ではfalse。',
      '回答はtrueもしくはfalseのみを返す。',
      'JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。'
    ].join('\n')
  });
}

function buildEnemyHostilityPrompt({ conversation, workRecordId }) {
  return buildConversationFinalizationPrompt({
    conversation,
    workRecordId,
    finalInstruction: [
      '会話相手と主人公の敵対関係が相互に成立したかを判定する。',
      'trueにするのは、主人公側と会話相手側のどちらも、相手を敵・脅威・明確な対立相手として扱う意思をその場で示した場合だけ。',
      '一方的な怒り、軽い口論、競争、警戒、冗談、将来の可能性、単なる不仲表現ではfalse。',
      '回答はtrueもしくはfalseのみを返す。',
      'JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。'
    ].join('\n')
  });
}

function selectableDestinationLocations({ locations, currentLocationId, random }) {
  return (locations ?? [])
    .filter((location) => location?.screen === 'field')
    .filter((location) => location.id !== currentLocationId)
    .map((location) => ({
      location_id: String(location.id ?? '').trim(),
      location_name: String(location.display_name ?? location.id ?? '').trim(),
      location_visible_situation: selectRandomLocationSituation({ location, random })
    }))
    .filter((location) => location.location_id && location.location_name);
}

function parseMoneyDeltaAnswer(answer) {
  const raw = String(answer ?? '').trim();
  if (!/^[-+]?\d+$/u.test(raw)) return 0;
  return Math.trunc(Number(raw));
}

function parseBooleanOnlyAnswer(answer) {
  return String(answer ?? '').trim().toLowerCase() === 'true';
}

function parseStageMoveDestinationAnswer(answer, destinations) {
  const normalized = String(answer ?? '').trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === 'none') return null;
  const destinationMap = new Map((destinations ?? []).map((destination) => [destination.location_id, destination]));
  return destinationMap.get(normalized) ?? null;
}

function recentStageMoveConversation(messages) {
  return (messages ?? []).slice(-(STAGE_MOVE_AGREEMENT_RECENT_EXCHANGES * 2));
}

function buildStageMoveNarration(location) {
  const situation = String(location.location_visible_situation ?? '').trim();
  return situation ? `舞台は${location.location_name}へ移った。${situation}` : `舞台は${location.location_name}へ移った。`;
}

function stageMoveGuidanceMessage() {
  return 'この先に続く自然な発話を生成する。';
}

function buddyFlagId(characterId) {
  return `relationship.${characterId}.buddy`;
}

function enemyFlagId(characterId) {
  return `relationship.${characterId}.enemy`;
}

// Applies an established buddy agreement to runtime state. The buddy is exclusive across BOTH rosters:
// every previous buddy flag (in `characters` or `homunculi`) is cleared, then the new buddy's flag is set
// under its own collection (a homunculus id under `homunculi`, every other id under `characters`) and
// `current_buddy_character_id` is set to it. A non-established judgment is a no-op that keeps the current
// buddy. This is the finalization write path; the debug setter mirrors the same roster-crossing rule.
function applyBuddyAgreementToState(state, { characterId, established }) {
  const next = JSON.parse(JSON.stringify(state));
  next.characters ??= {};
  if (established) {
    for (const collectionName of ['characters', 'homunculi']) {
      const collection = next[collectionName];
      if (!collection) continue;
      for (const entry of Object.values(collection)) {
        if (!entry?.flags) continue;
        for (const key of Object.keys(entry.flags)) {
          if (key.startsWith('relationship.') && key.endsWith('.buddy')) delete entry.flags[key];
        }
      }
    }
    const collectionName = isHomunculusIdFormat(characterId) ? 'homunculi' : 'characters';
    next[collectionName] ??= {};
    next[collectionName][characterId] ??= { flags: {} };
    next[collectionName][characterId].flags ??= {};
    next[collectionName][characterId].flags[buddyFlagId(characterId)] = true;
    next.current_buddy_character_id = characterId;
  }
  return next;
}

function applyEnemyHostilityToState(state, { characterId, established }) {
  const next = JSON.parse(JSON.stringify(state));
  next.characters ??= {};
  const currentEnemyIds = Array.isArray(next.current_enemy_character_ids)
    ? next.current_enemy_character_ids.map((id) => String(id ?? '').trim()).filter(Boolean)
    : [];
  if (established) {
    next.characters[characterId] ??= { flags: {} };
    next.characters[characterId].flags ??= {};
    next.characters[characterId].flags[enemyFlagId(characterId)] = true;
    next.current_enemy_character_ids = [...new Set([...currentEnemyIds, characterId])];
  } else {
    next.current_enemy_character_ids = currentEnemyIds;
  }
  return next;
}

function scoreRecordForInput(record, playerInput) {
  const input = String(playerInput ?? '').toLowerCase();
  if (!input) return 0;
  const source = `${record.title}\n${record.body}\n${record.tags?.join(' ') ?? ''}`.toLowerCase();
  const tokens = Array.from(new Set(input.match(/[\p{Letter}\p{Number}_]+/gu) ?? [])).filter((token) => token.length >= 2);
  return tokens.reduce((score, token) => score + (source.includes(token) ? token.length : 0), 0);
}

export function selectRelevantWorkRecords(workRecords, playerInput, limit = 3) {
  return workRecords
    .map((record, index) => ({ record, index, score: scoreRecordForInput(record, playerInput) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map((item) => item.record);
}

async function readConversationIfExists(root, conversationId) {
  if (!conversationId) return null;
  return readJsonIfExists(root, conversationLogPath(conversationId));
}

function resolveActiveConversation({ state, characterId, providedId, conversation }) {
  if (conversation?.discarded_after_work_record_id) return null;
  if (providedId) return conversation?.character_id === characterId && conversation.id === providedId ? conversation : null;
  if (conversation?.character_id === characterId && state.current_interaction_character_id === characterId) return conversation;
  return null;
}

function normalizeConversationRoutingHubContext(conversation) {
  if (!Object.prototype.hasOwnProperty.call(conversation ?? {}, 'routing_hub')) return undefined;
  return normalizeRoutingHubContext(conversation.routing_hub);
}

function resolveRoutingHubActiveConversation({ activeConversation, requestedConversationId, routingHubContext }) {
  if (!activeConversation) return null;
  const conversationRoutingHubContext = normalizeConversationRoutingHubContext(activeConversation);
  if (conversationRoutingHubContext === undefined) {
    if (requestedConversationId && activeConversation.id === requestedConversationId) {
      throw new Error('routingHubContext cannot continue a non-routing conversation');
    }
    return null;
  }
  if (conversationRoutingHubContext.persona_variant !== routingHubContext.persona_variant) {
    throw new Error('routingHubContext persona_variant must match active routing conversation');
  }
  return activeConversation;
}

function conversationActorContextFromActiveConversation(conversation) {
  if (!Object.hasOwn(conversation ?? {}, 'conversation_actor_context')) {
    throw new Error('active conversation is missing conversation_actor_context');
  }
  return normalizeConversationActorContext(conversation.conversation_actor_context);
}

function assertRoutingHubOpeningConversationId({ existingConversation, routingHubContext }) {
  if (!existingConversation) return;
  const conversationRoutingHubContext = normalizeConversationRoutingHubContext(existingConversation);
  if (conversationRoutingHubContext === undefined) {
    throw new Error('routingHubContext cannot open over a non-routing conversation');
  }
  if (conversationRoutingHubContext.persona_variant !== routingHubContext.persona_variant) {
    throw new Error('routingHubContext persona_variant must match existing routing conversation');
  }
}

function cloneRuntimeState(state) {
  if (!state || typeof state !== 'object') throw new Error('runtime state is required');
  return JSON.parse(JSON.stringify(state));
}

export function academyPostTurnStatePolicy(state, { conversation, actorId, stageMove }) {
  if (!conversation?.id) throw new Error('postTurnStatePolicy conversation is required');
  if (!actorId) throw new Error('postTurnStatePolicy actorId is required');
  const nextState = cloneRuntimeState(state);
  nextState.last_conversation_id = conversation.id;
  nextState.current_screen = 'interaction';
  nextState.current_interaction_character_id = actorId;
  if (stageMove) {
    nextState.current_location_id = stageMove.to_location_id;
    nextState.current_location_visible_situation = stageMove.to_visible_situation;
  }
  return nextState;
}
Object.defineProperty(academyPostTurnStatePolicy, 'stageMoveEnabled', { value: true });

export function companionPostTurnStatePolicy(state) {
  return cloneRuntimeState(state);
}
Object.defineProperty(companionPostTurnStatePolicy, 'stageMoveEnabled', { value: false });

function assertPostTurnStatePolicy(postTurnStatePolicy) {
  if (typeof postTurnStatePolicy !== 'function') throw new Error('postTurnStatePolicy is required');
  if (typeof postTurnStatePolicy.stageMoveEnabled !== 'boolean') throw new Error('postTurnStatePolicy.stageMoveEnabled is required');
}

function enrichEventContextWithSourceWorkRecord(eventContext, allWorkRecords) {
  if (!eventContext || typeof eventContext !== 'object') return null;
  const sourceConversationId = String(eventContext.source_conversation_id ?? '').trim();
  const sourceWorkRecordId = sourceConversationId ? `wr_${sourceConversationId}` : '';
  const sourceWorkRecord = allWorkRecords.find((record) => record.id === sourceWorkRecordId);
  if (!sourceWorkRecord?.body) return { ...eventContext };
  return {
    ...eventContext,
    source_work_record_id: sourceWorkRecord.id,
    source_work_record_body: sourceWorkRecord.body
  };
}

// The token an authored persona-specific event context (e.g. the routing opening greeting) uses to
// refer to the speaker by name. It is interpolated with the speaking profile's display name at
// prompt-build time so the injected text follows the active persona (the selected routing variant)
// instead of baking in a fixed name.
export const EVENT_CONTEXT_PERSONA_NAME_TOKEN = '{{persona_name}}';

// The event context fields rendered into the prompt (renderEventContext: 「イベント: <event_label>」/
// 「イベント文脈: <opening_context>」). Both may carry the authored persona-name token, so both are
// interpolated — a token surviving into the prompt is a leak, not a display fallback.
const EVENT_CONTEXT_PERSONA_NAME_FIELDS = ['event_label', 'opening_context'];

function interpolateEventContextPersonaName(eventContext, displayName) {
  if (!eventContext || typeof eventContext !== 'object') return eventContext;
  const fieldsWithToken = EVENT_CONTEXT_PERSONA_NAME_FIELDS.filter(
    (field) => typeof eventContext[field] === 'string' && eventContext[field].includes(EVENT_CONTEXT_PERSONA_NAME_TOKEN)
  );
  if (fieldsWithToken.length === 0) return eventContext;
  if (typeof displayName !== 'string' || displayName === '') {
    throw new Error('a display name is required to interpolate the event context persona token');
  }
  const interpolated = { ...eventContext };
  for (const field of fieldsWithToken) {
    interpolated[field] = eventContext[field].split(EVENT_CONTEXT_PERSONA_NAME_TOKEN).join(displayName);
  }
  return interpolated;
}

export async function startInteractionSession({ root, characterId = 'lina' }) {
  if (!root) throw new Error('root is required');
  const actor = resolveDialogueActor(characterId);
  const state = await readJson(root, 'game_data/runtime_state.json');
  const nextState = JSON.parse(JSON.stringify(state));
  nextState.current_screen = 'interaction';
  nextState.current_interaction_character_id = actor.id;
  nextState.last_conversation_id = null;
  nextState.pending_interaction_context = null;
  await writeJson(root, 'game_data/runtime_state.json', nextState);
  return { state: nextState };
}

function assertRoutingHubActor(actorId, routingHubContext) {
  if (routingHubContext !== undefined && actorId !== ROUTING_PERSONA_CHARACTER_ID) {
    throw new Error(`routingHubContext requires characterId to be ${ROUTING_PERSONA_CHARACTER_ID}`);
  }
}

// The routing graduation phase-2 conversation with the guide persona (案内人自身) speaks in the effective
// routing persona of the save's variant — not the raw game_data/lina profile — even though it is an ordinary
// event conversation carrying no routing hub context. The gate is explicit (not an implicit fallback): the
// actor is the routing persona AND there is no hub context AND the active/pending context is the graduation
// ending event. A selectable roster partner (loop graduation or a character_### guide selection) fails this
// gate and keeps its own disk profile; the routing hub turn is handled by its own hub-context branch above.
function isGraduationPersonaPhase2({ actorId, routingHubContext, state, activeConversation }) {
  return actorId === ROUTING_PERSONA_CHARACTER_ID
    && routingHubContext === undefined
    && isGraduationEndingContext(state, activeConversation);
}

// The prompt profile for a guide-persona graduation phase 2. The effective variant must be supplied — a
// phase-2-with-lina turn that reaches here without a variant is a wiring bug, so fail fast rather than fall
// back to the disk lina profile.
function graduationPersonaPromptProfile(graduationPersonaVariant) {
  if (graduationPersonaVariant === undefined) {
    throw new Error('graduationPersonaVariant is required for the guide graduation phase 2 conversation');
  }
  return buildRoutingPersona(graduationPersonaVariant);
}

async function loadConversationContext({ root, characterId, state, playerInput = '', routingHubContext, graduationPersonaVariant }) {
  const actor = resolveDialogueActor(characterId);
  const actorId = actor.id;
  assertRoutingHubActor(actorId, routingHubContext);
  const [locations, profile, flags, skillsFile, memories, allWorkRecords, previousConversation, world] = await Promise.all([
    readJson(root, 'game_data/locations.json'),
    readJson(root, `${actor.basePath}/profile.json`),
    readJson(root, `${actor.basePath}/flags.json`),
    readSkillsFile(root, actorId),
    listJson(root, `${actor.basePath}/memory`),
    listMarkdownRecords(root, `${actor.basePath}/work_records`),
    readConversationIfExists(root, state.last_conversation_id),
    loadWorldSettings({ root })
  ]);
  mergeDialogueActorFlagsIntoState({ state, actor, flagsFile: flags });

  const resolvedActiveConversation = resolveActiveConversation({ state, characterId: actorId, conversation: previousConversation });
  const activeConversation = routingHubContext === undefined ? resolvedActiveConversation : null;
  const currentConversation = activeConversation?.messages ?? [];
  const pendingRecallIds = pendingRecalledWorkRecordIds(activeConversation, allWorkRecords);
  const pendingRecallRecords = allWorkRecords.filter((record) => pendingRecallIds.includes(record.id));
  const selectedWorkRecords = mergeWorkRecordsById(
    selectRelevantWorkRecords(allWorkRecords, playerInput),
    pendingRecallRecords
  );
  const continuityPromptContext = buildContinuityPromptContext({
    memories,
    workRecords: selectedWorkRecords,
    allWorkRecords
  });
  const location = locations.find((item) => item.id === state.current_location_id);
  const rawEventContext = state.current_interaction_character_id === actorId
    ? enrichEventContextWithSourceWorkRecord(state.pending_interaction_context ?? null, allWorkRecords)
    : null;
  const promptProfile = routingHubContext !== undefined
    ? buildRoutingPersona(routingHubContext.persona_variant)
    : isGraduationPersonaPhase2({ actorId, routingHubContext, state, activeConversation })
      ? graduationPersonaPromptProfile(graduationPersonaVariant)
      : profile;
  // Interpolate the authored persona-name token in the event context with the speaking profile's
  // display name, so an event greeting (e.g. the routing opening) names the active variant.
  const eventContext = interpolateEventContextPersonaName(rawEventContext, promptProfile.display_name);
  return {
    profile: promptProfile,
    actorProfile: profile,
    location,
    world,
    actor,
    skillsFile,
    memories: continuityPromptContext.memoriesForPrompt,
    activeConversation,
    currentConversation,
    selectedWorkRecords: continuityPromptContext.workRecordsForPrompt,
    eventContext
  };
}

// Validate an injected dungeon scene context. Fail fast (no silent fallback to
// the academy field scene) when a caller opts into the dungeon scene but does
// not supply a well-formed one.
function assertDungeonSceneContext(dungeonSceneContext) {
  if (typeof dungeonSceneContext !== 'object' || dungeonSceneContext === null) {
    throw new Error('dungeonSceneContext must be an object');
  }
  const locationName = String(dungeonSceneContext.location_name ?? '').trim();
  if (!locationName) throw new Error('dungeonSceneContext.location_name is required');
  if (typeof dungeonSceneContext.visible_situation !== 'string') {
    throw new Error('dungeonSceneContext.visible_situation must be a string');
  }
  const scene = { location_name: locationName, visible_situation: dungeonSceneContext.visible_situation };
  if (Object.prototype.hasOwnProperty.call(dungeonSceneContext, 'prompt_tail_context')) {
    if (typeof dungeonSceneContext.prompt_tail_context !== 'string') {
      throw new Error('dungeonSceneContext.prompt_tail_context must be a string');
    }
    const promptTailContext = dungeonSceneContext.prompt_tail_context.trim();
    if (!promptTailContext) throw new Error('dungeonSceneContext.prompt_tail_context must not be empty');
    scene.prompt_tail_context = promptTailContext;
  }
  return scene;
}

// The record-metadata scene an injected-scene conversation (dungeon / errand / study circle) carries in place
// of a field location. Each of these 舞台 is dynamic per session, so — unlike the hub, whose scene is a fixed
// constant recovered at finalization — the actual session scene is stamped onto the conversation record,
// letting conversationFinalizationStageFields reproduce it for the post-processing prompts. The injected scene
// context opts in by declaring one of the INJECTED_SCENE_SOURCE_TYPES as its source_type; an injected scene
// without a source_type declaration is not an injected-scene record and keeps the field descriptor unchanged.
// Returns null when there is no opt-in, or the { source_type, location_name, visible_situation } scene to stamp
// when there is. A declared source_type outside the injected-scene set is a caller bug and fails fast rather
// than silently degrading to a field record.
function injectedConversationRecordScene(dungeonSceneContext) {
  if (dungeonSceneContext === undefined || dungeonSceneContext === null) return null;
  if (typeof dungeonSceneContext !== 'object' || Array.isArray(dungeonSceneContext)) return null;
  if (!Object.prototype.hasOwnProperty.call(dungeonSceneContext, 'source_type')) return null;
  if (!INJECTED_SCENE_SOURCE_TYPES.has(dungeonSceneContext.source_type)) {
    throw new Error(`injected scene context source_type must be one of: ${[...INJECTED_SCENE_SOURCE_TYPES].join(', ')}`);
  }
  const scene = assertDungeonSceneContext(dungeonSceneContext);
  return {
    source_type: dungeonSceneContext.source_type,
    location_name: scene.location_name,
    visible_situation: scene.visible_situation
  };
}

// Builds the character-prompt scene. Two explicit modes selected by the caller,
// distinguished by whether `dungeonSceneContext` was passed at all (`undefined`),
// NOT by truthiness — so a provided-but-invalid value (e.g. null) fails fast
// instead of silently degrading to the academy scene:
// - undefined  → academy mode: derive the stage/situation from the player's
//   field location (that IS the academy's own scene, not a fallback).
// - anything else → dungeon mode: validate and use the injected dungeon scene;
//   a malformed value throws rather than degrading to the field scene.
function buildPromptScene({ world, state, location, dungeonSceneContext, routingHubContext, routingGraduationGuideContext }) {
  const base = {
    academy_name: world?.academy_name ?? '星灯魔法学院',
    world_description: world?.world_description ?? '',
    player_name: world?.player_name ?? '主人公',
    player_parameters: world?.player_parameters
  };
  if (routingHubContext !== undefined && dungeonSceneContext !== undefined) {
    throw new Error('routingHubContext and dungeonSceneContext cannot be used together');
  }
  if (dungeonSceneContext !== undefined) {
    const dungeon = assertDungeonSceneContext(dungeonSceneContext);
    return {
      ...base,
      location_name: dungeon.location_name,
      visible_situation: dungeon.visible_situation,
      ...(dungeon.prompt_tail_context ? { prompt_tail_context: dungeon.prompt_tail_context } : {})
    };
  }
  if (routingHubContext !== undefined) {
    return {
      ...base,
      ...buildRoutingPromptSceneFields({ state, routingHubContext, routingGraduationGuideContext })
    };
  }
  return {
    ...base,
    location_name: location?.display_name ?? state.current_location_id,
    visible_situation: state.current_location_visible_situation ?? location?.visible_situation ?? ''
  };
}

function dungeonSceneContextForPrompt({ dungeonSceneContext, state }) {
  if (dungeonSceneContext === undefined) return undefined;
  if (typeof dungeonSceneContext !== 'object' || dungeonSceneContext === null) return dungeonSceneContext;
  if (Object.prototype.hasOwnProperty.call(dungeonSceneContext, 'prompt_tail_context')) return dungeonSceneContext;
  if (state?.dungeon_run?.companion) {
    return {
      ...dungeonSceneContext,
      prompt_tail_context: buildDungeonCompanionPromptTailContext(state.dungeon_run)
    };
  }
  return dungeonSceneContext;
}

export async function runConversationOpening({
  root,
  id,
  characterId = 'lina',
  now = new Date().toISOString(),
  chatProvider = defaultChatProvider,
  characterSpeechConstraints = [],
  dungeonSceneContext,
  routingHubContext,
  graduationPersonaVariant,
  onAssistantComplete
}) {
  if (!root) throw new Error('root is required');
  const requestedConversationId = id == null ? null : assertValidConversationId(id);
  const promptRoutingHubContext = normalizeRoutingHubContext(routingHubContext);

  const state = await readJson(root, 'game_data/runtime_state.json');
  const context = await loadConversationContext({ root, characterId, state, routingHubContext: promptRoutingHubContext, graduationPersonaVariant });
  const requestedExistingConversation = promptRoutingHubContext !== undefined && requestedConversationId
    ? await readConversationIfExists(root, requestedConversationId)
    : null;
  assertRoutingHubOpeningConversationId({
    existingConversation: requestedExistingConversation,
    routingHubContext: promptRoutingHubContext
  });
  if (promptRoutingHubContext === undefined && !requestedConversationId && context.activeConversation?.messages?.length) {
    conversationActorContextFromActiveConversation(context.activeConversation);
    return { conversation: context.activeConversation, state };
  }
  const promptDungeonSceneContext = dungeonSceneContextForPrompt({ dungeonSceneContext, state });
  const injectedRecordScene = injectedConversationRecordScene(dungeonSceneContext);
  const conversationActorContext = appendWeeklyActivityFacts(
    await buildConversationActorContextSnapshot({
      root,
      actor: context.actor,
      profile: context.actorProfile
    }),
    state,
    context.actor.id
  );

  const prompt = buildCharacterPrompt({
    profile: context.profile,
    scene: buildPromptScene({
      world: context.world,
      state,
      location: context.location,
      dungeonSceneContext: promptDungeonSceneContext,
      routingHubContext: promptRoutingHubContext
    }),
    memories: context.memories,
    skills: context.skillsFile.skills ?? [],
    workRecords: context.selectedWorkRecords,
    currentConversation: [],
    eventContext: context.eventContext,
    characterSpeechConstraints,
    conversationActorContext,
    openingGuidanceContext: promptRoutingHubContext !== undefined
      ? buildRoutingOpeningSmalltalkGuidance(promptRoutingHubContext)
      : null,
    playerInput: null,
    openingTurn: true
  });

  const assistantText = await chatProvider({ prompt, state, profile: context.profile, playerInput: null });
  onAssistantComplete?.({ content: assistantText });
  const academyWeekSnapshot = academyWeekSnapshotFromState(state);
  const conversation = {
    id: requestedConversationId ?? assertValidConversationId(makeConversationId(now)),
    character_id: context.actor.id,
    character_name: context.profile.display_name,
    created_at: now,
    updated_at: now,
    academy_week_number: academyWeekSnapshot.academy_week_number,
    academy_elapsed_weeks_at_start: academyWeekSnapshot.academy_elapsed_weeks_at_start,
    source_type: promptRoutingHubContext !== undefined
      ? ROUTING_HUB_SOURCE_TYPE
      : injectedRecordScene !== null
        ? injectedRecordScene.source_type
        : state.pending_interaction_context?.source_type ?? 'field',
    event_flag_id: state.pending_interaction_context?.event_flag_id ?? null,
    event_label: state.pending_interaction_context?.event_label ?? null,
    source_conversation_id: state.pending_interaction_context?.source_conversation_id ?? null,
    // The routing hub and an injected-scene session (dungeon / errand / study) are not field locations: the
    // record omits location_id / time_slot (「該当しない」). The hub's 舞台 is a constant recovered at
    // finalization; an injected-scene 舞台 is dynamic per session, so its record carries that session's
    // location_name / visible_situation. Field sessions keep location_id / time_slot.
    ...(promptRoutingHubContext !== undefined
      ? {}
      : injectedRecordScene !== null
        ? { location_name: injectedRecordScene.location_name, visible_situation: injectedRecordScene.visible_situation }
        : { location_id: state.current_location_id, time_slot: state.time_slot }),
    conversation_actor_context: conversationActorContext,
    ...(promptRoutingHubContext !== undefined ? { routing_hub: promptRoutingHubContext } : {}),
    prompt,
    messages: [{ role: 'assistant', content: assistantText }]
  };
  await writeJson(root, conversationLogPath(conversation.id), conversation);

  const nextState = JSON.parse(JSON.stringify(state));
  nextState.last_conversation_id = conversation.id;
  nextState.current_screen = 'interaction';
  nextState.current_interaction_character_id = context.actor.id;
  await writeJson(root, 'game_data/runtime_state.json', nextState);

  return { conversation, state: nextState };
}

export async function editConversationUserMessage({
  root,
  characterId = 'lina',
  messageIndex,
  content,
  now = new Date().toISOString(),
  chatProvider = defaultChatProvider,
  emotionProvider = defaultEmotionProvider,
  workRecordRecallProvider = defaultWorkRecordRecallProvider,
  promptPrewarmProvider = defaultPromptPrewarmProvider,
  conversationContinuationProvider = defaultConversationContinuationProvider,
  conversationCutoffProvider = defaultConversationCutoffProvider,
  stageMoveAgreementProvider = defaultStageMoveAgreementProvider,
  stageMoveDestinationProvider = defaultStageMoveDestinationProvider,
  stageMoveCutoffProvider = defaultStageMoveCutoffProvider,
  stageMoveOpeningProvider = defaultStageMoveOpeningProvider,
  characterSpeechConstraints = []
}) {
  if (!root) throw new Error('root is required');
  const normalizedIndex = Math.trunc(Number(messageIndex));
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) throw new Error('messageIndex must be a non-negative integer');
  const playerInput = String(content ?? '').trim();
  if (!playerInput) throw new Error('content is required');

  const inventory = await loadInventory({ root });
  if (!(inventory.items ?? []).some((item) => item.item_id === CONVERSATION_EDIT_ITEM_ID && Number(item.quantity ?? 0) > 0)) {
    throw new Error('conversation_edit_item_required');
  }

  const actor = resolveDialogueActor(characterId);
  const actorId = actor.id;
  const state = await readJson(root, 'game_data/runtime_state.json');
  const previousConversation = await readConversationIfExists(root, state.last_conversation_id);
  const activeConversation = resolveActiveConversation({ state, characterId: actorId, conversation: previousConversation });
  if (!activeConversation) throw new Error('active conversation not found');
  const previousMessages = activeConversation.messages ?? [];
  if (!previousMessages[normalizedIndex] || previousMessages[normalizedIndex].role !== 'user') throw new Error('messageIndex must point to a user message');

  const rewoundConversation = {
    ...activeConversation,
    updated_at: now,
    messages: previousMessages.slice(0, normalizedIndex)
  };
  await writeJson(root, conversationLogPath(activeConversation.id), rewoundConversation);

  const result = await runConversationTurn({
    root,
    id: activeConversation.id,
    characterId: actorId,
    playerInput,
    now,
    chatProvider,
    emotionProvider,
    workRecordRecallProvider,
    promptPrewarmProvider,
    conversationContinuationProvider,
    conversationCutoffProvider,
    stageMoveAgreementProvider,
    stageMoveDestinationProvider,
    stageMoveCutoffProvider,
    stageMoveOpeningProvider,
    postTurnStatePolicy: academyPostTurnStatePolicy,
    characterSpeechConstraints
  });
  return {
    ...result,
    edited_message_index: normalizedIndex,
    rewound_from_message_count: previousMessages.length
  };
}

function giftReactionError(message, { statusCode, errorCode }) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

// The narration appended to the conversation record as the player-side event line when a gift / ally-boost
// item is handed over in conversation. It is a fixed scene line (地の文), not an LLM utterance, so the
// reaction that follows has an explicit hand-over to react to and the item stays in the ongoing transcript.
export function conversationGiftHandoverNarration({ itemName }) {
  const name = String(itemName ?? '').trim();
  if (!name) throw new Error('itemName is required for the gift handover narration');
  return `主人公が「${name}」を差し出した。`;
}

// Generates ONLY the recipient's reaction to a handed-over gift / ally-boost item. This is a dedicated,
// judgment-free generation seam: it builds one character prompt (turnType 'gift_reaction') from the active
// conversation transcript + persona + the item's name/description and returns the reaction text plus the
// hand-over narration. It runs no continuation / errand / study-circle / stage-move judgment and writes
// nothing — the caller's atomic economy transaction owns appending the two messages and applying the effect,
// so a generation failure (LM unreachable / empty output) fails fast (503) with nothing consumed or written.
export async function runConversationGiftReaction({
  root,
  conversationId,
  characterId,
  giftItem,
  chatProvider = defaultChatProvider,
  characterSpeechConstraints = [],
  dungeonSceneContext
}) {
  if (!root) throw new Error('root is required');
  const requestedConversationId = assertValidConversationId(conversationId);
  if (!giftItem || typeof giftItem !== 'object') throw new Error('giftItem is required');
  const itemName = String(giftItem.name ?? '').trim();
  if (!itemName) throw new Error('giftItem.name is required');
  const actor = resolveDialogueActor(characterId);
  const actorId = actor.id;

  const state = await readJson(root, 'game_data/runtime_state.json');
  const context = await loadConversationContext({ root, characterId: actorId, state, playerInput: '' });
  const activeConversation = context.activeConversation;
  if (!activeConversation || activeConversation.id !== requestedConversationId) {
    throw giftReactionError('no active conversation is open for this gift', {
      statusCode: 409,
      errorCode: 'GIFT_NO_ACTIVE_CONVERSATION'
    });
  }

  // Re-derive the routing hub snapshot from the persisted conversation, server-authoritatively, the same
  // discipline a hub continuation turn uses. When present, the guide (routing persona `lina`) is an explicitly
  // accepted recipient and reacts in the save's variant persona — never the raw disk lina profile. A hub
  // snapshot on any other actor is a wiring bug (fail fast, no silent fallback). When absent, the recipient
  // must be a selectable roster character; every other actor is rejected.
  const routingHubContext = normalizeConversationRoutingHubContext(activeConversation);
  if (routingHubContext === undefined) {
    if (!isSelectableCharacterId(actorId)) {
      throw giftReactionError(`conversation gift is only supported for selectable roster characters: ${actorId}`, {
        statusCode: 409,
        errorCode: 'GIFT_ACTOR_NOT_SELECTABLE'
      });
    }
  } else if (actorId !== ROUTING_PERSONA_CHARACTER_ID) {
    throw new Error(`routing hub gift requires actor ${ROUTING_PERSONA_CHARACTER_ID}`);
  }
  const promptProfile = routingHubContext !== undefined
    ? buildRoutingPersona(routingHubContext.persona_variant)
    : context.profile;

  const promptDungeonSceneContext = dungeonSceneContextForPrompt({ dungeonSceneContext, state });
  const scene = buildPromptScene({
    world: context.world,
    state,
    location: context.location,
    dungeonSceneContext: promptDungeonSceneContext,
    routingHubContext
  });
  const prompt = buildCharacterPrompt({
    profile: promptProfile,
    scene,
    memories: context.memories,
    skills: context.skillsFile.skills ?? [],
    workRecords: context.selectedWorkRecords,
    currentConversation: activeConversation.messages ?? [],
    characterSpeechConstraints,
    conversationActorContext: conversationActorContextFromActiveConversation(activeConversation),
    turnType: 'gift_reaction',
    giftItemName: itemName,
    giftItemDescription: giftItem.description ?? null,
    playerInput: null
  });

  const reactionText = String(await chatProvider({ prompt, state, profile: promptProfile, playerInput: null }) ?? '').trim();
  if (!reactionText) {
    throw giftReactionError('gift reaction generation produced no text', {
      statusCode: 503,
      errorCode: 'GIFT_REACTION_GENERATION_FAILED'
    });
  }
  return {
    conversation: activeConversation,
    reaction_text: reactionText,
    handover_narration: conversationGiftHandoverNarration({ itemName })
  };
}

export async function runConversationTurn({
  root,
  id,
  characterId = 'lina',
  playerInput,
  now = new Date().toISOString(),
  chatProvider = defaultChatProvider,
  emotionProvider = defaultEmotionProvider,
  workRecordRecallProvider = defaultWorkRecordRecallProvider,
  promptPrewarmProvider = defaultPromptPrewarmProvider,
  conversationContinuationProvider = defaultConversationContinuationProvider,
  conversationCutoffProvider = defaultConversationCutoffProvider,
  errandJudgmentContext,
  errandAchievementProvider,
  errandWrapUpProvider,
  studyCircleJudgmentContext,
  studyCircleAchievementProvider,
  studyCircleWrapUpProvider,
  stageMoveAgreementProvider = defaultStageMoveAgreementProvider,
  stageMoveDestinationProvider = defaultStageMoveDestinationProvider,
  stageMoveCutoffProvider = defaultStageMoveCutoffProvider,
  stageMoveOpeningProvider = defaultStageMoveOpeningProvider,
  routingDestinationProvider,
  routingTransitionProvider,
  routingGraduationGuideProvider,
  routingGraduationGuideContext,
  stageMoveLocationSituationRandom = Math.random,
  characterSpeechConstraints = [],
  dungeonSceneContext,
  routingHubContext,
  graduationPersonaVariant,
  onEmotion,
  onAssistantComplete,
  postTurnStatePolicy
}) {
  assertPostTurnStatePolicy(postTurnStatePolicy);
  if (!root) throw new Error('root is required');
  if (!playerInput) throw new Error('playerInput is required');
  const requestedConversationId = id == null ? null : assertValidConversationId(id);
  const promptRoutingHubContext = normalizeRoutingHubContext(routingHubContext);
  // The graduation guide (routing week-50) is a hub-only overlay: it presents the top-N characters and judges
  // the player's chosen graduation partner instead of a routing destination. It only applies to the routing
  // hub persona turn, so a guide context without a routing hub context is a wiring bug — fail fast.
  const promptRoutingGraduationGuideContext = normalizeRoutingGraduationGuideContext(routingGraduationGuideContext);
  if (promptRoutingGraduationGuideContext !== undefined && promptRoutingHubContext === undefined) {
    throw new Error('routingGraduationGuideContext requires routingHubContext');
  }

  const state = await readJson(root, 'game_data/runtime_state.json');
  const actor = resolveDialogueActor(characterId);
  const actorId = actor.id;
  assertRoutingHubActor(actorId, promptRoutingHubContext);
  const [locations, profile, flags, skillsFile, memories, allWorkRecords, previousConversation, world] = await Promise.all([
    readJson(root, 'game_data/locations.json'),
    readJson(root, `${actor.basePath}/profile.json`),
    readJson(root, `${actor.basePath}/flags.json`),
    readSkillsFile(root, actorId),
    listJson(root, `${actor.basePath}/memory`),
    listMarkdownRecords(root, `${actor.basePath}/work_records`),
    readConversationIfExists(root, state.last_conversation_id),
    loadWorldSettings({ root })
  ]);
  mergeDialogueActorFlagsIntoState({ state, actor, flagsFile: flags });

  const resolvedActiveConversation = resolveActiveConversation({ state, characterId: actorId, providedId: requestedConversationId, conversation: previousConversation });
  const activeConversation = promptRoutingHubContext === undefined
    ? resolvedActiveConversation
    : resolveRoutingHubActiveConversation({
      activeConversation: resolvedActiveConversation,
      requestedConversationId,
      routingHubContext: promptRoutingHubContext
    });
  const currentConversation = activeConversation?.messages ?? [];
  const pendingRecallEntries = normalizePendingRecalledWorkRecords(activeConversation, allWorkRecords);
  const pendingRecallIds = pendingRecallEntries.map((entry) => entry.id);
  const pendingRecallRecords = allWorkRecords.filter((record) => pendingRecallIds.includes(record.id));
  const selectedWorkRecords = mergeWorkRecordsById(
    selectRelevantWorkRecords(allWorkRecords, playerInput),
    pendingRecallRecords
  );
  const continuityPromptContext = buildContinuityPromptContext({
    memories,
    workRecords: selectedWorkRecords,
    allWorkRecords
  });
  const location = locations.find((item) => item.id === state.current_location_id);
  const promptDungeonSceneContext = dungeonSceneContextForPrompt({ dungeonSceneContext, state });
  const injectedRecordScene = injectedConversationRecordScene(dungeonSceneContext);
  // Defensive invariant against injected-scene route omissions. An in-progress injected-scene conversation
  // (dungeon / errand / study circle / atelier) must be continued with its injected scene re-supplied EVERY
  // turn — that scene is what stamps location_name / visible_situation back onto the record. If a caller
  // continues such a conversation without a scene (injectedRecordScene === null), the record below would
  // inherit the injected source_type but be written in the field shape (location_id / time_slot), which
  // finalization's stage-descriptor guard then rejects. Fail fast BEFORE any provider call or record write so
  // a route that forgets to inject the scene cannot corrupt the conversation log. A routing hub turn overrides
  // source_type to the hub type and is exempt; field / event / new_game / loop turns keep a non-injected
  // source_type and are byte-for-byte unaffected.
  if (
    promptRoutingHubContext === undefined
    && injectedRecordScene === null
    && activeConversation
    && INJECTED_SCENE_SOURCE_TYPES.has(activeConversation.source_type)
  ) {
    throw new Error(`${activeConversation.source_type} conversation must be continued with its injected scene`);
  }
  const promptProfile = promptRoutingHubContext !== undefined
    ? buildRoutingPersona(promptRoutingHubContext.persona_variant)
    : isGraduationPersonaPhase2({ actorId, routingHubContext: promptRoutingHubContext, state, activeConversation })
      ? graduationPersonaPromptProfile(graduationPersonaVariant)
      : profile;
  const conversationActorContext = activeConversation
    ? conversationActorContextFromActiveConversation(activeConversation)
    : appendWeeklyActivityFacts(
      await buildConversationActorContextSnapshot({ root, actor, profile }),
      state,
      actor.id
    );
  const promptArgs = {
    profile: promptProfile,
    scene: buildPromptScene({
      world,
      state,
      location,
      dungeonSceneContext: promptDungeonSceneContext,
      routingHubContext: promptRoutingHubContext,
      routingGraduationGuideContext: promptRoutingGraduationGuideContext
    }),
    memories: continuityPromptContext.memoriesForPrompt,
    skills: skillsFile.skills ?? [],
    workRecords: continuityPromptContext.workRecordsForPrompt,
    currentConversation,
    characterSpeechConstraints,
    conversationActorContext,
    eventContext: state.current_interaction_character_id === actorId
      ? enrichEventContextWithSourceWorkRecord(state.pending_interaction_context ?? null, allWorkRecords)
      : null,
    playerInput
  };
  // (A) On a graduation guide continuation turn the persona's speech uses a dedicated final instruction
  // (turnType 'graduation_guide_reply') instead of the default one, so it presents the partner candidates and
  // draws out the choice rather than routing to a normal destination. An explicit branch on the guide context —
  // no silent fallback — keeps every non-guide reply on the unchanged default instruction. The emotion / helper
  // prompts keep the default turnType and are byte-equivalent.
  const prompt = promptRoutingGraduationGuideContext !== undefined
    ? buildCharacterPrompt({
      ...promptArgs,
      turnType: 'graduation_guide_reply',
      graduationGuideCandidates: promptRoutingGraduationGuideContext.candidates
    })
    : buildCharacterPrompt(promptArgs);

  const emotionPrompt = buildCharacterPrompt({ ...promptArgs, turnType: 'emotion_choice' });
  const emotion = normalizeEmotionChoice(await emotionProvider({ prompt: emotionPrompt, state, profile: promptProfile, playerInput, currentConversation }));
  onEmotion?.(emotion);

  const generatedAssistantText = await chatProvider({ prompt, state, profile: promptProfile, playerInput, emotion });
  onAssistantComplete?.({ content: generatedAssistantText, emotion });
  const provisionalMessages = [
    ...currentConversation,
    { role: 'user', content: playerInput },
    { role: 'assistant', content: generatedAssistantText, ...emotion }
  ];
  let continueConversation;
  let continuationPrompt = null;
  let continuationModelResponse = null;
  let cutoffPrompt = null;
  let cutoffAssistantText = null;
  let errandAchievementJudgment = null;
  let errandAchievement = null;
  let studyCircleAchievementJudgment = null;
  let studyCircleAchievement = null;
  let graduationGuideSelectionJudgment = null;
  let graduationGuideSelection = null;
  let nextMessages;
  if (promptRoutingGraduationGuideContext !== undefined) {
    // Graduation guide turn (routing week 50): the partner-selection judgment REPLACES the continuation
    // judgment. The guide conversation continues until the player picks one of the presented characters — it
    // is never unilaterally cut off by the persona and never decides a routing destination. A judged 'none'
    // (or the strict parser rejecting an unusable answer) keeps the conversation going; a matched candidate id
    // confirms the graduation partner and ends this turn so phase 2 (the character event) can begin.
    assertRoutingGraduationGuideProvider(routingGraduationGuideProvider);
    const candidates = promptRoutingGraduationGuideContext.candidates;
    // The guide persona (案内人自身) is a permanent selection option alongside the memory-ranked candidates:
    // its id is the fixed routing persona actor id, its display name the effective variant proper name. It is
    // presented to the judgment (in the candidate table) and accepted by the parse, so the presented options
    // and the closed judgment set never disagree. A guide turn always carries the hub context (asserted
    // above), so the variant is available here without threading graduationPersonaVariant.
    const guidePersonaOption = {
      character_id: ROUTING_PERSONA_CHARACTER_ID,
      display_name: routingPersonaDisplayName(promptRoutingHubContext.persona_variant)
    };
    const selectionCandidates = [...candidates, guidePersonaOption];
    const selectionPrompt = buildCharacterPrompt({
      ...promptArgs,
      currentConversation: provisionalMessages,
      playerInput: null,
      turnType: 'graduation_guide_selection',
      graduationGuideCandidates: selectionCandidates
    });
    const selectionModelResponse = await routingGraduationGuideProvider({
      prompt: selectionPrompt,
      state,
      profile: promptProfile,
      playerInput,
      generatedAssistantText,
      currentConversation: provisionalMessages,
      candidates: selectionCandidates
    });
    const selectedCandidate = parseGraduationGuideSelectionAnswer(selectionModelResponse, candidates, guidePersonaOption);
    continueConversation = selectedCandidate === null;
    if (selectedCandidate) {
      const narration = buildGraduationGuideSelectionNarration(selectedCandidate);
      nextMessages = [
        ...provisionalMessages,
        { role: 'system', content: narration }
      ];
      graduationGuideSelection = {
        character_id: selectedCandidate.character_id,
        display_name: selectedCandidate.display_name,
        narration
      };
    } else {
      nextMessages = provisionalMessages;
    }
    graduationGuideSelectionJudgment = {
      prompt: selectionPrompt,
      model_response: String(selectionModelResponse ?? '').trim(),
      decided: selectedCandidate !== null,
      character_id: selectedCandidate?.character_id ?? null,
      candidate_character_ids: candidates.map((candidate) => candidate.character_id),
      ...(selectedCandidate ? { display_name: selectedCandidate.display_name, narration: graduationGuideSelection.narration } : {})
    };
  } else if (errandJudgmentContext !== undefined) {
    // Errand turn: the per-turn achievement judgment REPLACES the continuation judgment. An errand ends
    // only by achievement (server-side auto-end, this turn) or by the player's manual exit; the client
    // character never unilaterally cuts an errand off. condition_text is the authored, per-type achievement
    // condition, judged against the full provisional transcript as a strict true/false.
    assertErrandAchievementProvider(errandAchievementProvider);
    const conditionText = errandJudgmentContext.condition_text;
    if (typeof conditionText !== 'string' || !conditionText.trim()) {
      throw new Error('errandJudgmentContext.condition_text is required for an errand turn');
    }
    const achievementPrompt = buildCharacterPrompt({
      ...promptArgs,
      currentConversation: provisionalMessages,
      playerInput: null,
      turnType: 'errand_achievement_judgment',
      errandCondition: conditionText
    });
    const achievementModelResponse = await errandAchievementProvider({
      prompt: achievementPrompt,
      state,
      profile: promptProfile,
      playerInput,
      generatedAssistantText,
      currentConversation: provisionalMessages,
      condition_text: conditionText
    });
    const achieved = parseErrandAchievementJudgment(achievementModelResponse);
    continueConversation = !achieved;
    let wrapUpPrompt = null;
    let wrapUpAssistantText = null;
    if (achieved) {
      assertErrandWrapUpProvider(errandWrapUpProvider);
      wrapUpPrompt = buildCharacterPrompt({
        ...promptArgs,
        currentConversation: provisionalMessages,
        turnType: 'errand_wrap_up_reply',
        generatedAssistantText
      });
      wrapUpAssistantText = String(await errandWrapUpProvider({
        prompt: wrapUpPrompt,
        state,
        profile: promptProfile,
        playerInput,
        emotion,
        generatedAssistantText,
        currentConversation: provisionalMessages,
        condition_text: conditionText
      }) ?? '').trim();
      if (!wrapUpAssistantText) throw new Error('errand wrap-up reply is required');
      onAssistantComplete?.({ content: wrapUpAssistantText, emotion });
      nextMessages = [
        ...provisionalMessages,
        { role: 'assistant', content: wrapUpAssistantText, ...emotion }
      ];
      errandAchievement = {
        condition_text: conditionText,
        model_response: String(achievementModelResponse ?? '').trim(),
        wrap_up_assistant_text: wrapUpAssistantText
      };
    } else {
      nextMessages = provisionalMessages;
    }
    errandAchievementJudgment = {
      condition_text: conditionText,
      prompt: achievementPrompt,
      model_response: String(achievementModelResponse ?? '').trim(),
      achieved,
      generated_assistant_text: generatedAssistantText,
      wrap_up_prompt: wrapUpPrompt,
      wrap_up_assistant_text: wrapUpAssistantText
    };
  } else if (studyCircleJudgmentContext !== undefined) {
    // Study circle turn: the exact mirror of the errand branch above. The per-turn achievement judgment
    // REPLACES the continuation judgment; a study circle ends only by achievement (server-side auto-end, this
    // turn) or by the player's manual exit, never by a unilateral character cutoff. condition_text is the
    // authored, per-type achievement condition, judged against the full provisional transcript as a strict
    // true/false.
    assertStudyCircleAchievementProvider(studyCircleAchievementProvider);
    const conditionText = studyCircleJudgmentContext.condition_text;
    if (typeof conditionText !== 'string' || !conditionText.trim()) {
      throw new Error('studyCircleJudgmentContext.condition_text is required for a study circle turn');
    }
    const achievementPrompt = buildCharacterPrompt({
      ...promptArgs,
      currentConversation: provisionalMessages,
      playerInput: null,
      turnType: 'study_circle_achievement_judgment',
      studyCircleCondition: conditionText
    });
    const achievementModelResponse = await studyCircleAchievementProvider({
      prompt: achievementPrompt,
      state,
      profile: promptProfile,
      playerInput,
      generatedAssistantText,
      currentConversation: provisionalMessages,
      condition_text: conditionText
    });
    const achieved = parseStudyCircleAchievementJudgment(achievementModelResponse);
    continueConversation = !achieved;
    let wrapUpPrompt = null;
    let wrapUpAssistantText = null;
    if (achieved) {
      assertStudyCircleWrapUpProvider(studyCircleWrapUpProvider);
      wrapUpPrompt = buildCharacterPrompt({
        ...promptArgs,
        currentConversation: provisionalMessages,
        turnType: 'study_circle_wrap_up_reply',
        generatedAssistantText
      });
      wrapUpAssistantText = String(await studyCircleWrapUpProvider({
        prompt: wrapUpPrompt,
        state,
        profile: promptProfile,
        playerInput,
        emotion,
        generatedAssistantText,
        currentConversation: provisionalMessages,
        condition_text: conditionText
      }) ?? '').trim();
      if (!wrapUpAssistantText) throw new Error('study circle wrap-up reply is required');
      onAssistantComplete?.({ content: wrapUpAssistantText, emotion });
      nextMessages = [
        ...provisionalMessages,
        { role: 'assistant', content: wrapUpAssistantText, ...emotion }
      ];
      studyCircleAchievement = {
        condition_text: conditionText,
        model_response: String(achievementModelResponse ?? '').trim(),
        wrap_up_assistant_text: wrapUpAssistantText
      };
    } else {
      nextMessages = provisionalMessages;
    }
    studyCircleAchievementJudgment = {
      condition_text: conditionText,
      prompt: achievementPrompt,
      model_response: String(achievementModelResponse ?? '').trim(),
      achieved,
      generated_assistant_text: generatedAssistantText,
      wrap_up_prompt: wrapUpPrompt,
      wrap_up_assistant_text: wrapUpAssistantText
    };
  } else {
    continuationPrompt = buildCharacterPrompt({
      ...promptArgs,
      turnType: 'conversation_continuation_judgment'
    });
    continuationModelResponse = await conversationContinuationProvider({
      prompt: continuationPrompt,
      state,
      profile: promptProfile,
      playerInput,
      generatedAssistantText,
      currentConversation: provisionalMessages
    });
    continueConversation = parseConversationContinuationChoice(continuationModelResponse);
    cutoffPrompt = continueConversation ? null : buildCharacterPrompt({
      ...promptArgs,
      turnType: 'conversation_cutoff_reply',
      generatedAssistantText
    });
    cutoffAssistantText = continueConversation ? null : await conversationCutoffProvider({
      prompt: cutoffPrompt,
      state,
      profile: promptProfile,
      playerInput,
      emotion,
      generatedAssistantText,
      currentConversation: provisionalMessages
    });
    if (cutoffAssistantText) {
      onAssistantComplete?.({ content: cutoffAssistantText, emotion });
    }
    nextMessages = continueConversation ? provisionalMessages : [
      ...provisionalMessages,
      { role: 'assistant', content: cutoffAssistantText, ...emotion }
    ];
  }
  let stageMove = null;
  let routingDestinationResult = null;
  let routingDestinationJudgment = null;
  let postTurnPromptArgs = promptArgs;
  if (continueConversation && promptRoutingHubContext !== undefined && promptRoutingGraduationGuideContext === undefined) {
    assertRoutingDestinationProvider(routingDestinationProvider);
    // Week-filtered candidate set (single source): an event week offers only the fixed event + the
    // neutral exit; a non-event week offers the current catalog plus the gated destinations this hub context
    // has unlocked. The prompt, the provider hint, and the accepted set all read the same filtered list so
    // they cannot drift — and the unlock (fail-closed) reads from the same stored hub context throughout.
    const weekRoutingDestinations = routingDestinationsForState(state, promptRoutingHubContext.unlocked_gated_destination_ids ?? []);
    const routingDestinationPrompt = buildCharacterPrompt({
      ...promptArgs,
      currentConversation: provisionalMessages,
      playerInput: null,
      turnType: 'routing_destination_selection',
      destinations: weekRoutingDestinations
    });
    const routingDestinationModelResponse = await routingDestinationProvider({
      prompt: routingDestinationPrompt,
      state,
      profile: promptProfile,
      playerInput,
      generatedAssistantText,
      currentConversation: provisionalMessages,
      destinations: weekRoutingDestinations
    });
    const routingDestination = parseRoutingDestinationAnswer(routingDestinationModelResponse, weekRoutingDestinations);
    routingDestinationJudgment = {
      prompt: routingDestinationPrompt,
      model_response: String(routingDestinationModelResponse ?? '').trim(),
      decided: routingDestination !== null,
      destination_id: routingDestination?.id ?? null
    };
    if (routingDestination) {
      assertRoutingTransitionProvider(routingTransitionProvider);
      const routingTransitionPrompt = buildCharacterPrompt({
        ...promptArgs,
        currentConversation: provisionalMessages,
        turnType: 'routing_transition_reply',
        generatedAssistantText,
        routingDestination
      });
      const routingTransitionAssistantText = String(await routingTransitionProvider({
        prompt: routingTransitionPrompt,
        state,
        profile: promptProfile,
        playerInput,
        emotion,
        generatedAssistantText,
        currentConversation: provisionalMessages,
        destination: routingDestination
      }) ?? '').trim();
      if (!routingTransitionAssistantText) throw new Error('routing transition reply is required');
      onAssistantComplete?.({ content: routingTransitionAssistantText, emotion });
      const routingDestinationNarration = buildRoutingDestinationNarration(routingDestination);
      nextMessages = [
        ...provisionalMessages,
        { role: 'assistant', content: routingTransitionAssistantText, ...emotion },
        { role: 'system', content: routingDestinationNarration }
      ];
      routingDestinationJudgment = {
        ...routingDestinationJudgment,
        destination_label: routingDestination.label,
        transition_prompt: routingTransitionPrompt,
        transition_assistant_text: routingTransitionAssistantText,
        narration: routingDestinationNarration
      };
      routingDestinationResult = {
        destination_id: routingDestination.id,
        destination_label: routingDestination.label,
        transition_assistant_text: routingTransitionAssistantText,
        narration: routingDestinationNarration
      };
    }
  } else if (continueConversation && postTurnStatePolicy.stageMoveEnabled && promptRoutingGraduationGuideContext === undefined) {
    const stageMoveRecentConversation = recentStageMoveConversation(provisionalMessages);
    const stageMoveAgreementPrompt = buildCharacterPrompt({
      ...promptArgs,
      currentConversation: stageMoveRecentConversation,
      playerInput: null,
      turnType: 'stage_move_agreement_judgment'
    });
    const rawStageMoveAgreement = await stageMoveAgreementProvider({
      prompt: stageMoveAgreementPrompt,
      state,
      profile: promptProfile,
      playerInput,
      generatedAssistantText,
      currentConversation: stageMoveRecentConversation
    });
    const stageMoveAgreed = normalizeStrictBooleanChoice(rawStageMoveAgreement, 'stage move agreement');
    if (stageMoveAgreed) {
      const destinations = selectableDestinationLocations({
        locations,
        currentLocationId: state.current_location_id,
        random: stageMoveLocationSituationRandom
      });
      const stageMoveDestinationPrompt = buildCharacterPrompt({
        ...promptArgs,
        currentConversation: provisionalMessages,
        playerInput: null,
        turnType: 'stage_move_destination_selection',
        destinations
      });
      const rawStageMoveDestination = await stageMoveDestinationProvider({
        prompt: stageMoveDestinationPrompt,
        state,
        profile: promptProfile,
        playerInput,
        generatedAssistantText,
        currentConversation: provisionalMessages,
        destinations
      });
      const stageMoveDestination = parseStageMoveDestinationAnswer(rawStageMoveDestination, destinations);
      if (stageMoveDestination) {
        const stageMoveCutoffPrompt = buildCharacterPrompt({
          ...promptArgs,
          currentConversation: provisionalMessages,
          turnType: 'stage_move_cutoff_reply',
          generatedAssistantText
        });
        const stageMoveCutoffAssistantText = String(await stageMoveCutoffProvider({
          prompt: stageMoveCutoffPrompt,
          state,
          profile: promptProfile,
          playerInput,
          emotion,
          generatedAssistantText,
          currentConversation: provisionalMessages,
          destination: stageMoveDestination
        }) ?? '').trim();
        if (!stageMoveCutoffAssistantText) throw new Error('stage move cutoff reply is required');
        onAssistantComplete?.({ content: stageMoveCutoffAssistantText, emotion });

        const stageMoveNarration = buildStageMoveNarration(stageMoveDestination);
        const stageMoveContextMessages = [
          ...provisionalMessages,
          { role: 'assistant', content: stageMoveCutoffAssistantText, ...emotion },
          { role: 'system', content: stageMoveNarration },
          { role: 'system', content: stageMoveGuidanceMessage() }
        ];
        const stageMoveScene = {
          ...promptArgs.scene,
          location_name: stageMoveDestination.location_name,
          visible_situation: stageMoveDestination.location_visible_situation ?? ''
        };
        const stageMoveOpeningPromptArgs = {
          ...promptArgs,
          scene: stageMoveScene,
          currentConversation: stageMoveContextMessages,
          playerInput: null
        };
        const stageMoveOpeningPrompt = buildCharacterPrompt(stageMoveOpeningPromptArgs);
        const stageMoveOpeningAssistantText = await stageMoveOpeningProvider({
          prompt: stageMoveOpeningPrompt,
          state,
          profile: promptProfile,
          currentConversation: stageMoveContextMessages,
          location: stageMoveDestination,
          destination: stageMoveDestination
        });
        const stageMoveOpeningMessage = {
          role: 'assistant',
          content: stageMoveOpeningAssistantText,
          ...emotion
        };
        nextMessages = [
          ...stageMoveContextMessages,
          stageMoveOpeningMessage
        ];
        postTurnPromptArgs = {
          ...promptArgs,
          scene: stageMoveScene
        };
        stageMove = {
          to_location_id: stageMoveDestination.location_id,
          to_location_name: stageMoveDestination.location_name,
          to_visible_situation: stageMoveDestination.location_visible_situation,
          cutoff_assistant_text: stageMoveCutoffAssistantText,
          narration: stageMoveNarration,
          next_assistant_message: stageMoveOpeningMessage
        };
      }
    }
  }
  const candidateWorkRecordIds = uniqueExistingWorkRecordIds(
    linkedWorkRecordIdsFromContinuity({ memories, skills: skillsFile.skills ?? [] }),
    allWorkRecords
  );
  const recallPromptArgs = { ...postTurnPromptArgs, currentConversation: nextMessages, playerInput: null };
  const recallPrompt = buildCharacterPrompt({
    ...recallPromptArgs,
    turnType: 'work_record_recall',
    candidateWorkRecordIds
  });
  const recallDecision = candidateWorkRecordIds.length > 0
    ? await workRecordRecallProvider({
      prompt: recallPrompt,
      state,
      profile: promptProfile,
      currentConversation: nextMessages,
      memories,
      candidateWorkRecordIds
    })
    : { work_record_ids: [] };
  const allowedRecallIds = new Set(candidateWorkRecordIds);
  const recalledWorkRecordIds = uniqueExistingWorkRecordIds(recallDecision?.work_record_ids ?? recallDecision?.workRecordIds ?? [], allWorkRecords)
    .filter((id) => allowedRecallIds.has(id));
  const recalledWorkRecords = allWorkRecords.filter((record) => recalledWorkRecordIds.includes(record.id));
  const enrichedWorkRecords = mergeWorkRecordsById(continuityPromptContext.workRecordsForPrompt, recalledWorkRecords);
  const prewarmPrompt = recalledWorkRecords.length > 0
    ? buildCharacterPrompt({
      ...recallPromptArgs,
      workRecords: enrichedWorkRecords,
      turnType: 'prefix_prewarm'
    })
    : null;
  const retainedPendingRecallRecords = updatePendingRecalledWorkRecordsAfterTurn({
    pendingEntries: pendingRecallEntries,
    recalledIds: recalledWorkRecordIds
  });
  const academyWeekSnapshot = academyWeekSnapshotForConversation({ conversation: activeConversation, state });
  const conversation = {
    id: activeConversation?.id ?? requestedConversationId ?? assertValidConversationId(makeConversationId(now)),
    character_id: actorId,
    character_name: promptRoutingHubContext !== undefined ? promptProfile.display_name : activeConversation?.character_name ?? promptProfile.display_name,
    created_at: activeConversation?.created_at ?? now,
    updated_at: now,
    academy_week_number: academyWeekSnapshot.academy_week_number,
    academy_elapsed_weeks_at_start: academyWeekSnapshot.academy_elapsed_weeks_at_start,
    source_type: promptRoutingHubContext !== undefined
      ? ROUTING_HUB_SOURCE_TYPE
      : injectedRecordScene !== null
        ? injectedRecordScene.source_type
        : activeConversation?.source_type ?? state.pending_interaction_context?.source_type ?? 'field',
    event_flag_id: activeConversation?.event_flag_id ?? state.pending_interaction_context?.event_flag_id ?? null,
    event_label: activeConversation?.event_label ?? state.pending_interaction_context?.event_label ?? null,
    source_conversation_id: activeConversation?.source_conversation_id ?? state.pending_interaction_context?.source_conversation_id ?? null,
    // The routing hub and an injected-scene session (dungeon / errand / study) are not field locations: the
    // record omits location_id / time_slot (「該当しない」). Neither turn triggers a stage move (routing
    // destinations replace it for the hub; the companion policy disables it for injected-scene sessions), so no
    // field location leaks. An injected-scene turn carries that session's location_name / visible_situation;
    // field sessions keep location_id / time_slot.
    ...(promptRoutingHubContext !== undefined
      ? {}
      : injectedRecordScene !== null
        ? { location_name: injectedRecordScene.location_name, visible_situation: injectedRecordScene.visible_situation }
        : {
          location_id: stageMove?.to_location_id ?? activeConversation?.location_id ?? state.current_location_id,
          time_slot: activeConversation?.time_slot ?? state.time_slot
        }),
    conversation_actor_context: conversationActorContext,
    ...(promptRoutingHubContext !== undefined ? { routing_hub: promptRoutingHubContext } : {}),
    prompt,
    // A graduation guide, errand, or study circle turn records its judgment in place of the continuation
    // judgment (each replaces it). Every other turn keeps the continuation record byte-for-byte, so
    // non-guide / non-errand / non-study-circle records are unchanged.
    ...(promptRoutingGraduationGuideContext !== undefined
      ? { graduation_guide_judgment: graduationGuideSelectionJudgment }
      : errandJudgmentContext !== undefined
        ? { errand_achievement_judgment: errandAchievementJudgment }
        : studyCircleJudgmentContext !== undefined
          ? { study_circle_achievement_judgment: studyCircleAchievementJudgment }
          : {
            conversation_continuation: {
              prompt: continuationPrompt,
              model_response: continuationModelResponse,
              continue_conversation: continueConversation,
              generated_assistant_text: generatedAssistantText,
              cutoff_prompt: cutoffPrompt,
              cutoff_assistant_text: cutoffAssistantText
            }
          }),
    ...(routingDestinationJudgment ? { routing_destination_judgment: routingDestinationJudgment } : {}),
    work_record_recall: {
      candidate_work_record_ids: candidateWorkRecordIds,
      recalled_work_record_ids: recalledWorkRecordIds,
      prompt: recallPrompt,
      model_response: recallDecision
    },
    pending_recalled_work_record_ids: retainedPendingRecallRecords.map((entry) => entry.id),
    pending_recalled_work_records: retainedPendingRecallRecords,
    next_prompt_cache: prewarmPrompt ? {
      recalled_work_record_ids: recalledWorkRecordIds,
      prompt: prewarmPrompt,
      prewarm_text: null
    } : null,
    ...(stageMove ? { stage_move: stageMove } : {}),
    messages: nextMessages
  };
  await writeJson(root, conversationLogPath(conversation.id), conversation);

  const nextState = postTurnStatePolicy(state, { conversation, actorId, stageMove });
  if (!nextState || typeof nextState !== 'object') throw new Error('postTurnStatePolicy must return state');
  await writeJson(root, 'game_data/runtime_state.json', nextState);

  if (prewarmPrompt) {
    startPostVisiblePromptPrewarm({
      root,
      conversation,
      prewarmPrompt,
      state,
      profile: promptProfile,
      currentConversation: nextMessages,
      recalledWorkRecords,
      promptPrewarmProvider
    });
  }

  if (graduationGuideSelection) return { conversation, state: nextState, routing_graduation_guide_selection: graduationGuideSelection };
  if (routingDestinationResult) return { conversation, state: nextState, routing_destination: routingDestinationResult };
  if (errandAchievement) return { conversation, state: nextState, errand_achievement: errandAchievement };
  if (studyCircleAchievement) return { conversation, state: nextState, study_circle_achievement: studyCircleAchievement };
  return stageMove ? { conversation, state: nextState, stage_move: stageMove } : { conversation, state: nextState };
}

export async function appendSkillRecord({ root, characterId, skillRecord }) {
  const actor = resolveDialogueActor(characterId);
  const relativePath = `${actor.basePath}/skills.json`;
  const skillsFile = await readSkillsFile(root, actor.id);
  const staticSkills = (skillsFile.skills ?? []).filter((skill) => skill.type !== 'self_change');
  const dynamicSkills = (skillsFile.skills ?? []).filter((skill) => skill.type === 'self_change' && skill.id !== skillRecord.id);
  const nextDynamicSkills = [...dynamicSkills, skillRecord].slice(-CONTINUITY_RECORD_LIMIT);
  const next = { ...skillsFile, skills: [...staticSkills, ...nextDynamicSkills] };
  await writeJson(root, relativePath, next);
}

async function discardConversationContent({ root, conversation, workRecordId, academyWeekSnapshot }) {
  await writeJson(root, conversationLogPath(conversation.id), {
    id: conversation.id,
    character_id: conversation.character_id,
    character_name: conversation.character_name,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    academy_week_number: academyWeekSnapshot.academy_week_number,
    academy_elapsed_weeks_at_start: academyWeekSnapshot.academy_elapsed_weeks_at_start,
    source_type: conversation.source_type ?? 'field',
    location_id: conversation.location_id,
    time_slot: conversation.time_slot,
    discarded_after_work_record_id: workRecordId,
    message_count: conversation.messages.length,
    prompt_discarded: true,
    messages: []
  });
}

function mergeConcurrentTrainingState(nextState, latestState) {
  if (!latestState || typeof latestState !== 'object') return nextState;
  const latestHasTrainingProgress = latestState.training_actions_used !== undefined || latestState.training_actions_limit !== undefined;
  if (!latestHasTrainingProgress) return nextState;
  const trainingScreens = new Set(['training', 'academy-training', 'academy-map']);
  const merged = {
    ...nextState,
    training_actions_used: latestState.training_actions_used,
    training_actions_limit: latestState.training_actions_limit ?? nextState.training_actions_limit
  };
  if (trainingScreens.has(latestState.current_screen) && latestState.current_interaction_character_id == null) {
    merged.current_screen = latestState.current_screen;
  }
  return merged;
}

function mergeConcurrentProgressionState(nextState, latestState) {
  if (!latestState || typeof latestState !== 'object') return nextState;
  const merged = { ...nextState };
  const latestElapsedWeeks = Number.isFinite(latestState.elapsed_weeks) ? latestState.elapsed_weeks : null;
  const nextElapsedWeeks = Number.isFinite(nextState.elapsed_weeks) ? nextState.elapsed_weeks : null;
  if (latestElapsedWeeks !== null || nextElapsedWeeks !== null) {
    if (latestElapsedWeeks === null) {
      merged.elapsed_weeks = nextElapsedWeeks;
    } else if (nextElapsedWeeks === null) {
      merged.elapsed_weeks = latestElapsedWeeks;
    } else {
      merged.elapsed_weeks = Math.max(nextElapsedWeeks, latestElapsedWeeks);
    }
  }
  if (merged.ending_started === undefined && latestState.ending_started !== undefined) {
    merged.ending_started = latestState.ending_started;
  }
  if (merged.ending_completed === undefined && latestState.ending_completed !== undefined) {
    merged.ending_completed = latestState.ending_completed;
  }
  if (latestState.ending_started === true) merged.ending_started = true;
  if (latestState.ending_completed === true) merged.ending_completed = true;
  if (
    latestState.ending_character_id != null
    && (latestState.ending_started === true || latestState.ending_completed === true || merged.ending_started === true || merged.ending_completed === true)
  ) {
    merged.ending_character_id = latestState.ending_character_id;
  }
  return merged;
}

function mergeConcurrentInteractionState(nextState, latestState, finalizedConversationId = null) {
  if (!latestState || typeof latestState !== 'object') return nextState;
  if (latestState.current_interaction_character_id == null) return nextState;
  if (finalizedConversationId && latestState.last_conversation_id === finalizedConversationId) return nextState;
  const merged = {
    ...nextState,
    current_screen: latestState.current_screen ?? nextState.current_screen,
    current_location_id: latestState.current_location_id ?? nextState.current_location_id,
    current_location_visible_situation: latestState.current_location_visible_situation ?? nextState.current_location_visible_situation,
    current_interaction_character_id: latestState.current_interaction_character_id,
    pending_interaction_context: latestState.pending_interaction_context ?? null,
    last_conversation_id: latestState.last_conversation_id ?? nextState.last_conversation_id
  };
  if (nextState.global_flags || latestState.global_flags) {
    merged.global_flags = {
      ...(latestState.global_flags ?? {}),
      ...(nextState.global_flags ?? {})
    };
  }
  if (nextState.event_flag_sources || latestState.event_flag_sources) {
    merged.event_flag_sources = {
      ...(latestState.event_flag_sources ?? {}),
      ...(nextState.event_flag_sources ?? {})
    };
  }
  if (nextState.event_completion_sources || latestState.event_completion_sources) {
    merged.event_completion_sources = {
      ...(latestState.event_completion_sources ?? {}),
      ...(nextState.event_completion_sources ?? {})
    };
  }
  return merged;
}

// The explicit finalization policy for a dialogue actor kind: which post-turn provider set runs. Keeping it a
// resolved policy (rather than scattered `actor.kind` checks) makes the supported combinations explicit and
// fail-fast on an unsupported kind. `relationship` is split into independent `buddy` / `enemy` sub-policies
// because a homunculus can become a buddy but never an enemy. Each sub-policy carries `writeLog`: whether this
// relation emits its `buddy_updates` / `enemy_updates` log artifact. Character and creature emit both logs even
// when the relation is skipped (a `skipped:true` record), reproducing today's on-disk artifacts exactly; a
// homunculus emits the buddy log (it judges buddy) but no enemy log (it can never be an enemy). Character and
// creature reproduce today's behavior exactly. A homunculus runs memory/work-record, its own affinity (with the
// same +10 buddy delta), a buddy judgment, and the MP reserve line (it can join a run as a companion) — but no
// enemy judgment, stage flags/rewards, event flags/completions, or money.
function resolveConversationFinalizationPolicy(actor, conversation) {
  // The routing hub is a metaphysical meta-surface whose persona (案内人) is not an event character: a hub
  // conversation (迎え / 週次 / 卒業ガイド, all stamped source_type 'routing_hub') never drives the event-flag /
  // participant-override / completion judgments. Stage-flag judgment (already zero-candidate at the hub for
  // lack of a location_id), rewards, money, affinity, and relationship are unaffected. Every non-hub
  // conversation keeps the full trio.
  const isRoutingHubConversation = conversation.source_type === ROUTING_HUB_SOURCE_TYPE;
  if (actor.kind === 'character') {
    const relationshipPolicy = actor.id === ROUTING_PERSONA_CHARACTER_ID
      ? { mode: 'skip', reason: 'routing_persona', writeLog: true }
      : { mode: 'judge', writeLog: true };
    return {
      kind: 'character',
      runFieldJudgments: true,
      runEventJudgments: !isRoutingHubConversation,
      eventSkipReason: isRoutingHubConversation ? 'routing_hub_conversation' : null,
      relationship: { buddy: relationshipPolicy, enemy: relationshipPolicy },
      affinity: { mode: 'character' },
      // Only the selectable roster can join a run as a dungeon companion, so only they carry an MP
      // reserve line. The routing persona (a non-selectable character id) is skipped.
      mpReserve: isSelectableCharacterId(actor.id) ? { mode: 'judge' } : { mode: 'skip', reason: 'non_selectable_character' }
    };
  }
  if (actor.kind === 'creature') {
    const relationshipPolicy = { mode: 'skip', reason: 'creature_actor', writeLog: true };
    return {
      kind: 'creature',
      runFieldJudgments: true,
      runEventJudgments: !isRoutingHubConversation,
      eventSkipReason: isRoutingHubConversation ? 'routing_hub_conversation' : null,
      relationship: { buddy: relationshipPolicy, enemy: relationshipPolicy },
      affinity: { mode: 'skip', reason: 'creature_actor' },
      mpReserve: { mode: 'skip', reason: 'creature_actor' }
    };
  }
  if (actor.kind === 'homunculus') {
    return {
      kind: 'homunculus',
      runFieldJudgments: false,
      fieldSkipReason: 'homunculus_actor',
      runEventJudgments: false,
      eventSkipReason: 'homunculus_actor',
      // A homunculus can be made a buddy (roster-crossing exclusive) but never an enemy: it judges and logs
      // buddy, and emits no enemy artifact at all.
      relationship: { buddy: { mode: 'judge', writeLog: true }, enemy: { mode: 'skip', reason: 'homunculus_actor', writeLog: false } },
      affinity: { mode: 'homunculus' },
      mpReserve: { mode: 'judge' }
    };
  }
  throw new Error(`unsupported dialogue actor kind for conversation finalization: ${actor.kind}`);
}

// Finalization progress phases (block-boundary vocabulary for the in-turn SSE loading-screen constellation).
// One drained job emits this closed set in order: memory update → skill-necessity → work-record draft →
// the grouped field/relation/affinity/MP state effects → the state+work-record commit and atomic promotion.
// The grouping keeps a multi-job drain within the constellation's 13-edge cap; any phase outside the set is a
// programming error and fail-fasts (no silent drop).
export const FINALIZATION_PROGRESS_PHASES = Object.freeze(['memory', 'skill', 'work_record', 'state_effects', 'commit']);
const FINALIZATION_PROGRESS_PHASE_SET = new Set(FINALIZATION_PROGRESS_PHASES);

export function reportFinalizationProgress(progressReporter, phase, characterId) {
  if (!FINALIZATION_PROGRESS_PHASE_SET.has(phase)) {
    throw new Error(`unsupported finalization progress phase: ${phase}`);
  }
  // A missing reporter means no observer is attached (a non-SSE finalize path); it is the explicit absence of
  // an observer, not a default value, so nothing is emitted. A present reporter must be callable.
  if (progressReporter == null) return;
  if (typeof progressReporter !== 'function') throw new Error('progressReporter must be a function when provided');
  progressReporter({ phase, character_id: characterId });
}

export async function finalizeConversation({
  root,
  conversationId,
  characterId = 'lina',
  now = new Date().toISOString(),
  memoryUpdateProvider = defaultMemoryUpdateProvider,
  skillNecessityProvider = defaultSkillNecessityProvider,
  skillUpdateProvider = defaultSkillUpdateProvider,
  workRecordProvider = defaultWorkRecordProvider,
  stageFlagJudgmentProvider = defaultStageFlagJudgmentProvider,
  eventFlagJudgmentProvider = defaultEventFlagJudgmentProvider,
  eventCompletionJudgmentProvider = defaultEventCompletionJudgmentProvider,
  eventParticipantOverrideJudgmentProvider = defaultEventParticipantOverrideJudgmentProvider,
  moneyDeltaProvider = defaultMoneyDeltaProvider,
  buddyAgreementProvider = defaultBuddyAgreementProvider,
  enemyHostilityProvider = defaultEnemyHostilityProvider,
  affinityDeltaProvider,
  mpReserveProvider,
  finalStateTransform = null,
  preservePrefixClusterOrder = false,
  progressReporter = null
}) {
  if (!root) throw new Error('root is required');
  if (!conversationId) throw new Error('conversationId is required');
  if (progressReporter != null && typeof progressReporter !== 'function') {
    throw new Error('progressReporter must be a function when provided');
  }
  const normalizedConversationId = assertValidConversationId(conversationId);

  const state = await readJson(root, 'game_data/runtime_state.json');
  const conversation = await readJson(root, conversationLogPath(normalizedConversationId));
  if (conversation.discarded_after_work_record_id) throw new Error(`conversation already finalized: ${normalizedConversationId}`);
  const actor = resolveDialogueActor(characterId);
  const actorId = actor.id;
  const finalizationPolicy = resolveConversationFinalizationPolicy(actor, conversation);
  const actorFlagsFile = await readJsonIfExists(root, `${actor.basePath}/flags.json`);
  mergeDialogueActorFlagsIntoState({ state, actor, flagsFile: actorFlagsFile });
  const workRecordId = `wr_${conversation.id}`;
  const academyWeekSnapshot = academyWeekSnapshotForConversation({ conversation, state });

  let memoryUpdate;
  let skillNecessity;
  let workRecordUpdate;
  if (preservePrefixClusterOrder) {
    // Serial common-prefix cluster (routing atomic finalize). Its block boundaries are the only place a
    // finalization progress reporter fires the memory/skill/work_record phases — emitted here because these
    // awaits are already serial, so no ordering is introduced for the UI. The non-routing Promise.all branch
    // below is never serialized for progress: it carries no reporter.
    memoryUpdate = await memoryUpdateProvider({ conversation, state, workRecordId, now });
    reportFinalizationProgress(progressReporter, 'memory', conversation.character_id);
    skillNecessity = await skillNecessityProvider({ conversation, state, workRecordId, now });
    reportFinalizationProgress(progressReporter, 'skill', conversation.character_id);
    workRecordUpdate = await workRecordProvider({ conversation, state, workRecordId, now });
    reportFinalizationProgress(progressReporter, 'work_record', conversation.character_id);
  } else {
    [memoryUpdate, skillNecessity, workRecordUpdate] = await Promise.all([
      memoryUpdateProvider({ conversation, state, workRecordId, now }),
      skillNecessityProvider({ conversation, state, workRecordId, now }),
      workRecordProvider({ conversation, state, workRecordId, now })
    ]);
  }
  const normalizedSkillNecessity = {
    necessary: skillNecessity?.necessary === true ? true : skillNecessity?.necessary === false ? false : null,
    raw_answer: String(skillNecessity?.raw_answer ?? '').trim(),
    source_conversation_id: conversation.id,
    work_record_id: workRecordId
  };
  const skillUpdate = normalizedSkillNecessity.necessary === true
    ? await skillUpdateProvider({ conversation, state, workRecordId, now })
    : {
      skipped: true,
      reason: normalizedSkillNecessity.necessary === false ? 'no_decisive_behavior_change' : 'invalid_skill_necessity_answer',
      raw_answer: normalizedSkillNecessity.raw_answer,
      source_conversation_id: conversation.id,
      work_record_id: workRecordId
    };
  await writeJson(root, `game_data/logs/memory_updates/${conversation.id}.json`, memoryUpdate);
  await writeJson(root, `game_data/logs/skill_updates/${conversation.id}.json`, skillUpdate);
  await writeJson(root, `game_data/logs/work_record_updates/${conversation.id}.json`, workRecordUpdate);

  const memoryRecord = normalizeMemoryRecordForSave({ memoryUpdate, conversation, workRecordId });
  const skillRecord = skillUpdate.skipped ? null : { ...(skillUpdate.skill_record ?? skillUpdate), visibility: 'character_known', source_conversation_id: conversation.id, work_record_id: workRecordId };
  const workRecordDraft = {
    ...(workRecordUpdate.work_record ?? workRecordUpdate),
    id: workRecordId,
    source_conversation_id: conversation.id,
    work_record_id: workRecordId,
    academy_week_number: academyWeekSnapshot.academy_week_number,
    academy_elapsed_weeks_at_start: academyWeekSnapshot.academy_elapsed_weeks_at_start
  };
  const validator = validateConversationRecordUpdates({
    sourceType: 'dialogue',
    state,
    memoryRecord,
    skillRecord,
    workRecordDraft,
    flagUpdateCandidates: workRecordDraft.flag_update_candidates ?? workRecordUpdate.flag_update_candidates ?? []
  });
  await writeJson(root, `game_data/logs/validator/${conversation.id}.json`, validator);
  // Explicit finalization marker, persisted immediately after the validator log. Routing hub entry uses the
  // pair to classify runtime_state.last_conversation_id when its validator log is absent: no marker means an
  // opening that was never finalized (a legitimate runtime state → conversation_without_memory), a marker
  // without its validator log means a finalized conversation whose validator was lost (corrupt → fail-fast).
  // Writing the marker after the validator makes a crash between the two land on the finalized side
  // (validator present, marker absent), never on the corrupt side.
  await writeJson(root, `game_data/logs/finalization/${conversation.id}.json`, {
    conversation_id: conversation.id,
    work_record_id: workRecordId,
    finalized_at: now
  });

  const acceptedMemory = validator.accepted_memory[0] ?? null;
  const acceptedSkill = validator.accepted_skills[0] ?? null;
  if (acceptedMemory) {
    const memoryActor = resolveDialogueActor(acceptedMemory.character_id);
    await writeJson(root, `${memoryActor.basePath}/memory/${acceptedMemory.id}.json`, acceptedMemory);
    await pruneFilesToLimit(root, `${memoryActor.basePath}/memory`, '.json');
  }
  if (acceptedSkill) await appendSkillRecord({ root, characterId: acceptedSkill.character_id, skillRecord: acceptedSkill });

  // Field-anchored side effects (stage flags/rewards, event flags/participant overrides/completions, money).
  // These run for character/creature exactly as before; a homunculus policy skips the whole region — no
  // judgments, no inventory/state mutations, and no logs — keeping only the accepted work-record flags on
  // state so finalization writes memory/work-record + affinity only.
  let stageFlagJudgment;
  let stageRewardUpdate;
  let eventFlagJudgment;
  let eventParticipantOverrideJudgment;
  let eventCompletionJudgment;
  let moneyUpdate;
  let stateAfterParticipantOverrides;
  if (finalizationPolicy.runFieldJudgments) {
    stageFlagJudgment = await judgeStageFlagsAfterConversation({
      root,
      state,
      conversation,
      workRecordId,
      stageFlagJudgmentProvider,
      now
    });
    const stateAfterCommittedStageFlags = applyAcceptedStageFlags(state, stageFlagJudgment);
    if ((stageFlagJudgment.accepted?.length ?? 0) > 0) {
      await writeJson(root, 'game_data/runtime_state.json', stateAfterCommittedStageFlags);
    }
    stageRewardUpdate = await grantInventoryRewards({
      root,
      rewards: collectAcceptedStageFlagRewards(stageFlagJudgment)
    });
    await writeJson(root, `game_data/logs/stage_reward_updates/${conversation.id}.json`, {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      granted_rewards: stageRewardUpdate.granted_rewards,
      before_inventory: stageRewardUpdate.before_inventory,
      inventory: stageRewardUpdate.inventory,
      updated_at: now
    });

    const currentInventory = stageRewardUpdate.inventory;
    const stateWithStageFlags = applyAcceptedStageFlags(applyAcceptedFlags(state, validator), stageFlagJudgment);
    if (finalizationPolicy.runEventJudgments) {
      eventFlagJudgment = await judgeEventFlagsAfterConversation({
        root,
        state: stateWithStageFlags,
        inventory: currentInventory,
        conversation,
        workRecordId,
        eventFlagJudgmentProvider,
        now
      });
      const stateAfterStageAndEvent = applyAcceptedEventFlags(stateWithStageFlags, eventFlagJudgment);
      eventParticipantOverrideJudgment = await judgeEventParticipantOverridesAfterConversation({
        root,
        state: stateAfterStageAndEvent,
        inventory: currentInventory,
        conversation,
        workRecordId,
        eventParticipantOverrideJudgmentProvider,
        now
      });
      stateAfterParticipantOverrides = applyAcceptedEventParticipantOverrides(stateAfterStageAndEvent, eventParticipantOverrideJudgment);
      eventCompletionJudgment = await judgeEventCompletionsAfterConversation({
        root,
        state: stateAfterParticipantOverrides,
        conversation,
        workRecordId,
        eventCompletionJudgmentProvider,
        now
      });
    } else {
      // Explicit hub-conversation skip of the event-flag / participant-override / completion judgments: no LM
      // call, no event_*_judgments log written, and no event flag / source / completion write to state. Stage
      // flags (empty-candidate at the hub) still applied above, so the money/affinity path continues from the
      // same stage-applied state a non-event field conversation would.
      const eventSkip = { skipped: true, reason: finalizationPolicy.eventSkipReason };
      eventFlagJudgment = { accepted: [], rejected: [], ...eventSkip };
      eventParticipantOverrideJudgment = { accepted: [], rejected: [], ...eventSkip };
      eventCompletionJudgment = { accepted: [], rejected: [], ...eventSkip };
      stateAfterParticipantOverrides = stateWithStageFlags;
    }
    const moneyDeltaPrompt = buildMoneyDeltaPrompt({ conversation, workRecordId, currentMoney: currentInventory.money });
    const rawMoneyDelta = await moneyDeltaProvider({
      prompt: moneyDeltaPrompt,
      conversation,
      state,
      workRecordId,
      now,
      currentMoney: currentInventory.money
    });
    const moneyDelta = parseMoneyDeltaAnswer(rawMoneyDelta);
    const moneyUpdatePath = `game_data/logs/money_updates/${conversation.id}.json`;
    const appliedMoney = await applyPlayerMoneyDelta({
      root,
      conversationId: conversation.id,
      delta: moneyDelta
    });
    const priorMoneyUpdate = appliedMoney.already_applied
      ? await readJsonIfExists(root, moneyUpdatePath)
      : null;
    moneyUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      raw_answer: String(rawMoneyDelta ?? '').trim(),
      delta: priorMoneyUpdate?.delta ?? appliedMoney.delta,
      before_money: priorMoneyUpdate?.before_money ?? appliedMoney.before_money,
      after_money: priorMoneyUpdate?.after_money ?? appliedMoney.after_money,
      already_applied: appliedMoney.already_applied === true,
      prompt: moneyDeltaPrompt,
      updated_at: now
    };
    await writeJson(root, moneyUpdatePath, moneyUpdate);
  } else {
    const fieldSkip = { skipped: true, reason: finalizationPolicy.fieldSkipReason };
    stageFlagJudgment = { accepted: [], rejected: [], ...fieldSkip };
    eventFlagJudgment = { accepted: [], rejected: [], ...fieldSkip };
    eventParticipantOverrideJudgment = { accepted: [], rejected: [], ...fieldSkip };
    eventCompletionJudgment = { accepted: [], rejected: [], ...fieldSkip };
    stageRewardUpdate = { conversation_id: conversation.id, work_record_id: workRecordId, ...fieldSkip, updated_at: now };
    moneyUpdate = { conversation_id: conversation.id, work_record_id: workRecordId, ...fieldSkip, updated_at: now };
    stateAfterParticipantOverrides = applyAcceptedFlags(state, validator);
  }

  let buddyEstablished = false;
  let enemyEstablished = false;
  let buddyUpdate;
  let enemyUpdate;
  const buddyPolicy = finalizationPolicy.relationship.buddy;
  const enemyPolicy = finalizationPolicy.relationship.enemy;
  if (buddyPolicy.mode === 'skip') {
    buddyUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      skipped: true,
      reason: buddyPolicy.reason,
      updated_at: now
    };
  } else {
    const buddyPrompt = buildBuddyAgreementPrompt({ conversation, workRecordId });
    const rawBuddyAgreement = await buddyAgreementProvider({
      prompt: buddyPrompt,
      conversation,
      state,
      workRecordId,
      now,
      characterId: conversation.character_id,
      characterName: conversation.character_name ?? null
    });
    buddyEstablished = parseBooleanOnlyAnswer(rawBuddyAgreement);
    buddyUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      flag: buddyFlagId(conversation.character_id),
      established: buddyEstablished,
      raw_answer: String(rawBuddyAgreement ?? '').trim(),
      prompt: buddyPrompt,
      updated_at: now
    };
  }
  if (enemyPolicy.mode === 'skip') {
    enemyUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      skipped: true,
      reason: enemyPolicy.reason,
      updated_at: now
    };
  } else {
    const enemyPrompt = buildEnemyHostilityPrompt({ conversation, workRecordId });
    const rawEnemyHostility = await enemyHostilityProvider({
      prompt: enemyPrompt,
      conversation,
      state,
      workRecordId,
      now,
      characterId: conversation.character_id,
      characterName: conversation.character_name ?? null
    });
    enemyEstablished = parseBooleanOnlyAnswer(rawEnemyHostility);
    enemyUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      flag: enemyFlagId(conversation.character_id),
      established: enemyEstablished,
      raw_answer: String(rawEnemyHostility ?? '').trim(),
      prompt: enemyPrompt,
      updated_at: now
    };
  }
  // A relation emits its log artifact per its `writeLog` policy: character and creature write both logs even
  // when the relation is skipped (a `skipped:true` record), a homunculus writes only the buddy log. A judged
  // relation always writes.
  if (buddyPolicy.writeLog) {
    await writeJson(root, `game_data/logs/buddy_updates/${conversation.id}.json`, buddyUpdate);
  }
  if (enemyPolicy.writeLog) {
    await writeJson(root, `game_data/logs/enemy_updates/${conversation.id}.json`, enemyUpdate);
  }

  let affinityUpdate;
  if (finalizationPolicy.affinity.mode === 'skip') {
    affinityUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      skipped: true,
      reason: finalizationPolicy.affinity.reason,
      updated_at: now
    };
  } else if (finalizationPolicy.affinity.mode === 'character') {
    if (typeof affinityDeltaProvider !== 'function') throw new Error('affinityDeltaProvider is required');
    const affinityPrompt = buildAffinityDeltaPrompt({ conversation, workRecordId });
    const rawAffinityDelta = await affinityDeltaProvider({
      prompt: affinityPrompt,
      conversation,
      state,
      workRecordId,
      now,
      characterId: conversation.character_id,
      characterName: conversation.character_name ?? null
    });
    const conversationDelta = parseAffinityDeltaAnswer(rawAffinityDelta);
    const buddyDelta = buddyEstablished ? BUDDY_AFFINITY_DELTA : 0;
    const enemyDelta = enemyEstablished ? ENEMY_AFFINITY_DELTA : 0;
    const affinityUpdatePath = `game_data/logs/affinity_updates/${conversation.id}.json`;
    const appliedAffinity = await applyCharacterAffinityDelta({
      root,
      characterId: conversation.character_id,
      conversationId: conversation.id,
      conversationDelta,
      buddyDelta,
      enemyDelta
    });
    const priorAffinityUpdate = appliedAffinity.already_applied
      ? await readJsonIfExists(root, affinityUpdatePath)
      : null;
    affinityUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      raw_answer: String(rawAffinityDelta ?? '').trim(),
      conversation_delta: priorAffinityUpdate?.conversation_delta ?? appliedAffinity.conversation_delta,
      buddy_delta: priorAffinityUpdate?.buddy_delta ?? appliedAffinity.buddy_delta,
      enemy_delta: priorAffinityUpdate?.enemy_delta ?? appliedAffinity.enemy_delta,
      total_delta: priorAffinityUpdate?.total_delta ?? appliedAffinity.total_delta,
      before_affinity: priorAffinityUpdate?.before_affinity ?? appliedAffinity.before_affinity,
      after_affinity: priorAffinityUpdate?.after_affinity ?? appliedAffinity.after_affinity,
      already_applied: appliedAffinity.already_applied === true,
      prompt: affinityPrompt,
      updated_at: now
    };
  } else if (finalizationPolicy.affinity.mode === 'homunculus') {
    // Homunculus affinity: the same ±10 conversation-end judgment, applied to the homunculus's own affinity
    // path (opening at 50) with the same 0..100 clamp. A homunculus can be made a buddy, so buddy establishment
    // adds the same +10 buddy delta as a character; it can never be an enemy, so there is no enemy delta. This
    // affinity update IS a homunculus finalization write, so its log is written.
    if (typeof affinityDeltaProvider !== 'function') throw new Error('affinityDeltaProvider is required');
    const affinityPrompt = buildAffinityDeltaPrompt({ conversation, workRecordId });
    const rawAffinityDelta = await affinityDeltaProvider({
      prompt: affinityPrompt,
      conversation,
      state,
      workRecordId,
      now,
      characterId: conversation.character_id,
      characterName: conversation.character_name ?? null
    });
    const conversationDelta = parseAffinityDeltaAnswer(rawAffinityDelta);
    const buddyDelta = buddyEstablished ? BUDDY_AFFINITY_DELTA : 0;
    const affinityUpdatePath = `game_data/logs/affinity_updates/${conversation.id}.json`;
    const appliedAffinity = await applyHomunculusAffinityDelta({
      root,
      homunculusId: conversation.character_id,
      conversationId: conversation.id,
      conversationDelta,
      buddyDelta
    });
    const priorAffinityUpdate = appliedAffinity.already_applied
      ? await readJsonIfExists(root, affinityUpdatePath)
      : null;
    affinityUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      raw_answer: String(rawAffinityDelta ?? '').trim(),
      conversation_delta: priorAffinityUpdate?.conversation_delta ?? appliedAffinity.conversation_delta,
      buddy_delta: priorAffinityUpdate?.buddy_delta ?? appliedAffinity.buddy_delta,
      total_delta: priorAffinityUpdate?.total_delta ?? appliedAffinity.total_delta,
      before_affinity: priorAffinityUpdate?.before_affinity ?? appliedAffinity.before_affinity,
      after_affinity: priorAffinityUpdate?.after_affinity ?? appliedAffinity.after_affinity,
      already_applied: appliedAffinity.already_applied === true,
      prompt: affinityPrompt,
      updated_at: now
    };
  } else {
    throw new Error(`unsupported finalization affinity mode: ${finalizationPolicy.affinity.mode}`);
  }
  await writeJson(root, `game_data/logs/affinity_updates/${conversation.id}.json`, affinityUpdate);

  // MP reserve line: the same conversation-end reflection seam as affinity, but it authors the
  // companion behavior line the actor wants (0..100 percent, overwritten each conversation). It runs for
  // any actor that can join a run as a dungeon companion — the selectable roster and active homunculi —
  // and is skipped for the routing persona and creatures. The parse is strict: a non-integer / out-of-range
  // answer fails fast, never silently keeping the old line.
  let mpReserveUpdate;
  if (finalizationPolicy.mpReserve.mode === 'skip') {
    mpReserveUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      skipped: true,
      reason: finalizationPolicy.mpReserve.reason,
      updated_at: now
    };
  } else if (finalizationPolicy.mpReserve.mode === 'judge') {
    if (typeof mpReserveProvider !== 'function') throw new Error('mpReserveProvider is required');
    const beforePercent = mpReservePercentFor(await loadMpReserveSurface({ root }), conversation.character_id);
    const mpReservePrompt = buildMpReservePrompt({ conversation, workRecordId, currentReservePercent: beforePercent });
    const rawMpReserve = await mpReserveProvider({
      prompt: mpReservePrompt,
      conversation,
      state,
      workRecordId,
      now,
      characterId: conversation.character_id,
      characterName: conversation.character_name ?? null,
      currentReservePercent: beforePercent
    });
    const afterPercent = parseMpReservePercentAnswer(rawMpReserve);
    await setMpReservePercent({ root, characterId: conversation.character_id, percent: afterPercent });
    mpReserveUpdate = {
      conversation_id: conversation.id,
      work_record_id: workRecordId,
      character_id: conversation.character_id,
      character_name: conversation.character_name ?? null,
      raw_answer: String(rawMpReserve ?? '').trim(),
      before_percent: beforePercent,
      after_percent: afterPercent,
      prompt: mpReservePrompt,
      updated_at: now
    };
    // Only an actual judgment writes a log file (matching money / buddy / enemy, which write no log for
    // an actor kind they do not apply to); the skipped record stays in the return object only.
    await writeJson(root, `game_data/logs/mp_reserve_updates/${conversation.id}.json`, mpReserveUpdate);
  } else {
    throw new Error(`unsupported finalization mp reserve mode: ${finalizationPolicy.mpReserve.mode}`);
  }

  // All field/relation/affinity/MP-reserve side effects (stage & event flags, money, buddy/enemy, affinity, MP
  // reserve) are decided and their logs written by here — one grouped state-effects boundary before the state is
  // assembled and committed.
  reportFinalizationProgress(progressReporter, 'state_effects', conversation.character_id);
  const stateAfterEventCompletions = applyAcceptedEventCompletions(stateAfterParticipantOverrides, eventCompletionJudgment);
  let nextState = stateAfterEventCompletions;
  if (buddyPolicy.mode === 'judge') {
    nextState = applyBuddyAgreementToState(nextState, {
      characterId: conversation.character_id,
      established: buddyEstablished
    });
  }
  if (enemyPolicy.mode === 'judge') {
    nextState = applyEnemyHostilityToState(nextState, {
      characterId: conversation.character_id,
      established: enemyEstablished
    });
  }
  nextState.last_conversation_id = conversation.id;
  nextState.current_screen = 'academy-room';
  nextState.current_interaction_character_id = null;
  nextState.pending_interaction_context = null;
  if (typeof finalStateTransform === 'function') {
    nextState = finalStateTransform(nextState);
  }
  if (validator.accepted_work_record) {
    const markdown = renderWorkRecordMarkdown({
      id: workRecordId,
      draft: validator.accepted_work_record
    });
    await writeText(root, `${actor.basePath}/work_records/${workRecordId}.md`, markdown);
    await pruneFilesToLimit(root, `${actor.basePath}/work_records`, '.md');
  }

  const actorFlagWriteIds = [...new Set([
    actorId,
    state.current_buddy_character_id,
    nextState.current_buddy_character_id,
    ...(Array.isArray(state.current_enemy_character_ids) ? state.current_enemy_character_ids : []),
    ...(Array.isArray(nextState.current_enemy_character_ids) ? nextState.current_enemy_character_ids : []),
    ...validator.accepted_flags.map((candidate) => candidate.character_id)
  ].filter(Boolean))];
  await Promise.all(actorFlagWriteIds.map((targetActorId) => writeDialogueActorFlagsFromState({ root, state: nextState, actorId: targetActorId })));
  const latestState = await readJson(root, 'game_data/runtime_state.json');
  nextState = mergeConcurrentTrainingState(nextState, latestState);
  nextState = mergeConcurrentProgressionState(nextState, latestState);
  nextState = mergeConcurrentInteractionState(nextState, latestState, conversation.id);
  if (typeof finalStateTransform === 'function') {
    nextState = finalStateTransform(nextState);
  }
  await writeJson(root, 'game_data/runtime_state.json', nextState);
  if (validator.accepted_work_record) {
    await discardConversationContent({ root, conversation, workRecordId, academyWeekSnapshot });
  }

  return { conversation, memory_update: memoryUpdate, skill_update: skillUpdate, work_record_update: workRecordUpdate, stage_reward_update: stageRewardUpdate, money_update: moneyUpdate, buddy_update: buddyUpdate, enemy_update: enemyUpdate, affinity_update: affinityUpdate, mp_reserve_update: mpReserveUpdate, validator, stage_flags: stageFlagJudgment, event_flags: eventFlagJudgment, event_participant_overrides: eventParticipantOverrideJudgment, event_completions: eventCompletionJudgment, state: nextState };
}

export async function finalizeConversationAtomic({
  root,
  conversationId,
  finalStateTransform = null,
  progressReporter = null,
  ...args
}) {
  const result = await runOutsideRoutingReadScope(() => runAtomicFinalizationWithStaging({
    root,
    conversationId,
    finalStateTransform,
    finalizer: ({ root: stagingRoot, finalStateTransform: atomicFinalStateTransform }) => finalizeConversation({
      ...args,
      root: stagingRoot,
      conversationId,
      progressReporter,
      finalStateTransform: atomicFinalStateTransform,
      preservePrefixClusterOrder: true
    })
  }));
  // The commit phase includes the atomic promotion (staging → live mutable root), which runs inside
  // runAtomicFinalizationWithStaging after the finalizer returns. Only once it resolves is the block "live
  // committed", so the commit boundary is emitted here, not from inside finalizeConversation on the staging root.
  // The drained conversation's actor is a required invariant of a successful atomic finalize (the same
  // conversation the first four phases were attributed to), so it is read from the result and asserted — never
  // defaulted or substituted from an outer parameter.
  if (progressReporter != null) {
    const committedCharacterId = result?.conversation?.character_id;
    if (!committedCharacterId) {
      throw new Error('atomic finalization result is missing conversation.character_id for the commit progress phase');
    }
    reportFinalizationProgress(progressReporter, 'commit', committedCharacterId);
  }
  return result;
}

export async function getContinuityRecordStatus({ root, characterId = 'lina' }) {
  if (!root) throw new Error('root is required');
  const state = await readJson(root, 'game_data/runtime_state.json');
  const actor = resolveDialogueActor(characterId);
  const [memories, skillsFile, workRecords] = await Promise.all([
    listJson(root, `${actor.basePath}/memory`),
    readSkillsFile(root, actor.id),
    listMarkdownRecords(root, `${actor.basePath}/work_records`)
  ]);
  const skillRecords = (skillsFile.skills ?? []).filter((skill) => skill.type === 'self_change');
  const activeConversation = state.current_interaction_character_id === actor.id
    ? await readConversationIfExists(root, state.last_conversation_id)
    : null;
  const lastConversationId = state.last_conversation_id ?? null;
  return {
    character_id: actor.id,
    responsibilities: {
      memory: '主人公との関係性変化と、それがどの経験・会話から生じたかを5文以下で保持する。',
      skills: 'キャラクター自身の変化と、それがどの経験・会話から生じたかを1文で保持する。Hermes Agentのスキルではなくゲーム内キャラクター技能・変化記録である。',
      work_records: 'その会話セッションで行われたやり取りを20文以下のサマリとして保持する。全文ログではなく、作成後は会話セッション本文を破棄する。'
    },
    limits: { memory: CONTINUITY_RECORD_LIMIT, skills: CONTINUITY_RECORD_LIMIT, work_records: CONTINUITY_RECORD_LIMIT, per_conversation_session: 1 },
    records: {
      memory: {
        count: memories.length,
        latest_ids: memories.slice(-5).map((memory) => memory.id),
        linked_work_record_ids: memories.slice(-5).map((memory) => memory.work_record_id).filter(Boolean),
        items: memories.slice(-20).map((memory) => ({
          id: memory.id,
          type: memory.type ?? 'memory',
          text: memory.text ?? '',
          source_conversation_id: memory.source_conversation_id ?? null,
          work_record_id: memory.work_record_id ?? null,
          tags: memory.tags ?? []
        }))
      },
      skills: {
        count: skillRecords.length,
        latest_ids: skillRecords.slice(-5).map((skill) => skill.id),
        linked_work_record_ids: skillRecords.slice(-5).map((skill) => skill.work_record_id).filter(Boolean),
        items: skillRecords.slice(-20).map((skill) => ({
          id: skill.id,
          name: skill.name ?? '会話からの自己変化',
          description: skill.description ?? '',
          source_conversation_id: skill.source_conversation_id ?? null,
          work_record_id: skill.work_record_id ?? null,
          tags: skill.tags ?? []
        }))
      },
      work_records: {
        count: workRecords.length,
        latest_ids: workRecords.slice(-5).map((record) => record.id),
        items: workRecords.slice(-20).map((record) => ({
          id: record.id,
          title: record.title,
          body: record.body,
          tags: record.tags ?? []
        }))
      }
    },
    active_session: activeConversation ? {
      conversation_id: activeConversation.id,
      source_type: activeConversation.source_type ?? 'field',
      message_count: activeConversation.messages?.length ?? 0,
      finalized: Boolean(activeConversation.discarded_after_work_record_id)
    } : null,
    pending_interaction_context: state.pending_interaction_context ?? null,
    last_finalization: lastConversationId ? {
      conversation_id: lastConversationId,
      memory_update: await readJsonIfExists(root, `game_data/logs/memory_updates/${lastConversationId}.json`),
      skill_update: await readJsonIfExists(root, `game_data/logs/skill_updates/${lastConversationId}.json`),
      work_record_update: await readJsonIfExists(root, `game_data/logs/work_record_updates/${lastConversationId}.json`),
      validator: await readJsonIfExists(root, `game_data/logs/validator/${lastConversationId}.json`),
      conversation_log: await readConversationIfExists(root, lastConversationId)
    } : null
  };
}

export async function resetContinuityRecords({ root, characterId = 'lina', target = 'all' }) {
  if (!root) throw new Error('root is required');
  const actor = resolveDialogueActor(characterId);
  const resetTargets = target === 'all' ? ['memory', 'skills', 'work_records'] : [target];
  const allowedTargets = new Set(['memory', 'skills', 'work_records']);
  for (const resetTarget of resetTargets) {
    if (!allowedTargets.has(resetTarget)) throw new Error(`unsupported continuity reset target: ${resetTarget}`);
  }
  const removed = { memory: [], skills: [], work_records: [] };

  if (resetTargets.includes('memory')) {
    const relativeDir = `${actor.basePath}/memory`;
    const entries = await listDirEntries(root, relativeDir, '.json');
    for (const entry of entries) {
      const record = await readJsonIfExists(root, path.join(relativeDir, entry));
      const generated = Boolean(record?.source_conversation_id || record?.work_record_id || record?.id?.startsWith('mem_conv_'));
      if (generated) {
        await fs.rm(storageFor(root).resolveWritePath(path.join(relativeDir, entry)), { force: true });
        removed.memory.push(entry);
      }
    }
  }

  if (resetTargets.includes('skills')) {
    const relativePath = `${actor.basePath}/skills.json`;
    const skillsFile = await readSkillsFile(root, actor.id);
    const staticSkills = (skillsFile.skills ?? []).filter((skill) => skill.type !== 'self_change');
    removed.skills = (skillsFile.skills ?? []).filter((skill) => skill.type === 'self_change').map((skill) => skill.id);
    await writeJson(root, relativePath, { ...skillsFile, skills: staticSkills });
  }

  if (resetTargets.includes('work_records')) {
    const relativeDir = `${actor.basePath}/work_records`;
    const entries = await listDirEntries(root, relativeDir, '.md');
    await Promise.all(entries.map((entry) => fs.rm(storageFor(root).resolveWritePath(path.join(relativeDir, entry)), { force: true })));
    removed.work_records = entries;
  }

  return {
    character_id: actor.id,
    reset_targets: resetTargets,
    removed,
    status: await getContinuityRecordStatus({ root, characterId: actor.id })
  };
}
