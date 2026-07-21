import { ROUTING_PERSONA_CHARACTER_ID } from './routingPersona.mjs';

// The routing opening event: the one-time routing persona hub greeting a routing new game opens
// on. It rides the shared event mechanism (definition in game_data/event_flags.json, opening_context
// injected into the opening prompt as「このイベントの文脈:」), exactly like loop's opening mentor
// intro. The canonical guidance text lives only in the event definition, never in code.
export const ROUTING_OPENING_EVENT_FLAG_ID = 'event.routing_opening_intro.ready';
export const ROUTING_OPENING_EVENT_COMPLETED_FLAG_ID = 'event.routing_opening_intro.completed';

// Seed the routing opening event for a routing new game, mirroring addOpeningMentorEvent's shape.
// The event source actor is the routing persona (ルミ), so runConversationOpening reads the pending
// interaction context as this actor's event context at hub start.
export function addRoutingOpeningEvent(state, now = new Date().toISOString()) {
  const next = structuredClone(state);
  next.global_flags ??= {};
  next.event_flag_sources ??= {};
  next.global_flags[ROUTING_OPENING_EVENT_FLAG_ID] = true;
  next.event_flag_sources[ROUTING_OPENING_EVENT_FLAG_ID] = {
    character_id: ROUTING_PERSONA_CHARACTER_ID,
    conversation_id: null,
    achieved_at: now,
    source_type: 'new_game'
  };
  return next;
}

// True exactly while the routing opening event is seeded active and not yet completed. Reading the raw
// runtime flags (not the decorated pending list) keeps hub start fail-fast: when the event is seeded
// but its definition is missing or malformed, this still reports pending, so startEventFlagInteraction
// throws instead of the hub silently skipping the opening.
export function isRoutingOpeningEventPending(state) {
  const globalFlags = state?.global_flags ?? {};
  return globalFlags[ROUTING_OPENING_EVENT_FLAG_ID] === true
    && globalFlags[ROUTING_OPENING_EVENT_COMPLETED_FLAG_ID] !== true;
}
