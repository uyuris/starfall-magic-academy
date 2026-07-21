import http from 'node:http';
import path from 'node:path';
import { buildCharacterPrompt } from './llm/promptBuilder.mjs';
import { editConversationUserMessage, finalizeConversation, finalizeConversationAtomic, getContinuityRecordStatus, pendingRecalledWorkRecordIds, resetContinuityRecords, runConversationOpening, runConversationTurn, selectRelevantWorkRecords, startInteractionSession } from './llm/conversationPipeline.mjs';
import { resolveCharacterSpeechConstraints } from './llm/characterSpeechConstraints.mjs';
import { createLmStudioProviders, createLoungeFinalizationProviders, loadLmStudioConfig } from './llm/lmStudioClient.mjs';
import { listSelectableCharacters, ensureSelectableCharacterStorage, updateCharacterProfileText } from './characterCatalog.mjs';
import { loadWorldSettings } from './worldSettings.mjs';
import { canHandleSaveLoadApiRoute, handleSaveLoadApi, isSaveSlotLoadRoute } from './server/saveLoadApi.mjs';
import { canHandleLmStudioSettingsRoute, handleLmStudioSettingsApi, ensureLmStudioConversationConfig } from './server/lmStudioSettingsApi.mjs';
import { canHandlePlayModeSettingsRoute, handlePlayModeSettingsApi, readPlayModeSettings } from './server/playModeSettingsApi.mjs';
import { canHandleRoutingHubRoute, handleRoutingHubApi } from './server/routingHubApi.mjs';
import { canHandleErrandApiRoute, handleErrandApi } from './server/errandApi.mjs';
import { canHandleAlchemyApiRoute, handleAlchemyApi } from './server/alchemyApi.mjs';
import { canHandleStudyCircleApiRoute, handleStudyCircleApi } from './server/studyCircleApi.mjs';
import { canHandleWorkshopApiRoute, handleWorkshopApi } from './server/workshopApi.mjs';
import { canHandleLibraryApiRoute, handleLibraryApi } from './server/libraryApi.mjs';
import { canHandleAtelierApiRoute, handleAtelierApi } from './server/atelierApi.mjs';
import { canHandleStarCradleApiRoute, handleStarCradleApi } from './server/starCradleApi.mjs';
import { canHandleConversationPopupSettingsRoute, handleConversationPopupSettingsApi } from './server/conversationPopupSettingsApi.mjs';
import { canHandleAudioSettingsRoute, handleAudioSettingsApi } from './server/audioSettingsApi.mjs';
import { canHandleFlagDebugRoute, handleFlagDebugApi } from './server/flagDebugApi.mjs';
import { canHandleDeleteFlagsRoute, handleDeleteFlagsApi } from './server/deleteFlagsApi.mjs';
import { canHandleAuthoringApiRoute, handleAuthoringApi } from './server/authoringApi.mjs';
import { canHandlePlaySessionFieldApiRoute, handlePlaySessionFieldApi, isNewGameRoute } from './server/playSessionFieldApi.mjs';
import { canHandleProgressionEconomyApiRoute, handleProgressionEconomyApi } from './server/progressionEconomyApi.mjs';
import { canHandleEquipmentRoute, handleEquipmentApi } from './server/equipmentApi.mjs';
import { canHandleRelationshipApiRoute, handleRelationshipApi } from './server/relationshipApi.mjs';
import { canHandleDungeonApiRoute, handleDungeonApi } from './server/dungeonApi.mjs';
import { canHandleArenaApiRoute, handleArenaApi } from './server/arenaApi.mjs';
import { canHandleAuctionApiRoute, handleAuctionApi } from './server/auctionApi.mjs';
import { canHandleLoungeApiRoute, handleLoungeApi } from './server/loungeApi.mjs';
import { canHandleDiaryApiRoute, handleDiaryApi } from './server/diaryApi.mjs';
import { beginLlmActivity } from './llm/llmActivity.mjs';
import { canHandleInteractionContinuityApiRoute, handleInteractionContinuityApi, isInteractionStartRoute } from './server/interactionContinuityApi.mjs';
import { canHandleAssetCompositeApiRoute, handleAssetCompositeApi } from './server/assetCompositeApi.mjs';
import { canHandleConversationLifecycleApiRoute, handleConversationLifecycleApi, isConversationOpeningRoute } from './server/conversationLifecycleApi.mjs';
import { canHandleConversationGiftApiRoute, handleConversationGiftApi } from './server/conversationGiftApi.mjs';
import { canHandleConversationStreamingApiRoute, handleConversationStreamingApi, isConversationOpeningStreamRoute } from './server/conversationStreamingApi.mjs';
import { sendJson, openSse, sendSseEvent, readBody } from './server/httpHelpers.mjs';
import { serveStatic } from './server/staticServing.mjs';
import { markGraduationEndingComplete, isGraduationEndingContext } from './graduationEnding.mjs';
import { defaultRuntimePaths } from './runtimePaths.mjs';
import { createStorageApi } from './storage.mjs';
import { assertValidSlotId, readActiveSlot, readValidActiveSlotId, resolveValidActivePlayRoot } from './playSession.mjs';
import { readSaveSlotActivePlayMode } from './saveLoad.mjs';
import { recoverPromotingFinalizations, runRoutingReadScopeIfActive, runRoutingReadScopeRequired } from './routingFinalizeQueue.mjs';

const projectRoot = defaultRuntimePaths.projectRoot;
const defaultPublicRoot = defaultRuntimePaths.publicRoot;
const defaultCanonicalAssetsRoot = defaultRuntimePaths.canonicalAssetsRoot;
const defaultCanonicalVisualSetsRoot = defaultRuntimePaths.canonicalVisualSetsRoot;
const defaultLmStudioConfigPath = path.join(defaultRuntimePaths.configRoot, 'lmstudio.json');
const defaultPort = Number(process.env.PORT ?? 4173);
const defaultHost = process.env.HOST ?? '127.0.0.1';

function storageFor(root, options = {}) {
  return createStorageApi({ root, ...options });
}

async function readJson(root, relativePath, options = {}) {
  return storageFor(root, options).readJson(relativePath);
}

async function writeJson(root, relativePath, value) {
  await storageFor(root).writeJson(relativePath, value);
}

async function readJsonIfExists(root, relativePath, options = {}) {
  return storageFor(root, options).readJsonIfExists(relativePath);
}

async function listJson(root, relativeDir, options = {}) {
  return storageFor(root, options).listJson(relativeDir);
}

async function listMarkdownRecords(root, relativeDir, options = {}) {
  return storageFor(root, options).listMarkdownRecords(relativeDir);
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

async function readCharacter(root, characterId) {
  const base = `game_data/characters/${characterId}`;
  const [profile, flags, skills] = await Promise.all([
    readJson(root, `${base}/profile.json`),
    readJson(root, `${base}/flags.json`),
    readJsonIfExists(root, `${base}/skills.json`)
  ]);
  return { profile, flags, skills: skills ?? { character_id: characterId, skills: [] } };
}

async function resolveRuntimeProviders({ requestedProvider, context, onChatDelta } = {}) {
  if (requestedProvider === 'mock') {
    return {
      chatProvider: async ({ playerInput }) => playerInput === null
        ? '……はい。まずはこの場所の様子を、落ち着いて見てみましょう。'
        : '……はい。今の話を手がかりに、目の前の状況から一つずつ確かめます。',
      conversationContinuationProvider: async () => true,
      conversationCutoffProvider: async () => '今日はここで区切りましょう。また必要になったら声をかけてください。',
      // The mock errand achievement judgment is driven by the player input so a mock-mode test can
      // deterministically hit both branches: an utterance containing 「達成」 achieves and auto-ends the
      // errand, anything else keeps it going (the same benign continue the mock continuation gives).
      errandAchievementProvider: async ({ playerInput }) => (String(playerInput ?? '').includes('達成') ? 'true' : 'false'),
      errandWrapUpProvider: async () => 'それじゃ、これで今回のお願いはおしまい。助かった、ありがとう。',
      // The mock study circle achievement judgment mirrors the errand one: an utterance containing 「達成」
      // achieves and auto-ends the study circle, anything else keeps it going.
      studyCircleAchievementProvider: async ({ playerInput }) => (String(playerInput ?? '').includes('達成') ? 'true' : 'false'),
      studyCircleWrapUpProvider: async () => '今日の研究会はここまでにしましょう。よく付き合ってくれました、ありがとう。',
      // The mock graduation guide selection is driven by the player input so a mock-mode test can pick a
      // presented candidate deterministically: an utterance naming a candidate's character id selects it;
      // anything else keeps the guide conversation going (none).
      routingGraduationGuideProvider: async ({ playerInput, candidates }) => {
        const input = String(playerInput ?? '');
        const match = (candidates ?? []).find((candidate) => input.includes(candidate.character_id));
        return match ? match.character_id : 'none';
      },
      // The mock routing destination selection is driven by the player input so a mock-mode test can decide a
      // routing hub destination deterministically: an utterance naming a destination id selects it; anything
      // else keeps the hub conversation going (none).
      routingDestinationProvider: async ({ playerInput, destinations }) => {
        const input = String(playerInput ?? '');
        const match = (destinations ?? []).find((destination) => input.includes(destination.id));
        return match ? match.id : 'none';
      },
      routingTransitionProvider: async () => 'それでは、そちらへ向かいましょう。',
      affinityDeltaProvider: async () => '0',
      // Neutral mock reserve line: the initial 30% (a no-change answer).
      mpReserveProvider: async () => '30'
    };
  }
  const config = await ensureLmStudioConversationConfig(context);
  const characterSpeechConstraints = await resolveCharacterSpeechConstraints({
    root: context.activeRoot ?? context.root,
    chatModel: config.chat_model
  });
  return { ...createLmStudioProviders({ config, onChatDelta }), characterSpeechConstraints };
}

async function runConversationFinalization({ root, conversationId, characterId, providers, finalStateTransform = null, useAtomicFinalize = false, progressReporter = null }) {
  // Mark the single LM Studio instance busy for the whole finalization so the
  // dungeon's two-mode availability check can see that background LLM work is
  // in flight (additive; does not change finalization behavior).
  const endActivity = beginLlmActivity();
  const startedAt = new Date().toISOString();
  const finalize = useAtomicFinalize ? finalizeConversationAtomic : finalizeConversation;
  try {
    return await finalize({
      root,
      conversationId,
      characterId,
      now: startedAt,
      skillNecessityProvider: providers.skillNecessityProvider ?? providers.skillNecessityJudgmentProvider,
      finalStateTransform,
      progressReporter,
      ...providers
    });
  } catch (error) {
    await writeJson(root, `game_data/logs/finalization_errors/${conversationId}.json`, {
      conversation_id: conversationId,
      character_id: characterId,
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      error: error.message,
      stack: error.stack
    });
    throw error;
  } finally {
    endActivity();
  }
}

async function updateAuthoringAndActiveRoot({ context, updater }) {
  const canonicalResult = await updater(context.root);
  if (context.activeRoot && path.resolve(context.activeRoot) !== path.resolve(context.root)) {
    await updater(context.activeRoot);
  }
  return canonicalResult;
}

async function ensureActiveRootRestored(context) {
  if (context.activeRootRestorePromise) {
    await context.activeRootRestorePromise;
    context.activeRootRestorePromise = null;
  }
}

async function routeApi(req, res, url, context, { routingRequest = false, readBodyOverride = readBody, activePlayMode = null } = {}) {
  await ensureActiveRootRestored(context);
  const storageOptions = { requireRoutingReadScope: routingRequest };
  const readJsonForRequest = (root, relativePath) => readJson(root, relativePath, storageOptions);
  const readJsonIfExistsForRequest = (root, relativePath) => readJsonIfExists(root, relativePath, storageOptions);
  const runConversationFinalizationForRequest = (args) => runConversationFinalization({
    ...args,
    useAtomicFinalize: routingRequest
  });
  const recoverRoutingFinalizationsForRequest = routingRequest
    ? ({ slotId }) => recoverPromotingFinalizations({ root: context.root, slotId })
    : null;
  if (canHandleSaveLoadApiRoute(req.method, url.pathname)) {
    await handleSaveLoadApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      recoverRoutingFinalizations: recoverRoutingFinalizationsForRequest
    });
    return;
  }
  if (canHandleLmStudioSettingsRoute(req.method, url.pathname)) {
    await handleLmStudioSettingsApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandlePlayModeSettingsRoute(req.method, url.pathname)) {
    await handlePlayModeSettingsApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleRoutingHubRoute(req.method, url.pathname)) {
    await handleRoutingHubApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      resolveRuntimeProviders,
      runConversationOpening,
      activePlayMode
    });
    return;
  }
  if (canHandleErrandApiRoute(req.method, url.pathname)) {
    await handleErrandApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      resolveRuntimeProviders,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context),
      runConversationOpening,
      startInteractionSession,
      activePlayMode
    });
    return;
  }
  if (canHandleAlchemyApiRoute(req.method, url.pathname)) {
    await handleAlchemyApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      activePlayMode
    });
    return;
  }
  if (canHandleStudyCircleApiRoute(req.method, url.pathname)) {
    await handleStudyCircleApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      resolveRuntimeProviders,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context),
      runConversationOpening,
      startInteractionSession,
      activePlayMode
    });
    return;
  }
  if (canHandleWorkshopApiRoute(req.method, url.pathname)) {
    await handleWorkshopApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      activePlayMode,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context)
    });
    return;
  }
  if (canHandleLibraryApiRoute(req.method, url.pathname)) {
    await handleLibraryApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      activePlayMode,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context)
    });
    return;
  }
  if (canHandleAtelierApiRoute(req.method, url.pathname)) {
    await handleAtelierApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      activePlayMode,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context),
      resolveRuntimeProviders,
      runConversationOpening,
      startInteractionSession
    });
    return;
  }
  if (canHandleStarCradleApiRoute(req.method, url.pathname)) {
    await handleStarCradleApi({ req, res, url, context, sendJson, readBody: readBodyOverride, activePlayMode });
    return;
  }
  if (canHandleConversationPopupSettingsRoute(req.method, url.pathname)) {
    await handleConversationPopupSettingsApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleAudioSettingsRoute(req.method, url.pathname)) {
    await handleAudioSettingsApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleFlagDebugRoute(req.method, url.pathname)) {
    await handleFlagDebugApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleDeleteFlagsRoute(req.method, url.pathname)) {
    await handleDeleteFlagsApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleAuthoringApiRoute(req.method, url.pathname)) {
    await handleAuthoringApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandlePlaySessionFieldApiRoute(req.method, url.pathname)) {
    await handlePlaySessionFieldApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleProgressionEconomyApiRoute(req.method, url.pathname)) {
    await handleProgressionEconomyApi({ req, res, url, context, sendJson, readBody: readBodyOverride, activePlayMode });
    return;
  }
  if (canHandleEquipmentRoute(req.method, url.pathname)) {
    await handleEquipmentApi({ req, res, url, context, sendJson, readBody: readBodyOverride });
    return;
  }
  if (canHandleRelationshipApiRoute(req.method, url.pathname)) {
    await handleRelationshipApi({ req, res, url, context, sendJson });
    return;
  }
  if (canHandleDungeonApiRoute(req.method, url.pathname)) {
    await handleDungeonApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      openSse,
      sendSseEvent,
      resolveRuntimeProviders,
      runConversationOpening,
      runConversationTurn,
      runConversationFinalization,
      activePlayMode
    });
    return;
  }
  if (canHandleArenaApiRoute(req.method, url.pathname)) {
    await handleArenaApi({ req, res, url, context, sendJson, readBody: readBodyOverride, activePlayMode });
    return;
  }
  if (canHandleAuctionApiRoute(req.method, url.pathname)) {
    await handleAuctionApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      activePlayMode,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context),
      openSse,
      sendSseEvent
    });
    return;
  }
  if (canHandleLoungeApiRoute(req.method, url.pathname)) {
    await handleLoungeApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      activePlayMode,
      resolveLmStudioConfig: () => ensureLmStudioConversationConfig(context),
      resolveRuntimeProviders,
      resolveLoungeFinalizationProviders: async () => createLoungeFinalizationProviders({
        config: await ensureLmStudioConversationConfig(context)
      }),
      openSse,
      sendSseEvent
    });
    return;
  }
  if (canHandleDiaryApiRoute(req.method, url.pathname)) {
    await handleDiaryApi({ req, res, url, context, sendJson });
    return;
  }
  if (canHandleInteractionContinuityApiRoute(req.method, url.pathname)) {
    await handleInteractionContinuityApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride
    });
    return;
  }
  if (canHandleAssetCompositeApiRoute(req.method, url.pathname)) {
    await handleAssetCompositeApi({ req, res, url, context, sendJson });
    return;
  }
  if (canHandleConversationGiftApiRoute(req.method, url.pathname)) {
    await handleConversationGiftApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      resolveRuntimeProviders,
      activePlayMode
    });
    return;
  }
  if (canHandleConversationLifecycleApiRoute(req.method, url.pathname)) {
    await handleConversationLifecycleApi({
      req,
      res,
      url,
      context,
      sendJson,
      readBody: readBodyOverride,
      resolveRuntimeProviders,
      readJson: readJsonForRequest,
      readJsonIfExists: readJsonIfExistsForRequest,
      writeJson,
      runConversationOpening,
      runConversationTurn,
      editConversationUserMessage,
      runConversationFinalization: runConversationFinalizationForRequest,
      markGraduationEndingComplete,
      isGraduationEndingContext,
      activePlayMode
    });
    return;
  }
  if (canHandleConversationStreamingApiRoute(req.method, url.pathname)) {
    await handleConversationStreamingApi({
      req,
      res,
      url,
      context,
      readBody: readBodyOverride,
      readJson: readJsonForRequest,
      readJsonIfExists: readJsonIfExistsForRequest,
      writeJson,
      resolveRuntimeProviders,
      runConversationOpening,
      runConversationTurn,
      runConversationFinalization: runConversationFinalizationForRequest,
      markGraduationEndingComplete,
      isGraduationEndingContext,
      openSse,
      sendSseEvent,
      activePlayMode
    });
    return;
  }

  return sendJson(res, { error: 'not found' }, 404);
}

function isRoutingHubEntryRoute(req, url) {
  return canHandleRoutingHubRoute(req.method, url.pathname) ||
    isInteractionStartRoute(req.method, url.pathname) ||
    isConversationOpeningRoute(req.method, url.pathname) ||
    isConversationOpeningStreamRoute(req.method, url.pathname);
}

function isSlotLoadRoute(req, url) {
  return isSaveSlotLoadRoute(req.method, url.pathname);
}

function isFirstRoutingStartRoute(req, url) {
  return isNewGameRoute(req.method, url.pathname);
}

async function recoverRoutingEntryIfActive(root) {
  try {
    await recoverPromotingFinalizations({ root });
  } catch (error) {
    if (/active slot is required/.test(error?.message ?? '')) return;
    throw error;
  }
}

async function hasActiveRoutingScopeTarget(context) {
  if (context.activeRoot) return true;
  const active = await readActiveSlot(context.root);
  const slotId = String(active?.slot_id ?? '').trim();
  if (!slotId) return false;
  assertValidSlotId(slotId);
  return true;
}

async function readActiveSlotPlayMode(context) {
  const slotId = await readValidActiveSlotId(context.root);
  if (!slotId) return null;
  return await readSaveSlotActivePlayMode({ root: context.root, slotId });
}

async function resolveRequestActivePlayMode(req, url, context) {
  if (isSlotLoadRoute(req, url)) {
    const body = await readBody(req);
    const slotId = assertValidSlotId(body.slot_id);
    return {
      activePlayMode: await readSaveSlotActivePlayMode({ root: context.root, slotId }),
      readBodyOverride: async () => body,
      targetSlotId: slotId
    };
  }
  if (isFirstRoutingStartRoute(req, url)) {
    // A new game is always routing (the play-mode sidecar is no longer consulted for the new-game mode); the
    // handler assigns the random persona variant. Only the mode gates the request read-scope here.
    return {
      activePlayMode: { mode: 'routing' },
      readBodyOverride: readBody,
      targetSlotId: null
    };
  }
  return {
    activePlayMode: await readActiveSlotPlayMode(context) ?? await readPlayModeSettings(context.playModeSettingsPath),
    readBodyOverride: readBody,
    targetSlotId: null
  };
}

async function routeApiWithReadScope(req, res, url, context) {
  if (canHandlePlayModeSettingsRoute(req.method, url.pathname)) {
    await routeApi(req, res, url, context);
    return;
  }
  await ensureActiveRootRestored(context);
  const {
    activePlayMode,
    readBodyOverride,
    targetSlotId
  } = await resolveRequestActivePlayMode(req, url, context);
  if (activePlayMode.mode !== 'routing') {
    await routeApi(req, res, url, context, { routingRequest: false, readBodyOverride, activePlayMode });
    return;
  }
  if (canHandleRoutingHubRoute(req.method, url.pathname)) {
    await recoverRoutingEntryIfActive(context.activeRoot ?? context.root);
    await runRoutingReadScopeIfActive(
      { root: context.activeRoot ?? context.root },
      () => routeApi(req, res, url, context, { routingRequest: true, readBodyOverride, activePlayMode })
    );
    return;
  }
  if (isRoutingHubEntryRoute(req, url)) {
    await recoverRoutingEntryIfActive(context.activeRoot ?? context.root);
  }
  const routeWithRoutingScope = ({ root = context.activeRoot ?? context.root, slotId = null, readBodyOverride: scopedReadBody = readBodyOverride } = {}) => runRoutingReadScopeIfActive(
    { root, slotId },
    () => routeApi(req, res, url, context, { routingRequest: true, readBodyOverride: scopedReadBody, activePlayMode })
  );
  if (isSlotLoadRoute(req, url)) {
    await runRoutingReadScopeRequired(() => routeWithRoutingScope({
      root: context.root,
      slotId: targetSlotId
    }));
    return;
  }
  if (await hasActiveRoutingScopeTarget(context)) {
    await runRoutingReadScopeRequired(() => routeWithRoutingScope());
    return;
  }
  if (isFirstRoutingStartRoute(req, url)) {
    await routeWithRoutingScope();
    return;
  }
  await runRoutingReadScopeRequired(() => routeWithRoutingScope());
}

export function createServer(options = {}) {
  const resolvedLmStudioConfigPath = path.resolve(options.lmStudioConfigPath ?? process.env.MAGIC_ACADEMY_LMSTUDIO_CONFIG ?? defaultLmStudioConfigPath);
  const context = {
    root: path.resolve(options.root ?? projectRoot),
    activeRoot: options.activeRoot ? path.resolve(options.activeRoot) : null,
    publicRoot: path.resolve(options.publicRoot ?? defaultPublicRoot),
    canonicalAssetsRoot: path.resolve(options.canonicalAssetsRoot ?? defaultCanonicalAssetsRoot),
    canonicalVisualSetsRoot: path.resolve(options.canonicalVisualSetsRoot ?? defaultCanonicalVisualSetsRoot),
    worldSettingsWriteTarget: options.worldSettingsWriteTarget === 'config' ? 'config' : 'definitions',
    characterAuthoringEnabled: options.characterAuthoringEnabled !== false,
    characterAuthoringDisabledReason: options.characterAuthoringDisabledReason ?? null,
    lmStudioConfig: options.lmStudioConfig ?? null,
    lmStudioConfigPath: resolvedLmStudioConfigPath,
    playModeSettingsPath: path.resolve(options.playModeSettingsPath ?? process.env.MAGIC_ACADEMY_PLAY_MODE_SETTINGS ?? path.join(path.dirname(resolvedLmStudioConfigPath), 'play-mode.json')),
    conversationPopupSettingsPath: path.resolve(options.conversationPopupSettingsPath ?? process.env.MAGIC_ACADEMY_CONV_POPUP_SETTINGS ?? path.join(path.dirname(resolvedLmStudioConfigPath), 'conversation-popup.json')),
    audioSettingsPath: path.resolve(options.audioSettingsPath ?? process.env.MAGIC_ACADEMY_AUDIO_SETTINGS ?? path.join(path.dirname(resolvedLmStudioConfigPath), 'audio.json')),
    activeRootRestorePromise: null
  };
  if (!context.activeRoot) {
    context.activeRootRestorePromise = resolveValidActivePlayRoot(context.root).then((activeRoot) => {
      context.activeRoot = activeRoot;
    });
  }
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await routeApiWithReadScope(req, res, url, context);
      else await serveStatic(req, res, url, context);
    } catch (error) {
      const payload = { error: error.message };
      if (error?.errorCode) payload.error_code = error.errorCode;
      sendJson(res, payload, error?.statusCode ?? 500);
    }
  });
}

async function loadStartupLmStudioConfig(configPath) {
  try {
    return await loadLmStudioConfig(configPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function startServer(options = {}) {
  const host = options.host ?? defaultHost;
  const port = Number(options.port ?? defaultPort);
  const configPath = path.resolve(options.lmStudioConfigPath ?? process.env.MAGIC_ACADEMY_LMSTUDIO_CONFIG ?? defaultLmStudioConfigPath);
  const lmStudioConfig = options.lmStudioConfig === undefined
    ? await loadStartupLmStudioConfig(configPath)
    : options.lmStudioConfig;
  const server = createServer({
    ...options,
    lmStudioConfig,
    lmStudioConfigPath: configPath
  });
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
  const address = server.address();
  const startedHost = typeof address === 'object' && address?.address ? address.address : host;
  const startedPort = typeof address === 'object' && address?.port ? address.port : port;
  if (options.silent !== true) {
    console.log(`STARFALL MAGIC ACADEMY runtime listening on http://${startedHost}:${startedPort}`);
    if (!lmStudioConfig) {
      console.log(`LM Studio config not found at ${configPath}; browser shell and settings surface are available, but conversation features will require saving LM Studio settings first.`);
    }
  }
  return { server, host: startedHost, port: startedPort, url: `http://${startedHost}:${startedPort}`, lmStudioConfigPath: configPath, lmStudioConfig };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
