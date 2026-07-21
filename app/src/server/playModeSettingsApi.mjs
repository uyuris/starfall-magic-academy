import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveActivePlayMode, validatePlayModeUpdate } from '../playMode.mjs';
import { hasAnyPromotingSentinel } from '../routingFinalizeQueue.mjs';

export async function readPlayModeSettings(settingsPath) {
  return await resolveActivePlayMode(settingsPath);
}

async function persistPlayModeSettings(settingsPath, settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

export function resolvePlayModeSettingsPath(context) {
  if (!context.playModeSettingsPath) throw new Error('play mode settings path is not configured');
  return context.playModeSettingsPath;
}

export function canHandlePlayModeSettingsRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/settings/play-mode') return true;
  if (method === 'PATCH' && pathname === '/api/settings/play-mode') return true;
  return false;
}

export async function handlePlayModeSettingsApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandlePlayModeSettingsRoute(req.method, url.pathname)) return false;
  const settingsPath = resolvePlayModeSettingsPath(context);

  if (req.method === 'GET' && url.pathname === '/api/settings/play-mode') {
    sendJson(res, await readPlayModeSettings(settingsPath));
    return true;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings/play-mode') {
    const body = await readBody(req);
    let update;
    try {
      update = validatePlayModeUpdate(body);
    } catch (error) {
      sendJson(res, { error: error.message }, 400);
      return true;
    }
    if (update.mode === 'loop' && await hasAnyPromotingSentinel({ root: context.root })) {
      sendJson(res, { error: 'cannot switch to loop while a routing finalize promotion is incomplete' }, 409);
      return true;
    }
    // The global play-mode sidecar is the new-game default only; it is never written through to the active
    // save slot. The session's live persona is the active slot's own meta variant, updated by the separate
    // slot-scoped operation (PATCH /api/slots/active/routing-persona), preserving the "settings apply at
    // game start" contract.
    const saved = await persistPlayModeSettings(settingsPath, update);
    sendJson(res, saved);
    return true;
  }

  return false;
}
