// 競売場 (auction house) session: the storage-facing feature owner between the pure domain layer (routingAuction
// / auctionAward, C-27) + the LLM generation (llm/auctionGeneration) and the thin HTTP surface (server/auctionApi).
//
// The persistence granularity is the LOT: the persisted slot (runtime_state.routing_auction, B1) advances only
// when a lot is awarded or passed in (recordAuctionLotAward). A lot's in-progress bidding (口上 / 反応 / 入札ループ)
// is NOT persisted — the current price, standing highest bidder, who has dropped, and the turn cursor are carried
// by the frontend between the per-utterance requests and re-validated here against the authoritative slot
// (npc budgets / min increment / initial price come from the slot, never the client). A reload restarts the
// current lot's bidding from the top (no half-applied award); money / ownership move only at award, in the writer's
// own atomic transaction.
//
// Every LLM-backed step fails fast (503) with nothing persisted when the LM is unconfigured/unreachable or emits
// unusable output. An award runs LLM-gen → validate → writer (atomic money + surface) → slot advance, in that
// order: a gen or writer failure leaves money, the target surface, AND the slot untouched.

import { createStorageApi } from './storage.mjs';
import { listSelectableCharacterChoices, selectableCharacterPersona } from './characterCatalog.mjs';
import { loadInventory } from './economy.mjs';
import { loadEquipmentSurface, findEquipmentInstance } from './equipment.mjs';
import { equipmentSellPrice, equippedInstanceIds } from './equipmentSale.mjs';
import { loadWorldSettings } from './worldSettings.mjs';
import { resolveCharacterSpeechConstraints } from './llm/characterSpeechConstraints.mjs';
import { buildConversationActorContextSnapshot } from './llm/conversationActorContext.mjs';
import {
  ROUTING_AUCTION_STATE_KEY,
  AUCTION_SOLD_LEDGER_STATE_KEY,
  ROUTING_AUCTION_CONSIGNMENT_STATE_KEY,
  loadAuctionCatalog,
  drawWeeklyAuctionLots,
  buildAuctionSlot,
  readAuctionSlotForWeek,
  recordAuctionLotAward,
  readAuctionSoldLedger,
  nextAuctionSoldLedger,
  auctionCatalogItem,
  previewAuctionEquipmentRoll,
  bandForConsignmentValue,
  auctionConsignmentEquipmentMarketValue,
  auctionConsignmentItemMarketValue,
  buildConsignmentLot,
  buildConsignmentSkip,
  readConsignmentForWeek,
  recordConsignmentResolution,
  auctionCagedCreatureBand,
  auctionCreatureLotForWeek,
  buildAuctionCreatureLot
} from './routingAuction.mjs';
import {
  awardAuctionEquipmentToPlayer,
  awardAuctionItemToPlayer,
  awardAuctionBeingToPlayer,
  awardAuctionCagedCreatureToPlayer,
  canAdoptAuctionBeing,
  payoutConsignmentToPlayer
} from './auctionAward.mjs';
import { loadHomunculiSurface } from './homunculusSurface.mjs';
import { loadStarCradleCatalog } from './starCradleCatalog.mjs';
import { loadStarCradleCreaturesSurface } from './starCradleSurface.mjs';
import { resolveCreatureIdentity } from './starCradle.mjs';
import {
  auctionLotPresentation,
  generateAuctionMasterOpening,
  generateAuctionMasterGoad,
  generateAuctionMasterHammer,
  generateAuctionReaction,
  generateAuctionNpcBid,
  generateAuctionBeingPersona,
  generateAuctionEquipmentNaming
} from './llm/auctionGeneration.mjs';
import { buildAuctionContentResult, ROUTING_CONTENT_RESULT_STATE_KEY } from './routingContentResult.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

// The player's own budget is their money; the master addresses a player win with this authored label (it does
// not know the player's name).
const PLAYER_WINNER_ID = 'player';
const PLAYER_WINNER_LABEL = 'お客人';

function statusError(message, statusCode, { errorCode = null } = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function auctionWeekFromState(state) {
  const week = state?.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw new Error('auction requires runtime_state.elapsed_weeks to be a non-negative integer');
  }
  return week;
}

function requiredInteger(value, label, { min = null } = {}) {
  if (!Number.isInteger(value)) throw statusError(`${label} must be an integer`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
  if (min !== null && value < min) throw statusError(`${label} must be at least ${min}`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
  return value;
}

// ----- catalog / roster loading -----

async function loadAuctionRoster({ root, authoringRoot }) {
  const choices = await listSelectableCharacterChoices({ root, authoringRoot });
  return choices.map((choice) => ({ character_id: choice.id, display_name: choice.display_name }));
}

// Resolves one seated bidder's conversation persona (manifest-free). The id is already verified seated by the
// caller, so a resolution failure is a genuine server error, not a client 404.
async function loadBidderPersona({ root, authoringRoot, characterId }) {
  return selectableCharacterPersona({ root, authoringRoot, characterId });
}

// The reaction / bid prompts synchronize the 通常会話コンテクスト: ワールド設定 (loadWorldSettings) + モデル別
// 発話禁止規則 (resolveCharacterSpeechConstraints, keyed on the chat model) + 会話相手コンテキスト〔好感度＋系統知識〕
// (buildConversationActorContextSnapshot), all through the SAME renderers the conversation prefix uses. The snapshot
// needs the bidder's magic parameters, which selectableCharacterPersona does not carry (it returns only the 5
// persona fields), so read the bidder's profile.json for them — runtime overlay first, then the authoring source,
// the same order loadSelectableCharacterProfile reads. Established resolver contracts (no matching model / absent
// definition → empty constraints; missing affinity file → 25 normalization) are relied on, not silently patched.
async function loadBidderConversationContext({ root, authoringRoot, characterId, chatModel }) {
  const runtimeStorage = createStorageApi({ root });
  const profile = await runtimeStorage.readJsonIfExists(`game_data/characters/${characterId}/profile.json`)
    ?? await createStorageApi({ root: authoringRoot }).readJsonIfExists(`game_data/characters/${characterId}/profile.json`);
  const [worldSettings, speechConstraints, actorContext] = await Promise.all([
    loadWorldSettings({ root }),
    resolveCharacterSpeechConstraints({ root, chatModel }),
    buildConversationActorContextSnapshot({ root, actor: { kind: 'character', id: characterId }, profile: { parameters: profile?.parameters } })
  ]);
  return { worldDescription: worldSettings.world_description, speechConstraints, actorContext };
}

// The master 口上 synchronize only the モデル別発話禁止規則 block (the master is an authored NPC, not a roster
// character, so no world / 会話相手コンテキスト). The block is keyed on the chat model, same resolver as above.
async function loadMasterSpeechConstraints({ root, chatModel }) {
  return resolveCharacterSpeechConstraints({ root, chatModel });
}

// The visit's already-spoken master 口上, carried by the frontend (per-utterance design: nothing bidding-related is
// persisted server-side). Validated as a plain string array — a malformed field is bad client input (400), never
// silently dropped. Absent / empty → no handoff block (第1ロットの開幕).
function normalizePriorUtterances(priorUtterances) {
  if (priorUtterances === null || priorUtterances === undefined) return [];
  if (!Array.isArray(priorUtterances)) throw statusError('prior_utterances must be an array', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
  return priorUtterances.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw statusError(`prior_utterances[${index}] must be a non-empty string`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    }
    return entry.trim();
  });
}

// ----- state view -----

// The public lot view: presentation + economics, but never the non-public npc_budgets. A being lot carries an
// `adoptable` flag (錬成室 roster free) so the client can show 入札不可 rather than failing at award time.
function publicLotView(lot, { adoptable = null } = {}) {
  const presentation = auctionLotPresentation(lot.item);
  return {
    lot_index: lot.lot_index,
    category: lot.item.category,
    band: lot.band,
    name: presentation.name,
    category_label: presentation.category_label,
    blurb: presentation.blurb,
    initial_price: lot.initial_price,
    min_increment: lot.min_increment,
    ...(lot.item.category === 'being' ? { species: lot.item.species, adoptable } : {})
  };
}

async function slotStateView({ root, slot }) {
  const beingAdoptable = slot.lots.some((lot) => lot.item.category === 'being')
    ? canAdoptAuctionBeing(await loadHomunculiSurface({ root }))
    : null;
  const lots = slot.lots.map((lot) => publicLotView(lot, { adoptable: lot.item.category === 'being' ? beingAdoptable : null }));
  return {
    phase: slot.status === 'closed' ? 'closed' : 'in_progress',
    week: slot.week,
    status: slot.status,
    current_lot_index: slot.current_lot_index,
    bidders: slot.bidders.map((bidder) => ({ character_id: bidder.character_id, display_name: bidder.display_name })),
    lots,
    awards: slot.awards.map((award) => ({
      lot_index: award.lot_index,
      outcome: award.outcome,
      winner_character_id: award.winner_character_id,
      amount: award.amount
    }))
  };
}

// The auction state: `selection` when no slot is built for this week (未開催), else the in-progress / closed slot
// view. A slot from an earlier week reads as 未開催 (readAuctionSlotForWeek returns null).
export async function getAuctionState({ root, authoringRoot }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const slot = readAuctionSlotForWeek(state, week);
  if (!slot) return { phase: 'selection', week };
  const view = await slotStateView({ root, slot });
  const consignment = readConsignmentForWeek(state, week);
  return { ...view, consignment: consignment ? consignmentStateView(consignment) : null };
}

// ----- enter (build the weekly slot) -----

// Builds this week's slot (B1 draw + build) and persists it. Same-week re-entry returns the existing slot (resume)
// rather than redrawing — the lineup never re-rolls within a week. The LM config must be resolved by the caller
// BEFORE enter (an unconfigured LM fails fast 503 with nothing built).
export async function enterAuction({ root, authoringRoot, postContentScreen }) {
  if (typeof postContentScreen !== 'string' || !postContentScreen) throw new Error('auction postContentScreen is required');
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const existing = readAuctionSlotForWeek(state, week);
  if (existing) {
    // Resume: the week's slot is already built (in progress or closed). Return it unchanged.
    const consignment = readConsignmentForWeek(state, week);
    return {
      ...(await slotStateView({ root, slot: existing })),
      consignment: consignment ? consignmentStateView(consignment) : null,
      post_content_screen: postContentScreen
    };
  }
  const catalog = await loadAuctionCatalog({ root });
  const roster = await loadAuctionRoster({ root, authoringRoot });
  const soldLedger = readAuctionSoldLedger(state);
  const previousLotItemIds = readPreviousLotItemIds(state, week);
  const draw = drawWeeklyAuctionLots({ week, roster, soldLedger, previousLotItemIds, catalog });
  // 星の揺り籠 connection (落札側): with a week-seed-deterministic AUCTION_CREATURE_LOT_CHANCE probability, lot 1 is
  // a generated 籠入りの生き物 lot instead of its catalog item. The catalog draw stays intact upstream (so lots 2/3
  // are unchanged from a non-creature week), and only lot 0 is overlaid — a generated one-off that is NOT sold-ledger
  // or prior-week tracked (the weekly chance + seed disperse it naturally). A non-creature week is byte-identical.
  const lots = auctionCreatureLotForWeek(week)
    ? [buildAuctionCreatureLot({ week, bidders: draw.bidders, catalog, starCradleCatalog: await loadStarCradleCatalog({ root }) }), ...draw.lots.slice(1)]
    : draw.lots;
  const slot = buildAuctionSlot({ week, bidders: draw.bidders, lots });
  const latest = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, {
    ...latest,
    current_screen: 'academy-auction',
    [ROUTING_AUCTION_STATE_KEY]: slot
  });
  // A fresh week slot has no consignment decision yet (未決＝frontend shows the 出品 options before lot 1).
  return { ...(await slotStateView({ root, slot })), consignment: null, post_content_screen: postContentScreen };
}

// The prior week's lot item ids, used to suppress a re-listable (treasure/flavor) item two weeks running. Read
// from a small persisted ledger of the last week's drawn item ids; absent = no suppression.
function readPreviousLotItemIds(state, week) {
  const record = state?.auction_previous_lots ?? null;
  if (record === null || record === undefined) return [];
  if (typeof record !== 'object' || Array.isArray(record)) throw new Error('auction_previous_lots must be an object or absent');
  if (record.week === week) return []; // same week already built — handled by resume, not suppression
  return Array.isArray(record.item_ids) ? record.item_ids : [];
}

// ----- current-lot access -----

function requireInProgressSlot(state, week) {
  const slot = readAuctionSlotForWeek(state, week);
  if (!slot) throw statusError('no auction is open this week', 409, { errorCode: 'AUCTION_NOT_OPEN' });
  if (slot.status === 'closed') throw statusError('this week\'s auction has closed', 409, { errorCode: 'AUCTION_CLOSED' });
  return slot;
}

function requireCurrentLot(slot, lotIndex) {
  if (lotIndex !== slot.current_lot_index) {
    throw statusError(`auction lot ${lotIndex} is not the current lot ${slot.current_lot_index}`, 409, { errorCode: 'AUCTION_LOT_NOT_CURRENT' });
  }
  return slot.lots[lotIndex];
}

async function loadSlotForStep({ root, lotIndex }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const slot = requireInProgressSlot(state, week);
  const lot = requireCurrentLot(slot, requiredInteger(lotIndex, 'lot_index', { min: 0 }));
  return { storage, state, week, slot, lot };
}

// ----- streamed master speeches / reactions (chat 経路・onDelta) -----

export async function streamMasterOpening({ root, config, lotIndex, priorUtterances, onDelta, fetchImpl }) {
  const { lot } = await loadSlotForStep({ root, lotIndex });
  const speechConstraints = await loadMasterSpeechConstraints({ root, chatModel: config?.chat_model });
  const utterance = await generateAuctionMasterOpening({
    config, fetchImpl, onDelta, lot, speechConstraints, priorUtterances: normalizePriorUtterances(priorUtterances)
  });
  return { lot_index: lot.lot_index, utterance };
}

export async function streamMasterGoad({ root, config, lotIndex, current, bidderName, priorUtterances, onDelta, fetchImpl }) {
  const { lot } = await loadSlotForStep({ root, lotIndex });
  const speechConstraints = await loadMasterSpeechConstraints({ root, chatModel: config?.chat_model });
  const utterance = await generateAuctionMasterGoad({
    config, fetchImpl, onDelta, lot, current: requiredInteger(current, 'current', { min: 1 }), bidderName,
    speechConstraints, priorUtterances: normalizePriorUtterances(priorUtterances)
  });
  return { lot_index: lot.lot_index, utterance };
}

export async function streamReaction({ root, authoringRoot, config, lotIndex, characterId, priorReactions, onDelta, fetchImpl }) {
  const { slot, lot } = await loadSlotForStep({ root, lotIndex });
  assertSeatedBidder(slot, characterId);
  const bidder = await loadBidderPersona({ root, authoringRoot, characterId });
  const { worldDescription, speechConstraints, actorContext } = await loadBidderConversationContext({ root, authoringRoot, characterId, chatModel: config?.chat_model });
  const utterance = await generateAuctionReaction({
    config, fetchImpl, onDelta, bidder, lot, priorReactions: priorReactions ?? [],
    worldDescription, speechConstraints, actorContext
  });
  return { lot_index: lot.lot_index, character_id: bidder.character_id, display_name: bidder.display_name, utterance };
}

// The master 落札宣言: read AFTER resolveAuctionLot has recorded the award. `lotIndex` is the just-resolved lot,
// which is now the slot's previous lot (current_lot_index advanced past it). Only an `awarded` lot gets a hammer;
// a passed_in (流札) lot has no LLM announcement (authored 地の演出 covers it on the client).
export async function streamMasterHammer({ root, config, lotIndex, priorUtterances, onDelta, fetchImpl }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const slot = readAuctionSlotForWeek(state, week);
  if (!slot) throw statusError('no auction is open this week', 409, { errorCode: 'AUCTION_NOT_OPEN' });
  const index = requiredInteger(lotIndex, 'lot_index', { min: 0 });
  const award = slot.awards[index];
  if (!award) throw statusError(`auction lot ${index} has not been resolved yet`, 409, { errorCode: 'AUCTION_LOT_NOT_RESOLVED' });
  if (award.outcome !== 'awarded') {
    throw statusError(`auction lot ${index} was passed in; there is no hammer announcement`, 409, { errorCode: 'AUCTION_LOT_PASSED_IN' });
  }
  const lot = slot.lots[index];
  const winnerName = award.winner_character_id === PLAYER_WINNER_ID
    ? PLAYER_WINNER_LABEL
    : bidderDisplayName(slot, award.winner_character_id);
  const speechConstraints = await loadMasterSpeechConstraints({ root, chatModel: config?.chat_model });
  const utterance = await generateAuctionMasterHammer({
    config, fetchImpl, onDelta, lot, price: award.amount, winnerName,
    speechConstraints, priorUtterances: normalizePriorUtterances(priorUtterances)
  });
  return { lot_index: index, utterance };
}

// Validates the client-carried bid history (a raw request field): each entry is { display_name, action:
// bid|pass, amount? }. A malformed entry is bad client input — a 400, not a 500 (it otherwise reaches
// formatBidHistory as a plain throw). Returns the normalized entries (a pass drops amount).
function normalizeBidHistory(history) {
  if (history === null || history === undefined) return [];
  if (!Array.isArray(history)) throw statusError('history must be an array', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
  return history.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw statusError(`history[${index}] must be an object`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    if (typeof entry.display_name !== 'string' || !entry.display_name.trim()) throw statusError(`history[${index}].display_name is required`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    if (entry.action !== 'bid' && entry.action !== 'pass') throw statusError(`history[${index}].action must be bid or pass`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    if (entry.action === 'bid' && (!Number.isInteger(entry.amount) || entry.amount <= 0)) {
      throw statusError(`history[${index}].amount must be a positive integer`, 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    }
    return { display_name: entry.display_name.trim(), action: entry.action, ...(entry.action === 'bid' ? { amount: entry.amount } : {}) };
  });
}

function assertSeatedBidder(slot, characterId) {
  if (!slot.bidders.some((bidder) => bidder.character_id === characterId)) {
    throw statusError(`auction bidder is not seated this week: ${characterId}`, 404, { errorCode: 'AUCTION_UNKNOWN_BIDDER' });
  }
}

function bidderDisplayName(slot, characterId) {
  const bidder = slot.bidders.find((entry) => entry.character_id === characterId);
  if (!bidder) throw statusError(`auction winner is not a seated bidder: ${characterId}`, 400, { errorCode: 'AUCTION_UNKNOWN_BIDDER' });
  return bidder.display_name;
}

// ----- NPC bid turn (structured + system re-validation) -----

// Resolves one NPC bid turn. The economic authority is the slot: minNext = current + lot.min_increment and the
// bidder's budget = lot.npc_budgets[characterId]. The LLM proposes { utterance, action, amount }; the system
// re-validation (resolveAuctionBidDecision) drops an out-of-range amount to a pass. `current` / `highestBidder`
// are the client-carried standing bid (re-validated: current >= initial_price). Returns the resolved decision
// and the new standing bid.
export async function resolveNpcBidTurn({ root, authoringRoot, config, lotIndex, characterId, current, highestBidder, highestBidderName, history, fetchImpl }) {
  const { slot, lot } = await loadSlotForStep({ root, lotIndex });
  assertSeatedBidder(slot, characterId);
  const normalizedCurrent = requiredInteger(current, 'current', { min: lot.initial_price });
  const normalizedHistory = normalizeBidHistory(history);
  const budget = lot.npc_budgets[characterId];
  if (!Number.isInteger(budget) || budget <= 0) throw new Error(`auction bidder has no budget for this lot: ${characterId}`);
  const minNext = normalizedCurrent + lot.min_increment;
  const bidder = await loadBidderPersona({ root, authoringRoot, characterId });
  const { worldDescription, speechConstraints, actorContext } = await loadBidderConversationContext({ root, authoringRoot, characterId, chatModel: config?.chat_model });
  const decision = await generateAuctionNpcBid({
    config,
    fetchImpl,
    bidder,
    lot,
    budget,
    current: normalizedCurrent,
    currentBidderName: highestBidderName,
    minNext,
    history: normalizedHistory,
    worldDescription,
    speechConstraints,
    actorContext
  });
  const resolvedCurrent = decision.action === 'bid' ? decision.amount : normalizedCurrent;
  const resolvedHighestBidder = decision.action === 'bid' ? characterId : (highestBidder ?? null);
  return {
    lot_index: lot.lot_index,
    character_id: bidder.character_id,
    display_name: bidder.display_name,
    utterance: decision.utterance,
    action: decision.action,
    amount: decision.amount,
    min_next: minNext,
    current: resolvedCurrent,
    highest_bidder: resolvedHighestBidder
  };
}

// ----- player bid / pass -----

// Applies the player's raised bid: the player answers with an ADD amount over the current price. Validated against
// the lot's min increment (add_amount >= min_increment, i.e. current + add_amount >= minNext) and the player's
// money (current + add_amount <= 所持金). An invalid amount is a 400 with an explicit code — never silently clamped.
export async function applyPlayerBid({ root, lotIndex, current, addAmount }) {
  const { lot } = await loadSlotForStep({ root, lotIndex });
  const normalizedCurrent = requiredInteger(current, 'current', { min: lot.initial_price });
  const add = requiredInteger(addAmount, 'add_amount', { min: 1 });
  if (add < lot.min_increment) {
    throw statusError(`the raise must be at least the minimum increment ${lot.min_increment}G: got ${add}G`, 400, { errorCode: 'AUCTION_BELOW_MIN_INCREMENT' });
  }
  const nextPrice = normalizedCurrent + add;
  const inventory = await loadInventory({ root });
  if (nextPrice > inventory.money) {
    throw statusError(`the bid ${nextPrice}G exceeds your money ${inventory.money}G`, 400, { errorCode: 'AUCTION_INSUFFICIENT_MONEY' });
  }
  return { lot_index: lot.lot_index, current: nextPrice, highest_bidder: PLAYER_WINNER_ID, money: inventory.money };
}

// The player drops out of the current lot. No server state changes (the standing bid is carried by the client);
// this only validates the lot is current and acknowledges the drop.
export async function applyPlayerPass({ root, lotIndex }) {
  const { lot } = await loadSlotForStep({ root, lotIndex });
  return { lot_index: lot.lot_index, player_active: false };
}

// ----- lot resolution (atomic award + slot advance + content result on close) -----

// Resolves the current lot: winner is 'player', a seated bidder, or null (流札). For a player win, the category
// writer runs LLM-gen → validate → atomic writer (money + surface); then the slot advances (recordAuctionLotAward)
// and, for a one-of-a-kind, the sold ledger updates — a single runtime_state write. For an NPC win, only the slot
// advance + sold ledger run (no player asset, no LLM). For 流札, only the slot advance. When the third lot resolves
// the auction closes and the week's content result is recorded. Returns the resolution + updated state view.
export async function resolveAuctionLot({ root, authoringRoot, config, lotIndex, winner, amount, fetchImpl, now = new Date().toISOString(), postContentScreen }) {
  const { storage, state, week, slot, lot } = await loadSlotForStep({ root, lotIndex });
  const catalog = await loadAuctionCatalog({ root });
  // A caged_creature lot is a generated one-off, not a catalog item — its lot item IS the award item. Every other
  // category resolves its normalized item from the catalog.
  const item = lot.item.category === 'caged_creature' ? lot.item : auctionCatalogItem(catalog, lot.item.item_id);

  if (winner === null || winner === undefined) {
    return await commitLotResolution({ storage, root, authoringRoot, slot, lotIndex, outcome: 'passed_in', winnerCharacterId: null, amount: null, catalog, week, now, postContentScreen });
  }

  const normalizedAmount = requiredInteger(amount, 'amount', { min: lot.initial_price });

  if (winner === PLAYER_WINNER_ID) {
    // Player win: run the category writer FIRST (its own atomic money + surface transaction). A gen or writer
    // failure throws here with money/surface untouched AND the slot not yet advanced.
    await runPlayerAward({ root, config, fetchImpl, item, week, price: normalizedAmount, catalog });
    return await commitLotResolution({ storage, root, authoringRoot, slot, lotIndex, outcome: 'awarded', winnerCharacterId: PLAYER_WINNER_ID, amount: normalizedAmount, catalog, week, now, postContentScreen });
  }

  // NPC win: no player asset, no LLM. Just record the award (and remove a one-of-a-kind from the world).
  bidderDisplayName(slot, winner); // fail-fast if the winner is not a seated bidder
  return await commitLotResolution({ storage, root, authoringRoot, slot, lotIndex, outcome: 'awarded', winnerCharacterId: winner, amount: normalizedAmount, catalog, week, now, postContentScreen });
}

// Runs the player's category-specific award, generating the LLM 銘/persona first and passing it to the B1 writer.
async function runPlayerAward({ root, config, fetchImpl, item, week, price, catalog }) {
  if (item.category === 'caged_creature') {
    // 星の揺り籠 connection: the caged instance enters star_cradle_creatures.json (name:null, feed:{}) with the money
    // debit, atomically. LM 非経由 — no naming/persona (the player names it later via the release flow).
    return await awardAuctionCagedCreatureToPlayer({ root, item, week, price });
  }
  if (item.category === 'weapon_amulet') {
    const roll = previewAuctionEquipmentRoll({ item, week });
    const { name, flavor } = await generateAuctionEquipmentNaming({ config, fetchImpl, roll, seedName: item.name });
    return await awardAuctionEquipmentToPlayer({ root, item, week, price, name, flavor });
  }
  if (item.category === 'treasure' || item.category === 'flavor') {
    return await awardAuctionItemToPlayer({ root, catalog, itemId: item.item_id, price });
  }
  if (item.category === 'being') {
    if (!canAdoptAuctionBeing(await loadHomunculiSurface({ root }))) {
      throw statusError('the atelier roster is full; a being cannot be adopted', 409, { errorCode: 'AUCTION_BEING_ROSTER_FULL' });
    }
    const { prompt_description, speaking_basis } = await generateAuctionBeingPersona({
      config,
      fetchImpl,
      name: item.name,
      temperamentSeed: item.temperament_seed,
      species: item.species
    });
    return await awardAuctionBeingToPlayer({ root, catalog, itemId: item.item_id, price, promptDescription: prompt_description, speakingBasis: speaking_basis });
  }
  throw new Error(`auction award unknown category: ${item.category}`);
}

// Commits the slot advance (+ sold ledger for a one-of-a-kind + content result on close + previous-lots ledger on
// close) in a single runtime_state write. Runs after any player writer has already committed its money/surface.
async function commitLotResolution({ storage, root, authoringRoot, slot, lotIndex, outcome, winnerCharacterId, amount, catalog, week, now, postContentScreen }) {
  const nextSlot = recordAuctionLotAward(slot, { lotIndex, outcome, winnerCharacterId, amount });
  const latest = await storage.readJson(RUNTIME_STATE_PATH);
  const nextState = { ...latest, [ROUTING_AUCTION_STATE_KEY]: nextSlot };

  // A one-of-a-kind (weapon/amulet 骨子・being) awarded to ANYONE (player or NPC) leaves the world. A caged_creature
  // lot is a generated one-off, never sold-ledger tracked (and its item_id is a 種卵 id, not a catalog item), so it
  // is skipped here.
  if (outcome === 'awarded' && slot.lots[lotIndex].item.category !== 'caged_creature') {
    const ledger = readAuctionSoldLedger(latest);
    const nextLedger = nextAuctionSoldLedger({ ledger, catalog, itemId: slot.lots[lotIndex].item.item_id });
    if (nextLedger !== ledger) nextState[AUCTION_SOLD_LEDGER_STATE_KEY] = nextLedger;
  }

  let contentResult = null;
  if (nextSlot.status === 'closed') {
    contentResult = buildAuctionContentResult({ week, now, lots: auctionResultLots(nextSlot) });
    nextState[ROUTING_CONTENT_RESULT_STATE_KEY] = contentResult;
    // The prior-week suppression ledger is catalog items only: a caged_creature lot is a generated one-off (not
    // prior-week tracked), so it is excluded here.
    nextState.auction_previous_lots = { week, item_ids: nextSlot.lots.filter((lot) => lot.item.category !== 'caged_creature').map((lot) => lot.item.item_id) };
    if (typeof postContentScreen === 'string' && postContentScreen) nextState.current_screen = postContentScreen;
  }

  await storage.writeJson(RUNTIME_STATE_PATH, nextState);
  return {
    resolution: {
      lot_index: lotIndex,
      outcome,
      winner_character_id: winnerCharacterId,
      amount,
      closed: nextSlot.status === 'closed'
    },
    content_result: contentResult ? contentResult.detail : null,
    ...(nextSlot.status === 'closed' && typeof postContentScreen === 'string' && postContentScreen ? { post_content_screen: postContentScreen } : {}),
    state: await slotStateView({ root, slot: nextSlot })
  };
}

// Maps a closed slot's awards + lots to the content-result lot summaries.
function auctionResultLots(slot) {
  return slot.awards.map((award, index) => {
    const lot = slot.lots[index];
    if (award.outcome === 'passed_in') {
      return { item_name: lot.item.name, category: lot.item.category, band: lot.band, result: 'passed_in', price: null, winner_display_name: null };
    }
    const wonByPlayer = award.winner_character_id === PLAYER_WINNER_ID;
    return {
      item_name: lot.item.name,
      category: lot.item.category,
      band: lot.band,
      result: wonByPlayer ? 'won_by_player' : 'won_by_other',
      price: award.amount,
      winner_display_name: wonByPlayer ? null : bidderDisplayName(slot, award.winner_character_id)
    };
  });
}

// ===== consignment (player-listed lot・出品側) =====
//
// The player consigns ONE owned asset per visit (before house lot 1): an unequipped equipment instance or a
// sell_price>0 inventory item. The seated NPC bidders (the week's slot bidders) run an NPC-ONLY ascending loop —
// the player does NOT bid on their own lot — and an NPC win pays the winning bid to the player IN EXCHANGE FOR the
// asset (payoutConsignmentToPlayer), 流札 leaves the asset with the player. The consignment lives in its own state
// key (ROUTING_AUCTION_CONSIGNMENT), so the house 3-lot slot is untouched; the frontend carries the in-progress
// NPC bidding (current price / highest bidder / who has dropped) exactly as it carries a house lot's, and the
// server re-validates each turn against the persisted consignment (npc_budgets / min_increment / initial_price).

// The consignment's public view (never the non-public npc_budgets).
function consignmentStateView(record) {
  if (record.status === 'skipped') return { status: 'skipped', week: record.week };
  return {
    status: record.status,
    week: record.week,
    source: record.source,
    presentation: record.presentation,
    band: record.band,
    initial_price: record.initial_price,
    min_increment: record.min_increment,
    ...(record.award ? { award: record.award } : {})
  };
}

// Validates the client-supplied consignment source (an equipment instance or an inventory item id). A malformed
// field is bad client input (400), never silently coerced.
function normalizeConsignmentSourceInput(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw statusError('source must be an object', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
  }
  if (source.kind === 'equipment') {
    if (typeof source.instance_id !== 'string' || !source.instance_id.trim()) {
      throw statusError('source.instance_id is required', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    }
    return { kind: 'equipment', instance_id: source.instance_id.trim() };
  }
  if (source.kind === 'item') {
    if (typeof source.item_id !== 'string' || !source.item_id.trim()) {
      throw statusError('source.item_id is required', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    }
    return { kind: 'item', item_id: source.item_id.trim() };
  }
  if (source.kind === 'star_cradle_creature') {
    if (typeof source.instance_id !== 'string' || !source.instance_id.trim()) {
      throw statusError('source.instance_id is required', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
    }
    return { kind: 'star_cradle_creature', instance_id: source.instance_id.trim() };
  }
  throw statusError('source.kind must be equipment, item, or star_cradle_creature', 400, { errorCode: 'AUCTION_BAD_REQUEST' });
}

// The 籠入りの生き物 presentation + band + value anchor for a consignable caged instance (星の揺り籠 connection・
// 出品側). The variety/変貌 identity is re-derived from the instance's (item_id, seed, feed) by C-28's roll; the band
// follows the shared rarity/変貌 rule (common→C, rare or 変貌→B) and the value anchor is that band's authored floor
// price. A revealed (adult) individual is the only thing that can be caged, so nothing hidden leaks.
function cagedCreatureConsignment({ catalog, starCradleCatalog, instance }) {
  const { variety, mutation } = resolveCreatureIdentity(starCradleCatalog, instance);
  const band = auctionCagedCreatureBand({ variety, mutation });
  const individualName = typeof instance.name === 'string' && instance.name.trim() ? `「${instance.name.trim()}」` : '';
  const presentation = {
    name: `籠入りの${variety.name}${individualName}`,
    category_label: '籠入りの生き物',
    blurb: mutation ? `${variety.flavor}（${mutation.name}）` : variety.flavor
  };
  return { band, presentation, valueAnchor: catalog.price_bands[band].price_min };
}

// The consignment presentation for an equipment instance: 銘 (name) + 来歴 (flavor) as the 触れ込み. A weapon reads
// as 武器, an amulet as 護符 (the same category labels the house weapon presentation uses).
function consignmentEquipmentPresentation(instance) {
  const name = typeof instance?.name === 'string' ? instance.name.trim() : '';
  const flavor = typeof instance?.flavor === 'string' ? instance.flavor.trim() : '';
  if (!name || !flavor) {
    throw statusError('the equipment instance is missing its name/flavor', 409, { errorCode: 'AUCTION_CONSIGNMENT_NOT_CONSIGNABLE' });
  }
  return { name, category_label: instance.kind === 'amulet' ? '護符' : '武器', blurb: flavor };
}

// Resolves a consignment source to { source, presentation, band, valueAnchor }, failing fast when the asset is not
// (any longer) consignable: an unknown / equipped equipment instance, an unheld / no-sell-value inventory item, or
// an unknown caged creature. The band is resolved per source kind — equipment/item map their value anchor through
// bandForConsignmentValue, a caged creature bands by its rarity/変貌 rule — so the caller never re-derives it. Used
// both at submit (list the lot) and at resolve (re-validate before the payout writer runs).
async function resolveConsignmentAsset({ root, storage, state, catalog, source }) {
  const normalized = normalizeConsignmentSourceInput(source);
  if (normalized.kind === 'equipment') {
    const surface = await loadEquipmentSurface({ storage });
    const instance = findEquipmentInstance(surface, normalized.instance_id);
    if (!instance) throw statusError(`unknown equipment instance: ${normalized.instance_id}`, 404, { errorCode: 'AUCTION_CONSIGNMENT_UNKNOWN_ASSET' });
    if (equippedInstanceIds(state).has(normalized.instance_id)) {
      throw statusError('an equipped item cannot be consigned; unequip it first', 409, { errorCode: 'AUCTION_CONSIGNMENT_ASSET_EQUIPPED' });
    }
    const valueAnchor = auctionConsignmentEquipmentMarketValue(equipmentSellPrice({ tier: instance.tier, quality: instance.quality }));
    return { source: normalized, presentation: consignmentEquipmentPresentation(instance), band: bandForConsignmentValue(catalog, valueAnchor), valueAnchor };
  }
  if (normalized.kind === 'star_cradle_creature') {
    const starCradleCatalog = await loadStarCradleCatalog({ root });
    const cagedSurface = await loadStarCradleCreaturesSurface({ storage });
    const instance = cagedSurface.instances.find((entry) => entry.instance_id === normalized.instance_id);
    if (!instance) throw statusError(`unknown caged creature: ${normalized.instance_id}`, 404, { errorCode: 'AUCTION_CONSIGNMENT_UNKNOWN_ASSET' });
    const { band, presentation, valueAnchor } = cagedCreatureConsignment({ catalog, starCradleCatalog, instance });
    return { source: normalized, presentation, band, valueAnchor };
  }
  const inventory = await loadInventory({ root });
  const item = inventory.items.find((entry) => entry.item_id === normalized.item_id);
  if (!item || !(item.quantity > 0)) throw statusError(`you do not hold that item: ${normalized.item_id}`, 404, { errorCode: 'AUCTION_CONSIGNMENT_UNKNOWN_ASSET' });
  if (!Number.isInteger(item.sell_price) || item.sell_price <= 0) {
    throw statusError(`that item cannot be consigned (no sell value): ${normalized.item_id}`, 409, { errorCode: 'AUCTION_CONSIGNMENT_NOT_CONSIGNABLE' });
  }
  const blurb = typeof item.description === 'string' ? item.description.trim() : '';
  if (!blurb) throw statusError(`that item cannot be consigned (no description): ${normalized.item_id}`, 409, { errorCode: 'AUCTION_CONSIGNMENT_NOT_CONSIGNABLE' });
  const valueAnchor = auctionConsignmentItemMarketValue(item.sell_price);
  return {
    source: normalized,
    presentation: { name: item.name, category_label: '所持品', blurb },
    band: bandForConsignmentValue(catalog, valueAnchor),
    valueAnchor
  };
}

// Requires the current week's slot to be open with the consignment window still available (before house lot 1) and
// no consignment decided yet. Returns the open slot.
function requireConsignmentWindow(state, week) {
  const slot = readAuctionSlotForWeek(state, week);
  if (!slot) throw statusError('no auction is open this week', 409, { errorCode: 'AUCTION_NOT_OPEN' });
  if (slot.status === 'closed') throw statusError('this week\'s auction has closed', 409, { errorCode: 'AUCTION_CLOSED' });
  if (slot.current_lot_index !== 0) throw statusError('the consignment window has passed', 409, { errorCode: 'AUCTION_CONSIGNMENT_WINDOW_PASSED' });
  if (readConsignmentForWeek(state, week)) throw statusError('the consignment for this week is already decided', 409, { errorCode: 'AUCTION_CONSIGNMENT_DECIDED' });
  return slot;
}

// Lists the player's consignable assets for the visit: unequipped equipment instances + sell_price>0 inventory
// items, each with its value anchor and the band that anchor maps to (so the client can preview the lot tier).
export async function listConsignableItems({ root }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const catalog = await loadAuctionCatalog({ root });
  const surface = await loadEquipmentSurface({ storage });
  const equipped = equippedInstanceIds(state);
  const equipment = surface.instances
    .filter((instance) => !equipped.has(instance.instance_id))
    .map((instance) => {
      const valueAnchor = auctionConsignmentEquipmentMarketValue(equipmentSellPrice({ tier: instance.tier, quality: instance.quality }));
      const presentation = consignmentEquipmentPresentation(instance);
      return { kind: 'equipment', instance_id: instance.instance_id, ...presentation, value_anchor: valueAnchor, band: bandForConsignmentValue(catalog, valueAnchor) };
    });
  const inventory = await loadInventory({ root });
  const items = inventory.items
    .filter((item) => Number.isInteger(item.sell_price) && item.sell_price > 0 && item.quantity > 0)
    .map((item) => {
      const valueAnchor = auctionConsignmentItemMarketValue(item.sell_price);
      return {
        kind: 'item',
        item_id: item.item_id,
        name: item.name,
        category_label: '所持品',
        blurb: typeof item.description === 'string' ? item.description : '',
        quantity: item.quantity,
        value_anchor: valueAnchor,
        band: bandForConsignmentValue(catalog, valueAnchor)
      };
    });
  // 星の揺り籠 connection (出品側): the player's caged creatures are consignable too, each with its rarity/変貌 band
  // and that band's floor as the value anchor.
  const starCradleCatalog = await loadStarCradleCatalog({ root });
  const cagedSurface = await loadStarCradleCreaturesSurface({ storage });
  const caged = cagedSurface.instances.map((instance) => {
    const { band, presentation, valueAnchor } = cagedCreatureConsignment({ catalog, starCradleCatalog, instance });
    return { kind: 'star_cradle_creature', instance_id: instance.instance_id, name: presentation.name, category_label: presentation.category_label, blurb: presentation.blurb, value_anchor: valueAnchor, band };
  });
  return { week, equipment, items, caged };
}

// Lists the chosen asset as this visit's consignment lot (before house lot 1). Persists the built lot (band /
// initial price / min increment / per-bidder budgets) under its own state key. Fails fast if the window has passed
// or a consignment is already decided.
export async function submitConsignment({ root, authoringRoot, source }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const slot = requireConsignmentWindow(state, week);
  const catalog = await loadAuctionCatalog({ root });
  const resolved = await resolveConsignmentAsset({ root, storage, state, catalog, source });
  const consignment = buildConsignmentLot({
    week,
    source: resolved.source,
    presentation: resolved.presentation,
    band: resolved.band,
    valueAnchor: resolved.valueAnchor,
    bidders: slot.bidders,
    catalog
  });
  const latest = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, { ...latest, [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]: consignment });
  return consignmentStateView(consignment);
}

// Declines to consign this visit (skip straight to the house lots). Terminal per-week decision.
export async function skipConsignment({ root }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  requireConsignmentWindow(state, week);
  const skip = buildConsignmentSkip(week);
  const latest = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, { ...latest, [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]: skip });
  return consignmentStateView(skip);
}

// Reads the current week's LISTED consignment for a bidding step, or fails fast when none is open for bidding.
async function loadConsignmentForStep({ root }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const slot = readAuctionSlotForWeek(state, week);
  if (!slot) throw statusError('no auction is open this week', 409, { errorCode: 'AUCTION_NOT_OPEN' });
  const consignment = readConsignmentForWeek(state, week);
  if (!consignment || consignment.status !== 'listed') {
    throw statusError('no consignment lot is open for bidding', 409, { errorCode: 'AUCTION_CONSIGNMENT_NOT_OPEN' });
  }
  return { storage, state, week, slot, consignment };
}

// A lot-shaped view of the consignment for the generation builders (which only read initial_price / min_increment
// when a `presentation` override is supplied).
function consignmentLotShape(consignment) {
  return { initial_price: consignment.initial_price, min_increment: consignment.min_increment };
}

// The consignment 出品披露口上 (master opening・出品 variant). First utterance of the visit, so priorUtterances is
// normally empty; the field is accepted for uniformity with the house openings.
export async function streamConsignmentOpening({ root, config, priorUtterances, onDelta, fetchImpl }) {
  const { consignment } = await loadConsignmentForStep({ root });
  const speechConstraints = await loadMasterSpeechConstraints({ root, chatModel: config?.chat_model });
  const utterance = await generateAuctionMasterOpening({
    config, fetchImpl, onDelta,
    lot: consignmentLotShape(consignment),
    presentation: consignment.presentation,
    consignment: true,
    speechConstraints,
    priorUtterances: normalizePriorUtterances(priorUtterances)
  });
  return { utterance };
}

// One character reaction to the consigned lot (数珠つなぎ threads priorReactions). Structurally identical to a house
// reaction (v1: the 委託明示 line is bid-loop only), only the presentation is the consigned asset's.
export async function streamConsignmentReaction({ root, authoringRoot, config, characterId, priorReactions, onDelta, fetchImpl }) {
  const { slot, consignment } = await loadConsignmentForStep({ root });
  assertSeatedBidder(slot, characterId);
  const bidder = await loadBidderPersona({ root, authoringRoot, characterId });
  const { worldDescription, speechConstraints, actorContext } = await loadBidderConversationContext({ root, authoringRoot, characterId, chatModel: config?.chat_model });
  const utterance = await generateAuctionReaction({
    config, fetchImpl, onDelta, bidder,
    lot: consignmentLotShape(consignment),
    presentation: consignment.presentation,
    priorReactions: priorReactions ?? [],
    worldDescription, speechConstraints, actorContext
  });
  return { character_id: bidder.character_id, display_name: bidder.display_name, utterance };
}

// One NPC bid turn on the consigned lot. Economics come from the persisted consignment (budget / min_increment /
// initial_price); the prompt carries the 委託明示 line (consignment:true). The player never takes a turn here.
export async function resolveConsignmentNpcBidTurn({ root, authoringRoot, config, characterId, current, highestBidder, highestBidderName, history, fetchImpl }) {
  const { slot, consignment } = await loadConsignmentForStep({ root });
  assertSeatedBidder(slot, characterId);
  const normalizedCurrent = requiredInteger(current, 'current', { min: consignment.initial_price });
  const normalizedHistory = normalizeBidHistory(history);
  const budget = consignment.npc_budgets[characterId];
  if (!Number.isInteger(budget) || budget <= 0) throw new Error(`auction bidder has no budget for this consignment: ${characterId}`);
  const minNext = normalizedCurrent + consignment.min_increment;
  const bidder = await loadBidderPersona({ root, authoringRoot, characterId });
  const { worldDescription, speechConstraints, actorContext } = await loadBidderConversationContext({ root, authoringRoot, characterId, chatModel: config?.chat_model });
  const decision = await generateAuctionNpcBid({
    config, fetchImpl, bidder,
    lot: consignmentLotShape(consignment),
    presentation: consignment.presentation,
    consignment: true,
    budget,
    current: normalizedCurrent,
    currentBidderName: highestBidderName,
    minNext,
    history: normalizedHistory,
    worldDescription, speechConstraints, actorContext
  });
  const resolvedCurrent = decision.action === 'bid' ? decision.amount : normalizedCurrent;
  const resolvedHighestBidder = decision.action === 'bid' ? characterId : (highestBidder ?? null);
  return {
    character_id: bidder.character_id,
    display_name: bidder.display_name,
    utterance: decision.utterance,
    action: decision.action,
    amount: decision.amount,
    min_next: minNext,
    current: resolvedCurrent,
    highest_bidder: resolvedHighestBidder
  };
}

// Resolves the consigned lot: a seated NPC won (payout writer credits the winning bid IN EXCHANGE FOR the asset)
// or 流札 (the asset stays with the player). Like the house player-award order, the payout writer (its own atomic
// money+asset transaction) runs FIRST; only after it commits is the consignment marked resolved. A generation-free
// resolution (no LLM). Known limitation (identical to the house lot): the narrow crash window between the payout
// commit and the consignment-resolved write is one lot's, accepted for the single-player local save.
export async function resolveConsignmentLot({ root, authoringRoot, config, winner, amount, fetchImpl }) {
  const { storage, state, week, slot, consignment } = await loadConsignmentForStep({ root });

  if (winner === null || winner === undefined) {
    const next = recordConsignmentResolution(consignment, { outcome: 'passed_in' });
    const latest = await storage.readJson(RUNTIME_STATE_PATH);
    await storage.writeJson(RUNTIME_STATE_PATH, { ...latest, [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]: next });
    return { resolution: { outcome: 'passed_in', winner_character_id: null, amount: null }, consignment: consignmentStateView(next), payout: null };
  }

  bidderDisplayName(slot, winner); // fail-fast if the winner is not a seated bidder
  const normalizedAmount = requiredInteger(amount, 'amount', { min: consignment.initial_price });
  // Re-validate the asset is still available, then run the payout writer FIRST (atomic money + asset). A failure
  // here leaves money, the asset, AND the consignment record untouched.
  const catalog = await loadAuctionCatalog({ root });
  await resolveConsignmentAsset({ root, storage, state, catalog, source: consignment.source });
  const payout = await payoutConsignmentToPlayer({ root, source: consignment.source, amount: normalizedAmount });
  const next = recordConsignmentResolution(consignment, { outcome: 'awarded', winnerCharacterId: winner, amount: normalizedAmount });
  const latest = await storage.readJson(RUNTIME_STATE_PATH);
  await storage.writeJson(RUNTIME_STATE_PATH, { ...latest, [ROUTING_AUCTION_CONSIGNMENT_STATE_KEY]: next });
  return {
    resolution: { outcome: 'awarded', winner_character_id: winner, amount: normalizedAmount },
    consignment: consignmentStateView(next),
    payout: { source: payout.source, amount: payout.amount, money: payout.inventory.money }
  };
}

// The consignment 落札宣言 (master hammer): read AFTER resolveConsignmentLot recorded an `awarded` outcome. A 流札
// consignment has no hammer (the client covers it with authored 地の演出).
export async function streamConsignmentHammer({ root, config, priorUtterances, onDelta, fetchImpl }) {
  const storage = createStorageApi({ root });
  const state = await storage.readJson(RUNTIME_STATE_PATH);
  const week = auctionWeekFromState(state);
  const slot = readAuctionSlotForWeek(state, week);
  if (!slot) throw statusError('no auction is open this week', 409, { errorCode: 'AUCTION_NOT_OPEN' });
  const consignment = readConsignmentForWeek(state, week);
  if (!consignment || consignment.status !== 'resolved') {
    throw statusError('the consignment has not been resolved yet', 409, { errorCode: 'AUCTION_CONSIGNMENT_NOT_RESOLVED' });
  }
  if (consignment.award.outcome !== 'awarded') {
    throw statusError('the consignment was passed in; there is no hammer announcement', 409, { errorCode: 'AUCTION_LOT_PASSED_IN' });
  }
  const winnerName = bidderDisplayName(slot, consignment.award.winner_character_id);
  const speechConstraints = await loadMasterSpeechConstraints({ root, chatModel: config?.chat_model });
  const utterance = await generateAuctionMasterHammer({
    config, fetchImpl, onDelta,
    lot: consignmentLotShape(consignment),
    presentation: consignment.presentation,
    price: consignment.award.amount,
    winnerName,
    speechConstraints,
    priorUtterances: normalizePriorUtterances(priorUtterances)
  });
  return { utterance };
}
