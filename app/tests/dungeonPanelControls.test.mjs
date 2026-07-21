import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

test('map icons: companion and enemy tokens carry no frame ring', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // The ally/enemy ::after frame ring is suppressed.
  assert.match(css, /\.dn-token--ally::after,\s*\.dn-token--enemy::after \{ display: none; \}/, 'companion/enemy frame ring is removed');
  // The frame PNGs for ally/enemy are no longer referenced (clean removal, not just hidden by layering).
  assert.doesNotMatch(css, /frames\/frame_ally\.png/, 'the companion frame PNG is no longer used');
  assert.doesNotMatch(css, /frames\/frame_enemy\.png/, 'the enemy frame PNG is no longer used');
  // The self token keeps its frame (only companion/enemy were asked to be cleaned).
  assert.match(css, /\.dn-token--self::after \{ background-image: url\("\/canonical\/dungeon\/frames\/frame_self\.png"\)/, 'the player token keeps its frame');
});

test('bottom panel: controls on the left, a scrollable action log on the right', async () => {
  const html = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  // Dock = spell controls + keyboard hint on the left, log panel on the right.
  assert.match(html, /class="dungeon-dock"[\s\S]*class="dungeon-dock-main"[\s\S]*id="dungeon-spells"[\s\S]*class="dungeon-controls-hint"[\s\S]*id="dungeon-log"/, 'dock has controls (spells + hint) then the log panel');
  // The dock is a flex row; the log fills the right and scrolls so past turns can be read back.
  assert.match(css, /\.dungeon-dock \{[\s\S]*display: flex;[\s\S]*\}/, 'the dock is a flex row');
  assert.match(css, /\.dungeon-log \{[\s\S]*overflow-y: auto[\s\S]*\}/, 'the action log scrolls');
  // The removed elements and their styles are gone.
  assert.doesNotMatch(html, /id="dungeon-wait"|id="dungeon-descend"|id="dungeon-log-ribbon"|class="dungeon-dpad"|data-dir=/, 'dpad and wait/descend buttons and the ribbon are gone');
  assert.doesNotMatch(css, /\.dungeon-dpad|\.dungeon-log-ribbon|\.dungeon-full-log/, 'dpad / ribbon / full-log styles are removed');
});

test('action log renders the full run history and follows the newest line', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // The dock renders every log entry into #dungeon-log (not just the last few) and auto-scrolls
  // to the bottom unless the player has scrolled up.
  assert.match(js, /function renderDungeonDock\(view\)[\s\S]*const log = document\.querySelector\('#dungeon-log'\)/, 'the dock renders the action log panel');
  assert.match(js, /function renderDungeonDock\(view\)[\s\S]*for \(const entry of view\.log \?\? \[\]\)[\s\S]*log\.append\(p\)/, 'the log shows the full run history');
  assert.match(js, /atBottom[\s\S]*log\.scrollTop = log\.scrollHeight/, 'the log follows the newest line when already at the bottom');
  // No descend button to gate, and the old full-log popup is gone (the inline log replaces it).
  assert.doesNotMatch(js, /#dungeon-descend/, 'no descend button is referenced');
  assert.doesNotMatch(js, /function openDungeonFullLog/, 'the old full-log popup helper is removed');
});

test('keyboard drives the dungeon: move keys, Space = wait, Enter = descend', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  // Arrow keys map to movement (the pre-existing movement contract; no added alternate keys).
  assert.match(js, /const DUNGEON_ARROW_DIRS = \{ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' \}/, 'arrow keys map to movement');
  assert.match(js, /const direction = DUNGEON_ARROW_DIRS\[event\.key\];[\s\S]*dungeonDo\(\{ type: 'move', direction \}\)/, 'arrow keys cast a move action');
  // Space = wait, Enter = descend.
  assert.match(js, /event\.key === ' ' \|\| event\.code === 'Space'[\s\S]*dungeonDo\(\{ type: 'wait' \}\)/, 'Space waits');
  assert.match(js, /event\.key === 'Enter'[\s\S]*dungeonDo\(\{ type: 'descend' \}\)/, 'Enter descends');
  // The handler never steals keys from a focused control (chat input / buttons) or from the
  // focused action log, so typing, focused-button Space/Enter, and keyboard scrolling of the log
  // keep working instead of firing accidental turns.
  assert.match(js, /active\.id === 'dungeon-log' \|\| \['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'\]\.includes\(active\.tagName\)/, 'the focused log and form controls are not hijacked');
  // The dpad-button click handlers are gone (no buttons to bind).
  assert.doesNotMatch(js, /querySelectorAll\('\.dungeon-move'\)/, 'the dpad button click loop is removed');
});
