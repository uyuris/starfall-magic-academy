import { createStorageApi } from './storage.mjs';

export const STAGE_FLAG_DEFINITIONS_PATH = 'game_data/stage_flags.json';

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

export async function loadStageFlags({ root }) {
  const file = await readJsonIfExists(root, STAGE_FLAG_DEFINITIONS_PATH);
  return {
    flags: (file?.flags ?? []).map((flag) => ({
      id: String(flag.id ?? ''),
      label: flag.label ?? flag.id ?? '',
      location_id: flag.location_id ?? null,
      condition: flag.condition ?? '',
      question: flag.question ?? flag.condition ?? '',
      motif_key: flag.motif_key ?? null,
      motif_family: flag.motif_family ?? null,
      homage_note: flag.homage_note ?? '',
      reward_on_inventory_open: flag.reward_on_inventory_open ?? null
    })).filter((flag) => flag.id && flag.location_id && flag.condition)
  };
}

export function selectStageFlagJudgmentTargets({ flags, state, locationId }) {
  const globalFlags = state?.global_flags ?? {};
  const disabledFlows = state?.disabled_stage_flag_judgment_flows ?? {};
  return (flags ?? []).filter((flag) => flag.location_id === locationId && globalFlags[flag.id] !== true && disabledFlows[flag.id] !== true);
}

export function normalizeStageFlagJudgment(rawJudgment, candidateFlags = []) {
  if (typeof rawJudgment === 'string' || typeof rawJudgment === 'boolean') {
    const text = String(rawJudgment).trim().toLowerCase();
    const achieved = text === 'true';
    const flag = candidateFlags[0];
    return {
      flag_results: flag ? [{ flag_id: flag.id, achieved, raw_answer: String(rawJudgment).trim() }] : []
    };
  }
  return {
    flag_results: (rawJudgment?.flag_results ?? []).map((result) => ({
      flag_id: String(result.flag_id ?? ''),
      achieved: result.achieved === true,
      reason: result.reason ?? '',
      ...(result.raw_answer != null ? { raw_answer: String(result.raw_answer) } : {})
    })).filter((result) => result.flag_id)
  };
}

export async function defaultStageFlagJudgmentProvider() {
  return { flag_results: [] };
}

export async function judgeStageFlagsAfterConversation({
  root,
  state,
  conversation,
  workRecordId,
  stageFlagJudgmentProvider = defaultStageFlagJudgmentProvider,
  now = new Date().toISOString()
}) {
  const definitions = await loadStageFlags({ root });
  const candidateFlags = selectStageFlagJudgmentTargets({
    flags: definitions.flags,
    state,
    locationId: conversation.location_id
  });
  const baseLog = {
    conversation_id: conversation.id,
    location_id: conversation.location_id,
    judged_at: now,
    candidate_flags: candidateFlags,
    raw_result: { flag_results: [] },
    accepted: [],
    rejected: []
  };
  if (candidateFlags.length === 0) {
    await writeJson(root, `game_data/logs/stage_flag_judgments/${conversation.id}.json`, baseLog);
    return baseLog;
  }
  const rawResult = normalizeStageFlagJudgment(await stageFlagJudgmentProvider({ conversation, state, candidateFlags, workRecordId, now }), candidateFlags);
  const candidateIds = new Set(candidateFlags.map((flag) => flag.id));
  const candidateById = new Map(candidateFlags.map((flag) => [flag.id, flag]));
  const accepted = [];
  const rejected = [];
  for (const result of rawResult.flag_results) {
    if (!candidateIds.has(result.flag_id)) {
      rejected.push({ ...result, reason: result.reason || 'not a candidate for this conversation location or already active' });
      continue;
    }
    const reward = normalizeStageRewardDefinition(candidateById.get(result.flag_id)?.reward_on_inventory_open);
    if (result.achieved) accepted.push(reward ? { ...result, reward } : result);
    else rejected.push(result);
  }
  const log = { ...baseLog, raw_result: rawResult, accepted, rejected };
  await writeJson(root, `game_data/logs/stage_flag_judgments/${conversation.id}.json`, log);
  return log;
}

function normalizeStageRewardDefinition(reward) {
  if (!reward?.item_id) return null;
  const quantity = Math.max(1, Math.floor(Number(reward.quantity ?? 1)));
  return {
    item_id: reward.item_id,
    quantity,
    ...(reward.name ? { name: reward.name } : {}),
    ...(reward.description ? { description: reward.description } : {}),
    ...(reward.sell_price != null ? { sell_price: Math.max(0, Math.floor(Number(reward.sell_price ?? 0))) } : {})
  };
}

export function collectAcceptedStageFlagRewards(judgment) {
  return (judgment?.accepted ?? [])
    .map((accepted) => ({
      flag_id: accepted.flag_id,
      reward: normalizeStageRewardDefinition(accepted.reward)
    }))
    .filter((entry) => entry.reward)
    .map((entry) => ({ flag_id: entry.flag_id, ...entry.reward }));
}

export function applyAcceptedStageFlags(state, judgment) {
  const next = structuredClone(state);
  next.global_flags ??= {};
  for (const accepted of judgment?.accepted ?? []) next.global_flags[accepted.flag_id] = true;
  return next;
}

export async function getStageFlagStatus({ root }) {
  const [definitions, state] = await Promise.all([
    loadStageFlags({ root }),
    readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} })
  ]);
  const globalFlags = state.global_flags ?? {};
  const disabledFlows = state.disabled_stage_flag_judgment_flows ?? {};
  return {
    flags: definitions.flags.map((flag) => ({
      ...flag,
      active: globalFlags[flag.id] === true,
      judgment_flow_enabled: disabledFlows[flag.id] !== true
    }))
  };
}

export async function setStageFlagActive({ root, flagId, active }) {
  const definitions = await loadStageFlags({ root });
  const knownIds = new Set(definitions.flags.map((flag) => flag.id));
  if (!knownIds.has(flagId)) throw new Error(`unknown stage flag: ${flagId}`);
  const state = await readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} });
  state.global_flags ??= {};
  state.global_flags[flagId] = active === true;
  await writeJson(root, 'game_data/runtime_state.json', state);
  return getStageFlagStatus({ root });
}

export async function setStageFlagJudgmentFlowEnabled({ root, flagId, enabled }) {
  const definitions = await loadStageFlags({ root });
  const knownIds = new Set(definitions.flags.map((flag) => flag.id));
  if (!knownIds.has(flagId)) throw new Error(`unknown stage flag: ${flagId}`);
  const state = await readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} });
  state.disabled_stage_flag_judgment_flows ??= {};
  if (enabled === true) delete state.disabled_stage_flag_judgment_flows[flagId];
  else state.disabled_stage_flag_judgment_flows[flagId] = true;
  await writeJson(root, 'game_data/runtime_state.json', state);
  return getStageFlagStatus({ root });
}

export async function setAllStageFlagsActive({ root, active = true }) {
  const definitions = await loadStageFlags({ root });
  const state = await readJsonIfExists(root, 'game_data/runtime_state.json', { global_flags: {} });
  state.global_flags ??= {};
  for (const flag of definitions.flags) state.global_flags[flag.id] = active === true;
  await writeJson(root, 'game_data/runtime_state.json', state);
  return getStageFlagStatus({ root });
}
