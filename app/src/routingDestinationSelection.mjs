// Single source for the routing destination candidate set.
//
// The routing hub's destination decision has three surfaces that must offer the exact same candidate
// set or they drift: (a) the routing_destination_selection gate prompt, (b) parseRoutingDestinationAnswer's
// accepted set, and (c) the routing meta-context destination catalog rendering. All three derive the set
// from here so they can never disagree.
//
// The set is the full catalog minus every hub-unreachable and every gated destination, then the unlocked
// gated destinations added back in the catalog's own order. With no unlocks the result is the full
// non-gated, hub-reachable catalog.
//
// This module stays pure: the unlock signal (which gated destinations are earned) is computed from player
// parameters where they are readable (hub-context build time) and passed in as data, never loaded here.

import { GATED_ROUTING_DESTINATION_IDS, routingDestinations } from './routingDestinations.mjs';

// Hub-unreachable destinations: catalog members the hub never offers, whatever the unlock signal. Their
// modules, APIs, screens and data stay in place (a save already inside one still loads and returns to the
// hub); only the hub's candidate set excludes them. `overlook`（星見の窓）is closed as a hub destination.
const HUB_UNREACHABLE_ROUTING_DESTINATION_IDS = Object.freeze(new Set(['overlook']));

for (const id of HUB_UNREACHABLE_ROUTING_DESTINATION_IDS) {
  if (!routingDestinations.some((destination) => destination.id === id)) {
    throw new Error(`hub-unreachable routing destination is not in the catalog: ${id}`);
  }
  if (GATED_ROUTING_DESTINATION_IDS.has(id)) {
    throw new Error(`hub-unreachable routing destination must not also be gated: ${id}`);
  }
}

// Normalizes the unlocked-gated-destination-id input to the closed set of valid gated ids actually unlocked.
// Every listed id must be a real gated destination (an unknown id is a caller bug, not silently ignored);
// duplicates collapse. An absent list is the honest fail-closed "nothing unlocked".
function normalizeUnlockedGatedDestinationIds(unlockedGatedDestinationIds) {
  if (unlockedGatedDestinationIds === undefined || unlockedGatedDestinationIds === null) return new Set();
  if (!Array.isArray(unlockedGatedDestinationIds)) {
    throw new Error('unlockedGatedDestinationIds must be an array');
  }
  const unlocked = new Set();
  for (const id of unlockedGatedDestinationIds) {
    if (!GATED_ROUTING_DESTINATION_IDS.has(id)) {
      throw new Error(`unlockedGatedDestinationIds contains a non-gated destination: ${id}`);
    }
    unlocked.add(id);
  }
  return unlocked;
}

export function routingDestinationsForState(state, unlockedGatedDestinationIds = []) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('runtime state is required to resolve routing destinations');
  }
  const unlocked = normalizeUnlockedGatedDestinationIds(unlockedGatedDestinationIds);
  return routingDestinations.filter((destination) => {
    if (HUB_UNREACHABLE_ROUTING_DESTINATION_IDS.has(destination.id)) return false;
    if (GATED_ROUTING_DESTINATION_IDS.has(destination.id)) return unlocked.has(destination.id);
    return true;
  });
}
