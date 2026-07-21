// Resolving a buddy / companion id into its display + combat data, across both rosters (selectable
// characters and active homunculi). The vocabulary (who can be a buddy) lives in companionRoster.mjs;
// this module turns a resolved id into the concrete summary the consumers need — the routing hub buddy
// name, the equipment buddy sub-view name/face, the dungeon companion descriptor, and the ungated
// current-buddy display contract for the frontend.
//
// A homunculus buddy/companion MUST be active: display_name + face come from the surface active entry,
// affinity from the actor affinity file, parameters (C-12 normalized) from the actor profile. A homunculus
// id that is not active (farewelled / never minted) is corrupt/dangling relationship state and throws —
// never a silent drop.

import { createStorageApi } from './storage.mjs';
import {
  isSelectableCharacterId,
  publicCanonicalFaceUrl,
  selectableCharacterDisplaySummary
} from './characterCatalog.mjs';
import { normalizeParameters } from './parameters.mjs';
import { loadHomunculiSurface } from './homunculusSurface.mjs';
import { homunculusAffinityPath, normalizeHomunculusAffinityFile } from './homunculusAffinity.mjs';
import { characterAffinityPath, normalizeCharacterAffinityFile } from './affinitySchema.mjs';
import { isHomunculusIdFormat } from './companionRoster.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

function storageFor({ root, storage }) {
  return storage ?? createStorageApi({ root });
}

async function readHomunculusAffinity(api, homunculusId) {
  return normalizeHomunculusAffinityFile(await api.readJsonIfExists(homunculusAffinityPath(homunculusId)), homunculusId).affinity;
}

async function readCharacterAffinity(api, characterId) {
  return normalizeCharacterAffinityFile(await api.readJsonIfExists(characterAffinityPath(characterId)), characterId).affinity;
}

// Resolves one ACTIVE homunculus into its buddy/companion summary: display_name + face from the surface
// active entry, affinity from the actor affinity file, parameters (C-12 normalized) from the actor profile.
// A non-active id throws — a buddy/companion target must be an active homunculus.
export async function resolveActiveHomunculusActor({ root, storage, homunculusId }) {
  const api = storageFor({ root, storage });
  const surface = await loadHomunculiSurface({ storage: api });
  const entry = surface.active.find((candidate) => candidate.homunculus_id === homunculusId);
  if (!entry) throw new Error(`homunculus buddy/companion is not active in the atelier: ${homunculusId}`);
  const profile = await api.readJson(`game_data/homunculi/${homunculusId}/profile.json`);
  return {
    homunculus_id: entry.homunculus_id,
    display_name: entry.display_name,
    face_id: entry.face_id,
    created_week: entry.created_week,
    affinity: await readHomunculusAffinity(api, homunculusId),
    parameters: normalizeParameters(profile.parameters),
    face_url: publicCanonicalFaceUrl(entry.face_id, 'neutral')
  };
}

// The current buddy's display data for the frontend, resolved for whichever roster owns it:
// null when there is no buddy, else { character_id, kind, display_name, face_url, affinity }. This is the
// ungated read contract (it does NOT depend on the atelier unlock gate) the routing hub / academy surfaces
// use to show a homunculus buddy. A present buddy id that resolves to neither roster is corrupt state and
// throws.
export async function resolveCurrentBuddySummary({ root, authoringRoot = root }) {
  if (!root) throw new Error('root is required');
  const api = createStorageApi({ root });
  const state = await api.readJson(RUNTIME_STATE_PATH);
  const buddyId = state.current_buddy_character_id ?? null;
  if (buddyId === null) return null;
  if (isSelectableCharacterId(buddyId)) {
    const summary = await selectableCharacterDisplaySummary({ root, authoringRoot, characterId: buddyId });
    return {
      character_id: summary.character_id,
      kind: 'character',
      display_name: summary.display_name,
      face_url: summary.face_url,
      affinity: await readCharacterAffinity(api, buddyId)
    };
  }
  if (isHomunculusIdFormat(buddyId)) {
    const actor = await resolveActiveHomunculusActor({ storage: api, homunculusId: buddyId });
    return {
      character_id: actor.homunculus_id,
      kind: 'homunculus',
      display_name: actor.display_name,
      face_url: actor.face_url,
      affinity: actor.affinity
    };
  }
  throw new Error(`runtime_state.current_buddy_character_id does not resolve to a selectable character or an active homunculus: ${JSON.stringify(buddyId)}`);
}
