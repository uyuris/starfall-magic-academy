// Study circle offer text: the LLM-supplied title / situation / motivation / appeal for one
// weekly study circle offer, and the only place study circle generation talks to the model.
//
// The deterministic skeleton (theme, type, host, reward params — the parameter-economy
// values) is frozen upstream by drawWeeklyStudyCircleSkeletons and treated here as
// caller-supplied. This module is the prose stage of that 2-stage gate:
//   1. the skeleton fixes which type / host / reward the offer is about.
//   2. buildStudyCircleOfferPrompt turns the type name, its authored scene brief, the host's
//      persona (standing + character description + speaking basis), the world description, and
//      the host's memory materials into a structured prompt so the model authors a study circle
//      that fits THIS host rather than a generic one; the LLM returns a { title, situation,
//      motivation } candidate. validateStudyCircleSkeletonText adopts and gates that candidate.
//   3. buildStudyCircleAppealPrompt turns the host's persona, the SAME memory materials, and
//      the adopted { title, situation, motivation } skeleton into a SEPARATE chat prompt,
//      framed so the model voices the CONFIRMED study circle in the host's own voice without
//      inventing a different one; the LLM returns the appeal through a distinct chat call so
//      the two registers (third-person scene vs first-person address) never share a single
//      response's token budget. The appeal thus depends on the skeleton output: the skeleton
//      is generated and validated first, then fed into the appeal.
//   4. validateStudyCircleOfferText is the final gate: exact { title, situation, motivation,
//      appeal } schema, non-empty, within the length caps, no quotation/bracket/newline
//      symbols. The pure-scene ban applies to situation ONLY — appeal carries first-person
//      feeling and a direct address, so the ban must never touch it.
//
// The reward amount, the reward band, and the achievement condition are NOT generated here —
// they are authored/rolled and stay out of the model's hands. Any failure — LM unconfigured
// or unreachable, malformed response, or a gate violation — throws with nothing persisted;
// there is no authored-text fallback and no silent retry.

import { callLmStudioStructuredJson, callLmStudioChat } from './lmStudioClient.mjs';
import { forbiddenOfferContractTerm } from './offerContractWording.mjs';

// A gate/shape failure on the generated offer text is surfaced as a structured 503 (the same
// contract library generation uses: LM未設定/不通/不正出力 は authored fallback なしの構造化エラー).
// An offer candidate that fails the 2-stage gate is the model producing unusable output, so it
// shares this status rather than falling through to a generic 500. Prompt-input validation
// (buildStudyCircleOfferPrompt) stays a plain error — that is a caller/skeleton bug, not model output.
export const STUDY_CIRCLE_GENERATION_FAILED_ERROR_CODE = 'STUDY_CIRCLE_GENERATION_FAILED';

function studyCircleOfferGenerationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = STUDY_CIRCLE_GENERATION_FAILED_ERROR_CODE;
  return error;
}

// ----- tunable gate constants (not env-configurable) -----
// Character caps counted in Unicode code points. Title is a short headline phrase; situation
// is a one-breath pure scene; motivation is the study circle's driving context; appeal is
// the host's own-voice invitation (指示は200〜300字, cap は暴走 XL を弾く上限).
export const STUDY_CIRCLE_OFFER_TITLE_MAX_LENGTH = 40;
export const STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH = 120;
export const STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH = 160;
export const STUDY_CIRCLE_OFFER_APPEAL_MAX_LENGTH = 450;

// Quotation, bracket, and line-structure characters are rejected: injected quotes make the
// model emit dialogue-like fragments, and brackets/newlines break a field into structured
// pieces. Everything else (ordinary Japanese prose and punctuation) is allowed.
const FORBIDDEN_OFFER_CHARACTERS = /["'`«»“”‘’「」『』【】〈〉《》〔〕（）()[\]{}<>\r\n\t]/u;

// A pure-scene situation must not carry the "someone was here / a presence / a sigh"
// register that reads as narration-of-feelings rather than a plain visible scene. Same
// contract the errand offer situations are held to.
const BANNED_SITUATION_PATTERN = /誰|持ち主|気配|らしい|溜め息|温もり|温み|余韻|余熱|名残|見当たらない|立ち去|席を外|願かけ/u;

// The third-party rule is fixed catalog policy: an absent third party may be a topic or a
// practice partner the player role-plays, but the model must never make one physically
// present or speak in a third party's own voice.
const THIRD_PARTY_CONSTRAINT = '第三者は話題・練習の想定相手としてのみ登場させる。その場に居させない。第三者本人の台詞は生成しない（主催者による伝聞・短い引用・演技はその旨明示の地の文で可）。';

// The response_format hint asks the model for a { title, situation, motivation } object. It
// is only a hint: validateStudyCircleOfferText is the authoritative gate.
export const STUDY_CIRCLE_OFFER_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'study_circle_offer_record',
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

// The memory materials are attached verbatim as raw context, with no usage hint: the design
// deliberately leaves whether and how to use them to the model. Empty or missing memory
// attaches nothing at all (no "no memories" line).
function memoryLines(memories) {
  if (memories == null) return [];
  if (!Array.isArray(memories)) throw new Error('study circle offer memories must be an array');
  return memories
    .map((memory) => String(memory?.text ?? '').trim())
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`);
}

// The appeal is the host speaking in their OWN voice, so the persona block is the heart of
// the prompt: without the speaking_basis the model collapses every host into the same neutral
// register (measured), so all four fields are required. This is prompt input, not model
// output — a missing field is a caller/skeleton bug, a plain Error.
function studyCirclePersonaBlock(persona) {
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) {
    throw new Error('study circle offer persona must be an object');
  }
  const displayName = String(persona.display_name ?? '').trim();
  if (!displayName) throw new Error('study circle offer persona display_name is required');
  const schoolYear = String(persona.school_year ?? '').trim();
  if (!schoolYear) throw new Error('study circle offer persona school_year is required');
  const identity = String(persona.identity ?? '').trim();
  if (!identity) throw new Error('study circle offer persona identity is required');
  const speakingBasis = String(persona.speaking_basis ?? '').trim();
  if (!speakingBasis) throw new Error('study circle offer persona speaking_basis is required');
  return { displayName, schoolYear, identity, speakingBasis };
}

// The offer-skeleton persona block carries the same standing fields as the appeal PLUS the
// prompt_description, so the model authors a study circle that fits THIS host (their standing,
// manner, concerns) rather than a generic one anybody could open. This is prompt input, not
// model output — a missing field is a caller/skeleton bug, a plain Error.
function studyCircleOfferPersonaBlock(persona) {
  if (persona === null || typeof persona !== 'object' || Array.isArray(persona)) {
    throw new Error('study circle offer persona must be an object');
  }
  const displayName = String(persona.display_name ?? '').trim();
  if (!displayName) throw new Error('study circle offer persona display_name is required');
  const schoolYear = String(persona.school_year ?? '').trim();
  if (!schoolYear) throw new Error('study circle offer persona school_year is required');
  const identity = String(persona.identity ?? '').trim();
  if (!identity) throw new Error('study circle offer persona identity is required');
  const promptDescription = String(persona.prompt_description ?? '').trim();
  if (!promptDescription) throw new Error('study circle offer persona prompt_description is required');
  const speakingBasis = String(persona.speaking_basis ?? '').trim();
  if (!speakingBasis) throw new Error('study circle offer persona speaking_basis is required');
  return { displayName, schoolYear, identity, promptDescription, speakingBasis };
}

// Builds the offer-text prompt from a skeleton type (name + authored scene brief), the host's
// display name, the host's persona (standing + character description + speaking basis), the
// world description, and the host's memory materials. Pure: the same inputs render the same
// prompt. The reward, band, and achievement condition are intentionally absent — they are not
// the model's to decide. The persona and world are what make the skeleton character-fit
// (without them the model produces a generic study circle any host could open — measured);
// both are required, fail-fast.
export function buildStudyCircleOfferPrompt({ type, hostDisplayName, memories, persona, world }) {
  if (type === null || typeof type !== 'object' || Array.isArray(type)) throw new Error('study circle offer type must be an object');
  const name = String(type.name ?? '').trim();
  if (!name) throw new Error('study circle offer type name is required');
  const sceneBrief = String(type.scene_brief ?? '').trim();
  if (!sceneBrief) throw new Error('study circle offer type scene_brief is required');
  const displayName = String(hostDisplayName ?? '').trim();
  if (!displayName) throw new Error('study circle offer hostDisplayName is required');
  const worldDescription = String(world ?? '').trim();
  if (!worldDescription) throw new Error('study circle offer world_description is required');
  const { displayName: personaName, schoolYear, identity, promptDescription, speakingBasis } = studyCircleOfferPersonaBlock(persona);
  const memoryBlock = memoryLines(memories);
  return [
    '星灯魔法学院の一週間の研究会オファーを1件、文面だけ作成する。',
    '研究会は「主催キャラと会話して進める」型で、以下の確定した骨組みを前提にする。',
    '',
    `活動: ${name}`,
    `場面の骨子: ${sceneBrief}`,
    `主催: ${displayName}`,
    '',
    ...(memoryBlock.length > 0
      ? ['主催者の記憶（材料。使う・使わないは自由）:', ...memoryBlock, '']
      : []),
    'この世界の設定:',
    worldDescription,
    '',
    'この研究会を主催する主催者の人物像:',
    `- 名前: ${personaName}`,
    `- 立場: ${schoolYear}・${identity}`,
    `- 人物像: ${promptDescription}`,
    `- 話し方: ${speakingBasis}`,
    '',
    '制約:',
    `- ${THIRD_PARTY_CONSTRAINT}`,
    '- situation は純情景文にする。見えている場面だけを地の文で描き、主催者の台詞・心情説明・呼びかけを混ぜない。',
    '- 報酬・達成条件は書かない（システムが別に定める）。',
    '- 研究会の内容（title・situation・motivation）は、上の主催者の人物像・立場・世界観に噛み合った、この主催者ならではのものにする。誰が主催しても成り立つ汎用的な内容にしない。',
    '',
    '出力は title と situation と motivation だけを持つ JSON オブジェクトを1つだけ返す。',
    `title はこの研究会の短い見出し。最大${STUDY_CIRCLE_OFFER_TITLE_MAX_LENGTH}文字。`,
    `situation は研究会の会場の純情景文。最大${STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH}文字。`,
    `motivation は主催者がこの研究会を開く動機・事情の地の文。最大${STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH}文字。`,
    '引用符・鉤括弧・各種括弧・改行などの記号は使わず、地の文で書く。',
    'title と situation と motivation 以外のキーは出力しない。'
  ].join('\n');
}

// The confirmed skeleton the appeal must stay faithful to: the adopted { title, situation,
// motivation } of THIS offer. Feeding it in (and forbidding the model from inventing a
// different study circle) is what stops the own-voice invitation from swapping the skeleton's
// subject for one the persona suggests. Prompt input — a missing field is a caller bug, a
// plain Error.
function studyCircleAppealKosshiBlock(kosshi) {
  if (kosshi === null || typeof kosshi !== 'object' || Array.isArray(kosshi)) {
    throw new Error('study circle appeal kosshi must be an object');
  }
  const title = String(kosshi.title ?? '').trim();
  if (!title) throw new Error('study circle appeal kosshi title is required');
  const situation = String(kosshi.situation ?? '').trim();
  if (!situation) throw new Error('study circle appeal kosshi situation is required');
  const motivation = String(kosshi.motivation ?? '').trim();
  if (!motivation) throw new Error('study circle appeal kosshi motivation is required');
  return { title, situation, motivation };
}

// Builds the appeal prompt: the host persona (name / standing / speaking basis), the study
// circle activity + authored scene brief, the same memory materials, and the CONFIRMED
// skeleton (title / situation / motivation), framed so the model writes AS the host inviting
// the player into the SAME study circle in their own voice. Pure: same inputs, same prompt.
// The reward / achievement condition are intentionally absent (not the model's to decide),
// and the second-person / no-name-symbol / single-paragraph clauses are what keep the
// command-register hosts from emitting the placeholder brackets + newline the offer gate
// forbids (measured). The 200〜300字 length line is the sweet-spot band from the study.
export function buildStudyCircleAppealPrompt({ type, persona, memories, kosshi }) {
  if (type === null || typeof type !== 'object' || Array.isArray(type)) throw new Error('study circle offer type must be an object');
  const name = String(type.name ?? '').trim();
  if (!name) throw new Error('study circle offer type name is required');
  const sceneBrief = String(type.scene_brief ?? '').trim();
  if (!sceneBrief) throw new Error('study circle offer type scene_brief is required');
  const { displayName, schoolYear, identity, speakingBasis } = studyCirclePersonaBlock(persona);
  const { title, situation, motivation } = studyCircleAppealKosshiBlock(kosshi);
  const memoryBlock = memoryLines(memories);
  return [
    `あなたは星灯魔法学院の生徒（または教職員）、${displayName}本人である。いま目の前の主人公に向けて、この研究会を自分の口から持ちかける。`,
    '',
    'あなたの人物像:',
    `- 名前: ${displayName}`,
    `- 立場: ${schoolYear}・${identity}`,
    `- 話し方: ${speakingBasis}`,
    '',
    `開く研究会（活動）: ${name}`,
    `どんな場面か: ${sceneBrief}`,
    '',
    'この研究会はすでに内容が確定している。あなたはこの確定した研究会に、内容を別のものに変えず、あなた自身の口調で主人公を誘う:',
    `- 研究会の見出し: ${title}`,
    `- 現場の様子: ${situation}`,
    `- あなたがこの研究会を開く動機・事情: ${motivation}`,
    '',
    ...(memoryBlock.length > 0
      ? ['あなたが覚えている主人公とのこと（材料。使う・使わないは自由）:', ...memoryBlock, '']
      : []),
    '書き方:',
    '- 上の「確定した研究会」の内容（何をやる集まりか）をそのまま誘う。上の内容と違う別の活動・別の集まりを新しく作り出さない。',
    '- その場で主人公に直接語りかけるように、呼びかけの口調で書く。ただし引用符や鉤括弧で自分の言葉を囲わず、語り全体をそのまま地の文として書く。',
    '- 一人称で、あなた自身の話し方（上の「話し方」）そのままの口調で語る。別人の声にならないようにする。',
    '- 何をしたくて研究会を開くのか、主人公に何を一緒にしてほしいのか、なぜ主人公を誘うのかが、あなた自身の言葉で自然に伝わるようにする。',
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
  if (typeof value !== 'string') throw studyCircleOfferGenerationError(`study circle offer ${label} must be a string`);
  if (value.trim().length === 0) throw studyCircleOfferGenerationError(`study circle offer ${label} must not be empty`);
  if ([...value].length > max) throw studyCircleOfferGenerationError(`study circle offer ${label} must be at most ${max} characters`);
  const forbidden = value.match(FORBIDDEN_OFFER_CHARACTERS);
  if (forbidden) throw studyCircleOfferGenerationError(`study circle offer ${label} must not contain quotation or bracket symbols: ${forbidden[0]}`);
  // The achievement condition and reward are system-owned (surfaced by system-owned UI); a
  // generated field must not state them, or the screen would fake the hidden judgment contract.
  const contractTerm = forbiddenOfferContractTerm(value);
  if (contractTerm) throw studyCircleOfferGenerationError(`study circle offer ${label} must not state the system-owned achievement condition or reward: ${contractTerm}`);
  return value.trim();
}

// Adopts and gates the structured skeleton BEFORE the appeal is generated: the exact
// { title, situation, motivation } schema, non-empty, length caps, forbidden-symbol rule,
// and the pure-scene rule on situation. Returns the trimmed skeleton — the value the appeal
// is written against and that the offer ultimately adopts (so a malformed skeleton fails
// fast here, on the offer gate's message, without spending an appeal call).
export function validateStudyCircleSkeletonText(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw studyCircleOfferGenerationError('study circle offer skeleton must be an object');
  const keys = Object.keys(candidate);
  const exact = keys.length === 3 && keys.includes('title') && keys.includes('situation') && keys.includes('motivation');
  if (!exact) throw studyCircleOfferGenerationError(`study circle offer skeleton keys must be exactly {title, situation, motivation}: got {${keys.sort().join(', ')}}`);
  const title = assertOfferField(candidate.title, 'title', STUDY_CIRCLE_OFFER_TITLE_MAX_LENGTH);
  const situation = assertOfferField(candidate.situation, 'situation', STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH);
  if (BANNED_SITUATION_PATTERN.test(situation)) throw studyCircleOfferGenerationError('study circle offer situation contains non-scene wording');
  const motivation = assertOfferField(candidate.motivation, 'motivation', STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH);
  return { title, situation, motivation };
}

// The 2-stage gate: validates a candidate against the exact { title, situation, motivation,
// appeal } schema, non-empty, length caps, and the forbidden-symbol rule. The pure-scene rule
// applies to situation ONLY: appeal is a first-person address whose feeling words would trip
// that ban, so the ban must never touch it. Throws with a reason on any violation; returns the
// trimmed fields on success.
export function validateStudyCircleOfferText(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw studyCircleOfferGenerationError('study circle offer candidate must be an object');
  const keys = Object.keys(candidate);
  const exact = keys.length === 4 && keys.includes('title') && keys.includes('situation') && keys.includes('motivation') && keys.includes('appeal');
  if (!exact) throw studyCircleOfferGenerationError(`study circle offer candidate keys must be exactly {title, situation, motivation, appeal}: got {${keys.sort().join(', ')}}`);
  const title = assertOfferField(candidate.title, 'title', STUDY_CIRCLE_OFFER_TITLE_MAX_LENGTH);
  const situation = assertOfferField(candidate.situation, 'situation', STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH);
  if (BANNED_SITUATION_PATTERN.test(situation)) throw studyCircleOfferGenerationError('study circle offer situation contains non-scene wording');
  const motivation = assertOfferField(candidate.motivation, 'motivation', STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH);
  const appeal = assertOfferField(candidate.appeal, 'appeal', STUDY_CIRCLE_OFFER_APPEAL_MAX_LENGTH);
  return { title, situation, motivation, appeal };
}

// ----- orchestration -----

// Generates and gates one offer's text. The structured { title, situation, motivation } is
// one character-fit structured-JSON call, adopted and gated by validateStudyCircleSkeletonText;
// the appeal is a SEPARATE chat call (single-register, own token budget) written against that
// adopted skeleton so it voices the SAME study circle and carries the full length + heat the
// bundled form would starve. The order is load-bearing: the skeleton is generated and validated
// first, then fed into the appeal. Returns the validated { title, situation, motivation,
// appeal }. The LLM transport (fetchImpl) is injectable per the lmStudioClient convention. Any
// failure throws with nothing persisted; there is no fallback text.
export async function generateStudyCircleOfferText({ config, fetchImpl, type, hostDisplayName, persona, memories, world } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for study circle offer generation');
  const skeleton = validateStudyCircleSkeletonText(await callLmStudioStructuredJson({
    config,
    prompt: buildStudyCircleOfferPrompt({ type, hostDisplayName, memories, persona, world }),
    fetchImpl,
    responseFormat: STUDY_CIRCLE_OFFER_RESPONSE_FORMAT,
    title: '研究会オファー文面生成'
  }));
  const appeal = await callLmStudioChat({
    config,
    prompt: buildStudyCircleAppealPrompt({ type, persona, memories, kosshi: skeleton }),
    fetchImpl,
    title: '研究会オファー当人の語り生成'
  });
  return validateStudyCircleOfferText({ ...skeleton, appeal });
}
