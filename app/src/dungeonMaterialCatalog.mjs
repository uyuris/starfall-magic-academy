// Authored dungeon material catalog: the 6 elements × 4 tiers = 24 drop materials.
//
// The id scheme `material_<element>_t<tier>` binds a catalog entry to a magic
// element and a tier band. The element vocabulary is the canonical magic
// parameter keys, so enemy/boss archetype elements, the drop roll, and this
// catalog all share one source of truth. The strict loader rejects any catalog
// that is not exactly the 24 element×tier entries with the required fields.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { magicParameterDefinitions } from './parameters.mjs';

const DUNGEON_MATERIALS_FILENAME = 'dungeon_materials.json';

export const MATERIAL_ELEMENTS = Object.freeze(magicParameterDefinitions.map((definition) => definition.key));
export const MATERIAL_TIERS = Object.freeze([1, 2, 3, 4]);

const MATERIAL_ELEMENT_SET = new Set(MATERIAL_ELEMENTS);
const MATERIAL_ID_PATTERN = new RegExp(`^material_(${MATERIAL_ELEMENTS.join('|')})_t([1-4])$`);
const EXPECTED_MATERIAL_COUNT = MATERIAL_ELEMENTS.length * MATERIAL_TIERS.length;

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

// Builds the catalog id for an element×tier pair. A caller passing an element
// outside the six magic keys or a tier outside 1-4 is fail-fast wrong input.
export function materialItemId(element, tier) {
  if (typeof element !== 'string' || !MATERIAL_ELEMENT_SET.has(element)) {
    throw new Error(`unknown dungeon material element: ${element}`);
  }
  if (!MATERIAL_TIERS.includes(tier)) throw new Error(`invalid dungeon material tier: ${tier}`);
  return `material_${element}_t${tier}`;
}

// Strictly validates a raw dungeon_materials.json object and returns the 24
// normalized entries sorted by item_id. A wrong count, an id off the scheme, a
// duplicate, a missing element×tier combination, or a missing field throws.
export function normalizeDungeonMaterialCatalog(raw) {
  const value = requiredObject(raw, 'dungeon materials');
  if (!Array.isArray(value.materials)) throw new Error('dungeon materials must be an array');
  if (value.materials.length !== EXPECTED_MATERIAL_COUNT) {
    throw new Error(`dungeon materials must contain exactly ${EXPECTED_MATERIAL_COUNT} entries`);
  }
  const seen = new Set();
  const materials = value.materials.map((material, index) => {
    const entry = requiredObject(material, `dungeon materials[${index}]`);
    const itemId = requiredString(entry.item_id, `dungeon materials[${index}].item_id`);
    // The id scheme binds each entry to its element and tier, so exec-capture is the
    // one authority for both: element/tier are derived from the validated id, never
    // authored as separate drift-prone fields.
    const idMatch = MATERIAL_ID_PATTERN.exec(itemId);
    if (!idMatch) {
      throw new Error(`dungeon material item_id must match material_<element>_t<1-4>: ${itemId}`);
    }
    if (seen.has(itemId)) throw new Error(`duplicate dungeon material item_id: ${itemId}`);
    seen.add(itemId);
    return {
      item_id: itemId,
      name: requiredString(entry.name, `dungeon materials[${index}].name`),
      description: requiredString(entry.description, `dungeon materials[${index}].description`),
      element: idMatch[1],
      tier: Number(idMatch[2]),
      sell_price: nonNegativeInteger(entry.sell_price, `dungeon materials[${index}].sell_price`),
      icon: requiredString(entry.icon, `dungeon materials[${index}].icon`)
    };
  });
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) {
      const id = `material_${element}_t${tier}`;
      if (!seen.has(id)) throw new Error(`dungeon materials missing required entry: ${id}`);
    }
  }
  return materials.sort((a, b) => a.item_id.localeCompare(b.item_id));
}

// Builds an item_id -> display name lookup over normalized catalog entries. The
// run-end result surface uses it to resolve each carried material's authoritative
// display name; a buffer id outside the catalog is resolved by the caller's
// fail-fast, never masked here.
export function dungeonMaterialDisplayNames(materials) {
  return new Map(materials.map((material) => [material.item_id, material.name]));
}

export async function loadDungeonMaterialDefinitions({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const definitionsPath = path.join(storage.paths.definitionsRoot, DUNGEON_MATERIALS_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(definitionsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`dungeon materials file is missing: ${definitionsPath}`);
    throw error;
  }
  return normalizeDungeonMaterialCatalog(JSON.parse(raw));
}
