import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';
import { createStorageApi } from '../src/storage.mjs';
import {
  ROUTING_ACTIVE_ERRAND_STATE_KEY,
  ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY,
  buildActiveRoutingErrand,
  buildRoutingErrandSceneContext,
  drawWeeklyErrandSkeletons,
  loadErrandTypeCatalog,
  readActiveRoutingErrand,
  readWeeklyErrandOffers,
  validateErrandTypeCatalog,
  validateWeeklyErrandOffers
} from '../src/routingErrands.mjs';
import { buildOrLoadWeeklyErrandOffers } from '../src/routingErrandOffers.mjs';
import {
  ERRAND_OFFER_TITLE_MAX_LENGTH,
  ERRAND_OFFER_SITUATION_MAX_LENGTH,
  ERRAND_OFFER_MOTIVATION_MAX_LENGTH,
  ERRAND_OFFER_APPEAL_MAX_LENGTH,
  buildErrandOfferPrompt,
  buildErrandAppealPrompt,
  generateErrandOfferText,
  validateErrandOfferText,
  validateErrandSkeletonText
} from '../src/llm/errandOffer.mjs';
import { routingDestinations } from '../src/routingDestinations.mjs';
import { ERRAND_SOURCE_TYPE } from '../src/routingMetaContext.mjs';
import { resolveRoutingDestinationDispatch } from '../src/routingDispatch.mjs';
import { buildRoutingHubContextSnapshot } from '../src/routingHubContextSnapshot.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import {
  ROUTING_CONTENT_RESULT_STATE_KEY,
  buildErrandContentResult,
  validateRoutingContentResult
} from '../src/routingContentResult.mjs';
import { runtimePathsManifestFilename } from '../src/runtimePaths.mjs';
import { projectRoot } from './testPaths.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

const livePublicRoot = path.join(projectRoot, 'app/public');
const repoCanonicalAssetsRoot = path.join(projectRoot, 'assets/canonical');

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function loadCatalogDoc() {
  return JSON.parse(await fs.readFile(path.join(projectRoot, 'data/definitions/errand_types.json'), 'utf8'));
}

// A fetchImpl that replies to BOTH offer-text calls: the structured { title, situation,
// motivation } call (carries response_format) gets `structured`, the separate appeal chat
// call (no response_format) gets `appeal`. Records every request so tests can assert the
// requested schema, the appeal prompt, and count calls.
function offerTextFetch({ structured, appeal }, calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const content = body.response_format ? structured : appeal;
    return {
      ok: true,
      headers: { get: (header) => (header.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ choices: [{ message: { content } }] })
    };
  };
}

const OFFER_CONFIG = { base_url: 'http://127.0.0.1:9/v1', chat_model: 'test-model', timeout_ms: 5000 };

async function writeRuntimeManifest(root) {
  await writeJson(root, runtimePathsManifestFilename, {
    configRoot: path.join(root, 'app/config'),
    definitionsRoot: path.join(root, 'data/definitions/game_data'),
    seedsRoot: path.join(root, 'data/definitions/game_data'),
    mutableRoot: path.join(root, 'data/mutable/game_data'),
    characterContentRoot: path.join(projectRoot, 'content/characters'),
    creatureContentRoot: path.join(projectRoot, 'content/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: root
  });
}

async function writeSlotRuntimeManifest(slotRoot, sourceRoot) {
  await writeJson(slotRoot, runtimePathsManifestFilename, {
    configRoot: path.join(sourceRoot, 'app/config'),
    definitionsRoot: path.join(sourceRoot, 'data/definitions/game_data'),
    seedsRoot: path.join(sourceRoot, 'data/definitions/game_data'),
    mutableRoot: path.join(slotRoot, 'game_data'),
    characterContentRoot: path.join(projectRoot, 'content/characters'),
    creatureContentRoot: path.join(projectRoot, 'content/creatures'),
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    publicRoot: livePublicRoot,
    resourceRoot: sourceRoot
  });
}

async function writePlayModeSettings(root, mode) {
  const settingsPath = path.join(root, 'play-mode.json');
  const value = mode === 'routing'
    ? { mode: 'routing', routing_persona_variant: 'fallen_star' }
    : { mode: 'loop' };
  await fs.writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return settingsPath;
}

async function errandServerRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-errand-api-'));
  const slotRoot = path.join(root, 'data/mutable/game_data/play/slots/slot_001');
  await writeRuntimeManifest(root);
  await writeSlotRuntimeManifest(slotRoot, root);
  await fs.mkdir(path.join(root, 'data/definitions'), { recursive: true });
  await fs.copyFile(path.join(projectRoot, 'data/definitions/errand_types.json'), path.join(root, 'data/definitions/errand_types.json'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/study_circles.json'),
    path.join(root, 'data/definitions/game_data/study_circles.json')
  );
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/star_cradle_catalog.json'),
    path.join(root, 'data/definitions/game_data/star_cradle_catalog.json')
  );
  await writeJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/locations.json', [{ id: 'herbology_garden', name: '薬草園', display_name: '薬草園', visible_situation: '薬草が並ぶ温室。', screen: 'field' }]);
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'errand test world',
    world_condition_texts: []
  });
  await writeJson(slotRoot, 'game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    time_slot: 'after_school',
    current_screen: 'academy-errand',
    current_interaction_character_id: null,
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
    elapsed_weeks: 4,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: [],
    pending_finalizations: [],
    routing_week_progressions: [
      {
        idempotency_key: 'conv_route_to_errand_001:errand',
        conversation_id: 'conv_route_to_errand_001',
        destination_id: 'errand',
        elapsed_weeks: 4,
        route: 'academy-week',
        phase: 'applied',
        applied_at: '2026-07-03T00:00:00.000Z'
      }
    ]
  });
  await writeJson(slotRoot, 'game_data/player_inventory.json', {
    money: 20,
    items: [],
    applied_money_delta_conversation_ids: []
  });
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  return { sourceRoot: root, slotRoot };
}

async function withErrandServer(t, mode = 'routing') {
  const { sourceRoot, slotRoot } = await errandServerRoot();
  const playModeSettingsPath = await writePlayModeSettings(sourceRoot, mode);
  const server = createServer({
    root: sourceRoot,
    activeRoot: slotRoot,
    publicRoot: livePublicRoot,
    canonicalAssetsRoot: repoCanonicalAssetsRoot,
    playModeSettingsPath,
    lmStudioConfigPath: path.join(sourceRoot, 'missing-lmstudio.json')
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });
  return { root: slotRoot, sourceRoot, base: `http://127.0.0.1:${server.address().port}` };
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

function parseSseEvents(text) {
  return text.split('\n\n').filter((block) => block.trim()).map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const dataText = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: dataText ? JSON.parse(dataText) : null };
  });
}

test('errand is a weekly routing destination with backend dispatch and meta context', () => {
  const destination = routingDestinations.find((item) => item.id === 'errand');
  assert.deepEqual(destination, {
    id: 'errand',
    label: '依頼',
    description: '学外・学内の小さな依頼を1件引き受けて一週間を使い、依頼主との会話を経て所持金の報酬を得る。'
  });
  assert.deepEqual(resolveRoutingDestinationDispatch('errand'), {
    destination_id: 'errand',
    destination_label: '依頼',
    next_screen: 'academy-errand',
    transition: { next_screen: 'academy-errand' }
  });
  const meta = buildRoutingMetaContext({
    state: { elapsed_weeks: 2 },
    routingHubContext: undefined
  });
  assert.match(meta, /依頼: 学外・学内の小さな依頼を1件引き受けて一週間を使い/);
  assert.match(meta, /依頼: 学院内外の小さな頼まれごとを1件引き受け/);
});

// ----- errand type catalog -----

test('errand type catalog loads with the strict authored shape', async () => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  assert.equal(catalog.types.length, 205);
  assert.deepEqual(Object.keys(catalog.reward_bands).sort(), ['large', 'medium', 'small']);
  // Bands are strictly ordered and non-overlapping, and the medium band centres on the
  // authored reward median (180).
  assert.ok(catalog.reward_bands.small.max < catalog.reward_bands.medium.min);
  assert.ok(catalog.reward_bands.medium.max < catalog.reward_bands.large.min);
  assert.ok(catalog.reward_bands.medium.min <= 180 && 180 <= catalog.reward_bands.medium.max);

  const ids = new Set();
  const categoryCounts = {};
  for (const type of catalog.types) {
    assert.equal(ids.has(type.id), false, `duplicate id ${type.id}`);
    ids.add(type.id);
    assert.match(type.id, /^[a-z0-9_-]+$/);
    assert.ok(['study', 'training', 'craft', 'life', 'campus', 'quirk'].includes(type.category));
    assert.ok(['small', 'medium', 'large'].includes(type.reward_band));
    assert.equal(typeof type.name, 'string');
    assert.ok(type.name.trim().length > 0);
    assert.ok(type.condition_text.trim().length > 0);
    categoryCounts[type.category] = (categoryCounts[type.category] ?? 0) + 1;
  }
  assert.deepEqual(categoryCounts, { study: 34, training: 30, craft: 32, life: 42, campus: 35, quirk: 32 });

  const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-missing-errand-types-'));
  await writeRuntimeManifest(missingRoot);
  await assert.rejects(loadErrandTypeCatalog({ root: missingRoot }), /errand type catalog file is missing/);
  await fs.rm(missingRoot, { recursive: true, force: true });
});

test('validateErrandTypeCatalog fails fast on malformed catalogs', async () => {
  const base = await loadCatalogDoc();
  assert.throws(() => validateErrandTypeCatalog(null), /errand type catalog must be an object/);
  assert.throws(() => validateErrandTypeCatalog({ reward_bands: base.reward_bands, types: base.types.slice(0, 10) }), /must contain exactly 205 types/);

  const overlappingBands = { small: { min: 15, max: 40 }, medium: { min: 30, max: 50 }, large: { min: 51, max: 80 } };
  assert.throws(() => validateErrandTypeCatalog({ reward_bands: overlappingBands, types: base.types }), /small must end below medium/);
  assert.throws(() => validateErrandTypeCatalog({ reward_bands: { small: base.reward_bands.small, medium: base.reward_bands.medium }, types: base.types }), /reward_bands keys must be exactly/);

  const badCategory = { reward_bands: base.reward_bands, types: base.types.map((t, i) => (i === 0 ? { ...t, category: 'bogus' } : t)) };
  assert.throws(() => validateErrandTypeCatalog(badCategory), /category must be one of/);
  const badBand = { reward_bands: base.reward_bands, types: base.types.map((t, i) => (i === 0 ? { ...t, reward_band: 'huge' } : t)) };
  assert.throws(() => validateErrandTypeCatalog(badBand), /reward_band must be a known band/);
  const emptyName = { reward_bands: base.reward_bands, types: base.types.map((t, i) => (i === 0 ? { ...t, name: '   ' } : t)) };
  assert.throws(() => validateErrandTypeCatalog(emptyName), /name is required/);
  const duplicateId = { reward_bands: base.reward_bands, types: base.types.map((t, i) => (i === 1 ? { ...t, id: base.types[0].id } : t)) };
  assert.throws(() => validateErrandTypeCatalog(duplicateId), /id must be unique/);
});

// ----- deterministic weekly skeleton draw -----

test('weekly errand skeletons are deterministic and assign unique clients and band-bounded rewards', async () => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  const characters = [
    { character_id: 'character_001', display_name: '一番' },
    { character_id: 'character_002', display_name: '二番' },
    { character_id: 'character_003', display_name: '三番' },
    { character_id: 'character_004', display_name: '四番' },
    { character_id: 'character_005', display_name: '五番' }
  ];

  const first = drawWeeklyErrandSkeletons({ state: { elapsed_weeks: 7 }, catalog, characters });
  const second = drawWeeklyErrandSkeletons({ state: { elapsed_weeks: 7 }, catalog, characters });
  const otherWeek = drawWeeklyErrandSkeletons({ state: { elapsed_weeks: 8 }, catalog, characters });

  assert.deepEqual(first, second, 'same week skeletons must be deterministic');
  assert.equal(first.week, 7);
  assert.equal(first.skeletons.length, 3);
  assert.equal(new Set(first.skeletons.map((s) => s.type_id)).size, 3);
  assert.equal(new Set(first.skeletons.map((s) => s.client_character_id)).size, 3);
  for (const skeleton of first.skeletons) {
    const band = catalog.reward_bands[skeleton.reward_band];
    assert.ok(Number.isInteger(skeleton.reward_money));
    assert.ok(skeleton.reward_money >= band.min && skeleton.reward_money <= band.max, `${skeleton.reward_money} in [${band.min},${band.max}]`);
    assert.equal(typeof skeleton.condition_text, 'string');
  }
  assert.notDeepEqual(otherWeek.skeletons.map((s) => s.type_id), first.skeletons.map((s) => s.type_id));

  assert.throws(() => drawWeeklyErrandSkeletons({ state: { elapsed_weeks: 7 }, catalog, characters: characters.slice(0, 2) }), /at least three selectable characters/);
});

test('errand reward bands and the 50-week best-of-3 selection average match the balance v2 target', async () => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  // Reward-balance v2 (2026-07-12): errand sits below dungeon T2 and above T1, targeting a ~200G
  // best-of-3 selection average over the current deterministic 50-week draw.
  assert.deepEqual(catalog.reward_bands, {
    small: { min: 63, max: 133 },
    medium: { min: 134, max: 233 },
    large: { min: 234, max: 365 }
  });
  const characters = [
    { character_id: 'character_001', display_name: '一番' },
    { character_id: 'character_002', display_name: '二番' },
    { character_id: 'character_003', display_name: '三番' }
  ];
  let sumBest = 0;
  for (let week = 0; week < 50; week++) {
    const { skeletons } = drawWeeklyErrandSkeletons({ state: { elapsed_weeks: week }, catalog, characters });
    sumBest += Math.max(...skeletons.map((s) => s.reward_money));
  }
  const bestOfThreeAverage = sumBest / 50;
  assert.ok(bestOfThreeAverage >= 190 && bestOfThreeAverage <= 210, `best-of-3 average ${bestOfThreeAverage} in [190,210]`);
});

// ----- errand offer text (LLM gate) -----

const OFFER_PERSONA = {
  display_name: '一番',
  school_year: '2年生',
  identity: '伝書鷹を駆る鷹匠見習い',
  prompt_description: '遠い梢を見上げる目つきの鷹匠見習い。言葉は短く、鷹の前でだけ表情がほどける。',
  speaking_basis: '言葉は短く、要点だけを置く。'
};
const OFFER_WORLD = '星灯魔法学院は地脈の丘に建つ全寮制の魔法学院。お金の単位はG。';

test('buildErrandOfferPrompt embeds type/client/world/persona/constraints, the character-fit clause, and attaches memories only when present', () => {
  const type = { id: 'study_01', category: 'study', name: '苦手科目の教え合い' };
  const withMemory = buildErrandOfferPrompt({
    type,
    clientDisplayName: '一番',
    persona: OFFER_PERSONA,
    world: OFFER_WORLD,
    memories: [{ text: '先週、主人公と図書館で魔法史を教え合った。' }, { text: '' }]
  });
  assert.match(withMemory, /種別: 苦手科目の教え合い/);
  assert.match(withMemory, /分類: 学業・研究/);
  assert.match(withMemory, /依頼主: 一番/);
  // world block and the persona block (with the prompt_description line) are what make the skeleton character-fit.
  assert.match(withMemory, /この世界の設定:\n星灯魔法学院は地脈の丘に建つ全寮制の魔法学院。お金の単位はG。/);
  assert.match(withMemory, /この依頼を持ちかける依頼主の人物像:/);
  assert.match(withMemory, /- 立場: 2年生・伝書鷹を駆る鷹匠見習い/);
  assert.match(withMemory, /- 人物像: 遠い梢を見上げる目つきの鷹匠見習い。/);
  assert.match(withMemory, /- 話し方: 言葉は短く、要点だけを置く。/);
  assert.match(withMemory, /この依頼主ならではのものにする。誰が持ちかけても成り立つ汎用的な依頼にしない。/);
  assert.match(withMemory, /依頼主の記憶/);
  assert.match(withMemory, /先週、主人公と図書館で魔法史を教え合った。/);
  assert.match(withMemory, /第三者本人の台詞は生成しない/);
  assert.match(withMemory, /situation は純情景文/);
  assert.match(withMemory, /報酬額・達成条件は書かない/);
  assert.match(withMemory, new RegExp(`最大${ERRAND_OFFER_SITUATION_MAX_LENGTH}文字`));

  const withoutMemory = buildErrandOfferPrompt({ type, clientDisplayName: '一番', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] });
  assert.doesNotMatch(withoutMemory, /依頼主の記憶/);

  assert.throws(() => buildErrandOfferPrompt({ type: { ...type, category: 'bogus' }, clientDisplayName: '一番', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] }), /category is not a known value/);
  assert.throws(() => buildErrandOfferPrompt({ type: { ...type, name: '' }, clientDisplayName: '一番', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] }), /type name is required/);
  assert.throws(() => buildErrandOfferPrompt({ type, clientDisplayName: '', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] }), /clientDisplayName is required/);
  // world and every persona field (including prompt_description) are required — fail-fast, no silent omission.
  assert.throws(() => buildErrandOfferPrompt({ type, clientDisplayName: '一番', persona: OFFER_PERSONA, world: '', memories: [] }), /world_description is required/);
  assert.throws(() => buildErrandOfferPrompt({ type, clientDisplayName: '一番', persona: { ...OFFER_PERSONA, prompt_description: '' }, world: OFFER_WORLD, memories: [] }), /persona prompt_description is required/);
  assert.throws(() => buildErrandOfferPrompt({ type, clientDisplayName: '一番', persona: { ...OFFER_PERSONA, school_year: '' }, world: OFFER_WORLD, memories: [] }), /persona school_year is required/);
  assert.throws(() => buildErrandOfferPrompt({ type, clientDisplayName: '一番', persona: { ...OFFER_PERSONA, identity: '' }, world: OFFER_WORLD, memories: [] }), /persona identity is required/);
  assert.throws(() => buildErrandOfferPrompt({ type, clientDisplayName: '一番', persona: { ...OFFER_PERSONA, speaking_basis: '' }, world: OFFER_WORLD, memories: [] }), /persona speaking_basis is required/);
});

test('validateErrandOfferText gates the exact { title, situation, motivation, appeal } shape', () => {
  const clean = {
    title: '苦手科目の教え合い',
    situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。',
    motivation: '試験前で不安があり、話しながら理解を確かめたいと考えている。',
    appeal: 'ねえ、ちょっといいかな。試験前でどうしても魔法史が苦手で、あなたと一緒に教え合ってほしいんだ。落ち着いて話せる相手が欲しくて声をかけたの。お願い、力を貸して。'
  };
  assert.deepEqual(validateErrandOfferText(clean), clean);

  assert.throws(() => validateErrandOfferText({ title: 'x', situation: 'y' }), /keys must be exactly \{title, situation, motivation, appeal\}/);
  assert.throws(() => validateErrandOfferText({ ...clean, extra: 1 }), /keys must be exactly/);
  assert.throws(() => validateErrandOfferText({ ...clean, title: 123 }), /title must be a string/);
  assert.throws(() => validateErrandOfferText({ ...clean, title: '   ' }), /title must not be empty/);
  assert.throws(() => validateErrandOfferText({ ...clean, motivation: 'あ'.repeat(ERRAND_OFFER_MOTIVATION_MAX_LENGTH + 1) }), /motivation must be at most/);
  assert.throws(() => validateErrandOfferText({ ...clean, appeal: 'あ'.repeat(ERRAND_OFFER_APPEAL_MAX_LENGTH + 1) }), /appeal must be at most/);
  assert.throws(() => validateErrandOfferText({ ...clean, appeal: '   ' }), /appeal must not be empty/);
  assert.throws(() => validateErrandOfferText({ ...clean, title: '「教え合い」' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateErrandOfferText({ ...clean, appeal: '一行目\n二行目' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateErrandOfferText({ ...clean, appeal: '「力を貸して」' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateErrandOfferText({ ...clean, situation: '一行目\n二行目' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateErrandOfferText({ ...clean, situation: '机に、持ち主の分からない教本が置かれている。' }), /situation contains non-scene wording/);
  // The pure-scene ban is situation-only: the appeal carries first-person feeling / direct address
  // (words like 誰・気配 the situation ban rejects) and must pass so the own-voice pitch can be written.
  assert.doesNotThrow(() => validateErrandOfferText({ ...clean, appeal: '誰かに頼るのは苦手だけど、あなたの落ち着いた気配が頼もしくて、つい声をかけてしまったんだ。力を貸してほしい。' }));
  // exactly at the caps is allowed
  assert.doesNotThrow(() => validateErrandOfferText({ title: 'あ'.repeat(ERRAND_OFFER_TITLE_MAX_LENGTH), situation: 'い'.repeat(ERRAND_OFFER_SITUATION_MAX_LENGTH), motivation: 'う'.repeat(ERRAND_OFFER_MOTIVATION_MAX_LENGTH), appeal: 'え'.repeat(ERRAND_OFFER_APPEAL_MAX_LENGTH) }));
});

test('validateErrandOfferText tags a gate violation as a structured 503 (ERRAND_GENERATION_FAILED)', () => {
  const clean = { title: '苦手科目の教え合い', situation: '机に、二人分の教本が開いて置かれている。', motivation: '試験前で不安があり、話しながら確かめたい。', appeal: 'ねえ、試験前で魔法史が苦手で、あなたと教え合いたいんだ。力を貸して。' };
  const cases = [
    { title: 'x', situation: 'y' }, // wrong shape
    { ...clean, title: 123 }, // non-string field
    { ...clean, title: '   ' }, // empty field
    { ...clean, title: '「教え合い」' }, // forbidden symbols
    { ...clean, appeal: '' }, // empty appeal
    { ...clean, situation: '机に、持ち主の分からない教本が置かれている。' } // non-scene wording
  ];
  for (const candidate of cases) {
    assert.throws(() => validateErrandOfferText(candidate), (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.errorCode, 'ERRAND_GENERATION_FAILED');
      return true;
    });
  }
});

test('validateErrandSkeletonText adopts+gates the exact { title, situation, motivation } skeleton before the appeal', () => {
  const clean = { title: '教え合いの相談', situation: '机に、二人分の教本が開いて置かれている。', motivation: '試験前で確かめたい。' };
  assert.deepEqual(validateErrandSkeletonText(clean), clean);
  assert.deepEqual(validateErrandSkeletonText({ title: ' 相談 ', situation: '机に道具が並ぶ。', motivation: '手を借りたい。' }), { title: '相談', situation: '机に道具が並ぶ。', motivation: '手を借りたい。' });
  assert.throws(() => validateErrandSkeletonText({ ...clean, appeal: 'x' }), /skeleton keys must be exactly \{title, situation, motivation\}/);
  assert.throws(() => validateErrandSkeletonText({ title: 'x', situation: 'y' }), /skeleton keys must be exactly/);
  assert.throws(() => validateErrandSkeletonText({ ...clean, title: '' }), /title must not be empty/);
  assert.throws(() => validateErrandSkeletonText({ ...clean, situation: '机に、持ち主の分からない教本が置かれている。' }), /situation contains non-scene wording/);
  assert.throws(() => validateErrandSkeletonText({ ...clean, motivation: 'あ'.repeat(ERRAND_OFFER_MOTIVATION_MAX_LENGTH + 1) }), /motivation must be at most/);
});

test('the errand offer gates reject a field that fakes the system-owned 達成条件 / 報酬 (regression: it used to pass)', () => {
  const cleanSkeleton = { title: '教え合いの相談', situation: '机に、二人分の教本が開いて置かれている。', motivation: '試験前で確かめたい。' };
  const cleanOffer = { ...cleanSkeleton, appeal: 'ねえ、試験前で魔法史が苦手で、あなたと教え合いたいんだ。力を貸して。' };
  const conditionRe = /must not state the system-owned achievement condition or reward: 達成条件/;
  const rewardRe = /must not state the system-owned achievement condition or reward: 報酬/;
  // The final gate rejects 達成条件 / 報酬 on any field, including the appeal — the exact混入 that made a screen
  // "達成条件: ..." diverge from the hidden judgment condition (offer-condition-mismatch-investigation Evidence §3).
  assert.throws(() => validateErrandOfferText({ ...cleanOffer, appeal: '達成条件: 主人公が返事をすること。' }), conditionRe);
  assert.throws(() => validateErrandOfferText({ ...cleanOffer, motivation: '報酬をはずむから手伝ってほしい。' }), rewardRe);
  assert.throws(() => validateErrandOfferText({ ...cleanOffer, title: '達成条件の確認' }), conditionRe);
  // The skeleton adopt-gate rejects them too (before the appeal call is even spent).
  assert.throws(() => validateErrandSkeletonText({ ...cleanSkeleton, situation: '机に、達成条件の紙が置かれている。' }), conditionRe);
  assert.throws(() => validateErrandSkeletonText({ ...cleanSkeleton, motivation: '報酬の相談をしたい。' }), rewardRe);
  // Structured 503 tagging is preserved for the new rejection.
  assert.throws(() => validateErrandOfferText({ ...cleanOffer, appeal: '報酬は気にしないで。' }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.errorCode, 'ERRAND_GENERATION_FAILED');
    return true;
  });
  // A clean offer with none of the terms still passes (no over-broad rejection of ordinary prose).
  assert.deepEqual(validateErrandOfferText(cleanOffer), cleanOffer);
});

test('the errand offer prompts contain no pre-fix (persona-less / skeleton-less / bare-motivation) form', () => {
  // Prompt-contract guards against the old forms silently returning.
  const offerPrompt = buildErrandOfferPrompt({ type: { id: 'study_01', category: 'study', name: '苦手科目の教え合い' }, clientDisplayName: '一番', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] });
  assert.match(offerPrompt, /この依頼を持ちかける依頼主の人物像:/, 'offer skeleton must carry the persona block');
  assert.match(offerPrompt, /- 人物像: /, 'offer persona block must include the prompt_description line');
  const appealPrompt = buildErrandAppealPrompt({ type: { id: 'study_01', category: 'study', name: '苦手科目の教え合い' }, persona: { display_name: '一番', school_year: '1年生', identity: '星を読む新入生', speaking_basis: '弾む。' }, kosshi: { title: 't', situation: 's', motivation: 'm' }, memories: [] });
  assert.match(appealPrompt, /別の依頼に変えず/, 'appeal must carry the faithfulness clause');
  // scene context must present the errand, not the bare motivation.
  const active = buildActiveRoutingErrand({
    offer: { errand_id: 'study_01', type_id: 'study_01', title: '教え合いの相談', situation: '机に、二人分の教本が開いて置かれている。', motivation: '試験前で確かめたい。', appeal: '一番が、あなたに手を貸してほしいと語りかけている。', condition_text: '確認した。', reward_money: 40, client_character_id: 'character_003' },
    clientDisplayName: '三番',
    conversationId: 'conv_errand_5_study_01_character_003_x',
    week: 5,
    startedAt: '2026-07-03T00:00:00.000Z'
  });
  const scene = buildRoutingErrandSceneContext(active);
  assert.match(scene.prompt_tail_context, /あなたは今、目の前の主人公にひとつの依頼を持ちかけている/, 'scene tail must frame the client as presenting the errand');
  assert.notEqual(scene.prompt_tail_context, active.prompt_tail_context, 'scene tail must not be the bare motivation');
});

test('buildErrandAppealPrompt frames the client persona, the confirmed skeleton + faithfulness clause, the address / no-name-symbol / one-paragraph / no-reward clauses, and attaches memories only when present', () => {
  const type = { id: 'study_01', category: 'study', name: '苦手科目の教え合い' };
  const persona = { display_name: '一番', school_year: '1年生', identity: '星を読む新入生', speaking_basis: '弾むように短い言葉で話す。' };
  const kosshi = { title: '教え合いの相談', situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。', motivation: '試験前で不安があり、話しながら理解を確かめたい。' };
  const withMemory = buildErrandAppealPrompt({
    type,
    persona,
    kosshi,
    memories: [{ text: '先週、主人公と図書館で魔法史を教え合った。' }, { text: '' }]
  });
  assert.match(withMemory, /一番本人である/);
  assert.match(withMemory, /この依頼を自分の口から持ちかける/);
  assert.match(withMemory, /- 名前: 一番/);
  assert.match(withMemory, /- 立場: 1年生・星を読む新入生/);
  assert.match(withMemory, /- 話し方: 弾むように短い言葉で話す。/);
  assert.match(withMemory, /頼みたいこと（種別）: 苦手科目の教え合い/);
  assert.match(withMemory, /分類: 学業・研究/);
  // the confirmed skeleton block + the faithfulness clause are what stop the swap.
  assert.match(withMemory, /この依頼はすでに内容が確定している。あなたはこの確定した依頼を、別の依頼に変えず/);
  assert.match(withMemory, /- 依頼の見出し: 教え合いの相談/);
  assert.match(withMemory, /- 依頼の現場の様子: 机に、二人分の教本と走り書きのノートが開いて置かれている。/);
  assert.match(withMemory, /- あなたがこの依頼を持ちかける動機・事情: 試験前で不安があり、話しながら理解を確かめたい。/);
  assert.match(withMemory, /上の内容と違う別の困りごと・別の頼みごとを新しく作り出さない。/);
  assert.match(withMemory, /あなたが覚えている主人公とのこと/);
  assert.match(withMemory, /先週、主人公と図書館で魔法史を教え合った。/);
  // the address clause, the second-person / no-name-symbol clause, the one-paragraph clause, the no-reward
  // clause, the third-party constraint, and the 200〜300字 band are all present.
  assert.match(withMemory, /直接語りかけるように/);
  assert.match(withMemory, /名前では呼ばず、あなたの口調に合う二人称/);
  assert.match(withMemory, /名前の空欄・伏字・記号/);
  assert.match(withMemory, /改行はせず/);
  assert.match(withMemory, /報酬や達成条件、点数のことは書かない/);
  assert.match(withMemory, /第三者本人の台詞は作らない/);
  assert.match(withMemory, /長さは200〜300字くらい。/);

  const withoutMemory = buildErrandAppealPrompt({ type, persona, kosshi, memories: [] });
  assert.doesNotMatch(withoutMemory, /あなたが覚えている主人公とのこと/);

  assert.throws(() => buildErrandAppealPrompt({ type: { ...type, name: '' }, persona, kosshi, memories: [] }), /type name is required/);
  assert.throws(() => buildErrandAppealPrompt({ type: { ...type, category: 'bogus' }, persona, kosshi, memories: [] }), /category is not a known value/);
  assert.throws(() => buildErrandAppealPrompt({ type, persona: { ...persona, speaking_basis: '' }, kosshi, memories: [] }), /persona speaking_basis is required/);
  assert.throws(() => buildErrandAppealPrompt({ type, persona: { ...persona, display_name: '' }, kosshi, memories: [] }), /persona display_name is required/);
  assert.throws(() => buildErrandAppealPrompt({ type, persona: { ...persona, school_year: '' }, kosshi, memories: [] }), /persona school_year is required/);
  assert.throws(() => buildErrandAppealPrompt({ type, persona: { ...persona, identity: '' }, kosshi, memories: [] }), /persona identity is required/);
  // the confirmed skeleton is required — a missing title/situation/motivation is a caller bug, fail-fast.
  assert.throws(() => buildErrandAppealPrompt({ type, persona, kosshi: { ...kosshi, title: '' }, memories: [] }), /kosshi title is required/);
  assert.throws(() => buildErrandAppealPrompt({ type, persona, kosshi: { ...kosshi, situation: '' }, memories: [] }), /kosshi situation is required/);
  assert.throws(() => buildErrandAppealPrompt({ type, persona, kosshi: { ...kosshi, motivation: '' }, memories: [] }), /kosshi motivation is required/);
});

test('generateErrandOfferText makes a character-fit structured call AND a separate appeal chat call fed the adopted skeleton, gates both, and fails fast without fallback', async () => {
  const type = { id: 'study_01', category: 'study', name: '苦手科目の教え合い' };
  const persona = OFFER_PERSONA;
  const world = OFFER_WORLD;
  const structured = { title: '教え合いの相談', situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。', motivation: '試験前で不安があり、話しながら理解を確かめたい。' };
  const appeal = 'ねえ、ちょっといいかな。試験前で魔法史がどうしても苦手で、あなたと一緒に教え合いたいんだ。落ち着いて話せる相手が欲しくて声をかけたの。';
  const calls = [];
  const result = await generateErrandOfferText({ config: OFFER_CONFIG, type, clientDisplayName: '一番', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: JSON.stringify(structured), appeal }, calls) });
  assert.deepEqual(result, { ...structured, appeal });
  assert.equal(calls.length, 2, 'the structured text and the appeal are two distinct calls');
  const structuredCall = calls.find((call) => call.response_format);
  const appealCall = calls.find((call) => !call.response_format);
  assert.equal(structuredCall.response_format.json_schema.name, 'errand_offer_record');
  assert.deepEqual(structuredCall.response_format.json_schema.schema.required, ['title', 'situation', 'motivation']);
  assert.match(structuredCall.messages[0].content, /種別: 苦手科目の教え合い/);
  // the structured (skeleton) call carries the world + persona blocks; the appeal call carries the adopted skeleton.
  assert.match(structuredCall.messages[0].content, /この世界の設定:/);
  assert.match(structuredCall.messages[0].content, /この依頼を持ちかける依頼主の人物像:/);
  assert.equal(appealCall.model, OFFER_CONFIG.chat_model, 'the appeal is a chat call on the chat model');
  assert.match(appealCall.messages[0].content, /一番本人である/);
  assert.match(appealCall.messages[0].content, /話し方: 言葉は短く、要点だけを置く。/);
  assert.match(appealCall.messages[0].content, /別の依頼に変えず/);
  assert.match(appealCall.messages[0].content, /- 依頼の見出し: 教え合いの相談/);

  // a malformed skeleton is adopted+gated BEFORE the appeal call, surfacing the offer-gate message.
  await assert.rejects(
    generateErrandOfferText({ config: OFFER_CONFIG, type, clientDisplayName: '一番', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: JSON.stringify({ title: '', situation: 'x', motivation: 'y' }), appeal }, []) }),
    /title must not be empty/
  );
  await assert.rejects(
    generateErrandOfferText({ config: OFFER_CONFIG, type, clientDisplayName: '一番', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: JSON.stringify(structured), appeal: '' }, []) }),
    /appeal must not be empty/
  );
  await assert.rejects(
    generateErrandOfferText({ config: OFFER_CONFIG, type, clientDisplayName: '一番', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: 'not json', appeal }, []) }),
    /structured JSON parse failed/
  );
  await assert.rejects(
    generateErrandOfferText({ config: { base_url: '', chat_model: '' }, type, clientDisplayName: '一番', persona, world, memories: [], fetchImpl: async () => { throw new Error('fetch must not be reached'); } }),
    (error) => error.code === 'LMSTUDIO_CONFIG_REQUIRED'
  );
  await assert.rejects(
    generateErrandOfferText({ config: OFFER_CONFIG, type, clientDisplayName: '一番', persona, world, memories: [], fetchImpl: async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; } }),
    (error) => error.code === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );
});

// ----- weekly build-or-load orchestration -----

async function orchestrationRoot(elapsedWeeks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-errand-offers-'));
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: elapsedWeeks, characters: {} });
  return root;
}

const orchestrationCharacters = [
  { character_id: 'character_001', display_name: '一番' },
  { character_id: 'character_002', display_name: '二番' },
  { character_id: 'character_003', display_name: '三番' },
  { character_id: 'character_004', display_name: '四番' }
];

function countingGenerator(calls) {
  return async ({ type, clientDisplayName, persona }) => {
    calls.push({ type_id: type.id, clientDisplayName, persona });
    return {
      title: `${clientDisplayName}の相談`,
      situation: `机に、${type.id}に使う道具が並べて置かれている。`,
      motivation: `${clientDisplayName}が、会話を通じて手を借りたいと考えている。`,
      appeal: `ねえ、${type.id}のことで手を貸してほしいんだ。${clientDisplayName}から、あなたに声をかけたよ。`
    };
  };
}

test('buildOrLoadWeeklyErrandOffers generates once, then reuses the persisted week with no further LLM calls', async (t) => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  const root = await orchestrationRoot(6);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createStorageApi({ root });
  const calls = [];
  const args = { storage, catalog, characters: orchestrationCharacters, memoriesFor: async () => [], generateOfferText: countingGenerator(calls) };

  const firstRun = await buildOrLoadWeeklyErrandOffers(args);
  assert.equal(firstRun.generated, true);
  assert.equal(firstRun.week, 6);
  assert.equal(firstRun.offers.length, 3);
  assert.equal(calls.length, 3, 'the generator is called once per offer on first build');
  const persisted = readWeeklyErrandOffers(await storage.readJson('game_data/runtime_state.json'));
  assert.deepEqual(persisted, { week: 6, offers: firstRun.offers });

  const secondRun = await buildOrLoadWeeklyErrandOffers(args);
  assert.equal(secondRun.generated, false, 'the same week returns the persisted offers');
  assert.deepEqual(secondRun.offers, firstRun.offers);
  assert.equal(calls.length, 3, 'no further LLM call happens for a same-week re-fetch');

  const advanced = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', { ...advanced, elapsed_weeks: 7 });
  const thirdRun = await buildOrLoadWeeklyErrandOffers(args);
  assert.equal(thirdRun.generated, true, 'a new week regenerates');
  assert.equal(thirdRun.week, 7);
  assert.equal(calls.length, 6);
});

function cleanErrandOffer({ type, clientDisplayName }) {
  return { title: `${clientDisplayName}の相談`, situation: `机に、${type.id}に使う道具が並べて置かれている。`, motivation: '手を貸してほしい。', appeal: `${clientDisplayName}が、あなたに手を貸してほしいと語りかけている。` };
}

// A generated field carrying a forbidden bracket symbol — exactly the runtime failure that
// motivated bounded retry ("errand offer appeal ... must not contain quotation or bracket
// symbols: 『").
function bracketDirtyErrandOffer({ type, clientDisplayName }) {
  return { ...cleanErrandOffer({ type, clientDisplayName }), appeal: `${clientDisplayName}が『手を貸して』と語りかけている。` };
}

test('buildOrLoadWeeklyErrandOffers recovers when an offer trips the gate once, then persists a clean week', async (t) => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  const root = await orchestrationRoot(6);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createStorageApi({ root });
  let firstTypeId;
  const attemptsByType = new Map();
  const generateOfferText = async ({ type, clientDisplayName }) => {
    if (firstTypeId === undefined) firstTypeId = type.id;
    const n = (attemptsByType.get(type.id) ?? 0) + 1;
    attemptsByType.set(type.id, n);
    if (type.id === firstTypeId && n === 1) return bracketDirtyErrandOffer({ type, clientDisplayName });
    return cleanErrandOffer({ type, clientDisplayName });
  };

  const run = await buildOrLoadWeeklyErrandOffers({ storage, catalog, characters: orchestrationCharacters, memoriesFor: async () => [], generateOfferText });
  assert.equal(run.generated, true);
  assert.equal(run.offers.length, 3);
  assert.equal(attemptsByType.get(firstTypeId), 2, 'the offer that tripped the gate was regenerated once');
  for (const offer of run.offers) assert.equal(offer.appeal.includes('『'), false, 'no persisted offer carries a forbidden symbol');
  const persisted = readWeeklyErrandOffers(await storage.readJson('game_data/runtime_state.json'));
  assert.deepEqual(persisted, { week: 6, offers: run.offers });
});

test('buildOrLoadWeeklyErrandOffers fails fast with a 503 and persists nothing when an offer trips the gate on every attempt', async (t) => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  const root = await orchestrationRoot(6);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createStorageApi({ root });
  const distinctTypes = [];
  let failingTypeId;
  let failingTypeAttempts = 0;
  const generateOfferText = async ({ type, clientDisplayName }) => {
    if (!distinctTypes.includes(type.id)) distinctTypes.push(type.id);
    if (failingTypeId === undefined && distinctTypes.length === 2) failingTypeId = distinctTypes[1];
    if (type.id === failingTypeId) {
      failingTypeAttempts += 1;
      return { title: '', situation: 'x', motivation: 'y', appeal: 'z' }; // permanently malformed (empty title)
    }
    return cleanErrandOffer({ type, clientDisplayName });
  };

  await assert.rejects(
    buildOrLoadWeeklyErrandOffers({ storage, catalog, characters: orchestrationCharacters, memoriesFor: async () => [], generateOfferText }),
    (error) => {
      assert.equal(error.errorCode, 'ERRAND_GENERATION_FAILED');
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /title must not be empty/);
      return true;
    }
  );
  assert.equal(failingTypeAttempts, 3, 'the failing offer was retried up to the cap before failing');
  const state = await storage.readJson('game_data/runtime_state.json');
  assert.equal(Object.hasOwn(state, ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY), false, 'no partial slot is persisted');
});

test('buildOrLoadWeeklyErrandOffers does not retry an LM connection failure and persists nothing', async (t) => {
  const catalog = await loadErrandTypeCatalog({ root: projectRoot });
  const root = await orchestrationRoot(6);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createStorageApi({ root });
  let calls = 0;
  const generateOfferText = async () => {
    calls += 1;
    const error = new Error('LM Studioの接続が確認できません。');
    error.errorCode = 'LMSTUDIO_CONNECTION_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  };

  await assert.rejects(
    buildOrLoadWeeklyErrandOffers({ storage, catalog, characters: orchestrationCharacters, memoriesFor: async () => [], generateOfferText }),
    (error) => error.errorCode === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );
  assert.equal(calls, 1, 'an LM connection failure fails fast without spending the retry budget');
  const state = await storage.readJson('game_data/runtime_state.json');
  assert.equal(Object.hasOwn(state, ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY), false, 'no partial slot is persisted');
});

// ----- persisted slot + active errand shapes -----

test('weekly errand offers slot and active errand state are strict', () => {
  const offer = {
    errand_id: 'study_01',
    type_id: 'study_01',
    title: '教え合いの相談',
    situation: '机に、二人分の教本と走り書きのノートが開いて置かれている。',
    motivation: '試験前で不安があり、話しながら理解を確かめたい。',
    appeal: 'ねえ、試験前で魔法史がどうしても苦手なんだ。あなたと一緒に教え合いたくて声をかけたの。落ち着いて話せる相手がほしくて。お願い、力を貸して。',
    condition_text: '主人公が依頼主の苦手な内容を説明し、依頼主が理解を示した。',
    reward_money: 40,
    client_character_id: 'character_003'
  };
  const slot = { week: 5, offers: [offer, { ...offer, errand_id: 'life_04', type_id: 'life_04' }, { ...offer, errand_id: 'craft_02', type_id: 'craft_02' }] };
  assert.deepEqual(readWeeklyErrandOffers({ [ROUTING_WEEKLY_ERRAND_OFFERS_STATE_KEY]: slot }), validateWeeklyErrandOffers(slot));
  assert.throws(() => validateWeeklyErrandOffers({ week: 5, offers: [offer, offer] }), /must contain exactly three offers/);
  assert.throws(() => validateWeeklyErrandOffers({ week: 5, offers: [offer, offer, offer] }), /errand_id must be unique/);

  const active = buildActiveRoutingErrand({
    offer,
    clientDisplayName: '三番',
    conversationId: 'conv_errand_5_study_01_character_003_x',
    week: 5,
    startedAt: '2026-07-03T00:00:00.000Z'
  });
  assert.equal(active.errand_id, 'study_01');
  assert.equal(active.type_id, 'study_01');
  assert.equal(active.condition_text, offer.condition_text);
  assert.equal(active.prompt_tail_context, offer.motivation, 'the generated motivation becomes prompt_tail_context');
  assert.equal(active.client_display_name, '三番');
  // The appeal is presentation-only: it never enters the active record or the scene context (below).
  assert.equal(Object.hasOwn(active, 'appeal'), false, 'the appeal is not carried into the active errand');
  assert.deepEqual(readActiveRoutingErrand({ [ROUTING_ACTIVE_ERRAND_STATE_KEY]: active }), active);
  assert.throws(() => readActiveRoutingErrand({ [ROUTING_ACTIVE_ERRAND_STATE_KEY]: null }), /routing active errand must be an object/);
  assert.throws(() => readActiveRoutingErrand({ [ROUTING_ACTIVE_ERRAND_STATE_KEY]: { ...active, type_id: '' } }), /type_id/);
  assert.throws(() => readActiveRoutingErrand({ [ROUTING_ACTIVE_ERRAND_STATE_KEY]: { ...active, condition_text: '' } }), /condition_text/);

  // The scene context is an errand statement: a framing block (framing + title + motivation) so the
  // client presents its own errand, followed by a goal block that names the achievement condition
  // (condition_text verbatim), forbids meta speech about it, and steers the conversation to reach that
  // point in-scene. visible_situation stays the pure scene, and only fields the active record already
  // carries (title + motivation + condition_text) are used.
  const errandScene = buildRoutingErrandSceneContext(active);
  assert.deepEqual(errandScene, {
    source_type: ERRAND_SOURCE_TYPE,
    location_name: '依頼の現場',
    visible_situation: offer.situation,
    prompt_tail_context: [
      'あなたは今、目の前の主人公にひとつの依頼を持ちかけている。この会話はその依頼を相談して進めるための場である。',
      `あなたが持ちかけている依頼: ${offer.title}`,
      `あなたがこの依頼を持ちかける事情: ${offer.motivation}`,
      'この依頼で主人公に何をしてほしいのかを、あなた自身が分かった上で、あなたの方から話を切り出す。',
      `この依頼が果たされたと言えるのは、次のことが会話の中で実際に起きたときである: ${offer.condition_text}`,
      'ただし「達成条件」といった言葉やこの文面そのものは決して口に出さず、会話の内容として自然にそこへ向かう。',
      'この到達点には、あなた自身（依頼主）の反応や言葉も含まれることがある。その場合は、あなた自身がその反応・納得・結論を、会話の自然な流れの中で自分から言葉にして示す。',
      'この到達点を先延ばしにしたり、下調べや段取りの相談だけで終わらせたりしない。会話の中で実際にその場面をやり切ることを目指し、主人公にも具体的な行動や答えを促し、頃合いを見てあなた自身の理解・納得・結論をはっきり言葉にして区切りをつける。',
      '特に、主人公自身が担う一歩（たとえば候補をひとつ選ぶ・指し示す・自分の答えや説明を口にする等）がまだ果たされていないなら、あなたの側だけで先に進めてしまわず、主人公にその一歩を具体的に問いかけ、主人公自身に決めさせてから次へ進む。',
      'ただし急いで結論へ運んだり主人公を質問攻めにしたりはせず、まず相手のやり取りを受け止めながら自然にそこへ近づける。'
    ].join('\n')
  });
  // The goal block carries the achievement condition verbatim, forbids meta speech, and appends the six
  // goal lines in order after the four framing lines.
  const errandTail = errandScene.prompt_tail_context.split('\n');
  assert.equal(errandTail.length, 10, 'errand scene tail is four framing lines plus six goal lines');
  assert.equal(errandTail[4], `この依頼が果たされたと言えるのは、次のことが会話の中で実際に起きたときである: ${offer.condition_text}`);
  assert.ok(errandTail[4].includes(offer.condition_text), 'the goal line carries condition_text verbatim');
  assert.equal(errandTail[5], 'ただし「達成条件」といった言葉やこの文面そのものは決して口に出さず、会話の内容として自然にそこへ向かう。', 'the meta-speech ban follows the goal line');

  const record = buildErrandContentResult({
    week: active.week,
    now: '2026-07-03T00:10:00.000Z',
    errandId: active.errand_id,
    title: active.title,
    achieved: true,
    rewardMoney: active.reward_money,
    clientCharacterId: active.client_character_id,
    clientDisplayName: active.client_display_name
  });
  assert.equal(record.kind, 'errand');
  assert.equal(record.detail.achieved, true);
  assert.equal(record.detail.reward_money, 40);
  assert.deepEqual(validateRoutingContentResult(record), record);

  const unachievedRecord = buildErrandContentResult({
    week: active.week,
    now: '2026-07-03T00:10:00.000Z',
    errandId: active.errand_id,
    title: active.title,
    achieved: false,
    rewardMoney: 0,
    clientCharacterId: active.client_character_id,
    clientDisplayName: active.client_display_name
  });
  assert.equal(unachievedRecord.detail.achieved, false);
  assert.equal(unachievedRecord.detail.reward_money, 0);
  assert.deepEqual(validateRoutingContentResult(unachievedRecord), unachievedRecord);
});

// ----- HTTP surface -----

test('GET /api/errand generates the weekly offers once and returns them deterministically', async (t) => {
  const { base } = await withErrandServer(t, 'routing');
  const first = await jsonFetch(`${base}/api/errand?provider=mock`);
  const second = await jsonFetch(`${base}/api/errand?provider=mock`);
  assert.equal(first.errands.length, 3);
  assert.deepEqual(first, second);
  for (const offer of first.errands) {
    assert.match(offer.errand_id, /^[a-z0-9_-]+$/);
    assert.equal(offer.type_id, offer.errand_id);
    assert.equal(typeof offer.client_display_name, 'string');
    assert.ok(offer.reward_money > 0);
    // The appeal (当人の語り) is the card's主表示 and IS public; situation stays public for the daytime scene.
    assert.equal(typeof offer.appeal, 'string');
    assert.ok(offer.appeal.trim().length > 0, 'the appeal is a non-empty own-voice pitch');
    assert.equal(typeof offer.situation, 'string');
    assert.equal(Object.hasOwn(offer, 'motivation'), false, 'motivation is not public');
    // condition_text is the authored judgment value the achievement check uses — it is internal and never
    // shown to the player, so it must not ride on the public offer.
    assert.equal(Object.hasOwn(offer, 'condition_text'), false, 'condition_text is not public (internal judgment value)');
  }

  const { base: loopBase } = await withErrandServer(t, 'loop');
  const response = await fetch(`${loopBase}/api/errand`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error_code, 'ROUTING_MODE_REQUIRED');
});

test('GET /api/errand fails fast with a structured error when LM Studio is not configured', async (t) => {
  const { base } = await withErrandServer(t, 'routing');
  const response = await fetch(`${base}/api/errand`); // no mock provider -> real generation path
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error_code, 'LMSTUDIO_CONFIG_REQUIRED');
});

test('errand provider seam rejects a present-but-unrecognized value (400 UNSUPPORTED_PROVIDER); absent → real, mock unchanged', async (t) => {
  const { base } = await withErrandServer(t, 'routing');
  // GET query seam: an unknown provider value is rejected before any generation.
  const getUnknown = await fetch(`${base}/api/errand?provider=real`);
  assert.equal(getUnknown.status, 400);
  assert.equal((await getUnknown.json()).error_code, 'UNSUPPORTED_PROVIDER');
  // An empty provider value counts as present-but-unrecognized (no silent real fallthrough).
  const getEmpty = await fetch(`${base}/api/errand?provider=`);
  assert.equal(getEmpty.status, 400);
  assert.equal((await getEmpty.json()).error_code, 'UNSUPPORTED_PROVIDER');
  // Absent still routes to the real path (503 with LM unconfigured) — checked before mock persists
  // the week's offers, so the real generation path is actually reached.
  const absent = await fetch(`${base}/api/errand`);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error_code, 'LMSTUDIO_CONFIG_REQUIRED');
  // mock still works.
  const mockOk = await fetch(`${base}/api/errand?provider=mock`);
  assert.equal(mockOk.status, 200);

  // POST body seam: an unknown provider value is rejected too (offers are now ready).
  const postUnknown = await fetch(`${base}/api/errand/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ errand_id: 'study_01', provider: 'real' })
  });
  assert.equal(postUnknown.status, 400);
  assert.equal((await postUnknown.json()).error_code, 'UNSUPPORTED_PROVIDER');
});

test('POST /api/errand/start fails fast outside routing mode, before offers are ready, and for unoffered errands', async (t) => {
  const { base: loopBase } = await withErrandServer(t, 'loop');
  const loopResponse = await fetch(`${loopBase}/api/errand/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ errand_id: 'study_01', provider: 'mock' })
  });
  assert.equal(loopResponse.status, 409);
  assert.equal((await loopResponse.json()).error_code, 'ROUTING_MODE_REQUIRED');

  const { base } = await withErrandServer(t, 'routing');
  const notReady = await fetch(`${base}/api/errand/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ errand_id: 'study_01', provider: 'mock' })
  });
  assert.equal(notReady.status, 409);
  assert.equal((await notReady.json()).error_code, 'ERRAND_OFFERS_NOT_READY');

  await jsonFetch(`${base}/api/errand?provider=mock`);
  const unofferedResponse = await fetch(`${base}/api/errand/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ errand_id: 'not_offered', provider: 'mock' })
  });
  assert.equal(unofferedResponse.status, 400);
  assert.equal((await unofferedResponse.json()).error_code, 'ERRAND_NOT_OFFERED');
});

test('POST /api/errand/start opens an errand scene, and a manual /api/conversation/end without achievement pays no reward and records it as unachieved', async (t) => {
  const { root, sourceRoot, base } = await withErrandServer(t, 'routing');
  const offers = await jsonFetch(`${base}/api/errand?provider=mock`);
  const chosen = offers.errands[0];

  const started = await jsonFetch(`${base}/api/errand/start`, {
    method: 'POST',
    body: { errand_id: chosen.errand_id, provider: 'mock' }
  });
  assert.equal(started.errand.errand_id, chosen.errand_id);
  assert.equal(started.errand.type_id, chosen.type_id);
  assert.equal(started.conversation.character_id, chosen.client_character_id);
  assert.match(started.conversation.prompt, /舞台: 依頼の現場/);
  assert.match(started.conversation.prompt, new RegExp(`見えている状況: ${chosen.situation}`));
  const activeErrand = started.state[ROUTING_ACTIVE_ERRAND_STATE_KEY];
  assert.equal(activeErrand.errand_id, chosen.errand_id);
  assert.equal(activeErrand.type_id, chosen.type_id);
  assert.equal(typeof activeErrand.condition_text, 'string');
  assert.ok(activeErrand.condition_text.length > 0, 'the achievement condition rides on the active errand');

  // The opening record is an errand injected-scene session (same record contract as the dungeon): it declares
  // source_type 'errand' and carries the errand 舞台, with no residual field location_id / time_slot.
  assert.equal(started.conversation.source_type, ERRAND_SOURCE_TYPE);
  assert.equal(started.conversation.location_name, '依頼の現場');
  assert.equal(Object.hasOwn(started.conversation, 'location_id'), false);
  assert.equal(Object.hasOwn(started.conversation, 'time_slot'), false);
  const persistedErrandOpen = await readJson(root, `game_data/logs/conversations/${started.conversation.id}.json`);
  assert.equal(persistedErrandOpen.source_type, ERRAND_SOURCE_TYPE);
  assert.equal(persistedErrandOpen.location_name, '依頼の現場');
  assert.equal(Object.hasOwn(persistedErrandOpen, 'location_id'), false);
  assert.equal(Object.hasOwn(persistedErrandOpen, 'time_slot'), false);

  // Manual exit without achievement: the week is consumed but no reward is paid, and the record is written
  // as unachieved (achieved:false, reward_money 0). The money path is still driven (delta 0), not skipped.
  const ended = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: {
      character_id: chosen.client_character_id,
      conversation_id: started.conversation.id,
      provider: 'mock'
    }
  });
  assert.equal(ended.finalization_status, 'drained');
  assert.equal(ended.post_content_screen, 'interaction');
  assert.equal(ended.transition.next_screen, 'interaction');
  assert.equal(ended.errand_result.achieved, false);
  assert.equal(ended.errand_result.reward_money, 0);
  assert.equal(ended.errand_result.money.delta, 0);
  assert.equal(ended.errand_result.money.already_applied, false);
  assert.equal(Object.hasOwn(ended.state, ROUTING_ACTIVE_ERRAND_STATE_KEY), false);
  assert.equal(ended.state[ROUTING_CONTENT_RESULT_STATE_KEY].kind, 'errand');
  assert.equal(ended.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.errand_id, chosen.errand_id);
  assert.equal(ended.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.achieved, false);
  assert.equal(ended.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.reward_money, 0);
  const hubSnapshot = await buildRoutingHubContextSnapshot({
    root,
    authoringRoot: sourceRoot,
    state: ended.state,
    personaVariant: 'fallen_star'
  });
  assert.equal(hubSnapshot.content_result_context.record.kind, 'errand');
  assert.match(buildRoutingMetaContext({ state: ended.state, routingHubContext: hubSnapshot }), /直近コンテンツ結果: 依頼（.*）を達成できずに終了.*報酬なし/);

  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.money, 20, 'an unachieved exit pays no reward');
  assert.deepEqual(inventory.applied_money_delta_conversation_ids, [started.conversation.id]);

  const secondEnd = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: {
      character_id: chosen.client_character_id,
      conversation_id: started.conversation.id,
      provider: 'mock'
    }
  });
  assert.equal(secondEnd.reason, 'already_finalized');
  const inventoryAfterRetry = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventoryAfterRetry.money, 20);
});

test('an errand turn that meets the achievement condition auto-ends inside the turn: wrap-up 発話, reward paid, achieved record', async (t) => {
  const { root, sourceRoot, base } = await withErrandServer(t, 'routing');
  const offers = await jsonFetch(`${base}/api/errand?provider=mock`);
  const chosen = offers.errands[0];
  const started = await jsonFetch(`${base}/api/errand/start`, {
    method: 'POST',
    body: { errand_id: chosen.errand_id, provider: 'mock' }
  });

  // The mock achievement judgment achieves when the player input carries 「達成」. The turn generates the
  // client's wrap-up 発話 and the server auto-ends the errand within the same turn response.
  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: {
      id: started.conversation.id,
      character_id: chosen.client_character_id,
      player_input: '頼まれたことをやり切りました。達成です。',
      provider: 'mock'
    }
  });
  assert.ok(turn.errand_achievement, 'the achieved turn carries the achievement signal');
  assert.equal(turn.errand_result.achieved, true);
  assert.equal(turn.errand_result.reward_money, chosen.reward_money);
  assert.equal(turn.errand_result.money.delta, chosen.reward_money);
  assert.equal(turn.finalization_status, 'drained');
  assert.equal(turn.post_content_screen, 'interaction');
  assert.equal(turn.transition.next_screen, 'interaction');
  // The wrap-up 発話 is the closing message of the turn conversation.
  const lastMessage = turn.conversation.messages.at(-1);
  assert.equal(lastMessage.role, 'assistant');
  assert.equal(lastMessage.content, 'それじゃ、これで今回のお願いはおしまい。助かった、ありがとう。');
  assert.equal(turn.conversation.errand_achievement_judgment.achieved, true);
  assert.equal(Object.hasOwn(turn.conversation, 'conversation_continuation'), false, 'an errand turn replaces the continuation judgment');

  assert.equal(Object.hasOwn(turn.state, ROUTING_ACTIVE_ERRAND_STATE_KEY), false, 'the active errand is cleared');
  assert.equal(turn.state[ROUTING_CONTENT_RESULT_STATE_KEY].kind, 'errand');
  assert.equal(turn.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.achieved, true);
  assert.equal(turn.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.reward_money, chosen.reward_money);

  const hubSnapshot = await buildRoutingHubContextSnapshot({
    root,
    authoringRoot: sourceRoot,
    state: turn.state,
    personaVariant: 'fallen_star'
  });
  assert.match(buildRoutingMetaContext({ state: turn.state, routingHubContext: hubSnapshot }), /直近コンテンツ結果: 依頼（.*）を達成。.*報酬: \d+/);

  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.money, 20 + chosen.reward_money, 'the achieved errand pays the band reward');

  // Idempotency: a stray manual end after the auto-end finds no active conversation and does not re-pay.
  const strayEnd = await jsonFetch(`${base}/api/conversation/end`, {
    method: 'POST',
    body: { character_id: chosen.client_character_id, conversation_id: started.conversation.id, provider: 'mock' }
  });
  assert.equal(strayEnd.reason, 'already_finalized');
  const inventoryAfter = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventoryAfter.money, 20 + chosen.reward_money);
});

test('a streaming errand turn returns the same auto-end completion contract as the non-streaming path', async (t) => {
  const { root, base } = await withErrandServer(t, 'routing');
  const offers = await jsonFetch(`${base}/api/errand?provider=mock`);
  const chosen = offers.errands[0];
  const started = await jsonFetch(`${base}/api/errand/start`, {
    method: 'POST',
    body: { errand_id: chosen.errand_id, provider: 'mock' }
  });

  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: started.conversation.id,
      character_id: chosen.client_character_id,
      player_input: 'これで達成ですね。ありがとうございました。',
      provider: 'mock'
    })
  });
  assert.equal(streamed.status, 200);
  const events = parseSseEvents(await streamed.text());
  const eventNames = events.map((item) => item.event);
  const result = events.find((item) => item.event === 'result')?.data;
  // The wrap-up 発話 streams as an assistant_complete before the result carrying the completion.
  const assistantCompletes = eventNames.filter((name) => name === 'assistant_complete');
  assert.ok(assistantCompletes.length >= 2, 'the reply and the wrap-up both stream as assistant_complete');
  assert.ok(result, 'the stream emits a result event');
  assert.ok(result.errand_achievement, 'the streamed achieved turn carries the achievement signal');
  assert.equal(result.errand_result.achieved, true);
  assert.equal(result.errand_result.reward_money, chosen.reward_money);
  assert.equal(result.finalization_status, 'drained');
  assert.equal(result.post_content_screen, 'interaction');
  assert.equal(Object.hasOwn(result.state, ROUTING_ACTIVE_ERRAND_STATE_KEY), false);
  assert.equal(result.state[ROUTING_CONTENT_RESULT_STATE_KEY].detail.achieved, true);
  assert.equal(result.conversation.messages.at(-1).content, 'それじゃ、これで今回のお願いはおしまい。助かった、ありがとう。');

  // Drain-on-exit loading signal: the stream emits achievement_draining AFTER the wrap-up (assistant_complete)
  // and BEFORE the result (the completion drain runs between them), so the client covers the drain with the
  // loading screen, matching routing_draining. The signal is paired with the completion result (errand_result
  // rides on the result event), so no half-signalled stream is possible.
  const drainingEvents = events.filter((item) => item.event === 'achievement_draining');
  assert.equal(drainingEvents.length, 1, 'the achieved errand stream emits exactly one achievement_draining signal');
  assert.equal(drainingEvents[0].data.kind, 'errand', 'the achievement_draining signal names the errand kind');
  const lastWrapUp = eventNames.lastIndexOf('assistant_complete');
  assert.ok(
    lastWrapUp < eventNames.indexOf('achievement_draining')
      && eventNames.indexOf('achievement_draining') < eventNames.indexOf('result'),
    'achievement_draining sits after the wrap-up and before the result (the drain runs under the loading screen)'
  );

  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.money, 20 + chosen.reward_money);
});

test('a streaming errand turn that does NOT meet the condition emits no achievement_draining signal', async (t) => {
  const { base } = await withErrandServer(t, 'routing');
  const offers = await jsonFetch(`${base}/api/errand?provider=mock`);
  const chosen = offers.errands[0];
  const started = await jsonFetch(`${base}/api/errand/start`, {
    method: 'POST',
    body: { errand_id: chosen.errand_id, provider: 'mock' }
  });

  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: started.conversation.id,
      character_id: chosen.client_character_id,
      player_input: 'まだ途中です。もう少し話しましょう。',
      provider: 'mock'
    })
  });
  assert.equal(streamed.status, 200);
  const events = parseSseEvents(await streamed.text());
  const result = events.find((item) => item.event === 'result')?.data;
  assert.equal(Object.hasOwn(result, 'errand_achievement'), false, 'an unachieved turn carries no achievement signal');
  assert.equal(
    events.some((item) => item.event === 'achievement_draining'),
    false,
    'no achievement_draining is emitted when the turn does not auto-end'
  );
});

test('an errand turn that does NOT meet the condition continues: no reward, no completion, active errand stays', async (t) => {
  const { root, base } = await withErrandServer(t, 'routing');
  const offers = await jsonFetch(`${base}/api/errand?provider=mock`);
  const chosen = offers.errands[0];
  const started = await jsonFetch(`${base}/api/errand/start`, {
    method: 'POST',
    body: { errand_id: chosen.errand_id, provider: 'mock' }
  });

  const turn = await jsonFetch(`${base}/api/conversation`, {
    method: 'POST',
    body: {
      id: started.conversation.id,
      character_id: chosen.client_character_id,
      player_input: 'まだ途中です。もう少し話しましょう。',
      provider: 'mock'
    }
  });
  assert.equal(Object.hasOwn(turn, 'errand_achievement'), false, 'an unachieved turn carries no achievement signal');
  assert.equal(Object.hasOwn(turn, 'errand_result'), false, 'an unachieved turn is not finalized');
  assert.equal(turn.conversation.errand_achievement_judgment.achieved, false);
  const activeErrand = turn.state[ROUTING_ACTIVE_ERRAND_STATE_KEY];
  assert.equal(activeErrand.errand_id, chosen.errand_id, 'the active errand stays for another turn');

  const inventory = await readJson(root, 'game_data/player_inventory.json');
  assert.equal(inventory.money, 20, 'no reward before achievement');
});

test('conversation end fails fast when active errand state is present but malformed', async (t) => {
  const { root, base } = await withErrandServer(t, 'routing');
  const offers = await jsonFetch(`${base}/api/errand?provider=mock`);
  const chosen = offers.errands[0];
  const started = await jsonFetch(`${base}/api/errand/start`, {
    method: 'POST',
    body: { errand_id: chosen.errand_id, provider: 'mock' }
  });

  const state = await readJson(root, 'game_data/runtime_state.json');
  await writeJson(root, 'game_data/runtime_state.json', {
    ...state,
    [ROUTING_ACTIVE_ERRAND_STATE_KEY]: null
  });

  const response = await fetch(`${base}/api/conversation/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      character_id: chosen.client_character_id,
      conversation_id: started.conversation.id,
      provider: 'mock'
    })
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /routing active errand must be an object/);
});
