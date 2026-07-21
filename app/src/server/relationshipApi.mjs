// Relationship read surface for the frontend. `GET /api/relationships/buddy` returns the current buddy's
// display data — for a selectable character or a homunculus alike — so the routing hub / academy surfaces can
// render a homunculus buddy (display_name / face_url / affinity) that they cannot resolve from the selectable
// roster. This is an UNGATED read path: it does not depend on the atelier unlock gate, so the buddy display
// works even for a save that has not unlocked the atelier destination.

import { resolveCurrentBuddySummary } from '../buddyResolution.mjs';

const ROUTES = new Set(['GET /api/relationships/buddy']);

export function canHandleRelationshipApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

export async function handleRelationshipApi({ req, res, url, context, sendJson }) {
  if (!canHandleRelationshipApiRoute(req.method, url.pathname)) return false;
  const root = context.activeRoot ?? context.root;

  if (req.method === 'GET' && url.pathname === '/api/relationships/buddy') {
    const buddy = await resolveCurrentBuddySummary({ root, authoringRoot: context.root });
    return sendJson(res, { buddy });
  }

  return sendJson(res, { error: 'not found' }, 404);
}
