// Authored 書誌カタログ (大書庫 / library) strict loader and fail-closed gate filter.
//
// The catalog is 31 core books + 500 periphery books = 531 entries authored in
// data/definitions/game_data/library_catalog.json.
//
// - Core knowledge books (12) carry a `knowledge_ref` (magic element × basic/advanced)
//   and no `text`; the body is resolved from the single actor-context source of truth
//   (MAGIC_KNOWLEDGE_TEXTS), never duplicated into the catalog. An unresolvable ref throws.
// - Core lore books (19) carry an authored `text`.
// - Periphery books (500 = 20 categories × 25) carry an authored `skeleton` plus a `backbone`
//   boolean that must match the mechanical rule (星図・天文誌 category, or 星降り/残光/月夜 in the
//   title or skeleton).
//
// Gates use a closed three-form vocabulary: omitted (no gate), { magic, key, min }, or
// { magic_any, min }. The gate filter is fail-closed: a book whose gate is unmet is
// excluded from the readable set, and missing parameters normalize to 0 so gated books
// naturally drop out. Every malformed shape fails fast — no silent fallback, no default.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';
import { magicParameterDefinitions, normalizeParameters } from './parameters.mjs';
import { MAGIC_KNOWLEDGE_TEXTS } from './llm/conversationActorContext.mjs';

export const LIBRARY_CATALOG_FILENAME = 'library_catalog.json';

export const LIBRARY_LAYERS = Object.freeze(['core', 'periphery']);
export const LIBRARY_MAGIC_KEYS = Object.freeze(magicParameterDefinitions.map((definition) => definition.key));
export const LIBRARY_KNOWLEDGE_TIERS = Object.freeze(['basic', 'advanced']);
export const LIBRARY_KNOWLEDGE_CATEGORY = '系統知識';
export const LIBRARY_STARCHART_CATEGORY = '星図・天文誌';
export const LIBRARY_PERIPHERY_CATEGORIES = Object.freeze([
  '動植物誌',
  '随筆・紀行',
  '料理帖・生活誌',
  '卒業生の手記・書簡',
  '古い演習・調合記録',
  '物語・詩歌',
  '歴史余話・人物伝',
  '星図・天文誌',
  '怪談・七不思議',
  '辞書・語源',
  '図録・目録',
  '戯曲・演目・歌集',
  '遊戯・娯楽',
  '医術・保健',
  '建築・営繕',
  '商いと市場',
  '書物の書物',
  '工芸・手仕事',
  '行き先見聞録',
  'しくじり録・珍事集'
]);
// The backbone flag (背骨前置き要否) is set by a mechanical rule, so the authored value is
// re-derived and cross-checked at load: a drifted flag fails fast rather than silently persisting.
export const LIBRARY_BACKBONE_PATTERN = /星降り|残光|月夜/;

export const EXPECTED_CORE_COUNT = 31;
export const EXPECTED_PERIPHERY_COUNT = 500;

const ID_PATTERN = /^[a-z0-9_]+$/;
const MAGIC_KEY_SET = new Set(LIBRARY_MAGIC_KEYS);
const LAYER_SET = new Set(LIBRARY_LAYERS);
const KNOWLEDGE_TIER_SET = new Set(LIBRARY_KNOWLEDGE_TIERS);
const PERIPHERY_CATEGORY_SET = new Set(LIBRARY_PERIPHERY_CATEGORIES);

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

// Keys must be a subset of allowed; every required key must be present. Optional keys
// (only `gate` here) may be absent. Any unexpected key fails fast.
function assertKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing required key: ${key}`);
  }
}

// Validates a present gate against the closed three-form schema and returns a faithful copy.
// An omitted gate is handled by the caller (absence = no gate); a present-but-malformed gate throws.
export function validateLibraryGate(gate, label) {
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error(`${label} gate must be an object`);
  if (gate.kind === 'magic') {
    assertKeys(gate, ['kind', 'key', 'min'], [], `${label} gate`);
    if (!MAGIC_KEY_SET.has(gate.key)) throw new Error(`${label} gate.key must be one of ${LIBRARY_MAGIC_KEYS.join('/')}: ${gate.key}`);
    positiveInteger(gate.min, `${label} gate.min`);
    return { kind: 'magic', key: gate.key, min: gate.min };
  }
  if (gate.kind === 'magic_any') {
    assertKeys(gate, ['kind', 'min'], [], `${label} gate`);
    positiveInteger(gate.min, `${label} gate.min`);
    return { kind: 'magic_any', min: gate.min };
  }
  throw new Error(`${label} gate.kind must be one of: magic, magic_any`);
}

function resolveKnowledgeText(element, tier, label) {
  const body = MAGIC_KNOWLEDGE_TEXTS[element]?.[tier];
  if (typeof body !== 'string' || !body) {
    throw new Error(`${label} knowledge_ref does not resolve to an actor-context knowledge text: ${element}.${tier}`);
  }
  return body;
}

function gateFor(entry, label) {
  if (!Object.prototype.hasOwnProperty.call(entry, 'gate')) return null;
  return validateLibraryGate(entry.gate, label);
}

function validateCoreEntry(entry, base, label) {
  const hasText = Object.prototype.hasOwnProperty.call(entry, 'text');
  const hasRef = Object.prototype.hasOwnProperty.call(entry, 'knowledge_ref');
  if (hasText === hasRef) {
    throw new Error(`${label} core book must have exactly one of text / knowledge_ref`);
  }
  if (hasRef) {
    assertKeys(entry, ['id', 'layer', 'title', 'category', 'knowledge_ref'], ['gate'], label);
    if (base.category !== LIBRARY_KNOWLEDGE_CATEGORY) {
      throw new Error(`${label} knowledge book category must be ${LIBRARY_KNOWLEDGE_CATEGORY}: ${base.category}`);
    }
    const ref = requiredObject(entry.knowledge_ref, `${label}.knowledge_ref`);
    assertKeys(ref, ['element', 'tier'], [], `${label}.knowledge_ref`);
    const element = requiredString(ref.element, `${label}.knowledge_ref.element`);
    if (!MAGIC_KEY_SET.has(element)) throw new Error(`${label}.knowledge_ref.element must be a magic key: ${element}`);
    const tier = requiredString(ref.tier, `${label}.knowledge_ref.tier`);
    if (!KNOWLEDGE_TIER_SET.has(tier)) throw new Error(`${label}.knowledge_ref.tier must be one of ${LIBRARY_KNOWLEDGE_TIERS.join('/')}: ${tier}`);
    return { ...base, knowledge_ref: { element, tier }, text: resolveKnowledgeText(element, tier, label) };
  }
  assertKeys(entry, ['id', 'layer', 'title', 'category', 'text'], ['gate'], label);
  return { ...base, text: requiredString(entry.text, `${label}.text`) };
}

function validatePeripheryEntry(entry, base, label) {
  assertKeys(entry, ['id', 'layer', 'title', 'category', 'skeleton', 'backbone'], [], label);
  if (!PERIPHERY_CATEGORY_SET.has(base.category)) {
    throw new Error(`${label}.category must be a periphery category: ${base.category}`);
  }
  const skeleton = requiredString(entry.skeleton, `${label}.skeleton`);
  if (typeof entry.backbone !== 'boolean') throw new Error(`${label}.backbone must be a boolean`);
  const expected = base.category === LIBRARY_STARCHART_CATEGORY
    || LIBRARY_BACKBONE_PATTERN.test(base.title)
    || LIBRARY_BACKBONE_PATTERN.test(skeleton);
  if (entry.backbone !== expected) {
    throw new Error(`${label}.backbone must follow the mechanical rule (expected ${expected}): ${base.title}`);
  }
  return { ...base, skeleton, backbone: entry.backbone };
}

function validateEntry(raw, index, seenIds) {
  const label = `library catalog books[${index}]`;
  const entry = requiredObject(raw, label);
  const id = requiredString(entry.id, `${label}.id`);
  if (!ID_PATTERN.test(id)) throw new Error(`${label}.id must match /^[a-z0-9_]+$/: ${id}`);
  if (seenIds.has(id)) throw new Error(`duplicate library catalog id: ${id}`);
  seenIds.add(id);
  const layer = requiredString(entry.layer, `${label}.layer`);
  if (!LAYER_SET.has(layer)) throw new Error(`${label}.layer must be one of ${LIBRARY_LAYERS.join('/')}: ${layer}`);
  const base = {
    id,
    layer,
    title: requiredString(entry.title, `${label}.title`),
    category: requiredString(entry.category, `${label}.category`),
    gate: gateFor(entry, label)
  };
  if (layer === 'periphery' && base.gate !== null) {
    // Periphery books carry no gate; a declared gate is caught here (before the periphery key check).
    throw new Error(`${label} periphery book must not carry a gate`);
  }
  return layer === 'core' ? validateCoreEntry(entry, base, label) : validatePeripheryEntry(entry, base, label);
}

// Strictly validates a raw library_catalog.json object and returns the 531 normalized
// entries in authored order. Wrong shape, id off the pattern, duplicate id, layer/category
// outside the closed sets, a core book with neither/both of text & knowledge_ref, an
// unresolvable knowledge_ref, a bad gate, a periphery backbone that violates the rule, or a
// core/periphery count that is not 31/500 all throw.
export function normalizeLibraryCatalog(raw) {
  const value = requiredObject(raw, 'library catalog');
  if (!Array.isArray(value.books)) throw new Error('library catalog books must be an array');
  const seenIds = new Set();
  const books = value.books.map((entry, index) => validateEntry(entry, index, seenIds));
  const coreCount = books.filter((book) => book.layer === 'core').length;
  const peripheryCount = books.filter((book) => book.layer === 'periphery').length;
  if (coreCount !== EXPECTED_CORE_COUNT) {
    throw new Error(`library catalog must contain exactly ${EXPECTED_CORE_COUNT} core books: got ${coreCount}`);
  }
  if (peripheryCount !== EXPECTED_PERIPHERY_COUNT) {
    throw new Error(`library catalog must contain exactly ${EXPECTED_PERIPHERY_COUNT} periphery books: got ${peripheryCount}`);
  }
  return books;
}

export async function loadLibraryCatalog({ root } = {}) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const definitionsPath = path.join(storage.paths.definitionsRoot, LIBRARY_CATALOG_FILENAME);
  let rawText;
  try {
    rawText = await fs.readFile(definitionsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`library catalog file is missing: ${definitionsPath}`);
    throw error;
  }
  return normalizeLibraryCatalog(JSON.parse(rawText));
}

// Builds a book_id -> normalized entry lookup. A reader resolving a collection/content-result
// book_id against the catalog uses it; a missing id is the caller's fail-fast, never masked.
export function libraryCatalogById(books) {
  return new Map(books.map((book) => [book.id, book]));
}

function gatePasses(gate, normalizedMagic) {
  if (gate === null) return true;
  if (gate.kind === 'magic') return normalizedMagic[gate.key].value >= gate.min;
  if (gate.kind === 'magic_any') return LIBRARY_MAGIC_KEYS.some((key) => normalizedMagic[key].value >= gate.min);
  throw new Error(`unknown library gate kind: ${gate.kind}`);
}

// Fail-closed readability: a book with no gate always passes; a gated book passes only when
// the hero's parameters meet it. Absent/partial parameters normalize to 0, so 禁書 naturally
// drop out — the gate is never opened by a missing value.
export function isLibraryBookReadable(book, parameters) {
  const normalized = normalizeParameters(parameters);
  return gatePasses(book.gate ?? null, normalized.magic);
}

// Returns only the books the hero can currently read. Gate-unmet books are excluded (not an
// error); this is the candidate set a downstream selector draws from.
export function filterReadableLibraryBooks(books, parameters) {
  const normalized = normalizeParameters(parameters);
  return books.filter((book) => gatePasses(book.gate ?? null, normalized.magic));
}
