import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUCTION_MASTER,
  AUCTION_WORLD_GUARD,
  AUCTION_BID_TURN_RESPONSE_FORMAT,
  AUCTION_MASTER_SPEECH_HARD_CAP,
  auctionLotPresentation,
  buildMasterOpeningPrompt,
  buildMasterGoadPrompt,
  buildMasterHammerPrompt,
  buildReactionPrompt,
  buildNpcBidPrompt,
  buildAuctionBeingPersonaPrompt,
  buildAuctionEquipmentNamingPrompt,
  gateMasterSpeech,
  gateReaction,
  validateAuctionBidCandidate,
  resolveAuctionBidDecision
} from '../src/llm/auctionGeneration.mjs';
import { renderConversationActorContext, AFFINITY_CONTEXT_SCALE } from '../src/llm/conversationActorContext.mjs';

// The shared 書き方の縛り / 世界整合ガード phrasing is benchmark-confirmed; these substring anchors are the
// prompt-contract guard. A wording change (which must go back to Lead) breaks them on purpose.
const FORBIDDEN_NARRATION_NAMING = '紹介記事調で書かない';
const FORBIDDEN_NARRATION_EXAMPLE = '「〜という品である」';

const WEAPON_LOT = {
  item: { item_id: 'auction_wa_02', category: 'weapon_amulet', name: '逸品の剣', weapon_kind: 'sword', band: 'A' },
  band: 'A',
  initial_price: 6000,
  min_increment: 300
};
const BEING_ITEM = { item_id: 'auction_being_01', category: 'being', name: 'スピカ', species: 'homunculus', face_id: 'ab_001', band: 'S', temperament_seed: '礼儀正しく几帳面。数字と約束を守る' };
const TREASURE_ITEM = { item_id: 'auction_item_01', category: 'treasure', name: '星降りの夜の蒸留酒', description: '贈り物・好感度 +15', band: 'A', effect: { category: 'gift', affinity_bonus: 15 } };
const FLAVOR_ITEM = { item_id: 'auction_flavor_01', category: 'flavor', name: '初代競売人の木槌', band: 'A', appeal_seed: '百年鳴り続けたと言われる槌' };

const BIDDER = {
  display_name: 'レオナ',
  school_year: '3年',
  identity: '剣術部の主将',
  prompt_description: '強気で負けず嫌い。良いものには惜しまず金を出す',
  speaking_basis: 'ぶっきらぼうで語尾が強い'
};

// The 通常会話コンテクスト同期 inputs. The speech-constraints lines and the 会話相手コンテキスト snapshot are the
// data the shared resolvers/renderers produce — the prompt injects them, it does not re-author their wording.
const WORLD_DESCRIPTION = '星灯魔法学院は、星明かりを魔力へ変換する塔を中心にした全寮制の魔法学院。お金の単位はG。';
const SPEECH_CONSTRAINTS = ['手垢のついた賛辞（「白眉」等）を使わない', 'その言い換えも避ける'];
const ACTOR_CONTEXT = {
  sections: [
    { title: '系統知識', entries: [{ title: '光・基礎', body: '光魔法の基礎。光は生成・集束・定着の三段で扱う。' }] },
    { title: '好感度', entries: [{ title: '主人公への好感度', body: `主人公への好感度: 90/100（${AFFINITY_CONTEXT_SCALE}）` }] }
  ]
};

// ----- presentation -----

test('auctionLotPresentation derives a clean blurb for every category', () => {
  assert.deepEqual(auctionLotPresentation(WEAPON_LOT.item), { name: '逸品の剣', category_label: '武器', blurb: '名うての逸品と名高い剣' });
  assert.deepEqual(auctionLotPresentation({ ...WEAPON_LOT.item, weapon_kind: 'amulet' }).category_label, '護符');
  assert.deepEqual(auctionLotPresentation(TREASURE_ITEM), { name: '星降りの夜の蒸留酒', category_label: '調合の逸品', blurb: '人に贈るための珍品' });
  assert.deepEqual(auctionLotPresentation(FLAVOR_ITEM), { name: '初代競売人の木槌', category_label: '愛玩の品', blurb: '百年鳴り続けたと言われる槌' });
  assert.deepEqual(auctionLotPresentation(BEING_ITEM), { name: 'スピカ', category_label: 'ホムンクルス', blurb: '礼儀正しく几帳面。数字と約束を守る' });
});

// ----- master opening (1a) -----

test('buildMasterOpeningPrompt carries the 本人 reframe, the fixed 縛りブロック, the 確定情報, and the 字数', () => {
  const prompt = buildMasterOpeningPrompt({ lot: WEAPON_LOT });
  assert.match(prompt, new RegExp(`司会者、${AUCTION_MASTER.name}本人である`));
  assert.ok(prompt.includes(AUCTION_MASTER.basis));
  // 禁止話法の名指し節 (load-bearing per 実測 M2).
  assert.ok(prompt.includes(FORBIDDEN_NARRATION_NAMING));
  assert.ok(prompt.includes(FORBIDDEN_NARRATION_EXAMPLE));
  // 確定情報 woven from the presentation + system economics.
  assert.match(prompt, /品名: 逸品の剣/);
  assert.match(prompt, /分類: 武器/);
  assert.match(prompt, /触れ込み: 名うての逸品と名高い剣/);
  assert.match(prompt, /開始値: 6000G/);
  assert.match(prompt, /最低つり上げ幅: 300G/);
  assert.match(prompt, /長さは140〜200字くらい。/);
});

// ----- master goad (1b) / hammer (1c) -----

test('buildMasterGoadPrompt weaves the current 最高値 / 入札者 / 増分 and asks for a 40〜80字 goad', () => {
  const prompt = buildMasterGoadPrompt({ lot: WEAPON_LOT, current: 6300, bidderName: 'レオナ' });
  assert.match(prompt, /ただいまの最高値: 6300G（レオナ）/);
  assert.match(prompt, /最低つり上げ幅: 300G/);
  assert.match(prompt, /場をさらに煽って次の入札を促す/);
  assert.match(prompt, /長さは40〜80字くらい。/);
  assert.ok(prompt.includes(FORBIDDEN_NARRATION_NAMING));
});

test('buildMasterHammerPrompt weaves the 落札額 / 落札者 and asks for a 40〜80字 declaration', () => {
  const prompt = buildMasterHammerPrompt({ lot: WEAPON_LOT, price: 7200, winnerName: 'お客人' });
  assert.match(prompt, /落札額: 7200G/);
  assert.match(prompt, /落札者: お客人/);
  assert.match(prompt, /槌を鳴らし、落札を宣言する/);
  assert.match(prompt, /長さは40〜80字くらい。/);
});

// ----- reaction (2) -----

test('buildReactionPrompt carries the persona prefix, the 品披露, the reaction 指示, and the 世界整合ガード', () => {
  const prompt = buildReactionPrompt({ bidder: BIDDER, lot: WEAPON_LOT });
  assert.match(prompt, /あなたはレオナである。宵の競売会場に客として居合わせている。/);
  assert.match(prompt, /立場: 3年・剣術部の主将/);
  assert.match(prompt, /人物像（演技・応答方針として扱う）: 強気で負けず嫌い/);
  assert.match(prompt, /話し方: ぶっきらぼうで語尾が強い/);
  assert.match(prompt, /品名: 逸品の剣／分類: 武器/);
  assert.match(prompt, /気になった一点にだけ触れて反応する/);
  assert.ok(prompt.includes(AUCTION_WORLD_GUARD));
  // No 数珠つなぎ block when there are no prior reactions.
  assert.doesNotMatch(prompt, /他の客のこれまでの反応:/);
});

test('buildReactionPrompt threads prior reactions (数珠つなぎ) and adds the "軽く反応してよいが丸ごとなぞらない" instruction', () => {
  const prompt = buildReactionPrompt({
    bidder: BIDDER,
    lot: WEAPON_LOT,
    priorReactions: [{ display_name: 'フィーネ', utterance: 'とても綺麗な光ですね' }]
  });
  assert.match(prompt, /他の客のこれまでの反応:/);
  assert.match(prompt, /- フィーネ: とても綺麗な光ですね/);
  assert.match(prompt, /他の客の反応に軽く反応してもよいが、丸ごとなぞらない。/);
});

// ----- NPC bid turn (3) -----

test('the NPC bid response schema is the exact single-call {utterance, action, amount} shape', () => {
  assert.equal(AUCTION_BID_TURN_RESPONSE_FORMAT.json_schema.name, 'auction_bid_turn');
  const schema = AUCTION_BID_TURN_RESPONSE_FORMAT.json_schema.schema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['action', 'amount', 'utterance']);
  assert.deepEqual(schema.properties.action.enum, ['bid', 'pass']);
  assert.equal(schema.properties.amount.type, 'integer');
  assert.deepEqual(schema.required.sort(), ['action', 'amount', 'utterance']);
});

test('buildNpcBidPrompt states the budget ceiling, the 成立範囲, the history, and the 世界整合ガード', () => {
  const prompt = buildNpcBidPrompt({
    bidder: BIDDER,
    lot: WEAPON_LOT,
    budget: 9000,
    current: 6000,
    currentBidderName: 'まだなし',
    minNext: 6300,
    history: [{ display_name: 'ポーラ', action: 'bid', amount: 6000 }]
  });
  assert.match(prompt, /あなたの手持ちの金（予算の上限）: 9000G/);
  assert.match(prompt, /ただいまの最高値: 6000G（まだなし）/);
  assert.match(prompt, /入札するなら 6300G 以上・9000G 以下の整数でなければならない。/);
  assert.match(prompt, /ここまでの競り: ポーラ 6000G/);
  assert.match(prompt, /amount: bid のとき 6300 以上 9000 以下の整数。pass のとき 0。/);
  assert.ok(prompt.includes(AUCTION_WORLD_GUARD));
});

// ----- master 語彙散らし: 禁忌ブロック (2-1) + 反復回避ハンドオフ (2-2) -----

test('the 3 master 口上 carry the 禁忌ブロック after the 書き方の縛り, and omit it when constraints resolve empty', () => {
  for (const prompt of [
    buildMasterOpeningPrompt({ lot: WEAPON_LOT, speechConstraints: SPEECH_CONSTRAINTS }),
    buildMasterGoadPrompt({ lot: WEAPON_LOT, current: 6300, bidderName: 'レオナ', speechConstraints: SPEECH_CONSTRAINTS }),
    buildMasterHammerPrompt({ lot: WEAPON_LOT, price: 7200, winnerName: 'お客人', speechConstraints: SPEECH_CONSTRAINTS })
  ]) {
    assert.match(prompt, /キャラクター発話上の禁止事項:/);
    assert.match(prompt, /- 手垢のついた賛辞（「白眉」等）を使わない/);
    assert.match(prompt, /- その言い換えも避ける/);
    // 禁忌ブロック sits after the 書き方の縛り (紹介記事調禁止) and before the 字数指定.
    assert.ok(prompt.indexOf(FORBIDDEN_NARRATION_NAMING) < prompt.indexOf('キャラクター発話上の禁止事項:'));
  }
  // empty constraints (chat-model mismatch / definition absent) → block omitted (established resolver contract).
  assert.doesNotMatch(buildMasterOpeningPrompt({ lot: WEAPON_LOT, speechConstraints: [] }), /キャラクター発話上の禁止事項:/);
});

test('the 3 master 口上 add the 反復回避ハンドオフ only once a prior 口上 exists (第1ロット開幕は非出力)', () => {
  const prior = ['さあ皆様、今宵の白眉を披露いたしましょう。', '皆様、この一振りにご注目を。'];
  const HANDOFF_HEADER = 'この競売ですでに述べた口上（品ごとに表現を変え、同じ褒め言葉・語り出し・比喩・言い回しを繰り返さない。特に毎回同じ賛辞で始めない）:';
  // first lot opening: no prior 口上 → no handoff
  assert.doesNotMatch(buildMasterOpeningPrompt({ lot: WEAPON_LOT, speechConstraints: SPEECH_CONSTRAINTS }), /この競売ですでに述べた口上/);
  for (const prompt of [
    buildMasterOpeningPrompt({ lot: WEAPON_LOT, speechConstraints: SPEECH_CONSTRAINTS, priorUtterances: prior }),
    buildMasterGoadPrompt({ lot: WEAPON_LOT, current: 6300, bidderName: 'レオナ', priorUtterances: prior }),
    buildMasterHammerPrompt({ lot: WEAPON_LOT, price: 7200, winnerName: 'お客人', priorUtterances: prior })
  ]) {
    assert.ok(prompt.includes(HANDOFF_HEADER));
    assert.match(prompt, /- さあ皆様、今宵の白眉を披露いたしましょう。/);
    assert.match(prompt, /- 皆様、この一振りにご注目を。/);
  }
});

// ----- reaction / bid: 通常会話コンテクスト同期 (world / speech-constraints / 会話相手コンテキスト) -----

test('buildReactionPrompt syncs the 3 conversation blocks right after the persona, reusing the shared actor renderer', () => {
  const prompt = buildReactionPrompt({
    bidder: BIDDER, lot: WEAPON_LOT,
    worldDescription: WORLD_DESCRIPTION, speechConstraints: SPEECH_CONSTRAINTS, actorContext: ACTOR_CONTEXT
  });
  assert.match(prompt, new RegExp(`ワールド設定: ${WORLD_DESCRIPTION}`));
  assert.match(prompt, /キャラクター発話上の禁止事項:/);
  // 会話相手コンテキスト is the shared renderer's verbatim output — no wording is duplicated in the auction module.
  assert.ok(prompt.includes(renderConversationActorContext(ACTOR_CONTEXT)));
  assert.match(prompt, /主人公への好感度: 90\/100/);
  assert.ok(prompt.includes(AFFINITY_CONTEXT_SCALE));
  // the block sits between the persona 話し方 line and the 品披露.
  assert.ok(prompt.indexOf('話し方: ぶっきらぼうで語尾が強い') < prompt.indexOf('ワールド設定:'));
  assert.ok(prompt.indexOf('ワールド設定:') < prompt.indexOf('いま司会が次の品を披露した:'));
});

test('buildNpcBidPrompt syncs the same 3 blocks and leaves the 成立範囲 / schema hint economic text intact', () => {
  const prompt = buildNpcBidPrompt({
    bidder: BIDDER, lot: WEAPON_LOT, budget: 9000, current: 6000, currentBidderName: 'まだなし', minNext: 6300,
    worldDescription: WORLD_DESCRIPTION, speechConstraints: SPEECH_CONSTRAINTS, actorContext: ACTOR_CONTEXT
  });
  assert.match(prompt, new RegExp(`ワールド設定: ${WORLD_DESCRIPTION}`));
  assert.match(prompt, /キャラクター発話上の禁止事項:/);
  assert.ok(prompt.includes(renderConversationActorContext(ACTOR_CONTEXT)));
  assert.match(prompt, /主人公への好感度: 90\/100/);
  // the economic boundary text is unchanged by the added context.
  assert.match(prompt, /入札するなら 6300G 以上・9000G 以下の整数でなければならない。/);
  assert.match(prompt, /amount: bid のとき 6300 以上 9000 以下の整数。pass のとき 0。/);
});

test('reaction / bid omit the sync block cleanly when nothing resolves (no world, empty constraints, null actor)', () => {
  const reaction = buildReactionPrompt({ bidder: BIDDER, lot: WEAPON_LOT });
  assert.doesNotMatch(reaction, /ワールド設定:/);
  assert.doesNotMatch(reaction, /キャラクター発話上の禁止事項:/);
  assert.doesNotMatch(reaction, /会話相手コンテキスト:/);
  // still a well-formed reaction prompt (persona + 品披露 + guard).
  assert.match(reaction, /あなたはレオナである。宵の競売会場に客として居合わせている。/);
  assert.match(reaction, /いま司会が次の品を披露した:/);
  const bid = buildNpcBidPrompt({ bidder: BIDDER, lot: WEAPON_LOT, budget: 9000, current: 6000, currentBidderName: 'まだなし', minNext: 6300 });
  assert.doesNotMatch(bid, /会話相手コンテキスト:/);
  assert.match(bid, /ただいまの競りの状況:/);
});

// ----- being persona (competition origin frame) -----

test('buildAuctionBeingPersonaPrompt swaps the origin frame to 競売場で迎えた and keeps the profile 規律 + labeled format', () => {
  const prompt = buildAuctionBeingPersonaPrompt({ name: 'スピカ', temperamentSeed: BEING_ITEM.temperament_seed, species: 'homunculus' });
  assert.match(prompt, /競売会場で競り落とされ主人公に迎えられたホムンクルス「スピカ」/);
  assert.match(prompt, /主人公に競り落とされて迎え入れられた/);
  assert.ok(prompt.includes(BEING_ITEM.temperament_seed));
  // profile 規律: no quoted dialogue example, no held props, no外見色.
  assert.match(prompt, /鉤括弧で囲ったセリフ（その者が口にする発言例）は書かない/);
  assert.match(prompt, /髪・瞳・肌・服の色などの外見は書かない/);
  // labeled output format parsed by parseHomunculusPersona.
  assert.match(prompt, /紹介文: <本文>/);
  assert.match(prompt, /話し方: <本文>/);
});

test('buildAuctionBeingPersonaPrompt renders the species label for spirit and monster', () => {
  assert.match(buildAuctionBeingPersonaPrompt({ name: 'ヒカゲ', temperamentSeed: '穏やか', species: 'spirit' }), /迎えられた精霊「ヒカゲ」/);
  assert.match(buildAuctionBeingPersonaPrompt({ name: 'フクフク', temperamentSeed: '眠たがり', species: 'monster' }), /迎えられた魔物「フクフク」/);
});

// ----- equipment naming (reuses the workshop gate) -----

test('buildAuctionEquipmentNamingPrompt frames the 落札品 with the 骨子名 and embeds the confirmed roll', () => {
  const roll = { kind: 'weapon', weapon_type: 'sword', element: 'fire', tier: 4, quality: 'masterwork', base_effects: { attack: 11 }, bonus_effects: { attack: 4 } };
  const prompt = buildAuctionEquipmentNamingPrompt({ roll, seedName: '逸品の剣' });
  assert.match(prompt, /競売会場で競り落とされた一点物の装備に、固有の銘と来歴の一文を付ける。競売では「逸品の剣」として披露された品である。/);
  assert.match(prompt, /種別: 武器（剣）/);
  assert.match(prompt, /属性: 火/);
});

// ----- gates -----

test('gateMasterSpeech / gateReaction reject empty and over-cap output as a structured 503', () => {
  assert.equal(gateMasterSpeech('  さあ皆様、今宵の白眉を。  '), 'さあ皆様、今宵の白眉を。');
  assert.throws(() => gateMasterSpeech('   '), (error) => error.statusCode === 503 && error.errorCode === 'AUCTION_GENERATION_FAILED');
  assert.throws(() => gateMasterSpeech('あ'.repeat(AUCTION_MASTER_SPEECH_HARD_CAP + 1)), (error) => error.statusCode === 503);
  assert.throws(() => gateReaction(''), (error) => error.statusCode === 503);
});

// ----- bid candidate gate + system re-validation -----

test('validateAuctionBidCandidate enforces the exact {utterance, action, amount} shape', () => {
  assert.deepEqual(validateAuctionBidCandidate({ utterance: '積む', action: 'bid', amount: 6300 }), { utterance: '積む', action: 'bid', amount: 6300 });
  assert.throws(() => validateAuctionBidCandidate({ action: 'bid', amount: 6300 }), (error) => error.statusCode === 503);
  assert.throws(() => validateAuctionBidCandidate({ utterance: 'x', action: 'raise', amount: 1 }), (error) => error.statusCode === 503);
  assert.throws(() => validateAuctionBidCandidate({ utterance: 'x', action: 'bid', amount: -1 }), (error) => error.statusCode === 503);
  assert.throws(() => validateAuctionBidCandidate({ utterance: '', action: 'pass', amount: 0 }), (error) => error.statusCode === 503);
});

test('resolveAuctionBidDecision keeps an in-range bid and resolves any out-of-range/pass to a pass (system 正本)', () => {
  // in range → real bid
  assert.deepEqual(resolveAuctionBidDecision({ candidate: { utterance: 'いくぞ', action: 'bid', amount: 6300 }, minNext: 6300, budget: 9000 }),
    { action: 'bid', amount: 6300, utterance: 'いくぞ' });
  // over budget → pass
  assert.deepEqual(resolveAuctionBidDecision({ candidate: { utterance: '一万だ', action: 'bid', amount: 10000 }, minNext: 6300, budget: 9000 }),
    { action: 'pass', amount: 0, utterance: '一万だ' });
  // below minNext → pass
  assert.deepEqual(resolveAuctionBidDecision({ candidate: { utterance: 'ちまちま', action: 'bid', amount: 6100 }, minNext: 6300, budget: 9000 }),
    { action: 'pass', amount: 0, utterance: 'ちまちま' });
  // explicit pass stays a pass, utterance preserved
  assert.deepEqual(resolveAuctionBidDecision({ candidate: { utterance: '降りる', action: 'pass', amount: 0 }, minNext: 6300, budget: 9000 }),
    { action: 'pass', amount: 0, utterance: '降りる' });
  // budget exactly reachable at minNext → bid
  assert.deepEqual(resolveAuctionBidDecision({ candidate: { utterance: '天井だ', action: 'bid', amount: 9000 }, minNext: 9000, budget: 9000 }),
    { action: 'bid', amount: 9000, utterance: '天井だ' });
});
