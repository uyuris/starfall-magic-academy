// Weekly errand offers: the build-or-load orchestration for the routing "依頼"
// destination's three offers.
//
// GET /api/errand reads the runtime_state slot `routing_weekly_errand_offers`. When it
// is present AND its week matches the current elapsed_weeks, the persisted three offers
// are returned as-is with no LLM call. Otherwise the offers are (re)generated:
//   1. drawWeeklyErrandSkeletons fixes the deterministic skeleton — three distinct
//      types, a band-bounded reward each, and a unique client each (no LLM).
//   2. per offer, sequentially, the client's memory materials are read and the offer
//      text (title / situation / motivation) is generated and gated.
//   3. only once ALL three pass the gate is the slot written in one commit.
//
// Any generation or gate failure throws with NOTHING persisted — no partial slot, no
// authored-text fallback, no silent retry. This is the errand analogue of the craft
// naming 2-stage gate.

import { createStorageApi } from './storage.mjs';
import {
  validateErrandOfferText,
  ERRAND_GENERATION_FAILED_ERROR_CODE
} from './llm/errandOffer.mjs';
import { generateGatedOfferTextWithRetry } from './llm/offerGenerationRetry.mjs';
import {
  ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY,
  drawWeeklyErrandSkeletons,
  readWeeklyErrandOffers,
  validateWeeklyErrandOffers
} from './routingErrands.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

function currentWeek(state) {
  const week = state?.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw new Error('runtime_state.elapsed_weeks must be a non-negative integer');
  }
  return week;
}

function charactersById(characters) {
  if (!Array.isArray(characters)) throw new Error('selectable characters must be an array');
  const byId = new Map();
  for (const character of characters) {
    const id = String(character?.character_id ?? '').trim();
    if (id) byId.set(id, character);
  }
  return byId;
}

// Reads the persisted weekly offers when fresh, otherwise generates, gates, and persists
// a new set. `memoriesFor(clientCharacterId)` returns the client's raw memory records (or
// []); the client persona (name / standing / speaking basis) is read from the passed-in
// `characters` summaries; `generateOfferText({ type, clientDisplayName, persona, memories })`
// returns the offer text candidate (mock or real) — its output is re-gated here so the
// persisted set is always validator-clean regardless of provider. Returns
// { week, offers, generated }.
export async function buildOrLoadWeeklyErrandOffers({
  root,
  storage,
  catalog,
  characters,
  memoriesFor,
  generateOfferText
} = {}) {
  if (typeof memoriesFor !== 'function') throw new Error('memoriesFor is required');
  if (typeof generateOfferText !== 'function') throw new Error('generateOfferText is required');
  const api = storage ?? createStorageApi({ root });

  const state = await api.readJson(RUNTIME_STATE_PATH);
  const week = currentWeek(state);
  const existing = readWeeklyErrandOffers(state);
  if (existing && existing.week === week) {
    return { week: existing.week, offers: existing.offers, generated: false };
  }

  const { skeletons } = drawWeeklyErrandSkeletons({ state, catalog, characters });
  const characterById = charactersById(characters);

  const offers = [];
  for (const skeleton of skeletons) {
    const character = characterById.get(skeleton.client_character_id);
    if (!character) throw new Error(`errand client is not a selectable character: ${skeleton.client_character_id}`);
    const clientDisplayName = String(character.display_name ?? '').trim();
    if (!clientDisplayName) throw new Error(`errand client has no display name: ${skeleton.client_character_id}`);
    const memories = await memoriesFor(skeleton.client_character_id);
    // The persona (name / standing / character description / speaking basis) drives both the
    // character-fit skeleton and the own-voice appeal. The character summary from
    // listSelectableCharacters already carries all five conversation-persona fields (including
    // the sanitized prompt_description), so this builds the persona from it directly; the
    // offer/appeal prompt builders are the gate on their required fields. Bounded retry on
    // gate/validate violations only (LLM 出力の確率的ゲート違反を同一 skeleton で再生成して吸収
    // する)。LM 設定不備・接続不能・HTTP・parse は retry されず即 fail-fast。
    const text = await generateGatedOfferTextWithRetry({
      generate: () => generateOfferText({
        type: { id: skeleton.type_id, category: skeleton.category, name: skeleton.name },
        clientDisplayName,
        persona: {
          display_name: clientDisplayName,
          school_year: character.school_year,
          identity: character.identity,
          prompt_description: character.prompt_description,
          speaking_basis: character.speaking_basis
        },
        memories
      }),
      validate: validateErrandOfferText,
      generationErrorCode: ERRAND_GENERATION_FAILED_ERROR_CODE
    });
    offers.push({
      errand_id: skeleton.type_id,
      type_id: skeleton.type_id,
      title: text.title,
      situation: text.situation,
      motivation: text.motivation,
      appeal: text.appeal,
      condition_text: skeleton.condition_text,
      reward_money: skeleton.reward_money,
      client_character_id: skeleton.client_character_id
    });
  }

  const persisted = validateWeeklyErrandOffers({ week, offers });

  // Atomic commit: re-read the freshest state and write the whole slot once, only after
  // all three offers passed the gate above.
  const stateForWrite = await api.readJson(RUNTIME_STATE_PATH);
  await api.writeJson(RUNTIME_STATE_PATH, {
    ...stateForWrite,
    [ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY]: persisted
  });

  return { week: persisted.week, offers: persisted.offers, generated: true };
}
