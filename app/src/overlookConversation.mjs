// 星見の窓 (overlook) two-child conversation: the record of one focused talk and the turn that extends it.
//
// The 談話室 group record and finalizer are fixed to three participants plus the hero, so this is a separate,
// smaller record: two children taking turns (the one who started the talk speaks first), each line followed by
// the outcome judgment (続く・果たされた・断られた・別の決着). When the starter's wish is aimed at the partner, it
// is fulfilled or refused by the partner's reply: until the partner has spoken the judgment may only say 続く or
// 別の決着, and after that it reads the partner's latest reply. A wish aimed at another child is neither fulfilled
// nor refused in this talk (続く or 別の決着 only). Every OVERLOOK_STAGNATION_INTERVAL consecutive 続く,
// a strict true/false stagnation judgment runs; true places one line from the closed, direction-free hook set in
// the next speaker's scene. There is no length cap: the talk closes only when the judgment says it has closed.
//
// Nothing here touches storage or the LM: the turn receives the generators and the prompt inputs from the
// runtime (routingOverlook.mjs), and returns a new record.

import { OVERLOOK_CLOSING_OUTCOMES, OVERLOOK_OUTCOMES, overlookJudgeableOutcomes } from './llm/overlookGeneration.mjs';

export const OVERLOOK_STAGNATION_INTERVAL = 4;
// Hooks carry no direction: each is something happening around the two, never a push toward an outcome.
export const OVERLOOK_STAGNATION_HOOKS = Object.freeze([
  '遠くで鐘がひとつ鳴った。',
  '風が吹き抜けて、足もとの葉が舞った。',
  'どこかの窓が開いて、笑い声がこぼれてきた。',
  '雲が陽をさえぎって、あたりが少し翳った。',
  '誰かの使い魔が、二人のそばを横切っていった。',
  '二人のあいだに、短い沈黙が落ちた。'
]);

function conversationError(message) {
  return new Error(`overlook conversation ${message}`);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function participant(value, label) {
  if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.id || !value.name) {
    throw conversationError(`${label} must be { id, name }`);
  }
  return { id: value.id, name: value.name };
}

export function createOverlookConversation({ id, encounterId, placeId, locationName, seedLine, initiator, partner, generation, fromWriting } = {}) {
  if (typeof id !== 'string' || !id) throw conversationError('id is required');
  if (typeof encounterId !== 'string' || !encounterId) throw conversationError('encounterId is required');
  if (typeof placeId !== 'string' || !placeId) throw conversationError('placeId is required');
  if (typeof locationName !== 'string' || !locationName) throw conversationError('locationName is required');
  if (typeof seedLine !== 'string' || !seedLine) throw conversationError('seedLine is required');
  if (!Number.isInteger(generation) || generation < 1) throw conversationError('generation must be a positive integer');
  if (typeof fromWriting !== 'boolean') throw conversationError('fromWriting must be a boolean');
  const first = participant(initiator, 'initiator');
  const second = participant(partner, 'partner');
  if (first.id === second.id) throw conversationError('needs two different children');
  return {
    id,
    encounter_id: encounterId,
    place_id: placeId,
    location_name: locationName,
    seed_line: seedLine,
    initiator: first,
    partner: second,
    generation,
    from_writing: fromWriting,
    messages: [],
    continue_streak: 0,
    pending_hook: null,
    judgments: [],
    outcome: null
  };
}

export function overlookConversationClosed(record) {
  return record.outcome !== null;
}

// Two children alternate, the one who started the talk first.
export function nextOverlookSpeaker(record) {
  if (overlookConversationClosed(record)) return null;
  return record.messages.length % 2 === 0 ? record.initiator : record.partner;
}

export function overlookConversationHistory(record) {
  return record.messages.map((message) => ({ speaker_name: message.speaker_name, content: message.content }));
}

function pickHook(record) {
  return OVERLOOK_STAGNATION_HOOKS[stableHash(`${record.id}:${record.messages.length}`) % OVERLOOK_STAGNATION_HOOKS.length];
}

// Generates the next line and judges it. `inputs(speaker)` resolves the speaker's prompt inputs (profile, scene,
// actor context, own state); `initiatorWish` is the wish the talk is judged against. Returns the extended record.
export async function runOverlookConversationTurn({ record, generators, inputs, initiatorWish, nameOf, placeNameOf, onDelta } = {}) {
  const speaker = nextOverlookSpeaker(record);
  if (!speaker) throw conversationError(`${record.id} is already closed`);
  if (!generators) throw conversationError('turn requires generators');
  if (typeof inputs !== 'function') throw conversationError('turn requires inputs');
  const partner = speaker.id === record.initiator.id ? record.partner : record.initiator;
  const speakerInputs = await inputs(speaker);
  const history = overlookConversationHistory(record);
  const { content, emotion } = await generators.generateUtterance({
    ...speakerInputs,
    history,
    speaker,
    partner,
    seedLine: record.seed_line,
    hook: record.pending_hook,
    nameOf,
    placeNameOf,
    onDelta
  });
  const judgedHistory = [...history, { speaker_name: speaker.name, content }];
  const spoken = [...record.messages, { speaker_id: speaker.id, speaker_name: speaker.name, content }];
  const partnerLine = spoken.findLast((message) => message.speaker_id === record.partner.id) ?? null;
  const judgmentInput = {
    locationName: record.location_name,
    initiator: record.initiator,
    partner: record.partner,
    initiatorWish,
    history: judgedHistory,
    partnerReply: partnerLine && { speaker_name: partnerLine.speaker_name, content: partnerLine.content },
    nameOf,
    placeNameOf
  };
  const outcome = await generators.judgeOutcome(judgmentInput);
  if (!OVERLOOK_OUTCOMES.includes(outcome)) throw conversationError(`outcome is outside the closed set: ${outcome}`);
  const judgeable = overlookJudgeableOutcomes({ initiatorWish, partnerId: record.partner.id, partnerReplied: partnerLine !== null });
  if (!judgeable.includes(outcome)) throw conversationError(`outcome ${outcome} is not judgeable at this line (${judgeable.join('・')})`);
  const message = {
    speaker_id: speaker.id,
    speaker_name: speaker.name,
    content,
    expression: emotion.expression,
    face_emotion_variant_id: emotion.face_emotion_variant_id,
    outcome
  };
  const next = {
    ...record,
    messages: [...record.messages, message],
    pending_hook: null,
    judgments: [...record.judgments, { after_message: record.messages.length + 1, kind: 'outcome', value: outcome }]
  };
  if (OVERLOOK_CLOSING_OUTCOMES.includes(outcome)) return { ...next, continue_streak: 0, outcome };
  const streak = record.continue_streak + 1;
  if (streak % OVERLOOK_STAGNATION_INTERVAL !== 0) return { ...next, continue_streak: streak };
  const stagnant = await generators.judgeStagnation(judgmentInput);
  if (typeof stagnant !== 'boolean') throw conversationError('stagnation judgment must be a boolean');
  const judged = {
    ...next,
    continue_streak: streak,
    judgments: [...next.judgments, { after_message: next.messages.length, kind: 'stagnation', value: stagnant }]
  };
  return stagnant ? { ...judged, pending_hook: pickHook(judged) } : judged;
}

// The client-facing view of a talk: the scene line, the two children (left = the one who spoke first), and the
// lines already shown. `shown` is how many lines the viewer has been given.
export function overlookConversationView(record, { shown }) {
  if (!Number.isInteger(shown) || shown < 0 || shown > record.messages.length) throw conversationError(`shown is out of range: ${shown}`);
  const visible = record.messages.slice(0, shown);
  const closedShown = overlookConversationClosed(record) && shown === record.messages.length;
  return {
    conversation_id: record.id,
    encounter_id: record.encounter_id,
    place_id: record.place_id,
    location_name: record.location_name,
    seed_line: record.seed_line,
    participants: [record.initiator, record.partner].map((child) => ({ character_id: child.id, character_name: child.name })),
    messages: visible.map((message) => ({
      character_id: message.speaker_id,
      character_name: message.speaker_name,
      content: message.content,
      expression: message.expression,
      face_emotion_variant_id: message.face_emotion_variant_id
    })),
    closed: closedShown,
    outcome: closedShown ? record.outcome : null
  };
}
