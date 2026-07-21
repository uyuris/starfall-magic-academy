// The shared-history renderer's two modes: a 1:1 assistant message (no speaker_name) renders as the single
// injected profile (byte-for-byte unchanged), a group message with an explicit speaker_name renders under that
// name, and a present-but-empty speaker_name fails fast rather than mislabeling the line.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCharacterPrompt } from '../src/llm/promptBuilder.mjs';

const profile = { display_name: 'リナ', parameters: {} };
const scene = { academy_name: '星灯魔法学院', location_name: '寮の談話室', player_parameters: {} };

function historyBlock(prompt) {
  const marker = '直前までの会話:\n';
  const index = prompt.indexOf(marker);
  assert.ok(index >= 0, 'the prompt has a shared history block');
  return prompt.slice(index + marker.length).split('\n\n')[0];
}

test('a 1:1 assistant message (no speaker_name) renders under the injected profile display name', () => {
  const prompt = buildCharacterPrompt({
    profile,
    scene,
    currentConversation: [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'やあ、こんにちは' }
    ],
    playerInput: 'げんき？'
  });
  const history = historyBlock(prompt);
  assert.ok(history.includes('- プレイヤー: こんにちは'));
  assert.ok(history.includes('- リナ: やあ、こんにちは'), 'the assistant line renders as the injected profile');
});

test('a group assistant message renders under its own speaker_name', () => {
  const prompt = buildCharacterPrompt({
    profile,
    scene,
    currentConversation: [
      { role: 'assistant', content: '風筋を通そう', speaker_name: 'レオナ' },
      { role: 'user', content: 'なるほど' },
      { role: 'assistant', content: '土を見てから', speaker_name: 'モナ' }
    ],
    playerInput: null
  });
  const history = historyBlock(prompt);
  assert.ok(history.includes('- レオナ: 風筋を通そう'), 'the first NPC line is named');
  assert.ok(history.includes('- モナ: 土を見てから'), 'the second NPC line is named');
  assert.ok(history.includes('- プレイヤー: なるほど'), 'the player line is unchanged');
  assert.ok(!history.includes('- リナ:'), 'no line is mislabeled as the injected profile');
});

test('a present-but-empty speaker_name fails fast', () => {
  assert.throws(() => buildCharacterPrompt({
    profile,
    scene,
    currentConversation: [{ role: 'assistant', content: 'x', speaker_name: '  ' }],
    playerInput: null
  }), /speaker_name must be a non-empty string/);
});
