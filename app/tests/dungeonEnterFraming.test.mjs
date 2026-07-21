import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';

const publicRoot = path.join(projectRoot, 'app/public');

// The dungeon entry frame uses the SAME camera rule as a move: the content-clamped deadzone follow,
// seeded from the player-centred offset. So the entry is the centred-then-clamped position the follow
// would hold — when the spawn sits near a floor edge the player is framed near that edge (the board's
// off-content margin is never shown), exactly as a follow frames it. Entry and movement obey one rule,
// so the first step does not jump the camera (the player stays inside the deadzone -> the camera
// holds). The viewport reaches its final size synchronously because renderDungeonPlay lays the
// surrounding panels out (the chat aside that claims the map column, the HUD, the dock) BEFORE the
// grid measures, so the entry frame is computed once against the settled viewport.
//
// Camera placement is a function of what changed: a fresh board (signature change) centers (seeded
// follow); a same-board render where the player MOVED follows; a same-board render where the player
// did NOT move (a re-show, a state refresh) preserves the camera as placed; a viewport resize
// reframes, and a reframe with no net size change (the settle right after the entry frame) is skipped.
// The render-backed proof (no first-move camera jerk, a content-clamped entry, a pre-move re-show
// leaving the camera put, and the first move handing off to deadzone follow) lives in
// app/tests/manual/dungeonEnterRender.mjs.

async function appJs() {
  return readFile(path.join(publicRoot, 'app.js'), 'utf8');
}
function fnSource(js, signature) {
  return js.match(new RegExp(`function ${signature}[\\s\\S]*?\\n}`))?.[0] ?? '';
}

test('the owed-center debt is gone entirely — no dungeonPendingCenter anywhere', async () => {
  const js = await appJs();
  assert.doesNotMatch(
    js,
    /dungeonPendingCenter/,
    'the entry center is a single deterministic placement, not a debt held until the first action and overwritten on every settle',
  );
});

test('renderDungeonPlay lays the surrounding panels out BEFORE the grid so the entry center measures the settled viewport', async () => {
  const fn = fnSource(await appJs(), 'renderDungeonPlay\\(view\\)');
  assert.ok(fn, 'renderDungeonPlay exists');
  const idxHud = fn.indexOf('renderDungeonHud(view)');
  const idxDock = fn.indexOf('renderDungeonDock(view)');
  const idxChat = fn.indexOf('renderDungeonChat(view)');
  const idxGrid = fn.indexOf('renderDungeonGrid(view)');
  assert.ok(idxHud >= 0 && idxDock >= 0 && idxChat >= 0 && idxGrid >= 0, 'all four panel renders are present');
  assert.ok(
    idxGrid > idxHud && idxGrid > idxDock && idxGrid > idxChat,
    'the grid renders LAST, so the chat aside has already claimed the map column and the entry center measures the final width',
  );
});

test('renderDungeonGrid centers a fresh board, follows a real move, and preserves a no-move re-render', async () => {
  const fn = fnSource(await appJs(), 'renderDungeonGrid\\(view\\)');
  assert.ok(fn, 'renderDungeonGrid exists');
  // The previous player tile is read before the entity overlay overwrites it and before a fresh
  // board clears it, so "did the player move?" is answered from the prior render.
  assert.match(
    fn,
    /const previousPlayerTile = dungeonEntityTiles\.get\('player'\) \?\? null;/,
    'the prior player tile is captured up front',
  );
  const prevIdx = fn.indexOf("const previousPlayerTile = dungeonEntityTiles.get('player')");
  const clearIdx = fn.indexOf('dungeonEntityTiles.clear()');
  const upsertIdx = fn.indexOf("upsertDungeonEntity(overlay, 'player'");
  assert.ok(prevIdx >= 0 && clearIdx > prevIdx, 'the prior tile is read before a fresh board clears the tile map');
  assert.ok(prevIdx >= 0 && upsertIdx > prevIdx, 'the prior tile is read before the player entity overwrites it with the new tile');
  assert.match(
    fn,
    /const playerMoved = !previousPlayerTile\s*\|\|\s*previousPlayerTile\.x !== view\.player\.x \|\| previousPlayerTile\.y !== view\.player\.y;/,
    'a move is detected by the player tile changing',
  );
  assert.match(
    fn,
    /const mode = signatureChanged \? 'center' : \(playerMoved \? 'follow' : 'preserve'\);/,
    'fresh board -> center, moved -> follow, unmoved same-board render -> preserve',
  );
  assert.match(fn, /layoutDungeonBoard\(view, \{ mode \}\);/, 'the chosen mode drives the layout');
});

test('layoutDungeonBoard treats preserve as a no-op so a pre-move re-show leaves the camera put', async () => {
  const fn = fnSource(await appJs(), 'layoutDungeonBoard\\(view, \\{ mode \\}\\)');
  assert.ok(fn, 'layoutDungeonBoard exists');
  assert.match(fn, /if \(mode === 'preserve'\) return;/, 'preserve leaves the camera exactly as placed');
  const preserveIdx = fn.indexOf("if (mode === 'preserve') return;");
  const measureIdx = fn.indexOf('const viewW = viewport.clientWidth;');
  assert.ok(preserveIdx >= 0 && preserveIdx < measureIdx, 'preserve returns before any measurement or camera math');
});

test('layoutDungeonBoard skips a reframe with no net viewport size change (the entry settle has nothing to reframe)', async () => {
  const fn = fnSource(await appJs(), 'layoutDungeonBoard\\(view, \\{ mode \\}\\)');
  assert.match(
    fn,
    /if \(mode === 'reframe' && viewW === dungeonViewportSize\.w && viewH === dungeonViewportSize\.h\) return;/,
    'a reframe whose viewport size matches the last layout has nothing to do',
  );
  assert.match(
    fn,
    /dungeonViewportSize = \{ w: viewW, h: viewH \};/,
    'each measured layout records the viewport size it was computed for',
  );
});

test('the entry (center) frame is the deadzone follow seeded from the centred offset — one rule, no clamp-less snap', async () => {
  const js = await appJs();
  const fn = fnSource(js, 'layoutDungeonBoard\\(view, \\{ mode \\}\\)');
  // center (fresh board) and follow (a move) share ONE camera call; they differ only in the deadzone
  // seed — a move continues from the previous camera, a fresh-board entry seeds from the player-centred
  // offset so the entry is the content-clamped position the follow holds. This is what removes the
  // first-move jerk (a clamp-less center handing off to a content-clamped follow).
  assert.match(fn, /const seedX = mode === 'center' \? playerX - viewW \/ 2 : dungeonCamera\.x;/, 'center seeds the follow from the centred x offset');
  assert.match(fn, /const seedY = mode === 'center' \? playerY - viewH \/ 2 : dungeonCamera\.y;/, 'center seeds the follow from the centred y offset');
  assert.match(fn, /prevX: seedX, prevY: seedY/, 'the seed feeds the deadzone follow as its previous camera');
  // No clamp-less center special-case survives in the camera call (the layout passes no snap flag) …
  assert.doesNotMatch(fn, /snap:/, 'the layout passes no snap flag to the camera');
  // … and the pure camera math has no snap parameter or branch at all.
  const cameraJs = await readFile(path.join(publicRoot, 'dungeonCamera.js'), 'utf8');
  const computeFn = cameraJs.match(/export function computeDungeonCamera\([\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(computeFn, 'computeDungeonCamera exists');
  assert.doesNotMatch(computeFn, /snap/, 'computeDungeonCamera has no snap parameter or branch');
});

test('layoutDungeonBoard never reassigns the mode to center — there is no owed-center upgrade path', async () => {
  const fn = fnSource(await appJs(), 'layoutDungeonBoard\\(view, \\{ mode \\}\\)');
  assert.doesNotMatch(fn, /mode = 'center';/, 'no layout silently upgrades itself to a center (the timing is fixed instead)');
  assert.doesNotMatch(fn, /dungeonPendingCenter/, 'no owed-center bookkeeping inside the layout');
});

test('dungeonDo no longer touches the entry framing — an action is just an action', async () => {
  const dungeonDo = fnSource(await appJs(), 'dungeonDo\\(action\\)');
  assert.ok(dungeonDo, 'dungeonDo exists');
  assert.doesNotMatch(dungeonDo, /dungeonPendingCenter|dungeonViewportSize/, 'the action handler does not special-case the camera framing');
});

test('the grid ResizeObserver re-lays out in reframe mode', async () => {
  const js = await appJs();
  assert.match(
    js,
    /new ResizeObserver\(\(\) => \{[\s\S]*layoutDungeonBoard\(currentDungeonView, \{ mode: 'reframe' \}\);[\s\S]*\}\)\.observe\(dungeonGridEl\)/,
    'the grid ResizeObserver re-lays out in reframe mode on an actual resize',
  );
});
