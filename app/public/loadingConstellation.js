// ── Loading constellation: a progress-driven silver line-drawing overlay ─────────────────────────────
// The loading screen already carries an ambient starfield (createStarfieldAmbient) that twinkles regardless of
// work. This overlay is the opposite: it advances ONLY when a real progress event is observed (notifyProgress),
// tracing one more silver segment between constellation stars each time. It resets every time the loader shows
// (start()), so the figure is drawn from nothing across exactly the events that land during that one wait — the
// wait being long does not fabricate progress, and no stall is ever inferred. prefers-reduced-motion draws each
// revealed segment statically (no grow animation). No new image assets: canvas lines over the existing night art.

// A single traced polyline through the nodes, so each progress event lights the next star-to-star segment and the
// figure is drawn one line at a time. count nodes → count-1 ordered edges.
export function buildLoadingConstellationEdges(count) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`loading constellation requires a positive integer node count, got ${JSON.stringify(count)}`);
  }
  const edges = [];
  for (let i = 0; i + 1 < count; i += 1) edges.push([i, i + 1]);
  return edges;
}

// The loading background (loading_night.jpg) is sky only in its upper band: the top holds the moon and open
// starfield, while the glowing celestial bridge/pathway and the hanging orreries fill the lower half from roughly
// mid-canvas down. The constellation nodes are confined to that upper sky band so the traced silver lines never
// fall onto the bridge or foreground. `top`/`bottom` are canvas-height fractions; the meander lives between them.
export const LOADING_CONSTELLATION_SKY_BAND = { top: 0.08, bottom: 0.42 };

// Deterministic node layout: a left→right meander (a vertical sine wave + a small deterministic break-up jitter)
// so consecutive nodes sit near each other and the traced polyline reads as a constellation crossing the sky
// rather than a tangle. The vertical meander is compressed into the sky band above so the figure stays in the
// open sky and never runs onto the bridge/foreground or off the canvas edge.
export function buildLoadingConstellationNodes(width, height, count) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`loading constellation requires a positive integer node count, got ${JSON.stringify(count)}`);
  }
  const { top: skyTop, bottom: skyBottom } = LOADING_CONSTELLATION_SKY_BAND;
  const bandCenter = (skyTop + skyBottom) / 2;
  const bandHalf = (skyBottom - skyTop) / 2;
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = (0.1 + 0.8 * t) * width;
    const wave = bandCenter + bandHalf * Math.sin(i * 1.15 + 0.6);
    const jitter = (((i * 37) % 13) / 13 - 0.5) * 0.05;
    const y = Math.min(skyBottom, Math.max(skyTop, wave + jitter)) * height;
    const radius = 1.4 + ((i * 7) % 5) / 5;
    nodes.push({ x, y, radius });
  }
  return nodes;
}

export function createLoadingConstellation({ canvasSelector, lineColorRgb, nodeColorRgb, nodeCount }) {
  // nodeCount is required and validated (no default-value fallback): a missing count is a broken consumer config,
  // not a cue to silently assume a figure size.
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
    throw new Error(`loading constellation requires a positive integer nodeCount, got ${JSON.stringify(nodeCount)}`);
  }
  const reducedMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };
  const edges = buildLoadingConstellationEdges(nodeCount);
  const GROW_MS = 520;
  let canvasEl = null;
  let ctx = null;
  let nodes = null;
  let width = 0;
  let height = 0;
  let revealed = 0;
  let animFrame = null;

  function drawSegment(edgeIndex, progress) {
    const [a, b] = edges[edgeIndex];
    const from = nodes[a];
    const to = nodes[b];
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
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function redraw(newestProgress) {
    ctx.clearRect(0, 0, width, height);
    for (let e = 0; e < revealed; e += 1) {
      const progress = e === revealed - 1 ? newestProgress : 1;
      drawSegment(e, progress);
    }
    // Light the star endpoints the drawn segments have reached (over the lines). The polyline shares node b of
    // edge e with node a of edge e+1, so lighting node a of every drawn segment plus the final endpoint once the
    // newest segment completes covers every reached star.
    for (let e = 0; e < revealed; e += 1) {
      drawNode(nodes[edges[e][0]]);
      if (e < revealed - 1 || newestProgress >= 1) drawNode(nodes[edges[e][1]]);
    }
    if (canvasEl) canvasEl.dataset.constellationRevealed = String(revealed);
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
        nodes = null;
        return;
      }
      // Size from the laid-out canvas. A genuinely unlaid-out (zero-size) canvas is a visible no-op — this
      // decorative overlay does NOT fabricate a magic default size (no default-value fallback); notifyProgress
      // then no-ops because ctx/nodes stay null.
      width = canvasEl.clientWidth || canvasEl.width;
      height = canvasEl.clientHeight || canvasEl.height;
      if (!width || !height) {
        ctx = null;
        nodes = null;
        return;
      }
      canvasEl.width = width;
      canvasEl.height = height;
      ctx = canvasEl.getContext('2d');
      if (!ctx) return;
      nodes = buildLoadingConstellationNodes(width, height, nodeCount);
      revealed = 0;
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
      // Only meaningful once started with a live canvas. Advance exactly one segment per observed event, capped at
      // the figure's edge count: events past a completed figure are a no-op (the constellation is simply full),
      // never a wrap-around or a fabricated extra step.
      if (!ctx || !nodes) return;
      if (revealed >= edges.length) return;
      revealed += 1;
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
      nodes = null;
      revealed = 0;
    }
  };
}
