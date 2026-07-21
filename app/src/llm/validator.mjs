import { resolveDialogueActor } from './dialogueActor.mjs';

function actorStateEntry(state, actorId) {
  if (!actorId) return null;
  const actor = resolveDialogueActor(actorId);
  return state?.[actor.stateCollection]?.[actor.id] ?? null;
}

function flagExists({ state, characterId, flag }) {
  if (Object.prototype.hasOwnProperty.call(state.global_flags ?? {}, flag)) return true;
  const actorFlags = actorStateEntry(state, characterId)?.flags ?? {};
  return Object.prototype.hasOwnProperty.call(actorFlags, flag);
}

function sentenceCount(text) {
  const source = String(text ?? '').trim();
  if (!source) return 0;
  return source.split(/[。.!?！？]+/u).map((part) => part.trim()).filter(Boolean).length || 1;
}

function validateFlagCandidate({ candidate, sourceType, state }) {
  if (!candidate?.flag || !candidate?.op) return 'missing flag or op';
  if (!['set', 'increment'].includes(candidate.op)) return `unsupported op: ${candidate.op}`;
  if (candidate.op === 'increment' && typeof candidate.value !== 'number') return 'increment value must be numeric';
  if (!flagExists({ state, characterId: candidate.character_id, flag: candidate.flag })) return `unknown flag: ${candidate.flag}`;
  return null;
}

function validateMemoryRecord(candidate, state) {
  if (!candidate?.character_id || !actorStateEntry(state, candidate.character_id)) return 'unknown dialogue actor';
  if (!candidate?.id || !candidate?.text) return 'memory record requires id and text';
  if (!candidate?.source_conversation_id) return 'memory record requires source_conversation_id';
  if (!candidate?.work_record_id) return 'memory record requires work_record_id';
  if (candidate.visibility && candidate.visibility !== 'character_known') return 'memory must be character_known before saving to character memory';
  if (sentenceCount(candidate.text) > 5) return 'memory text must be 5 sentences or fewer';
  return null;
}

function validateSkillRecord(candidate, state) {
  if (!candidate?.character_id || !actorStateEntry(state, candidate.character_id)) return 'unknown dialogue actor';
  if (!candidate?.id || !candidate?.description) return 'skill record requires id and description';
  if (!candidate?.source_conversation_id) return 'skill record requires source_conversation_id';
  if (!candidate?.work_record_id) return 'skill record requires work_record_id';
  if (candidate.visibility && candidate.visibility !== 'character_known') return 'skill must be character_known before saving to character skills';
  if (sentenceCount(candidate.description) !== 1) return 'skill description must be exactly 1 sentence';
  return null;
}

function validateWorkRecordDraft(draft) {
  const required = ['title', 'summary'];
  for (const key of required) {
    const value = draft?.[key];
    if (Array.isArray(value) && value.length === 0) return `work_record missing ${key}`;
    if (!Array.isArray(value) && !value) return `work_record missing ${key}`;
  }
  if (draft.academy_week_number !== undefined && (!Number.isInteger(draft.academy_week_number) || draft.academy_week_number < 1)) return 'work_record academy_week_number must be a positive integer';
  if (draft.academy_elapsed_weeks_at_start !== undefined && (!Number.isInteger(draft.academy_elapsed_weeks_at_start) || draft.academy_elapsed_weeks_at_start < 0)) return 'work_record academy_elapsed_weeks_at_start must be a non-negative integer';
  if (sentenceCount(draft.summary) > 20) return 'work_record summary must be 20 sentences or fewer';
  if (draft.messages || draft.full_transcript) return 'work_record must be a summary, not the full conversation content';
  return null;
}

function sanitizeWorkRecordDraft(draft) {
  if (!draft) return draft;
  return {
    id: draft.id,
    character_id: draft.character_id,
    source_conversation_id: draft.source_conversation_id,
    work_record_id: draft.work_record_id,
    academy_week_number: draft.academy_week_number,
    academy_elapsed_weeks_at_start: draft.academy_elapsed_weeks_at_start,
    title: draft.title,
    summary: draft.summary,
    flag_update_candidates: draft.flag_update_candidates ?? [],
    warnings: draft.warnings ?? []
  };
}

export function validateConversationRecordUpdates({ sourceType = 'dialogue', state, memoryRecord, skillRecord, workRecordDraft, flagUpdateCandidates = [] }) {
  const accepted_flags = [];
  const rejected_flags = [];
  for (const candidate of flagUpdateCandidates ?? []) {
    const reason = validateFlagCandidate({ candidate, sourceType, state });
    if (reason) rejected_flags.push({ ...candidate, reason });
    else accepted_flags.push(candidate);
  }

  const memoryReason = validateMemoryRecord(memoryRecord, state);
  const skillReason = skillRecord ? validateSkillRecord(skillRecord, state) : null;
  const workRecordReason = validateWorkRecordDraft(workRecordDraft);
  const acceptedWorkRecord = workRecordReason ? null : sanitizeWorkRecordDraft(workRecordDraft);
  return {
    source_conversation_id: workRecordDraft?.source_conversation_id ?? memoryRecord?.source_conversation_id ?? skillRecord?.source_conversation_id ?? null,
    accepted_flags,
    rejected_flags,
    accepted_memory: memoryReason ? [] : [memoryRecord],
    rejected_memory: memoryReason ? [{ ...(memoryRecord ?? {}), reason: memoryReason }] : [],
    accepted_skills: skillRecord && !skillReason ? [skillRecord] : [],
    rejected_skills: skillRecord && skillReason ? [{ ...(skillRecord ?? {}), reason: skillReason }] : [],
    accepted_work_record: acceptedWorkRecord,
    rejected_work_record: workRecordReason ? { reason: workRecordReason, draft: workRecordDraft } : null
  };
}

export function validateReflectionCandidates({ sourceType, state, reflection }) {
  const workRecordId = reflection.work_record_draft?.work_record_id ?? `wr_${reflection.source_conversation_id}`;
  return validateConversationRecordUpdates({
    sourceType,
    state,
    memoryRecord: (reflection.memory_update_candidates ?? [])[0] ? {
      ...(reflection.memory_update_candidates ?? [])[0],
      source_conversation_id: (reflection.memory_update_candidates ?? [])[0].source_conversation_id ?? reflection.source_conversation_id,
      work_record_id: (reflection.memory_update_candidates ?? [])[0].work_record_id ?? workRecordId
    } : null,
    skillRecord: (reflection.skill_update_candidates ?? [])[0] ? {
      ...(reflection.skill_update_candidates ?? [])[0],
      source_conversation_id: (reflection.skill_update_candidates ?? [])[0].source_conversation_id ?? reflection.source_conversation_id,
      work_record_id: (reflection.skill_update_candidates ?? [])[0].work_record_id ?? workRecordId
    } : null,
    workRecordDraft: reflection.work_record_draft ? {
      ...reflection.work_record_draft,
      source_conversation_id: reflection.source_conversation_id,
      work_record_id: workRecordId,
      summary: reflection.work_record_draft.summary ?? [
        reflection.work_record_draft.scene,
        reflection.work_record_draft.what_player_did,
        reflection.work_record_draft.what_character_did,
        reflection.work_record_draft.character_interpretation,
        reflection.work_record_draft.uncertainty
      ].filter(Boolean).join(' ')
    } : null,
    flagUpdateCandidates: reflection.flag_update_candidates ?? []
  });
}
