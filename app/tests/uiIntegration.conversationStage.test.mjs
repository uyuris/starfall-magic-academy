import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runtimePublicReferenceRoot } from './testPaths.mjs';
import { readUiSource } from './fixtures/uiSource.mjs';
import {
  conversationStageWeek,
  conversationStageMoonPhase,
  conversationStageMoonImageUrl,
  MOON_PHASE_IMAGE_COUNT,
  conversationStageStreamIsAtBottom,
  CONVERSATION_STAGE_STICK_THRESHOLD_PX,
  resolveConversationStageInfoCategoryTitle,
  createConversationStageTurnReveal,
  buildConversationStageStars,
  createStarfieldAmbient
} from '../public/conversationStage.js';

test('conversationStageWeek returns the 1-based week and fail-fasts on broken elapsed_weeks', () => {
  assert.equal(conversationStageWeek(0), 1);
  assert.equal(conversationStageWeek(7), 8);
  assert.equal(conversationStageWeek('3'), 4); // Number-coerced like the routing runtime source
  // Missing / non-finite / negative elapsed_weeks is broken runtime state — fail fast, never fabricate
  // week 1 or silently clamp the range. (Number(null) is 0, a legitimate week-1 source, same as the
  // original routing runtime read — so null is not in the fail-fast set.)
  for (const bad of [undefined, NaN, -1, 'abc', {}]) {
    assert.throws(() => conversationStageWeek(bad), /conversation stage week requires a valid elapsed_weeks/);
  }
});

test('conversationStageMoonPhase cycles the 0-based phase over the N-phase cycle and fail-fasts on an invalid phaseCount', () => {
  assert.equal(conversationStageMoonPhase(1, 8), 0);
  assert.equal(conversationStageMoonPhase(8, 8), 7);
  assert.equal(conversationStageMoonPhase(9, 8), 0);
  assert.equal(conversationStageMoonPhase(50, 8), (50 - 1) % 8);
  // A non-8 cycle length is honoured (a second consumer could theme a different phase count).
  assert.equal(conversationStageMoonPhase(5, 4), 0);
  // phaseCount is required + validated — no default-value fallback to 8 (absolute-rules fail-fast).
  for (const bad of [undefined, null, 0, -8, 8.5, '8', NaN]) {
    assert.throws(() => conversationStageMoonPhase(3, bad), /conversation stage moon phase requires a positive integer phaseCount/);
  }
});

test('conversationStageMoonImageUrl maps a phase index to its canonical moon-phase asset and fail-fasts out of range', () => {
  // The moon is a real image asset now: phase index n → /canonical/moon_phases/phase_<n>.jpg, over the shipped
  // 8-image set (new → waxing → full → waning), the same cycle semantics the removed CSS glyph expressed.
  assert.equal(MOON_PHASE_IMAGE_COUNT, 8);
  assert.equal(conversationStageMoonImageUrl(0), '/canonical/moon_phases/phase_0.jpg');
  assert.equal(conversationStageMoonImageUrl(4), '/canonical/moon_phases/phase_4.jpg');
  assert.equal(conversationStageMoonImageUrl(7), '/canonical/moon_phases/phase_7.jpg');
  // An out-of-range / non-integer phase is a broken caller — fail fast, never clamp or wrap to a placeholder
  // image (absolute-rules fail-fast).
  for (const bad of [-1, 8, 8.0 + 0.5, 3.5, '2', undefined, null, NaN]) {
    assert.throws(() => conversationStageMoonImageUrl(bad), /conversation stage moon image requires a phase in \[0, 8\)/);
  }
});

test('renderWeekAndMoon renders the phase as an <img> asset and fail-fasts when the cycle length ≠ the image set', async () => {
  // The moon topbar builds a circular-framed <img class="moon-phase-image"> whose src is the phase's canonical
  // asset and whose alt carries the phase label — not a CSS-glyph data-phase attribute. A consuming stage whose
  // moonPhaseCount ≠ the shipped image-set size throws (no silent glyph/default-value fallback), and a missing
  // asset is left to surface as an ordinary <img> load failure (no placeholder fabricated).
  const src = await readUiSource(path.join(runtimePublicReferenceRoot, 'conversationStage.js'), 'utf8');
  const renderFn = src.match(/renderWeekAndMoon\(\) \{[\s\S]*?\n    \},/)?.[0] ?? '';
  assert.notEqual(renderFn, '', 'conversationStage.js should carry a renderWeekAndMoon method');
  assert.match(renderFn, /config\.moonPhaseCount !== MOON_PHASE_IMAGE_COUNT[\s\S]*?throw new Error/, 'renderWeekAndMoon fail-fasts when the consumer cycle length does not equal the image set');
  assert.match(renderFn, /createElement\('img'\)[\s\S]*?className = 'moon-phase-image'/, 'renderWeekAndMoon builds the moon <img> with the shared moon-phase-image class');
  assert.match(renderFn, /image\.src = conversationStageMoonImageUrl\(phase\);[\s\S]*?image\.alt = label;/, 'renderWeekAndMoon points the <img> at the canonical phase asset and carries the accessible label as alt');
  // The CSS-glyph data-phase attribute wiring is fully gone (no残骸).
  assert.doesNotMatch(src, /dataset\.phase/, 'the moon no longer sets a data-phase attribute (CSS glyph residue removed)');
});

test('conversationStageStreamIsAtBottom applies the at-bottom gate within the given threshold', () => {
  const T = CONVERSATION_STAGE_STICK_THRESHOLD_PX; // the canonical 24px stick band, passed explicitly (no default)
  assert.equal(T, 24);
  // Exactly at the bottom.
  assert.equal(conversationStageStreamIsAtBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }, T), true);
  // Within the 24px threshold (a face-image row height wobble stays "at bottom").
  assert.equal(conversationStageStreamIsAtBottom({ scrollHeight: 1000, scrollTop: 780, clientHeight: 200 }, T), true);
  // Scrolled up past the threshold is not at bottom.
  assert.equal(conversationStageStreamIsAtBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 }, T), false);
  // The threshold is a caller-supplied value.
  assert.equal(conversationStageStreamIsAtBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 }, 120), true);
});

test('resolveConversationStageInfoCategoryTitle returns the title and fail-fasts on an unknown category', () => {
  const titles = { self: '自分', buddy: 'バディ', enemy: 'エネミー', inventory: '持ち物', money: 'お金' };
  assert.equal(resolveConversationStageInfoCategoryTitle('self', titles), '自分');
  assert.equal(resolveConversationStageInfoCategoryTitle('money', titles), 'お金');
  // An unknown category is broken data-* wiring — fail fast (no generic-title degrade).
  for (const bad of ['weather', '', undefined, null]) {
    assert.throws(() => resolveConversationStageInfoCategoryTitle(bad, titles), /unknown conversation stage info category/);
  }
});

test('buildConversationStageStars lays a deterministic even lattice (no RNG)', () => {
  const a = buildConversationStageStars(800, 450, 90);
  const b = buildConversationStageStars(800, 450, 90);
  assert.equal(a.length, 90);
  // Deterministic: two builds with the same dimensions/count are identical (no Math.random).
  assert.deepEqual(a, b);
  // Every star sits inside the canvas and carries the twinkle fields the drawer consumes.
  for (const star of a) {
    assert.ok(star.x >= 0 && star.x <= 800);
    assert.ok(star.y >= 0 && star.y <= 450);
    assert.ok(star.radius > 0);
    assert.equal(typeof star.phase, 'number');
    assert.equal(typeof star.speed, 'number');
  }
});

test('createStarfieldAmbient fail-fasts on an invalid starCount (no default-value fallback)', () => {
  // A valid config builds the ambient strategy (in node there is no window, so it reads matches:false).
  const ambient = createStarfieldAmbient({ canvasSelector: '#x', starColorRgb: '207, 218, 255', starCount: 90 });
  assert.equal(typeof ambient.start, 'function');
  assert.equal(typeof ambient.stop, 'function');
  // starCount is required + validated — a missing/invalid count is a broken consumer config, not a cue to
  // silently assume a field size (absolute-rules fail-fast).
  for (const bad of [undefined, null, 0, -1, 90.5, '90', NaN]) {
    assert.throws(() => createStarfieldAmbient({ canvasSelector: '#x', starColorRgb: '207, 218, 255', starCount: bad }), /conversation stage starfield ambient requires a positive integer starCount/);
  }
});

// The reveal queue is the invariant 統一出現規律: every 完成吹き出し単位 is revealed one at a time, spaced by
// the injected cooldown, with empty segments dropped and drain()/cancel() honoured. A controllable sleep
// lets the test step the queue deterministically without real timers.

test('createConversationStageTurnReveal reveals completed 吹き出し one at a time, spaced by the cooldown', async () => {
  const renders = [];
  const pendingSleeps = [];
  // A cooldown gate the test resolves explicitly, so it can observe one reveal per cooldown tick.
  const sleep = () => new Promise((resolve) => { pendingSleeps.push(resolve); });
  const reveal = createConversationStageTurnReveal({
    cooldownMs: () => 500,
    sleep,
    render: (revealed) => renders.push(revealed.map((s) => s.content))
  });

  reveal.enqueue([{ content: 'A' }, { content: '' }, { content: '  ' }, { content: 'B' }]);
  // The first segment reveals immediately (the initial cooldown gate is an already-resolved promise); the
  // empty / whitespace-only segments are dropped, so only A and B are ever queued.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(renders[0], ['A']);
  // B waits behind the cooldown gate until the sleep resolves.
  assert.equal(renders.length, 1);
  pendingSleeps.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(renders[1], ['A', 'B']);
});

test('createConversationStageTurnReveal drain() waits for the queue to empty and cancel() stops further reveals', async () => {
  const renders = [];
  const sleep = () => Promise.resolve(); // no real delay: reveals as fast as the microtask queue allows
  const reveal = createConversationStageTurnReveal({
    cooldownMs: () => 0,
    sleep,
    render: (revealed) => renders.push(revealed.length)
  });
  reveal.enqueue([{ content: 'x' }, { content: 'y' }, { content: 'z' }]);
  await reveal.drain();
  assert.deepEqual(renders, [1, 2, 3]);

  // After cancel(), a further enqueue reveals nothing (a failed send's restore is not overwritten by a
  // late paced render).
  reveal.cancel();
  reveal.enqueue([{ content: 'w' }]);
  await reveal.drain();
  assert.deepEqual(renders, [1, 2, 3]);
});

// ── Daytime conversation screen: the second consumer of the shared conversation stage ───────────────
// #conversation-day-screen instantiates createConversationStage over its own daytime scope, exactly as the
// routing hub does over #routing-hub-*. These pins verify the daytime screen consumes the stage (no
// reimplemented reveal / drawer / at-bottom mechanics), talks to a selectable roster character over the
// ordinary character conversation API (no hub dispatch), and is authored on a separate --cd-night-* token layer
// so the --routing-* layer and the shared chat CSS stay byte-equal.
