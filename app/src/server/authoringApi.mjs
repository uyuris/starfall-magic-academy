import path from 'node:path';

import { listSelectableCharacters, ensureSelectableCharacterStorage, updateCharacterProfileText } from '../characterCatalog.mjs';
import { loadWorldSettings, updatePlayerParameters, updateWorldDescription } from '../worldSettings.mjs';

function characterAuthoringCapability(context) {
  const enabled = context.characterAuthoringEnabled !== false;
  return {
    enabled,
    reason: enabled ? null : (context.characterAuthoringDisabledReason ?? 'desktop_runtime_read_only'),
    message: enabled
      ? null
      : 'デスクトップ版ではキャラクター説明の編集は無効です。ブラウザ実行で編集してください。'
  };
}

export function canHandleAuthoringApiRoute(method, pathname) {
  if (method === 'GET' && pathname === '/api/characters') return true;
  if (method === 'POST' && pathname === '/api/characters/profile') return true;
  if (method === 'GET' && pathname === '/api/world') return true;
  if (method === 'POST' && pathname === '/api/world') return true;
  return false;
}

async function updateAuthoringAndActiveRoot({ context, updater }) {
  const canonicalResult = await updater(context.root);
  if (context.activeRoot && path.resolve(context.activeRoot) !== path.resolve(context.root)) {
    await updater(context.activeRoot);
  }
  return canonicalResult;
}

export async function handleAuthoringApi({ req, res, url, context, sendJson, readBody }) {
  if (!canHandleAuthoringApiRoute(req.method, url.pathname)) return false;
  const persistToDefinitions = context.worldSettingsWriteTarget !== 'config';

  if (req.method === 'GET' && url.pathname === '/api/characters') {
    sendJson(res, {
      characters: await listSelectableCharacters({ root: context.activeRoot ?? context.root, authoringRoot: context.root }),
      capabilities: {
        character_authoring: characterAuthoringCapability(context)
      }
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/characters/profile') {
    const capability = characterAuthoringCapability(context);
    if (!capability.enabled) {
      sendJson(res, {
        error: capability.message,
        error_code: 'character_authoring_disabled',
        reason: capability.reason
      }, 403);
      return true;
    }
    const body = await readBody(req);
    const profile = await updateCharacterProfileText({
      root: context.root,
      characterId: body.character_id,
      promptDescription: body.prompt_description,
      speakingBasis: body.speaking_basis
    });
    if (context.activeRoot && path.resolve(context.activeRoot) !== path.resolve(context.root) && /^character_\d{3}$/.test(String(body.character_id ?? '').trim())) {
      await ensureSelectableCharacterStorage({ root: context.activeRoot, authoringRoot: context.root, characterId: body.character_id });
    }
    sendJson(res, { profile });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/world') {
    sendJson(res, await loadWorldSettings({ root: context.activeRoot ?? context.root }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/world') {
    const body = await readBody(req);
    sendJson(res, await updateAuthoringAndActiveRoot({
      context,
      updater: async (targetRoot) => {
        const updatedWorld = await updateWorldDescription({
          root: targetRoot,
          worldDescription: body.world_description,
          playerName: body.player_name,
          persistToDefinitions
        });
        if (body.player_parameters === undefined) return updatedWorld;
        return updatePlayerParameters({
          root: targetRoot,
          playerParameters: body.player_parameters
        });
      }
    }));
    return true;
  }
  return false;
}
