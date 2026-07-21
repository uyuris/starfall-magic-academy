// Pure layout math for the dungeon (実践) map: tile size, the follow margin, and the
// deadzone camera offset. These hold no DOM reference — app.js measures the viewport and
// feeds the numbers in, then applies the result to `--dn-cell` and the board transform — so
// the camera/scale/boundary logic is unit-testable headless.
//
// The cell is sized from the viewport alone (a fixed target cell count, vision-independent) so the scale
// is constant at one window size. The follow margin — where the camera starts scrolling — is still the
// vision radius, and the camera holds the player out of that margin: when the lit box fits the window the
// lit area sits fully on-screen as the camera begins to follow, and when a large vision or small window
// makes it exceed the viewport the deadzone follow + content clamp keep the player framed instead.

// Tile size (px, including the inter-cell gap in its budget) sized from the viewport ALONE: a fixed
// target cell count fit into the SMALLER viewport axis, clamped to a readable band. It is deliberately
// independent of the vision radius and of any HUD / item-region content, so at one window size the scale
// is constant — a run that raises vision, a deeper floor, or a dock/item panel toggling never rezooms the
// map (the "大きくなったり小さくなったり" the player reported). When the vision box then exceeds the window,
// the deadzone-follow camera + content clamp carry it (full visibility is not a dungeon requirement — the
// player asked for the largest readable tiles, not the whole lit box on-screen). Outside the band the clamp
// wins: a big window caps the cell (more map shown), a small one floors it (icons stay legible).
export function computeDungeonCellSize({ viewW, viewH, gap, targetCells, cellMin, cellMax }) {
  const rawCell = Math.min(viewW, viewH) / targetCells - gap;
  return Math.max(cellMin, Math.min(cellMax, rawCell));
}

// The follow margin (px from a viewport edge where the camera starts scrolling). The vision
// range reaches r tiles out from the player's tile, so the outermost visible tile's far EDGE
// is r*step + cell/2 from the player's tile center: holding the player that far from the
// viewport edge lands the full lit tile (edge, not center) exactly at the edge as follow
// begins. Capped at just under half the viewport so a small window keeps a positive deadzone
// instead of inverting into a hard center-lock (which would make the player jitter every step).
export function computeFollowMargin({ visionRadius, step, cell, viewSize }) {
  return Math.min(visionRadius * step + cell / 2, Math.max(0, (viewSize - step) / 2));
}

// Clamps a camera axis to the scrollable CONTENT bounds [contentMin, contentMax] (px). When the
// content is smaller than the viewport it is centered; otherwise the offset is clamped so the
// content never scrolls past either content edge.
function clampCameraAxis(cam, contentMin, contentMax, viewSize) {
  const content = contentMax - contentMin;
  if (content <= viewSize) return (contentMin + contentMax - viewSize) / 2;
  return Math.max(contentMin, Math.min(cam, contentMax - viewSize));
}

// Deadzone follow camera. Returns the board scroll offset {x, y} (px) whose negation translates the
// board inside the viewport. While the player stays inside the central deadzone the offset is
// unchanged (only the player moves); at the deadzone edge it scrolls just enough to hold the player
// there; the result is clamped to the CONTENT bounds — the explorable area (the floor bounding box
// plus its bordering wall), NOT the full map. Clamping means that from the outermost reachable floor
// tile the camera reaches the content edge on every axis and seed (the all-wall rows beyond the
// outermost rooms are never scrolled into emptiness); an axis whose content is smaller than the
// viewport is centered. `prevX`/`prevY` seed the deadzone: a move passes the previous camera so the
// follow continues from it, and a fresh-board entry passes the player-centred offset
// (playerX - viewW/2, playerY - viewH/2) so the entry frame is the SAME centred-then-clamped result
// the follow holds — entry and movement obey one camera rule, so the first step never jumps.
export function computeDungeonCamera({
  playerX, playerY, contentMinX, contentMaxX, contentMinY, contentMaxY,
  viewW, viewH, marginX, marginY, prevX, prevY
}) {
  let camX = prevX;
  let camY = prevY;
  const screenX = playerX - camX;
  const screenY = playerY - camY;
  if (screenX < marginX) camX = playerX - marginX;
  else if (screenX > viewW - marginX) camX = playerX - (viewW - marginX);
  if (screenY < marginY) camY = playerY - marginY;
  else if (screenY > viewH - marginY) camY = playerY - (viewH - marginY);
  camX = clampCameraAxis(camX, contentMinX, contentMaxX, viewW);
  camY = clampCameraAxis(camY, contentMinY, contentMaxY, viewH);
  return { x: camX, y: camY };
}

// Reframe the camera when the viewport changes size (a window/orientation resize, or — the case
// that bites mid-combat — a HUD row reflowing as the turn/HP/MP text widens, which resizes the
// map column and changes the tile px). It holds the player at the SAME relative screen position
// it already had (its fraction of each viewport axis), then clamps to content. Centering on every
// resize instead would yank an off-center player into the middle of the screen each time the HUD
// reflowed — the "self jumps when I attack" desync; preserving the fraction keeps the player put
// (the map rescales a hair around them) so a resize never moves the player off its framed spot.
// `fracX`/`fracY` are the player's previous on-screen position divided by the viewport size.
export function reframeDungeonCamera({
  playerX, playerY, fracX, fracY,
  contentMinX, contentMaxX, contentMinY, contentMaxY, viewW, viewH
}) {
  const camX = clampCameraAxis(playerX - fracX * viewW, contentMinX, contentMaxX, viewW);
  const camY = clampCameraAxis(playerY - fracY * viewH, contentMinY, contentMaxY, viewH);
  return { x: camX, y: camY };
}

// The player token's CURRENT on-screen center as a fraction of the viewport, from measured DOM
// rects. The reframe source MUST be read live (not a stored target) so it reflects where the
// player is actually drawn this frame — including a follow pan or a tile slide still mid-flight.
// A resize that fires mid-transition then preserves the real displayed frame, not the place the
// pan was heading, so no jump can slip through between turns.
export function playerViewportFraction({ playerRect, viewportRect }) {
  return {
    x: (playerRect.left + playerRect.width / 2 - viewportRect.left) / viewportRect.width,
    y: (playerRect.top + playerRect.height / 2 - viewportRect.top) / viewportRect.height
  };
}

// Re-express a board-pixel position measured under one tile size into the equivalent position under
// another, via its cell-independent tile coordinate (`(px - cell/2) / (cell + gap)`). A mid-slide
// entity sits at a FRACTIONAL tile (e.g. 16.5 halfway through a 16→17 step); this keeps that exact
// visual point fixed when a resize changes the tile size, so a reframe anchors on where the entity
// is actually drawn — not its final logical tile (which mixes a half-slid token with its
// destination and jumps the view a half-tile, then drifts back as the slide finishes).
export function rescaleBoardPx({ px, fromCell, toCell, gap }) {
  const tile = (px - fromCell / 2) / (fromCell + gap);
  return tile * (toCell + gap) + toCell / 2;
}
