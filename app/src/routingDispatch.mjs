import { routingDestinations } from './routingDestinations.mjs';

const ROUTING_DISPATCH_TARGETS = Object.freeze({
  'academy-map': 'academy-map',
  training: 'academy-training',
  dungeon: 'academy-dungeon',
  errand: 'academy-errand',
  alchemy: 'academy-alchemy',
  study_circle: 'academy-study-circle',
  workshop: 'academy-workshop',
  library: 'academy-library',
  arena: 'academy-arena',
  auction: 'academy-auction',
  lounge: 'academy-lounge',
  homunculus: 'academy-atelier',
  title: 'title'
});

// The wrap-up destination ('区切りをつける'): a neutral exit that returns to the title screen without
// progressing the week. It is the one dispatch that does not run startNextAcademyWeek, so callers
// branch on it to skip the week increment / sanrin redraw / graduation firing.
export const ROUTING_TITLE_DESTINATION_ID = 'title';

export function isRoutingTitleDispatch(dispatch) {
  return dispatch?.destination_id === ROUTING_TITLE_DESTINATION_ID;
}

function routingDispatchError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function resolveRoutingDestinationDispatch(destinationId) {
  const normalizedId = String(destinationId ?? '').trim();
  const destination = routingDestinations.find((item) => item.id === normalizedId);
  if (!destination) throw routingDispatchError(`unknown routing destination: ${destinationId}`);
  const screen = ROUTING_DISPATCH_TARGETS[destination.id];
  if (!screen) throw routingDispatchError(`routing destination has no dispatch target: ${destination.id}`);
  return {
    destination_id: destination.id,
    destination_label: destination.label,
    next_screen: screen,
    transition: { next_screen: screen }
  };
}

export function resolveRoutingHubDispatch(conversation) {
  if (!conversation?.routing_hub) return null;
  const judgment = conversation.routing_destination_judgment;
  if (!judgment || judgment.decided !== true) {
    throw routingDispatchError('routing hub conversation has no decided routing destination', 409);
  }
  return resolveRoutingDestinationDispatch(judgment.destination_id);
}
