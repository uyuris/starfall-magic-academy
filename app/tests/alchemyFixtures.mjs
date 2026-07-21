import { readFileSync } from 'node:fs';
import path from 'node:path';

import { definitionsRoot } from './testPaths.mjs';

// The canonical 56-entry alchemy catalog (the standing recipe book). Tests that only need a valid,
// loadable alchemy definitions object write this into their fixture root. Loading it also requires the
// dungeon material catalog (dungeon_materials.json) in the same root, since recipe costs reference it.
const canonicalAlchemyDefinitions = JSON.parse(
  readFileSync(path.join(definitionsRoot, 'alchemy_recipes.json'), 'utf8')
);

export function minimalValidAlchemyDefinitions() {
  return structuredClone(canonicalAlchemyDefinitions);
}
