// 闘技会 (arena) LLM flavor generation: the only place the arena session talks to the language model.
//
// Two generation surfaces, built verbatim from the reviewed 実測 prompt templates in the arena LLM flavor
// investigation (docs/reports/arena-llm-flavor-investigation.md §3 口上 / §4 実況一文):
//   - Match intro (buildArenaIntroPrompt): a 場内アナウンス風の地の文 (固有 persona を立てない・§2 で確定) that
//     announces the start of a match the player actually sees (a player match or a spectator-replayable auto
//     match). The two 散らし levers of the intro are: the 陳腐語禁止 constraint line (always) and the visit's
//     already-spoken intros handoff (only once ≥1 intro has been spoken this tournament — §6). Chat 経路.
//   - Result flavor (buildArenaResultPrompt): a one-line 場内アナウンス for the tournament conclusion. The
//     {result_info} is composed per outcome and ALWAYS names the real champion (§4/§7-1: naming only the
//     defeated side makes the model fabricate the defeated side as the champion). The intro's handoff has no
//     counterpart here (1 visit = 1 result・§6), so its 散らし is the 陳腐語禁止 line only. Chat 経路.
//
// The arena is a 地の文 surface with no persona and no per-character conversation context, so — unlike
// auctionGeneration — these prompts carry no persona / world-sync / actor-context blocks; the templates are
// self-contained. Every failure — LM unconfigured/unreachable, empty/over-cap output — throws a 503-tagged error
// with nothing persisted. No authored fallback, no silent retry. The benchmark-confirmed template wording is
// fixed (any wording change goes back to Lead first).

import { callLmStudioChat } from './lmStudioClient.mjs';
import { ARENA_OUTCOMES } from '../arena/arenaTournament.mjs';

// A generation failure is surfaced as a structured 503 (the errand / study / library / 錬成室 / auction contract).
// An empty / over-cap output is the model producing unusable output, so it shares this status.
export const ARENA_GENERATION_FAILED_ERROR_CODE = 'ARENA_GENERATION_FAILED';

// Defensive hard caps: the templates target 80〜140字 (intro) / one line (result). The 字数指定 is soft, so a
// modest overshoot is normal (§7-3: intro 130〜143字 with the handoff); these caps only fence a markdown /
// 紹介記事調 runaway (§1 対照群: intro C0=1094字・result C0=396字), which is unusable output.
export const ARENA_INTRO_HARD_CAP = 300;
export const ARENA_RESULT_HARD_CAP = 200;

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

// ----- shared prompt fragments (benchmark-confirmed, wording fixed) -----

// The 語り形 role line shared by both surfaces (§2/§3/§4: 場内アナウンスの地の文・固有 persona なし).
const ARENA_ANNOUNCE_ROLE = 'あなたは魔法学院の闘技会の場内アナウンスの地の文を綴る。';

// The 世界整合ガード行 (§7-4: the anachronism guard that doubles as the 世界語彙 seed — always present).
const ARENA_WORLD_GUARD_LINE = '- 実在の地名・人名・歴史、現代語・外来語、現代の器具や単位を混ぜない（この世界は星の残光と地脈の魔法が息づく古い学院世界である）。';

// ----- 試合前口上 (§3・pure) -----

// The visit's already-spoken intros handoff (§6・2レバー目): drops entirely when no intro has been spoken yet
// (第1試合＝0本なら 行ごと非出力), so the first intro of a tournament reads the base form.
function priorIntrosBlockLines(priorIntros) {
  const lines = (Array.isArray(priorIntros) ? priorIntros : [])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return [
    'この闘技会でこれまでに述べた口上（語り出し・言い回しを繰り返さない。特に同じ書き出しで始めない）:',
    ...lines.map((line) => `- ${line}`)
  ];
}

// The match-intro prompt (§3 採用テンプレ verbatim). `roundLabel` / `formatLabel` / `eastNames` / `westNames`
// are the resolved display strings from the slot bracket (arenaIntroPromptInputs); `priorIntros` is the visit's
// prior intros for the 散らし handoff. The 陳腐語禁止 line is always in the 書き方の縛り (散らし lever 1).
export function buildArenaIntroPrompt({ roundLabel, formatLabel, eastNames, westNames, priorIntros = [] }) {
  const round = requireNonEmptyString(roundLabel, 'intro roundLabel');
  const format = requireNonEmptyString(formatLabel, 'intro formatLabel');
  const east = requireNonEmptyString(eastNames, 'intro eastNames');
  const west = requireNonEmptyString(westNames, 'intro westNames');
  return [
    `${ARENA_ANNOUNCE_ROLE}次の試合の開始を告げる短い口上を書く。`,
    '書き方の縛り:',
    '- 試合を外から解説・要約する話法にしない。「この試合は」「本試合は」「〜が見どころだ」のような紹介記事調・解説枠で書かない。',
    '- 会場の観客へ試合の始まりを告げる、場内に響く生のアナウンスとして書く。',
    '- 引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。',
    '- 陳腐な決まり文句や毎回同じ語り出し・同じ賛辞を避け、この一戦ならではの言葉で語る。同じ言い回しを繰り返さない。',
    ...priorIntrosBlockLines(priorIntros),
    'この試合の確定情報（すべて口上に自然に織り込む。勝敗を先読みしない・居ない出場者を出さない）:',
    `- 番付: ${round}`,
    `- 形式: ${format}`,
    `- 東方: ${east}`,
    `- 西方: ${west}`,
    ARENA_WORLD_GUARD_LINE,
    '長さは80〜140字くらい。'
  ].join('\n');
}

// ----- 優勝/敗退実況一文 (§4・pure) -----

// The per-outcome {result_info} block + {tail} instruction. Every branch names the REAL champion (§4/§7-1):
// champion / spectated_champion state the winner directly; eliminated / spectated_eliminated append the
// tournament champion so the model cannot fabricate the defeated opponent as the champion.
function arenaResultInfo({ outcome, championName, finalistName, buddyName, defeatRoundLabel, defeaterName }) {
  if (outcome === 'champion') {
    const finalist = requireNonEmptyString(finalistName, 'result finalistName');
    return {
      info: ['- 優勝者: 主人公', `- 主人公は決勝で ${finalist} を下して優勝した`],
      tail: '一文だけで書く。'
    };
  }
  if (outcome === 'eliminated') {
    const round = requireNonEmptyString(defeatRoundLabel, 'result defeatRoundLabel');
    const defeater = requireNonEmptyString(defeaterName, 'result defeaterName');
    const champion = requireNonEmptyString(championName, 'result championName');
    return {
      info: [`- 主人公は${round}で ${defeater} に敗れて姿を消した`, `- この大会の優勝者は ${champion}`],
      tail: '主人公が敗れたことと、優勝者が誰かの両方に触れ、一文だけで書く。'
    };
  }
  if (outcome === 'spectated_champion') {
    const buddy = requireNonEmptyString(buddyName, 'result buddyName');
    return {
      info: [`- 優勝者: ${buddy}（主人公の相棒）`, `- ${buddy} は決勝を制して優勝した`],
      tail: '一文だけで書く。'
    };
  }
  if (outcome === 'spectated_eliminated') {
    const buddy = requireNonEmptyString(buddyName, 'result buddyName');
    const round = requireNonEmptyString(defeatRoundLabel, 'result defeatRoundLabel');
    const defeater = requireNonEmptyString(defeaterName, 'result defeaterName');
    const champion = requireNonEmptyString(championName, 'result championName');
    return {
      info: [`- 主人公の相棒 ${buddy} は${round}で ${defeater} に敗れて姿を消した`, `- この大会の優勝者は ${champion}`],
      tail: '相棒が敗れたことと、優勝者が誰かの両方に触れ、一文だけで書く。'
    };
  }
  throw new Error(`arena result flavor unknown outcome: ${outcome}`);
}

// The result-flavor prompt (§4 採用テンプレ verbatim). The 陳腐語禁止 line is the sole 散らし lever (§6: 1 visit =
// 1 result, so there is no handoff counterpart).
export function buildArenaResultPrompt(inputs) {
  if (!ARENA_OUTCOMES.includes(inputs?.outcome)) {
    throw new Error(`arena result flavor outcome must be one of ${ARENA_OUTCOMES.join('/')}: ${inputs?.outcome}`);
  }
  const { info, tail } = arenaResultInfo(inputs);
  return [
    `${ARENA_ANNOUNCE_ROLE}大会の全試合が終わり、結果を告げる実況を一文だけ書く。`,
    '書き方の縛り:',
    '- 結果を外から解説・要約する話法にしない。「この大会は」「〜という結果になった」のような紹介記事調・解説枠で書かない。',
    '- 会場の観客へ結果を告げる、場内に響く生のアナウンスとして書く。',
    '- 引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。',
    '- 陳腐な決まり文句や毎回同じ語り出し・同じ賛辞を避け、この結果ならではの言葉で語る。',
    'この大会の確定した結果（この結果に忠実に。勝敗を捏造しない・居ない出場者を出さない）:',
    ...info,
    ARENA_WORLD_GUARD_LINE,
    tail
  ].join('\n');
}

// ----- gates (pure) -----

function gateArenaText(text, cap, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw arenaGenerationError(`arena ${label} generation returned empty output`);
  }
  const trimmed = text.trim();
  if ([...trimmed].length > cap) {
    throw arenaGenerationError(`arena ${label} exceeded the ${cap} character cap: got ${[...trimmed].length}`);
  }
  return trimmed;
}

export function gateArenaIntro(text) {
  return gateArenaText(text, ARENA_INTRO_HARD_CAP, 'intro');
}

export function gateArenaResultFlavor(text) {
  return gateArenaText(text, ARENA_RESULT_HARD_CAP, 'result flavor');
}

// ----- orchestration (call the model) -----

// Generates one match intro (chat・onDelta streams the 口上). Returns the gated text.
export async function generateArenaIntro({ config, fetchImpl, onDelta, roundLabel, formatLabel, eastNames, westNames, priorIntros = [] } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for arena intro');
  const prompt = buildArenaIntroPrompt({ roundLabel, formatLabel, eastNames, westNames, priorIntros });
  return gateArenaIntro(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '闘技会の試合前口上生成' }));
}

// Generates the tournament result flavor (chat). Returns the gated text.
export async function generateArenaResultFlavor({ config, fetchImpl, onDelta, ...inputs } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for arena result flavor');
  const prompt = buildArenaResultPrompt(inputs);
  return gateArenaResultFlavor(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '闘技会の結果実況生成' }));
}
