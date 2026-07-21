import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { createStorageApi } from '../src/storage.mjs';
import {
  loadStudyCircleDefinitions,
  validateStudyCircleDefinitions
} from '../src/studyCircleDefinitions.mjs';
import {
  ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY,
  ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY,
  STUDY_CIRCLE_TYPE_COUNT,
  STUDY_CIRCLE_TYPES_PER_THEME,
  applyStudyCircleCompletion,
  buildActiveRoutingStudyCircle,
  buildRoutingStudyCircleSceneContext,
  drawWeeklyStudyCircleSkeletons,
  findPersistedStudyCircleOffer,
  loadStudyCircleTypeCatalog,
  readActiveRoutingStudyCircle,
  readWeeklyStudyCircleOffers,
  studyCircleRewardAmount,
  toPublicStudyCircleOffer,
  validateStudyCircleContentResult,
  validateStudyCircleTypeCatalog,
  validateWeeklyStudyCircleOffers
} from '../src/routingStudyCircle.mjs';
import { buildOrLoadWeeklyStudyCircleOffers } from '../src/routingStudyCircleOffers.mjs';
import { STUDY_CIRCLE_SOURCE_TYPE } from '../src/routingMetaContext.mjs';
import {
  STUDY_CIRCLE_OFFER_TITLE_MAX_LENGTH,
  STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH,
  STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH,
  STUDY_CIRCLE_OFFER_APPEAL_MAX_LENGTH,
  buildStudyCircleOfferPrompt,
  buildStudyCircleAppealPrompt,
  generateStudyCircleOfferText,
  validateStudyCircleSkeletonText,
  validateStudyCircleOfferText
} from '../src/llm/studyCircleOffer.mjs';
import { trainingDefinitions } from '../src/training.mjs';
import { defaultPlayerParameters } from '../src/parameters.mjs';
import { routingDestinations } from '../src/routingDestinations.mjs';
import { resolveRoutingDestinationDispatch } from '../src/routingDispatch.mjs';
import { buildRoutingMetaContext } from '../src/routingMetaContext.mjs';
import { projectRoot } from './testPaths.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

function characterId(index) {
  return `character_${String(index).padStart(3, '0')}`;
}

function fixtureDefinitions() {
  return trainingDefinitions.map((training, index) => ({
    theme_id: training.id,
    venue: `fixture venue ${index + 1}`,
    host_candidate_ids: [characterId(index * 3 + 1), characterId(index * 3 + 2), characterId(index * 3 + 3)]
  }));
}

async function writeFixtureProfiles(root, definitions = fixtureDefinitions()) {
  const ids = new Set(definitions.flatMap((definition) => definition.host_candidate_ids));
  for (const id of ids) {
    await writeJson(root, `content/characters/${id}/profile.json`, {
      character_id: id,
      display_name: `表示名 ${id}`
    });
  }
}

async function studyCircleRoot({ definitions = fixtureDefinitions(), state = {}, parameters = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-study-circle-'));
  await writeJson(root, 'data/definitions/game_data/study_circles.json', definitions);
  // The type catalog is the authored one (140 types across the 20 themes).
  await fs.mkdir(path.join(root, 'data/definitions/game_data'), { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, 'data/definitions/game_data/study_circle_types.json'),
    path.join(root, 'data/definitions/game_data/study_circle_types.json')
  );
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'study circle test world',
    world_condition_texts: []
  });
  await writeFixtureProfiles(root, definitions);
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', parameters ?? defaultPlayerParameters());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_screen: 'academy-study-circle',
    elapsed_weeks: 0,
    global_flags: {},
    characters: {},
    ...state
  });
  return root;
}

// A fetchImpl that replies to BOTH offer-text calls: the structured { title, situation,
// motivation } call (carries response_format) gets `structured`, the separate appeal chat
// call (no response_format) gets `appeal`. Records every request so tests can assert the
// requested schema, the appeal prompt, and count calls. (Mirrors the errand offer test helper.)
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

const OFFER_PERSONA = {
  display_name: '主催者',
  school_year: '3年生',
  identity: '星図を編む観測者',
  prompt_description: '星図に見入る静かな観測者。言葉は選ぶが、星の話になると熱がこもる。',
  speaking_basis: '落ち着いた低い声でゆっくり話す。'
};
const OFFER_WORLD = '星灯魔法学院は地脈の丘に建つ全寮制の魔法学院。お金の単位はG。';

// ----- authored theme/host definitions -----

test('authored study circle definitions cover every training theme with selectable hosts', async () => {
  const definitions = await loadStudyCircleDefinitions({ root: projectRoot });
  assert.equal(definitions.length, trainingDefinitions.length);
  assert.deepEqual(
    definitions.map((definition) => definition.theme_id).sort(),
    trainingDefinitions.map((training) => training.id).sort()
  );

  for (const definition of definitions) {
    assert.equal(definition.host_candidate_ids.length >= 3, true);
    assert.equal(definition.host_candidates.length, definition.host_candidate_ids.length);
    assert.equal(new Set(definition.host_candidate_ids).size, definition.host_candidate_ids.length);
    assert.equal(definition.host_candidate_ids.includes('lina'), false);
    for (const hostId of definition.host_candidate_ids) assert.match(hostId, /^character_(00[1-9]|0[1-9][0-9]|1[01][0-9]|12[0-7])$/);
    assert.equal(typeof definition.venue, 'string');
    assert.equal(Object.hasOwn(definition, 'situation'), false);
  }
});

test('study circle definition validation fails fast on theme mismatch and malformed hosts', () => {
  const missingTheme = fixtureDefinitions().filter((definition) => definition.theme_id !== 'star_observation');
  assert.throws(
    () => validateStudyCircleDefinitions(missingTheme),
    /theme set must match training definitions/
  );

  const invalidHost = fixtureDefinitions();
  invalidHost[0].host_candidate_ids = ['character_001', 'character_001', 'lina'];
  assert.throws(
    () => validateStudyCircleDefinitions(invalidHost),
    /duplicate host_candidate_id|selectable character/
  );

  const tooFewHosts = fixtureDefinitions();
  tooFewHosts[0].host_candidate_ids = ['character_001', 'character_002'];
  assert.throws(
    () => validateStudyCircleDefinitions(tooFewHosts),
    /at least three/
  );
});

// ----- type catalog -----

test('the authored study circle type catalog loads with 140 types across 20 themes of 7', async () => {
  const catalog = await loadStudyCircleTypeCatalog({ root: projectRoot });
  assert.equal(catalog.types.length, STUDY_CIRCLE_TYPE_COUNT);
  const themeIds = new Set(trainingDefinitions.map((training) => training.id));
  const perTheme = new Map();
  const seenIds = new Set();
  for (const type of catalog.types) {
    assert.equal(themeIds.has(type.theme_id), true, `type ${type.id} references a known theme`);
    assert.equal(seenIds.has(type.id), false, `type id ${type.id} is unique`);
    seenIds.add(type.id);
    assert.equal(typeof type.name, 'string');
    assert.equal(typeof type.scene_brief, 'string');
    assert.equal(typeof type.condition_text, 'string');
    assert.equal(['small', 'medium', 'large'].includes(type.reward_band), true);
    perTheme.set(type.theme_id, (perTheme.get(type.theme_id) ?? 0) + 1);
  }
  assert.equal(perTheme.size, trainingDefinitions.length);
  for (const [, count] of perTheme) assert.equal(count, STUDY_CIRCLE_TYPES_PER_THEME);
  // Bands are strictly ordered non-overlapping small < medium < large.
  assert.equal(catalog.reward_bands.small.max < catalog.reward_bands.medium.min, true);
  assert.equal(catalog.reward_bands.medium.max < catalog.reward_bands.large.min, true);
});

test('study circle type catalog validation fails fast on count, theme, band, uniqueness, and per-theme balance', async () => {
  const catalog = await loadStudyCircleTypeCatalog({ root: projectRoot });
  const clone = () => JSON.parse(JSON.stringify(catalog));

  const shortCatalog = clone();
  shortCatalog.types = shortCatalog.types.slice(0, STUDY_CIRCLE_TYPE_COUNT - 1);
  assert.throws(() => validateStudyCircleTypeCatalog(shortCatalog), /must contain exactly 140 types/);

  const unknownTheme = clone();
  unknownTheme.types[0].theme_id = 'bogus_theme';
  assert.throws(() => validateStudyCircleTypeCatalog(unknownTheme), /must be a known theme/);

  const unknownBand = clone();
  unknownBand.types[0].reward_band = 'huge';
  assert.throws(() => validateStudyCircleTypeCatalog(unknownBand), /must be a known band/);

  const duplicateId = clone();
  duplicateId.types[1].id = duplicateId.types[0].id;
  assert.throws(() => validateStudyCircleTypeCatalog(duplicateId), /id must be unique/);

  // Reassigning one star_observation type to potion_brewing keeps the total at 140 but
  // unbalances the per-theme counts (6 vs 8).
  const unbalanced = clone();
  const star = unbalanced.types.find((type) => type.theme_id === 'star_observation');
  star.theme_id = 'potion_brewing';
  assert.throws(() => validateStudyCircleTypeCatalog(unbalanced), /must have exactly 7 types/);

  const badBands = clone();
  badBands.reward_bands = { small: { min: 5, max: 6 }, medium: { min: 3, max: 4 }, large: { min: 1, max: 2 } };
  assert.throws(() => validateStudyCircleTypeCatalog(badBands), /small must end below medium/);
});

// ----- offer text prompt + gate -----

test('buildStudyCircleOfferPrompt embeds the activity, scene brief, host, world, persona, the character-fit clause, and attaches memories only when present', () => {
  const type = { id: 'star_missing_search', name: '帰らない星の捜索', scene_brief: '見つからない星を望遠鏡と星図で探す。' };
  const withMemory = buildStudyCircleOfferPrompt({
    type,
    hostDisplayName: '主催者',
    persona: OFFER_PERSONA,
    world: OFFER_WORLD,
    memories: [{ text: '先週、主人公と星図を読んだ。' }]
  });
  assert.match(withMemory, /活動: 帰らない星の捜索/);
  assert.match(withMemory, /場面の骨子: 見つからない星を望遠鏡と星図で探す。/);
  assert.match(withMemory, /主催: 主催者/);
  // world block and the persona block (with the prompt_description line) are what make the skeleton character-fit.
  assert.match(withMemory, /この世界の設定:\n星灯魔法学院は地脈の丘に建つ全寮制の魔法学院。お金の単位はG。/);
  assert.match(withMemory, /この研究会を主催する主催者の人物像:/);
  assert.match(withMemory, /- 立場: 3年生・星図を編む観測者/);
  assert.match(withMemory, /- 人物像: 星図に見入る静かな観測者。/);
  assert.match(withMemory, /- 話し方: 落ち着いた低い声でゆっくり話す。/);
  assert.match(withMemory, /この主催者ならではのものにする。誰が主催しても成り立つ汎用的な内容にしない。/);
  assert.match(withMemory, /主催者の記憶/);
  assert.match(withMemory, /先週、主人公と星図を読んだ。/);
  assert.match(withMemory, /第三者本人の台詞は生成しない/);
  assert.match(withMemory, /situation は純情景文/);
  assert.match(withMemory, /報酬・達成条件は書かない/);
  assert.match(withMemory, new RegExp(`最大${STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH}文字`));

  const withoutMemory = buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] });
  assert.doesNotMatch(withoutMemory, /主催者の記憶/);

  assert.throws(() => buildStudyCircleOfferPrompt({ type: { ...type, name: '' }, hostDisplayName: '主催者', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] }), /type name is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type: { ...type, scene_brief: '' }, hostDisplayName: '主催者', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] }), /scene_brief is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] }), /hostDisplayName is required/);
  // world and every persona field (including prompt_description) are required — fail-fast, no silent omission.
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: OFFER_PERSONA, world: '', memories: [] }), /world_description is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: { ...OFFER_PERSONA, prompt_description: '' }, world: OFFER_WORLD, memories: [] }), /persona prompt_description is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: { ...OFFER_PERSONA, school_year: '' }, world: OFFER_WORLD, memories: [] }), /persona school_year is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: { ...OFFER_PERSONA, identity: '' }, world: OFFER_WORLD, memories: [] }), /persona identity is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: { ...OFFER_PERSONA, display_name: '' }, world: OFFER_WORLD, memories: [] }), /persona display_name is required/);
  assert.throws(() => buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: { ...OFFER_PERSONA, speaking_basis: '' }, world: OFFER_WORLD, memories: [] }), /persona speaking_basis is required/);
});

test('validateStudyCircleOfferText gates the exact { title, situation, motivation, appeal } shape', () => {
  const clean = {
    title: '帰らない星の相談',
    situation: '観測台に、望遠鏡と星図が並べて広げられている。',
    motivation: '観測記録の締切が迫り、今夜のうちに探し切りたいと考えている。',
    appeal: 'ねえ、少しだけ時間はあるかな。観測記録の締切が今夜までで、帰らない星をどうしても探し切りたいんだ。あなたと一緒なら見つけられそうな気がして、声をかけたの。手伝ってほしい。'
  };
  assert.deepEqual(validateStudyCircleOfferText(clean), clean);

  assert.throws(() => validateStudyCircleOfferText({ title: 'x', situation: 'y' }), /keys must be exactly \{title, situation, motivation, appeal\}/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, extra: 1 }), /keys must be exactly/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, title: 123 }), /title must be a string/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, title: '   ' }), /title must not be empty/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, motivation: 'あ'.repeat(STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH + 1) }), /motivation must be at most/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, appeal: 'あ'.repeat(STUDY_CIRCLE_OFFER_APPEAL_MAX_LENGTH + 1) }), /appeal must be at most/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, appeal: '   ' }), /appeal must not be empty/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, title: '「星さがし」' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, appeal: '一行目\n二行目' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, appeal: '「手伝って」' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, situation: '一行目\n二行目' }), /must not contain quotation or bracket symbols/);
  assert.throws(() => validateStudyCircleOfferText({ ...clean, situation: '観測台に、持ち主の分からない星図が置かれている。' }), /situation contains non-scene wording/);
  // The pure-scene ban is situation-only: the appeal carries first-person feeling / direct address
  // (words like 誰・気配 the situation ban rejects) and must pass so the own-voice invitation can be written.
  assert.doesNotThrow(() => validateStudyCircleOfferText({ ...clean, appeal: '誰かと星を探すのは久しぶりで、あなたの落ち着いた気配が頼もしくて声をかけたんだ。一緒に来てほしい。' }));
  assert.doesNotThrow(() => validateStudyCircleOfferText({ title: 'あ'.repeat(STUDY_CIRCLE_OFFER_TITLE_MAX_LENGTH), situation: 'い'.repeat(STUDY_CIRCLE_OFFER_SITUATION_MAX_LENGTH), motivation: 'う'.repeat(STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH), appeal: 'え'.repeat(STUDY_CIRCLE_OFFER_APPEAL_MAX_LENGTH) }));
});

test('validateStudyCircleOfferText tags a gate violation as a structured 503 (STUDY_CIRCLE_GENERATION_FAILED)', () => {
  const clean = { title: '帰らない星の相談', situation: '観測台に、望遠鏡と星図が並べて広げられている。', motivation: '観測記録の締切が迫り、今夜のうちに探し切りたい。', appeal: 'ねえ、帰らない星を一緒に探してほしいんだ。あなたとなら見つけられそうで、声をかけたの。' };
  const cases = [
    { title: 'x', situation: 'y' }, // wrong shape
    { ...clean, title: 123 }, // non-string field
    { ...clean, title: '   ' }, // empty field
    { ...clean, title: '「星さがし」' }, // forbidden symbols
    { ...clean, appeal: '' }, // empty appeal
    { ...clean, situation: '観測台に、持ち主の分からない星図が置かれている。' } // non-scene wording
  ];
  for (const candidate of cases) {
    assert.throws(() => validateStudyCircleOfferText(candidate), (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.errorCode, 'STUDY_CIRCLE_GENERATION_FAILED');
      return true;
    });
  }
});

test('buildStudyCircleAppealPrompt frames the host persona, the confirmed skeleton + faithfulness clause, the address / no-name-symbol / one-paragraph / no-reward clauses, and attaches memories only when present', () => {
  const type = { id: 'star_missing_search', name: '帰らない星の捜索', scene_brief: '見つからない星を望遠鏡と星図で探す。' };
  const persona = { display_name: '主催者', school_year: '3年生', identity: '星図を編む観測者', speaking_basis: '落ち着いた低い声でゆっくり話す。' };
  const kosshi = { title: '帰らない星の相談', situation: '観測台に、望遠鏡と星図が並べて広げられている。', motivation: '観測記録の締切が迫り、今夜のうちに探し切りたい。' };
  const withMemory = buildStudyCircleAppealPrompt({
    type,
    persona,
    kosshi,
    memories: [{ text: '先週、主人公と星図を読んだ。' }, { text: '' }]
  });
  assert.match(withMemory, /主催者本人である/);
  assert.match(withMemory, /この研究会を自分の口から持ちかける/);
  assert.match(withMemory, /- 名前: 主催者/);
  assert.match(withMemory, /- 立場: 3年生・星図を編む観測者/);
  assert.match(withMemory, /- 話し方: 落ち着いた低い声でゆっくり話す。/);
  assert.match(withMemory, /開く研究会（活動）: 帰らない星の捜索/);
  assert.match(withMemory, /どんな場面か: 見つからない星を望遠鏡と星図で探す。/);
  // the confirmed skeleton is injected and the faithfulness clause forbids inventing a different circle.
  assert.match(withMemory, /この研究会はすでに内容が確定している。あなたはこの確定した研究会に、内容を別のものに変えず/);
  assert.match(withMemory, /- 研究会の見出し: 帰らない星の相談/);
  assert.match(withMemory, /- 現場の様子: 観測台に、望遠鏡と星図が並べて広げられている。/);
  assert.match(withMemory, /- あなたがこの研究会を開く動機・事情: 観測記録の締切が迫り、今夜のうちに探し切りたい。/);
  assert.match(withMemory, /上の「確定した研究会」の内容（何をやる集まりか）をそのまま誘う。上の内容と違う別の活動・別の集まりを新しく作り出さない。/);
  assert.match(withMemory, /あなたが覚えている主人公とのこと/);
  assert.match(withMemory, /先週、主人公と星図を読んだ。/);
  assert.match(withMemory, /直接語りかけるように/);
  assert.match(withMemory, /なぜ主人公を誘うのか/);
  assert.match(withMemory, /名前では呼ばず、あなたの口調に合う二人称/);
  assert.match(withMemory, /名前の空欄・伏字・記号/);
  assert.match(withMemory, /改行はせず/);
  assert.match(withMemory, /報酬や達成条件、点数のことは書かない/);
  assert.match(withMemory, /第三者本人の台詞は作らない/);
  assert.match(withMemory, /長さは200〜300字くらい。/);

  const withoutMemory = buildStudyCircleAppealPrompt({ type, persona, kosshi, memories: [] });
  assert.doesNotMatch(withoutMemory, /あなたが覚えている主人公とのこと/);

  assert.throws(() => buildStudyCircleAppealPrompt({ type: { ...type, name: '' }, persona, kosshi, memories: [] }), /type name is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type: { ...type, scene_brief: '' }, persona, kosshi, memories: [] }), /scene_brief is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona: { ...persona, speaking_basis: '' }, kosshi, memories: [] }), /persona speaking_basis is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona: { ...persona, display_name: '' }, kosshi, memories: [] }), /persona display_name is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona: { ...persona, school_year: '' }, kosshi, memories: [] }), /persona school_year is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona: { ...persona, identity: '' }, kosshi, memories: [] }), /persona identity is required/);
  // the confirmed skeleton's three values are required — fail-fast.
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona, kosshi: { ...kosshi, title: '' }, memories: [] }), /kosshi title is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona, kosshi: { ...kosshi, situation: '' }, memories: [] }), /kosshi situation is required/);
  assert.throws(() => buildStudyCircleAppealPrompt({ type, persona, kosshi: { ...kosshi, motivation: '' }, memories: [] }), /kosshi motivation is required/);
});

test('validateStudyCircleSkeletonText adopts+gates the exact { title, situation, motivation } skeleton before the appeal', () => {
  const clean = { title: '帰らない星の相談', situation: '観測台に、望遠鏡と星図が並べて広げられている。', motivation: '観測記録の締切が迫っている。' };
  assert.deepEqual(validateStudyCircleSkeletonText(clean), clean);
  assert.deepEqual(validateStudyCircleSkeletonText({ title: ' 相談 ', situation: '台に道具が並ぶ。', motivation: '付き合ってほしい。' }), { title: '相談', situation: '台に道具が並ぶ。', motivation: '付き合ってほしい。' });
  assert.throws(() => validateStudyCircleSkeletonText({ ...clean, appeal: 'x' }), /skeleton keys must be exactly \{title, situation, motivation\}/);
  assert.throws(() => validateStudyCircleSkeletonText({ title: 'x', situation: 'y' }), /skeleton keys must be exactly/);
  assert.throws(() => validateStudyCircleSkeletonText({ ...clean, title: '' }), /title must not be empty/);
  assert.throws(() => validateStudyCircleSkeletonText({ ...clean, situation: '観測台に、持ち主の分からない星図が置かれている。' }), /situation contains non-scene wording/);
  assert.throws(() => validateStudyCircleSkeletonText({ ...clean, motivation: 'あ'.repeat(STUDY_CIRCLE_OFFER_MOTIVATION_MAX_LENGTH + 1) }), /motivation must be at most/);
  assert.throws(() => validateStudyCircleSkeletonText({ ...clean, title: '「星さがし」' }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.errorCode, 'STUDY_CIRCLE_GENERATION_FAILED');
    return true;
  });
});

test('the study circle offer gates reject a field that fakes the system-owned 達成条件 / 報酬 (regression: it used to pass)', () => {
  const cleanSkeleton = { title: '帰らない星の相談', situation: '観測台に、望遠鏡と星図が並べて広げられている。', motivation: '観測記録の締切が迫っている。' };
  const cleanOffer = { ...cleanSkeleton, appeal: 'ねえ、帰らない星を一緒に探してほしいんだ。あなたとなら見つけられそうで、声をかけたの。' };
  const conditionRe = /must not state the system-owned achievement condition or reward: 達成条件/;
  const rewardRe = /must not state the system-owned achievement condition or reward: 報酬/;
  // The final gate rejects 達成条件 / 報酬 on any field, including the appeal — the exact混入 that made a screen
  // "達成条件: ..." diverge from the hidden judgment condition (offer-condition-mismatch-investigation Evidence §3).
  assert.throws(() => validateStudyCircleOfferText({ ...cleanOffer, appeal: '達成条件: 主人公が結論を述べること。' }), conditionRe);
  assert.throws(() => validateStudyCircleOfferText({ ...cleanOffer, motivation: '報酬をはずむから来てほしい。' }), rewardRe);
  assert.throws(() => validateStudyCircleOfferText({ ...cleanOffer, title: '達成条件の確認' }), conditionRe);
  // The skeleton adopt-gate rejects them too (before the appeal call is even spent).
  assert.throws(() => validateStudyCircleSkeletonText({ ...cleanSkeleton, situation: '台に、達成条件の紙が置かれている。' }), conditionRe);
  assert.throws(() => validateStudyCircleSkeletonText({ ...cleanSkeleton, motivation: '報酬の相談をしたい。' }), rewardRe);
  // Structured 503 tagging is preserved for the new rejection.
  assert.throws(() => validateStudyCircleOfferText({ ...cleanOffer, appeal: '報酬は気にしないで。' }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.errorCode, 'STUDY_CIRCLE_GENERATION_FAILED');
    return true;
  });
  // A clean offer with none of the terms still passes (no over-broad rejection of ordinary prose).
  assert.deepEqual(validateStudyCircleOfferText(cleanOffer), cleanOffer);
});

test('the study circle offer prompts contain no pre-fix (persona-less / skeleton-less / bare-motivation) form', () => {
  const type = { id: 'star_missing_search', name: '帰らない星の捜索', scene_brief: '見つからない星を望遠鏡と星図で探す。' };
  // (1) offer skeleton carries the world + persona blocks (character-fit).
  const offerPrompt = buildStudyCircleOfferPrompt({ type, hostDisplayName: '主催者', persona: OFFER_PERSONA, world: OFFER_WORLD, memories: [] });
  assert.match(offerPrompt, /この研究会を主催する主催者の人物像:/, 'offer skeleton must carry the persona block');
  assert.match(offerPrompt, /- 人物像: /, 'offer persona block must include the prompt_description line');
  // (2) appeal carries the confirmed skeleton + faithfulness clause.
  const appealPrompt = buildStudyCircleAppealPrompt({ type, persona: { display_name: '主催者', school_year: '3年生', identity: '星図を編む観測者', speaking_basis: '落ち着いて話す。' }, kosshi: { title: 't', situation: 's', motivation: 'm' }, memories: [] });
  assert.match(appealPrompt, /この研究会はすでに内容が確定している/, 'appeal must carry the confirmed skeleton');
  assert.match(appealPrompt, /上の内容と違う別の活動・別の集まりを新しく作り出さない/, 'appeal must carry the faithfulness clause');
});

test('generateStudyCircleOfferText makes a character-fit structured call AND a separate appeal chat call fed the adopted skeleton, gates both, and fails fast without fallback', async () => {
  const type = { id: 'star_missing_search', name: '帰らない星の捜索', scene_brief: '見つからない星を望遠鏡と星図で探す。' };
  const persona = OFFER_PERSONA;
  const world = OFFER_WORLD;
  const structured = { title: '帰らない星の相談', situation: '観測台に、望遠鏡と星図が並べて広げられている。', motivation: '観測記録の締切が迫っている。' };
  const appeal = 'ねえ、少しだけ時間はあるかな。帰らない星を今夜のうちに探し切りたくて、あなたと一緒に観測したいんだ。声をかけたのは、あなたとなら見つけられそうだと思ったから。';
  const calls = [];
  const result = await generateStudyCircleOfferText({ config: OFFER_CONFIG, type, hostDisplayName: '主催者', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: JSON.stringify(structured), appeal }, calls) });
  assert.deepEqual(result, { ...structured, appeal });
  assert.equal(calls.length, 2, 'the structured text and the appeal are two distinct calls');
  const structuredCall = calls.find((call) => call.response_format);
  const appealCall = calls.find((call) => !call.response_format);
  assert.equal(structuredCall.response_format.json_schema.name, 'study_circle_offer_record');
  assert.deepEqual(structuredCall.response_format.json_schema.schema.required, ['title', 'situation', 'motivation']);
  assert.match(structuredCall.messages[0].content, /活動: 帰らない星の捜索/);
  // the structured (skeleton) call carries the world + persona blocks; the appeal call carries the adopted skeleton.
  assert.match(structuredCall.messages[0].content, /この世界の設定:/);
  assert.match(structuredCall.messages[0].content, /この研究会を主催する主催者の人物像:/);
  assert.equal(appealCall.model, OFFER_CONFIG.chat_model, 'the appeal is a chat call on the chat model');
  assert.match(appealCall.messages[0].content, /主催者本人である/);
  assert.match(appealCall.messages[0].content, /話し方: 落ち着いた低い声でゆっくり話す。/);
  assert.match(appealCall.messages[0].content, /この研究会はすでに内容が確定している/);
  assert.match(appealCall.messages[0].content, /- 研究会の見出し: 帰らない星の相談/);

  await assert.rejects(
    generateStudyCircleOfferText({ config: OFFER_CONFIG, type, hostDisplayName: '主催者', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: JSON.stringify({ title: '', situation: 'x', motivation: 'y' }), appeal }, []) }),
    /title must not be empty/
  );
  await assert.rejects(
    generateStudyCircleOfferText({ config: OFFER_CONFIG, type, hostDisplayName: '主催者', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: JSON.stringify(structured), appeal: '' }, []) }),
    /appeal must not be empty/
  );
  await assert.rejects(
    generateStudyCircleOfferText({ config: OFFER_CONFIG, type, hostDisplayName: '主催者', persona, world, memories: [], fetchImpl: offerTextFetch({ structured: 'not json', appeal }, []) }),
    /structured JSON parse failed/
  );
  await assert.rejects(
    generateStudyCircleOfferText({ config: { base_url: '', chat_model: '' }, type, hostDisplayName: '主催者', persona, world, memories: [], fetchImpl: async () => { throw new Error('fetch must not be reached'); } }),
    (error) => error.code === 'LMSTUDIO_CONFIG_REQUIRED'
  );
  await assert.rejects(
    generateStudyCircleOfferText({ config: OFFER_CONFIG, type, hostDisplayName: '主催者', persona, world, memories: [], fetchImpl: async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; } }),
    (error) => error.code === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );
});

// ----- deterministic weekly skeleton draw -----

test('study circle skeletons are deterministic weekly triples with unique themes, hosts, and band-bounded rewards', async () => {
  const root = await studyCircleRoot();
  const catalog = await loadStudyCircleTypeCatalog({ root });
  const definitions = await loadStudyCircleDefinitions({ root });

  const week5A = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: 5 }, catalog, definitions });
  const week5B = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: 5 }, catalog, definitions });
  const week6 = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: 6 }, catalog, definitions });

  assert.deepEqual(week5A, week5B);
  assert.equal(week5A.week, 5);
  assert.equal(week5A.skeletons.length, 3);
  assert.equal(new Set(week5A.skeletons.map((skeleton) => skeleton.theme_id)).size, 3);
  assert.equal(new Set(week5A.skeletons.map((skeleton) => skeleton.host_character_id)).size, 3);
  assert.notDeepEqual(week5A.skeletons.map((skeleton) => skeleton.theme_id), week6.skeletons.map((skeleton) => skeleton.theme_id));

  for (const skeleton of week5A.skeletons) {
    const type = catalog.types.find((candidate) => candidate.id === skeleton.type_id);
    assert.equal(type.theme_id, skeleton.theme_id);
    const band = catalog.reward_bands[type.reward_band];
    const training = trainingDefinitions.find((candidate) => candidate.id === skeleton.theme_id);
    assert.deepEqual(
      skeleton.reward_params.map(({ group, key }) => ({ group, key })),
      training.increases.map((effect) => ({ group: effect.group, key: effect.key }))
    );
    for (const reward of skeleton.reward_params) {
      assert.equal(reward.amount >= band.min && reward.amount <= band.max, true, 'reward amount is within the type band');
      assert.equal(reward.amount, skeleton.reward_params[0].amount, 'all grown parameters share the rolled amount');
    }
    assert.equal(skeleton.reward_params[0].amount, studyCircleRewardAmount({ band, week: 5, typeId: skeleton.type_id }));
  }

  assert.throws(
    () => drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: 1.5 }, catalog, definitions }),
    /non-negative integer/
  );
});

test('study circle reward bands and the 50-week best-of-3 total average match the balance v2 target', async () => {
  const catalog = await loadStudyCircleTypeCatalog({ root: projectRoot });
  const definitions = await loadStudyCircleDefinitions({ root: projectRoot });
  // Reward-balance v2 (2026-07-12): study circle sits just above 鍛錬's optimal +11/week, targeting a
  // +12..13 total-parameter best-of-3 selection average over the current deterministic 50-week draw.
  assert.deepEqual(catalog.reward_bands, {
    small: { min: 1, max: 3 },
    medium: { min: 4, max: 5 },
    large: { min: 6, max: 8 }
  });
  let sumBest = 0;
  for (let week = 0; week < 50; week++) {
    const { skeletons } = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: week }, catalog, definitions });
    const totals = skeletons.map((skeleton) => skeleton.reward_params.reduce((sum, reward) => sum + reward.amount, 0));
    sumBest += Math.max(...totals);
  }
  const bestOfThreeAverage = sumBest / 50;
  assert.ok(bestOfThreeAverage >= 12.0 && bestOfThreeAverage <= 13.0, `best-of-3 total average ${bestOfThreeAverage} in [12.0,13.0]`);
});

// Long-cycle host reachability: the weekly host order is a full permutation keyed by (theme_id, week,
// candidate_id), so over the full deterministic cycle EVERY authored host candidate is offered at least once —
// including within each theme. This guards the fix for the earlier `week % candidate_count` rotation, whose start
// coupled the (week % 20) weeks a theme was offered to which host led, leaving candidates unreachable whenever a
// list length shared a factor with the 20-theme cycle (measured: 24/78 candidates never appeared, character_116
// 756×). Measured against the REAL authored study_circles.json + type catalog (the lengths that trigger the bug).
test('study circle host selection reaches every authored host candidate over the full cycle, within every theme, and stays deterministic', async () => {
  const authoredCatalog = await loadStudyCircleTypeCatalog({ root: projectRoot });
  const authoredDefinitions = await loadStudyCircleDefinitions({ root: projectRoot });

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const lcm = (a, b) => (a / gcd(a, b)) * b;
  // Cover the 20-theme rotation, the 7 type slots per theme, and every host-candidate list length.
  const cycleWeeks = authoredDefinitions.reduce((acc, d) => lcm(acc, d.host_candidate_ids.length), lcm(authoredDefinitions.length, 7));

  const eligible = [...new Set(authoredDefinitions.flatMap((d) => d.host_candidate_ids))];
  const counts = new Map(eligible.map((id) => [id, 0]));
  const perTheme = new Map(authoredDefinitions.map((d) => [d.theme_id, new Map(d.host_candidate_ids.map((id) => [id, 0]))]));

  for (let week = 0; week < cycleWeeks; week += 1) {
    const draw = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: week }, catalog: authoredCatalog, definitions: authoredDefinitions });
    // Week-internal uniqueness holds every week (the assignUniqueHosts contract).
    assert.equal(new Set(draw.skeletons.map((skeleton) => skeleton.host_character_id)).size, 3, `week ${week} assigns three distinct hosts`);
    for (const skeleton of draw.skeletons) {
      counts.set(skeleton.host_character_id, counts.get(skeleton.host_character_id) + 1);
      const themeCounts = perTheme.get(skeleton.theme_id);
      themeCounts.set(skeleton.host_character_id, themeCounts.get(skeleton.host_character_id) + 1);
    }
  }

  // Reachability across the whole eligible set...
  const unreached = eligible.filter((id) => counts.get(id) === 0);
  assert.deepEqual(unreached, [], `every eligible host candidate is offered at least once over the full cycle (unreached: ${unreached.join(', ')})`);
  // ...and reachability within each theme's own candidate list (no candidate is structurally locked out of its theme).
  for (const [themeId, themeCounts] of perTheme) {
    const themeUnreached = [...themeCounts.entries()].filter(([, count]) => count === 0).map(([id]) => id);
    assert.deepEqual(themeUnreached, [], `theme ${themeId} reaches all its host candidates (unreached: ${themeUnreached.join(', ')})`);
  }

  // Determinism: the same week always yields the same hosts (re-draw a sampled week).
  const drawA = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: 42 }, catalog: authoredCatalog, definitions: authoredDefinitions });
  const drawB = drawWeeklyStudyCircleSkeletons({ state: { elapsed_weeks: 42 }, catalog: authoredCatalog, definitions: authoredDefinitions });
  assert.deepEqual(drawA.skeletons.map((skeleton) => skeleton.host_character_id), drawB.skeletons.map((skeleton) => skeleton.host_character_id));
});

// ----- weekly build-or-load orchestration -----

// A fixed persona resolver for the direct build-or-load tests: the countingGenerator ignores
// it (deterministic), so any complete persona works — the real appeal-prompt validation lives
// in buildStudyCircleAppealPrompt, exercised separately above.
const fixturePersonaFor = async () => ({ display_name: '主催者', school_year: '2年生', identity: '研究会をひらく者', prompt_description: '研究会をひらく穏やかな主催者。', speaking_basis: '穏やかに話す。' });

function countingGenerator(calls) {
  return async ({ type, hostDisplayName, persona }) => {
    calls.push({ type_id: type.id, hostDisplayName, persona });
    return {
      title: `${hostDisplayName}の研究会`,
      situation: `実習台に、${type.id}の支度が並べて置かれている。`,
      motivation: `${hostDisplayName}が、会話を通じてこの研究会に付き合ってほしいと考えている。`,
      appeal: `ねえ、${type.id}の研究会を開くから、${hostDisplayName}と一緒に来てほしいんだ。あなたに声をかけたよ。`
    };
  };
}

test('buildOrLoadWeeklyStudyCircleOffers generates once, then reuses the persisted week with no further LLM calls', async (t) => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 6 } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadStudyCircleTypeCatalog({ root });
  const definitions = await loadStudyCircleDefinitions({ root });
  const storage = createStorageApi({ root });
  const calls = [];
  const args = { storage, catalog, definitions, memoriesFor: async () => [], personaFor: fixturePersonaFor, generateOfferText: countingGenerator(calls) };

  const firstRun = await buildOrLoadWeeklyStudyCircleOffers(args);
  assert.equal(firstRun.generated, true);
  assert.equal(firstRun.week, 6);
  assert.equal(firstRun.offers.length, 3);
  assert.equal(calls.length, 3, 'the generator is called once per offer on first build');
  const persisted = readWeeklyStudyCircleOffers(await storage.readJson('game_data/runtime_state.json'));
  assert.deepEqual(persisted, { week: 6, offers: firstRun.offers });

  const secondRun = await buildOrLoadWeeklyStudyCircleOffers(args);
  assert.equal(secondRun.generated, false, 'the same week returns the persisted offers');
  assert.deepEqual(secondRun.offers, firstRun.offers);
  assert.equal(calls.length, 3, 'no further LLM call happens for a same-week re-fetch');

  const advanced = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', { ...advanced, elapsed_weeks: 7 });
  const thirdRun = await buildOrLoadWeeklyStudyCircleOffers(args);
  assert.equal(thirdRun.generated, true, 'a new week regenerates');
  assert.equal(thirdRun.week, 7);
  assert.equal(calls.length, 6);
});

function cleanStudyCircleOffer({ type, hostDisplayName }) {
  return { title: `${hostDisplayName}の研究会`, situation: `実習台に、${type.id}の支度が並べて置かれている。`, motivation: '付き合ってほしい。', appeal: `${hostDisplayName}が、あなたに一緒に来てほしいと語りかけている。` };
}

// A generated field carrying a forbidden bracket symbol — exactly the runtime failure that
// motivated bounded retry ("study circle offer appeal ... must not contain quotation or
// bracket symbols: 『").
function bracketDirtyStudyCircleOffer({ type, hostDisplayName }) {
  return { ...cleanStudyCircleOffer({ type, hostDisplayName }), appeal: `${hostDisplayName}が『一緒に来て』と語りかけている。` };
}

test('buildOrLoadWeeklyStudyCircleOffers recovers when an offer trips the gate once, then persists a clean week', async (t) => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 6 } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadStudyCircleTypeCatalog({ root });
  const definitions = await loadStudyCircleDefinitions({ root });
  const storage = createStorageApi({ root });
  let firstTypeId;
  const attemptsByType = new Map();
  const generateOfferText = async ({ type, hostDisplayName }) => {
    if (firstTypeId === undefined) firstTypeId = type.id;
    const n = (attemptsByType.get(type.id) ?? 0) + 1;
    attemptsByType.set(type.id, n);
    // The first offer trips the forbidden-symbol gate on its first attempt, then regenerates clean.
    if (type.id === firstTypeId && n === 1) return bracketDirtyStudyCircleOffer({ type, hostDisplayName });
    return cleanStudyCircleOffer({ type, hostDisplayName });
  };

  const run = await buildOrLoadWeeklyStudyCircleOffers({ storage, catalog, definitions, memoriesFor: async () => [], personaFor: fixturePersonaFor, generateOfferText });
  assert.equal(run.generated, true);
  assert.equal(run.offers.length, 3);
  assert.equal(attemptsByType.get(firstTypeId), 2, 'the offer that tripped the gate was regenerated once');
  for (const offer of run.offers) assert.equal(offer.appeal.includes('『'), false, 'no persisted offer carries a forbidden symbol');
  const persisted = readWeeklyStudyCircleOffers(await storage.readJson('game_data/runtime_state.json'));
  assert.deepEqual(persisted, { week: 6, offers: run.offers });
});

test('buildOrLoadWeeklyStudyCircleOffers fails fast with a 503 and persists nothing when an offer trips the gate on every attempt', async (t) => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 6 } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadStudyCircleTypeCatalog({ root });
  const definitions = await loadStudyCircleDefinitions({ root });
  const storage = createStorageApi({ root });
  const distinctTypes = [];
  let failingTypeId;
  let failingTypeAttempts = 0;
  const generateOfferText = async ({ type, hostDisplayName }) => {
    if (!distinctTypes.includes(type.id)) distinctTypes.push(type.id);
    if (failingTypeId === undefined && distinctTypes.length === 2) failingTypeId = distinctTypes[1];
    if (type.id === failingTypeId) {
      failingTypeAttempts += 1;
      return { title: '', situation: 'x', motivation: 'y', appeal: 'z' }; // permanently malformed (empty title)
    }
    return cleanStudyCircleOffer({ type, hostDisplayName });
  };

  await assert.rejects(
    buildOrLoadWeeklyStudyCircleOffers({ storage, catalog, definitions, memoriesFor: async () => [], personaFor: fixturePersonaFor, generateOfferText }),
    (error) => {
      assert.equal(error.errorCode, 'STUDY_CIRCLE_GENERATION_FAILED');
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /title must not be empty/);
      return true;
    }
  );
  assert.equal(failingTypeAttempts, 3, 'the failing offer was retried up to the cap before failing');
  const state = await storage.readJson('game_data/runtime_state.json');
  assert.equal(Object.hasOwn(state, ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY), false, 'no partial slot is persisted');
});

test('buildOrLoadWeeklyStudyCircleOffers does not retry an LM connection failure and persists nothing', async (t) => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 6 } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadStudyCircleTypeCatalog({ root });
  const definitions = await loadStudyCircleDefinitions({ root });
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
    buildOrLoadWeeklyStudyCircleOffers({ storage, catalog, definitions, memoriesFor: async () => [], personaFor: fixturePersonaFor, generateOfferText }),
    (error) => error.errorCode === 'LMSTUDIO_CONNECTION_UNAVAILABLE'
  );
  assert.equal(calls, 1, 'an LM connection failure fails fast without spending the retry budget');
  const state = await storage.readJson('game_data/runtime_state.json');
  assert.equal(Object.hasOwn(state, ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY), false, 'no partial slot is persisted');
});

test('buildOrLoadWeeklyStudyCircleOffers requires a personaFor resolver (the appeal needs the host persona)', async (t) => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 6 } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = await loadStudyCircleTypeCatalog({ root });
  const definitions = await loadStudyCircleDefinitions({ root });
  const storage = createStorageApi({ root });
  await assert.rejects(
    buildOrLoadWeeklyStudyCircleOffers({ storage, catalog, definitions, memoriesFor: async () => [], generateOfferText: countingGenerator([]) }),
    /personaFor is required/
  );
});

// ----- persisted slot + active study circle shapes -----

function fixtureOffer(overrides = {}) {
  return {
    study_circle_id: 'star_missing_search',
    type_id: 'star_missing_search',
    theme_id: 'star_observation',
    theme_name: '星詠み観測',
    title: '帰らない星の相談',
    situation: '観測台に、望遠鏡と星図が並べて広げられている。',
    motivation: '観測記録の締切が迫り、今夜のうちに探し切りたいと考えている。',
    appeal: 'ねえ、少しだけ時間はあるかな。帰らない星を今夜のうちに探し切りたくて、あなたと一緒に観測したいんだ。あなたとなら見つけられそうで、声をかけたの。手伝ってほしい。',
    condition_text: '主人公が候補の星をひとつ指し示し、探している星かどうかの結論を主催者と出した。',
    reward_params: [
      { group: 'abilities', key: 'academics', label: '学力', amount: 3 },
      { group: 'magic', key: 'light', label: '光魔法習熟度', amount: 3 }
    ],
    venue: '天文塔の観測台',
    host_character_id: 'character_048',
    host_display_name: '主催者',
    ...overrides
  };
}

test('weekly study circle offers slot and active study circle state are strict', () => {
  const offer = fixtureOffer();
  const slot = {
    week: 5,
    offers: [
      offer,
      fixtureOffer({ study_circle_id: 'failed_brew_sniff', type_id: 'failed_brew_sniff', theme_id: 'potion_brewing' }),
      fixtureOffer({ study_circle_id: 'line_time_trial', type_id: 'line_time_trial', theme_id: 'physical_drills' })
    ]
  };
  assert.deepEqual(readWeeklyStudyCircleOffers({ [ROUTING_WEEKLY_STUDY_CIRCLE_OFFERS_STATE_KEY]: slot }), validateWeeklyStudyCircleOffers(slot));
  assert.throws(() => validateWeeklyStudyCircleOffers({ week: 5, offers: [offer, offer] }), /must contain exactly 3 offers/);
  assert.throws(() => validateWeeklyStudyCircleOffers({ week: 5, offers: [offer, offer, offer] }), /study_circle_id must be unique/);

  assert.deepEqual(findPersistedStudyCircleOffer({ offers: slot, themeId: 'physical_drills' }).type_id, 'line_time_trial');
  assert.throws(() => findPersistedStudyCircleOffer({ offers: slot, themeId: 'not_offered' }), /is not offered this week/);

  // The public offer strips the internal motivation and the internal condition_text (the authored judgment value
  // the achievement check uses — never shown to the player). The appeal (当人の語り) is the card's主表示 and IS
  // public; situation stays public for the daytime scene detail popup.
  const publicOffer = toPublicStudyCircleOffer(offer);
  assert.equal(Object.hasOwn(publicOffer, 'motivation'), false);
  assert.equal(Object.hasOwn(publicOffer, 'condition_text'), false, 'condition_text is not public (internal judgment value)');
  assert.equal(publicOffer.title, offer.title);
  assert.equal(publicOffer.situation, offer.situation);
  assert.equal(publicOffer.appeal, offer.appeal);
  assert.deepEqual(publicOffer.reward_params, offer.reward_params);

  const active = buildActiveRoutingStudyCircle({
    offer,
    conversationId: 'conv_study_circle_active_001',
    week: 5,
    startedAt: '2026-07-06T00:00:00.000Z'
  });
  assert.equal(active.study_circle_id, 'star_missing_search');
  assert.equal(active.type_id, 'star_missing_search');
  assert.equal(active.condition_text, offer.condition_text);
  assert.equal(active.prompt_tail_context, offer.motivation, 'the generated motivation becomes prompt_tail_context');
  assert.equal(active.title, offer.title);
  // The appeal is presentation-only: it never enters the active record or the scene context (below).
  assert.equal(Object.hasOwn(active, 'appeal'), false, 'the appeal is not carried into the active study circle');
  assert.deepEqual(readActiveRoutingStudyCircle({ [ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY]: active }), active);
  assert.throws(() => readActiveRoutingStudyCircle({ [ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY]: null }), /routing active study circle must be an object/);
  assert.throws(() => readActiveRoutingStudyCircle({ [ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY]: { ...active, condition_text: '' } }), /condition_text/);
  assert.throws(() => readActiveRoutingStudyCircle({ [ROUTING_ACTIVE_STUDY_CIRCLE_STATE_KEY]: { ...active, conversation_id: 'bad' } }), /conversation_id/);

  // The scene context is a host-framed study circle statement: a framing block (framing + title +
  // motivation) so the host drives THIS study circle from their side, followed by a goal block that
  // names the achievement condition (condition_text verbatim), forbids meta speech about it, and steers
  // the conversation to reach that point in-scene. Only title + motivation + condition_text are used.
  const studyScene = buildRoutingStudyCircleSceneContext(active);
  assert.deepEqual(studyScene, {
    source_type: STUDY_CIRCLE_SOURCE_TYPE,
    location_name: offer.venue,
    visible_situation: offer.situation,
    prompt_tail_context: [
      'あなたは今、この研究会を主催していて、目の前の主人公はその参加者である。この会話はその研究会の活動を一緒に進めるための場である。',
      `あなたが開いている研究会: ${offer.title}`,
      `あなたがこの研究会を開く動機・事情: ${offer.motivation}`,
      'この研究会で何をする集まりなのかを、あなた自身が分かった上で、あなたの方から活動を進める。',
      `この研究会の目的が果たされたと言えるのは、次のことが会話の中で実際に起きたときである: ${offer.condition_text}`,
      'ただし「達成条件」といった言葉やこの文面そのものは決して口に出さず、会話の内容として自然にそこへ向かう。',
      'この到達点には、あなた自身（主催者）の反応や言葉も含まれることがある。その場合は、あなた自身がその反応・納得・結論を、会話の自然な流れの中で自分から言葉にして示す。',
      'この到達点を先延ばしにしたり、下調べや段取りの相談だけで終わらせたりしない。会話の中で実際にその場面をやり切ることを目指し、主人公にも具体的な行動や答えを促し、頃合いを見てあなた自身の理解・納得・結論をはっきり言葉にして区切りをつける。',
      '特に、主人公自身が担う一歩（たとえば候補をひとつ選ぶ・指し示す・自分の答えや説明を口にする等）がまだ果たされていないなら、あなたの側だけで先に進めてしまわず、主人公にその一歩を具体的に問いかけ、主人公自身に決めさせてから次へ進む。',
      'ただし急いで結論へ運んだり主人公を質問攻めにしたりはせず、まず相手のやり取りを受け止めながら自然にそこへ近づける。'
    ].join('\n')
  });
  assert.notEqual(studyScene.prompt_tail_context, active.prompt_tail_context, 'scene tail must not be the bare motivation');
  // The goal block carries the achievement condition verbatim, forbids meta speech, and appends the six
  // goal lines in order after the four framing lines. The errand/study-circle goal blocks differ by two words only.
  const studyTail = studyScene.prompt_tail_context.split('\n');
  assert.equal(studyTail.length, 10, 'study circle scene tail is four framing lines plus six goal lines');
  assert.equal(studyTail[4], `この研究会の目的が果たされたと言えるのは、次のことが会話の中で実際に起きたときである: ${offer.condition_text}`);
  assert.ok(studyTail[4].includes(offer.condition_text), 'the goal line carries condition_text verbatim');
  assert.equal(studyTail[5], 'ただし「達成条件」といった言葉やこの文面そのものは決して口に出さず、会話の内容として自然にそこへ向かう。', 'the meta-speech ban follows the goal line');
});

// ----- routing destination + meta context (unchanged surface) -----

test('study circle is a weekly routing destination with backend dispatch and meta context', () => {
  const destination = routingDestinations.find((item) => item.id === 'study_circle');
  assert.equal(destination.id, 'study_circle');
  assert.deepEqual(resolveRoutingDestinationDispatch('study_circle'), {
    destination_id: 'study_circle',
    destination_label: '研究会',
    next_screen: 'academy-study-circle',
    transition: { next_screen: 'academy-study-circle' }
  });
  const meta = buildRoutingMetaContext({
    state: { elapsed_weeks: 2 },
    routingHubContext: {
      persona_variant: 'fallen_star',
      recent_conversation_context: {
        kind: 'no_new_conversation',
        conversation_id: null,
        character_id: null,
        character_name: null,
        memory_text: null
      },
      relationship_context: { buddy: null, enemies: [] },
      alchemy_context: { recipe_count: 8 },
      study_circle_context: { theme_count: trainingDefinitions.length, weekly_offer_count: 3 },
      content_result_context: null
    }
  });
  assert.match(meta, /研究会: 週替わりの研究テーマを1件選び/);
  assert.match(meta, new RegExp(`研究会: 全${trainingDefinitions.length}種のテーマから週3件のオファー`));
});

// ----- completion (reward applied from the persisted active record) -----

async function completeFromActive({ root, offer, achieved = true, now = '2026-07-06T00:00:00.000Z' }) {
  const active = buildActiveRoutingStudyCircle({
    offer,
    conversationId: 'conv_study_circle_active_001',
    week: 3,
    startedAt: now
  });
  return applyStudyCircleCompletion({ root, activeStudyCircle: active, achieved, now });
}

test('study circle completion applies the persisted reward params and returns a strict achieved content result', async () => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 3 } });
  const offer = fixtureOffer();
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  const result = await completeFromActive({ root, offer, achieved: true });

  assert.deepEqual(Object.keys(result).sort(), ['destination_id', 'detail', 'kind', 'trigger']);
  assert.equal(result.kind, 'study_circle');
  assert.equal(result.destination_id, 'study_circle');
  assert.equal(result.trigger, 'study_circle_completed');
  assert.equal(result.detail.achieved, true);
  assert.equal(result.detail.theme_id, offer.theme_id);
  assert.equal(result.detail.theme_name, offer.theme_name);
  assert.equal(result.detail.host_character_id, offer.host_character_id);
  assert.deepEqual(Object.keys(result.detail).sort(), [
    'achieved',
    'host_character_id',
    'host_display_name',
    'outcome',
    'parameter_deltas',
    'theme_id',
    'theme_name'
  ]);

  const after = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  for (const reward of offer.reward_params) {
    assert.equal(result.detail.parameter_deltas[reward.group][reward.key], reward.amount);
    assert.equal(after[reward.group][reward.key].value, before[reward.group][reward.key].value + reward.amount);
  }
});

test('an unachieved study circle completion applies no reward and records achieved:false with empty deltas', async () => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 3 } });
  const offer = fixtureOffer();
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  const result = await completeFromActive({ root, offer, achieved: false });

  assert.equal(result.detail.achieved, false);
  assert.deepEqual(result.detail.parameter_deltas, { magic: {}, abilities: {} });
  // No parameter write happens for an unachieved exit: the mutable slot is never created.
  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/runtime/player_parameters.json')), { code: 'ENOENT' });
  assert.deepEqual(await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json'), before);
});

test('applyStudyCircleCompletion fails fast without a boolean achieved', async () => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 3 } });
  const active = buildActiveRoutingStudyCircle({
    offer: fixtureOffer(),
    conversationId: 'conv_study_circle_active_001',
    week: 3,
    startedAt: '2026-07-06T00:00:00.000Z'
  });
  await assert.rejects(
    () => applyStudyCircleCompletion({ root, activeStudyCircle: active }),
    /requires a boolean achieved/
  );
});

test('study circle content result validation rejects unexpected keys and enforces the achieved/deltas invariant', () => {
  const validResult = {
    kind: 'study_circle',
    destination_id: 'study_circle',
    trigger: 'study_circle_completed',
    detail: {
      outcome: 'completed',
      achieved: false,
      theme_id: 'star_observation',
      theme_name: '星詠み観測',
      host_character_id: 'character_048',
      host_display_name: '主催者',
      parameter_deltas: { magic: {}, abilities: {} }
    }
  };

  assert.deepEqual(validateStudyCircleContentResult(validResult), validResult);
  assert.throws(
    () => validateStudyCircleContentResult({ ...validResult, week: 3 }),
    /unexpected key/
  );
  assert.throws(
    () => validateStudyCircleContentResult({
      ...validResult,
      detail: { ...validResult.detail, conversation_id: 'conv_study_circle_001' }
    }),
    /unexpected key/
  );
  // achieved must be a boolean, and it must agree with the deltas: achieved⟺non-empty, unachieved⟺empty.
  assert.throws(
    () => validateStudyCircleContentResult({
      ...validResult,
      detail: { ...validResult.detail, achieved: 'yes' }
    }),
    /requires a boolean achieved/
  );
  assert.throws(
    () => validateStudyCircleContentResult({
      ...validResult,
      detail: { ...validResult.detail, achieved: true }
    }),
    /achieved requires non-empty parameter_deltas/
  );
  assert.throws(
    () => validateStudyCircleContentResult({
      ...validResult,
      detail: { ...validResult.detail, parameter_deltas: { magic: { light: 1 }, abilities: {} } }
    }),
    /unachieved requires empty parameter_deltas/
  );
});

test('study circle completion rejects bounded parameters instead of clamping partial deltas', async () => {
  const highParameters = defaultPlayerParameters();
  for (const group of Object.keys(highParameters)) {
    for (const key of Object.keys(highParameters[group])) {
      highParameters[group][key].value = 100;
    }
  }
  const root = await studyCircleRoot({ state: { elapsed_weeks: 3 }, parameters: highParameters });
  const before = await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json');

  await assert.rejects(
    () => completeFromActive({ root, offer: fixtureOffer() }),
    /cannot apply full study circle reward/
  );

  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/runtime/player_parameters.json')), { code: 'ENOENT' });
  assert.deepEqual(await readJson(root, 'data/seeds/game_data/runtime/player_parameters.json'), before);
});

test('study circle completion does not write partial parameter updates when persistence fails', async () => {
  const root = await studyCircleRoot({ state: { elapsed_weeks: 3 } });
  const parameterPath = path.join(root, 'data/mutable/game_data/runtime/player_parameters.json');
  await writeJson(root, 'data/mutable/game_data/runtime/player_parameters.json', defaultPlayerParameters());
  await fs.chmod(parameterPath, 0o444);
  const before = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');

  try {
    await assert.rejects(
      () => completeFromActive({ root, offer: fixtureOffer() }),
      /EACCES|permission denied|operation not permitted/i
    );
    assert.deepEqual(await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json'), before);
  } finally {
    await fs.chmod(parameterPath, 0o644).catch(() => {});
  }
});
