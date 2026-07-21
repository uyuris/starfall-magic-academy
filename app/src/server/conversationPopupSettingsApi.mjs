import { promises as fs } from 'node:fs';
import path from 'node:path';

// Conversation popup display preferences (client-side reveal pacing) are persisted server-side, the same
// way LM Studio settings are, so they survive across revisits in both the browser shell and Electron. The
// store keeps the raw millisecond value; the settings UI constrains the user to presets, while the server
// validates type/range and fail-fasts on garbage.

// The preset values are the only accepted contract: the settings UI offers exactly these, so the API rejects
// anything else rather than widening the contract. The settings UI <option> values must match this set (a UI
// test imports this array to guard against drift).
export const CONVERSATION_POPUP_COOLDOWN_PRESETS = Object.freeze([800, 500, 300, 120]);

export const CONVERSATION_POPUP_DEFAULTS = Object.freeze({
  cooldown_ms: 500
});

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateCooldownMs(value, statusCode) {
  if (!CONVERSATION_POPUP_COOLDOWN_PRESETS.includes(value)) {
    throw statusError(`cooldown_ms must be one of the presets: ${CONVERSATION_POPUP_COOLDOWN_PRESETS.join(', ')}`, statusCode);
  }
  return value;
}

// The stored shape is the single cooldown preset. A file written before the shape narrowed may still carry
// the removed animation_ms / academy_conversation_screen keys; they are dropped on read (the shape is defined
// by what this normalize returns, not by what the file happens to hold), so an older file loads cleanly as the
// new shape. cooldown_ms itself is still validated, so a corrupt cooldown value fails fast as before.
function normalizeStoredShape(config) {
  return {
    cooldown_ms: validateCooldownMs(config.cooldown_ms, 500)
  };
}

function validateConversationPopupUpdate(body = {}) {
  return {
    cooldown_ms: validateCooldownMs(Number(body.cooldown_ms), 400)
  };
}

async function readConversationPopupSettings(settingsPath) {
  let raw;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...CONVERSATION_POPUP_DEFAULTS };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw statusError(`conversation popup settings file is corrupt: ${settingsPath}`, 500);
  }
  return normalizeStoredShape(parsed);
}

async function persistConversationPopupSettings(settingsPath, settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

function resolveSettingsPath(context) {
  if (!context.conversationPopupSettingsPath) throw new Error('conversation popup settings path is not configured');
  return context.conversationPopupSettingsPath;
}

// The backend-originated landing screen for an academy-map character conversation. Routing is the official
// mode, so this is fixed to the daytime conversation screen: a new conversation never lands on the legacy
// conversation-session screen (whose render code stays only for saves whose current_screen was persisted as
// legacy). Used by the graduation ending setup so its startEventFlagInteraction screen arg and its transition
// next_screen match where the frontend lands.
export function resolveAcademyConversationLandingScreen() {
  return 'conversation-day';
}

export function canHandleConversationPopupSettingsRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/settings/conversation-popup') return true;
  if (method === 'PATCH' && pathname === '/api/settings/conversation-popup') return true;
  return false;
}

export async function handleConversationPopupSettingsApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleConversationPopupSettingsRoute(req.method, url.pathname)) return false;
  const settingsPath = resolveSettingsPath(context);

  if (req.method === 'GET' && url.pathname === '/api/settings/conversation-popup') {
    sendJson(res, await readConversationPopupSettings(settingsPath));
    return true;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings/conversation-popup') {
    const body = await readBody(req);
    try {
      const update = validateConversationPopupUpdate(body);
      const saved = await persistConversationPopupSettings(settingsPath, update);
      sendJson(res, saved);
    } catch (error) {
      // Validation rejects carry an explicit 400; an fs-origin persist failure (EACCES etc.) has no
      // statusCode and surfaces as a 500 server failure, consistent with the outer createServer catch —
      // never mislabeled as client input 400.
      sendJson(res, { error: error.message }, error.statusCode ?? 500);
    }
    return true;
  }

  return false;
}
