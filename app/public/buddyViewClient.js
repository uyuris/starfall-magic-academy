// Pure, DOM-independent buddy-view contract checks, shared by app.js and headless unit tests so the fail-fast
// paths — the buddy request path and the GET /api/relationships/buddy response shape — are verifiable without a
// browser (the same headless-testable seam as diaryViewClient.js / libraryCollectionViewClient.js).
//
// The buddy read API (GET /api/relationships/buddy, atelier-gate independent) is the single truth source for the
// three 昼スタイル info drawers' buddy category. It returns { buddy: null | { character_id, kind, display_name,
// face_url, affinity } }: null when no buddy is set; kind is the closed set character | homunculus (a selectable
// roster member or an active 錬成室 child). A present-but-unresolvable buddy id is a 500 on the backend (corrupt
// state, never silently nulled), so the frontend only receives a legitimately-empty null or a fully-populated
// buddy. parseBuddyView refuses a malformed envelope BEFORE any DOM mutation — no default-value fill, no silent
// coercion of a broken shape to the empty state.

export const BUDDY_VIEW_REQUEST_PATH = '/api/relationships/buddy';

// The closed set of buddy kinds the backend emits (a selectable academy character or an active homunculus).
export const BUDDY_VIEW_KINDS = Object.freeze(['character', 'homunculus']);

function buddyString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`buddy view: ${label} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

// Validate the GET /api/relationships/buddy payload and return { buddy: null | { character_id, kind, display_name,
// face_url, affinity } }. A non-object payload or a missing `buddy` key is broken state → throw. buddy null is the
// legitimate "no buddy" empty state. A present buddy must carry a non-empty character_id, a kind in the closed set,
// a non-empty display_name, a non-empty face_url, and a finite affinity — any missing/mistyped field throws (no
// default-value completion), so a corrupt buddy never renders as an empty or half-filled hero card.
export function parseBuddyView(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`buddy view: response must be an object, got ${JSON.stringify(payload)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'buddy')) {
    throw new Error(`buddy view: response requires a buddy key (null when unset), got ${JSON.stringify(payload)}`);
  }
  const buddy = payload.buddy;
  if (buddy === null) return { buddy: null };
  if (typeof buddy !== 'object' || Array.isArray(buddy)) {
    throw new Error(`buddy view: buddy must be an object or null, got ${JSON.stringify(buddy)}`);
  }
  const kind = buddy.kind;
  if (!BUDDY_VIEW_KINDS.includes(kind)) {
    throw new Error(`buddy view: buddy.kind must be one of ${BUDDY_VIEW_KINDS.join('/')} (got ${JSON.stringify(kind)})`);
  }
  if (typeof buddy.affinity !== 'number' || !Number.isFinite(buddy.affinity)) {
    throw new Error(`buddy view: buddy.affinity must be a finite number (got ${JSON.stringify(buddy.affinity)})`);
  }
  return {
    buddy: {
      character_id: buddyString(buddy.character_id, 'buddy.character_id'),
      kind,
      display_name: buddyString(buddy.display_name, 'buddy.display_name'),
      face_url: buddyString(buddy.face_url, 'buddy.face_url'),
      affinity: buddy.affinity
    }
  };
}
