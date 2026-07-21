import { isRoutingActivePlayMode, resolvePostContentScreen } from '../playMode.mjs';
import { ensureLmStudioConversationConfig } from './lmStudioSettingsApi.mjs';
import {
  getArenaState,
  enterArenaTournament,
  startArenaMatch,
  applyArenaMatchAction,
  replayArenaMatch,
  generateArenaMatchIntro,
  generateArenaTournamentResultFlavor
} from '../arena/arenaSession.mjs';

// The 闘技会 HTTP surface. All routes are routing-only (arena is a routing destination); loop mode never
// reaches them, so loop runtime_state is untouched. The handler stays thin — descriptor gathering, bracket
// state, engine stepping, reward granting, and LLM flavor generation live in arenaSession; thrown status errors
// are mapped to JSON responses by the server's top-level handler.
//
// The two LLM flavor routes (match intro / result flavor) resolve the LM config FIRST, so an unconfigured /
// unreachable LM is a clean 503 with nothing consumed — and, because flavor is independent of combat / reward /
// bracket, the non-flavor routes stay LM-free (arena's combat + reward flow needs no LM).
const ARENA_FIXED_ROUTES = new Set([
  'GET /api/arena/state',
  'POST /api/arena/enter',
  'POST /api/arena/match/start',
  'POST /api/arena/action',
  'POST /api/arena/match/intro',
  'POST /api/arena/result-flavor'
]);
const ARENA_REPLAY_PATTERN = /^\/api\/arena\/match\/([^/]+)\/replay$/;

export function canHandleArenaApiRoute(method, pathname) {
  if (ARENA_FIXED_ROUTES.has(`${method} ${pathname}`)) return true;
  return method === 'GET' && ARENA_REPLAY_PATTERN.test(pathname);
}

export async function handleArenaApi({ req, res, url, context, sendJson, readBody, activePlayMode }) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  if (!isRoutingActivePlayMode(activePlayMode)) {
    return sendJson(res, { error: 'arena requires routing mode', error_code: 'ROUTING_MODE_REQUIRED' }, 409);
  }
  const root = context.activeRoot ?? context.root;
  const authoringRoot = context.root;
  // The return-to-hub screen is owned by the caller's play mode (routing hub) and passed down explicitly.
  const postContentScreen = resolvePostContentScreen({ mode: activePlayMode.mode, loopScreen: 'academy-room' });

  if (req.method === 'GET' && url.pathname === '/api/arena/state') {
    return sendJson(res, await getArenaState({ root, authoringRoot }));
  }
  if (req.method === 'POST' && url.pathname === '/api/arena/match/intro') {
    // Resolve the LM config first (clean 503 if unconfigured); flavor is independent of the combat/reward flow.
    const config = await ensureLmStudioConversationConfig(context);
    const body = await readBody(req);
    return sendJson(res, await generateArenaMatchIntro({ root, config, matchId: body.match_id }));
  }
  if (req.method === 'POST' && url.pathname === '/api/arena/result-flavor') {
    const config = await ensureLmStudioConversationConfig(context);
    return sendJson(res, await generateArenaTournamentResultFlavor({ root, config }));
  }
  if (req.method === 'POST' && url.pathname === '/api/arena/enter') {
    const body = await readBody(req);
    return sendJson(res, await enterArenaTournament({ root, authoringRoot, mode: body.mode, postContentScreen }));
  }
  if (req.method === 'POST' && url.pathname === '/api/arena/match/start') {
    return sendJson(res, await startArenaMatch({ root, authoringRoot }));
  }
  if (req.method === 'POST' && url.pathname === '/api/arena/action') {
    const body = await readBody(req);
    return sendJson(res, await applyArenaMatchAction({ root, authoringRoot, action: body.action, postContentScreen }));
  }
  const replayMatch = ARENA_REPLAY_PATTERN.exec(url.pathname);
  if (req.method === 'GET' && replayMatch) {
    return sendJson(res, await replayArenaMatch({ root, matchId: decodeURIComponent(replayMatch[1]) }));
  }
  return sendJson(res, { error: 'not found' }, 404);
}
