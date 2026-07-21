import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { projectRoot } from './testPaths.mjs';
import { computeDungeonCellSize, computeFollowMargin, computeDungeonCamera, reframeDungeonCamera, playerViewportFraction, rescaleBoardPx } from '../public/dungeonCamera.js';

const publicRoot = path.join(projectRoot, 'app/public');

// A representative desktop dungeon viewport (map column ~6/10 of the stage, full height).
const VIEW_W = 900;
const VIEW_H = 500;
const GAP = 1;
const R = 3; // default academics → vision_radius 3; drives the follow margin now (no longer the cell size)
const CELL_MIN = 44;
const CELL_MAX = 72;
const TARGET_CELLS = 8; // fixed cells across the smaller axis — the scale is vision/content-independent

// ---- cell sizing: a fixed target count fits the viewport, independent of vision/content ----

test('cell size fits a fixed target cell count into the smaller viewport axis (larger axis shows more)', () => {
  const cell = computeDungeonCellSize({ viewW: VIEW_W, viewH: VIEW_H, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  const step = cell + GAP;
  // The smaller axis (height) shows ~ TARGET_CELLS cells when the band does not clamp.
  const cellsDownSmallerAxis = VIEW_H / step;
  assert.ok(Math.abs(cellsDownSmallerAxis - TARGET_CELLS) < 0.2, `the smaller axis shows ~${TARGET_CELLS} cells (showed ${cellsDownSmallerAxis.toFixed(2)})`);
  // The larger axis (width) then simply shows more of the map.
  assert.ok(VIEW_W / step > cellsDownSmallerAxis, 'the larger axis shows more cells than the smaller axis');
});

test('cell size is clamped to a readable band on extreme viewports', () => {
  const huge = computeDungeonCellSize({ viewW: 2400, viewH: 2400, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  assert.equal(huge, CELL_MAX, 'a huge viewport caps the cell size (shows more map, not giant tiles)');
  const tiny = computeDungeonCellSize({ viewW: 180, viewH: 120, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  assert.equal(tiny, CELL_MIN, 'a tiny viewport floors the cell size (stays readable — the "小さくて見えない" floor)');
});

test('cell size does not depend on vision radius or content — one window size gives one scale', () => {
  // The signature carries no vision/content input: the same viewport always yields the same cell, so a run
  // that raises vision, a deeper floor, or a HUD/item toggle can never rezoom the map. (The old rule shrank
  // the cell for a wider vision; that coupling is gone — vision now drives only the follow margin.)
  const a = computeDungeonCellSize({ viewW: VIEW_W, viewH: VIEW_H, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  const b = computeDungeonCellSize({ viewW: VIEW_W, viewH: VIEW_H, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  assert.equal(a, b, 'a fixed viewport yields a fixed cell (content-independent scale)');
  // A raised floor keeps the representative desktop column well above the old 24px specks.
  assert.ok(a >= CELL_MIN && a >= 44, 'the representative desktop cell stays large and readable');
});

// ---- follow margin: where the camera starts scrolling ----

test('the follow margin reaches the outer vision tile EDGE (r*step + cell/2), not just its center', () => {
  const cell = 48;
  const step = cell + GAP;
  assert.equal(computeFollowMargin({ visionRadius: R, step, cell, viewSize: VIEW_W }), R * step + cell / 2);
});

test('the follow margin never inverts the deadzone on a small viewport', () => {
  const cell = 48;
  const step = cell + GAP;
  const margin = computeFollowMargin({ visionRadius: R, step, cell, viewSize: 120 });
  assert.ok(margin > 0, 'a small viewport keeps a positive margin');
  assert.ok(margin < 120 / 2, 'the margin stays under half the viewport so the deadzone does not invert');
});

// ---- deadzone camera ----

const STEP = 49; // for the camera scenarios below we pin cell+gap so positions are exact
function tileCenter(i) {
  return i * STEP + (STEP - GAP) / 2; // cell = STEP - GAP
}
const CELL = STEP - GAP; // 48
const MAP_TILES = 40; // big enough that mid-map follow is not clamped to an edge
const MAP_PX = MAP_TILES * STEP - GAP;
const MARGIN = R * STEP + CELL / 2; // tile-edge margin: holds the full lit tile on-screen

function camera(player, prev) {
  return computeDungeonCamera({
    playerX: tileCenter(player.x), playerY: tileCenter(player.y),
    contentMinX: 0, contentMaxX: MAP_PX, contentMinY: 0, contentMaxY: MAP_PX,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN, prevX: prev.x, prevY: prev.y
  });
}

// The entry frame uses the SAME deadzone-follow rule as a move, seeded from the player-centred
// offset, so it is the centred-then-content-clamped position the follow holds. A move then
// continues the follow from there, so the first step never jumps.
function entryCamera(player) {
  const playerX = tileCenter(player.x);
  const playerY = tileCenter(player.y);
  return computeDungeonCamera({
    playerX, playerY,
    contentMinX: 0, contentMaxX: MAP_PX, contentMinY: 0, contentMaxY: MAP_PX,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN,
    prevX: playerX - VIEW_W / 2, prevY: playerY - VIEW_H / 2
  });
}

test('the entry frame centers a player whose centred camera fits inside the content bounds', () => {
  const cam = entryCamera({ x: 10, y: 10 }); // tile 10 of a 40-tile map: centring does not reach a content edge
  assert.ok(Math.abs((tileCenter(10) - cam.x) - VIEW_W / 2) < 1e-6, 'player is horizontally centered');
  assert.ok(Math.abs((tileCenter(10) - cam.y) - VIEW_H / 2) < 1e-6, 'player is vertically centered');
});

test('the entry frame content-clamps a near-edge spawn (same as a follow) so the first step never jumps', () => {
  // The spawn tile sits against the floor content's top-left edge (the common entry), and the content
  // box is wider/taller than the viewport. The entry uses the follow's content clamp — NOT a clamp-less
  // center — so the centred camera, which lies past the content edge, is clamped back to that edge. The
  // player is intentionally NOT dead-centre here (it sits near the edge, exactly as a follow frames it).
  const cMin = 0;
  const cMax = MAP_PX; // content larger than the viewport on both axes
  const px = tileCenter(1); // near the content's top-left corner
  const py = tileCenter(1);
  const entry = computeDungeonCamera({
    playerX: px, playerY: py,
    contentMinX: cMin, contentMaxX: cMax, contentMinY: cMin, contentMaxY: cMax,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN,
    prevX: px - VIEW_W / 2, prevY: py - VIEW_H / 2 // entry seeds the deadzone from the centred offset
  });
  assert.equal(entry.x, cMin, 'the entry camera is clamped to the content edge, not parked at the clamp-less center');
  assert.equal(entry.y, cMin, 'same on the y axis');
  // The entry equals the position a follow holds for that spawn, so the first step (player still
  // inside the deadzone) leaves the camera exactly where it is — no clamp-gap jerk on move one.
  const firstStep = computeDungeonCamera({
    playerX: px + STEP, playerY: py,
    contentMinX: cMin, contentMaxX: cMax, contentMinY: cMin, contentMaxY: cMax,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN, prevX: entry.x, prevY: entry.y
  });
  assert.equal(firstStep.x, entry.x, 'the first step does not jump the camera on x (the no-jerk property)');
  assert.equal(firstStep.y, entry.y, 'nor on y');
});

test('across viewports and content offsets the entry frame is centred-then-clamped (the follow rule), no first-step jerk', () => {
  const viewports = [[900, 500], [1280, 720], [600, 900], [375, 667]];
  const offsets = [0, 3, 7, 12]; // the floor content box starts at a different tile per seed
  for (const [vw, vh] of viewports) {
    for (const off of offsets) {
      // Player at the content's near edge (the typical entry), content larger than the viewport.
      const contentMin = off * STEP;
      const contentMax = (off + 30) * STEP - GAP;
      const px = tileCenter(off);
      const py = tileCenter(off + 1);
      const bounds = { contentMinX: contentMin, contentMaxX: contentMax, contentMinY: contentMin, contentMaxY: contentMax };
      const entry = computeDungeonCamera({ playerX: px, playerY: py, ...bounds, viewW: vw, viewH: vh, marginX: MARGIN, marginY: MARGIN, prevX: px - vw / 2, prevY: py - vh / 2 });
      // The entry is exactly the centred camera clamped to the content bounds — the follow rule.
      const expectedX = Math.max(contentMin, Math.min(px - vw / 2, contentMax - vw));
      const expectedY = Math.max(contentMin, Math.min(py - vh / 2, contentMax - vh));
      assert.ok(Math.abs(entry.x - expectedX) < 1e-6, `entry x is centred-then-clamped (viewport ${vw}x${vh}, content@${off})`);
      assert.ok(Math.abs(entry.y - expectedY) < 1e-6, `entry y is centred-then-clamped (viewport ${vw}x${vh}, content@${off})`);
      // Stepping one tile from the entry moves the camera by at most one tile (the deadzone bound) —
      // never the clamp-gap jump a clamp-less center handing off to a clamped follow would produce.
      const step = computeDungeonCamera({ playerX: px + STEP, playerY: py, ...bounds, viewW: vw, viewH: vh, marginX: MARGIN, marginY: MARGIN, prevX: entry.x, prevY: entry.y });
      assert.ok(Math.abs(step.x - entry.x) <= STEP + 1e-6, `the first step moves the camera at most one tile (viewport ${vw}x${vh}, content@${off})`);
    }
  }
});

test('inside the deadzone the camera holds still — only the player moves', () => {
  const start = entryCamera({ x: 10, y: 10 });
  // Step one tile right; the player stays inside the central deadzone, so the camera must not move.
  const after = camera({ x: 11, y: 10 }, start);
  assert.equal(after.x, start.x, 'the camera x does not move while the player is inside the deadzone');
  assert.equal(after.y, start.y, 'the camera y does not move');
});

test('at the deadzone edge the camera scrolls to hold the player at the margin', () => {
  const start = entryCamera({ x: 10, y: 10 });
  // Walk right until the player pushes past the right deadzone edge.
  const after = camera({ x: 17, y: 10 }, start);
  assert.notEqual(after.x, start.x, 'the camera scrolled to follow');
  const playerScreenX = tileCenter(17) - after.x;
  assert.ok(Math.abs(playerScreenX - (VIEW_W - MARGIN)) < 1e-6, 'the player is held exactly at the right follow margin');
  // Held there, the outer visible tile EDGE (r*step + cell/2 beyond the player center) lands
  // exactly at the viewport edge — the full lit tile is on-screen (the "視界内なのに画面外" fix),
  // asserting the tile EDGE, not just its center.
  assert.ok(Math.abs((playerScreenX + R * STEP + CELL / 2) - VIEW_W) < 1e-6, 'the outermost visible tile edge sits exactly at the viewport edge');
});

test('the camera cannot scroll past the content edges (so the edge is reachable, not endless)', () => {
  // Player jammed into the top-left corner: the camera clamps to (0,0).
  const corner = camera({ x: 0, y: 0 }, { x: 9999, y: 9999 });
  assert.equal(corner.x, 0, 'no scroll past the left edge');
  assert.equal(corner.y, 0, 'no scroll past the top edge');
  // Player in the bottom-right corner: the camera clamps to the far edge.
  const far = camera({ x: MAP_TILES - 1, y: MAP_TILES - 1 }, { x: -9999, y: -9999 });
  assert.equal(far.x, MAP_PX - VIEW_W, 'clamped to the right content edge');
  assert.equal(far.y, MAP_PX - VIEW_H, 'clamped to the bottom content edge');
});

test('content smaller than the viewport is centered, not scrolled (no follow when it all fits)', () => {
  const smallMax = 6 * STEP - GAP; // content [0, smallMax) is smaller than VIEW_H and VIEW_W
  const cam = computeDungeonCamera({
    playerX: tileCenter(1), playerY: tileCenter(1),
    contentMinX: 0, contentMaxX: smallMax, contentMinY: 0, contentMaxY: smallMax,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN, prevX: 0, prevY: 0
  });
  assert.equal(cam.x, (smallMax - VIEW_W) / 2, 'sub-viewport content is centered horizontally regardless of player position');
  assert.equal(cam.y, (smallMax - VIEW_H) / 2, 'sub-viewport content is centered vertically');
});

test('the camera clamps to the FLOOR content box, not the full map (offset edges are reachable)', () => {
  // The explorable content does not start at the map origin: floor bbox occupies tiles 5..30,
  // so the scroll bounds are an offset window inside the larger map. The outermost reachable
  // tile must bring that content edge to the viewport edge (this is the seed-robust edge fix).
  const cMinX = 5 * STEP;
  const cMaxX = 30 * STEP + (STEP - GAP); // right edge of tile 30
  const bounds = { contentMinX: cMinX, contentMaxX: cMaxX, contentMinY: cMinX, contentMaxY: cMaxX };
  const atRight = computeDungeonCamera({
    playerX: tileCenter(30), playerY: tileCenter(30), ...bounds,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN, prevX: 0, prevY: 0
  });
  assert.equal(atRight.x, cMaxX - VIEW_W, 'the right content edge is reached from the rightmost floor tile');
  assert.equal(atRight.y, cMaxX - VIEW_H, 'the bottom content edge is reached from the bottommost floor tile');
  const atLeft = computeDungeonCamera({
    playerX: tileCenter(5), playerY: tileCenter(5), ...bounds,
    viewW: VIEW_W, viewH: VIEW_H, marginX: MARGIN, marginY: MARGIN, prevX: 99999, prevY: 99999
  });
  assert.equal(atLeft.x, cMinX, 'the left content edge (not 0) is reached from the leftmost floor tile');
  assert.equal(atLeft.y, cMinX, 'the top content edge (not 0) is reached from the topmost floor tile');
});

// ---- reframe on a viewport resize: hold the player, do not re-center (the combat-shake desync) ----
// Mid-combat the HUD row reflows as the turn/HP/MP text widens; that resizes the map column and
// changes the tile px, firing the grid ResizeObserver. Re-centering on that resize yanks an
// off-center player into the middle of the screen — the reported "self jumps when I attack".

test('a resize holds the player at its framed position instead of re-centering it (no jump)', () => {
  // Before the reflow: the player has walked east and is held at the right deadzone edge (so it is
  // off-center on screen — the exact state that makes a re-center visible).
  const beforeCell = computeDungeonCellSize({ viewW: VIEW_W, viewH: VIEW_H, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  const beforeStep = beforeCell + GAP;
  const beforeMargin = computeFollowMargin({ visionRadius: R, step: beforeStep, cell: beforeCell, viewSize: VIEW_W });
  const before = computeDungeonCamera({
    playerX: 17 * beforeStep + beforeCell / 2, playerY: 10 * beforeStep + beforeCell / 2,
    contentMinX: 0, contentMaxX: 40 * beforeStep - GAP, contentMinY: 0, contentMaxY: 40 * beforeStep - GAP,
    viewW: VIEW_W, viewH: VIEW_H, marginX: beforeMargin, marginY: beforeMargin, prevX: 0, prevY: 0
  });
  const beforeScreenX = (17 * beforeStep + beforeCell / 2) - before.x;
  assert.ok(Math.abs(beforeScreenX - (VIEW_W - beforeMargin)) < 1e-6, 'precondition: the player sits off-center at the right follow margin');
  // The player's framed position as a fraction of each axis (what a reframe must preserve).
  const frac = { x: beforeScreenX / VIEW_W, y: ((10 * beforeStep + beforeCell / 2) - before.y) / VIEW_H };

  // The HUD grows one row: the map viewport keeps its width but loses height, so the tile px change.
  const afterH = 470;
  const afterCell = computeDungeonCellSize({ viewW: VIEW_W, viewH: afterH, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  assert.notEqual(afterCell, beforeCell, 'the reflow actually changes the tile size (otherwise there is nothing to mishandle)');
  const afterStep = afterCell + GAP;
  const playerX = 17 * afterStep + afterCell / 2;
  const playerY = 10 * afterStep + afterCell / 2;
  const bounds = { contentMinX: 0, contentMaxX: 40 * afterStep - GAP, contentMinY: 0, contentMaxY: 40 * afterStep - GAP };

  // The fix: reframe holds the player's screen fraction. Width is unchanged here, so the player's
  // horizontal screen position is preserved to the pixel — no horizontal jump at all.
  const reframed = reframeDungeonCamera({ playerX, playerY, fracX: frac.x, fracY: frac.y, ...bounds, viewW: VIEW_W, viewH: afterH });
  assert.ok(Math.abs((playerX - reframed.x) - beforeScreenX) < 1e-6, 'reframe keeps the player exactly where it was on screen (no horizontal jump)');
  // Height shrank, so the vertical shift is bounded by the viewport height change — not a yank to center.
  const reframedShiftY = Math.abs((playerY - reframed.y) - ((10 * beforeStep + beforeCell / 2) - before.y));
  assert.ok(reframedShiftY <= (VIEW_H - afterH), 'the vertical shift stays within the viewport height change');

  // Re-centering on a resize (what the reframe must NOT do) would put the player at mid-screen.
  const centeredScreenX = VIEW_W / 2;
  assert.ok(Math.abs(centeredScreenX - beforeScreenX) > 200, 'centering would throw the player far across the screen — the desync the reframe removes');
});

test('repeated reframes converge: once a reframe holds the player, further reflows do not move it', () => {
  const cellA = computeDungeonCellSize({ viewW: VIEW_W, viewH: VIEW_H, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  const stepA = cellA + GAP;
  const bounds = (step) => ({ contentMinX: 0, contentMaxX: 40 * step - GAP, contentMinY: 0, contentMaxY: 40 * step - GAP });
  // Player off-center, framed at a fraction.
  const frac = { x: 0.72, y: 0.4 };
  const playerA = { x: 17 * stepA + cellA / 2, y: 10 * stepA + cellA / 2 };
  const camA = reframeDungeonCamera({ playerX: playerA.x, playerY: playerA.y, fracX: frac.x, fracY: frac.y, ...bounds(stepA), viewW: VIEW_W, viewH: VIEW_H });
  const screenAx = playerA.x - camA.x;
  const fracAfter = { x: (playerA.x - camA.x) / VIEW_W, y: (playerA.y - camA.y) / VIEW_H };

  // A second reflow with the SAME viewport reframes again from the re-measured fraction: the
  // player must not drift (this is why "撃ち続けるとだんだんズレなくなる" — it settles, not oscillates).
  const camB = reframeDungeonCamera({ playerX: playerA.x, playerY: playerA.y, fracX: fracAfter.x, fracY: fracAfter.y, ...bounds(stepA), viewW: VIEW_W, viewH: VIEW_H });
  assert.ok(Math.abs((playerA.x - camB.x) - screenAx) < 1e-6, 'the player does not drift horizontally across repeated reframes');
  assert.ok(Math.abs((playerA.y - camB.y) - (playerA.y - camA.y)) < 1e-6, 'the player does not drift vertically across repeated reframes');
});

// The reframe anchor is read LIVE from the rendered rects (playerViewportFraction), so a resize
// that fires while a follow pan is still animating holds the player where it is ACTUALLY drawn —
// not the pan's target. This is the mid-transition timing path that a stored target fraction missed.
test('a resize mid follow-pan reframes from the displayed player position, not the pan target', () => {
  const viewW = VIEW_W;
  const afterH = 470; // a HUD row reflow shrank the height (and so the tile size) this frame
  const afterCell = computeDungeonCellSize({ viewW, viewH: afterH, gap: GAP, targetCells: TARGET_CELLS, cellMin: CELL_MIN, cellMax: CELL_MAX });
  const afterStep = afterCell + GAP;
  const playerX = 17 * afterStep + afterCell / 2;
  const playerY = 10 * afterStep + afterCell / 2;
  const bounds = { contentMinX: 0, contentMaxX: 40 * afterStep - GAP, contentMinY: 0, contentMaxY: 40 * afterStep - GAP };

  // The follow pan was heading to center the player (target ≈ 0.5), but at the instant the resize
  // fires the player is STILL drawn near the right edge (mid-pan). The live rects show ~0.78/0.62.
  const viewportRect = { left: 0, top: 0, width: viewW, height: afterH };
  const displayedX = 0.78 * viewW;
  const displayedY = 0.62 * afterH;
  const playerRect = { left: displayedX - afterCell / 2, top: displayedY - afterCell / 2, width: afterCell, height: afterCell };
  const frac = playerViewportFraction({ playerRect, viewportRect });
  assert.ok(Math.abs(frac.x - 0.78) < 1e-9 && Math.abs(frac.y - 0.62) < 1e-9, 'the fraction is read from the displayed rect, not a target');

  const reframed = reframeDungeonCamera({ playerX, playerY, fracX: frac.x, fracY: frac.y, ...bounds, viewW, viewH: afterH });
  const reframedScreenX = playerX - reframed.x;
  const reframedScreenY = playerY - reframed.y;
  // It holds the DISPLAYED position to the pixel (no jump) and does NOT snap to the pan's mid target.
  assert.ok(Math.abs(reframedScreenX - displayedX) < 1e-6, 'horizontal: holds the actually-displayed position');
  assert.ok(Math.abs(reframedScreenY - displayedY) < 1e-6, 'vertical: holds the actually-displayed position');
  assert.ok(Math.abs(reframedScreenX - viewW / 2) > 200, 'it did NOT collapse to the centered pan target');
});

// ---- self-action animation-state race: anchor on the DISPLAYED (mid-slide) center ----
// When the player moves and then casts/attacks before the 160ms tile slide finishes, the engine's
// new event carries the FINAL logical tile while the token is still drawn mid-slide. A reframe (or
// an effect origin) keyed on the final tile jumps a half-tile ahead of the visible token; keying on
// the displayed center keeps everything on the token. (Upstream investigation worker-8, deterministic.)

test('rescaleBoardPx keeps a mid-slide point at its tile fraction across a tile-size change', () => {
  const fromCell = 48; // a token halfway through a 16->17 slide sits at tile 16.5
  const px = 16.5 * (fromCell + GAP) + fromCell / 2;
  const toCell = 52;
  const out = rescaleBoardPx({ px, fromCell, toCell, gap: GAP });
  assert.ok(Math.abs(out - (16.5 * (toCell + GAP) + toCell / 2)) < 1e-9, 'the mid-slide tile fraction (16.5) is preserved under the new cell');
  const logicalDestination = 17 * (toCell + GAP) + toCell / 2;
  assert.ok(Math.abs(out - logicalDestination) > 1, 'it is the half-slid point, not the destination tile center');
});

test('a resize during the player tile-slide anchors on the displayed center, not the final tile (no half-tile jump)', () => {
  const cell = 48;
  const stepLocal = cell + GAP; // 49
  const tileCenterLocal = (n) => n * stepLocal + cell / 2;
  const target = tileCenterLocal(17); // 857 — the engine's final logical tile this turn
  const displayed = (tileCenterLocal(16) + target) / 2; // 832.5 — token halfway through 16->17
  const viewW = 900;
  const camBefore = 120; // the follow camera currently in effect
  const displayedScreenX = displayed - camBefore; // 712.5 — where the token is drawn on screen
  const fracX = displayedScreenX / viewW;
  const bounds = { contentMinX: 0, contentMaxX: 40 * stepLocal - GAP, contentMinY: 0, contentMaxY: 40 * stepLocal - GAP };

  // FIX: anchor on the displayed (mid-slide) center, re-expressed into the (here unchanged) cell.
  const anchorX = rescaleBoardPx({ px: displayed, fromCell: cell, toCell: cell, gap: GAP });
  const fixed = reframeDungeonCamera({ playerX: anchorX, playerY: tileCenterLocal(10), fracX, fracY: 0.5, ...bounds, viewW, viewH: 470 });
  // The token is at `displayed` board-px this instant; the reframe must leave it on screen unmoved.
  assert.ok(Math.abs((displayed - fixed.x) - displayedScreenX) < 1e-6, 'no jump: the visible token does not move when the reframe commits');

  // BUG (anchoring on the final logical tile) jumps the token by the slide remainder.
  const buggy = reframeDungeonCamera({ playerX: target, playerY: tileCenterLocal(10), fracX, fracY: 0.5, ...bounds, viewW, viewH: 470 });
  const buggyJump = (displayed - buggy.x) - displayedScreenX;
  assert.ok(Math.abs(buggyJump - -24.5) < 1e-6, 'the final-tile anchor jumps the token by the 24.5px half-tile slide remainder (the investigation case)');
});

// ---- a cell-changing reframe: snap the tokens with the tiles, hold a stationary player put ----
// When the tile size actually changes (a genuine viewport resize), the CSS-grid tiles resize at
// once but a token's transform would slide over 0.16s — a tile-vs-token lag at the switch. The fix
// snaps the tokens to the new cell in the same frame (so they sit on their tile centers) and anchors
// the camera on the player's logical tile, held at its current screen fraction (no jump).

test('a cell-changing reframe keeps a stationary player put and the token aligned with its tile', () => {
  const playerTile = 17;
  const fromCell = 54;
  const fromStep = fromCell + GAP;
  const displayedOld = playerTile * fromStep + fromCell / 2; // stationary: displayed == logical
  const camOld = 200;
  const viewW = 900;
  const screenX = displayedOld - camOld;
  const fracX = screenX / viewW;

  // The dock/stage resized smaller: the cell shrinks. layoutDungeonBoard recomputes playerX from the
  // logical tile under the NEW cell (and snaps the token there), so the camera anchors on that.
  const toCell = 48;
  const toStep = toCell + GAP;
  const playerLogicalNew = playerTile * toStep + toCell / 2;
  const bounds = { contentMinX: 0, contentMaxX: 40 * toStep - GAP, contentMinY: 0, contentMaxY: 40 * toStep - GAP };

  const cam = reframeDungeonCamera({ playerX: playerLogicalNew, playerY: playerLogicalNew, fracX, fracY: fracX, ...bounds, viewW, viewH: 470 });
  assert.ok(Math.abs((playerLogicalNew - cam.x) - screenX) < 1e-6, 'the stationary player keeps its exact screen position across the cell change (no jump)');

  // The snapped token sits on its tile center under the new cell (tiles + token use the same cell
  // math), and an integer logical tile rescales to exactly that center — they move together.
  assert.equal(playerLogicalNew, playerTile * toStep + toCell / 2, 'the snapped token sits exactly on its tile center under the new cell');
  assert.ok(Math.abs(rescaleBoardPx({ px: displayedOld, fromCell, toCell, gap: GAP }) - playerLogicalNew) < 1e-9, 'an integer tile rescales to its tile center under the new cell (token follows the tile)');
});

// ---- structural wiring: the camera is actually mounted in the runtime ----

test('the dungeon runtime mounts the clipping viewport + deadzone camera', async () => {
  const js = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');

  // app.js imports and uses the pure camera math, and drives the board transform.
  assert.match(js, /import \{ computeDungeonCellSize, computeFollowMargin, computeDungeonCamera, reframeDungeonCamera, playerViewportFraction, rescaleBoardPx \} from '\.\/dungeonCamera\.js'/, 'app.js imports the camera math');
  assert.match(js, /function renderDungeonGrid\(view\)[\s\S]*className = 'dn-viewport'[\s\S]*className = 'dn-board'/, 'the board is wrapped in a clipping viewport');
  assert.match(js, /function layoutDungeonBoard\(view, \{ mode \}\)[\s\S]*computeDungeonCellSize\([\s\S]*computeFollowMargin\([\s\S]*computeDungeonCamera\(/, 'layoutDungeonBoard sizes the cell, the margin, and the camera');
  // The cell is sized from a FIXED target cell count (vision/content-independent scale), while the vision
  // radius now feeds only the follow margin — so one window size gives one constant, readable scale.
  assert.match(js, /const DN_TARGET_CELLS = \d+;/, 'a fixed target cell count constant drives the scale');
  assert.match(js, /computeDungeonCellSize\(\{ viewW, viewH, gap, targetCells: DN_TARGET_CELLS, cellMin: DN_CELL_MIN, cellMax: DN_CELL_MAX \}\)/, 'the cell is sized from the fixed target count, not the vision radius');
  assert.match(js, /computeFollowMargin\(\{ visionRadius: r, step, cell, viewSize: viewW \}\)/, 'the vision radius still drives the follow margin');
  assert.match(js, /const transform = `translate\(\$\{-camera\.x\}px, \$\{-camera\.y\}px\)`/, 'the camera offset translates the board');
  assert.match(js, /new ResizeObserver\(\(\) => \{[\s\S]*layoutDungeonBoard\(currentDungeonView, \{ mode: 'reframe' \}\)/, 'a viewport resize reframes the camera (holds the player, no re-center)');
  // The reframe anchor is read from the LIVE rendered rects (player fraction + board-px center), and
  // the center is re-expressed into the new tile size via rescaleBoardPx — so a resize during a tile
  // slide holds the displayed (mid-slide) position, never the final logical tile.
  assert.match(js, /function measureDungeonReframeAnchor\(viewport, board\)[\s\S]*getBoundingClientRect\(\)[\s\S]*playerViewportFraction\(\{[\s\S]*boardCenterX[\s\S]*boardCenterY/, 'reframe measures the live player fraction + board-px center');
  assert.match(js, /mode === 'reframe' \? measureDungeonReframeAnchor\(viewport, board\) : null/, 'the live measurement is taken before the layout changes the tile size');
  assert.match(js, /rescaleBoardPx\(\{ px: reframeAnchor\.boardCenterX, fromCell: reframeFromCell, toCell: cell, gap \}\)/, 'the displayed center is re-expressed into the new tile size (not the logical tile)');
  // When the cell actually changes, the tokens are snapped to the new size in the same frame as the
  // CSS-grid tiles (no 0.16s slide lag), and the camera anchors on the player's logical tile.
  assert.match(js, /mode === 'reframe' && cell !== reframeFromCell\) \{[\s\S]*snapDungeonEntitiesToCell\(grid\)/, 'a cell-changing reframe snaps the tokens with the tiles');
  assert.match(js, /function snapDungeonEntitiesToCell\(grid\)[\s\S]*node\.style\.transition = 'none'[\s\S]*node\.style\.transition = ''/, 'the snap suppresses the transform transition for one reflow so tokens commit at the new cell instantly');
  // The combat-effect origin is the entity ACTUALLY drawn at the event tile (mid-slide), resolved at
  // spawn time, so a cast/melee fired during the actor's slide shoots from the visible token.
  assert.match(js, /function dungeonEntityDisplayedCenter\(x, y, board\)[\s\S]*getBoundingClientRect\(\)/, 'effect origin reads the live entity rect at the event tile');
  assert.match(js, /const origin = \(x, y\) => dungeonEntityDisplayedCenter\(x, y, board\) \?\? \{ x: center\(x\), y: center\(y\) \}/, 'effect endpoints use the displayed entity center, falling back to the logical tile');
  assert.match(js, /const from = origin\(event\.from\.x, event\.from\.y\)[\s\S]*const to = origin\(event\.to\.x, event\.to\.y\)/, 'spawnDungeonEffect originates from the displayed actor/target');

  // CSS: the viewport clips and the board is the translated camera layer.
  assert.match(css, /\.dn-viewport \{[\s\S]*overflow: hidden/, 'the viewport clips the board');
  assert.match(css, /\.dn-board \{[\s\S]*position: absolute[\s\S]*transition: transform/, 'the board is absolutely placed and transitions its transform (the camera pan)');
  assert.match(css, /\.dungeon-grid \{[\s\S]*overflow: hidden/, 'the framed grid clips its inner viewport');
});

// The action log is a FIXED-height panel (not max-height), so a growing log scrolls internally
// instead of taller — the dock height, the stage height, and so the tile size (`--dn-cell`) stay
// constant turn to turn (no log-driven reframe).
test('the dungeon action log reserves a fixed height and scrolls internally (content does not resize the dock)', async () => {
  const css = await readFile(path.join(publicRoot, 'style.css'), 'utf8');
  const logRule = css.match(/\.dungeon-log \{[\s\S]*?\}/);
  assert.ok(logRule, '.dungeon-log rule exists');
  assert.match(logRule[0], /height:\s*132px/, 'the log has a fixed height so its content cannot grow the dock');
  assert.doesNotMatch(logRule[0], /max-height/, 'the log uses a fixed height, not max-height (which would grow with content up to the cap)');
  assert.match(logRule[0], /overflow-y:\s*auto/, 'the log scrolls internally so past turns are still readable');
});
