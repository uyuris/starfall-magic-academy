// Dungeon-only bestiary. Deliberately separate from the creature catalog
// (C-05) and field encounters (C-08 fieldRuntime): this subsystem defines its
// own enemies, scaling, and reward grants and never reuses those systems.
//
// Each archetype declares `grants`: the parameters a defeat nudges upward.
// Fighting fire imps trains fire/magical_power; fighting golems trains
// strength/earth. This is what makes the dungeon a coherent "practical"
// counterpart to basic training.

import { difficultyFloorFor } from './dungeonScaling.mjs';

const ENEMY_ATTACK_PRESSURE_MULTIPLIER = 1.0;

// Enemy-only HP-pool multiplier. Players and companions seed their combat HP from the shared-core
// combatMaxHp (× COMBAT_HP_MULTIPLIER = 3); enemies do not, because monster archetypes already carry
// high stat HP, and folding the ×3 into them on top of that made dungeon fights a slog. Every dungeon
// enemy (normal, elite base, milestone boss) seeds its pool from this knob instead: 0.6 = 3 × 1/5, so
// the pool is exactly one fifth of the previous ×3 value while attack/defense/speed/count are untouched.
const ENEMY_HP_MULTIPLIER = 0.6;

// The combat HP pool for a dungeon enemy whose depth-scaled max is `baseMaxHp`. The single definition
// every enemy-construction site (normal spawn, milestone boss) seeds its hp/max_hp from; elite promotion
// multiplies the resulting max_hp by a relative factor, so it follows this pool automatically. Rounded,
// floored at 1.
export function enemyCombatMaxHp(baseMaxHp) {
  return Math.max(1, Math.round(baseMaxHp * ENEMY_HP_MULTIPLIER));
}

export const enemyArchetypes = [
  {
    id: 'mire_slime',
    name: '澱みスライム',
    element: 'water',
    base_hp: 72,
    base_attack: 9,
    base_defense: 3,
    speed: 80,
    glyph: 's',
    grants: [{ group: 'magic', key: 'water', weight: 2 }, { group: 'abilities', key: 'magical_power', weight: 1 }]
  },
  {
    id: 'ember_imp',
    name: '火の子鬼',
    element: 'fire',
    base_hp: 66,
    base_attack: 11,
    base_defense: 3,
    speed: 130,
    glyph: 'i',
    grants: [{ group: 'magic', key: 'fire', weight: 2 }, { group: 'abilities', key: 'agility', weight: 1 }]
  },
  {
    id: 'stone_golem',
    name: '石塊ゴーレム',
    element: 'earth',
    base_hp: 108,
    base_attack: 13,
    base_defense: 8,
    speed: 60,
    glyph: 'G',
    grants: [{ group: 'magic', key: 'earth', weight: 2 }, { group: 'abilities', key: 'strength', weight: 2 }]
  },
  {
    id: 'gale_hound',
    name: '疾風狼',
    element: 'wind',
    base_hp: 96,
    base_attack: 11,
    base_defense: 4,
    speed: 130,
    glyph: 'h',
    grants: [{ group: 'magic', key: 'wind', weight: 2 }, { group: 'abilities', key: 'agility', weight: 2 }]
  },
  {
    id: 'gl-wisp',
    name: '灯火ウィスプ',
    element: 'light',
    base_hp: 70,
    base_attack: 12,
    base_defense: 3,
    speed: 100,
    glyph: 'w',
    grants: [{ group: 'magic', key: 'light', weight: 2 }, { group: 'abilities', key: 'academics', weight: 1 }]
  },
  {
    id: 'creeping_shade',
    name: '這い寄る影',
    element: 'dark',
    base_hp: 84,
    base_attack: 11,
    base_defense: 4,
    speed: 95,
    glyph: 'x',
    grants: [{ group: 'magic', key: 'dark', weight: 2 }, { group: 'abilities', key: 'charisma', weight: 1 }]
  },
  {
    id: 'moon_mote',
    name: '月硝モート',
    element: 'light',
    base_hp: 68,
    base_attack: 10,
    base_defense: 3,
    speed: 120,
    glyph: 'm',
    grants: [{ group: 'magic', key: 'light', weight: 2 }, { group: 'abilities', key: 'academics', weight: 1 }]
  },
  {
    id: 'prism_heron',
    name: '虹羽サギ',
    element: 'light',
    base_hp: 82,
    base_attack: 10,
    base_defense: 4,
    speed: 115,
    glyph: 'p',
    grants: [{ group: 'magic', key: 'light', weight: 2 }, { group: 'abilities', key: 'charisma', weight: 1 }]
  },
  {
    id: 'halo_knight',
    name: '環光の騎影',
    element: 'light',
    base_hp: 102,
    base_attack: 13,
    base_defense: 7,
    speed: 80,
    glyph: 'k',
    grants: [{ group: 'magic', key: 'light', weight: 2 }, { group: 'abilities', key: 'strength', weight: 1 }, { group: 'abilities', key: 'academics', weight: 1 }]
  },
  {
    id: 'ink_bat',
    name: '墨羽コウモリ',
    element: 'dark',
    base_hp: 64,
    base_attack: 10,
    base_defense: 2,
    speed: 135,
    glyph: 'b',
    grants: [{ group: 'magic', key: 'dark', weight: 2 }, { group: 'abilities', key: 'agility', weight: 1 }]
  },
  {
    id: 'grave_mirror',
    name: '墓鏡の影',
    element: 'dark',
    base_hp: 88,
    base_attack: 12,
    base_defense: 5,
    speed: 95,
    glyph: 'r',
    grants: [{ group: 'magic', key: 'dark', weight: 2 }, { group: 'abilities', key: 'charisma', weight: 1 }, { group: 'abilities', key: 'magical_power', weight: 1 }]
  },
  {
    id: 'night_lector',
    name: '夜帳の詠み手',
    element: 'dark',
    base_hp: 76,
    base_attack: 13,
    base_defense: 3,
    speed: 105,
    glyph: 'n',
    grants: [{ group: 'magic', key: 'dark', weight: 2 }, { group: 'abilities', key: 'academics', weight: 1 }]
  },
  {
    id: 'cinder_lizard',
    name: '燠火トカゲ',
    element: 'fire',
    base_hp: 78,
    base_attack: 12,
    base_defense: 4,
    speed: 110,
    glyph: 'l',
    grants: [{ group: 'magic', key: 'fire', weight: 2 }, { group: 'abilities', key: 'agility', weight: 1 }]
  },
  {
    id: 'ash_lantern',
    name: '灰燈ランタン',
    element: 'fire',
    base_hp: 70,
    base_attack: 13,
    base_defense: 3,
    speed: 90,
    glyph: 'a',
    grants: [{ group: 'magic', key: 'fire', weight: 2 }, { group: 'abilities', key: 'magical_power', weight: 1 }]
  },
  {
    id: 'forge_hornet',
    name: '炉蜂',
    element: 'fire',
    base_hp: 66,
    base_attack: 12,
    base_defense: 2,
    speed: 140,
    glyph: 'f',
    grants: [{ group: 'magic', key: 'fire', weight: 2 }, { group: 'abilities', key: 'agility', weight: 1 }]
  },
  {
    id: 'rime_newt',
    name: '霜鰭イモリ',
    element: 'water',
    base_hp: 80,
    base_attack: 10,
    base_defense: 5,
    speed: 85,
    glyph: 'u',
    grants: [{ group: 'magic', key: 'water', weight: 2 }, { group: 'abilities', key: 'magical_power', weight: 1 }]
  },
  {
    id: 'tide_jelly',
    name: '潮泡クラゲ',
    element: 'water',
    base_hp: 92,
    base_attack: 9,
    base_defense: 6,
    speed: 70,
    glyph: 'j',
    grants: [{ group: 'magic', key: 'water', weight: 2 }, { group: 'abilities', key: 'academics', weight: 1 }]
  },
  {
    id: 'mirror_carp',
    name: '鏡鯉',
    element: 'water',
    base_hp: 74,
    base_attack: 11,
    base_defense: 3,
    speed: 120,
    glyph: 'c',
    grants: [{ group: 'magic', key: 'water', weight: 2 }, { group: 'abilities', key: 'charisma', weight: 1 }]
  },
  {
    id: 'moss_armor',
    name: '苔鎧の従者',
    element: 'earth',
    base_hp: 116,
    base_attack: 12,
    base_defense: 9,
    speed: 65,
    glyph: 'A',
    grants: [{ group: 'magic', key: 'earth', weight: 2 }, { group: 'abilities', key: 'strength', weight: 1 }]
  },
  {
    id: 'crystal_mole',
    name: '晶洞モグラ',
    element: 'earth',
    base_hp: 90,
    base_attack: 11,
    base_defense: 7,
    speed: 75,
    glyph: 'o',
    grants: [{ group: 'magic', key: 'earth', weight: 2 }, { group: 'abilities', key: 'strength', weight: 1 }, { group: 'abilities', key: 'academics', weight: 1 }]
  },
  {
    id: 'whistle_sprite',
    name: '風笛スプライト',
    element: 'wind',
    base_hp: 66,
    base_attack: 10,
    base_defense: 2,
    speed: 140,
    glyph: 'q',
    grants: [{ group: 'magic', key: 'wind', weight: 2 }, { group: 'abilities', key: 'agility', weight: 1 }]
  },
  {
    id: 'draft_mantis',
    name: '風切カマキリ',
    element: 'wind',
    base_hp: 84,
    base_attack: 13,
    base_defense: 3,
    speed: 135,
    glyph: 'd',
    grants: [{ group: 'magic', key: 'wind', weight: 2 }, { group: 'abilities', key: 'agility', weight: 1 }, { group: 'abilities', key: 'strength', weight: 1 }]
  }
];

export const bossArchetypes = [
  {
    id: 'aurora_regent',
    name: '極光の校庭主',
    element: 'light',
    base_hp: 260,
    base_attack: 22,
    base_defense: 13,
    speed: 95,
    glyph: 'R',
    boss: true,
    grants: [{ group: 'magic', key: 'light', weight: 4 }, { group: 'abilities', key: 'academics', weight: 2 }, { group: 'abilities', key: 'charisma', weight: 1 }]
  },
  {
    id: 'abyss_prefect',
    name: '深淵の寮監',
    element: 'dark',
    base_hp: 280,
    base_attack: 24,
    base_defense: 12,
    speed: 105,
    glyph: 'Y',
    boss: true,
    grants: [{ group: 'magic', key: 'dark', weight: 4 }, { group: 'abilities', key: 'charisma', weight: 2 }, { group: 'abilities', key: 'magical_power', weight: 1 }]
  },
  {
    id: 'volcanic_matron',
    name: '熔炉の大母',
    element: 'fire',
    base_hp: 240,
    base_attack: 26,
    base_defense: 11,
    speed: 100,
    glyph: 'V',
    boss: true,
    grants: [{ group: 'magic', key: 'fire', weight: 4 }, { group: 'abilities', key: 'magical_power', weight: 2 }, { group: 'abilities', key: 'strength', weight: 1 }]
  },
  {
    id: 'leyline_colossus',
    name: '地脈の巨像',
    element: 'earth',
    base_hp: 340,
    base_attack: 23,
    base_defense: 16,
    speed: 70,
    glyph: 'L',
    boss: true,
    grants: [{ group: 'magic', key: 'earth', weight: 4 }, { group: 'abilities', key: 'strength', weight: 3 }]
  }
];

export function validateEnemyArchetypeIdentities(archetypes) {
  const ids = new Set();
  const glyphs = new Set();
  for (const archetype of archetypes) {
    if (!archetype.id) throw new Error('enemy archetype is missing id');
    if (!archetype.glyph) throw new Error(`enemy archetype ${archetype.id} is missing glyph`);
    if (ids.has(archetype.id)) throw new Error(`duplicate enemy archetype id: ${archetype.id}`);
    if (glyphs.has(archetype.glyph)) throw new Error(`duplicate enemy archetype glyph: ${archetype.glyph}`);
    ids.add(archetype.id);
    glyphs.add(archetype.glyph);
  }
}

const allArchetypes = [...enemyArchetypes, ...bossArchetypes];
validateEnemyArchetypeIdentities(allArchetypes);

const archetypeById = new Map(allArchetypes.map((archetype) => [archetype.id, archetype]));

export function enemyArchetype(id) {
  const archetype = archetypeById.get(id);
  if (!archetype) throw new Error(`unknown enemy archetype: ${id}`);
  return archetype;
}

// Floor depth scales an archetype's raw stats. Deeper floors are meaningfully
// more dangerous, which is what makes greed (descending further) a real choice.
export function scaledEnemyStats(archetype, floor) {
  const depth = difficultyFloorFor(floor) - 1;
  const scaledAttack = archetype.base_attack + depth;
  return {
    max_hp: archetype.base_hp + Math.round(archetype.base_hp * 0.38 * depth),
    attack: Math.round(scaledAttack * ENEMY_ATTACK_PRESSURE_MULTIPLIER),
    defense: archetype.base_defense + Math.floor(depth / 2),
    speed: archetype.speed
  };
}

// How many enemies populate a floor (grows with depth).
export function enemyCountForFloor(floor) {
  return 4 + difficultyFloorFor(floor);
}
