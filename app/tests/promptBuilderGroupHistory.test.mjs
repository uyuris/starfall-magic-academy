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

// The lounge continuation judgment is a third-person classification task over the transcript, not a first-person
// role-play question: asking 「<名前>として、……と思うか」 makes the model act as that character and emit an utterance
// instead of the strict boolean, so the prompt frames the record and asks for a verdict about the character.
test('lounge_continuation_judgment: the final instruction is the third-person verdict form over the transcript, not the first-person role-play question', () => {
  const prompt = buildCharacterPrompt({
    profile,
    scene,
    currentConversation: [
      { role: 'assistant', content: 'それでは。', speaker_name: 'リナ' }
    ],
    playerInput: null,
    turnType: 'lounge_continuation_judgment'
  });
  // Third-person verdict framing, with the display name embedded in both the question and the false/true clause.
  assert.ok(prompt.includes('この記録を読み、リナが自分の今の発話を終えたあとも、この談話の場に残っていたいと思っているかを判定する。'), 'the third-person verdict instruction is emitted');
  assert.ok(prompt.includes('リナが自分だけこの場から退出したいと思っていればfalse、残って談話を続けたいと思っていればtrueと判定する。'), 'the false/true meaning is emitted with the display name');
  // Ban list: all three measured components (single-word output, utterance/prose/parenthesized behavior, machine formats).
  assert.ok(prompt.includes('出力はtrueもしくはfalseの1語だけとする。'), 'the single-word output contract is emitted');
  assert.ok(prompt.includes('発話、地の文、括弧書きの振る舞い、理由、補足、ラベル、JSON、Markdownコードブロックは一切出力しない。'), 'the full ban list is emitted');
  // The transcript is framed as a closed record, not as a turn awaiting the player.
  assert.ok(prompt.includes('以上が談話の記録である。'), 'the closed-record turn line is emitted');
  assert.ok(!prompt.includes('プレイヤーの次の発言を待っている。'), 'the between-turns marker is NOT emitted');
  // The retired first-person role-play form must not come back in any shape.
  assert.ok(!prompt.includes('として、自分の今の発話を終えたあとも'), 'the first-person role-play question is NOT emitted');
  assert.ok(!prompt.includes('他の参加者は残っており、談話そのものはこれで終わらない。'), 'the retired group-still-continues sentence is NOT emitted');
  assert.ok(!prompt.includes('この発言を行ったプレイヤーとの会話'), 'the 1:1 continuation form is NOT emitted');
});

// The reframe is scoped to the lounge branch: the 1:1 continuation judgment prompt stays byte-identical to the reply
// prompt except for its own final instruction line.
test('conversation_continuation_judgment: the 1:1 judgment prompt is unchanged by the lounge reframe', () => {
  const baseArgs = {
    profile,
    scene,
    currentConversation: [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'やあ、こんにちは' }
    ],
    playerInput: 'げんき？'
  };
  const replyPrompt = buildCharacterPrompt(baseArgs);
  const judgmentPrompt = buildCharacterPrompt({ ...baseArgs, turnType: 'conversation_continuation_judgment' });
  const replyLines = replyPrompt.trim().split('\n');
  const judgmentLines = judgmentPrompt.trim().split('\n');
  assert.deepEqual(judgmentLines.slice(0, -1), replyLines.slice(0, -1), 'everything above the final instruction is byte-identical to the reply prompt');
  assert.equal(judgmentLines.at(-1), 'リナとして、この発言を行ったプレイヤーとの会話を継続したいと思うか。回答はtrueもしくはfalseのみを返す。継続したい場合はtrue。継続したくない場合はfalse。');
  assert.ok(judgmentPrompt.includes('プレイヤーの発言: げんき？'), 'the 1:1 judgment keeps the player-input line');
  assert.ok(!judgmentPrompt.includes('以上が談話の記録である。'), 'the lounge closed-record turn line does NOT leak into the 1:1 judgment');
  assert.ok(!judgmentPrompt.includes('出力はtrueもしくはfalseの1語だけとする。'), 'the lounge ban list does NOT leak into the 1:1 judgment');
});

test('lounge_departure_reply: the final instruction is the single-speaker exit that leaves the group intact, distinct from the 1:1 cutoff', () => {
  const prompt = buildCharacterPrompt({
    profile,
    scene,
    currentConversation: [
      { role: 'assistant', content: 'それじゃあ、部屋に戻るね。', speaker_name: 'リナ' }
    ],
    playerInput: null,
    turnType: 'lounge_departure_reply',
    generatedAssistantText: 'それじゃあ、部屋に戻るね。'
  });
  assert.ok(prompt.includes('この談話の場から自分だけが退出する'), 'the single-speaker exit instruction is emitted');
  assert.ok(prompt.includes('他の参加者はこの場に残り、談話そのものは続く'), 'the group-still-continues clause is emitted');
  assert.ok(prompt.includes('先ほど自分が生成した発言: それじゃあ、部屋に戻るね。'), 'the previous utterance is re-injected as generated text');
  assert.ok(!prompt.includes('この会話を切り上げる'), 'the 1:1 cutoff instruction is NOT emitted');
});
