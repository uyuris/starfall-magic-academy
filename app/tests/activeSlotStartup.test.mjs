import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createServer } from '../src/server.mjs';
import { isValidSlot } from '../src/playSession.mjs';
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

test('server startup treats invalid active slot as no active slot and refuses parent-state fallback', async (t) => {
  const root = await fixtureRoot('magic-adv-invalid-active-slot-');
  await createSaveSlot({ root, slotId: 'slot_001', label: 'valid but inactive', now: '2026-05-25T10:00:00.000+09:00' });
  await fs.mkdir(path.join(root, 'game_data/play'), { recursive: true });
  await writeJson(root, 'game_data/play/active_slot.json', {
    slot_id: 'slot_missing',
    activated_at: '2026-05-25T10:05:00.000+09:00',
    label: 'missing slot'
  });

  const parentState = await readJson(root, 'game_data/runtime_state.json');
  parentState.current_location_id = 'parent_should_not_be_read';
  await writeJson(root, 'game_data/runtime_state.json', parentState);

  const base = await withHttpServer(t, root);
  const stateResult = await jsonFetch(`${base}/api/state`);
  const fieldResult = await jsonFetch(`${base}/api/field`);
  const moveResult = await jsonFetch(`${base}/api/field/move`, {
    method: 'POST',
    body: JSON.stringify({ location_id: 'herbology_garden' })
  });
  const slotsResult = await jsonFetch(`${base}/api/slots`);

  for (const result of [stateResult, fieldResult, moveResult]) {
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error_code, 'NO_ACTIVE_SLOT');
  }
  assert.equal(slotsResult.response.status, 200);
  assert.equal(slotsResult.body.active_slot_id, null);
  assert.deepEqual(slotsResult.body.slots.map((slot) => slot.slot_id), ['slot_001']);
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

test('routing mode new-game fails fast on invalid active slot metadata instead of treating it as first start', async (t) => {
  const root = await fixtureRoot('magic-adv-routing-invalid-active-slot-');
  const settingsRoot = await fs.mkdtemp(path.join(root, 'settings-'));
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await writeJson(settingsRoot, 'play-mode.json', { mode: 'routing', routing_persona_variant: 'fallen_star' });
  await fs.mkdir(path.join(root, 'game_data/play'), { recursive: true });
  await writeJson(root, 'game_data/play/active_slot.json', {
    slot_id: '../escape',
    activated_at: '2026-05-25T10:05:00.000+09:00',
    label: 'invalid slot'
  });

  const base = await withHttpServer(t, root, { playModeSettingsPath: settingsPath });
  const result = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: JSON.stringify({}) });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error_code, 'invalid_slot_id');
  assert.match(result.body.error, /invalid slotId/);
});

test('routing mode slot-load without an active slot validates the explicit target before loading', async (t) => {
  const root = await fixtureRoot('magic-adv-routing-load-target-scope-');
  const settingsRoot = await fs.mkdtemp(path.join(root, 'settings-'));
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await writeJson(settingsRoot, 'play-mode.json', { mode: 'routing', routing_persona_variant: 'fallen_star' });
  await createSaveSlot({ root, slotId: 'slot_001', label: 'loadable slot', now: '2026-05-25T10:00:00.000+09:00' });

  const base = await withHttpServer(t, root, { playModeSettingsPath: settingsPath });
  const result = await jsonFetch(`${base}/api/slots/load`, {
    method: 'POST',
    body: JSON.stringify({ slot_id: '../escape' })
  });

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error_code, 'invalid_slot_id');
  assert.match(result.body.error, /invalid slotId/);
});

test('valid-slot contract rejects broken JSON and disallowed slot ids', async () => {
  const root = await fixtureRoot('magic-adv-valid-slot-contract-shapes-');
  await createSaveSlot({ root, slotId: 'slot_valid', label: 'valid', now: '2026-05-25T10:00:00.000+09:00' });

  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_broken_meta/game_data'), { recursive: true });
  await writeJson(root, 'game_data/play/slots/slot_broken_meta/game_data/runtime_state.json', { current_location_id: 'herbology_garden' });
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_broken_meta/meta.json'), '{ broken', 'utf8');

  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_broken_runtime/game_data'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_broken_runtime/game_data/runtime_state.json'), '{ broken', 'utf8');
  await writeJson(root, 'game_data/play/slots/slot_broken_runtime/meta.json', { slot_id: 'slot_broken_runtime' });

  await fs.mkdir(path.join(root, 'game_data/play/slots/invalidSlot/game_data'), { recursive: true });
  await writeJson(root, 'game_data/play/slots/invalidSlot/game_data/runtime_state.json', { current_location_id: 'herbology_garden' });
  await writeJson(root, 'game_data/play/slots/invalidSlot/meta.json', { slot_id: 'invalidSlot' });

  assert.equal(await isValidSlot(root, 'slot_valid'), true);
  assert.equal(await isValidSlot(root, 'slot_broken_meta'), false);
  assert.equal(await isValidSlot(root, 'slot_broken_runtime'), false);
  assert.equal(await isValidSlot(root, 'invalidSlot'), false);
});

test('slot mutation APIs reject directories that do not satisfy the valid-slot contract', async (t) => {
  const root = await fixtureRoot('magic-adv-valid-slot-contract-');
  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_999/game_data'), { recursive: true });
  await writeJson(root, 'game_data/play/slots/slot_999/meta.json', {
    slot_id: 'slot_999',
    label: 'broken slot',
    created_at: '2026-05-25T10:00:00.000+09:00',
    updated_at: '2026-05-25T10:00:00.000+09:00',
    current_location_id: 'missing-runtime',
    current_screen: 'academy-map'
  });

  const base = await withHttpServer(t, root);
  const loadResult = await jsonFetch(`${base}/api/slots/load`, {
    method: 'POST',
    body: JSON.stringify({ slot_id: 'slot_999' })
  });
  const noteResult = await jsonFetch(`${base}/api/slots/slot_999/note`, {
    method: 'PATCH',
    body: JSON.stringify({ player_note: 'should not save' })
  });
  const deleteResult = await jsonFetch(`${base}/api/slots/slot_999`, { method: 'DELETE' });

  assert.equal(loadResult.response.status, 400);
  assert.equal(loadResult.body.error_code, 'invalid_slot');
  assert.equal(noteResult.response.status, 400);
  assert.equal(noteResult.body.error_code, 'invalid_slot');
  assert.equal(deleteResult.response.status, 400);
  assert.equal(deleteResult.body.error_code, 'invalid_slot');
  assert.equal(await fs.access(path.join(root, 'game_data/play/slots/slot_999')).then(() => true), true);
});
