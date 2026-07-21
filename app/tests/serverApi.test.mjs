import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureRoot, isolatedServerOptions, readJson, writeJson } from './helpers.mjs';
import { pooledLegacyFixtureRoot } from './fixtures/serverFixturePool.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { projectRoot } from './testPaths.mjs';
import { createServer } from '../src/server.mjs';
import { runtimePathsManifestFilename } from '../src/runtimePaths.mjs';
import { finalizeConversation as finalizeConversationCore } from '../src/llm/conversationPipeline.mjs';
import { handleConversationLifecycleApi } from '../src/server/conversationLifecycleApi.mjs';
import { TRAINING_ACTION_LIMIT, trainingDefinitions } from '../src/training.mjs';
import { MAX_FLOORS } from '../src/dungeon/dungeonEngine.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions, normalizeParameters } from '../src/parameters.mjs';
import { ROUTING_ACTIVE_ERRAND_STATE_KEY } from '../src/routingErrands.mjs';
import { ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY } from '../src/routingStudyCircle.mjs';
import { ROUTING_CONTENT_RESULT_STATE_KEY } from '../src/routingContentResult.mjs';
import { ROUTING_PERSONA_VARIANTS } from '../src/playMode.mjs';
import { initializeNewPlayArea } from '../src/playSession.mjs';
import { resolveAcademyConversationLandingScreen } from '../src/server/conversationPopupSettingsApi.mjs';

// creature_003 (淵主) authored stats, mirrored from content/creatures/creature_003/profile.json.
// The catalog/field API normalizes these into the academy meter shape; the encounter
// summary must carry them so the client renders the same meters as students.
const CREATURE_003_PARAMETER_ATTITUDE_TYPE = 'equal_average_respect_1_2';
const CREATURE_003_PARAMETERS = normalizeParameters({
  magic: { light: 40, dark: 46, fire: 16, water: 94, earth: 50, wind: 24 },
  abilities: { strength: 80, agility: 44, academics: 78, magical_power: 84, charisma: 58 }
});

const livePublicRoot = path.join(projectRoot, 'app/public');
const repoCanonicalAssetsRoot = path.join(projectRoot, 'assets/canonical');

function finalizeConversation(args) {
  return finalizeConversationCore({ affinityDeltaProvider: async () => '0', ...args });
}
const sanrinLocationContracts = [
  {
    id: 'sanrin_trailhead',
    display_name: '山道入口',
    background_manifest_id: 'sanrin_trailhead',
    background_url: '/canonical/backgrounds/sanrin_background_001.jpg'
  },
  {
    id: 'sanrin_conifer_forest',
    display_name: '深い針葉樹林',
    background_manifest_id: 'sanrin_conifer_forest',
    background_url: '/canonical/backgrounds/sanrin_background_002.jpg'
  },
  {
    id: 'sanrin_stream_bank',
    display_name: '渓流のほとり',
    background_manifest_id: 'sanrin_stream_bank',
    background_url: '/canonical/backgrounds/sanrin_background_003.jpg'
  },
  {
    id: 'sanrin_mossy_shrine',
    display_name: '苔むした古祠',
    background_manifest_id: 'sanrin_mossy_shrine',
    background_url: '/canonical/backgrounds/sanrin_background_004.jpg'
  }
];
const gatheringPointContracts = [
  {
    point_id: 'sanrin_trailhead_silverleaf_patch',
    location_id: 'sanrin_trailhead',
    item_id: 'silverleaf_sprout',
    image: '/canonical/gathering/points/sanrin_trailhead_silverleaf_patch.png',
    icon: '/canonical/gathering/material-icons/silverleaf_sprout.png',
    stock_max: 3,
    sell_price: 4
  },
  {
    point_id: 'sanrin_conifer_forest_resin_cluster',
    location_id: 'sanrin_conifer_forest',
    item_id: 'star_resin_amber',
    image: '/canonical/gathering/points/sanrin_conifer_forest_resin_cluster.png',
    icon: '/canonical/gathering/material-icons/star_resin_amber.png',
    stock_max: 3,
    sell_price: 6
  },
  {
    point_id: 'sanrin_stream_bank_mica_pebbles',
    location_id: 'sanrin_stream_bank',
    item_id: 'mica_stream_pebble',
    image: '/canonical/gathering/points/sanrin_stream_bank_mica_pebbles.png',
    icon: '/canonical/gathering/material-icons/mica_stream_pebble.png',
    stock_max: 3,
    sell_price: 3
  },
  {
    point_id: 'sanrin_mossy_shrine_blue_moss',
    location_id: 'sanrin_mossy_shrine',
    item_id: 'ancient_shrine_moss',
    image: '/canonical/gathering/points/sanrin_mossy_shrine_blue_moss.png',
    icon: '/canonical/gathering/material-icons/ancient_shrine_moss.png',
    stock_max: 3,
    sell_price: 5
  },
  {
    point_id: 'sanrin_conifer_forest_yuragi_bulb',
    location_id: 'sanrin_conifer_forest',
    item_id: 'star_cradle_yuragi_bulb',
    image: '/canonical/gathering/points/sanrin_conifer_forest_yuragi_bulb.png',
    icon: '/canonical/star-cradle/item-icons/star_cradle_yuragi_bulb.png',
    stock_max: 1,
    sell_price: 0
  },
  {
    point_id: 'sanrin_mossy_shrine_madara_egg',
    location_id: 'sanrin_mossy_shrine',
    item_id: 'star_cradle_madara_egg',
    image: '/canonical/gathering/points/sanrin_mossy_shrine_madara_egg.png',
    icon: '/canonical/star-cradle/item-icons/star_cradle_madara_egg.png',
    stock_max: 1,
    sell_price: 0
  },
  {
    point_id: 'sanrin_stream_bank_warm_egg',
    location_id: 'sanrin_stream_bank',
    item_id: 'star_cradle_warm_egg',
    image: '/canonical/gathering/points/sanrin_stream_bank_warm_egg.png',
    icon: '/canonical/star-cradle/item-icons/star_cradle_warm_egg.png',
    stock_max: 1,
    sell_price: 0
  }
];

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

// Full-copy legacy fixture for the tests that read or persist character
// authoring directly under `root/game_data/characters` (which the shared,
// read-only pool intentionally does not materialize there).
async function withPrivateAuthoringServer(t, serverOptions = {}) {
  const root = await fixtureRoot('magic-adv-server-api-');
  await writeLegacyFixtureRuntimePaths(root);
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

async function withRoutingLmStub(t, responder = null) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ method: req.method, url: req.url, body });
    const prompt = body.messages?.[0]?.content ?? '';
    const content = responder
      ? responder({ body, prompt, requestIndex: requests.length - 1 })
      : '新しい週をここから始めましょう。';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function routingTurnLmResponder({ body, prompt, requestIndex }) {
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'training';
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) {
    return 'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。';
  }
  // Drain-on-exit finalizes the hub conversation synchronously at dispatch, so the shared turn responder
  // also answers the finalization judgments with neutral values (no money delta / no buddy / no enemy /
  // no affinity delta) and lets the memory / work-record builders take any plain text.
  if (prompt.includes('所持金を判定')) return '0';
  if (prompt.includes('バディになる合意')) return 'false';
  if (prompt.includes('敵対関係が相互に成立')) return 'false';
  if (prompt.includes('好感度の変化量を判定')) return '0';
  if (requestIndex === 0) return '新しい週をここから始めましょう。';
  return '鍛錬ですね。今の伸ばしたい力にも合っています。';
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

// The wrap-up ('title') in-turn responder: ルミ decides the neutral exit, then the wrap-up fully drains
// the hub finalization synchronously, so this also answers the finalization judgments with neutral
// values (no money delta / no buddy / no enemy / no affinity delta) and lets the memory / work-record
// builders take any plain text. Empty stage/event flag definitions mean no flag-judgment LM calls.
function routingTurnTitleLmResponder({ body, prompt, requestIndex }) {
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'true';
  if (prompt.includes('ルーティングハブ会話内容') && prompt.includes('destination_id')) return 'title';
  if (prompt.includes('行き先が確定したプレイヤーを送り出す')) {
    return 'では、今日はここまでにしましょう。また続きから始められます。';
  }
  if (prompt.includes('所持金を判定')) return '0';
  if (prompt.includes('バディになる合意')) return 'false';
  if (prompt.includes('敵対関係が相互に成立')) return 'false';
  if (prompt.includes('好感度の変化量を判定')) return '0';
  if (requestIndex === 0) return '新しい週をここから始めましょう。';
  return 'わかりました。今日はここで一区切りにしましょう。';
}

// A routing turn responder whose continuation judgment returns invalid output (neither true nor false).
// The strict continuation parser must fail the turn fast (structured error) before persistence, so no
// destination is ever judged for this turn.
function routingInvalidContinuationLmResponder({ body, prompt, requestIndex }) {
  const schemaName = body.response_format?.json_schema?.name ?? '';
  if (schemaName === 'character_emotion_choice') return JSON.stringify({ expression: 'joy' });
  if (schemaName === 'work_record_recall_choice') return JSON.stringify({ work_record_ids: [] });
  if (prompt.includes('この発言を行ったプレイヤーとの会話を継続したいと思うか')) return 'maybe';
  if (requestIndex === 0) return '新しい週をここから始めましょう。';
  return '鍛錬ですね。今の伸ばしたい力にも合っています。';
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

async function writeLoopModeSettings(t, prefix = 'loop-mode-settings-') {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');
  return settingsPath;
}

// A new game now always starts routing with a uniformly-random persona variant, so a test that needs a
// deterministic persona pins the freshly-created slot's variant after new-game. This writes only the slot
// meta variant (the read path resolves the persona from it); it never touches the global sidecar.
async function forceRoutingSlotPersonaVariant(root, slotId, variant) {
  const metaPath = path.join(root, 'game_data/play/slots', slotId, 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  await fs.writeFile(metaPath, `${JSON.stringify({ ...meta, routing_persona_variant: variant }, null, 2)}\n`, 'utf8');
}

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitServerRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-server-split-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', [{ id: 'herbology_garden', name: '薬草園' }]);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'split server fixture',
    world_condition_texts: []
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    disabled_stage_flag_judgment_flows: {},
    visited_locations: ['herbology_garden'],
    active_character_ids: [],
    last_conversation_id: null,
    characters: {},
    pending_interaction_context: null,
    training_actions_used: 0,
    training_actions_limit: 6,
    elapsed_weeks: 0,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/player_inventory.json', { money: 0, items: [] });
  await writeSplitJson(root, 'data/mutable/game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  await writeSplitJson(root, 'data/mutable/game_data/play/active_slot.json', { slot_id: 'slot_002' });
  await writeSplitJson(root, 'data/mutable/game_data/play/slots/slot_001/meta.json', {
    slot_id: 'slot_001',
    label: 'slot 001',
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:00:00.000+09:00',
    player_note: '',
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    play_mode: 'loop'
  });
  await writeSplitJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    ending_completed: false
  });
  await writeSplitJson(root, 'data/mutable/game_data/play/slots/slot_002/meta.json', {
    slot_id: 'slot_002',
    label: 'slot 002',
    created_at: '2026-05-05T06:10:00.000+09:00',
    updated_at: '2026-05-05T06:10:00.000+09:00',
    player_note: '',
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    play_mode: 'loop'
  });
  await writeSplitJson(root, 'data/mutable/game_data/play/slots/slot_002/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    ending_completed: false
  });
  return root;
}

async function withSplitServer(t) {
  const root = await splitServerRoot();
  await writeSplitFixtureRuntimePaths(root);
  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
  }, 'magic-adv-split-server-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = server.address();
  return { root, base: `http://127.0.0.1:${port}` };
}

async function writeFixtureRuntimePaths(root, manifest) {
  await fs.writeFile(path.join(root, runtimePathsManifestFilename), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function writeLegacyFixtureRuntimePaths(root) {
  await writeFixtureRuntimePaths(root, {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'game_data'),
    seedsRoot: path.join(root, 'game_data'),
    mutableRoot: path.join(root, 'game_data'),
    characterContentRoot: path.join(root, 'game_data/characters'),
    creatureContentRoot: path.join(root, 'game_data/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  });
}

async function writeSplitFixtureRuntimePaths(root) {
  await writeFixtureRuntimePaths(root, {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'data/definitions/game_data'),
    mutableRoot: path.join(root, 'data/mutable/game_data'),
    characterContentRoot: path.join(root, 'content/characters'),
    creatureContentRoot: path.join(root, 'content/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  });
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

function expectedImageContentType(assetPath) {
  if (/\.jpe?g$/i.test(assetPath)) return 'image/jpeg';
  if (/\.png$/i.test(assetPath)) return 'image/png';
  throw new Error(`unsupported image extension in test asset path: ${assetPath}`);
}

async function seedCreatureProfiles(root) {
  await fs.cp(path.join(projectRoot, 'content/creatures'), path.join(root, 'game_data/creatures'), { recursive: true });
}

async function withMathRandom(value, callback) {
  const originalRandom = Math.random;
  Math.random = () => value;
  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

async function writeActiveSlotRuntimeState(root, slotId, state) {
  await writeJson(root, `game_data/play/slots/${slotId}/game_data/runtime_state.json`, state);
}

async function waitFor(assertion, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError;
}

function createLifecycleReqRes() {
  const req = { method: 'POST' };
  const res = {};
  return { req, res };
}

test('save and conversation APIs reject invalid filesystem-backed ids with 400 responses', async (t) => {
  const { root, base } = await withServer(t);

  const saveResponse = await fetch(`${base}/api/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slot_id: '../escape', label: 'bad slot' })
  });
  assert.equal(saveResponse.status, 400);
  assert.deepEqual(await saveResponse.json(), {
    error: 'invalid slotId: ../escape',
    error_code: 'invalid_slot_id'
  });

  const openingResponse = await fetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '../escape', character_id: 'lina', provider: 'mock' })
  });
  assert.equal(openingResponse.status, 400);
  assert.deepEqual(await openingResponse.json(), {
    error: 'invalid id: ../escape',
    error_code: 'invalid_conversation_id'
  });

  await assert.rejects(fs.access(path.join(root, 'game_data/logs/conversations/../escape.json')), { code: 'ENOENT' });
});

test('character authoring stays enabled on browser server and is rejected on desktop-configured server', async (t) => {
  const { base: browserBase } = await withPrivateAuthoringServer(t);
  const browserCharacters = await jsonFetch(`${browserBase}/api/characters`);
  assert.equal(browserCharacters.capabilities?.character_authoring?.enabled, true);
  assert.equal(browserCharacters.capabilities?.character_authoring?.reason, null);

  const { root, base: desktopBase } = await withPrivateAuthoringServer(t, {
    characterAuthoringEnabled: false,
    characterAuthoringDisabledReason: 'desktop_runtime_read_only'
  });
  const desktopCharactersResponse = await fetch(`${desktopBase}/api/characters`);
  assert.equal(desktopCharactersResponse.status, 200);
  const desktopCharacters = await desktopCharactersResponse.json();
  assert.deepEqual(desktopCharacters.capabilities?.character_authoring, {
    enabled: false,
    reason: 'desktop_runtime_read_only',
    message: 'デスクトップ版ではキャラクター説明の編集は無効です。ブラウザ実行で編集してください。'
  });

  const saveResponse = await fetch(`${desktopBase}/api/characters/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      character_id: 'character_001',
      prompt_description: 'desktop should not write',
      speaking_basis: 'desktop should not write'
    })
  });
  assert.equal(saveResponse.status, 403);
  assert.deepEqual(await saveResponse.json(), {
    error: 'デスクトップ版ではキャラクター説明の編集は無効です。ブラウザ実行で編集してください。',
    error_code: 'character_authoring_disabled',
    reason: 'desktop_runtime_read_only'
  });

  const profile = await readJson(root, 'game_data/characters/character_001/profile.json');
  assert.notEqual(profile.prompt_description, 'desktop should not write');
  assert.notEqual(profile.speaking_basis, 'desktop should not write');
});

test('default startup serves title-active initial HTML while ?initialScreen=debug returns the academy-map tab-bar layout', async (t) => {
  const { base } = await withServer(t);

  // Default startup (no initialScreen query) is the title screen. The server rewrites the static academy-map-active
  // HTML to title-active so the debug topbar is never painted before app.js runs (flash-free).
  const defaultResponse = await fetch(`${base}/`);
  assert.equal(defaultResponse.status, 200);
  const defaultHtml = await defaultResponse.text();
  assert.match(defaultHtml, /<body class="title-screen-active">/, 'default startup should mark the body for title full-screen CSS before app.js runs (flash-free topbar)');
  assert.match(defaultHtml, /id="title-screen" class="screen title-hero-screen active"/, 'default startup should make the title screen active in the returned HTML');
  assert.doesNotMatch(defaultHtml, /id="academy-map-screen" class="screen active"/, 'default startup must not return academy map as the active initial screen');
  assert.match(defaultHtml, /<button data-screen="title" class="active">タイトル<\/button>/, 'default startup should make the title debug tab active');
  assert.match(defaultHtml, /<button data-screen="academy-map">学院マップ<\/button>/, 'default startup should remove the academy-map tab active marker');

  // ?initialScreen=debug is the opt-in debug tab-bar startup: the static academy-map-active layout, served unchanged.
  const debugResponse = await fetch(`${base}/?initialScreen=debug`);
  assert.equal(debugResponse.status, 200);
  const debugHtml = await debugResponse.text();
  assert.doesNotMatch(debugHtml, /<body class="title-screen-active">/, 'the debug startup should not mark the body as title-active');
  assert.match(debugHtml, /id="academy-map-screen" class="screen active"/, 'the debug startup should keep academy-map as the static initial screen');
  assert.match(debugHtml, /id="title-screen" class="screen title-hero-screen"/, 'the debug startup should keep title available but inactive in static HTML');
  assert.match(debugHtml, /<button data-screen="academy-map" class="active">学院マップ<\/button>/, 'the debug startup should keep the academy-map debug tab active');

  // A dev-only screen entry is served unchanged (academy-map-active); the front-end switches to the actual screen.
  const devEntryResponse = await fetch(`${base}/?initialScreen=academy-arena`);
  assert.equal(devEntryResponse.status, 200);
  const devEntryHtml = await devEntryResponse.text();
  assert.match(devEntryHtml, /id="academy-map-screen" class="screen active"/, 'a dev-entry initialScreen value should serve the academy-map-active static HTML for the front-end to switch from');

  // The 談話室 dev entry is served the same way (the front-end applyInitialScreenOverride switches to academy-lounge).
  const loungeEntryResponse = await fetch(`${base}/?initialScreen=academy-lounge`);
  assert.equal(loungeEntryResponse.status, 200, 'the lounge dev entry is a known DEBUG_INITIAL_SCREENS value, not a 400');
  const loungeEntryHtml = await loungeEntryResponse.text();
  assert.match(loungeEntryHtml, /id="academy-map-screen" class="screen active"/, 'the lounge dev entry serves the academy-map-active static HTML for the front-end to switch from');

  // An unknown initialScreen value is a hard error, not a silent fall-through to the default title startup. The
  // former explicit title override is gone, so its value is just one such unknown, rejected the same way.
  const unknownResponse = await fetch(`${base}/?initialScreen=foo`);
  assert.equal(unknownResponse.status, 400, 'an unknown initialScreen value should fail fast with 400, not silently default');
});

test('settings screen exposes LM Studio thinking effort selector with None as the disabling choice', async (t) => {
  const { base } = await withServer(t);

  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<select id="lmstudio-thinking-effort">/);
  assert.match(html, /<option value="none">None<\/option>/);
  assert.match(html, /<option value="low">Low<\/option>/);
  assert.match(html, /<option value="medium">Medium<\/option>/);
  assert.match(html, /<option value="high">High<\/option>/);
  assert.match(html, /None を選ぶと、LM Studio へのリクエストでシンキングを無効化します。/);

  const appJs = await fetch(`${base}/app.js`).then((jsResponse) => jsResponse.text());
  assert.match(appJs, /lmstudio-thinking-effort/);
  assert.match(appJs, /thinking_effort/);
  assert.match(appJs, /value\s*===\s*['"]none['"]/);
});

test('root public shell serves from app/public while generated compatibility assets resolve from canonical roots', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-public-root-'));
  const publicRoot = path.join(root, 'public');
  const canonicalAssetsRoot = path.join(root, 'canonical_assets');
  await fs.mkdir(path.join(publicRoot), { recursive: true });
  await fs.mkdir(path.join(canonicalAssetsRoot, 'title'), { recursive: true });
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="app">stable root shell</div><script type="module" src="/app.js"></script></body></html>');
  await fs.writeFile(path.join(publicRoot, 'app.js'), 'console.log("root shell");');
  await fs.writeFile(path.join(publicRoot, 'style.css'), 'body { color: rgb(1, 2, 3); }');
  await fs.writeFile(path.join(canonicalAssetsRoot, 'title', 'title.jpg'), 'canonical-title');

  const server = createServer(await isolatedServerOptions(t, { root, publicRoot, canonicalAssetsRoot }, 'magic-adv-public-root-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  // This fixture verifies publicRoot resolution + generated-asset compatibility, not the initialScreen contract,
  // so it serves the raw shell via the debug passthrough (?initialScreen=debug returns index.html unchanged). The
  // default GET / title-active rewrite is covered against the real production shell by the initialScreen test above.
  const html = await fetch(`${base}/?initialScreen=debug`).then((response) => response.text());
  assert.match(html, /stable root shell/);

  const assetResponse = await fetch(`${base}/generated/title/title.jpg`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get('content-type'), 'image/jpeg');
  assert.equal(await assetResponse.text(), 'canonical-title');
});

test('retired legacy asset routes are absent from the live server surface', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-retired-asset-routes-'));
  const publicRoot = path.join(root, 'public');
  const localSourceAssetsRoot = path.join(root, 'source_assets');
  const localSourceSheetAssetsRoot = path.join(root, 'source_sheet_assets');
  const localV5AssetsRoot = path.join(root, 'v5_assets');
  const localV5AdditionalAssetsRoot = path.join(root, 'v5_additional_assets');
  await fs.mkdir(publicRoot, { recursive: true });
  await fs.mkdir(path.join(localSourceAssetsRoot, 'ui'), { recursive: true });
  await fs.mkdir(path.join(localSourceSheetAssetsRoot, 'source_images'), { recursive: true });
  await fs.mkdir(path.join(localV5AssetsRoot, 'character_visual_sets', 'visual_set_001', 'face_emotions'), { recursive: true });
  await fs.mkdir(localV5AdditionalAssetsRoot, { recursive: true });
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  await fs.writeFile(path.join(localSourceAssetsRoot, 'ui', 'dialogue_box.png'), 'legacy-source');
  await fs.writeFile(path.join(localSourceSheetAssetsRoot, 'source_images', 'character_source_sheet_chromakey.png'), 'legacy-sheet');
  await fs.writeFile(path.join(localV5AssetsRoot, 'character_visual_sets', 'visual_set_001', 'face_emotions', 'neutral.png'), 'legacy-v5');
  await fs.writeFile(path.join(localV5AdditionalAssetsRoot, 'misc.txt'), 'legacy-v5-additional');

  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot
  }, 'magic-adv-retired-assets-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  for (const pathname of [
    '/source-assets/ui/dialogue_box.png',
    '/source-sheet-assets/source_images/character_source_sheet_chromakey.png',
    '/source-sheet-crops/character_001.svg?view=face&expression=neutral',
    '/v5-assets/character_visual_sets/visual_set_001/face_emotions/neutral.png',
    '/v5-additional-assets/misc.txt'
  ]) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 404, `${pathname} should be retired from the live runtime surface`);
  }
});

test('retired character composite endpoints are absent from the live server surface', async (t) => {
  const { base } = await withServer(t);

  const recipeResponse = await fetch(`${base}/api/character-composite?character_id=lina`);
  assert.equal(recipeResponse.status, 404);

  const svgResponse = await fetch(`${base}/composites/lina.svg`);
  assert.equal(svgResponse.status, 404);
});

test('/canonical serves canonical-backed live image classes for character and non-character runtime assets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-canonical-route-'));
  const publicRoot = path.join(root, 'public');
  const canonicalAssetsRoot = path.join(root, 'canonical_assets');
  await fs.mkdir(publicRoot, { recursive: true });
  await fs.mkdir(path.join(canonicalAssetsRoot, 'character_visual_sets', 'visual_set_001', 'scene_standee'), { recursive: true });
  await fs.mkdir(path.join(canonicalAssetsRoot, 'character_visual_sets', 'visual_set_001', 'face_emotions'), { recursive: true });
  await fs.mkdir(path.join(canonicalAssetsRoot, 'backgrounds'), { recursive: true });
  await fs.mkdir(path.join(canonicalAssetsRoot, 'title'), { recursive: true });
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  await fs.writeFile(path.join(canonicalAssetsRoot, 'character_visual_sets', 'visual_set_001', 'scene_standee', 'scene_standee_character_05.jpg'), 'canonical-standee');
  await fs.writeFile(path.join(canonicalAssetsRoot, 'character_visual_sets', 'visual_set_001', 'face_emotions', 'neutral.jpg'), 'canonical-face');
  await fs.writeFile(path.join(canonicalAssetsRoot, 'backgrounds', 'background_001.jpg'), 'canonical-background');
  await fs.writeFile(path.join(canonicalAssetsRoot, 'title', 'title.jpg'), 'canonical-title');

  const server = createServer(await isolatedServerOptions(t, { root, publicRoot, canonicalAssetsRoot }, 'magic-adv-canonical-route-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const standeeResponse = await fetch(`${base}/canonical/character_visual_sets/visual_set_001/scene_standee/scene_standee_character_05.jpg`);
  const faceResponse = await fetch(`${base}/canonical/character_visual_sets/visual_set_001/face_emotions/neutral.jpg`);
  const backgroundResponse = await fetch(`${base}/canonical/backgrounds/background_001.jpg`);
  const titleResponse = await fetch(`${base}/canonical/title/title.jpg`);

  assert.equal(standeeResponse.headers.get('content-type'), 'image/jpeg');
  assert.equal(faceResponse.headers.get('content-type'), 'image/jpeg');
  assert.equal(backgroundResponse.headers.get('content-type'), 'image/jpeg');
  assert.equal(titleResponse.headers.get('content-type'), 'image/jpeg');
  assert.equal(await standeeResponse.text(), 'canonical-standee');
  assert.equal(await faceResponse.text(), 'canonical-face');
  assert.equal(await backgroundResponse.text(), 'canonical-background');
  assert.equal(await titleResponse.text(), 'canonical-title');
});

test('/canonical serves bundled Ogg Opus BGM tracks with the audio/ogg content type', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-canonical-bgm-'));
  const publicRoot = path.join(root, 'public');
  const canonicalAssetsRoot = path.join(root, 'canonical_assets');
  await fs.mkdir(publicRoot, { recursive: true });
  await fs.mkdir(path.join(canonicalAssetsRoot, 'bgm'), { recursive: true });
  await fs.writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  // Content bytes are irrelevant to the MIME contract; the extension selects audio/ogg.
  await fs.writeFile(path.join(canonicalAssetsRoot, 'bgm', 'v1-moonlit.ogg'), 'OggS-canonical-bgm');

  const server = createServer(await isolatedServerOptions(t, { root, publicRoot, canonicalAssetsRoot }, 'magic-adv-canonical-bgm-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const bgmResponse = await fetch(`${base}/canonical/bgm/v1-moonlit.ogg`);
  assert.equal(bgmResponse.status, 200);
  assert.equal(bgmResponse.headers.get('content-type'), 'audio/ogg');
  assert.equal(await bgmResponse.text(), 'OggS-canonical-bgm');
});

test('new game creates an isolated routing slot-owned play area with empty character state, 25-point player parameters, and the routing opening event', async (t) => {
  const { root, base } = await withServer(t);
  await fs.writeFile(path.join(root, 'game_data/runtime/player_parameters.json'), JSON.stringify({
    magic: { light: { value: 88 } },
    abilities: { strength: { value: 77 } }
  }, null, 2));
  await fs.mkdir(path.join(root, 'game_data/characters/lina/memory'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/characters/lina/memory/old.md'), 'balance memory should stay outside play area');

  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  assert.equal(started.area, 'play');
  assert.match(started.slot.slot_id, /^slot_\d{3}$/);
  assert.equal(started.state.current_screen, 'academy-map');
  assert.deepEqual(Object.keys(started.state.global_flags), ['event.routing_opening_intro.ready']);
  assert.equal(started.state.global_flags['event.routing_opening_intro.ready'], true);
  assert.deepEqual(started.state.characters, {});
  const openingSource = started.state.event_flag_sources['event.routing_opening_intro.ready'];
  assert.equal(typeof openingSource.character_id, 'string');
  assert.equal(openingSource.source_type, 'new_game');

  const activeSlot = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/active_slot.json'), 'utf8'));
  assert.equal(activeSlot.slot_id, started.slot.slot_id);

  const playState = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/slots', started.slot.slot_id, 'game_data/runtime_state.json'), 'utf8'));
  assert.equal(playState.current_screen, 'academy-map');
  assert.equal(playState.global_flags['event.routing_opening_intro.ready'], true);
  assert.deepEqual(playState.event_flag_sources['event.routing_opening_intro.ready'], openingSource);
  assert.deepEqual(playState.characters, {});
  const playParameters = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/slots', started.slot.slot_id, 'game_data/runtime/player_parameters.json'), 'utf8'));
  for (const definition of [...magicParameterDefinitions, ...abilityParameterDefinitions]) {
    const group = magicParameterDefinitions.some((item) => item.key === definition.key) ? 'magic' : 'abilities';
    assert.equal(playParameters[group][definition.key].value, 25, `${definition.key} should start at 25`);
  }
  const playLinaFlags = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/slots', started.slot.slot_id, 'game_data/characters/lina/flags.json'), 'utf8'));
  assert.deepEqual(playLinaFlags, { character_id: 'lina', flags: {} });
  const playLinaMemoryEntries = await fs.readdir(path.join(root, 'game_data/play/slots', started.slot.slot_id, 'game_data/characters/lina/memory'));
  assert.deepEqual(playLinaMemoryEntries, []);

  const balanceParameters = JSON.parse(await fs.readFile(path.join(root, 'game_data/runtime/player_parameters.json'), 'utf8'));
  assert.equal(balanceParameters.magic.light.value, 88, 'balance-tuning runtime parameters should not be overwritten');
  assert.equal(await fs.readFile(path.join(root, 'game_data/characters/lina/memory/old.md'), 'utf8'), 'balance memory should stay outside play area');

  const world = await jsonFetch(`${base}/api/world`);
  assert.equal(world.player_parameters.magic.light.value, 25, 'subsequent runtime APIs should read the play area after new game starts');
  const state = await jsonFetch(`${base}/api/state`);
  assert.equal(state.current_screen, 'academy-map');

  // The routing opening event is the seeded opening for a (now always-routing) new game; it is the routing
  // persona's hub greeting anchored at the routing hub. Its hub-start injection / consumption flow is covered
  // by the dedicated routing-opening test.
  const eventStatus = await jsonFetch(`${base}/api/event-flags`);
  const openingEvent = eventStatus.pending_events.find((event) => event.id === 'event.routing_opening_intro.ready');
  // The event-flags status list returns the raw authored label; the {{persona_name}} token is resolved to the
  // active variant's display name only when the label is injected into the conversation prompt (event_label
  // interpolation), not on this status surface.
  assert.equal(openingEvent.label, 'ルーティング開始の{{persona_name}}の迎え');
  assert.equal(openingEvent.character_id, openingSource.character_id);
  assert.equal(openingEvent.interaction.location_id, 'routing_hub');
});

test('authoring save endpoints persist canonical game_data while mirroring into active play for immediate preview', async (t) => {
  const { root, base } = await withPrivateAuthoringServer(t);
  await jsonFetch(`${base}/api/characters`);
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });

  const worldDescription = '保存ボタンはプレイコピーではなく、編集元のワールド設定へ残す。';
  const savedWorld = await jsonFetch(`${base}/api/world`, {
    method: 'POST',
    body: {
      player_name: '調整者',
      world_description: worldDescription,
      player_parameters: {
        magic: { light: 61, dark: 12, fire: 13, water: 14, earth: 15, wind: 16 },
        abilities: { strength: 21, agility: 22, academics: 23, magical_power: 24, charisma: 25 }
      }
    }
  });
  assert.equal(savedWorld.world_description, worldDescription);

  const canonicalWorld = JSON.parse(await fs.readFile(path.join(root, 'game_data/world/settings.json'), 'utf8'));
  const activeWorld = await jsonFetch(`${base}/api/world`);
  assert.equal(canonicalWorld.world_description, worldDescription, 'world save should persist the canonical authoring file');
  assert.equal(activeWorld.world_description_base, worldDescription, 'active play should read the updated world description immediately after authoring save');
  const canonicalParameters = JSON.parse(await fs.readFile(path.join(root, 'game_data/runtime/player_parameters.json'), 'utf8'));
  assert.equal(canonicalParameters.magic.light.value, 61);
  assert.equal(activeWorld.player_parameters.magic.light.value, 61, 'active play should read updated player parameters immediately after authoring save');

  await jsonFetch(`${base}/api/characters`);
  const editedPrompt = 'フィールド保存ボタンはキャラ説明を編集元profileへ残す。';
  const editedSpeaking = '調整用の話し方も編集元profileへ残す。';
  await jsonFetch(`${base}/api/characters/profile`, {
    method: 'POST',
    body: { character_id: 'character_020', prompt_description: editedPrompt, speaking_basis: editedSpeaking }
  });
  const canonicalProfile = JSON.parse(await fs.readFile(path.join(root, 'game_data/characters/character_020/profile.json'), 'utf8'));
  assert.equal(canonicalProfile.prompt_description, editedPrompt, 'character save should persist the canonical authoring profile');
  assert.equal(canonicalProfile.speaking_basis, editedSpeaking);

  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'character_020', source_type: 'field' }
  });
  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=character_020&player_input=${encodeURIComponent('確認')}`);
  assert.match(preview.prompt, new RegExp(worldDescription));
  assert.match(preview.prompt, new RegExp(editedPrompt));
});

test('desktop-config world settings mode persists /api/world edits under app/config instead of canonical definitions', async (t) => {
  const { root, base } = await withServer(t, { worldSettingsWriteTarget: 'config' });
  const original = await jsonFetch(`${base}/api/world`);
  const marker = 'desktop-config-write-marker';
  const updated = await jsonFetch(`${base}/api/world`, {
    method: 'POST',
    body: {
      player_name: original.player_name,
      world_description: `${original.world_description}\n${marker}`,
      player_parameters: original.player_parameters
    }
  });
  assert.match(updated.world_description, new RegExp(marker));
  const configWorld = JSON.parse(await fs.readFile(path.join(root, 'app/config/world/settings.json'), 'utf8'));
  const canonicalWorld = JSON.parse(await fs.readFile(path.join(root, 'game_data/world/settings.json'), 'utf8'));
  assert.match(configWorld.world_description, new RegExp(marker), 'desktop mode should persist writable settings under app/config');
  assert.doesNotMatch(canonicalWorld.world_description, new RegExp(marker), 'desktop mode should not mutate canonical definitions');
});

test('server API tests use an explicit baseline runtime location instead of copied live state', async (t) => {
  const { base } = await withServer(t);
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const field = await jsonFetch(`${base}/api/field`);
  assert.equal(field.state.current_location_id, 'herbology_garden');
  assert.equal(field.state.current_screen, 'academy-map');
  assert.deepEqual(field.state.visited_locations, ['herbology_garden']);
});

test('resolveAcademyConversationLandingScreen is fixed to the daytime screen and no longer reads the academy_conversation_screen setting', async (t) => {
  // The store still holds 'legacy' (its GET/PATCH contract is unchanged), but backend landing resolution is
  // fixed to the daytime screen: routing is official and a new conversation never lands on the legacy screen.
  const conversationPopupSettingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'conv-popup-landing-')), 'conversation-popup.json');
  await fs.writeFile(conversationPopupSettingsPath, `${JSON.stringify({ cooldown_ms: 500, animation_ms: 220, academy_conversation_screen: 'legacy' }, null, 2)}\n`, 'utf8');
  assert.equal(resolveAcademyConversationLandingScreen({ conversationPopupSettingsPath }), 'conversation-day');
  assert.equal(resolveAcademyConversationLandingScreen(), 'conversation-day');
});

test('conversation popup settings API is a cooldown_ms-only contract: 500ms default, drops removed keys on read, and fail-fasts on invalid values', async (t) => {
  const conversationPopupSettingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'conv-popup-settings-')), 'conversation-popup.json');
  const { root, base } = await withServer(t, { conversationPopupSettingsPath });

  const initial = await jsonFetch(`${base}/api/settings/conversation-popup`);
  assert.deepEqual(initial, { cooldown_ms: 500 }, 'missing settings should default to the 500ms standard cooldown (no other keys)');

  const updated = await jsonFetch(`${base}/api/settings/conversation-popup`, {
    method: 'PATCH',
    body: { cooldown_ms: 300 }
  });
  assert.deepEqual(updated, { cooldown_ms: 300 }, 'PATCH should echo back only the saved cooldown');

  const reread = await jsonFetch(`${base}/api/settings/conversation-popup`);
  assert.deepEqual(reread, { cooldown_ms: 300 }, 'saved cooldown should persist across requests');

  const fasterThanStandard = await jsonFetch(`${base}/api/settings/conversation-popup`, {
    method: 'PATCH',
    body: { cooldown_ms: 120 }
  });
  assert.equal(fasterThanStandard.cooldown_ms, 120, 'a cooldown shorter than the 500ms standard must be allowed (no hard lower bound)');

  // The removed keys are ignored on PATCH (only cooldown_ms is read from the body) and never echoed / stored.
  const withRemovedKeys = await jsonFetch(`${base}/api/settings/conversation-popup`, {
    method: 'PATCH',
    body: { cooldown_ms: 500, animation_ms: 120, academy_conversation_screen: 'legacy' }
  });
  assert.deepEqual(withRemovedKeys, { cooldown_ms: 500 }, 'removed keys in the PATCH body are ignored; only cooldown_ms is saved');

  for (const badBody of [
    { cooldown_ms: -1 },
    { cooldown_ms: 500.5 },
    { cooldown_ms: 'fast' },
    { cooldown_ms: 250 },
    // A missing cooldown_ms (Number(undefined) = NaN) is not a preset and fails fast.
    { animation_ms: 220 },
    {}
  ]) {
    const response = await fetch(`${base}/api/settings/conversation-popup`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(badBody)
    });
    assert.equal(response.status, 400, `invalid popup settings ${JSON.stringify(badBody)} should fail fast with 400`);
  }

  // The last valid saved cooldown is still intact after the rejected updates (not overwritten).
  const afterRejects = await jsonFetch(`${base}/api/settings/conversation-popup`);
  assert.equal(afterRejects.cooldown_ms, 500, 'rejected updates must not overwrite the last valid saved cooldown');

  // A settings file written before the shape narrowed still carries the removed animation_ms /
  // academy_conversation_screen keys; they are dropped on read and the file loads cleanly as the cooldown-only
  // shape (the shape is defined by what normalize returns, not by what the file holds).
  await fs.writeFile(conversationPopupSettingsPath, `${JSON.stringify({ cooldown_ms: 300, animation_ms: 120, academy_conversation_screen: 'legacy' }, null, 2)}\n`, 'utf8');
  const migrated = await jsonFetch(`${base}/api/settings/conversation-popup`);
  assert.deepEqual(migrated, { cooldown_ms: 300 }, 'a pre-narrowing settings file drops the removed keys and reads as the cooldown-only shape');

  // A present-but-invalid cooldown_ms in the stored file is corrupt state: it is not silently repaired; the
  // read fails fast as a corrupt store (500).
  await fs.writeFile(conversationPopupSettingsPath, `${JSON.stringify({ cooldown_ms: 250 }, null, 2)}\n`, 'utf8');
  const corruptRead = await fetch(`${base}/api/settings/conversation-popup`);
  assert.equal(corruptRead.status, 500, 'a stored settings file with an out-of-set cooldown must fail fast on read (corrupt store), not be silently defaulted');
  assert.ok(root);
});

test('play mode settings API defaults missing storage to loop and persists only closed-set modes', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'play-mode-settings-')), 'play-mode.json');
  const { base } = await withServer(t, { playModeSettingsPath: settingsPath });

  const initial = await jsonFetch(`${base}/api/settings/play-mode`);
  assert.deepEqual(initial, { mode: 'loop' }, 'missing play-mode.json should resolve to the explicit loop baseline');
  await assert.rejects(fs.stat(settingsPath), { code: 'ENOENT' }, 'GET should not materialize the missing settings file');

  const updated = await jsonFetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    body: { mode: 'routing', routing_persona_variant: 'fallen_star' }
  });
  assert.deepEqual(updated, { mode: 'routing', routing_persona_variant: 'fallen_star' }, 'PATCH should echo the saved routing mode and persona variant');
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { mode: 'routing', routing_persona_variant: 'fallen_star' }, 'PATCH should persist the sidecar JSON');

  const reread = await jsonFetch(`${base}/api/settings/play-mode`);
  assert.deepEqual(reread, { mode: 'routing', routing_persona_variant: 'fallen_star' }, 'saved routing mode should be returned on later GET');

  const invalidResponse = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'banana' })
  });
  assert.equal(invalidResponse.status, 400, 'unknown PATCH mode should fail fast with 400');
  const paddedResponse = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: ' routing ' })
  });
  assert.equal(paddedResponse.status, 400, 'padded PATCH mode should fail fast with 400');
  const missingVariantResponse = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'routing' })
  });
  assert.equal(missingVariantResponse.status, 400, 'routing PATCH without persona variant should fail fast with 400');
  const unknownVariantResponse = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'routing', routing_persona_variant: 'banana' })
  });
  assert.equal(unknownVariantResponse.status, 400, 'unknown routing persona variant should fail fast with 400');
  const afterReject = await jsonFetch(`${base}/api/settings/play-mode`);
  assert.deepEqual(afterReject, { mode: 'routing', routing_persona_variant: 'fallen_star' }, 'rejected PATCH must not overwrite the last valid mode');
});

test('a routing sidecar with an out-of-set persona variant stays bootable and is recoverable by re-selection', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'play-mode-settings-stale-')), 'play-mode.json');
  // Simulate an install that persisted a routing variant which a later closed-set replacement removed.
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'legacy_removed_variant' }, null, 2)}\n`, 'utf8');
  const { base } = await withServer(t, { playModeSettingsPath: settingsPath });

  // Boot + shell serving stay up.
  const shell = await fetch(`${base}/`);
  assert.equal(shell.status, 200, 'GET / must still serve the shell with a stale persisted variant');

  // The settings surface is reachable: the play-mode read carries the stale variant through as-is (no
  // 500, no silent default / alias / mapping), and a dispatched non-routing endpoint is not bricked.
  const staleRead = await jsonFetch(`${base}/api/settings/play-mode`);
  assert.deepEqual(staleRead, { mode: 'routing', routing_persona_variant: 'legacy_removed_variant' }, 'the stale variant is surfaced raw, not defaulted or mapped');
  const lmSettings = await fetch(`${base}/api/settings/lmstudio`);
  assert.equal(lmSettings.status, 200, 'dispatch must not 500 non-routing endpoints on a stale persisted variant');

  // Reading must not silently rewrite the stale sidecar.
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { mode: 'routing', routing_persona_variant: 'legacy_removed_variant' }, 'reading must not rewrite the stale sidecar');

  // Re-selecting a valid variant recovers routing (the write validates closed-set membership).
  const reselected = await jsonFetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    body: { mode: 'routing', routing_persona_variant: 'fallen_star' }
  });
  assert.deepEqual(reselected, { mode: 'routing', routing_persona_variant: 'fallen_star' }, 're-selection persists a valid variant');
  const recovered = await jsonFetch(`${base}/api/settings/play-mode`);
  assert.deepEqual(recovered, { mode: 'routing', routing_persona_variant: 'fallen_star' }, 'after re-selection the routing variant is valid again');
});

test('an existing routing save slot with an out-of-set persona variant is loadable and recovered by the save-side re-selection, leaving the global sidecar untouched', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'play-mode-slot-recovery-')), 'play-mode.json');
  // The install-wide sidecar (new-game default) and the active save slot both carry a pre-replacement
  // variant (the real scenario for an existing player after a closed-set replacement). The global sidecar
  // holds a DISTINCT valid variant so the test can prove the save-side re-selection never touches it.
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'stardust_sweeper' }, null, 2)}\n`, 'utf8');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const metaRelPath = 'game_data/play/slots/slot_002/meta.json';
  const staleMeta = {
    slot_id: 'slot_002',
    label: 'slot 002',
    created_at: '2026-05-05T06:10:00.000+09:00',
    updated_at: '2026-05-05T06:10:00.000+09:00',
    player_note: '',
    current_location_id: 'herbology_garden',
    current_screen: 'academy-map',
    graduation_completed: false,
    play_mode: 'routing',
    routing_persona_variant: 'legacy_removed_variant'
  };
  await writeJson(root, 'game_data/play/active_slot.json', { slot_id: 'slot_002' });
  await writeJson(root, metaRelPath, staleMeta);
  await writeJson(root, 'game_data/play/slots/slot_002/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-map',
    ending_completed: false
  });

  // Boot + shell serve with a stale active routing slot.
  assert.equal((await fetch(`${base}/`)).status, 200, 'GET / must serve the shell with a stale active routing slot');

  // The slot list surfaces the stale slot raw (read-tolerant) and pure reads never rewrite the meta.
  const listed = await jsonFetch(`${base}/api/slots`);
  const staleSummary = listed.slots.find((slot) => slot.slot_id === 'slot_002');
  assert.ok(staleSummary, 'the stale slot is listed');
  assert.equal(staleSummary.routing_persona_variant, 'legacy_removed_variant', 'the stale variant is surfaced raw, not mapped/defaulted');
  assert.deepEqual(await readJson(root, metaRelPath), staleMeta, 'listing must not rewrite the slot meta');

  // The stale slot loads (read-tolerant) instead of 400-ing.
  const loaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: 'slot_002' } });
  assert.ok(loaded?.slot, 'the stale slot loads');

  // Re-selecting in the SAVE-SIDE operation updates the active routing slot's meta (recovery) — and only
  // that slot: the global sidecar (new-game default) is untouched.
  const reselected = await jsonFetch(`${base}/api/slots/active/routing-persona`, {
    method: 'PATCH',
    body: { routing_persona_variant: 'fallen_star' }
  });
  assert.equal(reselected.slot_id, 'slot_002');
  assert.equal(reselected.routing_persona_variant, 'fallen_star', 'the save-side op echoes the re-selected variant');
  const recoveredMeta = await readJson(root, metaRelPath);
  assert.equal(recoveredMeta.routing_persona_variant, 'fallen_star', 'the active routing slot is recovered');
  assert.equal(recoveredMeta.play_mode, 'routing', 'the slot stays routing');
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { mode: 'routing', routing_persona_variant: 'stardust_sweeper' }, 'the save-side re-selection must NOT touch the global sidecar (new-game default)');

  // Reads after recovery still do not rewrite the (now recovered) meta or the sidecar.
  const metaAfterRecovery = await readJson(root, metaRelPath);
  await jsonFetch(`${base}/api/slots`);
  await jsonFetch(`${base}/api/settings/play-mode`);
  assert.deepEqual(await readJson(root, metaRelPath), metaAfterRecovery, 'pure reads after recovery must not rewrite the slot meta');
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { mode: 'routing', routing_persona_variant: 'stardust_sweeper' }, 'pure reads must not rewrite the global sidecar');
});

test('play mode settings API fails fast on corrupt JSON and unknown stored modes', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'play-mode-settings-corrupt-')), 'play-mode.json');
  const { base } = await withServer(t, { playModeSettingsPath: settingsPath });

  await fs.writeFile(settingsPath, '{not-json', 'utf8');
  const corruptResponse = await fetch(`${base}/api/settings/play-mode`);
  assert.equal(corruptResponse.status, 500, 'corrupt play-mode.json should fail fast');
  assert.match(await corruptResponse.text(), /corrupt/i);

  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'banana' })}\n`, 'utf8');
  const unknownResponse = await fetch(`${base}/api/settings/play-mode`);
  assert.equal(unknownResponse.status, 500, 'unknown stored mode should fail fast instead of falling back to loop');
  assert.match(await unknownResponse.text(), /mode/i);

  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing' })}\n`, 'utf8');
  const missingVariantResponse = await fetch(`${base}/api/settings/play-mode`);
  assert.equal(missingVariantResponse.status, 500, 'routing stored mode without persona variant should fail fast');
  assert.match(await missingVariantResponse.text(), /routing persona variant/i);

  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop ' })}\n`, 'utf8');
  const paddedResponse = await fetch(`${base}/api/settings/play-mode`);
  assert.equal(paddedResponse.status, 500, 'padded stored mode should fail fast instead of normalizing');
  assert.match(await paddedResponse.text(), /mode/i);
});

test('play mode settings API reports persistence failures as server errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'play-mode-settings-unwritable-'));
  const blockedParent = path.join(root, 'not-a-directory');
  await fs.writeFile(blockedParent, 'blocks mkdir', 'utf8');
  const { base } = await withServer(t, { playModeSettingsPath: path.join(blockedParent, 'play-mode.json') });

  const response = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' })
  });
  assert.equal(response.status, 500, 'filesystem persistence failures should fail as server errors, not client validation errors');
  assert.match(await response.text(), /not-a-directory|ENOTDIR|EEXIST/i);
});

test('routing mode start load and resume APIs expose resolved mode screens without pending queue shape drift', async (t) => {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-mode-entry-screens-'));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });

  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  // A new game is always routing with a uniformly-random persona variant (not the sidecar's); the slot then
  // persists exactly that variant, and load/resume expose it unchanged.
  assert.equal(started.active_play_mode.mode, 'routing');
  const variant = started.active_play_mode.routing_persona_variant;
  assert.ok(ROUTING_PERSONA_VARIANTS.includes(variant), 'new game picks a variant from the closed set');
  assert.equal(started.post_content_screen, 'interaction');
  assert.equal(started.state.current_screen, 'academy-map', 'backend start exposes routing material without opening the hub conversation itself');
  assert.equal(Object.hasOwn(started.state, 'pending_finalizations'), false);

  const slotId = started.slot.slot_id;
  assert.equal((await readJson(root, `game_data/play/slots/${slotId}/meta.json`)).play_mode, 'routing');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');

  const resume = await jsonFetch(`${base}/api/slots`);
  assert.equal(resume.active_slot_id, slotId);
  assert.deepEqual(resume.active_play_mode, { mode: 'routing', routing_persona_variant: variant });
  assert.equal(resume.post_content_screen, 'interaction');
  assert.equal(resume.slots.find((slot) => slot.slot_id === slotId)?.play_mode, 'routing');

  const absentLoaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.deepEqual(absentLoaded.active_play_mode, { mode: 'routing', routing_persona_variant: variant });
  assert.equal(absentLoaded.post_content_screen, 'interaction');
  assert.equal(absentLoaded.state.current_screen, 'interaction');
  assert.equal(Object.hasOwn(absentLoaded.state, 'pending_finalizations'), false, 'routing load must not materialize an absent pending queue');

  const slotStatePath = path.join(root, 'game_data/play/slots', slotId, 'game_data/runtime_state.json');
  const pendingFinalizations = [{
    conversation_id: 'conv_api_pending_001',
    character_id: 'lina',
    enqueued_at: '2026-05-05T06:11:00.000+09:00',
    status: 'pending',
    attempts: 0
  }];
  const stateWithQueue = JSON.parse(await fs.readFile(slotStatePath, 'utf8'));
  await fs.writeFile(slotStatePath, `${JSON.stringify({
    ...stateWithQueue,
    current_screen: 'academy-room',
    pending_finalizations: pendingFinalizations
  }, null, 2)}\n`, 'utf8');

  const presentLoaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.equal(presentLoaded.state.current_screen, 'interaction');
  assert.deepEqual(presentLoaded.state.pending_finalizations, pendingFinalizations, 'routing load must preserve an existing pending queue');
  assert.deepEqual(JSON.parse(await fs.readFile(slotStatePath, 'utf8')).pending_finalizations, pendingFinalizations);
});

test('routing slot load starts hub from slot mode when global settings changed to loop', async (t) => {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-slot-load-global-loop-'));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const lm = await withRoutingLmStub(t);
  const { base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });

  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotId = started.slot.slot_id;
  const variant = started.active_play_mode.routing_persona_variant;
  assert.ok(ROUTING_PERSONA_VARIANTS.includes(variant), 'new game picks a variant from the closed set');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');

  const loaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.deepEqual(loaded.active_play_mode, { mode: 'routing', routing_persona_variant: variant });
  assert.equal(loaded.post_content_screen, 'interaction');

  const hub = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_slot_load_global_loop_001' }
  });
  assert.equal(hub.conversation.id, 'conv_slot_load_global_loop_001');
  assert.equal(hub.conversation.routing_hub.persona_variant, variant);
  assert.equal(lm.requests.length > 0, true, 'hub start should reach the normal LM-backed opening path');
});

test('loop slot load keeps loop routing when global play mode changes to routing', async (t) => {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-slot-entry-screens-'));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  // The global sidecar is routing throughout — new games are always routing now, so a retained loop save is
  // created directly through the loop code path (initializeNewPlayArea). The point is that this loop slot
  // still loads/resumes as loop regardless of the routing global setting.
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });

  const { slot } = await initializeNewPlayArea({ root, playMode: 'loop' });
  const slotId = slot.slot_id;
  assert.equal((await readJson(root, `game_data/play/slots/${slotId}/meta.json`)).play_mode, 'loop');

  const resume = await jsonFetch(`${base}/api/slots`);
  assert.deepEqual(resume.active_play_mode, { mode: 'loop' });
  assert.equal(resume.post_content_screen, 'academy-room');
  assert.equal(resume.slots.find((slot) => slot.slot_id === slotId)?.play_mode, 'loop');

  const loaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.deepEqual(loaded.active_play_mode, { mode: 'loop' });
  assert.equal(loaded.post_content_screen, 'academy-room');
  assert.equal(loaded.state.current_screen, 'academy-room');
});

test('slot APIs fail fast when slot play_mode is missing or invalid', async (t) => {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slot-mode-migration-required-'));
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'loop' }, null, 2)}\n`, 'utf8');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });

  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotId = started.slot.slot_id;
  const metaPath = path.join(root, 'game_data/play/slots', slotId, 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  delete meta.play_mode;
  // A routing new game persists a variant; drop it too so the later play_mode:'routing' case below exercises
  // the routing-without-variant fail-fast rather than a fully-valid routing meta.
  delete meta.routing_persona_variant;
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  for (const [label, response] of [
    ['list', await fetch(`${base}/api/slots`)],
    ['load', await fetch(`${base}/api/slots/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot_id: slotId })
    })]
  ]) {
    assert.equal(response.status, 400, `${label} should reject a slot with missing play_mode`);
    assert.match(await response.text(), /node scripts\/stamp-slot-play-mode\.mjs/);
  }

  await fs.writeFile(metaPath, `${JSON.stringify({ ...meta, play_mode: 'banana' }, null, 2)}\n`, 'utf8');
  for (const [label, response] of [
    ['list', await fetch(`${base}/api/slots`)],
    ['load', await fetch(`${base}/api/slots/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot_id: slotId })
    })]
  ]) {
    assert.equal(response.status, 400, `${label} should reject a slot with invalid play_mode`);
    assert.match(await response.text(), /node scripts\/stamp-slot-play-mode\.mjs/);
  }

  await fs.writeFile(metaPath, `${JSON.stringify({ ...meta, play_mode: 'routing' }, null, 2)}\n`, 'utf8');
  for (const [label, response] of [
    ['list', await fetch(`${base}/api/slots`)],
    ['load', await fetch(`${base}/api/slots/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot_id: slotId })
    })]
  ]) {
    assert.equal(response.status, 400, `${label} should reject a routing slot without routing_persona_variant`);
    assert.match(await response.text(), /node scripts\/stamp-slot-play-mode\.mjs/);
  }
});

test('routing hub start refuses loop mode before any LM gate or opening work', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-loop-mode-')), 'play-mode.json');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-loop-lm-')), 'missing-lmstudio.json');
  const { base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });

  const response = await fetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'mock' })
  });
  assert.equal(response.status, 409, 'missing play-mode.json resolves to loop and must not start the routing hub');
  assert.match(await response.text(), /routing mode/i);
});

test('routing hub start reports missing LM Studio config instead of downgrading routing to loop', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-missing-lm-mode-')), 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-missing-lm-config-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const beforeState = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', { ...beforeState, elapsed_weeks: 0 });

  const response = await fetch(`${base}/api/routing/hub/start`, { method: 'POST' });
  assert.equal(response.status, 503);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
  assert.match(body.error, /LM Studio/);
});

test('routing hub start fails fast when routing mode has no persona variant', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-missing-variant-')), 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing' }, null, 2)}\n`, 'utf8');
  const lm = await withRoutingLmStub(t);
  const { base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });

  const response = await fetch(`${base}/api/routing/hub/start`, { method: 'POST' });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /routing persona variant/i);
  assert.equal(lm.requests.length, 0, 'invalid routing settings must fail before LM requests');
});

test('routing hub start creates a routing opening with persona and meta context only', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-start-mode-')), 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'hourglass_grain' }, null, 2)}\n`, 'utf8');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const beforeState = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', { ...beforeState, elapsed_weeks: 0 });

  const started = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_hub_start_api_001', provider: 'mock' }
  });

  assert.equal(started.conversation.id, 'conv_routing_hub_start_api_001');
  assert.equal(started.conversation.character_id, 'lina');
  assert.equal(started.conversation.character_name, 'サラ・アワーグラス');
  assert.equal(started.conversation.routing_hub.persona_variant, 'hourglass_grain');
  assert.deepEqual(started.conversation.routing_hub.recent_conversation_context, {
    kind: 'no_new_conversation',
    conversation_id: null,
    character_id: null,
    character_name: null,
    memory_text: null
  });
  assert.deepEqual(started.conversation.routing_hub.relationship_context, { buddy: null, enemies: [] });
  assert.deepEqual(started.conversation.routing_hub.alchemy_context, {
    recipe_count: 56
  });
  assert.deepEqual(started.conversation.routing_hub.study_circle_context, {
    theme_count: trainingDefinitions.length,
    weekly_offer_count: 3
  });
  assert.equal(started.conversation.routing_hub.content_result_context, null);
  assert.deepEqual(started.conversation.messages, [{ role: 'assistant', content: '新しい週をここから始めましょう。' }]);
  assert.equal(started.state.current_screen, 'interaction');
  assert.equal(started.state.current_interaction_character_id, 'lina');
  assert.equal(started.state.last_conversation_id, 'conv_routing_hub_start_api_001');
  assert.equal(started.state.current_location_id, beforeState.current_location_id, 'hub opening should not dispatch or move location');
  assert.equal(Object.prototype.hasOwnProperty.call(started, 'transition'), false, 'Stage 3 does not dispatch or return a destination transition');

  // Non-selectable routing persona visual summary: the hub start response exposes ルミ's visual for the
  // session's effective variant (hourglass_grain here) so the frontend renders her own face / standee /
  // speaker icon instead of the roster head, and the set follows whichever variant is active.
  assert.deepEqual(started.routing_persona_visual, {
    character_id: 'lina',
    display_name: 'サラ・アワーグラス',
    visual_set_id: 'routing_lumi_hourglass_grain',
    face_url: '/canonical/character_visual_sets/routing_lumi_hourglass_grain/face_emotions/neutral.jpg',
    selection_icon_url: '/canonical/character_visual_sets/routing_lumi_hourglass_grain/face_emotions/neutral.jpg',
    standee_url: '/canonical/character_visual_sets/routing_lumi_hourglass_grain/scene_standee/scene_standee_character_01.jpg',
    available_expressions: ['neutral', 'joy', 'caring', 'confident', 'sadness', 'worried', 'anger', 'surprised', 'embarrassed', 'shy', 'serious', 'determined', 'panic', 'tired', 'sick', 'smug']
  }, 'the routing hub start response exposes the effective-variant visual summary (non-selectable actor)');

  assert.equal(lm.requests.length, 1, 'hub opening should make only the opening chat request');
  assert.equal(lm.requests[0].method, 'POST');
  assert.equal(lm.requests[0].url, '/v1/chat/completions');
  assert.equal(lm.requests[0].body.model, 'chat-model');
  assert.equal(lm.requests[0].body.stream, false, 'routing hub must use configured LM Studio instead of the mock provider body field');
  const prompt = lm.requests[0].body.messages[0].content;
  assert.match(prompt, /あなたはサラ・アワーグラスである。/);
  assert.match(prompt, /くびれに引っかかった一粒/);
  assert.match(prompt, /ルーティング会話メタ情報:/);
  assert.match(prompt, /このオープニングの文脈:/);
  assert.match(prompt, /ルーティングハブopening誘導:/);
  assert.match(prompt, /体調・気分・近況を伺う世間話/);
  assert.match(prompt, /行き先の確認・催促から入らない/);
  assert.match(prompt, /サラ・アワーグラスが覗ける新しい記憶はない/);
  assert.match(prompt, /現在の相棒: なし/);
  assert.match(prompt, /現在のライバル: なし/);
  assert.match(prompt, new RegExp(`${trainingDefinitions.length}種の鍛錬`));
  assert.match(prompt, new RegExp(`週${TRAINING_ACTION_LIMIT}回の行動`));
  assert.match(prompt, new RegExp(`最大${MAX_FLOORS}層`));
  assert.match(prompt, /学院マップ/);
  assert.match(prompt, /鍛錬/);
  assert.match(prompt, /ダンジョン/);
  assert.match(prompt, /数値範囲は0〜100/);
  assert.doesNotMatch(prompt, /薬草の観察/);
});

test('slot load and slots resume expose the in-flight graduation phase 2 re-entry contract and refuse hub start', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'graduation-phase2-reentry-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });

  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotId = started.slot.slot_id;
  // Pin the persona to ルミ (fallen_star) so the guide-persona visual assertions below are deterministic.
  await forceRoutingSlotPersonaVariant(root, slotId, 'fallen_star');
  const slotStatePath = path.join(root, 'game_data/play/slots', slotId, 'game_data/runtime_state.json');

  // A fresh routing slot is not mid-phase-2: the entry contract is null.
  const freshSlots = await jsonFetch(`${base}/api/slots`);
  assert.equal(freshSlots.graduation_phase2_reentry, null);

  // Seed an in-flight guide-persona (lina) phase 2 into the active slot's runtime_state.
  const baseState = JSON.parse(await fs.readFile(slotStatePath, 'utf8'));
  const linaPhase2 = {
    ...baseState,
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    last_conversation_id: 'conv_reentry_lina_001',
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: false,
    ending_character_id: 'lina',
    global_flags: { ...(baseState.global_flags ?? {}), 'event.graduation_ending.ready': true, 'event.graduation_ending.completed': false },
    pending_interaction_context: { source_type: 'event', event_flag_id: 'event.graduation_ending.ready', opening_context: '卒業の日。' }
  };
  await fs.writeFile(slotStatePath, `${JSON.stringify(linaPhase2, null, 2)}\n`, 'utf8');

  // GET /api/slots (the resume route source) exposes the re-entry contract with the persona visual for lina.
  const slots = await jsonFetch(`${base}/api/slots`);
  assert.equal(slots.graduation_phase2_reentry.character_id, 'lina');
  assert.equal(slots.graduation_phase2_reentry.screen, 'interaction');
  assert.equal(slots.graduation_phase2_reentry.last_conversation_id, 'conv_reentry_lina_001');
  assert.equal(slots.graduation_phase2_reentry.is_guide_persona, true);
  assert.equal(slots.graduation_phase2_reentry.routing_persona_visual.character_id, 'lina');
  assert.equal(slots.graduation_phase2_reentry.routing_persona_visual.display_name, 'ルミ');
  assert.equal(slots.graduation_phase2_reentry.routing_persona_visual.visual_set_id, 'routing_lumi_fallen_star');

  // Hub start is refused fail-fast while mid-phase-2 (dedicated error code), before any LM/opening work — so
  // the phase-2 context can never be overwritten by a hub greeting.
  const hubResponse = await fetch(`${base}/api/routing/hub/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'conv_reentry_hub_001' })
  });
  assert.equal(hubResponse.status, 409);
  assert.equal(JSON.parse(await hubResponse.text()).error_code, 'GRADUATION_PHASE2_IN_FLIGHT');

  // POST /api/slots/load preserves the conversation entry state and carries the same re-entry contract.
  const loaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.equal(loaded.state.current_interaction_character_id, 'lina');
  assert.equal(loaded.state.current_screen, 'interaction');
  assert.equal(loaded.state.last_conversation_id, 'conv_reentry_lina_001');
  assert.equal(loaded.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(loaded.graduation_phase2_reentry.is_guide_persona, true);
  assert.equal(loaded.graduation_phase2_reentry.routing_persona_visual.visual_set_id, 'routing_lumi_fallen_star');

  // A roster candidate phase 2 carries the contract WITHOUT a persona visual (it resolves through the roster).
  const candidatePhase2 = { ...linaPhase2, current_interaction_character_id: 'character_001', ending_character_id: 'character_001', last_conversation_id: null };
  await fs.writeFile(slotStatePath, `${JSON.stringify(candidatePhase2, null, 2)}\n`, 'utf8');
  const candidateSlots = await jsonFetch(`${base}/api/slots`);
  assert.equal(candidateSlots.graduation_phase2_reentry.character_id, 'character_001');
  assert.equal(candidateSlots.graduation_phase2_reentry.screen, 'interaction');
  assert.equal(candidateSlots.graduation_phase2_reentry.last_conversation_id, null);
  assert.equal(candidateSlots.graduation_phase2_reentry.is_guide_persona, false);
  assert.equal(Object.hasOwn(candidateSlots.graduation_phase2_reentry, 'routing_persona_visual'), false);
  const candidateLoaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.equal(candidateLoaded.state.current_interaction_character_id, 'character_001');
  assert.equal(candidateLoaded.graduation_phase2_reentry.is_guide_persona, false);
  assert.equal(Object.hasOwn(candidateLoaded.graduation_phase2_reentry, 'routing_persona_visual'), false);
});

test('loop slot exposes the in-flight graduation phase 2 re-entry contract without a persona visual', async (t) => {
  const { root, base } = await withServer(t);

  // A retained loop save (created via the loop code path; new games are always routing now).
  const { slot } = await initializeNewPlayArea({ root, playMode: 'loop' });
  const slotId = slot.slot_id;
  const slotStatePath = path.join(root, 'game_data/play/slots', slotId, 'game_data/runtime_state.json');

  const baseState = JSON.parse(await fs.readFile(slotStatePath, 'utf8'));
  const loopPhase2 = {
    ...baseState,
    current_screen: 'academy-conversation-session',
    current_interaction_character_id: 'character_002',
    last_conversation_id: 'conv_loop_reentry_001',
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: false,
    ending_character_id: 'character_002',
    global_flags: { ...(baseState.global_flags ?? {}), 'event.graduation_ending.ready': true, 'event.graduation_ending.completed': false },
    pending_interaction_context: { source_type: 'event', event_flag_id: 'event.graduation_ending.ready', opening_context: '卒業の日。' }
  };
  await fs.writeFile(slotStatePath, `${JSON.stringify(loopPhase2, null, 2)}\n`, 'utf8');

  // Loop keeps the legacy conversation session screen and never carries a persona visual; the loop load
  // landing (academy-room) is not applied while mid-phase-2.
  const loaded = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotId } });
  assert.deepEqual(loaded.active_play_mode, { mode: 'loop' });
  assert.equal(loaded.state.current_interaction_character_id, 'character_002');
  assert.equal(loaded.state.current_screen, 'academy-conversation-session');
  assert.equal(loaded.graduation_phase2_reentry.character_id, 'character_002');
  assert.equal(loaded.graduation_phase2_reentry.screen, 'academy-conversation-session');
  assert.equal(loaded.graduation_phase2_reentry.is_guide_persona, false);
  assert.equal(Object.hasOwn(loaded.graduation_phase2_reentry, 'routing_persona_visual'), false);
});

test('routing new game injects the opening event into the first hub greeting, then reverts to the normal greeting', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-opening-inject-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });

  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotId = started.slot.slot_id;
  // Pin the persona to ルミ (fallen_star) so the interpolated opening-event name is deterministic.
  await forceRoutingSlotPersonaVariant(root, slotId, 'fallen_star');
  const slotStatePath = path.join(root, 'game_data/play/slots', slotId, 'game_data/runtime_state.json');
  const seededState = JSON.parse(await fs.readFile(slotStatePath, 'utf8'));
  assert.equal(seededState.global_flags['event.routing_opening_intro.ready'], true, 'routing new game seeds the opening event');

  const firstHub = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_opening_inject_001' }
  });

  const firstPrompt = lm.requests[0].body.messages[0].content;
  assert.match(firstPrompt, /このイベントの文脈:/, 'the opening event context is injected into the first hub greeting');
  assert.match(firstPrompt, /月の文字盤の空間/, 'the injected context is the event definition opening_context');
  assert.match(firstPrompt, /必ずしも全ての項目を説明する必要はない。/, 'the injected context carries the new authored guidance');
  // The authored persona-name token is interpolated with the active variant's display name
  // (fallen_star=ルミ) in both the event label and the opening_context, and the raw token never leaks.
  assert.match(firstPrompt, /イベント: ルーティング開始のルミの迎え/, 'the opening event label names the active variant (interpolated)');
  assert.match(firstPrompt, /あなた（ルミ）は月の文字盤の空間/, 'the opening event context names the active variant (interpolated)');
  assert.doesNotMatch(firstPrompt, /\{\{persona_name\}\}/, 'the raw persona-name token is not leaked into the prompt');
  // The old brief-v1 phrasing (order-locked items, 「一緒に決める案内人」self-intro) is fully replaced.
  assert.doesNotMatch(firstPrompt, /週の始まりにここで、その週の行き先を一緒に決める案内人/, 'the old order-locked opening text is gone');
  assert.doesNotMatch(firstPrompt, /最初の一言は説明ではなく/, 'the old first-line item is gone');
  assert.equal(firstHub.state.pending_interaction_context.event_flag_id, 'event.routing_opening_intro.ready');
  assert.equal(
    firstHub.state.current_location_id,
    seededState.current_location_id,
    'the hub greeting opens on the routing meta-surface and must not move the runtime location'
  );

  const afterFirstHub = JSON.parse(await fs.readFile(slotStatePath, 'utf8'));
  assert.equal(afterFirstHub.global_flags['event.routing_opening_intro.completed'], true, 'complete_when_started consumes the event so it never retriggers');

  const secondHub = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_opening_inject_002' }
  });

  const secondPrompt = lm.requests[1].body.messages[0].content;
  assert.doesNotMatch(secondPrompt, /このイベントの文脈:/, 'later hub greetings carry no opening event context');
  assert.match(secondPrompt, /ルーティング会話メタ情報:/, 'later hub greetings are the normal persona + meta greeting');
  // The standing world-law meta facts (4 items) enter every hub conversation — the opening 迎え above and the
  // normal weekly greeting here alike — with the persona line resolved to the active variant (ルミ).
  assert.match(secondPrompt, /今会話しているこの場所は、その週の行き先を決めるための月の文字盤の空間/, 'the place world-law meta item is present');
  assert.match(secondPrompt, /ルミは主人公の一番新しい記憶だけを覗ける/, 'the memory-peek meta item names the active variant');
  assert.match(secondPrompt, /「ロード機能」は世界線を変える機能で、「セーブ機能」はない。/, 'the load-not-save world-law meta item is present');
  assert.match(secondPrompt, /会話の途中で不正に終了するとデータ破損・起動不能になる可能性がある/, 'the mid-conversation-abort warning meta item is present');
  assert.doesNotMatch(secondPrompt, /\{\{persona_name\}\}/, 'the normal greeting leaks no raw persona-name token');
  assert.equal(secondHub.state.pending_interaction_context, null, 'the normal greeting clears the pending interaction context, byte-equivalent to the pre-event path');
});

test('routing hub start fails fast when the opening event is seeded but its definition is missing', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-opening-missing-def-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });

  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });

  // Strip the opening event definition while leaving the seeded runtime flag in place. The hub must not
  // silently skip the opening — it must surface the missing/malformed definition.
  const definitionsPath = path.join(root, 'game_data/event_flags.json');
  const definitions = JSON.parse(await fs.readFile(definitionsPath, 'utf8'));
  definitions.flags = definitions.flags.filter((flag) => flag.id !== 'event.routing_opening_intro.ready');
  await fs.writeFile(definitionsPath, `${JSON.stringify(definitions, null, 2)}\n`, 'utf8');

  const response = await fetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'conv_routing_opening_missing_def_001' })
  });
  assert.equal(response.status, 500, 'a seeded opening event with no definition fails fast instead of silently skipping');
  assert.equal(lm.requests.length, 0, 'the failure happens before any opening chat request');
});

test('routing hub start captures recent conversation memory before startInteractionSession clears state', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-hub-recent-memory-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 2,
    last_conversation_id: 'conv_recent_memory_hub_start_001'
  });
  await writeJson(root, 'game_data/logs/conversations/conv_recent_memory_hub_start_001.json', {
    id: 'conv_recent_memory_hub_start_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    messages: []
  });
  await writeJson(root, 'game_data/logs/validator/conv_recent_memory_hub_start_001.json', {
    accepted_memory: [{ text: '主人公は星図の読み方を少し覚えた。' }]
  });

  const started = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_hub_recent_memory_001' }
  });

  assert.deepEqual(started.conversation.routing_hub.recent_conversation_context, {
    kind: 'conversation_memory',
    conversation_id: 'conv_recent_memory_hub_start_001',
    character_id: 'character_001',
    character_name: 'セラ・アストルーペ',
    memory_text: '主人公は星図の読み方を少し覚えた。'
  });
  assert.equal(started.state.last_conversation_id, 'conv_routing_hub_recent_memory_001', 'hub opening becomes the active conversation after the capture');
  const prompt = lm.requests[0].body.messages[0].content;
  assert.match(prompt, /直近の行き先での会話: セラ・アストルーペ（character_001）との会話/);
  assert.match(prompt, /ルミが覗ける一番新しい記憶: 主人公は星図の読み方を少し覚えた。/);
  assert.match(prompt, /ルーティングハブopening誘導:/);
  assert.match(prompt, /主人公は星図の読み方を少し覚えた。/);
  assert.match(prompt, /行き先の確認・催促から入らない/);
});

test('routing hub start explicitly renders recent conversation without accepted memory and prior hub conversations as no new memory', async (t) => {
  const scenarios = [
    {
      name: 'non-routing conversation without accepted memory',
      conversationId: 'conv_recent_no_memory_hub_start_001',
      seed: async (root) => {
        await writeJson(root, 'game_data/logs/conversations/conv_recent_no_memory_hub_start_001.json', {
          id: 'conv_recent_no_memory_hub_start_001',
          character_id: 'character_002',
          character_name: 'ミラ',
          messages: []
        });
        await writeJson(root, 'game_data/logs/validator/conv_recent_no_memory_hub_start_001.json', {
          accepted_memory: []
        });
      },
      kind: 'conversation_without_memory',
      promptPattern: /その会話で新しい記憶は生まれていない/
    },
    {
      name: 'unfinished non-routing opening without validator or finalization marker',
      conversationId: 'conv_unfinished_opening_hub_start_001',
      seed: async (root) => {
        await writeJson(root, 'game_data/logs/conversations/conv_unfinished_opening_hub_start_001.json', {
          id: 'conv_unfinished_opening_hub_start_001',
          character_id: 'character_002',
          character_name: 'ミラ',
          source_type: 'field',
          location_id: 'courtyard_fountain',
          time_slot: 'after_school',
          messages: [{ role: 'assistant', content: 'やあ、少し話さない?' }]
        });
      },
      kind: 'conversation_without_memory',
      promptPattern: /その会話で新しい記憶は生まれていない/
    },
    {
      name: 'prior routing hub conversation',
      conversationId: 'conv_prior_routing_hub_start_001',
      seed: async (root) => {
        await writeJson(root, 'game_data/logs/conversations/conv_prior_routing_hub_start_001.json', {
          id: 'conv_prior_routing_hub_start_001',
          character_id: 'lina',
          character_name: 'ルミ',
          routing_hub: routingHubContextFixture('fallen_star'),
          messages: []
        });
      },
      kind: 'no_new_conversation',
      promptPattern: /ルミが覗ける新しい記憶はない/
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const settingsPath = await writeRoutingModeSettings(subtest, `routing-hub-${scenario.kind}-`);
      const lm = await withRoutingLmStub(subtest);
      const { root, base } = await withServer(subtest, {
        playModeSettingsPath: settingsPath,
        lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
      });
      const state = await readJson(root, 'game_data/runtime_state.json');
      await writeJson(root, 'game_data/runtime_state.json', {
        ...state,
        elapsed_weeks: 2,
        last_conversation_id: scenario.conversationId
      });
      await scenario.seed(root);

      const started = await jsonFetch(`${base}/api/routing/hub/start`, {
        method: 'POST',
        body: { id: `conv_routing_hub_${scenario.kind}_001` }
      });

      assert.equal(started.conversation.routing_hub.recent_conversation_context.kind, scenario.kind);
      assert.match(lm.requests[0].body.messages[0].content, scenario.promptPattern);
    });
  }
});

test('routing hub start fails fast on corrupt recent conversation context before any LM request', async (t) => {
  const scenarios = [
    {
      name: 'dangling last conversation id',
      conversationId: 'conv_missing_recent_hub_start_001',
      seed: async () => {},
      message: /last conversation log is missing/
    },
    {
      name: 'finalization marker present but validator missing for non-routing conversation',
      conversationId: 'conv_missing_validator_hub_start_001',
      seed: async (root) => {
        await writeJson(root, 'game_data/logs/conversations/conv_missing_validator_hub_start_001.json', {
          id: 'conv_missing_validator_hub_start_001',
          character_id: 'character_001',
          character_name: 'セラ・アストルーペ',
          messages: []
        });
        await writeJson(root, 'game_data/logs/finalization/conv_missing_validator_hub_start_001.json', {
          conversation_id: 'conv_missing_validator_hub_start_001',
          work_record_id: 'wr_conv_missing_validator_hub_start_001',
          finalized_at: '2026-05-05T06:00:00.000+09:00'
        });
      },
      message: /validator log is missing/
    },
    {
      name: 'unknown buddy id',
      conversationId: null,
      mutateState: (state) => ({ ...state, current_buddy_character_id: 'character_999' }),
      seed: async () => {},
      message: /unknown selectable character/
    },
    {
      name: 'missing current buddy field',
      conversationId: null,
      mutateState: (state) => {
        const next = { ...state };
        delete next.current_buddy_character_id;
        return next;
      },
      seed: async () => {},
      message: /runtime_state.current_buddy_character_id is required/
    },
    {
      name: 'missing current enemy field',
      conversationId: null,
      mutateState: (state) => {
        const next = { ...state };
        delete next.current_enemy_character_ids;
        return next;
      },
      seed: async () => {},
      message: /runtime_state.current_enemy_character_ids is required/
    },
    {
      name: 'blank current enemy entry',
      conversationId: null,
      mutateState: (state) => ({ ...state, current_enemy_character_ids: [''] }),
      seed: async () => {},
      message: /runtime_state.current_enemy_character_ids\[0\] is required/
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const settingsPath = await writeRoutingModeSettings(subtest, `routing-hub-corrupt-${scenario.name.replaceAll(' ', '-')}-`);
      const lm = await withRoutingLmStub(subtest);
      const { root, base } = await withServer(subtest, {
        playModeSettingsPath: settingsPath,
        lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
      });
      const state = await readJson(root, 'game_data/runtime_state.json');
      const nextState = scenario.mutateState
        ? scenario.mutateState({ ...state, elapsed_weeks: 2 })
        : { ...state, elapsed_weeks: 2, last_conversation_id: scenario.conversationId };
      await writeJson(root, 'game_data/runtime_state.json', nextState);
      await scenario.seed(root);

      const response = await fetch(`${base}/api/routing/hub/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: `conv_routing_hub_corrupt_${scenario.name.replaceAll(' ', '_')}_001` })
      });
      assert.equal(response.status, 500);
      const body = JSON.parse(await response.text());
      assert.match(body.error, scenario.message);
      assert.equal(lm.requests.length, 0, 'corrupt hub context must fail before the opening LM request');
    });
  }
});

test('POST /api/debug/relationships rejects non-selectable buddy ids with HTTP 400 and leaves relationship state unchanged', async (t) => {
  const { root, base } = await withServer(t);
  const baseline = await jsonFetch(`${base}/api/debug/relationships`, {
    method: 'POST',
    body: { buddy_character_id: 'character_003', enemy_character_ids: ['character_004'] }
  });
  assert.equal(baseline.relationship.current_buddy_character_id, 'character_003');

  for (const buddyId of ['lina', 'creature_001']) {
    const response = await fetch(`${base}/api/debug/relationships`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buddy_character_id: buddyId, enemy_character_ids: [] })
    });
    assert.equal(response.status, 400);
    const body = JSON.parse(await response.text());
    assert.match(body.error, /buddy character is not a selectable roster character/);
  }

  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.current_buddy_character_id, 'character_003');
  assert.deepEqual(state.current_enemy_character_ids, ['character_004']);
  assert.equal(state.characters?.lina?.flags?.['relationship.lina.buddy'], undefined);
});

test('POST /api/debug/relationships rejects non-selectable enemy ids with HTTP 400 and leaves relationship state unchanged', async (t) => {
  const { root, base } = await withServer(t);
  const baseline = await jsonFetch(`${base}/api/debug/relationships`, {
    method: 'POST',
    body: { buddy_character_id: 'character_005', enemy_character_ids: ['character_006'] }
  });
  assert.equal(baseline.relationship.current_buddy_character_id, 'character_005');

  const response = await fetch(`${base}/api/debug/relationships`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buddy_character_id: null, enemy_character_ids: ['character_007', 'lina'] })
  });
  assert.equal(response.status, 400);
  const body = JSON.parse(await response.text());
  assert.match(body.error, /enemy character is not a selectable roster character/);

  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.current_buddy_character_id, 'character_005');
  assert.deepEqual(state.current_enemy_character_ids, ['character_006']);
  assert.equal(state.characters?.lina?.flags?.['relationship.lina.enemy'], undefined);
});

test('POST /api/debug/relationships recovers a saved invalid buddy=lina by clearing it to null', async (t) => {
  const { root, base } = await withServer(t);
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', {
    ...state,
    current_buddy_character_id: 'lina',
    characters: { ...(state.characters ?? {}), lina: { flags: { 'relationship.lina.buddy': true } } }
  });

  const recovered = await jsonFetch(`${base}/api/debug/relationships`, {
    method: 'POST',
    body: { buddy_character_id: null, enemy_character_ids: [] }
  });
  assert.equal(recovered.relationship.current_buddy_character_id, null);
  assert.equal(recovered.state.current_buddy_character_id, null);
  assert.equal(recovered.state.characters.lina.flags['relationship.lina.buddy'], false);

  const afterState = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(afterState.current_buddy_character_id, null);
});

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

function academyStageVariants(fieldLocation) {
  return [...new Set([
    fieldLocation.visible_situation,
    ...(fieldLocation.visible_situation_variants ?? [])
  ].map((value) => String(value ?? '').trim()).filter(Boolean))];
}

test('routing academy-map arrival rerolls and persists every academy stage situation in the same arrival write; other dispatches and repeated /api/field reads leave it alone', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'academy-stage-arrival-reroll-mode-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'academy-stage-arrival-reroll-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);

  async function dispatch(conversationId, destinationId) {
    await seedConversationForRoutingEnd({ slotRoot, conversationId, characterId: 'lina', routingDestinationId: destinationId });
    return await jsonFetch(`${base}/api/conversation/end`, {
      method: 'POST',
      body: { character_id: 'lina', conversation_id: conversationId, provider: 'mock' }
    });
  }

  // Arrival 1: the dispatch that lands on the academy map reselects every academy stage's situation in the
  // SAME arrival response state (not a separate write): the state already reads screen=academy-map AND
  // carries a fully populated academy_stage_situations.
  const first = await dispatch('conv_academy_stage_arrival_1', 'academy-map');
  assert.equal(first.state.current_screen, 'academy-map');
  assert.ok(first.state.academy_stage_situations && typeof first.state.academy_stage_situations === 'object' && !Array.isArray(first.state.academy_stage_situations));

  const fieldAfterFirst = await jsonFetch(`${base}/api/field`);
  const academyStages = fieldAfterFirst.locations.filter((location) => location.region === 'academy');
  assert.ok(academyStages.length > 0, 'the academy map has field stages');

  // Every academy map stage got a persisted selection drawn from its own variants, and the evaluated field
  // (what the map DOM reads) shows exactly that persisted selection.
  for (const stage of academyStages) {
    const selected = first.state.academy_stage_situations[stage.id];
    assert.equal(academyStageVariants(stage).includes(selected), true, `${stage.id} selection is one of its variants`);
    assert.equal(stage.visible_situation, selected, `${stage.id} map description reads the persisted selection`);
  }
  const persistedAfterFirst = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(persistedAfterFirst.academy_stage_situations, first.state.academy_stage_situations, 'the reroll is durable in runtime state');

  // Idempotency: repeated /api/field reads never reroll — the persisted selections and the returned
  // descriptions stay identical.
  const fieldRepeat = await jsonFetch(`${base}/api/field`);
  const descriptionsFor = (field) => Object.fromEntries(field.locations.filter((l) => l.region === 'academy').map((l) => [l.id, l.visible_situation]));
  assert.deepEqual(descriptionsFor(fieldRepeat), descriptionsFor(fieldAfterFirst), 'repeated /api/field reads return identical stage descriptions');
  const persistedAfterReads = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(persistedAfterReads.academy_stage_situations, first.state.academy_stage_situations, 'GET /api/field does not reroll the academy stage situations');

  // A non-academy-map dispatch (training) progresses the week but must NOT touch academy_stage_situations
  // (the reroll is gated on the academy-map arrival only).
  const training = await dispatch('conv_academy_stage_training_1', 'training');
  assert.equal(training.state.current_screen, 'academy-training');
  assert.deepEqual(training.state.academy_stage_situations, first.state.academy_stage_situations, 'a training dispatch leaves the academy stage situations unchanged');

  // Arrival 2: every academy stage's persisted situation changes from the previous arrival (all authored
  // academy stages have multiple variants, so the previous-value exclusion guarantees a fresh description).
  const second = await dispatch('conv_academy_stage_arrival_2', 'academy-map');
  assert.equal(second.state.current_screen, 'academy-map');
  for (const stage of academyStages) {
    assert.notEqual(
      second.state.academy_stage_situations[stage.id],
      first.state.academy_stage_situations[stage.id],
      `${stage.id} presents a new description on the next arrival`
    );
  }
});

test('after a routing academy-map arrival the conversation prompt context injects the same stage description the map shows', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'academy-stage-arrival-context-mode-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'academy-stage-arrival-context-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);

  await seedConversationForRoutingEnd({ slotRoot, conversationId: 'conv_academy_stage_context_1', characterId: 'lina', routingDestinationId: 'academy-map' });
  const arrival = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', conversation_id: 'conv_academy_stage_context_1', provider: 'mock' }
  });
  assert.equal(arrival.state.current_screen, 'academy-map');

  // The current stage's map description (server-evaluated field) and the conversation prompt context both
  // read the same persisted value: the reroll syncs the current stage's current_location_visible_situation
  // to its new selection.
  const field = await jsonFetch(`${base}/api/field`);
  const currentStage = field.locations.find((location) => location.id === arrival.state.current_location_id);
  assert.ok(currentStage, 'the current location is an evaluated academy field stage');
  const mapDescription = currentStage.visible_situation;
  assert.equal(mapDescription, arrival.state.academy_stage_situations[arrival.state.current_location_id]);

  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=lina&provider=mock`);
  assert.ok(
    preview.prompt.includes(`見えている状況: ${mapDescription}`),
    'the conversation prompt injects the same stage description the map shows for the current stage'
  );
});

test('alchemy API serves the standing recipe book, crafts in place (stay), and persists the content result for the next hub opening', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-alchemy-api-mode-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: {
      base_url: lm.baseUrl,
      chat_model: 'chat-model',
      reflection_model: 'reflection-model',
      timeout_ms: 5000,
      stream: false
    }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const week = 3;
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-alchemy',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: week,
    // A prior applied dispatch to alchemy this week, so the next hub opening treats the craft result as fresh.
    routing_week_progressions: [{
      idempotency_key: 'conv_routing_dispatch_alchemy_001:alchemy',
      conversation_id: 'conv_routing_dispatch_alchemy_001',
      destination_id: 'alchemy',
      phase: 'applied',
      route: 'academy-alchemy',
      applied_at: '2026-07-09T00:00:00.000Z',
      elapsed_weeks: week
    }]
  });
  await writeJson(slotRoot, 'game_data/player_inventory.json', {
    money: 0,
    items: [{ item_id: 'material_light_t1', quantity: 5 }]
  });

  const book = await jsonFetch(`${base}/api/alchemy`);
  assert.equal(book.week, week);
  assert.equal(book.recipes.length, 56);
  assert.equal(book.post_content_screen, 'interaction');
  for (const recipe of book.recipes) {
    assert.equal(typeof recipe.recipe_id, 'string');
    assert.equal(typeof recipe.result.name, 'string');
    assert.equal(typeof recipe.result.effect_summary, 'string');
    assert.equal(typeof recipe.affordable, 'boolean');
    assert.equal(typeof recipe.costs.money.required, 'number');
  }

  const gift = book.recipes.find((recipe) => recipe.recipe_id === 'alchemy_stardust_konpeito');
  assert.equal(gift.affordable, true, 'material_light_t1×2 is held so the gift recipe is craftable');

  const crafted = await jsonFetch(`${base}/api/alchemy/craft`, {
    method: 'POST',
    body: { recipe_id: gift.recipe_id }
  });
  assert.equal(crafted.post_content_screen, 'interaction');
  assert.equal(crafted.result.crafted_item.item_id, 'alchemy_stardust_konpeito');
  assert.equal(crafted.result.content_result.kind, 'alchemy');
  assert.equal(crafted.result.content_result.detail.item_id, 'alchemy_stardust_konpeito');
  assert.equal(crafted.result.content_result.detail.name, '星屑の金平糖');
  assert.equal(crafted.result.content_result.detail.category, 'gift');
  assert.deepEqual(crafted.state.last_routing_content_result, crafted.result.content_result);
  // Stay-and-craft: the screen is not advanced, so the player can craft again.
  assert.equal(crafted.state.current_screen, 'academy-alchemy');
  assert.equal(crafted.result.inventory.items.find((item) => item.item_id === 'alchemy_stardust_konpeito').quantity, 1);
  assert.equal(crafted.result.inventory.items.find((item) => item.item_id === 'material_light_t1').quantity, 3);

  const persistedState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(persistedState.last_routing_content_result, crafted.result.content_result);
  assert.equal(persistedState.current_screen, 'academy-alchemy');

  const hub = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_after_alchemy_result_001' }
  });
  assert.deepEqual(hub.conversation.routing_hub.alchemy_context, {
    recipe_count: 56
  });
  assert.deepEqual(hub.conversation.routing_hub.study_circle_context, {
    theme_count: trainingDefinitions.length,
    weekly_offer_count: 3
  });
  assert.equal(hub.conversation.routing_hub.content_result_context.record.kind, 'alchemy');
  assert.match(hub.conversation.prompt, /調合: 常設の全56種のレシピブックから/);
  assert.match(hub.conversation.prompt, /直近コンテンツ結果: 調合で「星屑の金平糖」/);
});

test('star cradle API serves the garden view and plants a seed in routing mode without LM configured', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'star-cradle-api-mode-');
  // No LM config: the star cradle feature must work fully with LM Studio unconfigured.
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 2 });
  await writeJson(slotRoot, 'game_data/player_inventory.json', { money: 0, items: [{ item_id: 'star_cradle_hoshikusa_seed', quantity: 1 }] });

  const view = await jsonFetch(`${base}/api/star-cradle`);
  assert.equal(view.pot_slots, 3);
  assert.equal(view.creature_slots, 3);
  assert.deepEqual(view.pots, []);
  assert.equal(view.free_pot_slots, 3);

  const planted = await jsonFetch(`${base}/api/star-cradle/plant`, { method: 'POST', body: { item_id: 'star_cradle_hoshikusa_seed' } });
  assert.equal(planted.planted.kind, 'plant');
  assert.equal(planted.view.pots.length, 1);
  assert.equal(planted.view.pots[0].stage, '芽');
  const leftover = planted.inventory.items.find((item) => item.item_id === 'star_cradle_hoshikusa_seed');
  assert.ok(!leftover || leftover.quantity === 0, 'the planted seed is consumed');

  // an unknown seed id is a fail-fast 400, not a silent no-op
  const bad = await fetch(`${base}/api/star-cradle/plant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item_id: 'not_a_star_cradle_seed' })
  });
  assert.equal(bad.status, 400);
});

test('star cradle API rejects loop mode with 409 (routing-only hub side-activity)', async (t) => {
  // The loop sidecar (no active slot) is the loop context now — new games are always routing, so a loop game
  // is not started here; the loop active mode alone must reject the routing-only endpoint.
  const settingsPath = await writeLoopModeSettings(t, 'star-cradle-loop-mode-');
  const { base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const res = await fetch(`${base}/api/star-cradle`);
  assert.equal(res.status, 409);
});

test('study circle API starts host conversations and persists an idempotent routing content result', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-study-circle-api-mode-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: {
      base_url: lm.baseUrl,
      chat_model: 'chat-model',
      reflection_model: 'reflection-model',
      timeout_ms: 5000,
      stream: false
    }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const targetWeek = 3;
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-study-circle',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: targetWeek,
    routing_week_progressions: [{
      idempotency_key: 'conv_routing_dispatch_study_circle_001:study_circle',
      conversation_id: 'conv_routing_dispatch_study_circle_001',
      destination_id: 'study_circle',
      phase: 'applied',
      route: 'academy-study-circle',
      applied_at: '2026-07-04T00:00:00.000Z',
      elapsed_weeks: targetWeek
    }]
  });

  const offers = await jsonFetch(`${base}/api/study-circle?provider=mock`);
  assert.equal(offers.week, targetWeek);
  assert.equal(offers.offers.length, 3);
  for (const offer of offers.offers) {
    assert.equal(typeof offer.theme_id, 'string');
    assert.equal(typeof offer.theme_name, 'string');
    assert.equal(typeof offer.venue, 'string');
    assert.equal(typeof offer.situation, 'string');
    // The appeal (当人の語り) is the card's主表示 and IS public; motivation stays internal.
    assert.equal(typeof offer.appeal, 'string');
    assert.ok(offer.appeal.trim().length > 0, 'the appeal is a non-empty own-voice invitation');
    assert.equal(Object.hasOwn(offer, 'motivation'), false, 'motivation is not public');
    assert.equal(typeof offer.host_character_id, 'string');
    assert.equal(typeof offer.host_display_name, 'string');
    assert.match(offer.host_face_url, /^\/canonical\/character_visual_sets\/visual_set_\d{3}\/face_emotions\/neutral\.jpg$/);
    assert.match(offer.host_selection_icon_url, /^\/canonical\/character_visual_sets\/visual_set_\d{3}\/face_emotions\/neutral\.jpg$/);
    assert.equal(offer.reward_params.length > 0, true);
  }

  const chosen = offers.offers[0];
  const beforeParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  const opened = await jsonFetch(`${base}/api/study-circle/start`, {
    method: 'POST',
    body: { theme_id: chosen.theme_id, provider: 'mock' }
  });
  assert.equal(opened.study_circle.theme_id, chosen.theme_id);
  assert.equal(opened.conversation.character_id, chosen.host_character_id);
  assert.match(opened.conversation.prompt, new RegExp(`舞台: ${chosen.venue}`));
  assert.match(opened.conversation.prompt, new RegExp(`見えている状況: ${chosen.situation}`));
  // The enriched scene tail frames the host as running THIS study circle (framing + title), injected into the prompt.
  assert.match(opened.conversation.prompt, /あなたは今、この研究会を主催していて/);
  assert.match(opened.conversation.prompt, new RegExp(`あなたが開いている研究会: ${chosen.title}`));
  assert.equal(opened.state[ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY].theme_id, chosen.theme_id);

  // The opening record is a study circle injected-scene session (same record contract as the dungeon): it
  // declares source_type 'study_circle' and carries the study circle 舞台, with no residual field
  // location_id / time_slot.
  assert.equal(opened.conversation.source_type, 'study_circle');
  assert.equal(opened.conversation.location_name, chosen.venue);
  assert.equal(Object.hasOwn(opened.conversation, 'location_id'), false);
  assert.equal(Object.hasOwn(opened.conversation, 'time_slot'), false);
  const persistedStudyOpen = await readJson(slotRoot, `game_data/logs/conversations/${opened.conversation.id}.json`);
  assert.equal(persistedStudyOpen.source_type, 'study_circle');
  assert.equal(persistedStudyOpen.location_name, chosen.venue);
  assert.equal(Object.hasOwn(persistedStudyOpen, 'location_id'), false);
  assert.equal(Object.hasOwn(persistedStudyOpen, 'time_slot'), false);

  const mismatch = await fetch(`${base}/api/conversation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'conv_wrong_study_circle_001',
      character_id: chosen.host_character_id,
      player_input: 'この会話ではないはず。',
      provider: 'mock'
    })
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error_code, 'ROUTING_STUDY_CIRCLE_CONTEXT_MISMATCH');

  const ended = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: {
      character_id: chosen.host_character_id,
      conversation_id: opened.conversation.id,
      provider: 'mock'
    }
  });
  // A manual end without achievement consumes the week but applies no reward: the record is stamped
  // achieved:false with empty deltas and the player parameters are untouched.
  assert.equal(ended.finalization_status, 'drained');
  assert.equal(ended.post_content_screen, 'interaction');
  assert.equal(ended.transition.next_screen, 'interaction');
  assert.equal(Object.hasOwn(ended.state, ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY), false);
  assert.equal(ended.study_circle_result.theme_id, chosen.theme_id);
  assert.equal(ended.study_circle_result.achieved, false);
  assert.equal(ended.study_circle_result.record.kind, 'study_circle');
  assert.equal(ended.study_circle_result.record.destination_id, 'study_circle');
  assert.equal(ended.study_circle_result.record.week, targetWeek);
  assert.equal(ended.study_circle_result.record.detail.theme_name, chosen.theme_name);
  assert.equal(ended.study_circle_result.record.detail.achieved, false);
  assert.deepEqual(ended.study_circle_result.record.detail.parameter_deltas, { magic: {}, abilities: {} });
  assert.deepEqual(ended.state.last_routing_content_result, ended.study_circle_result.record);

  const afterParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  assert.deepEqual(afterParameters, beforeParameters, 'an unachieved manual exit applies no parameter reward');

  const retry = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: {
      character_id: chosen.host_character_id,
      conversation_id: opened.conversation.id,
      provider: 'mock'
    }
  });
  assert.equal(retry.reason, 'already_finalized');
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), afterParameters);

  const hub = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_after_study_circle_result_001' }
  });
  assert.deepEqual(hub.conversation.routing_hub.study_circle_context, {
    theme_count: trainingDefinitions.length,
    weekly_offer_count: 3
  });
  assert.equal(hub.conversation.routing_hub.content_result_context.record.kind, 'study_circle');
  assert.match(hub.conversation.prompt, new RegExp(`研究会: 全${trainingDefinitions.length}種のテーマから週3件のオファー`));
  assert.match(hub.conversation.prompt, new RegExp(`直近コンテンツ結果: 研究会（${chosen.theme_name}・${chosen.host_display_name}）を達成できずに終了`));
});

test('a study circle turn that meets the achievement condition auto-ends inside the turn: wrap-up 発話, reward applied, achieved record', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-study-circle-achieve-mode-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: {
      base_url: lm.baseUrl,
      chat_model: 'chat-model',
      reflection_model: 'reflection-model',
      timeout_ms: 5000,
      stream: false
    }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const targetWeek = 3;
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-study-circle',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: targetWeek,
    routing_week_progressions: [{
      idempotency_key: 'conv_routing_dispatch_study_circle_ach_001:study_circle',
      conversation_id: 'conv_routing_dispatch_study_circle_ach_001',
      destination_id: 'study_circle',
      phase: 'applied',
      route: 'academy-study-circle',
      applied_at: '2026-07-04T00:00:00.000Z',
      elapsed_weeks: targetWeek
    }]
  });

  const offers = await jsonFetch(`${base}/api/study-circle?provider=mock`);
  const chosen = offers.offers[0];
  const beforeParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  const opened = await jsonFetch(`${base}/api/study-circle/start`, {
    method: 'POST',
    body: { theme_id: chosen.theme_id, provider: 'mock' }
  });

  // The mock achievement judgment achieves when the player input carries 「達成」. The turn generates the host's
  // wrap-up 発話 and the server auto-ends the study circle within the same turn response.
  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: {
      id: opened.conversation.id,
      character_id: chosen.host_character_id,
      player_input: '今日の研究、やり切りました。達成です。',
      provider: 'mock'
    }
  });
  assert.ok(turn.study_circle_achievement, 'the achieved turn carries the achievement signal');
  assert.equal(turn.study_circle_result.achieved, true);
  assert.equal(turn.finalization_status, 'drained');
  assert.equal(turn.post_content_screen, 'interaction');
  assert.equal(turn.transition.next_screen, 'interaction');
  // The wrap-up 発話 is the closing message of the turn conversation.
  const lastMessage = turn.conversation.messages.at(-1);
  assert.equal(lastMessage.role, 'assistant');
  assert.equal(lastMessage.content, '今日の研究会はここまでにしましょう。よく付き合ってくれました、ありがとう。');
  assert.equal(turn.conversation.study_circle_achievement_judgment.achieved, true);
  assert.equal(Object.hasOwn(turn.conversation, 'conversation_continuation'), false, 'a study circle turn replaces the continuation judgment');

  assert.equal(Object.hasOwn(turn.state, ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY), false, 'the active study circle is cleared');
  assert.equal(turn.state[ROUTING_CONTENT_RESULT_STATE_KEY].kind, 'study_circle');
  assert.equal(turn.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.achieved, true);

  const afterParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  for (const reward of chosen.reward_params) {
    assert.equal(
      afterParameters[reward.group][reward.key].value,
      beforeParameters[reward.group][reward.key].value + reward.amount
    );
    assert.equal(
      turn.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.parameter_deltas[reward.group][reward.key],
      reward.amount
    );
  }

  // Idempotency: a stray manual end after the auto-end finds no active conversation and does not re-apply.
  const strayEnd = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: chosen.host_character_id, conversation_id: opened.conversation.id, provider: 'mock' }
  });
  assert.equal(strayEnd.reason, 'already_finalized');
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), afterParameters);
});

test('a streaming study circle achievement turn emits achievement_draining after the wrap-up and before the result', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-study-circle-stream-drain-mode-');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: {
      base_url: lm.baseUrl,
      chat_model: 'chat-model',
      reflection_model: 'reflection-model',
      timeout_ms: 5000,
      stream: false
    }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const targetWeek = 3;
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-study-circle',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: targetWeek,
    routing_week_progressions: [{
      idempotency_key: 'conv_routing_dispatch_study_circle_stream_001:study_circle',
      conversation_id: 'conv_routing_dispatch_study_circle_stream_001',
      destination_id: 'study_circle',
      phase: 'applied',
      route: 'academy-study-circle',
      applied_at: '2026-07-04T00:00:00.000Z',
      elapsed_weeks: targetWeek
    }]
  });

  const offers = await jsonFetch(`${base}/api/study-circle?provider=mock`);
  const chosen = offers.offers[0];
  const opened = await jsonFetch(`${base}/api/study-circle/start`, {
    method: 'POST',
    body: { theme_id: chosen.theme_id, provider: 'mock' }
  });

  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: opened.conversation.id,
      character_id: chosen.host_character_id,
      player_input: '今日の研究、やり切りました。達成です。',
      provider: 'mock'
    })
  });
  assert.equal(streamed.status, 200);
  const events = parseSse(await streamed.text());
  const eventNames = events.map((item) => item.event);
  const result = events.find((item) => item.event === 'result')?.data;
  assert.ok(result, 'the stream emits a result event');
  assert.ok(result.study_circle_achievement, 'the streamed achieved turn carries the achievement signal');
  assert.equal(result.study_circle_result.achieved, true);
  assert.equal(Object.hasOwn(result.state, ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY), false);
  assert.equal(result.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.achieved, true);

  // Same drain-on-exit contract as the errand path: achievement_draining sits after the wrap-up and before
  // the result, and it is paired with the study circle completion result on the result event (no half-signal).
  const drainingEvents = events.filter((item) => item.event === 'achievement_draining');
  assert.equal(drainingEvents.length, 1, 'the achieved study circle stream emits exactly one achievement_draining signal');
  assert.equal(drainingEvents[0].data.kind, 'study_circle', 'the achievement_draining signal names the study_circle kind');
  const lastWrapUp = eventNames.lastIndexOf('assistant_complete');
  assert.ok(
    lastWrapUp < eventNames.indexOf('achievement_draining')
      && eventNames.indexOf('achievement_draining') < eventNames.indexOf('result'),
    'achievement_draining sits after the wrap-up and before the result (the drain runs under the loading screen)'
  );
});

test('study circle API rejects non-routing and unoffered starts without mutating state or parameters', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-study-circle-api-mode-');
  const { base: loopBase } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  // Loop context = the loop sidecar with no active slot (new games are always routing now).
  const loopGet = await fetch(`${loopBase}/api/study-circle`);
  assert.equal(loopGet.status, 409);
  assert.equal((await loopGet.json()).error_code, 'ROUTING_MODE_REQUIRED');

  const routingSettingsPath = await writeRoutingModeSettings(t, 'routing-study-circle-failure-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: routingSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-study-circle',
    elapsed_weeks: 2
  });
  // Start resolves only from the persisted weekly slot. Before any GET generates it, a start
  // fails fast as not-ready and mutates nothing.
  const beforeReadyState = await readJson(slotRoot, 'game_data/runtime_state.json');
  const beforeReadyParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  const notReady = await fetch(`${base}/api/study-circle/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme_id: 'not_offered', provider: 'mock' })
  });
  assert.equal(notReady.status, 409);
  assert.equal((await notReady.json()).error_code, 'STUDY_CIRCLE_OFFERS_NOT_READY');
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime_state.json'), beforeReadyState);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), beforeReadyParameters);

  // Once the week's offers exist, starting a theme that is not one of the three fails fast as
  // not-offered and still mutates nothing.
  await jsonFetch(`${base}/api/study-circle?provider=mock`);
  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');
  const beforeParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  const unoffered = await fetch(`${base}/api/study-circle/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme_id: 'not_offered', provider: 'mock' })
  });
  assert.equal(unoffered.status, 400);
  assert.equal((await unoffered.json()).error_code, 'STUDY_CIRCLE_THEME_NOT_OFFERED');
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime_state.json'), beforeState);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), beforeParameters);
});

test('study circle provider seam rejects a present-but-unrecognized value (400 UNSUPPORTED_PROVIDER); mock unchanged', async (t) => {
  const routingSettingsPath = await writeRoutingModeSettings(t, 'routing-study-circle-provider-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: routingSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...state, current_screen: 'academy-study-circle', elapsed_weeks: 2 });

  // GET query seam: unknown value rejected before any generation.
  const getUnknown = await fetch(`${base}/api/study-circle?provider=real`);
  assert.equal(getUnknown.status, 400);
  assert.equal((await getUnknown.json()).error_code, 'UNSUPPORTED_PROVIDER');

  // mock GET still works and readies the weekly slot.
  const offers = await jsonFetch(`${base}/api/study-circle?provider=mock`);
  const chosen = offers.offers[0];

  // POST body seam: unknown value rejected.
  const postUnknown = await fetch(`${base}/api/study-circle/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme_id: chosen.theme_id, provider: 'real' })
  });
  assert.equal(postUnknown.status, 400);
  assert.equal((await postUnknown.json()).error_code, 'UNSUPPORTED_PROVIDER');
});

test('alchemy API rejects non-routing mode and a failed craft leaves state, inventory, and parameters untouched', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-alchemy-api-mode-');
  const { base: loopBase } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  // Loop context = the loop sidecar with no active slot (new games are always routing now).
  const loopGet = await fetch(`${loopBase}/api/alchemy`);
  assert.equal(loopGet.status, 409);
  assert.equal((await loopGet.json()).error_code, 'ROUTING_MODE_REQUIRED');

  const routingSettingsPath = await writeRoutingModeSettings(t, 'routing-alchemy-failure-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: routingSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-alchemy',
    elapsed_weeks: 3
  });
  await writeJson(slotRoot, 'game_data/player_inventory.json', { money: 0, items: [] });

  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');
  const beforeInventory = await readJson(slotRoot, 'game_data/player_inventory.json');
  const beforeParameters = await readJson(slotRoot, 'game_data/runtime/player_parameters.json');
  const unknown = await fetch(`${base}/api/alchemy/craft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe_id: 'alchemy_not_a_recipe' })
  });

  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error_code, 'ALCHEMY_RECIPE_NOT_FOUND');
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime_state.json'), beforeState);
  assert.deepEqual(await readJson(slotRoot, 'game_data/player_inventory.json'), beforeInventory);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), beforeParameters);

  // A real recipe with nothing held: insufficient materials, nothing consumed.
  const failed = await fetch(`${base}/api/alchemy/craft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe_id: 'alchemy_stardust_konpeito' })
  });

  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /insufficient_/);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime_state.json'), beforeState);
  assert.deepEqual(await readJson(slotRoot, 'game_data/player_inventory.json'), beforeInventory);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), beforeParameters);

  const definitions = await readJson(root, 'game_data/alchemy_recipes.json');
  await writeJson(root, 'game_data/alchemy_recipes.json', {
    ...definitions,
    recipes: definitions.recipes.slice(0, 55)
  });
  const malformed = await fetch(`${base}/api/alchemy/craft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe_id: 'alchemy_stardust_konpeito' })
  });

  assert.equal(malformed.status, 500);
  assert.match((await malformed.json()).error, /alchemy recipes must contain exactly 56 entries/);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime_state.json'), beforeState);
  assert.deepEqual(await readJson(slotRoot, 'game_data/player_inventory.json'), beforeInventory);
  assert.deepEqual(await readJson(slotRoot, 'game_data/runtime/player_parameters.json'), beforeParameters);
});

// Two strictly-valid equipment instances (a sword, a water amulet) used to seed the
// per-slot player_equipment surface the equipment API reads.
function equipmentInstanceFixtures() {
  return {
    weapon: {
      instance_id: 'equip_weapon_fixture',
      kind: 'weapon',
      weapon_type: 'sword',
      element: 'fire',
      tier: 2,
      quality: 'fine',
      name: '試作の剣',
      flavor: 'テスト用の剣。',
      base_effects: { attack: 5, max_hp: 3, element_spell_power: 2 },
      bonus_effects: { attack: 2 }
    },
    amulet: {
      instance_id: 'equip_amulet_fixture',
      kind: 'amulet',
      element: 'water',
      tier: 1,
      quality: 'common',
      name: '試作の護符',
      flavor: 'テスト用の護符。',
      base_effects: { defense: 4, max_hp: 2 },
      bonus_effects: { defense: 1 }
    }
  };
}

test('equipment API reads, equips, and unequips the two slots with one authoritative snapshot', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-api-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon, amulet } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon, amulet] });

  // Absent slots read as unequipped, not an error; every owned instance is listed. With no buddy set, the buddy
  // sub-view is an explicit null (present, not omitted).
  const initial = await jsonFetch(`${base}/api/equipment`);
  assert.deepEqual(initial.slots, { weapon: null, amulet: null });
  assert.deepEqual(initial.instances, [weapon, amulet]);
  assert.equal(initial.run_equipment, null);
  assert.equal(initial.buddy, null);

  const equippedWeapon = await jsonFetch(`${base}/api/equipment/equip`, {
    method: 'POST',
    body: { target: 'player', slot: 'weapon', instance_id: weapon.instance_id }
  });
  assert.deepEqual(equippedWeapon.slots.weapon, weapon);
  assert.equal(equippedWeapon.slots.amulet, null);
  assert.deepEqual(equippedWeapon.instances, [weapon, amulet]);
  assert.equal(equippedWeapon.run_equipment.slots.weapon.instance_id, weapon.instance_id);
  assert.equal(equippedWeapon.run_equipment.slots.amulet, null);
  assert.equal(equippedWeapon.run_equipment.effects.attack, 7); // base 5 + bonus 2
  assert.deepEqual(equippedWeapon.run_equipment.effects.element_spell_power, { fire: 2 });
  assert.equal(equippedWeapon.buddy, null);
  assert.deepEqual(
    (await readJson(slotRoot, 'game_data/runtime_state.json')).equipment_slots,
    { weapon: weapon.instance_id }
  );

  const equippedBoth = await jsonFetch(`${base}/api/equipment/equip`, {
    method: 'POST',
    body: { target: 'player', slot: 'amulet', instance_id: amulet.instance_id }
  });
  assert.deepEqual(equippedBoth.slots.weapon, weapon);
  assert.deepEqual(equippedBoth.slots.amulet, amulet);
  assert.equal(equippedBoth.run_equipment.effects.defense, 5); // amulet base 4 + bonus 1
  assert.equal(equippedBoth.run_equipment.effects.max_hp, 5); // weapon base 3 + amulet base 2

  const readBack = await jsonFetch(`${base}/api/equipment`);
  assert.deepEqual(readBack.slots.weapon, weapon);
  assert.deepEqual(readBack.slots.amulet, amulet);

  const unequippedWeapon = await jsonFetch(`${base}/api/equipment/unequip`, {
    method: 'POST',
    body: { target: 'player', slot: 'weapon' }
  });
  assert.equal(unequippedWeapon.slots.weapon, null);
  assert.deepEqual(unequippedWeapon.slots.amulet, amulet);
  assert.deepEqual(
    (await readJson(slotRoot, 'game_data/runtime_state.json')).equipment_slots,
    { amulet: amulet.instance_id }
  );

  const unequippedBoth = await jsonFetch(`${base}/api/equipment/unequip`, {
    method: 'POST',
    body: { target: 'player', slot: 'amulet' }
  });
  assert.deepEqual(unequippedBoth.slots, { weapon: null, amulet: null });
  assert.equal(unequippedBoth.run_equipment, null);
  assert.deepEqual(unequippedBoth.instances, [weapon, amulet]);
  assert.equal(unequippedBoth.buddy, null);
  // Fully unequipping returns to the absent-field invariant (no explicit null map).
  assert.equal(
    Object.hasOwn(await readJson(slotRoot, 'game_data/runtime_state.json'), 'equipment_slots'),
    false
  );
});

test('equipment API fails fast on bad slot/instance/kind/body without mutating state', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-failure-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon, amulet } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon, amulet] });
  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');

  const cases = [
    // A missing or unknown target is the caller's 400 before any slot/instance work (no silent player downgrade).
    { path: '/api/equipment/equip', body: { slot: 'weapon', instance_id: weapon.instance_id }, code: 'EQUIPMENT_TARGET_REQUIRED' },
    { path: '/api/equipment/equip', body: { target: 'character_999', slot: 'weapon', instance_id: weapon.instance_id }, code: 'EQUIPMENT_TARGET_UNKNOWN' },
    { path: '/api/equipment/equip', body: { target: 'lina', slot: 'weapon', instance_id: weapon.instance_id }, code: 'EQUIPMENT_TARGET_UNKNOWN' },
    { path: '/api/equipment/unequip', body: { slot: 'weapon' }, code: 'EQUIPMENT_TARGET_REQUIRED' },
    { path: '/api/equipment/unequip', body: { target: 'character_999', slot: 'weapon' }, code: 'EQUIPMENT_TARGET_UNKNOWN' },
    { path: '/api/equipment/equip', body: { target: 'player', slot: 'helmet', instance_id: weapon.instance_id }, code: 'EQUIPMENT_SLOT_UNKNOWN' },
    { path: '/api/equipment/equip', body: { target: 'player', instance_id: weapon.instance_id }, code: 'EQUIPMENT_SLOT_REQUIRED' },
    { path: '/api/equipment/equip', body: { target: 'player', slot: 'weapon' }, code: 'EQUIPMENT_INSTANCE_ID_REQUIRED' },
    { path: '/api/equipment/equip', body: { target: 'player', slot: 'weapon', instance_id: 'equip_missing_fixture' }, code: 'EQUIPMENT_INSTANCE_UNKNOWN' },
    { path: '/api/equipment/equip', body: { target: 'player', slot: 'weapon', instance_id: amulet.instance_id }, code: 'EQUIPMENT_KIND_MISMATCH' },
    { path: '/api/equipment/equip', body: { target: 'character_003', slot: 'weapon', instance_id: amulet.instance_id }, code: 'EQUIPMENT_KIND_MISMATCH' },
    { path: '/api/equipment/unequip', body: { target: 'player', slot: 'helmet' }, code: 'EQUIPMENT_SLOT_UNKNOWN' },
    { path: '/api/equipment/unequip', body: [], code: 'EQUIPMENT_BODY_INVALID' }
  ];
  for (const testCase of cases) {
    const response = await fetch(`${base}${testCase.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(testCase.body)
    });
    const label = `${testCase.path} ${JSON.stringify(testCase.body)}`;
    assert.equal(response.status, 400, label);
    assert.equal((await response.json()).error_code, testCase.code, label);
  }

  // No failed request equipped anything or partially applied: runtime_state is byte-equal
  // and neither the hero nor a companion slot field was written.
  const afterState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(afterState, beforeState);
  assert.equal(Object.hasOwn(afterState, 'equipment_slots'), false);
  assert.equal(Object.hasOwn(afterState, 'companion_equipment_slots'), false);
});

test('equipment API surfaces the current buddy sub-view and equips/unequips the buddy with one-of-a-kind exclusion', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-buddy-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon, amulet } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon, amulet] });

  // No buddy set → the buddy sub-view is an explicit null.
  assert.equal((await jsonFetch(`${base}/api/equipment`)).buddy, null);

  // Set the run companion and read the buddy sub-view: present, character_id + unequipped slots + null run_equipment.
  const buddyId = 'character_003';
  const stateBefore = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...stateBefore, current_buddy_character_id: buddyId });
  const withBuddy = await jsonFetch(`${base}/api/equipment`);
  assert.deepEqual(withBuddy.buddy, { character_id: buddyId, slots: { weapon: null, amulet: null }, run_equipment: null });
  // Adding a buddy leaves the player fields unchanged.
  assert.deepEqual(withBuddy.slots, { weapon: null, amulet: null });
  assert.equal(withBuddy.run_equipment, null);

  // Equip the weapon onto the buddy: the buddy sub-view mirrors the player derivation (resolved slot + run summary),
  // the player slots stay empty, and runtime_state persists under companion_equipment_slots.
  const buddyEquipped = await jsonFetch(`${base}/api/equipment/equip`, {
    method: 'POST',
    body: { target: buddyId, slot: 'weapon', instance_id: weapon.instance_id }
  });
  assert.deepEqual(buddyEquipped.buddy.slots.weapon, weapon);
  assert.equal(buddyEquipped.buddy.slots.amulet, null);
  assert.equal(buddyEquipped.buddy.run_equipment.slots.weapon.instance_id, weapon.instance_id);
  assert.equal(buddyEquipped.buddy.run_equipment.effects.attack, 7); // base 5 + bonus 2
  assert.deepEqual(buddyEquipped.slots, { weapon: null, amulet: null });
  assert.equal(buddyEquipped.run_equipment, null);
  assert.deepEqual(
    (await readJson(slotRoot, 'game_data/runtime_state.json')).companion_equipment_slots,
    { [buddyId]: { weapon: weapon.instance_id } }
  );

  // One-of-a-kind exclusion across owners: the hero cannot take the instance the buddy wears (400 + code), and the
  // rejected attempt writes no hero slot.
  const conflict = await fetch(`${base}/api/equipment/equip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'player', slot: 'weapon', instance_id: weapon.instance_id })
  });
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error_code, 'EQUIPMENT_INSTANCE_ALREADY_EQUIPPED');
  assert.equal(Object.hasOwn(await readJson(slotRoot, 'game_data/runtime_state.json'), 'equipment_slots'), false);

  // Unequip the buddy: the emptied entry leaves no companion residue, and the buddy sub-view returns to unequipped.
  const buddyCleared = await jsonFetch(`${base}/api/equipment/unequip`, {
    method: 'POST',
    body: { target: buddyId, slot: 'weapon' }
  });
  assert.deepEqual(buddyCleared.buddy, { character_id: buddyId, slots: { weapon: null, amulet: null }, run_equipment: null });
  assert.equal(
    Object.hasOwn(await readJson(slotRoot, 'game_data/runtime_state.json'), 'companion_equipment_slots'),
    false
  );
});

test('equipment API rejects a buddy id that does not resolve to a selectable character (corrupt state, never nulled)', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-buddy-corrupt-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const stateBefore = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...stateBefore, current_buddy_character_id: 'character_999' });
  const response = await fetch(`${base}/api/equipment`);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /current_buddy_character_id is present but does not resolve/);
});

// Hand-seeds an active homunculus into a play slot: the surface active entry plus its actor directory,
// enough for the buddy/companion consumption surfaces to resolve it.
async function seedActiveHomunculusInSlot(slotRoot, { id = 'homunculus_001', displayName = 'ノクス', faceId = 'hp_007', affinity = 50 } = {}) {
  const magicKeys = magicParameterDefinitions.map((definition) => definition.key);
  const abilityKeys = abilityParameterDefinitions.map((definition) => definition.key);
  const parameters = {
    magic: Object.fromEntries(magicKeys.map((key) => [key, { value: 50 }])),
    abilities: Object.fromEntries(abilityKeys.map((key) => [key, { value: 60 }]))
  };
  await writeJson(slotRoot, 'game_data/homunculi.json', { version: 1, active: [{ homunculus_id: id, display_name: displayName, face_id: faceId, created_week: 5 }], nameplates: [] });
  await writeJson(slotRoot, `game_data/homunculi/${id}/profile.json`, { character_id: id, display_name: displayName, visual_set_id: faceId, prompt_description: 'x', speaking_basis: 'x', available_expressions: ['neutral'], parameters });
  await writeJson(slotRoot, `game_data/homunculi/${id}/flags.json`, { character_id: id, flags: {} });
  await writeJson(slotRoot, `game_data/homunculi/${id}/affinity.json`, { homunculus_id: id, affinity, applied_affinity_conversation_ids: [] });
  return id;
}

test('equipment API surfaces a homunculus buddy sub-view (display_name + face_url) and equips/rejects it by active membership', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-hom-buddy-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon] });
  await seedActiveHomunculusInSlot(slotRoot, { id: 'homunculus_001', displayName: 'ノクス', faceId: 'hp_007' });

  // The debug relationship endpoint accepts an active homunculus buddy.
  const set = await jsonFetch(`${base}/api/debug/relationships`, { method: 'POST', body: { buddy_character_id: 'homunculus_001', enemy_character_ids: [] } });
  assert.equal(set.relationship.current_buddy_character_id, 'homunculus_001');

  // The buddy sub-view carries the server-resolved homunculus display_name + face_url (the frontend cannot
  // resolve a homunculus from the selectable roster).
  const snapshot = await jsonFetch(`${base}/api/equipment`);
  assert.equal(snapshot.buddy.character_id, 'homunculus_001');
  assert.equal(snapshot.buddy.display_name, 'ノクス');
  assert.match(snapshot.buddy.face_url, /hp_007\/face_emotions\/neutral\.jpg$/);

  // Equipping onto the active homunculus buddy persists under companion_equipment_slots.
  const equipped = await jsonFetch(`${base}/api/equipment/equip`, { method: 'POST', body: { target: 'homunculus_001', slot: 'weapon', instance_id: weapon.instance_id } });
  assert.equal(equipped.buddy.slots.weapon.instance_id, weapon.instance_id);
  assert.deepEqual((await readJson(slotRoot, 'game_data/runtime_state.json')).companion_equipment_slots, { homunculus_001: { weapon: weapon.instance_id } });

  // A non-active homunculus target is the caller's 400 (never a silent player downgrade).
  const badTarget = await fetch(`${base}/api/equipment/equip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'homunculus_099', slot: 'weapon', instance_id: weapon.instance_id }) });
  assert.equal(badTarget.status, 400);
  assert.equal((await badTarget.json()).error_code, 'EQUIPMENT_TARGET_UNKNOWN');
});

test('GET /api/relationships/buddy returns the current buddy display data across rosters (ungated)', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-relationships-buddy-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);

  // No buddy → null.
  assert.deepEqual(await jsonFetch(`${base}/api/relationships/buddy`), { buddy: null });

  // Homunculus buddy → kind homunculus with display_name + face_url + affinity.
  await seedActiveHomunculusInSlot(slotRoot, { id: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_012', affinity: 61 });
  await jsonFetch(`${base}/api/debug/relationships`, { method: 'POST', body: { buddy_character_id: 'homunculus_001', enemy_character_ids: [] } });
  const homBuddy = (await jsonFetch(`${base}/api/relationships/buddy`)).buddy;
  assert.equal(homBuddy.character_id, 'homunculus_001');
  assert.equal(homBuddy.kind, 'homunculus');
  assert.equal(homBuddy.display_name, 'ヴィオラ');
  assert.equal(homBuddy.affinity, 61);
  assert.match(homBuddy.face_url, /hp_012\/face_emotions\/neutral\.jpg$/);

  // Selectable buddy → kind character, display data resolved from the roster.
  await jsonFetch(`${base}/api/debug/relationships`, { method: 'POST', body: { buddy_character_id: 'character_004', enemy_character_ids: [] } });
  const charBuddy = (await jsonFetch(`${base}/api/relationships/buddy`)).buddy;
  assert.equal(charBuddy.character_id, 'character_004');
  assert.equal(charBuddy.kind, 'character');
  assert.equal(typeof charBuddy.display_name, 'string');
  assert.equal(typeof charBuddy.affinity, 'number');
  assert.match(charBuddy.face_url, /face_emotions\/neutral\.jpg$/);
});

test('equipment snapshot carries a per-instance sale view (deterministic price + equipped判定)', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-sales-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon, amulet } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon, amulet] });

  // The sale view is parallel to instances (same order), carries the deterministic price
  // (weapon tier 2 fine = 36, amulet tier 1 common = 8), and marks both unequipped.
  const initial = await jsonFetch(`${base}/api/equipment`);
  assert.deepEqual(initial.sales, [
    { instance_id: weapon.instance_id, sell_price: 36, equipped: false },
    { instance_id: amulet.instance_id, sell_price: 8, equipped: false }
  ]);

  // Equipping flips the equipped flag for that instance; the price is unchanged.
  await jsonFetch(`${base}/api/equipment/equip`, {
    method: 'POST',
    body: { target: 'player', slot: 'weapon', instance_id: weapon.instance_id }
  });
  const afterEquip = await jsonFetch(`${base}/api/equipment`);
  assert.deepEqual(afterEquip.sales, [
    { instance_id: weapon.instance_id, sell_price: 36, equipped: true },
    { instance_id: amulet.instance_id, sell_price: 8, equipped: false }
  ]);
});

test('POST /api/shop/sell-equipment sells an unequipped instance, credits the wallet, and removes it from the surface', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-sell-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon, amulet } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon, amulet] });
  const moneyBefore = (await jsonFetch(`${base}/api/inventory`)).money;

  const sold = await jsonFetch(`${base}/api/shop/sell-equipment`, {
    method: 'POST',
    body: { instance_id: amulet.instance_id }
  });
  assert.equal(sold.sell_price, 8, 'tier 1 common sells for 8');
  assert.equal(sold.sold_instance.instance_id, amulet.instance_id);
  assert.equal(sold.sold_instance.name, amulet.name);
  assert.equal(sold.inventory.money, moneyBefore + 8);

  // The instance is gone from the surface and the equipment list; the wallet persisted.
  assert.deepEqual(
    (await readJson(slotRoot, 'game_data/player_equipment.json')).instances.map((i) => i.instance_id),
    [weapon.instance_id]
  );
  const listing = await jsonFetch(`${base}/api/equipment`);
  assert.deepEqual(listing.instances.map((i) => i.instance_id), [weapon.instance_id]);
  assert.deepEqual(listing.sales.map((s) => s.instance_id), [weapon.instance_id]);
  assert.equal((await jsonFetch(`${base}/api/inventory`)).money, moneyBefore + 8);
});

test('POST /api/shop/sell-equipment rejects an equipped or unknown instance as 400 with the domain code, unchanged state', async (t) => {
  const loopSettingsPath = await writeLoopModeSettings(t, 'loop-equipment-sell-reject-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: loopSettingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const { weapon, amulet } = equipmentInstanceFixtures();
  await writeJson(slotRoot, 'game_data/player_equipment.json', { version: 1, instances: [weapon, amulet] });
  // Equip the weapon onto a companion so the equipped-across-any-owner rule applies.
  await jsonFetch(`${base}/api/equipment/equip`, {
    method: 'POST',
    body: { target: 'character_003', slot: 'weapon', instance_id: weapon.instance_id }
  });
  const moneyBefore = (await jsonFetch(`${base}/api/inventory`)).money;

  const cases = [
    { instance_id: weapon.instance_id, error: 'equipment_instance_equipped' },
    { instance_id: 'equip_missing_fixture', error: 'unknown_equipment_instance' }
  ];
  for (const testCase of cases) {
    const response = await fetch(`${base}/api/shop/sell-equipment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance_id: testCase.instance_id })
    });
    assert.equal(response.status, 400, testCase.error);
    assert.equal((await response.json()).error, testCase.error);
  }

  // No rejected sale removed an instance or credited the wallet.
  assert.deepEqual(
    (await readJson(slotRoot, 'game_data/player_equipment.json')).instances.map((i) => i.instance_id),
    [weapon.instance_id, amulet.instance_id]
  );
  assert.equal((await jsonFetch(`${base}/api/inventory`)).money, moneyBefore);
});

test('routing conversation end applies week progression idempotently for dispatch retries', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-idempotent-mode-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-dispatch-idempotent-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const conversationId = 'conv_routing_dispatch_retry_001';
  await seedConversationForRoutingEnd({ slotRoot, conversationId, characterId: 'lina', routingDestinationId: 'training' });

  // Drain-on-exit finalizes on the first end; the mock provider drains without an LM Studio config.
  const first = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', conversation_id: conversationId, provider: 'mock' }
  });
  const second = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', conversation_id: conversationId, provider: 'mock' }
  });

  assert.equal(first.state.elapsed_weeks, 1);
  assert.equal(first.week_progression.status, 'applied');
  assert.equal(second.state.elapsed_weeks, 1, 'retrying the same dispatch must not increment a second week');
  assert.equal(second.week_progression.status, 'already_applied');
  assert.equal(second.week_progression.idempotency_key, `${conversationId}:training`);
  assert.deepEqual(
    second.state.routing_week_progressions.map((record) => record.idempotency_key),
    [`${conversationId}:training`]
  );
});

test('routing hub dispatch to the dungeon drains ルミ on exit so the dungeon return sees an empty queue', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dungeon-dispatch-drain-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-dungeon-dispatch-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const conversationId = 'conv_routing_dungeon_dispatch_001';
  await seedConversationForRoutingEnd({ slotRoot, conversationId, characterId: 'lina', routingDestinationId: 'dungeon' });

  // The hub->dungeon dispatch drains ルミ's hub finalization on exit (mock provider drains without an LM
  // config), so when the player arrives at the dungeon the pending-finalization queue is already empty —
  // there is nothing left to serial-drain on the later dungeon->hub return.
  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', conversation_id: conversationId, provider: 'mock' }
  });
  assert.equal(ending.finalization_status, 'drained');
  assert.equal(ending.routing_dispatch.destination_id, 'dungeon');
  assert.equal(ending.state.current_screen, 'academy-dungeon');
  assert.equal(ending.transition.next_screen, 'academy-dungeon');
  assert.deepEqual(ending.state.pending_finalizations, [], 'the hub->dungeon dispatch leaves an empty queue at dungeon entry');
  const conversation = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
  assert.equal(conversation.discarded_after_work_record_id, `wr_${conversationId}`, 'ルミ is finalized on the dispatch exit, not deferred to the dungeon return');
});

test('routing conversation end leaves state unchanged when non-graduation week progression fails', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-non-graduation-failure-mode-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-dispatch-non-graduation-failure-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const conversationId = 'conv_routing_dispatch_non_grad_failure_001';
  await seedConversationForRoutingEnd({ slotRoot, conversationId, characterId: 'lina', routingDestinationId: 'training' });
  const seededState = await readJson(slotRoot, 'game_data/runtime_state.json');
  const unchangedState = {
    ...seededState,
    elapsed_weeks: 0,
    sanrin_creature_placements: { sanrin_trailhead: 'creature_001' }
  };
  await writeJson(slotRoot, 'game_data/runtime_state.json', unchangedState);

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: conversationId })
  });

  assert.equal(response.status, 500);
  assert.match(await response.text(), /sanrin_creature_placements must cover exactly/);
  const persisted = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(persisted, unchangedState);
});

test('routing hub start at the displayed graduation week creates the graduation guide and keeps the opening as smalltalk', async (t) => {
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-hub-guide-create-mode-')), 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'hourglass_grain' }, null, 2)}\n`, 'utf8');
  const lm = await withRoutingLmStub(t);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  // Displayed graduation week: elapsed 49 (the hub shows week 50). Give character_008 the most memory so it ranks
  // first among the guide candidates.
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 49 });
  await fs.mkdir(path.join(slotRoot, 'game_data/characters/character_008/memory'), { recursive: true });
  await writeJson(slotRoot, 'game_data/characters/character_008/memory/mem_1.json', { id: 'mem_1', text: 'memory 1' });
  await writeJson(slotRoot, 'game_data/characters/character_008/memory/mem_2.json', { id: 'mem_2', text: 'memory 2' });

  const hub = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_hub_guide_create_001', provider: 'mock' }
  });

  // The opening is the unchanged smalltalk opening: it carries no guide selection judgment (that only runs on
  // continuation turns), and elapsed_weeks stays at the displayed graduation week.
  assert.equal(hub.conversation.id, 'conv_routing_hub_guide_create_001');
  assert.equal(Object.hasOwn(hub.conversation, 'graduation_guide_judgment'), false, 'the hub opening stays smalltalk, not a guide turn');
  assert.equal(hub.state.elapsed_weeks, 49);

  // The graduation guide is created at hub start, so every continuation turn of this hub conversation runs as the
  // guide. The candidates are the top-N memory-ranked characters (character_008 first here).
  const afterStart = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(afterStart.routing_graduation_guide.candidate_character_ids[0], 'character_008');
  assert.equal(afterStart.routing_graduation_guide.candidate_character_ids.length, 3);
  assert.equal(afterStart.elapsed_weeks, 49, 'creating the guide does not advance the week');
  const createdStartedAt = afterStart.routing_graduation_guide.started_at;
  assert.equal(typeof createdStartedAt, 'string');

  // Idempotent: a re-start with the guide already present does not re-select or overwrite it.
  await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_hub_guide_create_002', provider: 'mock' }
  });
  const afterRestart = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(afterRestart.routing_graduation_guide.candidate_character_ids, afterStart.routing_graduation_guide.candidate_character_ids);
  assert.equal(afterRestart.routing_graduation_guide.started_at, createdStartedAt, 'a re-start must not re-create the guide');
});

test('routing graduation guide selection turn starts the chosen character event and the event end completes the run', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-graduation-guide-select-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const hubConversationId = 'conv_routing_hub_guide_select_001';
  const selectedCharacterId = 'character_002';
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: hubConversationId,
    characterId: 'lina',
    routingHub: true
  });
  // The seeded hub conversation must carry the actor-context snapshot key (null is valid) so it can be
  // continued as a live turn, not only ended.
  const hubConversation = await readJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`);
  await writeJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`, {
    ...hubConversation,
    conversation_actor_context: null
  });
  // Enter the graduation guide phase directly (the hub-start guide creation is covered separately): the guide runs
  // at the displayed graduation week (elapsed 49), the top-3 characters presented, the hub conversation is the live
  // guide conversation.
  const guideState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...guideState,
    elapsed_weeks: 49,
    routing_graduation_guide: {
      candidate_character_ids: ['character_003', selectedCharacterId, 'character_001'],
      started_at: '2026-05-26T06:00:00.000+09:00'
    }
  });

  // A turn whose utterance chooses one of the three presented characters confirms the partner and starts
  // phase 2 (the character graduation event). Starting the ending conversation advances the week to the graduation
  // week (elapsed 49 → 50). With no conversation-popup settings file the academy_conversation_screen preference
  // defaults to 'day', so the event lands on the daytime conversation screen: transition.next_screen is
  // 'conversation-day' and the persisted current_screen is 'interaction' (the same mapping every daytime event
  // conversation uses). The guide phase state is cleared and the event context is unchanged by the landing screen.
  const selectionTurn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { id: hubConversationId, character_id: 'lina', player_input: `最後は ${selectedCharacterId} と過ごしたい`, provider: 'mock' }
  });
  assert.equal(selectionTurn.routing_graduation_guide_selection.character_id, selectedCharacterId);
  assert.equal(selectionTurn.graduation_ending.character_id, selectedCharacterId);
  assert.equal(selectionTurn.transition.next_screen, 'conversation-day');
  assert.equal(selectionTurn.transition.loading_copy_key, 'graduation-ending-start');
  assert.equal(selectionTurn.state.current_screen, 'interaction');
  assert.equal(selectionTurn.state.elapsed_weeks, 50, 'starting the ending conversation advances the week to the graduation week');
  assert.equal(selectionTurn.state.ending_character_id, selectedCharacterId);
  assert.equal(selectionTurn.state.current_interaction_character_id, selectedCharacterId);
  assert.equal(selectionTurn.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(Object.hasOwn(selectionTurn.state, 'routing_graduation_guide'), false, 'the guide phase state must be cleared once the character event starts');

  // Phase 2: the character event opening and its end reach the same run-complete terminal as loop graduation.
  const opening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: selectedCharacterId, provider: 'mock' }
  });
  assert.equal(opening.conversation.event_flag_id, 'event.graduation_ending.ready');

  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: selectedCharacterId, provider: 'mock' }
  });
  assert.equal(ending.finalization_status, 'completed');
  assert.equal(ending.state.current_screen, 'title');
  assert.equal(ending.state.ending_completed, true);
  assert.equal(ending.transition.next_screen, 'title');
  assert.equal(ending.transition.loading_copy_key, 'graduation-ending-complete');

  const finalState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(finalState.ending_completed, true);
  assert.equal(finalState.global_flags['event.graduation_ending.completed'], true);
  const slots = await jsonFetch(`${base}/api/slots`);
  const graduatedSlot = slots.slots.find((slot) => slot.slot_id === started.slot.slot_id);
  assert.equal(graduatedSlot.graduation_completed, true);
});

test('routing graduation guide selection of the guide persona (lina) starts the persona event and completes the run, supplying the persona visual on the confirm and phase-2 opening responses', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-graduation-guide-persona-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  // Pin the persona to ルミ (fallen_star) so the guide-persona visual/name assertions are deterministic.
  await forceRoutingSlotPersonaVariant(root, started.slot.slot_id, 'fallen_star');
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const hubConversationId = 'conv_routing_hub_guide_persona_001';
  await seedConversationForRoutingEnd({ slotRoot, conversationId: hubConversationId, characterId: 'lina', routingHub: true });
  const hubConversation = await readJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`);
  await writeJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`, {
    ...hubConversation,
    conversation_actor_context: null
  });
  const guideState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...guideState,
    elapsed_weeks: 49,
    routing_graduation_guide: {
      candidate_character_ids: ['character_003', 'character_002', 'character_001'],
      started_at: '2026-05-26T06:00:00.000+09:00'
    }
  });

  // A turn whose utterance chooses the guide persona itself (案内人自身・lina) confirms the persona as the
  // graduation partner: the selection carries character_id 'lina' and the effective variant proper name, the
  // phase-2 event flag source is 'lina', and the confirm response supplies the routing persona visual (the
  // same summary shape hub start returns) so the frontend renders the persona hub-outside.
  const selectionTurn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { id: hubConversationId, character_id: 'lina', player_input: '最後は案内人のあなた（lina）と過ごしたい', provider: 'mock' }
  });
  assert.equal(selectionTurn.routing_graduation_guide_selection.character_id, 'lina');
  assert.equal(selectionTurn.routing_graduation_guide_selection.display_name, 'ルミ');
  assert.equal(selectionTurn.graduation_ending.character_id, 'lina');
  assert.equal(selectionTurn.transition.next_screen, 'conversation-day');
  assert.equal(selectionTurn.state.ending_character_id, 'lina');
  assert.equal(selectionTurn.state.current_interaction_character_id, 'lina');
  assert.equal(selectionTurn.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(selectionTurn.state.event_flag_sources['event.graduation_ending.ready'].character_id, 'lina');
  assert.equal(Object.hasOwn(selectionTurn.state, 'routing_graduation_guide'), false);
  assert.deepEqual(selectionTurn.routing_persona_visual, {
    character_id: 'lina',
    display_name: 'ルミ',
    visual_set_id: 'routing_lumi_fallen_star',
    face_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
    selection_icon_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/face_emotions/neutral.jpg',
    standee_url: '/canonical/character_visual_sets/routing_lumi_fallen_star/scene_standee/scene_standee_character_01.jpg',
    available_expressions: ['neutral', 'joy', 'caring', 'confident', 'sadness', 'worried', 'anger', 'surprised', 'embarrassed', 'shy', 'serious', 'determined', 'panic', 'tired', 'sick', 'smug']
  });

  // Phase 2: the persona event opening (also the restore re-open path) carries the persona visual too, and its
  // event context is the graduation ending flag on the persona actor.
  const opening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });
  assert.equal(opening.conversation.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(opening.conversation.character_id, 'lina');
  assert.equal(opening.conversation.character_name, 'ルミ');
  assert.equal(opening.routing_persona_visual.character_id, 'lina');
  assert.equal(opening.routing_persona_visual.display_name, 'ルミ');
  assert.equal(opening.routing_persona_visual.visual_set_id, 'routing_lumi_fallen_star');

  // The persona event end reaches the same run-complete terminal as loop / character graduation.
  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });
  assert.equal(ending.finalization_status, 'completed');
  assert.equal(ending.state.current_screen, 'title');
  assert.equal(ending.state.ending_completed, true);
  assert.equal(ending.transition.next_screen, 'title');
  assert.equal(ending.transition.loading_copy_key, 'graduation-ending-complete');

  const finalState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(finalState.ending_completed, true);
  assert.equal(finalState.global_flags['event.graduation_ending.completed'], true);
  const slots = await jsonFetch(`${base}/api/slots`);
  const graduatedSlot = slots.slots.find((slot) => slot.slot_id === started.slot.slot_id);
  assert.equal(graduatedSlot.graduation_completed, true);
});

test('routing graduation guide selection lands on the daytime screen even when academy_conversation_screen is legacy (setting ignored)', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-graduation-guide-legacy-mode-');
  const conversationPopupSettingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'conv-popup-legacy-')), 'conversation-popup.json');
  // The academy_conversation_screen setting is deliberately 'legacy' to prove the backend landing resolution
  // no longer reads it: routing is official, so the graduation event lands on the daytime screen regardless.
  await fs.writeFile(
    conversationPopupSettingsPath,
    `${JSON.stringify({ cooldown_ms: 500, animation_ms: 220, academy_conversation_screen: 'legacy' }, null, 2)}\n`,
    'utf8'
  );
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, conversationPopupSettingsPath });
  const startedGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', startedGame.slot.slot_id);
  const hubConversationId = 'conv_routing_hub_guide_legacy_001';
  const selectedCharacterId = 'character_002';
  await seedConversationForRoutingEnd({ slotRoot, conversationId: hubConversationId, characterId: 'lina', routingHub: true });
  const hubConversation = await readJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`);
  await writeJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`, {
    ...hubConversation,
    conversation_actor_context: null
  });
  const guideState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...guideState,
    elapsed_weeks: 49,
    routing_graduation_guide: {
      candidate_character_ids: ['character_003', selectedCharacterId, 'character_001'],
      started_at: '2026-05-26T06:00:00.000+09:00'
    }
  });

  // The backend landing resolution is fixed to the daytime screen and does not read the preference, so even
  // with academy_conversation_screen='legacy' the graduation event lands on the day screen: transition.next_screen
  // is 'conversation-day' (the frontend navigation target). The persisted current_screen for a daytime event
  // conversation is 'interaction' (startEventFlagInteraction maps every non-legacy landing to 'interaction').
  const selectionTurn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { id: hubConversationId, character_id: 'lina', player_input: `最後は ${selectedCharacterId} と過ごしたい`, provider: 'mock' }
  });
  assert.equal(selectionTurn.graduation_ending.character_id, selectedCharacterId);
  assert.equal(selectionTurn.transition.next_screen, 'conversation-day');
  assert.equal(selectionTurn.transition.loading_copy_key, 'graduation-ending-start');
  assert.equal(selectionTurn.state.current_screen, 'interaction');
  assert.equal(selectionTurn.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
});

test('routing hub turn at the displayed graduation week runs as a guide turn and never dispatches a destination', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-graduation-guide-inturn-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const hubConversationId = 'conv_routing_hub_guide_inturn_001';
  const candidateIds = ['character_003', 'character_002', 'character_001'];
  await seedConversationForRoutingEnd({ slotRoot, conversationId: hubConversationId, characterId: 'lina', routingHub: true });
  const hubConversation = await readJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`);
  await writeJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`, {
    ...hubConversation,
    conversation_actor_context: null
  });
  // The guide is created at hub start; here it is already active at the displayed graduation week (elapsed 49).
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 49,
    routing_graduation_guide: { candidate_character_ids: candidateIds, started_at: '2026-05-26T06:00:00.000+09:00' }
  });

  // Even an utterance that names a destination runs as a guide turn: the routing destination judgment is gated off
  // while the guide is active, so the response carries no routing_destination and no routing_dispatch, no week
  // progression fires, and elapsed_weeks stays at the displayed graduation week.
  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { id: hubConversationId, character_id: 'lina', player_input: '今週は training に集中したい', provider: 'mock' }
  });
  assert.equal(Object.hasOwn(turn, 'routing_dispatch'), false, 'a guide turn must not dispatch a destination');
  assert.equal(Object.hasOwn(turn, 'routing_destination'), false, 'the routing destination judgment is gated off during the guide');
  assert.equal(Object.hasOwn(turn, 'routing_graduation_guide_selection'), false);
  assert.equal(turn.conversation.graduation_guide_judgment.decided, false, 'the turn is a guide turn');
  assert.equal(turn.state.elapsed_weeks, 49);
  const afterTurn = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(afterTurn.routing_graduation_guide.candidate_character_ids, candidateIds);
  assert.equal(afterTurn.elapsed_weeks, 49);
  assert.equal(Object.hasOwn(afterTurn, 'routing_week_progressions'), false, 'a guide turn advances no week progression');
});

test('routing conversation end rejects an explicit title wrap_up while the graduation guide is active', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-graduation-guide-wrapup-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const hubConversationId = 'conv_routing_hub_guide_wrapup_001';
  const candidateIds = ['character_003', 'character_002', 'character_001'];
  await seedConversationForRoutingEnd({ slotRoot, conversationId: hubConversationId, characterId: 'lina', routingHub: true });
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 49,
    routing_graduation_guide: { candidate_character_ids: candidateIds, started_at: '2026-05-26T06:00:00.000+09:00' }
  });

  // The guide has no title wrap-up (the run cannot leave graduation once the guide begins): an explicit
  // wrap_up during the guide fail-fasts with a 409 and leaves the guide state and week untouched.
  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: hubConversationId, wrap_up: 'title', provider: 'mock' })
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /wrap_up is not allowed during the graduation guide/);
  const persisted = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(persisted.routing_graduation_guide.candidate_character_ids, candidateIds);
  assert.equal(persisted.elapsed_weeks, 49);
});

test('routing graduation guide continues on an undecided turn and resumes the guide context after a reload', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-graduation-guide-resume-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const hubConversationId = 'conv_routing_hub_guide_resume_001';
  const candidateIds = ['character_003', 'character_002', 'character_001'];
  await seedConversationForRoutingEnd({ slotRoot, conversationId: hubConversationId, characterId: 'lina', routingHub: true });
  const hubConversation = await readJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`);
  await writeJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`, {
    ...hubConversation,
    conversation_actor_context: null
  });
  const guideState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...guideState,
    elapsed_weeks: 49,
    routing_graduation_guide: { candidate_character_ids: candidateIds, started_at: '2026-05-26T06:00:00.000+09:00' }
  });

  // An undecided utterance keeps the guide conversation going: no partner is chosen, no phase 2, and the guide
  // phase state is untouched.
  const undecidedTurn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { id: hubConversationId, character_id: 'lina', player_input: 'まだ迷っている', provider: 'mock' }
  });
  assert.equal(Object.hasOwn(undecidedTurn, 'routing_graduation_guide_selection'), false);
  assert.equal(Object.hasOwn(undecidedTurn, 'graduation_ending'), false);
  assert.equal(undecidedTurn.conversation.graduation_guide_judgment.decided, false);
  const afterUndecided = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(afterUndecided.routing_graduation_guide.candidate_character_ids, candidateIds, 'the guide phase state persists across an undecided turn');
  assert.equal(afterUndecided.elapsed_weeks, 49, 'elapsed_weeks stays at the displayed graduation week through the guide');

  // Reload: a fresh turn reconstructs the guide context from the persisted state and still judges the partner
  // (the guide prompt presents the three candidates again), then confirms and starts phase 2.
  const decidedTurn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { id: hubConversationId, character_id: 'lina', player_input: 'character_002 と締めくくりたい', provider: 'mock' }
  });
  assert.equal(decidedTurn.routing_graduation_guide_selection.character_id, 'character_002');
  assert.match(decidedTurn.conversation.graduation_guide_judgment.prompt, /締めくくりの相手の名称とcharacter_idの対応表/);
  assert.equal(decidedTurn.state.ending_character_id, 'character_002');
  assert.equal(decidedTurn.state.elapsed_weeks, 50, 'confirming the partner starts the ending and advances the week');
});

test('routing conversation end fails fast when retry recovery has ambiguous progression records', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-ambiguous-progression-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const conversationId = 'conv_routing_dispatch_ambiguous_progression_001';
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 49,
    routing_week_progressions: [
      {
        idempotency_key: `${conversationId}:training`,
        conversation_id: conversationId,
        destination_id: 'training',
        phase: 'applied',
        started_at: '2026-05-05T06:00:00.000+09:00',
        applied_at: '2026-05-05T06:00:00.000+09:00',
        elapsed_weeks: 49,
        route: 'academy-training'
      },
      {
        idempotency_key: `${conversationId}:dungeon`,
        conversation_id: conversationId,
        destination_id: 'dungeon',
        phase: 'applied',
        started_at: '2026-05-05T06:00:00.000+09:00',
        applied_at: '2026-05-05T06:00:00.000+09:00',
        elapsed_weeks: 49,
        route: 'academy-dungeon'
      }
    ]
  });
  await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, {
    id: conversationId,
    character_id: 'lina',
    character_name: 'ルミ',
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:02:00.000+09:00',
    discarded_after_work_record_id: `wr_${conversationId}`,
    messages: [
      { role: 'assistant', content: '行き先を決めましょう。' },
      { role: 'user', content: 'お願いします。' }
    ]
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: conversationId, provider: 'mock' })
  });

  assert.equal(response.status, 500);
  assert.match(await response.text(), /multiple routing week progressions for conversation_id/);
});

test('routing conversation end fails fast instead of advancing a week progression into graduation', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-into-graduation-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const dispatchConversationId = 'conv_routing_dispatch_into_graduation_001';
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  const previousSanrinPlacements = {
    sanrin_trailhead: 'creature_001',
    sanrin_conifer_forest: 'creature_002',
    sanrin_stream_bank: 'creature_003',
    sanrin_mossy_shrine: 'creature_004'
  };
  // Displayed graduation week (elapsed 49) with NO guide state and a decided routing destination — the guide should
  // have been created at hub start, so reaching a destination dispatch here is a wiring bug. The dispatch would try
  // to advance the week into graduation; it must fail-fast before any write instead of silently running the loop
  // graduation path, leaving elapsed, sanrin placements, and progressions untouched.
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 49,
    sanrin_creature_placements: previousSanrinPlacements
  });
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: dispatchConversationId,
    characterId: 'lina',
    routingDestinationId: 'training'
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: dispatchConversationId, provider: 'mock' })
  });

  assert.equal(response.status, 500);
  assert.match(await response.text(), /must not advance into graduation/);
  const persisted = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(persisted.elapsed_weeks, 49);
  assert.equal(persisted.ending_started, false);
  assert.equal(Object.hasOwn(persisted, 'routing_week_progressions'), false, 'no week progression is written when the dispatch fails fast');
  assert.deepEqual(persisted.sanrin_creature_placements, previousSanrinPlacements);
});

test('routing conversation end fails fast on an unknown decided hub destination', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-unknown-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: 'conv_routing_dispatch_unknown_001',
    characterId: 'lina',
    routingDestinationId: 'bananas'
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: 'conv_routing_dispatch_unknown_001' })
  });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /unknown routing destination/);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(Object.hasOwn(state, 'pending_finalizations'), false, 'unknown destination must not enqueue a fallback job');
});

test('routing conversation end wraps up to the title screen by fully draining without progressing the week', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-title-drain-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const pendingConversationId = 'conv_routing_pending_wrapup_001';
  const dispatchConversationId = 'conv_routing_dispatch_title_001';
  const pendingActorRoot = path.join(slotRoot, 'game_data/characters/character_008');
  await fs.mkdir(path.join(pendingActorRoot, 'memory'), { recursive: true });
  await fs.mkdir(path.join(pendingActorRoot, 'work_records'), { recursive: true });
  await writeJson(slotRoot, 'game_data/characters/character_008/flags.json', {
    character_id: 'character_008',
    flags: { 'knowledge.character_008.player_checked_garden_label': false }
  });
  await writeJson(slotRoot, 'game_data/characters/character_008/skills.json', { character_id: 'character_008', skills: [] });
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  // A partial sanrin placement the week-progressing dispatch would reject on its forced redraw. The
  // wrap-up exit never touches sanrin, so it survives untouched — proof that no redraw ran and the
  // week did not advance.
  const untouchedSanrinPlacements = { sanrin_trailhead: 'creature_001' };
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 3,
    sanrin_creature_placements: untouchedSanrinPlacements,
    pending_finalizations: [{
      conversation_id: pendingConversationId,
      character_id: 'character_008',
      enqueued_at: '2026-05-05T06:00:00.000+09:00',
      status: 'pending',
      attempts: 0
    }]
  });
  await writeJson(slotRoot, `game_data/logs/conversations/${pendingConversationId}.json`, {
    id: pendingConversationId,
    character_id: 'character_008',
    character_name: 'テスト生徒',
    created_at: '2026-05-05T05:59:00.000+09:00',
    updated_at: '2026-05-05T06:00:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    messages: [
      { role: 'assistant', content: '棚札を見ていました。' },
      { role: 'user', content: '一緒に確認しよう。' }
    ]
  });
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: dispatchConversationId,
    characterId: 'lina',
    routingDestinationId: 'title'
  });

  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', conversation_id: dispatchConversationId, provider: 'mock' }
  });

  assert.equal(ending.finalization_status, 'drained');
  assert.equal(Object.hasOwn(ending, 'pending_finalization'), false, 'a drained title wrap-up response must not carry a singular pending_finalization field');
  assert.equal(ending.routing_dispatch.destination_id, 'title');
  assert.equal(ending.routing_dispatch.destination_label, '区切りをつける');
  assert.equal(ending.routing_dispatch.next_screen, 'title');
  assert.equal(ending.transition.next_screen, 'title');
  assert.equal(Object.hasOwn(ending, 'week_progression'), false, 'the wrap-up exit must not report week progression');
  assert.equal(ending.state.elapsed_weeks, 3, 'the wrap-up exit must not advance the week');
  assert.equal(ending.state.current_screen, 'title');
  assert.equal(ending.state.current_interaction_character_id, null);
  assert.equal(ending.state.pending_interaction_context, null);
  assert.equal(ending.state.ending_started, false, 'the wrap-up exit must not fire the graduation ending');
  assert.equal(Object.hasOwn(ending.state, 'routing_week_progressions'), false, 'the wrap-up exit must not record a week progression');
  assert.deepEqual(ending.state.sanrin_creature_placements, untouchedSanrinPlacements, 'the wrap-up exit must not redraw sanrin placements');
  assert.deepEqual(ending.state.pending_finalizations, [], 'the whole pending-finalization queue must be drained before returning to title');
  const pendingConversation = await readJson(slotRoot, `game_data/logs/conversations/${pendingConversationId}.json`);
  const dispatchConversation = await readJson(slotRoot, `game_data/logs/conversations/${dispatchConversationId}.json`);
  assert.equal(pendingConversation.discarded_after_work_record_id, `wr_${pendingConversationId}`, 'other queued jobs are drained too');
  assert.equal(dispatchConversation.discarded_after_work_record_id, `wr_${dispatchConversationId}`, 'the hub conversation itself is finalized in the same full drain');
});

test('routing conversation end explicit title wrap_up drains an undecided hub conversation to title without progressing the week', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-wrap-up-title-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const pendingConversationId = 'conv_routing_pending_explicit_wrapup_001';
  const hubConversationId = 'conv_routing_undecided_title_wrapup_001';
  const pendingActorRoot = path.join(slotRoot, 'game_data/characters/character_008');
  await fs.mkdir(path.join(pendingActorRoot, 'memory'), { recursive: true });
  await fs.mkdir(path.join(pendingActorRoot, 'work_records'), { recursive: true });
  await writeJson(slotRoot, 'game_data/characters/character_008/flags.json', {
    character_id: 'character_008',
    flags: { 'knowledge.character_008.player_checked_garden_label': false }
  });
  await writeJson(slotRoot, 'game_data/characters/character_008/skills.json', { character_id: 'character_008', skills: [] });
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  const untouchedSanrinPlacements = { sanrin_trailhead: 'creature_001' };
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 3,
    sanrin_creature_placements: untouchedSanrinPlacements,
    pending_finalizations: [{
      conversation_id: pendingConversationId,
      character_id: 'character_008',
      enqueued_at: '2026-05-05T06:00:00.000+09:00',
      status: 'pending',
      attempts: 0
    }]
  });
  await writeJson(slotRoot, `game_data/logs/conversations/${pendingConversationId}.json`, {
    id: pendingConversationId,
    character_id: 'character_008',
    character_name: 'テスト生徒',
    created_at: '2026-05-05T05:59:00.000+09:00',
    updated_at: '2026-05-05T06:00:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    messages: [
      { role: 'assistant', content: '棚札を見ていました。' },
      { role: 'user', content: '一緒に確認しよう。' }
    ]
  });
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: hubConversationId,
    characterId: 'lina',
    routingHub: true
  });

  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', conversation_id: hubConversationId, provider: 'mock', wrap_up: 'title' }
  });

  assert.equal(ending.finalization_status, 'drained');
  assert.equal(Object.hasOwn(ending, 'pending_finalization'), false, 'a drained explicit title wrap-up response must not carry a singular pending_finalization field');
  assert.equal(ending.routing_dispatch.destination_id, 'title');
  assert.equal(ending.routing_dispatch.destination_label, '区切りをつける');
  assert.equal(ending.routing_dispatch.next_screen, 'title');
  assert.equal(ending.transition.next_screen, 'title');
  assert.equal(Object.hasOwn(ending, 'week_progression'), false, 'the explicit wrap-up exit must not report week progression');
  assert.equal(ending.state.elapsed_weeks, 3, 'the explicit wrap-up exit must not advance the week');
  assert.equal(ending.state.current_screen, 'title');
  assert.equal(ending.state.current_interaction_character_id, null);
  assert.equal(ending.state.pending_interaction_context, null);
  assert.equal(ending.state.ending_started, false, 'the explicit wrap-up exit must not fire the graduation ending');
  assert.equal(Object.hasOwn(ending.state, 'routing_week_progressions'), false, 'the explicit wrap-up exit records no week progression');
  assert.deepEqual(ending.state.sanrin_creature_placements, untouchedSanrinPlacements, 'the explicit wrap-up exit must not redraw sanrin placements');
  assert.deepEqual(ending.state.pending_finalizations, [], 'the explicit wrap-up exit drains the whole pending-finalization queue before returning to title');
  const pendingConversation = await readJson(slotRoot, `game_data/logs/conversations/${pendingConversationId}.json`);
  const hubConversation = await readJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`);
  assert.equal(pendingConversation.discarded_after_work_record_id, `wr_${pendingConversationId}`, 'other queued jobs are drained too');
  assert.equal(hubConversation.discarded_after_work_record_id, `wr_${hubConversationId}`, 'the undecided hub conversation itself is finalized in the same full drain');
});

test('routing conversation end title wrap_up keeps active errand context validation', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-wrap-up-errand-context-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const hubConversationId = 'conv_routing_undecided_title_wrapup_context_001';
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: hubConversationId,
    characterId: 'lina',
    routingHub: true
  });
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    [ROUTING_ACTIVE_ERRAND_STATE_KEY]: {
      errand_id: 'study_01',
      type_id: 'study_01',
      title: '資料室の整理',
      situation: '資料室の机に、分類待ちの古い貸出票が積まれている。',
      prompt_tail_context: '依頼主と一緒に古い貸出票を整理する。',
      condition_text: '主人公が貸出票を整理し、依頼主が片付いたと確認した。',
      reward_money: 45,
      client_character_id: 'lina',
      client_display_name: 'ルミ',
      conversation_id: 'conv_active_errand_other_001',
      week: 3,
      started_at: '2026-05-05T06:00:00.000+09:00'
    }
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: hubConversationId, provider: 'mock', wrap_up: 'title' })
  });
  const error = await response.json();

  assert.equal(response.status, 409);
  assert.equal(error.error_code, 'ROUTING_ERRAND_CONTEXT_MISMATCH');
  assert.match(error.error, /active routing errand conversation mismatch/);
});

test('routing conversation end rejects unknown wrap_up values', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-wrap-up-invalid-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: 'conv_routing_invalid_wrapup_value_001',
    characterId: 'lina',
    routingHub: true
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: 'conv_routing_invalid_wrapup_value_001', wrap_up: 'academy-map' })
  });

  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.error_code, 'INVALID_CONVERSATION_WRAP_UP');
  assert.match(error.error, /unknown conversation end wrap_up/);
});

test('routing conversation end title wrap_up rejects loop-mode end requests', async (t) => {
  // The default sidecar (no play-mode.json) resolves to loop with no active slot; wrap_up rejects on mode
  // before any slot/conversation read, so no loop game needs to be started (new games are always routing now).
  const { base } = await withServer(t);

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: 'conv_loop_title_wrapup_001', wrap_up: 'title' })
  });

  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.error_code, 'INVALID_CONVERSATION_WRAP_UP');
  assert.match(error.error, /conversation end wrap_up requires routing mode/);
});

test('routing conversation end title wrap_up rejects non-hub conversations', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-wrap-up-non-hub-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: 'conv_routing_non_hub_title_wrapup_001',
    characterId: 'character_007'
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_007', conversation_id: 'conv_routing_non_hub_title_wrapup_001', wrap_up: 'title' })
  });

  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.error_code, 'INVALID_CONVERSATION_WRAP_UP');
  assert.match(error.error, /conversation end wrap_up requires a routing hub conversation/);
});

test('routing conversation end title wrap_up rejects already decided hub conversations', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-wrap-up-decided-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: 'conv_routing_decided_title_wrapup_001',
    characterId: 'lina',
    routingDestinationId: 'training'
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: 'conv_routing_decided_title_wrapup_001', wrap_up: 'title' })
  });

  assert.equal(response.status, 409);
  const error = await response.json();
  assert.equal(error.error_code, 'ROUTING_WRAP_UP_CONFLICT');
  assert.match(error.error, /conversation end wrap_up cannot override a decided routing destination/);
});

test('routing conversation end without wrap_up still rejects undecided hub conversations', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-wrap-up-absent-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: 'conv_routing_no_wrapup_undecided_001',
    characterId: 'lina',
    routingHub: true
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: 'conv_routing_no_wrapup_undecided_001' })
  });

  assert.equal(response.status, 409);
  assert.match(await response.text(), /routing hub conversation has no decided routing destination/);
});

test('routing conversation end fails fast on the wrap-up exit while pending finalizations remain blocked', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-dispatch-title-blocked-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const dispatchConversationId = 'conv_routing_dispatch_title_blocked_001';
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    elapsed_weeks: 3,
    pending_finalizations: [{
      conversation_id: 'conv_routing_failed_wrapup_001',
      character_id: 'lina',
      enqueued_at: '2026-05-05T06:00:00.000+09:00',
      status: 'failed',
      attempts: 1,
      error: { message: 'previous finalization failed' }
    }]
  });
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: dispatchConversationId,
    characterId: 'lina',
    routingDestinationId: 'title'
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', conversation_id: dispatchConversationId, provider: 'mock' })
  });

  // A blocked queue fails fast: the wrap-up never confirms a half-drained title exit, and it advances
  // nothing. The blocking failed job stays for retry.
  assert.equal(response.status, 500);
  assert.match(await response.text(), /pending finalizations are blocked by failed jobs/);
  const persisted = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(persisted.elapsed_weeks, 3, 'a blocked wrap-up drain must not advance the week');
  assert.equal(persisted.ending_started, false);
  assert.equal(Object.hasOwn(persisted, 'routing_week_progressions'), false, 'the wrap-up exit records no week progression');
  const dispatchConversation = await readJson(slotRoot, `game_data/logs/conversations/${dispatchConversationId}.json`);
  assert.equal(Object.hasOwn(dispatchConversation, 'discarded_after_work_record_id'), false, 'the hub conversation must not be finalized when the drain is blocked');
  const stillFailed = persisted.pending_finalizations.find((job) => job.conversation_id === 'conv_routing_failed_wrapup_001');
  assert.equal(stillFailed.status, 'failed', 'the blocking failed job remains for retry');
});

test('routing conversation end returns non-hub content conversations to the hub through the post-content resolver', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-content-return-mode-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-content-return-missing-lm-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({
    slotRoot,
    conversationId: 'conv_routing_content_return_001',
    characterId: 'character_007'
  });

  // Drain-on-exit needs a provider to finalize; the mock provider drains without an LM Studio config.
  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'character_007', conversation_id: 'conv_routing_content_return_001', provider: 'mock' }
  });

  assert.equal(ending.finalization_status, 'drained');
  assert.equal(Object.hasOwn(ending, 'pending_finalization'), false, 'a drained content-return response must not carry a singular pending_finalization field');
  assert.equal(Object.hasOwn(ending, 'routing_dispatch'), false);
  assert.equal(ending.state.current_screen, 'interaction');
  assert.equal(ending.transition.next_screen, 'interaction');
  // The content-return exit fully drained the queue before returning to the hub.
  assert.deepEqual(ending.state.pending_finalizations, [], 'the content-return exit drains the queue empty');
  const conversation = await readJson(slotRoot, 'game_data/logs/conversations/conv_routing_content_return_001.json');
  assert.equal(conversation.discarded_after_work_record_id, 'wr_conv_routing_content_return_001', 'the content-return conversation is finalized on exit');
});

test('routing conversation end fail-fasts with a structured error when drain-on-exit cannot resolve an LM provider', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-drain-no-lm-');
  const missingLmConfigPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'routing-drain-no-lm-missing-')), 'missing-lmstudio.json');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath, lmStudioConfigPath: missingLmConfigPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await seedConversationForRoutingEnd({ slotRoot, conversationId: 'conv_routing_drain_no_lm_001', characterId: 'character_007' });

  // No provider + missing LM config: drain-on-exit requires an LM provider to finalize, so the end
  // fail-fasts with a structured error instead of silently returning or degrading to loop.
  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_007', conversation_id: 'conv_routing_drain_no_lm_001' })
  });
  assert.equal(response.status, 503);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
  // The failed drain leaves the conversation un-finalized so a later exit (with a provider) can retry it.
  const conversation = await readJson(slotRoot, 'game_data/logs/conversations/conv_routing_drain_no_lm_001.json');
  assert.equal(Object.hasOwn(conversation, 'discarded_after_work_record_id'), false, 'a drain that cannot resolve a provider does not finalize the conversation (retryable)');
});

test('the removed routing drain endpoints (finalize-next / character finalize) return 404 (drain-on-exit removed the idle/entry drain paths)', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-removed-drain-endpoints-');
  const { base } = await withServer(t, { playModeSettingsPath: settingsPath });
  for (const pathname of ['/api/conversation/finalize-next', '/api/conversation/finalize']) {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mock' })
    });
    // The route is gone from the lifecycle route set, so it falls through to the 404 handler rather than
    // matching a handler that never responds (which would hang the request).
    assert.equal(response.status, 404, `${pathname} should be removed (404)`);
  }
});

test('routing conversation turn rederives active hub context and dispatches a decided destination', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-turn-rederive-mode-');
  const lm = await withRoutingLmStub(t, routingTurnLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const startedGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await forceRoutingSlotPersonaVariant(root, startedGame.slot.slot_id, 'fallen_star');
  const slotRoot = path.join(root, 'game_data/play/slots', startedGame.slot.slot_id);
  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...beforeState, elapsed_weeks: 0 });

  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_turn_rederive_001' }
  });
  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { character_id: 'character_001', player_input: '今週は鍛錬する' }
  });

  assert.equal(turn.conversation.id, opening.conversation.id);
  assert.equal(turn.conversation.character_id, 'lina');
  assert.equal(turn.conversation.character_name, 'ルミ');
  assert.equal(turn.conversation.routing_hub.persona_variant, 'fallen_star');
  assert.deepEqual(turn.conversation.routing_hub.recent_conversation_context, opening.conversation.routing_hub.recent_conversation_context);
  assert.match(turn.conversation.prompt, /ルーティング会話メタ情報:/);
  assert.match(turn.conversation.prompt, /ルミが覗ける新しい記憶はない/);
  assert.match(turn.conversation.prompt, /あなたはルミである。/);
  assert.doesNotMatch(turn.conversation.prompt, /セラ・アストルーペ/);
  assert.doesNotMatch(turn.conversation.prompt, /舞台: 薬草温室/);
  assert.deepEqual(turn.routing_destination, {
    destination_id: 'training',
    destination_label: '鍛錬',
    transition_assistant_text: 'では、鍛錬へ向かいましょう。新しい一週間をそこから始めます。',
    narration: '行き先は鍛錬に決まった。六つの行動で一週間の鍛錬を進め、魔法習熟度と基礎能力のパラメーターを増減させる。'
  });
  assert.equal(turn.routing_dispatch.destination_id, 'training');
  assert.equal(turn.routing_dispatch.next_screen, 'academy-training');
  assert.equal(turn.finalization_status, 'drained');
  assert.equal(Object.hasOwn(turn, 'pending_finalization'), false, 'a drained in-turn dispatch response must not carry a singular pending_finalization field');
  assert.equal(turn.week_progression.status, 'applied');
  assert.equal(turn.week_progression.idempotency_key, `${opening.conversation.id}:training`);
  assert.equal(turn.state.current_screen, 'academy-training');
  assert.equal(turn.state.current_interaction_character_id, null);
  assert.equal(turn.state.pending_interaction_context, null);
  assert.equal(turn.state.elapsed_weeks, 1);
  // Drain-on-exit: the in-turn dispatch drained the hub finalization, so no residual pending job remains
  // and the dispatched hub conversation is finalized (its routing decision was already asserted on the
  // response's routing_dispatch / routing_destination above).
  assert.equal(turn.state.pending_finalizations.find((job) => job.conversation_id === opening.conversation.id), undefined, 'the in-turn dispatch drains the hub finalization on exit');

  const persisted = await readJson(slotRoot, `game_data/logs/conversations/${opening.conversation.id}.json`);
  assert.equal(persisted.discarded_after_work_record_id, `wr_${opening.conversation.id}`, 'the dispatched hub conversation is finalized on exit');
});

test('routing conversation stream rederives active hub context and returns dispatch in the result event', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-stream-rederive-mode-');
  const lm = await withRoutingLmStub(t, routingTurnLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const startedGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await forceRoutingSlotPersonaVariant(root, startedGame.slot.slot_id, 'fallen_star');
  const slotRoot = path.join(root, 'game_data/play/slots', startedGame.slot.slot_id);
  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...beforeState, elapsed_weeks: 0 });

  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_stream_rederive_001' }
  });
  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_001', player_input: '今週は鍛錬する' })
  });

  assert.equal(streamed.status, 200);
  const events = parseSse(await streamed.text());
  const eventNames = events.map((item) => item.event);
  const result = events.find((item) => item.event === 'result')?.data;
  // Drain-on-exit loading signal: the stream emits routing_draining AFTER the send-off (assistant_complete)
  // and BEFORE the result (the drain runs between them), so the client shows the loading screen while the
  // post-processing drain runs, with the send-off already shown.
  const drainingEvent = events.find((item) => item.event === 'routing_draining');
  assert.ok(drainingEvent, 'the decided routing turn stream emits a routing_draining signal before its drain');
  assert.equal(drainingEvent.data.destination_id, 'training');
  assert.ok(
    eventNames.indexOf('assistant_complete') < eventNames.indexOf('routing_draining')
      && eventNames.indexOf('routing_draining') < eventNames.indexOf('result'),
    'routing_draining sits after the send-off and before the result (the drain runs under the loading screen)'
  );
  // A routing destination turn is not an achievement auto-end: it carries routing_destination, not
  // errand_achievement / study_circle_achievement, so achievement_draining stays off (only routing_draining fires).
  assert.equal(
    eventNames.includes('achievement_draining'),
    false,
    'a routing destination turn emits routing_draining, never achievement_draining'
  );
  assert.equal(result.conversation.id, opening.conversation.id);
  assert.equal(result.conversation.character_id, 'lina');
  assert.equal(result.conversation.routing_hub.persona_variant, 'fallen_star');
  assert.deepEqual(result.conversation.routing_hub.recent_conversation_context, opening.conversation.routing_hub.recent_conversation_context);
  assert.match(result.conversation.prompt, /ルーティング会話メタ情報:/);
  assert.match(result.conversation.prompt, /ルミが覗ける新しい記憶はない/);
  assert.doesNotMatch(result.conversation.prompt, /セラ・アストルーペ/);
  assert.equal(result.routing_destination.destination_id, 'training');
  assert.equal(result.routing_dispatch.destination_id, 'training');
  assert.equal(result.routing_dispatch.next_screen, 'academy-training');
  assert.equal(result.finalization_status, 'drained');
  assert.equal(Object.hasOwn(result, 'pending_finalization'), false, 'a drained streamed dispatch response must not carry a singular pending_finalization field');
  assert.equal(result.week_progression.status, 'applied');
  assert.equal(result.state.current_screen, 'academy-training');
  assert.equal(result.state.elapsed_weeks, 1);
  // Drain-on-exit: the streamed dispatch drained the hub finalization, so no residual pending job remains.
  assert.equal(result.state.pending_finalizations.find((job) => job.conversation_id === opening.conversation.id), undefined, 'the streamed dispatch drains the hub finalization on exit');
});

test('routing conversation stream emits finalization_progress block boundaries between routing_draining and result', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-stream-finalization-progress-mode-');
  const lm = await withRoutingLmStub(t, routingTurnLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const startedGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await forceRoutingSlotPersonaVariant(root, startedGame.slot.slot_id, 'fallen_star');
  const slotRoot = path.join(root, 'game_data/play/slots', startedGame.slot.slot_id);
  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...beforeState, elapsed_weeks: 0 });

  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_stream_finprog_001' }
  });
  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_001', player_input: '今週は鍛錬する' })
  });

  assert.equal(streamed.status, 200);
  const events = parseSse(await streamed.text());
  const eventNames = events.map((item) => item.event);
  const progressEvents = events.filter((item) => item.event === 'finalization_progress');
  // The hub conversation is the single drained job, so exactly the 5-phase closed set is emitted once, in order.
  assert.deepEqual(
    progressEvents.map((item) => item.data.phase),
    ['memory', 'skill', 'work_record', 'state_effects', 'commit'],
    'a single drained job emits the finalization phases as the ordered closed set'
  );
  // The payload names the drained conversation's actor so a multi-job drain can be attributed per character.
  for (const item of progressEvents) {
    assert.equal(item.data.character_id, 'lina', 'each finalization_progress names the drained hub conversation actor');
  }
  // Ordering contract: existing drain signal → finalization_progress (0+) → result. The block boundaries sit
  // strictly after routing_draining and strictly before result, so the loader raised during the drain advances.
  const firstProgress = eventNames.indexOf('finalization_progress');
  const lastProgress = eventNames.lastIndexOf('finalization_progress');
  assert.ok(
    eventNames.indexOf('routing_draining') < firstProgress && lastProgress < eventNames.indexOf('result'),
    'finalization_progress events sit after routing_draining and before result'
  );
});

test('routing conversation stream emits an error event with INVALID_LLM_CONTINUATION_OUTPUT when the continuation judgment output is invalid', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-stream-invalid-continuation-mode-');
  const lm = await withRoutingLmStub(t, routingInvalidContinuationLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const startedGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', startedGame.slot.slot_id);

  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_stream_invalid_continuation_001' }
  });
  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_001', player_input: '鍛錬か迷っている' })
  });

  assert.equal(streamed.status, 200);
  const events = parseSse(await streamed.text());
  const errorEvent = events.find((item) => item.event === 'error');
  assert.ok(errorEvent, 'the invalid continuation turn stream emits an error event');
  // The exact wire error_code is the contract the client keys on to show the cause and route to the LM
  // settings; the fixed string here pins it against silent drift.
  assert.equal(errorEvent.data.error_code, 'INVALID_LLM_CONTINUATION_OUTPUT');
  assert.match(errorEvent.data.error, /conversation continuation judgment must be true or false/);
  // Fail-fast before persistence: the stream never reaches a result, and the persisted hub conversation
  // keeps no continuation / destination judgment from the failed turn.
  assert.equal(events.find((item) => item.event === 'result'), undefined);
  const persisted = await readJson(slotRoot, `game_data/logs/conversations/${opening.conversation.id}.json`);
  assert.equal(Object.hasOwn(persisted, 'conversation_continuation'), false);
  assert.equal(Object.hasOwn(persisted, 'routing_destination_judgment'), false);
});

test('routing conversation non-stream turn returns a 503 JSON error with INVALID_LLM_CONTINUATION_OUTPUT when the continuation judgment output is invalid', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-turn-invalid-continuation-mode-');
  const lm = await withRoutingLmStub(t, routingInvalidContinuationLmResponder);
  const { base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_turn_invalid_continuation_001' }
  });
  const response = await fetch(`${base}/api/conversation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'character_001', player_input: '鍛錬か迷っている' })
  });

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error_code, 'INVALID_LLM_CONTINUATION_OUTPUT');
  assert.match(body.error, /conversation continuation judgment must be true or false/);
});

test('routing conversation turn dispatches a decided title wrap-up: full drain, no week progression, title transition', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-turn-title-mode-');
  const lm = await withRoutingLmStub(t, routingTurnTitleLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const startedGame = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', startedGame.slot.slot_id);
  const beforeState = await readJson(slotRoot, 'game_data/runtime_state.json');
  // A partial sanrin placement the week-progressing dispatch would reject on its forced redraw; the
  // wrap-up must leave it untouched (proof it neither redraws sanrin nor advances the week).
  const untouchedSanrinPlacements = { sanrin_trailhead: 'creature_001' };
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...beforeState,
    elapsed_weeks: 3,
    sanrin_creature_placements: untouchedSanrinPlacements
  });

  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_turn_title_001' }
  });
  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { character_id: 'character_001', player_input: '今日はここまでにしたい' }
  });
  // The main routing decision path (in-turn dispatch via /api/conversation, not the end button) funnels
  // through the same wrap-up branch: neutral title exit, full drain, no week progression.
  assert.equal(turn.conversation.id, opening.conversation.id);
  assert.equal(turn.conversation.character_id, 'lina');
  assert.equal(turn.routing_destination.destination_id, 'title');
  assert.equal(turn.routing_destination.destination_label, '区切りをつける');
  assert.equal(turn.routing_dispatch.destination_id, 'title');
  assert.equal(turn.routing_dispatch.next_screen, 'title');
  assert.equal(turn.finalization_status, 'drained');
  assert.equal(Object.hasOwn(turn, 'pending_finalization'), false, 'a drained in-turn title wrap-up response must not carry a singular pending_finalization field');
  assert.equal(Object.hasOwn(turn, 'week_progression'), false, 'the wrap-up exit must not report week progression');
  assert.equal(turn.transition.next_screen, 'title');
  assert.equal(turn.state.current_screen, 'title');
  assert.equal(turn.state.current_interaction_character_id, null);
  assert.equal(turn.state.pending_interaction_context, null);
  assert.equal(turn.state.elapsed_weeks, 3, 'the wrap-up exit must not advance the week');
  assert.equal(turn.state.ending_started, false, 'the wrap-up exit must not fire the graduation ending');
  assert.equal(Object.hasOwn(turn.state, 'routing_week_progressions'), false, 'the wrap-up exit records no week progression');
  assert.deepEqual(turn.state.sanrin_creature_placements, untouchedSanrinPlacements, 'the wrap-up exit must not redraw sanrin placements');
  assert.deepEqual(turn.state.pending_finalizations, [], 'the hub finalization is fully drained before returning to title');
  // The turn result already proves the decided destination (turn.routing_destination / routing_dispatch);
  // after the full drain the hub conversation is discarded, so its log carries the finalization marker
  // rather than the pre-finalize routing judgment.
  const persisted = await readJson(slotRoot, `game_data/logs/conversations/${opening.conversation.id}.json`);
  assert.equal(persisted.discarded_after_work_record_id, `wr_${opening.conversation.id}`, 'the hub conversation itself is finalized in the same full drain');
});

test('routing conversation turn fails fast when an explicit routing conversation id is paired with a different actor', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-turn-mismatch-mode-');
  const lm = await withRoutingLmStub(t, routingTurnLmResponder);
  const { base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_turn_actor_mismatch_001' }
  });

  const response = await fetch(`${base}/api/conversation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: opening.conversation.id,
      character_id: 'character_001',
      player_input: '今週は鍛錬する'
    })
  });

  assert.equal(response.status, 409);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'ROUTING_TURN_CONTEXT_MISMATCH');
  assert.match(body.error, /explicit routing conversation actor mismatch/);
});

test('routing conversation turn fails fast when an explicit non-routing id conflicts with the active routing hub', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-turn-id-mismatch-mode-');
  const lm = await withRoutingLmStub(t, routingTurnLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_turn_id_mismatch_active_001' }
  });
  await writeJson(slotRoot, 'game_data/logs/conversations/conv_routing_turn_id_mismatch_normal_001.json', {
    id: 'conv_routing_turn_id_mismatch_normal_001',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T05:00:00.000+09:00',
    updated_at: '2026-05-05T05:10:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    messages: [{ role: 'assistant', content: 'これは通常会話です。' }]
  });

  const response = await fetch(`${base}/api/conversation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'conv_routing_turn_id_mismatch_normal_001',
      character_id: 'lina',
      player_input: '今週は鍛錬する'
    })
  });

  assert.equal(response.status, 409);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'ROUTING_TURN_CONTEXT_MISMATCH');
  assert.match(body.error, /explicit conversation id does not match the active routing hub conversation/);
  assert.equal(lm.requests.length, 1, 'mismatched explicit id must fail before making turn LM requests');
});

test('routing conversation turn fails fast when active routing hub persistence is missing or invalid', async (t) => {
  const scenarios = [
    {
      name: 'missing file',
      prefix: 'missing-file',
      mutate: async ({ conversationPath }) => {
        await fs.rm(conversationPath);
      },
      message: /active routing hub conversation file is missing/
    },
    {
      name: 'missing routing_hub',
      prefix: 'missing-context',
      mutate: async ({ slotRoot, conversationId }) => {
        const conversation = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
        delete conversation.routing_hub;
        await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, conversation);
      },
      message: /active routing hub conversation is missing routing_hub/
    },
    {
      name: 'invalid routing_hub',
      prefix: 'invalid-context',
      mutate: async ({ slotRoot, conversationId }) => {
        const conversation = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
        conversation.routing_hub = { persona_variant: 'banana' };
        await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, conversation);
      },
      message: /active routing hub conversation has invalid routing_hub/
    },
    {
      name: 'inconsistent no-new-conversation snapshot',
      prefix: 'inconsistent-no-new-conversation',
      mutate: async ({ slotRoot, conversationId }) => {
        const conversation = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
        conversation.routing_hub.recent_conversation_context.character_id = 'character_001';
        await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, conversation);
      },
      message: /active routing hub conversation has invalid routing_hub/
    },
    {
      name: 'inconsistent no-memory snapshot',
      prefix: 'inconsistent-no-memory',
      mutate: async ({ slotRoot, conversationId }) => {
        const conversation = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
        conversation.routing_hub.recent_conversation_context = {
          kind: 'conversation_without_memory',
          conversation_id: 'conv_recent_no_memory_001',
          character_id: 'character_001',
          character_name: 'セラ・アストルーペ',
          memory_text: '矛盾した記憶'
        };
        await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, conversation);
      },
      message: /active routing hub conversation has invalid routing_hub/
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const settingsPath = await writeRoutingModeSettings(subtest, `routing-turn-${scenario.prefix}-mode-`);
      const lm = await withRoutingLmStub(subtest, routingTurnLmResponder);
      const { root, base } = await withServer(subtest, {
        playModeSettingsPath: settingsPath,
        lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
      });
      const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
      const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
      const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
        method: 'POST',
        body: { id: `conv_routing_turn_${scenario.prefix.replaceAll('-', '_')}_001` }
      });
      const conversationPath = path.join(slotRoot, `game_data/logs/conversations/${opening.conversation.id}.json`);
      await scenario.mutate({ slotRoot, conversationId: opening.conversation.id, conversationPath });

      const response = await fetch(`${base}/api/conversation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ player_input: '今週は鍛錬する' })
      });

      assert.equal(response.status, 409);
      const body = JSON.parse(await response.text());
      assert.equal(body.error_code, 'ROUTING_TURN_CONTEXT_MISMATCH');
      assert.match(body.error, scenario.message);
      assert.equal(lm.requests.length, 1, 'invalid active routing hub persistence must fail before making turn LM requests');
    });
  }
});

test('routing conversation stream emits mismatch errors without running a turn', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-stream-error-mode-');
  const lm = await withRoutingLmStub(t, routingTurnLmResponder);
  const { root, base } = await withServer(t, {
    playModeSettingsPath: settingsPath,
    lmStudioConfig: { base_url: lm.baseUrl, chat_model: 'chat-model', reflection_model: 'reflection-model', timeout_ms: 5000, stream: false }
  });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const opening = await jsonFetch(`${base}/api/routing/hub/start`, {
    method: 'POST',
    body: { id: 'conv_routing_stream_error_active_001' }
  });

  await writeJson(slotRoot, 'game_data/logs/conversations/conv_routing_stream_error_normal_001.json', {
    id: 'conv_routing_stream_error_normal_001',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T05:00:00.000+09:00',
    updated_at: '2026-05-05T05:10:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    messages: [{ role: 'assistant', content: 'これは通常会話です。' }]
  });

  const mismatch = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'conv_routing_stream_error_normal_001',
      character_id: 'lina',
      player_input: '今週は鍛錬する'
    })
  });
  assert.equal(mismatch.status, 200);
  const mismatchEvents = parseSse(await mismatch.text());
  assert.equal(mismatchEvents[0].event, 'status');
  assert.deepEqual(mismatchEvents.find((item) => item.event === 'error')?.data, {
    error: 'explicit conversation id does not match the active routing hub conversation',
    error_code: 'ROUTING_TURN_CONTEXT_MISMATCH'
  });
  assert.equal(lm.requests.length, 1, 'stream mismatch must fail before making turn LM requests');

  const conversation = await readJson(slotRoot, `game_data/logs/conversations/${opening.conversation.id}.json`);
  delete conversation.routing_hub;
  await writeJson(slotRoot, `game_data/logs/conversations/${opening.conversation.id}.json`, conversation);

  const invalidHub = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ player_input: '今週は鍛錬する' })
  });
  assert.equal(invalidHub.status, 200);
  const invalidHubEvents = parseSse(await invalidHub.text());
  const invalidHubError = invalidHubEvents.find((item) => item.event === 'error')?.data;
  assert.equal(invalidHubError.error_code, 'ROUTING_TURN_CONTEXT_MISMATCH');
  assert.match(invalidHubError.error, /active routing hub conversation is missing routing_hub/);
  assert.equal(lm.requests.length, 1, 'stream invalid active hub must fail before making turn LM requests');
});

test('LM Studio settings API normalizes localhost/lan editing, persists config, updates the live server config object, and proxies model discovery', async (t) => {
  const root = await fixtureRoot('magic-adv-server-lmstudio-settings-');
  const configPath = path.join(root, 'config/lmstudio.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let requestedModelsUrl = null;
  const lmStudioModelServer = createHttpServer((req, res) => {
    requestedModelsUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'gemma-4-27b-it', object: 'model' },
        { id: 'qwen3-32b', object: 'model' }
      ]
    }));
  });
  await new Promise((resolve) => lmStudioModelServer.listen(0, '127.0.0.1', resolve));
  const modelServerPort = lmStudioModelServer.address().port;
  const liveLmStudioConfig = {
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 120000,
    stream: true,
    mock_provider_enabled: true
  };
  await fs.writeFile(configPath, `${JSON.stringify(liveLmStudioConfig, null, 2)}\n`, 'utf8');
  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
    lmStudioConfig: liveLmStudioConfig,
    lmStudioConfigPath: configPath
  }, 'magic-adv-lm-settings-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => lmStudioModelServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const initial = await jsonFetch(`${base}/api/settings/lmstudio`);
  assert.equal(initial.connection_mode, 'localhost');
  assert.equal(initial.host, '127.0.0.1');
  assert.equal(initial.port, 1234);
  assert.equal(initial.base_url, 'http://127.0.0.1:1234/v1');
  assert.equal(initial.model, 'gemma-4-31b-it');
  assert.equal(initial.chat_model, 'gemma-4-31b-it');
  assert.equal(initial.reflection_model, 'gemma-4-31b-it');
  assert.equal(initial.thinking_effort, null);
  assert.equal(liveLmStudioConfig.thinking_effort, null, 'GET should normalize the live config object used by the running server');

  const discoveredModels = await jsonFetch(`${base}/api/settings/lmstudio/models`, {
    method: 'POST',
    body: { connection_mode: 'localhost', host: 'ignored.example', port: modelServerPort }
  });
  assert.equal(requestedModelsUrl, '/v1/models');
  assert.deepEqual(discoveredModels.models, [
    { id: 'gemma-4-27b-it', label: 'gemma-4-27b-it' },
    { id: 'qwen3-32b', label: 'qwen3-32b' }
  ]);

  const updatedLan = await jsonFetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    body: { connection_mode: 'lan', host: '192.168.11.3', port: 2244, model: 'qwen3-32b', thinking_effort: 'low' }
  });
  assert.equal(updatedLan.connection_mode, 'lan');
  assert.equal(updatedLan.host, '192.168.11.3');
  assert.equal(updatedLan.port, 2244);
  assert.equal(updatedLan.base_url, 'http://192.168.11.3:2244/v1');
  assert.equal(updatedLan.model, 'qwen3-32b');
  assert.equal(updatedLan.chat_model, 'qwen3-32b');
  assert.equal(updatedLan.reflection_model, 'qwen3-32b');
  assert.equal(updatedLan.thinking_effort, 'low');
  assert.equal(liveLmStudioConfig.base_url, 'http://192.168.11.3:2244/v1', 'PATCH should update the live config object used by the running server');
  assert.equal(liveLmStudioConfig.chat_model, 'qwen3-32b', 'PATCH should update the live chat model');
  assert.equal(liveLmStudioConfig.reflection_model, 'qwen3-32b', 'PATCH should update the live reflection model');
  assert.equal(liveLmStudioConfig.thinking_effort, 'low', 'PATCH should update the live thinking effort');
  const persistedLan = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(persistedLan.base_url, 'http://192.168.11.3:2244/v1');
  assert.equal(persistedLan.chat_model, 'qwen3-32b', 'selected model should be persisted as chat_model');
  assert.equal(persistedLan.reflection_model, 'qwen3-32b', 'selected model should be persisted as reflection_model');
  assert.equal(persistedLan.thinking_effort, 'low', 'selected thinking effort should be persisted');

  const updatedLocalhost = await jsonFetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    body: { connection_mode: 'localhost', host: 'ignored.example', port: 1235, model: 'gemma-4-27b-it', thinking_effort: null }
  });
  assert.equal(updatedLocalhost.connection_mode, 'localhost');
  assert.equal(updatedLocalhost.host, '127.0.0.1');
  assert.equal(updatedLocalhost.port, 1235);
  assert.equal(updatedLocalhost.base_url, 'http://127.0.0.1:1235/v1');
  assert.equal(updatedLocalhost.model, 'gemma-4-27b-it');
  assert.equal(updatedLocalhost.thinking_effort, null);

  const invalidPortResponse = await fetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection_mode: 'lan', host: '192.168.11.3', port: 70000, model: 'qwen3-32b' })
  });
  assert.equal(invalidPortResponse.status, 400);
  const invalidPortBody = JSON.parse(await invalidPortResponse.text());
  assert.match(invalidPortBody.error, /port/i);

  const missingHostResponse = await fetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection_mode: 'lan', host: '   ', port: 1234, model: 'qwen3-32b' })
  });
  assert.equal(missingHostResponse.status, 400);
  const missingHostBody = JSON.parse(await missingHostResponse.text());
  assert.match(missingHostBody.error, /host/i);

  const missingModelResponse = await fetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection_mode: 'localhost', port: 1234, model: '   ' })
  });
  assert.equal(missingModelResponse.status, 400);
  const missingModelBody = JSON.parse(await missingModelResponse.text());
  assert.match(missingModelBody.error, /model/i);

  const invalidThinkingEffortResponse = await fetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connection_mode: 'localhost', port: 1234, model: 'qwen3-32b', thinking_effort: 'ultra' })
  });
  assert.equal(invalidThinkingEffortResponse.status, 400);
  const invalidThinkingEffortBody = JSON.parse(await invalidThinkingEffortResponse.text());
  assert.match(invalidThinkingEffortBody.error, /thinking_effort/i);
});

test('LM Studio settings API lazy-loads config from lmStudioConfigPath when the server entrypoint does not preload it', async (t) => {
  const root = await fixtureRoot('magic-adv-lmstudio-lazy-load-');
  const configPath = path.join(root, 'runtime-config', 'lmstudio.json');
  const initialConfig = {
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:1234/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 120000,
    stream: true,
    mock_provider_enabled: true
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8');

  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
    lmStudioConfigPath: configPath
  }, 'magic-adv-lm-persist-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  const initial = await jsonFetch(`${base}/api/settings/lmstudio`);
  assert.equal(initial.base_url, 'http://127.0.0.1:1234/v1');
  assert.equal(initial.model, 'gemma-4-31b-it');
  assert.equal(initial.thinking_effort, null);

  const updated = await jsonFetch(`${base}/api/settings/lmstudio`, {
    method: 'PATCH',
    body: { connection_mode: 'lan', host: '192.168.11.3', port: 2244, model: 'qwen3-32b', thinking_effort: 'high' }
  });
  assert.equal(updated.connection_mode, 'lan');
  assert.equal(updated.base_url, 'http://192.168.11.3:2244/v1');
  assert.equal(updated.model, 'qwen3-32b');
  assert.equal(updated.thinking_effort, 'high');

  const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(persisted.base_url, 'http://192.168.11.3:2244/v1');
  assert.equal(persisted.chat_model, 'qwen3-32b');
  assert.equal(persisted.reflection_model, 'qwen3-32b');
  assert.equal(persisted.thinking_effort, 'high');
});

test('conversation opening returns a structured connection-unavailable error when LM Studio config lazy-loads but the API is unreachable', async (t) => {
  const root = await fixtureRoot('magic-adv-lmstudio-opening-lazy-load-');
  const configPath = path.join(root, 'runtime-config', 'lmstudio.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:9/v1',
    chat_model: 'gemma-4-31b-it',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 250,
    stream: false,
    mock_provider_enabled: true
  }, null, 2)}\n`, 'utf8');

  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
    lmStudioConfigPath: configPath
  }, 'magic-adv-lm-opening-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina' })
  });
  assert.equal(response.status, 503);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'LMSTUDIO_CONNECTION_UNAVAILABLE');
  assert.match(body.error ?? '', /LM Studioの接続が確認できません/);
});

test('conversation opening returns a structured config-required error when LM Studio config is unavailable', async (t) => {
  const root = await fixtureRoot('magic-adv-lmstudio-opening-config-required-');
  const configPath = path.join(root, 'runtime-config', 'missing-lmstudio.json');

  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
    lmStudioConfigPath: configPath
  }, 'magic-adv-lm-config-required-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina' })
  });
  assert.equal(response.status, 503);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
  assert.match(body.error ?? '', /LM Studio/i);
});

test('conversation opening returns a structured config-required error when LM Studio chat model is missing', async (t) => {
  const root = await fixtureRoot('magic-adv-lmstudio-opening-incomplete-config-');
  const configPath = path.join(root, 'runtime-config', 'lmstudio.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    provider: 'lmstudio',
    base_url: 'http://127.0.0.1:9/v1',
    reflection_model: 'gemma-4-31b-it',
    timeout_ms: 250,
    stream: false,
    mock_provider_enabled: true
  }, null, 2)}\n`, 'utf8');

  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
    lmStudioConfigPath: configPath
  }, 'magic-adv-lm-incomplete-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina' })
  });
  assert.equal(response.status, 503);
  const body = JSON.parse(await response.text());
  assert.equal(body.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
  assert.match(body.error ?? '', /LM Studioの設定が必要です/);
});

test('interaction start only bootstraps mutable storage for the selected character', async (t) => {
  const { root, base } = await withPrivateAuthoringServer(t);

  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'character_007', source_type: 'field' }
  });

  await fs.access(path.join(root, 'game_data/characters/character_007/profile.json'));
  await fs.access(path.join(root, 'game_data/characters/character_007/flags.json'));
  await fs.access(path.join(root, 'game_data/characters/character_007/skills.json'));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_008/flags.json')));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_008/skills.json')));
});

test('interaction start bootstraps creature mutable storage under the creature root', async (t) => {
  const { root, base } = await withServer(t);
  await fs.cp(path.join(projectRoot, 'content/creatures'), path.join(root, 'game_data/creatures'), { recursive: true });

  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'creature_001', source_type: 'field' }
  });

  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.current_interaction_character_id, 'creature_001');
  await fs.access(path.join(root, 'game_data/creatures/creature_001/profile.json'));
  await fs.access(path.join(root, 'game_data/creatures/creature_001/flags.json'));
  await fs.access(path.join(root, 'game_data/creatures/creature_001/skills.json'));
  await fs.access(path.join(root, 'game_data/creatures/creature_001/memory'));
  await fs.access(path.join(root, 'game_data/creatures/creature_001/work_records'));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/creature_001/flags.json')), { code: 'ENOENT' });
});

test('character catalog response does not materialize selectable-character mutable storage on disk', async (t) => {
  const { root, base } = await withPrivateAuthoringServer(t);

  const catalog = await jsonFetch(`${base}/api/characters`);
  assert.equal(catalog.characters.length, 172);

  await fs.access(path.join(root, 'game_data/characters/character_001/profile.json'));
  await fs.access(path.join(root, 'game_data/characters/character_050/profile.json'));
  await fs.access(path.join(root, 'game_data/characters/character_052/profile.json'));
  await fs.access(path.join(root, 'game_data/characters/character_055/profile.json'));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_001/flags.json')));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_050/flags.json')));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_052/flags.json')));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/character_055/flags.json')));
});

test('server exposes 172 v5 selectable characters and persists prompt-description edits', async (t) => {
  const { root, base } = await withPrivateAuthoringServer(t);
  const catalog = await jsonFetch(`${base}/api/characters`);
  assert.equal(catalog.characters.length, 172);
  assert.equal(catalog.characters[6].character_id, 'character_007');
  assert.match(catalog.characters[6].source_image_url, /^\/canonical\/character_visual_sets\/visual_set_007\/face_emotions\/neutral\.jpg$/);
  assert.match(catalog.characters[6].face_url, /^\/canonical\/character_visual_sets\/visual_set_007\/face_emotions\/neutral\.jpg$/);
  assert.equal(catalog.characters[20].character_id, 'character_021');
  assert.match(catalog.characters[20].source_image_url, /^\/canonical\/character_visual_sets\/visual_set_021\/face_emotions\/neutral\.jpg$/);
  assert.match(catalog.characters[20].selection_icon_url, /^\/canonical\/character_visual_sets\/visual_set_021\/face_emotions\/neutral\.jpg$/);
  assert.equal(catalog.characters[50].character_id, 'character_051');
  assert.equal(catalog.characters[51].character_id, 'character_052');
  assert.equal(catalog.characters[54].character_id, 'character_055');
  assert.match(catalog.characters[54].source_image_url, /^\/canonical\/character_visual_sets\/visual_set_055\/face_emotions\/neutral\.jpg$/);
  assert.match(catalog.characters[54].standee_url, /^\/canonical\/character_visual_sets\/visual_set_055\/scene_standee\/scene_standee_character_01\.jpg$/);

  const edited = '図書塔の鍵束を管理する、静かな観察者。プロンプト編集の反映確認用。';
  await jsonFetch(`${base}/api/characters/profile`, {
    method: 'POST',
    body: { character_id: 'character_007', prompt_description: edited }
  });
  const profile = JSON.parse(await fs.readFile(path.join(root, 'game_data/characters/character_007/profile.json'), 'utf8'));
  assert.equal(profile.prompt_description, edited);

  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'character_007', source_type: 'field' }
  });
  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=character_007&player_input=${encodeURIComponent('話せる？')}`);
  assert.match(preview.prompt, new RegExp(edited));

  const sourceImage = await fetch(`${base}${catalog.characters[6].source_image_url}`);
  assert.equal(sourceImage.status, 200);
  assert.equal(sourceImage.headers.get('content-type'), 'image/jpeg');
  const generatedFace = await fetch(`${base}${catalog.characters[6].face_url}`);
  assert.equal(generatedFace.status, 200);
  assert.equal(generatedFace.headers.get('content-type'), 'image/jpeg');
  const newestCharFace = await fetch(`${base}${catalog.characters[51].face_url}`);
  assert.equal(newestCharFace.status, 200);
  assert.equal(newestCharFace.headers.get('content-type'), 'image/jpeg');
  const newestCharStandee = await fetch(`${base}${catalog.characters[51].standee_url}`);
  assert.equal(newestCharStandee.status, 200);
  assert.equal(newestCharStandee.headers.get('content-type'), 'image/jpeg');
});

test('prompt preview does not reread selectable character storage bootstrap files after first ensure', async (t) => {
  const { base } = await withPrivateAuthoringServer(t);
  const watchedSuffixes = [
    '/game_data/characters/character_001/profile.json',
    '/game_data/characters/character_001/flags.json',
    '/game_data/characters/character_001/skills.json'
  ];
  const readCounts = new Map(watchedSuffixes.map((suffix) => [suffix, 0]));
  const originalReadFile = fs.readFile;
  fs.readFile = async function patchedReadFile(targetPath, ...args) {
    const normalized = String(targetPath).split(path.sep).join('/');
    for (const suffix of watchedSuffixes) {
      if (normalized.endsWith(suffix)) readCounts.set(suffix, readCounts.get(suffix) + 1);
    }
    return originalReadFile.call(this, targetPath, ...args);
  };
  t.after(() => {
    fs.readFile = originalReadFile;
  });

  await jsonFetch(`${base}/api/prompt-preview?character_id=character_001&player_input=${encodeURIComponent('能力を見て')}`);

  assert.equal(readCounts.get('/game_data/characters/character_001/profile.json'), 1, 'prompt preview should read profile.json only once while bootstrapping a selectable character');
  assert.equal(readCounts.get('/game_data/characters/character_001/flags.json'), 1, 'prompt preview should read flags.json only once while bootstrapping a selectable character');
  assert.equal(readCounts.get('/game_data/characters/character_001/skills.json'), 1, 'prompt preview should read skills.json only once while bootstrapping a selectable character');
});

test('server world settings expose editable player name and zero-default player parameters in prompt preview', async (t) => {
  const { base } = await withServer(t);
  const initialWorld = await jsonFetch(`${base}/api/world`);
  assert.equal(initialWorld.player_name, '主人公');
  assert.equal(initialWorld.player_parameters.magic.light.value, 0);
  assert.equal(initialWorld.player_parameters.abilities.magical_power.value, 0);

  const savedWorld = await jsonFetch(`${base}/api/world`, {
    method: 'POST',
    body: {
      player_name: 'うゆりす',
      world_description: initialWorld.world_description,
      player_parameters: {
        magic: { light: 60, dark: 4, fire: 12, water: 99, earth: 101, wind: -1 },
        abilities: { strength: 45, agility: 67, academics: 89, magical_power: 23, charisma: 10 }
      }
    }
  });
  assert.equal(savedWorld.player_name, 'うゆりす');
  assert.equal(savedWorld.player_parameters.magic.earth.value, 100);
  assert.equal(savedWorld.player_parameters.magic.wind.value, 0);
  assert.equal(savedWorld.player_parameters.abilities.academics.value, 89);

  await jsonFetch(`${base}/api/characters`);
  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=character_001&player_input=${encodeURIComponent('能力を見て')}`);
  assert.doesNotMatch(preview.prompt, /プレイヤーの名前:/);
  assert.doesNotMatch(preview.prompt, /うゆりすの発言:/);
  assert.match(preview.prompt, /プレイヤーの発言: 能力を見て/);
  assert.match(preview.prompt, /キャラクター自身のパラメーター:/);
  assert.match(preview.prompt, /プレイヤーのパラメーター:/);
  assert.match(preview.prompt, /水魔法習熟度: 99\/100/);
  assert.match(preview.prompt, /風魔法習熟度: 0\/100/);
  assert.match(preview.prompt, /学力: 89\/100/);
});

test('prompt preview resolves character speech constraints from LM Studio chat_model without leaking model metadata', async (t) => {
  const { base } = await withServer(t, {
    lmStudioConfig: {
      base_url: 'http://127.0.0.1:9/v1',
      chat_model: 'google/gemma-4-31b',
      reflection_model: 'reflection-model',
      stream: false,
      timeout_ms: 5000,
      thinking_effort: null
    }
  });

  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=lina&player_input=${encodeURIComponent('星図を見たい')}`);
  const worldIndex = preview.prompt.indexOf('ワールド設定:');
  const constraintsIndex = preview.prompt.indexOf('キャラクター発話上の禁止事項:');
  const stageIndex = preview.prompt.indexOf('舞台:');

  assert.ok(worldIndex >= 0, 'prompt preview should include world settings');
  assert.ok(constraintsIndex > worldIndex, 'prompt preview should place speech constraints after world settings');
  assert.ok(stageIndex > constraintsIndex, 'prompt preview should place speech constraints before the stage');
  assert.doesNotMatch(preview.prompt, /Gemma4|LLM固有|モデル固有|このモデル|モデルの癖|profile_id|match_models|chat_model|reflection_model|provider/);

  const mockPreview = await jsonFetch(`${base}/api/prompt-preview?provider=mock&character_id=lina&player_input=${encodeURIComponent('星図を見たい')}`);
  assert.doesNotMatch(mockPreview.prompt, /キャラクター発話上の禁止事項:/);
});

test('training catalog covers every generated card image with weekday affinities and one drawback each', () => {
  const expectedTrainingIds = [
    'artifact_appraisal',
    'barrier_weaving',
    'broom_flight',
    'earth_barrier',
    'elemental_sparring',
    'familiar_bonding',
    'flame_focus',
    'healing_practice',
    'library_study',
    'mana_control',
    'physical_drills',
    'potion_brewing',
    'ritual_research',
    'rune_calligraphy',
    'salon_practice',
    'shadow_control',
    'spirit_listening',
    'star_observation',
    'water_meditation',
    'wind_step'
  ];
  assert.deepEqual(trainingDefinitions.map((training) => training.id).sort(), expectedTrainingIds, 'training catalog should expose one action per generated card image');
  assert.equal(new Set(trainingDefinitions.map((training) => training.id)).size, trainingDefinitions.length, 'training ids should be unique');
  assert.equal(trainingDefinitions.every((training) => training.increases.length > 0), true, 'every training should report probabilistic gains');
  assert.equal(trainingDefinitions.every((training) => training.element && training.decrease?.chance === 0.5 && training.decrease?.amount === 1), true, 'every training should have an elemental weekday affinity and a 50% one-point drawback');
  assert.equal(trainingDefinitions.some((training) => training.increases.some((effect) => effect.group === 'magic')), true, 'catalog should include magic-focused training');
  assert.equal(trainingDefinitions.some((training) => training.increases.some((effect) => effect.group === 'abilities')), true, 'catalog should include ability-focused training');
});

test('training endpoint uses six weekday turns with elemental double bonus, drawbacks, and returns to academy map after Wind day', async (t) => {
  const { base } = await withServer(t);
  const before = await jsonFetch(`${base}/api/world`);
  await jsonFetch(`${base}/api/world`, {
    method: 'POST',
    body: {
      player_name: before.player_name,
      world_description: before.world_description,
      player_parameters: {
        magic: { light: 10, dark: 10, fire: 10, water: 10, earth: 10, wind: 10 },
        abilities: { strength: 10, agility: 10, academics: 10, magical_power: 10, charisma: 10 }
      }
    }
  });

  const first = await jsonFetch(`${base}/api/training/run`, {
    method: 'POST',
    body: { training_id: 'healing_practice', random_seed: 16 }
  });

  assert.equal(first.training.id, 'healing_practice');
  assert.deepEqual(first.training_day, { index: 0, id: 'light_day', name: '光曜', element: 'light', element_label: '光' });
  assert.equal(first.training_progress.actions_used, 1);
  assert.equal(first.training_progress.actions_limit, 6);
  assert.equal(first.training_progress.remaining_actions, 5);
  assert.equal(first.training_progress.completed, false);
  assert.equal(first.training_progress.next_day.name, '闇曜');
  assert.equal(first.state.current_screen, 'training');

  const light = first.effects.find((effect) => effect.group === 'magic' && effect.key === 'light');
  assert.equal(light.weekday_bonus, true, '光曜 should double the light-themed training effect');
  assert.equal(light.bonus_multiplier, 2);
  assert.equal(light.amount, 2, 'successful matching elemental gain should be doubled to +2');
  assert.equal(light.before, 10);
  assert.equal(light.after, 12);

  const magicalPower = first.effects.find((effect) => effect.group === 'abilities' && effect.key === 'magical_power');
  assert.equal(magicalPower.weekday_bonus, true, 'weekday affinity should double every positive effect in the chosen training');
  assert.equal(magicalPower.bonus_multiplier, 2);
  assert.equal(magicalPower.amount, 2);

  const drawback = first.effects.find((effect) => effect.direction === 'decrease');
  assert.equal(drawback.label, '闇魔法習熟度');
  assert.equal(drawback.chance, 0.5);
  assert.equal(drawback.amount, -1);
  assert.equal(drawback.before, 10);
  assert.equal(drawback.after, 9);

  let result = first;
  for (const [index, weekday] of ['闇曜', '火曜', '水曜', '土曜', '風曜'].entries()) {
    result = await jsonFetch(`${base}/api/training/run`, {
      method: 'POST',
      body: { training_id: 'healing_practice', random_seed: 20 + index }
    });
    assert.equal(result.training_day.name, weekday);
    assert.equal(result.training_progress.actions_used, index + 2);
  }

  assert.equal(result.training_progress.completed, true);
  assert.equal(result.training_progress.remaining_actions, 0);
  assert.equal(result.training_progress.next_day, null);
  assert.equal(result.state.current_screen, 'academy-map');
  assert.equal(result.state.training_actions_used, 0, 'academy map return should reset the next training display to 光曜 0 / 6');
  assert.equal(result.state.training_actions_limit, 6);

  const after = await jsonFetch(`${base}/api/world`);
  assert.deepEqual(after.player_parameters, result.world.player_parameters);
});

test('academy 鍛錬 screen keeps weekday progress instead of resetting to 光曜 on each action', async (t) => {
  const { root, base } = await withServer(t);
  const state = JSON.parse(await fs.readFile(path.join(root, 'game_data/runtime_state.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), `${JSON.stringify({
    ...state,
    current_screen: 'academy-training',
    training_actions_used: 2,
    training_actions_limit: 6
  }, null, 2)}\n`, 'utf8');

  const result = await jsonFetch(`${base}/api/training/run`, {
    method: 'POST',
    body: { training_id: 'healing_practice', random_seed: 16 }
  });

  assert.equal(result.training_day.name, '火曜');
  assert.equal(result.training_progress.actions_used, 3);
  assert.equal(result.training_progress.next_day.name, '水曜');
  assert.equal(result.state.current_screen, 'academy-training');
  assert.equal(result.state.training_actions_used, 3);
});

test('routing training completion returns to the hub through the post-content resolver without week increment', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-training-return-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-training',
    elapsed_weeks: 0,
    training_actions_used: 5,
    training_actions_limit: 6,
    // Routing training persists an in-progress week accumulator each day; resuming
    // mid-week requires it to be present (a missing one is corrupt state).
    routing_training_week_accumulator: {
      week: 0,
      destination_id: 'training',
      trainings: Array.from({ length: 5 }, (_, index) => ({
        day_index: index, day_name: `d${index}`, training_id: `t_${index}`, training_name: `n_${index}`
      })),
      parameter_deltas: { magic: {}, abilities: {} }
    }
  });

  const result = await jsonFetch(`${base}/api/training/run`, {
    method: 'POST',
    body: { training_id: 'healing_practice', random_seed: 16 }
  });

  assert.equal(result.training_progress.completed, true);
  assert.equal(result.state.current_screen, 'interaction');
  assert.equal(result.state.elapsed_weeks, 0, 'Stage 7a post-content return must not increment the week');
  assert.equal(result.post_content_screen, 'interaction');
});

test('routing training skip returns to the hub through the post-content resolver without week increment', async (t) => {
  const settingsPath = await writeRoutingModeSettings(t, 'routing-training-skip-return-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotRoot = path.join(root, 'game_data/play/slots', started.slot.slot_id);
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'academy-training',
    elapsed_weeks: 0,
    training_actions_used: 2,
    training_actions_limit: 6,
    // Routing training persists an in-progress week accumulator each day; a mid-week
    // skip requires it to be present (a missing one is corrupt state).
    routing_training_week_accumulator: {
      week: 0,
      destination_id: 'training',
      trainings: Array.from({ length: 2 }, (_, index) => ({
        day_index: index, day_name: `d${index}`, training_id: `t_${index}`, training_name: `n_${index}`
      })),
      parameter_deltas: { magic: {}, abilities: {} }
    }
  });

  const result = await jsonFetch(`${base}/api/training/skip`, {
    method: 'POST',
    body: {}
  });

  assert.equal(result.training_progress.completed, true);
  assert.equal(result.state.current_screen, 'interaction');
  assert.equal(result.state.elapsed_weeks, 0, 'Stage 7a post-content return must not increment the week');
  assert.equal(result.post_content_screen, 'interaction');
});

test('training skip endpoint completes the week without changing player parameters after academy week start', async (t) => {
  const { base } = await withServer(t);
  const before = await jsonFetch(`${base}/api/world`);

  const started = await jsonFetch(`${base}/api/academy/week/start`, {
    method: 'POST',
    body: {}
  });

  assert.equal(started.route, 'academy-training');
  assert.equal(started.state.current_screen, 'academy-training');

  const skipped = await jsonFetch(`${base}/api/training/skip`, {
    method: 'POST',
    body: {}
  });

  assert.equal(skipped.training.id, 'skip_training');
  assert.equal(skipped.training_progress.completed, true);
  assert.equal(skipped.training_progress.actions_used, 6);
  assert.equal(skipped.training_progress.remaining_actions, 0);
  assert.deepEqual(skipped.effects, []);
  assert.equal(skipped.state.current_screen, 'academy-map');
  assert.equal(skipped.state.training_actions_used, 0);

  const after = await jsonFetch(`${base}/api/world`);
  assert.deepEqual(after.player_parameters, before.player_parameters);
  assert.deepEqual(skipped.world.player_parameters, before.player_parameters);
});

test('gathering API collects fixed sanrin materials, keeps training actions independent, sells materials, and resets stock weekly', async (t) => {
  const { base } = await withServer(t);
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });

  const initialState = await jsonFetch(`${base}/api/state`);
  const initialGathering = await jsonFetch(`${base}/api/gathering`);
  assert.deepEqual(initialGathering.points.map((point) => point.point_id), gatheringPointContracts.map((point) => point.point_id));
  assert.deepEqual(initialGathering.points.map((point) => point.location_id), gatheringPointContracts.map((point) => point.location_id));
  for (const [index, point] of initialGathering.points.entries()) {
    const contract = gatheringPointContracts[index];
    assert.equal(point.stock.remaining, contract.stock_max);
    assert.equal(point.stock.max, contract.stock_max);
    assert.equal(point.image, contract.image);
    assert.equal(point.material.item_id, contract.item_id);
    assert.equal(point.material.quantity, 1);
    assert.equal(point.material.sell_price, contract.sell_price);
    assert.equal(point.material.icon, contract.icon);
  }

  const contract = gatheringPointContracts[0];
  const collected = await jsonFetch(`${base}/api/gathering/collect`, {
    method: 'POST',
    body: { point_id: contract.point_id }
  });
  assert.equal(collected.point.point_id, contract.point_id);
  assert.equal(collected.point.stock.remaining, contract.stock_max - 1);
  assert.equal(collected.point.image, contract.image);
  assert.equal(collected.point.material.icon, contract.icon);
  assert.deepEqual(collected.gathered_item, { item_id: contract.item_id, quantity: 1 });
  assert.equal(collected.inventory.items.find((item) => item.item_id === contract.item_id)?.quantity, 1);
  assert.equal(collected.inventory.items.find((item) => item.item_id === contract.item_id)?.sell_price, contract.sell_price);
  assert.equal(collected.inventory.items.find((item) => item.item_id === contract.item_id)?.icon, contract.icon);

  const stateAfterGathering = await jsonFetch(`${base}/api/state`);
  assert.equal(stateAfterGathering.training_actions_used, initialState.training_actions_used);
  assert.equal(stateAfterGathering.training_actions_limit, initialState.training_actions_limit);

  await jsonFetch(`${base}/api/gathering/collect`, { method: 'POST', body: { point_id: contract.point_id } });
  await jsonFetch(`${base}/api/gathering/collect`, { method: 'POST', body: { point_id: contract.point_id } });
  const emptyResponse = await fetch(`${base}/api/gathering/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ point_id: contract.point_id })
  });
  const emptyBody = await emptyResponse.json();
  assert.equal(emptyResponse.status, 400);
  assert.equal(emptyBody.error, 'gathering_stock_empty');

  const sold = await jsonFetch(`${base}/api/shop/sell`, {
    method: 'POST',
    body: { item_id: contract.item_id, quantity: 2 }
  });
  assert.equal(sold.item.item_id, contract.item_id);
  assert.equal(sold.item.sell_price, contract.sell_price);
  assert.equal(sold.item.icon, contract.icon);
  assert.equal(sold.inventory.money, contract.sell_price * 2);
  assert.equal(sold.inventory.items.find((item) => item.item_id === contract.item_id)?.quantity, 1);
  assert.equal(sold.inventory.items.find((item) => item.item_id === contract.item_id)?.icon, contract.icon);

  const startedWeek = await jsonFetch(`${base}/api/academy/week/start`, {
    method: 'POST',
    body: {}
  });
  const resetPoint = startedWeek.gathering.points.find((point) => point.point_id === contract.point_id);
  assert.equal(resetPoint.stock.remaining, contract.stock_max);
  assert.equal(startedWeek.state.training_actions_used, initialState.training_actions_used);

  const gatheringAfterWeekStart = await jsonFetch(`${base}/api/gathering`);
  assert.equal(gatheringAfterWeekStart.points.find((point) => point.point_id === contract.point_id).stock.remaining, contract.stock_max);
});

test('academy week start uses repository root as authoring source while mutating the active play slot', async (t) => {
  const root = await splitServerRoot();
  await fs.mkdir(path.join(root, 'content/characters/character_001'), { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, 'content/characters/character_001/profile.json'),
    path.join(root, 'content/characters/character_001/profile.json')
  );
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/event_flags.json'),
    path.join(root, 'data/definitions/game_data/event_flags.json')
  );
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/locations.json'),
    path.join(root, 'data/definitions/game_data/locations.json')
  );
  // Week start re-draws the fixed Sanrin creature placement, which reads this definition.
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/creature_encounters.json'),
    path.join(root, 'data/definitions/game_data/creature_encounters.json')
  );
  await writeSplitJson(root, 'data/mutable/game_data/play/slots/slot_002/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    disabled_stage_flag_judgment_flows: {},
    visited_locations: ['herbology_garden'],
    active_character_ids: [],
    last_conversation_id: null,
    characters: {},
    pending_interaction_context: null,
    training_actions_used: 0,
    training_actions_limit: 6,
    elapsed_weeks: 49,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: []
  });

  const server = createServer(await isolatedServerOptions(t, {
    root,
    publicRoot: livePublicRoot,
  }, 'magic-adv-training-api-play-mode-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const started = await jsonFetch(`${base}/api/academy/week/start`, {
    method: 'POST',
    body: {}
  });

  assert.equal(started.route, 'graduation-ending');
  assert.equal(started.character_id, 'character_001');
  assert.equal(started.state.ending_started, true);
  assert.equal(started.state.ending_completed, false);
  assert.equal(started.state.ending_character_id, 'character_001');
  assert.equal(started.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');

  const savedState = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/play/slots/slot_002/game_data/runtime_state.json'), 'utf8'));
  assert.equal(savedState.elapsed_weeks, 50);
  assert.equal(savedState.ending_character_id, 'character_001');
  assert.equal(savedState.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  await assert.rejects(fs.access(path.join(root, 'data/mutable/characters/character_001/profile.json')), { code: 'ENOENT' });
});

test('training updates player parameters without baking conditional world lore into the editable base description', async (t) => {
  const { root, base } = await withServer(t);
  const state = JSON.parse(await fs.readFile(path.join(root, 'game_data/runtime_state.json'), 'utf8'));
  state.global_flags = {
    ...state.global_flags,
    'knowledge.runaway_cleaning_golem_discussed': true,
    'event.cleaning_golem_shutdown.completed': false
  };
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'game_data/world/settings.json'), `${JSON.stringify({
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '基本説明。',
    world_condition_texts: [
      {
        id: 'knowledge.runaway_cleaning_golem_discussed.world_text',
        required_global_flags: ['knowledge.runaway_cleaning_golem_discussed'],
        excluded_global_flags: ['event.cleaning_golem_shutdown.completed'],
        text: '廊下を巡回する自動掃除ゴーレムが、命令を誤解して暴走しているらしい。'
      }
    ]
  }, null, 2)}\n`, 'utf8');

  const before = await jsonFetch(`${base}/api/world`);
  assert.equal(before.world_description_base, '基本説明。');
  assert.match(before.world_description, /自動掃除ゴーレム/);

  await jsonFetch(`${base}/api/training/run`, {
    method: 'POST',
    body: { training_id: 'healing_practice', random_seed: 16 }
  });

  const persisted = JSON.parse(await fs.readFile(path.join(root, 'game_data/world/settings.json'), 'utf8'));
  assert.equal(persisted.world_description, '基本説明。');
  assert.doesNotMatch(persisted.world_description, /自動掃除ゴーレム/);
  const after = await jsonFetch(`${base}/api/world`);
  assert.match(after.world_description, /自動掃除ゴーレム/);
  assert.notEqual(after.player_parameters.magic.light.value, before.player_parameters.magic.light.value);
});

test('prompt preview includes pending recalled work records selected after the previous reply', async (t) => {
  const { root, base } = await withServer(t);
  const pendingId = 'wr_pending_preview_recall';
  await fs.writeFile(path.join(root, 'game_data/characters/lina/work_records', `${pendingId}.md`), '# 深夜の鍵束について話した\n\nID: wr_pending_preview_recall\n\n## Summary\n\n主人公は深夜の鍵束の音が北階段から聞こえたとリナに伝え、リナはその記録を次の会話で参照する必要がある。\n', 'utf8');
  await fs.mkdir(path.join(root, 'game_data/logs/conversations'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/logs/conversations/conv_pending_preview.json'), JSON.stringify({
    id: 'conv_pending_preview',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-06T06:50:00.000+09:00',
    updated_at: '2026-05-06T06:51:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    time_slot: 'after_school',
    conversation_actor_context: null,
    pending_recalled_work_record_ids: [pendingId],
    messages: [
      { role: 'user', content: 'さっきの記録を思い出して' },
      { role: 'assistant', content: '次の発言に備えて記録を接続します。' }
    ]
  }, null, 2), 'utf8');
  const state = JSON.parse(await fs.readFile(path.join(root, 'game_data/runtime_state.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), JSON.stringify({
    ...state,
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    last_conversation_id: 'conv_pending_preview'
  }, null, 2), 'utf8');

  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=lina&player_input=${encodeURIComponent('これは検索語が合わない次発言')}`);

  assert.match(preview.prompt, /この場で参照する過去の記録:\n- wr pending preview recall/);
  assert.match(preview.prompt, /主人公は深夜の鍵束の音が北階段から聞こえた/);
});

test('prompt preview replaces the most recent memories with their matching work records like the live conversation path', async (t) => {
  const { root, base } = await withServer(t);
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  const workRecordDir = path.join(root, 'game_data/characters/lina/work_records');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(workRecordDir, { recursive: true });

  for (const index of [1, 2, 3, 4, 5]) {
    await fs.writeFile(path.join(memoryDir, `mem_preview_recent_${index}.json`), JSON.stringify({
      id: `mem_preview_recent_${index}`,
      character_id: 'lina',
      visibility: 'character_known',
      type: 'relationship_change',
      text: `PREVIEW-MEMORY-${index}`,
      source_conversation_id: `conv_preview_recent_${index}`,
      work_record_id: `wr_preview_recent_${index}`
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(workRecordDir, `wr_preview_recent_${index}.md`), `# preview recent ${index}\n\nID: wr_preview_recent_${index}\n\n## Summary\n\nPREVIEW-WORK-${index}\n`, 'utf8');
  }
  await fs.writeFile(path.join(memoryDir, 'mem_preview_recent_6_hidden.json'), JSON.stringify({
    id: 'mem_preview_recent_6_hidden',
    character_id: 'lina',
    visibility: 'hidden_story',
    type: 'relationship_change',
    text: 'PREVIEW-HIDDEN-MEMORY-6',
    source_conversation_id: 'conv_preview_recent_6',
    work_record_id: 'wr_preview_hidden_recent_6'
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workRecordDir, 'wr_preview_hidden_recent_6.md'), '# hidden preview recent 6\n\nID: wr_preview_hidden_recent_6\n\n## Summary\n\nPREVIEW-HIDDEN-WORK-6\n', 'utf8');

  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=lina&player_input=${encodeURIComponent('今日は別件だけ確認したい')}`);

  assert.match(preview.prompt, /PREVIEW-MEMORY-1/);
  assert.match(preview.prompt, /PREVIEW-MEMORY-2/);
  assert.doesNotMatch(preview.prompt, /PREVIEW-MEMORY-3/);
  assert.doesNotMatch(preview.prompt, /PREVIEW-MEMORY-4/);
  assert.doesNotMatch(preview.prompt, /PREVIEW-MEMORY-5/);
  assert.match(preview.prompt, /PREVIEW-WORK-3/);
  assert.match(preview.prompt, /PREVIEW-WORK-4/);
  assert.match(preview.prompt, /PREVIEW-WORK-5/);
  assert.doesNotMatch(preview.prompt, /PREVIEW-HIDDEN-MEMORY-6/);
  assert.doesNotMatch(preview.prompt, /PREVIEW-HIDDEN-WORK-6/);
});

test('prompt preview supports explicit routing persona and meta context', async (t) => {
  const { root, base } = await withPrivateAuthoringServer(t);
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', { ...state, elapsed_weeks: 0 });
  const profile = await readJson(root, 'game_data/characters/lina/profile.json');
  await writeJson(root, 'game_data/characters/lina/profile.json', {
    ...profile,
    parameters: {
      magic: { light: 0, dark: 0, fire: 0, water: 80, earth: 0, wind: 0 },
      abilities: {}
    }
  });
  await writeJson(root, 'game_data/characters/lina/affinity.json', {
    character_id: 'lina',
    affinity: 64,
    applied_affinity_conversation_ids: []
  });

  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=lina&routing_persona_variant=hourglass_grain&player_input=${encodeURIComponent('今週の行き先を相談したい')}`);

  assert.equal(preview.character_id, 'lina');
  assert.match(preview.prompt, /会話相手コンテキスト:\n系統知識:/);
  assert.match(preview.prompt, /水魔法の基礎。水は無から生めない/);
  assert.match(preview.prompt, /水魔法の応用。治癒と併用する水術では/);
  assert.match(preview.prompt, /主人公への好感度: 64\/100（0=強い忌避・25=同級生の標準的な距離感・50=気安い相手・70=親しい友人・90以上=特別な存在）/);
  assert.match(preview.prompt, /あなたはサラ・アワーグラスである。/);
  assert.match(preview.prompt, /くびれに引っかかった一粒/);
  assert.match(preview.prompt, /ルーティング会話メタ情報:/);
  assert.match(preview.prompt, /loop\/routing/);
  assert.match(preview.prompt, /学院マップ/);
  assert.match(preview.prompt, /鍛錬/);
  assert.match(preview.prompt, /ダンジョン/);
  assert.match(preview.prompt, /数値範囲は0〜100/);
  assert.doesNotMatch(preview.prompt, /リナ・クラウゼ/);
  assert.doesNotMatch(preview.prompt, /薬草の観察/);
});

test('prompt preview fails fast when an active conversation is missing actor-context snapshot state', async (t) => {
  const { root, base } = await withServer(t);
  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/logs/conversations/conv_preview_missing_actor_context_001.json', {
    id: 'conv_preview_missing_actor_context_001',
    character_id: 'lina',
    character_name: 'リナ・クラウゼ',
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:00:00.000+09:00',
    academy_week_number: 1,
    academy_elapsed_weeks_at_start: 0,
    source_type: 'field',
    location_id: state.current_location_id,
    time_slot: state.time_slot,
    prompt: 'legacy prompt without actor context snapshot',
    messages: [{ role: 'assistant', content: '古い会話です。' }]
  });
  await writeJson(root, 'game_data/runtime_state.json', {
    ...state,
    current_screen: 'interaction',
    current_interaction_character_id: 'lina',
    last_conversation_id: 'conv_preview_missing_actor_context_001'
  });

  const response = await fetch(`${base}/api/prompt-preview?character_id=lina&player_input=${encodeURIComponent('続けよう')}`);
  const body = await response.json();

  assert.equal(response.ok, false);
  assert.equal(response.status, 500);
  assert.match(body.error, /active conversation is missing conversation_actor_context/);
});


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

test('diary API returns all character memories in shared chronology order without capping', async (t) => {
  const { root, base } = await withServer(t);
  const memoryDir = path.join(root, 'game_data/characters/lina/memory');
  await fs.rm(memoryDir, { recursive: true, force: true });
  await fs.mkdir(memoryDir, { recursive: true });

  async function writeMemory(filename, record) {
    await fs.writeFile(path.join(memoryDir, filename), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  await writeMemory('z_no_source.json', {
    id: 'mem_conv_0000',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'no source memory',
    work_record_id: 'wr_conv_0000',
    tags: ['diary']
  });
  for (const index of Array.from({ length: 21 }, (_, itemIndex) => itemIndex + 1).filter((item) => item !== 10)) {
    const key = String(index).padStart(4, '0');
    await writeMemory(`memory_${String(99 - index).padStart(3, '0')}.json`, {
      id: `mem_out_of_file_order_${key}`,
      character_id: 'lina',
      visibility: 'character_known',
      type: 'relationship_change',
      text: `memory ${key}`,
      source_conversation_id: `conv_${key}`,
      work_record_id: `wr_conv_${key}`,
      tags: ['diary', key]
    });
  }
  await writeMemory('a_tie_first.json', {
    id: 'mem_tie_first',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'tie first',
    source_conversation_id: 'conv_0010',
    work_record_id: 'wr_conv_0010_a',
    tags: ['tie']
  });
  await writeMemory('b_tie_second.json', {
    id: 'mem_tie_second',
    character_id: 'lina',
    visibility: 'character_known',
    type: 'relationship_change',
    text: 'tie second',
    source_conversation_id: 'conv_0010',
    work_record_id: 'wr_conv_0010_b',
    tags: ['tie']
  });

  const beforeNames = (await fs.readdir(memoryDir)).sort();
  const diary = await jsonFetch(`${base}/api/diary?character_id=lina`);
  const afterNames = (await fs.readdir(memoryDir)).sort();

  assert.equal(diary.character_id, 'lina');
  assert.equal(diary.entries.length, 23);
  assert.deepEqual(afterNames, beforeNames);
  assert.deepEqual(diary.entries.map((entry) => entry.id), [
    'mem_conv_0000',
    'mem_out_of_file_order_0001',
    'mem_out_of_file_order_0002',
    'mem_out_of_file_order_0003',
    'mem_out_of_file_order_0004',
    'mem_out_of_file_order_0005',
    'mem_out_of_file_order_0006',
    'mem_out_of_file_order_0007',
    'mem_out_of_file_order_0008',
    'mem_out_of_file_order_0009',
    'mem_tie_first',
    'mem_tie_second',
    'mem_out_of_file_order_0011',
    'mem_out_of_file_order_0012',
    'mem_out_of_file_order_0013',
    'mem_out_of_file_order_0014',
    'mem_out_of_file_order_0015',
    'mem_out_of_file_order_0016',
    'mem_out_of_file_order_0017',
    'mem_out_of_file_order_0018',
    'mem_out_of_file_order_0019',
    'mem_out_of_file_order_0020',
    'mem_out_of_file_order_0021'
  ]);
  assert.deepEqual(diary.entries[0], {
    id: 'mem_conv_0000',
    type: 'relationship_change',
    text: 'no source memory',
    work_record_id: 'wr_conv_0000',
    tags: ['diary']
  });
  assert.equal(diary.entries[10].source_conversation_id, 'conv_0010');
  assert.equal(diary.entries[11].source_conversation_id, 'conv_0010');
});

test('diary API returns empty entries for an existing academy character without materializing memory', async (t) => {
  const { root, base } = await withServer(t);
  const memoryDir = path.join(root, 'game_data/characters/character_001/memory');
  await fs.rm(memoryDir, { recursive: true, force: true });

  const diary = await jsonFetch(`${base}/api/diary?character_id=character_001`);

  assert.deepEqual(diary, { character_id: 'character_001', entries: [] });
  await assert.rejects(fs.access(memoryDir), { code: 'ENOENT' });
});

test('diary API fails fast for missing, creature, and unknown character ids', async (t) => {
  const { base } = await withServer(t);

  for (const [label, url, status, code] of [
    ['missing', `${base}/api/diary`, 400, 'DIARY_CHARACTER_ID_REQUIRED'],
    ['creature', `${base}/api/diary?character_id=creature_001`, 400, 'DIARY_CHARACTER_NOT_SELECTABLE'],
    ['unknown academy character', `${base}/api/diary?character_id=character_999`, 400, 'DIARY_CHARACTER_NOT_SELECTABLE'],
    ['unknown actor', `${base}/api/diary?character_id=unknown`, 400, 'DIARY_CHARACTER_NOT_SELECTABLE']
  ]) {
    const response = await fetch(url);
    const body = await response.json();
    assert.equal(response.status, status, label);
    assert.equal(body.error_code, code, label);
    assert.match(body.error, /character_id|academy character|diary/i, label);
  }
});

test('split-root continuity status/reset stay missing-dir tolerant and do not materialize legacy game_data character continuity paths', async (t) => {
  const { root, base } = await withSplitServer(t);

  const status = await jsonFetch(`${base}/api/records/status?character_id=lina`);
  assert.equal(status.records.memory.count, 0);
  assert.equal(status.records.skills.count, 0);
  assert.equal(status.records.work_records.count, 0);
  assert.equal(status.last_finalization, null);

  const reset = await jsonFetch(`${base}/api/records/reset`, {
    method: 'POST',
    body: { character_id: 'lina', target: 'all' }
  });
  assert.deepEqual(reset.reset_targets, ['memory', 'skills', 'work_records']);
  assert.equal(reset.status.records.memory.count, 0);
  assert.equal(reset.status.records.skills.count, 0);
  assert.equal(reset.status.records.work_records.count, 0);

  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/memory')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/work_records')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/skills.json')), { code: 'ENOENT' });
});

test('split-root prompt preview reads authored profile plus mutable flags without materializing legacy continuity directories', async (t) => {
  const { root, base } = await withSplitServer(t);
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    character_id: 'lina',
    display_name: 'リナ・クラウゼ',
    school_year: '2年生',
    club: '薬草学研究会',
    identity: '星図と温室の噂話をつなげて考える少女。',
    prompt_description: '星図と温室の噂話をつなげて考える少女。',
    speaking_basis: '落ち着いた口調で、観察した事実を順序立てて話す。'
  });
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/flags.json', {
    character_id: 'lina',
    flags: {
      'knowledge.lina.player_checked_garden_label': true,
      'relationship.lina.trust': 5
    }
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'academy-room',
    current_interaction_character_id: 'lina',
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    disabled_stage_flag_judgment_flows: {},
    visited_locations: ['herbology_garden'],
    active_character_ids: ['lina'],
    last_conversation_id: null,
    characters: { lina: { flags: { 'relationship.lina.trust': 5 } } },
    pending_interaction_context: null,
    training_actions_used: 0,
    training_actions_limit: 6,
    elapsed_weeks: 0,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: []
  });

  const preview = await jsonFetch(`${base}/api/prompt-preview?character_id=lina&player_input=${encodeURIComponent('温室の札について相談したい。')}`);
  assert.equal(preview.character_id, 'lina');
  assert.match(preview.prompt, /リナ・クラウゼ/);
  assert.match(preview.prompt, /星図と温室の噂話をつなげて考える少女/);
  assert.match(preview.prompt, /温室の札について相談したい/);

  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/memory')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/work_records')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/skills.json')), { code: 'ENOENT' });
});

test('conversation end endpoint is safe when there is no active conversation or the session is already finalized', async (t) => {
  const { root, base } = await withServer(t);
  const noSession = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'character_007', provider: 'mock' }
  });
  assert.equal(noSession.skipped, true);
  assert.equal(noSession.reason, 'no_active_conversation');
  assert.equal(noSession.state.current_screen, 'academy-room');

  await jsonFetch(`${base}/api/characters`);
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'character_007', source_type: 'field' }
  });
  const opening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: 'character_007', provider: 'mock' }
  });
  const finalized = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'character_007', provider: 'mock' }
  });
  assert.equal(finalized.finalization_status, 'completed');
  assert.equal(finalized.state.current_screen, 'academy-room');
  assert.equal(finalized.conversation.id, opening.conversation.id);
  const log = JSON.parse(await fs.readFile(path.join(root, 'game_data/logs/conversations', `${opening.conversation.id}.json`), 'utf8'));
  assert.equal(log.discarded_after_work_record_id, `wr_${opening.conversation.id}`);
  const finalizedAgain = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'character_007', provider: 'mock' }
  });
  assert.equal(finalizedAgain.skipped, true);
  assert.equal(finalizedAgain.reason, 'already_finalized');
  assert.equal(finalizedAgain.conversation.id, finalized.conversation.id);
  assert.equal(finalizedAgain.state.current_screen, 'academy-room');
});

test('conversation lifecycle does not mark graduation ending complete before finalization succeeds', async () => {
  const writes = [];
  await assert.rejects(() => handleConversationLifecycleApi({
    req: { method: 'POST' },
    res: {},
    url: new URL('http://example.test/api/conversation/end'),
    context: { root: '/tmp/runtime' },
    sendJson: () => {
      throw new Error('sendJson should not be called after finalization failure');
    },
    readBody: async () => ({ character_id: 'lina', conversation_id: 'conv_grad_test' }),
    resolveRuntimeProviders: async () => ({ provider: 'mock' }),
    readJson: async (_root, relativePath) => {
      if (relativePath === 'game_data/runtime_state.json') {
        return {
          current_screen: 'interaction',
          current_interaction_character_id: 'lina',
          pending_interaction_context: { event_flag_id: 'event.graduation_ending.ready' },
          last_conversation_id: 'conv_grad_test',
          ending_started: true,
          ending_completed: false,
          ending_character_id: 'lina',
          global_flags: { 'event.graduation_ending.ready': true }
        };
      }
      throw new Error(`unexpected readJson path: ${relativePath}`);
    },
    readJsonIfExists: async (_root, relativePath) => {
      if (relativePath === 'game_data/logs/conversations/conv_grad_test.json') {
        return { id: 'conv_grad_test', character_id: 'lina' };
      }
      throw new Error(`unexpected readJsonIfExists path: ${relativePath}`);
    },
    writeJson: async (_root, relativePath, value) => {
      writes.push({ relativePath, value: structuredClone(value) });
    },
    runConversationOpening: async () => {
      throw new Error('unused');
    },
    runConversationTurn: async () => {
      throw new Error('unused');
    },
    editConversationUserMessage: async () => {
      throw new Error('unused');
    },
    runConversationFinalization: async () => {
      throw new Error('finalization_failed');
    },
    markGraduationEndingComplete: (state) => ({ ...state, ending_completed: true }),
    isGraduationEndingContext: () => true,
    activePlayMode: { mode: 'loop' }
  }), /finalization_failed/);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].relativePath, 'game_data/runtime_state.json');
  assert.equal(writes[0].value.ending_completed, false);
  assert.equal(writes[0].value.current_interaction_character_id, null);
  assert.equal(writes[0].value.pending_interaction_context, null);
});

test('conversation lifecycle skip paths do not manufacture graduation ending completion', async () => {
  const { req, res } = createLifecycleReqRes();
  const writes = [];
  let payload = null;
  await handleConversationLifecycleApi({
    req,
    res,
    url: new URL('http://example.test/api/conversation/end'),
    context: { root: '/tmp/runtime' },
    sendJson: (_res, body) => {
      payload = body;
      return body;
    },
    readBody: async () => ({ character_id: 'lina', conversation_id: 'conv_missing' }),
    resolveRuntimeProviders: async () => ({ provider: 'mock' }),
    readJson: async (_root, relativePath) => {
      if (relativePath === 'game_data/runtime_state.json') {
        return {
          current_screen: 'interaction',
          current_interaction_character_id: 'lina',
          pending_interaction_context: { event_flag_id: 'event.graduation_ending.ready' },
          last_conversation_id: 'conv_missing',
          ending_started: true,
          ending_completed: false,
          ending_character_id: 'lina',
          global_flags: { 'event.graduation_ending.ready': true }
        };
      }
      throw new Error(`unexpected readJson path: ${relativePath}`);
    },
    readJsonIfExists: async () => null,
    writeJson: async (_root, relativePath, value) => {
      writes.push({ relativePath, value: structuredClone(value) });
    },
    runConversationOpening: async () => {
      throw new Error('unused');
    },
    runConversationTurn: async () => {
      throw new Error('unused');
    },
    editConversationUserMessage: async () => {
      throw new Error('unused');
    },
    runConversationFinalization: async () => {
      throw new Error('unused');
    },
    markGraduationEndingComplete: (state) => ({ ...state, ending_completed: true }),
    isGraduationEndingContext: () => true,
    activePlayMode: { mode: 'loop' }
  });

  assert.equal(payload.skipped, true);
  assert.equal(payload.reason, 'no_active_conversation');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.ending_completed, false);
  assert.equal(writes[0].value.current_interaction_character_id, null);
  assert.equal(writes[0].value.pending_interaction_context, null);
});

test('conversation lifecycle delegates graduation completion into finalization instead of writing it afterward', async () => {
  const { req, res } = createLifecycleReqRes();
  const writes = [];
  let payload = null;
  let finalizationArgs = null;
  await handleConversationLifecycleApi({
    req,
    res,
    url: new URL('http://example.test/api/conversation/end'),
    context: { root: '/tmp/runtime' },
    sendJson: (_res, body) => {
      payload = body;
      return body;
    },
    readBody: async () => ({ character_id: 'lina', conversation_id: 'conv_grad_success' }),
    resolveRuntimeProviders: async () => ({ provider: 'mock' }),
    readJson: async (_root, relativePath) => {
      if (relativePath === 'game_data/runtime_state.json') {
        return {
          current_screen: 'interaction',
          current_interaction_character_id: 'lina',
          pending_interaction_context: { event_flag_id: 'event.graduation_ending.ready' },
          last_conversation_id: 'conv_grad_success',
          ending_started: true,
          ending_completed: false,
          ending_character_id: 'lina',
          global_flags: { 'event.graduation_ending.ready': true }
        };
      }
      throw new Error(`unexpected readJson path: ${relativePath}`);
    },
    readJsonIfExists: async (_root, relativePath) => {
      if (relativePath === 'game_data/logs/conversations/conv_grad_success.json') {
        return { id: 'conv_grad_success', character_id: 'lina' };
      }
      throw new Error(`unexpected readJsonIfExists path: ${relativePath}`);
    },
    writeJson: async (_root, relativePath, value) => {
      writes.push({ relativePath, value: structuredClone(value) });
    },
    runConversationOpening: async () => {
      throw new Error('unused');
    },
    runConversationTurn: async () => {
      throw new Error('unused');
    },
    editConversationUserMessage: async () => {
      throw new Error('unused');
    },
    runConversationFinalization: async (args) => {
      finalizationArgs = args;
      return {
        conversation: { id: 'conv_grad_success', character_id: 'lina', discarded_after_work_record_id: 'wr_conv_grad_success' },
        state: {
          current_screen: 'title',
          current_interaction_character_id: null,
          pending_interaction_context: null,
          ending_started: true,
          ending_completed: true,
          ending_character_id: 'lina',
          global_flags: {
            'event.graduation_ending.ready': true,
            'event.graduation_ending.completed': true
          }
        }
      };
    },
    markGraduationEndingComplete: (state) => ({
      ...state,
      ending_completed: true,
      current_screen: 'title',
      global_flags: {
        ...(state.global_flags ?? {}),
        'event.graduation_ending.completed': true
      }
    }),
    isGraduationEndingContext: () => true,
    activePlayMode: { mode: 'loop' }
  });

  assert.equal(typeof finalizationArgs?.finalStateTransform, 'function');
  assert.equal(finalizationArgs.finalStateTransform({
    current_screen: 'academy-room',
    ending_started: true,
    ending_completed: false,
    global_flags: { 'event.graduation_ending.ready': true }
  }).ending_completed, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].relativePath, 'game_data/runtime_state.json');
  assert.equal(writes[0].value.ending_completed, false);
  assert.equal(payload.finalization_status, 'completed');
  assert.equal(payload.state.ending_completed, true);
  assert.equal(payload.state.current_screen, 'title');
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

test('server exposes generated background files and field locations for every background manifest entry', async (t) => {
  const { base } = await withServer(t);
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const field = await jsonFetch(`${base}/api/field`);
  const manifest = await jsonFetch(`${base}/generated/backgrounds/manifest.json`);

  for (const background of manifest.backgrounds) {
    assert.equal(field.locations.some((location) => location.background_manifest_id === background.id), true, background.id);
  }
  const cafeteria = field.locations.find((location) => location.background_manifest_id === 'student_cafeteria_magic_lamps');
  assert.equal(cafeteria.id, 'student_cafeteria_magic_lamps');
  assert.equal(cafeteria.display_name, '学生食堂');
  assert.equal(cafeteria.background_url, '/canonical/backgrounds/background_012.jpg');

  const generatedBackground = await fetch(`${base}${cafeteria.background_url}`);
  assert.equal(generatedBackground.status, 200);
  assert.equal(generatedBackground.headers.get('content-type'), 'image/jpeg');
});

test('canonical locations define explicit academy and sanrin regions', async () => {
  const locations = await readJson(projectRoot, 'data/definitions/game_data/locations.json');
  const academyLocations = locations.filter((location) => location.region === 'academy');
  const sanrinLocations = locations.filter((location) => location.region === 'sanrin');

  assert.equal(locations.length, 37);
  assert.equal(locations.every((location) => typeof location.region === 'string'), true);
  assert.equal(academyLocations.length, 33);
  assert.equal(academyLocations.filter((location) => !location.screen || location.screen === 'field').length, 30);
  assert.deepEqual(sanrinLocations.map((location) => location.id), sanrinLocationContracts.map((location) => location.id));

  for (const [index, location] of sanrinLocations.entries()) {
    const contract = sanrinLocationContracts[index];
    assert.equal(location.screen, 'field');
    assert.equal(location.display_name, contract.display_name);
    assert.equal(location.background_manifest_id, contract.background_manifest_id);
    assert.equal(location.background_url, contract.background_url);
    assert.equal(location.background_source_image_url, contract.background_url);
    assert.equal(location.visible_situation_variants?.[0], location.visible_situation);
    for (const text of [location.visible_situation, ...(location.visible_situation_variants ?? [])]) {
      assert.doesNotMatch(text, /誰|持ち主|気配|らしい|溜め息|温もり|温み|余韻|余熱|名残|見当たらない|立ち去|席を外|願かけ/);
    }
  }
});

test('field API exposes Sanrin regions and derives the fixed-placement creature for the current location', async (t) => {
  const { root, base } = await withServer(t);
  await seedCreatureProfiles(root);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const field = await jsonFetch(`${base}/api/field`);

  assert.equal(field.current_location.region, 'academy');
  assert.equal(field.locations.every((location) => typeof location.region === 'string'), true);
  assert.equal(field.locations.filter((location) => location.region === 'academy').length, 30);
  const sanrinLocations = field.locations.filter((location) => location.region === 'sanrin');
  assert.deepEqual(sanrinLocations.map((location) => location.id), sanrinLocationContracts.map((location) => location.id));
  assert.deepEqual(sanrinLocations.map((location) => location.background_url), sanrinLocationContracts.map((location) => location.background_url));

  // Every Sanrin location is fixed (full coverage); pin stream_bank for a deterministic summary.
  await writeActiveSlotRuntimeState(root, started.slot.slot_id, {
    ...started.state,
    sanrin_creature_placements: {
      sanrin_trailhead: 'creature_001',
      sanrin_conifer_forest: 'creature_001',
      sanrin_stream_bank: 'creature_003',
      sanrin_mossy_shrine: 'creature_001'
    }
  });

  // Moving no longer rolls an encounter; the move response carries no creature_encounter.
  const moved = await jsonFetch(`${base}/api/field/move`, {
    method: 'POST',
    body: { location_id: 'sanrin_stream_bank' }
  });
  assert.equal(moved.location.id, 'sanrin_stream_bank');
  assert.equal(moved.location.region, 'sanrin');
  assert.equal(moved.state.current_location_id, 'sanrin_stream_bank');
  assert.equal(Object.hasOwn(moved.state, 'creature_encounter'), false);

  // GET /api/field derives the fixed-placement creature for the current location, with summary.
  const afterMoveField = await jsonFetch(`${base}/api/field`);
  assert.equal(afterMoveField.current_location.id, 'sanrin_stream_bank');
  assert.equal(afterMoveField.current_location.region, 'sanrin');
  assert.deepEqual(afterMoveField.state.creature_encounter, {
    location_id: 'sanrin_stream_bank',
    creature_id: 'creature_003',
    status: 'available',
    creature_summary: {
      creature_id: 'creature_003',
      display_name: '淵主',
      kind: 'monster',
      kind_label: '魔物',
      parameter_attitude_type: CREATURE_003_PARAMETER_ATTITUDE_TYPE,
      parameters: CREATURE_003_PARAMETERS,
      visual_set_id: 'creature_003',
      face_url: '/canonical/character_visual_sets/creature_003/face_emotions/neutral.jpg',
      standee_url: '/canonical/character_visual_sets/creature_003/scene_standee/scene_standee_character_01.jpg'
    }
  });
});

test('field API embeds catalog creature_summary for the current location fixed placement', async (t) => {
  const { root, base } = await withServer(t);
  await seedCreatureProfiles(root);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await writeActiveSlotRuntimeState(root, started.slot.slot_id, {
    ...started.state,
    current_location_id: 'sanrin_stream_bank',
    current_screen: 'field',
    sanrin_creature_placements: {
      sanrin_trailhead: 'creature_001',
      sanrin_conifer_forest: 'creature_001',
      sanrin_stream_bank: 'creature_003',
      sanrin_mossy_shrine: 'creature_001'
    }
  });

  const field = await jsonFetch(`${base}/api/field`);

  assert.deepEqual(field.state.creature_encounter, {
    location_id: 'sanrin_stream_bank',
    creature_id: 'creature_003',
    status: 'available',
    creature_summary: {
      creature_id: 'creature_003',
      display_name: '淵主',
      kind: 'monster',
      kind_label: '魔物',
      parameter_attitude_type: CREATURE_003_PARAMETER_ATTITUDE_TYPE,
      parameters: CREATURE_003_PARAMETERS,
      visual_set_id: 'creature_003',
      face_url: '/canonical/character_visual_sets/creature_003/face_emotions/neutral.jpg',
      standee_url: '/canonical/character_visual_sets/creature_003/scene_standee/scene_standee_character_01.jpg'
    }
  });
  // The derived encounter (and its summary) is field-response only; persisted state keeps
  // raw placement ids and never a creature_encounter / creature_summary.
  const persisted = await readJson(root, `game_data/play/slots/${started.slot.slot_id}/game_data/runtime_state.json`);
  assert.equal(Object.hasOwn(persisted, 'creature_encounter'), false);
  assert.equal(persisted.sanrin_creature_placements.sanrin_stream_bank, 'creature_003');
});

test('creatures API lists the full roster in the encounter-summary shape without an active slot', async (t) => {
  const { root, base } = await withServer(t);
  await seedCreatureProfiles(root);

  // No new-game / active slot: the full creature roster is authoring-canonical.
  const response = await jsonFetch(`${base}/api/creatures`);
  assert.equal(Array.isArray(response.creatures), true);
  assert.equal(response.creatures.length, 15);

  // Every entry carries the same creature_id-keyed shape the field payload's creature_summary uses,
  // so the client reuses creatureCandidateFromSummary without inventing values.
  for (const creature of response.creatures) {
    assert.deepEqual(Object.keys(creature).sort(), [
      'creature_id', 'display_name', 'face_url', 'kind', 'kind_label',
      'parameter_attitude_type', 'parameters', 'standee_url', 'visual_set_id'
    ]);
    assert.match(creature.creature_id, /^creature_\d{3}$/);
  }
  const byId = Object.fromEntries(response.creatures.map((creature) => [creature.creature_id, creature]));
  assert.equal(byId.creature_003.display_name, '淵主');
  assert.equal(byId.creature_003.parameter_attitude_type, CREATURE_003_PARAMETER_ATTITUDE_TYPE);
  assert.deepEqual(byId.creature_003.parameters, CREATURE_003_PARAMETERS);
  assert.equal(byId.creature_003.face_url, '/canonical/character_visual_sets/creature_003/face_emotions/neutral.jpg');
});

test('field API has no creature encounter at a non-Sanrin (academy) current location', async (t) => {
  const { root, base } = await withServer(t);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  // The opening location is an academy stage; only Sanrin locations carry a fixed creature.
  assert.equal(started.state.current_location_id, 'herbology_garden');

  const field = await jsonFetch(`${base}/api/field`);

  assert.equal(field.current_location.region, 'academy');
  assert.equal(Object.hasOwn(field.state, 'creature_encounter'), false);
});

test('field API fails fast when the current location fixed placement creature has no catalog profile', async (t) => {
  const { root, base } = await withServer(t);
  // Creature profiles are intentionally not seeded here, so a valid placement id still
  // fails fast at the catalog lookup rather than being silently dropped.
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await writeActiveSlotRuntimeState(root, started.slot.slot_id, {
    ...started.state,
    current_location_id: 'sanrin_stream_bank',
    current_screen: 'field',
    sanrin_creature_placements: {
      sanrin_trailhead: 'creature_001',
      sanrin_conifer_forest: 'creature_001',
      sanrin_stream_bank: 'creature_001',
      sanrin_mossy_shrine: 'creature_001'
    }
  });

  const response = await fetch(`${base}/api/field`);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /missing creature profile: creature_001/);
});

test('field API strips legacy persisted creature_encounter and moveToLocation clears it (no stale trace)', async (t) => {
  const { root, base } = await withServer(t);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  // A slot carrying legacy per-move encounter data alongside the new fixed placement.
  await writeActiveSlotRuntimeState(root, started.slot.slot_id, {
    ...started.state,
    current_location_id: 'herbology_garden',
    current_screen: 'field',
    sanrin_creature_placements: {
      sanrin_trailhead: 'creature_001',
      sanrin_conifer_forest: 'creature_001',
      sanrin_stream_bank: 'creature_001',
      sanrin_mossy_shrine: 'creature_001'
    },
    creature_encounter: { location_id: 'sanrin_stream_bank', creature_id: 'creature_003', status: 'available' }
  });

  // The field response derives from the fixed placement alone and drops the legacy encounter.
  const field = await jsonFetch(`${base}/api/field`);
  assert.equal(field.current_location.region, 'academy');
  assert.equal(Object.hasOwn(field.state, 'creature_encounter'), false);

  // Moving clears the legacy field from the persisted state.
  await jsonFetch(`${base}/api/field/move`, { method: 'POST', body: { location_id: 'sanrin_trailhead' } });
  const persisted = await readJson(root, `game_data/play/slots/${started.slot.slot_id}/game_data/runtime_state.json`);
  assert.equal(Object.hasOwn(persisted, 'creature_encounter'), false);
});

test('field API fixes the Sanrin creature placement on open (ensure-if-unassigned) and keeps it fixed', async (t) => {
  const { root, base } = await withServer(t);
  await seedCreatureProfiles(root);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  // A new game does not pre-draw placements; opening the field/map is the ensure trigger.
  assert.equal(Object.hasOwn(started.state, 'sanrin_creature_placements'), false);

  await jsonFetch(`${base}/api/field`);
  const persisted = await readJson(root, `game_data/play/slots/${started.slot.slot_id}/game_data/runtime_state.json`);
  const placements = persisted.sanrin_creature_placements;
  // Opening fixed one creature for every configured Sanrin location (prob=1 => all placed).
  assert.equal(placements && typeof placements === 'object' && !Array.isArray(placements), true);
  assert.equal(Object.keys(placements).length > 0, true);
  for (const [locationId, creatureId] of Object.entries(placements)) {
    assert.match(locationId, /^sanrin_/);
    assert.match(creatureId, /^creature_\d{3}$/);
  }

  // Re-opening keeps the same fixed placement (ensure does not re-draw without force).
  await jsonFetch(`${base}/api/field`);
  const persistedAgain = await readJson(root, `game_data/play/slots/${started.slot.slot_id}/game_data/runtime_state.json`);
  assert.deepEqual(persistedAgain.sanrin_creature_placements, placements);
});

test('field API fails fast on a present but malformed Sanrin placement (no silent redraw or suppression)', async (t) => {
  const { root, base } = await withServer(t);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await writeActiveSlotRuntimeState(root, started.slot.slot_id, {
    ...started.state,
    sanrin_creature_placements: ['creature_001']
  });

  const response = await fetch(`${base}/api/field`);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error, /sanrin_creature_placements/);
});

test('week start fails fast on a present but corrupted Sanrin placement before advancing the week', async (t) => {
  const { root, base } = await withServer(t);
  const started = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  await writeActiveSlotRuntimeState(root, started.slot.slot_id, {
    ...started.state,
    sanrin_creature_placements: ['creature_001']
  });

  const response = await fetch(`${base}/api/academy/week/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.match(body.error, /sanrin_creature_placements/);

  // The weekly reroll fails fast before the week is advanced (no half-applied week, no overwrite).
  const persisted = await readJson(root, `game_data/play/slots/${started.slot.slot_id}/game_data/runtime_state.json`);
  assert.equal(persisted.elapsed_weeks, started.state.elapsed_weeks ?? 0);
  assert.deepEqual(persisted.sanrin_creature_placements, ['creature_001']);
});

test('server exposes generated field backgrounds through repo-local canonical assets', async (t) => {
  const { base } = await withServer(t);
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const field = await jsonFetch(`${base}/api/field`);
  const location = field.locations.find((item) => item.id === 'herbology_garden');
  assert.equal(location.background_manifest_id, 'herbology_greenhouse');
  assert.match(location.background_url, /\/canonical\/backgrounds\/background_006\.jpg$/);
  assert.equal(location.background_source_image_url, location.background_url);

  for (const assetPath of [
    location.background_url,
    location.background_source_image_url
  ]) {
    const response = await fetch(`${base}${assetPath}`);
    assert.equal(response.status, 200, assetPath);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
  }
});

test('server exposes live character and location render contracts through canonical-backed assets', async (t) => {
  const { base } = await withServer(t);
  const catalog = await jsonFetch(`${base}/api/characters`);
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const field = await jsonFetch(`${base}/api/field`);

  const character = catalog.characters.find((entry) => entry.standee_url && entry.face_url && entry.selection_icon_url);
  assert.ok(character, 'playable character catalog should include at least one fully renderable character');
  assert.match(character.standee_url, /^\/canonical\/character_visual_sets\/.+\/(?:standees|scene_standee)\//);
  assert.match(character.face_url, /^\/canonical\/character_visual_sets\/.+\/face_emotions\/.*\.jpg$/);
  assert.match(character.selection_icon_url, /^\/canonical\/character_visual_sets\/.+\/face_emotions\/.*\.jpg$/);

  const currentLocation = field.locations.find((location) => location.id === field.state.current_location_id);
  assert.ok(currentLocation, 'field API should include the current location detail inside locations');
  assert.equal(typeof currentLocation.display_name, 'string');
  assert.ok(currentLocation.display_name.length > 0);
  assert.match(currentLocation.visible_situation, /薬草|温室/);
  assert.match(currentLocation.background_url, /\/canonical\/backgrounds\/.*\.(?:jpg|png)$/);

  for (const assetPath of [character.standee_url, character.face_url, character.selection_icon_url, currentLocation.background_url]) {
    const response = await fetch(`${base}${assetPath}`);
    assert.equal(response.status, 200, assetPath);
    assert.equal(response.headers.get('content-type'), expectedImageContentType(assetPath));
  }
});

test('server creates LLM-generated opening utterance and resets continuity records by target', async (t) => {
  const { root, base } = await withServer(t);
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'lina', source_type: 'field' }
  });
  const opening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });
  assert.equal(opening.conversation.messages.length, 1);
  assert.equal(opening.conversation.messages[0].role, 'assistant');
  assert.doesNotMatch(opening.conversation.messages[0].content, /この葉、普通の病気ではなさそうです/);
  assert.equal(opening.state.current_screen, 'interaction');

  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });
  assert.equal(ending.finalization_status, 'completed');
  assert.equal(ending.state.current_screen, 'academy-room');
  await fs.access(path.join(root, 'game_data/characters/lina/work_records', `wr_${opening.conversation.id}.md`));

  const reset = await jsonFetch(`${base}/api/records/reset`, {
    method: 'POST',
    body: { character_id: 'lina', target: 'all' }
  });
  assert.deepEqual(reset.reset_targets, ['memory', 'skills', 'work_records']);
  assert.equal((await fs.readdir(path.join(root, 'game_data/characters/lina/work_records'))).length, 0);
  const skills = JSON.parse(await fs.readFile(path.join(root, 'game_data/characters/lina/skills.json'), 'utf8'));
  assert.equal(skills.skills.some((skill) => skill.type === 'self_change'), false);
});

function parseSse(text) {
  return text.trim().split('\n\n').filter(Boolean).map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test('default ordinary academy conversation stays non-routing across non-stream and stream sends', async (t) => {
  const { base } = await withServer(t);
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'lina', source_type: 'field' }
  });

  const first = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { character_id: 'lina', player_input: '温室の様子を聞きたい', provider: 'mock' }
  });
  assert.equal(Object.hasOwn(first.conversation, 'routing_hub'), false);
  assert.equal(Object.hasOwn(first, 'routing_destination'), false);
  assert.equal(Object.hasOwn(first, 'routing_dispatch'), false);
  assert.equal(Object.hasOwn(first, 'week_progression'), false);
  assert.equal(Object.hasOwn(first, 'finalization_status'), false);
  assert.match(first.conversation.prompt, /舞台: 薬草温室/);
  assert.doesNotMatch(first.conversation.prompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(first.conversation.prompt, /ルミ/);

  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', player_input: 'もう少し続けるね', provider: 'mock' })
  });
  assert.equal(streamed.status, 200);
  const events = parseSse(await streamed.text());
  const result = events.find((item) => item.event === 'result')?.data;
  assert.equal(result.conversation.id, first.conversation.id);
  assert.equal(Object.hasOwn(result.conversation, 'routing_hub'), false);
  assert.equal(Object.hasOwn(result, 'routing_destination'), false);
  assert.equal(Object.hasOwn(result, 'routing_dispatch'), false);
  assert.equal(Object.hasOwn(result, 'week_progression'), false);
  assert.equal(Object.hasOwn(result, 'finalization_status'), false);
  assert.match(result.conversation.prompt, /舞台: 薬草温室/);
  assert.doesNotMatch(result.conversation.prompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(result.conversation.prompt, /ルミ/);
});

test('loop mode keeps one active conversation across non-stream and stream sends without routing fields', async (t) => {
  const settingsPath = await writeLoopModeSettings(t, 'loop-turn-non-routing-mode-');
  const { root, base } = await withServer(t, { playModeSettingsPath: settingsPath });
  assert.deepEqual(await jsonFetch(`${base}/api/settings/play-mode`), { mode: 'loop' });
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'lina', source_type: 'field' }
  });

  const first = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { character_id: 'lina', player_input: '最初の発言だよ', provider: 'mock' }
  });
  assert.equal(Object.hasOwn(first.conversation, 'routing_hub'), false);
  assert.equal(Object.hasOwn(first, 'routing_destination'), false);
  assert.equal(Object.hasOwn(first, 'routing_dispatch'), false);
  assert.equal(Object.hasOwn(first, 'week_progression'), false);
  assert.equal(Object.hasOwn(first, 'finalization_status'), false);
  assert.match(first.conversation.prompt, /舞台: 薬草温室/);
  assert.doesNotMatch(first.conversation.prompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(first.conversation.prompt, /ルミ/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { character_id: 'lina', player_input: 'さっきの続きで聞くね', provider: 'mock' }
  });

  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(second.conversation.messages.length, 4);
  assert.deepEqual(second.conversation.messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(Object.hasOwn(second.conversation, 'routing_hub'), false);
  assert.equal(Object.hasOwn(second, 'routing_destination'), false);
  assert.equal(Object.hasOwn(second, 'routing_dispatch'), false);
  assert.equal(Object.hasOwn(second, 'week_progression'), false);
  assert.equal(Object.hasOwn(second, 'finalization_status'), false);
  const secondLog = JSON.parse(await fs.readFile(path.join(root, 'game_data/logs/conversations', `${first.conversation.id}.json`), 'utf8'));
  assert.match(secondLog.prompt, /直前までの会話:/);
  assert.match(secondLog.prompt, /プレイヤー: 最初の発言だよ/);
  assert.match(secondLog.prompt, /リナ・クラウゼ: ……はい。今の話を手がかりに/);
  assert.match(secondLog.prompt, /舞台: 薬草温室/);
  assert.doesNotMatch(secondLog.prompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(secondLog.prompt, /ルミ/);

  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 'lina', player_input: 'さらに続けるね', provider: 'mock' })
  });
  assert.equal(streamed.status, 200);
  const events = parseSse(await streamed.text());
  const result = events.find((item) => item.event === 'result')?.data;
  assert.equal(result.conversation.id, first.conversation.id);
  assert.equal(result.conversation.messages.length, 6);
  assert.equal(result.conversation.messages.at(-2).content, 'さらに続けるね');
  assert.equal(Object.hasOwn(result.conversation, 'routing_hub'), false);
  assert.equal(Object.hasOwn(result, 'routing_destination'), false);
  assert.equal(Object.hasOwn(result, 'routing_dispatch'), false);
  assert.equal(Object.hasOwn(result, 'week_progression'), false);
  assert.equal(Object.hasOwn(result, 'finalization_status'), false);
  assert.match(result.conversation.prompt, /舞台: 薬草温室/);
  assert.doesNotMatch(result.conversation.prompt, /ルーティング会話メタ情報:/);
  assert.doesNotMatch(result.conversation.prompt, /ルミ/);
});

test('server starts a distinct opening conversation after leaving and re-entering interaction', async (t) => {
  const { base } = await withServer(t);
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'lina', source_type: 'field' }
  });
  const firstOpening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });
  await jsonFetch(`${base}/api/field/move`, {
    method: 'POST',
    body: { location_id: 'old_corridor' }
  }).catch(() => null);
  await jsonFetch(`${base}/api/interaction/start`, {
    method: 'POST',
    body: { character_id: 'lina', source_type: 'field' }
  });
  const secondOpening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });

  assert.notEqual(secondOpening.conversation.id, firstOpening.conversation.id);
  assert.equal(secondOpening.conversation.messages.length, 1);
  assert.equal(secondOpening.conversation.messages[0].role, 'assistant');
});

test('server POST endpoints run conversation, ignore deprecated event files, and save/load against the selected runtime root', async (t) => {
  const { root, base } = await withServer(t);

  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: { character_id: 'lina', player_input: '棚札の順番を一緒に調べよう', provider: 'mock' }
  });
  assert.equal(turn.conversation.character_id, 'lina');
  assert.equal(turn.state.last_conversation_id, turn.conversation.id);
  assert.equal(turn.state.current_screen, 'interaction');
  assert.equal(turn.state.current_interaction_character_id, 'lina');
  assert.equal(turn.validator, undefined);
  await fs.access(path.join(root, 'game_data/logs/conversations', `${turn.conversation.id}.json`));
  await assert.rejects(fs.access(path.join(root, 'game_data/characters/lina/work_records', `wr_${turn.conversation.id}.md`)));

  const finalizedTurn = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: 'lina', provider: 'mock' }
  });
  assert.equal(finalizedTurn.conversation.id, turn.conversation.id);
  assert.equal(finalizedTurn.finalization_status, 'completed');
  assert.equal(finalizedTurn.state.current_screen, 'academy-room');
  await waitFor(async () => fs.access(path.join(root, 'game_data/characters/lina/work_records', `wr_${turn.conversation.id}.md`)));
  const validator = JSON.parse(await fs.readFile(path.join(root, 'game_data/logs/validator', `${turn.conversation.id}.json`), 'utf8'));
  assert.equal(validator.accepted_memory.length, 1);

  const saved = await jsonFetch(`${base}/api/save`, {
    method: 'POST',
    body: { slot_id: 'slot_api_1', label: 'API smoke slot' }
  });
  assert.equal(saved.slot_id, 'slot_api_1');
  const slots = await jsonFetch(`${base}/api/save-slots`);
  assert.deepEqual(slots.map((slot) => slot.slot_id), ['slot_api_1']);

  await fs.mkdir(path.join(root, 'game_data/events'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'game_data/events/evt_field_arrival_test.json'),
    `${JSON.stringify({
      id: 'evt_field_arrival_test',
      title: 'Deprecated field arrival test',
      location_id: 'old_corridor',
      time_slots: ['after_school'],
      priority: 60,
      screen: 'event',
      trigger: { all: [{ flag: 'story.archive_intro_done', op: 'eq', value: false }] },
      effects_on_complete: []
    }, null, 2)}\n`,
    'utf8'
  );
  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const moved = await jsonFetch(`${base}/api/field/move`, {
    method: 'POST',
    body: { location_id: 'old_corridor' }
  });
  assert.equal(moved.location.id, 'old_corridor');
  assert.equal(moved.state.current_location_id, 'old_corridor');
  assert.equal(moved.state.current_screen, 'field');
  assert.deepEqual(moved.state.visited_locations.slice(0, 2), ['herbology_garden', 'old_corridor']);
  assert.equal(new Set(moved.state.visited_locations).size, moved.state.visited_locations.length);

  const afterMoveField = await jsonFetch(`${base}/api/field`);
  assert.equal(afterMoveField.state.current_location_id, 'old_corridor');

  const obsoleteEndpoint = await fetch(`${base}/api/events/complete`, { method: 'POST' });
  assert.equal(obsoleteEndpoint.status, 404);

  const fieldCandidates = await jsonFetch(`${base}/api/field`);
  assert.equal(fieldCandidates.locations.length, 34);
  assert.equal(fieldCandidates.locations.some((location) => location.id === 'sealed_ritual_room'), true);
  assert.equal(fieldCandidates.locations.some((location) => location.background_manifest_id === 'front_gate_morning'), true);
  assert.equal(fieldCandidates.locations.filter((location) => location.region === 'academy').length, 30);
  assert.deepEqual(
    fieldCandidates.locations.filter((location) => location.region === 'sanrin').map((location) => location.id),
    sanrinLocationContracts.map((location) => location.id)
  );
  assert.equal(fieldCandidates.locations.flatMap((location) => location.hotspots ?? []).some((hotspot) => hotspot.target?.startsWith('event:')), false);
  assert.equal(fieldCandidates.locations.flatMap((location) => location.hotspots ?? []).some((hotspot) => hotspot.target?.startsWith('interaction:')), false);

  const directStageMove = await jsonFetch(`${base}/api/field/move`, {
    method: 'POST',
    body: { location_id: 'astronomy_tower_observatory' }
  });
  assert.equal(directStageMove.location.id, 'astronomy_tower_observatory');
  assert.equal(directStageMove.state.current_screen, 'field');

  const loaded = await jsonFetch(`${base}/api/slots/load`, {
    method: 'POST',
    body: { slot_id: 'slot_api_1' }
  });
  assert.equal(loaded.runtime_state.global_flags['story.archive_intro_done'], false);
});

test('slot load keeps character continuity isolated per slot and lands on the routing hub', async (t) => {
  const { root, base } = await withServer(t);

  const first = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotA = first.slot.slot_id;
  await fs.mkdir(path.join(root, 'game_data/play/slots', slotA, 'game_data/characters/lina/memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'game_data/play/slots', slotA, 'game_data/characters/lina/work_records'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots', slotA, 'game_data/characters/lina/memory', 'slot-a-memory.json'), `${JSON.stringify({ id: 'slot-a-memory', text: 'slot A only' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'game_data/play/slots', slotA, 'game_data/characters/lina/skills.json'), `${JSON.stringify({ character_id: 'lina', skills: [{ id: 'slot_a_skill', type: 'self_change', description: 'slot A skill' }] }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'game_data/play/slots', slotA, 'game_data/characters/lina/work_records', 'wr_slot_a.md'), '# slot A work record\n', 'utf8');

  const second = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const slotB = second.slot.slot_id;
  assert.notEqual(slotB, slotA);

  const slotBMemoryEntries = await fs.readdir(path.join(root, 'game_data/play/slots', slotB, 'game_data/characters/lina/memory'));
  assert.deepEqual(slotBMemoryEntries, []);
  const slotBSkills = JSON.parse(await fs.readFile(path.join(root, 'game_data/play/slots', slotB, 'game_data/characters/lina/skills.json'), 'utf8'));
  assert.deepEqual(slotBSkills.skills, []);

  const slotALoad = await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotA } });
  assert.equal(slotALoad.state.current_screen, 'interaction');
  assert.equal(slotALoad.slot.slot_id, slotA);

  const slotARecords = await jsonFetch(`${base}/api/records/status?character_id=lina`);
  assert.equal(slotARecords.records.memory.items.some((item) => item.id === 'slot-a-memory'), true);
  assert.equal(slotARecords.records.skills.items.some((item) => item.id === 'slot_a_skill'), true);
  assert.equal(slotARecords.records.work_records.items.some((item) => item.id === 'wr_slot_a'), true);

  const listedWithSlotAActive = await jsonFetch(`${base}/api/slots`);
  assert.equal(listedWithSlotAActive.active_slot_id, slotA);
  assert.equal(listedWithSlotAActive.slots.some((slot) => slot.slot_id === slotA), true);

  await jsonFetch(`${base}/api/slots/load`, { method: 'POST', body: { slot_id: slotB } });
  const slotBRecords = await jsonFetch(`${base}/api/records/status?character_id=lina`);
  assert.equal(slotBRecords.records.memory.items.some((item) => item.id === 'slot-a-memory'), false);
  assert.equal(slotBRecords.records.skills.items.some((item) => item.id === 'slot_a_skill'), false);
  assert.equal(slotBRecords.records.work_records.items.some((item) => item.id === 'wr_slot_a'), false);

  const listedWithSlotBActive = await jsonFetch(`${base}/api/slots`);
  assert.equal(listedWithSlotBActive.active_slot_id, slotB);
});

test('slot load API refuses graduated slots and exposes graduation_completed in slot summaries', async (t) => {
  const { root, base } = await withServer(t);

  const first = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const graduatedSlotId = first.slot.slot_id;
  const second = await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const activeSlotId = second.slot.slot_id;

  const graduatedStatePath = path.join(root, 'game_data/play/slots', graduatedSlotId, 'game_data/runtime_state.json');
  const graduatedState = JSON.parse(await fs.readFile(graduatedStatePath, 'utf8'));
  graduatedState.ending_completed = true;
  await fs.writeFile(graduatedStatePath, `${JSON.stringify(graduatedState, null, 2)}\n`, 'utf8');

  const listed = await jsonFetch(`${base}/api/slots`);
  assert.equal(listed.slots.find((slot) => slot.slot_id === graduatedSlotId)?.graduation_completed, true);
  assert.equal(listed.slots.find((slot) => slot.slot_id === activeSlotId)?.graduation_completed, false);
  assert.equal(listed.active_slot_id, activeSlotId);

  const response = await fetch(`${base}/api/slots/load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slot_id: graduatedSlotId })
  });
  const body = JSON.parse(await response.text());
  assert.equal(response.status, 409);
  assert.match(body.error ?? '', /graduation_completed|graduated/i);

  const activeAfterRefusal = await jsonFetch(`${base}/api/slots`);
  assert.equal(activeAfterRefusal.active_slot_id, activeSlotId);
});

test('starting the next academy week increments elapsed weeks and branches into the graduation ending at week 50', async (t) => {
  const { root, base } = await withServer(t);

  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const runtimeStatePath = path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json');
  const runtimeState = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
  runtimeState.current_screen = 'academy-room';
  runtimeState.elapsed_weeks = 48;
  await fs.writeFile(runtimeStatePath, `${JSON.stringify(runtimeState, null, 2)}\n`, 'utf8');

  const week49 = await jsonFetch(`${base}/api/academy/week/start`, { method: 'POST', body: {} });
  assert.equal(week49.route, 'academy-training');
  assert.equal(week49.state.elapsed_weeks, 49);
  assert.equal(week49.state.current_screen, 'academy-training');

  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_007/memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_008/memory'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_007/memory/mem_1.json'), `${JSON.stringify({ id: 'mem_1', text: 'older memory' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_008/memory/mem_1.json'), `${JSON.stringify({ id: 'mem_1', text: 'memory 1' }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_008/memory/mem_2.json'), `${JSON.stringify({ id: 'mem_2', text: 'memory 2' }, null, 2)}\n`, 'utf8');

  const week50 = await jsonFetch(`${base}/api/academy/week/start`, { method: 'POST', body: {} });
  assert.equal(week50.route, 'graduation-ending');
  assert.equal(week50.state.elapsed_weeks, 50);
  // No conversation-popup settings file → academy_conversation_screen defaults to 'day', so the loop graduation
  // event lands on the daytime screen: current_screen is 'interaction' (the same mapping every daytime event
  // conversation uses). The event context (pending_interaction_context) is unchanged by the landing screen.
  assert.equal(week50.state.current_screen, 'interaction');
  assert.equal(week50.state.current_interaction_character_id, 'character_008');
  assert.equal(week50.state.ending_started, true);
  assert.equal(week50.state.ending_completed, false);
  assert.equal(week50.state.ending_character_id, 'character_008');
  assert.equal(week50.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');
  assert.equal(week50.state.pending_interaction_context.opening_context, '会話ではこれまでの関係や記憶を振り返ること。');
});

test('ending conversation returns to title after graduation loading and marks the ending complete', async (t) => {
  const { root, base } = await withServer(t);

  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const runtimeStatePath = path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json');
  const runtimeState = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
  runtimeState.current_screen = 'academy-room';
  runtimeState.elapsed_weeks = 49;
  await fs.writeFile(runtimeStatePath, `${JSON.stringify(runtimeState, null, 2)}\n`, 'utf8');
  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_008/memory'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_001/game_data/characters/character_008/memory/mem_1.json'), `${JSON.stringify({ id: 'mem_1', text: 'memory 1' }, null, 2)}\n`, 'utf8');

  const week50 = await jsonFetch(`${base}/api/academy/week/start`, { method: 'POST', body: {} });
  const opening = await jsonFetch(`${base}/api/conversation/opening`, {
    method: 'POST',
    body: { character_id: week50.character_id, provider: 'mock' }
  });
  assert.equal(opening.conversation.event_flag_id, 'event.graduation_ending.ready');

  const ending = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: week50.character_id, provider: 'mock' }
  });
  assert.equal(ending.finalization_status, 'completed');
  assert.equal(ending.state.current_screen, 'title');
  assert.equal(ending.state.ending_completed, true);
  assert.equal(ending.transition.next_screen, 'title');
  assert.equal(ending.transition.loading_copy_key, 'graduation-ending-complete');

  await waitFor(async () => {
    const state = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
    assert.equal(state.global_flags['event.graduation_ending.completed'], true);
    assert.equal(state.current_screen, 'title');
  });
});

test('debug weeks endpoint updates elapsed weeks and clears graduation lifecycle state', async (t) => {
  const { root, base } = await withServer(t);

  await jsonFetch(`${base}/api/new-game`, { method: 'POST', body: {} });
  const runtimeStatePath = path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json');
  const runtimeState = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
  Object.assign(runtimeState, {
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: true,
    ending_character_id: 'character_008',
    global_flags: {
      ...(runtimeState.global_flags ?? {}),
      'event.graduation_ending.ready': true,
      'event.graduation_ending.completed': true
    },
    event_flag_sources: {
      ...(runtimeState.event_flag_sources ?? {}),
      'event.graduation_ending.ready': { character_id: 'character_008' }
    },
    event_completion_sources: {
      ...(runtimeState.event_completion_sources ?? {}),
      'event.graduation_ending.completed': { source_type: 'test' }
    }
  });
  await fs.writeFile(runtimeStatePath, `${JSON.stringify(runtimeState, null, 2)}\n`, 'utf8');

  const updated = await jsonFetch(`${base}/api/debug/weeks`, {
    method: 'POST',
    body: { elapsed_weeks: 42 }
  });
  assert.equal(updated.state.elapsed_weeks, 42);
  assert.equal(updated.state.ending_started, false);
  assert.equal(updated.state.ending_completed, false);
  assert.equal(updated.state.ending_character_id, null);
  assert.equal(updated.state.global_flags['event.graduation_ending.ready'], false);
  assert.equal(updated.state.global_flags['event.graduation_ending.completed'], false);
});

test('POST /api/debug/dungeon-materials grants +10 of every catalog material additively and reflects in inventory', async (t) => {
  const { base } = await withServer(t);

  const first = await jsonFetch(`${base}/api/debug/dungeon-materials`, { method: 'POST', body: {} });
  assert.equal(first.grant_each, 10);
  assert.equal(first.deposited_materials.length, 24);
  for (const grant of first.deposited_materials) {
    assert.equal(grant.quantity, 10);
    assert.match(grant.item_id, /^material_.+_t[1-4]$/);
  }
  const materialIds = first.deposited_materials.map((grant) => grant.item_id);

  const inventoryAfterFirst = await jsonFetch(`${base}/api/inventory`);
  for (const itemId of materialIds) {
    assert.equal(inventoryAfterFirst.items.find((item) => item.item_id === itemId)?.quantity, 10);
  }

  const second = await jsonFetch(`${base}/api/debug/dungeon-materials`, { method: 'POST', body: {} });
  assert.equal(second.deposited_materials.length, 24);
  const inventoryAfterSecond = await jsonFetch(`${base}/api/inventory`);
  for (const itemId of materialIds) {
    assert.equal(inventoryAfterSecond.items.find((item) => item.item_id === itemId)?.quantity, 20);
  }
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

test('slot APIs on split-root fixtures keep active_slot_id and slot loading under data/mutable play without consulting legacy game_data/play', async (t) => {
  const { root, base } = await withSplitServer(t);

  const listedBefore = await jsonFetch(`${base}/api/slots`);
  assert.equal(listedBefore.active_slot_id, 'slot_002');
  assert.deepEqual(listedBefore.slots.map((slot) => slot.slot_id), ['slot_001', 'slot_002']);

  const updated = await jsonFetch(`${base}/api/slots/slot_001/note`, {
    method: 'PATCH',
    body: { player_note: 'split root note' }
  });

  assert.equal(updated.slot.slot_id, 'slot_001');
  assert.equal(updated.slot.player_note, 'split root note');
  assert.equal(updated.active_slot_id, 'slot_002');

  const loaded = await jsonFetch(`${base}/api/slots/load`, {
    method: 'POST',
    body: { slot_id: 'slot_001' }
  });
  assert.equal(loaded.slot.slot_id, 'slot_001');
  assert.equal(loaded.state.current_screen, 'academy-room');

  const activeSlot = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/play/active_slot.json'), 'utf8'));
  assert.equal(activeSlot.slot_id, 'slot_001');
  const slotMeta = JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/play/slots/slot_001/meta.json'), 'utf8'));
  assert.equal(slotMeta.player_note, 'split root note');

  await assert.rejects(fs.access(path.join(root, 'game_data/play/active_slot.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots/slot_001/meta.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json')), { code: 'ENOENT' });
});
