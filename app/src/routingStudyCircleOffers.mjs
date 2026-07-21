// Weekly study circle offers: the build-or-load orchestration for the routing "研究会"
// destination's three offers.
//
// GET /api/study-circle reads the runtime_state slot `routing_weekly_study_circle_offers`.
// When it is present AND its week matches the current elapsed_weeks, the persisted three
// offers are returned as-is with no LLM call. Otherwise the offers are (re)generated:
//   1. drawWeeklyStudyCircleSkeletons fixes the deterministic skeleton — three distinct
//      themes, a type drawn from each theme, a unique host each, and a band-rolled per-
//      parameter reward (no LLM).
//   2. per offer, sequentially, the host's memory materials are read and the offer text
//      (title / situation / motivation) is generated and gated.
//   3. only once ALL three pass the gate is the slot written in one commit.
//
// Any generation or gate failure throws with NOTHING persisted — no partial slot, no
// authored-text fallback, no silent retry. This is the study circle analogue of the errand
// offer 2-stage gate.

import { createStorageApi } from './storage.mjs';
import {
  validateStudyCircleOfferText,
  STUDY_CIRCLE_GENERATION_FAILED_ERROR_CODE
} from './llm/studyCircleOffer.mjs';
import { generateGatedOfferTextWithRetry } from './llm/offerGenerationRetry.mjs';
import {
  ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY,
  drawWeeklyStudyCircleSkeletons,
  readWeeklyStudyCircleOffers,
  validateWeeklyStudyCircleOffers
} from './routingStudyCircle.mjs';

const RUNTIME_STATE_PATH = 'game_data/runtime_state.json';

function currentWeek(state) {
  const week = state?.elapsed_weeks;
  if (!Number.isInteger(week) || week < 0) {
    throw new Error('runtime_state.elapsed_weeks must be a non-negative integer');
  }
  return week;
}

// Reads the persisted weekly offers when fresh, otherwise generates, gates, and persists a
// new set. `memoriesFor(hostCharacterId)` returns the host's raw memory records (or []);
// `personaFor(hostCharacterId)` returns the host persona (name / standing / character
// description / speaking basis) that both the character-fit skeleton and the own-voice appeal
// need; `generateOfferText({ type, hostDisplayName, persona, memories })` returns the offer
// text candidate (mock or real) — its output is re-gated here so the persisted set is always
// validator-clean regardless of provider. Returns { week, offers, generated }.
export async function buildOrLoadWeeklyStudyCircleOffers({
  root,
  storage,
  catalog,
  definitions,
  memoriesFor,
  personaFor,
  generateOfferText
} = {}) {
  if (typeof memoriesFor !== 'function') throw new Error('memoriesFor is required');
  if (typeof personaFor !== 'function') throw new Error('personaFor is required');
  if (typeof generateOfferText !== 'function') throw new Error('generateOfferText is required');
  const api = storage ?? createStorageApi({ root });

  const state = await api.readJson(RUNTIME_STATE_PATH);
  const week = currentWeek(state);
  const existing = readWeeklyStudyCircleOffers(state);
  if (existing && existing.week === week) {
    return { week: existing.week, offers: existing.offers, generated: false };
  }

  const { skeletons } = drawWeeklyStudyCircleSkeletons({ state, catalog, definitions });

  const offers = [];
  for (const skeleton of skeletons) {
    const memories = await memoriesFor(skeleton.host_character_id);
    // The persona (name / standing / character description / speaking basis) drives both the
    // character-fit skeleton and the own-voice appeal. The offer/appeal prompt builders are the
    // gate on their required fields, so this passes it through as resolved.
    const persona = await personaFor(skeleton.host_character_id);
    // Bounded retry on gate/validate violations only (LLM 出力の確率的ゲート違反を同一 skeleton
    // で再生成して吸収する)。LM 設定不備・接続不能・HTTP・parse は retry されず即 fail-fast。
    const text = await generateGatedOfferTextWithRetry({
      generate: () => generateOfferText({
        type: { id: skeleton.type_id, name: skeleton.name, scene_brief: skeleton.scene_brief },
        hostDisplayName: skeleton.host_display_name,
        persona,
        memories
      }),
      validate: validateStudyCircleOfferText,
      generationErrorCode: STUDY_CIRCLE_GENERATION_FAILED_ERROR_CODE
    });
    offers.push({
      study_circle_id: skeleton.study_circle_id,
      type_id: skeleton.type_id,
      theme_id: skeleton.theme_id,
      theme_name: skeleton.theme_name,
      title: text.title,
      situation: text.situation,
      motivation: text.motivation,
      appeal: text.appeal,
      condition_text: skeleton.condition_text,
      reward_params: skeleton.reward_params,
      venue: skeleton.venue,
      host_character_id: skeleton.host_character_id,
      host_display_name: skeleton.host_display_name
    });
  }

  const persisted = validateWeeklyStudyCircleOffers({ week, offers });

  // Atomic commit: re-read the freshest state and write the whole slot once, only after all
  // three offers passed the gate above.
  const stateForWrite = await api.readJson(RUNTIME_STATE_PATH);
  await api.writeJson(RUNTIME_STATE_PATH, {
    ...stateForWrite,
    [ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY]: persisted
  });

  return { week: persisted.week, offers: persisted.offers, generated: true };
}
