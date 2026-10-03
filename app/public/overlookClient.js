// Pure, DOM-independent 星見の窓 (overlook) screen contract, shared by app.js, the layout worker and the headless
// unit tests (the same seam as concertHallClient.js): the fail-fast validators for every /api/overlook* payload
// and the conversation SSE events, the screen's closed state machine, and the field geometry the screen draws
// with (the camera, the playback of the server's positions between polls, the walk flourishes, the hover
// premise, the place hit test, the pair ring, the focus / return camera path). app.js imports these and only
// assembles the DOM around them — no inline re-implementation.
//
// Everything validated here is exact-keys: a surplus key, a missing key or a value outside its closed set is a
// contract break → throw before any DOM mutation.

// ---------- constants ----------

export const OVERLOOK_SCREEN_ID = 'academy-overlook';
export const OVERLOOK_MAP_IMAGE_URL = '/canonical/academy_overlook/field_map.jpg';
export const OVERLOOK_STAGE_IMAGE_URL = '/canonical/academy_overlook/stage_window.jpg';
export const OVERLOOK_FOUNTAIN_PLACE_ID = 'courtyard_fountain';

// 顔コマ: 直径 56 px（縁を含む）。
export const OVERLOOK_COMA_RADIUS = 28;
// hover: 0.3 秒で一言の札、1.2 秒で線と気持ちの札。
export const OVERLOOK_SAY_DELAY_MS = 300;
export const OVERLOOK_LINES_DELAY_MS = 1200;
// フォーカスへ寄る: 0.6 秒で中点へ、続けて 0.5 秒で倍率 1.0 → 1.8、会話画面へ 0.3 秒で重ねて切り替える。
export const OVERLOOK_FOCUS_PAN_MS = 600;
export const OVERLOOK_FOCUS_ZOOM_MS = 500;
export const OVERLOOK_FOCUS_SCALE = 1.8;
export const OVERLOOK_TALK_CROSSFADE_MS = 300;
// field の GET は同時に 1 本まで。前の応答を待ってから、この間隔をおいて次を出す。
export const OVERLOOK_FIELD_POLL_MS = 250;
// 描くのは server の時刻より少し前（前後 2 つの標本の間を道に沿って補間する）。
export const OVERLOOK_PLAYBACK_DELAY_MS = 500;
// 書き込み: 1 行・最大 40 字。
export const OVERLOOK_WRITING_MAX_CHARS = 40;
// 札・枠の置き場の数値（構成表 状態 11・14）。
export const OVERLOOK_WRITING_FRAME_WIDTH = 360;
export const OVERLOOK_WRITING_FRAME_GAP = 18;
export const OVERLOOK_PAIR_RING_HEIGHT = 70;
export const OVERLOOK_PAIR_RING_PADDING = 5;
// 動きの読み分けの飾り（構成表 0.4）: 見回しの揺れ・振り返り・一巡り。
export const OVERLOOK_SEARCH_SWAY_PX = 4;
export const OVERLOOK_SEARCH_SWAY_MS = 480;
export const OVERLOOK_AVOID_GLANCE_PX = 5;
export const OVERLOOK_AVOID_GLANCE_EVERY_MS = 1600;
export const OVERLOOK_AVOID_GLANCE_MS = 160;
export const OVERLOOK_CHECK_CIRCLE_PX = 24;
export const OVERLOOK_CHECK_CIRCLE_MS = 1600;

export const OVERLOOK_ENTRY_LOADING_COPY = Object.freeze({ title: '星見の窓へ移動中', status: '学院の朝の鐘を待っています。' });
export const OVERLOOK_FOCUS_WAIT_STATUS = '二人の最初の言葉を待っています。';

export const OVERLOOK_CHILD_STATUSES = Object.freeze(['free', 'deciding', 'encounter', 'leaving', 'arriving']);
// The sent-off child and the newcomer walk the road outside the gate at this fixed speed, with no pattern.
const OVERLOOK_GATE_STATUSES = Object.freeze(['leaving', 'arriving']);
export const OVERLOOK_GATE_WALK_SPEED_PX_PER_S = 110;
export const OVERLOOK_ROSTER_SIZE = 12;
export const OVERLOOK_PATTERNS = Object.freeze(['search', 'meet', 'avoid', 'stay', 'check']);
export const OVERLOOK_FEELING_LABELS = Object.freeze(['好意', '関心', '気まずい', '負い目', '反発']);
export const OVERLOOK_FOCUS_SOURCES = Object.freeze(['academy', 'picked']);
export const OVERLOOK_OUTCOMES = Object.freeze(['果たされた', '断られた', '別の決着']);

// ---------- the screen's closed state machine ----------

// The states the screen can be in (構成表の状態番号). 状態 10・12 are the field with traces / a writing mark on
// it, 状態 15 is the shared settings redirect and 状態 16 the loading-covered hub return, so they are not states
// of this screen of their own.
export const OVERLOOK_STATES = Object.freeze([
  'entering',            // 2  入場のローディング被覆（enter の応答待ち）
  'field',               // 3・10・12 フィールド
  'say',                 // 4  hover 段階 1（一言の札）
  'lines',               // 5  hover 段階 2（線と気持ちの札）
  'pair',                // 14 出会っている二人に hover（輪と二人の一言の札）
  'writing',             // 11 書き込みの枠（一行を入力中）
  'writing-limited',     // 13 書き込みの枠（上限中）
  'focusing',            // 6  フォーカスへ寄る（1.1 秒）
  'awaiting-first-line', // 6  寄りが終わっても最初の発言の流れが始まっていない（ローディング被覆）
  'talk',                // 7  会話：クリック待ち
  'talk-generating',     // 8  会話：次の発言を生成中
  'talk-closed',         // 9  会話：閉じた最終発言
  'returning',           // 9 → 10 戻りのカメラ
  'exiting',             // 16 ハブへ（出るボタン・15:00）
  'failed'               // 15 ほか: この入場は止まった（LM 不通なら設定画面へ）
]);

const FIELD_STATES = ['field', 'say', 'lines', 'pair', 'writing', 'writing-limited'];

// The closed transition table. Only these edges exist; anything else is a programming error → throw.
//   入場 → フィールド; フィールドの中の hover・書き込み・二人の輪は互いに行き来し、どれからも 学院のフォーカス /
//   つまんだ二人 → 寄る、出るボタン / 15:00 → ハブへ。寄る → (最初の発言が始まっていれば) 会話 / (まだなら)
//   被覆 → 会話。寄っている最中につまめば寄り直す。会話は 7 ⇄ 8 → 9 → 戻る → フィールド。どこからでも止まる。
export const OVERLOOK_TRANSITIONS = Object.freeze({
  entering: Object.freeze(['field', 'failed']),
  field: Object.freeze(['say', 'pair', 'writing', 'writing-limited', 'focusing', 'exiting', 'failed']),
  say: Object.freeze(['field', 'lines', 'pair', 'say', 'writing', 'writing-limited', 'focusing', 'exiting', 'failed']),
  lines: Object.freeze(['field', 'say', 'pair', 'writing', 'writing-limited', 'focusing', 'exiting', 'failed']),
  pair: Object.freeze(['field', 'say', 'pair', 'writing', 'writing-limited', 'focusing', 'exiting', 'failed']),
  writing: Object.freeze(['field', 'writing', 'writing-limited', 'focusing', 'exiting', 'failed']),
  'writing-limited': Object.freeze(['field', 'writing', 'writing-limited', 'focusing', 'exiting', 'failed']),
  focusing: Object.freeze(['focusing', 'awaiting-first-line', 'talk', 'talk-generating', 'failed']),
  'awaiting-first-line': Object.freeze(['talk', 'talk-generating', 'failed']),
  talk: Object.freeze(['talk-generating', 'talk', 'talk-closed', 'failed']),
  'talk-generating': Object.freeze(['talk', 'talk-closed', 'failed']),
  'talk-closed': Object.freeze(['returning', 'failed']),
  returning: Object.freeze(['field', 'failed']),
  exiting: Object.freeze(['failed']),
  failed: Object.freeze([])
});

export function transitionOverlookState(from, to) {
  if (!OVERLOOK_STATES.includes(from)) throw new Error(`overlook state is not in the closed set: ${from}`);
  if (!OVERLOOK_STATES.includes(to)) throw new Error(`overlook state is not in the closed set: ${to}`);
  if (!OVERLOOK_TRANSITIONS[from].includes(to)) throw new Error(`overlook state transition is not allowed: ${from} → ${to}`);
  return to;
}

export function isOverlookFieldState(state) {
  if (!OVERLOOK_STATES.includes(state)) throw new Error(`overlook state is not in the closed set: ${state}`);
  return FIELD_STATES.includes(state);
}

// 顔ぶれの一覧（状態 18・19）は状態ではなく、フィールドの上に重なる枠: 開いているあいだも hover（4・5）と二人の輪
// （14）はそのまま動くので、この 4 状態の上でだけ開いていられる。ほかの状態へ移った時点で閉じる（書き込みの枠・
// 寄る・ハブへ・止まる）。
const ROSTER_OPEN_STATES = ['field', 'say', 'lines', 'pair'];

export function overlookRosterMayOpen(state) {
  if (!OVERLOOK_STATES.includes(state)) throw new Error(`overlook state is not in the closed set: ${state}`);
  return ROSTER_OPEN_STATES.includes(state);
}

// One machine per entry: it starts in `entering`.
export function createOverlookStateMachine() {
  let state = 'entering';
  return {
    get state() { return state; },
    transition(to) {
      state = transitionOverlookState(state, to);
      return state;
    }
  };
}

// ---------- validation helpers ----------

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isObject(value)) throw new Error(`overlook ${label} must be an object`);
  const present = Object.keys(value);
  const missing = keys.filter((key) => !present.includes(key));
  const surplus = present.filter((key) => !keys.includes(key));
  if (missing.length || surplus.length) {
    throw new Error(`overlook ${label} keys must be exactly {${keys.join(', ')}}: missing [${missing.join(', ')}] surplus [${surplus.join(', ')}]`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`overlook ${label} must be a non-empty string`);
  return value;
}

function requireNullableString(value, label) {
  if (value === null) return null;
  return requireString(value, label);
}

function requireFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`overlook ${label} must be a finite number: ${value}`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`overlook ${label} must be a non-negative integer: ${value}`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`overlook ${label} must be a boolean: ${value}`);
  return value;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`overlook ${label} must be one of ${allowed.join(', ')}: ${JSON.stringify(value)}`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`overlook ${label} must be an array`);
  return value;
}

const ACADEMY_TIME = /^(\d{1,2}):([0-5]\d)$/;

// "9:40" → minutes since midnight. The academy time is the server's formatted clock (H:MM).
export function overlookAcademyMinute(text) {
  const match = ACADEMY_TIME.exec(requireString(text, 'academy time'));
  if (!match) throw new Error(`overlook academy time must be H:MM: ${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function requireAcademyTime(value, label) {
  overlookAcademyMinute(requireString(value, label));
  return value;
}

function requirePoint(value, label) {
  assertExactKeys(value, ['x', 'y'], label);
  requireFinite(value.x, `${label}.x`);
  requireFinite(value.y, `${label}.y`);
  return value;
}

function validateParticipant(value, label) {
  assertExactKeys(value, ['character_id', 'character_name'], label);
  requireString(value.character_id, `${label}.character_id`);
  requireString(value.character_name, `${label}.character_name`);
  return value;
}

function validateParticipantPair(value, label) {
  requireArray(value, label);
  if (value.length !== 2) throw new Error(`overlook ${label} must hold exactly two children`);
  value.forEach((entry, index) => validateParticipant(entry, `${label}[${index}]`));
  if (value[0].character_id === value[1].character_id) throw new Error(`overlook ${label} names the same child twice`);
  return value;
}

// ---------- payload validators ----------

// enter の応答の `places`: 24 か所（地図 px・正規化半径・表示名）。
export function validateOverlookPlaces(places) {
  requireArray(places, 'places');
  if (places.length === 0) throw new Error('overlook places must not be empty');
  const seen = new Set();
  places.forEach((place, index) => {
    const label = `places[${index}]`;
    assertExactKeys(place, ['place_id', 'name', 'x', 'y', 'radius'], label);
    requireString(place.place_id, `${label}.place_id`);
    requireString(place.name, `${label}.name`);
    requireFinite(place.x, `${label}.x`);
    requireFinite(place.y, `${label}.y`);
    if (requireFinite(place.radius, `${label}.radius`) <= 0) throw new Error(`overlook ${label}.radius must be positive`);
    if (seen.has(place.place_id)) throw new Error(`overlook places repeat ${place.place_id}`);
    seen.add(place.place_id);
  });
  if (!seen.has(OVERLOOK_FOUNTAIN_PLACE_ID)) throw new Error(`overlook places must hold ${OVERLOOK_FOUNTAIN_PLACE_ID} (the entry camera centre)`);
  return places;
}

function validateChild(child, label, placeIds) {
  assertExactKeys(child, ['character_id', 'character_name', 'status', 'wish_line', 'feelings', 'x', 'y', 'pattern', 'speed_px_per_s', 'paused', 'route', 'place_id'], label);
  requireString(child.character_id, `${label}.character_id`);
  requireString(child.character_name, `${label}.character_name`);
  requireOneOf(child.status, OVERLOOK_CHILD_STATUSES, `${label}.status`);
  // A free child always carries its wish; deciding and the two gate walkers never do; a child in an encounter
  // may have lost its wish when its target was sent off.
  if (child.status === 'free') requireString(child.wish_line, `${label}.wish_line`);
  else if (child.status === 'encounter') requireNullableString(child.wish_line, `${label}.wish_line`);
  else if (child.wish_line !== null) throw new Error(`overlook ${label}.wish_line must be null while ${child.status}`);
  requireArray(child.feelings, `${label}.feelings`).forEach((feeling, index) => {
    assertExactKeys(feeling, ['character_id', 'label', 'text'], `${label}.feelings[${index}]`);
    requireString(feeling.character_id, `${label}.feelings[${index}].character_id`);
    requireOneOf(feeling.label, OVERLOOK_FEELING_LABELS, `${label}.feelings[${index}].label`);
    requireString(feeling.text, `${label}.feelings[${index}].text`);
  });
  requireFinite(child.x, `${label}.x`);
  requireFinite(child.y, `${label}.y`);
  if (child.pattern !== null) requireOneOf(child.pattern, OVERLOOK_PATTERNS, `${label}.pattern`);
  if (requireFinite(child.speed_px_per_s, `${label}.speed_px_per_s`) < 0) throw new Error(`overlook ${label}.speed_px_per_s must not be negative`);
  requireBoolean(child.paused, `${label}.paused`);
  requireArray(child.route, `${label}.route`).forEach((point, index) => requirePoint(point, `${label}.route[${index}]`));
  if (child.place_id !== null && placeIds && !placeIds.has(child.place_id)) throw new Error(`overlook ${label}.place_id is not a known place: ${child.place_id}`);
  if (child.place_id !== null) requireString(child.place_id, `${label}.place_id`);
  if (OVERLOOK_GATE_STATUSES.includes(child.status)) {
    if (child.pattern !== null || child.speed_px_per_s !== OVERLOOK_GATE_WALK_SPEED_PX_PER_S || child.paused || child.place_id !== null) {
      throw new Error(`overlook ${label} is ${child.status}: pattern null, speed ${OVERLOOK_GATE_WALK_SPEED_PX_PER_S}, not paused, place_id null`);
    }
    if (child.status === 'leaving' && child.feelings.length !== 0) throw new Error(`overlook ${label} is leaving and must hold no feelings`);
  }
  return child;
}

// The roster: always 12 rows in the order the children joined. Only a newcomer before the gate is not swappable.
function validateRoster(roster) {
  requireArray(roster, 'field.roster');
  if (roster.length !== OVERLOOK_ROSTER_SIZE) throw new Error(`overlook field.roster must hold ${OVERLOOK_ROSTER_SIZE} rows: ${roster.length}`);
  const ids = new Set();
  roster.forEach((row, index) => {
    const label = `field.roster[${index}]`;
    assertExactKeys(row, ['character_id', 'character_name', 'swappable'], label);
    requireString(row.character_id, `${label}.character_id`);
    requireString(row.character_name, `${label}.character_name`);
    requireBoolean(row.swappable, `${label}.swappable`);
    if (ids.has(row.character_id)) throw new Error(`overlook field.roster repeats ${row.character_id}`);
    ids.add(row.character_id);
  });
  return ids;
}

function validateEncounter(encounter, label, childIds) {
  assertExactKeys(encounter, ['encounter_id', 'participants', 'place_id', 'pickable'], label);
  requireString(encounter.encounter_id, `${label}.encounter_id`);
  validateParticipantPair(encounter.participants, `${label}.participants`);
  for (const participant of encounter.participants) {
    if (!childIds.has(participant.character_id)) throw new Error(`overlook ${label} names a child outside the field: ${participant.character_id}`);
  }
  requireNullableString(encounter.place_id, `${label}.place_id`);
  requireBoolean(encounter.pickable, `${label}.pickable`);
  return encounter;
}

// GET /api/overlook/field の `field`（enter・focus・return・writings の応答も同じ shape を載せる）。
// `places` を渡すと、children・跡・印の place_id がその閉集合の中にあることも確かめる。
export function validateOverlookField(field, { places = null } = {}) {
  assertExactKeys(field, ['week', 'clock', 'map', 'roster', 'children', 'encounters', 'focus', 'traces', 'writing_marks', 'writing'], 'field');
  requireNonNegativeInteger(field.week, 'field.week');
  assertExactKeys(field.clock, ['tick', 'academy_time', 'academy_minute', 'ended', 'tick_ms'], 'field.clock');
  requireNonNegativeInteger(field.clock.tick, 'field.clock.tick');
  requireAcademyTime(field.clock.academy_time, 'field.clock.academy_time');
  requireNonNegativeInteger(field.clock.academy_minute, 'field.clock.academy_minute');
  if (overlookAcademyMinute(field.clock.academy_time) !== field.clock.academy_minute) {
    throw new Error(`overlook field.clock.academy_time ${field.clock.academy_time} disagrees with academy_minute ${field.clock.academy_minute}`);
  }
  requireBoolean(field.clock.ended, 'field.clock.ended');
  if (requireNonNegativeInteger(field.clock.tick_ms, 'field.clock.tick_ms') === 0) throw new Error('overlook field.clock.tick_ms must be positive');
  assertExactKeys(field.map, ['width', 'height'], 'field.map');
  if (requireFinite(field.map.width, 'field.map.width') <= 0 || requireFinite(field.map.height, 'field.map.height') <= 0) throw new Error('overlook field.map must have a positive size');
  const placeIds = places ? new Set(places.map((place) => place.place_id)) : null;
  const rosterIds = validateRoster(field.roster);
  requireArray(field.children, 'field.children');
  if (field.children.length === 0) throw new Error('overlook field.children must not be empty');
  const childIds = new Set();
  field.children.forEach((child, index) => {
    validateChild(child, `field.children[${index}]`, placeIds);
    if (childIds.has(child.character_id)) throw new Error(`overlook field.children repeat ${child.character_id}`);
    childIds.add(child.character_id);
    // The map shows the roster (a newcomer once it appears) and, besides it, only the children walking out.
    if ((child.status === 'leaving') === rosterIds.has(child.character_id)) {
      throw new Error(`overlook field.children[${index}] ${child.character_id} is ${child.status} but ${rosterIds.has(child.character_id) ? 'on' : 'off'} the roster`);
    }
  });
  field.children.forEach((child, index) => {
    for (const feeling of child.feelings) {
      if (feeling.character_id === child.character_id) throw new Error(`overlook field.children[${index}] holds a feeling for itself`);
      // The hover lines are drawn to every feeling's target, so each one must be on the field.
      if (!childIds.has(feeling.character_id)) throw new Error(`overlook field.children[${index}] holds a feeling for a child off the field: ${feeling.character_id}`);
    }
  });
  const encounterIds = new Set();
  requireArray(field.encounters, 'field.encounters').forEach((encounter, index) => {
    validateEncounter(encounter, `field.encounters[${index}]`, childIds);
    encounterIds.add(encounter.encounter_id);
  });
  if (field.focus !== null) {
    assertExactKeys(field.focus, ['encounter_id', 'participants', 'place_id', 'pickable', 'conversation_id', 'source'], 'field.focus');
    validateEncounter({
      encounter_id: field.focus.encounter_id,
      participants: field.focus.participants,
      place_id: field.focus.place_id,
      pickable: field.focus.pickable
    }, 'field.focus', childIds);
    requireNullableString(field.focus.conversation_id, 'field.focus.conversation_id');
    requireOneOf(field.focus.source, OVERLOOK_FOCUS_SOURCES, 'field.focus.source');
    if (!encounterIds.has(field.focus.encounter_id)) throw new Error(`overlook field.focus ${field.focus.encounter_id} is not among the encounters`);
  }
  const tracePlaces = new Set();
  requireArray(field.traces, 'field.traces').forEach((trace, index) => {
    const label = `field.traces[${index}]`;
    assertExactKeys(trace, ['place_id', 'x', 'y', 'academy_time', 'text'], label);
    requireString(trace.place_id, `${label}.place_id`);
    if (placeIds && !placeIds.has(trace.place_id)) throw new Error(`overlook ${label}.place_id is not a known place: ${trace.place_id}`);
    if (tracePlaces.has(trace.place_id)) throw new Error(`overlook field.traces hold two traces for ${trace.place_id}`);
    tracePlaces.add(trace.place_id);
    requireFinite(trace.x, `${label}.x`);
    requireFinite(trace.y, `${label}.y`);
    requireAcademyTime(trace.academy_time, `${label}.academy_time`);
    requireString(trace.text, `${label}.text`);
  });
  requireArray(field.writing_marks, 'field.writing_marks').forEach((mark, index) => {
    const label = `field.writing_marks[${index}]`;
    assertExactKeys(mark, ['writing_id', 'place_id', 'x', 'y', 'academy_time', 'until', 'text'], label);
    requireString(mark.writing_id, `${label}.writing_id`);
    requireString(mark.place_id, `${label}.place_id`);
    if (placeIds && !placeIds.has(mark.place_id)) throw new Error(`overlook ${label}.place_id is not a known place: ${mark.place_id}`);
    requireFinite(mark.x, `${label}.x`);
    requireFinite(mark.y, `${label}.y`);
    requireAcademyTime(mark.academy_time, `${label}.academy_time`);
    requireAcademyTime(mark.until, `${label}.until`);
    requireString(mark.text, `${label}.text`);
  });
  assertExactKeys(field.writing, ['available', 'next_available_at'], 'field.writing');
  requireBoolean(field.writing.available, 'field.writing.available');
  if (field.writing.next_available_at !== null) requireAcademyTime(field.writing.next_available_at, 'field.writing.next_available_at');
  if (field.writing.available && field.writing.next_available_at !== null) throw new Error('overlook field.writing names a next time while writing is available');
  return field;
}

function requireInteractionScreen(value, label) {
  if (value !== 'interaction') throw new Error(`overlook ${label} must be 'interaction' (the routing hub): ${JSON.stringify(value)}`);
  return value;
}

// POST /api/overlook/enter → { field, places, post_content_screen }
export function validateOverlookEnterResponse(payload) {
  assertExactKeys(payload, ['field', 'places', 'post_content_screen'], 'enter response');
  validateOverlookPlaces(payload.places);
  validateOverlookField(payload.field, { places: payload.places });
  requireInteractionScreen(payload.post_content_screen, 'enter response.post_content_screen');
  return payload;
}

// GET /api/overlook/field → { field }
export function validateOverlookFieldResponse(payload, { places }) {
  assertExactKeys(payload, ['field'], 'field response');
  validateOverlookField(payload.field, { places });
  return payload;
}

// POST /api/overlook/focus → { focus:{encounter_id, source:'picked'}, field }
export function validateOverlookFocusResponse(payload, { places }) {
  assertExactKeys(payload, ['focus', 'field'], 'focus response');
  assertExactKeys(payload.focus, ['encounter_id', 'source'], 'focus response.focus');
  requireString(payload.focus.encounter_id, 'focus response.focus.encounter_id');
  if (payload.focus.source !== 'picked') throw new Error(`overlook focus response.focus.source must be 'picked': ${payload.focus.source}`);
  validateOverlookField(payload.field, { places });
  if (payload.field.focus?.encounter_id !== payload.focus.encounter_id) throw new Error('overlook focus response: the field does not carry the picked focus');
  return payload;
}

// POST /api/overlook/roster/swap → { swap:{leaving, arriving}, field }. The newcomer holds the leaver's roster row
// and cannot be sent off before it walks through the gate; the leaver is off the roster, walking out.
export function validateOverlookSwapResponse(payload, { places }) {
  assertExactKeys(payload, ['swap', 'field'], 'swap response');
  assertExactKeys(payload.swap, ['leaving', 'arriving'], 'swap response.swap');
  validateParticipant(payload.swap.leaving, 'swap response.swap.leaving');
  validateParticipant(payload.swap.arriving, 'swap response.swap.arriving');
  validateOverlookField(payload.field, { places });
  const { leaving, arriving } = payload.swap;
  if (payload.field.roster.some((row) => row.character_id === leaving.character_id)) throw new Error(`overlook swap response: ${leaving.character_id} was sent off but is still on the roster`);
  const row = payload.field.roster.find((entry) => entry.character_id === arriving.character_id);
  if (!row || row.swappable) throw new Error(`overlook swap response: the newcomer ${arriving.character_id} must hold a roster row that cannot be sent off yet`);
  if (!payload.field.children.some((child) => child.character_id === leaving.character_id && child.status === 'leaving')) {
    throw new Error(`overlook swap response: ${leaving.character_id} is not walking out on the field`);
  }
  return payload;
}

// POST /api/overlook/conversation/return → { field }
export function validateOverlookReturnResponse(payload, { places }) {
  assertExactKeys(payload, ['field'], 'return response');
  validateOverlookField(payload.field, { places });
  return payload;
}

// POST /api/overlook/writings → { writing:{writing_id, place_id, text}, field }
export function validateOverlookWritingResponse(payload, { places }) {
  assertExactKeys(payload, ['writing', 'field'], 'writing response');
  assertExactKeys(payload.writing, ['writing_id', 'place_id', 'text'], 'writing response.writing');
  requireString(payload.writing.writing_id, 'writing response.writing.writing_id');
  requireString(payload.writing.place_id, 'writing response.writing.place_id');
  requireString(payload.writing.text, 'writing response.writing.text');
  validateOverlookField(payload.field, { places });
  return payload;
}

// The writings route's 409 while the hourly limit holds: { error, error_code:'OVERLOOK_WRITING_LIMITED',
// next_available_at }. Returns the academy time the next line may be written at.
export function validateOverlookWritingLimited(payload) {
  if (!isObject(payload) || payload.error_code !== 'OVERLOOK_WRITING_LIMITED') throw new Error('overlook writing 409 is not the writing limit');
  assertExactKeys(payload, ['error', 'error_code', 'next_available_at'], 'writing limit');
  requireString(payload.error, 'writing limit.error');
  return requireAcademyTime(payload.next_available_at, 'writing limit.next_available_at');
}

function validateWatched(entry, label) {
  assertExactKeys(entry, ['initiator', 'partner', 'outcome', 'wish_line'], label);
  validateParticipant(entry.initiator, `${label}.initiator`);
  validateParticipant(entry.partner, `${label}.partner`);
  requireOneOf(entry.outcome, OVERLOOK_OUTCOMES, `${label}.outcome`);
  requireString(entry.wish_line, `${label}.wish_line`);
}

// POST /api/overlook/exit → { content_result:{kind:'overlook', …}, post_content_screen }
export function validateOverlookExitResponse(payload) {
  assertExactKeys(payload, ['content_result', 'post_content_screen'], 'exit response');
  const result = payload.content_result;
  assertExactKeys(result, ['kind', 'destination_id', 'week', 'recorded_at', 'trigger', 'detail'], 'exit response.content_result');
  if (result.kind !== 'overlook' || result.destination_id !== 'overlook') throw new Error('overlook exit response.content_result must be the overlook kind');
  requireNonNegativeInteger(result.week, 'exit response.content_result.week');
  requireString(result.recorded_at, 'exit response.content_result.recorded_at');
  requireString(result.trigger, 'exit response.content_result.trigger');
  assertExactKeys(result.detail, ['watched_conversations', 'writing_movers'], 'exit response.content_result.detail');
  requireArray(result.detail.watched_conversations, 'exit response watched_conversations').forEach((entry, index) => validateWatched(entry, `watched_conversations[${index}]`));
  requireArray(result.detail.writing_movers, 'exit response writing_movers').forEach((entry, index) => {
    const label = `writing_movers[${index}]`;
    assertExactKeys(entry, ['character_id', 'character_name', 'writing_text', 'wish_line'], label);
    requireString(entry.character_id, `${label}.character_id`);
    requireString(entry.character_name, `${label}.character_name`);
    requireString(entry.writing_text, `${label}.writing_text`);
    requireString(entry.wish_line, `${label}.wish_line`);
  });
  requireInteractionScreen(payload.post_content_screen, 'exit response.post_content_screen');
  return payload;
}

// The conversation view (GET /api/overlook/conversation and the next stream's `message` event).
export function validateOverlookConversation(conversation) {
  assertExactKeys(conversation, ['conversation_id', 'encounter_id', 'place_id', 'location_name', 'seed_line', 'participants', 'messages', 'closed', 'outcome'], 'conversation');
  requireString(conversation.conversation_id, 'conversation.conversation_id');
  requireString(conversation.encounter_id, 'conversation.encounter_id');
  requireString(conversation.place_id, 'conversation.place_id');
  requireString(conversation.location_name, 'conversation.location_name');
  requireString(conversation.seed_line, 'conversation.seed_line');
  validateParticipantPair(conversation.participants, 'conversation.participants');
  const speakers = new Set(conversation.participants.map((participant) => participant.character_id));
  requireArray(conversation.messages, 'conversation.messages').forEach((message, index) => {
    const label = `conversation.messages[${index}]`;
    assertExactKeys(message, ['character_id', 'character_name', 'content', 'expression', 'face_emotion_variant_id'], label);
    if (!speakers.has(requireString(message.character_id, `${label}.character_id`))) throw new Error(`overlook ${label} speaker is not one of the two`);
    requireString(message.character_name, `${label}.character_name`);
    requireString(message.content, `${label}.content`);
    requireString(message.expression, `${label}.expression`);
    requireString(message.face_emotion_variant_id, `${label}.face_emotion_variant_id`);
  });
  requireBoolean(conversation.closed, 'conversation.closed');
  if (conversation.closed) {
    requireOneOf(conversation.outcome, OVERLOOK_OUTCOMES, 'conversation.outcome');
    if (conversation.messages.length === 0) throw new Error('overlook conversation closed with no line shown');
  } else if (conversation.outcome !== null) {
    throw new Error('overlook conversation.outcome must be null until the closing line is shown');
  }
  return conversation;
}

// GET /api/overlook/conversation?conversation_id= → { conversation }
export function validateOverlookConversationResponse(payload) {
  assertExactKeys(payload, ['conversation'], 'conversation response');
  validateOverlookConversation(payload.conversation);
  return payload;
}

// ---------- the next-line SSE stream ----------

// One `event:` / `data:` block of the next route's stream → { event, data }. The stream carries exactly three
// events: assistant_delta {delta} (zero or more), then one terminal `message` {conversation} or `error`
// {error, error_code?, …}. Anything else is a protocol break.
export const OVERLOOK_SSE_EVENTS = Object.freeze(['assistant_delta', 'message', 'error']);

export function parseOverlookSseBlock(block) {
  const lines = String(block).split('\n');
  const eventLine = lines.find((line) => line.startsWith('event: '));
  const dataLine = lines.find((line) => line.startsWith('data: '));
  if (!eventLine || !dataLine) throw new Error(`overlook stream block needs an event and a data line: ${JSON.stringify(block)}`);
  const event = requireOneOf(eventLine.slice(7), OVERLOOK_SSE_EVENTS, 'stream event');
  const data = JSON.parse(dataLine.slice(6));
  if (event === 'assistant_delta') {
    assertExactKeys(data, ['delta'], 'assistant_delta');
    if (typeof data.delta !== 'string') throw new Error('overlook assistant_delta.delta must be a string');
  } else if (event === 'message') {
    assertExactKeys(data, ['conversation'], 'message');
    validateOverlookConversation(data.conversation);
  } else {
    if (!isObject(data)) throw new Error('overlook error event must carry an object');
    requireString(data.error, 'error event.error');
    const allowed = ['error', 'error_code', 'target', 'cause_code', 'cause_message'];
    const surplus = Object.keys(data).filter((key) => !allowed.includes(key));
    if (surplus.length) throw new Error(`overlook error event carries unknown keys: ${surplus.join(', ')}`);
  }
  return { event, data };
}

// ---------- text ----------

// The line the viewer may write: 1 行・最大 40 字（server と同じ規則。server の拒みが正本）。
export function isValidOverlookWritingText(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && [...trimmed].length <= OVERLOOK_WRITING_MAX_CHARS && !/[\r\n]/.test(text);
}

// The given name (the part before 「・」) of a full name.
export function overlookGivenName(fullName) {
  return requireString(fullName, 'character name').split('・')[0];
}

// 状態 6 の被覆の文面: 表題「レオナとフロスのもとへ」（話しかけた子が先）と状態の一行。
export function overlookFocusLoadingCopy(participants) {
  validateParticipantPair(participants, 'focus participants');
  return {
    title: `${overlookGivenName(participants[0].character_name)}と${overlookGivenName(participants[1].character_name)}のもとへ`,
    status: OVERLOOK_FOCUS_WAIT_STATUS
  };
}

// ---------- camera ----------

// The camera is the map point at the screen's top-left at scale 1 (地図 1 px = 画面 1 CSS px). Clamped so the
// map's edge is never passed (端で止まる); on an axis where the window is wider than the map, the map is centred.
export function clampOverlookCamera(camera, viewport, map) {
  const axis = (value, view, size) => (view >= size ? (size - view) / 2 : Math.min(Math.max(value, 0), size - view));
  return { x: axis(camera.x, viewport.width, map.width), y: axis(camera.y, viewport.height, map.height) };
}

export function overlookCameraCentredOn(point, viewport, map) {
  return clampOverlookCamera({ x: point.x - viewport.width / 2, y: point.y - viewport.height / 2 }, viewport, map);
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// The map point shown at the screen centre for a camera at a scale. At scale s the screen shows view/s map px.
function centreOf(camera, viewport, scale) {
  return { x: camera.x + viewport.width / (2 * scale), y: camera.y + viewport.height / (2 * scale) };
}

function clampCentre(centre, viewport, map, scale) {
  const view = { width: viewport.width / scale, height: viewport.height / scale };
  const camera = clampOverlookCamera({ x: centre.x - view.width / 2, y: centre.y - view.height / 2 }, view, map);
  return { x: camera.x + view.width / 2, y: camera.y + view.height / 2 };
}

// The focus move (構成表 0.2・状態 6): 0.6 秒で二人の中点が中央へ滑り（倍率 1.0）、続けて 0.5 秒で倍率 1.0 → 1.8
// に寄りながら縁から暗くなる。`elapsedMs` からその瞬間の { centre, scale, dim(0..1), done } を返す。どの瞬間も
// 地図の端より外は見せない。戻り（状態 9 → 10）は `reverse` で同じ道を逆に辿る。
export function overlookFocusCameraFrame({ from, target, viewport, map, elapsedMs, reverse = false }) {
  const total = OVERLOOK_FOCUS_PAN_MS + OVERLOOK_FOCUS_ZOOM_MS;
  const t = Math.min(Math.max(reverse ? total - elapsedMs : elapsedMs, 0), total);
  const start = clampCentre(from, viewport, map, 1);
  const panEnd = clampCentre(target, viewport, map, 1);
  const zoomEnd = clampCentre(target, viewport, map, OVERLOOK_FOCUS_SCALE);
  let centre;
  let scale;
  let dim;
  if (t <= OVERLOOK_FOCUS_PAN_MS) {
    const k = easeInOut(t / OVERLOOK_FOCUS_PAN_MS);
    centre = { x: start.x + (panEnd.x - start.x) * k, y: start.y + (panEnd.y - start.y) * k };
    scale = 1;
    dim = 0;
  } else {
    const k = easeInOut((t - OVERLOOK_FOCUS_PAN_MS) / OVERLOOK_FOCUS_ZOOM_MS);
    scale = 1 + (OVERLOOK_FOCUS_SCALE - 1) * k;
    const bound = clampCentre({ x: panEnd.x + (zoomEnd.x - panEnd.x) * k, y: panEnd.y + (zoomEnd.y - panEnd.y) * k }, viewport, map, scale);
    centre = bound;
    dim = k;
  }
  return { centre, scale, dim, done: elapsedMs >= total };
}

// The screen point of a map point for a camera frame ({centre, scale}).
export function overlookScreenPoint(point, frame, viewport) {
  return {
    x: (point.x - frame.centre.x) * frame.scale + viewport.width / 2,
    y: (point.y - frame.centre.y) * frame.scale + viewport.height / 2
  };
}

export function overlookFrameOfCamera(camera, viewport) {
  return { centre: centreOf(camera, viewport, 1), scale: 1 };
}

// ---------- playback of the server's positions ----------

// The server walks the children tick by tick; the client receives a sample per poll. The screen draws a moment
// OVERLOOK_PLAYBACK_DELAY_MS behind the newest sample and places each child between the two samples around that
// moment, moving along the earlier sample's route (its position then the upcoming nodes) — so a child turns at
// the nodes like the server's does, and a stop the server made (a fork pause, an arrival) shows as a stop.

export function overlookSampleMs(field) {
  return field.clock.tick * field.clock.tick_ms;
}

function pathOf(child) {
  const points = [{ x: child.x, y: child.y }];
  for (const point of child.route) {
    const last = points[points.length - 1];
    if (point.x !== last.x || point.y !== last.y) points.push({ x: point.x, y: point.y });
  }
  return points;
}

function projectOnPath(path, point) {
  let walked = 0;
  let best = { distance: Infinity, along: 0 };
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const u = Math.min(Math.max(((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length), 0), 1);
    const distance = Math.hypot(a.x + dx * u - point.x, a.y + dy * u - point.y);
    if (distance < best.distance - 1e-9) best = { distance, along: walked + length * u };
    walked += length;
  }
  if (path.length === 1) best = { distance: Math.hypot(path[0].x - point.x, path[0].y - point.y), along: 0 };
  return best;
}

function pointAlong(path, along) {
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + length >= along) {
      const u = length === 0 ? 0 : (along - walked) / length;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
    walked += length;
  }
  return { ...path[path.length - 1] };
}

// The unit direction a child walks in (towards its first route node), or null when it has nowhere to go.
export function overlookHeading(child) {
  const path = pathOf(child);
  if (path.length < 2) return null;
  const dx = path[1].x - path[0].x;
  const dy = path[1].y - path[0].y;
  const length = Math.hypot(dx, dy);
  return { x: dx / length, y: dy / length };
}

// 構成表 0.4 の飾り（server の位置は道の上の点だけで、飾りは持たない）:
//   探す・止まっている → 進む向きと直角に ±4 px 揺れて見回す（0.48 秒で一往復）。
//   避ける・歩いている → 1.6 秒ごとに相手の方（進む向きの逆）へ 5 px 戻って振り返る（2 フレーム＝0.16 秒）。
//   確かめる・止まっている → 半径 24 px の輪を 1.6 秒で一巡りする。
export function overlookWalkFlourish(child, momentMs) {
  const heading = overlookHeading(child);
  if (child.pattern === 'search' && child.paused && heading) {
    const sway = OVERLOOK_SEARCH_SWAY_PX * Math.sin((2 * Math.PI * (momentMs % OVERLOOK_SEARCH_SWAY_MS)) / OVERLOOK_SEARCH_SWAY_MS);
    return { x: -heading.y * sway, y: heading.x * sway };
  }
  if (child.pattern === 'avoid' && !child.paused && child.speed_px_per_s > 0 && heading
      && momentMs % OVERLOOK_AVOID_GLANCE_EVERY_MS < OVERLOOK_AVOID_GLANCE_MS) {
    return { x: -heading.x * OVERLOOK_AVOID_GLANCE_PX, y: -heading.y * OVERLOOK_AVOID_GLANCE_PX };
  }
  if (child.pattern === 'check' && child.paused) {
    const angle = (2 * Math.PI * (momentMs % OVERLOOK_CHECK_CIRCLE_MS)) / OVERLOOK_CHECK_CIRCLE_MS;
    return { x: OVERLOOK_CHECK_CIRCLE_PX * Math.sin(angle), y: OVERLOOK_CHECK_CIRCLE_PX * (Math.cos(angle) - 1) };
  }
  return { x: 0, y: 0 };
}

// The positions to draw at `momentMs` (server time), from the samples (oldest first, each a validated field).
// Returns Map(character_id → {x, y}). A child absent from the earlier sample is drawn at the later one.
export function overlookPlaybackPositions(samples, momentMs) {
  requireArray(samples, 'playback samples');
  if (samples.length === 0) throw new Error('overlook playback needs at least one sample');
  let before = samples[0];
  let after = null;
  for (const sample of samples) {
    if (overlookSampleMs(sample) <= momentMs) before = sample;
    else { after = sample; break; }
  }
  const beforeMs = overlookSampleMs(before);
  const positions = new Map();
  for (const child of before.children) {
    const next = after?.children.find((entry) => entry.character_id === child.character_id) ?? null;
    let point = { x: child.x, y: child.y };
    if (next && momentMs > beforeMs) {
      const fraction = Math.min((momentMs - beforeMs) / (overlookSampleMs(after) - beforeMs), 1);
      const path = pathOf(child);
      const projected = projectOnPath(path, next);
      point = projected.distance <= 1
        ? pointAlong(path, projected.along * fraction)
        : { x: child.x + (next.x - child.x) * fraction, y: child.y + (next.y - child.y) * fraction };
    }
    const flourish = overlookWalkFlourish(child, momentMs);
    positions.set(child.character_id, { x: point.x + flourish.x, y: point.y + flourish.y });
  }
  if (after) {
    for (const child of after.children) {
      if (!positions.has(child.character_id)) positions.set(child.character_id, { x: child.x, y: child.y });
    }
  }
  return positions;
}

// Keep the samples the playback can still need: everything newer than the moment plus the one just before it.
export function overlookTrimSamples(samples, momentMs) {
  let keepFrom = 0;
  samples.forEach((sample, index) => {
    if (overlookSampleMs(sample) <= momentMs) keepFrom = index;
  });
  return samples.slice(keepFrom);
}

// ---------- hover premise, hit tests ----------

function rectDistance(point, rect) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

// The hover premise of overlookLayout.js (構成表 0.1): the coma's centre is inside the screen and its rim keeps
// 6 px from every part. A coma outside it belongs to the part above it and gets no hover.
export function isOverlookComaHoverable(point, { screen, parts }) {
  if (point.x < 0 || point.y < 0 || point.x > screen.width || point.y > screen.height) return false;
  return parts.every((part) => rectDistance(point, part) - OVERLOOK_COMA_RADIUS >= 6);
}

// 出ていく途中の子（送り出した時点から）と、門をくぐる前の入ってくる子は、ポインタを置けない（状態 19）。
export function isOverlookChildPointable(child) {
  requireOneOf(child.status, OVERLOOK_CHILD_STATUSES, 'child.status');
  return !OVERLOOK_GATE_STATUSES.includes(child.status);
}

// The coma under a screen point (the nearest centre within the coma radius), or null.
export function overlookComaAt(point, comas) {
  let best = null;
  for (const coma of comas) {
    const distance = Math.hypot(coma.x - point.x, coma.y - point.y);
    if (distance <= OVERLOOK_COMA_RADIUS && (!best || distance < best.distance)) best = { id: coma.id, distance };
  }
  return best ? best.id : null;
}

// The place whose radius holds a map point (the server's rule: normalized Euclid, an ellipse in map px), or null.
export function overlookPlaceAt(places, map, point) {
  for (const place of places) {
    const dx = (point.x - place.x) / map.width;
    const dy = (point.y - place.y) / map.height;
    if (Math.sqrt(dx * dx + dy * dy) <= place.radius) return place;
  }
  return null;
}

// The writing frame's rect (状態 11): 幅 360 px、場所の輪の真上 18 px で左右中央。`height` is the frame's
// rendered height; `ringRadius` the drawn ring's radius.
export function overlookWritingFrameRect(point, { height, ringRadius }) {
  const bottom = point.y - ringRadius - OVERLOOK_WRITING_FRAME_GAP;
  return { left: point.x - OVERLOOK_WRITING_FRAME_WIDTH / 2, top: bottom - height, right: point.x + OVERLOOK_WRITING_FRAME_WIDTH / 2, bottom };
}

// The ring around two meeting children (状態 14): centred on their midpoint, along the line joining them, tall
// enough for a coma with its padding, rounded to a pill. Screen px.
export function overlookPairRing(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  const width = distance + OVERLOOK_COMA_RADIUS * 2 + OVERLOOK_PAIR_RING_PADDING * 2;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    width,
    height: OVERLOOK_PAIR_RING_HEIGHT,
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    cornerRadius: OVERLOOK_PAIR_RING_HEIGHT / 2
  };
}

// The say label rect for a side fixed at stage 1, re-anchored to where the coma is now (状態 4: 札はコマに付いて
// 動き、置き場の側は変えない). Same geometry as placeSayLabel: 10 px from the coma rim, centred on the axis.
export function overlookSayLabelRectAt(point, side, { width, height }) {
  const gap = OVERLOOK_COMA_RADIUS + 10;
  if (side === 'above') return { left: point.x - width / 2, top: point.y - gap - height, right: point.x + width / 2, bottom: point.y - gap };
  if (side === 'below') return { left: point.x - width / 2, top: point.y + gap, right: point.x + width / 2, bottom: point.y + gap + height };
  if (side === 'right') return { left: point.x + gap, top: point.y - height / 2, right: point.x + gap + width, bottom: point.y + height / 2 };
  if (side === 'left') return { left: point.x - gap - width, top: point.y - height / 2, right: point.x - gap, bottom: point.y + height / 2 };
  throw new Error(`overlook say label side is not one of above/below/right/left: ${side}`);
}

// ---------- the layout worker protocol ----------

// app.js → overlookLayoutWorker.js: { id, input } (placeRelationLines の入力). Worker → app.js: { id, ok:true,
// result } or { id, ok:false, error }. One request is in flight at a time; a reply whose id is not the latest
// request's is stale and dropped by the caller.
export function validateOverlookLayoutReply(reply) {
  if (!isObject(reply)) throw new Error('overlook layout reply must be an object');
  if (reply.ok === true) {
    assertExactKeys(reply, ['id', 'ok', 'result'], 'layout reply');
  } else if (reply.ok === false) {
    assertExactKeys(reply, ['id', 'ok', 'error'], 'layout reply');
    requireString(reply.error, 'layout reply.error');
  } else {
    throw new Error('overlook layout reply.ok must be a boolean');
  }
  requireNonNegativeInteger(reply.id, 'layout reply.id');
  return reply;
}
