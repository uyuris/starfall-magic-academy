// The authored 舞台 for a homunculus atelier conversation. Unlike the dungeon / errand / study injected
// scenes (dynamic per session), the atelier scene is a single fixed authored scene reused by every atelier
// conversation, so it is the canonical source here (no LLM generation, no data-JSON duplicate). The builder
// returns the injected-scene context shape the conversation pipeline consumes (the same `{ source_type,
// location_name, visible_situation }` an errand/study scene supplies), stamping the homunculus source_type so
// the conversation record carries this 舞台 for finalization.

import { HOMUNCULUS_SOURCE_TYPE } from './routingMetaContext.mjs';

export const ATELIER_LOCATION_NAME = '錬成室';

// Pure scene: only what is physically present in the atelier now — glassware, mercury, the銀線 of the
// transmutation circle, night beyond the window. No人の気配 / intent / meaning inference (ref-content-writing
// pure-scene rule); the cold deep-night experiment room the brief specifies.
export const ATELIER_VISIBLE_SITUATION = '硝子の器がいくつも棚に並び、そのひとつひとつが内側から青白い残光をゆるやかに明滅させている。作業台の中央には水銀を張った浅い皿が据えられ、鏡のような面が天井の淡い光をゆがめて映す。床の一隅には錬成陣の銀線が幾重にも刻まれ、細い光条がその溝を巡っている。窓の外は深い夜で、器のふちに結んだ露が冷えた空気のなかを細く伝い落ちる。';

// The injected-scene context to pass as the conversation pipeline's scene input (opening / turn) for a
// homunculus atelier conversation. B2 / frontend call this instead of hand-building the object so the
// authored scene stays single-sourced.
export function atelierInjectedSceneContext() {
  return {
    source_type: HOMUNCULUS_SOURCE_TYPE,
    location_name: ATELIER_LOCATION_NAME,
    visible_situation: ATELIER_VISIBLE_SITUATION
  };
}
