// 奏楽堂 (concert hall) LLM generation: the only place the concert hall talks to the language model.
//
// The piece is written in stages, each a structured_json call (callLmStudioStructuredJson, temperature
// unset = server default), with a machine step in between:
//   S1 materials  — buildMaterialsPrompt: pick 0..3 material ids from the player's closed candidate set
//                   and 1..3 motif words for the free-text wish; one remark to the player.
//   S2 direction  — buildDirectionPrompt: one id per authored axis (direction / subject / motif
//                   category); one remark.
//   S3 guidance   — resolveConcertHallGuidance: no LLM. The 2..4 guidance lines for this piece are
//                   looked up from the authored guidance catalog by the three ids.
//   S4 skeleton   — buildSkeletonPrompt: key / mode / tempo / meter and 2..4 sections, each with bars,
//                   one chord per bar and a character line. The only prompt that carries the short
//                   theory preamble (CONCERT_HALL_THEORY_PREAMBLE); the guidance lines are the main body.
//   S5 sections   — buildSectionPrompt: the melody (plus an optional counter melody) of one section as
//                   token JSON notes. Accompaniment and bass are never asked of the model —
//                   machineAccompaniment voices them from the skeleton chords.
//
// Adopted form and prompt wording come from the reviewed measurement: token JSON, melody
// only, machine voicing, per-stage bounded retry of 3, gate relaxed to melody G3–E6 / 0.25 grid / the
// 9・m9・add9・7sus4・maj9 chord qualities.
//
// Fixed constraints (do not weaken):
//   (1) No finished note sequence is shown as an example at any prompt level. Grammar definitions and
//       schema descriptions are not examples.
//   (2) No music-theory system is laid down as a foundation. S4 alone gets a short constant preamble
//       (key and functional-harmony vocabulary only); it must stay shorter than the injected guidance.
//   (3) The machine gates are the minimum that keeps unplayable output from playing (closed-set ids,
//       ranges, beat totals, grid, chord grammar, overlaps). A violation fails the attempt; nothing is
//       corrected and there is no silent fallback.
//
// Retry: per stage, same input, at most CONCERT_HALL_MAX_ATTEMPTS. Only gate violations are retried;
// LM unconfigured / unreachable / HTTP / parse failures are thrown at once. The retry unit of S5 is
// one section. When every attempt violates, ConcertHallGenerationError (code
// CONCERT_HALL_GENERATION_FAILED, stage, index, violations) is thrown.
//
// The closed-set constants, the chord / meter grammar, the skeleton and score validators and the S3
// guidance lookup live in the catalog module (app/src/concertHallCatalog.mjs); this module imports them.

import { callLmStudioStructuredJson } from './lmStudioClient.mjs';
import {
  CONCERT_HALL_ACCOMPANIMENT_STYLES,
  CONCERT_HALL_BEAT_GRID,
  CONCERT_HALL_GUIDANCE_LINES_RANGE,
  CONCERT_HALL_KEYS,
  CONCERT_HALL_MATERIALS_MAX,
  CONCERT_HALL_METERS,
  CONCERT_HALL_MODES,
  CONCERT_HALL_MOTIF_WORDS_RANGE,
  CONCERT_HALL_RANGES,
  CONCERT_HALL_SCORE_VERSION,
  CONCERT_HALL_SECTION_BARS_RANGE,
  CONCERT_HALL_SECTION_COUNT_RANGE,
  CONCERT_HALL_TEMPO_RANGE,
  CONCERT_HALL_VELOCITY_RANGE,
  concertHallMeterInfo,
  concertHallNotesOverlap,
  concertHallOnBeatGrid,
  parseConcertHallChord,
  resolveConcertHallGuidance,
  validateConcertHallScore,
  validateSkeleton
} from '../concertHallCatalog.mjs';

// Retry cap per stage (total attempts; 1 = no retry). Same shape as OFFER_GENERATION_MAX_ATTEMPTS.
export const CONCERT_HALL_MAX_ATTEMPTS = 3;
export const CONCERT_HALL_GENERATION_FAILED_ERROR_CODE = 'CONCERT_HALL_GENERATION_FAILED';

// Velocities the machine fills in: LLM notes that omit velocity, and the voiced accompaniment/bass.
const DEFAULT_VELOCITY = { melody: 96, counter: 72 };
const VOICING_VELOCITY = { block: { accompaniment: 64, bassRoot: 80, bassFifth: 72 }, arpeggio: { accompaniment: 60, bass: 76 } };
// The section-end breath: the last melody note of every section is shortened by this, never below the grid.
const SECTION_END_BREATH_BEATS = 0.5;

// The S4-only preamble. Key and functional-harmony vocabulary, nothing input-dependent, and by
// construction shorter than the guidance block it sits next to (buildSkeletonPrompt enforces it).
export const CONCERT_HALL_THEORY_PREAMBLE = '前置き（最小限の語彙）: 調（key）は主音、旋法（mode）は音階の性格。機能和声では I（主和音）が安定、V（属和音）が緊張して I へ戻り、IV は橋渡しになる。短調系では i・iv・V と、VI・VII の平行和音も使う。';

export class ConcertHallGenerationError extends Error {
  constructor({ stage, index = null, violations }) {
    super(`concert hall generation failed at ${stage}${index === null ? '' : `[${index}]`}: ${violations.join(', ')}`);
    this.name = 'ConcertHallGenerationError';
    this.code = CONCERT_HALL_GENERATION_FAILED_ERROR_CODE;
    this.errorCode = CONCERT_HALL_GENERATION_FAILED_ERROR_CODE;
    this.statusCode = 503;
    this.stage = stage;
    this.index = index;
    this.violations = violations;
  }
}

// ---------- small helpers ----------

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCH_PATTERN = /^([A-G])(#|b)?(-?\d)$/;

function accidental(sign) {
  return sign === '#' ? 1 : sign === 'b' ? -1 : 0;
}

export function concertHallPitchToMidi(pitch) {
  const match = PITCH_PATTERN.exec(String(pitch));
  if (!match) return null;
  return (Number(match[3]) + 1) * 12 + PITCH_CLASS[match[1]] + accidental(match[2]);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`concert hall generation ${label} is required`);
  return value.trim();
}

function requirePerformer(performer) {
  if (!isObject(performer)) throw new Error('concert hall generation performer is required');
  return { name: requireNonEmptyString(performer.name, 'performer.name'), voice: requireNonEmptyString(performer.voice, 'performer.voice') };
}

function requireLabeled(entry, label) {
  if (!isObject(entry)) throw new Error(`concert hall generation ${label} must be an object`);
  return { id: requireNonEmptyString(entry.id, `${label}.id`), label: requireNonEmptyString(entry.label, `${label}.label`) };
}

function requireLabeledList(list, label) {
  if (!Array.isArray(list)) throw new Error(`concert hall generation ${label} must be an array`);
  return list.map((entry, index) => requireLabeled(entry, `${label}[${index}]`));
}

function requireGuidanceLines(lines) {
  const [min, max] = CONCERT_HALL_GUIDANCE_LINES_RANGE;
  if (!Array.isArray(lines) || lines.length < min || lines.length > max) {
    throw new Error(`concert hall generation guidance must be ${min}〜${max} lines`);
  }
  return lines.map((line, index) => requireNonEmptyString(line, `guidance[${index}]`));
}

function requireAxisList(axes, key) {
  if (!isObject(axes) || !Array.isArray(axes[key])) throw new Error(`concert hall generation axes.${key} must be an array`);
  return axes[key].map((entry, index) => {
    const labeled = requireLabeled(entry, `axes.${key}[${index}]`);
    const cues = entry.cues;
    if (!Array.isArray(cues) || cues.length === 0) throw new Error(`concert hall generation axes.${key}[${index}].cues must be a non-empty array`);
    return {
      ...labeled,
      description: requireNonEmptyString(entry.description, `axes.${key}[${index}].description`),
      cues: cues.map((cue, cueIndex) => requireNonEmptyString(cue, `axes.${key}[${index}].cues[${cueIndex}]`))
    };
  });
}

const AXIS_KEYS = ['directions', 'subjects', 'motif_categories'];

function requireAxes(axes) {
  return Object.fromEntries(AXIS_KEYS.map((key) => [key, requireAxisList(axes, key)]));
}

// ---------- candidate materials (S1 input) ----------

const CANDIDATE_KINDS = [
  { key: 'events', kind: '直近の出来事' },
  { key: 'items', kind: '所持品' },
  { key: 'books', kind: '読んだ本' }
];

// The candidate set flattened to {id, kind, label}; week is context, not a selectable id.
export function concertHallCandidateEntries(candidates) {
  if (!isObject(candidates)) throw new Error('concert hall generation candidates is required');
  const entries = [];
  for (const { key, kind } of CANDIDATE_KINDS) {
    for (const entry of requireLabeledList(candidates[key], `candidates.${key}`)) entries.push({ ...entry, kind });
  }
  if (candidates.buddy !== null) entries.push({ ...requireLabeled(candidates.buddy, 'candidates.buddy'), kind: '同行者' });
  if (!Number.isInteger(candidates.week) || candidates.week < 0) throw new Error('concert hall generation candidates.week must be a non-negative integer');
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`concert hall generation candidate id is duplicated: ${entry.id}`);
    ids.add(entry.id);
  }
  return entries;
}

function candidateLine(entry) {
  return `- ${entry.id}: [${entry.kind}] ${entry.label}`;
}

function performerHeader(performer, doing) {
  return `あなたは学院の奏楽堂に常駐する楽師「${performer.name}」で、${doing}`;
}

function voiceRule(performer) {
  return `語りの文体: ${performer.voice}`;
}

// ---------- S1 materials ----------

export const CONCERT_HALL_MATERIALS_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'concert_hall_materials',
    schema: {
      type: 'object',
      properties: {
        materials: { type: 'array', items: { type: 'string' } },
        motif_words: { type: 'array', items: { type: 'string' } },
        remark: { type: 'string' }
      },
      required: ['materials', 'motif_words', 'remark']
    }
  }
};

export function buildMaterialsPrompt({ freeText, candidates, performer }) {
  const text = requireNonEmptyString(freeText, 'freeText');
  const voice = requirePerformer(performer);
  const entries = concertHallCandidateEntries(candidates);
  const lines = entries.length ? entries.map(candidateLine).join('\n') : '- （候補材料なし）';
  const [motifMin, motifMax] = CONCERT_HALL_MOTIF_WORDS_RANGE;
  return `${performerHeader(voice, 'これから主人公の願いに合わせて一曲を組み立てる。まず、曲の材料になるものを選ぶ。')}

主人公の願い（自由文）:
${text}

いまは入学から ${candidates.week} 週目。

主人公の身の回りにある候補材料（この一覧の id だけを使う。一覧に無い id を作らない）:
${lines}

やること:
- 願いの気分に響き合う材料を候補から 0〜${CONCERT_HALL_MATERIALS_MAX} 個選び、その id を materials に並べる（同じ id を重ねない。願いと無関係なら選ばなくてよい）。
- 願いから曲のモチーフになる言葉（情景・動き・質感を表す短い語）を ${motifMin}〜${motifMax} 個、motif_words に日本語で書く。
- remark に、楽師として主人公へ一言だけ（1 文・40 字以内・改行なし・鉤括弧なし）語りかける。
${voiceRule(voice)}

JSON だけを返す。`;
}

export function validateMaterials(value, { candidateIds }) {
  if (!(candidateIds instanceof Set)) throw new Error('validateMaterials requires candidateIds as a Set');
  if (!isObject(value)) return ['shape:not-object'];
  const violations = [];
  if (!Array.isArray(value.materials)) violations.push('shape:materials');
  else {
    if (value.materials.length > CONCERT_HALL_MATERIALS_MAX) violations.push('count:materials');
    const seen = new Set();
    for (const id of value.materials) {
      if (!candidateIds.has(id)) violations.push(`unknown-id:materials:${id}`);
      if (seen.has(id)) violations.push(`duplicate:materials:${id}`);
      seen.add(id);
    }
  }
  const [motifMin, motifMax] = CONCERT_HALL_MOTIF_WORDS_RANGE;
  if (!Array.isArray(value.motif_words) || value.motif_words.some((word) => !isNonEmptyString(word))) violations.push('shape:motif_words');
  else if (value.motif_words.length < motifMin || value.motif_words.length > motifMax) violations.push('count:motif_words');
  violations.push(...validateRemark(value.remark));
  return violations;
}

function validateRemark(remark) {
  if (!isNonEmptyString(remark)) return ['shape:remark'];
  if (/\n/.test(remark)) return ['format:remark'];
  return [];
}

// ---------- S2 direction ----------

export const CONCERT_HALL_DIRECTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'concert_hall_direction',
    schema: {
      type: 'object',
      properties: {
        direction_id: { type: 'string' },
        subject_id: { type: 'string' },
        motif_category_id: { type: 'string' },
        remark: { type: 'string' }
      },
      required: ['direction_id', 'subject_id', 'motif_category_id', 'remark']
    }
  }
};

function axisLines(entries) {
  return entries.map((entry) => `- ${entry.id}: ${entry.label} — ${entry.description}（徴候: ${entry.cues.join('、')}）`).join('\n');
}

function selectedMaterialLines(materials, candidates) {
  const entries = concertHallCandidateEntries(candidates);
  if (!Array.isArray(materials?.materials) || !Array.isArray(materials?.motif_words)) throw new Error('concert hall generation materials must be a validated S1 result');
  if (materials.materials.length === 0) return '- （選ばれた材料なし）';
  return materials.materials.map((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`concert hall generation selected material is not a candidate: ${id}`);
    return candidateLine(entry);
  }).join('\n');
}

export function buildDirectionPrompt({ freeText, materials, candidates, axes, performer }) {
  const text = requireNonEmptyString(freeText, 'freeText');
  const voice = requirePerformer(performer);
  const checkedAxes = requireAxes(axes);
  const materialLines = selectedMaterialLines(materials, candidates);
  return `${performerHeader(voice, '主人公の願いに合わせて一曲を組み立てている。いま、曲の方向・題材・モチーフの分類を一つずつ決める。')}

主人公の願い（自由文）:
${text}

選ばれた材料:
${materialLines}

モチーフの言葉: ${materials.motif_words.join('、')}

方向（direction_id はこの一覧の id から 1 つ。一覧に無い id を作らない。徴候は、願いにその気配があればその方向を選ぶ手がかり）:
${axisLines(checkedAxes.directions)}

題材（subject_id はこの一覧の id から 1 つ）:
${axisLines(checkedAxes.subjects)}

モチーフの分類（motif_category_id はこの一覧の id から 1 つ）:
${axisLines(checkedAxes.motif_categories)}

やること:
- 願いの気分と材料に最も合う方向・題材・モチーフ分類を 1 つずつ選ぶ。願いの気分と食い違う方向を選ばない。
- remark に、楽師として「こういう曲にしよう」と主人公へ一言（1 文・50 字以内・改行なし・鉤括弧なし）。
${voiceRule(voice)}

JSON だけを返す。`;
}

const DIRECTION_FIELDS = [
  { field: 'direction_id', axis: 'directions' },
  { field: 'subject_id', axis: 'subjects' },
  { field: 'motif_category_id', axis: 'motif_categories' }
];

export function validateDirection(value, { axes }) {
  const checkedAxes = requireAxes(axes);
  if (!isObject(value)) return ['shape:not-object'];
  const violations = [];
  for (const { field, axis } of DIRECTION_FIELDS) {
    if (!checkedAxes[axis].some((entry) => entry.id === value[field])) violations.push(`unknown-id:${field}:${value[field]}`);
  }
  violations.push(...validateRemark(value.remark));
  return violations;
}

// ---------- S4 skeleton ----------

export const CONCERT_HALL_SKELETON_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'concert_hall_skeleton',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        key: { type: 'string' },
        mode: { type: 'string' },
        tempo: { type: 'integer' },
        meter: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              bars: { type: 'integer' },
              chords: { type: 'array', items: { type: 'string' } },
              character: { type: 'string' }
            },
            required: ['name', 'bars', 'chords', 'character']
          }
        }
      },
      required: ['title', 'key', 'mode', 'tempo', 'meter', 'sections']
    }
  }
};

export const CONCERT_HALL_CHORD_GRAMMAR_TEXT = `コード記号の文法（この形だけを受理する。他の書き方は不合格）:
  <根音><種類>[/<低音>]
  根音・低音: C D E F G A B のいずれかに、必要なら # か b を 1 つ付ける（例: F#, Bb）
  種類: 無印（長三和音）, m, dim, aug, 7, m7, maj7, 9, m9, maj9, add9, sus4, sus2, 7sus4, m7b5, dim7 のいずれか
  例示ではなく文法として: 根音 G と種類 m7 なら "Gm7"、低音 B を添えるなら "G/B"。空白・括弧・「N.C.」・ローマ数字は使わない。`;

function guidanceBlock(lines) {
  return `この曲に効く指南（守ること）:
${lines.map((line) => `- ${line}`).join('\n')}`;
}

export function buildSkeletonPrompt({ freeText, materials, direction, guidance, performer }) {
  const text = requireNonEmptyString(freeText, 'freeText');
  const voice = requirePerformer(performer);
  const lines = requireGuidanceLines(guidance);
  if (!Array.isArray(materials?.motif_words)) throw new Error('concert hall generation materials must be a validated S1 result');
  if (!isObject(direction?.labels) || !isObject(direction?.ids)) throw new Error('concert hall generation direction must carry ids and labels');
  const guidanceBytes = Buffer.byteLength(lines.join('\n'), 'utf8');
  const preambleBytes = Buffer.byteLength(CONCERT_HALL_THEORY_PREAMBLE, 'utf8');
  if (preambleBytes >= guidanceBytes) {
    throw new Error(`concert hall generation theory preamble (${preambleBytes} bytes) must stay shorter than the guidance (${guidanceBytes} bytes)`);
  }
  const [sectionMin, sectionMax] = CONCERT_HALL_SECTION_COUNT_RANGE;
  const [barsMin, barsMax] = CONCERT_HALL_SECTION_BARS_RANGE;
  return `${performerHeader(voice, '主人公の願いに合わせて一曲の骨子を書く。この段では音符は書かず、調・速度・拍子と、節ごとの小節数・コード進行・性格だけを決める。')}

主人公の願い（自由文）:
${text}

決まっていること:
- モチーフの言葉: ${materials.motif_words.join('、')}
- 方向: ${direction.labels.direction_id}（${direction.ids.direction_id}）
- 題材: ${direction.labels.subject_id}（${direction.ids.subject_id}）
- モチーフの分類: ${direction.labels.motif_category_id}（${direction.ids.motif_category_id}）

${guidanceBlock(lines)}

${CONCERT_HALL_THEORY_PREAMBLE}

出力の各欄:
- title: 曲の題（日本語・20 字以内・鉤括弧なし）。
- key: ${CONCERT_HALL_KEYS.join(', ')} のいずれか（主音）。
- mode: ${CONCERT_HALL_MODES.join(', ')} のいずれか。指南の方向に合うものを選ぶ。
- tempo: ${CONCERT_HALL_TEMPO_RANGE[0]}〜${CONCERT_HALL_TEMPO_RANGE[1]} の整数（1 分あたりの拍数。拍の単位は拍子記号の分母の音価）。指南の速度の帯に収める。
- meter: ${CONCERT_HALL_METERS.join(', ')} のいずれか。
- sections: ${sectionMin}〜${sectionMax} 個の節。各節は name（日本語の短い名）、bars（${barsMin}〜${barsMax} の整数）、chords（小節ごとに 1 つ、bars と同じ個数のコード記号の配列。1 小節 1 コード）、character（その節の性格を 1 文で）。
${CONCERT_HALL_CHORD_GRAMMAR_TEXT}

同じ願いでも毎回違う曲になるように、調・速度・進行は指南の帯の中で自由に選ぶ。JSON だけを返す。`;
}

// ---------- S5 section notes ----------

const NOTE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      pitch: { type: 'string' },
      start_beat: { type: 'number' },
      duration_beats: { type: 'number' },
      velocity: { type: 'integer' }
    },
    required: ['pitch', 'start_beat', 'duration_beats']
  }
};

export const CONCERT_HALL_SECTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'concert_hall_section_notes',
    schema: {
      type: 'object',
      properties: { melody: NOTE_SCHEMA, counter: NOTE_SCHEMA },
      required: ['melody', 'counter']
    }
  }
};

export const CONCERT_HALL_TOKEN_GRAMMAR_TEXT = `音符の書き方（token JSON・文法）:
  各音は object {"pitch": <音名>, "start_beat": <数>, "duration_beats": <数>, "velocity": <${CONCERT_HALL_VELOCITY_RANGE[0]}〜${CONCERT_HALL_VELOCITY_RANGE[1]} の整数・省略可>}。
  <音名> は C D E F G A B のいずれかに、必要なら # か b を 1 つ付け、続けてオクターブ番号を付ける（C4 が中央ハ。文法として: 根音 F・シャープ・オクターブ 4 なら "F#4"）。
  start_beat は節の先頭を 0 とした拍位置、duration_beats は長さ。どちらも ${CONCERT_HALL_BEAT_GRID} 刻みの数。拍の単位は拍子記号の分母の音価（4/4 なら 4 分音符が 1 拍、6/8 なら 8 分音符が 1 拍）。
  音を置かない時間は休符として単に空けてよい（休符 object は書かない）。`;

function requireSkeleton(skeleton) {
  const violations = validateSkeleton(skeleton);
  if (violations.length) throw new Error(`concert hall generation skeleton is invalid: ${violations.join(', ')}`);
  return skeleton;
}

export function buildSectionPrompt({ skeleton, sectionIndex, guidance, performer }) {
  const voice = requirePerformer(performer);
  const lines = requireGuidanceLines(guidance);
  requireSkeleton(skeleton);
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= skeleton.sections.length) {
    throw new Error(`concert hall generation sectionIndex is out of range: ${sectionIndex}`);
  }
  const section = skeleton.sections[sectionIndex];
  const { beatsPerBar } = concertHallMeterInfo(skeleton.meter);
  const total = beatsPerBar * section.bars;
  return `${performerHeader(voice, '骨子を決めた曲の一つの節に音符を書き込む。')}

曲の骨子:
- 題: ${skeleton.title}
- 調・旋法: ${skeleton.key} ${skeleton.mode}
- 速度: ${skeleton.tempo}
- 拍子: ${skeleton.meter}（1 小節 ${beatsPerBar} 拍）
- 節の並び: ${skeleton.sections.map((entry, index) => `${index + 1}.${entry.name}(${entry.bars}小節)`).join(' → ')}

いま書く節: ${sectionIndex + 1}. ${section.name}（${section.bars} 小節・合計 ${total} 拍）
- 小節ごとのコード: ${section.chords.map((chord, index) => `${index + 1}:${chord}`).join(' ')}
- この節の性格: ${section.character}

${guidanceBlock(lines)}

${CONCERT_HALL_TOKEN_GRAMMAR_TEXT}

声部は melody だけを書く（counter は任意）:
- melody（旋律・音域 ${CONCERT_HALL_RANGES.melody.text}）: 単旋律。音が重ならないように順に並べ、節の最後の音の終わりが合計拍数 ${total} にちょうど一致する。
- counter（対旋律・音域 ${CONCERT_HALL_RANGES.counter.text}・任意）: 書くなら単旋律で、最後の音の終わりが ${total} に一致する。書かないなら空の配列。
伴奏と低音は書かない（小節ごとのコードから機械が付ける）。

音域を外れる音・合計拍数に合わない声部は不合格になる。JSON だけを返す。`;
}

// Parses one voice of token-JSON notes into {midi, start_beat, duration_beats, velocity} (section-relative
// beats) and lists its violations. A note that cannot be placed (bad pitch or off-grid) is dropped from
// the parsed list so the later checks describe the rest; the violation still fails the attempt.
function parseVoice(role, notes, { total }) {
  if (!Array.isArray(notes)) return { violations: [`shape:${role}`], notes: [] };
  const violations = [];
  const parsed = [];
  const range = CONCERT_HALL_RANGES[role];
  const [velocityMin, velocityMax] = CONCERT_HALL_VELOCITY_RANGE;
  for (const note of notes) {
    if (!isObject(note)) {
      violations.push(`shape:${role}`);
      continue;
    }
    const midi = concertHallPitchToMidi(note.pitch);
    if (midi === null) {
      violations.push(`pitch-grammar:${role}:${note.pitch}`);
      continue;
    }
    if (!concertHallOnBeatGrid(note.start_beat) || !concertHallOnBeatGrid(note.duration_beats) || note.duration_beats <= 0 || note.start_beat < 0) {
      violations.push(`beat-grid:${role}`);
      continue;
    }
    if (note.velocity !== undefined && (!Number.isInteger(note.velocity) || note.velocity < velocityMin || note.velocity > velocityMax)) {
      violations.push(`range:${role}-velocity:${note.velocity}`);
    }
    if (midi < range.lo || midi > range.hi) violations.push(`range:${role}:${note.pitch}`);
    parsed.push({ midi, start_beat: note.start_beat, duration_beats: note.duration_beats, velocity: note.velocity ?? DEFAULT_VELOCITY[role] });
  }
  if (parsed.length === 0) {
    violations.push(`empty:${role}`);
    return { violations, notes: parsed };
  }
  const end = Math.max(...parsed.map((note) => note.start_beat + note.duration_beats));
  if (Math.abs(end - total) > 1e-9) violations.push(`beat-total:${role}`);
  if (concertHallNotesOverlap(parsed)) violations.push(`overlap:${role}`);
  return { violations, notes: parsed };
}

function sectionTotalBeats(section, meter) {
  if (!isObject(section) || !Number.isInteger(section.bars) || section.bars <= 0) throw new Error('validateSectionNotes requires a section with integer bars');
  return concertHallMeterInfo(meter).beatsPerBar * section.bars;
}

export function validateSectionNotes(value, { section, meter }) {
  const total = sectionTotalBeats(section, meter);
  if (!isObject(value)) return ['shape:not-object'];
  const violations = [...parseVoice('melody', value.melody, { total }).violations];
  if (Array.isArray(value.counter) && value.counter.length > 0) violations.push(...parseVoice('counter', value.counter, { total }).violations);
  else if (!Array.isArray(value.counter)) violations.push('shape:counter');
  return violations;
}

// The validated S5 voices as parsed notes (section-relative beats). Only meaningful after
// validateSectionNotes returned no violations.
function parseSectionNotes(value, { section, meter }) {
  const total = sectionTotalBeats(section, meter);
  const melody = parseVoice('melody', value.melody, { total }).notes;
  const counter = value.counter.length > 0 ? parseVoice('counter', value.counter, { total }).notes : [];
  return { melody, counter };
}

// ---------- machine voicing (accompaniment / bass from the skeleton chords) ----------

// Closed-position voicing: every chord tone folded into the octave around the range centre, sorted.
function voiceChordInRange(chord, { lo, hi }) {
  const center = (lo + hi) / 2;
  const notes = chord.intervals.map((interval) => {
    const pitchClass = (chord.root + interval) % 12;
    let midi = pitchClass + 12 * Math.floor(center / 12);
    while (midi < lo) midi += 12;
    while (midi > hi) midi -= 12;
    return midi;
  });
  return [...new Set(notes)].sort((a, b) => a - b);
}

// Arpeggio order: the root near the range centre, then the chord's next two intervals (third and
// fifth for triads; the suspended note stands in for the third) stacked upward inside the range.
function arpeggioTones(chord, { lo, hi }) {
  const center = (lo + hi) / 2;
  let root = chord.root + 12 * Math.floor(center / 12);
  while (root < lo) root += 12;
  while (root > hi) root -= 12;
  const tones = [root];
  for (const interval of chord.intervals.slice(1, 3)) {
    let midi = ((chord.root + interval) % 12) + 12 * Math.floor(root / 12);
    while (midi < root) midi += 12;
    while (midi > hi) midi -= 12;
    tones.push(midi);
  }
  return tones;
}

function bassMidiFor(chord) {
  const { lo, hi } = CONCERT_HALL_RANGES.bass;
  let midi = chord.bass + 36;
  while (midi < lo) midi += 12;
  // Keep a fifth above the root inside the range too (block style alternates root → fifth).
  while (midi > hi - 12) midi -= 12;
  return midi;
}

// Voices accompaniment and bass for the whole piece from the skeleton chords, in absolute beats.
//   block:    each bar split in two; the chord tones in closed position (C3–G5) on both halves, the
//             bass root on the first half and its fifth on the second.
//   arpeggio: the chord tones in the order [root, 3rd, 5th, 3rd] one beat each across the bar (the
//             root near the range centre, 3rd and 5th stacked above it); the bass root for the whole bar.
// A slash chord puts the slash note in the bass.
export function machineAccompaniment({ skeleton, guidance }) {
  requireSkeleton(skeleton);
  if (!isObject(guidance) || !CONCERT_HALL_ACCOMPANIMENT_STYLES.includes(guidance.accompaniment)) {
    throw new Error('machineAccompaniment requires guidance.accompaniment as block or arpeggio');
  }
  const style = guidance.accompaniment;
  const { beatsPerBar } = concertHallMeterInfo(skeleton.meter);
  const accompaniment = [];
  const bass = [];
  let offset = 0;
  for (const section of skeleton.sections) {
    section.chords.forEach((symbol, bar) => {
      const chord = parseConcertHallChord(symbol);
      const start = offset + bar * beatsPerBar;
      const tones = voiceChordInRange(chord, CONCERT_HALL_RANGES.accompaniment);
      const bassMidi = bassMidiFor(chord);
      if (style === 'block') {
        const half = beatsPerBar / 2;
        const velocities = VOICING_VELOCITY.block;
        for (const halfStart of [start, start + half]) {
          for (const midi of tones) accompaniment.push({ midi, start_beat: halfStart, duration_beats: half, velocity: velocities.accompaniment });
        }
        bass.push({ midi: bassMidi, start_beat: start, duration_beats: half, velocity: velocities.bassRoot });
        bass.push({ midi: bassMidi + 7, start_beat: start + half, duration_beats: half, velocity: velocities.bassFifth });
      } else {
        const velocities = VOICING_VELOCITY.arpeggio;
        const order = arpeggioTones(chord, CONCERT_HALL_RANGES.accompaniment);
        for (let beat = 0; beat < beatsPerBar; beat += 1) {
          const midi = order[[0, 1, 2, 1][beat % 4]];
          accompaniment.push({ midi, start_beat: start + beat, duration_beats: 1, velocity: velocities.accompaniment });
        }
        bass.push({ midi: bassMidi, start_beat: start, duration_beats: beatsPerBar, velocity: velocities.bass });
      }
    });
    offset += section.bars * beatsPerBar;
  }
  return { accompaniment, bass };
}

// ---------- score assembly ----------

// Shortens the melody notes that close a section by the breath (never below the grid) so that phrases
// do not run into each other — the model writes no rests.
function breathe(notes, total) {
  return notes.map((note) => {
    if (Math.abs(note.start_beat + note.duration_beats - total) > 1e-9) return note;
    return { ...note, duration_beats: Math.max(CONCERT_HALL_BEAT_GRID, note.duration_beats - SECTION_END_BREATH_BEATS) };
  });
}

// Joins the validated per-section voices into the absolute-beat score JSON (version 1).
export function assembleConcertHallScore({ skeleton, sectionNotes, guidance }) {
  requireSkeleton(skeleton);
  if (!Array.isArray(sectionNotes) || sectionNotes.length !== skeleton.sections.length) {
    throw new Error('assembleConcertHallScore requires one validated notes object per section');
  }
  if (!isObject(guidance?.instruments)) throw new Error('assembleConcertHallScore requires guidance.instruments');
  const { beatsPerBar } = concertHallMeterInfo(skeleton.meter);
  const melody = [];
  const counter = [];
  let offset = 0;
  skeleton.sections.forEach((section, index) => {
    const total = section.bars * beatsPerBar;
    const violations = validateSectionNotes(sectionNotes[index], { section, meter: skeleton.meter });
    if (violations.length) throw new Error(`assembleConcertHallScore section ${index} notes are invalid: ${violations.join(', ')}`);
    const parsed = parseSectionNotes(sectionNotes[index], { section, meter: skeleton.meter });
    for (const note of breathe(parsed.melody, total)) melody.push({ ...note, start_beat: note.start_beat + offset });
    for (const note of parsed.counter) counter.push({ ...note, start_beat: note.start_beat + offset });
    offset += total;
  });
  const voiced = machineAccompaniment({ skeleton, guidance });
  const tracks = [
    { role: 'melody', instrument: guidance.instruments.melody, notes: melody },
    ...(counter.length ? [{ role: 'counter', instrument: guidance.instruments.melody, notes: counter }] : []),
    { role: 'accompaniment', instrument: guidance.instruments.accompaniment, notes: voiced.accompaniment },
    { role: 'bass', instrument: guidance.instruments.bass, notes: voiced.bass }
  ];
  const score = {
    version: CONCERT_HALL_SCORE_VERSION,
    title: skeleton.title,
    key: skeleton.key,
    mode: skeleton.mode,
    tempo: skeleton.tempo,
    meter: skeleton.meter,
    sections: skeleton.sections.map((section) => ({ name: section.name, bars: section.bars, chords: [...section.chords], character: section.character })),
    tracks
  };
  const violations = validateConcertHallScore(score);
  if (violations.length) throw new Error(`assembleConcertHallScore produced an invalid score: ${violations.join(', ')}`);
  return score;
}

// ---------- orchestration ----------

// One stage: the same prompt is sent at most CONCERT_HALL_MAX_ATTEMPTS times and only a gate
// violation spends an attempt. Transport / HTTP / parse errors from lmStudioClient propagate as they are.
async function runGatedStage({ stage, index = null, config, fetchImpl, prompt, responseFormat, title, validate }) {
  let violations = [];
  for (let attempt = 1; attempt <= CONCERT_HALL_MAX_ATTEMPTS; attempt += 1) {
    const candidate = await callLmStudioStructuredJson({ config, prompt, fetchImpl, responseFormat, title });
    violations = validate(candidate);
    if (violations.length === 0) return candidate;
  }
  throw new ConcertHallGenerationError({ stage, index, violations });
}

export async function generateConcertHallPiece({ config, fetchImpl, freeText, candidates, axes, guidanceCatalog, performer, onStage }) {
  if (typeof onStage !== 'function') throw new Error('concert hall generation onStage is required');
  const text = requireNonEmptyString(freeText, 'freeText');
  const voice = requirePerformer(performer);
  const candidateIds = new Set(concertHallCandidateEntries(candidates).map((entry) => entry.id));
  const checkedAxes = requireAxes(axes);

  const materials = await runGatedStage({
    stage: 'materials', config, fetchImpl, title: '奏楽堂 材料選び',
    prompt: buildMaterialsPrompt({ freeText: text, candidates, performer: voice }),
    responseFormat: CONCERT_HALL_MATERIALS_RESPONSE_FORMAT,
    validate: (candidate) => validateMaterials(candidate, { candidateIds })
  });
  await onStage({ stage: 'materials', payload: materials });

  const direction = await runGatedStage({
    stage: 'direction', config, fetchImpl, title: '奏楽堂 方向決め',
    prompt: buildDirectionPrompt({ freeText: text, materials, candidates, axes: checkedAxes, performer: voice }),
    responseFormat: CONCERT_HALL_DIRECTION_RESPONSE_FORMAT,
    validate: (candidate) => validateDirection(candidate, { axes: checkedAxes })
  });
  await onStage({ stage: 'direction', payload: direction });

  const guidance = resolveConcertHallGuidance({ direction, axes: checkedAxes, guidanceCatalog });
  await onStage({ stage: 'guidance', payload: { lines: guidance.lines } });

  const directionForPrompt = {
    ids: { direction_id: direction.direction_id, subject_id: direction.subject_id, motif_category_id: direction.motif_category_id },
    labels: guidance.labels
  };
  const skeleton = await runGatedStage({
    stage: 'skeleton', config, fetchImpl, title: '奏楽堂 骨子',
    prompt: buildSkeletonPrompt({ freeText: text, materials, direction: directionForPrompt, guidance: guidance.lines, performer: voice }),
    responseFormat: CONCERT_HALL_SKELETON_RESPONSE_FORMAT,
    validate: validateSkeleton
  });
  await onStage({ stage: 'skeleton', payload: skeleton });

  const sectionNotes = [];
  for (let index = 0; index < skeleton.sections.length; index += 1) {
    const section = skeleton.sections[index];
    const notes = await runGatedStage({
      stage: 'section', index, config, fetchImpl, title: `奏楽堂 節 ${index + 1}`,
      prompt: buildSectionPrompt({ skeleton, sectionIndex: index, guidance: guidance.lines, performer: voice }),
      responseFormat: CONCERT_HALL_SECTION_RESPONSE_FORMAT,
      validate: (candidate) => validateSectionNotes(candidate, { section, meter: skeleton.meter })
    });
    sectionNotes.push(notes);
    await onStage({ stage: 'section', index, payload: notes });
  }

  const score = assembleConcertHallScore({ skeleton, sectionNotes, guidance });
  return {
    materials,
    direction,
    guidance: guidance.lines,
    skeleton,
    score,
    narration: {
      materials: materials.remark,
      direction: direction.remark,
      guidance: guidance.lines,
      skeleton: skeleton.sections.map((section) => section.character)
    }
  };
}
