// 奏楽堂 (concert hall) catalog: the closed-set constants of the FS-20260918-03 contract, the score
// JSON grammar (chord symbols, meters, the skeleton and score validators), and the strict loader of the
// three authored files under data/definitions/game_data/:
//   concert_hall_axes.json      — the 3 axes S2 chooses from (directions / subjects / motif categories)
//   concert_hall_guidance.json  — the S3 guidance looked up by the 3 chosen ids (bands + prose)
//   concert_hall_performer.json — the resident performer's display lines and narration voice
//
// Every other concert-hall module imports its closed sets from here: the LLM module
// (llm/concertHallGeneration.mjs) for the gates and prompts, the 収蔵 surface (concertHallPieces.mjs)
// for the score it stores, the feature owner (routingConcertHall.mjs) and the API. The loader is
// fail-fast: a missing file, a malformed shape, an axis count off by one, an id without exactly one
// guidance row, a band outside the closed range or an unknown instrument all throw at startup. There is
// no default value and no silent fallback for any authored field.
//
// The validators (`validateSkeleton`, `validateConcertHallScore`) return an array of violation names and
// never throw — the callers decide: a generation gate retries on violations, the 収蔵 append and the API
// throw when the array is non-empty.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createStorageApi } from './storage.mjs';

// ---------- closed sets (shared contract) ----------

export const CONCERT_HALL_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db'];
export const CONCERT_HALL_MODES = ['major', 'minor', 'dorian', 'mixolydian', 'lydian'];
// The beat unit is the meter denominator's note value (6/8: one eighth note is one beat).
export const CONCERT_HALL_METERS = ['4/4', '3/4', '6/8'];
export const CONCERT_HALL_TEMPO_RANGE = [40, 200];
export const CONCERT_HALL_CHORD_PATTERN = /^([A-G])(#|b)?(m7b5|dim7|maj7|maj9|7sus4|add9|sus4|sus2|dim|aug|m7|m9|m|7|9)?(\/([A-G])(#|b)?)?$/;
export const CONCERT_HALL_ACCOMPANIMENT_STYLES = ['block', 'arpeggio'];
export const CONCERT_HALL_INSTRUMENTS = ['piano', 'harp', 'celesta', 'vibraphone', 'strings', 'flute'];
// MIDI ranges per track role (inclusive). melody G3–E6, counter G3–G5, accompaniment C3–G5, bass C2–C4.
export const CONCERT_HALL_RANGES = {
  melody: { lo: 55, hi: 88, text: 'G3〜E6' },
  counter: { lo: 55, hi: 79, text: 'G3〜G5' },
  accompaniment: { lo: 48, hi: 79, text: 'C3〜G5' },
  bass: { lo: 36, hi: 60, text: 'C2〜C4' }
};
export const CONCERT_HALL_BEAT_GRID = 0.25;
export const CONCERT_HALL_VELOCITY_RANGE = [1, 127];
export const CONCERT_HALL_SECTION_COUNT_RANGE = [2, 4];
export const CONCERT_HALL_SECTION_BARS_RANGE = [4, 8];
export const CONCERT_HALL_MATERIALS_MAX = 3;
export const CONCERT_HALL_MOTIF_WORDS_RANGE = [1, 3];
export const CONCERT_HALL_GUIDANCE_LINES_RANGE = [2, 4];
export const CONCERT_HALL_SCORE_VERSION = 1;

export const CONCERT_HALL_AXIS_KEYS = ['directions', 'subjects', 'motif_categories'];
export const CONCERT_HALL_AXIS_COUNTS = { directions: 8, subjects: 10, motif_categories: 8 };
export const CONCERT_HALL_AXIS_CUES_RANGE = [3, 6];
export const CONCERT_HALL_DIRECTION_MODES_RANGE = [1, 3];
export const CONCERT_HALL_PERFORMER_KEYS = ['name', 'greeting', 'input_placeholder', 'empty_shelf', 'voice'];

export const CONCERT_HALL_AXES_FILENAME = 'concert_hall_axes.json';
export const CONCERT_HALL_GUIDANCE_FILENAME = 'concert_hall_guidance.json';
export const CONCERT_HALL_PERFORMER_FILENAME = 'concert_hall_performer.json';

const AXIS_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const INSTRUMENT_ROLES = ['melody', 'accompaniment', 'bass'];

// ---------- small helpers ----------

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const CHORD_INTERVALS = {
  '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7], sus2: [0, 2, 7], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9],
  9: [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14], '7sus4': [0, 5, 7, 10], maj9: [0, 4, 7, 11, 14]
};

function accidental(sign) {
  return sign === '#' ? 1 : sign === 'b' ? -1 : 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`concert hall catalog ${label} must be a non-empty string`);
  return value;
}

function assertExactKeys(object, expectedKeys, label) {
  if (!isObject(object)) throw new Error(`concert hall catalog ${label} must be an object`);
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  const matches = actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  if (!matches) throw new Error(`concert hall catalog ${label} keys must be exactly {${expected.join(', ')}}: got {${actual.join(', ')}}`);
}

// ---------- chord / meter / grid grammar ----------

// Parses one chord symbol of the closed grammar into pitch classes; null when the symbol is not in it.
export function parseConcertHallChord(symbol) {
  const match = CONCERT_HALL_CHORD_PATTERN.exec(String(symbol));
  if (!match) return null;
  const root = (PITCH_CLASS[match[1]] + accidental(match[2]) + 12) % 12;
  const quality = match[3] ?? '';
  const bass = match[5] ? (PITCH_CLASS[match[5]] + accidental(match[6]) + 12) % 12 : root;
  return { root, quality, intervals: CHORD_INTERVALS[quality], bass };
}

export function concertHallMeterInfo(meter) {
  if (!CONCERT_HALL_METERS.includes(meter)) throw new Error(`concert hall meter is not in the closed set: ${meter}`);
  const [beatsPerBar, denominator] = meter.split('/').map(Number);
  return { beatsPerBar, denominator };
}

// True when a beat value sits on the 0.25 grid.
export function concertHallOnBeatGrid(value) {
  return Number.isFinite(value) && Math.abs(value / CONCERT_HALL_BEAT_GRID - Math.round(value / CONCERT_HALL_BEAT_GRID)) < 1e-9;
}

// True when two notes of one single-line voice overlap in time (notes carry start_beat / duration_beats).
export function concertHallNotesOverlap(notes) {
  const sorted = [...notes].sort((a, b) => a.start_beat - b.start_beat);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start_beat < sorted[index - 1].start_beat + sorted[index - 1].duration_beats - 1e-9) return true;
  }
  return false;
}

// ---------- skeleton / score validators (violation-name arrays, never throw) ----------

export function validateSkeleton(value) {
  if (!isObject(value)) return ['shape:not-object'];
  const violations = [];
  if (!isNonEmptyString(value.title)) violations.push('shape:title');
  if (!CONCERT_HALL_KEYS.includes(value.key)) violations.push(`unknown-id:key:${value.key}`);
  if (!CONCERT_HALL_MODES.includes(value.mode)) violations.push(`unknown-id:mode:${value.mode}`);
  if (!Number.isInteger(value.tempo) || value.tempo < CONCERT_HALL_TEMPO_RANGE[0] || value.tempo > CONCERT_HALL_TEMPO_RANGE[1]) violations.push(`range:tempo:${value.tempo}`);
  if (!CONCERT_HALL_METERS.includes(value.meter)) violations.push(`unknown-id:meter:${value.meter}`);
  const [sectionMin, sectionMax] = CONCERT_HALL_SECTION_COUNT_RANGE;
  if (!Array.isArray(value.sections) || value.sections.length < sectionMin || value.sections.length > sectionMax) {
    violations.push('count:sections');
    return violations;
  }
  const [barsMin, barsMax] = CONCERT_HALL_SECTION_BARS_RANGE;
  value.sections.forEach((section, index) => {
    if (!isObject(section)) {
      violations.push(`shape:section:${index}`);
      return;
    }
    if (!isNonEmptyString(section.name)) violations.push(`shape:section:${index}:name`);
    if (!Number.isInteger(section.bars) || section.bars < barsMin || section.bars > barsMax) violations.push(`range:section:${index}:bars:${section.bars}`);
    if (!Array.isArray(section.chords)) violations.push(`shape:section:${index}:chords`);
    else {
      if (section.chords.length !== section.bars) violations.push(`count:section:${index}:chords`);
      for (const chord of section.chords) if (!parseConcertHallChord(chord)) violations.push(`chord-grammar:${chord}`);
    }
    if (!isNonEmptyString(section.character)) violations.push(`shape:section:${index}:character`);
  });
  return violations;
}

const SCORE_ROLES = ['melody', 'counter', 'accompaniment', 'bass'];
const SCORE_REQUIRED_ROLES = ['melody', 'accompaniment', 'bass'];

// The score JSON (version 1): the skeleton fields plus tracks in absolute beats. Roles are unique,
// melody / accompaniment / bass are required, counter is optional; overlaps are refused for the
// single-line voices (accompaniment is chordal, so simultaneous notes are its normal shape).
export function validateConcertHallScore(score) {
  if (!isObject(score)) return ['shape:not-object'];
  const violations = [];
  if (score.version !== CONCERT_HALL_SCORE_VERSION) violations.push('shape:version');
  const skeletonViolations = validateSkeleton({ title: score.title, key: score.key, mode: score.mode, tempo: score.tempo, meter: score.meter, sections: score.sections });
  violations.push(...skeletonViolations);
  if (!Array.isArray(score.tracks)) {
    violations.push('shape:tracks');
    return violations;
  }
  if (skeletonViolations.length) return violations;
  const { beatsPerBar } = concertHallMeterInfo(score.meter);
  const total = score.sections.reduce((sum, section) => sum + section.bars * beatsPerBar, 0);
  const roles = new Set();
  const [velocityMin, velocityMax] = CONCERT_HALL_VELOCITY_RANGE;
  for (const track of score.tracks) {
    if (!isObject(track) || !SCORE_ROLES.includes(track.role)) {
      violations.push(`unknown-id:track-role:${track?.role}`);
      continue;
    }
    if (roles.has(track.role)) violations.push(`duplicate:track-role:${track.role}`);
    roles.add(track.role);
    if (!CONCERT_HALL_INSTRUMENTS.includes(track.instrument)) violations.push(`unknown-id:instrument:${track.instrument}`);
    if (!Array.isArray(track.notes) || track.notes.length === 0) {
      violations.push(`empty:${track.role}`);
      continue;
    }
    const range = CONCERT_HALL_RANGES[track.role];
    for (const note of track.notes) {
      if (!isObject(note) || !Number.isInteger(note.midi)) {
        violations.push(`shape:${track.role}`);
        continue;
      }
      if (note.midi < range.lo || note.midi > range.hi) violations.push(`range:${track.role}:${note.midi}`);
      if (!concertHallOnBeatGrid(note.start_beat) || !concertHallOnBeatGrid(note.duration_beats) || note.duration_beats <= 0 || note.start_beat < 0) violations.push(`beat-grid:${track.role}`);
      else if (note.start_beat + note.duration_beats > total + 1e-9) violations.push(`beat-total:${track.role}`);
      if (!Number.isInteger(note.velocity) || note.velocity < velocityMin || note.velocity > velocityMax) violations.push(`range:${track.role}-velocity:${note.velocity}`);
    }
    if (track.role !== 'accompaniment' && track.notes.every((note) => isObject(note) && concertHallOnBeatGrid(note.start_beat) && concertHallOnBeatGrid(note.duration_beats)) && concertHallNotesOverlap(track.notes)) {
      violations.push(`overlap:${track.role}`);
    }
  }
  for (const role of SCORE_REQUIRED_ROLES) if (!roles.has(role)) violations.push(`missing:${role}`);
  return violations;
}

// ---------- authored data validation ----------

function validateAxisEntry(entry, axis, index) {
  const label = `axes.${axis}[${index}]`;
  assertExactKeys(entry, ['id', 'label', 'description', 'cues'], label);
  requireNonEmptyString(entry.id, `${label}.id`);
  if (!AXIS_ID_PATTERN.test(entry.id)) throw new Error(`concert hall catalog ${label}.id must match ${AXIS_ID_PATTERN}: ${entry.id}`);
  requireNonEmptyString(entry.label, `${label}.label`);
  requireNonEmptyString(entry.description, `${label}.description`);
  const [cuesMin, cuesMax] = CONCERT_HALL_AXIS_CUES_RANGE;
  if (!Array.isArray(entry.cues) || entry.cues.length < cuesMin || entry.cues.length > cuesMax) {
    throw new Error(`concert hall catalog ${label}.cues must hold ${cuesMin}〜${cuesMax} strings: ${entry.id}`);
  }
  entry.cues.forEach((cue, cueIndex) => requireNonEmptyString(cue, `${label}.cues[${cueIndex}]`));
  return { id: entry.id, label: entry.label, description: entry.description, cues: [...entry.cues] };
}

// Validates the axes file: exactly the 3 axes with their fixed counts, ids unique within an axis.
export function validateConcertHallAxes(raw) {
  assertExactKeys(raw, CONCERT_HALL_AXIS_KEYS, 'axes');
  const axes = {};
  for (const axis of CONCERT_HALL_AXIS_KEYS) {
    const entries = raw[axis];
    const expected = CONCERT_HALL_AXIS_COUNTS[axis];
    if (!Array.isArray(entries)) throw new Error(`concert hall catalog axes.${axis} must be an array`);
    if (entries.length !== expected) throw new Error(`concert hall catalog axes.${axis} must hold exactly ${expected} entries: got ${entries.length}`);
    const ids = new Set();
    axes[axis] = entries.map((entry, index) => {
      const normalized = validateAxisEntry(entry, axis, index);
      if (ids.has(normalized.id)) throw new Error(`concert hall catalog axes.${axis} id must be unique: ${normalized.id}`);
      ids.add(normalized.id);
      return normalized;
    });
  }
  return axes;
}

function assertGuidanceKeysMatchAxis(rows, axisEntries, axis) {
  if (!isObject(rows)) throw new Error(`concert hall catalog guidance.${axis} must be an object`);
  const axisIds = new Set(axisEntries.map((entry) => entry.id));
  for (const id of axisIds) {
    if (!Object.hasOwn(rows, id)) throw new Error(`concert hall catalog guidance.${axis} is missing the row for ${id}`);
  }
  for (const key of Object.keys(rows)) {
    if (!axisIds.has(key)) throw new Error(`concert hall catalog guidance.${axis} has a row for an unknown id: ${key}`);
  }
}

function validateTempoBand(tempo, label) {
  const [rangeMin, rangeMax] = CONCERT_HALL_TEMPO_RANGE;
  if (!Array.isArray(tempo) || tempo.length !== 2 || !Number.isInteger(tempo[0]) || !Number.isInteger(tempo[1])
    || tempo[0] < rangeMin || tempo[1] > rangeMax || tempo[0] >= tempo[1]) {
    throw new Error(`concert hall catalog ${label}.tempo must be [min, max] integers with ${rangeMin} <= min < max <= ${rangeMax}: ${JSON.stringify(tempo)}`);
  }
  return [tempo[0], tempo[1]];
}

function validateDirectionGuidance(row, id) {
  const label = `guidance.directions.${id}`;
  assertExactKeys(row, ['modes', 'tempo', 'accompaniment', 'instruments', 'harmony', 'dissonance'], label);
  const [modesMin, modesMax] = CONCERT_HALL_DIRECTION_MODES_RANGE;
  if (!Array.isArray(row.modes) || row.modes.length < modesMin || row.modes.length > modesMax) {
    throw new Error(`concert hall catalog ${label}.modes must hold ${modesMin}〜${modesMax} modes`);
  }
  const modes = new Set();
  for (const mode of row.modes) {
    if (!CONCERT_HALL_MODES.includes(mode)) throw new Error(`concert hall catalog ${label}.modes has a mode outside the closed set: ${mode}`);
    if (modes.has(mode)) throw new Error(`concert hall catalog ${label}.modes repeats ${mode}`);
    modes.add(mode);
  }
  const tempo = validateTempoBand(row.tempo, label);
  if (!CONCERT_HALL_ACCOMPANIMENT_STYLES.includes(row.accompaniment)) {
    throw new Error(`concert hall catalog ${label}.accompaniment must be one of ${CONCERT_HALL_ACCOMPANIMENT_STYLES.join('/')}: ${row.accompaniment}`);
  }
  assertExactKeys(row.instruments, INSTRUMENT_ROLES, `${label}.instruments`);
  const instruments = {};
  for (const role of INSTRUMENT_ROLES) {
    const instrument = row.instruments[role];
    if (!CONCERT_HALL_INSTRUMENTS.includes(instrument)) {
      throw new Error(`concert hall catalog ${label}.instruments.${role} is not in the closed set: ${instrument}`);
    }
    instruments[role] = instrument;
  }
  requireNonEmptyString(row.harmony, `${label}.harmony`);
  requireNonEmptyString(row.dissonance, `${label}.dissonance`);
  return { modes: [...row.modes], tempo, accompaniment: row.accompaniment, instruments, harmony: row.harmony, dissonance: row.dissonance };
}

function validateProseGuidance(row, axis, id) {
  const label = `guidance.${axis}.${id}`;
  assertExactKeys(row, ['guidance'], label);
  requireNonEmptyString(row.guidance, `${label}.guidance`);
  return { guidance: row.guidance };
}

// Validates the guidance file against validated axes: every axis id has exactly one row (no hole, no
// extra), direction rows carry bands inside the closed sets, subject / motif rows carry one prose line.
export function validateConcertHallGuidance(raw, axes) {
  assertExactKeys(raw, CONCERT_HALL_AXIS_KEYS, 'guidance');
  for (const axis of CONCERT_HALL_AXIS_KEYS) assertGuidanceKeysMatchAxis(raw[axis], axes[axis], axis);
  return {
    directions: Object.fromEntries(axes.directions.map((entry) => [entry.id, validateDirectionGuidance(raw.directions[entry.id], entry.id)])),
    subjects: Object.fromEntries(axes.subjects.map((entry) => [entry.id, validateProseGuidance(raw.subjects[entry.id], 'subjects', entry.id)])),
    motif_categories: Object.fromEntries(axes.motif_categories.map((entry) => [entry.id, validateProseGuidance(raw.motif_categories[entry.id], 'motif_categories', entry.id)]))
  };
}

// Validates the performer file: exactly the 5 display / voice strings, all non-empty.
export function validateConcertHallPerformer(raw) {
  assertExactKeys(raw, CONCERT_HALL_PERFORMER_KEYS, 'performer');
  return Object.fromEntries(CONCERT_HALL_PERFORMER_KEYS.map((key) => [key, requireNonEmptyString(raw[key], `performer.${key}`)]));
}

// Validates the three files together (the guidance depends on the axes). Returns the normalized catalog.
export function validateConcertHallCatalog({ axes, guidance, performer }) {
  const checkedAxes = validateConcertHallAxes(axes);
  return {
    axes: checkedAxes,
    guidance: validateConcertHallGuidance(guidance, checkedAxes),
    performer: validateConcertHallPerformer(performer)
  };
}

async function readDefinitionJson(definitionsRoot, filename) {
  const fullPath = path.join(definitionsRoot, filename);
  let rawText;
  try {
    rawText = await fs.readFile(fullPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`concert hall catalog file is missing: ${fullPath}`);
    throw error;
  }
  return JSON.parse(rawText);
}

// Loads and validates the three authored files from the definitions root of `root` (a slot root or the
// project root — both resolve the same authored definitions). One read per file, no caching, no default.
export async function loadConcertHallCatalog({ root } = {}) {
  if (!root) throw new Error('root is required');
  const { definitionsRoot } = createStorageApi({ root }).paths;
  const [axes, guidance, performer] = await Promise.all([
    readDefinitionJson(definitionsRoot, CONCERT_HALL_AXES_FILENAME),
    readDefinitionJson(definitionsRoot, CONCERT_HALL_GUIDANCE_FILENAME),
    readDefinitionJson(definitionsRoot, CONCERT_HALL_PERFORMER_FILENAME)
  ]);
  return validateConcertHallCatalog({ axes, guidance, performer });
}

// ---------- S3 guidance (machine lookup over the loaded catalog) ----------

const DIRECTION_FIELDS = [
  { field: 'direction_id', axis: 'directions' },
  { field: 'subject_id', axis: 'subjects' },
  { field: 'motif_category_id', axis: 'motif_categories' }
];

function requireGuidanceEntry(catalog, axis, id) {
  if (!isObject(catalog) || !isObject(catalog[axis])) throw new Error(`concert hall generation guidanceCatalog.${axis} is required`);
  const entry = catalog[axis][id];
  if (!isObject(entry)) throw new Error(`concert hall generation guidance is missing for ${axis}/${id}`);
  return entry;
}

function requireInstrument(value, label) {
  if (!CONCERT_HALL_INSTRUMENTS.includes(value)) throw new Error(`concert hall generation ${label} is not in the closed set: ${value}`);
  return value;
}

function requireAxisEntries(axes, axis) {
  if (!isObject(axes) || !Array.isArray(axes[axis])) throw new Error(`concert hall generation axes.${axis} must be an array`);
  return axes[axis];
}

// Looks the direction / subject / motif-category guidance up by the three chosen ids and lays out the
// 3 guidance lines (2..4 is the contract band) that S4 and S5 carry. Returns the direction's voicing
// too: the accompaniment style and instruments come from the authored row, never from the model.
// `direction` is the validated S2 result ({direction_id, subject_id, motif_category_id}); `axes` and
// `guidanceCatalog` are the loaded catalog's `axes` and `guidance`.
export function resolveConcertHallGuidance({ direction, axes, guidanceCatalog }) {
  const labels = Object.fromEntries(DIRECTION_FIELDS.map(({ field, axis }) => {
    const entry = requireAxisEntries(axes, axis).find((candidate) => candidate?.id === direction?.[field]);
    if (!entry || !isNonEmptyString(entry.label)) throw new Error(`concert hall generation direction ${field} is not an axis id: ${direction?.[field]}`);
    return [field, entry.label];
  }));
  const directionEntry = requireGuidanceEntry(guidanceCatalog, 'directions', direction.direction_id);
  const subjectEntry = requireGuidanceEntry(guidanceCatalog, 'subjects', direction.subject_id);
  const motifEntry = requireGuidanceEntry(guidanceCatalog, 'motif_categories', direction.motif_category_id);
  const modes = directionEntry.modes;
  if (!Array.isArray(modes) || modes.length === 0 || modes.some((mode) => !CONCERT_HALL_MODES.includes(mode))) {
    throw new Error(`concert hall generation guidance modes are invalid for ${direction.direction_id}`);
  }
  const tempo = directionEntry.tempo;
  if (!Array.isArray(tempo) || tempo.length !== 2 || !Number.isInteger(tempo[0]) || !Number.isInteger(tempo[1]) || tempo[0] >= tempo[1]
    || tempo[0] < CONCERT_HALL_TEMPO_RANGE[0] || tempo[1] > CONCERT_HALL_TEMPO_RANGE[1]) {
    throw new Error(`concert hall generation guidance tempo is invalid for ${direction.direction_id}`);
  }
  if (!CONCERT_HALL_ACCOMPANIMENT_STYLES.includes(directionEntry.accompaniment)) {
    throw new Error(`concert hall generation guidance accompaniment is invalid for ${direction.direction_id}`);
  }
  if (!isObject(directionEntry.instruments)) throw new Error(`concert hall generation guidance instruments are required for ${direction.direction_id}`);
  const instruments = {
    melody: requireInstrument(directionEntry.instruments.melody, 'instruments.melody'),
    accompaniment: requireInstrument(directionEntry.instruments.accompaniment, 'instruments.accompaniment'),
    bass: requireInstrument(directionEntry.instruments.bass, 'instruments.bass')
  };
  if (!isNonEmptyString(directionEntry.harmony)) throw new Error('concert hall generation guidance harmony is required');
  if (!isNonEmptyString(directionEntry.dissonance)) throw new Error('concert hall generation guidance dissonance is required');
  if (!isNonEmptyString(subjectEntry.guidance)) throw new Error('concert hall generation subject guidance is required');
  if (!isNonEmptyString(motifEntry.guidance)) throw new Error('concert hall generation motif category guidance is required');
  const lines = [
    `${labels.direction_id}: 旋法は ${modes.join('・')} から選び、速度は ${tempo[0]}〜${tempo[1]} の帯に収める。${directionEntry.harmony.trim()} ${directionEntry.dissonance.trim()} 伴奏は${directionEntry.accompaniment === 'block' ? 'ブロック和音' : '分散和音'}で付く。`,
    `${labels.subject_id}: ${subjectEntry.guidance.trim()}`,
    `${labels.motif_category_id}: ${motifEntry.guidance.trim()}`
  ];
  const [linesMin, linesMax] = CONCERT_HALL_GUIDANCE_LINES_RANGE;
  if (lines.length < linesMin || lines.length > linesMax) throw new Error(`concert hall generation guidance must be ${linesMin}〜${linesMax} lines`);
  return {
    lines,
    labels,
    accompaniment: directionEntry.accompaniment,
    instruments,
    modes: [...modes],
    tempo: [...tempo]
  };
}
