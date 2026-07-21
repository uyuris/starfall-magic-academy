// 談話室 (lounge) authored scene: the fixed location name「寮の談話室」and an authored pool of visible_situation
// lines (pure scene, no character names / dialogue / handheld props). The pool exists so the lounge scene does not
// monotonize week to week; a week-seed deterministic draw picks one line per conversation, so the same week always
// opens on the same scene. The pool is loaded from the definitions surface (data/definitions/game_data), the same
// place the study-circle / auction catalogs live.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from '../storage.mjs';
import { createRng, deriveSeed } from '../dungeon/dungeonRng.mjs';

export const LOUNGE_SCENE_DEFINITIONS_FILENAME = 'lounge_scenes.json';

// The week-seed base for the lounge scene draw — independent of the participant draw so scene and participants vary
// on separate axes (each derives from its own base).
const LOUNGE_SCENE_SEED_BASE = 0x4c53434e; // 'LSCN'
const MIN_VISIBLE_SITUATIONS = 8;

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export function validateLoungeSceneCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('lounge scene catalog must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'location_name' && key !== 'visible_situations') throw new Error(`lounge scene catalog has an unexpected key: ${key}`);
  }
  const locationName = requiredString(raw.location_name, 'lounge scene catalog location_name');
  if (!Array.isArray(raw.visible_situations)) throw new Error('lounge scene catalog visible_situations must be an array');
  if (raw.visible_situations.length < MIN_VISIBLE_SITUATIONS) {
    throw new Error(`lounge scene catalog visible_situations must contain at least ${MIN_VISIBLE_SITUATIONS} entries, got ${raw.visible_situations.length}`);
  }
  const seen = new Set();
  const visibleSituations = raw.visible_situations.map((entry, index) => {
    const situation = requiredString(entry, `lounge scene catalog visible_situations[${index}]`);
    if (seen.has(situation)) throw new Error(`lounge scene catalog visible_situations has a duplicate entry: ${situation}`);
    seen.add(situation);
    return situation;
  });
  return { location_name: locationName, visible_situations: visibleSituations };
}

export async function loadLoungeSceneCatalog({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const definitionsPath = path.join(storage.paths.definitionsRoot, LOUNGE_SCENE_DEFINITIONS_FILENAME);
  let raw;
  try {
    raw = await fs.readFile(definitionsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`lounge scene definitions file is missing: ${definitionsPath}`);
    throw error;
  }
  return validateLoungeSceneCatalog(JSON.parse(raw));
}

// Draws one visible_situation from the authored pool, week-seed deterministic (salt `lounge-scene:<week>`). The same
// week always yields the same scene line for the fixed「寮の談話室」location.
export function selectLoungeVisibleSituation({ catalog, week }) {
  const normalized = validateLoungeSceneCatalog(catalog);
  const normalizedWeek = nonNegativeInteger(week, 'lounge week');
  const rng = createRng(deriveSeed(LOUNGE_SCENE_SEED_BASE, stableHash(`lounge-scene:${normalizedWeek}`)));
  return rng.pick(normalized.visible_situations);
}

// Resolves the full lounge scene for a week: the fixed location name and the week-drawn visible_situation.
export async function resolveLoungeScene({ root, week }) {
  const catalog = await loadLoungeSceneCatalog({ root });
  return {
    location_name: catalog.location_name,
    visible_situation: selectLoungeVisibleSituation({ catalog, week })
  };
}
