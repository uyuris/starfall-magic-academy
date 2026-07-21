import { isSelectableCharacterId } from '../characterCatalog.mjs';
import { sortMemoriesByChronology } from '../llm/continuityPromptContext.mjs';
import { createStorageApi } from '../storage.mjs';

const ROUTES = new Set([
  'GET /api/diary'
]);

function statusError(message, statusCode, errorCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (errorCode) error.errorCode = errorCode;
  return error;
}

function requiredDiaryCharacterId(url) {
  const characterId = String(url.searchParams.get('character_id') ?? '').trim();
  if (!characterId) {
    throw statusError('diary character_id is required', 400, 'DIARY_CHARACTER_ID_REQUIRED');
  }
  if (characterId !== 'lina' && !isSelectableCharacterId(characterId)) {
    throw statusError(
      `diary character_id must be an academy character: ${characterId}`,
      400,
      'DIARY_CHARACTER_NOT_SELECTABLE'
    );
  }
  return characterId;
}

function diaryEntryFromMemory(memory) {
  return {
    id: memory?.id,
    type: memory?.type,
    text: memory?.text,
    source_conversation_id: memory?.source_conversation_id,
    work_record_id: memory?.work_record_id,
    tags: memory?.tags
  };
}

export function canHandleDiaryApiRoute(method, pathname) {
  return ROUTES.has(`${method} ${pathname}`);
}

export async function handleDiaryApi({ req, res, url, context, sendJson }) {
  if (!canHandleDiaryApiRoute(req.method, url.pathname)) return false;
  const root = context.activeRoot ?? context.root;
  const characterId = requiredDiaryCharacterId(url);
  const actorBasePath = `game_data/characters/${characterId}`;
  const storage = createStorageApi({ root });
  const memories = await storage.listJson(`${actorBasePath}/memory`);
  return sendJson(res, {
    character_id: characterId,
    entries: sortMemoriesByChronology(memories).map(diaryEntryFromMemory)
  });
}
