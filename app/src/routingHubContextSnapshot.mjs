import { ensureSelectableCharacterStorage } from './characterCatalog.mjs';
import { isHomunculusIdFormat } from './companionRoster.mjs';
import { resolveActiveHomunculusActor } from './buddyResolution.mjs';
import { latestAppliedRoutingWeekProgression } from './graduationEnding.mjs';
import { loadAlchemyDefinitions } from './alchemyDefinitions.mjs';
import { loadStudyCircleDefinitions } from './studyCircleDefinitions.mjs';
import { STUDY_CIRCLE_WEEKLY_OFFER_COUNT } from './routingStudyCircle.mjs';
import { ARENA_BRACKET_UNIT_COUNT } from './arena/arenaTournament.mjs';
import { normalizeRoutingHubContext } from './routingMetaContext.mjs';
import { readRoutingContentResult, requireRoutingContentWeek } from './routingContentResult.mjs';
import { loadStarCradleCatalog } from './starCradleCatalog.mjs';
import { buildStarCradleView } from './starCradleOperations.mjs';
import { unlockedGatedDestinationIdsForParameters } from './homunculusUnlock.mjs';
import { createStorageApi } from './storage.mjs';

const PLAYER_PARAMETERS_PATH = 'game_data/runtime/player_parameters.json';

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

function storageFor(root) {
  return createStorageApi({ root });
}

function normalizeConversationId(value, label) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`${label} must be a valid conversation id`);
  return normalized;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

async function selectableCharacterSummary({ root, authoringRoot, characterId }) {
  const normalizedCharacterId = requireNonEmptyString(characterId, 'character id');
  const { profile } = await ensureSelectableCharacterStorage({
    root,
    authoringRoot,
    characterId: normalizedCharacterId
  });
  return {
    character_id: normalizedCharacterId,
    display_name: requireNonEmptyString(profile.display_name, `${normalizedCharacterId} display_name`)
  };
}

async function readConversationStrict({ storage, conversationId }) {
  const conversation = await storage.readJsonIfExists(`game_data/logs/conversations/${conversationId}.json`);
  if (!conversation) throw new Error(`last conversation log is missing: ${conversationId}`);
  return conversation;
}

async function buildRecentConversationContext({ storage, state }) {
  const conversationId = normalizeConversationId(state.last_conversation_id, 'runtime_state.last_conversation_id');
  if (!conversationId) {
    return {
      kind: 'no_new_conversation',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    };
  }

  const conversation = await readConversationStrict({ storage, conversationId });
  if (Object.prototype.hasOwnProperty.call(conversation, 'routing_hub')) {
    return {
      kind: 'no_new_conversation',
      conversation_id: conversationId,
      character_id: null,
      character_name: null,
      memory_text: null
    };
  }

  const characterId = requireNonEmptyString(conversation.character_id, `conversation ${conversationId} character_id`);
  const characterName = requireNonEmptyString(conversation.character_name, `conversation ${conversationId} character_name`);
  const validator = await storage.readJsonIfExists(`game_data/logs/validator/${conversationId}.json`);
  if (!validator) {
    // No validator log. Finalization writes the validator unconditionally, then an explicit finalization
    // marker, so the two absences are told apart by that marker: no marker → an opening that was started but
    // never finalized (a legitimate runtime state — the conversation happened but produced no memory), a
    // present marker → a finalized conversation whose validator log was lost (corrupt → fail-fast).
    const finalizationMarker = await storage.readJsonIfExists(`game_data/logs/finalization/${conversationId}.json`);
    if (finalizationMarker) {
      throw new Error(`validator log is missing for finalized conversation: ${conversationId}`);
    }
    return {
      kind: 'conversation_without_memory',
      conversation_id: conversationId,
      character_id: characterId,
      character_name: characterName,
      memory_text: null
    };
  }
  if (!Array.isArray(validator.accepted_memory)) {
    throw new Error(`validator accepted_memory must be an array for conversation: ${conversationId}`);
  }
  if (validator.accepted_memory.length === 0) {
    return {
      kind: 'conversation_without_memory',
      conversation_id: conversationId,
      character_id: characterId,
      character_name: characterName,
      memory_text: null
    };
  }
  const memoryText = requireNonEmptyString(
    validator.accepted_memory[0]?.text,
    `validator accepted_memory[0].text for conversation ${conversationId}`
  );
  return {
    kind: 'conversation_memory',
    conversation_id: conversationId,
    character_id: characterId,
    character_name: characterName,
    memory_text: memoryText
  };
}

// Resolves the current buddy id to its `{ character_id, display_name }` prompt summary across both rosters:
// a selectable character via the roster, an ACTIVE homunculus via its surface active entry. A homunculus
// buddy id that is not active is corrupt/dangling state and throws (the same severity as an unknown
// selectable id), so the hub start fails fast rather than rendering a stale buddy.
async function resolveBuddySummary({ root, authoringRoot, buddyId }) {
  if (isHomunculusIdFormat(buddyId)) {
    const actor = await resolveActiveHomunculusActor({ root, homunculusId: buddyId });
    return { character_id: actor.homunculus_id, display_name: actor.display_name };
  }
  return selectableCharacterSummary({ root, authoringRoot, characterId: buddyId });
}

async function buildRelationshipContext({ root, authoringRoot, state }) {
  if (!Object.prototype.hasOwnProperty.call(state, 'current_buddy_character_id')) {
    throw new Error('runtime_state.current_buddy_character_id is required');
  }
  if (!Object.prototype.hasOwnProperty.call(state, 'current_enemy_character_ids')) {
    throw new Error('runtime_state.current_enemy_character_ids is required');
  }
  const buddyId = state.current_buddy_character_id === null
    ? null
    : requireNonEmptyString(state.current_buddy_character_id, 'runtime_state.current_buddy_character_id');
  const enemyIds = state.current_enemy_character_ids;
  if (!Array.isArray(enemyIds)) {
    throw new Error('runtime_state.current_enemy_character_ids must be an array');
  }
  const buddy = buddyId
    ? await resolveBuddySummary({ root, authoringRoot, buddyId })
    : null;
  const enemies = [];
  const seen = new Set();
  for (const [index, rawEnemyId] of enemyIds.entries()) {
    const enemyId = requireNonEmptyString(rawEnemyId, `runtime_state.current_enemy_character_ids[${index}]`);
    if (seen.has(enemyId)) {
      throw new Error(`runtime_state.current_enemy_character_ids[${index}] must not duplicate ${enemyId}`);
    }
    enemies.push(await selectableCharacterSummary({ root, authoringRoot, characterId: enemyId }));
    seen.add(enemyId);
  }
  return { buddy, enemies };
}

async function buildContentResultContext({ root, authoringRoot, state }) {
  const record = readRoutingContentResult(state);
  if (!record) return null;
  const latestProgression = latestAppliedRoutingWeekProgression(state);
  if (!latestProgression) return null;
  if (latestProgression.elapsed_weeks !== record.week || latestProgression.destination_id !== record.destination_id) {
    return null;
  }
  const companionCharacterId = record.kind === 'dungeon'
    ? record.detail.companion_character_id
    : null;
  // The last dungeon's companion is a buddy — a selectable character or an active homunculus — so it is
  // resolved across both rosters, the same as the relationship buddy.
  const companion = companionCharacterId
    ? await resolveBuddySummary({ root, authoringRoot, buddyId: companionCharacterId })
    : null;
  return { record, companion };
}

// The gated-destination unlocks for this hub context, derived from the save's live player parameters. An
// absent parameters file keeps the gate closed (fail-closed) — a gated destination is never offered on an
// unverifiable gate.
async function buildUnlockedGatedDestinationIds({ storage }) {
  const playerParameters = await storage.readJsonIfExists(PLAYER_PARAMETERS_PATH);
  return unlockedGatedDestinationIdsForParameters(playerParameters);
}

async function buildAlchemyContext({ root }) {
  const definitions = await loadAlchemyDefinitions({ root });
  return {
    recipe_count: definitions.recipes.length
  };
}

async function buildStudyCircleContext({ root }) {
  const definitions = await loadStudyCircleDefinitions({ root });
  return {
    theme_count: definitions.length,
    weekly_offer_count: STUDY_CIRCLE_WEEKLY_OFFER_COUNT
  };
}

// The 星の揺り籠 hub context: a present-tense, player-disclosed snapshot of the little garden so the persona can
// speak to "the cradle right now". Built purely from the same view the HTTP surface serves (C-28 read-out: growth
// and reveal are elapsed-weeks reads, no write), so nothing is duplicated or re-derived here. Only disclosed
// fields cross into the prompt — a pre-reveal individual carries its stage and seed item, never its hidden
// variety; the second-form mutation appears only once the creature is adult, exactly as plantView / creatureView
// gate them. An empty garden (no pots, creatures, or caged) yields empty arrays and renders no line.
async function buildStarCradleContext({ storage, state }) {
  const catalog = await loadStarCradleCatalog({ storage });
  const currentWeek = requireRoutingContentWeek(state);
  const view = await buildStarCradleView({ storage, catalog, currentWeek });
  return {
    pots: view.pots.map((pot) => ({
      stage: pot.stage,
      seed_item_name: pot.seed_item.name,
      revealed: pot.revealed,
      ...(pot.revealed ? { variety_name: pot.variety.name } : {})
    })),
    creatures: view.creatures.map((creature) => ({
      stage: creature.stage,
      seed_item_name: creature.seed_item.name,
      revealed: creature.revealed,
      adult: creature.adult,
      name: creature.name,
      ...(creature.revealed ? { variety_name: creature.variety.name } : {}),
      ...(creature.adult ? { mutation_name: creature.mutation ? creature.mutation.name : null } : {})
    })),
    caged: view.caged.map((instance) => ({
      name: instance.name,
      variety_name: instance.variety.name
    }))
  };
}

export async function buildRoutingHubContextSnapshot({
  root,
  authoringRoot = root,
  state,
  personaVariant
}) {
  if (!root) throw new Error('root is required');
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('runtime state is required');
  const storage = storageFor(root);
  return normalizeRoutingHubContext({
    persona_variant: personaVariant,
    unlocked_gated_destination_ids: await buildUnlockedGatedDestinationIds({ storage }),
    recent_conversation_context: await buildRecentConversationContext({ storage, state }),
    relationship_context: await buildRelationshipContext({ root, authoringRoot, state }),
    alchemy_context: await buildAlchemyContext({ root }),
    study_circle_context: await buildStudyCircleContext({ root }),
    arena_context: { bracket_size: ARENA_BRACKET_UNIT_COUNT },
    star_cradle_context: await buildStarCradleContext({ storage, state }),
    content_result_context: await buildContentResultContext({ root, authoringRoot, state })
  });
}
