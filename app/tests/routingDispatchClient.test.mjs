import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTING_DISPATCH_SCREENS, assertDrainedRoutingFinalization, assertRoutingDispatchFinalization, validateRoutingDispatchScreen } from '../public/routingDispatchClient.js';

test('the frontend dispatch screen map mirrors the backend routing dispatch targets', () => {
  assert.deepEqual(ROUTING_DISPATCH_SCREENS, {
    'academy-map': 'academy-map',
    training: 'academy-training',
    dungeon: 'academy-dungeon',
    errand: 'academy-errand',
    alchemy: 'academy-alchemy',
    study_circle: 'academy-study-circle',
    workshop: 'academy-workshop',
    library: 'academy-library',
    homunculus: 'academy-atelier',
    arena: 'academy-arena',
    auction: 'academy-auction',
    lounge: 'academy-lounge',
    title: 'title'
  });
});

test('assertDrainedRoutingFinalization accepts only the drained status', () => {
  // Drain-on-exit: every routing exit fully drains the queue server-side, so the content-return case
  // reports 'drained'. Anything else (missing, still-queued, inline-completed, or a skip) fail-fasts
  // instead of transitioning on a partial response.
  assert.doesNotThrow(() => assertDrainedRoutingFinalization('drained'));
  for (const status of [undefined, null, 'queued', 'completed', 'running', 'skipped', '']) {
    assert.throws(() => assertDrainedRoutingFinalization(status), /expected finalization_status 'drained'/);
  }
});

test('assertRoutingDispatchFinalization expects drained for every destination (drain-on-exit)', () => {
  // Every routing hub dispatch — the wrap-up ('title') and the content destinations — fully
  // drains the queue server-side before responding, so only 'drained' is accepted for all of them.
  for (const destinationId of ['title', 'academy-map', 'training', 'dungeon', 'errand', 'alchemy', 'study_circle', 'workshop', 'library', 'homunculus', 'arena', 'auction', 'lounge']) {
    assert.doesNotThrow(() => assertRoutingDispatchFinalization({ destination_id: destinationId }, 'drained'));
    for (const status of ['queued', undefined, null, 'completed', '']) {
      assert.throws(
        () => assertRoutingDispatchFinalization({ destination_id: destinationId }, status),
        /expected finalization_status 'drained' for destination/
      );
    }
  }
});

test('validateRoutingDispatchScreen returns the target screen for every allowed destination', () => {
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'academy-map', next_screen: 'academy-map' }), 'academy-map');
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'training', next_screen: 'academy-training' }), 'academy-training');
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'dungeon', next_screen: 'academy-dungeon' }), 'academy-dungeon');
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'errand', next_screen: 'academy-errand' }), 'academy-errand');
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'alchemy', next_screen: 'academy-alchemy' }), 'academy-alchemy');
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'study_circle', next_screen: 'academy-study-circle' }), 'academy-study-circle');
  // The workshop destination lands on the stay-and-craft workshop arrival screen.
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'workshop', next_screen: 'academy-workshop' }), 'academy-workshop');
  // The library destination lands on the search-driven stay library arrival screen.
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'library', next_screen: 'academy-library' }), 'academy-library');
  // The 錬成室 destination lands on the stay atelier arrival screen.
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'homunculus', next_screen: 'academy-atelier' }), 'academy-atelier');
  // The 闘技会 destination lands on the arena screen (mode selection → bracket → matches).
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'arena', next_screen: 'academy-arena' }), 'academy-arena');
  // The 競売場 destination lands on the auction screen (board + streamed bidding).
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'auction', next_screen: 'academy-auction' }), 'academy-auction');
  // The 談話室 destination lands on the lounge screen (multi-speaker round talk).
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'lounge', next_screen: 'academy-lounge' }), 'academy-lounge');
  // The wrap-up destination maps to the title screen.
  assert.equal(validateRoutingDispatchScreen({ destination_id: 'title', next_screen: 'title' }), 'title');
});

test('validateRoutingDispatchScreen fail-fasts when the wrap-up screen disagrees with its destination', () => {
  assert.throws(() => validateRoutingDispatchScreen({ destination_id: 'title', next_screen: 'academy-map' }), /screen mismatch/);
  assert.throws(() => validateRoutingDispatchScreen({ destination_id: 'dungeon', next_screen: 'title' }), /screen mismatch/);
});

test('validateRoutingDispatchScreen fail-fasts on an unknown destination id', () => {
  // Unknown / missing / non-own-property destination ids surface as errors, never an ambiguous route.
  for (const destinationId of ['academy-dungeon', 'shop', 'constructor', '__proto__', '', undefined, null, 42]) {
    assert.throws(() => validateRoutingDispatchScreen({ destination_id: destinationId, next_screen: 'academy-map' }), /unknown destination_id/);
  }
});

test('validateRoutingDispatchScreen fail-fasts when the dispatch screen disagrees with its destination', () => {
  assert.throws(() => validateRoutingDispatchScreen({ destination_id: 'training', next_screen: 'academy-dungeon' }), /screen mismatch/);
  assert.throws(() => validateRoutingDispatchScreen({ destination_id: 'dungeon', next_screen: 'interaction' }), /screen mismatch/);
  assert.throws(() => validateRoutingDispatchScreen({ destination_id: 'academy-map', next_screen: undefined }), /screen mismatch/);
});
