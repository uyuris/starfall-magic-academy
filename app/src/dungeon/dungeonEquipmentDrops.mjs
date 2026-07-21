// Boss treasure: the milestone-floor (5F/10F) boss reward equipment, and the run-scoped
// buffer that holds opened chests until finalize.
//
// A milestone boss defeat drops a `treasure_chest` floor item (dungeonEngine places it);
// opening the chest with `use_item` rolls a finished weapon/amulet instance and adds it to
// the run's equipment buffer. The roll is derived from (run seed, floor) through the same
// Park–Miller path as generation/combat/material-drops (its own seed namespace), so a chest
// opened on a given floor reproduces the same instance per (seed, floor) and never draws from
// the shared combat RNG. Naming is authored and fully deterministic — no LLM — so every path
// works with LM Studio absent (the dungeon's mandatory base mode).
//
// The instance shape (kind/weapon_type/element/tier/quality/name/flavor/base_effects/
// bonus_effects) and its validator are the C-08 equipment truth (`equipment.mjs`); the roll
// bands and base/bonus vocabulary mirror the auction's weapon/amulet derivation
// (previewAuctionEquipmentRoll) without importing it, so the two stay independently owned.
//
// The buffer is a plain array of instances kept on the run, separate from player_equipment:
// nothing here writes owned equipment. An absent buffer (a run saved before this feature)
// reads as empty — absence is zero, not a masked error — while a present-but-non-array buffer
// is corrupt state and throws.

import { createRng, deriveSeed } from './dungeonRng.mjs';
import { dungeonFloorNumber } from './dungeonScaling.mjs';
import { magicParameterDefinitions } from '../parameters.mjs';
import { EQUIPMENT_QUALITIES, WEAPON_TYPES, validateEquipmentInstance } from '../equipment.mjs';

const ELEMENT_KEYS = magicParameterDefinitions.map((definition) => definition.key);

// A distinct seed namespace so a treasure roll never collides with the generation stream
// (deriveSeed(seed, floor)), the combat stream (deriveSeed(seed, 100000 + turn)), or the
// material-drop stream (deriveSeed(seed, 700000 + floor)).
const TREASURE_SEED_NAMESPACE = 800000;

// Milestone floor → equipment band. 5F = 中位帯 (T3 / excellent, 2 rolled lines), 10F = 上位帯
// (T4 / masterwork, 3 stronger lines). Tune the boss-reward economy from this one table; a floor
// absent here has no boss treasure band and fails fast (this table IS the milestone-only gate).
export const MILESTONE_TREASURE_BANDS = Object.freeze({
  5: Object.freeze({ tier: 3, quality: 'excellent', bonus_lines: 2, bonus_band: Object.freeze([2, 3]) }),
  10: Object.freeze({ tier: 4, quality: 'masterwork', bonus_lines: 3, bonus_band: Object.freeze([4, 6]) })
});

// The weapon/amulet kinds a chest can roll (one amulet option among the three weapon types),
// and the per-kind bonus-effect pools — the same closed vocabulary the auction equipment uses.
const TREASURE_WEAPON_KINDS = Object.freeze(['sword', 'staff', 'short_rod', 'amulet']);
const TREASURE_WEAPON_BONUS_POOL = Object.freeze(['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus', 'element_spell_power']);
const TREASURE_AMULET_BONUS_POOL = Object.freeze(['attack', 'defense', 'max_hp', 'max_mp', 'spell_mp_discount', 'self_heal_bonus']);

// ----- authored deterministic naming (no LLM) -----

const ELEMENT_EPITHETS = Object.freeze({
  light: Object.freeze(['暁光', '聖光']),
  dark: Object.freeze(['宵闇', '深淵']),
  fire: Object.freeze(['烈火', '焦炎']),
  water: Object.freeze(['清冽', '蒼氷']),
  earth: Object.freeze(['堅岩', '巌']),
  wind: Object.freeze(['疾風', '烈風'])
});

const KIND_TITLES = Object.freeze({
  sword: '剣',
  staff: '杖',
  short_rod: '呪具',
  amulet: '護符'
});

const QUALITY_PREFIX = Object.freeze({
  excellent: '優なる',
  masterwork: '傑作の'
});

const QUALITY_FLAVOR = Object.freeze({
  excellent: '優れた業物の風格を帯びている',
  masterwork: '名工の傑作と呼ぶにふさわしい仕上がりだ'
});

const FLAVOR_TAILS = Object.freeze(['深き階に眠っていた。', '守護者の亡骸のそばに遺されていた。', '宝箱の底で静かに輝いていた。']);

const ELEMENT_LABELS = Object.freeze(Object.fromEntries(magicParameterDefinitions.map((definition) => [definition.key, definition.label.replace('魔法習熟度', '')])));

function assertElement(element) {
  if (!ELEMENT_KEYS.includes(element)) throw new Error(`boss treasure element must be a magic element: ${element}`);
  return element;
}

// A weapon/amulet title key: a weapon uses its weapon_type title, an amulet its own.
function titleKey(kind, weaponType) {
  return kind === 'weapon' ? weaponType : 'amulet';
}

// Builds an authored, deterministic 銘 and 来歴 from (element, kind, quality) plus the run rng
// (the picks are part of the (seed, floor) stream, so a given chest always names the same).
function treasureNaming({ element, kind, weaponType, quality, rng }) {
  const epithet = rng.pick(ELEMENT_EPITHETS[assertElement(element)]);
  const title = KIND_TITLES[titleKey(kind, weaponType)];
  if (!title) throw new Error(`boss treasure has no title for kind=${kind} weapon_type=${weaponType}`);
  const prefix = QUALITY_PREFIX[quality];
  const flavorLead = QUALITY_FLAVOR[quality];
  if (!prefix || !flavorLead) throw new Error(`boss treasure has no naming vocabulary for quality: ${quality}`);
  const tail = rng.pick(FLAVOR_TAILS);
  return {
    name: `${prefix}${epithet}の${title}`,
    flavor: `${ELEMENT_LABELS[element]}の力を宿し、${flavorLead}。${tail}`
  };
}

// ----- deterministic effect rolls (mirror the auction weapon/amulet derivation) -----

function treasureBaseEffects(kind, weaponType, tier) {
  if (kind === 'amulet') return { defense: 2 + tier, max_hp: 4 + 3 * tier };
  if (weaponType === 'sword') return { attack: 3 + 2 * tier, max_hp: 2 + 2 * tier };
  if (weaponType === 'staff') return { max_mp: 2 + 2 * tier, element_spell_power: 2 + 2 * tier };
  if (weaponType === 'short_rod') return { spell_mp_discount: tier, max_mp: 1 + 2 * tier };
  throw new Error(`unknown boss treasure weapon_type for base effects: ${weaponType}`);
}

function treasureBonusEffects({ kind, band, rng }) {
  const pool = kind === 'weapon' ? TREASURE_WEAPON_BONUS_POOL : TREASURE_AMULET_BONUS_POOL;
  const [low, high] = band.bonus_band;
  const bonus = {};
  for (const key of rng.shuffle(pool).slice(0, band.bonus_lines)) {
    bonus[key] = rng.int(low, high);
  }
  return bonus;
}

// The band for a milestone floor. A non-milestone floor has no band and fails fast — this lookup
// is the single milestone-only gate for boss treasure.
export function bandForMilestoneFloor(floor) {
  const value = dungeonFloorNumber(floor);
  const band = MILESTONE_TREASURE_BANDS[value];
  if (!band) {
    throw new Error(`no boss treasure band for floor ${floor} (milestone floors: ${Object.keys(MILESTONE_TREASURE_BANDS).join(', ')})`);
  }
  return band;
}

// Rolls the finished weapon/amulet instance a milestone chest yields, fully determined by
// (seed, floor). Returns a validated C-08 equipment instance. A non-milestone floor throws
// (bandForMilestoneFloor), so this is never called off a milestone chest.
export function rollBossTreasureEquipment({ seed, floor }) {
  const floorNumber = dungeonFloorNumber(floor);
  const band = bandForMilestoneFloor(floorNumber);
  if (!band.tier || !EQUIPMENT_QUALITIES.includes(band.quality)) {
    throw new Error(`boss treasure band must carry a tier and a known quality: floor ${floorNumber}`);
  }
  const seedKey = Math.floor(Number(seed));
  if (!Number.isFinite(seedKey)) throw new Error(`boss treasure roll requires a numeric run seed: ${seed}`);
  const rng = createRng(deriveSeed(deriveSeed(seedKey, TREASURE_SEED_NAMESPACE + floorNumber), 1));
  const weaponKind = rng.pick(TREASURE_WEAPON_KINDS);
  const kind = weaponKind === 'amulet' ? 'amulet' : 'weapon';
  const weaponType = kind === 'weapon' ? weaponKind : null;
  if (kind === 'weapon' && !WEAPON_TYPES.includes(weaponType)) throw new Error(`boss treasure weapon_type is not a weapon type: ${weaponType}`);
  const element = rng.pick(ELEMENT_KEYS);
  const base_effects = treasureBaseEffects(kind, weaponType, band.tier);
  const bonus_effects = treasureBonusEffects({ kind, band, rng });
  const { name, flavor } = treasureNaming({ element, kind, weaponType, quality: band.quality, rng });
  return validateEquipmentInstance({
    instance_id: `dungeon_boss_equip_s${seedKey}_f${floorNumber}`,
    kind,
    ...(kind === 'weapon' ? { weapon_type: weaponType } : {}),
    element,
    tier: band.tier,
    quality: band.quality,
    name,
    flavor,
    base_effects,
    bonus_effects
  });
}

// ----- run equipment buffer (opened-chest equipment, kept until finalize) -----

export function emptyEquipmentBuffer() {
  return [];
}

// Reads the run's equipment buffer as a validated instance array. Absent (older save / fresh
// run) reads as empty; a present non-array, or any invalid instance, is corrupt state and throws.
export function readEquipmentBuffer(run) {
  if (!run || typeof run !== 'object') throw new Error('dungeon run is required to read equipment buffer');
  const buffer = run.equipment_buffer;
  if (buffer === undefined || buffer === null) return [];
  if (!Array.isArray(buffer)) throw new Error('dungeon equipment buffer must be an array of equipment instances');
  return buffer.map((instance) => validateEquipmentInstance(instance));
}

// Appends a validated instance. A duplicate instance_id in the buffer is corrupt state and throws
// before any change (one-of-a-kind discipline, matching player_equipment).
export function addEquipmentToBuffer(buffer, instance) {
  if (!Array.isArray(buffer)) throw new Error('equipment buffer must be an array');
  validateEquipmentInstance(instance);
  if (buffer.some((entry) => entry.instance_id === instance.instance_id)) {
    throw new Error(`equipment buffer already holds instance_id: ${instance.instance_id}`);
  }
  return [...buffer, instance];
}

// The buffer as a stable display list (instance_id-sorted copies) for the view and run-end result.
export function equipmentBufferItems(buffer) {
  return [...buffer]
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id))
    .map((instance) => ({ ...instance }));
}
