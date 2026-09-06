// routing の hub dispatch を 6 destination すべてで総なめする持ち場。
//
// 1 dispatch ごとに atomic finalize が「全 slot copy ＋ 全 mutable-tree mirror」を1組走らせるので、
// 6 destination を1本の test で回すと単体で10秒の線を越える。変更ごとの lane が踏むのは代表 1
// destination（serverApi.test.mjs の 'routing conversation end dispatches a decided hub destination
// and drains the finalization on exit'）で、6 destination の総なめはこの file が持ち、週1の全量網
// でだけ走る。
//
// サーバ起動 helper は serverApi.test.mjs / flagSystem.test.mjs / characterDeleteFlags.test.mjs と
// 同じく、この file が自分の分を持つ（この suite の既存の書き方）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedServerOptions, readJson, writeJson } from './helpers.mjs';
import { pooledLegacyFixtureRoot } from './fixtures/serverFixturePool.mjs';
import { projectRoot } from './testPaths.mjs';
import { createServer } from '../src/server.mjs';
import { runtimePathsManifestFilename } from '../src/runtimePaths.mjs';
import { trainingDefinitions } from '../src/training.mjs';

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
  }, 'magic-adv-routing-sweep-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = server.address();
  return { root, base: `http://127.0.0.1:${port}` };
}

async function writeRoutingModeSettings(t, prefix = 'routing-mode-settings-') {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  return settingsPath;
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

function routingHubContextFixture(personaVariant = 'fallen_star') {
  return {
    persona_variant: personaVariant,
    recent_conversation_context: {
      kind: 'no_new_conversation',
      conversation_id: null,
      character_id: null,
      character_name: null,
      memory_text: null
    },
    relationship_context: {
      buddy: null,
      enemies: []
    },
    alchemy_context: {
      recipe_count: 8
    },
    study_circle_context: {
      theme_count: trainingDefinitions.length,
      weekly_offer_count: 3
    },
    content_result_context: null
  };
}

async function seedConversationForRoutingEnd({ slotRoot, conversationId, characterId, routingDestinationId = null, routingHub = routingDestinationId !== null }) {
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'interaction',
    current_interaction_character_id: characterId,
    pending_interaction_context: null,
    last_conversation_id: conversationId,
    elapsed_weeks: state.elapsed_weeks ?? 0
  });
  await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, {
    id: conversationId,
    character_id: characterId,
    character_name: characterId === 'lina' ? 'ルミ' : 'テスト生徒',
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:02:00.000+09:00',
    ...(routingHub
      ? {
          routing_hub: routingHubContextFixture('fallen_star'),
          ...(routingDestinationId !== null
            ? {
                routing_destination_judgment: {
                  decided: true,
                  destination_id: routingDestinationId,
                  destination_label: routingDestinationId,
                  model_response: routingDestinationId
                }
              }
            : {})
        }
      : {}),
    messages: [
      { role: 'assistant', content: '行き先を決めましょう。' },
      { role: 'user', content: 'お願いします。' }
    ]
  });
}

test('routing conversation end dispatches decided hub destinations and drains the finalization on exit', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-mode-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-dispatch-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const destinations = [
    ['academy-map', 'academy-map'],
    ['training', 'academy-training'],
    ['dungeon', 'academy-dungeon'],
    ['errand', 'academy-errand'],
    ['alchemy', 'academy-alchemy'],
    ['study_circle', 'academy-study-circle']
  ];

  for (const [index, [destinationId, expectedScreen]] of destinations.entries()) {
    const conversationId = `conv_routing_dispatch_${destinationId.replace('-', '_')}_001`;
    await seedConversationForRoutingEnd({ slotRoot, conversationId, characterId: 'lina', routingDestinationId: destinationId });

    // Drain-on-exit needs a provider to finalize; the mock provider drains without an LM Studio config.
    const ending = await jsonFetch(`${base}/api/conversation/end`, {
      method: 'POST',
      body: { character_id: 'lina', conversation_id: conversationId, provider: 'mock' }
    });

    assert.equal(ending.finalization_status, 'drained');
    assert.equal(Object.hasOwn(ending, 'pending_finalization'), false, 'a drained dispatch response must not carry a singular pending_finalization field');
    assert.equal(ending.routing_dispatch.destination_id, destinationId);
    assert.equal(ending.week_progression.status, 'applied');
    assert.equal(ending.week_progression.idempotency_key, `${conversationId}:${destinationId}`);
    assert.equal(ending.state.current_screen, expectedScreen);
    assert.equal(ending.transition.next_screen, expectedScreen);
    assert.equal(ending.state.current_interaction_character_id, null);
    assert.equal(ending.state.pending_interaction_context, null);
    assert.equal(ending.state.elapsed_weeks, index + 1, 'routing dispatch must increment exactly one week per decided destination');
    // The exit drained the whole queue, so this dispatch conversation's job is gone and it is finalized.
    assert.equal(ending.state.pending_finalizations.find((job) => job.conversation_id === conversationId), undefined, 'the dispatch drains the finalization on exit (no residual pending job)');
    const conversation = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
    assert.equal(conversation.discarded_after_work_record_id, `wr_${conversationId}`, 'the drained dispatch conversation is finalized on exit');
  }
});
