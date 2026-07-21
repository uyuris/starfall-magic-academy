import { createStorageApi } from '../storage.mjs';

export const characterSpeechConstraintsDefinitionPath = 'game_data/prompt/character_speech_constraints.json';

function normalizeModelId(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizedModelLeaf(value) {
  const normalized = normalizeModelId(value);
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function modelMatches({ chatModel, matcher }) {
  const model = normalizeModelId(chatModel);
  const pattern = normalizeModelId(matcher);
  if (!model || !pattern) return false;
  const modelLeaf = normalizedModelLeaf(model);
  const patternLeaf = normalizedModelLeaf(pattern);
  if (model === pattern) return true;
  if (modelLeaf === patternLeaf) return true;
  return model.endsWith(`/${patternLeaf}`);
}

function normalizeConstraints(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

export function selectCharacterSpeechConstraints({ definitions, chatModel } = {}) {
  const profiles = Array.isArray(definitions?.profiles) ? definitions.profiles : [];
  for (const profile of profiles) {
    const matchers = Array.isArray(profile?.match_models) ? profile.match_models : [];
    if (matchers.some((matcher) => modelMatches({ chatModel, matcher }))) {
      return normalizeConstraints(profile.constraints);
    }
  }
  return [];
}

export async function resolveCharacterSpeechConstraints({ root, chatModel } = {}) {
  if (!root) return [];
  let definitions;
  try {
    definitions = await createStorageApi({ root }).readJsonIfExists(characterSpeechConstraintsDefinitionPath);
  } catch {
    return [];
  }
  return selectCharacterSpeechConstraints({ definitions, chatModel });
}
