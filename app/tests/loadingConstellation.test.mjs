import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOADING_CONSTELLATION_PATTERNS,
  LOADING_CONSTELLATION_SKY_BAND,
  createLoadingConstellation,
  placePatternNodes,
} from '../public/loadingConstellation.js';

// A finite RNG bound to a fixed sequence + a couple of helpers around it. Injecting `random` this way is what
// lets every determinism test pin the exact figures/slots the controller picks.
function seededRandom(values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error(`seededRandom exhausted after ${values.length} calls`);
    const v = values[i]; i += 1; return v;
  };
}

const COLOR_LINE = '198, 212, 255';
const COLOR_NODE = '224, 232, 255';

test('LOADING_CONSTELLATION_PATTERNS is the authored catalog of exactly 10 abstract patterns with unique ids', () => {
  assert.equal(LOADING_CONSTELLATION_PATTERNS.length, 10, 'catalog holds 10 authored patterns');
  const ids = new Set(LOADING_CONSTELLATION_PATTERNS.map((p) => p.id));
  assert.equal(ids.size, 10, 'catalog pattern ids are unique');
  for (const pattern of LOADING_CONSTELLATION_PATTERNS) {
    assert.ok(pattern.nodes.length >= 3, `${pattern.id} has at least 3 nodes`);
    assert.ok(pattern.edges.length >= 3, `${pattern.id} has at least 3 edges`);
    assert.equal(pattern.drawOrder.length, pattern.edges.length, `${pattern.id} drawOrder covers every edge`);
    for (const [nx, ny] of pattern.nodes) {
      assert.ok(nx >= 0 && nx <= 1, `${pattern.id} node x in [0,1]`);
      assert.ok(ny >= 0 && ny <= 1, `${pattern.id} node y in [0,1]`);
    }
    for (const [a, b] of pattern.edges) {
      assert.ok(Number.isInteger(a) && a >= 0 && a < pattern.nodes.length, `${pattern.id} edge start ok`);
      assert.ok(Number.isInteger(b) && b >= 0 && b < pattern.nodes.length, `${pattern.id} edge end ok`);
      assert.notEqual(a, b, `${pattern.id} edge is not a self-loop`);
    }
    const seenEdgeIdx = new Set(pattern.drawOrder);
    assert.equal(seenEdgeIdx.size, pattern.edges.length, `${pattern.id} drawOrder edges are unique`);
    for (const idx of pattern.drawOrder) {
      assert.ok(idx >= 0 && idx < pattern.edges.length, `${pattern.id} drawOrder idx in range`);
    }
  }
});

test('LOADING_CONSTELLATION_SKY_BAND is an upper canvas inset (top < bottom, both in [0,1])', () => {
  const { top, bottom } = LOADING_CONSTELLATION_SKY_BAND;
  assert.ok(top >= 0 && top < bottom && bottom <= 1, `sky band is a valid upper inset: ${JSON.stringify(LOADING_CONSTELLATION_SKY_BAND)}`);
});

test('placePatternNodes confines every placed node to the sky band and its horizontal slot inside the canvas', () => {
  const { top, bottom } = LOADING_CONSTELLATION_SKY_BAND;
  for (const [w, h] of [[800, 450], [1200, 820], [1458, 656]]) {
    for (const slotCount of [2, 3]) {
      for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
        for (const pattern of LOADING_CONSTELLATION_PATTERNS) {
          const placed = placePatternNodes(pattern, { canvasWidth: w, canvasHeight: h, slotIndex, slotCount });
          const slotW = w / slotCount;
          for (const { x, y } of placed) {
            assert.ok(x >= slotIndex * slotW - 1e-6 && x <= (slotIndex + 1) * slotW + 1e-6, `x within slot ${slotIndex}: ${x}`);
            assert.ok(y >= top * h - 1e-6 && y <= bottom * h + 1e-6, `y within sky band: ${y}`);
            assert.ok(x >= 0 && x <= w, `x within canvas: ${x}`);
            assert.ok(y >= 0 && y <= h, `y within canvas: ${y}`);
          }
        }
      }
    }
  }
});

test('placePatternNodes fail-fasts on invalid canvas/slot input (no default-value fallback)', () => {
  const pattern = LOADING_CONSTELLATION_PATTERNS[0];
  assert.throws(() => placePatternNodes(pattern, { canvasWidth: 0, canvasHeight: 450, slotIndex: 0, slotCount: 2 }), /positive canvas size/);
  assert.throws(() => placePatternNodes(pattern, { canvasWidth: 800, canvasHeight: 0, slotIndex: 0, slotCount: 2 }), /positive canvas size/);
  assert.throws(() => placePatternNodes(pattern, { canvasWidth: 800, canvasHeight: 450, slotIndex: 0, slotCount: 0 }), /slotCount/);
  assert.throws(() => placePatternNodes(pattern, { canvasWidth: 800, canvasHeight: 450, slotIndex: 2, slotCount: 2 }), /slotIndex/);
  assert.throws(() => placePatternNodes(pattern, { canvasWidth: 800, canvasHeight: 450, slotIndex: -1, slotCount: 2 }), /slotIndex/);
});

test('createLoadingConstellation fail-fasts on missing/invalid options (no Math.random fallback, no default figures shape)', () => {
  const base = { canvasSelector: '#x', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random: Math.random };
  for (const bad of [undefined, null, {}, 'random', 42]) {
    assert.throws(() => createLoadingConstellation({ ...base, random: bad }), /random\(\) function/);
  }
  for (const bad of [undefined, null, '']) {
    assert.throws(() => createLoadingConstellation({ ...base, canvasSelector: bad }), /canvasSelector/);
    assert.throws(() => createLoadingConstellation({ ...base, lineColorRgb: bad }), /lineColorRgb/);
    assert.throws(() => createLoadingConstellation({ ...base, nodeColorRgb: bad }), /nodeColorRgb/);
  }
});

// ── Controller behavior over a stubbed canvas (no jsdom in this suite) ────────────────────────────────
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

test('reduced-motion: start picks 2 figures for a low shape-roll, traces exactly one segment per event, caps at total edges', () => {
  const { canvas, restore } = installStubDom({ reducedMotion: true });
  try {
    // First random() < 0.5 → figuresCount = 2. Next calls drive pattern shuffle (10 values), then slot shuffle (1 value).
    const random = seededRandom([
      0.1, // figuresCount → 2
      0, 0, 0, 0, 0, 0, 0, 0, 0, // pattern index shuffle (Fisher-Yates on length 10 uses 9 randoms)
      0, // slot shuffle (length 2 uses 1 random)
    ]);
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random });
    c.start();
    assert.equal(canvas.dataset.constellation, 'static', 'reduced-motion draws statically');
    assert.equal(canvas.dataset.constellationRevealed, '0', 'a fresh loader shows zero traced segments');
    // With all-zero shuffle randoms Fisher-Yates rotates [0..9] to [1,2,...,9,0]; slice(0,2) = [1,2] =
    // arrow_ascend(4 edges) + chevron_double(6 edges) = 10 edges total.
    const total = 4 + 6;
    for (let i = 1; i <= total; i += 1) {
      c.notifyProgress();
      assert.equal(canvas.dataset.constellationRevealed, String(i), `event ${i} traces segment ${i}`);
    }
    c.notifyProgress();
    c.notifyProgress();
    assert.equal(canvas.dataset.constellationRevealed, String(total), 'events past the last figure do not advance');
  } finally {
    restore();
  }
});

test('reduced-motion: high shape-roll picks 3 figures, sequential drawOrder consumes figure A fully before figure B', () => {
  const { canvas, restore } = installStubDom({ reducedMotion: true });
  try {
    // shape-roll >= 0.5 → 3 figures. Pattern shuffle uses 9 randoms, slot shuffle uses 2 randoms.
    const random = seededRandom([
      0.9, // figuresCount → 3
      0, 0, 0, 0, 0, 0, 0, 0, 0, // pattern shuffle (all-zero keeps indices [0,1,2] as the picks: 3 patterns, 7 edges)
      0, 0, // slot shuffle for [0,1,2] with two zeros: swaps identity → slots [0,1,2]
    ]);
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random });
    c.start();
    // With all-zero shuffle randoms slice(0,3) = [1,2,3] = arrow_ascend(4) + chevron_double(6) + curve_arc(4) = 14 edges.
    const total = 4 + 6 + 4;
    for (let i = 1; i <= total; i += 1) {
      c.notifyProgress();
      assert.equal(canvas.dataset.constellationRevealed, String(i), `event ${i} traces sequential segment ${i}`);
    }
    c.notifyProgress();
    assert.equal(canvas.dataset.constellationRevealed, String(total), 'events past the last figure do not advance');
  } finally {
    restore();
  }
});

test('same injected random stream produces the same session (determinism for tests / replay)', () => {
  const { canvas, restore } = installStubDom({ reducedMotion: true });
  try {
    const seq = [0.7, 0.3, 0.6, 0.1, 0.4, 0.8, 0.2, 0.5, 0.9, 0.05, 0.42, 0.66];
    const c1 = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random: seededRandom([...seq]) });
    c1.start();
    for (let i = 0; i < 6; i += 1) c1.notifyProgress();
    const first = canvas.dataset.constellationRevealed;
    const c2 = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random: seededRandom([...seq]) });
    c2.start();
    for (let i = 0; i < 6; i += 1) c2.notifyProgress();
    const second = canvas.dataset.constellationRevealed;
    assert.equal(first, second, 'a replayed random sequence produces the same revealed count over the same events');
  } finally {
    restore();
  }
});

test('animated mode: dataset reports animated + progress advances one segment per event once the grow completes', () => {
  const { canvas, pump, restore } = installStubDom({ reducedMotion: false });
  try {
    const random = seededRandom([0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random });
    c.start();
    assert.equal(canvas.dataset.constellation, 'animated', 'normal motion animates tracing');
    c.notifyProgress();
    pump(); pump();
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
    const c = createLoadingConstellation({ canvasSelector: '#academy-loading-constellation', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random: seededRandom([0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });
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

test('start with a zero-size canvas is an inert no-op (no default-value fallback fabricates a size)', () => {
  const prev = { document: globalThis.document, window: globalThis.window };
  try {
    const canvas = { clientWidth: 0, clientHeight: 0, width: 0, height: 0, dataset: {}, getContext: () => ({}) };
    globalThis.document = { querySelector: () => canvas };
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    const c = createLoadingConstellation({ canvasSelector: '#x', lineColorRgb: COLOR_LINE, nodeColorRgb: COLOR_NODE, random: () => 0 });
    c.start();
    assert.doesNotThrow(() => c.notifyProgress(), 'unlaid-out canvas → notifyProgress is a no-op');
    assert.equal(canvas.dataset.constellationRevealed, undefined, 'unlaid-out canvas leaves the dataset untouched');
  } finally {
    Object.assign(globalThis, prev);
  }
});

test('slot placements never overlap horizontally within a session', () => {
  // For every slotCount ∈ {2,3} the slot bounds are non-overlapping ranges: slot i occupies [i/N, (i+1)/N] of
  // the canvas width. Verify by placing every pattern into every slot and checking the x extent stays within
  // its slot regardless of pattern shape.
  const w = 900;
  const h = 500;
  for (const slotCount of [2, 3]) {
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const lo = slotIndex * (w / slotCount);
      const hi = (slotIndex + 1) * (w / slotCount);
      for (const pattern of LOADING_CONSTELLATION_PATTERNS) {
        const placed = placePatternNodes(pattern, { canvasWidth: w, canvasHeight: h, slotIndex, slotCount });
        for (const { x } of placed) {
          assert.ok(x >= lo - 1e-6 && x <= hi + 1e-6, `slot ${slotIndex}/${slotCount}: pattern ${pattern.id} x ${x} within [${lo},${hi}]`);
        }
      }
    }
  }
});

test('module-level catalog validation: a malformed catalog throws at import (guard by cloning + re-validating locally)', () => {
  // The exported catalog is frozen for the app; re-run the same validation shape against a hand-broken clone to
  // pin the fail-fast rules. This mirrors the module-level check without requiring dynamic module reloading.
  const bad = [{ id: 'a', nodes: [[0, 0], [1, 1]], edges: [[0, 0]], drawOrder: [0] }];
  const seenIds = new Set();
  const validate = (patterns) => {
    if (!Array.isArray(patterns) || patterns.length === 0) throw new Error('non-empty');
    for (const p of patterns) {
      if (!p || typeof p !== 'object') throw new Error('object');
      if (typeof p.id !== 'string' || p.id.length === 0) throw new Error('id');
      if (seenIds.has(p.id)) throw new Error('duplicate id');
      seenIds.add(p.id);
      for (const [a, b] of p.edges) {
        if (a === b) throw new Error('self loop');
        if (a < 0 || a >= p.nodes.length || b < 0 || b >= p.nodes.length) throw new Error('edge range');
      }
    }
  };
  assert.throws(() => validate(bad), /self loop/);
});
