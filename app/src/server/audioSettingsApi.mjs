import { promises as fs } from 'node:fs';
import path from 'node:path';

// Audio (BGM) preferences are persisted server-side, the same self-managed fs sidecar way the LM Studio,
// conversation-popup, and play-mode settings are, so they survive across revisits in both the browser shell and
// Electron. The frontend bgmController applies them to a master GainNode (on/off + master volume) without
// restarting the playing source; per-slot save state and the LM Studio config never carry audio settings.

// The stored shape is exactly these two keys. First-run (file absent) returns this documented initial state — an
// explicit contract, not a silent fallback. A file that exists but disagrees with the shape fails fast on read.
export const AUDIO_SETTINGS_DEFAULTS = Object.freeze({
  bgm_enabled: true,
  bgm_volume: 1
});

const AUDIO_SETTINGS_KEYS = Object.freeze(['bgm_enabled', 'bgm_volume']);

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// bgm_enabled is a strict boolean; bgm_volume is a strict finite number within 0..1. No coercion and no clamping:
// a wrong type or an out-of-range value is a real contract violation, raised at the caller's status code (500 for
// a corrupt persisted file, 400 for a rejected PATCH body).
function requireBgmEnabled(value, statusCode) {
  if (typeof value !== 'boolean') {
    throw statusError(`bgm_enabled must be a boolean, got ${JSON.stringify(value)}`, statusCode);
  }
  return value;
}

function requireBgmVolume(value, statusCode) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw statusError(`bgm_volume must be a number within 0..1, got ${JSON.stringify(value)}`, statusCode);
  }
  return value;
}

function requirePlainObject(value, message, statusCode) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw statusError(message, statusCode);
  }
}

function unknownKeys(value) {
  return Object.keys(value).filter((key) => !AUDIO_SETTINGS_KEYS.includes(key));
}

// The persisted file is always the full two-key shape (persist writes the whole object). On read it is validated
// strictly: exact key set, both keys present, both values valid. Any deviation is corruption → 500, never a silent
// reset to the defaults.
function validateStoredShape(config, settingsPath) {
  requirePlainObject(config, `audio settings file is malformed (not a JSON object): ${settingsPath}`, 500);
  const unknown = unknownKeys(config);
  if (unknown.length) {
    throw statusError(`audio settings file has unknown keys (${unknown.join(', ')}): ${settingsPath}`, 500);
  }
  for (const key of AUDIO_SETTINGS_KEYS) {
    if (!Object.hasOwn(config, key)) {
      throw statusError(`audio settings file is missing ${key}: ${settingsPath}`, 500);
    }
  }
  return {
    bgm_enabled: requireBgmEnabled(config.bgm_enabled, 500),
    bgm_volume: requireBgmVolume(config.bgm_volume, 500)
  };
}

// PATCH accepts a partial update (either or both keys). Unknown keys, wrong types, and out-of-range values are
// rejected with 400 (never clamped or silently dropped); an empty update is rejected too.
function validateAudioUpdate(body) {
  requirePlainObject(body, 'audio settings update must be a JSON object', 400);
  const unknown = unknownKeys(body);
  if (unknown.length) {
    throw statusError(`unknown audio settings keys: ${unknown.join(', ')}`, 400);
  }
  const update = {};
  if (Object.hasOwn(body, 'bgm_enabled')) update.bgm_enabled = requireBgmEnabled(body.bgm_enabled, 400);
  if (Object.hasOwn(body, 'bgm_volume')) update.bgm_volume = requireBgmVolume(body.bgm_volume, 400);
  if (Object.keys(update).length === 0) {
    throw statusError('audio settings update must set bgm_enabled and/or bgm_volume', 400);
  }
  return update;
}

async function readAudioSettings(settingsPath) {
  let raw;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...AUDIO_SETTINGS_DEFAULTS };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw statusError(`audio settings file is corrupt (invalid JSON): ${settingsPath}`, 500);
  }
  return validateStoredShape(parsed, settingsPath);
}

async function persistAudioSettings(settingsPath, settings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, settingsPath);
  return settings;
}

function resolveSettingsPath(context) {
  if (!context.audioSettingsPath) throw new Error('audio settings path is not configured');
  return context.audioSettingsPath;
}

export function canHandleAudioSettingsRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/settings/audio') return true;
  if (method === 'PATCH' && pathname === '/api/settings/audio') return true;
  return false;
}

export async function handleAudioSettingsApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleAudioSettingsRoute(req.method, url.pathname)) return false;
  const settingsPath = resolveSettingsPath(context);

  if (req.method === 'GET' && url.pathname === '/api/settings/audio') {
    // A corrupt persisted file throws a 500 statusError here; the server's outer handler serializes it. We never
    // swallow it back to the defaults.
    sendJson(res, await readAudioSettings(settingsPath));
    return true;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings/audio') {
    const body = await readBody(req);
    try {
      const update = validateAudioUpdate(body);
      // Merge the partial update onto the current persisted shape, then write the whole object back so the file
      // stays the full two-key shape. A corrupt current file surfaces as a 500 here rather than being overwritten.
      const current = await readAudioSettings(settingsPath);
      const saved = await persistAudioSettings(settingsPath, { ...current, ...update });
      sendJson(res, saved);
    } catch (error) {
      // Validation rejects carry an explicit 400 (see validateAudioUpdate); an fs-origin persist failure
      // (EACCES etc.) has no statusCode and surfaces as a 500 server failure, consistent with the outer
      // createServer catch — never mislabeled as client input 400.
      sendJson(res, { error: error.message }, error.statusCode ?? 500);
    }
    return true;
  }

  return false;
}
