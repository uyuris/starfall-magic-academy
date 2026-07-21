import { newGameActivePlayMode, resolveActivePlayMode, resolvePostContentScreen } from '../playMode.mjs';
import { isDegradedSlotError, readSaveSlotActivePlayMode, readSaveSlotRuntimeState } from '../saveLoad.mjs';
import { isInFlightGraduationPhase2 } from '../graduationEnding.mjs';
import { buildRoutingPersonaVisualSummary } from '../routingPersonaVisual.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../routingPersona.mjs';
import { resolvePlayModeSettingsPath } from './playModeSettingsApi.mjs';

// The persisted current_screen an in-flight graduation phase 2 can hold on entry: the daytime event screen
// ('interaction') or the legacy conversation session screen. Any other screen under the in-flight predicate
// is a data-integrity error (fail-fast), never silently coerced to a default.
const GRADUATION_PHASE2_ENTRY_SCREENS = Object.freeze(['interaction', 'academy-conversation-session']);

function resolvedScreenRouting({ activePlayMode, loopScreen }) {
  return {
    active_play_mode: activePlayMode,
    post_content_screen: resolvePostContentScreen({
      mode: activePlayMode.mode,
      loopScreen
    })
  };
}

// The load/slots entry contract for re-entering an in-flight graduation phase 2 conversation. Null when the
// slot is not mid-phase-2. When present, the frontend branches into the phase-2 conversation surface (instead
// of the hub / post-content landing) from the preserved entry state, and — for the guide persona (lina) —
// registers the routing persona visual before its own refresh so the persona identity is known up front. A
// selectable roster partner (loop or a character_### guide selection) resolves through the roster and carries
// no persona visual.
async function resolveGraduationPhase2Reentry({ root, state, activePlayMode }) {
  if (!isInFlightGraduationPhase2(state)) return null;
  const characterId = String(state.current_interaction_character_id ?? '').trim();
  if (!characterId) {
    throw new Error('in-flight graduation phase 2 is missing current_interaction_character_id');
  }
  const screen = state.current_screen;
  if (!GRADUATION_PHASE2_ENTRY_SCREENS.includes(screen)) {
    throw new Error(`in-flight graduation phase 2 has an unexpected entry screen: ${screen}`);
  }
  const isGuidePersona = characterId === ROUTING_PERSONA_CHARACTER_ID;
  const reentry = {
    character_id: characterId,
    screen,
    last_conversation_id: state.last_conversation_id ?? null,
    is_guide_persona: isGuidePersona
  };
  if (isGuidePersona) {
    if (activePlayMode.mode !== 'routing') {
      throw new Error('guide-persona graduation phase 2 requires routing mode');
    }
    reentry.routing_persona_visual = await buildRoutingPersonaVisualSummary({
      root,
      personaVariant: activePlayMode.routing_persona_variant
    });
  }
  return reentry;
}

// The GET /api/slots top-level routing fields for an INCOMPATIBLE active slot: resume is disabled and the
// play-mode-derived fields are explicitly null (never a fabricated default / silent fallback). The slot
// still lists in incompatible_slots and stays deletable.
function incompatibleActiveSlotRouting() {
  return {
    active_slot_incompatible: true,
    active_play_mode: null,
    post_content_screen: null,
    graduation_phase2_reentry: null
  };
}

export async function resolvePlayModeScreenRouting({ context, loopScreen }) {
  const activePlayMode = await resolveActivePlayMode(resolvePlayModeSettingsPath(context));
  return { ...resolvedScreenRouting({ activePlayMode, loopScreen }), graduation_phase2_reentry: null };
}

// The screen routing for a NEW GAME: always routing (the play-mode sidecar is not consulted) with a
// uniformly-random persona variant. The returned active_play_mode carries that fresh variant so the caller
// persists exactly what it routed on; a new game never re-enters an in-flight graduation phase 2.
export function resolveNewGameScreenRouting({ loopScreen, random = Math.random } = {}) {
  const activePlayMode = newGameActivePlayMode(random);
  return { ...resolvedScreenRouting({ activePlayMode, loopScreen }), graduation_phase2_reentry: null };
}

export async function resolveSlotPlayModeScreenRouting({ root, slotId, loopScreen }) {
  const activePlayMode = await readSaveSlotActivePlayMode({ root, slotId });
  const state = await readSaveSlotRuntimeState({ root, slotId });
  return {
    ...resolvedScreenRouting({ activePlayMode, loopScreen }),
    graduation_phase2_reentry: await resolveGraduationPhase2Reentry({ root, state, activePlayMode })
  };
}

// The GET /api/slots top-level active-slot routing contract. An absent active slot resolves the sidecar
// default (compatible). A present active slot is resolved from its persisted play mode; if that slot is
// degraded (one of the closed compatibility errors), it returns the incompatible contract with the routing
// fields null and resume disabled, instead of bricking the whole listing. Any non-degraded throw
// propagates unchanged (fail-fast preserved). The returned object always carries active_slot_incompatible.
export async function resolveActiveSlotPlayModeScreenRouting({ context, activeSlotId, loopScreen }) {
  if (!activeSlotId) {
    return { active_slot_incompatible: false, ...await resolvePlayModeScreenRouting({ context, loopScreen }) };
  }
  try {
    return {
      active_slot_incompatible: false,
      ...await resolveSlotPlayModeScreenRouting({ root: context.root, slotId: activeSlotId, loopScreen })
    };
  } catch (error) {
    if (!isDegradedSlotError(error)) throw error;
    return incompatibleActiveSlotRouting();
  }
}
