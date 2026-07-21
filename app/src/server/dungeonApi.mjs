import { promises as fs } from 'node:fs';

import { prepareDungeonRun, commitEnteredRun, dungeonRunView, dungeonAction, dungeonFinalizeRun, getDungeonView, loadDungeonRun } from '../dungeon/dungeonEngine.mjs';
import { evaluateDungeonLlmAvailability } from '../dungeon/dungeonAvailability.mjs';
import { isLlmBusy } from '../llm/llmActivity.mjs';
import { companionPostTurnStatePolicy } from '../llm/conversationPipeline.mjs';
import { DUNGEON_SOURCE_TYPE } from '../routingMetaContext.mjs';
import { selectCompanion, companionDescriptor, dungeonEnterCompanionEvent } from '../dungeon/dungeonCompanion.mjs';
import { listSelectableCharacters, ensureSelectableCharacterStorage } from '../characterCatalog.mjs';
import { isHomunculusIdFormat } from '../companionRoster.mjs';
import { resolveActiveHomunculusActor } from '../buddyResolution.mjs';
import { createStorageApi } from '../storage.mjs';
import { isRoutingActivePlayMode, resolvePostContentScreen } from '../playMode.mjs';
import { streamConversationTurnSse, serializeStreamError } from './conversationStreamingApi.mjs';

const ROUTES = new Set([
  'GET /api/dungeon/state',
  'GET /api/dungeon/availability',
  'POST /api/dungeon/enter',
  'POST /api/dungeon/action',
  'POST /api/dungeon/finalize',
  'POST /api/dungeon/companion/talk',
  'POST /api/dungeon/companion/talk/stream'
]);

export function canHandleDungeonApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

async function isLmStudioConfigured(context) {
  if (context.lmStudioConfig) return true;
  try {
    await fs.access(context.lmStudioConfigPath);
    return true;
  } catch {
    return false;
  }
}

function companionConversationId(runSeed) {
  return `conv_dungeon_dr_${runSeed}`;
}

function dungeonSceneLocationName(floor) {
  return `実践ダンジョン 第${floor}層`;
}

// Scene context for the companion's opening at dungeon entry: frames the
// utterance as an in-dungeon encounter that starts the run together. source_type
// marks this as a dungeon record so the conversation record stamps the dungeon
// 舞台 (location_name / visible_situation) instead of the residual field location.
function dungeonEncounterSceneContext(floor) {
  return {
    source_type: DUNGEON_SOURCE_TYPE,
    location_name: dungeonSceneLocationName(floor),
    visible_situation: `実践ダンジョンの第${floor}層。探索の途中で主人公と出会い、ここから一緒に潜ることになった。`
  };
}

// Scene context for an ongoing companion turn: the dungeon floor being explored
// together, instead of the academy field location the player came from. source_type
// marks this as a dungeon record so each turn stamps the current floor's 舞台.
function dungeonExplorationSceneContext(floor) {
  return {
    source_type: DUNGEON_SOURCE_TYPE,
    location_name: dungeonSceneLocationName(floor),
    visible_situation: `実践ダンジョンの第${floor}層を主人公と一緒に探索している。`
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 2147483646) + 1;
}

// Decides whether the LLM-backed companion mode is available right now, by an
// explicit check: LM Studio configured AND no background finalization in flight.
async function currentAvailability(context) {
  return evaluateDungeonLlmAvailability({
    lmStudioConfigured: await isLmStudioConfigured(context),
    busy: isLlmBusy()
  });
}

function resolvePostDungeonScreen(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  return resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-room' });
}

export async function handleDungeonApi({
  req,
  res,
  url,
  context,
  sendJson,
  readBody,
  openSse,
  sendSseEvent,
  resolveRuntimeProviders,
  runConversationOpening,
  runConversationTurn,
  runConversationFinalization,
  activePlayMode
}) {
  const root = context.activeRoot ?? context.root;
  const postDungeonScreen = resolvePostDungeonScreen(activePlayMode);
  const routing = isRoutingActivePlayMode(activePlayMode);

  if (req.method === 'GET' && url.pathname === '/api/dungeon/availability') {
    return sendJson(res, await currentAvailability(context));
  }

  if (req.method === 'GET' && url.pathname === '/api/dungeon/state') {
    return sendJson(res, await getDungeonView({ root }));
  }

  if (req.method === 'POST' && url.pathname === '/api/dungeon/enter') {
    const body = await readBody(req);
    openSse(res);
    try {
      sendSseEvent(res, 'status', { phase: 'entering' });
      const existing = await loadDungeonRun({ root });
      if (existing && existing.status === 'active') {
        // Fail fast (as an SSE error) without rolling a companion / opening a chat.
        sendSseEvent(res, 'error', { error: 'a dungeon run is already active', error_code: 'active' });
      } else {
        const runSeed = body.seed === undefined ? randomSeed() : Number(body.seed);
        const availability = await currentAvailability(context);
        const wantCompanion = body.with_companion !== false;
        let selected = null;
        let conversationId = null;
        let companionFaceUrl = null;
        if (availability.available && wantCompanion) {
          const storage = createStorageApi({ root });
          const state = await storage.readJson('game_data/runtime_state.json');
          const buddyId = state.current_buddy_character_id ?? null;
          if (buddyId && isHomunculusIdFormat(buddyId)) {
            // The buddy is a homunculus: it IS the companion (fixed, no roll). Resolve its active actor
            // (display name + face + C-12 normalized parameters); a non-active buddy id throws — surfaced as
            // an SSE error, never a silent drop to a random selectable companion.
            const actor = await resolveActiveHomunculusActor({ storage, homunculusId: buddyId });
            selected = { character_id: actor.homunculus_id, display_name: actor.display_name, parameters: actor.parameters };
            companionFaceUrl = actor.face_url;
            conversationId = companionConversationId(runSeed);
          } else {
            const characters = await listSelectableCharacters({ root, authoringRoot: context.root });
            selected = selectCompanion({ characters, currentBuddyCharacterId: buddyId, seed: runSeed });
            if (selected) conversationId = companionConversationId(runSeed);
          }
        }
        // faceUrl is threaded only for a homunculus companion; a selectable companion keeps the exact
        // prior descriptor (no face_url), so the persisted run.companion stays byte-identical.
        const companion = selected ? companionDescriptor(selected, conversationId, { faceUrl: companionFaceUrl }) : null;
        // Build the run WITHOUT persisting it yet, so the board can render the moment
        // the opening starts streaming; if the opening fails, no run is committed.
        const run = await prepareDungeonRun({ root, seed: runSeed, companion });
        const enterView = await dungeonRunView(run, { availability, root });
        sendSseEvent(res, 'dungeon_enter', {
          view: enterView,
          availability,
          // Identity + (for a homunculus) the face_url + C-12 parameters marker fields, so the frontend can
          // render the companion detail popup from the enter event alone; the same projection the run view
          // uses (dungeonEnterCompanionEvent), byte-identical to before for a selectable companion.
          companion: dungeonEnterCompanionEvent(run.companion)
        });
        if (selected) {
          // Mirror the interaction flow: ensure a selectable companion's mutable storage exists. A
          // homunculus companion's actor directory was already seeded at synthesis, so it is skipped here.
          if (!isHomunculusIdFormat(selected.character_id)) {
            await ensureSelectableCharacterStorage({ root, authoringRoot: context.root, characterId: selected.character_id });
          }
          const providers = await resolveRuntimeProviders({
            requestedProvider: body.provider,
            context,
            onChatDelta: (delta) => sendSseEvent(res, 'assistant_delta', { delta })
          });
          // The opening is a real LLM call, streamed token by token. A failure throws
          // (surfaced as an SSE error) and the run is NOT committed — never a silent
          // drop to solo. The run starts on floor 1, so the encounter scene frames it there.
          const opening = await runConversationOpening({
            root,
            id: conversationId,
            characterId: selected.character_id,
            now: new Date().toISOString(),
            dungeonSceneContext: dungeonEncounterSceneContext(1),
            onAssistantComplete: ({ content }) => sendSseEvent(res, 'assistant_complete', { content }),
            ...providers
          });
          await commitEnteredRun({ root, run });
          sendSseEvent(res, 'result', { conversation: opening.conversation });
        } else {
          // Solo / LLM unavailable: no opening to stream — commit and finish.
          await commitEnteredRun({ root, run });
          sendSseEvent(res, 'result', { conversation: null });
        }
      }
    } catch (error) {
      sendSseEvent(res, 'error', serializeStreamError(error));
    } finally {
      res.end();
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/dungeon/action') {
    const body = await readBody(req);
    // A companion run end returns a preview and defers its finalize; a solo run end
    // commits synchronously. The deferred finalize lands via /api/dungeon/finalize.
    const result = await dungeonAction({ root, action: body.action, postDungeonScreen, routing });
    return sendJson(res, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/dungeon/finalize') {
    const body = await readBody(req);
    // Deferred companion finalize -> bank -> clear for a run held by a prior ended
    // action. runConversationFinalization wraps the work in beginLlmActivity, so the
    // busy gate rejects new LLM requests while this runs. The engine finalizes BEFORE
    // banking/clearing, so a finalize failure throws (500) and leaves the run intact.
    const finalizeCompanion = ({ conversationId, characterId }) =>
      resolveRuntimeProviders({ requestedProvider: body.provider, context })
        .then((providers) => runConversationFinalization({ root, conversationId, characterId, providers }));
    const result = await dungeonFinalizeRun({ root, finalizeCompanion, postDungeonScreen, routing });
    return sendJson(res, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/dungeon/companion/talk') {
    const body = await readBody(req);
    const run = await loadDungeonRun({ root });
    if (!run?.companion?.conversation_id) {
      return sendJson(res, { error: 'no_companion' }, 409);
    }
    const providers = await resolveRuntimeProviders({ requestedProvider: body.provider, context });
    const result = await runConversationTurn({
      root,
      id: run.companion.conversation_id,
      characterId: run.companion.character_id,
      playerInput: body.player_input,
      now: new Date().toISOString(),
      ...providers,
      dungeonSceneContext: dungeonExplorationSceneContext(run.floor),
      postTurnStatePolicy: companionPostTurnStatePolicy
    });
    return sendJson(res, { conversation: result.conversation, state: result.state });
  }

  if (req.method === 'POST' && url.pathname === '/api/dungeon/companion/talk/stream') {
    const body = await readBody(req);
    let run = null;
    const loadCompanionRun = async () => {
      run ??= await loadDungeonRun({ root });
      if (!run?.companion?.conversation_id) {
        const error = new Error('no_companion');
        error.errorCode = 'no_companion';
        error.statusCode = 409;
        throw error;
      }
      return run;
    };
    openSse(res);
    await streamConversationTurnSse({
      res,
      root,
      context,
      body,
      resolveConversationId: async () => (await loadCompanionRun()).companion.conversation_id,
      resolveCharacterId: async () => (await loadCompanionRun()).companion.character_id,
      resolveDungeonSceneContext: async () => dungeonExplorationSceneContext((await loadCompanionRun()).floor),
      postTurnStatePolicy: companionPostTurnStatePolicy,
      resolveRuntimeProviders,
      runConversationTurn,
      sendSseEvent
    });
    return true;
  }

  return sendJson(res, { error: 'not found' }, 404);
}
