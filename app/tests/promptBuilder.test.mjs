import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCharacterPrompt, buildCharacterPromptPrefix } from '../src/llm/promptBuilder.mjs';

test('buildCharacterPrompt includes only character-known context and starts with immersion', () => {
  const prompt = buildCharacterPrompt({
    profile: {
      character_id: 'lina',
      display_name: 'リナ・クラウゼ',
      school_year: '2年生',
      club: '薬草学研究会',
      identity: '静かな場所で相手の話を丁寧に聞く、慎重な生徒。',
      speaking_basis: '丁寧で、確認するときは短く区切って話す。'
    },
    scene: {
      academy_name: '星灯魔法学院',
      location_name: '放課後の薬草園',
      visible_situation: '夕方の光が差す薬草園。棚の札と鉢植えが静かに並んでいる。',
      player_name: 'うゆりす'
    },
    memories: [
      { id: 'mem_lina_archive_rumor', visibility: 'character_known', text: 'リナは放課後の薬草園で、棚札の並びを一緒に確認したことを覚えている。', tags: ['薬草園', '棚札'] },
      { id: 'mem_hidden_truth', visibility: 'hidden_story', text: '犯人は教師のオルドである。', tags: ['hidden'] }
    ],
    skills: [{ id: 'herbology_basic', visibility: 'character_known', name: '薬草学基礎', description: '葉や鉢の状態を観察して、手入れの順番を決める。' }],
    workRecords: [
      { id: 'wr_lina_garden_0001', visibility: 'character_known', title: '薬草園での棚札確認', body: 'プレイヤーは棚札の順番を確認した。リナは水やりの記録と照らし合わせた。', tags: ['薬草園', '棚札'] }
    ],
    currentConversation: [
      { role: 'user', content: 'さっきの棚札の話、続きだけど。' },
      { role: 'assistant', content: '水やりの記録と並びが合っていませんでした。' }
    ],
    playerInput: 'この棚札、順番が違うよね？'
  });

  assert.match(prompt, /^星灯魔法学院の2年生、薬草学研究会に所属するリナ・クラウゼへの完全な没入によって応答する。/);
  assert.doesNotMatch(prompt, /人物像:/);
  assert.doesNotMatch(prompt, /人物像: 星羅針盤を読む新入生/);
  assert.match(prompt, /夕方の光が差す薬草園。棚の札と鉢植えが静かに並んでいる。/);
  assert.match(prompt, /リナは放課後の薬草園で、棚札の並びを一緒に確認したことを覚えている。/);
  assert.match(prompt, /薬草学基礎/);
  assert.match(prompt, /薬草園での棚札確認/);
  assert.match(prompt, /直前までの会話:/);
  assert.doesNotMatch(prompt, /プレイヤーの名前:/);
  assert.doesNotMatch(prompt, /うゆりす: さっきの棚札の話、続きだけど。/);
  assert.match(prompt, /プレイヤー: さっきの棚札の話、続きだけど。/);
  assert.match(prompt, /リナ・クラウゼ: 水やりの記録と並びが合っていませんでした。/);
  assert.doesNotMatch(prompt, /うゆりすの発言:/);
  assert.match(prompt, /プレイヤーの発言: この棚札、順番が違うよね？/);
  assert.doesNotMatch(prompt, /犯人は教師のオルド/);
  assert.doesNotMatch(prompt, /hidden_story/);
  assert.doesNotMatch(prompt, /知らない/);
  assert.doesNotMatch(prompt, /do not reveal/i);
  assert.match(prompt.trim().split('\n').at(-1), /発話は一度に1〜3文程度/);
  assert.match(prompt.trim().split('\n').at(-1), /発話すること自体が不自然な場合は振る舞いなどのみを書く。/);
});

test('buildCharacterPrompt renders creature profile fields without academy defaults and fails fast when required fields are missing', () => {
  const baseInput = {
    profile: {
      character_id: 'creature_001',
      display_name: '苔火',
      kind_label: '精霊',
      habitat: '山林の苔むした古祠',
      hostility: 'none',
      identity: '学院には属さない山林の灯火精霊。',
      speaking_basis: '古い灯がまたたくように、短く静かに話す。'
    },
    scene: {
      academy_name: '星灯魔法学院',
      location_name: '苔むした古祠',
      visible_situation: '苔むした石灯籠が淡く光っている。'
    },
    playerInput: 'この祠の灯りは君なの？'
  };

  const prompt = buildCharacterPrompt(baseInput);
  assert.match(prompt, /^星灯魔法学院の外、山林の苔むした古祠にいる精霊、苔火への完全な没入によって応答する。/);
  assert.match(prompt, /種別: 精霊/);
  assert.match(prompt, /棲み処: 山林の苔むした古祠/);
  assert.match(prompt, /学院所属者としてではなく、山林でまれに会話できる存在として振る舞う。/);
  assert.doesNotMatch(prompt, /所属未設定/);
  assert.doesNotMatch(prompt, /生徒/);

  assert.throws(
    () => buildCharacterPrompt({ ...baseInput, profile: { ...baseInput.profile, habitat: '' } }),
    /creature profile habitat is required: creature_001/
  );
  assert.throws(
    () => buildCharacterPrompt({ ...baseInput, profile: { ...baseInput.profile, kind_label: '' } }),
    /creature profile kind_label is required: creature_001/
  );
});

test('buildCharacterPrompt carries creature real parameters and explicit attitude type into the prompt', () => {
  const prompt = buildCharacterPrompt({
    profile: {
      character_id: 'creature_001',
      display_name: '苔火',
      kind_label: '精霊',
      habitat: '山林の苔むした古祠',
      hostility: 'none',
      identity: '学院には属さない山林の灯火精霊。',
      speaking_basis: '古い灯がまたたくように、短く静かに話す。',
      parameter_attitude_type: 'respect_any_superior',
      parameters: {
        magic: { light: 88, dark: 24, fire: 60, water: 30, earth: 70, wind: 18 },
        abilities: { strength: 20, agility: 22, academics: 72, magical_power: 78, charisma: 64 }
      }
    },
    scene: {
      academy_name: '星灯魔法学院',
      location_name: '苔むした古祠',
      visible_situation: '苔むした石灯籠が淡く光っている。'
    },
    playerInput: 'この祠の灯りは君なの？'
  });

  // The creature's real magic/ability values ride the always-on parameter frame,
  // not zero-filled placeholders.
  assert.match(prompt, /キャラクター自身のパラメーター:/);
  assert.match(prompt, /光魔法習熟度: 88\/100/);
  assert.match(prompt, /土魔法習熟度: 70\/100/);
  assert.match(prompt, /学力: 72\/100/);
  assert.match(prompt, /魔力: 78\/100/);
  // The creature's own magic line carries real values, not a zero-filled placeholder.
  assert.match(prompt, /キャラクター自身のパラメーター:\n光魔法習熟度: 88\/100、闇魔法習熟度: 24\/100、火魔法習熟度: 60\/100、水魔法習熟度: 30\/100、土魔法習熟度: 70\/100、風魔法習熟度: 18\/100/);
  // The explicitly-set attitude type drives the guidance (no silent default).
  assert.match(prompt, /パラメーター差に基づく態度・行動指針:タイプ1/);
  assert.match(prompt, /・一つでも自分を超えるパラメータを持っていると尊敬する。/);
});



test('buildCharacterPrompt gives compact parameter-attitude rules without per-call calculations', () => {
  const common = {
    display_name: 'アリア・スターリング',
    school_year: '2年生',
    club: '星読み同好会',
    parameters: {
      magic: { light: 50, dark: 50, fire: 50, water: 50, earth: 50, wind: 50 },
      abilities: { strength: 50, agility: 50, academics: 50, magical_power: 50, charisma: 50 }
    }
  };
  const scene = {
    academy_name: '星灯魔法学院',
    location_name: '演習場',
    player_parameters: {
      magic: { light: 61, dark: 60, fire: 60, water: 60, earth: 60, wind: 60 },
      abilities: { strength: 60, agility: 60, academics: 60, magical_power: 60, charisma: 60 }
    }
  };

  const type2Prompt = buildCharacterPrompt({
    profile: { ...common, parameter_attitude_type: 'equal_any_respect_average' },
    scene,
    playerInput: '一緒に訓練しよう'
  });

  assert.match(type2Prompt, /パラメーター差に基づく態度・行動指針:タイプ2/);
  assert.match(type2Prompt, /・全てのパラメーターが自分未満である場合は相手を軽蔑する。/);
  assert.match(type2Prompt, /・一つでも自分を超えるパラメータを持っていると対等に扱う。/);
  assert.match(type2Prompt, /・平均パラメーターが自分を超えていると尊敬する。/);
  assert.match(type2Prompt, /各パラメーターは、自分や相手の能力・得意不得意を表すものとして扱う。/);
  assert.match(type2Prompt, /数値が高いほど、その能力が会話中の判断・態度・行動に自然に表れる。/);
  assert.match(type2Prompt, /・プレイヤーの筋力の数値が高ければ高いほど、プレイヤーが肉体的に頑強であるものとして振る舞う。/);
  assert.match(type2Prompt, /・自身の学力の数値が高ければ高いほど、自身が教養豊かであるように振る舞う。/);
  assert.match(type2Prompt, /・プレイヤーの火魔法習熟度が高ければ高いほど、プレイヤーが火の扱いに慣れているものとして反応する。/);
  assert(type2Prompt.indexOf('・平均パラメーターが自分を超えていると尊敬する。') < type2Prompt.indexOf('各パラメーターは、自分や相手の能力・得意不得意を表すものとして扱う。'));
  assert.doesNotMatch(type2Prompt, /キャラクター平均:/);
  assert.doesNotMatch(type2Prompt, /プレイヤー平均:/);
  assert.doesNotMatch(type2Prompt, /自分を超えられている項目:/);
  assert.doesNotMatch(type2Prompt, /判定:/);
  assert.doesNotMatch(type2Prompt, /露骨な数値読み上げ/);

  const typePrompts = [
    ['respect_any_superior', /パラメーター差に基づく態度・行動指針:タイプ1/, /・パラメーター差によって相手を軽蔑しない。/, /・一つでも自分を超えるパラメータを持っていると尊敬する。/],
    ['equal_average_respect_1_2', /パラメーター差に基づく態度・行動指針:タイプ3/, /・平均パラメーターが自分以下である場合は相手を軽蔑する。/, /・平均パラメーターが自分を超えていたら対等に扱う。/, /・平均パラメーターが自分の1\.2倍を超えていると尊敬する。/],
    ['equal_1_2_respect_1_5', /パラメーター差に基づく態度・行動指針:タイプ4/, /・平均パラメーターが自分の1\.2倍未満である場合は相手を軽蔑する。/, /・平均パラメーターが自分の1\.2倍以上なら対等に扱う。/, /・平均パラメーターが自分の1\.5倍を超えていると尊敬する。/]
  ];

  for (const [typeId, ...patterns] of typePrompts) {
    const prompt = buildCharacterPrompt({ profile: { ...common, parameter_attitude_type: typeId }, scene, playerInput: '一緒に訓練しよう' });
    for (const pattern of patterns) assert.match(prompt, pattern);
  }
});

test('buildCharacterPrompt can ask for an LLM-generated opening utterance at the moved field stage before player input', () => {
  const prompt = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: { academy_name: '星灯魔法学院', location_name: '旧廊下', visible_situation: '西日の差す廊下に、使われていない掲示板が残っている。' },
    currentConversation: [],
    playerInput: null,
    turnType: 'opening'
  });

  assert.match(prompt, /舞台: 旧廊下/);
  assert.match(prompt, /西日の差す廊下に、使われていない掲示板が残っている。/);
  assert.match(prompt, /プレイヤーはまだ発言していない/);
  assert.match(prompt, /会話開始時の最初の発言を/);
  assert.match(prompt.trim().split('\n').at(-1), /発話は一度に1〜3文程度/);
  assert.match(prompt.trim().split('\n').at(-1), /発話すること自体が不自然な場合は振る舞いなどのみを書く。/);
});

test('buildCharacterPrompt renders actor context after attitude guidance and before scene lines', () => {
  const prompt = buildCharacterPrompt({
    profile: {
      display_name: 'セレナ・ノクターン',
      school_year: '2年生',
      club: '星詠み研究会',
      parameters: {
        magic: { light: 81, dark: 10, fire: 20, water: 30, earth: 40, wind: 50 },
        abilities: { strength: 10, agility: 20, academics: 80, magical_power: 90, charisma: 30 }
      }
    },
    scene: {
      academy_name: '星灯魔法学院',
      world_description: '星と地脈の術理を学ぶ学院。',
      location_name: '星見塔',
      visible_situation: '星図盤と古い望遠鏡が静かに並んでいる。'
    },
    conversationActorContext: {
      sections: [{
        title: '系統知識',
        entries: [{
          title: '光・基礎',
          body: '光魔法の基礎。光は生成・集束・定着の三段で扱う。'
        }]
      }]
    },
    currentConversation: [{ role: 'assistant', content: '星図盤の角度が少し変わっています。' }],
    playerInput: 'この光、何か意味がある？'
  });

  const attitudeIndex = prompt.indexOf('パラメーター差に基づく態度・行動指針:');
  const actorContextIndex = prompt.indexOf('会話相手コンテキスト:');
  const sceneIndex = prompt.indexOf('ワールド設定: 星と地脈の術理を学ぶ学院。');
  const conversationIndex = prompt.indexOf('直前までの会話:');
  const playerInputIndex = prompt.indexOf('プレイヤーの発言: この光、何か意味がある？');

  assert.ok(attitudeIndex >= 0, 'attitude guidance should be present');
  assert.ok(actorContextIndex > attitudeIndex, 'actor context should follow attitude guidance');
  assert.ok(actorContextIndex < sceneIndex, 'actor context should precede scene lines');
  assert.ok(actorContextIndex < conversationIndex, 'actor context should precede conversation history');
  assert.ok(actorContextIndex < playerInputIndex, 'actor context should precede player input');
  assert.match(prompt, /系統知識:\n- 光・基礎:\n光魔法の基礎。光は生成・集束・定着の三段で扱う。/);

  const promptWithoutActorContext = buildCharacterPrompt({
    profile: { display_name: 'セレナ・ノクターン', school_year: '2年生', club: '星詠み研究会' },
    scene: { academy_name: '星灯魔法学院', location_name: '星見塔' },
    playerInput: 'この光、何か意味がある？'
  });
  assert.doesNotMatch(promptWithoutActorContext, /会話相手コンテキスト:/);
});

test('buildCharacterPrompt changes only the final instruction between emotion choice and reply generation for cache reuse', () => {
  const baseInput = {
    profile: {
      character_id: 'serena',
      display_name: 'セレナ・ノクターン',
      school_year: '2年生',
      club: '星詠み研究会',
      identity: '夜空の兆しを静かに読む生徒。'
    },
    scene: {
      academy_name: '星灯魔法学院',
      location_name: '星見塔',
      visible_situation: '星図盤と古い望遠鏡が静かに並んでいる。'
    },
    currentConversation: [{ role: 'assistant', content: '星の角度が少し変わっています。' }],
    playerInput: 'この星図盤、さっきより明るくない？'
  };

  const replyPrompt = buildCharacterPrompt(baseInput);
  const emotionPrompt = buildCharacterPrompt({ ...baseInput, turnType: 'emotion_choice' });
  const replyLines = replyPrompt.trim().split('\n');
  const emotionLines = emotionPrompt.trim().split('\n');

  assert.deepEqual(emotionLines.slice(0, -1), replyLines.slice(0, -1));
  assert.match(replyLines.at(-1), /セレナ・ノクターンとして、あなた自身の話し方の口調を保ったまま、彼我の能力値と言動が矛盾しないよう注意しつつ、現在の場面に自然に続く返答だけを書く。「見えている状況」は丸ごと説明し直さず、気になった一点にだけ触れて反応する。相手の言葉をそのまま言い換えて返すオウム返しや、説明口調で理屈を並べる受け答えはしない。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いや仕草には丸括弧をつける。発話すること自体が不自然な場合は振る舞いなどのみを書く。/);
  assert.match(emotionLines.at(-1), /セレナ・ノクターンとして、彼我の能力値を参照した上で、数値と言動が矛盾しないよう注意しつつ、現在の場面に自然に続く感情を次から1つだけ選択する。/);
  assert.doesNotMatch(emotionLines.at(-1), /発言内容に鉤括弧はつけない/);
  assert.match(emotionLines.at(-1), /neutral, joy, caring, confident, sadness, worried, anger, surprised, embarrassed, shy, serious, determined, panic, tired, sick, smug/);
  assert.match(emotionLines.at(-1), /返答本文はまだ書かない。/);
});

test('buildCharacterPrompt changes only the final instruction between work-record recall and prewarm while waiting between turns', () => {
  const baseInput = {
    profile: {
      display_name: 'セレナ・ノクターン',
      school_year: '2年生',
      club: '星詠み研究会'
    },
    scene: {
      academy_name: '星灯魔法学院',
      location_name: '星見塔',
      visible_situation: '星図盤と古い望遠鏡が静かに並んでいる。'
    },
    memories: [{ visibility: 'character_known', text: 'セレナは主人公が星図盤の古い傷に気づいたことを覚えている。', work_record_id: 'wr_star_dial' }],
    currentConversation: [
      { role: 'user', content: '星図盤の傷、前にも見た気がする。' },
      { role: 'assistant', content: '……その傷なら、私も少し引っかかっています。' }
    ],
    playerInput: null
  };

  const recallPrompt = buildCharacterPrompt({ ...baseInput, turnType: 'work_record_recall', candidateWorkRecordIds: ['wr_star_dial'] });
  const prewarmPrompt = buildCharacterPrompt({ ...baseInput, turnType: 'prefix_prewarm' });
  const recallLines = recallPrompt.trim().split('\n');
  const prewarmLines = prewarmPrompt.trim().split('\n');

  assert.deepEqual(recallLines.slice(0, -1), prewarmLines.slice(0, -1));
  assert.match(recallPrompt, /プレイヤーの次の発言を待っている。/);
  assert.match(recallLines.at(-1), /より詳細化したい"この場で参照する記憶"があれば/);
  assert.match(recallLines.at(-1), /それと対応するwork_record_idを次の形式で指定する/);
  assert.match(recallLines.at(-1), /出力形式: \{"work_record_ids":\["wr_star_dial"\]\}/);
  assert.match(recallLines.at(-1), /指定できるwork_record_idは候補に含まれるIDだけ/);
  assert.match(recallLines.at(-1), /候補work_record_id: wr_star_dial/);
  assert.match(recallLines.at(-1), /詳細化したい"この場で参照する記憶"がなければ空配列を返す。/);
  assert.match(prewarmLines.at(-1), /次のプレイヤー発言に備えて/);
});

test('buildCharacterPrompt inserts conversation continuation judgment and cutoff prompts after the same dialogue prefix', () => {
  const baseInput = {
    profile: {
      display_name: 'セラ・アストルーペ',
      school_year: '2年生',
      club: '星詠み研究会'
    },
    scene: {
      academy_name: '星灯魔法学院',
      location_name: '保健室',
      visible_situation: '白いカーテンと薬瓶が並ぶ学院の保健室。'
    },
    currentConversation: [
      { role: 'assistant', content: '少し休んでから話しましょう。' }
    ],
    playerInput: 'もう少しだけ聞いてもいい？'
  };

  const replyPrompt = buildCharacterPrompt(baseInput);
  const judgmentPrompt = buildCharacterPrompt({ ...baseInput, turnType: 'conversation_continuation_judgment' });
  const cutoffPrompt = buildCharacterPrompt({
    ...baseInput,
    turnType: 'conversation_cutoff_reply',
    generatedAssistantText: '……はい。短くなら、続けられます。'
  });
  const replyLines = replyPrompt.trim().split('\n');
  const judgmentLines = judgmentPrompt.trim().split('\n');
  const cutoffLines = cutoffPrompt.trim().split('\n');

  assert.deepEqual(judgmentLines.slice(0, -1), replyLines.slice(0, -1));
  assert.match(judgmentLines.at(-1), /セラ・アストルーペとして、この発言を行ったプレイヤーとの会話を継続したいと思うか。/);
  assert.match(judgmentLines.at(-1), /回答はtrueもしくはfalseのみを返す。/);
  assert.match(judgmentLines.at(-1), /継続したい場合はtrue。継続したくない場合はfalse。/);
  const commonPrefixThroughPlayerLine = replyLines.slice(0, -2);
  assert.deepEqual(cutoffLines.slice(0, commonPrefixThroughPlayerLine.length), commonPrefixThroughPlayerLine);
  assert.equal(cutoffLines[commonPrefixThroughPlayerLine.length], '先ほど自分が生成した発言: ……はい。短くなら、続けられます。');
  assert.match(cutoffPrompt, /先ほど自分が生成した発言: ……はい。短くなら、続けられます。/);
  assert.match(cutoffLines.at(-1), /セラ・アストルーペとして、この会話を切り上げる。/);
  assert.match(cutoffLines.at(-1), /現在の場面に自然に続く、会話を終了させるための発言だけを書く。/);
  assert.match(cutoffLines.at(-1), /発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。/);
});

test('buildCharacterPrompt marks empty character memory as first meeting instead of none', () => {
  const prompt = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: { academy_name: '星灯魔法学院', location_name: '放課後の薬草園' },
    memories: [],
    playerInput: 'はじめまして'
  });

  assert.match(prompt, /この場で参照する記憶:\n- 初対面/);
  assert.doesNotMatch(prompt, /この場で参照する記憶:\n- なし/);
});

test('buildCharacterPrompt does not mark empty prompt memory as first meeting when work records exist', () => {
  const prompt = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: { academy_name: '星灯魔法学院', location_name: '放課後の薬草園' },
    memories: [],
    workRecords: [{ id: 'wr_conv_first_001', title: '初回会話の記録', body: '主人公と一度話した記録。' }],
    playerInput: '続きから話そう'
  });

  assert.match(prompt, /この場で参照する記憶:\n- なし/);
  assert.doesNotMatch(prompt, /この場で参照する記憶:\n- 初対面/);
  assert.match(prompt, /この場で参照する過去の記録:\n- 初回会話の記録/);
});

test('buildCharacterPrompt treats no character-known memory as first meeting', () => {
  const prompt = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: { academy_name: '星灯魔法学院', location_name: '放課後の薬草園' },
    memories: [{ visibility: 'hidden_story', text: 'リナはまだ知り得ない秘密。' }],
    playerInput: 'はじめまして'
  });

  assert.match(prompt, /この場で参照する記憶:\n- 初対面/);
  assert.doesNotMatch(prompt, /リナはまだ知り得ない秘密。/);
});

test('buildCharacterPrompt does not include every old work record when none are selected for the current call', () => {
  const prompt = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: { academy_name: '星灯魔法学院', location_name: '放課後の薬草園' },
    workRecords: [],
    currentConversation: [{ role: 'assistant', content: '会話はここから続けられる。' }],
    playerInput: '続きから話そう'
  });

  assert.match(prompt, /この場で参照する過去の記録:\n- なし/);
  assert.match(prompt, /リナ・クラウゼ: 会話はここから続けられる。/);
});


test('buildCharacterPrompt renders character speech constraints after world settings without leaking model metadata', () => {
  const prompt = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: {
      academy_name: '星灯魔法学院',
      world_description: '学院には地脈と星明かりを使う授業がある。',
      location_name: '天文塔'
    },
    characterSpeechConstraints: [
      '「最高」という単語は禁忌である。なぜなら、それは陳腐な表現だからだ。',
      '自らの肩書きは決して自分で名乗ってはいけない。'
    ],
    playerInput: '星図を見よう'
  });

  const worldIndex = prompt.indexOf('ワールド設定: 学院には地脈と星明かりを使う授業がある。');
  const constraintsIndex = prompt.indexOf('キャラクター発話上の禁止事項:');
  const stageIndex = prompt.indexOf('舞台: 天文塔');
  assert.ok(worldIndex >= 0, 'world settings should remain present');
  assert.ok(constraintsIndex > worldIndex, 'speech constraints should be placed after world settings');
  assert.ok(stageIndex > constraintsIndex, 'speech constraints should be placed before the stage');
  assert.match(prompt, /キャラクター発話上の禁止事項:\n- 「最高」という単語は禁忌である。/);
  assert.match(prompt, /- 自らの肩書きは決して自分で名乗ってはいけない。/);
  assert.doesNotMatch(prompt, /Gemma4|LLM固有|モデル固有|このモデル|モデルの癖|profile_id|match_models|chat_model|reflection_model|provider/);

  const promptWithoutConstraints = buildCharacterPrompt({
    profile: { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' },
    scene: { academy_name: '星灯魔法学院', world_description: '学院設定のみ。', location_name: '天文塔' },
    playerInput: '星図を見よう'
  });
  assert.doesNotMatch(promptWithoutConstraints, /キャラクター発話上の禁止事項/);
});

test('additional status context renders directly after world settings and preserves the stable prefix boundary', () => {
  const profile = { display_name: 'リナ・クラウゼ', school_year: '2年生', club: '薬草学研究会' };
  const scene = {
    academy_name: '星灯魔法学院',
    world_description: '星明かりと地脈を学ぶ学院。',
    location_name: '放課後の薬草園',
    visible_situation: '夕方の光が差す薬草園。棚の札と鉢植えが静かに並んでいる。'
  };
  const currentConversation = [{ role: 'assistant', content: '棚札の並びを確認しましょう。' }];
  const common = { profile, currentConversation, playerInput: 'この棚札、順番が違うよね？' };
  const additionalStatus = [
    '- 階層: 第2層 / 全5層',
    '- 主人公: HP 5/96, MP 3/48',
    '- 同行者 リナ・クラウゼ: HP 7/88, MP 4/42',
    '- 近くの敵: 石塊ゴーレム HP 40/80 距離1',
    '- 近くのアイテム: 癒し草 距離1',
    '- 直近ログ: なし'
  ].join('\n');

  // The academy turn carries no additional status block at all.
  const academyPrompt = buildCharacterPrompt({ ...common, scene });
  assert.doesNotMatch(academyPrompt, /追加の現在状況:/);
  assert.doesNotMatch(academyPrompt, /近くの敵:/);

  const dungeonPrompt = buildCharacterPrompt({ ...common, scene: { ...scene, prompt_tail_context: additionalStatus } });
  const sharedPrefix = buildCharacterPromptPrefix({ profile, scene, currentConversation });
  const sharedPrefixWithStatusScene = buildCharacterPromptPrefix({
    profile,
    scene: { ...scene, prompt_tail_context: additionalStatus },
    currentConversation
  });
  assert.equal(sharedPrefixWithStatusScene, sharedPrefix, 'prefix builder remains stable and excludes additional status');
  assert.doesNotMatch(sharedPrefixWithStatusScene, /追加の現在状況:/);
  assert.doesNotMatch(sharedPrefixWithStatusScene, /近くの敵:/);
  const worldLine = 'ワールド設定: 星明かりと地脈を学ぶ学院。';
  const worldIndex = dungeonPrompt.indexOf(worldLine);
  const statusIndex = dungeonPrompt.indexOf('追加の現在状況:');
  const stageIndex = dungeonPrompt.indexOf('舞台: 放課後の薬草園');
  const playerInputIndex = dungeonPrompt.indexOf('プレイヤーの発言: この棚札、順番が違うよね？');
  assert.ok(worldIndex >= 0, 'world settings remain present');
  assert.ok(statusIndex > worldIndex, 'additional status sits after world settings');
  assert.ok(statusIndex < stageIndex, 'additional status sits before the stage line');
  assert.ok(statusIndex < playerInputIndex, 'additional status is no longer appended near the turn tail');

  // KV-cache reuse stops at the per-turn status block. The stable prompt bytes
  // before that variable block remain identical between academy and dungeon prompts,
  // while buildCharacterPromptPrefix itself stays free of the variable block.
  const stablePrefixEnd = worldIndex + worldLine.length;
  assert.equal(dungeonPrompt.slice(0, stablePrefixEnd), academyPrompt.slice(0, stablePrefixEnd));

  // The two prompts are byte-identical except for the injected status block: removing
  // it from the dungeon prompt reproduces the academy prompt exactly.
  assert.equal(dungeonPrompt.replace(`追加の現在状況:\n${additionalStatus}\n`, ''), academyPrompt);
});
