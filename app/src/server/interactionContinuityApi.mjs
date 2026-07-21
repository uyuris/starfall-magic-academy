import { buildCharacterPrompt } from '../llm/promptBuilder.mjs';
import {
  buildConversationActorContextSnapshot,
  normalizeConversationActorContext
} from '../llm/conversationActorContext.mjs';
import { resolveCharacterSpeechConstraints } from '../llm/characterSpeechConstraints.mjs';
import { appendWeeklyActivityFacts } from '../weeklyActivityFacts.mjs';
import { buildContinuityPromptContext, mergeWorkRecordsById } from '../llm/continuityPromptContext.mjs';
import { getContinuityRecordStatus, pendingRecalledWorkRecordIds, resetContinuityRecords, selectRelevantWorkRecords, startInteractionSession } from '../llm/conversationPipeline.mjs';
import { ensureSelectableCharacterStorage } from '../characterCatalog.mjs';
import { ensureCreatureStorage, isCreatureId } from '../creatureCatalog.mjs';
import {
  normalizeDialogueActorSkillsFile,
  resolveDialogueActor
} from '../llm/dialogueActor.mjs';
import { loadWorldSettings } from '../worldSettings.mjs';
import { buildRoutingPromptSceneFields } from '../routingMetaContext.mjs';
import { buildRoutingHubContextSnapshot } from '../routingHubContextSnapshot.mjs';
import { buildRoutingPersona, ROUTING_PERSONA_CHARACTER_ID } from '../routingPersona.mjs';
import { createStorageApi } from '../storage.mjs';
import { ensureLmStudioConfigLoaded } from './lmStudioSettingsApi.mjs';

function storageFor(root) {
  return createStorageApi({ root });
}

async function readJson(root, relativePath) {
  return storageFor(root).readJson(relativePath);
}

async function readJsonIfExists(root, relativePath) {
  return storageFor(root).readJsonIfExists(relativePath);
}

async function listJson(root, relativeDir) {
  return storageFor(root).listJson(relativeDir);
}

async function listMarkdownRecords(root, relativeDir) {
  return storageFor(root).listMarkdownRecords(relativeDir);
}

async function readDialogueActor(root, actorId) {
  const actor = resolveDialogueActor(actorId);
  const [profile, flags, skills] = await Promise.all([
    readJson(root, `${actor.basePath}/profile.json`),
    readJsonIfExists(root, `${actor.basePath}/flags.json`),
    readJsonIfExists(root, `${actor.basePath}/skills.json`)
  ]);
  return { profile, flags, skills: normalizeDialogueActorSkillsFile(skills, actor.id) };
}

function enrichEventContextWithSourceWorkRecord(eventContext, workRecords) {
  if (!eventContext || typeof eventContext !== 'object') return null;
  const sourceConversationId = String(eventContext.source_conversation_id ?? '').trim();
  const sourceWorkRecordId = sourceConversationId ? `wr_${sourceConversationId}` : '';
  const sourceWorkRecord = workRecords.find((record) => record.id === sourceWorkRecordId);
  if (!sourceWorkRecord?.body) return { ...eventContext };
  return {
    ...eventContext,
    source_work_record_id: sourceWorkRecord.id,
    source_work_record_body: sourceWorkRecord.body
  };
}

function conversationActorContextFromActiveConversation(conversation) {
  if (!Object.hasOwn(conversation ?? {}, 'conversation_actor_context')) {
    throw new Error('active conversation is missing conversation_actor_context');
  }
  return normalizeConversationActorContext(conversation.conversation_actor_context);
}

export function isInteractionStartRoute(method, pathname) {
  return method === 'POST' && pathname === '/api/interaction/start';
}

function routingHubContextFromPromptPreview(url) {
  if (!url.searchParams.has('routing_persona_variant')) return undefined;
  return { persona_variant: url.searchParams.get('routing_persona_variant') };
}

export function canHandleInteractionContinuityApiRoute(method, pathname) {
  return (
    isInteractionStartRoute(method, pathname) ||
    (method === 'GET' && pathname === '/api/records/status') ||
    (method === 'POST' && pathname === '/api/records/reset') ||
    (method === 'GET' && pathname === '/api/prompt-preview')
  );
}

export async function handleInteractionContinuityApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody
}) {
  const root = context.activeRoot ?? context.root;

  if (req.method === 'POST' && url.pathname === '/api/interaction/start') {
    const body = await readBody(req);
    const characterId = String(body.character_id ?? 'lina').trim() || 'lina';
    // Drain-on-exit owns all post-processing: the previous conversation's exit fully drained the queue
    // before it transitioned here, so the session starts immediately with no entry pre-drain.
    if (/^character_\d{3}$/.test(characterId)) {
      await ensureSelectableCharacterStorage({ root, authoringRoot: context.root, characterId });
    } else if (isCreatureId(characterId)) {
      await ensureCreatureStorage({ root, authoringRoot: context.root, creatureId: characterId });
    }
    return sendJson(res, await startInteractionSession({ root, characterId }));
  }

  if (req.method === 'GET' && url.pathname === '/api/records/status') {
    const characterId = url.searchParams.get('character_id') ?? 'lina';
    return sendJson(res, await getContinuityRecordStatus({ root, characterId }));
  }

  if (req.method === 'POST' && url.pathname === '/api/records/reset') {
    const body = await readBody(req);
    return sendJson(res, await resetContinuityRecords({
      root,
      characterId: body.character_id ?? 'lina',
      target: body.target ?? 'all'
    }));
  }

  if (req.method === 'GET' && url.pathname === '/api/prompt-preview') {
    const characterId = url.searchParams.get('character_id') ?? 'lina';
    const normalizedCharacterId = String(characterId).trim();
    const routingHubContext = routingHubContextFromPromptPreview(url);
    if (routingHubContext !== undefined && normalizedCharacterId !== ROUTING_PERSONA_CHARACTER_ID) {
      throw new Error(`routing prompt preview requires character_id=${ROUTING_PERSONA_CHARACTER_ID}`);
    }
    const actor = resolveDialogueActor(normalizedCharacterId);
    const selectableCharacter = /^character_\d{3}$/.test(normalizedCharacterId)
      ? await ensureSelectableCharacterStorage({ root, authoringRoot: context.root, characterId: normalizedCharacterId })
      : null;
    const ensuredCreature = isCreatureId(normalizedCharacterId)
      ? await ensureCreatureStorage({ root, authoringRoot: context.root, creatureId: normalizedCharacterId })
      : null;
    const [state, character, memories, workRecords, locations, world] = await Promise.all([
      readJson(root, 'game_data/runtime_state.json'),
      selectableCharacter ? Promise.resolve(selectableCharacter) : ensuredCreature ? Promise.resolve(ensuredCreature) : readDialogueActor(root, normalizedCharacterId),
      listJson(root, `${actor.basePath}/memory`),
      listMarkdownRecords(root, `${actor.basePath}/work_records`),
      readJson(root, 'game_data/locations.json'),
      loadWorldSettings({ root })
    ]);
    const promptRoutingHubContext = routingHubContext === undefined
      ? undefined
      : await buildRoutingHubContextSnapshot({
        root,
        authoringRoot: context.root,
        state,
        personaVariant: routingHubContext.persona_variant
      });
    const location = locations.find((item) => item.id === state.current_location_id);
    const playerInput = url.searchParams.get('player_input') ?? 'この葉、普通じゃないよね？';
    const activeConversation = state.current_interaction_character_id === normalizedCharacterId
      ? await readJsonIfExists(root, `game_data/logs/conversations/${state.last_conversation_id}.json`)
      : null;
    const currentConversation = activeConversation?.messages ?? [];
    const pendingRecallIds = new Set(pendingRecalledWorkRecordIds(activeConversation, workRecords));
    const relevantWorkRecords = selectRelevantWorkRecords(workRecords, playerInput);
    const pendingWorkRecords = workRecords.filter((record) => pendingRecallIds.has(record.id));
    const selectedWorkRecords = mergeWorkRecordsById(relevantWorkRecords, pendingWorkRecords);
    const continuityPromptContext = buildContinuityPromptContext({
      memories,
      workRecords: selectedWorkRecords,
      allWorkRecords: workRecords
    });
    const requestedProvider = url.searchParams.get('provider') ?? '';
    let characterSpeechConstraints = [];
    if (requestedProvider !== 'mock') {
      const lmStudioConfig = await ensureLmStudioConfigLoaded(context, { allowMissing: true });
      characterSpeechConstraints = await resolveCharacterSpeechConstraints({ root, chatModel: lmStudioConfig?.chat_model });
    }
    const previewProfile = promptRoutingHubContext !== undefined
      ? buildRoutingPersona(promptRoutingHubContext.persona_variant)
      : character.profile;
    const conversationActorContext = activeConversation
      ? conversationActorContextFromActiveConversation(activeConversation)
      : appendWeeklyActivityFacts(
        await buildConversationActorContextSnapshot({ root, actor, profile: character.profile }),
        state,
        actor.id
      );
    const baseScene = {
      academy_name: world.academy_name ?? '星灯魔法学院',
      world_description: world.world_description ?? '',
      player_name: world.player_name ?? '主人公',
      player_parameters: world.player_parameters,
      location_name: location?.display_name ?? state.current_location_id,
      visible_situation: state.current_location_visible_situation ?? location?.visible_situation ?? ''
    };
    const prompt = buildCharacterPrompt({
      profile: previewProfile,
      scene: promptRoutingHubContext !== undefined
        ? { ...baseScene, ...buildRoutingPromptSceneFields({ state, routingHubContext: promptRoutingHubContext }) }
        : baseScene,
      memories: continuityPromptContext.memoriesForPrompt,
      skills: character.skills.skills,
      workRecords: continuityPromptContext.workRecordsForPrompt,
      eventContext: state.current_interaction_character_id === normalizedCharacterId
        ? enrichEventContextWithSourceWorkRecord(state.pending_interaction_context, workRecords)
        : null,
      currentConversation,
      characterSpeechConstraints,
      conversationActorContext,
      playerInput
    });
    return sendJson(res, { character_id: normalizedCharacterId, prompt });
  }
}
