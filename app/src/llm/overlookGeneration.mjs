// 星見の窓 (overlook) LLM generation: the only place the overlook destination talks to the language model, and
// the home of every overlook prompt.
//
// The feature side (routingOverlook / overlookConversation) receives these as an injected `generators` object
// and never sees LM config. Seven generators:
//   decideWish       — structured JSON: one wish (action / target / 一言) from 人柄・いまの状態・いる場所. After a
//                      closed talk it also reads the wish the child held, the talk's outcome and what happened in
//                      it (the whole talk, or the seed, the reply and the trace of an unwatched one); a fulfilled
//                      wish is read as done.
//   generateSeed     — structured JSON: the one-line scene of a watched encounter (種), from both states and the
//                      place.
//   generateUtterance— one line of a two-child talk, assembled with the 談話室 parts unchanged: the speaker's
//                      full prompt (buildCharacterPrompt over the selectable prompt profile, the actor-context
//                      snapshot, the speech constraints and a speaker-named shared history) and the emotion
//                      choice (turnType 'emotion_choice' → normalizeEmotionChoice). Two LM calls (emotion, chat).
//   judgeOutcome     — reflection text, one word of the outcomes judgeable at that line (overlookJudgeableOutcomes).
//                      Built from the 談話室 stay judgment's parts: a third-person reading of the record, the ban
//                      list and the just-spoken line re-injected. A wish aimed at the partner is fulfilled or refused
//                      by the partner's reply: before the partner has spoken only 続く・別の決着 can be returned, after
//                      it the partner's latest reply is re-injected. A wish aimed at another child is neither
//                      fulfilled nor refused in this talk (続く・別の決着 only). Any other output is a 503.
//   judgeStagnation  — reflection text, strict true / false: is the talk circling without moving? Any other
//                      output is a 503.
//   rewriteState     — structured JSON: one child's new feeling toward the partner, concerns and mood after a
//                      closed talk.
//   resolveOffscreen — structured JSON: an encounter nobody watched, without utterances — its seed line, the
//                      partner's one-line reply, the outcome (decided by that reply when the wish is aimed at the
//                      partner; 別の決着 when it is aimed at another child), the one-line trace left at the place,
//                      and both children's rewritten states in one call.
//
// The structured stages (wish, seed, rewrite, offscreen) retry gate violations up to OVERLOOK_MAX_ATTEMPTS, each
// retry carrying the previous answer's violations (which item, its count or length, the limit), then 503.
//
// LM unconfigured / unreachable, HTTP and parse failures propagate as lmStudioClient raises them (the 503
// LMSTUDIO_CONNECTION_UNAVAILABLE path). The LM gets no seed: its output would not reproduce anyway.

import { buildCharacterPrompt } from './promptBuilder.mjs';
import { normalizeEmotionChoice } from './conversationPipeline.mjs';
import { callLmStudioReflectionText, callLmStudioStructuredJson, createLmStudioProviders } from './lmStudioClient.mjs';
import {
  OVERLOOK_CONCERNS_MAX,
  OVERLOOK_FEELING_LABELS,
  OVERLOOK_MOODS,
  OVERLOOK_WISH_ACTIONS,
  OVERLOOK_WISH_TARGET_KINDS
} from '../overlookState.mjs';

export const OVERLOOK_MAX_ATTEMPTS = 3;
export const OVERLOOK_OUTCOMES = Object.freeze(['続く', '果たされた', '断られた', '別の決着']);
export const OVERLOOK_CLOSING_OUTCOMES = Object.freeze(['果たされた', '断られた', '別の決着']);
export const OVERLOOK_WISH_LINE_MAX = 30;
export const OVERLOOK_SEED_LINE_MAX = 60;
export const OVERLOOK_TRACE_LINE_MAX = 40;
export const OVERLOOK_STATE_LINE_MAX = 40;
export const OVERLOOK_REPLY_LINE_MAX = 40;
// The head of the concern that keeps a fulfilled wish (「済んだ: <一言>」, added by the runtime after the rewrite).
// A wish line passes the wish gate, so the concern it becomes passes the rewrite gate as it is.
export const OVERLOOK_DONE_CONCERN_PREFIX = '済んだ: ';
if ([...OVERLOOK_DONE_CONCERN_PREFIX].length + OVERLOOK_WISH_LINE_MAX > OVERLOOK_STATE_LINE_MAX) {
  throw new Error('overlook done concern (prefix + wish line) must fit the concern line limit');
}

// How the initiator's wish meets this partner: 'partner' (it names the partner), 'other-child' (it names another
// child), or 'open' (it names a place, or there is no wish).
function wishAim(initiatorWish, partnerId) {
  if (typeof partnerId !== 'string' || !partnerId) throw new Error('overlook wish aim requires partnerId');
  if (initiatorWish?.target.kind !== 'child') return 'open';
  return initiatorWish.target.id === partnerId ? 'partner' : 'other-child';
}

// The outcomes a judgment may return after a line. A wish aimed at the partner is fulfilled or refused by the
// partner's reply, so until the partner has spoken it can only go on or close on another settlement; a wish aimed
// at another child is neither fulfilled nor refused by this talk; any other wish (aimed at a place, or none) is
// judged on the closed four.
export function overlookJudgeableOutcomes({ initiatorWish, partnerId, partnerReplied }) {
  if (typeof partnerReplied !== 'boolean') throw new Error('overlook judgeable outcomes require partnerReplied');
  const aim = wishAim(initiatorWish, partnerId);
  if (aim === 'other-child' || (aim === 'partner' && !partnerReplied)) return ['続く', '別の決着'];
  return [...OVERLOOK_OUTCOMES];
}

export const OVERLOOK_GENERATION_FAILED_ERROR_CODE = 'OVERLOOK_GENERATION_FAILED';
export const OVERLOOK_JUDGMENT_INVALID_ERROR_CODE = 'OVERLOOK_JUDGMENT_INVALID';

export class OverlookGenerationError extends Error {
  constructor({ stage, violations }) {
    super(`overlook generation failed at ${stage}: ${violations.join(', ')}`);
    this.name = 'OverlookGenerationError';
    this.code = OVERLOOK_GENERATION_FAILED_ERROR_CODE;
    this.errorCode = OVERLOOK_GENERATION_FAILED_ERROR_CODE;
    this.statusCode = 503;
    this.stage = stage;
    this.violations = violations;
  }
}

function judgmentInvalidError(stage, raw) {
  const error = new Error(`overlook ${stage} judgment returned an answer outside its closed set: ${JSON.stringify(raw)}`);
  error.code = OVERLOOK_JUDGMENT_INVALID_ERROR_CODE;
  error.errorCode = OVERLOOK_JUDGMENT_INVALID_ERROR_CODE;
  error.statusCode = 503;
  error.stage = stage;
  return error;
}

// ---------- shared rendering ----------

const WISH_ACTION_GUIDE = [
  '探す: 相手を探して、場所から場所へ渡り歩く（相手は生徒）',
  '会う: 相手のところへまっすぐ向かって会う（相手は生徒）',
  '避ける: 相手と顔を合わせないよう離れる（相手は生徒）',
  '籠もる: 一つの場所へ行って、そこでじっと過ごす（相手は場所）',
  '確かめる: 場所か相手のところへ行って、何かを確かめる（相手は場所か生徒）'
];

function requireName(nameOf, id) {
  const name = nameOf(id);
  if (typeof name !== 'string' || !name) throw new Error(`overlook prompt has no name for ${id}`);
  return name;
}

function wishText(wish, { nameOf, placeNameOf }) {
  if (!wish) return 'まだ決めていない';
  const target = wish.target.kind === 'child' ? requireName(nameOf, wish.target.id) : requireName(placeNameOf, wish.target.id);
  return `${wish.action}（相手: ${target}）「${wish.line}」`;
}

// The four-part state as prompt lines. Feelings list every other child the state names. `withWish: false` leaves
// the wish out (the decision after a talk shows the wish the child held as what it had, not what it has).
export function renderOverlookChildState(state, { nameOf, placeNameOf }, { withWish = true } = {}) {
  const feelings = Object.entries(state.feelings);
  const feelingLines = feelings.length
    ? feelings.map(([otherId, feeling]) => `  - ${requireName(nameOf, otherId)}: ${feeling.label}（${feeling.text}）`)
    : ['  - まだ誰にも特別な気持ちはない'];
  const concernLines = state.concerns.length ? state.concerns.map((concern) => `  - ${concern.text}`) : ['  - なし'];
  return [
    `- いまの気分: ${state.mood}`,
    '- 相手への気持ち:',
    ...feelingLines,
    '- 抱えている事:',
    ...concernLines,
    withWish ? `- したいこと: ${wishText(state.wish, { nameOf, placeNameOf })}` : null
  ].filter((line) => line !== null).join('\n');
}

function profileLines(profile) {
  return [
    `- 名前: ${profile.display_name}`,
    profile.school_year || profile.club ? `- 学年・所属: ${[profile.school_year, profile.club].filter(Boolean).join('・')}` : null,
    profile.prompt_description ? `- 人物像: ${profile.prompt_description}` : null
  ].filter(Boolean).join('\n');
}

function transcriptLines(history) {
  return history.map((message) => `- ${message.speaker_name}: ${message.content}`).join('\n');
}

function singleLine(value, max, label, violations) {
  if (typeof value !== 'string') {
    violations.push(`${label} must be a string`);
    return;
  }
  const text = value.trim();
  if (!text) violations.push(`${label} is empty`);
  if (/[\r\n]/.test(text)) violations.push(`${label} must be one line`);
  if (/[「」『』"]/.test(text)) violations.push(`${label} must not quote`);
  const length = [...text].length;
  if (length > max) violations.push(`${label} exceeds ${max} characters: ${length}`);
}

// The prompt of a retry: the stage's prompt, then what the previous answer broke.
function retryPrompt(prompt, violations) {
  if (!violations.length) return prompt;
  return [prompt, '', '前の答えは次の決まりに合わなかった。この点を直した JSON を返す:', ...violations.map((violation) => `- ${violation}`)].join('\n');
}

async function runGatedStage({ stage, config, fetchImpl, prompt, responseFormat, title, validate }) {
  let violations = [];
  for (let attempt = 1; attempt <= OVERLOOK_MAX_ATTEMPTS; attempt += 1) {
    const candidate = await callLmStudioStructuredJson({ config, prompt: retryPrompt(prompt, violations), fetchImpl, responseFormat, title });
    violations = validate(candidate);
    if (violations.length === 0) return candidate;
  }
  throw new OverlookGenerationError({ stage, violations });
}

function exactKeys(value, keys, label, violations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort().join(',');
  if (actual !== [...keys].sort().join(',')) {
    violations.push(`${label} keys must be ${[...keys].sort().join(',')}: got ${actual}`);
    return false;
  }
  return true;
}

// ---------- decideWish ----------

export const OVERLOOK_WISH_TRIGGERS = Object.freeze(['entry', 'arrival', 'lapsed', 'conversation', 'writing']);

// An academy minute (minutes since midnight) as 「13時05分」.
function academyClockText(minute) {
  if (!Number.isInteger(minute) || minute < 0) throw new Error(`overlook arrival trigger minute must be a non-negative integer: ${minute}`);
  return `${Math.floor(minute / 60)}時${String(minute % 60).padStart(2, '0')}分`;
}

function triggerLine(trigger, { nameOf }) {
  if (trigger.kind === 'entry') return '学院の朝が始まった。今日これからの学院の1時間ほどで、したいことを決める。';
  if (trigger.kind === 'arrival') {
    return `学院の時刻は${academyClockText(trigger.minute)}。いま正門から学院に入ってきたところ。ここからの学院の1時間ほどで、したいことを決める。`;
  }
  if (trigger.kind === 'lapsed') return '前のしたいことは、誰とも話さないまま時間が過ぎて終わった。次にしたいことを決める。';
  if (trigger.kind === 'writing') return `いまいる場所で「${trigger.text}」という書き込みを見た。それを気にかけて、したいことを決め直す。`;
  throw new Error(`overlook wish trigger is not one of ${OVERLOOK_WISH_TRIGGERS.join(', ')}: ${trigger.kind}`);
}

// What happened in the closed talk, as the decision reads it: the whole watched talk, or the three lines an
// unwatched encounter left (its seed, the partner's reply, the trace).
function talkHappenedLines(talk, { partnerName }) {
  if (talk?.kind === 'focus') {
    if (!Array.isArray(talk.history) || !talk.history.length) throw new Error('overlook conversation trigger talk.history must list the lines');
    return ['会話の全文:', transcriptLines(talk.history)];
  }
  if (talk?.kind === 'offscreen') {
    for (const key of ['seed', 'partner_reply', 'trace']) {
      if (typeof talk[key] !== 'string' || !talk[key]) throw new Error(`overlook conversation trigger talk.${key} is required`);
    }
    return [
      `- 出会いの場面: ${talk.seed}`,
      `- ${partnerName}の返事: ${talk.partner_reply}`,
      `- 残った跡: ${talk.trace}`
    ];
  }
  throw new Error(`overlook conversation trigger talk.kind must be focus or offscreen: ${talk?.kind}`);
}

// The decision after a closed talk: who started it and with what wish, the outcome, the wish this child held,
// and what happened. A fulfilled wish is stated as done; nothing tells the child whom to choose next.
function conversationTriggerLines(trigger, { child, nameOf, placeNameOf }) {
  for (const key of ['partner_id', 'initiator_id', 'outcome']) {
    if (typeof trigger[key] !== 'string' || !trigger[key]) throw new Error(`overlook conversation trigger ${key} is required`);
  }
  if (!OVERLOOK_CLOSING_OUTCOMES.includes(trigger.outcome)) throw new Error(`overlook conversation trigger outcome is not a closing outcome: ${trigger.outcome}`);
  if (trigger.initiator_id !== child.id && trigger.initiator_id !== trigger.partner_id) {
    throw new Error(`overlook conversation trigger initiator_id must be one of the two: ${trigger.initiator_id}`);
  }
  if (trigger.initiator_wish === undefined || trigger.wish === undefined) throw new Error('overlook conversation trigger requires initiator_wish and wish (null when there was none)');
  const selfName = child.name;
  const partnerName = requireName(nameOf, trigger.partner_id);
  const selfStarted = trigger.initiator_id === child.id;
  const initiatorName = selfStarted ? selfName : partnerName;
  const heldWish = (wish) => (wish ? wishText(wish, { nameOf, placeNameOf }) : 'なかった');
  return [
    `きっかけ: いま${partnerName}との会話が終わったところ。`,
    `- この会話は${initiatorName}が話しかけて始まった。${initiatorName}のしたいこと: ${heldWish(trigger.initiator_wish)}`,
    `- 成り行き: ${trigger.outcome}`,
    selfStarted ? null : `- ${selfName}がこの会話の前に持っていたしたいこと: ${heldWish(trigger.wish)}`,
    '',
    '会話で起きたこと:',
    ...talkHappenedLines(trigger.talk, { partnerName: selfStarted ? partnerName : selfName }),
    '',
    trigger.outcome === '果たされた' ? `${initiatorName}のしたいことは、この会話で果たされた。果たされたしたいことは、もう済んだことである。` : null,
    `この会話で起きたことを踏まえて、${selfName}が次にしたいことを決める。`
  ].filter((line) => line !== null);
}

export function buildOverlookWishPrompt({ child, state, placeId, trigger, roster, places, nameOf, placeNameOf }) {
  const others = roster.filter((entry) => entry.id !== child.id);
  const afterTalk = trigger.kind === 'conversation';
  return [
    '魔法学院の昼下がり、生徒たちは思い思いに学院の中を歩いている。次の生徒が、これから学院の1時間ほどのあいだにしたいことを1つだけ決める。',
    '',
    'この生徒:',
    profileLines(child.profile),
    `- いまいる所: ${placeId ? requireName(placeNameOf, placeId) : '道の途中'}`,
    '',
    'この生徒のいまの状態:',
    renderOverlookChildState(state, { nameOf, placeNameOf }, { withWish: !afterTalk }),
    '',
    ...(afterTalk ? conversationTriggerLines(trigger, { child, nameOf, placeNameOf }) : [`きっかけ: ${triggerLine(trigger, { nameOf })}`]),
    '',
    'したいことの種類（action）:',
    ...WISH_ACTION_GUIDE.map((line) => `- ${line}`),
    '',
    '相手に選べる生徒（target_kind は child・target_id はこの id）:',
    ...others.map((entry) => `- ${entry.id}: ${entry.name}`),
    '',
    '相手に選べる場所（target_kind は place・target_id はこの id）:',
    ...places.map((place) => `- ${place.id}: ${place.name}`),
    '',
    `line は、この生徒の胸のうちのしたいことを表す一言（${OVERLOOK_WISH_LINE_MAX}字以内・1行・鉤括弧や引用符なし）。人柄といまの状態から自然に出てくるものにする。`,
    'JSON だけを返す。'
  ].join('\n');
}

function wishResponseFormat({ childIds, placeIds }) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'overlook_wish',
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...OVERLOOK_WISH_ACTIONS] },
          target_kind: { type: 'string', enum: ['child', 'place'] },
          target_id: { type: 'string', enum: [...childIds, ...placeIds] },
          line: { type: 'string' }
        },
        required: ['action', 'target_kind', 'target_id', 'line']
      }
    }
  };
}

export function validateOverlookWishCandidate(candidate, { selfId, childIds, placeIds }) {
  const violations = [];
  if (!exactKeys(candidate, ['action', 'target_kind', 'target_id', 'line'], 'wish', violations)) return violations;
  if (!OVERLOOK_WISH_ACTIONS.includes(candidate.action)) violations.push(`action is not in the closed set: ${candidate.action}`);
  else if (!OVERLOOK_WISH_TARGET_KINDS[candidate.action].includes(candidate.target_kind)) {
    violations.push(`${candidate.action} cannot aim at a ${candidate.target_kind}`);
  }
  if (candidate.target_kind === 'child' && (!childIds.includes(candidate.target_id) || candidate.target_id === selfId)) {
    violations.push(`target_id is not another child: ${candidate.target_id}`);
  }
  if (candidate.target_kind === 'place' && !placeIds.includes(candidate.target_id)) violations.push(`target_id is not a place: ${candidate.target_id}`);
  singleLine(candidate.line, OVERLOOK_WISH_LINE_MAX, 'line', violations);
  return violations;
}

// ---------- generateSeed ----------

// The seed line's rule, shared by the watched encounter's seed call and the unwatched encounter's one call.
const SEED_LINE_RULE = `は、二人がいまどんな様子で顔を合わせたかを三人称で描く一行（${OVERLOOK_SEED_LINE_MAX}字以内・1行）。台詞・鉤括弧・引用符は書かない。二人の状態としたいことから、この出会いに何がかかっているかがにじむ場面にする。`;

export function buildOverlookSeedPrompt({ initiator, partner, states, placeId, nameOf, placeNameOf }) {
  return [
    `魔法学院の${requireName(placeNameOf, placeId)}のそばで、二人の生徒が出会った。この出会いの瞬間を、地の文の一行で書く。`,
    '',
    `先に声をかける生徒: ${requireName(nameOf, initiator.id)}`,
    profileLines(initiator.profile),
    renderOverlookChildState(states[initiator.id], { nameOf, placeNameOf }),
    '',
    `声をかけられる生徒: ${requireName(nameOf, partner.id)}`,
    profileLines(partner.profile),
    renderOverlookChildState(states[partner.id], { nameOf, placeNameOf }),
    '',
    `line ${SEED_LINE_RULE}`,
    'JSON だけを返す。'
  ].join('\n');
}

const SEED_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'overlook_seed',
    schema: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] }
  }
};

function validateSeedCandidate(candidate) {
  const violations = [];
  if (!exactKeys(candidate, ['line'], 'seed', violations)) return violations;
  singleLine(candidate.line, OVERLOOK_SEED_LINE_MAX, 'line', violations);
  return violations;
}

// ---------- generateUtterance ----------

// The overlook part of the speaker's prompt, carried as the scene's prompt_tail_context (the one scene field the
// shared builder reserves for a caller's current situation): who the partner is, the scene line, the speaker's
// own state, the stagnation hook when one was drawn for this turn, and how the stage directions name people.
export function buildOverlookUtteranceContext({ speaker, partner, seedLine, speakerState, hook, nameOf, placeNameOf }) {
  return [
    `いま${speaker.name}は${partner.name}と二人で話している。主人公はこの場にいない。`,
    `出会いの場面: ${seedLine}`,
    `${speaker.name}のいまの状態:`,
    renderOverlookChildState(speakerState, { nameOf, placeNameOf }),
    hook ? `いまの場のようす: ${hook}` : null,
    `丸括弧の振る舞いや仕草の中では、${partner.name}を名前で書き、誰のことも「あなた」とは書かない。`
  ].filter(Boolean).join('\n');
}

// ---------- judgeOutcome / judgeStagnation ----------

const OUTCOME_OUTPUT_BAN = '発話、地の文、括弧書きの振る舞い、理由、補足、ラベル、JSON、Markdownコードブロックは一切出力しない。';

// `partnerReply` is the partner's latest line ({ speaker_name, content }) or null while the partner has not spoken.
export function buildOverlookOutcomePrompt({ locationName, initiator, partner, initiatorWish, history, partnerReply, nameOf, placeNameOf }) {
  if (partnerReply === undefined) throw new Error('overlook outcome judgment requires partnerReply (null before the partner speaks)');
  const last = history[history.length - 1];
  const outcomes = overlookJudgeableOutcomes({ initiatorWish, partnerId: partner.id, partnerReplied: partnerReply !== null });
  const aim = wishAim(initiatorWish, partner.id);
  let rule;
  if (aim === 'other-child') {
    rule = [
      `${initiator.name}のしたいことの相手は${requireName(nameOf, initiatorWish.target.id)}で、いま話している${partner.name}ではない。この会話では、そのしたいことは果たされも断られもしない。`,
      `話がまだ続いているなら「続く」、二人の話に決着がついたなら「別の決着」と判定する。`
    ];
  } else if (aim === 'partner' && partnerReply === null) {
    rule = [
      `${partner.name}はまだ一言も返していない。${initiator.name}のしたいことが果たされるか断られるかは${partner.name}の返事で決まるので、いまはまだ決まらない。`,
      `話がまだ続いているなら「続く」、したいこととは別の形で二人の話に決着がついたなら「別の決着」と判定する。`
    ];
  } else if (aim === 'partner') {
    rule = [
      `${initiator.name}のしたいことを${partner.name}の返事が受け入れた・かなえたなら「果たされた」、${partner.name}の返事が断った・拒んだなら「断られた」と判定する。二人が会えて話していることだけでは、果たされたとしない。`,
      `したいこととは別の形で二人の話に決着がついたなら「別の決着」、まだ話が続いているなら「続く」と判定する。`
    ];
  } else {
    rule = [`${initiator.name}のしたいことがこの会話で果たされたなら「果たされた」、${partner.name}に断られた・拒まれたなら「断られた」、したいこととは別の形で二人の話に決着がついたなら「別の決着」、まだ話が続いているなら「続く」と判定する。`];
  }
  return [
    `以下は、魔法学院の${locationName}での${initiator.name}と${partner.name}の二人の会話の記録である。`,
    transcriptLines(history),
    '',
    `会話を始めた${initiator.name}のしたいこと: ${wishText(initiatorWish, { nameOf, placeNameOf })}`,
    aim === 'partner' && partnerReply !== null ? `${partner.name}の直前の返事: ${partnerReply.speaker_name}: ${partnerReply.content}` : null,
    `直前の発言: ${last.speaker_name}: ${last.content}`,
    '',
    'この記録を読み、直前の発言を終えた時点でのこの会話の成り行きを判定する。',
    ...rule,
    `出力は ${outcomes.join('・')} のいずれか1語だけとする。${OUTCOME_OUTPUT_BAN}`
  ].filter((line) => line !== null).join('\n');
}

// `outcomes` is the set judgeable at that line (overlookJudgeableOutcomes).
export function parseOverlookOutcome(raw, outcomes) {
  const text = String(raw ?? '').trim();
  if (!outcomes.includes(text)) throw judgmentInvalidError('outcome', text);
  return text;
}

export function buildOverlookStagnationPrompt({ locationName, initiator, partner, initiatorWish, history, nameOf, placeNameOf }) {
  const last = history[history.length - 1];
  return [
    `以下は、魔法学院の${locationName}での${initiator.name}と${partner.name}の二人の会話の記録である。`,
    transcriptLines(history),
    '',
    `会話を始めた${initiator.name}のしたいこと: ${wishText(initiatorWish, { nameOf, placeNameOf })}`,
    `直前の発言: ${last.speaker_name}: ${last.content}`,
    '',
    'この記録を読み、この会話が同じところを回っている、またはしたいことに向かって少しも動いていないかを判定する。',
    '回っている・動いていないなら true、話が動いているなら false と判定する。',
    '出力は true もしくは false の1語だけとする。発話、地の文、括弧書きの振る舞い、理由、補足、ラベル、JSON、Markdownコードブロックは一切出力しない。'
  ].join('\n');
}

export function parseOverlookStagnation(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw judgmentInvalidError('stagnation', String(raw ?? '').trim());
}

// ---------- rewriteState / resolveOffscreen ----------

function stateSchema() {
  return {
    type: 'object',
    properties: {
      feeling_label: { type: 'string', enum: [...OVERLOOK_FEELING_LABELS] },
      feeling_text: { type: 'string' },
      concerns: { type: 'array', items: { type: 'string' } },
      mood: { type: 'string', enum: [...OVERLOOK_MOODS] }
    },
    required: ['feeling_label', 'feeling_text', 'concerns', 'mood']
  };
}

function validateStateCandidate(candidate, label, violations) {
  if (!exactKeys(candidate, ['feeling_label', 'feeling_text', 'concerns', 'mood'], label, violations)) return;
  if (!OVERLOOK_FEELING_LABELS.includes(candidate.feeling_label)) violations.push(`${label}.feeling_label is not in the closed set: ${candidate.feeling_label}`);
  singleLine(candidate.feeling_text, OVERLOOK_STATE_LINE_MAX, `${label}.feeling_text`, violations);
  if (!Array.isArray(candidate.concerns)) {
    violations.push(`${label}.concerns must be an array`);
  } else {
    if (candidate.concerns.length > OVERLOOK_CONCERNS_MAX) violations.push(`${label}.concerns must be an array of at most ${OVERLOOK_CONCERNS_MAX}: got ${candidate.concerns.length}`);
    candidate.concerns.forEach((concern, index) => singleLine(concern, OVERLOOK_STATE_LINE_MAX, `${label}.concerns[${index}]`, violations));
    if (new Set(candidate.concerns.map((concern) => String(concern).trim())).size !== candidate.concerns.length) violations.push(`${label}.concerns repeat`);
  }
  if (!OVERLOOK_MOODS.includes(candidate.mood)) violations.push(`${label}.mood is not in the closed set: ${candidate.mood}`);
}

function trimmedState(candidate) {
  return {
    feeling_label: candidate.feeling_label,
    feeling_text: candidate.feeling_text.trim(),
    concerns: candidate.concerns.map((concern) => concern.trim()),
    mood: candidate.mood
  };
}

const STATE_OUTPUT_RULES = [
  `feeling_label は相手への気持ち（${OVERLOOK_FEELING_LABELS.join('・')} のどれか1つ）、feeling_text はその気持ちを表す一行（${OVERLOOK_STATE_LINE_MAX}字以内）。`,
  `feeling_label は会話の中身に沿って決め、${OVERLOOK_FEELING_LABELS.join('・')} のどれにも動きうる（前と同じままのこともある）。断られた・食い違った・約束が破れた、のような出来事も会話の中身として読む。`,
  `concerns は、いま抱えている事の一覧（${OVERLOOK_CONCERNS_MAX}件まで・各${OVERLOOK_STATE_LINE_MAX}字以内の一行）。まだ抱えている事はそのままの文で残し、片づいた事は外し、新しく抱えた事を足す。「${OVERLOOK_DONE_CONCERN_PREFIX}」で始まる事は果たしたしたいことの控えで、そのままの文で残すか外す。「${OVERLOOK_DONE_CONCERN_PREFIX}」で始まる事を新しく書き足さない（果たしたしたいことの控えは仕組みが足す）。全部で${OVERLOOK_CONCERNS_MAX}件を超えるときは、古い事から外して${OVERLOOK_CONCERNS_MAX}件以内にする。`,
  `mood はいまの気分（${OVERLOOK_MOODS.join('・')} のどれか1つ）。`,
  '一行の文には鉤括弧・引用符・改行を入れない。'
];

export function buildOverlookRewritePrompt({ self, partner, state, locationName, history, outcome, nameOf, placeNameOf }) {
  return [
    `魔法学院の${locationName}で、${self.name}と${partner.name}の会話が終わった（成り行き: ${outcome}）。この会話を経た${self.name}の新しい状態を決める。`,
    '',
    '会話の全文:',
    transcriptLines(history),
    '',
    `${self.name}:`,
    profileLines(self.profile),
    '',
    `会話の前の${self.name}の状態:`,
    renderOverlookChildState(state, { nameOf, placeNameOf }),
    '',
    `${partner.name}への気持ちと、抱えている事、いまの気分を、会話の中身から決める。`,
    ...STATE_OUTPUT_RULES,
    'JSON だけを返す。'
  ].join('\n');
}

const REWRITE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'overlook_state_rewrite', schema: stateSchema() }
};

// The outcomes an unwatched encounter may close on: a wish aimed at another child closes on 別の決着 only.
export function overlookOffscreenOutcomes(initiatorWish, partnerId) {
  return wishAim(initiatorWish, partnerId) === 'other-child' ? ['別の決着'] : [...OVERLOOK_CLOSING_OUTCOMES];
}

function offscreenOutcomeRule({ initiator, partner, initiatorWish, nameOf }) {
  const aim = wishAim(initiatorWish, partner.id);
  if (aim === 'other-child') {
    return `outcome は結末の型で、別の決着 にする: ${initiator.name}のしたいことの相手は${requireName(nameOf, initiatorWish.target.id)}で${partner.name}ではないので、この出会いではそのしたいことは果たされも断られもしない。`;
  }
  if (aim === 'partner') {
    return `outcome は結末の型で、partner_reply で決める: ${partner.name}の返事が${initiator.name}のしたいことを受け入れた・かなえたなら 果たされた、断った・拒んだなら 断られた、どちらでもない別の形で決着したなら 別の決着。二人が会えたことだけでは 果たされた としない。`;
  }
  return `outcome は結末の型: ${initiator.name}のしたいことが果たされたなら 果たされた、断られたなら 断られた、別の形で決着したなら 別の決着。`;
}

export function buildOverlookOffscreenPrompt({ initiator, partner, states, placeId, nameOf, placeNameOf }) {
  return [
    `魔法学院の${requireName(placeNameOf, placeId)}のそばで、${initiator.name}と${partner.name}が出会い、誰にも見られずに言葉を交わした。台詞のやりとりは書かず、出会いの場面と、${partner.name}の返事の一言と、この出会いがどう決着したかだけを決める。`,
    '',
    `先に声をかけた生徒: ${initiator.name}`,
    profileLines(initiator.profile),
    renderOverlookChildState(states[initiator.id], { nameOf, placeNameOf }),
    '',
    `声をかけられた生徒: ${partner.name}`,
    profileLines(partner.profile),
    renderOverlookChildState(states[partner.id], { nameOf, placeNameOf }),
    '',
    `seed ${SEED_LINE_RULE}`,
    `partner_reply は、${initiator.name}のしたいことに対する${partner.name}の返事の一言。${partner.name}のいまの状態（したいこと・抱えている事・${initiator.name}への気持ち）から出てくるものにする（${OVERLOOK_REPLY_LINE_MAX}字以内・1行・鉤括弧や引用符なし）。`,
    offscreenOutcomeRule({ initiator, partner, initiatorWish: states[initiator.id].wish, nameOf }),
    `trace はその場所に残る結末の跡の一行（${OVERLOOK_TRACE_LINE_MAX}字以内・「${initiator.name}が、…」のように誰が何をしたかを三人称で・鉤括弧や引用符なし）。`,
    `initiator は${initiator.name}の、partner は${partner.name}の、この出会いを経た新しい状態（相手への気持ちは互いに向けたもの）。`,
    ...STATE_OUTPUT_RULES,
    'JSON だけを返す。'
  ].join('\n');
}

function offscreenResponseFormat(outcomes) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'overlook_offscreen',
      schema: {
        type: 'object',
        properties: {
          seed: { type: 'string' },
          partner_reply: { type: 'string' },
          outcome: { type: 'string', enum: outcomes },
          trace: { type: 'string' },
          initiator: stateSchema(),
          partner: stateSchema()
        },
        required: ['seed', 'partner_reply', 'outcome', 'trace', 'initiator', 'partner']
      }
    }
  };
}

function validateOffscreenCandidate(candidate, outcomes) {
  const violations = [];
  if (!exactKeys(candidate, ['seed', 'partner_reply', 'outcome', 'trace', 'initiator', 'partner'], 'offscreen', violations)) return violations;
  singleLine(candidate.seed, OVERLOOK_SEED_LINE_MAX, 'seed', violations);
  singleLine(candidate.partner_reply, OVERLOOK_REPLY_LINE_MAX, 'partner_reply', violations);
  if (!outcomes.includes(candidate.outcome)) violations.push(`outcome must be one of ${outcomes.join('・')}: ${candidate.outcome}`);
  singleLine(candidate.trace, OVERLOOK_TRACE_LINE_MAX, 'trace', violations);
  validateStateCandidate(candidate.initiator, 'initiator', violations);
  validateStateCandidate(candidate.partner, 'partner', violations);
  return violations;
}

// ---------- the generators ----------

export function createOverlookGenerators({ config, characterSpeechConstraints, fetchImpl } = {}) {
  if (!config) throw new Error('overlook generators require config');
  if (!Array.isArray(characterSpeechConstraints)) throw new Error('overlook generators require characterSpeechConstraints');
  return {
    async decideWish(input) {
      const childIds = input.roster.map((entry) => entry.id).filter((id) => id !== input.child.id);
      const placeIds = input.places.map((place) => place.id);
      const candidate = await runGatedStage({
        stage: 'wish',
        config,
        fetchImpl,
        prompt: buildOverlookWishPrompt(input),
        responseFormat: wishResponseFormat({ childIds, placeIds }),
        title: '星見の窓 したいこと',
        validate: (value) => validateOverlookWishCandidate(value, { selfId: input.child.id, childIds, placeIds })
      });
      return { action: candidate.action, target: { kind: candidate.target_kind, id: candidate.target_id }, line: candidate.line.trim() };
    },

    async generateSeed(input) {
      const candidate = await runGatedStage({
        stage: 'seed',
        config,
        fetchImpl,
        prompt: buildOverlookSeedPrompt(input),
        responseFormat: SEED_RESPONSE_FORMAT,
        title: '星見の窓 出会いの種',
        validate: validateSeedCandidate
      });
      return { line: candidate.line.trim() };
    },

    // input: { profile, scene, conversationActorContext, history, speaker, partner, seedLine, speakerState, hook,
    //          nameOf, placeNameOf, onDelta }
    async generateUtterance(input) {
      const providers = createLmStudioProviders({ config, fetchImpl, onChatDelta: input.onDelta });
      const promptArgs = {
        profile: input.profile,
        scene: { ...input.scene, prompt_tail_context: buildOverlookUtteranceContext(input) },
        characterSpeechConstraints,
        conversationActorContext: input.conversationActorContext,
        currentConversation: input.history.map((message) => ({ role: 'assistant', content: message.content, speaker_name: message.speaker_name })),
        playerInput: null
      };
      const emotionPrompt = buildCharacterPrompt({ ...promptArgs, turnType: 'emotion_choice' });
      const emotion = normalizeEmotionChoice(await providers.emotionProvider({ prompt: emotionPrompt }));
      const content = String(await providers.chatProvider({ prompt: buildCharacterPrompt(promptArgs) }) ?? '').trim();
      if (!content) throw new OverlookGenerationError({ stage: 'utterance', violations: ['utterance is empty'] });
      return { content, emotion };
    },

    async judgeOutcome(input) {
      const prompt = buildOverlookOutcomePrompt(input);
      const outcomes = overlookJudgeableOutcomes({ initiatorWish: input.initiatorWish, partnerId: input.partner.id, partnerReplied: input.partnerReply !== null });
      return parseOverlookOutcome(await callLmStudioReflectionText({ config, fetchImpl, prompt, title: '星見の窓 成り行き判定' }), outcomes);
    },

    async judgeStagnation(input) {
      return parseOverlookStagnation(await callLmStudioReflectionText({ config, fetchImpl, prompt: buildOverlookStagnationPrompt(input), title: '星見の窓 停滞判定' }));
    },

    async rewriteState(input) {
      const candidate = await runGatedStage({
        stage: 'rewrite',
        config,
        fetchImpl,
        prompt: buildOverlookRewritePrompt(input),
        responseFormat: REWRITE_RESPONSE_FORMAT,
        title: '星見の窓 状態の書き換え',
        validate: (value) => {
          const violations = [];
          validateStateCandidate(value, 'state', violations);
          return violations;
        }
      });
      return trimmedState(candidate);
    },

    async resolveOffscreen(input) {
      const outcomes = overlookOffscreenOutcomes(input.states[input.initiator.id].wish, input.partner.id);
      const candidate = await runGatedStage({
        stage: 'offscreen',
        config,
        fetchImpl,
        prompt: buildOverlookOffscreenPrompt(input),
        responseFormat: offscreenResponseFormat(outcomes),
        title: '星見の窓 見ていない所の出会い',
        validate: (value) => validateOffscreenCandidate(value, outcomes)
      });
      return {
        seed: candidate.seed.trim(),
        partner_reply: candidate.partner_reply.trim(),
        outcome: candidate.outcome,
        trace: candidate.trace.trim(),
        initiator: trimmedState(candidate.initiator),
        partner: trimmedState(candidate.partner)
      };
    }
  };
}
