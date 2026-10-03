// Pure, DOM-independent 奏楽堂 (concert hall) screen contract, shared by app.js and the headless unit tests
// (the same seam as workshopArrivalClient.js): the fail-fast validators for the arrival payload
// (GET /api/concert-hall), the compose SSE events (POST /api/concert-hall/compose: stage / done / error), the
// 収蔵 piece (GET /api/concert-hall/pieces/<id>) and the score JSON, plus the screen's closed 9-state machine.
// app.js imports these and only assembles the DOM around them — no inline re-implementation.
//
// The stage output of the composer is the 楽師's PRE-PERFORMANCE narration: the stage cards on the 語り面 are
// filled in the order the events arrive, and a piece replayed from the shelf re-shows its saved narration
// (no LM involved). Everything validated here is exact-keys: a surplus key, a missing key, an unknown stage or
// a malformed score is a contract break → throw before any DOM mutation (never a partially drawn card).

// The nine screen states (the board-approved layout §2). The 作曲中 state carries the running stage in the
// separate `stage` slot (S1 / S2 / S4 / S5 — the machine S3 guidance arrives in the same breath as S2).
export const CONCERT_HALL_STATES = Object.freeze([
  'arrived',    // 1 到着: 棚面, empty input, 奏でてもらう disabled
  'typing',     // 2 入力中: 棚面, text in the input, 奏でてもらう enabled
  'composing',  // 3 作曲中: 語り面, busy on the running stage, input + 奏でてもらう disabled
  'narrated',   // 4 演奏前の語り: 語り面 + 「演奏を始める」, input enabled (another piece may be asked)
  'playing',    // 5 演奏中: 演奏面, input + 奏でてもらう disabled
  'played',     // 6 演奏後: 棚面 with the new piece on top, highlighted
  'shelf',      // 7 棚: 棚面 (after a replay ended), no highlight
  'replaying',  // 8 再演: 演奏面 with the saved narration
  'error'       // 9 LM エラー: 語り面, the failed stage card carries the message + 「もう一度」
]);

// The closed transition table. Only these edges exist; anything else is a programming error → throw.
//   到着 → 入力中 → 作曲中 → 演奏前 → 演奏中 → 演奏後,  演奏後 / 到着 / 棚 → 再演 → 棚 (再演 ends),
//   any state → LM エラー (the compose stream closed with `error`),  エラー → もう一度 → 作曲中.
// The loops back: emptying the input returns 入力中 → 到着; asking for another piece from 演奏前 / エラー /
// 演奏後 / 棚 goes through 入力中 (or straight to 作曲中 where the input is already live: 演奏前 / エラー).
export const CONCERT_HALL_TRANSITIONS = Object.freeze({
  arrived: Object.freeze(['typing', 'replaying', 'error']),
  typing: Object.freeze(['composing', 'arrived', 'replaying', 'error']),
  composing: Object.freeze(['narrated', 'error']),
  narrated: Object.freeze(['playing', 'composing', 'error']),
  playing: Object.freeze(['played', 'error']),
  played: Object.freeze(['typing', 'replaying', 'error']),
  shelf: Object.freeze(['typing', 'replaying', 'error']),
  replaying: Object.freeze(['shelf', 'error']),
  error: Object.freeze(['composing', 'typing', 'error'])
});

// The compose stages in stream order; `section` repeats once per skeleton section (index 0..n-1).
export const CONCERT_HALL_STAGES = Object.freeze(['materials', 'direction', 'guidance', 'skeleton', 'section']);

// The four fixed stage cards of the 語り面 (S1 → S2 → S3 → S4), in display order; the section cards (S5) follow.
export const CONCERT_HALL_STAGE_CARDS = Object.freeze([
  Object.freeze({ stage: 'materials', title: '拾った材料' }),
  Object.freeze({ stage: 'direction', title: '方向' }),
  Object.freeze({ stage: 'guidance', title: 'この曲に効く指南' }),
  Object.freeze({ stage: 'skeleton', title: '骨子' })
]);

export const CONCERT_HALL_INSTRUMENTS = Object.freeze(['piano', 'harp', 'celesta', 'vibraphone', 'strings', 'flute']);
export const CONCERT_HALL_METERS = Object.freeze(['4/4', '3/4', '6/8']);
export const CONCERT_HALL_TEMPO_RANGE = Object.freeze([40, 200]);
export const CONCERT_HALL_SCORE_ROLES = Object.freeze(['melody', 'counter', 'accompaniment', 'bass']);
export const CONCERT_HALL_SCORE_REQUIRED_ROLES = Object.freeze(['melody', 'accompaniment', 'bass']);
export const CONCERT_HALL_MODE_LABELS = Object.freeze({ major: '長調', minor: '短調', dorian: 'ドリア旋法', mixolydian: 'ミクソリディア旋法', lydian: 'リディア旋法' });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function assertExactKeys(value, keys, label) {
  if (!isObject(value)) throw new Error(`concert hall ${label} must be an object`);
  const present = Object.keys(value);
  const missing = keys.filter((key) => !present.includes(key));
  const surplus = present.filter((key) => !keys.includes(key));
  if (missing.length || surplus.length) {
    throw new Error(`concert hall ${label} keys must be exactly {${keys.join(', ')}}: missing [${missing.join(', ')}] surplus [${surplus.join(', ')}]`);
  }
}

function requireNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`concert hall ${label} must be a non-empty string`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`concert hall ${label} must be a non-negative integer: ${value}`);
  return value;
}

function requireStringList(value, label) {
  if (!Array.isArray(value)) throw new Error(`concert hall ${label} must be an array`);
  value.forEach((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
  return [...value];
}

// ---------- state machine ----------

// The single transition rule: (from, to) must be an edge of CONCERT_HALL_TRANSITIONS. Returns `to`.
export function transitionConcertHallState(from, to) {
  if (!CONCERT_HALL_STATES.includes(from)) throw new Error(`concert hall state is not in the closed set: ${from}`);
  if (!CONCERT_HALL_STATES.includes(to)) throw new Error(`concert hall state is not in the closed set: ${to}`);
  if (!CONCERT_HALL_TRANSITIONS[from].includes(to)) throw new Error(`concert hall state transition is not allowed: ${from} → ${to}`);
  return to;
}

// A tiny holder around the rule: `state`, `stage` (the running compose stage while composing, else null) and
// `transition(to, { stage })`. Re-entering `composing` for the next stage is not a transition — `setStage`.
export function createConcertHallStateMachine() {
  let state = 'arrived';
  let stage = null;
  return {
    get state() { return state; },
    get stage() { return stage; },
    transition(to, { stage: nextStage = null } = {}) {
      // Entering 作曲中 needs its running stage; both are checked before either slot moves.
      const enteringStage = to === 'composing' ? requireStage(nextStage) : null;
      state = transitionConcertHallState(state, to);
      stage = enteringStage;
      return state;
    },
    setStage(nextStage) {
      if (state !== 'composing') throw new Error(`concert hall stage can only move while composing (state ${state})`);
      stage = requireStage(nextStage);
      return stage;
    }
  };
}

function requireStage(stage) {
  if (!CONCERT_HALL_STAGES.includes(stage)) throw new Error(`concert hall stage is not in the closed set: ${stage}`);
  return stage;
}

// ---------- score ----------

// Throws on a malformed score JSON (version 1 of the C-15 contract). Returns the score untouched.
export function validateConcertHallScoreShape(score) {
  assertExactKeys(score, ['version', 'title', 'key', 'mode', 'tempo', 'meter', 'sections', 'tracks'], 'score');
  if (score.version !== 1) throw new Error(`concert hall score version must be 1: ${score.version}`);
  requireNonEmptyString(score.title, 'score.title');
  requireNonEmptyString(score.key, 'score.key');
  if (!Object.hasOwn(CONCERT_HALL_MODE_LABELS, score.mode)) throw new Error(`concert hall score.mode is not in the closed set: ${score.mode}`);
  const [tempoMin, tempoMax] = CONCERT_HALL_TEMPO_RANGE;
  if (!Number.isInteger(score.tempo) || score.tempo < tempoMin || score.tempo > tempoMax) throw new Error(`concert hall score.tempo must be an integer in ${tempoMin}〜${tempoMax}: ${score.tempo}`);
  if (!CONCERT_HALL_METERS.includes(score.meter)) throw new Error(`concert hall score.meter is not in the closed set: ${score.meter}`);
  if (!Array.isArray(score.sections) || score.sections.length < 2 || score.sections.length > 4) throw new Error('concert hall score.sections must hold 2〜4 sections');
  const beatsPerBar = Number(score.meter.split('/')[0]);
  let total = 0;
  score.sections.forEach((section, index) => {
    assertExactKeys(section, ['name', 'bars', 'chords', 'character'], `score.sections[${index}]`);
    requireNonEmptyString(section.name, `score.sections[${index}].name`);
    if (!Number.isInteger(section.bars) || section.bars <= 0) throw new Error(`concert hall score.sections[${index}].bars must be a positive integer`);
    const chords = requireStringList(section.chords, `score.sections[${index}].chords`);
    if (chords.length !== section.bars) throw new Error(`concert hall score.sections[${index}].chords must hold one chord per bar`);
    requireNonEmptyString(section.character, `score.sections[${index}].character`);
    total += section.bars * beatsPerBar;
  });
  if (!Array.isArray(score.tracks)) throw new Error('concert hall score.tracks must be an array');
  const roles = new Set();
  score.tracks.forEach((track, trackIndex) => {
    assertExactKeys(track, ['role', 'instrument', 'notes'], `score.tracks[${trackIndex}]`);
    if (!CONCERT_HALL_SCORE_ROLES.includes(track.role)) throw new Error(`concert hall score track role is not in the closed set: ${track.role}`);
    if (roles.has(track.role)) throw new Error(`concert hall score track role is duplicated: ${track.role}`);
    roles.add(track.role);
    if (!CONCERT_HALL_INSTRUMENTS.includes(track.instrument)) throw new Error(`concert hall score track instrument is not in the closed set: ${track.instrument}`);
    if (!Array.isArray(track.notes) || track.notes.length === 0) throw new Error(`concert hall score track ${track.role} must hold at least one note`);
    track.notes.forEach((note, noteIndex) => {
      const label = `score.tracks[${trackIndex}].notes[${noteIndex}]`;
      assertExactKeys(note, ['midi', 'start_beat', 'duration_beats', 'velocity'], label);
      if (!Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) throw new Error(`concert hall ${label}.midi must be a MIDI integer`);
      if (!Number.isFinite(note.start_beat) || note.start_beat < 0) throw new Error(`concert hall ${label}.start_beat must be a non-negative number`);
      if (!Number.isFinite(note.duration_beats) || note.duration_beats <= 0) throw new Error(`concert hall ${label}.duration_beats must be a positive number`);
      if (note.start_beat + note.duration_beats > total + 1e-9) throw new Error(`concert hall ${label} runs past the end of the piece`);
      if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) throw new Error(`concert hall ${label}.velocity must be an integer in 1〜127`);
    });
  });
  for (const role of CONCERT_HALL_SCORE_REQUIRED_ROLES) if (!roles.has(role)) throw new Error(`concert hall score is missing the ${role} track`);
  return score;
}

// The 曲頭 line: 「ハ長調・♩=96・4/4」 style key / mode / tempo / meter summary.
export function concertHallScoreHeadline(score) {
  return `${score.key} ${CONCERT_HALL_MODE_LABELS[score.mode]}・♩=${score.tempo}・${score.meter}`;
}

// ---------- arrival payload ----------

// GET /api/concert-hall → { week, postContentScreen, performer, pieces }. Exact keys throughout.
export function validateConcertHallArrivalPayload(payload) {
  assertExactKeys(payload, ['week', 'post_content_screen', 'performer', 'pieces'], 'arrival payload');
  const week = requireNonNegativeInteger(payload.week, 'arrival week');
  const postContentScreen = requireNonEmptyString(payload.post_content_screen, 'arrival post_content_screen');
  assertExactKeys(payload.performer, ['name', 'greeting', 'input_placeholder', 'empty_shelf'], 'arrival performer');
  const performer = {
    name: requireNonEmptyString(payload.performer.name, 'arrival performer.name'),
    greeting: requireNonEmptyString(payload.performer.greeting, 'arrival performer.greeting'),
    input_placeholder: requireNonEmptyString(payload.performer.input_placeholder, 'arrival performer.input_placeholder'),
    empty_shelf: requireNonEmptyString(payload.performer.empty_shelf, 'arrival performer.empty_shelf')
  };
  if (!Array.isArray(payload.pieces)) throw new Error('concert hall arrival pieces must be an array');
  const ids = new Set();
  const pieces = payload.pieces.map((piece, index) => {
    assertExactKeys(piece, ['entry_id', 'title', 'direction_label', 'composed_week'], `arrival pieces[${index}]`);
    const entryId = requireNonEmptyString(piece.entry_id, `arrival pieces[${index}].entry_id`);
    if (ids.has(entryId)) throw new Error(`concert hall arrival pieces entry_id is duplicated: ${entryId}`);
    ids.add(entryId);
    return {
      entry_id: entryId,
      title: requireNonEmptyString(piece.title, `arrival pieces[${index}].title`),
      direction_label: requireNonEmptyString(piece.direction_label, `arrival pieces[${index}].direction_label`),
      composed_week: requireNonNegativeInteger(piece.composed_week, `arrival pieces[${index}].composed_week`)
    };
  });
  return { week, postContentScreen, performer, pieces };
}

// ---------- compose SSE events ----------

const STAGE_PAYLOAD_KEYS = Object.freeze({
  materials: ['materials', 'motif_words', 'remark'],
  direction: ['direction_id', 'subject_id', 'motif_category_id', 'remark'],
  guidance: ['lines'],
  skeleton: ['title', 'key', 'mode', 'tempo', 'meter', 'sections'],
  section: ['melody', 'counter']
});

// event `stage` data { stage, index?, payload } → { stage, index, payload, narration } where `narration` is the
// text the stage card shows (S1 / S2 remark, S3 lines, S4 section characters; S5 has none — the section card
// is marked written). `index` is required for `section` and refused elsewhere.
export function validateConcertHallStageEvent(data) {
  if (!isObject(data)) throw new Error('concert hall stage event must be an object');
  const stage = data.stage;
  if (!CONCERT_HALL_STAGES.includes(stage)) throw new Error(`concert hall stage event stage is not in the closed set: ${stage}`);
  const keys = stage === 'section' ? ['stage', 'index', 'payload'] : ['stage', 'payload'];
  assertExactKeys(data, keys, `stage event (${stage})`);
  const index = stage === 'section' ? requireNonNegativeInteger(data.index, 'stage event index') : null;
  assertExactKeys(data.payload, STAGE_PAYLOAD_KEYS[stage], `stage event payload (${stage})`);
  const payload = data.payload;
  let narration;
  if (stage === 'materials' || stage === 'direction') {
    narration = [requireNonEmptyString(payload.remark, `stage event payload (${stage}).remark`)];
    if (stage === 'materials') {
      requireStringList(payload.materials, 'stage event payload (materials).materials');
      requireStringList(payload.motif_words, 'stage event payload (materials).motif_words');
    } else {
      for (const key of ['direction_id', 'subject_id', 'motif_category_id']) requireNonEmptyString(payload[key], `stage event payload (direction).${key}`);
    }
  } else if (stage === 'guidance') {
    narration = requireStringList(payload.lines, 'stage event payload (guidance).lines');
    if (narration.length === 0) throw new Error('concert hall stage event payload (guidance).lines must not be empty');
  } else if (stage === 'skeleton') {
    requireNonEmptyString(payload.title, 'stage event payload (skeleton).title');
    if (!Array.isArray(payload.sections) || payload.sections.length === 0) throw new Error('concert hall stage event payload (skeleton).sections must be a non-empty array');
    narration = payload.sections.map((section, sectionIndex) => {
      assertExactKeys(section, ['name', 'bars', 'chords', 'character'], `stage event payload (skeleton).sections[${sectionIndex}]`);
      requireNonEmptyString(section.name, `stage event payload (skeleton).sections[${sectionIndex}].name`);
      return requireNonEmptyString(section.character, `stage event payload (skeleton).sections[${sectionIndex}].character`);
    });
  } else {
    if (!Array.isArray(payload.melody) || !Array.isArray(payload.counter)) throw new Error('concert hall stage event payload (section) must carry melody / counter arrays');
    narration = [];
  }
  return { stage, index, payload, narration };
}

// The 収蔵 entry (the `done` event's piece and GET /api/concert-hall/pieces/<id>). Exact keys; the narration
// must carry one skeleton line per score section; the score is validated in full.
export function validateConcertHallPiece(piece) {
  assertExactKeys(piece, ['entry_id', 'title', 'direction_id', 'subject_id', 'motif_category_id', 'materials', 'narration', 'score', 'composed_week'], 'piece');
  requireNonEmptyString(piece.entry_id, 'piece.entry_id');
  requireNonEmptyString(piece.title, 'piece.title');
  for (const key of ['direction_id', 'subject_id', 'motif_category_id']) requireNonEmptyString(piece[key], `piece.${key}`);
  requireStringList(piece.materials, 'piece.materials');
  assertExactKeys(piece.narration, ['materials', 'direction', 'guidance', 'skeleton'], 'piece.narration');
  requireNonEmptyString(piece.narration.materials, 'piece.narration.materials');
  requireNonEmptyString(piece.narration.direction, 'piece.narration.direction');
  const guidance = requireStringList(piece.narration.guidance, 'piece.narration.guidance');
  if (guidance.length === 0) throw new Error('concert hall piece.narration.guidance must not be empty');
  const skeleton = requireStringList(piece.narration.skeleton, 'piece.narration.skeleton');
  validateConcertHallScoreShape(piece.score);
  if (skeleton.length !== piece.score.sections.length) throw new Error('concert hall piece.narration.skeleton must hold one line per score section');
  if (piece.score.title !== piece.title) throw new Error('concert hall piece.title must equal piece.score.title');
  requireNonNegativeInteger(piece.composed_week, 'piece.composed_week');
  return piece;
}

// event `done` data { entry_id, piece } → { entryId, piece }.
export function validateConcertHallDoneEvent(data) {
  assertExactKeys(data, ['entry_id', 'piece'], 'done event');
  const entryId = requireNonEmptyString(data.entry_id, 'done event entry_id');
  const piece = validateConcertHallPiece(data.piece);
  if (piece.entry_id !== entryId) throw new Error(`concert hall done event entry_id must equal piece.entry_id: ${entryId} vs ${piece.entry_id}`);
  return { entryId, piece };
}

// event `error` data { code, stage, message } → { code, stage, message }. `stage` is null for a failure outside
// a stage (transport, internal) or one of the closed stages; the card the message lands on is chosen from it.
export function validateConcertHallErrorEvent(data) {
  assertExactKeys(data, ['code', 'stage', 'message'], 'error event');
  requireNonEmptyString(data.code, 'error event code');
  if (data.stage !== null && !CONCERT_HALL_STAGES.includes(data.stage)) throw new Error(`concert hall error event stage is not in the closed set: ${data.stage}`);
  requireNonEmptyString(data.message, 'error event message');
  return { code: data.code, stage: data.stage, message: data.message };
}

// One SSE block (`event: x\ndata: {...}`) → { event, data }. The compose stream carries exactly stage / done /
// error events with JSON data; anything else is a contract break.
export function parseConcertHallSseBlock(block) {
  const lines = block.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
  const dataText = lines.find((line) => line.startsWith('data: '))?.slice(6);
  if (!['stage', 'done', 'error'].includes(event)) throw new Error(`concert hall compose stream carried an unknown event: ${event}`);
  if (typeof dataText !== 'string') throw new Error(`concert hall compose stream event without data: ${event}`);
  return { event, data: JSON.parse(dataText) };
}

// The shelf order: newest composition first (the append-ordered 収蔵 list reversed).
export function concertHallShelfOrder(pieces) {
  return [...pieces].reverse();
}
