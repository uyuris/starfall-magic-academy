import { ROUTING_PERSONA_CHARACTER_ID } from './routingFinalizeClient.js';

// The persisted current_screen an in-flight graduation phase 2 conversation can hold on entry: the daytime
// event surface ('interaction') or the legacy conversation session screen. Any other value under the in-flight
// predicate is a backend data-integrity error (fail-fast), never coerced to a default. Mirrors the backend
// GRADUATION_PHASE2_ENTRY_SCREENS closed set (server/playModeRouting.mjs).
export const GRADUATION_PHASE2_REENTRY_SCREENS = Object.freeze(['interaction', 'academy-conversation-session']);

// Read + validate the in-flight graduation phase-2 re-entry contract carried on a POST /api/slots/load or
// GET /api/slots response (server/playModeRouting.mjs resolveGraduationPhase2Reentry). Returns null when the
// slot is not mid-phase-2 (the frontend then follows the ordinary hub / post-content landing). A present
// contract is fully shape-checked with no silent / default fallback: character_id (non-empty string), screen
// (closed set), last_conversation_id (non-empty string | null), is_guide_persona (boolean that must equal
// character_id === the routing persona id), and routing_persona_visual present iff the guide persona (the
// backend attaches the persona summary only for the 案内人 / lina phase 2; a candidate character_### carries
// none). A missing or malformed field is a real contract violation and throws — it is never read as non-phase-2.
export function parseGraduationPhase2Reentry(result, source) {
  const reentry = result?.graduation_phase2_reentry;
  if (reentry === null || reentry === undefined) return null;
  if (typeof reentry !== 'object') {
    throw new Error(`${source}: graduation_phase2_reentry must be an object or null: ${JSON.stringify(reentry)}`);
  }
  const { character_id, screen, last_conversation_id, is_guide_persona, routing_persona_visual } = reentry;
  if (typeof character_id !== 'string' || character_id === '') {
    throw new Error(`${source}: graduation_phase2_reentry.character_id must be a non-empty string: ${JSON.stringify(character_id)}`);
  }
  if (!GRADUATION_PHASE2_REENTRY_SCREENS.includes(screen)) {
    throw new Error(`${source}: graduation_phase2_reentry.screen is outside the closed set: ${JSON.stringify(screen)}`);
  }
  if (last_conversation_id !== null && (typeof last_conversation_id !== 'string' || last_conversation_id === '')) {
    throw new Error(`${source}: graduation_phase2_reentry.last_conversation_id must be a non-empty string or null: ${JSON.stringify(last_conversation_id)}`);
  }
  if (typeof is_guide_persona !== 'boolean') {
    throw new Error(`${source}: graduation_phase2_reentry.is_guide_persona must be a boolean: ${JSON.stringify(is_guide_persona)}`);
  }
  if (is_guide_persona !== (character_id === ROUTING_PERSONA_CHARACTER_ID)) {
    throw new Error(`${source}: graduation_phase2_reentry.is_guide_persona must equal character_id === ${JSON.stringify(ROUTING_PERSONA_CHARACTER_ID)}: ${JSON.stringify(reentry)}`);
  }
  const hasVisual = routing_persona_visual !== undefined;
  if (is_guide_persona && !hasVisual) {
    throw new Error(`${source}: guide-persona graduation_phase2_reentry is missing routing_persona_visual: ${JSON.stringify(reentry)}`);
  }
  if (!is_guide_persona && hasVisual) {
    throw new Error(`${source}: non-guide graduation_phase2_reentry must not carry routing_persona_visual: ${JSON.stringify(reentry)}`);
  }
  return reentry;
}
