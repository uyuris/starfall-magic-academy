// 星見の窓 (overlook) persistent surface: the 12 children the field shows (顔ぶれ) and each child's four-part
// state — feelings toward others, concerns, mood and the current wish (したいこと).
//
// The surface lives in `game_data/overlook/` of the slot: `roster.json` (`{ version, members }`) and
// `children.json` (`{ version, children }`). A routing new game writes both empty; an absent file reads as the
// same empty surface (the honest initial state, as with the other routing player surfaces). Slot save/load and
// clone copy the slot directory whole, so nothing else carries it. A present-but-malformed file is corrupt state
// and throws on load.
//
// This surface is closed inside the destination: nothing here reads or writes the hero-facing memory, affinity,
// buddy or enemy records. The closed vocabularies (feeling labels, moods, wish actions, concern sources) are the
// Japanese words themselves — the same words the LM is constrained to and the screen shows.

import { createRng, deriveSeed } from './dungeon/dungeonRng.mjs';

export const OVERLOOK_ROSTER_PATH = 'game_data/overlook/roster.json';
export const OVERLOOK_CHILDREN_PATH = 'game_data/overlook/children.json';
export const OVERLOOK_SURFACE_VERSION = 1;

export const OVERLOOK_ROSTER_SIZE = 12;
export const OVERLOOK_CONCERNS_MAX = 3;
export const OVERLOOK_FEELING_LABELS = Object.freeze(['好意', '関心', '気まずい', '負い目', '反発']);
// The three labels that make an encounter a ぶつかる組み合わせ (brief §5).
export const OVERLOOK_FRICTION_FEELING_LABELS = Object.freeze(['気まずい', '負い目', '反発']);
export const OVERLOOK_MOODS = Object.freeze(['落ち着き', '高揚', '沈み', '苛立ち', '不安']);
export const OVERLOOK_WISH_ACTIONS = Object.freeze(['探す', '会う', '避ける', '籠もる', '確かめる']);
// Which target kinds each action accepts: 探す・会う・避ける aim at a child, 籠もる at a place, 確かめる at either.
export const OVERLOOK_WISH_TARGET_KINDS = Object.freeze({
  探す: Object.freeze(['child']),
  会う: Object.freeze(['child']),
  避ける: Object.freeze(['child']),
  籠もる: Object.freeze(['place']),
  確かめる: Object.freeze(['place', 'child'])
});
// Where a concern or a wish came from: a closed conversation (focused or off-screen), a written line, or a
// spontaneous 湧き (entry and a wish that ended without a conversation). 湧き carries no id.
export const OVERLOOK_SOURCE_KINDS = Object.freeze(['conversation', 'writing', 'spring']);
// The mood every child starts from the first time it joins the field.
export const OVERLOOK_INITIAL_MOOD = '落ち着き';

const CHARACTER_ID_PATTERN = /^character_\d{3}$/;
const ROSTER_SEED_BASE = 0x4f564c4b; // 'OVLK'

function surfaceError(message) {
  return new Error(`overlook surface ${message}`);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw surfaceError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw surfaceError(`${label} keys must be exactly {${wanted.join(', ')}}: got {${actual.join(', ')}}`);
  }
}

function nonEmptyLine(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\r\n]/.test(value)) {
    throw surfaceError(`${label} must be a trimmed non-empty single line`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw surfaceError(`${label} must be a positive integer`);
  return value;
}

function characterId(value, label) {
  if (typeof value !== 'string' || !CHARACTER_ID_PATTERN.test(value)) throw surfaceError(`${label} must be a selectable character id`);
  return value;
}

function closedWord(value, vocabulary, label) {
  if (!vocabulary.includes(value)) throw surfaceError(`${label} must be one of ${vocabulary.join('・')}: ${JSON.stringify(value)}`);
  return value;
}

export function validateOverlookSource(source, label) {
  assertExactKeys(source, ['kind', 'id'], label);
  closedWord(source.kind, OVERLOOK_SOURCE_KINDS, `${label}.kind`);
  if (source.kind === 'spring') {
    if (source.id !== null) throw surfaceError(`${label}.id must be null for a 湧き source`);
  } else {
    nonEmptyLine(source.id, `${label}.id`);
  }
  return source;
}

// A wish: the action, its target (a child id or a place id), the one-line 一言, the chain generation (代), the
// source, and the academy minute (minutes since 0:00) at which it lapses.
export function validateOverlookWish(wish, { members, placeIds = null } = {}, label = 'wish') {
  assertExactKeys(wish, ['action', 'target', 'line', 'generation', 'source', 'expires_at_minute'], label);
  closedWord(wish.action, OVERLOOK_WISH_ACTIONS, `${label}.action`);
  assertExactKeys(wish.target, ['kind', 'id'], `${label}.target`);
  closedWord(wish.target.kind, OVERLOOK_WISH_TARGET_KINDS[wish.action], `${label}.target.kind`);
  if (wish.target.kind === 'child') {
    characterId(wish.target.id, `${label}.target.id`);
    if (members && !members.includes(wish.target.id)) throw surfaceError(`${label}.target.id is not on the roster: ${wish.target.id}`);
  } else {
    nonEmptyLine(wish.target.id, `${label}.target.id`);
    if (placeIds && !placeIds.includes(wish.target.id)) throw surfaceError(`${label}.target.id is not a field place: ${wish.target.id}`);
  }
  nonEmptyLine(wish.line, `${label}.line`);
  positiveInteger(wish.generation, `${label}.generation`);
  validateOverlookSource(wish.source, `${label}.source`);
  if (!Number.isInteger(wish.expires_at_minute) || wish.expires_at_minute < 0) throw surfaceError(`${label}.expires_at_minute must be a non-negative integer`);
  return wish;
}

export function validateOverlookChildState(state, { selfId, members, placeIds = null }, label = 'child') {
  assertExactKeys(state, ['feelings', 'concerns', 'mood', 'wish'], label);
  if (!state.feelings || typeof state.feelings !== 'object' || Array.isArray(state.feelings)) throw surfaceError(`${label}.feelings must be an object`);
  for (const [otherId, feeling] of Object.entries(state.feelings)) {
    characterId(otherId, `${label}.feelings key`);
    if (otherId === selfId) throw surfaceError(`${label}.feelings must not hold a feeling toward itself`);
    assertExactKeys(feeling, ['label', 'text'], `${label}.feelings.${otherId}`);
    closedWord(feeling.label, OVERLOOK_FEELING_LABELS, `${label}.feelings.${otherId}.label`);
    nonEmptyLine(feeling.text, `${label}.feelings.${otherId}.text`);
  }
  if (!Array.isArray(state.concerns) || state.concerns.length > OVERLOOK_CONCERNS_MAX) {
    throw surfaceError(`${label}.concerns must be an array of at most ${OVERLOOK_CONCERNS_MAX}`);
  }
  state.concerns.forEach((concern, index) => {
    assertExactKeys(concern, ['text', 'source', 'generation'], `${label}.concerns[${index}]`);
    nonEmptyLine(concern.text, `${label}.concerns[${index}].text`);
    validateOverlookSource(concern.source, `${label}.concerns[${index}].source`);
    positiveInteger(concern.generation, `${label}.concerns[${index}].generation`);
  });
  closedWord(state.mood, OVERLOOK_MOODS, `${label}.mood`);
  if (state.wish !== null) {
    validateOverlookWish(state.wish, { members, placeIds }, `${label}.wish`);
    if (state.wish.target.kind === 'child' && state.wish.target.id === selfId) throw surfaceError(`${label}.wish must not target itself`);
  }
  return state;
}

// The whole surface: either empty (no roster drawn yet — members [] and children {}) or a full roster of
// OVERLOOK_ROSTER_SIZE distinct selectable ids with exactly one state per member.
export function validateOverlookSurface(surface, { placeIds = null } = {}) {
  assertExactKeys(surface, ['roster', 'children'], 'surface');
  const { roster, children } = surface;
  assertExactKeys(roster, ['version', 'members'], 'roster');
  if (roster.version !== OVERLOOK_SURFACE_VERSION) throw surfaceError(`roster.version must be ${OVERLOOK_SURFACE_VERSION}`);
  if (!Array.isArray(roster.members)) throw surfaceError('roster.members must be an array');
  if (roster.members.length !== 0 && roster.members.length !== OVERLOOK_ROSTER_SIZE) {
    throw surfaceError(`roster.members must be empty or hold exactly ${OVERLOOK_ROSTER_SIZE} ids`);
  }
  roster.members.forEach((id, index) => characterId(id, `roster.members[${index}]`));
  if (new Set(roster.members).size !== roster.members.length) throw surfaceError('roster.members must be distinct');
  assertExactKeys(children, ['version', 'children'], 'children');
  if (children.version !== OVERLOOK_SURFACE_VERSION) throw surfaceError(`children.version must be ${OVERLOOK_SURFACE_VERSION}`);
  assertExactKeys(children.children, roster.members, 'children.children');
  for (const id of roster.members) {
    validateOverlookChildState(children.children[id], { selfId: id, members: roster.members, placeIds }, `children.${id}`);
  }
  return surface;
}

export function emptyOverlookRoster() {
  return { version: OVERLOOK_SURFACE_VERSION, members: [] };
}

export function emptyOverlookChildren() {
  return { version: OVERLOOK_SURFACE_VERSION, children: {} };
}

export function initialOverlookChildState() {
  return { feelings: {}, concerns: [], mood: OVERLOOK_INITIAL_MOOD, wish: null };
}

export async function loadOverlookSurface({ storage, placeIds = null } = {}) {
  if (!storage) throw new Error('overlook surface load requires storage');
  const roster = await storage.readJsonIfExists(OVERLOOK_ROSTER_PATH);
  const children = await storage.readJsonIfExists(OVERLOOK_CHILDREN_PATH);
  if ((roster === null) !== (children === null)) {
    throw surfaceError(`${OVERLOOK_ROSTER_PATH} and ${OVERLOOK_CHILDREN_PATH} must both exist or both be absent`);
  }
  const surface = roster === null
    ? { roster: emptyOverlookRoster(), children: emptyOverlookChildren() }
    : { roster, children };
  return validateOverlookSurface(surface, { placeIds });
}

export async function writeOverlookSurface({ storage, surface, placeIds = null } = {}) {
  if (!storage) throw new Error('overlook surface write requires storage');
  validateOverlookSurface(surface, { placeIds });
  await storage.writeJson(OVERLOOK_ROSTER_PATH, surface.roster);
  await storage.writeJson(OVERLOOK_CHILDREN_PATH, surface.children);
}

// Draws the 12 children from the selectable roster with the field seed. Only the first entry draws; later entries
// keep the drawn roster (there is no automatic per-entry rotation — the 顔ぶれ操作 is the one place a member
// changes: replaceOverlookRosterMember).
export function drawOverlookRoster({ selectableIds, seed } = {}) {
  if (!Array.isArray(selectableIds)) throw new Error('overlook roster draw requires selectableIds');
  selectableIds.forEach((id, index) => characterId(id, `selectableIds[${index}]`));
  if (new Set(selectableIds).size !== selectableIds.length) throw new Error('overlook roster draw requires distinct selectableIds');
  if (selectableIds.length < OVERLOOK_ROSTER_SIZE) {
    throw new Error(`overlook roster draw requires at least ${OVERLOOK_ROSTER_SIZE} selectable characters, got ${selectableIds.length}`);
  }
  if (!Number.isInteger(seed)) throw new Error('overlook roster draw requires an integer seed');
  const rng = createRng(deriveSeed(ROSTER_SEED_BASE, seed));
  return rng.shuffle(selectableIds).slice(0, OVERLOOK_ROSTER_SIZE);
}

// Ensures the surface has a roster: an empty surface draws one (every member starting from the initial state);
// a drawn roster is returned as it is. Pure — the caller persists.
export function ensureOverlookRoster({ surface, selectableIds, seed }) {
  if (surface.roster.members.length === OVERLOOK_ROSTER_SIZE) return { surface, drawn: false };
  const members = drawOverlookRoster({ selectableIds, seed });
  return {
    surface: {
      roster: { version: OVERLOOK_SURFACE_VERSION, members },
      children: {
        version: OVERLOOK_SURFACE_VERSION,
        children: Object.fromEntries(members.map((id) => [id, initialOverlookChildState()]))
      }
    },
    drawn: true
  };
}

// 顔ぶれの記録 on a send-off (brief §2): the newcomer takes the leaver's place in the roster (the order is kept)
// and starts from the initial state; the leaver's state goes, and so does every feeling the others held toward
// it. Wishes are the runtime's to end and re-decide. Pure — the caller persists.
export function replaceOverlookRosterMember({ surface, leavingId, arrivingId }) {
  const index = surface.roster.members.indexOf(leavingId);
  if (index === -1) throw surfaceError(`roster has no member ${leavingId}`);
  if (surface.roster.members.includes(arrivingId)) throw surfaceError(`roster already holds ${arrivingId}`);
  const members = surface.roster.members.map((id) => (id === leavingId ? arrivingId : id));
  const withoutFeelingToward = (state) => ({
    ...state,
    feelings: Object.fromEntries(Object.entries(state.feelings).filter(([otherId]) => otherId !== leavingId))
  });
  return {
    roster: { ...surface.roster, members },
    children: {
      ...surface.children,
      children: Object.fromEntries(members.map((id) => [
        id,
        id === arrivingId ? initialOverlookChildState() : withoutFeelingToward(surface.children.children[id])
      ]))
    }
  };
}

// Adds one concern, dropping the oldest when the list is full. Pure.
export function addOverlookConcern(state, concern) {
  const concerns = [...state.concerns, concern];
  return { ...state, concerns: concerns.slice(Math.max(0, concerns.length - OVERLOOK_CONCERNS_MAX)) };
}
