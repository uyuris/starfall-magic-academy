// 談話室 (lounge) group turn orchestrator: the HTTP-independent domain/session layer that starts a group
// conversation and generates one NPC utterance per call. It owns the scheduling the 1:1 pipeline does not — which
// of the three seated participants speaks next — and assembles that speaker's prompt with the SAME parts the 昼会話
// pipeline uses (buildCharacterPrompt: persona profile, 会話相手コンテキスト snapshot, モデル別発話禁止規則, authored
// scene, 無改変 final instruction), differing only in that the shared history renders each NPC under its own name.
// The group record is the authoritative transcript + cursor: every utterance is appended and persisted before the
// call returns, and the LM is reached only through injected provider seams so the domain flow is testable without a
// live model.

import { createStorageApi } from '../storage.mjs';
import { listSelectableCharacterChoices, selectableCharacterPromptProfile } from '../characterCatalog.mjs';
import { loadWorldSettings } from '../worldSettings.mjs';
import { buildCharacterPrompt } from './promptBuilder.mjs';
import { buildConversationActorContextSnapshot } from './conversationActorContext.mjs';
import { normalizeEmotionChoice } from './conversationPipeline.mjs';
import { parseLoungeContinuationChoice } from './lmStudioClient.mjs';
import { selectLoungeParticipants } from './loungeParticipants.mjs';
import { resolveLoungeScene } from './loungeScene.mjs';
import {
  createLoungeGroupRecord,
  validateLoungeGroupRecord,
  currentLoungeSpeaker,
  loungeActorContextFor,
  applyLoungeAssistantTurn,
  appendLoungePlayerMessage
} from './loungeGroupRecord.mjs';

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]+$/;

function assertConversationId(id) {
  const normalized = String(id ?? '').trim();
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error(`lounge conversation id must be a valid conversation id: ${normalized || '(empty)'}`);
  return normalized;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function loungeRecordPath(id) {
  return `game_data/logs/lounge/${assertConversationId(id)}.json`;
}

// Reads and validates the persisted group record. A missing record for an id the caller believes is active is a
// wiring error, not a soft state — fail fast rather than silently start a fresh conversation.
export async function readLoungeGroupRecord({ root, id }) {
  if (!root) throw new Error('root is required');
  const storage = createStorageApi({ root });
  const raw = await storage.readJsonIfExists(loungeRecordPath(id));
  if (raw == null) throw new Error(`lounge group record not found: ${assertConversationId(id)}`);
  return validateLoungeGroupRecord(raw);
}

async function writeLoungeGroupRecord({ root, record }) {
  const validated = validateLoungeGroupRecord(record);
  const storage = createStorageApi({ root });
  await storage.writeJson(loungeRecordPath(validated.id), validated);
  return validated;
}

// The prompt-facing scene for a lounge turn: the shared world fields (academy / world description / player) plus the
// record's authored lounge 舞台. The world fields are required (loadWorldSettings always resolves them) — a missing
// one is a corrupt world surface, not a case to paper over.
function loungeScene(world, record) {
  return {
    academy_name: requiredString(world.academy_name, 'world academy_name'),
    world_description: requiredString(world.world_description, 'world world_description'),
    player_name: requiredString(world.player_name, 'world player_name'),
    player_parameters: world.player_parameters,
    location_name: record.location_name,
    visible_situation: record.visible_situation
  };
}

// The shared, speaker-named history handed to buildCharacterPrompt. Each NPC line carries its own speaker_name so
// the prompt renders「- 話者名: 本文」per NPC; player lines render as プレイヤー (no speaker_name). This is the ONLY
// place the persisted per-message identity is projected into the prompt — it is never completed from a top-level
// actor.
function loungePromptHistory(messages) {
  return messages.map((message) => (message.role === 'assistant'
    ? { role: 'assistant', content: message.content, speaker_name: message.character_name }
    : { role: 'user', content: message.content }));
}

// Seats the week's three participants, snapshots each one's actor context (系統知識 + 好感度), draws the week's
// authored scene, and persists the initial record (empty transcript, cursor at round 1 / first NPC). Returns the
// created record. The participant draw and scene draw are week-seed deterministic, so re-entering the same week
// reconstructs the same three participants and scene.
export async function startLoungeGroupConversation({ root, authoringRoot = root, id, week }) {
  if (!root) throw new Error('root is required');
  const conversationId = assertConversationId(id);
  const scene = await resolveLoungeScene({ root, week });
  const rosterChoices = await listSelectableCharacterChoices({ root, authoringRoot });
  const roster = rosterChoices.map((choice) => ({ character_id: choice.id, character_name: choice.display_name }));
  const participants = selectLoungeParticipants({ roster, week });
  const conversationActorContexts = [];
  for (const participant of participants) {
    const profile = await selectableCharacterPromptProfile({ root, authoringRoot, characterId: participant.character_id });
    const conversationActorContext = await buildConversationActorContextSnapshot({
      root,
      actor: { kind: 'character', id: participant.character_id },
      profile
    });
    if (conversationActorContext === null) {
      throw new Error(`lounge participant actor context is empty: ${participant.character_id}`);
    }
    conversationActorContexts.push({ character_id: participant.character_id, conversation_actor_context: conversationActorContext });
  }
  const record = createLoungeGroupRecord({
    id: conversationId,
    week,
    participants,
    conversationActorContexts,
    locationName: scene.location_name,
    visibleSituation: scene.visible_situation
  });
  await writeLoungeGroupRecord({ root, record });
  return record;
}

// Generates the current NPC speaker's single utterance and, per the v2 group turn contract, immediately after the
// normal utterance runs a strict per-speaker continuation-希望 judgment. When the judgment is `true`, the turn is
// exactly the v1 single-utterance turn: one assistant message appended, cursor advanced by one speaker slot. When
// the judgment is `false`, the same current speaker generates one additional departure utterance in the same round,
// both messages are appended atomically as separate assistant lines carrying the same speaker identity and the same
// emotion, and the current speaker's participant lifecycle entry transitions from active to exited with its
// `exited_after_message_count` boundary; the cursor then advances one slot and fast-forwards over any inactive
// suffix. All record state changes (both messages, lifecycle update, cursor advance) are one atomic transition and
// a single persist at the end of the turn — a malformed judgment output or a departure-generation failure throws
// before persist, so no half-appended turn is ever written.
//
// The prompt for the normal utterance (`buildCharacterPrompt(promptArgs)`) is byte-equivalent to v1: neither the
// judgment nor the departure-reply prompt modifies the shared history the normal utterance sees.
//
// LM seam:
//  - `chatProvider` — normal utterance (streamed 1-shot as in v1)
//  - `emotionProvider` — the same emotion selection as v1, reused for both normal and departure messages
//  - `conversationContinuationProvider` — the reflection-text continuation-judgment provider (fail-closed strict
//    boolean, `parseLoungeContinuationChoice`); the runtime bundle already includes it
//  - `conversationCutoffProvider` — the non-streamed chat provider for the departure utterance (no `onChatDelta`,
//    so the departure tokens never mix into the normal utterance's SSE delta buffer)
//
// SSE callback seam:
//  - `onEmotion(emotion)` — fires BEFORE `chatProvider` starts (v1 seam, unchanged)
//  - `onAssistantComplete({ content, emotion })` — fires once for every assistant message the turn appends. For a
//    continue turn it fires once (for the normal utterance, when `chatProvider` returns). For a departure turn it
//    fires twice: once for the normal utterance, then once for the departure utterance. The SSE layer uses this to
//    send one `assistant_complete` per appended message.
export async function runLoungeGroupTurn({
  root,
  authoringRoot = root,
  id,
  chatProvider,
  emotionProvider,
  conversationContinuationProvider,
  conversationCutoffProvider,
  characterSpeechConstraints = [],
  onEmotion,
  onAssistantComplete
}) {
  if (!root) throw new Error('root is required');
  if (typeof chatProvider !== 'function') throw new Error('chatProvider is required');
  if (typeof emotionProvider !== 'function') throw new Error('emotionProvider is required');
  if (typeof conversationContinuationProvider !== 'function') throw new Error('conversationContinuationProvider is required');
  if (typeof conversationCutoffProvider !== 'function') throw new Error('conversationCutoffProvider is required');
  const record = await readLoungeGroupRecord({ root, id });
  const speaker = currentLoungeSpeaker(record);
  if (!speaker) throw new Error('lounge turn: the player speaks next, there is no NPC utterance to generate');

  const [profile, world] = await Promise.all([
    selectableCharacterPromptProfile({ root, authoringRoot, characterId: speaker.character_id }),
    loadWorldSettings({ root })
  ]);
  const scene = loungeScene(world, record);
  const conversationActorContext = loungeActorContextFor(record, speaker.character_id);
  const currentConversation = loungePromptHistory(record.messages);
  const promptArgs = {
    profile,
    scene,
    characterSpeechConstraints,
    conversationActorContext,
    currentConversation,
    playerInput: null
  };

  const emotionPrompt = buildCharacterPrompt({ ...promptArgs, turnType: 'emotion_choice' });
  const emotion = normalizeEmotionChoice(await emotionProvider({ prompt: emotionPrompt, profile, playerInput: null, currentConversation }));
  onEmotion?.(emotion);
  const prompt = buildCharacterPrompt(promptArgs);
  const content = await chatProvider({ prompt, profile, playerInput: null, emotion });
  onAssistantComplete?.({ content, emotion });

  // The provisional history the judgment and departure reply see: v1 history + the current speaker's just-generated
  // normal utterance. Rendered with the shared speaker-named renderer via `loungePromptHistory`, so the two extra
  // prompts see the same「話者名: 本文」form the normal utterance uses.
  const provisionalMessages = [
    ...record.messages,
    { role: 'assistant', character_id: speaker.character_id, character_name: speaker.character_name, content, expression: emotion.expression, face_emotion_variant_id: emotion.face_emotion_variant_id }
  ];
  const provisionalHistory = loungePromptHistory(provisionalMessages);
  const provisionalPromptArgs = { ...promptArgs, currentConversation: provisionalHistory };

  const continuationPrompt = buildCharacterPrompt({ ...provisionalPromptArgs, turnType: 'lounge_continuation_judgment' });
  const continuationModelResponse = await conversationContinuationProvider({
    prompt: continuationPrompt,
    profile,
    playerInput: null,
    generatedAssistantText: content,
    currentConversation: provisionalHistory
  });
  const continueParticipation = parseLoungeContinuationChoice(continuationModelResponse);

  let departureContent = null;
  let departurePrompt = null;
  if (!continueParticipation) {
    departurePrompt = buildCharacterPrompt({
      ...provisionalPromptArgs,
      turnType: 'lounge_departure_reply',
      generatedAssistantText: content
    });
    const rawDeparture = await conversationCutoffProvider({
      prompt: departurePrompt,
      profile,
      playerInput: null,
      emotion,
      generatedAssistantText: content,
      currentConversation: provisionalHistory
    });
    departureContent = String(rawDeparture ?? '').trim();
    if (!departureContent) throw new Error('lounge departure reply is required');
    onAssistantComplete?.({ content: departureContent, emotion });
  }

  const nextRecord = applyLoungeAssistantTurn(record, {
    characterId: speaker.character_id,
    content,
    emotion,
    departure: departureContent === null ? null : { content: departureContent, emotion }
  });
  await writeLoungeGroupRecord({ root, record: nextRecord });
  return {
    record: nextRecord,
    speaker,
    emotion,
    prompt,
    emotionPrompt,
    content,
    continuation: {
      prompt: continuationPrompt,
      model_response: String(continuationModelResponse ?? '').trim(),
      continued: continueParticipation
    },
    departure: departureContent === null ? null : { prompt: departurePrompt, content: departureContent, emotion }
  };
}

// Appends the player's round-closing utterance to the persisted record and opens the next round. The persisted
// record is the authoritative cursor, so a premature player turn (the round's NPCs have not all spoken) throws
// inside appendLoungePlayerMessage rather than being silently accepted. Persists and returns the advanced record.
export async function appendLoungePlayerTurn({ root, id, content }) {
  if (!root) throw new Error('root is required');
  const record = await readLoungeGroupRecord({ root, id });
  const nextRecord = appendLoungePlayerMessage(record, content);
  await writeLoungeGroupRecord({ root, record: nextRecord });
  return nextRecord;
}
