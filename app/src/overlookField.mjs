// 星見の窓 (overlook) field engine: the academy clock, the children's walk on the road network, encounters,
// the approaching-pair forecast and the focus ranking. Everything here is synchronous and deterministic in its
// inputs — the field seed, the wishes it is given and the tick it is stepped to — so the same seed and the same
// wishes applied at the same ticks reproduce the same position sequence. The LM never runs here: the runtime
// (routingOverlook.mjs) feeds wishes in and turns the events this engine emits into LM work.
//
// Geometry is in map pixels (the 3340×1884 field map at zoom 1.0). The road network is
// `overlook_field.json`; a child only ever stands on a node or on the segment
// between two adjacent nodes.
//
// Clock: one tick is TICK_MS of real time; 5 real minutes are one academy hour, the entry opens at 9:00 and
// the field ends at 15:00 (30 real minutes).

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { createRng, deriveSeed } from './dungeon/dungeonRng.mjs';
import { OVERLOOK_FRICTION_FEELING_LABELS } from './overlookState.mjs';

export const OVERLOOK_FIELD_DEFINITIONS_FILENAME = 'overlook_field.json';

export const OVERLOOK_TICK_MS = 40;
export const OVERLOOK_REAL_MS_PER_ACADEMY_MINUTE = 5000;
export const OVERLOOK_START_MINUTE = 9 * 60;
export const OVERLOOK_END_MINUTE = 15 * 60;
export const OVERLOOK_TICKS_PER_ACADEMY_MINUTE = OVERLOOK_REAL_MS_PER_ACADEMY_MINUTE / OVERLOOK_TICK_MS;
export const OVERLOOK_END_TICK = (OVERLOOK_END_MINUTE - OVERLOOK_START_MINUTE) * OVERLOOK_TICKS_PER_ACADEMY_MINUTE;
// A wish lapses one academy hour after it is decided (籠もる / 確かめる at a place: one hour after arriving).
export const OVERLOOK_WISH_DURATION_MINUTES = 60;
// 接近中の出会い: two children that would come within encounter distance within 15 academy minutes.
export const OVERLOOK_APPROACH_HORIZON_MINUTES = 15;

// Encounter distance: one face disc (56 px) + 8 px, the gap 会う stops at.
export const OVERLOOK_ENCOUNTER_DISTANCE_PX = 64;
// A pair that has met is re-armed only once it has separated past this distance (or one of them takes a new
// wish aimed at the other), so two children standing together after a talk do not meet again on the next tick.
export const OVERLOOK_REARM_DISTANCE_PX = 128;
// 避ける turns back when the avoided child comes this close.
export const OVERLOOK_AVOID_TURN_DISTANCE_PX = 210;

// The walk table (composition plan 0.4): speed in map px per real second and the pattern the client animates.
export const OVERLOOK_WALK = Object.freeze({
  探す: Object.freeze({ speed: 110, pattern: 'search' }),
  会う: Object.freeze({ speed: 110, pattern: 'meet' }),
  避ける: Object.freeze({ speed: 130, pattern: 'avoid' }),
  籠もる: Object.freeze({ speed: 40, pattern: 'stay' }),
  確かめる: Object.freeze({ speed: 70, pattern: 'check' })
});
// 探す stops 0.48 s at every fork; 確かめる circles 1.6 s on arrival.
export const OVERLOOK_SEARCH_FORK_PAUSE_TICKS = Math.round(480 / OVERLOOK_TICK_MS);
export const OVERLOOK_CHECK_CIRCLE_TICKS = Math.round(1600 / OVERLOOK_TICK_MS);

// 顔ぶれの入れ替え (brief §2 門の通り方): the road outside the gate runs from the front gate's place point due south
// past the map's bottom edge, off the road network. A child sent off walks the network's shortest way to the gate
// point and then down the lane 28 px west of the road's centre; the newcomer walks up the lane 28 px east of it.
// Both walk at 110 without stopping. A child is off the map once its whole face disc (56 px) is below the edge.
export const OVERLOOK_GATE_PLACE_ID = 'front_gate_morning';
export const OVERLOOK_GATE_LANE_OFFSET_PX = 28;
export const OVERLOOK_GATE_WALK_SPEED = 110;
export const OVERLOOK_FACE_RADIUS_PX = 28;

const FIELD_SEED_BASE = 0x4f564644; // 'OVFD'
const ROUTE_VIEW_NODES = 40;
const APPROACH_SAMPLE_TICKS = Math.round(1000 / OVERLOOK_TICK_MS);

function fieldError(message) {
  return new Error(`overlook field ${message}`);
}

// ---------- clock ----------

export function overlookMinuteAtTick(tick) {
  if (!Number.isInteger(tick) || tick < 0) throw fieldError(`tick must be a non-negative integer: ${tick}`);
  return OVERLOOK_START_MINUTE + Math.floor(tick / OVERLOOK_TICKS_PER_ACADEMY_MINUTE);
}

export function overlookTickAtMinute(minute) {
  if (!Number.isInteger(minute) || minute < OVERLOOK_START_MINUTE) throw fieldError(`minute must be an integer ≥ ${OVERLOOK_START_MINUTE}: ${minute}`);
  return (minute - OVERLOOK_START_MINUTE) * OVERLOOK_TICKS_PER_ACADEMY_MINUTE;
}

// "9:40" — the academy time label the top bar and the traces show.
export function formatOverlookMinute(minute) {
  if (!Number.isInteger(minute) || minute < 0) throw fieldError(`minute must be a non-negative integer: ${minute}`);
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

// ---------- graph ----------

export function buildOverlookFieldGraph(raw) {
  if (!raw || typeof raw !== 'object' || !raw.map || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(raw.places)) {
    throw fieldError('definition must hold map, nodes, edges and places');
  }
  const { width, height } = raw.map;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw fieldError('map size must be positive');
  const nodes = new Map();
  for (const node of raw.nodes) {
    if (nodes.has(node.id)) throw fieldError(`duplicate node: ${node.id}`);
    nodes.set(node.id, { id: node.id, x: node.x * width, y: node.y * height });
  }
  const neighbors = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const [a, b] of raw.edges) {
    if (!nodes.has(a) || !nodes.has(b)) throw fieldError(`edge names an unknown node: ${a}–${b}`);
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  for (const list of neighbors.values()) list.sort();
  const places = raw.places.map((place) => {
    const node = nodes.get(place.node);
    if (!node) throw fieldError(`place ${place.location_id} names an unknown node: ${place.node}`);
    return { location_id: place.location_id, node: place.node, radius: place.radius, x: node.x, y: node.y };
  });
  return {
    width,
    height,
    nodes,
    neighbors,
    places,
    placeById: new Map(places.map((place) => [place.location_id, place]))
  };
}

export async function loadOverlookFieldGraph({ root } = {}) {
  if (!root) throw new Error('overlook field graph requires root');
  const storage = createStorageApi({ root });
  const filePath = path.join(storage.paths.definitionsRoot, OVERLOOK_FIELD_DEFINITIONS_FILENAME);
  return buildOverlookFieldGraph(JSON.parse(await fs.readFile(filePath, 'utf8')));
}

function nodeDistance(graph, a, b) {
  const na = graph.nodes.get(a);
  const nb = graph.nodes.get(b);
  return Math.hypot(na.x - nb.x, na.y - nb.y);
}

// Dijkstra over the node graph with a binary heap; ties resolve by node id so a route is a pure function of
// its endpoints.
function heapPush(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!entryBefore(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && entryBefore(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && entryBefore(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  }
  return top;
}

function entryBefore(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function shortestPath(graph, from, to) {
  if (from === to) return [];
  const dist = new Map([[from, 0]]);
  const previous = new Map();
  const done = new Set();
  const heap = [[0, from]];
  while (heap.length) {
    const [d, id] = heapPop(heap);
    if (done.has(id)) continue;
    done.add(id);
    if (id === to) break;
    for (const next of graph.neighbors.get(id)) {
      if (done.has(next)) continue;
      const candidate = d + nodeDistance(graph, id, next);
      if (!dist.has(next) || candidate < dist.get(next)) {
        dist.set(next, candidate);
        previous.set(next, id);
        heapPush(heap, [candidate, next]);
      }
    }
  }
  if (!previous.has(to)) throw fieldError(`no route from ${from} to ${to}`);
  const route = [];
  for (let id = to; id !== from; id = previous.get(id)) route.push(id);
  return route.reverse();
}

// The place whose radius (normalized Euclid) holds the point, or null.
export function overlookPlaceAt(graph, point) {
  for (const place of graph.places) {
    const dx = (point.x - place.x) / graph.width;
    const dy = (point.y - place.y) / graph.height;
    if (Math.sqrt(dx * dx + dy * dy) <= place.radius) return place.location_id;
  }
  return null;
}

function nearestPlace(graph, point) {
  let best = null;
  let bestDistance = Infinity;
  for (const place of graph.places) {
    const distance = Math.hypot(place.x - point.x, place.y - point.y);
    if (distance < bestDistance) {
      best = place;
      bestDistance = distance;
    }
  }
  return best.location_id;
}

function routeLength(graph, from, route) {
  let length = 0;
  let at = from;
  for (const id of route) {
    length += nodeDistance(graph, at, id);
    at = id;
  }
  return length;
}

// ---------- the road outside the gate ----------

function gatePlace(graph) {
  const place = graph.placeById.get(OVERLOOK_GATE_PLACE_ID);
  if (!place) throw fieldError(`has no gate place: ${OVERLOOK_GATE_PLACE_ID}`);
  return place;
}

// The polyline a gate walker follows. Leaving: gate point → its lane → below the map. Arriving: below the map →
// its lane → gate point.
function gateRoadPoints(graph, phase) {
  const gate = gatePlace(graph);
  const x = gate.x + (phase === 'leaving' ? -OVERLOOK_GATE_LANE_OFFSET_PX : OVERLOOK_GATE_LANE_OFFSET_PX);
  const lane = [{ x, y: gate.y }, { x, y: graph.height + OVERLOOK_FACE_RADIUS_PX }];
  const gatePoint = { x: gate.x, y: gate.y };
  return phase === 'leaving' ? [gatePoint, ...lane] : [...lane.reverse(), gatePoint];
}

function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += distanceBetween(points[index - 1], points[index]);
  return length;
}

function polylinePoint(points, traveled) {
  let left = traveled;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const length = distanceBetween(a, b);
    if (left <= length) return { x: a.x + ((b.x - a.x) * left) / length, y: a.y + ((b.y - a.y) * left) / length };
    left -= length;
  }
  return { ...points[points.length - 1] };
}

// The polyline points still ahead of a walker `traveled` along it.
function polylineAhead(points, traveled) {
  let at = 0;
  const ahead = [];
  for (let index = 1; index < points.length; index += 1) {
    at += distanceBetween(points[index - 1], points[index]);
    if (at > traveled) ahead.push({ ...points[index] });
  }
  return ahead;
}

// ---------- field state ----------

function childPosition(graph, child) {
  if (child.gate?.road) return polylinePoint(child.gate.road.points, child.gate.road.traveled);
  if (child.gate?.phase === 'outside') return gateRoadPoints(graph, 'arriving')[0];
  const from = graph.nodes.get(child.from);
  if (child.to === null) return { x: from.x, y: from.y };
  const to = graph.nodes.get(child.to);
  const length = nodeDistance(graph, child.from, child.to);
  const ratio = length === 0 ? 0 : child.offset / length;
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function nearestNodeOf(graph, child) {
  // A child on the road outside the gate is reached through the gate.
  if (child.gate) return gatePlace(graph).node;
  if (child.to === null) return child.from;
  return child.offset * 2 < nodeDistance(graph, child.from, child.to) ? child.from : child.to;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Creates the field for one entry: every member stands on a distinct place node drawn from the seed, holds no
// wish yet (the runtime decides the entry 湧き before the clock starts) and is held as `deciding`.
export function createOverlookField({ graph, members, seed } = {}) {
  if (!graph) throw fieldError('requires the graph');
  if (!Array.isArray(members) || members.length === 0) throw fieldError('requires members');
  if (!Number.isInteger(seed)) throw fieldError('requires an integer seed');
  if (graph.places.length < members.length) throw fieldError('has fewer places than members');
  const rng = createRng(deriveSeed(FIELD_SEED_BASE, seed));
  const starts = rng.shuffle(graph.places).slice(0, members.length);
  const children = new Map();
  members.forEach((id, index) => {
    children.set(id, {
      id,
      from: starts[index].node,
      to: null,
      offset: 0,
      route: [],
      wish: null,
      hold: 'deciding',
      halted: false,
      pauseTicks: 0,
      replanTick: 0,
      placeId: starts[index].location_id,
      gate: null
    });
  });
  return { graph, rng, tick: 0, children, disarmed: new Set() };
}

function requireChild(field, id) {
  const child = field.children.get(id);
  if (!child) throw fieldError(`has no child: ${id}`);
  return child;
}

export function overlookChildPoint(field, id) {
  return childPosition(field.graph, requireChild(field, id));
}

// Where a wish sends a child next, as a node id.
function wishDestination(field, child) {
  const { graph } = field;
  const wish = child.wish;
  if (wish.target.kind === 'place') return graph.placeById.get(wish.target.id).node;
  const partner = requireChild(field, wish.target.id);
  const partnerPoint = childPosition(graph, partner);
  if (wish.action === '避ける') {
    // Away: the place farthest from the avoided child (places are scanned in definition order, so a tie keeps
    // the earlier one).
    let best = null;
    let bestDistance = -1;
    for (const place of graph.places) {
      const distance = distanceBetween(place, partnerPoint);
      if (distance > bestDistance) {
        best = place;
        bestDistance = distance;
      }
    }
    return best.node;
  }
  if (wish.action === '探す') {
    // Place to place: the place nearest to where the sought child is, unless the searcher already stands in
    // it — then straight to the child.
    const place = graph.placeById.get(nearestPlace(graph, partnerPoint));
    const here = overlookPlaceAt(graph, childPosition(graph, child));
    return here === place.location_id ? nearestNodeOf(graph, partner) : place.node;
  }
  return nearestNodeOf(graph, partner);
}

function routeEnd(child) {
  return child.route.length ? child.route[child.route.length - 1] : child.to ?? child.from;
}

// Routes a child from where it stands to its wish's destination. A child between two nodes keeps walking to the
// node ahead and routes on from there.
function planRoute(field, child) {
  const destination = wishDestination(field, child);
  child.halted = false;
  child.replanTick = field.tick;
  if (child.to !== null) {
    child.route = shortestPath(field.graph, child.to, destination);
    return;
  }
  const route = shortestPath(field.graph, child.from, destination);
  child.to = route.shift() ?? null;
  child.offset = 0;
  child.route = route;
}

// Gives a child a new wish and releases it onto the field. A wish aimed at a child re-arms that pair, so the
// two can meet even when they are standing together. A newcomer still outside the gate keeps the wish and sets
// off toward it once it walks through the gate.
export function setOverlookChildWish(field, id, wish) {
  const child = requireChild(field, id);
  if (!wish) throw fieldError(`wish for ${id} is required`);
  if (child.gate?.phase === 'leaving') throw fieldError(`${id} has been sent off and takes no wish`);
  child.wish = wish;
  child.hold = null;
  child.pauseTicks = 0;
  if (wish.target.kind === 'child') field.disarmed.delete(pairKey(id, wish.target.id));
  if (child.gate) return;
  planRoute(field, child);
}

// Holds a child in place (waiting for its wish to be decided, or in an encounter).
export function holdOverlookChild(field, id, reason) {
  if (reason !== 'deciding' && reason !== 'encounter') throw fieldError(`unknown hold reason: ${reason}`);
  const child = requireChild(field, id);
  if (child.gate?.phase === 'leaving') throw fieldError(`${id} has been sent off and is not held`);
  child.hold = reason;
}

// Where a child stands relative to the gate: null on the road network; 'leaving' once sent off (on its way to
// the gate point and then down the road); 'outside' for a newcomer that has not appeared yet (its leaver has not
// passed the gate point); 'arriving' for a newcomer walking up the road, until it passes the gate point.
export function overlookChildGatePhase(field, id) {
  return requireChild(field, id).gate?.phase ?? null;
}

// Routes a child sent off to the gate node along the network's shortest way, turning back on its segment when
// that is shorter than walking on to the node ahead.
function routeToGate(field, child, gateNode) {
  const { graph } = field;
  if (child.to === null) {
    const route = shortestPath(graph, child.from, gateNode);
    child.to = route.shift() ?? null;
    child.offset = 0;
    child.route = route;
    return;
  }
  const length = nodeDistance(graph, child.from, child.to);
  const ahead = shortestPath(graph, child.to, gateNode);
  const back = shortestPath(graph, child.from, gateNode);
  const aheadCost = length - child.offset + routeLength(graph, child.to, ahead);
  const backCost = child.offset + routeLength(graph, child.from, back);
  if (backCost < aheadCost) {
    [child.from, child.to] = [child.to, child.from];
    child.offset = length - child.offset;
    child.route = back;
  } else {
    child.route = ahead;
  }
}

// 顔ぶれの送り出し (brief §2): the child stops what it was doing and heads out through the gate, and a newcomer
// drawn uniformly with the field seed from the selectable children not on the field — neither the current 12
// (the one sent off included) nor any child still on its way out — waits outside to walk in once the leaver
// passes the gate point. Returns the newcomer's id. The runtime owns the roster and the states; this only moves.
export function sendOverlookChildOff(field, { id, selectableIds } = {}) {
  const child = requireChild(field, id);
  if (child.gate) throw fieldError(`${id} is on the road outside the gate and cannot be sent off`);
  if (!Array.isArray(selectableIds)) throw fieldError('send-off requires selectableIds');
  const candidates = selectableIds.filter((candidate) => !field.children.has(candidate)).sort();
  if (candidates.length === 0) throw fieldError('has no selectable child left to send in');
  const gate = gatePlace(field.graph);
  const arrivingId = field.rng.pick(candidates);
  routeToGate(field, child, gate.node);
  Object.assign(child, {
    wish: null,
    hold: null,
    halted: false,
    pauseTicks: 0,
    placeId: null,
    gate: { phase: 'leaving', arrivingId, road: null }
  });
  for (const key of [...field.disarmed]) {
    if (key.split('|').includes(id)) field.disarmed.delete(key);
  }
  field.children.set(arrivingId, {
    id: arrivingId,
    from: gate.node,
    to: null,
    offset: 0,
    route: [],
    wish: null,
    hold: 'deciding',
    halted: false,
    pauseTicks: 0,
    replanTick: field.tick,
    placeId: null,
    gate: { phase: 'outside' }
  });
  return arrivingId;
}

// One tick of a gate walker at OVERLOOK_GATE_WALK_SPEED, never pausing. A leaver on the network walks its route to
// the gate point; passing it sends its newcomer onto the road below the map, and the leaver continues down its
// lane and is gone once off the map. A newcomer passing the gate point stands on the gate node: it sets off
// toward its wish if one has arrived, and otherwise waits there, held as deciding.
function moveGateWalker(field, child) {
  const { graph } = field;
  const gate = child.gate;
  let budget = (OVERLOOK_GATE_WALK_SPEED * OVERLOOK_TICK_MS) / 1000;
  if (gate.phase === 'leaving' && gate.road === null) {
    while (child.to !== null) {
      const remaining = nodeDistance(graph, child.from, child.to) - child.offset;
      if (budget < remaining) {
        child.offset += budget;
        return;
      }
      budget -= remaining;
      child.from = child.to;
      child.offset = 0;
      child.to = child.route.shift() ?? null;
    }
    gate.road = { points: gateRoadPoints(graph, 'leaving'), traveled: 0 };
    requireChild(field, gate.arrivingId).gate = { phase: 'arriving', road: { points: gateRoadPoints(graph, 'arriving'), traveled: 0 } };
  }
  gate.road.traveled += budget;
  if (gate.road.traveled < polylineLength(gate.road.points)) return;
  if (gate.phase === 'leaving') {
    field.children.delete(child.id);
    return;
  }
  Object.assign(child, { from: gatePlace(graph).node, to: null, offset: 0, route: [], gate: null });
  if (child.hold === null) planRoute(field, child);
}

// A wish that follows a child (会う・探す・確かめる at a child) re-routes at every fork and on arrival, and — when
// it has run out of route while its target walks on — once a second.
const FOLLOW_REPLAN_TICKS = Math.round(1000 / OVERLOOK_TICK_MS);

function follows(wish) {
  return wish.target.kind === 'child' && wish.action !== '避ける';
}

// Moves a free child by one tick. Returns an `arrived` event when it reaches the end of its route.
function moveChild(field, child) {
  const { graph } = field;
  if (child.pauseTicks > 0) {
    child.pauseTicks -= 1;
    return null;
  }
  const wish = child.wish;
  if (follows(wish)) {
    const here = childPosition(graph, child);
    const target = childPosition(graph, requireChild(field, wish.target.id));
    // 会う stops beside the other child (one disc + 8 px) and waits there while the other is busy.
    if (distanceBetween(here, target) <= OVERLOOK_ENCOUNTER_DISTANCE_PX) {
      child.halted = true;
      return null;
    }
    if (child.halted || (child.to === null && field.tick - child.replanTick >= FOLLOW_REPLAN_TICKS)) planRoute(field, child);
  }
  if (child.to === null) return null;
  let budget = (OVERLOOK_WALK[wish.action].speed * OVERLOOK_TICK_MS) / 1000;
  while (budget > 0) {
    const remaining = nodeDistance(graph, child.from, child.to) - child.offset;
    if (budget < remaining) {
      child.offset += budget;
      return null;
    }
    budget -= remaining;
    child.from = child.to;
    child.to = null;
    child.offset = 0;
    const fork = graph.neighbors.get(child.from).length >= 3;
    if (child.route.length === 0) {
      if (wish.action === '確かめる' && wish.target.kind === 'place') child.pauseTicks = OVERLOOK_CHECK_CIRCLE_TICKS;
      if (wish.action === '探す') planRoute(field, child);
      return { type: 'arrived', id: child.id };
    }
    if (fork && wish.target.kind === 'child') planRoute(field, child);
    else child.to = child.route.shift();
    if (child.to === null) return null;
    if (fork && wish.action === '探す') {
      child.pauseTicks = OVERLOOK_SEARCH_FORK_PAUSE_TICKS;
      return null;
    }
  }
  return null;
}

function friction(stateOf, a, b) {
  const aState = stateOf(a);
  const bState = stateOf(b);
  const feelsFriction = (state, other) => OVERLOOK_FRICTION_FEELING_LABELS.includes(state.feelings[other]?.label);
  const avoids = (state, other) => state.wish?.action === '避ける' && state.wish.target.id === other;
  return feelsFriction(aState, b) || feelsFriction(bState, a) || avoids(aState, b) || avoids(bState, a);
}

// The side that speaks first: the one whose wish is aimed at the other; else (neither, or both) the larger
// generation; else the seed.
function initiatorOf(field, a, b) {
  const aWish = requireChild(field, a).wish;
  const bWish = requireChild(field, b).wish;
  const aTargets = aWish.target.kind === 'child' && aWish.target.id === b;
  const bTargets = bWish.target.kind === 'child' && bWish.target.id === a;
  if (aTargets !== bTargets) return aTargets ? [a, b] : [b, a];
  if (aWish.generation !== bWish.generation) return aWish.generation > bWish.generation ? [a, b] : [b, a];
  return field.rng.chance(0.5) ? [a, b] : [b, a];
}

// The chain generation an encounter carries (the larger of the two wishes) and whether a written line started it.
function encounterLineage(field, a, b) {
  const wishes = [requireChild(field, a).wish, requireChild(field, b).wish].filter(Boolean);
  return {
    generation: Math.max(1, ...wishes.map((wish) => wish.generation)),
    from_writing: wishes.some((wish) => wish.source.kind === 'writing')
  };
}

// Advances the field by one tick. The gate walkers move first (in id order; a newcomer that appears this tick
// starts walking on the next), then the children on the road network. Gate walkers take no part in wishes,
// places or encounters. `stateOf(id)` reads a child's persisted state (feelings / wish) for the encounter
// classification. Returns the tick's events in a fixed order:
//   { type: 'wish_expired', id }                    — a wish lapsed; the child is held until it has a new one
//   { type: 'arrived', id }                          — a child reached the end of its route
//   { type: 'entered_place', id, place_id }          — a child walked into a place's radius
//   { type: 'encounter', initiator, partner, place_id, friction, generation, from_writing }
export function stepOverlookField(field, { stateOf } = {}) {
  if (typeof stateOf !== 'function') throw fieldError('step requires stateOf');
  if (field.tick >= OVERLOOK_END_TICK) throw fieldError('has already ended');
  const { graph } = field;
  field.tick += 1;
  const minute = overlookMinuteAtTick(field.tick);
  const events = [];
  const walkers = [...field.children.values()].filter((child) => child.gate && child.gate.phase !== 'outside').map((child) => child.id).sort();
  for (const id of walkers) moveGateWalker(field, field.children.get(id));
  const ids = [...field.children.values()].filter((child) => !child.gate).map((child) => child.id).sort();
  for (const id of ids) {
    const child = field.children.get(id);
    if (child.hold !== null) continue;
    if (child.wish.expires_at_minute <= minute) {
      child.hold = 'deciding';
      events.push({ type: 'wish_expired', id });
      continue;
    }
    if (child.wish.action === '避ける' && child.pauseTicks === 0) {
      const partnerPoint = childPosition(graph, requireChild(field, child.wish.target.id));
      if (distanceBetween(partnerPoint, childPosition(graph, child)) <= OVERLOOK_AVOID_TURN_DISTANCE_PX && wishDestination(field, child) !== routeEnd(child)) {
        planRoute(field, child);
      }
    }
    const moved = moveChild(field, child);
    if (moved) events.push(moved);
  }
  const points = new Map(ids.map((id) => [id, childPosition(graph, field.children.get(id))]));
  for (const id of ids) {
    const child = field.children.get(id);
    const placeId = overlookPlaceAt(graph, points.get(id));
    if (placeId !== child.placeId) {
      child.placeId = placeId;
      if (placeId !== null) events.push({ type: 'entered_place', id, place_id: placeId });
    }
  }
  const candidates = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = field.children.get(ids[i]);
      const b = field.children.get(ids[j]);
      const pa = points.get(a.id);
      const pb = points.get(b.id);
      const distance = distanceBetween(pa, pb);
      const key = pairKey(a.id, b.id);
      if (field.disarmed.has(key)) {
        if (distance > OVERLOOK_REARM_DISTANCE_PX) field.disarmed.delete(key);
        continue;
      }
      if (a.hold !== null || b.hold !== null) continue;
      if (distance <= OVERLOOK_ENCOUNTER_DISTANCE_PX) {
        candidates.push({ a: a.id, b: b.id, key, distance, midpoint: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } });
      }
    }
  }
  candidates.sort((x, y) => x.distance - y.distance || (x.key < y.key ? -1 : 1));
  const taken = new Set();
  for (const candidate of candidates) {
    if (taken.has(candidate.a) || taken.has(candidate.b)) continue;
    taken.add(candidate.a);
    taken.add(candidate.b);
    field.disarmed.add(candidate.key);
    const [initiator, partner] = initiatorOf(field, candidate.a, candidate.b);
    const lineage = encounterLineage(field, candidate.a, candidate.b);
    field.children.get(candidate.a).hold = 'encounter';
    field.children.get(candidate.b).hold = 'encounter';
    events.push({
      type: 'encounter',
      initiator,
      partner,
      place_id: nearestPlace(graph, candidate.midpoint),
      friction: friction(stateOf, initiator, partner),
      generation: lineage.generation,
      from_writing: lineage.from_writing
    });
  }
  return events;
}

// Arrival bookkeeping the runtime applies to the wish: 籠もる / 確かめる at a place lapse one academy hour after
// arriving, not after deciding. Returns the updated wish (or the same wish when arrival does not move it).
export function overlookWishOnArrival(wish, tick) {
  if (wish.target.kind !== 'place' || (wish.action !== '籠もる' && wish.action !== '確かめる')) return wish;
  return { ...wish, expires_at_minute: overlookMinuteAtTick(tick) + OVERLOOK_WISH_DURATION_MINUTES };
}

// ---------- forecast and focus ----------

// Samples a child's position every APPROACH_SAMPLE_TICKS along its planned route for `horizonTicks`, as if it
// kept walking without pauses and stopped at the route's end. A held child stands still.
function forecastChild(field, child, horizonTicks) {
  const { graph } = field;
  const samples = [];
  let from = child.from;
  let to = child.to;
  let offset = child.offset;
  const route = [...child.route];
  const moving = child.hold === null && child.wish !== null;
  const stepPx = moving ? (OVERLOOK_WALK[child.wish.action].speed * OVERLOOK_TICK_MS * APPROACH_SAMPLE_TICKS) / 1000 : 0;
  for (let elapsed = APPROACH_SAMPLE_TICKS; elapsed <= horizonTicks; elapsed += APPROACH_SAMPLE_TICKS) {
    let budget = stepPx;
    while (budget > 0 && to !== null) {
      const remaining = nodeDistance(graph, from, to) - offset;
      if (budget < remaining) {
        offset += budget;
        budget = 0;
      } else {
        budget -= remaining;
        from = to;
        offset = 0;
        to = route.shift() ?? null;
      }
    }
    samples.push(childPosition(graph, { from, to, offset }));
  }
  return samples;
}

// 接近中の出会い: pairs of children not in an encounter that, walking on as planned, come within encounter
// distance inside OVERLOOK_APPROACH_HORIZON_MINUTES. A pair already within the distance is not "approaching"
// (it is either meeting or has just met).
export function listOverlookApproachingPairs(field, { stateOf } = {}) {
  if (typeof stateOf !== 'function') throw fieldError('forecast requires stateOf');
  const horizon = OVERLOOK_APPROACH_HORIZON_MINUTES * OVERLOOK_TICKS_PER_ACADEMY_MINUTE;
  const ids = [...field.children.keys()].sort().filter((id) => field.children.get(id).hold !== 'encounter' && !field.children.get(id).gate);
  const forecasts = new Map(ids.map((id) => [id, forecastChild(field, field.children.get(id), horizon)]));
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      if (field.disarmed.has(pairKey(a, b))) continue;
      const pa = overlookChildPoint(field, a);
      const pb = overlookChildPoint(field, b);
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) <= OVERLOOK_ENCOUNTER_DISTANCE_PX) continue;
      const fa = forecasts.get(a);
      const fb = forecasts.get(b);
      const meets = fa.some((point, index) => Math.hypot(point.x - fb[index].x, point.y - fb[index].y) <= OVERLOOK_ENCOUNTER_DISTANCE_PX);
      if (!meets) continue;
      const lineage = encounterLineage(field, a, b);
      pairs.push({ kind: 'approaching', participants: [a, b], friction: friction(stateOf, a, b), ...lineage });
    }
  }
  return pairs;
}

// いちばん大きな山: ぶつかる組み合わせ first, then the larger chain generation, then one a written line started,
// and the field seed decides what is still tied. `candidates` are { friction, generation, from_writing, ... }.
export function rankOverlookFocusCandidates(field, candidates) {
  const keyed = candidates.map((candidate) => ({ candidate, draw: field.rng.next() }));
  keyed.sort((x, y) => (
    Number(y.candidate.friction) - Number(x.candidate.friction)
    || y.candidate.generation - x.candidate.generation
    || Number(y.candidate.from_writing) - Number(x.candidate.from_writing)
    || x.draw - y.draw
  ));
  return keyed.map((entry) => entry.candidate);
}

// ---------- views ----------

export function overlookChildFieldView(field, id) {
  const child = requireChild(field, id);
  const point = childPosition(field.graph, child);
  if (child.gate) {
    if (child.gate.phase === 'outside') throw fieldError(`${id} has not appeared on the map yet`);
    // A gate walker walks at 110 without stopping. Its route is whole (not cut at ROUTE_VIEW_NODES): the nodes to
    // the gate point, then its lane of the road outside the gate.
    const onNetwork = child.gate.road === null
      ? [child.to, ...child.route].filter((nodeId) => nodeId !== null).map((nodeId) => ({ x: field.graph.nodes.get(nodeId).x, y: field.graph.nodes.get(nodeId).y }))
      : [];
    const road = child.gate.road ?? { points: gateRoadPoints(field.graph, 'leaving'), traveled: 0 };
    return {
      x: point.x,
      y: point.y,
      pattern: null,
      speed_px_per_s: OVERLOOK_GATE_WALK_SPEED,
      paused: false,
      route: [...onNetwork, ...polylineAhead(road.points, road.traveled)],
      place_id: null
    };
  }
  const upcoming = child.to === null ? [] : [child.to, ...child.route].slice(0, ROUTE_VIEW_NODES);
  const walk = child.wish ? OVERLOOK_WALK[child.wish.action] : null;
  return {
    x: point.x,
    y: point.y,
    pattern: walk ? walk.pattern : null,
    speed_px_per_s: walk && child.hold === null ? walk.speed : 0,
    paused: child.pauseTicks > 0,
    route: upcoming.map((nodeId) => {
      const node = field.graph.nodes.get(nodeId);
      return { x: node.x, y: node.y };
    }),
    place_id: child.placeId
  };
}
