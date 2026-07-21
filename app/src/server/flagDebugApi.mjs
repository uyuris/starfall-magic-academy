import { getStageFlagStatus, setAllStageFlagsActive, setStageFlagActive, setStageFlagJudgmentFlowEnabled } from '../stageFlags.mjs';
import { getEventFlagStatus, setAllEventFlagsActive, setEventCompletionFlagActive, setEventFlagActive, startEventFlagInteraction } from '../eventFlags.mjs';
import { getRecentLlmRequests } from '../llm/llmRequestLog.mjs';
import { setElapsedWeeksDebug } from '../graduationEnding.mjs';
import { setRelationshipDebugState } from '../relationshipState.mjs';
import { grantAllDungeonMaterials } from '../economy.mjs';

export function canHandleFlagDebugRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/flags') return true;
  if (method === 'POST' && pathname === '/api/flags/set') return true;
  if (method === 'POST' && pathname === '/api/flags/judgment-flow') return true;
  if (method === 'POST' && pathname === '/api/flags/all-on') return true;
  if (method === 'GET' && pathname === '/api/event-flags') return true;
  if (method === 'POST' && pathname === '/api/event-flags/set') return true;
  if (method === 'POST' && pathname === '/api/event-flags/completion/set') return true;
  if (method === 'POST' && pathname === '/api/event-flags/all-on') return true;
  if (method === 'POST' && pathname === '/api/event-flags/all-off') return true;
  if (method === 'POST' && pathname === '/api/event-flags/start') return true;
  if (method === 'GET' && pathname === '/api/debug/llm-requests') return true;
  if (method === 'POST' && pathname === '/api/debug/relationships') return true;
  if (method === 'POST' && pathname === '/api/debug/weeks') return true;
  if (method === 'POST' && pathname === '/api/debug/dungeon-materials') return true;
  return false;
}

export async function handleFlagDebugApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleFlagDebugRoute(req.method, url.pathname)) return false;
  const root = context.activeRoot ?? context.root;

  if (req.method === 'GET' && url.pathname === '/api/flags') {
    sendJson(res, await getStageFlagStatus({ root }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/flags/set') {
    const body = await readBody(req);
    try {
      sendJson(res, await setStageFlagActive({ root, flagId: body.flag_id, active: body.active === true }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/flags/judgment-flow') {
    const body = await readBody(req);
    try {
      sendJson(res, await setStageFlagJudgmentFlowEnabled({ root, flagId: body.flag_id, enabled: body.enabled === true }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/flags/all-on') {
    sendJson(res, await setAllStageFlagsActive({ root, active: true }));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/event-flags') {
    sendJson(res, await getEventFlagStatus({ root }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/event-flags/set') {
    const body = await readBody(req);
    try {
      sendJson(res, await setEventFlagActive({ root, flagId: body.flag_id, active: body.active === true }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/event-flags/completion/set') {
    const body = await readBody(req);
    try {
      sendJson(res, await setEventCompletionFlagActive({ root, flagId: body.flag_id, active: body.active === true }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/event-flags/all-on') {
    sendJson(res, await setAllEventFlagsActive({ root, active: true }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/event-flags/all-off') {
    sendJson(res, await setAllEventFlagsActive({ root, active: false }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/event-flags/start') {
    const body = await readBody(req);
    try {
      sendJson(res, await startEventFlagInteraction({ root, flagId: body.flag_id, screen: body.screen }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/debug/llm-requests') {
    sendJson(res, getRecentLlmRequests());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/debug/relationships') {
    const body = await readBody(req);
    try {
      sendJson(res, await setRelationshipDebugState({
        root,
        buddyCharacterId: body.buddy_character_id ?? null,
        enemyCharacterIds: Array.isArray(body.enemy_character_ids) ? body.enemy_character_ids : []
      }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/debug/weeks') {
    const body = await readBody(req);
    try {
      sendJson(res, await setElapsedWeeksDebug({ root, elapsedWeeks: body.elapsed_weeks }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/debug/dungeon-materials') {
    try {
      sendJson(res, await grantAllDungeonMaterials({ root }));
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
    }
    return true;
  }
  return false;
}
