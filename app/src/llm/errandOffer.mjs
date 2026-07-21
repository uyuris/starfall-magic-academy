// Errand offer text: the LLM-supplied title / situation / motivation / appeal for one
// weekly errand offer, and the only place errand generation talks to the language model.
//
// The deterministic skeleton (type, reward, client — the economy-bearing values) is
// frozen upstream by drawWeeklyErrandSkeletons and treated here as caller-supplied.
// This module is the prose stage of that 2-stage gate:
//   1. the skeleton fixes which type / client / reward the offer is about.
//   2. buildErrandOfferPrompt turns the type, the client's persona (standing + character
//      description + speaking basis), the world description, and the client's memory
//      materials into a structured prompt so the model authors an errand that fits THIS
//      client rather than a generic one; the LLM returns a { title, situation, motivation }
//      candidate. validateErrandSkeletonText adopts and gates that candidate.
//   3. buildErrandAppealPrompt turns the client's persona, the SAME memory materials, and
//      the adopted { title, situation, motivation } skeleton into a SEPARATE chat prompt,
//      framed so the model voices the CONFIRMED errand in the client's own voice without
//      inventing a different one; the LLM returns the appeal through a distinct chat call so
//      the two registers (third-person scene vs first-person address) never share a single
//      response's token budget. The appeal thus depends on the skeleton output: the skeleton
//      is generated and validated first, then fed into the appeal.
//   4. validateErrandOfferText is the final gate: exact { title, situation, motivation,
//      appeal } schema, non-empty, within the length caps, no quotation/bracket/newline
//      symbols. The pure-scene ban applies to situation ONLY — appeal carries first-person
//      feeling and a direct address, so the ban must never touch it.
//
// The reward amount, the reward band, and the achievement condition are NOT generated
// here — they are authored/rolled and stay out of the model's hands. Any failure — LM
// unconfigured or unreachable, malformed response, or a gate violation — throws with
// nothing persisted; there is no authored-text fallback and no silent retry.

import { callLmStudioStructuredJson, callLmStudioChat } from './lmStudioClient.mjs';
import { forbiddenOfferContractTerm } from './offerContractWording.mjs';

// A gate/shape failure on the generated offer text is surfaced as a structured 503 (the same
// contract library generation uses: LM未設定/不通/不正出力 は authored fallback なしの構造化エラー).
// An offer candidate that fails the 2-stage gate is the model producing unusable output, so it
// shares this status rather than falling through to a generic 500. Prompt-input validation
// (buildErrandOfferPrompt) stays a plain error — that is a caller/skeleton bug, not model output.
export const ERRAND_GENERATION_FAILED_ERROR_CODE = 'ERRAND_GENERATION_FAILED';

function errandOfferGenerationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = ERRAND_GENERATION_FAILED_ERROR_CODE;
  return error;
}

// ----- tunable gate constants (not env-configurable) -----
// Character caps counted in Unicode code points. Title is a short headline phrase;
// situation is a one-breath pure scene; motivation is the errand's driving context;
// appeal is the client's own-voice pitch (指示は200〜300字, cap は暴走 XL を弾く上限).
export const ERRAND_OFFER_TITLE_MAX_LENGTH = 40;
export const ERRAND_OFFER_SITUATION_MAX_LENGTH = 120;
export const ERRAND_OFFER_MOTIVATION_MAX_LENGTH = 160;
export const ERRAND_OFFER_APPEAL_MAX_LENGTH = 450;

// Quotation, bracket, and line-structure characters are rejected: injected quotes make
// the model emit dialogue-like fragments, and brackets/newlines break a field into
// structured pieces. Everything else (ordinary Japanese prose and punctuation) is allowed.
const FORBIDDEN_OFFER_CHARACTERS = /["'`«»“”‘’「」『』【】〈〉《》〔〕（）()[\]{}<>\r\n\t]/u;

// A pure-scene situation must not carry the "someone was here / a presence / a sigh"
// register that reads as narration-of-feelings rather than a plain visible scene. Same
// contract the authored errand situations were held to.
const BANNED_SITUATION_PATTERN = /誰|持ち主|気配|らしい|溜め息|温もり|温み|余韻|余熱|名残|見当たらない|立ち去|席を外|願かけ/u;

const CATEGORY_LABELS = {
  study: '学業・研究',
  training: '実技・鍛錬',
  craft: '採取・素材・工房',
  life: '生活・人間関係',
  campus: '学院生活・行事',
  quirk: 'ちょっと変・個性'
};

// The third-party rule is fixed catalog policy: an absent third party may be a topic or
// a practice partner the player role-plays, but the model must never make one physically
// present or speak in a third party's own voice.
const THIRD_PARTY_CONSTRAINT = '第三者は話題・練習の想定相手としてのみ登場させる。その場に居させない。第三者本人の台詞は生成しない（依頼主による伝聞・短い引用・演技はその旨明示の地の文で可）。';

// The response_format hint asks the model for a { title, situation, motivation } object.
// It is only a hint: validateErrandOfferText is the authoritative gate.
export const ERRAND_OFFER_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'errand_offer_record',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        situation: { type: 'string' },
        motivation: { type: 'string' }
      },
      required: ['title', 'situation', 'motivation']
    }
  }
};

function categoryLabel(category) {
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category)) {
    throw new Error(`errand offer category is not a known value: ${category}`);
  }
  return CATEGORY_LABELS[category];
}

// The appeal is the client speaking in their OWN voice, so the persona block is the
// heart of the prompt: without the speaking_basis the model collapses every client into
// the same neutral register (measured), so all four fields are required. This is prompt
// input, not model output — a missing field is a caller/skeleton bug, a plain Error.
function errandPersonaBlock(persona) {
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) {
    throw new Error('errand offer persona must be an object');
  }
  const displayName = String(persona.display_name ?? '').trim();
  if (!displayName) throw new Error('errand offer persona display_name is required');
  const schoolYear = String(persona.school_year ?? '').trim();
  if (!schoolYear) throw new Error('errand offer persona school_year is required');
  const identity = String(persona.identity ?? '').trim();
  if (!identity) throw new Error('errand offer persona identity is required');
  const speakingBasis = String(persona.speaking_basis ?? '').trim();
  if (!speakingBasis) throw new Error('errand offer persona speaking_basis is required');
  return { displayName, schoolYear, identity, speakingBasis };
}

// The memory materials are attached verbatim as raw context, with no usage hint: the
// design deliberately leaves whether and how to use them to the model. Empty or missing
// memory attaches nothing at all (no "no memories" line).
function memoryLines(memories) {
  if (memories == null) return [];
  if (!Array.isArray(memories)) throw new Error('errand offer memories must be an array');
  return memories
    .map((memory) => String(memory?.text ?? '').trim())
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`);
}

// The offer-skeleton persona block carries the same standing fields as the appeal PLUS the
// prompt_description, so the model authors an errand that fits THIS client (their standing,
// manner, concerns) rather than a generic one anybody could ask. This is prompt input, not
// model output — a missing field is a caller/skeleton bug, a plain Error.
function errandOfferPersonaBlock(persona) {
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) {
    throw new Error('errand offer persona must be an object');
  }
  const displayName = String(persona.display_name ?? '').trim();
  if (!displayName) throw new Error('errand offer persona display_name is required');
  const schoolYear = String(persona.school_year ?? '').trim();
  if (!schoolYear) throw new Error('errand offer persona school_year is required');
  const identity = String(persona.identity ?? '').trim();
  if (!identity) throw new Error('errand offer persona identity is required');
  const promptDescription = String(persona.prompt_description ?? '').trim();
  if (!promptDescription) throw new Error('errand offer persona prompt_description is required');
  const speakingBasis = String(persona.speaking_basis ?? '').trim();
  if (!speakingBasis) throw new Error('errand offer persona speaking_basis is required');
  return { displayName, schoolYear, identity, promptDescription, speakingBasis };
}

// Builds the offer-text prompt from a skeleton type, the client's display name, the client's
// persona (standing + character description + speaking basis), the world description, and the
// client's memory materials. Pure: the same inputs render the same prompt. The reward, band,
// and achievement condition are intentionally absent — they are not the model's to decide.
// The persona and world are what make the skeleton character-fit (without them the model
// produces a generic errand any client could carry — measured); both are required, fail-fast.
export function buildErrandOfferPrompt({ type, clientDisplayName, memories, persona, world }) {
  if (type === null || typeof type !== 'object' || Array.isArray(type)) throw new Error('errand offer type must be an object');
  const name = String(type.name ?? '').trim();
  if (!name) throw new Error('errand offer type name is required');
  const displayName = String(clientDisplayName ?? '').trim();
  if (!displayName) throw new Error('errand offer clientDisplayName is required');
  const worldDescription = String(world ?? '').trim();
  if (!worldDescription) throw new Error('errand offer world_description is required');
  const { displayName: personaName, schoolYear, identity, promptDescription, speakingBasis } = errandOfferPersonaBlock(persona);
  const memoryBlock = memoryLines(memories);
  return [
    '星灯魔法学院の一週間の依頼オファーを1件、文面だけ作成する。',
    '依頼は「依頼主と会話して完了する」型で、以下の確定した骨組みを前提にする。',
    '',
    `種別: ${name}`,
    `分類: ${categoryLabel(type.category)}`,
    `依頼主: ${displayName}`,
    '',
    'この世界の設定:',
    worldDescription,
    '',
    'この依頼を持ちかける依頼主の人物像:',
    `- 名前: ${personaName}`,
    `- 立場: ${schoolYear}・${identity}`,
    `- 人物像: ${promptDescription}`,
    `- 話し方: ${speakingBasis}`,
    '',
    ...(memoryBlock.length > 0
      ? ['依頼主の記憶（材料。使う・使わないは自由）:', ...memoryBlock, '']
      : []),
    '制約:',
    `- ${THIRD_PARTY_CONSTRAINT}`,
    '- situation は純情景文にする。見えている場面だけを地の文で描き、依頼主の台詞・心情説明・呼びかけを混ぜない。',
    '- 報酬額・達成条件は書かない（システムが別に定める）。',
    '- 依頼の内容（title・situation・motivation）は、上の依頼主の人物像・立場・世界観に噛み合った、この依頼主ならではのものにする。誰が持ちかけても成り立つ汎用的な依頼にしない。',
    '',
    '出力は title と situation と motivation だけを持つ JSON オブジェクトを1つだけ返す。',
    `title はこの依頼の短い見出し。最大${ERRAND_OFFER_TITLE_MAX_LENGTH}文字。`,
    `situation は依頼の現場の純情景文。最大${ERRAND_OFFER_SITUATION_MAX_LENGTH}文字。`,
    `motivation は依頼主がこの依頼を持ちかける動機・事情の地の文。最大${ERRAND_OFFER_MOTIVATION_MAX_LENGTH}文字。`,
    '引用符・鉤括弧・各種括弧・改行などの記号は使わず、地の文で書く。',
    'title と situation と motivation 以外のキーは出力しない。'
  ].join('\n');
}

// The confirmed skeleton the appeal must stay faithful to: the adopted { title, situation,
// motivation } of THIS offer. Feeding it in (and forbidding the model from inventing a
// different errand) is what stops the own-voice pitch from swapping the skeleton's subject
// for one the persona suggests (measured: a memo skeleton became a lost-hawk pitch without
// it). Prompt input — a missing field is a caller bug, a plain Error.
function errandAppealKosshiBlock(kosshi) {
  if (kosshi === null || typeof kosshi !== 'object' || Array.isArray(kosshi)) {
    throw new Error('errand appeal kosshi must be an object');
  }
  const title = String(kosshi.title ?? '').trim();
  if (!title) throw new Error('errand appeal kosshi title is required');
  const situation = String(kosshi.situation ?? '').trim();
  if (!situation) throw new Error('errand appeal kosshi situation is required');
  const motivation = String(kosshi.motivation ?? '').trim();
  if (!motivation) throw new Error('errand appeal kosshi motivation is required');
  return { title, situation, motivation };
}

// Builds the appeal prompt: the client persona (name / standing / speaking basis), the
// errand type, the same memory materials, and the CONFIRMED skeleton (title / situation /
// motivation), framed so the model writes AS the client pitching the SAME errand to the
// player in their own voice. Pure: same inputs, same prompt. The reward / achievement
// condition are intentionally absent (not the model's to decide), and the second-person /
// no-name-symbol / single-paragraph clauses are what keep the command-register clients from
// emitting the placeholder brackets + newline the offer gate forbids (measured). The
// 200〜300字 length line is the sweet-spot band from the study.
export function buildErrandAppealPrompt({ type, persona, memories, kosshi }) {
  if (type === null || typeof type !== 'object' || Array.isArray(type)) throw new Error('errand offer type must be an object');
  const name = String(type.name ?? '').trim();
  if (!name) throw new Error('errand offer type name is required');
  const label = categoryLabel(type.category);
  const { displayName, schoolYear, identity, speakingBasis } = errandPersonaBlock(persona);
  const { title, situation, motivation } = errandAppealKosshiBlock(kosshi);
  const memoryBlock = memoryLines(memories);
  return [
    `あなたは星灯魔法学院の生徒（または教職員）、${displayName}本人である。いま目の前の主人公に向けて、この依頼を自分の口から持ちかける。`,
    '',
    'あなたの人物像:',
    `- 名前: ${displayName}`,
    `- 立場: ${schoolYear}・${identity}`,
    `- 話し方: ${speakingBasis}`,
    '',
    `頼みたいこと（種別）: ${name}`,
    `分類: ${label}`,
    '',
    'この依頼はすでに内容が確定している。あなたはこの確定した依頼を、別の依頼に変えず、あなた自身の口調で主人公に持ちかける:',
    `- 依頼の見出し: ${title}`,
    `- 依頼の現場の様子: ${situation}`,
    `- あなたがこの依頼を持ちかける動機・事情: ${motivation}`,
    '',
    ...(memoryBlock.length > 0
      ? ['あなたが覚えている主人公とのこと（材料。使う・使わないは自由）:', ...memoryBlock, '']
      : []),
    '書き方:',
    '- 上の「確定した依頼」の内容（何に困っていて何をしてほしいか）をそのまま持ちかける。上の内容と違う別の困りごと・別の頼みごとを新しく作り出さない。',
    '- その場で主人公に直接語りかけるように、呼びかけの口調で書く。ただし引用符や鉤括弧で自分の言葉を囲わず、語り全体をそのまま地の文として書く。',
    '- 一人称で、あなた自身の話し方（上の「話し方」）そのままの口調で語る。別人の声にならないようにする。',
    '- 何に困っていて、主人公に何をしてほしいのか、なぜ主人公に頼むのかが、あなた自身の言葉で自然に伝わるようにする。',
    '- 主人公の名前は分からない。名前では呼ばず、あなたの口調に合う二人称（あなた・きみ・お前・そちら等）で呼ぶ。名前の空欄・伏字・記号（〇〇や（名前）など）は入れない。',
    '- 報酬や達成条件、点数のことは書かない（それは別に決まる）。',
    '- 第三者は話題・想定相手としてのみ出す。その場に居させず、第三者本人の台詞は作らない。',
    '- 改行はせず、ひとつながりの文章として書く。',
    '- 見出し・題名・前置き・自分の名前の署名は書かず、語りの本文だけを書く。',
    '- 長さは200〜300字くらい。'
  ].join('\n');
}

// ----- gate (pure) -----

function assertOfferField(value, label, max) {
  if (typeof value !== 'string') throw errandOfferGenerationError(`errand offer ${label} must be a string`);
  if (value.trim().length === 0) throw errandOfferGenerationError(`errand offer ${label} must not be empty`);
  if ([...value].length > max) throw errandOfferGenerationError(`errand offer ${label} must be at most ${max} characters`);
  const forbidden = value.match(FORBIDDEN_OFFER_CHARACTERS);
  if (forbidden) throw errandOfferGenerationError(`errand offer ${label} must not contain quotation or bracket symbols: ${forbidden[0]}`);
  // The achievement condition and reward are system-owned (surfaced by system-owned UI); a
  // generated field must not state them, or the screen would fake the hidden judgment contract.
  const contractTerm = forbiddenOfferContractTerm(value);
  if (contractTerm) throw errandOfferGenerationError(`errand offer ${label} must not state the system-owned achievement condition or reward: ${contractTerm}`);
  return value.trim();
}

// Adopts and gates the structured skeleton BEFORE the appeal is generated: the exact
// { title, situation, motivation } schema, non-empty, length caps, forbidden-symbol rule,
// and the pure-scene rule on situation. Returns the trimmed skeleton — the value the appeal
// is written against and that the offer ultimately adopts (so a malformed skeleton fails
// fast here, on the offer gate's message, without spending an appeal call).
export function validateErrandSkeletonText(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw errandOfferGenerationError('errand offer skeleton must be an object');
  const keys = Object.keys(candidate);
  const exact = keys.length === 3 && keys.includes('title') && keys.includes('situation') && keys.includes('motivation');
  if (!exact) throw errandOfferGenerationError(`errand offer skeleton keys must be exactly {title, situation, motivation}: got {${keys.sort().join(', ')}}`);
  const title = assertOfferField(candidate.title, 'title', ERRAND_OFFER_TITLE_MAX_LENGTH);
  const situation = assertOfferField(candidate.situation, 'situation', ERRAND_OFFER_SITUATION_MAX_LENGTH);
  if (BANNED_SITUATION_PATTERN.test(situation)) throw errandOfferGenerationError('errand offer situation contains non-scene wording');
  const motivation = assertOfferField(candidate.motivation, 'motivation', ERRAND_OFFER_MOTIVATION_MAX_LENGTH);
  return { title, situation, motivation };
}

// The 2-stage gate: validates a candidate against the exact { title, situation,
// motivation, appeal } schema, non-empty, length caps, and the forbidden-symbol rule. The
// pure-scene rule applies to situation ONLY: appeal is a first-person address whose feeling
// words would trip that ban, so the ban must never touch it. Throws with a reason on any
// violation; returns the trimmed fields on success.
export function validateErrandOfferText(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw errandOfferGenerationError('errand offer candidate must be an object');
  const keys = Object.keys(candidate);
  const exact = keys.length === 4 && keys.includes('title') && keys.includes('situation') && keys.includes('motivation') && keys.includes('appeal');
  if (!exact) throw errandOfferGenerationError(`errand offer candidate keys must be exactly {title, situation, motivation, appeal}: got {${keys.sort().join(', ')}}`);
  const title = assertOfferField(candidate.title, 'title', ERRAND_OFFER_TITLE_MAX_LENGTH);
  const situation = assertOfferField(candidate.situation, 'situation', ERRAND_OFFER_SITUATION_MAX_LENGTH);
  if (BANNED_SITUATION_PATTERN.test(situation)) throw errandOfferGenerationError('errand offer situation contains non-scene wording');
  const motivation = assertOfferField(candidate.motivation, 'motivation', ERRAND_OFFER_MOTIVATION_MAX_LENGTH);
  const appeal = assertOfferField(candidate.appeal, 'appeal', ERRAND_OFFER_APPEAL_MAX_LENGTH);
  return { title, situation, motivation, appeal };
}

// ----- orchestration -----

// Generates and gates one offer's text. The structured { title, situation, motivation } is
// one character-fit structured-JSON call, adopted and gated by validateErrandSkeletonText;
// the appeal is a SEPARATE chat call (single-register, own token budget) written against
// that adopted skeleton so it voices the SAME errand and carries the full length + heat the
// bundled form would starve. The order is load-bearing: the skeleton is generated and
// validated first, then fed into the appeal. Returns the validated { title, situation,
// motivation, appeal }. The LLM transport (fetchImpl) is injectable per the lmStudioClient
// convention. Any failure throws with nothing persisted; there is no fallback text.
export async function generateErrandOfferText({ config, fetchImpl, type, clientDisplayName, persona, memories, world } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for errand offer generation');
  const skeleton = validateErrandSkeletonText(await callLmStudioStructuredJson({
    config,
    prompt: buildErrandOfferPrompt({ type, clientDisplayName, memories, persona, world }),
    fetchImpl,
    responseFormat: ERRAND_OFFER_RESPONSE_FORMAT,
    title: '依頼オファー文面生成'
  }));
  const appeal = await callLmStudioChat({
    config,
    prompt: buildErrandAppealPrompt({ type, persona, memories, kosshi: skeleton }),
    fetchImpl,
    title: '依頼オファー当人の語り生成'
  });
  return validateErrandOfferText({ ...skeleton, appeal });
}
