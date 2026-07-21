import { renderParameterScaleForPrompt, renderParametersForPrompt } from '../parameters.mjs';
import { faceExpressionChoicesText } from '../faceExpressions.mjs';
import { renderConversationActorContext } from './conversationActorContext.mjs';

function isCharacterKnown(item) {
  return !item.visibility || item.visibility === 'character_known' || item.visibility === 'public';
}

function bulletList(items, render, emptyLabel = 'なし') {
  const visible = items.filter(isCharacterKnown);
  if (visible.length === 0) return `- ${emptyLabel}`;
  return visible.map((item) => `- ${render(item)}`).join('\n');
}

function renderConversationLine(profile, message) {
  if (message.role === 'assistant') {
    // A group (談話室) transcript carries an explicit per-message speaker name so the shared history renders each
    // NPC under its own name; a 1:1 transcript never carries this field and renders as the single injected
    // profile (byte-for-byte unchanged). Present-but-empty is a malformed group message — fail fast rather than
    // mislabel the line.
    if (Object.hasOwn(message, 'speaker_name')) {
      const speakerName = String(message.speaker_name ?? '').trim();
      if (!speakerName) throw new Error('assistant message speaker_name must be a non-empty string when present');
      return `- ${speakerName}: ${message.content}`;
    }
    return `- ${profile.display_name}: ${message.content}`;
  }
  const speaker = message.role === 'system' ? 'システム' : 'プレイヤー';
  return `- ${speaker}: ${message.content}`;
}

const parameterAttitudeTypes = {
  respect_any_superior: {
    label: 'タイプ1',
    rules: [
      'パラメーター差によって相手を軽蔑しない。',
      '一つでも自分を超えるパラメータを持っていると尊敬する。'
    ]
  },
  equal_any_respect_average: {
    label: 'タイプ2',
    rules: [
      '全てのパラメーターが自分未満である場合は相手を軽蔑する。',
      '一つでも自分を超えるパラメータを持っていると対等に扱う。',
      '平均パラメーターが自分を超えていると尊敬する。'
    ]
  },
  equal_average_respect_1_2: {
    label: 'タイプ3',
    rules: [
      '平均パラメーターが自分以下である場合は相手を軽蔑する。',
      '平均パラメーターが自分を超えていたら対等に扱う。',
      '平均パラメーターが自分の1.2倍を超えていると尊敬する。'
    ]
  },
  equal_1_2_respect_1_5: {
    label: 'タイプ4',
    rules: [
      '平均パラメーターが自分の1.2倍未満である場合は相手を軽蔑する。',
      '平均パラメーターが自分の1.2倍以上なら対等に扱う。',
      '平均パラメーターが自分の1.5倍を超えていると尊敬する。'
    ]
  }
};

const parameterAbilityGuidance = [
  '各パラメーターは、自分や相手の能力・得意不得意を表すものとして扱う。',
  '数値が高いほど、その能力が会話中の判断・態度・行動に自然に表れる。',
  '・プレイヤーの筋力の数値が高ければ高いほど、プレイヤーが肉体的に頑強であるものとして振る舞う。',
  '・自身の学力の数値が高ければ高いほど、自身が教養豊かであるように振る舞う。',
  '・プレイヤーの火魔法習熟度が高ければ高いほど、プレイヤーが火の扱いに慣れているものとして反応する。'
];

function renderParameterAttitudeGuidance(profile) {
  const typeId = profile.parameter_attitude_type ?? 'respect_any_superior';
  const type = parameterAttitudeTypes[typeId] ?? parameterAttitudeTypes.respect_any_superior;

  return [
    `パラメーター差に基づく態度・行動指針:${type.label}`,
    ...type.rules.map((rule) => `・${rule}`),
    ...parameterAbilityGuidance
  ].join('\n');
}

function renderEventContext(eventContext) {
  if (!eventContext || typeof eventContext !== 'object') return null;
  const lines = [
    eventContext.event_label ? `イベント: ${eventContext.event_label}` : null,
    eventContext.opening_context ? `イベント文脈: ${eventContext.opening_context}` : null,
    eventContext.source_work_record_body ? `成立元会話ワークレコード:\n${eventContext.source_work_record_body}` : '成立元会話ワークレコード: まだ作成されていない。'
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

function renderOpeningGuidanceContext(openingGuidanceContext) {
  if (openingGuidanceContext == null) return null;
  if (typeof openingGuidanceContext !== 'string') throw new Error('openingGuidanceContext must be a string');
  const text = openingGuidanceContext.trim();
  if (!text) throw new Error('openingGuidanceContext must not be empty');
  return text;
}

function normalizeSpeechConstraintText(value) {
  return String(value ?? '').trim().replace(/^-+\s*/, '');
}

function renderCharacterSpeechConstraints(characterSpeechConstraints = []) {
  if (!Array.isArray(characterSpeechConstraints)) return null;
  const lines = characterSpeechConstraints
    .map(normalizeSpeechConstraintText)
    .filter(Boolean);
  if (lines.length === 0) return null;
  return `キャラクター発話上の禁止事項:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

function isCreatureProfile(profile) {
  return /^creature_\d{3}$/.test(String(profile?.character_id ?? '').trim());
}

function isHomunculusProfile(profile) {
  return /^homunculus_\d{3}$/.test(String(profile?.character_id ?? '').trim());
}

function requiredCreatureProfileText(profile, fieldName) {
  const value = String(profile?.[fieldName] ?? '').trim();
  if (!value) throw new Error(`creature profile ${fieldName} is required: ${profile?.character_id ?? '(unknown creature)'}`);
  return value;
}

function renderImmersionLine({ profile, scene }) {
  if (isHomunculusProfile(profile)) {
    return `${scene.academy_name}の錬成室で、主人公の手によって灯された存在、${profile.display_name}への完全な没入によって応答する。`;
  }
  if (isCreatureProfile(profile)) {
    const habitat = requiredCreatureProfileText(profile, 'habitat');
    const kindLabel = requiredCreatureProfileText(profile, 'kind_label');
    const role = [habitat, kindLabel].join('にいる');
    return `${scene.academy_name}の外、${role}、${profile.display_name}への完全な没入によって応答する。`;
  }
  const schoolYear = profile.school_year ?? '生徒';
  const club = profile.club ?? '所属未設定';
  return `${scene.academy_name}の${schoolYear}、${club}に所属する${profile.display_name}への完全な没入によって応答する。`;
}

function renderCreaturePromptLines(profile) {
  if (!isCreatureProfile(profile)) return [];
  const kindLabel = requiredCreatureProfileText(profile, 'kind_label');
  const habitat = requiredCreatureProfileText(profile, 'habitat');
  return [
    `種別: ${kindLabel}`,
    `棲み処: ${habitat}`,
    profile.hostility ? `敵対性: ${profile.hostility}` : null,
    '学院所属者としてではなく、山林でまれに会話できる存在として振る舞う。'
  ].filter(Boolean);
}

function renderPromptTailContext(scene) {
  if (!Object.prototype.hasOwnProperty.call(scene ?? {}, 'prompt_tail_context')) return null;
  if (typeof scene.prompt_tail_context !== 'string') throw new Error('scene.prompt_tail_context must be a string');
  const text = scene.prompt_tail_context.trim();
  if (!text) throw new Error('scene.prompt_tail_context must not be empty');
  return text;
}

function insertPromptTailContextAfterWorldSettings(promptPrefix, scene) {
  const promptTailContext = renderPromptTailContext(scene);
  if (!promptTailContext) return promptPrefix;
  if (!scene.world_description) throw new Error('scene.world_description is required when scene.prompt_tail_context is provided');
  const worldSettingsLine = `ワールド設定: ${scene.world_description}`;
  const worldSettingsIndex = promptPrefix.indexOf(worldSettingsLine);
  if (worldSettingsIndex < 0) throw new Error('world settings line is required before scene.prompt_tail_context');
  const insertAt = worldSettingsIndex + worldSettingsLine.length;
  const afterWorldSettings = promptPrefix.slice(insertAt);
  const beforeWorldSettings = promptPrefix.slice(0, insertAt);
  const joinAfterStatus = afterWorldSettings.startsWith('\n') ? afterWorldSettings : `\n${afterWorldSettings}`;
  return `${beforeWorldSettings}\n追加の現在状況:\n${promptTailContext}${joinAfterStatus}`;
}

function insertOpeningGuidanceContext(promptPrefix, openingGuidanceContext) {
  const openingGuidanceText = renderOpeningGuidanceContext(openingGuidanceContext);
  if (!openingGuidanceText) return promptPrefix;
  const memoryBlockMarker = '\n\nこの場で参照する記憶:';
  const insertAt = promptPrefix.indexOf(memoryBlockMarker);
  if (insertAt < 0) throw new Error('memory block is required before openingGuidanceContext');
  return `${promptPrefix.slice(0, insertAt)}\n\nこのオープニングの文脈:\n${openingGuidanceText}${promptPrefix.slice(insertAt)}`;
}

export function buildCharacterPromptPrefix({ profile, scene, memories = [], skills = [], workRecords = [], currentConversation = [], eventContext = null, characterSpeechConstraints = [], conversationActorContext = null }) {
  if (!profile?.display_name) throw new Error('profile.display_name is required');
  if (!scene?.academy_name || !scene?.location_name) throw new Error('scene academy and location are required');

  const memoryEmptyLabel = workRecords.length === 0 ? '初対面' : 'なし';
  const memoryText = bulletList(memories, (memory) => `${memory.text}${memory.work_record_id ? `\n  work_record_id: ${memory.work_record_id}` : ''}${memory.tags?.length ? `\n  tags: ${memory.tags.join(', ')}` : ''}`, memoryEmptyLabel);
  const skillText = bulletList(skills, (skill) => `${skill.name}: ${skill.description}${skill.work_record_id ? `\n  work_record_id: ${skill.work_record_id}` : ''}`);
  const workRecordText = bulletList(workRecords, (record) => `${record.title}\n  ${record.body}${record.tags?.length ? `\n  tags: ${record.tags.join(', ')}` : ''}`);
  const conversationText = currentConversation.length === 0 ? '- なし' : currentConversation.map((message) => renderConversationLine(profile, message)).join('\n');
  const eventContextText = renderEventContext(eventContext);
  const characterParameterText = renderParametersForPrompt(profile.parameters);
  const playerParameterText = renderParametersForPrompt(scene.player_parameters);
  const parameterAttitudeGuidance = renderParameterAttitudeGuidance(profile);
  const characterSpeechConstraintsText = renderCharacterSpeechConstraints(characterSpeechConstraints);
  const conversationActorContextText = renderConversationActorContext(conversationActorContext);
  renderPromptTailContext(scene);

  const sceneLines = [
    scene.world_description ? `ワールド設定: ${scene.world_description}` : null,
    characterSpeechConstraintsText,
    `舞台: ${scene.location_name}`,
    scene.visible_situation ? `見えている状況: ${scene.visible_situation}` : null
  ].filter(Boolean);

  return [
    renderImmersionLine({ profile, scene }),
    '',
    `あなたは${profile.display_name}である。`,
    ...renderCreaturePromptLines(profile),
    profile.prompt_description ? `キャラクター説明（この内容を演技・応答方針として扱う）: ${profile.prompt_description}` : null,
    profile.speaking_basis ? `話し方: ${profile.speaking_basis}` : null,
    '',
    `能力値は${renderParameterScaleForPrompt()}で、大きいほどその能力が高い。`,
    'キャラクター自身のパラメーター:',
    characterParameterText,
    'プレイヤーのパラメーター:',
    playerParameterText,
    '',
    parameterAttitudeGuidance,
    '',
    ...(conversationActorContextText ? [conversationActorContextText, ''] : []),
    ...sceneLines,
    eventContextText ? `このイベントの文脈:\n${eventContextText}` : null,
    '',
    'この場で参照する記憶:',
    memoryText,
    '',
    'この場で使う技能:',
    skillText,
    '',
    'この場で参照する過去の記録:',
    workRecordText,
    '',
    '直前までの会話:',
    conversationText
  ].filter((line) => line !== null).join('\n');
}

export function buildCharacterPrompt({ profile, scene, memories = [], skills = [], workRecords = [], currentConversation = [], eventContext = null, characterSpeechConstraints = [], conversationActorContext = null, openingGuidanceContext = null, playerInput, openingTurn = false, turnType = null, candidateWorkRecordIds = [], generatedAssistantText = '', destinations = [], routingDestination = null, graduationGuideCandidates = [], errandCondition = null, studyCircleCondition = null, giftItemName = null, giftItemDescription = null }) {
  const isOpeningTurn = openingTurn || turnType === 'opening';
  const openingGuidanceText = renderOpeningGuidanceContext(openingGuidanceContext);
  if (openingGuidanceText && !isOpeningTurn) throw new Error('openingGuidanceContext can only be used for opening prompts');
  const isBetweenTurns = turnType === 'work_record_recall'
    || turnType === 'prefix_prewarm'
    || turnType === 'stage_move_agreement_judgment'
    || turnType === 'stage_move_destination_selection'
    || turnType === 'routing_destination_selection'
    || turnType === 'graduation_guide_selection'
    || turnType === 'errand_achievement_judgment'
    || turnType === 'study_circle_achievement_judgment';
  const promptPrefix = buildCharacterPromptPrefix({ profile, scene, memories, skills, workRecords, currentConversation, eventContext, characterSpeechConstraints, conversationActorContext });
  const candidateIdsText = candidateWorkRecordIds.length ? candidateWorkRecordIds.join(', ') : '';
  const candidateIdsJsonExample = candidateWorkRecordIds[0] ? `"${candidateWorkRecordIds[0]}"` : '';
  const stageDestinationTable = destinations.length === 0
    ? '- なし'
    : destinations.map((destination) => `${destination.location_name}: ${destination.location_id}`).join('\n');
  const routingDestinationTable = destinations.length === 0
    ? '- なし'
    : destinations.map((destination) => `${destination.label}: ${destination.id} - ${destination.description}`).join('\n');
  const selectedRoutingDestinationText = routingDestination
    ? `${routingDestination.label}: ${routingDestination.description}`
    : '';
  const graduationGuideCandidateTable = graduationGuideCandidates.length === 0
    ? '- なし'
    : graduationGuideCandidates.map((candidate) => `${candidate.display_name}: ${candidate.character_id}`).join('\n');

  let finalInstruction;
  if (turnType === 'emotion_choice') {
    finalInstruction = `${profile.display_name}として、彼我の能力値を参照した上で、数値と言動が矛盾しないよう注意しつつ、現在の場面に自然に続く感情を次から1つだけ選択する。選択肢: ${faceExpressionChoicesText}。返答本文はまだ書かない。JSONのexpressionだけを返す。`;
  } else if (turnType === 'conversation_continuation_judgment') {
    finalInstruction = `${profile.display_name}として、この発言を行ったプレイヤーとの会話を継続したいと思うか。回答はtrueもしくはfalseのみを返す。継続したい場合はtrue。継続したくない場合はfalse。`;
  } else if (turnType === 'conversation_cutoff_reply') {
    finalInstruction = `${profile.display_name}として、この会話を切り上げる。現在の場面に自然に続く、会話を終了させるための発言だけを書く。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。`;
  } else if (turnType === 'gift_reaction') {
    const itemName = String(giftItemName ?? '').trim();
    if (!itemName) throw new Error('giftItemName is required for gift_reaction');
    const itemDescription = String(giftItemDescription ?? '').trim();
    finalInstruction = [
      `主人公が${profile.display_name}に「${itemName}」を手渡した。`,
      itemDescription ? `渡されたものの様子: ${itemDescription}` : null,
      `${profile.display_name}として、それを受け取ったこの瞬間の反応の発話だけを書く。自分の話し方の口調を保ち、直前までの会話と現在の場面に自然に続けること。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いや仕草には丸括弧をつける。`
    ].filter((line) => line !== null).join('\n');
  } else if (turnType === 'errand_achievement_judgment') {
    const conditionText = String(errandCondition ?? '').trim();
    if (!conditionText) throw new Error('errandCondition is required for errand_achievement_judgment');
    finalInstruction = [
      `${profile.display_name}が持ちかけたこの依頼の達成条件が、ここまでの会話で満たされたかを判定する。`,
      `達成条件: ${conditionText}`,
      '会話の中でこの達成条件が満たされていれば true、まだ満たされていなければ false だけを返す。',
      'true もしくは false 以外は返さない。JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。'
    ].join('\n');
  } else if (turnType === 'errand_wrap_up_reply') {
    finalInstruction = `${profile.display_name}として、依頼の達成条件が満たされたので、この依頼のやり取りを締めくくる。達成を受けて自然に会話を切り上げ、労いや礼を短く述べる発言だけを書く。通常返信の後ろに続く発言として自然にする。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。`;
  } else if (turnType === 'study_circle_achievement_judgment') {
    const conditionText = String(studyCircleCondition ?? '').trim();
    if (!conditionText) throw new Error('studyCircleCondition is required for study_circle_achievement_judgment');
    finalInstruction = [
      `${profile.display_name}が主催するこの研究会の達成条件が、ここまでの会話で満たされたかを判定する。`,
      `達成条件: ${conditionText}`,
      '会話の中でこの達成条件が満たされていれば true、まだ満たされていなければ false だけを返す。',
      'true もしくは false 以外は返さない。JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。'
    ].join('\n');
  } else if (turnType === 'study_circle_wrap_up_reply') {
    finalInstruction = `${profile.display_name}として、研究会の達成条件が満たされたので、この研究会のやり取りを締めくくる。達成を受けて自然に会話を切り上げ、労いや礼を短く述べる発言だけを書く。通常返信の後ろに続く発言として自然にする。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。`;
  } else if (turnType === 'stage_move_agreement_judgment') {
    finalInstruction = `${profile.display_name}として、直近の会話だけを根拠に、主人公と${profile.display_name}の間でこの会話セッション中に別の場所へ一緒に移動する場所移動の合意が形成されたかを判定する。成立していればtrue、成立していなければfalseだけを返す。冗談、曖昧な提案、将来いつか行く話、今いる場所に留まる流れならfalse。`;
  } else if (turnType === 'stage_move_destination_selection') {
    finalInstruction = [
      'ここまでの会話内容を踏まえて移動先となる場所を判定して。',
      '返答は対応表にあるlocation_idを1つだけ返す。',
      '会話内で合意が成立していない、候補が複数あって一意でない、行き先が対応表にない、今いる場所に留まるだけ、冗談や曖昧な提案に留まる場合は none を返す。',
      'JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。',
      '移動可能な移動先の名称とlocation_idの対応表:',
      stageDestinationTable
    ].join('\n');
  } else if (turnType === 'routing_destination_selection') {
    finalInstruction = [
      'ここまでのルーティングハブ会話内容を踏まえて、プレイヤーが次に向かう行き先を判定して。',
      '返答は対応表にあるdestination_idを1つだけ返す。',
      'destination_idを返してよいのは、直近のやり取りでプレイヤー（主人公）がその行き先へ行くことに合意・同意した場合、またはプレイヤー自身がその行き先を選ぶ・行くと明示した場合だけ。',
      '案内人がその行き先を提案・推薦・示唆しただけで、プレイヤーがまだ受け入れていない状態は none を返す。プレイヤーが迷っている、返事を保留している、聞き返している場合も none を返す。',
      '行き先がまだ決まらない、候補が複数あって一意でない、行き先が対応表にない、冗談や曖昧な相談に留まる場合は none を返す。',
      'JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。',
      'ルーティング行き先の名称とdestination_idの対応表:',
      routingDestinationTable
    ].join('\n');
  } else if (turnType === 'graduation_guide_selection') {
    finalInstruction = [
      'ここまでの卒業ガイド会話内容を踏まえて、主人公が学院生活の締めくくりを誰と過ごすと選んだかを判定して。',
      '返答は対応表にあるcharacter_idを1つだけ返す。',
      'character_idを返してよいのは、直近のやり取りで主人公（プレイヤー）がその相手と締めくくると選ぶ・その相手がいいと明示した場合だけ。',
      '案内人がその相手を挙げた・勧めただけで主人公がまだ選んでいない状態、主人公が迷っている・保留している・複数を候補にしている・対応表にない相手を挙げた場合は none を返す。',
      'JSON、Markdownコードブロック、理由、補足、ラベルは出力しない。',
      '締めくくりの相手の名称とcharacter_idの対応表:',
      graduationGuideCandidateTable
    ].join('\n');
  } else if (turnType === 'stage_move_cutoff_reply') {
    finalInstruction = `${profile.display_name}として、今いる場所での会話を短く区切り、移動して場面を移すための発言だけを書く。通常返信の後ろに続く発言として自然にする。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。`;
  } else if (turnType === 'routing_transition_reply') {
    finalInstruction = `${profile.display_name}として、行き先が確定したプレイヤーを送り出す。確定した行き先: ${selectedRoutingDestinationText}。本段では画面遷移・週進行・コンテンツ起動は行わず、行き先への遷移を説明する見送り発話だけを書く。通常返信の後ろに続く発言として自然にする。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いなどには丸括弧をつける。`;
  } else if (turnType === 'work_record_recall') {
    finalInstruction = `${profile.display_name}として、現在の会話の流れから、より詳細化したい"この場で参照する記憶"があれば、それと対応するwork_record_idを次の形式で指定する。出力形式: {"work_record_ids":[${candidateIdsJsonExample}]}。指定できるwork_record_idは候補に含まれるIDだけ。候補work_record_id: ${candidateIdsText}。詳細化したい"この場で参照する記憶"がなければ空配列を返す。`;
  } else if (turnType === 'prefix_prewarm') {
    finalInstruction = `${profile.display_name}として、次のプレイヤー発言に備えて、追加された過去の記録を現在の会話文脈へ軽く接続する短い内部確認を1文だけ出力する。会話本文として表示する返答はまだ書かない。`;
  } else if (turnType === 'graduation_guide_reply') {
    const guideCandidateNames = graduationGuideCandidates.map((candidate) => candidate.display_name).join('、');
    if (!guideCandidateNames) throw new Error('graduationGuideCandidates is required for graduation_guide_reply');
    finalInstruction = [
      `${profile.display_name}として、あなた自身の話し方の口調を保ったまま返答を書く。`,
      'いまは学院生活を締めくくる卒業の局面であり、次の行き先を決める通常の週ではない。鍛錬・ダンジョン・依頼・調合・研究会・闘技会・錬成室・学院マップといった通常の行き先へは案内しない。',
      `代わりに、卒業の締めくくりを誰と過ごすかを主人公に問いかける。締めくくりの相手の候補（${guideCandidateNames}、そして案内人自身の${profile.display_name}）を、この発話の中で名前を挙げて示し、「誰と最後の時を過ごしたいか」を主人公に尋ねて選択を促す。`,
      '主人公がまだ決めかねていても急かさず、通常の行き先の話には戻さない。発話は一度に3〜5文程度にする。発言内容に鉤括弧はつけない。振る舞いや仕草には丸括弧をつける。'
    ].join('\n');
  } else {
    finalInstruction = `${profile.display_name}として、あなた自身の話し方の口調を保ったまま、彼我の能力値と言動が矛盾しないよう注意しつつ、現在の場面に自然に続く返答だけを書く。「見えている状況」は丸ごと説明し直さず、気になった一点にだけ触れて反応する。相手の言葉をそのまま言い換えて返すオウム返しや、説明口調で理屈を並べる受け答えはしない。発話は一度に1〜3文程度にする。発言内容に鉤括弧はつけない。振る舞いや仕草には丸括弧をつける。発話すること自体が不自然な場合は振る舞いなどのみを書く。`;
  }

  const turnLine = turnType === 'stage_move_destination_selection' || turnType === 'routing_destination_selection' || turnType === 'graduation_guide_selection' || turnType === 'errand_achievement_judgment' || turnType === 'study_circle_achievement_judgment'
    ? '以上が会話内容である。'
    : isOpeningTurn
    ? 'プレイヤーはまだ発言していない。現在の場面・記憶だけをもとに、会話開始時の最初の発言を生成する。'
    : isBetweenTurns
      ? 'プレイヤーの次の発言を待っている。'
      : playerInput == null
        ? 'プレイヤーの次の発言を待たず、直前までの会話に自然に続く発話を生成する。'
        : `プレイヤーの発言: ${playerInput}`;
  const promptWithOpeningGuidance = insertOpeningGuidanceContext(promptPrefix, openingGuidanceText);
  const promptWithAdditionalStatus = insertPromptTailContextAfterWorldSettings(promptWithOpeningGuidance, scene);

  return [
    promptWithAdditionalStatus,
    '',
    turnLine,
    turnType === 'conversation_cutoff_reply' || turnType === 'stage_move_cutoff_reply' || turnType === 'routing_transition_reply' || turnType === 'errand_wrap_up_reply' || turnType === 'study_circle_wrap_up_reply' ? `先ほど自分が生成した発言: ${generatedAssistantText}` : null,
    '',
    finalInstruction
  ].filter((line) => line !== null).join('\n');
}
