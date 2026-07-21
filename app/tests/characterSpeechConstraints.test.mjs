import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCharacterSpeechConstraints, selectCharacterSpeechConstraints } from '../src/llm/characterSpeechConstraints.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixtureDefinitions() {
  return {
    profiles: [
      {
        id: 'gemma4_31b',
        match_models: ['gemma-4-31b', 'gemma-4-31b-it'],
        constraints: ['Gemma用ではなく発話制約本文だけを返す。']
      },
      {
        id: 'other_chat',
        match_models: ['acme/other-chat'],
        constraints: ['他モデル用の発話制約。']
      }
    ]
  };
}

test('selectCharacterSpeechConstraints uses chat_model matching and never falls back to Gemma constraints for unknown models', () => {
  const definitions = fixtureDefinitions();

  assert.deepEqual(
    selectCharacterSpeechConstraints({ definitions, chatModel: ' GOOGLE/GEMMA-4-31B ' }),
    ['Gemma用ではなく発話制約本文だけを返す。']
  );
  assert.deepEqual(
    selectCharacterSpeechConstraints({ definitions, chatModel: 'lmstudio-community/gemma-4-31b-it' }),
    ['Gemma用ではなく発話制約本文だけを返す。']
  );
  assert.deepEqual(
    selectCharacterSpeechConstraints({
      definitions: { profiles: [{ id: 'qualified_only', match_models: ['google/gemma-4-31b'], constraints: ['provider付きmatcherだけでも一致する。'] }] },
      chatModel: 'gemma-4-31b'
    }),
    ['provider付きmatcherだけでも一致する。'],
    'matcher normalization should tolerate the provider prefix being present only on the matcher side'
  );
  assert.deepEqual(
    selectCharacterSpeechConstraints({ definitions, chatModel: 'acme/other-chat' }),
    ['他モデル用の発話制約。']
  );
  assert.deepEqual(
    selectCharacterSpeechConstraints({ definitions, chatModel: 'unknown/model', reflectionModel: 'google/gemma-4-31b' }),
    [],
    'reflection_model must not select character speech constraints'
  );
});

test('resolveCharacterSpeechConstraints reads prompt definitions from the active root and treats missing files as no constraints', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-speech-constraints-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(await resolveCharacterSpeechConstraints({ root, chatModel: 'google/gemma-4-31b' }), []);

  await writeJson(root, 'data/definitions/game_data/prompt/character_speech_constraints.json', fixtureDefinitions());

  assert.deepEqual(
    await resolveCharacterSpeechConstraints({ root, chatModel: 'google/gemma-4-31b' }),
    ['Gemma用ではなく発話制約本文だけを返す。']
  );
  assert.deepEqual(
    await resolveCharacterSpeechConstraints({ root, chatModel: 'unknown/model', reflectionModel: 'google/gemma-4-31b' }),
    []
  );
});

test('resolveCharacterSpeechConstraints treats malformed prompt definitions as no constraints instead of breaking conversation setup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-speech-constraints-invalid-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const fullPath = path.join(root, 'data/definitions/game_data/prompt/character_speech_constraints.json');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, '{ invalid json', 'utf8');

  assert.deepEqual(await resolveCharacterSpeechConstraints({ root, chatModel: 'google/gemma-4-31b' }), []);
});

test('resolveCharacterSpeechConstraints treats unreadable prompt definition paths as no constraints', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-speech-constraints-unreadable-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const fullPath = path.join(root, 'data/definitions/game_data/prompt/character_speech_constraints.json');
  await fs.mkdir(fullPath, { recursive: true });

  assert.deepEqual(await resolveCharacterSpeechConstraints({ root, chatModel: 'google/gemma-4-31b' }), []);
});
