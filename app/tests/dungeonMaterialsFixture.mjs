import { promises as fs } from 'node:fs';
import path from 'node:path';

import { definitionsRoot } from './testPaths.mjs';

// The real authored dungeon material catalog, so tests that assert display
// enrichment (name / description / icon / sell_price) see real values.
export async function realDungeonMaterials() {
  return JSON.parse(await fs.readFile(path.join(definitionsRoot, 'dungeon_materials.json'), 'utf8'));
}

// Seeds the dungeon material catalog into a split-layout test root's definitions so
// loadInventory / sellShopItem / consumeInventoryItems and the dungeon finalize
// merge resolve it.
export async function writeDungeonMaterialsDefinition(root) {
  const catalog = await realDungeonMaterials();
  const destination = path.join(root, 'data/definitions/game_data/dungeon_materials.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}
