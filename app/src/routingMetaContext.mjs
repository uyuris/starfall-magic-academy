import { GRADUATION_ENDING_WEEK } from './graduationEnding.mjs';
import { normalizeRoutingGraduationGuideContext } from './routingGraduationGuide.mjs';
import {
  abilityParameterDefinitions,
  magicParameterDefinitions,
  renderParameterScaleForPrompt
} from './parameters.mjs';
import { PLAY_MODES, validateRoutingPersonaVariant } from './playMode.mjs';
import { routingPersonaDisplayName } from './routingPersona.mjs';
import { GATED_ROUTING_DESTINATION_IDS, validateRoutingDestinations } from './routingDestinations.mjs';
import { routingDestinationsForState } from './routingDestinationSelection.mjs';
import { validateRoutingContentResult } from './routingContentResult.mjs';
import { TRAINING_ACTION_LIMIT, trainingDefinitions } from './training.mjs';
import { MAX_FLOORS } from './dungeon/dungeonEngine.mjs';
import { EQUIPMENT_KINDS, WEAPON_TYPES, EQUIPMENT_QUALITIES } from './equipment.mjs';

export const ROUTING_HUB_LOCATION_NAME = 'ルーティングハブ';
export const ROUTING_HUB_VISIBLE_SITUATION = '新しい一週間の始まりを告げ、プレイヤーと次の行き先を話して決める場所。';
// The source_type stamped on every routing hub conversation record (迎え / 週次会話). The hub is a
// metaphysical meta-surface, not a field session, so its records declare this instead of reusing 'field'.
export const ROUTING_HUB_SOURCE_TYPE = 'routing_hub';
// The source_type stamped on every dungeon companion conversation record (encounter opening + exploration
// turns). A dungeon session is not a field location: unlike the hub (whose scene is a fixed constant), the
// dungeon 舞台 is dynamic per run/floor, so the record additionally carries that floor's location_name /
// visible_situation and drops the field location_id / time_slot.
export const DUNGEON_SOURCE_TYPE = 'dungeon';
// The source_type stamped on every routing errand conversation record (依頼主との会話). Like the dungeon, an
// errand is not a field location and its 舞台 is per-errand dynamic, so the record carries the errand scene's
// location_name / visible_situation instead of the residual field location_id / time_slot.
export const ERRAND_SOURCE_TYPE = 'errand';
// The source_type stamped on every routing study circle conversation record (主催キャラとの会話). Same shape as
// errand: not a field location, per-study dynamic 舞台 carried on the record.
export const STUDY_CIRCLE_SOURCE_TYPE = 'study_circle';
// The source_type stamped on every homunculus atelier conversation record (錬成室のうちの子との会話). The atelier
// is not a field location; its 舞台 is a fixed authored scene supplied per conversation, so — like the other
// injected-scene sessions — the record carries location_name / visible_situation instead of location_id /
// time_slot.
export const HOMUNCULUS_SOURCE_TYPE = 'homunculus';
// The source_type stamped on every 談話室 group conversation record (3 NPC + プレイヤー のラウンド談話). Like the
// other injected-scene sessions the lounge is not a field location; its 舞台 is a per-conversation authored scene
// (location_name「寮の談話室」＋ week-seed 抽選の visible_situation), so — unlike the routing hub's fixed constant
// scene — the record carries location_name / visible_situation instead of location_id / time_slot.
export const LOUNGE_SOURCE_TYPE = 'lounge';
// The source_types whose 舞台 is injected per-conversation (dynamic per run / errand / study, the fixed
// atelier scene, or the authored lounge scene) and is therefore stamped onto the conversation record — as
// opposed to the routing hub (fixed constant scene) or a field session (location_id / time_slot). Records with
// these source_types omit location_id / time_slot and carry location_name / visible_situation;
// conversationFinalizationStageFields reads that scene back for the post-processing prompts.
export const INJECTED_SCENE_SOURCE_TYPES = Object.freeze(new Set([
  DUNGEON_SOURCE_TYPE,
  ERRAND_SOURCE_TYPE,
  STUDY_CIRCLE_SOURCE_TYPE,
  HOMUNCULUS_SOURCE_TYPE,
  LOUNGE_SOURCE_TYPE
]));
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;
const RECENT_CONVERSATION_CONTEXT_KINDS = Object.freeze([
  'no_new_conversation',
  'conversation_memory',
  'conversation_without_memory'
]);
const ROUTING_OPENING_SMALLTALK_COMMON_GUIDANCE = '行き先の確認・催促から入らない。世間話から入る。世間話がひと段落してから、主人公の様子に合わせて自然に次の行き先の話題へ移る。';

function assertRuntimeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('routing meta state must be an object');
  }
  const elapsedWeeks = Number(state.elapsed_weeks);
  if (!Number.isInteger(elapsedWeeks) || elapsedWeeks < 0) {
    throw new Error('routing meta state.elapsed_weeks must be a non-negative integer');
  }
  return elapsedWeeks;
}

function renderParameterMeaning(definition) {
  const label = String(definition.label ?? '').trim();
  const meaning = String(definition.prompt_meaning ?? '').trim();
  if (!label) throw new Error(`parameter label is required: ${definition.key ?? '(unknown)'}`);
  if (!meaning) throw new Error(`parameter prompt_meaning is required: ${definition.key ?? label}`);
  return `  - ${label}: ${meaning}`;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function normalizeNullableConversationId(value, label) {
  if (value === null) return null;
  const normalized = String(value ?? '').trim();
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`${label} must be null or a valid conversation id`);
  return normalized;
}

function normalizeRequiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireNull(value, label) {
  if (value !== null) throw new Error(`${label} must be null`);
  return null;
}

function normalizeNullableCharacterSummary(value, label) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object or null`);
  }
  return {
    character_id: normalizeRequiredString(value.character_id, `${label}.character_id`),
    display_name: normalizeRequiredString(value.display_name, `${label}.display_name`)
  };
}

function normalizeRecentConversationContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.recent_conversation_context must be an object');
  }
  for (const key of ['kind', 'conversation_id', 'character_id', 'character_name', 'memory_text']) {
    if (!hasOwn(value, key)) throw new Error(`routingHubContext.recent_conversation_context.${key} is required`);
  }
  const kind = normalizeRequiredString(value.kind, 'routingHubContext.recent_conversation_context.kind');
  if (!RECENT_CONVERSATION_CONTEXT_KINDS.includes(kind)) {
    throw new Error(`routingHubContext.recent_conversation_context.kind must be one of: ${RECENT_CONVERSATION_CONTEXT_KINDS.join(', ')}`);
  }
  const conversationId = normalizeNullableConversationId(
    value.conversation_id,
    'routingHubContext.recent_conversation_context.conversation_id'
  );
  if (kind === 'no_new_conversation') {
    return {
      kind,
      conversation_id: conversationId,
      character_id: requireNull(value.character_id, 'routingHubContext.recent_conversation_context.character_id'),
      character_name: requireNull(value.character_name, 'routingHubContext.recent_conversation_context.character_name'),
      memory_text: requireNull(value.memory_text, 'routingHubContext.recent_conversation_context.memory_text')
    };
  }
  if (!conversationId) throw new Error('routingHubContext.recent_conversation_context.conversation_id is required');
  return {
    kind,
    conversation_id: conversationId,
    character_id: normalizeRequiredString(value.character_id, 'routingHubContext.recent_conversation_context.character_id'),
    character_name: normalizeRequiredString(value.character_name, 'routingHubContext.recent_conversation_context.character_name'),
    memory_text: kind === 'conversation_memory'
      ? normalizeRequiredString(value.memory_text, 'routingHubContext.recent_conversation_context.memory_text')
      : requireNull(value.memory_text, 'routingHubContext.recent_conversation_context.memory_text')
  };
}

function normalizeRelationshipContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.relationship_context must be an object');
  }
  if (!Array.isArray(value.enemies)) throw new Error('routingHubContext.relationship_context.enemies must be an array');
  const enemies = value.enemies.map((enemy, index) => {
    const normalized = normalizeNullableCharacterSummary(
      enemy,
      `routingHubContext.relationship_context.enemies[${index}]`
    );
    if (normalized === null) throw new Error(`routingHubContext.relationship_context.enemies[${index}] must be an object`);
    return normalized;
  });
  return {
    buddy: normalizeNullableCharacterSummary(value.buddy, 'routingHubContext.relationship_context.buddy'),
    enemies
  };
}

function normalizeContentResultContext(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.content_result_context must be an object or null');
  }
  const record = validateRoutingContentResult(value.record);
  const companion = normalizeNullableCharacterSummary(
    value.companion,
    'routingHubContext.content_result_context.companion'
  );
  if (record.kind === 'dungeon' && record.detail.companion_character_id !== null) {
    if (!companion) throw new Error('routingHubContext.content_result_context.companion is required for a dungeon companion result');
    if (companion.character_id !== record.detail.companion_character_id) {
      throw new Error('routingHubContext.content_result_context.companion must match record.detail.companion_character_id');
    }
  }
  if (record.kind !== 'dungeon' && companion !== null) {
    throw new Error('routingHubContext.content_result_context.companion is only valid for dungeon results');
  }
  return { record, companion };
}

function normalizeAlchemyContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.alchemy_context must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'recipe_count') throw new Error(`routingHubContext.alchemy_context has unexpected key: ${key}`);
  }
  if (!hasOwn(value, 'recipe_count')) throw new Error('routingHubContext.alchemy_context.recipe_count is required');
  return {
    recipe_count: normalizePositiveInteger(value.recipe_count, 'routingHubContext.alchemy_context.recipe_count')
  };
}

// The 闘技会 hub context: the minimal, permanent-destination fact ルミ can speak to — the bracket size. It is
// optional (present only when the caller supplies it, like unlocked_gated_destination_ids), so a hub-context
// literal that predates the arena — or a fixture that omits it — simply renders no 闘技会 仕組み line, exactly
// as the alchemy / study circle lines render only when their context is present.
function normalizeArenaContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.arena_context must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'bracket_size') throw new Error(`routingHubContext.arena_context has unexpected key: ${key}`);
  }
  if (!hasOwn(value, 'bracket_size')) throw new Error('routingHubContext.arena_context.bracket_size is required');
  return {
    bracket_size: normalizePositiveInteger(value.bracket_size, 'routingHubContext.arena_context.bracket_size')
  };
}

function normalizeBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

// One pot's disclosed status. Before bloom only the stage and the planted seed item are known; the variety is
// hidden, so a variety_name present pre-reveal is a disclosure leak — reject it rather than pass it through.
function normalizeStarCradlePot(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const revealed = normalizeBoolean(value.revealed, `${label}.revealed`);
  const normalized = {
    stage: normalizeRequiredString(value.stage, `${label}.stage`),
    seed_item_name: normalizeRequiredString(value.seed_item_name, `${label}.seed_item_name`),
    revealed
  };
  if (revealed) {
    normalized.variety_name = normalizeRequiredString(value.variety_name, `${label}.variety_name`);
  } else if (hasOwn(value, 'variety_name')) {
    throw new Error(`${label}.variety_name must be absent before the plant blooms`);
  }
  return normalized;
}

// One creature's disclosed status. name is player-set (nullable, disclosed at any stage); the variety is hidden
// until hatch and the second-form mutation until adulthood, so each is rejected when present out of its disclosed
// stage. adult without revealed is an impossible stage and fails fast.
function normalizeStarCradleCreature(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const revealed = normalizeBoolean(value.revealed, `${label}.revealed`);
  const adult = normalizeBoolean(value.adult, `${label}.adult`);
  if (adult && !revealed) throw new Error(`${label}.adult requires revealed`);
  const normalized = {
    stage: normalizeRequiredString(value.stage, `${label}.stage`),
    seed_item_name: normalizeRequiredString(value.seed_item_name, `${label}.seed_item_name`),
    revealed,
    adult,
    name: value.name === null ? null : normalizeRequiredString(value.name, `${label}.name`)
  };
  if (revealed) {
    normalized.variety_name = normalizeRequiredString(value.variety_name, `${label}.variety_name`);
  } else if (hasOwn(value, 'variety_name')) {
    throw new Error(`${label}.variety_name must be absent before the egg hatches`);
  }
  if (adult) {
    normalized.mutation_name = value.mutation_name === null
      ? null
      : normalizeRequiredString(value.mutation_name, `${label}.mutation_name`);
  } else if (hasOwn(value, 'mutation_name')) {
    throw new Error(`${label}.mutation_name must be absent before the creature is an adult`);
  }
  return normalized;
}

// One caged (one-off item) creature: fully disclosed — a named-or-null resident and its revealed variety.
function normalizeStarCradleCaged(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return {
    name: value.name === null ? null : normalizeRequiredString(value.name, `${label}.name`),
    variety_name: normalizeRequiredString(value.variety_name, `${label}.variety_name`)
  };
}

// The 星の揺り籠 hub context: present-only passthrough (like arena_context) carrying the disclosed current state of
// the garden — growing pots, resident creatures, and caged items. Empty arrays are the honest "nothing growing";
// the renderer draws no line for them.
function normalizeStarCradleContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.star_cradle_context must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'pots' && key !== 'creatures' && key !== 'caged') {
      throw new Error(`routingHubContext.star_cradle_context has unexpected key: ${key}`);
    }
  }
  for (const key of ['pots', 'creatures', 'caged']) {
    if (!Array.isArray(value[key])) throw new Error(`routingHubContext.star_cradle_context.${key} must be an array`);
  }
  return {
    pots: value.pots.map((pot, index) => normalizeStarCradlePot(pot, `routingHubContext.star_cradle_context.pots[${index}]`)),
    creatures: value.creatures.map((creature, index) => normalizeStarCradleCreature(creature, `routingHubContext.star_cradle_context.creatures[${index}]`)),
    caged: value.caged.map((instance, index) => normalizeStarCradleCaged(instance, `routingHubContext.star_cradle_context.caged[${index}]`))
  };
}

function normalizeStudyCircleContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingHubContext.study_circle_context must be an object');
  }
  for (const key of ['theme_count', 'weekly_offer_count']) {
    if (!hasOwn(value, key)) throw new Error(`routingHubContext.study_circle_context.${key} is required`);
  }
  return {
    theme_count: normalizePositiveInteger(value.theme_count, 'routingHubContext.study_circle_context.theme_count'),
    weekly_offer_count: normalizePositiveInteger(value.weekly_offer_count, 'routingHubContext.study_circle_context.weekly_offer_count')
  };
}

// The gated destinations unlocked for this hub context. Optional and fail-closed: an absent field is the
// honest "nothing unlocked" (the required security semantic, not a compat mask), so a context literal that
// predates the gate — or a fixture that omits it — offers no gated destination. Every listed id must be a
// real gated destination; duplicates collapse.
function normalizeUnlockedGatedDestinationIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('routingHubContext.unlocked_gated_destination_ids must be an array');
  const seen = new Set();
  for (const id of value) {
    if (!GATED_ROUTING_DESTINATION_IDS.has(id)) {
      throw new Error(`routingHubContext.unlocked_gated_destination_ids contains a non-gated destination: ${id}`);
    }
    seen.add(id);
  }
  return [...seen];
}

export function normalizeRoutingHubContext(routingHubContext) {
  if (routingHubContext === undefined) return undefined;
  if (!routingHubContext || typeof routingHubContext !== 'object' || Array.isArray(routingHubContext)) {
    throw new Error('routingHubContext must be an object');
  }
  const normalized = {
    persona_variant: validateRoutingPersonaVariant(routingHubContext.persona_variant)
  };
  // Optional passthrough: present in the output only when the caller supplied it (the real hub snapshot
  // always does). A caller that omits it keeps the pre-gate shape unchanged, and every reader treats an
  // absent value as the fail-closed empty unlock set.
  if (hasOwn(routingHubContext, 'unlocked_gated_destination_ids')) {
    normalized.unlocked_gated_destination_ids = normalizeUnlockedGatedDestinationIds(routingHubContext.unlocked_gated_destination_ids);
  }
  // Optional passthrough: present in the output only when the caller supplied it (the real hub snapshot
  // always does). Absent keeps the pre-arena shape unchanged and renders no 闘技会 仕組み line.
  if (hasOwn(routingHubContext, 'arena_context')) {
    normalized.arena_context = normalizeArenaContext(routingHubContext.arena_context);
  }
  // Optional passthrough: present in the output only when the caller supplied it (the real hub snapshot always
  // does). Absent keeps the pre-cradle shape unchanged and renders no 星の揺り籠 line, so persisted hub
  // conversations started before this field keep continuing without a 409.
  if (hasOwn(routingHubContext, 'star_cradle_context')) {
    normalized.star_cradle_context = normalizeStarCradleContext(routingHubContext.star_cradle_context);
  }
  for (const key of ['recent_conversation_context', 'relationship_context', 'alchemy_context', 'study_circle_context', 'content_result_context']) {
    if (!hasOwn(routingHubContext, key)) throw new Error(`routingHubContext.${key} is required`);
  }
  normalized.recent_conversation_context = normalizeRecentConversationContext(routingHubContext.recent_conversation_context);
  normalized.relationship_context = normalizeRelationshipContext(routingHubContext.relationship_context);
  normalized.alchemy_context = normalizeAlchemyContext(routingHubContext.alchemy_context);
  normalized.study_circle_context = normalizeStudyCircleContext(routingHubContext.study_circle_context);
  normalized.content_result_context = normalizeContentResultContext(routingHubContext.content_result_context);
  return normalized;
}

function parameterLabel(group, key) {
  const definitions = group === 'magic' ? magicParameterDefinitions : abilityParameterDefinitions;
  const definition = definitions.find((item) => item.key === key);
  if (!definition?.label) throw new Error(`unknown parameter key in routing context: ${group}.${key}`);
  return definition.label;
}

function renderSignedAmount(amount) {
  return amount > 0 ? `+${amount}` : String(amount);
}

function renderParameterDeltaMap(map) {
  const parts = [];
  for (const group of ['magic', 'abilities']) {
    for (const [key, amount] of Object.entries(map[group])) {
      parts.push(`${parameterLabel(group, key)} ${renderSignedAmount(amount)}`);
    }
  }
  return parts.length ? parts.join('、') : '増減なし';
}

function renderRecentConversationContext(context, personaName) {
  if (!context) return [];
  if (context.kind === 'no_new_conversation') {
    return [`- 直近の行き先での会話: 新しい会話はなく、${personaName}が覗ける新しい記憶はない。`];
  }
  const head = `- 直近の行き先での会話: ${context.character_name}（${context.character_id}）との会話。`;
  if (context.kind === 'conversation_without_memory') {
    return [head, '  - その会話で新しい記憶は生まれていない。'];
  }
  return [head, `  - ${personaName}が覗ける一番新しい記憶: ${context.memory_text}`];
}

// Closed-vocabulary display labels for the workshop content result announcement.
// The keys mirror the frozen equipment vocabulary (imported above); a load-time
// coverage check pins each map to its canonical key set, so a future vocabulary
// addition fails fast here instead of rendering a silently mislabeled announcement.
const WORKSHOP_ELEMENT_LABELS = { light: '光', dark: '闇', fire: '火', water: '水', earth: '土', wind: '風' };
const WORKSHOP_KIND_LABELS = { weapon: '武器', amulet: '護符' };
const WORKSHOP_WEAPON_TYPE_LABELS = { sword: '剣', staff: '杖', short_rod: '短杖' };
const WORKSHOP_QUALITY_LABELS = { common: '並', fine: '良', excellent: '優', masterwork: '傑作' };

function assertWorkshopLabelsCover(labels, keys, what) {
  const labelKeys = Object.keys(labels).sort();
  const canonical = [...keys].sort();
  const matches = labelKeys.length === canonical.length && labelKeys.every((key, index) => key === canonical[index]);
  if (!matches) throw new Error(`workshop content result ${what} labels must cover exactly {${canonical.join(', ')}}: got {${labelKeys.join(', ')}}`);
}

assertWorkshopLabelsCover(WORKSHOP_ELEMENT_LABELS, magicParameterDefinitions.map((definition) => definition.key), 'element');
assertWorkshopLabelsCover(WORKSHOP_KIND_LABELS, EQUIPMENT_KINDS, 'kind');
assertWorkshopLabelsCover(WORKSHOP_WEAPON_TYPE_LABELS, WEAPON_TYPES, 'weapon_type');
assertWorkshopLabelsCover(WORKSHOP_QUALITY_LABELS, EQUIPMENT_QUALITIES, 'quality');

function workshopLabelFor(labels, key, what) {
  if (!Object.prototype.hasOwnProperty.call(labels, key)) throw new Error(`workshop content result ${what} is not a known value: ${key}`);
  return labels[key];
}

// Closed-vocabulary display labels for the 闘技会 content result announcement (mode + outcome).
const ARENA_MODE_LABELS = { solo: '一人出場', pair: '二人出場', spectate: 'バディー観戦' };
const ARENA_OUTCOME_LABELS = {
  champion: '優勝', eliminated: '敗退', spectated_champion: 'バディーが優勝', spectated_eliminated: 'バディーが敗退'
};

// Summarizes a finished craft's confirmed identity (kind/weapon_type, element, tier,
// quality) for the hub announcement. The item's own name is announced separately by
// the caller; flavor is intentionally omitted so the line names only the confirmed
// item identity, not its descriptive prose.
function renderWorkshopItemSummary(detail) {
  const kindLabel = detail.kind === 'weapon'
    ? `${workshopLabelFor(WORKSHOP_KIND_LABELS, 'weapon', 'kind')}（${workshopLabelFor(WORKSHOP_WEAPON_TYPE_LABELS, detail.weapon_type, 'weapon_type')}）`
    : workshopLabelFor(WORKSHOP_KIND_LABELS, detail.kind, 'kind');
  const elementLabel = workshopLabelFor(WORKSHOP_ELEMENT_LABELS, detail.element, 'element');
  const qualityLabel = workshopLabelFor(WORKSHOP_QUALITY_LABELS, detail.quality, 'quality');
  return `${kindLabel}・属性${elementLabel}・階級T${detail.tier}・出来栄え${qualityLabel}`;
}

function renderContentResultContext(context) {
  if (!context) return [];
  const { record } = context;
  if (record.kind === 'training') {
    const outcome = record.detail.outcome === 'skipped' ? 'スキップ' : '完了';
    const trainings = record.detail.trainings.length
      ? record.detail.trainings.map((entry) => `${entry.day_name}:${entry.training_name}`).join('、')
      : '実施なし';
    return [
      `- 直近コンテンツ結果: 鍛錬（${outcome}）。実施: ${trainings}。週の増減: ${renderParameterDeltaMap(record.detail.parameter_deltas)}。`
    ];
  }
  if (record.kind === 'errand') {
    const client = `${record.detail.client_display_name}（${record.detail.client_character_id}）`;
    return record.detail.achieved
      ? [`- 直近コンテンツ結果: 依頼（${record.detail.title}）を達成。依頼主: ${client}。報酬: ${record.detail.reward_money}。`]
      : [`- 直近コンテンツ結果: 依頼（${record.detail.title}）を達成できずに終了。依頼主: ${client}。報酬なし。`];
  }
  if (record.kind === 'alchemy') {
    return [
      `- 直近コンテンツ結果: 調合で「${record.detail.name}」（${alchemyCategoryLabel(record.detail.category)}）を${record.detail.quantity}つ仕上げた。`
    ];
  }
  if (record.kind === 'study_circle') {
    const host = `${record.detail.theme_name}・${record.detail.host_display_name}`;
    return record.detail.achieved
      ? [`- 直近コンテンツ結果: 研究会（${host}）を達成。成果: ${renderParameterDeltaMap(record.detail.parameter_deltas)}。`]
      : [`- 直近コンテンツ結果: 研究会（${host}）を達成できずに終了。成果なし。`];
  }
  if (record.kind === 'workshop') {
    return [
      `- 直近コンテンツ結果: 工房（${record.detail.name}）。仕上がり: ${renderWorkshopItemSummary(record.detail)}。`
    ];
  }
  if (record.kind === 'library') {
    const books = record.detail.books.map((book) => `『${book.title}』（${book.category}）`).join('、');
    return [
      `- 直近コンテンツ結果: 大書庫で読書。読んだ本: ${books}。`
    ];
  }
  if (record.kind === 'homunculus') {
    const child = `${record.detail.display_name}（${record.detail.homunculus_id}）`;
    if (record.detail.action === 'created') {
      return [`- 直近コンテンツ結果: 錬成室でホムンクルス${child}を錬成した。`];
    }
    if (record.detail.action === 'conversation') {
      return [`- 直近コンテンツ結果: 錬成室でホムンクルス${child}と言葉を交わした。`];
    }
    return [`- 直近コンテンツ結果: 錬成室でホムンクルス${child}と別れを告げた。銘: ${record.detail.epitaph}。`];
  }
  if (record.kind === 'arena') {
    const modeLabel = workshopLabelFor(ARENA_MODE_LABELS, record.detail.mode, 'mode');
    const outcomeLabel = workshopLabelFor(ARENA_OUTCOME_LABELS, record.detail.outcome, 'outcome');
    const materials = record.detail.materials.length
      ? record.detail.materials.map((material) => `${material.display_name}×${material.quantity}`).join('、')
      : 'なし';
    return [
      `- 直近コンテンツ結果: 闘技会（${modeLabel}・${outcomeLabel}）。${record.detail.wins}勝。賞金${record.detail.prize_money}G。獲得素材: ${materials}。`
    ];
  }
  if (record.kind === 'auction') {
    const lotLines = record.detail.lots.map((lot) => {
      if (lot.result === 'won_by_player') return `「${lot.item_name}」（${lot.band}帯）を${lot.price}Gで自分が落札`;
      if (lot.result === 'won_by_other') return `「${lot.item_name}」（${lot.band}帯）は${lot.winner_display_name}が${lot.price}Gで落札`;
      return `「${lot.item_name}」（${lot.band}帯）は流札`;
    });
    const won = record.detail.lots.filter((lot) => lot.result === 'won_by_player');
    const wonSummary = won.length
      ? `自分の落札品: ${won.map((lot) => `「${lot.item_name}」`).join('、')}`
      : '自分の落札品: なし';
    return [
      `- 直近コンテンツ結果: 競売場（全${record.detail.lots.length}ロット）。${lotLines.join('。')}。${wonSummary}。`
    ];
  }
  if (record.kind === 'lounge') {
    const names = record.detail.participants.map((participant) => participant.character_name).join('・');
    return [
      `- 直近コンテンツ結果: 談話室で${names}と車座になって語らった。`
    ];
  }
  if (record.kind === 'dungeon') {
    const outcomeLabels = {
      cleared: '踏破',
      retreated: '撤退',
      dead: '全滅'
    };
    const companionName = context.companion ? context.companion.display_name : 'なし';
    return [
      `- 直近コンテンツ結果: ダンジョン（${outcomeLabels[record.detail.outcome] ?? record.detail.outcome}）。到達階: ${record.detail.floor_reached}/${record.detail.max_floors}。確定獲得: ${renderParameterDeltaMap(record.detail.applied_gains)}。同行者: ${companionName}。`
    ];
  }
  // The record is already validated against the closed content-result vocabulary
  // upstream (validateRoutingContentResult), and every kind that reaches the hub
  // renderer has an explicit branch above. A kind with no branch here is a desync
  // (e.g. a content result that should have been gated out of the hub context but
  // was not), so fail fast instead of silently mis-rendering it as another kind.
  throw new Error(`routing content result render has no branch for kind: ${record.kind}`);
}

const ALCHEMY_CATEGORY_LABELS = Object.freeze({
  gift: '贈り物',
  ally_boost: '仲間強化薬',
  self_boost: '自分用強化薬',
  dungeon_consumable: 'ダンジョン消耗品',
  product: '換金品'
});

function alchemyCategoryLabel(category) {
  const label = ALCHEMY_CATEGORY_LABELS[category];
  if (!label) throw new Error(`unknown alchemy content result category: ${category}`);
  return label;
}

// The 星の揺り籠 current-status lines (1〜2 of them, or none for an empty garden): one line for what is growing,
// one for what sits caged. Present-tense and disclosure-safe — a pre-reveal individual is named only by its stage
// and seed item, a revealed one by its variety, an adult by its variety and (if it took one) its second form.
function renderStarCradleContext(context) {
  if (!context) return [];
  const growing = [];
  for (const pot of context.pots) {
    growing.push(pot.revealed ? `開花した鉢「${pot.variety_name}」` : `${pot.stage}の鉢（${pot.seed_item_name}）`);
  }
  for (const creature of context.creatures) {
    const named = creature.name ? `「${creature.name}」` : '';
    if (creature.adult) {
      const mutation = creature.mutation_name ? `・${creature.mutation_name}` : '';
      growing.push(`成体${named}（${creature.variety_name}${mutation}）`);
    } else if (creature.revealed) {
      growing.push(`幼体${named}（${creature.variety_name}）`);
    } else {
      growing.push(`${creature.stage}${named}（${creature.seed_item_name}）`);
    }
  }
  const caged = context.caged.map((instance) => (
    instance.name ? `「${instance.name}」（${instance.variety_name}）` : `名無し（${instance.variety_name}）`
  ));
  const lines = [];
  if (growing.length) lines.push(`- 星の揺り籠で育っているもの: ${growing.join('、')}。`);
  if (caged.length) lines.push(`- 星の揺り籠の籠入りの生き物: ${caged.join('、')}。`);
  return lines;
}

function renderRelationshipContext(context) {
  if (!context) return [];
  const buddy = context.buddy ? `${context.buddy.display_name}（${context.buddy.character_id}）` : 'なし';
  const enemies = context.enemies.length
    ? context.enemies.map((enemy) => `${enemy.display_name}（${enemy.character_id}）`).join('、')
    : 'なし';
  return [
    `- 現在の相棒: ${buddy}`,
    `- 現在のライバル: ${enemies}`
  ];
}

function contentResultTopicText(context) {
  const lines = renderContentResultContext(context);
  if (lines.length !== 1) throw new Error('routing opening smalltalk content result context is required');
  return lines[0].replace(/^- /, '');
}

export function buildRoutingOpeningSmalltalkGuidance(routingHubContext) {
  const normalizedRoutingHubContext = normalizeRoutingHubContext(routingHubContext);
  if (normalizedRoutingHubContext === undefined) {
    throw new Error('routingHubContext is required for routing opening smalltalk guidance');
  }
  const recent = normalizedRoutingHubContext.recent_conversation_context;
  let topicGuidance;
  if (recent.kind === 'conversation_memory') {
    topicGuidance = `直近会話で残った記憶「${recent.memory_text}」を話題の起点として、その話題から自然に世間話を切り出す。`;
  } else if (recent.kind === 'conversation_without_memory') {
    topicGuidance = `直近に${recent.character_name}（${recent.character_id}）との会話があった事実に軽く触れつつ、様子を伺う世間話から入る。新しい記憶は生まれていないため、記憶を捏造しない。`;
  } else if (recent.kind === 'no_new_conversation' && normalizedRoutingHubContext.content_result_context !== null) {
    topicGuidance = `${contentResultTopicText(normalizedRoutingHubContext.content_result_context)}を話題の起点として、自然に世間話を切り出す。`;
  } else if (recent.kind === 'no_new_conversation') {
    topicGuidance = '一般的な出迎えとして、体調・気分・近況を伺う世間話から入る。';
  } else {
    throw new Error(`routingHubContext.recent_conversation_context.kind must be one of: ${RECENT_CONVERSATION_CONTEXT_KINDS.join(', ')}`);
  }
  return [
    'ルーティングハブopening誘導:',
    `- 話題の起点: ${topicGuidance}`,
    `- 共通方針: ${ROUTING_OPENING_SMALLTALK_COMMON_GUIDANCE}`
  ].join('\n');
}

// The graduation guide framing (routing week-50 卒業ガイド). When present it replaces the "行き先を決める"
// framing with a top-priority "誰と学院生活を締めくくるかを決める" directive: Lumi names the top-N
// deeply-involved characters, presents herself (案内人自身) as an always-available choice, and draws out the
// player's choice without forcing it, while explicitly refusing to route to any normal destination. Absent =
// a normal hub turn, so non-guide turns render nothing extra and stay byte-equivalent. personaName is the
// effective variant's proper name (the guide-self option's shown name); it is required whenever the guide
// framing renders, so the presented options never disagree with the closed judgment set.
function renderRoutingGraduationGuideContext(normalizedGuideContext, personaName) {
  if (normalizedGuideContext === undefined) return [];
  if (typeof personaName !== 'string' || !personaName) {
    throw new Error('routing graduation guide framing requires the persona name');
  }
  return [
    '- 卒業ガイド【最優先・今週で唯一の目的】: 今は第50週、学院生活を締めくくる卒業の局面。もう次の行き先を決める週ではない。鍛錬・ダンジョン・依頼・調合・研究会・闘技会・錬成室・学院マップといった通常の行き先へは一切案内しない。誰と最後の時を過ごして学院生活を締めくくるかだけを、主人公と決める。',
    '  - 締めくくりの相手候補（この名前を会話の中で必ず挙げる）:',
    ...normalizedGuideContext.candidates.map((candidate) => `    - ${candidate.display_name}`),
    `    - ${personaName}（案内人自身。主人公が望めば案内人と締めくくることもできる）`,
    '  - この局面であることをはっきり伝え、上の候補を名前を挙げて示し、「誰と締めくくりたいか」を主人公に問いかけて選択を促す。主人公がまだ決めかねているうちは急かさず会話を続けるが、通常の行き先の話には戻さない。'
  ];
}

export function buildRoutingMetaContext({ state, routingHubContext, routingGraduationGuideContext } = {}) {
  const elapsedWeeks = assertRuntimeState(state);
  const weekNumber = elapsedWeeks + 1;
  const normalizedRoutingHubContext = normalizeRoutingHubContext(routingHubContext);
  const normalizedGuideContext = normalizeRoutingGraduationGuideContext(routingGraduationGuideContext);
  // The unlocked gated destinations (fail-closed: absent hub context or absent field offers none) drive the
  // same candidate set the destination-selection gate uses, so the catalog Lumi offers and the set she can
  // decide never disagree.
  const unlockedGatedDestinationIds = normalizedRoutingHubContext?.unlocked_gated_destination_ids ?? [];
  const normalizedDestinations = validateRoutingDestinations(
    routingDestinationsForState(state, unlockedGatedDestinationIds)
  );
  const atelierUnlocked = unlockedGatedDestinationIds.includes('homunculus');
  const parameterDefinitions = [...magicParameterDefinitions, ...abilityParameterDefinitions];
  const parameterScale = renderParameterScaleForPrompt();
  const alchemyContext = normalizedRoutingHubContext?.alchemy_context;
  const studyCircleContext = normalizedRoutingHubContext?.study_circle_context;
  const arenaContext = normalizedRoutingHubContext?.arena_context;
  // The current-status lines name the persona (the guide who "peeks" the memory), so they follow the
  // active variant's display name. It is only needed when a hub context is present (the lines render).
  const personaName = normalizedRoutingHubContext
    ? routingPersonaDisplayName(normalizedRoutingHubContext.persona_variant)
    : null;
  const currentContextLines = [
    ...renderRecentConversationContext(normalizedRoutingHubContext?.recent_conversation_context, personaName),
    ...renderContentResultContext(normalizedRoutingHubContext?.content_result_context),
    ...renderRelationshipContext(normalizedRoutingHubContext?.relationship_context),
    ...renderStarCradleContext(normalizedRoutingHubContext?.star_cradle_context)
  ];

  // The standing world-law facts every hub conversation carries — 迎え and every weekly turn alike. They name
  // the place (月の文字盤の空間), the persona's memory-peek reach, the load-not-save world rule, and the
  // mid-conversation-abort warning. The persona line follows the active variant's display name (personaName is
  // the resolved name, non-empty whenever a hub context is present), so it never leaves an unresolved token.
  const worldLawLines = personaName ? [
    '- 今会話しているこの場所は、その週の行き先を決めるための月の文字盤の空間',
    `- ${personaName}は主人公の一番新しい記憶だけを覗ける`,
    '- 「ロード機能」は世界線を変える機能で、「セーブ機能」はない。常に情報は更新され、過去の特定のタイミングに戻ってやり直す手段はない。',
    '- 会話の途中で不正に終了するとデータ破損・起動不能になる可能性がある'
  ] : [];

  // During a graduation guide turn the destination-selection gate is replaced by the partner-selection
  // judgment (spec C-03), so on week-50+ routing there is no destination path to take. The destination catalog
  // would then be a pure decoy that pulls the guide toward a normal branch, so it is not rendered on guide
  // turns. A normal (guide-absent) hub turn renders it exactly as before (byte-equivalent).
  const destinationCatalogLines = [
    '- 行き先:',
    ...normalizedDestinations.map((destination) => `  - ${destination.label}: ${destination.description}`),
    '- 行き先の仕組み:',
    `  - 鍛錬: ${trainingDefinitions.length}種の鍛錬から選び、週${TRAINING_ACTION_LIMIT}回の行動で一週間の鍛錬を進める。`,
    `  - ダンジョン: 最大${MAX_FLOORS}層の探索と戦闘を行い、終了時に確定した獲得分だけを持ち帰る。`,
    '  - 依頼: 学院内外の小さな頼まれごとを1件引き受け、依頼主との会話を経て、終了時に固定の所持金報酬を受け取る。',
    ...(alchemyContext ? [
      `  - 調合: 常設の全${alchemyContext.recipe_count}種のレシピブックから、素材と所持金を支払えるものを滞在中に何度でも調合し、贈り物・仲間強化薬・自分用強化薬・ダンジョン消耗品・換金品のいずれかのアイテムを得る。`
    ] : []),
    ...(studyCircleContext ? [
      `  - 研究会: 全${studyCircleContext.theme_count}種のテーマから週${studyCircleContext.weekly_offer_count}件のオファーを見て、主催キャラクターとの会話後に対応する鍛錬単位のパラメーター上昇を得る。`
    ] : []),
    ...(arenaContext ? [
      `  - 闘技会: 週替わりの${arenaContext.bracket_size}枠シングルエリミネーショントーナメントに、一人・二人（主人公＋バディー）・バディー観戦のいずれかで出場する。実戦の戦闘で勝ち抜いた数に応じて賞金とダンジョン素材を得る。`
    ] : []),
    ...(atelierUnlocked ? [
      '  - 錬成室: 重い素材と大金を注いで自分だけのホムンクルスを錬成する。同時に持てるのは3体まで。生まれた子は錬成室に住み、会いに行って言葉を交わせる。'
    ] : []),
    '  - 学院マップ: 学院内の場所を選び、キャラクターとの会話やフィールド探索に入る。'
  ];

  return [
    'ルーティング会話メタ情報:',
    `- モード: ${PLAY_MODES.join('/')}。loop は現行の固定サイクルをそのまま回し、routing はこの会話ハブで次の行き先を決める。`,
    `- 週進行: 現在は第${weekNumber}週。routing では行き先が確定した時点で即1週進む（各行き先の説明で週を進めないと明記されたものを除く）。`,
    `- 卒業: ${GRADUATION_ENDING_WEEK}週で卒業エンディングが発火する。現在の経過週は${elapsedWeeks}週。`,
    ...worldLawLines,
    ...renderRoutingGraduationGuideContext(normalizedGuideContext, personaName),
    ...(normalizedGuideContext === undefined ? destinationCatalogLines : []),
    ...(currentContextLines.length ? [`- ${personaName}が参照できる現在状況:`, ...currentContextLines] : []),
    '- パラメーター仕様:',
    `  - 全${parameterDefinitions.length}項目。数値範囲は${parameterScale}で、大きいほどその能力が高い。`,
    '  - 魔法習熟度:',
    ...magicParameterDefinitions.map(renderParameterMeaning),
    '  - 基礎能力:',
    ...abilityParameterDefinitions.map(renderParameterMeaning)
  ].join('\n');
}

export function buildRoutingPromptSceneFields({ state, routingHubContext, routingGraduationGuideContext }) {
  return {
    location_name: ROUTING_HUB_LOCATION_NAME,
    visible_situation: ROUTING_HUB_VISIBLE_SITUATION,
    prompt_tail_context: buildRoutingMetaContext({ state, routingHubContext, routingGraduationGuideContext })
  };
}

// The stage descriptor embedded in every conversation-finalization / post-processing prompt (memory,
// skill, work_record, money, affinity, stage/event-flag judgments), so the generating model writes for the
// correct 舞台. Three shapes:
// - routing hub: not a field location. The record carries source_type 'routing_hub' and the canonical hub
//   scene (the same location_name + visible_situation constants the live hub prompt uses, so stage never
//   drifts) in place of a field location_id / time_slot.
// - injected-scene sessions (dungeon / errand / study circle): not field locations either, and their 舞台 is
//   dynamic per session, so the record itself carries that session's location_name / visible_situation (stamped
//   at record time from the injected scene); this reads them straight back. A record of one of these
//   source_types missing that scene is a defect — fail fast, do not degrade.
// - everything else (field / event / new_game / graduation_ending / ...): a field-anchored session carries its
//   location_id / time_slot exactly as before, so those records render byte-for-byte unchanged.
// The field location_id / time_slot are legitimately absent for hub / injected-scene records —「該当しない」, the
// same "absent = not this kind" schema meaning materials use for element/tier.
export function conversationFinalizationStageFields(conversation) {
  if (conversation.source_type === ROUTING_HUB_SOURCE_TYPE) {
    return {
      source_type: ROUTING_HUB_SOURCE_TYPE,
      location_name: ROUTING_HUB_LOCATION_NAME,
      visible_situation: ROUTING_HUB_VISIBLE_SITUATION
    };
  }
  if (INJECTED_SCENE_SOURCE_TYPES.has(conversation.source_type)) {
    if (typeof conversation.location_name !== 'string' || !conversation.location_name.trim()) {
      throw new Error(`${conversation.source_type} conversation record must carry a non-empty location_name for finalization`);
    }
    if (typeof conversation.visible_situation !== 'string') {
      throw new Error(`${conversation.source_type} conversation record must carry a visible_situation string for finalization`);
    }
    return {
      source_type: conversation.source_type,
      location_name: conversation.location_name,
      visible_situation: conversation.visible_situation
    };
  }
  return {
    source_type: conversation.source_type,
    location_id: conversation.location_id,
    time_slot: conversation.time_slot
  };
}
