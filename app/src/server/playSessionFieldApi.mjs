import { evaluateLocationsForState, moveToLocation, ensureSanrinCreaturePlacements, validateSanrinCreaturePlacements } from '../fieldRuntime.mjs';
import { initializeNewPlayArea } from '../playSession.mjs';
import { creatureEncounterSummary, listCreatureEncounterSummaries } from '../creatureCatalog.mjs';
import { createStorageApi } from '../storage.mjs';
import { resolveNewGameScreenRouting } from './playModeRouting.mjs';

function storageFor(root) {
  return createStorageApi({ root });
}

async function readJson(root, relativePath) {
  return storageFor(root).readJson(relativePath);
}

function sendNoActiveSlot(res, sendJson) {
  return sendJson(res, {
    error: 'No active save slot is available. Start a new game or load a valid save slot.',
    error_code: 'NO_ACTIVE_SLOT'
  }, 409);
}

// Derives the current location's creature from the fixed Sanrin placement and enriches it
// (field response only — never the persisted state or /api/state) with the catalog summary,
// so arriving at a Sanrin location shows its assigned creature and can start the conversation.
// The placement is fixed (drawn at new game, re-drawn weekly), so re-visiting a location
// shows the same creature instead of a fresh per-move roll.
async function stateWithCurrentCreatureEncounter({ root, state }) {
  // A present but malformed placement is corrupted state and fails fast (never suppressed).
  const placements = validateSanrinCreaturePlacements(state.sanrin_creature_placements);
  const locationId = state.current_location_id;
  const creatureId = placements === undefined ? undefined : placements[locationId];
  // The field encounter is derived from the fixed placement alone; strip any legacy
  // persisted creature_encounter so the destructive replacement leaves no stale trace.
  const { creature_encounter: _legacyEncounter, ...withoutLegacyEncounter } = state;
  if (!creatureId) return withoutLegacyEncounter;
  return {
    ...withoutLegacyEncounter,
    creature_encounter: {
      location_id: locationId,
      creature_id: creatureId,
      status: 'available',
      creature_summary: await creatureEncounterSummary({ root, creatureId })
    }
  };
}

export function canHandlePlaySessionFieldApiRoute(method, pathname) {
  return (
    isNewGameRoute(method, pathname) ||
    (method === 'GET' && pathname === '/api/creatures') ||
    (method === 'GET' && pathname === '/api/state') ||
    (method === 'GET' && pathname === '/api/field') ||
    (method === 'POST' && pathname === '/api/field/move')
  );
}

export function isNewGameRoute(method, pathname) {
  return method === 'POST' && pathname === '/api/new-game';
}

export async function handlePlaySessionFieldApi({ req, res, url, context, sendJson, readBody }) {
  if (req.method === 'POST' && url.pathname === '/api/new-game') {
    // A new game is always routing with a uniformly-random persona variant — the play-mode sidecar (and any
    // settings-chosen mode/variant) is deliberately not consulted here.
    const routing = resolveNewGameScreenRouting({ loopScreen: 'academy-map' });
    const playSession = await initializeNewPlayArea({
      root: context.root,
      playMode: routing.active_play_mode.mode,
      routingPersonaVariant: routing.active_play_mode.routing_persona_variant
    });
    context.activeRoot = playSession.root;
    return sendJson(res, {
      area: playSession.area,
      slot: playSession.slot,
      state: playSession.state,
      player_parameters: playSession.player_parameters,
      ...routing
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/creatures') {
    // The full creature roster is authoring-canonical (content/creatures under the
    // project root) and independent of play state, so it does not require an active slot.
    return sendJson(res, { creatures: await listCreatureEncounterSummaries({ root: context.root }) });
  }

  if (!context.activeRoot) return sendNoActiveSlot(res, sendJson);
  const root = context.activeRoot;

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, await readJson(root, 'game_data/runtime_state.json'));
  }

  if (req.method === 'GET' && url.pathname === '/api/field') {
    // Opening the field/map fixes the Sanrin creature placement if it is not set yet
    // (ensure-if-unassigned, then fixed — same shape as the academy map fixing its stage
    // occupants on open); a new week re-draws it via /api/academy/week/start.
    await ensureSanrinCreaturePlacements({ root });
    const [state, locations] = await Promise.all([
      readJson(root, 'game_data/runtime_state.json'),
      readJson(root, 'game_data/locations.json')
    ]);
    const responseState = await stateWithCurrentCreatureEncounter({ root, state });
    // One full-catalog evaluation: academy_stage_situations is validated against the whole location set
    // (an unknown stage key must fail fast, which a per-location subset could not detect), and the current
    // location is taken from that same evaluated set. An event-screen current location is filtered out of
    // the evaluated field, so it falls back to its raw authored form.
    const evaluatedLocations = evaluateLocationsForState({ state: responseState, locations });
    const currentLocationRaw = locations.find((location) => location.id === state.current_location_id) ?? null;
    const currentLocation = evaluatedLocations.find((location) => location.id === state.current_location_id) ?? currentLocationRaw;
    return sendJson(res, { state: responseState, current_location: currentLocation, locations: evaluatedLocations });
  }

  if (req.method === 'POST' && url.pathname === '/api/field/move') {
    const body = await readBody(req);
    return sendJson(res, await moveToLocation({
      root,
      locationId: body.location_id,
      selectedVisibleSituation: body.selected_visible_situation
    }));
  }
}
