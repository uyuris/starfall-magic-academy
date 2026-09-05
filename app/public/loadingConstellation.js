// ── Loading constellation: a progress-driven silver line-drawing overlay ─────────────────────────────
// The loading screen already carries an ambient starfield (createStarfieldAmbient) that twinkles regardless of
// work. This overlay is the opposite: it advances ONLY when a real progress event is observed (notifyProgress),
// tracing one more silver segment across a session's figures each time. Each loader session picks 2 or 3 authored
// abstract patterns from the catalog below (deterministically, from the injected `random`), places them in
// non-overlapping horizontal slots inside the sky band, and draws them one segment at a time in figure order.
// prefers-reduced-motion draws each revealed segment statically. No new image assets: canvas lines over the
// existing night art.

// Authored abstract pattern catalog. Each pattern is declared in pattern-local normalized coordinates
// (x∈[0,1], y∈[0,1]); the slot placement layer maps them into the loader canvas's sky band. Nodes carry no
// per-node radius — the canvas draw picks a uniform silver radius so patterns share a look.
export const LOADING_CONSTELLATION_PATTERNS = [
  {
    id: 'triangle_bright',
    nodes: [[0.5, 0.10], [0.10, 0.90], [0.90, 0.90]],
    edges: [[0, 1], [1, 2], [2, 0]],
    drawOrder: [0, 1, 2],
  },
  {
    id: 'arrow_ascend',
    nodes: [[0.50, 0.95], [0.50, 0.30], [0.30, 0.50], [0.70, 0.50], [0.50, 0.10]],
    edges: [[0, 1], [1, 2], [1, 3], [1, 4]],
    drawOrder: [0, 1, 2, 3],
  },
  {
    id: 'chevron_double',
    nodes: [[0.05, 0.80], [0.30, 0.30], [0.55, 0.70], [0.75, 0.30], [0.95, 0.70], [0.55, 0.15]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [1, 5], [5, 3]],
    drawOrder: [0, 1, 2, 3, 4, 5],
  },
  {
    id: 'curve_arc',
    nodes: [[0.05, 0.85], [0.25, 0.55], [0.50, 0.30], [0.75, 0.55], [0.95, 0.85]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
    drawOrder: [0, 1, 2, 3],
  },
  {
    id: 'crown_five',
    nodes: [[0.10, 0.85], [0.30, 0.20], [0.50, 0.55], [0.70, 0.20], [0.90, 0.85]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
    drawOrder: [0, 1, 2, 3],
  },
  {
    id: 'wing_pair',
    nodes: [[0.50, 0.50], [0.25, 0.20], [0.05, 0.60], [0.75, 0.20], [0.95, 0.60], [0.50, 0.90]],
    edges: [[0, 1], [1, 2], [0, 3], [3, 4], [0, 5]],
    drawOrder: [0, 1, 2, 3, 4],
  },
  {
    id: 'lantern',
    nodes: [[0.50, 0.05], [0.50, 0.25], [0.20, 0.45], [0.50, 0.65], [0.80, 0.45], [0.50, 0.85], [0.50, 0.95]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1], [3, 5], [5, 6]],
    drawOrder: [0, 1, 2, 3, 4, 5, 6],
  },
  {
    id: 'serpent_wave',
    nodes: [[0.05, 0.55], [0.22, 0.20], [0.40, 0.55], [0.58, 0.20], [0.76, 0.55], [0.95, 0.20]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
    drawOrder: [0, 1, 2, 3, 4],
  },
  {
    id: 'constellation_l',
    nodes: [[0.20, 0.15], [0.20, 0.75], [0.55, 0.75], [0.85, 0.75]],
    edges: [[0, 1], [1, 2], [2, 3]],
    drawOrder: [0, 1, 2],
  },
  {
    id: 'cross_small',
    nodes: [[0.50, 0.50], [0.50, 0.10], [0.90, 0.50], [0.50, 0.90], [0.10, 0.50]],
    edges: [[0, 1], [0, 2], [0, 3], [0, 4]],
    drawOrder: [0, 1, 2, 3],
  },
];

// Fail-fast catalog validation at module import: id uniqueness, node arrays non-empty with in-range coordinates,
// edges reference valid nodes, drawOrder covers every edge exactly once. A malformed catalog is a broken build,
// not a cue to silently ignore a bad pattern.
(function validatePatternCatalog() {
  if (!Array.isArray(LOADING_CONSTELLATION_PATTERNS) || LOADING_CONSTELLATION_PATTERNS.length === 0) {
    throw new Error('loading constellation catalog must be a non-empty array');
  }
  const seenIds = new Set();
  for (const pattern of LOADING_CONSTELLATION_PATTERNS) {
    if (!pattern || typeof pattern !== 'object') {
      throw new Error(`loading constellation pattern must be an object, got ${JSON.stringify(pattern)}`);
    }
    const { id, nodes, edges, drawOrder } = pattern;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`loading constellation pattern id must be a non-empty string, got ${JSON.stringify(id)}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`loading constellation pattern id ${JSON.stringify(id)} is duplicated`);
    }
    seenIds.add(id);
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error(`loading constellation pattern ${id} nodes must be a non-empty array`);
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!Array.isArray(node) || node.length !== 2) {
        throw new Error(`loading constellation pattern ${id} node[${i}] must be a [x, y] pair`);
      }
      const [x, y] = node;
      if (!(Number.isFinite(x) && x >= 0 && x <= 1)) {
        throw new Error(`loading constellation pattern ${id} node[${i}].x out of range [0,1]: ${x}`);
      }
      if (!(Number.isFinite(y) && y >= 0 && y <= 1)) {
        throw new Error(`loading constellation pattern ${id} node[${i}].y out of range [0,1]: ${y}`);
      }
    }
    if (!Array.isArray(edges) || edges.length === 0) {
      throw new Error(`loading constellation pattern ${id} edges must be a non-empty array`);
    }
    for (let e = 0; e < edges.length; e += 1) {
      const edge = edges[e];
      if (!Array.isArray(edge) || edge.length !== 2) {
        throw new Error(`loading constellation pattern ${id} edges[${e}] must be a [a, b] pair`);
      }
      const [a, b] = edge;
      if (!Number.isInteger(a) || a < 0 || a >= nodes.length) {
        throw new Error(`loading constellation pattern ${id} edges[${e}][0] out of range: ${a}`);
      }
      if (!Number.isInteger(b) || b < 0 || b >= nodes.length) {
        throw new Error(`loading constellation pattern ${id} edges[${e}][1] out of range: ${b}`);
      }
      if (a === b) {
        throw new Error(`loading constellation pattern ${id} edges[${e}] connects a node to itself: ${a}`);
      }
    }
    if (!Array.isArray(drawOrder) || drawOrder.length !== edges.length) {
      throw new Error(`loading constellation pattern ${id} drawOrder length must equal edges length (${edges.length}), got ${drawOrder?.length}`);
    }
    const seenEdge = new Set();
    for (let i = 0; i < drawOrder.length; i += 1) {
      const idx = drawOrder[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= edges.length) {
        throw new Error(`loading constellation pattern ${id} drawOrder[${i}] out of range: ${idx}`);
      }
      if (seenEdge.has(idx)) {
        throw new Error(`loading constellation pattern ${id} drawOrder[${i}] repeats edge index ${idx}`);
      }
      seenEdge.add(idx);
    }
  }
})();

// The loading background (loading_night.jpg) is sky only in its upper band: the top holds the moon and open
// starfield, while the glowing celestial bridge/pathway and the hanging orreries fill the lower half from roughly
// mid-canvas down. The constellation figures are confined to that upper sky band so the traced silver lines never
// fall onto the bridge or foreground. `top`/`bottom` are canvas-height fractions.
export const LOADING_CONSTELLATION_SKY_BAND = { top: 0.08, bottom: 0.42 };

// Pattern index picker: consume the injected `random` to pull `count` distinct catalog indices via
// reservoir-style selection (Fisher-Yates on a fresh index array with `random()` in [0,1)). Same random output
// stream → same selection, so tests can pin behavior by injecting a deterministic sequence.
function pickPatternIndices(random, count) {
  const total = LOADING_CONSTELLATION_PATTERNS.length;
  if (!Number.isInteger(count) || count <= 0 || count > total) {
    throw new Error(`loading constellation figuresCount must be a positive integer <= ${total}, got ${JSON.stringify(count)}`);
  }
  const indices = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i -= 1) {
    const r = random();
    if (!(Number.isFinite(r) && r >= 0 && r < 1)) {
      throw new Error(`loading constellation random() must return a number in [0,1), got ${JSON.stringify(r)}`);
    }
    const j = Math.floor(r * (i + 1));
    const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
  }
  return indices.slice(0, count);
}

// Slot placement: N horizontal slots split the sky band evenly, each pattern is placed inside its slot with a
// small inset so adjacent figures do not touch. Slot assignment: given `count` slots, deterministically pick
// which slot each of the `count` figures takes by shuffling `[0..count-1]` with the same injected `random`.
function pickSlotIndices(random, count) {
  const slots = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const r = random();
    if (!(Number.isFinite(r) && r >= 0 && r < 1)) {
      throw new Error(`loading constellation random() must return a number in [0,1), got ${JSON.stringify(r)}`);
    }
    const j = Math.floor(r * (i + 1));
    const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp;
  }
  return slots;
}

// Map a pattern's local node coordinates into canvas pixels, confined to one slot of the sky band. The slot is
// a horizontal strip of the band: x spans an even fraction of the canvas width with a small inset, y spans the
// full sky band with the same inset applied vertically inside the band.
const SLOT_INSET_X = 0.02; // fraction of a slot's width
const SLOT_INSET_Y = 0.05; // fraction of the sky band height

export function placePatternNodes(pattern, { canvasWidth, canvasHeight, slotIndex, slotCount }) {
  if (!(canvasWidth > 0 && canvasHeight > 0)) {
    throw new Error(`loading constellation placement requires positive canvas size, got ${canvasWidth}x${canvasHeight}`);
  }
  if (!Number.isInteger(slotCount) || slotCount <= 0) {
    throw new Error(`loading constellation slotCount must be a positive integer, got ${JSON.stringify(slotCount)}`);
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slotCount) {
    throw new Error(`loading constellation slotIndex out of range [0,${slotCount}): ${JSON.stringify(slotIndex)}`);
  }
  const { top, bottom } = LOADING_CONSTELLATION_SKY_BAND;
  const slotW = canvasWidth / slotCount;
  const slotX0 = slotW * slotIndex;
  const insetX = slotW * SLOT_INSET_X;
  const bandH = (bottom - top) * canvasHeight;
  const insetY = bandH * SLOT_INSET_Y;
  const x0 = slotX0 + insetX;
  const x1 = slotX0 + slotW - insetX;
  const y0 = top * canvasHeight + insetY;
  const y1 = bottom * canvasHeight - insetY;
  const placed = pattern.nodes.map(([nx, ny]) => ({ x: x0 + (x1 - x0) * nx, y: y0 + (y1 - y0) * ny }));
  // Sky-band + canvas containment invariants (fail-fast; the placement math is closed so a violation is a bug).
  for (let i = 0; i < placed.length; i += 1) {
    const { x, y } = placed[i];
    if (!(x >= 0 && x <= canvasWidth)) {
      throw new Error(`loading constellation pattern ${pattern.id} node[${i}] x out of canvas after placement: ${x}`);
    }
    if (!(y >= top * canvasHeight - 1e-6 && y <= bottom * canvasHeight + 1e-6)) {
      throw new Error(`loading constellation pattern ${pattern.id} node[${i}] y out of sky band after placement: ${y}`);
    }
  }
  return placed;
}

export function createLoadingConstellation({ canvasSelector, lineColorRgb, nodeColorRgb, random }) {
  if (typeof canvasSelector !== 'string' || canvasSelector.length === 0) {
    throw new Error(`loading constellation requires a canvasSelector string, got ${JSON.stringify(canvasSelector)}`);
  }
  if (typeof lineColorRgb !== 'string' || lineColorRgb.length === 0) {
    throw new Error(`loading constellation requires a lineColorRgb string, got ${JSON.stringify(lineColorRgb)}`);
  }
  if (typeof nodeColorRgb !== 'string' || nodeColorRgb.length === 0) {
    throw new Error(`loading constellation requires a nodeColorRgb string, got ${JSON.stringify(nodeColorRgb)}`);
  }
  if (typeof random !== 'function') {
    throw new Error(`loading constellation requires a random() function (no Math.random fallback), got ${JSON.stringify(random)}`);
  }
  const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };
  const GROW_MS = 520;
  const NODE_RADIUS = 1.7;
  let canvasEl = null;
  let ctx = null;
  let width = 0;
  let height = 0;
  // A `figure` is { pattern, placedNodes, drawOrder (from the pattern), revealed }. `figures` is the whole
  // session's list in draw order. `totalEdges` is the sum of every figure's edge count; `revealedTotal` is how
  // many edges across the whole session have been traced so far.
  let figures = null;
  let totalEdges = 0;
  let revealedTotal = 0;
  let animFrame = null;

  function drawSegment(figure, edgeIndex, progress) {
    const [a, b] = figure.pattern.edges[edgeIndex];
    const from = figure.placedNodes[a];
    const to = figure.placedNodes[b];
    const tx = from.x + (to.x - from.x) * progress;
    const ty = from.y + (to.y - from.y) * progress;
    ctx.strokeStyle = `rgba(${lineColorRgb}, 0.72)`;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = `rgba(${lineColorRgb}, 0.6)`;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawNode(node) {
    ctx.fillStyle = `rgba(${nodeColorRgb}, 0.95)`;
    ctx.shadowColor = `rgba(${nodeColorRgb}, 0.8)`;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Draw the whole session state onto the single canvas. `newestProgress` is the animation progress for the
  // most-recently-added edge across all figures; every earlier edge draws at progress 1.
  function redraw(newestProgress) {
    ctx.clearRect(0, 0, width, height);
    let drawn = 0;
    for (const figure of figures) {
      const litNodes = new Set();
      for (let i = 0; i < figure.revealed; i += 1) {
        drawn += 1;
        const isNewest = drawn === revealedTotal;
        const progress = isNewest ? newestProgress : 1;
        const edgeIndex = figure.drawOrder[i];
        drawSegment(figure, edgeIndex, progress);
        const [a, b] = figure.pattern.edges[edgeIndex];
        litNodes.add(a);
        if (!isNewest || newestProgress >= 1) litNodes.add(b);
      }
      for (const idx of litNodes) drawNode(figure.placedNodes[idx]);
    }
    if (canvasEl) canvasEl.dataset.constellationRevealed = String(revealedTotal);
  }

  function animateNewest() {
    if (animFrame) cancelAnimationFrame(animFrame);
    let startTime = null;
    const step = (time) => {
      if (startTime === null) startTime = time;
      const progress = Math.min(1, (time - startTime) / GROW_MS);
      redraw(progress);
      if (progress < 1) {
        animFrame = requestAnimationFrame(step);
      } else {
        animFrame = null;
      }
    };
    animFrame = requestAnimationFrame(step);
  }

  return {
    start() {
      canvasEl = document.querySelector(canvasSelector);
      if (!canvasEl || typeof canvasEl.getContext !== 'function') {
        ctx = null;
        figures = null;
        return;
      }
      // Size from the laid-out canvas. A genuinely unlaid-out (zero-size) canvas is a visible no-op — this
      // decorative overlay does NOT fabricate a magic default size (no default-value fallback); notifyProgress
      // then no-ops because ctx/figures stay null.
      width = canvasEl.clientWidth || canvasEl.width;
      height = canvasEl.clientHeight || canvasEl.height;
      if (!width || !height) {
        ctx = null;
        figures = null;
        return;
      }
      canvasEl.width = width;
      canvasEl.height = height;
      ctx = canvasEl.getContext('2d');
      if (!ctx) return;
      // Loader-session shape: 2 or 3 figures, drawn from `random()`. The first random call picks the count so
      // downstream selection uses the remaining stream — a stable, replayable order for tests.
      const shapeRoll = random();
      if (!(Number.isFinite(shapeRoll) && shapeRoll >= 0 && shapeRoll < 1)) {
        throw new Error(`loading constellation random() must return a number in [0,1), got ${JSON.stringify(shapeRoll)}`);
      }
      const figuresCount = shapeRoll < 0.5 ? 2 : 3;
      const patternIndices = pickPatternIndices(random, figuresCount);
      const slotIndices = pickSlotIndices(random, figuresCount);
      figures = patternIndices.map((patternIndex, i) => {
        const pattern = LOADING_CONSTELLATION_PATTERNS[patternIndex];
        return {
          pattern,
          drawOrder: pattern.drawOrder,
          placedNodes: placePatternNodes(pattern, {
            canvasWidth: width,
            canvasHeight: height,
            slotIndex: slotIndices[i],
            slotCount: figuresCount,
          }),
          revealed: 0,
        };
      });
      totalEdges = figures.reduce((sum, f) => sum + f.pattern.edges.length, 0);
      revealedTotal = 0;
      if (animFrame) {
        cancelAnimationFrame(animFrame);
        animFrame = null;
      }
      ctx.clearRect(0, 0, width, height);
      // Observable mode + progress on the canvas dataset (same contract shape as the starfield ambient), so a
      // render harness / test can read whether the figure animates and how many segments have been traced.
      canvasEl.dataset.constellation = reducedMotion.matches ? 'static' : 'animated';
      canvasEl.dataset.constellationRevealed = '0';
    },
    notifyProgress() {
      // Only meaningful once started with a live canvas. Advance exactly one segment per observed event,
      // sequential across figures: fill figure[0] completely, then figure[1], etc. Events past the last edge
      // of the last figure are a no-op (the session is simply full), never a wrap-around.
      if (!ctx || !figures) return;
      if (revealedTotal >= totalEdges) return;
      let advanced = false;
      for (const figure of figures) {
        if (figure.revealed < figure.pattern.edges.length) {
          figure.revealed += 1;
          revealedTotal += 1;
          advanced = true;
          break;
        }
      }
      if (!advanced) return;
      if (reducedMotion.matches) {
        redraw(1);
        return;
      }
      animateNewest();
    },
    stop() {
      if (animFrame) {
        cancelAnimationFrame(animFrame);
        animFrame = null;
      }
      if (ctx) ctx.clearRect(0, 0, width, height);
      ctx = null;
      figures = null;
      totalEdges = 0;
      revealedTotal = 0;
    }
  };
}
