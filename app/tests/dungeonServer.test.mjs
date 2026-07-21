import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createServer } from '../src/server.mjs';
import { runtimePathsManifestFilename } from '../src/runtimePaths.mjs';
import { projectRoot } from './testPaths.mjs';
import { fixtureRoot, isolatedServerOptions, readJson } from './helpers.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { beginLlmActivity, resetLlmActivity } from '../src/llm/llmActivity.mjs';

const livePublicRoot = path.join(projectRoot, 'app/public');
const repoCanonicalAssetsRoot = path.join(projectRoot, 'assets/canonical');

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function baselineParameters() {
  return {
    magic: { light: { value: 12 }, dark: { value: 10 }, fire: { value: 14 }, water: { value: 8 }, earth: { value: 11 }, wind: { value: 9 } },
    abilities: { strength: { value: 28 }, agility: { value: 30 }, academics: { value: 26 }, magical_power: { value: 24 }, charisma: { value: 22 } }
  };
}

// A minimal split-layout root (no characters needed): enough for the mechanical
// solo dungeon path.
async function splitRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-dungeon-srv-'));
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '学院。', world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', baselineParameters());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1, current_location_id: 'familiar_stables', current_screen: 'academy-map', global_flags: {}, characters: {}
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  // The run view enriches usable dungeon consumables from the alchemy catalog.
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  return root;
}

async function bootServer(t, options) {
  const server = createServer(await isolatedServerOptions(t, options, 'magic-adv-dungeon-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetLlmActivity();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

// Enter is an SSE stream: read the whole body and parse the event blocks.
async function enterDungeonSse(base, body) {
  const response = await fetch(`${base}/api/dungeon/enter`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    if (!eventLine) continue;
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    events.push({ event: eventLine.slice(7), data: dataLine ? JSON.parse(dataLine.slice(6)) : null });
  }
  return { status: response.status, events };
}

function sseEvent(events, name) {
  return events.find((entry) => entry.event === name)?.data ?? null;
}

async function writeRoutingModeSettings(root) {
  const playModeSettingsPath = path.join(root, 'play-mode.json');
  await fs.writeFile(playModeSettingsPath, `${JSON.stringify({
    mode: 'routing',
    routing_persona_variant: 'fallen_star'
  }, null, 2)}\n`, 'utf8');
  return playModeSettingsPath;
}

test('dungeon mechanical path works over HTTP with no LLM configured', async (t) => {
  const root = await splitRoot();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: path.join(root, 'no-such-config.json') });

  const availability = await fetch(`${base}/api/dungeon/availability`).then((r) => r.json());
  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'lmstudio_not_configured');

  const entered = await enterDungeonSse(base, { seed: 2024 });
  const enterView = sseEvent(entered.events, 'dungeon_enter');
  assert.ok(enterView, 'the enter stream sends the dungeon board');
  assert.equal(enterView.view.active, true);
  assert.equal(enterView.companion, null, 'no companion without LLM');
  assert.equal(enterView.view.floor, 1);
  assert.ok(entered.events.some((entry) => entry.event === 'result'), 'a solo enter completes with a result');

  // Re-entering while a run is active is rejected (SSE error, no overwrite).
  const reenter = await enterDungeonSse(base, { seed: 999 });
  assert.ok(reenter.events.some((entry) => entry.event === 'error'), 're-entering an active run is rejected');

  const state = await fetch(`${base}/api/dungeon/state`).then((r) => r.json());
  assert.equal(state.active, true);
  assert.equal(state.turn, 0);

  const waited = await postJson(base, '/api/dungeon/action', { action: { type: 'wait' } });
  assert.equal(waited.body.turn, 1);

  // A solo run end (no companion) commits synchronously: no deferred finalize.
  const retreat = await postJson(base, '/api/dungeon/action', { action: { type: 'retreat' } });
  assert.equal(retreat.body.status, 'retreated');
  assert.equal(retreat.body.ended, true);
  assert.equal(retreat.body.pending_finalize, false);

  const afterState = await fetch(`${base}/api/dungeon/state`).then((r) => r.json());
  assert.equal(afterState.active, false);
});

test('availability flips to busy while background finalization is in flight', async (t) => {
  const root = await splitRoot();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'app/config/lmstudio.json');
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1234', chat_model: 'test' });
  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath });

  const idle = await fetch(`${base}/api/dungeon/availability`).then((r) => r.json());
  assert.deepEqual(idle, { available: true, reason: 'available' });

  const end = beginLlmActivity();
  try {
    const busy = await fetch(`${base}/api/dungeon/availability`).then((r) => r.json());
    assert.deepEqual(busy, { available: false, reason: 'llm_busy' });
  } finally {
    end();
  }

  const recovered = await fetch(`${base}/api/dungeon/availability`).then((r) => r.json());
  assert.equal(recovered.available, true);
});

test('with LLM available a companion joins via the conversation system and the run-end finalizes it', async (t) => {
  const root = await fixtureRoot('magic-adv-dungeon-companion-');
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  // Legacy fixture layout: point runtime paths at game_data/ under root.
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  await writeJson(root, 'game_data/runtime/player_parameters.json', baselineParameters());
  const configPath = path.join(root, 'app/config/lmstudio.json');
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1234', chat_model: 'test' });

  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath });

  const entered = await enterDungeonSse(base, { seed: 8080, provider: 'mock', with_companion: true });
  const enterView = sseEvent(entered.events, 'dungeon_enter');
  assert.ok(enterView, 'the enter stream sends the dungeon board');
  assert.equal(enterView.view.active, true);
  assert.equal(enterView.availability.available, true);
  assert.notEqual(enterView.companion, null, 'a companion appears when LLM is available');
  assert.equal(typeof enterView.companion.character_id, 'string');
  // The companion opening streams (token deltas + completion) rather than arriving whole.
  assert.ok(
    entered.events.some((entry) => entry.event === 'assistant_delta' || entry.event === 'assistant_complete'),
    'the companion greets on joining via a streamed opening'
  );
  const openingResult = sseEvent(entered.events, 'result');
  assert.ok(openingResult?.conversation && Array.isArray(openingResult.conversation.messages), 'the opening completes as a conversation');

  // Talking to the companion reuses the conversation system (mock provider).
  const talk = await postJson(base, '/api/dungeon/companion/talk', { player_input: 'よろしく', provider: 'mock' });
  assert.equal(Array.isArray(talk.body.conversation.messages), true);

  // A companion run end returns a preview and defers its finalize; /finalize banks + clears.
  const retreat = await postJson(base, '/api/dungeon/action', { action: { type: 'retreat' }, provider: 'mock' });
  assert.equal(retreat.body.status, 'retreated');
  assert.equal(retreat.body.pending_finalize, true, 'the companion run end is deferred');
  const finalize = await postJson(base, '/api/dungeon/finalize', { provider: 'mock' });
  assert.equal(finalize.body.status, 'retreated');
  assert.equal(finalize.body.pending_finalize, false);
  const afterState = await fetch(`${base}/api/dungeon/state`).then((r) => r.json());
  assert.equal(afterState.active, false, 'the deferred finalize clears the run');
});

test('routing dungeon deferred finalize returns to the hub through the mode-owned transition', async (t) => {
  const root = await fixtureRoot('magic-adv-dungeon-routing-finalize-');
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  await writeJson(root, 'game_data/runtime/player_parameters.json', baselineParameters());
  const configPath = path.join(root, 'app/config/lmstudio.json');
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1234', chat_model: 'test' });
  const playModeSettingsPath = await writeRoutingModeSettings(root);
  const base = await bootServer(t, { root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath, playModeSettingsPath });
  const started = await postJson(base, '/api/new-game', {});
  assert.equal(started.status, 200);

  const entered = await enterDungeonSse(base, { seed: 8080, provider: 'mock', with_companion: true });
  assert.notEqual(sseEvent(entered.events, 'dungeon_enter').companion, null);

  const retreat = await postJson(base, '/api/dungeon/action', { action: { type: 'retreat' }, provider: 'mock' });
  assert.equal(retreat.body.pending_finalize, true);
  assert.equal(retreat.body.transition.next_screen, 'interaction');

  const finalize = await postJson(base, '/api/dungeon/finalize', { provider: 'mock' });
  assert.equal(finalize.body.status, 'retreated');
  assert.equal(finalize.body.pending_finalize, false);
  assert.equal(finalize.body.transition.next_screen, 'interaction');
  assert.equal(finalize.body.state.current_screen, 'interaction');
});

test('the companion conversation is framed in dungeon context and the entry log marks the encounter', async (t) => {
  const root = await fixtureRoot('magic-adv-dungeon-context-');
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  await writeJson(root, 'game_data/runtime/player_parameters.json', baselineParameters());
  const configPath = path.join(root, 'app/config/lmstudio.json');
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1234', chat_model: 'test' });
  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath });

  const entered = await enterDungeonSse(base, { seed: 8080, provider: 'mock', with_companion: true });
  const enterView = sseEvent(entered.events, 'dungeon_enter');
  assert.notEqual(enterView.companion, null, 'a companion appears when LLM is available');
  // The always-visible run log marks the encounter / joining-up (text-centric affordance).
  assert.ok(
    enterView.view.log.some((line) => line.includes('遭遇') && line.includes('一緒に')),
    'entry log marks the dungeon encounter and joining up'
  );

  // The opening prompt is framed in dungeon context (floor + encounter), not the academy field location.
  const opening = await readJson(root, 'game_data/logs/conversations/conv_dungeon_dr_8080.json');
  assert.match(opening.prompt, /舞台: 実践ダンジョン 第1層/);
  assert.match(opening.prompt, /探索の途中で主人公と出会い、ここから一緒に潜ることになった。/);
  assert.doesNotMatch(opening.prompt, /舞台: 薬草温室/, 'opening scene must not be the academy field location');
  // The opening RECORD (finalization / post-processing input) declares the dungeon source_type and carries the
  // floor scene, not the residual field location_id / time_slot the player entered from.
  assert.equal(opening.source_type, 'dungeon');
  assert.equal(opening.location_name, '実践ダンジョン 第1層');
  assert.equal(Object.hasOwn(opening, 'location_id'), false);
  assert.equal(Object.hasOwn(opening, 'time_slot'), false);

  const beforeTalkState = await readJson(root, 'game_data/runtime_state.json');
  const run = beforeTalkState.dungeon_run;
  const nearX = Math.min(run.width - 1, run.player.x + 1);
  const nearY = run.player.y;
  run.player.hp = 5;
  run.player.mp = 3;
  run.companion.hp = 7;
  run.companion.mp = 4;
  run.enemies = [{ uid: 'near_enemy', archetype_id: 'stone_golem', name: '石塊ゴーレム', element: 'earth', glyph: 'G', x: nearX, y: nearY, hp: 40, max_hp: 80, attack: 4, defense: 2, speed: 60 }];
  run.items = [{ uid: 'near_item', kind: 'heal_herb', x: nearX, y: nearY }];
  run.explored[nearY][nearX] = true;
  await writeJson(root, 'game_data/runtime_state.json', beforeTalkState);

  // A companion turn keeps the dungeon-floor exploration scene.
  const talk = await postJson(base, '/api/dungeon/companion/talk', { player_input: 'この先、気をつけよう', provider: 'mock' });
  assert.equal(Array.isArray(talk.body.conversation.messages), true);
  const afterTalk = await readJson(root, 'game_data/logs/conversations/conv_dungeon_dr_8080.json');
  assert.match(afterTalk.prompt, /舞台: 実践ダンジョン 第1層/);
  assert.match(afterTalk.prompt, /実践ダンジョンの第1層を主人公と一緒に探索している。/);
  assert.match(afterTalk.prompt, /追加の現在状況:/);
  assert.match(afterTalk.prompt, /主人公: HP 5\/\d+, MP 3\/\d+/);
  assert.match(afterTalk.prompt, /同行者 .+: HP 7\/\d+, MP 4\/\d+/);
  assert.match(afterTalk.prompt, /近くの敵: 石塊ゴーレム HP 40\/80/);
  assert.match(afterTalk.prompt, /近くのアイテム: 癒し草/);
  assert.doesNotMatch(afterTalk.prompt, /舞台: 薬草温室/, 'companion turn scene must not be the academy field location');
  // The turn RECORD keeps the dungeon contract: dungeon source_type + current-floor scene, no field residual.
  assert.equal(afterTalk.source_type, 'dungeon');
  assert.equal(afterTalk.location_name, '実践ダンジョン 第1層');
  assert.equal(Object.hasOwn(afterTalk, 'location_id'), false);
  assert.equal(Object.hasOwn(afterTalk, 'time_slot'), false);
});

test('a failed companion-conversation finalize at run end fails the request (fail-fast, not swallowed)', async (t) => {
  const root = await fixtureRoot('magic-adv-dungeon-finalize-fail-');
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  await writeJson(root, 'game_data/runtime/player_parameters.json', baselineParameters());
  const configPath = path.join(root, 'app/config/lmstudio.json');
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1234', chat_model: 'test' });
  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath });

  const entered = await enterDungeonSse(base, { seed: 8080, provider: 'mock', with_companion: true });
  assert.notEqual(sseEvent(entered.events, 'dungeon_enter').companion, null);

  // Point the companion at a conversation log that does not exist so finalize
  // throws, and inject pending gains so a (wrong) bank would be observable.
  const state = await readJson(root, 'game_data/runtime_state.json');
  state.dungeon_run.companion.conversation_id = 'conv_dungeon_missing_log';
  state.dungeon_run.pending_gains.abilities.strength = 6;
  await writeJson(root, 'game_data/runtime_state.json', state);
  const strengthBefore = (await readJson(root, 'game_data/runtime/player_parameters.json')).abilities.strength.value;

  // The ended action returns a preview and holds the run (no bank, no clear yet).
  const retreat = await postJson(base, '/api/dungeon/action', { action: { type: 'retreat' }, provider: 'mock' });
  assert.equal(retreat.status, 200);
  assert.equal(retreat.body.pending_finalize, true, 'a companion run end is deferred to /finalize');
  const held = await readJson(root, 'game_data/runtime_state.json');
  assert.notEqual(held.dungeon_run, null, 'the run is held awaiting its finalize');

  // The deferred finalize fails -> surfaces as a failed request; the run is NOT
  // confirmed — still present (retryable), gains not banked.
  const finalize = await postJson(base, '/api/dungeon/finalize', { provider: 'mock' });
  assert.notEqual(finalize.status, 200, 'a failed deferred finalize surfaces as a failed request');
  assert.equal(typeof finalize.body.error, 'string');
  const after = await readJson(root, 'game_data/runtime_state.json');
  assert.notEqual(after.dungeon_run, null, 'failed finalize leaves the run held');
  assert.deepEqual(after.dungeon_run.pending_finalize, { outcome: 'retreated' });
  const strengthAfter = (await readJson(root, 'game_data/runtime/player_parameters.json')).abilities.strength.value;
  assert.equal(strengthAfter, strengthBefore, 'failed finalize does not bank gains');
});

test('a failed companion opening at enter surfaces an SSE error and commits no run (no silent solo)', async (t) => {
  const root = await fixtureRoot('magic-adv-dungeon-open-fail-');
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  await writeJson(root, 'game_data/runtime/player_parameters.json', baselineParameters());
  const configPath = path.join(root, 'app/config/lmstudio.json');
  // Configured (so availability is true and a companion rolls) but unreachable: the real opening
  // LLM call fails. The enter must surface that and commit NO run — never a silent solo fallback.
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1', chat_model: 'test' });
  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath });

  // No provider: 'mock' here, so the opening attempts the (unreachable) real provider.
  const entered = await enterDungeonSse(base, { seed: 8080, with_companion: true });
  assert.notEqual(sseEvent(entered.events, 'dungeon_enter')?.companion, null, 'the board offered a companion before the opening');
  assert.ok(entered.events.some((entry) => entry.event === 'error'), 'a failed opening surfaces as an SSE error');

  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.dungeon_run ?? null, null, 'a failed opening commits no run (no silent solo run left behind)');
});

test('re-entering while a run is held awaiting its deferred finalize is rejected, not downgraded to solo', async (t) => {
  const root = await fixtureRoot('magic-adv-dungeon-reenter-held-');
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify({
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  }, null, 2)}\n`, 'utf8');
  await writeJson(root, 'game_data/runtime/player_parameters.json', baselineParameters());
  const configPath = path.join(root, 'app/config/lmstudio.json');
  await writeJson(root, 'app/config/lmstudio.json', { base_url: 'http://127.0.0.1:1234', chat_model: 'test' });
  const base = await bootServer(t, { root, activeRoot: root, publicRoot: livePublicRoot, lmStudioConfigPath: configPath });

  const entered = await enterDungeonSse(base, { seed: 8080, provider: 'mock', with_companion: true });
  assert.notEqual(sseEvent(entered.events, 'dungeon_enter').companion, null);

  // Retreat defers the finalize: the run is held (pending_finalize). This is the exact state the
  // exit's background finalize runs against, so it stands in for "enter during background finalize".
  const retreat = await postJson(base, '/api/dungeon/action', { action: { type: 'retreat' }, provider: 'mock' });
  assert.equal(retreat.body.pending_finalize, true);

  // Re-entering now is rejected as already-active — never silently downgraded to a fresh solo run.
  const reenter = await enterDungeonSse(base, { seed: 9090, provider: 'mock', with_companion: true });
  assert.ok(reenter.events.some((entry) => entry.event === 'error'), 're-entering a held run is rejected');
  assert.equal(sseEvent(reenter.events, 'dungeon_enter') ?? null, null, 'no fresh board/run is offered for the rejected re-enter');

  // The held run is untouched: still the same companion run awaiting finalize (not a new solo run).
  const held = await readJson(root, 'game_data/runtime_state.json');
  assert.notEqual(held.dungeon_run, null);
  assert.deepEqual(held.dungeon_run.pending_finalize, { outcome: 'retreated' });
  assert.notEqual(held.dungeon_run.companion, null, 'the held run keeps its companion (no solo downgrade)');
});
