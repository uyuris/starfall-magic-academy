import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import {
  loadStudyCircleDefinitions,
  studyCircleTrainingDefinition,
  validateStudyCircleDefinitions
} from './studyCircleDefinitions.mjs';
import { abilityParameterDefinitions, magicParameterDefinitions, normalizeParameters } from './parameters.mjs';
import { loadWorldSettings, updatePlayerParameters } from './worldSettings.mjs';
import { trainingDefinitions } from './training.mjs';
import { STUDY_CIRCLE_SOURCE_TYPE } from './routingMetaContext.mjs';

// The authored themes are the training definitions' ids: the study circle grows the same
// parameters a week of that training would. Derived here (single source of truth) so the
// catalog loader validates theme membership and per-theme counts without a parallel list.
const STUDY_CIRCLE_THEME_IDS = Object.freeze(trainingDefinitions.map((training) => training.id));

export const STUDY_CIRCLE_WEEKLY_OFFER_COUNT = 3;
export const ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY = 'routing_active_study_circle';
export const ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY = 'routing_weekly_study_circle_offers';

const STUDY_CIRCLE_TYPES_FILENAME = 'study_circle_types.json';
const STUDY_CIRCLE_TRIGGER = 'study_circle_completed';
const EFFECT_GROUPS = Object.freeze(['magic', 'abilities']);
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;
const STUDY_CIRCLE_TYPE_ID_PATTERN = /^[a-z0-9_-]+$/;
// The pure-scene ban the LLM-generated situation is held to (same register discipline as
// the errand offer situation): no "someone was here / a presence / a sigh" narration.
const BANNED_SITUATION_PATTERN = /誰|持ち主|気配|らしい|溜め息|温もり|温み|余韻|余熱|名残|見当たらない|立ち去|席を外|願かけ/u;

// The catalog's closed reward-band vocabulary. Study circle rewards are parameter deltas
// (not money): the band fixes the per-parameter growth amount rolled for an offer. Pinned
// here so a stray band slug in the data fails the loader fast.
export const STUDY_CIRCLE_REWARD_BAND_KEYS = Object.freeze(['small', 'medium', 'large']);
export const STUDY_CIRCLE_TYPE_COUNT = 140;
export const STUDY_CIRCLE_TYPES_PER_THEME = 7;

const parameterDefinitionsByGroup = Object.freeze({
  magic: new Map(magicParameterDefinitions.map((definition) => [definition.key, definition])),
  abilities: new Map(abilityParameterDefinitions.map((definition) => [definition.key, definition]))
});

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredStudyCircleTypeId(value, label) {
  const normalized = requiredString(value, label);
  if (!STUDY_CIRCLE_TYPE_ID_PATTERN.test(normalized)) throw new Error(`${label} must match ${STUDY_CIRCLE_TYPE_ID_PATTERN}`);
  return normalized;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

function assertElapsedWeeks(elapsedWeeks) {
  return nonNegativeInteger(elapsedWeeks, 'study circle elapsedWeeks');
}

function requiredConversationId(value, label = 'conversation_id') {
  const normalized = requiredString(value, label);
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`${label} must be a valid conversation id`);
  return normalized;
}

function validateSituation(value, label) {
  const normalized = requiredString(value, label);
  if (BANNED_SITUATION_PATTERN.test(normalized)) throw new Error(`${label} contains non-scene wording`);
  return normalized;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rotatedDeterministicItems(items, { elapsedWeeks, namespace, idFor }) {
  const ordered = [...items].sort((a, b) => {
    const scoreA = stableHash(`${namespace}:${idFor(a)}`);
    const scoreB = stableHash(`${namespace}:${idFor(b)}`);
    return scoreA - scoreB || String(idFor(a)).localeCompare(String(idFor(b)));
  });
  const start = elapsedWeeks % ordered.length;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

// ----- study circle type catalog -----

function validateStudyCircleRewardBand(band, label) {
  requiredObject(band, label);
  const min = positiveInteger(band.min, `${label}.min`);
  const max = positiveInteger(band.max, `${label}.max`);
  if (min > max) throw new Error(`${label}.min must not exceed ${label}.max`);
  return { min, max };
}

function validateStudyCircleRewardBands(value) {
  requiredObject(value, 'study circle reward_bands');
  const keys = Object.keys(value).sort();
  const expected = [...STUDY_CIRCLE_REWARD_BAND_KEYS].sort();
  const matches = keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`study circle reward_bands keys must be exactly {${expected.join(', ')}}: got {${keys.join(', ')}}`);
  const bands = {};
  for (const key of STUDY_CIRCLE_REWARD_BAND_KEYS) bands[key] = validateStudyCircleRewardBand(value[key], `study circle reward_bands.${key}`);
  // Bands are strictly ordered and non-overlapping: small < medium < large.
  if (bands.small.max >= bands.medium.min) throw new Error('study circle reward_bands small must end below medium');
  if (bands.medium.max >= bands.large.min) throw new Error('study circle reward_bands medium must end below large');
  return bands;
}

function validateStudyCircleType(entry, index, { bands, themeIds }) {
  requiredObject(entry, `study circle type[${index}]`);
  const themeId = requiredString(entry.theme_id, `study circle type[${index}].theme_id`);
  if (!themeIds.has(themeId)) {
    throw new Error(`study circle type[${index}].theme_id must be a known theme: ${themeId}`);
  }
  const rewardBand = requiredString(entry.reward_band, `study circle type[${index}].reward_band`);
  if (!Object.prototype.hasOwnProperty.call(bands, rewardBand)) {
    throw new Error(`study circle type[${index}].reward_band must be a known band: ${rewardBand}`);
  }
  return {
    id: requiredStudyCircleTypeId(entry.id, `study circle type[${index}].id`),
    theme_id: themeId,
    name: requiredString(entry.name, `study circle type[${index}].name`),
    scene_brief: requiredString(entry.scene_brief, `study circle type[${index}].scene_brief`),
    condition_text: requiredString(entry.condition_text, `study circle type[${index}].condition_text`),
    reward_band: rewardBand
  };
}

export function validateStudyCircleTypeCatalog(value) {
  requiredObject(value, 'study circle type catalog');
  const bands = validateStudyCircleRewardBands(value.reward_bands);
  if (!Array.isArray(value.types)) throw new Error('study circle type catalog types must be an array');
  if (value.types.length !== STUDY_CIRCLE_TYPE_COUNT) {
    throw new Error(`study circle type catalog must contain exactly ${STUDY_CIRCLE_TYPE_COUNT} types: got ${value.types.length}`);
  }
  const themeIds = new Set(STUDY_CIRCLE_THEME_IDS);
  const seenIds = new Set();
  const perTheme = new Map(STUDY_CIRCLE_THEME_IDS.map((themeId) => [themeId, 0]));
  const types = value.types.map((entry, index) => {
    const type = validateStudyCircleType(entry, index, { bands, themeIds });
    if (seenIds.has(type.id)) throw new Error(`study circle type id must be unique: ${type.id}`);
    seenIds.add(type.id);
    perTheme.set(type.theme_id, perTheme.get(type.theme_id) + 1);
    return type;
  });
  for (const [themeId, count] of perTheme) {
    if (count !== STUDY_CIRCLE_TYPES_PER_THEME) {
      throw new Error(`study circle theme ${themeId} must have exactly ${STUDY_CIRCLE_TYPES_PER_THEME} types: got ${count}`);
    }
  }
  return { reward_bands: bands, types };
}

export async function loadStudyCircleTypeCatalog({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const catalogPath = path.join(storage.paths.definitionsRoot, STUDY_CIRCLE_TYPES_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`study circle type catalog file is missing: ${catalogPath}`);
    throw error;
  }
  return validateStudyCircleTypeCatalog(JSON.parse(raw));
}

// ----- reward params (which parameters grow, from the theme's training definition) -----

function parameterDefinition(effect) {
  if (!EFFECT_GROUPS.includes(effect?.group)) throw new Error(`unknown study circle reward group: ${effect?.group}`);
  const definition = parameterDefinitionsByGroup[effect.group].get(effect.key);
  if (!definition) throw new Error(`unknown study circle reward parameter: ${effect.group}.${effect.key}`);
  return definition;
}

// The theme fixes WHICH parameters grow (the training definition's increases); the band
// roll fixes the amount, applied uniformly to each grown parameter.
function rewardParamsForTheme({ themeId, amount }) {
  const training = studyCircleTrainingDefinition(themeId);
  if (!Array.isArray(training?.increases) || training.increases.length === 0) {
    throw new Error(`study circle theme ${themeId} requires training increases`);
  }
  positiveInteger(amount, `study circle reward amount for ${themeId}`);
  return training.increases.map((effect) => {
    const definition = parameterDefinition(effect);
    return { group: effect.group, key: effect.key, label: definition.label, amount };
  });
}

// Deterministic per-parameter growth amount for a type this week: an integer inside the
// type's band, seeded by (type id, week). Same (type, week) always yields the same amount.
export function studyCircleRewardAmount({ band, week, typeId }) {
  const min = positiveInteger(band?.min, 'study circle reward band.min');
  const max = positiveInteger(band?.max, 'study circle reward band.max');
  if (min > max) throw new Error('study circle reward band.min must not exceed band.max');
  const span = max - min + 1;
  return min + (stableHash(`routing-study-circle-reward:${requiredString(typeId, 'typeId')}:${nonNegativeInteger(week, 'week')}`) % span);
}

// ----- loaded definitions (theme skeleton: venue + resolved hosts) -----

function validateLoadedStudyCircleDefinitions(definitions) {
  const raw = validateStudyCircleDefinitions(definitions);
  const sourceByThemeId = new Map(definitions.map((definition) => [definition.theme_id, definition]));
  return raw.map((definition) => {
    const source = sourceByThemeId.get(definition.theme_id);
    if (!Array.isArray(source?.host_candidates)) {
      throw new Error(`${definition.theme_id}.host_candidates must be present on loaded study circle definitions`);
    }
    if (source.host_candidates.length !== definition.host_candidate_ids.length) {
      throw new Error(`${definition.theme_id}.host_candidates must match host_candidate_ids`);
    }
    const hostCandidates = source.host_candidates.map((candidate, index) => {
      const value = requiredObject(candidate, `${definition.theme_id}.host_candidates[${index}]`);
      const characterId = requiredString(value.character_id, `${definition.theme_id}.host_candidates[${index}].character_id`);
      if (characterId !== definition.host_candidate_ids[index]) {
        throw new Error(`${definition.theme_id}.host_candidates[${index}] must match host_candidate_ids`);
      }
      return {
        character_id: characterId,
        display_name: requiredString(value.display_name, `${definition.theme_id}.host_candidates[${index}].display_name`)
      };
    });
    return { ...definition, host_candidates: hostCandidates };
  });
}

// Host order for a theme this week is a full deterministic permutation keyed by (theme_id, week,
// candidate_id) — NOT a fixed order rotated by (week % candidate_count). A rotation start of the form
// `week % N` couples the weeks a theme is actually offered (fixed by week % 20 via the theme rotation) to
// which host lands at the front, so when the theme count (20) and a candidate-list length N share a factor
// only a subset of list residues is ever sampled and some candidates are unreachable. Re-sorting the whole
// list by stableHash(...:<week>:<candidate>) reshuffles it independently every week, so over the full cycle
// every candidate reaches the front of some offered week — reachability no longer depends on gcd(20, N).
function orderedHostsForDefinition({ definition, week }) {
  return [...definition.host_candidates].sort((a, b) => {
    const scoreA = stableHash(`routing-study-circle-host:${definition.theme_id}:${week}:${a.character_id}`);
    const scoreB = stableHash(`routing-study-circle-host:${definition.theme_id}:${week}:${b.character_id}`);
    return scoreA - scoreB || a.character_id.localeCompare(b.character_id);
  });
}

function assignUniqueHosts({ definitions, week }) {
  const candidateOrders = definitions.map((definition) => orderedHostsForDefinition({ definition, week }));
  const assigned = [];
  function search(index, usedCharacterIds) {
    if (index >= candidateOrders.length) return true;
    for (const host of candidateOrders[index]) {
      if (usedCharacterIds.has(host.character_id)) continue;
      assigned[index] = host;
      usedCharacterIds.add(host.character_id);
      if (search(index + 1, usedCharacterIds)) return true;
      usedCharacterIds.delete(host.character_id);
      assigned[index] = null;
    }
    return false;
  }
  if (!search(0, new Set())) throw new Error('unable to assign unique study circle hosts');
  return assigned;
}

// ----- deterministic weekly skeleton draw -----

function weekFromState(state) {
  requiredObject(state, 'runtime state');
  return assertElapsedWeeks(state.elapsed_weeks);
}

// Draws the deterministic skeleton for the week: three distinct themes, a type drawn from
// each theme's authored catalog, a unique host per theme (host selection unchanged), and a
// band-rolled per-parameter reward. No LLM, no prose — this is the parameter-economy part
// the design keeps out of the model's hands. Returns { week, skeletons: [...] }.
export function drawWeeklyStudyCircleSkeletons({ state, catalog, definitions }) {
  const week = weekFromState(state);
  const { reward_bands: bands, types } = validateStudyCircleTypeCatalog(catalog);
  const normalizedDefinitions = validateLoadedStudyCircleDefinitions(definitions);
  if (normalizedDefinitions.length < STUDY_CIRCLE_WEEKLY_OFFER_COUNT) {
    throw new Error('validated study circle definitions are required');
  }

  const typesByTheme = new Map();
  for (const type of types) {
    if (!typesByTheme.has(type.theme_id)) typesByTheme.set(type.theme_id, []);
    typesByTheme.get(type.theme_id).push(type);
  }

  const selectedDefinitions = rotatedDeterministicItems(normalizedDefinitions, {
    elapsedWeeks: week,
    namespace: 'routing-study-circle-theme',
    idFor: (definition) => definition.theme_id
  }).slice(0, STUDY_CIRCLE_WEEKLY_OFFER_COUNT);

  const hosts = assignUniqueHosts({ definitions: selectedDefinitions, week });

  const skeletons = selectedDefinitions.map((definition, index) => {
    const themeTypes = typesByTheme.get(definition.theme_id);
    if (!Array.isArray(themeTypes) || themeTypes.length === 0) {
      throw new Error(`study circle theme has no catalog types: ${definition.theme_id}`);
    }
    const chosenType = rotatedDeterministicItems(themeTypes, {
      elapsedWeeks: week,
      namespace: `routing-study-circle-type:${definition.theme_id}`,
      idFor: (type) => type.id
    })[0];
    const amount = studyCircleRewardAmount({ band: bands[chosenType.reward_band], week, typeId: chosenType.id });
    const training = studyCircleTrainingDefinition(definition.theme_id);
    return {
      study_circle_id: chosenType.id,
      type_id: chosenType.id,
      theme_id: definition.theme_id,
      theme_name: training.name,
      name: chosenType.name,
      scene_brief: chosenType.scene_brief,
      condition_text: chosenType.condition_text,
      reward_band: chosenType.reward_band,
      reward_params: rewardParamsForTheme({ themeId: definition.theme_id, amount }),
      venue: definition.venue,
      host_character_id: hosts[index].character_id,
      host_display_name: hosts[index].display_name
    };
  });

  return { week, skeletons };
}

// ----- reward params validation -----

function validateRewardParams(rewardParams, label) {
  if (!Array.isArray(rewardParams) || rewardParams.length === 0) throw new Error(`${label} must be a non-empty array`);
  return rewardParams.map((reward, index) => {
    const value = requiredObject(reward, `${label}[${index}]`);
    const group = requiredString(value.group, `${label}[${index}].group`);
    if (!EFFECT_GROUPS.includes(group)) throw new Error(`${label}[${index}].group must be one of: ${EFFECT_GROUPS.join(', ')}`);
    const normalized = {
      group,
      key: requiredString(value.key, `${label}[${index}].key`),
      label: requiredString(value.label, `${label}[${index}].label`),
      amount: positiveInteger(value.amount, `${label}[${index}].amount`)
    };
    parameterDefinition(normalized);
    return normalized;
  });
}

// ----- persisted weekly offers (runtime_state slot) -----

function validatePersistedStudyCircleOffer(value, index) {
  requiredObject(value, `weekly study circle offer[${index}]`);
  return {
    study_circle_id: requiredStudyCircleTypeId(value.study_circle_id, `weekly study circle offer[${index}].study_circle_id`),
    type_id: requiredStudyCircleTypeId(value.type_id, `weekly study circle offer[${index}].type_id`),
    theme_id: requiredString(value.theme_id, `weekly study circle offer[${index}].theme_id`),
    theme_name: requiredString(value.theme_name, `weekly study circle offer[${index}].theme_name`),
    title: requiredString(value.title, `weekly study circle offer[${index}].title`),
    situation: validateSituation(value.situation, `weekly study circle offer[${index}].situation`),
    motivation: requiredString(value.motivation, `weekly study circle offer[${index}].motivation`),
    // appeal (主催者当人の語り) is required: an old-form persisted offer without it fails fast
    // here — there is no compat read / migration / default fill (the week regenerates on advance).
    appeal: requiredString(value.appeal, `weekly study circle offer[${index}].appeal`),
    condition_text: requiredString(value.condition_text, `weekly study circle offer[${index}].condition_text`),
    reward_params: validateRewardParams(value.reward_params, `weekly study circle offer[${index}].reward_params`),
    venue: requiredString(value.venue, `weekly study circle offer[${index}].venue`),
    host_character_id: requiredString(value.host_character_id, `weekly study circle offer[${index}].host_character_id`),
    host_display_name: requiredString(value.host_display_name, `weekly study circle offer[${index}].host_display_name`)
  };
}

export function validateWeeklyStudyCircleOffers(value) {
  requiredObject(value, 'routing weekly study circle offers');
  if (!Array.isArray(value.offers)) throw new Error('routing weekly study circle offers.offers must be an array');
  if (value.offers.length !== STUDY_CIRCLE_WEEKLY_OFFER_COUNT) {
    throw new Error(`routing weekly study circle offers must contain exactly ${STUDY_CIRCLE_WEEKLY_OFFER_COUNT} offers`);
  }
  const week = nonNegativeInteger(value.week, 'routing weekly study circle offers week');
  const seenOfferIds = new Set();
  const seenThemeIds = new Set();
  const offers = value.offers.map((offer, index) => {
    const normalized = validatePersistedStudyCircleOffer(offer, index);
    if (seenOfferIds.has(normalized.study_circle_id)) {
      throw new Error(`weekly study circle offer study_circle_id must be unique: ${normalized.study_circle_id}`);
    }
    if (seenThemeIds.has(normalized.theme_id)) {
      throw new Error(`weekly study circle offer theme_id must be unique: ${normalized.theme_id}`);
    }
    seenOfferIds.add(normalized.study_circle_id);
    seenThemeIds.add(normalized.theme_id);
    return normalized;
  });
  return { week, offers };
}

export function readWeeklyStudyCircleOffers(state) {
  requiredObject(state, 'runtime state is required to read the weekly study circle offers');
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY)) return null;
  return validateWeeklyStudyCircleOffers(state[ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY]);
}

function themeNotOfferedError(themeId) {
  const error = new Error(`study circle theme is not offered this week: ${themeId}`);
  error.statusCode = 400;
  error.errorCode = 'STUDY_CIRCLE_THEME_NOT_OFFERED';
  return error;
}

export function findPersistedStudyCircleOffer({ offers, themeId }) {
  const normalizedThemeId = requiredString(themeId, 'theme_id');
  const offer = offers?.offers?.find((candidate) => candidate.theme_id === normalizedThemeId) ?? null;
  if (!offer) throw themeNotOfferedError(normalizedThemeId);
  return validatePersistedStudyCircleOffer(offer, 0);
}

// The public offer is the client-facing subset. The motivation and the achievement condition
// (`condition_text`) stay internal: the motivation is the scene-injection tail, and the condition
// is the authored judgment value the achievement check uses — neither is display text and neither
// is shown to the player. The appeal (主催者当人の語り) is the card's主表示; situation stays public
// because the daytime scene detail popup (会場) reads it as its pure-scene description — the offer
// card itself renders neither situation nor a condition.
export function toPublicStudyCircleOffer(offer) {
  const normalized = validatePersistedStudyCircleOffer(offer, 0);
  return {
    theme_id: normalized.theme_id,
    type_id: normalized.type_id,
    theme_name: normalized.theme_name,
    title: normalized.title,
    venue: normalized.venue,
    situation: normalized.situation,
    appeal: normalized.appeal,
    reward_params: normalized.reward_params,
    host_character_id: normalized.host_character_id,
    host_display_name: normalized.host_display_name
  };
}

// ----- active study circle (opened conversation) -----

export function makeStudyCircleConversationId({ now, week, themeId, hostCharacterId }) {
  const timestamp = requiredString(now, 'now').replace(/[^0-9A-Za-z]/g, '');
  const normalizedWeek = assertElapsedWeeks(week);
  const normalizedThemeId = requiredString(themeId, 'theme_id').replace(/[^0-9A-Za-z_-]/g, '-');
  const normalizedHostId = requiredString(hostCharacterId, 'host_character_id').replace(/[^0-9A-Za-z_-]/g, '-');
  return `conv_study_circle_${normalizedWeek}_${normalizedThemeId}_${normalizedHostId}_${timestamp}`;
}

// Builds the active study circle from a persisted weekly offer. The generated motivation
// becomes prompt_tail_context so the scene-context injection contract is unchanged;
// type_id and condition_text ride along for the (later) achievement judgment.
export function buildActiveRoutingStudyCircle({ offer, conversationId, week, startedAt }) {
  const normalizedOffer = validatePersistedStudyCircleOffer(offer, 0);
  return validateActiveRoutingStudyCircle({
    conversation_id: requiredConversationId(conversationId),
    week: assertElapsedWeeks(week),
    started_at: requiredString(startedAt, 'started_at'),
    study_circle_id: normalizedOffer.study_circle_id,
    type_id: normalizedOffer.type_id,
    theme_id: normalizedOffer.theme_id,
    theme_name: normalizedOffer.theme_name,
    title: normalizedOffer.title,
    host_character_id: normalizedOffer.host_character_id,
    host_display_name: normalizedOffer.host_display_name,
    venue: normalizedOffer.venue,
    situation: normalizedOffer.situation,
    prompt_tail_context: normalizedOffer.motivation,
    condition_text: normalizedOffer.condition_text,
    reward_params: normalizedOffer.reward_params
  });
}

export function validateActiveRoutingStudyCircle(record) {
  requiredObject(record, 'routing active study circle');
  assertExactKeys(record, [
    'conversation_id',
    'week',
    'started_at',
    'study_circle_id',
    'type_id',
    'theme_id',
    'theme_name',
    'title',
    'host_character_id',
    'host_display_name',
    'venue',
    'situation',
    'prompt_tail_context',
    'condition_text',
    'reward_params'
  ], 'active routing study circle');
  return {
    conversation_id: requiredConversationId(record.conversation_id),
    week: assertElapsedWeeks(record.week),
    started_at: requiredString(record.started_at, 'active routing study circle started_at'),
    study_circle_id: requiredStudyCircleTypeId(record.study_circle_id, 'active routing study circle study_circle_id'),
    type_id: requiredStudyCircleTypeId(record.type_id, 'active routing study circle type_id'),
    theme_id: requiredString(record.theme_id, 'active routing study circle theme_id'),
    theme_name: requiredString(record.theme_name, 'active routing study circle theme_name'),
    title: requiredString(record.title, 'active routing study circle title'),
    host_character_id: requiredString(record.host_character_id, 'active routing study circle host_character_id'),
    host_display_name: requiredString(record.host_display_name, 'active routing study circle host_display_name'),
    venue: requiredString(record.venue, 'active routing study circle venue'),
    situation: validateSituation(record.situation, 'active routing study circle situation'),
    prompt_tail_context: requiredString(record.prompt_tail_context, 'active routing study circle prompt_tail_context'),
    condition_text: requiredString(record.condition_text, 'active routing study circle condition_text'),
    reward_params: validateRewardParams(record.reward_params, 'active routing study circle reward_params')
  };
}

export function readActiveRoutingStudyCircle(state) {
  requiredObject(state, 'runtime state is required to read active routing study circle');
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY)) return null;
  return validateActiveRoutingStudyCircle(state[ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY]);
}

// source_type marks this as a study circle record so the conversation record stamps the study circle 舞台
// (location_name / visible_situation) instead of the residual field location, and finalization reads it back.
// prompt_tail_context is a host-framed study circle statement: a framing block (framing + title + motivation)
// so the host knows they are running THIS study circle and drives the activity from their side, followed by a
// goal block that names the achievement condition (condition_text, verbatim third-person), forbids meta speech
// about it, and steers the conversation to actually reach that point in-scene (the host voices its own
// understanding/conclusion, the pair carries the moment through rather than deferring, and the protagonist is
// prompted for their own step). Injected every turn through the existing scene-context path. It uses only the
// title, motivation, and condition_text the active record already carries — no new record field.
export function buildRoutingStudyCircleSceneContext(activeStudyCircle) {
  const active = validateActiveRoutingStudyCircle(activeStudyCircle);
  return {
    source_type: STUDY_CIRCLE_SOURCE_TYPE,
    location_name: active.venue,
    visible_situation: active.situation,
    prompt_tail_context: [
      'あなたは今、この研究会を主催していて、目の前の主人公はその参加者である。この会話はその研究会の活動を一緒に進めるための場である。',
      `あなたが開いている研究会: ${active.title}`,
      `あなたがこの研究会を開く動機・事情: ${active.prompt_tail_context}`,
      'この研究会で何をする集まりなのかを、あなた自身が分かった上で、あなたの方から活動を進める。',
      `この研究会の目的が果たされたと言えるのは、次のことが会話の中で実際に起きたときである: ${active.condition_text}`,
      'ただし「達成条件」といった言葉やこの文面そのものは決して口に出さず、会話の内容として自然にそこへ向かう。',
      'この到達点には、あなた自身（主催者）の反応や言葉も含まれることがある。その場合は、あなた自身がその反応・納得・結論を、会話の自然な流れの中で自分から言葉にして示す。',
      'この到達点を先延ばしにしたり、下調べや段取りの相談だけで終わらせたりしない。会話の中で実際にその場面をやり切ることを目指し、主人公にも具体的な行動や答えを促し、頃合いを見てあなた自身の理解・納得・結論をはっきり言葉にして区切りをつける。',
      '特に、主人公自身が担う一歩（たとえば候補をひとつ選ぶ・指し示す・自分の答えや説明を口にする等）がまだ果たされていないなら、あなたの側だけで先に進めてしまわず、主人公にその一歩を具体的に問いかけ、主人公自身に決めさせてから次へ進む。',
      'ただし急いで結論へ運んだり主人公を質問攻めにしたりはせず、まず相手のやり取りを受け止めながら自然にそこへ近づける。'
    ].join('\n')
  };
}

// ----- completion (reward applied at conversation end from the persisted active record) -----

function emptyParameterDeltaMap() {
  return { magic: {}, abilities: {} };
}

// True when the { magic, abilities } delta map carries at least one grown parameter. The achievement
// invariant reads this: an achieved study circle applies its band reward (non-empty deltas), an unachieved
// exit applies nothing (empty deltas). The two must agree so an unachieved record can never carry a grant
// and an achieved one can never carry none.
function parameterDeltaMapHasEntries(map) {
  return EFFECT_GROUPS.some((group) => Object.keys(map[group] ?? {}).length > 0);
}

function applyRewardParamsToParameters(playerParameters, rewardParams) {
  const nextParameters = normalizeParameters(playerParameters);
  const parameterDeltas = emptyParameterDeltaMap();
  for (const reward of rewardParams) {
    parameterDefinition(reward);
    if (!Number.isInteger(reward.amount) || reward.amount <= 0) {
      throw new Error(`study circle reward amount must be a positive integer: ${reward.group}.${reward.key}`);
    }
    const current = nextParameters[reward.group]?.[reward.key];
    if (!current || typeof current !== 'object') throw new Error(`player parameter is missing: ${reward.group}.${reward.key}`);
    if (!Number.isInteger(current.value)) throw new Error(`player parameter value must be an integer: ${reward.group}.${reward.key}`);
    const before = current.value;
    const min = Number(current.min);
    const max = Number(current.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error(`player parameter bounds are invalid: ${reward.group}.${reward.key}`);
    }
    const after = before + reward.amount;
    if (after < min || after > max) {
      throw new Error(`cannot apply full study circle reward for ${reward.group}.${reward.key}: ${before} + ${reward.amount} exceeds ${min}..${max}`);
    }
    nextParameters[reward.group][reward.key] = { ...current, value: after };
    parameterDeltas[reward.group][reward.key] = reward.amount;
  }
  return { nextParameters: normalizeParameters(nextParameters), parameterDeltas };
}

function validateParameterDeltaMap(map, label) {
  requiredObject(map, `${label} must be a { magic, abilities } object`);
  assertExactKeys(map, EFFECT_GROUPS, label);
  for (const group of EFFECT_GROUPS) {
    if (!map[group] || typeof map[group] !== 'object' || Array.isArray(map[group])) {
      throw new Error(`${label}.${group} must be an object`);
    }
    for (const [key, value] of Object.entries(map[group])) {
      if (typeof key !== 'string' || !key) throw new Error(`${label}.${group} key must be non-empty`);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}.${group}.${key} must be a finite number`);
    }
  }
}

export function validateStudyCircleContentResult(record) {
  requiredObject(record, 'study circle content result');
  assertExactKeys(record, ['kind', 'destination_id', 'trigger', 'detail'], 'study circle content result');
  if (record.kind !== 'study_circle') throw new Error("study circle content result kind must be 'study_circle'");
  if (record.destination_id !== 'study_circle') throw new Error("study circle content result destination_id must be 'study_circle'");
  if (record.trigger !== STUDY_CIRCLE_TRIGGER) throw new Error(`study circle content result trigger must be '${STUDY_CIRCLE_TRIGGER}'`);
  const detail = requiredObject(record.detail, 'study circle content result detail');
  assertExactKeys(detail, ['outcome', 'achieved', 'theme_id', 'theme_name', 'host_character_id', 'host_display_name', 'parameter_deltas'], 'study circle content result detail');
  if (detail.outcome !== 'completed') throw new Error("study circle content result outcome must be 'completed'");
  if (typeof detail.achieved !== 'boolean') throw new Error('study circle content result requires a boolean achieved');
  requiredString(detail.theme_id, 'study circle content result theme_id');
  requiredString(detail.theme_name, 'study circle content result theme_name');
  requiredString(detail.host_character_id, 'study circle content result host_character_id');
  requiredString(detail.host_display_name, 'study circle content result host_display_name');
  validateParameterDeltaMap(detail.parameter_deltas, 'study circle content result parameter_deltas');
  // parameter_deltas is the reward actually applied: the band deltas when the achievement condition was met,
  // exactly none when the study circle was left unachieved. The two must agree so an unachieved record can
  // never carry a grant and an achieved one can never carry none.
  const hasDeltas = parameterDeltaMapHasEntries(detail.parameter_deltas);
  if (detail.achieved && !hasDeltas) throw new Error('study circle content result achieved requires non-empty parameter_deltas');
  if (!detail.achieved && hasDeltas) throw new Error('study circle content result unachieved requires empty parameter_deltas');
  return record;
}

export function buildStudyCircleContentResult({ activeStudyCircle, achieved, parameterDeltas }) {
  if (typeof achieved !== 'boolean') throw new Error('buildStudyCircleContentResult requires a boolean achieved');
  const active = validateActiveRoutingStudyCircle(activeStudyCircle);
  return validateStudyCircleContentResult({
    kind: 'study_circle',
    destination_id: 'study_circle',
    trigger: STUDY_CIRCLE_TRIGGER,
    detail: {
      outcome: 'completed',
      achieved,
      theme_id: active.theme_id,
      theme_name: active.theme_name,
      host_character_id: active.host_character_id,
      host_display_name: active.host_display_name,
      parameter_deltas: parameterDeltas
    }
  });
}

// Applies the persisted active study circle's reward at conversation end, CONDITIONAL on achievement.
// An achieved study circle (its condition met, auto-ended within a turn) applies the persisted reward_params
// — the single source of truth carried since the offer was generated, never re-derived or re-rolled, so the
// player gets exactly the reward the offer showed. An unachieved manual exit applies nothing: no parameter
// write, empty deltas, and the record is stamped achieved:false. The week is consumed by the end path
// regardless; only the reward is gated.
export async function applyStudyCircleCompletion({ root, activeStudyCircle, achieved, now = new Date().toISOString() } = {}) {
  if (!root) throw new Error('root is required');
  if (typeof achieved !== 'boolean') throw new Error('applyStudyCircleCompletion requires a boolean achieved');
  const active = validateActiveRoutingStudyCircle(activeStudyCircle);
  requiredString(now, 'now');
  if (!achieved) {
    return buildStudyCircleContentResult({
      activeStudyCircle: active,
      achieved: false,
      parameterDeltas: emptyParameterDeltaMap()
    });
  }
  const world = await loadWorldSettings({ root });
  const applied = applyRewardParamsToParameters(world.player_parameters, active.reward_params);
  const contentResult = buildStudyCircleContentResult({
    activeStudyCircle: active,
    achieved: true,
    parameterDeltas: applied.parameterDeltas
  });
  await updatePlayerParameters({ root, playerParameters: applied.nextParameters });
  return contentResult;
}
