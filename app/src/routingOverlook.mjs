// 星見の窓 (overlook): the routing destination's feature owner. It composes the persistent surface
// (overlookState), the deterministic field (overlookField), the two-child talk (overlookConversation) and the
// injected LM generators (llm/overlookGeneration) into one entry session: arrival, the academy clock, the loop of
// wishes → walks → encounters → talks → rewritten states → new wishes, the one-line writings, the 顔ぶれ send-off
// (one child out through the gate, a newcomer in), and the exit that hands the hub its content result. The HTTP
// surface (server/overlookApi.mjs) stays thin.
//
// Clock: the session clock is the server's; each request (and each finished LM job) steps the field up to "now"
// before it reads or changes anything, so the field advances whether or not anyone polls, in whole ticks, and a
// test drives it with an injected clock. The field ends at 15:00.
//
// LM work runs through two lanes: `focus` (the watched talk: its seed, every line, and the two rewrites and two
// wishes after it closes) and `background` (everything else: the one resolution call of an unwatched encounter —
// seed included — and its two wishes, 湧き, wishes after a writing, the wishes a send-off calls for). Each lane
// runs one job at a time, and when both have work the focus job starts first. A finished job applies its result
// at once (the field is stepped to the completion time first). A cancelled job's result is discarded, and so is
// its failure. Any other job failure ends the session: every later call rethrows that error (an LM 503 surfaces
// as the 503 the settings route handles).
//
// The session lives in process memory, keyed by the slot root; only the surface (roster + child states) is
// persisted. Re-entering starts a fresh session at 9:00 with the same 12 children.

import { listSelectableCharacterChoices, selectableCharacterPromptProfile } from './characterCatalog.mjs';
import { buildConversationActorContextSnapshot } from './llm/conversationActorContext.mjs';
import { runIndependentBundle } from './llm/llmConcurrency.mjs';
import { OVERLOOK_DONE_CONCERN_PREFIX } from './llm/overlookGeneration.mjs';
import { loadWorldSettings } from './worldSettings.mjs';
import {
  addOverlookConcern,
  ensureOverlookRoster,
  loadOverlookSurface,
  replaceOverlookRosterMember,
  writeOverlookSurface
} from './overlookState.mjs';
import {
  OVERLOOK_END_TICK,
  OVERLOOK_GATE_PLACE_ID,
  OVERLOOK_TICKS_PER_ACADEMY_MINUTE,
  OVERLOOK_TICK_MS,
  OVERLOOK_WISH_DURATION_MINUTES,
  createOverlookField,
  formatOverlookMinute,
  holdOverlookChild,
  listOverlookApproachingPairs,
  loadOverlookFieldGraph,
  overlookChildFieldView,
  overlookChildGatePhase,
  overlookChildPoint,
  overlookMinuteAtTick,
  overlookPlaceAt,
  overlookWishOnArrival,
  rankOverlookFocusCandidates,
  sendOverlookChildOff,
  setOverlookChildWish,
  stepOverlookField
} from './overlookField.mjs';
import {
  createOverlookConversation,
  overlookConversationClosed,
  overlookConversationView,
  runOverlookConversationTurn
} from './overlookConversation.mjs';
import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  buildOverlookContentResult,
  requireRoutingContentWeek
} from './routingContentResult.mjs';

export const OVERLOOK_DESTINATION_ID = 'overlook';
export const OVERLOOK_WRITING_MAX_CHARS = 40;
// One line per academy hour; a line reaches the children in its place's radius when written and, for the next
// academy hour, up to OVERLOOK_WRITING_LATE_READERS children who walk into that place.
export const OVERLOOK_WRITING_INTERVAL_MINUTES = 60;
export const OVERLOOK_WRITING_LATE_READERS = 3;
// A trace shows only unwatched encounters that closed since the viewer last returned to the field: each return
// clears the traces that closed before the previous one, and a trace also fades once the field has been watched
// for one academy hour since it closed (the time a talk is on screen does not count).
export const OVERLOOK_TRACE_WATCHED_MINUTES = 60;
const TRACE_WATCHED_TICKS = OVERLOOK_TRACE_WATCHED_MINUTES * OVERLOOK_TICKS_PER_ACADEMY_MINUTE;

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';
const LOCATIONS_PATH = 'game_data/locations.json';
const GENERATOR_NAMES = ['decideWish', 'generateSeed', 'generateUtterance', 'judgeOutcome', 'judgeStagnation', 'rewriteState', 'resolveOffscreen'];
// The LM requests one generator call issues (an utterance is the emotion choice plus the line).
const LM_REQUESTS_PER_CALL = Object.freeze({ generateUtterance: 2 });
// `roster` counts the calls a send-off queues: the newcomer's 湧き, the re-decision of a partner whose encounter
// was cut off, and the re-decisions of wishes aimed at the child sent off.
export const OVERLOOK_CALL_CATEGORIES = Object.freeze(['focus', 'background', 'spring', 'writing', 'roster']);

const sessions = new Map();

function statusError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// The field seed of an entry week.
export function overlookSeedForWeek(week) {
  if (!Number.isInteger(week) || week < 0) throw new Error(`overlook seed requires a non-negative integer week: ${week}`);
  return stableHash(`overlook:${week}`) & 0x7fffffff;
}

function assertGenerators(generators) {
  if (!generators || typeof generators !== 'object') throw new Error('overlook generators are required');
  for (const name of GENERATOR_NAMES) {
    if (typeof generators[name] !== 'function') throw new Error(`overlook generators.${name} must be a function`);
  }
  return generators;
}

function assertClock(clock) {
  if (!clock || typeof clock.now !== 'function') throw new Error('overlook clock must provide now()');
  return clock;
}

// ---------- the job lanes ----------

function createScheduler(session) {
  const lanes = { focus: { queue: [], running: null }, background: { queue: [], running: null } };
  const idleWaiters = [];

  function settleIdle() {
    if (lanes.focus.running || lanes.background.running || lanes.focus.queue.length || lanes.background.queue.length) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function pump() {
    // A failed or ended session starts nothing more: whatever is still queued is dropped.
    if (session.failure || session.disposed) {
      lanes.focus.queue.length = 0;
      lanes.background.queue.length = 0;
    }
    for (const laneName of ['focus', 'background']) {
      const lane = lanes[laneName];
      while (!lane.running && lane.queue.length) {
        const job = lane.queue.shift();
        if (job.cancelled) continue;
        lane.running = job;
        // A job cancelled before its turn to run (in the same tick it was queued) never reaches the LM.
        Promise.resolve()
          .then(() => (job.cancelled ? null : job.run()))
          .then((result) => {
            lane.running = null;
            if (!session.disposed && !session.failure && !job.cancelled) {
              stepSessionTo(session, session.clock.now());
              job.apply(result);
            }
          })
          .catch((error) => {
            lane.running = null;
            // A job cancelled while it ran (its encounter cut off by a send-off) ends in nothing, failed or not.
            if (!job.cancelled) failSession(session, error);
          })
          .finally(() => pump());
      }
    }
    settleIdle();
  }

  return {
    enqueue(laneName, job) {
      if (session.failure || session.disposed) return job;
      lanes[laneName].queue.push(job);
      pump();
      return job;
    },
    // Resolves once no job is queued or running (tests step tick by tick and wait here in between).
    idle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settleIdle();
      });
    },
    lanes
  };
}

function failSession(session, error) {
  if (!session.failure) session.failure = error;
  for (const conversation of session.conversations.values()) {
    if (conversation.inflight) conversation.inflight.reject(error);
  }
}

// Wraps the injected generators so every call is counted under the lane category that issued it.
function countedGenerators(session, category) {
  return Object.fromEntries(GENERATOR_NAMES.map((name) => [name, (input) => {
    const counts = session.stats[category];
    counts.calls[name] = (counts.calls[name] ?? 0) + 1;
    counts.lm_requests += LM_REQUESTS_PER_CALL[name] ?? 1;
    return session.generators[name](input);
  }]));
}

function job(session, { lane, category, run, apply }) {
  return session.scheduler.enqueue(lane, {
    cancelled: false,
    run: () => run(countedGenerators(session, category)),
    apply
  });
}

// ---------- session state helpers ----------

function stateOf(session, id) {
  const state = session.surface.children.children[id];
  if (!state) throw new Error(`overlook session has no child state: ${id}`);
  return state;
}

function nameOf(session) {
  return (id) => session.names.get(id);
}

function placeNameOf(session) {
  return (id) => session.placeNames.get(id);
}

function currentMinute(session) {
  return overlookMinuteAtTick(session.field.tick);
}

function ended(session) {
  return session.field.tick >= OVERLOOK_END_TICK;
}

function childDescriptor(session, id) {
  return { id, name: session.names.get(id), profile: session.profiles.get(id) };
}

// Surface writes are serialized per session (each writes the snapshot taken when it was requested), so two jobs
// finishing close together never interleave on the same file. A failed write ends the session.
function persistSurface(session) {
  const surface = session.surface;
  session.persistChain = session.persistChain
    .then(() => writeOverlookSurface({ storage: session.storage, surface, placeIds: session.placeIds }))
    .catch((error) => failSession(session, error));
  return session.persistChain;
}

function setChildState(session, id, next) {
  session.surface = {
    ...session.surface,
    children: { ...session.surface.children, children: { ...session.surface.children.children, [id]: next } }
  };
}

function onRoster(session, id) {
  return session.surface.roster.members.includes(id);
}

function rosterEntries(session) {
  return session.surface.roster.members.map((id) => ({ id, name: session.names.get(id) }));
}

function placeEntries(session) {
  return session.graph.places.map((place) => ({ id: place.location_id, name: session.placeNames.get(place.location_id) }));
}

// ---------- wishes ----------

// Where a child decides from: its place on the field, or the gate for a newcomer that has not walked in yet.
function wishPlaceId(session, id) {
  const phase = overlookChildGatePhase(session.field, id);
  if (phase === 'outside' || phase === 'arriving') return OVERLOOK_GATE_PLACE_ID;
  return overlookPlaceAt(session.graph, overlookChildPoint(session.field, id));
}

function wishInput(session, id, trigger) {
  return {
    child: childDescriptor(session, id),
    state: stateOf(session, id),
    placeId: wishPlaceId(session, id),
    trigger,
    roster: rosterEntries(session),
    places: placeEntries(session),
    nameOf: nameOf(session),
    placeNameOf: placeNameOf(session)
  };
}

function applyWish(session, id, decided, { generation, source }) {
  const wish = {
    action: decided.action,
    target: decided.target,
    line: decided.line,
    generation,
    source,
    expires_at_minute: currentMinute(session) + OVERLOOK_WISH_DURATION_MINUTES
  };
  setChildState(session, id, { ...stateOf(session, id), wish });
  setOverlookChildWish(session.field, id, wish);
  return wish;
}

// The wish that ended because it was aimed at a child sent off: decided anew as a 湧き (generation 1).
const SENT_OFF_TARGET_REDECISION = Object.freeze({
  lane: 'background',
  category: 'roster',
  trigger: Object.freeze({ kind: 'lapsed' }),
  generation: 1,
  source: Object.freeze({ kind: 'spring', id: null })
});

// Queues a child's wish decision (the child is held as deciding until it applies). `ready` is awaited before the
// call (a newcomer's profile). A decision taken against a roster that has since lost its target (the target was
// sent off while the call ran) ends at once and is decided anew.
function queueWish(session, id, { lane, category, trigger, generation, source, onApplied = null, ready = null }) {
  holdOverlookChild(session.field, id, 'deciding');
  const queued = job(session, {
    lane,
    category,
    run: async (generators) => {
      if (ready) await ready;
      return generators.decideWish(wishInput(session, id, trigger));
    },
    apply: (decided) => {
      session.wishJobs.delete(id);
      if (decided.target.kind === 'child' && !onRoster(session, decided.target.id)) {
        queueWish(session, id, SENT_OFF_TARGET_REDECISION);
        return;
      }
      const wish = applyWish(session, id, decided, { generation, source });
      onApplied?.(wish);
      deliverHeldWriting(session, id);
      persistSurface(session);
    }
  });
  session.wishJobs.set(id, queued);
}

// ---------- state rewrites ----------

// Folds a rewrite into a child's state: the feeling toward the partner (none when `partnerId` is null — the
// partner was sent off after the talk closed), the concern list (a concern whose text is unchanged keeps its
// source and generation; a new one comes from this talk), and the mood. The wish is left for the re-decision
// that follows.
function rewrittenState(state, rewrite, { partnerId, source, generation }) {
  const kept = new Map(state.concerns.map((concern) => [concern.text, concern]));
  return {
    ...state,
    feelings: partnerId === null ? state.feelings : { ...state.feelings, [partnerId]: { label: rewrite.feeling_label, text: rewrite.feeling_text } },
    concerns: rewrite.concerns.map((text) => kept.get(text) ?? { text, source, generation }),
    mood: rewrite.mood
  };
}

// A fulfilled wish stays with the child that held it, as the concern 「済んだ: <一言>」 added after the rewrite (the
// oldest concern goes when the list is full), so the decisions after the next one still read it as done.
function withFulfilledWish(state, wish, { source, generation }) {
  const text = `${OVERLOOK_DONE_CONCERN_PREFIX}${wish.line}`;
  if (state.concerns.some((concern) => concern.text === text)) return state;
  return addOverlookConcern(state, { text, source, generation });
}

function heldWish(wish) {
  return wish === null ? null : { action: wish.action, target: wish.target, line: wish.line };
}

// ---------- encounters and focus ----------

function encounterView(session, encounter) {
  return {
    encounter_id: encounter.id,
    participants: [encounter.initiator, encounter.partner].map((id) => ({ character_id: id, character_name: session.names.get(id) })),
    place_id: encounter.place_id,
    pickable: encounter.status === 'pending' && !ended(session) && session.focus?.encounter_id !== encounter.id
  };
}

function handleEncounter(session, event) {
  session.encounterCounter += 1;
  const encounter = {
    id: `ove_${String(session.encounterCounter).padStart(4, '0')}`,
    initiator: event.initiator,
    partner: event.partner,
    place_id: event.place_id,
    tick: session.field.tick,
    friction: event.friction,
    generation: event.generation,
    from_writing: event.from_writing,
    status: 'pending',
    seed_line: null,
    seedJob: null,
    offscreenJob: null
  };
  session.encounters.set(encounter.id, encounter);
  const reservedHere = session.reservedFocus === pairKeyOf(encounter.initiator, encounter.partner);
  if (!session.focus && reservedHere) {
    session.reservedFocus = null;
    focusEncounter(session, encounter, 'academy');
    return;
  }
  queueOffscreen(session, encounter);
  if (!session.focus) selectAcademyFocus(session);
}

function pairKeyOf(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// The seed of a watched encounter is its own call on the focus lane (an unwatched one raises its seed inside the
// resolution call).
function queueFocusSeed(session, encounter) {
  return job(session, {
    lane: 'focus',
    category: 'focus',
    run: (generators) => generators.generateSeed({
      initiator: childDescriptor(session, encounter.initiator),
      partner: childDescriptor(session, encounter.partner),
      states: { [encounter.initiator]: stateOf(session, encounter.initiator), [encounter.partner]: stateOf(session, encounter.partner) },
      placeId: encounter.place_id,
      nameOf: nameOf(session),
      placeNameOf: placeNameOf(session)
    }),
    apply: (seed) => {
      if (encounter.status !== 'focused' || encounter.seed_line !== null) return;
      encounter.seed_line = seed.line;
      openFocusConversation(session, encounter);
    }
  });
}

// いちばん大きな山 among the pending encounters and the approaching pairs. A pending encounter on top becomes the
// focus at once; an approaching pair on top is reserved and becomes the focus when the two meet.
function selectAcademyFocus(session) {
  if (session.focus || ended(session)) return;
  const pending = [...session.encounters.values()]
    .filter((encounter) => encounter.status === 'pending')
    .map((encounter) => ({ kind: 'encounter', encounter, friction: encounter.friction, generation: encounter.generation, from_writing: encounter.from_writing }));
  const approaching = listOverlookApproachingPairs(session.field, { stateOf: (id) => stateOf(session, id) });
  const [top] = rankOverlookFocusCandidates(session.field, [...pending, ...approaching]);
  if (!top) {
    session.reservedFocus = null;
    return;
  }
  if (top.kind === 'encounter') {
    session.reservedFocus = null;
    focusEncounter(session, top.encounter, 'academy');
  } else {
    session.reservedFocus = pairKeyOf(...top.participants);
  }
}

function focusEncounter(session, encounter, source) {
  encounter.status = 'focused';
  if (encounter.offscreenJob) encounter.offscreenJob.cancelled = true;
  session.focus = { encounter_id: encounter.id, conversation_id: null, source };
  if (encounter.seed_line !== null) {
    openFocusConversation(session, encounter);
    return;
  }
  encounter.seedJob = queueFocusSeed(session, encounter);
}

// Drops a focus that has not shown a line yet: its seed call and its talk (a line in flight is refused with
// `error`) are discarded. Returns the focused encounter.
function dropFocus(session, error) {
  const focus = session.focus;
  const encounter = session.encounters.get(focus.encounter_id);
  if (focus.conversation_id) {
    const conversation = session.conversations.get(focus.conversation_id);
    conversation.discarded = true;
    if (conversation.turnJob) conversation.turnJob.cancelled = true;
    conversation.inflight?.reject(error);
    session.conversations.delete(focus.conversation_id);
  }
  session.focus = null;
  if (encounter.seedJob) encounter.seedJob.cancelled = true;
  return encounter;
}

// A focus that has not shown a line yet can be taken back: its encounter returns to the unwatched path.
function releaseFocus(session) {
  if (!session.focus) return;
  const encounter = dropFocus(session, statusError('the viewer picked another encounter', 409, 'OVERLOOK_FOCUS_REDIRECTED'));
  encounter.status = 'pending';
  queueOffscreen(session, encounter);
}

// ---------- unwatched encounters ----------

// One call raises the seed, the outcome, the trace and both rewritten states; the seed stays on the encounter
// record (the one the outcome was decided with), then both children re-decide their wishes.

function queueOffscreen(session, encounter) {
  encounter.offscreenJob = job(session, {
    lane: 'background',
    category: 'background',
    run: (generators) => generators.resolveOffscreen({
      initiator: childDescriptor(session, encounter.initiator),
      partner: childDescriptor(session, encounter.partner),
      states: { [encounter.initiator]: stateOf(session, encounter.initiator), [encounter.partner]: stateOf(session, encounter.partner) },
      placeId: encounter.place_id,
      nameOf: nameOf(session),
      placeNameOf: placeNameOf(session)
    }),
    apply: (resolution) => {
      if (encounter.status !== 'pending') return;
      encounter.status = 'resolved';
      encounter.seed_line = resolution.seed;
      const source = { kind: 'conversation', id: encounter.id };
      const wishes = { [encounter.initiator]: stateOf(session, encounter.initiator).wish, [encounter.partner]: stateOf(session, encounter.partner).wish };
      setChildState(session, encounter.initiator, rewrittenState(stateOf(session, encounter.initiator), resolution.initiator, { partnerId: encounter.partner, source, generation: encounter.generation }));
      if (resolution.outcome === '果たされた' && wishes[encounter.initiator] !== null) {
        setChildState(session, encounter.initiator, withFulfilledWish(stateOf(session, encounter.initiator), wishes[encounter.initiator], { source, generation: encounter.generation }));
      }
      setChildState(session, encounter.partner, rewrittenState(stateOf(session, encounter.partner), resolution.partner, { partnerId: encounter.initiator, source, generation: encounter.generation }));
      session.traces.set(encounter.place_id, {
        place_id: encounter.place_id,
        tick: session.field.tick,
        minute: currentMinute(session),
        watched_ticks: session.fieldWatchedTicks,
        text: resolution.trace,
        encounter_id: encounter.id
      });
      finishEncounter(session, encounter, {
        lane: 'background',
        category: 'background',
        outcome: resolution.outcome,
        source,
        wishes,
        talk: { kind: 'offscreen', seed: resolution.seed, partner_reply: resolution.partner_reply, trace: resolution.trace }
      });
    }
  });
}

// After a talk (watched or not) closes and both states are rewritten: both children decide a new wish, one
// generation past the talk, reading who started it with what wish, the outcome, the wish each held (`wishes`, by
// child id, as they stood when the talk closed) and what happened (`talk`). A child sent off since the talk closed
// decides nothing.
function finishEncounter(session, encounter, { lane, category, outcome, source, wishes, talk }) {
  for (const [id, partnerId] of [[encounter.initiator, encounter.partner], [encounter.partner, encounter.initiator]]) {
    if (!onRoster(session, id)) continue;
    queueWish(session, id, {
      lane,
      category,
      trigger: {
        kind: 'conversation',
        partner_id: partnerId,
        initiator_id: encounter.initiator,
        outcome,
        initiator_wish: heldWish(wishes[encounter.initiator]),
        wish: heldWish(wishes[id]),
        talk
      },
      generation: encounter.generation + 1,
      source
    });
  }
  persistSurface(session);
}

// ---------- the watched talk ----------

function openFocusConversation(session, encounter) {
  session.conversationCounter += 1;
  const record = createOverlookConversation({
    id: `ovc_${String(session.conversationCounter).padStart(4, '0')}`,
    encounterId: encounter.id,
    placeId: encounter.place_id,
    locationName: session.placeNames.get(encounter.place_id),
    seedLine: encounter.seed_line,
    initiator: { id: encounter.initiator, name: session.names.get(encounter.initiator) },
    partner: { id: encounter.partner, name: session.names.get(encounter.partner) },
    generation: encounter.generation,
    fromWriting: encounter.from_writing
  });
  const conversation = {
    record,
    shown: 0,
    inflight: null,
    waiting: false,
    turnJob: null,
    discarded: false,
    initiatorWish: stateOf(session, encounter.initiator).wish,
    actorContexts: new Map()
  };
  session.conversations.set(record.id, conversation);
  session.focus = { ...session.focus, conversation_id: record.id };
  startTurn(session, conversation);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function speakerInputs(session, conversation, speaker) {
  if (!conversation.actorContexts.has(speaker.id)) {
    conversation.actorContexts.set(speaker.id, await buildConversationActorContextSnapshot({
      root: session.root,
      actor: { kind: 'character', id: speaker.id },
      profile: session.profiles.get(speaker.id)
    }));
  }
  return {
    profile: session.profiles.get(speaker.id),
    scene: {
      academy_name: session.world.academy_name,
      world_description: session.world.world_description,
      player_name: session.world.player_name,
      player_parameters: session.world.player_parameters,
      location_name: conversation.record.location_name,
      visible_situation: session.placeSituations.get(conversation.record.place_id)
    },
    conversationActorContext: conversation.actorContexts.get(speaker.id),
    speakerState: stateOf(session, speaker.id)
  };
}

// Keeps exactly one line generated ahead of what the viewer has been shown (the first line on opening).
function startTurn(session, conversation) {
  const { record } = conversation;
  if (conversation.discarded || conversation.inflight || overlookConversationClosed(record) || record.messages.length > conversation.shown) return;
  const inflight = { text: '', listeners: new Set(), ...deferred() };
  conversation.inflight = inflight;
  conversation.turnJob = job(session, {
    lane: 'focus',
    category: 'focus',
    run: (generators) => runOverlookConversationTurn({
      record,
      generators,
      inputs: (speaker) => speakerInputs(session, conversation, speaker),
      initiatorWish: conversation.initiatorWish,
      nameOf: nameOf(session),
      placeNameOf: placeNameOf(session),
      onDelta: (delta) => {
        inflight.text += delta;
        for (const listener of inflight.listeners) listener(delta);
      }
    }),
    apply: (next) => {
      if (conversation.discarded) return;
      conversation.record = next;
      conversation.inflight = null;
      inflight.resolve();
      if (overlookConversationClosed(next)) closeFocusConversation(session, conversation);
    }
  });
}

// The watched talk closed: record what the viewer saw, then rewrite both states and decide both wishes on the
// focus lane (the two children stand where they talked until their wishes arrive).
function closeFocusConversation(session, conversation) {
  const { record } = conversation;
  const encounter = session.encounters.get(record.encounter_id);
  encounter.status = 'resolved';
  session.watched.push({
    initiator: { character_id: record.initiator.id, character_name: record.initiator.name },
    partner: { character_id: record.partner.id, character_name: record.partner.name },
    outcome: record.outcome,
    wish_line: conversation.initiatorWish.line
  });
  const source = { kind: 'conversation', id: record.id };
  const history = record.messages.map((message) => ({ speaker_name: message.speaker_name, content: message.content }));
  const wishes = { [record.initiator.id]: conversation.initiatorWish, [record.partner.id]: stateOf(session, record.partner.id).wish };
  let rewritten = 0;
  for (const [self, partner] of [[record.initiator, record.partner], [record.partner, record.initiator]]) {
    job(session, {
      lane: 'focus',
      category: 'focus',
      run: (generators) => generators.rewriteState({
        self: childDescriptor(session, self.id),
        partner: childDescriptor(session, partner.id),
        state: stateOf(session, self.id),
        locationName: record.location_name,
        history,
        outcome: record.outcome,
        nameOf: nameOf(session),
        placeNameOf: placeNameOf(session)
      }),
      apply: (rewrite) => {
        // A child sent off after the talk closed keeps no state, and no one keeps a feeling toward it.
        if (onRoster(session, self.id)) {
          const partnerId = onRoster(session, partner.id) ? partner.id : null;
          setChildState(session, self.id, rewrittenState(stateOf(session, self.id), rewrite, { partnerId, source, generation: record.generation }));
          if (self.id === record.initiator.id && record.outcome === '果たされた' && conversation.initiatorWish !== null) {
            setChildState(session, self.id, withFulfilledWish(stateOf(session, self.id), conversation.initiatorWish, { source, generation: record.generation }));
          }
        }
        rewritten += 1;
        if (rewritten === 2) {
          finishEncounter(session, encounter, { lane: 'focus', category: 'focus', outcome: record.outcome, source, wishes, talk: { kind: 'focus', history } });
        }
      }
    });
  }
}

// ---------- field stepping ----------

function applyFieldEvent(session, event) {
  if (event.type === 'wish_expired') {
    queueWish(session, event.id, {
      lane: 'background',
      category: 'spring',
      trigger: { kind: 'lapsed' },
      generation: 1,
      source: { kind: 'spring', id: null }
    });
    return;
  }
  if (event.type === 'arrived') {
    const state = stateOf(session, event.id);
    const wish = overlookWishOnArrival(state.wish, session.field.tick);
    if (wish !== state.wish) {
      setChildState(session, event.id, { ...state, wish });
      session.field.children.get(event.id).wish = wish;
    }
    return;
  }
  if (event.type === 'entered_place') {
    const writing = session.writings.find((entry) => entry.place_id === event.place_id && currentMinute(session) < entry.minute + OVERLOOK_WRITING_INTERVAL_MINUTES);
    if (writing && writing.late_readers.length < OVERLOOK_WRITING_LATE_READERS && !writing.readers.has(event.id) && session.field.children.get(event.id).hold === null) {
      writing.late_readers.push(event.id);
      deliverWriting(session, writing, event.id);
    }
    return;
  }
  if (event.type === 'encounter') {
    handleEncounter(session, event);
    return;
  }
  throw new Error(`overlook field event has no handler: ${event.type}`);
}

function stepSessionTo(session, nowMs) {
  const target = Math.min(OVERLOOK_END_TICK, Math.floor((nowMs - session.startedAtMs) / OVERLOOK_TICK_MS));
  while (session.field.tick < target) {
    const events = stepOverlookField(session.field, { stateOf: (id) => stateOf(session, id) });
    if (!focusOnScreen(session)) {
      session.fieldWatchedTicks += 1;
      fadeWatchedTraces(session);
    }
    for (const event of events) applyFieldEvent(session, event);
  }
}

// ---------- traces ----------

function fadeWatchedTraces(session) {
  for (const [placeId, trace] of session.traces) {
    if (session.fieldWatchedTicks - trace.watched_ticks >= TRACE_WATCHED_TICKS) session.traces.delete(placeId);
  }
}

// Back on the field: the traces left are the ones that closed since the previous return.
function clearTracesBeforeLastReturn(session) {
  for (const [placeId, trace] of session.traces) {
    if (trace.tick <= session.lastReturnTick) session.traces.delete(placeId);
  }
  session.lastReturnTick = session.field.tick;
}

function assertLive(session) {
  if (session.failure) throw session.failure;
  if (session.disposed) throw statusError('the overlook session has ended', 409, 'OVERLOOK_NOT_ACTIVE');
}

// Brings the session up to the injected clock's "now". Every public operation calls this first.
export function advanceOverlookSession(session) {
  assertLive(session);
  stepSessionTo(session, session.clock.now());
  assertLive(session);
  return session;
}

// ---------- writings ----------

function deliverWriting(session, writing, id) {
  writing.readers.add(id);
  const source = { kind: 'writing', id: writing.id };
  setChildState(session, id, addOverlookConcern(stateOf(session, id), {
    text: `${session.placeNames.get(writing.place_id)}で見た書き込み: ${writing.text}`,
    source,
    generation: 1
  }));
  queueWish(session, id, {
    lane: 'background',
    category: 'writing',
    trigger: { kind: 'writing', text: writing.text },
    generation: 1,
    source,
    onApplied: (wish) => {
      session.movers.push({ character_id: id, character_name: session.names.get(id), writing_text: writing.text, wish_line: wish.line });
    }
  });
}

// A child that stood in a writing's radius when it was written, but was held (deciding or in an encounter), reads
// it once its hands are free — if the writing is still in effect. It does not take one of the late-reader places.
function deliverHeldWriting(session, id) {
  const minute = currentMinute(session);
  const writing = session.writings.find((entry) => entry.held.has(id));
  if (!writing) return;
  writing.held.delete(id);
  if (minute < writing.minute + OVERLOOK_WRITING_INTERVAL_MINUTES) deliverWriting(session, writing, id);
}

function nextWritingMinute(session) {
  const last = session.writings[session.writings.length - 1];
  return last ? last.minute + OVERLOOK_WRITING_INTERVAL_MINUTES : null;
}

function validWritingText(text) {
  if (typeof text !== 'string') throw statusError('writing text must be a string', 400, 'OVERLOOK_WRITING_TEXT_INVALID');
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || [...trimmed].length > OVERLOOK_WRITING_MAX_CHARS) {
    throw statusError(`writing text must be one line of 1〜${OVERLOOK_WRITING_MAX_CHARS} characters`, 400, 'OVERLOOK_WRITING_TEXT_INVALID');
  }
  return trimmed;
}

// Writes one line at a place: it reaches every child standing in the place's radius now (a held one once its
// hands are free), and up to
// OVERLOOK_WRITING_LATE_READERS children who walk in during the next academy hour. Each reader gets it as a
// concern (source = the writing, generation 1) and re-decides its wish (generation 1).
export function writeOverlookLine(session, { placeId, text } = {}) {
  advanceOverlookSession(session);
  if (ended(session)) throw statusError('the academy day has ended', 409, 'OVERLOOK_ENDED');
  if (!session.graph.placeById.has(placeId)) throw statusError(`unknown overlook place: ${placeId}`, 400, 'OVERLOOK_PLACE_UNKNOWN');
  const line = validWritingText(text);
  const minute = currentMinute(session);
  const next = nextWritingMinute(session);
  if (next !== null && minute < next) {
    const error = statusError(`the next line can be written from ${formatOverlookMinute(next)}`, 409, 'OVERLOOK_WRITING_LIMITED');
    error.nextAvailableAt = formatOverlookMinute(next);
    throw error;
  }
  session.writingCounter += 1;
  const writing = {
    id: `writing_${String(session.writingCounter).padStart(3, '0')}`,
    place_id: placeId,
    text: line,
    minute,
    readers: new Set(),
    held: new Set(),
    late_readers: []
  };
  session.writings.push(writing);
  const inRadius = [...session.field.children.keys()].sort().filter((id) => session.field.children.get(id).placeId === placeId);
  for (const id of inRadius) {
    if (session.field.children.get(id).hold === null) deliverWriting(session, writing, id);
    else writing.held.add(id);
  }
  return writing;
}

// ---------- 顔ぶれ: the send-off ----------

// The focused talk is on screen from its first shown line until the viewer returns to the field.
function focusOnScreen(session) {
  const conversationId = session.focus?.conversation_id;
  return Boolean(conversationId) && session.conversations.get(conversationId).shown > 0;
}

// Cuts off an encounter in progress (unwatched, or the focus before its first line is shown): it leaves no
// outcome, no trace and no state rewrite.
function abortEncounter(session, encounter) {
  if (session.focus?.encounter_id === encounter.id) {
    dropFocus(session, statusError('a child in the focused encounter was sent off', 409, 'OVERLOOK_FOCUS_SENT_OFF'));
  }
  encounter.status = 'aborted';
  if (encounter.offscreenJob) encounter.offscreenJob.cancelled = true;
}

// 顔ぶれの送り出し (brief §2): the child stops what it was doing and walks out through the gate, and a newcomer
// drawn with the field seed walks in once the leaver passes the gate point. At the moment of the send-off:
// - the newcomer takes the leaver's row with an empty state; the leaver's state and every feeling toward it go;
// - the newcomer's 湧き (generation 1) is queued on the background lane first, so it is most likely decided by
//   the time the newcomer walks through the gate (otherwise it waits at the gate point);
// - a wish aimed at the leaver ends: a free child decides anew (湧き); a held child's wish is cleared (its next
//   decision is already on its way, or follows its encounter);
// - an encounter in progress with the leaver is cut off and the partner decides anew (湧き).
// All of these calls count under `roster`. Refused while the focused talk is on screen, after 15:00, and for a
// child not on the roster or a newcomer still outside the gate. There is no undo and no limit.
export function sendOffOverlookChild(session, { characterId } = {}) {
  advanceOverlookSession(session);
  if (ended(session)) throw statusError('the academy day has ended', 409, 'OVERLOOK_ENDED');
  if (focusOnScreen(session)) throw statusError('the roster cannot change while a talk is on screen', 409, 'OVERLOOK_ROSTER_BUSY');
  if (!onRoster(session, characterId) || overlookChildGatePhase(session.field, characterId) !== null) {
    throw statusError(`this child cannot be sent off now: ${characterId}`, 409, 'OVERLOOK_CHILD_NOT_SWAPPABLE');
  }
  const leavingId = characterId;
  const arrivingId = sendOverlookChildOff(session.field, { id: leavingId, selectableIds: [...session.selectableNames.keys()] });
  session.leavers.push(leavingId);
  session.names.set(arrivingId, session.selectableNames.get(arrivingId));
  const leaverWish = session.wishJobs.get(leavingId);
  if (leaverWish) {
    leaverWish.cancelled = true;
    session.wishJobs.delete(leavingId);
  }
  session.surface = replaceOverlookRosterMember({ surface: session.surface, leavingId, arrivingId });

  const profile = selectableCharacterPromptProfile({ root: session.root, authoringRoot: session.authoringRoot, characterId: arrivingId })
    .then((loaded) => { session.profiles.set(arrivingId, loaded); });
  // A load failure fails the newcomer's wish job (and so the session) when the job awaits it.
  profile.catch(() => {});
  queueWish(session, arrivingId, {
    lane: 'background',
    category: 'roster',
    trigger: { kind: 'arrival', minute: currentMinute(session) },
    generation: 1,
    source: { kind: 'spring', id: null },
    ready: profile
  });

  for (const id of session.surface.roster.members) {
    const state = stateOf(session, id);
    if (state.wish?.target.kind !== 'child' || state.wish.target.id !== leavingId) continue;
    setChildState(session, id, { ...state, wish: null });
    if (session.field.children.get(id).hold === null) queueWish(session, id, SENT_OFF_TARGET_REDECISION);
  }

  let focusDropped = false;
  for (const encounter of session.encounters.values()) {
    if (encounter.status !== 'pending' && encounter.status !== 'focused') continue;
    if (encounter.initiator !== leavingId && encounter.partner !== leavingId) continue;
    focusDropped ||= session.focus?.encounter_id === encounter.id;
    abortEncounter(session, encounter);
    queueWish(session, encounter.initiator === leavingId ? encounter.partner : encounter.initiator, SENT_OFF_TARGET_REDECISION);
  }
  const reservationDropped = session.reservedFocus !== null && session.reservedFocus.split('|').includes(leavingId);
  if (reservationDropped) session.reservedFocus = null;
  if (!session.focus && (focusDropped || reservationDropped)) selectAcademyFocus(session);

  persistSurface(session);
  return {
    leaving: { character_id: leavingId, character_name: session.names.get(leavingId) },
    arriving: { character_id: arrivingId, character_name: session.names.get(arrivingId) }
  };
}

// ---------- entry ----------

async function loadPlaceTexts(storage, graph) {
  const locations = await storage.readJson(LOCATIONS_PATH);
  if (!Array.isArray(locations)) throw new Error('locations.json must be an array');
  const byId = new Map(locations.map((location) => [location.id, location]));
  const names = new Map();
  const situations = new Map();
  for (const place of graph.places) {
    const location = byId.get(place.location_id);
    if (!location || typeof location.display_name !== 'string' || !location.display_name) {
      throw new Error(`overlook place has no display name in locations.json: ${place.location_id}`);
    }
    names.set(place.location_id, location.display_name);
    situations.set(place.location_id, location.visible_situation);
  }
  return { names, situations };
}

function emptyStats() {
  return Object.fromEntries(OVERLOOK_CALL_CATEGORIES.map((category) => [category, { calls: {}, lm_requests: 0 }]));
}

// Opens an entry session: loads (or, on the first entry, draws and persists) the 12 children, places them from
// the seed, decides every child's entry 湧き (generation 1) as an independent bundle, persists the surface and
// starts the academy clock at 9:00. Replaces any earlier session of the same slot.
export async function enterOverlook({ root, authoringRoot, storage, state, generators, clock } = {}) {
  if (!root) throw new Error('overlook entry requires root');
  if (!authoringRoot) throw new Error('overlook entry requires authoringRoot');
  if (!storage) throw new Error('overlook entry requires storage');
  assertGenerators(generators);
  assertClock(clock);
  const week = requireRoutingContentWeek(state);
  const fieldSeed = overlookSeedForWeek(week);
  const previous = sessions.get(root);
  if (previous) disposeOverlookSession(previous);

  const graph = await loadOverlookFieldGraph({ root });
  const placeIds = graph.places.map((place) => place.location_id);
  const { names: placeNames, situations: placeSituations } = await loadPlaceTexts(storage, graph);
  const choices = await listSelectableCharacterChoices({ root, authoringRoot });
  const loaded = await loadOverlookSurface({ storage, placeIds });
  const { surface } = ensureOverlookRoster({ surface: loaded, selectableIds: choices.map((choice) => choice.id), seed: fieldSeed });
  const names = new Map(choices.filter((choice) => surface.roster.members.includes(choice.id)).map((choice) => [choice.id, choice.display_name]));
  for (const id of surface.roster.members) {
    if (!names.has(id)) throw new Error(`overlook roster member is no longer selectable: ${id}`);
  }
  const profiles = new Map();
  for (const id of surface.roster.members) profiles.set(id, await selectableCharacterPromptProfile({ root, authoringRoot, characterId: id }));
  const world = await loadWorldSettings({ root });

  const session = {
    root,
    authoringRoot,
    storage,
    week,
    seed: fieldSeed,
    generators,
    clock,
    graph,
    placeIds,
    placeNames,
    placeSituations,
    names,
    selectableNames: new Map(choices.map((choice) => [choice.id, choice.display_name])),
    profiles,
    world,
    surface,
    field: createOverlookField({ graph, members: surface.roster.members, seed: fieldSeed }),
    startedAtMs: null,
    encounters: new Map(),
    conversations: new Map(),
    focus: null,
    reservedFocus: null,
    traces: new Map(),
    fieldWatchedTicks: 0,
    lastReturnTick: 0,
    writings: [],
    watched: [],
    movers: [],
    wishJobs: new Map(),
    leavers: [],
    encounterCounter: 0,
    conversationCounter: 0,
    writingCounter: 0,
    stats: emptyStats(),
    persistChain: Promise.resolve(),
    failure: null,
    disposed: false
  };
  session.scheduler = createScheduler(session);

  // The entry 湧き run before the clock starts, so every child walks from 9:00 with a wish.
  const springGenerators = countedGenerators(session, 'spring');
  const members = surface.roster.members;
  const decided = await runIndependentBundle(members, {
    run: (id) => springGenerators.decideWish(wishInput(session, id, { kind: 'entry' }))
  });
  session.startedAtMs = clock.now();
  members.forEach((id, index) => applyWish(session, id, decided[index], { generation: 1, source: { kind: 'spring', id: null } }));
  await persistSurface(session);
  assertLive(session);
  sessions.set(root, session);
  return session;
}

export function requireOverlookSession(root) {
  const session = sessions.get(root);
  if (!session) throw statusError('no overlook session is active for this slot', 409, 'OVERLOOK_NOT_ACTIVE');
  return session;
}

export function disposeOverlookSession(session) {
  session.disposed = true;
  for (const conversation of session.conversations.values()) conversation.discarded = true;
  if (sessions.get(session.root) === session) sessions.delete(session.root);
}

// Resolves once every queued LM job has finished and been applied (the deterministic test seam).
export async function overlookSessionIdle(session) {
  await session.scheduler.idle();
  await session.persistChain;
}

// ---------- views ----------

function childStatus(session, id) {
  const hold = session.field.children.get(id).hold;
  if (hold === null) return 'free';
  return hold === 'encounter' ? 'encounter' : 'deciding';
}

// One child on the map. A child sent off is `leaving` (it has no state any more); a newcomer on the road up to
// the gate is `arriving`. Neither shows a wish line. A child in an encounter whose wish was aimed at a child
// sent off has no wish left to show.
function childView(session, id) {
  const identity = { character_id: id, character_name: session.names.get(id) };
  const phase = overlookChildGatePhase(session.field, id);
  if (phase === 'leaving') {
    return { ...identity, status: 'leaving', wish_line: null, feelings: [], ...overlookChildFieldView(session.field, id) };
  }
  const state = stateOf(session, id);
  const status = phase === 'arriving' ? 'arriving' : childStatus(session, id);
  let wishLine = null;
  if (status === 'free') wishLine = state.wish.line;
  else if (status === 'encounter' && state.wish !== null) wishLine = state.wish.line;
  return {
    ...identity,
    status,
    wish_line: wishLine,
    feelings: Object.entries(state.feelings).map(([otherId, feeling]) => ({ character_id: otherId, label: feeling.label, text: feeling.text })),
    ...overlookChildFieldView(session.field, id)
  };
}

export function overlookFieldView(session) {
  advanceOverlookSession(session);
  // A child sent off stays listed until it has walked off the map.
  session.leavers = session.leavers.filter((id) => session.field.children.has(id));
  const minute = currentMinute(session);
  const next = nextWritingMinute(session);
  const place = (placeId) => session.graph.placeById.get(placeId);
  return {
    week: session.week,
    clock: {
      tick: session.field.tick,
      academy_time: formatOverlookMinute(minute),
      academy_minute: minute,
      ended: ended(session),
      tick_ms: OVERLOOK_TICK_MS
    },
    map: { width: session.graph.width, height: session.graph.height },
    // The roster rows in the order the children joined; a newcomer's row cannot be sent off until it walks
    // through the gate.
    roster: session.surface.roster.members.map((id) => ({
      character_id: id,
      character_name: session.names.get(id),
      swappable: overlookChildGatePhase(session.field, id) === null
    })),
    // The roster members on the map (a newcomer appears once its leaver passes the gate point), then the children
    // still on their way out, in send-off order.
    children: [
      ...session.surface.roster.members.filter((id) => overlookChildGatePhase(session.field, id) !== 'outside'),
      ...session.leavers
    ].map((id) => childView(session, id)),
    encounters: [...session.encounters.values()]
      .filter((encounter) => encounter.status === 'pending' || encounter.status === 'focused')
      .map((encounter) => encounterView(session, encounter)),
    focus: session.focus ? {
      ...encounterView(session, session.encounters.get(session.focus.encounter_id)),
      conversation_id: session.focus.conversation_id,
      source: session.focus.source
    } : null,
    traces: [...session.traces.values()].map((trace) => ({
      place_id: trace.place_id,
      x: place(trace.place_id).x,
      y: place(trace.place_id).y,
      academy_time: formatOverlookMinute(trace.minute),
      text: trace.text
    })),
    writing_marks: session.writings
      .filter((writing) => minute < writing.minute + OVERLOOK_WRITING_INTERVAL_MINUTES)
      .map((writing) => ({
        writing_id: writing.id,
        place_id: writing.place_id,
        x: place(writing.place_id).x,
        y: place(writing.place_id).y,
        academy_time: formatOverlookMinute(writing.minute),
        until: formatOverlookMinute(writing.minute + OVERLOOK_WRITING_INTERVAL_MINUTES),
        text: writing.text
      })),
    writing: {
      available: !ended(session) && (next === null || minute >= next),
      next_available_at: next !== null && minute < next ? formatOverlookMinute(next) : null
    }
  };
}

// ---------- focus picking and the conversation routes ----------

// Picks an encounter the viewer pointed at: it overrides the academy's focus, including one it is still
// approaching (no line shown yet). A focus whose talk is already on screen cannot be taken over.
export function pickOverlookFocus(session, { encounterId } = {}) {
  advanceOverlookSession(session);
  if (ended(session)) throw statusError('the academy day has ended', 409, 'OVERLOOK_ENDED');
  const encounter = session.encounters.get(encounterId);
  if (!encounter || encounter.status !== 'pending') {
    throw statusError(`encounter is not one that can be picked: ${encounterId}`, 409, 'OVERLOOK_ENCOUNTER_NOT_PICKABLE');
  }
  if (session.focus) {
    const conversation = session.focus.conversation_id ? session.conversations.get(session.focus.conversation_id) : null;
    if (conversation && conversation.shown > 0) throw statusError('the focused talk is already on screen', 409, 'OVERLOOK_FOCUS_BUSY');
    releaseFocus(session);
  }
  session.reservedFocus = null;
  focusEncounter(session, encounter, 'picked');
  return session.focus;
}

function requireConversation(session, conversationId) {
  const conversation = session.conversations.get(conversationId);
  if (!conversation || conversation.discarded) throw statusError(`no such overlook conversation: ${conversationId}`, 404, 'OVERLOOK_CONVERSATION_NOT_FOUND');
  return conversation;
}

export function overlookConversationViewFor(session, conversationId) {
  advanceOverlookSession(session);
  const conversation = requireConversation(session, conversationId);
  return overlookConversationView(conversation.record, { shown: conversation.shown });
}

// The next route's checks, run before its stream opens: a talk shown to its close gives no more lines, and a talk
// whose line an earlier next is still waiting for refuses a second next until that one returns.
export function assertNextOverlookLineAllowed(session, { conversationId } = {}) {
  advanceOverlookSession(session);
  const conversation = requireConversation(session, conversationId);
  if (overlookConversationClosed(conversation.record) && conversation.shown === conversation.record.messages.length) {
    throw statusError('the talk has closed; return to the field', 409, 'OVERLOOK_CONVERSATION_CLOSED');
  }
  if (conversation.waiting) throw statusError('the next line is still on its way', 409, 'OVERLOOK_CONVERSATION_BUSY');
  return conversation;
}

// Shows the next line. A line generated ahead is shown at once; otherwise `onDelta` receives the line's text as
// it streams (first the part already generated, then each delta) until it is complete. Showing a line starts the
// generation of the one after it. Returns the conversation view with the new line.
export async function showNextOverlookLine(session, { conversationId, onDelta = null } = {}) {
  const conversation = assertNextOverlookLineAllowed(session, { conversationId });
  if (conversation.record.messages.length === conversation.shown) {
    const inflight = conversation.inflight;
    if (!inflight) throw new Error(`overlook conversation ${conversationId} has no line in flight`);
    if (onDelta) {
      if (inflight.text) onDelta(inflight.text);
      inflight.listeners.add(onDelta);
    }
    conversation.waiting = true;
    try {
      await inflight.promise;
    } finally {
      conversation.waiting = false;
      inflight.listeners.delete(onDelta);
    }
    assertLive(session);
    if (conversation.discarded) throw statusError(`no such overlook conversation: ${conversationId}`, 404, 'OVERLOOK_CONVERSATION_NOT_FOUND');
  }
  conversation.shown += 1;
  startTurn(session, conversation);
  return overlookConversationView(conversation.record, { shown: conversation.shown });
}

// Back to the field after the closing line: the traces from before the previous return go, and the academy may
// pick its next focus.
export function returnFromOverlookConversation(session, { conversationId } = {}) {
  advanceOverlookSession(session);
  const conversation = requireConversation(session, conversationId);
  if (!overlookConversationClosed(conversation.record) || conversation.shown !== conversation.record.messages.length) {
    throw statusError('the talk has not closed yet', 409, 'OVERLOOK_CONVERSATION_OPEN');
  }
  if (session.focus?.conversation_id !== conversationId) throw statusError('the talk is not the current focus', 409, 'OVERLOOK_FOCUS_MISMATCH');
  session.focus = null;
  clearTracesBeforeLastReturn(session);
  selectAcademyFocus(session);
}

// ---------- exit ----------

// Leaves the destination: persists the surface, folds the watched talks and the writing-moved children into the
// routing content result and writes it onto runtime_state, then ends the session. Returns the content result.
export async function exitOverlook(session, { now } = {}) {
  advanceOverlookSession(session);
  if (typeof now !== 'string' || !now) throw new Error('overlook exit requires now');
  await persistSurface(session);
  assertLive(session);
  const state = await session.storage.readJson(RUNTIME_STATE_PATH);
  const record = buildOverlookContentResult({
    week: requireRoutingContentWeek(state),
    now,
    watchedConversations: session.watched,
    writingMovers: session.movers
  });
  await session.storage.writeJson(RUNTIME_STATE_PATH, { ...state, [ROUTING_CONTENT_RESULT_STATE_KEY]: record });
  disposeOverlookSession(session);
  return record;
}
