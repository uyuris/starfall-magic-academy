import test from 'node:test';
import assert from 'node:assert/strict';

import { routingDestinations, parseRoutingDestinationAnswer } from '../src/routingDestinations.mjs';
import { routingDestinationsForState } from '../src/routingDestinationSelection.mjs';

const NON_GATED_IDS = ['academy-map', 'training', 'dungeon', 'errand', 'alchemy', 'study_circle', 'workshop', 'library', 'arena', 'auction', 'lounge', 'title'];
const WITH_HOMUNCULUS_IDS = ['academy-map', 'training', 'dungeon', 'errand', 'alchemy', 'study_circle', 'workshop', 'library', 'arena', 'auction', 'lounge', 'homunculus', 'title'];

test('with no unlocks the candidate set is the full catalog minus every gated destination, in catalog order', () => {
  for (const elapsedWeeks of [0, 1, 8, 9, 29, 48]) {
    assert.deepEqual(
      routingDestinationsForState({ elapsed_weeks: elapsedWeeks }).map((destination) => destination.id),
      NON_GATED_IDS,
      `elapsed_weeks=${elapsedWeeks} offers the same week-independent set`
    );
  }
});

test('an unlocked gated destination is added back in catalog order', () => {
  assert.deepEqual(
    routingDestinationsForState({ elapsed_weeks: 3 }, ['homunculus']).map((d) => d.id),
    WITH_HOMUNCULUS_IDS
  );
});

test('the filtered set is the single accepted set for parseRoutingDestinationAnswer', () => {
  const set = routingDestinationsForState({ elapsed_weeks: 3 });
  assert.equal(parseRoutingDestinationAnswer('training', set).id, 'training');
  assert.equal(parseRoutingDestinationAnswer('title', set).id, 'title');
  assert.equal(parseRoutingDestinationAnswer('none', set), null);
  // A gated destination is not in the default set: fail fast.
  assert.throws(() => parseRoutingDestinationAnswer('homunculus', set), /unknown routing destination/);
});

test('the resolver fails fast on a non-object state and on a non-gated unlock id', () => {
  assert.throws(() => routingDestinationsForState(null), /runtime state is required/);
  assert.throws(() => routingDestinationsForState([]), /runtime state is required/);
  assert.throws(() => routingDestinationsForState({ elapsed_weeks: 3 }, ['training']), /non-gated destination/);
});
