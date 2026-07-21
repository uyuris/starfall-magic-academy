// Pure logic for the dev-only frame-decoration drag-calibration tool, shared by app.js and headless
// unit tests so the registry contract, the query trigger, and the export format are verifiable without
// a browser. The DOM side (draggable handles, live drag, clipboard) lives in app.js and reads this
// registry generically — adding a new decoration to the tool is a single entry below, no tool code.
//
// Model: each corner ornament's position offset is a translate in SCREEN pixels driven by a pair of CSS
// custom properties (varX / varY). The offset composes IN FRONT of the ornament's decorative transform
// (rotate(180deg) / scaleY(-1) / none), so dragging is natural (right = +x, down = +y) regardless of
// how the ornament is flipped. The defaults are defined as real declarations in style.css (0px each =
// pixel-equivalent to the baked positions); consumers read `var(--x)` with NO fallback, so this adds no
// default-value fallback — a genuinely undefined property surfaces as a broken transform, not a silent 0.

// The corners of an anchor box a handle can sit at.
export const CALIBRATION_CORNERS = Object.freeze(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

// The declarative registry. Each entry:
//   id                 unique id (handle + export key)
//   label              human label on the handle and in the export
//   screen             the screen name (showScreen) whose decorations this belongs to; ?calibrate=<screen>
//                      reveals exactly the entries for that screen
//   anchorSelector     stable box whose `corner` locates the ornament; it is NOT itself translated, so the
//                      handle tracks the ornament at anchorCorner + (offsetX, offsetY)
//   corner             which corner of the anchor the ornament hugs
//   styleHostSelector  element the offset custom properties are set on; the consuming rule (which may be a
//                      ::before / ::after pseudo-element) inherits them from this host
//   varX / varY        custom property names driving the ornament's translate offset, in px
export const FRAME_DECORATION_CALIBRATION_TARGETS = Object.freeze([
  Object.freeze({
    id: 'routing-hub-standee-corner-tl',
    label: '立ち絵フレーム 左上',
    screen: 'routing-hub',
    anchorSelector: '.routing-hub-standee-frame',
    corner: 'top-left',
    styleHostSelector: '.routing-hub-standee-frame',
    varX: '--rh-standee-corner-tl-dx',
    varY: '--rh-standee-corner-tl-dy'
  }),
  Object.freeze({
    id: 'routing-hub-standee-corner-br',
    label: '立ち絵フレーム 右下',
    screen: 'routing-hub',
    anchorSelector: '.routing-hub-standee-frame',
    corner: 'bottom-right',
    styleHostSelector: '.routing-hub-standee-frame',
    varX: '--rh-standee-corner-br-dx',
    varY: '--rh-standee-corner-br-dy'
  }),
  Object.freeze({
    id: 'routing-hub-chat-corner-tl',
    label: '会話パネル 左上',
    screen: 'routing-hub',
    anchorSelector: '.routing-hub-chat-panel',
    corner: 'top-left',
    styleHostSelector: '.routing-hub-corner-tl',
    varX: '--rh-chat-corner-tl-dx',
    varY: '--rh-chat-corner-tl-dy'
  }),
  Object.freeze({
    id: 'routing-hub-chat-corner-br',
    label: '会話パネル 右下',
    screen: 'routing-hub',
    anchorSelector: '.routing-hub-chat-panel',
    corner: 'bottom-right',
    styleHostSelector: '.routing-hub-corner-br',
    varX: '--rh-chat-corner-br-dx',
    varY: '--rh-chat-corner-br-dy'
  }),
  Object.freeze({
    id: 'conversation-day-standee-corner-tl',
    label: '立ち絵フレーム 左上',
    screen: 'conversation-day',
    anchorSelector: '.conversation-day-standee-frame',
    corner: 'top-left',
    styleHostSelector: '.conversation-day-standee-frame',
    varX: '--cd-standee-corner-tl-dx',
    varY: '--cd-standee-corner-tl-dy'
  }),
  Object.freeze({
    id: 'conversation-day-standee-corner-br',
    label: '立ち絵フレーム 右下',
    screen: 'conversation-day',
    anchorSelector: '.conversation-day-standee-frame',
    corner: 'bottom-right',
    styleHostSelector: '.conversation-day-standee-frame',
    varX: '--cd-standee-corner-br-dx',
    varY: '--cd-standee-corner-br-dy'
  }),
  Object.freeze({
    id: 'conversation-day-chat-corner-tl',
    label: '会話パネル 左上',
    screen: 'conversation-day',
    anchorSelector: '.conversation-day-chat-panel',
    corner: 'top-left',
    styleHostSelector: '.conversation-day-corner-tl',
    varX: '--cd-chat-corner-tl-dx',
    varY: '--cd-chat-corner-tl-dy'
  }),
  Object.freeze({
    id: 'conversation-day-chat-corner-br',
    label: '会話パネル 右下',
    screen: 'conversation-day',
    anchorSelector: '.conversation-day-chat-panel',
    corner: 'bottom-right',
    styleHostSelector: '.conversation-day-corner-br',
    varX: '--cd-chat-corner-br-dx',
    varY: '--cd-chat-corner-br-dy'
  }),
  Object.freeze({
    id: 'title-corner-tl',
    label: 'タイトル額装 左上',
    screen: 'title',
    anchorSelector: '.title-screen-shell',
    corner: 'top-left',
    styleHostSelector: '.title-corner-tl',
    varX: '--title-corner-tl-dx',
    varY: '--title-corner-tl-dy'
  }),
  Object.freeze({
    id: 'title-corner-tr',
    label: 'タイトル額装 右上',
    screen: 'title',
    anchorSelector: '.title-screen-shell',
    corner: 'top-right',
    styleHostSelector: '.title-corner-tr',
    varX: '--title-corner-tr-dx',
    varY: '--title-corner-tr-dy'
  }),
  Object.freeze({
    id: 'title-corner-bl',
    label: 'タイトル額装 左下',
    screen: 'title',
    anchorSelector: '.title-screen-shell',
    corner: 'bottom-left',
    styleHostSelector: '.title-corner-bl',
    varX: '--title-corner-bl-dx',
    varY: '--title-corner-bl-dy'
  }),
  Object.freeze({
    id: 'title-corner-br',
    label: 'タイトル額装 右下',
    screen: 'title',
    anchorSelector: '.title-screen-shell',
    corner: 'bottom-right',
    styleHostSelector: '.title-corner-br',
    varX: '--title-corner-br-dx',
    varY: '--title-corner-br-dy'
  }),
  // 学院マップ額装の四隅（tl/tr/bl/br の4箇所）。routing-hub / conversation-day が tl/br の2箇所だけ持つのと違い、
  // マップ額装は四隅すべてに隅飾りを置く。オフセットは #academy-map-screen 実宣言の --am-corner-*（初期 0px・
  // var() fallback なし）を各 .academy-map-corner-* が consume し、host はその consuming 要素自身（pseudo-element
  // でない実要素なので inline で直接上書きできる）。anchor はマップ canvas の各隅。
  Object.freeze({
    id: 'academy-map-corner-tl',
    label: 'マップ額装 左上',
    screen: 'academy-map',
    anchorSelector: '.academy-map-canvas',
    corner: 'top-left',
    styleHostSelector: '.academy-map-corner-tl',
    varX: '--am-corner-tl-dx',
    varY: '--am-corner-tl-dy'
  }),
  Object.freeze({
    id: 'academy-map-corner-tr',
    label: 'マップ額装 右上',
    screen: 'academy-map',
    anchorSelector: '.academy-map-canvas',
    corner: 'top-right',
    styleHostSelector: '.academy-map-corner-tr',
    varX: '--am-corner-tr-dx',
    varY: '--am-corner-tr-dy'
  }),
  Object.freeze({
    id: 'academy-map-corner-bl',
    label: 'マップ額装 左下',
    screen: 'academy-map',
    anchorSelector: '.academy-map-canvas',
    corner: 'bottom-left',
    styleHostSelector: '.academy-map-corner-bl',
    varX: '--am-corner-bl-dx',
    varY: '--am-corner-bl-dy'
  }),
  Object.freeze({
    id: 'academy-map-corner-br',
    label: 'マップ額装 右下',
    screen: 'academy-map',
    anchorSelector: '.academy-map-canvas',
    corner: 'bottom-right',
    styleHostSelector: '.academy-map-corner-br',
    varX: '--am-corner-br-dx',
    varY: '--am-corner-br-dy'
  }),
  // 錬成室 stage-frame の四隅（tl/tr/bl/br）。マップと同じく四隅すべてに隅飾りを置く。オフセットは
  // #academy-atelier-screen 実宣言の --atelier-corner-*（初期 0px・var() fallback なし）を各 .academy-atelier-corner-*
  // が transform で consume し、host はその consuming 要素自身（実要素なので inline で直接上書きできる）。anchor は
  // 1:1 stage frame の各隅。
  Object.freeze({
    id: 'academy-atelier-corner-tl',
    label: '錬成室額装 左上',
    screen: 'academy-atelier',
    anchorSelector: '.academy-atelier-stage',
    corner: 'top-left',
    styleHostSelector: '.academy-atelier-corner-tl',
    varX: '--atelier-corner-tl-dx',
    varY: '--atelier-corner-tl-dy'
  }),
  Object.freeze({
    id: 'academy-atelier-corner-tr',
    label: '錬成室額装 右上',
    screen: 'academy-atelier',
    anchorSelector: '.academy-atelier-stage',
    corner: 'top-right',
    styleHostSelector: '.academy-atelier-corner-tr',
    varX: '--atelier-corner-tr-dx',
    varY: '--atelier-corner-tr-dy'
  }),
  Object.freeze({
    id: 'academy-atelier-corner-bl',
    label: '錬成室額装 左下',
    screen: 'academy-atelier',
    anchorSelector: '.academy-atelier-stage',
    corner: 'bottom-left',
    styleHostSelector: '.academy-atelier-corner-bl',
    varX: '--atelier-corner-bl-dx',
    varY: '--atelier-corner-bl-dy'
  }),
  Object.freeze({
    id: 'academy-atelier-corner-br',
    label: '錬成室額装 右下',
    screen: 'academy-atelier',
    anchorSelector: '.academy-atelier-stage',
    corner: 'bottom-right',
    styleHostSelector: '.academy-atelier-corner-br',
    varX: '--atelier-corner-br-dx',
    varY: '--atelier-corner-br-dy'
  })
]);

const REQUIRED_STRING_FIELDS = Object.freeze(['id', 'label', 'screen', 'anchorSelector', 'corner', 'styleHostSelector', 'varX', 'varY']);

// Validate one registry entry. A malformed entry (missing/blank field, unknown corner, or a var name that
// is not a `--` custom property) fail-fasts rather than being silently skipped — a broken registration is
// a wiring bug, not a state to ignore. Returns the target unchanged.
export function validateCalibrationTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new Error(`calibration target must be an object, got ${JSON.stringify(target)}`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = target[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`calibration target ${JSON.stringify(target.id)} field ${field} must be a non-empty string`);
    }
  }
  if (!CALIBRATION_CORNERS.includes(target.corner)) {
    throw new Error(`calibration target ${target.id} has unknown corner ${JSON.stringify(target.corner)} (expected one of ${CALIBRATION_CORNERS.join(', ')})`);
  }
  for (const field of ['varX', 'varY']) {
    if (!target[field].startsWith('--')) {
      throw new Error(`calibration target ${target.id} ${field} must be a CSS custom property name starting with "--", got ${JSON.stringify(target[field])}`);
    }
  }
  return target;
}

// Validate the whole registry: a non-empty array of valid entries with unique ids. Fail-fasts on any
// malformed entry or duplicate id.
export function validateCalibrationRegistry(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('calibration registry must be a non-empty array');
  }
  const seen = new Set();
  for (const target of targets) {
    validateCalibrationTarget(target);
    if (seen.has(target.id)) {
      throw new Error(`duplicate calibration target id: ${target.id}`);
    }
    seen.add(target.id);
  }
  return targets;
}

// Read the ?calibrate=<screen> trigger from a URL query string. Absent or blank returns null (the normal
// play state — the tool adds nothing). A present value names the screen to calibrate; validation of
// whether that screen has targets happens in targetsForScreen (fail-fast there).
export function readCalibrationScreen(search) {
  const value = new URLSearchParams(search ?? '').get('calibrate');
  if (value === null || value.trim() === '') return null;
  return value;
}

// Read the optional ?region=<region> selector that accompanies ?calibrate= for the multi-region map screen.
// Absent or blank returns null (the screen renders its default region); a present value names the map region
// to switch to before the overlay is built. Whether that region id is real is validated by the tool at switch
// time (fail-fast there) — this reader only trims the raw query value.
export function readCalibrationRegion(search) {
  const value = new URLSearchParams(search ?? '').get('region');
  if (value === null || value.trim() === '') return null;
  return value;
}

// The distinct screens that own at least one calibration target, in first-seen order.
export function calibrationScreensWithTargets(targets) {
  return Object.freeze([...new Set(targets.map((target) => target.screen))]);
}

// The targets registered for a screen. An unknown screen (no registered targets) fail-fasts rather than
// opening an empty calibration overlay.
export function targetsForScreen(targets, screen) {
  const matched = targets.filter((target) => target.screen === screen);
  if (matched.length === 0) {
    throw new Error(`no frame-decoration calibration targets registered for screen ${JSON.stringify(screen)} (known: ${calibrationScreensWithTargets(targets).join(', ') || 'none'})`);
  }
  return matched;
}

// Format an offset component as an integer px string (`0px` for zero, sign preserved). Fail-fasts on a
// non-finite number instead of emitting `NaNpx`.
export function formatCalibrationPx(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`calibration offset must be a finite number, got ${JSON.stringify(value)}`);
  }
  const rounded = Math.round(value);
  return `${rounded === 0 ? 0 : rounded}px`;
}

// Parse a resolved offset custom-property value into a px number. The value MUST be a plain px length —
// an empty value (undefined property), or a non-px token (`1rem`, `12foo`, a bare number `3`, `px`, etc.),
// fail-fasts rather than being coerced with parseFloat into an ambiguous px assumption. `varName`/`targetId`
// only shape the error message. Pure, so the accept/reject boundary is verifiable without the DOM.
export function parseCalibrationOffsetPx(raw, { varName = '', targetId } = {}) {
  const label = `calibration target ${JSON.stringify(targetId)} custom property ${varName}`;
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') {
    throw new Error(`${label} is not defined (add its default declaration in CSS)`);
  }
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed);
  if (!match) {
    throw new Error(`${label} must be a px length, got ${JSON.stringify(trimmed)}`);
  }
  return Number.parseFloat(match[1]);
}

// Restore each entry's offset to its captured baseline — the per-target starting state read at tool build
// from the resolved custom-property values. `リセット` must return to this baseline, NOT a hardcoded origin:
// once a screen ships non-zero baked offsets, reset has to land on the declared start, not (0,0). Each entry
// must carry a `baseline` (fail-fast if missing — a reset with no captured baseline is broken tool state).
export function restoreCalibrationBaselines(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('restoreCalibrationBaselines: entries must be an array');
  }
  for (const entry of entries) {
    const baseline = entry?.baseline;
    if (!baseline || !Number.isFinite(baseline.x) || !Number.isFinite(baseline.y)) {
      throw new Error(`restoreCalibrationBaselines: entry ${JSON.stringify(entry?.target?.id)} is missing a finite baseline {x,y}`);
    }
    entry.offset = { x: baseline.x, y: baseline.y };
  }
  return entries;
}

// Format the current offsets as CSS custom-property declarations ready to bake back into the defaults.
// `entries` is [{ target, x, y }]; each target is validated (fail-fast on a malformed entry). The output
// is deterministic and copy-pasteable into the screen's default token block.
export function formatCalibrationOffsetsCss(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('formatCalibrationOffsetsCss: entries must be a non-empty array');
  }
  const screens = new Set();
  const lines = [];
  for (const entry of entries) {
    const target = validateCalibrationTarget(entry?.target);
    screens.add(target.screen);
    lines.push(`  ${target.varX}: ${formatCalibrationPx(entry.x)}; /* ${target.label} X */`);
    lines.push(`  ${target.varY}: ${formatCalibrationPx(entry.y)}; /* ${target.label} Y */`);
  }
  const header = `/* Frame decoration calibration offsets — ${[...screens].join(', ')} */`;
  return `${header}\n${lines.join('\n')}`;
}

// ── Second calibration kind: map pins ──────────────────────────────────────────────────────────────────
// The corner ornaments above are one kind of calibration target (a px translate offset driven by CSS custom
// properties). A map pin is the second kind: a stage marker positioned by a percentage coordinate inside the
// map image, whose truth source is a JS constant object (academyMapStagePinCoordinates), NOT a CSS token.
// The two kinds share the same tool body — a handle per target, live drag, リセット-to-baseline, an export box
// — but differ in the drag unit (px vs %) and the export format (CSS declarations vs a JS object literal).
// A pin entry is declared as a GROUP (one entry per map + truth source): the individual per-pin handles are
// enumerated at build time from the rendered pin nodes, so the registry stays a small declaration instead of
// duplicating every locationId. The consuming tool maps `coordinatesName` to the real truth-source object.
//
// The academy map screen (#academy-map-stage-layer) hosts more than one map region (学院 / 山林) on the same
// DOM, switched at runtime. A pin group therefore also names the `region` it belongs to; the consuming tool
// activates that region (`?calibrate=academy-map&region=<region>`) so exactly one region's pins are calibrated
// at a time, over the matching background. Structural validation of `region` (non-empty string) lives here;
// whether the string is a real map region id is a domain check the tool performs when it switches region.
export const MAP_PIN_CALIBRATION_KIND = 'map-pins';

export const MAP_PIN_CALIBRATION_TARGETS = Object.freeze([
  Object.freeze({
    kind: MAP_PIN_CALIBRATION_KIND,
    id: 'academy-map-stage-pins',
    label: '学院マップ ピン',
    screen: 'academy-map',
    region: 'academy',
    containerSelector: '#academy-map-stage-layer',
    nodeSelector: '.academy-map-node',
    coordinatesName: 'academyMapStagePinCoordinates'
  }),
  Object.freeze({
    kind: MAP_PIN_CALIBRATION_KIND,
    id: 'sanrin-map-stage-pins',
    label: '山林マップ ピン',
    screen: 'academy-map',
    region: 'sanrin',
    containerSelector: '#academy-map-stage-layer',
    nodeSelector: '.academy-map-node',
    coordinatesName: 'sanrinMapStagePinCoordinates'
  })
]);

const REQUIRED_MAP_PIN_STRING_FIELDS = Object.freeze(['id', 'label', 'screen', 'region', 'containerSelector', 'nodeSelector', 'coordinatesName']);

// Validate one map-pin registry entry. An entry with an unknown `kind`, or a missing/blank required string
// field, fail-fasts rather than being silently accepted — a broken pin registration is a wiring bug.
export function validateMapPinCalibrationTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new Error(`map-pin calibration target must be an object, got ${JSON.stringify(target)}`);
  }
  if (target.kind !== MAP_PIN_CALIBRATION_KIND) {
    throw new Error(`map-pin calibration target ${JSON.stringify(target.id)} has unknown kind ${JSON.stringify(target.kind)} (expected ${JSON.stringify(MAP_PIN_CALIBRATION_KIND)})`);
  }
  for (const field of REQUIRED_MAP_PIN_STRING_FIELDS) {
    const value = target[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`map-pin calibration target ${JSON.stringify(target.id)} field ${field} must be a non-empty string`);
    }
  }
  return target;
}

// Validate the whole map-pin registry: a non-empty array of valid entries with unique ids. Fail-fasts on any
// malformed entry or duplicate id (mirrors validateCalibrationRegistry for the corner kind).
export function validateMapPinCalibrationRegistry(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('map-pin calibration registry must be a non-empty array');
  }
  const seen = new Set();
  for (const target of targets) {
    validateMapPinCalibrationTarget(target);
    if (seen.has(target.id)) {
      throw new Error(`duplicate map-pin calibration target id: ${target.id}`);
    }
    seen.add(target.id);
  }
  return targets;
}

// The union of every kind's targets that belong to a screen. A screen owning no target of either kind
// fail-fasts (never opens an empty calibration overlay). Corners and pins are returned separately because the
// tool builds/exports them differently.
export function calibrationTargetsForScreen(screen) {
  const corners = FRAME_DECORATION_CALIBRATION_TARGETS.filter((target) => target.screen === screen);
  const pins = MAP_PIN_CALIBRATION_TARGETS.filter((target) => target.screen === screen);
  if (corners.length === 0 && pins.length === 0) {
    const knownScreens = [...new Set([
      ...FRAME_DECORATION_CALIBRATION_TARGETS.map((target) => target.screen),
      ...MAP_PIN_CALIBRATION_TARGETS.map((target) => target.screen)
    ])];
    throw new Error(`no calibration targets registered for screen ${JSON.stringify(screen)} (known: ${knownScreens.join(', ') || 'none'})`);
  }
  return { corners, pins };
}

// Round a pin percentage to the granularity that pastes straight back into the JS truth source (one decimal).
// Fail-fasts on a non-finite number instead of emitting `NaN`.
export function roundMapPinCoordinate(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`map pin coordinate must be a finite number, got ${JSON.stringify(value)}`);
  }
  return Math.round(value * 10) / 10;
}

// Format the pin coordinates as a JS object-literal `const` declaration ready to paste back over the truth
// source (e.g. `const academyMapStagePinCoordinates = { … };`). `baseCoordinates` is the full source object
// ({ [id]: {x,y} }); `overrides` supplies the calibrated values for the pins that were dragged. EVERY id in
// the base source is emitted in its declaration order, using the override when present and the base value
// otherwise, so pasting the result replaces the whole object without dropping the pins that never rendered.
// Pure, so the export format is verifiable without the DOM.
export function formatMapPinCoordinatesJs({ coordinatesName, baseCoordinates, overrides = {} } = {}) {
  if (typeof coordinatesName !== 'string' || coordinatesName.trim() === '') {
    throw new Error('formatMapPinCoordinatesJs: coordinatesName must be a non-empty string');
  }
  if (!baseCoordinates || typeof baseCoordinates !== 'object') {
    throw new Error('formatMapPinCoordinatesJs: baseCoordinates must be an object');
  }
  const ids = Object.keys(baseCoordinates);
  if (ids.length === 0) {
    throw new Error('formatMapPinCoordinatesJs: baseCoordinates must contain at least one pin');
  }
  const lines = ids.map((id) => {
    const source = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : baseCoordinates[id];
    if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.y)) {
      throw new Error(`formatMapPinCoordinatesJs: pin ${JSON.stringify(id)} must have finite {x,y}`);
    }
    return `  ${id}: { x: ${roundMapPinCoordinate(source.x)}, y: ${roundMapPinCoordinate(source.y)} }`;
  });
  return `const ${coordinatesName} = {\n${lines.join(',\n')}\n};`;
}
