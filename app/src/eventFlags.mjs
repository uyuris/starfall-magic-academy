import { createStorageApi } from './storage.mjs';
import { normalizeStageFlagJudgment } from './stageFlags.mjs';
import { loadInventory } from './economy.mjs';
import { selectRandomLocationSituation } from './fieldRuntime.mjs';

export const EVENT_FLAG_DEFINITIONS_PATH = 'game_data/event_flags.json';

function storageApiFor(rootOrStorage) {
  if (rootOrStorage && typeof rootOrStorage.readJson === 'function' && typeof rootOrStorage.writeJson === 'function') {
    return rootOrStorage;
  }
  return createStorageApi({ root: rootOrStorage });
}

async function readJsonIfExists(rootOrStorage, relativePath, fallback = null) {
  const storage = storageApiFor(rootOrStorage);
  const value = await storage.readJsonIfExists(relativePath);
  return value == null ? (fallback == null ? null : structuredClone(fallback)) : value;
}

async function writeJson(rootOrStorage, relativePath, value) {
  const storage = storageApiFor(rootOrStorage);
  await storage.writeJson(relativePath, value);
}

function normalizeRequiredItems(items) {
  return (items ?? [])
    .map((item) => ({
      item_id: String(item.item_id ?? item.id ?? '').trim(),
      quantity: Math.max(1, Math.floor(Number(item.quantity ?? 1)))
    }))
    .filter((item) => item.item_id);
}

function normalizeRequiredFlags(flagIds) {
  return (flagIds ?? []).map((flagId) => String(flagId ?? '').trim()).filter(Boolean);
}

function normalizeInteraction(interaction) {
  if (!interaction || typeof interaction !== 'object') return null;
  const locationId = String(interaction.location_id ?? '').trim();
  if (!locationId) return null;
  return {
    location_id: locationId,
    source_type: String(interaction.source_type ?? 'event').trim() || 'event',
    opening_context: String(interaction.opening_context ?? '').trim()
  };
}

function normalizeCompletionJudgment(completionJudgment, completedFlagId) {
  if (!completionJudgment || typeof completionJudgment !== 'object') return null;
  const locationId = String(completionJudgment.location_id ?? '').trim();
  const question = String(completionJudgment.question ?? completionJudgment.condition ?? '').trim();
  const flagId = String(completionJudgment.completed_flag_id ?? completedFlagId ?? '').trim();
  if (!locationId || !question || !flagId) return null;
  return {
    location_id: locationId,
    completed_flag_id: flagId,
    condition: String(completionJudgment.condition ?? question).trim(),
    question
  };
}

function normalizeParticipantOverrideJudgment(participantOverrideJudgment) {
  if (!participantOverrideJudgment || typeof participantOverrideJudgment !== 'object') return null;
  const question = String(participantOverrideJudgment.question ?? participantOverrideJudgment.condition ?? '').trim();
  if (!question) return null;
  return {
    condition: String(participantOverrideJudgment.condition ?? question).trim(),
    question
  };
}

export async function loadEventFlags({ root }) {
  const file = await readJsonIfExists(root, EVENT_FLAG_DEFINITIONS_PATH);
  return {
    flags: (file?.flags ?? []).map((flag) => ({
      id: String(flag.id ?? ''),
      label: flag.label ?? flag.title ?? flag.id ?? '',
      condition: flag.condition ?? '',
      question: flag.question ?? flag.condition ?? '',
      required_global_flags: normalizeRequiredFlags(flag.required_global_flags ?? flag.required_flags),
      required_inventory_items: normalizeRequiredItems(flag.required_inventory_items ?? flag.required_items),
      completed_flag_id: flag.completed_flag_id ?? flag.completion_flag_id ?? null,
      event_id: flag.event_id ?? null,
      description: flag.description ?? flag.homage_note ?? '',
      hidden_from_event_status: flag.hidden_from_event_status === true,
      auto_ready_when_prerequisites_met: flag.auto_ready_when_prerequisites_met === true,
      conversation_end_judgment: flag.conversation_end_judgment === false ? false : true,
      complete_when_started: flag.complete_when_started === true,
      complete_on_conversation_end: flag.complete_on_conversation_end === true,
      interaction: normalizeInteraction(flag.interaction),
      completion_judgment: normalizeCompletionJudgment(flag.completion_judgment, flag.completed_flag_id ?? flag.completion_flag_id ?? null),
      participant_override_judgment: normalizeParticipantOverrideJudgment(flag.participant_override_judgment ?? flag.companion_override_judgment)
    })).filter((flag) => flag.id && flag.condition)
  };
}

function inventoryQuantity(inventory, itemId) {
  return (inventory?.items ?? []).find((item) => item.item_id === itemId)?.quantity ?? 0;
}

function requiredGlobalFlagsMet(flag, state) {
  const globalFlags = state?.global_flags ?? {};
  for (const requiredFlag of flag.required_global_flags ?? []) {
    if (globalFlags[requiredFlag] !== true) return false;
  }
  return true;
}

function prerequisitesMet(flag, { state, inventory }) {
  if (!requiredGlobalFlagsMet(flag, state)) return false;
  for (const requiredItem of flag.required_inventory_items ?? []) {
    if (inventoryQuantity(inventory, requiredItem.item_id) < requiredItem.quantity) return false;
  }
  return true;
}

export function selectEventFlagJudgmentTargets({ flags, state, inventory, conversation }) {
  const globalFlags = state?.global_flags ?? {};
  return (flags ?? []).filter((flag) => {
    if (!prerequisitesMet(flag, { state, inventory })) return false;
    if (flag.auto_ready_when_prerequisites_met === true) return false;
    if (flag.conversation_end_judgment === false) return false;
    return globalFlags[flag.id] !== true;
  });
}

export async function defaultEventFlagJudgmentProvider() {
  return { flag_results: [] };
}

export async function judgeEventFlagsAfterConversation({
  root,
  state,
  inventory,
  conversation,
  workRecordId,
  eventFlagJudgmentProvider = defaultEventFlagJudgmentProvider,
  now = new Date().toISOString()
}) {
  const definitions = await loadEventFlags({ root });
  const candidateFlags = selectEventFlagJudgmentTargets({ flags: definitions.flags, state, inventory, conversation });
  const baseLog = {
    conversation_id: conversation.id,
    judged_at: now,
    candidate_flags: candidateFlags,
    raw_result: { flag_results: [] },
    accepted: [],
    rejected: []
  };
  if (candidateFlags.length === 0) {
    await writeJson(root, `game_data/logs/event_flag_judgments/${conversation.id}.json`, baseLog);
    return baseLog;
  }
  const rawResult = normalizeStageFlagJudgment(await eventFlagJudgmentProvider({ conversation, state, inventory, candidateFlags, workRecordId, now }), candidateFlags);
  const candidateIds = new Set(candidateFlags.map((flag) => flag.id));
  const accepted = [];
  const rejected = [];
  for (const result of rawResult.flag_results) {
    if (!candidateIds.has(result.flag_id)) {
      rejected.push({ ...result, reason: result.reason || 'not a candidate because prerequisites were missing or the same character already owns this active flag' });
      continue;
    }
    const enriched = {
      ...result,
      character_id: conversation.character_id ?? null,
      conversation_id: conversation.id,
      achieved_at: now
    };
    if (result.achieved) accepted.push(enriched);
    else rejected.push(enriched);
  }
  const log = { ...baseLog, raw_result: rawResult, accepted, rejected };
  await writeJson(root, `game_data/logs/event_flag_judgments/${conversation.id}.json`, log);
  return log;
}

export function applyAcceptedEventFlags(state, judgment) {
  const next = structuredClone(state);
  next.global_flags ??= {};
  next.event_flag_sources ??= {};
  for (const accepted of judgment?.accepted ?? []) {
    next.global_flags[accepted.flag_id] = true;
    next.event_flag_sources[accepted.flag_id] = {
      character_id: accepted.character_id ?? null,
      conversation_id: accepted.conversation_id ?? null,
      achieved_at: accepted.achieved_at ?? null
    };
  }
  return next;
}

export function selectEventParticipantOverrideJudgmentTargets({ flags, state, inventory, conversation }) {
  const globalFlags = state?.global_flags ?? {};
  const eventSources = state?.event_flag_sources ?? {};
  const conversationCharacterId = conversation?.character_id ?? null;
  return (flags ?? []).filter((flag) => {
    if (!flag.participant_override_judgment) return false;
    if (!conversationCharacterId) return false;
    if (!requiredGlobalFlagsMet(flag, state)) return false;
    if (flag.completed_flag_id && globalFlags[flag.completed_flag_id] === true) return false;
    const source = eventSources[flag.id] ?? derivedAutoReadySource(flag, state);
    if (!source?.character_id) return false;
    if (source.character_id === conversationCharacterId) return false;
    return true;
  }).map((flag) => {
    const source = eventSources[flag.id] ?? derivedAutoReadySource(flag, state);
    const ready = globalFlags[flag.id] === true || prerequisitesMet(flag, { state, inventory });
    return {
      ...flag,
      active: ready,
      ready,
      completed: Boolean(flag.completed_flag_id && globalFlags[flag.completed_flag_id] === true),
      source,
      character_id: source?.character_id ?? null,
      source_conversation_id: source?.conversation_id ?? null,
      achieved_at: source?.achieved_at ?? null,
      condition: flag.participant_override_judgment.condition,
      question: flag.participant_override_judgment.question
    };
  });
}

export async function defaultEventParticipantOverrideJudgmentProvider() {
  return { flag_results: [] };
}

export async function judgeEventParticipantOverridesAfterConversation({
  root,
  state,
  inventory,
  conversation,
  workRecordId,
  eventParticipantOverrideJudgmentProvider = defaultEventParticipantOverrideJudgmentProvider,
  now = new Date().toISOString()
}) {
  const definitions = await loadEventFlags({ root });
  const candidateFlags = selectEventParticipantOverrideJudgmentTargets({ flags: definitions.flags, state, inventory, conversation });
  const baseLog = {
    conversation_id: conversation.id,
    judged_at: now,
    candidate_flags: candidateFlags,
    raw_result: { flag_results: [] },
    accepted: [],
    rejected: []
  };
  if (candidateFlags.length === 0) {
    await writeJson(root, `game_data/logs/event_participant_override_judgments/${conversation.id}.json`, baseLog);
    return baseLog;
  }
  const rawResult = normalizeStageFlagJudgment(await eventParticipantOverrideJudgmentProvider({ conversation, state, inventory, candidateFlags, workRecordId, now }), candidateFlags);
  const candidateIds = new Set(candidateFlags.map((flag) => flag.id));
  const accepted = [];
  const rejected = [];
  for (const result of rawResult.flag_results) {
    if (!candidateIds.has(result.flag_id)) {
      rejected.push({ ...result, reason: result.reason || 'not a candidate because the event is not ready, is completed, lacks participant override judgment, or already uses this character' });
      continue;
    }
    const flag = candidateFlags.find((entry) => entry.id === result.flag_id);
    const enriched = {
      ...result,
      character_id: conversation.character_id ?? null,
      conversation_id: conversation.id,
      achieved_at: now,
      previous_character_id: flag.character_id ?? null,
      previous_conversation_id: flag.source_conversation_id ?? null,
      ready: flag.ready === true
    };
    if (result.achieved) accepted.push(enriched);
    else rejected.push(enriched);
  }
  const log = { ...baseLog, raw_result: rawResult, accepted, rejected };
  await writeJson(root, `game_data/logs/event_participant_override_judgments/${conversation.id}.json`, log);
  return log;
}

export function applyAcceptedEventParticipantOverrides(state, judgment) {
  const next = structuredClone(state);
  next.global_flags ??= {};
  next.event_flag_sources ??= {};
  for (const accepted of judgment?.accepted ?? []) {
    if (accepted.ready === true || next.global_flags[accepted.flag_id] === true) {
      next.global_flags[accepted.flag_id] = true;
    }
    next.event_flag_sources[accepted.flag_id] = {
      character_id: accepted.character_id ?? null,
      conversation_id: accepted.conversation_id ?? null,
      achieved_at: accepted.achieved_at ?? null,
      participant_override: true,
      previous_character_id: accepted.previous_character_id ?? null,
      previous_conversation_id: accepted.previous_conversation_id ?? null
    };
  }
  return next;
}

function isConversationEndingCurrentEvent(flag, state, conversation) {
  if (flag.complete_on_conversation_end !== true) return false;
  if (!flag.completed_flag_id) return false;
  const explicitEventFlagId = conversation?.event_flag_id ?? state?.pending_interaction_context?.event_flag_id ?? null;
  const inferredFromEventConversation = !explicitEventFlagId
    && conversation?.source_type === 'event'
    && flag.interaction?.location_id
    && conversation?.location_id === flag.interaction.location_id
    && (!state?.event_flag_sources?.[flag.id]?.character_id || state.event_flag_sources[flag.id].character_id === conversation?.character_id);
  if ((explicitEventFlagId ?? (inferredFromEventConversation ? flag.id : null)) !== flag.id) return false;
  if (conversation?.source_type && conversation.source_type !== 'event') return false;
  if (state?.current_interaction_character_id && conversation?.character_id && state.current_interaction_character_id !== conversation.character_id) return false;
  if (flag.interaction?.location_id && conversation?.location_id && flag.interaction.location_id !== conversation.location_id) return false;
  return true;
}

export function selectEventCompletionJudgmentTargets({ flags, state, conversation }) {
  const globalFlags = state?.global_flags ?? {};
  const locationId = conversation?.location_id ?? state?.current_location_id ?? null;
  return (flags ?? []).filter((flag) => {
    if (!flag.completion_judgment) return false;
    if (flag.completion_judgment.location_id !== locationId) return false;
    if (globalFlags[flag.id] !== true) return false;
    if (globalFlags[flag.completion_judgment.completed_flag_id] === true) return false;
    return true;
  });
}

export async function defaultEventCompletionJudgmentProvider() {
  return { flag_results: [] };
}

function selectConversationEndCompletionTargets({ flags, state, conversation }) {
  const globalFlags = state?.global_flags ?? {};
  return (flags ?? []).filter((flag) => {
    if (!isConversationEndingCurrentEvent(flag, state, conversation)) return false;
    if (globalFlags[flag.id] !== true) return false;
    if (globalFlags[flag.completed_flag_id] === true) return false;
    return true;
  });
}

function conversationEndCompletionResult(flag, conversation, now) {
  return {
    flag_id: flag.id,
    achieved: true,
    completed_flag_id: flag.completed_flag_id,
    character_id: conversation.character_id ?? null,
    conversation_id: conversation.id,
    achieved_at: now,
    completed_on_conversation_end: true
  };
}

export async function judgeEventCompletionsAfterConversation({
  root,
  state,
  conversation,
  workRecordId,
  eventCompletionJudgmentProvider = defaultEventCompletionJudgmentProvider,
  now = new Date().toISOString()
}) {
  const definitions = await loadEventFlags({ root });
  const conversationEndFlags = selectConversationEndCompletionTargets({ flags: definitions.flags, state, conversation });
  const judgmentFlags = selectEventCompletionJudgmentTargets({ flags: definitions.flags, state, conversation })
    .filter((flag) => !conversationEndFlags.some((autoFlag) => autoFlag.id === flag.id));
  const accepted = conversationEndFlags.map((flag) => conversationEndCompletionResult(flag, conversation, now));
  const baseLog = {
    conversation_id: conversation.id,
    judged_at: now,
    candidate_flags: [...conversationEndFlags, ...judgmentFlags],
    raw_result: { flag_results: [] },
    accepted,
    rejected: []
  };
  if (judgmentFlags.length === 0) {
    await writeJson(root, `game_data/logs/event_completion_judgments/${conversation.id}.json`, baseLog);
    return baseLog;
  }
  const providerFlags = judgmentFlags.map((flag) => ({
    ...flag,
    condition: flag.completion_judgment.condition,
    question: flag.completion_judgment.question,
    completion_flag_id: flag.completion_judgment.completed_flag_id
  }));
  const rawResult = normalizeStageFlagJudgment(await eventCompletionJudgmentProvider({ conversation, state, candidateFlags: providerFlags, workRecordId, now }), providerFlags);
  const candidateIds = new Set(judgmentFlags.map((flag) => flag.id));
  const rejected = [];
  for (const result of rawResult.flag_results) {
    if (!candidateIds.has(result.flag_id)) {
      rejected.push({ ...result, reason: result.reason || 'not a candidate because event was not active, already completed, or this conversation was outside the completion location' });
      continue;
    }
    const flag = judgmentFlags.find((entry) => entry.id === result.flag_id);
    const enriched = {
      ...result,
      completed_flag_id: flag.completion_judgment.completed_flag_id,
      character_id: conversation.character_id ?? null,
      conversation_id: conversation.id,
      achieved_at: now
    };
    if (result.achieved) accepted.push(enriched);
    else rejected.push(enriched);
  }
  const log = { ...baseLog, raw_result: rawResult, accepted, rejected };
  await writeJson(root, `game_data/logs/event_completion_judgments/${conversation.id}.json`, log);
  return log;
}

export function applyAcceptedEventCompletions(state, judgment) {
  const next = structuredClone(state);
  next.global_flags ??= {};
  next.event_completion_sources ??= {};
  for (const accepted of judgment?.accepted ?? []) {
    next.global_flags[accepted.completed_flag_id] = true;
    next.event_completion_sources[accepted.completed_flag_id] = {
      event_flag_id: accepted.flag_id,
      character_id: accepted.character_id ?? null,
      conversation_id: accepted.conversation_id ?? null,
      achieved_at: accepted.achieved_at ?? null,
      ...(accepted.completed_on_conversation_end === true ? { completed_on_conversation_end: true } : {})
    };
  }
  return next;
}

function derivedAutoReadySource(flag, state) {
  const sources = state?.event_flag_sources ?? {};
  for (const requiredFlag of flag.required_global_flags ?? []) {
    if (sources[requiredFlag]) return sources[requiredFlag];
  }
  return { character_id: null, conversation_id: null, achieved_at: null, auto_ready: true };
}

export function decorateEventFlags(definitions, state, inventory = null) {
  const globalFlags = state?.global_flags ?? {};
  const eventSources = state?.event_flag_sources ?? {};
  const completionSources = state?.event_completion_sources ?? {};
  const flags = (definitions.flags ?? []).map((flag) => {
    const autoReady = flag.auto_ready_when_prerequisites_met === true && prerequisitesMet(flag, { state, inventory });
    const active = globalFlags[flag.id] === true || autoReady;
    const completed = Boolean(flag.completed_flag_id && globalFlags[flag.completed_flag_id] === true);
    const source = eventSources[flag.id] ?? (autoReady ? derivedAutoReadySource(flag, state) : null);
    const completionSource = flag.completed_flag_id ? completionSources[flag.completed_flag_id] ?? null : null;
    return {
      ...flag,
      active,
      completed,
      ready: active && !completed,
      source,
      completion_source: completionSource,
      character_id: source?.character_id ?? null,
      source_conversation_id: source?.conversation_id ?? null,
      achieved_at: source?.achieved_at ?? null
    };
  });
  return {
    flags,
    pending_events: flags.filter((flag) => flag.ready && !flag.hidden_from_event_status)
  };
}

export async function getEventFlagStatus({ root }) {
  const [definitions, state, inventory] = await Promise.all([
    loadEventFlags({ root }),
    readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} }),
    loadInventory({ root })
  ]);
  return decorateEventFlags(definitions, state, inventory);
}

// keepCurrentLocation: start the interaction in place instead of moving the runtime to the event's
// interaction location. The routing hub greeting renders on the routing meta-surface (built from
// routingHubContext, not current_location_id), so its opening event must keep the hub's own location
// and visible situation. Field/academy events default to false and move to the event location.
export async function startEventFlagInteraction({ root, flagId, screen = 'interaction', random = Math.random, keepCurrentLocation = false }) {
  if (!root) throw new Error('root is required');
  const nextScreen = screen === 'academy-conversation-session' ? 'academy-conversation-session' : 'interaction';
  const definitions = await loadEventFlags({ root });
  const [state, inventory, locations] = await Promise.all([
    readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} }),
    loadInventory({ root }),
    readJsonIfExists(root, 'game_data/locations.json', [])
  ]);
  const status = decorateEventFlags(definitions, state, inventory);
  const readyFlag = status.pending_events.find((entry) => entry.id === flagId);
  if (!readyFlag) throw new Error(`event flag is not ready: ${flagId}`);
  if (!readyFlag.interaction?.location_id) throw new Error(`event flag does not define an interaction: ${flagId}`);
  const characterId = readyFlag.character_id;
  if (!characterId) throw new Error(`event flag source character is missing: ${flagId}`);
  const location = (locations ?? []).find((entry) => entry.id === readyFlag.interaction.location_id) ?? null;
  const next = structuredClone(state);
  next.global_flags ??= {};
  next.event_flag_sources ??= {};
  if (next.global_flags[readyFlag.id] !== true) {
    next.global_flags[readyFlag.id] = true;
    next.event_flag_sources[readyFlag.id] = {
      character_id: characterId,
      conversation_id: readyFlag.source_conversation_id ?? null,
      achieved_at: readyFlag.achieved_at ?? null,
      auto_ready: true
    };
  }
  next.current_screen = nextScreen;
  if (!keepCurrentLocation) {
    next.current_location_id = readyFlag.interaction.location_id;
    next.current_location_visible_situation = selectRandomLocationSituation({ location, random }) ?? next.current_location_visible_situation ?? null;
  }
  next.current_interaction_character_id = characterId;
  next.last_conversation_id = null;
  if (readyFlag.complete_when_started === true && readyFlag.completed_flag_id) {
    next.global_flags[readyFlag.completed_flag_id] = true;
    next.event_completion_sources ??= {};
    next.event_completion_sources[readyFlag.completed_flag_id] = {
      event_flag_id: readyFlag.id,
      character_id: characterId,
      conversation_id: readyFlag.source_conversation_id ?? null,
      achieved_at: new Date().toISOString(),
      completed_when_started: true
    };
  }
  next.pending_interaction_context = {
    source_type: readyFlag.interaction.source_type,
    event_flag_id: readyFlag.id,
    event_label: readyFlag.label,
    source_conversation_id: readyFlag.source_conversation_id ?? null,
    opening_context: readyFlag.interaction.opening_context
  };
  await writeJson(root, 'game_data/runtime_state.json', next);
  return {
    event_flag: readyFlag,
    character_id: characterId,
    location_id: readyFlag.interaction.location_id,
    state: next
  };
}

export async function setEventFlagActive({ root, flagId, active }) {
  const definitions = await loadEventFlags({ root });
  const knownIds = new Set(definitions.flags.map((flag) => flag.id));
  if (!knownIds.has(flagId)) throw new Error(`unknown event flag: ${flagId}`);
  const state = await readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} });
  state.global_flags ??= {};
  state.event_flag_sources ??= {};
  state.global_flags[flagId] = active === true;
  if (active === true && !state.event_flag_sources[flagId]) {
    state.event_flag_sources[flagId] = { character_id: null, conversation_id: null, achieved_at: null };
  }
  if (active !== true) delete state.event_flag_sources[flagId];
  await writeJson(root, 'game_data/runtime_state.json', state);
  return getEventFlagStatus({ root });
}

export async function setEventCompletionFlagActive({ root, flagId, active }) {
  const definitions = await loadEventFlags({ root });
  const flag = definitions.flags.find((entry) => entry.id === flagId);
  if (!flag) throw new Error(`unknown event flag: ${flagId}`);
  if (!flag.completed_flag_id) throw new Error(`event flag does not define a completion flag: ${flagId}`);
  const state = await readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} });
  state.global_flags ??= {};
  state.event_completion_sources ??= {};
  state.global_flags[flag.completed_flag_id] = active === true;
  if (active === true && !state.event_completion_sources[flag.completed_flag_id]) {
    state.event_completion_sources[flag.completed_flag_id] = {
      event_flag_id: flag.id,
      character_id: null,
      conversation_id: null,
      achieved_at: null
    };
  }
  if (active !== true) delete state.event_completion_sources[flag.completed_flag_id];
  await writeJson(root, 'game_data/runtime_state.json', state);
  return getEventFlagStatus({ root });
}

export async function setAllEventFlagsActive({ root, active = true }) {
  const definitions = await loadEventFlags({ root });
  const state = await readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} });
  state.global_flags ??= {};
  state.event_flag_sources ??= {};
  state.event_completion_sources ??= {};
  for (const flag of definitions.flags) {
    state.global_flags[flag.id] = active === true;
    if (active === true && !state.event_flag_sources[flag.id]) {
      state.event_flag_sources[flag.id] = { character_id: null, conversation_id: null, achieved_at: null };
    }
    if (active !== true) {
      delete state.event_flag_sources[flag.id];
      if (flag.completed_flag_id) {
        state.global_flags[flag.completed_flag_id] = false;
        delete state.event_completion_sources[flag.completed_flag_id];
      }
    }
  }
  await writeJson(root, 'game_data/runtime_state.json', state);
  return getEventFlagStatus({ root });
}
