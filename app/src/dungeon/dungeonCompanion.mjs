// Companion appearance: when the LLM-backed mode is available, an academy
// character appears and joins the run. The companion is fixed to the current
// buddy — when a buddy is set it IS the companion, decided at run entry with no
// roll (うゆりすさん: not a player pick). Only when there is no buddy does an
// academy character appear at random, seeded from the run seed so a run
// reproduces its companion. A buddy that is not among the selectable candidates
// is a hard error, never a silent drop to a random companion.

import { createRng, deriveSeed } from './dungeonRng.mjs';

const COMPANION_SALT = 7777;

export function selectCompanion({ characters, currentBuddyCharacterId = null, seed } = {}) {
  if (!Array.isArray(characters) || characters.length === 0) return null;
  if (currentBuddyCharacterId !== null) {
    const buddy = characters.find((character) => character.character_id === currentBuddyCharacterId);
    if (!buddy) {
      throw new Error(`buddy character ${currentBuddyCharacterId} is not among the selectable companion candidates`);
    }
    return buddy;
  }
  // No buddy: an academy character appears at random, uniform over the roster.
  const rng = createRng(deriveSeed(seed, COMPANION_SALT));
  let roll = rng.next() * characters.length;
  for (const character of characters) {
    roll -= 1;
    if (roll <= 0) return character;
  }
  return characters[characters.length - 1];
}

// Builds the companion descriptor the engine consumes from a companion record (a selectable character or a
// homunculus, both carrying normalized parameters). A homunculus companion cannot be resolved from the
// selectable roster on the frontend, so its face_url is threaded through here; a selectable companion omits
// it (the frontend resolves its face from the roster) so the persisted run.companion stays byte-identical.
export function companionDescriptor(character, conversationId, { faceUrl = null } = {}) {
  return {
    character_id: character.character_id,
    name: character.display_name ?? character.character_id,
    parameters: character.parameters,
    conversation_id: conversationId,
    ...(faceUrl ? { face_url: faceUrl } : {})
  };
}

// The homunculus-only fields a run companion surfaces to the frontend: its entry-snapshot face_url and
// C-12 normalized parameters, present together ONLY for a homunculus companion (the "this companion is a
// homunculus" schema marker). They let the frontend render the companion's detail popup (顔＋名前＋11
// パラメーター) with no extra fetch. A selectable companion carries neither, so every payload that spreads
// this stays byte-identical to before for a selectable companion. Single source for the run view and the
// streamed enter event so the two never drift.
export function homunculusCompanionViewFields(runCompanion) {
  return runCompanion.face_url
    ? { face_url: runCompanion.face_url, parameters: runCompanion.parameters }
    : {};
}

// The companion identity payload for the streamed `dungeon_enter` event: character_id + name +
// conversation_id, plus the homunculus marker fields (face_url + parameters) for a homunculus companion so
// the frontend can render its detail popup from the enter event alone. null when the run has no companion.
export function dungeonEnterCompanionEvent(runCompanion) {
  if (!runCompanion) return null;
  return {
    character_id: runCompanion.character_id,
    name: runCompanion.name,
    conversation_id: runCompanion.conversation_id,
    ...homunculusCompanionViewFields(runCompanion)
  };
}
