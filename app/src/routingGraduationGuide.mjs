// The routing graduation guide phase (routing week-50 卒業ガイド). When the guide is active, a routing hub
// turn presents the top-N memory-ranked characters plus the guide persona (案内人自身・actor id `lina`) as a
// permanent option, and judges which of them (a closed set of their ids plus 「none」) the player has chosen
// to end the run with. This module owns the guide's prompt-facing context normalization, the closed-set
// selection parse, and the decision narration — the same shape the routing destination selection uses
// (normalize context → structured judgment → narration), but over characters instead of destinations.

import { ROUTING_PERSONA_CHARACTER_ID } from './routingPersona.mjs';

const CHARACTER_ID_PATTERN = /^character_\d{3}$/;
const NONE_ANSWER = 'none';

// The guide persona (案内人自身) is a permanent selection option that sits OUTSIDE the memory-ranked candidate
// list: its id is the fixed routing persona actor id, and its display name is the save's effective variant
// proper name. Normalized fail-fast — a persona option whose id is not the routing persona, or whose display
// name is empty, is a wiring bug, not a silently accepted value.
export function normalizeGraduationGuidePersonaOption(guidePersona) {
  if (!guidePersona || typeof guidePersona !== 'object' || Array.isArray(guidePersona)) {
    throw new Error('graduation guide persona option must be an object');
  }
  const characterId = String(guidePersona.character_id ?? '').trim();
  if (characterId !== ROUTING_PERSONA_CHARACTER_ID) {
    throw new Error(`graduation guide persona option character_id must be ${ROUTING_PERSONA_CHARACTER_ID}: ${guidePersona.character_id}`);
  }
  const displayName = String(guidePersona.display_name ?? '').trim();
  if (!displayName) throw new Error('graduation guide persona option display_name is required');
  return { character_id: characterId, display_name: displayName };
}

function normalizeCandidate(candidate, index) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`routingGraduationGuideContext.candidates[${index}] must be an object`);
  }
  const characterId = String(candidate.character_id ?? '').trim();
  if (!CHARACTER_ID_PATTERN.test(characterId)) {
    throw new Error(`routingGraduationGuideContext.candidates[${index}].character_id must be a character id: ${candidate.character_id}`);
  }
  const displayName = String(candidate.display_name ?? '').trim();
  if (!displayName) {
    throw new Error(`routingGraduationGuideContext.candidates[${index}].display_name is required`);
  }
  return { character_id: characterId, display_name: displayName };
}

// undefined passes through untouched (a non-guide turn), so a hub turn that is not in the guide phase never
// renders guide framing and stays byte-equivalent. A present value must be a non-empty candidate list with no
// duplicate ids — fail-fast, no silent dedupe.
export function normalizeRoutingGraduationGuideContext(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routingGraduationGuideContext must be an object');
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error('routingGraduationGuideContext.candidates must be a non-empty array');
  }
  const candidates = value.candidates.map((candidate, index) => normalizeCandidate(candidate, index));
  const ids = candidates.map((candidate) => candidate.character_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('routingGraduationGuideContext.candidates must not contain duplicate character ids');
  }
  return { candidates };
}

// Parses the closed-set guide selection judgment: exactly one of the presented candidate character ids, the
// guide persona id (the always-available 案内人自身 option), or 「none」 for「まだ選んでいない」. A judged 'none'
// (or an unparseable/blank answer, which the strict parser rejects) means the guide conversation continues; a
// matched candidate or the guide persona confirms the graduation partner. An answer that is none of these
// fail-fasts rather than silently resolving to a default. The guide persona is a required option (it is always
// presented alongside the candidates), so a missing/malformed persona option is a wiring bug.
export function parseGraduationGuideSelectionAnswer(answer, candidates, guidePersona) {
  const normalizedCandidates = normalizeRoutingGraduationGuideContext({ candidates }).candidates;
  const normalizedGuidePersona = normalizeGraduationGuidePersonaOption(guidePersona);
  const raw = String(answer ?? '').trim();
  if (!raw) throw new Error('graduation guide selection answer is required');
  if (raw.toLowerCase() === NONE_ANSWER) return null;
  if (raw === normalizedGuidePersona.character_id) return normalizedGuidePersona;
  const match = normalizedCandidates.find((candidate) => candidate.character_id === raw);
  if (!match) throw new Error(`unknown graduation guide selection: ${raw}`);
  return match;
}

// The confirmed partner is either a memory-ranked candidate ({character_###, display_name}) or the guide
// persona ({lina, variant display_name}); both carry the display name the narration names. Only the display
// name is required here — the parse already fixed the id.
export function buildGraduationGuideSelectionNarration(selection) {
  const displayName = String(selection?.display_name ?? '').trim();
  if (!displayName) throw new Error('graduation guide selection display_name is required for narration');
  return `卒業の締めくくりを共に過ごす相手は${displayName}に決まった。`;
}
