import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createStorageApi } from './storage.mjs';
import { createRuntimePaths } from './runtimePaths.mjs';
import { ensureCharacterMutableSurface, resetSlotGameDataRoot, writeRuntimePathsManifest } from './runtimeSlotBootstrap.mjs';
import { ensureSelectableCharacterStorage, isSelectableCharacterId } from './characterCatalog.mjs';
import { normalizeParameters } from './parameters.mjs';
import { validatePlayMode, validateRoutingPersonaVariant } from './playMode.mjs';
import { addRoutingOpeningEvent } from './routingOpeningEvent.mjs';

export const playAreaRelativeRoot = 'game_data/play';
export const playSlotsRelativeRoot = `${playAreaRelativeRoot}/slots`;
export const slotPlayModeMigrationCommand = 'node scripts/stamp-slot-play-mode.mjs';

const sharedDefinitionEntries = [
  'event_flags.json',
  'locations.json',
  'shop_catalog.json',
  'stage_flags.json',
  'world'
];

const SLOT_ID_PATTERN = /^slot_[A-Za-z0-9_-]+$/;
const NUMBERED_CHARACTER_ID_PATTERN = /^character_\d{3}$/;
const FIRST_PLAY_OPENING_MENTOR_CHARACTER_ID = 'character_001';

function invalidSlotIdError(slotId) {
  const error = new Error(`invalid slotId: ${slotId}`);
  error.code = 'INVALID_SLOT_ID';
  error.errorCode = 'invalid_slot_id';
  error.statusCode = 400;
  return error;
}

function slotPlayModeMigrationError(slotId, reason, errorCode) {
  const error = new Error(`slot ${slotId} ${reason}; run ${slotPlayModeMigrationCommand} <slot_id> <loop|routing>`);
  error.code = errorCode;
  error.errorCode = errorCode;
  error.statusCode = 400;
  return error;
}

export function assertValidSlotId(slotId) {
  const normalized = String(slotId ?? '').trim();
  if (!normalized) throw invalidSlotIdError(slotId);
  if (!SLOT_ID_PATTERN.test(normalized)) throw invalidSlotIdError(slotId);
  return normalized;
}

export function assertValidSlotPlayMode(value, slotId) {
  if (value == null || value === '') {
    throw slotPlayModeMigrationError(slotId, 'is missing play_mode', 'slot_play_mode_missing');
  }
  try {
    return validatePlayMode(value);
  } catch {
    throw slotPlayModeMigrationError(slotId, `has invalid play_mode: ${JSON.stringify(value)}`, 'slot_play_mode_invalid');
  }
}

export function assertValidSlotRoutingPersonaVariant(value, slotId) {
  if (value == null || value === '') {
    throw slotPlayModeMigrationError(slotId, 'is missing routing_persona_variant for routing play_mode', 'slot_routing_persona_variant_missing');
  }
  try {
    return validateRoutingPersonaVariant(value);
  } catch {
    throw slotPlayModeMigrationError(slotId, `has invalid routing_persona_variant: ${JSON.stringify(value)}`, 'slot_routing_persona_variant_invalid');
  }
}

export function assertValidSlotActivePlayMode({ playMode, routingPersonaVariant }, slotId) {
  const mode = assertValidSlotPlayMode(playMode, slotId);
  if (mode !== 'routing') return { mode };
  return {
    mode,
    routing_persona_variant: assertValidSlotRoutingPersonaVariant(routingPersonaVariant, slotId)
  };
}

// Read-path normalization for a save slot's persisted play mode. Validates play_mode and the routing
// variant SHAPE (a non-empty string) but NOT its closed-set membership: an existing save slot whose
// routing_persona_variant predates a closed-set replacement must stay listable, loadable, and
// dispatchable rather than 400-ing server boot / GET / / settings / the slot list. Closed-set membership
// is enforced on write (createSaveSlot / new-game / re-selection) and at the point of use (routing persona
// build), so a stale slot variant fails fast only when a routing operation actually needs it, and is
// recoverable by re-selection. The stale variant is carried through raw — never mapped, defaulted, or
// silently rewritten on read.
export function normalizeSlotActivePlayModeForRead({ playMode, routingPersonaVariant }, slotId) {
  const mode = assertValidSlotPlayMode(playMode, slotId);
  if (mode !== 'routing') return { mode };
  if (routingPersonaVariant == null || routingPersonaVariant === '') {
    throw slotPlayModeMigrationError(slotId, 'is missing routing_persona_variant for routing play_mode', 'slot_routing_persona_variant_missing');
  }
  return { mode, routing_persona_variant: routingPersonaVariant };
}

function freshRuntimeState({ currentLocationId = 'herbology_garden', disabledStageFlagJudgmentFlows = {} } = {}) {
  return {
    version: 1,
    current_location_id: currentLocationId,
    time_slot: 'after_school',
    current_screen: 'academy-map',
    current_interaction_character_id: null,
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    disabled_stage_flag_judgment_flows: structuredClone(disabledStageFlagJudgmentFlows),
    visited_locations: [currentLocationId],
    active_character_ids: [],
    last_conversation_id: null,
    characters: {},
    pending_interaction_context: null,
    training_actions_used: 0,
    training_actions_limit: 6,
    elapsed_weeks: 0,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: []
  };
}

function freshPlayerParameters() {
  return normalizeParameters({}, { fallbackValue: 25 });
}

async function readJsonIfExists(fullPath) {
  try {
    return JSON.parse(await fs.readFile(fullPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function slotLabelFor(slotId) {
  return slotId.replaceAll('_', ' ');
}

function runtimePathsFor(root) {
  const resolvedRoot = path.resolve(root);
  const legacyGameDataRoot = path.join(resolvedRoot, 'game_data');
  if (existsSync(legacyGameDataRoot)) {
    return {
      playRoot: path.join(resolvedRoot, playAreaRelativeRoot),
      playSlotsRoot: path.join(resolvedRoot, playSlotsRelativeRoot),
      slotProjectRoot: (slotId) => path.join(resolvedRoot, playSlotsRelativeRoot, slotId),
      mutableGameDataRoot: legacyGameDataRoot,
      characterContentRoot: path.join(legacyGameDataRoot, 'characters')
    };
  }
  const runtimePaths = createRuntimePaths({ projectRoot: resolvedRoot });
  const playRoot = path.join(runtimePaths.mutableRoot, 'play');
  const playSlotsRoot = path.join(playRoot, 'slots');
  return {
    playRoot,
    playSlotsRoot,
    slotProjectRoot: (slotId) => path.join(playSlotsRoot, slotId),
    mutableGameDataRoot: runtimePaths.mutableRoot,
    characterContentRoot: runtimePaths.characterContentRoot
  };
}

export function resolvePlayRoot(root) {
  return runtimePathsFor(root).playRoot;
}

export function resolvePlaySlotsRoot(root) {
  return runtimePathsFor(root).playSlotsRoot;
}

export function resolveSlotProjectRoot(root, slotId) {
  return runtimePathsFor(root).slotProjectRoot(assertValidSlotId(slotId));
}

function resolveActiveSlotFile(root) {
  return path.join(resolvePlayRoot(root), 'active_slot.json');
}

function resolveActiveGameDataLink(root) {
  return path.join(resolvePlayRoot(root), 'game_data');
}

function resolveSlotMetaPath(root, slotId) {
  return path.join(resolveSlotProjectRoot(root, slotId), 'meta.json');
}

async function listExistingSlotIds(root) {
  const slotsRoot = resolvePlaySlotsRoot(root);
  try {
    const entries = await fs.readdir(slotsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function slotRuntimeStateExists(root, slotId) {
  const state = await readJsonIfExists(path.join(resolveSlotProjectRoot(root, slotId), 'game_data/runtime_state.json'));
  return state != null;
}

export async function isValidSlot(root, slotId) {
  const normalized = String(slotId ?? '').trim();
  if (!SLOT_ID_PATTERN.test(normalized)) return false;
  try {
    if (!(await slotRuntimeStateExists(root, normalized))) return false;
    const meta = await readSlotMeta(root, normalized);
    return meta != null;
  } catch (error) {
    if (error?.code === 'INVALID_SLOT_ID') return false;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function listValidSlotIds(root) {
  const ids = await listExistingSlotIds(root);
  const valid = [];
  for (const id of ids) {
    if (await isValidSlot(root, id)) valid.push(id);
  }
  return valid;
}

async function nextGeneratedSlotId(root) {
  const ids = await listValidSlotIds(root);
  let max = 0;
  for (const id of ids) {
    const match = /^slot_(\d+)$/.exec(id);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `slot_${String(max + 1).padStart(3, '0')}`;
}

export async function listOpeningMentorCharacterIds(root) {
  const storage = createStorageApi({ root });
  const charactersRoot = storage.paths.characterContentRoot;
  const entries = await fs.readdir(charactersRoot, { withFileTypes: true }).catch(() => []);
  const characterIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(await pathExists(path.join(charactersRoot, entry.name, 'profile.json')))) continue;
    // A numbered character_NNN directory is only a valid opening mentor when the catalog
    // selects it (index within 1..characterCount). A profile that exists on disk beyond the
    // catalog range — e.g. a Phase A profile committed ahead of the character count — is not
    // selectable, so it must never enter the mentor pool; otherwise new-game would 500 when
    // the catalog rejects it. Non-numbered defaults (lina) are kept as before.
    if (NUMBERED_CHARACTER_ID_PATTERN.test(entry.name) && !isSelectableCharacterId(entry.name)) continue;
    characterIds.push(entry.name);
  }
  characterIds.sort();
  return characterIds;
}

function missingFirstPlayOpeningMentorError(characterId) {
  const error = new Error(`first-play opening mentor profile is missing: ${characterId}`);
  error.code = 'FIRST_PLAY_OPENING_MENTOR_MISSING';
  error.errorCode = 'first_play_opening_mentor_missing';
  error.statusCode = 500;
  return error;
}

async function chooseFirstPlayOpeningMentorCharacterId(root) {
  const characterIds = await listOpeningMentorCharacterIds(root);
  if (!characterIds.includes(FIRST_PLAY_OPENING_MENTOR_CHARACTER_ID)) {
    throw missingFirstPlayOpeningMentorError(FIRST_PLAY_OPENING_MENTOR_CHARACTER_ID);
  }
  return FIRST_PLAY_OPENING_MENTOR_CHARACTER_ID;
}

async function chooseRandomOpeningMentorCharacterId(root, random = Math.random) {
  const characterIds = await listOpeningMentorCharacterIds(root);
  if (!characterIds.length) return null;
  const index = Math.min(characterIds.length - 1, Math.floor(random() * characterIds.length));
  return characterIds[index];
}

async function chooseOpeningMentorCharacterId(root, hasExistingSaveData, random = Math.random) {
  if (!hasExistingSaveData) return await chooseFirstPlayOpeningMentorCharacterId(root);
  return await chooseRandomOpeningMentorCharacterId(root, random);
}

function addOpeningMentorEvent(state, mentorCharacterId, now = new Date().toISOString()) {
  if (!mentorCharacterId) return state;
  const next = structuredClone(state);
  next.global_flags ??= {};
  next.event_flag_sources ??= {};
  next.global_flags['event.opening_mentor_intro.ready'] = true;
  next.event_flag_sources['event.opening_mentor_intro.ready'] = {
    character_id: mentorCharacterId,
    conversation_id: null,
    achieved_at: now,
    source_type: 'new_game'
  };
  return next;
}

async function readParentRuntimeState(root) {
  const storage = createStorageApi({ root });
  const state = await storage.readJsonIfExists('game_data/runtime_state.json');
  return state ?? {};
}

async function createSlotCharacterStorage(root, slotGameDataRoot) {
  const storage = createStorageApi({ root });
  const sourceCharactersRoot = storage.paths.characterContentRoot;
  const slotRoot = path.dirname(slotGameDataRoot);
  const entries = await fs.readdir(sourceCharactersRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceCharacterDir = path.join(sourceCharactersRoot, entry.name);
    const sourceProfilePath = path.join(sourceCharacterDir, 'profile.json');
    if (!(await pathExists(sourceProfilePath))) continue;
    await ensureCharacterMutableSurface({
      root: slotRoot,
      characterId: entry.name,
      flags: { character_id: entry.name, flags: {} },
      skills: { character_id: entry.name, skills: [] }
    });
  }
}

async function copyDefinitionsToSlot(root, slotRoot) {
  const slotGameDataRoot = path.join(slotRoot, 'game_data');
  await resetSlotGameDataRoot(slotRoot);
  await writeRuntimePathsManifest({ root: slotRoot, sourceRoot: root, mutableRoot: slotGameDataRoot });
  await createSlotCharacterStorage(root, slotGameDataRoot);
}

function buildSlotMeta({ slotId, label, state, now, playMode, routingPersonaVariant }) {
  const activePlayMode = assertValidSlotActivePlayMode({ playMode, routingPersonaVariant }, slotId);
  return {
    slot_id: slotId,
    label: label ?? slotLabelFor(slotId),
    created_at: now,
    updated_at: now,
    player_note: '',
    current_location_id: state.current_location_id ?? null,
    current_screen: state.current_screen ?? null,
    graduation_completed: state.ending_completed === true,
    play_mode: activePlayMode.mode,
    ...(activePlayMode.routing_persona_variant ? { routing_persona_variant: activePlayMode.routing_persona_variant } : {})
  };
}

export async function readActiveSlot(root) {
  return await readJsonIfExists(resolveActiveSlotFile(root));
}

export async function readValidActiveSlotId(root) {
  const active = await readActiveSlot(root);
  const slotId = String(active?.slot_id ?? '').trim();
  if (!slotId) return null;
  return await isValidSlot(root, slotId) ? slotId : null;
}

export async function resolveValidActivePlayRoot(root) {
  const slotId = await readValidActiveSlotId(root);
  if (!slotId) return null;
  const playRoot = resolvePlayRoot(root);
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  await fs.mkdir(resolvePlaySlotsRoot(root), { recursive: true });
  await fs.mkdir(playRoot, { recursive: true });
  await fs.rm(resolveActiveGameDataLink(root), { recursive: true, force: true });
  await writeRuntimePathsManifest({ root: playRoot, sourceRoot: root, mutableRoot: path.join(slotRoot, 'game_data') });
  return playRoot;
}

export async function readSlotMeta(root, slotId) {
  return await readJsonIfExists(resolveSlotMetaPath(root, slotId));
}

export async function writeSlotMeta(root, slotId, meta) {
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  await fs.mkdir(slotRoot, { recursive: true });
  await fs.writeFile(resolveSlotMetaPath(root, slotId), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function setActiveSlot(root, slotId) {
  const playRoot = resolvePlayRoot(root);
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  await fs.mkdir(resolvePlaySlotsRoot(root), { recursive: true });
  await fs.mkdir(playRoot, { recursive: true });
  await fs.rm(resolveActiveGameDataLink(root), { recursive: true, force: true });
  await writeRuntimePathsManifest({ root: playRoot, sourceRoot: root, mutableRoot: path.join(slotRoot, 'game_data') });
  const meta = await readSlotMeta(root, slotId);
  await fs.writeFile(resolveActiveSlotFile(root), `${JSON.stringify({
    slot_id: slotId,
    activated_at: new Date().toISOString(),
    label: meta?.label ?? slotLabelFor(slotId)
  }, null, 2)}\n`, 'utf8');
}

export async function refreshSlotMetaFromRuntime(root, slotId) {
  const slotRoot = resolveSlotProjectRoot(root, slotId);
  const state = await readJsonIfExists(path.join(slotRoot, 'game_data/runtime_state.json'));
  const existingMeta = await readSlotMeta(root, slotId);
  const now = new Date().toISOString();
  // Load-time meta refresh preserves the slot's persisted variant as-is (read-tolerant): a stale
  // out-of-closed-set variant is carried through, not validated or rewritten, so an existing save stays
  // loadable. Closed-set membership is enforced on write / at routing-persona use.
  const activePlayMode = normalizeSlotActivePlayModeForRead({
    playMode: existingMeta?.play_mode,
    routingPersonaVariant: existingMeta?.routing_persona_variant
  }, slotId);
  const nextMeta = {
    slot_id: slotId,
    label: existingMeta?.label ?? slotLabelFor(slotId),
    created_at: existingMeta?.created_at ?? now,
    updated_at: now,
    player_note: existingMeta?.player_note ?? '',
    current_location_id: state?.current_location_id ?? existingMeta?.current_location_id ?? null,
    current_screen: state?.current_screen ?? existingMeta?.current_screen ?? null,
    graduation_completed: state?.ending_completed === true,
    play_mode: activePlayMode.mode,
    ...(activePlayMode.routing_persona_variant ? { routing_persona_variant: activePlayMode.routing_persona_variant } : {})
  };
  await writeSlotMeta(root, slotId, nextMeta);
  return nextMeta;
}

export async function initializeNewPlayArea({ root, slotId, label, playMode, routingPersonaVariant, now = new Date().toISOString() }) {
  if (!root) throw new Error('root is required');
  const normalizedSlotId = slotId || await nextGeneratedSlotId(root);
  const activePlayMode = assertValidSlotActivePlayMode({ playMode, routingPersonaVariant }, normalizedSlotId);
  const slotRoot = resolveSlotProjectRoot(root, normalizedSlotId);
  const hasExistingSaveData = (await listValidSlotIds(root)).length > 0;
  const parentRuntimeState = await readParentRuntimeState(root);
  await copyDefinitionsToSlot(root, slotRoot);
  const freshState = freshRuntimeState({
    disabledStageFlagJudgmentFlows: parentRuntimeState.disabled_stage_flag_judgment_flows ?? {}
  });
  // Each mode seeds exactly its own opening event: loop opens on the academy-map mentor intro (actor is
  // a selectable mentor character), routing opens on the ルミ hub greeting (actor is the routing
  // persona). The mentor event only ever fires through the loop academy-map scan, so seeding it in
  // routing would leave a permanently-dead flag; keeping the seeds mode-specific preserves the
  // mechanism's symmetry (one new game → one mode-appropriate opening event).
  let state;
  if (activePlayMode.mode === 'routing') {
    state = addRoutingOpeningEvent(freshState, now);
  } else {
    const mentorCharacterId = await chooseOpeningMentorCharacterId(root, hasExistingSaveData);
    if (NUMBERED_CHARACTER_ID_PATTERN.test(String(mentorCharacterId ?? ''))) {
      await ensureSelectableCharacterStorage({ root: slotRoot, authoringRoot: root, characterId: mentorCharacterId });
    }
    state = addOpeningMentorEvent(freshState, mentorCharacterId, now);
  }
  const playerParameters = freshPlayerParameters();
  await writeJson(slotRoot, 'game_data/runtime_state.json', state);
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', playerParameters);
  await writeJson(slotRoot, 'game_data/player_inventory.json', { money: 0, items: [] });
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [] });
  // The MP reserve surface tracks a companion behavior line per roster character. Dungeon companions
  // exist in both loop and routing, so unlike the routing-only library / homunculi surfaces this seeds
  // in both modes (an empty surface reads every character at the initial line anyway).
  await writeJson(slotRoot, 'game_data/mp_reserve.json', { version: 1, reserves: {} });
  // The library collection and homunculi surfaces are routing-only (大書庫 / 錬成室 are routing
  // destinations). Seeding them in loop mode would add routing surfaces to the loop mutable set, so a loop
  // new game leaves them absent — absence reads as the empty surface anyway.
  if (activePlayMode.mode === 'routing') {
    await writeJson(slotRoot, 'game_data/library_collection.json', { version: 1, entries: [] });
    await writeJson(slotRoot, 'game_data/homunculi.json', { version: 1, active: [], nameplates: [] });
    // The star cradle (ハブの箱庭) is a routing-only hub side-activity: its garden and its caged-creature
    // item surfaces seed empty here, matching the library / homunculi routing-only surfaces.
    await writeJson(slotRoot, 'game_data/star_cradle.json', { version: 1, pots: [], creatures: [] });
    await writeJson(slotRoot, 'game_data/star_cradle_creatures.json', { version: 1, instances: [] });
  }
  await fs.mkdir(path.join(slotRoot, 'game_data/logs'), { recursive: true });
  const meta = buildSlotMeta({
    slotId: normalizedSlotId,
    label,
    state,
    now,
    playMode: activePlayMode.mode,
    routingPersonaVariant: activePlayMode.routing_persona_variant
  });
  await writeSlotMeta(root, normalizedSlotId, meta);
  await setActiveSlot(root, normalizedSlotId);
  return { area: 'play', root: slotRoot, slot: meta, state, player_parameters: playerParameters };
}

export async function listSlotIds(root) {
  return await listExistingSlotIds(root);
}
