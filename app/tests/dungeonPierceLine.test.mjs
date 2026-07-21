import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { pierceSpellPower } from '../src/dungeon/dungeonStats.mjs';
import { spellOutcome } from '../src/dungeon/combatResolution.mjs';
import { createRng, deriveSeed } from '../src/dungeon/dungeonRng.mjs';
import { enterDungeon, dungeonAction } from '../src/dungeon/dungeonEngine.mjs';
import { TILE_FLOOR, TILE_WALL } from '../src/dungeon/dungeonGeneration.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

// A high dark+fire hero so the pierce power is comfortably above 1 (distinct per-hit variance damage).
function params() {
  const magic = { light: 20, dark: 80, fire: 80, water: 20, earth: 80, wind: 80 };
  const abilities = { strength: 25, agility: 25, academics: 25, magical_power: 25, charisma: 25 };
  return {
    magic: Object.fromEntries(Object.entries(magic).map(([k, v]) => [k, { value: v }])),
    abilities: Object.fromEntries(Object.entries(abilities).map(([k, v]) => [k, { value: v }]))
  };
}

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}
async function pierceRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-pierce-line-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '学院購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', params());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  return root;
}
async function readRun(root) {
  return (await readJson(root, 'data/mutable/game_data/runtime_state.json')).dungeon_run;
}

// Lays down a fully controlled board: every tile a wall except a single carved floor row `py`, the player
// planted at (2, py) with wide vision and deep HP/MP, and the given collinear/off-line enemies. This makes
// the pierce ray a straight horizontal line whose reach is decided only by the walls the test places on it.
async function setBoard(root, { py, enemies, wallCells = [] }) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  const run = state.dungeon_run;
  const { width, height } = run;
  run.tiles = Array.from({ length: height }, () => Array.from({ length: width }, () => TILE_WALL));
  for (let x = 0; x < width; x += 1) run.tiles[py][x] = TILE_FLOOR;
  for (const cell of wallCells) run.tiles[cell.y][cell.x] = TILE_WALL;
  run.explored = Array.from({ length: height }, () => Array.from({ length: width }, () => true));
  run.player.x = 2;
  run.player.y = py;
  run.player.hp = 99999;
  run.player.max_hp = 99999;
  run.player.mp = 999;
  run.player.max_mp = 999;
  run.player_stats = { ...run.player_stats, vision_radius: 50 };
  run.stairs = { x: 0, y: 0 };
  run.entrance = { x: 0, y: 0 };
  // element 'dark' gives the dark pierce no elemental advantage (dark beats light, not dark), so every hit's
  // damage is a pure power×variance roll — and a surviving enemy that casts back never hits an unknown-element
  // label. defense is large per test but ignored by pierce; it only proves the bypass.
  run.enemies = enemies.map((e) => ({
    archetype_id: 'ember_imp', name: e.uid, element: 'dark', glyph: 'w', attack: 1, defense: e.defense ?? 0, speed: 1,
    max_hp: e.hp, ...e
  }));
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);
}

// Replays the engine's combat RNG (createRng(deriveSeed(seed, 100000 + turn))) to compute the exact
// per-hit ignore-defense damage in a given resolution order — the reference the engine must match.
function referenceDamages(run, orderedDefenders) {
  const rng = createRng(deriveSeed(run.seed, 100000 + run.turn));
  const power = pierceSpellPower(run.parameters);
  return orderedDefenders.map((d) => spellOutcome(rng, power, 'dark', { element: 'dark', defense: d.defense ?? 0 }, { ignoreDefense: true }).damage);
}

test('貫通は直線上の複数の敵を近→遠順に多段ヒットし、全ヒットで防御無視が維持される', async (t) => {
  const root = await pierceRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  const py = 5;
  // Collinear on the player row: near(x=4), mid(x=6), far(x=8). All high-defense so a non-ignoring hit
  // would floor to 1 — proving every hit (not just the first) bypasses defense.
  await setBoard(root, { py, enemies: [
    { uid: 'near', x: 4, y: py, hp: 9999, defense: 500 },
    { uid: 'mid', x: 6, y: py, hp: 9999, defense: 500 },
    { uid: 'far', x: 8, y: py, hp: 9999, defense: 500 }
  ] });

  const before = await readRun(root);
  const expected = referenceDamages(before, [
    { defense: 500 }, { defense: 500 }, { defense: 500 }
  ]);

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'pierce_spell' } });

  const after = await readRun(root);
  const dmg = (uid) => { const e = after.enemies.find((x) => x.uid === uid); return e.max_hp - e.hp; };
  // Each hit's damage equals the reference drawn in near→far order — proving multi-hit, the resolution
  // order (near consumes the first variance roll, far the last), and defense bypass on every hit at once.
  assert.deepEqual([dmg('near'), dmg('mid'), dmg('far')], expected, 'near→far hits match the ordered ignore-defense reference');
  assert.ok(expected.every((d) => d > 1), 'every hit bypasses the def-500 wall (a non-ignoring hit would be 1)');
});

test('貫通線は壁で止まり、壁の向こうの敵には当たらない', async (t) => {
  const root = await pierceRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  const py = 5;
  // near(x=4) is hit; a wall at x=6 stops the ray before the far enemy at x=8.
  await setBoard(root, {
    py,
    enemies: [
      { uid: 'near', x: 4, y: py, hp: 9999, defense: 0 },
      { uid: 'behind_wall', x: 8, y: py, hp: 9999, defense: 0 }
    ],
    wallCells: [{ x: 6, y: py }]
  });

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'pierce_spell' } });

  const after = await readRun(root);
  const near = after.enemies.find((e) => e.uid === 'near');
  const behind = after.enemies.find((e) => e.uid === 'behind_wall');
  assert.ok(near.max_hp - near.hp > 0, 'the enemy before the wall is hit');
  assert.equal(behind.hp, behind.max_hp, 'the enemy past the wall is untouched (magic does not pierce walls)');
});

test('貫通線から外れた敵（非 collinear）には当たらない', async (t) => {
  const root = await pierceRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await enterDungeon({ root, seed: 4242 });
  const py = 5;
  // near(x=4) and mid(x=6) sit on the ray; an off-line enemy on the row below (its own carved floor) does not.
  await setBoard(root, {
    py,
    enemies: [
      { uid: 'near', x: 4, y: py, hp: 9999, defense: 0 },
      { uid: 'mid', x: 6, y: py, hp: 9999, defense: 0 },
      { uid: 'off_line', x: 6, y: py + 1, hp: 9999, defense: 0 }
    ],
    // Carve the off-line enemy's tile to floor so it is a legitimate standable cell, not merely wall-shadowed.
    wallCells: []
  });
  // The off-line cell needs to be floor for the enemy to be a real target elsewhere; carve it directly.
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.dungeon_run.tiles[py + 1][6] = TILE_FLOOR;
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', state);

  await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'pierce_spell' } });

  const after = await readRun(root);
  const near = after.enemies.find((e) => e.uid === 'near');
  const mid = after.enemies.find((e) => e.uid === 'mid');
  const off = after.enemies.find((e) => e.uid === 'off_line');
  assert.ok(near.max_hp - near.hp > 0, 'the on-line near enemy is hit');
  assert.ok(mid.max_hp - mid.hp > 0, 'the on-line mid enemy is hit');
  assert.equal(off.hp, off.max_hp, 'the off-line enemy takes no damage');
});

test('貫通の結果は同一 (seed, turn, 盤面) で決定的（save/reload 不変）', async (t) => {
  async function runOnce() {
    const root = await pierceRoot();
    await enterDungeon({ root, seed: 4242 });
    const py = 5;
    await setBoard(root, { py, enemies: [
      { uid: 'near', x: 4, y: py, hp: 9999, defense: 0 },
      { uid: 'mid', x: 6, y: py, hp: 9999, defense: 0 },
      { uid: 'far', x: 8, y: py, hp: 9999, defense: 0 }
    ] });
    await dungeonAction({ root, postDungeonScreen: 'academy-room', action: { type: 'pierce_spell' } });
    const after = await readRun(root);
    const result = ['near', 'mid', 'far'].map((uid) => {
      const e = after.enemies.find((x) => x.uid === uid);
      return e.max_hp - e.hp;
    });
    await fs.rm(root, { recursive: true, force: true });
    return result;
  }

  const first = await runOnce();
  const second = await runOnce();
  assert.deepEqual(second, first, 'identical (seed, turn, board) yields identical per-hit damage');
});
