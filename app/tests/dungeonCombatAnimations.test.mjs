import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('the engine exposes structured turn events on the view without persisting them', async () => {
  const engine = await readFile(path.join(projectRoot, 'app/src/dungeon/dungeonEngine.mjs'), 'utf8');
  // Combat moments emit events; the view carries them; they are stripped from saved state.
  assert.match(engine, /function pushEvent\(run, event\)/, 'pushEvent records combat events');
  assert.match(engine, /pushEvent\(run, \{ kind: 'cast'/, 'casts emit a cast event');
  assert.match(engine, /pushEvent\(run, \{ kind: 'melee'/, 'melee/bumps emit a melee event');
  assert.match(engine, /pushEvent\(run, \{ kind: 'enemy_attack'/, 'enemy attacks emit an enemy_attack event');
  assert.match(engine, /events: \[\.\.\.\(run\.turn_events \?\? \[\]\)\]/, 'the view exposes the turn events');
  assert.match(engine, /dungeon_run: \{ \.\.\.run, turn_events: \[\] \}/, 'turn events are stripped from persisted state');
  // Both run-ending result builders carry the turn's events (e.g. the fatal blow): the deferred
  // preview (beginRunEnd) and the synchronous/committed end (commitRunEnd).
  assert.match(engine, /function beginRunEnd\([\s\S]*events,[\s\S]*transition:/, 'the deferred preview carries the run-ending turn events');
  assert.match(engine, /function commitRunEnd\([\s\S]*events: \[\.\.\.\(run\.turn_events \?\? \[\]\)\][\s\S]*transition:/, 'the committed end carries the run-ending turn events');
});

test('the client animates combat events without blocking input', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // A dedicated effects layer lives inside the board (scrolls with the camera).
  assert.match(js, /function renderDungeonGrid\(view\)[\s\S]*effectsLayer\.className = 'dn-effects'[\s\S]*board\.append\(tilesLayer, entitiesLayer, effectsLayer\)/, 'the board carries a combat-effects layer');
  // dungeonDo renders then fires the (non-blocking) animation for that turn's events.
  assert.match(js, /renderDungeonPlay\(result\);\s*animateDungeonCombat\(result\.events\)/, 'dungeonDo animates the turn events after rendering');
  // A run-ending turn still animates its combat (the fatal blow) before showing the result.
  assert.match(js, /if \(result\.ended\) \{[\s\S]*if \(result\.events\?\.length\) \{[\s\S]*animateDungeonCombat\(result\.events\)[\s\S]*DUNGEON_ENDED_ANIM_MS[\s\S]*\}\s*renderDungeonResult\(result\)/, 'an ended run animates its combat before the result screen');
  // animateDungeonCombat clears stale effects, staggers, and respects reduced-motion.
  assert.match(js, /function animateDungeonCombat\(events\)[\s\S]*layer\.replaceChildren\(\)[\s\S]*prefers-reduced-motion: reduce[\s\S]*spawnDungeonEffect/, 'animateDungeonCombat clears, checks reduced-motion, and spawns effects');
  // spawnDungeonEffect resolves the displayed endpoints, then delegates: element events (cast /
  // enemy_attack) play asset sprites, melee (element: null) keeps the neutral CSS strike.
  assert.match(js, /function spawnDungeonEffect\(layer, event, \{ origin, cell, reduce \}\)[\s\S]*if \(event\.element != null\) spawnDungeonAssetEffect[\s\S]*else spawnDungeonMeleeEffect/, 'spawnDungeonEffect delegates element events to assets and melee to the neutral strike');
  // The asset effect lands an impact burst only on a hit (the miss contract is preserved).
  assert.match(js, /function spawnDungeonAssetEffect\([\s\S]*if \(!event\.hit\) return;[\s\S]*dn-effect-burst/, 'a hit lands an asset impact; a miss does not');
});

test('combat effect styles exist and respect reduced motion', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  assert.match(css, /\.dn-effects \{[\s\S]*position: absolute[\s\S]*pointer-events: none[\s\S]*\}/, 'the effects layer overlays the board');
  assert.match(css, /\.dn-effect \{[\s\S]*var\(--dn-effect-color\)/, 'the melee projectile uses the per-event color');
  assert.match(css, /\.dn-effect-impact \{[\s\S]*var\(--dn-effect-color\)/, 'the melee impact uses the per-event color');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.dn-effect, \.dn-effect-bolt \{ display: none; \}/, 'both the melee projectile and the asset bolt are suppressed under reduced motion');
});
