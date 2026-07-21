import { promises as fs } from 'node:fs';
import path from 'node:path';

import { definitionsRoot } from './testPaths.mjs';

// Copies the real 星の揺り籠 catalog into a fixture root's definitions, so a minimal fixture that exercises the
// inventory path (loadFullExtraItemDefinitions now reads the star cradle catalog) has it present.
export async function writeStarCradleCatalogDefinition(root) {
  const source = path.join(definitionsRoot, 'star_cradle_catalog.json');
  const destination = path.join(root, 'game_data/star_cradle_catalog.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

// Copies the real 星の揺り籠 catalog into a SPLIT-layout root's definitions (data/definitions/game_data/…), for a
// root whose storage resolves game_data/* reads against a separate definitions base (the auction consignment /
// caged-creature connection paths load the star cradle catalog through that layout).
export async function writeStarCradleCatalogDefinitionSplit(root) {
  const source = path.join(definitionsRoot, 'star_cradle_catalog.json');
  const destination = path.join(root, 'data/definitions/game_data/star_cradle_catalog.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}
