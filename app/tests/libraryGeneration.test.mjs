import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIBRARY_BACKBONE_BLOCK,
  LIBRARY_GENERATED_CATEGORY,
  LIBRARY_MAX_SELECTION,
  buildLibraryFragmentPrompt,
  buildLibrarySelectionPrompt,
  buildLibrarySkeletonPrompt,
  buildLibraryTitlesPrompt,
  generateLibraryFragmentText,
  generateLibrarySkeleton,
  generateLibraryTitles,
  parseLibraryTitles,
  selectLibraryBookIds,
  validateLibrarySelection
} from '../src/llm/libraryGeneration.mjs';

const CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'test-model', timeout_ms: 5000 };

// A fetchImpl that replies with one OpenAI-compatible completion whose message content is `content`.
// Records every request so a test can assert the requested schema / prompt. config.stream is unset,
// so callLmStudioChat / callLmStudioStructuredJson both take the non-stream JSON path.
function completionFetch(content, calls) {
  return async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
}

// ----- fragment prompt (reqD author-voice) -----

test('buildLibraryFragmentPrompt (periphery, no backbone) uses the reqD author-voice template and the 書名/分類 骨子 block', () => {
  const prompt = buildLibraryFragmentPrompt({
    title: '月光苔の観察記',
    category: '動植物誌',
    skeleton: '夜に淡く光る苔を季節を追って書き留めた観察帖。',
    backbone: false
  });
  // author-voice reframe (書き手 / direct narration), not the old 書き写している copyist voice
  assert.match(prompt, /あなたは魔法学院の大書庫に収められた一冊の本の書き手である。いまその本の一節として、頁に記される本文そのものを書く。/);
  assert.match(prompt, /事典や随筆のように直接語る本文を書く。/);
  // strong anti-meta: the digest verbs are named as forbidden and direct narration is demanded
  assert.match(prompt, /「〜が描き出されている」「〜が綴られている」「〜に紙幅が割かれている」「〜が並べられている」「本書は〜を説く」/);
  assert.match(prompt, /その本が何を扱うかを外側から述べる書き方を一切しない/);
  assert.match(prompt, /主題となる事物そのものを、あなた自身が直接に叙述する/);
  // creation permitted, with the 現代語・外来語 ban, and the softer 余談 inducement
  assert.match(prompt, /自由に補って創作してよい/);
  assert.match(prompt, /現代語・外来語/);
  assert.match(prompt, /脇道の逸話・余談まで、書き手が筆を滑らせるように書き添えてよい/);
  // one-line canon-guard present in every book
  assert.match(prompt, /世界の背骨（役目を終えた星が砕けて残光となり地脈に沁みる／魔法は残光を借りて返す技術／学院はその番所）と食い違う断定はしない/);
  // length, quote ban, no title restate
  assert.match(prompt, /長さは300〜400字程度。/);
  assert.match(prompt, /会話文や引用符で囲ったセリフ、口調の再現は書かない/);
  assert.match(prompt, /前置きや説明、題名の再掲はせず、本文だけを書く。/);
  // the 骨子 block prefixes 書名/分類 before the authored skeleton
  assert.match(prompt, /【骨子】\n書名『月光苔の観察記』／分類: 動植物誌。\n夜に淡く光る苔/);
  // the old forbidden-creation clause and title-frame anti-meta and copyist voice are gone
  assert.equal(prompt.includes('骨子に無い固有名詞・数値・断定的な事実を新たに作らない'), false);
  assert.equal(prompt.includes('本の「中身」の文章そのものを書く'), false);
  assert.equal(prompt.includes('書き写している'), false);
  // backbone false: no backbone block, no full-backbone bullet
  assert.equal(prompt.includes(LIBRARY_BACKBONE_BLOCK), false);
  assert.equal(prompt.includes('世界の背骨と矛盾しない範囲で書き'), false);
});

test('buildLibraryFragmentPrompt (backbone true) prepends the backbone block and adds the 講義しない bullet', () => {
  const prompt = buildLibraryFragmentPrompt({
    title: '星降りの晩の散歩',
    category: '随筆・紀行',
    skeleton: '星が降る晩に外を歩いた随想。',
    backbone: true
  });
  assert.ok(prompt.startsWith(LIBRARY_BACKBONE_BLOCK), 'backbone block is prepended at the very top');
  assert.match(prompt, /- 世界の背骨と矛盾しない範囲で書き、背骨そのものを講義的に説明はしない。/);
  // still the same reqD author-voice body
  assert.match(prompt, /あなたは魔法学院の大書庫に収められた一冊の本の書き手である。/);
  assert.match(prompt, /主題となる事物そのものを、あなた自身が直接に叙述する/);
});

test('buildLibraryFragmentPrompt validates its inputs', () => {
  assert.throws(() => buildLibraryFragmentPrompt({ title: '', category: 'c', skeleton: 's', backbone: false }), /fragment title/);
  assert.throws(() => buildLibraryFragmentPrompt({ title: 't', category: 'c', skeleton: 's', backbone: 'no' }), /backbone must be a boolean/);
});

// ----- title prompt (T3, theme-bound) -----

test('buildLibraryTitlesPrompt binds every title to the theme, adds a world anchor, and drops the backbone block + 雰囲気 hedge', () => {
  const prompt = buildLibraryTitlesPrompt({ theme: '薬草', count: 4 });
  // theme as the subject, with the fidelity demand
  assert.match(prompt, /次のテーマ『薬草』を主題とする本のタイトルを4つ考える。/);
  assert.match(prompt, /テーマ『薬草』を扱う本だと読み手が一目でわかるようにする。テーマから離れた題は出さない。/);
  // one-line world anchor naming the generic-isekai words as forbidden
  assert.match(prompt, /「元素」「精霊」「宮廷」などこの世界にそぐわない一般的な異世界語や、実在の地名・人名・現代語・器具名は使わない。/);
  assert.match(prompt, /テーマ語を無理に背骨の語（残光・地脈など）と接ぎ木しなくてよい。/);
  assert.match(prompt, /タイトルだけを1行ずつ、4つ挙げる。/);
  // the backbone block and the fidelity-killing 雰囲気-first hedge are gone
  assert.equal(prompt.includes(LIBRARY_BACKBONE_BLOCK), false);
  assert.equal(prompt.includes('雰囲気を主とし'), false);
});

test('buildLibraryTitlesPrompt validates its inputs', () => {
  assert.throws(() => buildLibraryTitlesPrompt({ theme: '', count: 2 }), /titles theme/);
  assert.throws(() => buildLibraryTitlesPrompt({ theme: '薬草', count: 0 }), /titles count/);
});

// ----- skeleton prompt (D) -----

test('buildLibrarySkeletonPrompt asks for a loose sketch with no backbone leak', () => {
  const prompt = buildLibrarySkeletonPrompt({ title: '霧が晴れない朝に' });
  assert.match(prompt, /緩いスケッチである。/);
  assert.match(prompt, /2〜3行の短いスケッチにする。/);
  assert.match(prompt, /書名『霧が晴れない朝に』／分類: 生成写本。$/);
  assert.equal(prompt.includes(LIBRARY_BACKBONE_BLOCK), false);
  assert.equal(LIBRARY_GENERATED_CATEGORY, '生成写本');
});

// ----- selection prompt (E) -----

test('buildLibrarySelectionPrompt lists the candidates and states the closed-set cap', () => {
  const prompt = buildLibrarySelectionPrompt({
    theme: '星と夜',
    candidates: [
      { id: 'periphery_essay_01', title: '星降りの晩の散歩', category: '随筆・紀行' },
      { id: 'core_starfall_principle', title: '星降りの理', category: '世界の理' }
    ]
  });
  assert.match(prompt, /テーマ: 星と夜/);
  assert.match(prompt, /- periphery_essay_01 ／ 星降りの晩の散歩 ／ 随筆・紀行/);
  assert.match(prompt, /- core_starfall_principle ／ 星降りの理 ／ 世界の理/);
  assert.match(prompt, /最大5冊/);
  assert.match(prompt, /候補一覧に無い id を作らない。/);
});

// ----- parseLibraryTitles -----

test('parseLibraryTitles keeps one title per line and drops blank lines', () => {
  assert.deepEqual(parseLibraryTitles('月霜の沈黙\n\n残光の凪に寄せて\n星葬の静寂について\n', 3), [
    '月霜の沈黙',
    '残光の凪に寄せて',
    '星葬の静寂について'
  ]);
});

test('parseLibraryTitles fails fast (503) on a wrong count', () => {
  const tooFew = () => parseLibraryTitles('一冊だけ', 3);
  assert.throws(tooFew, /exactly 3 titles: got 1/);
  try {
    tooFew();
  } catch (error) {
    assert.equal(error.statusCode, 503);
    assert.equal(error.errorCode, 'LIBRARY_GENERATION_FAILED');
  }
  assert.throws(() => parseLibraryTitles('a\nb\nc\nd', 3), /exactly 3 titles: got 4/);
});

// ----- validateLibrarySelection (closed set) -----

test('validateLibrarySelection accepts a distinct subset of the candidate ids', () => {
  const candidateIds = new Set(['a', 'b', 'c']);
  assert.deepEqual(validateLibrarySelection({ book_ids: ['b', 'a'] }, candidateIds), ['b', 'a']);
  assert.deepEqual(validateLibrarySelection({ book_ids: [] }, candidateIds), []);
});

test('validateLibrarySelection rejects unknown / duplicate / over-cap / non-array (503)', () => {
  const candidateIds = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.throws(() => validateLibrarySelection({ book_ids: ['z'] }, new Set(['a'])), /outside the candidate set: z/);
  assert.throws(() => validateLibrarySelection({ book_ids: ['a', 'a'] }, new Set(['a'])), /duplicate id: a/);
  assert.throws(
    () => validateLibrarySelection({ book_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }, candidateIds),
    new RegExp(`at most ${LIBRARY_MAX_SELECTION} ids: got 6`)
  );
  assert.throws(() => validateLibrarySelection({ book_ids: 'a' }, new Set(['a'])), /book_ids must be an array/);
  try {
    validateLibrarySelection({ book_ids: ['z'] }, new Set(['a']));
  } catch (error) {
    assert.equal(error.statusCode, 503);
  }
});

// ----- orchestration (injected fetch) -----

test('generateLibraryFragmentText returns the trimmed body and throws 503 on empty output', async () => {
  const calls = [];
  const text = await generateLibraryFragmentText({
    config: CONFIG,
    fetchImpl: completionFetch('  夜の帳が降りた石壁に苔が息づいている。  ', calls),
    title: '月光苔の観察記',
    category: '動植物誌',
    skeleton: '苔の観察帖。',
    backbone: false
  });
  assert.equal(text, '夜の帳が降りた石壁に苔が息づいている。');
  assert.equal(calls.length, 1);
  // chat 経路: single user message, no response_format
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[0].messages[0].role, 'user');
  assert.equal(calls[0].response_format, undefined);

  await assert.rejects(
    () => generateLibraryFragmentText({
      config: CONFIG,
      fetchImpl: completionFetch('   ', []),
      title: 't',
      category: 'c',
      skeleton: 's',
      backbone: false
    }),
    (error) => error.statusCode === 503 && /empty output/.test(error.message)
  );
});

test('generateLibraryTitles parses exactly count titles and threads the theme-bound T3 prompt', async () => {
  const calls = [];
  const titles = await generateLibraryTitles({
    config: CONFIG,
    fetchImpl: completionFetch('月霜の沈黙\n残光の凪に寄せて', calls),
    theme: '夜',
    count: 2
  });
  assert.deepEqual(titles, ['月霜の沈黙', '残光の凪に寄せて']);
  // the T3 fidelity instruction reached the model
  assert.match(calls[0].messages[0].content, /テーマ『夜』を扱う本だと読み手が一目でわかる/);
});

test('generateLibrarySkeleton returns the trimmed sketch', async () => {
  const skeleton = await generateLibrarySkeleton({
    config: CONFIG,
    fetchImpl: completionFetch('物憂げな散策記。眼差しは穏やか。\n', []),
    title: '霧が晴れない朝に'
  });
  assert.equal(skeleton, '物憂げな散策記。眼差しは穏やか。');
});

test('selectLibraryBookIds validates the structured response against the candidate set', async () => {
  const calls = [];
  const candidates = [
    { id: 'periphery_essay_01', title: '星降りの晩の散歩', category: '随筆・紀行' },
    { id: 'core_starfall_principle', title: '星降りの理', category: '世界の理' }
  ];
  const ids = await selectLibraryBookIds({
    config: CONFIG,
    fetchImpl: completionFetch(JSON.stringify({ book_ids: ['periphery_essay_01'] }), calls),
    theme: '星',
    candidates
  });
  assert.deepEqual(ids, ['periphery_essay_01']);
  // selection is the structured_json surface
  assert.equal(calls[0].response_format.json_schema.name, 'library_book_selection');

  await assert.rejects(
    () => selectLibraryBookIds({
      config: CONFIG,
      fetchImpl: completionFetch(JSON.stringify({ book_ids: ['not_a_candidate'] }), []),
      theme: '星',
      candidates
    }),
    (error) => error.statusCode === 503 && /outside the candidate set/.test(error.message)
  );
});
