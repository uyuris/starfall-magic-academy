import { promises as fs } from 'node:fs';
import path from 'node:path';

import { definitionsRoot } from './testPaths.mjs';

// The real authored auction catalog (52 items). The economy's loadFullExtraItemDefinitions reads the auction
// treasure/flavor items on every inventory path, so a split-layout test root that seeds dungeon materials must
// seed the auction catalog too (both feed the same known-item / decorate set).
export async function realAuctionCatalog() {
  return JSON.parse(await fs.readFile(path.join(definitionsRoot, 'auction_catalog.json'), 'utf8'));
}

// Seeds the auction catalog into a split-layout test root's definitions so loadInventory / consumeInventoryItems
// and the auction ownership writers resolve it.
export async function writeAuctionCatalogDefinition(root) {
  const catalog = await realAuctionCatalog();
  const destination = path.join(root, 'data/definitions/game_data/auction_catalog.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}
