// 大書庫 (library) LLM generation: the only place the library talks to the language model.
//
// Four generation surfaces, all built from the reviewed prompt discipline in
// ref-llm-pipeline.md (實測 gemma-4-31b, task library-genprompt-reqd-t3-implementation):
//   - Fragment body (periphery / generated books): buildLibraryFragmentPrompt — the author-voice
//     template. The model is the book's writer narrating the page's own subject directly; the digest
//     verbs (「〜が描き出されている」…) are named as forbidden so the page never describes the book from
//     outside, and inventing flora/places/villages/lore detail is permitted (実在物・現代語・外来語 除く).
//     A one-line canon-guard is in every book; a backbone-flagged catalog book (world/cosmos only)
//     additionally prepends the full 世界の背骨 block + the "背骨を講義しない" bullet. A generated book
//     never gets the backbone block.
//   - Titles (generation-fill + free books): buildLibraryTitlesPrompt — a theme-bound list. Every
//     title, in both the fill and the free row, must read as the search theme (fidelity + a one-line
//     world anchor, no backbone block); the free row is catalog-external books, not a theme-free row.
//   - Skeleton (generated books, lazy): buildLibrarySkeletonPrompt — a loose 2-3 line sketch,
//     backbone deliberately withheld so it does not leak lore into the sketch.
//   - Selection (theme -> catalog ids): buildLibrarySelectionPrompt — the ONLY structured_json
//     surface, a closed-set id list (<=5) over the gate-passing candidates.
//
// Body / title / skeleton run the chat 経路 (callLmStudioChat, temperature unset = server
// default — the non-determinism is the requirement, not a defect). Selection alone runs
// structured_json. Every failure — LM unconfigured/unreachable, empty/unparseable output, or a
// closed-set violation — throws a 503-tagged error with nothing persisted. No authored fallback,
// no silent retry, no partial-result swallowing.

import { callLmStudioChat, callLmStudioStructuredJson } from './lmStudioClient.mjs';

// The world backbone block, prepended to the fragment prompt of a backbone-flagged catalog book
// (world/cosmos only). Verbatim canon (世界の背骨5柱の要約一文).
export const LIBRARY_BACKBONE_BLOCK = '【世界の背骨】役目を終えた星が地に降りて砕け、その「残光」が大地に沁みて地脈となる。魔法とは星の残光を借りて返して使う技術で、学院はその落着地に建つ番所である。';

// The category stamped on a generated (catalog-external) book.
export const LIBRARY_GENERATED_CATEGORY = '生成写本';

// The closed-set selection cap: at most 5 catalog ids chosen per search.
export const LIBRARY_MAX_SELECTION = 5;

// A generation failure is surfaced as a structured 503 (the errand/study contract: LM未設定/不通/
// 不正出力 は authored fallback なしの構造化エラー). Closed-set / parse violations are the model
// producing unusable output, so they share this status rather than a generic 500.
function libraryGenerationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = 'LIBRARY_GENERATION_FAILED';
  return error;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`library generation ${label} is required`);
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`library generation ${label} must be a positive integer`);
  return value;
}

// The structured_json hint for selection. Only a hint: validateLibrarySelection is the gate.
export const LIBRARY_SELECTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'library_book_selection',
    schema: {
      type: 'object',
      properties: {
        book_ids: { type: 'array', items: { type: 'string' } }
      },
      required: ['book_ids']
    }
  }
};

// ----- prompt builders (pure) -----

// The 骨子 block handed to the fragment prompt: the 書名/分類 line prefixed before the sketch, so
// the model always knows the book's identity even for a bare authored skeleton.
function fragmentSkeletonBlock({ title, category, skeleton }) {
  return `書名『${title}』／分類: ${category}。\n${skeleton}`;
}

// Builds the fragment-body prompt for one periphery or generated book. The author-voice reqD form:
// direct narration of the subject, the digest verbs named as forbidden, flavor invention permitted
// (実在物・現代語・外来語 除く), and a one-line canon-guard always present. `backbone` true (world/cosmos
// catalog books only) additionally prepends the full backbone block and adds the "背骨を講義しない"
// bullet; generated books always pass backbone false. Pure: same inputs render the same prompt.
export function buildLibraryFragmentPrompt({ title, category, skeleton, backbone }) {
  const normalizedTitle = requireNonEmptyString(title, 'fragment title');
  const normalizedCategory = requireNonEmptyString(category, 'fragment category');
  const normalizedSkeleton = requireNonEmptyString(skeleton, 'fragment skeleton');
  if (typeof backbone !== 'boolean') throw new Error('library generation fragment backbone must be a boolean');
  const bullets = [
    '- 骨子はあくまで種であり、主題そのものを情景・手触り・匂い・光・来歴などで具体的に肉付けする。',
    '- 本を外から紹介・要約・目次化しない。「〜が描き出されている」「〜が綴られている」「〜に紙幅が割かれている」「〜が並べられている」「本書は〜を説く」のように、その本が何を扱うかを外側から述べる書き方を一切しない。かわりに、主題となる事物そのものを、あなた自身が直接に叙述する。「〜は〜という性質を持ち、〜のように用いられる」のように、事物について直接書く。',
    '- 骨子に無い草や品・土地・村・人の営み・言い伝え・逸話などの細部は、読み物として豊かにするために自由に補って創作してよい。ただし実在の地名・人名・歴史や、現代語・外来語・現代の器具・単位・年号は持ち込まない。',
    '- 効能・用途・由来・変わった使われ方や、脇道の逸話・余談まで、書き手が筆を滑らせるように書き添えてよい。',
    '- ただし世界の背骨（役目を終えた星が砕けて残光となり地脈に沁みる／魔法は残光を借りて返す技術／学院はその番所）と食い違う断定はしない。',
    ...(backbone ? ['- 世界の背骨と矛盾しない範囲で書き、背骨そのものを講義的に説明はしない。'] : []),
    '- 長さは300〜400字程度。',
    '- 会話文や引用符で囲ったセリフ、口調の再現は書かない（地の文の記述体・随筆体で書く）。',
    '- 前置きや説明、題名の再掲はせず、本文だけを書く。'
  ];
  return [
    ...(backbone ? [LIBRARY_BACKBONE_BLOCK, ''] : []),
    'あなたは魔法学院の大書庫に収められた一冊の本の書き手である。いまその本の一節として、頁に記される本文そのものを書く。',
    '次の骨子が示す主題について、事典や随筆のように直接語る本文を書く。',
    ...bullets,
    '',
    '【骨子】',
    fragmentSkeletonBlock({ title: normalizedTitle, category: normalizedCategory, skeleton: normalizedSkeleton })
  ].join('\n');
}

// Builds the title-list prompt for `count` titles bound to the search `theme` — the same T3 form for
// both the generation-fill row and the free (catalog-external) row: every title must read as the
// theme, a one-line world anchor replaces the backbone block, and the 雰囲気-first hedge is gone. Pure.
export function buildLibraryTitlesPrompt({ theme, count }) {
  const normalizedTheme = requireNonEmptyString(theme, 'titles theme');
  const normalizedCount = requirePositiveInteger(count, 'titles count');
  return [
    `あなたは魔法学院の大書庫の蔵書目録を作っている。次のテーマ『${normalizedTheme}』を主題とする本のタイトルを${normalizedCount}つ考える。`,
    `- どの題も、テーマ『${normalizedTheme}』を扱う本だと読み手が一目でわかるようにする。テーマから離れた題は出さない。`,
    '- この世界は、星の残光と地脈の魔法が息づく古い学院世界である。「元素」「精霊」「宮廷」などこの世界にそぐわない一般的な異世界語や、実在の地名・人名・現代語・器具名は使わない。',
    '- 古い書物らしい落ち着いた題にする。テーマ語を無理に背骨の語（残光・地脈など）と接ぎ木しなくてよい。',
    `- 会話文や説明・番号の意味づけは不要。タイトルだけを1行ずつ、${normalizedCount}つ挙げる。`
  ].join('\n');
}

// Builds the lazy-skeleton prompt for one generated book title. Backbone deliberately withheld
// (a backbone here leaks lore into the sketch and forecloses the body's余白). Pure.
export function buildLibrarySkeletonPrompt({ title }) {
  const normalizedTitle = requireNonEmptyString(title, 'skeleton title');
  return [
    'あなたは魔法学院の大書庫の書誌カタログを整えている。',
    '次の本について、後で本文を生成するための「骨子」を書く。骨子は本文そのものではなく、緩いスケッチである。',
    '- 2〜3行の短いスケッチにする。具体的になりすぎない。',
    '- 固有名詞・確定した事実・数値を新しく作り込まない（本文生成側に描写の余白を残す）。',
    '- 分類／何の本か／眼差し・味わい、を端的に示す程度でよい。',
    '- 会話文や引用符で囲ったセリフは入れない。',
    '- 前置きや説明はせず、骨子だけを書く。',
    '',
    `書名『${normalizedTitle}』／分類: ${LIBRARY_GENERATED_CATEGORY}。`
  ].join('\n');
}

// Builds the selection prompt: the theme, the gate-passing candidate list (id / title / category
// per line), and the closed-set instruction. `candidates` are the gate-passing catalog entries.
export function buildLibrarySelectionPrompt({ theme, candidates }) {
  const normalizedTheme = requireNonEmptyString(theme, 'selection theme');
  if (!Array.isArray(candidates)) throw new Error('library generation selection candidates must be an array');
  const lines = candidates.map((candidate, index) => {
    const id = requireNonEmptyString(candidate?.id, `selection candidate[${index}].id`);
    const title = requireNonEmptyString(candidate?.title, `selection candidate[${index}].title`);
    const category = requireNonEmptyString(candidate?.category, `selection candidate[${index}].category`);
    return `- ${id} ／ ${title} ／ ${category}`;
  });
  return [
    'あなたは魔法学院の大書庫の蔵書から、次のテーマに合う本を選ぶ司書である。',
    `テーマ: ${normalizedTheme}`,
    '',
    '候補一覧（この id だけを使う）:',
    ...lines,
    '',
    `テーマに合う本を最大${LIBRARY_MAX_SELECTION}冊、id で選ぶ。合うものが無ければ少なくてよい（無理に${LIBRARY_MAX_SELECTION}冊へ埋めない）。候補一覧に無い id を作らない。`,
    'book_ids に選んだ id の配列だけを返す。'
  ].join('\n');
}

// ----- parsers / gates (pure) -----

// Gates a fragment/skeleton body: a non-empty string, returned trimmed. Empty output is the model
// producing nothing usable — a structured 503, not a silent empty page.
function gateGeneratedText(text, label) {
  if (typeof text !== 'string' || !text.trim()) throw libraryGenerationError(`library ${label} generation returned empty output`);
  return text.trim();
}

// Parses the title list: one title per line, blank lines dropped, the surviving count must be
// EXACTLY `count`. Fewer or more (the model padded, merged, or added prose) fails fast.
export function parseLibraryTitles(text, count) {
  const normalizedCount = requirePositiveInteger(count, 'titles count');
  if (typeof text !== 'string') throw libraryGenerationError('library title generation returned a non-string');
  const titles = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (titles.length !== normalizedCount) {
    throw libraryGenerationError(`library title generation must return exactly ${normalizedCount} titles: got ${titles.length}`);
  }
  return titles;
}

// The closed-set gate for id selection: `candidate` must be an object carrying a book_ids array of
// distinct ids, each one a member of `candidateIds`, and at most LIBRARY_MAX_SELECTION of them.
// Zero is legitimate (generation-fill covers all 5 slots). A non-array, an unknown id, a duplicate,
// or more than the cap fails fast.
export function validateLibrarySelection(candidate, candidateIds) {
  if (!(candidateIds instanceof Set)) throw new Error('validateLibrarySelection requires a candidateIds Set');
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw libraryGenerationError('library selection result must be an object');
  }
  const ids = candidate.book_ids;
  if (!Array.isArray(ids)) throw libraryGenerationError('library selection book_ids must be an array');
  if (ids.length > LIBRARY_MAX_SELECTION) {
    throw libraryGenerationError(`library selection must choose at most ${LIBRARY_MAX_SELECTION} ids: got ${ids.length}`);
  }
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id) throw libraryGenerationError('library selection book_ids entries must be non-empty strings');
    if (!candidateIds.has(id)) throw libraryGenerationError(`library selection chose an id outside the candidate set: ${id}`);
    if (seen.has(id)) throw libraryGenerationError(`library selection chose a duplicate id: ${id}`);
    seen.add(id);
  }
  return [...ids];
}

// ----- orchestration -----

// Generates one book's fragment body. Returns the gated (trimmed, non-empty) text.
export async function generateLibraryFragmentText({ config, fetchImpl, title, category, skeleton, backbone } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for library fragment generation');
  const prompt = buildLibraryFragmentPrompt({ title, category, skeleton, backbone });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: '大書庫断片本文生成' });
  return gateGeneratedText(text, 'fragment');
}

// Generates `count` titles under `theme`. Returns the parsed list (exactly `count`).
export async function generateLibraryTitles({ config, fetchImpl, theme, count } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for library title generation');
  const prompt = buildLibraryTitlesPrompt({ theme, count });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: '大書庫タイトル生成' });
  return parseLibraryTitles(text, count);
}

// Generates the lazy skeleton for one generated book title. Returns the gated skeleton text.
export async function generateLibrarySkeleton({ config, fetchImpl, title } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for library skeleton generation');
  const prompt = buildLibrarySkeletonPrompt({ title });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: '大書庫骨子生成' });
  return gateGeneratedText(text, 'skeleton');
}

// Selects catalog ids for a theme over the gate-passing candidates. Returns the validated
// closed-set id array (<=5, may be empty).
export async function selectLibraryBookIds({ config, fetchImpl, theme, candidates } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for library selection');
  if (!Array.isArray(candidates)) throw new Error('library selection candidates must be an array');
  const prompt = buildLibrarySelectionPrompt({ theme, candidates });
  const result = await callLmStudioStructuredJson({
    config,
    prompt,
    fetchImpl,
    responseFormat: LIBRARY_SELECTION_RESPONSE_FORMAT,
    title: '大書庫テーマ選定'
  });
  return validateLibrarySelection(result, new Set(candidates.map((candidate) => candidate.id)));
}
