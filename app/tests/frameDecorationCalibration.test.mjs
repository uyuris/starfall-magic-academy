import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_CORNERS,
  FRAME_DECORATION_CALIBRATION_TARGETS,
  MAP_PIN_CALIBRATION_KIND,
  MAP_PIN_CALIBRATION_TARGETS,
  validateCalibrationTarget,
  validateCalibrationRegistry,
  validateMapPinCalibrationTarget,
  validateMapPinCalibrationRegistry,
  calibrationTargetsForScreen,
  readCalibrationScreen,
  readCalibrationRegion,
  calibrationScreensWithTargets,
  targetsForScreen,
  parseCalibrationOffsetPx,
  restoreCalibrationBaselines,
  formatCalibrationPx,
  formatCalibrationOffsetsCss,
  roundMapPinCoordinate,
  formatMapPinCoordinatesJs
} from '../public/frameDecorationCalibration.js';

function validTarget(overrides = {}) {
  return {
    id: 'example',
    label: 'Example',
    screen: 'routing-hub',
    anchorSelector: '.anchor',
    corner: 'top-left',
    styleHostSelector: '.host',
    varX: '--example-dx',
    varY: '--example-dy',
    ...overrides
  };
}

test('the shipped corner registry validates and covers the routing hub, daytime, title, and academy-map corners', () => {
  assert.doesNotThrow(() => validateCalibrationRegistry(FRAME_DECORATION_CALIBRATION_TARGETS));
  // The routing hub's four corners are unchanged (their pin is preserved as the exact per-screen set).
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'routing-hub').map((target) => target.id), [
    'routing-hub-standee-corner-tl',
    'routing-hub-standee-corner-br',
    'routing-hub-chat-corner-tl',
    'routing-hub-chat-corner-br'
  ]);
  // The daytime conversation screen registers its own four corners (the second consumer's calibration set).
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'conversation-day').map((target) => target.id), [
    'conversation-day-standee-corner-tl',
    'conversation-day-standee-corner-br',
    'conversation-day-chat-corner-tl',
    'conversation-day-chat-corner-br'
  ]);
  // The title menu card registers all four corner ornaments so ?calibrate=title can bake its offsets back
  // into the title-scoped --title-corner-* declarations.
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'title').map((target) => target.id), [
    'title-corner-tl',
    'title-corner-tr',
    'title-corner-bl',
    'title-corner-br'
  ]);
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'title').map((target) => target.corner), [
    'top-left', 'top-right', 'bottom-left', 'bottom-right'
  ]);
  // The academy map frame registers all FOUR corners (tl/tr/bl/br), unlike the hub/daytime screens which only
  // decorate tl/br — its ornaments drive the --am-corner-* offsets consumed by .academy-map-corner-*.
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'academy-map').map((target) => target.id), [
    'academy-map-corner-tl',
    'academy-map-corner-tr',
    'academy-map-corner-bl',
    'academy-map-corner-br'
  ]);
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'academy-map').map((target) => target.corner), [
    'top-left', 'top-right', 'bottom-left', 'bottom-right'
  ]);
  // The 錬成室 stage frame likewise registers all FOUR corners, driving the --atelier-corner-* offsets consumed by
  // .academy-atelier-corner-*.
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'academy-atelier').map((target) => target.id), [
    'academy-atelier-corner-tl',
    'academy-atelier-corner-tr',
    'academy-atelier-corner-bl',
    'academy-atelier-corner-br'
  ]);
  assert.deepEqual(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'academy-atelier').map((target) => target.corner), [
    'top-left', 'top-right', 'bottom-left', 'bottom-right'
  ]);
  // Every shipped target lives on a known calibration screen and drives a distinct pair of custom properties
  // (unique across the whole registry — no offset var is shared between two ornaments).
  const knownScreens = new Set(['routing-hub', 'conversation-day', 'title', 'academy-map', 'academy-atelier']);
  const varNames = new Set();
  for (const target of FRAME_DECORATION_CALIBRATION_TARGETS) {
    assert.ok(knownScreens.has(target.screen), `unexpected calibration screen ${target.screen}`);
    varNames.add(target.varX);
    varNames.add(target.varY);
  }
  assert.equal(varNames.size, FRAME_DECORATION_CALIBRATION_TARGETS.length * 2);
});

test('validateCalibrationTarget fail-fasts on a malformed entry', () => {
  assert.doesNotThrow(() => validateCalibrationTarget(validTarget()));
  assert.throws(() => validateCalibrationTarget(null), /must be an object/);
  for (const field of ['id', 'label', 'screen', 'anchorSelector', 'corner', 'styleHostSelector', 'varX', 'varY']) {
    assert.throws(() => validateCalibrationTarget(validTarget({ [field]: '' })), new RegExp(`field ${field} must be a non-empty string`));
    assert.throws(() => validateCalibrationTarget(validTarget({ [field]: 42 })), new RegExp(`field ${field} must be a non-empty string`));
  }
  assert.throws(() => validateCalibrationTarget(validTarget({ corner: 'middle' })), /unknown corner/);
  assert.throws(() => validateCalibrationTarget(validTarget({ varX: 'example-dx' })), /must be a CSS custom property name starting with "--"/);
  assert.throws(() => validateCalibrationTarget(validTarget({ varY: 'dy' })), /must be a CSS custom property name starting with "--"/);
});

test('every known corner is accepted and locates a rect point', () => {
  for (const corner of CALIBRATION_CORNERS) {
    assert.doesNotThrow(() => validateCalibrationTarget(validTarget({ corner })));
  }
  assert.deepEqual([...CALIBRATION_CORNERS], ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
});

test('validateCalibrationRegistry rejects an empty registry and duplicate ids', () => {
  assert.throws(() => validateCalibrationRegistry([]), /non-empty array/);
  assert.throws(() => validateCalibrationRegistry('nope'), /non-empty array/);
  assert.throws(
    () => validateCalibrationRegistry([validTarget({ id: 'dup' }), validTarget({ id: 'dup', varX: '--other-dx', varY: '--other-dy' })]),
    /duplicate calibration target id: dup/
  );
});

test('readCalibrationScreen reads the ?calibrate trigger and treats absent/blank as off', () => {
  assert.equal(readCalibrationScreen('?calibrate=routing-hub'), 'routing-hub');
  assert.equal(readCalibrationScreen('?other=1&calibrate=some-screen'), 'some-screen');
  assert.equal(readCalibrationScreen(''), null);
  assert.equal(readCalibrationScreen('?initialScreen=debug'), null);
  assert.equal(readCalibrationScreen('?calibrate='), null);
  assert.equal(readCalibrationScreen('?calibrate=%20'), null);
});

test('readCalibrationRegion reads the optional ?region selector and treats absent/blank as off', () => {
  assert.equal(readCalibrationRegion('?calibrate=academy-map&region=sanrin'), 'sanrin');
  assert.equal(readCalibrationRegion('?region=academy'), 'academy');
  assert.equal(readCalibrationRegion('?calibrate=academy-map'), null, 'no region selector is the default-region case');
  assert.equal(readCalibrationRegion(''), null);
  assert.equal(readCalibrationRegion('?region='), null);
  assert.equal(readCalibrationRegion('?region=%20'), null);
});

test('calibrationScreensWithTargets and targetsForScreen resolve by screen and fail-fast on an unknown one', () => {
  assert.deepEqual([...calibrationScreensWithTargets(FRAME_DECORATION_CALIBRATION_TARGETS)], ['routing-hub', 'conversation-day', 'title', 'academy-map', 'academy-atelier']);
  assert.equal(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'routing-hub').length, 4);
  assert.equal(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'conversation-day').length, 4);
  assert.equal(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'title').length, 4);
  assert.equal(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'academy-map').length, 4);
  assert.equal(targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'academy-atelier').length, 4);
  assert.throws(
    () => targetsForScreen(FRAME_DECORATION_CALIBRATION_TARGETS, 'nonexistent'),
    /no frame-decoration calibration targets registered for screen "nonexistent"/
  );
});

test('formatCalibrationPx rounds to integer px, keeps sign, and normalizes zero', () => {
  assert.equal(formatCalibrationPx(0), '0px');
  assert.equal(formatCalibrationPx(-0), '0px');
  assert.equal(formatCalibrationPx(0.4), '0px');
  assert.equal(formatCalibrationPx(3.6), '4px');
  assert.equal(formatCalibrationPx(-2.5), '-2px');
  assert.throws(() => formatCalibrationPx(Number.NaN), /must be a finite number/);
  assert.throws(() => formatCalibrationPx(Infinity), /must be a finite number/);
});

test('parseCalibrationOffsetPx accepts only a plain px length and fail-fasts on empty / non-px values', () => {
  assert.equal(parseCalibrationOffsetPx('0px'), 0);
  assert.equal(parseCalibrationOffsetPx('24px'), 24);
  assert.equal(parseCalibrationOffsetPx('-6px'), -6);
  assert.equal(parseCalibrationOffsetPx('3.5px'), 3.5);
  assert.equal(parseCalibrationOffsetPx('  12px  '), 12, 'surrounding whitespace is trimmed');
  // Empty (undefined property) fail-fasts distinctly from a wrong unit.
  for (const raw of ['', '   ', null, undefined]) {
    assert.throws(() => parseCalibrationOffsetPx(raw, { varName: '--x', targetId: 't' }), /is not defined/);
  }
  // Non-px tokens that parseFloat would have silently coerced must throw, not be treated as px.
  for (const raw of ['1rem', '12foo', '3', '0', 'px', 'abc', 'NaNpx', '10PX', '1e2px', '5 px']) {
    assert.throws(() => parseCalibrationOffsetPx(raw, { varName: '--x', targetId: 't' }), /must be a px length/, `"${raw}" must be rejected`);
  }
});

test('restoreCalibrationBaselines returns each entry to its captured baseline (not a hardcoded 0)', () => {
  // A screen may ship non-zero baked offsets; reset must land on that declared baseline, not origin.
  const entries = [
    { target: FRAME_DECORATION_CALIBRATION_TARGETS[0], baseline: { x: 5, y: -3 }, offset: { x: 40, y: 12 } },
    { target: FRAME_DECORATION_CALIBRATION_TARGETS[1], baseline: { x: 0, y: 0 }, offset: { x: -8, y: 9 } }
  ];
  restoreCalibrationBaselines(entries);
  assert.deepEqual(entries[0].offset, { x: 5, y: -3 }, 'a non-zero baseline is restored (not zeroed)');
  assert.deepEqual(entries[1].offset, { x: 0, y: 0 }, 'a zero baseline is restored to zero');
  // Restoring makes a fresh object so mutating the restored offset does not corrupt the baseline.
  entries[0].offset.x = 999;
  assert.equal(entries[0].baseline.x, 5, 'the baseline is not aliased by the restored offset');
  assert.throws(() => restoreCalibrationBaselines([{ target: FRAME_DECORATION_CALIBRATION_TARGETS[0], offset: { x: 1, y: 1 } }]), /missing a finite baseline/);
  assert.throws(() => restoreCalibrationBaselines([{ baseline: { x: Number.NaN, y: 0 } }]), /missing a finite baseline/);
  assert.throws(() => restoreCalibrationBaselines('nope'), /must be an array/);
});

test('formatCalibrationOffsetsCss emits bake-ready declarations and validates its targets', () => {
  const css = formatCalibrationOffsetsCss([
    { target: FRAME_DECORATION_CALIBRATION_TARGETS[0], x: 3, y: -2 },
    { target: FRAME_DECORATION_CALIBRATION_TARGETS[2], x: 0, y: 5.7 }
  ]);
  assert.match(css, /^\/\* Frame decoration calibration offsets — routing-hub \*\//);
  assert.match(css, /--rh-standee-corner-tl-dx: 3px; \/\* 立ち絵フレーム 左上 X \*\//);
  assert.match(css, /--rh-standee-corner-tl-dy: -2px; \/\* 立ち絵フレーム 左上 Y \*\//);
  assert.match(css, /--rh-chat-corner-tl-dx: 0px; \/\* 会話パネル 左上 X \*\//);
  assert.match(css, /--rh-chat-corner-tl-dy: 6px; \/\* 会話パネル 左上 Y \*\//);
  assert.throws(() => formatCalibrationOffsetsCss([]), /non-empty array/);
  assert.throws(() => formatCalibrationOffsetsCss([{ target: validTarget({ varX: 'bad' }), x: 0, y: 0 }]), /must be a CSS custom property name/);
});

// ── Second calibration kind: map pins ────────────────────────────────────────────────────────────────────

function validPinTarget(overrides = {}) {
  return {
    kind: MAP_PIN_CALIBRATION_KIND,
    id: 'example-pins',
    label: 'Example pins',
    screen: 'academy-map',
    region: 'academy',
    containerSelector: '#stage-layer',
    nodeSelector: '.pin',
    coordinatesName: 'exampleCoordinates',
    ...overrides
  };
}

test('the shipped map-pin registry validates and registers the academy + sanrin stage pins on the academy-map screen', () => {
  assert.doesNotThrow(() => validateMapPinCalibrationRegistry(MAP_PIN_CALIBRATION_TARGETS));
  assert.equal(MAP_PIN_CALIBRATION_TARGETS.length, 2);
  const [academy, sanrin] = MAP_PIN_CALIBRATION_TARGETS;
  // Both pin groups share the academy-map DOM screen but name distinct regions and truth sources — the tool
  // switches to the named region (?region=) so only that region's pins are calibrated at a time.
  assert.equal(academy.kind, MAP_PIN_CALIBRATION_KIND);
  assert.equal(academy.id, 'academy-map-stage-pins');
  assert.equal(academy.screen, 'academy-map');
  assert.equal(academy.region, 'academy');
  assert.equal(academy.containerSelector, '#academy-map-stage-layer');
  assert.equal(academy.nodeSelector, '.academy-map-node');
  assert.equal(academy.coordinatesName, 'academyMapStagePinCoordinates');
  assert.equal(sanrin.kind, MAP_PIN_CALIBRATION_KIND);
  assert.equal(sanrin.id, 'sanrin-map-stage-pins');
  assert.equal(sanrin.screen, 'academy-map');
  assert.equal(sanrin.region, 'sanrin');
  assert.equal(sanrin.containerSelector, '#academy-map-stage-layer');
  assert.equal(sanrin.nodeSelector, '.academy-map-node');
  assert.equal(sanrin.coordinatesName, 'sanrinMapStagePinCoordinates');
});

test('validateMapPinCalibrationTarget fail-fasts on an unknown kind or a malformed entry', () => {
  assert.doesNotThrow(() => validateMapPinCalibrationTarget(validPinTarget()));
  assert.throws(() => validateMapPinCalibrationTarget(null), /must be an object/);
  assert.throws(() => validateMapPinCalibrationTarget(validPinTarget({ kind: 'corner' })), /unknown kind/);
  assert.throws(() => validateMapPinCalibrationTarget(validPinTarget({ kind: undefined })), /unknown kind/);
  for (const field of ['id', 'label', 'screen', 'region', 'containerSelector', 'nodeSelector', 'coordinatesName']) {
    assert.throws(() => validateMapPinCalibrationTarget(validPinTarget({ [field]: '' })), new RegExp(`field ${field} must be a non-empty string`));
    assert.throws(() => validateMapPinCalibrationTarget(validPinTarget({ [field]: 3 })), new RegExp(`field ${field} must be a non-empty string`));
  }
});

test('validateMapPinCalibrationRegistry rejects an empty registry and duplicate ids', () => {
  assert.throws(() => validateMapPinCalibrationRegistry([]), /non-empty array/);
  assert.throws(() => validateMapPinCalibrationRegistry('nope'), /non-empty array/);
  assert.throws(
    () => validateMapPinCalibrationRegistry([validPinTarget({ id: 'dup' }), validPinTarget({ id: 'dup' })]),
    /duplicate map-pin calibration target id: dup/
  );
});

test('calibrationTargetsForScreen unions corners and pins per screen and fail-fasts on an unknown screen', () => {
  const hub = calibrationTargetsForScreen('routing-hub');
  assert.equal(hub.corners.length, 4);
  assert.equal(hub.pins.length, 0, 'the hub has corner targets but no pin targets');
  const title = calibrationTargetsForScreen('title');
  assert.equal(title.corners.length, 4, 'the title menu card has four frame corners');
  assert.equal(title.pins.length, 0, 'the title screen has corner targets but no pin targets');
  const map = calibrationTargetsForScreen('academy-map');
  assert.equal(map.corners.length, 4, 'the academy map has four frame corners');
  assert.equal(map.pins.length, 2, 'the academy map screen owns the academy + sanrin pin groups');
  assert.deepEqual(map.pins.map((entry) => entry.id), ['academy-map-stage-pins', 'sanrin-map-stage-pins']);
  assert.deepEqual(map.pins.map((entry) => entry.region), ['academy', 'sanrin']);
  assert.throws(() => calibrationTargetsForScreen('nonexistent'), /no calibration targets registered for screen "nonexistent"/);
});

test('roundMapPinCoordinate rounds to one decimal and fail-fasts on a non-finite number', () => {
  assert.equal(roundMapPinCoordinate(50), 50);
  assert.equal(roundMapPinCoordinate(35.94), 35.9);
  assert.equal(roundMapPinCoordinate(35.95), 36); // Math.round(359.5) = 360
  assert.equal(roundMapPinCoordinate(-6.28), -6.3);
  assert.equal(roundMapPinCoordinate(0), 0);
  assert.throws(() => roundMapPinCoordinate(Number.NaN), /must be a finite number/);
  assert.throws(() => roundMapPinCoordinate(Infinity), /must be a finite number/);
});

test('formatMapPinCoordinatesJs emits a paste-ready JS object with every base id, overriding dragged pins', () => {
  const baseCoordinates = {
    courtyard_fountain: { x: 50, y: 45 },
    academy_shop: { x: 35.9, y: 30.7 },
    sealed_ritual_room: { x: 87, y: 67 } // an unrendered pin: no override, keeps its base value
  };
  const overrides = {
    courtyard_fountain: { x: 51.24, y: 44.98 } // a dragged pin: rounded to one decimal
  };
  const js = formatMapPinCoordinatesJs({ coordinatesName: 'academyMapStagePinCoordinates', baseCoordinates, overrides });
  // Header + closing are a real const declaration ready to paste over the truth source.
  assert.match(js, /^const academyMapStagePinCoordinates = \{\n/);
  assert.match(js, /\n\};$/);
  // Stable declaration order = the base object's key order; dragged pin uses the rounded override, others base.
  assert.equal(js, [
    'const academyMapStagePinCoordinates = {',
    '  courtyard_fountain: { x: 51.2, y: 45 },',
    '  academy_shop: { x: 35.9, y: 30.7 },',
    '  sealed_ritual_room: { x: 87, y: 67 }',
    '};'
  ].join('\n'));
  // No overrides supplied → the export is exactly the base coordinates (round-trip identity for integers/1dp).
  const identity = formatMapPinCoordinatesJs({ coordinatesName: 'academyMapStagePinCoordinates', baseCoordinates });
  assert.match(identity, /courtyard_fountain: \{ x: 50, y: 45 \}/);
  assert.match(identity, /academy_shop: \{ x: 35\.9, y: 30\.7 \}/);
  assert.throws(() => formatMapPinCoordinatesJs({ coordinatesName: '', baseCoordinates }), /coordinatesName must be a non-empty string/);
  assert.throws(() => formatMapPinCoordinatesJs({ coordinatesName: 'x', baseCoordinates: {} }), /at least one pin/);
  assert.throws(() => formatMapPinCoordinatesJs({ coordinatesName: 'x', baseCoordinates: { a: { x: 1 } } }), /must have finite \{x,y\}/);
  assert.throws(() => formatMapPinCoordinatesJs({ coordinatesName: 'x', baseCoordinates: { a: { x: 1, y: Number.NaN } } }), /must have finite \{x,y\}/);
});
