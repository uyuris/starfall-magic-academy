import { readCharacterDeleteFlags, toggleCharacterDeleteFlag } from './deleteFlagsStore.mjs';

export function canHandleDeleteFlagsRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/character-delete-flags') return true;
  if (method === 'POST' && pathname === '/api/character-delete-flags/toggle') return true;
  return false;
}

export async function handleDeleteFlagsApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleDeleteFlagsRoute(req.method, url.pathname)) return false;
  // Delete flags live in the git-managed canonical content/characters surface,
  // not in the per-play-session mutable root, so always use context.root.
  const root = context.root;

  if (req.method === 'GET' && url.pathname === '/api/character-delete-flags') {
    sendJson(res, await readCharacterDeleteFlags({ root }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/character-delete-flags/toggle') {
    const body = await readBody(req);
    try {
      sendJson(res, await toggleCharacterDeleteFlag({ root, characterId: body.character_id }));
    } catch (error) {
      sendJson(res, { error: error.message, error_code: error.errorCode ?? null }, error.statusCode ?? 500);
    }
    return true;
  }
  return false;
}
