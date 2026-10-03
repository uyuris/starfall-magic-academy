// 残す (a): 起動が active slot の meta を書き換える壊れ方と、new game が親の live 進行を新しい slot へ持ち込む壊れ方から、プレイヤーの slot を守る。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.mjs';
import { createSaveSlot as createSaveSlotCore, loadSaveSlot } from '../src/saveLoad.mjs';
import { fixtureRoot, isolatedServerOptions, readJson, writeJson } from './helpers.mjs';

function createSaveSlot(options) {
  return createSaveSlotCore({ playMode: 'loop', ...options });
}

async function withHttpServer(t, root, serverOptions = {}) {
  const server = createServer(await isolatedServerOptions(t, { root, ...serverOptions }, 'magic-adv-active-slot-play-mode-'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function jsonFetch(url, options) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

test('server startup restores valid active slot before serving live play state without rewriting active slot metadata', async (t) => {
  const root = await fixtureRoot('magic-adv-active-slot-startup-');
  await createSaveSlot({ root, slotId: 'slot_001', label: 'active slot', now: '2026-05-25T10:00:00.000+09:00' });
  await loadSaveSlot({ root, slotId: 'slot_001' });
  const activeBefore = await readJson(root, 'game_data/play/active_slot.json');

  const parentState = await readJson(root, 'game_data/runtime_state.json');
  parentState.current_location_id = 'parent_should_not_be_read';
  parentState.current_screen = 'interaction';
  await writeJson(root, 'game_data/runtime_state.json', parentState);

  const slotState = await readJson(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json');
  slotState.current_location_id = 'slot_state_location';
  slotState.current_screen = 'academy-map';
  await writeJson(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json', slotState);

  const base = await withHttpServer(t, root);
  const { response, body } = await jsonFetch(`${base}/api/state`);
  const activeAfter = await readJson(root, 'game_data/play/active_slot.json');

  assert.equal(response.status, 200);
  assert.equal(body.current_location_id, 'slot_state_location');
  assert.notEqual(body.current_location_id, 'parent_should_not_be_read');
  assert.deepEqual(activeAfter, activeBefore, 'startup routing restore must not rewrite active_slot.json metadata');
});

test('new game ignores parent live progress while preserving only shared execution policy', async (t) => {
  const root = await fixtureRoot('magic-adv-new-game-parent-boundary-');
  const parentState = await readJson(root, 'game_data/runtime_state.json');
  parentState.current_location_id = 'parent_stale_location';
  parentState.current_screen = 'interaction';
  parentState.current_interaction_character_id = 'lina';
  parentState.visited_locations = ['parent_stale_location'];
  parentState.global_flags = { 'stage.parent_stale': true };
  parentState.active_character_ids = ['parent_stale_character'];
  parentState.current_buddy_character_id = 'parent_stale_buddy';
  parentState.current_enemy_character_ids = ['parent_stale_enemy'];
  parentState.disabled_stage_flag_judgment_flows = { 'stage.shared_policy': true };
  await writeJson(root, 'game_data/runtime_state.json', parentState);
  await writeJson(root, 'game_data/player_inventory.json', { money: 9999, items: [{ item_id: 'stale_item', count: 1 }] });
  await writeJson(root, 'game_data/runtime/player_parameters.json', { intellect: 99, magic: 99, stamina: 99, charm: 99, ethics: 99 });

  const base = await withHttpServer(t, root);
  const newGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: JSON.stringify({}) });

  assert.equal(newGame.response.status, 200);
  assert.equal(newGame.body.state.current_location_id, 'herbology_garden');
  assert.equal(newGame.body.state.current_screen, 'academy-map');
  assert.deepEqual(newGame.body.state.visited_locations, ['herbology_garden']);
  assert.equal(newGame.body.state.current_interaction_character_id, null);
  assert.deepEqual(newGame.body.state.active_character_ids, []);
  assert.equal(newGame.body.state.current_buddy_character_id, null);
  assert.deepEqual(newGame.body.state.current_enemy_character_ids, []);
  assert.equal(newGame.body.state.global_flags['stage.parent_stale'], undefined);
  assert.deepEqual(newGame.body.state.disabled_stage_flag_judgment_flows, { 'stage.shared_policy': true });
  assert.equal(newGame.body.player_parameters.magic.light.value, 25);
  assert.equal(newGame.body.player_parameters.magic.dark.value, 25);
  assert.equal(newGame.body.player_parameters.abilities.strength.value, 25);
  assert.equal(newGame.body.player_parameters.abilities.charisma.value, 25);

  const inventory = await readJson(root, `game_data/play/slots/${newGame.body.slot.slot_id}/game_data/player_inventory.json`);
  assert.deepEqual(inventory, { money: 0, items: [] });
});
