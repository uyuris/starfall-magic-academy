import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTING_OPENING_EVENT_FLAG_ID,
  ROUTING_OPENING_EVENT_COMPLETED_FLAG_ID,
  addRoutingOpeningEvent,
  isRoutingOpeningEventPending
} from '../src/routingOpeningEvent.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../src/routingPersona.mjs';

test('addRoutingOpeningEvent seeds the routing opening event with the routing persona as source actor', () => {
  const seeded = addRoutingOpeningEvent({ global_flags: {}, event_flag_sources: {} }, '2026-07-05T00:00:00.000Z');
  assert.equal(seeded.global_flags[ROUTING_OPENING_EVENT_FLAG_ID], true);
  assert.deepEqual(seeded.event_flag_sources[ROUTING_OPENING_EVENT_FLAG_ID], {
    character_id: ROUTING_PERSONA_CHARACTER_ID,
    conversation_id: null,
    achieved_at: '2026-07-05T00:00:00.000Z',
    source_type: 'new_game'
  });
});

test('addRoutingOpeningEvent does not mutate the input state', () => {
  const input = { global_flags: {}, event_flag_sources: {} };
  addRoutingOpeningEvent(input, '2026-07-05T00:00:00.000Z');
  assert.deepEqual(input, { global_flags: {}, event_flag_sources: {} });
});

test('isRoutingOpeningEventPending is true only while the event is seeded active and not yet completed', () => {
  assert.equal(isRoutingOpeningEventPending({ global_flags: {} }), false);
  assert.equal(
    isRoutingOpeningEventPending({ global_flags: { [ROUTING_OPENING_EVENT_FLAG_ID]: true } }),
    true
  );
  assert.equal(
    isRoutingOpeningEventPending({
      global_flags: {
        [ROUTING_OPENING_EVENT_FLAG_ID]: true,
        [ROUTING_OPENING_EVENT_COMPLETED_FLAG_ID]: true
      }
    }),
    false,
    'a completed opening event is no longer pending, so later hub visits use the normal greeting'
  );
});

test('isRoutingOpeningEventPending tolerates missing or nullish state without throwing', () => {
  assert.equal(isRoutingOpeningEventPending({}), false);
  assert.equal(isRoutingOpeningEventPending(null), false);
  assert.equal(isRoutingOpeningEventPending(undefined), false);
});
