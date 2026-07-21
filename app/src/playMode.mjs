import { promises as fs } from 'node:fs';

export const PLAY_MODES = Object.freeze(['loop', 'routing']);
export const DEFAULT_PLAY_MODE = 'loop';
export const ROUTING_PERSONA_VARIANTS = Object.freeze(['fallen_star', 'bureau_apprentice', 'dethroned_constellation', 'scale_arbiter', 'pool_cat', 'far_side_sister', 'eclipse_shadow', 'hourglass_grain', 'star_egg_keeper', 'stardust_sweeper']);
export const ROUTING_HUB_SCREEN = 'interaction';

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function validatePlayMode(value) {
  if (!PLAY_MODES.includes(value)) {
    throw new Error(`mode must be one of: ${PLAY_MODES.join(', ')}`);
  }
  return value;
}

export function validateRoutingPersonaVariant(value) {
  if (!ROUTING_PERSONA_VARIANTS.includes(value)) {
    throw new Error(`routing persona variant must be one of: ${ROUTING_PERSONA_VARIANTS.join(', ')}`);
  }
  return value;
}

// Picks one routing persona variant uniformly at random from the closed set. `random` returns a float in
// [0, 1) (Math.random by default); the index is floored and clamped to the last variant so a random() of
// exactly 1 (out of contract) still maps in-range rather than reading past the end. Injectable for
// deterministic tests.
export function chooseRandomRoutingPersonaVariant(random = Math.random) {
  const index = Math.min(ROUTING_PERSONA_VARIANTS.length - 1, Math.floor(random() * ROUTING_PERSONA_VARIANTS.length));
  return ROUTING_PERSONA_VARIANTS[index];
}

// The play mode a NEW GAME always starts in: routing (the official mode) with a persona variant drawn
// uniformly at random. The play-mode sidecar is no longer consulted for the new-game mode or variant, so
// starting a loop game or picking the variant through settings is not possible; existing loop / routing
// saves keep their own persisted mode + variant untouched.
export function newGameActivePlayMode(random = Math.random) {
  return { mode: 'routing', routing_persona_variant: chooseRandomRoutingPersonaVariant(random) };
}

// Shape-only check for the PERSISTED variant on read. It must be a non-empty string, but its closed-set
// membership is intentionally NOT validated here: a persisted variant outside the current closed set
// (e.g. left by an install that predates a closed-set replacement) must not brick reading the sidecar,
// dispatching requests, or serving the settings surface. Closed-set membership is enforced on write
// (validatePlayModeUpdate) and at the point of use (buildRoutingPersona / routing meta context), so a
// stale persisted variant fails fast only when a routing operation actually needs it, and is recoverable
// by re-selecting a variant in settings. No silent default, alias, or sidecar rewrite is applied.
function validateStoredRoutingPersonaVariantShape(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('routing persona variant is required');
  }
  return value;
}

export function normalizePlayModeSettings(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('play mode settings must be an object');
  }
  const mode = validatePlayMode(config.mode);
  if (mode === 'routing') {
    return {
      mode,
      routing_persona_variant: validateStoredRoutingPersonaVariantShape(config.routing_persona_variant)
    };
  }
  if (Object.prototype.hasOwnProperty.call(config, 'routing_persona_variant')) {
    return {
      mode,
      routing_persona_variant: validateStoredRoutingPersonaVariantShape(config.routing_persona_variant)
    };
  }
  return { mode };
}

export function validatePlayModeUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('play mode update must be an object');
  }
  const mode = validatePlayMode(body.mode);
  if (mode === 'routing') {
    return {
      mode,
      routing_persona_variant: validateRoutingPersonaVariant(body.routing_persona_variant)
    };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'routing_persona_variant')) {
    return {
      mode,
      routing_persona_variant: validateRoutingPersonaVariant(body.routing_persona_variant)
    };
  }
  return { mode };
}

export async function resolveActivePlayMode(settingsPath) {
  if (!settingsPath) throw new Error('play mode settings path is required');
  let raw;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { mode: DEFAULT_PLAY_MODE };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw statusError(`play mode settings file is corrupt: ${settingsPath}`, 500);
  }
  try {
    return normalizePlayModeSettings(parsed);
  } catch (error) {
    throw statusError(`play mode settings file is invalid: ${error.message}`, 500);
  }
}

export function isRoutingActivePlayMode(activePlayMode) {
  if (!activePlayMode || typeof activePlayMode !== 'object') throw new Error('activePlayMode is required');
  return validatePlayMode(activePlayMode.mode) === 'routing';
}

export function resolvePostContentScreen({ mode, loopScreen }) {
  const normalizedMode = validatePlayMode(mode);
  if (normalizedMode === 'routing') return ROUTING_HUB_SCREEN;
  if (typeof loopScreen !== 'string' || !loopScreen) {
    throw new Error('loopScreen is required for loop mode post-content routing');
  }
  return loopScreen;
}
