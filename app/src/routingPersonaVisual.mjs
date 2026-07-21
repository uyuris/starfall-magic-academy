import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createStorageApi } from './storage.mjs';
import { faceExpressions } from './faceExpressions.mjs';
import {
  publicCanonicalFaceUrl,
  publicCanonicalSceneStandeeUrl,
  sceneStandeeFilenameFromManifest
} from './characterCatalog.mjs';
import { ROUTING_PERSONA_CHARACTER_ID, routingPersonaDisplayName } from './routingPersona.mjs';
import { validateRoutingPersonaVariant } from './playMode.mjs';

// Each routing persona variant has its own canonical visual set, deliberately NOT in the selectable
// `visual_set_NNN` catalog — the routing persona reuses the load-bearing `lina` dialogue slot but is a
// non-selectable actor, so its visual key is routing-scoped.
//
// The variant → visual set mapping is a mechanical closed map with no special cases: variant `<v>` uses
// the set `routing_lumi_<v>`. An unknown variant fails validateRoutingPersonaVariant (the same use-time
// fail-fast as buildRoutingPersona); there is no silent fallback to a default set.
export function routingPersonaVisualSetId(personaVariant) {
  return `routing_lumi_${validateRoutingPersonaVariant(personaVariant)}`;
}

// Build the routing persona's non-selectable actor visual summary from the effective variant's canonical
// visual set (routing_lumi_<variant>). The neutral face and the manifest-resolved standee must exist; a
// missing manifest, standee, or face asset is a real data-integrity error (fail-fast) — there is no
// fallback to another variant, `lina`, `character_001`, a PNG, or a placeholder.
export async function buildRoutingPersonaVisualSummary({ root, personaVariant }) {
  const visualSetId = routingPersonaVisualSetId(personaVariant);
  const storage = createStorageApi({ root });
  const faceAssetPath = path.join(
    storage.paths.canonicalAssetsRoot,
    'character_visual_sets',
    visualSetId,
    'face_emotions',
    'neutral.jpg'
  );
  const faceExists = await fs.access(faceAssetPath).then(() => true).catch(() => false);
  if (!faceExists) {
    throw new Error(`missing routing persona neutral face asset: ${visualSetId}`);
  }
  const standeeFilename = await sceneStandeeFilenameFromManifest({ root, visualSetId });
  const faceUrl = publicCanonicalFaceUrl(visualSetId, 'neutral');
  return {
    character_id: ROUTING_PERSONA_CHARACTER_ID,
    display_name: routingPersonaDisplayName(personaVariant),
    visual_set_id: visualSetId,
    face_url: faceUrl,
    selection_icon_url: faceUrl,
    standee_url: publicCanonicalSceneStandeeUrl(visualSetId, standeeFilename),
    available_expressions: faceExpressions
  };
}
