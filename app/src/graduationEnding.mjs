import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createStorageApi } from './storage.mjs';
import { startEventFlagInteraction } from './eventFlags.mjs';
import { ensureSelectableCharacterStorage } from './characterCatalog.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from './routingPersona.mjs';

export const GRADUATION_ENDING_FLAG_ID = 'event.graduation_ending.ready';
export const GRADUATION_ENDING_COMPLETED_FLAG_ID = 'event.graduation_ending.completed';
export const GRADUATION_ENDING_WEEK = 50;
// The runtime_state key that holds the routing graduation guide phase. Its presence is the single source of
// truth for "the routing graduation guide is active": any routing hub turn while it is present runs the guide
// selection (top-N partner) instead of routing destination selection, and the manual end stays in the
// conversation. It is set when a routing dispatch at week 50 begins the guide and cleared when the player's
// choice starts the character graduation event. Loop graduation never sets it (loop goes straight to the
// top-1 character event), so the loop path is unaffected.
export const ROUTING_GRADUATION_GUIDE_STATE_KEY = 'routing_graduation_guide';
// How many memory-count-ranked characters the routing graduation guide presents. Fewer are presented when the
// roster is smaller; zero candidates falls back to the same missing-character-profile behavior loop uses.
export const GRADUATION_GUIDE_CANDIDATE_LIMIT = 3;
const CHARACTER_ID_PATTERN = /^character_\d{3}$/;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;
const ROUTING_WEEK_PROGRESSION_PHASE_APPLIED = 'applied';

function storageApiFor(rootOrStorage) {
  if (rootOrStorage && typeof rootOrStorage.readJson === 'function' && typeof rootOrStorage.writeJson === 'function') {
    return rootOrStorage;
  }
  return createStorageApi({ root: rootOrStorage });
}

async function readRuntimeState(rootOrStorage) {
  return await storageApiFor(rootOrStorage).readJson('game_data/runtime_state.json');
}

async function writeRuntimeState(rootOrStorage, state) {
  await storageApiFor(rootOrStorage).writeJson('game_data/runtime_state.json', state);
}

function normalizeWeekCount(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeGraduationState(state) {
  return {
    ...state,
    elapsed_weeks: normalizeWeekCount(state?.elapsed_weeks),
    ending_started: state?.ending_started === true,
    ending_completed: state?.ending_completed === true,
    ending_character_id: state?.ending_character_id ?? null,
    global_flags: { ...(state?.global_flags ?? {}) },
    event_flag_sources: { ...(state?.event_flag_sources ?? {}) },
    event_completion_sources: { ...(state?.event_completion_sources ?? {}) }
  };
}

function routingWeekProgressionError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ROUTING_WEEK_PROGRESSION';
  error.errorCode = 'invalid_routing_week_progression';
  error.statusCode = 500;
  return error;
}

function normalizeProgressionIntegerField(record, fieldName) {
  const value = Number(record?.[fieldName]);
  if (!Number.isInteger(value) || value < 0) {
    throw routingWeekProgressionError(`routing week progression ${fieldName} must be a non-negative integer: ${record?.[fieldName]}`);
  }
  return value;
}

function normalizeRoutingWeekProgressionRecords(state) {
  if (!Object.prototype.hasOwnProperty.call(state ?? {}, 'routing_week_progressions')) return [];
  if (!Array.isArray(state.routing_week_progressions)) {
    throw routingWeekProgressionError('runtime_state.routing_week_progressions must be an array when present');
  }
  const seenKeys = new Set();
  return state.routing_week_progressions.map((record) => {
    const idempotencyKey = String(record?.idempotency_key ?? '').trim();
    const conversationId = String(record?.conversation_id ?? '').trim();
    const destinationId = String(record?.destination_id ?? '').trim();
    const route = String(record?.route ?? '').trim();
    const phase = String(record?.phase ?? '').trim();
    if (!idempotencyKey) throw routingWeekProgressionError('routing week progression idempotency_key is required');
    if (seenKeys.has(idempotencyKey)) throw routingWeekProgressionError(`duplicate routing week progression idempotency_key: ${idempotencyKey}`);
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw routingWeekProgressionError(`routing week progression conversation_id is invalid: ${conversationId}`);
    if (!destinationId) throw routingWeekProgressionError('routing week progression destination_id is required');
    if (idempotencyKey !== buildRoutingWeekProgressionKey({ conversationId, destinationId })) {
      throw routingWeekProgressionError(`routing week progression idempotency_key does not match its decision: ${idempotencyKey}`);
    }
    if (!route) throw routingWeekProgressionError('routing week progression route is required');
    if (phase !== ROUTING_WEEK_PROGRESSION_PHASE_APPLIED) {
      throw routingWeekProgressionError(`routing week progression phase is invalid: ${phase || '(empty)'}`);
    }
    seenKeys.add(idempotencyKey);
    const common = {
      idempotency_key: idempotencyKey,
      conversation_id: conversationId,
      destination_id: destinationId,
      phase,
      route
    };
    const appliedAt = String(record?.applied_at ?? '').trim();
    const startedAt = String(record?.started_at ?? '').trim();
    const elapsedWeeks = normalizeProgressionIntegerField(record, 'elapsed_weeks');
    if (!appliedAt) throw routingWeekProgressionError('routing week progression applied_at is required');
    return {
      ...common,
      ...(startedAt ? { started_at: startedAt } : {}),
      applied_at: appliedAt,
      elapsed_weeks: elapsedWeeks,
      route
    };
  });
}

export function latestAppliedRoutingWeekProgression(state) {
  const records = normalizeRoutingWeekProgressionRecords(state);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].phase === ROUTING_WEEK_PROGRESSION_PHASE_APPLIED) return records[index];
  }
  return null;
}

export function buildRoutingWeekProgressionKey({ conversationId, destinationId }) {
  const normalizedConversationId = String(conversationId ?? '').trim();
  const normalizedDestinationId = String(destinationId ?? '').trim();
  if (!CONVERSATION_ID_PATTERN.test(normalizedConversationId)) {
    throw routingWeekProgressionError(`routing week progression conversation_id is invalid: ${conversationId}`);
  }
  if (!normalizedDestinationId) throw routingWeekProgressionError('routing week progression destination_id is required');
  return `${normalizedConversationId}:${normalizedDestinationId}`;
}

function normalizeRoutingWeekProgressionInput(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw routingWeekProgressionError('routingWeekProgression must be an object');
  }
  const conversationId = String(value.conversation_id ?? '').trim();
  const destinationId = String(value.destination_id ?? '').trim();
  const idempotencyKey = String(value.idempotency_key ?? '').trim();
  const expectedKey = buildRoutingWeekProgressionKey({ conversationId, destinationId });
  if (!idempotencyKey) throw routingWeekProgressionError('routingWeekProgression.idempotency_key is required');
  if (idempotencyKey !== expectedKey) {
    throw routingWeekProgressionError(`routingWeekProgression.idempotency_key does not match its decision: ${idempotencyKey}`);
  }
  return {
    idempotency_key: idempotencyKey,
    conversation_id: conversationId,
    destination_id: destinationId
  };
}

export function findRoutingWeekProgression(state, idempotencyKey) {
  const normalizedKey = String(idempotencyKey ?? '').trim();
  if (!normalizedKey) throw routingWeekProgressionError('routing week progression idempotency key is required');
  return normalizeRoutingWeekProgressionRecords(state).find((record) => record.idempotency_key === normalizedKey) ?? null;
}

export function findRoutingWeekProgressionByConversation(state, conversationId) {
  const normalizedConversationId = String(conversationId ?? '').trim();
  if (!CONVERSATION_ID_PATTERN.test(normalizedConversationId)) {
    throw routingWeekProgressionError(`routing week progression conversation_id is invalid: ${conversationId}`);
  }
  const matches = normalizeRoutingWeekProgressionRecords(state)
    .filter((record) => record.conversation_id === normalizedConversationId);
  if (matches.length > 1) {
    throw routingWeekProgressionError(`multiple routing week progressions for conversation_id: ${normalizedConversationId}`);
  }
  return matches[0] ?? null;
}

export function isRoutingWeekProgressionApplied(state, idempotencyKey) {
  return findRoutingWeekProgression(state, idempotencyKey)?.phase === ROUTING_WEEK_PROGRESSION_PHASE_APPLIED;
}

export function isRoutingWeekProgressionRecordApplied(record) {
  return record?.phase === ROUTING_WEEK_PROGRESSION_PHASE_APPLIED;
}

function completeRoutingWeekProgression(state, routingWeekProgression, { route, now }) {
  if (!routingWeekProgression) return state;
  const appliedAt = String(now ?? '').trim();
  if (!appliedAt) throw routingWeekProgressionError('routing week progression applied_at is required');
  const existingRecords = normalizeRoutingWeekProgressionRecords(state);
  // A matching key here means it was already applied during this same advance; startNextAcademyWeek early-returns
  // on an applied record before reaching this point, so a duplicate is a re-entry bug rather than a normal state.
  if (existingRecords.some((record) => record.idempotency_key === routingWeekProgression.idempotency_key)) {
    throw routingWeekProgressionError(`routing week progression was already applied during the same advance: ${routingWeekProgression.idempotency_key}`);
  }
  const appliedRecord = {
    ...routingWeekProgression,
    phase: ROUTING_WEEK_PROGRESSION_PHASE_APPLIED,
    started_at: appliedAt,
    applied_at: appliedAt,
    elapsed_weeks: normalizeWeekCount(state.elapsed_weeks),
    route
  };
  return {
    ...state,
    routing_week_progressions: [
      ...existingRecords,
      appliedRecord
    ]
  };
}

async function characterIdsWithProfiles(root) {
  const storage = createStorageApi({ root });
  const charactersDir = storage.paths.characterContentRoot;
  const entries = await fs.readdir(charactersDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const characterIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^character_\d{3}$/.test(entry.name)) continue;
    characterIds.push(entry.name);
  }
  return characterIds.sort();
}

async function summarizeCharacterMemory(root, characterId) {
  const storage = createStorageApi({ root });
  const memoryDir = await storage.resolveReadPath(`game_data/characters/${characterId}/memory`);
  try {
    const names = (await fs.readdir(memoryDir)).filter((name) => name.endsWith('.json')).sort();
    let latestMtimeMs = 0;
    for (const name of names) {
      const stat = await fs.stat(path.join(memoryDir, name));
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    }
    return { characterId, count: names.length, latestMtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return { characterId, count: 0, latestMtimeMs: 0 };
    throw error;
  }
}

async function sortedCharacterMemorySummaries(root) {
  const characterIds = await characterIdsWithProfiles(root);
  if (characterIds.length === 0) return [];
  const summaries = await Promise.all(characterIds.map((characterId) => summarizeCharacterMemory(root, characterId)));
  summaries.sort((left, right) => (
    right.count - left.count
    || right.latestMtimeMs - left.latestMtimeMs
    || left.characterId.localeCompare(right.characterId)
  ));
  return summaries;
}

export async function selectGraduationEndingCharacterId(root) {
  const summaries = await sortedCharacterMemorySummaries(root);
  return summaries[0]?.characterId ?? null;
}

// The routing graduation guide generalizes the loop's top-1 selection to the top-N characters, keeping the
// same ordering (memory count desc, latest memory file mtime desc, character id asc). Fewer than `limit` are
// returned when the roster is smaller; an empty roster returns [].
export async function selectGraduationEndingCharacterIds(root, { limit } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('selectGraduationEndingCharacterIds requires a positive integer limit');
  }
  const summaries = await sortedCharacterMemorySummaries(root);
  return summaries.slice(0, limit).map((summary) => summary.characterId);
}

// Reads the routing graduation guide phase state. Absent = not in the guide (null). Present-but-malformed
// fail-fasts (no silent fallback / default), so a corrupt guide state is a loud error rather than a silent
// skip of the graduation flow.
export function readRoutingGraduationGuide(state) {
  if (!Object.prototype.hasOwnProperty.call(state ?? {}, ROUTING_GRADUATION_GUIDE_STATE_KEY)) return null;
  const value = state[ROUTING_GRADUATION_GUIDE_STATE_KEY];
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routing_graduation_guide must be an object or null');
  }
  const ids = value.candidate_character_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('routing_graduation_guide.candidate_character_ids must be a non-empty array');
  }
  const candidateCharacterIds = ids.map((id) => {
    const normalized = String(id ?? '').trim();
    if (!CHARACTER_ID_PATTERN.test(normalized)) {
      throw new Error(`routing_graduation_guide.candidate_character_ids has an invalid id: ${id}`);
    }
    return normalized;
  });
  if (new Set(candidateCharacterIds).size !== candidateCharacterIds.length) {
    throw new Error('routing_graduation_guide.candidate_character_ids must not contain duplicates');
  }
  const startedAt = String(value.started_at ?? '').trim();
  if (!startedAt) throw new Error('routing_graduation_guide.started_at is required');
  return { candidate_character_ids: candidateCharacterIds, started_at: startedAt };
}

// Starts the character graduation event for the guide-selected partner (routing phase 2). Reuses the exact
// event-flag interaction the loop graduation uses, advances the week to the graduation week (the guide ran at
// GRADUATION_ENDING_WEEK - 1, so the ending conversation is the graduation-week content), and clears the guide
// phase state — all in the same runtime-state write as the ending flags. The partner is either one of the presented
// memory-ranked candidates (a selectable roster `character_###`) or the guide persona itself (案内人自身・the
// fixed non-selectable actor id `lina`), which is a permanent option outside the presented candidate list.
// Fail-fasts when the guide is not active, or when a `character_###` selection is not one of the presented
// candidates, so a stray selection cannot start an off-list ending. The guide persona takes the non-selectable
// dialogue actor path (no selectable-storage materialization) exactly as its routing hub conversation does.
export async function startGraduationEndingConversationForCharacter({
  root,
  authoringRoot = root,
  characterId,
  screen,
  now = new Date().toISOString()
}) {
  if (typeof screen !== 'string' || !screen) throw new Error('screen is required');
  const normalizedCharacterId = String(characterId ?? '').trim();
  const isGuidePersona = normalizedCharacterId === ROUTING_PERSONA_CHARACTER_ID;
  if (!isGuidePersona && !CHARACTER_ID_PATTERN.test(normalizedCharacterId)) {
    throw new Error(`graduation guide selection must be a character id or the guide persona: ${characterId}`);
  }
  let state = normalizeGraduationState(await readRuntimeState(root));
  const guide = readRoutingGraduationGuide(state);
  if (!guide) throw new Error('routing graduation guide is not active');
  if (!isGuidePersona && !guide.candidate_character_ids.includes(normalizedCharacterId)) {
    throw new Error(`graduation guide selection is not a presented candidate: ${normalizedCharacterId}`);
  }
  if (state.ending_completed) throw new Error('graduation ending is already completed');
  // The guide runs at GRADUATION_ENDING_WEEK - 1 (displayed graduation week) with elapsed_weeks held there; the
  // ending conversation is the graduation-week content, so starting it advances elapsed_weeks to the graduation
  // week in this same write. Fail-fast on any other elapsed_weeks so a stray start cannot silently mis-count.
  const targetElapsedWeeks = state.elapsed_weeks + 1;
  if (targetElapsedWeeks !== GRADUATION_ENDING_WEEK) {
    throw new Error(`graduation ending must advance elapsed_weeks to ${GRADUATION_ENDING_WEEK}: ${state.elapsed_weeks}`);
  }

  // The guide persona is a non-selectable actor (its dialogue slot `game_data/characters/lina` already
  // exists); only a selectable roster candidate needs its per-slot mutable storage materialized.
  if (!isGuidePersona) {
    await ensureSelectableCharacterStorage({ root, authoringRoot, characterId: normalizedCharacterId });
  }

  state.elapsed_weeks = targetElapsedWeeks;
  state.ending_started = true;
  state.ending_completed = false;
  state.ending_character_id = normalizedCharacterId;
  state.global_flags[GRADUATION_ENDING_FLAG_ID] = true;
  state.global_flags[GRADUATION_ENDING_COMPLETED_FLAG_ID] = false;
  state.event_flag_sources[GRADUATION_ENDING_FLAG_ID] = {
    character_id: normalizedCharacterId,
    source_type: 'graduation_ending',
    achieved_at: now
  };
  delete state.event_completion_sources[GRADUATION_ENDING_COMPLETED_FLAG_ID];
  delete state[ROUTING_GRADUATION_GUIDE_STATE_KEY];
  await writeRuntimeState(root, state);

  const started = await startEventFlagInteraction({
    root,
    flagId: GRADUATION_ENDING_FLAG_ID,
    screen
  });
  const nextState = normalizeGraduationState(started.state);
  nextState.elapsed_weeks = state.elapsed_weeks;
  nextState.ending_started = true;
  nextState.ending_completed = false;
  nextState.ending_character_id = normalizedCharacterId;
  nextState.global_flags[GRADUATION_ENDING_COMPLETED_FLAG_ID] = false;
  delete nextState[ROUTING_GRADUATION_GUIDE_STATE_KEY];
  await writeRuntimeState(root, nextState);
  return {
    route: 'graduation-ending',
    character_id: normalizedCharacterId,
    ...started,
    state: nextState
  };
}

function clearGraduationFlags(state) {
  state.global_flags[GRADUATION_ENDING_FLAG_ID] = false;
  state.global_flags[GRADUATION_ENDING_COMPLETED_FLAG_ID] = false;
  delete state.event_flag_sources[GRADUATION_ENDING_FLAG_ID];
  delete state.event_completion_sources[GRADUATION_ENDING_COMPLETED_FLAG_ID];
}

export async function setElapsedWeeksDebug({ root, elapsedWeeks }) {
  const state = normalizeGraduationState(await readRuntimeState(root));
  state.elapsed_weeks = normalizeWeekCount(elapsedWeeks);
  state.ending_started = false;
  state.ending_completed = false;
  state.ending_character_id = null;
  clearGraduationFlags(state);
  await writeRuntimeState(root, state);
  return { state };
}

export async function startNextAcademyWeek({
  root,
  authoringRoot = root,
  now = new Date().toISOString(),
  nextScreen = 'academy-training',
  graduationEndingScreen = null,
  prepareWeekState = null,
  routingWeekProgression = null
}) {
  if (typeof nextScreen !== 'string' || !nextScreen) throw new Error('nextScreen is required');
  if (prepareWeekState != null && typeof prepareWeekState !== 'function') throw new Error('prepareWeekState must be a function');
  const normalizedRoutingWeekProgression = normalizeRoutingWeekProgressionInput(routingWeekProgression);
  const prepareStateForWeekCommit = async (nextState, expectedElapsedWeeks) => {
    if (!prepareWeekState) return nextState;
    const preparedState = normalizeGraduationState(await prepareWeekState(nextState));
    if (preparedState.elapsed_weeks !== expectedElapsedWeeks) {
      throw new Error(`prepareWeekState changed elapsed_weeks: ${expectedElapsedWeeks} -> ${preparedState.elapsed_weeks}`);
    }
    return preparedState;
  };
  let state = normalizeGraduationState(await readRuntimeState(root));
  const existingRoutingWeekProgression = normalizedRoutingWeekProgression
    ? findRoutingWeekProgression(state, normalizedRoutingWeekProgression.idempotency_key)
    : null;
  if (existingRoutingWeekProgression?.phase === ROUTING_WEEK_PROGRESSION_PHASE_APPLIED) {
    return {
      route: existingRoutingWeekProgression.route,
      state,
      routing_week_progression: {
        ...existingRoutingWeekProgression,
        status: 'already_applied'
      }
    };
  }
  const previousElapsedWeeks = state.elapsed_weeks;
  state.elapsed_weeks += 1;
  const targetElapsedWeeks = state.elapsed_weeks;
  // Routing never advances the week into graduation: the routing graduation guide is created at hub start (the
  // displayed graduation week runs entirely as the guide) and the ending conversation is what advances the week.
  // A routing week progression that would reach the graduation week is a wiring bug (a dispatch reached while the
  // guide should be active) — fail-fast before any write instead of silently running the loop graduation path.
  if (normalizedRoutingWeekProgression && targetElapsedWeeks >= GRADUATION_ENDING_WEEK) {
    throw routingWeekProgressionError(
      `routing week progression must not advance into graduation: ${previousElapsedWeeks} -> ${targetElapsedWeeks}`
    );
  }

  if (state.elapsed_weeks < GRADUATION_ENDING_WEEK || state.ending_completed) {
    state.current_screen = nextScreen;
    state = await prepareStateForWeekCommit(state, targetElapsedWeeks);
    state = completeRoutingWeekProgression(state, normalizedRoutingWeekProgression, { route: nextScreen, now });
    await writeRuntimeState(root, state);
    return {
      route: nextScreen,
      state,
      ...(normalizedRoutingWeekProgression ? {
        routing_week_progression: {
          status: 'applied',
          ...state.routing_week_progressions.at(-1)
        }
      } : {})
    };
  }

  state = await prepareStateForWeekCommit(state, targetElapsedWeeks);

  // Only loop graduation reaches this branch (routing is blocked above): it lands directly on the top-1
  // memory-ranked character's graduation event. There is no routing week progression here.
  const characterId = state.ending_character_id ?? await selectGraduationEndingCharacterId(root);
  if (!characterId) {
    state.current_screen = nextScreen;
    await writeRuntimeState(root, state);
    return {
      route: nextScreen,
      state,
      fallback_reason: 'missing_character_profile'
    };
  }

  // The loop graduation event lands on the conversation screen the caller resolved (routing is the official
  // mode, so the resolver is fixed to the daytime screen); startEventFlagInteraction maps that to current_screen
  // below, so the persisted screen stays truthful to where the frontend lands. Fail-fast before any graduation
  // write if the loop caller omitted it (a half-applied graduation start with an unresolved landing screen is not
  // left behind).
  if (typeof graduationEndingScreen !== 'string' || !graduationEndingScreen) {
    throw new Error('graduationEndingScreen is required for the loop graduation ending');
  }

  await ensureSelectableCharacterStorage({
    root,
    authoringRoot,
    characterId
  });

  state.ending_started = true;
  state.ending_completed = false;
  state.ending_character_id = characterId;
  state.global_flags[GRADUATION_ENDING_FLAG_ID] = true;
  state.global_flags[GRADUATION_ENDING_COMPLETED_FLAG_ID] = false;
  state.event_flag_sources[GRADUATION_ENDING_FLAG_ID] = {
    character_id: characterId,
    source_type: 'graduation_ending',
    achieved_at: now
  };
  delete state.event_completion_sources[GRADUATION_ENDING_COMPLETED_FLAG_ID];
  await writeRuntimeState(root, state);

  const started = await startEventFlagInteraction({
    root,
    flagId: GRADUATION_ENDING_FLAG_ID,
    screen: graduationEndingScreen
  });
  const nextState = normalizeGraduationState(started.state);
  nextState.elapsed_weeks = state.elapsed_weeks;
  nextState.ending_started = true;
  nextState.ending_completed = false;
  nextState.ending_character_id = characterId;
  nextState.global_flags[GRADUATION_ENDING_COMPLETED_FLAG_ID] = false;
  await writeRuntimeState(root, nextState);
  return {
    route: 'graduation-ending',
    character_id: characterId,
    ...started,
    state: nextState
  };
}

export function isGraduationEndingContext(state, conversation) {
  const pendingFlagId = state?.pending_interaction_context?.event_flag_id ?? null;
  const conversationFlagId = conversation?.event_flag_id ?? null;
  return pendingFlagId === GRADUATION_ENDING_FLAG_ID || conversationFlagId === GRADUATION_ENDING_FLAG_ID;
}

// The single predicate for an in-flight graduation phase 2 (ending) conversation: the ending has begun, is
// not yet completed, and the graduation ending event context is still pending on the interaction. It is the
// one definition shared by slot load (entry-state preservation), the load/slots re-entry contract, and the
// routing hub-start guard, so those consumers never drift into separate ad-hoc checks. A completed ending
// clears pending_interaction_context (and sets ending_completed), so this is false once graduation finishes.
export function isInFlightGraduationPhase2(state) {
  return state?.ending_started === true
    && state?.ending_completed !== true
    && (state?.pending_interaction_context?.event_flag_id ?? null) === GRADUATION_ENDING_FLAG_ID;
}

export function markGraduationEndingComplete(state) {
  const nextState = normalizeGraduationState(state);
  nextState.ending_started = true;
  nextState.ending_completed = true;
  nextState.current_screen = 'title';
  nextState.global_flags[GRADUATION_ENDING_COMPLETED_FLAG_ID] = true;
  return nextState;
}
