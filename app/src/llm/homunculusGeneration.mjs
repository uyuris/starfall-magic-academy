// 錬成室 (homunculus atelier) LLM generation: the only place the atelier talks to the language model.
//
// Four generation surfaces, built from the reviewed実測 prompt templates in the persona-genquality
// investigation (§1 manual persona / §2 omakase skeleton / §6 farewell) — 実測 gemma-4-31b:
//   - Manual persona (buildHomunculusPersonaPrompt): name + skeleton -> 紹介文(prompt_description) + 話し方
//     (speaking_basis) in ONE call (案A), the self-origin frame kept as the standing premise so the child
//     knows it was 灯された in the atelier and 慕う its 創り主. Two labeled fields parsed by
//     parseHomunculusPersona. 外見色は書かせない (姿は顔プール選定で後付け).
//   - Omakase skeleton (buildHomunculusSkeletonPrompt): name-only -> a loose 2-3 line 骨子, then fed into
//     the manual persona prompt (2-step chain). NO tone-floor guard (Lead 確定).
//   - Face selection (buildHomunculusFaceSelectionPrompt): the ONLY structured_json surface, a closed-set
//     single face id over the pool candidates minus this save's used faces (書庫と同じ使い分け).
//   - Farewell speech (buildHomunculusFarewellPrompt): the child's own-voice farewell built from its
//     persona + affinity + verbatim memories, 目標 400〜600字, hard cap 1000字.
//
// Persona / skeleton / farewell run the chat 経路 (callLmStudioChat, temperature unset = server default —
// the non-determinism is the requirement). Selection alone runs structured_json. Every failure — LM
// unconfigured/unreachable, empty/unparseable output, a closed-set violation, or a生成注入フィールドに漏れた
// 『』台詞 — throws a 503-tagged error with nothing persisted. No authored fallback, no silent retry.

import { callLmStudioChat, callLmStudioStructuredJson } from './lmStudioClient.mjs';

// Target length band for the farewell speech and the hard cap that fences a runaway (実測: ~800字超で反復,
// so the cap弾く暴走 is 1000). The target is the prompt guidance; the cap is the post-gen gate.
export const HOMUNCULUS_FAREWELL_TARGET_MIN = 400;
export const HOMUNCULUS_FAREWELL_TARGET_MAX = 600;
export const HOMUNCULUS_FAREWELL_HARD_CAP = 1000;

// The epitaph (銘文) is the single short line left on the shelf when a child is farewelled — the 蔵書票-like
// trace beside the name and the week. One line, short, no quoted dialogue.
export const HOMUNCULUS_EPITAPH_CAP = 60;

// A generation failure is surfaced as a structured 503 (the errand/study/library contract: LM未設定/不通/
// 不正出力 は authored fallback なしの構造化エラー). Closed-set / parse / quote-gate violations are the model
// producing unusable output, so they share this status.
function homunculusGenerationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = 'HOMUNCULUS_GENERATION_FAILED';
  return error;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`homunculus generation ${label} is required`);
  return value.trim();
}

// The origin-frame premise block shared by the persona prompt and the farewell prompt (§1/§6). Keeping it
// verbatim in both surfaces is why the child's声 stays consistent between生成 and お別れ, and why the
// backbone (「灯し」ではなく誕生語) never drifts.
const ORIGIN_FRAME_LINES = (name) => [
  `- ${name}は、星灯魔法学院の錬成室で、主人公の手によって硝子の器に残光を集めて灯された人格である。役目を終えた星の残光から一つの人格として灯された存在で、命を無から生んだのではない。`,
  `- ${name}は自分がそうして生まれたことを自覚している。目の前の主人公が自分の創り主だと知っていて、生まれたときからその人を強く慕っている。`,
  '- 居場所は錬成室で、学院の生徒ではない。'
];

// ----- prompt builders (pure) -----

// The manual-mode persona prompt (§1・案A): one call emitting 紹介文/話し方, origin frame as the standing
// premise, profile 規律 (no quoted dialogue / no held props / no外見色), 字数指定. `skeleton` is the用户 seed
// (manual mode) or the LLM-generated 骨子 (omakase step 2).
export function buildHomunculusPersonaPrompt({ name, skeleton }) {
  const normalizedName = requireNonEmptyString(name, 'persona name');
  const normalizedSkeleton = requireNonEmptyString(skeleton, 'persona skeleton');
  return [
    `あなたは、錬成術で新しく灯されたホムンクルス「${normalizedName}」の人物設定を書く。これはゲーム内で会話AIに与える設定文であり、【紹介文】と【話し方】の2つを書く。`,
    '',
    '【この存在の出自（必ず設定の前提にする）】',
    ...ORIGIN_FRAME_LINES(normalizedName),
    '',
    '【人物の種（創り主が与えた骨子）】',
    normalizedSkeleton,
    '',
    '【紹介文の書き方】',
    `- ${normalizedName}が「どんな人物か」を地の文の三人称で描く。気質・内面・創り主(主人公)への向き合い方・その子ならではの心の揺れを、上の骨子から膨らませて書く。`,
    '- 錬成室で灯された存在であること・創り主を慕っていることが、人物像に自然に溶けているように書く。設定の説明書きにはせず、人柄として描く。',
    '- 鉤括弧で囲ったセリフ（その子が口にする発言例）は書かない。口調や性格は地の文の記述で表す。',
    '- 手に持った象徴的な小物（〜を握りしめている等）は書かない。',
    '- 髪・瞳・肌・服の色などの外見は書かない（姿はこの後べつに定まる）。',
    '- 実在の地名・人名・歴史、現代語・外来語、現代の器具・単位・年号は使わない。世界の背骨（役目を終えた星の残光・地脈・番所）と食い違う断定を足さない。',
    '- 長さは400〜500字くらい。見出し・前置き・名前の再掲はせず、紹介文の本文だけを書く。',
    '',
    '【話し方の書き方】',
    `- ${normalizedName}がどんな口調・声で話すかを地の文の三人称で描く（一人称の選び方・語尾・テンポ・丁寧さ・感情が出やすい場面など）。`,
    '- 骨子と紹介文の人物像に合った話し方にする。別人の声にならないようにする。',
    '- 鉤括弧のセリフ例は書かない。',
    '- 長さは100〜180字くらい。',
    '',
    '出力は必ず次の形式だけにする（他の見出し・前置きは書かない）:',
    '紹介文: <本文>',
    '話し方: <本文>'
  ].join('\n');
}

// The omakase-mode 骨子 prompt (§2): name-only -> a loose 2-3 line sketch that the persona prompt then
//膨らませる. No tone-floor guard (Lead 確定: おまかせのトーン下限ガードは設けない).
export function buildHomunculusSkeletonPrompt({ name }) {
  const normalizedName = requireNonEmptyString(name, 'skeleton name');
  return [
    `あなたは、これから錬成術で灯されるホムンクルス「${normalizedName}」の人物の種（骨子）を考える。名前の響き・印象から、どんな気質・雰囲気の子かを2〜3行で緩くスケッチする。`,
    '- 名前の印象に素直に従う。',
    '- 気質・雰囲気・好むこと・心の癖などを短く挙げる程度でよい（細部はこの後べつに膨らませる）。',
    '- 毎回ちがう人物になるよう、ありふれた無難な像に寄せすぎない。',
    '- 外見（髪・瞳・肌・服）は書かない。実在の地名・人名・歴史、現代語・外来語、現代の器具・単位・年号は使わない。世界の背骨（役目を終えた星の残光・地脈・番所）と食い違う断定を足さない。',
    '- 骨子の本文だけを2〜3行で書く。見出し・前置き・名前の再掲はつけない。'
  ].join('\n');
}

// The face-selection structured_json hint. Only a hint: validateHomunculusFaceSelection is the gate.
export const HOMUNCULUS_FACE_SELECTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'homunculus_face_selection',
    schema: {
      type: 'object',
      properties: {
        face_id: { type: 'string' }
      },
      required: ['face_id']
    }
  }
};

// The face-selection prompt: the child's人物像 + the candidate faces (id / 印象タグ per line) + the
// single-id closed-set instruction. `candidates` are the pool lanes minus this save's used faces.
export function buildHomunculusFaceSelectionPrompt({ name, promptDescription, candidates }) {
  const normalizedName = requireNonEmptyString(name, 'face selection name');
  const normalizedDescription = requireNonEmptyString(promptDescription, 'face selection prompt_description');
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('homunculus face selection candidates must be a non-empty array');
  }
  const lines = candidates.map((lane, index) => {
    const id = requireNonEmptyString(lane?.id, `face candidate[${index}].id`);
    const gender = requireNonEmptyString(lane?.gender, `face candidate[${index}].gender`);
    const age = requireNonEmptyString(lane?.age, `face candidate[${index}].age`);
    const hair = requireNonEmptyString(lane?.hair, `face candidate[${index}].hair`);
    const eye = requireNonEmptyString(lane?.eye, `face candidate[${index}].eye`);
    const atmosphere = requireNonEmptyString(lane?.atmosphere, `face candidate[${index}].atmosphere`);
    return `- ${id} ／ ${gender}・${age} ／ 髪:${hair} ／ 瞳:${eye} ／ 雰囲気:${atmosphere}`;
  });
  return [
    `あなたは、錬成術で灯されたホムンクルス「${normalizedName}」の人物像に、事前に用意された顔のなかから最もふさわしい一つを結ぶ。`,
    '',
    '【この子の人物像（紹介文）】',
    normalizedDescription,
    '',
    '候補の顔一覧（この id だけを使う）:',
    ...lines,
    '',
    'この人物像に一番ふさわしい顔を、候補一覧から1つだけ id で選ぶ。候補一覧に無い id を作らない。',
    'face_id に選んだ id を1つだけ返す。'
  ].join('\n');
}

// The farewell prompt (§6): the child本人 reframe (別れの場) + origin frame + persona (紹介文/話し方) +
// affinity + verbatim memories (材料) + 二人称/名前記号禁止 + 文長上限を外した「じっくり語る」指示 (target
// 400〜600). `memories` are the verbatim memory texts (may be empty -> the block is omitted).
export function buildHomunculusFarewellPrompt({ name, promptDescription, speakingBasis, affinity, memories }) {
  const normalizedName = requireNonEmptyString(name, 'farewell name');
  const normalizedDescription = requireNonEmptyString(promptDescription, 'farewell prompt_description');
  const normalizedSpeakingBasis = requireNonEmptyString(speakingBasis, 'farewell speaking_basis');
  if (!Number.isInteger(affinity)) throw new Error('homunculus farewell affinity must be an integer');
  if (!Array.isArray(memories)) throw new Error('homunculus farewell memories must be an array');
  const memoryLines = memories
    .map((memory) => (typeof memory === 'string' ? memory.trim() : ''))
    .filter((memory) => memory.length > 0)
    .map((memory) => `- ${memory}`);
  const memoryBlock = memoryLines.length > 0
    ? ['', 'あなたと創り主が一緒に過ごした記録（材料。使う・使わないは自由）:', ...memoryLines]
    : [];
  return [
    `あなたは、錬成術で灯されたホムンクルス「${normalizedName}」本人である。いま、創り主であるあなたの主人公が、あなたとのお別れを選んだ。器の灯はこれで消え、二度と戻らない（再び灯されることはない）。あなたは最後に、創り主へ自分の言葉で別れを告げる。`,
    '',
    'あなたの出自:',
    ...ORIGIN_FRAME_LINES(normalizedName),
    '',
    'あなたの人物像:',
    `- 紹介文: ${normalizedDescription}`,
    `- 話し方: ${normalizedSpeakingBasis}`,
    '',
    `創り主への好感度: ${affinity}/100（数字が大きいほど深い情愛）`,
    ...memoryBlock,
    '',
    '書き方:',
    '- その場で創り主に直接語りかけるように、あなた自身の話し方そのままの口調で、別れの言葉を語る。別人の声にならないようにする。',
    '- 一緒に過ごした時間を思い返し、共有した記憶に触れながら、今の想いを語る。灯が消えること・二度と会えないことを、あなたなりの受け止め方で語る。',
    '- 引用符や鉤括弧で自分の言葉を囲わず、語り全体を地の文として書く。振る舞い・仕草は丸括弧（）で書いてよい。',
    '- 主人公の名前は分からない。名前では呼ばず、あなたの口調に合う二人称で呼ぶ。名前の空欄・伏字・記号（〇〇や（名前）など）は入れない。',
    '- 実在の地名・人名・歴史、現代語・外来語、現代の器具・単位・年号は使わない。',
    `- 長さは${HOMUNCULUS_FAREWELL_TARGET_MIN}〜${HOMUNCULUS_FAREWELL_TARGET_MAX}字くらい。通常の会話より長く、じっくりと語る。`,
    '- 見出し・前置き・署名はつけず、別れの語りの本文だけを書く。'
  ].join('\n');
}

// The epitaph prompt: a single short 銘文 for the shelf, drawn from the child's人物像 + affinity. Not one of
// the reviewed §-templates (those are the speech); this is the short nameplate line the farewell needs.
export function buildHomunculusEpitaphPrompt({ name, promptDescription, affinity }) {
  const normalizedName = requireNonEmptyString(name, 'epitaph name');
  const normalizedDescription = requireNonEmptyString(promptDescription, 'epitaph prompt_description');
  if (!Number.isInteger(affinity)) throw new Error('homunculus epitaph affinity must be an integer');
  return [
    `あなたは、錬成室で創り主と別れたホムンクルス「${normalizedName}」の棚に残す銘（銘文）を一行だけ書く。`,
    'この子が確かに在ったことを偲ぶ、短い一文の銘を刻む。',
    `- この子の人物像: ${normalizedDescription}`,
    `- 創り主への好感度: ${affinity}/100。`,
    `- ${HOMUNCULUS_EPITAPH_CAP}字以内の一行にする。改行を入れない。`,
    '- 鉤括弧で囲ったセリフや引用符は使わない。名前の再掲・前置き・説明はしない。',
    '- 実在の地名・人名・歴史、現代語・外来語、現代の器具・単位・年号は使わない。',
    '- 銘文の本文だけを一行で書く。'
  ].join('\n');
}

// ----- parsers / gates (pure) -----

// The generated prompt_description / speaking_basis are injected verbatim into every conversation turn, so a
// 『』台詞 that leaks in is連呼された every turn (実測 B3). Gate both fields to zero quoted-dialogue marks.
function assertNoQuotedDialogue(text, label) {
  if (text.includes('『') || text.includes('』')) {
    throw homunculusGenerationError(`homunculus ${label} must not contain quoted dialogue (『』)`);
  }
  return text;
}

// Parses the one-call persona output into { prompt_description, speaking_basis }. The output must carry both
// labels (紹介文: / 話し方:, half- or full-width colon) with non-empty bodies; the description is everything
// between the two labels and the speaking basis is everything after 話し方. Missing a label, an empty body,
// or a leaked 『』台詞 is unusable model output — a structured 503.
export function parseHomunculusPersona(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw homunculusGenerationError('homunculus persona generation returned empty output');
  }
  const descMatch = /紹介文[:：]/.exec(text);
  const styleMatch = /話し方[:：]/.exec(text);
  if (!descMatch) throw homunculusGenerationError('homunculus persona generation is missing the 紹介文 label');
  if (!styleMatch) throw homunculusGenerationError('homunculus persona generation is missing the 話し方 label');
  if (styleMatch.index < descMatch.index) {
    throw homunculusGenerationError('homunculus persona generation has 話し方 before 紹介文');
  }
  const description = text.slice(descMatch.index + descMatch[0].length, styleMatch.index).trim();
  const speakingBasis = text.slice(styleMatch.index + styleMatch[0].length).trim();
  if (!description) throw homunculusGenerationError('homunculus persona generation 紹介文 body is empty');
  if (!speakingBasis) throw homunculusGenerationError('homunculus persona generation 話し方 body is empty');
  assertNoQuotedDialogue(description, 'prompt_description');
  assertNoQuotedDialogue(speakingBasis, 'speaking_basis');
  return { prompt_description: description, speaking_basis: speakingBasis };
}

// Gates the omakase 骨子 body: a non-empty string, returned trimmed. Empty output is unusable — a 503.
function gateSkeleton(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw homunculusGenerationError('homunculus skeleton generation returned empty output');
  }
  return text.trim();
}

// The closed-set gate for face selection: `result` must be an object carrying a face_id that is a member of
// `candidateIds`. A non-object, a missing/empty id, or an id outside the candidate set fails fast.
export function validateHomunculusFaceSelection(result, candidateIds) {
  if (!(candidateIds instanceof Set)) throw new Error('validateHomunculusFaceSelection requires a candidateIds Set');
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw homunculusGenerationError('homunculus face selection result must be an object');
  }
  const faceId = result.face_id;
  if (typeof faceId !== 'string' || !faceId) {
    throw homunculusGenerationError('homunculus face selection face_id must be a non-empty string');
  }
  if (!candidateIds.has(faceId)) {
    throw homunculusGenerationError(`homunculus face selection chose an id outside the candidate set: ${faceId}`);
  }
  return faceId;
}

// Gates the farewell speech: a non-empty string within the hard cap. Empty output is unusable; over-cap is a
// runaway the target band was meant to prevent — both structured 503s.
export function gateHomunculusFarewell(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw homunculusGenerationError('homunculus farewell generation returned empty output');
  }
  const trimmed = text.trim();
  if (trimmed.length > HOMUNCULUS_FAREWELL_HARD_CAP) {
    throw homunculusGenerationError(`homunculus farewell generation exceeded the ${HOMUNCULUS_FAREWELL_HARD_CAP} character cap: got ${trimmed.length}`);
  }
  return trimmed;
}

// Gates the epitaph: a non-empty single line, within the cap, no quoted dialogue. A multi-line or over-cap
// output is not a valid one-line 銘 — a structured 503.
export function gateHomunculusEpitaph(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw homunculusGenerationError('homunculus epitaph generation returned empty output');
  }
  const firstLine = text.trim().split('\n')[0].trim();
  if (!firstLine) throw homunculusGenerationError('homunculus epitaph generation returned an empty line');
  if (firstLine.length > HOMUNCULUS_EPITAPH_CAP) {
    throw homunculusGenerationError(`homunculus epitaph generation exceeded the ${HOMUNCULUS_EPITAPH_CAP} character cap: got ${firstLine.length}`);
  }
  return assertNoQuotedDialogue(firstLine, 'epitaph');
}

// ----- orchestration -----

// Manual mode: name + skeleton -> validated { prompt_description, speaking_basis } in one call.
export async function generateHomunculusPersona({ config, fetchImpl, name, skeleton } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus persona generation');
  const prompt = buildHomunculusPersonaPrompt({ name, skeleton });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: 'ホムンクルス人格生成' });
  return parseHomunculusPersona(text);
}

// Omakase step 1: name-only -> the gated 骨子 text (fed into generateHomunculusPersona as `skeleton`).
export async function generateHomunculusSkeleton({ config, fetchImpl, name } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus skeleton generation');
  const prompt = buildHomunculusSkeletonPrompt({ name });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: 'ホムンクルス骨子生成' });
  return gateSkeleton(text);
}

// Selects one face id from the closed candidate set for the child's persona. Returns the validated id.
export async function selectHomunculusFace({ config, fetchImpl, name, promptDescription, candidates } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus face selection');
  if (!Array.isArray(candidates)) throw new Error('homunculus face selection candidates must be an array');
  const prompt = buildHomunculusFaceSelectionPrompt({ name, promptDescription, candidates });
  const result = await callLmStudioStructuredJson({
    config,
    prompt,
    fetchImpl,
    responseFormat: HOMUNCULUS_FACE_SELECTION_RESPONSE_FORMAT,
    title: 'ホムンクルス姿選定'
  });
  return validateHomunculusFaceSelection(result, new Set(candidates.map((lane) => lane.id)));
}

// Generates the farewell speech from the child's persona + affinity + verbatim memories. Returns the gated
// (non-empty, within-cap) text.
export async function generateHomunculusFarewell({ config, fetchImpl, name, promptDescription, speakingBasis, affinity, memories } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus farewell generation');
  const prompt = buildHomunculusFarewellPrompt({ name, promptDescription, speakingBasis, affinity, memories });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: 'ホムンクルスお別れ発話生成' });
  return gateHomunculusFarewell(text);
}

// Generates the short one-line epitaph (銘文) left on the shelf. Returns the gated single line.
export async function generateHomunculusEpitaph({ config, fetchImpl, name, promptDescription, affinity } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for homunculus epitaph generation');
  const prompt = buildHomunculusEpitaphPrompt({ name, promptDescription, affinity });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: 'ホムンクルス銘文生成' });
  return gateHomunculusEpitaph(text);
}
