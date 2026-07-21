// 錬成室 (homunculus atelier) domain orchestration: synthesis (人格生成 → 姿選定 → judged→consumed atomic
// seed) and farewell (お別れ発話 + 銘 → free slot + nameplate), plus the atelier arrival view. It sits on the
// homunculus surface (homunculusSurface.mjs), the face pool (homunculusPool.mjs), the atelier LLM generation
// (llm/homunculusGeneration.mjs), the inventory transaction (economy.mjs), and the content-result builder.
//
// Design (homunculus-atelier-brief + persona-genquality investigation, Lead 確定):
//   - Blind confirm: the child's人格・顔 are unseen until birth; no preview / no pre-accept re-roll. Because
//     素材消費 is bound behind judged→consumed, a generation/selection failure leaves nothing spent.
//   - Cost: the player picks dungeon materials totaling EXACTLY 10 (any of the 24 element×tier ids, tiers and
//     duplicates allowed), no money. They are consumed in the ONE inventory transaction that also seeds the
//     actor directory and appends the surface (工房クラフトと同じ 判定→消費 境界). 満枠(3)・pool 枯渇・素材の
//     catalog/合計10/所持不足/型 は fail-fast 錬成開始前 (before any LLM call / consume).
//   - Parameters: at synthesis the child gets the academy 11-parameter set (magic 6 + abilities 5, 0..100).
//     final_key = clamp(floor(0.4 × hero key) + round(r × material_bonus_key), 0, 100); each material adds its
//     element's magic bonus and 3 distinct ability bonuses (both tier-scaled), and one global roll r ∈ [0.5,
//     1.5] scales every key's material bonus. rng is an injected seam (the API passes Math.random).
//   - Face selection is a closed set over the pool MINUS this save's used faces, so a face never repeats.
//   - ids are homunculus_NNN, monotonically minted (max used + 1 across active ∪ nameplates), never reused.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { publicCanonicalFaceUrl } from './characterCatalog.mjs';
import { faceExpressions } from './faceExpressions.mjs';
import { consumeInventoryItems } from './economy.mjs';
import { loadDungeonMaterialDefinitions } from './dungeonMaterialCatalog.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions, normalizeParameters } from './parameters.mjs';
import { requireRoutingContentWeek, buildHomunculusContentResult } from './routingContentResult.mjs';
import {
  HOMUNCULI_SURFACE_PATH,
  HOMUNCULUS_ID_PATTERN,
  MAX_ACTIVE_HOMUNCULI,
  appendActiveHomunculus,
  emptyHomunculiSurface,
  farewellActiveHomunculus,
  loadHomunculiSurface
} from './homunculusSurface.mjs';
import { availableFaceLanes } from './homunculusPool.mjs';
import { homunculusAffinityPath, normalizeHomunculusAffinityFile } from './homunculusAffinity.mjs';
import {
  generateHomunculusEpitaph,
  generateHomunculusFarewell,
  generateHomunculusPersona,
  generateHomunculusSkeleton,
  selectHomunculusFace
} from './llm/homunculusGeneration.mjs';

const INVENTORY_PATH = 'game_data/player_inventory.json';
const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
const PLAYER_PARAMETERS_PATH = 'game_data/runtime/player_parameters.json';

// ----- cost (tunable constants, not env-configurable) -----

// The synthesis cost is player-chosen dungeon materials totaling EXACTLY this many (no money). Any of the 24
// element×tier ids, tier-mixed, duplicates allowed — the only constraint is the combined total.
export const HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL = 10;

// ----- parameter generation (tunable constants) -----

// final_key = clamp(base_key + round(r × bonus_key), 0, 100)
//   base_key = floor(HOMUNCULUS_PARAMETER_BASE_RATIO × 主人公の同 key 値)   （raw 読み・欠落 fail-fast）
//   素材1個ごとに その系統の魔法習熟へ +magic(tier)、相異なる3能力へ +ability(tier)
//   r        = 一様乱数 [ROLL_MIN, ROLL_MAX]（錬成1回に1回引き、全 key の素材ボーナス合計へ共通で掛ける）
const HOMUNCULUS_PARAMETER_BASE_RATIO = 0.4;
const HOMUNCULUS_MAGIC_BONUS_BY_TIER = Object.freeze({ 1: 3, 2: 8, 3: 15, 4: 26 });
const HOMUNCULUS_ABILITY_BONUS_BY_TIER = Object.freeze({ 1: 1, 2: 2, 3: 3, 4: 6 });
const HOMUNCULUS_ABILITY_BONUS_KEYS_PER_MATERIAL = 3;
const HOMUNCULUS_GLOBAL_ROLL_MIN = 0.5;
const HOMUNCULUS_GLOBAL_ROLL_MAX = 1.5;

const MAGIC_PARAMETER_KEYS = Object.freeze(magicParameterDefinitions.map((definition) => definition.key));
const ABILITY_PARAMETER_KEYS = Object.freeze(abilityParameterDefinitions.map((definition) => definition.key));

export const HOMUNCULUS_SYNTHESIS_MODES = Object.freeze(['manual', 'omakase']);

// ----- name validation (実装で確定・report に明記) -----

// A user-chosen name: non-empty (trimmed), at most HOMUNCULUS_NAME_MAX_LENGTH code points, and free of
// control characters, newlines, and the structural / quote brackets that would corrupt the generation
// prompts or the 『』 quote-gate. Fails fast (400) rather than sanitizing silently.
export const HOMUNCULUS_NAME_MAX_LENGTH = 24;
// The forbidden set: control characters (U+0000..U+001F, which include newline / carriage return), DEL
// (U+007F), and the structural / quote brackets listed individually — no unintended character ranges.
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f『』「」【】〈〉《》＜＞<>]/;

function nameError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errorCode = 'HOMUNCULUS_NAME_INVALID';
  return error;
}

export function validateHomunculusName(name) {
  if (typeof name !== 'string') throw nameError('homunculus name must be a string');
  const trimmed = name.trim();
  if (!trimmed) throw nameError('homunculus name must not be empty');
  if ([...trimmed].length > HOMUNCULUS_NAME_MAX_LENGTH) {
    throw nameError(`homunculus name must be at most ${HOMUNCULUS_NAME_MAX_LENGTH} characters`);
  }
  if (FORBIDDEN_NAME_CHARS.test(trimmed)) {
    throw nameError('homunculus name must not contain control characters, newlines, or bracket/quote symbols');
  }
  return trimmed;
}

function validateSynthesisMode(mode) {
  const normalized = String(mode ?? '').trim();
  if (!HOMUNCULUS_SYNTHESIS_MODES.includes(normalized)) {
    const error = new Error(`homunculus synthesis mode must be one of: ${HOMUNCULUS_SYNTHESIS_MODES.join(', ')}`);
    error.statusCode = 400;
    error.errorCode = 'HOMUNCULUS_MODE_INVALID';
    throw error;
  }
  return normalized;
}

function assertHomunculusId(homunculusId) {
  const normalized = String(homunculusId ?? '').trim();
  if (!HOMUNCULUS_ID_PATTERN.test(normalized)) {
    const error = new Error(`homunculus id must match homunculus_NNN: ${homunculusId}`);
    error.statusCode = 400;
    error.errorCode = 'HOMUNCULUS_ID_INVALID';
    throw error;
  }
  return normalized;
}

// ----- shared helpers -----

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

async function currentWeek(api) {
  const state = await api.readJson(RUNTIME_STATE_PATH);
  return requireRoutingContentWeek(state);
}

// The next monotonic id: max used NNN across active ∪ nameplates, plus one — so a farewelled id is never
// reissued (the surface enforces uniqueness; this guarantees the freshly minted id is always unused).
export function nextHomunculusId(surface) {
  let max = 0;
  for (const entry of [...(surface.active ?? []), ...(surface.nameplates ?? [])]) {
    const match = /^homunculus_(\d{3})$/.exec(entry.homunculus_id ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = max + 1;
  if (next > 999) throw new Error('homunculus id space (homunculus_001..homunculus_999) is exhausted');
  return `homunculus_${String(next).padStart(3, '0')}`;
}

function visualSummaryFields(faceId) {
  return {
    visual_set_id: faceId,
    face_url: publicCanonicalFaceUrl(faceId, 'neutral')
  };
}

function insufficientError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function rosterFullError() {
  const error = new Error(`the atelier already holds the maximum of ${MAX_ACTIVE_HOMUNCULI} homunculi; farewell one before synthesizing another`);
  error.statusCode = 409;
  error.errorCode = 'HOMUNCULUS_ROSTER_FULL';
  return error;
}

function ownedQuantity(inventory, itemId) {
  if (!inventory || !Array.isArray(inventory.items)) return 0;
  return inventory.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
}

function materialsError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errorCode = 'HOMUNCULUS_MATERIALS_INVALID';
  return error;
}

// Validates the player-chosen synthesis materials against the 24-entry dungeon catalog: every entry is a
// {item_id, quantity} with a positive-integer quantity and a catalog item_id; duplicate item_ids are summed;
// the combined total must be EXACTLY HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL. Returns the combined,
// item_id-sorted list carrying each entry's element/tier/name from the catalog. Fails fast (400) — no LLM.
function resolveSynthesisMaterials(materials, catalogById) {
  if (!Array.isArray(materials)) throw materialsError('homunculus synthesis materials must be an array of {item_id, quantity}');
  const combined = new Map();
  for (const entry of materials) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw materialsError('each homunculus synthesis material must be an object {item_id, quantity}');
    }
    const itemId = String(entry.item_id ?? '').trim();
    if (!catalogById.has(itemId)) throw materialsError(`unknown dungeon material for synthesis: ${entry.item_id}`);
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw materialsError(`homunculus synthesis material quantity must be a positive integer: ${entry.quantity}`);
    }
    combined.set(itemId, (combined.get(itemId) ?? 0) + quantity);
  }
  const total = [...combined.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (total !== HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL) {
    throw materialsError(`homunculus synthesis requires exactly ${HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL} materials in total; got ${total}`);
  }
  return [...combined.entries()]
    .map(([itemId, quantity]) => {
      const catalog = catalogById.get(itemId);
      return { item_id: itemId, quantity, element: catalog.element, tier: catalog.tier, name: catalog.name };
    })
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
}

// Pre-consume ownership check (fail-fast 錬成開始前, so a short-material synthesis never wastes an LLM call).
// Uses the same insufficient_item_quantity message the inventory transaction raises, so the API maps both to 400.
function assertMaterialsOwned(inventory, resolvedMaterials) {
  for (const material of resolvedMaterials) {
    if (ownedQuantity(inventory, material.item_id) < material.quantity) throw insufficientError('insufficient_item_quantity');
  }
}

// The hero's raw player-parameter value (equipmentCraft と同じ規律: raw 読み・欠落 fail-fast・default 補完なし).
function requiredPlayerParameterValue(parameters, group, key) {
  const entry = parameters?.[group]?.[key];
  const raw = entry !== null && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`player parameter ${group}.${key} is required for homunculus synthesis`);
  return value;
}

// Deterministic distinct pick using the injected rng: a partial Fisher–Yates shuffle over a copy.
function pickDistinctKeys(keys, count, rng) {
  const copy = [...keys];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}

// Generates the homunculus's 11 parameters from the hero's parameters + the chosen materials. Draws the global
// roll r ONCE, then for each individual material (quantity-expanded) adds its element's magic bonus and picks 3
// distinct abilities for the ability bonus. final_key = clamp(floor(0.4 × hero key) + round(r × bonus), 0, 100);
// the clamp / [0,100] round is C-12 normalizeParameters. rng is an injected [0,1) source — no default (no
// silent fallback), so the API layer must pass Math.random explicitly and tests pass a deterministic source.
export function generateHomunculusParameters({ playerParameters, materials, rng }) {
  if (typeof rng !== 'function') throw new Error('rng function is required for homunculus parameter generation');
  const roll = HOMUNCULUS_GLOBAL_ROLL_MIN + rng() * (HOMUNCULUS_GLOBAL_ROLL_MAX - HOMUNCULUS_GLOBAL_ROLL_MIN);
  const magicBonus = Object.fromEntries(MAGIC_PARAMETER_KEYS.map((key) => [key, 0]));
  const abilityBonus = Object.fromEntries(ABILITY_PARAMETER_KEYS.map((key) => [key, 0]));
  for (const material of materials) {
    for (let unit = 0; unit < material.quantity; unit += 1) {
      magicBonus[material.element] += HOMUNCULUS_MAGIC_BONUS_BY_TIER[material.tier];
      for (const key of pickDistinctKeys(ABILITY_PARAMETER_KEYS, HOMUNCULUS_ABILITY_BONUS_KEYS_PER_MATERIAL, rng)) {
        abilityBonus[key] += HOMUNCULUS_ABILITY_BONUS_BY_TIER[material.tier];
      }
    }
  }
  const finalValue = (base, bonus) => Math.floor(HOMUNCULUS_PARAMETER_BASE_RATIO * base) + Math.round(roll * bonus);
  const magic = Object.fromEntries(MAGIC_PARAMETER_KEYS.map((key) => [
    key,
    finalValue(requiredPlayerParameterValue(playerParameters, 'magic', key), magicBonus[key])
  ]));
  const abilities = Object.fromEntries(ABILITY_PARAMETER_KEYS.map((key) => [
    key,
    finalValue(requiredPlayerParameterValue(playerParameters, 'abilities', key), abilityBonus[key])
  ]));
  return normalizeParameters({ magic, abilities });
}

async function seedActorDirectory({ api, homunculusId, profile }) {
  const base = `game_data/homunculi/${homunculusId}`;
  await api.writeJson(`${base}/profile.json`, profile);
  await api.writeJson(`${base}/flags.json`, { character_id: homunculusId, flags: {} });
  await api.writeJson(`${base}/skills.json`, { character_id: homunculusId, skills: [] });
}

// Removes a seeded actor directory (transaction rollback). Resolves the actor dir from the profile write
// path and removes it recursively; a never-written dir is a no-op (force).
async function removeActorDirectory({ api, homunculusId }) {
  const profilePath = api.resolveWritePath(`game_data/homunculi/${homunculusId}/profile.json`);
  await fs.rm(path.dirname(profilePath), { recursive: true, force: true });
}

async function readAffinityValue(api, homunculusId) {
  const affinityFile = normalizeHomunculusAffinityFile(await api.readJsonIfExists(homunculusAffinityPath(homunculusId)), homunculusId);
  return affinityFile.affinity;
}

async function readMemoryTexts(api, homunculusId) {
  const entries = await api.listJson(`game_data/homunculi/${homunculusId}/memory`);
  return entries
    .map((entry) => (typeof entry?.text === 'string' ? entry.text.trim() : ''))
    .filter((text) => text.length > 0);
}

// ----- arrival view -----

// The atelier arrival view: the active children (with face urls + affinity + parameters), the persistent
// nameplates, the material picker (all 24 dungeon materials with held counts + the required total), and
// whether a new synthesis is possible (roster not full, pool not exhausted, at least 10 materials held). The
// conversation gate and the exit destination are the server's concern (added by the API layer).
export async function buildAtelierArrivalView({ root, storage } = {}) {
  const api = storageFor({ root, storage });
  const [surface, week, inventory, materialCatalog, state] = await Promise.all([
    loadHomunculiSurface({ storage: api }),
    currentWeek(api),
    api.readJsonIfExists(INVENTORY_PATH),
    loadDungeonMaterialDefinitions({ root: api.paths.projectRoot }),
    api.readJson(RUNTIME_STATE_PATH)
  ]);
  const currentBuddyId = state.current_buddy_character_id ?? null;
  const active = await Promise.all(surface.active.map(async (entry) => {
    const profile = await api.readJson(`game_data/homunculi/${entry.homunculus_id}/profile.json`);
    return {
      homunculus_id: entry.homunculus_id,
      display_name: entry.display_name,
      face_id: entry.face_id,
      created_week: entry.created_week,
      affinity: await readAffinityValue(api, entry.homunculus_id),
      parameters: normalizeParameters(profile.parameters),
      // Whether this active child is the current buddy (current_buddy_character_id match), so the atelier
      // arrival view can mark the buddy without the frontend re-deriving relationship state.
      is_buddy: entry.homunculus_id === currentBuddyId,
      ...visualSummaryFields(entry.face_id)
    };
  }));
  const nameplates = surface.nameplates.map((entry) => ({
    homunculus_id: entry.homunculus_id,
    display_name: entry.display_name,
    epitaph: entry.epitaph,
    face_id: entry.face_id,
    farewell_week: entry.farewell_week,
    ...visualSummaryFields(entry.face_id)
  }));
  const materials = materialCatalog.map((material) => ({
    item_id: material.item_id,
    name: material.name,
    element: material.element,
    tier: material.tier,
    held: ownedQuantity(inventory, material.item_id)
  }));
  const totalHeld = materials.reduce((sum, material) => sum + material.held, 0);
  return {
    week,
    active,
    nameplates,
    max_active: MAX_ACTIVE_HOMUNCULI,
    can_synthesize: surface.active.length < MAX_ACTIVE_HOMUNCULI
      && availableFaceLanes(surface).length > 0
      && totalHeld >= HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL,
    materials,
    required_material_total: HOMUNCULUS_SYNTHESIS_REQUIRED_MATERIAL_TOTAL
  };
}

// ----- synthesis (judged → consumed atomic) -----

// Synthesizes a new homunculus. Runs every fail-fast check that can spend nothing (満枠 / pool exhausted /
// material catalog+total+ownership / player parameters) BEFORE any LLM call, generates the child's parameters
// from the hero + chosen materials, then generates the persona (+ skeleton for omakase), selects a face from
// the used-excluded closed set, and binds the material spend (no money), actor-directory seed, and surface
// append into ONE inventory transaction. A failure at any stage leaves materials untouched. Returns the minted
// child (with parameters), the consumed costs (with display names), and the `created` content result.
export async function synthesizeHomunculus({ root, storage, config, fetchImpl, mode, name, skeleton, materials, rng, now } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus synthesis');
  if (typeof now !== 'string' || !now) throw new Error('now (ISO timestamp) is required for homunculus synthesis');
  if (typeof rng !== 'function') throw new Error('rng function is required for homunculus synthesis');
  const api = storageFor({ root, storage });
  const projectRoot = api.paths.projectRoot;
  const validatedName = validateHomunculusName(name);
  const normalizedMode = validateSynthesisMode(mode);

  // Fail-fast before any generation / consume: full roster, exhausted pool, malformed/short/unowned materials,
  // or absent/incomplete player parameters — so nothing here can waste an LLM call.
  const surface = await loadHomunculiSurface({ storage: api });
  if (surface.active.length >= MAX_ACTIVE_HOMUNCULI) throw rosterFullError();
  const candidates = availableFaceLanes(surface);
  if (candidates.length === 0) {
    const error = new Error('the homunculus face pool is exhausted; no unused face remains');
    error.statusCode = 409;
    error.errorCode = 'HOMUNCULUS_FACE_POOL_EXHAUSTED';
    throw error;
  }
  const materialCatalog = await loadDungeonMaterialDefinitions({ root: projectRoot });
  const catalogById = new Map(materialCatalog.map((material) => [material.item_id, material]));
  const resolvedMaterials = resolveSynthesisMaterials(materials, catalogById);
  const inventory = await api.readJsonIfExists(INVENTORY_PATH);
  assertMaterialsOwned(inventory, resolvedMaterials);

  const playerParameters = await api.readJsonIfExists(PLAYER_PARAMETERS_PATH);
  if (playerParameters === null) throw new Error('player parameters are required for homunculus synthesis');
  const parameters = generateHomunculusParameters({ playerParameters, materials: resolvedMaterials, rng });

  // Generation (manual takes the caller's skeleton; omakase generates it from the name first).
  let usedSkeleton;
  if (normalizedMode === 'manual') {
    if (typeof skeleton !== 'string' || !skeleton.trim()) {
      throw nameError('manual synthesis requires a non-empty skeleton');
    }
    usedSkeleton = skeleton.trim();
  } else {
    usedSkeleton = await generateHomunculusSkeleton({ config, fetchImpl, name: validatedName });
  }
  const persona = await generateHomunculusPersona({ config, fetchImpl, name: validatedName, skeleton: usedSkeleton });
  const faceId = await selectHomunculusFace({
    config,
    fetchImpl,
    name: validatedName,
    promptDescription: persona.prompt_description,
    candidates
  });

  const homunculusId = nextHomunculusId(surface);
  const week = await currentWeek(api);
  const activeEntry = { homunculus_id: homunculusId, display_name: validatedName, face_id: faceId, created_week: week };
  const profile = {
    character_id: homunculusId,
    display_name: validatedName,
    visual_set_id: faceId,
    prompt_description: persona.prompt_description,
    speaking_basis: persona.speaking_basis,
    available_expressions: [...faceExpressions],
    parameters
  };

  // Atomic: seed the actor directory and append the surface in beforeWrite; if the inventory write then
  // fails, rollback restores the prior surface and removes the seeded directory, so nothing is half-applied.
  let priorSurface = null;
  const transaction = await consumeInventoryItems({
    root: projectRoot,
    itemCosts: resolvedMaterials.map((material) => ({ item_id: material.item_id, quantity: material.quantity })),
    moneyCost: 0,
    rewards: [],
    beforeWrite: async () => {
      priorSurface = await loadHomunculiSurface({ storage: api });
      await seedActorDirectory({ api, homunculusId, profile });
      return await appendActiveHomunculus({ storage: api, entry: activeEntry });
    },
    rollbackBeforeWrite: async () => {
      await api.writeJson(HOMUNCULI_SURFACE_PATH, priorSurface ?? emptyHomunculiSurface());
      await removeActorDirectory({ api, homunculusId });
    }
  });

  const contentResult = buildHomunculusContentResult({
    week,
    now,
    action: 'created',
    homunculusId,
    displayName: validatedName,
    faceId
  });

  return {
    homunculus: {
      homunculus_id: homunculusId,
      display_name: validatedName,
      face_id: faceId,
      created_week: week,
      parameters,
      ...visualSummaryFields(faceId)
    },
    mode: normalizedMode,
    consumed_costs: {
      item_costs: transaction.item_costs.map((cost) => ({ ...cost, name: catalogById.get(cost.item_id).name }))
    },
    inventory: transaction.inventory,
    content_result: contentResult
  };
}

// Clears every current-buddy / companion-equipment reference to a homunculus about to be farewelled, so no
// buddy pointer (current_buddy_character_id + the actor buddy flag) or companion equipment slot dangles onto
// a non-active homunculus after farewell. The equipment instances stay on the equipment surface (they revert
// to unequipped, not deleted). Buddy clearing is conditional on the child actually being the current buddy;
// the companion equipment slot is removed whenever one exists.
async function clearFarewelledHomunculusReferences({ api, homunculusId }) {
  const buddyFlag = `relationship.${homunculusId}.buddy`;
  const state = await api.readJson(RUNTIME_STATE_PATH);
  let changed = false;
  const wasBuddy = state.current_buddy_character_id === homunculusId;
  if (wasBuddy) {
    state.current_buddy_character_id = null;
    if (state.homunculi?.[homunculusId]?.flags) state.homunculi[homunculusId].flags[buddyFlag] = false;
    changed = true;
  }
  if (state.companion_equipment_slots && Object.prototype.hasOwnProperty.call(state.companion_equipment_slots, homunculusId)) {
    delete state.companion_equipment_slots[homunculusId];
    if (Object.keys(state.companion_equipment_slots).length === 0) delete state.companion_equipment_slots;
    changed = true;
  }
  if (changed) await api.writeJson(RUNTIME_STATE_PATH, state);
  if (wasBuddy) {
    const flagsPath = `game_data/homunculi/${homunculusId}/flags.json`;
    const flagsFile = await api.readJsonIfExists(flagsPath) ?? { character_id: homunculusId, flags: {} };
    flagsFile.character_id ??= homunculusId;
    flagsFile.flags ??= {};
    flagsFile.flags[buddyFlag] = false;
    await api.writeJson(flagsPath, flagsFile);
  }
}

// ----- farewell (speech + 銘 → free slot + nameplate) -----

// Farewells an active homunculus: generates the farewell speech (§6) and the short 銘文 from the child's
// persona + affinity + verbatim memories, clears any buddy / companion-equipment reference to it (so nothing
// dangles onto a now-inactive homunculus), then frees its active slot and appends its persistent nameplate.
// One-way (no restore); the face id stays excluded from future candidates because it lives on in the
// nameplate. A generation failure leaves the child active (fail-fast, retriable). Returns the speech + the
// `farewell` content result for the caller to record.
export async function farewellHomunculus({ root, storage, config, fetchImpl, homunculusId, now } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus farewell');
  if (typeof now !== 'string' || !now) throw new Error('now (ISO timestamp) is required for homunculus farewell');
  const api = storageFor({ root, storage });
  const normalizedId = assertHomunculusId(homunculusId);
  const surface = await loadHomunculiSurface({ storage: api });
  const activeEntry = surface.active.find((entry) => entry.homunculus_id === normalizedId);
  if (!activeEntry) {
    const error = new Error(`homunculus is not active in the atelier: ${normalizedId}`);
    error.statusCode = 404;
    error.errorCode = 'HOMUNCULUS_NOT_ACTIVE';
    throw error;
  }

  const [profile, affinity, memories, week] = await Promise.all([
    api.readJson(`game_data/homunculi/${normalizedId}/profile.json`),
    readAffinityValue(api, normalizedId),
    readMemoryTexts(api, normalizedId),
    currentWeek(api)
  ]);

  const farewellSpeech = await generateHomunculusFarewell({
    config,
    fetchImpl,
    name: activeEntry.display_name,
    promptDescription: profile.prompt_description,
    speakingBasis: profile.speaking_basis,
    affinity,
    memories
  });
  const epitaph = await generateHomunculusEpitaph({
    config,
    fetchImpl,
    name: activeEntry.display_name,
    promptDescription: profile.prompt_description,
    affinity
  });

  // Clear buddy / companion-equipment references BEFORE the surface move, so the farewell never leaves a
  // buddy pointer or companion equipment slot dangling onto a now-inactive homunculus.
  await clearFarewelledHomunculusReferences({ api, homunculusId: normalizedId });
  await farewellActiveHomunculus({ storage: api, homunculusId: normalizedId, epitaph, farewellWeek: week });

  const contentResult = buildHomunculusContentResult({
    week,
    now,
    action: 'farewell',
    homunculusId: normalizedId,
    displayName: activeEntry.display_name,
    faceId: activeEntry.face_id,
    epitaph
  });

  return {
    homunculus_id: normalizedId,
    display_name: activeEntry.display_name,
    face_id: activeEntry.face_id,
    farewell_speech: farewellSpeech,
    epitaph,
    farewell_week: week,
    ...visualSummaryFields(activeEntry.face_id),
    content_result: contentResult
  };
}

// The visual summary for one child (the conversation-start / arrival face payload the frontend renders).
// Reused by the API so the atelier conversation surface carries server-resolved visuals.
export function homunculusVisualSummary({ homunculusId, displayName, faceId }) {
  return {
    homunculus_id: homunculusId,
    display_name: displayName,
    face_id: faceId,
    ...visualSummaryFields(faceId)
  };
}
