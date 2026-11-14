// 闘技会 (arena) LLM flavor generation: the only place the arena session talks to the language model.
//
// Two generation surfaces:
//   - Match voices (buildArenaMatchVoicesPrompt): once per match, before it is shown, the model writes five short
//     場内の声 for that match's decisive moments — the start (opening), 東方 / 西方 driven to the edge (east_edge /
//     west_edge), and 東方 / 西方 landing the deciding blow (east_wins / west_wins). The frontend picks among them as
//     the board's events arrive; some are never used. The call is a structured_json call whose response format
//     fixes, per moment, WHO it happened to (the 追い詰められた者 / 勝った者 fields are single-value enums of the
//     side's label), so the voice is written right after the correct side — the model at reasoning 'none' otherwise
//     swaps east and west. The opening carries a 切り口 and a sentence shape and every side moment a sentence shape,
//     picked by the tournament seed and the match's round (散らし). The prompt carries no voice of another match: a
//     model copies a listed voice into the same moment of the next match, swapping only the name.
//   - Result flavor (buildArenaResultPrompt): a one-line 場内アナウンス for the tournament conclusion, composed per
//     outcome. A solo / pair result (champion / eliminated) is the player's own last match — the player's side (with
//     the buddy in a pair) is its subject, and that match's opponent and 番付 are its only other content; the rest of
//     the tournament is out of its scope. Those prompts and their gate share one 字数 cap (ARENA_RESULT_CHAR_CAP)
//     that fits the result stage's two-line box. A spectate result names the buddy and ALWAYS the real champion
//     (naming only the defeated side makes the model fabricate the defeated side as the champion) and carries no
//     字数 line. 1 visit = 1 result, so the result has no handoff.
//
// The player is never called by a name in either surface: the protagonist's display name is the role word 主人公,
// so the prompts carry the player's side as ARENA_UNNAMED_PLAYER_LABEL and ask the model to leave that side
// unnamed (no name, no stand-in word, no 彼 / 彼女). A pair side is the buddy's name with that label; a pair result
// line keeps the player's side as its subject and names the buddy as the one who fought alongside.
//
// No prompt carries a quoted example phrase or a phrase pattern with a blank (a model copies them into every
// line). The arena is a 地の文 surface with no persona and no per-character conversation context, so these prompts
// carry no persona / world-sync / actor-context blocks. Every failure — LM unconfigured / unreachable, unusable
// output — throws a 503-tagged error with nothing persisted. No authored fallback, no truncation, no retry.

import { callLmStudioChat, callLmStudioStructuredJson } from './lmStudioClient.mjs';
import { ARENA_OUTCOMES, ARENA_VOICE_KEYS } from '../arena/arenaTournament.mjs';
import { WORLD_CANON_GUARD_CLAUSE } from './worldCanonGuard.mjs';

// A generation failure is surfaced as a structured 503 (the errand / study / library / 錬成室 / auction contract).
// Unusable output (a voice off the gate, an empty / over-cap result line) is the model failing, so it shares this.
export const ARENA_GENERATION_FAILED_ERROR_CODE = 'ARENA_GENERATION_FAILED';

// Every voice must fit, whole, in the two-line voice box above the board (opening 56字, the others 44字). Counted
// like the result cap: every character of the trimmed text. A voice over its cap fails the match (never truncated).
export const ARENA_VOICE_CHAR_CAPS = Object.freeze({ opening: 56, east_edge: 44, west_edge: 44, east_wins: 44, west_wins: 44 });

// The lengths the prompt asks for, per format (a 2v2 side carries two names). Below the caps so the soft 字数 ask
// lands inside the box.
const ARENA_VOICE_ASK = Object.freeze({
  一対一: Object.freeze({ opening: 40, other: 28 }),
  二対二: Object.freeze({ opening: 40, other: 36 })
});

// A solo / pair result line must fit the result stage's two-line flavor box (幅 560px・16px・word-break: auto-phrase).
// Measured in the real box (at most 560px wide — it shrinks to the text — at both the 1440×900 and 1100×720
// windows) with the roster's longest name (14字) shifted across the first line's end: every line of ≤64字 fit and
// overflow began at 65字 (whole-name phrases wrap early), so 62 keeps a 2字 margin. Counted like the gate: every
// character, spaces included.
export const ARENA_RESULT_CHAR_CAP = 62;

// Defensive cap for the spectate result line (one line, no 字数 ask): fences a markdown / 紹介記事調 runaway only.
export const ARENA_RESULT_HARD_CAP = 200;

// How the prompts carry the player's side: a label the model reads as "this entrant is not to be named".
export const ARENA_UNNAMED_PLAYER_LABEL = '名を呼ばない出場者';

// The 切り口 a line starts from, picked by the tournament seed (散らし): left to itself the model opens every
// tournament's first match, and every champion line, from the same place. The opening voice takes an angle and a
// sentence shape (an angle alone still leaves every opening in one 骨組み), each offset by the match's round: the
// player meets one match per round, so the four openings of a tournament take four different angles and four
// different shapes. The four side moments (east_edge / west_edge / east_wins / west_wins) take a shape each from
// their own list, offset by the round and by the moment's place, so the four moments of one match take four
// different shapes, and one moment takes four different ones across a tournament's four rounds. A side moment takes
// no angle: a 題材 crowds out what happened at that moment. The solo / pair result line takes an angle of its own. Each angle names WHAT to start from and each shape HOW the
// sentence is built — never a phrase.
const ARENA_VOICE_OPENING_ANGLES = Object.freeze([
  '客席のどよめきと熱気',
  '場内に満ちていく魔力の気配',
  'この番付で向き合うことの重み',
  '試合を見守る学院の者たちの眼差し'
]);
const ARENA_VOICE_OPENING_SHAPES = Object.freeze([
  '名を文の頭に置いて語り出す',
  '体言で結ぶ',
  '名を呼ばず、場の様子だけで言い切る',
  '名を文の終わりに置いて言い切る'
]);
const ARENA_VOICE_MOMENT_SHAPES = Object.freeze([
  '名を文の頭に置く',
  '名を文の終わりに置く',
  '短い二つの句を読点でつなぐ',
  '問いかける形で結ぶ'
]);
const ARENA_RESULT_OPENING_ANGLES = Object.freeze([
  '客席の沸き立ち',
  '決着の一瞬の手応え',
  '相手の名',
  'この大会でここまで歩んできた道のり',
  '場内に残る魔力の余韻'
]);

// Picks one entry of a list by an integer seed: (|seed| / stride + offset) mod length. A `stride` > 1 lets two lists
// picked from one seed (the opening's angle and shape) vary independently; `offset` steps through the list. Every
// caller passes both explicitly.
function pickBySeed(entries, seed, label, { stride, offset }) {
  if (!Number.isInteger(seed)) throw new Error(`arena generation ${label} must be an integer`);
  if (!Number.isInteger(stride) || stride < 1) throw new Error(`arena generation ${label} stride must be a positive integer`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`arena generation ${label} offset must be a non-negative integer`);
  return entries[(Math.floor(Math.abs(seed) / stride) + offset) % entries.length];
}

function arenaGenerationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = ARENA_GENERATION_FAILED_ERROR_CODE;
  return error;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`arena generation ${label} is required`);
  return value.trim();
}

// ----- shared prompt fragments -----

const ARENA_VOICE_ROLE = 'あなたは魔法学院の闘技会の場内の語り手である。';
const ARENA_ANNOUNCE_ROLE = 'あなたは魔法学院の闘技会の場内アナウンスの地の文を綴る。';

// The 世界整合ガード行: the anachronism guard followed by the shared canon guard.
const ARENA_WORLD_GUARD_LINE = `- 実在の地名・人名・歴史、現代語・外来語、現代の器具や単位を混ぜない。${WORLD_CANON_GUARD_CLAUSE}`;

// The line that keeps the player unnamed, shared by both surfaces.
const ARENA_UNNAMED_PLAYER_RULE = `- ${ARENA_UNNAMED_PLAYER_LABEL} を指す語を一つも書かない。名も、主人公・彼・彼女・あなた・挑戦者・相棒・伴侶・もう一人のような呼び名も、名もなき者・謎の者・正体不明の者のような言い表しも使わない。その身に起きたことは主語を省いて語る。`;

// A side of a match as the prompts carry it: `names` are the members that may be called by name (略さず), and
// `unnamedPlayer` marks the side the player fights on (the player is carried as ARENA_UNNAMED_PLAYER_LABEL).
function sideLabel(side, label) {
  if (!side || typeof side !== 'object') throw new Error(`arena generation ${label} side is required`);
  if (!Array.isArray(side.names)) throw new Error(`arena generation ${label} side names must be an array`);
  if (typeof side.unnamedPlayer !== 'boolean') throw new Error(`arena generation ${label} side unnamedPlayer must be a boolean`);
  const names = side.names.map((name, index) => requireNonEmptyString(name, `${label} side names[${index}]`));
  const members = side.unnamedPlayer ? [...names, ARENA_UNNAMED_PLAYER_LABEL] : names;
  if (members.length === 0) throw new Error(`arena generation ${label} side has no member`);
  return members.join(' と ');
}

// ----- 試合の声 (pure) -----

function voiceSides({ formatLabel, east, west }) {
  const format = requireNonEmptyString(formatLabel, 'voices formatLabel');
  const ask = ARENA_VOICE_ASK[format];
  if (!ask) throw new Error(`arena generation has no voice length ask for format ${format}`);
  const eastLabel = sideLabel(east, 'voices east');
  const westLabel = sideLabel(west, 'voices west');
  return { format, ask, eastLabel, westLabel, hasUnnamed: east.unnamedPlayer || west.unnamedPlayer };
}

// The match-voices prompt. `roundLabel` / `formatLabel` are the bracket's display strings; `east` / `west` are the
// two sides (team a / team b); `tournamentSeed` and `roundIndex` (0-based) pick the opening's angle and shape and
// every side moment's shape.
export function buildArenaMatchVoicesPrompt({ roundLabel, roundIndex, formatLabel, east, west, tournamentSeed }) {
  const round = requireNonEmptyString(roundLabel, 'voices roundLabel');
  if (!Number.isInteger(roundIndex) || roundIndex < 0) throw new Error(`arena generation voices roundIndex must be a non-negative integer: ${roundIndex}`);
  const angle = pickBySeed(ARENA_VOICE_OPENING_ANGLES, tournamentSeed, 'voices tournamentSeed', { stride: 1, offset: roundIndex });
  const shape = pickBySeed(ARENA_VOICE_OPENING_SHAPES, tournamentSeed, 'voices tournamentSeed', { stride: ARENA_VOICE_OPENING_ANGLES.length, offset: roundIndex });
  const { format, ask, eastLabel, westLabel, hasUnnamed } = voiceSides({ formatLabel, east, west });
  // A side moment's shape: moment `place` (0..3) takes shape `round + place` from its seed-picked start.
  const momentLead = (place) => `声の形は、${pickBySeed(ARENA_VOICE_MOMENT_SHAPES, tournamentSeed, 'voices tournamentSeed', { stride: 1, offset: roundIndex + place })}。`;
  return [
    `${ARENA_VOICE_ROLE}これから始まる一試合のあいだに場内へ響かせる短い声を、試合の前に五つ書いておく。`,
    '声は、試合の中の決まった瞬間が来たときに一つだけ使われる。使われない声もある。応答の「声」の欄に、その瞬間の声だけを書く。',
    '五つの瞬間（誰の身に何が起きた瞬間かを取り違えない）:',
    `- opening: 試合が始まる瞬間。${eastLabel} と ${westLabel} が向き合った。`,
    `- east_edge: ${eastLabel} が追い詰められ、あと一押しで倒れる瞬間。追い詰めているのは ${westLabel}。${momentLead(0)}`,
    `- west_edge: ${westLabel} が追い詰められ、あと一押しで倒れる瞬間。追い詰めているのは ${eastLabel}。${momentLead(1)}`,
    `- east_wins: ${eastLabel} が決着の一撃を決め、${westLabel} を下した瞬間。${momentLead(2)}`,
    `- west_wins: ${westLabel} が決着の一撃を決め、${eastLabel} を下した瞬間。${momentLead(3)}`,
    '書き方の縛り:',
    `- opening は${ask.opening}字以内、ほかの四つはそれぞれ${ask.other}字以内。どれも一息で言い切る。`,
    '- その瞬間に場内へ放つ生の声として書く。試合を外から解説・要約しない。',
    '- まだ起きていない経過を作らない。何手目か、どの魔法か、どれだけの傷かには触れない。',
    '- 名を呼ぶときは略さずそのまま書く。一つの声で名を呼ぶのは二人まで。',
    ...(hasUnnamed ? [ARENA_UNNAMED_PLAYER_RULE, `- opening では ${ARENA_UNNAMED_PLAYER_LABEL} に触れない（対峙する者・その相手のように言い換えて置くこともしない）。`] : []),
    `- opening は、${angle}を題材に、${shape}。番付の名から語り出さない。号令や呼びかけで締めない。静寂や火花のような使い古された景物から始めない。`,
    '- 引用符や鉤括弧で言葉を囲わない。見出し・前置き・ト書きは書かない。',
    '- 五つの声で語り出しと結びの形を変える。陳腐な決まり文句や同じ賛辞を繰り返さない。',
    'この試合の確定情報（勝敗を先読みしない・居ない出場者を出さない）:',
    `- 番付: ${round}`,
    `- 形式: ${format}`,
    ARENA_WORLD_GUARD_LINE
  ].join('\n');
}

// The response format: opening is a bare string; the four side moments each carry the sides' fixed labels before
// the 声 field (single-value enums), so the model writes the voice right after naming who it happened to.
function fixedValue(value) {
  return { type: 'string', enum: [value] };
}
function sideMoment(fields) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...Object.keys(fields), '声'],
    properties: { ...fields, 声: { type: 'string' } }
  };
}
export function arenaMatchVoicesResponseFormat({ formatLabel, east, west }) {
  const { eastLabel, westLabel } = voiceSides({ formatLabel, east, west });
  return {
    type: 'json_schema',
    json_schema: {
      name: 'arena_match_voices',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...ARENA_VOICE_KEYS],
        properties: {
          opening: { type: 'string' },
          east_edge: sideMoment({ 追い詰められた者: fixedValue(eastLabel), 追い詰めている者: fixedValue(westLabel) }),
          west_edge: sideMoment({ 追い詰められた者: fixedValue(westLabel), 追い詰めている者: fixedValue(eastLabel) }),
          east_wins: sideMoment({ 勝った者: fixedValue(eastLabel), 敗れた者: fixedValue(westLabel) }),
          west_wins: sideMoment({ 勝った者: fixedValue(westLabel), 敗れた者: fixedValue(eastLabel) })
        }
      }
    }
  };
}

// ----- 優勝/敗退実況一文 (pure) -----

// Whether the result line is the player's own (solo / pair: champion / eliminated) — the line held to the two-line box.
// The mode must agree with the outcome (spectated_* only in spectate, champion / eliminated only in solo / pair).
function isPlayerResult({ outcome, mode }) {
  if (outcome === 'spectated_champion' || outcome === 'spectated_eliminated') {
    if (mode !== 'spectate') throw new Error(`arena result flavor mode for ${outcome} must be spectate: ${mode}`);
    return false;
  }
  if (mode !== 'solo' && mode !== 'pair') throw new Error(`arena result flavor mode for ${outcome} must be solo or pair: ${mode}`);
  return true;
}

// The player's side of the last match: the unnamed player alone (solo), or the unnamed player with the named buddy
// carried on its own line as the one who fought alongside (pair).
function playerSide({ mode, buddyName }) {
  if (mode === 'solo') {
    if (buddyName !== undefined) throw new Error('arena result flavor buddyName is only for a pair or spectate tournament');
    return { lines: [`- こちらの側: ${ARENA_UNNAMED_PLAYER_LABEL}（一人で出場）`], mustName: [] };
  }
  const buddy = requireNonEmptyString(buddyName, 'result buddyName');
  return { lines: [`- こちらの側: ${ARENA_UNNAMED_PLAYER_LABEL}`, `- 並んで戦った連れ: ${buddy}`], mustName: [buddy] };
}

// The player's last match: champion — the final and its opponent; eliminated — the 番付 and the opponent that ended
// the player's run.
function playerLastMatch({ outcome, mode, buddyName, finalistName, defeatRoundLabel, defeaterName }) {
  const side = playerSide({ mode, buddyName });
  const champion = outcome === 'champion';
  const round = champion ? '決勝' : requireNonEmptyString(defeatRoundLabel, 'result defeatRoundLabel');
  const opponent = champion
    ? requireNonEmptyString(finalistName, 'result finalistName')
    : requireNonEmptyString(defeaterName, 'result defeaterName');
  return {
    info: [
      ...side.lines,
      `- 番付: ${round}`,
      `- 相手: ${opponent}`,
      champion ? '- 決着: こちらの側が勝ち、この大会で優勝した' : '- 決着: こちらの側が敗れ、この大会の戦いを終えた'
    ],
    mustName: [...side.mustName, opponent]
  };
}

// Who the result line is about: the player's side, the player left unnamed (the subject goes unsaid). In a pair the
// buddy enters by name as the one who fought alongside the player — never the subject, never the head the pair is
// counted from. No word for the pair is suggested (a model copies it).
function playerSubjectRules({ mode, buddyName }) {
  if (mode === 'solo') {
    return [
      '- 文の主役はこちらの側。こちらの側が何を成し遂げたか、どこで力尽きたかを語る。相手を主語にして相手の働きだけを語る文にしない。',
      ARENA_UNNAMED_PLAYER_RULE
    ];
  }
  const buddy = requireNonEmptyString(buddyName, 'result buddyName');
  return [
    `- 文の主役は ${ARENA_UNNAMED_PLAYER_LABEL}。${ARENA_UNNAMED_PLAYER_LABEL} が ${buddy} と並んで戦い、何を成し遂げたか、どこで力尽きたかを語る。${buddy} は ${ARENA_UNNAMED_PLAYER_LABEL} の傍らで戦った連れとして名で文に入れ、${buddy} を主語にも、二人をくくる語の頭にもしない。相手を主語にもしない。`,
    ARENA_UNNAMED_PLAYER_RULE,
    `- 字数が詰まるときは場の様子や飾りの言葉を削る。${buddy} と相手の名は削らない。`
  ];
}

// The solo / pair result prompt: the player's last match is the only subject, the player's side is its 主役,
// held to ARENA_RESULT_CHAR_CAP. `tournamentSeed` picks the line's opening angle.
function buildPlayerResultPrompt(inputs) {
  const { info, mustName } = playerLastMatch(inputs);
  const angle = pickBySeed(ARENA_RESULT_OPENING_ANGLES, inputs.tournamentSeed, 'result tournamentSeed', { stride: 1, offset: 0 });
  return [
    `${ARENA_ANNOUNCE_ROLE}こちらの側のこの大会での最後の一戦について、結果を告げる実況を一文だけ書く。`,
    '書き方の縛り:',
    ...playerSubjectRules(inputs),
    '- 語るのはこちらの側とこの一戦の相手だけ。ほかの試合・ほかの出場者・大会のその後の行方には触れない。',
    '- 結果を外から解説・要約する話法にせず、会場の観客へこの一戦の決着を告げる、場内に響く生のアナウンスとして書く。',
    '- 引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。',
    `- ${angle}から語り出す。書き出しを番付の名や勝ち負けを言う言葉から始めない。`,
    '- 陳腐な決まり文句や毎回同じ語り出し・同じ賛辞を避け、この一戦ならではの言葉で語る。',
    'この一戦の確定した結果（この結果に忠実に。勝敗を捏造しない・居ない出場者を出さない）:',
    ...info,
    ARENA_WORLD_GUARD_LINE,
    `${mustName.join('、')} の名を略さずそのまま一文の中に入れる。一文だけで、長さは${ARENA_RESULT_CHAR_CAP}字以内。`
  ].join('\n');
}

// The spectate result info + tail instruction. Both branches name the REAL champion: spectated_champion states the
// buddy as the winner; spectated_eliminated appends the tournament champion so the model cannot fabricate the
// defeated opponent as the champion.
function spectatedResultInfo({ outcome, championName, buddyName, defeatRoundLabel, defeaterName }) {
  const buddy = requireNonEmptyString(buddyName, 'result buddyName');
  if (outcome === 'spectated_champion') {
    return {
      info: [`- 優勝者: ${buddy}`, `- ${buddy} は決勝を制して優勝した`],
      tail: '一文だけで書く。'
    };
  }
  const round = requireNonEmptyString(defeatRoundLabel, 'result defeatRoundLabel');
  const defeater = requireNonEmptyString(defeaterName, 'result defeaterName');
  const champion = requireNonEmptyString(championName, 'result championName');
  return {
    info: [`- ${buddy} は${round}で ${defeater} に敗れて姿を消した`, `- この大会の優勝者は ${champion}`],
    tail: `${buddy} が敗れたことと、優勝者が誰かの両方に触れ、一文だけで書く。`
  };
}

// The spectate result prompt. The 陳腐語禁止 line is its sole 散らし lever (1 visit = 1 result, no handoff).
function buildSpectatedResultPrompt(inputs) {
  const { info, tail } = spectatedResultInfo(inputs);
  return [
    `${ARENA_ANNOUNCE_ROLE}大会の全試合が終わり、結果を告げる実況を一文だけ書く。`,
    '書き方の縛り:',
    '- 結果を外から解説・要約する話法にしない。大会そのものを主題に立てて振り返る紹介記事の調子や、結末を説明の言い回しでくくる解説の枠で書かない。',
    '- 会場の観客へ結果を告げる、場内に響く生のアナウンスとして書く。',
    '- 引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。',
    '- 陳腐な決まり文句や毎回同じ語り出し・同じ賛辞を避け、この結果ならではの言葉で語る。',
    'この大会の確定した結果（この結果に忠実に。勝敗を捏造しない・居ない出場者を出さない）:',
    ...info,
    ARENA_WORLD_GUARD_LINE,
    tail
  ].join('\n');
}

export function buildArenaResultPrompt(inputs) {
  if (!ARENA_OUTCOMES.includes(inputs?.outcome)) {
    throw new Error(`arena result flavor outcome must be one of ${ARENA_OUTCOMES.join('/')}: ${inputs?.outcome}`);
  }
  return isPlayerResult(inputs) ? buildPlayerResultPrompt(inputs) : buildSpectatedResultPrompt(inputs);
}

// ----- gates (pure) -----

const QUOTE_MARKS = /[「」『』"“”]/;

// The five voices: every one present, unquoted, within its cap. Any miss fails the whole match (no truncation, no
// partial set). Returns the trimmed voices keyed by ARENA_VOICE_KEYS.
export function gateArenaMatchVoices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw arenaGenerationError('arena match voices generation returned a non-object');
  }
  const voices = {};
  for (const key of ARENA_VOICE_KEYS) {
    const written = key === 'opening' ? value[key] : value[key]?.声;
    const text = typeof written === 'string' ? written.trim() : '';
    if (!text) throw arenaGenerationError(`arena match voice ${key} is empty`);
    const length = [...text].length;
    if (length > ARENA_VOICE_CHAR_CAPS[key]) {
      throw arenaGenerationError(`arena match voice ${key} exceeded the ${ARENA_VOICE_CHAR_CAPS[key]} character cap: got ${length}`);
    }
    if (QUOTE_MARKS.test(text)) throw arenaGenerationError(`arena match voice ${key} carries quote marks`);
    voices[key] = text;
  }
  return voices;
}

// `outcome` / `mode` pick the cap: an over-cap solo / pair result line fails like any unusable output.
export function gateArenaResultFlavor(text, { outcome, mode }) {
  const cap = isPlayerResult({ outcome, mode }) ? ARENA_RESULT_CHAR_CAP : ARENA_RESULT_HARD_CAP;
  if (typeof text !== 'string' || !text.trim()) {
    throw arenaGenerationError('arena result flavor generation returned empty output');
  }
  const trimmed = text.trim();
  if ([...trimmed].length > cap) {
    throw arenaGenerationError(`arena result flavor exceeded the ${cap} character cap: got ${[...trimmed].length}`);
  }
  return trimmed;
}

// ----- orchestration (call the model) -----

// Generates one match's five voices (one structured_json call). Returns the gated voices.
export async function generateArenaVoices({ config, fetchImpl, roundLabel, roundIndex, formatLabel, east, west, tournamentSeed } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for arena match voices');
  const prompt = buildArenaMatchVoicesPrompt({ roundLabel, roundIndex, formatLabel, east, west, tournamentSeed });
  const responseFormat = arenaMatchVoicesResponseFormat({ formatLabel, east, west });
  let value;
  try {
    value = await callLmStudioStructuredJson({ config, prompt, fetchImpl, responseFormat, title: '闘技会の試合の声生成' });
  } catch (error) {
    if (error.statusCode) throw error; // LM unconfigured / unreachable keep their own 503
    throw arenaGenerationError(`arena match voices generation failed: ${error.message}`);
  }
  return gateArenaMatchVoices(value);
}

// Generates the tournament result flavor (chat). Returns the gated text.
export async function generateArenaResultFlavor({ config, fetchImpl, onDelta, ...inputs } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for arena result flavor');
  const prompt = buildArenaResultPrompt(inputs);
  return gateArenaResultFlavor(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '闘技会の結果実況生成' }), inputs);
}
