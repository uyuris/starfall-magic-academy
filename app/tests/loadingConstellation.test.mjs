import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOADING_CONSTELLATION_SKY_BAND,
  buildLoadingConstellationEdges,
  buildLoadingConstellationNodes,
  createLoadingConstellation
} from '../public/loadingConstellation.js';

test('buildLoadingConstellationEdges traces a single polyline (count-1 ordered segments, deterministic)', () => {
  const edges = buildLoadingConstellationEdges(14);
  assert.equal(edges.length, 13);
  // A polyline: edge e connects node e→e+1, so edge e shares its end node with edge e+1's start node.
  for (let e = 0; e < edges.length; e += 1) assert.deepEqual(edges[e], [e, e + 1]);
  assert.deepEqual(buildLoadingConstellationEdges(14), edges);
});

test('buildLoadingConstellationEdges / Nodes fail-fast on an invalid count (no default-value fallback)', () => {
  for (const bad of [undefined, null, 0, -1, 14.5, '14', NaN]) {
    assert.throws(() => buildLoadingConstellationEdges(bad), /loading constellation requires a positive integer node count/);
    assert.throws(() => buildLoadingConstellationNodes(800, 450, bad), /loading constellation requires a positive integer node count/);
  }
});

test('buildLoadingConstellationNodes lays a deterministic in-canvas figure (no RNG)', () => {
  const a = buildLoadingConstellationNodes(800, 450, 14);
  const b = buildLoadingConstellationNodes(800, 450, 14);
  assert.equal(a.length, 14);
  assert.deepEqual(a, b);
  for (const node of a) {
    assert.ok(node.x >= 0 && node.x <= 800, `x in canvas: ${node.x}`);
    assert.ok(node.y >= 0 && node.y <= 450, `y in canvas: ${node.y}`);
    assert.ok(node.radius > 0);
  }
  // Left→right progression: the meander advances horizontally so consecutive stars stay near each other.
  for (let i = 1; i < a.length; i += 1) assert.ok(a[i].x > a[i - 1].x, `x advances at ${i}`);
});

test('buildLoadingConstellationNodes confines every node to the upper sky band (lines never reach the bridge/foreground)', () => {
  const { top, bottom } = LOADING_CONSTELLATION_SKY_BAND;
  assert.ok(top >= 0 && top < bottom && bottom <= 1, `sky band is a valid upper inset: ${JSON.stringify(LOADING_CONSTELLATION_SKY_BAND)}`);
  for (const [width, height] of [[800, 450], [1200, 820], [1458, 656]]) {
    const nodes = buildLoadingConstellationNodes(width, height, 14);
    for (const node of nodes) {
      assert.ok(node.y >= top * height, `node y above the sky-band top: ${node.y} >= ${top * height} (h=${height})`);
      assert.ok(node.y <= bottom * height, `node y within the sky-band bottom: ${node.y} <= ${bottom * height} (h=${height})`);
    }
    // Still a meander, not a flat line collapsed onto one edge: the band is actually used.
    const ys = nodes.map((n) => n.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    assert.ok(spread > 0.1 * height, `figure meanders within the band rather than collapsing flat: spread ${spread} (h=${height})`);
  }
});

test('createLoadingConstellation fail-fasts on an invalid nodeCount (no default-value fallback)', () => {
  for (const bad of [undefined, null, 0, -1, 14.5, '14', NaN]) {
    assert.throws(
      () => createLoadingConstellation({ canvasSelector: '#x', lineColorRgb: '198, 212, 255', nodeColorRgb: '224, 232, 255', nodeCount: bad }),
      /loading constellation requires a positive integer nodeCount/
    );
  }
});

// ── Controller behavior over a stubbed canvas (no jsdom in this suite) ────────────────────────────────
// A minimal 2D context + canvas + rAF harness so the progress accounting (reset-on-start, one-segment-per-event,
// cap at the figure's edge count, reduced-motion static draw) is observable through the canvas dataset.
function installStubDom({ reducedMotion }) {
  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  };
  const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
    strokeStyle: '', fillStyle: '', lineWidth: 0, shadowColor: '', shadowBlur: 0
  };
  const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, dataset: {}, getContext: () => ctx };
  globalThis.document = { querySelector: () => canvas };
  globalThis.window = { matchMedia: (q) => ({ matches: reducedMotion && q.includes('reduced-motion') }) };
  const rafQueue = [];
  let now = 0;
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};
  const pump = () => {
    const cbs = rafQueue.splice(0);
    now += 600; // > GROW_MS so a segment's grow completes in one pump
    for (const cb of cbs) cb(now);
  };
  const restore = () => Object.assign(globalThis, prev);
  return { canvas, pump, restore };
}

test('reduced-motion: start resets to zero, each progress event traces exactly one more segment, capped at the figure', () => {
  const { canvas, restore } = installStubDom({ reducedMotion: true });
  try {
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: '198, 212, 255', nodeColorRgb: '224, 232, 255', nodeCount: 14 });
    c.start();
    assert.equal(canvas.dataset.constellation, 'static', 'reduced-motion draws the figure statically');
    assert.equal(canvas.dataset.constellationRevealed, '0', 'a fresh loader shows no traced segments');
    // One segment per observed event.
    for (let i = 1; i <= 13; i += 1) {
      c.notifyProgress();
      assert.equal(canvas.dataset.constellationRevealed, String(i), `event ${i} traces segment ${i}`);
    }
    // 14 nodes → 13 edges; further events are a no-op (the figure is simply complete, no wrap-around).
    c.notifyProgress();
    c.notifyProgress();
    assert.equal(canvas.dataset.constellationRevealed, '13', 'events past a full figure do not advance it');
    // Reset on the next loader show.
    c.start();
    assert.equal(canvas.dataset.constellationRevealed, '0', 'showing the loader again resets the figure');
  } finally {
    restore();
  }
});

test('animated mode: dataset reports the animated figure and advances one segment per event once the grow completes', () => {
  const { canvas, pump, restore } = installStubDom({ reducedMotion: false });
  try {
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: '198, 212, 255', nodeColorRgb: '224, 232, 255', nodeCount: 14 });
    c.start();
    assert.equal(canvas.dataset.constellation, 'animated', 'normal motion animates the tracing');
    c.notifyProgress();
    pump(); pump(); // run the grow animation to completion
    assert.equal(canvas.dataset.constellationRevealed, '1', 'the first event traced one segment');
    c.notifyProgress();
    pump(); pump();
    assert.equal(canvas.dataset.constellationRevealed, '2', 'the second event traced the next segment');
  } finally {
    restore();
  }
});

test('progress before start / after stop is an inert no-op (no throw, nothing to advance)', () => {
  const { canvas, restore } = installStubDom({ reducedMotion: true });
  try {
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: '198, 212, 255', nodeColorRgb: '224, 232, 255', nodeCount: 14 });
    assert.doesNotThrow(() => c.notifyProgress(), 'progress before start must not throw');
    c.start();
    c.notifyProgress();
    assert.equal(canvas.dataset.constellationRevealed, '1');
    c.stop();
    assert.doesNotThrow(() => c.notifyProgress(), 'progress after stop must not throw');
  } finally {
    restore();
  }
});
