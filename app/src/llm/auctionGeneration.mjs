// 競売場 (auction house) LLM generation: the only place the auction session talks to the language model.
//
// Five generation surfaces, built from the reviewed 実測 prompt templates in the auction LLM quality
// investigation (§1 master 口上 / §2 キャラ反応 / §3 NPC 入札ターン / §4 世界整合ガード) plus the auction-being
// persona (the 錬成室 persona 採用形 with only the origin frame swapped to 競売場で迎えた). 実測 gemma-4-31b:
//   - Master speech (buildMasterOpeningPrompt / GoadPrompt / HammerPrompt): the errand-appeal 本人 reframe +
//     外部要約話法の名指し禁止 + 記号/ト書き禁止 + 確定情報の織り込み + 字数, plus the two 散らし levers — the
//     model-specific 発話禁止規則 block (always, from resolveCharacterSpeechConstraints) and, once one master 口上
//     has already been spoken this visit, the 反復回避 handoff of the visit's prior 口上 (front-carried). Chat 経路.
//   - Character reaction (buildReactionPrompt): the conversation prefix (prompt_description + speaking_basis) + the
//     通常会話コンテクスト同期 block (world_description + model speech-constraints + 会話相手コンテキスト〔好感度 +
//     系統知識〕, all composed through the shared conversation renderers) + a reaction final instruction; the
//     数珠つなぎ threads prior reactions in. Chat 経路 (streamed).
//   - NPC bid turn (buildNpcBidPrompt): the same 通常会話コンテクスト同期 block after the persona, then the single-call
//     structured `{utterance, action, amount}` (採用形 B). The system re-validates the amount against [minNext,
//     budget]; an out-of-range amount resolves to a pass (resolveAuctionBidDecision) — 経済に効く値は system 正本,
//     the LLM amount is a proposal only (the thicker context does not touch this economic boundary).
//   - Being persona (buildAuctionBeingPersonaPrompt): name + temperament_seed -> 紹介文 / 話し方 in ONE call,
//     the 競売場で迎えた origin frame as the standing premise. Parsed by parseHomunculusPersona (shared gate).
//   - Equipment naming (buildAuctionEquipmentNamingPrompt): the confirmed roll -> structured `{name, flavor}`,
//     gated by validateCraftNaming (shared with the workshop). Feeds deriveAuctionEquipmentInstance.
//
// Every failure — LM unconfigured/unreachable, empty/unparseable output, a closed-set / parse / quote-gate
// violation — throws a 503-tagged error with nothing persisted. No authored fallback, no silent retry. The
// benchmark-confirmed template wording is fixed (any wording change goes back to Lead first).

import { callLmStudioChat, callLmStudioStructuredJson } from './lmStudioClient.mjs';
import { renderConversationActorContext } from './conversationActorContext.mjs';
import { parseHomunculusPersona } from './homunculusGeneration.mjs';
import { validateCraftNaming, buildCraftNamingPrompt, CRAFT_NAME_MAX_LENGTH, CRAFT_FLAVOR_MAX_LENGTH } from './craftNaming.mjs';
import { AUCTION_WEAPON_KINDS, AUCTION_BANDS, AUCTION_BEING_SPECIES } from '../routingAuction.mjs';

// ----- authored master persona (仮確定 — 文言は Lead / うゆりすさんが差し替えられる形に1箇所で保持) -----
export const AUCTION_MASTER = Object.freeze({
  name: '競売人ガロウ',
  basis: '慇懃だが目端の利く宵の競売人。品を立てるときは芝居がかり、値が動く瞬間は声を落とす。'
});

// A defensive hard cap on a streamed master utterance: the templates target 40〜200字, so a markdown / 紹介記事調
// runaway (実測 M0 = 1041字 without the 縛りブロック) is unusable output. The 縛りブロック keeps real outputs well
// under this; the cap only fences a pathological runaway.
export const AUCTION_MASTER_SPEECH_HARD_CAP = 600;

// A generation failure is surfaced as a structured 503 (the errand / study / library / 錬成室 contract). An
// empty / over-cap / unparseable / gate-violating output is the model producing unusable output, so it shares
// this status.
export const AUCTION_GENERATION_FAILED_ERROR_CODE = 'AUCTION_GENERATION_FAILED';

function auctionGenerationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.errorCode = AUCTION_GENERATION_FAILED_ERROR_CODE;
  return error;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`auction generation ${label} is required`);
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`auction generation ${label} must be a positive integer`);
  return value;
}

// ----- shared prompt fragments (benchmark-confirmed, wording fixed) -----

// The common 書き方の縛り block shared by the three master speeches (§1). The 記号/ト書き禁止 + 話法名指し禁止 lines
// are load-bearing (実測 M2: removing them brings back 「」囲い + ト書き).
const AUCTION_WRITING_CONSTRAINTS = [
  '書き方の縛り:',
  '- 品を外から解説・要約する話法にしない。「〜という品である」「〜が特徴だ」「本品は〜」のような紹介記事調で書かない。',
  '- 客に呼びかけ、品の値打ちを立て場を沸かせる、司会そのものの生の口上として語る。',
  '- 実在の地名・人名・歴史、現代語・外来語、現代の器具や単位を混ぜない（G は通貨単位として可）。',
  '- 引用符や鉤括弧で言葉を囲わない。改行せず一続きに。見出し・前置き・ト書き（丸括弧の動作描写）は書かない。'
];

// The 世界整合ガード (§4), attached to every generation surface (実測: removes the 外来通貨語 `ギル` leak).
export const AUCTION_WORLD_GUARD = '実在の地名・人名・歴史、現代語・外来語、現代の器具や単位を混ぜない。通貨単位は G のみ（ギル等の他通貨名を使わない）。';

// The 本人 reframe 役割行 (3種共通・`action` is the per-kind その場の動作).
function masterRoleLines(action) {
  return [
    `あなたは宵の競売会場の司会者、${AUCTION_MASTER.name}本人である。${action}`,
    `あなたの司会ぶり: ${AUCTION_MASTER.basis}`
  ];
}

// ----- 通常会話コンテクスト同期 blocks (shared between the master 口上 and the reaction / bid prompts) -----

// The モデル別発話禁止規則 block. Its LINES are the shared speech-constraints DATA resolved upstream by
// resolveCharacterSpeechConstraints (the same 陳腐語＋言い換え禁止 profile the conversation prefix injects) — not
// re-authored here; only the block framing is local, because promptBuilder's renderCharacterSpeechConstraints is
// private (not exported) and promptBuilder is not modified. An empty array — the resolver's established result when
// the chat model has no matching profile or the definition file is absent — drops the block (not a silent fallback).
function speechConstraintsBlockLines(speechConstraints) {
  const lines = (Array.isArray(speechConstraints) ? speechConstraints : [])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return ['キャラクター発話上の禁止事項:', ...lines.map((line) => `- ${line}`)];
}

// The 反復回避ハンドオフ block (2-2): the visit's already-spoken master 口上, so the model varies each 口上 rather than
// opening every lot with the same 賛辞. Empty (第1ロットの開幕・まだ一本も述べていない) drops the block entirely.
function priorUtterancesHandoffLines(priorUtterances) {
  const lines = (Array.isArray(priorUtterances) ? priorUtterances : [])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return [
    'この競売ですでに述べた口上（品ごとに表現を変え、同じ褒め言葉・語り出し・比喩・言い回しを繰り返さない。特に毎回同じ賛辞で始めない）:',
    ...lines.map((line) => `- ${line}`)
  ];
}

// The two master 散らし blocks, placed right after the 書き方の縛り in all three master speeches: (2-1) the 禁忌 block
// (always, when non-empty) then (2-2) the 反復回避 handoff (only with a prior 口上). Each present block is preceded by
// a blank line so it reads as its own paragraph; both absent leaves the master prompt exactly as its base form.
function masterScatterBlockLines({ speechConstraints, priorUtterances }) {
  const lines = [];
  const banBlock = speechConstraintsBlockLines(speechConstraints);
  if (banBlock.length > 0) lines.push('', ...banBlock);
  const handoff = priorUtterancesHandoffLines(priorUtterances);
  if (handoff.length > 0) lines.push('', ...handoff);
  return lines;
}

// The 通常会話コンテクスト同期 block inserted right after the persona in the reaction / bid prompts: ワールド設定 +
// モデル別発話禁止規則 + 会話相手コンテキスト. world_description is rendered with the same `ワールド設定: ` label the
// conversation prefix uses (loadWorldSettings supplies a non-empty default, so the line is always present); the
// 会話相手コンテキスト〔好感度＋系統知識〕 is rendered VERBATIM through the shared renderConversationActorContext (no
// wording duplicated). A null actor context (no affinity and no ≥50 系統知識) drops just that sub-block.
function conversationContextBlockLines({ worldDescription, speechConstraints, actorContext }) {
  const lines = [];
  const world = String(worldDescription ?? '').trim();
  if (world) lines.push(`ワールド設定: ${world}`);
  lines.push(...speechConstraintsBlockLines(speechConstraints));
  const actorContextText = renderConversationActorContext(actorContext ?? null);
  if (actorContextText) lines.push(actorContextText);
  return lines;
}

// ----- lot presentation (pure): a catalog item -> the display fields the 口上 / 反応 / 入札 prompts inject -----

const WEAPON_KIND_LABELS = { sword: '剣', staff: '杖', short_rod: '短杖', amulet: '護符' };
const WEAPON_GRADE_DESCRIPTIONS = { B: '確かな業物', A: '名うての逸品', S: '会場随一の神品' };
const BEING_SPECIES_LABELS = { homunculus: 'ホムンクルス', spirit: '精霊', monster: '魔物' };
const TREASURE_EFFECT_BLURBS = {
  gift: '人に贈るための珍品',
  self_boost: '身を高める秘薬の類',
  dungeon_consumable: '戦いの場で真価を発揮する品'
};

function assertLabelsCover(labels, keys, what) {
  const labelKeys = Object.keys(labels).sort();
  const canonical = [...keys].sort();
  const matches = labelKeys.length === canonical.length && labelKeys.every((key, index) => key === canonical[index]);
  if (!matches) throw new Error(`auction ${what} labels must cover exactly {${canonical.join(', ')}}: got {${labelKeys.join(', ')}}`);
}

// The weapon-grade descriptor covers only the weapon/amulet bands (B/A/S), not C. The species labels cover the
// closed being species. A vocabulary addition upstream fails fast here rather than rendering a mislabeled prompt.
assertLabelsCover(WEAPON_KIND_LABELS, AUCTION_WEAPON_KINDS, 'weapon_kind');
assertLabelsCover(BEING_SPECIES_LABELS, AUCTION_BEING_SPECIES, 'being species');
assertLabelsCover(WEAPON_GRADE_DESCRIPTIONS, AUCTION_BANDS.filter((band) => band !== 'C'), 'weapon grade');

// Maps a normalized catalog item to its presentation: `name` (品名), `category_label` (分類), and `blurb`
// (触れ込み). Weapon/amulet has no authored blurb (the 銘/来歴 is LLM-generated at award), so it is derived from
// grade + kind; treasure is derived from its effect category; flavor uses appeal_seed; being uses temperament_seed.
export function auctionLotPresentation(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('auction lot presentation requires an item');
  const name = requireNonEmptyString(item.name, 'item.name');
  if (item.category === 'weapon_amulet') {
    const kindLabel = WEAPON_KIND_LABELS[item.weapon_kind];
    const gradeDesc = WEAPON_GRADE_DESCRIPTIONS[item.band];
    if (!kindLabel) throw new Error(`auction weapon_kind has no label: ${item.weapon_kind}`);
    if (!gradeDesc) throw new Error(`auction weapon/amulet band has no grade description: ${item.band}`);
    return {
      name,
      category_label: item.weapon_kind === 'amulet' ? '護符' : '武器',
      blurb: `${gradeDesc}と名高い${kindLabel}`
    };
  }
  if (item.category === 'treasure') {
    const blurb = TREASURE_EFFECT_BLURBS[item.effect?.category];
    if (!blurb) throw new Error(`auction treasure effect category has no blurb: ${item.effect?.category}`);
    return { name, category_label: '調合の逸品', blurb };
  }
  if (item.category === 'flavor') {
    return { name, category_label: '愛玩の品', blurb: requireNonEmptyString(item.appeal_seed, 'flavor.appeal_seed') };
  }
  if (item.category === 'being') {
    const speciesLabel = BEING_SPECIES_LABELS[item.species];
    if (!speciesLabel) throw new Error(`auction being species has no label: ${item.species}`);
    return { name, category_label: speciesLabel, blurb: requireNonEmptyString(item.temperament_seed, 'being.temperament_seed') };
  }
  if (item.category === 'caged_creature') {
    // A 星の揺り籠 caged creature (落札側): the name/触れ込み are already the C-28-derived presentation carried on
    // the lot item, so the presentation just surfaces them under the fixed 分類 label (no catalog lookup).
    return { name, category_label: '籠入りの生き物', blurb: requireNonEmptyString(item.blurb, 'caged_creature.blurb') };
  }
  throw new Error(`auction lot presentation unknown category: ${item.category}`);
}

// ----- master speech prompts (§1・pure) -----

// (1a) 開幕口上: presents the lot + tells the 開始値 / 最低つり上げ幅 so the client learns how to bid. 140〜200字.
// The two 散らし blocks (禁忌 + 反復回避ハンドオフ) follow the 書き方の縛り. A `presentation` override lets a
// non-catalog lot (a player-consigned asset) supply its display fields directly; `consignment` switches the 口上 to
// the 出品披露 form (調査 auction-consignment-llm-investigation §1 の A3 採用形・差分3箇所: 役割行 action・確定情報
// 「出どころ」行・「委託品と伝わるよう口火を切る」最終指示。禁忌ブロック・ハンドオフ機構は会場ロットと共通).
export function buildMasterOpeningPrompt({ lot, presentation = null, consignment = false, speechConstraints = [], priorUtterances = [] }) {
  const view = presentation ?? auctionLotPresentation(lot?.item);
  const startPrice = requirePositiveInteger(lot?.initial_price, 'lot.initial_price');
  const increment = requirePositiveInteger(lot?.min_increment, 'lot.min_increment');
  const roleAction = consignment
    ? 'いま壇上で、お客から持ち込まれた品を客たちに披露し、競りの口火を切る。'
    : 'いま壇上で、次の品を客たちに披露し、競りの口火を切る。';
  return [
    ...masterRoleLines(roleAction),
    '',
    'この品の確定情報（すべて口上に自然に織り込む。値は勝手に変えない）:',
    `- 品名: ${view.name}`,
    `- 分類: ${view.category_label}`,
    `- 触れ込み: ${view.blurb}`,
    ...(consignment ? ['- 出どころ: この会場の常連客が手放すために持ち込んだ委託の品'] : []),
    `- 開始値: ${startPrice}G`,
    `- 最低つり上げ幅: ${increment}G`,
    '',
    ...AUCTION_WRITING_CONSTRAINTS,
    ...masterScatterBlockLines({ speechConstraints, priorUtterances }),
    '',
    '開始値と最低つり上げ幅は、客が入札の仕方を分かるよう口上のなかで自然に告げる。',
    ...(consignment ? ['この品が客の持ち込んだ委託品であることが伝わるよう口火を切る。'] : []),
    '長さは140〜200字くらい。'
  ].join('\n');
}

// (1b) 競り中の煽り: 40〜80字, the current 最高値 + 入札者 + 最低つり上げ幅 woven in.
export function buildMasterGoadPrompt({ lot, current, bidderName, presentation = null, speechConstraints = [], priorUtterances = [] }) {
  const view = presentation ?? auctionLotPresentation(lot?.item);
  const currentPrice = requirePositiveInteger(current, 'current');
  const increment = requirePositiveInteger(lot?.min_increment, 'lot.min_increment');
  const bidder = requireNonEmptyString(bidderName, 'bidderName');
  return [
    ...masterRoleLines('競りは白熱している。今の最高値を受け、場をさらに煽って次の入札を促す。'),
    '',
    'この品の確定情報（すべて口上に自然に織り込む。値は勝手に変えない）:',
    `- 品名: ${view.name}`,
    `- ただいまの最高値: ${currentPrice}G（${bidder}）`,
    `- 最低つり上げ幅: ${increment}G`,
    '',
    ...AUCTION_WRITING_CONSTRAINTS,
    ...masterScatterBlockLines({ speechConstraints, priorUtterances }),
    '',
    '短く、ひと呼吸ぶんの煽りだけを語る。長さは40〜80字くらい。'
  ].join('\n');
}

// (1c) 落札宣言: 40〜80字, the 落札額 + 落札者 woven in with the 槌.
export function buildMasterHammerPrompt({ lot, price, winnerName, presentation = null, speechConstraints = [], priorUtterances = [] }) {
  const view = presentation ?? auctionLotPresentation(lot?.item);
  const finalPrice = requirePositiveInteger(price, 'price');
  const winner = requireNonEmptyString(winnerName, 'winnerName');
  return [
    ...masterRoleLines('競りは決した。槌を鳴らし、落札を宣言する。'),
    '',
    'この品の確定情報（すべて口上に自然に織り込む。値は勝手に変えない）:',
    `- 品名: ${view.name}`,
    `- 落札額: ${finalPrice}G`,
    `- 落札者: ${winner}`,
    '',
    ...AUCTION_WRITING_CONSTRAINTS,
    ...masterScatterBlockLines({ speechConstraints, priorUtterances }),
    '',
    '短く、落札を告げる宣言だけを語る。長さは40〜80字くらい。'
  ].join('\n');
}

// ----- character reaction prompt (§2・pure) -----

function biddersPersonaLines(bidder, situating) {
  const name = requireNonEmptyString(bidder?.display_name, 'bidder.display_name');
  return [
    `あなたは${name}である。${situating}`,
    `立場: ${requireNonEmptyString(bidder?.school_year, 'bidder.school_year')}・${requireNonEmptyString(bidder?.identity, 'bidder.identity')}`,
    `人物像（演技・応答方針として扱う）: ${requireNonEmptyString(bidder?.prompt_description, 'bidder.prompt_description')}`,
    `話し方: ${requireNonEmptyString(bidder?.speaking_basis, 'bidder.speaking_basis')}`
  ];
}

// The reaction prompt. `priorReactions` (可空) threads the 数珠つなぎ: prior 客 reactions are inserted after the
// 品披露 and an "軽く反応してよいが丸ごとなぞらない" instruction is added. The 通常会話コンテクスト同期 block
// (world / speech-constraints / 会話相手コンテキスト) is inserted right after the persona.
export function buildReactionPrompt({ bidder, lot, presentation = null, priorReactions = [], worldDescription = '', speechConstraints = [], actorContext = null }) {
  const view = presentation ?? auctionLotPresentation(lot?.item);
  const name = requireNonEmptyString(bidder?.display_name, 'bidder.display_name');
  const contextLines = conversationContextBlockLines({ worldDescription, speechConstraints, actorContext });
  const priorLines = (Array.isArray(priorReactions) ? priorReactions : [])
    .map((entry) => {
      const speaker = requireNonEmptyString(entry?.display_name, 'priorReactions.display_name');
      const utterance = requireNonEmptyString(entry?.utterance, 'priorReactions.utterance');
      return `- ${speaker}: ${utterance}`;
    });
  const chainBlock = priorLines.length > 0 ? ['', '他の客のこれまでの反応:', ...priorLines] : [];
  const chainInstruction = priorLines.length > 0 ? ['他の客の反応に軽く反応してもよいが、丸ごとなぞらない。'] : [];
  return [
    ...biddersPersonaLines(bidder, '宵の競売会場に客として居合わせている。'),
    ...(contextLines.length > 0 ? ['', ...contextLines] : []),
    '',
    'いま司会が次の品を披露した:',
    `- 品名: ${view.name}／分類: ${view.category_label}`,
    `- 触れ込み: ${view.blurb}`,
    ...chainBlock,
    '',
    `${name}として、この品を見た今の反応の発話だけを書く。欲しがる・値踏みする・関心が薄い等、この品への態度が自然に伝わるようにする。`,
    '自分の話し方の口調を保ち、品の触れ込みを丸ごと言い直さず、気になった一点にだけ触れて反応する。',
    ...chainInstruction,
    '発話は一度に1〜2文程度で短く。発言内容に鉤括弧はつけない。振る舞いや仕草には丸括弧をつける。',
    AUCTION_WORLD_GUARD
  ].join('\n');
}

// ----- NPC bid turn prompt (§3・pure) + structured schema -----

// The bid turn structured schema (採用形 B). Only a hint: validateAuctionBidCandidate + resolveAuctionBidDecision
// are the authoritative gate + system re-validation.
export const AUCTION_BID_TURN_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'auction_bid_turn',
    schema: {
      type: 'object',
      properties: {
        utterance: { type: 'string' },
        action: { type: 'string', enum: ['bid', 'pass'] },
        amount: { type: 'integer' }
      },
      required: ['utterance', 'action', 'amount']
    }
  }
};

// Formats the bid history for the prompt: each event as "<名> <額>G" (bid) or "<名> 降りる" (pass), ' → ' joined.
function formatBidHistory(history) {
  const entries = (Array.isArray(history) ? history : []).map((entry) => {
    const name = requireNonEmptyString(entry?.display_name, 'history.display_name');
    if (entry.action === 'bid') return `${name} ${requirePositiveInteger(entry.amount, 'history.amount')}G`;
    if (entry.action === 'pass') return `${name} 降りる`;
    throw new Error(`auction bid history action must be bid or pass: ${entry?.action}`);
  });
  return entries.length > 0 ? entries.join(' → ') : 'まだ入札はない';
}

// The NPC bid turn prompt: persona -> 競り状況 (出品物 / 予算上限 / 最高値 / 成立範囲 / 履歴) -> 出力指示. `minNext`
// is current + increment; `budget` is this bidder's non-public budget for this lot. `currentBidderName` is the
// standing highest bidder, or a "まだなし" placeholder when the price is still the opening value.
export function buildNpcBidPrompt({ bidder, lot, presentation = null, consignment = false, budget, current, currentBidderName, minNext, history = [], worldDescription = '', speechConstraints = [], actorContext = null }) {
  const view = presentation ?? auctionLotPresentation(lot?.item);
  const normalizedBudget = requirePositiveInteger(budget, 'budget');
  const normalizedCurrent = requirePositiveInteger(current, 'current');
  const normalizedMinNext = requirePositiveInteger(minNext, 'minNext');
  const bidderLabel = typeof currentBidderName === 'string' && currentBidderName.trim() ? currentBidderName.trim() : 'まだなし';
  const contextLines = conversationContextBlockLines({ worldDescription, speechConstraints, actorContext });
  return [
    ...biddersPersonaLines(bidder, '宵の競売会場に客として居合わせ、いま出品物の競りに加わっている。'),
    ...(contextLines.length > 0 ? ['', ...contextLines] : []),
    '',
    'ただいまの競りの状況:',
    `- 出品物: ${view.name}（${view.category_label}）／${view.blurb}`,
    ...(consignment ? ['- この出品物は、この会場のお客（主人公）が持ち込んだ委託品である。会場の主催者の品ではない。'] : []),
    `- あなたの手持ちの金（予算の上限）: ${normalizedBudget}G`,
    `- ただいまの最高値: ${normalizedCurrent}G（${bidderLabel}）`,
    `- 入札するなら ${normalizedMinNext}G 以上・${normalizedBudget}G 以下の整数でなければならない。`,
    `- ここまでの競り: ${formatBidHistory(history)}`,
    '',
    `${requireNonEmptyString(bidder?.display_name, 'bidder.display_name')}として、この品に積むか降りるかを決める。出力は utterance, action, amount の3キーの JSON オブジェクト1つだけ。`,
    `utterance: あなたの性格がにじむ短い発話（1〜2文・鉤括弧なし・振る舞いは丸括弧）。${AUCTION_WORLD_GUARD}`,
    'action: 積むなら "bid"、降りるなら "pass"。あなたの性格に照らし、強気なら大きく上乗せ、慎重なら最小限に。予算を超える額は決して出さない。',
    `amount: bid のとき ${normalizedMinNext} 以上 ${normalizedBudget} 以下の整数。pass のとき 0。`
  ].join('\n');
}

// ----- being persona prompt (競売場で迎えた origin frame・pure) -----

// The auction-being origin-frame premise block (the 錬成室 persona 採用形 with only the origin swapped). Keeping
// it verbatim as the standing premise is what keeps the being's voice consistent 生成→会話 and prevents 誕生語 drift.
function auctionBeingOriginLines(name, speciesLabel) {
  return [
    `- ${name}は、宵の競売会場で品として競りにかけられ、主人公に競り落とされて迎え入れられた${speciesLabel}である。競売場に流れ着く前の来歴を持つ、既にひとつの人格として在った存在で、主人公が無から生んだのではない。`,
    `- ${name}は自分がそうして迎えられたことを自覚している。自分を競り落として迎えた主人公のもとで、これから共に過ごしていく。`,
    '- 居場所は主人公の錬成室で、学院の生徒ではない。'
  ];
}

// The being persona prompt (§ 錬成室 persona 採用形・出自フレームのみ差し替え): name + temperament_seed -> 紹介文 /
// 話し方 in one call, parsed by parseHomunculusPersona. Profile 規律 (no quoted dialogue / no held props / no
// 外見色) + 字数指定 mirror the atelier form.
export function buildAuctionBeingPersonaPrompt({ name, temperamentSeed, species }) {
  const normalizedName = requireNonEmptyString(name, 'being name');
  const normalizedSeed = requireNonEmptyString(temperamentSeed, 'being temperament_seed');
  const speciesLabel = BEING_SPECIES_LABELS[species];
  if (!speciesLabel) throw new Error(`auction being species has no label: ${species}`);
  return [
    `あなたは、競売会場で競り落とされ主人公に迎えられた${speciesLabel}「${normalizedName}」の人物設定を書く。これはゲーム内で会話AIに与える設定文であり、【紹介文】と【話し方】の2つを書く。`,
    '',
    '【この存在の出自（必ず設定の前提にする）】',
    ...auctionBeingOriginLines(normalizedName, speciesLabel),
    '',
    '【人物の種（競売に付された気質の触れ込み）】',
    normalizedSeed,
    '',
    '【紹介文の書き方】',
    `- ${normalizedName}が「どんな人物か」を地の文の三人称で描く。気質・内面・迎えてくれた主人公への向き合い方・その者ならではの心の揺れを、上の骨子から膨らませて書く。`,
    '- 競売場で迎えられた存在であることが、人物像に自然に溶けているように書く。設定の説明書きにはせず、人柄として描く。',
    '- 鉤括弧で囲ったセリフ（その者が口にする発言例）は書かない。口調や性格は地の文の記述で表す。',
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

// ----- equipment naming prompt (competition 骨子・reuses the workshop naming gate) -----

// The auction-weapon naming prompt: the confirmed roll (previewAuctionEquipmentRoll) framed as a competition
// 落札品 that gets its 銘/来歴, with the 骨子名 as a seed. Reuses buildCraftNamingPrompt's roll rendering and the
// shared validateCraftNaming gate; only the 場のフレーム line prepends.
export function buildAuctionEquipmentNamingPrompt({ roll, seedName }) {
  const normalizedSeed = requireNonEmptyString(seedName, 'seedName');
  const base = buildCraftNamingPrompt(roll);
  return [
    `宵の競売会場で競り落とされた一点物の装備に、固有の銘と来歴の一文を付ける。競売では「${normalizedSeed}」として披露された品である。`,
    base
  ].join('\n');
}

// ----- gates / system re-validation (pure) -----

// Gates a streamed master utterance: a non-empty string within the hard cap. Empty is unusable; over-cap is a
// markdown / 紹介記事調 runaway the 縛りブロック was meant to prevent — both structured 503s.
export function gateMasterSpeech(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw auctionGenerationError('auction master speech generation returned empty output');
  }
  const trimmed = text.trim();
  if ([...trimmed].length > AUCTION_MASTER_SPEECH_HARD_CAP) {
    throw auctionGenerationError(`auction master speech exceeded the ${AUCTION_MASTER_SPEECH_HARD_CAP} character cap: got ${[...trimmed].length}`);
  }
  return trimmed;
}

// Gates a streamed character reaction: a non-empty string within the hard cap (reactions are 1〜2文・実測最長 122字).
export function gateReaction(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw auctionGenerationError('auction reaction generation returned empty output');
  }
  const trimmed = text.trim();
  if ([...trimmed].length > AUCTION_MASTER_SPEECH_HARD_CAP) {
    throw auctionGenerationError(`auction reaction exceeded the ${AUCTION_MASTER_SPEECH_HARD_CAP} character cap: got ${[...trimmed].length}`);
  }
  return trimmed;
}

// Validates the raw NPC bid candidate against the exact `{utterance, action, amount}` schema: a non-empty
// utterance, action ∈ {bid, pass}, a non-negative integer amount. A malformed candidate is unusable model
// output — a structured 503. Returns the normalized candidate (no economic judgment yet).
export function validateAuctionBidCandidate(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw auctionGenerationError('auction bid candidate must be an object');
  }
  const keys = Object.keys(candidate);
  const exact = keys.length === 3 && keys.includes('utterance') && keys.includes('action') && keys.includes('amount');
  if (!exact) throw auctionGenerationError(`auction bid candidate keys must be exactly {utterance, action, amount}: got {${keys.sort().join(', ')}}`);
  if (typeof candidate.utterance !== 'string' || !candidate.utterance.trim()) {
    throw auctionGenerationError('auction bid candidate utterance must be a non-empty string');
  }
  if (candidate.action !== 'bid' && candidate.action !== 'pass') {
    throw auctionGenerationError(`auction bid candidate action must be bid or pass: ${candidate.action}`);
  }
  if (!Number.isInteger(candidate.amount) || candidate.amount < 0) {
    throw auctionGenerationError('auction bid candidate amount must be a non-negative integer');
  }
  return { utterance: candidate.utterance.trim(), action: candidate.action, amount: candidate.amount };
}

// The system re-validation (§3 必須・fail-soft は不採用): 経済に効く値 (最低増分・予算) は system 正本. A candidate
// that says "bid" resolves to a real bid ONLY when minNext <= amount <= budget; any out-of-range amount — or an
// action of pass — resolves to a pass (amount 0). This is the auction's 判定→消費境界 discipline (工房/錬成室と同族),
// NOT a silent fallback: the resolution rule is the design. Returns { action, amount, utterance }.
export function resolveAuctionBidDecision({ candidate, minNext, budget }) {
  const normalized = validateAuctionBidCandidate(candidate);
  const normalizedMinNext = requirePositiveInteger(minNext, 'minNext');
  const normalizedBudget = requirePositiveInteger(budget, 'budget');
  if (normalized.action === 'bid'
    && normalized.amount >= normalizedMinNext
    && normalized.amount <= normalizedBudget) {
    return { action: 'bid', amount: normalized.amount, utterance: normalized.utterance };
  }
  return { action: 'pass', amount: 0, utterance: normalized.utterance };
}

// ----- orchestration (call the model) -----

// Streams a master 開幕口上 (chat 経路・onDelta). Returns the gated text.
export async function generateAuctionMasterOpening({ config, fetchImpl, onDelta, lot, presentation = null, consignment = false, speechConstraints = [], priorUtterances = [] } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction master opening');
  const prompt = buildMasterOpeningPrompt({ lot, presentation, consignment, speechConstraints, priorUtterances });
  return gateMasterSpeech(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '競売マスター開幕口上生成' }));
}

// Streams a master 競り中の煽り. Returns the gated text.
export async function generateAuctionMasterGoad({ config, fetchImpl, onDelta, lot, current, bidderName, presentation = null, speechConstraints = [], priorUtterances = [] } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction master goad');
  const prompt = buildMasterGoadPrompt({ lot, current, bidderName, presentation, speechConstraints, priorUtterances });
  return gateMasterSpeech(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '競売マスター煽り生成' }));
}

// Streams a master 落札宣言. Returns the gated text.
export async function generateAuctionMasterHammer({ config, fetchImpl, onDelta, lot, price, winnerName, presentation = null, speechConstraints = [], priorUtterances = [] } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction master hammer');
  const prompt = buildMasterHammerPrompt({ lot, price, winnerName, presentation, speechConstraints, priorUtterances });
  return gateMasterSpeech(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '競売マスター落札宣言生成' }));
}

// Streams one character reaction (数珠つなぎ: priorReactions threaded). Returns the gated text.
export async function generateAuctionReaction({ config, fetchImpl, onDelta, bidder, lot, presentation = null, priorReactions = [], worldDescription = '', speechConstraints = [], actorContext = null } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction reaction');
  const prompt = buildReactionPrompt({ bidder, lot, presentation, priorReactions, worldDescription, speechConstraints, actorContext });
  return gateReaction(await callLmStudioChat({ config, prompt, fetchImpl, onDelta, title: '競売キャラ反応生成' }));
}

// Runs one NPC bid turn: the single structured call, then the system re-validation (out-of-range -> pass).
// Returns { action, amount, utterance }.
export async function generateAuctionNpcBid({ config, fetchImpl, bidder, lot, presentation = null, consignment = false, budget, current, currentBidderName, minNext, history = [], worldDescription = '', speechConstraints = [], actorContext = null } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction NPC bid');
  const prompt = buildNpcBidPrompt({ bidder, lot, presentation, consignment, budget, current, currentBidderName, minNext, history, worldDescription, speechConstraints, actorContext });
  const candidate = await callLmStudioStructuredJson({
    config,
    prompt,
    fetchImpl,
    responseFormat: AUCTION_BID_TURN_RESPONSE_FORMAT,
    title: '競売NPC入札ターン生成'
  });
  return resolveAuctionBidDecision({ candidate, minNext, budget });
}

// Generates the auction-being persona: name + temperament_seed -> validated { prompt_description, speaking_basis }.
export async function generateAuctionBeingPersona({ config, fetchImpl, name, temperamentSeed, species } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction being persona');
  const prompt = buildAuctionBeingPersonaPrompt({ name, temperamentSeed, species });
  const text = await callLmStudioChat({ config, prompt, fetchImpl, title: '競売の子人格生成' });
  return parseHomunculusPersona(text);
}

// Generates the auction-weapon 銘/来歴: the confirmed roll -> structured { name, flavor } -> validateCraftNaming.
export async function generateAuctionEquipmentNaming({ config, fetchImpl, roll, seedName } = {}) {
  if (!config) throw new Error('lmStudioConfig is required for auction equipment naming');
  const prompt = buildAuctionEquipmentNamingPrompt({ roll, seedName });
  const candidate = await callLmStudioStructuredJson({
    config,
    prompt,
    fetchImpl,
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'auction_equipment_naming',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, flavor: { type: 'string' } },
          required: ['name', 'flavor']
        }
      }
    },
    title: '競売落札装備の銘生成'
  });
  return validateCraftNaming(candidate);
}

export { CRAFT_NAME_MAX_LENGTH as AUCTION_EQUIP_NAME_MAX_LENGTH, CRAFT_FLAVOR_MAX_LENGTH as AUCTION_EQUIP_FLAVOR_MAX_LENGTH };
