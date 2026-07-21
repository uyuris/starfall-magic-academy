const DEFAULT_RECENT_MEMORY_COUNT = 3;

function normalizedString(value) {
  return String(value ?? '').trim();
}

function normalizeConversationSortKey(value) {
  const text = normalizedString(value);
  return text.startsWith('conv_') ? text.slice('conv_'.length) : text;
}

export function memoryChronologyKey(memory) {
  const sourceConversationId = normalizedString(memory?.source_conversation_id);
  if (sourceConversationId) return normalizeConversationSortKey(sourceConversationId);
  const id = normalizedString(memory?.id);
  const memorySourceId = id.startsWith('mem_') ? id.slice('mem_'.length) : id;
  return normalizeConversationSortKey(memorySourceId);
}

export function sortMemoriesByChronology(memories) {
  return [...(memories ?? [])]
    .map((memory, index) => ({ memory, index, key: memoryChronologyKey(memory) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index)
    .map((item) => item.memory);
}

function isPromptVisibleMemory(memory) {
  return !memory?.visibility || memory.visibility === 'character_known' || memory.visibility === 'public';
}

function workRecordCandidateIdsForMemory(memory) {
  const explicitId = normalizedString(memory?.work_record_id);
  if (explicitId) return [explicitId];
  const sourceConversationId = normalizedString(memory?.source_conversation_id);
  return sourceConversationId ? [`wr_${sourceConversationId}`] : [];
}

export function mergeWorkRecordsById(...recordLists) {
  const byId = new Map();
  for (const records of recordLists) {
    for (const record of records ?? []) {
      const id = normalizedString(record?.id);
      if (!id) continue;
      byId.set(id, record);
    }
  }
  return Array.from(byId.values());
}

export function buildContinuityPromptContext({
  memories = [],
  workRecords = [],
  allWorkRecords = [],
  recentMemoryCount = DEFAULT_RECENT_MEMORY_COUNT
} = {}) {
  const promptMemories = (memories ?? []).filter(isPromptVisibleMemory);
  const sortedMemories = sortMemoriesByChronology(promptMemories);
  const replacementLimit = Math.max(0, Math.trunc(Number(recentMemoryCount) || 0));
  if (!replacementLimit || sortedMemories.length === 0) {
    return {
      memoriesForPrompt: sortedMemories,
      workRecordsForPrompt: mergeWorkRecordsById(workRecords),
      recentMemoryIds: [],
      substitutedWorkRecordIds: [],
      missingRecentWorkRecordIds: []
    };
  }

  const firstRecentIndex = Math.max(0, sortedMemories.length - replacementLimit);
  const oldMemories = sortedMemories.slice(0, firstRecentIndex);
  const recentMemories = sortedMemories.slice(firstRecentIndex);
  const recordPool = (allWorkRecords?.length ? allWorkRecords : workRecords) ?? [];
  const workRecordsById = new Map(recordPool.map((record) => [normalizedString(record?.id), record]).filter(([id]) => id));
  const keptRecentMemories = [];
  const substitutedWorkRecords = [];
  const recentMemoryIds = [];
  const substitutedWorkRecordIds = [];
  const missingRecentWorkRecordIds = [];

  for (const memory of recentMemories) {
    const memoryId = normalizedString(memory?.id);
    if (memoryId) recentMemoryIds.push(memoryId);
    const candidateIds = workRecordCandidateIdsForMemory(memory);
    const workRecord = candidateIds.map((id) => workRecordsById.get(id)).find(Boolean);
    if (workRecord) {
      substitutedWorkRecords.push(workRecord);
      substitutedWorkRecordIds.push(workRecord.id);
    } else {
      keptRecentMemories.push(memory);
      missingRecentWorkRecordIds.push(candidateIds[0] ?? memoryId);
    }
  }

  return {
    memoriesForPrompt: [...oldMemories, ...keptRecentMemories],
    workRecordsForPrompt: mergeWorkRecordsById(substitutedWorkRecords, workRecords),
    recentMemoryIds,
    substitutedWorkRecordIds,
    missingRecentWorkRecordIds
  };
}
