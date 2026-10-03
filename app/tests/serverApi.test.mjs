// 残す (a): save slot の削除・note 更新と会話の記録の対象別リセットが、対象の外の slot や記録を消す・上書きする壊れ方と、会話の後処理が並行して書かれた卒業エンディングの新しい状態を古い値で書き潰す壊れ方から、プレイヤーの save を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixtureRoot, isolatedServerOptions, readJson, writeJson } from './helpers.mjs';
import { pooledLegacyFixtureRoot } from './fixtures/serverFixturePool.mjs';
import { projectRoot } from './testPaths.mjs';
import { createServer } from '../src/server.mjs';
import { runtimePathsManifestFilename } from '../src/runtimePaths.mjs';
import { finalizeConversation } from '../src/llm/conversationPipeline.mjs';

const livePublicRoot = path.join(projectRoot, 'app/public');
const repoCanonicalAssetsRoot = path.join(projectRoot, 'assets/canonical');

async function withServer(t, serverOptions = {}) {
  const root = await pooledLegacyFixtureRoot({
    manifestFilename: runtimePathsManifestFilename,
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot
  });
  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
    ...serverOptions
  }, 'magic-adv-server-api-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = server.address();
  return { root, base: `http://127.0.0.1:${port}` };
}

async function jsonFetch(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
    body: options?.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options?.body
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  assert.equal(response.ok, true, `${response.status} ${text}`);
  return body;
}

test('server exposes character-local continuity records and delete actions for the selected character', async (t) => {
  const { root, base } = await withServer(t);
  await jsonFetch(`${base}/api/characters`);
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'character_007', source_type: 'field' }
  });
  const opening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: 'character_007', provider: 'mock' }
  });
  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'character_007', provider: 'mock' }
  });
  assert.equal(ending.finalization_status, 'completed');
  assert.equal(ending.state.current_screen, 'academy-room');

  const status = await jsonFetch(`${base}/api/records/status?character_id=character_007`);
  assert.equal(status.records.memory.items.length, 1);
  assert.equal(status.records.skills.items.length, 1);
  assert.equal(status.records.work_records.items.length, 1);
  assert.equal(status.records.memory.items.length, 1);
  assert.equal(status.records.memory.items[0].source_conversation_id, opening.conversation.id);
  assert.equal(status.records.skills.items.length, 1);
  assert.equal(status.records.skills.items[0].source_conversation_id, opening.conversation.id);
  assert.equal(status.records.work_records.items.length, 1);
  assert.equal(status.records.work_records.items[0].id, `wr_${opening.conversation.id}`);
  assert.match(status.responsibilities.work_records, /20文以下/);
  await fs.access(path.join(root, 'game_data/characters/character_007/memory'));
  await fs.access(path.join(root, 'game_data/characters/character_007/work_records'));
  await fs.access(path.join(root, 'game_data/characters/character_007/skills.json'));

  const deleteMemory = await jsonFetch(`${base}/api/records/reset`, {
    method: 'POST',
    body: { character_id: 'character_007', target: 'memory' }
  });
  assert.equal(deleteMemory.status.records.memory.count, 0);
  assert.equal(deleteMemory.status.records.skills.count, 1);
  assert.equal(deleteMemory.status.records.work_records.count, 1);

  const deleteSkills = await jsonFetch(`${base}/api/records/reset`, {
    method: 'POST',
    body: { character_id: 'character_007', target: 'skills' }
  });
  assert.equal(deleteSkills.status.records.skills.count, 0);

  const deleteWorkRecords = await jsonFetch(`${base}/api/records/reset`, {
    method: 'POST',
    body: { character_id: 'character_007', target: 'work_records' }
  });
  assert.equal(deleteWorkRecords.status.records.work_records.count, 0);
});

test('background finalization preserves a newer graduation ending interaction state', async (t) => {
  const root = await fixtureRoot('magic-adv-finalize-race-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'game_data/logs/conversations'), { recursive: true });

  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_screen = 'interaction';
  state.current_location_id = 'herbology_garden';
  state.current_location_visible_situation = '薬草温室の奥で、香りの強い苗が風に揺れている。';
  state.current_interaction_character_id = 'lina';
  state.last_conversation_id = 'conv_a';
  await writeJson(root, 'game_data/runtime_state.json', state);
  await writeJson(root, 'game_data/logs/conversations/conv_a.json', {
    id: 'conv_a',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-17T08:00:00.000+09:00',
    updated_at: '2026-05-17T08:05:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    time_slot: 'after_school',
    prompt: 'old prompt',
    messages: [
      { role: 'assistant', content: '温室の話をしよう。' },
      { role: 'user', content: 'うん。' }
    ]
  });

  let injected = false;
  const result = await finalizeConversation({
    root,
    conversationId: 'conv_a',
    characterId: 'lina',
    memoryUpdateProvider: async () => ({ memory_record: { text: '温室で話した。', tags: [] } }),
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'NO' }),
    skillUpdateProvider: async () => ({ skipped: true, reason: 'test' }),
    workRecordProvider: async () => ({ work_record: { title: '温室の会話', summary: '温室で短く話した。', tags: [] }, flag_update_candidates: [] }),
    stageFlagJudgmentProvider: async () => ({ raw_answer: '[]', accepted_flags: [], rejected_flags: [] }),
    eventFlagJudgmentProvider: async () => ({ raw_answer: '[]', accepted_flags: [], rejected_flags: [] }),
    eventCompletionJudgmentProvider: async () => ({ raw_answer: '[]', accepted_flags: [], rejected_flags: [] }),
    eventParticipantOverrideJudgmentProvider: async () => ({ raw_answer: '[]', accepted_overrides: [], rejected_overrides: [] }),
    moneyDeltaProvider: async () => '0',
    buddyAgreementProvider: async () => 'NO',
    enemyHostilityProvider: async () => 'NONE',
    // The routing persona (lina) skips buddy/enemy judgment, so drive the concurrent
    // graduation-ending write from a finalization step that still runs for lina and
    // executes before the concurrent-interaction-state merge.
    affinityDeltaProvider: async () => {
      if (!injected) {
        injected = true;
        const newer = await readJson(root, 'game_data/runtime_state.json');
        await writeJson(root, 'game_data/runtime_state.json', {
          ...newer,
          current_screen: 'academy-conversation-session',
          current_location_id: 'front_gate_morning',
          current_location_visible_situation: '朝の正門で、卒業を見送る空気が静かに満ちている。',
          current_interaction_character_id: 'lina',
          last_conversation_id: 'conv_ending',
          ending_started: true,
          ending_completed: false,
          ending_character_id: 'lina',
          global_flags: {
            ...(newer.global_flags ?? {}),
            'event.graduation_ending.ready': true
          },
          event_flag_sources: {
            ...(newer.event_flag_sources ?? {}),
            'event.graduation_ending.ready': {
              character_id: 'lina',
              source_type: 'graduation_ending',
              achieved_at: '2026-05-17T08:06:00.000+09:00'
            }
          },
          pending_interaction_context: {
            source_type: 'event_flag',
            event_flag_id: 'event.graduation_ending.ready',
            event_label: '卒業エンディング',
            source_conversation_id: null,
            opening_context: 'これまでの出来事を振り返る卒業エンディング会話。'
          }
        });
      }
      return '0';
    }
  });

  assert.equal(result.state.current_screen, 'academy-conversation-session');
  assert.equal(result.state.current_location_id, 'front_gate_morning');
  assert.equal(result.state.current_location_visible_situation, '朝の正門で、卒業を見送る空気が静かに満ちている。');
  assert.equal(result.state.current_interaction_character_id, 'lina');
  assert.equal(result.state.last_conversation_id, 'conv_ending');
  assert.equal(result.state.pending_interaction_context?.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(result.state.global_flags['event.graduation_ending.ready'], true);

  const persisted = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(persisted.current_screen, 'academy-conversation-session');
  assert.equal(persisted.current_location_id, 'front_gate_morning');
  assert.equal(persisted.last_conversation_id, 'conv_ending');
  assert.equal(persisted.pending_interaction_context?.event_flag_id, 'event.graduation_ending.ready');
});

test('slot deletion removes only the selected slot and keeps the others intact', async (t) => {
  const { root, base } = await withServer(t);

  const first = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotA = first.slot.slot_id;
  await fs.writeFile(path.join(root, 'game_data/play/slots', slotA, 'marker.txt'), 'slot-a', 'utf8');

  const second = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotB = second.slot.slot_id;
  await fs.writeFile(path.join(root, 'game_data/play/slots', slotB, 'marker.txt'), 'slot-b', 'utf8');

  const listedBefore = await jsonFetch(`${base}/api/slots`);
  assert.deepEqual(listedBefore.slots.map((slot) => slot.slot_id), [slotA, slotB]);

  const removed = await fetch(`${base}/api/slots/${slotB}`, { method: 'DELETE' });
  assert.equal(removed.ok, true);

  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots', slotB)));
  assert.equal(await fs.readFile(path.join(root, 'game_data/play/slots', slotA, 'marker.txt'), 'utf8'), 'slot-a');

  const listedAfter = await jsonFetch(`${base}/api/slots`);
  assert.deepEqual(listedAfter.slots.map((slot) => slot.slot_id), [slotA]);
});

test('slot note API updates only the targeted slot and returns the note in slot listings', async (t) => {
  const { root, base } = await withServer(t);

  const first = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotA = first.slot.slot_id;
  const second = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotB = second.slot.slot_id;

  const longBody = '風'.repeat(2105);
  const updated = await jsonFetch(`${base}/api/slots/${slotA}/note`, {
    method: 'PATCH',
    body: { player_note: `  中庭噴水 / バディー更新前\n${longBody}  ` }
  });
  const expected = `中庭噴水 / バディー更新前\n${longBody}`.slice(0, 2000);

  assert.equal(updated.slot.slot_id, slotA);
  assert.equal(updated.slot.player_note, expected);
  assert.equal(updated.slot.player_note.length, 2000);
  assert.equal(updated.active_slot_id, slotB, 'editing a note should not switch the active slot');

  const slotAMeta = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/slots', slotA, 'meta.json'), 'utf8'));
  const slotBMeta = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/slots', slotB, 'meta.json'), 'utf8'));
  assert.equal(slotAMeta.player_note, expected);
  assert.equal(slotBMeta.player_note ?? '', '');

  const listed = await jsonFetch(`${base}/api/slots`);
  assert.equal(listed.slots.find((slot) => slot.slot_id === slotA)?.player_note, expected);
  assert.equal(listed.slots.find((slot) => slot.slot_id === slotA)?.player_note.length, 2000);
  assert.equal(listed.slots.find((slot) => slot.slot_id === slotB)?.player_note ?? '', '');
});
