// Arena tournament session: the storage-facing feature owner between the pure tournament state machine
// (arenaTournament.mjs) and the thin HTTP surface (server/arenaApi.mjs). It gathers the entry-snapshot
// descriptors (protagonist / buddy / opponent parameters, equipment, MP-reserve line — the same entry
// snapshot discipline as a dungeon run, so a mid-week equip / reserve change never touches an in-progress
// tournament), builds and persists the weekly bracket, drives the player's interactive matches through the
// engine, resolves NPC matches deterministically, and grants the win-count reward exactly once on conclude.

import { createStorageApi } from '../storage.mjs';
import { loadWorldSettings } from '../worldSettings.mjs';
import { normalizeParameters } from '../parameters.mjs';
import { PLAYER_EQUIP_TARGET, resolveRunEquipment } from '../equipment.mjs';
import { loadMpReserveSurface, mpReservePercentFor, MP_RESERVE_INITIAL_PERCENT } from '../mpReserve.mjs';
import { listSelectableCharacters, isSelectableCharacterId } from '../characterCatalog.mjs';
import { isHomunculusIdFormat } from '../companionRoster.mjs';
import { resolveActiveHomunculusActor, resolveCurrentBuddySummary } from '../buddyResolution.mjs';
import { loadDungeonMaterialDefinitions, dungeonMaterialDisplayNames } from '../dungeonMaterialCatalog.mjs';
import { applyPlayerMoneyDelta, depositDungeonMaterials } from '../economy.mjs';
import { loadRunConsumables } from '../dungeon/combatConsumables.mjs';
import { buildArenaContentResult, ROUTING_CONTENT_RESULT_STATE_KEY } from '../routingContentResult.mjs';
import { generateArenaIntro, generateArenaResultFlavor } from '../llm/arenaGeneration.mjs';
import { createArenaMatch, arenaMatchView, arenaStep, runArenaMatchAuto } from './arenaEngine.mjs';
import {
  ARENA_BRACKET_UNIT_COUNT, ARENA_MODES,
  arenaWeekSeed, arenaUnitSizeForMode, selectArenaOpponentCharacterIds, assembleArenaUnits,
  createArenaTournamentSlot, readArenaTournamentSlot, validateArenaTournamentSlot,
  advanceArenaTournament, findPlayerCurrentMatch, arenaMatchTeams, recordPlayerMatchWinner,
  isArenaTournamentTerminal, arenaTournamentOutcome, arenaTournamentWins, computeArenaReward,
  arenaTournamentView, findArenaReplayMatch, ARENA_TOURNAMENT_STATE_KEY,
  arenaIntroPromptInputs, arenaResultPromptInputs, arenaMatchIntro, setArenaMatchIntro,
  arenaResultFlavor, setArenaResultFlavor
} from './arenaTournament.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function assertPostContentScreen(postContentScreen) {
  // The return-to-hub screen is owned by the caller (C-02 play-mode), never defaulted here (fail-fast).
  if (typeof postContentScreen !== 'string' || !postContentScreen) {
    throw new Error('arena postContentScreen is required');
  }
  return postContentScreen;
}

function arenaWeekFromState(state) {
  const week = state?.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw new Error('arena requires runtime_state.elapsed_weeks to be a non-negative integer');
  }
  return week;
}

function currentBuddyId(state) {
  const raw = state?.current_buddy_character_id ?? null;
  if (raw === null) return null;
  if (typeof raw !== 'string' || !raw) throw new Error('runtime_state.current_buddy_character_id must be a non-empty string or null');
  return raw;
}

function arenaRewardConversationKey(week) {
  return `arena:reward:${week}`;
}

// ----- runtime_state write serialization (per root) -----
//
// runtime_state.json is written with a plain read-modify-write (no storage-level lock, and the HTTP server does
// not serialize requests). The flavor writers (intro / result) are the FIRST arena writers that can run
// concurrently with a match action: the intro fetch is deliberately outside the frontend action single-flight, so
// its persist can interleave with — and silently revert (lost update) — an action's bracket-advance / terminal
// commit (`concluded`+`rewards_paid`+`content_result`), which would violate the terminal-atomicity invariant.
// This per-root async mutex serializes every arena runtime_state read-modify-write, so a flavor persist and an
// action/terminal write can never interleave. LM generation stays OUTSIDE the lock (only the short persist is
// serialized), so a 1〜3s 生成 never blocks combat input. concludeArenaTournament is only ever called from within
// an already-locked action/enter section, so it does not take the lock itself (no re-entrancy / deadlock).
const arenaWriteChains = new Map();
export function withArenaWriteLock(root, fn) {
  const prior = arenaWriteChains.get(root) ?? Promise.resolve();
  const run = prior.then(fn, fn); // run regardless of a prior section's outcome — a prior failure must not stall the chain
  arenaWriteChains.set(root, run.then(() => {}, () => {})); // the stored tail never rejects the next waiter
  return run;
}

// ----- entry-snapshot descriptor gathering -----

async function resolveArenaBuddyInput({ root, state, characters, surface, buddyId }) {
  if (isHomunculusIdFormat(buddyId)) {
    // A homunculus buddy must be active (resolveActiveHomunculusActor throws otherwise) — never a silent drop.
    const actor = await resolveActiveHomunculusActor({ root, homunculusId: buddyId });
    return {
      character_id: actor.homunculus_id,
      display_name: actor.display_name,
      kind: 'homunculus',
      parameters: actor.parameters,
      equipment: await resolveRunEquipment({ root, state, target: buddyId }),
      mp_reserve_percent: mpReservePercentFor(surface, buddyId)
    };
  }
  const summary = characters.find((candidate) => candidate.character_id === buddyId);
  if (!summary) throw statusError(`arena buddy is not a known selectable character: ${buddyId}`, 409, { errorCode: 'unknown_buddy' });
  return {
    character_id: buddyId,
    display_name: summary.display_name,
    kind: 'character',
    parameters: normalizeParameters(summary.parameters),
    equipment: await resolveRunEquipment({ root, state, target: buddyId }),
    mp_reserve_percent: mpReservePercentFor(surface, buddyId)
  };
}

function resolveArenaOpponentInputs({ state, characters, surface, buddyId, mode, seed }) {
  const excluded = new Set(buddyId ? [buddyId] : []);
  const pool = characters.filter((candidate) => !excluded.has(candidate.character_id));
  const summaryById = new Map(pool.map((candidate) => [candidate.character_id, candidate]));
  const poolIds = pool.map((candidate) => candidate.character_id);
  const rawEnemies = Array.isArray(state?.current_enemy_character_ids) ? state.current_enemy_character_ids : [];
  const enemyIds = [];
  for (const enemyId of rawEnemies) {
    const normalized = String(enemyId ?? '').trim();
    if (!normalized) continue;
    if (excluded.has(normalized)) continue; // the buddy is never drafted as an opponent, even if flagged an enemy.
    if (!isSelectableCharacterId(normalized)) {
      throw new Error(`arena enemy id is not a selectable character: ${normalized}`);
    }
    enemyIds.push(normalized);
  }
  const count = (ARENA_BRACKET_UNIT_COUNT - 1) * arenaUnitSizeForMode(mode);
  const selectedIds = selectArenaOpponentCharacterIds({ seed, pool: poolIds, enemyIds, count });
  return selectedIds.map((characterId) => {
    const summary = summaryById.get(characterId);
    if (!summary) throw new Error(`arena opponent id resolved to no roster summary: ${characterId}`);
    return {
      character_id: characterId,
      display_name: summary.display_name,
      parameters: normalizeParameters(summary.parameters),
      mp_reserve_percent: mpReservePercentFor(surface, characterId)
    };
  });
}

// ----- mode availability / state view -----

function arenaModeAvailability(hasBuddy) {
  return ARENA_MODES.map((mode) => {
    const requiresBuddy = mode === 'pair' || mode === 'spectate';
    const available = !requiresBuddy || hasBuddy;
    return { mode, available, reason: available ? null : 'no_buddy' };
  });
}

// A homunculus entrant is not in the selectable roster, so the front end cannot resolve its face the way it does
// for a `character` actor (roster lookup by actor_id). We enrich the view actors with the homunculus's face_url
// from the atelier — additive to the actor shape, `character`/`protagonist` untouched. The parameters are already
// projected by the pure view (from the persisted snapshot); only the face_url needs the root-bearing read path.
// Resolution failures throw (resolveActiveHomunculusActor never silently drops a missing homunculus).
function arenaHomunculusFaceResolver({ root }) {
  const cache = new Map();
  return async (homunculusId) => {
    if (cache.has(homunculusId)) return cache.get(homunculusId);
    const actor = await resolveActiveHomunculusActor({ root, homunculusId });
    cache.set(homunculusId, actor.face_url);
    return actor.face_url;
  };
}

async function enrichArenaActorFaces(resolve, actors) {
  if (!Array.isArray(actors)) return;
  for (const actor of actors) {
    if (actor && actor.kind === 'homunculus') actor.face_url = await resolve(actor.actor_id);
  }
}

// Walks any arena view shape (tournament state with units + current_match, or a bare match view with actors) and
// fills each homunculus actor's face_url. Returns the same view (mutated in place — the projections build fresh
// objects, so no shared state is aliased).
async function enrichArenaViewHomunculusFaces({ root, view }) {
  const resolve = arenaHomunculusFaceResolver({ root });
  if (Array.isArray(view.units)) {
    for (const unit of view.units) await enrichArenaActorFaces(resolve, unit.actors);
  }
  if (view.current_match) await enrichArenaActorFaces(resolve, view.current_match.actors);
  await enrichArenaActorFaces(resolve, view.actors);
  return view;
}

async function arenaTournamentStateView({ root, authoringRoot, state, slot }) {
  const base = arenaTournamentView(slot);
  let currentMatch = null;
  if (slot.current_match) {
    const consumables = await loadRunConsumables(root);
    currentMatch = arenaMatchView(slot.current_match, { consumables });
  }
  return await enrichArenaViewHomunculusFaces({ root, view: { phase: 'tournament', ...base, current_match: currentMatch } });
}

// The arena state: the participate-form selection view when no tournament is built for this week, else the
// bracket (with the player's live match view attached when one is in progress).
export async function getArenaState({ root, authoringRoot }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = arenaWeekFromState(state);
  const slot = readArenaTournamentSlot(state);
  if (slot && slot.week === week) {
    return await arenaTournamentStateView({ root, authoringRoot, state, slot });
  }
  const buddy = await resolveCurrentBuddySummary({ root, authoringRoot });
  return {
    phase: 'selection',
    week,
    modes: arenaModeAvailability(buddy !== null),
    buddy: buddy ? { character_id: buddy.character_id, display_name: buddy.display_name, kind: buddy.kind } : null
  };
}

// ----- enter -----

export async function enterArenaTournament(params) {
  return withArenaWriteLock(params.root, () => enterArenaTournamentImpl(params));
}

async function enterArenaTournamentImpl({ root, authoringRoot, mode, postContentScreen, now = new Date().toISOString() }) {
  if (!ARENA_MODES.includes(mode)) throw statusError(`arena mode must be one of ${ARENA_MODES.join('/')}: ${mode}`, 400, { errorCode: 'invalid_mode' });
  assertPostContentScreen(postContentScreen);
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = arenaWeekFromState(state);
  const existing = readArenaTournamentSlot(state);
  if (existing && existing.week === week) {
    throw statusError('an arena tournament is already entered this week', 409, { errorCode: 'already_entered' });
  }
  const buddyId = currentBuddyId(state);
  if ((mode === 'pair' || mode === 'spectate') && !buddyId) {
    throw statusError(`arena ${mode} mode requires a buddy`, 409, { errorCode: 'no_buddy' });
  }

  const characters = await listSelectableCharacters({ root, authoringRoot });
  const surface = await loadMpReserveSurface({ root });
  const world = await loadWorldSettings({ root });
  const seed = arenaWeekSeed(week);

  const protagonist = {
    parameters: normalizeParameters(world.player_parameters),
    equipment: await resolveRunEquipment({ root, state, target: PLAYER_EQUIP_TARGET }),
    // The protagonist is player-controlled in solo/pair (the reserve line is an AI-only behavior), and never
    // fields in spectate; the entry snapshot carries the spec initial value.
    mp_reserve_percent: MP_RESERVE_INITIAL_PERCENT
  };
  const buddy = mode === 'solo'
    ? null
    : await resolveArenaBuddyInput({ root, state, characters, surface, buddyId });
  const opponents = resolveArenaOpponentInputs({ state, characters, surface, buddyId, mode, seed });

  const { playerUnit, opponentUnits } = assembleArenaUnits({ mode, protagonist, buddy, opponents });
  const slot = createArenaTournamentSlot({ seed, week, mode, playerUnit, opponentUnits });
  await advanceArenaTournament(slot, { root });

  if (isArenaTournamentTerminal(slot)) {
    // Spectate resolves the whole bracket at entry (the buddy is AI): conclude + pay now, but keep the player
    // on the arena screen so they can watch the replays. Return-to-hub is the frontend's move afterward.
    const concluded = await concludeArenaTournament({ root, slot, postContentScreen, now, setScreen: false });
    const latest = await storage.readJson(RUNTIME_STATE_PATH);
    return await arenaTournamentStateView({ root, authoringRoot, state: latest, slot: concluded.slot });
  }

  const nextState = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, { ...nextState, current_screen: 'academy-arena', [ARENA_TOURNAMENT_STATE_KEY]: slot });
  return await arenaTournamentStateView({ root, authoringRoot, state: nextState, slot });
}

// ----- conclude + reward (idempotent) -----

// Grants the win-count reward once and marks the tournament concluded. money uses the economy's synthetic-key
// idempotency (a retry never re-pays); materials are additive and gated on rewards_paid. The concluded status,
// rewards_paid marker, outcome, stored content-result detail, the routing content-result record, and (when
// setScreen) the return screen are bound into ONE runtime_state write — the commit point — so a crash before
// it leaves the tournament re-runnable rather than half-concluded. An already-concluded slot is a no-op.
export async function concludeArenaTournament({ root, slot, postContentScreen, now = new Date().toISOString(), setScreen }) {
  validateArenaTournamentSlot(slot);
  assertPostContentScreen(postContentScreen);
  if (typeof setScreen !== 'boolean') throw new Error('arena conclude setScreen must be a boolean');
  if (slot.status === 'concluded') return { slot, record: null, alreadyConcluded: true };
  if (!isArenaTournamentTerminal(slot)) throw new Error('cannot conclude an arena tournament that is not terminal');

  const wins = arenaTournamentWins(slot);
  const outcome = arenaTournamentOutcome(slot);
  const reward = computeArenaReward({ seed: slot.seed, wins });
  const displayNames = dungeonMaterialDisplayNames(await loadDungeonMaterialDefinitions({ root }));
  const detailMaterials = reward.materials.map((material) => {
    const displayName = displayNames.get(material.item_id);
    if (!displayName) throw new Error(`arena reward material has no catalog display name: ${material.item_id}`);
    return { item_id: material.item_id, display_name: displayName, quantity: material.quantity };
  });

  if (!slot.rewards_paid) {
    if (reward.money > 0) {
      await applyPlayerMoneyDelta({ root, conversationId: arenaRewardConversationKey(slot.week), delta: reward.money });
    }
    if (reward.materials.length > 0) {
      await depositDungeonMaterials({
        root,
        materials: Object.fromEntries(reward.materials.map((material) => [material.item_id, material.quantity]))
      });
    }
  }

  const record = buildArenaContentResult({
    week: slot.week,
    now,
    outcome,
    mode: slot.mode,
    wins,
    prizeMoney: reward.money,
    materials: detailMaterials
  });
  const concludedSlot = validateArenaTournamentSlot({
    ...slot,
    status: 'concluded',
    rewards_paid: true,
    current_match: null,
    current_match_id: null,
    outcome,
    content_result: record.detail
  });
  const storage = createStorageApi({ root });
  const latest = await storage.readJson(RUNTIME_STATE_PATH);
  const nextState = {
    ...latest,
    [ARENA_TOURNAMENT_STATE_KEY]: concludedSlot,
    [ROUTING_CONTENT_RESULT_STATE_KEY]: record
  };
  if (setScreen) nextState.current_screen = postContentScreen;
  await storage.writeJson(RUNTIME_STATE_PATH, nextState);
  return { slot: concludedSlot, record, alreadyConcluded: false };
}

// ----- interactive player match -----

function loadActiveSlot(state, { requireNotConcluded = true } = {}) {
  const slot = readArenaTournamentSlot(state);
  if (!slot) throw statusError('no arena tournament is in progress', 409, { errorCode: 'no_tournament' });
  if (requireNotConcluded && slot.status === 'concluded') {
    throw statusError('the arena tournament is already concluded', 409, { errorCode: 'concluded' });
  }
  return slot;
}

export async function startArenaMatch(params) {
  return withArenaWriteLock(params.root, () => startArenaMatchImpl(params));
}

async function startArenaMatchImpl({ root, authoringRoot }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const slot = loadActiveSlot(state);
  if (slot.mode === 'spectate') throw statusError('spectate mode has no player match to start', 409, { errorCode: 'spectate_no_match' });

  if (slot.current_match) {
    // Resume: a match is already in progress (e.g. after a reload) — return it without recreating.
    const consumables = await loadRunConsumables(root);
    return {
      view: await enrichArenaViewHomunculusFaces({ root, view: arenaMatchView(slot.current_match, { consumables }) }),
      tournament: await arenaTournamentStateView({ root, authoringRoot, state, slot })
    };
  }

  const playerMatch = findPlayerCurrentMatch(slot);
  if (!playerMatch) throw statusError('the player has no arena match to play right now', 409, { errorCode: 'no_player_match' });
  const { teamA, teamB } = arenaMatchTeams(slot, playerMatch);
  const match = createArenaMatch({ seed: playerMatch.seed, teamA, teamB });
  slot.current_match = match;
  slot.current_match_id = playerMatch.match_id;
  const persistState = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, { ...persistState, [ARENA_TOURNAMENT_STATE_KEY]: slot });
  const consumables = await loadRunConsumables(root);
  return {
    view: await enrichArenaViewHomunculusFaces({ root, view: arenaMatchView(match, { consumables }) }),
    tournament: await arenaTournamentStateView({ root, authoringRoot, state: persistState, slot })
  };
}

export async function applyArenaMatchAction(params) {
  return withArenaWriteLock(params.root, () => applyArenaMatchActionImpl(params));
}

async function applyArenaMatchActionImpl({ root, authoringRoot, action, postContentScreen, now = new Date().toISOString() }) {
  assertPostContentScreen(postContentScreen);
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const slot = loadActiveSlot(state);
  if (!slot.current_match) throw statusError('no arena match is in progress', 409, { errorCode: 'no_active_match' });

  const result = await arenaStep({ root, match: slot.current_match, action });
  slot.current_match = result.match;
  await enrichArenaViewHomunculusFaces({ root, view: result.view }); // fills homunculus face_url for all return paths

  if (result.match.status === 'active') {
    const persistState = await storage.readJson(RUNTIME_STATE_PATH);
    await storage.writeJson(RUNTIME_STATE_PATH, { ...persistState, [ARENA_TOURNAMENT_STATE_KEY]: slot });
    return {
      view: result.view,
      events: result.events,
      concluded: false,
      tournament: await arenaTournamentStateView({ root, authoringRoot, state: persistState, slot })
    };
  }

  // The player's match resolved: record the winner, advance the bracket (auto-resolving the newly reachable
  // NPC matches), and conclude if the tournament is now terminal.
  const matchId = slot.current_match_id;
  recordPlayerMatchWinner(slot, matchId, result.match.winner);
  await advanceArenaTournament(slot, { root });

  if (isArenaTournamentTerminal(slot)) {
    const concluded = await concludeArenaTournament({ root, slot, postContentScreen, now, setScreen: true });
    const latest = await storage.readJson(RUNTIME_STATE_PATH);
    return {
      view: result.view,
      events: result.events,
      concluded: true,
      content_result: concluded.record.detail,
      post_content_screen: postContentScreen,
      tournament: await arenaTournamentStateView({ root, authoringRoot, state: latest, slot: concluded.slot })
    };
  }

  const persistState = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, { ...persistState, [ARENA_TOURNAMENT_STATE_KEY]: slot });
  return {
    view: result.view,
    events: result.events,
    concluded: false,
    tournament: await arenaTournamentStateView({ root, authoringRoot, state: persistState, slot })
  };
}

// ----- spectator replay -----

export async function replayArenaMatch({ root, matchId }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const slot = readArenaTournamentSlot(state);
  if (!slot) throw statusError('no arena tournament is in progress', 404, { errorCode: 'no_tournament' });
  const match = findArenaReplayMatch(slot, matchId);
  const { teamA, teamB } = arenaMatchTeams(slot, match);
  const result = await runArenaMatchAuto({ root, seed: match.seed, teamA, teamB });
  // Spectate-mode replays can feature a homunculus buddy fighting solo — fill each turn's homunculus face_url.
  const resolve = arenaHomunculusFaceResolver({ root });
  for (const turn of result.turns) await enrichArenaActorFaces(resolve, turn.view.actors);
  return {
    match_id: match.match_id,
    round: match.round,
    winner_unit_id: match.winner_unit_id,
    seed: match.seed,
    turns: result.turns
  };
}

// ----- LLM flavor (試合前口上 / 優勝・敗退実況一文) -----
//
// Both surfaces are INDEPENDENT of the combat / reward / terminal commit: they only read the resolved bracket and
// idempotently persist the generated text back into the slot's flavor fields. A generation failure (structured
// 503) writes nothing — the tournament, its rewards, and its content result are untouched, so an unconfigured /
// unreachable LM leaves every non-flavor arena flow intact. The first generation is the persisted truth; a
// re-request for a match/tournament that already has flavor returns the stored value without calling the model.

// Generates (or returns the persisted) 口上 for a player-facing match — the player's current match or a resolved
// auto (spectator-replayable) match. Persists idempotently; the visit's prior intros feed the 散らし handoff.
export async function generateArenaMatchIntro({ root, config, fetchImpl, matchId }) {
  if (!config) throw new Error('lmStudioConfig is required for arena match intro');
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const slot = readArenaTournamentSlot(state);
  if (!slot) throw statusError('no arena tournament is in progress', 409, { errorCode: 'no_tournament' });

  const persisted = arenaMatchIntro(slot, matchId);
  if (persisted) return { match_id: matchId, intro: persisted };

  // arenaIntroPromptInputs validates the match is player-facing (statusCode on a non-viewable / undetermined id).
  const inputs = arenaIntroPromptInputs(slot, matchId);
  const intro = await generateArenaIntro({ config, fetchImpl, ...inputs }); // LM call OUTSIDE the write lock

  // Persist under the write lock so the read-latest→merge→write can never interleave with an action / terminal
  // write (which would silently revert it). Only the match_intros key is added onto whatever the latest slot is.
  return withArenaWriteLock(root, async () => {
    const latestState = await storage.readJson(RUNTIME_STATE_PATH);
    const latestSlot = readArenaTournamentSlot(latestState);
    if (!latestSlot) throw statusError('no arena tournament is in progress', 409, { errorCode: 'no_tournament' });
    const already = arenaMatchIntro(latestSlot, matchId);
    if (already) return { match_id: matchId, intro: already }; // a concurrent request already persisted it
    const updated = setArenaMatchIntro(latestSlot, matchId, intro);
    await storage.writeJson(RUNTIME_STATE_PATH, { ...latestState, [ARENA_TOURNAMENT_STATE_KEY]: updated });
    return { match_id: matchId, intro: arenaMatchIntro(updated, matchId) };
  });
}

// Generates (or returns the persisted) 実況一文 for the concluded tournament. Only available once the tournament is
// terminal (a non-terminal request is an explicit 409, never a fabricated result).
export async function generateArenaTournamentResultFlavor({ root, config, fetchImpl }) {
  if (!config) throw new Error('lmStudioConfig is required for arena result flavor');
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const slot = readArenaTournamentSlot(state);
  if (!slot) throw statusError('no arena tournament is in progress', 409, { errorCode: 'no_tournament' });
  if (!isArenaTournamentTerminal(slot)) {
    throw statusError('the arena tournament result is not available until it concludes', 409, { errorCode: 'not_terminal' });
  }

  const persisted = arenaResultFlavor(slot);
  if (persisted) return { outcome: arenaTournamentOutcome(slot), flavor: persisted };

  const inputs = arenaResultPromptInputs(slot);
  const flavor = await generateArenaResultFlavor({ config, fetchImpl, ...inputs }); // LM call OUTSIDE the write lock

  return withArenaWriteLock(root, async () => {
    const latestState = await storage.readJson(RUNTIME_STATE_PATH);
    const latestSlot = readArenaTournamentSlot(latestState);
    if (!latestSlot) throw statusError('no arena tournament is in progress', 409, { errorCode: 'no_tournament' });
    const already = arenaResultFlavor(latestSlot);
    if (already) return { outcome: arenaTournamentOutcome(latestSlot), flavor: already };
    const updated = setArenaResultFlavor(latestSlot, flavor);
    await storage.writeJson(RUNTIME_STATE_PATH, { ...latestState, [ARENA_TOURNAMENT_STATE_KEY]: updated });
    return { outcome: arenaTournamentOutcome(updated), flavor: arenaResultFlavor(updated) };
  });
}
