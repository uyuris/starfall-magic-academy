// 卒業の星の道の材料: 一年に出会った人（道に灯る星）と、卒業の相手の最後の一言。どちらも保存の記録から読むだけで、LM は呼ばない。
// 卒業の会話を締めるとその本文は消える（conversationPipeline の discardConversationContent）ので、frontend は締めの前にこれを読む。
//
// 人と星:
// - 灯る候補は、締まった会話が一つでもある人（affinity.json の applied_affinity_conversation_ids が空でない人）と、卒業の相手。
// - 関わりの深い順（好感度 → 会話の数 → 早く出会った順）に GRADUATION_ROAD_LIMIT 人まで灯す。案内人と卒業の相手は必ず灯る。
// - 道に並ぶのは出会った順（その人の締まった会話のいちばん早い週。同じ週なら案内人が先）。締まった会話の無い相手は卒業の会話の週。
// - 星の明るさは、灯る人の好感度の最低〜最高を GRADUATION_ROAD_DIMMEST〜1.0 へ線形に写す（全員同じなら全員 1.0）。
// - 寄り添う星はバディーの成立（buddy_updates の established）とスキルの登録（skills.json の self_change）の数。
// 最後の一言: 卒業の会話の最後の assistant の発話から、仕草（丸括弧の段。製品の吹き出しの分け方と同じ）を外した台詞の段。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createStorageApi } from './storage.mjs';
import { normalizeCharacterAffinityFile } from './affinitySchema.mjs';
import { publicCanonicalFaceUrl, selectableCharacterDisplaySummary } from './characterCatalog.mjs';
import { ROUTING_PERSONA_CHARACTER_ID, routingPersonaDisplayName } from './routingPersona.mjs';
import { routingPersonaVisualSetId } from './routingPersonaVisual.mjs';

export const GRADUATION_ROAD_LIMIT = 10;
export const GRADUATION_ROAD_DIMMEST = 0.35;
const GRADUATION_EVENT_FLAG_ID = 'event.graduation_ending.ready';
const CHARACTER_DIR_PATTERN = /^(?:lina|character_\d{3})$/;
// 製品の吹き出しの分け方（app.js splitMessageContent）と同じ: 全角・半角の丸括弧の一続きが仕草。
const GESTURE_PATTERN = /（[^（）]+）|\([^()]+\)/g;

function graduationRoadError(message, statusCode = 409) {
  const error = new Error(`graduation road: ${message}`);
  error.statusCode = statusCode;
  error.errorCode = 'GRADUATION_ROAD_UNAVAILABLE';
  return error;
}

// 最後の一言の台詞の段（仕草を外し、残った段を空行・改行で分けたもの）。台詞が一つも残らない一言は道に置けない。
export function lastLineSpeech(content) {
  if (typeof content !== 'string') throw graduationRoadError('the last line must be a string', 500);
  const speech = content.replace(GESTURE_PATTERN, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  if (speech.length === 0) throw graduationRoadError('the last line has no speech once the gestures are removed', 500);
  return speech;
}

// 灯す人を選び、出会った順に並べ、明るさを付ける（純関数）。people: { character_id, first_week, affinity, conversations, companions }
export function arrangeRoadPeople(people, { partnerId }) {
  const ranked = [...people].sort((a, b) => b.affinity - a.affinity || b.conversations - a.conversations || a.first_week - b.first_week
    || a.character_id.localeCompare(b.character_id));
  const fixed = new Set([ROUTING_PERSONA_CHARACTER_ID, partnerId]);
  const lit = ranked.filter((person) => fixed.has(person.character_id));
  if (!lit.some((person) => person.character_id === partnerId)) throw graduationRoadError(`the partner ${partnerId} is not among the people`, 500);
  for (const person of ranked) {
    if (lit.length >= GRADUATION_ROAD_LIMIT) break;
    if (!fixed.has(person.character_id)) lit.push(person);
  }
  const affinities = lit.map((person) => person.affinity);
  const low = Math.min(...affinities);
  const high = Math.max(...affinities);
  const brightness = (affinity) => (high === low ? 1 : GRADUATION_ROAD_DIMMEST + (1 - GRADUATION_ROAD_DIMMEST) * (affinity - low) / (high - low));
  return lit
    .map((person) => ({ ...person, brightness: Math.round(brightness(person.affinity) * 1000) / 1000 }))
    .sort((a, b) => a.first_week - b.first_week
      || (a.character_id === ROUTING_PERSONA_CHARACTER_ID ? -1 : b.character_id === ROUTING_PERSONA_CHARACTER_ID ? 1 : 0)
      || a.character_id.localeCompare(b.character_id));
}

function conversationWeek(conversation, conversationId) {
  const week = conversation?.academy_week_number;
  if (!Number.isInteger(week)) throw graduationRoadError(`conversation ${conversationId} has no academy_week_number`, 500);
  return week;
}

async function listCharacterIds(root) {
  const entries = await fs.readdir(path.join(createStorageApi({ root }).paths.mutableRoot, 'characters'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && CHARACTER_DIR_PATTERN.test(entry.name)).map((entry) => entry.name).sort();
}

// 会話の無い人（相手でない）は好感度の file だけを読んで外す（null）。
async function readPersonRecord({ root, readJson, readJsonIfExists, characterId, partnerId }) {
  const affinity = normalizeCharacterAffinityFile(await readJsonIfExists(root, `game_data/characters/${characterId}/affinity.json`), characterId);
  const applied = affinity.applied_affinity_conversation_ids;
  if (applied.length === 0 && characterId !== partnerId) return null;
  const weeks = new Map();
  for (const conversationId of applied) {
    weeks.set(conversationId, conversationWeek(await readJson(root, `game_data/logs/conversations/${conversationId}.json`), conversationId));
  }
  let companions = 0;
  for (const conversationId of applied) {
    const buddy = await readJsonIfExists(root, `game_data/logs/buddy_updates/${conversationId}.json`);
    if (buddy?.established === true) companions += 1;
  }
  const skillsFile = await readJsonIfExists(root, `game_data/characters/${characterId}/skills.json`);
  companions += (skillsFile?.skills ?? []).filter((skill) => skill.type === 'self_change').length;
  return {
    character_id: characterId,
    affinity: affinity.affinity,
    conversations: applied.length,
    first_week: weeks.size ? Math.min(...weeks.values()) : null,
    companions
  };
}

async function displayFor({ root, authoringRoot, characterId, personaVariant, expression }) {
  if (characterId === ROUTING_PERSONA_CHARACTER_ID) {
    return { name: routingPersonaDisplayName(personaVariant), face_url: publicCanonicalFaceUrl(routingPersonaVisualSetId(personaVariant), expression) };
  }
  // 学院の人の顔は、目録の neutral の顔（publicCanonicalFaceUrl の形）の表情を差し替えて引く。その形でない顔は落とす。
  const summary = await selectableCharacterDisplaySummary({ root, authoringRoot, characterId });
  const neutralFace = /^(\/canonical\/character_visual_sets\/[^/]+\/face_emotions\/)neutral\.jpg$/.exec(summary.face_url);
  if (!neutralFace) throw graduationRoadError(`the face of ${characterId} is not a canonical neutral face: ${summary.face_url}`, 500);
  return { name: summary.display_name, face_url: `${neutralFace[1]}${expression}.jpg` };
}

// GET /api/graduation/road の中身。卒業の会話が進行中（締めの前）でなければ 409。
export async function readGraduationRoad({ root, authoringRoot, readJson, readJsonIfExists, personaVariant }) {
  if (!root || !authoringRoot) throw new Error('graduation road: root and authoringRoot are required');
  const state = await readJson(root, 'game_data/runtime_state.json');
  if (state.pending_interaction_context?.event_flag_id !== GRADUATION_EVENT_FLAG_ID) {
    throw graduationRoadError('no graduation conversation is in progress');
  }
  const conversationId = state.last_conversation_id;
  if (typeof conversationId !== 'string' || conversationId === '') throw graduationRoadError('the graduation conversation id is missing');
  const conversation = await readJson(root, `game_data/logs/conversations/${conversationId}.json`);
  if (conversation.discarded_after_work_record_id) throw graduationRoadError('the graduation conversation is already finalized');
  const partnerId = conversation.character_id;
  const lastMessage = [...(conversation.messages ?? [])].reverse().find((message) => message.role === 'assistant');
  if (!lastMessage) throw graduationRoadError('the graduation conversation has no reply yet');
  if (typeof lastMessage.expression !== 'string' || lastMessage.expression === '') {
    throw graduationRoadError('the last line carries no expression', 500);
  }
  const graduationWeek = conversationWeek(conversation, conversationId);

  const records = [];
  for (const characterId of await listCharacterIds(root)) {
    const record = await readPersonRecord({ root, readJson, readJsonIfExists, characterId, partnerId });
    if (record) records.push({ ...record, first_week: record.first_week ?? graduationWeek });
  }
  if (!records.some((record) => record.character_id === ROUTING_PERSONA_CHARACTER_ID)) {
    throw graduationRoadError('the guide has no finalized conversation in this save', 500);
  }
  const lit = arrangeRoadPeople(records, { partnerId });
  const people = [];
  for (const person of lit) {
    const display = await displayFor({ root, authoringRoot, characterId: person.character_id, personaVariant, expression: 'neutral' });
    people.push({
      character_id: person.character_id,
      name: display.name,
      face_url: display.face_url,
      first_week: person.first_week,
      affinity: person.affinity,
      brightness: person.brightness,
      companions: person.companions
    });
  }
  const partnerDisplay = await displayFor({ root, authoringRoot, characterId: partnerId, personaVariant, expression: lastMessage.expression });
  return {
    conversation_id: conversationId,
    partner: {
      character_id: partnerId,
      name: partnerDisplay.name,
      face_url: partnerDisplay.face_url,
      line: lastLineSpeech(lastMessage.content)
    },
    people
  };
}
