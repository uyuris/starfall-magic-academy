// Pure routing-hub conversation-end contract checks, shared by app.js and headless unit tests so
// the fail-fast paths are verifiable without a browser.

// The closed set of routing hub dispatch destinations, mirroring the backend dispatch targets
// (app/src/routingDispatch.mjs ROUTING_DISPATCH_TARGETS): destination_id -> the screen the player is
// dispatched to. 'title' is the wrap-up exit (区切りをつける) back to the title screen.
export const ROUTING_DISPATCH_SCREENS = Object.freeze({
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

// Drain-on-exit: every routing conversation exit fully drains the pending-finalization queue
// server-side before it responds, so the content-return case (no hub dispatch) reports
// finalization_status 'drained'. Any other status — absent, 'queued', 'completed', or a skip — is
// unexpected and fail-fasts instead of transitioning on a partial response.
export function assertDrainedRoutingFinalization(finalizationStatus) {
  if (finalizationStatus !== 'drained') {
    throw new Error(`routing conversation end: expected finalization_status 'drained', got ${JSON.stringify(finalizationStatus)}`);
  }
}

// A routing hub dispatch (the wrap-up 'title' or one of the content destinations) also drains the
// whole queue server-side before responding, so every destination reports 'drained'. Assert it for the
// given dispatch; any mismatch fail-fasts rather than transitioning on a partial response.
export function assertRoutingDispatchFinalization(dispatch, finalizationStatus) {
  if (finalizationStatus !== 'drained') {
    throw new Error(`routing dispatch: expected finalization_status 'drained' for destination ${JSON.stringify(dispatch?.destination_id)}, got ${JSON.stringify(finalizationStatus)}`);
  }
}

// Validate a routing hub dispatch payload against the allowed destinations and return its content
// screen. An unknown destination_id, or a next_screen that does not match the destination's target,
// fail-fasts — an unknown destination surfaces as an error rather than an ambiguous continue.
export function validateRoutingDispatchScreen(dispatch) {
  const destinationId = dispatch?.destination_id;
  if (typeof destinationId !== 'string' || !Object.hasOwn(ROUTING_DISPATCH_SCREENS, destinationId)) {
    throw new Error(`routing dispatch: unknown destination_id ${JSON.stringify(destinationId)}`);
  }
  const dispatchScreen = ROUTING_DISPATCH_SCREENS[destinationId];
  if (dispatch.next_screen !== dispatchScreen) {
    throw new Error(`routing dispatch: destination ${destinationId} screen mismatch (got ${JSON.stringify(dispatch.next_screen)}, expected ${dispatchScreen})`);
  }
  return dispatchScreen;
}
