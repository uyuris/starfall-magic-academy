// 談話室 (lounge) aggregate finalizer: the conversation-end processing for a 3 NPC + プレイヤー group talk.
// A 1:1 conversation finalizes one actor (memory/skill/work-record + affinity, plus the field/relationship/MP
// side effects that only make sense for a single dialogue partner). A lounge talk finalizes THREE participants
// off one shared transcript, and deliberately runs a narrower set: per-participant memory/skill/work-record
// generation plus the ±10 affinity judgment, and nothing else. Field judgments (stage/event/money), buddy/enemy,
// and the MP-reserve line are explicitly NOT part of the group policy — a casual dorm-lounge round is not a
// field visit, a relationship-defining 1:1, or a dungeon-companion briefing.
//
// The three-piece generation projects the existing single-actor record path per participant, with two group
// adaptations the 1:1 path cannot express: (1) every artifact is participant-scoped — the work-record id is
// `wr_<conversation_id>_<character_id>` and every log is keyed `<conversation_id>_<character_id>` — so three
// projections off one conversation id never collide; (2) the generation prompt presents the shared transcript
// with each line named by its own speaker and names the target participant explicitly, instead of the 1:1
// "every assistant line is the one actor" framing that would misattribute the other two speakers' words.
//
// The whole group finalizes as ONE staging transaction: all three participants complete inside a single
// finalize-staging workspace and only then does one group finalization marker and one transcript discard land,
// promoted atomically. Any participant's generation failure throws, the staging workspace is discarded by the
// atomic machinery, and no partial finalize is ever promoted.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from '../storage.mjs';
import { resolveDialogueActor } from './dialogueActor.mjs';
import { validateConversationRecordUpdates } from './validator.mjs';
import { applyCharacterAffinityDelta, parseAffinityDeltaAnswer } from '../affinityState.mjs';
import { runAtomicFinalizationWithStaging, runOutsideRoutingReadScope } from '../routingFinalizeQueue.mjs';
import { validateLoungeGroupRecord } from './loungeGroupRecord.mjs';
import {
  normalizeMemoryRecordForSave,
  renderWorkRecordMarkdown,
  appendSkillRecord,
  pruneFilesToLimit,
  mergeDialogueActorFlagsIntoState,
  applyAcceptedFlags,
  writeDialogueActorFlagsFromState
} from './conversationPipeline.mjs';

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

function assertConversationId(id) {
  const normalized = String(id ?? '').trim();
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`lounge conversation id must be a valid conversation id: ${normalized || '(empty)'}`);
  return normalized;
}

function loungeRecordPath(id) {
  return `game_data/logs/lounge/${assertConversationId(id)}.json`;
}

function participantLogKey(conversationId, characterId) {
  return `${conversationId}_${characterId}`;
}

function participantWorkRecordId(conversationId, characterId) {
  return `wr_${conversationId}_${characterId}`;
}

function academyWeekSnapshotFromState(state) {
  const elapsed = Number(state?.elapsed_weeks);
  const elapsedWeeks = Number.isFinite(elapsed) ? Math.max(0, Math.trunc(elapsed)) : 0;
  return {
    academy_elapsed_weeks_at_start: elapsedWeeks,
    academy_week_number: Math.max(1, elapsedWeeks + 1)
  };
}

// The explicit group finalization policy. Unlike the 1:1 actor-kind policy, a lounge talk runs ONLY the
// per-participant three-piece continuity records and the conversation affinity delta; the field judgments
// (stage/event/money), buddy/enemy relationship judgments, and the MP-reserve line are skipped for the whole
// group. Kept a resolved object (not scattered checks) so the executed set is a single, testable fact.
export function resolveLoungeGroupFinalizationPolicy() {
  return {
    source_type: 'lounge',
    participant_count: 3,
    runFieldJudgments: false,
    runRelationshipJudgments: false,
    runMpReserve: false,
    perParticipant: {
      memory: true,
      skill: true,
      workRecord: true,
      affinity: { mode: 'character', buddyDelta: 0, enemyDelta: 0 }
    }
  };
}

// The shared, speaker-named transcript handed to every generation prompt: each NPC line is「- 話者名: 本文」and
// the player line is「- 主人公: 本文」. This is the multi-speaker presentation that replaces the 1:1
// "role assistant = the one actor" framing — the target participant is named separately in the instruction, so a
// generator never attributes another speaker's words to the target.
function loungeTranscriptText(record) {
  if (record.messages.length === 0) return '- なし';
  return record.messages.map((message) => (message.role === 'assistant'
    ? `- ${message.character_name}: ${message.content}`
    : `- 主人公: ${message.content}`)).join('\n');
}

function loungeParticipantRosterText(record) {
  return record.participants.map((participant) => `- ${participant.character_name} (${participant.character_id})`).join('\n');
}

function loungeContinuitySubjectRule(record, participant) {
  const otherNames = record.participants
    .filter((entry) => entry.character_id !== participant.character_id)
    .map((entry) => entry.character_name)
    .join('・');
  return [
    `対象キャラクター(${participant.character_name})の行動・発言・変容を記載する際は、必ず「${participant.character_name}」を主語として表記し、「AI」「assistant」「キャラクター」などの役割名では書かない。`,
    '主人公(プレイヤー)の行動・発言を記載する際は「主人公」を主語として使用する。',
    `他の参加者(${otherNames})の発言は文脈としてのみ扱い、対象キャラクターの記録に他人の内面や行動を混同しない。`
  ].join('');
}

function buildLoungeContinuityPrompt({ record, participant, workRecordId, finalInstruction }) {
  return [
    '次の談話(3人のキャラクターと主人公が交わした複数人の会話)だけを根拠に、対象キャラクターの継続記録を1レコード作成する。',
    '各発言は「- 話者名: 本文」の形式で、話者名がそのまま発言者である。「主人公」はプレイヤーの発言。',
    `記録の対象キャラクターは「${participant.character_name}」(${participant.character_id})。この対象キャラクター目線で、対象キャラクター自身の体験・関係性変化として記録する。`,
    '根拠はここに示す談話だけ。談話全文を出力レコードへ転載しない。',
    '',
    JSON.stringify({
      conversation_id: record.id,
      target_character_id: participant.character_id,
      target_character_name: participant.character_name,
      work_record_id: workRecordId,
      location_name: record.location_name,
      visible_situation: record.visible_situation
    }, null, 2),
    '',
    '参加者:',
    loungeParticipantRosterText(record),
    '',
    '談話:',
    loungeTranscriptText(record),
    '',
    finalInstruction
  ].join('\n');
}

function buildLoungeMemoryUpdatePrompt({ record, participant, workRecordId }) {
  return buildLoungeContinuityPrompt({
    record,
    participant,
    workRecordId,
    finalInstruction: `memory_recordの本文だけを平文で出力する。memory_recordの責務は、${participant.character_name}の主人公との関係性変化と、その変化がどの経験・会話から生じたかを残すこと。textは最大5文。可能な限り具体的な情報を盛り込み、誰が何を言った・したか、どの場面や対象から変化が生じたかを省略しすぎない。${loungeContinuitySubjectRule(record, participant)}`
  });
}

function buildLoungeSkillNecessityPrompt({ record, participant, workRecordId }) {
  return buildLoungeContinuityPrompt({
    record,
    participant,
    workRecordId,
    finalInstruction: `${participant.character_name}にとってskill_record作成の必要性判定だけを行う。今後の振る舞いに決定的な影響を与える自己変化がこの談話で実際に起きた場合だけtrue、それ以外はfalse。回答はtrueもしくはfalseのみを返す。説明文、理由、補足、JSON、Markdownコードブロックは出力しない。`
  });
}

function buildLoungeSkillUpdatePrompt({ record, participant, workRecordId }) {
  return buildLoungeContinuityPrompt({
    record,
    participant,
    workRecordId,
    finalInstruction: `skill_recordのタイトルと本文を平文で出力する。出力形式は必ず「タイトル: ...」改行「本文: ...」だけにする。責務は、${participant.character_name}自身の変化と、その変化がどの経験・会話から生じたかを残すこと。descriptionは必ず1文。${loungeContinuitySubjectRule(record, participant)}`
  });
}

function buildLoungeWorkRecordUpdatePrompt({ record, participant, workRecordId }) {
  return buildLoungeContinuityPrompt({
    record,
    participant,
    workRecordId,
    finalInstruction: `work_recordのタイトルと本文を平文で出力する。出力形式は必ず「タイトル: ...」改行「本文: ...」だけにする。work_recordの責務は、この談話で${participant.character_name}を中心に行われたやり取りを、タイトルと最大20文の本文として残すこと。タイトルは1行。summaryは最大20文。誰が何を言った・したか、どの場面・対象・判断・変化があったかを省略しない。${loungeContinuitySubjectRule(record, participant)}`
  });
}

function buildLoungeAffinityDeltaPrompt({ record, participant, workRecordId }) {
  return [
    '次の談話(3人のキャラクターと主人公が交わした複数人の会話)だけを根拠に、対象キャラクターの主人公への好感度の変化量を判定する。',
    '各発言は「- 話者名: 本文」の形式で、話者名がそのまま発言者である。「主人公」はプレイヤーの発言。',
    `対象キャラクターは「${participant.character_name}」(${participant.character_id})。この対象キャラクターから見た主人公への好感度の変化量だけを判定する。`,
    '',
    JSON.stringify({
      conversation_id: record.id,
      target_character_id: participant.character_id,
      target_character_name: participant.character_name,
      work_record_id: workRecordId
    }, null, 2),
    '',
    '参加者:',
    loungeParticipantRosterText(record),
    '',
    '談話:',
    loungeTranscriptText(record),
    '',
    '好感度の変化量を判定する基準: +10=距離が決定的に縮まる出来事があった／+5=心に残る良い会話／+1〜3=感じの良い会話／0=特筆なし／−1〜3=引っかかり／−5=明確な不快／−10=決定的な失望・裏切り',
    '回答は−10〜+10 の整数のみを出力する。説明・単位・JSON・Markdown・ラベル禁止。'
  ].join('\n');
}

async function readLoungeRecordForFinalize({ storage, conversationId }) {
  const raw = await storage.readJsonIfExists(loungeRecordPath(conversationId));
  if (raw == null) throw new Error(`lounge group record not found: ${conversationId}`);
  return validateLoungeGroupRecord(raw);
}

async function writeMarkdownRecord({ storage, root, relativePath, markdown }) {
  const fullPath = storage.resolveWritePath(relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, markdown, 'utf8');
}

function assertProvider(provider, name) {
  if (typeof provider !== 'function') throw new Error(`${name} is required`);
}

// Finalizes one participant off the shared record against the (staging) root: generates the three-piece records
// through the injected provider seams, validates them through the shared single-actor validator, writes the
// participant-scoped logs and accepted records, applies the accepted work-record flags to that participant's actor
// flags, and applies the conversation affinity delta (idempotent per conversation id inside the participant's own
// affinity file). Returns the state carrying this participant's accepted flags, threaded into the next participant.
async function finalizeLoungeParticipant({ storage, root, record, participant, state, now, weekSnapshot, providers }) {
  const conversationId = record.id;
  const workRecordId = participantWorkRecordId(conversationId, participant.character_id);
  const logKey = participantLogKey(conversationId, participant.character_id);
  const actor = resolveDialogueActor(participant.character_id);

  // Load the participant's persisted flags into state so the validator resolves the actor and knowledge-flag
  // candidates against real flags (mirrors the 1:1 finalizer's actor-flag merge).
  const actorFlagsFile = await storage.readJsonIfExists(`${actor.basePath}/flags.json`);
  mergeDialogueActorFlagsIntoState({ state, actor, flagsFile: actorFlagsFile });

  const memoryPrompt = buildLoungeMemoryUpdatePrompt({ record, participant, workRecordId });
  const skillNecessityPrompt = buildLoungeSkillNecessityPrompt({ record, participant, workRecordId });
  const workRecordPrompt = buildLoungeWorkRecordUpdatePrompt({ record, participant, workRecordId });
  const affinityPrompt = buildLoungeAffinityDeltaPrompt({ record, participant, workRecordId });

  const memoryUpdate = await providers.memoryUpdateProvider({ prompt: memoryPrompt, record, participant, workRecordId, now });
  const skillNecessity = await providers.skillNecessityProvider({ prompt: skillNecessityPrompt, record, participant, workRecordId, now });
  const workRecordUpdate = await providers.workRecordProvider({ prompt: workRecordPrompt, record, participant, workRecordId, now });

  const normalizedSkillNecessity = {
    necessary: skillNecessity?.necessary === true ? true : skillNecessity?.necessary === false ? false : null,
    raw_answer: String(skillNecessity?.raw_answer ?? '').trim(),
    source_conversation_id: conversationId,
    work_record_id: workRecordId
  };
  const skillUpdate = normalizedSkillNecessity.necessary === true
    ? await providers.skillUpdateProvider({ prompt: buildLoungeSkillUpdatePrompt({ record, participant, workRecordId }), record, participant, workRecordId, now })
    : {
      skipped: true,
      reason: normalizedSkillNecessity.necessary === false ? 'no_decisive_behavior_change' : 'invalid_skill_necessity_answer',
      raw_answer: normalizedSkillNecessity.raw_answer,
      source_conversation_id: conversationId,
      work_record_id: workRecordId
    };

  const conversationProjection = { id: conversationId, character_id: participant.character_id, character_name: participant.character_name };
  // The target participant owns every record: force character_id to the participant so a generator can never
  // misattribute a record to another speaker (the validator resolves memory/skill against this id).
  const memoryRecord = { ...normalizeMemoryRecordForSave({ memoryUpdate, conversation: conversationProjection, workRecordId }), character_id: participant.character_id };
  const skillRecord = skillUpdate.skipped
    ? null
    : { ...(skillUpdate.skill_record ?? skillUpdate), character_id: participant.character_id, visibility: 'character_known', source_conversation_id: conversationId, work_record_id: workRecordId };
  const workRecordDraft = {
    ...(workRecordUpdate.work_record ?? workRecordUpdate),
    id: workRecordId,
    character_id: participant.character_id,
    source_conversation_id: conversationId,
    work_record_id: workRecordId,
    academy_week_number: weekSnapshot.academy_week_number,
    academy_elapsed_weeks_at_start: weekSnapshot.academy_elapsed_weeks_at_start
  };

  const validator = validateConversationRecordUpdates({
    sourceType: 'dialogue',
    state,
    memoryRecord,
    skillRecord,
    workRecordDraft,
    flagUpdateCandidates: workRecordDraft.flag_update_candidates ?? workRecordUpdate.flag_update_candidates ?? []
  });

  await storage.writeJson(`game_data/logs/memory_updates/${logKey}.json`, memoryUpdate);
  await storage.writeJson(`game_data/logs/skill_updates/${logKey}.json`, skillUpdate);
  await storage.writeJson(`game_data/logs/work_record_updates/${logKey}.json`, workRecordUpdate);
  await storage.writeJson(`game_data/logs/validator/${logKey}.json`, validator);

  const acceptedMemory = validator.accepted_memory[0] ?? null;
  const acceptedSkill = validator.accepted_skills[0] ?? null;
  if (acceptedMemory) {
    const memoryActor = resolveDialogueActor(acceptedMemory.character_id);
    await storage.writeJson(`${memoryActor.basePath}/memory/${acceptedMemory.id}.json`, acceptedMemory);
    await pruneFilesToLimit(root, `${memoryActor.basePath}/memory`, '.json');
  }
  if (acceptedSkill) await appendSkillRecord({ root, characterId: acceptedSkill.character_id, skillRecord: acceptedSkill });
  if (validator.accepted_work_record) {
    const markdown = renderWorkRecordMarkdown({ id: workRecordId, draft: validator.accepted_work_record });
    await writeMarkdownRecord({ storage, root, relativePath: `${actor.basePath}/work_records/${workRecordId}.md`, markdown });
    await pruneFilesToLimit(root, `${actor.basePath}/work_records`, '.md');
  }

  const nextState = applyAcceptedFlags(state, validator);
  await writeDialogueActorFlagsFromState({ root, state: nextState, actorId: participant.character_id });

  const rawAffinityDelta = await providers.affinityDeltaProvider({ prompt: affinityPrompt, record, participant, workRecordId, now });
  const conversationDelta = parseAffinityDeltaAnswer(rawAffinityDelta);
  const affinityUpdatePath = `game_data/logs/affinity_updates/${logKey}.json`;
  const appliedAffinity = await applyCharacterAffinityDelta({
    root,
    characterId: participant.character_id,
    conversationId,
    conversationDelta,
    buddyDelta: 0,
    enemyDelta: 0
  });
  const priorAffinityUpdate = appliedAffinity.already_applied ? await storage.readJsonIfExists(affinityUpdatePath) : null;
  const affinityUpdate = {
    conversation_id: conversationId,
    work_record_id: workRecordId,
    character_id: participant.character_id,
    character_name: participant.character_name,
    raw_answer: String(rawAffinityDelta ?? '').trim(),
    conversation_delta: priorAffinityUpdate?.conversation_delta ?? appliedAffinity.conversation_delta,
    buddy_delta: 0,
    enemy_delta: 0,
    total_delta: priorAffinityUpdate?.total_delta ?? appliedAffinity.total_delta,
    before_affinity: priorAffinityUpdate?.before_affinity ?? appliedAffinity.before_affinity,
    after_affinity: priorAffinityUpdate?.after_affinity ?? appliedAffinity.after_affinity,
    already_applied: appliedAffinity.already_applied === true,
    prompt: affinityPrompt,
    updated_at: now
  };
  await storage.writeJson(affinityUpdatePath, affinityUpdate);

  return {
    state: nextState,
    participant_id: participant.character_id,
    work_record_id: workRecordId,
    memory_update: memoryUpdate,
    skill_update: skillUpdate,
    work_record_update: workRecordUpdate,
    validator,
    affinity_update: affinityUpdate
  };
}

// Runs the aggregate lounge finalization against a given root (a finalize-staging workspace under the atomic
// path, or a plain root in unit tests). Finalizes all three seated participants off the shared transcript, then —
// only after every participant succeeds — writes exactly one group finalization marker and discards the transcript
// once. A missing record, an already-present finalization marker (re-finalization), or any participant failure
// throws; the caller's staging discards the workspace so no partial finalize is promoted.
export async function runLoungeGroupFinalization({
  root,
  conversationId,
  now = new Date().toISOString(),
  finalStateTransform = (state) => state,
  memoryUpdateProvider,
  skillNecessityProvider,
  skillUpdateProvider,
  workRecordProvider,
  affinityDeltaProvider
}) {
  if (!root) throw new Error('root is required');
  const normalizedConversationId = assertConversationId(conversationId);
  assertProvider(memoryUpdateProvider, 'memoryUpdateProvider');
  assertProvider(skillNecessityProvider, 'skillNecessityProvider');
  assertProvider(skillUpdateProvider, 'skillUpdateProvider');
  assertProvider(workRecordProvider, 'workRecordProvider');
  assertProvider(affinityDeltaProvider, 'affinityDeltaProvider');
  const providers = { memoryUpdateProvider, skillNecessityProvider, skillUpdateProvider, workRecordProvider, affinityDeltaProvider };

  const policy = resolveLoungeGroupFinalizationPolicy();
  const storage = createStorageApi({ root });

  const existingMarker = await storage.readJsonIfExists(`game_data/logs/finalization/${normalizedConversationId}.json`);
  if (existingMarker) throw new Error(`lounge conversation already finalized: ${normalizedConversationId}`);

  const record = await readLoungeRecordForFinalize({ storage, conversationId: normalizedConversationId });
  let state = await storage.readJson('game_data/runtime_state.json');
  const weekSnapshot = academyWeekSnapshotFromState(state);

  const participantResults = [];
  for (const participant of record.participants) {
    const result = await finalizeLoungeParticipant({ storage, root, record, participant, state, now, weekSnapshot, providers });
    state = result.state;
    participantResults.push(result);
  }

  const nextState = finalStateTransform(state);
  await storage.writeJson('game_data/runtime_state.json', nextState);

  // One group finalization marker for the whole talk (never one per participant): the per-participant validator
  // logs are keyed `<conversation_id>_<character_id>`, so this marker is the single group-level record that the
  // talk was finalized, carrying each participant's work-record id.
  const finalizationMarker = {
    conversation_id: normalizedConversationId,
    source_type: policy.source_type,
    finalized_at: now,
    participants: participantResults.map((result) => ({ character_id: result.participant_id, work_record_id: result.work_record_id }))
  };
  await storage.writeJson(`game_data/logs/finalization/${normalizedConversationId}.json`, finalizationMarker);

  // One transcript discard for the whole talk: the shared transcript is the finalization input, so it is dropped
  // exactly once after all three participants have consumed it. The record keeps its participants/scene/cursor
  // (a valid empty-message record) so the raw utterances are gone but the group's structure remains inspectable.
  const discardedRecord = validateLoungeGroupRecord({ ...record, messages: [] });
  await storage.writeJson(loungeRecordPath(normalizedConversationId), discardedRecord);

  return {
    conversation_id: normalizedConversationId,
    policy,
    participants: participantResults,
    finalization_marker: finalizationMarker,
    record: discardedRecord,
    state: nextState
  };
}

// Finalizes a lounge group conversation atomically: the three-participant aggregate runs inside one
// finalize-staging workspace and is promoted in a single atomic mirror only if every participant succeeds. A
// failure discards the staging workspace, leaving the live slot untouched (no partial finalize). Mirrors the 1:1
// `finalizeConversationAtomic` staging contract; the injected provider seams are the LM boundary.
export async function finalizeLoungeGroupConversationAtomic({
  root,
  conversationId,
  now = new Date().toISOString(),
  memoryUpdateProvider,
  skillNecessityProvider,
  skillUpdateProvider,
  workRecordProvider,
  affinityDeltaProvider
}) {
  if (!root) throw new Error('root is required');
  return await runOutsideRoutingReadScope(() => runAtomicFinalizationWithStaging({
    root,
    conversationId,
    finalizer: ({ root: stagingRoot, finalStateTransform }) => runLoungeGroupFinalization({
      root: stagingRoot,
      conversationId,
      now,
      finalStateTransform,
      memoryUpdateProvider,
      skillNecessityProvider,
      skillUpdateProvider,
      workRecordProvider,
      affinityDeltaProvider
    })
  }));
}
