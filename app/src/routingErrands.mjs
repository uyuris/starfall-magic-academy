import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { ERRAND_SOURCE_TYPE } from './routingMetaContext.mjs';

export const ROUTING_ACTIVE_ERRAND_STATE_KEY = 'routing_active_errand';
export const ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY = 'routing_weekly_errand_offers';

const ERRAND_TYPES_PATH = 'data/definitions/errand_types.json';
const ERRAND_ID_PATTERN = /^[a-z0-9_-]+$/;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;
const BANNED_SITUATION_PATTERN = /誰|持ち主|気配|らしい|溜め息|温もり|温み|余韻|余熱|名残|見当たらない|立ち去|席を外|願かけ/u;

// The catalog's closed vocabularies. The reward bands are keyed small/medium/large
// (小/中/大); the categories are the six authored errand-type groups. Both are pinned
// here so a stray band reference or category slug in the data fails the loader fast.
export const ERRAND_REWARD_BAND_KEYS = Object.freeze(['small', 'medium', 'large']);
export const ERRAND_CATEGORY_KEYS = Object.freeze(['study', 'training', 'craft', 'life', 'campus', 'quirk']);
export const ERRAND_TYPE_COUNT = 205;

function requiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function requiredErrandId(value, label = 'errand id') {
  const normalized = requiredString(value, label);
  if (!ERRAND_ID_PATTERN.test(normalized)) throw new Error(`${label} must match ${ERRAND_ID_PATTERN}`);
  return normalized;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validConversationId(value, label = 'conversation_id') {
  const normalized = requiredString(value, label);
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`${label} must be a valid conversation id`);
  return normalized;
}

function validateSituation(value, label) {
  const normalized = requiredString(value, label);
  if (BANNED_SITUATION_PATTERN.test(normalized)) {
    throw new Error(`${label} contains non-scene wording`);
  }
  return normalized;
}

// ----- errand type catalog -----

function validateRewardBand(band, label) {
  if (!band || typeof band !== 'object' || Array.isArray(band)) throw new Error(`${label} must be an object`);
  const min = band.min;
  const max = band.max;
  if (!Number.isInteger(min) || min <= 0) throw new Error(`${label}.min must be a positive integer`);
  if (!Number.isInteger(max) || max <= 0) throw new Error(`${label}.max must be a positive integer`);
  if (min > max) throw new Error(`${label}.min must not exceed ${label}.max`);
  return { min, max };
}

function validateRewardBands(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('errand reward_bands must be an object');
  const keys = Object.keys(value).sort();
  const expected = [...ERRAND_REWARD_BAND_KEYS].sort();
  const matches = keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`errand reward_bands keys must be exactly {${expected.join(', ')}}: got {${keys.join(', ')}}`);
  const bands = {};
  for (const key of ERRAND_REWARD_BAND_KEYS) bands[key] = validateRewardBand(value[key], `errand reward_bands.${key}`);
  // Bands must be strictly ordered and non-overlapping: small < medium < large.
  if (bands.small.max >= bands.medium.min) throw new Error('errand reward_bands small must end below medium');
  if (bands.medium.max >= bands.large.min) throw new Error('errand reward_bands medium must end below large');
  return bands;
}

function validateErrandType(entry, index, { bands }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`errand type[${index}] must be an object`);
  }
  const category = requiredString(entry.category, `errand type[${index}].category`);
  if (!ERRAND_CATEGORY_KEYS.includes(category)) {
    throw new Error(`errand type[${index}].category must be one of {${ERRAND_CATEGORY_KEYS.join(', ')}}: got ${category}`);
  }
  const rewardBand = requiredString(entry.reward_band, `errand type[${index}].reward_band`);
  if (!Object.prototype.hasOwnProperty.call(bands, rewardBand)) {
    throw new Error(`errand type[${index}].reward_band must be a known band: ${rewardBand}`);
  }
  return {
    id: requiredErrandId(entry.id, `errand type[${index}].id`),
    category,
    name: requiredString(entry.name, `errand type[${index}].name`),
    reward_band: rewardBand,
    condition_text: requiredString(entry.condition_text, `errand type[${index}].condition_text`)
  };
}

export function validateErrandTypeCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('errand type catalog must be an object');
  const bands = validateRewardBands(value.reward_bands);
  if (!Array.isArray(value.types)) throw new Error('errand type catalog types must be an array');
  if (value.types.length !== ERRAND_TYPE_COUNT) {
    throw new Error(`errand type catalog must contain exactly ${ERRAND_TYPE_COUNT} types: got ${value.types.length}`);
  }
  const seen = new Set();
  const types = value.types.map((entry, index) => {
    const type = validateErrandType(entry, index, { bands });
    if (seen.has(type.id)) throw new Error(`errand type id must be unique: ${type.id}`);
    seen.add(type.id);
    return type;
  });
  return { reward_bands: bands, types };
}

export async function loadErrandTypeCatalog({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const catalogPath = path.join(storage.paths.resourceRoot, ERRAND_TYPES_PATH);
  let raw;
  try {
    raw = await fs.readFile(catalogPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`errand type catalog file is missing: ${catalogPath}`);
    throw error;
  }
  return validateErrandTypeCatalog(JSON.parse(raw));
}

// ----- deterministic weekly skeleton draw -----

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function weekFromState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('runtime state is required');
  return nonNegativeInteger(state.elapsed_weeks, 'runtime_state.elapsed_weeks');
}

function validateOfferCharacter(character, index) {
  if (!character || typeof character !== 'object' || Array.isArray(character)) {
    throw new Error(`selectable character[${index}] must be an object`);
  }
  return {
    character_id: requiredString(character.character_id, `selectable character[${index}].character_id`),
    display_name: requiredString(character.display_name, `selectable character[${index}].display_name`)
  };
}

function rotatedDeterministicItems(items, { week, namespace, idFor }) {
  const ordered = [...items].sort((a, b) => {
    const scoreA = stableHash(`${namespace}:${idFor(a)}`);
    const scoreB = stableHash(`${namespace}:${idFor(b)}`);
    return scoreA - scoreB || String(idFor(a)).localeCompare(String(idFor(b)));
  });
  const start = week % ordered.length;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

// Deterministic reward for a type this week: an integer inside the type's band,
// seeded by (type id, week). Same (type, week) always yields the same amount.
export function errandRewardMoney({ band, week, typeId }) {
  const { min, max } = band;
  const span = max - min + 1;
  return min + (stableHash(`routing-errand-reward:${typeId}:${nonNegativeInteger(week, 'week')}`) % span);
}

// Draws the deterministic skeleton for the week: three distinct types, a band-bounded
// reward per offer, and a unique selectable client per offer. No LLM, no prose — this
// is the economy-bearing part the design keeps out of the model's hands. Returns
// { week, skeletons: [{ type_id, category, name, reward_band, condition_text, reward_money, client_character_id }] }.
export function drawWeeklyErrandSkeletons({ state, catalog, characters }) {
  const week = weekFromState(state);
  const { reward_bands: bands, types } = validateErrandTypeCatalog(catalog);
  if (!Array.isArray(characters)) throw new Error('selectable characters must be an array');
  const normalizedCharacters = characters.map(validateOfferCharacter);
  if (normalizedCharacters.length < 3) throw new Error('at least three selectable characters are required for errand offers');

  const selectedTypes = rotatedDeterministicItems(types, {
    week,
    namespace: 'routing-errand-type',
    idFor: (type) => type.id
  }).slice(0, 3);

  const usedCharacterIds = new Set();
  const skeletons = selectedTypes.map((type, index) => {
    const characterOrder = rotatedDeterministicItems(normalizedCharacters, {
      week: week + index * 17 + stableHash(type.id),
      namespace: `routing-errand-client:${type.id}`,
      idFor: (character) => character.character_id
    });
    const client = characterOrder.find((character) => !usedCharacterIds.has(character.character_id));
    if (!client) throw new Error('unable to assign unique errand clients');
    usedCharacterIds.add(client.character_id);
    return {
      type_id: type.id,
      category: type.category,
      name: type.name,
      reward_band: type.reward_band,
      condition_text: type.condition_text,
      reward_money: errandRewardMoney({ band: bands[type.reward_band], week, typeId: type.id }),
      client_character_id: client.character_id
    };
  });

  return { week, skeletons };
}

// ----- persisted weekly offers (runtime_state slot) -----

function validatePersistedErrandOffer(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`weekly errand offer[${index}] must be an object`);
  }
  return {
    errand_id: requiredErrandId(value.errand_id, `weekly errand offer[${index}].errand_id`),
    type_id: requiredErrandId(value.type_id, `weekly errand offer[${index}].type_id`),
    title: requiredString(value.title, `weekly errand offer[${index}].title`),
    situation: validateSituation(value.situation, `weekly errand offer[${index}].situation`),
    motivation: requiredString(value.motivation, `weekly errand offer[${index}].motivation`),
    // appeal (依頼主当人の語り) is required: an old-form persisted offer without it fails fast
    // here — there is no compat read / migration / default fill (the week regenerates on advance).
    appeal: requiredString(value.appeal, `weekly errand offer[${index}].appeal`),
    condition_text: requiredString(value.condition_text, `weekly errand offer[${index}].condition_text`),
    reward_money: positiveInteger(value.reward_money, `weekly errand offer[${index}].reward_money`),
    client_character_id: requiredString(value.client_character_id, `weekly errand offer[${index}].client_character_id`)
  };
}

export function validateWeeklyErrandOffers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routing weekly errand offers must be an object');
  }
  if (!Array.isArray(value.offers)) throw new Error('routing weekly errand offers.offers must be an array');
  if (value.offers.length !== 3) throw new Error('routing weekly errand offers must contain exactly three offers');
  const week = nonNegativeInteger(value.week, 'routing weekly errand offers week');
  const seenErrandIds = new Set();
  const offers = value.offers.map((offer, index) => {
    const normalized = validatePersistedErrandOffer(offer, index);
    if (seenErrandIds.has(normalized.errand_id)) {
      throw new Error(`weekly errand offer errand_id must be unique: ${normalized.errand_id}`);
    }
    seenErrandIds.add(normalized.errand_id);
    return normalized;
  });
  return { week, offers };
}

export function readWeeklyErrandOffers(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the weekly errand offers');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY)) return null;
  return validateWeeklyErrandOffers(state[ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY]);
}

export function findPersistedErrandOffer({ offers, errandId }) {
  const normalizedErrandId = requiredErrandId(errandId);
  const offer = offers?.offers?.find((candidate) => candidate.errand_id === normalizedErrandId) ?? null;
  if (!offer) {
    const error = new Error(`errand is not offered this week: ${normalizedErrandId}`);
    error.statusCode = 400;
    error.errorCode = 'ERRAND_NOT_OFFERED';
    throw error;
  }
  return validatePersistedErrandOffer(offer, 0);
}

// The public offer is the client-facing subset. The motivation and the achievement condition
// (`condition_text`) stay internal: the motivation is the scene-injection tail, and the condition
// is the authored judgment value the achievement check uses — neither is display text and neither
// is shown to the player. The appeal (依頼主当人の語り) is the card's主表示; situation stays public
// because the daytime scene detail popup (依頼の現場) reads it as its pure-scene description — the
// offer card itself renders neither situation nor a condition.
export function toPublicErrandOffer(offer, clientDisplayName) {
  const normalized = validatePersistedErrandOffer(offer, 0);
  return {
    errand_id: normalized.errand_id,
    type_id: normalized.type_id,
    title: normalized.title,
    situation: normalized.situation,
    appeal: normalized.appeal,
    reward_money: normalized.reward_money,
    client_character_id: normalized.client_character_id,
    client_display_name: requiredString(clientDisplayName, 'client_display_name')
  };
}

// ----- active errand (opened conversation) -----

export function makeErrandConversationId({ now, week, errandId, clientCharacterId }) {
  const stamp = requiredString(now, 'now').replace(/[^0-9A-Za-z]/g, '');
  const normalizedErrandId = requiredErrandId(errandId);
  const normalizedClientId = requiredString(clientCharacterId, 'client_character_id').replace(/[^0-9A-Za-z_-]/g, '_');
  return validConversationId(`conv_errand_${nonNegativeInteger(week, 'week')}_${normalizedErrandId}_${normalizedClientId}_${stamp}`);
}

// Builds the active errand from a persisted weekly offer. The generated motivation
// becomes prompt_tail_context so the scene-context injection contract is unchanged;
// type_id and condition_text ride along for the (later) achievement judgment.
export function buildActiveRoutingErrand({
  offer,
  clientDisplayName,
  conversationId,
  week,
  startedAt
}) {
  const normalizedOffer = validatePersistedErrandOffer(offer, 0);
  return validateActiveRoutingErrand({
    errand_id: normalizedOffer.errand_id,
    type_id: normalizedOffer.type_id,
    title: normalizedOffer.title,
    situation: normalizedOffer.situation,
    prompt_tail_context: normalizedOffer.motivation,
    condition_text: normalizedOffer.condition_text,
    reward_money: normalizedOffer.reward_money,
    client_character_id: normalizedOffer.client_character_id,
    client_display_name: requiredString(clientDisplayName, 'client_display_name'),
    conversation_id: validConversationId(conversationId),
    week: nonNegativeInteger(week, 'week'),
    started_at: requiredString(startedAt, 'started_at')
  });
}

export function validateActiveRoutingErrand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routing active errand must be an object');
  }
  return {
    errand_id: requiredErrandId(value.errand_id, 'routing active errand errand_id'),
    type_id: requiredErrandId(value.type_id, 'routing active errand type_id'),
    title: requiredString(value.title, 'routing active errand title'),
    situation: validateSituation(value.situation, 'routing active errand situation'),
    prompt_tail_context: requiredString(value.prompt_tail_context, 'routing active errand prompt_tail_context'),
    condition_text: requiredString(value.condition_text, 'routing active errand condition_text'),
    reward_money: positiveInteger(value.reward_money, 'routing active errand reward_money'),
    client_character_id: requiredString(value.client_character_id, 'routing active errand client_character_id'),
    client_display_name: requiredString(value.client_display_name, 'routing active errand client_display_name'),
    conversation_id: validConversationId(value.conversation_id, 'routing active errand conversation_id'),
    week: nonNegativeInteger(value.week, 'routing active errand week'),
    started_at: requiredString(value.started_at, 'routing active errand started_at')
  };
}

export function readActiveRoutingErrand(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to read the active routing errand');
  }
  if (!Object.prototype.hasOwnProperty.call(state, ROUTING_ACTIVE_ERRAND_STATE_KEY)) return null;
  const value = state[ROUTING_ACTIVE_ERRAND_STATE_KEY];
  return validateActiveRoutingErrand(value);
}

// source_type marks this as an errand record so the conversation record stamps the errand 舞台
// (location_name / visible_situation) instead of the residual field location, and finalization reads it back.
//
// The prompt_tail_context is an errand statement: a framing block (framing + title + motivation)
// so the client knows it is the one presenting an errand and speaks the specific request from its
// own side (without the framing, terse or soft-request personas read the motivation as a passive
// "current situation" and open reactively without ever issuing the request — measured), followed
// by a goal block that names the achievement condition (condition_text, verbatim third-person),
// forbids meta speech about it, and steers the conversation to actually reach that point in-scene
// (the NPC voices its own understanding/conclusion, the pair carries the moment through rather than
// deferring, and the protagonist is prompted for their own step). This reuses the existing
// scene-context injection path (prompt_tail_context → 追加の現在状況); it does not add a new injection
// route, and it uses only fields the active errand already carries (title + motivation +
// condition_text), so the active record shape is unchanged. The appeal stays presentation-only and
// is never injected here.
export function buildRoutingErrandSceneContext(activeErrand) {
  const errand = validateActiveRoutingErrand(activeErrand);
  return {
    source_type: ERRAND_SOURCE_TYPE,
    location_name: '依頼の現場',
    visible_situation: errand.situation,
    prompt_tail_context: [
      'あなたは今、目の前の主人公にひとつの依頼を持ちかけている。この会話はその依頼を相談して進めるための場である。',
      `あなたが持ちかけている依頼: ${errand.title}`,
      `あなたがこの依頼を持ちかける事情: ${errand.prompt_tail_context}`,
      'この依頼で主人公に何をしてほしいのかを、あなた自身が分かった上で、あなたの方から話を切り出す。',
      `この依頼が果たされたと言えるのは、次のことが会話の中で実際に起きたときである: ${errand.condition_text}`,
      'ただし「達成条件」といった言葉やこの文面そのものは決して口に出さず、会話の内容として自然にそこへ向かう。',
      'この到達点には、あなた自身（依頼主）の反応や言葉も含まれることがある。その場合は、あなた自身がその反応・納得・結論を、会話の自然な流れの中で自分から言葉にして示す。',
      'この到達点を先延ばしにしたり、下調べや段取りの相談だけで終わらせたりしない。会話の中で実際にその場面をやり切ることを目指し、主人公にも具体的な行動や答えを促し、頃合いを見てあなた自身の理解・納得・結論をはっきり言葉にして区切りをつける。',
      '特に、主人公自身が担う一歩（たとえば候補をひとつ選ぶ・指し示す・自分の答えや説明を口にする等）がまだ果たされていないなら、あなたの側だけで先に進めてしまわず、主人公にその一歩を具体的に問いかけ、主人公自身に決めさせてから次へ進む。',
      'ただし急いで結論へ運んだり主人公を質問攻めにしたりはせず、まず相手のやり取りを受け止めながら自然にそこへ近づける。'
    ].join('\n')
  };
}
